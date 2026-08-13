# /// script
# requires-python = ">=3.11"
# dependencies = ["polars>=1.0"]
# ///
"""Add home-state inspection share to carrier_aggregates — the fraction of a
carrier's roadside inspections that occur in its registered (physical) state.

Feeds the Risk score's "home-region mismatch" marker: a SMALL carrier whose
citations are mostly away from where it's registered shuts down ~1.3-1.4x more
(validated on 156k small fleets; base 23.8% → <10% in-home = 34%). Operating
where you're registered is *protective* (50%+ in-home = 0.76x). Confounded with
legit long-haul, so it's a deliberately light, small-fleet-gated soft signal.

Columns added:
  home_state_insp_share  float — in-home inspections ÷ total (null if <5 insp)
  insp_total_24mo        int   — total inspections seen in the SMS inspection file
"""
import os
from pathlib import Path
import polars as pl

AGG = Path(os.environ.get("FMCSA_PARQUET", "data/carrier_aggregates.parquet"))
INSP = Path(os.environ.get(
    "FMCSA_INSPECTION_FILE",
    "data/sources/SMS_Input_-_Inspection.csv"  # undated: what the downloader writes,
))
MIN_INSP = 5  # below this the share is too noisy to score


def main() -> None:
    agg = pl.read_parquet(AGG)
    for col in ("home_state_insp_share", "insp_total_24mo"):
        if col in agg.columns:
            agg = agg.drop(col)
    home = agg.select(
        pl.col("DOT_NUMBER").alias("dot"),
        pl.col("physical_state").alias("home"),
    )
    geo = (
        pl.scan_csv(INSP, infer_schema_length=0, ignore_errors=True)
        .select(
            dot=pl.col("DOT_Number").cast(pl.Int64, strict=False),
            st=pl.col("Report_State"),
        )
        .filter(pl.col("dot").is_not_null() & pl.col("st").is_not_null())
        .join(home.lazy(), on="dot", how="left")
        .group_by("dot")
        .agg(
            insp_total_24mo=pl.len(),
            in_home=(pl.col("st") == pl.col("home")).sum(),
        )
        .with_columns(
            home_state_insp_share=pl.when(pl.col("insp_total_24mo") >= MIN_INSP)
            .then(pl.col("in_home") / pl.col("insp_total_24mo"))
            .otherwise(None)
        )
        .select("dot", "insp_total_24mo", "home_state_insp_share")
        .collect(engine="streaming")
    )
    merged = agg.join(geo, left_on="DOT_NUMBER", right_on="dot", how="left").with_columns(
        pl.col("insp_total_24mo").fill_null(0)
    )
    merged.write_parquet(AGG, compression="zstd")
    n = merged.filter(pl.col("home_state_insp_share").is_not_null()).height
    print(f"[add_geo_mismatch] scored {n:,} carriers (>= {MIN_INSP} insp) -> {AGG} ({AGG.stat().st_size/1e6:.1f}MB)")


if __name__ == "__main__":
    main()
