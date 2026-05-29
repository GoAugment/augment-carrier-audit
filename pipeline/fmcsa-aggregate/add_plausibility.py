# /// script
# requires-python = ">=3.11"
# dependencies = ["polars>=1.0"]
# ///
"""
Add fleet-plausibility columns to carrier_aggregates.parquet.

New columns:
  - inspections_per_pu       : inspections_24mo / power_units (yearly: divide by 2)
  - crashes_per_inspection   : crashes_24mo / inspections_24mo (PU-independent crash signal)
  - fleet_size_flag          : 'tiny' | 'plausible' | 'low-activity' | 'unknown'
       - tiny:           power_units <= 2
       - low-activity:   power_units >= 5 AND inspections_per_pu < 1.0
                         (i.e. < 1 inspection per truck in 24 months; suggests inflated PU)
       - plausible:      power_units >= 1 AND inspections_per_pu >= 0.5
       - unknown:        power_units is null or 0

Industry baseline: a typical operating truck sees ~1-3 inspections per year, so 24-mo
expectation is ~2-6 inspections per PU. < 0.5 over 24 months is a strong signal that
the carrier's self-reported PU is much larger than its actual operating fleet.
"""

from __future__ import annotations

from pathlib import Path

import polars as pl

HERE = Path(__file__).parent
IN_PARQUET = HERE / "carrier_aggregates.parquet"
OUT_PARQUET = HERE / "carrier_aggregates.parquet"  # overwrite in place


def main() -> None:
    df = pl.read_parquet(IN_PARQUET)
    print(f"Loaded {df.height:,} carriers x {df.width} columns")

    df = df.with_columns(
        inspections_per_pu=pl.when((pl.col("power_units").is_not_null()) & (pl.col("power_units") > 0))
        .then(pl.col("inspections_24mo").fill_null(0) / pl.col("power_units"))
        .otherwise(None),
        crashes_per_inspection=pl.when(pl.col("inspections_24mo") > 0)
        .then(pl.col("crashes_24mo") / pl.col("inspections_24mo"))
        .otherwise(None),
    ).with_columns(
        fleet_size_flag=(
            pl.when(pl.col("power_units").is_null() | (pl.col("power_units") == 0))
            .then(pl.lit("unknown"))
            .when(pl.col("power_units") <= 2)
            .then(pl.lit("tiny"))
            .when((pl.col("power_units") >= 5) & (pl.col("inspections_per_pu") < 1.0))
            .then(pl.lit("low-activity"))
            .otherwise(pl.lit("plausible"))
        ),
    )

    print(f"After adding columns: {df.width} columns")
    print("\nfleet_size_flag distribution:")
    print(df.group_by("fleet_size_flag").len().sort("len", descending=True))

    df.write_parquet(OUT_PARQUET, compression="zstd")
    print(f"\nWrote {OUT_PARQUET}")

    # Spot check the disputed carriers
    print("\n=== Spot-check known carriers ===")
    sub = df.filter(pl.col("DOT_NUMBER").is_in([2282557, 3863705, 3621624, 2075148, 3943677])).select(
        "DOT_NUMBER", "LEGAL_NAME", "power_units", "inspections_24mo",
        "inspections_per_pu", "crashes_24mo", "crashes_per_truck",
        "crashes_per_inspection", "fleet_size_flag",
    )
    print(sub)


if __name__ == "__main__":
    main()
