# /// script
# requires-python = ">=3.11"
# dependencies = ["polars>=1.0"]
# ///
"""
v9 — Wilson 95% CI for OOS rates; PU>=5 OR fatal/injury crash for crash flagging.

Rules:
  - Driver OOS:  Wilson95-lower(driver_oos/driver_insp)  >= 0.10
  - Vehicle OOS: Wilson95-lower(vehicle_oos/vehicle_insp) >= 0.40
  - Hazmat OOS:  Wilson95-lower(hazmat_oos/hazmat_insp)  >= 0.05
  - Crash:       crashes_per_truck >= 0.20  AND  crashes >= 1
                 AND (power_units >= 5 OR fatal_crashes >= 1 OR injury_crashes >= 1)

Outputs:
  - t1_action_list_v9.csv
  - t1_action_list_v9.md
"""

from __future__ import annotations

import csv
import json
import math
from pathlib import Path

import polars as pl

HERE = Path(__file__).parent
PARQUET = HERE / "carrier_aggregates.parquet"
T1_DIR = HERE.parent / "t1-fmcsa-2026-05-14"
CARRIERS_JSON = T1_DIR / "carriers.json"
OUT_CSV = T1_DIR / "t1_action_list_v9.csv"
OUT_MD = T1_DIR / "t1_action_list_v9.md"

DRIVER_OOS_CUT = 0.10
VEHICLE_OOS_CUT = 0.40
HAZMAT_OOS_CUT = 0.05
CRASH_PER_TRUCK_CUT = 0.20
MIN_PU_FOR_CRASH_WITHOUT_HARM = 5
Z_95 = 1.96


def wilson_lower(k_expr: pl.Expr, n_expr: pl.Expr, z: float = Z_95) -> pl.Expr:
    """Wilson score interval, lower bound, for proportion k/n at confidence z.

    Formula:
       p_hat = k / n
       denom = 1 + z^2 / n
       center = p_hat + z^2 / (2n)
       margin = z * sqrt(p_hat*(1-p_hat)/n + z^2/(4n^2))
       lower = (center - margin) / denom
    Returns null when n == 0.
    """
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


def severity_label(row: dict) -> str:
    """Pick severity label based on the worst signal."""
    if row["flag_crash"]:
        if row["crashes_per_truck"] >= 0.40 or row["fatal_crashes_24mo"] >= 1:
            return "Severe"
        if row["crashes_per_truck"] >= 0.30:
            return "High"
    if row["flag_driver"] and row["driver_oos_rate"] >= 0.30:
        return "High"
    if row["flag_hazmat"] and row["hazmat_oos_rate"] >= 0.15:
        return "High"
    return "Elevated"


def fmt_reasons(r: dict) -> str:
    bits: list[str] = []
    if r["flag_crash"]:
        bits.append(
            f"Crashes: {r['crashes_per_truck']:.2f}/truck — "
            f"{r['crashes_24mo']} on {r['power_units']} PU "
            f"({r['fatal_crashes_24mo']} fatal, {r['injury_crashes_24mo']} injury, {r['tow_crashes_24mo']} tow)"
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
    ).with_columns(
        any_flag=pl.col("flag_driver") | pl.col("flag_vehicle") | pl.col("flag_hazmat") | pl.col("flag_crash"),
    )

    flagged = scored.filter(pl.col("any_flag"))
    print(f"v9 flagged: {flagged.height} of {t1.height} ({flagged.height/t1.height*100:.1f}%)")

    rows: list[dict] = []
    for r in flagged.iter_rows(named=True):
        label = severity_label(r)
        rows.append(
            {
                "risk_level": label,
                "load_count": r["loads_today"],
                "dot": r["DOT_NUMBER"],
                "carrier": r["LEGAL_NAME"] or r["t1_name"],
                "power_units": r["power_units"],
                "fleet_size_flag": r["fleet_size_flag"],
                "reasons": fmt_reasons(r),
                # raw fields for downstream consumers
                "crashes_per_truck": r.get("crashes_per_truck"),
                "fatal_crashes_24mo": r.get("fatal_crashes_24mo"),
                "injury_crashes_24mo": r.get("injury_crashes_24mo"),
                "driver_oos_rate": r.get("driver_oos_rate"),
                "driver_oos_wilson": r.get("driver_oos_wilson"),
                "vehicle_oos_rate": r.get("vehicle_oos_rate"),
                "vehicle_oos_wilson": r.get("vehicle_oos_wilson"),
                "hazmat_oos_rate": r.get("hazmat_oos_rate"),
                "hazmat_oos_wilson": r.get("hazmat_oos_wilson"),
            }
        )

    rows.sort(
        key=lambda x: (
            {"Severe": 0, "High": 1, "Elevated": 2}[x["risk_level"]],
            -(x.get("crashes_per_truck") or 0),
            -(x.get("driver_oos_wilson") or 0),
            -x["load_count"],
        )
    )
    for i, r in enumerate(rows, 1):
        r["rank"] = i

    # CSV
    fieldnames = [
        "rank", "risk_level", "load_count", "dot", "carrier",
        "power_units", "fleet_size_flag", "reasons",
        "crashes_per_truck", "fatal_crashes_24mo", "injury_crashes_24mo",
        "driver_oos_rate", "driver_oos_wilson",
        "vehicle_oos_rate", "vehicle_oos_wilson",
        "hazmat_oos_rate", "hazmat_oos_wilson",
    ]
    with open(OUT_CSV, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, "") for k in fieldnames})
    print(f"Wrote {OUT_CSV}")

    # MD
    md = [
        "# T1 Action List v9 — 2026-05-14",
        "",
        "**Source:** offline FMCSA SMS bulk snapshot (May 2026).",
        f"**Population:** {t1.height} carriers booked today.",
        f"**Flagged:** {len(rows)} ({len(rows)/t1.height*100:.1f}%).",
        "",
        "**Methodology changes from v8:**",
        "- OOS rates use **Wilson 95% lower confidence bound** (not point estimate) — eliminates small-sample false positives.",
        "- Crash flag requires **PU ≥ 5 OR fatal/injury crash** — tow-only crashes on tiny fleets are no longer flagged as unlucky one-offs.",
        "",
    ]
    by_level: dict[str, list[dict]] = {}
    for r in rows:
        by_level.setdefault(r["risk_level"], []).append(r)
    for level in ("Severe", "High", "Elevated"):
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
    ]
    OUT_MD.write_text("\n".join(md))
    print(f"Wrote {OUT_MD}")


if __name__ == "__main__":
    main()
