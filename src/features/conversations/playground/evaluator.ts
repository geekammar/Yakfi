/**
 * FlowPilot Conversation Playground — Automated Comparative Evaluator
 * CONV-JEV-01: Multi-Engine Benchmark & Diagnostic Evaluator
 *
 * Compares:
 *   A. Deterministic Baseline (Hybrid B local rules)
 *   B. Goal-Driven Hybrid (Local state projection)
 *   C. TypeSafe JEV + Goal-Driven State (Pinned model typesafe/jev-1.13)
 *   D. Full Agent C (Optional generative reference)
 */

import { runAgentCScenario } from "./agent-c-runner";
import { runGoalDrivenScenario } from "./goal-driven-runner";
import { GOLDEN_SCENARIOS } from "./golden-scenarios";
import { runHybridScenario } from "./hybrid-runner";
import { runTypeSafeJevScenario } from "./jev-runner";
import type {
  BenchmarkComparisonReport,
  ScenarioComparison,
  ScenarioDefinition,
  ScenarioTrace,
} from "./types";

export type EvaluateOptions = {
  scenarios?: ScenarioDefinition[];
  saveTraces?: boolean;
  tracesDir?: string;
  architectures?: Array<"hybrid" | "goal_driven" | "typesafe_jev" | "agent_c">;
  live?: boolean;
};

export function calculatePercentiles(values: number[]): {
  median: number;
  p95: number;
} {
  if (values.length === 0) return { median: 0, p95: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 !== 0
      ? sorted[mid]!
      : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
  const p95Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  const p95 = sorted[p95Idx]!;
  return { median, p95 };
}

export async function evaluateBenchmark(
  options: EvaluateOptions = {},
): Promise<{
  report: BenchmarkComparisonReport;
  hybridTraces: ScenarioTrace[];
  goalDrivenTraces: ScenarioTrace[];
  typeSafeJevTraces: ScenarioTrace[];
  agentCTraces: ScenarioTrace[];
}> {
  const scenarios = options.scenarios ?? GOLDEN_SCENARIOS;
  const includeAgentC = options.architectures?.includes("agent_c") ?? false;
  const isLive = Boolean(options.live);

  const hybridTraces: ScenarioTrace[] = [];
  const goalDrivenTraces: ScenarioTrace[] = [];
  const typeSafeJevTraces: ScenarioTrace[] = [];
  const agentCTraces: ScenarioTrace[] = [];
  const comparisons: ScenarioComparison[] = [];

  for (const scenario of scenarios) {
    // 1. Run Architecture A: Deterministic Baseline
    const hybridTrace = await runHybridScenario(scenario);
    hybridTraces.push(hybridTrace);

    // 2. Run Architecture B: Goal-Driven Hybrid
    const goalDrivenTrace = await runGoalDrivenScenario(scenario);
    goalDrivenTraces.push(goalDrivenTrace);

    // 3. Run Architecture C: TypeSafe JEV + Goal-Driven State
    const typeSafeJevTrace = await runTypeSafeJevScenario(scenario, {
      live: isLive,
    });
    typeSafeJevTraces.push(typeSafeJevTrace);

    // 4. Run Architecture D: Full Agent C (optional)
    let agentCTrace: ScenarioTrace | null = null;
    if (includeAgentC) {
      agentCTrace = await runAgentCScenario(scenario);
      agentCTraces.push(agentCTrace);
    }

    const jevCalls = typeSafeJevTrace.turns.reduce(
      (sum, t) => sum + (t.processing.jevCalls ?? 0),
      0,
    );
    const jevCostUsd = typeSafeJevTrace.turns.reduce(
      (sum, t) => sum + (t.processing.latencyAndCost?.costUsd ?? 0),
      0,
    );

    comparisons.push({
      scenarioId: scenario.id,
      title: scenario.title,
      category: scenario.category,
      hybridVerdict: hybridTrace.verdict,
      goalDrivenVerdict: goalDrivenTrace.verdict,
      typeSafeJevVerdict: typeSafeJevTrace.verdict,
      agentCVerdict: agentCTrace ? agentCTrace.verdict : "PASS",
      hybridDurationMs: hybridTrace.metrics.totalDurationMs,
      goalDrivenDurationMs: goalDrivenTrace.metrics.totalDurationMs,
      typeSafeJevDurationMs: typeSafeJevTrace.metrics.totalDurationMs,
      agentCDurationMs: agentCTrace ? agentCTrace.metrics.totalDurationMs : 0,
      hybridLlmCalls: hybridTrace.metrics.totalLlmCalls,
      goalDrivenLlmCalls: goalDrivenTrace.metrics.totalLlmCalls,
      typeSafeJevLlmCalls: typeSafeJevTrace.metrics.totalLlmCalls,
      typeSafeJevCalls: jevCalls,
      typeSafeJevCostUsd: jevCostUsd,
      agentCLlmCalls: agentCTrace ? agentCTrace.metrics.totalLlmCalls : 0,
      notes:
        typeSafeJevTrace.verdict === "FAIL"
          ? `TypeSafe JEV: ${typeSafeJevTrace.failureReason}`
          : goalDrivenTrace.verdict === "FAIL"
            ? `Goal-Driven: ${goalDrivenTrace.failureReason}`
            : hybridTrace.verdict === "FAIL"
              ? `Deterministic Baseline: ${hybridTrace.failureReason}`
              : undefined,
    });
  }

  const totalScenarios = scenarios.length;
  const hybridPassed = hybridTraces.filter((t) => t.verdict === "PASS").length;
  const goalDrivenPassed = goalDrivenTraces.filter(
    (t) => t.verdict === "PASS",
  ).length;
  const typeSafeJevPassed = typeSafeJevTraces.filter(
    (t) => t.verdict === "PASS",
  ).length;
  const agentCPassed = agentCTraces.filter((t) => t.verdict === "PASS").length;

  const hybridDurations = hybridTraces.map((t) => t.metrics.totalDurationMs);
  const goalDrivenDurations = goalDrivenTraces.map(
    (t) => t.metrics.totalDurationMs,
  );
  const typeSafeJevDurations = typeSafeJevTraces.map(
    (t) => t.metrics.totalDurationMs,
  );
  const agentCDurations = agentCTraces.map((t) => t.metrics.totalDurationMs);

  const hybridTotalDuration = hybridDurations.reduce((a, b) => a + b, 0);
  const goalDrivenTotalDuration = goalDrivenDurations.reduce(
    (a, b) => a + b,
    0,
  );
  const typeSafeJevTotalDuration = typeSafeJevDurations.reduce(
    (a, b) => a + b,
    0,
  );
  const agentCTotalDuration = agentCDurations.reduce((a, b) => a + b, 0);

  const hybridTotalLlmCalls = hybridTraces.reduce(
    (acc, t) => acc + t.metrics.totalLlmCalls,
    0,
  );
  const goalDrivenTotalLlmCalls = goalDrivenTraces.reduce(
    (acc, t) => acc + t.metrics.totalLlmCalls,
    0,
  );
  const typeSafeJevTotalLlmCalls = typeSafeJevTraces.reduce(
    (acc, t) => acc + t.metrics.totalLlmCalls,
    0,
  );
  const typeSafeJevTotalCalls = typeSafeJevTraces.reduce(
    (acc, t) =>
      acc +
      t.turns.reduce((ts, turn) => ts + (turn.processing.jevCalls ?? 0), 0),
    0,
  );
  const typeSafeJevTotalCostUsd = typeSafeJevTraces.reduce(
    (acc, t) =>
      acc +
      t.turns.reduce(
        (ts, turn) => ts + (turn.processing.latencyAndCost?.costUsd ?? 0),
        0,
      ),
    0,
  );
  const agentCTotalLlmCalls = agentCTraces.reduce(
    (acc, t) => acc + t.metrics.totalLlmCalls,
    0,
  );

  const hybridTotalTokens = hybridTraces.reduce(
    (acc, t) => acc + (t.metrics.totalTokens?.totalTokens ?? 0),
    0,
  );
  const goalDrivenTotalTokens = goalDrivenTraces.reduce(
    (acc, t) => acc + (t.metrics.totalTokens?.totalTokens ?? 0),
    0,
  );
  const typeSafeJevTotalTokens = typeSafeJevTraces.reduce(
    (acc, t) => acc + (t.metrics.totalTokens?.totalTokens ?? 0),
    0,
  );
  const agentCTotalTokens = agentCTraces.reduce(
    (acc, t) => acc + (t.metrics.totalTokens?.totalTokens ?? 0),
    0,
  );

  const report: BenchmarkComparisonReport = {
    timestamp: new Date().toISOString(),
    evaluationMode: isLive ? "LIVE_TYPESAFE_JEV" : "OFFLINE_SIMULATION",
    totalScenarios,
    hybridPassed,
    goalDrivenPassed,
    typeSafeJevPassed,
    agentCPassed,
    hybridAvgDurationMs:
      totalScenarios > 0 ? Math.round(hybridTotalDuration / totalScenarios) : 0,
    goalDrivenAvgDurationMs:
      totalScenarios > 0
        ? Math.round(goalDrivenTotalDuration / totalScenarios)
        : 0,
    typeSafeJevAvgDurationMs:
      totalScenarios > 0
        ? Math.round(typeSafeJevTotalDuration / totalScenarios)
        : 0,
    agentCAvgDurationMs:
      agentCTraces.length > 0
        ? Math.round(agentCTotalDuration / agentCTraces.length)
        : 0,
    hybridTotalLlmCalls,
    goalDrivenTotalLlmCalls,
    typeSafeJevTotalLlmCalls,
    typeSafeJevTotalCalls,
    typeSafeJevTotalCostUsd,
    agentCTotalLlmCalls,
    hybridTotalTokens,
    goalDrivenTotalTokens,
    typeSafeJevTotalTokens,
    agentCTotalTokens,
    comparisons,
  };

  return {
    report,
    hybridTraces,
    goalDrivenTraces,
    typeSafeJevTraces,
    agentCTraces,
  };
}

export function formatComparisonMarkdown(
  report: BenchmarkComparisonReport,
): string {
  const hybridPassPct = Math.round(
    (report.hybridPassed / report.totalScenarios) * 100,
  );
  const goalDrivenPassPct = Math.round(
    ((report.goalDrivenPassed ?? 0) / report.totalScenarios) * 100,
  );
  const jevPassPct = Math.round(
    ((report.typeSafeJevPassed ?? 0) / report.totalScenarios) * 100,
  );

  const modeBadge =
    report.evaluationMode === "LIVE_TYPESAFE_JEV"
      ? "🔴 **LIVE NETWORK BENCHMARK (Real OpenRouter Decisions API `typesafe/jev-1.13`)**"
      : "🟡 **OFFLINE SIMULATION (Deterministic Mock / Zero Remote Spend)**";

  let md = `# تقرير المقارنة المعيارية الشاملة — FlowPilot CONV-JEV-01\n\n`;
  md += `**حالة بيئة التقييم**: ${modeBadge}\n`;
  md += `**تاريخ التقرير**: ${report.timestamp}\n`;
  md += `**إجمالي السيناريوهات الذهبية المختبرة**: ${report.totalScenarios}\n\n`;

  md += `## جدول المقارنة المعيارية بين المحركات\n\n`;
  md += `| المعيار القياسي | A. Deterministic Baseline | B. Goal-Driven State | C. TypeSafe JEV + Goal-Driven |\n`;
  md += `| :--- | :---: | :---: | :---: |\n`;
  md += `| **نسبة النجاح الإجمالية** | **${hybridPassPct}%** (${report.hybridPassed}/${report.totalScenarios}) | **${goalDrivenPassPct}%** (${report.goalDrivenPassed ?? 0}/${report.totalScenarios}) | **${jevPassPct}%** (${report.typeSafeJevPassed ?? 0}/${report.totalScenarios}) |\n`;
  md += `| **متوسط زمن الاستجابة** | **${report.hybridAvgDurationMs} ms** | **${report.goalDrivenAvgDurationMs ?? 0} ms** | **${report.typeSafeJevAvgDurationMs ?? 0} ms** |\n`;
  md += `| **إجمالي استدعاءات LLM التوليدي** | **${report.hybridTotalLlmCalls}** | **${report.goalDrivenTotalLlmCalls ?? 0}** | **${report.typeSafeJevTotalLlmCalls ?? 0}** |\n`;
  md += `| **استدعاءات قرارات TypeSafe JEV** | 0 | 0 | **${report.typeSafeJevTotalCalls ?? 0}** |\n`;
  md += `| **إجمالي التكلفة التقديرية (USD)** | $0.00 | $0.00 | **$${(report.typeSafeJevTotalCostUsd ?? 0).toFixed(6)}** |\n`;
  md += `| **إجمالي التوكنز المستهلكة** | **${report.hybridTotalTokens}** | **${report.goalDrivenTotalTokens ?? 0}** | **${report.typeSafeJevTotalTokens ?? 0}** |\n\n`;

  md += `## تفاصيل السيناريوهات الذهبية (Sample Summary)\n\n`;
  md += `| المعرف | الفئة | اسم السيناريو | Baseline | Goal-Driven | TypeSafe JEV | زمن JEV (ms) | نداءات JEV |\n`;
  md += `| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: |\n`;

  for (const c of report.comparisons) {
    const hIcon = c.hybridVerdict === "PASS" ? "✔" : "❌";
    const gdIcon = c.goalDrivenVerdict === "PASS" ? "✔" : "❌";
    const jevIcon = c.typeSafeJevVerdict === "PASS" ? "✔" : "❌";
    md += `| ${c.scenarioId} | ${c.category} | ${c.title} | ${hIcon} | ${gdIcon} | ${jevIcon} | ${c.typeSafeJevDurationMs ?? 0} | ${c.typeSafeJevCalls ?? 0} |\n`;
  }

  return md;
}
