#!/usr/bin/env bash
#
# Publish the four validated carrier-audit artifacts to the knowledge-ingress
# bucket named as $1, under a vintage-tagged prefix per artifact.
#
# ONE BUCKET PER INVOCATION. Both environments get the same validated bytes, so
# refresh.yml calls this TWICE — staging, then prod:
#
#   scripts/drop_files_to_knowledge_ingress.sh goaugment-knowledge-ingress-bucket-staging
#   scripts/drop_files_to_knowledge_ingress.sh goaugment-knowledge-ingress-bucket-prod
#
# It is not one call looping over both because each environment has its own OIDC
# role, and configure-aws-credentials overwrites the job's credentials — so the
# workflow must re-assume between the two, and the buckets cannot share a loop.
# Staging runs first so a trust- or bucket-policy error surfaces before prod is
# touched; the workflow's cumulative success() then skips prod if staging fails.
#
# Dropping these files into S3 each month was the ONLY human step left in the
# carrier-intelligence pipeline; Snowpipe (AUTO_INGEST) loads them on arrival
# with no further action.
#
# Requires: TAG (the FMCSA vintage), and AWS credentials already in the env.
set -euo pipefail

cd "$(dirname "$0")/.."

BUCKET="${1:-}"
[[ -n "$BUCKET" ]] || { echo "usage: $0 <bucket-name>" >&2; exit 2; }
: "${TAG:?TAG (FMCSA vintage) must be set}"

# Prefix names MUST match the stage paths in augment-dbt
# snowflake_setup/knowledge/snowpipe/augment_carrier_audit.sql — a typo here
# lands the file somewhere no pipe reads, and nothing errors.
ARTIFACTS=(
  "data/carrier_aggregates.parquet:carrier_aggregates"
  "data/carrier_identity.parquet:carrier_identity"
  "data/carrier_risk_signals.parquet:carrier_risk_signals"
  "data/national_thresholds.json:national_thresholds"
)

# macOS first, GNU second — same order as promote.sh, so this runs locally.
filesize() { stat -f%z "$1" 2>/dev/null || stat -c%s "$1"; }
summary()  { [[ -n "${GITHUB_STEP_SUMMARY:-}" ]] && echo "$1" >> "$GITHUB_STEP_SUMMARY"; return 0; }

# No alert email covers this step (see the ordering note in refresh.yml), so a
# failure has to be visible somewhere. EXIT rather than ERR: the guards below
# fail with an explicit `exit 1`, which does not fire an ERR trap.
drop_failed() {
  local rc=$?
  (( rc == 0 )) && return
  summary ""
  summary "> **S3 drop FAILED for vintage ${TAG} → ${BUCKET} (exit ${rc}).**"
  summary "> The Snowflake drop did not happen. No alert email is sent for this step."
}
trap drop_failed EXIT

# GUARD 1 — the build on disk must BE the vintage we are labelling it with.
# Run 32754995868 uploaded an artifact whose refresh_metrics.json still read the
# PREVIOUS vintage. A green upload step says a file was uploaded, not that it was
# the file you meant; dropping a stale parquet under a fresh prefix makes
# Snowpipe ingest last month's data as this month's, silently.
BUILT=$(node -e "console.log(require('./data/refresh_metrics.json').snapshot_date||'')")
if [[ "$BUILT" != "$TAG" ]]; then
  echo "::error::refresh_metrics.json says snapshot_date=$BUILT but this run drops $TAG — refusing to upload."
  exit 1
fi

# GUARD 2 — every file exists and is big enough to be real. A truncated or
# 0-byte parquet uploads happily and fails later inside Snowflake, where the
# only trace is COPY_HISTORY.
for entry in "${ARTIFACTS[@]}"; do
  f="${entry%%:*}"
  [[ -f "$f" ]] || { echo "::error::missing $f"; exit 1; }
  if (( $(filesize "$f") < 1024 )); then
    echo "::error::$f is only $(filesize "$f")B — refusing to upload a truncated artifact."
    exit 1
  fi
done

summary "## S3 drop — vintage ${TAG} → ${BUCKET}"

for entry in "${ARTIFACTS[@]}"; do
  f="${entry%%:*}"
  key="landing/augment-carrier-audit-test/${entry##*:}/${TAG}/$(basename "$f")"

  aws s3 cp "$f" "s3://${BUCKET}/${key}" --only-show-errors

  # GUARD 3 — confirm what actually landed, for the same reason as guard 1:
  # a clean exit is not proof of a correct object.
  want=$(filesize "$f")
  got=$(aws s3api head-object --bucket "$BUCKET" --key "$key" \
          --query ContentLength --output text)
  if [[ "$want" != "$got" ]]; then
    echo "::error::s3://${BUCKET}/${key} is ${got}B but the local file is ${want}B."
    exit 1
  fi

  summary "- \`s3://${BUCKET}/${key}\` (${want} B)"
done

echo "::notice::Published ${#ARTIFACTS[@]} artifacts for vintage ${TAG} to ${BUCKET}."
