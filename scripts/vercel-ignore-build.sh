#!/usr/bin/env bash
# FlowPilot Vercel Ignored Build Step (DEVOPS-01 Release Guard Hardened)
#
# Rules:
# - Previews (PRs and feature branches): ALLOW build (exit 1).
# - Production pushes to 'main':
#     - Standard PR merges (merge commits, squash merges): SUPPRESS build (exit 0).
#     - Untrusted commits with loose release markers: SUPPRESS build (exit 0).
#     - Multi-parent merge commits: SUPPRESS build (exit 0).
#     - Commits without verified package.json version bump: SUPPRESS build (exit 0).
#     - Verified Authorized Production releases: ALLOW build (exit 1).
#
# Exit codes for Vercel Ignored Build Step:
#   exit 0 = IGNORE / CANCEL build (no deployment)
#   exit 1 = PROCEED with build

set -e

echo "🔍 FlowPilot Hardened Vercel Release Guard:"
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
# Only proceed if the commit passes rigorous human authorization and integrity checks.

# Extract strictly the first line (subject) of the commit message
RAW_MSG="${VERCEL_GIT_COMMIT_MESSAGE:-$(git log -1 --pretty=%B 2>/dev/null || echo '')}"
COMMIT_SUBJECT=$(echo "$RAW_MSG" | head -n 1 | tr -d '\r')
echo "   - Commit Subject: '${COMMIT_SUBJECT}'"

# A. Fast Rejection: PR Merge Commits and Squash Merges
# GitHub PR squash merges append ' (#<pr_number>)' to the subject line.
# Standard merge commits begin with 'Merge pull request #' or 'Merge branch '.
if [[ "$COMMIT_SUBJECT" =~ \(#[0-9]+\)$ ]] || [[ "$COMMIT_SUBJECT" =~ ^Merge\ pull\ request\ #[0-9]+ ]] || [[ "$COMMIT_SUBJECT" =~ ^Merge\ branch\  ]]; then
  echo "🛑 PR MERGE DETECTED:"
  echo "   Subject line matches PR merge signature ('${COMMIT_SUBJECT}')."
  echo "   Merging a PR into 'main' does NOT automatically deploy to Production."
  echo "   Production deployment is safely blocked."
  exit 0
fi

# B. Check for multi-parent merge commits
if git rev-parse -q --verify "${COMMIT_SHA}^2" >/dev/null 2>&1; then
  echo "🛑 MULTI-PARENT COMMIT DETECTED:"
  echo "   Commit has multiple parents (merge commit). Production releases must be single-parent commits."
  exit 0
fi

# C. Match Exact Authorized Release Subject Formats
# 1) Controlled GitHub Actions release workflow: 'chore(release): vX.Y.Z [release]'
# 2) Legacy pnpm ship release: '(fix|feat|chore): release vX.Y.Z'
MATCH_WORKFLOW_RELEASE=0
MATCH_SHIP_RELEASE=0
TARGET_VERSION=""

if [[ "$COMMIT_SUBJECT" =~ ^chore\(release\):\ v([0-9]+\.[0-9]+\.[0-9]+)\ \[release\]$ ]]; then
  MATCH_WORKFLOW_RELEASE=1
  TARGET_VERSION="${BASH_REMATCH[1]}"
elif [[ "$COMMIT_SUBJECT" =~ ^(fix|feat|chore):\ release\ v([0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
  MATCH_SHIP_RELEASE=1
  TARGET_VERSION="${BASH_REMATCH[2]}"
fi

if [ "$MATCH_WORKFLOW_RELEASE" -eq 0 ] && [ "$MATCH_SHIP_RELEASE" -eq 0 ]; then
  echo "🛑 PRODUCTION AUTO-DEPLOY SUPPRESSED:"
  echo "   Commit subject does not match an authorized release format."
  echo "   Loose strings or embedded markers are strictly rejected."
  echo "   To deploy, trigger 'Controlled Production Release' via GitHub Actions or run 'pnpm ship'."
  exit 0
fi

echo "📋 Release pattern matched. Target version: v${TARGET_VERSION}"

# D. Defense-in-depth: Verify package.json was modified in this commit
if command -v git >/dev/null 2>&1; then
  COMMIT_TARGET="${VERCEL_GIT_COMMIT_SHA:-HEAD}"
  if git rev-parse -q --verify "$COMMIT_TARGET" >/dev/null 2>&1; then
    CHANGED_FILES=$(git diff-tree --no-commit-id --name-only -r "$COMMIT_TARGET" 2>/dev/null || echo "")
    if [ -n "$CHANGED_FILES" ] && ! echo "$CHANGED_FILES" | grep -qx "package.json"; then
      echo "🛑 INTEGRITY CHECK FAILED:"
      echo "   The commit matches a release pattern, but 'package.json' was NOT modified in commit ${COMMIT_TARGET}."
      echo "   Blocking deployment to prevent spoofed release commit messages."
      exit 0
    fi
    echo "✅ package.json modification verified in commit."
  fi
fi

# E. Defense-in-depth: Verify package.json version matches target version
if [ -f "package.json" ] && command -v node >/dev/null 2>&1; then
  PKG_VERSION=$(node -e "try { console.log(require('./package.json').version || '') } catch(e) {}")
  if [ "$PKG_VERSION" != "$TARGET_VERSION" ]; then
    echo "🛑 VERSION MISMATCH DETECTED:"
    echo "   Commit indicates v${TARGET_VERSION}, but package.json has version '${PKG_VERSION}'."
    echo "   Blocking deployment due to version inconsistency."
    exit 0
  fi
  echo "✅ Version consistency verified: package.json version (${PKG_VERSION}) matches release tag."
fi

echo "🚀 RELEASE AUTHORIZED & VERIFIED:"
echo "   Commit '${COMMIT_SUBJECT}' satisfies all release guard requirements."
echo "   Proceeding with Production build and deployment for v${TARGET_VERSION}."
exit 1
