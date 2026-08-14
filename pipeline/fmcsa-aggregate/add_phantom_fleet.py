# /// script
# requires-python = ">=3.11"
# dependencies = ["polars>=1.0"]
# ///
"""Add the phantom-fleet signal: distinct power-unit VINs seen in inspections.

The strongest single fraud predictor in the revocation backtest (13.5x lift): a
carrier that reports 1-2 power units but is inspected in dozens/hundreds of
DISTINCT trucks is running a rented/shared authority (one DOT used by many
operators — the double-broker / chameleon engine). We store the raw distinct
count; the analyzer computes the ratio vs reported power units and gates it
(corroborated by sub-min insurance / new authority) to exclude legit high-VIN
models (drive-away, leased owner-operators, stale-PU majors).

  pu_vins_inspected  int  # of distinct power-unit VINs in the 24-mo inspection
                          window (Unit_Type_Desc = tractor/truck/bus, not trailer)

Power-unit VIN ≈ reported power units for legit carriers (e.g. FOX 57 vs 51);
the fraud pattern is VINs >> reported PU (e.g. MYKTYBEK 49 vs 1).
"""
from __future__ import annotations

import os
from pathlib import Path
import polars as pl

# Repo-relative default. These pointed at the san-antonio workspace, so a
# standalone `uv run` silently read from (or wrote into) a different clone.
# Harmless under build_all, which supplies the env; wrong every other way.
REPO = Path(__file__).resolve().parents[2]

PARQUET = Path(os.environ.get(
    "FMCSA_PARQUET",
    REPO / "data" / "carrier_aggregates.parquet",
))
_REFRESH = os.environ.get("FMCSA_REFRESH_DIR")
INSP = (
    Path(os.environ["FMCSA_INSPECTION_FILE"]) if os.environ.get("FMCSA_INSPECTION_FILE")
    else Path(_REFRESH) / "SMS_Input_-_Inspection.csv" if _REFRESH
    else Path("/__unset__run-via-build_all.py-or-set-the-env-var__/SMS_Input_-_Inspection.csv")
)
POWER_UNIT_TYPES = [
    "TRUCK TRACTOR", "STRAIGHT TRUCK", "SCHOOL BUS", "BUS",
    "MOTOR COACH", "PASSENGER VAN", "LIMOUSINE",
]


def log(m: str) -> None:
    print(f"[add_phantom_fleet] {m}", flush=True)


def main() -> None:
    df = pl.read_parquet(PARQUET)
    if "pu_vins_inspected" in df.columns:
        df = df.drop("pu_vins_inspected")

    log(f"counting distinct power-unit VINs from {INSP.name} …")
    vins = (
        pl.scan_csv(INSP, infer_schema_length=0, ignore_errors=True)
        .filter(pl.col("Unit_Type_Desc").is_in(POWER_UNIT_TYPES))
        .filter(pl.col("VIN").is_not_null() & (pl.col("VIN").str.len_chars() >= 11))
        .group_by(pl.col("DOT_Number").cast(pl.Int64, strict=False).alias("DOT_NUMBER"))
        .agg(pu_vins_inspected=pl.col("VIN").n_unique())
        .filter(pl.col("DOT_NUMBER").is_not_null())
        .collect(engine="streaming")
    )
    log(f"carriers with inspected power-unit VINs: {vins.height:,}")

    out = df.join(vins, on="DOT_NUMBER", how="left").with_columns(
        pu_vins_inspected=pl.col("pu_vins_inspected").fill_null(0).cast(pl.Int64)
    )
    # quick sanity: phantom = >=10 VINs and >=4x reported power units
    n_phantom = out.filter(
        (pl.col("pu_vins_inspected") >= 10)
        & (pl.col("pu_vins_inspected") >= 4 * pl.max_horizontal(pl.col("power_units"), pl.lit(1)))
    ).height
    log(f"phantom-fleet candidates (>=10 VINs & >=4x reported PU): {n_phantom:,}")

    out.write_parquet(PARQUET, compression="zstd")
    log(f"wrote {PARQUET}")


if __name__ == "__main__":
    main()
