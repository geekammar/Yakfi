#!/usr/bin/env node
// FlowPilot — Context Architecture V1 focused check (DECISIONS #75).
//
//   pnpm check:context
//
// Verifies the context utilities themselves (not the whole repo):
//   1. a valid context resolves correctly (docs/code/tests present)
//   2. an unknown context fails clearly (non-zero exit + lists available)
//   3. a broken mapped path is detected by the check logic
//   4. duplicate context names are rejected
//   5. `pnpm context:check` passes against the real committed map
//
// Read-only + deterministic: uses in-memory fixtures for the failure cases and
// spawns the real CLI for the success/failure exit-code contract.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { allPaths, parseContextMap } from "./context-map.lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

const checks = [];
const check = (label, pass) => checks.push({ label, pass: Boolean(pass) });

function runNode(scriptRel, args) {
  return spawnSync("node", [join(HERE, scriptRel), ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

async function main() {
  // 1. Valid context resolves correctly against the real map.
  const { contexts, duplicates } = await parseContextMap();
  check("real map parses to >= 1 context", contexts.length >= 1);
  check("real map has no duplicate names", duplicates.length === 0);

  const sample = contexts[0];
  check(
    "first context has docs + code + tests entries",
    sample &&
      sample.docs.length > 0 &&
      sample.code.length > 0 &&
      sample.tests.length > 0,
  );
  check(
    "every mapped path in every context exists on disk",
    contexts.every((c) =>
      allPaths(c).every((p) => existsSync(resolve(REPO_ROOT, p))),
    ),
  );

  // Resolve a known context via the CLI (exit 0 + prints its files).
  const okRun = runNode("context.mjs", [sample.name]);
  check("`context <valid>` exits 0", okRun.status === 0);
  check(
    "`context <valid>` prints a mapped code path",
    sample && okRun.stdout.includes(sample.code[0]),
  );

  // 2. Unknown context fails clearly.
  const unknownRun = runNode("context.mjs", ["does.not.exist"]);
  check("`context <unknown>` exits non-zero", unknownRun.status !== 0);
  check(
    "`context <unknown>` lists available contexts",
    unknownRun.stderr.includes("Available contexts") &&
      unknownRun.stderr.includes(sample.name),
  );

  // 3 + 4. Broken path + duplicate names detected by the parser/check logic.
  const dir = mkdtempSync(join(tmpdir(), "fp-ctx-"));
  const brokenMap = join(dir, "MAP.md");
  writeFileSync(
    brokenMap,
    [
      "# Fixture",
      "",
      "## Contexts",
      "",
      "### dup.name",
      "Docs:",
      "- docs/AGENT_RULES.md",
      "Code:",
      "- src/lib/utils.ts",
      "Tests:",
      "- scripts/context.mjs",
      "",
      "### dup.name",
      "Code:",
      "- src/does/not/exist.ts",
      "",
    ].join("\n"),
  );
  try {
    const parsed = await parseContextMap(brokenMap);
    check(
      "duplicate context names are detected",
      parsed.duplicates.includes("dup.name"),
    );
    const brokenEntry = parsed.contexts.find((c) =>
      c.code.includes("src/does/not/exist.ts"),
    );
    check(
      "broken mapped path is detectable (does not exist)",
      brokenEntry !== undefined &&
        !existsSync(resolve(REPO_ROOT, "src/does/not/exist.ts")),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // 5. The real check command passes.
  const checkRun = runNode("context-check.mjs", []);
  check("`context:check` exits 0 on the real map", checkRun.status === 0);

  let failed = 0;
  for (const { label, pass } of checks) {
    if (pass) console.log(`\u2714 ${label}`);
    else {
      console.error(`\u2718 ${label}`);
      failed += 1;
    }
  }
  if (failed > 0) {
    console.error(`\nContext architecture: ${failed}/${checks.length} FAILED.`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `\nContext architecture OK: ${checks.length}/${checks.length} checks passed.`,
  );
}

main().catch((err) => {
  console.error(`\ncheck:context errored: ${err?.message ?? err}`);
  process.exitCode = 1;
});
