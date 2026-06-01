# /// script
# requires-python = ">=3.11"
# dependencies = ["polars>=1.0"]
# ///
"""Add phy_zip (5-digit physical-address ZIP) to carrier_aggregates, joined from
carrier_identity. A small, highly-repeating string column — feeds the analyzer's
ZIP-risk fraud marker (lookupZipRisk + zip-risk.json). Idempotent; re-run safe.

NB: this nudges the parquet toward the 100 MiB GitHub blob limit. If it ever
crosses, switch to precomputing a compact zip_risk_tier enum instead of the raw
ZIP (build_zip_risk.py already has the lift table)."""
import polars as pl
from pathlib import Path

AGG = Path("data/carrier_aggregates.parquet")
IDN = Path("data/carrier_identity.parquet")


def main() -> None:
    df = pl.read_parquet(AGG)
    if "phy_zip" in df.columns:
        df = df.drop("phy_zip")
    idn = pl.read_parquet(IDN).select(
        "DOT_NUMBER",
        pl.col("phy_zip").cast(pl.Utf8).str.extract(r"(\d{5})").alias("phy_zip"),
    )
    out = df.join(idn, on="DOT_NUMBER", how="left")
    out.write_parquet(AGG, compression="zstd")
    n = out.filter(pl.col("phy_zip").is_not_null()).height
    print(f"[add_phy_zip] rows={out.height:,} with phy_zip={n:,} -> {AGG} ({AGG.stat().st_size/1e6:.1f}MB)")


if __name__ == "__main__":
    main()
