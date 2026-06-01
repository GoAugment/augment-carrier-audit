# /// script
# requires-python = ">=3.11"
# dependencies = ["polars>=1.0"]
# ///
"""
Score T1's booked carriers using the offline parquet (replaces v7 API-based output).

Outputs:
  - t1-fmcsa-2026-05-14/t1_action_list_v8.csv
  - t1-fmcsa-2026-05-14/t1_action_list_v8.md
"""

from __future__ import annotations

import csv
import json
from pathlib import Path

import polars as pl

HERE = Path(__file__).parent
PARQUET = HERE / "carrier_aggregates.parquet"
T1_DIR = HERE.parent / "t1-fmcsa-2026-05-14"
CARRIERS_JSON = T1_DIR / "carriers.json"
LOADS_JSON = T1_DIR / "loads_today.json"

OUT_CSV = T1_DIR / "t1_action_list_v8.csv"
OUT_MD = T1_DIR / "t1_action_list_v8.md"

DRIVER_OOS_CUT = 0.10
VEHICLE_OOS_CUT = 0.40
HAZMAT_OOS_CUT = 0.05
CRASH_PER_TRUCK_CUT = 0.20

MIN_INSP = 3
MIN_PU = 1


def severity(row: dict) -> tuple[str, int]:
    """Return (label, sort_key). Higher sort_key = more severe."""
    score = 0
    label = "Elevated"
    if row["flag_crash"] and row["crashes_per_truck"] >= 0.40:
        score = 4
        label = "Severe"
    elif row["flag_crash"] and row["crashes_per_truck"] >= 0.30:
        score = 3
        label = "High"
    elif row["flag_driver"] and row["driver_oos_rate"] >= 0.30:
        score = 3
        label = "High"
    elif row["flag_hazmat"] and row["hazmat_oos_rate"] >= 0.15:
        score = 3
        label = "High"
    else:
        score = 1
        label = "Elevated"
    return label, score


def fmt_reason(row: dict) -> str:
    bits: list[str] = []
    if row["flag_crash"]:
        bits.append(
            f"Crashes: {row['crashes_per_truck']:.2f}/truck (cutoff {CRASH_PER_TRUCK_CUT}) — "
            f"{row['crashes_24mo']} on {row['power_units']} PU "
            f"({row['fatal_crashes_24mo']} fatal, {row['injury_crashes_24mo']} injury, {row['tow_crashes_24mo']} tow)"
        )
    if row["flag_driver"]:
        bits.append(
            f"Driver OOS: {row['driver_oos_rate']*100:.0f}% (cutoff 10%) — "
            f"{row['driver_oos_24mo']} of {row['driver_inspections_24mo']} inspections"
        )
    if row["flag_vehicle"]:
        bits.append(
            f"Vehicle OOS: {row['vehicle_oos_rate']*100:.0f}% (cutoff 40%) — "
            f"{row['vehicle_oos_24mo']} of {row['vehicle_inspections_24mo']} inspections"
        )
    if row["flag_hazmat"]:
        bits.append(
            f"Hazmat OOS: {row['hazmat_oos_rate']*100:.0f}% (cutoff 5%) — "
            f"{row['hazmat_oos_24mo']} of {row['hazmat_inspections_24mo']} inspections"
        )
    return "; ".join(bits)


def load_t1() -> pl.DataFrame:
    t1 = json.loads(CARRIERS_JSON.read_text())
    return pl.DataFrame(
        [
            {
                "DOT_NUMBER": int(c["dotNumber"]),
                "loads_today": c["loadsToday"],
                "t1_name": c["name"],
                "mc_number": c.get("mcNumber"),
            }
            for c in t1
        ]
    )


def load_t1_loads_by_dot() -> dict[int, list[str]]:
    """Map DOT -> list of load IDs booked today, if loads_today.json exists."""
    if not LOADS_JSON.exists():
        return {}
    loads = json.loads(LOADS_JSON.read_text())
    out: dict[int, list[str]] = {}
    for ld in loads:
        try:
            dot = int(ld.get("carrier", {}).get("dotNumber") or ld.get("dotNumber") or 0)
            lid = str(ld.get("id") or ld.get("loadId") or "")
            if dot and lid:
                out.setdefault(dot, []).append(lid)
        except Exception:
            continue
    return out


def main() -> None:
    t1 = load_t1()
    print(f"T1 carriers: {t1.height}")
    pq = pl.read_parquet(PARQUET)

    joined = t1.join(pq, on="DOT_NUMBER", how="left")

    scored = joined.with_columns(
        flag_driver=(pl.col("driver_oos_rate") >= DRIVER_OOS_CUT)
        & (pl.col("driver_inspections_24mo") >= MIN_INSP),
        flag_vehicle=(pl.col("vehicle_oos_rate") >= VEHICLE_OOS_CUT)
        & (pl.col("vehicle_inspections_24mo") >= MIN_INSP),
        flag_hazmat=(pl.col("hazmat_oos_rate") >= HAZMAT_OOS_CUT)
        & (pl.col("hazmat_inspections_24mo") >= MIN_INSP),
        flag_crash=(pl.col("crashes_per_truck") >= CRASH_PER_TRUCK_CUT)
        & (pl.col("power_units") >= MIN_PU)
        & (pl.col("crashes_24mo") >= 1),
    ).with_columns(
        any_flag=pl.col("flag_driver") | pl.col("flag_vehicle") | pl.col("flag_hazmat") | pl.col("flag_crash"),
    )

    flagged = scored.filter(pl.col("any_flag"))
    print(f"Flagged: {flagged.height} of {t1.height} ({flagged.height/t1.height*100:.1f}%)")

    loads_by_dot = load_t1_loads_by_dot()

    rows: list[dict] = []
    for r in flagged.iter_rows(named=True):
        label, score = severity(r)
        load_ids = loads_by_dot.get(r["DOT_NUMBER"], [])
        rows.append(
            {
                "risk_level": label,
                "severity_score": score,
                "load_count": r["loads_today"],
                "load_ids": ";".join(load_ids) if load_ids else "",
                "dot": r["DOT_NUMBER"],
                "carrier": r["LEGAL_NAME"] or r["t1_name"],
                "power_units": r["power_units"],
                "fleet_size_flag": r["fleet_size_flag"],
                "inspections_per_pu": round(r["inspections_per_pu"], 2) if r["inspections_per_pu"] is not None else None,
                "crashes_per_inspection": round(r["crashes_per_inspection"], 3) if r["crashes_per_inspection"] is not None else None,
                "reasons": fmt_reason(r),
            }
        )

    # Sort: Severe > High > Elevated, then by severity within bands using crash rate / driver OOS
    rows.sort(
        key=lambda x: (
            {"Severe": 0, "High": 1, "Elevated": 2}[x["risk_level"]],
            -(x.get("severity_score") or 0),
            -x["load_count"],
        )
    )
    for i, r in enumerate(rows, 1):
        r["rank"] = i

    # CSV output
    fieldnames = [
        "rank", "risk_level", "load_count", "load_ids", "dot", "carrier",
        "power_units", "fleet_size_flag", "inspections_per_pu", "crashes_per_inspection",
        "reasons",
    ]
    with open(OUT_CSV, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for r in rows:
            writer.writerow({k: r.get(k, "") for k in fieldnames})
    print(f"Wrote {OUT_CSV}")

    # MD output
    md = ["# T1 Action List v8 — 2026-05-14", "",
          "**Source:** offline FMCSA SMS bulk snapshot (May 2026); thresholds 10/40/5/0.20.",
          f"**Population:** {t1.height} carriers booked today.",
          f"**Flagged:** {len(rows)} ({len(rows)/t1.height*100:.1f}%).",
          ""]
    by_level: dict[str, list[dict]] = {}
    for r in rows:
        by_level.setdefault(r["risk_level"], []).append(r)
    for level in ("Severe", "High", "Elevated"):
        if level not in by_level:
            continue
        md.append(f"## {level} ({len(by_level[level])})")
        md.append("")
        md.append("| # | Loads | DOT | Carrier | PU | Fleet check | Reasons |")
        md.append("|---:|---:|---:|---|---:|---|---|")
        for r in by_level[level]:
            fleet_note = r["fleet_size_flag"]
            if r["fleet_size_flag"] == "low-activity":
                fleet_note = f"⚠ low-activity ({r['inspections_per_pu']} insp/PU)"
            md.append(
                f"| {r['rank']} | {r['load_count']} | {r['dot']} | "
                f"{r['carrier']} | {r['power_units'] or '—'} | {fleet_note} | {r['reasons']} |"
            )
        md.append("")

    md.append("---")
    md.append("## Methodology")
    md.append("")
    md.append("- Cutoffs: Driver OOS ≥10%, Vehicle OOS ≥40%, Hazmat OOS ≥5%, Crash-per-truck ≥0.20.")
    md.append("- Sufficiency: minimum 3 inspections (driver/vehicle/hazmat). PU ≥1 and ≥1 crash for crash flag.")
    md.append("- **Fleet check column** (`low-activity`): carrier reports ≥5 power units but had <1 inspection per PU over 24 months — self-reported fleet may be inflated. Treat crashes-per-truck as a potentially-understated number for these carriers.")
    md.append("- Source: SMS Input bulk files (Census, PassProperty, Crash, Inspection) — see `.context/fmcsa-aggregate/methodology.md`.")

    OUT_MD.write_text("\n".join(md))
    print(f"Wrote {OUT_MD}")


if __name__ == "__main__":
    main()
