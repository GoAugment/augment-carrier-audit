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
else
  step "1/4  Download SKIPPED (--no-download)"
fi

step "2/4  Build pipeline"
uv run pipeline/fmcsa-aggregate/build_all.py "${BUILD_ARGS[@]}"

step "3/4  Validate app contract + rules + snapshots"
pnpm test

step "4/4  Summary"
REPORT="data/refresh_reports/refresh_${TAG}.md"
if [[ -f "$REPORT" ]]; then
  sed -n '1,/^## What moved/p' "$REPORT" | sed '$d'
  echo "full report: $REPORT"
else
  echo "no report written (expected $REPORT)"
fi

step "Refresh $TAG complete"
echo "finished $(date '+%Y-%m-%d %H:%M:%S')"
echo
echo "Nothing has been deployed. To promote:  scripts/promote.sh"
