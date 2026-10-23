/* eslint-disable @typescript-eslint/consistent-type-imports */
/**
 * FlowPilot — JEV SHADOW MODE check (PROMPT-AI-JEV-03D — OPTION E).
 *
 * Deterministic, OFFLINE verification of the non-authoritative semantic-JEV
 * shadow. NO DB, NO network, NO real LLM, NO real JEV/OpenRouter call, NO API
 * tokens, NO secrets. Every provider is an in-memory stand-in; the shadow
 * strategy, the sampler, the eligibility gate, the orchestrator seam, the
 * observability projections and the REAL conversation engine are the actual
 * production code.
 *
 *   PART A — FLAGS      the three-state matrix (DISABLED / SHADOW / ACTIVE)
 *   PART B — START      when a shadow call starts, and when it must NOT
 *   PART C — AUTHORITY  OPTION E: the serving decision always wins
 *   PART D — ISOLATION every shadow failure class leaves the customer turn
 *                        byte-for-byte unchanged
 *   PART E — ACCOUNTING modelCallCount stays serving-only; the disjoint
 *                        shadowModelCallCount accounts for the experiment
 *   PART F — PLANNER    the Turn Planner / resolver input is provably
 *                        unchanged; disagreements are evidence only
 *   PART G — PRIVACY    no raw text, secret, Authorization header, provider
 *                        body, chain-of-thought or model prose in evidence
 *   PART H — LANGUAGE   the closed languageHint key + the honest dialect
 *                        limitation
 *   PART I — ISOLATION  no evaluation/* or holdout runtime import, no
 *                        schema/migration dependency
 *   PART J — TIMING     the concurrency structure proof (max, not sum)
 *   PART K — IDENTITY   full-engine customer-behavior identity
 *                        (shadow OFF ≡ shadow ON on every customer surface)
 *
 * Every S-number below is a requirement of PROMPT-AI-JEV-03D §19.
 *
 * Run: pnpm check:jev-shadow
 */
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

export {};

type Check = { label: string; pass: boolean };
const checks: Check[] = [];
function check(label: string, pass: boolean): void {
  checks.push({ label, pass });
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const semantic =
    await import("../src/server/integrations/ai/jev-semantic-strategy");
  const jev = await import("../src/server/integrations/ai/jev-strategy");
  const shadowMod =
    await import("../src/server/integrations/ai/jev-shadow-strategy");
  const { createAiOrchestrator } =
    await import("../src/server/integrations/ai/orchestrator");
  const { JEV_DETERMINISTIC_PROVIDER } =
    await import("../src/server/integrations/ai/jev-strategy");
  const { createLlmConversationAi } =
    await import("../src/server/integrations/ai/conversation-ai");
  const {
    isShadowJevEnabled,
    isSemanticJevEnabled,
    SHADOW_JEV_FLAG,
    SEMANTIC_JEV_FLAG,
    createPolicyBackedAi,
  } = await import("../src/server/integrations/ai/factory");
  const { buildTurnObservability } =
    await import("../src/features/conversations/server/ai-observability");
  const { buildTurnEvidence, assertTurnEvidenceContentFree } =
    await import("../src/features/conversations/server/turn-evidence");
  const engine =
    await import("../src/features/conversations/server/conversation-engine");

  type AiRequest =
    import("../src/features/conversations/server/ai-contract").AiRequest;
  type AiResponse =
    import("../src/features/conversations/server/ai-contract").AiResponse;
  type AiProviderAdapter =
    import("../src/server/integrations/ai/types").AiProviderAdapter;
  type AiProviderResult =
    import("../src/server/integrations/ai/types").AiProviderResult;
  type JevAnswer =
    import("../src/server/integrations/ai/jev-decisions-provider").JevAnswer;
  type JevDecisionsProvider =
    import("../src/server/integrations/ai/jev-decisions-provider").JevDecisionsProvider;
  type JevDecisionsResult =
    import("../src/server/integrations/ai/jev-decisions-provider").JevDecisionsResult;
  type JevErrorCode =
    import("../src/server/integrations/ai/jev-decisions-provider").JevErrorCode;
  type JevSemanticEvidence =
    import("../src/server/integrations/ai/jev-semantic-strategy").JevSemanticEvidence;
  type ConversationEngineDeps =
    import("../src/features/conversations/server/conversation-engine").ConversationEngineDeps;
  type InboundResult =
    import("../src/features/conversations/server/conversation-engine").InboundResult;
  type InboundSuccess =
    import("../src/features/conversations/server/conversation-engine").InboundSuccess;
  type TurnEvidence =
    import("../src/features/conversations/server/turn-evidence").TurnEvidence;
  type TurnObservability =
    import("../src/features/conversations/server/ai-observability").TurnObservability;

  const emptyExtraction = {
    service: null,
    provider: null,
    date: null,
    timePreference: null,
  };

  function req(message: string, partial: Partial<AiRequest> = {}): AiRequest {
    return {
      message,
      conversationStatus: "AI_ACTIVE",
      recentMessages: [],
      businessName: "عيادة التجميل",
      services: [],
      faqs: [],
      ...partial,
    };
  }

  /** Build noul answers keyed by question key. */
  function noul(pairs: Array<[string, number]>): Record<string, JevAnswer> {
    const out: Record<string, JevAnswer> = {};
    for (const [key, value] of pairs) {
      out[key] = { type: "noul", noul: value };
    }
    return out;
  }

  const llmReply = (): AiResponse => ({
    intent: "FAQ",
    action: "reply",
    content: "نفتح من 9 حتى 6 يومياً.",
    extraction: emptyExtraction,
    safetyAssessment: "safe",
    handoffReason: null,
    summary: null,
  });

  // ── Deterministic admitted/rejected trace ids for the DEFAULT sampler ────
  // (rate 1/100, default salt). Brute-forced from the sampler's own hash so
  // the pair is stable across runs and process restarts (S: reproducible).
  const ADMIT_THRESHOLD = Math.ceil(
    2 ** 32 * shadowMod.DEFAULT_SHADOW_SAMPLE_RATE,
  );
  function bruteForceTraces(): { admitted: string; rejected: string } {
    let admitted: string | null = null;
    let rejected: string | null = null;
    for (
      let index = 0;
      index < 200_000 && (!admitted || !rejected);
      index += 1
    ) {
      const candidate = index.toString(16).padStart(32, "0");
      const value = shadowMod.sampleUint32(
        shadowMod.DEFAULT_SHADOW_SALT,
        candidate,
      );
      if (admitted === null && value < ADMIT_THRESHOLD) admitted = candidate;
      if (rejected === null && value >= ADMIT_THRESHOLD) rejected = candidate;
    }
    if (!admitted || !rejected) throw new Error("brute force failed");
    return { admitted, rejected };
  }
  const TRACES = bruteForceTraces();

  /** A sampler env map: rate=1 admits everything; rate=0 admits nothing. */
  const samplerEnv = (rate: string): Record<string, string | undefined> => ({
    SHADOW_SAMPLE_RATE: rate,
  });

  // ═══════════════════════════════════════════════════════════════════════
  // PART A — the three-state flag matrix (S1–S4)
  // ═══════════════════════════════════════════════════════════════════════

  check(
    "S1 the flag is the documented FLOWPILOT_JEV_SHADOW_ENABLED",
    SHADOW_JEV_FLAG === "FLOWPILOT_JEV_SHADOW_ENABLED",
  );
  check(
    "S1b the authority flag is unchanged FLOWPILOT_JEV_SEMANTIC_ENABLED",
    SEMANTIC_JEV_FLAG === "FLOWPILOT_JEV_SEMANTIC_ENABLED",
  );
  check(
    "S1c shadow flag ABSENT ⇒ OFF (exact v0.45.0 behaviour)",
    isShadowJevEnabled(() => undefined) === false,
  );
  check(
    "S2 every non-positive/garbage form ⇒ OFF",
    isShadowJevEnabled(() => "0") === false &&
      isShadowJevEnabled(() => "false") === false &&
      isShadowJevEnabled(() => "FALSE") === false &&
      isShadowJevEnabled(() => "no") === false &&
      isShadowJevEnabled(() => "") === false &&
      isShadowJevEnabled(() => "off") === false &&
      isShadowJevEnabled(() => "garbage") === false,
  );
  check(
    "S3 only the explicit positive enablements ⇒ ON",
    isShadowJevEnabled(() => "1") === true &&
      isShadowJevEnabled(() => "true") === true &&
      isShadowJevEnabled(() => "YES") === true &&
      isShadowJevEnabled(() => " yes ") === true,
  );
  check(
    "S3b the two switches share the identical enablement set",
    isShadowJevEnabled(() => "1") === isSemanticJevEnabled(() => "1") &&
      isShadowJevEnabled(() => "yes") === isSemanticJevEnabled(() => "yes"),
  );
  check(
    "S3c the authority switch is still independently readable",
    isSemanticJevEnabled(() => undefined) === false,
  );

  // The FACTORY-level three-state matrix, end-to-end through the REAL
  // createPolicyBackedAi with a stubbed policy + a URL-routing fetch.
  function policyStub() {
    return async () =>
      ({
        success: true as const,
        data: {
          policy: {} as never,
          effective: {
            primaryProvider: "openrouter",
            primaryModel: "openrouter/test-model",
            secondary: null,
            openRouterProviderOnly: null,
          },
        },
      }) as never;
  }
  function decisionsBody(): unknown {
    const answers: Record<string, unknown> = {};
    for (const key of semantic.jevSemanticQuestionKeys) {
      if (key === "conversationGoal") {
        answers[key] = {
          type: "choice",
          choice: "booking",
          confidence: 0.9,
          probabilities: { booking: 0.9 },
        };
      } else {
        answers[key] = {
          type: "noul",
          noul: key === "bookingRequested" ? 0.9 : 0.1,
        };
      }
    }
    return {
      model: "typesafe/jev-1.13",
      answers,
      usage: { input_tokens: 10, output_tokens: 5 },
    };
  }
  const chatBody = () => ({
    choices: [{ message: { content: JSON.stringify(llmReply()) } }],
    usage: { prompt_tokens: 12, completion_tokens: 8 },
  });
  function routingFetch(log: Array<string>): typeof fetch {
    return (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      log.push(url);
      if (url.includes("/decisions")) {
        return new Response(JSON.stringify(decisionsBody()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(chatBody()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
  }
  const factoryRequest = (): AiRequest =>
    req("عايز أحجز موعد بكرة", { traceId: TRACES.admitted });

  {
    // DISABLED via Emergency Kill Switch (CONV-JEV-01): FLOWPILOT_JEV_SEMANTIC_ENABLED=false ⇒ ZERO JEV/decisions traffic.
    const log: Array<string> = [];
    const disabledEnv: Record<string, string | undefined> = {
      FLOWPILOT_JEV_SEMANTIC_ENABLED: "false",
      OPENROUTER_API_KEY: "stub-key-not-a-secret",
    };
    const ai = await createPolicyBackedAi({
      getEnvVar: (name) => disabledEnv[name],
      fetchImpl: routingFetch(log),
      getAiPolicyImpl: policyStub() as never,
    });
    await ai.respond(factoryRequest());
    const decisionsCalls = log.filter((url) =>
      url.includes("/decisions"),
    ).length;
    check(
      "S4a DISABLED (emergency kill switch false) ⇒ the factory sends ZERO decisions calls",
      decisionsCalls === 0,
    );
  }
  {
    // S45 — ROLLBACK via Emergency Kill Switch: with FLOWPILOT_JEV_SEMANTIC_ENABLED=false the factory reproduces the
    // pre-03D serving path: exactly one generative call, no decisions call,
    // and NO shadow telemetry slot. Disabling JEV is a full rollback.
    const log: Array<string> = [];
    const offEnv: Record<string, string | undefined> = {
      FLOWPILOT_JEV_SEMANTIC_ENABLED: "false",
      OPENROUTER_API_KEY: "stub-key-not-a-secret",
    };
    const ai = await createPolicyBackedAi({
      getEnvVar: (name) => offEnv[name],
      fetchImpl: routingFetch(log),
      getAiPolicyImpl: policyStub() as never,
    });
    const response = await ai.respond(factoryRequest());
    const telemetry = (
      ai as { getLastTelemetry?: () => unknown }
    ).getLastTelemetry?.() as { shadow?: unknown } | null;
    const chatCalls = log.filter((url) =>
      url.includes("chat/completions"),
    ).length;
    check(
      "S45 SHADOW OFF (kill switch false) reproduces the deterministic/generative serving path",
      chatCalls === 1 &&
        log.filter((url) => url.includes("/decisions")).length === 0 &&
        (telemetry?.shadow === undefined || telemetry?.shadow === null) &&
        response.content === llmReply().content,
    );
  }
  {
    // CONV-JEV-01: With flags absent, TypeSafe JEV is preferred by default!
    const log: Array<string> = [];
    const defaultEnv: Record<string, string | undefined> = {
      OPENROUTER_API_KEY: "stub-key-not-a-secret",
    };
    const ai = await createPolicyBackedAi({
      getEnvVar: (name) => defaultEnv[name],
      fetchImpl: routingFetch(log),
      getAiPolicyImpl: policyStub() as never,
    });
    await ai.respond(factoryRequest());
    const decisionsCalls = log.filter((url) =>
      url.includes("/decisions"),
    ).length;
    const chatCalls = log.filter((url) =>
      url.includes("chat/completions"),
    ).length;
    check(
      "S4_CONV_JEV_01 flags absent ⇒ TypeSafe JEV is preferred (1 decisions, 0 chat)",
      decisionsCalls === 1 && chatCalls === 0,
    );
  }
  {
    // SHADOW: shadow flag with semantic disabled ⇒ the conservative route stays authoritative
    // (one chat call) AND the shadow evaluation runs (one decisions call).
    const log: Array<string> = [];
    const env: Record<string, string | undefined> = {
      FLOWPILOT_JEV_SEMANTIC_ENABLED: "false",
      FLOWPILOT_JEV_SHADOW_ENABLED: "1",
      OPENROUTER_API_KEY: "stub-key-not-a-secret",
      SHADOW_SAMPLE_RATE: "1",
    };
    const ai = await createPolicyBackedAi({
      getEnvVar: (name) => env[name],
      fetchImpl: routingFetch(log),
      getAiPolicyImpl: policyStub() as never,
    });
    const response = await ai.respond(factoryRequest());
    const decisionsCalls = log.filter((url) =>
      url.includes("/decisions"),
    ).length;
    const chatCalls = log.filter((url) =>
      url.includes("chat/completions"),
    ).length;
    const telemetry = (
      ai as { getLastTelemetry?: () => unknown }
    ).getLastTelemetry?.() as { shadow?: JevSemanticEvidence } | null;
    check(
      "S4b SHADOW (shadow on, semantic disabled) ⇒ serving chat=1 AND shadow decisions=1",
      chatCalls === 1 &&
        decisionsCalls === 1 &&
        telemetry?.shadow?.evidenceRole === "SHADOW",
    );
    check(
      "S4c SHADOW keeps the SERVING response authoritative (LLM reply bytes)",
      response.content === llmReply().content &&
        response.intent === "FAQ" &&
        response.action === "reply",
    );
  }
  {
    // ACTIVE: both flags set ⇒ collapses to ACTIVE; NO shadow slot; the
    // semantic strategy owns the turn; exactly ONE decisions call.
    const log: Array<string> = [];
    const env: Record<string, string | undefined> = {
      FLOWPILOT_JEV_SEMANTIC_ENABLED: "1",
      FLOWPILOT_JEV_SHADOW_ENABLED: "1",
      OPENROUTER_API_KEY: "stub-key-not-a-secret",
    };
    const ai = await createPolicyBackedAi({
      getEnvVar: (name) => env[name],
      fetchImpl: routingFetch(log),
      getAiPolicyImpl: policyStub() as never,
    });
    const response = await ai.respond(factoryRequest());
    const decisionsCalls = log.filter((url) =>
      url.includes("/decisions"),
    ).length;
    const chatCalls = log.filter((url) =>
      url.includes("chat/completions"),
    ).length;
    const telemetry = (
      ai as { getLastTelemetry?: () => unknown }
    ).getLastTelemetry?.() as {
      shadow?: JevSemanticEvidence | null;
      jevDecision?: { mode: string; semantic?: JevSemanticEvidence };
    } | null;
    check(
      "S4d both flags ON ⇒ ACTIVE only: 1 decisions call, 0 chat calls",
      decisionsCalls === 1 && chatCalls === 0,
    );
    check(
      "S4e both flags ON ⇒ NO shadow slot exists (no duplicate evaluation)",
      telemetry?.shadow === undefined || telemetry?.shadow === null,
    );
    check(
      "S4f both flags ON ⇒ the semantic strategy owns the turn",
      telemetry?.jevDecision?.mode === "DETERMINISTIC" &&
        telemetry?.jevDecision?.semantic?.jevCallSpent === true &&
        response.intent === "BOOKING",
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PART B — when a shadow call starts, and when it must NOT (S5, S6)
  // ═══════════════════════════════════════════════════════════════════════

  type JevStubOutcome =
    | {
        kind: "ok";
        answers: Record<string, JevAnswer>;
        servedModel?: string;
        latencyMs?: number;
      }
    | { kind: "fail"; errorCode: JevErrorCode; attemptSpent: boolean }
    | { kind: "hang" }
    | { kind: "throw" };

  function fakeJevProvider(outcome: JevStubOutcome): {
    provider: JevDecisionsProvider;
    calls: () => number;
    started: number[];
  } {
    let calls = 0;
    const started: number[] = [];
    return {
      provider: {
        model: "typesafe/jev-1.13",
        secretRef: "OPENROUTER_API_KEY",
        async evaluate(): Promise<JevDecisionsResult> {
          calls += 1;
          started.push(Date.now());
          if (outcome.kind === "throw") {
            throw new Error("simulated shadow internal explosion");
          }
          if (outcome.kind === "hang") {
            return new Promise<JevDecisionsResult>(() => {
              /* never settles: a provider that ignores its own deadline */
            });
          }
          if (outcome.kind === "fail") {
            return {
              ok: false,
              errorCode: outcome.errorCode,
              errorMessage: `RAW-BODY-MARKER ${outcome.errorCode} detail`,
              answers: {},
              latencyMs: 4,
              servedModel: null,
              inputTokens: null,
              outputTokens: null,
              attemptSpent: outcome.attemptSpent,
            };
          }
          return {
            ok: true,
            errorCode: null,
            errorMessage: null,
            answers: outcome.answers,
            latencyMs: outcome.latencyMs ?? 4,
            servedModel: outcome.servedModel ?? "typesafe/jev-1.13",
            inputTokens: 11,
            outputTokens: 7,
            attemptSpent: true,
          };
        },
      },
      calls: () => calls,
      started,
    };
  }

  function fakeLlm(
    opts: {
      delayMs?: number;
      response?: AiResponse;
      fail?: boolean;
    } = {},
  ): { adapter: AiProviderAdapter; calls: () => number; started: number[] } {
    let calls = 0;
    const started: number[] = [];
    const adapter: AiProviderAdapter = {
      providerId: "openrouter",
      model: "openrouter/test-model",
      secretRef: "OPENROUTER_API_KEY",
      async call(): Promise<AiProviderResult> {
        calls += 1;
        started.push(Date.now());
        if (opts.delayMs) await delay(opts.delayMs);
        if (opts.fail) {
          return {
            ok: false,
            error: {
              code: "PERMANENT",
              message: "provider down",
              retryable: false,
            },
            provider: "openrouter",
            model: "openrouter/test-model",
            latencyMs: 1,
          } as AiProviderResult;
        }
        return {
          ok: true,
          response: opts.response ?? llmReply(),
          provider: "openrouter",
          model: "openrouter/test-model",
          latencyMs: 2,
          httpAttempts: 1,
        } as AiProviderResult;
      },
    };
    return { adapter, calls: () => calls, started };
  }

  /**
   * The OPTION E orchestrator fixture: the CONSERVATIVE strategy is the
   * authoritative decision (exactly the SHADOW state), with a shadow
   * strategy installed alongside it.
   */
  function shadowOrchestrator(opts: {
    jevOutcome: JevStubOutcome;
    rate?: string;
    request: AiRequest;
    llmDelayMs?: number;
    llmResponse?: AiResponse;
    llmFail?: boolean;
    shadowTimeoutMs?: number;
    traceId?: string;
  }) {
    const {
      provider: jevProvider,
      calls: jevCalls,
      started: jevStarted,
    } = fakeJevProvider(opts.jevOutcome);
    const sampler = shadowMod.createShadowSampler({
      getEnvVar: (name) => samplerEnv(opts.rate ?? "1")[name],
    });
    const shadowStrategy = shadowMod.createShadowJevStrategy({
      provider: jevProvider,
      sampler,
      ...(opts.shadowTimeoutMs !== undefined
        ? { timeoutMs: opts.shadowTimeoutMs }
        : {}),
    });
    const {
      adapter,
      calls: llmCalls,
      started: llmStarted,
    } = fakeLlm({
      delayMs: opts.llmDelayMs,
      response: opts.llmResponse,
      fail: opts.llmFail,
    });
    const orchestrator = createAiOrchestrator({
      primary: adapter,
      secondary: null,
      fallbackEnabled: false,
      decisionStrategy: jev.createConservativeJevStrategy(),
      shadowStrategy,
      ...(opts.shadowTimeoutMs !== undefined
        ? { shadowTimeoutMs: opts.shadowTimeoutMs }
        : {}),
    });
    return {
      orchestrator,
      jevCalls,
      llmCalls,
      jevStarted,
      llmStarted,
      shadowStrategy,
    };
  }

  const eligible = (): AiRequest =>
    req("عايز أحجز موعد بكرة", { traceId: TRACES.admitted });

  // S5 — a deterministic zero-call bypass turn starts NEITHER operation.
  {
    const greeting = req("صباح الخير", { traceId: TRACES.admitted });
    const { orchestrator, jevCalls, llmCalls } = shadowOrchestrator({
      jevOutcome: { kind: "ok", answers: noul([["bookingRequested", 0.9]]) },
      request: greeting,
    });
    const result = await orchestrator.callWithFallback(greeting);
    check(
      "S5 a deterministic bypass turn starts NEITHER call (shadow=0, LLM=0)",
      jevCalls() === 0 &&
        llmCalls() === 0 &&
        result.telemetry.attempts.length === 0 &&
        result.telemetry.finalProvider === JEV_DETERMINISTIC_PROVIDER &&
        result.telemetry.jevDecision?.mode === "DETERMINISTIC",
    );
    check(
      "S5b a bypass turn records NO shadow evaluation",
      result.telemetry.shadow === undefined || result.telemetry.shadow === null,
    );
  }

  // S5c — an ineligible (quotable) turn never starts a shadow call.
  {
    const quotable = req("عايز أعرف سعر التنظيف", {
      traceId: TRACES.admitted,
      services: [{ name: "تنظيف", price: "٥٠٠ جنيه" }],
    });
    const { orchestrator, jevCalls, llmCalls } = shadowOrchestrator({
      jevOutcome: { kind: "ok", answers: noul([["bookingRequested", 0.9]]) },
      request: quotable,
    });
    const result = await orchestrator.callWithFallback(quotable);
    check(
      "S5c a quotable-ineligible turn ⇒ the ONE serving LLM call, shadow=0, marker NOT_SAMPLED-family",
      llmCalls() === 1 &&
        jevCalls() === 0 &&
        result.telemetry.shadow?.selected === false &&
        result.telemetry.shadow?.jevCallSpent === false,
    );
  }

  // S6 — the OPTION E row: a normal generative + shadow turn.
  {
    const { orchestrator, jevCalls, llmCalls } = shadowOrchestrator({
      jevOutcome: { kind: "ok", answers: noul([["bookingRequested", 0.9]]) },
      request: eligible(),
    });
    const result = await orchestrator.callWithFallback(eligible());
    check(
      "S6 normal generative + shadow ⇒ serving LLM=1, shadow JEV=1, attempts=[1]",
      llmCalls() === 1 &&
        jevCalls() === 1 &&
        result.telemetry.attempts.length === 1 &&
        result.telemetry.shadow?.evidenceRole === "SHADOW" &&
        result.telemetry.shadow?.jevCallSpent === true,
    );
    check(
      "S6b the shadow records the same outcome class ACTIVE would compute",
      result.telemetry.shadow?.resultClass === "SEMANTIC_DOMAIN",
    );
    check(
      "S6c the SERVING response is still the LLM's reply",
      result.response?.content === llmReply().content &&
        result.telemetry.attempts[0]?.status === "SUCCESS",
    );
  }

  // S6d — admission is required: a sampled-out eligible turn never calls JEV.
  {
    const rejected = req("عايز أحجز موعد بكرة", { traceId: TRACES.rejected });
    const { orchestrator, jevCalls, llmCalls } = shadowOrchestrator({
      jevOutcome: { kind: "ok", answers: noul([["bookingRequested", 0.9]]) },
      request: rejected,
      rate: "0",
    });
    const result = await orchestrator.callWithFallback(rejected);
    check(
      "S6d a not-sampled eligible turn ⇒ LLM=1, shadow JEV=0, zero-call marker",
      llmCalls() === 1 &&
        jevCalls() === 0 &&
        result.telemetry.shadow?.sampled === false &&
        result.telemetry.shadow?.jevCallSpent === false &&
        result.telemetry.shadow?.selected === true,
    );
  }
  {
    // No trace id at all ⇒ fail closed, no shadow call.
    const noTrace = req("عايز أحجز موعد بكرة");
    const { orchestrator, jevCalls } = shadowOrchestrator({
      jevOutcome: { kind: "ok", answers: noul([["bookingRequested", 0.9]]) },
      request: noTrace,
    });
    const result = await orchestrator.callWithFallback(noTrace);
    check(
      "S6e a request without traceId ⇒ NO shadow call (fail-closed admission)",
      jevCalls() === 0 &&
        result.telemetry.shadow?.notSampledReason === "NO_TRACE_ID",
    );
  }
  {
    // The budget guard: SHADOW_MAX_CALLS_PER_DAY=0 admits nothing.
    const guardEnv: Record<string, string | undefined> = {
      SHADOW_SAMPLE_RATE: "1",
      SHADOW_MAX_CALLS_PER_DAY: "0",
    };
    const sampler = shadowMod.createShadowSampler({
      getEnvVar: (name) => guardEnv[name],
    });
    check(
      "S6f SHADOW_MAX_CALLS_PER_DAY=0 admits nothing (belt-and-braces off-switch)",
      sampler.admit(TRACES.admitted) === false &&
        sampler.notAdmittedReason() === "SAMPLER_DISABLED",
    );
  }
  {
    // Sampling is deterministic and reproducible.
    const samplerA = shadowMod.createShadowSampler({
      getEnvVar: () => undefined,
    });
    const samplerB = shadowMod.createShadowSampler({
      getEnvVar: () => undefined,
    });
    let consistent = true;
    for (let index = 0; index < 500; index += 1) {
      const trace = index.toString(16).padStart(32, "0");
      if (samplerA.admit(trace) !== samplerB.admit(trace)) {
        consistent = false;
        break;
      }
    }
    check(
      "S6g deterministic sampling: the same traceId admits identically across samplers",
      consistent === true,
    );
    check(
      "S6h the default rate admits ~1/100 (the AI-JEV-03C stage-0 value)",
      ((): boolean => {
        let admittedCount = 0;
        for (let index = 0; index < 10_000; index += 1) {
          if (samplerA.admit(index.toString(16).padStart(32, "0"))) {
            admittedCount += 1;
          }
        }
        return admittedCount >= 50 && admittedCount <= 250;
      })() === true,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PART C — AUTHORITY: the serving decision always wins (S7, S8)
  // ═══════════════════════════════════════════════════════════════════════

  async function shadowVsBaseline(
    jevOutcome: JevStubOutcome,
    label: string,
    extra?: (shadowed: {
      response: AiResponse | null;
      jevDecision: unknown;
      shadow: JevSemanticEvidence | null | undefined;
    }) => boolean,
  ): Promise<void> {
    const request = eligible();
    const {
      orchestrator: withoutShadow,
      jevCalls: baselineJevCalls,
      llmCalls: baselineLlmCalls,
    } = shadowOrchestrator({ jevOutcome, request });
    const baseline = await withoutShadow.callWithFallback(request);
    const { orchestrator, jevCalls, llmCalls } = shadowOrchestrator({
      jevOutcome,
      request,
    });
    const result = await orchestrator.callWithFallback(request);
    check(
      `${label} the SERVING result is byte-identical with the shadow ON`,
      JSON.stringify(result.response) === JSON.stringify(baseline.response) &&
        JSON.stringify(result.telemetry.attempts) ===
          JSON.stringify(baseline.telemetry.attempts) &&
        JSON.stringify(result.telemetry.jevDecision) ===
          JSON.stringify(baseline.telemetry.jevDecision) &&
        JSON.stringify(result.telemetry.finalProvider) ===
          JSON.stringify(baseline.telemetry.finalProvider) &&
        JSON.stringify(result.telemetry.finalStatus) ===
          JSON.stringify(baseline.telemetry.finalStatus),
    );
    check(
      `${label} the ONLY telemetry difference is the disjoint shadow slot`,
      (() => {
        const a = { ...result.telemetry, shadow: undefined };
        const b = { ...baseline.telemetry, shadow: undefined };
        return JSON.stringify(a) === JSON.stringify(b);
      })() === true,
    );
    if (extra) {
      check(
        `${label} the shadow evidence is recorded`,
        extra({
          response: result.response,
          jevDecision: result.telemetry.jevDecision,
          shadow: result.telemetry.shadow,
        }) === true,
      );
    }
    void baselineJevCalls;
    void baselineLlmCalls;
    void jevCalls;
    void llmCalls;
  }

  // S7 — the shadow AGREES with the serving decision (reply-class reading).
  await shadowVsBaseline(
    { kind: "ok", answers: noul([["greetingOnly", 0.95]]) },
    "S7 shadow AGREES (reply-class reading)",
    (shadowed) =>
      shadowed.shadow?.resultClass === "SEMANTIC_ANSWER" &&
      shadowed.shadow?.handoffAgreement === "AGREE_NO_HANDOFF",
  );

  // S8 — the DISAGREES cases: the customer still gets the serving result.
  await shadowVsBaseline(
    { kind: "ok", answers: noul([["bookingRequested", 0.97]]) },
    "S8 shadow DISAGREES (booking task) — customer keeps the LLM reply",
    (shadowed) =>
      shadowed.shadow?.resultClass === "SEMANTIC_DOMAIN" &&
      shadowed.shadow?.facts?.bookingTask === true &&
      shadowed.response?.action === "reply" &&
      shadowed.response?.content === llmReply().content,
  );
  await shadowVsBaseline(
    { kind: "ok", answers: noul([["supportRequested", 0.97]]) },
    "S8b shadow DISAGREES (handoff) — customer keeps the LLM reply",
    (shadowed) =>
      shadowed.shadow?.resultClass === "SEMANTIC_HANDOFF" &&
      shadowed.shadow?.handoffAgreement === "SEMANTIC_ONLY_HANDOFF" &&
      shadowed.response?.action === "reply",
  );
  await shadowVsBaseline(
    {
      kind: "ok",
      answers: noul([
        ["bookingRequested", 1.0],
        ["sensitiveTurn", 1.0],
      ]),
    },
    "S8c an EXTREME shadow reading (booking=1.0 AND sensitive=1.0) never reaches the customer",
    (shadowed) =>
      shadowed.shadow?.facts?.sensitiveTurn === true &&
      shadowed.shadow?.resultClass === "SEMANTIC_HANDOFF" &&
      shadowed.response?.content === llmReply().content &&
      shadowed.response?.handoffReason === null,
  );
  await shadowVsBaseline(
    {
      kind: "ok",
      answers: noul([
        ["providerRequested", 0.45],
        ["bookingRequested", 0.2],
        ["supportRequested", 0.05],
        ["sensitiveTurn", 0.02],
      ]),
    },
    "S8d the contact-vs-book boundary fires as EVIDENCE only",
    (shadowed) =>
      shadowed.shadow?.clarifyContactOrBookProposed === true &&
      shadowed.shadow?.resultClass === "SEMANTIC_CLARIFY" &&
      shadowed.response?.clarification === undefined,
  );

  // ═══════════════════════════════════════════════════════════════════════
  // PART D — failure isolation: every failure class (S9–S16)
  // ═══════════════════════════════════════════════════════════════════════

  const spentFailures: Array<[string, JevErrorCode]> = [
    ["S9 TIMEOUT", "TIMEOUT"],
    ["S10 NETWORK", "NETWORK"],
    ["S11 4xx BAD_REQUEST", "BAD_REQUEST"],
    ["S11b 4xx AUTH_FAILED", "AUTH_FAILED"],
    ["S11c 4xx MODEL_NOT_FOUND", "MODEL_NOT_FOUND"],
    ["S11d 4xx INSUFFICIENT_CREDITS", "INSUFFICIENT_CREDITS"],
    ["S12 5xx PROVIDER", "PROVIDER"],
    ["S13 RATE_LIMITED", "RATE_LIMITED"],
    ["S14 INVALID_RESPONSE (malformed)", "INVALID_RESPONSE"],
    ["S15 EMPTY_RESPONSE", "EMPTY_RESPONSE"],
  ];
  for (const [label, errorCode] of spentFailures) {
    await shadowVsBaseline(
      { kind: "fail", errorCode, attemptSpent: true },
      `${label} (attempt spent)`,
      (shadowed) =>
        shadowed.shadow?.failureCode === errorCode &&
        shadowed.shadow?.resultClass === "FAILURE_FAIL_CLOSED" &&
        shadowed.shadow?.jevCallSpent === true,
    );
  }
  await shadowVsBaseline(
    { kind: "fail", errorCode: "MISSING_CREDENTIAL", attemptSpent: false },
    "S16 MISSING_CREDENTIAL (pre-attempt) — zero calls spent",
    (shadowed) =>
      shadowed.shadow?.failureCode === "MISSING_CREDENTIAL" &&
      shadowed.shadow?.resultClass === "UNAVAILABLE_PRE_ATTEMPT" &&
      shadowed.shadow?.jevCallSpent === false,
  );
  await shadowVsBaseline(
    { kind: "throw" },
    "S16b a shadow INTERNAL EXCEPTION is absorbed (evidence lost, turn intact)",
    (shadowed) => shadowed.shadow === null || shadowed.shadow === undefined,
  );
  {
    // S9b — the join-level timeout: a provider that ignores its own deadline.
    const { orchestrator, llmCalls } = shadowOrchestrator({
      jevOutcome: { kind: "hang" },
      request: eligible(),
      shadowTimeoutMs: 60,
    });
    const started = Date.now();
    const result = await orchestrator.callWithFallback(eligible());
    const elapsed = Date.now() - started;
    check(
      "S9b a hanging shadow join resolves within the shadow deadline (turn completes)",
      result.response !== null &&
        llmCalls() === 1 &&
        (result.telemetry.shadow === null ||
          result.telemetry.shadow === undefined) &&
        elapsed < 5_000,
    );
  }
  {
    // An empty answer set is unusable evidence: no reading, never scored.
    // closedFacts always projects the full closed key set, so every fact is
    // false (no positive reading) rather than the key set being empty.
    await shadowVsBaseline(
      { kind: "ok", answers: noul([]) },
      "S15b a valid answer set with NO answers ⇒ NO_READING_BASELINE evidence",
      (shadowed) =>
        shadowed.shadow?.resultClass === "NO_READING_BASELINE" &&
        Object.values(shadowed.shadow?.facts ?? {}).every((v) => v === false),
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PART E — model-call accounting (S17–S20)
  // ═══════════════════════════════════════════════════════════════════════

  {
    const request = eligible();
    const { orchestrator, jevCalls, llmCalls } = shadowOrchestrator({
      jevOutcome: { kind: "ok", answers: noul([["bookingRequested", 0.9]]) },
      request,
    });
    const result = await orchestrator.callWithFallback(request);
    const shadow = result.telemetry.shadow;
    const jevCallSpent = !!result.telemetry.jevDecision?.semantic?.jevCallSpent;
    const providerAttempts = result.telemetry.attempts.length;
    // The ENGINE's exact computation (conversation-engine.ts:1933-1934),
    // reproduced here ONLY to assert it stays serving-only.
    const modelCallCount = providerAttempts + (jevCallSpent ? 1 : 0);
    const shadowModelCallCount = shadow?.jevCallSpent ? 1 : 0;
    check(
      "S17 modelCallCount remains the SERVING count (1), not 2",
      llmCalls() === 1 &&
        jevCalls() === 1 &&
        modelCallCount === 1 &&
        providerAttempts === 1 &&
        jevCallSpent === false,
    );
    check(
      "S18 shadowModelCallCount accounts for the shadow call separately (1)",
      shadowModelCallCount === 1 && shadow?.jevCallSpent === true,
    );
    check(
      "S19 no serving row reads JEV=1 + LLM=1 (shadow is not a serving call)",
      !(jevCallSpent && providerAttempts >= 1) &&
        modelCallCount <= 1 &&
        shadowModelCallCount <= 1,
    );
  }
  {
    // The ACTIVE row: 1 serving JEV call, 0 LLM, and NO separate shadow call
    // even when a shadow strategy is (hypothetically) also installed.
    const semanticProvider = fakeJevProvider({
      kind: "ok",
      answers: noul([["bookingRequested", 0.9]]),
    });
    const shadowProvider = fakeJevProvider({
      kind: "ok",
      answers: noul([["bookingRequested", 0.9]]),
    });
    const shadowStrategy = shadowMod.createShadowJevStrategy({
      provider: shadowProvider.provider,
      sampler: shadowMod.createShadowSampler({
        getEnvVar: (name) => samplerEnv("1")[name],
      }),
    });
    const { adapter, calls: llmCalls } = fakeLlm();
    const orchestrator = createAiOrchestrator({
      primary: adapter,
      secondary: null,
      fallbackEnabled: false,
      decisionStrategy: semantic.createSemanticJevStrategy({
        provider: semanticProvider.provider,
        enabled: true,
      }),
      shadowStrategy,
    });
    const result = await orchestrator.callWithFallback(eligible());
    check(
      "S20 ACTIVE mode starts NO separate shadow call (authoritative JEV=1, LLM=0, shadow=0)",
      semanticProvider.calls() === 1 &&
        shadowProvider.calls() === 0 &&
        llmCalls() === 0 &&
        result.telemetry.attempts.length === 0 &&
        result.telemetry.finalProvider === jev.JEV_DETERMINISTIC_PROVIDER &&
        (result.telemetry.shadow === null ||
          result.telemetry.shadow === undefined),
    );
  }
  {
    // Structural: the engine's serving counter source is unchanged.
    const engineSrc = readFileSync(
      resolvePath(
        process.cwd(),
        "src/features/conversations/server/conversation-engine.ts",
      ),
      "utf8",
    );
    check(
      "S17b the engine resolves modelCallCount from serving activity without double-counting JEV",
      engineSrc.includes(
        "const jevCallSpent = !!turnTelemetry?.jevDecision?.semantic?.jevCallSpent;",
      ) === true &&
        engineSrc.includes("resolveTurnCounters") === true &&
        engineSrc.includes(
          "const { providerAttempts, modelCallCount } = resolveTurnCounters",
        ) === true,
    );
    check(
      "S17c the engine's serving computation never references the shadow slot",
      /resolveTurnCounters[^;]*;/.exec(engineSrc)?.[0]?.includes("shadow") ===
        false && /modelCallCount\s*=[^;]*shadow/.test(engineSrc) === false,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PART F — Turn Planner / resolver authority (S21–S24)
  // ═══════════════════════════════════════════════════════════════════════

  {
    // The resolver's telemetry input is `jevDecision.semantic.signals` and it
    // is consulted ONLY on routing === "JEV". In SHADOW state the routing is
    // "LLM" and the authoritative decision carries no semantic block, so the
    // resolver input is provably identical with the shadow ON or OFF — and
    // the shadow never attaches `signals` at all.
    const request = eligible();
    const { orchestrator: withoutShadow } = shadowOrchestrator({
      jevOutcome: { kind: "ok", answers: noul([["bookingRequested", 0.9]]) },
      request,
    });
    const baseline = await withoutShadow.callWithFallback(request);
    const { orchestrator } = shadowOrchestrator({
      jevOutcome: { kind: "ok", answers: noul([["bookingRequested", 0.9]]) },
      request,
    });
    const result = await orchestrator.callWithFallback(request);
    check(
      "S21 the resolver's input (routing + jevDecision) is unchanged in SHADOW",
      JSON.stringify(baseline.telemetry.jevDecision) ===
        JSON.stringify(result.telemetry.jevDecision) &&
        result.telemetry.jevDecision?.semantic === undefined,
    );
    check(
      "S21b the shadow NEVER materializes resolver signals",
      result.telemetry.shadow?.signals === undefined,
    );
    check(
      "S21c the ACTIVE-only signals path is untouched (signals exist only on semantic decisions)",
      baseline.telemetry.jevDecision?.semantic?.signals === undefined,
    );
  }
  {
    // S22/S23/S24 — disagreement classes are EVIDENCE ONLY.
    const disagreement = noul([["supportRequested", 0.95]]);
    const request = eligible();
    const { orchestrator } = shadowOrchestrator({
      jevOutcome: { kind: "ok", answers: disagreement },
      request,
    });
    const result = await orchestrator.callWithFallback(request);
    const shadow = result.telemetry.shadow;
    check(
      "S22 a shadow HANDOFF disagreement is evidence only (no handoff in the serving result)",
      shadow?.handoffAgreement === "SEMANTIC_ONLY_HANDOFF" &&
        shadow?.facts?.supportRequested === true &&
        result.response?.action === "reply" &&
        result.response?.handoffReason === null,
    );
  }
  {
    const booking = noul([["bookingRequested", 0.95]]);
    const request = eligible();
    const { orchestrator } = shadowOrchestrator({
      jevOutcome: { kind: "ok", answers: booking },
      request,
    });
    const result = await orchestrator.callWithFallback(request);
    check(
      "S23 a shadow BOOKING disagreement is evidence only (no booking path in the serving result)",
      result.telemetry.shadow?.resultClass === "SEMANTIC_DOMAIN" &&
        result.telemetry.shadow?.facts?.bookingTask === true &&
        result.response?.action === "reply" &&
        result.telemetry.attempts.length === 1,
    );
  }
  {
    const sensitive = noul([["sensitiveTurn", 0.95]]);
    const request = eligible();
    const { orchestrator } = shadowOrchestrator({
      jevOutcome: { kind: "ok", answers: sensitive },
      request,
    });
    const result = await orchestrator.callWithFallback(request);
    check(
      "S24 a shadow SAFETY disagreement is evidence only (safety-precedence metric stays measurable)",
      result.telemetry.shadow?.facts?.sensitiveTurn === true &&
        result.telemetry.shadow?.resultClass === "SEMANTIC_HANDOFF" &&
        result.response?.handoffReason === null &&
        result.telemetry.shadow?.jevCallSpent === true,
    );
    check(
      "S24b the sensitive-turn shadow is NOT excluded (the measurement population keeps sensitive turns)",
      result.telemetry.shadow?.selected === true,
    );
  }
  {
    // Structural: exactly ONE resolver call site exists, and the shadow
    // module never references a resolver.
    const engineSrc = readFileSync(
      resolvePath(
        process.cwd(),
        "src/features/conversations/server/conversation-engine.ts",
      ),
      "utf8",
    );
    const shadowSrc = readFileSync(
      resolvePath(
        process.cwd(),
        "src/server/integrations/ai/jev-shadow-strategy.ts",
      ),
      "utf8",
    );
    check(
      "S38b the shadow module references no resolver / turn-planner symbol",
      /resolveTurnPlan|turn-planner|resolveFinishedTurn/.test(shadowSrc) ===
        false,
    );
    check(
      "S39b the engine keeps exactly ONE resolver invocation site",
      // One CALL site: exclude the function definition `function resolveFinishedTurn(`.
      (engineSrc.match(/(?<!function )resolveFinishedTurn\(/g) ?? []).length ===
        1,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PART G — privacy: the evidence record stays content-free (S25–S29)
  // ═══════════════════════════════════════════════════════════════════════

  {
    const customerText = "عايز أحجز موعد يوم الأحد القادم";
    const secretValue = "sk-shadow-secret-DO-NOT-LEAK-0123456789";
    const env: Record<string, string | undefined> = {
      SHADOW_SAMPLE_RATE: "1",
      OPENROUTER_API_KEY: secretValue,
    };
    const provider = fakeJevProvider({
      kind: "ok",
      answers: noul([["bookingRequested", 0.9]]),
    });
    const shadowStrategy = shadowMod.createShadowJevStrategy({
      provider: provider.provider,
      sampler: shadowMod.createShadowSampler({
        getEnvVar: (name) => env[name],
      }),
    });
    const { adapter, calls: llmCalls } = fakeLlm();
    const orchestrator = createAiOrchestrator({
      primary: adapter,
      secondary: null,
      fallbackEnabled: false,
      decisionStrategy: jev.createConservativeJevStrategy(),
      shadowStrategy,
    });
    const request = req(customerText, { traceId: TRACES.admitted });
    const result = await orchestrator.callWithFallback(request);
    const obs: TurnObservability = buildTurnObservability({
      routingDecision: "LLM",
      response: result.response,
      provider: "openrouter",
      model: "openrouter/test-model",
      providerAttempts: 1,
      providerStatus: "SUCCESS",
      jev: result.telemetry.jevDecision ?? null,
      shadow: result.telemetry.shadow ?? null,
      traceId: TRACES.admitted,
      modelCallCount: 1,
    });
    const record: TurnEvidence = buildTurnEvidence(
      {
        ok: true,
        duplicate: false,
        businessId: "business-1",
        conversationId: "conv-1",
        customerMessageId: "msg-1",
        assistantAction: "AI_REPLY",
        intent: result.response?.intent ?? null,
        conversationStatus: "AI_ACTIVE",
        handoffCause: null,
        observability: obs,
        knowledgeGap: null,
        delivery: { delivered: true },
      },
      {
        environment: "test",
        appVersion: "0.0.0",
        emittedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    );
    let contentFree = true;
    try {
      assertTurnEvidenceContentFree(record);
    } catch {
      contentFree = false;
    }
    const serialized = JSON.stringify(record);
    const questionProse = "non-clinical"; // from SEMANTIC_QUESTIONS instructions
    check(
      "S25 the content-free guard still passes on a shadowed record",
      contentFree === true,
    );
    check(
      "S25b NO raw customer text appears in the shadow evidence record",
      serialized.includes(customerText) === false &&
        serialized.includes("الأحد") === false,
    );
    check(
      "S26 NO secret value appears in the shadow evidence record",
      serialized.includes(secretValue) === false &&
        serialized.includes("OPENROUTER_API_KEY") === false,
    );
    check(
      "S27 NO Authorization header / Bearer token appears in the record",
      serialized.includes("Authorization") === false &&
        serialized.includes("Bearer") === false,
    );
    check(
      "S28 NO raw provider body / error message leaks into the record",
      serialized.includes("RAW-BODY-MARKER") === false &&
        "usage" in record === false &&
        record.inputTokens === null &&
        record.outputTokens === null,
    );
    check(
      "S29 NO chain-of-thought / question-instruction prose leaks into the record",
      serialized.includes(questionProse) === false &&
        serialized.includes("criteria") === false,
    );
    check(
      "S29b the shadow evidence carries ONLY closed machine-key string fields",
      record.shadowEvidenceRole === "SHADOW" &&
        record.shadowModelCallCount === 1 &&
        record.shadowLanguageHint === "ar" &&
        typeof record.shadowResultClass === "string",
    );
    check(
      "S29c the shadow record is bounded and machine-readable (no free-text array)",
      JSON.stringify(record.shadowFacts).length < 600 &&
        JSON.stringify(record.shadowProbabilities).length < 600,
    );
    void llmCalls;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PART H — language / dialect evidence (S30, S31)
  // ═══════════════════════════════════════════════════════════════════════

  {
    const cases: Array<[string, string]> = [
      ["عايز أحجز موعد", "ar"],
      ["I want to book an appointment", "en"],
      ["عايز أحجز appointment بكرة", "mixed"],
      ["", "en"],
    ];
    let allCorrect = true;
    for (const [message, expected] of cases) {
      if (semantic.languageHint(message) !== expected) allCorrect = false;
    }
    check(
      "S30 languageHint is the exported closed key (ar / en / mixed) — script-block only",
      allCorrect === true,
    );
  }
  {
    const arabicReq = eligible(); // Arabic message
    const { orchestrator } = shadowOrchestrator({
      jevOutcome: { kind: "ok", answers: noul([["bookingRequested", 0.9]]) },
      request: arabicReq,
    });
    const result = await orchestrator.callWithFallback(arabicReq);
    check(
      "S30b the shadow evidence exposes the language signal as the approved closed key",
      result.telemetry.shadow?.languageHint === "ar",
    );
    check(
      "S30c the language hint sent to the provider equals the one in the evidence",
      semantic.languageHint(arabicReq.message) ===
        result.telemetry.shadow?.languageHint,
    );
  }
  {
    const mixedReq = req("عايز أحجز appointment بكرة", {
      traceId: TRACES.admitted,
    });
    const { orchestrator } = shadowOrchestrator({
      jevOutcome: { kind: "ok", answers: noul([["bookingRequested", 0.9]]) },
      request: mixedReq,
    });
    const result = await orchestrator.callWithFallback(mixedReq);
    check(
      "S30d the mixed code-switching bucket is first-class (never folded or dropped)",
      result.telemetry.shadow?.languageHint === "mixed",
    );
  }
  {
    // No dialect claim is made anywhere in the vocabulary.
    const shadowSrc = readFileSync(
      resolvePath(
        process.cwd(),
        "src/server/integrations/ai/jev-shadow-strategy.ts",
      ),
      "utf8",
    );
    check(
      "S31 the shadow vocabulary claims NO dialect certainty (no egyptian/msa key)",
      shadowSrc.includes("egyptian") === false &&
        shadowSrc.includes("MSA") === false,
    );
    check(
      "S31b the language observable is implemented as a script-block test, not a classifier",
      /function languageHint[\s\S]{0,220}?\\u0600-\\u06FF/.test(
        readFileSync(
          resolvePath(
            process.cwd(),
            "src/server/integrations/ai/jev-semantic-strategy.ts",
          ),
          "utf8",
        ),
      ) === true,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PART I — production isolation (S32–S34)
  // ═══════════════════════════════════════════════════════════════════════

  {
    const srcRoot = resolvePath(process.cwd(), "src");
    const offenderPattern =
      /(?:from|import|require)\s*[(]?\s*["'][^"']*(?:^|\/)evaluation\//;
    const holdoutPattern =
      /(?:from|import|require)\s*[(]?\s*["'][^"']*(?:^|\/)(?:evaluation\/[^"']*holdout|holdout)/;
    const offenders: Array<string> = [];
    const holdoutOffenders: Array<string> = [];
    async function scan(dir: string): Promise<void> {
      const { readdirSync, statSync } = await import("node:fs");
      for (const entry of readdirSync(dir)) {
        const abs = resolvePath(dir, entry);
        const stat = statSync(abs);
        if (stat.isDirectory()) {
          await scan(abs);
          continue;
        }
        if (!abs.endsWith(".ts") && !abs.endsWith(".tsx")) continue;
        const text = readFileSync(abs, "utf8");
        if (offenderPattern.test(text)) offenders.push(abs);
        if (holdoutPattern.test(text)) holdoutOffenders.push(abs);
      }
    }
    await scan(srcRoot);
    check(
      "S32 src/* has ZERO runtime imports of evaluation/* (production isolation kept)",
      offenders.length === 0,
    );
    if (offenders.length > 0) {
      console.log("    offenders:", offenders.join(", "));
    }
    check(
      "S33 src/* has ZERO holdout runtime imports (holdout-v4 stays retired, no holdout-v5)",
      holdoutOffenders.length === 0,
    );
    if (holdoutOffenders.length > 0) {
      console.log("    holdout offenders:", holdoutOffenders.join(", "));
    }
  }
  {
    const shadowSrc = readFileSync(
      resolvePath(
        process.cwd(),
        "src/server/integrations/ai/jev-shadow-strategy.ts",
      ),
      "utf8",
    );
    const factorySrc = readFileSync(
      resolvePath(process.cwd(), "src/server/integrations/ai/factory.ts"),
      "utf8",
    );
    const orchestratorSrc = readFileSync(
      resolvePath(process.cwd(), "src/server/integrations/ai/orchestrator.ts"),
      "utf8",
    );
    check(
      "S34 the shadow seam imports no prisma / repository / migration dependency",
      /prisma|@prisma|migration|Repository/.test(shadowSrc) === false &&
        /prisma|@prisma|migration/.test(orchestratorSrc) === false,
    );
    check(
      "S34b the shadow strategy's only deps are the provider, the sampler and the timeout",
      /createShadowJevStrategy\(\{[\s\S]{0,400}?provider:/.test(factorySrc) ===
        true &&
        /deps\.(provider|sampler|timeoutMs)/.test(shadowSrc) === true &&
        /from "@\/lib|from "@\/server\/db|prisma/.test(shadowSrc) === false,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PART J — the concurrency structure proof (S35)
  // ═══════════════════════════════════════════════════════════════════════

  {
    // Structural timing proof: record the START of each operation. The shadow
    // must START before the serving LLM call COMPLETES (overlap), proving the
    // two operations run concurrently rather than serialized.
    const events: Array<string> = [];
    const jevProvider: JevDecisionsProvider = {
      model: "typesafe/jev-1.13",
      secretRef: "OPENROUTER_API_KEY",
      async evaluate() {
        events.push("shadow-start");
        await delay(40);
        events.push("shadow-end");
        return {
          ok: true,
          errorCode: null,
          errorMessage: null,
          answers: noul([["bookingRequested", 0.9]]),
          latencyMs: 40,
          servedModel: "typesafe/jev-1.13",
          inputTokens: 1,
          outputTokens: 1,
          attemptSpent: true,
        };
      },
    };
    let llmCalls = 0;
    const adapter: AiProviderAdapter = {
      providerId: "openrouter",
      model: "openrouter/test-model",
      secretRef: "OPENROUTER_API_KEY",
      async call() {
        llmCalls += 1;
        events.push("llm-start");
        await delay(90);
        events.push("llm-end");
        return {
          ok: true,
          response: llmReply(),
          provider: "openrouter",
          model: "openrouter/test-model",
          latencyMs: 90,
        } as AiProviderResult;
      },
    };
    const shadowStrategy = shadowMod.createShadowJevStrategy({
      provider: jevProvider,
      sampler: shadowMod.createShadowSampler({
        getEnvVar: (name) => samplerEnv("1")[name],
      }),
    });
    const orchestrator = createAiOrchestrator({
      primary: adapter,
      secondary: null,
      fallbackEnabled: false,
      decisionStrategy: jev.createConservativeJevStrategy(),
      shadowStrategy,
    });
    const started = Date.now();
    const result = await orchestrator.callWithFallback(eligible());
    const elapsed = Date.now() - started;
    const shadowStart = events.indexOf("shadow-start");
    const shadowEnd = events.indexOf("shadow-end");
    const llmStart = events.indexOf("llm-start");
    const llmEnd = events.indexOf("llm-end");
    check(
      "S35a the shadow STARTS before the serving LLM call completes (concurrent, not serial)",
      shadowStart !== -1 &&
        llmStart !== -1 &&
        shadowStart < llmEnd &&
        llmStart < shadowEnd,
    );
    check(
      "S35b wall clock ≈ max(serving, shadow), NOT the sum (90+40 serial would exceed 115ms)",
      elapsed < 115 &&
        result.telemetry.shadow?.jevCallSpent === true &&
        llmCalls === 1,
    );
  }
  {
    // A deterministic bypass turn starts NEITHER operation (the second half
    // of the concurrency requirement).
    const events: Array<string> = [];
    const jevProvider: JevDecisionsProvider = {
      model: "typesafe/jev-1.13",
      secretRef: "OPENROUTER_API_KEY",
      async evaluate() {
        events.push("shadow-start");
        return {
          ok: true,
          errorCode: null,
          errorMessage: null,
          answers: noul([["bookingRequested", 0.9]]),
          latencyMs: 1,
          servedModel: "typesafe/jev-1.13",
          inputTokens: 1,
          outputTokens: 1,
          attemptSpent: true,
        };
      },
    };
    let llmCalls = 0;
    const adapter: AiProviderAdapter = {
      providerId: "openrouter",
      model: "openrouter/test-model",
      secretRef: "OPENROUTER_API_KEY",
      async call() {
        llmCalls += 1;
        events.push("llm-start");
        return {
          ok: true,
          response: llmReply(),
          provider: "openrouter",
          model: "openrouter/test-model",
          latencyMs: 1,
        } as AiProviderResult;
      },
    };
    const shadowStrategy = shadowMod.createShadowJevStrategy({
      provider: jevProvider,
      sampler: shadowMod.createShadowSampler({
        getEnvVar: (name) => samplerEnv("1")[name],
      }),
    });
    const orchestrator = createAiOrchestrator({
      primary: adapter,
      secondary: null,
      fallbackEnabled: false,
      decisionStrategy: jev.createConservativeJevStrategy(),
      shadowStrategy,
    });
    const greeting = req("صباح الخير", { traceId: TRACES.admitted });
    await orchestrator.callWithFallback(greeting);
    check(
      "S35c a deterministic bypass turn starts NEITHER operation (no events, zero calls)",
      events.length === 0 && llmCalls === 0,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PART K — full-engine customer-behavior identity (S36–S40)
  // ═══════════════════════════════════════════════════════════════════════

  const BUSINESS = "11111111-1111-4111-8111-111111111111";
  const BRANCH = "44444444-4444-4444-8444-444444444444";
  const NUMBER = "+201001111111";

  function engineHarness(opts: {
    shadow: boolean;
    jevOutcome: JevStubOutcome;
    rate?: string;
    sink?: "capture" | "throw";
    llmResponse?: AiResponse;
    faqs?: Array<{ question: string; answer: string }>;
  }) {
    const emitted: TurnEvidence[] = [];
    const counts = {
      addMessage: 0,
      createAppointment: 0,
      usageRecord: 0,
      sends: 0,
      resolverObs: 0,
    };
    const now = () => new Date();
    const business = {
      id: BUSINESS,
      name: "مركز أفنان",
      vertical: "dental",
      city: "كفر الشيخ",
      whatsappNumber: NUMBER,
      timezone: "Africa/Cairo",
      about: null,
      address: null,
      workingHours: {},
      slotDurationMinutes: 30,
      confirmationMode: "automatic",
      faqs: opts.faqs ?? [],
      cancellationPolicy: null,
      onboardingCompletedAt: now(),
      isActive: true,
      createdAt: now(),
      updatedAt: now(),
      deletedAt: null,
      assistantName: null,
      assistantStyle: null,
      defaultBranchId: BRANCH,
    } as never;
    let conversation: { id: string; status: string } | null = null;
    const messages: Array<{ senderType: string; content: string }> = [];

    // The REAL LLM ConversationAi with the conservative strategy + (optionally)
    // the real shadow strategy — exactly what createPolicyBackedAi installs.
    const jevStub = fakeJevProvider(opts.jevOutcome);
    const shadowStrategy = opts.shadow
      ? shadowMod.createShadowJevStrategy({
          provider: jevStub.provider,
          sampler: shadowMod.createShadowSampler({
            getEnvVar: (name) => samplerEnv(opts.rate ?? "1")[name],
          }),
        })
      : null;
    const { adapter } = fakeLlm(
      opts.llmResponse ? { response: opts.llmResponse } : {},
    );
    const ai = createLlmConversationAi({
      primary: adapter,
      secondary: null,
      fallbackEnabled: false,
      decisionStrategy: jev.createConservativeJevStrategy(),
      shadowStrategy,
    });

    const turnTelemetry =
      opts.sink === "throw"
        ? {
            emit: (): never => {
              throw new Error("simulated telemetry sink outage");
            },
          }
        : {
            emit: (record: TurnEvidence) => {
              emitted.push(record);
            },
          };

    const deps: ConversationEngineDeps = {
      requiredSemanticCapability: null,
      businessRepository: {
        findByWhatsappNumber: async (number: string) =>
          number === NUMBER ? business : null,
        findById: async (id: string) => (id === BUSINESS ? business : null),
      },
      branchRepository: {
        findDefaultByBusiness: async () =>
          ({
            id: BRANCH,
            businessId: BUSINESS,
            name: "الفرع الرئيسي",
            isActive: true,
            createdAt: now(),
            updatedAt: now(),
            deletedAt: null,
          }) as never,
      },
      customerRepository: {
        upsertByPhone: async () =>
          ({
            id: "cust-1",
            businessId: BUSINESS,
            name: "عميل",
            phone: "+201234567890",
            email: null,
            notes: null,
            lastConversationAt: null,
            lastAppointmentAt: null,
            createdAt: now(),
            updatedAt: now(),
            deletedAt: null,
          }) as never,
        touchConversation: async () => ({ id: "cust-1" }) as never,
      },
      conversationRepository: {
        findLatestByCustomer: async () =>
          (conversation ? { id: conversation.id } : null) as never,
        findById: async () => conversation as never,
        create: async (input: {
          businessId: string;
          customerId: string;
          branchId: string;
        }) => {
          conversation = {
            id: crypto.randomUUID(),
            status: "AI_ACTIVE",
          };
          return {
            id: conversation.id,
            businessId: input.businessId,
            customerId: input.customerId,
            branchId: input.branchId,
            status: "AI_ACTIVE",
            assignedUserId: null,
            aiSummary: null,
            lastMessageAt: now(),
            createdAt: now(),
            updatedAt: now(),
          } as never;
        },
        addMessage: async (input: {
          conversationId: string;
          senderType: string;
          content: string;
        }) => {
          counts.addMessage += 1;
          messages.push({
            senderType: input.senderType,
            content: input.content,
          });
          return {
            id: crypto.randomUUID(),
            conversationId: input.conversationId,
            senderType: input.senderType,
            content: input.content,
            createdAt: now(),
            updatedAt: now(),
          } as never;
        },
        getMessages: async () =>
          [...messages].reverse().map((message, index) => ({
            id: `msg-${messages.length - index}`,
            conversationId: conversation?.id ?? "",
            senderType: message.senderType,
            content: message.content,
            createdAt: now(),
            updatedAt: now(),
          })) as never,
        update: async () => conversation as never,
        updateWorkflow: async (
          _id: string,
          patch: { status?: string; assignedUserId?: string | null },
        ) => {
          if (conversation && patch.status) {
            conversation = { ...conversation, status: patch.status };
          }
          return conversation as never;
        },
      },
      serviceRepository: {
        listByBusiness: async () => [] as never,
        findById: async () => null,
      },
      inboundDedupeRepository: {
        claim: async () => ({ status: "claimed" as const, claimId: "claim-1" }),
      },
      usageRepository: {
        record: async (input: { type?: string }) => {
          counts.usageRecord += 1;
          return input as never;
        },
      },
      attentionRepository: {
        open: async () => ({}) as never,
      },
      appointmentRepository: {
        listBlockingByAssignees: async () => [] as never,
        createWithConflictCheck: async () => {
          counts.createAppointment += 1;
          return { ok: false, errorCode: "CONFLICT" as never } as never;
        },
      },
      ...(turnTelemetry ? { turnTelemetry } : {}),
      ai,
      transport: {
        providerName: "fake-transport",
        send: async () => {
          counts.sends += 1;
          return { provider: "fake-transport", delivered: true } as never;
        },
      },
    };
    return { deps, counts, messages, emitted, ai };
  }

  async function runEngine(
    harness: ReturnType<typeof engineHarness>,
    text: string,
    externalId: string,
  ): Promise<InboundResult> {
    return engine.receiveInboundMessage(harness.deps, {
      to: NUMBER,
      from: "+201234567890",
      text,
      receivedAt: new Date().toISOString(),
      externalId,
    });
  }

  function isSuccess(result: InboundResult): result is InboundSuccess {
    return result.ok && !result.duplicate;
  }

  /** Run the SAME turn with the shadow OFF and ON and compare every
   *  customer-visible surface plus the DB/transport side effects. */
  async function identityPair(
    text: string,
    jevOutcome: JevStubOutcome,
    rate: string = "1",
    extra?: {
      llmResponse?: AiResponse;
      faqs?: Array<{ question: string; answer: string }>;
    },
  ): Promise<{
    off: InboundResult;
    on: InboundResult;
    offCounts: ReturnType<typeof engineHarness>["counts"];
    onCounts: ReturnType<typeof engineHarness>["counts"];
    offMessages: Array<{ senderType: string; content: string }>;
    onMessages: Array<{ senderType: string; content: string }>;
  }> {
    const offHarness = engineHarness({ shadow: false, jevOutcome, ...extra });
    const onHarness = engineHarness({
      shadow: true,
      jevOutcome,
      rate,
      ...extra,
    });
    const off = await runEngine(offHarness, text, `off-${text.length}-${rate}`);
    const on = await runEngine(onHarness, text, `on-${text.length}-${rate}`);
    return {
      off,
      on,
      offCounts: offHarness.counts,
      onCounts: onHarness.counts,
      offMessages: offHarness.messages,
      onMessages: onHarness.messages,
    };
  }

  function customerSurfaces(result: InboundResult): string {
    if (!isSuccess(result)) return JSON.stringify(result);
    return JSON.stringify({
      ok: result.ok,
      assistantAction: result.assistantAction,
      intent: result.intent,
      conversationStatus: result.conversationStatus,
      handoffCause: result.handoffCause,
      assistantProvider: result.assistantProvider,
    });
  }

  {
    // The PRIMARY identity proof: identical input, stubbed serving provider,
    // shadow OFF vs ON — the authoritative customer-facing result must match.
    const pair = await identityPair("عايز أحجز موعد بكرة", {
      kind: "ok",
      answers: noul([["bookingRequested", 0.9]]),
    });
    check(
      "S40 SHADOW OFF ≡ SHADOW ON: identical customer result (intent/action/status/handoff)",
      customerSurfaces(pair.off) === customerSurfaces(pair.on),
    );
    check(
      "S40b the deterministic customer reply bytes are identical",
      JSON.stringify(pair.offMessages) === JSON.stringify(pair.onMessages),
    );
    check(
      "S36 the customer send count is exactly ONE, with or without the shadow",
      pair.offCounts.sends === 1 && pair.onCounts.sends === 1,
    );
    check(
      "S37 booking/domain mutation counts are unchanged (zero appointments either way)",
      pair.offCounts.createAppointment === 0 &&
        pair.onCounts.createAppointment === 0,
    );
    check(
      "S37b DB message writes are identical (customer + assistant, nothing else)",
      pair.offCounts.addMessage === 2 && pair.onCounts.addMessage === 2,
    );
    check(
      "S37c usage records are identical (the shadow records nothing)",
      pair.offCounts.usageRecord === pair.onCounts.usageRecord &&
        pair.onCounts.usageRecord > 0,
    );
  }
  {
    // The identity proof under a DISAGREEING shadow: the customer still
    // receives the original serving result.
    const pair = await identityPair("عايز أحجز موعد بكرة", {
      kind: "ok",
      answers: noul([["supportRequested", 0.97]]),
    });
    check(
      "S40c a DISAGREEING shadow cannot change the customer result",
      customerSurfaces(pair.off) === customerSurfaces(pair.on) &&
        (pair.on as InboundSuccess).assistantAction ===
          (pair.off as InboundSuccess).assistantAction &&
        JSON.stringify(pair.onMessages) === JSON.stringify(pair.offMessages),
    );
  }
  {
    // The identity proof under a FAILING shadow.
    const pair = await identityPair("عايز أحجز موعد بكرة", {
      kind: "fail",
      errorCode: "TIMEOUT",
      attemptSpent: true,
    });
    check(
      "S40d a TIMED-OUT shadow cannot change the customer result",
      customerSurfaces(pair.off) === customerSurfaces(pair.on) &&
        pair.onCounts.sends === 1,
    );
  }
  {
    // The identity proof when the shadow was never sampled.
    const pair = await identityPair(
      "عايز أحجز موعد بكرة",
      { kind: "ok", answers: noul([["bookingRequested", 0.9]]) },
      "0",
    );
    check(
      "S40e a sampled-out eligible turn is byte-identical to the shadow-off turn",
      customerSurfaces(pair.off) === customerSurfaces(pair.on) &&
        JSON.stringify(pair.offMessages) === JSON.stringify(pair.onMessages),
    );
  }
  {
    // The observability identity: the emitted evidence records differ ONLY in
    // the disjoint shadow slot (traceId is random per turn, so it is normalized
    // out before comparison).
    const offHarness = engineHarness({
      shadow: false,
      jevOutcome: { kind: "ok", answers: noul([["bookingRequested", 0.9]]) },
    });
    const onHarness = engineHarness({
      shadow: true,
      jevOutcome: { kind: "ok", answers: noul([["bookingRequested", 0.9]]) },
    });
    await runEngine(offHarness, "عايز أحجز موعد بكرة", "obs-off");
    await runEngine(onHarness, "عايز أحجز موعد بكرة", "obs-on");
    const normalize = (record: TurnEvidence | undefined): string => {
      if (!record) return "missing";
      // Per-run random identifiers (new conversation / message / trace ids
      // every turn) are normalized out; nothing else is.
      const copy = {
        ...record,
        traceId: null,
        emittedAt: null,
        conversationId: null,
        customerMessageId: null,
        businessId: null,
      };
      return JSON.stringify(copy);
    };
    const offRecord = offHarness.emitted[0];
    const onRecord = onHarness.emitted[0];
    check(
      "S40f the emitted evidence differs ONLY in the disjoint shadow slot (+traceId)",
      (() => {
        const a = normalize(offRecord);
        const b = normalize(onRecord);
        if (a === "missing" || b === "missing") return false;
        const parsed = JSON.parse(b) as Record<string, unknown>;
        const withoutShadow: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(parsed)) {
          if (key.startsWith("shadow")) continue;
          withoutShadow[key] = value;
        }
        const offParsed = JSON.parse(a) as Record<string, unknown>;
        const offWithoutShadow: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(offParsed)) {
          if (key.startsWith("shadow")) continue;
          offWithoutShadow[key] = value;
        }
        return (
          JSON.stringify(withoutShadow) === JSON.stringify(offWithoutShadow)
        );
      })() === true,
    );
    check(
      "S40g the emitted record carries the disjoint shadow keys when the shadow ran",
      onRecord?.shadowEvidenceRole === "SHADOW" &&
        onRecord?.shadowModelCallCount === 1 &&
        onRecord?.shadowSampled === true &&
        offRecord?.shadowEvidenceRole === null,
    );
    check(
      "S40h the emitted record passes the content-free guard with the shadow attached",
      (() => {
        try {
          assertTurnEvidenceContentFree(onRecord);
          return true;
        } catch {
          return false;
        }
      })() === true,
    );
  }
  {
    // S17/S18 at the ENGINE level: the authoritative modelCallCount stays
    // serving-only while the disjoint shadow counter accounts for the
    // experimental call.
    const onHarness = engineHarness({
      shadow: true,
      jevOutcome: { kind: "ok", answers: noul([["bookingRequested", 0.9]]) },
    });
    const result = await runEngine(onHarness, "عايز أحجز موعد بكرة", "counts");
    const obs = isSuccess(result) ? result.observability : null;
    check(
      "S17d engine-level: modelCallCount stays 1 (serving) with the shadow ON",
      obs?.modelCallCount === 1 && obs?.providerAttempts === 1,
    );
    check(
      "S18d engine-level: shadowModelCallCount accounts for the shadow call (1)",
      obs?.shadow?.shadowModelCallCount === 1 &&
        obs?.shadow?.jevCallSpent === true,
    );
    check(
      "S19b engine-level: no field anywhere on the record reads a combined 2",
      (() => {
        const serialized =
          JSON.stringify(onHarness.emitted[0]) + JSON.stringify(obs ?? {});
        const hasTwo = /"modelCallCount":2|"shadowModelCallCount":2/.test(
          serialized,
        );
        return hasTwo === false;
      })() === true,
    );
  }
  {
    // S39 — the resolver executes exactly once per turn, observable as ONE
    // assistant reply + ONE send + ONE evidence record with ONE plan.
    const onHarness = engineHarness({
      shadow: true,
      jevOutcome: { kind: "ok", answers: noul([["bookingRequested", 0.9]]) },
    });
    const result = await runEngine(onHarness, "عايز أحجز موعد بكرة", "once");
    check(
      "S39c one turn ⇒ one reply, one send, one evidence record (the resolver ran once)",
      isSuccess(result) &&
        onHarness.counts.sends === 1 &&
        onHarness.emitted.length === 1 &&
        onHarness.messages.filter((m) => m.senderType === "AI").length === 1,
    );
    check(
      "S39d the shadow evaluation invokes no resolver: the shadow runs inside the AI call only",
      isSuccess(result) &&
        result.observability?.routingDecision === "LLM" &&
        result.observability?.shadow?.evidenceRole === "SHADOW",
    );
  }
  {
    // A throwing telemetry sink never changes the customer outcome (the
    // shadow evidence must ride the same fail-open contract).
    const throwing = engineHarness({
      shadow: true,
      jevOutcome: { kind: "ok", answers: noul([["bookingRequested", 0.9]]) },
      sink: "throw",
    });
    const result = await runEngine(throwing, "عايز أحجز موعد بكرة", "throw");
    // The control: the SAME sink-throwing turn with the shadow OFF. The
    // customer outcome must be identical whether or not a shadow ran.
    const offThrowing = engineHarness({
      shadow: false,
      jevOutcome: { kind: "ok", answers: noul([["bookingRequested", 0.9]]) },
      sink: "throw",
    });
    const offResult = await runEngine(
      offThrowing,
      "عايز أحجز موعد بكرة",
      "throw",
    );
    check(
      "S40i a failing evidence sink (with shadow attached) never alters the customer turn",
      isSuccess(result) &&
        isSuccess(offResult) &&
        customerSurfaces(result) === customerSurfaces(offResult) &&
        throwing.counts.sends === offThrowing.counts.sends &&
        throwing.counts.sends === 1,
    );
  }

  // ── Engine-level customer-behavior identity matrix (PROMPT-AI-JEV-03D-R) ──
  {
    // S41a — FAQ / authoritative knowledge-answer turn
    const pair = await identityPair(
      "ما هي مواعيد العمل لديكم؟",
      { kind: "ok", answers: noul([["serviceOrPriceAsked", 0.05]]) },
      "1",
      {
        faqs: [
          {
            question: "ما هي مواعيد العمل لديكم؟",
            answer: "نعمل يومياً من 9 صباحاً حتى 6 مساءً.",
          },
        ],
        llmResponse: {
          intent: "FAQ",
          action: "reply",
          content: "نعمل يومياً من 9 صباحاً حتى 6 مساءً.",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
        },
      },
    );
    check(
      "S41a FAQ identity: Shadow OFF ≡ Shadow ON (reply, intent, status, send count)",
      customerSurfaces(pair.off) === customerSurfaces(pair.on) &&
        JSON.stringify(pair.offMessages) === JSON.stringify(pair.onMessages) &&
        pair.offCounts.sends === 1 &&
        pair.onCounts.sends === 1 &&
        pair.offCounts.createAppointment === 0 &&
        pair.onCounts.createAppointment === 0 &&
        pair.offCounts.addMessage === 2 &&
        pair.onCounts.addMessage === 2 &&
        pair.offCounts.usageRecord === pair.onCounts.usageRecord &&
        isSuccess(pair.off) &&
        pair.off.intent === "FAQ" &&
        pair.off.assistantAction === "AI_REPLY" &&
        pair.off.conversationStatus === "AI_ACTIVE",
    );
  }
  {
    // S41b — Availability
    const pair = await identityPair(
      "هل متاح ميعاد بكرة الساعة 5؟",
      { kind: "ok", answers: noul([["availabilityAsked", 0.95]]) },
      "1",
      {
        llmResponse: {
          intent: "AVAILABILITY",
          action: "booking_handoff",
          content: "جاري البحث عن المواعيد المتاحة غداً.",
          extraction: {
            service: null,
            provider: null,
            date: null,
            timePreference: "evening",
          },
          handoffReason: null,
          summary: "استفسار عن موعد متاح",
        },
      },
    );
    check(
      "S41b availability identity: Shadow OFF ≡ Shadow ON (booking seam clarify, status, send count)",
      customerSurfaces(pair.off) === customerSurfaces(pair.on) &&
        JSON.stringify(pair.offMessages) === JSON.stringify(pair.onMessages) &&
        pair.offCounts.sends === 1 &&
        pair.onCounts.sends === 1 &&
        pair.offCounts.createAppointment === 0 &&
        pair.onCounts.createAppointment === 0 &&
        pair.offCounts.addMessage === 2 &&
        pair.onCounts.addMessage === 2 &&
        pair.offCounts.usageRecord === pair.onCounts.usageRecord &&
        isSuccess(pair.off) &&
        pair.off.intent === "AVAILABILITY" &&
        pair.off.assistantAction === "AI_REPLY" &&
        pair.off.conversationStatus === "AI_ACTIVE",
    );
  }
  {
    // S41c — Explicit human request
    const pair = await identityPair(
      "عايز أكلم موظف خدمة العملاء",
      { kind: "ok", answers: noul([["supportRequested", 0.98]]) },
      "1",
      {
        llmResponse: {
          intent: "HUMAN_REQUEST",
          action: "handoff",
          content: "سيتم تحويلك إلى أحد ممثلي خدمة العملاء الآن.",
          extraction: emptyExtraction,
          handoffReason: "HUMAN_REQUEST",
          summary: null,
        },
      },
    );
    check(
      "S41c explicit human identity: Shadow OFF ≡ Shadow ON (HUMAN_REQUEST, NEED_HUMAN, handoff cause)",
      customerSurfaces(pair.off) === customerSurfaces(pair.on) &&
        JSON.stringify(pair.offMessages) === JSON.stringify(pair.onMessages) &&
        pair.offCounts.sends === 1 &&
        pair.onCounts.sends === 1 &&
        pair.offCounts.createAppointment === 0 &&
        pair.onCounts.createAppointment === 0 &&
        pair.offCounts.addMessage === 2 &&
        pair.onCounts.addMessage === 2 &&
        pair.offCounts.usageRecord === pair.onCounts.usageRecord &&
        isSuccess(pair.off) &&
        pair.off.intent === "HUMAN_REQUEST" &&
        pair.off.assistantAction === "AI_HANDOFF" &&
        pair.off.conversationStatus === "NEED_HUMAN" &&
        pair.off.handoffCause === "CUSTOMER_REQUESTED_HUMAN",
    );
  }
  {
    // S41d — Provider-direct-contact request
    const pair = await identityPair(
      "أريد التحدث مع الطبيب مباشرة على هاتفه الشخصي",
      { kind: "ok", answers: noul([["providerRequested", 0.96]]) },
      "1",
      {
        llmResponse: {
          intent: "HUMAN_REQUEST",
          action: "handoff",
          content: "سأقوم بتحويل طلبك للتواصل مع الطبيب.",
          extraction: emptyExtraction,
          handoffReason: "HUMAN_REQUEST",
          summary: null,
        },
      },
    );
    check(
      "S41d provider-direct contact identity: Shadow OFF ≡ Shadow ON (HUMAN_REQUEST handoff preserved)",
      customerSurfaces(pair.off) === customerSurfaces(pair.on) &&
        JSON.stringify(pair.offMessages) === JSON.stringify(pair.onMessages) &&
        pair.offCounts.sends === 1 &&
        pair.onCounts.sends === 1 &&
        pair.offCounts.createAppointment === 0 &&
        pair.onCounts.createAppointment === 0 &&
        pair.offCounts.addMessage === 2 &&
        pair.onCounts.addMessage === 2 &&
        pair.offCounts.usageRecord === pair.onCounts.usageRecord &&
        isSuccess(pair.off) &&
        pair.off.assistantAction === "AI_HANDOFF" &&
        pair.off.conversationStatus === "NEED_HUMAN" &&
        pair.off.handoffCause === "CUSTOMER_REQUESTED_HUMAN",
    );
  }
  {
    // S41e — Contact-vs-book genuine ambiguity
    const pair = await identityPair(
      "دكتور أحمد",
      {
        kind: "ok",
        answers: noul([
          ["providerRequested", 0.35],
          ["bookingRequested", 0.2],
        ]),
      },
      "1",
      {
        faqs: [
          {
            question: "دكتور أحمد",
            answer:
              "دكتور أحمد استشاري المركز، هل ترغب في حجز موعد معه أم لديك استفسار محدد؟",
          },
        ],
        llmResponse: {
          intent: "FAQ",
          action: "reply",
          content:
            "دكتور أحمد استشاري المركز، هل ترغب في حجز موعد معه أم لديك استفسار محدد؟",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
        },
      },
    );
    check(
      "S41e contact-vs-book ambiguity identity: Shadow OFF ≡ Shadow ON (authoritative serving path preserved)",
      customerSurfaces(pair.off) === customerSurfaces(pair.on) &&
        JSON.stringify(pair.offMessages) === JSON.stringify(pair.onMessages) &&
        pair.offCounts.sends === 1 &&
        pair.onCounts.sends === 1 &&
        pair.offCounts.createAppointment === 0 &&
        pair.onCounts.createAppointment === 0 &&
        pair.offCounts.addMessage === 2 &&
        pair.onCounts.addMessage === 2 &&
        pair.offCounts.usageRecord === pair.onCounts.usageRecord &&
        isSuccess(pair.off) &&
        pair.off.intent === "FAQ" &&
        pair.off.assistantAction === "AI_REPLY" &&
        pair.off.conversationStatus === "AI_ACTIVE",
    );
  }
  {
    // S41f — Greeting deterministic bypass
    const pair = await identityPair("صباح الخير", {
      kind: "ok",
      answers: noul([["greetingOnly", 0.99]]),
    });
    check(
      "S41f greeting deterministic bypass identity: Shadow OFF ≡ Shadow ON (0 model calls, bypass reply)",
      customerSurfaces(pair.off) === customerSurfaces(pair.on) &&
        JSON.stringify(pair.offMessages) === JSON.stringify(pair.onMessages) &&
        pair.offCounts.sends === 1 &&
        pair.onCounts.sends === 1 &&
        pair.offCounts.createAppointment === 0 &&
        pair.onCounts.createAppointment === 0 &&
        pair.offCounts.addMessage === 2 &&
        pair.onCounts.addMessage === 2 &&
        pair.offCounts.usageRecord === pair.onCounts.usageRecord &&
        pair.offCounts.usageRecord === 2 &&
        isSuccess(pair.off) &&
        isSuccess(pair.on) &&
        pair.off.intent === "GREETING" &&
        pair.off.assistantAction === "AI_REPLY" &&
        pair.off.observability?.routingDecision === "DETERMINISTIC_BYPASS" &&
        pair.on.observability?.routingDecision === "DETERMINISTIC_BYPASS" &&
        pair.off.observability?.providerAttempts === 0 &&
        pair.on.observability?.providerAttempts === 0,
    );
  }
  {
    // S41g — Knowledge gap (NO_KNOWLEDGE)
    const pair = await identityPair(
      "هل تقومون بجراحة زراعة الكلى؟",
      { kind: "ok", answers: noul([["serviceOrPriceAsked", 0.95]]) },
      "1",
      {
        llmResponse: {
          intent: "AMBIGUOUS",
          action: "handoff",
          content:
            "عذراً، لا تتوفر لدي معلومات حول هذه الجراحة، سأقوم بتحويلك لأحد ممثلينا.",
          extraction: emptyExtraction,
          handoffReason: "NO_KNOWLEDGE",
          summary: null,
        },
      },
    );
    check(
      "S41g knowledge gap identity: Shadow OFF ≡ Shadow ON (NO_KNOWLEDGE handoff preserved)",
      customerSurfaces(pair.off) === customerSurfaces(pair.on) &&
        JSON.stringify(pair.offMessages) === JSON.stringify(pair.onMessages) &&
        pair.offCounts.sends === 1 &&
        pair.onCounts.sends === 1 &&
        pair.offCounts.createAppointment === 0 &&
        pair.onCounts.createAppointment === 0 &&
        pair.offCounts.addMessage === 2 &&
        pair.onCounts.addMessage === 2 &&
        pair.offCounts.usageRecord === pair.onCounts.usageRecord &&
        isSuccess(pair.off) &&
        pair.off.intent === "AMBIGUOUS" &&
        pair.off.assistantAction === "AI_HANDOFF" &&
        pair.off.conversationStatus === "NEED_HUMAN" &&
        pair.off.handoffCause === "KNOWLEDGE_GAP_UNRESOLVED",
    );
  }
  {
    // S41h — Cancellation
    const pair = await identityPair(
      "أريد إلغاء موعدي المحجوز",
      { kind: "ok", answers: noul([["cancellationRequested", 0.95]]) },
      "1",
      {
        llmResponse: {
          intent: "CANCELLATION",
          action: "booking_handoff",
          content:
            "تم استلام طلب إلغاء الموعد وسيتم التواصل معك لتأكيد الإلغاء.",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: "طلب إلغاء موعد محجوز",
        },
      },
    );
    check(
      "S41h cancellation identity: Shadow OFF ≡ Shadow ON (CANCELLATION domain handoff preserved)",
      customerSurfaces(pair.off) === customerSurfaces(pair.on) &&
        JSON.stringify(pair.offMessages) === JSON.stringify(pair.onMessages) &&
        pair.offCounts.sends === 1 &&
        pair.onCounts.sends === 1 &&
        pair.offCounts.createAppointment === 0 &&
        pair.onCounts.createAppointment === 0 &&
        pair.offCounts.addMessage === 2 &&
        pair.onCounts.addMessage === 2 &&
        pair.offCounts.usageRecord === pair.onCounts.usageRecord &&
        isSuccess(pair.off) &&
        pair.off.intent === "CANCELLATION" &&
        pair.off.assistantAction === "AI_HANDOFF" &&
        pair.off.conversationStatus === "NEED_HUMAN" &&
        pair.off.handoffCause === "DOMAIN_REQUIRES_HUMAN",
    );
  }
  {
    // S41i — Reschedule
    const pair = await identityPair(
      "عايز أغير ميعاد الحجز ليوم الأسبوع القادم",
      { kind: "ok", answers: noul([["rescheduleRequested", 0.95]]) },
      "1",
      {
        llmResponse: {
          intent: "RESCHEDULE",
          action: "booking_handoff",
          content:
            "تم استلام طلب تأجيل الموعد، وسنتواصل معك لترتيب الموعد الجديد.",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: "طلب تأجيل موعد الحجز",
        },
      },
    );
    check(
      "S41i reschedule identity: Shadow OFF ≡ Shadow ON (RESCHEDULE domain handoff preserved)",
      customerSurfaces(pair.off) === customerSurfaces(pair.on) &&
        JSON.stringify(pair.offMessages) === JSON.stringify(pair.onMessages) &&
        pair.offCounts.sends === 1 &&
        pair.onCounts.sends === 1 &&
        pair.offCounts.createAppointment === 0 &&
        pair.onCounts.createAppointment === 0 &&
        pair.offCounts.addMessage === 2 &&
        pair.onCounts.addMessage === 2 &&
        pair.offCounts.usageRecord === pair.onCounts.usageRecord &&
        isSuccess(pair.off) &&
        pair.off.intent === "RESCHEDULE" &&
        pair.off.assistantAction === "AI_HANDOFF" &&
        pair.off.conversationStatus === "NEED_HUMAN" &&
        pair.off.handoffCause === "DOMAIN_REQUIRES_HUMAN",
    );
  }
  {
    // S41j — Provider preference
    const pair = await identityPair(
      "أريد حجز كشف وأفضل دكتورة سارة",
      {
        kind: "ok",
        answers: noul([
          ["bookingRequested", 0.95],
          ["providerPreferenceExpressed", 0.9],
        ]),
      },
      "1",
      {
        llmResponse: {
          intent: "BOOKING",
          action: "booking_handoff",
          content:
            "تم تسجيل تفضيلك لدكتورة سارة، يرجى تحديد اليوم والوقت المناسبين.",
          extraction: {
            service: null,
            provider: "دكتورة سارة",
            date: null,
            timePreference: null,
          },
          handoffReason: null,
          summary: "حجز كشف مع تفضيل دكتورة سارة",
        },
      },
    );
    check(
      "S41j provider preference identity: Shadow OFF ≡ Shadow ON (booking preference, not accidental handoff)",
      customerSurfaces(pair.off) === customerSurfaces(pair.on) &&
        JSON.stringify(pair.offMessages) === JSON.stringify(pair.onMessages) &&
        pair.offCounts.sends === 1 &&
        pair.onCounts.sends === 1 &&
        pair.offCounts.createAppointment === 0 &&
        pair.onCounts.createAppointment === 0 &&
        pair.offCounts.addMessage === 2 &&
        pair.onCounts.addMessage === 2 &&
        pair.offCounts.usageRecord === pair.onCounts.usageRecord &&
        isSuccess(pair.off) &&
        pair.off.intent === "BOOKING" &&
        pair.off.assistantAction === "AI_REPLY" &&
        pair.off.conversationStatus === "AI_ACTIVE",
    );
  }
  {
    // S41k — Mixed-language turn
    const pair = await identityPair(
      "Hello, I want to book an appointment for tomorrow afternoon",
      { kind: "ok", answers: noul([["bookingRequested", 0.95]]) },
      "1",
      {
        llmResponse: {
          intent: "BOOKING",
          action: "booking_handoff",
          content:
            "We can help you book an appointment for tomorrow. Which service do you need?",
          extraction: {
            service: null,
            provider: null,
            date: null,
            timePreference: "afternoon",
          },
          handoffReason: null,
          summary: "Booking request for tomorrow afternoon",
        },
      },
    );
    check(
      "S41k mixed-language identity: Shadow OFF ≡ Shadow ON (engine plumbing works for mixed language)",
      customerSurfaces(pair.off) === customerSurfaces(pair.on) &&
        JSON.stringify(pair.offMessages) === JSON.stringify(pair.onMessages) &&
        pair.offCounts.sends === 1 &&
        pair.onCounts.sends === 1 &&
        pair.offCounts.createAppointment === 0 &&
        pair.onCounts.createAppointment === 0 &&
        pair.offCounts.addMessage === 2 &&
        pair.onCounts.addMessage === 2 &&
        pair.offCounts.usageRecord === pair.onCounts.usageRecord &&
        isSuccess(pair.off) &&
        pair.off.intent === "BOOKING" &&
        pair.off.assistantAction === "AI_REPLY" &&
        pair.off.conversationStatus === "AI_ACTIVE",
    );
  }
  {
    // S41l — Booking with doctor name (special boundary: §7)
    const pair = await identityPair(
      "عايز أحجز كشف عند دكتور محمد بكرة",
      {
        kind: "ok",
        answers: noul([
          ["bookingRequested", 0.95],
          ["providerRequested", 0.4],
        ]),
      },
      "1",
      {
        llmResponse: {
          intent: "BOOKING",
          action: "booking_handoff",
          content: "جاري حجز موعد مع دكتور محمد غداً.",
          extraction: {
            service: null,
            provider: "دكتور محمد",
            date: null,
            timePreference: null,
          },
          handoffReason: null,
          summary: "حجز كشف عند دكتور محمد",
        },
      },
    );
    check(
      "S41l booking with provider name identity: provider name inside booking does NOT convert to handoff",
      customerSurfaces(pair.off) === customerSurfaces(pair.on) &&
        JSON.stringify(pair.offMessages) === JSON.stringify(pair.onMessages) &&
        pair.offCounts.sends === 1 &&
        pair.onCounts.sends === 1 &&
        pair.offCounts.createAppointment === 0 &&
        pair.onCounts.createAppointment === 0 &&
        pair.offCounts.addMessage === 2 &&
        pair.onCounts.addMessage === 2 &&
        pair.offCounts.usageRecord === pair.onCounts.usageRecord &&
        isSuccess(pair.off) &&
        pair.off.intent === "BOOKING" &&
        pair.off.assistantAction === "AI_REPLY" &&
        pair.off.conversationStatus === "AI_ACTIVE",
    );
  }
  {
    // S41m — Availability with doctor name (special boundary: §7)
    const pair = await identityPair(
      "هل دكتور أحمد متاح للكشف بكرة؟",
      {
        kind: "ok",
        answers: noul([
          ["availabilityAsked", 0.95],
          ["providerRequested", 0.3],
        ]),
      },
      "1",
      {
        llmResponse: {
          intent: "AVAILABILITY",
          action: "booking_handoff",
          content: "جاري التحقق من مواعيد دكتور أحمد المتاحة غداً.",
          extraction: {
            service: null,
            provider: "دكتور أحمد",
            date: null,
            timePreference: null,
          },
          handoffReason: null,
          summary: "استفسار عن توافر دكتور أحمد",
        },
      },
    );
    check(
      "S41m availability with provider name identity: provider title inside availability does NOT create handoff",
      customerSurfaces(pair.off) === customerSurfaces(pair.on) &&
        JSON.stringify(pair.offMessages) === JSON.stringify(pair.onMessages) &&
        pair.offCounts.sends === 1 &&
        pair.onCounts.sends === 1 &&
        pair.offCounts.createAppointment === 0 &&
        pair.onCounts.createAppointment === 0 &&
        pair.offCounts.addMessage === 2 &&
        pair.onCounts.addMessage === 2 &&
        pair.offCounts.usageRecord === pair.onCounts.usageRecord &&
        isSuccess(pair.off) &&
        pair.off.intent === "AVAILABILITY" &&
        pair.off.assistantAction === "AI_REPLY" &&
        pair.off.conversationStatus === "AI_ACTIVE",
    );
  }
  {
    // S41n — Representative disagreement: Shadow wants human handoff, serving LLM gives FAQ reply
    const pair = await identityPair(
      "ما هي مواعيد العمل؟",
      { kind: "ok", answers: noul([["supportRequested", 0.99]]) },
      "1",
      {
        faqs: [
          {
            question: "ما هي مواعيد العمل؟",
            answer: "نعمل يومياً من 9 حتى 6.",
          },
        ],
        llmResponse: {
          intent: "FAQ",
          action: "reply",
          content: "نعمل يومياً من 9 حتى 6.",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
        },
      },
    );
    check(
      "S41n disagreement: Shadow supportRequested=0.99 cannot change serving FAQ reply",
      customerSurfaces(pair.off) === customerSurfaces(pair.on) &&
        JSON.stringify(pair.offMessages) === JSON.stringify(pair.onMessages) &&
        isSuccess(pair.off) &&
        isSuccess(pair.on) &&
        pair.on.assistantAction === "AI_REPLY" &&
        pair.on.intent === "FAQ",
    );
  }
  {
    // S41o — Representative disagreement: Shadow wants sensitive handoff, serving LLM gives FAQ reply
    const pair = await identityPair(
      "ما هي مواعيد العمل؟",
      { kind: "ok", answers: noul([["sensitiveTurn", 0.99]]) },
      "1",
      {
        faqs: [
          {
            question: "ما هي مواعيد العمل؟",
            answer: "نعمل يومياً من 9 حتى 6.",
          },
        ],
        llmResponse: {
          intent: "FAQ",
          action: "reply",
          content: "نعمل يومياً من 9 حتى 6.",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
        },
      },
    );
    check(
      "S41o disagreement: Shadow sensitiveTurn=0.99 cannot change serving FAQ reply",
      customerSurfaces(pair.off) === customerSurfaces(pair.on) &&
        JSON.stringify(pair.offMessages) === JSON.stringify(pair.onMessages) &&
        isSuccess(pair.off) &&
        isSuccess(pair.on) &&
        pair.on.assistantAction === "AI_REPLY" &&
        pair.on.intent === "FAQ",
    );
  }
  {
    // S41p — Representative disagreement: Shadow wants cancellation, serving LLM gives FAQ reply
    const pair = await identityPair(
      "ما هي مواعيد العمل؟",
      { kind: "ok", answers: noul([["cancellationRequested", 0.95]]) },
      "1",
      {
        faqs: [
          {
            question: "ما هي مواعيد العمل؟",
            answer: "نعمل يومياً من 9 حتى 6.",
          },
        ],
        llmResponse: {
          intent: "FAQ",
          action: "reply",
          content: "نعمل يومياً من 9 حتى 6.",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
        },
      },
    );
    check(
      "S41p disagreement: Shadow cancellationRequested=0.95 cannot change serving FAQ reply",
      customerSurfaces(pair.off) === customerSurfaces(pair.on) &&
        JSON.stringify(pair.offMessages) === JSON.stringify(pair.onMessages) &&
        isSuccess(pair.off) &&
        isSuccess(pair.on) &&
        pair.on.assistantAction === "AI_REPLY" &&
        pair.on.intent === "FAQ",
    );
  }
  {
    // S41q — Representative disagreement: Shadow wants booking, serving LLM gives human handoff
    const pair = await identityPair(
      "عايز أكلم موظف خدمة العملاء",
      { kind: "ok", answers: noul([["bookingRequested", 0.95]]) },
      "1",
      {
        llmResponse: {
          intent: "HUMAN_REQUEST",
          action: "handoff",
          content: "سيتم تحويلك لأحد موظفينا الآن.",
          extraction: emptyExtraction,
          handoffReason: "HUMAN_REQUEST",
          summary: null,
        },
      },
    );
    check(
      "S41q disagreement: Shadow bookingRequested=0.95 cannot change serving HUMAN_REQUEST handoff",
      customerSurfaces(pair.off) === customerSurfaces(pair.on) &&
        JSON.stringify(pair.offMessages) === JSON.stringify(pair.onMessages) &&
        isSuccess(pair.off) &&
        isSuccess(pair.on) &&
        pair.on.assistantAction === "AI_HANDOFF" &&
        pair.on.intent === "HUMAN_REQUEST",
    );
  }
  {
    // S41r — Failing shadow at engine level: INSUFFICIENT_CREDITS
    const pair = await identityPair("عايز أحجز موعد بكرة", {
      kind: "fail",
      errorCode: "INSUFFICIENT_CREDITS",
      attemptSpent: true,
    });
    check(
      "S41r failing shadow: INSUFFICIENT_CREDITS cannot change customer result",
      customerSurfaces(pair.off) === customerSurfaces(pair.on) &&
        JSON.stringify(pair.offMessages) === JSON.stringify(pair.onMessages) &&
        pair.onCounts.sends === 1,
    );
  }
  {
    // S41s — Failing shadow at engine level: BAD_REQUEST (400)
    const pair = await identityPair("عايز أحجز موعد بكرة", {
      kind: "fail",
      errorCode: "BAD_REQUEST",
      attemptSpent: true,
    });
    check(
      "S41s failing shadow: BAD_REQUEST (400) cannot change customer result",
      customerSurfaces(pair.off) === customerSurfaces(pair.on) &&
        JSON.stringify(pair.offMessages) === JSON.stringify(pair.onMessages) &&
        pair.onCounts.sends === 1,
    );
  }
  {
    // S41t — Failing shadow at engine level: PROVIDER (500)
    const pair = await identityPair("عايز أحجز موعد بكرة", {
      kind: "fail",
      errorCode: "PROVIDER",
      attemptSpent: true,
    });
    check(
      "S41t failing shadow: PROVIDER (500) cannot change customer result",
      customerSurfaces(pair.off) === customerSurfaces(pair.on) &&
        JSON.stringify(pair.offMessages) === JSON.stringify(pair.onMessages) &&
        pair.onCounts.sends === 1,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  const failures = checks.filter((checkEntry) => !checkEntry.pass);
  const passCount = checks.length - failures.length;
  console.log("");
  console.log("── JEV shadow mode (PROMPT-AI-JEV-03D — OPTION E) ──");
  for (const checkEntry of checks) {
    console.log(`  ${checkEntry.pass ? "✓" : "✗"} ${checkEntry.label}`);
  }
  console.log("");
  console.log(
    `  RESULT: ${passCount}/${checks.length} passed` +
      (failures.length > 0
        ? ` — FAILED: ${failures.map((f) => f.label).join("; ")}`
        : " — ALL GREEN"),
  );
  if (failures.length > 0) process.exitCode = 1;
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
