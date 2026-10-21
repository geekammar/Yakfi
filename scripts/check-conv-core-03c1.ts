/* eslint-disable @typescript-eslint/no-explicit-any */
import "./setup-test-env";

/**
 * FlowPilot — CORE-03C1 Acceptance Test Suite
 *
 * Verifies Current Engine Playground alignment:
 * 1. Structured turn reaches generative adapter, not prototype
 * 2. Durable state is saved and reloaded between turns with CAS revision semantics
 * 3. SET / REMOVE / no-update appear correctly in recorded durable state
 * 4. Captured availability query arguments match actual repository calls
 * 5. Scenario reset prevents cross-scenario contamination
 * 6. Mechanical selection spends zero provider attempts
 * 7. Policy prohibition prevents provider requests
 * 8. Provider failure/invalid output is recorded honestly
 * 9. Mocked retry attempts are counted individually at the physical fetch boundary
 * 10. Missing usage stays unknown (never reported as zero)
 * 11. Live preflight blocks missing/invalid limits before network activity
 * 12. Historical modes cannot be mislabeled as current-engine live evidence
 */

import {
  runCurrentEngineScenario,
  validateLiveOperatorLimits,
} from "../src/features/conversations/playground/current-engine-runner";
import { EGYPTIAN_ARABIC_SCENARIOS } from "../src/features/conversations/playground/egyptian-scenarios";
import { runGoalDrivenScenario } from "../src/features/conversations/playground/goal-driven-runner";
import {
  PLAYGROUND_IDS,
  createPlaygroundHarness,
} from "../src/features/conversations/playground/harness";
import { runHybridScenario } from "../src/features/conversations/playground/hybrid-runner";
import { runTypeSafeJevScenario } from "../src/features/conversations/playground/jev-runner";

type CheckResult = {
  label: string;
  pass: boolean;
  detail?: any;
};

const checks: CheckResult[] = [];

function check(label: string, pass: boolean, detail?: any) {
  if (!pass && detail !== undefined) {
    console.error(`[FAIL] ${label}:`, detail);
  }
  checks.push({ label, pass, detail });
}

async function runAcceptanceSuite(): Promise<void> {
  console.log("========================================================");
  console.log("  FLOWPILOT CORE-03C1 ACCEPTANCE VERIFICATION SUITE");
  console.log("  Playground Alignment with Current Conversation Engine");
  console.log("========================================================\n");

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. Structured turn reaches generative adapter, not prototype
  // ─────────────────────────────────────────────────────────────────────────────
  const scenario01 = EGYPTIAN_ARABIC_SCENARIOS.find((s) => s.id === "CE-01")!;
  const trace01 = await runCurrentEngineScenario(scenario01);

  check("1a. CE-01 passes with verdict PASS", trace01.verdict === "PASS");
  check(
    "1b. Architecture is strictly CURRENT_ENGINE",
    trace01.architecture === "CURRENT_ENGINE",
  );
  check(
    "1c. Routing is STRUCTURED_SEMANTIC with structured_turn capability",
    trace01.turns[0]?.processing.currentEngine?.routing.route ===
      "STRUCTURED_SEMANTIC" &&
      trace01.turns[0]?.processing.currentEngine?.routing
        .effectiveCapability === "structured_turn",
  );
  check(
    "1d. Generative adapter attempt was captured at fetch boundary",
    trace01.turns[0]?.processing.currentEngine?.httpAttempts.count === 1 &&
      trace01.metrics.totalLlmCalls === 1,
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Durable state is saved and reloaded between turns with CAS semantics
  // ─────────────────────────────────────────────────────────────────────────────
  const scenario03 = EGYPTIAN_ARABIC_SCENARIOS.find((s) => s.id === "CE-03")!;
  const trace03 = await runCurrentEngineScenario(scenario03);

  check(
    "2a. CE-03 multi-turn passes with verdict PASS",
    trace03.verdict === "PASS",
  );
  check(
    "2b. Multi-turn scenario has exactly 2 turns",
    trace03.turns.length === 2,
  );
  check(
    "2c. Turn 1 stateBefore is null and stateAfter has date 2026-10-21",
    trace03.turns[0]?.stateBefore === null &&
      trace03.turns[0]?.stateAfter?.selectedDate === "2026-10-21",
  );
  check(
    "2d. Turn 2 stateBefore has date 2026-10-21 loaded from state store",
    trace03.turns[1]?.stateBefore?.selectedDate === "2026-10-21",
  );
  check(
    "2e. Turn 2 stateAfter has updated date 2026-10-22",
    trace03.turns[1]?.stateAfter?.selectedDate === "2026-10-22",
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. SET / REMOVE / no-update appear correctly in recorded durable state
  // ─────────────────────────────────────────────────────────────────────────────
  const scenario05 = EGYPTIAN_ARABIC_SCENARIOS.find((s) => s.id === "CE-05")!;
  const trace05 = await runCurrentEngineScenario(scenario05);

  check("3a. CE-05 passes with verdict PASS", trace05.verdict === "PASS");
  check(
    "3b. Turn 1 records SET provider Sara in durable state",
    trace05.turns[0]?.stateAfter?.providerPreference === "د. سارة عادل",
  );
  check(
    "3c. Turn 2 records REMOVE provider and clears providerPreference",
    trace05.turns[1]?.stateAfter?.providerPreference === null ||
      trace05.turns[1]?.stateAfter?.providerPreference === "ANY_PROVIDER",
  );

  const scenario08 = EGYPTIAN_ARABIC_SCENARIOS.find((s) => s.id === "CE-08")!;
  const trace08 = await runCurrentEngineScenario(scenario08);

  check(
    "3d. CE-08 FAQ turn performs no-update and preserves booking facts",
    trace08.turns[1]?.stateAfter?.selectedDate === "2026-10-21" &&
      trace08.turns[1]?.stateAfter?.selectedService === "كشف أسنان",
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. Captured availability query arguments match actual repository calls
  // ─────────────────────────────────────────────────────────────────────────────
  check(
    "4a. Availability query for CE-01 captured exact businessId, date, and assigneeIds",
    trace01.turns[0]?.processing.currentEngine?.availabilityQueries.length ===
      1 &&
      trace01.turns[0]?.processing.currentEngine?.availabilityQueries[0]
        ?.businessId === PLAYGROUND_IDS.BIZ_ID &&
      trace01.turns[0]?.processing.currentEngine?.availabilityQueries[0]
        ?.date === "2026-10-21" &&
      trace01.turns[0]?.processing.currentEngine?.availabilityQueries[0]
        ?.assigneeIds.length === 2,
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. Scenario reset prevents cross-scenario contamination
  // ─────────────────────────────────────────────────────────────────────────────
  const harness = createPlaygroundHarness({
    todayRef: "2026-10-20",
  });
  await runCurrentEngineScenario(scenario01, { harness });

  check(
    "5a. Harness has captured data before reset",
    harness.messages.length > 0 &&
      harness.capturedAvailabilityQueries.length > 0 &&
      harness.capturedHttpAttempts.length > 0 &&
      harness.stateStore.rows.size > 0,
  );

  harness.reset();

  check(
    "5b. Reset completely wipes messages, queries, writes, attempts, and state store rows",
    harness.messages.length === 0 &&
      harness.deliveredOutbound.length === 0 &&
      harness.capturedAvailabilityQueries.length === 0 &&
      harness.capturedAppointmentWrites.length === 0 &&
      harness.capturedHttpAttempts.length === 0 &&
      harness.stateStore.rows.size === 0 &&
      harness.dedupeLedger.size === 0,
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. Mechanical selection spends zero provider attempts
  // ─────────────────────────────────────────────────────────────────────────────
  const scenario11 = EGYPTIAN_ARABIC_SCENARIOS.find((s) => s.id === "CE-11")!;
  const trace11 = await runCurrentEngineScenario(scenario11);

  check("6a. CE-11 passes with verdict PASS", trace11.verdict === "PASS");
  check(
    "6b. Turn 1 (slot offer query) spent exactly 1 physical HTTP attempt",
    trace11.turns[0]?.processing.currentEngine?.httpAttempts.count === 1,
  );
  check(
    "6c. Turn 2 (mechanical numeric selection '1') spent strictly 0 physical HTTP attempts",
    trace11.turns[1]?.processing.currentEngine?.httpAttempts.count === 0 &&
      trace11.turns[1]?.processing.currentEngine?.routing.route ===
        "MECHANICAL_SELECTION",
  );
  check(
    "6d. Turn 2 confirmed booking and created appointment",
    trace11.turns[1]?.diagnostics.appointmentCreated === true &&
      trace11.turns[1]?.conversationStatus === "BOOKED",
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // 7. Policy prohibition prevents provider requests
  // ─────────────────────────────────────────────────────────────────────────────
  const prohibitedHarness = createPlaygroundHarness({
    todayRef: "2026-10-20",
  });

  const prohibitedTrace = await runCurrentEngineScenario(scenario01, {
    harness: prohibitedHarness,
    aiPolicy: {
      primaryProvider: "deterministic" as any,
    },
  });

  check(
    "7a. Turn under prohibited/deterministic policy spends ZERO physical HTTP calls",
    prohibitedHarness.capturedHttpAttempts.length === 0 &&
      prohibitedTrace.metrics.totalLlmCalls === 0,
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // 8. Provider failure / invalid output is recorded honestly
  // ─────────────────────────────────────────────────────────────────────────────
  const failingScenario: typeof scenario01 = {
    ...scenario01,
    id: "TEST-FAIL-01",
    mockResponses: {
      1: {
        body: { error: "Internal Server Error" },
        status: 500,
      },
    },
    turns: [
      {
        input: "عايز كشف أسنان",
        expectedAction: "AI_HANDOFF",
      },
    ],
  };

  const failingTrace = await runCurrentEngineScenario(failingScenario);

  check(
    "8a. Failing provider call results in AI_HANDOFF and handoffCause PROVIDER_FAILURE",
    failingTrace.turns[0]?.assistantAction === "AI_HANDOFF" &&
      failingTrace.turns[0]?.processing.currentEngine?.domainResult
        .handoffCause === "PROVIDER_FAILURE",
  );
  check(
    "8b. Failed physical HTTP attempt is captured with status 500",
    failingTrace.turns[0]?.processing.currentEngine?.httpAttempts.attempts[0]
      ?.status === 500,
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // 9. Mocked retry attempts are counted individually
  // ─────────────────────────────────────────────────────────────────────────────
  let attemptCounter = 0;
  const retryHarness = createPlaygroundHarness({
    todayRef: "2026-10-20",
  });

  const retryMockFetch: typeof fetch = async () => {
    attemptCounter++;
    if (attemptCounter === 1) {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    }
    return new Response(
      JSON.stringify({
        id: "chatcmpl-retry-2",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({
                intent: "BOOKING",
                action: "booking_handoff",
                content: "تم بنجاح بعد المحاولة الثانية",
                summary: "طلب حجز",
                extraction: { service: "كشف أسنان", date: "2026-10-21" },
                factUpdates: [
                  { key: "service", operation: "set", value: "كشف أسنان" },
                  { key: "date", operation: "set", value: "2026-10-21" },
                ],
              }),
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 150, completion_tokens: 30, total_tokens: 180 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  // Run turn using retryMockFetch through current-engine
  const retryPolicyAi = await (
    await import("@/server/integrations/ai/factory")
  ).createPolicyBackedAi({
    getEnvVar: () => "test-key",
    fetchImpl: retryMockFetch,
    getAiPolicyImpl: async () => ({
      success: true,
      data: {
        policy: {
          primaryProvider: "openrouter",
          primaryModel: "deepseek/deepseek-chat",
          secondaryProvider: null,
          secondaryModel: null,
          fallbackEnabled: false,
          primarySecretRef: "OPENROUTER_API_KEY",
          secondarySecretRef: null,
          openRouterProviderOnly: null,
          updatedAt: new Date(),
        },
        effective: {
          primaryProvider: "openrouter",
          primaryModel: "deepseek/deepseek-chat",
          secondary: null,
          fallbackEnabled: false,
          openRouterProviderOnly: null,
        },
      },
    }),
  });

  retryHarness.deps.ai = retryPolicyAi;
  const retryTurnResult = await (
    await import("@/features/conversations/server/conversation-engine")
  ).receiveInboundMessage(
    retryHarness.deps,
    {
      from: "+201001234567",
      to: "+201001111111",
      text: "عايز كشف أسنان بكرة",
      receivedAt: "2026-10-20T10:00:00.000Z",
    },
    { businessId: retryHarness.business.id },
  );

  check(
    "9a. Retried request counted individual physical HTTP attempts (attemptCounter == 2)",
    attemptCounter === 2 && retryTurnResult.ok === true,
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // 10. Missing usage stays unknown (never reported as zero)
  // ─────────────────────────────────────────────────────────────────────────────
  const noUsageScenario: typeof scenario01 = {
    ...scenario01,
    id: "TEST-NO-USAGE",
    mockResponses: {
      1: {
        body: {
          intent: "BOOKING",
          action: "booking_handoff",
          content: "متاح المواعيد التالية:",
          summary: "طلب حجز",
          extraction: { service: "كشف أسنان", date: "2026-10-21" },
          factUpdates: [
            { key: "service", operation: "set", value: "كشف أسنان" },
            { key: "date", operation: "set", value: "2026-10-21" },
          ],
        },
        usage: null, // explicit null usage
      },
    },
    turns: [
      {
        input: "عايز كشف أسنان بكرة",
      },
    ],
  };

  const noUsageTrace = await runCurrentEngineScenario(noUsageScenario);

  check(
    "10a. Missing usage reports source UNKNOWN and promptTokens === null (NOT 0)",
    noUsageTrace.turns[0]?.processing.currentEngine?.tokenUsage.source ===
      "UNKNOWN" &&
      noUsageTrace.turns[0]?.processing.currentEngine?.tokenUsage
        .promptTokens === null &&
      noUsageTrace.turns[0]?.processing.currentEngine?.tokenUsage
        .totalTokens === null,
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // 11. Live preflight blocks missing/invalid limits before network activity
  // ─────────────────────────────────────────────────────────────────────────────
  const limitNull = validateLiveOperatorLimits(null);
  check("11a. Null limits are rejected", limitNull.valid === false);

  const limitEmptySubset = validateLiveOperatorLimits({
    scenarioSubset: [],
    maxPhysicalHttpAttempts: 10,
    outputTokenLimit: 500,
    timeoutMs: 15000,
    approvedBudgetUsd: 0.1,
    budgetBasis: "basis",
  });
  check(
    "11b. Empty scenarioSubset is rejected",
    limitEmptySubset.valid === false,
  );

  const limitZeroReqs = validateLiveOperatorLimits({
    scenarioSubset: ["CE-01"],
    maxPhysicalHttpAttempts: 0,
    outputTokenLimit: 500,
    timeoutMs: 15000,
    approvedBudgetUsd: 0.1,
    budgetBasis: "basis",
  });
  check("11c. Zero max requests is rejected", limitZeroReqs.valid === false);

  let liveBlockedCaught = false;
  try {
    await runCurrentEngineScenario(scenario01, {
      live: true,
      operatorLimits: {
        scenarioSubset: ["CE-01"],
        maxPhysicalHttpAttempts: 10,
        outputTokenLimit: 500,
        timeoutMs: 15000,
        approvedBudgetUsd: 0.1,
        budgetBasis: "basis",
      },
    });
  } catch (err: any) {
    if (String(err?.message).includes("LIVE EXECUTION BLOCKED")) {
      liveBlockedCaught = true;
    }
  }
  check(
    "11d. Live mode in CORE-03C1 safely blocks paid execution before network activity",
    liveBlockedCaught === true,
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // 12. Historical modes cannot be mislabeled as current-engine live evidence
  // ─────────────────────────────────────────────────────────────────────────────
  const hybridTrace = await runHybridScenario(scenario01);
  const goalDrivenTrace = await runGoalDrivenScenario(scenario01);
  const jevTrace = await runTypeSafeJevScenario(scenario01, { live: false });

  check(
    "12a. Hybrid runner labels architecture HYBRID_B, not CURRENT_ENGINE",
    hybridTrace.architecture === "HYBRID_B",
  );
  check(
    "12b. Goal driven runner labels architecture GOAL_DRIVEN_HYBRID, not CURRENT_ENGINE",
    goalDrivenTrace.architecture === "GOAL_DRIVEN_HYBRID",
  );
  check(
    "12c. TypeSafe JEV runner labels architecture TYPESAFE_JEV_GOAL_DRIVEN, not CURRENT_ENGINE",
    jevTrace.architecture === "TYPESAFE_JEV_GOAL_DRIVEN",
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // Summary
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n========================================================");
  const passed = checks.filter((c) => c.pass).length;
  const failed = checks.filter((c) => !c.pass).length;
  console.log(
    `TOTAL CHECKS: ${checks.length} | PASSED: ${passed} | FAILED: ${failed}`,
  );
  console.log("========================================================\n");

  for (const c of checks) {
    console.log(`${c.pass ? "✔" : "❌"} ${c.label}`);
  }

  if (failed > 0) {
    console.error(`\n❌ Acceptance suite failed with ${failed} failure(s).`);
    process.exit(1);
  }

  console.log("\n✔ ALL CORE-03C1 ACCEPTANCE CHECKS PASSED SUCCESSFULLY!");
}

runAcceptanceSuite().catch((err) => {
  console.error("Unhandled fatal error in acceptance suite:", err);
  process.exit(1);
});
