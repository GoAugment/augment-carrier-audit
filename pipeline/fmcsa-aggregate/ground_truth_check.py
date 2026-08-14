# /// script
# requires-python = ">=3.11"
# dependencies = ["polars>=1.0", "httpx"]
# ///
"""Sample real carriers and compare our parquet against LIVE FMCSA.

Why this exists, and why it is not the same as drift_report.py:

  drift_report  compares this refresh to OUR OWN last refresh. It answers
                "did something change that shouldn't have?"
  this script   compares this refresh to FMCSA. It answers "are we right?"

Drift is self-referential and therefore blind to systematic error: if we compute
something wrong the same way every month, the metric is perfectly stable and
drift reports all clear forever. The tow-crash definition was wrong from the
start and drift would never have found it. The Motus insurance rebuild broke
twice during the Aug 2026 refresh (Schneider read as lapsed, Werner as $6M) —
both were stable-looking numbers that only a comparison against FMCSA catches.

Source: FMCSA QCMobile API, https://mobile.fmcsa.dot.gov/qc/services/carriers/{dot}
Needs FMCSA_WEBKEY. (SAFER scraping is not used — it needs a proxy and HTML
parsing; L&I is reCAPTCHA-gated and cannot be used at all.)

NEVER fails the build on a network/credential problem. FMCSA's uptime is not our
correctness, and a check that blocks the pipeline when a third party is down gets
disabled, which costs more than it saves. Missing key / API errors => WARN, exit 0.
Only genuine field disagreement above threshold fails.
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
from pathlib import Path

import httpx
import polars as pl

REPO = Path(__file__).resolve().parent.parent.parent
AGG = Path(os.environ.get("FMCSA_PARQUET", REPO / "data" / "carrier_aggregates.parquet"))
API = "https://mobile.fmcsa.dot.gov/qc/services/carriers/{dot}?webKey={key}"

SNAPSHOT = os.environ.get("FMCSA_SNAPSHOT_DATE", "")


def _webkey() -> str | None:
    if (k := os.environ.get("FMCSA_WEBKEY")):
        return k.strip()
    # Convenience for local runs: the key has historically lived in a backup
    # env file rather than .env.local. Checked last so the env var always wins.
    for name in (".env.local", ".env.local.api-bak", ".env"):
        p = REPO / name
        if not p.exists():
            continue
        for line in p.read_text().splitlines():
            if line.startswith("FMCSA_WEBKEY="):
                v = line.split("=", 1)[1].strip().strip("\"'")
                if v:
                    return v
    return None


# (our_column, fmcsa_field, rule)
#   exact     — any difference is a real defect
#   tol:N,P   — allow the larger of N absolute or P fraction; absorbs the fact
#               that FMCSA is live while our extract is a fixed snapshot, so the
#               rolling 24-month window differs by a few days in both directions
#               (and DataQs removals can make OUR count the higher one)
#   advisory  — reported, never gates
#
# tow_crashes_24mo is deliberately ABSENT. Ours counts the TOW_AWAY flag (a
# reportability criterion present on ~every reportable crash); FMCSA's
# towawayCrash is a mutually-exclusive severity tier. They disagree for 42.9% of
# crash-carriers by design. Reviewed Aug 2026, accepted as display-only, won't
# fix. Including it here would fail this check every single month for a known
# non-defect, which is the fastest way to get a check ignored.
FIELDS = [
    ("bipd_insurance_on_file",    "bipdInsuranceOnFile", "exact"),
    ("bipd_required_amount",      "bipdRequiredAmount",  "exact"),
    ("crashes_24mo",              "crashTotal",          "exact"),
    ("fatal_crashes_24mo",        "fatalCrash",          "exact"),
    ("injury_crashes_24mo",       "injCrash",            "exact"),
    # Generous on purpose. FMCSA's API is live, while the SMS extract we build
    # from is a monthly cut that itself lags MCMIS by weeks — so the 24-month
    # windows are offset by more than the snapshot date suggests, in both
    # directions (DataQs removals can make OUR count the higher one). Measured
    # Aug 2026: gaps up to 6 inspections on small carriers with no defect
    # present. Still catches what matters — a broken join reads 0 vs 20, not
    # 12 vs 18.
    ("driver_inspections_24mo",   "driverInsp",          "tol:3,0.25"),
    ("vehicle_inspections_24mo",  "vehicleInsp",         "tol:3,0.25"),
    ("driver_oos_24mo",           "driverOosInsp",       "tol:2,0.25"),
    ("vehicle_oos_24mo",          "vehicleOosInsp",      "tol:2,0.25"),
    # Reported power units disagree between FMCSA's own census files ~6% of the
    # time; tested Aug 2026, live FMCSA sided with SMS census 12 / Company
    # Census 11 / neither 2 on the disagreements. That is a coin flip, i.e. not
    # our error to fix, so it is reported but never gates.
    ("power_units",               "totalPowerUnits",     "advisory"),
]


def _num(x):
    if x is None:
        return None
    try:
        return float(str(x).replace(",", "").strip())
    except (ValueError, AttributeError):
        return None


def agrees(ours, theirs, rule: str) -> bool:
    a, b = _num(ours), _num(theirs)
    if a is None and b is None:
        return True
    if a is None or b is None:
        # One side has no record at all. Treat 0-vs-missing as agreement: FMCSA
        # omits zero-valued fields for carriers it has no filing for.
        return (a or 0) == (b or 0)
    if rule == "exact":
        return a == b
    if rule.startswith("tol:"):
        absolute, frac = rule[4:].split(",")
        return abs(a - b) <= max(float(absolute), float(frac) * max(abs(a), abs(b)))
    return True


def sample_dots(n: int) -> list[int]:
    """Carriers FMCSA actually has something to compare against.

    A uniform draw over the full ~2.08M is mostly dormant one-truck carriers with
    no inspections, no crashes and no insurance filing — every field would be
    null on both sides and the check would pass ~100% while testing nothing.
    """
    df = pl.read_parquet(AGG, columns=[
        "DOT_NUMBER", "power_units", "driver_inspections_24mo",
        "vehicle_inspections_24mo", "crashes_24mo",
    ])
    pool = df.filter(
        (pl.col("power_units") >= 1)
        & ((pl.col("driver_inspections_24mo").fill_null(0)
            + pl.col("vehicle_inspections_24mo").fill_null(0)
            + pl.col("crashes_24mo").fill_null(0)) > 0)
    )
    # Seed from the snapshot: stable WITHIN a vintage (re-runs and --from resumes
    # check the same carriers, so the result is reproducible and a failure can be
    # investigated) but different ACROSS vintages, so coverage widens every month
    # instead of re-testing one lucky sample forever.
    rng = random.Random(f"ground-truth-{SNAPSHOT}")
    idx = rng.sample(range(pool.height), min(n, pool.height))
    return [int(d) for d in pool[idx]["DOT_NUMBER"]]


def fetch(dots: list[int], key: str, pause: float) -> tuple[dict, list[str]]:
    out, errs = {}, []
    with httpx.Client(timeout=45, follow_redirects=True) as c:
        for d in dots:
            try:
                r = c.get(API.format(dot=d, key=key))
                if r.status_code != 200:
                    errs.append(f"DOT {d}: HTTP {r.status_code}")
                    continue
                car = (r.json().get("content") or {}).get("carrier")
                if car:
                    out[d] = car
                else:
                    errs.append(f"DOT {d}: no carrier in response")
            except Exception as e:  # noqa: BLE001 — network shape varies
                errs.append(f"DOT {d}: {type(e).__name__} {str(e)[:60]}")
            time.sleep(pause)
    return out, errs


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("-n", "--sample", type=int, default=int(os.environ.get("FMCSA_GT_SAMPLE", "40")))
    ap.add_argument("--min-match", type=float, default=float(os.environ.get("FMCSA_GT_MIN_MATCH", "0.95")))
    ap.add_argument("--pause", type=float, default=0.35, help="seconds between API calls")
    ap.add_argument("--warn-only", action="store_true")
    args = ap.parse_args()

    key = _webkey()
    if not key:
        print("[ground-truth] WARN: no FMCSA_WEBKEY — skipping. "
              "Set it in the env or .env.local to enable this check.")
        return 0
    if not AGG.exists():
        print(f"[ground-truth] WARN: parquet not found ({AGG}) — skipping.")
        return 0

    dots = sample_dots(args.sample)
    print(f"[ground-truth] sampling {len(dots)} carriers (seed=vintage {SNAPSHOT or 'unset'})")
    live, errs = fetch(dots, key, args.pause)
    if not live:
        print(f"[ground-truth] WARN: no successful API responses ({len(errs)} error(s)) — "
              f"treating as inconclusive, NOT a failure.")
        for e in errs[:3]:
            print(f"    {e}")
        return 0

    ours = {
        int(r["DOT_NUMBER"]): r
        for r in pl.read_parquet(AGG).filter(
            pl.col("DOT_NUMBER").is_in(list(live))
        ).iter_rows(named=True)
    }

    gated = advisory = gated_ok = advisory_ok = 0
    mismatches: list[tuple] = []
    for dot, car in live.items():
        row = ours.get(dot)
        if row is None:
            mismatches.append((dot, "(missing)", "not in parquet", "present in FMCSA", "exact"))
            gated += 1
            continue
        # A carrier mid-cancellation legitimately disagrees on coverage: FMCSA
        # zeroes bipdInsuranceOnFile as soon as the insurer files, while our
        # snapshot still shows the amount that was on file on snapshot day.
        # Measured Aug 2026 on DOT 3065951 (HUAYRA TRANSPORT) — ours $750k,
        # FMCSA $0, with a suspension already pending for 2026-09-03. Our data
        # is right as of its vintage and the pending-suspension signal already
        # flags the carrier, so gating on this would fail every month on a
        # non-defect.
        in_transition = bool(
            row.get("insurance_suspension_status") or row.get("bipd_pending_cancel_date")
        )
        for col, api_field, rule in FIELDS:
            if col not in row:
                continue
            if in_transition and col.startswith("bipd_"):
                continue
            ok = agrees(row[col], car.get(api_field), rule)
            if rule == "advisory":
                advisory += 1
                advisory_ok += ok
            else:
                gated += 1
                gated_ok += ok
            if not ok:
                mismatches.append((dot, col, row[col], car.get(api_field), rule))

    rate = gated_ok / gated if gated else 1.0
    adv_rate = advisory_ok / advisory if advisory else 1.0
    print(f"[ground-truth] carriers compared: {len(live)}"
          + (f"  (api errors: {len(errs)})" if errs else ""))
    print(f"[ground-truth] gated fields:    {gated_ok}/{gated} = {rate:.1%} (floor {args.min_match:.0%})")
    print(f"[ground-truth] advisory fields: {advisory_ok}/{advisory} = {adv_rate:.1%} (never gates)")

    if mismatches:
        print(f"\n{'DOT':>9} {'field':<28} {'ours':>12} {'FMCSA':>12}  rule")
        for dot, col, a, b, rule in mismatches[:25]:
            tag = "advisory" if rule == "advisory" else rule
            print(f"{dot:>9} {col:<28} {str(a):>12} {str(b):>12}  {tag}")
        if len(mismatches) > 25:
            print(f"    ... and {len(mismatches) - 25} more")

    if rate < args.min_match:
        print(f"\n[ground-truth] FAIL: {rate:.1%} of gated fields match FMCSA, below {args.min_match:.0%}.")
        print("[ground-truth] This means our data disagrees with FMCSA — investigate before shipping.")
        return 0 if args.warn_only else 1

    print("\n[ground-truth] OK — our data agrees with live FMCSA.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
