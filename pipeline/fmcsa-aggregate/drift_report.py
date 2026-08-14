# /// script
# requires-python = ">=3.11"
# dependencies = ["polars>=1.0"]
# ///
"""Post-build drift report: compare this refresh's artifacts against the previous
vintage and fail loudly on implausible moves.

Why this exists — the Aug 2026 refresh shipped an insurer-lift table whose
observation window was hardcoded to 2025-04-01..2026-04-30, so it silently
excluded every revocation from May onward. Nothing failed. Every test passed. It
was found only by reading the source by hand, weeks later.

That bug had a specific signature: the artifact did not change at all. So this
checks BOTH directions, and the second one is the one that matters:

  * MOVED TOO MUCH  — a count/rate swung beyond tolerance, or collapsed to zero.
                      Catches broken joins, bad filters, truncated sources.
  * DID NOT MOVE    — a metric that MUST change every refresh is byte-identical
                      to last month. Catches frozen windows, stale file reads,
                      a pipeline step that silently no-ops.

A metric marked `must_move` is the tripwire for the entire class of "still May"
bugs, none of which any test suite will ever catch, because a stale-but-valid
artifact is indistinguishable from a correct one without a prior to compare to.

Usage:
    uv run drift_report.py                  # compare + write new baseline
    uv run drift_report.py --warn-only      # report, never exit non-zero
    uv run drift_report.py --init           # seed the baseline, no comparison

Baseline lives at data/refresh_metrics.json (committed, so the comparison
survives a fresh clone and is reviewable in the PR diff).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import polars as pl

REPO = Path(__file__).resolve().parent.parent.parent
AGG = Path(os.environ.get("FMCSA_PARQUET", REPO / "data" / "carrier_aggregates.parquet"))
SIGNALS = Path(os.environ.get("FMCSA_RISK_SIGNALS", REPO / "data" / "carrier_risk_signals.parquet"))
LIB_DATA = REPO / "lib" / "data"
BASELINE = Path(os.environ.get("FMCSA_DRIFT_BASELINE", REPO / "data" / "refresh_metrics.json"))

SNAPSHOT = os.environ.get("FMCSA_SNAPSHOT_DATE")

# tolerance = max relative change before we complain; None = must not change sign/zero only.
# must_move  = this value is expected to differ from last refresh; identical means stale.
#
# CALIBRATION (not guesswork). Replayed the committed June 2026 parquet against
# August to get real two-month movement:
#     rows +1.9%   bipd_on_file +2.5%   crashes -5.8%   fatal -4.7%
#     driver insp +1.5%   vehicle insp +1.5%   prior_revoke -5.7%
# So genuine movement is 1.5-6% over two months and the tolerances below sit at
# 10-25%, i.e. 3-4x headroom. Verified against that baseline: a healthy new
# vintage raises ZERO errors, while the two real Aug 2026 defects both trip —
# frozen insurer/zip tables on a vintage change, and the scrape error ceiling.
# A check that cries wolf gets switched off, so no-false-alarms was the
# requirement; detection headroom is the deliberate trade.
#
# Note crashes fall while inspections rise: the 24-month window sheds old
# crashes faster than new ones land. Expected, not a bug.
SPEC: dict[str, dict] = {
    # --- universe ---
    "rows":                       {"tol": 0.10},
    "risk_signal_rows":           {"tol": 0.25},
    # --- insurance (the Motus rebuild — most fragile surface) ---
    "bipd_on_file":               {"tol": 0.15},
    "bipd_required":              {"tol": 0.15},
    "bipd_zero_with_requirement": {"tol": 0.50},
    "suspension_pending":         {"tol": 0.75},
    "suspension_effective":       {"tol": 0.75},
    "imminent_lapse":             {"tol": 0.75},
    # --- authority / revocation ---
    "active_authority":           {"tol": 0.15},
    "prior_revoke_flag":          {"tol": 0.20},
    # New Aug 2026. Watch it like any other gating signal: a join change or a
    # shift in what counts as "shut down" would move this sharply and silently.
    "shutdown_sibling_any":       {"tol": 0.30},
    "shutdown_sibling_high":      {"tol": 0.40},
    # --- safety volume (should drift gently as the 24mo window rolls) ---
    "sum_crashes":                {"tol": 0.20, "must_move": True},
    "sum_fatal_crashes":          {"tol": 0.25, "must_move": True},
    "sum_driver_inspections":     {"tol": 0.20, "must_move": True},
    "sum_vehicle_inspections":    {"tol": 0.20, "must_move": True},
    "crash_indicator_alert":      {"tol": 0.35},
    # --- derived lookup tables (the class that silently froze) ---
    "insurer_base_rate":          {"tol": 0.40, "must_move": True},
    "insurer_count":              {"tol": 0.35},
    "zip_base_rate":              {"tol": 0.40, "must_move": True},
    "zip_count":                  {"tol": 0.35},
    "lane_national_injury_pct":   {"tol": 0.15},
    "lane_state_count":           {"tol": 0.50},
    # --- scrape coverage ---
    # Added after the Aug 2026 refresh shipped with the serious-violations scrape
    # failing 714/5,006 DOTs (14.3%) because it ran unproxied into FMCSA's WAF.
    # Nothing noticed: the artifacts were present and plausible, so every check
    # above passed. Error COUNTS get a tight tolerance and a hard zero-tolerance
    # ceiling, because a scrape that silently stops working is indistinguishable
    # from one that found nothing.
    "scrape_sv_ok":               {"tol": 0.25},
    "scrape_sv_error":            {"tol": 0.50, "ceiling": 150},
    "scrape_ci_ok":               {"tol": 0.20},
    "scrape_ci_error":            {"tol": 0.50, "ceiling": 400},
    # --- vintage: not a measurement, a tripwire ---
    "snapshot_date":              {"exact_must_move": True},
}


def _count(df: pl.DataFrame, expr: pl.Expr) -> int:
    return int(df.select(expr.sum()).item() or 0)


def collect() -> dict:
    cols = pl.scan_parquet(AGG).collect_schema().names()

    def has(c: str) -> bool:
        return c in cols

    want = [c for c in (
        "bipd_insurance_on_file", "bipd_insurance_required", "bipd_required_amount",
        "insurance_suspension_status", "bipd_imminent_lapse", "has_active_authority",
        "prior_revoke_flag", "shutdown_sibling_count", "power_units",
        "crashes_24mo", "fatal_crashes_24mo",
        "driver_inspections_24mo", "vehicle_inspections_24mo", "crash_indicator_alert",
    ) if has(c)]
    df = pl.read_parquet(AGG, columns=want)
    m: dict = {"rows": pl.scan_parquet(AGG).select(pl.len()).collect().item()}

    if has("bipd_insurance_on_file"):
        m["bipd_on_file"] = _count(df, (pl.col("bipd_insurance_on_file") > 0).cast(pl.Int64))
    if has("bipd_insurance_required"):
        m["bipd_required"] = _count(df, (pl.col("bipd_insurance_required") == "Y").cast(pl.Int64))
    if has("bipd_insurance_on_file") and has("bipd_required_amount"):
        m["bipd_zero_with_requirement"] = _count(
            df,
            ((pl.col("bipd_insurance_on_file") == 0) & (pl.col("bipd_required_amount") > 0)).cast(pl.Int64),
        )
    if has("insurance_suspension_status"):
        m["suspension_pending"] = _count(df, (pl.col("insurance_suspension_status") == "pending").cast(pl.Int64))
        m["suspension_effective"] = _count(df, (pl.col("insurance_suspension_status") == "effective").cast(pl.Int64))
    if has("bipd_imminent_lapse"):
        m["imminent_lapse"] = _count(df, pl.col("bipd_imminent_lapse").cast(pl.Int64))
    if has("has_active_authority"):
        m["active_authority"] = _count(df, pl.col("has_active_authority").cast(pl.Int64))
    if has("prior_revoke_flag"):
        m["prior_revoke_flag"] = _count(df, pl.col("prior_revoke_flag").cast(pl.Int64))
    if has("shutdown_sibling_count"):
        n = pl.col("shutdown_sibling_count").fill_null(0)
        pu = pl.col("power_units").fill_null(0).clip(1) if has("power_units") else pl.lit(1)
        m["shutdown_sibling_any"] = _count(df, (n >= 1).cast(pl.Int64))
        # The gating population: matches the analyzer's high/critical tiers.
        m["shutdown_sibling_high"] = _count(df, ((n >= 2) & (n / pu >= 0.25)).cast(pl.Int64))
    for src, dst in (("crashes_24mo", "sum_crashes"), ("fatal_crashes_24mo", "sum_fatal_crashes"),
                     ("driver_inspections_24mo", "sum_driver_inspections"),
                     ("vehicle_inspections_24mo", "sum_vehicle_inspections")):
        if has(src):
            m[dst] = int(df.select(pl.col(src).sum()).item() or 0)
    # String 'Y'/'N'/null, not a boolean — casting it to Int64 raises.
    if has("crash_indicator_alert"):
        m["crash_indicator_alert"] = _count(df, (pl.col("crash_indicator_alert") == "Y").cast(pl.Int64))

    if SIGNALS.exists():
        m["risk_signal_rows"] = pl.scan_parquet(SIGNALS).select(pl.len()).collect().item()

    def load(name):
        p = LIB_DATA / name
        return json.loads(p.read_text()) if p.exists() else None

    if (j := load("insurer-risk.json")):
        m["insurer_base_rate"] = j.get("base_rate")
        m["insurer_count"] = len(j.get("insurers", {}))
    if (j := load("zip-risk.json")):
        m["zip_base_rate"] = j.get("base_rate")
        m["zip_count"] = len(j.get("zips", {}))
    if (j := load("lane-liability.json")):
        m["lane_national_injury_pct"] = (j.get("_meta") or {}).get("national_injury_pct")
        m["lane_state_count"] = len([k for k in j if k != "_meta"])

    # Scrape coverage, read from the per-vintage status parquets. Counted here
    # (rather than trusted) because a scrape can fail wholesale and still leave a
    # complete-looking artifact behind.
    scrape_dir = REPO / "data" / "fmcsa_scrape"
    for pattern, prefix, status_col in (
        (f"serious_violations_status_{SNAPSHOT}.parquet", "scrape_sv", "scrape_status"),
        (f"crash_indicator_{SNAPSHOT}.parquet", "scrape_ci", "scrape_status"),
    ):
        p = scrape_dir / pattern
        if not (SNAPSHOT and p.exists()):
            continue
        s = pl.read_parquet(p, columns=[status_col])
        m[f"{prefix}_ok"] = int((s[status_col] == "ok").sum())
        m[f"{prefix}_error"] = int(s[status_col].str.starts_with("error").sum())

    if SNAPSHOT:
        m["snapshot_date"] = SNAPSHOT
    return m


def compare(new: dict, old: dict) -> list[tuple[str, str, str]]:
    """Returns (severity, metric, message). severity in {ERROR, WARN}.

    Same snapshot_date means this is a RE-RUN of a vintage already in the
    baseline (a --from resume, a re-build after a fix), not a new refresh.
    Nothing is expected to have moved, so the must_move tripwires are muted —
    otherwise every resume fails and the check gets ignored, which is worse than
    not having it. The tripwire that matters is unaffected: a NEW snapshot_date
    with identical metrics still errors, and that is the actual bug signature.
    """
    rerun = "snapshot_date" in new and new.get("snapshot_date") == old.get("snapshot_date")
    issues = []
    if rerun:
        issues.append((
            "WARN", "snapshot_date",
            f"same vintage as baseline ({new['snapshot_date']}) — treating as a re-run; "
            f"'must move' checks muted, tolerances still enforced",
        ))
    for key, spec in SPEC.items():
        if rerun and (spec.get("must_move") or spec.get("exact_must_move")):
            continue
        if key not in new:
            continue
        if key not in old:
            issues.append(("WARN", key, f"new metric ({new[key]}) — no baseline to compare"))
            continue
        a, b = old[key], new[key]

        if spec.get("exact_must_move"):
            if a == b:
                issues.append(("ERROR", key, f"unchanged at {b!r} — a refresh must advance this"))
            continue

        if a is None or b is None:
            if a != b:
                issues.append(("ERROR", key, f"{a!r} -> {b!r} (became/stopped being null)"))
            continue

        if b == 0 and a != 0:
            issues.append(("ERROR", key, f"{a:,} -> 0 — collapsed to zero"))
            continue

        # Absolute ceiling, independent of the relative move. An error count can
        # creep up within tolerance every month and still end up somewhere it
        # should never be.
        ceiling = spec.get("ceiling")
        if ceiling is not None and b > ceiling:
            issues.append(("ERROR", key, f"{b:,} exceeds the absolute ceiling of {ceiling:,}"))
            continue

        if spec.get("must_move") and a == b:
            issues.append((
                "ERROR", key,
                f"IDENTICAL to last refresh ({b}) — expected to move; suspect a frozen "
                f"window or a stale source read",
            ))
            continue

        tol = spec.get("tol")
        if tol is not None and a:
            rel = (b - a) / abs(a)
            if abs(rel) > tol:
                issues.append((
                    "ERROR", key,
                    f"{a:,} -> {b:,} ({rel:+.1%}, tolerance +/-{tol:.0%})" if isinstance(a, int)
                    else f"{a} -> {b} ({rel:+.1%}, tolerance +/-{tol:.0%})",
                ))
    return issues


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--warn-only", action="store_true", help="report but always exit 0")
    ap.add_argument("--init", action="store_true", help="write baseline without comparing")
    args = ap.parse_args()

    if not AGG.exists():
        sys.exit(f"drift_report: parquet not found: {AGG}")

    new = collect()

    if args.init or not BASELINE.exists():
        BASELINE.parent.mkdir(parents=True, exist_ok=True)
        BASELINE.write_text(json.dumps(new, indent=2, sort_keys=True) + "\n")
        print(f"[drift] baseline seeded ({len(new)} metrics) -> {BASELINE}")
        print("[drift] no comparison this run; next refresh will diff against it.")
        return 0

    old = json.loads(BASELINE.read_text())
    issues = compare(new, old)

    # Persist the comparison BEFORE the baseline advances — once it does, the
    # "previous" values are gone and the run summary would have nothing to diff
    # against. This is what refresh_summary.py reads.
    if SNAPSHOT:
        rep_dir = REPO / "data" / "refresh_reports"
        rep_dir.mkdir(parents=True, exist_ok=True)
        (rep_dir / f"drift_{SNAPSHOT}.json").write_text(json.dumps({
            "snapshot": SNAPSHOT,
            "previous": old,
            "current": new,
            "issues": [{"severity": s, "metric": k, "message": m} for s, k, m in issues],
        }, indent=2, sort_keys=True) + "\n")

    print(f"\n{'metric':<28} {'previous':>16} {'current':>16}   change")
    print("-" * 82)
    for key in SPEC:
        if key not in new:
            continue
        a, b = old.get(key), new[key]
        chg = ""
        if isinstance(a, (int, float)) and isinstance(b, (int, float)) and a:
            chg = f"{(b - a) / abs(a):+.1%}"
        elif a == b:
            chg = "same"
        flag = next((s for s, k, _ in issues if k == key), "")
        mark = " <<" if flag == "ERROR" else ""
        print(f"{key:<28} {str(a):>16} {str(b):>16}   {chg:>8}{mark}")

    errors = [i for i in issues if i[0] == "ERROR"]
    warns = [i for i in issues if i[0] == "WARN"]
    print()
    for sev, key, msg in warns:
        print(f"  WARN  {key}: {msg}")
    for sev, key, msg in errors:
        print(f"  ERROR {key}: {msg}")

    # Baseline advances only on a clean run, so a failing refresh doesn't quietly
    # become next month's "normal" — otherwise a bad vintage launders itself.
    if not errors:
        BASELINE.write_text(json.dumps(new, indent=2, sort_keys=True) + "\n")
        print(f"\n[drift] clean ({len(warns)} warning(s)) — baseline updated -> {BASELINE}")
        return 0

    print(f"\n[drift] {len(errors)} metric(s) outside tolerance. Baseline NOT updated.")
    print("[drift] If these moves are real, re-run with --init to accept them as the new baseline.")
    return 0 if args.warn_only else 1


if __name__ == "__main__":
    sys.exit(main())
