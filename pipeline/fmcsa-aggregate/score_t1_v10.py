# /// script
# requires-python = ">=3.11"
# dependencies = ["polars>=1.0"]
# ///
"""
v10 — adds recent-revocation rule on top of v9.

New rule:
  - Recent involuntary revocation (≤24 months) → auto-flag as High
    regardless of OOS/crash signals. Catches denominator-inflation cases
    (huge self-reported PU) and chameleon-style operators v9 missed.
  - Combined with any other v9 flag → Severe.
  - Multiple historical revocations (≥3 total) → push tier up by one
    (Elevated→High, High→Severe).

All v9 rules retained unchanged.

Outputs:
  - t1_action_list_v10.csv
  - t1_action_list_v10.md
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
OUT_CSV = T1_DIR / "t1_action_list_v10.csv"
OUT_MD = T1_DIR / "t1_action_list_v10.md"

DRIVER_OOS_CUT = 0.10
VEHICLE_OOS_CUT = 0.40
HAZMAT_OOS_CUT = 0.05
CRASH_PER_TRUCK_CUT = 0.20
MIN_PU_FOR_CRASH_WITHOUT_HARM = 5
Z_95 = 1.96

SNAPSHOT_DATE = date(2026, 5, 14)
RECENT_REVOCATION_WINDOW_DAYS = 730  # 24 months
CHRONIC_REVOCATION_THRESHOLD = 3

LEVELS = ("Severe", "High", "Elevated")


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


def parse_date(s: str | None) -> date | None:
    if not s:
        return None
    try:
        return date.fromisoformat(s[:10])
    except Exception:
        return None


def base_severity(row: dict) -> str:
    """v9 severity classification — used as starting point before revocation bump."""
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
    return "Severe"


def fmt_reasons(r: dict) -> str:
    bits: list[str] = []
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
    )

    cutoff = SNAPSHOT_DATE - timedelta(days=RECENT_REVOCATION_WINDOW_DAYS)
    cutoff_str = cutoff.isoformat()
    scored = scored.with_columns(
        flag_recent_revocation=(
            pl.col("most_recent_involuntary_date").is_not_null()
            & (pl.col("most_recent_involuntary_date") >= cutoff_str)
        ),
        flag_chronic_revocation=pl.col("involuntary_revocations") >= CHRONIC_REVOCATION_THRESHOLD,
    ).with_columns(
        any_flag=pl.col("flag_driver")
        | pl.col("flag_vehicle")
        | pl.col("flag_hazmat")
        | pl.col("flag_crash")
        | pl.col("flag_recent_revocation")
        | pl.col("flag_chronic_revocation"),
    )

    flagged = scored.filter(pl.col("any_flag"))
    print(f"v10 flagged: {flagged.height} of {t1.height} ({flagged.height/t1.height*100:.1f}%)")

    rows: list[dict] = []
    for r in flagged.iter_rows(named=True):
        v9_flag = r["flag_driver"] or r["flag_vehicle"] or r["flag_hazmat"] or r["flag_crash"]
        recent_rev = r["flag_recent_revocation"]
        chronic_rev = r["flag_chronic_revocation"]

        if recent_rev and v9_flag:
            level = "Severe"
        elif recent_rev:
            level = "High"
        elif v9_flag:
            level = base_severity(r)
            if chronic_rev:
                level = bump_up(level)
        else:
            # only chronic_rev hit, no v9 signals
            level = "High" if chronic_rev else "Elevated"

        rows.append(
            {
                "risk_level": level,
                "load_count": r["loads_today"],
                "dot": r["DOT_NUMBER"],
                "carrier": r["LEGAL_NAME"] or r["t1_name"],
                "power_units": r["power_units"],
                "reasons": fmt_reasons(r),
                "crashes_per_truck": r.get("crashes_per_truck"),
                "fatal_crashes_24mo": r.get("fatal_crashes_24mo"),
                "involuntary_revocations": r.get("involuntary_revocations"),
                "most_recent_involuntary_date": r.get("most_recent_involuntary_date"),
                "driver_oos_rate": r.get("driver_oos_rate"),
                "vehicle_oos_rate": r.get("vehicle_oos_rate"),
                "hazmat_oos_rate": r.get("hazmat_oos_rate"),
            }
        )

    rows.sort(
        key=lambda x: (
            LEVELS.index(x["risk_level"]),
            -(x.get("involuntary_revocations") or 0),
            -(x.get("crashes_per_truck") or 0),
            -x["load_count"],
        )
    )
    for i, r in enumerate(rows, 1):
        r["rank"] = i

    fieldnames = [
        "rank", "risk_level", "load_count", "dot", "carrier", "power_units", "reasons",
        "crashes_per_truck", "fatal_crashes_24mo",
        "involuntary_revocations", "most_recent_involuntary_date",
        "driver_oos_rate", "vehicle_oos_rate", "hazmat_oos_rate",
    ]
    with open(OUT_CSV, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, "") for k in fieldnames})
    print(f"Wrote {OUT_CSV}")

    md = [
        "# T1 Action List v10 — 2026-05-14",
        "",
        "**Source:** offline FMCSA SMS bulk snapshot + Revocation history (May 2026).",
        f"**Population:** {t1.height} carriers booked today.",
        f"**Flagged:** {len(rows)} ({len(rows)/t1.height*100:.1f}%).",
        "",
        "**Changes from v9:**",
        "- New rule: **Recent involuntary revocation (≤24 mo) → auto-flag High**, regardless of OOS/crash signals.",
        "- If recent revocation **AND** any v9 signal → **Severe**.",
        "- **Chronic** (≥3 historical involuntary revocations) bumps tier up one.",
        "",
    ]
    by_level: dict[str, list[dict]] = {}
    for r in rows:
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
        "| Driver OOS | Wilson 95% lower bound ≥ 10% |",
        "| Vehicle OOS | Wilson 95% lower bound ≥ 40% |",
        "| Hazmat OOS | Wilson 95% lower bound ≥ 5% |",
        "| Crash/truck | rate ≥ 0.20 AND ≥1 crash AND (PU ≥ 5 OR fatal ≥ 1 OR injury ≥ 1) |",
        f"| Recent revocation | involuntary revocation date ≥ {cutoff_str} |",
        f"| Chronic revocation | involuntary_revocations ≥ {CHRONIC_REVOCATION_THRESHOLD} |",
    ]
    OUT_MD.write_text("\n".join(md))
    print(f"Wrote {OUT_MD}")


if __name__ == "__main__":
    main()
