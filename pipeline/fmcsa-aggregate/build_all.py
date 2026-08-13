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
MERGED_DIR = SOURCES_DIR / "merged"  # merge_motus.py output (L&I + Motus splice)
# Vintage of this refresh. Drives the scrape output filenames AND which scrape
# vintage the pipeline reads back, so the two can never drift apart.
DATA_TAG = "20260812"
LIB_DATA_DIR = ROOT / "lib" / "data"


def _first_existing(*names: str) -> Path:
    """First source file that exists, else the preferred (first) name. Lets a
    source come from either of two filenames — e.g. inshist as the Socrata CSV
    mirror (`inshist_allwithhistory.csv`, auto-downloaded) or FMCSA's native
    `inshist_allwithhistory.txt`."""
    for n in names:
        p = SOURCES_DIR / n
        if p.exists():
            return p
    return SOURCES_DIR / names[0]


def _latest_glob(pattern: str, fallback: str, base: Path | None = None) -> Path:
    """Newest file matching a glob (handles undated downloader output and dated
    legacy files, e.g. Revocation_-_All_With_History*.csv). Defaults to
    SOURCES_DIR; pass `base` for artifacts that live elsewhere, e.g. the scrape
    outputs in SCRAPE_DIR."""
    root = base or SOURCES_DIR
    matches = sorted(root.glob(pattern), key=lambda p: p.stat().st_mtime, reverse=True)
    return matches[0] if matches else root / fallback


DEFAULT_ENV = {
    "FMCSA_OUTPUT_DIR": DATA_DIR,
    # build_aggregates.py resolves a few inputs relative to INPUT_DIR/REFRESH_DIR
    # rather than via a per-file env var (notably CRASH_PATH = INPUT_DIR/
    # Crash_File.csv, and the motor-carrier-census _refreshable lookup). Point
    # both at data/sources so it finds the promoted, undated refresh files
    # instead of the ~/Downloads default.
    "FMCSA_INPUT_DIR": SOURCES_DIR,
    "FMCSA_REFRESH_DIR": SOURCES_DIR,
    "FMCSA_MOTOR_CARRIER_CENSUS": SOURCES_DIR / "SMS_Input_-_Motor_Carrier_Census_Information.csv",
    "FMCSA_PARQUET": DATA_DIR / "carrier_aggregates.parquet",
    "FMCSA_IDENTITY_PARQUET": DATA_DIR / "carrier_identity.parquet",
    "FMCSA_THRESHOLDS_OUT": DATA_DIR / "national_thresholds.json",
    "FMCSA_THRESHOLDS_V2_OUT": DATA_DIR / "national_thresholds_v2.json",
    "FMCSA_SCRAPE_DIR": SCRAPE_DIR,
    # Newest vintage, not a pinned filename — the scrape writes
    # serious_violations_<SMS_DATA_TAG>.parquet, so a pin silently keeps
    # reading the old one after a refresh. The "_2" prefix excludes the
    # sibling serious_violations_status_* files.
    # Keyed on DATA_TAG, NOT newest-by-mtime: mtime lies the moment a file is
    # restored or touched (a `git checkout` of the old vintage gave the May file
    # a newer mtime than the August scrape, so "newest" silently selected the
    # stale one). The tag is the vintage; use it.
    "FMCSA_SERIOUS_VIOLATIONS": (
        SCRAPE_DIR / f"serious_violations_{DATA_TAG}.parquet"
        if (SCRAPE_DIR / f"serious_violations_{DATA_TAG}.parquet").exists()
        else _latest_glob("serious_violations_2*.parquet",
                          "serious_violations_20260514.parquet", base=SCRAPE_DIR)
    ),
    # Revocations come from merge_motus.py, NOT the raw download: FMCSA retired
    # the L&I Revocation feed on 2026-05-14 and everything since lives in the
    # Motus datasets. The merged file is the old schema with the Motus events
    # spliced on, so downstream steps are unchanged. _RAW is what merge reads.
    "FMCSA_REVOCATION": MERGED_DIR / "Revocation_-_All_With_History.csv",
    "FMCSA_REVOCATION_RAW": _latest_glob(
        "Revocation_-_All_With_History*.csv",  # undated download or dated legacy
        "Revocation_-_All_With_History.csv",
    ),
    "FMCSA_MERGED_DIR": MERGED_DIR,
    "FMCSA_MOTUS_REVSUSP": SOURCES_DIR / "Motus_RevokeSuspend_All_With_History.csv",
    "FMCSA_MOTUS_AUTHHIST": SOURCES_DIR / "Motus_AuthHist_All_With_History.csv",
    "FMCSA_PENDING_SUSPENSION": MERGED_DIR / "motus_pending_suspension.csv",
    "FMCSA_INSHIST": _first_existing(
        "inshist_allwithhistory.csv",  # Socrata mirror (auto-downloaded), preferred
        "inshist_allwithhistory.txt",  # FMCSA native dump (legacy/manual)
    ),
    "FMCSA_ENFORCEMENT_XLSX": SOURCES_DIR / "closed_enforcement_cases_20260515005306.xlsx",
    "FMCSA_ACTPEND": SOURCES_DIR / "ActPendInsur_All_With_History.csv",
    "FMCSA_PASSPROP": _latest_glob(
        "SMS_AB_PassProperty*.csv",  # undated download or dated legacy
        "SMS_AB_PassProperty.csv",
    ),
    # Carrier auth comes from merge_motus.merge_insurance: the L&I feed is frozen
    # at 2026-05-14 and BIPD-on-file is rebuilt from Motus_Insur's BMC-91 filings.
    # (NOT from Motus_Carrier.BIPD_FILE — different field, see merge_motus.)
    "FMCSA_CARRIER_AUTH": MERGED_DIR / "Carrier_All_With_History.csv",
    "FMCSA_CARRIER_AUTH_RAW": SOURCES_DIR / "Carrier_All_With_History.csv",
    "FMCSA_MOTUS_CARRIER": SOURCES_DIR / "Motus_Carrier_All_With_History.csv",
    "FMCSA_MOTUS_INSUR": SOURCES_DIR / "Motus_Insur_All_With_History.csv",
    # Downloader writes undated names; prefer those, fall back to dated legacy.
    "FMCSA_INSPECTION_FILE": _first_existing("SMS_Input_-_Inspection.csv", "SMS_Input_-_Inspection_20260518.csv"),
    "FMCSA_VIOLATION_FILE": _first_existing("SMS_Input_-_Violation.csv", "SMS_Input_-_Violation_20260518.csv"),
    "FMCSA_CRASH_FILE": _first_existing("SMS_Input_-_Crash.csv", "SMS_Input_-_Crash_20260518.csv"),
    # Output tag for the per-DOT crash-scrape parquet (crash_indicator_<TAG>.parquet).
    # Bump this with the monthly drop so the scrape writes a fresh vintage file
    # (compute_basics globs the newest). The scraper recomputes Crash-Indicator
    # eligibility from FMCSA_CRASH_FILE's date automatically, so only this tag +
    # the dated filenames above need updating each month.
    "SMS_DATA_TAG": DATA_TAG,
    # merge_motus: events effective after this are "pending", not revocations.
    "FMCSA_SNAPSHOT_DATE": DATA_TAG,
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
    # Most steps are Polars scripts in this directory run under `uv run`. A few
    # live at the repo root and run under a different interpreter (the DuckDB
    # risk-signals builder is Node) — these two fields cover that.
    runner: tuple[str, ...] = ("uv", "run")
    repo_root_script: bool = False  # resolve `script` against ROOT, not HERE


STEPS: list[Step] = [
    # MUST be first: everything downstream that reads revocations (add_revocations,
    # build_insurer_risk, build_risk_signals' shut-down universe) consumes the
    # merged output, not the frozen raw feed.
    Step(
        name="merge_motus",
        script="merge_motus.py",
        description="Splice live Motus authority/insurance events onto the retired L&I feeds (frozen 2026-05-14)",
        runtime_estimate_min=0.5,
    ),
    Step(
        name="build_aggregates",
        script="build_aggregates.py",
        description="Core schema + 5 public BASIC measures from bulk SMS file",
        runtime_estimate_min=0.5,
    ),
    Step(
        name="add_revocations",
        script="add_revocations.py",
        description="Revocation history + prior-revoke flag",
        runtime_estimate_min=0.2,
    ),
    Step(
        name="add_inshist",
        script="add_inshist.py",
        description="Insurance cancellation history (distinct policies, "
                    "rapid-replace flag)",
        runtime_estimate_min=0.2,
    ),
    Step(
        name="add_enforcement",
        script="add_enforcement.py",
        description="Enforcement case counts + settlement totals",
        runtime_estimate_min=0.2,
    ),
    Step(
        name="add_pending_lapse",
        script="add_pending_lapse.py",
        description="Imminent BIPD insurance lapse (terminal cancellation, no "
                    "replacement, no other active coverage)",
        runtime_estimate_min=0.2,
    ),
    Step(
        name="add_fleet_sharing",
        script="add_fleet_sharing.py",
        description="Cross-DOT VIN overlap (largest sibling for "
                    "chameleon-shared-fleet rule)",
        runtime_estimate_min=0.5,
    ),
    Step(
        name="add_plausibility",
        script="add_plausibility.py",
        description="Fleet-size plausibility heuristic (inflated PU detection)",
        runtime_estimate_min=0.2,
    ),
    Step(
        name="add_chameleon_signals",
        script="add_chameleon_signals.py",
        description="Diffuse VIN share + insurance distinct-policy / "
                    "replace counts",
        runtime_estimate_min=0.5,
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
        runtime_estimate_min=0.2,
    ),
    Step(
        name="add_high_risk",
        script="add_high_risk.py",
        description="FAST Act §5305 High-Risk flag (2+ of UD/CI/HOS/VM "
                    "at >=90th percentile)",
        runtime_estimate_min=0.2,
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
        runtime_estimate_min=0.2,
    ),
    Step(
        name="compute_iss",
        script="compute_iss.py",
        description="ISS-CSA score (1-100, three tiers)",
        runtime_estimate_min=0.5,
    ),
    Step(
        name="recompute_thresholds",
        script="recompute_thresholds.py",
        description="Peer-group P85/P95/P99 cutoffs for analyzer.ts",
        runtime_estimate_min=0.2,
    ),
    # --- Risk-axis derived data (previously run by hand; now part of the refresh) ---
    Step(
        name="add_phantom_fleet",
        script="add_phantom_fleet.py",
        description="Phantom-fleet signal: distinct inspected VINs vs reported PU",
        runtime_estimate_min=0.2,
    ),
    # Must precede prune_app_parquet (it adds app-facing columns) and follow
    # merge_motus (it reads the pending-suspension sidecar).
    Step(
        name="add_insurance_suspension",
        script="add_insurance_suspension.py",
        description="FMCSA involuntary suspension for lack of insurance (pending + effective)",
        runtime_estimate_min=0.3,
    ),
    Step(
        name="add_phy_zip",
        script="add_phy_zip.py",
        description="Physical-address ZIP (from carrier_identity) for the ZIP-risk marker",
        runtime_estimate_min=0.2,
    ),
    Step(
        name="add_geo_mismatch",
        script="add_geo_mismatch.py",
        description="Home-state inspection share (registration vs where cited)",
        runtime_estimate_min=0.2,
    ),
    Step(
        name="build_insurer_risk",
        script="build_insurer_risk.py",
        description="Insurer-reputation lift table -> lib/data/insurer-risk.json",
        runtime_estimate_min=0.2,
    ),
    Step(
        name="build_zip_risk",
        script="build_zip_risk.py",
        description="Per-ZIP shutdown-lift table -> lib/data/zip-risk.json",
        runtime_estimate_min=0.2,
    ),
    # MUST stay ahead of prune_app_parquet: it reads home_state_insp_share,
    # which is a build-only column the prune step drops. Running it after the
    # prune (or standalone against the checked-in parquet) fails with a DuckDB
    # Binder error — which is why data/carrier_risk_signals.parquet silently
    # went stale once add_geo_mismatch introduced that dependency.
    Step(
        name="build_risk_signals",
        script="scripts/build_risk_signals.cjs",
        description="Identity risk-signal sidecar (free-email / residential / shutdown links) -> data/carrier_risk_signals.parquet",
        runtime_estimate_min=2.0,
        runner=("node",),
        repo_root_script=True,
    ),
    Step(
        name="prune_app_parquet",
        script="prune_app_parquet.py",
        description="Drop build-only columns; keep the checked-in aggregate at the app contract",
        runtime_estimate_min=0.2,
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
    script_path = (ROOT if step.repo_root_script else HERE) / step.script
    if not script_path.exists():
        print(f"  ✗ {step.name}: script not found at {script_path}")
        return 1
    cmd = [*step.runner, str(script_path), *step.extra_args]
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
