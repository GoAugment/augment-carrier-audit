# /// script
# requires-python = ">=3.11"
# dependencies = ["polars>=1.0"]
# ///
"""
Add insurance-history (chameleon-detection) columns to carrier_aggregates.parquet.

Source: inshist_allwithhistory.txt — header-less CSV with historical insurance
policy lifecycle events (cancel / replace / name-change / transfer). The
classic chameleon-carrier pattern is "cancel and replace within 30 days" —
the carrier shuts down a policy under one name and immediately reopens under
another to dodge a bad safety record.

New columns added:
  - insurance_cancellations_24mo   (int) : # of cancellation events in last 24mo
  - most_recent_cancel_date        (str) : YYYY-MM-DD of most recent cancel event
  - most_recent_cancel_reason      (str) : the cancellation type (Cancelled / Replaced / Name Change / Transferred)
  - rapid_replace_flag             (bool): ANY cancel followed by replace within 30 days, ever

Schema is positional (no header row) per FMCSA's InsHist format. Verified
against sample rows in the May 2026 snapshot:
  col  1: DOCKET_NUMBER       (e.g. "FF000031" / "MC000647")
  col  2: DOT_NUMBER          (0 for very old brokers without USDOT)
  col  3: form code
  col  4: CANCELLATION_TYPE   (Cancelled / Replaced / Name Change / Transferred)
  col  5-6: misc
  col  7: insurance type      (BIPD / BIPD/Primary / Cargo / etc.)
  col  8: policy number
  col  9: amount in $k
  col 10: misc
  col 11: policy_effective_date (MM/DD/YYYY)
  col 12-13: misc
  col 14: cancel_date         (MM/DD/YYYY)
  col 15: cancel_action       (CANCEL / REPLACE / etc.)
  col 16: misc
  col 17: insurer_name
"""

from __future__ import annotations

import os
from pathlib import Path

import polars as pl

HERE = Path(__file__).parent
INSHIST = Path(os.environ.get("FMCSA_INSHIST", "/Users/art/Downloads/inshist_allwithhistory.txt"))
PARQUET = Path(os.environ.get("FMCSA_PARQUET", HERE / "carrier_aggregates.parquet"))

# Match the convention used elsewhere in this pipeline.
SNAPSHOT_DATE = "2026-05-14"


def main() -> None:
    print(f"Scanning InsHist: {INSHIST.name}")

    cols = [f"c{i:02d}" for i in range(1, 18)]
    df = (
        pl.scan_csv(
            INSHIST,
            has_header=False,
            new_columns=cols,
            schema_overrides={c: pl.Utf8 for c in cols},
            ignore_errors=True,
        )
        .with_columns(
            DOT_NUMBER=pl.col("c02").cast(pl.Int64, strict=False),
            cancellation_type=pl.col("c04"),
            cancel_date=pl.col("c14").str.strptime(pl.Date, format="%m/%d/%Y", strict=False),
            insurer_name=pl.col("c17"),
            ins_type=pl.col("c07"),
        )
        .filter(pl.col("DOT_NUMBER").is_not_null() & (pl.col("DOT_NUMBER") > 0))
        .collect(engine="streaming")
    )

    print(f"InsHist rows with valid USDOT: {df.height:,}")
    print(f"Unique DOTs with history events: {df['DOT_NUMBER'].n_unique():,}")

    cutoff = pl.lit(SNAPSHOT_DATE).str.strptime(pl.Date, format="%Y-%m-%d").dt.offset_by("-24mo")

    # Aggregate per DOT.
    #
    # IMPORTANT: `insurance_cancellations_24mo` counts ONLY events with
    # cancellation_type='Cancelled' — true policy cancellations. Validated
    # against production data: counting all events (including 'Replaced')
    # produced floods of false positives on legitimate fleets like Ryder /
    # Cowan / Ashley Distribution, whose 'Replaced' rows were annual policy
    # renewals, not chameleon signals. The actual chameleon pattern is
    # *Cancelled* without a clean replacement (or Cancelled-then-Replaced
    # within 30 days, which `rapid_replace_flag` already captures).
    #
    # `most_recent_cancel_date` / `most_recent_cancel_reason` still reflect
    # the carrier's most recent event of ANY type — useful broker context
    # ("last touched their insurance 2 weeks ago"). The count semantics
    # diverge from the date semantics by design.
    is_cancel = pl.col("cancellation_type") == "Cancelled"

    # IMPORTANT CHANGE (Aug 2026): count DISTINCT policy_nos with at least one
    # Cancelled event, not raw cancel events. Prior implementation counted
    # cancellation events including reinstatement cycles — a carrier whose one
    # insurer billed-and-reinstated them 6 times would show as "6 cancellations"
    # in the top 0.4% nationally, while their actual insurance situation was
    # one stable policy with chronic billing friction. Empirically this changes
    # ~31,500 carriers from Elevated to Clean (NOOR/VOXSER-style false
    # positives) while keeping real chameleon insurance-shoppers flagged.
    # See conversation log + /tmp/distinct_vs_events_analysis for the data.
    c01_policy = pl.col("c08")  # policy_no — defined as column 8 in InsHist
    agg = (
        df.with_columns(
            within_24mo=pl.col("cancel_date") >= cutoff,
            is_cancel=is_cancel,
            policy_no=c01_policy,
        )
        .group_by("DOT_NUMBER")
        .agg(
            insurance_cancellations_24mo=(
                pl.col("policy_no")
                  .filter(pl.col("within_24mo") & pl.col("is_cancel"))
                  .n_unique()
            ),
            most_recent_cancel_date=pl.col("cancel_date").max().dt.strftime("%Y-%m-%d"),
            most_recent_cancel_reason=pl.col("cancellation_type")
                .filter(pl.col("cancel_date") == pl.col("cancel_date").max())
                .first(),
        )
    )

    # Detect rapid-replace pattern: any policy where the SAME DOT had two
    # events on the same policy_no within 30 days, one Cancelled + one Replaced.
    # Simpler proxy that catches the common pattern: any DOT with at least one
    # cancel-event AND at least one replace-event whose dates are <=30 days apart.
    paired = (
        df
        .filter(
            pl.col("cancellation_type").is_in(["Cancelled", "Replaced"])
        )
        .group_by("DOT_NUMBER")
        .agg(
            cancel_dates=pl.col("cancel_date").filter(pl.col("cancellation_type") == "Cancelled"),
            replace_dates=pl.col("cancel_date").filter(pl.col("cancellation_type") == "Replaced"),
        )
        .with_columns(
            rapid_replace_flag=(
                pl.col("cancel_dates").list.len() > 0
            )
            & (
                pl.col("replace_dates").list.len() > 0
            )
            & (
                # Pairwise min-distance approximation: if any replace_date is within
                # 30 days of any cancel_date. Polars doesn't have a clean cross-join
                # within group_by, so we approximate by taking min/max bounds.
                # If max(replace_date) >= min(cancel_date) - 30d AND
                #    min(replace_date) <= max(cancel_date) + 30d, there's plausible
                # overlap. Tightens further to: max replace within 30d of any cancel.
                (pl.col("replace_dates").list.max() - pl.col("cancel_dates").list.min()).dt.total_days().abs() <= 30
            )
        )
        .select("DOT_NUMBER", "rapid_replace_flag")
    )

    agg = agg.join(paired, on="DOT_NUMBER", how="left").with_columns(
        rapid_replace_flag=pl.col("rapid_replace_flag").fill_null(False)
    )

    print(f"Aggregated per-DOT: {agg.height:,} rows")
    print(agg.sort("insurance_cancellations_24mo", descending=True).head(5))

    # Merge into parquet
    pq = pl.read_parquet(PARQUET)
    print(f"\nParquet before merge: {pq.height:,} x {pq.width}")

    for col in agg.columns:
        if col != "DOT_NUMBER" and col in pq.columns:
            pq = pq.drop(col)

    merged = pq.join(agg, on="DOT_NUMBER", how="left").with_columns(
        insurance_cancellations_24mo=pl.col("insurance_cancellations_24mo").fill_null(0),
        rapid_replace_flag=pl.col("rapid_replace_flag").fill_null(False),
    )
    print(f"Parquet after merge: {merged.height:,} x {merged.width}")

    merged.write_parquet(PARQUET, compression="zstd")
    print(f"Wrote {PARQUET}")


if __name__ == "__main__":
    main()
