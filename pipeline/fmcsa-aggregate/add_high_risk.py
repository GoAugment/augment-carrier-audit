# /// script
# requires-python = ">=3.11"
# dependencies = ["polars>=1.0"]
# ///
"""Add FMCSA FAST Act §5305 "High-Risk" carrier flag.

FMCSA identifies High-Risk carriers for onsite investigation under the Fixing
America's Surface Transportation (FAST) Act, Section 5305. Criteria (per
FMCSA's "Status of High-Risk Carrier Investigations" report, current since
Jan 2016):

  Passenger carriers:
    2+ of {Unsafe Driving, Crash Indicator, HOS Compliance, Vehicle
    Maintenance} at or above the 90th percentile for ONE month; AND no onsite
    investigation in the previous 12 months.

  Non-passenger carriers:
    same 2-of-4 at >=90th percentile for TWO CONSECUTIVE months; AND no onsite
    investigation in the previous 18 months.

These four are the BASICs FMCSA considers most correlated with crash risk.

Distinct from:
  - ISS Group 1 "high-risk" (2012 ISS algorithm: 4+ BASICs, or 2+ with
    UD/HOS/CI >=85th). Different BASIC set + threshold + purpose (roadside
    inspection priority, not investigation targeting). See compute_iss.py.
  - The withdrawn 2016 Safety Fitness Determination NPRM (absolute measures,
    "unfit" determination). Withdrawn 2017; NOT implemented anywhere here.

WHAT WE COMPUTE (and its limits — we don't guess):
  - The percentile component: 2+ of the four BASICs at >=90th percentile,
    using the CURRENT snapshot's percentiles.
  - We do NOT apply the "two consecutive months" persistence test (we have a
    single monthly snapshot, not a time series) — so the flag is the
    single-month version, slightly over-inclusive for non-passenger carriers.
    This is conservative for a risk signal and labelled as such.
  - We do NOT apply the "no onsite investigation in 12/18mo" exclusion. That
    exclusion is about FMCSA's investigation WORKLOAD (don't re-investigate),
    not about carrier risk. A carrier meeting the threshold is high-risk
    whether or not FMCSA recently looked at it.
  - Crash Indicator percentile is only populated for carriers with scraped
    Avg PU (~21k crash-sufficient). High-risk status that depends on CI is
    therefore UNDERCOUNTED until CI coverage is broader. UD/HOS/VM are
    complete.

Columns added to carrier_aggregates.parquet:
  fast_act_high_risk_n       int   — count of the four BASICs at >=90th pctile
  fast_act_high_risk         bool  — n >= 2
  fast_act_high_risk_basics  str   — which BASICs, e.g. "UD+VM" ("" if none)
"""
from __future__ import annotations

import os
from pathlib import Path
import polars as pl

PARQUET = Path(
    os.environ.get(
        "FMCSA_PARQUET",
        "/Users/art/conductor/workspaces/augment-carrier-audit-v1/san-antonio/"
        "data/carrier_aggregates.parquet",
    )
)

# The four crash-correlated BASICs FMCSA uses for High-Risk identification,
# with the percentile column and a short display code for each.
HIGH_RISK_BASICS = [
    ("unsafe_driving_percentile", "UD"),
    ("crash_indicator_percentile", "CI"),
    ("hos_percentile", "HOS"),
    ("vehicle_maintenance_percentile", "VM"),
]
THRESHOLD = 90.0


def log(m: str) -> None:
    print(f"[add_high_risk] {m}", flush=True)


def main() -> None:
    log(f"Reading {PARQUET.name}…")
    df = pl.read_parquet(PARQUET)
    log(f"  rows: {df.height:,}")

    # Idempotent re-run support.
    for c in ("fast_act_high_risk_n", "fast_act_high_risk", "fast_act_high_risk_basics"):
        if c in df.columns:
            df = df.drop(c)

    # Per-BASIC ">=90th percentile" booleans (null percentile → not at-threshold).
    at_threshold = {
        code: (pl.col(col).fill_null(-1.0) >= THRESHOLD)
        for col, code in HIGH_RISK_BASICS
    }

    n_expr = sum(expr.cast(pl.Int8) for expr in at_threshold.values())

    # Compact "which BASICs" string, e.g. "UD+VM".
    basics_expr = pl.concat_str(
        [
            pl.when(at_threshold[code]).then(pl.lit(code + "+")).otherwise(pl.lit(""))
            for _, code in HIGH_RISK_BASICS
        ]
    ).str.strip_chars_end("+")

    df = df.with_columns(
        fast_act_high_risk_n=n_expr,
        fast_act_high_risk_basics=basics_expr,
    ).with_columns(
        fast_act_high_risk=pl.col("fast_act_high_risk_n") >= 2,
    )

    n_hr = df.filter(pl.col("fast_act_high_risk")).height
    log(f"  FAST Act high-risk carriers (2+ of 4 at >=90th): {n_hr:,}")
    log("  breakdown by # of BASICs at >=90th:")
    print(
        df.group_by("fast_act_high_risk_n").len().sort("fast_act_high_risk_n")
    )
    log("  top BASIC combos among high-risk:")
    print(
        df.filter(pl.col("fast_act_high_risk"))
        .group_by("fast_act_high_risk_basics")
        .len()
        .sort("len", descending=True)
        .head(10)
    )

    df.write_parquet(PARQUET, compression="zstd")
    log(f"Wrote {PARQUET}")


if __name__ == "__main__":
    main()
