/**
 * FlowPilot AI Evaluation — baseline runner CLI.
 *
 * Loads a generated dataset version and runs the CURRENT production AI
 * behavior against it (offline), then writes the JSON + Markdown baseline
 * report. Fully deterministic and network-free.
 *
 * Run: pnpm eval:baseline [--dataset egyptian-v1]
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { EGYPTIAN_V1_VERSION } from "../evaluation/datasets/egyptian-v1";
import { runCurrentAiForCase } from "../evaluation/runner/current-ai-adapter";
import {
  buildReport,
  writeJsonReport,
  writeMarkdownReport,
} from "../evaluation/runner/report";
import { scoreCase } from "../evaluation/runner/scoring";
import { safeParseDataset } from "../evaluation/schema/dataset-schema";

const DATASETS_DIR = "evaluation/datasets";
const REPORTS_DIR = "evaluation/reports";

function readDataset(version: string): unknown {
  const path = resolve(
    process.cwd(),
    DATASETS_DIR,
    version,
    `${version}.dataset.json`,
  );
  return JSON.parse(readFileSync(path, "utf8"));
}

async function main(): Promise<void> {
  const versionArg = process.argv[2] ?? EGYPTIAN_V1_VERSION;
  const version = versionArg.startsWith("--dataset=")
    ? versionArg.slice("--dataset=".length)
    : versionArg;

  const raw = readDataset(version);
  const parsed = safeParseDataset(raw);
  if (!parsed.success) {
    console.error(`dataset ${version} failed validation`);
    console.error(parsed.error.message.slice(0, 800));
    process.exit(1);
  }
  const dataset = parsed.data;

  const results = [];
  for (const c of dataset.cases) {
    const outcome = await runCurrentAiForCase(c);
    results.push(scoreCase(c, outcome));
  }

  const report = buildReport({
    datasetVersion: version,
    cases: dataset.cases,
    results,
  });
  const jsonPath = writeJsonReport(
    report,
    `${REPORTS_DIR}/${version}/baseline-report.json`,
  );
  const mdPath = writeMarkdownReport(
    report,
    `${REPORTS_DIR}/${version}/baseline-report.md`,
  );

  // A small reproducibility manifest alongside the reports.
  const manifestPath = resolve(
    process.cwd(),
    REPORTS_DIR,
    version,
    "run-manifest.json",
  );
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        datasetVersion: version,
        seed: dataset.meta.seed,
        cases: dataset.cases.length,
        subject: report.meta.subject,
        generatedAt: report.meta.generatedAt,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const a = report.aggregate;
  console.log(`eval:baseline → ${version}`);
  console.log(`  cases                  : ${a.totalCases}`);
  console.log(
    `  intent accuracy        : ${(a.intentAccuracy * 100).toFixed(1)}%`,
  );
  console.log(
    `  intent (limitation-adj): ${(a.intentAccuracyLimitationAdjusted * 100).toFixed(1)}%`,
  );
  console.log(
    `  handoff precision      : ${(a.handoffPrecision * 100).toFixed(1)}%`,
  );
  console.log(
    `  handoff recall         : ${(a.handoffRecall * 100).toFixed(1)}%`,
  );
  console.log(`  unnecessary handoffs   : ${a.handoffUnnecessary}`);
  console.log(`  missed handoffs        : ${a.handoffMissed}`);
  console.log(
    `  entity accuracy        : ${(a.entityExtractionAccuracy * 100).toFixed(1)}%`,
  );
  console.log(
    `  multi-intent success   : ${(a.multiIntentSuccessRate * 100).toFixed(1)}%`,
  );
  console.log(
    `  continuity accuracy    : ${(a.conversationContinuityAccuracy * 100).toFixed(1)}%`,
  );
  console.log(
    `  safety violations      : ${report.caseResults.filter((r) => r.safetyViolation).length}`,
  );
  console.log(`  reports                : ${jsonPath}`);
  console.log(`                           ${mdPath}`);
}

void main();
