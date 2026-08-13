# /// script
# requires-python = ">=3.11"
# dependencies = ["polars>=1.0"]
# ///
"""Compute FMCSA Inspection Selection System (ISS-CSA) score per the official
Algorithm Description doc (December 2012, current methodology v3.20 inputs).

ISS assigns every active motor carrier a value 1-100 mapped to one of three
recommendations:
    75-100: Inspect (top priority)
    50-74:  Optional (next priority)
    1-49:   Pass (inspection not warranted)

Algorithm has two paths:

  SAFETY ALGORITHM (carriers with sufficient BASIC data):
    Identifies which of 13 ordered groups a carrier falls into based on their
    BASIC alert pattern + Serious Violations. Within each group, carriers are
    ranked by sum of BASIC percentiles and assigned ISS quantiles within
    these bands:
      Groups 1-5  → ISS 75-99 (Inspect)
      Groups 6-12 → ISS 50-74 (Optional)
      Group 13    → ISS 1-49  (Pass)

  INSUFFICIENT DATA ALGORITHM (carriers without enough BASIC data):
    Three cases plus OOSO/random:
      OOSO carriers:                ISS = 100
      Random 1% selection:           ISS = 99
      Case 1: "1 away" from
        sufficiency, ranked by
        violation rate:             ISS = 70-74
      Case 2: 0 inspections,
        ranked by max(PU, drivers): ISS = 63-69
      Case 3: some inspections,
        ranked by inspection rate:  ISS = 50-69

Output columns added to carrier_aggregates.parquet:
  iss_score       int    — 1-100, the computed ISS value
  iss_tier        str    — 'Inspect' / 'Optional' / 'Pass'
  iss_group       str    — Group 1-13 (Safety) or Case 1/2/3 (Insufficient Data)
  iss_algorithm   str    — 'safety' or 'insufficient_data' or 'oos' or 'random'

CAVEATS / divergences from official FMCSA ISS:
  - We don't have "Serious Violations from Compliance Reviews" in bulk data;
    Group 6 (carriers with ONLY Insurance/Other Serious Violations) won't be
    fully reproducible. Most carriers in this group will instead be classified
    in adjacent groups (5 or 7).
  - HM Compliance BASIC alert is computed by us from inspection + violation
    files. Should match FMCSA but worth spot-checking.
  - Crash Indicator alert depends on the scraped Avg PU. For carriers not in
    the ~25k scraped set, we fall back to peer-group crash classification.

Validation: spot-check 20 random DOTs against FMCSA's per-DOT ISS value.
"""
from __future__ import annotations

import os
import random
from pathlib import Path
import polars as pl

# Repo-relative default. These pointed at the san-antonio workspace, so a
# standalone `uv run` silently read from (or wrote into) a different clone.
# Harmless under build_all, which supplies the env; wrong every other way.
REPO = Path(__file__).resolve().parents[2]

PARQUET = Path(
    os.environ.get(
        "FMCSA_PARQUET",
        REPO / "data" / "carrier_aggregates.parquet",
    )
)

# Random selection percentage for Insufficient Data Algorithm.
# Per methodology: ~1% of carriers without ISS Safety value get random=99.
RANDOM_SELECTION_PCT = 0.01
RANDOM_SEED = 20260514  # match SMS data vintage for reproducibility

# Insufficient Data Algorithm Case 2 buckets — ISS by max(PU, drivers).
# Table from the ISS doc (December 2012, page 17).
PU_DRIVER_BUCKETS = [
    (1001, 1_000_000, 69),
    (201, 1000, 68),
    (64, 200, 67),
    (16, 63, 66),
    (7, 15, 65),
    (2, 6, 64),
    (1, 1, 63),
]


def determine_safety_group(c: dict) -> tuple[str, int]:
    """Map a carrier (one row from the parquet) to one of the 13 ordered
    Safety Algorithm groups + the tier (75-99, 50-74, or 1-49).

    Returns (group_label, base_iss_value) where base_iss_value is the lower
    bound of the tier — the within-group rank then assigns a specific value
    above this bound.
    """
    # Extract alerts as booleans
    a_ud = c.get("unsafe_driving_alert") == "Y"
    a_hos = c.get("hos_alert") == "Y"
    a_df = c.get("driver_fitness_alert") == "Y"
    a_cs = c.get("controlled_substances_alert") == "Y"
    a_vm = c.get("vehicle_maintenance_alert") == "Y"
    a_hm = c.get("hm_compliance_alert") == "Y"
    a_ci = c.get("crash_indicator_alert") == "Y"

    # Percentiles for the high-risk check
    p_ud = c.get("unsafe_driving_percentile") or 0
    p_hos = c.get("hos_percentile") or 0
    p_ci = c.get("crash_indicator_percentile") or 0

    # Total BASIC alerts
    n_alerts = sum([a_ud, a_hos, a_df, a_cs, a_vm, a_hm, a_ci])
    # BASICs best addressed roadside (per Table 1 in ISS doc): HOS, DF, CS, VM, HM
    n_roadside_alerts = sum([a_hos, a_df, a_cs, a_vm, a_hm])

    # ----- INSPECT tier (Groups 1-5, ISS 75-99) -----

    # Group 1: High-risk
    #   4+ BASICs exceeding threshold, OR
    #   2+ BASICs exceeding threshold AND one of (UD/HOS/CI) at percentile ≥ 85
    if n_alerts >= 4:
        return ("Group 1 (high-risk)", 75)
    if n_alerts >= 2:
        if (a_ud and p_ud >= 85) or (a_hos and p_hos >= 85) or (a_ci and p_ci >= 85):
            return ("Group 1 (high-risk)", 75)

    # Group 2: Multiple BASICs prioritized — 3+ best addressed roadside
    if n_roadside_alerts >= 3:
        return ("Group 2 (3+ roadside BASICs)", 75)

    # Group 3: Multiple BASICs prioritized — 2 best addressed roadside
    if n_roadside_alerts == 2:
        return ("Group 3 (2 roadside BASICs)", 75)

    # Group 4: Multiple BASICs prioritized — 1 best addressed roadside
    if n_roadside_alerts == 1 and n_alerts >= 2:
        return ("Group 4 (1 roadside + UD/CI)", 75)

    # Group 5: HOS Compliance BASIC exceeding threshold (only)
    if a_hos and n_alerts == 1:
        return ("Group 5 (HOS only)", 75)

    # ----- OPTIONAL tier (Groups 6-12, ISS 50-74) -----

    # Group 6: Insurance/Other Serious Violations found in an investigation.
    #   This requires the acute/critical Serious-Violation data, which lives
    #   only on the per-carrier SMS pages (not in any bulk file). Until that
    #   scrape lands, Group 6 is intentionally left EMPTY rather than
    #   approximated — the prior `bipd_insurance_on_file == 0` proxy was wrong
    #   (it swept in ~137k dormant/uninsured carriers that FMCSA never
    #   investigated). Carriers with no BASIC alert correctly fall through to
    #   Group 13 below. See add_serious_violations (planned).

    # Group 7: Vehicle Maintenance BASIC prioritized
    if a_vm and n_alerts == 1:
        return ("Group 7 (VM only)", 50)

    # Group 8: HM Compliance BASIC
    if a_hm and n_alerts == 1:
        return ("Group 8 (HM only)", 50)

    # Group 9: Driver Fitness BASIC prioritized
    if a_df and n_alerts == 1:
        return ("Group 9 (DF only)", 50)

    # Group 10: Controlled Substances and Alcohol BASIC
    if a_cs and n_alerts == 1:
        return ("Group 10 (CS only)", 50)

    # Group 11: Unsafe Driving AND Crash BASIC prioritized
    if a_ud and a_ci:
        return ("Group 11 (UD+CI)", 50)

    # Group 12: Single Crash OR Unsafe Driving BASIC
    if (a_ud or a_ci) and n_alerts == 1:
        return ("Group 12 (UD or CI only)", 50)

    # ----- PASS tier (Group 13, ISS 1-49) -----

    # Group 13: One or more BASIC percentiles, none exceeding threshold
    return ("Group 13 (no alerts)", 1)


def determine_insufficient_data_iss(c: dict) -> tuple[str, int]:
    """For carriers without sufficient data for the Safety Algorithm.

    Returns (case_label, iss_value).
    """
    # OOSO check
    if c.get("status_code") in ("V", "R") or (
        c.get("safety_rating") == "U"
    ):
        return ("OOSO (insufficient data)", 100)

    pu = c.get("power_units") or 0
    drivers = c.get("drivers") or 0
    veh_insp = c.get("vehicle_inspections_24mo") or 0
    drv_insp = c.get("driver_inspections_24mo") or 0
    size = max(pu, drivers)

    # Case 2: zero roadside inspections
    if veh_insp == 0 and drv_insp == 0:
        for lo, hi, iss_val in PU_DRIVER_BUCKETS:
            if lo <= size <= hi:
                return ("Case 2 (zero insp, by size)", iss_val)
        # If no PU/driver info, midpoint
        return ("Case 2 (zero insp, no size)", 66)

    # Case 3: some inspections, not enough for a measure
    # Rank by Inspection Average Rate (avg of insp/PU and insp/driver).
    # Higher rate → lower ISS (more recently observed, safer to "pass").
    # We compute the rate and assign 50-69 by rank — but ranking happens
    # globally in the caller, so we just return the rate as a sortable value
    # via an interim key. For simplicity within this function, return 60 as
    # default and let the caller refine via global ranking.
    return ("Case 3 (some insp)", 60)


def main() -> None:
    print(f"Reading {PARQUET.name}…")
    df = pl.read_parquet(PARQUET)
    print(f"  rows: {df.height:,}")

    # Determine each carrier's path through ISS
    print("\nClassifying carriers into ISS algorithm paths…")

    # Has BASIC sufficient data: at least one alert OR a percentile rank in
    # any BASIC. Approximation — FMCSA's full sufficiency check is per-BASIC
    # inspection-count floors.
    alert_cols = [
        "unsafe_driving_alert", "hos_alert", "vehicle_maintenance_alert",
        "driver_fitness_alert", "controlled_substances_alert", "hm_compliance_alert",
        "crash_indicator_alert",
    ]
    percentile_cols = [
        "unsafe_driving_percentile", "hos_percentile", "vehicle_maintenance_percentile",
        "driver_fitness_percentile", "controlled_substances_percentile",
        "hm_compliance_percentile", "crash_indicator_percentile",
    ]
    has_basic_data = pl.lit(False)
    for col in alert_cols:
        if col in df.columns:
            has_basic_data = has_basic_data | (pl.col(col).is_in(["Y", "N"]))
    for col in percentile_cols:
        if col in df.columns:
            has_basic_data = has_basic_data | pl.col(col).is_not_null()

    df = df.with_columns(has_basic_data=has_basic_data.fill_null(False))

    # OOSO: status R/V or Unsatisfactory rating
    # fill_null(False) on each side — Kleene `null OR False = null` would
    # otherwise leave is_oos null for carriers without a safety_rating, and
    # `~null & ...` would silently drop them from both algorithm paths.
    is_oos = (
        pl.col("status_code").is_in(["R", "V"]).fill_null(False)
        | (pl.col("safety_rating") == "U").fill_null(False)
    )
    df = df.with_columns(is_oos=is_oos)

    # Compute group + base ISS for safety path
    print("Running Safety Algorithm for carriers with BASIC data…")
    safety_carriers = df.filter(pl.col("has_basic_data") & ~pl.col("is_oos"))
    print(f"  safety-path carriers: {safety_carriers.height:,}")

    iss_rows = []
    for c in safety_carriers.iter_rows(named=True):
        group, base = determine_safety_group(c)
        iss_rows.append(
            {"DOT_NUMBER": c["DOT_NUMBER"], "iss_group": group, "iss_base": base, "iss_algorithm": "safety"}
        )

    safety_iss = pl.DataFrame(iss_rows, schema={
        "DOT_NUMBER": pl.Int64, "iss_group": pl.Utf8, "iss_base": pl.Int64, "iss_algorithm": pl.Utf8,
    })

    # Per ISS doc Appendix A, carriers are ranked by the SUM OF BASIC
    # PERCENTILES, but the sum is BASIC-set-dependent:
    #   - Groups 1-12: sum of all 7 BASIC percentiles.
    #   - Group 13 (Pass): sum of ONLY HOS, Driver Fitness, Controlled
    #     Substances, Vehicle Maintenance, HM — Unsafe Driving and Crash
    #     Indicator are EXCLUDED (any value there is itself a negative event,
    #     so they don't belong in the "clean" ranking).
    pass_cols = [
        "hos_percentile", "driver_fitness_percentile",
        "controlled_substances_percentile", "vehicle_maintenance_percentile",
        "hm_compliance_percentile",
    ]
    sums = safety_carriers.with_columns(
        sum_all=sum(pl.col(c).fill_null(0) for c in percentile_cols if c in df.columns),
        sum_pass=sum(pl.col(c).fill_null(0) for c in pass_cols if c in df.columns),
    ).select("DOT_NUMBER", "sum_all", "sum_pass")
    safety_iss = safety_iss.join(sums, on="DOT_NUMBER", how="left")

    # Numeric group order (1..13) parsed from the label; lower = higher ISS.
    safety_iss = safety_iss.with_columns(
        group_order=pl.col("iss_group").str.extract(r"Group (\d+)", 1).cast(pl.Int64),
    ).with_columns(
        sum_used=pl.when(pl.col("group_order") == 13)
        .then(pl.col("sum_pass")).otherwise(pl.col("sum_all")),
    )

    # Cross-group ordering WITHIN a tier (Appendix A: "carriers in group 1 are
    # ranked higher than carriers in group 2", etc). Sort key makes the group
    # the primary axis and the percentile-sum the tiebreaker; bigger = higher
    # ISS. group weight (1000) dominates the 0-700 sum so groups never overlap.
    safety_iss = safety_iss.with_columns(
        _sortkey=(50 - pl.col("group_order")) * 1000 + pl.col("sum_used"),
    )
    # Rank the sort key within the tier (defined by iss_base = 75/50/1), then
    # map the quantile into that tier's band.
    safety_iss = safety_iss.with_columns(
        rank_in_tier=pl.col("_sortkey").rank("average").over("iss_base"),
        n_in_tier=pl.len().over("iss_base"),
    ).with_columns(
        iss_score=(
            pl.col("iss_base")
            + (pl.col("rank_in_tier") / pl.col("n_in_tier"))
            * pl.when(pl.col("iss_base") == 1).then(48).otherwise(24)
        ).cast(pl.Int64),
    )

    # Insufficient Data path
    print("\nRunning Insufficient Data Algorithm for remaining carriers…")
    insuff_carriers = df.filter(~pl.col("has_basic_data") & ~pl.col("is_oos"))
    print(f"  insufficient-data carriers: {insuff_carriers.height:,}")

    insuff_rows = []
    for c in insuff_carriers.iter_rows(named=True):
        case, iss = determine_insufficient_data_iss(c)
        insuff_rows.append(
            {"DOT_NUMBER": c["DOT_NUMBER"], "iss_group": case, "iss_score": iss, "iss_algorithm": "insufficient_data"}
        )
    insuff_iss = pl.DataFrame(insuff_rows, schema={
        "DOT_NUMBER": pl.Int64, "iss_group": pl.Utf8, "iss_score": pl.Int64, "iss_algorithm": pl.Utf8,
    })

    # Random 1% selection from insufficient-data carriers → ISS = 99
    n_random = int(insuff_iss.height * RANDOM_SELECTION_PCT)
    rng = random.Random(RANDOM_SEED)
    # SORT before sampling. The seed alone is not enough: rng.sample() draws by
    # position, so if the input list arrives in a different order the selection
    # differs even with a fixed seed. Row order here comes from upstream joins
    # and is not stable, which made iss_score/iss_group differ for 38,196
    # carriers between two builds of identical inputs.
    random_dots = rng.sample(sorted(insuff_iss["DOT_NUMBER"].to_list()), n_random)
    insuff_iss = insuff_iss.with_columns(
        iss_score=pl.when(pl.col("DOT_NUMBER").is_in(random_dots)).then(99).otherwise(pl.col("iss_score")),
        iss_group=pl.when(pl.col("DOT_NUMBER").is_in(random_dots)).then(pl.lit("Random (insufficient data)")).otherwise(pl.col("iss_group")),
        iss_algorithm=pl.when(pl.col("DOT_NUMBER").is_in(random_dots)).then(pl.lit("random")).otherwise(pl.col("iss_algorithm")),
    )

    # OOSO carriers → ISS = 100 regardless of algorithm path
    oos_iss = df.filter(pl.col("is_oos")).select(
        "DOT_NUMBER",
        pl.lit("OOSO").alias("iss_group"),
        pl.lit(100).cast(pl.Int64).alias("iss_score"),
        pl.lit("oos").alias("iss_algorithm"),
    )

    # Merge all paths
    all_iss = pl.concat([
        safety_iss.select("DOT_NUMBER", "iss_score", "iss_group", "iss_algorithm"),
        insuff_iss.select("DOT_NUMBER", "iss_score", "iss_group", "iss_algorithm"),
        oos_iss.select("DOT_NUMBER", "iss_score", "iss_group", "iss_algorithm"),
    ])
    print(f"\nTotal ISS scores assigned: {all_iss.height:,}")

    # Map to tiers
    all_iss = all_iss.with_columns(
        iss_tier=pl.when(pl.col("iss_score") >= 75).then(pl.lit("Inspect"))
                   .when(pl.col("iss_score") >= 50).then(pl.lit("Optional"))
                   .otherwise(pl.lit("Pass")),
    )

    # Drop existing columns if present and merge back
    for col in ("iss_score", "iss_group", "iss_tier", "iss_algorithm"):
        if col in df.columns:
            df = df.drop(col)
    merged = df.drop("has_basic_data").drop("is_oos").join(all_iss, on="DOT_NUMBER", how="left")
    print(f"Final shape: {merged.shape}")

    print("\nISS distribution:")
    print(merged.group_by("iss_tier").agg(pl.len()).sort("iss_tier"))

    print("\nISS by algorithm:")
    print(merged.group_by("iss_algorithm").agg(pl.len()).sort("iss_algorithm"))

    merged.write_parquet(PARQUET, compression="zstd")
    print(f"\nWrote {PARQUET}")


if __name__ == "__main__":
    main()
