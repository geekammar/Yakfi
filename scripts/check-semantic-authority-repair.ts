/**
 * FlowPilot — Focused Semantic Authority Repair Verification Suite
 *
 * Verifies the repaired semantic authority flows:
 *   Part 1: Structured Context Identity Enrollment & Boundary Gating (Repair A)
 *   Part 1b: Reviewer Counterexample & Grounding Regressions (Section 3)
 *   Part 2: Safe Failure / Handoff Reply Resolution (Repair B & Section 5)
 *   Part 3: End-to-End Engine Invariants, Bounded Domain Rendering & Delivery (Part 4)
 *
 * Offline, resource-safe test suite with zero live paid model calls.
 */

import { buildAiContext } from "@/features/conversations/server/ai-context-builder";
import type { AiResponse } from "@/features/conversations/server/ai-contract";
import {
  enforceDisclosure,
  isExplicitIdentityResponse,
} from "@/features/conversations/server/ai-disclosure";
import {
  SAFE_HANDOFF_REPLIES,
  buildBusinessIdentityContent,
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
  message: "مين أنتم؟",
  requiredSemanticCapability: "structured_turn" as const,
  ...overrides,
});

/**
 * Creates an in-memory harness for the full receiveInboundMessage execution pipeline.
 */
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
  responders: Array<(req: unknown) => Promise<AiResponse>>;
  telemetry?: Array<Record<string, unknown>>;
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
    id: "conv-101",
    businessId: TENANT_A,
    customerId: CUST_A,
    status: "AI_ACTIVE",
    assignedUserId: null,
  };
  const attention = new Map<string, AttentionRow>();
  let providerInvocations = 0;
  let appointmentCreationAttempts = 0;
  let turnIndex = 0;

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
      name: "كشف أسنان",
      description: "فحص وتشخيص",
      durationMinutes: 30,
      priceType: null,
      priceAmount: null,
      priceMaxAmount: null,
      priceCurrency: null,
      priceNote: null,
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
        appointmentCreationAttempts += 1;
        return {} as never;
      },
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
    getProviderInvocations: () => providerInvocations,
    getAppointmentAttempts: () => appointmentCreationAttempts,
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

  // A3a: FORBIDDEN fields are strictly excluded from ledger facts and request context
  {
    const built = buildAiContext({
      scope: { businessId: TENANT_A },
      sources: baseSources({
        business: {
          ...baseSources().business,
          id: TENANT_A,
          defaultBranchId: "branch-uuid-999",
        },
      }),
    });

    const forbiddenLedger = built.facts.filter(
      (f) => f.visibility === "FORBIDDEN",
    );
    const forbiddenIncluded = forbiddenLedger.some((f) => f.included);
    const requestContainsForbiddenId =
      JSON.stringify(built.request).includes("branch-uuid-999") ||
      ("id" in built.request &&
        (built.request as Record<string, unknown>).id === TENANT_A);

    check(
      "A3a. FORBIDDEN fields (id, defaultBranchId) are excluded from ledger facts and request context",
      forbiddenLedger.length > 0 &&
        !forbiddenIncluded &&
        !requestContainsForbiddenId,
      { forbiddenLedger, requestContainsForbiddenId },
    );
  }

  // A3b: INTERNAL operational metadata is strictly excluded from being disclosable
  {
    const built = buildAiContext({
      scope: { businessId: TENANT_A },
      sources: baseSources({
        business: {
          ...baseSources().business,
          slotDurationMinutes: 45,
          timezone: "Africa/Cairo",
        },
      }),
    });

    const internalLedger = built.facts.filter(
      (f) => f.visibility === "INTERNAL",
    );
    const internalDisclosable = internalLedger.some((f) => f.disclosable);
    const requestContainsDuration =
      "slotDurationMinutes" in built.request ||
      ("durationMinutes" in built.request &&
        (built.request as Record<string, unknown>).durationMinutes === 45);

    check(
      "A3b. INTERNAL operational metadata (slotDurationMinutes) is never disclosable nor leaked into request",
      internalLedger.length > 0 &&
        !internalDisclosable &&
        !requestContainsDuration,
      { internalLedger, requestContainsDuration },
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
  // PART 1b: Reviewer Counterexample & Grounding Regressions (Section 3)
  // ════════════════════════════════════════════════════════════════════════════
  console.log(
    "\n── Part 1b: Disclosure Boundary Grounding Regressions (Section 3) ──",
  );

  // D1: Supported identity-only answer succeeds without customer keyword triggers
  {
    const built = buildAiContext({
      scope: { businessId: TENANT_A },
      sources: baseSources({
        business: {
          ...baseSources().business,
          about: "",
          address: "",
        },
        services: [],
        message: "مرحبا ممكن استفسار بسيط؟",
      }),
    });

    const response: AiResponse = {
      intent: "FAQ",
      action: "reply",
      content: "أيوه، مركز رعاية الأسنان التخصصي معاك. تحب نساعدك إزاي؟",
      extraction: emptyExtraction,
      handoffReason: null,
      summary: null,
      goals: [
        {
          kind: "ANSWER",
          intent: "FAQ",
          requiredKnowledge: "business.identity",
        },
      ],
    };

    const gateResult = enforceDisclosure({ context: built, response });

    check(
      "D1. Supported identity-only answer succeeds without customer keyword triggers",
      gateResult.kind === "disclosed" &&
        eq(gateResult.support[0], "business.identity") &&
        isExplicitIdentityResponse(response),
      gateResult,
    );
  }

  // D2: Unsupported price without business name is refused
  {
    const built = buildAiContext({
      scope: { businessId: TENANT_A },
      sources: baseSources({
        business: {
          ...baseSources().business,
          name: "مركز رعاية الأسنان التخصصي",
          faqs: [],
          about: "",
          address: "",
        },
        services: [],
      }),
    });

    const response: AiResponse = {
      intent: "FAQ",
      action: "reply",
      content: "سعر الكشف 300 جنيه للجلسة.",
      extraction: emptyExtraction,
      handoffReason: null,
      summary: null,
    };

    const gateResult = enforceDisclosure({ context: built, response });

    check(
      "D2. Unsupported price without business name is refused",
      gateResult.kind === "requires-human",
      gateResult,
    );
  }

  // D3: Unsupported price WITH the authoritative business name is ALSO refused (Reviewer Counterexample)
  {
    const built = buildAiContext({
      scope: { businessId: TENANT_A },
      sources: baseSources({
        business: {
          ...baseSources().business,
          name: "مركز أفنان",
          faqs: [],
          about: "",
          address: "",
        },
        services: [],
      }),
    });

    // Replay of the reviewer's counterexample:
    // FAQ reply mentioning the exact true business name, but asserting an unsupported price
    const reviewerCounterexample: AiResponse = {
      intent: "FAQ",
      action: "reply",
      content: "في مركز أفنان سعر الكشف 999 جنيه.",
      extraction: emptyExtraction,
      handoffReason: null,
      summary: null,
    };

    const gateResult = enforceDisclosure({
      context: built,
      response: reviewerCounterexample,
    });

    check(
      "D3. Unsupported price with authoritative business name is strictly refused (Reviewer Counterexample)",
      gateResult.kind === "requires-human",
      gateResult,
    );
  }

  // D4: Unsupported procedure/detail with the business name is refused
  {
    const built = buildAiContext({
      scope: { businessId: TENANT_A },
      sources: baseSources({
        business: {
          ...baseSources().business,
          name: "مركز أفنان",
          faqs: [],
          about: "",
          address: "",
        },
        services: [],
      }),
    });

    const procedureClaim: AiResponse = {
      intent: "FAQ",
      action: "reply",
      content:
        "في مركز أفنان نقوم بزراعة الأسنان في 10 دقائق فقط بدون أي جراحة وبأحدث أجهزة الليزر.",
      extraction: emptyExtraction,
      handoffReason: null,
      summary: null,
    };

    const gateResult = enforceDisclosure({
      context: built,
      response: procedureClaim,
    });

    check(
      "D4. Unsupported procedure/detail with business name is strictly refused",
      gateResult.kind === "requires-human",
      gateResult,
    );
  }

  // D5: Missing or foreign-tenant identity cannot authorize a reply
  {
    const missingNameBuilt = buildAiContext({
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

    const identityResponse: AiResponse = {
      intent: "FAQ",
      action: "reply",
      content: "أهلاً بك",
      extraction: emptyExtraction,
      handoffReason: null,
      summary: null,
      goals: [
        {
          kind: "ANSWER",
          intent: "FAQ",
          requiredKnowledge: "business.identity",
        },
      ],
    };

    const missingResult = enforceDisclosure({
      context: missingNameBuilt,
      response: identityResponse,
    });

    const foreignTenantBuilt = buildAiContext({
      scope: { businessId: TENANT_A },
      sources: baseSources({
        business: {
          ...baseSources().business,
          businessId: TENANT_B,
          name: "مركز أجنبي",
          about: "",
          address: "",
        },
        services: [],
      }),
    });

    const foreignResult = enforceDisclosure({
      context: foreignTenantBuilt,
      response: identityResponse,
    });

    check(
      "D5. Missing or foreign-tenant identity cannot authorize a reply",
      missingResult.kind === "requires-human" &&
        foreignResult.kind === "requires-human",
      { missingResult, foreignResult },
    );
  }

  // D6: Existing legitimately supported price/catalog/address behavior remains valid under its own contracts
  {
    // D6a. Legitimate price channel
    const priceBuilt = buildAiContext({
      scope: { businessId: TENANT_A },
      sources: baseSources({
        business: {
          ...baseSources().business,
          about: "",
          address: "",
        },
        services: [
          {
            id: "s1",
            businessId: TENANT_A,
            name: "تنظيف جير",
            description: null,
            durationMinutes: 30,
            priceType: "FIXED",
            priceAmount: 400,
            priceCurrency: "EGP",
          },
        ],
        message: "بكام تنظيف الجير؟",
      }),
    });

    const priceReply: AiResponse = {
      intent: "FAQ",
      action: "reply",
      content: "سعر تنظيف الجير 400 EGP.",
      extraction: emptyExtraction,
      handoffReason: null,
      summary: null,
    };
    const priceResult = enforceDisclosure({
      context: priceBuilt,
      response: priceReply,
    });

    // D6b. Legitimate address channel
    const addressBuilt = buildAiContext({
      scope: { businessId: TENANT_A },
      sources: baseSources({
        business: {
          ...baseSources().business,
          address: "شارع مصطفى كامل 15",
          about: "",
        },
        services: [],
        message: "عنوانكم فين؟",
      }),
    });

    const addressReply: AiResponse = {
      intent: "FAQ",
      action: "reply",
      content: "عنواننا في شارع مصطفى كامل 15.",
      extraction: emptyExtraction,
      handoffReason: null,
      summary: null,
    };
    const addressResult = enforceDisclosure({
      context: addressBuilt,
      response: addressReply,
    });

    // D6c. Legitimate catalog channel
    const catalogBuilt = buildAiContext({
      scope: { businessId: TENANT_A },
      sources: baseSources({
        business: {
          ...baseSources().business,
          about: "",
          address: "",
        },
        services: [
          {
            id: "s1",
            businessId: TENANT_A,
            name: "تنظيف جير",
            description: null,
            durationMinutes: 30,
          },
        ],
        message: "ايه الخدمات اللي عندكم؟",
      }),
    });

    const catalogReply: AiResponse = {
      intent: "FAQ",
      action: "reply",
      content: "الخدمة المتاحة لدينا هي تنظيف جير.",
      extraction: emptyExtraction,
      handoffReason: null,
      summary: null,
    };
    const catalogResult = enforceDisclosure({
      context: catalogBuilt,
      response: catalogReply,
    });

    check(
      "D6. Legitimate price, address, and catalog replies remain valid under their respective channels",
      priceResult.kind === "disclosed" &&
        priceResult.support.includes("service.price") &&
        addressResult.kind === "disclosed" &&
        addressResult.support.includes("business.address") &&
        catalogResult.kind === "disclosed" &&
        catalogResult.support.includes("service.name"),
      { priceResult, addressResult, catalogResult },
    );
  }

  // D7a: Populated context with about/address/catalog present: Identity with unbacked prose
  // cannot bypass bounded domain rendering via unrelated business.about
  {
    const h = createEngineHarness({
      about: "عيادة تخصصية لطب وجراحة الفم والأسنان بأحدث التقنيات",
      address: "15 شارع النصر، المعادي، القاهرة",
      services: [
        {
          id: "s1",
          businessId: TENANT_A,
          name: "كشف أسنان",
          description: "فحص شامل وتشخيص كامل",
          priceAmount: 300,
          priceCurrency: "EGP",
          priceType: "FIXED",
          durationMinutes: 20,
        },
      ],
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          // Model authored unbacked prose with fabricated price alongside identity goal
          content:
            "في مركز رعاية الأسنان التخصصي سعر الكشف 999 جنيه ومواعيدنا يومياً.",
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

    const res = await h.runInbound("أنتم مين؟", "d7a-pop-identity");
    const sentMessages = h.getSent();
    const firstMsg = sentMessages[0] ?? "";
    const expectedBounded = buildBusinessIdentityContent(
      "مركز رعاية الأسنان التخصصي",
    );

    check(
      "D7a. Populated context (about/address/services present) does NOT bypass bounded identity rendering",
      isSuccess(res) &&
        res.conversationStatus === "AI_ACTIVE" &&
        res.assistantAction === "AI_REPLY" &&
        sentMessages.length === 1 &&
        firstMsg === expectedBounded &&
        !firstMsg.includes("999") &&
        !firstMsg.includes("عيادة تخصصية"),
      { sentMessages, expectedBounded },
    );
  }

  // D7b: Populated context: Supported non-identity price answer remains correct
  {
    const h = createEngineHarness({
      about: "عيادة تخصصية لطب وجراحة الفم والأسنان",
      address: "15 شارع النصر، المعادي",
      services: [
        {
          id: "s1",
          businessId: TENANT_A,
          name: "كشف أسنان",
          description: null,
          priceAmount: 300,
          priceCurrency: "EGP",
          priceType: "FIXED",
          durationMinutes: 20,
        },
      ],
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "سعر كشف الأسنان 300 جنيه.",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
        }),
      ],
    });

    const res = await h.runInbound("سعر الكشف كام؟", "d7b-pop-price");
    const sentMessages = h.getSent();

    check(
      "D7b. Supported non-identity price answer is preserved and NOT replaced by identity rendering",
      isSuccess(res) &&
        res.conversationStatus === "AI_ACTIVE" &&
        res.assistantAction === "AI_REPLY" &&
        sentMessages.length === 1 &&
        sentMessages[0] === "سعر كشف الأسنان 300 جنيه.",
      { sentMessages },
    );
  }

  // D7c: Populated context: Supported non-identity address answer remains correct
  {
    const h = createEngineHarness({
      about: "عيادة تخصصية لطب وجراحة الفم والأسنان",
      address: "15 شارع النصر، المعادي",
      services: [],
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "عنوان العيادة في 15 شارع النصر، المعادي.",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
        }),
      ],
    });

    const res = await h.runInbound("عنوانكم فين؟", "d7c-pop-address");
    const sentMessages = h.getSent();

    check(
      "D7c. Supported non-identity address answer is preserved and NOT replaced by identity rendering",
      isSuccess(res) &&
        res.conversationStatus === "AI_ACTIVE" &&
        res.assistantAction === "AI_REPLY" &&
        sentMessages.length === 1 &&
        sentMessages[0] === "عنوان العيادة في 15 شارع النصر، المعادي.",
      { sentMessages },
    );
  }

  // D7d: Populated context: Mixed goals (Identity Answer + Booking Action) preserves both
  {
    const h = createEngineHarness({
      about: "عيادة تخصصية لطب وجراحة الفم والأسنان",
      address: "15 شارع النصر، المعادي",
      services: [
        {
          id: "s1",
          businessId: TENANT_A,
          name: "كشف أسنان",
          description: null,
          priceAmount: 300,
          priceCurrency: "EGP",
          priceType: "FIXED",
          durationMinutes: 20,
        },
      ],
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "نحن المركز التخصصي",
          extraction: {
            service: "كشف أسنان",
            provider: null,
            date: null,
            timePreference: null,
          },
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
          goals: [
            {
              kind: "ANSWER",
              intent: "FAQ",
              requiredKnowledge: "business.identity",
              priority: 10,
            },
            {
              kind: "DOMAIN_ACTION",
              intent: "BOOKING",
              priority: 20,
              continueAfter: true,
            },
          ],
        }),
      ],
    });

    const res = await h.runInbound(
      "أنتم مين وعايز أحجز كشف أسنان؟",
      "d7d-mixed-goals",
    );
    const sentMessages = h.getSent();
    const firstMsg = sentMessages[0] ?? "";
    const expectedBounded = buildBusinessIdentityContent(
      "مركز رعاية الأسنان التخصصي",
    );

    check(
      "D7d. Mixed goals preserve bounded identity answer AND append continuation invite for domain goal",
      isSuccess(res) &&
        res.conversationStatus === "AI_ACTIVE" &&
        res.assistantAction === "AI_REPLY" &&
        sentMessages.length === 1 &&
        firstMsg.startsWith(expectedBounded) &&
        firstMsg.includes("وبخصوص طلب الحجز"),
      { sentMessages },
    );
  }

  // D7e: Populated context: Single-intent identity using top-level canonical signal
  {
    const h = createEngineHarness({
      about: "عيادة تخصصية لطب وجراحة الفم والأسنان",
      address: "15 شارع النصر، المعادي",
      services: [],
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          requiredKnowledge: "business.identity",
          content: "أيوه إحنا المركز",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
        }),
      ],
    });

    const res = await h.runInbound("اسم المركز ايه؟", "d7e-single-signal");
    const sentMessages = h.getSent();
    const expectedBounded = buildBusinessIdentityContent(
      "مركز رعاية الأسنان التخصصي",
    );

    check(
      "D7e. Single-intent identity using top-level signal delivers canonical bounded identity copy",
      isSuccess(res) &&
        res.conversationStatus === "AI_ACTIVE" &&
        res.assistantAction === "AI_REPLY" &&
        sentMessages.length === 1 &&
        sentMessages[0] === expectedBounded,
      { sentMessages },
    );
  }

  // D7f: Missing or invalid signal fails safe closed to policy refused without guessing
  {
    const h = createEngineHarness({
      about: null,
      address: null,
      services: [],
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          // Missing requiredKnowledge: "business.identity" and missing goals
          content: "نحن المركز التخصصي",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
        }),
      ],
    });

    const res = await h.runInbound("أنتم مين؟", "d7f-missing-signal");
    const sentMessages = h.getSent();

    check(
      "D7f. Missing identity machine signal fails closed to AI_HANDOFF with POLICY_REFUSED",
      isSuccess(res) &&
        res.conversationStatus === "NEED_HUMAN" &&
        res.assistantAction === "AI_HANDOFF" &&
        res.handoffCause === "POLICY_REFUSED" &&
        sentMessages.length === 1 &&
        sentMessages[0] === SAFE_HANDOFF_REPLIES.DISCLOSURE_REFUSED,
      { res, sentMessages },
    );
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PART 2: Safe Failure / Handoff Reply Resolution (Repair B & Section 5)
  // ════════════════════════════════════════════════════════════════════════════
  console.log(
    "\n── Part 2: Safe Failure / Handoff Reply Resolution (Repair B & Section 5) ──",
  );

  // B1: Pure resolver maps provider outage / retry exhaustion to honest PROVIDER_FAILURE copy
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
      "B1. Provider outage & retry exhaustion map to honest, non-promissory failure copy",
      eq(replyTimeout, SAFE_HANDOFF_REPLIES.PROVIDER_FAILURE) &&
        eq(replyUnavailable, SAFE_HANDOFF_REPLIES.PROVIDER_FAILURE) &&
        eq(replyQuota, SAFE_HANDOFF_REPLIES.PROVIDER_FAILURE) &&
        replyTimeout === SAFE_HANDOFF_REPLIES.PROVIDER_FAILURE,
      { replyTimeout },
    );
  }

  // B2: Pure resolver maps malformed/unparseable output to neutral INVALID_OUTPUT copy (no customer blame)
  {
    const replyInvalid = resolveSafeFailureReply({
      controlHandoffReason: null,
      failureCause: "AI_FAILURE",
    });
    const replyUnsupported = resolveSafeFailureReply({
      controlHandoffReason: "UNSUPPORTED_REQUEST",
      failureCause: "AI_FAILURE",
    });
    const replyDefault = resolveSafeFailureReply({});

    check(
      "B2. Invalid or absent structured output maps to neutral safe handoff copy without customer blame",
      eq(replyInvalid, SAFE_HANDOFF_REPLIES.INVALID_OUTPUT) &&
        eq(replyUnsupported, SAFE_HANDOFF_REPLIES.INVALID_OUTPUT) &&
        eq(replyDefault, SAFE_HANDOFF_REPLIES.INVALID_OUTPUT) &&
        replyInvalid === SAFE_HANDOFF_REPLIES.INVALID_OUTPUT,
      { replyInvalid },
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
        replyHuman === "تحت أمرك — تم تحويل المحادثة لفريق العمل للمتابعة.",
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
          "سنعتني بطلبك — تم تحويل المحادثة لفريق العمل للمتابعة.",
    );
  }

  // B5: Disclosure refusal constant matches canonical neutral handoff copy
  {
    check(
      "B5. Disclosure refusal constant matches canonical neutral assistance copy",
      SAFE_HANDOFF_REPLIES.DISCLOSURE_REFUSED ===
        "شكراً لسؤالك — تم تحويل استفسارك لفريق العمل للمتابعة.",
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

    const res1 = await h1.runInbound("عايز أحجز كشف أسنان بكرة", "t1-fail");

    check(
      "C1. Provider failure with booking-like text does NOT trigger lexical booking reply",
      isSuccess(res1) &&
        res1.conversationStatus === "NEED_HUMAN" &&
        res1.assistantAction === "AI_HANDOFF" &&
        res1.handoffCause === "RETRY_EXHAUSTED" &&
        h1.getSent().length === 1 &&
        h1.getSent()[0] ===
          "واجهت صعوبة مؤقتة في الرد — جارٍ تحويلك لأحد أعضاء الفريق للمتابعة.",
      { res1, sent: h1.getSent() },
    );

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
          "واجهت صعوبة مؤقتة في الرد — جارٍ تحويلك لأحد أعضاء الفريق للمتابعة.",
    );
  }

  // C3a: Genuinely invalid structured output exercises response validation failure
  {
    const h = createEngineHarness({
      responders: [
        async () =>
          ({
            notAValidAiResponse: true,
            bogusIntent: "UNKNOWN_123",
          }) as unknown as AiResponse,
      ],
    });

    const res = await h.runInbound(
      "أنا مستفسر عن مواعيد العمل",
      "t3-invalid-schema",
    );

    check(
      "C3a. Genuinely invalid structured output fails validation and produces safe failure reply",
      isSuccess(res) &&
        res.conversationStatus === "NEED_HUMAN" &&
        res.assistantAction === "AI_HANDOFF" &&
        res.handoffCause === "AI_FAILURE" &&
        h.getSent()[0] === SAFE_HANDOFF_REPLIES.INVALID_OUTPUT,
      { res, sent: h.getSent() },
    );
  }

  // C3b: Thrown runtime adapter error is covered independently
  {
    const h = createEngineHarness({
      responders: [
        async () => {
          throw new Error("Unexpected network abort from provider");
        },
      ],
    });

    const res = await h.runInbound("عندي استفسار", "t3-thrown-err");

    check(
      "C3b. Thrown adapter error produces safe failure reply and AI_FAILURE cause",
      isSuccess(res) &&
        res.conversationStatus === "NEED_HUMAN" &&
        res.assistantAction === "AI_HANDOFF" &&
        res.handoffCause === "AI_FAILURE" &&
        h.getSent()[0] === SAFE_HANDOFF_REPLIES.INVALID_OUTPUT,
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

    const res = await h.runInbound(
      "لو سمحت عايز موظف يساعدني في الحجز",
      "t4-human",
    );

    check(
      "C4. Structured HUMAN_REQUEST handoff delivers canonical human request reply directly",
      isSuccess(res) &&
        res.conversationStatus === "NEED_HUMAN" &&
        res.handoffCause === "CUSTOMER_REQUESTED_HUMAN" &&
        h.getSent()[0] === SAFE_HANDOFF_REPLIES.HUMAN_REQUEST,
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

    const res = await h.runInbound("أهلاً، ألم شديد ونزيف حاد", "t5-sensitive");

    check(
      "C5. Structured SAFETY_RESTRICTED handoff delivers canonical sensitive reply directly",
      isSuccess(res) &&
        res.conversationStatus === "NEED_HUMAN" &&
        res.handoffCause === "SENSITIVE_OR_RESTRICTED" &&
        h.getSent()[0] === SAFE_HANDOFF_REPLIES.SENSITIVE,
      { res, sent: h.getSent() },
    );
  }

  // C6: Disclosure Refusal (B-03) drops unbacked reply and sends safe refusal acknowledgment
  {
    const h = createEngineHarness({
      faqs: [],
      about: null,
      address: null,
      services: [],
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "سعر الكشف 300 جنيه شامل الأشعة.",
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
        h.getSent()[0] === SAFE_HANDOFF_REPLIES.DISCLOSURE_REFUSED,
      { res, sent: h.getSent() },
    );
  }

  // C7: Repository-seam appointment creation attempts are strictly zero across all failure/handoff branches
  {
    // Test 5 distinct failure & handoff paths:
    // 1. Provider outage
    const hProvider = createEngineHarness({
      responders: [
        async () => {
          throw new Error("Provider down");
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
    const resProvider = await hProvider.runInbound(
      "عايز أحجز ميعاد الساعة 5",
      "t7-branch1",
    );

    // 2. Invalid AI response
    const hInvalid = createEngineHarness({
      responders: [
        async () =>
          ({
            notValid: true,
          }) as unknown as AiResponse,
      ],
    });
    const resInvalid = await hInvalid.runInbound("عايز أحجز كشف", "t7-branch2");

    // 3. Explicit human request
    const hHuman = createEngineHarness({
      responders: [
        async () => ({
          intent: "HUMAN_REQUEST",
          action: "handoff",
          content: "حاضر",
          extraction: emptyExtraction,
          handoffReason: "HUMAN_REQUEST",
          summary: "طلب موظف",
          safetyAssessment: "safe",
        }),
      ],
    });
    const resHuman = await hHuman.runInbound("وصلني بموظف الحجز", "t7-branch3");

    // 4. Sensitive emergency
    const hSensitive = createEngineHarness({
      responders: [
        async () => ({
          intent: "AMBIGUOUS",
          action: "handoff",
          content: "حالة طارئة",
          extraction: emptyExtraction,
          handoffReason: "SENSITIVE",
          summary: "نزيف حاد",
          safetyAssessment: "sensitive",
        }),
      ],
    });
    const resSensitive = await hSensitive.runInbound(
      "نزيف شديد بعد خلع الضرس",
      "t7-branch4",
    );

    // 5. Disclosure refusal
    const hDisclosure = createEngineHarness({
      faqs: [],
      about: null,
      address: null,
      services: [],
      responders: [
        async () => ({
          intent: "FAQ",
          action: "reply",
          content: "سعر الزراعة 15000 جنيه.",
          extraction: emptyExtraction,
          handoffReason: null,
          summary: null,
          safetyAssessment: "safe",
        }),
      ],
    });
    const resDisclosure = await hDisclosure.runInbound(
      "بكام الزراعة؟",
      "t7-branch5",
    );

    const zeroAppointmentsAll =
      hProvider.getAppointmentAttempts() === 0 &&
      hInvalid.getAppointmentAttempts() === 0 &&
      hHuman.getAppointmentAttempts() === 0 &&
      hSensitive.getAppointmentAttempts() === 0 &&
      hDisclosure.getAppointmentAttempts() === 0;

    const singleAiBoundaryInvocationAll =
      hProvider.getProviderInvocations() === 1 &&
      hInvalid.getProviderInvocations() === 1 &&
      hHuman.getProviderInvocations() === 1 &&
      hSensitive.getProviderInvocations() === 1 &&
      hDisclosure.getProviderInvocations() === 1;

    const deliveryCompletedAll =
      hProvider.getSent().length === 1 &&
      hInvalid.getSent().length === 1 &&
      hHuman.getSent().length === 1 &&
      hSensitive.getSent().length === 1 &&
      hDisclosure.getSent().length === 1;

    const statusNeedHumanAll =
      isSuccess(resProvider) &&
      resProvider.conversationStatus === "NEED_HUMAN" &&
      isSuccess(resInvalid) &&
      resInvalid.conversationStatus === "NEED_HUMAN" &&
      isSuccess(resHuman) &&
      resHuman.conversationStatus === "NEED_HUMAN" &&
      isSuccess(resSensitive) &&
      resSensitive.conversationStatus === "NEED_HUMAN" &&
      isSuccess(resDisclosure) &&
      resDisclosure.conversationStatus === "NEED_HUMAN";

    check(
      "C7. Domain seam verifies strictly zero appointment creation attempts across all failure/handoff branches",
      zeroAppointmentsAll &&
        singleAiBoundaryInvocationAll &&
        deliveryCompletedAll &&
        statusNeedHumanAll,
      {
        zeroAppointmentsAll,
        singleAiBoundaryInvocationAll,
        deliveryCompletedAll,
        statusNeedHumanAll,
      },
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
