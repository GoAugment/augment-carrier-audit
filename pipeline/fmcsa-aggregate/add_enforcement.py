# /// script
# requires-python = ">=3.11"
# dependencies = ["polars>=1.0", "fastexcel"]
# ///
"""
Add FMCSA closed enforcement case aggregates to the parquet, and produce a T1
cross-reference report.

Inputs:
  - closed_enforcement_cases_20260515005306.xlsx (~211 rows of settled cases)

Adds these columns to carrier_aggregates.parquet:
  - enforcement_cases_count   (int): # of closed enforcement cases in the file
  - enforcement_total_settled (int): sum of $ settled
  - enforcement_recent_date   (str): most recent case close date (YYYY-MM-DD)
  - enforcement_violations    (str): semicolon-joined unique violation codes
"""

from __future__ import annotations

import csv
import json
import os
from pathlib import Path

import polars as pl

# Repo-relative: HERE is pipeline/fmcsa-aggregate/, so this used to read and
# write a parquet INSIDE the pipeline dir rather than data/.
REPO = Path(__file__).resolve().parents[2]

HERE = Path(__file__).parent
T1_DIR = HERE.parent / "t1-fmcsa-2026-05-14"
ENF_XLSX = Path(os.environ.get("FMCSA_ENFORCEMENT_XLSX", "/__unset__run-via-build_all.py-or-set-the-env-var__/closed_enforcement_cases_20260515005306.xlsx"))
PARQUET = Path(os.environ.get("FMCSA_PARQUET", REPO / "data" / "carrier_aggregates.parquet"))
CARRIERS_JSON = T1_DIR / "carriers.json"
T1_OUT_CSV = T1_DIR / "enforcement_t1.csv"
T1_OUT_MD = T1_DIR / "enforcement_t1.md"


def load_enforcement() -> pl.DataFrame:
    # File has its real header on row 2 (row 1 has descriptive labels).
    # Read with header_row=1 (0-indexed) so the second row becomes headers.
    raw = pl.read_excel(ENF_XLSX, read_options={"header_row": 1})
    # Standardize column names
    rename_map = {c: c.strip().replace("U.S.DOT#", "DOT").replace(" ", "_") for c in raw.columns}
    raw = raw.rename(rename_map)
    print(f"Enforcement rows: {raw.height}, columns: {raw.columns}")

    # Cast DOT to Int64 (skip non-numeric rows) and $ to int
    df = (
        raw
        .with_columns(
            DOT=pl.col("DOT").cast(pl.Int64, strict=False),
            Total_Amount_Settled=pl.col("Total_Amount_Settled").cast(pl.Float64, strict=False).cast(pl.Int64),
            Closed_Date=pl.col("Closed_Date").cast(pl.Utf8).str.head(10),  # "YYYY-MM-DD..."
        )
        .filter(pl.col("DOT").is_not_null())
    )
    print(f"After cleaning: {df.height} rows with valid DOT")
    return df


def aggregate_by_dot(df: pl.DataFrame) -> pl.DataFrame:
    return (
        df.group_by("DOT")
        .agg(
            enforcement_cases_count=pl.len(),
            enforcement_total_settled=pl.col("Total_Amount_Settled").sum(),
            enforcement_recent_date=pl.col("Closed_Date").max(),
            enforcement_violations=pl.col("Violation_Code").drop_nulls().unique().str.join("; "),
        )
        .rename({"DOT": "DOT_NUMBER"})
    )


def main() -> None:
    enf_raw = load_enforcement()
    enf = aggregate_by_dot(enf_raw)
    print(f"\nUnique DOTs with enforcement cases: {enf.height}")
    print(enf.sort("enforcement_total_settled", descending=True).head(5))

    # Join into parquet
    pq = pl.read_parquet(PARQUET)
    print(f"\nParquet: {pq.height:,} carriers, {pq.width} columns")

    # Drop columns if they already exist (re-run safety)
    for col in ("enforcement_cases_count", "enforcement_total_settled",
                "enforcement_recent_date", "enforcement_violations"):
        if col in pq.columns:
            pq = pq.drop(col)

    merged = pq.join(enf, on="DOT_NUMBER", how="left").with_columns(
        enforcement_cases_count=pl.col("enforcement_cases_count").fill_null(0),
        enforcement_total_settled=pl.col("enforcement_total_settled").fill_null(0),
    )
    print(f"After merge: {merged.height:,} x {merged.width}")

    merged.write_parquet(PARQUET, compression="zstd")
    print(f"Wrote {PARQUET}")

    # T1 cross-reference — legacy diagnostic; skip when carriers.json isn't present.
    if not CARRIERS_JSON.exists():
        print("(skipping legacy T1 cross-reference — carriers.json not present)")
        return
    t1 = json.loads(CARRIERS_JSON.read_text())
    t1_dots = {int(c["dotNumber"]): c["name"] for c in t1}
    t1_loads = {int(c["dotNumber"]): c["loadsToday"] for c in t1}

    t1_hits = merged.filter(
        (pl.col("DOT_NUMBER").is_in(list(t1_dots.keys())))
        & (pl.col("enforcement_cases_count") > 0)
    ).sort("enforcement_total_settled", descending=True)

    print(f"\n=== T1 carriers with enforcement cases: {t1_hits.height} ===")

    rows = []
    for r in t1_hits.iter_rows(named=True):
        rows.append(
            {
                "dot": r["DOT_NUMBER"],
                "carrier": r["LEGAL_NAME"],
                "loads_today": t1_loads.get(r["DOT_NUMBER"], 0),
                "cases": r["enforcement_cases_count"],
                "total_settled": r["enforcement_total_settled"],
                "most_recent_date": r["enforcement_recent_date"],
                "violation_codes": r["enforcement_violations"],
                "crashes_24mo": r["crashes_24mo"],
                "fatal_crashes_24mo": r["fatal_crashes_24mo"],
                "driver_oos_rate": round((r.get("driver_oos_rate") or 0), 3),
                "vehicle_oos_rate": round((r.get("vehicle_oos_rate") or 0), 3),
            }
        )

    fieldnames = ["dot", "carrier", "loads_today", "cases", "total_settled",
                  "most_recent_date", "violation_codes", "crashes_24mo",
                  "fatal_crashes_24mo", "driver_oos_rate", "vehicle_oos_rate"]
    with open(T1_OUT_CSV, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for r in rows:
            w.writerow(r)
    print(f"Wrote {T1_OUT_CSV}")

    # MD
    md = [
        "# T1 — FMCSA Enforcement Cases Cross-Reference",
        "",
        f"**Source:** closed_enforcement_cases_20260515005306.xlsx ({enf.height} unique DOTs with closed cases).",
        f"**T1 carriers booked today:** {len(t1_dots)}",
        f"**T1 carriers with closed enforcement cases in this snapshot:** {len(rows)}",
        "",
        "| Loads | DOT | Carrier | Cases | $ Settled | Most Recent | Violation codes | Crashes 24mo | Fatal | Driver OOS | Vehicle OOS |",
        "|---:|---:|---|---:|---:|---|---|---:|---:|---:|---:|",
    ]
    for r in rows:
        md.append(
            f"| {r['loads_today']} | {r['dot']} | {r['carrier']} | "
            f"{r['cases']} | ${r['total_settled']:,} | {r['most_recent_date']} | "
            f"{r['violation_codes']} | {r['crashes_24mo']} | {r['fatal_crashes_24mo']} | "
            f"{r['driver_oos_rate']*100:.0f}% | {r['vehicle_oos_rate']*100:.0f}% |"
        )
    md.append("")
    md.append("**Notes:**")
    md.append("- Violation codes follow CFR 49 format. Common ones:")
    md.append("  - `382.x` — drug & alcohol testing (carrier-level)")
    md.append("  - `383.x` — CDL standards (driver licensure)")
    md.append("  - `391.x` — driver qualification files")
    md.append("  - `395.x` — hours of service (driver logs)")
    md.append("  - `396.x` — vehicle maintenance/inspection")
    md.append("- This file is a snapshot of recently-closed cases, not the carrier's full history.")
    T1_OUT_MD.write_text("\n".join(md))
    print(f"Wrote {T1_OUT_MD}")


if __name__ == "__main__":
    main()
