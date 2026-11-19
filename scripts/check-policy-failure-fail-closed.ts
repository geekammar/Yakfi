/* eslint-disable @typescript-eslint/no-explicit-any */
import "./setup-test-env";

/**
 * FlowPilot — POLICY-RESOLUTION FAILURE MUST FAIL CLOSED.
 *
 * Verifies, with mocked policy/provider boundaries only (no DB, no network,
 * no paid calls), that `createPolicyBackedAi` never selects the lexical
 * `deterministicConversationAi` when the platform policy cannot be resolved:
 *
 *   1. policy read throws;
 *   2. policy read returns a persistence failure;
 *   3. stored policy is invalid;
 *   4. each failure + a structured free-form booking request → safe handoff,
 *      no booking mutation, no lexical interpretation, no provider/JEV call;
 *   5. ambiguous and sensitive free-form messages under policy failure →
 *      the same fail-closed behavior;
 *   6. valid policy → the existing structured behavior is preserved;
 *   7. valid policy + provider failure → the existing safe failure is preserved;
 *   8. `/start` and a valid offer callback remain protocol-driven (zero AI);
 *   9. failure evidence reports zero physical attempts / model calls and never
 *      records an AI_TURN that did not happen.
 *
 * Run: pnpm check:policy-failure
 */

import {
  PLAYGROUND_IDS,
  createPlaygroundHarness,
} from "../src/features/conversations/playground/harness";
import { buildSlotOffer } from "../src/features/conversations/server/booking-offer";
import {
  SAFE_HANDOFF_REPLIES,
  type ConversationAi,
} from "../src/features/conversations/server/conversation-ai";
import {
  receiveInboundMessage,
  type InboundSuccess,
} from "../src/features/conversations/server/conversation-engine";
import {
  dehydrateConversationState,
  emptyConversationState,
  withPresentedOffer,
} from "../src/features/conversations/server/conversation-state";
import type { EffectiveAiPolicy } from "../src/lib/validation/platform";
import {
  POLICY_UNAVAILABLE_AI_PROVIDER,
  createPolicyBackedAi,
} from "../src/server/integrations/ai/factory";

type Check = { label: string; pass: boolean };

const checks: Check[] = [];

function check(label: string, pass: boolean): void {
  checks.push({ label, pass });
  console.log(`${pass ? "✔" : "✘"} ${label}`);
}

function offlineEnv(name: string): string | undefined {
  // JEV is disabled so a passing valid-policy case proves the generative path
  // itself and cannot consume a second mocked request.
  if (name === "FLOWPILOT_JEV_SEMANTIC_ENABLED") return "0";
  if (
    name === "OPENROUTER_API_KEY" ||
    name === "AGENTROUTER_API_KEY" ||
    name === "ATRIA_API_KEY" ||
    name === "CODECRAFT_API_KEY"
  ) {
    return "test-key";
  }
  return process.env[name];
}

function validReply(): string {
  return JSON.stringify({
    intent: "GREETING",
    action: "reply",
    content: "وعليكم السلام ورحمة الله وبركاته",
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
}

function openAiEnvelope(content: string): Record<string, unknown> {
  return {
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 12, completion_tokens: 8 },
  };
}

type FetchCounter = { calls: number; fetchImpl: typeof fetch };

function countingFetch(status: number, body: unknown): FetchCounter {
  const counter: FetchCounter = {
    calls: 0,
    fetchImpl: (async () => {
      counter.calls += 1;
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch,
  };
  return counter;
}

type PolicyResult =
  | { success: true; data: { effective: EffectiveAiPolicy } }
  | { success: false; error: { code: string; message: string } };

type PolicyFailureCase = { label: string; read: () => Promise<PolicyResult> };

const POLICY_FAILURES: PolicyFailureCase[] = [
  {
    label: "policy read throws",
    read: async () => {
      throw new Error("db down");
    },
  },
  {
    label: "policy read returns PERSISTENCE_FAILED",
    read: async () => ({
      success: false,
      error: {
        code: "PERSISTENCE_FAILED",
        message: "تعذر تحميل سياسة الذكاء الاصطناعي",
      },
    }),
  },
  {
    label: "stored policy is INVALID_POLICY",
    read: async () => ({
      success: false,
      error: {
        code: "INVALID_POLICY",
        message: "تكوين سياسة الذكاء الاصطناعي غير صالح",
      },
    }),
  },
];

const BOOKING_MESSAGE = "عايز أحجز كشف أسنان بكرة الساعة 10 الصبح";

async function buildUnavailableAi(
  failure: PolicyFailureCase,
): Promise<{ ai: ConversationAi; fetchCalls: () => number }> {
  const counter = countingFetch(200, openAiEnvelope(validReply()));
  const ai = await createPolicyBackedAi({
    getEnvVar: offlineEnv,
    fetchImpl: counter.fetchImpl,
    getAiPolicyImpl: failure.read as never,
  });
  return { ai, fetchCalls: () => counter.calls };
}

async function runPolicyFailureTurn(params: {
  failure: PolicyFailureCase;
  message: string;
  externalId: string;
}): Promise<{
  ai: ConversationAi;
  fetchCalls: () => number;
  result: InboundSuccess;
  harness: ReturnType<typeof createPlaygroundHarness>;
  usage: Array<Record<string, unknown>>;
}> {
  const { ai, fetchCalls } = await buildUnavailableAi(params.failure);
  const harness = createPlaygroundHarness({ channel: "WHATSAPP" });
  const usage: Array<Record<string, unknown>> = [];
  harness.deps.ai = ai;
  harness.deps.usageRepository = {
    record: async (record: Record<string, unknown>) => {
      usage.push(record);
      return { id: `usage-${usage.length}` };
    },
  } as never;

  const result = (await receiveInboundMessage(harness.deps, {
    to: harness.business.whatsappNumber ?? "+201001111111",
    from: "+201011112222",
    text: params.message,
    receivedAt: harness.getVirtualNow().toISOString(),
    externalId: params.externalId,
  })) as InboundSuccess;

  return { ai, fetchCalls, result, harness, usage };
}

async function main(): Promise<void> {
  console.log("=== Policy-resolution failure fail-closed verification ===\n");

  // ── 1–4. Every failure mode + a structured free-form booking request ──────
  for (const [index, failure] of POLICY_FAILURES.entries()) {
    const { ai, fetchCalls } = await buildUnavailableAi(failure);
    check(
      `1.${index + 1} ${failure.label} → bounded unavailable assistant (not lexical)`,
      ai.providerName === POLICY_UNAVAILABLE_AI_PROVIDER,
    );

    let rejected = false;
    try {
      await ai.respond({
        message: BOOKING_MESSAGE,
        conversationStatus: "AI_ACTIVE",
        recentMessages: [],
        businessName: "عيادة النور لطب الأسنان",
        services: [],
        faqs: [],
      });
    } catch {
      rejected = true;
    }
    check(
      `1.${index + 1}b ${failure.label} → unavailable respond rejects with ZERO provider calls`,
      rejected && fetchCalls() === 0,
    );

    const run = await runPolicyFailureTurn({
      failure,
      message: BOOKING_MESSAGE,
      externalId: `policy-failure-booking-${index + 1}`,
    });
    const { result, harness, usage } = run;
    const assistantMessages = harness.messages.filter(
      (message) => message.senderType === "AI",
    );
    const observability = result.ok ? result.observability : undefined;

    check(
      `4.${index + 1}a booking request under ${failure.label} → NEED_HUMAN / AI_HANDOFF / AI_FAILURE`,
      result.ok === true &&
        result.assistantAction === "AI_HANDOFF" &&
        result.conversationStatus === "NEED_HUMAN" &&
        result.handoffCause === "AI_FAILURE" &&
        result.intent === null &&
        result.assistantProvider === POLICY_UNAVAILABLE_AI_PROVIDER,
    );
    check(
      `4.${index + 1}b booking request under ${failure.label} → existing safe acknowledgment only`,
      assistantMessages.length === 1 &&
        assistantMessages[0]?.content ===
          SAFE_HANDOFF_REPLIES.INVALID_OUTPUT,
    );
    check(
      `4.${index + 1}c booking request under ${failure.label} → no booking mutation and no lexical interpretation`,
      harness.capturedAppointmentWrites.length === 0 &&
        harness.appointments.length === 0 &&
        !assistantMessages[0]?.content.includes("يسعدنا خدمتك") &&
        !assistantMessages[0]?.content.includes("سيتم التواصل"),
    );
    check(
      `4.${index + 1}d booking request under ${failure.label} → zero provider/JEV attempts and no AI_TURN usage`,
      run.fetchCalls() === 0 &&
        observability?.routingDecision === "NONE" &&
        observability?.providerAttempts === 0 &&
        observability?.modelCallCount === 0 &&
        observability?.providerStatus === "NOT_CALLED" &&
        (observability?.executionAttempts ?? null) === null &&
        usage.filter((record) => record.kind === "AI_TURN").length === 0,
    );
  }

  // ── 5. Ambiguous and sensitive free-form turns under policy failure ───────
  for (const [index, failure] of POLICY_FAILURES.entries()) {
    for (const [caseIndex, message] of [
      "مش عارف",
      "عندي ألم شديد في سني ومحتاج مساعدة عاجلة",
    ].entries()) {
      const run = await runPolicyFailureTurn({
        failure,
        message,
        externalId: `policy-failure-edge-${index + 1}-${caseIndex + 1}`,
      });
      const { result, harness, usage } = run;
      const assistantMessages = harness.messages.filter(
        (entry) => entry.senderType === "AI",
      );
      const observability = result.ok ? result.observability : undefined;

      check(
        `5.${index + 1}.${caseIndex + 1} ${failure.label} + ${caseIndex === 0 ? "ambiguous" : "sensitive"} message → same fail-closed handoff`,
        result.ok === true &&
          result.assistantAction === "AI_HANDOFF" &&
          result.conversationStatus === "NEED_HUMAN" &&
          result.handoffCause === "AI_FAILURE" &&
          result.intent === null &&
          result.assistantProvider === POLICY_UNAVAILABLE_AI_PROVIDER &&
          assistantMessages.length === 1 &&
          assistantMessages[0]?.content ===
            SAFE_HANDOFF_REPLIES.INVALID_OUTPUT &&
          harness.capturedAppointmentWrites.length === 0 &&
          run.fetchCalls() === 0 &&
          observability?.providerAttempts === 0 &&
          observability?.modelCallCount === 0 &&
          usage.filter((record) => record.kind === "AI_TURN").length === 0,
      );
    }
  }

  // ── 6. Valid policy → existing structured behavior is preserved ───────────
  {
    const counter = countingFetch(200, openAiEnvelope(validReply()));
    const effective: EffectiveAiPolicy = {
      primaryProvider: "openrouter",
      primaryModel: "openrouter/auto",
      secondary: null,
      openRouterProviderOnly: null,
    };
    const ai = await createPolicyBackedAi({
      getEnvVar: offlineEnv,
      fetchImpl: counter.fetchImpl,
      getAiPolicyImpl: (async () => ({
        success: true,
        data: { effective },
      })) as never,
    });
    const harness = createPlaygroundHarness({ channel: "WHATSAPP" });
    harness.deps.ai = ai;

    const result = (await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber ?? "+201001111111",
      from: "+201011112222",
      text: "السلام عليكم",
      receivedAt: harness.getVirtualNow().toISOString(),
      externalId: "valid-policy-structured",
    })) as InboundSuccess;
    const assistantMessages = harness.messages.filter(
      (message) => message.senderType === "AI",
    );

    check(
      "6a valid policy → unchanged structured provider call and AI_ACTIVE reply",
      ai.providerName === "openrouter" &&
        counter.calls === 1 &&
        result.ok === true &&
        result.assistantAction === "AI_REPLY" &&
        result.conversationStatus === "AI_ACTIVE" &&
        result.intent === "GREETING" &&
        result.assistantProvider === "openrouter" &&
        assistantMessages[0]?.content ===
          "وعليكم السلام ورحمة الله وبركاته",
    );
    check(
      "6b valid policy → one physical attempt, one logical model call, no false zero",
      result.ok === true &&
        result.observability?.providerAttempts === 1 &&
        result.observability?.modelCallCount === 1 &&
        result.observability?.providerStatus === "SUCCESS",
    );
  }

  // ── 7. Valid policy + provider failure → existing safe failure preserved ──
  {
    const counter = countingFetch(503, { error: "upstream unavailable" });
    const effective: EffectiveAiPolicy = {
      primaryProvider: "openrouter",
      primaryModel: "openrouter/auto",
      secondary: null,
      openRouterProviderOnly: null,
    };
    const ai = await createPolicyBackedAi({
      getEnvVar: offlineEnv,
      fetchImpl: counter.fetchImpl,
      getAiPolicyImpl: (async () => ({
        success: true,
        data: { effective },
      })) as never,
    });
    const harness = createPlaygroundHarness({ channel: "WHATSAPP" });
    harness.deps.ai = ai;

    const result = (await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber ?? "+201001111111",
      from: "+201011112222",
      text: "ما هي مواعيد العمل؟",
      receivedAt: harness.getVirtualNow().toISOString(),
      externalId: "valid-policy-provider-failure",
    })) as InboundSuccess;
    const assistantMessages = harness.messages.filter(
      (message) => message.senderType === "AI",
    );

    check(
      "7a valid policy + provider 503 → existing PROVIDER_FAILURE safe handoff",
      result.ok === true &&
        result.assistantAction === "AI_HANDOFF" &&
        result.conversationStatus === "NEED_HUMAN" &&
        result.handoffCause === "PROVIDER_FAILURE" &&
        assistantMessages.length === 1 &&
        assistantMessages[0]?.content ===
          SAFE_HANDOFF_REPLIES.PROVIDER_FAILURE,
    );
    check(
      "7b provider failure keeps real physical-attempt evidence",
      counter.calls >= 1 &&
        result.ok === true &&
        (result.observability?.providerAttempts ?? 0) >= 1 &&
        result.observability?.providerStatus === "FAILURE",
    );
  }

  // ── 8. Protocol handling under policy failure remains zero-call ───────────
  {
    const { ai, fetchCalls } = await buildUnavailableAi(POLICY_FAILURES[2]!);
    const harness = createPlaygroundHarness({ channel: "TELEGRAM" });
    harness.deps.ai = ai;

    const startResult = (await receiveInboundMessage(
      harness.deps,
      {
        to: "6000000000",
        from: "9988771122",
        text: "/start",
        receivedAt: harness.getVirtualNow().toISOString(),
        externalId: "tg:6000000000:policy-failure-start",
      },
      {
        businessId: harness.business.id,
        connectionId: null,
        branchId: harness.business.defaultBranchId,
      },
    )) as InboundSuccess;
    const startMessages = harness.messages.filter(
      (message) => message.senderType === "AI",
    );

    check(
      "8a /start under policy failure stays a protocol reply (no AI, no failure acknowledgment)",
      startResult.ok === true &&
        startResult.assistantAction === "AI_REPLY" &&
        startResult.conversationStatus === "AI_ACTIVE" &&
        startResult.intent === "GREETING" &&
        startMessages.length === 1 &&
        startMessages[0]?.content !== SAFE_HANDOFF_REPLIES.INVALID_OUTPUT &&
        fetchCalls() === 0,
    );

    harness.reset();

    const offer = buildSlotOffer(
      {
        businessId: harness.business.id,
        conversationId: harness.conversation.id,
      },
      "policy-failure-callback-token",
      {
        serviceId: PLAYGROUND_IDS.SERV_DENTAL,
        serviceName: "كشف أسنان",
        serviceSource: "CUSTOMER",
        providerId: PLAYGROUND_IDS.PROV_1,
        date: "2026-10-25",
        followUpRequestId: null,
        shownCount: 1,
        options: [
          {
            providerId: PLAYGROUND_IDS.PROV_1,
            displayName: "د. أحمد سامي",
            startAt: "2026-10-25T10:00",
            endAt: "2026-10-25T10:30",
          },
        ],
      },
      harness.getVirtualNow(),
    );
    if (offer) {
      await harness.stateStore.save(
        harness.business.id,
        harness.conversation.id,
        null,
        dehydrateConversationState(
          withPresentedOffer(emptyConversationState(), offer),
        ),
      );
    }

    const callbackResult = (await receiveInboundMessage(
      harness.deps,
      {
        to: "6000000000",
        from: "9988771122",
        text: `fp:${offer?.token ?? "missing"}:1`,
        receivedAt: harness.getVirtualNow().toISOString(),
        externalId: "tg:6000000000:policy-failure-valid-callback",
      },
      {
        businessId: harness.business.id,
        connectionId: null,
        branchId: harness.business.defaultBranchId,
      },
    )) as InboundSuccess;
    const callbackMessages = harness.messages.filter(
      (message) => message.senderType === "AI",
    );

    check(
      "8b valid offer callback under policy failure stays mechanical and correct",
      offer !== null &&
        callbackResult.ok === true &&
        callbackResult.assistantAction === "AI_REPLY" &&
        callbackResult.conversationStatus === "BOOKED" &&
        harness.capturedAppointmentWrites.length === 1 &&
        callbackMessages.length >= 1 &&
        callbackMessages.every(
          (message) => message.content !== SAFE_HANDOFF_REPLIES.INVALID_OUTPUT,
        ) &&
        fetchCalls() === 0,
    );
  }

  // ── 9. No stale/foreign telemetry is reused for the no-call failure ───────
  {
    const staleTelemetry = {
      attempts: [
        {
          provider: "openrouter",
          model: "stale-model",
          latencyMs: 1,
          status: "FAILURE" as const,
          errorCode: "PERMANENT" as const,
          httpAttempts: 1,
        },
      ],
      fallbackUsed: false,
      finalProvider: "openrouter",
      finalModel: "stale-model",
      finalStatus: "FAILURE" as const,
      totalHttpAttempts: 1,
    };
    const unavailableWithStaleTelemetry: ConversationAi & {
      getLastTelemetry: () => typeof staleTelemetry;
    } = {
      providerName: POLICY_UNAVAILABLE_AI_PROVIDER,
      async respond(): Promise<never> {
        throw new Error("AI_POLICY_UNAVAILABLE");
      },
      getLastTelemetry: () => staleTelemetry,
    };
    const harness = createPlaygroundHarness({ channel: "WHATSAPP" });
    const usage: Array<Record<string, unknown>> = [];
    harness.deps.ai = unavailableWithStaleTelemetry;
    harness.deps.usageRepository = {
      record: async (record: Record<string, unknown>) => {
        usage.push(record);
        return { id: `usage-${usage.length}` };
      },
    } as never;

    const result = (await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber ?? "+201001111111",
      from: "+201011112222",
      text: BOOKING_MESSAGE,
      receivedAt: harness.getVirtualNow().toISOString(),
      externalId: "policy-failure-stale-telemetry",
    })) as InboundSuccess;

    check(
      "9 stale/foreign telemetry is never reused for a policy-unavailable turn",
      result.ok === true &&
        result.handoffCause === "AI_FAILURE" &&
        result.observability?.routingDecision === "NONE" &&
        result.observability?.providerAttempts === 0 &&
        result.observability?.modelCallCount === 0 &&
        result.observability?.providerStatus === "NOT_CALLED" &&
        (result.observability?.executionAttempts ?? null) === null &&
        usage.filter((record) => record.kind === "AI_TURN").length === 0,
    );
  }

  const failures = checks.filter((entry) => !entry.pass);
  console.log(
    `\n${checks.length - failures.length}/${checks.length} checks passed.`,
  );
  if (failures.length > 0) {
    console.error("FAILED:");
    for (const failure of failures) console.error(`- ${failure.label}`);
    process.exit(1);
  }
  console.log("RESULT: PASS");
}

main().catch((error) => {
  console.error("UNEXPECTED FAILURE:", error);
  process.exit(1);
});
