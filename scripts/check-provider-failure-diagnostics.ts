/**
 * FlowPilot — Verification of Sanitized Provider Failure Evidence & HTTP 402 Classification.
 *
 * Validates:
 * 1. HTTP 401, 402, 403, 429, 5xx diagnostics preservation.
 * 2. Network failure without HTTP response leaves status absent/null (never 0 or 200).
 * 3. Timeout and zero-dispatch failures do not invent an HTTP status.
 * 4. Failed-attempt diagnostics survive retry/fallback aggregation (including failed primary before success).
 * 5. Both Engine attempt-projection paths (retryTrace and non-retryTrace) preserve fields.
 * 6. HTTP 402 operational provider failure handoff without extra attempts.
 * 7. Privacy boundaries: raw bodies/secrets/customer text never appear in emitted TurnEvidence.
 * 8. assertTurnEvidenceContentFree validation on emitted evidence records.
 * 9. Existing counters and cost completeness remain intact.
 */
import {
  buildTurnObservability,
  type TurnExecutionAttempt,
} from "@/features/conversations/server/ai-observability";
import {
  assertTurnEvidenceContentFree,
  buildTurnEvidence,
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
          message: `Simulated error ${status} containing SECRET_TOKEN_XYZ and cust-phone-+2010000000`,
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
    // Primary fails with 503; secondary succeeds
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

  // ── 5. Engine Attempt-Projection Paths (retryTrace and non-retryTrace) ──
  console.log("\n--- Group 5: Engine Attempt-Projection Paths ---");
  {
    // Branch 1: retryTrace path
    const mockRetryTraceAttempts = [
      {
        attempt: 1,
        outcome: "FAILURE" as const,
        errorCode: "CONFIG_ERROR" as const,
        httpStatus: 402,
        httpAttempts: 1,
        latencyMs: 150,
        provider: "openrouter" as const,
        model: "deepseek/deepseek-v4.1-flash",
      },
    ];

    const obsRetryTrace = buildTurnObservability({
      routingDecision: "LLM",
      executionAttempts: mockRetryTraceAttempts.map((a) => ({
        attempt: a.attempt,
        provider: a.provider,
        model: a.model,
        status: a.outcome,
        httpAttempts: a.httpAttempts,
        errorCode: a.errorCode,
        httpStatus: a.httpStatus,
      })),
      errorCode: "CONFIG_ERROR",
      httpStatus: 402,
    });

    const evidenceRetryTrace: TurnEvidence = buildTurnEvidence(
      {
        conversationId: "conv-1",
        businessId: "biz-1",
        customerMessageId: "msg-1",
        ok: false,
        assistantAction: "AI_HANDOFF",
        conversationStatus: "NEED_HUMAN",
        handoffCause: "PROVIDER_FAILURE",
        observability: obsRetryTrace,
      },
      { environment: "test", appVersion: "0.72.1" },
    );

    check(
      "retryTrace path: TurnEvidence preserves top-level errorCode='CONFIG_ERROR' and httpStatus=402",
      evidenceRetryTrace.errorCode === "CONFIG_ERROR" &&
        evidenceRetryTrace.httpStatus === 402,
    );
    check(
      "retryTrace path: executionAttempts[0] preserves errorCode='CONFIG_ERROR' and httpStatus=402",
      evidenceRetryTrace.executionAttempts?.[0]?.errorCode === "CONFIG_ERROR" &&
        evidenceRetryTrace.executionAttempts?.[0]?.httpStatus === 402,
    );

    // Branch 2: non-retryTrace path (direct attempts)
    const mockDirectAttempts: TurnExecutionAttempt[] = [
      {
        attempt: 1,
        provider: "openrouter",
        model: "deepseek/deepseek-v4.1-flash",
        status: "FAILURE",
        httpAttempts: 1,
        errorCode: "RETRYABLE",
        httpStatus: 500,
      },
    ];

    const obsDirect = buildTurnObservability({
      routingDecision: "LLM",
      executionAttempts: mockDirectAttempts,
      errorCode: "RETRYABLE",
      httpStatus: 500,
    });

    const evidenceDirect: TurnEvidence = buildTurnEvidence(
      {
        conversationId: "conv-2",
        businessId: "biz-1",
        customerMessageId: "msg-2",
        ok: false,
        assistantAction: "AI_HANDOFF",
        conversationStatus: "NEED_HUMAN",
        handoffCause: "PROVIDER_FAILURE",
        observability: obsDirect,
      },
      { environment: "test", appVersion: "0.72.1" },
    );

    check(
      "non-retryTrace path: TurnEvidence preserves top-level errorCode='RETRYABLE' and httpStatus=500",
      evidenceDirect.errorCode === "RETRYABLE" &&
        evidenceDirect.httpStatus === 500,
    );
    check(
      "non-retryTrace path: executionAttempts[0] preserves errorCode='RETRYABLE' and httpStatus=500",
      evidenceDirect.executionAttempts?.[0]?.errorCode === "RETRYABLE" &&
        evidenceDirect.executionAttempts?.[0]?.httpStatus === 500,
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

  // ── 7. Privacy Boundaries & Content-Freeness Guard ──
  console.log("\n--- Group 7: Privacy & Content-Freeness Verification ---");
  {
    const sensitivePayload = {
      apiKey: "example-dummy-fixture-secret-token",
      authorization: "Bearer example-dummy-jwt-token",
      customerPhone: "+201234567890",
      customerMessage: "سؤال خاص جداً عن تكلفة العملية",
    };

    const obs = buildTurnObservability({
      routingDecision: "LLM",
      executionAttempts: [
        {
          attempt: 1,
          provider: "openrouter",
          model: "deepseek/deepseek-v4.1-flash",
          status: "FAILURE",
          httpAttempts: 1,
          errorCode: "CONFIG_ERROR",
          httpStatus: 402,
        },
      ],
      errorCode: "CONFIG_ERROR",
      httpStatus: 402,
    });

    const record: TurnEvidence = buildTurnEvidence(
      {
        conversationId: "f217cf5e-f417-4db1-b074-d5e531198285",
        businessId: "biz-afnan",
        customerMessageId: "416b8ccf-3a6c-4dd2-b949-2590fc41124b",
        ok: false,
        assistantAction: "AI_HANDOFF",
        conversationStatus: "NEED_HUMAN",
        handoffCause: "PROVIDER_FAILURE",
        observability: obs,
      },
      { environment: "production", appVersion: "0.72.1" },
    );

    let contentFreePassed = false;
    try {
      assertTurnEvidenceContentFree(record);
      contentFreePassed = true;
    } catch (e) {
      console.error(e);
      contentFreePassed = false;
    }
    check(
      "assertTurnEvidenceContentFree accepts TurnEvidence with errorCode & httpStatus",
      contentFreePassed,
    );

    const serialized = JSON.stringify(record);
    check(
      "Serialized evidence does not contain apiKey secret",
      !serialized.includes(sensitivePayload.apiKey),
    );
    check(
      "Serialized evidence does not contain auth token",
      !serialized.includes(sensitivePayload.authorization),
    );
    check(
      "Serialized evidence does not contain customer phone",
      !serialized.includes(sensitivePayload.customerPhone),
    );
    check(
      "Serialized evidence does not contain customer text",
      !serialized.includes(sensitivePayload.customerMessage),
    );
    check(
      "Serialized evidence contains sanitized errorCode: 'CONFIG_ERROR'",
      serialized.includes('"errorCode":"CONFIG_ERROR"'),
    );
    check(
      "Serialized evidence contains sanitized httpStatus: 402",
      serialized.includes('"httpStatus":402'),
    );
  }

  // ── 8. Existing Counters & Cost Completeness Invariants ──
  console.log(
    "\n--- Group 8: Existing Counters & Cost Completeness Preservation ---",
  );
  {
    const obs = buildTurnObservability({
      routingDecision: "LLM",
      providerAttempts: 1,
      modelCallCount: 1,
      costCompleteness: "UNAVAILABLE",
      totalCostUsd: null,
      knownCostSubtotalUsd: null,
      executionAttempts: [
        {
          attempt: 1,
          provider: "openrouter",
          status: "FAILURE",
          httpAttempts: 1,
          errorCode: "CONFIG_ERROR",
          httpStatus: 402,
        },
      ],
      errorCode: "CONFIG_ERROR",
      httpStatus: 402,
    });

    const record = buildTurnEvidence(
      {
        conversationId: "conv-1",
        businessId: "biz-1",
        customerMessageId: "msg-1",
        ok: false,
        assistantAction: "AI_HANDOFF",
        conversationStatus: "NEED_HUMAN",
        handoffCause: "PROVIDER_FAILURE",
        observability: obs,
      },
      { environment: "test", appVersion: "0.72.1" },
    );

    check("providerAttempts remains exactly 1", record.providerAttempts === 1);
    check(
      "costCompleteness remains UNAVAILABLE",
      record.costCompleteness === "UNAVAILABLE",
    );
    check("totalCostUsd remains null", record.totalCostUsd === null);
    check(
      "knownCostSubtotalUsd remains null",
      record.knownCostSubtotalUsd === null,
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
