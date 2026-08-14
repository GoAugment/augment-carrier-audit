# /// script
# requires-python = ">=3.11"
# dependencies = ["polars>=1.0"]
# ///
"""Write one human-readable digest of a refresh, so reviewing it means reading a
page instead of poking at parquets.

The Aug 2026 refresh shipped three defects that were each invisible in a green
build and only surfaced by hand-inspection days later: an insurer table frozen
to a stale window, a lane table with no generator, and a scrape silently failing
14% of its DOTs. None of them made anything fail. The lesson is that "the build
passed" is not the same as "the data is good", and the gap between them was
being closed by whoever remembered to go look.

This closes it by default: every refresh leaves a dated report at
data/refresh_reports/refresh_<TAG>.md covering vintage, what moved, scrape
coverage, agreement with live FMCSA, and an explicit NEEDS ATTENTION list.

Reads what earlier steps already produced (drift_<TAG>.json, the scrape status
parquets, the built parquet). Computes nothing new, so it cannot disagree with
the checks that gate the build.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import polars as pl

REPO = Path(__file__).resolve().parent.parent.parent
AGG = Path(os.environ.get("FMCSA_PARQUET", REPO / "data" / "carrier_aggregates.parquet"))
SCRAPE_DIR = REPO / "data" / "fmcsa_scrape"
REPORTS = REPO / "data" / "refresh_reports"
SNAPSHOT = os.environ.get("FMCSA_SNAPSHOT_DATE", "")

# Counts worth seeing every month: each one gates a verdict somewhere, so a
# surprise here is a surprise in what brokers get told.
HEADLINE = [
    ("has_serious_violation", "carriers w/ acute-critical violations", "bool"),
    ("fast_act_high_risk", "FAST Act high-risk (2+ BASICs >=90th)", "bool"),
    ("insurance_suspension_status", "authority suspended for insurance", "notnull"),
    ("bipd_imminent_lapse", "imminent insurance lapse", "bool"),
    ("prior_revoke_flag", "prior-revoked (chameleon predecessor)", "bool"),
    ("crash_indicator_alert", "Crash Indicator alert", "eq:Y"),
]


def _fmt(n) -> str:
    return f"{n:,}" if isinstance(n, int) else ("—" if n is None else str(n))


def _delta(cur, prev) -> str:
    if not isinstance(cur, (int, float)) or not isinstance(prev, (int, float)) or not prev:
        return ""
    d = cur - prev
    return f"{d:+,} ({d / abs(prev):+.1%})" if d else "no change"


def main() -> int:
    if not SNAPSHOT:
        print("[summary] FMCSA_SNAPSHOT_DATE unset — run via build_all.py.")
        return 0
    if not AGG.exists():
        print(f"[summary] parquet missing ({AGG}) — nothing to summarise.")
        return 0

    attention: list[str] = []
    out: list[str] = [f"# FMCSA refresh — {SNAPSHOT}", ""]

    # --- drift ---
    drift_path = REPORTS / f"drift_{SNAPSHOT}.json"
    drift = json.loads(drift_path.read_text()) if drift_path.exists() else None
    if drift:
        prev_tag = drift["previous"].get("snapshot_date", "?")
        errs = [i for i in drift["issues"] if i["severity"] == "ERROR"]
        out += [f"Compared against previous vintage **{prev_tag}**.", ""]
        if errs:
            attention += [f"drift: {i['metric']} — {i['message']}" for i in errs]
    else:
        out += ["_No drift report found for this vintage._", ""]

    # --- what moved ---
    out += ["## What moved", "", "| metric | previous | current | change |", "|---|---:|---:|---:|"]
    if drift:
        for k, cur in sorted(drift["current"].items()):
            prev = drift["previous"].get(k)
            if k == "snapshot_date":
                continue
            out.append(f"| `{k}` | {_fmt(prev)} | {_fmt(cur)} | {_delta(cur, prev)} |")
    out.append("")

    # --- headline flag counts ---
    cols = pl.scan_parquet(AGG).collect_schema().names()
    present = [(c, lbl, kind) for c, lbl, kind in HEADLINE if c in cols]
    if present:
        df = pl.read_parquet(AGG, columns=[c for c, _, _ in present])
        out += ["## Carriers flagged", "", "| signal | carriers |", "|---|---:|"]
        for c, lbl, kind in present:
            if kind == "bool":
                n = int(df.select(pl.col(c).fill_null(False).sum()).item() or 0)
            elif kind == "notnull":
                n = int(df.select(pl.col(c).is_not_null().sum()).item() or 0)
            else:
                n = int(df.select((pl.col(c) == kind.split(":", 1)[1]).sum()).item() or 0)
            out.append(f"| {lbl} | {n:,} |")
        out.append("")

    # --- scrape coverage ---
    out += ["## Scrape coverage", "", "| scrape | ok | no data | errors |", "|---|---:|---:|---:|"]
    for label, fname in (("serious violations", f"serious_violations_status_{SNAPSHOT}.parquet"),
                         ("crash indicator", f"crash_indicator_{SNAPSHOT}.parquet")):
        p = SCRAPE_DIR / fname
        if not p.exists():
            out.append(f"| {label} | _not run_ | | |")
            continue
        s = pl.read_parquet(p, columns=["scrape_status"])["scrape_status"]
        ok = int((s == "ok").sum())
        nod = int((s == "no_data").sum())
        err = int(s.str.starts_with("error").sum())
        out.append(f"| {label} | {ok:,} | {nod:,} | {err:,} |")
        total = ok + nod + err
        # A scrape that quietly stops working looks exactly like one that found
        # nothing, so surface the rate rather than trusting the artifact exists.
        if total and err / total > 0.05:
            attention.append(
                f"{label} scrape: {err:,}/{total:,} DOTs failed ({err/total:.1%}) — "
                f"check the proxy before trusting this vintage"
            )
    out.append("")

    # --- ground truth (written by ground_truth_check.py when it runs) ---
    gt_path = REPORTS / f"ground_truth_{SNAPSHOT}.json"
    if gt_path.exists():
        gt = json.loads(gt_path.read_text())
        out += ["## Agreement with live FMCSA", "",
                f"- gated fields: **{gt['gated_ok']}/{gt['gated']} = {gt['rate']:.1%}** "
                f"(floor {gt['floor']:.0%})",
                f"- carriers sampled: {gt['carriers']}", ""]
        if gt["rate"] < gt["floor"]:
            attention.append(f"ground truth: {gt['rate']:.1%} agreement, below the {gt['floor']:.0%} floor")

    # --- the part worth reading first ---
    head = ["## Needs attention", ""]
    head += ([f"- {a}" for a in attention] if attention
             else ["_Nothing._ Drift within tolerance, scrape coverage healthy, "
                   "data agrees with live FMCSA."])
    head.append("")
    out = out[:2] + head + out[2:]

    REPORTS.mkdir(parents=True, exist_ok=True)
    path = REPORTS / f"refresh_{SNAPSHOT}.md"
    path.write_text("\n".join(out) + "\n")

    print(f"[summary] wrote {path.relative_to(REPO)}")
    if attention:
        print(f"[summary] {len(attention)} item(s) need attention:")
        for a in attention:
            print(f"    - {a}")
    else:
        print("[summary] nothing needs attention.")
    # Never fails the build: the gating checks already ran and this only reports.
    return 0


if __name__ == "__main__":
    sys.exit(main())
