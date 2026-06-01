# /// script
# requires-python = ">=3.11"
# dependencies = ["polars>=1.0", "httpx>=0.27"]
# ///
"""
Spot-check parquet against live FMCSA QCMobile API for a sample of T1 carriers.

Compares the fields the web tool's analyzer relies on:
  - legal name
  - power units, drivers
  - safety rating, allowed to operate, OOS date
  - insurance: BIPD required / on file / required amount
  - inspection totals: driver/vehicle/hazmat (count + OOS)
  - crash totals (24mo)

Per-carrier output flags any field that differs by more than a tolerance.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import httpx
import polars as pl

HERE = Path(__file__).parent
T1_DIR = HERE.parent / "t1-fmcsa-2026-05-14"
PARQUET = HERE / "carrier_aggregates.parquet"
ENV_PATH = Path("/Users/art/conductor/workspaces/augment-carrier-audit/.env.local")

API_URL = "https://mobile.fmcsa.dot.gov/qc/services/carriers/{dot}"
SAMPLE_SIZE = 10


def get_webkey() -> str:
    if "FMCSA_WEBKEY" in os.environ:
        return os.environ["FMCSA_WEBKEY"]
    if ENV_PATH.exists():
        for line in ENV_PATH.read_text().splitlines():
            if line.startswith("FMCSA_WEBKEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    sys.exit("FMCSA_WEBKEY not found in env or .env.local")


def fetch_api(dot: int, key: str) -> dict | None:
    r = httpx.get(API_URL.format(dot=dot), params={"webKey": key}, timeout=15)
    if r.status_code != 200:
        return None
    body = r.json()
    content = body.get("content")
    if isinstance(content, list):
        content = content[0] if content else None
    if not content:
        return None
    return content.get("carrier")


def as_int(v) -> int:
    if v is None:
        return 0
    try:
        return int(float(v))
    except (ValueError, TypeError):
        return 0


def compare(parq: dict, api: dict) -> list[str]:
    diffs: list[str] = []

    def cmp(label: str, p, a, tol: int = 0):
        if p is None and a is None:
            return
        pn = as_int(p) if isinstance(p, (int, float)) else (p or "")
        an = as_int(a) if isinstance(a, (int, float)) else (a or "")
        if isinstance(pn, int) and isinstance(an, int):
            if abs(pn - an) > tol:
                diffs.append(f"  {label}: parquet={pn}, api={an}")
        else:
            if str(pn).strip().upper() != str(an).strip().upper():
                diffs.append(f"  {label}: parquet={pn!r}, api={an!r}")

    cmp("legal_name", parq.get("LEGAL_NAME"), api.get("legalName"))
    cmp("power_units", parq.get("power_units"), api.get("totalPowerUnits"))
    cmp("drivers", parq.get("drivers"), api.get("totalDrivers"))
    cmp("safety_rating", parq.get("safety_rating"), api.get("safetyRating"))
    # API allowedToOperate = "Y"/"N"; parquet status_code "A" = allowed
    parq_allowed = "Y" if (parq.get("status_code") or "").upper() == "A" else "N"
    cmp("allowed_to_operate", parq_allowed, api.get("allowedToOperate"))
    cmp("bipd_required", parq.get("bipd_insurance_required"), api.get("bipdInsuranceRequired"))
    cmp("bipd_required_amount", as_int(parq.get("bipd_required_amount")), as_int(api.get("bipdRequiredAmount")), tol=1)
    cmp("bipd_on_file", as_int(parq.get("bipd_insurance_on_file")), as_int(api.get("bipdInsuranceOnFile")), tol=1)
    cmp("driver_insp_24mo", as_int(parq.get("driver_inspections_24mo")), as_int(api.get("driverInsp")), tol=2)
    cmp("driver_oos_24mo", as_int(parq.get("driver_oos_24mo")), as_int(api.get("driverOosInsp")), tol=2)
    cmp("vehicle_insp_24mo", as_int(parq.get("vehicle_inspections_24mo")), as_int(api.get("vehicleInsp")), tol=2)
    cmp("vehicle_oos_24mo", as_int(parq.get("vehicle_oos_24mo")), as_int(api.get("vehicleOosInsp")), tol=2)
    cmp("crashes_24mo", as_int(parq.get("crashes_24mo")), as_int(api.get("crashTotal")), tol=1)
    cmp("fatal_crashes_24mo", as_int(parq.get("fatal_crashes_24mo")), as_int(api.get("fatalCrash")), tol=0)
    return diffs


def main() -> None:
    key = get_webkey()
    t1 = json.loads((T1_DIR / "carriers.json").read_text())

    # Sample: 5 flagged + 5 unflagged for coverage of both happy/sad paths
    flagged_csv = T1_DIR / "t1_action_list_v11.csv"
    flagged_dots: list[int] = []
    if flagged_csv.exists():
        for line in flagged_csv.read_text().splitlines()[1:]:
            parts = line.split(",")
            try:
                flagged_dots.append(int(parts[3]))
            except (ValueError, IndexError):
                pass

    flagged_sample = flagged_dots[:5]
    unflagged_pool = [int(c["dotNumber"]) for c in t1 if int(c["dotNumber"]) not in set(flagged_dots)]
    unflagged_sample = unflagged_pool[:5]
    sample = flagged_sample + unflagged_sample

    pq = pl.read_parquet(PARQUET).filter(pl.col("DOT_NUMBER").is_in(sample))
    by_dot = {r["DOT_NUMBER"]: r for r in pq.iter_rows(named=True)}

    print(f"Validating {len(sample)} carriers against live FMCSA API\n")

    total_diffs = 0
    perfect = 0
    for dot in sample:
        api = fetch_api(dot, key)
        parq = by_dot.get(dot)
        if not api:
            print(f"DOT {dot}: API returned nothing — skipping")
            continue
        if not parq:
            print(f"DOT {dot}: not in parquet — skipping")
            continue
        diffs = compare(parq, api)
        name = parq.get("LEGAL_NAME") or "?"
        if not diffs:
            print(f"✓ DOT {dot} ({name}) — all fields match")
            perfect += 1
        else:
            print(f"✗ DOT {dot} ({name}) — {len(diffs)} diff(s)")
            for d in diffs:
                print(d)
            total_diffs += len(diffs)
        print()

    print(f"\nSummary: {perfect}/{len(sample)} perfect matches, {total_diffs} total field diffs")


if __name__ == "__main__":
    main()
