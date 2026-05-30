# /// script
# requires-python = ">=3.11"
# dependencies = ["polars>=1.0"]
# ///
"""Detect carriers whose BIPD insurance is about to lapse with no replacement.

A strong leading risk indicator: a carrier days from losing its operating
authority because its insurance is cancelling and nothing new has been filed.

SOURCE: ActPendInsur (Active & Pending Insurance, All With History). This file —
already loaded by build_aggregates for the on-file/required amounts — carries a
`cancl_effective_date` per policy, which is exactly FMCSA's "pending
cancellation" date (the value shown on the L&I CompleteProfile page). We compute,
per carrier, the latest date any in-effect BIPD policy provides coverage through:

  coverage_end = max( coalesce(cancl_effective_date, far_future) )
                 over BIPD policies already in effect (effective_date <= window end)

If a carrier has ANY BIPD policy with no cancellation (or one cancelling after the
window), coverage_end is far in the future → not at risk. A carrier is imminent-
lapse only when EVERY in-effect BIPD policy ends within the window — i.e. the last
coverage is cancelling and nothing replaces it. This cleanly handles replacements
(a new policy pushes coverage_end out) without the old `on_file<=1` heuristic.

  bipd_pending_cancel_date  date  coverage_end (the terminal cancellation date)
  bipd_days_to_lapse        int   days from as-of date to that date (neg = lapsed)
  bipd_imminent_lapse       bool  coverage_end within [as-of - LOOKBACK, as-of + HORIZON]

Prior implementation read the InsHist event log and missed most carriers (caught
5 of ~8,600 with coverage on file) because its "last event = Cancelled" matching
under-detected future-dated pending cancellations. ActPendInsur is the correct,
already-loaded source.

CAVEAT: most freshness-sensitive rule in the pipeline — pull ActPendInsur daily
(refresh_sms_data.py --daily). As-of date defaults to today; override with
FMCSA_LAPSE_ASOF=YYYY-MM-DD for a reproducible build.
"""
from __future__ import annotations

import os
from datetime import date, datetime, timedelta
from pathlib import Path
import polars as pl

PARQUET = Path(os.environ.get(
    "FMCSA_PARQUET",
    "/Users/art/conductor/workspaces/augment-carrier-audit-v1/san-antonio/data/carrier_aggregates.parquet",
))
ACTPEND = Path(os.environ.get(
    "FMCSA_ACTPEND",
    "/Users/art/Downloads/ActPendInsur_All_With_History.csv",
))
_asof = os.environ.get("FMCSA_LAPSE_ASOF")
SNAPSHOT = datetime.strptime(_asof, "%Y-%m-%d").date() if _asof else date.today()
HORIZON = 45     # flag coverage ending up to 45 days out
LOOKBACK = 30    # ...and coverage that ended within the last 30 days (still uninsured)
FAR_FUTURE = date(2099, 12, 31)


def log(m: str) -> None:
    print(f"[add_pending_lapse] {m}", flush=True)


def main() -> None:
    df = pl.read_parquet(PARQUET)
    for c in ("bipd_pending_cancel_date", "bipd_days_to_lapse", "bipd_imminent_lapse"):
        if c in df.columns:
            df = df.drop(c)

    window_hi = SNAPSHOT + timedelta(days=HORIZON)
    window_lo = SNAPSHOT - timedelta(days=LOOKBACK)
    log(f"as-of {SNAPSHOT}  window [{window_lo} … {window_hi}]  source {ACTPEND.name}")

    bipd = (
        pl.scan_csv(ACTPEND, infer_schema_length=0, ignore_errors=True)
        .with_columns(
            DOT_NUMBER=pl.col("DOT_NUMBER").cast(pl.Int64, strict=False),
            eff=pl.col("effective_date").str.strptime(pl.Date, format="%m/%d/%Y", strict=False),
            cancl=pl.col("cancl_effective_date").str.strptime(pl.Date, format="%m/%d/%Y", strict=False),
        )
        # BIPD/Primary liability policies only
        .filter(pl.col("ins_type_desc").str.starts_with("BIPD"))
        .filter(pl.col("DOT_NUMBER").is_not_null() & pl.col("eff").is_not_null())
        # only policies already in effect by the window end — a not-yet-effective
        # future-dated policy (incl. garbage dates like 2032) is NOT current
        # coverage and must not mask a real near-term cancellation.
        .filter(pl.col("eff") <= pl.lit(window_hi))
        .select("DOT_NUMBER", "cancl")
        .collect(engine="streaming")
    )
    log(f"in-effect BIPD policy rows: {bipd.height:,}")

    cover = (
        bipd.with_columns(
            # no cancellation on file → coverage runs indefinitely
            coverage_until=pl.col("cancl").fill_null(FAR_FUTURE)
        )
        .group_by("DOT_NUMBER")
        .agg(coverage_end=pl.col("coverage_until").max())
        .with_columns(
            bipd_pending_cancel_date=pl.col("coverage_end"),
            bipd_days_to_lapse=(pl.col("coverage_end") - pl.lit(SNAPSHOT)).dt.total_days().cast(pl.Int64),
            imminent=(pl.col("coverage_end") >= pl.lit(window_lo))
            & (pl.col("coverage_end") <= pl.lit(window_hi)),
        )
    )
    flagged = cover.filter(pl.col("imminent"))
    log(f"carriers with all-BIPD coverage ending in window (imminent): {flagged.height:,}")

    out = (
        df.join(
            flagged.select("DOT_NUMBER", "bipd_pending_cancel_date", "bipd_days_to_lapse"),
            on="DOT_NUMBER", how="left",
        )
        .with_columns(bipd_imminent_lapse=pl.col("bipd_days_to_lapse").is_not_null())
    )

    n_active = out.filter(pl.col("bipd_imminent_lapse") & (pl.col("status_code") == "A")).height
    n_covered = out.filter(
        pl.col("bipd_imminent_lapse") & (pl.col("bipd_insurance_on_file").fill_null(0) >= 1)
    ).height
    log(f"  flagged total: {out['bipd_imminent_lapse'].sum():,}  active: {n_active:,}  "
        f"with coverage on file (forward-looking): {n_covered:,}")

    out.write_parquet(PARQUET, compression="zstd")
    log(f"wrote {PARQUET}")


if __name__ == "__main__":
    main()
