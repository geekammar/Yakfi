#!/usr/bin/env node
/**
 * FlowPilot — CI Base-versus-HEAD Handoff-Cause Comparison
 *
 * Runs scripts/check-handoff-cause.ts in isolated checkouts on both BASE and HEAD.
 * Validates execution integrity, parses and validates check counts, ensures fail-closed
 * behavior on crashes, spawn errors, or missing cases, and reports E10/E12b explicitly.
 */
import { execSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const KNOWN_PERMISSIBLE_FAILURES = ["E10", "E12b"];

export interface ProcessRunResult {
  exitCode: number | null;
  rawOutput: string;
  error?: Error | null;
  signal?: NodeJS.Signals | string | null;
}

export interface ParsedRunExecution {
  exitCode: number;
  passed: number;
  total: number;
  failedChecks: string[];
  passedChecks: string[];
  summaryFound: boolean;
}

export type ValidateRunResult =
  | { ok: true; parsed: ParsedRunExecution; error?: never }
  | { ok: false; error: string; parsed?: never };

export type EvaluationResult =
  | {
      pass: true;
      classification: "VERIFIED_IMPROVEMENT" | "IDENTICAL_KNOWN_FAILURES";
      message: string;
      baseVal: ValidateRunResult;
      headVal: ValidateRunResult;
      error?: never;
    }
  | {
      pass: false;
      error: string;
      baseVal?: ValidateRunResult;
      headVal?: ValidateRunResult | null;
      classification?: never;
      message?: never;
    };

export function getBaseCommit(): string {
  const candidates = [
    process.env.BASE_COMMIT,
    process.env.GITHUB_BASE_REF
      ? `origin/${process.env.GITHUB_BASE_REF}`
      : null,
    "origin/main",
    "22e64f9c40e93bb11c48d0efe55fc9cd6e1ad205",
  ].filter((c): c is string => Boolean(c));

  for (const candidate of candidates) {
    try {
      const sha = execSync(`git rev-parse --verify "${candidate}^{commit}"`, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (sha) return sha;
    } catch {}
  }
  return "22e64f9c40e93bb11c48d0efe55fc9cd6e1ad205";
}

export function getHeadCommit(): string {
  try {
    return execSync("git rev-parse HEAD", {
      cwd: root,
      encoding: "utf8",
    }).trim();
  } catch {
    return "HEAD";
  }
}

export function extractCheckCode(label: string): string {
  const match = label.match(/^([A-Za-z0-9_-]+)\./);
  return match
    ? (match[1] ?? label.split(" ")[0] ?? "")
    : (label.split(" ")[0] ?? "");
}

export function validateRunExecution(
  name: "BASE" | "HEAD" | string,
  run: ProcessRunResult,
): ValidateRunResult {
  if (run.error) {
    return {
      ok: false,
      error: `${name} process execution error: ${run.error.message || String(run.error)}`,
    };
  }
  if (run.signal) {
    return {
      ok: false,
      error: `${name} process terminated abnormally by signal: ${run.signal}`,
    };
  }

  const raw = run.rawOutput || "";
  const summaryMatch = raw.match(
    /(PASS|FAIL)\s*—\s*(\d+)\/(\d+)\s*checks passed/,
  );
  if (!summaryMatch) {
    return {
      ok: false,
      error: `${name} missing canonical test summary line in output (possible early exit, syntax error, or unhandled exception)`,
    };
  }

  const passed = Number(summaryMatch[2]);
  const total = Number(summaryMatch[3]);
  if (!Number.isInteger(total) || total <= 0) {
    return {
      ok: false,
      error: `${name} reported invalid or zero total checks: ${total}`,
    };
  }

  const lines = raw.split("\n");
  const failedChecks: string[] = [];
  const passedChecks: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("✘ ")) {
      failedChecks.push(trimmed.slice(2).trim());
    } else if (trimmed.startsWith("✔ ")) {
      passedChecks.push(trimmed.slice(2).trim());
    }
  }

  if (passedChecks.length !== passed) {
    return {
      ok: false,
      error: `${name} output passed checks line count (${passedChecks.length}) does not match summary count (${passed})`,
    };
  }

  const expectedFailed = total - passed;
  if (failedChecks.length !== expectedFailed) {
    return {
      ok: false,
      error: `${name} output failed checks line count (${failedChecks.length}) does not match summary failed count (${expectedFailed})`,
    };
  }

  const exitCode = run.exitCode ?? (run.error ? 1 : 0);
  if (failedChecks.length === 0 && exitCode !== 0) {
    return {
      ok: false,
      error: `${name} process exited with code ${exitCode} but zero checks failed`,
    };
  }
  if (failedChecks.length > 0 && exitCode !== 1) {
    return {
      ok: false,
      error: `${name} process exited with code ${exitCode} but ${failedChecks.length} checks failed (expected exit 1)`,
    };
  }

  return {
    ok: true,
    parsed: {
      exitCode,
      passed,
      total,
      failedChecks,
      passedChecks,
      summaryFound: true,
    },
  };
}

export function evaluateHandoffComparison(
  baseRun: ProcessRunResult,
  headRun: ProcessRunResult,
): EvaluationResult {
  const baseVal = validateRunExecution("BASE", baseRun);
  if (!baseVal.ok) {
    return { pass: false, error: baseVal.error, baseVal, headVal: null };
  }

  const headVal = validateRunExecution("HEAD", headRun);
  if (!headVal.ok) {
    return { pass: false, error: headVal.error, baseVal, headVal };
  }

  const base = baseVal.parsed;
  const head = headVal.parsed;

  // 1. Suite completeness: HEAD must execute at least as many checks as BASE
  if (head.total < base.total) {
    return {
      pass: false,
      error: `Incomplete check set: HEAD executed ${head.total} checks, fewer than BASE (${base.total})`,
      baseVal,
      headVal,
    };
  }

  // 2. Missing executed cases: Every check code executed on BASE must exist on HEAD
  const headExecutedCodes = new Set([
    ...head.passedChecks.map(extractCheckCode),
    ...head.failedChecks.map(extractCheckCode),
  ]);
  const baseExecutedCodes = [
    ...base.passedChecks.map(extractCheckCode),
    ...base.failedChecks.map(extractCheckCode),
  ];
  const missingCases = baseExecutedCodes.filter(
    (code) => !headExecutedCodes.has(code),
  );
  if (missingCases.length > 0) {
    return {
      pass: false,
      error: `Missing executed cases on HEAD that existed on BASE: ${missingCases.join(", ")}`,
      baseVal,
      headVal,
    };
  }

  // 3. Regressions: Failures on HEAD that did not exist on BASE
  const baseFailedCodes = new Set(base.failedChecks.map(extractCheckCode));
  const newFailures = head.failedChecks.filter(
    (f) => !baseFailedCodes.has(extractCheckCode(f)),
  );
  if (newFailures.length > 0) {
    return {
      pass: false,
      error: `New regressions introduced on HEAD: ${newFailures.join(", ")}`,
      baseVal,
      headVal,
    };
  }

  // 4. Permissible known failures check: Failures on HEAD must strictly belong to reviewed permissible list
  const unknownFailures = head.failedChecks.filter((f) => {
    const code = extractCheckCode(f);
    return !KNOWN_PERMISSIBLE_FAILURES.includes(code);
  });
  if (unknownFailures.length > 0) {
    return {
      pass: false,
      error: `Unreviewed failure(s) on HEAD not in permissible known-failures set: ${unknownFailures.join(", ")}`,
      baseVal,
      headVal,
    };
  }

  // 5. Success classification: improvement vs identical known failures
  if (head.failedChecks.length < base.failedChecks.length) {
    return {
      pass: true,
      classification: "VERIFIED_IMPROVEMENT",
      message: `Verified improvement: HEAD passed ${head.passed}/${head.total} (BASE passed ${base.passed}/${base.total}) with 0 regressions`,
      baseVal,
      headVal,
    };
  }

  return {
    pass: true,
    classification: "IDENTICAL_KNOWN_FAILURES",
    message: `Reconciliation verified: Both BASE and HEAD exhibit identical pre-existing failures (${head.failedChecks.map(extractCheckCode).join(", ")}), 0 regressions`,
    baseVal,
    headVal,
  };
}

export function runCheckInDir(dir: string): ProcessRunResult {
  const scriptPath = join(dir, "scripts/check-handoff-cause.ts");
  if (!existsSync(scriptPath)) {
    throw new Error(`scripts/check-handoff-cause.ts not found in ${dir}`);
  }

  const res = spawnSync(
    "pnpm",
    ["exec", "tsx", "scripts/check-handoff-cause.ts"],
    {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, CI: "true" },
    },
  );

  const rawOutput = (res.stdout ?? "") + "\n" + (res.stderr ?? "");
  const exitCode = res.status ?? (res.error ? 1 : 0);
  return {
    exitCode,
    rawOutput,
    error: res.error ?? null,
    signal: res.signal ?? null,
  };
}

async function main() {
  console.log("========================================================");
  console.log("  FLOWPILOT BASE VS HEAD HANDOFF-CAUSE COMPARISON       ");
  console.log("========================================================\n");

  const headCommit = getHeadCommit();
  const baseCommit = getBaseCommit();

  console.log(`BASE commit: ${baseCommit}`);
  console.log(`HEAD commit: ${headCommit}\n`);

  // 1. Run on HEAD (current repository)
  console.log("--- [1/2] Running check:handoff-cause on HEAD ---");
  const headResult = runCheckInDir(root);
  console.log(headResult.rawOutput);
  console.log(`HEAD exit code: ${headResult.exitCode}\n`);

  // 2. Run on BASE in isolated temporary worktree
  console.log(
    "--- [2/2] Running check:handoff-cause on BASE (isolated worktree) ---",
  );
  const tempDir = mkdtempSync(join(tmpdir(), "handoff-base-wt-"));
  let baseResult;
  try {
    execSync(`git worktree add --detach "${tempDir}" "${baseCommit}"`, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const sourceNodeModules = join(root, "node_modules");
    const targetNodeModules = join(tempDir, "node_modules");
    if (existsSync(sourceNodeModules) && !existsSync(targetNodeModules)) {
      symlinkSync(sourceNodeModules, targetNodeModules, "junction");
    }

    const sourceGenerated = join(root, "src/generated");
    const targetGenerated = join(tempDir, "src/generated");
    if (existsSync(sourceGenerated)) {
      cpSync(sourceGenerated, targetGenerated, { recursive: true });
    }

    baseResult = runCheckInDir(tempDir);
    console.log(baseResult.rawOutput);
    console.log(`BASE exit code: ${baseResult.exitCode}\n`);
  } finally {
    try {
      rmSync(join(tempDir, "src/generated"), { force: true, recursive: false });
    } catch {}
    try {
      rmSync(join(tempDir, "node_modules"), { force: true, recursive: false });
    } catch {}
    try {
      execSync(`git worktree remove --force "${tempDir}"`, {
        cwd: root,
        stdio: "ignore",
      });
    } catch {}
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }

  // 3. Comparison & Reconciliation
  console.log("========================================================");
  console.log("  COMPARISON RECONCILIATION SUMMARY                     ");
  console.log("========================================================");

  const evalResult = evaluateHandoffComparison(baseResult, headResult);

  if (evalResult.baseVal?.parsed && evalResult.headVal?.parsed) {
    const b = evalResult.baseVal.parsed;
    const h = evalResult.headVal.parsed;
    console.log(
      `BASE (${baseCommit.slice(0, 8)}): exit=${b.exitCode}, passed=${b.passed}/${b.total}`,
    );
    console.log(
      `HEAD (${headCommit.slice(0, 8)}): exit=${h.exitCode}, passed=${h.passed}/${h.total}`,
    );

    console.log("\nBASE Failed Checks:");
    for (const f of b.failedChecks) {
      console.log(`  - ${f}`);
    }

    console.log("\nHEAD Failed Checks:");
    for (const f of h.failedChecks) {
      console.log(`  - ${f}`);
    }

    if (process.env.GITHUB_STEP_SUMMARY) {
      try {
        const summaryMd = `
### 🔍 Base-versus-HEAD Handoff-Cause Reconciliation

| Revision | Commit SHA | Exit Code | Checks Passed | Failed Checks |
|---|---|---|---|---|
| **BASE** | \`${baseCommit.slice(0, 10)}\` | \`${b.exitCode}\` | ${b.passed}/${b.total} | ${b.failedChecks.map((c) => `\`${extractCheckCode(c)}\``).join(", ") || "None"} |
| **HEAD** | \`${headCommit.slice(0, 10)}\` | \`${h.exitCode}\` | ${h.passed}/${h.total} | ${h.failedChecks.map((c) => `\`${extractCheckCode(c)}\``).join(", ") || "None"} |

**Reconciliation Verdict**: \`${evalResult.classification ?? (evalResult.pass ? "PASS" : "FAIL")}\`
${evalResult.message || evalResult.error}

**Contract Observation (Unresolved Upstream Items)**:
- \`E10\` (Tenant configuration): Inactive service triggers clarification inquiry in mock rather than direct tenant misconfiguration handoff.
- \`E12b\` (Safety precedence): Model \`HUMAN_REQUEST\` intent resolved as \`CUSTOMER_REQUESTED_HUMAN\` rather than \`SENSITIVE_OR_RESTRICTED\`.
`;
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMd, "utf8");
      } catch (e) {
        console.warn("Could not write GITHUB_STEP_SUMMARY:", e);
      }
    }
  }

  if (!evalResult.pass) {
    console.error(`\n❌ COMPARISON FAILED: ${evalResult.error}`);
    process.exit(1);
  }

  console.log(
    `\n✅ RECONCILIATION RESULT: PASS (${evalResult.classification})`,
  );
  console.log(evalResult.message);
}

// When executed directly as CLI script
if (
  process.argv[1] &&
  (process.argv[1].endsWith("compare-handoff-cause.mjs") ||
    process.argv[1].endsWith("compare-handoff-cause.ts") ||
    process.argv[1].endsWith("compare-handoff-cause"))
) {
  main().catch((err) => {
    console.error("Comparison execution error:", err);
    process.exit(1);
  });
}
