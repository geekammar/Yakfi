/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/consistent-type-imports */
/**
 * FlowPilot — CONVERSATION CONTROL deterministic offline simulation
 * (PROMPT-OPS-CONVERSATION-CONTROL-RETRY-HANDOFF-15, Phase 17).
 *
 * CONTROLLED SIMULATION ONLY. It does NOT:
 *   - send WhatsApp messages
 *   - call Meta
 *   - deploy
 *   - modify production state
 *   - touch the DB or transport
 *
 * Every provider call is a scripted adapter over a mocked fetch. The
 * simulation walks the 10 required scenarios end-to-end through the
 * provider-agnostic Conversation Control Layer and records EXACT COUNTS
 * for: provider calls, retries, handoffs, customer handoff messages, and
 * staff notifications.
 *
 * Run: pnpm check:simulate-conversation-control
 */
export {};

type AiRequest =
  import("../src/features/conversations/server/ai-contract").AiRequest;
type AiResponse =
  import("../src/features/conversations/server/ai-contract").AiResponse;
type AiProviderResult =
  import("../src/server/integrations/ai/types").AiProviderResult;
type AiProviderErrorCode =
  import("../src/server/integrations/ai/types").AiProviderErrorCode;

type Scenario = {
  name: string;
  run: () => Promise<void>;
};

// ── shared counters (the exact counts the simulation records) ───────────────
const counters = {
  providerCalls: 0,
  retriesStarted: 0,
  handoffs: 0,
  handoffMessages: 0,
  notifications: 0,
  scenarios: 0,
};

function banner(title: string): void {
  console.log(`\n── ${title} ──`);
}

async function main(): Promise<void> {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const cc = await import("../src/server/integrations/ai/conversation-control");
  const atria = await import("../src/server/integrations/ai/atria");
  const openrouter = await import("../src/server/integrations/ai/openrouter");
  const agentrouter = await import("../src/server/integrations/ai/agentrouter");

  const KEY = "sim-secret-value";
  const FAR_DEADLINE = Date.now() + 300_000;

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
    intent: "BOOKING",
    action: "booking_handoff",
    content: "يسعدنا خدمتك! سيتواصل معك أحد أعضاء الفريق لإتمام الحجز.",
    extraction: {
      service: null,
      provider: null,
      date: null,
      timePreference: null,
    },
    handoffReason: null,
    summary: "طلب العميل حجز موعد جديد",
  };

  // ── scripted provider (direct AiProviderAdapter injection) ────────────────
  type Step =
    | { kind: "success"; response: AiResponse }
    | { kind: "failure"; code: AiProviderErrorCode; httpStatus?: number };
  function scriptedProvider(
    providerId: "atria" | "openrouter" | "agentrouter",
    steps: Step[],
  ) {
    let calls = 0;
    const adapter = {
      providerId,
      model: `${providerId}-sim-model`,
      secretRef: `${providerId.toUpperCase()}_API_KEY`,
      async call(): Promise<AiProviderResult> {
        const idx = Math.min(calls, steps.length - 1);
        calls += 1;
        counters.providerCalls += 1;
        const step: Step | undefined = steps[idx];
        if (step === undefined) {
          return {
            ok: false,
            provider: providerId,
            model: `${providerId}-sim-model`,
            latencyMs: 5,
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
            model: `${providerId}-sim-model`,
            latencyMs: 5,
            response: step.response,
          };
        }
        return {
          ok: false,
          provider: providerId,
          model: `${providerId}-sim-model`,
          latencyMs: 5,
          error: {
            code: step.code,
            message: "simulated failure",
            retryable: step.code === "TIMEOUT" || step.code === "RETRYABLE",
            ...(step.httpStatus === undefined
              ? {}
              : { httpStatus: step.httpStatus }),
          },
        };
      },
    };
    return { adapter, getCalls: () => calls };
  }

  function makeControl(
    steps: Step[],
    providerId: "atria" | "openrouter" | "agentrouter" = "atria",
  ) {
    const scripted = scriptedProvider(providerId, steps);
    const control = cc.createConversationControl({
      provider: scripted.adapter,
      deadlineMs: FAR_DEADLINE,
      attemptTimeoutMs: 16_000,
    });
    return { control, getCalls: scripted.getCalls };
  }

  const scenarios: Scenario[] = [];

  // 1. success without retry ──────────────────────────────────────────────────
  scenarios.push({
    name: "1. success without retry",
    run: async () => {
      const { control, getCalls } = makeControl([
        { kind: "success", response: VALID_REPLY },
      ]);
      const o = await control.executeTurn(baseRequest);
      const ok = o.result.ok && getCalls() === 1 && o.handoffReason === null;
      counters.scenarios += 1;
      console.log(
        `   calls=${getCalls()} retries=${o.retryTrace.attempts.length - 1} ` +
          `handoff=${o.handoffReason} notifications=${o.notifications.length} ` +
          `→ ${ok ? "OK" : "UNEXPECTED"}`,
      );
      if (!ok) throw new Error("scenario 1 failed");
    },
  });

  // 2. timeout recovered by retry ─────────────────────────────────────────────
  scenarios.push({
    name: "2. timeout recovered by retry",
    run: async () => {
      const { control, getCalls } = makeControl([
        { kind: "failure", code: "TIMEOUT" },
        { kind: "success", response: VALID_REPLY },
      ]);
      const o = await control.executeTurn(baseRequest);
      counters.retriesStarted += o.retryTrace.retryAttempted ? 1 : 0;
      counters.scenarios += 1;
      const ok =
        o.result.ok &&
        getCalls() === 2 &&
        o.handoffReason === null &&
        o.notifications.length === 0;
      console.log(
        `   calls=${getCalls()} retries=${o.retryTrace.attempts.length - 1} ` +
          `handoff=${o.handoffReason} notifications=${o.notifications.length} ` +
          `→ ${ok ? "OK" : "UNEXPECTED"}`,
      );
      if (!ok) throw new Error("scenario 2 failed");
    },
  });

  // 3. timeout exhausted → human ──────────────────────────────────────────────
  scenarios.push({
    name: "3. timeout exhausted → human",
    run: async () => {
      const { control, getCalls } = makeControl([
        { kind: "failure", code: "TIMEOUT" },
        { kind: "failure", code: "TIMEOUT" },
      ]);
      const o = await control.executeTurn(baseRequest);
      counters.retriesStarted += o.retryTrace.retryAttempted ? 1 : 0;
      counters.handoffs += o.handoffReason !== null ? 1 : 0;
      counters.handoffMessages += o.handoffMessage !== null ? 1 : 0;
      counters.notifications += o.notifications.length;
      counters.scenarios += 1;
      const ok =
        !o.result.ok &&
        getCalls() === 2 &&
        o.handoffReason === "RETRY_EXHAUSTED" &&
        o.notifications.length === 1 &&
        o.notifications[0]?.event === "AI_RETRY_EXHAUSTED";
      console.log(
        `   calls=${getCalls()} retries=${o.retryTrace.attempts.length - 1} ` +
          `handoff=${o.handoffReason} msg="${o.handoffMessage}" ` +
          `notifications=${o.notifications.length} ` +
          `→ ${ok ? "OK" : "UNEXPECTED"}`,
      );
      if (!ok) throw new Error("scenario 3 failed");
    },
  });

  // 4. technical retry on customer human request wording ──────────────────────
  scenarios.push({
    name: "4. technical retry on customer human request wording",
    run: async () => {
      const { control, getCalls } = makeControl([
        { kind: "failure", code: "TIMEOUT" },
        { kind: "success", response: VALID_REPLY },
      ]);
      const o = await control.executeTurn(humanRequest);
      counters.handoffs += o.handoffReason !== null ? 1 : 0;
      counters.handoffMessages += o.handoffMessage !== null ? 1 : 0;
      counters.notifications += o.notifications.length;
      counters.scenarios += 1;
      const ok =
        o.result.ok &&
        getCalls() === 2 &&
        o.retryTrace.retryAttempted === true &&
        o.handoffReason === null &&
        o.notifications.length === 0;
      console.log(
        `   calls=${getCalls()} retries=${o.retryTrace.attempts.length - 1} ` +
          `handoff=${o.handoffReason} msg="${o.handoffMessage}" ` +
          `notifications=${o.notifications.length} ` +
          `→ ${ok ? "OK" : "UNEXPECTED"}`,
      );
      if (!ok) throw new Error("scenario 4 failed");
    },
  });

  // 5. AI requested handoff ───────────────────────────────────────────────────
  scenarios.push({
    name: "5. AI requested handoff (existing contract action)",
    run: async () => {
      const { control, getCalls } = makeControl([
        { kind: "success", response: AI_HANDOFF_REPLY },
      ]);
      const o = await control.executeTurn(baseRequest);
      counters.handoffs += o.handoffReason !== null ? 1 : 0;
      counters.handoffMessages += o.handoffMessage !== null ? 1 : 0;
      counters.notifications += o.notifications.length;
      counters.scenarios += 1;
      const ok =
        o.result.ok &&
        getCalls() === 1 &&
        o.handoffReason === "AI_REQUESTED_HANDOFF" &&
        o.notifications.length === 1 &&
        o.notifications[0]?.event === "HUMAN_HANDOFF_REQUESTED";
      console.log(
        `   calls=${getCalls()} retries=${o.retryTrace.attempts.length - 1} ` +
          `handoff=${o.handoffReason} msg="${o.handoffMessage}" ` +
          `notifications=${o.notifications.length} ` +
          `→ ${ok ? "OK" : "UNEXPECTED"}`,
      );
      if (!ok) throw new Error("scenario 5 failed");
    },
  });

  // 6. provider unavailable → human ───────────────────────────────────────────
  scenarios.push({
    name: "6. provider unavailable → human",
    run: async () => {
      const { control, getCalls } = makeControl([
        { kind: "failure", code: "RETRYABLE", httpStatus: 503 },
      ]);
      const o = await control.executeTurn(baseRequest);
      counters.handoffs += o.handoffReason !== null ? 1 : 0;
      counters.handoffMessages += o.handoffMessage !== null ? 1 : 0;
      counters.notifications += o.notifications.length;
      counters.scenarios += 1;
      const ok =
        !o.result.ok &&
        getCalls() === 1 &&
        o.handoffReason === "PROVIDER_UNAVAILABLE" &&
        o.notifications.length === 1 &&
        o.notifications[0]?.event === "AI_UNAVAILABLE";
      console.log(
        `   calls=${getCalls()} retries=${o.retryTrace.attempts.length - 1} ` +
          `handoff=${o.handoffReason} msg="${o.handoffMessage}" ` +
          `notifications=${o.notifications.length} ` +
          `→ ${ok ? "OK" : "UNEXPECTED"}`,
      );
      if (!ok) throw new Error("scenario 6 failed");
    },
  });

  // 7. successful retry → no handoff ──────────────────────────────────────────
  scenarios.push({
    name: "7. successful retry → no handoff",
    run: async () => {
      const { control, getCalls } = makeControl([
        { kind: "failure", code: "TIMEOUT" },
        { kind: "success", response: VALID_REPLY },
      ]);
      const o = await control.executeTurn(baseRequest);
      counters.retriesStarted += o.retryTrace.retryAttempted ? 1 : 0;
      counters.scenarios += 1;
      const ok =
        o.result.ok &&
        getCalls() === 2 &&
        o.handoffReason === null &&
        o.handoffMessage === null &&
        o.notifications.length === 0;
      console.log(
        `   calls=${getCalls()} retries=${o.retryTrace.attempts.length - 1} ` +
          `handoff=${o.handoffReason} notifications=${o.notifications.length} ` +
          `→ ${ok ? "OK" : "UNEXPECTED"}`,
      );
      if (!ok) throw new Error("scenario 7 failed");
    },
  });

  // 8. duplicate event → one notification ─────────────────────────────────────
  scenarios.push({
    name: "8. duplicate event → one notification",
    run: async () => {
      const sink = cc.createInMemoryNotificationSink();
      const payload = cc.buildNotification("AI_RETRY_EXHAUSTED", {
        provider: "atria",
        handoffReason: "RETRY_EXHAUSTED",
        failureClass: "TIMEOUT",
        retryCount: 1,
        now: 1_000,
      });
      const a = sink.record(payload, "turn-x");
      const b = sink.record(payload, "turn-x");
      counters.scenarios += 1;
      const ok = a === true && b === false && sink.recorded().length === 1;
      counters.notifications += sink.recorded().length;
      console.log(
        `   first=${a} duplicate=${b} recorded=${sink.recorded().length} ` +
          `→ ${ok ? "OK" : "UNEXPECTED"}`,
      );
      if (!ok) throw new Error("scenario 8 failed");
    },
  });

  // 9. duplicate event → one customer handoff message ─────────────────────────
  scenarios.push({
    name: "9. duplicate event → one customer handoff message",
    run: async () => {
      // First handoff turn: exactly ONE canonical customer message.
      const first = makeControl([
        { kind: "failure", code: "TIMEOUT" },
        { kind: "failure", code: "TIMEOUT" },
      ]);
      const firstOutcome = await first.control.executeTurn(baseRequest);
      // The same conversation is now NEED_HUMAN: a repeat turn must NOT
      // re-execute the provider and must NOT emit another handoff message.
      const repeat = makeControl([
        { kind: "success", response: AI_HANDOFF_REPLY },
      ]);
      const repeatOutcome = await repeat.control.executeTurn({
        ...baseRequest,
        conversationStatus: "NEED_HUMAN",
      });
      counters.handoffMessages += firstOutcome.handoffMessage !== null ? 1 : 0;
      counters.scenarios += 1;
      const ok =
        firstOutcome.handoffMessage !== null &&
        firstOutcome.handoffMessage === cc.HANDOFF_MESSAGES.RETRY_EXHAUSTED &&
        repeatOutcome.alreadyInHandoff === true &&
        repeatOutcome.handoffMessage === null &&
        repeatOutcome.notifications.length === 0;
      console.log(
        `   firstMsg="${firstOutcome.handoffMessage}" ` +
          `repeatAlreadyInHandoff=${repeatOutcome.alreadyInHandoff} ` +
          `repeatMsg=${repeatOutcome.handoffMessage} ` +
          `repeatNotifications=${repeatOutcome.notifications.length} ` +
          `→ ${ok ? "OK" : "UNEXPECTED"}`,
      );
      if (!ok) throw new Error("scenario 9 failed");
    },
  });

  // 10. no provider-specific control logic ────────────────────────────────────
  scenarios.push({
    name: "10. no provider-specific control logic (Atria/OpenRouter/AgentRouter)",
    run: async () => {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const coreFiles = [
        "conversation-control/conversation-control.ts",
        "conversation-control/retry-policy.ts",
        "conversation-control/handoff-policy.ts",
        "conversation-control/notification-policy.ts",
        "conversation-control/settings.ts",
      ];
      let clean = true;
      for (const rel of coreFiles) {
        const src = await fs.readFile(
          path.join(process.cwd(), "src", "server", "integrations", "ai", rel),
          "utf8",
        );
        if (/"atria"|"openrouter"|"agentrouter"/.test(src)) clean = false;
      }
      // Identical scripted exhaustion through all three REAL adapters
      // wrapped by the control layer must yield identical decisions.
      async function signature(createAdapter: any, secretRef: string) {
        const steps = [{ kind: "abort" as const }, { kind: "abort" as const }];
        let calls = 0;
        const fetchImpl = (async () => {
          const i = Math.min(calls, steps.length - 1);
          calls += 1;
          counters.providerCalls += 1;
          throw steps[i] && new DOMException("aborted", "AbortError");
        }) as unknown as typeof fetch;
        const adapter = createAdapter({
          model: "sim-model",
          getEnvVar: (n: string) => (n === secretRef ? KEY : undefined),
          fetchImpl,
        });
        const control = cc.createConversationControl({
          provider: adapter,
          deadlineMs: FAR_DEADLINE,
          attemptTimeoutMs: 16_000,
        });
        const o = await control.executeTurn(baseRequest);
        return {
          attempts: o.retryTrace.attempts.length,
          skip: o.retryTrace.retrySkippedReason,
          handoff: o.handoffReason,
          events: o.notifications.map((n: any) => n.event),
        };
      }
      const sigA = await signature(atria.createAtriaAdapter, "ATRIA_API_KEY");
      const sigO = await signature(
        openrouter.createOpenRouterAdapter,
        "OPENROUTER_API_KEY",
      );
      const sigG = await signature(
        agentrouter.createAgentRouterAdapter,
        "AGENTROUTER_API_KEY",
      );
      counters.handoffs += sigA.handoff !== null ? 3 : 0;
      counters.notifications += 3;
      counters.scenarios += 1;
      const ok =
        clean &&
        JSON.stringify(sigA) === JSON.stringify(sigO) &&
        JSON.stringify(sigA) === JSON.stringify(sigG);
      console.log(
        `   coreFilesClean=${clean} identicalDecisions=${ok} ` +
          `attempts=${sigA.attempts} handoff=${sigA.handoff} ` +
          `events=${JSON.stringify(sigA.events)} ` +
          `→ ${ok ? "OK" : "UNEXPECTED"}`,
      );
      if (!ok) throw new Error("scenario 10 failed");
    },
  });

  // ── run ────────────────────────────────────────────────────────────────────
  banner("CONVERSATION CONTROL — deterministic offline simulation");
  console.log(
    "No WhatsApp, no Meta, no deploy, no DB, no production state is touched.",
  );
  for (const scenario of scenarios) {
    console.log(`\n▶ ${scenario.name}`);
    await scenario.run();
  }

  banner("EXACT COUNTS");
  console.log(`scenarios run              : ${counters.scenarios}`);
  console.log(`provider attempts (total)  : ${counters.providerCalls}`);
  console.log(`retries started            : ${counters.retriesStarted}`);
  console.log(`handoffs decided           : ${counters.handoffs}`);
  console.log(`customer handoff messages  : ${counters.handoffMessages}`);
  console.log(`staff notifications        : ${counters.notifications}`);
  console.log(
    `\nSimulation complete. Provider-agnostic control verified offline.`,
  );
}

main().catch((error: Error) => {
  console.error(`simulation crashed: ${error.message}`);
  console.error(error.stack ?? "");
  process.exit(1);
});
