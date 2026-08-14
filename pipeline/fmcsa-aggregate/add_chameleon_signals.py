# /// script
# requires-python = ">=3.11"
# dependencies = ["polars>=1.0"]
# ///
"""Add chameleon-detection signal columns that span fleet-sharing AND
insurance history. Touches two source files (inspection CSV + InsHist text)
to produce a coherent set of signals that all feed into chameleon-cluster.

Columns added to carrier_aggregates.parquet:
  diffuse_vin_share_pct            % of own VINs that have run under ANY
                                   other active DOT (versus the concentrated
                                   overlap with a single sibling captured by
                                   largest_sibling_overlap_pct in
                                   add_fleet_sharing.py)
  diffuse_vin_share_n_siblings     count of distinct other-DOTs that
                                   inspected ≥1 of this carrier's VINs
  insurance_replaces_24mo          # of 'Replaced' events on BIPD policies
                                   in last 24mo (vs 'Cancelled' events
                                   already captured by add_inshist.py)
  insurance_distinct_policies_24mo # of distinct BIPD policy_nos touched in
                                   last 24mo (any event)

Why one script for both: the diffuse-equipment signal and the all-cancel
insurance pattern both feed chameleon-cluster. Keeping them together makes
it easy to inspect them as a unit when debugging false positives. Could
later be split: insurance half → add_inshist.py, diffuse half →
add_fleet_sharing.py.
"""
import os
from pathlib import Path
import polars as pl

# Repo-relative default. These pointed at the san-antonio workspace, so a
# standalone `uv run` silently read from (or wrote into) a different clone.
# Harmless under build_all, which supplies the env; wrong every other way.
REPO = Path(__file__).resolve().parents[2]

PARQUET = Path(os.environ.get("FMCSA_PARQUET", REPO / "data" / "carrier_aggregates.parquet"))
_RD = os.environ.get("FMCSA_REFRESH_DIR")
INSP = (
    Path(os.environ["FMCSA_INSPECTION_FILE"]) if os.environ.get("FMCSA_INSPECTION_FILE")
    else Path(_RD) / "SMS_Input_-_Inspection.csv" if _RD
    else Path("/__unset__run-via-build_all.py-or-set-the-env-var__/SMS_Input_-_Inspection.csv")
)
INSHIST = Path(os.environ.get("FMCSA_INSHIST", "/__unset__run-via-build_all.py-or-set-the-env-var__/inshist_allwithhistory.txt"))
# Derived from the same env var as the rest of the pipeline; this was a
# literal that had to be remembered every refresh.
_sd = os.environ.get("FMCSA_SNAPSHOT_DATE", "20260812")
SNAPSHOT_DATE = f"{_sd[:4]}-{_sd[4:6]}-{_sd[6:]}"

def log(m): print(f"[add_new_signals] {m}", flush=True)

log(f"Reading {PARQUET.name}...")
agg = pl.read_parquet(PARQUET)
log(f"Parquet: {agg.shape}")
active_set = set(agg.filter(pl.col("status_code") == "A")["DOT_NUMBER"].to_list())
log(f"Active carriers: {len(active_set):,}")

# === DIFFUSE EQUIPMENT ===
peek = pl.scan_csv(INSP, n_rows=5, ignore_errors=True).collect()
vin_col = next(c for c in peek.columns if "VIN" in c.upper())
dot_col = next(c for c in peek.columns if c.upper() in ("DOT_NUMBER", "DOTNUMBER"))

log(f"Step A1: unique (active-DOT, VIN) pairs...")
pairs = (
    pl.scan_csv(INSP, schema_overrides={dot_col: pl.Int64}, ignore_errors=True)
    .filter(pl.col(vin_col).is_not_null())
    .filter(pl.col(vin_col).str.len_chars() >= 10)
    .filter(pl.col(dot_col).is_in(list(active_set)))
    .select(pl.col(vin_col).alias("vin"), pl.col(dot_col).alias("dot"))
    .unique()
    .collect(engine="streaming")
)
log(f"  pairs: {pairs.height:,}")

log("Step A2: per-VIN count of distinct active DOTs that have inspected it...")
vin_dot_count = pairs.group_by("vin").agg(pl.col("dot").n_unique().alias("vin_n_dots"))
log(f"  unique VINs: {vin_dot_count.height:,}")

log("Step A3: per-DOT total VINs + count of shared VINs (>=2 DOTs) + count of distinct other-DOTs...")
pairs_with_count = pairs.join(vin_dot_count, on="vin")
per_dot_totals = pairs.group_by("dot").agg(pl.len().alias("total_vins"))
per_dot_shared = (
    pairs_with_count
    .filter(pl.col("vin_n_dots") >= 2)
    .group_by("dot")
    .agg(pl.len().alias("shared_vins_any"))
)

# Distinct other-DOTs: self-join on vin
log("Step A4: self-join for distinct sibling-DOT counts...")
left = pairs.rename({"dot": "dot_a"})
right = pairs.rename({"dot": "dot_b"})
joined = left.join(right, on="vin").filter(pl.col("dot_a") != pl.col("dot_b"))
per_dot_siblings = (
    joined.group_by("dot_a")
    .agg(pl.col("dot_b").n_unique().alias("n_distinct_siblings"))
    .rename({"dot_a": "dot"})
)

diffuse = (
    per_dot_totals
    .join(per_dot_shared, on="dot", how="left")
    .join(per_dot_siblings, on="dot", how="left")
    .with_columns(
        shared_vins_any=pl.col("shared_vins_any").fill_null(0),
        n_distinct_siblings=pl.col("n_distinct_siblings").fill_null(0),
    )
    .with_columns(
        diffuse_vin_share_pct=(
            pl.col("shared_vins_any") / pl.col("total_vins") * 100.0
        )
    )
    .select(
        pl.col("dot").alias("DOT_NUMBER"),
        pl.col("diffuse_vin_share_pct"),
        pl.col("n_distinct_siblings").alias("diffuse_vin_share_n_siblings"),
    )
)
log(f"  diffuse rows: {diffuse.height:,}")
log(f"  sample (top by spread): {diffuse.sort('diffuse_vin_share_n_siblings', descending=True).head(5)}")

# === SHUT-DOWN EQUIPMENT PREDECESSORS ===
# Which of this carrier's VIN-sharing partners has FMCSA already shut down?
#
# The classic chameleon succession: the old authority is revoked, the trucks
# move to a new one. The diffuse counter above treats such a partner exactly
# like any other, which throws away the strongest signal in it. Measured on this
# vintage with a temporal split (partner revoked before 2026-02-12, carrier's own
# revocation after), against a 1.15% base rate:
#     1 shut-down partner    11,428 carriers   11.2%   9.8x
#     2                       2,075            16.1%  14.1x
#     >=3                     1,952            25.6%  22.4x
#     >=5                       781            31.0%  27.1x
#
# "Shut down" MUST mean revoked AND still unauthorized, not merely "has a
# revocation on record". The latter includes SWIFT, UPS, LANDSTAR, CRETE and
# PENSKE — large carriers with a decades-old docket action since reinstated —
# which between them link to ~3,000 carriers and would have made this signal a
# false-positive generator. With the stricter definition the top hubs are
# instead the likes of SUPLICIUM TRANSPORT (1 reported power unit, 333 VIN-
# sharing partners) — shells, which is the point.
log("Step A5: VIN-sharing partners that FMCSA has already shut down...")
shut = agg.filter(
    pl.col("most_recent_involuntary_date").is_not_null()
    & (pl.col("has_active_authority") == False)  # noqa: E712 — null must not match
).select(
    pl.col("DOT_NUMBER").alias("dot_b"),
    pl.col("LEGAL_NAME").alias("shutdown_sibling_name"),
    pl.col("most_recent_involuntary_date").alias("shutdown_sibling_revoked_date"),
)
log(f"  shut-down carriers (revoked AND still unauthorized): {shut.height:,}")

shut_links = joined.select("dot_a", "dot_b").unique().join(shut, on="dot_b", how="inner")
shutdown_sib = (
    shut_links.group_by("dot_a")
    .agg(
        pl.len().alias("shutdown_sibling_count"),
        # Surface the most RECENTLY shut-down partner: it is the one a broker can
        # still recognise, and the closest in time to whatever is happening now.
        pl.col("dot_b").sort_by("shutdown_sibling_revoked_date", descending=True).first().alias("shutdown_sibling_dot"),
        pl.col("shutdown_sibling_name").sort_by("shutdown_sibling_revoked_date", descending=True).first(),
        pl.col("shutdown_sibling_revoked_date").max().alias("shutdown_sibling_revoked_date"),
    )
    .rename({"dot_a": "DOT_NUMBER"})
)
log(f"  carriers with >=1 shut-down VIN partner: {shutdown_sib.height:,}")
for k in (1, 2, 3, 5, 10):
    log(f"    >={k}: {shutdown_sib.filter(pl.col('shutdown_sibling_count') >= k).height:,}")

# === INSURANCE REPLACE COUNT + DISTINCT POLICIES ===
log("\nStep B1: parse InsHist (header-less)...")
cols = [f"c{i:02d}" for i in range(1, 18)]
hist = (
    pl.scan_csv(INSHIST, has_header=False, new_columns=cols,
                schema_overrides={c: pl.Utf8 for c in cols},
                ignore_errors=True)
    .with_columns(
        DOT_NUMBER=pl.col("c02").cast(pl.Int64, strict=False),
        event_type=pl.col("c04"),
        coverage=pl.col("c07"),
        policy_no=pl.col("c08"),
        cancel_date=pl.col("c14").str.strptime(pl.Date, format="%m/%d/%Y", strict=False),
    )
    .filter(pl.col("DOT_NUMBER").is_not_null() & (pl.col("DOT_NUMBER") > 0))
    .filter(pl.col("coverage").str.contains("BIPD", literal=False).fill_null(False))
    .collect(engine="streaming")
)
log(f"  BIPD events: {hist.height:,}")

cutoff = pl.lit(SNAPSHOT_DATE).str.strptime(pl.Date, format="%Y-%m-%d").dt.offset_by("-24mo")
recent = hist.filter(pl.col("cancel_date") >= cutoff)

ins_agg = (
    recent.group_by("DOT_NUMBER").agg(
        insurance_replaces_24mo=(pl.col("event_type") == "Replaced").sum().cast(pl.Int64),
        insurance_distinct_policies_24mo=pl.col("policy_no").n_unique().cast(pl.Int64),
    )
)
log(f"  per-DOT BIPD agg: {ins_agg.height:,}")
log(f"  sample: {ins_agg.sort('insurance_distinct_policies_24mo', descending=True).head(5)}")

# === MERGE ===
log("\nStep C: merge into parquet...")
# Drop existing columns if present
for col in [
    "diffuse_vin_share_pct", "diffuse_vin_share_n_siblings",
    "insurance_replaces_24mo", "insurance_distinct_policies_24mo",
    "shutdown_sibling_count", "shutdown_sibling_dot",
    "shutdown_sibling_name", "shutdown_sibling_revoked_date",
]:
    if col in agg.columns:
        agg = agg.drop(col)

out = (
    agg
    .join(diffuse, on="DOT_NUMBER", how="left")
    .join(shutdown_sib, on="DOT_NUMBER", how="left")
    .join(ins_agg, on="DOT_NUMBER", how="left")
    .with_columns(
        diffuse_vin_share_pct=pl.col("diffuse_vin_share_pct").fill_null(0.0),
        diffuse_vin_share_n_siblings=pl.col("diffuse_vin_share_n_siblings").fill_null(0),
        insurance_replaces_24mo=pl.col("insurance_replaces_24mo").fill_null(0),
        insurance_distinct_policies_24mo=pl.col("insurance_distinct_policies_24mo").fill_null(0),
        # 0 means "no shut-down partner", which is a real answer, not missing data.
        shutdown_sibling_count=pl.col("shutdown_sibling_count").fill_null(0),
    )
)
log(f"Final: {out.shape}")
out.write_parquet(PARQUET, compression="zstd")
log(f"Wrote {PARQUET}")

# Validation: dump network DOT values for the new columns
log("\n=== Validation: Alake network values ===")
network = [4198159, 4469680, 3412088, 2893370, 1841344, 3398193, 3913686, 3432788, 1691395,
           3374454, 4014085, 4141034]
val = (
    out.filter(pl.col("DOT_NUMBER").is_in(network))
    .select("DOT_NUMBER", "LEGAL_NAME",
            "diffuse_vin_share_pct", "diffuse_vin_share_n_siblings",
            "largest_sibling_overlap_pct", "largest_sibling_shared_vins", "largest_sibling_total_vins",
            "insurance_cancellations_24mo", "insurance_replaces_24mo", "insurance_distinct_policies_24mo",
            "bipd_insurance_on_file")
)
print(val)
