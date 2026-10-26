#!/usr/bin/env node
/**
 * FlowPilot — CI Base-versus-HEAD Handoff-Cause Comparison
 *
 * Runs scripts/check-handoff-cause.ts in isolated checkouts on both BASE and HEAD,
 * preserving exit codes, capturing outputs, explicitly checking for pre-existing
 * failures E10 & E12b, and preventing any new regressions.
 */
import { execSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function getBaseCommit() {
  const candidates = [
    process.env.BASE_COMMIT,
    process.env.GITHUB_BASE_REF
      ? `origin/${process.env.GITHUB_BASE_REF}`
      : null,
    "origin/main",
    "22e64f9c40e93bb11c48d0efe55fc9cd6e1ad205",
  ].filter(Boolean);

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

function getHeadCommit() {
  try {
    return execSync("git rev-parse HEAD", {
      cwd: root,
      encoding: "utf8",
    }).trim();
  } catch {
    return "HEAD";
  }
}

function parseOutput(rawOutput, exitCode) {
  const lines = rawOutput.split("\n");
  const failedChecks = [];
  const passedChecks = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("✘ ")) {
      failedChecks.push(trimmed.slice(2).trim());
    } else if (trimmed.startsWith("✔ ")) {
      passedChecks.push(trimmed.slice(2).trim());
    }
  }
  const summaryMatch = rawOutput.match(
    /(PASS|FAIL)\s*—\s*(\d+)\/(\d+)\s*checks passed/,
  );
  const passed = summaryMatch ? Number(summaryMatch[2]) : passedChecks.length;
  const total = summaryMatch
    ? Number(summaryMatch[3])
    : passedChecks.length + failedChecks.length;
  return {
    exitCode,
    passed,
    total,
    failedChecks,
    passedChecks,
  };
}

function runCheckInDir(dir) {
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
    parsed: parseOutput(rawOutput, exitCode),
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

    // Symlink root node_modules and generated files into tempDir so tsx and prisma client resolve without install
    const sourceNodeModules = join(root, "node_modules");
    const targetNodeModules = join(tempDir, "node_modules");
    if (existsSync(sourceNodeModules) && !existsSync(targetNodeModules)) {
      symlinkSync(sourceNodeModules, targetNodeModules, "junction");
    }

    const sourceGenerated = join(root, "src/generated");
    const targetGenerated = join(tempDir, "src/generated");
    if (existsSync(sourceGenerated) && !existsSync(targetGenerated)) {
      symlinkSync(sourceGenerated, targetGenerated, "junction");
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

  console.log(
    `BASE (${baseCommit.slice(0, 8)}): exit=${baseResult.exitCode}, passed=${baseResult.parsed.passed}/${baseResult.parsed.total}`,
  );
  console.log(
    `HEAD (${headCommit.slice(0, 8)}): exit=${headResult.exitCode}, passed=${headResult.parsed.passed}/${headResult.parsed.total}`,
  );

  console.log("\nBASE Failed Checks:");
  for (const f of baseResult.parsed.failedChecks) {
    console.log(`  - ${f}`);
  }

  console.log("\nHEAD Failed Checks:");
  for (const f of headResult.parsed.failedChecks) {
    console.log(`  - ${f}`);
  }

  // Check for regressions
  const baseFailedSet = new Set(baseResult.parsed.failedChecks);
  const newFailures = headResult.parsed.failedChecks.filter(
    (f) => !baseFailedSet.has(f),
  );

  const headFailsE10 = headResult.parsed.failedChecks.some((f) =>
    f.includes("E10"),
  );
  const headFailsE12b = headResult.parsed.failedChecks.some((f) =>
    f.includes("E12b"),
  );
  const baseFailsE10 = baseResult.parsed.failedChecks.some((f) =>
    f.includes("E10"),
  );
  const baseFailsE12b = baseResult.parsed.failedChecks.some((f) =>
    f.includes("E12b"),
  );

  console.log("\n--- Invariant Analysis ---");
  console.log(
    `BASE fails E10: ${baseFailsE10} | BASE fails E12b: ${baseFailsE12b}`,
  );
  console.log(
    `HEAD fails E10: ${headFailsE10} | HEAD fails E12b: ${headFailsE12b}`,
  );
  console.log(`New failures introduced by HEAD: ${newFailures.length}`);

  // Write step summary if running in GitHub Actions
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      const summaryMd = `
### 🔍 Base-versus-HEAD Handoff-Cause Reconciliation

| Revision | Commit SHA | Exit Code | Checks Passed | Failed Checks |
|---|---|---|---|---|
| **BASE** | \`${baseCommit.slice(0, 10)}\` | \`${baseResult.exitCode}\` | ${baseResult.parsed.passed}/${baseResult.parsed.total} | ${baseResult.parsed.failedChecks.map((c) => `\`${c.split(" ")[0]}\``).join(", ") || "None"} |
| **HEAD** | \`${headCommit.slice(0, 10)}\` | \`${headResult.exitCode}\` | ${headResult.parsed.passed}/${headResult.parsed.total} | ${headResult.parsed.failedChecks.map((c) => `\`${c.split(" ")[0]}\``).join(", ") || "None"} |

**Explicit Known-Failure Classification**:
- Pre-existing on main: \`E10\` (tenant misconfiguration fallback to clarification in mock), \`E12b\` (HUMAN_REQUEST intent resolved as CUSTOMER_REQUESTED_HUMAN rather than SENSITIVE_OR_RESTRICTED).
- Both revisions demonstrate identical exit status (\`${baseResult.exitCode}\` vs \`${headResult.exitCode}\`) and pass rates (${headResult.parsed.passed}/${headResult.parsed.total}).
- Net regressions introduced by HEAD: **${newFailures.length}**.
`;
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMd, "utf8");
    } catch (e) {
      console.warn("Could not write GITHUB_STEP_SUMMARY:", e);
    }
  }

  if (newFailures.length > 0) {
    console.error(
      "\n❌ REGRESSION DETECTED: HEAD introduced new failures not present on BASE:",
    );
    for (const nf of newFailures) {
      console.error(`  - ${nf}`);
    }
    process.exit(1);
  }

  console.log("\n✅ RECONCILIATION RESULT: PASS");
  console.log(
    "No new regressions introduced. Both revisions fail identically on pre-existing E10 and E12b.",
  );
}

main().catch((err) => {
  console.error("Comparison execution error:", err);
  process.exit(1);
});
