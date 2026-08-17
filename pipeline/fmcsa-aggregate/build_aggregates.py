# /// script
# requires-python = ">=3.11"
# dependencies = ["polars>=1.0"]
# ///
"""
Build offline per-carrier aggregates from FMCSA SMS bulk files.

Inputs (in INPUT_DIR):
  - SMS_Input_-_Motor_Carrier_Census_Information_<YYYYMMDD>.csv  (~752 MB)
  - SMS_AB_PassProperty_<YYYYMMDD>.csv                            (~64  MB)
  - Crash_File.csv                                                (~1.85 GB)
  - SMS_Input_-_Inspection_<YYYYMMDD>.csv                         (~1.45 GB) — used for hazmat counts (matches SAFER definition)
  - Company_Census_File.csv                                       (~1.7 GB)  — safety rating, MCS-150, prior-revoke, address
  - Carrier_All_With_History.csv                                  (~335 MB)  — authority, BIPD-on-file
  - ActPendInsur_All_With_History.csv                             (~50 MB)   — insurer name + policy effective dates

Outputs (in OUTPUT_DIR):
  - carrier_aggregates.parquet  : one row per DOT, all signals joined
  - national_thresholds.json    : P50/P75/P85/P90/P95 cutoffs per signal

Window: trailing 24 months from SNAPSHOT_DATE.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import polars as pl

# --- config -----------------------------------------------------------------

# Single source of truth: build_all exports FMCSA_SNAPSHOT_DATE from DATA_TAG.
# These were two independent literals — bump one, forget the other, and the
# 24-month crash filter silently disagrees with the date the file stamps.
SNAPSHOT_DATE = int(os.environ.get('FMCSA_SNAPSHOT_DATE', '20260812'))
WINDOW_START = SNAPSHOT_DATE - 20000  # exactly 24 months earlier

# Non-API feeds (PassProperty, Crash_File, Carrier auth, ActPendInsur) live here.
# Override with FMCSA_INPUT_DIR for a candidate build from a staging dir.
INPUT_DIR = Path(os.environ.get("FMCSA_INPUT_DIR", "/Users/art/Downloads"))
# The 5 Socrata-refreshable feeds resolve from REFRESH_DIR when set (files use
# the un-dated refresh_sms_data.py names); otherwise they fall back to INPUT_DIR
# with the original dated filenames. Lets us refresh inspection/violation/crash/
# census while holding PassProperty et al. at the current vintage.
_REFRESH_DIR = os.environ.get("FMCSA_REFRESH_DIR")
REFRESH_DIR = Path(_REFRESH_DIR) if _REFRESH_DIR else None


def _refreshable(refresh_name: str, fallback: Path) -> Path:
    """Prefer REFRESH_DIR/<refresh_name> when a refresh dir is configured."""
    if REFRESH_DIR is not None:
        p = REFRESH_DIR / refresh_name
        if p.exists():
            return p
    return fallback


OUTPUT_DIR = Path(os.environ.get("FMCSA_OUTPUT_DIR", Path(__file__).parent))

CENSUS_PATH = Path(os.environ.get(
    "FMCSA_MOTOR_CARRIER_CENSUS",
    _refreshable(
        "SMS_Input_-_Motor_Carrier_Census_Information.csv",
        INPUT_DIR / "SMS_Input_-_Motor_Carrier_Census_Information_20260514.csv",
    ),
))
PASSPROP_PATH = Path(os.environ.get(
    "FMCSA_PASSPROP",
    INPUT_DIR / "SMS_AB_PassProperty_20260514.csv",
))
CRASH_PATH = INPUT_DIR / "Crash_File.csv"
# Hazmat counts source: SMS_Input_-_Inspection (NOT the raw Vehicle_Inspection_File).
# Verified empirically: aggregating from this file with `Total_Hazmat_Sent > 0`
# produces SAFER-matching counts (Schneider: 508 vs SAFER 502). The previous
# approach (raw inspection file with HAZMAT_PLACARD_REQ='Y') produced 86 — way
# under SAFER, because PLACARD_REQ is the strict regulatory-placard subset
# while SAFER counts any inspection where hazmat was being transported.
INSPECTION_PATH = Path(os.environ.get(
    "FMCSA_INSPECTION_FILE",
    _refreshable(
        "SMS_Input_-_Inspection.csv", INPUT_DIR / "SMS_Input_-_Inspection_20260518.csv"
    ),
))
# Critical-tier data sources (DOT Open Data Portal bulk extracts)
COMPANY_CENSUS_PATH = Path(os.environ.get(
    "FMCSA_COMPANY_CENSUS",
    _refreshable("Company_Census_File.csv", INPUT_DIR / "Company_Census_File.csv"),
))
CARRIER_AUTH_PATH = Path(os.environ.get(
    "FMCSA_CARRIER_AUTH",
    INPUT_DIR / "Carrier_All_With_History.csv",
))
ACTPEND_INSUR_PATH = Path(os.environ.get(
    "FMCSA_ACTPEND",
    INPUT_DIR / "ActPendInsur_All_With_History.csv",
))

OUT_PARQUET = Path(os.environ.get("FMCSA_PARQUET", OUTPUT_DIR / "carrier_aggregates.parquet"))
OUT_IDENTITY = Path(os.environ.get("FMCSA_IDENTITY_PARQUET", OUTPUT_DIR / "carrier_identity.parquet"))
OUT_THRESHOLDS = Path(os.environ.get("FMCSA_THRESHOLDS_OUT", OUTPUT_DIR / "national_thresholds.json"))

# Minimum inspections for a carrier's OOS rate to count toward the national
# threshold distribution. FMCSA SMS uses a data-sufficiency threshold; we use 3.
MIN_INSP_FOR_THRESHOLD = 3
MIN_PU_FOR_CRASH_THRESHOLD = 1


def log(msg: str) -> None:
    print(f"[build_aggregates] {msg}", flush=True)


# --- step 1: census ---------------------------------------------------------

def load_census() -> pl.LazyFrame:
    log(f"Scanning census: {CENSUS_PATH.name}")
    return (
        pl.scan_csv(
            CENSUS_PATH,
            schema_overrides={
                "DOT_NUMBER": pl.Int64,
                "NBR_POWER_UNIT": pl.Int64,
                "DRIVER_TOTAL": pl.Int64,
                "MCS150_MILEAGE": pl.Int64,
                # ADD_DATE is DD-MMM-YY (e.g., "01-JUN-74"); parsed as string then dt-parsed.
                "ADD_DATE": pl.Utf8,
                "PHY_STATE": pl.Utf8,
            },
            ignore_errors=True,
        )
        .with_columns(
            # Parse DD-MMM-YY → Date. Polars %y assumes 19xx for ≥69, 20xx for <69 by default.
            dot_add_date=pl.col("ADD_DATE").str.strptime(
                pl.Date, format="%d-%b-%y", strict=False
            ).dt.strftime("%Y-%m-%d"),
        )
        .select(
            pl.col("DOT_NUMBER"),
            pl.col("LEGAL_NAME"),
            pl.col("DBA_NAME"),
            pl.col("HM_FLAG"),
            pl.col("PHY_STATE").alias("physical_state"),
            pl.col("CARRIER_OPERATION"),
            pl.col("NBR_POWER_UNIT").alias("power_units"),
            pl.col("DRIVER_TOTAL").alias("drivers"),
            pl.col("MCS150_MILEAGE").alias("annual_mileage"),
            "dot_add_date",
        )
    )


# --- step 2: SMS AB PassProperty (24-mo inspection rollups + BASIC alerts) --

def load_passproperty() -> pl.LazyFrame:
    log(f"Scanning PassProperty: {PASSPROP_PATH.name}")
    # All numeric columns are quoted strings — cast on the way in.
    int_cols = [
        "INSP_TOTAL",
        "DRIVER_INSP_TOTAL", "DRIVER_OOS_INSP_TOTAL",
        "VEHICLE_INSP_TOTAL", "VEHICLE_OOS_INSP_TOTAL",
        "UNSAFE_DRIV_INSP_W_VIOL",
        "HOS_DRIV_INSP_W_VIOL",
        "DRIV_FIT_INSP_W_VIOL",
        "CONTR_SUBST_INSP_W_VIOL",
        "VEH_MAINT_INSP_W_VIOL",
    ]
    float_cols = [
        "UNSAFE_DRIV_MEASURE",
        "HOS_DRIV_MEASURE",
        "DRIV_FIT_MEASURE",
        "CONTR_SUBST_MEASURE",
        "VEH_MAINT_MEASURE",
    ]
    overrides: dict[str, pl.DataType] = {"DOT_NUMBER": pl.Int64}
    overrides.update({c: pl.Int64 for c in int_cols})
    overrides.update({c: pl.Float64 for c in float_cols})

    return (
        pl.scan_csv(PASSPROP_PATH, schema_overrides=overrides, ignore_errors=True)
        .with_columns(
            driver_oos_rate=pl.when(pl.col("DRIVER_INSP_TOTAL") > 0)
            .then(pl.col("DRIVER_OOS_INSP_TOTAL") / pl.col("DRIVER_INSP_TOTAL"))
            .otherwise(None),
            vehicle_oos_rate=pl.when(pl.col("VEHICLE_INSP_TOTAL") > 0)
            .then(pl.col("VEHICLE_OOS_INSP_TOTAL") / pl.col("VEHICLE_INSP_TOTAL"))
            .otherwise(None),
        )
        .with_columns(
            unsafe_driving_rate=pl.when(pl.col("DRIVER_INSP_TOTAL") > 0)
            .then(pl.col("UNSAFE_DRIV_INSP_W_VIOL") / pl.col("DRIVER_INSP_TOTAL"))
            .otherwise(None),
            hos_rate=pl.when(pl.col("DRIVER_INSP_TOTAL") > 0)
            .then(pl.col("HOS_DRIV_INSP_W_VIOL") / pl.col("DRIVER_INSP_TOTAL"))
            .otherwise(None),
        )
        .select(
            "DOT_NUMBER",
            pl.col("INSP_TOTAL").alias("inspections_24mo"),
            pl.col("DRIVER_INSP_TOTAL").alias("driver_inspections_24mo"),
            pl.col("DRIVER_OOS_INSP_TOTAL").alias("driver_oos_24mo"),
            pl.col("VEHICLE_INSP_TOTAL").alias("vehicle_inspections_24mo"),
            pl.col("VEHICLE_OOS_INSP_TOTAL").alias("vehicle_oos_24mo"),
            pl.col("UNSAFE_DRIV_INSP_W_VIOL").alias("unsafe_driving_violations_24mo"),
            pl.col("HOS_DRIV_INSP_W_VIOL").alias("hos_violations_24mo"),
            "driver_oos_rate",
            "vehicle_oos_rate",
            "unsafe_driving_rate",
            "hos_rate",
            pl.col("UNSAFE_DRIV_AC").alias("unsafe_driving_alert"),
            pl.col("HOS_DRIV_AC").alias("hos_alert"),
            pl.col("DRIV_FIT_AC").alias("driver_fitness_alert"),
            pl.col("CONTR_SUBST_AC").alias("controlled_substances_alert"),
            pl.col("VEH_MAINT_AC").alias("vehicle_maintenance_alert"),
            # BASIC measures (FMCSA's own percentile-input numbers). Pair with
            # the *_alert columns above and surface in the UI to anchor our
            # peer-group cutoffs against FMCSA's authoritative measures.
            pl.col("UNSAFE_DRIV_MEASURE").alias("unsafe_driving_measure"),
            pl.col("HOS_DRIV_MEASURE").alias("hos_measure"),
            pl.col("DRIV_FIT_MEASURE").alias("driver_fitness_measure"),
            pl.col("CONTR_SUBST_MEASURE").alias("controlled_substances_measure"),
            pl.col("VEH_MAINT_MEASURE").alias("vehicle_maintenance_measure"),
        )
    )


# --- step 3: crash aggregate (24mo) -----------------------------------------

def aggregate_crashes() -> pl.LazyFrame:
    """
    Two outputs:
      * Original counts: crashes_24mo, fatal_crashes_24mo, injury_crashes_24mo,
        tow_crashes_24mo (overlapping severity flags — kept for backward
        compatibility with v9/v10/v11 Python scoring scripts).
      * crash_measure — OUR weighted crash rate, deliberately NOT a reproduction
        of the SMS Crash Indicator BASIC. That reproduction lives in
        compute_basics.py (crash_indicator_measure) and uses FMCSA's own
        Severity_Weight/Time_Weight columns, excludes Not_Preventable crashes,
        and divides by the scraped Avg PU x UF. THIS column instead uses our own
        severity tiers and divides by reported power_units, so it covers ~1.98M
        carriers versus the ~23k the real BASIC can reach (which needs a scraped
        Avg PU). Both are wanted; only the BASIC is FMCSA-conformant.
        Our severity tiers intentionally separate fatal from injury because a
        fatality is a far larger liability for a broker; FMCSA collapses both to
        2 (methodology Table 3-6) because it is triaging investigations, not
        pricing risk. Do NOT "fix" this to match Table 3-6 without also changing
        what it is called and what consumes it.
        Each crash gets a mutually-exclusive severity tier
        (Fatal=4 > Injury=3 > Tow=2 > NoHarm=1) times a
        time-recency weight (≤6mo ago=3, 7-12mo=2, 13-24mo=1). Summed per
        carrier; divided by power_units downstream to produce the SMS Crash
        Indicator measure.
    """
    log(f"Scanning crashes: {CRASH_PATH.name} (filter REPORT_DATE >= {WINDOW_START})")
    return (
        pl.scan_csv(
            CRASH_PATH,
            schema_overrides={
                "DOT_NUMBER": pl.Int64,
                "REPORT_DATE": pl.Int64,
                "FATALITIES": pl.Int64,
                "INJURIES": pl.Int64,
            },
            ignore_errors=True,
        )
        .filter(pl.col("REPORT_DATE") >= WINDOW_START)
        .filter(pl.col("DOT_NUMBER").is_not_null())
        .with_columns(
            # Mutually-exclusive severity tier (highest applicable wins).
            severity_weight=pl.when(pl.col("FATALITIES") > 0)
            .then(4)
            .when(pl.col("INJURIES") > 0)
            .then(3)
            .when(pl.col("TOW_AWAY") == "Y")
            .then(2)
            .otherwise(1),
            # Months ago: parse YYYYMMDD into date, compute difference.
            months_ago=(
                pl.lit(SNAPSHOT_DATE).cast(pl.Utf8).str.strptime(pl.Date, format="%Y%m%d", strict=False)
                - pl.col("REPORT_DATE").cast(pl.Utf8).str.strptime(pl.Date, format="%Y%m%d", strict=False)
            ).dt.total_days() / 30.4375,
        )
        .with_columns(
            time_weight=pl.when(pl.col("months_ago") <= 6)
            .then(3)
            .when(pl.col("months_ago") <= 12)
            .then(2)
            .otherwise(1),
        )
        .with_columns(
            weighted_crash=pl.col("severity_weight") * pl.col("time_weight"),
        )
        .group_by("DOT_NUMBER")
        .agg(
            crashes_24mo=pl.len(),
            fatal_crashes_24mo=(pl.col("FATALITIES") > 0).sum(),
            injury_crashes_24mo=(pl.col("INJURIES") > 0).sum(),
            tow_crashes_24mo=(pl.col("TOW_AWAY") == "Y").sum(),
            total_fatalities_24mo=pl.col("FATALITIES").sum(),
            total_injuries_24mo=pl.col("INJURIES").sum(),
            # SMS-style weighted measure (numerator). Divided by power_units in
            # the join step to produce the Crash Indicator measure.
            weighted_crash_total=pl.col("weighted_crash").sum(),
        )
    )


# --- step 4: hazmat OOS aggregate (24mo, from raw inspection file) ----------

def aggregate_hazmat_oos() -> pl.LazyFrame:
    """
    Aggregate hazmat inspection counts using SAFER's definition.

    Empirically validated against the SAFER Company Snapshot for 12 known
    DOTs — using `Total_Hazmat_Sent > 0` from SMS_Input_-_Inspection produces
    counts that match SAFER within snapshot-window noise (Schneider: 508 vs
    SAFER 502; J.B. Hunt: 724 vs 705; Marten: 120 vs 118).

    The prior approach (raw Vehicle_Inspection_File with
    `HAZMAT_PLACARD_REQ='Y'`) undercounted by 5-6× for mega fleets because
    PLACARD_REQ is the strict regulatory-placard subset, while SAFER's
    "Hazmat Inspections" count is any inspection where the carrier was
    transporting hazardous material (placardable or not).

    SMS_Input_-_Inspection is already filtered to the 24-month SMS window,
    so no date filter is applied here.
    """
    log(f"Scanning inspections for hazmat counts: {INSPECTION_PATH.name}")
    return (
        pl.scan_csv(
            INSPECTION_PATH,
            schema_overrides={
                "DOT_Number": pl.Int64,
                "Total_Hazmat_Sent": pl.Int64,
                "Hazmat_OOS_Total": pl.Int64,
            },
            ignore_errors=True,
        )
        .filter(pl.col("DOT_Number").is_not_null())
        .filter(pl.col("Total_Hazmat_Sent") > 0)
        .group_by("DOT_Number")
        .agg(
            hazmat_inspections_24mo=pl.len(),
            hazmat_oos_24mo=(pl.col("Hazmat_OOS_Total") > 0).sum(),
        )
        .rename({"DOT_Number": "DOT_NUMBER"})
        .with_columns(
            hazmat_oos_rate=pl.when(pl.col("hazmat_inspections_24mo") > 0)
            .then(pl.col("hazmat_oos_24mo") / pl.col("hazmat_inspections_24mo"))
            .otherwise(None),
        )
    )


# --- step 4b: Company Census (safety rating + status) -----------------------

def load_company_census() -> pl.LazyFrame:
    log(f"Scanning Company Census: {COMPANY_CENSUS_PATH.name}")
    # YYYYMMDD-or-YYYYMMDD-HHMM → YYYY-MM-DD. Slice first 8 chars and parse.
    def yyyymmdd_to_iso(col_name: str) -> pl.Expr:
        return (
            pl.col(col_name)
            .str.head(8)
            .str.strptime(pl.Date, format="%Y%m%d", strict=False)
            .dt.strftime("%Y-%m-%d")
        )

    return (
        pl.scan_csv(
            COMPANY_CENSUS_PATH,
            schema_overrides={
                "DOT_NUMBER": pl.Int64,
                # Force string for these — date fields include "20260508 1543"
                # values that break int inference, and with ignore_errors=True
                # polars silently nulls the row.
                "MCS150_DATE": pl.Utf8,
                "ADD_DATE": pl.Utf8,
                "STATUS_CODE": pl.Utf8,
                "SAFETY_RATING": pl.Utf8,
                "SAFETY_RATING_DATE": pl.Utf8,
                "REVIEW_DATE": pl.Utf8,
                "REVIEW_TYPE": pl.Utf8,
                "PRIOR_REVOKE_FLAG": pl.Utf8,
                "PRIOR_REVOKE_DOT_NUMBER": pl.Int64,
                "RECORDABLE_CRASH_RATE": pl.Float64,
                "PHONE": pl.Utf8,
                "EMAIL_ADDRESS": pl.Utf8,
                "COMPANY_OFFICER_1": pl.Utf8,
                "COMPANY_OFFICER_2": pl.Utf8,
                "PHY_STREET": pl.Utf8,
                "PHY_CITY": pl.Utf8,
                "PHY_ZIP": pl.Utf8,
                # MC/MX/FF docket + operation classification — broker-facing
                # core fields, kept in main parquet (not identity) so they're
                # available on every audit lookup.
                "DOCKET1PREFIX": pl.Utf8,
                "DOCKET1": pl.Int64,
                "DOCKET2PREFIX": pl.Utf8,
                "DOCKET2": pl.Int64,
                "DOCKET3PREFIX": pl.Utf8,
                "DOCKET3": pl.Int64,
                "DOCKET1_STATUS_CODE": pl.Utf8,
                "DOCKET2_STATUS_CODE": pl.Utf8,
                "DOCKET3_STATUS_CODE": pl.Utf8,
                "CLASSDEF": pl.Utf8,
                "BUSINESS_ORG_DESC": pl.Utf8,
            },
            ignore_errors=True,
        )
        .with_columns(
            # Normalize all date columns to YYYY-MM-DD strings to match
            # the rest of the parquet (dot_add_date already follows this format).
            safety_rating_date=yyyymmdd_to_iso("SAFETY_RATING_DATE"),
            mcs150_date=yyyymmdd_to_iso("MCS150_DATE"),
            # NOTE: REVIEW_DATE / REVIEW_TYPE in Census reflect the
            # rating-context review (the one that produced the safety rating),
            # NOT the most-recent compliance review or safety audit. SAFER
            # displays the most-recent review, sourced from the Motor Carrier
            # Compliance Reviews & Safety Audits dataset (no bulk download
            # available). Surfaced here as best-available, but consumers should
            # NOT treat this as "FMCSA recently reviewed this carrier".
            review_date=yyyymmdd_to_iso("REVIEW_DATE"),
            # Primary MC/MX/FF docket. Format: "MC-133655" / "FF-51075" /
            # "MX-..." for Mexican carriers. Brokers reference this alongside
            # the DOT number on every load contract.
            mc_number=(
                pl.when(pl.col("DOCKET1PREFIX").is_not_null() & pl.col("DOCKET1").is_not_null())
                .then(pl.col("DOCKET1PREFIX") + pl.lit("-") + pl.col("DOCKET1").cast(pl.Utf8))
                .otherwise(None)
            ),
            # Secondary docket(s) — many carriers have multiple (e.g. Hunt has
            # MC-135797 + FF-51075). Pipe-separated for compactness; null when
            # only one docket exists.
            additional_dockets=(
                pl.when(pl.col("DOCKET2PREFIX").is_not_null() & pl.col("DOCKET2").is_not_null())
                .then(pl.col("DOCKET2PREFIX") + pl.lit("-") + pl.col("DOCKET2").cast(pl.Utf8))
                .otherwise(None)
            ),
        )
        .select(
            "DOT_NUMBER",
            pl.col("STATUS_CODE").alias("status_code"),
            pl.col("SAFETY_RATING").alias("safety_rating"),
            "safety_rating_date",
            "mcs150_date",
            "review_date",
            pl.col("REVIEW_TYPE").alias("review_type"),
            # Chameleon-detection: FMCSA's own flag linking this DOT to a
            # previously-revoked predecessor DOT. The strongest single
            # chameleon signal — no inference required.
            (pl.col("PRIOR_REVOKE_FLAG") == "Y").alias("prior_revoke_flag"),
            pl.col("PRIOR_REVOKE_DOT_NUMBER").alias("prior_revoke_dot_number"),
            # FMCSA's own pre-computed recordable crash rate (independent
            # methodology from our crashes_per_million_miles — pair both).
            pl.col("RECORDABLE_CRASH_RATE").alias("recordable_crash_rate"),
            # MC/MX/FF docket(s) and operation classification — broker-facing
            # core fields (every load contract references the MC number).
            "mc_number",
            "additional_dockets",
            pl.col("CLASSDEF").alias("operation_classification"),
            pl.col("BUSINESS_ORG_DESC").alias("business_org_type"),
            # NOTE: phy_street/phy_city/phy_zip/phone/email_address/officer_1/
            # officer_2 used to be selected here but moved to the identity
            # parquet (lib/fmcsa-identity.ts). Keeping them in main as well
            # would double-store ~80MB of strings and push main past GitHub's
            # 100MB blob limit. Identity is lazy-loaded when a broker drills
            # into a specific carrier.
        )
        # Company Census can have duplicate rows per DOT; keep the first
        .unique(subset=["DOT_NUMBER"], keep="first")
        .with_columns(
            allowed_to_operate=pl.when(pl.col("status_code") == "A")
            .then(pl.lit("Y"))
            .otherwise(pl.lit("N")),
        )
    )


# --- step 4c: Carrier authority (BIPD required + on-file flag) --------------

def load_carrier_authority() -> pl.LazyFrame:
    log(f"Scanning Carrier authority: {CARRIER_AUTH_PATH.name}")
    return (
        pl.scan_csv(
            CARRIER_AUTH_PATH,
            schema_overrides={
                "DOT_NUMBER": pl.Int64,
                # MIN_COV_AMOUNT and BIPD_FILE are zero-padded $-thousands amounts.
                # CARGO_FILE and BOND_FILE are Y/N flags (NOT amounts) — confirmed by
                # inspecting the raw rows. The actual cargo amount, if needed,
                # lives in the ActPendInsur file per-policy.
                "MIN_COV_AMOUNT": pl.Float64,
                "BIPD_FILE": pl.Float64,
                "CARGO_FILE": pl.Utf8,
                "COMMON_STAT": pl.Utf8,
                "CONTRACT_STAT": pl.Utf8,
                "BROKER_STAT": pl.Utf8,
                "PROPERTY_CHK": pl.Utf8,
                "PASSENGER_CHK": pl.Utf8,
                "CARGO_REQ": pl.Utf8,
            },
            ignore_errors=True,
        )
        .filter(pl.col("DOT_NUMBER").is_not_null())
        .group_by("DOT_NUMBER")
        .agg(
            bipd_required_amount=pl.col("MIN_COV_AMOUNT").max(),
            bipd_insurance_on_file=pl.col("BIPD_FILE").max(),
            # Boolean: any docket row reports cargo insurance on file
            cargo_on_file_flag=(pl.col("CARGO_FILE") == "Y").any(),
            cargo_required_flag=(pl.col("CARGO_REQ") == "Y").any(),
            # Authority-type checkboxes (any docket row "Y" → carrier has it).
            # Surfaced individually so brokers can answer "is this carrier
            # authorized for HHG?" without re-reading the source CSV.
            has_property_authority=(pl.col("PROPERTY_CHK") == "Y").any(),
            has_passenger_authority=(pl.col("PASSENGER_CHK") == "Y").any(),
            has_hhg_authority=(pl.col("HHG_CHK") == "Y").any(),
            has_private_authority=(pl.col("PRIVATE_AUTH_CHK") == "Y").any(),
            has_enterprise_authority=(pl.col("ENTERPRISE_CHK") == "Y").any(),
            # Authority status by docket type.
            common_active=(pl.col("COMMON_STAT") == "A").any(),
            contract_active=(pl.col("CONTRACT_STAT") == "A").any(),
            broker_active=(pl.col("BROKER_STAT") == "A").any(),
        )
        .with_columns(
            # BIPD is required if a min-coverage was set or the carrier holds
            # property/passenger authority (broker-only authorities don't require BIPD).
            bipd_insurance_required=pl.when(
                (pl.col("bipd_required_amount") > 0)
                | pl.col("has_property_authority")
                | pl.col("has_passenger_authority")
            )
            .then(pl.lit("Y"))
            .otherwise(pl.lit("N")),
            has_active_authority=(
                pl.col("common_active") | pl.col("contract_active") | pl.col("broker_active")
            ),
            has_broker_authority=pl.col("broker_active"),
        )
        .select(
            "DOT_NUMBER",
            "bipd_required_amount",
            "bipd_insurance_on_file",
            "bipd_insurance_required",
            "cargo_on_file_flag",
            "cargo_required_flag",
            "has_active_authority",
            # Authority types (5 flags from MCS-150 + 1 derived from BROKER_STAT)
            "has_property_authority",
            "has_passenger_authority",
            "has_hhg_authority",
            "has_private_authority",
            "has_enterprise_authority",
            "has_broker_authority",
        )
    )


# --- step 4d: chameleon-cluster counters (address dedup + name reuse) -------

def aggregate_chameleon() -> pl.LazyFrame:
    """
    Per-DOT chameleon-cluster counters derived from Company Census.

    Rule: chameleon-address-cluster (OOS-share variant).
      Address dedup. Counts how many OTHER DOTs share this carrier's
      normalized physical address, split by their FMCSA status. The
      out-of-service-sibling count is the strong signal: brokers care
      most when an active carrier shares an address with a pile of
      defunct DOTs (the chameleon-farm pattern). The active-sibling
      count is supporting context (registered-agent addresses tend to
      have lots of active siblings and few OOS, so this lets the
      consumer distinguish patterns).

    Why we settled on OOS share (and not cluster-size suppression):
      Real-data exploration (.context/explore_chameleon_2.py, May 2026)
      showed real chameleon farms and benign registered agents overlap
      heavily in cluster size — both span n=10 through n=50. What
      distinguishes them is the OOS:active ratio. A cluster like
      "9435 Waterstone Blvd STE 140 Cincinnati OH" has 5 active and 15
      OOS at one suite — chameleon pattern. The Dover DE
      registered-agent at "8 The Green Suite A" has 11 active and 4
      OOS — registered agent. Cluster size alone confuses the two; OOS
      count separates them.

    Address normalization:
      - Excluded: PO boxes ("P.O. BOX ...", "POST OFFICE BOX ..."), blank
        / "UNKNOWN" street rows, and any cluster ≥ MEGA_CLUSTER_CUTOFF
        (definite registered-agent / virtual-mailbox services).
      - Kept: suite/unit numbers (strict key). Empirical finding: the
        aggressive-strip variant collapses adjacent tenants in office
        buildings into one cluster, adding more noise than signal.

    Outputs per DOT:
      address_dupe_active_count : # of OTHER active-status DOTs at same
                                  normalized address (≥0)
      address_dupe_oos_count    : # of OTHER inactive-status DOTs at same
                                  normalized address (≥0)

    Name-reuse columns were considered but dropped from this iteration:
      A standalone name-only join produces ~281k false positives across
      the universe (common owner-op names like "Jorge Perez" repeat across
      states; common LLC stems like "Foster Trucking LLC" repeat across
      unrelated businesses). Real chameleon name reuse is best detected
      via the existing PRIOR_REVOKE_FLAG (FMCSA-blessed; already
      plumbed) or by intersecting name reuse with address co-location
      (future work, when we have a robust same-address-and-similar-name
      similarity score).
    """
    log("Computing chameleon-cluster counters from Company Census")

    # Above this cluster size, the address is overwhelmingly a registered
    # agent / virtual mailbox / business park. Real chameleon farms tend
    # to be < 30 DOTs at one suite; the famous registered-agent buildings
    # host 200-700 DOTs each (5900 Balcones Dr Austin = 268; 3377
    # California Ave Signal Hill = 700+). 100 splits the two cleanly with
    # margin to spare.
    MEGA_CLUSTER_CUTOFF = 100

    base = (
        pl.scan_csv(
            COMPANY_CENSUS_PATH,
            schema_overrides={
                "DOT_NUMBER": pl.Int64,
                "STATUS_CODE": pl.Utf8,
                "LEGAL_NAME": pl.Utf8,
                "PHY_STREET": pl.Utf8,
                "PHY_CITY": pl.Utf8,
                "PHY_STATE": pl.Utf8,
                "PHY_ZIP": pl.Utf8,
                "ADD_DATE": pl.Utf8,
            },
            ignore_errors=True,
        )
        .filter(pl.col("DOT_NUMBER").is_not_null())
        .unique(subset=["DOT_NUMBER"], keep="first")
        .with_columns(
            phy_street_up=pl.col("PHY_STREET").fill_null("").str.to_uppercase().str.strip_chars(),
            is_active=pl.col("STATUS_CODE") == "A",
        )
        .with_columns(
            # Filter out PO boxes and "UNKNOWN" / blank streets. PO boxes are
            # not fraud signals (anyone can rent one); blank/UNKNOWN streets
            # would cluster every legacy 1970s-era DOT together by city.
            is_pobox=pl.col("phy_street_up").str.contains(
                r"^(P\.? ?O\.? ?BOX|POST OFFICE BOX|PO BX|P O BOX|BOX [0-9])"
            ),
            is_unknown_street=pl.col("phy_street_up").str.contains(
                r"^(UNKNOWN|NONE|N/?A|TBD|NULL)$"
            ),
        )
        .with_columns(
            # Strict address key. Keeps suite/unit numbers so adjacent tenants
            # in a multi-tenant building don't get merged into one cluster.
            addr_key=pl.when(
                pl.col("is_pobox")
                | pl.col("is_unknown_street")
                | (pl.col("phy_street_up").str.len_chars() < 4)
            )
            .then(None)
            .otherwise(
                pl.concat_str([
                    pl.col("phy_street_up").str.replace_all(r"\s+", " ").str.strip_chars(),
                    pl.col("PHY_CITY").fill_null("").str.to_uppercase().str.strip_chars(),
                    pl.col("PHY_STATE").fill_null("").str.to_uppercase().str.strip_chars(),
                    pl.col("PHY_ZIP").fill_null("").str.head(5),
                ], separator="|")
            ),
        )
        .select("DOT_NUMBER", "addr_key", "is_active")
    )

    # Per-cluster aggregates: how many total + active + OOS DOTs at each address.
    # Mega-clusters (≥ MEGA_CLUSTER_CUTOFF) are dropped here — they're
    # registered agents / virtual mailboxes, not fraud patterns.
    addr_cluster = (
        base
        .filter(pl.col("addr_key").is_not_null())
        .group_by("addr_key")
        .agg(
            pl.len().alias("cluster_size"),
            pl.col("is_active").cast(pl.Int64).sum().alias("cluster_active"),
        )
        .with_columns(cluster_oos=pl.col("cluster_size") - pl.col("cluster_active"))
        .filter(pl.col("cluster_size") < MEGA_CLUSTER_CUTOFF)
    )

    return (
        base
        .join(addr_cluster, on="addr_key", how="left")
        .with_columns(
            # Subtract self from the appropriate bucket so the counter reflects
            # "OTHER DOTs at the same address," not "DOTs at this address
            # including me." Null-coalesce: a DOT in a dropped/mega cluster
            # ends up with both counts = 0 (cluster was suppressed).
            address_dupe_active_count=pl.when(pl.col("cluster_active").is_null())
            .then(0)
            .when(pl.col("is_active"))
            .then(pl.col("cluster_active") - 1)
            .otherwise(pl.col("cluster_active")),
            address_dupe_oos_count=pl.when(pl.col("cluster_oos").is_null())
            .then(0)
            .when(pl.col("is_active"))
            .then(pl.col("cluster_oos"))
            .otherwise(pl.col("cluster_oos") - 1),
        )
        .select("DOT_NUMBER", "address_dupe_active_count", "address_dupe_oos_count")
    )


# --- step 4e: Active/pending insurance policies (BIPD on-file amount) -------

def load_actpend_insurance() -> pl.LazyFrame:
    """
    Per-policy insurance details from ActPendInsur (active/pending only).

    bipd_insurance_on_file is NOT pulled from here — Carrier_All_With_History's
    BIPD_FILE column already has the correctly-summed primary+excess total
    that SAFER displays (Hunt: $3.5M = $1M primary + $2.5M excess). Recomputing
    here would risk drift. Instead this function contributes:
      - bipd_insurer_name        : current BIPD primary insurer
      - bipd_policy_effective_date: when current primary policy was filed
      - cargo_insurer_name       : current cargo insurer (if filed)
    """
    log(f"Scanning ActPendInsur: {ACTPEND_INSUR_PATH.name}")
    base = (
        pl.scan_csv(
            ACTPEND_INSUR_PATH,
            schema_overrides={
                "DOT_NUMBER": pl.Int64,
                "underl_lim_amount": pl.Float64,
                "max_cov_amount": pl.Float64,
                "effective_date": pl.Utf8,
                "cancl_effective_date": pl.Utf8,
            },
            ignore_errors=True,
        )
        .filter(pl.col("DOT_NUMBER").is_not_null())
        # Active = no cancel date set.
        .filter(
            (pl.col("cancl_effective_date").is_null())
            | (pl.col("cancl_effective_date") == "")
        )
    )

    # BIPD: prefer "Primary" rows over "Excess"; take the most-recent effective.
    bipd = (
        base
        .filter(pl.col("ins_type_desc").str.contains("(?i)BIPD|BI/PD|BI&PD|Liability"))
        # Rank: Primary first, then Excess; tie-break by latest effective_date.
        .with_columns(
            is_primary=pl.col("ins_type_desc").str.contains("(?i)Primary|^BIPD$|^BI/PD$|^BI&PD$"),
        )
        .sort(["DOT_NUMBER", "is_primary", "effective_date"], descending=[False, True, True])
        .group_by("DOT_NUMBER", maintain_order=True)
        .agg(
            bipd_insurer_name=pl.col("name_company").first(),
            bipd_policy_effective_date=pl.col("effective_date").first().str.head(10),
        )
    )

    cargo = (
        base
        .filter(pl.col("ins_type_desc").str.contains("(?i)cargo"))
        .sort(["DOT_NUMBER", "effective_date"], descending=[False, True])
        .group_by("DOT_NUMBER", maintain_order=True)
        .agg(
            cargo_insurer_name=pl.col("name_company").first(),
        )
    )

    return bipd.join(cargo, on="DOT_NUMBER", how="full", coalesce=True)


# --- step 5: join everything ------------------------------------------------

def build_aggregate() -> pl.DataFrame:
    census = load_census()
    passprop = load_passproperty()
    crashes = aggregate_crashes()
    hazmat = aggregate_hazmat_oos()
    company_census = load_company_census()
    carrier_auth = load_carrier_authority()
    chameleon = aggregate_chameleon()
    insurer_identity = load_actpend_insurance()

    log("Joining all sources...")
    joined = (
        census
        .join(passprop, on="DOT_NUMBER", how="left")
        .join(crashes, on="DOT_NUMBER", how="left")
        .join(hazmat, on="DOT_NUMBER", how="left")
        .join(company_census, on="DOT_NUMBER", how="left")
        .join(carrier_auth, on="DOT_NUMBER", how="left")
        .join(chameleon, on="DOT_NUMBER", how="left")
        .join(insurer_identity, on="DOT_NUMBER", how="left")
        .with_columns(
            crashes_per_truck=pl.when((pl.col("power_units").is_not_null()) & (pl.col("power_units") > 0))
            .then(pl.col("crashes_24mo").fill_null(0) / pl.col("power_units"))
            .otherwise(None),
            # SMS-style Crash Indicator measure: (weighted crash total) / power_units.
            # Weighted total has severity (Fatal=4, Injury=3, Tow=2, NoHarm=1)
            # × time recency (≤6mo=3, 7-12mo=2, 13-24mo=1) folded in already.
            crash_measure=pl.when((pl.col("power_units").is_not_null()) & (pl.col("power_units") > 0))
            .then(pl.col("weighted_crash_total").fill_null(0) / pl.col("power_units"))
            .otherwise(None),
            # Industry-standard crashes per million miles (raw count, unweighted).
            # This is the universal trucking-safety metric — every fleet publishes
            # it, every insurance underwriter uses it, every safety scorecard
            # benchmarks against it. Werner: 0.42, J.B. Hunt: ~0.50, fleet
            # average ~1.0, problem carrier ~2.0+.
            # Denominator is 24 months of MCS-150 mileage. MCS150_MILEAGE is
            # annualized, so we multiply by 2 to match the 24-month crash window.
            # Mileage is much harder to fake than power_units (separate MCS-150
            # field with audit trail).
            crashes_per_million_miles=pl.when(
                (pl.col("annual_mileage").is_not_null())
                & (pl.col("annual_mileage") > 0)
            )
            .then(pl.col("crashes_24mo").fill_null(0).cast(pl.Float64) * 1_000_000.0 / (pl.col("annual_mileage") * 2))
            .otherwise(None),
            # Fleet-size peer group using industry-standard buckets.
            #   Owner-operator: 1 PU (distinct regulatory + insurance posture)
            #   Small:    2-50      (the operational "small fleet")
            #   Mid:      51-250    (regional carrier territory)
            #   Large:    251-1000
            #   Mega:     1000+     (Schneider, JB Hunt, Werner, etc.)
            peer_group=pl.when(pl.col("power_units").is_null() | (pl.col("power_units") == 0))
            .then(pl.lit("unknown"))
            .when(pl.col("power_units") == 1)
            .then(pl.lit("owner_op"))
            .when(pl.col("power_units") <= 50)
            .then(pl.lit("small"))
            .when(pl.col("power_units") <= 250)
            .then(pl.lit("mid"))
            .when(pl.col("power_units") <= 1000)
            .then(pl.lit("large"))
            .otherwise(pl.lit("mega")),
        )
        .with_columns(
            crashes_24mo=pl.col("crashes_24mo").fill_null(0),
            fatal_crashes_24mo=pl.col("fatal_crashes_24mo").fill_null(0),
            injury_crashes_24mo=pl.col("injury_crashes_24mo").fill_null(0),
            tow_crashes_24mo=pl.col("tow_crashes_24mo").fill_null(0),
            total_fatalities_24mo=pl.col("total_fatalities_24mo").fill_null(0),
            total_injuries_24mo=pl.col("total_injuries_24mo").fill_null(0),
            weighted_crash_total=pl.col("weighted_crash_total").fill_null(0),
            hazmat_inspections_24mo=pl.col("hazmat_inspections_24mo").fill_null(0),
            hazmat_oos_24mo=pl.col("hazmat_oos_24mo").fill_null(0),
            # Chameleon-cluster counters default to 0 when the address was
            # filtered out (PO box, "UNKNOWN", or mega cluster of ≥100 DOTs
            # which we treat as a registered-agent / virtual-mailbox).
            address_dupe_active_count=pl.col("address_dupe_active_count").fill_null(0),
            address_dupe_oos_count=pl.col("address_dupe_oos_count").fill_null(0),
        )
    )

    log("Collecting joined dataframe (this is the expensive step)...")
    df = joined.collect(streaming=True)
    log(f"Collected {df.height:,} carriers x {df.width} columns")
    return df


# --- step 6: thresholds -----------------------------------------------------

def compute_thresholds(df: pl.DataFrame) -> dict:
    log("Computing national P50/P75/P85/P90/P95 thresholds...")
    out: dict = {
        "snapshot_date": SNAPSHOT_DATE,
        "window_start": WINDOW_START,
        "min_inspections_for_stat": MIN_INSP_FOR_THRESHOLD,
        "min_power_units_for_crash": MIN_PU_FOR_CRASH_THRESHOLD,
        "carrier_count_total": df.height,
    }

    def pcts(series: pl.Series, n_qualified: int) -> dict:
        if n_qualified == 0:
            return {"n": 0}
        return {
            "n": n_qualified,
            "p50": float(series.quantile(0.50) or 0),
            "p75": float(series.quantile(0.75) or 0),
            "p85": float(series.quantile(0.85) or 0),
            "p90": float(series.quantile(0.90) or 0),
            "p95": float(series.quantile(0.95) or 0),
        }

    # Driver OOS — only carriers with enough driver inspections
    drv = df.filter(pl.col("driver_inspections_24mo") >= MIN_INSP_FOR_THRESHOLD)
    out["driver_oos_rate"] = pcts(drv["driver_oos_rate"].drop_nulls(), drv.height)

    veh = df.filter(pl.col("vehicle_inspections_24mo") >= MIN_INSP_FOR_THRESHOLD)
    out["vehicle_oos_rate"] = pcts(veh["vehicle_oos_rate"].drop_nulls(), veh.height)

    haz = df.filter(pl.col("hazmat_inspections_24mo") >= MIN_INSP_FOR_THRESHOLD)
    out["hazmat_oos_rate"] = pcts(haz["hazmat_oos_rate"].drop_nulls(), haz.height)

    # Unsafe Driving and HOS rates (denominator = driver inspections, same as driver OOS)
    out["unsafe_driving_rate"] = pcts(drv["unsafe_driving_rate"].drop_nulls(), drv.height)
    out["hos_rate"] = pcts(drv["hos_rate"].drop_nulls(), drv.height)

    crash = df.filter(pl.col("power_units") >= MIN_PU_FOR_CRASH_THRESHOLD)
    out["crashes_per_truck"] = pcts(crash["crashes_per_truck"].drop_nulls(), crash.height)
    # OUR crash rate — NOT the SMS Crash Indicator BASIC. See the docstring on
    # aggregate_crashes for the distinction; conflating the two cost real
    # debugging time. Percentiles over the whole PU>=threshold population, which
    # is ~94% zero-crash, so p50..p85 are all 0.0 and this block cannot band a
    # carrier on its own.
    out["crash_measure"] = pcts(crash["crash_measure"].drop_nulls(), crash.height)
    # Same metric ranked ONLY among carriers that actually have a weighted crash.
    # This is the population any "top N%" label must be stated against: with 94%
    # zeros, "top 15%" off the full distribution is meaningless, while the
    # non-zero cutoffs (p85=3, p95=6, p99=9 in Aug 2026) are the real bands.
    # lib/email/check.ts hardcoded exactly those numbers; this makes them track.
    crash_nz = crash.filter(pl.col("crash_measure") > 0)
    _nz = crash_nz["crash_measure"].drop_nulls()
    out["crash_measure_nonzero"] = pcts(_nz, crash_nz.height)
    if crash_nz.height:
        # p99 is not in the shared pcts() shape but the band label needs it.
        out["crash_measure_nonzero"]["p99"] = float(_nz.quantile(0.99) or 0)
    # Industry-standard crashes per million miles (the primary safety metric).
    # Filter to carriers with actual reported mileage to avoid percentile
    # contamination from non-operating / fake-PU carriers.
    miles = df.filter(
        (pl.col("annual_mileage").is_not_null()) & (pl.col("annual_mileage") >= 100_000)
    )
    out["crashes_per_million_miles"] = pcts(
        miles["crashes_per_million_miles"].drop_nulls(), miles.height
    )

    # --- Peer-group thresholds ------------------------------------------------
    # Same percentiles but bucketed by fleet size (SMS Safety Event Group analog).
    # Lets the scorer compare a 10-truck carrier against other 10-truck carriers
    # instead of against the national-everyone distribution.
    peer_groups = ["owner_op", "small", "mid", "large", "mega"]
    per_group: dict = {}
    for pg in peer_groups:
        bucket = df.filter(pl.col("peer_group") == pg)
        if bucket.is_empty():
            continue
        drv_pg = bucket.filter(pl.col("driver_inspections_24mo") >= MIN_INSP_FOR_THRESHOLD)
        veh_pg = bucket.filter(pl.col("vehicle_inspections_24mo") >= MIN_INSP_FOR_THRESHOLD)
        haz_pg = bucket.filter(pl.col("hazmat_inspections_24mo") >= MIN_INSP_FOR_THRESHOLD)
        crash_pg = bucket.filter(pl.col("power_units") >= MIN_PU_FOR_CRASH_THRESHOLD)
        miles_pg = bucket.filter(
            (pl.col("annual_mileage").is_not_null())
            & (pl.col("annual_mileage") >= 100_000)
        )
        per_group[pg] = {
            "carriers_in_group": bucket.height,
            "driver_oos_rate": pcts(drv_pg["driver_oos_rate"].drop_nulls(), drv_pg.height),
            "vehicle_oos_rate": pcts(veh_pg["vehicle_oos_rate"].drop_nulls(), veh_pg.height),
            "hazmat_oos_rate": pcts(haz_pg["hazmat_oos_rate"].drop_nulls(), haz_pg.height),
            "unsafe_driving_rate": pcts(
                drv_pg["unsafe_driving_rate"].drop_nulls(), drv_pg.height
            ),
            "hos_rate": pcts(drv_pg["hos_rate"].drop_nulls(), drv_pg.height),
            "crash_measure": pcts(crash_pg["crash_measure"].drop_nulls(), crash_pg.height),
            "crashes_per_million_miles": pcts(
                miles_pg["crashes_per_million_miles"].drop_nulls(), miles_pg.height
            ),
        }
    out["peer_groups"] = per_group

    return out


# --- identity parquet ------------------------------------------------------

# Cargo-flag rolldown: each carrier has 30 boolean CRGO_* columns in Census
# (value "X" when selected). We keep them as individual boolean columns in the
# identity parquet so the broker UI can filter on specific capabilities
# (e.g. "this is a refrigerated load — show me carriers with cargo_coldfood=true").
# Booleans compress to near-zero in parquet, so the cost is minimal.
CARGO_FLAGS = [
    ("CRGO_GENFREIGHT", "cargo_general_freight"),
    ("CRGO_HOUSEHOLD", "cargo_household_goods"),
    ("CRGO_METALSHEET", "cargo_metal_sheets"),
    ("CRGO_MOTOVEH", "cargo_motor_vehicles"),
    ("CRGO_DRIVETOW", "cargo_drive_away_tow_away"),
    ("CRGO_LOGPOLE", "cargo_logs_poles_lumber"),
    ("CRGO_BLDGMAT", "cargo_building_materials"),
    ("CRGO_MOBILEHOME", "cargo_mobile_homes"),
    ("CRGO_MACHLRG", "cargo_machinery"),
    ("CRGO_PRODUCE", "cargo_produce"),
    ("CRGO_LIQGAS", "cargo_liquids_gases"),
    ("CRGO_INTERMODAL", "cargo_intermodal"),
    ("CRGO_PASSENGERS", "cargo_passengers"),
    ("CRGO_OILFIELD", "cargo_oilfield"),
    ("CRGO_LIVESTOCK", "cargo_livestock"),
    ("CRGO_GRAINFEED", "cargo_grain_feed_hay"),
    ("CRGO_COALCOKE", "cargo_coal_coke"),
    ("CRGO_MEAT", "cargo_meat"),
    ("CRGO_GARBAGE", "cargo_garbage_refuse"),
    ("CRGO_USMAIL", "cargo_us_mail"),
    ("CRGO_CHEM", "cargo_chemicals"),
    ("CRGO_DRYBULK", "cargo_dry_bulk"),
    ("CRGO_COLDFOOD", "cargo_refrigerated_food"),
    ("CRGO_BEVERAGES", "cargo_beverages"),
    ("CRGO_PAPERPROD", "cargo_paper_products"),
    ("CRGO_UTILITY", "cargo_utilities"),
    ("CRGO_FARMSUPP", "cargo_agricultural_farm"),
    ("CRGO_CONSTRUCT", "cargo_construction"),
    ("CRGO_WATERWELL", "cargo_water_well"),
    ("CRGO_CARGOOTHR", "cargo_other"),
]


def build_identity(dot_universe: pl.DataFrame | None = None) -> pl.DataFrame:
    """
    Build the per-carrier identity layer. Separate parquet from the
    aggregates file so the scoring path doesn't pay for fields it never
    reads. Lazily loaded by the analyzer only when a broker drills into a
    specific carrier ("inspect carrier" drawer) or when chameleon cluster
    detection needs to look for shared address/officer relationships.

    When `dot_universe` is provided (a DataFrame with a DOT_NUMBER column),
    the identity table is inner-joined to it. We use this to restrict
    identity rows to the same ~2M carriers the main aggregates parquet
    knows about, dropping the 2.3M dormant/intrastate-only entries in
    Census. Without this filter the parquet hits 297 MB; with it ~50-60 MB.

    Schema:
      - Identity: phy address, mail address, phone, email, officers, DUNS
      - Operating profile: cargo capability flags (30 booleans), operating area
      - Fleet composition: owned vs term-leased truck/tractor/trailer counts,
        avg drivers leased per month
      - Compliance status: MCSIP step + date (formal "carrier under review")
    """
    log(f"Building identity parquet from {COMPANY_CENSUS_PATH.name}...")

    # Override schema for fields with messy data (avoid silent null-out)
    text_cols = [
        "PHY_STREET", "PHY_CITY", "PHY_STATE", "PHY_ZIP",
        "CARRIER_MAILING_STREET", "CARRIER_MAILING_CITY",
        "CARRIER_MAILING_STATE", "CARRIER_MAILING_ZIP",
        "PHONE", "FAX", "CELL_PHONE", "EMAIL_ADDRESS",
        "COMPANY_OFFICER_1", "COMPANY_OFFICER_2",
        "DUN_BRADSTREET_NO", "MCSIPSTEP", "MCSIPDATE", "HM_Ind",
    ]
    # INTERSTATE_*/INTRASTATE_* are DRIVER COUNTS by operating mode (not Y/N
    # flags as the column names suggest). Schneider has 2,660 interstate-far
    # drivers; Hunt has 21,543. Any positive count means the carrier operates
    # in that mode.
    int_cols = [
        "OWNTRUCK", "OWNTRACT", "OWNTRAIL",
        "TRMTRUCK", "TRMTRACT", "TRMTRAIL",
        "TRPTRUCK", "TRPTRACT", "TRPTRAIL",
        "AVG_DRIVERS_LEASED_PER_MONTH",
        "INTERSTATE_BEYOND_100_MILES", "INTERSTATE_WITHIN_100_MILES",
        "INTRASTATE_BEYOND_100_MILES", "INTRASTATE_WITHIN_100_MILES",
    ]
    overrides: dict[str, pl.DataType] = {"DOT_NUMBER": pl.Int64}
    overrides.update({c: pl.Utf8 for c in text_cols})
    overrides.update({c: pl.Int64 for c in int_cols})
    overrides.update({c: pl.Utf8 for c in (col for col, _ in CARGO_FLAGS)})

    lf = pl.scan_csv(
        COMPANY_CENSUS_PATH,
        schema_overrides=overrides,
        ignore_errors=True,
    ).filter(pl.col("DOT_NUMBER").is_not_null())

    # Build cargo-flag columns (CRGO_* "X" → True)
    cargo_exprs = [
        (pl.col(src) == "X").alias(dst) for src, dst in CARGO_FLAGS
    ]

    # Operating-mode derivation: each INTERSTATE_*/INTRASTATE_* column holds
    # a DRIVER COUNT for that mode (not a Y/N flag despite the name). Any
    # positive count means the carrier operates in that mode. We surface
    # raw counts as bools and pick the largest as `primary_operating_area`.
    def has_op(col: str) -> pl.Expr:
        return (pl.col(col).fill_null(0) > 0)

    inter_far = has_op("INTERSTATE_BEYOND_100_MILES")
    inter_near = has_op("INTERSTATE_WITHIN_100_MILES")
    intra_far = has_op("INTRASTATE_BEYOND_100_MILES")
    intra_near = has_op("INTRASTATE_WITHIN_100_MILES")

    # Largest driver count wins. Falls back through priority order on ties /
    # when only Y/N is known.
    primary_area = (
        pl.when(inter_far).then(pl.lit("interstate_otr"))
        .when(inter_near).then(pl.lit("interstate_local"))
        .when(intra_far).then(pl.lit("intrastate_long"))
        .when(intra_near).then(pl.lit("intrastate_local"))
        .otherwise(pl.lit("unknown"))
    )

    # Email domain derivation: extract the part after @, lowercase, for cheap
    # chameleon-clustering by domain. Full email is kept too because the email
    # verification flow compares sender local-part@domain against FMCSA's
    # registered address, especially for free-mail providers.
    email_domain = (
        pl.when(pl.col("EMAIL_ADDRESS").str.contains("@"))
        .then(pl.col("EMAIL_ADDRESS").str.split("@").list.get(-1).str.to_lowercase())
        .otherwise(None)
    )

    # Trims applied to fit identity parquet under GitHub's 100MB blob limit
    # (full schema was 144MB before these drops). What was cut and why:
    #   - mail_street/city/state/zip: ~32MB. Mailing address is often the
    #     carrier's registered agent (Sentry Insurance, etc.), not where
    #     trucks operate. Less useful for chameleon than physical.
    #   - fax, cell_phone: rarely populated, low broker value. ~11MB.
    #   - trip_leased_truck/tractor/trailer: almost always 0; term-leased
    #     is the load-bearing leasing metric. ~negligible compressed.
    #   - company_officer_2: usually null; officer_1 is the load-bearing
    #     identity field. ~4MB.
    df = (
        lf.select(
            pl.col("DOT_NUMBER"),
            # Physical address (primary chameleon-cluster key)
            pl.col("PHY_STREET").alias("phy_street"),
            pl.col("PHY_CITY").alias("phy_city"),
            pl.col("PHY_STATE").alias("phy_state"),
            pl.col("PHY_ZIP").alias("phy_zip"),
            # Contact
            pl.col("PHONE").alias("phone"),
            pl.col("EMAIL_ADDRESS").str.to_lowercase().alias("email_address"),
            email_domain.alias("email_domain"),
            # Officers + corporate identity
            pl.col("COMPANY_OFFICER_1").alias("company_officer_1"),
            pl.col("DUN_BRADSTREET_NO").alias("dun_bradstreet_no"),
            # Operating area — booleans derived from positive driver counts.
            has_op("INTERSTATE_BEYOND_100_MILES").alias("interstate_beyond_100mi"),
            has_op("INTERSTATE_WITHIN_100_MILES").alias("interstate_within_100mi"),
            has_op("INTRASTATE_BEYOND_100_MILES").alias("intrastate_beyond_100mi"),
            has_op("INTRASTATE_WITHIN_100_MILES").alias("intrastate_within_100mi"),
            primary_area.alias("primary_operating_area"),
            # Fleet composition (owned + term-leased; trip-leased dropped)
            pl.col("OWNTRUCK").alias("own_truck"),
            pl.col("OWNTRACT").alias("own_tractor"),
            pl.col("OWNTRAIL").alias("own_trailer"),
            pl.col("TRMTRUCK").alias("term_leased_truck"),
            pl.col("TRMTRACT").alias("term_leased_tractor"),
            pl.col("TRMTRAIL").alias("term_leased_trailer"),
            pl.col("AVG_DRIVERS_LEASED_PER_MONTH").alias("avg_drivers_leased_per_month"),
            # Compliance status — MCSIPSTEP is a single-letter code from FMCSA's
            # Motor Carrier Safety Improvement Process. Worth knowing if a
            # carrier is formally under review.
            pl.col("MCSIPSTEP").alias("mcsip_step"),
            pl.col("MCSIPDATE").str.head(8).str.strptime(
                pl.Date, format="%Y%m%d", strict=False
            ).dt.strftime("%Y-%m-%d").alias("mcsip_date"),
            (pl.col("HM_Ind") == "Y").alias("hazmat_flag"),
            # Cargo capability flags (30 booleans)
            *cargo_exprs,
        )
        .unique(subset=["DOT_NUMBER"], keep="first")
        .collect(engine="streaming")
    )
    if dot_universe is not None:
        before = df.height
        df = df.join(dot_universe, on="DOT_NUMBER", how="inner")
        log(f"Filtered identity to main parquet's DOT universe: {before:,} → {df.height:,} rows")
    log(f"Built identity table: {df.height:,} carriers × {df.width} columns")
    return df


# --- main -------------------------------------------------------------------

def main() -> None:
    OUT_PARQUET.parent.mkdir(parents=True, exist_ok=True)
    OUT_IDENTITY.parent.mkdir(parents=True, exist_ok=True)
    OUT_THRESHOLDS.parent.mkdir(parents=True, exist_ok=True)

    df = build_aggregate()

    log(f"Writing {OUT_PARQUET}")
    df.write_parquet(OUT_PARQUET, compression="zstd")

    # Use main parquet's DOTs as the identity universe — keeps identity file
    # under the GitHub 100MB blob limit.
    dot_universe = df.select("DOT_NUMBER")
    identity = build_identity(dot_universe=dot_universe)
    log(f"Writing {OUT_IDENTITY}")
    # Canonical row order — see prune_app_parquet. Without it an unchanged
    # rebuild rewrites all 96MB with identical values in a different order.
    identity.sort("DOT_NUMBER").write_parquet(OUT_IDENTITY, compression="zstd")

    thresholds = compute_thresholds(df)
    log(f"Writing {OUT_THRESHOLDS}")
    OUT_THRESHOLDS.write_text(json.dumps(thresholds, indent=2))

    # Quick sanity print
    print("\n=== National thresholds (P85) ===")
    for key in ("driver_oos_rate", "vehicle_oos_rate", "hazmat_oos_rate", "crashes_per_truck"):
        t = thresholds.get(key, {})
        if "p85" in t:
            print(f"  {key:>22}: P85={t['p85']:.4f}  (n={t['n']:,})")

    print("\n=== Sample rows for known DOTs ===")
    known = [3943677, 3333366, 2049859, 3201000, 2075148, 3621624]
    sub = df.filter(pl.col("DOT_NUMBER").is_in(known)).select(
        "DOT_NUMBER", "LEGAL_NAME", "power_units",
        "driver_oos_rate", "vehicle_oos_rate", "hazmat_oos_rate",
        "crashes_24mo", "crashes_per_truck",
    )
    print(sub)


if __name__ == "__main__":
    main()
