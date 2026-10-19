/**
 * FlowPilot — Conversation Playground CLI
 * CONV-JEV-01: Real TypeSafe JEV Default Engine, Diagnostics & Benchmarking
 *
 * Usage:
 *   pnpm convo:playground [--scenario <id>] [--mode <baseline|goal_driven|typesafe_jev|agent_c>] [--live] [--inspect]
 *   pnpm convo:compare [--live]
 *   pnpm convo:replay <trace.json> [--inspect]
 *   pnpm check:convo-play (or --check)
 *
 * Filters:
 *   --failed-only, --clarifications-only, --handoffs-only, --context-loss-only
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type {
  ScenarioTrace,
  TurnTrace,
} from "../src/features/conversations/playground/types";

// Setup placeholder env vars before loading application modules
process.env.DATABASE_URL ??=
  "postgresql://user:password@localhost:5432/placeholder";
process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

if (!process.env.OPENROUTER_API_KEY && fs.existsSync(".env.local")) {
  const envContent = fs.readFileSync(".env.local", "utf-8");
  for (const line of envContent.split("\n")) {
    const match = line.match(/^\s*([^#=\s]+)\s*=\s*(.*)$/);
    if (match) {
      const key = match[1]!.trim();
      const val = match[2]!.trim().replace(/^['"]|['"]$/g, "");
      if (!process.env[key] || process.env[key]!.trim().length === 0) {
        process.env[key] = val;
      }
    }
  }
}

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

function printTurn(turn: TurnTrace, inspectMode = false): void {
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

  if (inspectMode) {
    console.log(`\n  --- STEP F DIAGNOSTICS INSPECTION ---`);
    console.log(`  1. Customer Message        : "${turn.inbound.text}"`);
    console.log(
      `  2. Goal/Context Before     : ${
        turn.processing.goalStateBefore
          ? JSON.stringify(turn.processing.goalStateBefore)
          : JSON.stringify(turn.stateBefore)
      }`,
    );
    console.log(
      `  3. TypeSafe JEV Decision   : ${
        turn.processing.typeSafeJevDecision
          ? `${turn.processing.typeSafeJevDecision.source} -> Intent: ${
              turn.processing.typeSafeJevDecision.intent
            } (Conf: ${(turn.processing.typeSafeJevDecision.confidence * 100).toFixed(0)}%) [${
              turn.processing.typeSafeJevDecision.reason
            }]`
          : "Not called / Bypassed"
      }`,
    );
    console.log(
      `  4. Baseline Decision       : ${
        turn.processing.baselineDecision
          ? `Intent: ${turn.processing.baselineDecision.intent} | Action: ${turn.processing.baselineDecision.action}`
          : "N/A"
      }`,
    );
    console.log(
      `  5. Decision Difference     : ${
        turn.processing.decisionDifference ?? "Full alignment between engines"
      }`,
    );
    console.log(
      `  6. Goal/Context After      : ${
        turn.processing.goalStateAfter
          ? JSON.stringify(turn.processing.goalStateAfter)
          : JSON.stringify(turn.stateAfter)
      }`,
    );
    console.log(
      `  7. Booking Core Action     : ${
        turn.processing.bookingCoreAction
          ? `${turn.processing.bookingCoreAction.action}${
              turn.processing.bookingCoreAction.appointmentId
                ? ` (ID: ${turn.processing.bookingCoreAction.appointmentId})`
                : ""
            }`
          : "None"
      }`,
    );
    console.log(`  8. Customer-Visible Reply  :`);
    const lines = turn.outbound.text.split("\n");
    for (const l of lines) {
      console.log(`       ${l}`);
    }
    console.log(
      `  9. Fallback / Handoff Cause: ${
        turn.processing.reasonForFallbackOrHandoff ?? "None (Standard Flow)"
      }`,
    );
    console.log(
      `  10. Latency & Cost         : ${
        turn.processing.latencyAndCost
          ? `${turn.processing.latencyAndCost.latencyMs}ms | $${turn.processing.latencyAndCost.costUsd.toFixed(6)} (${
              turn.processing.latencyAndCost.isEstimate ? "Estimate" : "Actual"
            })`
          : `${turn.processing.executionTimeMs}ms`
      }`,
    );
    console.log(`  -------------------------------------`);
  } else {
    if (turn.processing.semanticIntent) {
      console.log(`  Intent : ${turn.processing.semanticIntent}`);
    }
    if (turn.processing.toolCalls.length > 0) {
      console.log(
        `  Tools  : ${turn.processing.toolCalls.map((t) => `${t.tool}()`).join(", ")}`,
      );
    }
    console.log(
      `  Outbound (${turn.outbound.sentCount} msg, ${turn.processing.executionTimeMs}ms, ${turn.processing.llmCalls} LLM, ${turn.processing.jevCalls ?? 0} JEV):`,
    );
    const lines = turn.outbound.text.split("\n");
    for (const l of lines) {
      console.log(`    ${l}`);
    }
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
  const { runTypeSafeJevScenario } =
    await import("../src/features/conversations/playground/jev-runner");
  const { runAgentCScenario } =
    await import("../src/features/conversations/playground/agent-c-runner");
  const { evaluateBenchmark, formatComparisonMarkdown } =
    await import("../src/features/conversations/playground/evaluator");

  const args = process.argv.slice(2);

  const isCheck = args.includes("--check");
  const isCompare = args.includes("--compare");
  const isLive = args.includes("--live");
  const isInspect = args.includes("--inspect");
  const filterFailed = args.includes("--failed-only");
  const filterClarifications = args.includes("--clarifications-only");
  const filterHandoffs = args.includes("--handoffs-only");
  const filterContextLoss = args.includes("--context-loss-only");

  const replayIdx = args.indexOf("--replay");
  const scenarioIdx = args.indexOf("--scenario");
  const modeIdx = args.indexOf("--mode");
  const outIdx = args.indexOf("--out");

  const tracesDir =
    outIdx !== -1 && args[outIdx + 1] ? args[outIdx + 1]! : DEFAULT_TRACES_DIR;
  const mode =
    modeIdx !== -1 && args[modeIdx + 1]
      ? args[modeIdx + 1]!.toLowerCase()
      : isLive
        ? "typesafe_jev"
        : "hybrid";

  console.log("========================================================");
  console.log("  FLOWPILOT CONVERSATION PLAYGROUND (CONV-JEV-01)");
  console.log("  Real TypeSafe JEV Default Engine & Benchmark Suite");
  console.log("========================================================");
  if (isLive) {
    console.log(
      "  MODE: LIVE TypeSafe JEV (typesafe/jev-1.13 via OpenRouter Decisions API)",
    );
  }

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
      printTurn(turn, isInspect);
    }
    console.log(
      `\nVerdict: ${traceData.verdict} (${traceData.metrics.totalTurns} turns, ${traceData.metrics.totalDurationMs}ms, ${traceData.metrics.totalLlmCalls} LLM calls)`,
    );
    return;
  }

  // 2. COMPARE BENCHMARK MODE
  if (isCompare) {
    console.log(
      `Running Comparative Benchmark across 3 Engines${
        isLive ? " [LIVE JEV NETWORK]" : " [OFFLINE SIMULATION]"
      }...`,
    );
    console.log(`Corpus: ${GOLDEN_SCENARIOS.length} Golden Scenarios\n`);

    const {
      report,
      hybridTraces,
      goalDrivenTraces,
      typeSafeJevTraces,
      agentCTraces,
    } = await evaluateBenchmark({ live: isLive });

    for (const t of hybridTraces) saveTrace(t, tracesDir);
    for (const t of goalDrivenTraces) saveTrace(t, tracesDir);
    for (const t of typeSafeJevTraces) saveTrace(t, tracesDir);
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

  // 3. CHECK MODE (Automated CI Verification of Golden Scenarios)
  if (isCheck) {
    console.log(
      `Verifying all ${GOLDEN_SCENARIOS.length} Golden Scenarios on Deterministic Baseline...\n`,
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
      `✔ All ${GOLDEN_SCENARIOS.length} Golden Scenarios passed on Deterministic Baseline architecture.`,
    );
    return;
  }

  // 4. SINGLE SCENARIO OR FILTERED RUN
  let targetScenarios = GOLDEN_SCENARIOS;
  const scenarioId =
    scenarioIdx !== -1 && args[scenarioIdx + 1] ? args[scenarioIdx + 1]! : null;

  if (scenarioId) {
    const single = GOLDEN_SCENARIOS.find((s) => s.id === scenarioId);
    if (!single) {
      console.error(
        `Error: Scenario '${scenarioId}' not found. Available IDs:`,
      );
      console.log(GOLDEN_SCENARIOS.map((s) => s.id).join(", "));
      process.exit(1);
    }
    targetScenarios = [single];
  }

  for (const scenario of targetScenarios) {
    let trace: ScenarioTrace;
    if (mode === "agent_c") {
      trace = await runAgentCScenario(scenario);
    } else if (mode === "typesafe_jev" || mode === "jev") {
      trace = await runTypeSafeJevScenario(scenario, { live: isLive });
    } else if (mode === "goal_driven" || mode === "goal-driven") {
      trace = await runGoalDrivenScenario(scenario);
    } else {
      trace = await runHybridScenario(scenario);
    }

    // Apply diagnostics filters if requested
    if (filterFailed && trace.verdict === "PASS") continue;
    if (filterClarifications && !trace.metrics.clarificationLoopDetected)
      continue;
    if (filterHandoffs && !trace.metrics.unnecessaryHandoffDetected) continue;
    if (
      filterContextLoss &&
      !trace.turns.some((t) =>
        t.diagnostics.warnings.includes("CONTEXT_LOSS_DETECTED"),
      )
    ) {
      continue;
    }

    console.log(`\nRunning Scenario: [${scenario.id}] ${scenario.title}`);
    console.log(`Category: ${scenario.category} | Mode: ${trace.architecture}`);
    console.log(`Description: ${scenario.description}`);

    for (const turn of trace.turns) {
      printTurn(turn, isInspect);
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
}

main().catch((err) => {
  console.error("Unhandled fatal error in playground:", err);
  process.exit(1);
});
