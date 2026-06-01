# /// script
# requires-python = ">=3.11"
# dependencies = ["polars>=1.0"]
# ///
"""
Fold FMCSA Revocation - All With History into the parquet.

New columns added to carrier_aggregates.parquet:
  - revocations_total         (int)  : all revocation events (involuntary + voluntary + admin)
  - involuntary_revocations   (int)  : FMCSA-issued involuntary revocations
  - voluntary_revocations     (int)  : carrier-surrendered
  - most_recent_revocation_date (str): YYYY-MM-DD of latest revocation of any type
  - most_recent_involuntary_date(str): YYYY-MM-DD of latest involuntary specifically
  - revoked_license_types     (str)  : distinct TYPE_LICENSE values (COMMON, CONTRACT, BROKER)

Also writes a T1 cross-reference: which booked carriers have prior revocations?
"""

from __future__ import annotations

import csv
import json
import os
from pathlib import Path

import polars as pl

HERE = Path(__file__).parent
T1_DIR = HERE.parent / "t1-fmcsa-2026-05-14"
REV_CSV = Path(os.environ.get("FMCSA_REVOCATION", "/Users/art/Downloads/Revocation_-_All_With_History_20260514.csv"))
PARQUET = Path(os.environ.get("FMCSA_PARQUET", HERE / "carrier_aggregates.parquet"))
CARRIERS_JSON = T1_DIR / "carriers.json"
T1_OUT_CSV = T1_DIR / "revocations_t1.csv"
T1_OUT_MD = T1_DIR / "revocations_t1.md"


def parse_us_date(col: str) -> pl.Expr:
    """Parse MM/DD/YYYY into YYYY-MM-DD string. Returns null on parse failure."""
    return (
        pl.col(col)
        .str.strptime(pl.Date, format="%m/%d/%Y", strict=False)
        .dt.strftime("%Y-%m-%d")
    )


def main() -> None:
    print(f"Scanning revocation file: {REV_CSV.name}")
    rev = (
        pl.scan_csv(REV_CSV, ignore_errors=True)
        .with_columns(
            DOT_NUMBER=pl.col("DOT_NUMBER").cast(pl.Int64, strict=False),
            serve_date=parse_us_date("ORDER1_SERVE_DATE"),
            effective_date=parse_us_date("order2_effective_Date"),
        )
        .filter(pl.col("DOT_NUMBER").is_not_null() & (pl.col("DOT_NUMBER") != 0))
        .collect(engine="streaming")
    )
    print(f"Revocation rows with valid USDOT: {rev.height:,}")
    print(f"Unique DOTs with at least one revocation: {rev['DOT_NUMBER'].n_unique():,}")

    is_involuntary = pl.col("ORDER2_TYPE_DESC") == "INVOLUNTARY REVOCATION"
    is_voluntary = pl.col("ORDER2_TYPE_DESC") == "VOLUNTARY REVOCATION"

    agg = (
        rev.group_by("DOT_NUMBER")
        .agg(
            revocations_total=pl.len(),
            involuntary_revocations=is_involuntary.sum(),
            voluntary_revocations=is_voluntary.sum(),
            most_recent_revocation_date=pl.col("effective_date").max(),
            most_recent_involuntary_date=pl.col("effective_date").filter(is_involuntary).max(),
            revoked_license_types=pl.col("TYPE_LICENSE").drop_nulls().unique().str.join(","),
        )
    )
    print(f"Aggregated per-DOT: {agg.height:,} rows")

    pq = pl.read_parquet(PARQUET)
    print(f"Parquet before merge: {pq.height:,} x {pq.width}")

    for col in agg.columns:
        if col != "DOT_NUMBER" and col in pq.columns:
            pq = pq.drop(col)

    merged = pq.join(agg, on="DOT_NUMBER", how="left").with_columns(
        revocations_total=pl.col("revocations_total").fill_null(0),
        involuntary_revocations=pl.col("involuntary_revocations").fill_null(0),
        voluntary_revocations=pl.col("voluntary_revocations").fill_null(0),
    )
    print(f"Parquet after merge: {merged.height:,} x {merged.width}")
    merged.write_parquet(PARQUET, compression="zstd")
    print(f"Wrote {PARQUET}")

    # T1 cross-reference — legacy diagnostic output (CSV/MD of booked T1 carriers
    # with revocation history). Optional; skip when the T1 carriers.json isn't
    # present (e.g. a fresh rebuild that didn't run the old T1 scoring step).
    if not CARRIERS_JSON.exists():
        print("(skipping legacy T1 cross-reference — carriers.json not present)")
        return
    t1 = json.loads(CARRIERS_JSON.read_text())
    t1_dots = {int(c["dotNumber"]): c["name"] for c in t1}
    t1_loads = {int(c["dotNumber"]): c["loadsToday"] for c in t1}

    t1_hits = merged.filter(
        pl.col("DOT_NUMBER").is_in(list(t1_dots.keys()))
        & (pl.col("revocations_total") > 0)
    ).sort(
        ["involuntary_revocations", "most_recent_revocation_date"],
        descending=[True, True],
    )

    rows: list[dict] = []
    for r in t1_hits.iter_rows(named=True):
        rows.append({
            "dot": r["DOT_NUMBER"],
            "carrier": r["LEGAL_NAME"],
            "loads_today": t1_loads.get(r["DOT_NUMBER"], 0),
            "total_revocations": r["revocations_total"],
            "involuntary": r["involuntary_revocations"],
            "voluntary": r["voluntary_revocations"],
            "most_recent_date": r["most_recent_revocation_date"],
            "most_recent_involuntary": r["most_recent_involuntary_date"],
            "license_types": r["revoked_license_types"],
            "current_pu": r["power_units"],
            "crashes_24mo": r["crashes_24mo"],
        })

    print(f"\n=== T1 carriers with revocation history: {len(rows)} of {len(t1_dots)} ===")
    fieldnames = ["dot", "carrier", "loads_today", "total_revocations", "involuntary",
                  "voluntary", "most_recent_date", "most_recent_involuntary",
                  "license_types", "current_pu", "crashes_24mo"]
    with open(T1_OUT_CSV, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for r in rows:
            w.writerow(r)
    print(f"Wrote {T1_OUT_CSV}")

    # MD
    md = [
        "# T1 — FMCSA Revocation History Cross-Reference",
        "",
        f"**Source:** Revocation_-_All_With_History_20260514.csv ({rev['DOT_NUMBER'].n_unique():,} unique DOTs with at least one revocation event)",
        f"**T1 carriers booked today:** {len(t1_dots)}",
        f"**T1 carriers with prior revocation history:** {len(rows)}",
        "",
        "Note: A revocation in this table means the carrier's authority was previously revoked — but they are *currently operating*, so they must have been reinstated (or paid the fine, or had a new docket issued). A history of **involuntary revocations** is a significant fraud/compliance signal.",
        "",
        "| Loads | DOT | Carrier | Involuntary | Voluntary | Most Recent Inv. | Types | Current PU | Crashes 24mo |",
        "|---:|---:|---|---:|---:|---|---|---:|---:|",
    ]
    for r in rows:
        md.append(
            f"| {r['loads_today']} | {r['dot']} | {r['carrier']} | "
            f"{r['involuntary']} | {r['voluntary']} | {r['most_recent_involuntary'] or '—'} | "
            f"{r['license_types']} | {r['current_pu'] or '—'} | {r['crashes_24mo']} |"
        )
    T1_OUT_MD.write_text("\n".join(md))
    print(f"Wrote {T1_OUT_MD}")


if __name__ == "__main__":
    main()
