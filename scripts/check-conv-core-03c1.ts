/* eslint-disable @typescript-eslint/no-explicit-any */
import "./setup-test-env";

import { execSync } from "node:child_process";

import {
  runCurrentEngineScenario,
  validateLiveOperatorLimits,
} from "../src/features/conversations/playground/current-engine-runner";
/**
 * FlowPilot — CORE-03C1 Focused Integrity Acceptance Test Suite
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
 * 9. Runner's own retry instrumentation counts every physical attempt at fetch boundary
 * 10. Usage accounting: missing usage stays null (never 0); partial usage preserves subtotal
 * 11. Honest monetary preflight: strict integer parsing, conservative bounds, BLOCKED status
 * 12. Shared run-level attempt ceiling across scenarios with hard refusal (N+1 blocked)
 * 13. Model output recorded separately from durable saved state
 * 14. Offer replacement detected by offer identity (id !== id -> OFFER_REPLACED)
 * 15. Outbound max_tokens parameter enforced in outgoing adapter requests
 * 16. Trace sanitization & deep canary redaction (tokens, nonces, auth headers)
 * 17. Historical modes cannot be mislabeled as current-engine live evidence
 */

import {
  CurrentEngineExecutionSession,
  DEEPSEEK_V3_OPENROUTER_COST_CONFIG,
  auditPreflightLimits,
  calculateConservativeCostCeiling,
} from "../src/features/conversations/playground/current-engine-session";
import { EGYPTIAN_ARABIC_SCENARIOS } from "../src/features/conversations/playground/egyptian-scenarios";
import { runGoalDrivenScenario } from "../src/features/conversations/playground/goal-driven-runner";
import {
  PLAYGROUND_IDS,
  createPlaygroundHarness,
} from "../src/features/conversations/playground/harness";
import { runHybridScenario } from "../src/features/conversations/playground/hybrid-runner";
import { runTypeSafeJevScenario } from "../src/features/conversations/playground/jev-runner";
import { redactTrace } from "../src/features/conversations/playground/trace-sanitizer";
import type { ScenarioTrace } from "../src/features/conversations/playground/types";

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
      (trace01.turns[0]?.processing.currentEngine?.availabilityQueries[0]
        ?.assigneeIds?.length ?? 0) === 2,
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
    "8a. Failing provider call results in AI_HANDOFF and handoffCause PROVIDER_FAILURE or AI_FAILURE",
    failingTrace.turns[0]?.assistantAction === "AI_HANDOFF" &&
      (failingTrace.turns[0]?.processing.currentEngine?.domainResult
        .handoffCause === "PROVIDER_FAILURE" ||
        failingTrace.turns[0]?.processing.currentEngine?.domainResult
          .handoffCause === "AI_FAILURE"),
  );
  check(
    "8b. Failed physical HTTP attempt is captured with status 500",
    failingTrace.turns[0]?.processing.currentEngine?.httpAttempts.attempts[0]
      ?.status === 500,
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // 9. Runner's own retry instrumentation counts every physical attempt
  // ─────────────────────────────────────────────────────────────────────────────
  let runnerAttemptCount = 0;
  const retryMockFetch: typeof fetch = async () => {
    runnerAttemptCount++;
    if (runnerAttemptCount === 1) {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    }
    return new Response(
      JSON.stringify({
        id: "chatcmpl-retry-test",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({
                intent: "BOOKING",
                action: "booking_handoff",
                content: "متاح بعد إعادة المحاولة",
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
        usage: { prompt_tokens: 140, completion_tokens: 30, total_tokens: 170 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const retryRunnerTrace = await runCurrentEngineScenario(scenario01, {
    live: true,
    upstreamFetch: retryMockFetch,
    operatorLimits: {
      scenarioSubset: ["CE-01"],
      maxPhysicalHttpAttempts: 5,
      outputTokenLimit: 500,
      timeoutMs: 15000,
      approvedBudgetUsd: 0.05,
      budgetBasis: "test retry basis",
    },
  });

  check(
    "9a. Runner recorded both physical HTTP attempts in turn details",
    retryRunnerTrace.turns[0]?.processing.currentEngine?.httpAttempts.count ===
      2 && runnerAttemptCount === 2,
  );
  check(
    "9b. First attempt recorded the abort error and second recorded success",
    retryRunnerTrace.turns[0]?.processing.currentEngine?.httpAttempts
      .attempts[0]?.error !== null &&
      retryRunnerTrace.turns[0]?.processing.currentEngine?.httpAttempts
        .attempts[1]?.status === 200,
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // 10. Usage accounting: missing usage stays null (never 0); partial usage preserves subtotal
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
        usage: null, // explicit missing usage
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
  check(
    "10b. Scenario metrics for missing usage records tokenCompleteness UNKNOWN and totalTokens null",
    noUsageTrace.metrics.tokenCompleteness === "UNKNOWN" &&
      noUsageTrace.metrics.totalTokens === null,
  );

  // Partial usage scenario (Turn 1 has usage, Turn 2 has null usage)
  const partialUsageScenario: typeof scenario03 = {
    ...scenario03,
    id: "TEST-PARTIAL-USAGE",
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
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      },
      2: {
        body: {
          intent: "BOOKING",
          action: "booking_handoff",
          content: "تم تعديل الموعد:",
          summary: "تعديل حجز",
          extraction: { service: "كشف أسنان", date: "2026-10-22" },
          factUpdates: [{ key: "date", operation: "set", value: "2026-10-22" }],
        },
        usage: null,
      },
    },
  };

  const partialTrace = await runCurrentEngineScenario(partialUsageScenario);

  check(
    "10c. Partial usage scenario records tokenCompleteness PARTIAL",
    partialTrace.metrics.tokenCompleteness === "PARTIAL",
  );
  check(
    "10d. Partial usage preserves knownTokensSubtotal while totalTokens is null",
    partialTrace.metrics.totalTokens === null &&
      partialTrace.metrics.knownTokensSubtotal?.totalTokens === 120,
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // 11. Honest monetary preflight: strict integer parsing, conservative bounds, BLOCKED status
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

  const limitFractional = validateLiveOperatorLimits({
    scenarioSubset: ["CE-01"],
    maxPhysicalHttpAttempts: 10.5 as any,
    outputTokenLimit: 500,
    timeoutMs: 15000,
    approvedBudgetUsd: 0.1,
    budgetBasis: "basis",
  });
  check(
    "11c. Fractional maxPhysicalHttpAttempts is rejected",
    limitFractional.valid === false,
  );

  const costCalc = calculateConservativeCostCeiling(25);
  check(
    "11d. Conservative cost ceiling for 25 calls @ 5k in / 500 out is exactly $0.0210 USD",
    costCalc.totalCostCeilingUsd.toFixed(4) === "0.0210",
  );

  const preflightAudit = auditPreflightLimits(
    {
      scenarioSubset: ["CE-01"],
      maxPhysicalHttpAttempts: 25,
      outputTokenLimit: 500,
      timeoutMs: 15000,
      approvedBudgetUsd: 0.05,
      budgetBasis: "test",
    },
    ["CE-01"],
    DEEPSEEK_V3_OPENROUTER_COST_CONFIG,
    false, // allowLivePaidExecution = false in slice
  );

  check(
    "11e. Preflight audit reports status BLOCKED and details provider limitations",
    preflightAudit.status === "BLOCKED" &&
      preflightAudit.resolvedConfig.conservativeCostCeilingUsd.toFixed(4) ===
        "0.0210" &&
      preflightAudit.resolvedConfig.providerSideHardLimitSupport.includes(
        "UNSUPPORTED_BY_PROVIDER_API",
      ),
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // 12. Shared run-level attempt ceiling across scenarios with hard refusal (N+1 blocked)
  // ─────────────────────────────────────────────────────────────────────────────
  const sharedSession = new CurrentEngineExecutionSession({
    live: false,
    operatorLimits: {
      scenarioSubset: ["CE-01", "CE-02"],
      maxPhysicalHttpAttempts: 2, // only 2 attempts allowed
      outputTokenLimit: 500,
      timeoutMs: 15000,
      approvedBudgetUsd: 0.05,
      budgetBasis: "test ceiling",
    },
  });

  // Run 1: spends 1 attempt
  await runCurrentEngineScenario(scenario01, { session: sharedSession });
  check(
    "12a. Session attempt count is 1 after scenario 1",
    sharedSession.attemptCount === 1,
  );

  // Run 2: spends 1 attempt
  const scenario02 = EGYPTIAN_ARABIC_SCENARIOS.find((s) => s.id === "CE-02")!;
  await runCurrentEngineScenario(scenario02, { session: sharedSession });
  check(
    "12b. Session attempt count is 2 after scenario 2",
    sharedSession.attemptCount === 2,
  );

  // Run 3: test direct instrumentedFetch refusal when ceiling reached
  let ceilingCaught = false;
  try {
    const fetchFn = sharedSession.createInstrumentedFetch({
      getTurnIndex: () => 1,
    });
    await fetchFn("https://api.example.com");
  } catch (err: any) {
    if (String(err?.message).includes("RUN_LIMIT_EXCEEDED")) {
      ceilingCaught = true;
    }
  }
  check(
    "12c. Direct attempt was hard-blocked when whole-run ceiling of 2 was reached",
    ceilingCaught === true && sharedSession.attemptCount === 2,
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // 13. Model output recorded separately from durable saved state
  // ─────────────────────────────────────────────────────────────────────────────
  const traceModelOutput = await runCurrentEngineScenario(scenario01);
  const ceDetails = traceModelOutput.turns[0]?.processing.currentEngine;

  check(
    "13a. modelExtraction matches AI response extraction, not durable knownFacts",
    ceDetails?.semantic.modelExtraction?.service === "كشف أسنان" &&
      ceDetails?.semantic.modelExtraction?.date === "2026-10-21",
  );
  check(
    "13b. modelFactUpdates contains model factUpdates array",
    Array.isArray(ceDetails?.semantic.modelFactUpdates) &&
      ceDetails?.semantic.modelFactUpdates?.length === 2,
  );
  check(
    "13c. reconciledKnownFacts contains durable state knownFacts",
    ceDetails?.semantic.reconciledKnownFacts?.service === "كشف أسنان" &&
      ceDetails?.semantic.reconciledKnownFacts?.date === "2026-10-21",
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // 14. Offer replacement detected by offer identity (id !== id -> OFFER_REPLACED)
  // ─────────────────────────────────────────────────────────────────────────────
  // In CE-03: Turn 1 creates offer A, Turn 2 requests date change to Thursday,
  // creating offer B with a different ID.
  check(
    "14a. Offer transition correctly detected as OFFER_REPLACED when offer id changed",
    trace03.turns[1]?.stateBefore?.offer?.id !==
      trace03.turns[1]?.stateAfter?.offer?.id &&
      trace03.turns[1]?.processing.currentEngine?.offerTransition.transition ===
        "OFFER_REPLACED",
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // 15. Outbound max_tokens parameter enforced in outgoing adapter requests
  // ─────────────────────────────────────────────────────────────────────────────
  let capturedOutboundBody: any = null;
  const inspectBodyFetch: typeof fetch = async (_input, init) => {
    if (init?.body) {
      try {
        capturedOutboundBody = JSON.parse(init.body as string);
      } catch {
        // non-json
      }
    }
    return new Response(
      JSON.stringify({
        id: "chatcmpl-tokens-test",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({
                intent: "BOOKING",
                action: "booking_handoff",
                content: "متاح",
                summary: "حجز",
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
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  await runCurrentEngineScenario(scenario01, {
    live: true,
    upstreamFetch: inspectBodyFetch,
    operatorLimits: {
      scenarioSubset: ["CE-01"],
      maxPhysicalHttpAttempts: 5,
      outputTokenLimit: 350, // explicit limit
      timeoutMs: 15000,
      approvedBudgetUsd: 0.05,
      budgetBasis: "test max_tokens",
    },
  });

  check(
    "15a. Outbound adapter HTTP request contained max_tokens: 350 in body",
    capturedOutboundBody?.max_tokens === 350,
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // 16. Trace sanitization & deep canary redaction (tokens, nonces, auth headers)
  // ─────────────────────────────────────────────────────────────────────────────
  const dirtyTrace: ScenarioTrace = {
    ...trace01,
    turns: [
      {
        ...trace01.turns[0]!,
        processing: {
          ...trace01.turns[0]!.processing,
          currentEngine: {
            ...trace01.turns[0]!.processing.currentEngine!,
            httpAttempts: {
              count: 1,
              attempts: [
                {
                  index: 1,
                  url: "https://openrouter.ai/api/v1/chat/completions",
                  method: "POST",
                  status: 200,
                  durationMs: 120,
                  timestamp: new Date().toISOString(),
                  sanitizedHeaders: {
                    authorization: "Bearer secret-api-key-998877",
                    "x-test-token": "secret_token_abcdef123456",
                  },
                  error: null,
                },
              ],
            },
          },
        },
        outbound: {
          ...trace01.turns[0]!.outbound,
          text: "Your claim nonce is: claim_nonce_1234567890abcdef. Please do not share.",
        },
      },
    ],
  };

  const sanitized = redactTrace(dirtyTrace);
  const serialized = JSON.stringify(sanitized);

  check(
    "16a. Raw secret-api-key-998877 is completely redacted from trace",
    !serialized.includes("secret-api-key-998877"),
  );
  check(
    "16b. Raw secret_token_abcdef123456 is completely redacted from trace",
    !serialized.includes("secret_token_abcdef123456"),
  );
  check(
    "16c. Raw claim_nonce_1234567890abcdef is redacted into deterministic marker",
    !serialized.includes("claim_nonce_1234567890abcdef") &&
      serialized.includes("[REDACTED_NONCE_"),
  );

  // 16d-h: Seed an arbitrary offer ID into actual state and callback markup
  const arbitraryOfferId = "custom_unprefixed_offer_xyz_987654";
  const canaryTrace: ScenarioTrace = {
    ...trace01,
    turns: [
      {
        ...trace01.turns[0]!,
        processing: {
          ...trace01.turns[0]!.processing,
          tokenUsageEstimate: {
            promptTokens: 111,
            completionTokens: 22,
            totalTokens: 133,
          },
          measuredUsage: {
            source: "OFFLINE_FIXTURE",
            promptTokens: 111,
            completionTokens: 22,
            totalTokens: 133,
            isEstimate: false,
          },
          currentEngine: {
            ...trace01.turns[0]!.processing.currentEngine!,
            tokenUsage: {
              source: "OFFLINE_FIXTURE",
              promptTokens: 111,
              completionTokens: 22,
              totalTokens: 133,
              isEstimate: false,
            },
          },
        },
        stateAfter: {
          offer: {
            id: arbitraryOfferId,
            token: "tok999",
            status: "ACTIVE" as any,
          } as any,
        },
        outbound: {
          text: `Booking offered under ID ${arbitraryOfferId}.`,
          buttons: [{ label: "10:00 AM", payload: `fp:${arbitraryOfferId}:1` }],
          sentCount: 1,
        },
      },
      {
        ...trace01.turns[0]!,
        turnIndex: 2,
        stateBefore: {
          offer: {
            id: arbitraryOfferId,
            token: "tok999",
            status: "ACTIVE" as any,
          } as any,
        },
        stateAfter: {
          offer: {
            id: arbitraryOfferId,
            token: "tok999",
            status: "CONSUMED" as any,
          } as any,
        },
      },
    ],
    metrics: {
      ...trace01.metrics,
      totalTokens: {
        promptTokens: 222,
        completionTokens: 44,
        totalTokens: 266,
      },
      knownTokensSubtotal: {
        promptTokens: 222,
        completionTokens: 44,
        totalTokens: 266,
      },
    },
  };

  // Prove value exists before export
  const preExportJson = JSON.stringify(canaryTrace);
  check(
    "16d. Arbitrary offer ID exists in trace before export",
    preExportJson.includes(arbitraryOfferId) &&
      preExportJson.includes(`fp:${arbitraryOfferId}:1`),
  );

  const canarySanitized = redactTrace(canaryTrace);
  const postExportJson = JSON.stringify(canarySanitized);

  // Prove it is absent from all public output
  check(
    "16e. Arbitrary offer ID is absent from public exported output",
    !postExportJson.includes(arbitraryOfferId),
  );
  check(
    "16f. Callback payload fp:<id>:1 is redacted to stable marker",
    !postExportJson.includes(`fp:${arbitraryOfferId}:1`) &&
      postExportJson.includes("fp:[REDACTED_OFFER_"),
  );

  // Prove stable references preserve identity comparisons
  const turn1OfferId = canarySanitized.turns[0]?.stateAfter?.offer?.id;
  const turn2OfferBeforeId = canarySanitized.turns[1]?.stateBefore?.offer?.id;
  const turn2OfferAfterId = canarySanitized.turns[1]?.stateAfter?.offer?.id;
  check(
    "16g. Stable references preserve identity comparison across turns",
    typeof turn1OfferId === "string" &&
      turn1OfferId.startsWith("[REDACTED_OFFER_") &&
      turn1OfferId === turn2OfferBeforeId &&
      turn1OfferId === turn2OfferAfterId,
  );

  // Prove tokenUsage and totalTokens remain structured numeric data
  const postTurn1Usage =
    canarySanitized.turns[0]?.processing.currentEngine?.tokenUsage;
  const postMetricsTotal = canarySanitized.metrics.totalTokens;
  check(
    "16h. tokenUsage and totalTokens remain structured numeric data, not [REDACTED]",
    typeof postTurn1Usage?.totalTokens === "number" &&
      postTurn1Usage.totalTokens === 133 &&
      typeof postMetricsTotal?.totalTokens === "number" &&
      postMetricsTotal.totalTokens === 266 &&
      canarySanitized.turns[0]?.processing.tokenUsageEstimate.totalTokens ===
        133,
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // 17. Historical modes cannot be mislabeled as current-engine live evidence
  // ─────────────────────────────────────────────────────────────────────────────
  const hybridTrace = await runHybridScenario(scenario01);
  const goalDrivenTrace = await runGoalDrivenScenario(scenario01);
  const jevTrace = await runTypeSafeJevScenario(scenario01, { live: false });

  check(
    "17a. Hybrid runner labels architecture HYBRID_B, not CURRENT_ENGINE",
    hybridTrace.architecture === "HYBRID_B",
  );
  check(
    "17b. Goal driven runner labels architecture GOAL_DRIVEN_HYBRID, not CURRENT_ENGINE",
    goalDrivenTrace.architecture === "GOAL_DRIVEN_HYBRID",
  );
  check(
    "17c. TypeSafe JEV runner labels architecture TYPESAFE_JEV_GOAL_DRIVEN, not CURRENT_ENGINE",
    jevTrace.architecture === "TYPESAFE_JEV_GOAL_DRIVEN",
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // 18. Assistant Telemetry Interface & Observability
  // ─────────────────────────────────────────────────────────────────────────────
  check(
    "18a. Observed provider is captured from actual telemetry/observability",
    trace01.turns[0]?.processing.currentEngine?.routing.observedProvider !==
      null,
  );

  const prohibitedScenario = {
    ...scenario01,
    id: "CE-PROHIBITED-TEST",
  };
  const telemetryProhibitedTrace = await runCurrentEngineScenario(
    prohibitedScenario,
    {
      aiPolicy: { primaryProvider: "deterministic" as any } as any,
    },
  );
  check(
    "18b. Policy prohibition results in route POLICY_PROHIBITED",
    telemetryProhibitedTrace.turns[0]?.processing.currentEngine?.routing
      .route === "POLICY_PROHIBITED",
  );
  check(
    "18c. Policy prohibition leaves observedProvider and observedModel as null",
    telemetryProhibitedTrace.turns[0]?.processing.currentEngine?.routing
      .observedProvider === null &&
      telemetryProhibitedTrace.turns[0]?.processing.currentEngine?.routing
        .observedModel === null,
  );
  check(
    "18d. Mechanical selection has no model extraction or model fact updates",
    trace11.turns[1]?.processing.currentEngine?.semantic.modelExtraction ===
      null &&
      trace11.turns[1]?.processing.currentEngine?.semantic.modelFactUpdates ===
        null,
  );
  check(
    "18e. Configured provider/model cannot masquerade as observed values when no call ran",
    trace11.turns[1]?.processing.currentEngine?.routing.observedProvider ===
      null &&
      trace11.turns[1]?.processing.currentEngine?.routing.observedModel ===
        null &&
      trace11.turns[1]?.processing.currentEngine?.routing.configuredProvider ===
        "openrouter",
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // 19. Per-attempt usage completeness (failed attempt without usage + successful retry with usage)
  // ─────────────────────────────────────────────────────────────────────────────
  let retryAttemptCount = 0;
  const retryUsageFetch: typeof fetch = async () => {
    retryAttemptCount++;
    if (retryAttemptCount === 1) {
      // First attempt times out without token usage
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    }
    // Second attempt succeeds with known token usage
    return new Response(
      JSON.stringify({
        id: "chatcmpl-retry-test",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({
                intent: "BOOKING",
                action: "booking_handoff",
                content: "تم الحجز",
                summary: "حجز",
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

  const retryTrace = await runCurrentEngineScenario(scenario01, {
    live: true,
    upstreamFetch: retryUsageFetch,
    operatorLimits: {
      scenarioSubset: ["CE-01"],
      maxPhysicalHttpAttempts: 5,
      outputTokenLimit: 500,
      timeoutMs: 15000,
      approvedBudgetUsd: 0.05,
      budgetBasis: "test retry completeness",
    },
  });

  check(
    "19a. Turn with 1 failed attempt (no usage) and 1 retry (usage) has completeness PARTIAL",
    retryTrace.turns[0]?.processing.measuredUsage?.completeness === "PARTIAL",
  );
  check(
    "19b. Turn with partial attempt usage leaves totalTokens as null",
    retryTrace.turns[0]?.processing.measuredUsage?.totalTokens === null,
  );
  check(
    "19c. Scenario with partial usage records tokenCompleteness PARTIAL and totalTokens null",
    retryTrace.metrics.tokenCompleteness === "PARTIAL" &&
      retryTrace.metrics.totalTokens === null &&
      retryTrace.metrics.knownTokensSubtotal?.totalTokens === 180,
  );

  // 19d: Partially populated usage object (missing prompt/completion tokens)
  const partialFieldsFetch: typeof fetch = async () => {
    return new Response(
      JSON.stringify({
        id: "chatcmpl-partial-fields-test",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({
                intent: "BOOKING",
                action: "booking_handoff",
                content: "متاح",
                summary: "حجز",
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
        // Missing prompt_tokens and completion_tokens:
        usage: { total_tokens: 120 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const partialFieldsTrace = await runCurrentEngineScenario(scenario01, {
    live: true,
    upstreamFetch: partialFieldsFetch,
    operatorLimits: {
      scenarioSubset: ["CE-01"],
      maxPhysicalHttpAttempts: 5,
      outputTokenLimit: 500,
      timeoutMs: 15000,
      approvedBudgetUsd: 0.05,
      budgetBasis: "test partial fields completeness",
    },
  });

  check(
    "19d. Usage object with missing prompt/completion fields reports completeness PARTIAL",
    partialFieldsTrace.turns[0]?.processing.measuredUsage?.completeness ===
      "PARTIAL",
  );
  check(
    "19e. Missing prompt/completion components stay null without coercing ?? 0",
    partialFieldsTrace.turns[0]?.processing.measuredUsage?.promptTokens ===
      null &&
      partialFieldsTrace.turns[0]?.processing.measuredUsage
        ?.completionTokens === null &&
      partialFieldsTrace.turns[0]?.processing.measuredUsage?.totalTokens ===
        120,
  );
  check(
    "19f. Turn with failed attempt + retry leaves tokenUsageEstimate.totalTokens as null (not 0)",
    retryTrace.turns[0]?.processing.tokenUsageEstimate?.totalTokens === null,
  );
  check(
    "19g. Turn with partial fields leaves tokenUsageEstimate missing fields as null (not 0)",
    partialFieldsTrace.turns[0]?.processing.tokenUsageEstimate?.promptTokens ===
      null &&
      partialFieldsTrace.turns[0]?.processing.tokenUsageEstimate
        ?.completionTokens === null &&
      partialFieldsTrace.turns[0]?.processing.tokenUsageEstimate
        ?.totalTokens === 120,
  );

  // 19h: Generative response without usage object at all
  const noUsageFetch: typeof fetch = async () => {
    return new Response(
      JSON.stringify({
        id: "chatcmpl-no-usage-test",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({
                intent: "BOOKING",
                action: "booking_handoff",
                content: "متاح",
                summary: "حجز",
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
        // usage field entirely omitted
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const liveNoUsageTrace = await runCurrentEngineScenario(scenario01, {
    live: true,
    upstreamFetch: noUsageFetch,
    operatorLimits: {
      scenarioSubset: ["CE-01"],
      maxPhysicalHttpAttempts: 5,
      outputTokenLimit: 500,
      timeoutMs: 15000,
      approvedBudgetUsd: 0.05,
      budgetBasis: "test no usage completeness",
    },
  });

  check(
    "19h. Generative response without usage reports UNKNOWN with null counts in measuredUsage and tokenUsageEstimate (not 0)",
    liveNoUsageTrace.turns[0]?.processing.measuredUsage?.completeness ===
      "UNKNOWN" &&
      liveNoUsageTrace.turns[0]?.processing.measuredUsage?.promptTokens ===
        null &&
      liveNoUsageTrace.turns[0]?.processing.measuredUsage?.completionTokens ===
        null &&
      liveNoUsageTrace.turns[0]?.processing.measuredUsage?.totalTokens ===
        null &&
      liveNoUsageTrace.turns[0]?.processing.tokenUsageEstimate?.promptTokens ===
        null &&
      liveNoUsageTrace.turns[0]?.processing.tokenUsageEstimate
        ?.completionTokens === null &&
      liveNoUsageTrace.turns[0]?.processing.tokenUsageEstimate?.totalTokens ===
        null &&
      liveNoUsageTrace.metrics.tokenCompleteness === "UNKNOWN" &&
      liveNoUsageTrace.metrics.totalTokens === null,
  );

  // 19i: Non-generative turn preserves genuine zero counts with NOT_APPLICABLE
  check(
    "19i. Non-generative turn preserves genuine zero counts with NOT_APPLICABLE",
    trace11.turns[1]?.processing.llmCalls === 0 &&
      trace11.turns[1]?.processing.measuredUsage?.completeness ===
        "NOT_APPLICABLE" &&
      trace11.turns[1]?.processing.measuredUsage?.source === "NOT_APPLICABLE" &&
      trace11.turns[1]?.processing.measuredUsage?.promptTokens === 0 &&
      trace11.turns[1]?.processing.measuredUsage?.completionTokens === 0 &&
      trace11.turns[1]?.processing.measuredUsage?.totalTokens === 0 &&
      trace11.turns[1]?.processing.tokenUsageEstimate?.promptTokens === 0 &&
      trace11.turns[1]?.processing.tokenUsageEstimate?.completionTokens === 0 &&
      trace11.turns[1]?.processing.tokenUsageEstimate?.totalTokens === 0,
  );

  // 19j: Public trace output does not contradict measuredUsage by displaying unknown generative usage as zero
  const publicNoUsage = redactTrace(liveNoUsageTrace);
  const publicPartial = redactTrace(partialFieldsTrace);
  const publicRetry = redactTrace(retryTrace);
  const publicNonGen = redactTrace(trace11);

  const noUsagePublicValid =
    publicNoUsage.turns[0]?.processing.tokenUsageEstimate?.totalTokens ===
      null &&
    publicNoUsage.turns[0]?.processing.measuredUsage?.totalTokens === null &&
    publicNoUsage.metrics.totalTokens === null;

  const partialPublicValid =
    publicPartial.turns[0]?.processing.tokenUsageEstimate?.promptTokens ===
      null &&
    publicPartial.turns[0]?.processing.measuredUsage?.promptTokens === null &&
    publicPartial.turns[0]?.processing.tokenUsageEstimate?.totalTokens ===
      120 &&
    publicPartial.turns[0]?.processing.measuredUsage?.totalTokens === 120;

  const retryPublicValid =
    publicRetry.turns[0]?.processing.tokenUsageEstimate?.totalTokens === null &&
    publicRetry.turns[0]?.processing.measuredUsage?.totalTokens === null;

  const nonGenPublicValid =
    publicNonGen.turns[1]?.processing.tokenUsageEstimate?.totalTokens === 0 &&
    publicNonGen.turns[1]?.processing.measuredUsage?.totalTokens === 0 &&
    publicNonGen.turns[1]?.processing.measuredUsage?.completeness ===
      "NOT_APPLICABLE";

  check(
    "19j. Public trace projection does not contradict measuredUsage by converting unknown generative usage to zero",
    noUsagePublicValid &&
      partialPublicValid &&
      retryPublicValid &&
      nonGenPublicValid,
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // 20. Evaluation Verdict Integrity
  // ─────────────────────────────────────────────────────────────────────────────
  const missingIntentScenario = {
    ...scenario01,
    id: "CE-MISSING-INTENT-TEST",
    turns: [
      {
        input: "أي كلام عامي",
        expectedIntent: "NON_EXISTENT_INTENT",
      },
    ],
  };
  const missingIntentTrace = await runCurrentEngineScenario(
    missingIntentScenario,
  );
  check(
    "20a. Mismatched or missing intent causes scenario verdict FAIL",
    missingIntentTrace.verdict === "FAIL" &&
      Boolean(
        missingIntentTrace.failureReason?.includes(
          "Expected intent 'NON_EXISTENT_INTENT'",
        ),
      ),
  );

  // 20b. Actual passing evaluated scenario produces zero exit code
  let passingCliExitCode = 1;
  try {
    execSync(
      "pnpm tsx scripts/convo-playground.ts --mode current_engine --scenario CE-01",
      { stdio: "pipe" },
    );
    passingCliExitCode = 0;
  } catch (err: any) {
    passingCliExitCode = err.status ?? 1;
  }
  check(
    "20b. Passing evaluated scenario in playground CLI produces zero exit code",
    passingCliExitCode === 0,
  );

  // 20c. Actual evaluated scenario failure reaches failed-evaluation path and produces non-zero exit code
  let failingCliExitCode = 0;
  let failingOutput = "";
  try {
    const res = execSync(
      "pnpm tsx scripts/convo-playground.ts --mode current_engine --scenario CE-01",
      {
        stdio: "pipe",
        env: {
          ...process.env,
          FLOWPILOT_TEST_EVAL_FAILURE_INTENT:
            "__INTENTIONALLY_MISMATCHED_INTENT__",
        },
      },
    );
    failingOutput = res.toString();
  } catch (err: any) {
    failingCliExitCode = err.status ?? 1;
    failingOutput =
      (err.stdout?.toString() ?? "") + (err.stderr?.toString() ?? "");
  }
  check(
    "20c. Actual evaluated scenario failure reaches failed-evaluation path and produces non-zero exit code",
    failingCliExitCode !== 0 &&
      failingOutput.includes("Verdict : FAIL") &&
      failingOutput.includes("One or more scenarios failed"),
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // 21. CE-13: Repaired false sensitive handoff on dialectal phrase 'مش مشكلة' (CORE-03D2)
  // ─────────────────────────────────────────────────────────────────────────────
  const scenario13 = EGYPTIAN_ARABIC_SCENARIOS.find((s) => s.id === "CE-13")!;
  check(
    "21a. CE-13 exists in EGYPTIAN_ARABIC_SCENARIOS",
    scenario13 !== undefined,
  );
  const trace13 = await runCurrentEngineScenario(scenario13);
  check(
    "21b. CE-13 passes and faithfully records the repair",
    trace13.verdict === "PASS",
  );
  check(
    "21c. CE-13 turn 2 continues AI_REPLY without handoff (cause null, timePreference removed)",
    trace13.turns[1]?.assistantAction === "AI_REPLY" &&
      trace13.turns[1]?.processing.currentEngine?.domainResult.handoffCause ===
        null &&
      trace13.turns[1]?.stateAfter?.knownFacts?.timePreference == null,
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // 22. Complete offline Egyptian Arabic scenario corpus (CE-01 to CE-13)
  // ─────────────────────────────────────────────────────────────────────────────
  check(
    "22a. Scenario corpus contains exactly 13 Egyptian Arabic scenarios",
    EGYPTIAN_ARABIC_SCENARIOS.length === 13,
  );

  let corpusAllPassed = true;
  const failingCorpusScenarios: string[] = [];
  for (const s of EGYPTIAN_ARABIC_SCENARIOS) {
    const t = await runCurrentEngineScenario(s);
    if (t.verdict !== "PASS") {
      corpusAllPassed = false;
      failingCorpusScenarios.push(`${s.id}: ${t.failureReason}`);
    }
  }

  check(
    "22b. All 13 offline Egyptian scenarios pass current-engine execution",
    corpusAllPassed,
    failingCorpusScenarios,
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
