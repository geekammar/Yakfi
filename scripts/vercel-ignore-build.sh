#!/usr/bin/env bash
# FlowPilot Vercel Ignored Build Step (DEVOPS-01D Simplified Auto-Deploy)
#
# Rules:
# 1. Preview environments (PRs and feature branches): ALLOW build (exit 1).
# 2. Production deployments (pushes targeting main):
#    - Explicit skip markers ([skip vercel], [skip ci], [no deploy]): SUPPRESS build (exit 0).
#    - Approved PR merges, direct commits, and legacy release commits: ALLOW build (exit 1).
#    - Corrupted or invalid SemVer in package.json: SUPPRESS build (exit 0).
#
# Exit codes for Vercel Ignored Build Step:
#   exit 0 = IGNORE / CANCEL build (no deployment)
#   exit 1 = PROCEED with build

set -e

echo "🔍 FlowPilot Vercel Release Guard (DEVOPS-01D):"
echo "   - Environment: ${VERCEL_ENV:-unknown}"
echo "   - Branch/Ref:  ${VERCEL_GIT_COMMIT_REF:-unknown}"
echo "   - Commit SHA:  ${VERCEL_GIT_COMMIT_SHA:-unknown}"

# 1. Preview environments (PRs and feature branches) always proceed
if [ "$VERCEL_ENV" = "preview" ]; then
  echo "✅ PREVIEW: Proceeding with Preview deployment for branch '${VERCEL_GIT_COMMIT_REF}'."
  exit 1
fi

# 2. Production deployments (pushes targeting main)
# Extract strictly the first line (subject) of the commit message
RAW_MSG="${VERCEL_GIT_COMMIT_MESSAGE:-$(git log -1 --pretty=%B 2>/dev/null || echo '')}"
COMMIT_SUBJECT=$(echo "$RAW_MSG" | head -n 1 | tr -d '\r')
echo "   - Commit Subject: '${COMMIT_SUBJECT}'"

# A. Fast Rejection: Explicit skip markers
if [[ "$COMMIT_SUBJECT" =~ \[skip\ vercel\] ]] || [[ "$COMMIT_SUBJECT" =~ \[skip\ ci\] ]] || [[ "$COMMIT_SUBJECT" =~ \[no\ deploy\] ]]; then
  echo "🛑 DEPLOYMENT SKIPPED:"
  echo "   Commit subject contains explicit skip marker ('${COMMIT_SUBJECT}')."
  echo "   Vercel production build safely suppressed."
  exit 0
fi

# B. Defense-in-depth: Validate package.json SemVer format
if [ -f "package.json" ] && command -v node >/dev/null 2>&1; then
  PKG_VERSION=$(node -e "try { console.log(require('./package.json').version || '') } catch(e) {}")
  if [ -z "$PKG_VERSION" ] || ! [[ "$PKG_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "🛑 INVALID VERSION DETECTED:"
    echo "   package.json must contain a valid SemVer string (got '${PKG_VERSION}')."
    echo "   Blocking deployment due to version format inconsistency."
    exit 0
  fi
  echo "✅ SemVer version verified: ${PKG_VERSION}"
fi

# C. Automatic Production Deployment on Approved Merge
echo "🚀 PRODUCTION DEPLOYMENT PROCEEDING:"
echo "   Commit '${COMMIT_SUBJECT}' satisfies all production deployment criteria."
echo "   Proceeding with Vercel Production build."
exit 1
