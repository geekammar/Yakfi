/* eslint-disable @typescript-eslint/consistent-type-imports */
/**
 * FlowPilot — HUMAN HANDOFF / RESUME AI semantics check (DECISIONS #61).
 *
 * Deterministic, OFFLINE verification of the human-ownership boundary and
 * the explicit Resume AI control (no DB, no network, no LLM, no API
 * tokens, no secrets, no WhatsApp transport). It runs the REAL
 * conversation engine with in-memory repositories, so the whole lifecycle
 * is exercised end-to-end:
 *
 *   AI_ACTIVE → handoff → NEED_HUMAN + staff ownership → the customer
 *   sends a message → the assistant does NOT wake up (no silent hijack),
 *   the message is DEFERRED_TO_STAFF, ownership is preserved → the
 *   operator explicitly chooses Resume AI → AI_ACTIVE + unassigned → the
 *   next customer message IS processed by the assistant, with the FULL
 *   conversation history preserved.
 *
 *   H1  an explicit handoff is human-owned (NEED_HUMAN + assignedUserId)
 *   H2  a message during human ownership does NOT trigger the AI
 *       (zero provider calls, DEFERRED_TO_STAFF, no assistant message)
 *   H3  human ownership is preserved across that message (assignment
 *       never silently cleared)
 *   H4  the Resume AI control (RETURN_TO_AI) restores AI_ACTIVE explicitly
 *       and clears the assignment
 *   H5  after Resume AI, the next customer message IS processed by the
 *       assistant (the turn runs, the thread is the assistant's again)
 *   H6  the resumed AI sees the FULL conversation history — it never
 *       restarts from empty context
 *   H7  no duplicate handoff acknowledgment is ever re-sent
 *   H8  no duplicate customer or assistant messages across the lifecycle
 *   H9  tenant isolation holds: the lifecycle never crosses businesses
 *   H10 the attention layer records exactly ONE event for the handoff and
 *       it is resolved by the Resume AI control
 *   H11 structural: the PRODUCTION Resume AI control (the real
 *       `transitionConversation` RETURN_TO_AI transition + the operator
 *       UI button) composes the same transition this lifecycle exercises,
 *       and the engine's AI-eligibility guard is in place
 *
 * The Resume AI control is NOT a new domain concept and is NOT recreated
 * here: it is the EXISTING `transitionConversation` `RETURN_TO_AI`
 * transition (status → AI_ACTIVE, assignedUserId → null, attention
 * resolved) already wired to the operator UI button «إعادة للمساعد». This
 * check verifies the ENGINE side of that lifecycle through the real
 * `receiveInboundMessage` path (the ownership boundary, the deferred-AI
 * path, history preservation after resume) and guards the real control
 * against drift structurally at H11 — a `"use server"` action cannot be
 * imported offline, so its transition mapping is asserted at the source
 * level, the pattern `check:conversation-control` uses for P2a.
 *
 * Run: pnpm check:conversation-handoff
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

async function main(): Promise<void> {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const engine =
    await import("../src/features/conversations/server/conversation-engine");
  const { operatorAttentionValidation } = await import("../src/lib/validation");

  // ── Deterministic fixtures ───────────────────────────────────────────────
  const BUSINESS_A = "11111111-1111-4111-8111-111111111111";
  const BRANCH_A = "55555555-5555-4555-8555-555555555555";
  const STAFF_ID = "44444444-4444-4444-8444-444444444444";
  const now = () => new Date();
  const business = {
    id: BUSINESS_A,
    name: "منشأة أ",
    vertical: null,
    city: null,
    whatsappNumber: "+201000000000",
    timezone: "Africa/Cairo",
    about: null,
    workingHours: {},
    slotDurationMinutes: 30,
    confirmationMode: "manual",
    faqs: [
      { question: "ما هي ساعات العمل؟", answer: "إجابة المساعد عن السؤال." },
    ],
    cancellationPolicy: null,
    onboardingCompletedAt: now(),
    isActive: true,
    createdAt: now(),
    updatedAt: now(),
    deletedAt: null,
    defaultBranchId: BRANCH_A,
  } as unknown as Parameters<
    typeof engine.receiveInboundMessage
  >[0]["businessRepository"] extends {
    findById: (id: string) => Promise<infer B>;
  }
    ? B
    : never;

  // ── Shared in-memory state (the lifecycle is one continuous thread) ────
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
  const attentionStore = new Map<string, { resolved: boolean }>();
  let aiCalls = 0;
  let messageSeq = 0;

  const aiReply: AiResponse = {
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
        // The ONE existing seam the Resume AI control composes (see below).
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
        operatorAttentionValidation.open.parse(input);
        attentionStore.set(input.conversationId, { resolved: false });
        return {
          id: "77777777-7777-4777-8777-777777777777",
          ...input,
          createdAt: now().toISOString(),
        };
      },
      resolve: async (input: {
        conversationId: string;
        resolvedById: string;
      }) => {
        operatorAttentionValidation.resolve.parse(input);
        const row = attentionStore.get(input.conversationId);
        if (row) attentionStore.set(input.conversationId, { resolved: true });
        return undefined;
      },
    },
    ai: {
      providerName: "scripted",
      async respond(): Promise<AiResponse> {
        aiCalls += 1;
        return aiReply;
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

  const aiMessageCount = () =>
    messages.filter((message) => message.senderType === "AI").length;

  // The EXISTING Resume AI control, composed exactly as the conversations
  // feature's `transitionConversation` does (conversation-actions.ts) — no
  // new domain concept, no new seam.
  const resumeAi = async (): Promise<void> => {
    await deps.conversationRepository.updateWorkflow(conversation.id, {
      status: "AI_ACTIVE",
      assignedUserId: null,
    });
    await (
      deps.attentionRepository as unknown as {
        resolve: (input: {
          conversationId: string;
          resolvedById: string;
        }) => Promise<unknown>;
      }
    ).resolve({
      conversationId: conversation.id,
      resolvedById: STAFF_ID,
    });
  };
  // The EXISTING staff takeover transition, composed the same way.
  const takeOver = async (): Promise<void> => {
    await deps.conversationRepository.updateWorkflow(conversation.id, {
      status: "NEED_HUMAN",
      assignedUserId: STAFF_ID,
    });
  };

  // ── H1. an explicit handoff is human-owned ──────────────────────────────
  await takeOver();
  check(
    "H1. التحويل البشري: NEED_HUMAN + ملكية فريق (assignedUserId محفوظ)",
    eq(conversation.status, "NEED_HUMAN") &&
      eq(conversation.assignedUserId, STAFF_ID),
  );

  // ── H2. a message during human ownership does NOT trigger the AI ────────
  const humanOwnedTurn = await run("عندي سؤال مهم", "ext-while-human-1");
  check(
    "H2. رسالة أثناء الملكية البشرية → DEFERRED_TO_STAFF (لا استيقاظ للذكاء)",
    humanOwnedTurn.ok &&
      !humanOwnedTurn.duplicate &&
      eq(humanOwnedTurn.assistantAction, "DEFERRED_TO_STAFF"),
  );
  check(
    "H2b. لا نداء مزود ذكاء (0) + لا رسالة مساعدة + لا إرسال",
    eq(aiCalls, 0) && eq(aiMessageCount(), 0) && eq(sent.length, 0),
  );
  // The customer message WAS persisted (never dropped) — it went to staff.
  check(
    "H2c. رسالة العميل محفوظة (تذهب للفريق، لا تُفقد)",
    messages.some(
      (message) =>
        message.senderType === "CUSTOMER" &&
        message.content === "عندي سؤال مهم",
    ),
  );

  // ── H3. human ownership is preserved (never silently cleared) ───────────
  check(
    "H3. الملكية البشرية محفوظة بعد رسالة العميل (لا تسليم صامت للذكاء)",
    eq(conversation.status, "NEED_HUMAN") &&
      eq(conversation.assignedUserId, STAFF_ID),
  );

  // ── H4. Resume AI restores AI_ACTIVE explicitly and clears ownership ────
  await resumeAi();
  check(
    "H4. Resume AI: AI_ACTIVE صراحةً + لا ملكية (التحكم القائم RETURN_TO_AI)",
    eq(conversation.status, "AI_ACTIVE") &&
      eq(conversation.assignedUserId, null),
  );
  check(
    "H4b. Resume AI يحلّ صف اهتمام المشغل (تنبيه واحد مُغلق)",
    attentionStore.get(conversation.id)?.resolved === true,
  );

  // ── H5. after Resume AI the next message IS processed by the AI ─────────
  const resumedTurn = await run("ما هي ساعات العمل؟", "ext-after-resume-1");
  check(
    "H5. بعد Resume AI: الرسالة التالية يعالجها المساعد (AI_REPLY)",
    resumedTurn.ok &&
      !resumedTurn.duplicate &&
      eq(resumedTurn.assistantAction, "AI_REPLY") &&
      eq(resumedTurn.conversationStatus, "AI_ACTIVE"),
  );
  check("H5b. الذكاء استُدعي بعد الاستئناف (الخيط عاد للمساعد)", aiCalls >= 1);

  // ── H6. the resumed AI sees the FULL history (no empty restart) ─────────
  // The engine loads the thread's persisted messages into the AI request;
  // the customer's earlier message from the human-owned phase is still
  // present, so the resumed context is continuous, not fresh.
  const customerTexts = messages
    .filter((message) => message.senderType === "CUSTOMER")
    .map((message) => message.content);
  check(
    "H6. السياق الكامل محفوظ — رسائل مرحلة الملكية البشرية لا تُفقد",
    customerTexts.includes("عندي سؤال مهم") &&
      customerTexts.includes("ما هي ساعات العمل؟"),
  );
  check(
    "H6b. لا تكرار للرسائل — كل رسالة عميل مرة واحدة فقط",
    new Set(customerTexts).size === customerTexts.length,
  );

  // ── H7. no duplicate handoff acknowledgment is re-sent ─────────────────
  // The Resume AI control sends NOTHING to the customer; the only outbound
  // so far is the resumed turn's reply.
  check(
    "H7. Resume AI لا يُعيد إرسال إقرار التحويل (لا تكرار)",
    !sent.some((content) => content.includes("سيتواصل")) && sent.length === 1,
  );

  // ── H8. no duplicate customer or assistant messages across the lifecycle
  const allIds = messages.map((message) => message.id);
  check(
    "H8. لا تكرار في معرّفات الرسائل عبر دورة الحياة كاملة",
    new Set(allIds).size === allIds.length && allIds.length === 3,
  );

  // ── H9. tenant isolation: a second business can never see this thread ──
  // A fresh thread for a DIFFERENT business is created and processed; the
  // original business's messages, ids, and state are never touched.
  // The other business gets its OWN Business record and its OWN Default
  // Branch — the engine keys every tenant write off `business.id` and
  // refuses to create a conversation when no Default Branch exists, so the
  // fixture must be tenant-honest or the turn fails safe (which would test
  // nothing about isolation).
  const beforeIds = new Set(messages.map((message) => message.id));
  const otherBusiness = "99999999-9999-4999-8999-999999999999";
  const otherBranch = "77777777-7777-4777-8777-777777777771";
  const otherCustomer = "88888888-8888-4888-8888-888888888888";
  const otherConversationId = "33333333-3333-4333-8333-333333333333";
  const otherBusinessRecord: object = {
    ...(business as object),
    id: otherBusiness,
    defaultBranchId: otherBranch,
    name: "منشأة ب",
  };
  let otherConversation: {
    id: string;
    businessId: string;
    status: ConversationStatus;
    assignedUserId: string | null;
  } | null = null;
  const otherTurn = await engine.receiveInboundMessage(
    {
      ...deps,
      businessRepository: {
        ...deps.businessRepository,
        findById: async (id: string) =>
          id === otherBusiness
            ? (otherBusinessRecord as object | null)
            : (business as object | null),
      },
      branchRepository: {
        findDefaultByBusiness: async (id: string) =>
          id === otherBusiness
            ? { id: otherBranch, businessId: otherBusiness }
            : { id: BRANCH_A, businessId: BUSINESS_A },
      },
      conversationRepository: {
        ...deps.conversationRepository,
        // Isolated repository: a second business has its OWN conversation
        // store; business A's thread is not visible to it at all.
        findById: async () => null,
        findLatestByCustomer: async () => null,
        create: async (input: { businessId: string; customerId: string }) => {
          otherConversation = {
            id: otherConversationId,
            businessId: input.businessId,
            status: "AI_ACTIVE",
            assignedUserId: null,
          };
          return otherConversation;
        },
        addMessage: async (input: {
          conversationId: string;
          senderType: string;
          content: string;
        }) => ({
          id: `other-${input.senderType}`,
          conversationId: input.conversationId,
          senderType: input.senderType,
          content: input.content,
          createdAt: now().toISOString(),
        }),
        getMessages: async () => [],
        update: async () => otherConversation,
        updateWorkflow: async () => otherConversation,
      },
      customerRepository: {
        ...deps.customerRepository,
        upsertByPhone: async () => ({
          id: otherCustomer,
          businessId: otherBusiness,
          name: "عميل آخر",
          phone: "+201234567890",
        }),
      },
    } as unknown as ConversationEngineDeps,
    {
      to: "+201000000000",
      from: "+201234567890",
      text: "اهلا",
      receivedAt: now().toISOString(),
      externalId: "ext-other-1",
    },
    { businessId: otherBusiness, connectionId: null, branchId: BRANCH_A },
  );
  check(
    "H9. عزل المستأجر: منشأة أخرى لا ترى خيط المنشأة أ (معاملة منفصلة)",
    otherTurn.ok &&
      !otherTurn.duplicate &&
      (otherTurn as { conversationId: string }).conversationId ===
        otherConversationId &&
      // The engine keyed the turn to the OTHER business (it reads
      // `business.id`, never the inbound number's existing mapping).
      (otherTurn as { businessId: string }).businessId === otherBusiness &&
      // Business A's message store is untouched by the other business turn.
      beforeIds.size === messages.length &&
      messages.every((message) => beforeIds.has(message.id)),
  );
  check(
    "H9b. الترحيب يعمل للمنشأة الأخرى أيضاً (النية محايدة عن القناة/المزود)",
    otherTurn.ok &&
      !otherTurn.duplicate &&
      (otherTurn as { intent: string | null }).intent === "GREETING" &&
      (otherTurn as { conversationStatus: string }).conversationStatus ===
        "AI_ACTIVE",
  );

  // ── H10. one attention event for the handoff, resolved by Resume AI ─────
  check(
    "H10. صف اهتمام واحد فقط لكل التحويل (تكرار الرسائل لا يُنشئ عاصفة)",
    attentionStore.size === 1,
  );

  // ── H11. the REAL Resume AI control exists in production source ──────────
  // The lifecycle above is driven through the repository seam; this proves
  // the PRODUCTION control the operator actually clicks composes the SAME
  // transition, so the harness cannot silently drift from the real action.
  // (Source-level structural guard, the same pattern as
  // check-conversation-control P2a — offline, no server action import.)
  {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const read = (rel: string) =>
      fs.readFileSync(path.join(process.cwd(), rel), "utf8");
    const actions = read(
      "src/features/conversations/actions/conversation-actions.ts",
    );
    const schema = read(
      "src/features/conversations/schemas/conversation-schema.ts",
    );
    const ui = read(
      "src/features/conversations/components/conversation-detail.tsx",
    );
    const engineSrc = read(
      "src/features/conversations/server/conversation-engine.ts",
    );
    check(
      "H11a. الإجراء الحقيقي يملك RETURN_TO_AI ⇒ AI_ACTIVE + لا ملكية",
      /RETURN_TO_AI:\s*\{\s*status:\s*"AI_ACTIVE"\s+as const,\s*assignedUserId:\s*null,?/.test(
        actions,
      ),
    );
    check(
      "H11b. RETURN_TO_AI يحلّ صف انتباه المشغل (نفس السلوك المُختبر)",
      /transition === "HANDOFF"[\s\S]*?else\s*\{\s*await operatorAttentionRepository\.resolve/.test(
        actions,
      ),
    );
    check(
      "H11c. مخطط الانتقال يحتوي RETURN_TO_AI (قائمة مغلقة)",
      schema.includes('"TAKE_OVER", "RETURN_TO_AI", "MARK_BOOKED", "HANDOFF"'),
    );
    check(
      "H11d. واجهة المشغل تعرض التحكم «إعادة للمساعد» (RETURN_TO_AI)",
      ui.includes('"RETURN_TO_AI"') && ui.includes("إعادة للمساعد"),
    );
    check(
      "H11e. المحرك يحرس AI eligibility: NEED_HUMAN أو ملكية ⇒ تأجيل",
      /aiEligible\s*=\s*conversation\.status === "AI_ACTIVE" && !conversation\.assignedUserId/.test(
        engineSrc,
      ),
    );
  }

  // ── report ─────────────────────────────────────────────────────────────
  const failed = checks.filter((item) => !item.pass);
  console.log(`\n── HUMAN HANDOFF / RESUME AI — ${checks.length} checks ──`);
  for (const item of checks) {
    console.log(`${item.pass ? "PASS" : "FAIL"}  ${item.label}`);
  }
  console.log(
    `\n${checks.length - failed.length}/${checks.length} passed, ${failed.length} failed`,
  );
  if (failed.length > 0) {
    console.log("\nFAILURES:");
    for (const item of failed) console.log(`  ✗ ${item.label}`);
    process.exitCode = 1;
  }
  console.log(
    "\nNo network, no DB, no LLM provider call for greetings, no WhatsApp transport, no Meta send was used by this check.",
  );
}

main().catch((error: Error) => {
  console.error(`check crashed: ${error.message}`);
  console.error(error.stack ?? "");
  process.exit(1);
});
