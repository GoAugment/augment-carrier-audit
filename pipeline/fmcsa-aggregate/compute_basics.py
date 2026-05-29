# /// script
# requires-python = ">=3.11"
# dependencies = ["polars>=1.0"]
# ///
"""Compute all 7 FMCSA BASIC measures, percentiles, and alerts in one pass.

The 7 BASICs:
  1. Unsafe Driving        — measure from bulk SMS file; we compute percentile
  2. HOS Compliance        — measure from bulk; we compute percentile
  3. Driver Fitness        — measure from bulk; we compute percentile
  4. Controlled Substances — measure from bulk; we compute percentile
  5. Vehicle Maintenance   — measure from bulk; we compute percentile
  6. HM Compliance         — we compute measure (from violation file) AND
                             percentile. FMCSA hides this BASIC publicly.
  7. Crash Indicator       — we compute measure (from crash file + scraped
                             Avg PU) AND percentile. Also hidden publicly.

Every BASIC follows the same algorithm:
  1. Determine measure (numerator / denominator per methodology v3.20)
  2. Bucket carrier into a Safety Event Group based on inspection / crash count
  3. Rank measure ascending within group → percentile
  4. Apply intervention threshold (varies by BASIC × carrier type) → alert

For BASICs 1-5 we already have FMCSA's measure in `<basic>_measure`; only
the percentile-rank step is new. For 6 we compute both. For 7 we compute
the measure when scraped Avg PU is available, otherwise leave null.

Output columns added to carrier_aggregates.parquet:
  unsafe_driving_percentile, unsafe_driving_seg_group
  hos_percentile, hos_seg_group
  driver_fitness_percentile, driver_fitness_seg_group
  controlled_substances_percentile, controlled_substances_seg_group
  vehicle_maintenance_percentile, vehicle_maintenance_seg_group
  hm_compliance_measure, hm_compliance_percentile, hm_compliance_alert,
    hm_compliance_seg_group
  crash_indicator_measure, crash_indicator_percentile, crash_indicator_alert,
    crash_indicator_seg_group, crash_indicator_avg_pu, crash_indicator_uf

Run after the bulk-file ingest (build_aggregates.py + add_*.py). Run again
after scrape_fmcsa_basics.py finishes to populate Crash Indicator.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta
from pathlib import Path
import polars as pl

PARQUET = Path(
    "/Users/art/conductor/workspaces/augment-carrier-audit-v1/san-antonio/"
    "data/carrier_aggregates.parquet"
)
INSP_CSV = Path("/Users/art/Downloads/SMS_Input_-_Inspection_20260518.csv")
VIOL_CSV = Path("/Users/art/Downloads/SMS_Input_-_Violation_20260518.csv")
CRASH_CSV = Path("/Users/art/Downloads/SMS_Input_-_Crash_20260518.csv")
SCRAPE_DIR = Path(
    "/Users/art/conductor/workspaces/augment-carrier-audit-v1/san-antonio/"
    "data/fmcsa_scrape"
)

SNAPSHOT = datetime(2026, 5, 18)
CUTOFF_24MO = SNAPSHOT - timedelta(days=730)
CUTOFF_12MO = SNAPSHOT - timedelta(days=365)


# ---------------------------------------------------------------------------
# Safety Event Group bucket boundaries per BASIC, per SMS Methodology v3.20.
# Each list: (lo, hi, label) for that BASIC's grouping count.
# ---------------------------------------------------------------------------

# Safety Event Groups are built on the number of RELEVANT INSPECTIONS (exposure),
# per SMS Methodology v3.20 / Sept-2025 §3 (Tables 3-12, 3-14, 3-20). NOT
# violation counts. HOS lower bound is 3 relevant driver inspections; Vehicle
# Maintenance / Driver Fitness / HM start at 5.
HOS_BUCKETS = [
    (3, 10, "Group 1"),
    (11, 20, "Group 2"),
    (21, 100, "Group 3"),
    (101, 500, "Group 4"),
    (501, 1_000_000, "Group 5"),
]

# Vehicle Maintenance + Driver Fitness (Tables 3-14, 3-20): relevant inspections.
VM_DF_BUCKETS = [
    (5, 10, "Group 1"),
    (11, 20, "Group 2"),
    (21, 100, "Group 3"),
    (101, 500, "Group 4"),
    (501, 1_000_000, "Group 5"),
]

HM_BUCKETS = [
    (5, 10, "Group 1"),
    (11, 15, "Group 2"),
    (16, 40, "Group 3"),
    (41, 100, "Group 4"),
    (101, 1_000_000, "Group 5"),
]

CONTROLLED_SUB_BUCKETS = [
    (1, 1, "Group 1"),
    (2, 2, "Group 2"),
    (3, 3, "Group 3"),
    (4, 1_000_000, "Group 4"),
]

UNSAFE_DRIVING_COMBO_BUCKETS = [
    (3, 8, "Combination 1"),
    (9, 21, "Combination 2"),
    (22, 57, "Combination 3"),
    (58, 149, "Combination 4"),
    (150, 1_000_000, "Combination 5"),
]

# Corrected per Table 3-4 (Sept-2025 methodology). Keyed on # inspections with
# an Unsafe Driving violation, within the Straight segment.
UNSAFE_DRIVING_STRAIGHT_BUCKETS = [
    (3, 4, "Straight 1"),
    (5, 8, "Straight 2"),
    (9, 18, "Straight 3"),
    (19, 49, "Straight 4"),
    (50, 1_000_000, "Straight 5"),
]

CRASH_COMBO_BUCKETS = [
    (2, 3, "Combination 1"),
    (4, 6, "Combination 2"),
    (7, 16, "Combination 3"),
    (17, 45, "Combination 4"),
    (46, 1_000_000, "Combination 5"),
]

CRASH_STRAIGHT_BUCKETS = [
    (2, 2, "Straight 1"),
    (3, 4, "Straight 2"),
    (5, 8, "Straight 3"),
    (9, 26, "Straight 4"),
    (27, 1_000_000, "Straight 5"),
]


# Intervention thresholds per BASIC × carrier type. Tables 3-5/11/13/15/17/19.
INTERVENTION = {
    "unsafe_driving":         {"passenger": 50, "hm": 60, "general": 65},
    "hos":                    {"passenger": 50, "hm": 60, "general": 65},
    "vehicle_maintenance":    {"passenger": 65, "hm": 75, "general": 80},
    "driver_fitness":         {"passenger": 65, "hm": 75, "general": 80},
    "controlled_substances":  {"passenger": 65, "hm": 75, "general": 80},
    "hm_compliance":          {"passenger": 80, "hm": 80, "general": 80},
    "crash_indicator":        {"passenger": 50, "hm": 60, "general": 65},
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def assign_bucket(count_col: pl.Expr, buckets: list[tuple[int, int, str]]) -> pl.Expr:
    expr = pl.when(pl.lit(False)).then(pl.lit("Below Sufficiency"))
    for lo, hi, label in buckets:
        expr = expr.when((count_col >= lo) & (count_col <= hi)).then(pl.lit(label))
    return expr.otherwise(pl.lit("Below Sufficiency"))


def rank_percentile_in_group(measure_col: str, group_col: str, eligible_col: str) -> pl.Expr:
    """Ascending rank → percentile (0-100, higher = worse), computed ONLY among
    ELIGIBLE carriers within each Safety Event Group.

    Per SMS methodology, carriers that don't meet data sufficiency are not part
    of the ranking population at all. Partitioning rank() and len() by
    [group, eligible] makes both span just the eligible members of the group —
    fixing the prior bug where the denominator counted every carrier in the
    group (including zero-violation / insufficient carriers), which
    systematically understated percentiles.
    """
    return (
        pl.when(pl.col(eligible_col))
        .then(
            pl.col(measure_col).rank("average").over([group_col, eligible_col])
            / pl.len().over([group_col, eligible_col])
            * 100
        )
        .otherwise(None)
    )


def assign_alert(percentile_col: str, basic_key: str) -> pl.Expr:
    """General-carrier threshold. Passenger/HM refinements deferred — apply
    via separate post-step when we add PC_FLAG / HM_FLAG to the parquet."""
    threshold = INTERVENTION[basic_key]["general"]
    return (
        pl.when(pl.col(percentile_col).is_null()).then(None)
        .when(pl.col(percentile_col) >= threshold).then(pl.lit("Y"))
        .otherwise(pl.lit("N"))
    )


# ---------------------------------------------------------------------------
# Event counts + segment from the inspection file
#   - <basic>_insp_viol: # inspections with >=1 violation in that BASIC (drives
#     Unsafe Driving grouping + the "had a violation" sufficiency gate).
#   - segment: 'Combo' when combination power units (truck tractors / motor
#     coaches) are >=70% of the carrier's PU inspections, else 'Straight'
#     (SMS methodology segmentation for Unsafe Driving + Crash Indicator).
# Relevant-inspection COUNTS for grouping reuse existing columns
# (driver_inspections_24mo for HOS/DF, vehicle_inspections_24mo for VM) — these
# equal the per-BASIC {flag}_Insp sums (verified: Werner Fatigued_Insp=10,800).
# ---------------------------------------------------------------------------

# BASIC key -> violation-count column in the inspection file.
INSP_VIOL_COL = {
    "unsafe_driving": "Unsafe_Viol",
    "hos": "Fatigued_Viol",
    "driver_fitness": "Dr_Fitness_Viol",
    "controlled_substances": "Subt_Alcohol_Viol",
    "vehicle_maintenance": "Vh_Maint_Viol",
}
COMBO_UNIT_TYPES = ["TRUCK TRACTOR", "MOTOR COACH"]
PU_UNIT_TYPES = ["TRUCK TRACTOR", "STRAIGHT TRUCK", "MOTOR COACH", "BUS", "SCHOOL BUS"]


def compute_event_counts(df: pl.DataFrame) -> pl.DataFrame:
    drop = [f"{b}_insp_viol" for b in INSP_VIOL_COL] + ["seg_segment"]
    df = df.drop([c for c in drop if c in df.columns])

    print("  Event counts: reading inspection file (per-BASIC inspections-with-"
          "violation + segment)…")
    raw = (
        pl.scan_csv(INSP_CSV, ignore_errors=True, schema_overrides={"DOT_Number": pl.Int64})
        .rename({"DOT_Number": "DOT_NUMBER"})
        .with_columns(d=pl.col("Insp_Date").str.strptime(pl.Date, format="%d-%b-%y", strict=False))
        .filter(pl.col("d") >= pl.lit(CUTOFF_24MO.date()))
        .filter(pl.col("d") <= pl.lit(SNAPSHOT.date()))
        .select(
            "DOT_NUMBER",
            *INSP_VIOL_COL.values(),
            "Unit_Type_Desc", "Unit_Type_Desc2",
        )
        .collect(engine="streaming")
    )

    # Inspections with >=1 violation in each BASIC.
    counts = raw.group_by("DOT_NUMBER").agg(
        [
            (pl.col(vc).cast(pl.Int64, strict=False).fill_null(0) > 0)
            .sum().cast(pl.Int64).alias(f"{b}_insp_viol")
            for b, vc in INSP_VIOL_COL.items()
        ]
    )

    # Segment: combination-PU share across both unit slots.
    seg = (
        raw.select(
            "DOT_NUMBER",
            pl.concat_list(["Unit_Type_Desc", "Unit_Type_Desc2"]).alias("uts"),
        )
        .explode("uts")
        .filter(pl.col("uts").is_in(PU_UNIT_TYPES))
        .group_by("DOT_NUMBER")
        .agg(
            combo=pl.col("uts").is_in(COMBO_UNIT_TYPES).sum(),
            total_pu=pl.len(),
        )
        .with_columns(
            seg_segment=pl.when(pl.col("combo") / pl.col("total_pu") >= 0.70)
            .then(pl.lit("Combo"))
            .otherwise(pl.lit("Straight"))
        )
        .select("DOT_NUMBER", "seg_segment")
    )

    df = df.join(counts, on="DOT_NUMBER", how="left").join(seg, on="DOT_NUMBER", how="left")
    df = df.with_columns(
        [pl.col(f"{b}_insp_viol").fill_null(0) for b in INSP_VIOL_COL]
    )
    print(f"    carriers with any BASIC inspection-with-violation: "
          f"{df.filter(pl.col('unsafe_driving_insp_viol') > 0).height:,} (UD)")
    return df


# ---------------------------------------------------------------------------
# HM Compliance — compute measure from violation file
# ---------------------------------------------------------------------------

def compute_hm_compliance_measure(df: pl.DataFrame) -> pl.DataFrame:
    """Add hm_compliance_measure + relevant_inspections + sufficiency flags."""
    # Idempotent re-run support — drop columns we'll re-add
    drop_first = [
        "hm_relevant_inspections", "hm_time_weighted_insp", "hm_most_recent_relevant",
        "hm_violations", "hm_severity_weighted_viol", "hm_most_recent_violation",
        "hm_had_12mo_viol", "hm_had_latest_viol", "hm_sufficient",
        "hm_compliance_measure", "hm_compliance_percentile", "hm_compliance_alert",
        "hm_compliance_seg_group",
    ]
    df = df.drop([c for c in drop_first if c in df.columns])

    print("  HM: reading inspection file (relevant inspections)…")
    insp = (
        pl.scan_csv(INSP_CSV, ignore_errors=True, schema_overrides={"DOT_Number": pl.Int64})
        .rename({"DOT_Number": "DOT_NUMBER"})
        .with_columns(insp_date=pl.col("Insp_Date").str.strptime(
            pl.Date, format="%d-%b-%y", strict=False
        ))
        .filter(pl.col("insp_date") >= pl.lit(CUTOFF_24MO.date()))
        .filter(pl.col("insp_date") <= pl.lit(SNAPSHOT.date()))
        # Note: Hazmat_Placard_req is bool, not "Y"/"N" string
        .filter(pl.col("Hazmat_Placard_req").fill_null(False))
        .filter(pl.col("Insp_level_ID").is_in([1, 2, 5, 6]))
        .collect(engine="streaming")
    )
    insp_per_dot = insp.group_by("DOT_NUMBER").agg(
        hm_relevant_inspections=pl.len().cast(pl.Int64),
        hm_time_weighted_insp=pl.col("Time_Weight").cast(pl.Float64).sum(),
        hm_most_recent_relevant=pl.col("insp_date").max(),
    )
    print(f"    HM-placardable inspections in 24mo: {insp.height:,}")
    print(f"    DOTs with HM inspections: {insp_per_dot.height:,}")

    print("  HM: reading violation file (HM Compliance violations)…")
    viol = (
        pl.scan_csv(VIOL_CSV, ignore_errors=True, schema_overrides={"DOT_Number": pl.Int64})
        .rename({"DOT_Number": "DOT_NUMBER"})
        .with_columns(viol_date=pl.col("Insp_Date").str.strptime(
            pl.Date, format="%d-%b-%y", strict=False
        ))
        .filter(pl.col("BASIC_Desc") == "Hazardous Materials Compliance")
        .filter(pl.col("viol_date") >= pl.lit(CUTOFF_24MO.date()))
        .filter(pl.col("viol_date") <= pl.lit(SNAPSHOT.date()))
        .collect(engine="streaming")
    )
    viol_per_dot = viol.group_by("DOT_NUMBER").agg(
        hm_violations=pl.len().cast(pl.Int64),
        # Numerator per Eq 3-8: TIME- and severity-weighted violations.
        # Total_Severity_Wght in the bulk file is severity ONLY (crash-risk +
        # OOS bump, capped at 30) — it does NOT include the time weight
        # (verified: SW=10,OOS=2,TW=3 → Total_Severity_Wght=12, not 36). So we
        # must multiply by Time_Weight here, matching how build_aggregates.py
        # computes the validated public-BASIC measures.
        hm_severity_weighted_viol=(
            pl.col("Total_Severity_Wght").cast(pl.Float64)
            * pl.col("Time_Weight").cast(pl.Float64)
        ).sum(),
        hm_most_recent_violation=pl.col("viol_date").max(),
        hm_had_12mo_viol=(pl.col("viol_date") >= pl.lit(CUTOFF_12MO.date())).any(),
    )
    print(f"    HM Compliance violations in 24mo: {viol.height:,}")
    print(f"    DOTs with HM violations: {viol_per_dot.height:,}")

    hm = (
        insp_per_dot.join(viol_per_dot, on="DOT_NUMBER", how="left")
        .with_columns(
            hm_violations=pl.col("hm_violations").fill_null(0),
            hm_severity_weighted_viol=pl.col("hm_severity_weighted_viol").fill_null(0.0),
            hm_had_12mo_viol=pl.col("hm_had_12mo_viol").fill_null(False),
        )
        .with_columns(
            hm_compliance_measure=pl.when(pl.col("hm_time_weighted_insp") > 0)
            .then(pl.col("hm_severity_weighted_viol") / pl.col("hm_time_weighted_insp"))
            .otherwise(0.0),
            hm_had_latest_viol=pl.col("hm_most_recent_violation").is_not_null()
            & (pl.col("hm_most_recent_violation") >= pl.col("hm_most_recent_relevant")),
        )
        .with_columns(
            hm_sufficient=(pl.col("hm_relevant_inspections") >= 5)
            & (pl.col("hm_violations") >= 1)
            & (pl.col("hm_had_12mo_viol") | pl.col("hm_had_latest_viol")),
        )
    )

    return df.join(hm, on="DOT_NUMBER", how="left")


# ---------------------------------------------------------------------------
# Crash Indicator — measure from crash file + scraped Avg PU
# ---------------------------------------------------------------------------

def latest_scrape() -> Path | None:
    files = sorted(SCRAPE_DIR.glob("crash_indicator_*.parquet"))
    return files[-1] if files else None


def compute_crash_indicator_measure(df: pl.DataFrame) -> pl.DataFrame:
    """Add crash_indicator_measure + crashes_24mo_count + avg_pu/uf columns,
    using the scraped Avg PU. Leave null when scrape data missing."""
    # Idempotent re-run support — drop columns we'll re-add
    drop_first = [
        "crash_indicator_measure", "crash_indicator_avg_pu", "crash_indicator_uf",
        "crash_indicator_segment", "crash_count_24mo", "crash_count_12mo",
        "ci_sufficient", "crash_indicator_percentile", "crash_indicator_alert",
        "crash_indicator_seg_group",
    ]
    df = df.drop([c for c in drop_first if c in df.columns])

    scrape_path = latest_scrape()
    if scrape_path is None:
        print("  Crash Indicator: no scrape file found — skipping")
        return df.with_columns(
            crash_indicator_measure=pl.lit(None, dtype=pl.Float64),
            crash_indicator_avg_pu=pl.lit(None, dtype=pl.Float64),
            crash_indicator_uf=pl.lit(None, dtype=pl.Float64),
            crash_indicator_segment=pl.lit(None, dtype=pl.Utf8),
            crash_count_24mo=pl.lit(0, dtype=pl.Int64),
            crash_count_12mo=pl.lit(0, dtype=pl.Int64),
            ci_sufficient=pl.lit(False),
        )

    print(f"  Crash Indicator: using scrape {scrape_path.name}")
    scrape = pl.read_parquet(scrape_path).filter(pl.col("scrape_status") == "ok")
    print(f"    scraped DOTs: {scrape.height:,}")

    print("  Crash Indicator: reading crash file (weighted numerator)…")
    crash = (
        pl.scan_csv(CRASH_CSV, ignore_errors=True, schema_overrides={"DOT_Number": pl.Int64})
        .rename({"DOT_Number": "DOT_NUMBER"})
        .with_columns(crash_date=pl.col("Report_Date").str.strptime(
            pl.Date, format="%d-%b-%y", strict=False
        ))
        .filter(pl.col("crash_date") >= pl.lit(CUTOFF_24MO.date()))
        .filter(pl.col("crash_date") <= pl.lit(SNAPSHOT.date()))
        .filter(~pl.col("Not_Preventable").fill_null(False))
        .with_columns(
            weighted=pl.col("Severity_Weight").cast(pl.Float64)
            * pl.col("Time_Weight").cast(pl.Float64),
            recent_12mo=pl.col("crash_date") >= pl.lit(CUTOFF_12MO.date()),
        )
        .collect(engine="streaming")
    )

    numerator = crash.group_by("DOT_NUMBER").agg(
        crash_weighted_total=pl.col("weighted").sum(),
        crash_count_24mo=pl.len().cast(pl.Int64),
        crash_count_12mo=pl.col("recent_12mo").sum().cast(pl.Int64),
    )

    ci = (
        scrape.rename({"dot_number": "DOT_NUMBER"})
        .select(
            "DOT_NUMBER",
            pl.col("avg_pu").alias("crash_indicator_avg_pu"),
            pl.col("utilization_factor").alias("crash_indicator_uf"),
            pl.col("segment").alias("crash_indicator_segment"),
        )
        .join(numerator, on="DOT_NUMBER", how="inner")
        .with_columns(
            denom=pl.col("crash_indicator_avg_pu") * pl.col("crash_indicator_uf"),
        )
        .with_columns(
            crash_indicator_measure=pl.when(pl.col("denom") > 0)
            .then(pl.col("crash_weighted_total") / pl.col("denom"))
            .otherwise(None),
            ci_sufficient=(pl.col("crash_count_24mo") >= 2)
            & (pl.col("crash_count_12mo") >= 1),
        )
        .drop("denom", "crash_weighted_total")
    )

    print(f"    crash-sufficient carriers with scraped Avg PU: "
          f"{ci.filter(pl.col('ci_sufficient')).height:,}")

    return df.join(ci, on="DOT_NUMBER", how="left")


# ---------------------------------------------------------------------------
# Main: compute measure → bucket → percentile → alert for all 7 BASICs
# ---------------------------------------------------------------------------

def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--skip-hm", action="store_true",
                   help="Skip HM Compliance computation (saves ~2 min if you "
                        "haven't changed inspection/violation files).")
    p.add_argument("--skip-crash", action="store_true",
                   help="Skip Crash Indicator (use when scrape isn't done yet).")
    args = p.parse_args()

    print(f"Reading {PARQUET.name}…")
    df = pl.read_parquet(PARQUET)
    print(f"  rows: {df.height:,}")

    # ----- Phase 1: compute measures we don't have from bulk file -----

    if not args.skip_hm:
        print("\nPhase 1a: HM Compliance measure")
        df = compute_hm_compliance_measure(df)

    if not args.skip_crash:
        print("\nPhase 1b: Crash Indicator measure")
        df = compute_crash_indicator_measure(df)

    # ----- Phase 1c: per-BASIC inspections-with-violation + segment -----
    print("\nPhase 1c: event counts + segment")
    df = compute_event_counts(df)

    # ----- Phase 2: BASIC percentiles + alerts -----
    # Per SMS methodology §3: each BASIC is grouped by RELEVANT INSPECTIONS
    # (HOS/DF/VM/HM) or INSPECTIONS-WITH-VIOLATION (UD/CS), ranked ONLY among
    # carriers meeting data sufficiency (>=1 inspection-with-violation), and —
    # for UD/CI — segmented Combo vs Straight. The eligible mask defines the
    # ranking population; rank_percentile_in_group ranks within it.
    print("\nPhase 2: percentile ranking + alerts per BASIC")

    PUB = ["unsafe_driving", "hos", "vehicle_maintenance",
           "driver_fitness", "controlled_substances"]

    # Unsafe Driving — segment (Combo/Straight) + group by # inspections w/ UD
    # violation. Excessively-high measures (>=250) are pinned to percentile 100
    # per methodology footnote 16.
    print("  Unsafe Driving (segmented Combo/Straight, grouped by insp-with-viol)")
    df = df.with_columns(
        _elig_unsafe_driving=(
            (pl.col("unsafe_driving_insp_viol") >= 3)
            & pl.col("unsafe_driving_measure").is_not_null()
        ),
        unsafe_driving_seg_group=pl.when(pl.col("seg_segment") == "Combo")
        .then(assign_bucket(pl.col("unsafe_driving_insp_viol"), UNSAFE_DRIVING_COMBO_BUCKETS))
        .otherwise(assign_bucket(pl.col("unsafe_driving_insp_viol"), UNSAFE_DRIVING_STRAIGHT_BUCKETS)),
    )
    df = df.with_columns(
        unsafe_driving_percentile=rank_percentile_in_group(
            "unsafe_driving_measure", "unsafe_driving_seg_group", "_elig_unsafe_driving"
        )
    ).with_columns(
        # methodology footnote 16: measure >= 250 → percentile 100
        unsafe_driving_percentile=pl.when(pl.col("unsafe_driving_measure") >= 250)
        .then(100.0).otherwise(pl.col("unsafe_driving_percentile"))
    )

    # HOS — group by relevant driver inspections.
    print("  HOS Compliance (grouped by relevant driver inspections)")
    df = df.with_columns(
        _elig_hos=(
            (pl.col("driver_inspections_24mo").fill_null(0) >= 3)
            & (pl.col("hos_insp_viol") >= 1)
            & pl.col("hos_measure").is_not_null()
        ),
        hos_seg_group=assign_bucket(pl.col("driver_inspections_24mo").fill_null(0), HOS_BUCKETS),
    )
    df = df.with_columns(
        hos_percentile=rank_percentile_in_group("hos_measure", "hos_seg_group", "_elig_hos")
    )

    # Vehicle Maintenance — group by relevant vehicle inspections.
    print("  Vehicle Maintenance (grouped by relevant vehicle inspections)")
    df = df.with_columns(
        _elig_vehicle_maintenance=(
            (pl.col("vehicle_inspections_24mo").fill_null(0) >= 5)
            & (pl.col("vehicle_maintenance_insp_viol") >= 1)
            & pl.col("vehicle_maintenance_measure").is_not_null()
        ),
        vehicle_maintenance_seg_group=assign_bucket(
            pl.col("vehicle_inspections_24mo").fill_null(0), VM_DF_BUCKETS
        ),
    )
    df = df.with_columns(
        vehicle_maintenance_percentile=rank_percentile_in_group(
            "vehicle_maintenance_measure", "vehicle_maintenance_seg_group", "_elig_vehicle_maintenance"
        )
    )

    # Driver Fitness — group by relevant driver inspections.
    print("  Driver Fitness (grouped by relevant driver inspections)")
    df = df.with_columns(
        _elig_driver_fitness=(
            (pl.col("driver_inspections_24mo").fill_null(0) >= 5)
            & (pl.col("driver_fitness_insp_viol") >= 1)
            & pl.col("driver_fitness_measure").is_not_null()
        ),
        driver_fitness_seg_group=assign_bucket(
            pl.col("driver_inspections_24mo").fill_null(0), VM_DF_BUCKETS
        ),
    )
    df = df.with_columns(
        driver_fitness_percentile=rank_percentile_in_group(
            "driver_fitness_measure", "driver_fitness_seg_group", "_elig_driver_fitness"
        )
    )

    # Controlled Substances — group by # inspections with applicable violation.
    print("  Controlled Substances (grouped by insp-with-viol)")
    df = df.with_columns(
        _elig_controlled_substances=(
            (pl.col("controlled_substances_insp_viol") >= 1)
            & pl.col("controlled_substances_measure").is_not_null()
        ),
        controlled_substances_seg_group=assign_bucket(
            pl.col("controlled_substances_insp_viol"), CONTROLLED_SUB_BUCKETS
        ),
    )
    df = df.with_columns(
        controlled_substances_percentile=rank_percentile_in_group(
            "controlled_substances_measure", "controlled_substances_seg_group",
            "_elig_controlled_substances"
        )
    )

    # Alerts for the 5 public BASICs, recomputed from the corrected percentiles
    # so alerts and percentiles stay internally consistent (general thresholds).
    for basic in PUB:
        df = df.with_columns(
            **{f"{basic}_alert": assign_alert(f"{basic}_percentile", basic)}
        )

    # HM Compliance (only if we computed measure)
    if not args.skip_hm:
        print("  HM Compliance")
        df = df.with_columns(
            hm_compliance_seg_group=assign_bucket(
                pl.col("hm_relevant_inspections").fill_null(0), HM_BUCKETS
            ),
        )
        df = df.with_columns(_elig_hm=pl.col("hm_sufficient").fill_null(False))
        df = df.with_columns(
            hm_compliance_percentile=rank_percentile_in_group(
                "hm_compliance_measure", "hm_compliance_seg_group", "_elig_hm"
            )
        )
        df = df.with_columns(
            hm_compliance_alert=assign_alert("hm_compliance_percentile", "hm_compliance"),
        )

    # Crash Indicator (only if we computed measure)
    if not args.skip_crash and "crash_indicator_measure" in df.columns:
        print("  Crash Indicator")
        df = df.with_columns(
            crash_indicator_seg_group=pl.when(pl.col("crash_indicator_segment") == "Combo")
            .then(assign_bucket(pl.col("crash_count_24mo").fill_null(0), CRASH_COMBO_BUCKETS))
            .otherwise(assign_bucket(pl.col("crash_count_24mo").fill_null(0), CRASH_STRAIGHT_BUCKETS)),
        )
        df = df.with_columns(_elig_ci=pl.col("ci_sufficient").fill_null(False))
        df = df.with_columns(
            crash_indicator_percentile=rank_percentile_in_group(
                "crash_indicator_measure", "crash_indicator_seg_group", "_elig_ci"
            )
        )
        df = df.with_columns(
            crash_indicator_alert=assign_alert("crash_indicator_percentile", "crash_indicator"),
        )

    # Drop intermediate helper columns
    drop_cols = [
        "seg_segment",
        "_elig_unsafe_driving", "_elig_hos", "_elig_vehicle_maintenance",
        "_elig_driver_fitness", "_elig_controlled_substances", "_elig_hm", "_elig_ci",
        "unsafe_driving_insp_viol", "hos_insp_viol", "vehicle_maintenance_insp_viol",
        "driver_fitness_insp_viol", "controlled_substances_insp_viol",
        "hm_relevant_inspections", "hm_time_weighted_insp", "hm_most_recent_relevant",
        "hm_violations", "hm_severity_weighted_viol", "hm_most_recent_violation",
        "hm_had_12mo_viol", "hm_had_latest_viol", "hm_sufficient",
        "crash_count_24mo", "crash_count_12mo", "ci_sufficient",
    ]
    df = df.drop([c for c in drop_cols if c in df.columns])

    print(f"\nFinal shape: {df.shape}")
    df.write_parquet(PARQUET, compression="zstd")
    print(f"Wrote {PARQUET}")

    # Summary
    print("\nAlert counts per BASIC:")
    for basic in ["unsafe_driving", "hos", "vehicle_maintenance",
                  "driver_fitness", "controlled_substances",
                  "hm_compliance", "crash_indicator"]:
        col = f"{basic}_alert"
        if col not in df.columns:
            continue
        n = df.filter(pl.col(col) == "Y").height
        print(f"  {basic}: {n:,} alerted")


if __name__ == "__main__":
    main()
