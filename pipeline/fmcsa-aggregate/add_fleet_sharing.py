# /// script
# requires-python = ">=3.11"
# dependencies = ["polars>=1.0"]
# ///
"""
Compute per-DOT fleet-sharing signals from the inspection file. Adds five
columns to carrier_aggregates.parquet:

  largest_sibling_dot              int    - active DOT sharing the most VINs
  largest_sibling_shared_vins      int    - # of VINs shared with that sibling
  largest_sibling_total_vins       int    - this carrier's total inspected VINs
  largest_sibling_overlap_pct      float  - shared / total * 100
  largest_sibling_legal_name       str    - name of the largest sibling DOT

These five columns let the analyzer fire chameleon-shared-fleet at three
tiers based on overlap %, with address + name comparison done in TS at
evaluator time.

Method: pairwise VIN intersection via a single self-join on (VIN, active-DOT).
For each (DOT_A, DOT_B) pair sharing a VIN, count distinct VINs. Keep
only the largest sibling per DOT_A. O(N) Polars, no Python loops.
"""
from pathlib import Path
import polars as pl

HERE = Path(__file__).parent
PARQUET = HERE / "carrier_aggregates.parquet"
INSP = Path("/Users/art/Downloads/SMS_Input_-_Inspection_20260518.csv")

def log(msg): print(f"[add_fleet_sharing] {msg}", flush=True)

log(f"Reading {PARQUET.name}...")
agg = pl.read_parquet(PARQUET)
active_dots = agg.filter(pl.col("status_code") == "A").select("DOT_NUMBER")
active_set = set(active_dots["DOT_NUMBER"].to_list())
log(f"Active carriers: {len(active_set):,}")

# Peek inspection schema
peek = pl.scan_csv(INSP, n_rows=5, ignore_errors=True).collect()
vin_col = next(c for c in peek.columns if "VIN" in c.upper())
dot_col = next(c for c in peek.columns if c.upper() in ("DOT_NUMBER", "DOTNUMBER"))
log(f"VIN column: {vin_col}, DOT column: {dot_col}")

# Step 1: (DOT, VIN) unique pairs, active carriers only
log("Step 1: extracting unique (active-DOT, VIN) pairs...")
pairs = (
    pl.scan_csv(INSP, schema_overrides={dot_col: pl.Int64}, ignore_errors=True)
    .filter(pl.col(vin_col).is_not_null())
    .filter(pl.col(vin_col).str.len_chars() >= 10)
    .filter(pl.col(dot_col).is_in(list(active_set)))
    .select(pl.col(vin_col).alias("vin"), pl.col(dot_col).alias("dot"))
    .unique()
    .collect(engine="streaming")
)
log(f"Unique (DOT, VIN) pairs: {pairs.height:,}")

# Step 2: per-DOT total inspected VINs
log("Step 2: per-DOT total VIN counts...")
total_vins = pairs.group_by("dot").agg(pl.len().alias("total_vins"))

# Step 3: self-join on VIN to get pairs of co-occurring DOTs
log("Step 3: VIN self-join (this is the expensive step)...")
left = pairs.rename({"dot": "dot_a"})
right = pairs.rename({"dot": "dot_b"})
joined = left.join(right, on="vin").filter(pl.col("dot_a") != pl.col("dot_b"))
log(f"Co-occurring DOT-pair rows: {joined.height:,}")

# Step 4: count shared VINs per (dot_a, dot_b)
log("Step 4: aggregating pair counts...")
pair_counts = (
    joined.group_by(["dot_a", "dot_b"])
    .agg(pl.len().alias("shared_vins"))
)
log(f"Distinct DOT-pairs with shared VINs: {pair_counts.height:,}")

# Step 5: for each dot_a, keep the largest sibling
log("Step 5: per-DOT largest sibling...")
largest = (
    pair_counts.sort(["dot_a", "shared_vins"], descending=[False, True])
    .group_by("dot_a", maintain_order=True)
    .agg(
        pl.col("dot_b").first().alias("largest_sibling_dot"),
        pl.col("shared_vins").first().alias("largest_sibling_shared_vins"),
    )
    .rename({"dot_a": "DOT_NUMBER"})
)
log(f"Carriers with at least one sibling: {largest.height:,}")

# Step 6: bring in total VIN count + sibling name
log("Step 6: enriching with totals + sibling name...")
sibling_names = (
    agg.select("DOT_NUMBER", "LEGAL_NAME")
    .rename({"DOT_NUMBER": "largest_sibling_dot", "LEGAL_NAME": "largest_sibling_legal_name"})
)
enriched = (
    largest
    .join(total_vins.rename({"dot": "DOT_NUMBER", "total_vins": "largest_sibling_total_vins"}), on="DOT_NUMBER", how="left")
    .join(sibling_names, on="largest_sibling_dot", how="left")
    .with_columns(
        largest_sibling_overlap_pct=(
            pl.col("largest_sibling_shared_vins") / pl.col("largest_sibling_total_vins") * 100.0
        )
    )
)

# Step 7: join back into main parquet, write
log("Step 7: writing updated parquet...")
out = (
    agg.join(enriched, on="DOT_NUMBER", how="left")
    .with_columns(
        largest_sibling_shared_vins=pl.col("largest_sibling_shared_vins").fill_null(0),
        largest_sibling_total_vins=pl.col("largest_sibling_total_vins").fill_null(0),
        largest_sibling_overlap_pct=pl.col("largest_sibling_overlap_pct").fill_null(0.0),
    )
)
log(f"Final shape: {out.shape}")
out.write_parquet(PARQUET, compression="zstd")
log(f"Wrote {PARQUET}")

# Quick sanity sample
log("\nSample carriers with high fleet overlap:")
sample = (
    out.filter(pl.col("largest_sibling_overlap_pct") >= 50)
    .filter(pl.col("largest_sibling_shared_vins") >= 10)
    .sort("largest_sibling_overlap_pct", descending=True)
    .head(10)
    .select("DOT_NUMBER", "LEGAL_NAME", "largest_sibling_dot",
            "largest_sibling_legal_name", "largest_sibling_shared_vins",
            "largest_sibling_total_vins", "largest_sibling_overlap_pct")
)
print(sample)
