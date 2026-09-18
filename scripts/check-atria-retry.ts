/* eslint-disable @typescript-eslint/consistent-type-imports */
/**
 * FlowPilot — ATRIA ADAPTER ISOLATION + CONVERSATION CONTROL check
 * (PROMPT-OPS-CONVERSATION-CONTROL-RETRY-HANDOFF-15).
 *
 * Supersedes the adapter-level retry matrix of
 * PROMPT-OPS-ATRIA-TIMEOUT-BOUNDED-RETRY-14. The retry loop moved OUT of
 * `atria.ts` into the provider-agnostic Conversation Control Layer, so
 * this check now proves the NEW contract instead:
 *
 *   R1  ONE adapter invocation = ONE provider attempt. The Atria adapter
 *       owns NO retry loop: a TIMEOUT is returned immediately.
 *   R2  Atria's provider-specific execution is intact: endpoint, model,
 *       timeout (16000ms), JSON instructions, bounded normalization
 *       policy, secret-by-name auth, error classification.
 *   R3  Atria's normalization wiring is unchanged (strict-first → generic
 *       → bounded Atria policy → unchanged schema gate).
 *   R4  Retry/handoff/notification now work THROUGH the generic control
 *       layer wrapping the Atria adapter (no provider-specific logic).
 *   R5  Isolation: selecting Atria changes nothing about OpenRouter /
 *       AgentRouter / the prompt / the engine — the adapters remain
 *       independent thin wrappers over the shared HTTP helper.
 *
 * Deterministic and OFFLINE: every provider call is a mocked fetch. No
 * network, no DB, no conversation state, no WhatsApp transport, no Meta
 * send, no real credentials.
 *
 * Run: pnpm check:atria-retry
 */
export {};

type Check = { label: string; pass: boolean };

type AiRequest =
  import("../src/features/conversations/server/ai-contract").AiRequest;
type AtriaModule = typeof import("../src/server/integrations/ai/atria");
type OrchestratorModule =
  typeof import("../src/server/integrations/ai/orchestrator");
type AiContractModule =
  typeof import("../src/features/conversations/server/ai-contract");

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

function openAiEnvelope(content: string): Record<string, unknown> {
  return {
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 12, completion_tokens: 8 },
  };
}

type FetchStep =
  | { kind: "ok"; body: unknown }
  | { kind: "status"; status: number; body: unknown }
  | { kind: "abort" }
  | { kind: "throw"; error: Error };

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
    if (step.kind === "throw") throw step.error;
    const status = step.kind === "ok" ? 200 : step.status;
    return new Response(JSON.stringify(step.body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetch: f, getCalls: () => calls };
}

async function main(): Promise<void> {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const atria: AtriaModule =
    await import("../src/server/integrations/ai/atria");
  const orchestrator: OrchestratorModule =
    await import("../src/server/integrations/ai/orchestrator");
  const aiContract: AiContractModule =
    await import("../src/features/conversations/server/ai-contract");
  const cc = await import("../src/server/integrations/ai/conversation-control");

  const checks: Check[] = [];
  function check(label: string, pass: boolean): void {
    checks.push({ label, pass });
  }

  const KEY = "test-atria-key-value";
  const getEnvVar = (name: string) =>
    name === "ATRIA_API_KEY" ? KEY : undefined;

  const baseRequest: AiRequest = {
    message: "ما هي ساعات العمل؟",
    conversationStatus: "AI_ACTIVE",
    recentMessages: [],
    businessName: "منشأة تجريبية",
    services: [],
    faqs: [{ question: "ما هي ساعات العمل؟", answer: "من 9 حتى 6" }],
  };
  const FAR_DEADLINE = Date.now() + 300_000;

  function adapterWith(steps: FetchStep[]) {
    const scripted = scriptedFetch(steps);
    const adapter = atria.createAtriaAdapter({
      model: "Atria-Dawn-Preview",
      getEnvVar,
      fetchImpl: scripted.fetch,
    });
    return { adapter, calls: scripted.getCalls };
  }
  function controlWith(steps: FetchStep[]) {
    const scripted = scriptedFetch(steps);
    const control = cc.createConversationControl({
      provider: atria.createAtriaAdapter({
        model: "Atria-Dawn-Preview",
        getEnvVar,
        fetchImpl: scripted.fetch,
      }),
      deadlineMs: FAR_DEADLINE,
      attemptTimeoutMs: atria.ATRIA_TIMEOUT_MS,
    });
    return { control, calls: scripted.getCalls };
  }

  // ── R1. ONE invocation = ONE attempt (no adapter-owned retry) ─────────────
  const r1 = adapterWith([
    { kind: "abort" },
    { kind: "ok", body: openAiEnvelope(validAiResponseJson()) },
  ]);
  const r1Result = await r1.adapter.call(baseRequest);
  check(
    "R1a a TIMEOUT is returned immediately (no internal retry), ONE call",
    r1Result.ok === false &&
      r1Result.error.code === "TIMEOUT" &&
      r1.calls() === 1,
  );
  check(
    "R1b the adapter result carries NO retry trace (policy moved out)",
    r1Result.retryTrace === undefined &&
      r1Result.conversationControl === undefined,
  );
  const r1b = adapterWith([
    { kind: "ok", body: openAiEnvelope(validAiResponseJson()) },
    { kind: "abort" },
  ]);
  const r1bResult = await r1b.adapter.call(baseRequest);
  check(
    "R1c a SUCCESS is returned immediately, ONE call",
    r1bResult.ok === true && r1b.calls() === 1,
  );
  const r1d = adapterWith([
    { kind: "ok", body: openAiEnvelope("prose, not JSON") },
    { kind: "abort" },
  ]);
  const r1dResult = await r1d.adapter.call(baseRequest);
  check(
    "R1d INVALID_RESPONSE is returned with no retry",
    !r1dResult.ok && r1dResult.error.code === "INVALID_RESPONSE",
  );

  // ── R2. provider-specific execution intact ────────────────────────────────
  check(
    "R2a endpoint / secret-ref / timeout constants unchanged",
    atria.ATRIA_ENDPOINT === "https://api.atria-asi.ai/v1/chat/completions" &&
      atria.ATRIA_SECRET_REF === "ATRIA_API_KEY" &&
      atria.ATRIA_TIMEOUT_MS === 16000,
  );
  check(
    "R2b JSON output instructions are present and Arabic-safe",
    atria.ATRIA_JSON_INSTRUCTIONS.includes("Return exactly ONE JSON object.") &&
      atria.ATRIA_JSON_INSTRUCTIONS.includes("JSON.parse"),
  );
  const auth = await adapterWith([
    {
      kind: "status",
      status: 401,
      body: { error: { message: "invalid api key" } },
    },
  ]).adapter.call(baseRequest);
  check(
    "R2c auth failure classified CONFIG_ERROR (secret-by-name auth path)",
    auth.ok === false &&
      auth.error.code === "CONFIG_ERROR" &&
      auth.error.httpStatus === 401,
  );
  // Secret never leaves the env-name boundary.
  const echoed = JSON.stringify(r1Result) + JSON.stringify(auth);
  check(
    "R2d no key / Authorization / Bearer leaks from the adapter",
    !echoed.includes(KEY) &&
      !echoed.includes("Authorization") &&
      !echoed.includes("Bearer"),
  );

  // ── R3. normalization wiring unchanged (strict-first) ─────────────────────
  const r3 = adapterWith([
    { kind: "ok", body: openAiEnvelope(validAiResponseJson()) },
  ]);
  const r3Result = await r3.adapter.call(baseRequest);
  check(
    "R3a strict JSON first: valid payload accepted as DIRECT_PARSE",
    r3Result.ok === true && r3Result.parseMode === "DIRECT_PARSE",
  );
  check(
    "R3b the accepted response passes the unchanged aiResponseSchema",
    r3Result.ok === true &&
      aiContract.parseAiResponse(r3Result.response) !== null,
  );
  // A surplus leading brace is repaired by the bounded Atria policy and
  // STILL passes strict re-parse + the unchanged schema.
  const r3b = adapterWith([
    {
      kind: "ok",
      body: openAiEnvelope(`{${validAiResponseJson()}`),
    },
  ]);
  const r3bResult = await r3b.adapter.call(baseRequest);
  check(
    "R3c bounded Atria normalization repairs a surplus brace (schema still holds)",
    r3bResult.ok === true &&
      (r3bResult.parseMode === "BOUNDED_PROVIDER_REPAIR" ||
        r3bResult.parseMode === "GENERIC_REPAIRED_PARSE") &&
      aiContract.parseAiResponse(r3bResult.response) !== null,
  );

  // ── R4. retry/handoff/notification now THROUGH the generic layer ──────────
  const r4 = controlWith([
    { kind: "abort" },
    { kind: "ok", body: openAiEnvelope(validAiResponseJson()) },
  ]);
  const r4Outcome = await r4.control.executeTurn(baseRequest);
  check(
    "R4a Atria TIMEOUT→SUCCESS through the control layer: TWO calls, accepted",
    r4Outcome.result.ok === true && r4.calls() === 2,
  );
  check(
    "R4b the trace is owned by the control layer, not the adapter",
    r4Outcome.retryTrace.provider === "atria" &&
      r4Outcome.retryTrace.retryAttempted === true &&
      r4Outcome.result.retryTrace?.retryAttempted === true,
  );
  const r4b = controlWith([
    { kind: "abort" },
    { kind: "abort" },
    { kind: "abort" },
  ]);
  const r4bOutcome = await r4b.control.executeTurn(baseRequest);
  check(
    "R4c exhaustion → ONE handoff + ONE notification, no third attempt",
    !r4bOutcome.result.ok &&
      r4b.calls() === 2 &&
      r4bOutcome.handoffReason === "RETRY_EXHAUSTED" &&
      r4bOutcome.notifications.length === 1 &&
      r4bOutcome.notifications[0]?.event === "AI_RETRY_EXHAUSTED",
  );
  // The orchestrator still sees exactly ONE result per logical turn.
  const orch = orchestrator.createAiOrchestrator({
    primary: controlWith([
      { kind: "abort" },
      { kind: "ok", body: openAiEnvelope(validAiResponseJson()) },
    ]).control,
    secondary: null,
    fallbackEnabled: false,
  });
  const orchResult = await orch.callWithFallback(baseRequest);
  check(
    "R4d orchestrator sees ONE result → engine outcome stays singular",
    orchResult.response !== null &&
      orchResult.telemetry.attempts.length === 1 &&
      orchResult.telemetry.retryTrace?.retryAttempted === true,
  );

  // ── R5. isolation: the other adapters are untouched by Atria ──────────────
  const openrouterMod =
    await import("../src/server/integrations/ai/openrouter");
  const agentrouterMod =
    await import("../src/server/integrations/ai/agentrouter");
  const orFetch = scriptedFetch([
    { kind: "ok", body: openAiEnvelope(validAiResponseJson()) },
  ]);
  const orResult = await openrouterMod
    .createOpenRouterAdapter({
      model: "or-model",
      getEnvVar: (n: string) => (n === "OPENROUTER_API_KEY" ? KEY : undefined),
      fetchImpl: orFetch.fetch,
    })
    .call(baseRequest);
  const arFetch = scriptedFetch([
    { kind: "ok", body: openAiEnvelope(validAiResponseJson()) },
  ]);
  const arResult = await agentrouterMod
    .createAgentRouterAdapter({
      model: "ar-model",
      getEnvVar: (n: string) => (n === "AGENTROUTER_API_KEY" ? KEY : undefined),
      fetchImpl: arFetch.fetch,
    })
    .call(baseRequest);
  check(
    "R5a OpenRouter / AgentRouter stay single-attempt, schema-valid, isolated",
    orResult.ok === true &&
      orResult.provider === "openrouter" &&
      arResult.ok === true &&
      arResult.provider === "agentrouter" &&
      orFetch.getCalls() === 1 &&
      arFetch.getCalls() === 1,
  );
  check(
    "R5b the non-Atria adapters carry NO Atria policy (byte-for-byte strict path)",
    orResult.ok === true &&
      orResult.parseMode === "DIRECT_PARSE" &&
      arResult.ok === true &&
      arResult.parseMode === "DIRECT_PARSE",
  );

  // ── report ────────────────────────────────────────────────────────────────
  const failed = checks.filter((c) => !c.pass);
  console.log(
    `\n── ATRIA ISOLATION + CONVERSATION CONTROL — ${checks.length} checks ──`,
  );
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
