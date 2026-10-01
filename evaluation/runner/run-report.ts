/**
 * FlowPilot AI Evaluation — run reporting (PROMPT-AI-EVAL-03).
 *
 * Produces the required artifacts from one `RunnerResult`:
 *   A. machine-readable result  → `<out>/evaluation-run.json` (EVAL-01 schema)
 *   B. human-readable summary   → `<out>/report.md`
 *   C. per-case result details  → in both (the JSON `caseResults[]` + a table)
 *   D. aggregated metric report → the metrics section (with denominators)
 *   E. failure-category table   → the closed failure taxonomy aggregation
 *   +  reproducibility manifest → `<out>/manifest.json`
 *
 * Every number is traceable to case ids. The JSON is validated against the
 * EVAL-01 `evaluationRunSchema` before it is written, so a report can never
 * drift from the schema.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { parseEvaluationRun } from "../schema/evaluation-result-schema";
import { aggregateFailures, failureTaxonomyTable } from "./failure-taxonomy";
import type { MetricWithDenominator } from "./metrics";
import type { RunnerResult } from "./runner";
import type { ScoredCase } from "./scoring-engine";

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

function m(md: MetricWithDenominator | undefined): string {
  if (!md) return "n/a";
  return `${pct(md.value)} (${md.numerator}/${md.denominator})`;
}

function table(rows: string[][]): string {
  if (rows.length === 0) return "";
  const widths = rows[0]!.map((_, i) =>
    Math.max(...rows.map((r) => (r[i] ?? "").length)),
  );
  const line = (r: string[]) =>
    r
      .map((c, i) => (c ?? "").padEnd(widths[i]!))
      .join(" | ")
      .trimEnd();
  const header = line(rows[0]!);
  const sep = widths.map((w) => "-".repeat(Math.max(w, 3))).join(" | ");
  return [header, sep, ...rows.slice(1).map(line)].join("\n");
}

/** The compact expected/actual triple used in per-case lines. */
function triple(record: ScoredCase["record"]): {
  expected: string;
  actual: string;
} {
  const e = record.expected as Record<string, unknown>;
  const expected = `${e.currentIntent ?? record.expected.primaryIntent}/${e.currentAction ?? record.expected.expectedAction}/${record.expected.handoffExpectation}`;
  const a = record.actual;
  const handed =
    a.action === "handoff" ||
    a.action === "booking_handoff" ||
    a.disclosure === "requires-human";
  const actual = `${a.intent ?? "∅"}/${a.action ?? "∅"}/${handed ? "handoff" : "no-handoff"}`;
  return { expected, actual };
}

export function renderMarkdown(result: RunnerResult): string {
  const { run, scored, metrics, manifest } = result;
  const d = metrics.denominators;
  const lines: string[] = [];

  lines.push("# FlowPilot AI — Evaluation Run");
  lines.push("");
  lines.push(
    `> run \`${run.run.runId}\` · dataset \`${run.run.datasetVersion}\` · target \`${manifest.targetId}\` · mode \`${manifest.executionMode}\``,
  );
  lines.push(
    `> evaluator \`${manifest.evaluatorVersion}\` · scoring \`${manifest.scoringVersion}\` · executed ${run.run.executedAt}`,
  );
  lines.push(
    `> subject: \`${run.system.kind}\`${run.system.modelProvider ? ` · ${run.system.modelProvider}` : ""}`,
  );
  lines.push("");
  lines.push(
    "> This is measurement infrastructure output. It is NOT a production " +
      "baseline claim — the dedicated baseline analysis is a separate slice.",
  );
  lines.push("");

  // ── verdicts ───────────────────────────────────────────────────────────
  lines.push("## 1. Verdicts");
  lines.push("");
  lines.push(
    table([
      ["measure", "value"],
      ["total cases", String(metrics.totalCases)],
      ["total turns", String(metrics.totalTurns)],
      ["scored cases (AI-owned)", String(metrics.scoredCases)],
      ["PASS", String(metrics.passCount)],
      ["LIMITATION", String(metrics.limitationCount)],
      ["FAIL", String(metrics.failCount)],
      ["SEAM_OWNED (excluded)", String(metrics.seamOwnedCount)],
    ]),
  );
  lines.push("");

  // ── metrics ──────────────────────────────────────────────────────────────
  lines.push("## 2. Metrics (value + numerator/denominator)");
  lines.push("");
  lines.push(
    table([
      ["metric", "value (n/d)"],
      ["intent accuracy", m(d.intentAccuracy)],
      [
        "intent accuracy (limitation-adj)",
        m(d.intentAccuracyLimitationAdjusted),
      ],
      ["action accuracy", m(d.actionAccuracy)],
      ["handoff precision", m(d.handoffPrecision)],
      ["handoff recall", m(d.handoffRecall)],
      ["unnecessary handoff rate", m(d.unnecessaryHandoffRate)],
      ["missed handoff rate", m(d.missedHandoffRate)],
      ["entity extraction accuracy", m(d.entityExtractionAccuracy)],
      ["multi-intent success rate", m(d.multiIntentSuccessRate)],
      ["ambiguity handling accuracy", m(d.ambiguityHandlingAccuracy)],
      ["clarification accuracy", m(d.clarificationAccuracy)],
      ["knowledge requirement accuracy", m(d.knowledgeRequirementAccuracy)],
      ["conversation-state accuracy", m(d.conversationStateAccuracy)],
      ["booking-state accuracy", m(d.bookingStateAccuracy)],
      ["safety violation rate", m(d.safetyViolationRate)],
      ["provider failure rate", m(d.providerFailureRate)],
      ["malformed output rate", m(d.malformedOutputRate)],
      ["deterministic bypass correctness", m(d.deterministicBypassCorrectness)],
    ]),
  );
  lines.push("");

  // ── handoff channels ───────────────────────────────────────────────────
  lines.push("## 3. Handoff outcome channels (kept separate)");
  lines.push("");
  const channelRows: string[][] = [["channel", "count"]];
  for (const [k, v] of Object.entries(metrics.handoffOutcomeClasses).sort()) {
    channelRows.push([k, String(v)]);
  }
  lines.push(table(channelRows));
  lines.push("");

  // ── failure taxonomy ──────────────────────────────────────────────────
  lines.push("## 4. Failure-category aggregation");
  lines.push("");
  lines.push(
    table([
      ["failure category", "count", "sample case ids"],
      ...failureTaxonomyTable(scored).map((b) => [
        b.category,
        String(b.count),
        b.sampleCaseIds.slice(0, 3).join(", "),
      ]),
    ]),
  );
  lines.push("");

  // ── filtered views ───────────────────────────────────────────────────────
  lines.push("## 5. Filtered views");
  lines.push("");
  lines.push("### 5a. By edge category");
  lines.push("");
  lines.push(byFacet(scored, (s) => s.facets.edgeCategories));
  lines.push("");
  lines.push("### 5b. By language register");
  lines.push("");
  lines.push(byFacet(scored, (s) => [s.facets.languageRegister]));
  lines.push("");
  lines.push("### 5c. By rarity");
  lines.push("");
  lines.push(byFacet(scored, (s) => [s.facets.rarity]));
  lines.push("");

  // ── missed + unnecessary handoffs ─────────────────────────────────────
  const missed = scored.filter(
    (s) => s.record.failureCategory === "HANDOFF_MISSED",
  );
  const unnecessary = scored.filter(
    (s) => s.record.failureCategory === "HANDOFF_UNNECESSARY",
  );
  lines.push("### 5d. MISSED handoffs (a human was required, none routed)");
  lines.push("");
  lines.push(missed.length === 0 ? "_None._" : caseLines(missed));
  lines.push("");
  lines.push(
    "### 5e. UNNECESSARY handoffs (system escalated a resolvable turn)",
  );
  lines.push("");
  lines.push(unnecessary.length === 0 ? "_None._" : caseLines(unnecessary));
  lines.push("");

  // ── per-case detail (bounded sample) ─────────────────────────────────────
  lines.push("## 6. Per-case results (first 50; full set in the JSON)");
  lines.push("");
  for (const s of scored.slice(0, 50)) {
    const t = triple(s.record);
    lines.push(
      `- **${s.record.caseId}** — expected \`${t.expected}\` · actual \`${t.actual}\` · **${s.record.verdict}**${s.record.verdict === "FAIL" || s.record.verdict === "LIMITATION" ? ` (${s.record.failureCategory})` : ""}`,
    );
  }
  lines.push("");
  lines.push("## 7. Traceability");
  lines.push("");
  lines.push(
    "Every number derives from `caseResults[]` in `evaluation-run.json`. " +
      "Each record carries `caseId`, `scenarioId`, the expected snapshot, the " +
      "actual outcome, the verdict, and the failure category. Filter the JSON " +
      "by any field to reproduce a metric exactly. `manifest.json` pins the " +
      "dataset hash + evaluator/scoring versions for replay.",
  );
  lines.push("");
  return lines.join("\n");
}

function caseLines(scored: ScoredCase[]): string {
  return scored
    .slice(0, 25)
    .map((s) => {
      const t = triple(s.record);
      return `- **${s.record.caseId}** — expected \`${t.expected}\` · actual \`${t.actual}\``;
    })
    .join("\n");
}

function byFacet(
  scored: ScoredCase[],
  keys: (s: ScoredCase) => string[],
): string {
  const map = new Map<
    string,
    { total: number; fail: number; limitation: number }
  >();
  for (const s of scored) {
    for (const k of keys(s)) {
      const e = map.get(k) ?? { total: 0, fail: 0, limitation: 0 };
      e.total += 1;
      if (s.record.verdict === "FAIL") e.fail += 1;
      if (s.record.verdict === "LIMITATION") e.limitation += 1;
      map.set(k, e);
    }
  }
  const rows = [...map.entries()]
    .sort((a, b) => b[1].fail - a[1].fail || b[1].total - a[1].total)
    .map(([k, v]) => [
      k,
      String(v.total),
      String(v.fail),
      String(v.limitation),
    ]);
  return table([["facet", "cases", "FAIL", "LIMITATION"], ...rows]);
}

export type WrittenArtifacts = {
  jsonPath: string;
  markdownPath: string;
  manifestPath: string;
};

/** Write the machine JSON + markdown + manifest to `outDir`. */
export function writeRunArtifacts(
  result: RunnerResult,
  outDir: string,
): WrittenArtifacts {
  // Validate the machine artifact against the EVAL-01 schema before writing.
  const validated = parseEvaluationRun(result.run);
  const base = resolve(process.cwd(), outDir);
  mkdirSync(base, { recursive: true });

  const jsonPath = resolve(base, "evaluation-run.json");
  writeFileSync(jsonPath, `${JSON.stringify(validated, null, 2)}\n`, "utf8");

  const markdownPath = resolve(base, "report.md");
  writeFileSync(markdownPath, renderMarkdown(result), "utf8");

  const manifestPath = resolve(base, "manifest.json");
  writeFileSync(
    manifestPath,
    `${JSON.stringify(result.manifest, null, 2)}\n`,
    "utf8",
  );

  return { jsonPath, markdownPath, manifestPath };
}

/** The failure aggregation, exported for programmatic callers (CLI summary). */
export { aggregateFailures };
