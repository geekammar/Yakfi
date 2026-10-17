#!/usr/bin/env node
// FlowPilot test-release-guard.mjs — Non-production verification suite for DEVOPS-01C Release Guard
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
    expectedExit: 0, // SUPPRESS
    description:
      "Standard GitHub PR merge commits must never trigger Production deploy",
  },
  {
    name: "3. GitHub PR Squash Merge on main",
    env: {
      VERCEL_ENV: "production",
      VERCEL_GIT_COMMIT_REF: "main",
      VERCEL_GIT_COMMIT_MESSAGE:
        "feat: update provider availability (#15)\n\n* implement slot calculations",
    },
    expectedExit: 0, // SUPPRESS
    description:
      "Squash merges appending ' (#PR_NUM)' must never trigger Production deploy",
  },
  {
    name: "4. Attack/Bypass: PR commit message contains [release] in body",
    env: {
      VERCEL_ENV: "production",
      VERCEL_GIT_COMMIT_REF: "main",
      VERCEL_GIT_COMMIT_MESSAGE:
        "fix: update button styles (#20)\n\n* this is required for [release] next week",
    },
    expectedExit: 0, // SUPPRESS
    description:
      "Loose release markers in PR commit body must be strictly rejected",
  },
  {
    name: "5. Attack/Bypass: PR title mimics release subject format",
    env: {
      VERCEL_ENV: "production",
      VERCEL_GIT_COMMIT_REF: "main",
      VERCEL_GIT_COMMIT_MESSAGE:
        "chore(release): v0.47.0 [release] (#99)\n\nAttempt to trigger unauthorized release via PR squash",
    },
    expectedExit: 0, // SUPPRESS
    description:
      "PR squash merge attempting to mimic release title must be caught by PR merge filter",
  },
  {
    name: "6. Attack/Bypass: Loose 'release vX.Y.Z' string in commit subject",
    env: {
      VERCEL_ENV: "production",
      VERCEL_GIT_COMMIT_REF: "main",
      VERCEL_GIT_COMMIT_MESSAGE: "wip: working towards release v0.47.0",
    },
    expectedExit: 0, // SUPPRESS
    description: "Non-anchored or informal release mentions must be rejected",
  },
  {
    name: "7. Attack/Bypass: Spoofed release commit with mismatched package.json version",
    env: {
      VERCEL_ENV: "production",
      VERCEL_GIT_COMMIT_REF: "main",
      VERCEL_GIT_COMMIT_MESSAGE: "chore(release): v0.99.0 [release]",
    },
    expectedExit: 0, // SUPPRESS
    description:
      "Release subject claiming v0.99.0 when package.json is 0.46.6 must be rejected",
  },
  {
    name: "8. Authorized Release: Controlled Production Release Workflow",
    env: {
      VERCEL_ENV: "production",
      VERCEL_GIT_COMMIT_REF: "main",
      VERCEL_GIT_COMMIT_SHA: "a660f64395e23d383ae13cc4b49ab9fe08506975",
      VERCEL_GIT_COMMIT_MESSAGE: "chore(release): v0.46.6 [release]",
    },
    expectedExit: 1, // ALLOW
    description:
      "Authorized GitHub Actions release matching package.json version must be allowed",
  },
  {
    name: "9. Authorized Release: Legacy pnpm ship",
    env: {
      VERCEL_ENV: "production",
      VERCEL_GIT_COMMIT_REF: "main",
      VERCEL_GIT_COMMIT_SHA: "a660f64395e23d383ae13cc4b49ab9fe08506975",
      VERCEL_GIT_COMMIT_MESSAGE: "fix: release v0.46.6",
    },
    expectedExit: 1, // ALLOW
    description:
      "Authorized pnpm ship release matching package.json version must be allowed",
  },
];

console.log("🛡️  FlowPilot Release Guard Threat Model & Cutover Test Suite\n");

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
