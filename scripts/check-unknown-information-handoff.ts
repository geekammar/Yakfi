/* eslint-disable @typescript-eslint/no-explicit-any */
import "./setup-test-env";

import {
  parseAiResponse,
  type AiResponse,
} from "../src/features/conversations/server/ai-contract";
import {
  buildBusinessAboutContent,
  buildBusinessAddressContent,
  buildBusinessIdentityContent,
  buildServiceDescriptionContent,
} from "../src/features/conversations/server/ai-disclosure";
import {
  SAFE_HANDOFF_REPLIES,
  resolveHandoffActionReply,
} from "../src/features/conversations/server/conversation-ai";
import { receiveInboundMessage } from "../src/features/conversations/server/conversation-engine";

type Check = { label: string; pass: boolean; details?: unknown };
const checks: Check[] = [];

function check(label: string, pass: boolean, details?: unknown): void {
  checks.push({ label, pass, details });
  if (pass) {
    console.log(`✔ ${label}`);
  } else {
    console.error(`✘ ${label}`);
    if (details !== undefined) {
      console.error("  details:", JSON.stringify(details, null, 2));
    }
  }
}

const TENANT_A = "biz-truth-101";
const CUST_A = "cust-truth-201";
const BRANCH_A = "branch-truth-301";
const WHATSAPP = "+201099999999";
const now = new Date("2026-10-31T18:00:00.000Z");

const emptyExtraction = {
  service: null,
  provider: null,
  date: null,
  timePreference: null,
  temporalRequest: null,
  exactTime: null,
};

type AttentionRow = {
  id: string;
  conversationId: string;
  businessId: string;
  reason: string;
  cause?: string | null;
  priority: string;
  status: string;
  createdAt: string;
};

function createEngineHarness(opts: {
  faqs?: Array<{ question: string; answer: string }>;
  services?: Array<{
    id: string;
    businessId: string;
    name: string;
    description: string | null;
    durationMinutes: number;
    priceType?: string | null;
    priceAmount?: number | null;
    priceCurrency?: string | null;
    isActive?: boolean;
  }>;
  about?: string | null;
  address?: string | null;
  responders: Array<(req: unknown) => Promise<AiResponse>>;
  telemetry?: Array<Record<string, unknown>>;
  transportThrows?: boolean;
  transportDelivered?: boolean;
  persistenceThrows?: boolean;
  gapRecordingThrows?: boolean;
  initialStatus?: string;
  initialAssignedUserId?: string | null;
}) {
  const sent: string[] = [];
  const messages: Array<{
    id: string;
    senderType: string;
    content: string;
    createdAt: Date;
  }> = [];
  let conversation: {
    id: string;
    businessId: string;
    customerId: string;
    status: string;
    assignedUserId: string | null;
    aiSummary?: string | null;
  } = {
    id: "conv-truth-101",
    businessId: TENANT_A,
    customerId: CUST_A,
    status: opts.initialStatus ?? "AI_ACTIVE",
    assignedUserId: opts.initialAssignedUserId ?? null,
  };
  const attention = new Map<string, AttentionRow>();
  let providerInvocations = 0;
  let turnIndex = 0;
  const claimedKeys = new Set<string>();

  const businessRecord = {
    id: TENANT_A,
    name: "مركز رعاية الأسنان التخصصي",
    isActive: true,
    about: opts.about !== undefined ? opts.about : "عيادة أسنان تخصصية",
    whatsappNumber: WHATSAPP,
    address: opts.address !== undefined ? opts.address : "شارع التحرير",
    cancellationPolicy: "24h",
    slotDurationMinutes: 30,
    confirmationMode: "manual",
    timezone: "Africa/Cairo",
    vertical: "dental",
    city: "الجيزة",
    faqs: opts.faqs ?? [],
  };

  const services = opts.services ?? [
    {
      id: "svc-1",
      businessId: TENANT_A,
      name: "تنظيف أسنان",
      description: "إزالة الجير والتلميع",
      durationMinutes: 30,
      priceType: "FIXED",
      priceAmount: 400,
      priceCurrency: "EGP",
      isActive: true,
    },
    {
      id: "svc-2",
      businessId: TENANT_A,
      name: "جلسة تجميلية",
      description: "جلسة تجميل ليزر بدون سعر معلن",
      durationMinutes: 45,
      priceType: null,
      priceAmount: null,
      priceCurrency: null,
      isActive: true,
    },
  ];

  const deps = {
    businessRepository: {
      findById: async () => businessRecord,
      findUnique: async () => businessRecord,
    },
    branchRepository: {
      findDefaultByBusiness: async () => ({
        id: BRANCH_A,
        businessId: TENANT_A,
        name: "الفرع الرئيسي",
      }),
      findByIdWithinBusiness: async () => null,
    },
    customerRepository: {
      upsertByPhone: async () => ({
        id: CUST_A,
        businessId: TENANT_A,
        phone: "+201234567890",
        name: "أحمد",
      }),
      touchConversation: async () => undefined,
      findById: async () => ({
        id: CUST_A,
        businessId: TENANT_A,
        phone: "+201234567890",
        name: "أحمد",
      }),
    },
    conversationRepository: {
      findById: async () => conversation,
      findLatestByCustomer: async () => conversation,
      create: async () => conversation,
      addMessage: async (
        input: {
          conversationId: string;
          senderType: string;
          content: string;
        },
        workflow?: { status?: string; assignedUserId?: string | null },
      ) => {
        if (opts.persistenceThrows && input.senderType === "AI") {
          throw new Error("Simulated database persistence failure");
        }
        const message = {
          id: `msg-${messages.length + 1}`,
          senderType: input.senderType,
          content: input.content,
          createdAt: now,
        };
        messages.push(message);
        if (workflow?.status) {
          conversation = { ...conversation, status: workflow.status };
        }
        if (workflow && "assignedUserId" in workflow) {
          conversation = {
            ...conversation,
            assignedUserId: workflow.assignedUserId ?? null,
          };
        }
        return message;
      },
      getMessages: async () =>
        [...messages].reverse().map((message) => ({
          id: message.id,
          conversationId: conversation.id,
          senderType: message.senderType,
          content: message.content,
          createdAt: message.createdAt.toISOString(),
        })),
      listRecentMessages: async () => [...messages],
      update: async (id: string, patch: { aiSummary?: string | null }) => {
        if (conversation && conversation.id === id && patch.aiSummary) {
          conversation = { ...conversation, aiSummary: patch.aiSummary };
        }
        return conversation;
      },
      updateWorkflow: async (
        id: string,
        patch: { status?: string; assignedUserId?: string | null },
      ) => {
        if (conversation && conversation.id === id) {
          conversation = {
            ...conversation,
            ...(patch.status ? { status: patch.status } : {}),
            ...("assignedUserId" in patch
              ? { assignedUserId: patch.assignedUserId ?? null }
              : {}),
          };
        }
        return conversation;
      },
    },
    appointmentRepository: {
      countOverlapping: async () => 0,
      create: async () => ({}) as never,
      listUpcomingForCustomer: async () => [],
      listForBusinessDay: async () => [],
    },
    serviceRepository: {
      listByBusiness: async () => services,
      listActiveByBusiness: async () =>
        services.filter((s) => s.isActive !== false),
      findById: async (id: string) => services.find((s) => s.id === id) ?? null,
      findByIdWithinBusiness: async (id: string) =>
        services.find((s) => s.id === id) ?? null,
      findByNameWithinBusiness: async (name: string) =>
        services.find((s) => s.name === name) ?? null,
    },
    usageRepository: { record: async () => undefined },
    providerRepository: {
      listActiveByBranch: async () => [],
      listActiveByService: async () => [],
      findByIdWithinBusiness: async () => null,
      findByNameWithinBusiness: async () => null,
    },
    inboundDedupeRepository: {
      claim: async (key: string) => {
        if (claimedKeys.has(key)) {
          return { status: "duplicate" as const, existingClaim: {} as never };
        }
        claimedKeys.add(key);
        return { status: "claimed" as const };
      },
    },
    conversationStateRepository: {
      findByConversationId: async () => null,
      create: async () => ({}) as never,
      updateState: async () => ({}) as never,
      updateWithOptimisticLock: async () => ({}) as never,
    },
    attentionRepository: {
      open: async (data: unknown) => {
        const row = data as AttentionRow;
        attention.set(row.conversationId, row);
        return row;
      },
    },
    knowledgeGapRepository: {
      recordGap: async () => {
        if (opts.gapRecordingThrows) {
          throw new Error("Simulated knowledge gap recording failure");
        }
        return {} as never;
      },
    },
    ai: {
      providerName: "mock-truth-provider",
      respond: async (req: unknown) => {
        providerInvocations += 1;
        const currentResponder = opts.responders[turnIndex];
        const currentTelemetry = opts.telemetry?.[turnIndex];
        turnIndex += 1;
        if (!currentResponder) {
          throw new Error("No responder configured for turn " + turnIndex);
        }
        const resp = await currentResponder(req);
        if (currentTelemetry) {
          (resp as { telemetry?: unknown }).telemetry = currentTelemetry;
        }
        return resp;
      },
      getLastTelemetry: () => {
        return opts.telemetry?.[turnIndex - 1] ?? null;
      },
    },
    transport: {
      providerName: "mock-truth-transport",
      send: async (input: { content: string }) => {
        if (opts.transportThrows) {
          throw new Error("Simulated transport network failure");
        }
        sent.push(input.content);
        return {
          provider: "mock-truth-transport",
          delivered: opts.transportDelivered ?? true,
        };
      },
    },
  } as unknown as Parameters<typeof receiveInboundMessage>[0];

  async function runInbound(text: string, extKey: string) {
    return receiveInboundMessage(
      deps,
      {
        externalId: extKey,
        from: "+201234567890",
        to: WHATSAPP,
        receivedAt: new Date().toISOString(),
        text,
      },
      { businessId: TENANT_A, connectionId: "conn-truth-1" },
    );
  }

  return {
    runInbound,
    getSent: () => sent,
    getMessages: () => messages,
    getAttention: () => attention,
    getProviderInvocations: () => providerInvocations,
    getConversation: () => conversation,
  };
}

async function runSuite(): Promise<void> {
  console.log(
    "════════════════════════════════════════════════════════════════",
  );
  console.log(
    "ISS-012: Truthful Unknown-Information Replies & Handoff Consistency",
  );
  console.log(
    "════════════════════════════════════════════════════════════════\n",
  );

  // ────────────────────────────────────────────────────────────────────────────
  // 1. BASELINE CONTROLLED INCONSISTENT-REPLY REPRODUCTION (Through Engine)
  // ────────────────────────────────────────────────────────────────────────────
  {
    // Complete parsed AI response representing the historical defect:
    // FAQ intent, reply action, unknown clinic fact (founding year),
    // unrelated catalog services available in context,
    // model content falsely claiming handoff ("هحوّلك لواحد من الفريق").
    const rawAiPayload = {
      intent: "FAQ",
      action: "reply",
      content: "العيادة لا تملك معلومة عن سنة التأسيس، هحوّلك لواحد من الفريق.",
      extraction: emptyExtraction,
      handoffReason: null,
      summary: null,
      safetyAssessment: "safe",
    };

    const parsed = parseAiResponse(rawAiPayload);
    check(
      "1.A Baseline parsed response satisfies strict AiResponse contract",
      parsed !== null && parsed.action === "reply" && parsed.intent === "FAQ",
      parsed,
    );

    // Run through complete receiveInboundMessage with unrelated catalog in context:
    const h = createEngineHarness({
      faqs: [{ question: "مواعيد العمل", answer: "من 9 صباحاً حتى 5 مساءً" }],
      services: [
        {
          id: "svc-1",
          businessId: TENANT_A,
          name: "تنظيف أسنان",
          description: "تنظيف جير وتلميع",
          durationMinutes: 30,
          priceType: "FIXED",
          priceAmount: 400,
          priceCurrency: "EGP",
          isActive: true,
        },
      ],
      responders: [async () => parsed!],
    });

    const res = await h.runInbound("متى تأسست العيادة؟", "ext-base-1");
    const conv = h.getConversation();
    const sent = h.getSent();
    const attention = h.getAttention();

    // In baseline with repair:
    // - Unrelated catalog service "تنظيف أسنان" does NOT authorize arbitrary FAQ founding year reply
    // - Unrelated working hours FAQ does NOT authorize founding year reply
    // - Model false handoff prose under action=reply is DROPPED
    // - Server transitions authoritatively to NEED_HUMAN with POLICY_REFUSED
    // - Attention record is opened for staff
    // - Truthful canonical safe handoff reply is delivered without false promises or SLAs
    check(
      "1.B Controlled inconsistent-reply baseline: unbacked prose refused and authoritatively handed off",
      res.ok === true &&
        !res.duplicate &&
        res.assistantAction === "AI_HANDOFF" &&
        res.conversationStatus === "NEED_HUMAN" &&
        res.handoffCause === "POLICY_REFUSED",
      res,
    );

    check(
      "1.C Conversation status in store is NEED_HUMAN (not false AI_ACTIVE)",
      conv.status === "NEED_HUMAN",
      conv,
    );

    check(
      "1.D Operator attention badge created in store with POLICY_REFUSED",
      attention.has(conv.id) &&
        attention.get(conv.id)?.cause === "POLICY_REFUSED",
      attention.get(conv.id),
    );

    check(
      "1.E Customer receives canonical truthful handoff wording (no 'الآن' or fake contact promise)",
      sent.length === 1 &&
        sent[0] === SAFE_HANDOFF_REPLIES.DISCLOSURE_REFUSED &&
        !sent[0].includes("الآن") &&
        !sent[0].includes("سيتواصل معك") &&
        !sent[0].includes("هحوّلك"),
      sent,
    );
  }

  // ────────────────────────────────────────────────────────────────────────────
  // 2. SCENARIO 1 & 2: Unknown Clinic Fact & False Handoff Reply
  // ────────────────────────────────────────────────────────────────────────────
  {
    // Model explicitly realizes knowledge gap and returns action=handoff
    const h = createEngineHarness({
      about: "عيادة أسنان تخصصية",
      responders: [
        async () => ({
          intent: "FAQ",
          action: "handoff",
          // Model attempts to include speculative or SLA prose in content:
          content: "سيتصل بك موظفنا خلال دقيقة الآن للمتابعة.",
          extraction: emptyExtraction,
          handoffReason: "NO_KNOWLEDGE",
          summary: "سؤال عن سنة التأسيس غير متوفرة",
          safetyAssessment: "safe",
        }),
      ],
    });

    const res = await h.runInbound("متى تم إنشاء المركز؟", "ext-sc1-1");
    const sent = h.getSent();
    const conv = h.getConversation();

    check(
      "2.A Explicit NO_KNOWLEDGE handoff transitions authoritatively to NEED_HUMAN",
      res.ok === true &&
        !res.duplicate &&
        res.conversationStatus === "NEED_HUMAN" &&
        conv.status === "NEED_HUMAN",
      { res, conv },
    );

    check(
      "2.B Server overrides model SLA prose with canonical bounded handoff copy",
      sent.length === 1 &&
        sent[0] === resolveHandoffActionReply("NO_KNOWLEDGE") &&
        sent[0] === SAFE_HANDOFF_REPLIES.DISCLOSURE_REFUSED &&
        !sent[0].includes("دقيقة") &&
        !sent[0].includes("الآن"),
      sent,
    );
  }

  // ────────────────────────────────────────────────────────────────────────────
  // 3. SCENARIO 3: Valid Authoritative Handoff (Human Request & Sensitive)
  // ────────────────────────────────────────────────────────────────────────────
  {
    // Explicit human request:
    const hHuman = createEngineHarness({
      responders: [
        async () => ({
          intent: "HUMAN_REQUEST",
          action: "handoff",
          content: "أي كلام من الموديل",
          extraction: emptyExtraction,
          handoffReason: "HUMAN_REQUEST",
          summary: "طلب التحدث مع موظف",
          safetyAssessment: "safe",
        }),
      ],
    });

    const resHuman = await hHuman.runInbound(
      "عايز أكلم حد من خدمة العملاء",
      "ext-sc3-1",
    );
    const sentHuman = hHuman.getSent();

    check(
      "3.A Explicit human request handoff yields truthful queue transfer copy",
      resHuman.ok === true &&
        !resHuman.duplicate &&
        resHuman.conversationStatus === "NEED_HUMAN" &&
        sentHuman[0] === SAFE_HANDOFF_REPLIES.HUMAN_REQUEST &&
        sentHuman[0] === "تحت أمرك — تم تحويل المحادثة لفريق العمل للمتابعة." &&
        !sentHuman[0].includes("الآن"),
      sentHuman,
    );

    // Sensitive medical emergency:
    const hSens = createEngineHarness({
      responders: [
        async () => ({
          intent: "HUMAN_REQUEST",
          action: "handoff",
          content: "أي كلام من الموديل",
          extraction: emptyExtraction,
          handoffReason: "SENSITIVE",
          summary: "حالة طارئة",
          safetyAssessment: "sensitive",
        }),
      ],
    });

    const resSens = await hSens.runInbound(
      "عندي نزيف حاد وألم شديد",
      "ext-sc3-2",
    );
    const sentSens = hSens.getSent();

    check(
      "3.B Sensitive emergency handoff yields truthful assistance copy without false SLAs",
      resSens.ok === true &&
        !resSens.duplicate &&
        resSens.conversationStatus === "NEED_HUMAN" &&
        sentSens[0] === SAFE_HANDOFF_REPLIES.SENSITIVE &&
        sentSens[0] ===
          "سنعتني بطلبك — تم تحويل المحادثة لفريق العمل للمتابعة." &&
        !sentSens[0].includes("في أقرب وقت") &&
        !sentSens[0].includes("سيتواصل معك"),
      sentSens,
    );
  }

  // ────────────────────────────────────────────────────────────────────────────
  // 4. SCENARIO 4: Failed Persistence Handling
  // ────────────────────────────────────────────────────────────────────────────
  {
    const h = createEngineHarness({
      persistenceThrows: true,
      responders: [
        async () => ({
          intent: "FAQ",
          action: "handoff",
          content: "تحويل",
          extraction: emptyExtraction,
          handoffReason: "NO_KNOWLEDGE",
          summary: null,
          safetyAssessment: "safe",
        }),
      ],
    });

    let threw = false;
    let res: unknown = null;
    try {
      res = await h.runInbound("سؤال اختباري", "ext-sc4-1");
    } catch {
      threw = true;
    }

    const failedSafely =
      threw === true ||
      (res !== null &&
        typeof res === "object" &&
        (res as { ok: boolean }).ok === false);

    check(
      "4.A Failed DB persistence safely rejects; does not fabricate success or partial send",
      failedSafely && h.getSent().length === 0,
      { threw, res, sent: h.getSent() },
    );
  }

  // ────────────────────────────────────────────────────────────────────────────
  // 5. SCENARIO 5: Unpublished Price Pressure
  // ────────────────────────────────────────────────────────────────────────────
  {
    // Customer presses: "قولّي رقم محدد، من غير كلام عام"
    // Service "جلسة تجميلية" has no price in database.
    // Model returns fabricated price under action=reply:
    const h = createEngineHarness({
      services: [
        {
          id: "svc-2",
          businessId: TENANT_A,
          name: "جلسة تجميلية",
          description: null,
          durationMinutes: 45,
          priceType: null,
          priceAmount: null,
          priceCurrency: null,
          isActive: true,
        },
      ],
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "سعر الجلسة التجميلية 1500 جنيه بالظبط.",
          extraction: {
            ...emptyExtraction,
            service: "جلسة تجميلية",
          },
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
        }),
      ],
    });

    const res = await h.runInbound(
      "قولّي رقم محدد للجلسة التجميلية، من غير كلام عام",
      "ext-sc5-1",
    );
    const sent = h.getSent();
    const conv = h.getConversation();

    check(
      "5.A Unpublished price pressure: fabricated price refused, never sent to customer",
      res.ok === true &&
        !res.duplicate &&
        res.assistantAction === "AI_HANDOFF" &&
        res.conversationStatus === "NEED_HUMAN" &&
        !sent.includes("1500") &&
        !sent.includes("١٥٠٠"),
      { res, sent },
    );

    check(
      "5.B Unpublished price pressure: terminal turn answered immediately with bounded safe handoff",
      sent.length === 1 &&
        sent[0] === SAFE_HANDOFF_REPLIES.DISCLOSURE_REFUSED &&
        conv.status === "NEED_HUMAN",
      { sent, conv },
    );
  }

  // ────────────────────────────────────────────────────────────────────────────
  // 6. SCENARIO 6: Provider Failure / Timeout Resilience
  // ────────────────────────────────────────────────────────────────────────────
  {
    const h = createEngineHarness({
      responders: [
        async () => {
          throw new Error("Simulated LLM provider timeout (HTTP 504)");
        },
      ],
      telemetry: [
        {
          finalProvider: "mock-truth-provider",
          finalStatus: "FAILURE",
          attempts: [],
          conversationControl: {
            handoffReason: "PROVIDER_UNAVAILABLE",
          },
        } as never,
      ],
    });

    const res = await h.runInbound("استفسار مع عطل مزود", "ext-sc6-1");
    const sent = h.getSent();
    const conv = h.getConversation();
    const attention = h.getAttention();

    check(
      "6.A Provider failure / timeout falls safe to PROVIDER_FAILURE handoff",
      res.ok === true &&
        !res.duplicate &&
        res.assistantAction === "AI_HANDOFF" &&
        res.conversationStatus === "NEED_HUMAN" &&
        res.handoffCause === "PROVIDER_FAILURE" &&
        conv.status === "NEED_HUMAN",
      { res, conv },
    );

    check(
      "6.B Provider failure delivers truthful non-silent acknowledgment and flags attention",
      sent.length === 1 &&
        sent[0] === SAFE_HANDOFF_REPLIES.PROVIDER_FAILURE &&
        attention.has(conv.id),
      { sent, attention: attention.get(conv.id) },
    );
  }

  // ────────────────────────────────────────────────────────────────────────────
  // 7. SCENARIO 7: Outbound Transport Failure
  // ────────────────────────────────────────────────────────────────────────────
  {
    const h = createEngineHarness({
      transportDelivered: false,
      responders: [
        async () => ({
          intent: "FAQ",
          action: "handoff",
          content: "تحويل",
          extraction: emptyExtraction,
          handoffReason: "NO_KNOWLEDGE",
          summary: null,
          safetyAssessment: "safe",
        }),
      ],
    });

    const res = await h.runInbound("استفسار مع عطل نقل", "ext-sc7-1");
    const conv = h.getConversation();
    const attention = h.getAttention();

    check(
      "7.A Outbound delivery failure is captured without crashing turn; DB state preserved",
      res.ok === true &&
        !res.duplicate &&
        res.delivery?.delivered === false &&
        conv.status === "NEED_HUMAN" &&
        attention.has(conv.id),
      { res, conv },
    );
  }

  // ────────────────────────────────────────────────────────────────────────────
  // 8. SCENARIO 8: Duplicate Inbound Deduplication
  // ────────────────────────────────────────────────────────────────────────────
  {
    const h = createEngineHarness({
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "أهلاً بك",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
          goals: [
            {
              kind: "ANSWER",
              intent: "FAQ",
              requiredKnowledge: "business.identity",
            },
          ],
        }),
      ],
    });

    const res1 = await h.runInbound("ما اسم العيادة؟", "ext-sc8-dup-1");
    const res2 = await h.runInbound("ما اسم العيادة؟", "ext-sc8-dup-1");

    check(
      "8.A Duplicate inbound message idempotently rejected without double-send or duplicate AI call",
      res1.ok === true &&
        !res1.duplicate &&
        res2.ok === true &&
        res2.duplicate === true &&
        h.getProviderInvocations() === 1 &&
        h.getSent().length === 1,
      {
        res1,
        res2,
        invocations: h.getProviderInvocations(),
        sent: h.getSent(),
      },
    );
  }

  // ────────────────────────────────────────────────────────────────────────────
  // 9. SCENARIO 9: Staff Ownership Preservation
  // ────────────────────────────────────────────────────────────────────────────
  {
    const h = createEngineHarness({
      initialStatus: "NEED_HUMAN",
      initialAssignedUserId: "staff-sarah-101",
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "مرحبا",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
        }),
      ],
    });

    const res = await h.runInbound("مساء الخير", "ext-sc9-1");
    const conv = h.getConversation();

    check(
      "9.A Conversation already assigned to staff maintains staff ownership; AI does not intervene",
      res.ok === true &&
        !res.duplicate &&
        res.assistantAction === "DEFERRED_TO_STAFF" &&
        res.conversationStatus === "NEED_HUMAN" &&
        conv.status === "NEED_HUMAN" &&
        conv.assignedUserId === "staff-sarah-101" &&
        h.getProviderInvocations() === 0,
      { res, conv, invocations: h.getProviderInvocations() },
    );
  }

  // ────────────────────────────────────────────────────────────────────────────
  // 10. SCENARIO 10: Supported Known Answers (No Regression)
  // ────────────────────────────────────────────────────────────────────────────
  {
    // 10.A Valid FAQ answer matching store
    const hFaq = createEngineHarness({
      faqs: [
        {
          question: "مواعيد العمل",
          answer: "مواعيدنا يومياً من 9 صباحاً حتى 5 مساءً.",
        },
      ],
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "مواعيدنا يومياً من 9 صباحاً حتى 5 مساءً.",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
          requiredKnowledge: "business.faqs",
          sourceId: "faq-0",
        }),
      ],
    });
    const resFaq = await hFaq.runInbound("مواعيد العمل ايه؟", "ext-sc10-faq");
    check(
      "10.A Supported FAQ reply with matching store answer is disclosed and stays AI_ACTIVE",
      resFaq.ok === true &&
        !resFaq.duplicate &&
        resFaq.assistantAction === "AI_REPLY" &&
        resFaq.conversationStatus === "AI_ACTIVE" &&
        hFaq.getSent()[0] === "مواعيدنا يومياً من 9 صباحاً حتى 5 مساءً.",
      resFaq,
    );

    // 10.B Valid Business Identity
    const hId = createEngineHarness({
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "نحن المركز التخصصي",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
          goals: [
            {
              kind: "ANSWER",
              intent: "FAQ",
              requiredKnowledge: "business.identity",
            },
          ],
        }),
      ],
    });
    const resId = await hId.runInbound("ما اسم المركز؟", "ext-sc10-id");
    check(
      "10.B Supported business identity is rendered via canonical bounded format and stays AI_ACTIVE",
      resId.ok === true &&
        !resId.duplicate &&
        resId.assistantAction === "AI_REPLY" &&
        resId.conversationStatus === "AI_ACTIVE" &&
        (hId.getSent()[0]?.includes("مركز رعاية الأسنان التخصصي") ?? false),
      resId,
    );

    // 10.C Valid Published Service Price
    const hPrice = createEngineHarness({
      services: [
        {
          id: "svc-1",
          businessId: TENANT_A,
          name: "تنظيف أسنان",
          description: null,
          durationMinutes: 30,
          priceType: "FIXED",
          priceAmount: 400,
          priceCurrency: "EGP",
          isActive: true,
        },
      ],
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "سعر تنظيف الأسنان 400 جنيه.",
          extraction: {
            ...emptyExtraction,
            service: "تنظيف أسنان",
          },
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
          requiredKnowledge: "service.price",
          sourceId: "svc-1",
        }),
      ],
    });
    const resPrice = await hPrice.runInbound(
      "بكام تنظيف الأسنان؟",
      "ext-sc10-price",
    );
    check(
      "10.C Supported service price with matching catalog price is disclosed and stays AI_ACTIVE",
      resPrice.ok === true &&
        !resPrice.duplicate &&
        resPrice.assistantAction === "AI_REPLY" &&
        resPrice.conversationStatus === "AI_ACTIVE" &&
        (hPrice.getSent()[0]?.includes("400") ?? false),
      resPrice,
    );

    // 10.D Valid Service Catalog Listing
    const hCat = createEngineHarness({
      services: [
        {
          id: "svc-1",
          businessId: TENANT_A,
          name: "تنظيف أسنان",
          description: null,
          durationMinutes: 30,
          priceType: null,
          priceAmount: null,
          priceCurrency: null,
          isActive: true,
        },
      ],
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "الخدمات المتاحة لدينا تشمل تنظيف أسنان.",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
          requiredKnowledge: "service.name",
        }),
      ],
    });
    const resCat = await hCat.runInbound(
      "ايه الخدمات المتاحة؟",
      "ext-sc10-cat",
    );
    check(
      "10.D Supported service catalog listing with explicit requiredKnowledge is disclosed",
      resCat.ok === true &&
        !resCat.duplicate &&
        resCat.assistantAction === "AI_REPLY" &&
        resCat.conversationStatus === "AI_ACTIVE" &&
        (hCat.getSent()[0]?.includes("تنظيف أسنان") ?? false),
      resCat,
    );

    // 10.E Valid Address
    const hAddr = createEngineHarness({
      address: "15 شارع النصر، المعادي، القاهرة",
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "عنواننا 15 شارع النصر بالمعادي",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
          requiredKnowledge: "business.address",
        }),
      ],
    });
    const resAddr = await hAddr.runInbound(
      "عنوانكم فين بالظبط؟",
      "ext-sc10-addr",
    );
    check(
      "10.E Supported business address is rendered authoritatively and stays AI_ACTIVE",
      resAddr.ok === true &&
        !resAddr.duplicate &&
        resAddr.assistantAction === "AI_REPLY" &&
        resAddr.conversationStatus === "AI_ACTIVE" &&
        (hAddr.getSent()[0]?.includes("15 شارع النصر") ?? false),
      resAddr,
    );

    // 10.F Valid About
    const hAbout = createEngineHarness({
      about: "عيادة أسنان تخصصية تقدم خدمات تقويم وجراحة وزراعة الأسنان",
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "نحن عيادة أسنان تخصصية",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
          requiredKnowledge: "business.about",
        }),
      ],
    });
    const resAbout = await hAbout.runInbound(
      "احكيلي عن العيادة وخدماتكم",
      "ext-sc10-about",
    );
    check(
      "10.F Supported business about is rendered authoritatively and stays AI_ACTIVE",
      resAbout.ok === true &&
        !resAbout.duplicate &&
        resAbout.assistantAction === "AI_REPLY" &&
        resAbout.conversationStatus === "AI_ACTIVE" &&
        (hAbout.getSent()[0]?.includes("عيادة أسنان تخصصية") ?? false),
      resAbout,
    );
  }

  // ────────────────────────────────────────────────────────────────────────────
  // 11. SCENARIO 11: Knowledge-Gap Recording Failure Resiliency
  // ────────────────────────────────────────────────────────────────────────────
  {
    const h = createEngineHarness({
      gapRecordingThrows: true,
      responders: [
        async () => ({
          intent: "FAQ",
          action: "handoff",
          content: "تحويل",
          extraction: emptyExtraction,
          handoffReason: "NO_KNOWLEDGE",
          summary: null,
          safetyAssessment: "safe",
        }),
      ],
    });

    const res = await h.runInbound(
      "سؤال غير معروف مع فشل فجوة المعرفة",
      "ext-sc11-1",
    );
    const sent = h.getSent();
    const conv = h.getConversation();

    check(
      "11.A Knowledge gap repository failure does not crash engine; turn succeeds and safely hands off",
      res.ok === true &&
        !res.duplicate &&
        res.assistantAction === "AI_HANDOFF" &&
        res.conversationStatus === "NEED_HUMAN" &&
        conv.status === "NEED_HUMAN" &&
        sent.length === 1,
      { res, conv, sent },
    );
  }

  // ────────────────────────────────────────────────────────────────────────────
  // 12. SCENARIO 12: Unrelated-Support Isolation
  // ────────────────────────────────────────────────────────────────────────────
  {
    // Service A ("كشف أسنان") has price 300.
    // Service B ("تبييض أسنان") has no price.
    // Customer asks about Service B ("تبييض أسنان"), but model asserts price.
    // Another service's price must NOT authorize Service B.
    const hUnrelatedPrice = createEngineHarness({
      services: [
        {
          id: "svc-1",
          businessId: TENANT_A,
          name: "كشف أسنان",
          description: null,
          durationMinutes: 30,
          priceType: "FIXED",
          priceAmount: 300,
          priceCurrency: "EGP",
          isActive: true,
        },
        {
          id: "svc-2",
          businessId: TENANT_A,
          name: "تبييض أسنان",
          description: null,
          durationMinutes: 45,
          priceType: null,
          priceAmount: null,
          priceCurrency: null,
          isActive: true,
        },
      ],
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "سعر تبييض الأسنان 2000 جنيه.",
          extraction: {
            ...emptyExtraction,
            service: "تبييض أسنان",
          },
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
          requiredKnowledge: "service.price",
          sourceId: "svc-2",
        }),
      ],
    });

    const resPrice = await hUnrelatedPrice.runInbound(
      "كم سعر تبييض الأسنان؟",
      "ext-sc12-unrelated-price",
    );
    check(
      "12.A Another service's price does not authorize an unpriced service (unrelated support isolated)",
      resPrice.ok === true &&
        !resPrice.duplicate &&
        resPrice.assistantAction === "AI_HANDOFF" &&
        resPrice.conversationStatus === "NEED_HUMAN" &&
        !hUnrelatedPrice.getSent().includes("2000"),
      resPrice,
    );

    // Unrelated FAQ: store has working hours FAQ only.
    // Customer asks about sterilization/safety.
    // Working hours FAQ must NOT authorize sterilization answer.
    const hUnrelatedFaq = createEngineHarness({
      faqs: [{ question: "مواعيد العمل", answer: "من 9 صباحاً حتى 5 مساءً" }],
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "نحن نستخدم أحدث أجهزة التعقيم المعتمدة دولياً.",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
          requiredKnowledge: "business.faqs",
        }),
      ],
    });

    const resFaq = await hUnrelatedFaq.runInbound(
      "ما هي إجراءات التعقيم؟",
      "ext-sc12-unrelated-faq",
    );
    check(
      "12.B Unrelated FAQ in store does not authorize unsupported answer; strictly handed off",
      resFaq.ok === true &&
        !resFaq.duplicate &&
        resFaq.assistantAction === "AI_HANDOFF" &&
        resFaq.conversationStatus === "NEED_HUMAN" &&
        !(hUnrelatedFaq.getSent()[0]?.includes("التعقيم المعتمدة") ?? false),
      resFaq,
    );
  }

  // ────────────────────────────────────────────────────────────────────────────
  // 13. SCENARIO 13: Adversarial Lexical Authorization Defeat & Server-Authoritative Rendering
  // ────────────────────────────────────────────────────────────────────────────
  {
    // 13.A Adversarial Word Overlap Defeat:
    // Store has an address FAQ with words "العيادة" and "المعادي".
    // Customer asks unsupported question: "متى تأسست العيادة؟"
    // Model returns unbacked answer claiming founding year 1990 sharing words "العيادة" and "المعادي".
    // Model specifies no valid source reference for founding year -> refused and handed off.
    const hAdversarialOverlap = createEngineHarness({
      faqs: [
        {
          question: "هل فرع العيادة في المعادي؟",
          answer: "نعم فرع العيادة يقع في المعادي.",
        },
      ],
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          // Cleverly crafting reply sharing substantive words "العيادة" and "المعادي"
          content: "تأسست العيادة سنة 1990 في حي المعادي العريق.",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
          requiredKnowledge: "business.faqs",
          // Model targets an unexposed or unbacked reference
          sourceId: "unsupported-founding-year-key",
        }),
      ],
    });

    const resAdv1 = await hAdversarialOverlap.runInbound(
      "متى تأسست العيادة؟",
      "ext-sc13-adv-1",
    );
    check(
      "13.A Adversarial lexical overlap defeated: unsupported founding year prose is refused and handed off",
      resAdv1.ok === true &&
        !resAdv1.duplicate &&
        resAdv1.assistantAction === "AI_HANDOFF" &&
        resAdv1.conversationStatus === "NEED_HUMAN" &&
        !hAdversarialOverlap.getSent().includes("1990"),
      resAdv1,
    );

    // 13.B Hallucinated Price on Genuinely Priced Service:
    // Service "تنظيف أسنان" costs 400 EGP in database.
    // Model attempts to quote "900 جنيه" referencing the service.
    // Server-authoritative rendering emits the canonical 400 EGP price, never the 900 quote.
    const hAdvPrice = createEngineHarness({
      services: [
        {
          id: "svc-1",
          businessId: TENANT_A,
          name: "تنظيف أسنان",
          description: null,
          durationMinutes: 30,
          priceType: "FIXED",
          priceAmount: 400,
          priceCurrency: "EGP",
          isActive: true,
        },
      ],
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "سعر تنظيف أسنان 900 جنيه شامل الكشف.",
          extraction: {
            ...emptyExtraction,
            service: "تنظيف أسنان",
          },
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
          requiredKnowledge: "service.price",
          sourceId: "svc-1",
        }),
      ],
    });

    const resAdvPrice = await hAdvPrice.runInbound(
      "بكام تنظيف الأسنان؟",
      "ext-sc13-adv-2",
    );
    const sentAdvPrice = hAdvPrice.getSent();
    check(
      "13.B Server-authoritative price rendering overrides hallucinated quote with authoritative price",
      resAdvPrice.ok === true &&
        !resAdvPrice.duplicate &&
        resAdvPrice.assistantAction === "AI_REPLY" &&
        resAdvPrice.conversationStatus === "AI_ACTIVE" &&
        sentAdvPrice.length === 1 &&
        (sentAdvPrice[0]?.includes("400") ?? false) &&
        !sentAdvPrice[0]?.includes("900"),
      sentAdvPrice,
    );

    // 13.C Foreign / Non-Existent Source Reference:
    // Model proposes a source ID from another tenant or unknown identifier.
    // Server validation fails closed -> NEED_HUMAN with POLICY_REFUSED.
    const hAdvCross = createEngineHarness({
      services: [
        {
          id: "svc-1",
          businessId: TENANT_A,
          name: "تنظيف أسنان",
          description: null,
          durationMinutes: 30,
          priceType: "FIXED",
          priceAmount: 400,
          priceCurrency: "EGP",
          isActive: true,
        },
      ],
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "سعر الجلسة 500 جنيه.",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
          requiredKnowledge: "service.price",
          sourceId: "cross-tenant-foreign-id-999",
        }),
      ],
    });

    const resAdvCross = await hAdvCross.runInbound(
      "سعر الخدمة ايه؟",
      "ext-sc13-adv-3",
    );
    check(
      "13.C Cross-tenant or unexposed source reference fails closed to NEED_HUMAN with POLICY_REFUSED",
      resAdvCross.ok === true &&
        !resAdvCross.duplicate &&
        resAdvCross.assistantAction === "AI_HANDOFF" &&
        resAdvCross.conversationStatus === "NEED_HUMAN" &&
        resAdvCross.handoffCause === "POLICY_REFUSED",
      resAdvCross,
    );
  }

  // ────────────────────────────────────────────────────────────────────────────
  // 14. NINE AUTHORITATIVE ADVERSARIAL GROUNDING CHECKS (PR74 REQUIRED REPAIR)
  // ────────────────────────────────────────────────────────────────────────────
  {
    // 14.1 Missing reference + stored address in reply containing invented founding year & transfer promise -> refused and dropped
    const hAdv1 = createEngineHarness({
      address: "شارع التحرير، الدقي، الجيزة",
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content:
            "تأسست العيادة عام 1995 في شارع التحرير، الدقي، الجيزة وهحولك لواحد من الفريق فوراً.",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
        }),
      ],
    });
    const resAdv1 = await hAdv1.runInbound(
      "متى تأسست العيادة وعنوانكم فين؟",
      "adv-1",
    );
    const sentAdv1 = hAdv1.getSent();
    check(
      "14.1 Missing reference + stored address in reply containing invented founding year & transfer promise -> refused and dropped",
      resAdv1.ok === true &&
        !resAdv1.duplicate &&
        resAdv1.assistantAction === "AI_HANDOFF" &&
        resAdv1.conversationStatus === "NEED_HUMAN" &&
        resAdv1.handoffCause === "POLICY_REFUSED" &&
        !sentAdv1.some(
          (msg) =>
            msg.includes("1995") ||
            msg.includes("هحولك") ||
            msg.includes("الفريق"),
        ),
      { resAdv1, sentAdv1 },
    );

    // 14.2 Explicit FAQ family without source ID + customer text matching FAQ -> refused (lexical cannot rescue)
    const hAdv2 = createEngineHarness({
      faqs: [
        {
          question: "ما هي مواعيد العمل؟",
          answer: "مواعيدنا يومياً من 9 صباحاً حتى 5 مساءً.",
        },
      ],
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content:
            "مواعيد العمل الرسمية من 9 صباحاً حتى 5 مساءً وسأقوم بمساعدتك فوراً.",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
          requiredKnowledge: "business.faqs",
          // explicitly omitting sourceId
        }),
      ],
    });
    const resAdv2 = await hAdv2.runInbound("ما هي مواعيد العمل؟", "adv-2");
    check(
      "14.2 Explicit FAQ family without source ID + customer text matching FAQ -> refused (lexical cannot rescue)",
      resAdv2.ok === true &&
        !resAdv2.duplicate &&
        resAdv2.assistantAction === "AI_HANDOFF" &&
        resAdv2.conversationStatus === "NEED_HUMAN" &&
        resAdv2.handoffCause === "POLICY_REFUSED" &&
        hAdv2.getSent()[0] !== "مواعيدنا يومياً من 9 صباحاً حتى 5 مساءً.",
      resAdv2,
    );

    // 14.3 Invalid FAQ reference + exact stored answer in content -> refused
    const hAdv3 = createEngineHarness({
      faqs: [
        {
          question: "ما هي مواعيد العمل؟",
          answer: "مواعيدنا يومياً من 9 صباحاً حتى 5 مساءً.",
        },
      ],
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "مواعيدنا يومياً من 9 صباحاً حتى 5 مساءً.",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
          requiredKnowledge: "business.faqs",
          sourceId: "non-existent-faq-id-999",
        }),
      ],
    });
    const resAdv3 = await hAdv3.runInbound("مواعيد العمل؟", "adv-3");
    check(
      "14.3 Invalid FAQ reference + exact stored answer in content -> refused",
      resAdv3.ok === true &&
        !resAdv3.duplicate &&
        resAdv3.assistantAction === "AI_HANDOFF" &&
        resAdv3.conversationStatus === "NEED_HUMAN" &&
        resAdv3.handoffCause === "POLICY_REFUSED",
      resAdv3,
    );

    // 14.4 Failed FAQ lookup + extracted priced service + wrong numeric quote -> refused
    const hAdv4 = createEngineHarness({
      services: [
        {
          id: "svc-1",
          businessId: TENANT_A,
          name: "تنظيف أسنان",
          description: null,
          durationMinutes: 30,
          priceType: "FIXED",
          priceAmount: 400,
          priceCurrency: "EGP",
          isActive: true,
        },
      ],
      faqs: [],
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "سنة تأسيس العيادة 2010 وسعر تنظيف الأسنان 9999 جنيه.",
          extraction: {
            ...emptyExtraction,
            service: "تنظيف أسنان",
          },
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
          requiredKnowledge: "business.faqs",
          sourceId: "non-existent-founding-year-faq",
        }),
      ],
    });
    const resAdv4 = await hAdv4.runInbound("متى تأسستم؟", "adv-4");
    check(
      "14.4 Failed FAQ lookup + extracted priced service + wrong numeric quote -> refused",
      resAdv4.ok === true &&
        !resAdv4.duplicate &&
        resAdv4.assistantAction === "AI_HANDOFF" &&
        resAdv4.conversationStatus === "NEED_HUMAN" &&
        resAdv4.handoffCause === "POLICY_REFUSED" &&
        !hAdv4
          .getSent()
          .some((msg) => msg.includes("9999") || msg.includes("2010")),
      resAdv4,
    );

    // 14.5 Missing reference + Arabic price keywords + known service name -> refused
    const hAdv5 = createEngineHarness({
      services: [
        {
          id: "svc-1",
          businessId: TENANT_A,
          name: "تنظيف أسنان",
          description: null,
          durationMinutes: 30,
          priceType: "FIXED",
          priceAmount: 400,
          priceCurrency: "EGP",
          isActive: true,
        },
      ],
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "سعر تنظيف أسنان 350 جنيه شامل الخصم.",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
          // missing reference completely
        }),
      ],
    });
    const resAdv5 = await hAdv5.runInbound(
      "بكام سعر تنظيف أسنان وتكلفة الجلسة كم؟",
      "adv-5",
    );
    check(
      "14.5 Missing reference + Arabic price keywords + known service name -> refused",
      resAdv5.ok === true &&
        !resAdv5.duplicate &&
        resAdv5.assistantAction === "AI_HANDOFF" &&
        resAdv5.conversationStatus === "NEED_HUMAN" &&
        resAdv5.handoffCause === "POLICY_REFUSED" &&
        !hAdv5.getSent().some((msg) => msg.includes("350")),
      resAdv5,
    );

    // 14.6 Explicit valid service-price reference + wrong numeric quote -> emits only authoritative stored price
    const hAdv6 = createEngineHarness({
      services: [
        {
          id: "svc-1",
          businessId: TENANT_A,
          name: "تنظيف أسنان",
          description: null,
          durationMinutes: 30,
          priceType: "FIXED",
          priceAmount: 400,
          priceCurrency: "EGP",
          isActive: true,
        },
      ],
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "سعر تنظيف أسنان 850 جنيه شامل الكشف.",
          extraction: {
            ...emptyExtraction,
            service: "تنظيف أسنان",
          },
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
          requiredKnowledge: "service.price",
          sourceId: "svc-1",
        }),
      ],
    });
    const resAdv6 = await hAdv6.runInbound("بكام تنظيف الأسنان؟", "adv-6");
    const sentAdv6 = hAdv6.getSent();
    check(
      "14.6 Explicit valid service-price reference + wrong numeric quote -> emits only authoritative stored price",
      resAdv6.ok === true &&
        !resAdv6.duplicate &&
        resAdv6.assistantAction === "AI_REPLY" &&
        resAdv6.conversationStatus === "AI_ACTIVE" &&
        sentAdv6.length === 1 &&
        sentAdv6[0]?.includes("400") === true &&
        sentAdv6[0]?.includes("850") === false,
      sentAdv6,
    );

    // 14.7 Valid FAQ/address/about/identity/description/catalog references -> verify exact canonical emitted content
    // 14.7a FAQ
    const hAdv7Faq = createEngineHarness({
      faqs: [{ question: "مواعيد العمل", answer: "من 9 صباحاً حتى 5 مساءً." }],
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "نص عشوائي للموديل لا يجب ظهوره",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
          requiredKnowledge: "business.faqs",
          sourceId: "مواعيد العمل",
        }),
      ],
    });
    await hAdv7Faq.runInbound("مواعيد العمل", "adv-7-faq");
    const sent7Faq = hAdv7Faq.getSent()[0];

    // 14.7b Address
    const hAdv7Addr = createEngineHarness({
      address: "15 شارع النصر، المعادي، القاهرة",
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "نص عشوائي للموديل لا يجب ظهوره",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
          requiredKnowledge: "business.address",
        }),
      ],
    });
    await hAdv7Addr.runInbound("عنوانكم", "adv-7-addr");
    const sent7Addr = hAdv7Addr.getSent()[0];

    // 14.7c About
    const hAdv7About = createEngineHarness({
      about: "عيادة أسنان تخصصية بأحدث الأجهزة",
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "نص عشوائي للموديل لا يجب ظهوره",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
          requiredKnowledge: "business.about",
        }),
      ],
    });
    await hAdv7About.runInbound("عن العيادة", "adv-7-about");
    const sent7About = hAdv7About.getSent()[0];

    // 14.7d Identity
    const hAdv7Id = createEngineHarness({
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "نص عشوائي للموديل لا يجب ظهوره",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
          goals: [
            {
              kind: "ANSWER",
              intent: "FAQ",
              requiredKnowledge: "business.identity",
            },
          ],
        }),
      ],
    });
    await hAdv7Id.runInbound("اسم المركز ايه", "adv-7-id");
    const sent7Id = hAdv7Id.getSent()[0];

    // 14.7e Description
    const hAdv7Desc = createEngineHarness({
      services: [
        {
          id: "svc-1",
          businessId: TENANT_A,
          name: "تنظيف أسنان",
          description: "تنظيف الجير والتلميع الكامل بالفرشاة الدوارة",
          durationMinutes: 30,
          isActive: true,
        },
      ],
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "نص عشوائي للموديل لا يجب ظهوره",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
          knowledgeRef: {
            family: "service.description",
            sourceId: "svc-1",
          },
        }),
      ],
    });
    await hAdv7Desc.runInbound("تفاصيل تنظيف الأسنان", "adv-7-desc");
    const sent7Desc = hAdv7Desc.getSent()[0];

    // 14.7f Catalog
    const hAdv7Cat = createEngineHarness({
      services: [
        {
          id: "svc-1",
          businessId: TENANT_A,
          name: "تنظيف أسنان",
          description: null,
          durationMinutes: 30,
          isActive: true,
        },
      ],
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "نص عشوائي للموديل لا يجب ظهوره",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
          requiredKnowledge: "service.name",
        }),
      ],
    });
    await hAdv7Cat.runInbound("الخدمات المتاحة", "adv-7-cat");
    const sent7Cat = hAdv7Cat.getSent()[0];

    check(
      "14.7 Valid FAQ/address/about/identity/description/catalog references -> verify exact canonical emitted content",
      sent7Faq === "من 9 صباحاً حتى 5 مساءً." &&
        sent7Addr ===
          buildBusinessAddressContent("15 شارع النصر، المعادي، القاهرة") &&
        sent7About ===
          buildBusinessAboutContent("عيادة أسنان تخصصية بأحدث الأجهزة") &&
        sent7Id ===
          buildBusinessIdentityContent("مركز رعاية الأسنان التخصصي") &&
        sent7Desc ===
          buildServiceDescriptionContent(
            "تنظيف أسنان",
            "تنظيف الجير والتلميع الكامل بالفرشاة الدوارة",
          ) &&
        sent7Cat?.includes("تنظيف أسنان") === true,
      {
        sent7Faq,
        sent7Addr,
        sent7About,
        sent7Id,
        sent7Desc,
        sent7Cat,
      },
    );

    // 14.8a Unknown source reference -> refused, zero leaked content
    const hAdv8a = createEngineHarness({
      services: [
        {
          id: "svc-1",
          businessId: TENANT_A,
          name: "تنظيف أسنان",
          description: null,
          durationMinutes: 30,
          priceType: "FIXED",
          priceAmount: 400,
          priceCurrency: "EGP",
          isActive: true,
        },
      ],
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "سعر الخدمة غير المعروفة 999 جنيه.",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
          knowledgeRef: {
            family: "service.price",
            sourceId: "non-existent-svc-id-999",
          },
        }),
      ],
    });
    const resAdv8a = await hAdv8a.runInbound("بكام الخدمة؟", "adv-8a");
    check(
      "14.8a Unknown source reference -> refused, zero leaked content",
      resAdv8a.ok === true &&
        !resAdv8a.duplicate &&
        resAdv8a.assistantAction === "AI_HANDOFF" &&
        resAdv8a.conversationStatus === "NEED_HUMAN" &&
        resAdv8a.handoffCause === "POLICY_REFUSED" &&
        !hAdv8a.getSent().some((msg) => msg.includes("999")),
      resAdv8a,
    );

    // 14.8b Source present in storage but not exposed this turn -> refused
    const hAdv8b = createEngineHarness({
      services: [
        {
          id: "svc-active-1",
          businessId: TENANT_A,
          name: "تنظيف أسنان",
          description: "تنظيف جير",
          durationMinutes: 30,
          priceType: "FIXED",
          priceAmount: 400,
          priceCurrency: "EGP",
          isActive: true,
        },
        {
          id: "svc-unexposed-inactive",
          businessId: TENANT_A,
          name: "خدمة معطلة",
          description: "وصف خدمة معطلة",
          durationMinutes: 30,
          priceType: "FIXED",
          priceAmount: 800,
          priceCurrency: "EGP",
          isActive: false, // inactive -> filtered from AI context request
        },
      ],
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "سعر الخدمة المعطلة 800 جنيه.",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
          knowledgeRef: {
            family: "service.price",
            sourceId: "svc-unexposed-inactive",
          },
        }),
      ],
    });
    const resAdv8b = await hAdv8b.runInbound("بكام الخدمة المعطلة؟", "adv-8b");
    check(
      "14.8b Source present in storage but not exposed this turn -> refused",
      resAdv8b.ok === true &&
        !resAdv8b.duplicate &&
        resAdv8b.assistantAction === "AI_HANDOFF" &&
        resAdv8b.conversationStatus === "NEED_HUMAN" &&
        resAdv8b.handoffCause === "POLICY_REFUSED" &&
        !hAdv8b.getSent().some((msg) => msg.includes("800")),
      resAdv8b,
    );

    // 14.8c Cross-tenant source excluded from current context -> refused, zero leaked content
    const hAdv8c = createEngineHarness({
      services: [
        {
          id: "svc-tenant-a-1",
          businessId: TENANT_A,
          name: "تنظيف أسنان",
          description: null,
          durationMinutes: 30,
          priceType: "FIXED",
          priceAmount: 400,
          priceCurrency: "EGP",
          isActive: true,
        },
      ],
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "سعر الخدمة الخاصة 1000 جنيه من مستأجر آخر.",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
          knowledgeRef: {
            family: "service.price",
            sourceId: "foreign-tenant-svc-999",
          },
        }),
      ],
    });
    const resAdv8c = await hAdv8c.runInbound("سعر الخدمة ايه؟", "adv-8c");
    check(
      "14.8c Cross-tenant source excluded from current context -> refused, zero leaked content",
      resAdv8c.ok === true &&
        !resAdv8c.duplicate &&
        resAdv8c.assistantAction === "AI_HANDOFF" &&
        resAdv8c.conversationStatus === "NEED_HUMAN" &&
        resAdv8c.handoffCause === "POLICY_REFUSED" &&
        !hAdv8c
          .getSent()
          .some((msg) => msg.includes("1000") || msg.includes("مستأجر")),
      resAdv8c,
    );

    // 14.8d Duplicate/ambiguous matching source references -> refused by cardinality check
    const hAdv8d = createEngineHarness({
      services: [
        {
          id: "svc-dental-standard",
          businessId: TENANT_A,
          name: "تنظيف أسنان",
          description: null,
          durationMinutes: 30,
          priceType: "FIXED",
          priceAmount: 400,
          priceCurrency: "EGP",
          isActive: true,
        },
        {
          id: "svc-dental-deep",
          businessId: TENANT_A,
          name: "تنظيف أسنان",
          description: null,
          durationMinutes: 45,
          priceType: "FIXED",
          priceAmount: 700,
          priceCurrency: "EGP",
          isActive: true,
        },
      ],
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "سعر تنظيف الأسنان 400 جنيه.",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
          knowledgeRef: {
            family: "service.price",
            sourceId: "تنظيف أسنان",
          },
        }),
      ],
    });
    const resAdv8d = await hAdv8d.runInbound("بكام تنظيف الأسنان؟", "adv-8d");
    check(
      "14.8d Duplicate/ambiguous matching source references -> refused by cardinality check",
      resAdv8d.ok === true &&
        !resAdv8d.duplicate &&
        resAdv8d.assistantAction === "AI_HANDOFF" &&
        resAdv8d.conversationStatus === "NEED_HUMAN" &&
        resAdv8d.handoffCause === "POLICY_REFUSED",
      resAdv8d,
    );

    // 14.8e Conflicting top-level versus goal-level references -> refused
    const hAdv8e = createEngineHarness({
      faqs: [{ question: "مواعيد العمل", answer: "من 9 إلى 5" }],
      services: [
        {
          id: "svc-1",
          businessId: TENANT_A,
          name: "تنظيف أسنان",
          description: null,
          durationMinutes: 30,
          priceType: "FIXED",
          priceAmount: 400,
          priceCurrency: "EGP",
          isActive: true,
        },
      ],
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "مواعيد العمل من 9 صباحاً.",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
          knowledgeRef: {
            family: "business.faqs",
            sourceId: "مواعيد العمل",
          },
          goals: [
            {
              kind: "ANSWER",
              intent: "FAQ",
              priority: 1,
              continueAfter: false,
              knowledgeRef: {
                family: "service.price",
                sourceId: "svc-1",
              },
            },
          ],
        }),
      ],
    });
    const resAdv8e = await hAdv8e.runInbound("مواعيد وسعر؟", "adv-8e");
    check(
      "14.8e Conflicting top-level versus goal-level references -> refused",
      resAdv8e.ok === true &&
        !resAdv8e.duplicate &&
        resAdv8e.assistantAction === "AI_HANDOFF" &&
        resAdv8e.conversationStatus === "NEED_HUMAN" &&
        resAdv8e.handoffCause === "POLICY_REFUSED",
      resAdv8e,
    );

    // 14.8f Service source without a resolvable knowledge operation -> refused without guessing
    const hAdv8f = createEngineHarness({
      services: [
        {
          id: "svc-combo",
          businessId: TENANT_A,
          name: "تنظيف أسنان شامل",
          description: "تنظيف وتبييض وصيانة كاملة",
          durationMinutes: 45,
          priceType: "FIXED",
          priceAmount: 600,
          priceCurrency: "EGP",
          isActive: true,
        },
      ],
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "سعر تنظيف أسنان شامل 600 جنيه.",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
          sourceId: "svc-combo",
        }),
      ],
    });
    const resAdv8f = await hAdv8f.runInbound("عايز تفاصيل الخدمة", "adv-8f");
    check(
      "14.8f Service source without a resolvable knowledge operation -> refused without guessing",
      resAdv8f.ok === true &&
        !resAdv8f.duplicate &&
        resAdv8f.assistantAction === "AI_HANDOFF" &&
        resAdv8f.conversationStatus === "NEED_HUMAN" &&
        resAdv8f.handoffCause === "POLICY_REFUSED",
      resAdv8f,
    );

    // 14.8g Valid explicit price and description references remain successful
    const hAdv8g = createEngineHarness({
      services: [
        {
          id: "svc-combo",
          businessId: TENANT_A,
          name: "تنظيف أسنان شامل",
          description: "تنظيف جير وتلميع أسنان شامل",
          durationMinutes: 45,
          priceType: "FIXED",
          priceAmount: 600,
          priceCurrency: "EGP",
          isActive: true,
        },
      ],
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "السعر المخترع 9999 جنيه غير المعتمد.",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
          knowledgeRef: {
            family: "service.price",
            sourceId: "svc-combo",
          },
        }),
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "الوصف المخترع غير المعتمد.",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
          knowledgeRef: {
            family: "service.description",
            sourceId: "svc-combo",
          },
        }),
      ],
    });
    const resPrice = await hAdv8g.runInbound("بكام الخدمة؟", "adv-8g-1");
    const sentPrice = hAdv8g.getSent();
    const resDesc = await hAdv8g.runInbound("ايه تفاصيل الخدمة؟", "adv-8g-2");
    const sentDesc = hAdv8g.getSent();

    check(
      "14.8g Valid explicit price and description references remain successful",
      resPrice.ok === true &&
        !resPrice.duplicate &&
        resPrice.assistantAction === "AI_REPLY" &&
        resPrice.conversationStatus === "AI_ACTIVE" &&
        sentPrice[0]?.includes("600") === true &&
        sentPrice[0]?.includes("9999") === false &&
        resDesc.ok === true &&
        !resDesc.duplicate &&
        resDesc.assistantAction === "AI_REPLY" &&
        resDesc.conversationStatus === "AI_ACTIVE" &&
        sentDesc[1]?.includes("تنظيف جير وتلميع أسنان شامل") === true &&
        sentDesc[1]?.includes("المخترع") === false,
      { resPrice, resDesc, sent: sentDesc },
    );

    // 14.9 Failed persistence, duplicate inbound, provider failure and staff-owned conversation invariants preserved
    // Confirms end-to-end invariant preservation from Scenarios 4, 6, 8, 9
    check(
      "14.9 Failed persistence, duplicate inbound, provider failure and staff-owned conversation invariants preserved",
      checks.some(
        (c) => c.label.includes("4.A Failed DB persistence") && c.pass === true,
      ) &&
        checks.some(
          (c) => c.label.includes("6.A Provider failure") && c.pass === true,
        ) &&
        checks.some(
          (c) => c.label.includes("8.A Duplicate inbound") && c.pass === true,
        ) &&
        checks.some(
          (c) =>
            c.label.includes("9.A Conversation already assigned to staff") &&
            c.pass === true,
        ),
    );
  }

  // ────────────────────────────────────────────────────────────────────────────
  // SUMMARY
  // ────────────────────────────────────────────────────────────────────────────
  const failed = checks.filter((c) => !c.pass);
  console.log(
    "\n────────────────────────────────────────────────────────────────",
  );
  console.log(
    `Results: ${checks.length - failed.length}/${checks.length} passed.`,
  );
  if (failed.length > 0) {
    console.error(`FAILED: ${failed.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(
    "All unknown-information and handoff consistency checks passed successfully.",
  );
}

runSuite().catch((err) => {
  console.error("FATAL in test suite:", err);
  process.exit(1);
});
