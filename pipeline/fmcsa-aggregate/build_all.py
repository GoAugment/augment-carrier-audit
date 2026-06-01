# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Single entry point that runs the entire pipeline in order.

Equivalent to invoking the constituent scripts sequentially per the order in
README.md. Stops on the first failure so the parquet is never left in an
inconsistent state. Each step prints its own progress to stdout.

Usage:
  uv run build_all.py                 # run full pipeline including scrape
  uv run build_all.py --no-scrape     # skip the per-DOT scrape (faster;
                                      # uses whatever scrape parquet exists)
  uv run build_all.py --from <step>   # resume from a specific step name
                                      # (e.g. --from compute_basics)
  uv run build_all.py --list          # list all steps + estimated runtime

Steps are intentionally simple subprocess invocations rather than imports so
each script's own dependency declarations (the `# /// script` block at the
top of each file) drive its environment via uv. Errors in any sub-script
surface as a non-zero exit + a clear "FAILED: <step>" message.

Designed to be the only command needed for a monthly refresh.
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
DATA_DIR = ROOT / "data"
SOURCES_DIR = DATA_DIR / "sources"
SCRAPE_DIR = DATA_DIR / "fmcsa_scrape"
LIB_DATA_DIR = ROOT / "lib" / "data"

DEFAULT_ENV = {
    "FMCSA_OUTPUT_DIR": DATA_DIR,
    "FMCSA_PARQUET": DATA_DIR / "carrier_aggregates.parquet",
    "FMCSA_IDENTITY_PARQUET": DATA_DIR / "carrier_identity.parquet",
    "FMCSA_THRESHOLDS_OUT": DATA_DIR / "national_thresholds.json",
    "FMCSA_THRESHOLDS_V2_OUT": DATA_DIR / "national_thresholds_v2.json",
    "FMCSA_SCRAPE_DIR": SCRAPE_DIR,
    "FMCSA_SERIOUS_VIOLATIONS": SCRAPE_DIR / "serious_violations_20260514.parquet",
    "FMCSA_REVOCATION": SOURCES_DIR / "Revocation_-_All_With_History_20260514.csv",
    "FMCSA_INSHIST": SOURCES_DIR / "inshist_allwithhistory.txt",
    "FMCSA_ENFORCEMENT_XLSX": SOURCES_DIR / "closed_enforcement_cases_20260515005306.xlsx",
    "FMCSA_ACTPEND": SOURCES_DIR / "ActPendInsur_All_With_History.csv",
    "FMCSA_PASSPROP": SOURCES_DIR / "SMS_AB_PassProperty_20260514.csv",
    "FMCSA_CARRIER_AUTH": SOURCES_DIR / "Carrier_All_With_History.csv",
    "FMCSA_INSPECTION_FILE": SOURCES_DIR / "SMS_Input_-_Inspection_20260518.csv",
    "FMCSA_VIOLATION_FILE": SOURCES_DIR / "SMS_Input_-_Violation_20260518.csv",
    "FMCSA_CRASH_FILE": SOURCES_DIR / "SMS_Input_-_Crash_20260518.csv",
    # Output tag for the per-DOT crash-scrape parquet (crash_indicator_<TAG>.parquet).
    # Bump this with the monthly drop so the scrape writes a fresh vintage file
    # (compute_basics globs the newest). The scraper recomputes Crash-Indicator
    # eligibility from FMCSA_CRASH_FILE's date automatically, so only this tag +
    # the dated filenames above need updating each month.
    "SMS_DATA_TAG": "20260514",
    "FMCSA_COMPANY_CENSUS": SOURCES_DIR / "Company_Census_File.csv",
    "FMCSA_ZIP_RISK_OUT": LIB_DATA_DIR / "zip-risk.json",
    "FMCSA_INSURER_RISK_OUT": LIB_DATA_DIR / "insurer-risk.json",
}


@dataclass
class Step:
    name: str
    script: str
    description: str
    runtime_estimate_min: float
    optional: bool = False  # can be skipped via --no-scrape
    extra_args: tuple[str, ...] = ()


STEPS: list[Step] = [
    Step(
        name="build_aggregates",
        script="build_aggregates.py",
        description="Core schema + 5 public BASIC measures from bulk SMS file",
        runtime_estimate_min=3.0,
    ),
    Step(
        name="add_revocations",
        script="add_revocations.py",
        description="Revocation history + prior-revoke flag",
        runtime_estimate_min=0.5,
    ),
    Step(
        name="add_inshist",
        script="add_inshist.py",
        description="Insurance cancellation history (distinct policies, "
                    "rapid-replace flag)",
        runtime_estimate_min=1.0,
    ),
    Step(
        name="add_enforcement",
        script="add_enforcement.py",
        description="Enforcement case counts + settlement totals",
        runtime_estimate_min=0.5,
    ),
    Step(
        name="add_pending_lapse",
        script="add_pending_lapse.py",
        description="Imminent BIPD insurance lapse (terminal cancellation, no "
                    "replacement, no other active coverage)",
        runtime_estimate_min=1.0,
    ),
    Step(
        name="add_fleet_sharing",
        script="add_fleet_sharing.py",
        description="Cross-DOT VIN overlap (largest sibling for "
                    "chameleon-shared-fleet rule)",
        runtime_estimate_min=3.0,
    ),
    Step(
        name="add_plausibility",
        script="add_plausibility.py",
        description="Fleet-size plausibility heuristic (inflated PU detection)",
        runtime_estimate_min=0.5,
    ),
    Step(
        name="add_chameleon_signals",
        script="add_chameleon_signals.py",
        description="Diffuse VIN share + insurance distinct-policy / "
                    "replace counts",
        runtime_estimate_min=2.0,
    ),
    Step(
        name="scrape_pu_history",
        script="scrape_pu_history.py",
        description="Per-DOT historical PU snapshots via ZenRows proxy "
                    "(~25k DOTs)",
        runtime_estimate_min=90.0,
        optional=True,
    ),
    Step(
        name="compute_basics",
        script="compute_basics.py",
        description="All 7 BASIC measures + percentiles + alerts",
        runtime_estimate_min=5.0,
    ),
    Step(
        name="add_high_risk",
        script="add_high_risk.py",
        description="FAST Act §5305 High-Risk flag (2+ of UD/CI/HOS/VM "
                    "at >=90th percentile)",
        runtime_estimate_min=0.5,
    ),
    Step(
        name="fetch_serious_violations",
        script="fetch_serious_violations.py",
        description="Scrape acute/critical investigation violations (ISS Group 6 / "
                    "BASIC→100). Needs SCRAPE_PROXY_URL (ZenRows).",
        runtime_estimate_min=50.0,
        optional=True,
    ),
    Step(
        name="add_serious_violations",
        script="add_serious_violations.py",
        description="Apply Serious Violations: affected BASIC percentile→100 + "
                    "alert (after add_high_risk so FAST uses roadside percentiles)",
        runtime_estimate_min=0.5,
    ),
    Step(
        name="compute_iss",
        script="compute_iss.py",
        description="ISS-CSA score (1-100, three tiers)",
        runtime_estimate_min=3.0,
    ),
    Step(
        name="recompute_thresholds",
        script="recompute_thresholds.py",
        description="Peer-group P85/P95/P99 cutoffs for analyzer.ts",
        runtime_estimate_min=0.5,
    ),
    # --- Risk-axis derived data (previously run by hand; now part of the refresh) ---
    Step(
        name="add_phantom_fleet",
        script="add_phantom_fleet.py",
        description="Phantom-fleet signal: distinct inspected VINs vs reported PU",
        runtime_estimate_min=2.0,
    ),
    Step(
        name="add_phy_zip",
        script="add_phy_zip.py",
        description="Physical-address ZIP (from carrier_identity) for the ZIP-risk marker",
        runtime_estimate_min=0.5,
    ),
    Step(
        name="add_geo_mismatch",
        script="add_geo_mismatch.py",
        description="Home-state inspection share (registration vs where cited)",
        runtime_estimate_min=2.0,
    ),
    Step(
        name="build_insurer_risk",
        script="build_insurer_risk.py",
        description="Insurer-reputation lift table -> lib/data/insurer-risk.json",
        runtime_estimate_min=0.5,
    ),
    Step(
        name="build_zip_risk",
        script="build_zip_risk.py",
        description="Per-ZIP shutdown-lift table -> lib/data/zip-risk.json",
        runtime_estimate_min=0.5,
    ),
    Step(
        name="prune_app_parquet",
        script="prune_app_parquet.py",
        description="Drop build-only columns; keep the checked-in aggregate at the app contract",
        runtime_estimate_min=0.5,
    ),
]


def list_steps() -> None:
    total = sum(s.runtime_estimate_min for s in STEPS)
    print(f"{'Step':<24} {'~min':>6}  {'Optional':<9}  Description")
    print("-" * 100)
    for s in STEPS:
        opt = "yes" if s.optional else ""
        print(f"  {s.name:<22} {s.runtime_estimate_min:>5.1f}  {opt:<9}  {s.description}")
    print("-" * 100)
    print(f"  {'TOTAL':<22} {total:>5.1f}m  (~{total/60:.1f}h)")


def run_step(step: Step) -> int:
    script_path = HERE / step.script
    if not script_path.exists():
        print(f"  ✗ {step.name}: script not found at {script_path}")
        return 1
    cmd = ["uv", "run", str(script_path), *step.extra_args]
    env = os.environ.copy()
    for key, value in DEFAULT_ENV.items():
        env.setdefault(key, str(value))
    start = time.monotonic()
    print(f"\n{'=' * 78}")
    print(f"STEP: {step.name}  (~{step.runtime_estimate_min:.0f}m)")
    print(f"  {step.description}")
    print(f"  cmd: {' '.join(cmd)}")
    print('=' * 78)
    rc = subprocess.run(cmd, cwd=ROOT, env=env).returncode
    elapsed = (time.monotonic() - start) / 60
    if rc == 0:
        print(f"\n  ✓ {step.name} ok ({elapsed:.1f}m)")
    else:
        print(f"\n  ✗ {step.name} FAILED (exit {rc}, {elapsed:.1f}m)")
    return rc


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--no-scrape", action="store_true",
                   help="Skip the per-DOT scrape step (uses existing scrape "
                        "parquet if present).")
    p.add_argument("--from", dest="from_step", metavar="STEP",
                   help="Resume from a specific step name (skip earlier steps).")
    p.add_argument("--list", action="store_true",
                   help="List all pipeline steps + runtime estimates and exit.")
    p.add_argument("--only", metavar="STEP",
                   help="Run only this one step.")
    args = p.parse_args()

    if args.list:
        list_steps()
        return 0

    steps_to_run = STEPS
    if args.only:
        matches = [s for s in STEPS if s.name == args.only]
        if not matches:
            print(f"Unknown step: {args.only}")
            print("Available:", ", ".join(s.name for s in STEPS))
            return 1
        steps_to_run = matches
    elif args.from_step:
        names = [s.name for s in STEPS]
        if args.from_step not in names:
            print(f"Unknown step: {args.from_step}")
            print("Available:", ", ".join(names))
            return 1
        idx = names.index(args.from_step)
        steps_to_run = STEPS[idx:]

    if args.no_scrape:
        steps_to_run = [s for s in steps_to_run if not s.optional]

    total_min = sum(s.runtime_estimate_min for s in steps_to_run)
    print(f"Running {len(steps_to_run)} steps, estimated total ~{total_min:.0f} min")
    print("Steps:")
    for s in steps_to_run:
        print(f"  - {s.name}")

    pipeline_start = time.monotonic()
    for step in steps_to_run:
        rc = run_step(step)
        if rc != 0:
            print(f"\n✗ Pipeline FAILED at step '{step.name}'. "
                  f"Fix and resume with: --from {step.name}")
            return rc

    total_elapsed = (time.monotonic() - pipeline_start) / 60
    print(f"\n{'=' * 78}")
    print(f"✓ Pipeline complete ({total_elapsed:.1f}m).")
    print('=' * 78)
    return 0


if __name__ == "__main__":
    sys.exit(main())
