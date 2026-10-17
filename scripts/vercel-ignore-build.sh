#!/usr/bin/env bash
# FlowPilot Vercel Ignored Build Step (DEVOPS-01 Release Guard)
#
# Rules:
# - Previews (PRs and feature branches): ALLOW build (exit 1).
# - Production pushes to 'main' without release authorization: SUPPRESS build (exit 0).
# - Authorized Production releases: ALLOW build (exit 1).
#
# Exit codes for Vercel Ignored Build Step:
#   exit 0 = IGNORE / CANCEL build (no deployment)
#   exit 1 = PROCEED with build

set -e

echo "🔍 FlowPilot Vercel Build Filter:"
echo "   - Environment: ${VERCEL_ENV:-unknown}"
echo "   - Branch/Ref:  ${VERCEL_GIT_COMMIT_REF:-unknown}"
echo "   - Commit SHA:  ${VERCEL_GIT_COMMIT_SHA:-unknown}"

# 1. Preview environments (PRs and feature branches) always proceed
if [ "$VERCEL_ENV" = "preview" ]; then
  echo "✅ PREVIEW: Proceeding with Preview deployment for branch '${VERCEL_GIT_COMMIT_REF}'."
  exit 1
fi

# 2. Production deployments (pushes targeting main)
# Suppress automatic deployment on standard PR merges.
# Only proceed if the commit is an explicitly authorized release.
IS_AUTHORIZED_RELEASE=0

# Check commit message for release markers:
# - "[release]" (new PR-based release workflow marker)
# - "(fix|feat|chore|release): release vX.Y.Z" (legacy pnpm ship marker)
# - Tag pattern vX.Y.Z
if [[ "$VERCEL_GIT_COMMIT_MESSAGE" == *"[release]"* ]]; then
  IS_AUTHORIZED_RELEASE=1
elif [[ "$VERCEL_GIT_COMMIT_MESSAGE" =~ (fix|feat|chore|release):\ release\ v[0-9]+\.[0-9]+\.[0-9]+ ]]; then
  IS_AUTHORIZED_RELEASE=1
elif [[ "$VERCEL_GIT_COMMIT_REF" =~ ^v[0-9]+\.[0-9]+\.[0-9]+ ]]; then
  IS_AUTHORIZED_RELEASE=1
fi

if [ "$IS_AUTHORIZED_RELEASE" -eq 1 ]; then
  echo "🚀 RELEASE AUTHORIZED: Release marker detected in commit message or ref."
  echo "   Proceeding with Production build and deployment."
  exit 1
fi

# If reached here: standard push to main (e.g. PR merge) that is NOT a release.
echo "🛑 PRODUCTION AUTO-DEPLOY SUPPRESSED:"
echo "   Merging a PR into 'main' does NOT automatically deploy to Production."
echo "   Production deployment is safely blocked until explicitly triggered by the operator."
echo "   To deploy a release, trigger the 'Production Release' GitHub workflow or run pnpm ship."
exit 0
