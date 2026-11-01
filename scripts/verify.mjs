#!/usr/bin/env node
// FlowPilot verify — full quality gate with a summary.
// Runs: lint → typecheck → format:check → build. Fails if ANY step fails.
// On Android/Termux the build automatically uses --webpack because Turbopack
// has no native Android bindings there.
import { spawnSync } from "node:child_process";
import { platform, release } from "node:os";

const isTermux =
  Boolean(process.env.TERMUX_VERSION) ||
  (process.env.PREFIX ?? "").includes("com.termux") ||
  (platform() === "linux" && /android/i.test(release()));

const steps = [
  { label: "lint", cmd: "pnpm", args: ["lint"], desc: "eslint ." },
  {
    label: "typecheck",
    cmd: "pnpm",
    args: ["typecheck"],
    desc: "tsc --noEmit",
  },
  {
    label: "format",
    cmd: "pnpm",
    args: ["format:check"],
    desc: "prettier --check .",
  },
  {
    label: isTermux ? "build (webpack — Termux)" : "build",
    cmd: "pnpm",
    args: isTermux ? ["exec", "next", "build", "--webpack"] : ["build"],
    desc: isTermux ? "next build --webpack" : "next build",
  },
];

console.log(`FlowPilot verify — ${platform()}${isTermux ? " / Termux" : ""}\n`);

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
}

// ── Summary ──────────────────────────────────────────────────────────────────
const pad = (s, n) => s.padEnd(n, " ");
console.log("────────────── verify summary ──────────────");
for (const row of summary) {
  console.log(
    ` ${row.pass ? "✅" : "❌"} ${pad(row.step, 22)} ${pad(`${row.seconds}s`, 8)} ${row.pass ? "" : `exit ${row.code}`}`,
  );
}
console.log("─────────────────────────────────────────────");

if (failed) {
  console.log(
    "RESULT: FAILED ❌ — fix the failing steps above and re-run: pnpm verify",
  );
  process.exit(1);
}
console.log(
  "RESULT: PASSED ✅ — all quality gates green (lint, typecheck, format, build).",
);
