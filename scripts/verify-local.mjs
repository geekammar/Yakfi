#!/usr/bin/env node
// FlowPilot verify-local.mjs — Lightweight Local Verification Gate (DEVOPS-01E)
// Runs fast, low-overhead quality checks for rapid iteration on resource-constrained environments.
//
// Guaranteed invariants:
// - NEVER invokes `next build`
// - NEVER starts headless browsers or Playwright suites
// - Catches type errors, security hygiene, prompt drift, lint, and formatting
// - Supports `--fast` flag (or `pnpm verify:fast`) to skip lint/format for sub-10s feedback
//
// Full production build & browser testing remain strictly owned by GitHub Actions CI and Vercel.
import { spawnSync } from "node:child_process";
import { platform } from "node:os";

const args = process.argv.slice(2);
const isFast = args.includes("--fast");
const skipLint = isFast || args.includes("--skip-lint");
const skipFormat = isFast || args.includes("--skip-format");

const steps = [
  {
    label: "security",
    cmd: "pnpm",
    args: ["security"],
    desc: "pnpm security — secret scan",
  },
  {
    label: "ai-prompts",
    cmd: "pnpm",
    args: ["check:ai-prompts"],
    desc: "pnpm check:ai-prompts — prompt drift check",
  },
  {
    label: "typecheck",
    cmd: "pnpm",
    args: ["typecheck"],
    desc: "tsc --noEmit — strict TypeScript check",
  },
];

if (!skipLint) {
  steps.push({
    label: "lint",
    cmd: "pnpm",
    args: ["lint"],
    desc: "eslint . — style & React rules",
  });
}

if (!skipFormat) {
  steps.push({
    label: "format",
    cmd: "pnpm",
    args: ["format:check"],
    desc: "prettier --check . — formatting consistency",
  });
}

console.log(
  `FlowPilot verify:local — ${platform()}${isFast ? " [FAST MODE]" : ""}`,
);
console.log(
  "ℹ️  Lightweight local gate (No 'next build', no browser startup).\n",
);

const summary = [];
let failed = false;

for (const step of steps) {
  console.log(`▶ ${step.label} — ${step.desc}`);
  const t0 = Date.now();
  const result = spawnSync(step.cmd, step.args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  const code = result.status ?? 1;
  const pass = code === 0;
  if (!pass) failed = true;
  summary.push({ step: step.label, pass, seconds, code });
  console.log(
    `${pass ? "✓" : "✗"} ${step.label} ${pass ? "passed" : `FAILED (exit ${code})`} in ${seconds}s\n`,
  );
  if (!pass) {
    // Fail fast on first error to save VPS CPU/memory
    break;
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────
const pad = (s, n) => s.padEnd(n, " ");
console.log("─────────── verify:local summary ───────────");
for (const row of summary) {
  console.log(
    ` ${row.pass ? "✅" : "❌"} ${pad(row.step, 18)} ${pad(`${row.seconds}s`, 8)} ${row.pass ? "" : `exit ${row.code}`}`,
  );
}
console.log("────────────────────────────────────────────");

if (failed) {
  console.log(
    "\nRESULT: FAILED ❌ — fix the failing check above and re-run: pnpm verify:local",
  );
  process.exit(1);
}

console.log("\nRESULT: PASSED ✅ — local gates green.");
console.log(
  "ℹ️  Next Step: Push feature branch to GitHub; GitHub Actions CI will run full build & Playwright UX QA.",
);
process.exit(0);
