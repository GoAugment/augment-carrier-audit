#!/usr/bin/env bash
#
# One command for a monthly FMCSA refresh: download -> build -> validate -> report.
#
#   scripts/refresh.sh 20260912            # full run for the Sept vintage
#   scripts/refresh.sh 20260912 --no-download   # sources already in data/sources
#   scripts/refresh.sh 20260912 --no-scrape     # reuse the existing scrape vintage
#
# Deliberately does NOT deploy. Promotion is outward-facing and is its own
# explicit step (scripts/promote.sh) — a refresh that silently reached
# production would remove the one place a human still decides.
#
# The vintage is passed, not edited into a source file. Everything downstream
# (scrape filenames, window starts, artifact stamps) derives from it, and
# drift_report fails the build if a "new" refresh reports an unchanged
# snapshot_date — so a forgotten bump cannot ship quietly.
set -euo pipefail

cd "$(dirname "$0")/.."

TAG="${1:-}"
if [[ -z "$TAG" || ! "$TAG" =~ ^[0-9]{8}$ ]]; then
  echo "usage: scripts/refresh.sh YYYYMMDD [--no-download] [--no-scrape]" >&2
  echo "  YYYYMMDD = the FMCSA SMS snapshot date for this vintage" >&2
  exit 2
fi
shift

DOWNLOAD=1
BUILD_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --no-download) DOWNLOAD=0 ;;
    --no-scrape)   BUILD_ARGS+=("--no-scrape") ;;
    *)             BUILD_ARGS+=("$arg") ;;
  esac
done

export FMCSA_DATA_TAG="$TAG"

step() { printf '\n\033[1m=== %s ===\033[0m\n' "$1"; }

step "Refresh $TAG"
echo "started $(date '+%Y-%m-%d %H:%M:%S')"

if [[ "$DOWNLOAD" == "1" ]]; then
  step "1/4  Download FMCSA sources"
  uv run pipeline/fmcsa-aggregate/refresh_sms_data.py
  # One file still has no machine-readable source: the data.transportation.gov
  # mirror for closed enforcement cases is dead, so it needs a browser export.
  # Warn rather than fail — the pipeline runs fine on the previous copy.
  if ! ls data/sources/closed_enforcement_cases_*.xlsx >/dev/null 2>&1; then
    echo "WARNING: no closed_enforcement_cases_*.xlsx — enforcement counts will be stale."
    echo "         Export it manually; see data/sources/README.md."
  fi

  # PROMOTE the staged download into data/sources/.
  #
  # refresh_sms_data.py writes to data/sources/refresh_<stamp>/, while the build
  # reads data/sources/. Moving between the two was a MANUAL step buried in the
  # README — so `pnpm refresh <tag>` downloaded 8.9GB of fresh data and then
  # built from the previous month's files, silently and with every check green.
  # Caught only by comparing row counts after a real end-to-end run: staging had
  # 258,353 crash rows, the build used 258,069.
  #
  # Promote only what the manifest marks ok, so a partial download cannot half-
  # replace the source set and leave the build reading a mix of two vintages.
  STAGING="$(ls -dt data/sources/refresh_* 2>/dev/null | head -1 || true)"
  if [[ -n "$STAGING" && -f "$STAGING/MANIFEST.txt" ]]; then
    if ! grep -q '^status=complete' "$STAGING/MANIFEST.txt"; then
      echo "Refusing to promote: $STAGING/MANIFEST.txt is not status=complete." >&2
      exit 1
    fi
    promoted=0; skipped=0
    while IFS=$'\t' read -r _did fname state; do
      [[ "$state" == "ok" && -f "$STAGING/$fname" ]] || { [[ -n "${fname:-}" ]] && skipped=$((skipped+1)); continue; }
      mv -f "$STAGING/$fname" "data/sources/$fname"
      promoted=$((promoted+1))
    done < <(grep -E $'\t(ok|MISSING)$' "$STAGING/MANIFEST.txt")
    echo "promoted $promoted file(s) from $STAGING into data/sources/ (skipped $skipped)"
    rmdir "$STAGING" 2>/dev/null || echo "  (left $STAGING in place — not empty)"
  else
    echo "no staged download found to promote (nothing new was fetched)"
  fi
else
  step "1/4  Download SKIPPED (--no-download)"
fi

step "2/4  Build pipeline"
# ${arr[@]+"${arr[@]}"} — the bash 3.2 idiom for "expand only if set". macOS
# ships bash 3.2, where `set -u` treats an EMPTY array expansion as unbound and
# aborts. That made the no-flags invocation — `pnpm refresh <tag>`, i.e. exactly
# what a scheduled run would use — fail after the ~20 minutes of downloads,
# while every flagged invocation worked. Found only by running it for real.
uv run pipeline/fmcsa-aggregate/build_all.py ${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"}

step "3/4  Validate app contract + rules + snapshots"
# NOT under `set -e`. Validation failing is exactly when the run report matters
# most, and aborting here would skip it — the first real run of this script died
# on a known-failing fixture and printed a wall of test output with no summary.
# Capture the status, always report, then exit with it.
set +e
pnpm test
TEST_STATUS=$?
set -e
[[ "$TEST_STATUS" == "0" ]] || echo "VALIDATION FAILED (exit $TEST_STATUS) — see output above."

step "4/4  Summary"
# Regenerate now that the test outcome is known. build_all already wrote a
# report, but it runs before validation and would claim "nothing needs
# attention" with a red test. Idempotent — it only re-reads persisted artifacts.
FMCSA_SNAPSHOT_DATE="$TAG" FMCSA_VALIDATION_STATUS="$TEST_STATUS" \
  uv run pipeline/fmcsa-aggregate/refresh_summary.py >/dev/null

REPORT="data/refresh_reports/refresh_${TAG}.md"
if [[ -f "$REPORT" ]]; then
  sed -n '1,/^## What moved/p' "$REPORT" | sed '$d'
  echo "full report: $REPORT"
else
  echo "no report written (expected $REPORT)"
fi

step "Refresh $TAG complete"
echo "finished $(date '+%Y-%m-%d %H:%M:%S')"
if [[ "$TEST_STATUS" != "0" ]]; then
  echo
  echo "Pipeline built, but VALIDATION FAILED — do not promote until resolved."
  exit "$TEST_STATUS"
fi
echo
echo "Nothing has been deployed. To promote:  scripts/promote.sh"
