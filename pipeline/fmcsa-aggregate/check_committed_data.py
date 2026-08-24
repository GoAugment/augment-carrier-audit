# /// script
# requires-python = ">=3.11"
# dependencies = ["polars>=1.0"]
# ///
"""Fail if the committed parquet and the committed metrics describe different builds.

WHY THIS EXISTS

data/carrier_aggregates.parquet and data/refresh_metrics.json are written by the
same refresh and are only meaningful as a pair. The refresh workflow commits them
together, and on a FAILED run it deliberately stages only data/fmcsa_scrape so an
unvalidated parquet cannot reach main.

A human can still bypass all of that with one `git add -A`, and one did: PR #80
swept up a parquet from a build that had failed validation, because it had been
copied into the working tree for local testing and a later `git stash pop` put it
back. main carried unvalidated data (prior_revoke 11,105 -> 382) for 1m48s, and
production auto-deploys from main, so it was briefly served.

Nothing caught it, because nothing looked. This looks: it recomputes the metrics
straight from the parquet and requires an EXACT match against the committed
baseline. Not a tolerance — these are two views of one build, so any difference
at all means they came from different ones.

It runs on pull requests, so the check happens before the merge that would
deploy, rather than after.

Usage:
    uv run check_committed_data.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from drift_report import BASELINE, collect  # noqa: E402

# Cheap, high-signal, and spread across independent parts of the build: the
# universe, the join-heavy authority/insurance columns, the rolling 24-month
# windows, and the field whose collapse started all this. A parquet from a
# different vintage cannot match all of them by accident.
KEYS = (
    "rows",
    "active_authority",
    "bipd_on_file",
    "prior_revoke_flag",
    "sum_crashes",
    "sum_fatal_crashes",
    "sum_driver_inspections",
    "sum_vehicle_inspections",
)


def main() -> int:
    if not BASELINE.exists():
        print(f"[check-data] no baseline at {BASELINE} — nothing to compare")
        return 0

    committed = json.loads(BASELINE.read_text())
    actual = collect()

    mismatches = [
        (k, committed.get(k), actual.get(k))
        for k in KEYS
        if k in committed and k in actual and committed[k] != actual[k]
    ]

    if not mismatches:
        print(
            f"[check-data] parquet matches refresh_metrics.json "
            f"(snapshot {committed.get('snapshot_date')}, {len(KEYS)} metrics checked)"
        )
        return 0

    print("[check-data] COMMITTED PARQUET AND METRICS DISAGREE\n", file=sys.stderr)
    for k, want, got in mismatches:
        print(f"  {k}: refresh_metrics.json={want!r}  parquet={got!r}", file=sys.stderr)
    print(
        "\n  These are two views of ONE build, so any difference means they came from\n"
        "  different ones. Almost always: a parquet was committed without the metrics\n"
        "  from the same run — check for a stray `git add -A` picking up a parquet\n"
        "  copied in for local testing.\n"
        "\n  Fix by restoring both files from the last refresh commit, NOT by\n"
        "  regenerating the baseline — that would just record whatever is there.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
