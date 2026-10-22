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

import type { EgyptianScenarioDefinition } from "../src/features/conversations/playground/egyptian-scenarios";
import { redactTrace } from "../src/features/conversations/playground/trace-sanitizer";
import type {
  ScenarioDefinition,
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
  const sanitizedTrace = redactTrace(trace);
  const fileName = `${sanitizedTrace.scenarioId}_${sanitizedTrace.architecture.toLowerCase()}.json`;
  const filePath = path.join(outDir, fileName);
  fs.writeFileSync(filePath, JSON.stringify(sanitizedTrace, null, 2), "utf-8");
  return filePath;
}

function parseStrictInteger(val: string | undefined): number | undefined {
  if (val === undefined) return undefined;
  if (!/^\d+$/.test(val.trim())) return NaN;
  const parsed = Number(val);
  return Number.isInteger(parsed) ? parsed : NaN;
}

function parseStrictFloat(val: string | undefined): number | undefined {
  if (val === undefined) return undefined;
  if (!/^\d+(\.\d+)?$/.test(val.trim())) return NaN;
  const parsed = Number(val);
  return Number.isFinite(parsed) ? parsed : NaN;
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
    if (turn.processing.currentEngine) {
      const ce = turn.processing.currentEngine;
      console.log(
        `\n  --- CURRENT ENGINE EXECUTION INSPECTION (CORE-03C1) ---`,
      );
      console.log(`  1. Customer Message        : "${turn.inbound.text}"`);
      console.log(
        `  2. Canonical Time / TZ     : ${turn.referenceTime ?? "N/A"} (${turn.timezone ?? "Africa/Cairo"})`,
      );
      console.log(
        `  3. Routing & Capability    : ${ce.routing.route} [${ce.routing.effectiveCapability}]`,
      );
      console.log(
        `  4. Provider / Model        : ${ce.routing.finalProvider} / ${ce.routing.finalModel}`,
      );
      console.log(`  5. Physical HTTP Attempts  : ${ce.httpAttempts.count}`);
      console.log(
        `  6. Measured Token Usage    : ${ce.tokenUsage.source} -> in=${ce.tokenUsage.promptTokens ?? "unknown"} out=${ce.tokenUsage.completionTokens ?? "unknown"} total=${ce.tokenUsage.totalTokens ?? "unknown"}`,
      );
      console.log(
        `  7. Durable State Before    : ${JSON.stringify(turn.stateBefore?.knownFacts ?? turn.stateBefore)}`,
      );
      console.log(
        `  8. Durable State After     : ${JSON.stringify(turn.stateAfter?.knownFacts ?? turn.stateAfter)}`,
      );
      console.log(
        `  9. Task & Missing Facts    : task=${ce.task.activeTask ?? "none"} | missing=[${ce.task.missingFacts.join(", ")}]`,
      );
      console.log(
        `  10. Offer Transition       : ${ce.offerTransition.transition}`,
      );
      console.log(
        `  11. Availability Queries   : ${JSON.stringify(ce.availabilityQueries)}`,
      );
      console.log(`  12. Customer-Visible Reply :`);
      const lines = turn.outbound.text.split("\n");
      for (const l of lines) {
        console.log(`       ${l}`);
      }
      console.log(
        `  13. Domain Result          : Action=${ce.domainResult.action} | Status=${ce.domainResult.conversationStatus}${ce.domainResult.clarificationCause ? ` | Clarify=${ce.domainResult.clarificationCause}` : ""}${ce.domainResult.handoffCause ? ` | Handoff=${ce.domainResult.handoffCause}` : ""}`,
      );
      console.log(`  -------------------------------------`);
      return;
    }
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
  const { EGYPTIAN_ARABIC_SCENARIOS, CORE_03C2_SMOKE_SCENARIOS } =
    await import("../src/features/conversations/playground/egyptian-scenarios");
  const { runCurrentEngineScenario } =
    await import("../src/features/conversations/playground/current-engine-runner");
  const { runHybridScenario } =
    await import("../src/features/conversations/playground/hybrid-runner");
  const {
    CurrentEngineExecutionSession,
    auditPreflightLimits,
    VERIFIED_OPENROUTER_DEEPSEEK_V3_COST_CONFIG,
  } =
    await import("../src/features/conversations/playground/current-engine-session");
  const { runGoalDrivenScenario } =
    await import("../src/features/conversations/playground/goal-driven-runner");
  const { runTypeSafeJevScenario } =
    await import("../src/features/conversations/playground/jev-runner");
  const { createJevDecisionsProvider, JEV_PINNED_MODEL } =
    await import("../src/server/integrations/ai/jev-decisions-provider");
  const { runAgentCScenario } =
    await import("../src/features/conversations/playground/agent-c-runner");
  const { evaluateBenchmark, formatComparisonMarkdown } =
    await import("../src/features/conversations/playground/evaluator");

  const args = process.argv.slice(2);

  const isCheck = args.includes("--check");
  const isCompare = args.includes("--compare");
  const isLive = args.includes("--live");
  const isInspect = args.includes("--inspect");
  const isPreflight =
    args.includes("--preflight") || args.includes("--dry-run");
  const allowPaid = args.includes("--allow-paid");
  const filterFailed = args.includes("--failed-only");
  const filterClarifications = args.includes("--clarifications-only");
  const filterHandoffs = args.includes("--handoffs-only");
  const filterContextLoss = args.includes("--context-loss-only");

  if (isCheck && (isLive || isCompare || isPreflight)) {
    console.error(
      "\n❌ [CONFLICTING FLAGS] --check cannot be combined with --live, --compare, or --preflight.\n",
    );
    process.exit(1);
  }

  const replayIdx = args.indexOf("--replay");
  const scenarioIdx = args.indexOf("--scenario");
  const modeIdx = args.indexOf("--mode");
  const trackIdx = args.indexOf("--track");
  const outIdx = args.indexOf("--out");
  const maxReqIdx = args.indexOf("--max-requests");
  const maxTokensIdx = args.indexOf("--max-tokens");
  const timeoutIdx = args.indexOf("--timeout");
  const budgetIdx = args.indexOf("--budget");
  const budgetBasisIdx = args.indexOf("--budget-basis");
  const scenariosIdx = args.indexOf("--scenarios");

  const track =
    trackIdx !== -1 && args[trackIdx + 1]
      ? args[trackIdx + 1]!.toLowerCase()
      : "both";

  const maxRequests =
    maxReqIdx !== -1 ? parseStrictInteger(args[maxReqIdx + 1]) : undefined;
  const maxTokens =
    maxTokensIdx !== -1
      ? parseStrictInteger(args[maxTokensIdx + 1])
      : undefined;
  const timeoutMs =
    timeoutIdx !== -1 ? parseStrictInteger(args[timeoutIdx + 1]) : undefined;
  const approvedBudgetUsd =
    budgetIdx !== -1 ? parseStrictFloat(args[budgetIdx + 1]) : undefined;
  const budgetBasis =
    budgetBasisIdx !== -1 && args[budgetBasisIdx + 1]
      ? args[budgetBasisIdx + 1]!
      : undefined;
  const scenariosArg =
    scenariosIdx !== -1 && args[scenariosIdx + 1]
      ? args[scenariosIdx + 1]!.toLowerCase()
      : undefined;

  if (maxReqIdx !== -1) {
    if (
      !args[maxReqIdx + 1] ||
      Number.isNaN(maxRequests) ||
      (maxRequests ?? 0) <= 0
    ) {
      console.error(
        "\n❌ [INVALID ARGUMENT] --max-requests must be a strict positive integer.\n",
      );
      process.exit(1);
    }
  }
  if (maxTokensIdx !== -1) {
    if (
      !args[maxTokensIdx + 1] ||
      Number.isNaN(maxTokens) ||
      (maxTokens ?? 0) <= 0
    ) {
      console.error(
        "\n❌ [INVALID ARGUMENT] --max-tokens must be a strict positive integer.\n",
      );
      process.exit(1);
    }
  }
  if (timeoutIdx !== -1) {
    if (
      !args[timeoutIdx + 1] ||
      Number.isNaN(timeoutMs) ||
      (timeoutMs ?? 0) <= 0
    ) {
      console.error(
        "\n❌ [INVALID ARGUMENT] --timeout must be a strict positive integer in milliseconds.\n",
      );
      process.exit(1);
    }
  }
  if (budgetIdx !== -1) {
    if (
      !args[budgetIdx + 1] ||
      Number.isNaN(approvedBudgetUsd) ||
      (approvedBudgetUsd ?? 0) <= 0
    ) {
      console.error(
        "\n❌ [INVALID ARGUMENT] --budget must be a positive number in USD.\n",
      );
      process.exit(1);
    }
  }

  const tracesDir =
    outIdx !== -1 && args[outIdx + 1] ? args[outIdx + 1]! : DEFAULT_TRACES_DIR;
  const rawMode =
    modeIdx !== -1 && args[modeIdx + 1]
      ? args[modeIdx + 1]!.toLowerCase()
      : null;
  const mode =
    rawMode === "current_engine" || rawMode === "current-engine"
      ? "current_engine"
      : rawMode
        ? rawMode
        : isLive
          ? "typesafe_jev"
          : "hybrid";

  console.log("========================================================");
  if (mode === "current_engine") {
    console.log("  FLOWPILOT CONVERSATION PLAYGROUND (CORE-03C1)");
    console.log("  Current Engine Mode (Merged Conversation Engine Path)");
  } else {
    console.log("  FLOWPILOT CONVERSATION PLAYGROUND (CONV-JEV-01)");
    console.log("  Real TypeSafe JEV Default Engine & Benchmark Suite");
  }
  console.log("========================================================");
  if (isLive) {
    if (mode === "current_engine") {
      console.log(
        "  MODE: LIVE Current Engine (OpenRouter generative adapter via policy)",
      );
    } else {
      console.log(
        "  MODE: LIVE TypeSafe JEV (typesafe/jev-1.13 via OpenRouter Decisions API)",
      );
    }
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
    const sanitizedTrace = redactTrace(traceData);
    console.log(
      `Scenario: [${sanitizedTrace.scenarioId}] ${sanitizedTrace.title}`,
    );
    console.log(`Architecture: ${sanitizedTrace.architecture}`);
    for (const turn of sanitizedTrace.turns) {
      printTurn(turn, isInspect);
    }
    console.log(
      `\nVerdict: ${sanitizedTrace.verdict} (${sanitizedTrace.metrics.totalTurns} turns, ${sanitizedTrace.metrics.totalDurationMs}ms, ${sanitizedTrace.metrics.totalLlmCalls} LLM calls)`,
    );
    if (sanitizedTrace.verdict === "FAIL") {
      process.exit(1);
    }
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

  // 4. PREFLIGHT / DRY-RUN MODE
  const allScenarios: (ScenarioDefinition | EgyptianScenarioDefinition)[] =
    mode === "current_engine"
      ? scenariosArg === "golden"
        ? GOLDEN_SCENARIOS
        : scenariosArg === "smoke"
          ? CORE_03C2_SMOKE_SCENARIOS
          : EGYPTIAN_ARABIC_SCENARIOS
      : GOLDEN_SCENARIOS;

  let targetScenarios = allScenarios;
  const scenarioId =
    scenarioIdx !== -1 && args[scenarioIdx + 1] ? args[scenarioIdx + 1]! : null;

  if (scenarioId) {
    const combined = [
      ...CORE_03C2_SMOKE_SCENARIOS,
      ...EGYPTIAN_ARABIC_SCENARIOS,
      ...GOLDEN_SCENARIOS,
    ];
    const single = combined.find((s) => s.id === scenarioId);
    if (!single) {
      console.error(
        `Error: Scenario '${scenarioId}' not found. Available IDs:`,
      );
      console.log(combined.map((s) => s.id).join(", "));
      process.exit(1);
    }
    targetScenarios = [single];
  }

  // Test seam: allow acceptance/regression tests to evaluate expectation mismatch
  // on a valid scenario without network calls or arbitrary code execution
  if (
    process.env.FLOWPILOT_TEST_EVAL_FAILURE_INTENT &&
    targetScenarios.length > 0
  ) {
    targetScenarios = targetScenarios.map((s) => ({
      ...s,
      turns: s.turns.map((t, idx) =>
        idx === 0
          ? {
              ...t,
              expectedIntent: process.env.FLOWPILOT_TEST_EVAL_FAILURE_INTENT!,
            }
          : t,
      ),
    }));
  }

  if (isPreflight) {
    const opLimits = {
      scenarioSubset: targetScenarios.map((s) => s.id),
      maxPhysicalHttpAttempts: maxRequests ?? 25,
      outputTokenLimit: maxTokens ?? 500,
      timeoutMs: timeoutMs ?? 15000,
      approvedBudgetUsd: approvedBudgetUsd ?? 0.05,
      budgetBasis:
        budgetBasis ??
        "12 Egyptian scenarios * ~1.5 turns/scenario * ~1.2k tokens/turn = ~22k tokens on DeepSeek V3 @ $0.14/M in, $0.28/M out -> $0.005 base, capped with 10x safety margin at $0.05",
    };

    const audit = auditPreflightLimits(
      opLimits,
      targetScenarios.map((s) => s.id),
      VERIFIED_OPENROUTER_DEEPSEEK_V3_COST_CONFIG,
      allowPaid,
    );

    console.log("\n  --- DRY-RUN / PREFLIGHT AUDIT REPORT ---");
    console.log(`  Preflight Status        : ${audit.status}`);
    if (audit.status === "BLOCKED") {
      console.log(`  Blocking Reasons        :`);
      for (const r of audit.reasons) {
        console.log(`    - ${r}`);
      }
    }
    console.log(`  Evaluation Mode         : ${mode}`);
    console.log(
      `  Target Architecture     : Merged Production Conversation Engine`,
    );
    console.log(
      `  Capability Requirement  : structured_turn (production default)`,
    );
    console.log(
      `  Provider / Model        : ${audit.resolvedConfig.provider} / ${audit.resolvedConfig.model}`,
    );
    console.log(
      `  Pricing Reference       : ${audit.resolvedConfig.pricingSource}`,
    );
    console.log(
      `  Target Scenarios        : ${targetScenarios.length} scenarios [${targetScenarios.map((s) => s.id).join(", ")}]`,
    );
    console.log(
      `  Max Physical HTTP Calls : ${audit.resolvedConfig.maxPhysicalHttpAttempts}`,
    );
    console.log(
      `  Output Token Limit      : ${audit.resolvedConfig.outputTokenLimit}`,
    );
    console.log(
      `  Per-Attempt Timeout     : ${audit.resolvedConfig.timeoutMs}ms`,
    );
    console.log(
      `  Input Token Bound       : ${audit.resolvedConfig.conservativeInputBoundTokens} tokens/call`,
    );
    console.log(
      `  Conservative Cost Bound : $${audit.resolvedConfig.conservativeCostCeilingUsd.toFixed(4)} USD`,
    );
    console.log(
      `  Approved Budget Cap     : $${audit.resolvedConfig.approvedBudgetUsd.toFixed(4)} USD`,
    );
    console.log(
      `  Cost Estimation Basis   : ${audit.resolvedConfig.costBasis}`,
    );
    console.log(`\n  --- MONETARY ENFORCEMENT METHOD & LIMITATIONS ---`);
    console.log(
      `  1. Physical Attempt Boundary: Adapter-level fetchImpl enforces an explicit ceiling on physical HTTP attempts.`,
    );
    console.log(
      `  2. Output Token Setting     : Bounded via OpenAI-compatible max_tokens parameter to prevent runaways.`,
    );
    console.log(
      `  3. Dollar Cap Limitations   : ${audit.resolvedConfig.providerSideHardLimitSupport}`,
    );
    console.log(
      `  4. JEV Spending Flag        : FLOWPILOT_JEV_APPROVED_MONTHLY_BUDGET applies strictly to JEV Decisions API and is NOT proof of generative LLM spending caps.`,
    );
    console.log(
      `  5. Execution Safety Status  : PAID LIVE EVALUATION NOT RUN. Zero remote calls made.`,
    );
    console.log(`  -----------------------------------------\n`);
    return;
  }

  // Live preflight validation before network activity
  if (isLive && mode === "current_engine") {
    const missing: string[] = [];
    if (!allowPaid)
      missing.push(
        "--allow-paid (explicit operator opt-in required for live paid provider calls)",
      );
    if (maxRequests == null) missing.push("--max-requests <positive-int>");
    if (maxTokens == null) missing.push("--max-tokens <positive-int>");
    if (timeoutMs == null) missing.push("--timeout <positive-int-ms>");
    if (approvedBudgetUsd == null)
      missing.push("--budget <positive-float-usd>");
    if (!budgetBasis) missing.push("--budget-basis <explanation-string>");

    if (missing.length > 0) {
      console.error(
        "\n❌ [LIVE PREFLIGHT BLOCKED] Missing required operator limits before network activity:\n",
      );
      for (const m of missing) {
        console.error(`  - ${m}`);
      }
      console.error("\nExample:");
      console.error(
        '  pnpm convo:playground --mode current_engine --live --allow-paid --max-requests 24 --max-tokens 600 --timeout 15000 --budget 0.10 --budget-basis "24 attempts <= $0.10" --scenarios smoke\n',
      );
      process.exit(1);
    }
  }

  // 5. SINGLE SCENARIO OR FILTERED RUN
  let hasAnyFailure = false;
  const sharedEngineSession =
    mode === "current_engine"
      ? new CurrentEngineExecutionSession({
          live: isLive,
          operatorLimits: isLive
            ? {
                scenarioSubset: targetScenarios.map((s) => s.id),
                maxPhysicalHttpAttempts: maxRequests!,
                outputTokenLimit: maxTokens!,
                timeoutMs: timeoutMs!,
                approvedBudgetUsd: approvedBudgetUsd!,
                budgetBasis: budgetBasis!,
              }
            : undefined,
          costConfig: VERIFIED_OPENROUTER_DEEPSEEK_V3_COST_CONFIG,
          allowLivePaidCalls: allowPaid,
        })
      : null;

  // Track A: JEV contract smoke check (when live & requested)
  if (
    isLive &&
    mode === "current_engine" &&
    (track === "both" || track === "jev")
  ) {
    console.log("\n========================================================");
    console.log("  TRACK A: REAL JEV INTEGRATION EVALUATION (CORE-03C2)");
    console.log(
      `  Pinned Model: ${JEV_PINNED_MODEL} via OpenRouter Decisions API`,
    );
    console.log("========================================================");

    const jevInstrumentedFetch = sharedEngineSession!.createInstrumentedFetch({
      getTurnIndex: () => 0,
    });
    const key = process.env.OPENROUTER_API_KEY;
    const jevProvider = createJevDecisionsProvider({
      getEnvVar: (k) => (k === "OPENROUTER_API_KEY" ? key : process.env[k]),
      fetchImpl: jevInstrumentedFetch,
      timeoutMs: timeoutMs ?? 15000,
    });

    const jevStart = Date.now();
    const jevRes = await jevProvider.evaluate({
      state: {
        customerMessage: "عايز أحجز كشف أسنان بكرة",
        businessName: "عيادة د. أحمد",
        services: [],
        faqs: [],
        languageHint: "ar",
      },
      questions: {
        bookingRequested: {
          type: "noul",
          instructions: "The customer is asking to book an appointment.",
        },
      },
    });
    const jevLatency = Date.now() - jevStart;

    const ans = jevRes.answers["bookingRequested"];
    const bookingProb = ans && ans.type === "noul" ? ans.noul : null;

    console.log(`  1. Customer Input            : "عايز أحجز كشف أسنان بكرة"`);
    console.log(
      `  2. Observed JEV Model        : ${jevRes.servedModel ?? "Unknown"}`,
    );
    console.log(`  3. Provider Call OK          : ${jevRes.ok}`);
    console.log(
      `  4. Physical HTTP Attempts    : ${sharedEngineSession!.attemptCount}`,
    );
    console.log(
      `  5. Latency                   : ${jevLatency}ms (provider reported: ${jevRes.latencyMs}ms)`,
    );
    console.log(
      `  6. Provider Token Usage      : in=${jevRes.inputTokens ?? "N/A"}, out=${jevRes.outputTokens ?? "N/A"}`,
    );
    console.log(
      `  7. Intent Routing Result     : bookingRequested prob=${bookingProb}`,
    );
    console.log(
      `  8. Structured Fact Updates   : UNSUPPORTED (Decisions API contract answers atomic questions; structured SET/REMOVE fact updates are not exposed)`,
    );
    console.log(
      `  9. Verdict                   : ${jevRes.ok ? "PASS" : "FAIL"} (Intent routing PASS; structured fact extraction UNSUPPORTED by contract design)`,
    );
    console.log("========================================================\n");

    if (track === "jev") {
      return;
    }
  }

  for (const scenario of targetScenarios) {
    let trace: ScenarioTrace;
    if (mode === "current_engine") {
      trace = await runCurrentEngineScenario(scenario, {
        live: isLive,
        allowLivePaidCalls: allowPaid,
        session: sharedEngineSession ?? undefined,
        operatorLimits: isLive
          ? {
              scenarioSubset: targetScenarios.map((s) => s.id),
              maxPhysicalHttpAttempts: maxRequests!,
              outputTokenLimit: maxTokens!,
              timeoutMs: timeoutMs!,
              approvedBudgetUsd: approvedBudgetUsd!,
              budgetBasis: budgetBasis!,
            }
          : undefined,
        inspect: isInspect,
      });
    } else if (mode === "agent_c") {
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

    // Create the single sanitized public projection for both terminal display and disk export
    const sanitizedTrace = redactTrace(trace);

    console.log(`\nRunning Scenario: [${scenario.id}] ${scenario.title}`);
    console.log(
      `Category: ${scenario.category} | Mode: ${sanitizedTrace.architecture}`,
    );
    console.log(`Description: ${scenario.description}`);

    for (const turn of sanitizedTrace.turns) {
      printTurn(turn, isInspect);
    }

    console.log("\n========================================================");
    console.log(`Verdict : ${sanitizedTrace.verdict}`);
    if (sanitizedTrace.failureReason) {
      console.log(`Failure : ${sanitizedTrace.failureReason}`);
    }
    const totalTokensStr =
      sanitizedTrace.metrics.totalTokens?.totalTokens !== null &&
      sanitizedTrace.metrics.totalTokens?.totalTokens !== undefined
        ? `${sanitizedTrace.metrics.totalTokens.totalTokens} tokens`
        : sanitizedTrace.metrics.knownTokensSubtotal
          ? `${sanitizedTrace.metrics.knownTokensSubtotal.totalTokens} known tokens (partial)`
          : "unknown tokens";
    console.log(
      `Metrics : ${sanitizedTrace.metrics.totalTurns} turns | ${sanitizedTrace.metrics.totalDurationMs}ms execution | ${sanitizedTrace.metrics.totalLlmCalls} LLM calls | ${totalTokensStr}`,
    );
    console.log("========================================================");

    const savedPath = saveTrace(sanitizedTrace, tracesDir);
    console.log(`Trace saved to: ${savedPath}`);

    if (sanitizedTrace.verdict === "FAIL") {
      hasAnyFailure = true;
    }
  }

  if (hasAnyFailure) {
    console.error("\n❌ One or more scenarios failed.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unhandled fatal error in playground:", err);
  process.exit(1);
});
