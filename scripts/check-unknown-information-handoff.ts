/* eslint-disable @typescript-eslint/no-explicit-any */
import "./setup-test-env";

import { buildAiContext } from "../src/features/conversations/server/ai-context-builder";
import {
  knowledgeFamilyValues,
  modelAuthorableKnowledgeFamilyValues,
  parseAiResponse,
  type AiResponse,
} from "../src/features/conversations/server/ai-contract";
import {
  buildBusinessAboutContent,
  buildBusinessAddressContent,
  buildBusinessIdentityContent,
  buildServiceDescriptionContent,
  enforceDisclosure,
  supportFamilyForProposedKnowledge,
} from "../src/features/conversations/server/ai-disclosure";
import {
  SAFE_HANDOFF_REPLIES,
  SERVICE_PRICE_UNAVAILABLE_TEXT,
  resolveHandoffActionReply,
} from "../src/features/conversations/server/conversation-ai";
import { receiveInboundMessage } from "../src/features/conversations/server/conversation-engine";
import { buildTurnEvidence } from "../src/features/conversations/server/turn-evidence";

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
    priceMaxAmount?: number | null;
    priceCurrency?: string | null;
    priceNote?: string | null;
    isActive?: boolean;
  }>;
  about?: string | null;
  address?: string | null;
  businessAbout?: string | null;
  businessAddress?: string | null;
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
  let appointmentWrites = 0;
  let turnIndex = 0;
  const claimedKeys = new Set<string>();

  const businessRecord = {
    id: TENANT_A,
    name: "مركز رعاية الأسنان التخصصي",
    isActive: true,
    about:
      opts.businessAbout !== undefined
        ? opts.businessAbout
        : opts.about !== undefined
          ? opts.about
          : "عيادة أسنان تخصصية",
    whatsappNumber: WHATSAPP,
    address:
      opts.businessAddress !== undefined
        ? opts.businessAddress
        : opts.address !== undefined
          ? opts.address
          : "شارع التحرير",
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
      create: async () => {
        appointmentWrites += 1;
        return {} as never;
      },
      listUpcomingForCustomer: async () => [],
      listForBusinessDay: async () => [],
    },
    serviceRepository: {
      listByBusiness: async (
        _bId?: string,
        options?: { includeInactive?: boolean },
      ) =>
        options?.includeInactive
          ? services
          : services.filter((s) => s.isActive !== false),
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
      claim: async (bIdOrKey: string, maybeKey?: string) => {
        const key = maybeKey ?? bIdOrKey;
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
    getAppointmentWrites: () => appointmentWrites,
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

    // 10.C2 Fixed price is rendered from the EXACT selected service, never
    // the first priced service in the catalog.
    const hSelectedPrice = createEngineHarness({
      faqs: [],
      services: [
        {
          id: "svc-first",
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
          id: "svc-selected",
          businessId: TENANT_A,
          name: "حشو أسنان",
          description: null,
          durationMinutes: 45,
          priceType: "FIXED",
          priceAmount: 900,
          priceCurrency: "EGP",
          isActive: true,
        },
      ],
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "سعر حشو الأسنان 900 جنيه.",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
          requiredKnowledge: "service.price",
          sourceId: "svc-selected",
        }),
      ],
    });
    const resSelectedPrice = await hSelectedPrice.runInbound(
      "بكام حشو الأسنان؟",
      "ext-sc10-price-selected",
    );
    check(
      "10.C2 Fixed price is rendered from the exact selected service (not the first priced service)",
      resSelectedPrice.ok === true &&
        !resSelectedPrice.duplicate &&
        resSelectedPrice.assistantAction === "AI_REPLY" &&
        resSelectedPrice.conversationStatus === "AI_ACTIVE" &&
        hSelectedPrice.getSent()[0] === "سعر حشو أسنان: 900 جنيه." &&
        !hSelectedPrice.getSent()[0]?.includes("400"),
      resSelectedPrice,
    );

    // 10.C3 RANGE stays a range — never converted into a fixed guarantee.
    const hRangePrice = createEngineHarness({
      faqs: [],
      services: [
        {
          id: "svc-range",
          businessId: TENANT_A,
          name: "علاج عصب",
          description: null,
          durationMinutes: 60,
          priceType: "RANGE",
          priceAmount: 800,
          priceMaxAmount: 1200,
          priceCurrency: "EGP",
          isActive: true,
        },
      ],
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "سعر علاج العصب 1000 جنيه.",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
          requiredKnowledge: "service.price",
          sourceId: "svc-range",
        }),
      ],
    });
    const resRangePrice = await hRangePrice.runInbound(
      "بكام علاج العصب؟",
      "ext-sc10-price-range",
    );
    check(
      "10.C3 RANGE is rendered authoritatively without becoming a fixed price",
      resRangePrice.ok === true &&
        !resRangePrice.duplicate &&
        resRangePrice.assistantAction === "AI_REPLY" &&
        resRangePrice.conversationStatus === "AI_ACTIVE" &&
        hRangePrice.getSent()[0] === "سعر علاج عصب: من 800 إلى 1200 جنيه." &&
        !hRangePrice.getSent()[0]?.includes("1000"),
      resRangePrice,
    );

    // 10.C4 CONDITIONAL ("حسب الحالة") is preserved with no invented number.
    const hConditionalPrice = createEngineHarness({
      faqs: [],
      services: [
        {
          id: "svc-conditional",
          businessId: TENANT_A,
          name: "جلسة تجميل",
          description: null,
          durationMinutes: 45,
          priceType: "CONDITIONAL",
          priceNote: "حسب الحالة",
          isActive: true,
        },
      ],
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "سعر جلسة التجميل 1000 جنيه.",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
          requiredKnowledge: "service.price",
          sourceId: "svc-conditional",
        }),
      ],
    });
    const resConditionalPrice = await hConditionalPrice.runInbound(
      "بكام جلسة التجميل؟",
      "ext-sc10-price-conditional",
    );
    check(
      "10.C4 Case-dependent price is rendered as stored without an invented number",
      resConditionalPrice.ok === true &&
        !resConditionalPrice.duplicate &&
        resConditionalPrice.assistantAction === "AI_REPLY" &&
        resConditionalPrice.conversationStatus === "AI_ACTIVE" &&
        hConditionalPrice.getSent()[0] === "سعر جلسة تجميل: حسب الحالة." &&
        !/\d/.test(hConditionalPrice.getSent()[0] ?? ""),
      resConditionalPrice,
    );

    // 10.C5 A service with NO stored price stays on the safe handoff path.
    const hMissingPrice = createEngineHarness({
      faqs: [],
      services: [
        {
          id: "svc-no-price",
          businessId: TENANT_A,
          name: "استشارة",
          description: null,
          durationMinutes: 20,
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
          content: "سعر الاستشارة 500 جنيه.",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
          requiredKnowledge: "service.price",
          sourceId: "svc-no-price",
        }),
      ],
    });
    const resMissingPrice = await hMissingPrice.runInbound(
      "بكام الاستشارة؟",
      "ext-sc10-price-missing",
    );
    check(
      "10.C5 Missing price is refused to the safe handoff path (no invented number)",
      resMissingPrice.ok === true &&
        !resMissingPrice.duplicate &&
        resMissingPrice.assistantAction === "AI_HANDOFF" &&
        resMissingPrice.conversationStatus === "NEED_HUMAN" &&
        resMissingPrice.handoffCause === "POLICY_REFUSED" &&
        !hMissingPrice.getSent().some((msg) => msg.includes("500")),
      resMissingPrice,
    );

    // 10.C6 A service-price reply without an exact source id is refused.
    const hMissingPriceSource = createEngineHarness({
      faqs: [],
      services: [
        {
          id: "svc-source-required",
          businessId: TENANT_A,
          name: "كشف",
          description: null,
          durationMinutes: 20,
          priceType: "FIXED",
          priceAmount: 300,
          priceCurrency: "EGP",
          isActive: true,
        },
      ],
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "سعر الكشف 300 جنيه.",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
          requiredKnowledge: "service.price",
        }),
      ],
    });
    const resMissingPriceSource = await hMissingPriceSource.runInbound(
      "بكام الكشف؟",
      "ext-sc10-price-missing-source",
    );
    check(
      "10.C6 service.price without the exact source id is refused to the safe handoff path",
      resMissingPriceSource.ok === true &&
        !resMissingPriceSource.duplicate &&
        resMissingPriceSource.assistantAction === "AI_HANDOFF" &&
        resMissingPriceSource.conversationStatus === "NEED_HUMAN" &&
        resMissingPriceSource.handoffCause === "POLICY_REFUSED" &&
        !hMissingPriceSource.getSent().some((msg) => msg.includes("300")),
      resMissingPriceSource,
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

    // 14.8d A service NAME is never accepted as a service-price source id
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
      "14.8d A service name is not accepted as the exact service-price source id",
      resAdv8d.ok === true &&
        !resAdv8d.duplicate &&
        resAdv8d.assistantAction === "AI_HANDOFF" &&
        resAdv8d.conversationStatus === "NEED_HUMAN" &&
        resAdv8d.handoffCause === "POLICY_REFUSED" &&
        resAdv8d.observability?.disclosure?.refusalReason ===
          "UNAVAILABLE_IN_REQUEST" &&
        !hAdv8d.getSent().some((msg) => msg.includes("400")),
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

    // 14.8h Singleton invalid reference -> refused, safe handoff
    let capturedReqAddress: string | undefined;
    const hAdv8h = createEngineHarness({
      businessAddress: "شارع التحرير، الدقي، الجيزة",
      responders: [
        async (req) => {
          if (
            typeof req === "object" &&
            req !== null &&
            "businessAddress" in req &&
            typeof (req as { businessAddress?: unknown }).businessAddress ===
              "string"
          ) {
            capturedReqAddress = (req as { businessAddress: string })
              .businessAddress;
          }
          return {
            intent: "FAQ",
            action: "reply",
            content: "عنوان العيادة في شارع التحرير.",
            extraction: emptyExtraction,
            handoffReason: null,
            summary: null,
            safetyAssessment: "safe",
            knowledgeRef: {
              family: "business.address",
              sourceId: "invalid-bogus-address-ref-999",
            },
          };
        },
      ],
    });
    const resAdv8h = await hAdv8h.runInbound("عنوانكم فين؟", "adv-8h");
    check(
      "14.8h Singleton invalid reference -> refused, safe handoff",
      capturedReqAddress === "شارع التحرير، الدقي، الجيزة" &&
        resAdv8h.ok === true &&
        !resAdv8h.duplicate &&
        resAdv8h.assistantAction === "AI_HANDOFF" &&
        resAdv8h.conversationStatus === "NEED_HUMAN" &&
        resAdv8h.handoffCause === "POLICY_REFUSED",
      { capturedReqAddress, resAdv8h },
    );

    // 14.8i Same-level conflict between knowledgeRef and requiredKnowledge -> refused
    const hAdv8i = createEngineHarness({
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
          content: "سعر تنظيف أسنان 400 جنيه.",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
          knowledgeRef: {
            family: "service.price",
            sourceId: "svc-1",
          },
          requiredKnowledge: "business.faqs", // same-level conflict with knowledgeRef.family!
        }),
      ],
    });
    const resAdv8i = await hAdv8i.runInbound("بكام التنظيف؟", "adv-8i");
    check(
      "14.8i Same-level conflict between knowledgeRef and requiredKnowledge -> refused",
      resAdv8i.ok === true &&
        !resAdv8i.duplicate &&
        resAdv8i.assistantAction === "AI_HANDOFF" &&
        resAdv8i.conversationStatus === "NEED_HUMAN" &&
        resAdv8i.handoffCause === "POLICY_REFUSED",
      resAdv8i,
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
  // 15. KNOWLEDGE-FAMILY CONTRACT, AVAILABILITY & REFUSAL EVIDENCE
  // ────────────────────────────────────────────────────────────────────────────
  {
    const fourServices = [
      {
        id: "svc-cat-1",
        businessId: TENANT_A,
        name: "استشارة أسنان",
        description: "استشارة وتشخيص",
        durationMinutes: 30,
        priceType: "FIXED",
        priceAmount: 300,
        priceCurrency: "EGP",
        isActive: true,
      },
      {
        id: "svc-cat-2",
        businessId: TENANT_A,
        name: "جلسة تجميلية",
        description: null,
        durationMinutes: 45,
        priceType: null,
        priceAmount: null,
        priceCurrency: null,
        isActive: true,
      },
      {
        id: "svc-cat-3",
        businessId: TENANT_A,
        name: "حشو عصب",
        description: null,
        durationMinutes: 60,
        priceType: null,
        priceAmount: null,
        priceCurrency: null,
        isActive: true,
      },
      {
        id: "svc-cat-4",
        businessId: TENANT_A,
        name: "كشف جراحة",
        description: null,
        durationMinutes: 30,
        priceType: null,
        priceAmount: null,
        priceCurrency: null,
        isActive: true,
      },
    ];

    const r6ShapedReply: AiResponse = {
      intent: "FAQ",
      action: "reply",
      content:
        "الخدمات المتاحة: استشارة أسنان، جلسة تجميلية، حشو عصب، وكشف جراحة.",
      extraction: emptyExtraction,
      handoffReason: null,
      summary: null,
      safetyAssessment: "safe",
      goals: [
        { kind: "ANSWER", intent: "FAQ", requiredKnowledge: "service.name" },
        {
          kind: "DOMAIN_ACTION",
          intent: "BOOKING",
          continueAfter: true,
        },
      ],
    };

    // 15.A Four authorized services + empty FAQs + explicit service.name
    // proposal: the catalog is disclosed and the booking goal stays pending.
    const hCatalog = createEngineHarness({
      faqs: [],
      services: fourServices,
      responders: [async () => r6ShapedReply],
    });
    const resCatalog = await hCatalog.runInbound(
      "ممكن أعرف الخدمات المتاحة عندكم وإزاي أبدأ حجز؟",
      "ext-15-catalog",
    );
    const sentCatalog = hCatalog.getSent();
    check(
      "15.A Four authorized services + empty FAQs + explicit service.name -> AI_REPLY with authoritative catalog",
      resCatalog.ok === true &&
        !resCatalog.duplicate &&
        resCatalog.assistantAction === "AI_REPLY" &&
        resCatalog.conversationStatus === "AI_ACTIVE" &&
        resCatalog.handoffCause === null &&
        resCatalog.observability?.disclosure?.allowed === true &&
        resCatalog.observability?.disclosure?.channel === "service.name" &&
        resCatalog.observability?.disclosure?.declaredIntent === "FAQ" &&
        sentCatalog.length === 1 &&
        fourServices.every((service) =>
          sentCatalog[0]!.includes(service.name),
        ) &&
        hCatalog.getProviderInvocations() === 1 &&
        hCatalog.getAppointmentWrites() === 0,
      { resCatalog, sentCatalog },
    );
    const catalogObservability =
      resCatalog.ok && !resCatalog.duplicate ? resCatalog.observability : null;
    check(
      "15.B Services answer + booking continuation preserves one send/model call and the pending booking goal",
      catalogObservability?.answerAndContinue === true &&
        catalogObservability?.pendingGoals?.some(
          (goal) => goal.kind === "DOMAIN_ACTION" && goal.intent === "BOOKING",
        ) === true &&
        catalogObservability?.contextChannels?.servicesCount === 4,
      catalogObservability,
    );

    // 15.C FAQ ledger EXCLUDED while the service catalog is authorized:
    // catalog disclosure must not depend on the FAQ family.
    const builtCatalog = buildAiContext({
      scope: { businessId: TENANT_A },
      sources: {
        business: {
          businessId: TENANT_A,
          name: "مركز رعاية الأسنان التخصصي",
          about: null,
          address: null,
          faqs: [],
        },
        services: fourServices,
        conversation: {
          id: "conv-gate-catalog",
          status: "AI_ACTIVE" as const,
          recentMessages: [],
        },
        message: "ممكن أعرف الخدمات المتاحة عندكم وإزاي أبدأ حجز؟",
        requiredSemanticCapability: "structured_turn",
      },
    });
    const factsWithoutFaqs = builtCatalog.facts.map((fact) =>
      fact.key === "business.faqs"
        ? { ...fact, included: false, disclosable: false }
        : fact,
    );
    const catalogWithoutFaqLedger = enforceDisclosure({
      response: r6ShapedReply,
      context: {
        request: builtCatalog.request,
        facts: factsWithoutFaqs,
        scope: { businessId: TENANT_A },
      },
    });
    check(
      "15.C FAQ ledger excluded -> service.name catalog disclosure remains independent",
      catalogWithoutFaqLedger.kind === "disclosed" &&
        catalogWithoutFaqLedger.support.includes("service.name") &&
        !catalogWithoutFaqLedger.support.includes("business.faqs"),
      catalogWithoutFaqLedger,
    );

    // 15.D A FAQ proposal against an EMPTY FAQ store is UNAVAILABLE, never
    // mislabeled as an excluded family and never sent.
    const hEmptyFaq = createEngineHarness({
      faqs: [],
      services: fourServices,
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "مواعيد العمل من 9 إلى 5.",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
          requiredKnowledge: "business.faqs",
          sourceId: "faq-0",
        }),
      ],
    });
    const resEmptyFaq = await hEmptyFaq.runInbound(
      "مواعيد العمل ايه؟",
      "ext-15-empty-faq",
    );
    check(
      "15.D FAQ proposal with empty FAQ store -> safe POLICY_REFUSED with UNAVAILABLE_IN_REQUEST",
      resEmptyFaq.ok === true &&
        !resEmptyFaq.duplicate &&
        resEmptyFaq.assistantAction === "AI_HANDOFF" &&
        resEmptyFaq.conversationStatus === "NEED_HUMAN" &&
        resEmptyFaq.handoffCause === "POLICY_REFUSED" &&
        resEmptyFaq.observability?.disclosure?.refusalReason ===
          "UNAVAILABLE_IN_REQUEST" &&
        resEmptyFaq.observability?.disclosure?.proposalStatus === "RESOLVED" &&
        resEmptyFaq.observability?.disclosure?.proposedFamily ===
          "business.faqs" &&
        resEmptyFaq.observability?.disclosure?.ledgerIncluded === true &&
        !hEmptyFaq.getSent().some((message) => message.includes("9 إلى 5")),
      { resEmptyFaq, sent: hEmptyFaq.getSent() },
    );

    // 15.E Known service price with a valid source: only the authoritative
    // server-rendered price is emitted, never the model's invented number.
    const hPrice = createEngineHarness({
      faqs: [],
      services: fourServices,
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "سعر الاستشارة 999 جنيه.",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
          requiredKnowledge: "service.price",
          sourceId: "svc-cat-1",
        }),
      ],
    });
    const resPrice = await hPrice.runInbound("بكام الاستشارة؟", "ext-15-price");
    check(
      "15.E Valid service price -> authoritative price rendered, invented number dropped",
      resPrice.ok === true &&
        !resPrice.duplicate &&
        resPrice.assistantAction === "AI_REPLY" &&
        resPrice.conversationStatus === "AI_ACTIVE" &&
        hPrice.getSent().length === 1 &&
        hPrice.getSent()[0]!.includes("300") &&
        !hPrice.getSent()[0]!.includes("999"),
      { resPrice, sent: hPrice.getSent() },
    );
    const priceEvidence = buildTurnEvidence(resPrice, {
      environment: "test",
      appVersion: "0.0.0",
      emittedAt: now,
    });
    check(
      "15.E1 Undeclared single-service scope stays null and allowed, not fabricated catalog",
      priceEvidence.disclosureChannel === "service.price" &&
        priceEvidence.disclosureAllowed === true &&
        priceEvidence.disclosureProposedScope === null &&
        priceEvidence.disclosureRefusalReason === null,
      priceEvidence,
    );

    // 15.E2 Aggregate catalog + prices via the explicit typed catalog scope:
    // one authoritative server-rendered list, all active services, stored
    // price shapes preserved, missing price stated truthfully, no invented
    // number, one model call and one send.
    const catalogPriceServices = [
      {
        id: "svc-cat-fixed",
        businessId: TENANT_A,
        name: "تنظيف أسنان",
        description: null,
        durationMinutes: 30,
        priceType: "FIXED",
        priceAmount: 300,
        priceCurrency: "EGP",
        isActive: true,
      },
      {
        id: "svc-cat-range",
        businessId: TENANT_A,
        name: "حشو عصب",
        description: null,
        durationMinutes: 30,
        priceType: "RANGE",
        priceAmount: 350,
        priceMaxAmount: 600,
        priceCurrency: "EGP",
        isActive: true,
      },
      {
        id: "svc-cat-conditional",
        businessId: TENANT_A,
        name: "جلسة تجميلية",
        description: null,
        durationMinutes: 30,
        priceType: "CONDITIONAL",
        priceNote: "حسب الحالة",
        isActive: true,
      },
      {
        id: "svc-cat-unpriced",
        businessId: TENANT_A,
        name: "كشف جراحة",
        description: null,
        durationMinutes: 30,
        priceType: null,
        isActive: true,
      },
      {
        id: "svc-cat-inactive",
        businessId: TENANT_A,
        name: "خدمة موقوفة",
        description: null,
        durationMinutes: 30,
        priceType: "FIXED",
        priceAmount: 888,
        priceCurrency: "EGP",
        isActive: false,
      },
    ];
    const hCatalogPrice = createEngineHarness({
      faqs: [],
      services: catalogPriceServices,
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "الأسعار تبدأ من 999 جنيه.",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
          requiredKnowledge: "service.price",
          knowledgeRef: {
            family: "service.price",
            scope: "catalog" as const,
          },
        }),
      ],
    });
    const resCatalogPrice = await hCatalogPrice.runInbound(
      "ممكن أعرف الخدمات المتاحة وسعر كل خدمة؟",
      "ext-15-catalog-price",
    );
    const sentCatalogPrice = hCatalogPrice.getSent();
    check(
      "15.E2 Aggregate catalog+prices -> authoritative list, truthful missing price, no invention",
      resCatalogPrice.ok === true &&
        !resCatalogPrice.duplicate &&
        resCatalogPrice.assistantAction === "AI_REPLY" &&
        resCatalogPrice.conversationStatus === "AI_ACTIVE" &&
        resCatalogPrice.handoffCause === null &&
        resCatalogPrice.observability?.disclosure?.allowed === true &&
        resCatalogPrice.observability?.disclosure?.channel ===
          "service.price" &&
        sentCatalogPrice.length === 1 &&
        sentCatalogPrice[0]!.includes("تنظيف أسنان") &&
        sentCatalogPrice[0]!.includes("حشو عصب") &&
        sentCatalogPrice[0]!.includes("جلسة تجميلية") &&
        sentCatalogPrice[0]!.includes("كشف جراحة") &&
        sentCatalogPrice[0]!.includes("300 جنيه") &&
        sentCatalogPrice[0]!.includes("من 350 إلى 600 جنيه") &&
        sentCatalogPrice[0]!.includes("حسب الحالة") &&
        sentCatalogPrice[0]!.includes(SERVICE_PRICE_UNAVAILABLE_TEXT) &&
        !sentCatalogPrice[0]!.includes("999") &&
        !sentCatalogPrice[0]!.includes("888") &&
        !sentCatalogPrice[0]!.includes("خدمة موقوفة") &&
        hCatalogPrice.getProviderInvocations() === 1 &&
        hCatalogPrice.getAppointmentWrites() === 0 &&
        hCatalogPrice.getAttention().size === 0,
      { resCatalogPrice, sentCatalogPrice },
    );
    const catalogPriceEvidence = buildTurnEvidence(resCatalogPrice, {
      environment: "test",
      appVersion: "0.0.0",
      emittedAt: now,
    });
    check(
      "15.E3 Successful catalog reply exposes allowed service.price + catalog scope evidence",
      catalogPriceEvidence.disclosureChannel === "service.price" &&
        catalogPriceEvidence.disclosureAllowed === true &&
        catalogPriceEvidence.disclosureProposedScope === "catalog" &&
        catalogPriceEvidence.disclosureProposedFamily === null &&
        catalogPriceEvidence.disclosureRefusalReason === null,
      catalogPriceEvidence,
    );

    // 15.F Missing service price or a cross-tenant source: no fabricated
    // price, no tenant leakage, safe refusal.
    const hMissingPrice = createEngineHarness({
      faqs: [],
      services: fourServices,
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "سعر الجلسة 1500 جنيه.",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
          requiredKnowledge: "service.price",
          sourceId: "svc-cat-2",
        }),
      ],
    });
    const resMissingPrice = await hMissingPrice.runInbound(
      "بكام الجلسة التجميلية؟",
      "ext-15-missing-price",
    );
    check(
      "15.F Missing price -> safe refusal with no fabricated number",
      resMissingPrice.ok === true &&
        !resMissingPrice.duplicate &&
        resMissingPrice.assistantAction === "AI_HANDOFF" &&
        resMissingPrice.conversationStatus === "NEED_HUMAN" &&
        resMissingPrice.handoffCause === "POLICY_REFUSED" &&
        !hMissingPrice.getSent().some((message) => message.includes("1500")),
      { resMissingPrice, sent: hMissingPrice.getSent() },
    );

    const hCrossTenant = createEngineHarness({
      faqs: [],
      services: [
        ...fourServices,
        {
          id: "svc-other-tenant",
          businessId: "biz-other-tenant",
          name: "خدمة منشأة أخرى",
          description: null,
          durationMinutes: 30,
          priceType: "FIXED",
          priceAmount: 999,
          priceCurrency: "EGP",
          isActive: true,
        },
      ],
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "سعر الخدمة 999 جنيه.",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
          requiredKnowledge: "service.price",
          sourceId: "svc-other-tenant",
        }),
      ],
    });
    const resCrossTenant = await hCrossTenant.runInbound(
      "بكام خدمة المنشأة الأخرى؟",
      "ext-15-cross-tenant",
    );
    check(
      "15.G Cross-tenant service source -> no price/name leakage, safe refusal",
      resCrossTenant.ok === true &&
        !resCrossTenant.duplicate &&
        resCrossTenant.assistantAction === "AI_HANDOFF" &&
        resCrossTenant.conversationStatus === "NEED_HUMAN" &&
        resCrossTenant.handoffCause === "POLICY_REFUSED" &&
        !hCrossTenant
          .getSent()
          .some(
            (message) =>
              message.includes("999") || message.includes("خدمة منشأة أخرى"),
          ),
      { resCrossTenant, sent: hCrossTenant.getSent() },
    );

    // 15.H Unknown family, conflicting declarations and missing metadata are
    // distinguishable, fail closed, and never expose the raw model label.
    const hUnknown = createEngineHarness({
      faqs: [],
      services: fourServices,
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "الخدمات المتاحة: استشارة أسنان.",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
          requiredKnowledge: "service.availability",
        }),
      ],
    });
    const resUnknown = await hUnknown.runInbound(
      "الخدمات المتاحة ايه؟",
      "ext-15-unknown-family",
    );
    check(
      "15.H Unknown structured family -> UNKNOWN_KNOWLEDGE_FAMILY, not EXCLUDED_FROM_CONTEXT",
      resUnknown.ok === true &&
        !resUnknown.duplicate &&
        resUnknown.assistantAction === "AI_HANDOFF" &&
        resUnknown.conversationStatus === "NEED_HUMAN" &&
        resUnknown.handoffCause === "POLICY_REFUSED" &&
        resUnknown.observability?.disclosure?.refusalReason ===
          "UNKNOWN_KNOWLEDGE_FAMILY" &&
        resUnknown.observability?.disclosure?.proposalStatus ===
          "UNKNOWN_FAMILY" &&
        resUnknown.observability?.disclosure?.proposedFamily === "UNKNOWN",
      resUnknown,
    );

    const hConflict = createEngineHarness({
      faqs: [],
      services: fourServices,
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "سعر الاستشارة 300 جنيه.",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
          knowledgeRef: { family: "service.price", sourceId: "svc-cat-1" },
          requiredKnowledge: "business.faqs",
        }),
      ],
    });
    const resConflict = await hConflict.runInbound(
      "بكام الاستشارة؟",
      "ext-15-conflict",
    );
    check(
      "15.I Conflicting family declarations -> AMBIGUOUS_MATCH with CONFLICT evidence",
      resConflict.ok === true &&
        !resConflict.duplicate &&
        resConflict.assistantAction === "AI_HANDOFF" &&
        resConflict.conversationStatus === "NEED_HUMAN" &&
        resConflict.observability?.disclosure?.refusalReason ===
          "AMBIGUOUS_MATCH" &&
        resConflict.observability?.disclosure?.proposalStatus === "CONFLICT" &&
        resConflict.observability?.disclosure?.proposedFamily === null,
      resConflict,
    );

    const hMissingFamily = createEngineHarness({
      faqs: [],
      services: fourServices,
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "الخدمات المتاحة: استشارة أسنان.",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
        }),
      ],
    });
    const resMissingFamily = await hMissingFamily.runInbound(
      "الخدمات المتاحة ايه؟",
      "ext-15-missing-family",
    );
    check(
      "15.J Missing family metadata -> UNAVAILABLE_IN_REQUEST with MISSING evidence",
      resMissingFamily.ok === true &&
        !resMissingFamily.duplicate &&
        resMissingFamily.assistantAction === "AI_HANDOFF" &&
        resMissingFamily.conversationStatus === "NEED_HUMAN" &&
        resMissingFamily.observability?.disclosure?.refusalReason ===
          "UNAVAILABLE_IN_REQUEST" &&
        resMissingFamily.observability?.disclosure?.proposalStatus ===
          "MISSING" &&
        resMissingFamily.observability?.disclosure?.proposedFamily === null,
      resMissingFamily,
    );

    // 15.K domain.availability in a model-authored reply: explicit safe
    // refusal; no invented slots, even when availability was carried.
    const builtAvailability = buildAiContext({
      scope: { businessId: TENANT_A },
      sources: {
        business: {
          businessId: TENANT_A,
          name: "مركز رعاية الأسنان التخصصي",
          about: null,
          address: null,
          faqs: [],
        },
        services: fourServices,
        conversation: {
          id: "conv-gate-availability",
          status: "AI_ACTIVE" as const,
          recentMessages: [],
        },
        message: "عايز أحجز موعد بكرة",
        availability: [{ date: "2026-11-15", slots: ["10:00", "11:00"] }],
        requiredSemanticCapability: "structured_turn",
      },
    });
    const modelAvailabilityReply: AiResponse = {
      intent: "FAQ",
      action: "reply",
      content: "المواعيد المتاحة: 10:00 و11:00.",
      extraction: emptyExtraction,
      handoffReason: null,
      summary: null,
      safetyAssessment: "safe",
      requiredKnowledge: "domain.availability",
    };
    const availabilityDecision = enforceDisclosure({
      response: modelAvailabilityReply,
      context: {
        request: builtAvailability.request,
        facts: builtAvailability.facts,
        scope: { businessId: TENANT_A },
      },
    });
    check(
      "15.K Model-authored domain.availability -> explicit NOT_DISCLOSABLE, no invented slots",
      availabilityDecision.kind === "requires-human" &&
        availabilityDecision.reason === "NOT_DISCLOSABLE" &&
        availabilityDecision.diagnostics.proposalStatus === "RESOLVED" &&
        availabilityDecision.diagnostics.proposedFamily ===
          "domain.availability" &&
        availabilityDecision.diagnostics.ledgerIncluded === true &&
        availabilityDecision.diagnostics.ledgerDisclosable === true,
      availabilityDecision,
    );

    const builtNoAvailability = buildAiContext({
      scope: { businessId: TENANT_A },
      sources: {
        business: {
          businessId: TENANT_A,
          name: "مركز رعاية الأسنان التخصصي",
          about: null,
          address: null,
          faqs: [],
        },
        services: fourServices,
        conversation: {
          id: "conv-gate-no-availability",
          status: "AI_ACTIVE" as const,
          recentMessages: [],
        },
        message: "عايز أحجز موعد بكرة",
        requiredSemanticCapability: "structured_turn",
      },
    });
    const missingAvailabilityDecision = enforceDisclosure({
      response: modelAvailabilityReply,
      context: {
        request: builtNoAvailability.request,
        facts: builtNoAvailability.facts,
        scope: { businessId: TENANT_A },
      },
    });
    check(
      "15.L Missing/uncomputed domain.availability -> UNAVAILABLE_IN_REQUEST, no slot invention",
      missingAvailabilityDecision.kind === "requires-human" &&
        missingAvailabilityDecision.reason === "UNAVAILABLE_IN_REQUEST" &&
        missingAvailabilityDecision.diagnostics.ledgerIncluded === null,
      missingAvailabilityDecision,
    );

    // 15.M Refusal evidence distinguishes declared intent, proposed family
    // and rejection cause while remaining content-free.
    const emptyFaqEvidence = buildTurnEvidence(resEmptyFaq, {
      environment: "test",
      appVersion: "0.0.0",
      emittedAt: now,
    });
    const unknownEvidence = buildTurnEvidence(resUnknown, {
      environment: "test",
      appVersion: "0.0.0",
      emittedAt: now,
    });
    check(
      "15.M Empty-FAQ evidence: legacy channel + proposed family + ledger verdict are distinct",
      emptyFaqEvidence.disclosureChannel === "business.faqs" &&
        emptyFaqEvidence.disclosureDeclaredIntent === "FAQ" &&
        emptyFaqEvidence.disclosureProposedFamily === "business.faqs" &&
        emptyFaqEvidence.disclosureProposalStatus === "RESOLVED" &&
        emptyFaqEvidence.disclosureRefusalReason === "UNAVAILABLE_IN_REQUEST" &&
        emptyFaqEvidence.disclosureLedgerIncluded === true,
      emptyFaqEvidence,
    );
    check(
      "15.N Unknown-family evidence exposes UNKNOWN, never the raw model label/content",
      unknownEvidence.disclosureChannel === "UNKNOWN" &&
        unknownEvidence.disclosureDeclaredIntent === "FAQ" &&
        unknownEvidence.disclosureProposedFamily === "UNKNOWN" &&
        unknownEvidence.disclosureProposalStatus === "UNKNOWN_FAMILY" &&
        unknownEvidence.disclosureRefusalReason ===
          "UNKNOWN_KNOWLEDGE_FAMILY" &&
        !JSON.stringify(unknownEvidence).includes("service.availability") &&
        !JSON.stringify(unknownEvidence).includes(
          "الخدمات المتاحة: استشارة أسنان.",
        ),
      unknownEvidence,
    );

    // 15.O A proposed SERVICE family is the channel the gate actually
    // evaluated (pure evidence projection fixture; this does NOT claim the
    // historical R6 proposal).
    const serviceFamilyEvidence = buildTurnEvidence(
      {
        ok: true,
        assistantAction: "AI_HANDOFF",
        intent: null,
        conversationStatus: "NEED_HUMAN",
        handoffCause: "POLICY_REFUSED",
        assistantProvider: "fixture",
        observability: {
          disclosure: {
            channel: "service.name",
            allowed: false,
            refusalReason: "EXCLUDED_FROM_CONTEXT",
            declaredIntent: "FAQ",
            proposedFamily: "service.name",
            proposalStatus: "RESOLVED",
            ledgerIncluded: false,
            ledgerDisclosable: false,
          },
        },
      },
      { environment: "test", appVersion: "0.0.0", emittedAt: now },
    );
    check(
      "15.O Proposed service family is retained as the evaluated disclosure channel",
      serviceFamilyEvidence.disclosureChannel === "service.name" &&
        serviceFamilyEvidence.disclosureProposedFamily === "service.name" &&
        serviceFamilyEvidence.disclosureProposalStatus === "RESOLVED" &&
        serviceFamilyEvidence.disclosureLedgerIncluded === false &&
        serviceFamilyEvidence.disclosureLedgerDisclosable === false,
      serviceFamilyEvidence,
    );
  }

  // ────────────────────────────────────────────────────────────────────────────
  // 16. IDENTITY PROPOSAL AUTHORITY + CANONICAL VOCABULARY CONSISTENCY
  // ────────────────────────────────────────────────────────────────────────────
  {
    const identityBuilt = buildAiContext({
      scope: { businessId: TENANT_A },
      sources: {
        business: {
          businessId: TENANT_A,
          name: "مركز رعاية الأسنان التخصصي",
          about: null,
          address: null,
          faqs: [],
        },
        services: [],
        conversation: {
          id: "conv-gate-identity",
          status: "AI_ACTIVE" as const,
          recentMessages: [],
        },
        message: "ما اسم العيادة؟",
        requiredSemanticCapability: "structured_turn",
      },
    });

    function identityReply(overrides: Partial<AiResponse> = {}): AiResponse {
      return {
        intent: "FAQ",
        action: "reply",
        content: "اسم العيادة هو مركز رعاية الأسنان التخصصي.",
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
        ...overrides,
      };
    }
    function identityDecision(overrides: Partial<AiResponse> = {}) {
      return enforceDisclosure({
        response: identityReply(overrides),
        context: {
          request: identityBuilt.request,
          facts: identityBuilt.facts,
          scope: { businessId: TENANT_A },
        },
      });
    }

    // A. Compatible top-level identity declaration + identity goal.
    const validIdentity = identityDecision({
      requiredKnowledge: "business.identity",
    });
    check(
      "16.A Compatible identity goal + top-level declaration -> authoritative identity answer",
      validIdentity.kind === "disclosed" &&
        validIdentity.support.includes("business.identity") &&
        validIdentity.renderedContent?.includes(
          "مركز رعاية الأسنان التخصصي",
        ) === true,
      validIdentity,
    );

    // B. Identity goal + contradictory top-level family -> conflict, not identity.
    const conflictingIdentity = identityDecision({
      requiredKnowledge: "business.faqs",
    });
    check(
      "16.B Identity goal + contradictory top-level family -> AMBIGUOUS_MATCH / CONFLICT",
      conflictingIdentity.kind === "requires-human" &&
        conflictingIdentity.reason === "AMBIGUOUS_MATCH" &&
        conflictingIdentity.diagnostics.proposalStatus === "CONFLICT" &&
        conflictingIdentity.diagnostics.proposedFamily === null &&
        !("content" in conflictingIdentity),
      conflictingIdentity,
    );

    // C. Identity goal + unknown top-level family -> unknown-family refusal.
    const unknownIdentity = identityDecision({
      requiredKnowledge: "service.availability",
    });
    check(
      "16.C Identity goal + unknown top-level family -> UNKNOWN_KNOWLEDGE_FAMILY",
      unknownIdentity.kind === "requires-human" &&
        unknownIdentity.reason === "UNKNOWN_KNOWLEDGE_FAMILY" &&
        unknownIdentity.diagnostics.proposalStatus === "UNKNOWN_FAMILY" &&
        unknownIdentity.diagnostics.proposedFamily === "UNKNOWN" &&
        !("content" in unknownIdentity),
      unknownIdentity,
    );

    // D. Identity goal + conflicting structured source references -> conflict.
    const sourceConflictIdentity = identityDecision({
      sourceId: "foreign-source",
      goals: [
        {
          kind: "ANSWER",
          intent: "FAQ",
          requiredKnowledge: "business.identity",
          knowledgeRef: {
            family: "business.identity",
            sourceId: "business.identity",
          },
        },
      ],
    });
    check(
      "16.D Identity goal + conflicting structured source references -> AMBIGUOUS_MATCH / CONFLICT",
      sourceConflictIdentity.kind === "requires-human" &&
        sourceConflictIdentity.reason === "AMBIGUOUS_MATCH" &&
        sourceConflictIdentity.diagnostics.proposalStatus === "CONFLICT" &&
        !("content" in sourceConflictIdentity),
      sourceConflictIdentity,
    );

    // E. Identity goal + foreign/invalid singleton source -> safe refusal.
    const foreignSourceIdentity = identityDecision({
      requiredKnowledge: "business.identity",
      sourceId: "foreign-source",
    });
    check(
      "16.E Identity goal + foreign/invalid source -> UNAVAILABLE_IN_REQUEST",
      foreignSourceIdentity.kind === "requires-human" &&
        foreignSourceIdentity.reason === "UNAVAILABLE_IN_REQUEST" &&
        foreignSourceIdentity.diagnostics.proposalStatus === "RESOLVED" &&
        foreignSourceIdentity.diagnostics.proposedFamily ===
          "business.identity" &&
        foreignSourceIdentity.diagnostics.ledgerIncluded === true,
      foreignSourceIdentity,
    );

    // Engine-level coverage of the important refusal path: the conflicting
    // identity proposal must produce one safe acknowledgment and never the
    // model-authored identity text or an appointment write.
    const hIdentityConflict = createEngineHarness({
      faqs: [],
      services: [],
      responders: [
        async () => identityReply({ requiredKnowledge: "business.faqs" }),
      ],
    });
    const resIdentityConflict = await hIdentityConflict.runInbound(
      "ما اسم العيادة؟",
      "ext-16-identity-conflict",
    );
    const sentIdentityConflict = hIdentityConflict.getSent();
    check(
      "16.F Engine identity conflict -> POLICY_REFUSED, one safe ack, no model text, zero appointment writes",
      resIdentityConflict.ok === true &&
        !resIdentityConflict.duplicate &&
        resIdentityConflict.assistantAction === "AI_HANDOFF" &&
        resIdentityConflict.conversationStatus === "NEED_HUMAN" &&
        resIdentityConflict.handoffCause === "POLICY_REFUSED" &&
        sentIdentityConflict.length === 1 &&
        sentIdentityConflict[0] === SAFE_HANDOFF_REPLIES.DISCLOSURE_REFUSED &&
        !sentIdentityConflict[0]!.includes("اسم العيادة هو") &&
        hIdentityConflict.getAppointmentWrites() === 0,
      { resIdentityConflict, sentIdentityConflict },
    );

    // Exhaustive canonical vocabulary/resolver consistency, using the
    // canonical definitions directly (no duplicated unchecked list).
    const unresolvedFamilies: string[] = [];
    for (const family of knowledgeFamilyValues) {
      const resolved = supportFamilyForProposedKnowledge(family);
      if (
        !resolved ||
        resolved === "GENERIC_FAQ" ||
        resolved.family !== family
      ) {
        unresolvedFamilies.push(family);
      }
    }
    check(
      "16.G Every canonical knowledgeFamilyValues entry resolves to itself",
      unresolvedFamilies.length === 0,
      unresolvedFamilies,
    );
    const authorableFamiliesAreCanonical =
      modelAuthorableKnowledgeFamilyValues.every((family) =>
        (knowledgeFamilyValues as readonly string[]).includes(family),
      );
    const authorableFamiliesExcludeDomain =
      !(modelAuthorableKnowledgeFamilyValues as readonly string[]).includes(
        "domain.availability",
      ) &&
      !(modelAuthorableKnowledgeFamilyValues as readonly string[]).includes(
        "business.cancellationPolicy",
      );
    check(
      "16.H Model-authorable families are a supported subset and exclude domain-owned families",
      authorableFamiliesAreCanonical && authorableFamiliesExcludeDomain,
    );
    const serviceCatalogAlias =
      supportFamilyForProposedKnowledge("service.catalog");
    const serviceCatalogAliasIsCanonical =
      typeof serviceCatalogAlias === "object" &&
      serviceCatalogAlias !== null &&
      serviceCatalogAlias.family === "service.name";
    check(
      "16.I Existing service.catalog alias still resolves to service.name",
      serviceCatalogAliasIsCanonical,
    );
    check(
      "16.J Unsupported structured label still resolves as unknown",
      supportFamilyForProposedKnowledge("service.availability") === null,
    );

    // Cancellation policy is a RECOGNIZED family (not UNKNOWN) but remains
    // domain/handoff-owned: the gate must return its explicit safe refusal.
    const cancellationReply: AiResponse = {
      intent: "FAQ",
      action: "reply",
      content: "يمكنك إلغاء الموعد قبل 24 ساعة.",
      extraction: emptyExtraction,
      handoffReason: null,
      summary: null,
      safetyAssessment: "safe",
      requiredKnowledge: "business.cancellationPolicy",
    };
    const cancellationDecision = enforceDisclosure({
      response: cancellationReply,
      context: {
        request: identityBuilt.request,
        facts: identityBuilt.facts,
        scope: { businessId: TENANT_A },
      },
    });
    check(
      "16.K cancellationPolicy -> recognized safe refusal, not UNKNOWN_KNOWLEDGE_FAMILY",
      cancellationDecision.kind === "requires-human" &&
        cancellationDecision.reason === "UNAVAILABLE_IN_REQUEST" &&
        cancellationDecision.diagnostics.proposalStatus === "RESOLVED" &&
        cancellationDecision.diagnostics.proposedFamily ===
          "business.cancellationPolicy" &&
        cancellationDecision.diagnostics.ledgerIncluded === false,
      cancellationDecision,
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
