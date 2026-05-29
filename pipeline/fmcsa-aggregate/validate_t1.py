# /// script
# requires-python = ">=3.11"
# dependencies = ["polars>=1.0"]
# ///
"""
Validate the parquet-based scoring against T1's earlier API-based v7 action list.

Loads:
  - T1's booked carriers from .context/t1-fmcsa-2026-05-14/carriers.json
  - Our offline parquet from .context/fmcsa-aggregate/carrier_aggregates.parquet

Applies fixed thresholds (10% driver / 40% vehicle / 5% hazmat / 0.20 crash-per-truck)
and outputs a flagged list. Then compares to v7's 11 known flagged DOTs.
"""

from __future__ import annotations

import json
from pathlib import Path

import polars as pl

HERE = Path(__file__).parent
PARQUET = HERE / "carrier_aggregates.parquet"
T1_DIR = HERE.parent / "t1-fmcsa-2026-05-14"
CARRIERS_JSON = T1_DIR / "carriers.json"

# Fixed thresholds
DRIVER_OOS_CUT = 0.10
VEHICLE_OOS_CUT = 0.40
HAZMAT_OOS_CUT = 0.05
CRASH_PER_TRUCK_CUT = 0.20

# Sufficiency: don't flag on rate-only if too few inspections
MIN_DRIVER_INSP = 3
MIN_VEHICLE_INSP = 3
MIN_HAZMAT_INSP = 3
MIN_PU_FOR_CRASH = 1

# v7's flagged DOTs for comparison
V7_FLAGGED = {
    3621624: "DK MAX TRUCKING (crash 0.55)",
    2075148: "ASAP TRANS (crash 0.50)",
    2049859: "XYQ EXPRESS (driver OOS 36%)",
    3201000: "LETEM TRANSPORTATION (driver OOS 29%)",
    3168296: "AFS WORLD (hazmat OOS 22%)",
    2902577: "HSD TRANSPORT (crash 0.47)",
    3863705: "NOOR EXPRESS LOGISTICS (crash 0.34)",
    1221360: "MASCOW DISTRIBUTION (crash 0.39)",
    2282557: "GTC LOGISTICS (crash 0.32)",
    2448392: "JUAN TRANSPORTATION (crash 1.00)",
    4271503: "SKY GUARD SERVICES (crash 1.00)",
}


def main() -> None:
    t1 = json.loads(CARRIERS_JSON.read_text())
    t1_df = pl.DataFrame(
        [
            {"DOT_NUMBER": int(c["dotNumber"]), "loads_today": c["loadsToday"], "t1_name": c["name"]}
            for c in t1
        ]
    )
    print(f"T1 carriers booked today: {t1_df.height}")

    pq = pl.read_parquet(PARQUET)
    joined = t1_df.join(pq, on="DOT_NUMBER", how="left")
    missing = joined.filter(pl.col("LEGAL_NAME").is_null())
    print(f"Carriers not found in parquet: {missing.height}")
    if missing.height:
        print(missing.select("DOT_NUMBER", "t1_name").to_pandas().to_string(index=False))

    # Apply thresholds
    flagged = joined.with_columns(
        flag_driver=(pl.col("driver_oos_rate") >= DRIVER_OOS_CUT)
        & (pl.col("driver_inspections_24mo") >= MIN_DRIVER_INSP),
        flag_vehicle=(pl.col("vehicle_oos_rate") >= VEHICLE_OOS_CUT)
        & (pl.col("vehicle_inspections_24mo") >= MIN_VEHICLE_INSP),
        flag_hazmat=(pl.col("hazmat_oos_rate") >= HAZMAT_OOS_CUT)
        & (pl.col("hazmat_inspections_24mo") >= MIN_HAZMAT_INSP),
        flag_crash=(pl.col("crashes_per_truck") >= CRASH_PER_TRUCK_CUT)
        & (pl.col("power_units") >= MIN_PU_FOR_CRASH)
        & (pl.col("crashes_24mo") >= 1),
    ).with_columns(
        any_flag=pl.col("flag_driver") | pl.col("flag_vehicle") | pl.col("flag_hazmat") | pl.col("flag_crash"),
    )

    fl = flagged.filter(pl.col("any_flag")).sort(
        ["flag_crash", "crashes_per_truck", "driver_oos_rate", "vehicle_oos_rate"], descending=True
    )

    print(f"\n=== Parquet-based flagged carriers: {fl.height} ===")
    for row in fl.iter_rows(named=True):
        reasons = []
        if row["flag_crash"]:
            reasons.append(f"crash {row['crashes_per_truck']:.2f}/truck ({row['crashes_24mo']} on {row['power_units']} PU)")
        if row["flag_driver"]:
            reasons.append(f"driver OOS {row['driver_oos_rate']:.0%} ({row['driver_oos_24mo']}/{row['driver_inspections_24mo']})")
        if row["flag_vehicle"]:
            reasons.append(f"vehicle OOS {row['vehicle_oos_rate']:.0%} ({row['vehicle_oos_24mo']}/{row['vehicle_inspections_24mo']})")
        if row["flag_hazmat"]:
            reasons.append(f"hazmat OOS {row['hazmat_oos_rate']:.0%} ({row['hazmat_oos_24mo']}/{row['hazmat_inspections_24mo']})")
        print(f"  DOT {row['DOT_NUMBER']:>7}  loads={row['loads_today']}  {row['LEGAL_NAME']}: " + "; ".join(reasons))

    # Compare against v7
    parquet_dots = {row["DOT_NUMBER"] for row in fl.iter_rows(named=True)}
    v7_dots = set(V7_FLAGGED.keys())
    only_v7 = v7_dots - parquet_dots
    only_parquet = parquet_dots - v7_dots
    both = v7_dots & parquet_dots

    print("\n=== Comparison ===")
    print(f"Both methods flagged: {len(both)}")
    for d in sorted(both):
        print(f"  DOT {d}  {V7_FLAGGED[d]}")
    print(f"\nOnly v7 (API) flagged ({len(only_v7)}):")
    for d in sorted(only_v7):
        rowdf = joined.filter(pl.col("DOT_NUMBER") == d)
        if rowdf.height:
            r = rowdf.to_dicts()[0]
            print(f"  DOT {d}  {V7_FLAGGED[d]}")
            print(f"      parquet says: driver_oos={r.get('driver_oos_rate')}, "
                  f"vehicle_oos={r.get('vehicle_oos_rate')}, hazmat_oos={r.get('hazmat_oos_rate')}, "
                  f"crashes={r.get('crashes_24mo')}, PU={r.get('power_units')}, "
                  f"crash/truck={r.get('crashes_per_truck')}")
        else:
            print(f"  DOT {d}  {V7_FLAGGED[d]}  (NOT IN PARQUET)")
    print(f"\nOnly parquet flagged ({len(only_parquet)}):")
    for d in sorted(only_parquet):
        rowdf = fl.filter(pl.col("DOT_NUMBER") == d)
        r = rowdf.to_dicts()[0]
        print(f"  DOT {d}  {r['LEGAL_NAME']}")


if __name__ == "__main__":
    main()
