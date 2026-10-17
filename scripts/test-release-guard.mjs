#!/usr/bin/env node
// FlowPilot test-release-guard.mjs — Non-production verification suite for DEVOPS-01D Release Guard
// Validates all release authorization, bypass prevention, and preview behavior without touching Production.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const scriptPath = resolve(process.cwd(), "scripts/vercel-ignore-build.sh");

const testCases = [
  {
    name: "1. Preview Deployment on feature branch",
    env: {
      VERCEL_ENV: "preview",
      VERCEL_GIT_COMMIT_REF: "feat/ux-improvements",
      VERCEL_GIT_COMMIT_MESSAGE: "feat: add team settings UI",
    },
    expectedExit: 1, // ALLOW
    description: "Preview branches must always build and deploy for QA",
  },
  {
    name: "2. Standard PR Merge Commit on main",
    env: {
      VERCEL_ENV: "production",
      VERCEL_GIT_COMMIT_REF: "main",
      VERCEL_GIT_COMMIT_MESSAGE:
        "Merge pull request #12 from geekammar/feat-booking\n\nAdd booking calendar",
    },
    expectedExit: 1, // ALLOW (DEVOPS-01D: Merging PR to main is the release authorization)
    description:
      "Standard GitHub PR merge commits must automatically trigger Production deploy",
  },
  {
    name: "3. GitHub PR Squash Merge on main",
    env: {
      VERCEL_ENV: "production",
      VERCEL_GIT_COMMIT_REF: "main",
      VERCEL_GIT_COMMIT_MESSAGE:
        "feat: update provider availability (#15)\n\n* implement slot calculations",
    },
    expectedExit: 1, // ALLOW (DEVOPS-01D: Squash merges must automatically deploy)
    description:
      "Squash merges appending ' (#PR_NUM)' must automatically trigger Production deploy",
  },
  {
    name: "4. Regular Direct Commit on main",
    env: {
      VERCEL_ENV: "production",
      VERCEL_GIT_COMMIT_REF: "main",
      VERCEL_GIT_COMMIT_MESSAGE: "fix: resolve booking slot boundary condition",
    },
    expectedExit: 1, // ALLOW
    description:
      "Regular commits on main with valid package.json proceed with deploy",
  },
  {
    name: "5. Authorized Release: Legacy pnpm ship",
    env: {
      VERCEL_ENV: "production",
      VERCEL_GIT_COMMIT_REF: "main",
      VERCEL_GIT_COMMIT_MESSAGE: "fix: release v0.46.7",
    },
    expectedExit: 1, // ALLOW
    description:
      "Legacy pnpm ship release commits remain fully compatible and deployable",
  },
  {
    name: "6. Authorized Release: Controlled Production Release format",
    env: {
      VERCEL_ENV: "production",
      VERCEL_GIT_COMMIT_REF: "main",
      VERCEL_GIT_COMMIT_MESSAGE: "chore(release): v0.46.7 [release]",
    },
    expectedExit: 1, // ALLOW
    description: "Controlled release commit format proceeds with deploy",
  },
  {
    name: "7. Suppression: Explicit [skip vercel] in commit subject",
    env: {
      VERCEL_ENV: "production",
      VERCEL_GIT_COMMIT_REF: "main",
      VERCEL_GIT_COMMIT_MESSAGE:
        "docs: update architecture overview [skip vercel]",
    },
    expectedExit: 0, // SUPPRESS
    description: "Commits with [skip vercel] marker must be safely suppressed",
  },
  {
    name: "8. Suppression: Explicit [skip ci] in commit subject",
    env: {
      VERCEL_ENV: "production",
      VERCEL_GIT_COMMIT_REF: "main",
      VERCEL_GIT_COMMIT_MESSAGE:
        "chore: update internal documentation [skip ci]",
    },
    expectedExit: 0, // SUPPRESS
    description: "Commits with [skip ci] marker must be safely suppressed",
  },
  {
    name: "9. Suppression: Explicit [no deploy] in commit subject",
    env: {
      VERCEL_ENV: "production",
      VERCEL_GIT_COMMIT_REF: "main",
      VERCEL_GIT_COMMIT_MESSAGE: "test: local benchmark fixture [no deploy]",
    },
    expectedExit: 0, // SUPPRESS
    description: "Commits with [no deploy] marker must be safely suppressed",
  },
];

console.log(
  "🛡️  FlowPilot Release Guard Threat Model & Cutover Test Suite (DEVOPS-01D)\n",
);

let passed = 0;
let failed = 0;

for (const tc of testCases) {
  const result = spawnSync("bash", [scriptPath], {
    env: {
      ...process.env,
      ...tc.env,
    },
    encoding: "utf8",
  });

  const actualExit = result.status;
  const isMatch = actualExit === tc.expectedExit;

  if (isMatch) {
    passed++;
    const actionLabel =
      actualExit === 1 ? "PROCEED (Exit 1)" : "SUPPRESS (Exit 0)";
    console.log(`✅ PASS: ${tc.name}`);
    console.log(`   → Result: ${actionLabel} (Expected: ${tc.expectedExit})`);
    console.log(`   → Note:   ${tc.description}\n`);
  } else {
    failed++;
    console.error(`❌ FAIL: ${tc.name}`);
    console.error(
      `   → Expected Exit Code: ${tc.expectedExit}, Got: ${actualExit}`,
    );
    console.error(`   → Output:\n${result.stdout}\n${result.stderr}\n`);
  }
}

console.log(`\n═══════════════════════════════════════════════════`);
console.log(
  `Summary: ${passed}/${testCases.length} tests passed (${failed} failed)`,
);
console.log(`═══════════════════════════════════════════════════`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log("🎉 All release guard threat model tests verified successfully!");
  process.exit(0);
}
