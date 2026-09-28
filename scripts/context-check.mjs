#!/usr/bin/env node
// FlowPilot — Context Architecture V1 health check (DECISIONS #75).
//
//   pnpm context:check
//
// Deterministic, lightweight validation of docs/CONTEXT_MAP.md:
//   - every mapped documentation path exists
//   - every mapped source path exists
//   - every mapped test path exists
//   - context names are unique
//   - no context is empty / has no mapped files
//
// It does NOT judge semantic correctness of the repository, run app code, or
// touch the network. Exit code 0 = healthy, 1 = broken map.
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  MAP_PATH,
  REPO_ROOT,
  allPaths,
  parseContextMap,
} from "./context-map.lib.mjs";

async function main() {
  const problems = [];

  if (!existsSync(MAP_PATH)) {
    console.error(`\nContext map missing: ${MAP_PATH}\n`);
    process.exitCode = 1;
    return;
  }

  const { contexts, duplicates } = await parseContextMap();

  if (contexts.length === 0) {
    problems.push("No contexts found under the '## Contexts' section.");
  }

  for (const name of [...new Set(duplicates)]) {
    problems.push(`Duplicate context name: "${name}".`);
  }

  for (const entry of contexts) {
    const paths = allPaths(entry);
    if (paths.length === 0) {
      problems.push(
        `Context "${entry.name}" (line ${entry.line}) maps no files.`,
      );
    }
    if (entry.code.length === 0) {
      problems.push(
        `Context "${entry.name}" (line ${entry.line}) maps no Code files.`,
      );
    }
    for (const category of ["docs", "code", "tests"]) {
      for (const rel of entry[category]) {
        if (!existsSync(resolve(REPO_ROOT, rel))) {
          problems.push(
            `Context "${entry.name}": ${category} path does not exist -> ${rel}`,
          );
        }
      }
    }
  }

  const fileCount = contexts.reduce((n, c) => n + allPaths(c).length, 0);

  if (problems.length > 0) {
    console.error(
      `\nContext map check FAILED (${problems.length} problem(s)):\n`,
    );
    for (const p of problems) console.error(`  - ${p}`);
    console.error("");
    process.exitCode = 1;
    return;
  }

  console.log(
    `\nContext map OK: ${contexts.length} contexts, ${fileCount} mapped paths, all present.\n`,
  );
}

main().catch((err) => {
  console.error(`\nContext map check errored: ${err?.message ?? err}\n`);
  process.exitCode = 1;
});
