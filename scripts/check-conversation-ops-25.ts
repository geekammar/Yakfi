/* eslint-disable @typescript-eslint/consistent-type-imports */
/**
 * FlowPilot — PROMPT-AI-OPS-25 regression check: REPEATED FALSE HANDOFF after
 * Resume AI (provider-mention false-positive).
 *
 * Deterministic, OFFLINE verification (no DB, no network, no LLM, no API
 * tokens, no secrets). It runs the REAL conversation engine with in-memory
 * repositories and a HEALTHY scripted provider that always returns a valid,
 * knowledge-backed reply, so the ONLY variable under test is the engine's own
 * deterministic decision authority — the pre-AI explicit-human precedence.
 *
 * ROOT CAUSE this check guards (PROMPT-AI-OPS-25):
 *   `HUMAN_WORDS` contained the provider/professional titles «دكتور» /
 *   «دكتورة». A turn that merely NAMED the provider — the live identity
 *   question «السلام عليكم هو انتو عيادة الدكتورة افنان للاسنان؟» — was
 *   read by `detectTurnControlSignals` / `classifyCustomerMessage` as an
 *   EXPLICIT HUMAN REQUEST. That signal is AUTHORITATIVE: `turn-planner` rule
 *   2 (`signals.explicitHuman === true`) forces `HANDOFF` /
 *   `EXPLICIT_HUMAN_REQUEST` and the engine then emits the deterministic
 *   customer-request handoff message, DISCARDING the provider's valid reply.
 *   Because the signal is re-derived from the CURRENT message text on every
 *   turn, "Resume AI" (status → AI_ACTIVE) could never clear it: the next
 *   ordinary message re-fired the same false handoff indefinitely.
 *
 *   FIX (smallest correction): a title is an explicit human request ONLY when
 *   the turn ALSO carries a first-person request-to-speak cue. Naming a
 *   provider stays a normal business turn; asking to speak to one still
 *   hands off. Booking-task provider preference («أي دكتور» inside a booking
 *   request) is unchanged — it was already masked and stays masked.
 *
 * Cases:
 *   R1  an ordinary provider-IDENTITY question is answered, not handed off
 *   R2  the same question again after Resume AI is answered again (the
 *       reported repetition is gone)
 *   R3  a second ordinary question after Resume AI is answered (no fallback)
 *   R4  a genuine explicit human request STILL hands off (model-driven)
 *   R5  a genuine provider-request phrase («أكلم الدكتور») still hands off
 *       deterministically (safety precedence intact)
 *   R6  a provider mention INSIDE a booking task is a provider PREFERENCE,
 *       never a human handoff (existing booking behavior unchanged)
 *   R7  sensitive language still hands off (safety precedence intact)
 *   R8  a genuine provider failure still fails safe to NEED_HUMAN with a
 *       correctly-typed PROVIDER_FAILURE cause — never mislabeled as the
 *       customer's own request
 *   R9  NEED_HUMAN → Resume AI → AI_ACTIVE persists durably across turns
 *   R10 the turn-scoped signal cannot be poisoned by a previous handoff:
 *       after Resume AI, an old NEED_HUMAN state/cause forces nothing
 *
 * Run: pnpm check:conversation-ops-25
 */
export {};

type Check = { label: string; pass: boolean };

type ConversationStatus = import("../src/types/domain").ConversationStatus;
type AiResponse =
  import("../src/features/conversations/server/ai-contract").AiResponse;
type ConversationEngineDeps =
  import("../src/features/conversations/server/conversation-engine").ConversationEngineDeps;
type InboundResult =
  import("../src/features/conversations/server/conversation-engine").InboundResult;

const checks: Check[] = [];
function check(label: string, pass: boolean): void {
  checks.push({ label, pass });
}
function eq<T>(actual: T, expected: T): boolean {
  return actual === expected;
}
/**
 * Narrow the engine's union result to the SUCCESS variant that carries the
 * turn fields (the duplicate/failure variants intentionally do not).
 */
function turnOf(result: InboundResult): {
  assistantAction: string;
  conversationStatus: ConversationStatus;
  handoffCause: string | null;
} {
  if (!result.ok || result.duplicate) {
    return {
      assistantAction: "NONE",
      conversationStatus: "NEED_HUMAN",
      handoffCause: null,
    };
  }
  return {
    assistantAction: result.assistantAction,
    conversationStatus: result.conversationStatus,
    handoffCause: result.handoffCause,
  };
}

async function main(): Promise<void> {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const engine =
    await import("../src/features/conversations/server/conversation-engine");
  const { detectTurnControlSignals } =
    await import("../src/features/conversations/server/conversation-ai");

  const BUSINESS_A = "11111111-1111-4111-8111-111111111111";
  const BRANCH_A = "55555555-5555-4555-8555-555555555555";
  const STAFF_ID = "44444444-4444-4444-8444-444444444444";
  const now = () => new Date();

  const business = {
    id: BUSINESS_A,
    name: "مركز أفنان",
    vertical: null,
    city: null,
    whatsappNumber: "+201000000000",
    timezone: "Africa/Cairo",
    about: "عيادة أسنان متخصصة",
    workingHours: {},
    slotDurationMinutes: 30,
    confirmationMode: "manual",
    faqs: [
      {
        question: "هل هذه عيادة الدكتورة أفنان للاسنان؟",
        answer: "نعم، هذه عيادة الدكتورة أفنان لطب الأسنان.",
      },
      { question: "مكانكم فين؟", answer: "موقعنا في شارع الاستاد." },
    ],
    cancellationPolicy: null,
    onboardingCompletedAt: now(),
    isActive: true,
    createdAt: now(),
    updatedAt: now(),
    deletedAt: null,
    assistantName: null,
    assistantStyle: null,
    defaultBranchId: BRANCH_A,
  } as unknown as Parameters<
    typeof engine.receiveInboundMessage
  >[0]["businessRepository"] extends {
    findById: (id: string) => Promise<infer B>;
  }
    ? B
    : never;

  let conversation: {
    id: string;
    businessId: string;
    status: ConversationStatus;
    assignedUserId: string | null;
  } = {
    id: "22222222-2222-4222-8222-222222222222",
    businessId: BUSINESS_A,
    status: "AI_ACTIVE",
    assignedUserId: null,
  };
  const messages: Array<{
    id: string;
    senderType: string;
    content: string;
    createdAt: string;
  }> = [];
  const sent: string[] = [];
  let aiCalls = 0;
  let messageSeq = 0;
  // The healthy provider's reply for the CURRENT turn (swapped per case).
  let nextReply: AiResponse = faqReply();

  function faqReply(): AiResponse {
    return {
      intent: "FAQ",
      action: "reply",
      content: "إجابة المساعد عن السؤال.",
      extraction: {
        service: null,
        provider: null,
        date: null,
        timePreference: null,
      },
      handoffReason: null,
      summary: null,
    };
  }

  function humanHandoff(): AiResponse {
    return {
      intent: "HUMAN_REQUEST",
      action: "handoff",
      content: "تحويل",
      extraction: {
        service: null,
        provider: null,
        date: null,
        timePreference: null,
      },
      handoffReason: "HUMAN_REQUEST",
      summary: null,
    };
  }

  const deps: ConversationEngineDeps = {
    businessRepository: {
      findByWhatsappNumber: async () => null,
      findById: async (id: string) =>
        id === BUSINESS_A ? (business as object | null) : null,
    },
    branchRepository: { findDefaultByBusiness: async () => null },
    customerRepository: {
      upsertByPhone: async () => ({
        id: "66666666-6666-4666-8666-666666666666",
        businessId: BUSINESS_A,
        name: "عميل",
        phone: "+201234567890",
      }),
      touchConversation: async () => undefined,
    },
    conversationRepository: {
      findLatestByCustomer: async () => ({ id: conversation.id }),
      findById: async () => conversation,
      create: async () => conversation,
      addMessage: async (
        input: { conversationId: string; senderType: string; content: string },
        workflow?: {
          status?: ConversationStatus;
          assignedUserId?: string | null;
        },
      ) => {
        messageSeq += 1;
        const message = {
          id: `msg-${messageSeq}`,
          senderType: input.senderType,
          content: input.content,
          createdAt: now().toISOString(),
        };
        messages.push(message);
        if (workflow?.status)
          conversation = { ...conversation, status: workflow.status };
        if (workflow && "assignedUserId" in workflow) {
          conversation = {
            ...conversation,
            assignedUserId: workflow.assignedUserId ?? null,
          };
        }
        return message;
      },
      getMessages: async () =>
        [...messages].reverse().map((message, index) => ({
          id: messages[messages.length - 1 - index]!.id,
          conversationId: conversation.id,
          senderType: message.senderType,
          content: message.content,
          createdAt: message.createdAt,
        })),
      update: async () => conversation,
      updateWorkflow: async (
        _id: string,
        patch: { status?: ConversationStatus; assignedUserId?: string | null },
      ) => {
        const next: typeof conversation = { ...conversation };
        if (patch.status) next.status = patch.status;
        if ("assignedUserId" in patch) {
          next.assignedUserId = patch.assignedUserId ?? null;
        }
        conversation = next;
        return conversation;
      },
    },
    serviceRepository: {
      listByBusiness: async () => [],
      findById: async () => null,
    },
    inboundDedupeRepository: {
      claim: async () => ({ status: "claimed" as const, claimId: "c1" }),
    },
    usageRepository: { record: async () => undefined },
    attentionRepository: {
      open: async (input: {
        businessId: string;
        conversationId: string;
        reason: string;
      }) => {
        return {
          id: "77777777-7777-4777-8777-777777777777",
          ...input,
          createdAt: now().toISOString(),
        };
      },
      resolve: async () => undefined,
    },
    ai: {
      providerName: "scripted-healthy",
      async respond(): Promise<AiResponse> {
        aiCalls += 1;
        return nextReply;
      },
    },
    transport: {
      providerName: "scripted",
      async send(input: { content: string }) {
        sent.push(input.content);
        return { provider: "scripted", delivered: true };
      },
    },
  } as unknown as ConversationEngineDeps;

  const run = async (
    text: string,
    externalId: string,
  ): Promise<InboundResult> =>
    engine.receiveInboundMessage(
      deps,
      {
        to: "+201000000000",
        from: "+201234567890",
        text,
        receivedAt: now().toISOString(),
        externalId,
      },
      { businessId: BUSINESS_A, connectionId: null, branchId: BRANCH_A },
    );

  // The EXISTING Resume AI control, composed exactly as the production
  // `transitionConversation` RETURN_TO_AI transition does.
  const resumeAi = async (): Promise<void> => {
    await deps.conversationRepository.updateWorkflow(conversation.id, {
      status: "AI_ACTIVE",
      assignedUserId: null,
    });
  };
  const takeOver = async (): Promise<void> => {
    await deps.conversationRepository.updateWorkflow(conversation.id, {
      status: "NEED_HUMAN",
      assignedUserId: STAFF_ID,
    });
  };

  const IDENTITY_QUESTION =
    "السلام عليكم هو انتو عيادة الدكتورة افنان للاسنان؟";
  const LOCATION_QUESTION = "مكانكم فين؟";
  const HUMAN_REQUEST = "ممكن أكلم حد من الفريق؟";

  // ── R1. an ordinary provider-identity question is ANSWERED ──────────────
  nextReply = faqReply();
  const r1 = await run(IDENTITY_QUESTION, "ops25-r1");
  check(
    "R1. سؤال هوية عادي (ذكر مقدم خدمة) → AI_REPLY، لا تحويل بشري",
    r1.ok &&
      eq(turnOf(r1).assistantAction, "AI_REPLY") &&
      eq(turnOf(r1).conversationStatus, "AI_ACTIVE"),
  );
  check(
    "R1b. رد المساعد صدر (لم يُتجاهل)، ولم تُرسل رسالة التحويل",
    sent.some((content) => content.includes("إجابة المساعد")) &&
      !sent.some((content) => content.includes("جارٍ تحويلك")),
  );
  check(
    "R1c. الإشارة الحتمية: ذكر المسمى الوظيفي وحده ليس طلباً بشرياً",
    eq(detectTurnControlSignals(IDENTITY_QUESTION).explicitHuman, false),
  );

  // ── R2. the reported repetition: Resume AI, then the SAME question ──────
  // Before the fix this re-fired the identical handoff on every turn because
  // the signal is re-derived from the current message text.
  await resumeAi();
  nextReply = faqReply();
  const r2 = await run(IDENTITY_QUESTION, "ops25-r2");
  check(
    "R2. بعد Resume AI: نفس السؤال العادي → AI_REPLY (التكرار اختفى)",
    r2.ok &&
      eq(turnOf(r2).assistantAction, "AI_REPLY") &&
      eq(turnOf(r2).conversationStatus, "AI_ACTIVE"),
  );

  // ── R3. a second ordinary question after Resume AI (no slow fallback) ────
  nextReply = faqReply();
  const r3 = await run(LOCATION_QUESTION, "ops25-r3");
  check(
    "R3. سؤال عادي ثانٍ بعد Resume AI → AI_REPLY (لا تراجع للتحويل)",
    r3.ok &&
      eq(turnOf(r3).assistantAction, "AI_REPLY") &&
      eq(turnOf(r3).conversationStatus, "AI_ACTIVE"),
  );

  // ── R4. a genuine explicit human request STILL hands off (model-driven) ──
  nextReply = humanHandoff();
  const r4 = await run(HUMAN_REQUEST, "ops25-r4");
  check(
    "R4. طلب بشري صريح (نموذج) → NEED_HUMAN + سبب طلب العميل",
    r4.ok &&
      eq(turnOf(r4).assistantAction, "AI_HANDOFF") &&
      eq(turnOf(r4).conversationStatus, "NEED_HUMAN") &&
      eq(turnOf(r4).handoffCause, "CUSTOMER_REQUESTED_HUMAN"),
  );

  // ── R5. a provider request phrase still hands off DETERMINISTICALLY ─────
  // Safety precedence must not become model-dependent: «أكلم الدكتور» fires
  // the deterministic signal even when the model proposed a reply.
  check(
    "R5. «أكلم الدكتور» إشارة حتمية موجبة (طلب صريح بمقدم الرعاية)",
    eq(detectTurnControlSignals("عايز أكلم الدكتور").explicitHuman, true),
  );
  nextReply = faqReply();
  const r5 = await run("عايز أكلم الدكتور", "ops25-r5");
  check(
    "R5b. «أكلم الدكتور» → NEED_HUMAN حتى لو اقترح النموذج رداً (أسبقية السلامة)",
    eq(turnOf(r5).conversationStatus, "NEED_HUMAN"),
  );

  // ── R6. a provider mention INSIDE a booking task stays a preference ─────
  check(
    "R6. «أي دكتور» داخل طلب حجز → ليس طلباً بشرياً (تفضيل مزود)",
    eq(
      detectTurnControlSignals("عايز أحجز تنظيف أسنان أي دكتور يوم 2026-09-14")
        .explicitHuman,
      false,
    ),
  );

  // ── R7. sensitive language still hands off (safety intact) ──────────────
  nextReply = faqReply();
  const r7 = await run("عندي ألم شديد جداً في ضرسي", "ops25-r7");
  check(
    "R7. لغة حساسة → NEED_HUMAN (أسبقية السلامة سليمة)",
    eq(turnOf(r7).conversationStatus, "NEED_HUMAN"),
  );

  // ── R8. a genuine provider failure fails safe with a TYPED cause ────────
  // The failure must never be relabeled as the customer's own request, and
  // the stored handoff cause must represent the provider failure accurately.
  // The provider failure is modelled through the REAL provider-agnostic
  // Conversation Control layer (a failing adapter), exactly as production
  // surfaces it, so the cause taxonomy is exercised end-to-end.
  await resumeAi();
  const { createConversationControl } =
    await import("../src/server/integrations/ai/conversation-control");
  const failingControl = createConversationControl({
    provider: {
      providerId: "atria",
      model: "test",
      secretRef: "NONE",
      async call() {
        return {
          ok: false,
          provider: "atria",
          model: "test",
          latencyMs: 0,
          error: {
            code: "PERMANENT",
            message: "provider unreachable",
            retryable: false,
          },
        };
      },
    },
  });
  const failingDeps = {
    ...deps,
    ai: {
      providerName: "scripted-failing",
      async respond(request: never): Promise<AiResponse> {
        aiCalls += 1;
        const outcome = await failingControl.executeTurn(request);
        if (!outcome.result.ok || !outcome.result.response) {
          throw new Error("provider unreachable");
        }
        return outcome.result.response;
      },
    },
  } as unknown as ConversationEngineDeps;
  const r8 = await engine.receiveInboundMessage(
    failingDeps,
    {
      to: "+201000000000",
      from: "+201234567890",
      text: IDENTITY_QUESTION,
      receivedAt: now().toISOString(),
      externalId: "ops25-r8",
    },
    { businessId: BUSINESS_A, connectionId: null, branchId: BRANCH_A },
  );
  check(
    "R8. فشل المزود → NEED_HUMAN (فشل آمن) + سبب فشل المزود وليس طلب العميل",
    r8.ok &&
      eq(turnOf(r8).conversationStatus, "NEED_HUMAN") &&
      turnOf(r8).handoffCause !== "CUSTOMER_REQUESTED_HUMAN" &&
      turnOf(r8).handoffCause !== null,
  );
  check(
    "R8b. العميل لا يرى رسالة «طلب العميل» عند فشل المزود",
    !sent.some((content) => content.includes("جارٍ تحويلك")),
  );

  // ── R9. NEED_HUMAN → Resume AI → AI_ACTIVE is durable across turns ──────
  await takeOver();
  check(
    "R9a. الاستيلاء البشري → NEED_HUMAN + ملكية",
    eq(conversation.status, "NEED_HUMAN") &&
      eq(conversation.assignedUserId, STAFF_ID),
  );
  await resumeAi();
  check(
    "R9b. Resume AI → AI_ACTIVE + لا ملكية (التحول القائم)",
    eq(conversation.status, "AI_ACTIVE") &&
      eq(conversation.assignedUserId, null),
  );
  nextReply = faqReply();
  const r9 = await run(IDENTITY_QUESTION, "ops25-r9");
  check(
    "R9c. بعد Resume AI المستمر: سؤال عادي → AI_REPLY (الاستئناف دائم)",
    r9.ok && eq(turnOf(r9).assistantAction, "AI_REPLY"),
  );

  // ── R10. an old handoff state/cause cannot force a new handoff ──────────
  // Resume AI clears the conversation-level handoff; nothing turn-scoped is
  // inherited from the previous NEED_HUMAN state. The only authority for THIS
  // turn is the current message + current provider result.
  const r10 = await run(LOCATION_QUESTION, "ops25-r10");
  check(
    "R10. سبب/حالة التحويل القديم لا يجبر تحويلاً جديداً بعد Resume AI",
    r10.ok &&
      eq(turnOf(r10).assistantAction, "AI_REPLY") &&
      eq(turnOf(r10).conversationStatus, "AI_ACTIVE"),
  );

  // ── R11. no duplicate messages, and the AI was actually consulted ───────
  const allIds = messages.map((message) => message.id);
  check(
    "R11. لا تكرار في معرّفات الرسائل عبر دورة الحياة كاملة",
    new Set(allIds).size === allIds.length,
  );
  check(
    "R11b. المساعد استُدعى فعلاً (الردود ليست مسار تجاوز حتمي)",
    aiCalls > 0,
  );

  const failures = checks.filter((entry) => !entry.pass);
  for (const entry of failures) {
    console.log(`✖ ${entry.label}`);
  }
  const passed = checks.length - failures.length;
  console.log(
    `PROMPT-AI-OPS-25 (repeated false handoff after Resume AI): ${passed}/${checks.length} checks passed.`,
  );
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
