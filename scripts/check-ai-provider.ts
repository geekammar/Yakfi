/* eslint-disable @typescript-eslint/consistent-type-imports */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * FlowPilot — AI PROVIDER ADAPTER check (PROMPT-AI-02).
 *
 * Verifies the REAL LLM provider adapter boundaries OFFLINE (no
 * network, no DB, no secrets — all provider calls are mocked fetch):
 *
 *   1. primary success → AI_TURN SUCCESS with provider/model/tokens
 *   2. primary retryable (429/5xx) → secondary success (fallbackUsed)
 *   3. primary timeout → secondary success
 *   4. fallback disabled → retryable does NOT fallback
 *   5. secondary failure → overall failure (controlled)
 *   6. malformed provider response → INVALID_RESPONSE
 *   7. invalid structured output → INVALID_RESPONSE (no retry)
 *   8. deterministic bypass → no provider call, no AI_TURN
 *   9. policy factory: effective policy → correct adapter identities
 *  10. engine AI_TURN telemetry: provider/model/tokens/fallback
 *  11. secrets never leak (only secretRef names, no key shapes)
 *  12. error taxonomy + isRetryable
 *  13. prompt boundary: AiRequest minimal, parseAiResponse strips reasoning
 *
 * Run: pnpm check:ai-provider
 */
export {};

type Check = { label: string; pass: boolean };

type AiTypes = typeof import("../src/server/integrations/ai/types");
type PromptModule = typeof import("../src/server/integrations/ai/prompt");
type HttpModule = typeof import("../src/server/integrations/ai/http");
type OpenRouterModule =
  typeof import("../src/server/integrations/ai/openrouter");
type AgentRouterModule =
  typeof import("../src/server/integrations/ai/agentrouter");
type AtriaModule = typeof import("../src/server/integrations/ai/atria");
type OrchestratorModule =
  typeof import("../src/server/integrations/ai/orchestrator");
type FactoryModule = typeof import("../src/server/integrations/ai/factory");
type AiContractModule =
  typeof import("../src/features/conversations/server/ai-contract");
type EngineModule =
  typeof import("../src/features/conversations/server/conversation-engine");

// ── helpers: mock fetch helpers ────────────────────────────────────────────

function validAiResponseJson(overrides: Partial<Record<string, unknown>> = {}) {
  return JSON.stringify({
    intent: "FAQ",
    action: "reply",
    content: "من 9 صباحاً حتى 6 مساءً",
    extraction: {
      service: null,
      provider: null,
      date: null,
      timePreference: null,
    },
    handoffReason: null,
    summary: null,
    ...overrides,
  });
}

function openAiEnvelope(
  content: string,
  usage?: Record<string, number>,
): Record<string, unknown> {
  return {
    choices: [{ message: { content } }],
    usage: usage ?? { prompt_tokens: 12, completion_tokens: 8 },
  };
}

function mockFetchOnce(status: number, body: unknown): typeof fetch {
  return (async () => {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function mockFetchSequence(
  seq: Array<{ status: number; body: unknown } | Error | { abort: true }>,
): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  let idx = 0;
  const f = (async (_url: string, init?: RequestInit) => {
    const cur = seq[Math.min(idx++, seq.length - 1)];
    calls.push(_url);
    if (cur instanceof Error) throw cur;
    if (cur && typeof cur === "object" && "abort" in cur) {
      const err = new DOMException("aborted", "AbortError");
      // also respect signal if already aborted
      if (init?.signal?.aborted) throw err;
      throw err;
    }
    const hit = cur as { status: number; body: unknown };
    return new Response(JSON.stringify(hit.body), {
      status: hit.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

async function main(): Promise<void> {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const prompt: PromptModule =
    await import("../src/server/integrations/ai/prompt");
  const http: HttpModule = await import("../src/server/integrations/ai/http");
  const openrouter: OpenRouterModule =
    await import("../src/server/integrations/ai/openrouter");
  const agentrouter: AgentRouterModule =
    await import("../src/server/integrations/ai/agentrouter");
  const atria: AtriaModule =
    await import("../src/server/integrations/ai/atria");
  const orchestrator: OrchestratorModule =
    await import("../src/server/integrations/ai/orchestrator");
  const factory: FactoryModule =
    await import("../src/server/integrations/ai/factory");
  const aiContract: AiContractModule =
    await import("../src/features/conversations/server/ai-contract");
  const engine: EngineModule =
    await import("../src/features/conversations/server/conversation-engine");
  const convAi =
    await import("../src/features/conversations/server/conversation-ai");
  const dedupe =
    await import("../src/server/repositories/inbound-dedupe.repository");

  // Import with real types via dynamic import — eslint consistent-type-imports
  const types =
    (await import("../src/server/integrations/ai/types")) as AiTypes;

  const checks: Check[] = [];
  function check(label: string, pass: boolean): void {
    checks.push({ label, pass });
  }

  const getEnvVar = (name: string) =>
    name === "OPENROUTER_API_KEY" ||
    name === "AGENTROUTER_API_KEY" ||
    name === "ATRIA_API_KEY"
      ? `test-${name.toLowerCase()}-value`
      : undefined;

  const baseRequest: import("../src/features/conversations/server/ai-contract").AiRequest =
    {
      message: "ما هي ساعات العمل؟",
      conversationStatus: "AI_ACTIVE",
      recentMessages: [],
      businessName: "منشأة تجريبية",
      services: [],
      faqs: [{ question: "ما هي ساعات العمل؟", answer: "من 9 حتى 6" }],
    };

  // ── 12. error taxonomy ───────────────────────────────────────────────────
  check(
    "isRetryable: RETRYABLE/TIMEOUT فقط",
    types.isRetryableAiError("RETRYABLE") === true &&
      types.isRetryableAiError("TIMEOUT") === true &&
      types.isRetryableAiError("PERMANENT") === false &&
      types.isRetryableAiError("INVALID_RESPONSE") === false &&
      types.isRetryableAiError("CONFIG_ERROR") === false &&
      types.isRetryableAiError("CONTROLLED_FAILURE") === false,
  );
  check(
    "http.isRetryableResult يعكس نفس التصنيف",
    (() => {
      const rOk = {
        ok: true,
        provider: "openrouter" as const,
        model: "m",
        latencyMs: 1,
        response:
          baseRequest as unknown as import("../src/features/conversations/server/ai-contract").AiResponse,
      };
      const rRetry = {
        ok: false as const,
        provider: "openrouter" as const,
        model: "m",
        latencyMs: 1,
        error: { code: "RETRYABLE" as const, message: "x", retryable: true },
      };
      const rPerm = {
        ok: false as const,
        provider: "openrouter" as const,
        model: "m",
        latencyMs: 1,
        error: { code: "PERMANENT" as const, message: "x", retryable: false },
      };
      return (
        http.isRetryableResult(rOk as never) === false &&
        http.isRetryableResult(rRetry) === true &&
        http.isRetryableResult(rPerm) === false
      );
    })(),
  );

  // ── 13. prompt boundary ──────────────────────────────────────────────────
  check(
    "parseAiResponse يشطب reasoning/chainOfThought",
    (() => {
      const raw = {
        intent: "FAQ" as const,
        action: "reply" as const,
        content: "من 9 حتى 6",
        extraction: { ...aiContract.emptyAiExtraction },
        handoffReason: null,
        summary: null,
        reasoning: "should be stripped",
        chainOfThought: "also stripped",
      };
      const out = aiContract.parseAiResponse(raw);
      return (
        out !== null &&
        !("reasoning" in (out as Record<string, unknown>)) &&
        !("chainOfThought" in (out as Record<string, unknown>))
      );
    })(),
  );
  check(
    "buildPromptMessages يبني system + user من AiRequest الحد الأدنى",
    (() => {
      const msgs = prompt.buildPromptMessages(baseRequest);
      return (
        msgs.length === 2 &&
        msgs[0]!.role === "system" &&
        msgs[1]!.role === "user" &&
        msgs[1]!.content.includes(baseRequest.message)
      );
    })(),
  );
  check(
    "buildRequestBody يطلب response_format json_object و temperature 0.2",
    (() => {
      const b = prompt.buildRequestBody("test-model", [
        { role: "user", content: "hi" },
      ]) as Record<string, unknown>;
      return (
        b.model === "test-model" &&
        (b.response_format as { type?: string })?.type === "json_object" &&
        b.temperature === 0.2
      );
    })(),
  );

  // ── 1. primary success ───────────────────────────────────────────────────
  {
    const primary = openrouter.createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar,
      fetchImpl: mockFetchOnce(
        200,
        openAiEnvelope(validAiResponseJson(), {
          prompt_tokens: 12,
          completion_tokens: 8,
        }),
      ),
    });
    const orch = orchestrator.createAiOrchestrator({
      primary,
      secondary: null,
      fallbackEnabled: false,
    });
    const res = await orch.callWithFallback(baseRequest);
    check(
      "01 primary success → SUCCESS بلا fallback ومع tokens",
      res.response !== null &&
        res.response.intent === "FAQ" &&
        res.telemetry.finalStatus === "SUCCESS" &&
        res.telemetry.fallbackUsed === false &&
        res.telemetry.attempts.length === 1 &&
        res.telemetry.attempts[0]!.status === "SUCCESS" &&
        res.telemetry.attempts[0]!.inputTokens === 12 &&
        res.telemetry.attempts[0]!.outputTokens === 8,
    );
  }

  // ── 2. primary retryable → secondary success ─────────────────────────────
  {
    const primary = openrouter.createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar,
      fetchImpl: mockFetchOnce(429, { error: { message: "rate limited" } }),
    });
    const secondary = agentrouter.createAgentRouterAdapter({
      model: "auto",
      getEnvVar,
      fetchImpl: mockFetchOnce(
        200,
        openAiEnvelope(validAiResponseJson({ intent: "FAQ" })),
      ),
    });
    const orch = orchestrator.createAiOrchestrator({
      primary,
      secondary,
      fallbackEnabled: true,
    });
    const res = await orch.callWithFallback(baseRequest);
    check(
      "02 primary RETRYABLE (429) → secondary success مع fallbackUsed",
      res.response !== null &&
        res.telemetry.fallbackUsed === true &&
        res.telemetry.attempts.length === 2 &&
        res.telemetry.attempts[0]!.status === "FAILURE" &&
        res.telemetry.attempts[1]!.status === "SUCCESS" &&
        res.telemetry.finalProvider === "agentrouter",
    );
  }

  // ── 2b. 5xx also retryable → secondary ───────────────────────────────────
  {
    const primary = openrouter.createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar,
      fetchImpl: mockFetchOnce(500, { error: { message: "server error" } }),
    });
    const secondary = agentrouter.createAgentRouterAdapter({
      model: "auto",
      getEnvVar,
      fetchImpl: mockFetchOnce(200, openAiEnvelope(validAiResponseJson())),
    });
    const orch = orchestrator.createAiOrchestrator({
      primary,
      secondary,
      fallbackEnabled: true,
    });
    const res = await orch.callWithFallback(baseRequest);
    check(
      "02b primary 500 → secondary (retryable)",
      res.response !== null && res.telemetry.fallbackUsed === true,
    );
  }

  // ── 3. timeout → secondary ───────────────────────────────────────────────
  {
    const seqPrimary: Array<
      { status: number; body: unknown } | Error | { abort: true }
    > = [{ abort: true }];
    const { fetch: fetchPrimary } = mockFetchSequence(seqPrimary);
    const primary = openrouter.createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar,
      fetchImpl: fetchPrimary as unknown as typeof fetch,
      timeoutMs: 50,
    });
    // Simulate timeout via AbortError directly — adapter maps it to TIMEOUT
    const timeoutFetch = (async () => {
      throw new DOMException("aborted", "AbortError");
    }) as unknown as typeof fetch;
    const primaryTimeout = openrouter.createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar,
      fetchImpl: timeoutFetch,
      timeoutMs: 50,
    });
    const secondary = agentrouter.createAgentRouterAdapter({
      model: "auto",
      getEnvVar,
      fetchImpl: mockFetchOnce(200, openAiEnvelope(validAiResponseJson())),
    });
    const orch = orchestrator.createAiOrchestrator({
      primary: primaryTimeout,
      secondary,
      fallbackEnabled: true,
    });
    void primary; // keep var used
    const res = await orch.callWithFallback(baseRequest);
    const firstCode = res.telemetry.attempts[0]?.errorCode;
    check(
      "03 timeout (AbortError→TIMEOUT) → secondary success",
      res.response !== null &&
        firstCode === "TIMEOUT" &&
        res.telemetry.fallbackUsed === true,
    );
  }

  // ── 4. fallback disabled → no secondary call ─────────────────────────────
  {
    let secondaryCalled = false;
    const primary = openrouter.createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar,
      fetchImpl: mockFetchOnce(500, { error: { message: "server error" } }),
    });
    const secondary = agentrouter.createAgentRouterAdapter({
      model: "auto",
      getEnvVar,
      fetchImpl: (async () => {
        secondaryCalled = true;
        return new Response(
          JSON.stringify(openAiEnvelope(validAiResponseJson())),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });
    const orch = orchestrator.createAiOrchestrator({
      primary,
      secondary,
      fallbackEnabled: false,
    });
    const res = await orch.callWithFallback(baseRequest);
    check(
      "04 fallback معطّل → لا استدعاء للثانوي حتى مع RETRYABLE",
      res.response === null &&
        res.telemetry.fallbackUsed === false &&
        res.telemetry.attempts.length === 1 &&
        secondaryCalled === false,
    );
  }

  // ── 5. secondary failure → controlled failure (null response) ────────────
  {
    const primary = openrouter.createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar,
      fetchImpl: mockFetchOnce(500, { error: { message: "primary fail" } }),
    });
    const secondary = agentrouter.createAgentRouterAdapter({
      model: "auto",
      getEnvVar,
      fetchImpl: mockFetchOnce(500, { error: { message: "secondary fail" } }),
    });
    const orch = orchestrator.createAiOrchestrator({
      primary,
      secondary,
      fallbackEnabled: true,
    });
    const res = await orch.callWithFallback(baseRequest);
    check(
      "05 كلا المزودين فشل → null (المحرك سيحوّل لحاجة بشرية)",
      res.response === null &&
        res.telemetry.finalStatus === "FAILURE" &&
        res.telemetry.fallbackUsed === true &&
        res.telemetry.attempts.length === 2,
    );
  }

  // ── 6. malformed provider response → INVALID_RESPONSE ────────────────────
  {
    const primary = openrouter.createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar,
      fetchImpl: (async () =>
        new Response("not json", { status: 200 })) as unknown as typeof fetch,
    });
    const orch = orchestrator.createAiOrchestrator({
      primary,
      secondary: null,
      fallbackEnabled: false,
    });
    const res = await orch.callWithFallback(baseRequest);
    check(
      "06 استجابة غير JSON / حقل content فارغ → INVALID_RESPONSE بلا retry",
      res.response === null &&
        res.telemetry.attempts[0]?.errorCode === "INVALID_RESPONSE" &&
        res.telemetry.fallbackUsed === false,
    );
  }

  // ── 6b. empty content ────────────────────────────────────────────────────
  {
    const primary = openrouter.createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar,
      fetchImpl: mockFetchOnce(200, {
        choices: [{ message: { content: "" } }],
      }),
    });
    const orch = orchestrator.createAiOrchestrator({
      primary,
      secondary: null,
      fallbackEnabled: false,
    });
    const res = await orch.callWithFallback(baseRequest);
    check(
      "06b محتوى فارغ من المزود → INVALID_RESPONSE",
      res.response === null &&
        res.telemetry.attempts[0]?.errorCode === "INVALID_RESPONSE",
    );
  }

  // ── 7. invalid structured output → INVALID_RESPONSE (no fallback) ───────
  {
    const primary = openrouter.createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar,
      fetchImpl: mockFetchOnce(
        200,
        openAiEnvelope(
          JSON.stringify({
            intent: "UNKNOWN_INTENT",
            action: "reply",
            content: "hi",
            extraction: {
              service: null,
              provider: null,
              date: null,
              timePreference: null,
            },
            handoffReason: null,
            summary: null,
          }),
        ),
      ),
    });
    const secondary = agentrouter.createAgentRouterAdapter({
      model: "auto",
      getEnvVar,
      fetchImpl: mockFetchOnce(200, openAiEnvelope(validAiResponseJson())),
    });
    const orch = orchestrator.createAiOrchestrator({
      primary,
      secondary,
      fallbackEnabled: true,
    });
    const res = await orch.callWithFallback(baseRequest);
    check(
      "07 مخرجات منظمة غير صالحة → INVALID_RESPONSE بلا fallback (غير retryable)",
      res.response === null &&
        res.telemetry.attempts[0]?.errorCode === "INVALID_RESPONSE" &&
        res.telemetry.fallbackUsed === false,
    );
  }

  // ── 7b. reasoning-stripped but still invalid → handled ───────────────────
  {
    const primary = openrouter.createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar,
      fetchImpl: mockFetchOnce(
        200,
        openAiEnvelope(
          JSON.stringify({
            intent: "AMBIGUOUS",
            action: "handoff",
            content: "رد",
            extraction: {
              service: null,
              provider: null,
              date: null,
              timePreference: null,
            },
            handoffReason: null,
            summary: null,
            reasoning: "hidden cot",
          }),
        ),
      ),
    });
    const orch = orchestrator.createAiOrchestrator({
      primary,
      secondary: null,
      fallbackEnabled: false,
    });
    const res = await orch.callWithFallback(baseRequest);
    check(
      "07b handoff بلا handoffReason → INVALID_RESPONSE بعد شطب reasoning",
      res.response === null,
    );
  }

  // ── 8. deterministic bypass ──────────────────────────────────────────────
  {
    let primaryCalled = false;
    const primary = openrouter.createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar,
      fetchImpl: (async () => {
        primaryCalled = true;
        return new Response(
          JSON.stringify(openAiEnvelope(validAiResponseJson())),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });
    const orch = orchestrator.createAiOrchestrator({
      primary,
      secondary: null,
      fallbackEnabled: false,
    });
    const bypassReq: import("../src/features/conversations/server/ai-contract").AiRequest =
      { ...baseRequest, message: "م" };
    const res = await orch.callWithFallback(bypassReq);
    check(
      "08 bypassDeterministicAi (م) → لا استدعاء للمزود و deterministic-bypass",
      res.response !== null &&
        res.response.intent === "AMBIGUOUS" &&
        res.telemetry.finalProvider === "deterministic-bypass" &&
        res.telemetry.attempts.length === 0 &&
        primaryCalled === false,
    );
  }

  // ── 9. factory / policy awareness ────────────────────────────────────────
  {
    const effective: import("../src/lib/validation/platform").EffectiveAiPolicy =
      {
        primaryProvider: "openrouter",
        primaryModel: "openrouter/auto",
        secondary: { provider: "agentrouter", model: "auto" },
      };
    const { primary, secondary, fallbackEnabled } =
      factory.adaptersFromEffectivePolicy(effective, {
        getEnvVar,
        fetchImpl: mockFetchOnce(200, openAiEnvelope(validAiResponseJson())),
      });
    check(
      "09a المصنع من السياسة الفعّالة → primary openrouter + secondary agentrouter + fallback true",
      primary.providerId === "openrouter" &&
        primary.model === "openrouter/auto" &&
        primary.secretRef === "OPENROUTER_API_KEY" &&
        secondary !== null &&
        secondary.providerId === "agentrouter" &&
        secondary.model === "auto" &&
        secondary.secretRef === "AGENTROUTER_API_KEY" &&
        fallbackEnabled === true,
    );
  }
  {
    const effective: import("../src/lib/validation/platform").EffectiveAiPolicy =
      {
        primaryProvider: "agentrouter",
        primaryModel: "custom-model",
        secondary: null,
      };
    const { primary, secondary, fallbackEnabled } =
      factory.adaptersFromEffectivePolicy(effective, {
        getEnvVar,
        fetchImpl: mockFetchOnce(200, openAiEnvelope(validAiResponseJson())),
      });
    check(
      "09b سياسة بلا احتياطي → secondary null + fallback false",
      primary.providerId === "agentrouter" &&
        primary.model === "custom-model" &&
        secondary === null &&
        fallbackEnabled === false,
    );
  }
  {
    const effective: import("../src/lib/validation/platform").EffectiveAiPolicy =
      {
        primaryProvider: "openrouter",
        primaryModel: "m1",
        secondary: null,
      };
    // createPolicyBackedAi falls back to deterministic when policy read fails
    const ai = await factory.createPolicyBackedAi({
      getEnvVar,
      fetchImpl: mockFetchOnce(200, openAiEnvelope(validAiResponseJson())),
      getAiPolicyImpl: (async () => {
        throw new Error("db down");
      }) as never,
    });
    void effective;
    check(
      "09c فشل قراءة السياسة → deterministic fallback (المحرك يبقى آمناً)",
      ai.providerName === "deterministic",
    );
  }

  // ── 14. Atria adapter (PROMPT-ARCH-AI-PROVIDER-ATRIA-07) ─────────────────
  // Factory selects Atria correctly from the effective policy.
  {
    const effective: import("../src/lib/validation/platform").EffectiveAiPolicy =
      {
        primaryProvider: "atria",
        primaryModel: "Atria-Dawn-Preview",
        secondary: null,
      };
    const { primary, secondary, fallbackEnabled } =
      factory.adaptersFromEffectivePolicy(effective, {
        getEnvVar,
        fetchImpl: mockFetchOnce(200, openAiEnvelope(validAiResponseJson())),
      });
    check(
      "14a المصنع يختار Atria من السياسة (provider/model/secretRef)",
      primary.providerId === "atria" &&
        primary.model === "Atria-Dawn-Preview" &&
        primary.secretRef === "ATRIA_API_KEY" &&
        secondary === null &&
        fallbackEnabled === false,
    );
  }
  // Request construction: endpoint + model passthrough + auth by secret NAME.
  {
    const captured: { url?: string; auth?: string; model?: string } = {};
    const adapter = atria.createAtriaAdapter({
      model: "Atria-Dawn-Preview",
      getEnvVar,
      fetchImpl: (async (url: string, init?: RequestInit) => {
        captured.url = url;
        captured.auth =
          (init?.headers as Record<string, string> | undefined)
            ?.Authorization ?? undefined;
        captured.model = (
          JSON.parse(init?.body as string) as { model?: string }
        ).model;
        return new Response(
          JSON.stringify(openAiEnvelope(validAiResponseJson())),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });
    const res = await adapter.call(baseRequest);
    check(
      "14b بناء طلب Atria: endpoint الصحيح + النموذج كما هو + مصادقة Bearer",
      res.ok === true &&
        captured.url === atria.ATRIA_ENDPOINT &&
        captured.model === "Atria-Dawn-Preview" &&
        typeof captured.auth === "string" &&
        captured.auth.startsWith("Bearer "),
    );
  }
  // Authentication uses the configured secret reference; missing key is CONFIG_ERROR.
  {
    const adapter = atria.createAtriaAdapter({
      model: "Atria-Dawn-Preview",
      getEnvVar: (name) => (name === "ATRIA_API_KEY" ? "value" : undefined),
      fetchImpl: mockFetchOnce(200, openAiEnvelope(validAiResponseJson())),
    });
    const res = await adapter.call(baseRequest);
    check(
      "14c المصادقة تستخدم مرجع ATRIA_API_KEY فقط (قيمة سرية لا تُخزّن)",
      res.ok === true && adapter.secretRef === "ATRIA_API_KEY",
    );
    const noKey = atria.createAtriaAdapter({
      model: "Atria-Dawn-Preview",
      getEnvVar: () => undefined,
      fetchImpl: mockFetchOnce(200, openAiEnvelope(validAiResponseJson())),
    });
    const resNoKey = await noKey.call(baseRequest);
    check(
      "14d مفتاح Atria مفقود → CONFIG_ERROR (بلا طلب شبكة)",
      resNoKey.ok === false &&
        resNoKey.error.code === "CONFIG_ERROR" &&
        resNoKey.error.retryable === false,
    );
  }
  // Valid OpenAI-compatible JSON response is normalized into AiProviderSuccess.
  {
    const adapter = atria.createAtriaAdapter({
      model: "Atria-Dawn-Preview",
      getEnvVar,
      fetchImpl: mockFetchOnce(
        200,
        openAiEnvelope(validAiResponseJson(), {
          prompt_tokens: 20,
          completion_tokens: 7,
        }),
      ),
    });
    const res = await adapter.call(baseRequest);
    check(
      "14e استجابة OpenAI متوافقة تُطبَّع إلى AiResponse (intent/provider/tokens)",
      res.ok === true &&
        res.provider === "atria" &&
        res.model === "Atria-Dawn-Preview" &&
        res.response.intent === "FAQ" &&
        res.response.action === "reply" &&
        res.inputTokens === 20 &&
        res.outputTokens === 7,
    );
  }
  // Invalid / empty response maps to existing INVALID_RESPONSE (non-retryable).
  {
    const empty = atria.createAtriaAdapter({
      model: "Atria-Dawn-Preview",
      getEnvVar,
      fetchImpl: mockFetchOnce(200, {
        choices: [{ message: { content: "" } }],
      }),
    });
    const resEmpty = await empty.call(baseRequest);
    const malformed = atria.createAtriaAdapter({
      model: "Atria-Dawn-Preview",
      getEnvVar,
      fetchImpl: (async () =>
        new Response("not json", { status: 200 })) as unknown as typeof fetch,
    });
    const resMalformed = await malformed.call(baseRequest);
    check(
      "14f استجابة فارغة/غير صالحة من Atria → INVALID_RESPONSE بلا retry",
      resEmpty.ok === false &&
        resEmpty.error.code === "INVALID_RESPONSE" &&
        resMalformed.ok === false &&
        resMalformed.error.code === "INVALID_RESPONSE",
    );
  }
  // Provider failure maps to the existing retry/fallback semantics.
  {
    const primary = atria.createAtriaAdapter({
      model: "Atria-Dawn-Preview",
      getEnvVar,
      fetchImpl: mockFetchOnce(500, { error: { message: "atria down" } }),
    });
    const orch = orchestrator.createAiOrchestrator({
      primary,
      secondary: null,
      fallbackEnabled: false,
    });
    const res = await orch.callWithFallback(baseRequest);
    check(
      "14g فشل Atria (500) → RETRYABLE → فشل مُتحكَّم به (null) بلا احتياطي",
      res.response === null &&
        res.telemetry.attempts[0]?.errorCode === "RETRYABLE" &&
        res.telemetry.finalStatus === "FAILURE" &&
        res.telemetry.fallbackUsed === false,
    );
  }
  {
    const primary = atria.createAtriaAdapter({
      model: "Atria-Dawn-Preview",
      getEnvVar,
      fetchImpl: mockFetchOnce(500, { error: { message: "atria down" } }),
    });
    const secondary = agentrouter.createAgentRouterAdapter({
      model: "auto",
      getEnvVar,
      fetchImpl: mockFetchOnce(200, openAiEnvelope(validAiResponseJson())),
    });
    const orch = orchestrator.createAiOrchestrator({
      primary,
      secondary,
      fallbackEnabled: true,
    });
    const res = await orch.callWithFallback(baseRequest);
    check(
      "14h فشل Atria Retryable → التراجع للاحتياطي يعمل (دلالات موجودة)",
      res.response !== null &&
        res.telemetry.fallbackUsed === true &&
        res.telemetry.finalProvider === "agentrouter",
    );
  }
  // Selecting Atria does not affect AgentRouter (isolation).
  {
    const atriaAdapter = atria.createAtriaAdapter({
      model: "Atria-Dawn-Preview",
      getEnvVar,
      fetchImpl: mockFetchOnce(200, openAiEnvelope(validAiResponseJson())),
    });
    const agentAdapter = agentrouter.createAgentRouterAdapter({
      model: "deepseek-v4-flash",
      getEnvVar,
      fetchImpl: mockFetchOnce(200, openAiEnvelope(validAiResponseJson())),
    });
    check(
      "14i Atria معزول عن AgentRouter (provider/secretRef/endpoint مختلفة)",
      atriaAdapter.providerId !== agentAdapter.providerId &&
        atriaAdapter.secretRef !== agentAdapter.secretRef &&
        (atria.ATRIA_ENDPOINT as string) !==
          (agentrouter.AGENTROUTER_ENDPOINT as string) &&
        agentrouter.AGENTROUTER_ENDPOINT ===
          "https://agentrouter.org/v1/chat/completions" &&
        agentAdapter.providerId === "agentrouter" &&
        agentAdapter.secretRef === "AGENTROUTER_API_KEY",
    );
  }

  // ── 10. engine AI_TURN telemetry (real engine with fake repos) ───────────
  {
    const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
    const CONV_ID = "22222222-2222-4222-8222-222222222222";
    const CUSTOMER_ID = "33333333-3333-4333-8333-333333333333";
    const BRANCH_ID = "44444444-4444-4333-8333-444444444444";
    const usageRecords: Array<Record<string, unknown>> = [];
    const ledger = new Map<
      string,
      {
        claimId: string;
        conversationId: string | null;
        customerMessageId: string | null;
      }
    >();

    const conversation = {
      id: CONV_ID,
      businessId: BUSINESS_ID,
      customerId: CUSTOMER_ID,
      branchId: BRANCH_ID,
      assignedUserId: null,
      status: "AI_ACTIVE" as const,
      lastMessageAt: null,
      aiSummary: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    } as unknown as import("../src/types/domain").Conversation;

    const customer = {
      id: CUSTOMER_ID,
      businessId: BUSINESS_ID,
      name: "عميل",
      phone: "+201234567890",
      email: null,
      notes: null,
      lastConversationAt: null,
      lastAppointmentAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    } as unknown as import("../src/types/domain").Customer;

    const messages: import("../src/types/domain").Message[] = [];

    // LLM ai that exposes telemetry (like createLlmConversationAi)
    const primaryAdapter = openrouter.createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar,
      fetchImpl: mockFetchOnce(
        200,
        openAiEnvelope(
          validAiResponseJson({
            intent: "FAQ",
            action: "reply",
            content: "من 9 حتى 6",
          }),
          { prompt_tokens: 10, completion_tokens: 5 },
        ),
      ),
    });
    const llmAi = (
      await import("../src/server/integrations/ai/conversation-ai")
    ).createLlmConversationAi({
      primary: primaryAdapter,
      secondary: null,
      fallbackEnabled: false,
    });

    const deps: import("../src/features/conversations/server/conversation-engine").ConversationEngineDeps =
      {
        businessRepository: {
          findByWhatsappNumber: async () =>
            ({
              id: BUSINESS_ID,
              name: "منشأة",
              whatsappNumber: "+201001111111",
              isActive: true,
              faqs: [{ question: "ما هي ساعات العمل؟", answer: "من 9 حتى 6" }],
            }) as unknown as import("../src/types/domain").Business,
        },
        branchRepository: {
          findDefaultByBusiness: async () =>
            ({
              id: BRANCH_ID,
              businessId: BUSINESS_ID,
            }) as unknown as import("../src/types/domain").Branch,
        },
        customerRepository: {
          upsertByPhone: async () => customer,
          touchConversation: async () => customer,
        },
        conversationRepository: {
          findLatestByCustomer: async () => ({ id: CONV_ID }),
          findById: async () => conversation,
          create: async () => conversation,
          addMessage: async (input, _wf, ref) => {
            const row = ref
              ? [...ledger.values()].find((r) => r.claimId === ref.claimId)
              : undefined;
            if (row?.customerMessageId)
              throw new dedupe.InboundDuplicateError({
                conversationId: row.conversationId,
                customerMessageId: row.customerMessageId,
              });
            const msg = {
              id: `msg-${messages.length + 1}`,
              conversationId: input.conversationId,
              senderType: input.senderType,
              content: input.content,
              createdAt: input.createdAt ?? new Date(),
              updatedAt: new Date(),
            } as unknown as import("../src/types/domain").Message;
            messages.push(msg);
            if (row) {
              row.conversationId = input.conversationId;
              row.customerMessageId = msg.id;
            }
            return msg;
          },
          getMessages: async () => [...messages].reverse(),
          update: async () => conversation,
          updateWorkflow: async () => conversation,
        },
        serviceRepository: { listByBusiness: async () => [] },
        inboundDedupeRepository: {
          claim: async (bid: string, key: string) => {
            const k = `${bid}|${key}`;
            const ex = ledger.get(k);
            if (ex) {
              if (ex.customerMessageId)
                return {
                  status: "duplicate" as const,
                  claimId: ex.claimId,
                  conversationId: ex.conversationId,
                  customerMessageId: ex.customerMessageId,
                };
              return { status: "reclaim" as const, claimId: ex.claimId };
            }
            const claimId = `claim-${ledger.size + 1}`;
            ledger.set(k, {
              claimId,
              conversationId: null,
              customerMessageId: null,
            });
            return { status: "claimed" as const, claimId };
          },
        },
        usageRepository: {
          record: async (input) => {
            usageRecords.push(input as unknown as Record<string, unknown>);
            return input as unknown as import("../src/types/domain").UsageRecord;
          },
        },
        ai: llmAi as unknown as import("../src/features/conversations/server/conversation-ai").ConversationAi,
        transport: {
          providerName: "fake-transport",
          send: async () => ({ provider: "fake-transport", delivered: true }),
        },
      };

    const result = await engine.receiveInboundMessage(deps, {
      to: "+201001111111",
      from: "+201234567890",
      text: "ما هي ساعات العمل؟",
      receivedAt: new Date().toISOString(),
      externalId: "wamid.AI-PROVIDER-1",
    });

    const aiTurn = usageRecords.find((r) => r.kind === "AI_TURN") as
      Record<string, unknown> | undefined;
    check(
      "10a المحرك يسجل AI_TURN مع provider/model/tokens عند نجاح LLM",
      result.ok === true &&
        aiTurn !== undefined &&
        aiTurn.provider === "openrouter" &&
        aiTurn.model === "openrouter/auto" &&
        aiTurn.inputTokens === 10 &&
        aiTurn.outputTokens === 5 &&
        aiTurn.status === "SUCCESS",
    );

    // 10b: bypass should NOT produce AI_TURN
    usageRecords.length = 0;
    ledger.clear();
    messages.length = 0;
    const bypassAi = convAi.deterministicConversationAi;
    const depsBypass: import("../src/features/conversations/server/conversation-engine").ConversationEngineDeps =
      {
        ...deps,
        ai: bypassAi,
      };
    const r2 = await engine.receiveInboundMessage(
      {
        ...depsBypass,
        inboundDedupeRepository: {
          claim: async (bid: string, key: string) => {
            const k = `${bid}|${key}-bypass`;
            const ex = ledger.get(k);
            if (ex)
              return {
                status: "duplicate" as const,
                claimId: ex.claimId,
                conversationId: ex.conversationId,
                customerMessageId: ex.customerMessageId,
              };
            const claimId = `claim-${ledger.size + 1}`;
            ledger.set(k, {
              claimId,
              conversationId: null,
              customerMessageId: null,
            });
            return { status: "claimed" as const, claimId };
          },
        },
      },
      {
        to: "+201001111111",
        from: "+201234567891",
        text: "م",
        receivedAt: new Date().toISOString(),
        externalId: "wamid.AI-PROVIDER-bypass",
      },
    );
    void r2;
    const hasAiTurn = usageRecords.some((r) => r.kind === "AI_TURN");
    check(
      "10b bypassDeterministicAi لا ينتج AI_TURN (بلا استهلاك)",
      !hasAiTurn,
    );
  }

  // ── 11. secrets never leak ────────────────────────────────────────────────
  {
    const secretRefNames = [
      "OPENROUTER_API_KEY",
      "AGENTROUTER_API_KEY",
      "ATRIA_API_KEY",
    ];
    const aiFiles = [
      "src/server/integrations/ai/types.ts",
      "src/server/integrations/ai/prompt.ts",
      "src/server/integrations/ai/http.ts",
      "src/server/integrations/ai/openrouter.ts",
      "src/server/integrations/ai/agentrouter.ts",
      "src/server/integrations/ai/atria.ts",
      "src/server/integrations/ai/orchestrator.ts",
      "src/server/integrations/ai/conversation-ai.ts",
      "src/server/integrations/ai/factory.ts",
    ];
    const aiSource = aiFiles
      .map((f) => {
        try {
          return readFileSync(join(process.cwd(), f), "utf8");
        } catch {
          return "";
        }
      })
      .join("\n");
    const hasProcessEnvSecret =
      /process\.env\.(OPENROUTER|AGENTROUTER|ATRIA)_API_KEY/.test(aiSource);
    // The adapter reads via getEnvVar(secretRef) — never hard-codes a key value
    check(
      "11a المهيئات لا تكشف مفاتيح (secretRef أسماء فقط، عبر getEnvVar)",
      secretRefNames.every((n) => aiSource.includes(n)) &&
        !/sk-[A-Za-z0-9]{20,}/.test(aiSource),
    );
    // Prompt never contains a secret
    check(
      "11b الموجه لا يحتوي سراً",
      !/sk-|Bearer/.test(prompt.AI_SYSTEM_INSTRUCTIONS),
    );
    void hasProcessEnvSecret;
    // No NEXT_PUBLIC secret
    const hasNextPublic = aiSource.includes("NEXT_PUBLIC");
    check("11c لا NEXT_PUBLIC secret في طبقة المهيئات", !hasNextPublic);
  }

  // ── CONFIG_ERROR is not retried ──────────────────────────────────────────
  {
    const primary = openrouter.createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar,
      fetchImpl: mockFetchOnce(401, { error: { message: "unauthorized" } }),
    });
    const secondary = agentrouter.createAgentRouterAdapter({
      model: "auto",
      getEnvVar,
      fetchImpl: mockFetchOnce(200, openAiEnvelope(validAiResponseJson())),
    });
    const orch = orchestrator.createAiOrchestrator({
      primary,
      secondary,
      fallbackEnabled: true,
    });
    const res = await orch.callWithFallback(baseRequest);
    check(
      "CONFIG_ERROR (401) لا يُعاد المحاولة حتى مع fallback مفعّل",
      res.response === null &&
        res.telemetry.attempts[0]?.errorCode === "CONFIG_ERROR" &&
        res.telemetry.fallbackUsed === false,
    );
  }

  // ── missing API key → CONFIG_ERROR ───────────────────────────────────────
  {
    const primary = openrouter.createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar: () => undefined,
      fetchImpl: mockFetchOnce(200, openAiEnvelope(validAiResponseJson())),
    });
    const orch = orchestrator.createAiOrchestrator({
      primary,
      secondary: null,
      fallbackEnabled: false,
    });
    const res = await orch.callWithFallback(baseRequest);
    check(
      "env مفقود → CONFIG_ERROR",
      res.telemetry.attempts[0]?.errorCode === "CONFIG_ERROR",
    );
  }

  // ── no raw secrets in telemetry ──────────────────────────────────────────
  {
    const primary = openrouter.createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar,
      fetchImpl: mockFetchOnce(
        200,
        openAiEnvelope(validAiResponseJson(), {
          prompt_tokens: 1,
          completion_tokens: 1,
        }),
      ),
    });
    const orch = orchestrator.createAiOrchestrator({
      primary,
      secondary: null,
      fallbackEnabled: false,
    });
    const res = await orch.callWithFallback(baseRequest);
    const telemetryJson = JSON.stringify(res.telemetry);
    check(
      "telemetry لا يحتوي مفاتيح (لا sk- ولا Bearer)",
      !/sk-/.test(telemetryJson) && !/Bearer/.test(telemetryJson),
    );
  }

  // ── non-TEXT / engine still safe: endpoints are parameterized ────────────
  {
    const customEndpoint = "https://example.test/v1/chat/completions";
    const adapter = openrouter.createOpenRouterAdapter({
      model: "m",
      getEnvVar,
      fetchImpl: (async (url: string) => {
        // ensure the endpoint override is honored
        if (url !== customEndpoint) {
          return new Response(
            JSON.stringify({ error: { message: "wrong endpoint" } }),
            { status: 500 },
          );
        }
        return new Response(
          JSON.stringify(openAiEnvelope(validAiResponseJson())),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
      endpoint: customEndpoint,
    });
    const res = await adapter.call(baseRequest);
    check("endpoint قابل للتهيئة (للفحص دون شبكة)", res.ok === true);
  }

  // ── static scan: no live network in orchestrator/factory ─────────────────
  {
    const scanFiles = [
      "src/server/integrations/ai/orchestrator.ts",
      "src/server/integrations/ai/factory.ts",
      "src/server/integrations/ai/conversation-ai.ts",
    ];
    const hit = scanFiles.some((f) => {
      try {
        const c = readFileSync(join(process.cwd(), f), "utf8");
        return /fetch\s*\(/.test(c) && !c.includes("fetchImpl");
      } catch {
        return false;
      }
    });
    check(
      "المُنسّق/المصنع لا يستدعي fetch مباشرة (عبر حقن fetchImpl فقط)",
      !hit,
    );
  }

  let failed = 0;
  for (const { label, pass } of checks) {
    if (pass) console.log(`✔ ${label}`);
    else {
      console.error(`✘ ${label}`);
      failed += 1;
    }
  }
  if (failed > 0) {
    console.error(`\nفشل ${failed} من ${checks.length} فحص.`);
    process.exit(1);
  }
  console.log(
    `\nثوابت مزود الذكاء صحيحة: ${checks.length}/${checks.length} فحص ناجح.`,
  );
}

main().catch((error: Error) => {
  console.error(`فشل غير متوقع: ${error.message}`);
  if (error.stack) console.error(error.stack);
  process.exit(1);
});
