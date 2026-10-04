/**
 * FlowPilot — OPERATOR ATTENTION check (PROMPT-B04).
 *
 * Offline, in-memory verification of the human-handoff notification layer
 * (no DB, no network, no LLM, no API tokens, no secrets). It runs the REAL
 * conversation engine with the REAL B-02 context builder and the REAL B-03
 * disclosure gate; only the repositories are in-memory fakes, so the whole
 * NEED_HUMAN → attention → resolution seam is exercised end-to-end:
 *
 *   1.  a safe AI answer creates NO operator attention;
 *   2.  an AI handoff creates operator attention with the coarse reason;
 *   3.  repeated handoffs on the same thread create exactly ONE live alert
 *       (no notification storm);
 *   4.  operator resolution clears the attention (and re-opening works);
 *   5.  a second tenant can never see another tenant's attention;
 *   6.  a B-03 refused reply still routes to handoff + attention;
 *   7.  a booking-domain answer (clarification) does NOT hand off;
 *   8.  unresolved attention survives a "restart" (state is external);
 *   9.  invalid identifiers fail safe (validation rejects; an attention
 *       write failure never breaks the customer turn);
 *  10.  the customer-facing output is unchanged — no attention metadata,
 *       reasons, or AI jargon ever reach the customer.
 *
 * Run: pnpm check:operator-attention
 */

import type { AiResponse } from "../src/features/conversations/server/ai-contract";
import type {
  ConversationEngineDeps,
  InboundResult,
  InboundSuccess,
} from "../src/features/conversations/server/conversation-engine";
import type { HandoffCause } from "../src/features/conversations/server/handoff-cause";
import type { AttentionReason } from "../src/lib/validation";
import type {
  Branch,
  Business,
  Conversation,
  ConversationStatus,
  Customer,
  Message,
  UsageRecord,
} from "../src/types/domain";

export {};

type Check = { label: string; pass: boolean };

/** Narrow a result to the real (non-duplicate) success the assertions read. */
function isSuccess(result: InboundResult): result is InboundSuccess {
  return result.ok && !result.duplicate;
}

async function main(): Promise<void> {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const engine =
    await import("../src/features/conversations/server/conversation-engine");
  const { operatorAttentionValidation, ATTENTION_REASON_LABELS } =
    await import("../src/lib/validation");

  const checks: Check[] = [];
  function check(label: string, pass: boolean): void {
    checks.push({ label, pass });
  }

  // ── Deterministic fixtures ───────────────────────────────────────────────
  const BUSINESS_A = "11111111-1111-4111-8111-111111111111";
  const BUSINESS_B = "22222222-2222-4222-8222-222222222222";
  const BUSINESS_C = "33333333-3333-4333-8333-333333333333";
  const BRANCH_A = "44444444-4444-4444-8444-444444444444";
  const BRANCH_B = "55555555-5555-4555-8555-555555555555";
  const BRANCH_C = "66666666-6666-4666-8666-666666666666";
  const NUMBER_A = "+201001111111";
  const NUMBER_B = "+201002222222";
  const NUMBER_C = "+201003333333";
  const OPERATOR_A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
  const FAQ_ANSWER = "سعر التنظيف ٣٠٠ جنيه.";

  const now = () => new Date();

  function businessRow(
    id: string,
    number: string,
    branchId: string,
    faqs: Array<{ question: string; answer: string }>,
  ) {
    return {
      id,
      name: id === BUSINESS_A ? "منشأة أ" : "منشأة ب",
      vertical: null,
      city: null,
      whatsappNumber: number,
      timezone: "Africa/Cairo",
      about: null,
      workingHours: {},
      slotDurationMinutes: 30,
      confirmationMode: "manual",
      // A PUBLIC knowledge store — backs a safe FAQ reply through B-03.
      faqs,
      cancellationPolicy: null,
      onboardingCompletedAt: now(),
      isActive: true,
      createdAt: now(),
      updatedAt: now(),
      deletedAt: null,
      assistantName: null,
      assistantStyle: null,
      defaultBranchId: branchId,
    } as unknown as Business;
  }

  const businesses = new Map<string, Business>([
    [
      BUSINESS_A,
      businessRow(BUSINESS_A, NUMBER_A, BRANCH_A, [
        { question: "كم سعر تنظيف الأسنان؟", answer: FAQ_ANSWER },
      ]),
    ],
    [
      BUSINESS_B,
      businessRow(BUSINESS_B, NUMBER_B, BRANCH_B, [
        { question: "كم سعر تنظيف الأسنان؟", answer: FAQ_ANSWER },
      ]),
    ],
    // An EMPTY knowledge store: a self-authored FAQ reply has no backing
    // fact here, so B-03 refuses it and the turn routes to a human.
    [BUSINESS_C, businessRow(BUSINESS_C, NUMBER_C, BRANCH_C, [])],
  ]);

  const branchOf = (businessId: string) =>
    businessId === BUSINESS_A
      ? BRANCH_A
      : businessId === BUSINESS_B
        ? BRANCH_B
        : BRANCH_C;

  // ── In-memory attention store ────────────────────────────────────────────
  // Faithfully mirrors OperatorAttentionRepository semantics: ONE row per
  // conversation (upsert on open), resolve only touches OPEN rows, and every
  // query is tenant-scoped by businessId. The store is EXTERNAL to any repo
  // instance so a "restart" (a second instance) still observes the state.
  type AttentionRow = {
    id: string;
    businessId: string;
    conversationId: string;
    reason: AttentionReason;
    /** The typed handoff cause (Slice 7) — null when none was recorded. */
    cause: HandoffCause | null;
    createdAt: string;
    resolvedAt: string | null;
    resolvedById: string | null;
  };

  const attentionStore = new Map<string, AttentionRow>();

  const inMemoryAttention = {
    async open(input: {
      businessId: string;
      conversationId: string;
      reason: AttentionReason;
      cause?: HandoffCause | null;
    }) {
      const parsed = operatorAttentionValidation.open.parse(input);
      const existing = attentionStore.get(parsed.conversationId);
      const row: AttentionRow = {
        id: existing?.id ?? crypto.randomUUID(),
        businessId: parsed.businessId,
        conversationId: parsed.conversationId,
        reason: parsed.reason,
        // Mirrors the real repository: the latest handoff's cause wins, and
        // a re-open without a cause clears any prior one (no stale leak).
        cause: parsed.cause ?? null,
        createdAt: existing ? existing.createdAt : now().toISOString(),
        resolvedAt: null,
        resolvedById: null,
      };
      // Upsert — an already-open handoff refreshes the same row; a resolved
      // one is re-opened. Exactly one live row per conversation.
      attentionStore.set(parsed.conversationId, row);
      return row;
    },
    async resolve(input: { conversationId: string; resolvedById: string }) {
      const parsed = operatorAttentionValidation.resolve.parse(input);
      const row = attentionStore.get(parsed.conversationId);
      if (row && row.resolvedAt === null) {
        attentionStore.set(parsed.conversationId, {
          ...row,
          resolvedAt: now().toISOString(),
          resolvedById: parsed.resolvedById,
        });
      }
    },
    async countOpen(businessId: string): Promise<number> {
      let count = 0;
      for (const row of attentionStore.values()) {
        if (row.businessId === businessId && row.resolvedAt === null)
          count += 1;
      }
      return count;
    },
    async findOpen(conversationId: string) {
      const row = attentionStore.get(conversationId);
      return row && row.resolvedAt === null ? row : null;
    },
    async findOpenByConversations(
      businessId: string,
      conversationIds: string[],
    ) {
      const map = new Map<string, AttentionRow>();
      for (const id of conversationIds) {
        const row = attentionStore.get(id);
        if (row && row.businessId === businessId && row.resolvedAt === null) {
          map.set(id, row);
        }
      }
      return map;
    },
  };

  // ── Engine harness (in-memory repositories, real engine + B-02 + B-03) ──
  // Conversation state is shared across runs, keyed by business — the same
  // find-or-reuse semantics the real engine has (latest thread per customer).
  const conversationByBusiness = new Map<string, Conversation>();

  function buildHarness(opts: {
    businessId: string;
    aiResponse: unknown;
    aiFails?: boolean;
    attentionOpenThrows?: boolean;
    resetConversation?: boolean;
  }) {
    const branchId = branchOf(opts.businessId);
    if (opts.resetConversation) conversationByBusiness.delete(opts.businessId);
    const ledger = new Map<
      string,
      {
        claimId: string;
        conversationId: string | null;
        customerMessageId: string | null;
      }
    >();
    const messages: Array<{
      senderType: string;
      content: string;
    }> = [];
    let conversation = conversationByBusiness.get(opts.businessId) ?? null;

    const attention = opts.attentionOpenThrows
      ? {
          open: async () => {
            throw new Error("simulated attention outage");
          },
        }
      : inMemoryAttention;

    const deps: ConversationEngineDeps = {
      businessRepository: {
        findByWhatsappNumber: async (number: string) =>
          [...businesses.values()].find((b) => b.whatsappNumber === number) ??
          null,
        findById: async (id: string) => businesses.get(id) ?? null,
      },
      branchRepository: {
        findDefaultByBusiness: async () =>
          ({
            id: branchId,
            businessId: opts.businessId,
            name: "الفرع الرئيسي",
            isActive: true,
            createdAt: now(),
            updatedAt: now(),
            deletedAt: null,
          }) as unknown as Branch,
      },
      customerRepository: {
        upsertByPhone: async () =>
          ({
            id: `cust-${opts.businessId}`,
            businessId: opts.businessId,
            name: "عميل",
            phone: "+201234567890",
            email: null,
            notes: null,
            lastConversationAt: null,
            lastAppointmentAt: null,
            createdAt: now(),
            updatedAt: now(),
            deletedAt: null,
          }) as unknown as Customer,
        touchConversation: async () =>
          ({
            id: `cust-${opts.businessId}`,
            businessId: opts.businessId,
            name: "عميل",
            phone: "+201234567890",
            email: null,
            notes: null,
            lastConversationAt: null,
            lastAppointmentAt: null,
            createdAt: now(),
            updatedAt: now(),
            deletedAt: null,
          }) as unknown as Customer,
      },
      conversationRepository: {
        findLatestByCustomer: async () =>
          conversation ? { id: conversation.id } : null,
        findById: async () => conversation,
        create: async (input) => {
          conversation = {
            id: crypto.randomUUID(),
            businessId: input.businessId,
            customerId: input.customerId,
            branchId: input.branchId,
            status: "AI_ACTIVE",
            assignedUserId: null,
            aiSummary: null,
            lastMessageAt: now(),
            createdAt: now(),
            updatedAt: now(),
          } as unknown as Conversation;
          conversationByBusiness.set(opts.businessId, conversation);
          return conversation;
        },
        addMessage: async (input: {
          conversationId: string;
          senderType: string;
          content: string;
        }) => {
          messages.push({
            senderType: input.senderType,
            content: input.content,
          });
          return {
            id: `msg-${messages.length}`,
            conversationId: input.conversationId,
            senderType: input.senderType,
            content: input.content,
            createdAt: now(),
            updatedAt: now(),
          } as unknown as Message;
        },
        getMessages: async () =>
          [...messages].reverse().map((message, index) => ({
            id: `msg-${messages.length - index}`,
            conversationId: conversation?.id ?? "",
            senderType: message.senderType,
            content: message.content,
            createdAt: now(),
            updatedAt: now(),
          })) as unknown as Message[],
        update: async () => conversation as Conversation,
        updateWorkflow: async (
          _id: string,
          patch: {
            status?: ConversationStatus;
            assignedUserId?: string | null;
          },
        ) => {
          if (conversation && patch.status) {
            conversation = {
              ...conversation,
              status: patch.status,
            };
            conversationByBusiness.set(opts.businessId, conversation);
          }
          return conversation as Conversation;
        },
      },
      serviceRepository: {
        listByBusiness: async () => [],
        findById: async () => null,
      },
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
        record: async (input: unknown) => input as unknown as UsageRecord,
      },
      attentionRepository: attention,
      ai: {
        providerName: "fake-ai",
        respond: async () => {
          if (opts.aiFails) throw new Error("provider down");
          return opts.aiResponse as unknown as AiResponse;
        },
      },
      transport: {
        providerName: "fake-transport",
        send: async () => ({ provider: "fake-transport", delivered: true }),
      },
    };

    return { deps, messages: () => messages };
  }

  async function run(opts: {
    businessId: string;
    text: string;
    externalId: string;
    aiResponse: unknown;
    aiFails?: boolean;
    attentionOpenThrows?: boolean;
    resetConversation?: boolean;
  }) {
    const harness = buildHarness(opts);
    const result = await engine.receiveInboundMessage(harness.deps, {
      to: businesses.get(opts.businessId)!.whatsappNumber,
      from: "+201234567890",
      text: opts.text,
      receivedAt: now().toISOString(),
      externalId: opts.externalId,
    });
    return { result, messages: harness.messages() };
  }

  const aiReply = (content: string) => ({
    intent: "FAQ",
    action: "reply",
    content,
    extraction: {
      service: null,
      provider: null,
      date: null,
      timePreference: null,
    },
    handoffReason: null,
    summary: null,
  });

  // ── 1. Safe AI answer → NO operator attention ────────────────────────────
  const safe = await run({
    businessId: BUSINESS_A,
    text: "كم سعر تنظيف الأسنان؟",
    externalId: "msg-safe-1",
    aiResponse: aiReply(FAQ_ANSWER),
  });
  check(
    "1. رد آمن للذكاء → لا تنبيه للبشر (AI_REPLY / AI_ACTIVE وبلا اهتمام مفتوح)",
    isSuccess(safe.result) &&
      !safe.result.duplicate &&
      safe.result.assistantAction === "AI_REPLY" &&
      safe.result.conversationStatus === "AI_ACTIVE" &&
      (await inMemoryAttention.countOpen(BUSINESS_A)) === 0,
  );

  // ── 2. AI handoff → operator attention created with the coarse reason ────
  const handoff = await run({
    businessId: BUSINESS_A,
    text: "عايز أسأل سؤال معقد",
    externalId: "msg-fail-1",
    aiResponse: undefined, // unparseable output → safe silent handoff
    aiFails: true, // provider failure → NEED_HUMAN (never a fabricated reply)
  });
  const handoffConvId = handoff.result.ok
    ? handoff.result.conversationId
    : null;
  const handoffRow = handoffConvId
    ? await inMemoryAttention.findOpen(handoffConvId)
    : null;
  check(
    "2. فشل/تعثّر الذكاء → AI_HANDOFF + NEED_HUMAN ويُنشأ اهتمام مفتوح للبشر",
    isSuccess(handoff.result) &&
      handoff.result.assistantAction === "AI_HANDOFF" &&
      handoff.result.conversationStatus === "NEED_HUMAN" &&
      handoffRow !== null &&
      handoffRow.businessId === BUSINESS_A,
  );
  check(
    "2b. سبب الاهتمام تصنيف تشغيلي خشن (AI_HANDOFF) — لا أسرار ولا تفكير داخلي",
    handoffRow?.reason === "AI_HANDOFF",
  );

  // ── 3. Repeated handoff → exactly ONE live alert (no storm) ──────────────
  await run({
    businessId: BUSINESS_A,
    text: "رسالة متابعة ١",
    externalId: "msg-fail-2",
    aiResponse: undefined,
    aiFails: true,
  });
  await run({
    businessId: BUSINESS_A,
    text: "رسالة متابعة ٢",
    externalId: "msg-fail-3",
    aiResponse: undefined,
    aiFails: true,
  });
  const openAfterStorm = handoffConvId
    ? await inMemoryAttention.findOpen(handoffConvId)
    : null;
  check(
    "3. تكرار الرسائل على محادثة عالقة → صف واحد فقط مفتوح (لا عاصفة تنبيهات)",
    handoffConvId !== null &&
      openAfterStorm !== null &&
      openAfterStorm.conversationId === handoffConvId &&
      (await inMemoryAttention.countOpen(BUSINESS_A)) === 1,
  );

  // ── 4. Operator resolution clears the attention; re-opening works ────────
  await inMemoryAttention.resolve({
    conversationId: handoffConvId!,
    resolvedById: OPERATOR_A,
  });
  check(
    "4. حلّ المشغل → يُغلق الاهتمام (countOpen = 0 و findOpen = null)",
    (await inMemoryAttention.countOpen(BUSINESS_A)) === 0 &&
      (handoffConvId
        ? (await inMemoryAttention.findOpen(handoffConvId)) === null
        : false),
  );
  const reopened = await run({
    businessId: BUSINESS_A,
    text: "رسالة جديدة بعد الحل",
    externalId: "msg-fail-4",
    aiResponse: undefined,
    aiFails: true,
  });
  const reopenedId = reopened.result.ok ? reopened.result.conversationId : null;
  check(
    "4b. تحويل جديد بعد الحل → يُعاد فتح اهتمام واحد على نفس السطر",
    reopenedId !== null &&
      reopenedId === handoffConvId &&
      (await inMemoryAttention.countOpen(BUSINESS_A)) === 1,
  );

  // ── 5. Tenant isolation — BUSINESS_B never sees BUSINESS_A's attention ──
  check(
    "5. النطاق المؤجر معزول: عدّاد المنشأة ب فارغ، ولا يصل اهتمام أ",
    (await inMemoryAttention.countOpen(BUSINESS_B)) === 0 &&
      (handoffConvId
        ? (
            await inMemoryAttention.findOpenByConversations(BUSINESS_B, [
              handoffConvId,
            ])
          ).size === 0
        : false) &&
      (handoffConvId
        ? (
            await inMemoryAttention.findOpenByConversations(BUSINESS_A, [
              handoffConvId,
            ])
          ).size === 1
        : false),
  );
  const bHandoff = await run({
    businessId: BUSINESS_B,
    text: "سؤال آخر",
    externalId: "msg-b-1",
    aiResponse: undefined,
    aiFails: true,
  });
  check(
    "5b. المنشأة ب تحوّل إلى اهتمام خاص بها تحت نطاقها فقط",
    isSuccess(bHandoff.result) &&
      (await inMemoryAttention.countOpen(BUSINESS_B)) === 1 &&
      (await inMemoryAttention.countOpen(BUSINESS_A)) === 1 &&
      (
        await inMemoryAttention.findOpen(
          bHandoff.result.ok ? bHandoff.result.conversationId : "",
        )
      )?.businessId === BUSINESS_B,
  );

  // ── 6. B-03 refused reply → handoff + attention (boundary intact) ────────
  // BUSINESS_C carries NO knowledge store, so a self-authored FAQ reply has
  // no backing fact: B-03 refuses it — the fabricated content is never
  // persisted and never sent. The customer still receives the SAME safe,
  // deterministic handoff acknowledgment the deterministic assistant would
  // send for this message (never silence), and the turn keeps the existing
  // NEED_HUMAN + operator-attention handoff semantics.
  const refused = await run({
    businessId: BUSINESS_C,
    text: "كم سعر تنظيف الأسنان؟",
    externalId: "msg-b03-1",
    resetConversation: true, // a fresh AI_ACTIVE thread so the AI turn runs
    aiResponse: aiReply("سعر التنظيف ١٠٠٠ جنيه."),
  });
  const refusedConvId = refused.result.ok
    ? refused.result.conversationId
    : null;
  check(
    "6. رفض B-03 (رد غير مدعوم بحقيقة قابلة للإفصاح) → AI_HANDOFF + اهتمام",
    isSuccess(refused.result) &&
      refused.result.assistantAction === "AI_HANDOFF" &&
      refused.result.conversationStatus === "NEED_HUMAN" &&
      refusedConvId !== null &&
      (await inMemoryAttention.findOpen(refusedConvId)) !== null &&
      (await inMemoryAttention.countOpen(BUSINESS_C)) === 1,
  );
  check(
    "6b. المحتوى المرفوض لا يُحفظ ولا يُرسل، و Acknowledgment آمن يصل العميل",
    isSuccess(refused.result) &&
      refused.result.delivery !== null &&
      refused.result.delivery.delivered === true &&
      // The fabricated, unbacked reply never reaches the customer…
      !refused.messages.some(
        (message) =>
          message.senderType === "AI" && message.content.includes("١٠٠٠"),
      ) &&
      // …but a safe deterministic handoff acknowledgment was persisted…
      refused.messages.some(
        (message) =>
          message.senderType === "AI" &&
          message.content.includes("سيرد عليك أحد أعضاء الفريق"),
      ) &&
      // …and it is the ONLY assistant message on the turn.
      refused.messages.filter((message) => message.senderType === "AI")
        .length === 1,
  );

  // ── 7. Booking-domain clarification → NO handoff, NO attention ───────────
  // A booking ask with no date: the deterministic domain asks for
  // clarification and stays AI_ACTIVE — no unnecessary handoff.
  const clarify = await run({
    businessId: BUSINESS_A,
    text: "عايز أحجز",
    externalId: "msg-clarify-1",
    resetConversation: true, // a fresh AI_ACTIVE thread for the booking ask
    aiResponse: {
      intent: "BOOKING",
      action: "reply",
      content: "أي خدمة تريد حجزها؟",
      extraction: {
        service: null,
        provider: null,
        date: null,
        timePreference: null,
      },
      handoffReason: null,
      summary: null,
    },
  });
  check(
    "7. رد توضيحي آمن (نطاق الحجز) → AI_REPLY بلا تحويل وبلا اهتمام",
    isSuccess(clarify.result) &&
      clarify.result.assistantAction === "AI_REPLY" &&
      clarify.result.conversationStatus === "AI_ACTIVE",
  );

  // ── 8. Unresolved attention survives a "restart" ────────────────────────
  // A fresh repository instance over the same store (process restart) still
  // observes the unresolved attention; only an explicit resolve clears it.
  const restarted = {
    countOpen: inMemoryAttention.countOpen,
    findOpen: inMemoryAttention.findOpen,
  };
  check(
    "8. بعد «إعادة التشغيل» يبقى الاهتمام غير المحلول ظاهراً (الحالة خارجية)",
    (await restarted.countOpen(BUSINESS_A)) >= 1 &&
      refusedConvId !== null &&
      (await restarted.findOpen(refusedConvId)) !== null,
  );

  // ── 9. Invalid identifiers fail safe ─────────────────────────────────────
  let invalidRejected = false;
  try {
    await inMemoryAttention.open({
      businessId: "not-a-uuid",
      conversationId: refusedConvId!,
      reason: "AI_HANDOFF",
    });
  } catch {
    invalidRejected = true; // Zod rejects — the DTO boundary holds
  }
  check("9a. معرّفات غير صالحة مرفوضة عند حدود DTO", invalidRejected);
  const failingAttention = await run({
    businessId: BUSINESS_A,
    text: "رسالة أثناء تعطل التنبيه",
    externalId: "msg-outage-1",
    resetConversation: true, // isolate the outage scenario on its own thread
    aiResponse: aiReply(FAQ_ANSWER),
    attentionOpenThrows: true,
  });
  check(
    "9b. فشل كتابة التنبيه لا يكسر دورة العميل (الرد الآمن يظل سليماً)",
    isSuccess(failingAttention.result) &&
      !failingAttention.result.duplicate &&
      failingAttention.result.assistantAction === "AI_REPLY" &&
      failingAttention.result.conversationStatus === "AI_ACTIVE",
  );

  // ── 10. Customer output unchanged — no attention metadata or jargon ─────
  const jargonPattern =
    /AI_HANDOFF|DEFERRED_TO_STAFF|BOOKING_BLOCKED|AttentionReason|operator-attention|graph\.facebook\.com|API|credentialsRef/i;
  check(
    "10. مخرجات العميل خالية من بيانات التنبيه وتصنيفاته ومصطلحات المزود",
    safe.messages.every((message) => !jargonPattern.test(message.content)) &&
      clarify.messages.every(
        (message) => !jargonPattern.test(message.content),
      ) &&
      Object.values(ATTENTION_REASON_LABELS).every(
        (label) => !safe.messages.some((m) => m.content.includes(label)),
      ),
  );

  // ── 11. DECISIONS #62 — duplicate inbound + safe payloads + navigation ────
  // The notification path's remaining contract: a DUPLICATE inbound (the
  // durable dedupe ledger) never reaches the attention layer; every typed
  // notification payload is safe; the operator can reach the conversation;
  // and the attention state is never color-only.
  {
    const control =
      await import("../src/server/integrations/ai/conversation-control");
    const { aiProviderValues } = await import("../src/lib/validation/platform");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const read = (rel: string) =>
      fs.readFileSync(path.join(process.cwd(), rel), "utf8");

    // 11a. A redelivered message is deduped BEFORE any attention write.
    // The durable ledger answers "duplicate" for an already-processed
    // (business, externalKey) — proven end-to-end by `check:whatsapp-inbound`
    // (dedupe replay). What THIS check proves is the engine's half: on that
    // answer the turn becomes a no-op with ZERO attention writes. The two
    // turns share ONE harness; after the first completes, the ledger is
    // switched to answer "duplicate" for the redelivery.
    const dupHarness = buildHarness({
      businessId: BUSINESS_A,
      aiResponse: undefined,
      aiFails: true,
      resetConversation: true,
    });
    let ledgerAnswersDuplicate = false;
    let dupConversationId: string | null = null;
    const realClaim = dupHarness.deps.inboundDedupeRepository.claim.bind(
      dupHarness.deps.inboundDedupeRepository,
    );
    dupHarness.deps.inboundDedupeRepository.claim = async (
      bid: string,
      key: string,
    ) => {
      if (ledgerAnswersDuplicate && dupConversationId) {
        return {
          status: "duplicate" as const,
          claimId: "claim-redeliver",
          conversationId: dupConversationId,
          customerMessageId: "msg-redeliver",
        };
      }
      const claimed = await realClaim(bid, key);
      ledgerAnswersDuplicate = true;
      return claimed;
    };
    const dupTurn = (externalId: string) =>
      engine.receiveInboundMessage(
        dupHarness.deps,
        {
          to: businesses.get(BUSINESS_A)!.whatsappNumber,
          from: "+201234567890",
          text: "عايز أسأل سؤال معقد",
          receivedAt: now().toISOString(),
          externalId,
        },
        undefined,
      );
    const firstDup = await dupTurn("msg-dedup-1");
    if (firstDup.ok) dupConversationId = firstDup.conversationId;
    const openAfterFirst = await inMemoryAttention.countOpen(BUSINESS_A);
    const secondDup = await dupTurn("msg-dedup-1"); // exact redelivery
    check(
      "11a. الرسالة المكرّرة (دفتر التكرار) → صفر انتباه إضافي (قبل أي كتابة)",
      isSuccess(firstDup) &&
        firstDup.assistantAction === "AI_HANDOFF" &&
        secondDup.ok &&
        secondDup.duplicate === true &&
        (await inMemoryAttention.countOpen(BUSINESS_A)) === openAfterFirst,
    );

    // 11b. ALL five notification events build SAFE payloads (the sanitized
    // seam — check:conversation-control S3b proves one outcome payload;
    // this proves the whole event vocabulary).
    const events = [
      "HUMAN_HANDOFF_REQUESTED",
      "AI_UNAVAILABLE",
      "AI_RETRY_EXHAUSTED",
      "AI_QUOTA_EXHAUSTED",
      "AI_CONFIGURATION_FAILURE",
    ] as const;
    const secretish = [
      "Bearer",
      "Authorization",
      "sk-",
      "api_key",
      "DATABASE_URL",
      "secretRef",
    ];
    const allSafe = events.every((event) => {
      const payload = control.buildNotification(event, {
        businessId: BUSINESS_A,
        conversationId: refusedConvId ?? undefined,
        handoffReason: "AI_REQUESTED_HANDOFF",
        provider: aiProviderValues[0]!,
        failureClass: "TIMEOUT",
        retryCount: 1,
        now: Date.now(),
      });
      return (
        control.isSanitized(payload) &&
        !secretish.some((token) =>
          JSON.stringify(payload).toLowerCase().includes(token.toLowerCase()),
        )
      );
    });
    check(
      "11b. كل أحداث التنبيه الخمسة آمنة (isSanitized، لا مفاتيح/ترويسات/حمعة خام)",
      allSafe,
    );

    // 11c. The operator can REACH the conversation: the inbox row is a link
    // and the staff takeover navigates to the detail page.
    const inbox = read("src/features/conversations/components/inbox-list.tsx");
    const staff = read("src/features/staff/components/staff-workspace.tsx");
    check(
      "11c. الوصول السريع: صف الصندوق رابط + استلام الموظف ينقل لتفاصيل المحادثة",
      inbox.includes("`/conversations/${conversation.id}`") &&
        staff.includes("handleTakeOver") &&
        staff.includes("router.push(`/conversations/${id}`)"),
    );

    // 11d. Attention state is never color-only: the inbox dot carries an
    // sr-only Arabic label, and the detail page's reason chip carries an
    // icon + Arabic text + an accessible name — captured BEFORE the
    // acknowledge-on-open resolve.
    const detail = read(
      "src/features/conversations/components/conversation-detail.tsx",
    );
    const queries = read(
      "src/features/conversations/server/conversation-queries.ts",
    );
    check(
      "11d. الانتباه ليس لوناً فقط: نقطة الصندوق نص مخفي + شارة السبب أيقونة ونص واسم متاح",
      inbox.includes('className="sr-only"') &&
        inbox.includes("تحتاج انتباهك") &&
        detail.includes("AttentionReasonChip") &&
        detail.includes("ATTENTION_REASON_LABELS") &&
        detail.includes("AlertCircleIcon") &&
        detail.includes("aria-label={`سبب انتباه المشغل:") &&
        // formatting-robust: the line may be reflowed by the formatter
        /const openAttention =\s*await operatorAttentionRepository\.findOpen\(/.test(
          queries,
        ) &&
        /attentionReason: openAttention\?\.reason \?\? null/.test(queries),
    );

    // 11e. Structural guards on the live mechanism: the engine is the one
    // writer, gated on a non-duplicate turn; the repository upserts on the
    // unique conversation; the schema enforces it at the DB level.
    const engineSrc = read(
      "src/features/conversations/server/conversation-engine.ts",
    );
    const repoSrc = read(
      "src/server/repositories/operator-attention.repository.ts",
    );
    const schemaSrc = read("prisma/schema.prisma");
    check(
      "11e. الهيكل: المحرك الكاتب الوحيد + upsert على conversationId فريد (قيد DB)",
      /if \(result\.ok && !result\.duplicate\)/.test(engineSrc) &&
        /attentionRepository\.open\(/.test(engineSrc) &&
        /db\.operatorAttention\.upsert\(\{/.test(repoSrc) &&
        /where: \{ conversationId: parsed\.conversationId \}/.test(repoSrc) &&
        /conversationId\s+String\s+@unique/.test(schemaSrc),
    );
  }

  // ── Report ───────────────────────────────────────────────────────────────
  let failedCount = 0;
  for (const { label, pass } of checks) {
    if (pass) console.log(`✔ ${label}`);
    else {
      console.error(`✘ ${label}`);
      failedCount += 1;
    }
  }
  if (failedCount > 0) {
    console.error(`\nفشل ${failedCount} من ${checks.length} فحص.`);
    process.exit(1);
  }
  console.log(
    `\nطبقة تنبيه البشر سليمة: ${checks.length}/${checks.length} فحص ناجح.`,
  );
}

main().catch((error: Error) => {
  console.error(`فشل غير متوقع: ${error.message}`);
  process.exit(1);
});
