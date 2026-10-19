/**
 * FlowPilot — Conversation Playground CLI
 * Non-negotiable DECISION 0.1, 0.2, 0.3 (CONV-PLAY-01 Checkpoint 12)
 *
 * Usage:
 *   pnpm convo:playground [--scenario <id>] [--mode <hybrid|agent_c>]
 *   pnpm convo:compare
 *   pnpm convo:replay <trace.json>
 *   pnpm check:convo-play (or --check)
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { ScenarioTrace } from "../src/features/conversations/playground/types";

// Setup placeholder env vars before loading application modules
process.env.DATABASE_URL ??=
  "postgresql://user:password@localhost:5432/placeholder";
process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

const DEFAULT_TRACES_DIR = path.resolve(
  process.cwd(),
  ".flowpilot/playground/traces",
);

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function saveTrace(trace: ScenarioTrace, outDir: string): string {
  ensureDir(outDir);
  const fileName = `${trace.scenarioId}_${trace.architecture.toLowerCase()}.json`;
  const filePath = path.join(outDir, fileName);
  fs.writeFileSync(filePath, JSON.stringify(trace, null, 2), "utf-8");
  return filePath;
}

function printTurn(turn: ScenarioTrace["turns"][0]): void {
  console.log(
    `\n  --- [Turn ${turn.turnIndex}] --------------------------------`,
  );
  console.log(
    `  Channel: ${turn.inbound.channel} | Sender: ${turn.inbound.senderId}`,
  );
  console.log(`  Input  : "${turn.inbound.text}"`);
  console.log(
    `  Action : ${turn.assistantAction} | Status: ${turn.conversationStatus}`,
  );
  if (turn.processing.semanticIntent) {
    console.log(`  Intent : ${turn.processing.semanticIntent}`);
  }
  if (turn.processing.toolCalls.length > 0) {
    console.log(
      `  Tools  : ${turn.processing.toolCalls.map((t) => `${t.tool}()`).join(", ")}`,
    );
  }
  console.log(
    `  Outbound (${turn.outbound.sentCount} msg, ${turn.processing.executionTimeMs}ms, ${turn.processing.llmCalls} LLM):`,
  );
  const lines = turn.outbound.text.split("\n");
  for (const l of lines) {
    console.log(`    ${l}`);
  }
  if (turn.diagnostics.appointmentCreated) {
    console.log(
      `  ✔ Appointment Created (ID: ${turn.diagnostics.appointmentId})`,
    );
  }
  if (turn.diagnostics.warnings.length > 0) {
    console.log(`  ⚠ Warnings: ${turn.diagnostics.warnings.join(", ")}`);
  }
}

async function main(): Promise<void> {
  const { GOLDEN_SCENARIOS } =
    await import("../src/features/conversations/playground/golden-scenarios");
  const { runHybridScenario } =
    await import("../src/features/conversations/playground/hybrid-runner");
  const { runGoalDrivenScenario } =
    await import("../src/features/conversations/playground/goal-driven-runner");
  const { runAgentCScenario } =
    await import("../src/features/conversations/playground/agent-c-runner");
  const { evaluateBenchmark, formatComparisonMarkdown } =
    await import("../src/features/conversations/playground/evaluator");

  const args = process.argv.slice(2);

  const isCheck = args.includes("--check");
  const isCompare = args.includes("--compare");
  const replayIdx = args.indexOf("--replay");
  const scenarioIdx = args.indexOf("--scenario");
  const modeIdx = args.indexOf("--mode");
  const outIdx = args.indexOf("--out");

  const tracesDir =
    outIdx !== -1 && args[outIdx + 1] ? args[outIdx + 1]! : DEFAULT_TRACES_DIR;
  const mode =
    modeIdx !== -1 && args[modeIdx + 1] ? args[modeIdx + 1]! : "hybrid";

  console.log("========================================================");
  console.log("  FLOWPILOT CONVERSATION PLAYGROUND (CONV-PLAY-02A)");
  console.log("  Goal-Driven Hybrid & Comparative Benchmark Engine");
  console.log("========================================================");

  // 1. REPLAY MODE
  if (replayIdx !== -1) {
    const replayFile = args[replayIdx + 1];
    if (!replayFile || !fs.existsSync(replayFile)) {
      console.error(`Error: Replay file not found: ${replayFile}`);
      process.exit(1);
    }
    console.log(`Replaying trace: ${replayFile}`);
    const traceData: ScenarioTrace = JSON.parse(
      fs.readFileSync(replayFile, "utf-8"),
    );
    console.log(`Scenario: [${traceData.scenarioId}] ${traceData.title}`);
    console.log(`Architecture: ${traceData.architecture}`);
    for (const turn of traceData.turns) {
      printTurn(turn);
    }
    console.log(
      `\nVerdict: ${traceData.verdict} (${traceData.metrics.totalTurns} turns, ${traceData.metrics.totalDurationMs}ms, ${traceData.metrics.totalLlmCalls} LLM calls)`,
    );
    return;
  }

  // 2. COMPARE BENCHMARK MODE
  if (isCompare) {
    console.log(
      "Running Comparative Benchmark: Hybrid B vs Goal-Driven vs Agent C...",
    );
    console.log(`Corpus: ${GOLDEN_SCENARIOS.length} Golden Scenarios\n`);

    const { report, hybridTraces, goalDrivenTraces, agentCTraces } =
      await evaluateBenchmark();

    for (const t of hybridTraces) saveTrace(t, tracesDir);
    for (const t of goalDrivenTraces) saveTrace(t, tracesDir);
    for (const t of agentCTraces) saveTrace(t, tracesDir);

    const mdReport = formatComparisonMarkdown(report);
    const mdPath = path.join(tracesDir, "benchmark_comparison.md");
    ensureDir(tracesDir);
    fs.writeFileSync(mdPath, mdReport, "utf-8");

    console.log(mdReport);
    console.log(
      `\n✔ Full traces and benchmark report written to: ${tracesDir}`,
    );
    return;
  }

  // 3. CHECK MODE (Automated CI Verification of all 38 Golden Scenarios)
  if (isCheck) {
    console.log(
      `Verifying all ${GOLDEN_SCENARIOS.length} Golden Scenarios on Hybrid B...\n`,
    );

    let passCount = 0;
    let failCount = 0;
    const failures: { id: string; title: string; reason: string }[] = [];

    for (const scenario of GOLDEN_SCENARIOS) {
      const trace = await runHybridScenario(scenario);
      saveTrace(trace, tracesDir);

      if (trace.verdict === "PASS") {
        passCount++;
        console.log(`✔ [${scenario.id}] ${scenario.title}`);
      } else {
        failCount++;
        failures.push({
          id: scenario.id,
          title: scenario.title,
          reason: trace.failureReason ?? "Unknown failure",
        });
        console.log(`❌ [${scenario.id}] ${scenario.title}`);
        console.log(`   ↳ Reason: ${trace.failureReason}`);
      }
    }

    console.log("\n========================================================");
    console.log(
      `RESULTS: Total: ${GOLDEN_SCENARIOS.length} | Passed: ${passCount} | Failed: ${failCount}`,
    );
    console.log("========================================================");

    if (failCount > 0) {
      console.error("\nFailures summary:");
      for (const f of failures) {
        console.error(`- [${f.id}] ${f.title}: ${f.reason}`);
      }
      process.exit(1);
    }

    console.log(
      "✔ All 38 Golden Scenarios passed on Hybrid B production architecture.",
    );
    return;
  }

  // 4. SINGLE SCENARIO OR INTERACTIVE
  const scenarioId =
    scenarioIdx !== -1 && args[scenarioIdx + 1]
      ? args[scenarioIdx + 1]!
      : "GS-01";
  const scenario = GOLDEN_SCENARIOS.find((s) => s.id === scenarioId);

  if (!scenario) {
    console.error(`Error: Scenario '${scenarioId}' not found. Available IDs:`);
    console.log(GOLDEN_SCENARIOS.map((s) => s.id).join(", "));
    process.exit(1);
  }

  console.log(`\nRunning Scenario: [${scenario.id}] ${scenario.title}`);
  console.log(`Category: ${scenario.category} | Mode: ${mode.toUpperCase()}`);
  console.log(`Description: ${scenario.description}`);

  let trace: ScenarioTrace;
  if (mode.toLowerCase() === "agent_c") {
    trace = await runAgentCScenario(scenario);
  } else if (
    mode.toLowerCase() === "goal_driven" ||
    mode.toLowerCase() === "goal-driven"
  ) {
    trace = await runGoalDrivenScenario(scenario);
  } else {
    trace = await runHybridScenario(scenario);
  }

  for (const turn of trace.turns) {
    printTurn(turn);
  }

  console.log("\n========================================================");
  console.log(`Verdict : ${trace.verdict}`);
  if (trace.failureReason) {
    console.log(`Failure : ${trace.failureReason}`);
  }
  console.log(
    `Metrics : ${trace.metrics.totalTurns} turns | ${trace.metrics.totalDurationMs}ms execution | ${trace.metrics.totalLlmCalls} LLM calls | ${trace.metrics.totalTokens.totalTokens} tokens`,
  );
  console.log("========================================================");

  const savedPath = saveTrace(trace, tracesDir);
  console.log(`Trace saved to: ${savedPath}`);
}

main().catch((err) => {
  console.error("Unhandled fatal error in playground:", err);
  process.exit(1);
});
