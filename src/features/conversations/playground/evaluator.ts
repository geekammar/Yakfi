/**
 * FlowPilot Conversation Playground — Automated Comparative Evaluator
 * Evaluates Hybrid B vs Goal-Driven Hybrid vs Full Agent C across the Golden Scenario corpus.
 */

import { runAgentCScenario } from "./agent-c-runner";
import { runGoalDrivenScenario } from "./goal-driven-runner";
import { GOLDEN_SCENARIOS } from "./golden-scenarios";
import { runHybridScenario } from "./hybrid-runner";
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
  architectures?: Array<"hybrid" | "goal_driven" | "agent_c">;
};

export async function evaluateBenchmark(
  options: EvaluateOptions = {},
): Promise<{
  report: BenchmarkComparisonReport;
  hybridTraces: ScenarioTrace[];
  goalDrivenTraces: ScenarioTrace[];
  agentCTraces: ScenarioTrace[];
}> {
  const scenarios = options.scenarios ?? GOLDEN_SCENARIOS;
  const hybridTraces: ScenarioTrace[] = [];
  const goalDrivenTraces: ScenarioTrace[] = [];
  const agentCTraces: ScenarioTrace[] = [];
  const comparisons: ScenarioComparison[] = [];

  for (const scenario of scenarios) {
    // 1. Run Hybrid B
    const hybridTrace = await runHybridScenario(scenario);
    hybridTraces.push(hybridTrace);

    // 2. Run Goal-Driven Hybrid
    const goalDrivenTrace = await runGoalDrivenScenario(scenario);
    goalDrivenTraces.push(goalDrivenTrace);

    // 3. Run Agent C
    const agentCTrace = await runAgentCScenario(scenario);
    agentCTraces.push(agentCTrace);

    comparisons.push({
      scenarioId: scenario.id,
      title: scenario.title,
      category: scenario.category,
      hybridVerdict: hybridTrace.verdict,
      goalDrivenVerdict: goalDrivenTrace.verdict,
      agentCVerdict: agentCTrace.verdict,
      hybridDurationMs: hybridTrace.metrics.totalDurationMs,
      goalDrivenDurationMs: goalDrivenTrace.metrics.totalDurationMs,
      agentCDurationMs: agentCTrace.metrics.totalDurationMs,
      hybridLlmCalls: hybridTrace.metrics.totalLlmCalls,
      goalDrivenLlmCalls: goalDrivenTrace.metrics.totalLlmCalls,
      agentCLlmCalls: agentCTrace.metrics.totalLlmCalls,
      notes:
        goalDrivenTrace.verdict === "FAIL"
          ? `Goal-Driven failed: ${goalDrivenTrace.failureReason}`
          : hybridTrace.verdict === "FAIL"
            ? `Hybrid B failed: ${hybridTrace.failureReason}`
            : agentCTrace.verdict === "FAIL"
              ? `Agent C failed: ${agentCTrace.failureReason}`
              : undefined,
    });
  }

  const totalScenarios = scenarios.length;
  const hybridPassed = hybridTraces.filter((t) => t.verdict === "PASS").length;
  const goalDrivenPassed = goalDrivenTraces.filter(
    (t) => t.verdict === "PASS",
  ).length;
  const agentCPassed = agentCTraces.filter((t) => t.verdict === "PASS").length;

  const hybridTotalDuration = hybridTraces.reduce(
    (acc, t) => acc + t.metrics.totalDurationMs,
    0,
  );
  const goalDrivenTotalDuration = goalDrivenTraces.reduce(
    (acc, t) => acc + t.metrics.totalDurationMs,
    0,
  );
  const agentCTotalDuration = agentCTraces.reduce(
    (acc, t) => acc + t.metrics.totalDurationMs,
    0,
  );

  const hybridTotalLlmCalls = hybridTraces.reduce(
    (acc, t) => acc + t.metrics.totalLlmCalls,
    0,
  );
  const goalDrivenTotalLlmCalls = goalDrivenTraces.reduce(
    (acc, t) => acc + t.metrics.totalLlmCalls,
    0,
  );
  const agentCTotalLlmCalls = agentCTraces.reduce(
    (acc, t) => acc + t.metrics.totalLlmCalls,
    0,
  );

  const hybridTotalTokens = hybridTraces.reduce(
    (acc, t) => acc + t.metrics.totalTokens.totalTokens,
    0,
  );
  const goalDrivenTotalTokens = goalDrivenTraces.reduce(
    (acc, t) => acc + t.metrics.totalTokens.totalTokens,
    0,
  );
  const agentCTotalTokens = agentCTraces.reduce(
    (acc, t) => acc + t.metrics.totalTokens.totalTokens,
    0,
  );

  const report: BenchmarkComparisonReport = {
    timestamp: new Date().toISOString(),
    totalScenarios,
    hybridPassed,
    goalDrivenPassed,
    agentCPassed,
    hybridAvgDurationMs:
      totalScenarios > 0 ? Math.round(hybridTotalDuration / totalScenarios) : 0,
    goalDrivenAvgDurationMs:
      totalScenarios > 0
        ? Math.round(goalDrivenTotalDuration / totalScenarios)
        : 0,
    agentCAvgDurationMs:
      totalScenarios > 0 ? Math.round(agentCTotalDuration / totalScenarios) : 0,
    hybridTotalLlmCalls,
    goalDrivenTotalLlmCalls,
    agentCTotalLlmCalls,
    hybridTotalTokens,
    goalDrivenTotalTokens,
    agentCTotalTokens,
    comparisons,
  };

  return { report, hybridTraces, goalDrivenTraces, agentCTraces };
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
  const agentCPassPct = Math.round(
    (report.agentCPassed / report.totalScenarios) * 100,
  );

  let md = `# تقرير المقارنة المعيارية الثلاثية: Hybrid B مقابل Goal-Driven Hybrid مقابل Full Agent C\n\n`;
  md += `**تاريخ التقرير**: ${report.timestamp}\n`;
  md += `**إجمالي السيناريوهات**: ${report.totalScenarios}\n\n`;

  md += `## ملخص المؤشرات القياسية المقارنة\n\n`;
  md += `| المؤشر | Hybrid B (الأساس الحالي) | Goal-Driven Hybrid (المرشح التجريبي) | Full Agent C (معيار المرجع التجريبي) |\n`;
  md += `| :--- | :---: | :---: | :---: |\n`;
  md += `| نسبة النجاح | **${hybridPassPct}%** (${report.hybridPassed}/${report.totalScenarios}) | **${goalDrivenPassPct}%** (${report.goalDrivenPassed ?? 0}/${report.totalScenarios}) | **${agentCPassPct}%** (${report.agentCPassed}/${report.totalScenarios}) |\n`;
  md += `| متوسط زمن الاستجابة | **${report.hybridAvgDurationMs} ms** | **${report.goalDrivenAvgDurationMs ?? 0} ms** | **${report.agentCAvgDurationMs} ms** |\n`;
  md += `| إجمالي مكالمات LLM | **${report.hybridTotalLlmCalls}** | **${report.goalDrivenTotalLlmCalls ?? 0}** | **${report.agentCTotalLlmCalls}** |\n`;
  md += `| إجمالي التوكنز المقدرة | **${report.hybridTotalTokens}** | **${report.goalDrivenTotalTokens ?? 0}** | **${report.agentCTotalTokens}** |\n\n`;

  md += `## تفاصيل السيناريوهات\n\n`;
  md += `| المعرف | الفئة | اسم السيناريو | Hybrid B | Goal-Driven | Agent C | زمن G-D (ms) | مكالمات G-D |\n`;
  md += `| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: |\n`;

  for (const c of report.comparisons) {
    const hIcon = c.hybridVerdict === "PASS" ? "✔" : "❌";
    const gdIcon = c.goalDrivenVerdict === "PASS" ? "✔" : "❌";
    const cIcon = c.agentCVerdict === "PASS" ? "✔" : "❌";
    md += `| ${c.scenarioId} | ${c.category} | ${c.title} | ${hIcon} | ${gdIcon} | ${cIcon} | ${c.goalDrivenDurationMs ?? 0} | ${c.goalDrivenLlmCalls ?? 0} |\n`;
  }

  return md;
}
