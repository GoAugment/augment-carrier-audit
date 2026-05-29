# /// script
# requires-python = ">=3.11"
# dependencies = ["polars>=1.0"]
# ///
"""
Re-compute national thresholds from the existing carrier_aggregates.parquet.

Adds two refinements over the initial pass:
  1. Higher MIN_INSP cutoff (10) to dampen small-fleet noise. Reports BOTH 3 and 10.
  2. Conditional crash threshold among meaningful fleets (PU>=5) with >=1 crash.

Outputs:
  - national_thresholds_v2.json
"""

from __future__ import annotations

import json
from pathlib import Path

import polars as pl

HERE = Path(__file__).parent
PARQUET = HERE / "carrier_aggregates.parquet"
OUT = HERE / "national_thresholds_v2.json"


def pcts(series: pl.Series, n: int) -> dict:
    if n == 0:
        return {"n": 0}
    return {
        "n": n,
        "p50": float(series.quantile(0.50) or 0),
        "p75": float(series.quantile(0.75) or 0),
        "p85": float(series.quantile(0.85) or 0),
        "p90": float(series.quantile(0.90) or 0),
        "p95": float(series.quantile(0.95) or 0),
        "p99": float(series.quantile(0.99) or 0),
    }


def threshold_for(df: pl.DataFrame, *, value_col: str, insp_col: str, min_insp: int) -> dict:
    sub = df.filter(pl.col(insp_col) >= min_insp)
    series = sub[value_col].drop_nulls()
    return pcts(series, len(series))


def crash_threshold(df: pl.DataFrame, *, min_pu: int, only_with_crashes: bool) -> dict:
    sub = df.filter(pl.col("power_units") >= min_pu)
    if only_with_crashes:
        sub = sub.filter(pl.col("crashes_24mo") >= 1)
    series = sub["crashes_per_truck"].drop_nulls()
    return pcts(series, len(series))


def inspection_weighted_rate(df: pl.DataFrame, *, num_col: str, den_col: str) -> float:
    """Sum-of-numerators / sum-of-denominators across all carriers — the headline national rate."""
    num = df[num_col].sum()
    den = df[den_col].sum()
    return float(num / den) if den else 0.0


def main() -> None:
    df = pl.read_parquet(PARQUET)
    print(f"Loaded {df.height:,} carriers")

    out: dict = {
        "snapshot_date": 20260514,
        "window_start": 20240514,
        "carrier_count_total": df.height,
        "national_inspection_weighted_rates": {
            "driver_oos": inspection_weighted_rate(df, num_col="driver_oos_24mo", den_col="driver_inspections_24mo"),
            "vehicle_oos": inspection_weighted_rate(df, num_col="vehicle_oos_24mo", den_col="vehicle_inspections_24mo"),
            "hazmat_oos": inspection_weighted_rate(df, num_col="hazmat_oos_24mo", den_col="hazmat_inspections_24mo"),
        },
        "driver_oos_rate": {
            "min_insp_3": threshold_for(df, value_col="driver_oos_rate", insp_col="driver_inspections_24mo", min_insp=3),
            "min_insp_10": threshold_for(df, value_col="driver_oos_rate", insp_col="driver_inspections_24mo", min_insp=10),
            "min_insp_20": threshold_for(df, value_col="driver_oos_rate", insp_col="driver_inspections_24mo", min_insp=20),
        },
        "vehicle_oos_rate": {
            "min_insp_3": threshold_for(df, value_col="vehicle_oos_rate", insp_col="vehicle_inspections_24mo", min_insp=3),
            "min_insp_10": threshold_for(df, value_col="vehicle_oos_rate", insp_col="vehicle_inspections_24mo", min_insp=10),
            "min_insp_20": threshold_for(df, value_col="vehicle_oos_rate", insp_col="vehicle_inspections_24mo", min_insp=20),
        },
        "hazmat_oos_rate": {
            "min_insp_3": threshold_for(df, value_col="hazmat_oos_rate", insp_col="hazmat_inspections_24mo", min_insp=3),
            "min_insp_5": threshold_for(df, value_col="hazmat_oos_rate", insp_col="hazmat_inspections_24mo", min_insp=5),
            "min_insp_10": threshold_for(df, value_col="hazmat_oos_rate", insp_col="hazmat_inspections_24mo", min_insp=10),
        },
        "crashes_per_truck": {
            "pu_ge_1_all": crash_threshold(df, min_pu=1, only_with_crashes=False),
            "pu_ge_5_all": crash_threshold(df, min_pu=5, only_with_crashes=False),
            "pu_ge_5_with_crash": crash_threshold(df, min_pu=5, only_with_crashes=True),
            "pu_ge_10_with_crash": crash_threshold(df, min_pu=10, only_with_crashes=True),
        },
    }

    OUT.write_text(json.dumps(out, indent=2))
    print(f"Wrote {OUT}\n")

    # Pretty summary
    print("=== National inspection-weighted rates (single number, all carriers) ===")
    for k, v in out["national_inspection_weighted_rates"].items():
        print(f"  {k:>14}: {v:.4f}  ({v*100:.2f}%)")

    print("\n=== Per-carrier P85 (carrier-weighted distribution) ===")
    print("Signal                  | n           | P85       | P95")
    print("------------------------|-------------|-----------|------")
    for label, sect, key in [
        ("Driver OOS  (insp>=3)",  out["driver_oos_rate"], "min_insp_3"),
        ("Driver OOS  (insp>=10)", out["driver_oos_rate"], "min_insp_10"),
        ("Driver OOS  (insp>=20)", out["driver_oos_rate"], "min_insp_20"),
        ("Vehicle OOS (insp>=3)",  out["vehicle_oos_rate"], "min_insp_3"),
        ("Vehicle OOS (insp>=10)", out["vehicle_oos_rate"], "min_insp_10"),
        ("Vehicle OOS (insp>=20)", out["vehicle_oos_rate"], "min_insp_20"),
        ("Hazmat OOS  (insp>=3)",  out["hazmat_oos_rate"], "min_insp_3"),
        ("Hazmat OOS  (insp>=5)",  out["hazmat_oos_rate"], "min_insp_5"),
        ("Hazmat OOS  (insp>=10)", out["hazmat_oos_rate"], "min_insp_10"),
    ]:
        t = sect[key]
        print(f"{label:24}| n={t['n']:>9,} | {t['p85']:.4f}   | {t['p95']:.4f}")

    print("\n=== Crash-per-truck thresholds ===")
    print("Filter                          | n           | P85       | P95")
    print("--------------------------------|-------------|-----------|------")
    for label, key in [
        ("All PU>=1 (incl. zero-crash)",   "pu_ge_1_all"),
        ("PU>=5  (incl. zero-crash)",      "pu_ge_5_all"),
        ("PU>=5  AND >=1 crash",            "pu_ge_5_with_crash"),
        ("PU>=10 AND >=1 crash",            "pu_ge_10_with_crash"),
    ]:
        t = out["crashes_per_truck"][key]
        print(f"{label:32}| n={t['n']:>9,} | {t['p85']:.4f}   | {t['p95']:.4f}")


if __name__ == "__main__":
    main()
