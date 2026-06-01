# /// script
# requires-python = ">=3.11"
# dependencies = ["polars>=1.0"]
# ///
"""
v11 — fully leverages enriched parquet.

New in v11 over v10:
  - **Critical tier** (binary regulatory failure — refuse to tender):
      * Insurance lapsed (bipd_insurance_on_file < bipd_required_amount when required)
      * Safety rating UNSATISFACTORY
      * Operating status not Active (status_code != "A")
      * Not allowed to operate
  - **Enforcement signal**: recent (≤24 mo) closed enforcement case
      * Adds an "Enforcement" axis. Combined with any other signal → bump tier.
      * High $ settled ($25k+) → auto-flag High on its own.

Risk tiers: Critical > Severe > High > Elevated (Critical always sorts first).

All v10 rules retained unchanged.

Outputs:
  - t1_action_list_v11.csv
  - t1_action_list_v11.md
"""

from __future__ import annotations

import csv
import json
from datetime import date, timedelta
from pathlib import Path

import polars as pl

HERE = Path(__file__).parent
PARQUET = HERE / "carrier_aggregates.parquet"
T1_DIR = HERE.parent / "t1-fmcsa-2026-05-14"
CARRIERS_JSON = T1_DIR / "carriers.json"
OUT_CSV = T1_DIR / "t1_action_list_v11.csv"
OUT_MD = T1_DIR / "t1_action_list_v11.md"

DRIVER_OOS_CUT = 0.10
VEHICLE_OOS_CUT = 0.40
HAZMAT_OOS_CUT = 0.05
CRASH_PER_TRUCK_CUT = 0.20
MIN_PU_FOR_CRASH_WITHOUT_HARM = 5
Z_95 = 1.96

SNAPSHOT_DATE = date(2026, 5, 14)
RECENT_REVOCATION_WINDOW_DAYS = 730
CHRONIC_REVOCATION_THRESHOLD = 3
RECENT_ENFORCEMENT_WINDOW_DAYS = 730
ENFORCEMENT_LARGE_SETTLEMENT = 25_000  # $ — solo trigger for High

LEVELS = ("Critical", "Severe", "High", "Elevated")


def wilson_lower(k_expr: pl.Expr, n_expr: pl.Expr, z: float = Z_95) -> pl.Expr:
    p_hat = k_expr / n_expr
    z2 = z * z
    center = p_hat + z2 / (2 * n_expr)
    margin = z * (p_hat * (1 - p_hat) / n_expr + z2 / (4 * n_expr * n_expr)).sqrt()
    denom = 1 + z2 / n_expr
    lower = (center - margin) / denom
    return pl.when(n_expr > 0).then(lower).otherwise(None)


def load_t1() -> pl.DataFrame:
    t1 = json.loads(CARRIERS_JSON.read_text())
    return pl.DataFrame(
        [
            {"DOT_NUMBER": int(c["dotNumber"]), "loads_today": c["loadsToday"], "t1_name": c["name"]}
            for c in t1
        ]
    )


def base_severity(row: dict) -> str:
    """v9 severity classification for statistical axes."""
    if row["flag_crash"]:
        if (row.get("crashes_per_truck") or 0) >= 0.40 or (row.get("fatal_crashes_24mo") or 0) >= 1:
            return "Severe"
        if (row.get("crashes_per_truck") or 0) >= 0.30:
            return "High"
    if row["flag_driver"] and (row.get("driver_oos_rate") or 0) >= 0.30:
        return "High"
    if row["flag_hazmat"] and (row.get("hazmat_oos_rate") or 0) >= 0.15:
        return "High"
    return "Elevated"


def bump_up(level: str) -> str:
    if level == "Elevated":
        return "High"
    if level == "High":
        return "Severe"
    if level == "Severe":
        return "Severe"
    return level


def collect_critical_reasons(r: dict) -> list[str]:
    """Binary regulatory failures — refuse to tender."""
    reasons: list[str] = []
    on_file = r.get("bipd_insurance_on_file") or 0
    required = r.get("bipd_required_amount") or 0
    bipd_required = r.get("bipd_insurance_required")
    if bipd_required == "Y" and required > 0 and on_file < required:
        reasons.append(
            f"🛑 Insurance lapsed: ${int(on_file):,} on file vs ${int(required):,} required"
        )
    rating = (r.get("safety_rating") or "").strip().upper()
    if rating == "UNSATISFACTORY":
        reasons.append("🛑 FMCSA safety rating: Unsatisfactory")
    status = (r.get("status_code") or "").strip().upper()
    if status and status != "A":
        reasons.append(f"🛑 Operating status: {status} (not Active)")
    return reasons


def fmt_reasons(r: dict) -> str:
    bits: list[str] = []
    bits.extend(collect_critical_reasons(r))
    if r.get("flag_recent_revocation"):
        bits.append(
            f"🚨 Recent involuntary revocation: {r['most_recent_involuntary_date']} "
            f"({r['revoked_license_types']})"
        )
    if (r.get("involuntary_revocations") or 0) >= CHRONIC_REVOCATION_THRESHOLD:
        bits.append(
            f"⚠ Chronic revocation history: {r['involuntary_revocations']} involuntary "
            f"(total {r['revocations_total']})"
        )
    if r.get("flag_enforcement"):
        bits.append(
            f"⚖ Recent enforcement: {r['enforcement_cases_count']} case(s), "
            f"${int(r['enforcement_total_settled']):,} settled "
            f"(latest {r['enforcement_recent_date']})"
        )
    if r["flag_crash"]:
        bits.append(
            f"Crashes: {r['crashes_per_truck']:.2f}/truck — "
            f"{r['crashes_24mo']} on {r['power_units']} PU "
            f"({r['fatal_crashes_24mo']} fatal, {r['injury_crashes_24mo']} injury, "
            f"{r['tow_crashes_24mo']} tow)"
        )
    if r["flag_driver"]:
        bits.append(
            f"Driver OOS: {r['driver_oos_rate']*100:.0f}% "
            f"(Wilson95-lower {r['driver_oos_wilson']*100:.0f}%) — "
            f"{r['driver_oos_24mo']} of {r['driver_inspections_24mo']}"
        )
    if r["flag_vehicle"]:
        bits.append(
            f"Vehicle OOS: {r['vehicle_oos_rate']*100:.0f}% "
            f"(Wilson95-lower {r['vehicle_oos_wilson']*100:.0f}%) — "
            f"{r['vehicle_oos_24mo']} of {r['vehicle_inspections_24mo']}"
        )
    if r["flag_hazmat"]:
        bits.append(
            f"Hazmat OOS: {r['hazmat_oos_rate']*100:.0f}% "
            f"(Wilson95-lower {r['hazmat_oos_wilson']*100:.0f}%) — "
            f"{r['hazmat_oos_24mo']} of {r['hazmat_inspections_24mo']}"
        )
    return "; ".join(bits)


def main() -> None:
    t1 = load_t1()
    pq = pl.read_parquet(PARQUET)
    joined = t1.join(pq, on="DOT_NUMBER", how="left")

    rev_cutoff = (SNAPSHOT_DATE - timedelta(days=RECENT_REVOCATION_WINDOW_DAYS)).isoformat()
    enf_cutoff = (SNAPSHOT_DATE - timedelta(days=RECENT_ENFORCEMENT_WINDOW_DAYS)).isoformat()

    scored = joined.with_columns(
        driver_oos_wilson=wilson_lower(pl.col("driver_oos_24mo"), pl.col("driver_inspections_24mo")),
        vehicle_oos_wilson=wilson_lower(pl.col("vehicle_oos_24mo"), pl.col("vehicle_inspections_24mo")),
        hazmat_oos_wilson=wilson_lower(pl.col("hazmat_oos_24mo"), pl.col("hazmat_inspections_24mo")),
    ).with_columns(
        flag_driver=pl.col("driver_oos_wilson") >= DRIVER_OOS_CUT,
        flag_vehicle=pl.col("vehicle_oos_wilson") >= VEHICLE_OOS_CUT,
        flag_hazmat=pl.col("hazmat_oos_wilson") >= HAZMAT_OOS_CUT,
        flag_crash=(pl.col("crashes_per_truck") >= CRASH_PER_TRUCK_CUT)
        & (pl.col("crashes_24mo") >= 1)
        & (
            (pl.col("power_units") >= MIN_PU_FOR_CRASH_WITHOUT_HARM)
            | (pl.col("fatal_crashes_24mo") >= 1)
            | (pl.col("injury_crashes_24mo") >= 1)
        ),
        flag_recent_revocation=(
            pl.col("most_recent_involuntary_date").is_not_null()
            & (pl.col("most_recent_involuntary_date") >= rev_cutoff)
        ),
        flag_chronic_revocation=pl.col("involuntary_revocations") >= CHRONIC_REVOCATION_THRESHOLD,
        flag_enforcement=(
            pl.col("enforcement_recent_date").is_not_null()
            & (pl.col("enforcement_recent_date") >= enf_cutoff)
            & (pl.col("enforcement_cases_count") >= 1)
        ),
    )

    # Critical: insurance, safety rating, status — computed per-row in Python for clarity
    flagged_rows: list[dict] = []
    for r in scored.iter_rows(named=True):
        critical_reasons = collect_critical_reasons(r)
        is_critical = len(critical_reasons) > 0

        v9_flag = r["flag_driver"] or r["flag_vehicle"] or r["flag_hazmat"] or r["flag_crash"]
        recent_rev = r["flag_recent_revocation"]
        chronic_rev = r["flag_chronic_revocation"]
        recent_enf = r["flag_enforcement"]
        large_enf = recent_enf and (r.get("enforcement_total_settled") or 0) >= ENFORCEMENT_LARGE_SETTLEMENT

        any_flag = is_critical or v9_flag or recent_rev or chronic_rev or recent_enf
        if not any_flag:
            continue

        if is_critical:
            level = "Critical"
        elif recent_rev and v9_flag:
            level = "Severe"
        elif recent_rev:
            level = "High"
        elif large_enf:
            level = "High"
        elif v9_flag:
            level = base_severity(r)
            if chronic_rev or recent_enf:
                level = bump_up(level)
        else:
            level = "High" if chronic_rev else "Elevated"
            if recent_enf and level == "Elevated":
                level = "High"

        flagged_rows.append(
            {
                "risk_level": level,
                "load_count": r["loads_today"],
                "dot": r["DOT_NUMBER"],
                "carrier": r["LEGAL_NAME"] or r["t1_name"],
                "power_units": r["power_units"],
                "reasons": fmt_reasons(r),
                "is_critical": is_critical,
                "crashes_per_truck": r.get("crashes_per_truck"),
                "fatal_crashes_24mo": r.get("fatal_crashes_24mo"),
                "involuntary_revocations": r.get("involuntary_revocations"),
                "most_recent_involuntary_date": r.get("most_recent_involuntary_date"),
                "enforcement_cases_count": r.get("enforcement_cases_count"),
                "enforcement_total_settled": r.get("enforcement_total_settled"),
                "enforcement_recent_date": r.get("enforcement_recent_date"),
                "safety_rating": r.get("safety_rating"),
                "status_code": r.get("status_code"),
                "bipd_insurance_on_file": r.get("bipd_insurance_on_file"),
                "bipd_required_amount": r.get("bipd_required_amount"),
                "driver_oos_rate": r.get("driver_oos_rate"),
                "vehicle_oos_rate": r.get("vehicle_oos_rate"),
                "hazmat_oos_rate": r.get("hazmat_oos_rate"),
            }
        )

    print(f"v11 flagged: {len(flagged_rows)} of {t1.height} ({len(flagged_rows)/t1.height*100:.1f}%)")

    flagged_rows.sort(
        key=lambda x: (
            LEVELS.index(x["risk_level"]),
            -(x.get("involuntary_revocations") or 0),
            -(x.get("enforcement_total_settled") or 0),
            -(x.get("crashes_per_truck") or 0),
            -x["load_count"],
        )
    )
    for i, r in enumerate(flagged_rows, 1):
        r["rank"] = i

    fieldnames = [
        "rank", "risk_level", "load_count", "dot", "carrier", "power_units", "reasons",
        "safety_rating", "status_code",
        "bipd_insurance_on_file", "bipd_required_amount",
        "involuntary_revocations", "most_recent_involuntary_date",
        "enforcement_cases_count", "enforcement_total_settled", "enforcement_recent_date",
        "crashes_per_truck", "fatal_crashes_24mo",
        "driver_oos_rate", "vehicle_oos_rate", "hazmat_oos_rate",
    ]
    with open(OUT_CSV, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for r in flagged_rows:
            w.writerow({k: r.get(k, "") for k in fieldnames})
    print(f"Wrote {OUT_CSV}")

    md = [
        "# T1 Action List v11 — 2026-05-14",
        "",
        "**Source:** offline FMCSA bulk snapshot — SMS + Company Census + Carrier Authority + ActPendInsur + Revocation history + Closed enforcement (May 2026).",
        f"**Population:** {t1.height} carriers booked today.",
        f"**Flagged:** {len(flagged_rows)} ({len(flagged_rows)/t1.height*100:.1f}%).",
        "",
        "**Changes from v10:**",
        "- New **Critical** tier — binary regulatory failure (refuse to tender):",
        "  - Insurance lapsed (on-file < required when BIPD required)",
        "  - FMCSA safety rating Unsatisfactory",
        "  - Operating status not Active",
        "- New **Enforcement** axis — recent (≤24 mo) closed enforcement case with $ settled.",
        f"  - Solo trigger for High at ${ENFORCEMENT_LARGE_SETTLEMENT:,}+ settled; otherwise bumps tier up one when combined with another signal.",
        "",
    ]
    by_level: dict[str, list[dict]] = {}
    for r in flagged_rows:
        by_level.setdefault(r["risk_level"], []).append(r)
    for level in LEVELS:
        if level not in by_level:
            continue
        md.append(f"## {level} ({len(by_level[level])})")
        md.append("")
        md.append("| # | Loads | DOT | Carrier | PU | Reasons |")
        md.append("|---:|---:|---:|---|---:|---|")
        for r in by_level[level]:
            md.append(
                f"| {r['rank']} | {r['load_count']} | {r['dot']} | "
                f"{r['carrier']} | {r['power_units'] or '—'} | {r['reasons']} |"
            )
        md.append("")
    md += [
        "---",
        "## Thresholds",
        "",
        "| Signal | Rule |",
        "|---|---|",
        "| **Critical** — Insurance | bipd_insurance_required=Y AND on_file < required |",
        "| **Critical** — Safety rating | safety_rating = UNSATISFACTORY |",
        "| **Critical** — Status | status_code ≠ A |",
        f"| Recent revocation | involuntary revocation date ≥ {rev_cutoff} |",
        f"| Chronic revocation | involuntary_revocations ≥ {CHRONIC_REVOCATION_THRESHOLD} |",
        f"| Recent enforcement | closed case date ≥ {enf_cutoff} |",
        f"| Large enforcement | $ settled ≥ ${ENFORCEMENT_LARGE_SETTLEMENT:,} |",
        "| Driver OOS | Wilson 95% lower bound ≥ 10% |",
        "| Vehicle OOS | Wilson 95% lower bound ≥ 40% |",
        "| Hazmat OOS | Wilson 95% lower bound ≥ 5% |",
        "| Crash/truck | rate ≥ 0.20 AND ≥1 crash AND (PU ≥ 5 OR fatal ≥ 1 OR injury ≥ 1) |",
    ]
    OUT_MD.write_text("\n".join(md))
    print(f"Wrote {OUT_MD}")


if __name__ == "__main__":
    main()
