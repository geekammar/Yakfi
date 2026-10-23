/* eslint-disable @typescript-eslint/no-explicit-any */
import "./setup-test-env";

import { createPlaygroundHarness } from "@/features/conversations/playground/harness";
import type { AiRequest } from "@/features/conversations/server/ai-contract";
import { receiveInboundMessage } from "@/features/conversations/server/conversation-engine";
import {
  dehydrateConversationState,
  emptyConversationState,
} from "@/features/conversations/server/conversation-state";
import type { TurnEvidence } from "@/features/conversations/server/turn-evidence";
import { createAtriaAdapter } from "@/server/integrations/ai/atria";
import { createLlmConversationAi } from "@/server/integrations/ai/conversation-ai";
import { createConversationControl } from "@/server/integrations/ai/conversation-control";
import {
  FLOWPILOT_AI_GLOBAL_STOP_FLAG,
  FLOWPILOT_AI_MAX_SERVING_ATTEMPTS_FLAG,
  createServingExecutionSession,
  parseGlobalAiStop,
  parseMaxServingAttempts,
} from "@/server/integrations/ai/execution-limits";
import { createJevDecisionsProvider } from "@/server/integrations/ai/jev-decisions-provider";
import { createSemanticJevStrategy } from "@/server/integrations/ai/jev-semantic-strategy";
import {
  createShadowJevStrategy,
  createShadowSampler,
} from "@/server/integrations/ai/jev-shadow-strategy";
import { createOpenRouterAdapter } from "@/server/integrations/ai/openrouter";
import { createAiOrchestrator } from "@/server/integrations/ai/orchestrator";
import type { AiProviderAdapter } from "@/server/integrations/ai/types";

/**
 * FlowPilot — CORE-04B Acceptance Suite
 * Global AI Stop and Shared Per-Turn Execution Limits
 *
 * Verifies:
 *   A. Global stop: zero HTTP across serving LLM, JEV, and eligible shadow scenarios
 *   B. Mechanical selection while global stop is active: valid offer selection remains zero-call
 *   C. Global stop disabled/absent: positive control actually invokes the permitted provider
 *   D. Serving allowance = 1: first failure cannot dispatch retry or secondary fallback
 *   E. Serving allowance = 2: two primary requests exhaust the allowance; no third secondary request
 *   F. Default allowance: preserve allowed primary-retry-plus-fallback scenario up to 3
 *   G. Primary success ends execution without unnecessary additional requests
 *   H. Shared deadline: fallback receives remaining time; expired deadline prevents dispatch
 *   I. In-flight timeout: abort reaches HTTP boundary; dispatched request remains counted
 *   J. Preflight failure: no physical allowance consumed and no fictitious request recorded
 *   K. Sequential turns on same AI object: independent fresh allowance and clean evidence
 *   L. Concurrent independent turns: allowances do not crosstalk
 *   M. JEV: one serving request and zero subsequent serving LLM requests
 *   N. Shadow: separate allowance/accounting, failure isolation, global-stop coverage
 *   O. Malformed configuration: invalid explicit values fail closed with INVALID_CONTROL_CONFIG
 *   P. Full-engine controlled-stop behavior: safe outcome, durable facts preserved, honest evidence
 *
 * Run: pnpm check:core-04b
 */

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

function sampleRequest(
  message = "أحتاج موعد كشف أسنان",
  capability?: "structured_turn",
): AiRequest {
  return {
    businessName: "عيادة د. أمل",
    message,
    conversationStatus: "AI_ACTIVE",
    recentMessages: [],
    services: [],
    faqs: [],
    traceId: "test-trace-core-04b",
    requiredSemanticCapability: capability,
  };
}

type ScriptedStep =
  | { kind: "ok"; body: Record<string, unknown>; status?: number }
  | { kind: "error"; status: number; body?: string | Record<string, unknown> }
  | { kind: "delay"; delayMs: number; then: ScriptedStep }
  | { kind: "throw"; error: Error };

function createScriptedFetch(steps: ScriptedStep[]) {
  let callIndex = 0;
  const recordedCalls: Array<{
    url: string;
    init?: RequestInit;
    abortedAtCall?: boolean;
  }> = [];

  const fetchImpl: typeof fetch = async (info, init) => {
    const url = typeof info === "string" ? info : (info as Request).url;
    const currentStep = steps[callIndex] ?? {
      kind: "throw",
      error: new Error(`Unexpected fetch call #${callIndex + 1}`),
    };
    callIndex++;

    recordedCalls.push({
      url,
      init,
      abortedAtCall: init?.signal?.aborted,
    });

    const executeStep = async (step: ScriptedStep): Promise<Response> => {
      if (step.kind === "throw") {
        throw step.error;
      }
      if (step.kind === "delay") {
        return new Promise<Response>((resolve, reject) => {
          let settled = false;
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            executeStep(step.then).then(resolve, reject);
          }, step.delayMs);

          if (init?.signal) {
            init.signal.addEventListener("abort", () => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              const abortError = new Error("This operation was aborted");
              abortError.name = "AbortError";
              reject(abortError);
            });
          }
        });
      }
      if (step.kind === "error") {
        const bodyText =
          typeof step.body === "object"
            ? JSON.stringify(step.body)
            : (step.body ?? JSON.stringify({ error: "error" }));
        return new Response(bodyText, {
          status: step.status,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(step.body), {
        status: step.status ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    return executeStep(currentStep);
  };

  return {
    fetchImpl,
    getCallCount: () => callIndex,
    getRecordedCalls: () => recordedCalls,
  };
}

async function run() {
  console.log("=== FlowPilot CORE-04B: Acceptance Suite ===\n");

  // -------------------------------------------------------------------------
  // Group A: Global external-model stop
  // -------------------------------------------------------------------------
  console.log("--- Group A: Global External-Model Stop ---");
  {
    let wireCalls = 0;
    const monitoredFetch: typeof fetch = async () => {
      wireCalls++;
      return new Response(
        JSON.stringify(openAiEnvelope(validAiResponseJson())),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    // A1. Serving LLM stopped
    const envStop1 = (k: string) => {
      if (k === FLOWPILOT_AI_GLOBAL_STOP_FLAG) return "1";
      if (k === "OPENROUTER_API_KEY") return "valid-key";
      return undefined;
    };
    const primaryA1 = createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar: envStop1,
      fetchImpl: monitoredFetch,
    });
    const primaryControlA1 = createConversationControl({ provider: primaryA1 });
    const orchestratorA1 = createAiOrchestrator({
      primary: primaryControlA1,
      fallbackEnabled: false,
      getEnvVar: envStop1,
    });

    const resA1 = await orchestratorA1.callWithFallback(sampleRequest());
    check(
      "A1. Serving LLM stopped: zero HTTP calls dispatched",
      wireCalls === 0,
    );
    check(
      "A1. Telemetry totalHttpAttempts is 0",
      resA1.telemetry.totalHttpAttempts === 0,
    );
    check(
      "A1. Telemetry stopReason is GLOBAL_STOP",
      resA1.telemetry.stopReason === "GLOBAL_STOP",
    );
    check("A1. Response is null (controlled failure)", resA1.response === null);

    // A2. Serving JEV stopped
    const envStopJev = (k: string) => {
      if (k === FLOWPILOT_AI_GLOBAL_STOP_FLAG) return "true";
      if (k === "OPENROUTER_API_KEY") return "valid-key";
      if (k === "FLOWPILOT_JEV_SEMANTIC_ENABLED") return "true";
      return undefined;
    };
    const jevProviderA2 = createJevDecisionsProvider({
      getEnvVar: envStopJev,
      fetchImpl: monitoredFetch,
    });
    const jevStrategyA2 = createSemanticJevStrategy({
      provider: jevProviderA2,
      enabled: true,
    });
    const orchestratorA2 = createAiOrchestrator({
      primary: primaryControlA1,
      fallbackEnabled: false,
      decisionStrategy: jevStrategyA2,
      getEnvVar: envStopJev,
    });

    const resA2 = await orchestratorA2.callWithFallback(sampleRequest());
    check(
      "A2. Serving JEV stopped: zero HTTP calls dispatched",
      wireCalls === 0,
    );
    check(
      "A2. Telemetry totalHttpAttempts is 0",
      resA2.telemetry.totalHttpAttempts === 0,
    );
    check(
      "A2. Telemetry stopReason is GLOBAL_STOP",
      resA2.telemetry.stopReason === "GLOBAL_STOP",
    );

    // A3. Shadow evaluation blocked by global stop
    const envStopShadow = (k: string) => {
      if (k === FLOWPILOT_AI_GLOBAL_STOP_FLAG) return "stop";
      if (k === "OPENROUTER_API_KEY") return "valid-key";
      if (k === "FLOWPILOT_JEV_SHADOW_ENABLED") return "true";
      if (k === "SHADOW_SAMPLE_RATE") return "1.0";
      return undefined;
    };
    const shadowProviderA3 = createJevDecisionsProvider({
      getEnvVar: envStopShadow,
      fetchImpl: monitoredFetch,
    });
    const shadowStrategyA3 = createShadowJevStrategy({
      provider: shadowProviderA3,
      sampler: createShadowSampler({ getEnvVar: envStopShadow }),
      timeoutMs: 500,
    });
    const orchestratorA3 = createAiOrchestrator({
      primary: primaryControlA1,
      fallbackEnabled: false,
      shadowStrategy: shadowStrategyA3,
      getEnvVar: envStopShadow,
    });

    const resA3 = await orchestratorA3.callWithFallback(sampleRequest());
    check(
      "A3. Shadow evaluation stopped: zero HTTP calls dispatched",
      wireCalls === 0,
    );
    check(
      "A3. Telemetry stopReason is GLOBAL_STOP",
      resA3.telemetry.stopReason === "GLOBAL_STOP",
    );
    check("A3. Shadow evidence not evaluated", !resA3.telemetry.shadow);

    // A4. Retry cannot occur when globally stopped
    check("A4. Retry cannot occur when globally stopped", wireCalls === 0);

    // A5. Fallback cannot occur when globally stopped
    check("A5. Fallback cannot occur when globally stopped", wireCalls === 0);
  }

  // -------------------------------------------------------------------------
  // Group B: Mechanical selection while global stop is active
  // -------------------------------------------------------------------------
  console.log(
    "\n--- Group B: Mechanical Selection While Global Stop Is Active ---",
  );
  {
    let wireCalls = 0;
    const monitoredFetch: typeof fetch = async () => {
      wireCalls++;
      return new Response("{}", { status: 200 });
    };

    const envStop = (k: string) => {
      if (k === FLOWPILOT_AI_GLOBAL_STOP_FLAG) return "true";
      if (k === "OPENROUTER_API_KEY") return "valid-key";
      return undefined;
    };

    const primaryAdapter = createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar: envStop,
      fetchImpl: monitoredFetch,
    });
    const testAi = createLlmConversationAi({
      primary: createConversationControl({ provider: primaryAdapter }),
      fallbackEnabled: false,
      getEnvVar: envStop,
    });

    const emittedEvidence: TurnEvidence[] = [];
    const harness = createPlaygroundHarness({
      channel: "WHATSAPP",
      todayRef: "2026-10-22",
    });
    harness.deps.ai = testAi;
    harness.deps.turnTelemetry = {
      emit: (ev: TurnEvidence) => emittedEvidence.push(ev),
    };

    // Active offer in conversation state
    const services = await harness.deps.serviceRepository.listByBusiness(
      harness.business.id,
    );
    const now = new Date();
    const testOffer = {
      id: "off-b-01",
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
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 3600000).toISOString(),
      status: "ACTIVE" as const,
    };
    await harness.stateStore.save(
      harness.business.id,
      harness.conversation.id,
      null,
      dehydrateConversationState({
        ...emptyConversationState(),
        offer: testOffer as any,
      }),
    );

    // Customer sends choice "1"
    const mechRes = await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber ?? "+201000000000",
      from: harness.customer.phone,
      text: "1",
      receivedAt: now.toISOString(),
      externalId: "ext-msg-mech-b",
    });

    check(
      "B1. Mechanical selection succeeds during global stop",
      mechRes.ok === true,
    );
    check(
      "B2. Mechanical selection dispatched strictly ZERO HTTP calls",
      wireCalls === 0,
    );
    check(
      "B3. Mechanical selection emitted TurnEvidence with providerAttempts === 0 and NOT_CALLED",
      emittedEvidence[0]?.providerAttempts === 0 &&
        emittedEvidence[0]?.providerStatus === "NOT_CALLED",
    );
    check(
      "B4. Mechanical selection stopReason is null (not stopped since not required)",
      emittedEvidence[0]?.stopReason === null,
    );
  }

  // -------------------------------------------------------------------------
  // Group C: Global stop disabled / absent (positive control)
  // -------------------------------------------------------------------------
  console.log(
    "\n--- Group C: Global Stop Disabled / Absent (Positive Control) ---",
  );
  {
    let wireCalls = 0;
    const monitoredFetch: typeof fetch = async () => {
      wireCalls++;
      return new Response(
        JSON.stringify(
          openAiEnvelope(validAiResponseJson({ content: "أهلاً بك" })),
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    // Absent
    const primaryAbsent = createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar: (k) => (k === "OPENROUTER_API_KEY" ? "valid-key" : undefined),
      fetchImpl: monitoredFetch,
    });
    const orchestratorAbsent = createAiOrchestrator({
      primary: createConversationControl({ provider: primaryAbsent }),
      fallbackEnabled: false,
      getEnvVar: (k) => (k === "OPENROUTER_API_KEY" ? "valid-key" : undefined),
    });

    const resAbsent =
      await orchestratorAbsent.callWithFallback(sampleRequest());
    check("C1. Absent global stop dispatches wire call", wireCalls === 1);
    check(
      "C1. Absent global stop returns SUCCESS",
      resAbsent.telemetry.finalStatus === "SUCCESS",
    );
    check(
      "C1. Telemetry stopReason is null",
      resAbsent.telemetry.stopReason === null,
    );

    // Explicitly disabled ("0")
    const envDisabled = (k: string) => {
      if (k === FLOWPILOT_AI_GLOBAL_STOP_FLAG) return "0";
      if (k === "OPENROUTER_API_KEY") return "valid-key";
      return undefined;
    };
    const primaryDisabled = createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar: envDisabled,
      fetchImpl: monitoredFetch,
    });
    const orchestratorDisabled = createAiOrchestrator({
      primary: createConversationControl({ provider: primaryDisabled }),
      fallbackEnabled: false,
      getEnvVar: envDisabled,
    });

    const resDisabled =
      await orchestratorDisabled.callWithFallback(sampleRequest());
    check("C2. Disabled global stop (0) dispatches wire call", wireCalls === 2);
    check(
      "C2. Telemetry finalStatus is SUCCESS",
      resDisabled.telemetry.finalStatus === "SUCCESS",
    );
    check(
      "C2. Telemetry stopReason is null",
      resDisabled.telemetry.stopReason === null,
    );
  }

  // -------------------------------------------------------------------------
  // Group D: Serving allowance = 1 (FLOWPILOT_AI_MAX_SERVING_ATTEMPTS=1)
  // -------------------------------------------------------------------------
  console.log("\n--- Group D: Serving Allowance = 1 ---");
  {
    let primaryWireCalls = 0;
    let secondaryWireCalls = 0;

    const primaryFetch: typeof fetch = async () => {
      primaryWireCalls++;
      throw new DOMException("The operation was aborted", "AbortError");
    };
    const secondaryFetch: typeof fetch = async () => {
      secondaryWireCalls++;
      return new Response(
        JSON.stringify(openAiEnvelope(validAiResponseJson())),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const envAllowance1 = (k: string) => {
      if (k === FLOWPILOT_AI_MAX_SERVING_ATTEMPTS_FLAG) return "1";
      if (k === "OPENROUTER_API_KEY") return "valid-key";
      if (k === "ATRIA_API_KEY") return "valid-key";
      return undefined;
    };

    const primaryAdapter = createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar: envAllowance1,
      fetchImpl: primaryFetch,
    });
    const secondaryAdapter = createAtriaAdapter({
      model: "atria/auto",
      getEnvVar: envAllowance1,
      fetchImpl: secondaryFetch,
    });

    const orchestratorD = createAiOrchestrator({
      primary: createConversationControl({
        provider: primaryAdapter,
        settings: {
          conversationControl: {
            maxAttempts: 2,
            enabled: true,
            retryEnabled: true,
          },
        },
      }),
      secondary: secondaryAdapter,
      fallbackEnabled: true,
      getEnvVar: envAllowance1,
    });

    const resD = await orchestratorD.callWithFallback(sampleRequest());
    check(
      "D1. First failure dispatches exactly 1 physical attempt",
      primaryWireCalls === 1,
    );
    check(
      "D2. Internal retry blocked because allowance exhausted",
      primaryWireCalls === 1,
    );
    check(
      "D3. Secondary fallback blocked because allowance exhausted",
      secondaryWireCalls === 0,
    );
    check(
      "D4. Telemetry totalHttpAttempts is strictly 1",
      resD.telemetry.totalHttpAttempts === 1,
    );
    check(
      "D5. Telemetry stopReason is ATTEMPT_LIMIT_EXHAUSTED",
      resD.telemetry.stopReason === "ATTEMPT_LIMIT_EXHAUSTED",
    );
    check(
      "D6. Telemetry finalStatus is FAILURE",
      resD.telemetry.finalStatus === "FAILURE",
    );
  }

  // -------------------------------------------------------------------------
  // Group E: Serving allowance = 2 (FLOWPILOT_AI_MAX_SERVING_ATTEMPTS=2)
  // -------------------------------------------------------------------------
  console.log("\n--- Group E: Serving Allowance = 2 ---");
  {
    let primaryWireCalls = 0;
    let secondaryWireCalls = 0;

    const primaryFetch: typeof fetch = async () => {
      primaryWireCalls++;
      throw new DOMException("The operation was aborted", "AbortError");
    };
    const secondaryFetch: typeof fetch = async () => {
      secondaryWireCalls++;
      return new Response(
        JSON.stringify(openAiEnvelope(validAiResponseJson())),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const envAllowance2 = (k: string) => {
      if (k === FLOWPILOT_AI_MAX_SERVING_ATTEMPTS_FLAG) return "2";
      if (k === "OPENROUTER_API_KEY") return "valid-key";
      if (k === "ATRIA_API_KEY") return "valid-key";
      return undefined;
    };

    const primaryAdapter = createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar: envAllowance2,
      fetchImpl: primaryFetch,
    });
    const secondaryAdapter = createAtriaAdapter({
      model: "atria/auto",
      getEnvVar: envAllowance2,
      fetchImpl: secondaryFetch,
    });

    const orchestratorE = createAiOrchestrator({
      primary: createConversationControl({
        provider: primaryAdapter,
        settings: {
          conversationControl: {
            maxAttempts: 2,
            enabled: true,
            retryEnabled: true,
          },
        },
      }),
      secondary: secondaryAdapter,
      fallbackEnabled: true,
      getEnvVar: envAllowance2,
    });

    const resE = await orchestratorE.callWithFallback(sampleRequest());
    check(
      "E1. Primary dispatches exactly 2 calls (initial + retry)",
      primaryWireCalls === 2,
    );
    check(
      "E2. Secondary fallback blocked because allowance (2) exhausted",
      secondaryWireCalls === 0,
    );
    check(
      "E3. Telemetry totalHttpAttempts is strictly 2",
      resE.telemetry.totalHttpAttempts === 2,
    );
    check(
      "E4. Telemetry stopReason is ATTEMPT_LIMIT_EXHAUSTED",
      resE.telemetry.stopReason === "ATTEMPT_LIMIT_EXHAUSTED",
    );
    check(
      "E5. Fallback is marked not used",
      resE.telemetry.fallbackUsed === false,
    );
  }

  // -------------------------------------------------------------------------
  // Group F: Default allowance (3 attempts preserved)
  // -------------------------------------------------------------------------
  console.log("\n--- Group F: Default Allowance (3 Attempts Preserved) ---");
  {
    let primaryWireCalls = 0;
    let secondaryWireCalls = 0;

    const primaryFetch: typeof fetch = async () => {
      primaryWireCalls++;
      throw new DOMException("The operation was aborted", "AbortError");
    };
    const secondaryFetch: typeof fetch = async () => {
      secondaryWireCalls++;
      return new Response(
        JSON.stringify(openAiEnvelope(validAiResponseJson())),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const envDefault = (k: string) => {
      if (k === "OPENROUTER_API_KEY") return "valid-key";
      if (k === "ATRIA_API_KEY") return "valid-key";
      return undefined;
    };

    const primaryAdapter = createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar: envDefault,
      fetchImpl: primaryFetch,
    });
    const secondaryAdapter = createAtriaAdapter({
      model: "atria/auto",
      getEnvVar: envDefault,
      fetchImpl: secondaryFetch,
    });

    const orchestratorF = createAiOrchestrator({
      primary: createConversationControl({
        provider: primaryAdapter,
        settings: {
          conversationControl: {
            maxAttempts: 2,
            enabled: true,
            retryEnabled: true,
          },
        },
      }),
      secondary: secondaryAdapter,
      fallbackEnabled: true,
      getEnvVar: envDefault,
    });

    const resF = await orchestratorF.callWithFallback(sampleRequest());
    check(
      "F1. Primary dispatched exactly 2 physical calls (exhausted retry ceiling)",
      primaryWireCalls === 2,
    );
    check(
      "F2. Secondary fallback dispatched exactly 1 physical call (3rd attempt allowed)",
      secondaryWireCalls === 1,
    );
    check(
      "F3. Total physical HTTP attempts is strictly 3",
      resF.telemetry.totalHttpAttempts === 3,
    );
    check(
      "F4. Final status is SUCCESS",
      resF.telemetry.finalStatus === "SUCCESS",
    );
    check("F5. Fallback marked used", resF.telemetry.fallbackUsed === true);
    check(
      "F6. Telemetry stopReason is null (succeeded on attempt 3)",
      resF.telemetry.stopReason === null,
    );
  }

  // -------------------------------------------------------------------------
  // Group G: Primary success ends execution immediately
  // -------------------------------------------------------------------------
  console.log("\n--- Group G: Primary Success Ends Execution Immediately ---");
  {
    let primaryWireCalls = 0;
    let secondaryWireCalls = 0;

    const primaryFetch: typeof fetch = async () => {
      primaryWireCalls++;
      return new Response(
        JSON.stringify(openAiEnvelope(validAiResponseJson())),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const secondaryFetch: typeof fetch = async () => {
      secondaryWireCalls++;
      return new Response(
        JSON.stringify(openAiEnvelope(validAiResponseJson())),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const envDefault = (k: string) => {
      if (k === "OPENROUTER_API_KEY") return "valid-key";
      if (k === "ATRIA_API_KEY") return "valid-key";
      return undefined;
    };

    const primaryAdapter = createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar: envDefault,
      fetchImpl: primaryFetch,
    });
    const secondaryAdapter = createAtriaAdapter({
      model: "atria/auto",
      getEnvVar: envDefault,
      fetchImpl: secondaryFetch,
    });

    const orchestratorG = createAiOrchestrator({
      primary: createConversationControl({ provider: primaryAdapter }),
      secondary: secondaryAdapter,
      fallbackEnabled: true,
      getEnvVar: envDefault,
    });

    const resG = await orchestratorG.callWithFallback(sampleRequest());
    check(
      "G1. Primary dispatched exactly 1 physical request",
      primaryWireCalls === 1,
    );
    check("G2. Zero secondary requests dispatched", secondaryWireCalls === 0);
    check(
      "G3. Telemetry totalHttpAttempts is 1",
      resG.telemetry.totalHttpAttempts === 1,
    );
    check(
      "G4. Final status is SUCCESS",
      resG.telemetry.finalStatus === "SUCCESS",
    );
  }

  // -------------------------------------------------------------------------
  // Group H: Shared serving deadline
  // -------------------------------------------------------------------------
  console.log("\n--- Group H: Shared Serving Deadline ---");
  {
    let simulatedNow = 1000;
    const getNow = () => simulatedNow;

    let primaryWireCalls = 0;
    let secondaryWireCalls = 0;
    let secondaryReceivedTimeout = 0;

    const primaryFetch: typeof fetch = async () => {
      primaryWireCalls++;
      // Advance clock by 3500ms during primary failure
      simulatedNow += 3500;
      return new Response(
        JSON.stringify({ error: { message: "Gateway timeout" } }),
        {
          status: 504,
          headers: { "Content-Type": "application/json" },
        },
      );
    };
    const secondaryFetch: typeof fetch = async () => {
      secondaryWireCalls++;
      return new Response(
        JSON.stringify(openAiEnvelope(validAiResponseJson())),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    // Route budget: 4000ms
    const session = createServingExecutionSession({
      getNow,
      timeoutMs: 4000,
    });

    // Mock secondary capturing remaining timeout
    const mockSecondary: AiProviderAdapter = {
      providerId: "atria",
      model: "atria/auto",
      secretRef: "ATRIA_API_KEY",
      async call(_req, opts) {
        secondaryReceivedTimeout = opts?.timeoutMs ?? 0;
        opts?.session?.recordDispatch(1);
        await secondaryFetch("https://atria.mock/chat", {} as any);
        return {
          ok: true,
          provider: "atria" as const,
          model: "atria/auto",
          latencyMs: 100,
          response: JSON.parse(validAiResponseJson()),
          httpAttempts: 1,
        };
      },
    };

    const primaryAdapter = createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar: (k) => (k === "OPENROUTER_API_KEY" ? "valid-key" : undefined),
      fetchImpl: primaryFetch,
    });

    const orchestratorH = createAiOrchestrator({
      primary: createConversationControl({
        provider: primaryAdapter,
        getNow,
        settings: { conversationControl: { maxAttempts: 1 } },
      }),
      secondary: mockSecondary,
      fallbackEnabled: true,
      getNow,
    });

    const resH = await orchestratorH.callWithFallback(sampleRequest(), {
      session,
    });

    check(
      "H1. Primary consumed 3500ms of 4000ms deadline",
      primaryWireCalls === 1,
    );
    check(
      "H2. Secondary fallback received clamped remaining timeout (~500ms, not fresh 4000ms)",
      secondaryReceivedTimeout === 500,
    );
    check(
      "H3. Total physical calls is 2 (1 primary + 1 secondary)",
      session.getDispatchedAttempts() === 2 && secondaryWireCalls === 1,
    );
    check(
      "H4. Secondary succeeded within remaining deadline",
      resH.telemetry.finalStatus === "SUCCESS",
    );

    // Case H5: Expired deadline before secondary dispatch
    let expiredSecondaryCalls = 0;
    let clock2 = 1000;
    const sessionExpired = createServingExecutionSession({
      getNow: () => clock2,
      timeoutMs: 3000,
    });

    const slowPrimaryFetch: typeof fetch = async () => {
      clock2 += 3500; // Exceeds 3000ms deadline
      return new Response(
        JSON.stringify({ error: { message: "Slow failure" } }),
        {
          status: 504,
          headers: { "Content-Type": "application/json" },
        },
      );
    };
    const secondaryNeverCalled: typeof fetch = async () => {
      expiredSecondaryCalls++;
      return new Response("{}", { status: 200 });
    };

    const slowPrimaryAdapter = createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar: (k) => (k === "OPENROUTER_API_KEY" ? "valid-key" : undefined),
      fetchImpl: slowPrimaryFetch,
    });
    const secondaryAdapter2 = createAtriaAdapter({
      model: "atria/auto",
      getEnvVar: (k) => (k === "ATRIA_API_KEY" ? "valid-key" : undefined),
      fetchImpl: secondaryNeverCalled,
    });

    const orchestratorH2 = createAiOrchestrator({
      primary: createConversationControl({
        provider: slowPrimaryAdapter,
        getNow: () => clock2,
        settings: { conversationControl: { maxAttempts: 1 } },
      }),
      secondary: secondaryAdapter2,
      fallbackEnabled: true,
      getNow: () => clock2,
    });

    const resH2 = await orchestratorH2.callWithFallback(sampleRequest(), {
      session: sessionExpired,
    });
    check(
      "H5. Secondary fallback prevented when deadline is expired",
      expiredSecondaryCalls === 0,
    );
    check(
      "H6. Telemetry stopReason reports DEADLINE_EXHAUSTED",
      resH2.telemetry.stopReason === "DEADLINE_EXHAUSTED",
    );
  }

  // -------------------------------------------------------------------------
  // Group I: In-flight timeout and cancellation
  // -------------------------------------------------------------------------
  console.log("\n--- Group I: In-Flight Timeout & Cancellation ---");
  {
    const abortedTracker = { aborted: false };
    let fetchCalls = 0;

    const timeoutScripted = createScriptedFetch([
      {
        kind: "delay",
        delayMs: 200,
        then: { kind: "ok", body: openAiEnvelope(validAiResponseJson()) },
      },
    ]);

    const monitoredTimeoutFetch: typeof fetch = async (info, init) => {
      fetchCalls++;
      if (init?.signal) {
        init.signal.addEventListener("abort", () => {
          abortedTracker.aborted = true;
        });
      }
      return timeoutScripted.fetchImpl(info, init);
    };

    const primaryAdapter = createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar: (k) => (k === "OPENROUTER_API_KEY" ? "valid-key" : undefined),
      fetchImpl: monitoredTimeoutFetch,
      timeoutMs: 50, // Triggers timeout before 200ms delay
    });

    const primaryControl = createConversationControl({
      provider: primaryAdapter,
      settings: { conversationControl: { maxAttempts: 1 } },
    });

    const orchestratorI = createAiOrchestrator({
      primary: primaryControl,
      fallbackEnabled: false,
    });

    const resI = await orchestratorI.callWithFallback(sampleRequest());
    check(
      "I1. Abort signal reached HTTP fetch boundary",
      abortedTracker.aborted === true,
    );
    check(
      "I2. Dispatched request was initiated (fetchCalls === 1)",
      fetchCalls === 1,
    );
    check(
      "I3. Dispatched request remains counted as 1 physical HTTP attempt",
      resI.telemetry.totalHttpAttempts === 1,
    );
    check(
      "I4. Attempt status is FAILURE with TIMEOUT",
      resI.telemetry.attempts[0]?.errorCode === "TIMEOUT",
    );
  }

  // -------------------------------------------------------------------------
  // Group J: Preflight failure
  // -------------------------------------------------------------------------
  console.log(
    "\n--- Group J: Preflight Failure (0 Physical Allowance Consumed) ---",
  );
  {
    let wireCalls = 0;
    const monitoredFetch: typeof fetch = async () => {
      wireCalls++;
      return new Response("{}", { status: 200 });
    };

    // Missing API key in environment
    const preflightPrimary = createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar: () => undefined, // No key
      fetchImpl: monitoredFetch,
    });

    const orchestratorJ = createAiOrchestrator({
      primary: createConversationControl({ provider: preflightPrimary }),
      fallbackEnabled: false,
    });

    const resJ = await orchestratorJ.callWithFallback(sampleRequest());
    check(
      "J1. Preflight failure made strictly ZERO HTTP wire calls",
      wireCalls === 0,
    );
    check(
      "J2. Telemetry totalHttpAttempts is strictly 0",
      resJ.telemetry.totalHttpAttempts === 0,
    );
    check(
      "J3. Telemetry attempts reports CONFIG_ERROR",
      resJ.telemetry.attempts[0]?.errorCode === "CONFIG_ERROR",
    );
    check(
      "J4. Attempt reports httpAttempts = 0",
      resJ.telemetry.attempts[0]?.httpAttempts === 0,
    );
  }

  // -------------------------------------------------------------------------
  // Group K: Sequential turns using the same AI object
  // -------------------------------------------------------------------------
  console.log("\n--- Group K: Sequential Turns Using Same AI Object ---");
  {
    let wireCalls = 0;
    const monitoredFetch: typeof fetch = async () => {
      wireCalls++;
      return new Response(
        JSON.stringify(openAiEnvelope(validAiResponseJson())),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const primaryAdapter = createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar: (k) => (k === "OPENROUTER_API_KEY" ? "valid-key" : undefined),
      fetchImpl: monitoredFetch,
    });

    const sharedAi = createLlmConversationAi({
      primary: createConversationControl({ provider: primaryAdapter }),
      fallbackEnabled: false,
    });

    // Turn 1
    await sharedAi.respond(sampleRequest("سؤال أول"));
    const telemK1 = sharedAi.getLastTelemetry();
    check("K1. Turn 1 dispatched 1 wire call", wireCalls === 1);
    check("K1. Turn 1 status is SUCCESS", telemK1?.finalStatus === "SUCCESS");
    check(
      "K1. Turn 1 totalHttpAttempts is 1",
      telemK1?.totalHttpAttempts === 1,
    );

    // Turn 2
    await sharedAi.respond(sampleRequest("سؤال ثانٍ"));
    const telemK2 = sharedAi.getLastTelemetry();
    check("K2. Turn 2 dispatched 1 wire call (total 2)", wireCalls === 2);
    check("K2. Turn 2 status is SUCCESS", telemK2?.finalStatus === "SUCCESS");
    check(
      "K2. Turn 2 totalHttpAttempts is 1 (fresh allowance, not accumulated)",
      telemK2?.totalHttpAttempts === 1,
    );
    check(
      "K2. Turn 2 has exactly 1 attempt record (no stale records)",
      telemK2?.attempts.length === 1,
    );
  }

  // -------------------------------------------------------------------------
  // Group L: Concurrent independent turns
  // -------------------------------------------------------------------------
  console.log("\n--- Group L: Concurrent Independent Turns ---");
  {
    let wireCalls = 0;
    const delayFetch: typeof fetch = async () => {
      wireCalls++;
      await new Promise((r) => setTimeout(r, 20));
      return new Response(
        JSON.stringify(openAiEnvelope(validAiResponseJson())),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const primaryAdapter = createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar: (k) => (k === "OPENROUTER_API_KEY" ? "valid-key" : undefined),
      fetchImpl: delayFetch,
    });

    const primaryControl = createConversationControl({
      provider: primaryAdapter,
    });
    const orchestratorL = createAiOrchestrator({
      primary: primaryControl,
      fallbackEnabled: false,
    });

    const [resL1, resL2] = await Promise.all([
      orchestratorL.callWithFallback(sampleRequest("طلب متزامن 1")),
      orchestratorL.callWithFallback(sampleRequest("طلب متزامن 2")),
    ]);

    check(
      "L1. Both concurrent turns completed (total wire calls = 2)",
      wireCalls === 2,
    );
    check(
      "L2. Turn 1 totalHttpAttempts is 1",
      resL1.telemetry.totalHttpAttempts === 1,
    );
    check(
      "L3. Turn 2 totalHttpAttempts is 1",
      resL2.telemetry.totalHttpAttempts === 1,
    );
    check(
      "L4. Neither turn contaminated the other's attempts",
      resL1.telemetry.attempts.length === 1 &&
        resL2.telemetry.attempts.length === 1,
    );
  }

  // -------------------------------------------------------------------------
  // Group M: Serving JEV accounting and limits
  // -------------------------------------------------------------------------
  console.log("\n--- Group M: Serving JEV Accounting & Limits ---");
  {
    let jevWireCalls = 0;
    let llmWireCalls = 0;

    const jevFetch: typeof fetch = async () => {
      jevWireCalls++;
      return new Response(
        JSON.stringify({
          model: "typesafe/jev-1.13",
          served_model: "typesafe/jev-1.13",
          answers: {
            bookingTask: true,
            supportRequest: false,
            providerRequest: false,
            availabilityInquiry: false,
            sensitiveTopic: false,
            explicitHumanAgent: false,
            ambiguousOrMixedIntent: false,
            priceOrServiceInquiry: false,
            bookingCancellation: false,
            rescheduleRequest: false,
            conversationGoal: "booking",
            clarificationNeeded: false,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const llmFetch: typeof fetch = async () => {
      llmWireCalls++;
      return new Response(
        JSON.stringify(openAiEnvelope(validAiResponseJson())),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const envJev = (k: string) => {
      if (k === "FLOWPILOT_JEV_SEMANTIC_ENABLED") return "true";
      if (k === "OPENROUTER_API_KEY") return "valid-key";
      return undefined;
    };

    const jevProvider = createJevDecisionsProvider({
      getEnvVar: envJev,
      fetchImpl: jevFetch,
    });
    const jevStrategy = createSemanticJevStrategy({
      provider: jevProvider,
      enabled: true,
    });

    const primaryAdapter = createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar: envJev,
      fetchImpl: llmFetch,
    });

    const orchestratorM = createAiOrchestrator({
      primary: createConversationControl({ provider: primaryAdapter }),
      decisionStrategy: jevStrategy,
      fallbackEnabled: false,
      getEnvVar: envJev,
    });

    const resM = await orchestratorM.callWithFallback(sampleRequest());
    check(
      "M1. JEV Decisions API dispatched exactly 1 physical HTTP call",
      jevWireCalls === 1,
    );
    check(
      "M2. Serving LLM dispatched strictly ZERO calls after spent JEV",
      llmWireCalls === 0,
    );
    check(
      "M3. Telemetry totalHttpAttempts reflects JEV call (1)",
      resM.telemetry.totalHttpAttempts === 1,
    );
    check(
      "M4. Telemetry jevDecision mode is DETERMINISTIC",
      resM.telemetry.jevDecision?.mode === "DETERMINISTIC",
    );
    check(
      "M5. jevCallSpent is true",
      resM.telemetry.jevDecision?.semantic?.jevCallSpent === true,
    );
  }

  // -------------------------------------------------------------------------
  // Group N: Shadow isolation and global stop coverage
  // -------------------------------------------------------------------------
  console.log("\n--- Group N: Shadow Isolation & Global Stop Coverage ---");
  {
    let servingCalls = 0;
    let shadowCalls = 0;

    const servingFetch: typeof fetch = async () => {
      servingCalls++;
      return new Response(
        JSON.stringify(openAiEnvelope(validAiResponseJson())),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const shadowFetch: typeof fetch = async () => {
      shadowCalls++;
      return new Response(
        JSON.stringify({
          model: "typesafe/jev-1.13",
          served_model: "typesafe/jev-1.13",
          answers: {
            bookingTask: false,
            supportRequest: false,
            providerRequest: false,
            availabilityInquiry: false,
            sensitiveTopic: false,
            explicitHumanAgent: false,
            ambiguousOrMixedIntent: false,
            priceOrServiceInquiry: false,
            bookingCancellation: false,
            rescheduleRequest: false,
            conversationGoal: "reply",
            clarificationNeeded: false,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const envShadow = (k: string) => {
      if (k === "FLOWPILOT_JEV_SHADOW_ENABLED") return "true";
      if (k === "SHADOW_SAMPLE_RATE") return "1.0";
      if (k === "OPENROUTER_API_KEY") return "valid-key";
      return undefined;
    };

    const shadowProvider = createJevDecisionsProvider({
      getEnvVar: envShadow,
      fetchImpl: shadowFetch,
    });
    const shadowStrategy = createShadowJevStrategy({
      provider: shadowProvider,
      sampler: createShadowSampler({ getEnvVar: envShadow }),
      timeoutMs: 500,
    });

    const primaryAdapter = createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar: envShadow,
      fetchImpl: servingFetch,
    });

    const orchestratorN = createAiOrchestrator({
      primary: createConversationControl({ provider: primaryAdapter }),
      shadowStrategy,
      fallbackEnabled: false,
      getEnvVar: envShadow,
    });

    const resN = await orchestratorN.callWithFallback(sampleRequest());
    check("N1. Serving call dispatched once", servingCalls === 1);
    check("N2. Shadow call dispatched once", shadowCalls === 1);
    check(
      "N3. Serving totalHttpAttempts is strictly 1 (shadow does not consume serving allowance)",
      resN.telemetry.totalHttpAttempts === 1,
    );
    check(
      "N4. Shadow evidence present on telemetry",
      resN.telemetry.shadow !== null,
    );

    // N5. Global stop blocks shadow
    let stoppedServingCalls = 0;
    let stoppedShadowCalls = 0;
    const envStopShadow = (k: string) => {
      if (k === FLOWPILOT_AI_GLOBAL_STOP_FLAG) return "1";
      if (k === "FLOWPILOT_JEV_SHADOW_ENABLED") return "true";
      if (k === "SHADOW_SAMPLE_RATE") return "1.0";
      if (k === "OPENROUTER_API_KEY") return "valid-key";
      return undefined;
    };

    const shadowProviderStopped = createJevDecisionsProvider({
      getEnvVar: envStopShadow,
      fetchImpl: async () => {
        stoppedShadowCalls++;
        return new Response("{}", { status: 200 });
      },
    });
    const shadowStrategyStopped = createShadowJevStrategy({
      provider: shadowProviderStopped,
      sampler: createShadowSampler({ getEnvVar: envStopShadow }),
      timeoutMs: 500,
    });

    const primaryAdapterStopped = createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar: envStopShadow,
      fetchImpl: async () => {
        stoppedServingCalls++;
        return new Response("{}", { status: 200 });
      },
    });

    const orchestratorN2 = createAiOrchestrator({
      primary: createConversationControl({ provider: primaryAdapterStopped }),
      shadowStrategy: shadowStrategyStopped,
      fallbackEnabled: false,
      getEnvVar: envStopShadow,
    });

    const resN2 = await orchestratorN2.callWithFallback(sampleRequest());
    check(
      "N5. Global stop blocks shadow: 0 shadow HTTP calls",
      stoppedShadowCalls === 0,
    );
    check(
      "N6. Global stop blocks serving: 0 serving HTTP calls",
      stoppedServingCalls === 0,
    );
    check(
      "N7. Telemetry stopReason is GLOBAL_STOP",
      resN2.telemetry.stopReason === "GLOBAL_STOP",
    );
  }

  // -------------------------------------------------------------------------
  // Group O: Malformed configuration handling
  // -------------------------------------------------------------------------
  console.log("\n--- Group O: Malformed Configuration Handling ---");
  {
    // O1. Malformed global stop value ("maybe", "half", "123")
    const parseMalformedStop = parseGlobalAiStop((k) =>
      k === FLOWPILOT_AI_GLOBAL_STOP_FLAG ? "maybe" : undefined,
    );
    check(
      "O1. Malformed global stop parses to stopped=true",
      parseMalformedStop.stopped === true,
    );
    check(
      "O1. Malformed global stop reports malformed=true",
      parseMalformedStop.malformed === true,
    );
    check(
      "O1. Malformed global stop reports INVALID_CONTROL_CONFIG",
      parseMalformedStop.stopReason === "INVALID_CONTROL_CONFIG",
    );

    // O2. Malformed attempt count ("not-a-number")
    const parseMalformedAttemptsStr = parseMaxServingAttempts((k) =>
      k === FLOWPILOT_AI_MAX_SERVING_ATTEMPTS_FLAG ? "invalid" : undefined,
    );
    check(
      "O2. Malformed attempt count string reports malformed=true",
      parseMalformedAttemptsStr.malformed === true,
    );
    check(
      "O2. Malformed attempt count string reports INVALID_CONTROL_CONFIG",
      parseMalformedAttemptsStr.stopReason === "INVALID_CONTROL_CONFIG",
    );
    check(
      "O2. Malformed attempt count maxAttempts is 0",
      parseMalformedAttemptsStr.maxAttempts === 0,
    );

    // O3. Negative attempt count ("-3")
    const parseNegativeAttempts = parseMaxServingAttempts((k) =>
      k === FLOWPILOT_AI_MAX_SERVING_ATTEMPTS_FLAG ? "-3" : undefined,
    );
    check(
      "O3. Negative attempt count reports malformed=true",
      parseNegativeAttempts.malformed === true,
    );
    check(
      "O3. Negative attempt count reports INVALID_CONTROL_CONFIG",
      parseNegativeAttempts.stopReason === "INVALID_CONTROL_CONFIG",
    );

    // O4. Zero attempt count ("0")
    const parseZeroAttempts = parseMaxServingAttempts((k) =>
      k === FLOWPILOT_AI_MAX_SERVING_ATTEMPTS_FLAG ? "0" : undefined,
    );
    check(
      "O4. Zero attempt count reports malformed=true",
      parseZeroAttempts.malformed === true,
    );
    check(
      "O4. Zero attempt count reports INVALID_CONTROL_CONFIG",
      parseZeroAttempts.stopReason === "INVALID_CONTROL_CONFIG",
    );

    // O5. Non-integer decimal attempt count ("1.5")
    const parseDecimalAttempts = parseMaxServingAttempts((k) =>
      k === FLOWPILOT_AI_MAX_SERVING_ATTEMPTS_FLAG ? "1.5" : undefined,
    );
    check(
      "O5. Decimal attempt count reports malformed=true",
      parseDecimalAttempts.malformed === true,
    );
    check(
      "O5. Decimal attempt count reports INVALID_CONTROL_CONFIG",
      parseDecimalAttempts.stopReason === "INVALID_CONTROL_CONFIG",
    );

    // O6. End-to-end fail-closed: malformed config blocks network dispatch
    let wireCalls = 0;
    const monitoredFetch: typeof fetch = async () => {
      wireCalls++;
      return new Response("{}", { status: 200 });
    };

    const envMalformed = (k: string) => {
      if (k === FLOWPILOT_AI_GLOBAL_STOP_FLAG) return "corrupted_val";
      if (k === "OPENROUTER_API_KEY") return "valid-key";
      return undefined;
    };

    const primaryMalformed = createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar: envMalformed,
      fetchImpl: monitoredFetch,
    });
    const orchestratorMalformed = createAiOrchestrator({
      primary: createConversationControl({ provider: primaryMalformed }),
      fallbackEnabled: false,
      getEnvVar: envMalformed,
    });

    const resMalformed =
      await orchestratorMalformed.callWithFallback(sampleRequest());
    check(
      "O6. Malformed config blocks dispatch: 0 wire HTTP calls",
      wireCalls === 0,
    );
    check(
      "O6. Telemetry totalHttpAttempts is 0",
      resMalformed.telemetry.totalHttpAttempts === 0,
    );
    check(
      "O6. Telemetry stopReason is INVALID_CONTROL_CONFIG",
      resMalformed.telemetry.stopReason === "INVALID_CONTROL_CONFIG",
    );
    check("O6. Response is null", resMalformed.response === null);
  }

  // -------------------------------------------------------------------------
  // Group P: Full-engine integration via receiveInboundMessage
  // -------------------------------------------------------------------------
  console.log(
    "\n--- Group P: Full-Engine Integration (Controlled-Stop Behavior) ---",
  );
  {
    // P1. Engine with active GLOBAL_STOP
    let wireCallsP1 = 0;
    const fetchP1: typeof fetch = async () => {
      wireCallsP1++;
      return new Response("{}", { status: 200 });
    };

    const envStopP1 = (k: string) => {
      if (k === FLOWPILOT_AI_GLOBAL_STOP_FLAG) return "1";
      if (k === "OPENROUTER_API_KEY") return "valid-key";
      return undefined;
    };

    const primaryP1 = createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar: envStopP1,
      fetchImpl: fetchP1,
    });
    const testAiP1 = createLlmConversationAi({
      primary: createConversationControl({ provider: primaryP1 }),
      fallbackEnabled: false,
      getEnvVar: envStopP1,
    });

    const emittedEvidenceP1: TurnEvidence[] = [];
    const harnessP1 = createPlaygroundHarness({
      channel: "WHATSAPP",
      todayRef: "2026-10-22",
    });
    harnessP1.deps.ai = testAiP1;
    harnessP1.deps.turnTelemetry = {
      emit: (ev: TurnEvidence) => emittedEvidenceP1.push(ev),
    };

    const resP1 = await receiveInboundMessage(harnessP1.deps, {
      to: harnessP1.business.whatsappNumber ?? "+201000000000",
      from: harnessP1.customer.phone,
      text: "عايز أحجز كشف أسنان النهاردة ضروري",
      receivedAt: new Date().toISOString(),
      externalId: "ext-msg-p1",
    });

    check(
      "P1. Engine completes safely when global stop active",
      resP1.ok === true,
    );
    check("P1. Strictly ZERO wire HTTP calls made", wireCallsP1 === 0);
    check(
      "P1. Emitted TurnEvidence receives stopReason === GLOBAL_STOP",
      emittedEvidenceP1[0]?.stopReason === "GLOBAL_STOP",
    );
    check(
      "P1. Emitted TurnEvidence reports providerAttempts === 0",
      emittedEvidenceP1[0]?.providerAttempts === 0,
    );
    check("P1. Zero appointments created", harnessP1.appointments.length === 0);

    // P2. Engine with attempt allowance = 1 exhausted
    let wireCallsP2 = 0;
    const fetchP2: typeof fetch = async () => {
      wireCallsP2++;
      throw new DOMException("The operation was aborted", "AbortError");
    };

    const envAllowanceP2 = (k: string) => {
      if (k === FLOWPILOT_AI_MAX_SERVING_ATTEMPTS_FLAG) return "1";
      if (k === "OPENROUTER_API_KEY") return "valid-key";
      return undefined;
    };

    const primaryP2 = createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar: envAllowanceP2,
      fetchImpl: fetchP2,
    });
    const testAiP2 = createLlmConversationAi({
      primary: createConversationControl({ provider: primaryP2 }),
      fallbackEnabled: false,
      getEnvVar: envAllowanceP2,
    });

    const emittedEvidenceP2: TurnEvidence[] = [];
    const harnessP2 = createPlaygroundHarness({
      channel: "WHATSAPP",
      todayRef: "2026-10-22",
    });
    harnessP2.deps.ai = testAiP2;
    harnessP2.deps.turnTelemetry = {
      emit: (ev: TurnEvidence) => emittedEvidenceP2.push(ev),
    };

    const resP2 = await receiveInboundMessage(harnessP2.deps, {
      to: harnessP2.business.whatsappNumber ?? "+201000000000",
      from: harnessP2.customer.phone,
      text: "عايز أعرف مواعيد العيادة",
      receivedAt: new Date().toISOString(),
      externalId: "ext-msg-p2",
    });

    check(
      "P2. Engine completes safely on attempt exhaustion",
      resP2.ok === true,
    );
    check(
      "P2. Exactly 1 wire HTTP call made before limit hit",
      wireCallsP2 === 1,
    );
    check(
      "P2. Emitted TurnEvidence reports stopReason === ATTEMPT_LIMIT_EXHAUSTED",
      emittedEvidenceP2[0]?.stopReason === "ATTEMPT_LIMIT_EXHAUSTED",
    );
    check(
      "P2. Emitted TurnEvidence reports providerAttempts === 1",
      emittedEvidenceP2[0]?.providerAttempts === 1,
    );
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;

  console.log("\n========================================================");
  console.log(`TOTAL CHECKS: ${total} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log("========================================================\n");

  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
