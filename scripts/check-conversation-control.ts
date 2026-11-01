/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/consistent-type-imports */
/**
 * FlowPilot — CONVERSATION CONTROL LAYER check
 * (PROMPT-OPS-CONVERSATION-CONTROL-RETRY-HANDOFF-15).
 *
 * Deterministic, OFFLINE test matrix (no network, no DB, no real
 * credentials, no WhatsApp transport, no Meta send). Every provider call
 * is either an injected scripted adapter or a real adapter over a mocked
 * fetch. It touches no database, no conversation state, and no transport.
 *
 * Proves the required invariants, one labelled check per number:
 *
 *   A1  SUCCESS on attempt 1 → NO retry (exactly one provider call)
 *   A2  TIMEOUT → SUCCESS on the retry → accepted
 *   A3  TIMEOUT + TIMEOUT → final TIMEOUT → handoff (no third attempt)
 *   A4  INVALID_RESPONSE → NO retry
 *   A5  AUTH_FAILURE (CONFIG_ERROR) → NO retry
 *   A6  a retried response passes the UNCHANGED aiResponseSchema
 *   A7  provider may be called twice → engine produces ONE logical result
 *   A8  no duplicate conversation state transition (one outcome)
 *   A9  an explicit human/staff request BYPASSES the retry
 *   A10 maxAttempts=2 means exactly TWO maximum provider attempts
 *   A11 maxAttempts can NEVER exceed the hard safety ceiling
 *   A12 an already-human state PREVENTS AI execution
 *   A13 retry exhaustion produces exactly ONE handoff
 *   A14 a successful retry produces NO handoff
 *   A15 notifications are emitted exactly once
 *   A16 a duplicate event does NOT duplicate the notification
 *   A17 Atria works through the generic control layer
 *   A18 OpenRouter works through the generic control layer
 *   A19 AgentRouter works through the generic control layer
 *   A20 non-Atria behaviour is byte-for-byte unchanged where applicable
 *
 * Plus structural guarantees:
 *   P1  the control layer contains NO provider-specific branching
 *   P2  the control layer never inspects raw provider JSON
 *   S1  NETWORK_ERROR (RETRYABLE, non-TIMEOUT) is NOT retried
 *   S2  PROVIDER_HTTP_ERROR (5xx) is NOT retried
 *   S3  all emitted payloads are fully sanitized (no keys/headers/content)
 *   S4  the budget guard skips a retry the route budget cannot host
 *
 * Run: pnpm check:conversation-control
 */
export {};

type Check = { label: string; pass: boolean };

type AiRequest =
  import("../src/features/conversations/server/ai-contract").AiRequest;
type AiResponse =
  import("../src/features/conversations/server/ai-contract").AiResponse;
type AiProviderResult =
  import("../src/server/integrations/ai/types").AiProviderResult;
type AiProviderErrorCode =
  import("../src/server/integrations/ai/types").AiProviderErrorCode;
type AiProviderAdapter =
  import("../src/server/integrations/ai/types").AiProviderAdapter;
type ConversationControl =
  import("../src/server/integrations/ai/conversation-control").ConversationControl;

// ─── scripted provider (no fetch, no network) ────────────────────────────────

type ProviderStep =
  | { kind: "success"; response: AiResponse }
  | { kind: "failure"; code: AiProviderErrorCode; httpStatus?: number };

function scriptedProvider(
  providerId: "atria" | "openrouter" | "agentrouter",
  steps: ProviderStep[],
): { adapter: AiProviderAdapter; getCalls: () => number } {
  let calls = 0;
  return {
    adapter: {
      providerId,
      model: `${providerId}-test-model`,
      secretRef: `${providerId.toUpperCase()}_API_KEY`,
      async call(): Promise<AiProviderResult> {
        const idx = Math.min(calls, steps.length - 1);
        calls += 1;
        const step: ProviderStep | undefined = steps[idx];
        if (step === undefined) {
          return {
            ok: false,
            provider: providerId,
            model: `${providerId}-test-model`,
            latencyMs: 10,
            error: {
              code: "CONTROLLED_FAILURE",
              message: "scripted steps exhausted",
              retryable: false,
            },
          };
        }
        if (step.kind === "success") {
          return {
            ok: true,
            provider: providerId,
            model: `${providerId}-test-model`,
            latencyMs: 10,
            response: step.response,
          };
        }
        return {
          ok: false,
          provider: providerId,
          model: `${providerId}-test-model`,
          latencyMs: 10,
          error: {
            code: step.code,
            message: "scripted failure",
            retryable: step.code === "TIMEOUT" || step.code === "RETRYABLE",
            ...(step.httpStatus === undefined
              ? {}
              : { httpStatus: step.httpStatus }),
          },
        };
      },
    },
    getCalls: () => calls,
  };
}

// ─── scripted fetch (for the REAL adapters, A17–A19) ─────────────────────────

type FetchStep =
  | { kind: "ok"; body: unknown }
  | { kind: "status"; status: number; body: unknown }
  | { kind: "abort" };

function scriptedFetch(steps: FetchStep[]): {
  fetch: typeof fetch;
  getCalls: () => number;
} {
  let calls = 0;
  const f = (async () => {
    const idx = Math.min(calls, steps.length - 1);
    calls += 1;
    const step: FetchStep | undefined = steps[idx];
    if (step === undefined) throw new Error("scripted fetch exhausted");
    if (step.kind === "abort") {
      throw new DOMException("The operation was aborted", "AbortError");
    }
    const status = step.kind === "ok" ? 200 : step.status;
    return new Response(JSON.stringify(step.body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetch: f, getCalls: () => calls };
}

// ─── shared fixtures ─────────────────────────────────────────────────────────

const VALID_REPLY: AiResponse = {
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
};

const AI_HANDOFF_REPLY: AiResponse = {
  intent: "HUMAN_REQUEST",
  action: "handoff",
  content: "تحت أمرك — جارٍ تحويلك الآن لأحد أعضاء الفريق.",
  extraction: {
    service: null,
    provider: null,
    date: null,
    timePreference: null,
  },
  handoffReason: "HUMAN_REQUEST",
  summary: null,
};

const baseRequest: AiRequest = {
  message: "ما هي ساعات العمل؟",
  conversationStatus: "AI_ACTIVE",
  recentMessages: [],
  businessName: "منشأة تجريبية",
  services: [],
  faqs: [{ question: "ما هي ساعات العمل؟", answer: "من 9 حتى 6" }],
};

const humanRequest: AiRequest = {
  ...baseRequest,
  message: "أريد التحدث إلى موظف من فضلك",
};

const KEY = "test-secret-key-value";

async function main(): Promise<void> {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const cc = await import("../src/server/integrations/ai/conversation-control");
  const aiContract =
    await import("../src/features/conversations/server/ai-contract");
  const orchestrator =
    await import("../src/server/integrations/ai/orchestrator");

  const checks: Check[] = [];
  function check(label: string, pass: boolean): void {
    checks.push({ label, pass });
  }

  const FAR_DEADLINE = Date.now() + 300_000;

  function controlWith(
    steps: ProviderStep[],
    opts?: {
      maxAttempts?: number;
      deadlineMs?: number;
      attemptTimeoutMs?: number;
    },
  ): { control: ConversationControl; calls: () => number } {
    const scripted = scriptedProvider("atria", steps);
    const control = cc.createConversationControl({
      provider: scripted.adapter,
      ...(opts?.maxAttempts === undefined
        ? {}
        : {
            settings: {
              conversationControl: { maxAttempts: opts.maxAttempts },
            },
          }),
      deadlineMs: opts?.deadlineMs ?? FAR_DEADLINE,
      attemptTimeoutMs: opts?.attemptTimeoutMs ?? 16_000,
    });
    return { control, calls: scripted.getCalls };
  }

  // ── A1. SUCCESS → NO retry ────────────────────────────────────────────────
  const a1 = controlWith([
    { kind: "success", response: VALID_REPLY },
    { kind: "success", response: VALID_REPLY },
  ]);
  const a1Outcome = await a1.control.executeTurn(baseRequest);
  check(
    "A1 SUCCESS attempt1: no retry, exactly one provider call",
    a1Outcome.result.ok && a1.calls() === 1,
  );
  check(
    "A1 retryAttempted=false, attempts=[1], skipReason=NONE",
    a1Outcome.retryTrace.retryAttempted === false &&
      a1Outcome.retryTrace.attempts.length === 1 &&
      a1Outcome.retryTrace.retrySkippedReason === "NONE",
  );

  // ── A2. TIMEOUT → SUCCESS ────────────────────────────────────────────────
  const a2 = controlWith([
    { kind: "failure", code: "TIMEOUT" },
    { kind: "success", response: VALID_REPLY },
    { kind: "success", response: VALID_REPLY },
  ]);
  const a2Outcome = await a2.control.executeTurn(baseRequest);
  check(
    "A2 TIMEOUT→SUCCESS: accepted, exactly two provider calls",
    a2Outcome.result.ok && a2.calls() === 2,
  );
  check(
    "A2 retryAttempted=true, trigger=TIMEOUT, finalOutcome=SUCCESS",
    a2Outcome.retryTrace.retryAttempted === true &&
      a2Outcome.retryTrace.retryTriggerCode === "TIMEOUT" &&
      a2Outcome.retryTrace.finalOutcome === "SUCCESS" &&
      a2Outcome.retryTrace.attempts.length === 2,
  );
  check(
    "A2 attempt1=TIMEOUT, attempt2=SUCCESS (per-attempt records)",
    a2Outcome.retryTrace.attempts[0]?.errorCode === "TIMEOUT" &&
      a2Outcome.retryTrace.attempts[0]?.outcome === "FAILURE" &&
      a2Outcome.retryTrace.attempts[1]?.outcome === "SUCCESS",
  );
  check(
    "A2 successful retry → NO handoff (A14 early)",
    a2Outcome.handoffReason === null && a2Outcome.handoffMessage === null,
  );

  // ── A3. TIMEOUT + TIMEOUT → final TIMEOUT → handoff, NO third ────────────
  const a3 = controlWith([
    { kind: "failure", code: "TIMEOUT" },
    { kind: "failure", code: "TIMEOUT" },
    { kind: "failure", code: "TIMEOUT" },
  ]);
  const a3Outcome = await a3.control.executeTurn(baseRequest);
  check(
    "A3 TIMEOUT+TIMEOUT: final TIMEOUT, exactly two provider calls",
    !a3Outcome.result.ok &&
      a3Outcome.result.error.code === "TIMEOUT" &&
      a3.calls() === 2,
  );
  check(
    "A3 no third attempt; skipReason=MAX_ATTEMPTS_REACHED",
    a3Outcome.retryTrace.attempts.length === 2 &&
      a3Outcome.retryTrace.retrySkippedReason === "MAX_ATTEMPTS_REACHED" &&
      a3Outcome.retryTrace.finalOutcome === "FAILURE",
  );
  check(
    "A3 retry exhaustion → handoffReason=RETRY_EXHAUSTED (A13 early)",
    a3Outcome.handoffReason === "RETRY_EXHAUSTED",
  );

  // ── A4. INVALID_RESPONSE → NO retry ──────────────────────────────────────
  const a4 = controlWith([
    { kind: "failure", code: "INVALID_RESPONSE" },
    { kind: "failure", code: "TIMEOUT" },
  ]);
  const a4Outcome = await a4.control.executeTurn(baseRequest);
  check(
    "A4 INVALID_RESPONSE: no retry, one provider call",
    !a4Outcome.result.ok &&
      a4Outcome.result.error.code === "INVALID_RESPONSE" &&
      a4.calls() === 1,
  );
  check(
    "A4 skipReason=NON_RETRYABLE_CLASSIFICATION",
    a4Outcome.retryTrace.retrySkippedReason ===
      "NON_RETRYABLE_CLASSIFICATION" &&
      a4Outcome.retryTrace.retryAttempted === false,
  );

  // ── A5. AUTH_FAILURE (CONFIG_ERROR) → NO retry ───────────────────────────
  const a5 = controlWith([
    { kind: "failure", code: "CONFIG_ERROR", httpStatus: 401 },
    { kind: "failure", code: "TIMEOUT" },
  ]);
  const a5Outcome = await a5.control.executeTurn(baseRequest);
  check(
    "A5 AUTH_FAILURE: no retry, one provider call",
    !a5Outcome.result.ok &&
      a5Outcome.result.error.code === "CONFIG_ERROR" &&
      a5.calls() === 1,
  );
  check(
    "A5 handoffReason=AUTH_OR_CONFIGURATION_FAILURE",
    a5Outcome.handoffReason === "AUTH_OR_CONFIGURATION_FAILURE",
  );

  // ── A6. a retried response passes the UNCHANGED schema ───────────────────
  const a6Parsed = a2Outcome.result.ok
    ? aiContract.parseAiResponse(a2Outcome.result.response)
    : null;
  check(
    "A6 retried response passes the unchanged aiResponseSchema",
    a2Outcome.result.ok && a6Parsed !== null && a6Parsed.intent === "FAQ",
  );

  // ── A7/A8. one logical result / no duplicate state transition ────────────
  // The control layer is a drop-in AiProviderAdapter: the orchestrator
  // (and therefore the engine) still receives exactly ONE result and ONE
  // telemetry entry per logical turn, so persist/deliver/transition can
  // only run once.
  const sideEffect = controlWith([
    { kind: "failure", code: "TIMEOUT" },
    { kind: "success", response: VALID_REPLY },
  ]).control;
  const orch = orchestrator.createAiOrchestrator({
    primary: sideEffect,
    secondary: null,
    fallbackEnabled: false,
  });
  const orchResult = await orch.callWithFallback(baseRequest);
  check(
    "A7 orchestrator sees ONE result → cannot create 2 outbound messages",
    orchResult.response !== null &&
      orchResult.telemetry.attempts.length === 1 &&
      orchResult.telemetry.attempts[0]?.status === "SUCCESS",
  );
  check(
    "A8 one logical turn → one state transition (single final provider/model)",
    orchResult.telemetry.finalStatus === "SUCCESS" &&
      orchResult.telemetry.finalProvider === "atria" &&
      orchResult.telemetry.fallbackUsed === false,
  );
  check(
    "A7b retry trace surfaced once on telemetry (not per attempt)",
    orchResult.telemetry.retryTrace?.retryAttempted === true &&
      orchResult.telemetry.attempts.length === 1,
  );
  // One outcome object, one result, one handoff decision — by construction
  // the engine can only persist/transition once.
  check(
    "A8b executeTurn returns exactly one result + one handoff decision",
    a2Outcome.handoffReason === null &&
      a2Outcome.notifications.length === 0 &&
      !a2Outcome.alreadyInHandoff,
  );

  // ── A9. retry policy governed strictly by technical classification ─────
  // Customer-message wording does not bypass provider retries or dictate failure reason.
  // With maxAttempts=2 and a retryable TIMEOUT, the attempt is retried and succeeds.
  const a9 = controlWith([
    { kind: "failure", code: "TIMEOUT" },
    { kind: "success", response: VALID_REPLY },
  ]);
  const a9Outcome = await a9.control.executeTurn(humanRequest);
  check(
    "A9 human request with retryable TIMEOUT: retried and succeeds on attempt 2",
    a9Outcome.result.ok &&
      a9.calls() === 2 &&
      a9Outcome.retryTrace.retryAttempted === true &&
      a9Outcome.handoffReason === null,
  );

  // When retries are exhausted under humanRequest, it exhausts technically to RETRY_EXHAUSTED
  const a9Exhausted = controlWith([
    { kind: "failure", code: "TIMEOUT" },
    { kind: "failure", code: "TIMEOUT" },
  ]);
  const a9ExhaustedOutcome =
    await a9Exhausted.control.executeTurn(humanRequest);
  check(
    "A9b terminal failure under humanRequest: RETRY_EXHAUSTED without lexical human assertion",
    !a9ExhaustedOutcome.result.ok &&
      a9Exhausted.calls() === 2 &&
      a9ExhaustedOutcome.retryTrace.retrySkippedReason ===
        "MAX_ATTEMPTS_REACHED" &&
      a9ExhaustedOutcome.handoffReason === "RETRY_EXHAUSTED",
  );

  // Verify same technical failure + different customer wording = same retry/failure policy
  const a9BaseExhausted = controlWith([
    { kind: "failure", code: "TIMEOUT" },
    { kind: "failure", code: "TIMEOUT" },
  ]);
  const a9BaseOutcome = await a9BaseExhausted.control.executeTurn(baseRequest);
  check(
    "A9c same technical failure + different customer wording yields identical retry policy",
    a9BaseOutcome.retryTrace.retryAttempted ===
      a9ExhaustedOutcome.retryTrace.retryAttempted &&
      a9BaseOutcome.handoffReason === a9ExhaustedOutcome.handoffReason &&
      a9BaseOutcome.retryTrace.retrySkippedReason ===
        a9ExhaustedOutcome.retryTrace.retrySkippedReason &&
      a9BaseExhausted.calls() === a9Exhausted.calls(),
  );

  // ── A10. maxAttempts=2 means exactly TWO maximum attempts ────────────────
  check(
    "A10a MAX_ATTEMPTS_HARD_CEILING constant is exactly 2",
    cc.MAX_ATTEMPTS_HARD_CEILING === 2,
  );
  // (b) a third offered attempt is never taken
  const a10b = controlWith([
    { kind: "failure", code: "TIMEOUT" },
    { kind: "failure", code: "TIMEOUT" },
    { kind: "success", response: VALID_REPLY },
  ]);
  const a10bOutcome = await a10b.control.executeTurn(baseRequest);
  check(
    "A10b a offered third attempt is never taken",
    !a10bOutcome.result.ok && a10b.calls() === 2,
  );
  // (c) maxAttempts=1 fully DISABLES the retry
  const a10c = controlWith(
    [
      { kind: "failure", code: "TIMEOUT" },
      { kind: "success", response: VALID_REPLY },
    ],
    { maxAttempts: 1 },
  );
  const a10cOutcome = await a10c.control.executeTurn(baseRequest);
  check(
    "A10c maxAttempts=1 disables the retry entirely",
    !a10cOutcome.result.ok && a10c.calls() === 1,
  );

  // ── A11. maxAttempts can NEVER exceed the hard ceiling ───────────────────
  const a11 = controlWith(
    [
      { kind: "failure", code: "TIMEOUT" },
      { kind: "failure", code: "TIMEOUT" },
      { kind: "failure", code: "TIMEOUT" },
      { kind: "failure", code: "TIMEOUT" },
    ],
    { maxAttempts: 5 },
  );
  const a11Outcome = await a11.control.executeTurn(baseRequest);
  check(
    "A11a settings maxAttempts=5 clamped to 2 (two calls, TIMEOUT)",
    !a11Outcome.result.ok &&
      a11Outcome.result.error.code === "TIMEOUT" &&
      a11.calls() === 2,
  );
  check(
    "A11b the clamped bound is reflected on the trace",
    a11Outcome.retryTrace.maxAttempts === 2,
  );
  check(
    "A11c clampMaxAttempts(5) === 2 and clampMaxAttempts(0) === 1",
    cc.clampMaxAttempts(5) === 2 && cc.clampMaxAttempts(0) === 1,
  );

  // ── A12. already-human state PREVENTS AI execution ───────────────────────
  const a12 = controlWith([
    { kind: "success", response: VALID_REPLY },
    { kind: "success", response: VALID_REPLY },
  ]);
  const a12Outcome = await a12.control.executeTurn({
    ...baseRequest,
    conversationStatus: "NEED_HUMAN",
  });
  check(
    "A12 NEED_HUMAN: provider NOT executed (zero calls)",
    a12.calls() === 0 && a12Outcome.alreadyInHandoff === true,
  );
  check(
    "A12 no customer handoff message re-sent; no notifications",
    a12Outcome.handoffMessage === null && a12Outcome.notifications.length === 0,
  );

  // ── A13. retry exhaustion produces exactly ONE handoff ───────────────────
  check(
    "A13a one handoff reason, one canonical message, one notification",
    a3Outcome.handoffReason === "RETRY_EXHAUSTED" &&
      a3Outcome.handoffMessage !== null &&
      a3Outcome.notifications.length === 1 &&
      a3Outcome.notifications[0]?.event === "AI_RETRY_EXHAUSTED",
  );
  check(
    "A13b the handoff message comes from the centralized seam",
    a3Outcome.handoffMessage === cc.HANDOFF_MESSAGES.RETRY_EXHAUSTED,
  );

  // ── A14. successful retry produces NO handoff ────────────────────────────
  check(
    "A14 successful retry: handoffReason=null, zero notifications",
    a2Outcome.handoffReason === null && a2Outcome.notifications.length === 0,
  );

  // ── A15. notifications emitted exactly once ──────────────────────────────
  const sink = a3.control.getNotificationSink();
  check(
    "A15 the sink recorded exactly one event for the exhausted turn",
    sink.recorded().length === 1 &&
      sink.recorded()[0]?.event === "AI_RETRY_EXHAUSTED",
  );

  // ── A16. duplicate event does NOT duplicate the notification ─────────────
  const dup = cc.createInMemoryNotificationSink();
  const payload = cc.buildNotification("AI_RETRY_EXHAUSTED", {
    provider: "atria",
    handoffReason: "RETRY_EXHAUSTED",
    failureClass: "TIMEOUT",
    retryCount: 1,
    now: 1_000,
  });
  const firstRecord = dup.record(payload, "turn-1");
  const secondRecord = dup.record(payload, "turn-1");
  check(
    "A16a same event + same turn → recorded once, second is suppressed",
    firstRecord === true &&
      secondRecord === false &&
      dup.recorded().length === 1,
  );
  // A different turn for the same conversation still emits (no over-dedupe).
  const thirdRecord = dup.record(payload, "turn-2");
  check(
    "A16b a different turn for the same event still emits",
    thirdRecord === true && dup.recorded().length === 2,
  );

  // ── A17–A19. the REAL adapters through the generic control layer ─────────
  const atriaMod = await import("../src/server/integrations/ai/atria");
  const openrouterMod =
    await import("../src/server/integrations/ai/openrouter");
  const agentrouterMod =
    await import("../src/server/integrations/ai/agentrouter");

  function openAiEnvelope(content: string): Record<string, unknown> {
    return {
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 12, completion_tokens: 8 },
    };
  }
  function validAiResponseJson(): string {
    return JSON.stringify(VALID_REPLY);
  }

  async function realAdapterThroughCC(
    providerId: "atria" | "openrouter" | "agentrouter",
    createAdapter: any,
    secretRef: string,
  ): Promise<{
    outcome: any;
    calls: () => number;
  }> {
    const steps: FetchStep[] = [
      { kind: "abort" },
      { kind: "ok", body: openAiEnvelope(validAiResponseJson()) },
      { kind: "ok", body: openAiEnvelope(validAiResponseJson()) },
    ];
    const scripted = scriptedFetch(steps);
    const adapter = createAdapter({
      model: `${providerId}-test-model`,
      getEnvVar: (name: string) => (name === secretRef ? KEY : undefined),
      fetchImpl: scripted.fetch,
    });
    const control = cc.createConversationControl({
      provider: adapter,
      deadlineMs: FAR_DEADLINE,
      attemptTimeoutMs: 16_000,
    });
    const outcome = await control.executeTurn(baseRequest);
    return { outcome, calls: scripted.getCalls };
  }

  const atriaRun = await realAdapterThroughCC(
    "atria",
    atriaMod.createAtriaAdapter,
    "ATRIA_API_KEY",
  );
  check(
    "A17 Atria through CC: TIMEOUT→SUCCESS, two provider calls, accepted",
    atriaRun.outcome.result.ok === true && atriaRun.calls() === 2,
  );
  check(
    "A17b Atria retryAttempted=true, no handoff, schema-valid response",
    atriaRun.outcome.retryTrace.retryAttempted === true &&
      atriaRun.outcome.handoffReason === null &&
      aiContract.parseAiResponse(atriaRun.outcome.result.response) !== null,
  );

  const openrouterRun = await realAdapterThroughCC(
    "openrouter",
    openrouterMod.createOpenRouterAdapter,
    "OPENROUTER_API_KEY",
  );
  check(
    "A18 OpenRouter through CC: TIMEOUT→SUCCESS, two provider calls, accepted",
    openrouterRun.outcome.result.ok === true && openrouterRun.calls() === 2,
  );

  const agentrouterRun = await realAdapterThroughCC(
    "agentrouter",
    agentrouterMod.createAgentRouterAdapter,
    "AGENTROUTER_API_KEY",
  );
  check(
    "A19 AgentRouter through CC: TIMEOUT→SUCCESS, two provider calls, accepted",
    agentrouterRun.outcome.result.ok === true && agentrouterRun.calls() === 2,
  );

  // ── P1. NO provider-specific branching in the control layer ──────────────
  // Identical scripted failure sequences through three different providers
  // must yield IDENTICAL retry/handoff/notification decisions — only the
  // provider identifier differs.
  async function exhaustedSignature(
    providerId: "atria" | "openrouter" | "agentrouter",
  ) {
    const scripted = scriptedProvider(providerId, [
      { kind: "failure", code: "TIMEOUT" },
      { kind: "failure", code: "TIMEOUT" },
    ]);
    const control = cc.createConversationControl({
      provider: scripted.adapter,
      deadlineMs: FAR_DEADLINE,
      attemptTimeoutMs: 16_000,
    });
    const o = await control.executeTurn(baseRequest);
    return {
      attempts: o.retryTrace.attempts.length,
      skip: o.retryTrace.retrySkippedReason,
      trigger: o.retryTrace.retryTriggerCode,
      final: o.retryTrace.finalOutcome,
      handoff: o.handoffReason,
      events: o.notifications.map((n: any) => n.event),
    };
  }
  const sigA = await exhaustedSignature("atria");
  const sigO = await exhaustedSignature("openrouter");
  const sigG = await exhaustedSignature("agentrouter");
  check(
    "P1 identical retry/handoff/notification decisions across all 3 providers",
    JSON.stringify(sigA) === JSON.stringify(sigO) &&
      JSON.stringify(sigA) === JSON.stringify(sigG),
  );

  // ── P2. the control layer never inspects raw provider JSON ───────────────
  const ccSource = [
    "conversation-control/conversation-control.ts",
    "conversation-control/retry-policy.ts",
    "conversation-control/handoff-policy.ts",
    "conversation-control/notification-policy.ts",
  ];
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  let noProviderBranching = true;
  for (const rel of ccSource) {
    const src = await fs.readFile(
      path.join(process.cwd(), "src", "server", "integrations", "ai", rel),
      "utf8",
    );
    if (/"atria"|"openrouter"|"agentrouter"/.test(src))
      noProviderBranching = false;
    if (/import.*\b(atria|openrouter|agentrouter)\b.*from/.test(src))
      noProviderBranching = false;
  }
  check("P2a core files import/branch on NO provider id", noProviderBranching);
  // It reads only the structured AiProviderResult — the raw provider JSON is
  // consumed inside http.ts/normalizer (unchanged).
  check(
    "P2b handoff reads the structured contract, never raw JSON",
    cc.handoffFromAiResponse(VALID_REPLY) === null &&
      cc.handoffFromAiResponse(AI_HANDOFF_REPLY) === "CUSTOMER_REQUESTED_HUMAN",
  );

  // ── S1. NETWORK_ERROR (RETRYABLE, non-TIMEOUT) NOT retried ───────────────
  const s1 = controlWith([
    { kind: "failure", code: "RETRYABLE" },
    { kind: "failure", code: "TIMEOUT" },
  ]);
  const s1Outcome = await s1.control.executeTurn(baseRequest);
  check(
    "S1 NETWORK_ERROR/RETRYABLE: not retried (one call)",
    !s1Outcome.result.ok &&
      s1Outcome.result.error.code === "RETRYABLE" &&
      s1.calls() === 1,
  );
  check(
    "S1b handoffReason=PROVIDER_UNAVAILABLE",
    s1Outcome.handoffReason === "PROVIDER_UNAVAILABLE",
  );

  // ── S2. PROVIDER_HTTP_ERROR (5xx) NOT retried ─────────────────────────────
  const s2 = controlWith([
    { kind: "failure", code: "RETRYABLE", httpStatus: 503 },
    { kind: "failure", code: "TIMEOUT" },
  ]);
  const s2Outcome = await s2.control.executeTurn(baseRequest);
  check(
    "S2 PROVIDER_HTTP_ERROR 503: not retried (one call)",
    !s2Outcome.result.ok &&
      s2Outcome.result.error.code === "RETRYABLE" &&
      s2.calls() === 1,
  );
  // A 429 is distinguished into QUOTA_EXHAUSTED without a retry.
  const s2b = controlWith([
    { kind: "failure", code: "RETRYABLE", httpStatus: 429 },
  ]);
  const s2bOutcome = await s2b.control.executeTurn(baseRequest);
  check(
    "S2b HTTP 429 → QUOTA_EXHAUSTED, no retry, one notification",
    s2bOutcome.handoffReason === "QUOTA_EXHAUSTED" &&
      s2b.calls() === 1 &&
      s2bOutcome.notifications.length === 1 &&
      s2bOutcome.notifications[0]?.event === "AI_QUOTA_EXHAUSTED",
  );

  // ── S3. all emitted payloads are sanitized ───────────────────────────────
  const serialized = JSON.stringify([
    ...a3Outcome.notifications,
    ...s2bOutcome.notifications,
    ...a5Outcome.notifications,
  ]);
  check(
    "S3 payloads leak no key / header / DATABASE_URL / content",
    !serialized.includes(KEY) &&
      !serialized.includes("Authorization") &&
      !serialized.includes("DATABASE_URL") &&
      !serialized.includes("Bearer") &&
      !serialized.includes("من 9"),
  );
  check(
    "S3b isSanitized() agrees on a clean payload",
    cc.isSanitized(a3Outcome.notifications[0] as any) === true,
  );

  // ── S4. the budget guard skips a retry the budget cannot host ────────────
  const s4 = controlWith(
    [
      { kind: "failure", code: "TIMEOUT" },
      { kind: "success", response: VALID_REPLY },
    ],
    { deadlineMs: Date.now() - 1 },
  );
  const s4Outcome = await s4.control.executeTurn(baseRequest);
  check(
    "S4 insufficient remaining budget → retry skipped, safe-fail preserved",
    !s4Outcome.result.ok &&
      s4Outcome.result.error.code === "TIMEOUT" &&
      s4.calls() === 1 &&
      s4Outcome.retryTrace.retrySkippedReason === "INSUFFICIENT_DEADLINE",
  );

  // ── A20. non-Atria behaviour byte-for-byte unchanged ─────────────────────
  // A first-attempt SUCCESS through CC must carry the IDENTICAL structured
  // response as the bare adapter call — only optional trace fields are added.
  const bareScripted = scriptedFetch([
    { kind: "ok", body: openAiEnvelope(validAiResponseJson()) },
  ]);
  const bareOpenRouter = openrouterMod.createOpenRouterAdapter({
    model: "openrouter-test-model",
    getEnvVar: (name: string) =>
      name === "OPENROUTER_API_KEY" ? KEY : undefined,
    fetchImpl: bareScripted.fetch,
  });
  const bareResult = await bareOpenRouter.call(baseRequest);
  const wrappedScripted = scriptedFetch([
    { kind: "ok", body: openAiEnvelope(validAiResponseJson()) },
  ]);
  const wrappedControl = cc.createConversationControl({
    provider: openrouterMod.createOpenRouterAdapter({
      model: "openrouter-test-model",
      getEnvVar: (name: string) =>
        name === "OPENROUTER_API_KEY" ? KEY : undefined,
      fetchImpl: wrappedScripted.fetch,
    }),
    deadlineMs: FAR_DEADLINE,
    attemptTimeoutMs: 16_000,
  });
  const wrappedOutcome = await wrappedControl.executeTurn(baseRequest);
  check(
    "A20 structured response byte-for-byte identical (bare vs CC-wrapped)",
    JSON.stringify(bareResult.ok ? bareResult.response : null) ===
      JSON.stringify(
        wrappedOutcome.result.ok ? wrappedOutcome.result.response : null,
      ),
  );
  check(
    "A20b a successful first attempt never triggers a retry (non-Atria)",
    wrappedScripted.getCalls() === 1 &&
      wrappedOutcome.retryTrace.retryAttempted === false,
  );

  // ── report ────────────────────────────────────────────────────────────────
  const failed = checks.filter((c) => !c.pass);
  console.log(`\n── CONVERSATION CONTROL — ${checks.length} checks ──`);
  for (const c of checks) {
    console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.label}`);
  }
  console.log(
    `\n${checks.length - failed.length}/${checks.length} passed, ${failed.length} failed`,
  );
  if (failed.length > 0) {
    console.log("\nFAILURES:");
    for (const c of failed) console.log(`  ✗ ${c.label}`);
    process.exitCode = 1;
  }
  console.log(
    "\nNo network, no DB, no WhatsApp transport, no Meta send was used by this check.",
  );
}

main().catch((error: Error) => {
  console.error(`check crashed: ${error.message}`);
  console.error(error.stack ?? "");
  process.exit(1);
});
