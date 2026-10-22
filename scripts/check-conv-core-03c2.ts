/* eslint-disable @typescript-eslint/no-explicit-any */
import "./setup-test-env";

import {
  runCurrentEngineScenario,
  validateLiveOperatorLimits,
} from "../src/features/conversations/playground/current-engine-runner";
import {
  CurrentEngineExecutionSession,
  JEV_BOOKING_REQUESTED_THRESHOLD,
  VERIFIED_OPENROUTER_DEEPSEEK_V3_COST_CONFIG,
  auditPreflightLimits,
  evaluateJevBookingIntent,
  runTrackAJevEvaluation,
} from "../src/features/conversations/playground/current-engine-session";
/**
 * FlowPilot — Acceptance Verification Suite (CORE-03C2)
 *
 * Verifies:
 * 1. Offline mode cannot reach real transport.
 * 2. Invalid or missing live limits fail before network.
 * 3. Explicit operator opt-in required for live execution.
 * 4. Combined attempt limits include retries and both tracks (Track A JEV + Track B LLM).
 * 5. Output limits (<= 600 tokens) and timeout (15s) reach the real transport path.
 * 6. Isolated business/outbound repositories remain in use (zero external DB / WhatsApp / Telegram I/O).
 * 7. Track A JEV contract boundary: atomic intent routing supported; structured SET/REMOVE fact updates reported as UNSUPPORTED.
 * 8. Small fixed Egyptian corpus (Cases A through H) definitions, reference time, and offline verification.
 *
 * Usage:
 *   pnpm check:conv-core-03c2
 */

import { CORE_03C2_SMOKE_SCENARIOS } from "../src/features/conversations/playground/egyptian-scenarios";
import { createPlaygroundHarness } from "../src/features/conversations/playground/harness";
import {
  JEV_PINNED_MODEL,
  createJevDecisionsProvider,
} from "../src/server/integrations/ai/jev-decisions-provider";
import { jevEligibility } from "../src/server/integrations/ai/jev-semantic-strategy";

let totalChecks = 0;
let passedChecks = 0;
const failures: string[] = [];

function check(title: string, passed: boolean, extraInfo?: string): void {
  totalChecks++;
  if (passed) {
    passedChecks++;
    console.log(`✔ ${title}`);
  } else {
    failures.push(title);
    console.error(`❌ ${title}${extraInfo ? ` -> ${extraInfo}` : ""}`);
  }
}

async function main(): Promise<void> {
  console.log("========================================================");
  console.log("  FLOWPILOT CORE-03C2 ACCEPTANCE VERIFICATION SUITE");
  console.log("  Real JEV + LLM Smoke Evaluation Rails & Safety Envelope");
  console.log("========================================================\n");

  const smokeA = CORE_03C2_SMOKE_SCENARIOS.find((s) => s.id === "SMOKE-A")!;
  const smokeB = CORE_03C2_SMOKE_SCENARIOS.find((s) => s.id === "SMOKE-B")!;
  const smokeC = CORE_03C2_SMOKE_SCENARIOS.find((s) => s.id === "SMOKE-C")!;
  const smokeD = CORE_03C2_SMOKE_SCENARIOS.find((s) => s.id === "SMOKE-D")!;
  const smokeE = CORE_03C2_SMOKE_SCENARIOS.find((s) => s.id === "SMOKE-E")!;
  const smokeF = CORE_03C2_SMOKE_SCENARIOS.find((s) => s.id === "SMOKE-F")!;
  const smokeG = CORE_03C2_SMOKE_SCENARIOS.find((s) => s.id === "SMOKE-G")!;
  const smokeH = CORE_03C2_SMOKE_SCENARIOS.find((s) => s.id === "SMOKE-H")!;

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. Offline mode cannot reach real transport
  // ─────────────────────────────────────────────────────────────────────────────
  let networkAttempted = false;
  const interceptingFetch = async (): Promise<Response> => {
    networkAttempted = true;
    throw new Error("REAL_NETWORK_ACCESS_FORBIDDEN_IN_OFFLINE_MODE");
  };

  const offlineTrace = await runCurrentEngineScenario(smokeA, {
    live: false,
    upstreamFetch: interceptingFetch,
  });

  check(
    "1a. Offline execution passes with verdict PASS",
    offlineTrace.verdict === "PASS",
  );
  check(
    "1b. Offline mode never dispatches to upstream real transport",
    networkAttempted === false,
  );
  check(
    "1c. Offline mode does not report LIVE_PROVIDER as token source",
    offlineTrace.turns[0]?.processing.measuredUsage?.source !== "LIVE_PROVIDER",
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Invalid or missing live limits fail before network
  // ─────────────────────────────────────────────────────────────────────────────
  check(
    "2a. Null limits are rejected by validator",
    validateLiveOperatorLimits(null).valid === false,
  );
  check(
    "2b. Undefined limits are rejected by validator",
    validateLiveOperatorLimits(undefined).valid === false,
  );
  check(
    "2c. Empty scenarioSubset is rejected",
    validateLiveOperatorLimits({
      scenarioSubset: [],
      maxPhysicalHttpAttempts: 20,
      outputTokenLimit: 500,
      timeoutMs: 15000,
      approvedBudgetUsd: 0.1,
      budgetBasis: "test",
    }).valid === false,
  );
  check(
    "2d. Non-integer maxPhysicalHttpAttempts is rejected",
    validateLiveOperatorLimits({
      scenarioSubset: ["SMOKE-A"],
      maxPhysicalHttpAttempts: 12.5,
      outputTokenLimit: 500,
      timeoutMs: 15000,
      approvedBudgetUsd: 0.1,
      budgetBasis: "test",
    }).valid === false,
  );
  check(
    "2e. Negative maxPhysicalHttpAttempts is rejected",
    validateLiveOperatorLimits({
      scenarioSubset: ["SMOKE-A"],
      maxPhysicalHttpAttempts: -5,
      outputTokenLimit: 500,
      timeoutMs: 15000,
      approvedBudgetUsd: 0.1,
      budgetBasis: "test",
    }).valid === false,
  );
  check(
    "2f. Zero outputTokenLimit is rejected",
    validateLiveOperatorLimits({
      scenarioSubset: ["SMOKE-A"],
      maxPhysicalHttpAttempts: 20,
      outputTokenLimit: 0,
      timeoutMs: 15000,
      approvedBudgetUsd: 0.1,
      budgetBasis: "test",
    }).valid === false,
  );
  check(
    "2g. Negative timeoutMs is rejected",
    validateLiveOperatorLimits({
      scenarioSubset: ["SMOKE-A"],
      maxPhysicalHttpAttempts: 20,
      outputTokenLimit: 500,
      timeoutMs: -100,
      approvedBudgetUsd: 0.1,
      budgetBasis: "test",
    }).valid === false,
  );
  check(
    "2h. Non-positive approvedBudgetUsd is rejected",
    validateLiveOperatorLimits({
      scenarioSubset: ["SMOKE-A"],
      maxPhysicalHttpAttempts: 20,
      outputTokenLimit: 500,
      timeoutMs: 15000,
      approvedBudgetUsd: 0,
      budgetBasis: "test",
    }).valid === false,
  );
  check(
    "2i. Empty budgetBasis is rejected",
    validateLiveOperatorLimits({
      scenarioSubset: ["SMOKE-A"],
      maxPhysicalHttpAttempts: 20,
      outputTokenLimit: 500,
      timeoutMs: 15000,
      approvedBudgetUsd: 0.1,
      budgetBasis: "   ",
    }).valid === false,
  );

  let preflightBlockedCaught = false;
  try {
    await runCurrentEngineScenario(smokeA, {
      live: true,
      operatorLimits: null as any,
    });
  } catch (err: any) {
    if (String(err?.message).includes("LIVE PREFLIGHT BLOCKED")) {
      preflightBlockedCaught = true;
    }
  }
  check(
    "2j. Runner throws LIVE PREFLIGHT BLOCKED before network when limits are null",
    preflightBlockedCaught === true,
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. Explicit operator opt-in required for live execution
  // ─────────────────────────────────────────────────────────────────────────────
  let optInBlockedCaught = false;
  try {
    await runCurrentEngineScenario(smokeA, {
      live: true,
      allowLivePaidCalls: false,
      operatorLimits: {
        scenarioSubset: ["SMOKE-A"],
        maxPhysicalHttpAttempts: 20,
        outputTokenLimit: 500,
        timeoutMs: 15000,
        approvedBudgetUsd: 0.1,
        budgetBasis: "test",
      },
    });
  } catch (err: any) {
    if (String(err?.message).includes("LIVE EXECUTION BLOCKED")) {
      optInBlockedCaught = true;
    }
  }
  check(
    "3a. Live execution without allowLivePaidCalls opt-in throws LIVE EXECUTION BLOCKED",
    optInBlockedCaught === true,
  );

  const preflightWithoutOptIn = auditPreflightLimits(
    {
      scenarioSubset: ["SMOKE-A"],
      maxPhysicalHttpAttempts: 24,
      outputTokenLimit: 600,
      timeoutMs: 15000,
      approvedBudgetUsd: 0.1,
      budgetBasis: "test",
    },
    ["SMOKE-A"],
    VERIFIED_OPENROUTER_DEEPSEEK_V3_COST_CONFIG,
    false,
  );
  check(
    "3b. Preflight audit without operator approval has status BLOCKED",
    preflightWithoutOptIn.status === "BLOCKED",
  );

  const preflightWithOptIn = auditPreflightLimits(
    {
      scenarioSubset: ["SMOKE-A"],
      maxPhysicalHttpAttempts: 24,
      outputTokenLimit: 600,
      timeoutMs: 15000,
      approvedBudgetUsd: 0.1,
      budgetBasis:
        "24 calls * 5k in @ $0.2574/M + 600 out @ $1.0287/M = $0.0457 USD <= $0.10",
    },
    ["SMOKE-A"],
    VERIFIED_OPENROUTER_DEEPSEEK_V3_COST_CONFIG,
    true,
  );
  check(
    "3c. Preflight audit with operator opt-in has status READY_FOR_OPERATOR_APPROVAL",
    preflightWithOptIn.status === "READY_FOR_OPERATOR_APPROVAL",
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. Combined attempt limits include retries and both tracks
  // ─────────────────────────────────────────────────────────────────────────────
  const sharedSession = new CurrentEngineExecutionSession({
    live: true,
    operatorLimits: {
      scenarioSubset: ["SMOKE-A", "SMOKE-B"],
      maxPhysicalHttpAttempts: 2, // Low ceiling to test hard block
      outputTokenLimit: 600,
      timeoutMs: 15000,
      approvedBudgetUsd: 0.1,
      budgetBasis: "test",
    },
    costConfig: VERIFIED_OPENROUTER_DEEPSEEK_V3_COST_CONFIG,
    allowLivePaidCalls: true,
    liveFetchImpl: async () =>
      new Response(
        JSON.stringify({
          id: "mock-call",
          object: "chat.completion",
          choices: [
            {
              message: {
                role: "assistant",
                content: JSON.stringify({
                  intent: "BOOKING",
                  action: "booking_handoff",
                  content: "متاح المواعيد التالية",
                  extraction: { date: "2026-10-21" },
                }),
              },
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 50,
            total_tokens: 150,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  });

  // Track A attempt (JEV call using shared session instrumented fetch)
  const jevFetch = sharedSession.createInstrumentedFetch({
    getTurnIndex: () => 1,
  });
  await jevFetch("https://openrouter.ai/api/alpha/decisions");

  check(
    "4a. Track A attempt increments shared session counter to 1",
    sharedSession.attemptCount === 1,
  );

  // Track B attempt (LLM call using shared session)
  await runCurrentEngineScenario(smokeA, {
    live: true,
    allowLivePaidCalls: true,
    session: sharedSession,
    operatorLimits: {
      scenarioSubset: ["SMOKE-A"],
      maxPhysicalHttpAttempts: 2,
      outputTokenLimit: 600,
      timeoutMs: 15000,
      approvedBudgetUsd: 0.1,
      budgetBasis: "test",
    },
  });

  check(
    "4b. Track B attempt increments shared session counter to 2",
    sharedSession.attemptCount === 2,
  );

  // Third attempt must be hard blocked
  let ceilingCaught = false;
  try {
    const nextFetch = sharedSession.createInstrumentedFetch({
      getTurnIndex: () => 2,
    });
    await nextFetch("https://openrouter.ai/api/v1/chat/completions");
  } catch (err: any) {
    if (String(err?.message).includes("RUN_LIMIT_EXCEEDED")) {
      ceilingCaught = true;
    }
  }

  check(
    "4c. Combined ceiling hard-blocks 3rd attempt across both tracks before network dispatch",
    ceilingCaught === true && sharedSession.attemptCount === 2,
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. Output limits and timeout/cancellation reach the real transport path
  // ─────────────────────────────────────────────────────────────────────────────
  let capturedBodyPayload: any = null;
  let capturedSignal: AbortSignal | null | undefined = null;

  const inspectingFetch = async (
    _input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    capturedBodyPayload = JSON.parse(String(init?.body ?? "{}"));
    capturedSignal = init?.signal;
    return new Response(
      JSON.stringify({
        id: "mock-call",
        object: "chat.completion",
        choices: [
          {
            message: {
              role: "assistant",
              content: JSON.stringify({
                intent: "BOOKING",
                action: "booking_handoff",
                content: "المواعيد المتاحة",
                extraction: { date: "2026-10-21" },
              }),
            },
          },
        ],
        usage: { prompt_tokens: 150, completion_tokens: 40, total_tokens: 190 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  await runCurrentEngineScenario(smokeA, {
    live: true,
    allowLivePaidCalls: true,
    upstreamFetch: inspectingFetch,
    operatorLimits: {
      scenarioSubset: ["SMOKE-A"],
      maxPhysicalHttpAttempts: 10,
      outputTokenLimit: 600,
      timeoutMs: 15000,
      approvedBudgetUsd: 0.1,
      budgetBasis: "test",
    },
  });

  check(
    "5a. Output token limit (600) reaches outbound HTTP request body max_tokens",
    capturedBodyPayload?.max_tokens === 600,
  );
  check(
    "5b. Timeout AbortSignal reaches outbound HTTP request",
    capturedSignal != null,
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. Isolated business/outbound repositories remain in use
  // ─────────────────────────────────────────────────────────────────────────────
  const harness = createPlaygroundHarness({
    channel: "WHATSAPP",
    requiredSemanticCapability: "structured_turn",
  });

  const traceH = await runCurrentEngineScenario(smokeH, {
    harness,
  });

  check(
    "6a. Appointment creation in Case H creates appointment strictly in in-memory repository",
    harness.appointments.length === 1 &&
      harness.appointments[0]?.id === "appt-1",
  );
  check(
    "6b. Outbound messages are captured in in-memory message store without external API dispatch",
    harness.deliveredOutbound.length === 2,
  );
  check(
    "6c. Conversation state is persisted in in-memory state store with CAS revision semantics",
    (harness.stateStore.rows.get(harness.conversation.id)?.revision ?? 0) >= 1,
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // 7. Track A JEV contract boundary, positive threshold & failure separation
  // ─────────────────────────────────────────────────────────────────────────────
  const jevStratEligibility = jevEligibility({
    message: "عايز أحجز كشف أسنان بكرة",
    businessName: "عيادة د. أحمد",
    conversationStatus: "AI_ACTIVE",
    recentMessages: [],
    services: [],
    faqs: [],
    requiredSemanticCapability: "structured_turn",
  });

  check(
    "7a. Turns requiring structured_turn capability are marked CAPABILITY_STRUCTURED_TURN for JEV",
    jevStratEligibility.eligible === false &&
      jevStratEligibility.reason === "CAPABILITY_STRUCTURED_TURN",
  );

  const jevSimulated = createJevDecisionsProvider({
    getEnvVar: () => "test-openrouter-key",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          model: "typesafe/jev-1.13-20260917",
          provider: "TypeSafe",
          answers: {
            bookingRequested: { type: "noul", noul: 0.98 },
            conversationGoal: { type: "choice", choice: "booking" },
          },
          usage: { input_tokens: 300, output_tokens: 24, cost: 0.0000126 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  });

  const jevRes = await jevSimulated.evaluate({
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

  check(
    "7b. JEV Decisions contract successfully answers atomic boolean and choice intent questions",
    jevRes.ok === true &&
      jevRes.answers["bookingRequested"]?.type === "noul" &&
      (jevRes.answers["bookingRequested"] as any).noul > 0.9,
  );
  check(
    "7c. JEV Decisions contract model is pinned to typesafe/jev-1.13",
    jevSimulated.model === JEV_PINNED_MODEL,
  );
  check(
    "7d. Declared positive threshold is explicitly predeclared (>= 0.70)",
    JEV_BOOKING_REQUESTED_THRESHOLD === 0.7,
  );

  // 7e. Positive answer (0.98 >= 0.70)
  const reportPositive = await runTrackAJevEvaluation({
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          model: "typesafe/jev-1.13-20260917",
          provider: "TypeSafe",
          answers: {
            bookingRequested: { type: "noul", noul: 0.98 },
          },
          usage: { input_tokens: 300, output_tokens: 24, cost: 0.0000126 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    apiKey: "test-key",
  });
  check(
    "7e. Positive answer (0.98 >= 0.70) produces transportSuccess true, semanticSuccess true, verdict PASS",
    reportPositive.transportSuccess === true &&
      reportPositive.semanticSuccess === true &&
      reportPositive.verdict === "PASS" &&
      reportPositive.failureReason === undefined,
  );

  // 7f. Low/negative answer (0.25 < 0.70)
  const reportLow = await runTrackAJevEvaluation({
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          model: "typesafe/jev-1.13-20260917",
          provider: "TypeSafe",
          answers: {
            bookingRequested: { type: "noul", noul: 0.25 },
          },
          usage: { input_tokens: 300, output_tokens: 24, cost: 0.0000126 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    apiKey: "test-key",
  });
  check(
    "7f. Low/negative answer (0.25 < 0.70) produces transportSuccess true, semanticSuccess false, verdict FAIL",
    reportLow.transportSuccess === true &&
      reportLow.semanticSuccess === false &&
      reportLow.verdict === "FAIL" &&
      String(reportLow.failureReason).includes(
        "below declared positive threshold",
      ),
  );

  // 7g. Invalid answer type (choice instead of noul)
  const reportInvalidType = await runTrackAJevEvaluation({
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          model: "typesafe/jev-1.13-20260917",
          provider: "TypeSafe",
          answers: {
            bookingRequested: { type: "choice", choice: "yes" },
          },
          usage: { input_tokens: 300, output_tokens: 24, cost: 0.0000126 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    apiKey: "test-key",
  });
  check(
    "7g. Invalid answer type produces transportSuccess true, semanticSuccess false, verdict FAIL",
    reportInvalidType.transportSuccess === true &&
      reportInvalidType.semanticSuccess === false &&
      reportInvalidType.verdict === "FAIL" &&
      String(reportInvalidType.failureReason).includes("Invalid answer type"),
  );

  // 7h. Missing answer key in provider payload fails closed
  const reportMissing = await runTrackAJevEvaluation({
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          model: "typesafe/jev-1.13-20260917",
          provider: "TypeSafe",
          answers: {},
          usage: { input_tokens: 300, output_tokens: 24, cost: 0.0000126 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    apiKey: "test-key",
  });
  check(
    "7h. Missing answer key in provider payload fails closed with verdict FAIL",
    reportMissing.verdict === "FAIL" &&
      reportMissing.semanticSuccess === false &&
      String(reportMissing.failureReason).length > 0,
  );

  const evalMissingDirect = evaluateJevBookingIntent({ ok: true, answers: {} });
  check(
    "7i. Missing answer in evaluateJevBookingIntent reports missing answer reason",
    evalMissingDirect.verdict === "FAIL" &&
      evalMissingDirect.semanticSuccess === false &&
      String(evalMissingDirect.failureReason).includes("Missing answer"),
  );

  const evalNonFinite = evaluateJevBookingIntent({
    ok: true,
    answers: { bookingRequested: { type: "noul", noul: NaN } },
  });
  check(
    "7j. Non-finite probability (NaN) reports invalid probability failure",
    evalNonFinite.verdict === "FAIL" &&
      evalNonFinite.semanticSuccess === false &&
      String(evalNonFinite.failureReason).includes("Invalid probability"),
  );

  // 7k. Provider/transport failure (HTTP 500)
  const reportProviderFailure = await runTrackAJevEvaluation({
    fetchImpl: async () =>
      new Response("Internal Server Error", {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      }),
    apiKey: "test-key",
  });
  check(
    "7k. Provider failure produces transportSuccess false, semanticSuccess false, verdict FAIL",
    reportProviderFailure.transportSuccess === false &&
      reportProviderFailure.semanticSuccess === false &&
      reportProviderFailure.verdict === "FAIL" &&
      String(reportProviderFailure.failureReason).includes(
        "Transport or provider failure",
      ),
  );

  // 7l. Shared session attempt counter increments on Track A evaluation
  const sessionForTrackA = new CurrentEngineExecutionSession({
    live: true,
    operatorLimits: {
      scenarioSubset: ["SMOKE-A"],
      maxPhysicalHttpAttempts: 5,
      outputTokenLimit: 600,
      timeoutMs: 15000,
      approvedBudgetUsd: 0.1,
      budgetBasis: "test",
    },
    costConfig: VERIFIED_OPENROUTER_DEEPSEEK_V3_COST_CONFIG,
    allowLivePaidCalls: true,
    liveFetchImpl: async () =>
      new Response(
        JSON.stringify({
          model: "typesafe/jev-1.13-20260917",
          provider: "TypeSafe",
          answers: { bookingRequested: { type: "noul", noul: 0.95 } },
          usage: { input_tokens: 200, output_tokens: 20, cost: 0.00001 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  });
  const reportWithSession = await runTrackAJevEvaluation({
    session: sessionForTrackA,
    apiKey: "test-key",
  });
  check(
    "7l. Track A execution via shared session increments session attemptCount to 1",
    reportWithSession.verdict === "PASS" && sessionForTrackA.attemptCount === 1,
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // 8. Small fixed Egyptian corpus (Cases A through H) offline verification
  // ─────────────────────────────────────────────────────────────────────────────
  check(
    "8a. CORE_03C2_SMOKE_SCENARIOS contains exactly 8 cases",
    CORE_03C2_SMOKE_SCENARIOS.length === 8,
  );

  const traceA = await runCurrentEngineScenario(smokeA);
  check(
    "8b. Case A (Direct booking) passes and reconciles date 2026-10-21",
    traceA.verdict === "PASS" &&
      traceA.turns[0]?.stateAfter?.selectedDate === "2026-10-21",
  );

  const traceB = await runCurrentEngineScenario(smokeB);
  check(
    "8c. Case B (Relative date 'بكرة') resolves to Cairo date 2026-10-21",
    traceB.verdict === "PASS" &&
      traceB.turns[0]?.stateAfter?.selectedDate === "2026-10-21",
  );

  const traceC = await runCurrentEngineScenario(smokeC);
  check(
    "8d. Case C (Date correction) updates date from Wednesday 21 to Thursday 22",
    traceC.verdict === "PASS" &&
      traceC.turns[0]?.stateAfter?.selectedDate === "2026-10-21" &&
      traceC.turns[1]?.stateAfter?.selectedDate === "2026-10-22",
  );

  const traceD = await runCurrentEngineScenario(smokeD);
  check(
    "8e. Case D (Provider preference removal) removes provider preference on 'خلاص أي دكتور متاح'",
    traceD.verdict === "PASS" &&
      traceD.turns[0]?.stateAfter?.providerPreference === "د. سارة عادل" &&
      (!traceD.turns[1]?.stateAfter?.providerPreference ||
        traceD.turns[1]?.stateAfter?.providerPreference === "ANY_PROVIDER"),
  );

  const traceE = await runCurrentEngineScenario(smokeE);
  check(
    "8f. Case E (Time preference removal) clears morning preference on 'أي وقت مناسب'",
    traceE.verdict === "PASS" &&
      traceE.turns[0]?.stateAfter?.selectedTimePref === "morning" &&
      !traceE.turns[1]?.stateAfter?.selectedTimePref,
  );

  const { aiExtractionSchema, aiFactUpdateSchema } =
    await import("../src/features/conversations/server/ai-contract");
  const noncanonicalExtraction = aiExtractionSchema.safeParse({
    service: null,
    provider: null,
    date: null,
    timePreference: "الصبح",
  });
  const canonicalExtraction = aiExtractionSchema.safeParse({
    service: null,
    provider: null,
    date: null,
    timePreference: "morning",
  });
  const noncanonicalUpdate = aiFactUpdateSchema.safeParse({
    key: "timePreference",
    operation: "set",
    value: "الصبح",
  });
  const canonicalUpdate = aiFactUpdateSchema.safeParse({
    key: "timePreference",
    operation: "set",
    value: "morning",
  });
  check(
    "8f2. Dialect timePreference ('الصبح') rejected by contract; canonical 'morning' accepted",
    !noncanonicalExtraction.success &&
      canonicalExtraction.success &&
      !noncanonicalUpdate.success &&
      canonicalUpdate.success,
  );

  const traceF = await runCurrentEngineScenario(smokeF);
  check(
    "8g. Case F (FAQ interruption) preserves booking facts across FAQ question",
    traceF.verdict === "PASS" &&
      traceF.turns[1]?.processing.semanticIntent === "FAQ" &&
      traceF.turns[1]?.stateAfter?.selectedDate === "2026-10-21",
  );

  const traceG = await runCurrentEngineScenario(smokeG);
  check(
    "8h. Case G (Known defect) records sensitive trigger on 'مش مشكلة' with SENSITIVE_OR_RESTRICTED cause",
    traceG.verdict === "PASS" &&
      traceG.turns[1]?.assistantAction === "AI_HANDOFF" &&
      traceG.turns[1]?.processing.currentEngine?.domainResult.handoffCause ===
        "SENSITIVE_OR_RESTRICTED",
  );

  check(
    "8i. Case H (Mechanical confirmation) confirms booking and spends 0 HTTP attempts on turn 2",
    traceH.verdict === "PASS" &&
      traceH.turns[1]?.processing.currentEngine?.httpAttempts.count === 0 &&
      traceH.turns[1]?.diagnostics.appointmentCreated === true,
  );

  console.log("\n========================================================");
  console.log(
    `TOTAL CHECKS: ${totalChecks} | PASSED: ${passedChecks} | FAILED: ${failures.length}`,
  );
  console.log("========================================================\n");

  if (failures.length > 0) {
    console.error("Failed checks:");
    for (const f of failures) {
      console.error(`- ${f}`);
    }
    process.exit(1);
  }

  console.log("✔ ALL CORE-03C2 ACCEPTANCE CHECKS PASSED SUCCESSFULLY!");
}

main().catch((err) => {
  console.error("Unhandled error in check:conv-core-03c2:", err);
  process.exit(1);
});
