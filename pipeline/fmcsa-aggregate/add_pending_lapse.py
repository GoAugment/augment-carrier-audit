# /// script
# requires-python = ">=3.11"
# dependencies = ["polars>=1.0"]
# ///
"""Detect carriers whose BIPD insurance is about to lapse with no replacement.

A strong leading risk indicator: a carrier days from losing its operating
authority because its insurance is cancelling and nothing new has been filed.

Definition (matches "about to expire, no new insurance provided"): a carrier's
MOST RECENT BIPD event (by effective date) is a 'Cancelled' event whose
effective date is in the near window — i.e., the cancellation is the last thing
on file, with no replacement/new policy filed after it.

  bipd_pending_cancel_date  date  effective date of the terminal cancellation
  bipd_days_to_lapse        int   days from snapshot to that date (negative =
                                  already lapsed); null if not at risk
  bipd_imminent_lapse       bool  terminal cancellation within HORIZON days
                                  (forward) or recently lapsed (LOOKBACK days)

CAVEAT: computed against the InsHist snapshot date, NOT today. This rule is the
most freshness-sensitive in the pipeline — refresh insurance data (Socrata /
L&I) before trusting it operationally.
"""
from __future__ import annotations

from datetime import date
from pathlib import Path
import polars as pl

PARQUET = Path("/Users/art/conductor/workspaces/augment-carrier-audit-v1/san-antonio/data/carrier_aggregates.parquet")
INSHIST = Path("/Users/art/Downloads/inshist_allwithhistory.txt")
SNAPSHOT = date(2026, 5, 14)
HORIZON = 45     # flag cancellations effective up to 45 days out
LOOKBACK = 30    # ...and ones that lapsed within the last 30 days (still uninsured)


def log(m: str) -> None:
    print(f"[add_pending_lapse] {m}", flush=True)


def main() -> None:
    df = pl.read_parquet(PARQUET)
    for c in ("bipd_pending_cancel_date", "bipd_days_to_lapse", "bipd_imminent_lapse"):
        if c in df.columns:
            df = df.drop(c)

    cols = [f"c{i:02d}" for i in range(1, 18)]
    hist = (
        pl.scan_csv(INSHIST, has_header=False, new_columns=cols,
                    schema_overrides={c: pl.Utf8 for c in cols}, ignore_errors=True)
        .with_columns(
            DOT_NUMBER=pl.col("c02").cast(pl.Int64, strict=False),
            event=pl.col("c04"),
            coverage=pl.col("c07"),
            eff=pl.col("c14").str.strptime(pl.Date, format="%m/%d/%Y", strict=False),
        )
        .filter(pl.col("coverage").str.contains("BIPD").fill_null(False))
        .filter(pl.col("DOT_NUMBER").is_not_null() & pl.col("eff").is_not_null())
        # guard against garbage future dates (file has some out to year 2802)
        .filter(pl.col("eff") <= pl.lit(date(2027, 12, 31)))
        .select("DOT_NUMBER", "event", "eff")
        .collect(engine="streaming")
    )
    log(f"BIPD events (clean dates): {hist.height:,}")

    # The terminal (latest-effective) BIPD event per carrier.
    latest = (
        hist.sort(["DOT_NUMBER", "eff"])
        .group_by("DOT_NUMBER", maintain_order=True)
        .last()
        .rename({"event": "last_event", "eff": "last_eff"})
    )

    lo, hi = SNAPSHOT.replace(), SNAPSHOT  # placeholders for clarity
    from datetime import timedelta
    window_lo = SNAPSHOT - timedelta(days=LOOKBACK)
    window_hi = SNAPSHOT + timedelta(days=HORIZON)

    lapse = (
        latest.filter(pl.col("last_event") == "Cancelled")
        .filter((pl.col("last_eff") >= pl.lit(window_lo)) & (pl.col("last_eff") <= pl.lit(window_hi)))
        .with_columns(
            bipd_pending_cancel_date=pl.col("last_eff"),
            bipd_days_to_lapse=(pl.col("last_eff") - pl.lit(SNAPSHOT)).dt.total_days().cast(pl.Int64),
        )
        .select("DOT_NUMBER", "bipd_pending_cancel_date", "bipd_days_to_lapse")
    )
    log(f"carriers with terminal pending/recent BIPD cancellation: {lapse.height:,}")

    # A terminal cancellation only means a real lapse if the carrier has no
    # OTHER active BIPD policy. A replacement can carry an EARLIER effective
    # date than the cancellation it triggers (so "latest event" alone
    # over-counts) — gate on bipd_insurance_on_file <= 1, i.e. the cancelling
    # policy is effectively the carrier's last/only active coverage.
    out = df.join(lapse, on="DOT_NUMBER", how="left").with_columns(
        bipd_imminent_lapse=(
            pl.col("bipd_days_to_lapse").is_not_null()
            & (pl.col("bipd_insurance_on_file").fill_null(0) <= 1)
        ),
    ).with_columns(
        # null the date/days for carriers we didn't ultimately flag, so the
        # columns only carry values for genuine imminent-lapse carriers.
        bipd_pending_cancel_date=pl.when(pl.col("bipd_imminent_lapse"))
        .then(pl.col("bipd_pending_cancel_date")).otherwise(None),
        bipd_days_to_lapse=pl.when(pl.col("bipd_imminent_lapse"))
        .then(pl.col("bipd_days_to_lapse")).otherwise(None),
    )
    # Active carriers are the actionable ones.
    n_active = out.filter(pl.col("bipd_imminent_lapse") & (pl.col("status_code") == "A")).height
    log(f"  active carriers flagged: {n_active:,}")
    log(f"  days-to-lapse distribution (active): "
        f"{out.filter(pl.col('bipd_imminent_lapse') & (pl.col('status_code')=='A'))['bipd_days_to_lapse'].describe()}")

    out.write_parquet(PARQUET, compression="zstd")
    log(f"wrote {PARQUET}")


if __name__ == "__main__":
    main()
