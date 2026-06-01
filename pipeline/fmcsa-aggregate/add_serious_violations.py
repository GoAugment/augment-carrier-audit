# /// script
# requires-python = ">=3.11"
# dependencies = ["polars>=1.0"]
# ///
"""Wire scraped Serious Violations into the BASIC percentiles/alerts per ISS.

Per the ISS-CSA Algorithm doc: if a carrier was found to have a Serious
(acute/critical) Violation during an investigation in the prior 12 months,
"the associated BASIC value for that violation is set to 100 before continuing
the [ISS] calculations." A Serious Violation with no associated BASIC sets the
final ISS to 74 (the "insurance/other" Group 6 case).

Input:  data/fmcsa_scrape/serious_violations_<TAG>.parquet (from
        fetch_serious_violations.py)
Effect: for each (DOT, BASIC) with a recent Serious Violation, force
        <basic>_percentile = 100 and <basic>_alert = 'Y' in the main parquet,
        and add:
          serious_violation_count          int   # SV rows in last 12mo
          serious_violation_basics         str   # e.g. "HOS+VM"
          serious_violation_no_basic        bool  # any SV with no BASIC → ISS 74
          has_serious_violation             bool

Run AFTER compute_basics.py (which sets the percentiles/alerts) and BEFORE
compute_iss.py (which reads them).
"""
from __future__ import annotations

import os
from pathlib import Path
import polars as pl

PARQUET = Path(os.environ.get("FMCSA_PARQUET", "/Users/art/conductor/workspaces/augment-carrier-audit-v1/san-antonio/data/carrier_aggregates.parquet"))
SV = Path("/Users/art/conductor/workspaces/augment-carrier-audit-v1/san-antonio/data/fmcsa_scrape/serious_violations_20260514.parquet")

# Map the XLSX BASIC label → our column prefix + a short code.
BASIC_MAP = {
    "Unsafe Driving": ("unsafe_driving", "UD"),
    "HOS Compliance": ("hos", "HOS"),
    "Driver Fitness": ("driver_fitness", "DF"),
    "Drugs/Alcohol": ("controlled_substances", "CS"),
    "Vehicle Maint.": ("vehicle_maintenance", "VM"),
    "HM Compliance": ("hm_compliance", "HM"),
    # Crash Indicator is never an investigation violation (crashes aren't cited).
}


def log(m: str) -> None:
    print(f"[add_serious_violations] {m}", flush=True)


def main() -> None:
    df = pl.read_parquet(PARQUET)
    log(f"parquet: {df.shape}")
    if not SV.exists():
        log(f"no SV file at {SV} — skipping (Group 6 stays empty)")
        return
    sv = pl.read_parquet(SV)
    # The per-carrier XLSX only lists acute/critical violations from the last
    # 12 months, so every scraped row already qualifies; no date filter needed.
    log(f"SV rows: {sv.height:,}  distinct DOTs: {sv['dot_number'].n_unique():,}")

    # Idempotent re-run support.
    for c in ("serious_violation_count", "serious_violation_basics",
              "serious_violation_no_basic", "has_serious_violation"):
        if c in df.columns:
            df = df.drop(c)

    # Per-DOT: which BASICs have a Serious Violation + counts + any no-BASIC.
    sv = sv.with_columns(
        prefix=pl.col("basic").replace_strict(
            {k: v[0] for k, v in BASIC_MAP.items()}, default=None),
        code=pl.col("basic").replace_strict(
            {k: v[1] for k, v in BASIC_MAP.items()}, default=None),
    )
    per_dot = sv.group_by("dot_number").agg(
        serious_violation_count=pl.len().cast(pl.Int64),
        serious_violation_basics=pl.col("code").drop_nulls().unique().sort().str.join("+"),
        serious_violation_no_basic=pl.col("basic").is_null().any(),
        _affected=pl.col("prefix").drop_nulls().unique(),
    ).rename({"dot_number": "DOT_NUMBER"})

    df = df.join(per_dot, on="DOT_NUMBER", how="left").with_columns(
        has_serious_violation=pl.col("serious_violation_count").is_not_null(),
        serious_violation_count=pl.col("serious_violation_count").fill_null(0),
        serious_violation_no_basic=pl.col("serious_violation_no_basic").fill_null(False),
    )

    # Force percentile=100 + alert=Y for each affected BASIC (methodology: SV
    # sets the BASIC to 100 regardless of roadside data sufficiency).
    bumped = {}
    for label, (prefix, _code) in BASIC_MAP.items():
        pct_col, alert_col = f"{prefix}_percentile", f"{prefix}_alert"
        has_sv_in_basic = pl.col("_affected").list.contains(prefix).fill_null(False)
        if pct_col in df.columns:
            df = df.with_columns(
                **{pct_col: pl.when(has_sv_in_basic).then(100.0).otherwise(pl.col(pct_col))}
            )
        if alert_col in df.columns:
            df = df.with_columns(
                **{alert_col: pl.when(has_sv_in_basic).then(pl.lit("Y")).otherwise(pl.col(alert_col))}
            )
        bumped[prefix] = df.filter(has_sv_in_basic).height

    df = df.drop("_affected")
    log(f"carriers flagged with Serious Violations: {df.filter(pl.col('has_serious_violation')).height:,}")
    log(f"  BASIC percentile→100 bumps: {bumped}")
    log(f"  SV with no associated BASIC (ISS-74 case): {df.filter(pl.col('serious_violation_no_basic')).height:,}")

    df.write_parquet(PARQUET, compression="zstd")
    log(f"wrote {PARQUET}")


if __name__ == "__main__":
    main()
