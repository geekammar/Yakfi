/**
 * FlowPilot Conversation Playground — Automated Comparative Evaluator
 * Evaluates Hybrid B vs Full Agent C across the Golden Scenario corpus.
 */

import { runAgentCScenario } from "./agent-c-runner";
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
};

export async function evaluateBenchmark(
  options: EvaluateOptions = {},
): Promise<{
  report: BenchmarkComparisonReport;
  hybridTraces: ScenarioTrace[];
  agentCTraces: ScenarioTrace[];
}> {
  const scenarios = options.scenarios ?? GOLDEN_SCENARIOS;
  const hybridTraces: ScenarioTrace[] = [];
  const agentCTraces: ScenarioTrace[] = [];
  const comparisons: ScenarioComparison[] = [];

  for (const scenario of scenarios) {
    // 1. Run Hybrid B
    const hybridTrace = await runHybridScenario(scenario);
    hybridTraces.push(hybridTrace);

    // 2. Run Agent C
    const agentCTrace = await runAgentCScenario(scenario);
    agentCTraces.push(agentCTrace);

    comparisons.push({
      scenarioId: scenario.id,
      title: scenario.title,
      category: scenario.category,
      hybridVerdict: hybridTrace.verdict,
      agentCVerdict: agentCTrace.verdict,
      hybridDurationMs: hybridTrace.metrics.totalDurationMs,
      agentCDurationMs: agentCTrace.metrics.totalDurationMs,
      hybridLlmCalls: hybridTrace.metrics.totalLlmCalls,
      agentCLlmCalls: agentCTrace.metrics.totalLlmCalls,
      notes:
        hybridTrace.verdict === "FAIL"
          ? `Hybrid B failed: ${hybridTrace.failureReason}`
          : agentCTrace.verdict === "FAIL"
            ? `Agent C failed: ${agentCTrace.failureReason}`
            : undefined,
    });
  }

  const totalScenarios = scenarios.length;
  const hybridPassed = hybridTraces.filter((t) => t.verdict === "PASS").length;
  const agentCPassed = agentCTraces.filter((t) => t.verdict === "PASS").length;

  const hybridTotalDuration = hybridTraces.reduce(
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
  const agentCTotalLlmCalls = agentCTraces.reduce(
    (acc, t) => acc + t.metrics.totalLlmCalls,
    0,
  );

  const hybridTotalTokens = hybridTraces.reduce(
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
    agentCPassed,
    hybridAvgDurationMs:
      totalScenarios > 0 ? Math.round(hybridTotalDuration / totalScenarios) : 0,
    agentCAvgDurationMs:
      totalScenarios > 0 ? Math.round(agentCTotalDuration / totalScenarios) : 0,
    hybridTotalLlmCalls,
    agentCTotalLlmCalls,
    hybridTotalTokens,
    agentCTotalTokens,
    comparisons,
  };

  return { report, hybridTraces, agentCTraces };
}

export function formatComparisonMarkdown(
  report: BenchmarkComparisonReport,
): string {
  const hybridPassPct = Math.round(
    (report.hybridPassed / report.totalScenarios) * 100,
  );
  const agentCPassPct = Math.round(
    (report.agentCPassed / report.totalScenarios) * 100,
  );

  let md = `# تقرير المقارنة المعيارية: Hybrid B مقابل Full Agent C\n\n`;
  md += `**تاريخ التقرير**: ${report.timestamp}\n`;
  md += `**إجمالي السيناريوهات**: ${report.totalScenarios}\n\n`;

  md += `## ملخص المؤشرات القياسية\n\n`;
  md += `| المؤشر | Hybrid B (الإنتاج المستهدف) | Full Agent C (المعيار التجريبي MOCK_ONLY) | الفارق |\n`;
  md += `| :--- | :--- | :--- | :--- |\n`;
  md += `| نسبة النجاح | **${hybridPassPct}%** (${report.hybridPassed}/${report.totalScenarios}) | **${agentCPassPct}%** (${report.agentCPassed}/${report.totalScenarios}) | ${hybridPassPct - agentCPassPct >= 0 ? "+" : ""}${hybridPassPct - agentCPassPct}% |\n`;
  md += `| متوسط زمن الاستجابة | **${report.hybridAvgDurationMs} ms** | **${report.agentCAvgDurationMs} ms** | ${report.agentCAvgDurationMs - report.hybridAvgDurationMs} ms |\n`;
  md += `| إجمالي مكالمات LLM | **${report.hybridTotalLlmCalls}** | **${report.agentCTotalLlmCalls}** | +${report.agentCTotalLlmCalls - report.hybridTotalLlmCalls} مكالمة |\n`;
  md += `| إجمالي التوكنز المقدرة | **${report.hybridTotalTokens}** | **${report.agentCTotalTokens}** | +${report.agentCTotalTokens - report.hybridTotalTokens} tokens |\n\n`;

  md += `## تفاصيل السيناريوهات الـ 38\n\n`;
  md += `| المعرف | الفئة | اسم السيناريو | Hybrid B | Agent C | زمن H (ms) | زمن C (ms) | مكالمات H | مكالمات C |\n`;
  md += `| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |\n`;

  for (const c of report.comparisons) {
    const hIcon = c.hybridVerdict === "PASS" ? "✔" : "❌";
    const cIcon = c.agentCVerdict === "PASS" ? "✔" : "❌";
    md += `| ${c.scenarioId} | ${c.category} | ${c.title} | ${hIcon} | ${cIcon} | ${c.hybridDurationMs} | ${c.agentCDurationMs} | ${c.hybridLlmCalls} | ${c.agentCLlmCalls} |\n`;
  }

  return md;
}
