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
import re
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
# Overridable so a monthly run is `FMCSA_DATA_TAG=YYYYMMDD ...` rather than a
# source edit. The literal is the last shipped vintage: it keeps a bare re-run
# reproducible, and drift_report fails the build if a new refresh ever reports
# an unchanged snapshot_date, so a forgotten bump cannot ship silently.
DATA_TAG = os.environ.get("FMCSA_DATA_TAG", "20260812")
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


def _undated_or_newest_dated(stem: str) -> Path:
    """`<stem>.csv` if the downloader wrote it, else the newest `<stem>_YYYYMMDD.csv`
    by the date IN THE NAME.

    Deliberately not _latest_glob: that ranks by mtime, and mtime lies. A `git
    checkout` of a stale dated file gives it a fresh mtime and it wins, which is
    exactly how a May extract got selected over an August one during this refresh.
    The date in the filename is the only trustworthy vintage.

    Also not a hardcoded dated fallback (the previous shape here): pinning
    `SMS_Input_-_Crash_20260518.csv` as the fallback means that if the undated
    download is ever missing, the build silently reads May data forever instead
    of failing. Missing everything returns the undated path, which then fails
    loudly downstream on a not-found."""
    exact = SOURCES_DIR / f"{stem}.csv"
    if exact.exists():
        return exact
    dated = sorted(
        (p for p in SOURCES_DIR.glob(f"{stem}_*.csv") if re.fullmatch(r"\d{8}", p.stem[len(stem) + 1 :])),
        key=lambda p: p.stem[len(stem) + 1 :],
        reverse=True,
    )
    return dated[0] if dated else exact


def _load_dotenv() -> None:
    """Load .env.local into the environment (never overriding what's already set).

    The scrape steps need ZENROWS_API_KEY, which lives ONLY in .env.local — and
    build_all never read it, so nothing put it in the child env. fetch_serious_
    violations then fell through to a direct connection, FMCSA's WAF blocked it,
    and 714 of 5,006 DOTs (14.3%) were written off as ordinary per-DOT errors in
    the Aug 2026 refresh. scrape_pu_history has the same dependency.

    Credentials belong in the environment the steps inherit, not in a file each
    script re-parses differently (or forgets to).
    """
    for name in (".env.local", ".env"):
        p = ROOT / name
        if not p.exists():
            continue
        for raw in p.read_text().splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip().strip("\"'")
            if k and v and k not in os.environ:
                os.environ[k] = v


_load_dotenv()


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
    # ALWAYS the tagged path — no exists() check, no mtime fallback.
    #
    # DEFAULT_ENV is evaluated at IMPORT. In a one-shot `build_all.py` the
    # fetch_serious_violations step writes serious_violations_<DATA_TAG>.parquet
    # DURING the run, so an exists() check here runs before that file is created
    # and silently binds the env to the previous vintage — the exact
    # silent-stale-read this was written to prevent. An mtime fallback is worse
    # still: restoring an old vintage via git gives it the newest mtime.
    #
    # If the tagged file is missing, add_serious_violations must fail loudly
    # rather than quietly score against months-old investigation data.
    "FMCSA_SERIOUS_VIOLATIONS": SCRAPE_DIR / f"serious_violations_{DATA_TAG}.parquet",
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
    # Pending-cancellation dates come from merge_motus: ActPendInsur froze on
    # 2026-05-14 and Motus InsHist is the only live source of
    # cancl_effective_date. _RAW is what the merge reads.
    "FMCSA_ACTPEND": MERGED_DIR / "ActPendInsur_All_With_History.csv",
    "FMCSA_ACTPEND_RAW": SOURCES_DIR / "ActPendInsur_All_With_History.csv",
    "FMCSA_MOTUS_INSHIST": SOURCES_DIR / "Motus_InsHist_All_With_History.csv",
    # Pin the lapse as-of date to the data vintage. It defaults to wall-clock
    # today, so the same inputs produced a different lapse set on each day the
    # build ran — the signal drifted without the data changing.
    "FMCSA_LAPSE_ASOF": f"{DATA_TAG[:4]}-{DATA_TAG[4:6]}-{DATA_TAG[6:]}",
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
    # Downloader writes undated names; prefer those, else newest dated legacy.
    "FMCSA_INSPECTION_FILE": _undated_or_newest_dated("SMS_Input_-_Inspection"),
    "FMCSA_VIOLATION_FILE": _undated_or_newest_dated("SMS_Input_-_Violation"),
    "FMCSA_CRASH_FILE": _undated_or_newest_dated("SMS_Input_-_Crash"),
    # Output tag for the per-DOT crash-scrape parquet (crash_indicator_<TAG>.parquet).
    # Bump this with the monthly drop so the scrape writes a fresh vintage file
    # (compute_basics globs the newest). The scraper recomputes Crash-Indicator
    # eligibility from FMCSA_CRASH_FILE's date automatically, so only this tag +
    # the dated filenames above need updating each month.
    "SMS_DATA_TAG": DATA_TAG,
    # merge_motus: events effective after this are "pending", not revocations.
    "FMCSA_SNAPSHOT_DATE": DATA_TAG,
    # scrape_pu_history derives the SMS vintage by regexing 8 digits out of
    # the crash filename — but the downloader writes an UNDATED name, so that
    # search fails and it fell back to a hardcoded 2026-05-18. Set it
    # explicitly so the scrape universe and the crash window agree with the
    # rest of the build.
    "SMS_DATA_DATE": DATA_TAG,
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
        description="Threshold SENSITIVITY study (min_insp 3/10/20, crash-per-truck by fleet size) -> national_thresholds_v2.json. NOT consumed by the app: the live cutoffs are national_thresholds.json, written by build_aggregates.",
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
    # Was hand-built once (2026-06-01) with no generator in the repo, so it kept
    # describing the May crash window through every later refresh. Now a step.
    Step(
        name="build_lane_liability",
        script="build_lane_liability.py",
        description="Per-state crash injury-share table -> lib/data/lane-liability.json",
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
    # LAST, and it reads the finished artifacts. Fails the build when a metric
    # moves implausibly OR when one that must move every refresh is byte-identical
    # to last month — the signature of a frozen window / stale source read, which
    # is invisible to every other check because a stale artifact is still valid.
    Step(
        name="drift_report",
        script="drift_report.py",
        description="Compare artifacts vs data/refresh_metrics.json; fail on implausible or absent drift",
        runtime_estimate_min=0.2,
    ),
    # Complements drift_report rather than duplicating it: drift compares us to
    # our own last refresh ("did anything change that shouldn't have?"), which is
    # blind to an error we make identically every month. This compares us to live
    # FMCSA ("are we right at all?"). Skips with a warning if FMCSA_WEBKEY is
    # unset or the API is unreachable — a third party's downtime must not fail
    # our build.
    Step(
        name="ground_truth_check",
        script="ground_truth_check.py",
        description="Sample live carriers from FMCSA's QCMobile API and verify our fields agree",
        runtime_estimate_min=0.5,
    ),
    # Reports, never gates — the checks above already decided pass/fail. Exists so
    # reviewing a refresh is reading one page instead of remembering which
    # parquets to poke at, which is how three defects shipped in Aug 2026.
    Step(
        name="refresh_summary",
        script="refresh_summary.py",
        description="Write data/refresh_reports/refresh_<TAG>.md — what moved, coverage, needs-attention",
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
