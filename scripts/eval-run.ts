/**
 * FlowPilot AI Evaluation — evaluation runner CLI (PROMPT-AI-EVAL-03).
 *
 * ONE command expresses every execution mode via filters:
 *
 *   pnpm eval:run                                  # whole dataset
 *   pnpm eval:run --case <caseId>                  # SINGLE_CASE
 *   pnpm eval:run --scenario <scenarioId>          # SCENARIO
 *   pnpm eval:run --category MULTI_INTENT          # CATEGORY (edge)
 *   pnpm eval:run --intent BOOKING --rarity RARE   # FILTERED
 *   pnpm eval:run --language ARABIZI               # FILTERED
 *   pnpm eval:run --smoke                           # tiny sample (prove it runs)
 *   pnpm eval:run --dataset egyptian-v1 --out <dir> --limit 100
 *
 * The runner is INFRASTRUCTURE: it targets the CURRENT FlowPilot AI offline
 * (deterministic classifier + disclosure gate). It does NOT publish a
 * production baseline — that is the next slice. Fully offline: no DB, no
 * network, no LLM, no keys.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { CaseFilter } from "../evaluation/runner/filters";
import {
  aggregateFailures,
  writeRunArtifacts,
} from "../evaluation/runner/run-report";
import { hashDataset, runEvaluation } from "../evaluation/runner/runner";
import { createCurrentFlowpilotTarget } from "../evaluation/runner/targets/current-flowpilot";
import { safeParseDataset } from "../evaluation/schema/dataset-schema";

const DEFAULT_VERSION = "egyptian-v1";
const SMOKE_LIMIT = 12;

function parseArgs(argv: string[]): {
  version: string;
  filter: CaseFilter;
  out: string | null;
  smoke: boolean;
} {
  const filter: CaseFilter = {};
  let version = DEFAULT_VERSION;
  let out: string | null = null;
  let smoke = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const [flag, inlineValue] = arg.includes("=")
      ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
      : [arg, undefined];
    const next = () => inlineValue ?? argv[++i];
    switch (flag) {
      case "--dataset":
        version = next() ?? version;
        break;
      case "--case":
        filter.caseId = next();
        break;
      case "--scenario":
        filter.scenarioId = next();
        break;
      case "--category":
        filter.edgeCategory = next();
        break;
      case "--intent":
        filter.intent = next();
        break;
      case "--rarity":
        filter.rarity = next();
        break;
      case "--language":
        filter.language = next();
        break;
      case "--orientation":
        filter.orientation = next();
        break;
      case "--limit": {
        const v = next();
        if (v) filter.limit = Number.parseInt(v, 10);
        break;
      }
      case "--out":
        out = next() ?? null;
        break;
      case "--smoke":
        smoke = true;
        break;
      default:
        break;
    }
  }
  if (smoke && filter.limit === undefined) filter.limit = SMOKE_LIMIT;
  return { version, filter, out, smoke };
}

async function main(): Promise<void> {
  // Offline env stubs (importing the production AI boundary reads config).
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const { version, filter, out, smoke } = parseArgs(process.argv.slice(2));

  const datasetPath = resolve(
    process.cwd(),
    "evaluation/datasets",
    version,
    `${version}.dataset.json`,
  );
  const raw = readFileSync(datasetPath, "utf8");
  const parsed = safeParseDataset(JSON.parse(raw));
  if (!parsed.success) {
    console.error(`dataset ${version} failed validation`);
    console.error(parsed.error.message.slice(0, 800));
    process.exit(1);
  }
  const dataset = parsed.data;

  const target = createCurrentFlowpilotTarget();
  const result = await runEvaluation(target, dataset.cases, {
    datasetVersion: version,
    datasetHash: hashDataset(raw),
    scenarioVersion: version,
    seed: dataset.meta.seed,
    filter,
  });

  const outDir = out ?? `evaluation/reports/${version}/runner`;
  const written = writeRunArtifacts(result, outDir);

  const met = result.metrics;
  console.log(
    `eval:run → ${version} (${result.mode})${smoke ? " [smoke]" : ""}`,
  );
  console.log(`  run id                 : ${result.run.run.runId}`);
  console.log(
    `  cases / turns          : ${met.totalCases} / ${met.totalTurns}`,
  );
  console.log(
    `  PASS / LIMITATION / FAIL: ${met.passCount} / ${met.limitationCount} / ${met.failCount}`,
  );
  console.log(`  seam-owned (excluded)  : ${met.seamOwnedCount}`);
  console.log(
    `  intent accuracy        : ${(met.intentAccuracy * 100).toFixed(1)}%`,
  );
  console.log(
    `  handoff precision/recall: ${(met.handoffPrecision * 100).toFixed(1)}% / ${(met.handoffRecall * 100).toFixed(1)}%`,
  );
  console.log(
    `  unnecessary handoff rate: ${(met.unnecessaryHandoffRate * 100).toFixed(1)}%`,
  );
  const failures = aggregateFailures(result.scored);
  if (failures.length > 0) {
    console.log("  top failure categories :");
    for (const f of failures.slice(0, 6)) {
      console.log(`    ${f.category.padEnd(24)} ${f.count}`);
    }
  }
  console.log(`  artifacts              : ${written.jsonPath}`);
  console.log(`                           ${written.markdownPath}`);
  console.log(`                           ${written.manifestPath}`);
}

void main();
