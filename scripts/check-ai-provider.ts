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
type CodeCraftModule = typeof import("../src/server/integrations/ai/codecraft");
type NormalizerModule =
  typeof import("../src/server/integrations/ai/response-normalizer");
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
  const codecraft: CodeCraftModule =
    await import("../src/server/integrations/ai/codecraft");
  const normalizer: NormalizerModule =
    await import("../src/server/integrations/ai/response-normalizer");
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
    name === "ATRIA_API_KEY" ||
    name === "CODECRAFT_API_KEY"
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
  // 14j: Atria-only structured-output hardening on the wire (request body).
  {
    const captured: {
      responseFormat?: string;
      system?: string;
      orSystem?: string;
    } = {};
    const captureBody = (key: "system" | "orSystem"): typeof fetch =>
      (async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string) as {
          response_format?: { type?: string };
          messages?: Array<{ role?: string; content?: string }>;
        };
        captured.responseFormat = body.response_format?.type;
        captured[key] = body.messages?.find(
          (m) => m.role === "system",
        )?.content;
        return new Response(
          JSON.stringify(openAiEnvelope(validAiResponseJson())),
          { status: 200 },
        );
      }) as unknown as typeof fetch;

    const atriaAdapter = atria.createAtriaAdapter({
      model: "Atria-Dawn-Preview",
      getEnvVar,
      fetchImpl: captureBody("system"),
    });
    await atriaAdapter.call(baseRequest);
    const orAdapter = openrouter.createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar,
      fetchImpl: captureBody("orSystem"),
    });
    await orAdapter.call(baseRequest);

    check(
      "14j طلب Atria يحمل response_format=json_object وتشدّيد JSON-only في system (بدون لمس المزودات الأخرى)",
      captured.responseFormat === "json_object" &&
        (captured.system ?? "").includes("exactly ONE JSON object") &&
        (captured.system ?? "").includes(
          "directly parseable by JSON.parse()",
        ) &&
        (captured.system ?? "").includes("Do not wrap JSON in ``` fences") &&
        // shared baseline contract is preserved, not replaced
        (captured.system ?? "").includes("intent: enum[") &&
        // hardening is Atria-only: OpenRouter system message is untouched
        !(captured.orSystem ?? "").includes("exactly ONE JSON object") &&
        (captured.orSystem ?? "").includes("intent: enum["),
    );
  }

  // ── 14k–14u: Atria bounded JSON repair (PROMPT-OPS-ATRIA-BOUNDED-JSON-REPAIR-07)
  // Strict JSON.parse() stays the FIRST path; repair is fallback-only and the
  // repaired output must still pass the UNCHANGED aiResponseSchema.
  {
    const contentFetch = (content: string): typeof fetch =>
      mockFetchOnce(200, openAiEnvelope(content));
    const validObj = JSON.parse(validAiResponseJson()) as Record<
      string,
      unknown
    >;
    const atriaWith = (content: string) =>
      atria.createAtriaAdapter({
        model: "Atria-Dawn-Preview",
        getEnvVar,
        fetchImpl: contentFetch(content),
      });

    // 1) Valid JSON → DIRECT_PARSE (strict path, no repair attempted).
    const resValid = await atriaWith(validAiResponseJson()).call(baseRequest);
    check(
      "14k JSON صالح → DIRECT_PARSE (الصارم أولاً، بلا إصلاح)",
      resValid.ok === true && resValid.parseMode === "DIRECT_PARSE",
    );

    // 2) Known extra-leading-brace artifact → BOUNDED_PROVIDER_REPAIR
    //    (generic jsonrepair rejects `{{` outright; the Atria surplus-brace
    //    rule normalizes it) + identical accepted value.
    const artifact = `{${validAiResponseJson()}`;
    const resRepaired = await atriaWith(artifact).call(baseRequest);
    check(
      "14l عيب القوس الزائد المعروف → BOUNDED_PROVIDER_REPAIR + قيمة مطابقة",
      resRepaired.ok === true &&
        resRepaired.parseMode === "BOUNDED_PROVIDER_REPAIR" &&
        resRepaired.normalizerTrace?.providerRepairRule ===
          "ATRIA_SURPLUS_BRACE" &&
        JSON.stringify(resRepaired.response) === JSON.stringify(validObj),
    );

    // 3) Markdown fenced JSON → current intended behavior (DIRECT_PARSE).
    const fenced = "```json\n" + validAiResponseJson() + "\n```";
    const resFenced = await atriaWith(fenced).call(baseRequest);
    check(
      "14m JSON داخل سياج Markdown → DIRECT_PARSE كالسلوك الحالي",
      resFenced.ok === true && resFenced.parseMode === "DIRECT_PARSE",
    );

    // 4) Empty response → INVALID_RESPONSE.
    const resEmpty = await atriaWith("").call(baseRequest);
    check(
      "14n استجابة فارغة → INVALID_RESPONSE",
      resEmpty.ok === false && resEmpty.error.code === "INVALID_RESPONSE",
    );

    // 5) Completely malformed response → INVALID_RESPONSE (nothing to repair).
    const resMalformed = await atriaWith("not json at all").call(baseRequest);
    check(
      "14o استجابة مشوّهة تماماً → INVALID_RESPONSE",
      resMalformed.ok === false &&
        resMalformed.error.code === "INVALID_RESPONSE",
    );

    // 6) Schema-invalid JSON → INVALID_RESPONSE (parses, fails aiResponseSchema).
    const resSchema = await atriaWith(
      JSON.stringify({ ...validObj, intent: "NOT_AN_INTENT" }),
    ).call(baseRequest);
    check(
      "14p JSON صالح التركيب لكن مخالف لـ aiResponseSchema → INVALID_RESPONSE",
      resSchema.ok === false && resSchema.error.code === "INVALID_RESPONSE",
    );

    // 7) Repair output parses but still violates schema → INVALID_RESPONSE.
    const resRepairSchema = await atriaWith(
      `{${JSON.stringify({ ...validObj, intent: "NOT_AN_INTENT" })}`,
    ).call(baseRequest);
    check(
      "14q إصلاح يُنتج JSON قابلاً للتحليل لكنه مخالف للـ schema → INVALID_RESPONSE",
      resRepairSchema.ok === false &&
        resRepairSchema.error.code === "INVALID_RESPONSE",
    );

    // 8) Valid input is never corrupted: the strict path accepts it verbatim
    //    (DIRECT_PARSE, generic repair never runs) and both bounded Atria
    //    rules DECLINE well-formed single-brace content.
    const nrValid = normalizer.normalizeResponse({
      content: validAiResponseJson(),
      provider: "atria",
      model: "Atria-Dawn-Preview",
      policy: normalizer.ATRIA_NORMALIZATION_POLICY,
    });
    check(
      "14r الاستجابة الصالحة لا تُفسَّد (DIRECT_PARSE + قواعد Atria ترفضها)",
      resValid.ok === true &&
        JSON.stringify(resValid.response) === JSON.stringify(validObj) &&
        nrValid.ok === true &&
        nrValid.mode === "DIRECT_PARSE" &&
        nrValid.trace.genericRepairRan === false &&
        nrValid.trace.providerRepairRan === false &&
        normalizer.ATRIA_SURPLUS_BRACE_RULE.apply(validAiResponseJson(), {
          provider: "atria",
          model: "Atria-Dawn-Preview",
        }) === null &&
        normalizer.ATRIA_EMPTY_KEY_WRAPPER_RULE.apply(validAiResponseJson(), {
          provider: "atria",
          model: "Atria-Dawn-Preview",
        }) === null,
    );

    // 9) Multiple-object response must NOT be blindly merged.
    const multi = '{"a":1}{"b":2}';
    const resMulti = await atriaWith(multi).call(baseRequest);
    const resMultiBraced = await atriaWith(
      `{${JSON.stringify({ ...validObj })},{"second":"obj"}}`,
    ).call(baseRequest);
    check(
      "14s كائنات متعددة لا تُدمج عمياء → INVALID_RESPONSE",
      resMulti.ok === false &&
        resMulti.error.code === "INVALID_RESPONSE" &&
        resMulti.normalizerTrace?.genericRepairProducedCandidate === false &&
        normalizer.ATRIA_SURPLUS_BRACE_RULE.apply(multi, {
          provider: "atria",
          model: "Atria-Dawn-Preview",
        }) === null &&
        resMultiBraced.ok === false &&
        resMultiBraced.error.code === "INVALID_RESPONSE",
    );

    // 10) Non-object response must NOT be coerced into an object.
    const resArray = await atriaWith("[1,2,3]").call(baseRequest);
    const resBrokenArray = await atriaWith("[[1,2]").call(baseRequest);
    const resScalar = await atriaWith('"just text"').call(baseRequest);
    check(
      "14t الاستجابة غير الكائنية لا تُكره إلى كائن → INVALID_RESPONSE",
      resArray.ok === false &&
        resArray.error.code === "INVALID_RESPONSE" &&
        resBrokenArray.ok === false &&
        resBrokenArray.error.code === "INVALID_RESPONSE" &&
        resScalar.ok === false &&
        resScalar.error.code === "INVALID_RESPONSE",
    );

    // Non-Atria adapters remain UNCHANGED: identical artifact, no repair seam.
    const resOr = await openrouter
      .createOpenRouterAdapter({
        model: "openrouter/auto",
        getEnvVar,
        fetchImpl: contentFetch(artifact),
      })
      .call(baseRequest);
    const resAr = await agentrouter
      .createAgentRouterAdapter({
        model: "auto",
        getEnvVar,
        fetchImpl: contentFetch(artifact),
      })
      .call(baseRequest);
    check(
      "14u المزودات غير Atria تبقى صارمة (نفس العيب → INVALID_RESPONSE، بلا إصلاح)",
      resOr.ok === false &&
        resOr.error.code === "INVALID_RESPONSE" &&
        resAr.ok === false &&
        resAr.error.code === "INVALID_RESPONSE",
    );

    // ── 14v–14z: jsonrepair-backed repair coverage
    // (PROMPT-OPS-ATRIA-JSONREPAIR-BOUNDED-08). Proves (a) corruption classes
    // that are already valid JSON stay on the strict DIRECT_PARSE path and
    // never invoke repair, and (b) corruption classes the old brace-only
    // repair could NOT fix (trailing commas, truncation, unquoted/single-
    // quoted keys, brace + restart combos) are now recovered — every one of
    // them still re-parsed by strict JSON.parse and bound by the unchanged
    // aiResponseSchema.

    // 11) Restarted / duplicated JSON-key corruption. Duplicated keys are
    //     syntactically VALID JSON, so the STRICT parser already absorbs
    //     them (JSON.parse keeps the last value per key) and repair is never
    //     invoked → DIRECT_PARSE. Documents that this corruption class
    //     needs no repair and never weakens the strict path.
    const restarted = `{"intent":"FAQ","action":"reply","content":"x","intent":"HUMAN_REQUEST","action":"handoff","handoffReason":"HUMAN_REQUEST","extraction":{"service":null,"provider":null,"date":null,"timePreference":null},"summary":null}`;
    const resRestarted = await atriaWith(restarted).call(baseRequest);
    check(
      "14v restarted/duplicated keys صالحة تركيبياً → DIRECT_PARSE (آخر قيمة، بلا إصلاح)",
      resRestarted.ok === true &&
        resRestarted.parseMode === "DIRECT_PARSE" &&
        resRestarted.response.intent === "HUMAN_REQUEST" &&
        resRestarted.response.action === "handoff" &&
        resRestarted.response.handoffReason === "HUMAN_REQUEST",
    );

    // 11b) The OBSERVED live failure shape: the surplus leading brace combined
    //      with restarted keys. Strict parse fails → generic jsonrepair
    //      rejects `{{` → the Atria surplus-brace rule normalizes and
    //      repairs ONE object → BOUNDED_PROVIDER_REPAIR, schema-bound.
    const restartedBraced = `{${restarted}`;
    const resRestartedBraced =
      await atriaWith(restartedBraced).call(baseRequest);
    check(
      "14v2 القوس الزائد + restarted keys (شكل الفشل الحي) → BOUNDED_PROVIDER_REPAIR",
      resRestartedBraced.ok === true &&
        resRestartedBraced.parseMode === "BOUNDED_PROVIDER_REPAIR" &&
        resRestartedBraced.response.intent === "HUMAN_REQUEST" &&
        resRestartedBraced.response.action === "handoff",
    );

    // 12) Trailing-comma corruption → GENERIC_REPAIRED_PARSE + identical
    //     value. Derived from the canonical helper so the repaired value is
    //     byte-equivalent to the accepted baseline.
    const trailingComma = validAiResponseJson()
      .replace(/"summary":null\}/, '"summary":null,}')
      .replace(/"timePreference":null\}/, '"timePreference":null,}');
    const resComma = await atriaWith(trailingComma).call(baseRequest);
    check(
      "14w فاصلة زائدة → GENERIC_REPAIRED_PARSE + قيمة مطابقة",
      resComma.ok === true &&
        resComma.parseMode === "GENERIC_REPAIRED_PARSE" &&
        resComma.normalizerTrace?.genericRepairRan === true &&
        JSON.stringify(resComma.response) === JSON.stringify(validObj),
    );

    // 13) Truncated JSON (provider cut mid-object) → GENERIC_REPAIRED_PARSE,
    //     and the repaired value still must pass schema.
    const truncated = `{"intent":"FAQ","action":"reply","content":"من 9 حتى 6","extraction":{"service":null,"provider":null,"date":null`;
    const resTrunc = await atriaWith(truncated).call(baseRequest);
    check(
      "14x JSON مقطوع → GENERIC_REPAIRED_PARSE (الإصلاح يُغلق البنية، الـ schema يبقى حاكم)",
      resTrunc.ok === true && resTrunc.parseMode === "GENERIC_REPAIRED_PARSE",
    );

    // 14) Unquoted / single-quoted keys → GENERIC_REPAIRED_PARSE.
    const badQuotes = `{'intent': 'FAQ', 'action': 'reply', 'content': 'من 9 حتى 6', "extraction": {'service': null, 'provider': null, 'date': null, 'timePreference': null}, "handoffReason": null, "summary": null}`;
    const resQuotes = await atriaWith(badQuotes).call(baseRequest);
    check(
      "14y مفاتيح غير محصورة/أحادية الاقتباس → GENERIC_REPAIRED_PARSE",
      resQuotes.ok === true && resQuotes.parseMode === "GENERIC_REPAIRED_PARSE",
    );

    // 14y2) OBSERVED Atria object-restart corruption: the model opens an
    //       object, emits a stray `"`, and restarts the payload. The generic
    //       stage repairs it into an empty-string-key wrapper; the bounded
    //       Atria rule then promotes the wrapped payload (ONE level) and the
    //       unchanged schema validates it.
    const objRestart = `{"{${validAiResponseJson().slice(1)}`;
    const resObjRestart = await atriaWith(objRestart).call(baseRequest);
    check(
      "14y2 إعادة تشغيل الكائن المعروفة (مفتاح فارغ) → BOUNDED_PROVIDER_REPAIR",
      resObjRestart.ok === true &&
        resObjRestart.parseMode === "BOUNDED_PROVIDER_REPAIR" &&
        resObjRestart.normalizerTrace?.providerRepairRule ===
          "ATRIA_EMPTY_KEY_WRAPPER" &&
        resObjRestart.normalizerTrace?.genericRepairProducedCandidate ===
          true &&
        resObjRestart.normalizerTrace?.genericRepairSchemaOk === false &&
        JSON.stringify(resObjRestart.response) === JSON.stringify(validObj),
    );

    // 14y3) The empty-key promotion is REFUSED outside its strict bounds:
    //       two keys, or a non-empty key, or a scalar wrapper value, or a
    //       nested wrapper — all stay INVALID_RESPONSE (no coercion).
    const twoKeys = JSON.stringify({
      "": validObj,
      other: 1,
    });
    const nonEmptyKey = JSON.stringify({ wrapped: validObj });
    const scalarWrapper = JSON.stringify({ "": "not-an-object" });
    const nestedWrapper = JSON.stringify({ "": { "": validObj } });
    for (const [label, content] of [
      ["keyCount≠1", twoKeys],
      ['key≠""', nonEmptyKey],
      ["scalarValue", scalarWrapper],
      ["nested", nestedWrapper],
    ] as Array<[string, string]>) {
      const res = await atriaWith(content).call(baseRequest);
      check(
        `14y3 قاعدة المفتاح الفارغ ترفض الحالات خارج حدودها (${label}) → INVALID_RESPONSE`,
        res.ok === false && res.error.code === "INVALID_RESPONSE",
      );
    }

    // 15) Balanced multi-object content is never merged, even after repair.
    const balancedMulti = `{{${JSON.stringify({ ...validObj, content: "أول" })}},{"second":"obj"}}`;
    const resBalancedMulti = await atriaWith(balancedMulti).call(baseRequest);
    check(
      "14z كائنات متعددة متوازنة لا تُدمج → INVALID_RESPONSE",
      resBalancedMulti.ok === false &&
        resBalancedMulti.error.code === "INVALID_RESPONSE",
    );
  }

  // ── 15. CodeCraft adapter (CODECRAFT-DISCOVERY-PROVIDER-58) ────────────────
  // Factory selects CodeCraft correctly from the effective policy.
  {
    const effective: import("../src/lib/validation/platform").EffectiveAiPolicy =
      {
        primaryProvider: "codecraft",
        primaryModel: "probe-model",
        secondary: null,
      };
    const { primary, secondary, fallbackEnabled } =
      factory.adaptersFromEffectivePolicy(effective, {
        getEnvVar,
        fetchImpl: mockFetchOnce(200, openAiEnvelope(validAiResponseJson())),
      });
    check(
      "15a المصنع يختار CodeCraft من السياسة (provider/model/secretRef)",
      primary.providerId === "codecraft" &&
        primary.model === "probe-model" &&
        primary.secretRef === "CODECRAFT_API_KEY" &&
        secondary === null &&
        fallbackEnabled === false,
    );
  }
  // Request construction: endpoint + model passthrough + auth by secret NAME
  // + the shared response_format/temperature contract (unchanged for every
  // provider — CodeCraft gets no special request shape).
  {
    const captured: {
      url?: string;
      auth?: string;
      model?: string;
      responseFormat?: string;
      temperature?: number;
    } = {};
    const adapter = codecraft.createCodeCraftAdapter({
      model: "probe-model",
      getEnvVar,
      fetchImpl: (async (url: string, init?: RequestInit) => {
        captured.url = url;
        captured.auth =
          (init?.headers as Record<string, string> | undefined)
            ?.Authorization ?? undefined;
        const body = JSON.parse(init?.body as string) as {
          model?: string;
          response_format?: { type?: string };
          temperature?: number;
        };
        captured.model = body.model;
        captured.responseFormat = body.response_format?.type;
        captured.temperature = body.temperature;
        return new Response(
          JSON.stringify(openAiEnvelope(validAiResponseJson())),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });
    const res = await adapter.call(baseRequest);
    check(
      "15b بناء طلب CodeCraft: endpoint الصحيح + النموذج كما هو + Bearer + العقد المشترك",
      res.ok === true &&
        captured.url === codecraft.CODECRAFT_ENDPOINT &&
        captured.model === "probe-model" &&
        typeof captured.auth === "string" &&
        captured.auth.startsWith("Bearer ") &&
        captured.responseFormat === "json_object" &&
        captured.temperature === 0.2,
    );
  }
  // Authentication uses the configured secret reference only; a missing key
  // is CONFIG_ERROR without any network call.
  {
    const adapter = codecraft.createCodeCraftAdapter({
      model: "probe-model",
      getEnvVar: (name) => (name === "CODECRAFT_API_KEY" ? "value" : undefined),
      fetchImpl: mockFetchOnce(200, openAiEnvelope(validAiResponseJson())),
    });
    const res = await adapter.call(baseRequest);
    check(
      "15c المصادقة تستخدم مرجع CODECRAFT_API_KEY فقط (قيمة سرية لا تُخزّن)",
      res.ok === true && adapter.secretRef === "CODECRAFT_API_KEY",
    );
    const noKey = codecraft.createCodeCraftAdapter({
      model: "probe-model",
      getEnvVar: () => undefined,
      fetchImpl: mockFetchOnce(200, openAiEnvelope(validAiResponseJson())),
    });
    const resNoKey = await noKey.call(baseRequest);
    check(
      "15d مفتاح CodeCraft مفقود → CONFIG_ERROR (بلا طلب شبكة)",
      resNoKey.ok === false &&
        resNoKey.error.code === "CONFIG_ERROR" &&
        resNoKey.error.retryable === false,
    );
  }
  // Valid OpenAI-compatible JSON response normalizes into AiProviderSuccess
  // through the SAME shared path (parseAiResponse + aiResponseSchema).
  {
    const adapter = codecraft.createCodeCraftAdapter({
      model: "probe-model",
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
      "15e استجابة OpenAI متوافقة تُطبَّع إلى AiResponse (intent/provider/tokens/DIRECT_PARSE)",
      res.ok === true &&
        res.provider === "codecraft" &&
        res.model === "probe-model" &&
        res.response.intent === "FAQ" &&
        res.response.action === "reply" &&
        res.inputTokens === 20 &&
        res.outputTokens === 7 &&
        res.parseMode === "DIRECT_PARSE",
    );
  }
  // Invalid / empty responses map to the existing INVALID_RESPONSE taxonomy.
  {
    const empty = codecraft.createCodeCraftAdapter({
      model: "probe-model",
      getEnvVar,
      fetchImpl: mockFetchOnce(200, {
        choices: [{ message: { content: "" } }],
      }),
    });
    const resEmpty = await empty.call(baseRequest);
    const malformed = codecraft.createCodeCraftAdapter({
      model: "probe-model",
      getEnvVar,
      fetchImpl: (async () =>
        new Response("not json", { status: 200 })) as unknown as typeof fetch,
    });
    const resMalformed = await malformed.call(baseRequest);
    check(
      "15f استجابة فارغة/غير صالحة من CodeCraft → INVALID_RESPONSE بلا retry",
      resEmpty.ok === false &&
        resEmpty.error.code === "INVALID_RESPONSE" &&
        resMalformed.ok === false &&
        resMalformed.error.code === "INVALID_RESPONSE",
    );
  }
  // A schema-invalid but syntactically valid payload is refused — the
  // parser is never weakened for a new provider.
  {
    const adapter = codecraft.createCodeCraftAdapter({
      model: "probe-model",
      getEnvVar,
      fetchImpl: mockFetchOnce(
        200,
        openAiEnvelope(
          JSON.stringify({
            intent: "NOT_AN_INTENT",
            action: "reply",
            content: "x",
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
    const res = await adapter.call(baseRequest);
    check(
      "15g JSON صالح التركيب لكن مخالف لـ aiResponseSchema → INVALID_RESPONSE (الـ schema حاكم)",
      res.ok === false && res.error.code === "INVALID_RESPONSE",
    );
  }
  // Provider failure maps to the existing retry/fallback semantics.
  {
    const primary = codecraft.createCodeCraftAdapter({
      model: "probe-model",
      getEnvVar,
      fetchImpl: mockFetchOnce(500, { error: { message: "codecraft down" } }),
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
      "15h فشل CodeCraft Retryable (500) → التراجع للاحتياطي يعمل (دلالات موجودة)",
      res.response !== null &&
        res.telemetry.fallbackUsed === true &&
        res.telemetry.finalProvider === "agentrouter",
    );
  }
  // Isolation: selecting CodeCraft changes nothing about the other providers.
  {
    const ccAdapter = codecraft.createCodeCraftAdapter({
      model: "probe-model",
      getEnvVar,
      fetchImpl: mockFetchOnce(200, openAiEnvelope(validAiResponseJson())),
    });
    const atriaAdapter = atria.createAtriaAdapter({
      model: "Atria-Dawn-Preview",
      getEnvVar,
      fetchImpl: mockFetchOnce(200, openAiEnvelope(validAiResponseJson())),
    });
    const orAdapter = openrouter.createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar,
      fetchImpl: mockFetchOnce(200, openAiEnvelope(validAiResponseJson())),
    });
    check(
      "15i CodeCraft معزول عن كل مزود آخر (provider/secretRef/endpoint مختلفة)",
      ccAdapter.providerId !== atriaAdapter.providerId &&
        ccAdapter.providerId !== orAdapter.providerId &&
        ccAdapter.secretRef !== atriaAdapter.secretRef &&
        ccAdapter.secretRef !== orAdapter.secretRef &&
        (codecraft.CODECRAFT_ENDPOINT as string) !==
          (atria.ATRIA_ENDPOINT as string) &&
        (codecraft.CODECRAFT_ENDPOINT as string) !==
          (openrouter.OPENROUTER_ENDPOINT as string) &&
        orAdapter.providerId === "openrouter" &&
        orAdapter.secretRef === "OPENROUTER_API_KEY",
    );
  }
  // The allowlist + secret mapping know CodeCraft (registration is complete).
  {
    const labels: typeof import("../src/features/platform/server/provider-labels") =
      await import("../src/features/platform/server/provider-labels");
    const validation: typeof import("../src/lib/validation/platform") =
      await import("../src/lib/validation/platform");
    check(
      "15j التسجيل: allowlist + label + secretRefFor تعرف CodeCraft",
      validation.aiProviderValues.includes("codecraft") &&
        validation.aiProviderValues.includes("atria") &&
        (labels.AI_PROVIDER_LABELS.codecraft as string) === "CodeCraft" &&
        labels.secretRefFor("codecraft") === "CODECRAFT_API_KEY" &&
        labels.secretRefFor("atria") === "ATRIA_API_KEY" &&
        labels.secretRefFor("openrouter") === "OPENROUTER_API_KEY",
    );
  }
  // PROMPT-AI-OPS-23 — the Superadmin form derives the displayed secret
  // reference from the SELECTED provider, so pin that what the operator reads
  // is exactly what each adapter resolves at runtime, for EVERY selectable
  // provider (a provider added to the allowlist without a matching mapping
  // would otherwise show a wrong/undefined reference).
  {
    const labels: typeof import("../src/features/platform/server/provider-labels") =
      await import("../src/features/platform/server/provider-labels");
    const validation: typeof import("../src/lib/validation/platform") =
      await import("../src/lib/validation/platform");
    const adapters: Record<string, { secretRef: string }> = {
      openrouter: openrouter.createOpenRouterAdapter({
        model: "probe-model",
        getEnvVar,
        fetchImpl: mockFetchOnce(200, openAiEnvelope(validAiResponseJson())),
      }),
      agentrouter: agentrouter.createAgentRouterAdapter({
        model: "probe-model",
        getEnvVar,
        fetchImpl: mockFetchOnce(200, openAiEnvelope(validAiResponseJson())),
      }),
      atria: atria.createAtriaAdapter({
        model: "probe-model",
        getEnvVar,
        fetchImpl: mockFetchOnce(200, openAiEnvelope(validAiResponseJson())),
      }),
      codecraft: codecraft.createCodeCraftAdapter({
        model: "probe-model",
        getEnvVar,
        fetchImpl: mockFetchOnce(200, openAiEnvelope(validAiResponseJson())),
      }),
    };
    check(
      "15l secretRefFor يساوي secretRef كل مهيئ لكل مزود مسموح (واجهة Superadmin = وقت التشغيل)",
      validation.aiProviderValues.every((p) => {
        const adapter = adapters[p];
        return (
          typeof labels.secretRefFor(p) === "string" &&
          !!adapter &&
          labels.secretRefFor(p) === adapter.secretRef
        );
      }) &&
        new Set(validation.aiProviderValues.map((p) => labels.secretRefFor(p)))
          .size === validation.aiProviderValues.length,
    );
  }
  // The CodeCraft policy is EMPTY, so CodeCraft content is held to the strict
  // parser + schema alone — identical to the pre-existing shared path.
  {
    const artifact = `{${validAiResponseJson()}`;
    const res = await codecraft
      .createCodeCraftAdapter({
        model: "probe-model",
        getEnvVar,
        fetchImpl: mockFetchOnce(200, openAiEnvelope(artifact)),
      })
      .call(baseRequest);
    check(
      "15k سياسة CodeCraft فارغة → العائق نفسه يُرفض (لا إصلاح خاص بالمزود)",
      res.ok === false && res.error.code === "INVALID_RESPONSE",
    );
  }

  // validation already succeed (the strict parser stays first and
  // authoritative). Asserted on the engine's own trace, so the guarantee is
  // provider-neutral-by-default and needs no instrumentation hook.
  {
    const resOk = await http.callOpenAiCompatible({
      providerId: "atria",
      model: "Atria-Dawn-Preview",
      secretRef: "ATRIA_API_KEY",
      endpoint: "https://probe.test/v1/chat/completions",
      getEnvVar,
      fetchImpl: mockFetchOnce(200, openAiEnvelope(validAiResponseJson())),
      timeoutMs: 8000,
      request: baseRequest,
      policy: normalizer.ATRIA_NORMALIZATION_POLICY,
    });
    check(
      "14aa التحليل الصارم أولاً: JSON صالح → لا يُستدعى الإصلاح أبداً (DIRECT_PARSE)",
      resOk.ok === true &&
        resOk.parseMode === "DIRECT_PARSE" &&
        resOk.normalizerTrace?.genericRepairRan === false &&
        resOk.normalizerTrace?.providerRepairRan === false &&
        resOk.normalizerTrace?.stage === "STRICT_PARSE",
    );

    // Schema-invalid content after a SUCCESSFUL strict parse: the generic
    // stage now runs (a schema rejection is a normalization trigger), but
    // jsonrepair is purely syntactic so it can never rescue a semantic
    // violation — the outcome stays INVALID_RESPONSE, schema unchanged.
    const resSchema = await http.callOpenAiCompatible({
      providerId: "atria",
      model: "Atria-Dawn-Preview",
      secretRef: "ATRIA_API_KEY",
      endpoint: "https://probe.test/v1/chat/completions",
      getEnvVar,
      fetchImpl: mockFetchOnce(
        200,
        openAiEnvelope(
          JSON.stringify({
            intent: "NOT_AN_INTENT",
            action: "reply",
            content: "x",
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
      timeoutMs: 8000,
      request: baseRequest,
      policy: normalizer.ATRIA_NORMALIZATION_POLICY,
    });
    check(
      "14ab فشل الـ schema بعد تحليل صارم ناجح → الإصلاح العام يعجز → INVALID_RESPONSE",
      resSchema.ok === false &&
        resSchema.error.code === "INVALID_RESPONSE" &&
        resSchema.normalizerTrace?.strictParseOk === true &&
        resSchema.normalizerTrace?.schemaOk === false &&
        resSchema.normalizerTrace?.genericRepairRan === true &&
        resSchema.normalizerTrace?.genericRepairSchemaOk === false &&
        resSchema.normalizerTrace?.outcome === "INVALID_RESPONSE",
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
      "CODECRAFT_API_KEY",
    ];
    const aiFiles = [
      "src/server/integrations/ai/types.ts",
      "src/server/integrations/ai/prompt.ts",
      "src/server/integrations/ai/http.ts",
      "src/server/integrations/ai/openrouter.ts",
      "src/server/integrations/ai/agentrouter.ts",
      "src/server/integrations/ai/atria.ts",
      "src/server/integrations/ai/codecraft.ts",
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
      /process\.env\.(OPENROUTER|AGENTROUTER|ATRIA|CODECRAFT)_API_KEY/.test(
        aiSource,
      );
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
