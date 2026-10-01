/**
 * FlowPilot AI Evaluation — report builder.
 *
 * Produces the two baseline artifacts:
 *  - machine-readable JSON (per-case results + aggregate metrics), so a
 *    metric is always traceable back to individual case ids.
 *  - human-readable Markdown summary with the required failure views.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { EvaluationCase } from "../schema/dataset-schema";
import type { AggregateReport, CaseResult } from "./scoring";
import {
  aggregate,
  failuresByEdgeCategory,
  limitationsBySemanticIntent,
  unnecessaryHandoffByIntent,
} from "./scoring";

export type EvalReport = {
  meta: {
    datasetVersion: string;
    generatedAt: string;
    subject: string;
    notes: string;
  };
  aggregate: AggregateReport;
  caseResults: CaseResult[];
};

export function buildReport(input: {
  datasetVersion: string;
  cases: EvaluationCase[];
  results: CaseResult[];
}): EvalReport {
  return {
    meta: {
      datasetVersion: input.datasetVersion,
      generatedAt: new Date().toISOString(),
      subject:
        "current FlowPilot AI (deterministic classifier + disclosure gate), offline replay",
      notes:
        "LIMITATION verdicts are architectural-gap evidence (the current contract cannot represent the goal), reported separately from FAIL verdicts.",
    },
    aggregate: aggregate(input.results),
    caseResults: input.results,
  };
}

export function writeJsonReport(report: EvalReport, outPath: string): string {
  const path = resolve(process.cwd(), outPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2), "utf8");
  return path;
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

function table(lines: string[][]): string {
  if (lines.length === 0) return "";
  const widths = lines[0]!.map((_, i) =>
    Math.max(...lines.map((row) => row[i]!.length)),
  );
  return lines
    .map((row, ri) =>
      row
        .map((cell, ci) => cell.padEnd(widths[ci]!))
        .join(ri === 0 ? " | " : " | ")
        .trimEnd(),
    )
    .join("\n");
}

export function writeMarkdownReport(
  report: EvalReport,
  outPath: string,
): string {
  const a = report.aggregate;
  const lines: string[] = [];
  lines.push("# FlowPilot AI — Current-AI Baseline Report");
  lines.push("");
  lines.push(
    `> Dataset: \`${report.meta.datasetVersion}\` · generated ${report.meta.generatedAt}`,
  );
  lines.push(`> Subject: ${report.meta.subject}`);
  lines.push("");
  lines.push("## 1. Dataset size");
  lines.push("");
  lines.push(
    table([
      ["measure", "value"],
      ["cases", String(a.totalCases)],
      ["scenarios", String(a.totalScenarios)],
      ...Object.entries(a.byConversationType)
        .sort()
        .map(([k, v]) => [k, String(v)]),
      ...Object.entries(a.byOrientation)
        .sort()
        .map(([k, v]) => [`${k} cases`, String(v)]),
    ]),
  );
  lines.push("");

  lines.push("## 2. Baseline metrics");
  lines.push("");
  lines.push(
    table([
      ["metric", "value"],
      ["intent accuracy (strict)", pct(a.intentAccuracy)],
      [
        "intent accuracy (limitation-adjusted)",
        pct(a.intentAccuracyLimitationAdjusted),
      ],
      ["action accuracy (strict)", pct(a.actionAccuracy)],
      [
        "action accuracy (limitation-adjusted)",
        pct(a.actionAccuracyLimitationAdjusted),
      ],
      ["handoff precision", pct(a.handoffPrecision)],
      ["handoff recall", pct(a.handoffRecall)],
      ["unnecessary handoff rate", pct(a.unnecessaryHandoffRate)],
      ["missed handoff rate", pct(a.missedHandoffRate)],
      ["entity extraction accuracy", pct(a.entityExtractionAccuracy)],
      ["FAQ answer correctness", pct(a.faqAnswerCorrectness)],
      ["multi-intent success rate", pct(a.multiIntentSuccessRate)],
      ["ambiguity handled acceptably", pct(a.ambiguityHandledAcceptably)],
      [
        "conversation continuity accuracy",
        pct(a.conversationContinuityAccuracy),
      ],
      ["safety violation rate", pct(a.safetyViolationRate)],
      ["malformed output rate", pct(a.malformedOutputRate)],
      [
        "deterministic bypass correctness",
        pct(a.deterministicBypassCorrectness),
      ],
      ["engine-seam-owned turns (excluded)", String(a.seamOwnedCases)],
    ]),
  );
  lines.push("");
  lines.push(
    `Handoff truth split — TRUE human required: **${a.handoffTrue}**, missed: **${a.handoffMissed}**, ` +
      `unnecessary: **${a.handoffUnnecessary}**, acceptable-by-design (booking routed to staff): **${a.handoffAcceptable}**, ` +
      `correctly no handoff: **${a.handoffNoHandoff}**. Verdicts — PASS **${a.passCases}**, ` +
      `LIMITATION **${a.limitationCases}**, FAIL **${a.failCases}**.`,
  );
  lines.push("");

  const byCat = failuresByEdgeCategory(report.caseResults);
  lines.push("## 3. Top failure categories (edge category)");
  lines.push("");
  lines.push(
    table([
      ["edge category", "cases", "FAIL", "LIMITATION"],
      ...byCat
        .slice(0, 12)
        .map((c) => [
          c.category,
          String(c.total),
          String(c.fails),
          String(c.limitations),
        ]),
    ]),
  );
  lines.push("");

  const unneeded = unnecessaryHandoffByIntent(report.caseResults);
  lines.push("## 4. Top unnecessary-handoff categories");
  lines.push("");
  if (unneeded.length === 0) {
    lines.push("_None recorded._");
  } else {
    lines.push(
      table([
        ["semantic intent", "unnecessary handoffs", "sample case ids"],
        ...unneeded.map((c) => [
          c.category,
          String(c.unnecessary),
          c.sampleCaseIds.slice(0, 3).join(", "),
        ]),
      ]),
    );
  }
  lines.push("");

  const missed = report.caseResults.filter((r) => r.handoff === "MISSED");
  lines.push(
    "### 4b. MISSED handoffs — a human was required and the AI did not hand off",
  );
  lines.push("");
  if (missed.length === 0) {
    lines.push("_None recorded — every REQUIRED handoff fired._");
  } else {
    lines.push(
      table([
        ["caseId", "message", "expected", "actual"],
        ...missed.map((r) => [
          r.caseId,
          r.evaluatedMessage.slice(0, 36),
          `${r.expected.intent}/${r.expected.handoffReason ?? "-"}`,
          `${r.actual.intent}/${r.actual.handoffReason ?? "-"}`,
        ]),
      ]),
    );
    lines.push("");
    lines.push(
      "These are the highest-severity findings in the baseline: the customer " +
        "asked for a human (or a sensitive turn needed staff) and the thread " +
        "stayed AI_ACTIVE with a self-authored reply.",
    );
  }
  lines.push("");

  const gaps = knowledgeGaps(report.caseResults);
  lines.push("## 5. Knowledge-gap categories");
  lines.push("");
  lines.push(
    table([
      [
        "knowledge requirement",
        "cases",
        "not self-answered",
        "sample case ids",
      ],
      ...gaps.map((g) => [
        g.requirement,
        String(g.cases),
        String(g.notAnswered),
        g.sampleCaseIds.slice(0, 3).join(", "),
      ]),
    ]),
  );
  lines.push("");

  const selfAnswered = selfAnswerByIntent(report.caseResults);
  lines.push("### 5b. Self-answer rate by semantic intent");
  lines.push("");
  lines.push(
    table([
      [
        "semantic intent",
        "cases",
        "self-answered",
        "acceptable handoff",
        "unnecessary",
      ],
      ...selfAnswered.map((g) => [
        g.intent,
        String(g.cases),
        String(g.selfAnswered),
        String(g.acceptable),
        String(g.unnecessary),
      ]),
    ]),
  );
  lines.push("");

  const lims = limitationsBySemanticIntent(report.caseResults);
  lines.push("## 6. Architectural limitations by semantic intent");
  lines.push("");
  lines.push(
    table([
      ["semantic intent", "limitation cases", "sample case ids"],
      ...lims.map((l) => [
        l.intent,
        String(l.cases),
        l.sampleCaseIds.slice(0, 3).join(", "),
      ]),
    ]),
  );
  lines.push("");

  const byRegister = registerFailures(report.caseResults);
  lines.push("## 7. Language / register robustness");
  lines.push("");
  lines.push(
    table([
      ["language register", "cases", "FAIL", "LIMITATION"],
      ...byRegister.map((r) => [
        r.register,
        String(r.total),
        String(r.fails),
        String(r.limitations),
      ]),
    ]),
  );
  lines.push("");
  lines.push("## 8. Traceability");
  lines.push("");
  lines.push(
    "Every metric above is computed from the per-case records in the sibling " +
      "`.json` report (`caseResults[]`): each record carries `caseId`, " +
      "`scenarioId`, the evaluated message, the expected vs actual outcome, " +
      "and the verdicts. Filter `caseResults` by any field to reproduce a " +
      "number exactly. Turns owned by the deterministic booking-selection " +
      'seam (`intentVerdict === "SEAM_OWNED"`) are recorded but excluded ' +
      "from AI metrics — the engine resolves them before any assistant call.",
  );
  lines.push("");

  const path = resolve(process.cwd(), outPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join("\n"), "utf8");
  return path;
}

type RegisterRow = {
  register: string;
  total: number;
  fails: number;
  limitations: number;
};

function registerFailures(results: CaseResult[]): RegisterRow[] {
  const map = new Map<string, RegisterRow>();
  for (const r of results) {
    const entry = map.get(r.languageRegister) ?? {
      register: r.languageRegister,
      total: 0,
      fails: 0,
      limitations: 0,
    };
    entry.total += 1;
    if (r.intentVerdict === "FAIL") entry.fails += 1;
    if (r.intentVerdict === "LIMITATION") entry.limitations += 1;
    map.set(r.languageRegister, entry);
  }
  return [...map.values()].sort((a, b) => b.fails - a.fails);
}

type KnowledgeRow = {
  requirement: string;
  cases: number;
  notAnswered: number;
  sampleCaseIds: string[];
};

/** Group by the case's declared knowledge requirement. */
function knowledgeGaps(results: CaseResult[]): KnowledgeRow[] {
  const map = new Map<string, KnowledgeRow>();
  for (const r of results) {
    const req = knowledgeRequirementFor(r);
    const entry = map.get(req) ?? {
      requirement: req,
      cases: 0,
      notAnswered: 0,
      sampleCaseIds: [],
    };
    entry.cases += 1;
    const selfAnswered =
      r.actual.action === "reply" && r.actual.disclosure === "disclosed";
    if (!selfAnswered) {
      entry.notAnswered += 1;
      if (entry.sampleCaseIds.length < 5) entry.sampleCaseIds.push(r.caseId);
    }
    map.set(req, entry);
  }
  return [...map.values()].sort((a, b) => b.notAnswered - a.notAnswered);
}

/**
 * The knowledge requirement lives on the case, not the per-case result; it is
 * recovered from the semantic intent + edge categories as a stable proxy.
 */
function knowledgeRequirementFor(r: CaseResult): string {
  return r.knowledgeRequirement;
}

type SelfAnswerRow = {
  intent: string;
  cases: number;
  selfAnswered: number;
  acceptable: number;
  unnecessary: number;
};

function selfAnswerByIntent(results: CaseResult[]): SelfAnswerRow[] {
  const map = new Map<string, SelfAnswerRow>();
  for (const r of results) {
    const entry = map.get(r.semanticPrimaryIntent) ?? {
      intent: r.semanticPrimaryIntent,
      cases: 0,
      selfAnswered: 0,
      acceptable: 0,
      unnecessary: 0,
    };
    entry.cases += 1;
    if (r.actual.action === "reply" && r.actual.disclosure === "disclosed") {
      entry.selfAnswered += 1;
    } else if (r.handoff === "UNNECESSARY") {
      entry.unnecessary += 1;
    } else {
      entry.acceptable += 1;
    }
    map.set(r.semanticPrimaryIntent, entry);
  }
  return [...map.values()].sort((a, b) => b.cases - a.cases);
}
