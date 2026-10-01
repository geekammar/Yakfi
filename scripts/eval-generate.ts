/**
 * FlowPilot AI Evaluation — dataset generator CLI.
 *
 * Assembles a dataset version from its scenario banks and writes the
 * machine-readable JSON artifact. Deterministic: same sources ⇒ same output.
 *
 * Run: pnpm eval:generate
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  AVAILABLE_DATASET_VERSIONS,
  resolveDatasetBuilder,
} from "../evaluation/datasets";

const version = process.argv[2] ?? AVAILABLE_DATASET_VERSIONS[0]!;
const OUT = resolve(
  process.cwd(),
  "evaluation/datasets",
  version,
  `${version}.dataset.json`,
);

function main(): void {
  const dataset = resolveDatasetBuilder(version)();
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(dataset, null, 2)}\n`, "utf8");

  const byType = new Map<string, number>();
  for (const c of dataset.cases) {
    byType.set(c.conversationType, (byType.get(c.conversationType) ?? 0) + 1);
  }
  const scenarios = new Set(dataset.cases.map((c) => c.scenarioId)).size;

  console.log(`eval:generate → ${OUT}`);
  console.log(`  scenarios : ${scenarios}`);
  console.log(`  cases     : ${dataset.cases.length}`);
  for (const [type, count] of [...byType].sort()) {
    console.log(`  ${type.padEnd(20)}: ${count}`);
  }
}

main();
