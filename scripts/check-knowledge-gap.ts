/**
 * FlowPilot — KNOWLEDGE-GAP check (PROMPT-AI-ARCH-18 — Slice 9).
 *
 * Offline, in-memory verification of the RECORD-ONLY, off-critical-path
 * knowledge-gap lifecycle. It runs the REAL conversation engine with the REAL
 * B-02 context builder and the REAL B-03 disclosure gate; only the
 * repositories are in-memory fakes, so the whole
 * `KNOWLEDGE_GAP_UNRESOLVED → record → human review` seam is exercised
 * end-to-end WITHOUT a DB, network, LLM, API token, or secret.
 *
 * What it proves:
 *   1.  a genuine knowledge gap creates exactly ONE bounded record;
 *   2.  an ordinary safe answer creates NO record;
 *   3.  a provider failure / AI failure creates NO false gap;
 *   4.  a safety handoff creates NO false gap;
 *   5.  a customer-requested handoff stays customer-requested;
 *   6.  a booking turn is byte-for-byte unaffected;
 *   7.  a price gap is recorded as evidence and NEVER fabricates a price;
 *   8.  duplicate recording is deterministic (one row per turn);
 *   9.  records are strictly tenant-scoped (cross-tenant exclusion);
 *  10.  a recording failure never modifies the turn outcome;
 *  11.  the zero-or-one model-call invariant holds;
 *  12.  the one-send invariant holds;
 *  13.  no second resolver / state / planner / classifier / inference /
 *       knowledge store / promotion path is introduced.
 *
 * Run: pnpm check:knowledge-gap
 */

import { readFileSync } from "node:fs";

import type { AiResponse } from "../src/features/conversations/server/ai-contract";
import type {
  ConversationEngineDeps,
  InboundResult,
  InboundSuccess,
} from "../src/features/conversations/server/conversation-engine";
import type {
  KnowledgeGapCategory,
  KnowledgeGapStatus,
  ListKnowledgeGapsDto,
  RecordKnowledgeGapDto,
  ReviewKnowledgeGapDto,
} from "../src/lib/validation";
import type { OpenAttention } from "../src/server/repositories/operator-attention.repository";
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
const read = (path: string) => readFileSync(path, "utf8");

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
  const recorder =
    await import("../src/features/conversations/server/knowledge-gap");
  const { knowledgeGapValidation } = await import("../src/lib/validation");

  const checks: Check[] = [];
  function check(label: string, pass: boolean): void {
    checks.push({ label, pass });
  }
  const now = () => new Date();

  // ── Deterministic fixtures ───────────────────────────────────────────────
  const BUSINESS_A = "11111111-1111-4111-8111-111111111111";
  const BUSINESS_B = "22222222-2222-4222-8222-222222222222";
  const BRANCH_A = "44444444-4444-4444-8444-444444444444";
  const BRANCH_B = "55555555-5555-4555-8555-555555555555";
  const NUMBER_A = "+201001111111";
  const NUMBER_B = "+201002222222";
  const OPERATOR_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";

  const emptyExtraction = {
    service: null,
    provider: null,
    date: null,
    timePreference: null,
  };

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
        { question: "إيه مواعيد العمل؟", answer: "من ٩ صباحاً إلى ٩ مساءً." },
      ]),
    ],
    // An EMPTY knowledge store — a question here is a GENUINE gap.
    [BUSINESS_B, businessRow(BUSINESS_B, NUMBER_B, BRANCH_B, [])],
  ]);
  const branchOf = (businessId: string) =>
    businessId === BUSINESS_A ? BRANCH_A : BRANCH_B;

  // ── In-memory knowledge-gap store (mirrors the real repository) ──────────
  type GapRow = {
    id: string;
    businessId: string;
    conversationId: string;
    customerMessageId: string;
    category: KnowledgeGapCategory;
    subjectText: string | null;
    status: KnowledgeGapStatus;
    createdAt: string;
    reviewedAt: string | null;
    seq: number;
  };

  function createGapStore() {
    const rows = new Map<string, GapRow>();
    let seq = 0;
    let recordCalls = 0;
    const key = (c: string, m: string) => `${c}|${m}`;

    function record(input: RecordKnowledgeGapDto): GapRow {
      recordCalls += 1;
      const parsed = knowledgeGapValidation.record.parse(input);
      const k = key(parsed.conversationId, parsed.customerMessageId);
      const existing = rows.get(k);
      // Upsert semantics: a replay of the SAME turn is a no-op.
      if (existing) return existing;
      seq += 1;
      const row: GapRow = {
        id: crypto.randomUUID(),
        businessId: parsed.businessId,
        conversationId: parsed.conversationId,
        customerMessageId: parsed.customerMessageId,
        category: parsed.category,
        subjectText: parsed.subjectText ?? null,
        status: "UNRESOLVED",
        createdAt: new Date(2026, 0, 1, 0, 0, seq).toISOString(),
        reviewedAt: null,
        seq,
      };
      rows.set(k, row);
      return row;
    }

    function list(input: ListKnowledgeGapsDto): GapRow[] {
      const parsed = knowledgeGapValidation.list.parse(input);
      return [...rows.values()]
        .filter(
          (row) =>
            row.businessId === parsed.businessId &&
            (parsed.status ? row.status === parsed.status : true) &&
            (parsed.category ? row.category === parsed.category : true),
        )
        .sort((a, b) => b.seq - a.seq)
        .slice(0, parsed.limit);
    }

    async function countUnresolved(businessId: string): Promise<number> {
      return [...rows.values()].filter(
        (row) => row.businessId === businessId && row.status === "UNRESOLVED",
      ).length;
    }

    function review(
      input: ReviewKnowledgeGapDto,
      status: "REVIEWED" | "REJECTED",
    ): void {
      const parsed = knowledgeGapValidation.review.parse(input);
      const entry = [...rows.entries()].find(([, row]) => row.id === parsed.id);
      if (!entry) return;
      const [k, row] = entry;
      if (row.businessId !== parsed.businessId) return; // tenant guard
      if (row.status !== "UNRESOLVED") return; // terminal
      rows.set(k, {
        ...row,
        status,
        reviewedAt: new Date(2026, 0, 2).toISOString(),
      });
    }

    return {
      record,
      list,
      countUnresolved,
      markReviewed: (input: ReviewKnowledgeGapDto) => review(input, "REVIEWED"),
      markRejected: (input: ReviewKnowledgeGapDto) => review(input, "REJECTED"),
      rows: () => [...rows.values()],
      recordCalls: () => recordCalls,
    };
  }
  // ── Engine harness (in-memory repositories, real engine + B-02 + B-03) ──
  function buildHarness(opts: {
    businessId: string;
    aiResponse?: unknown;
    aiFails?: boolean;
    recorder?: "ok" | "throw" | "none";
  }) {
    const branchId = branchOf(opts.businessId);
    const store = createGapStore();
    let conversation: Conversation | null = null;
    const messages: Array<{ senderType: string; content: string }> = [];
    const ledger = new Map<
      string,
      {
        claimId: string;
        conversationId: string | null;
        customerMessageId: string | null;
      }
    >();
    let aiCalls = 0;
    let sends = 0;

    const knowledgeGapRepository =
      opts.recorder === "throw"
        ? {
            record: async (): Promise<never> => {
              throw new Error("simulated knowledge-gap store outage");
            },
          }
        : opts.recorder === "none"
          ? undefined
          : { record: async (dto: RecordKnowledgeGapDto) => store.record(dto) };

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
          return conversation;
        },
        addMessage: async (
          input: {
            conversationId: string;
            senderType: string;
            content: string;
          },
          _patch?: unknown,
          opts?: { claimId?: string },
        ) => {
          messages.push({
            senderType: input.senderType,
            content: input.content,
          });
          const id = crypto.randomUUID();
          // Mirror the real claim-coupled write: the customer-message id is
          // recorded on the SAME claim so a redelivery is an idempotent
          // duplicate (never a second turn/record).
          if (opts?.claimId) {
            for (const [k, v] of ledger.entries()) {
              if (v.claimId === opts.claimId) {
                ledger.set(k, {
                  ...v,
                  conversationId: input.conversationId,
                  customerMessageId: id,
                });
              }
            }
          }
          return {
            id,
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
            conversation = { ...conversation, status: patch.status };
          }
          return conversation as Conversation;
        },
      },
      serviceRepository: {
        listByBusiness: async () => [],
        findById: async () => null,
      },
      inboundDedupeRepository: {
        claim: async (bid: string, externalKey: string) => {
          const k = `${bid}|${externalKey}`;
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
      attentionRepository: {
        open: async () => ({}) as unknown as OpenAttention,
      },
      ...(knowledgeGapRepository ? { knowledgeGapRepository } : {}),
      ai: {
        providerName: "fake-ai",
        respond: async () => {
          aiCalls += 1;
          if (opts.aiFails) throw new Error("provider down");
          return opts.aiResponse as unknown as AiResponse;
        },
      },
      transport: {
        providerName: "fake-transport",
        send: async () => {
          sends += 1;
          return { provider: "fake-transport", delivered: true };
        },
      },
    };

    return {
      deps,
      store,
      businessId: opts.businessId,
      aiCalls: () => aiCalls,
      sends: () => sends,
      messages: () => messages,
    };
  }

  type Harness = ReturnType<typeof buildHarness>;
  async function run(
    harness: Harness,
    input: { text: string; externalId: string },
  ): Promise<InboundResult> {
    return engine.receiveInboundMessage(harness.deps, {
      to: businesses.get(harness.businessId)!.whatsappNumber,
      from: "+201234567890",
      text: input.text,
      receivedAt: now().toISOString(),
      externalId: input.externalId,
    });
  }

  const aiReply = (content: string, intent = "FAQ") => ({
    intent,
    action: "reply",
    content,
    extraction: emptyExtraction,
    handoffReason: null,
    summary: null,
  });
  const aiGapHandoff = (content: string, intent = "FAQ") => ({
    intent,
    action: "handoff",
    content,
    extraction: emptyExtraction,
    handoffReason: "NO_KNOWLEDGE",
    summary: null,
  });

  // ── 1. A genuine knowledge gap creates exactly ONE record ────────────────
  const gapHarness = buildHarness({
    businessId: BUSINESS_B,
    aiResponse: aiGapHandoff("سأوصل سؤالك لفريق العيادة."),
  });
  const gap = await run(gapHarness, {
    text: "كم سعر الكشف؟",
    externalId: "gap-1",
  });
  const gapRow = gapHarness.store.rows()[0];
  check(
    "1. فجوة معرفية حقيقية → NEED_HUMAN + سجل واحد مقيد (UNRESOLVED)",
    isSuccess(gap) &&
      gap.assistantAction === "AI_HANDOFF" &&
      gap.conversationStatus === "NEED_HUMAN" &&
      gap.handoffCause === "KNOWLEDGE_GAP_UNRESOLVED" &&
      gap.knowledgeGap !== undefined &&
      gap.knowledgeGap !== null &&
      gap.knowledgeGap.category === "SERVICE_PRICE",
  );
  check(
    "1b. السجل مربوط بالمنشأة والمحادثة ورسالة العميل، وحالته UNRESOLVED",
    gapRow !== undefined &&
      gapRow.businessId === BUSINESS_B &&
      gapRow.conversationId === (isSuccess(gap) ? gap.conversationId : "") &&
      gapRow.customerMessageId ===
        (isSuccess(gap) ? gap.customerMessageId : "") &&
      gapRow.status === "UNRESOLVED" &&
      gapRow.category === "SERVICE_PRICE" &&
      gapHarness.store.recordCalls() === 1,
  );

  // ── 2. An ordinary safe answer creates NO record ─────────────────────────
  const replyHarness = buildHarness({
    businessId: BUSINESS_A,
    aiResponse: aiReply("مواعيد العمل من ٩ صباحاً إلى ٩ مساءً."),
  });
  const reply = await run(replyHarness, {
    text: "إيه مواعيد العمل؟",
    externalId: "reply-1",
  });
  check(
    "2. رد آمن عادي → AI_REPLY / AI_ACTIVE ولا سجل فجوة (0 محاولات تسجيل)",
    isSuccess(reply) &&
      reply.assistantAction === "AI_REPLY" &&
      reply.conversationStatus === "AI_ACTIVE" &&
      reply.handoffCause === null &&
      reply.knowledgeGap === undefined &&
      replyHarness.store.recordCalls() === 0 &&
      (await replyHarness.store.countUnresolved(BUSINESS_A)) === 0,
  );

  // ── 3. Provider / AI failure creates NO false gap ────────────────────────
  const failHarness = buildHarness({
    businessId: BUSINESS_B,
    aiFails: true,
  });
  const failure = await run(failHarness, {
    text: "عايز أسأل سؤال معقد",
    externalId: "fail-1",
  });
  check(
    "3. فشل المزوّد/الذكاء → لا فجوة معرفية كاذبة (السبب ليس KNOWLEDGE_GAP)",
    isSuccess(failure) &&
      failure.conversationStatus === "NEED_HUMAN" &&
      failure.handoffCause !== "KNOWLEDGE_GAP_UNRESOLVED" &&
      failure.knowledgeGap === undefined &&
      failHarness.store.recordCalls() === 0,
  );

  // ── 4. Safety handoff creates NO false gap ───────────────────────────────
  const safetyHarness = buildHarness({
    businessId: BUSINESS_B,
    aiResponse: aiReply("هذا عرض توضيحي."),
  });
  const safety = await run(safetyHarness, {
    text: "عندي ألم شديد",
    externalId: "safe-1",
  });
  check(
    "4. تحويل سلامة/حساس → SENSITIVE_OR_RESTRICTED بلا فجوة كاذبة",
    isSuccess(safety) &&
      safety.conversationStatus === "NEED_HUMAN" &&
      safety.handoffCause === "SENSITIVE_OR_RESTRICTED" &&
      safety.knowledgeGap === undefined &&
      safetyHarness.store.recordCalls() === 0,
  );

  // ── 5. Customer-requested handoff stays customer-requested ───────────────
  const humanHarness = buildHarness({
    businessId: BUSINESS_B,
    aiResponse: aiReply("تمام."),
  });
  const human = await run(humanHarness, {
    text: "عايز حد يكلمني",
    externalId: "human-1",
  });
  check(
    "5. طلب بشري صريح يبقى CUSTOMER_REQUESTED_HUMAN بلا فجوة",
    isSuccess(human) &&
      human.conversationStatus === "NEED_HUMAN" &&
      human.handoffCause === "CUSTOMER_REQUESTED_HUMAN" &&
      human.knowledgeGap === undefined &&
      humanHarness.store.recordCalls() === 0,
  );

  // ── 6. A booking turn is unaffected (clarify, no handoff, no gap) ────────
  const bookingResponse = aiReply("تمام، تحب تحجز إمتى؟", "BOOKING");
  const bookingWith = buildHarness({
    businessId: BUSINESS_B,
    aiResponse: bookingResponse,
  });
  const bookingWithout = buildHarness({
    businessId: BUSINESS_B,
    aiResponse: bookingResponse,
    recorder: "none",
  });
  const bookingA = await run(bookingWith, {
    text: "عايز أحجز",
    externalId: "book-1",
  });
  const bookingB = await run(bookingWithout, {
    text: "عايز أحجز",
    externalId: "book-1",
  });
  check(
    "6. حجز بلا فجوة → لا سجل، والنتيجة مطابقة تماماً بوجود/غياب المسجّل",
    isSuccess(bookingA) &&
      isSuccess(bookingB) &&
      bookingA.assistantAction === "AI_REPLY" &&
      bookingA.conversationStatus === "AI_ACTIVE" &&
      bookingA.knowledgeGap === undefined &&
      bookingA.assistantAction === bookingB.assistantAction &&
      bookingA.conversationStatus === bookingB.conversationStatus &&
      bookingA.intent === bookingB.intent &&
      bookingA.handoffCause === bookingB.handoffCause &&
      bookingWith.store.recordCalls() === 0,
  );

  // ── 7. A price gap is evidence only — NEVER a fabricated price ───────────
  const priceRow = gapHarness.store.rows()[0];
  const serializedGap = JSON.stringify(priceRow);
  const fabricatesPrice = /[0-9٠-٩]+\s*(جنيه|جنية|ج\.م|EGP)/.test(
    serializedGap,
  );
  check(
    "7. فجوة السعر تُسجّل كدليل (SERVICE_PRICE) ولا تختلق سعراً",
    priceRow !== undefined &&
      priceRow.category === "SERVICE_PRICE" &&
      priceRow.subjectText === "كم سعر الكشف؟" &&
      !fabricatesPrice &&
      !("price" in (priceRow as unknown as Record<string, unknown>)) &&
      !("answer" in (priceRow as unknown as Record<string, unknown>)),
  );

  // ── 8. Duplicate recording is deterministic (one row per turn) ───────────
  const duplicate = await run(gapHarness, {
    text: "كم سعر الكشف؟",
    externalId: "gap-1",
  });
  const stillOne = gapHarness.store.rows().length === 1;
  const replay = gapHarness.store.record(
    knowledgeGapValidation.record.parse({
      businessId: BUSINESS_B,
      conversationId: gapRow!.conversationId,
      customerMessageId: gapRow!.customerMessageId,
      category: gapRow!.category,
      subjectText: gapRow!.subjectText,
    }),
  );
  check(
    "8. تكرار نفس الدورة/التسجيل → صف واحد فقط بنفس المعرّف (بلا تكرار)",
    duplicate.ok &&
      duplicate.duplicate === true &&
      stillOne &&
      gapHarness.store.rows().length === 1 &&
      replay.id === gapRow!.id,
  );

  // ── 9. Tenant isolation (cross-tenant exclusion) ─────────────────────────
  const listA = await gapHarness.store.list({
    businessId: BUSINESS_B,
    limit: 20,
  });
  const listOther = await gapHarness.store.list({
    businessId: BUSINESS_A,
    limit: 20,
  });
  await gapHarness.store.markReviewed({
    id: gapRow!.id,
    businessId: BUSINESS_A, // wrong tenant — must be a no-op
    reviewedById: OPERATOR_B,
  });
  const afterCrossTenantReview = gapHarness.store.rows()[0]!;
  check(
    "9. عزل المستأجرين: A لا ترى فجوات B، ومراجعة عبر مستأجر خاطئ لا تؤثر",
    listA.length === 1 &&
      listOther.length === 0 &&
      (await gapHarness.store.countUnresolved(BUSINESS_A)) === 0 &&
      afterCrossTenantReview.status === "UNRESOLVED",
  );
  await gapHarness.store.markReviewed({
    id: gapRow!.id,
    businessId: BUSINESS_B,
    reviewedById: OPERATOR_B,
  });
  check(
    "9b. مراجعة صحيحة (نفس المستأجر) → REVIEWED ولا ترقية للمعرفة",
    gapHarness.store.rows()[0]!.status === "REVIEWED" &&
      gapHarness.store.rows()[0]!.reviewedAt !== null &&
      gapHarness.store.rows().length === 1,
  );

  // ── 10. A recording failure never modifies the turn outcome ──────────────
  const failRecorder = buildHarness({
    businessId: BUSINESS_B,
    aiResponse: aiGapHandoff("سأوصل سؤالك لفريق العيادة."),
    recorder: "throw",
  });
  const gapNoRecorder = buildHarness({
    businessId: BUSINESS_B,
    aiResponse: aiGapHandoff("سأوصل سؤالك لفريق العيادة."),
    recorder: "none",
  });
  const thrown = await run(failRecorder, {
    text: "كم سعر الكشف؟",
    externalId: "gap-fail-1",
  });
  const noRecorder = await run(gapNoRecorder, {
    text: "كم سعر الكشف؟",
    externalId: "gap-fail-1",
  });
  check(
    "10. فشل التسجيل لا يغيّر نتيجة الدورة (نفس الحالة/السبب/التسليم، بلا سجل)",
    isSuccess(thrown) &&
      isSuccess(noRecorder) &&
      thrown.assistantAction === noRecorder.assistantAction &&
      thrown.conversationStatus === noRecorder.conversationStatus &&
      thrown.intent === noRecorder.intent &&
      thrown.handoffCause === noRecorder.handoffCause &&
      JSON.stringify(thrown.delivery) === JSON.stringify(noRecorder.delivery) &&
      thrown.knowledgeGap === undefined &&
      failRecorder.sends() === 1 &&
      failRecorder.aiCalls() === 1,
  );

  // ── 11. Zero-or-one model-call invariant ─────────────────────────────────
  const greetingHarness = buildHarness({
    businessId: BUSINESS_B,
    aiResponse: undefined,
  });
  const greeting = await run(greetingHarness, {
    text: "السلام عليكم",
    externalId: "greet-1",
  });
  check(
    "11. صفر أو استدعاء واحد: تحية=0، فجوة معرفية=1، والمسجّل لا يستدعي النموذج",
    greetingHarness.aiCalls() === 0 &&
      gapHarness.aiCalls() === 1 &&
      isSuccess(greeting) &&
      greeting.assistantAction === "AI_REPLY",
  );

  // ── 12. One-send invariant ───────────────────────────────────────────────
  check(
    "12. إرسال واحد لكل دورة (لا إرسال ثانٍ بسبب التسجيل)",
    gapHarness.sends() === 1 &&
      replyHarness.sends() === 1 &&
      bookingWith.sends() === 1 &&
      failRecorder.sends() === 1,
  );

  // ── 13. Pure recorder unit checks ────────────────────────────────────────
  check(
    "13. المسجّل نقي: لا سجل بغير سبب KNOWLEDGE_GAP_UNRESOLVED",
    recorder.deriveKnowledgeGapObservation({
      turn: {
        businessId: BUSINESS_A,
        conversationId: "c",
        customerMessageId: "m",
        intent: "FAQ",
        handoffCause: "PROVIDER_FAILURE",
      },
      messageText: "أي شيء",
    }) === null &&
      recorder.deriveKnowledgeGapObservation({
        turn: {
          businessId: BUSINESS_A,
          conversationId: "c",
          customerMessageId: "m",
          intent: "FAQ",
          handoffCause: "POLICY_REFUSED",
        },
        messageText: "أي شيء",
      }) === null,
  );
  check(
    "13b. تصنيف الفئة حتمي: سعر/عن المنشأة/وصف الخدمة/متاح/عام",
    recorder.deriveKnowledgeGapCategory("FAQ", {
      bookingOrAvailability: false,
      cancellationOrReschedule: false,
      providerChoice: false,
      contactOrIdentity: false,
      priceOrFee: true,
      businessInfo: false,
      serviceInfo: false,
      serviceCatalog: false,
    }) === "SERVICE_PRICE" &&
      recorder.deriveKnowledgeGapCategory("FAQ", {
        bookingOrAvailability: false,
        cancellationOrReschedule: false,
        providerChoice: false,
        contactOrIdentity: false,
        priceOrFee: false,
        businessInfo: true,
        serviceInfo: false,
        serviceCatalog: false,
      }) === "BUSINESS_INFO" &&
      recorder.deriveKnowledgeGapCategory("FAQ", {
        bookingOrAvailability: false,
        cancellationOrReschedule: false,
        providerChoice: false,
        contactOrIdentity: false,
        priceOrFee: false,
        businessInfo: false,
        serviceInfo: true,
        serviceCatalog: false,
      }) === "SERVICE_INFO" &&
      recorder.deriveKnowledgeGapCategory("AVAILABILITY", null) ===
        "AVAILABILITY" &&
      recorder.deriveKnowledgeGapCategory("GREETING", null) === "GENERAL",
  );
  check(
    "13c. نص الموضوع مقيد (≤200) ولا يحمل تفكيراً داخلياً",
    (() => {
      const long = "ا".repeat(500);
      const dto = recorder.deriveKnowledgeGapObservation({
        turn: {
          businessId: BUSINESS_A,
          conversationId: "c",
          customerMessageId: "m",
          intent: "FAQ",
          handoffCause: "KNOWLEDGE_GAP_UNRESOLVED",
        },
        messageText: long,
      });
      return (
        dto !== null &&
        typeof dto.subjectText === "string" &&
        dto.subjectText.length === recorder.KNOWLEDGE_GAP_SUBJECT_MAX_LENGTH
      );
    })(),
  );

  // ── Structural guards (the real files, not the fakes) ────────────────────
  {
    const engineSrc = read(
      "src/features/conversations/server/conversation-engine.ts",
    );
    const recorderSrc = read(
      "src/features/conversations/server/knowledge-gap.ts",
    );
    const repoSrc = read("src/server/repositories/knowledge-gap.repository.ts");
    const schemaSrc = read("prisma/schema.prisma");
    const validationSrc = read("src/lib/validation/knowledge-gap.ts");
    const migrationSrc = read(
      "prisma/migrations/20261002140000_knowledge_gap/migration.sql",
    );

    // 13d. One engine, one resolver/state/planner/classifier — unchanged.
    const countOccurrences = (haystack: string, needle: string) =>
      haystack.split(needle).length - 1;
    check(
      "13d. لا محلل ثانٍ/مخطّط ثانٍ/محرك ثانٍ: عنصر واحد لكل حد قائم",
      countOccurrences(engineSrc, "resolveTurnPlan(") === 1 &&
        countOccurrences(engineSrc, "mergeConversationState(") === 2 &&
        countOccurrences(engineSrc, "buildAiContext(") === 1 &&
        countOccurrences(engineSrc, "bypassDeterministicAi(") === 1 &&
        !engineSrc.includes("knowledgeGapClassifier") &&
        !engineSrc.includes("secondResolver"),
    );

    // 13e. The recorder is pure: no DB/provider/env/network, reuses the
    // EXISTING deterministic relevance seam (no new classifier).
    check(
      "13e. المسجّل نقي ويعيد استخدام سياق المهمة القائم (لا مصنّف جديد)",
      recorderSrc.includes("deriveTaskRelevance") &&
        !/from "@\/server\//.test(recorderSrc) &&
        !/from "@\/generated\/prisma/.test(recorderSrc) &&
        !recorderSrc.includes("db.") &&
        !recorderSrc.includes("process.env") &&
        !recorderSrc.includes("fetch("),
    );

    // 13f. The record cannot promote knowledge: no FAQ/business/service/
    // price/prompt write path exists anywhere in the repository.
    check(
      "13f. لا مسار ترقية للمعرفة: لا كتابة FAQ/منشأة/خدمة/سعر/موجّه",
      !repoSrc.includes("db.business.update") &&
        !repoSrc.includes("db.service.update") &&
        !repoSrc.includes("formatServicePrice") &&
        !/async\s+(promote|approve|publish)\b/i.test(repoSrc) &&
        repoSrc.includes("db.knowledgeGap.upsert(") &&
        repoSrc.includes('status: "UNRESOLVED"'),
    );

    // 13g. Tenant isolation is structural.
    check(
      "13g. العزل بنيوي: الاسترجاع والتحديث مفلتران بـ businessId دائماً",
      /businessId: parsed\.businessId/.test(repoSrc) &&
        /where:\s*\{[\s\S]*id: parsed\.id,[\s\S]*businessId: parsed\.businessId,[\s\S]*status: "UNRESOLVED"/.test(
          repoSrc,
        ) &&
        schemaSrc.includes("@@index([businessId, status])") &&
        schemaSrc.includes("@@index([businessId, category, createdAt])"),
    );

    // 13h. The schema is additive + append-oriented + has no promotion state.
    check(
      "13h. المخطط إضافي: جدول knowledge_gaps فريد لكل دورة بلا حالة ترقية",
      schemaSrc.includes("model KnowledgeGap") &&
        schemaSrc.includes('@@map("knowledge_gaps")') &&
        schemaSrc.includes("@@unique([conversationId, customerMessageId])") &&
        !schemaSrc.includes('"APPROVED"') &&
        !schemaSrc.includes('"PROMOTED"') &&
        !schemaSrc.includes("promoted_at") &&
        migrationSrc.includes('CREATE TABLE "knowledge_gaps"') &&
        !/ALTER TABLE "(businesses|conversations|services|users)"/.test(
          migrationSrc,
        ),
    );

    // 13i. The lifecycle is exactly UNRESOLVED → REVIEWED / REJECTED.
    check(
      "13i. دورة الحياة: UNRESOLVED → REVIEWED/REJECTED فقط (لا APPROVED)",
      validationSrc.includes('"UNRESOLVED"') &&
        validationSrc.includes('"REVIEWED"') &&
        validationSrc.includes('"REJECTED"') &&
        !validationSrc.includes('"APPROVED"') &&
        !validationSrc.includes('"PROMOTED"'),
    );

    // 13j. The recording call is strictly post-turn and best-effort.
    const recFnStart = engineSrc.indexOf(
      "async function recordKnowledgeGapOffPath",
    );
    const recFnEnd = engineSrc.indexOf(
      "export async function receiveInboundMessage",
    );
    const recorderFn = engineSrc.slice(recFnStart, recFnEnd);
    check(
      "13j. التسجيل بعد الدورة: داخل if (ok && !duplicate) وبعد أنبوب الاهتمام",
      engineSrc.indexOf("recordKnowledgeGapOffPath(deps, result, input)") >
        engineSrc.indexOf("attentionRepository.open(") &&
        recorderFn.includes("catch") &&
        recorderFn.includes("return null"),
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
    `\nدورة حياة الفجوة المعرفية (تسجيل فقط، خارج المسار الحرج) سليمة: ${checks.length}/${checks.length}.`,
  );
}

main().catch((error: Error) => {
  console.error(`فشل غير متوقع: ${error.message}`);
  process.exit(1);
});
