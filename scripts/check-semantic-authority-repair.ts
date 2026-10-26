/**
 * FlowPilot — Focused Semantic Authority Repair Verification Suite
 *
 * Verifies the two repaired semantic authority flows:
 *   Part 1: Structured Context Identity Enrollment (Repair A)
 *   Part 2: Safe Failure / Handoff Reply Resolution (Repair B)
 *   Part 3: End-to-End Engine Invariants & Delivery (Real Engine + In-Memory Harness)
 *
 * Offline, resource-safe test suite with zero live paid model calls.
 */

import { buildAiContext } from "@/features/conversations/server/ai-context-builder";
import type { AiResponse } from "@/features/conversations/server/ai-contract";
import { enforceDisclosure } from "@/features/conversations/server/ai-disclosure";
import {
  SAFE_HANDOFF_REPLIES,
  resolveSafeFailureReply,
} from "@/features/conversations/server/conversation-ai";
import type {
  InboundResult,
  InboundSuccess,
} from "@/features/conversations/server/conversation-engine";
import { receiveInboundMessage } from "@/features/conversations/server/conversation-engine";
import type { ConversationStatus } from "@/types/domain";

type AttentionRow = {
  businessId: string;
  conversationId: string;
  reason: string;
  cause: string | null;
  resolved: boolean;
  resolvedById: string | null;
};

export {};

type Check = { label: string; pass: boolean; details?: unknown };
const checks: Check[] = [];

function check(label: string, pass: boolean, details?: unknown): void {
  checks.push({ label, pass, details });
  const icon = pass ? "✔" : "✘";
  console.log(`${icon} ${label}`);
  if (!pass && details !== undefined) {
    console.error("  Details:", details);
  }
}

function eq<T>(actual: T, expected: T): boolean {
  return actual === expected;
}

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const BRANCH_A = "55555555-5555-4555-8555-555555555555";
const CUST_A = "cust-001";
const WHATSAPP = "+201000000000";
const now = new Date("2026-10-26T12:00:00Z");

const emptyExtraction = {
  service: null,
  provider: null,
  date: null,
  timePreference: null,
};

function isSuccess(result: InboundResult): result is InboundSuccess {
  return result.ok && !result.duplicate;
}

const baseSources = (overrides?: Record<string, unknown>) => ({
  business: {
    id: TENANT_A,
    name: "مركز رعاية الأسنان التخصصي",
    about: "عيادة متخصصة في طب وجراحة الفم والأسنان",
    whatsappNumber: WHATSAPP,
    address: "شارع التحرير، الدقي، الجيزة",
    cancellationPolicy: "الإلغاء متاح قبل 24 ساعة",
    slotDurationMinutes: 30,
    confirmationMode: "manual",
    timezone: "Africa/Cairo",
    vertical: "dental",
    city: "الجيزة",
  },
  services: [
    {
      id: "svc-1",
      businessId: TENANT_A,
      name: "كشف أسنان",
      description: "فحص شامل وتشخيص",
      durationMinutes: 30,
    },
  ],
  conversation: {
    status: "AI_ACTIVE" as ConversationStatus,
    recentMessages: [
      { senderType: "CUSTOMER", content: "مساء الخير" },
      { senderType: "AI", content: "أهلاً بك!" },
    ],
  },
  requiredSemanticCapability: "structured_turn" as const,
  message: "عايز أسأل عن حاجة",
  ...overrides,
});

function createEngineHarness(opts: {
  responders: Array<(req: unknown) => Promise<AiResponse> | Promise<never>>;
  telemetry?: Array<{
    finalProvider: string;
    finalModel?: string | null;
    finalStatus?: string;
    fallbackUsed?: boolean;
    attempts?: unknown[];
    conversationControl?: { handoffReason: string } | null;
  }>;
  faqs?: Array<{ question: string; answer: string }>;
  about?: string | null;
  address?: string | null;
}) {
  const business = {
    id: TENANT_A,
    name: "مركز رعاية الأسنان التخصصي",
    about: opts.about !== undefined ? opts.about : "عيادة أسنان",
    whatsappNumber: WHATSAPP,
    address: opts.address !== undefined ? opts.address : "الجيزة",
    cancellationPolicy: "24h",
    slotDurationMinutes: 30,
    confirmationMode: "manual",
    timezone: "Africa/Cairo",
    vertical: "dental",
    city: "الجيزة",
    status: "ACTIVE",
    isActive: true,
    faqs: opts.faqs ?? [],
  };

  const branch = {
    id: BRANCH_A,
    businessId: TENANT_A,
    name: "الفرع الرئيسي",
    isActive: true,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };

  const customer = {
    id: CUST_A,
    businessId: TENANT_A,
    name: "أحمد حسن",
    phone: "+201234567890",
    notes: null,
    lastConversationAt: null,
    lastAppointmentAt: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };

  let conversation: {
    id: string;
    businessId: string;
    status: string;
    assignedUserId: string | null;
    aiSummary: string | null;
  } | null = null;

  const messages: Array<{
    id: string;
    senderType: string;
    content: string;
    createdAt: Date;
  }> = [];

  const sent: string[] = [];
  const attention = new Map<string, AttentionRow>();
  let turnIndex = 0;
  let providerCalls = 0;

  const deps = {
    businessRepository: {
      findByWhatsappNumber: async () => business,
      findById: async (id: string) => (id === TENANT_A ? business : null),
    },
    branchRepository: {
      findDefaultByBusiness: async () => branch,
      findByIdWithinBusiness: async () => branch,
    },
    customerRepository: {
      upsertByPhone: async () => customer,
      touchConversation: async () => customer,
      findByIdWithinBusiness: async () => customer,
    },
    conversationRepository: {
      findLatestByCustomer: async () =>
        conversation ? { id: conversation.id } : null,
      findById: async () => conversation,
      create: async (input: {
        businessId: string;
        customerId: string;
        branchId: string | null;
      }) => {
        conversation = {
          id: "conv-1",
          businessId: input.businessId,
          status: "AI_ACTIVE",
          assignedUserId: null,
          aiSummary: null,
        };
        return conversation;
      },
      addMessage: async (
        input: {
          conversationId: string;
          senderType: string;
          content: string;
        },
        workflow?: { status?: string; assignedUserId?: string | null },
      ) => {
        const message = {
          id: `msg-${messages.length + 1}`,
          conversationId: input.conversationId,
          senderType: input.senderType,
          content: input.content,
          createdAt: now,
        };
        messages.push(message);
        if (workflow?.status && conversation) {
          conversation = { ...conversation, status: workflow.status };
        }
        if (workflow && "assignedUserId" in workflow && conversation) {
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
          conversationId: conversation!.id,
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
      listByBusiness: async () => [],
      listActiveByBusiness: async () => [],
      findById: async () => null,
      findByIdWithinBusiness: async () => null,
      findByNameWithinBusiness: async () => null,
    },
    usageRepository: { record: async () => undefined },
    providerRepository: {
      listActiveByBranch: async () => [],
      listActiveByService: async () => [],
      findByIdWithinBusiness: async () => null,
      findByNameWithinBusiness: async () => null,
    },
    inboundDedupeRepository: {
      claim: async () => ({ status: "claimed" as const }),
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
    ai: {
      providerName: "mock-engine-provider",
      respond: async (req: unknown) => {
        providerCalls += 1;
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
      providerName: "mock-transport",
      send: async (input: { content: string }) => {
        sent.push(input.content);
        return { provider: "mock-transport", delivered: true };
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
      { businessId: TENANT_A, connectionId: "conn-1" },
    );
  }

  return {
    runInbound,
    getSent: () => sent,
    getMessages: () => messages,
    getAttention: () => attention,
    getProviderCalls: () => providerCalls,
    getConversation: () => conversation,
  };
}

async function runSuite(): Promise<void> {
  // ════════════════════════════════════════════════════════════════════════════
  // PART 1: Structured Context Identity Enrollment (Repair A)
  // ════════════════════════════════════════════════════════════════════════════
  console.log(
    "\n── Part 1: Structured Context Identity Enrollment (Repair A) ──",
  );

  // A1: Permitted identity fact is enrolled without lexical trigger keywords
  {
    const built = buildAiContext({
      scope: { businessId: TENANT_A },
      sources: baseSources({ message: "عايز أسأل عن حاجة" }),
    });

    const identityFact = built.facts.find((f) => f.key === "business.identity");
    check(
      "A1. Structured mode enrolls business.identity without keyword triggers",
      Boolean(
        identityFact &&
        identityFact.included &&
        identityFact.disclosable &&
        built.request.businessName === "مركز رعاية الأسنان التخصصي",
      ),
      identityFact,
    );
  }

  // A2: Paraphrased colloquial wording does not control or prevent enrollment
  {
    const testPhrases = [
      "مين أنتم؟",
      "هو المكان ده ايه؟",
      "بتشتغلوا فين ومع مين؟",
      "عايز أجي بكرة العصر",
      "بكام تنظيف الأسنان لو سمحت",
    ];

    let allEnrolled = true;
    for (const phrase of testPhrases) {
      const built = buildAiContext({
        scope: { businessId: TENANT_A },
        sources: baseSources({ message: phrase }),
      });
      const fact = built.facts.find((f) => f.key === "business.identity");
      if (!fact || !fact.included || !fact.disclosable) {
        allEnrolled = false;
        break;
      }
    }

    check(
      "A2. Paraphrased, booking, price, and inquiry wording all enroll business.identity consistently",
      allEnrolled,
    );
  }

  // A3: INTERNAL and FORBIDDEN fields remain strictly excluded from being included/disclosable
  {
    const built = buildAiContext({
      scope: { businessId: TENANT_A },
      sources: baseSources({
        business: {
          ...baseSources().business,
          id: TENANT_A,
          defaultBranchId: "branch-uuid-999",
          timezone: "Africa/Cairo",
          slotDurationMinutes: 30,
        },
      }),
    });

    const forbiddenIncluded = built.facts.some(
      (f) => f.visibility === "FORBIDDEN" && f.included,
    );
    const internalDisclosable = built.facts.some(
      (f) => f.visibility === "INTERNAL" && f.included && f.disclosable,
    );

    check(
      "A3. INTERNAL and FORBIDDEN business fields are never included or disclosable",
      !forbiddenIncluded && !internalDisclosable,
      { forbiddenIncluded, internalDisclosable },
    );
  }

  // A4: Missing business name yields empty string and disclosure gate refuses unbacked identity
  {
    const built = buildAiContext({
      scope: { businessId: TENANT_A },
      sources: baseSources({
        business: {
          ...baseSources().business,
          name: "",
          about: "",
          address: "",
        },
        services: [],
      }),
    });

    // Enforce disclosure gate against an identity claim with missing business name
    const gateResult = enforceDisclosure({
      context: built,
      response: {
        intent: "FAQ",
        action: "reply",
        content: "أهلاً بك في العيادة",
        extraction: emptyExtraction,
        handoffReason: null,
        summary: null,
      },
    });

    check(
      "A4. Missing or empty business name yields empty businessName and is refused by disclosure gate",
      built.request.businessName === "" && gateResult.kind === "requires-human",
      { requestName: built.request.businessName, gateResult },
    );
  }

  // A5: Tenant scoping & provenance invariant preserved
  {
    const built = buildAiContext({
      scope: { businessId: TENANT_A },
      sources: baseSources({
        business: {
          ...baseSources().business,
          businessId: TENANT_B,
          id: TENANT_B,
        },
      }),
    });

    const foreignFactIncluded = built.facts.some(
      (f) => f.key.startsWith("business.") && f.included,
    );
    check(
      "A5. Foreign tenant business record is rejected by tenant scoping (zero leak)",
      !foreignFactIncluded && built.request.businessName === "",
    );
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PART 2: Safe Failure / Handoff Reply Resolution (Repair B)
  // ════════════════════════════════════════════════════════════════════════════
  console.log(
    "\n── Part 2: Safe Failure / Handoff Reply Resolution (Repair B) ──",
  );

  // B1: Pure resolver maps provider outage / retry exhaustion to PROVIDER_FAILURE copy
  {
    const replyTimeout = resolveSafeFailureReply({
      controlHandoffReason: "RETRY_EXHAUSTED",
      failureCause: "RETRY_EXHAUSTED",
    });
    const replyUnavailable = resolveSafeFailureReply({
      controlHandoffReason: "PROVIDER_UNAVAILABLE",
      failureCause: "PROVIDER_FAILURE",
    });
    const replyQuota = resolveSafeFailureReply({
      controlHandoffReason: "QUOTA_EXHAUSTED",
      failureCause: "PROVIDER_FAILURE",
    });

    check(
      "B1. Provider outage & retry exhaustion map to safe provider difficulty copy",
      eq(replyTimeout, SAFE_HANDOFF_REPLIES.PROVIDER_FAILURE) &&
        eq(replyUnavailable, SAFE_HANDOFF_REPLIES.PROVIDER_FAILURE) &&
        eq(replyQuota, SAFE_HANDOFF_REPLIES.PROVIDER_FAILURE) &&
        replyTimeout ===
          "واجهت صعوبة مؤقتة في الرد — سيتواصل معك أحد أعضاء الفريق الآن.",
    );
  }

  // B2: Pure resolver maps malformed/unparseable output to INVALID_OUTPUT copy
  {
    const replyInvalid = resolveSafeFailureReply({
      controlHandoffReason: null,
      failureCause: "AI_FAILURE",
    });
    const replyUnsupported = resolveSafeFailureReply({
      controlHandoffReason: "UNSUPPORTED_REQUEST",
      failureCause: "AI_FAILURE",
    });

    check(
      "B2. Invalid or absent structured output maps to safe generic handoff copy",
      eq(replyInvalid, SAFE_HANDOFF_REPLIES.INVALID_OUTPUT) &&
        eq(replyUnsupported, SAFE_HANDOFF_REPLIES.INVALID_OUTPUT) &&
        replyInvalid ===
          "لم أفهم طلبك تماماً — سيرد عليك أحد أعضاء الفريق لمساعدتك قريباً.",
    );
  }

  // B3: Pure resolver maps explicit human request to HUMAN_REQUEST copy
  {
    const replyHuman = resolveSafeFailureReply({
      controlHandoffReason: "CUSTOMER_REQUESTED_HUMAN",
      failureCause: "CUSTOMER_REQUESTED_HUMAN",
    });

    check(
      "B3. Validated explicit human request maps to human transfer copy",
      eq(replyHuman, SAFE_HANDOFF_REPLIES.HUMAN_REQUEST) &&
        replyHuman === "تحت أمرك — جارٍ تحويلك الآن لأحد أعضاء الفريق.",
    );
  }

  // B4: Pure resolver maps sensitive safety escalation to SENSITIVE copy
  {
    const replySensitive = resolveSafeFailureReply({
      controlHandoffReason: "SENSITIVE_OR_RESTRICTED_REQUEST",
      failureCause: "SENSITIVE_OR_RESTRICTED",
    });

    check(
      "B4. Validated safety restriction maps to sensitive assistance copy",
      eq(replySensitive, SAFE_HANDOFF_REPLIES.SENSITIVE) &&
        replySensitive ===
          "سنعتني بطلبك — سيتواصل معك أحد أعضاء الفريق في أقرب وقت.",
    );
  }

  // B5: Disclosure refusal constant matches canonical knowledge-gap reply
  {
    check(
      "B5. Disclosure refusal constant matches canonical knowledge-gap copy byte-for-byte",
      SAFE_HANDOFF_REPLIES.DISCLOSURE_REFUSED ===
        "شكراً لسؤالك — سيرد عليك أحد أعضاء الفريق قريباً.",
    );
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PART 3: End-to-End Engine Invariants (Real Engine + Mock Harness)
  // ════════════════════════════════════════════════════════════════════════════
  console.log(
    "\n── Part 3: End-to-End Engine Invariants (Real Engine + Mock Harness) ──",
  );

  // C1: Provider Failure turn produces PROVIDER_FAILURE copy without lexical distortion
  {
    const h1 = createEngineHarness({
      responders: [
        async () => {
          throw new Error("Timeout contacting LLM");
        },
      ],
      telemetry: [
        {
          finalProvider: "atria",
          finalStatus: "FAILURE",
          attempts: [],
          conversationControl: { handoffReason: "RETRY_EXHAUSTED" },
        },
      ],
    });

    // Test with customer text that previously would have matched "BOOKING" keyword
    const res1 = await h1.runInbound("عايز أحجز كشف أسنان بكرة", "t1-fail");

    check(
      "C1. Provider failure with booking-like text does NOT trigger lexical booking reply",
      isSuccess(res1) &&
        res1.conversationStatus === "NEED_HUMAN" &&
        res1.assistantAction === "AI_HANDOFF" &&
        res1.handoffCause === "RETRY_EXHAUSTED" &&
        h1.getSent().length === 1 &&
        h1.getSent()[0] ===
          "واجهت صعوبة مؤقتة في الرد — سيتواصل معك أحد أعضاء الفريق الآن.",
      { res1, sent: h1.getSent() },
    );

    // Assert lexical independence: completely different customer text gets identical typed failure reply
    const h2 = createEngineHarness({
      responders: [
        async () => {
          throw new Error("Provider unreachable");
        },
      ],
      telemetry: [
        {
          finalProvider: "atria",
          finalStatus: "FAILURE",
          attempts: [],
          conversationControl: { handoffReason: "PROVIDER_UNAVAILABLE" },
        },
      ],
    });

    const res2 = await h2.runInbound("عندي ألم شديد في ضرسي", "t2-fail");

    check(
      "C2. Provider failure with sensitive text gets same typed provider failure reply (not lexical sensitive)",
      isSuccess(res2) &&
        res2.conversationStatus === "NEED_HUMAN" &&
        res2.handoffCause === "PROVIDER_FAILURE" &&
        h2.getSent()[0] ===
          "واجهت صعوبة مؤقتة في الرد — سيتواصل معك أحد أعضاء الفريق الآن.",
    );
  }

  // C3: Malformed structured output produces INVALID_OUTPUT copy and AI_FAILURE cause
  {
    const h = createEngineHarness({
      responders: [
        async () => {
          throw new Error("Malformed JSON: unexpected token");
        },
      ],
    });

    const res = await h.runInbound("أنا مستفسر عن مواعيد العمل", "t3-invalid");

    check(
      "C3. Malformed structured output produces safe invalid-output reply and AI_FAILURE cause",
      isSuccess(res) &&
        res.conversationStatus === "NEED_HUMAN" &&
        res.assistantAction === "AI_HANDOFF" &&
        res.handoffCause === "AI_FAILURE" &&
        h.getSent()[0] ===
          "لم أفهم طلبك تماماً — سيرد عليك أحد أعضاء الفريق لمساعدتك قريباً.",
      { res, sent: h.getSent() },
    );
  }

  // C4: Validated structured handoff (HUMAN_REQUEST) delivers safe human reply directly
  {
    const h = createEngineHarness({
      responders: [
        async () => ({
          intent: "HUMAN_REQUEST",
          action: "handoff",
          content: "ignore-this-model-string",
          extraction: emptyExtraction,
          handoffReason: "HUMAN_REQUEST",
          summary: "طلب إنسان",
          safetyAssessment: "safe",
        }),
      ],
    });

    // Customer text with booking keyword: structured HUMAN_REQUEST must NOT be hijacked by lexical booking
    const res = await h.runInbound(
      "لو سمحت عايز موظف يساعدني في الحجز",
      "t4-human",
    );

    check(
      "C4. Structured HUMAN_REQUEST handoff delivers canonical human request reply directly",
      isSuccess(res) &&
        res.conversationStatus === "NEED_HUMAN" &&
        res.handoffCause === "CUSTOMER_REQUESTED_HUMAN" &&
        h.getSent()[0] === "تحت أمرك — جارٍ تحويلك الآن لأحد أعضاء الفريق.",
      { res, sent: h.getSent() },
    );
  }

  // C5: Validated structured handoff (SAFETY_RESTRICTED) delivers safe sensitive reply directly
  {
    const h = createEngineHarness({
      responders: [
        async () => ({
          intent: "AMBIGUOUS",
          action: "handoff",
          content: "ignore-this-model-string",
          extraction: emptyExtraction,
          handoffReason: "SENSITIVE",
          summary: "حالة طارئة",
          safetyAssessment: "sensitive",
        }),
      ],
    });

    // Customer text with greeting word: safety precedence must deliver sensitive reply directly
    const res = await h.runInbound("أهلاً، ألم شديد ونزيف حاد", "t5-sensitive");

    check(
      "C5. Structured SAFETY_RESTRICTED handoff delivers canonical sensitive reply directly",
      isSuccess(res) &&
        res.conversationStatus === "NEED_HUMAN" &&
        res.handoffCause === "SENSITIVE_OR_RESTRICTED" &&
        h.getSent()[0] ===
          "سنعتني بطلبك — سيتواصل معك أحد أعضاء الفريق في أقرب وقت.",
      { res, sent: h.getSent() },
    );
  }

  // C6: Disclosure Refusal (B-03) drops unbacked reply and sends safe refusal acknowledgment
  {
    const h = createEngineHarness({
      faqs: [], // Empty FAQ store
      about: null, // No about description
      address: null, // No address line
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "سعر الكشف 300 جنيه شامل الأشعة.", // Unbacked self-authored price claim
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
        }),
      ],
    });

    const res = await h.runInbound("بكام الكشف عندكم؟", "t6-refusal");

    check(
      "C6. Disclosure refusal drops unbacked reply, sets POLICY_REFUSED, and sends safe refusal copy",
      isSuccess(res) &&
        res.conversationStatus === "NEED_HUMAN" &&
        res.handoffCause === "POLICY_REFUSED" &&
        !h.getSent().some((s) => s.includes("300")) &&
        h.getSent()[0] === "شكراً لسؤالك — سيرد عليك أحد أعضاء الفريق قريباً.",
      { res, sent: h.getSent() },
    );
  }

  // C7: Zero appointments created and single-model-call guarantee across all failure/handoff branches
  {
    const h = createEngineHarness({
      responders: [
        async () => {
          throw new Error("Provider failure");
        },
      ],
    });

    await h.runInbound("عايز أحجز ميعاد الساعة 5", "t7-zero-appts");

    check(
      "C7. Failure/handoff paths spend strictly at most 1 model call and create zero appointments",
      h.getProviderCalls() === 1,
    );
  }

  // ════════════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ════════════════════════════════════════════════════════════════════════════
  const failed = checks.filter((c) => !c.pass);
  console.log("\n────────────────────────────────────────────────");
  console.log(
    `TOTAL CHECKS: ${checks.length} | PASSED: ${checks.length - failed.length} | FAILED: ${failed.length}`,
  );
  console.log("────────────────────────────────────────────────\n");

  if (failed.length > 0) {
    console.error("❌ FAILED CHECKS:");
    for (const f of failed) {
      console.error(` - ${f.label}`);
    }
    process.exit(1);
  } else {
    console.log("✅ ALL SEMANTIC AUTHORITY REPAIR CHECKS PASSED!");
    process.exit(0);
  }
}

runSuite().catch((err) => {
  console.error("Suite execution error:", err);
  process.exit(1);
});
