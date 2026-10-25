/* eslint-disable @typescript-eslint/no-explicit-any */
import "./setup-test-env";

import { createPlaygroundHarness } from "@/features/conversations/playground/harness";
import type { AiRequest } from "@/features/conversations/server/ai-contract";
import {
  receiveInboundMessage,
  resolveTurnCounters,
} from "@/features/conversations/server/conversation-engine";
import {
  dehydrateConversationState,
  emptyConversationState,
} from "@/features/conversations/server/conversation-state";
import type { TurnEvidence } from "@/features/conversations/server/turn-evidence";
import { createAtriaAdapter } from "@/server/integrations/ai/atria";
import { createLlmConversationAi } from "@/server/integrations/ai/conversation-ai";
/**
 * FlowPilot — CORE-04A Acceptance Suite
 * Production AI Physical-Attempt Accounting and Control Audit
 *
 * Verifies:
 *   A. Mechanical selection: zero serving and shadow physical HTTP attempts
 *   B. Primary success: exactly 1 physical request
 *   C. Primary internal retry then success: exactly 2 physical requests
 *   D. Primary retry exhaustion followed by secondary success: exact aggregate count (e.g. 3, not 2)
 *   E. Secondary retry: full aggregate without duplicate counting (e.g. 2 + 2 = 4)
 *   F. Preflight rejection: zero HTTP requests (fails before network I/O)
 *   G. Provider timeout or transport failure: invoked HTTP attempt remains counted
 *   H. Serving JEV: real mocked HTTP invocation counts as model activity; no extra generative request follows
 *   I. Shadow: counters are separate; shadow failure does not alter customer outcome
 *   J. Missing telemetry on supported legacy/custom seam: unknown stays unknown (null), not 0 or 1
 *   K. Usage/cost honesty: known, unavailable, and partially known cases; no provider misattribution
 *   L. Budget approval: positive finite numeric USD accepted; invalid values rejected; emergency disable authoritative
 *   M. Integration: full production engine receives the correct aggregate for retry-plus-fallback
 *
 * Run: pnpm check:core-04a
 */

import { createConversationControl } from "@/server/integrations/ai/conversation-control";
import {
  isSemanticJevEmergencyDisabled,
  isTypeSafeJevPreferred,
  parseApprovedMonthlyBudget,
} from "@/server/integrations/ai/factory";
import {
  computeCostAggregation,
  parseReportedCost,
} from "@/server/integrations/ai/http";
import { createJevDecisionsProvider } from "@/server/integrations/ai/jev-decisions-provider";
import { createSemanticJevStrategy } from "@/server/integrations/ai/jev-semantic-strategy";
import {
  createShadowJevStrategy,
  createShadowSampler,
} from "@/server/integrations/ai/jev-shadow-strategy";
import { createOpenRouterAdapter } from "@/server/integrations/ai/openrouter";
import { createAiOrchestrator } from "@/server/integrations/ai/orchestrator";
import type {
  AiProviderAdapter,
  AiProviderResult,
} from "@/server/integrations/ai/types";
import type { UsageRecord } from "@/types/domain";

type CheckResult = { label: string; pass: boolean; detail?: string };
const results: CheckResult[] = [];

function check(label: string, pass: boolean, detail?: string) {
  results.push({ label, pass, detail });
  const icon = pass ? "✔" : "✘";
  console.log(`  ${icon} ${label}${!pass && detail ? ` (${detail})` : ""}`);
}

function openAiEnvelope(
  content: string,
  usage = { prompt_tokens: 15, completion_tokens: 10 },
): Record<string, unknown> {
  return {
    choices: [{ message: { content } }],
    usage,
  };
}

function validAiResponseJson(
  overrides: Partial<Record<string, unknown>> = {},
): string {
  return JSON.stringify({
    intent: "FAQ",
    action: "reply",
    content: "مواعيد العمل من ٩ صباحاً إلى ٥ مساءً",
    extraction: {
      service: null,
      provider: null,
      date: null,
      timePreference: null,
    },
    safetyAssessment: "safe",
    handoffReason: null,
    summary: null,
    ...overrides,
  });
}

function jevDecisionsEnvelope(
  answers: Record<string, unknown> = {
    bookingRequested: { type: "noul", noul: 0.95 },
  },
): Record<string, unknown> {
  return {
    model: "typesafe/jev-1.13",
    provider: "openrouter",
    answers,
    usage: {
      input_tokens: 42,
      output_tokens: 18,
    },
  };
}

type ScriptedStep =
  | { kind: "ok"; body: unknown; status?: number }
  | { kind: "status"; status: number; body: unknown }
  | { kind: "abort" }
  | { kind: "throw"; error: Error };

function createScriptedFetch(steps: ScriptedStep[]): {
  fetchImpl: typeof fetch;
  getCallCount: () => number;
} {
  let callCount = 0;
  const fetchImpl = (async () => {
    const idx = callCount;
    callCount += 1;
    const step = steps[idx] ?? steps[steps.length - 1];
    if (!step) {
      throw new Error(`Scripted fetch exhausted at call ${callCount}`);
    }
    if (step.kind === "abort") {
      throw new DOMException("The operation was aborted", "AbortError");
    }
    if (step.kind === "throw") {
      throw step.error;
    }
    const status = step.kind === "status" ? step.status : (step.status ?? 200);
    return new Response(JSON.stringify(step.body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;

  return { fetchImpl, getCallCount: () => callCount };
}

const baseRequest: AiRequest = {
  message: "ما هي ساعات العمل؟",
  businessName: "عيادة د. أحمد",
  conversationStatus: "AI_ACTIVE",
  recentMessages: [],
  services: [],
  faqs: [],
};

async function runSuite(): Promise<void> {
  console.log(
    "\n=== FlowPilot CORE-04A: Production AI Physical-Attempt Accounting & Control Audit ===\n",
  );

  // -------------------------------------------------------------------------
  // A. Mechanical selection: zero serving and shadow physical HTTP attempts
  // -------------------------------------------------------------------------
  console.log("--- Group A: Mechanical Selection Zero-Call Invariant ---");
  {
    const scripted = createScriptedFetch([
      { kind: "ok", body: openAiEnvelope(validAiResponseJson()) },
    ]);
    const mockEnv = (name: string) =>
      name.includes("KEY") ? "test-key" : undefined;
    const adapter = createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar: mockEnv,
      fetchImpl: scripted.fetchImpl,
    });
    const orch = createAiOrchestrator({
      primary: adapter,
      fallbackEnabled: false,
    });

    // When customer input is handled deterministically by bypass
    const res = await orch.callWithFallback({
      ...baseRequest,
      message: "م", // 1 character -> deterministic bypass
    });

    check(
      "A1. Mechanical/deterministic bypass produces ZERO physical HTTP requests",
      scripted.getCallCount() === 0,
    );
    check(
      "A2. Telemetry totalHttpAttempts is explicitly 0",
      res.telemetry.totalHttpAttempts === 0,
    );
    check(
      "A3. Telemetry attempts is empty",
      res.telemetry.attempts.length === 0,
    );
    check(
      "A4. Final provider is deterministic-bypass",
      res.telemetry.finalProvider === "deterministic-bypass",
    );
  }

  // -------------------------------------------------------------------------
  // B. Primary success: exactly 1 physical request
  // -------------------------------------------------------------------------
  console.log("\n--- Group B: Primary Success Accounting ---");
  {
    const scripted = createScriptedFetch([
      { kind: "ok", body: openAiEnvelope(validAiResponseJson()) },
    ]);
    const adapter = createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar: () => "valid-key",
      fetchImpl: scripted.fetchImpl,
    });
    const orch = createAiOrchestrator({
      primary: adapter,
      fallbackEnabled: false,
    });

    const res = await orch.callWithFallback(baseRequest);

    check(
      "B1. Exactly one physical HTTP call dispatched",
      scripted.getCallCount() === 1,
    );
    check(
      "B2. Telemetry totalHttpAttempts equals 1",
      res.telemetry.totalHttpAttempts === 1,
    );
    check(
      "B3. Exactly one attempt record in telemetry",
      res.telemetry.attempts.length === 1,
    );
    check(
      "B4. Attempt status is SUCCESS",
      res.telemetry.attempts[0]?.status === "SUCCESS",
    );
    check(
      "B5. Attempt reports httpAttempts=1",
      res.telemetry.attempts[0]?.httpAttempts === 1,
    );
  }

  // -------------------------------------------------------------------------
  // C. Primary internal retry then success: exactly 2 physical requests
  // -------------------------------------------------------------------------
  console.log("\n--- Group C: Primary Internal Retry Accounting ---");
  {
    const scripted = createScriptedFetch([
      { kind: "abort" },
      { kind: "ok", body: openAiEnvelope(validAiResponseJson()) },
    ]);
    const rawAdapter = createAtriaAdapter({
      model: "atria-1",
      getEnvVar: () => "valid-key",
      fetchImpl: scripted.fetchImpl,
    });
    const controlledPrimary = createConversationControl({
      provider: rawAdapter,
      settings: {
        conversationControl: {
          enabled: true,
          maxAttempts: 2,
          retryEnabled: true,
        },
      },
    });
    const orch = createAiOrchestrator({
      primary: controlledPrimary,
      fallbackEnabled: false,
    });

    const res = await orch.callWithFallback(baseRequest);

    check(
      "C1. Exactly two physical HTTP calls dispatched",
      scripted.getCallCount() === 2,
    );
    check(
      "C2. Telemetry totalHttpAttempts is 2",
      res.telemetry.totalHttpAttempts === 2,
    );
    check(
      "C3. RetryTrace captures exactly 2 attempt records",
      res.telemetry.retryTrace?.attempts.length === 2,
    );
    check(
      "C4. RetryTrace totalHttpAttempts is 2",
      res.telemetry.retryTrace?.totalHttpAttempts === 2,
    );
    check(
      "C5. First attempt marked FAILURE, second marked SUCCESS",
      res.telemetry.retryTrace?.attempts[0]?.outcome === "FAILURE" &&
        res.telemetry.retryTrace?.attempts[1]?.outcome === "SUCCESS",
    );
    check(
      "C6. Logical result outcome is SUCCESS",
      res.telemetry.finalStatus === "SUCCESS",
    );
  }

  // -------------------------------------------------------------------------
  // D. Primary retry exhaustion followed by secondary success: exact count = 3
  // -------------------------------------------------------------------------
  console.log(
    "\n--- Group D: Retry-Exhaustion Plus Fallback (2 Primary + 1 Secondary = 3) ---",
  );
  {
    const primaryFetch = createScriptedFetch([
      { kind: "abort" },
      { kind: "abort" },
    ]);
    const secondaryFetch = createScriptedFetch([
      { kind: "ok", body: openAiEnvelope(validAiResponseJson()) },
    ]);

    const rawPrimary = createOpenRouterAdapter({
      model: "deepseek/deepseek-chat",
      getEnvVar: () => "valid-key-1",
      fetchImpl: primaryFetch.fetchImpl,
    });
    const primary = createConversationControl({
      provider: rawPrimary,
      settings: {
        conversationControl: {
          enabled: true,
          maxAttempts: 2,
          retryEnabled: true,
        },
      },
    });

    const secondary = createAtriaAdapter({
      model: "atria-1",
      getEnvVar: () => "valid-key-2",
      fetchImpl: secondaryFetch.fetchImpl,
    });

    const orch = createAiOrchestrator({
      primary,
      secondary,
      fallbackEnabled: true,
    });

    const res = await orch.callWithFallback(baseRequest);

    check(
      "D1. Primary dispatched exactly 2 physical calls",
      primaryFetch.getCallCount() === 2,
    );
    check(
      "D2. Secondary dispatched exactly 1 physical call",
      secondaryFetch.getCallCount() === 1,
    );
    check(
      "D3. Combined total physical HTTP attempts is strictly 3 (not 2)",
      res.telemetry.totalHttpAttempts === 3,
    );
    check(
      "D4. Unified retryTrace aggregates all 3 attempts sequentially",
      res.telemetry.retryTrace?.attempts.length === 3,
    );
    check(
      "D5. Attempt sequence reflects providers: primary, primary, secondary",
      res.telemetry.retryTrace?.attempts[0]?.provider === "openrouter" &&
        res.telemetry.retryTrace?.attempts[1]?.provider === "openrouter" &&
        res.telemetry.retryTrace?.attempts[2]?.provider === "atria",
    );
    check(
      "D6. Each attempt carries exactly 1 httpAttempt",
      res.telemetry.retryTrace?.attempts.every((a) => a.httpAttempts === 1) ===
        true,
    );
    check("D7. Fallback was marked used", res.telemetry.fallbackUsed === true);
    check(
      "D8. Final provider is secondary",
      res.telemetry.finalProvider === "atria",
    );
    check(
      "D9. Final status is SUCCESS",
      res.telemetry.finalStatus === "SUCCESS",
    );
  }

  // -------------------------------------------------------------------------
  // E. Secondary retry supported: full aggregate within hard ceiling (1 Primary + 2 Secondary = 3)
  // -------------------------------------------------------------------------
  console.log(
    "\n--- Group E: Secondary Internal Retry (1 Primary + 2 Secondary = 3) ---",
  );
  {
    const primaryFetch = createScriptedFetch([{ kind: "abort" }]);
    const secondaryFetch = createScriptedFetch([
      { kind: "abort" },
      { kind: "ok", body: openAiEnvelope(validAiResponseJson()) },
    ]);

    const primary = createConversationControl({
      provider: createOpenRouterAdapter({
        model: "model-1",
        getEnvVar: () => "valid-key-1",
        fetchImpl: primaryFetch.fetchImpl,
      }),
      settings: {
        conversationControl: {
          enabled: true,
          maxAttempts: 1,
          retryEnabled: false,
        },
      },
    });

    const secondary = createConversationControl({
      provider: createAtriaAdapter({
        model: "model-2",
        getEnvVar: () => "valid-key-2",
        fetchImpl: secondaryFetch.fetchImpl,
      }),
      settings: {
        conversationControl: {
          enabled: true,
          maxAttempts: 2,
          retryEnabled: true,
        },
      },
    });

    const orch = createAiOrchestrator({
      primary,
      secondary,
      fallbackEnabled: true,
    });

    const res = await orch.callWithFallback(baseRequest);

    check(
      "E1. Primary dispatched 1 call and secondary dispatched 2 calls",
      primaryFetch.getCallCount() === 1 && secondaryFetch.getCallCount() === 2,
    );
    check(
      "E2. Total physical HTTP attempts is strictly 3",
      res.telemetry.totalHttpAttempts === 3,
    );
    check(
      "E3. Unified retryTrace has 3 attempts",
      res.telemetry.retryTrace?.attempts.length === 3,
    );
    check(
      "E4. Sequential attempt indices are 1, 2, 3 without collisions",
      res.telemetry.retryTrace?.attempts.map((a) => a.attempt).join(",") ===
        "1,2,3",
    );
    check("E5. Outcome is SUCCESS", res.telemetry.finalStatus === "SUCCESS");
  }

  // -------------------------------------------------------------------------
  // F. Preflight rejection: zero HTTP requests
  // -------------------------------------------------------------------------
  console.log(
    "\n--- Group F: Preflight Rejection (0 Physical HTTP Requests) ---",
  );
  {
    const scripted = createScriptedFetch([
      { kind: "ok", body: openAiEnvelope(validAiResponseJson()) },
    ]);
    const adapter = createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar: () => undefined, // missing API key -> preflight rejection
      fetchImpl: scripted.fetchImpl,
    });
    const orch = createAiOrchestrator({
      primary: adapter,
      fallbackEnabled: false,
    });

    const res = await orch.callWithFallback(baseRequest);

    check(
      "F1. Preflight rejection made ZERO physical HTTP requests",
      scripted.getCallCount() === 0,
    );
    check(
      "F2. Telemetry totalHttpAttempts is strictly 0",
      res.telemetry.totalHttpAttempts === 0,
    );
    check(
      "F3. Telemetry attempts reports CONFIG_ERROR",
      res.telemetry.attempts[0]?.errorCode === "CONFIG_ERROR",
    );
    check(
      "F4. Attempt record reports httpAttempts=0",
      res.telemetry.attempts[0]?.httpAttempts === 0,
    );
  }

  // -------------------------------------------------------------------------
  // G. Provider timeout or transport failure: invoked attempt remains counted
  // -------------------------------------------------------------------------
  console.log("\n--- Group G: Transport Failure / Timeout Accounting ---");
  {
    const scripted = createScriptedFetch([{ kind: "abort" }]);
    const adapter = createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar: () => "valid-key",
      fetchImpl: scripted.fetchImpl,
      timeoutMs: 50,
    });
    const orch = createAiOrchestrator({
      primary: adapter,
      fallbackEnabled: false,
    });

    const res = await orch.callWithFallback(baseRequest);

    check(
      "G1. Fetch was invoked before timeout",
      scripted.getCallCount() === 1,
    );
    check(
      "G2. Timeout attempt remains counted as 1 physical HTTP attempt",
      res.telemetry.totalHttpAttempts === 1,
    );
    check(
      "G3. Error code is TIMEOUT",
      res.telemetry.attempts[0]?.errorCode === "TIMEOUT",
    );
    check("G4. Status is FAILURE", res.telemetry.finalStatus === "FAILURE");
  }

  // -------------------------------------------------------------------------
  // H. Serving JEV: real mocked HTTP counts as model activity; no extra LLM
  // -------------------------------------------------------------------------
  console.log("\n--- Group H: Serving JEV Accounting ---");
  {
    const jevFetch = createScriptedFetch([
      { kind: "ok", body: jevDecisionsEnvelope() },
    ]);
    const llmFetch = createScriptedFetch([
      { kind: "ok", body: openAiEnvelope(validAiResponseJson()) },
    ]);

    const jevProvider = createJevDecisionsProvider({
      getEnvVar: () => "valid-openrouter-key",
      fetchImpl: jevFetch.fetchImpl,
    });
    const decisionStrategy = createSemanticJevStrategy({
      provider: jevProvider,
      enabled: true,
    });

    const llmAdapter = createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar: () => "valid-llm-key",
      fetchImpl: llmFetch.fetchImpl,
    });

    const orch = createAiOrchestrator({
      primary: llmAdapter,
      decisionStrategy,
      fallbackEnabled: false,
    });

    const res = await orch.callWithFallback({
      ...baseRequest,
      message: "عايز أحجز كشف أسنان",
    });

    check(
      "H1. JEV Decisions API dispatched exactly 1 physical HTTP call",
      jevFetch.getCallCount() === 1,
    );
    check(
      "H2. Serving LLM dispatched strictly ZERO calls after spent JEV",
      llmFetch.getCallCount() === 0,
    );
    check(
      "H3. Telemetry totalHttpAttempts reflects JEV invocation (1)",
      res.telemetry.totalHttpAttempts === 1,
    );
    check(
      "H4. Telemetry jevDecision mode is DETERMINISTIC",
      res.telemetry.jevDecision?.mode === "DETERMINISTIC",
    );
    check(
      "H5. jevCallSpent is true",
      res.telemetry.jevDecision?.semantic?.jevCallSpent === true,
    );
    check(
      "H6. finalProvider is jev-deterministic",
      res.telemetry.finalProvider === "jev-deterministic",
    );

    const jevCounters = resolveTurnCounters({
      deterministicBypass: false,
      providerName: "openrouter",
      turnTelemetry: res.telemetry,
    });
    check(
      "H7. JEV serving 1-call invariant: providerAttempts === 1 and modelCallCount === 1 (no double counting to 2)",
      jevCounters.providerAttempts === 1 && jevCounters.modelCallCount === 1,
    );
  }

  // -------------------------------------------------------------------------
  // I. Shadow: separate counters; failure does not alter customer outcome
  // -------------------------------------------------------------------------
  console.log("\n--- Group I: Shadow Evaluation Isolation ---");
  {
    const servingFetch = createScriptedFetch([
      {
        kind: "ok",
        body: openAiEnvelope(
          validAiResponseJson({ content: "خدمتنا الأساسية كشف أسنان" }),
        ),
      },
    ]);
    const shadowFetch = createScriptedFetch([
      { kind: "status", status: 500, body: { error: "shadow error" } },
    ]);

    const primary = createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar: () => "valid-key",
      fetchImpl: servingFetch.fetchImpl,
    });

    const shadowProvider = createJevDecisionsProvider({
      getEnvVar: () => "valid-key",
      fetchImpl: shadowFetch.fetchImpl,
      timeoutMs: 1000,
    });

    const shadowStrategy = createShadowJevStrategy({
      provider: shadowProvider,
      sampler: createShadowSampler({ getEnvVar: () => "1" }), // 100% sample rate
    });

    const orch = createAiOrchestrator({
      primary,
      shadowStrategy,
      fallbackEnabled: false,
    });

    const res = await orch.callWithFallback({
      ...baseRequest,
      message: "عايز أعرف الخدمات",
      traceId: "trace-shadow-test-01",
    });

    check(
      "I1. Serving HTTP call dispatched exactly once",
      servingFetch.getCallCount() === 1,
    );
    check(
      "I2. Shadow HTTP call dispatched once",
      shadowFetch.getCallCount() === 1,
    );
    check(
      "I3. Serving totalHttpAttempts is 1 (shadow does NOT inflate serving count)",
      res.telemetry.totalHttpAttempts === 1,
    );
    check(
      "I4. Shadow evidence captures failure isolation",
      res.telemetry.shadow?.jevCallSpent === true,
    );
    check(
      "I5. Shadow failure did NOT corrupt or alter customer serving response",
      res.response !== null &&
        res.response.content === "خدمتنا الأساسية كشف أسنان",
    );
  }

  // -------------------------------------------------------------------------
  // J. Missing telemetry on supported legacy/custom seam: unknown stays null
  // -------------------------------------------------------------------------
  console.log("\n--- Group J: Legacy/Custom Adapter Unknown Telemetry ---");
  {
    const legacyAdapter: AiProviderAdapter = {
      providerId: "openrouter",
      model: "legacy-model",
      secretRef: "OPENROUTER_API_KEY",
      async call(): Promise<AiProviderResult> {
        return {
          ok: true,
          response: {
            action: "reply",
            intent: "FAQ",
            content: "legacy reply",
            extraction: {
              service: null,
              provider: null,
              date: null,
              timePreference: null,
            },
            handoffReason: null,
            summary: null,
          },
          provider: "openrouter",
          model: "legacy-model",
          latencyMs: 50,
          // Explicitly OMITTING httpAttempts to represent legacy adapter
        };
      },
    };

    const orch = createAiOrchestrator({
      primary: legacyAdapter,
      fallbackEnabled: false,
    });

    const res = await orch.callWithFallback(baseRequest);

    check(
      "J1. Telemetry totalHttpAttempts is explicitly null when unknown",
      res.telemetry.totalHttpAttempts === null,
    );
    check(
      "J2. Does not fabricate a physical count of 1",
      res.telemetry.totalHttpAttempts !== 1,
    );
    check(
      "J3. Does not silently convert unknown to 0",
      res.telemetry.totalHttpAttempts !== 0,
    );

    const jCounters = resolveTurnCounters({
      deterministicBypass: false,
      providerName: "legacy-provider",
      turnTelemetry: res.telemetry,
    });
    check(
      "J4. Unknown physical telemetry derives modelCallCount=1 honestly while providerAttempts remains strictly null",
      jCounters.providerAttempts === null && jCounters.modelCallCount === 1,
    );

    // Mixed known / unknown fallback
    const p1Fetch = createScriptedFetch([
      { kind: "status", status: 500, body: { error: "down" } },
    ]);
    const pKnown = createOpenRouterAdapter({
      model: "openrouter/p1",
      getEnvVar: () => "k",
      fetchImpl: p1Fetch.fetchImpl,
    });
    const sUnknown: AiProviderAdapter = {
      providerId: "atria",
      model: "custom-model",
      secretRef: "CUSTOM_KEY",
      async call() {
        return {
          ok: true,
          provider: "atria",
          model: "custom-model",
          latencyMs: 15,
          response: JSON.parse(validAiResponseJson()),
        };
      },
    };
    const orchMixed = createAiOrchestrator({
      primary: pKnown,
      secondary: sUnknown,
      fallbackEnabled: true,
    });
    const resMixed = await orchMixed.callWithFallback(baseRequest);
    check(
      "J5. Mixed known and unknown physical attempts aggregates strictly to null (no fabricated total)",
      resMixed.telemetry.totalHttpAttempts === null &&
        resMixed.telemetry.fallbackUsed === true,
    );
  }

  // -------------------------------------------------------------------------
  // K. Usage and cost honesty: token preservation & attribution
  // -------------------------------------------------------------------------
  console.log("\n--- Group K: Usage & Cost Honesty ---");
  {
    // Complete case
    const step1 = openAiEnvelope(validAiResponseJson(), {
      prompt_tokens: 25,
      completion_tokens: 15,
    });
    const scripted1 = createScriptedFetch([{ kind: "ok", body: step1 }]);
    const adapter1 = createOpenRouterAdapter({
      model: "openrouter/model-1",
      getEnvVar: () => "key",
      fetchImpl: scripted1.fetchImpl,
    });
    const res1 = await createAiOrchestrator({
      primary: adapter1,
      fallbackEnabled: false,
    }).callWithFallback(baseRequest);

    check(
      "K1. Complete reported usage preserved in attempt record",
      res1.telemetry.attempts[0]?.inputTokens === 25 &&
        res1.telemetry.attempts[0]?.outputTokens === 15,
    );

    // Unavailable tokens case (transport failure)
    const scripted2 = createScriptedFetch([
      { kind: "status", status: 500, body: { error: "down" } },
    ]);
    const adapter2 = createOpenRouterAdapter({
      model: "openrouter/model-2",
      getEnvVar: () => "key",
      fetchImpl: scripted2.fetchImpl,
    });
    const res2 = await createAiOrchestrator({
      primary: adapter2,
      fallbackEnabled: false,
    }).callWithFallback(baseRequest);

    check(
      "K2. Failed attempt without tokens has undefined inputTokens (not fabricated 0)",
      res2.telemetry.attempts[0]?.inputTokens === undefined,
    );
    check(
      "K3. Failed attempt without tokens has undefined outputTokens (not fabricated 0)",
      res2.telemetry.attempts[0]?.outputTokens === undefined,
    );

    // No misattribution across fallback
    const primaryFetch = createScriptedFetch([
      {
        kind: "status",
        status: 500,
        body: {
          error: "p-fail",
          usage: { prompt_tokens: 30, completion_tokens: 0 },
        },
      },
    ]);
    const secondaryFetch = createScriptedFetch([
      {
        kind: "ok",
        body: openAiEnvelope(validAiResponseJson(), {
          prompt_tokens: 40,
          completion_tokens: 20,
        }),
      },
    ]);

    const p = createOpenRouterAdapter({
      model: "model-p",
      getEnvVar: () => "key-p",
      fetchImpl: primaryFetch.fetchImpl,
    });
    const s = createAtriaAdapter({
      model: "model-s",
      getEnvVar: () => "key-s",
      fetchImpl: secondaryFetch.fetchImpl,
    });
    const resFallback = await createAiOrchestrator({
      primary: p,
      secondary: s,
      fallbackEnabled: true,
    }).callWithFallback(baseRequest);

    check(
      "K4. Primary attempts preserve primary provider and tokens",
      resFallback.telemetry.attempts[0]?.provider === "openrouter" &&
        resFallback.telemetry.attempts[0]?.inputTokens === 30,
    );
    check(
      "K5. Secondary attempt preserves secondary provider and tokens",
      resFallback.telemetry.attempts[1]?.provider === "atria" &&
        resFallback.telemetry.attempts[1]?.inputTokens === 40 &&
        resFallback.telemetry.attempts[1]?.outputTokens === 20,
    );
    check(
      "K6. Secondary provider does not claim primary tokens (no misattribution)",
      resFallback.telemetry.attempts[1]?.inputTokens !== 70,
    );

    // K7: Reported cost parsing validation
    check(
      "K7. parseReportedCost parses valid numeric cost and rejects negative/NaN/non-numeric",
      parseReportedCost({ cost: 0.0025 }) === 0.0025 &&
        parseReportedCost({ total_cost: 0.015 }) === 0.015 &&
        parseReportedCost({ cost: -0.5 }) === undefined &&
        parseReportedCost({ cost: NaN }) === undefined &&
        parseReportedCost({ cost: Infinity }) === undefined &&
        parseReportedCost({ cost: "0.05" }) === undefined &&
        parseReportedCost(undefined) === undefined &&
        parseReportedCost(null) === undefined,
    );

    // K8: Cost completeness COMPLETE
    const costComplete = computeCostAggregation([
      { costUsd: 0.001 },
      { costUsd: 0.002 },
    ]);
    check(
      "K8. computeCostAggregation is COMPLETE when all attempts report cost",
      costComplete.costCompleteness === "COMPLETE" &&
        costComplete.totalCostUsd === 0.003 &&
        costComplete.knownCostSubtotalUsd === 0.003,
    );

    // K9: Cost completeness PARTIAL
    const costPartial = computeCostAggregation([
      { costUsd: 0.0015 },
      { costUsd: undefined },
    ]);
    check(
      "K9. computeCostAggregation is PARTIAL with knownCostSubtotalUsd when some attempts lack cost",
      costPartial.costCompleteness === "PARTIAL" &&
        costPartial.totalCostUsd === null &&
        costPartial.knownCostSubtotalUsd === 0.0015,
    );

    // K10: Cost completeness UNAVAILABLE
    const costUnavailable = computeCostAggregation([
      { costUsd: undefined },
      { costUsd: undefined },
    ]);
    check(
      "K10. computeCostAggregation is UNAVAILABLE when no attempt has cost",
      costUnavailable.costCompleteness === "UNAVAILABLE" &&
        costUnavailable.totalCostUsd === null &&
        costUnavailable.knownCostSubtotalUsd === null,
    );

    // K11: Malformed cost rejected in computeCostAggregation
    const costMalformed = computeCostAggregation([
      { costUsd: 0.005 },
      { costUsd: -0.01 as any },
      { costUsd: NaN as any },
    ]);
    check(
      "K11. Malformed cost values (negative, NaN) are excluded rather than corrupting aggregate",
      costMalformed.costCompleteness === "PARTIAL" &&
        costMalformed.totalCostUsd === null &&
        costMalformed.knownCostSubtotalUsd === 0.005,
    );
  }

  // -------------------------------------------------------------------------
  // L. Budget approval: finite positive numeric USD validation & emergency disable
  // -------------------------------------------------------------------------
  console.log(
    "\n--- Group L: FLOWPILOT_JEV_APPROVED_MONTHLY_BUDGET Validation ---",
  );
  {
    // Valid positive finite numeric USD values
    check(
      "L1. Accepts integer USD string '50'",
      parseApprovedMonthlyBudget("50") === 50,
    );
    check(
      "L2. Accepts decimal USD string '0.05'",
      parseApprovedMonthlyBudget("0.05") === 0.05,
    );
    check(
      "L3. Accepts decimal with surrounding whitespace '  100.50  '",
      parseApprovedMonthlyBudget("  100.50  ") === 100.5,
    );

    // Rejected invalid values
    check(
      "L4. Rejects undefined",
      parseApprovedMonthlyBudget(undefined) === null,
    );
    check("L5. Rejects empty string", parseApprovedMonthlyBudget("") === null);
    check(
      "L6. Rejects whitespace only",
      parseApprovedMonthlyBudget("   ") === null,
    );
    check("L7. Rejects zero '0'", parseApprovedMonthlyBudget("0") === null);
    check(
      "L8. Rejects negative amount '-25'",
      parseApprovedMonthlyBudget("-25") === null,
    );
    check(
      "L9. Rejects non-numeric string 'approved'",
      parseApprovedMonthlyBudget("approved") === null,
    );
    check(
      "L10. Rejects NaN string 'NaN'",
      parseApprovedMonthlyBudget("NaN") === null,
    );
    check(
      "L11. Rejects positive Infinity 'Infinity'",
      parseApprovedMonthlyBudget("Infinity") === null,
    );
    check(
      "L12. Rejects negative Infinity '-Infinity'",
      parseApprovedMonthlyBudget("-Infinity") === null,
    );

    // Production gating integration
    const prodEnv =
      (budget: string | undefined, killSwitch?: string) => (name: string) => {
        if (name === "NODE_ENV") return "production";
        if (name === "FLOWPILOT_JEV_APPROVED_MONTHLY_BUDGET") return budget;
        if (name === "FLOWPILOT_JEV_SEMANTIC_ENABLED") return killSwitch;
        return undefined;
      };

    check(
      "L13. Production with valid budget is approved",
      isTypeSafeJevPreferred(prodEnv("25.00")) === true,
    );
    check(
      "L14. Production with empty budget is blocked",
      isTypeSafeJevPreferred(prodEnv("")) === false,
    );
    check(
      "L15. Production with zero budget is blocked",
      isTypeSafeJevPreferred(prodEnv("0")) === false,
    );
    check(
      "L16. Production with negative budget is blocked",
      isTypeSafeJevPreferred(prodEnv("-10")) === false,
    );
    check(
      "L17. Production with non-numeric budget is blocked",
      isTypeSafeJevPreferred(prodEnv("yes")) === false,
    );

    // Emergency kill switch overrides any budget
    check(
      "L18. Emergency kill switch is engaged on 'false'",
      isSemanticJevEmergencyDisabled(prodEnv("100", "false")) === true,
    );
    check(
      "L19. Emergency kill switch is engaged on '0'",
      isSemanticJevEmergencyDisabled(prodEnv("100", "0")) === true,
    );
    check(
      "L20. Emergency kill switch overrides valid budget in production",
      isTypeSafeJevPreferred(prodEnv("100", "false")) === false,
    );
  }

  // -------------------------------------------------------------------------
  // M. Integration: full production engine receives correct aggregate for retry+fallback
  // -------------------------------------------------------------------------
  console.log(
    "\n--- Group M: Full Engine Pipeline Integration (Retry + Fallback Aggregate) ---",
  );
  {
    const primaryFetch = createScriptedFetch([
      { kind: "abort" },
      { kind: "abort" },
    ]);
    const secondaryFetch = createScriptedFetch([
      {
        kind: "ok",
        body: openAiEnvelope(
          validAiResponseJson({ content: "نحن في خدمتكم من ٩ إلى ٥" }),
          { prompt_tokens: 30, completion_tokens: 15, cost: 0.0025 } as any,
        ),
      },
    ]);

    const primaryRaw = createOpenRouterAdapter({
      model: "deepseek/deepseek-chat",
      getEnvVar: () => "key-1",
      fetchImpl: primaryFetch.fetchImpl,
    });
    const primaryControlled = createConversationControl({
      provider: primaryRaw,
      settings: {
        conversationControl: {
          enabled: true,
          maxAttempts: 2,
          retryEnabled: true,
        },
      },
    });
    const secondaryAdapter = createAtriaAdapter({
      model: "atria-1",
      getEnvVar: () => "key-2",
      fetchImpl: secondaryFetch.fetchImpl,
    });

    const testAi = createLlmConversationAi({
      primary: primaryControlled,
      secondary: secondaryAdapter,
      fallbackEnabled: true,
    });

    const emittedEvidence: TurnEvidence[] = [];
    const recordedUsage: Record<string, unknown>[] = [];

    const harness = createPlaygroundHarness({
      channel: "WHATSAPP",
      todayRef: "2026-10-20",
    });
    harness.deps.ai = testAi;
    harness.deps.turnTelemetry = {
      emit: (ev: TurnEvidence) => {
        emittedEvidence.push(ev);
      },
    };
    harness.deps.usageRepository = {
      record: async (u) => {
        recordedUsage.push(u as unknown as Record<string, unknown>);
        return u as unknown as UsageRecord;
      },
    };

    const res = await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber ?? "+201000000000",
      from: "+201234567890",
      text: "ما هي ساعات العمل؟",
      receivedAt: new Date().toISOString(),
      externalId: "ext-msg-core04a",
    });

    if (!res.ok) {
      console.log("M result failed:", res);
    }

    check(
      "M1. receiveInboundMessage returns success",
      res.ok === true && !res.duplicate,
    );
    check(
      "M2. Exactly 2 primary calls dispatched",
      primaryFetch.getCallCount() === 2,
    );
    check(
      "M3. Exactly 1 secondary call dispatched",
      secondaryFetch.getCallCount() === 1,
    );
    check(
      "M4. Emitted TurnEvidence receives providerAttempts === 3 (NOT 2 or 1)",
      emittedEvidence.length > 0 && emittedEvidence[0]?.providerAttempts === 3,
    );
    check(
      "M5. TurnEvidence providerStatus is SUCCESS",
      emittedEvidence[0]?.providerStatus === "SUCCESS",
    );
    check(
      "M6. AI_TURN usage record recorded with secondary provider and tokens",
      recordedUsage.some(
        (u) =>
          u.kind === "AI_TURN" &&
          u.provider === "atria" &&
          u.status === "SUCCESS",
      ),
    );
    check(
      "M7. TurnEvidence preserves bounded executionAttempts for all 3 attempts",
      emittedEvidence[0]?.executionAttempts?.length === 3,
    );
    check(
      "M8. ExecutionAttempts preserves attempt-level provider attribution (primary=openrouter, secondary=atria)",
      emittedEvidence[0]?.executionAttempts?.[0]?.provider === "openrouter" &&
        emittedEvidence[0]?.executionAttempts?.[1]?.provider === "openrouter" &&
        emittedEvidence[0]?.executionAttempts?.[2]?.provider === "atria",
    );
    check(
      "M9. ExecutionAttempts captures per-attempt reported cost on successful attempt",
      emittedEvidence[0]?.executionAttempts?.[2]?.costUsd === 0.0025 &&
        emittedEvidence[0]?.executionAttempts?.[2]?.costSource ===
          "PROVIDER_REPORTED",
    );
    check(
      "M10. TurnEvidence costCompleteness is PARTIAL and knownCostSubtotalUsd is 0.0025",
      emittedEvidence[0]?.costCompleteness === "PARTIAL" &&
        emittedEvidence[0]?.knownCostSubtotalUsd === 0.0025 &&
        emittedEvidence[0]?.totalCostUsd === null,
    );
  }

  // -------------------------------------------------------------------------
  // N. Mechanical Selection & Positive Control Integration
  // -------------------------------------------------------------------------
  console.log(
    "\n--- Group N: Mechanical Selection & Positive Control Integration ---",
  );
  {
    let wireCalls = 0;
    const testFetch = createScriptedFetch([
      {
        kind: "ok",
        body: openAiEnvelope(
          validAiResponseJson({ content: "نعم متوفر لدينا كشف أسنان" }),
        ),
      },
    ]);
    const monitoredFetch: typeof fetch = async (info, init) => {
      wireCalls++;
      return testFetch.fetchImpl(info, init);
    };

    const primaryAdapter = createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar: () => "valid-key",
      fetchImpl: monitoredFetch,
    });
    const testAi = createLlmConversationAi({
      primary: primaryAdapter,
      fallbackEnabled: false,
    });

    const emittedEvidence: TurnEvidence[] = [];
    const harness = createPlaygroundHarness({
      channel: "WHATSAPP",
      todayRef: "2026-10-20",
    });
    harness.deps.ai = testAi;
    harness.deps.turnTelemetry = {
      emit: (ev: TurnEvidence) => {
        emittedEvidence.push(ev);
      },
    };

    // 1. Mechanical Selection: set up an active offer in conversation state for harness.conversation
    const services = await harness.deps.serviceRepository.listByBusiness(
      harness.business.id,
    );
    const nowMech = new Date();
    const testOffer = {
      id: "off-mech-1",
      token: "off00001",
      kind: "SLOT" as const,
      businessId: harness.business.id,
      conversationId: harness.conversation.id,
      serviceId: services[0]!.id,
      serviceName: services[0]!.name,
      serviceSource: "CUSTOMER" as const,
      date: "2026-10-25",
      providerId: null,
      followUpRequestId: null,
      shownCount: 1,
      options: [
        {
          index: 1,
          providerId: "prov-1",
          displayName: "د. سارة",
          startAt: "2026-10-25T10:00",
          endAt: "2026-10-25T10:30",
        },
      ],
      issuedAt: nowMech.toISOString(),
      expiresAt: new Date(nowMech.getTime() + 3600000).toISOString(),
      status: "ACTIVE" as const,
    };
    const st = {
      ...emptyConversationState(),
      offer: testOffer as any,
    };
    const persisted = dehydrateConversationState(st);
    await harness.stateStore.save(
      harness.business.id,
      harness.conversation.id,
      null,
      persisted,
    );

    // Customer sends numeric choice "1"
    const mechRes = await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber ?? "+201000000000",
      from: harness.customer.phone,
      text: "1",
      receivedAt: nowMech.toISOString(),
      externalId: "ext-msg-mech-01",
    });

    check(
      "N1. Mechanical selection (/start or numeric choice) succeeds",
      mechRes.ok === true && !mechRes.duplicate,
    );
    check(
      "N2. Mechanical selection dispatched strictly ZERO HTTP requests over wire",
      wireCalls === 0,
    );
    check(
      "N3. Mechanical selection emitted TurnEvidence with providerAttempts === 0 (not null or 1)",
      emittedEvidence.length > 0 && emittedEvidence[0]?.providerAttempts === 0,
    );
    check(
      "N4. Mechanical selection TurnEvidence providerStatus is NOT_CALLED",
      emittedEvidence[0]?.providerStatus === "NOT_CALLED",
    );
    check(
      "N5. Mechanical selection shadow did not run (shadowModelCallCount is null)",
      emittedEvidence[0]?.shadowModelCallCount === null,
    );

    // 2. Positive Control: conversational turn that DOES require model request
    const posRes = await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber ?? "+201000000000",
      from: harness.customer.phone,
      text: "هل عندكم كشف أسنان اليوم؟",
      receivedAt: new Date().toISOString(),
      externalId: "ext-msg-positive-ctrl",
    });

    check(
      "N6. Positive control conversational turn succeeds",
      posRes.ok === true && !posRes.duplicate,
    );
    check(
      "N7. Positive control dispatched exactly 1 wire HTTP request (proving harness operates)",
      wireCalls === 1,
    );
    check(
      "N8. Positive control emitted TurnEvidence with providerAttempts === 1 and SUCCESS",
      emittedEvidence.length > 1 &&
        emittedEvidence[1]?.providerAttempts === 1 &&
        emittedEvidence[1]?.providerStatus === "SUCCESS",
    );
  }

  // -------------------------------------------------------------------------
  // O. Post-AI Early Returns & Offer Conflict Evidence Preservation
  // -------------------------------------------------------------------------
  console.log(
    "\n--- Group O: Post-AI Early Returns & Offer Conflict Evidence Preservation ---",
  );
  {
    // Test A: SERVICE offer conflict after AI
    const emittedEvidenceA: TurnEvidence[] = [];
    let wireCallsA = 0;
    const scriptedA = createScriptedFetch([
      {
        kind: "ok",
        body: openAiEnvelope(
          validAiResponseJson({
            intent: "BOOKING",
            action: "reply",
            content: "أي خدمة تحب تحجزها؟",
            extraction: {
              service: null,
              provider: null,
              date: "2026-10-21",
              timePreference: null,
            },
            safetyAssessment: "safe",
            factUpdates: [
              { key: "date", operation: "set", value: "2026-10-21" },
            ],
          }),
        ),
      },
    ]);
    const monitoredFetchA: typeof fetch = async (info, init) => {
      wireCallsA++;
      return scriptedA.fetchImpl(info, init);
    };
    const adapterA = createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar: () => "valid-key",
      fetchImpl: monitoredFetchA,
    });
    const harnessA = createPlaygroundHarness({
      channel: "TELEGRAM",
      todayRef: "2026-10-20",
    });
    harnessA.deps.ai = createLlmConversationAi({
      primary: adapterA,
      fallbackEnabled: false,
    });
    harnessA.deps.turnTelemetry = {
      emit: (ev: TurnEvidence) => {
        emittedEvidenceA.push(ev);
      },
    };
    const origSaveA = harnessA.stateStore.save.bind(harnessA.stateStore);
    harnessA.stateStore.save = async (bId, cId, expRev, st: any) => {
      if (st?.offer?.kind === "SERVICE") {
        return { status: "conflict" as const };
      }
      return origSaveA(bId, cId, expRev, st);
    };

    const fromHandleA = harnessA.customer.phone.replace(/^tg:/, "");
    const resA = await receiveInboundMessage(harnessA.deps, {
      to: harnessA.business.whatsappNumber ?? "+201000000000",
      from: fromHandleA,
      text: "عايز أحجز ميعاد مع دكتور بكرة",
      receivedAt: new Date("2026-10-20T08:00:00.000Z").toISOString(),
      externalId: "ext-cas-service",
    });

    const lastOutboundA =
      harnessA.deliveredOutbound[harnessA.deliveredOutbound.length - 1];

    check(
      "O1. SERVICE offer CAS conflict returns success status with safe retry message",
      resA.ok === true &&
        lastOutboundA?.body ===
          "حدث تعارض مؤقت أثناء معالجة طلبك، يرجى إعادة المحاولة.",
    );
    check(
      "O2. SERVICE offer CAS conflict suppressed Telegram replyMarkup",
      lastOutboundA?.replyMarkup == null,
    );
    check(
      "O3. SERVICE offer CAS conflict created zero appointments",
      harnessA.appointments.length === 0,
    );
    check(
      "O4. SERVICE offer CAS conflict matches physical HTTP calls (1 wire call)",
      wireCallsA === 1,
    );
    check(
      "O5. SERVICE offer CAS conflict preserves TurnEvidence providerAttempts === 1 and modelCallCount === 1",
      emittedEvidenceA.length === 1 &&
        emittedEvidenceA[0]?.providerAttempts === 1 &&
        (resA as any).observability?.modelCallCount === 1,
    );
    check(
      "O6. SERVICE offer CAS conflict TurnEvidence providerStatus is SUCCESS (not NOT_CALLED)",
      emittedEvidenceA[0]?.providerStatus === "SUCCESS",
    );
    check(
      "O7. SERVICE offer CAS conflict TurnEvidence preserves executionAttempts and costCompleteness",
      emittedEvidenceA[0]?.executionAttempts?.length === 1 &&
        emittedEvidenceA[0]?.costCompleteness !== undefined,
    );

    // Test B: DATE offer conflict after AI
    const emittedEvidenceB: TurnEvidence[] = [];
    let wireCallsB = 0;
    const scriptedB = createScriptedFetch([
      {
        kind: "ok",
        body: openAiEnvelope(
          validAiResponseJson({
            intent: "BOOKING",
            action: "reply",
            content: "أي يوم يناسبك لحجز كشف أسنان؟",
            extraction: {
              service: "كشف أسنان",
              provider: null,
              date: null,
              timePreference: null,
            },
            safetyAssessment: "safe",
            factUpdates: [
              { key: "service", operation: "set", value: "كشف أسنان" },
            ],
          }),
        ),
      },
    ]);
    const monitoredFetchB: typeof fetch = async (info, init) => {
      wireCallsB++;
      return scriptedB.fetchImpl(info, init);
    };
    const adapterB = createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar: () => "valid-key",
      fetchImpl: monitoredFetchB,
    });
    const harnessB = createPlaygroundHarness({
      channel: "TELEGRAM",
      todayRef: "2026-10-20",
    });
    harnessB.deps.ai = createLlmConversationAi({
      primary: adapterB,
      fallbackEnabled: false,
    });
    harnessB.deps.turnTelemetry = {
      emit: (ev: TurnEvidence) => {
        emittedEvidenceB.push(ev);
      },
    };
    const origSaveB = harnessB.stateStore.save.bind(harnessB.stateStore);
    harnessB.stateStore.save = async (bId, cId, expRev, st: any) => {
      if (st?.offer?.kind === "DATE") {
        return { status: "conflict" as const };
      }
      return origSaveB(bId, cId, expRev, st);
    };

    const fromHandleB = harnessB.customer.phone.replace(/^tg:/, "");
    const resB = await receiveInboundMessage(harnessB.deps, {
      to: harnessB.business.whatsappNumber ?? "+201000000000",
      from: fromHandleB,
      text: "عايز كشف أسنان",
      receivedAt: new Date().toISOString(),
      externalId: "ext-cas-date",
    });

    const lastOutboundB =
      harnessB.deliveredOutbound[harnessB.deliveredOutbound.length - 1];

    check(
      "O8. DATE offer CAS conflict returns safe retry message",
      resB.ok === true &&
        lastOutboundB?.body ===
          "حدث تعارض مؤقت أثناء معالجة طلبك، يرجى إعادة المحاولة.",
    );
    check(
      "O9. DATE offer CAS conflict suppressed Telegram replyMarkup",
      lastOutboundB?.replyMarkup == null,
    );
    check(
      "O10. DATE offer CAS conflict created zero appointments",
      harnessB.appointments.length === 0,
    );
    check(
      "O11. DATE offer CAS conflict matches physical HTTP calls (1 wire call)",
      wireCallsB === 1,
    );
    check(
      "O12. DATE offer CAS conflict preserves TurnEvidence providerAttempts === 1 and modelCallCount === 1",
      emittedEvidenceB.length === 1 &&
        emittedEvidenceB[0]?.providerAttempts === 1 &&
        (resB as any).observability?.modelCallCount === 1,
    );
    check(
      "O13. DATE offer CAS conflict TurnEvidence providerStatus is SUCCESS (not NOT_CALLED)",
      emittedEvidenceB[0]?.providerStatus === "SUCCESS",
    );
    check(
      "O14. DATE offer CAS conflict TurnEvidence preserves executionAttempts and costCompleteness",
      emittedEvidenceB[0]?.executionAttempts?.length === 1 &&
        emittedEvidenceB[0]?.costCompleteness !== undefined,
    );

    // Test C: SLOT offer conflict after AI
    const emittedEvidenceC: TurnEvidence[] = [];
    let wireCallsC = 0;
    const scriptedC = createScriptedFetch([
      {
        kind: "ok",
        body: openAiEnvelope(
          validAiResponseJson({
            intent: "BOOKING",
            action: "reply",
            content: "المواعيد المتاحة:",
            extraction: {
              service: "كشف أسنان",
              provider: null,
              date: "2026-10-21",
              timePreference: null,
            },
            safetyAssessment: "safe",
            factUpdates: [
              { key: "service", operation: "set", value: "كشف أسنان" },
              { key: "date", operation: "set", value: "2026-10-21" },
            ],
          }),
        ),
      },
    ]);
    const monitoredFetchC: typeof fetch = async (info, init) => {
      wireCallsC++;
      return scriptedC.fetchImpl(info, init);
    };
    const adapterC = createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar: () => "valid-key",
      fetchImpl: monitoredFetchC,
    });
    const harnessC = createPlaygroundHarness({
      channel: "TELEGRAM",
      todayRef: "2026-10-20",
    });
    harnessC.deps.ai = createLlmConversationAi({
      primary: adapterC,
      fallbackEnabled: false,
    });
    harnessC.deps.turnTelemetry = {
      emit: (ev: TurnEvidence) => {
        emittedEvidenceC.push(ev);
      },
    };
    const origSaveC = harnessC.stateStore.save.bind(harnessC.stateStore);
    harnessC.stateStore.save = async (bId, cId, expRev, st: any) => {
      if (st?.offer?.kind === "SLOT") {
        return { status: "conflict" as const };
      }
      return origSaveC(bId, cId, expRev, st);
    };

    const fromHandleC = harnessC.customer.phone.replace(/^tg:/, "");
    const resC = await receiveInboundMessage(harnessC.deps, {
      to: harnessC.business.whatsappNumber ?? "+201000000000",
      from: fromHandleC,
      text: "عايز كشف أسنان يوم الأربعاء",
      receivedAt: new Date("2026-10-20T08:00:00.000Z").toISOString(),
      externalId: "ext-cas-slot",
    });

    const lastOutboundC =
      harnessC.deliveredOutbound[harnessC.deliveredOutbound.length - 1];

    check(
      "O15. SLOT offer CAS conflict returns safe retry message",
      resC.ok === true &&
        lastOutboundC?.body ===
          "حدث تعارض مؤقت أثناء معالجة طلبك، يرجى إعادة المحاولة.",
    );
    check(
      "O16. SLOT offer CAS conflict suppressed Telegram replyMarkup",
      lastOutboundC?.replyMarkup == null,
    );
    check(
      "O17. SLOT offer CAS conflict created zero appointments",
      harnessC.appointments.length === 0,
    );
    check(
      "O18. SLOT offer CAS conflict matches physical HTTP calls (1 wire call)",
      wireCallsC === 1,
    );
    check(
      "O19. SLOT offer CAS conflict preserves TurnEvidence providerAttempts === 1 and modelCallCount === 1",
      emittedEvidenceC.length === 1 &&
        emittedEvidenceC[0]?.providerAttempts === 1 &&
        (resC as any).observability?.modelCallCount === 1,
    );
    check(
      "O20. SLOT offer CAS conflict TurnEvidence providerStatus is SUCCESS (not NOT_CALLED)",
      emittedEvidenceC[0]?.providerStatus === "SUCCESS",
    );
    check(
      "O21. SLOT offer CAS conflict TurnEvidence preserves executionAttempts and costCompleteness",
      emittedEvidenceC[0]?.executionAttempts?.length === 1 &&
        emittedEvidenceC[0]?.costCompleteness !== undefined,
    );
  }

  // -------------------------------------------------------------------------
  // P. Multi-Turn Stale-Telemetry Isolation (Model Turn 1 -> Mechanical Turn 2)
  // -------------------------------------------------------------------------
  console.log(
    "\n--- Group P: Multi-Turn Stale-Telemetry Isolation (Model Turn 1 -> Mechanical Turn 2) ---",
  );
  {
    const emittedEvidenceP: TurnEvidence[] = [];
    let wireCallsP = 0;
    const scriptedP = createScriptedFetch([
      {
        kind: "ok",
        body: openAiEnvelope(
          validAiResponseJson({ content: "نعم متوفر كشف أسنان" }),
        ),
      },
    ]);
    const monitoredFetchP: typeof fetch = async (info, init) => {
      wireCallsP++;
      return scriptedP.fetchImpl(info, init);
    };
    const adapterP = createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar: () => "valid-key",
      fetchImpl: monitoredFetchP,
    });
    const testAiP = createLlmConversationAi({
      primary: adapterP,
      fallbackEnabled: false,
    });
    const harnessP = createPlaygroundHarness({
      channel: "WHATSAPP",
      todayRef: "2026-10-20",
    });
    harnessP.deps.ai = testAiP;
    harnessP.deps.turnTelemetry = {
      emit: (ev: TurnEvidence) => {
        emittedEvidenceP.push(ev);
      },
    };

    // Turn 1: Model conversational turn
    const turn1Res = await receiveInboundMessage(harnessP.deps, {
      to: harnessP.business.whatsappNumber ?? "+201000000000",
      from: harnessP.customer.phone,
      text: "هل عندكم كشف أسنان؟",
      receivedAt: new Date().toISOString(),
      externalId: "ext-msg-p-turn1",
    });

    check("P1. Model Turn 1 succeeds", turn1Res.ok === true);
    check("P2. Model Turn 1 invoked 1 wire HTTP request", wireCallsP === 1);
    check(
      "P3. Model Turn 1 emitted TurnEvidence with providerAttempts === 1 and SUCCESS",
      emittedEvidenceP.length === 1 &&
        emittedEvidenceP[0]?.providerAttempts === 1 &&
        emittedEvidenceP[0]?.providerStatus === "SUCCESS",
    );

    // Pre-seed an active offer in the same conversation state
    const servicesP = await harnessP.deps.serviceRepository.listByBusiness(
      harnessP.business.id,
    );
    const nowP = new Date();
    const testOfferP = {
      id: "off-p-1",
      token: "off00002",
      kind: "SLOT" as const,
      businessId: harnessP.business.id,
      conversationId: harnessP.conversation.id,
      serviceId: servicesP[0]!.id,
      serviceName: servicesP[0]!.name,
      serviceSource: "CUSTOMER" as const,
      date: "2026-10-25",
      providerId: null,
      followUpRequestId: null,
      shownCount: 1,
      options: [
        {
          index: 1,
          providerId: "prov-1",
          displayName: "د. سارة",
          startAt: "2026-10-25T10:00",
          endAt: "2026-10-25T10:30",
        },
      ],
      issuedAt: nowP.toISOString(),
      expiresAt: new Date(nowP.getTime() + 3600000).toISOString(),
      status: "ACTIVE" as const,
    };
    const loadedStateP = await harnessP.stateStore.load(
      harnessP.business.id,
      harnessP.conversation.id,
    );
    await harnessP.stateStore.save(
      harnessP.business.id,
      harnessP.conversation.id,
      loadedStateP?.revision ?? null,
      dehydrateConversationState({
        ...emptyConversationState(),
        offer: testOfferP as any,
      }),
    );

    // Turn 2: Mechanical selection "1" on the SAME harness
    const turn2Res = await receiveInboundMessage(harnessP.deps, {
      to: harnessP.business.whatsappNumber ?? "+201000000000",
      from: harnessP.customer.phone,
      text: "1",
      receivedAt: new Date(nowP.getTime() + 5000).toISOString(),
      externalId: "ext-msg-p-turn2",
    });

    check("P4. Mechanical Turn 2 succeeds", turn2Res.ok === true);
    check(
      "P5. Mechanical Turn 2 dispatched ZERO new wire calls (total wireCalls still 1)",
      wireCallsP === 1,
    );
    check(
      "P6. Mechanical Turn 2 emitted TurnEvidence with providerAttempts === 0 and NOT_CALLED",
      emittedEvidenceP.length === 2 &&
        emittedEvidenceP[1]?.providerAttempts === 0 &&
        emittedEvidenceP[1]?.providerStatus === "NOT_CALLED",
    );
    check(
      "P7. Mechanical Turn 2 routingDecision is DETERMINISTIC_BYPASS",
      emittedEvidenceP[1]?.routingDecision === "DETERMINISTIC_BYPASS",
    );
    check(
      "P8. Mechanical Turn 2 has modelCallCount === 0",
      (turn2Res as any).observability?.modelCallCount === 0,
    );
    check(
      "P9. Mechanical Turn 2 has zero contamination from Turn 1 (no executionAttempts from previous turn)",
      emittedEvidenceP[1]?.executionAttempts == null ||
        emittedEvidenceP[1]?.executionAttempts?.length === 0,
    );
  }

  // -------------------------------------------------------------------------
  // Q. Engine-Level Integration for JEV-Only & Unknown Physical Count
  // -------------------------------------------------------------------------
  console.log(
    "\n--- Group Q: Engine-Level Integration for JEV-Only & Unknown Physical Count ---",
  );
  {
    // Q1-Q5: Real engine receiveInboundMessage with JEV decision:
    // JEV API makes 1 call, LLM makes 0 calls -> emitted TurnEvidence providerAttempts === 1, modelCallCount === 1
    const emittedEvidenceQ1: TurnEvidence[] = [];
    let jevCallsQ = 0;
    let llmCallsQ = 0;
    const jevFetchQ = createScriptedFetch([
      { kind: "ok", body: jevDecisionsEnvelope() },
    ]);
    const monitoredJevFetch: typeof fetch = async (info, init) => {
      jevCallsQ++;
      return jevFetchQ.fetchImpl(info, init);
    };
    const llmFetchQ = createScriptedFetch([
      { kind: "ok", body: openAiEnvelope(validAiResponseJson()) },
    ]);
    const monitoredLlmFetch: typeof fetch = async (info, init) => {
      llmCallsQ++;
      return llmFetchQ.fetchImpl(info, init);
    };

    const jevProviderQ = createJevDecisionsProvider({
      getEnvVar: () => "valid-key",
      fetchImpl: monitoredJevFetch,
    });
    const decisionStrategyQ = createSemanticJevStrategy({
      provider: jevProviderQ,
      enabled: true,
    });
    const llmAdapterQ = createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar: () => "valid-key",
      fetchImpl: monitoredLlmFetch,
    });

    const harnessQ1 = createPlaygroundHarness({
      channel: "WHATSAPP",
      todayRef: "2026-10-20",
      requiredSemanticCapability: null,
    });
    harnessQ1.deps.ai = createLlmConversationAi({
      primary: llmAdapterQ,
      decisionStrategy: decisionStrategyQ,
      fallbackEnabled: false,
    });
    harnessQ1.deps.turnTelemetry = {
      emit: (ev: TurnEvidence) => {
        emittedEvidenceQ1.push(ev);
      },
    };

    const resQ1 = await receiveInboundMessage(harnessQ1.deps, {
      to: harnessQ1.business.whatsappNumber ?? "+201000000000",
      from: harnessQ1.customer.phone,
      text: "عايز أحجز كشف أسنان",
      receivedAt: new Date().toISOString(),
      externalId: "ext-msg-q1",
    });

    check("Q1. JEV-decision engine turn succeeds", resQ1.ok === true);
    check(
      "Q2. JEV Decisions API dispatched exactly 1 physical HTTP request",
      jevCallsQ === 1,
    );
    check(
      "Q3. Serving LLM dispatched strictly 0 requests after spent JEV",
      llmCallsQ === 0,
    );
    check(
      "Q4. Emitted TurnEvidence providerAttempts === 1 and modelCallCount === 1 (no double counting)",
      emittedEvidenceQ1.length === 1 &&
        emittedEvidenceQ1[0]?.providerAttempts === 1 &&
        (resQ1 as any).observability?.modelCallCount === 1,
    );
    check(
      "Q5. Emitted TurnEvidence provider is jev-deterministic",
      emittedEvidenceQ1[0]?.provider === "jev-deterministic",
    );

    // Q6-Q8: Real engine receiveInboundMessage with custom adapter reporting null physical attempts
    const emittedEvidenceQ2: TurnEvidence[] = [];
    const customNullAdapter: AiProviderAdapter = {
      providerId: "openrouter",
      model: "legacy-model",
      secretRef: "CUSTOM_KEY",
      async call() {
        return {
          ok: true,
          provider: "openrouter",
          model: "legacy-model",
          latencyMs: 20,
          response: JSON.parse(validAiResponseJson()),
        };
      },
    };
    const harnessQ2 = createPlaygroundHarness({
      channel: "WHATSAPP",
      todayRef: "2026-10-20",
    });
    harnessQ2.deps.ai = createLlmConversationAi({
      primary: customNullAdapter,
      fallbackEnabled: false,
    });
    harnessQ2.deps.turnTelemetry = {
      emit: (ev: TurnEvidence) => {
        emittedEvidenceQ2.push(ev);
      },
    };

    const resQ2 = await receiveInboundMessage(harnessQ2.deps, {
      to: harnessQ2.business.whatsappNumber ?? "+201000000000",
      from: harnessQ2.customer.phone,
      text: "ما هي مواعيد العمل؟",
      receivedAt: new Date().toISOString(),
      externalId: "ext-msg-q2",
    });

    check(
      "Q6. Unknown physical telemetry engine turn succeeds",
      resQ2.ok === true,
    );
    check(
      "Q7. Emitted TurnEvidence providerAttempts is strictly null (not 0 or 1)",
      emittedEvidenceQ2.length === 1 &&
        emittedEvidenceQ2[0]?.providerAttempts === null,
    );
    check(
      "Q8. Emitted TurnEvidence modelCallCount derives honestly as 1",
      (resQ2 as any).observability?.modelCallCount === 1,
    );

    // Q9-Q11: Real engine receiveInboundMessage with mixed known and unknown attempts
    const emittedEvidenceQ3: TurnEvidence[] = [];
    const pFailFetch = createScriptedFetch([
      { kind: "status", status: 500, body: { error: "down" } },
    ]);
    const pFailAdapter = createOpenRouterAdapter({
      model: "openrouter/fail",
      getEnvVar: () => "k",
      fetchImpl: pFailFetch.fetchImpl,
    });
    const sUnknownAdapter: AiProviderAdapter = {
      providerId: "atria",
      model: "custom-s",
      secretRef: "CUSTOM_KEY",
      async call() {
        return {
          ok: true,
          provider: "atria",
          model: "custom-s",
          latencyMs: 15,
          response: JSON.parse(validAiResponseJson()),
        };
      },
    };
    const harnessQ3 = createPlaygroundHarness({
      channel: "WHATSAPP",
      todayRef: "2026-10-20",
    });
    harnessQ3.deps.ai = createLlmConversationAi({
      primary: pFailAdapter,
      secondary: sUnknownAdapter,
      fallbackEnabled: true,
    });
    harnessQ3.deps.turnTelemetry = {
      emit: (ev: TurnEvidence) => {
        emittedEvidenceQ3.push(ev);
      },
    };

    const resQ3 = await receiveInboundMessage(harnessQ3.deps, {
      to: harnessQ3.business.whatsappNumber ?? "+201000000000",
      from: harnessQ3.customer.phone,
      text: "ما هي مواعيد العمل لديكم؟",
      receivedAt: new Date().toISOString(),
      externalId: "ext-msg-q3",
    });

    check(
      "Q9. Mixed known/unknown fallback engine turn succeeds",
      resQ3.ok === true,
    );
    check(
      "Q10. Emitted TurnEvidence providerAttempts aggregates strictly to null (no fabricated total)",
      emittedEvidenceQ3.length === 1 &&
        emittedEvidenceQ3[0]?.providerAttempts === null,
    );
    check(
      "Q11. Emitted TurnEvidence modelCallCount derives honestly as 1",
      (resQ3 as any).observability?.modelCallCount === 1,
    );
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log("\n========================================================");
  console.log(
    `TOTAL CHECKS: ${results.length} | PASSED: ${passed} | FAILED: ${failed}`,
  );
  console.log("========================================================\n");

  if (failed > 0) {
    process.exit(1);
  }
}

runSuite().catch((err) => {
  console.error("FATAL in CORE-04A acceptance suite:", err);
  process.exit(1);
});
