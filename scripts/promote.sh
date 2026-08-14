#!/usr/bin/env bash
#
# Promote the current build to production: deploy, then upload the parquets to
# Blob. Separate from refresh.sh on purpose — this is the outward-facing step.
#
#   scripts/promote.sh              # deploy + upload
#   scripts/promote.sh --dry-run    # show what would happen
#
# ORDER MATTERS. /api/analyze and /api/email bundle carrier_aggregates.parquet,
# so they flip atomically with the deploy. /api/check reads it from Blob, so it
# is exposed to whichever half is older:
#
#   deploy first  -> /api/check is briefly new-code + old-parquet, and recovers
#                    as soon as the upload finishes (last step, self-healing).
#   upload first  -> live production breaks immediately on the old code, and
#                    STAYS broken until the deploy lands.
#
# The Aug 2026 refresh removed 17 columns the previous adapter referenced
# (inspections_24mo among them), so this is a real failure mode, not theory.
# Deploy first.
set -euo pipefail

cd "$(dirname "$0")/.."

DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1

step() { printf '\n\033[1m=== %s ===\033[0m\n' "$1"; }

if [[ -n "$(git status --porcelain data lib pipeline 2>/dev/null)" ]]; then
  echo "Refusing to promote: uncommitted changes in data/, lib/ or pipeline/." >&2
  echo "What reaches production should be exactly what is committed." >&2
  git status --short data lib pipeline >&2
  exit 1
fi

step "Preflight"
for f in data/carrier_aggregates.parquet data/carrier_identity.parquet; do
  [[ -f "$f" ]] || { echo "missing $f" >&2; exit 1; }
  printf '  %-42s %s MB\n' "$f" "$(( $(stat -f%z "$f" 2>/dev/null || stat -c%s "$f") / 1048576 ))"
done
pnpm check:parquet

if [[ "$DRY" == "1" ]]; then
  step "Dry run — stopping before deploy"
  echo "would run: npx vercel --prod --yes"
  echo "then     : node scripts/upload-identity-blob.mjs"
  exit 0
fi

step "1/2  Deploy to production"
npx vercel --prod --yes

step "2/2  Upload parquets to Blob"
if [[ -z "${BLOB_READ_WRITE_TOKEN:-}" && -f .env.local ]]; then
  BLOB_READ_WRITE_TOKEN="$(grep '^BLOB_READ_WRITE_TOKEN=' .env.local | cut -d= -f2- | tr -d '"'"'"' ')"
  export BLOB_READ_WRITE_TOKEN
fi
[[ -n "${BLOB_READ_WRITE_TOKEN:-}" ]] || { echo "BLOB_READ_WRITE_TOKEN unset" >&2; exit 1; }
node scripts/upload-identity-blob.mjs

step "Promoted"
echo "Verify a carrier end to end, e.g.:"
echo '  curl -s -X POST https://augment-carrier-audit.vercel.app/api/analyze \'
echo "    -H 'Content-Type: application/json' -d '{\"input\":\"3008423\"}'"
