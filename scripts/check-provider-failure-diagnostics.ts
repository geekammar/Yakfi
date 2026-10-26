/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * FlowPilot — Verification of Sanitized Provider Failure Evidence & HTTP 402 Classification.
 *
 * Validates:
 * 1. HTTP 401, 402, 403, 429, 5xx diagnostics preservation.
 * 2. Network failure without HTTP response leaves status absent/null (never 0 or 200).
 * 3. Timeout and zero-dispatch failures do not invent an HTTP status.
 * 4. Failed-attempt diagnostics survive retry/fallback aggregation in Orchestrator.
 * 5. Real Engine attempt-projection paths (executing receiveInboundMessage with createPlaygroundHarness):
 *    - 5a. retryTrace projection branch preserves attempt and turn-level diagnostics.
 *    - 5b. Direct telemetry attempts projection branch preserves attempt and turn-level diagnostics.
 *    - 5c. Failed primary followed by successful fallback retains failed diagnostics while overall turn succeeds.
 *    - 5d. Network/timeout failure without observed status keeps httpStatus absent/null.
 *    - 5e. Existing counters and cost completeness invariants remain intact.
 * 6. HTTP 402 operational provider failure handoff without extra attempts.
 * 7. Privacy boundaries & content-free guard connected to the real engine path with canaries.
 */
import { createPlaygroundHarness } from "@/features/conversations/playground/harness";
import { receiveInboundMessage } from "@/features/conversations/server/conversation-engine";
import {
  assertTurnEvidenceContentFree,
  type TurnEvidence,
} from "@/features/conversations/server/turn-evidence";
import { createAgentRouterAdapter } from "@/server/integrations/ai/agentrouter";
import { createConversationControl } from "@/server/integrations/ai/conversation-control";
import { createOpenRouterAdapter } from "@/server/integrations/ai/openrouter";
import { createAiOrchestrator } from "@/server/integrations/ai/orchestrator";
import type { AiProviderErrorCode } from "@/server/integrations/ai/types";

let failures = 0;
function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`✔ ${label}`);
  } else {
    console.error(`✘ ${label}`);
    failures += 1;
  }
}

function mockFetchResponse(
  status: number,
  body: unknown,
  delayMs = 0,
): typeof fetch {
  return (async () => {
    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function mockNetworkError(): typeof fetch {
  return (async () => {
    throw new TypeError("fetch failed: ECONNREFUSED 127.0.0.1:443");
  }) as unknown as typeof fetch;
}

const dummyRequest = {
  message: "ما هي مواعيد العمل؟",
  conversationStatus: "AI_ACTIVE" as const,
  businessName: "عيادة الاختبار",
  services: [],
  faqs: [],
  recentMessages: [],
};

const fakeEnv = (name: string) => {
  if (name === "OPENROUTER_API_KEY") return "sk-openrouter-test-key";
  if (name === "AGENTROUTER_API_KEY") return "sk-agentrouter-test-key";
  return undefined;
};

async function main() {
  console.log(
    "=== FlowPilot: Provider Failure Diagnostics & HTTP 402 Verification ===\n",
  );

  // ── 1. HTTP 401, 402, 403, 429, 500, 503 Diagnostics Preservation ──
  console.log("--- Group 1: HTTP Status & Error Code Preservation ---");
  for (const status of [401, 402, 403, 429, 500, 503]) {
    const adapter = createOpenRouterAdapter({
      model: "test-model",
      getEnvVar: fakeEnv,
      fetchImpl: mockFetchResponse(status, {
        error: {
          message: `Simulated error ${status} containing sensitive fixture info`,
          code: status,
        },
      }),
    });
    const result = await adapter.call(dummyRequest);
    check(
      `Status ${status}: adapter call fails with httpStatus === ${status}`,
      !result.ok && result.error.httpStatus === status,
    );
    const expectedCode: AiProviderErrorCode =
      status === 401 || status === 402 || status === 403
        ? "CONFIG_ERROR"
        : "RETRYABLE";
    check(
      `Status ${status}: errorCode is ${expectedCode} (retryable: ${status === 429 || status >= 500})`,
      !result.ok &&
        result.error.code === expectedCode &&
        result.error.retryable === (status === 429 || status >= 500),
    );
  }

  // ── 2. Network Failure Keeps httpStatus Unknown (never 0 or 200) ──
  console.log("\n--- Group 2: Network Error Handling ---");
  {
    const adapter = createOpenRouterAdapter({
      model: "test-model",
      getEnvVar: fakeEnv,
      fetchImpl: mockNetworkError(),
    });
    const result = await adapter.call(dummyRequest);
    check(
      "Network failure produces RETRYABLE error without httpStatus (undefined)",
      !result.ok &&
        result.error.code === "RETRYABLE" &&
        result.error.httpStatus === undefined,
    );
  }

  // ── 3. Zero-Dispatch & Timeout Failures Do Not Invent Status ──
  console.log("\n--- Group 3: Zero-Dispatch & Timeout Status Invariants ---");
  {
    // Preflight missing secret
    const adapter = createOpenRouterAdapter({
      model: "test-model",
      getEnvVar: () => undefined,
      fetchImpl: mockFetchResponse(200, {}),
    });
    const result = await adapter.call(dummyRequest);
    check(
      "Missing secret produces CONFIG_ERROR with httpAttempts=0 and undefined httpStatus",
      !result.ok &&
        result.error.code === "CONFIG_ERROR" &&
        result.httpAttempts === 0 &&
        result.error.httpStatus === undefined,
    );
  }
  {
    // Timeout
    const adapter = createOpenRouterAdapter({
      model: "test-model",
      getEnvVar: fakeEnv,
      fetchImpl: mockFetchResponse(200, {}, 200),
      timeoutMs: 10,
    });
    const result = await adapter.call(dummyRequest);
    check(
      "Timeout produces TIMEOUT error with undefined httpStatus (never 0 or 200)",
      !result.ok &&
        result.error.code === "TIMEOUT" &&
        result.error.httpStatus === undefined,
    );
  }

  // ── 4. Failed-Attempt Diagnostics Survive Retry/Fallback Aggregation ──
  console.log("\n--- Group 4: Fallback & Retry Aggregation Preservation ---");
  {
    const primary = createOpenRouterAdapter({
      model: "primary-model",
      getEnvVar: fakeEnv,
      fetchImpl: mockFetchResponse(503, {
        error: { message: "service unavailable" },
      }),
    });
    const validContent = JSON.stringify({
      intent: "FAQ",
      action: "reply",
      content: "ساعات العمل من 9 صباحاً",
      extraction: {
        service: null,
        provider: null,
        date: null,
        timePreference: null,
      },
      handoffReason: null,
      summary: null,
      safetyAssessment: "safe",
    });
    const secondary = createAgentRouterAdapter({
      model: "secondary-model",
      getEnvVar: fakeEnv,
      fetchImpl: mockFetchResponse(200, {
        choices: [{ message: { content: validContent } }],
        usage: { prompt_tokens: 15, completion_tokens: 10 },
      }),
    });
    const orch = createAiOrchestrator({
      primary,
      secondary,
      fallbackEnabled: true,
    });
    const result = await orch.callWithFallback(dummyRequest);

    check("Fallback turn overall succeeds", result.response !== null);
    check("Fallback was marked used", result.telemetry.fallbackUsed === true);
    check(
      "Telemetry captures 2 attempts",
      result.telemetry.attempts.length === 2,
    );
    check(
      "Primary failed attempt preserved with httpStatus=503 and errorCode=RETRYABLE",
      result.telemetry.attempts[0]?.status === "FAILURE" &&
        result.telemetry.attempts[0]?.httpStatus === 503 &&
        result.telemetry.attempts[0]?.errorCode === "RETRYABLE",
    );
    check(
      "Secondary success attempt has SUCCESS status and undefined httpStatus",
      result.telemetry.attempts[1]?.status === "SUCCESS" &&
        result.telemetry.attempts[1]?.httpStatus === undefined,
    );
  }

  // ── 5. Actual Engine Attempt-Projection Paths & Fallback Coexistence ──
  console.log(
    "\n--- Group 5: Actual Engine Attempt-Projection Paths (receiveInboundMessage) ---",
  );
  {
    // 5a. Real Engine execution through the retryTrace projection branch (HTTP 402)
    const emittedRetryTrace: TurnEvidence[] = [];
    const harness5a = createPlaygroundHarness({ channel: "WHATSAPP" });
    harness5a.deps.turnTelemetry = {
      emit: (ev) => emittedRetryTrace.push(ev),
    };

    const mockFetch402 = async () =>
      new Response(
        JSON.stringify({
          error: { message: "Payment Required / Insufficient Credits" },
        }),
        { status: 402, headers: { "Content-Type": "application/json" } },
      );

    const openRouter402 = createOpenRouterAdapter({
      model: "deepseek/deepseek-v4.1-flash",
      fetchImpl: mockFetch402 as any,
      getEnvVar: fakeEnv,
    });

    const controlled402 = createConversationControl({
      provider: openRouter402,
      settings: {
        conversationControl: {
          enabled: true,
          retryEnabled: true,
          maxAttempts: 2,
        },
      } as any,
    });

    harness5a.deps.ai = {
      providerName: "openrouter",
      respond: async (req: any): Promise<any> => {
        const result = await controlled402.call(req);
        (harness5a.deps.ai as any)._lastTelemetry = {
          finalProvider: result.provider,
          finalModel: result.model,
          attempts:
            result.retryTrace?.attempts.map((a) => ({
              provider: a.provider,
              model: a.model,
              status: a.outcome === "SUCCESS" ? "SUCCESS" : "FAILURE",
              errorCode: a.errorCode,
              httpStatus: a.httpStatus,
              httpAttempts: a.httpAttempts,
              latencyMs: a.latencyMs,
            })) ?? [],
          retryTrace: result.retryTrace,
          conversationControl: result.conversationControl,
        };
        if (!result.ok) return null;
        return result.response;
      },
      getLastTelemetry: () => (harness5a.deps.ai as any)._lastTelemetry,
    } as any;

    const res5a = await receiveInboundMessage(harness5a.deps, {
      to: harness5a.business.whatsappNumber ?? "+201001111111",
      from: "+201011112222",
      text: "عايز استفسار عن مواعيد العمل",
      receivedAt: new Date().toISOString(),
      externalId: "ext-msg-5a",
    });

    const ev5a = emittedRetryTrace[0];
    check("5a. Real Engine completes turn", res5a.ok === true);
    check(
      "5a. Handoff cause is PROVIDER_FAILURE",
      (res5a as any).handoffCause === "PROVIDER_FAILURE",
    );
    check(
      "5a. retryTrace path: TurnEvidence top-level preserves errorCode='CONFIG_ERROR'",
      ev5a?.errorCode === "CONFIG_ERROR",
    );
    check(
      "5a. retryTrace path: TurnEvidence top-level preserves httpStatus=402",
      ev5a?.httpStatus === 402,
    );
    check(
      "5a. retryTrace path: executionAttempts[0] preserves errorCode='CONFIG_ERROR' and httpStatus=402",
      ev5a?.executionAttempts?.[0]?.errorCode === "CONFIG_ERROR" &&
        ev5a?.executionAttempts?.[0]?.httpStatus === 402 &&
        ev5a?.executionAttempts?.[0]?.status === "FAILURE",
    );

    // 5b. Real Engine execution through direct telemetry attempts branch (non-retryTrace)
    const emittedDirect: TurnEvidence[] = [];
    const harness5b = createPlaygroundHarness({ channel: "WHATSAPP" });
    harness5b.deps.turnTelemetry = {
      emit: (ev) => emittedDirect.push(ev),
    };

    harness5b.deps.ai = {
      providerName: "openrouter",
      respond: async () => null,
      getLastTelemetry: () => ({
        finalProvider: "openrouter",
        finalModel: "deepseek/deepseek-v4.1-flash",
        // Direct attempts present, retryTrace intentionally undefined
        attempts: [
          {
            provider: "openrouter",
            model: "deepseek/deepseek-v4.1-flash",
            status: "FAILURE" as const,
            errorCode: "RETRYABLE" as const,
            httpStatus: 500,
            httpAttempts: 1,
            latencyMs: 180,
          },
        ],
        retryTrace: undefined,
      }),
    } as any;

    const res5b = await receiveInboundMessage(harness5b.deps, {
      to: harness5b.business.whatsappNumber ?? "+201001111111",
      from: "+201011113333",
      text: "عايز استفسار عن الخدمات",
      receivedAt: new Date().toISOString(),
      externalId: "ext-msg-5b",
    });

    const ev5b = emittedDirect[0];
    check("5b. Real Engine completes turn", res5b.ok === true);
    check(
      "5b. Direct branch: TurnEvidence top-level preserves errorCode='RETRYABLE'",
      ev5b?.errorCode === "RETRYABLE",
    );
    check(
      "5b. Direct branch: TurnEvidence top-level preserves httpStatus=500",
      ev5b?.httpStatus === 500,
    );
    check(
      "5b. Direct branch: executionAttempts[0] preserves errorCode='RETRYABLE' and httpStatus=500",
      ev5b?.executionAttempts?.[0]?.errorCode === "RETRYABLE" &&
        ev5b?.executionAttempts?.[0]?.httpStatus === 500 &&
        ev5b?.executionAttempts?.[0]?.status === "FAILURE",
    );

    // 5c. Real Engine path: Failed primary followed by successful fallback
    const emittedFallback: TurnEvidence[] = [];
    const harness5c = createPlaygroundHarness({ channel: "WHATSAPP" });
    harness5c.deps.turnTelemetry = {
      emit: (ev) => emittedFallback.push(ev),
    };

    harness5c.deps.ai = {
      providerName: "openrouter",
      respond: async () => ({
        intent: "FAQ",
        action: "reply",
        content:
          "مواعيد العمل لدينا من السبت إلى الخميس من 9 صباحاً حتى 5 مساءً.",
        extraction: {
          service: null,
          provider: null,
          date: null,
          timePreference: null,
        },
        handoffReason: null,
        summary: null,
        safetyAssessment: "safe",
      }),
      getLastTelemetry: () => ({
        finalProvider: "agentrouter",
        finalModel: "gpt-4o-mini",
        attempts: [
          {
            provider: "openrouter",
            model: "deepseek/deepseek-v4.1-flash",
            status: "FAILURE" as const,
            errorCode: "RETRYABLE" as const,
            httpStatus: 503,
            httpAttempts: 1,
            latencyMs: 320,
          },
          {
            provider: "agentrouter",
            model: "gpt-4o-mini",
            status: "SUCCESS" as const,
            httpAttempts: 1,
            latencyMs: 410,
            inputTokens: 120,
            outputTokens: 45,
          },
        ],
        retryTrace: {
          totalAttempts: 2,
          totalCostUsd: null,
          exhausted: false,
          handoffReason: null,
          attempts: [
            {
              attempt: 1,
              provider: "openrouter",
              model: "deepseek/deepseek-v4.1-flash",
              outcome: "FAILURE" as const,
              errorCode: "RETRYABLE" as const,
              httpStatus: 503,
              httpAttempts: 1,
              latencyMs: 320,
            },
            {
              attempt: 2,
              provider: "agentrouter",
              model: "gpt-4o-mini",
              outcome: "SUCCESS" as const,
              httpAttempts: 1,
              latencyMs: 410,
              inputTokens: 120,
              outputTokens: 45,
            },
          ],
        },
      }),
    } as any;

    const res5c = await receiveInboundMessage(harness5c.deps, {
      to: harness5c.business.whatsappNumber ?? "+201001111111",
      from: "+201011114444",
      text: "مواعيد العمل إيه؟",
      receivedAt: new Date().toISOString(),
      externalId: "ext-msg-5c",
    });

    const ev5c = emittedFallback[0];
    check(
      "5c. Turn overall succeeds (AI_REPLY)",
      (res5c as any).assistantAction === "AI_REPLY",
    );
    check(
      "5c. Conversation status remains AI_ACTIVE",
      (res5c as any).conversationStatus === "AI_ACTIVE",
    );
    check(
      "5c. Handoff cause is null on successful turn",
      (res5c as any).handoffCause === null,
    );
    check(
      "5c. executionAttempts captures both attempts",
      ev5c?.executionAttempts?.length === 2,
    );
    check(
      "5c. Primary failed attempt preserves httpStatus=503 and errorCode=RETRYABLE",
      ev5c?.executionAttempts?.[0]?.status === "FAILURE" &&
        ev5c?.executionAttempts?.[0]?.errorCode === "RETRYABLE" &&
        ev5c?.executionAttempts?.[0]?.httpStatus === 503,
    );
    check(
      "5c. Secondary success attempt has SUCCESS status and undefined httpStatus",
      ev5c?.executionAttempts?.[1]?.status === "SUCCESS" &&
        ev5c?.executionAttempts?.[1]?.httpStatus === undefined,
    );
    check(
      "5c. TurnEvidence top-level retains last failed attempt diagnostics (coexistence invariant)",
      ev5c?.errorCode === "RETRYABLE" && ev5c?.httpStatus === 503,
    );
    console.log(
      "ℹ Note: In 5c, turn-level failure diagnostics (errorCode=RETRYABLE, httpStatus=503) coexist with a recovered successful fallback turn; they do not mean the final turn failed.",
    );

    // 5d. Real Engine path: Network error without observed HTTP status
    const emittedNetwork: TurnEvidence[] = [];
    const harness5d = createPlaygroundHarness({ channel: "WHATSAPP" });
    harness5d.deps.turnTelemetry = {
      emit: (ev) => emittedNetwork.push(ev),
    };

    harness5d.deps.ai = {
      providerName: "openrouter",
      respond: async () => null,
      getLastTelemetry: () => ({
        finalProvider: "openrouter",
        finalModel: "deepseek/deepseek-v4.1-flash",
        attempts: [
          {
            provider: "openrouter",
            model: "deepseek/deepseek-v4.1-flash",
            status: "FAILURE" as const,
            errorCode: "RETRYABLE" as const,
            httpAttempts: 1,
            // httpStatus undefined on network error
          },
        ],
      }),
    } as any;

    const res5d = await receiveInboundMessage(harness5d.deps, {
      to: harness5d.business.whatsappNumber ?? "+201001111111",
      from: "+201011115555",
      text: "عايز كشف عاجل",
      receivedAt: new Date().toISOString(),
      externalId: "ext-msg-5d",
    });

    const ev5d = emittedNetwork[0];
    check("5d. Real Engine completes turn", res5d.ok === true);
    check(
      "5d. Network error: httpStatus remains strictly null/undefined (never 0 or 200)",
      ev5d?.httpStatus === null || ev5d?.httpStatus === undefined,
    );
    check(
      "5d. Network error: executionAttempts[0].httpStatus is undefined",
      ev5d?.executionAttempts?.[0]?.httpStatus === undefined,
    );
    check(
      "5d. Network error: errorCode is preserved as RETRYABLE",
      ev5d?.errorCode === "RETRYABLE" &&
        ev5d?.executionAttempts?.[0]?.errorCode === "RETRYABLE",
    );

    // 5e. Existing counters and cost completeness invariants
    check(
      "5e. providerAttempts accurate on single attempt (1)",
      ev5a?.providerAttempts === 1,
    );
    check(
      "5e. providerAttempts accurate on fallback (2)",
      ev5c?.providerAttempts === 2,
    );
    check(
      "5e. costCompleteness remains UNAVAILABLE",
      ev5a?.costCompleteness === "UNAVAILABLE" &&
        ev5c?.costCompleteness === "UNAVAILABLE",
    );
    check(
      "5e. totalCostUsd remains null",
      ev5a?.totalCostUsd === null && ev5c?.totalCostUsd === null,
    );
  }

  // ── 6. HTTP 402 Reaches Operational Handoff Without Extra Attempts ──
  console.log(
    "\n--- Group 6: HTTP 402 Operational Handoff & Single Attempt ---",
  );
  {
    let wireCalls = 0;
    const fetch402: typeof fetch = (async () => {
      wireCalls += 1;
      return new Response(
        JSON.stringify({
          error: {
            message: "Insufficient credits / Payment required for model",
            code: 402,
          },
        }),
        { status: 402, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const rawAdapter = createOpenRouterAdapter({
      model: "deepseek/deepseek-v4.1-flash",
      getEnvVar: fakeEnv,
      fetchImpl: fetch402,
    });

    const controlledAdapter = createConversationControl({
      provider: rawAdapter,
      settings: {
        conversationControl: {
          enabled: true,
          retryEnabled: true,
          maxAttempts: 2,
        },
      },
    });

    const controlOutcome = await controlledAdapter.executeTurn(dummyRequest);

    check(
      "HTTP 402 executes exactly 1 wire attempt (no retries)",
      wireCalls === 1,
    );
    check(
      "HTTP 402 control handoffReason is AUTH_OR_CONFIGURATION_FAILURE",
      controlOutcome.handoffReason === "AUTH_OR_CONFIGURATION_FAILURE",
    );
    check(
      "HTTP 402 result errorCode is CONFIG_ERROR",
      !controlOutcome.result.ok &&
        controlOutcome.result.error.code === "CONFIG_ERROR",
    );
    check(
      "HTTP 402 result httpStatus is 402",
      !controlOutcome.result.ok &&
        controlOutcome.result.error.httpStatus === 402,
    );
    check(
      "HTTP 402 retryTrace attempt carries httpStatus=402 and errorCode=CONFIG_ERROR",
      controlOutcome.retryTrace.attempts[0]?.httpStatus === 402 &&
        controlOutcome.retryTrace.attempts[0]?.errorCode === "CONFIG_ERROR",
    );
  }

  // ── 7. Privacy Canaries Connected to Real Engine Diagnostic Pipeline ──
  console.log(
    "\n--- Group 7: Privacy Canaries & Content-Freeness Connected to Real Engine Path ---",
  );
  {
    const CANARY_CUSTOMER_PHONE = "+201999988887";
    const CANARY_CUSTOMER_TEXT =
      "كاناري سري جدا لمعاينة تفاصيل الأسعار والعروض الخاصة";
    const CANARY_API_KEY = "example-canary-secret-api-key-xyz987";
    const CANARY_AUTH_HEADER = "Bearer example-canary-jwt-token-auth456";
    const CANARY_RAW_ERROR_MESSAGE =
      "Raw upstream provider error containing sensitive stack trace and secret debug metadata";
    const CANARY_DEBUG_REQ_ID = "req_secret_debug_789";

    const emittedPrivacyEvidence: TurnEvidence[] = [];
    const harnessPrivacy = createPlaygroundHarness({ channel: "WHATSAPP" });
    harnessPrivacy.deps.turnTelemetry = {
      emit: (ev) => emittedPrivacyEvidence.push(ev),
    };

    const mockFetchWithCanaries: typeof fetch = (async () => {
      return new Response(
        JSON.stringify({
          error: {
            message: CANARY_RAW_ERROR_MESSAGE,
            type: "insufficient_quota",
            code: 402,
            debug_request_id: CANARY_DEBUG_REQ_ID,
            internal_stack:
              "at OpenRouterAdapter.execute (/internal/secret/path.ts:42)",
          },
        }),
        {
          status: 402,
          headers: {
            "Content-Type": "application/json",
            "x-canary-api-key": CANARY_API_KEY,
            Authorization: CANARY_AUTH_HEADER,
          },
        },
      );
    }) as unknown as typeof fetch;

    const rawAdapterCanary = createOpenRouterAdapter({
      model: "deepseek/deepseek-v4.1-flash",
      getEnvVar: () => CANARY_API_KEY,
      fetchImpl: mockFetchWithCanaries,
    });

    const controlledCanary = createConversationControl({
      provider: rawAdapterCanary,
      settings: {
        conversationControl: {
          enabled: true,
          retryEnabled: true,
          maxAttempts: 2,
        },
      },
    });

    harnessPrivacy.deps.ai = {
      providerName: "openrouter",
      respond: async (req: any): Promise<any> => {
        const result = await controlledCanary.call(req);
        (harnessPrivacy.deps.ai as any)._lastTelemetry = {
          finalProvider: result.provider,
          finalModel: result.model,
          attempts:
            result.retryTrace?.attempts.map((a) => ({
              provider: a.provider,
              model: a.model,
              status: a.outcome === "SUCCESS" ? "SUCCESS" : "FAILURE",
              errorCode: a.errorCode,
              httpStatus: a.httpStatus,
              httpAttempts: a.httpAttempts,
              latencyMs: a.latencyMs,
            })) ?? [],
          retryTrace: result.retryTrace,
          conversationControl: result.conversationControl,
        };
        if (!result.ok) return null;
        return result.response;
      },
      getLastTelemetry: () => (harnessPrivacy.deps.ai as any)._lastTelemetry,
    } as any;

    // Execute real Engine path passing customer-text and phone canaries
    const resPrivacy = await receiveInboundMessage(harnessPrivacy.deps, {
      to: harnessPrivacy.business.whatsappNumber ?? "+201001111111",
      from: CANARY_CUSTOMER_PHONE,
      text: CANARY_CUSTOMER_TEXT,
      receivedAt: new Date().toISOString(),
      externalId: "ext-msg-canary",
    });

    check("Real Engine completes canary turn", resPrivacy.ok === true);
    check(
      "Handoff cause is PROVIDER_FAILURE",
      (resPrivacy as any).handoffCause === "PROVIDER_FAILURE",
    );

    const record = emittedPrivacyEvidence[0];
    check("TurnEvidence was captured by the test sink", Boolean(record));

    let contentFreePassed = false;
    try {
      if (record) {
        assertTurnEvidenceContentFree(record);
        contentFreePassed = true;
      }
    } catch (e) {
      console.error("assertTurnEvidenceContentFree threw:", e);
      contentFreePassed = false;
    }
    check(
      "assertTurnEvidenceContentFree accepts emitted TurnEvidence without error",
      contentFreePassed,
    );

    const serialized = JSON.stringify(record);

    check(
      "Sanitized internal errorCode 'CONFIG_ERROR' survives in emitted evidence",
      record?.errorCode === "CONFIG_ERROR" &&
        serialized.includes('"errorCode":"CONFIG_ERROR"'),
    );
    check(
      "Observed httpStatus 402 survives in emitted evidence",
      record?.httpStatus === 402 && serialized.includes('"httpStatus":402'),
    );
    check(
      "Attempt-level errorCode 'CONFIG_ERROR' and httpStatus 402 survive",
      record?.executionAttempts?.[0]?.errorCode === "CONFIG_ERROR" &&
        record?.executionAttempts?.[0]?.httpStatus === 402,
    );

    check(
      "Serialized evidence does NOT contain CANARY_API_KEY",
      !serialized.includes(CANARY_API_KEY),
    );
    check(
      "Serialized evidence does NOT contain CANARY_AUTH_HEADER",
      !serialized.includes(CANARY_AUTH_HEADER),
    );
    check(
      "Serialized evidence does NOT contain CANARY_CUSTOMER_PHONE",
      !serialized.includes(CANARY_CUSTOMER_PHONE),
    );
    check(
      "Serialized evidence does NOT contain CANARY_CUSTOMER_TEXT",
      !serialized.includes(CANARY_CUSTOMER_TEXT),
    );
    check(
      "Serialized evidence does NOT contain CANARY_RAW_ERROR_MESSAGE",
      !serialized.includes(CANARY_RAW_ERROR_MESSAGE),
    );
    check(
      "Serialized evidence does NOT contain raw error payload details (debug_id/stack)",
      !serialized.includes(CANARY_DEBUG_REQ_ID) &&
        !serialized.includes("internal_stack") &&
        !serialized.includes("insufficient_quota"),
    );
  }

  console.log("\n========================================================");
  if (failures === 0) {
    console.log("ALL PROVIDER FAILURE DIAGNOSTICS & HTTP 402 CHECKS PASSED ✅");
    process.exit(0);
  } else {
    console.error(`FAILED ❌: ${failures} checks failed.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
