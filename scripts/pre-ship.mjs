#!/usr/bin/env node
// FlowPilot pre-ship — the canonical, repository-owned pre-release gate
// (PROMPT-OPS-REL-01).
//
//   pnpm pre-ship            read-only release-readiness gate + report
//   pnpm pre-ship --json     same gate, machine-readable (for CI reuse)
//
// This is the ONE routine pre-release checkpoint. It composes the existing
// canonical commands — it does NOT reimplement any of them:
//
//   git state validation   (branch=main, unambiguous baseline, exact
//                           non-empty release candidate)
//   git diff --check       (conflict markers / whitespace errors)
//   pnpm security          (secret scan over the whole candidate)
//   pnpm check:ai-prompts  (committed prompt artifact + prompt contract)
//   pnpm verify            (lint + typecheck + format + build)
//   non-mutation witness   (the gates left the candidate byte-identical)
//
// pre-ship NEVER SHIPS: no git add/commit/push/tag, no GitHub Release, no
// deploy, no migration, no DB write, no provider call, no customer action,
// and no Production secrets. It only reads repository state and runs
// sanctioned offline quality checks. The human operator chooses PATCH /
// MINOR / explicit version and runs `pnpm ship <type>` themselves.
//
// Exit codes: 0 = PRE_SHIP_GREEN · 1 = PRE_SHIP_BLOCKED ·
//             2 = MANUAL_RELEASE_REVIEW_REQUIRED
import {
  DECISIONS,
  candidateStatus,
  resolveRoot,
  runPreShipGate,
} from "./pre-ship-lib.mjs";

const JSON_MODE = process.argv.includes("--json");

const MAX_LIST = 30;
const capPaths = (paths) => paths.slice(0, MAX_LIST);

const root = resolveRoot();
const report = runPreShipGate(root);
const {
  baseline,
  candidate,
  gates,
  risk,
  decision,
  recommendedBump,
  nextAction,
} = report;

const EXIT_CODE =
  decision === DECISIONS.GREEN ? 0 : decision === DECISIONS.MANUAL ? 2 : 1;

const changedCount = baseline.unreleasedFiles.length;
const range = baseline.tag ? `${baseline.tag}..HEAD` : "no previous tag";

const short = (s, n = 72) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

if (JSON_MODE) {
  console.log(
    JSON.stringify(
      {
        preShipReport: true,
        decision,
        recommendedBump,
        nextAction,
        baseline: {
          branch: baseline.branch,
          head: baseline.head,
          version: baseline.version,
          latestTag: baseline.tag,
          unreleasedFiles: changedCount,
          range,
          originState: baseline.originState,
          localAhead: baseline.localAhead,
        },
        candidate: {
          count: candidate.count,
          fingerprint: candidate.fingerprint,
          paths: candidate.paths.map((p) => ({
            path: p,
            status: candidateStatus(p, candidate),
          })),
        },
        gates: gates.map((g) => ({
          id: g.id,
          label: g.label,
          status: g.status,
          seconds: g.seconds ?? null,
          detail: g.detail ?? null,
        })),
        riskHigh: risk.high.map((s) => ({
          id: s.id,
          label: s.label,
          files: s.files,
        })),
        riskElevated: risk.elevated.map((s) => ({
          id: s.id,
          label: s.label,
          files: s.files,
          checks: s.checks,
        })),
      },
      null,
      2,
    ),
  );
  process.exit(EXIT_CODE);
}

// ── phone-friendly report (stable shape) ─────────────────────────────────────
const lines = [];
lines.push("PRE-SHIP REPORT");
lines.push("");
lines.push(`Branch: ${baseline.branch || "(detached HEAD)"}`);
lines.push(`HEAD: ${baseline.head ?? "unknown"}`);
lines.push(`Version: ${baseline.version ?? "unknown"}`);
lines.push(`Latest tag: ${baseline.tag ?? "none"}`);
if (baseline.localAhead > 0)
  lines.push(
    `Local commits not on origin/main: ${baseline.localAhead} (they ship with this release)`,
  );
lines.push(`Changed files: ${changedCount} (${range})`);

// The exact, inspected release candidate: these paths — and only these — are
// what `pnpm ship` will commit. Listing them is the "inspected" half of the
// invariant; the fingerprint is the "exact" half.
lines.push("");
lines.push(
  `Release candidate (${candidate.count} path(s), fingerprint ${candidate.fingerprint.slice(0, 12)}):`,
);
for (const p of capPaths(candidate.paths))
  lines.push(`  ${candidateStatus(p, candidate).padEnd(8)} ${p}`);
if (candidate.paths.length > MAX_LIST)
  lines.push(
    `  … and ${candidate.paths.length - MAX_LIST} more (pnpm pre-ship --json lists all)`,
  );
if (risk.high.length > 0 || risk.elevated.length > 0) {
  lines.push("Risk surfaces:");
  for (const s of risk.high)
    lines.push(`  HIGH     ${s.label} — ${short(s.files.join(", "))}`);
  for (const s of risk.elevated)
    lines.push(`  elevated ${s.label} — ${short(s.files.join(", "))}`);
} else {
  lines.push("Risk surfaces: none");
}

lines.push("");
lines.push("Gates:");
for (const g of gates) {
  const icon = g.status === "PASS" ? "✓" : g.status === "FAIL" ? "✗" : "·";
  const secs = g.seconds ? ` ${g.seconds}s` : "";
  const detail = g.detail ? ` — ${short(g.detail, 66)}` : "";
  lines.push(`  ${icon} ${g.label.padEnd(14)} ${g.status}${secs}${detail}`);
}

lines.push("");
lines.push("Decision:");
lines.push(`  ${decision}`);
lines.push("");
lines.push("Recommended bump:");
lines.push(`  ${recommendedBump}`);
lines.push("");
lines.push("Next human action:");
for (const l of nextAction.split("\n")) lines.push(`  ${l}`);

console.log(lines.join("\n"));

// ── failing-gate detail (after the report, so the summary stays readable) ─────
const failures = gates.filter((g) => g.status === "FAIL" && g.output);
if (failures.length > 0) {
  console.log("");
  for (const g of failures) {
    console.log(`── ${g.label} output ──────────────────────`);
    console.log(g.output.split("\n").slice(-40).join("\n"));
    console.log("");
  }
}

if (decision === DECISIONS.BLOCKED)
  console.error(
    "\nSHIPPING IS BLOCKED — do not run pnpm ship until the failing gate passes.",
  );
else if (decision === DECISIONS.MANUAL)
  console.error(
    "\nMANUAL RELEASE REVIEW REQUIRED — the machine cannot certify this diff; a human must review it before shipping.",
  );

process.exit(EXIT_CODE);
