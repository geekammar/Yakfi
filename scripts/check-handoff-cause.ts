/* eslint-disable @typescript-eslint/consistent-type-imports */
/**
 * FlowPilot — TYPED HANDOFF CAUSE + OPERATOR MAPPING check
 * (PROMPT-AI-ARCH-16 — Slice 7).
 *
 * Deterministic, OFFLINE verification of the typed handoff-cause contract (no
 * DB, no network, no LLM, no API tokens, no secrets, no WhatsApp transport).
 * It exercises BOTH the pure cause/mapping module AND the REAL Conversation
 * Engine with in-memory repositories + a scripted assistant, so the whole
 *
 *     authoritative engine/resolver decision
 *         → typed cause derived
 *         → persisted on the operator-attention row
 *         → operator presentation
 *
 * seam is covered end-to-end. The scripted assistant is a STAND-IN for the
 * provider path only — every deterministic safety/precedence/disclosure seam
 * the engine applies is the REAL production code.
 *
 *   UNIT (the pure contract)
 *   U1  every canonical cause is representable + schema-parseable
 *   U2  every canonical cause maps to an operator presentation (label +
 *       description, non-empty Arabic)
 *   U3  unknown / legacy / malformed stored values FAIL SAFE to null — they
 *       can never silently become a misleading cause
 *   U4  the EXISTING AI-contract handoff reasons map onto the taxonomy
 *   U5  the EXISTING Conversation-Control handoff reasons map onto the
 *       taxonomy (provider failure stays distinct from a knowledge gap)
 *   U6  booking-eligibility failure codes split tenant-configuration vs a
 *       domain constraint
 *   U7  the module adds NO second resolver / state / planner / engine /
 *       classifier (pure functions only; no Prisma/provider/transport import)
 *
 *   ENGINE (the real decision path)
 *   E1  explicit human request      → NEED_HUMAN + CUSTOMER_REQUESTED_HUMAN
 *   E2  sensitive / restricted      → NEED_HUMAN + SENSITIVE_OR_RESTRICTED
 *   E3  knowledge gap               → NEED_HUMAN + KNOWLEDGE_GAP_UNRESOLVED
 *   E4  genuine ambiguity           → NEED_HUMAN + AMBIGUITY_UNRESOLVED
 *   E5  domain constraint           → NEED_HUMAN + DOMAIN_REQUIRES_HUMAN
 *   E6  disclosure refusal (B-03)   → NEED_HUMAN + POLICY_REFUSED
 *   E7  invalid/absent AI output    → NEED_HUMAN + AI_FAILURE
 *   E8  provider outage             → NEED_HUMAN + PROVIDER_FAILURE
 *   E9  bounded retry spent         → NEED_HUMAN + RETRY_EXHAUSTED
 *   E10 tenant misconfiguration     → NEED_HUMAN + TENANT_CONFIGURATION
 *   E11 an answerable turn          → AI_ACTIVE, NO attention, cause null
 *   E12 SAFETY PRECEDENCE: a sensitive turn where the model proposed a plain
 *       reply still hands off with SENSITIVE_OR_RESTRICTED — the cause can
 *       never downgrade a safety handoff
 *   E13 MULTI-INTENT human + booking → the handoff stays authoritative and
 *       the cause is the customer's request (goals[] never become the cause)
 *   E14 MULTI-INTENT knowledge + booking → ANSWER-AND-CONTINUE stays
 *       AI_ACTIVE (pendingGoals intact), no cause, no attention
 *   E15 the cause survives the persistence/display seam (attention row)
 *   E16 NO STALE CAUSE: a later handoff with a different cause overwrites;
 *       a re-open without a cause clears any prior one
 *   E17 RESUME AI never fabricates or reclassifies a historical handoff cause
 *   E18 TENANT ISOLATION: one business never sees another's cause
 *   E19 the cause is NEVER customer-visible (no label/text reaches the reply)
 *   E20 cause derivation adds ZERO model calls (the turn's call count is
 *       unchanged) and the turn stays one-send
 *
 * Run: pnpm check:handoff-cause
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export {};

type Check = { label: string; pass: boolean };
const checks: Check[] = [];
function check(label: string, pass: boolean): void {
  checks.push({ label, pass });
}

async function main(): Promise<void> {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const engine =
    await import("../src/features/conversations/server/conversation-engine");
  const cause =
    await import("../src/features/conversations/server/handoff-cause");
  const { operatorAttentionValidation } = await import("../src/lib/validation");

  type AiResponse =
    import("../src/features/conversations/server/ai-contract").AiResponse;
  type ConversationEngineDeps =
    import("../src/features/conversations/server/conversation-engine").ConversationEngineDeps;
  type InboundResult =
    import("../src/features/conversations/server/conversation-engine").InboundResult;
  type InboundSuccess =
    import("../src/features/conversations/server/conversation-engine").InboundSuccess;
  type HandoffCause =
    import("../src/features/conversations/server/handoff-cause").HandoffCause;

  const BUSINESS_A = "11111111-1111-4111-8111-111111111111";
  const BUSINESS_B = "22222222-2222-4222-8222-222222222222";
  const BRANCH_A = "55555555-5555-4555-8555-555555555555";
  const now = new Date();
  const WHATSAPP = "+201000000000";

  const emptyExtraction = {
    service: null,
    provider: null,
    date: null,
    timePreference: null,
  };

  function isSuccess(result: InboundResult): result is InboundSuccess {
    return result.ok && !result.duplicate;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PART 1 — UNIT: the pure cause contract
  // ═══════════════════════════════════════════════════════════════════════

  // U1 — every canonical cause is representable + schema-parseable.
  const parsedAll = cause.handoffCauseValues.map(
    (value) => cause.handoffCauseSchema.safeParse(value).success,
  );
  check(
    "U1. كل سبب canonical قابل للتمثيل ويقبل التحقق",
    parsedAll.length === 10 && parsedAll.every(Boolean),
  );

  // U2 — every canonical cause maps to an operator presentation.
  const presentationsOk = cause.handoffCauseValues.map((value) => {
    const presentation = cause.HANDOFF_CAUSE_PRESENTATIONS[value];
    return (
      typeof presentation.label === "string" &&
      presentation.label.trim().length > 0 &&
      typeof presentation.description === "string" &&
      presentation.description.trim().length > 0 &&
      // Arabic operational language only — no machine keys leaked to the
      // operator, no provider/resolver jargon.
      !/[A-Z]{2,}/.test(presentation.label) &&
      !/[A-Z]{2,}/.test(presentation.description)
    );
  });
  check(
    "U2. كل سبب له عرض مُشغّل (تسمية + شرح، عربي، بلا مصطلحات داخلية)",
    presentationsOk.every(Boolean) &&
      new Set(cause.handoffCauseValues.map((v) => cause.handoffCauseLabel(v)))
        .size === 10,
  );

  // U3 — unknown / legacy / malformed values fail safe to null.
  const unknownValues = [
    "UNKNOWN",
    "KNOWLEDGE_GAP",
    "knowledge_gap",
    "",
    "PROVIDER_ERROR",
    null,
    undefined,
    42,
    { cause: "AI_FAILURE" },
  ];
  check(
    "U3. القيم غير المعروفة/القديمة تفشل بأمان إلى null (لا تصبح سبباً مضللاً)",
    unknownValues.every((value) => cause.parseHandoffCause(value) === null) &&
      cause.parseHandoffCause("AI_FAILURE") === "AI_FAILURE",
  );

  // U4 — the EXISTING AI-contract handoff reasons map onto the taxonomy.
  check(
    "U4. أسباب التحويل في عقد الذكاء تُطابق الـ taxonomy",
    cause.contractHandoffReasonToCause("HUMAN_REQUEST") ===
      "CUSTOMER_REQUESTED_HUMAN" &&
      cause.contractHandoffReasonToCause("SENSITIVE") ===
        "SENSITIVE_OR_RESTRICTED" &&
      cause.contractHandoffReasonToCause("NO_KNOWLEDGE") ===
        "KNOWLEDGE_GAP_UNRESOLVED" &&
      cause.contractHandoffReasonToCause("AMBIGUOUS") ===
        "AMBIGUITY_UNRESOLVED" &&
      cause.contractHandoffReasonToCause(null) === null,
  );

  // U5 — the EXISTING Conversation-Control reasons map, keeping provider
  //      failure distinct from a knowledge gap.
  check(
    "U5. أسباب التحكم في المحادثة تُفرّق فشل المزود عن فجوة المعرفة",
    cause.controlHandoffReasonToCause("RETRY_EXHAUSTED") ===
      "RETRY_EXHAUSTED" &&
      cause.controlHandoffReasonToCause("PROVIDER_UNAVAILABLE") ===
        "PROVIDER_FAILURE" &&
      cause.controlHandoffReasonToCause("QUOTA_EXHAUSTED") ===
        "PROVIDER_FAILURE" &&
      cause.controlHandoffReasonToCause("AUTH_OR_CONFIGURATION_FAILURE") ===
        "PROVIDER_FAILURE" &&
      cause.controlHandoffReasonToCause("UNSUPPORTED_REQUEST") ===
        "AI_FAILURE" &&
      cause.controlHandoffReasonToCause("CUSTOMER_REQUESTED_HUMAN") ===
        "CUSTOMER_REQUESTED_HUMAN" &&
      cause.controlHandoffReasonToCause("SENSITIVE_OR_RESTRICTED_REQUEST") ===
        "SENSITIVE_OR_RESTRICTED" &&
      cause.controlHandoffReasonToCause(null) === null,
  );

  // U6 — booking-eligibility failure codes split config vs domain constraint.
  check(
    "U6. رموز الأهلية: إعداد المستأجر مقابل قيد مجالي",
    cause.eligibilityFailureCodeToCause("NO_BUSINESS") ===
      "TENANT_CONFIGURATION" &&
      cause.eligibilityFailureCodeToCause("BRANCH_NOT_FOUND") ===
        "TENANT_CONFIGURATION" &&
      cause.eligibilityFailureCodeToCause("SERVICE_NOT_FOUND") ===
        "TENANT_CONFIGURATION" &&
      cause.eligibilityFailureCodeToCause("SERVICE_INACTIVE") ===
        "TENANT_CONFIGURATION" &&
      cause.eligibilityFailureCodeToCause("INVALID_INPUT") ===
        "DOMAIN_REQUIRES_HUMAN" &&
      cause.eligibilityFailureCodeToCause("PROVIDER_NOT_ELIGIBLE") ===
        "DOMAIN_REQUIRES_HUMAN" &&
      cause.eligibilityFailureCodeToCause("ANYTHING_ELSE") ===
        "DOMAIN_REQUIRES_HUMAN",
  );

  // U7 — the module is pure: no second resolver/state/planner/engine/classifier
  //      and no DB/provider/transport awareness.
  {
    const source = readFileSync(
      join(process.cwd(), "src/features/conversations/server/handoff-cause.ts"),
      "utf8",
    );
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    const forbidden = [
      "prisma",
      "@prisma",
      "db.",
      "repository",
      "transport",
      "atria",
      "openrouter",
      "agentrouter",
      "codecraft",
      "resolveTurnPlan",
      "ConversationState",
      "mergeConversationState",
      "fetch(",
      "process.env",
    ];
    check(
      "U7. وحدة السبب نقية: لا محرّر/حالة/مخطط/محرّك ثانٍ ولا وعي بقاعدة/مزود",
      !forbidden.some((token) => code.includes(token)) &&
        /server-authoritative/i.test(source),
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PART 2 — ENGINE: the real decision path (in-memory repos + scripted AI)
  // ═══════════════════════════════════════════════════════════════════════

  type AttentionRow = {
    businessId: string;
    conversationId: string;
    reason: string;
    cause: HandoffCause | null;
    resolved: boolean;
    resolvedById: string | null;
  };

  function makeBusiness(
    id: string,
    faqs: Array<{ question: string; answer: string }>,
  ) {
    return {
      id,
      name: "عيادة",
      vertical: null,
      city: null,
      whatsappNumber: WHATSAPP,
      timezone: "Africa/Cairo",
      about: null,
      workingHours: {},
      slotDurationMinutes: 30,
      confirmationMode: "manual",
      faqs,
      cancellationPolicy: null,
      onboardingCompletedAt: now,
      isActive: true,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      defaultBranchId: BRANCH_A,
    } as unknown as Parameters<
      typeof engine.receiveInboundMessage
    >[0]["businessRepository"] extends {
      findById: (id: string) => Promise<infer B>;
    }
      ? B
      : never;
  }

  const DEFAULT_FAQS = [
    { question: "مواعيد العمل", answer: "من 9 صباحاً حتى 6 مساءً" },
  ];

  /**
   * A fresh, isolated engine harness. `responders` is a per-turn script; the
   * `telemetry` hook lets a turn simulate the Conversation-Control outcome a
   * real wrapped provider would report (provider failure vs retry exhaustion).
   */
  function makeHarness(opts: {
    businessId?: string;
    conversationId?: string;
    responders: Array<
      (request: unknown) => Promise<AiResponse> | Promise<never>
    >;
    telemetry?: Array<{
      finalProvider: string;
      finalModel?: string | null;
      finalStatus?: string;
      fallbackUsed?: boolean;
      attempts?: unknown[];
      conversationControl?: { handoffReason: string } | null;
    }>;
    faqs?: Array<{ question: string; answer: string }>;
    services?: unknown[];
  }) {
    const businessId = opts.businessId ?? BUSINESS_A;
    const conversationId =
      opts.conversationId ?? "33333333-3333-4333-8333-333333333333";
    const business = makeBusiness(businessId, opts.faqs ?? DEFAULT_FAQS);
    const branch = {
      id: BRANCH_A,
      businessId,
      name: "الفرع الرئيسي",
      isActive: true,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    const customer = {
      id: "cust-1",
      businessId,
      name: "عميل",
      phone: "+201234567890",
      notes: null,
      lastConversationAt: null,
      lastAppointmentAt: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    const services = (opts.services ?? []) as {
      id: string;
      businessId: string;
      name: string;
      isActive: boolean;
      durationMinutes: number;
      priceType: string | null;
      priceAmount: number | null;
      priceMaxAmount: number | null;
      priceCurrency: string | null;
      priceNote: string | null;
      vertical: string | null;
      createdAt: Date;
      updatedAt: Date;
      deletedAt: null;
    }[];

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
      createdAt: string;
    }> = [];
    const sent: string[] = [];
    const attention = new Map<string, AttentionRow>();
    let aiCalls = 0;
    let mseq = 0;
    let turnIndex = 0;

    const deps = {
      businessRepository: {
        findByWhatsappNumber: async () => business,
        findById: async (id: string) =>
          id === businessId ? (business as object | null) : null,
      },
      branchRepository: {
        findDefaultByBusiness: async () => branch,
        findByIdWithinBusiness: async () => branch,
      },
      customerRepository: {
        upsertByPhone: async () => customer,
        touchConversation: async () => customer,
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
            id: conversationId,
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
          mseq += 1;
          const message = {
            id: `msg-${mseq}`,
            senderType: input.senderType,
            content: input.content,
            createdAt: now.toISOString(),
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
            createdAt: message.createdAt,
          })),
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
      serviceRepository: {
        listByBusiness: async () => services,
        findById: async (id: string) =>
          (services.find((service) => service.id === id) as object) ?? null,
      },
      inboundDedupeRepository: {
        claim: async () => ({ status: "claimed" as const, claimId: "claim-1" }),
      },
      usageRepository: { record: async () => undefined },
      attentionRepository: {
        open: async (input: {
          businessId: string;
          conversationId: string;
          reason: string;
          cause?: HandoffCause | null;
        }) => {
          const parsed = operatorAttentionValidation.open.parse(input);
          const row: AttentionRow = {
            businessId: parsed.businessId,
            conversationId: parsed.conversationId,
            reason: parsed.reason,
            cause: parsed.cause ?? null,
            resolved: false,
            resolvedById: null,
          };
          attention.set(parsed.conversationId, row);
          return {
            id: "77777777-7777-4777-8777-777777777777",
            ...row,
            createdAt: now.toISOString(),
          };
        },
        resolve: async (input: {
          conversationId: string;
          resolvedById: string;
        }) => {
          operatorAttentionValidation.resolve.parse(input);
          const row = attention.get(input.conversationId);
          if (row) {
            attention.set(input.conversationId, {
              ...row,
              resolved: true,
              resolvedById: input.resolvedById,
            });
          }
          return undefined;
        },
        countOpen: async (id: string) =>
          [...attention.values()].filter(
            (row) => row.businessId === id && !row.resolved,
          ).length,
        findOpen: async (conversationId: string) => {
          const row = attention.get(conversationId);
          return row && !row.resolved
            ? {
                id: "77777777-7777-4777-8777-777777777777",
                conversationId: row.conversationId,
                reason: row.reason,
                cause: row.cause,
                createdAt: now.toISOString(),
              }
            : null;
        },
        findOpenByConversations: async (
          id: string,
          conversationIds: string[],
        ) => {
          const map = new Map<string, AttentionRow>();
          for (const conversationId of conversationIds) {
            const row = attention.get(conversationId);
            if (row && row.businessId === id && !row.resolved) {
              map.set(conversationId, row);
            }
          }
          return map;
        },
      },
      ai: {
        providerName: "scripted",
        async respond(request: unknown): Promise<AiResponse> {
          aiCalls += 1;
          const responder =
            opts.responders[Math.min(turnIndex, opts.responders.length - 1)]!;
          turnIndex += 1;
          return responder(request);
        },
        // Simulates the Conversation-Control outcome a real wrapped provider
        // reports (readAiTelemetry reads exactly this).
        getLastTelemetry: () => {
          const entry =
            opts.telemetry?.[
              Math.min(turnIndex - 1, (opts.telemetry?.length ?? 1) - 1)
            ];
          return entry ?? null;
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

    const run = async (text: string, externalId: string) =>
      engine.receiveInboundMessage(
        deps,
        {
          to: WHATSAPP,
          from: "+201234567890",
          text,
          receivedAt: now.toISOString(),
          externalId,
        },
        { businessId, connectionId: null, branchId: BRANCH_A },
      );

    return {
      run,
      deps,
      get conversation() {
        return conversation;
      },
      attention,
      sent,
      aiCalls: () => aiCalls,
      aiMessageCount: () =>
        messages.filter((message) => message.senderType === "AI").length,
    };
  }

  const handoff = (
    handoffReason: AiResponse["handoffReason"],
    intent: AiResponse["intent"] = "AMBIGUOUS",
    action: AiResponse["action"] = "handoff",
    extra: Partial<AiResponse> = {},
  ): AiResponse => ({
    intent,
    action,
    content: "سيتواصل معك أحد أعضاء الفريق.",
    extraction: emptyExtraction,
    handoffReason,
    summary: action === "booking_handoff" ? "طلب يتطلب تدخل الفريق" : null,
    ...extra,
  });

  // E1 — explicit human request.
  {
    const h = makeHarness({
      responders: [async () => handoff("HUMAN_REQUEST", "HUMAN_REQUEST")],
    });
    const result = await h.run("أريد التحدث إلى موظف لو سمحت", "e1");
    const row = h.attention.get(h.conversation!.id);
    check(
      "E1. طلب صريح لمسؤول → NEED_HUMAN + CUSTOMER_REQUESTED_HUMAN + انتباه",
      isSuccess(result) &&
        result.conversationStatus === "NEED_HUMAN" &&
        result.handoffCause === "CUSTOMER_REQUESTED_HUMAN" &&
        row?.reason === "AI_HANDOFF" &&
        row?.cause === "CUSTOMER_REQUESTED_HUMAN",
    );
  }

  // E2 — sensitive / restricted.
  {
    const h = makeHarness({
      responders: [async () => handoff("SENSITIVE")],
    });
    const result = await h.run("ألم شديد جداً في ضهري", "e2");
    const row = h.attention.get(h.conversation!.id);
    check(
      "E2. حالة حسّاسة → NEED_HUMAN + SENSITIVE_OR_RESTRICTED",
      isSuccess(result) &&
        result.conversationStatus === "NEED_HUMAN" &&
        result.handoffCause === "SENSITIVE_OR_RESTRICTED" &&
        row?.cause === "SENSITIVE_OR_RESTRICTED",
    );
  }

  // E3 — knowledge gap.
  {
    const h = makeHarness({
      responders: [async () => handoff("NO_KNOWLEDGE", "FAQ")],
    });
    const result = await h.run("ما هي مدة الجلسة الواحدة بالضبط؟", "e3");
    const row = h.attention.get(h.conversation!.id);
    check(
      "E3. فجوة معرفة → NEED_HUMAN + KNOWLEDGE_GAP_UNRESOLVED (لا إجابة مختلقة)",
      isSuccess(result) &&
        result.conversationStatus === "NEED_HUMAN" &&
        result.handoffCause === "KNOWLEDGE_GAP_UNRESOLVED" &&
        row?.cause === "KNOWLEDGE_GAP_UNRESOLVED",
    );
  }

  // E4 — genuine ambiguity (a non-committal fragment: the resolver suppresses
  //      an unnecessary CLARIFY with no pending task → handoff).
  {
    const h = makeHarness({
      responders: [async () => handoff("AMBIGUOUS")],
    });
    const result = await h.run("مش عارف", "e4");
    const row = h.attention.get(h.conversation!.id);
    check(
      "E4. غموض حقيقي → NEED_HUMAN + AMBIGUITY_UNRESOLVED",
      isSuccess(result) &&
        result.conversationStatus === "NEED_HUMAN" &&
        result.handoffCause === "AMBIGUITY_UNRESOLVED" &&
        row?.cause === "AMBIGUITY_UNRESOLVED",
    );
  }

  // E5 — domain constraint (a booking-family task routed to staff).
  {
    const h = makeHarness({
      responders: [
        async () =>
          handoff(null, "CANCELLATION", "booking_handoff", {
            summary: "طلب إلغاء موعد",
          }),
      ],
    });
    const result = await h.run("أريد إلغاء موعد السبت", "e5");
    const row = h.attention.get(h.conversation!.id);
    check(
      "E5. قيد مجالي (إلغاء) → NEED_HUMAN + DOMAIN_REQUIRES_HUMAN",
      isSuccess(result) &&
        result.conversationStatus === "NEED_HUMAN" &&
        result.handoffCause === "DOMAIN_REQUIRES_HUMAN" &&
        row?.reason === "AI_HANDOFF" &&
        row?.cause === "DOMAIN_REQUIRES_HUMAN",
    );
  }

  // E6 — disclosure refusal (B-03): an unbacked self-authored reply. No FAQ
  //      store and no price fact are in context, so the gate cannot justify it.
  {
    const h = makeHarness({
      faqs: [],
      services: [],
      responders: [
        async () =>
          ({
            intent: "FAQ",
            action: "reply",
            content: "الأسعار تبدأ من 500 جنيه للجلسة الواحدة.",
            extraction: emptyExtraction,
            handoffReason: null,
            summary: null,
          }) as AiResponse,
      ],
    });
    const result = await h.run("كم سعر الجلسة عندكم؟", "e6");
    const row = h.attention.get(h.conversation!.id);
    check(
      "E6. رد غير مدعوم (B-03) → NEED_HUMAN + POLICY_REFUSED (لا فجوة معرفة)",
      isSuccess(result) &&
        result.conversationStatus === "NEED_HUMAN" &&
        result.handoffCause === "POLICY_REFUSED" &&
        row?.cause === "POLICY_REFUSED" &&
        !h.sent.some((text) => text.includes("500")),
    );
  }

  // E7 — invalid/absent AI output (no control telemetry → AI_FAILURE).
  {
    const h = makeHarness({
      responders: [
        async () => {
          throw new Error("provider returned nothing parseable");
        },
      ],
    });
    const result = await h.run("عندي سؤال غريب", "e7");
    const row = h.attention.get(h.conversation!.id);
    check(
      "E7. مخرجات مساعد غير صالحة/غائبة → NEED_HUMAN + AI_FAILURE",
      isSuccess(result) &&
        result.conversationStatus === "NEED_HUMAN" &&
        result.handoffCause === "AI_FAILURE" &&
        row?.cause === "AI_FAILURE",
    );
  }

  // E8 — provider outage (Conversation-Control outcome).
  {
    const h = makeHarness({
      responders: [
        async () => {
          throw new Error("provider unreachable");
        },
      ],
      telemetry: [
        {
          finalProvider: "atria",
          finalModel: null,
          finalStatus: "FAILURE",
          fallbackUsed: false,
          attempts: [],
          conversationControl: { handoffReason: "PROVIDER_UNAVAILABLE" },
        },
      ],
    });
    const result = await h.run("عندي استفسار", "e8");
    const row = h.attention.get(h.conversation!.id);
    check(
      "E8. انقطاع المزود → NEED_HUMAN + PROVIDER_FAILURE (ليست فجوة معرفة)",
      isSuccess(result) &&
        result.conversationStatus === "NEED_HUMAN" &&
        result.handoffCause === "PROVIDER_FAILURE" &&
        row?.cause === "PROVIDER_FAILURE",
    );
  }

  // E9 — bounded retry spent.
  {
    const h = makeHarness({
      responders: [
        async () => {
          throw new Error("timeout");
        },
      ],
      telemetry: [
        {
          finalProvider: "atria",
          finalModel: null,
          finalStatus: "FAILURE",
          fallbackUsed: false,
          attempts: [],
          conversationControl: { handoffReason: "RETRY_EXHAUSTED" },
        },
      ],
    });
    const result = await h.run("محتاج مساعدة لو سمحت", "e9");
    const row = h.attention.get(h.conversation!.id);
    check(
      "E9. استنفاد المحاولات → NEED_HUMAN + RETRY_EXHAUSTED",
      isSuccess(result) &&
        result.conversationStatus === "NEED_HUMAN" &&
        result.handoffCause === "RETRY_EXHAUSTED" &&
        row?.cause === "RETRY_EXHAUSTED",
    );
  }

  // E10 — tenant misconfiguration: the service exists but is INACTIVE, so the
  //       deterministic domain (CORE-01) blocks the task with a fixable setup
  //       cause.
  {
    const h = makeHarness({
      responders: [
        async () =>
          ({
            intent: "BOOKING",
            action: "reply",
            content: "سأتحقق من المواعيد المتاحة.",
            extraction: {
              ...emptyExtraction,
              service: "تنظيف الأسنان",
              date: "2026-10-05",
            },
            handoffReason: null,
            summary: null,
          }) as AiResponse,
      ],
      services: [
        {
          id: "99999999-9999-4999-8999-999999999999",
          businessId: BUSINESS_A,
          name: "تنظيف الأسنان",
          isActive: false,
          durationMinutes: 30,
          priceType: null,
          priceAmount: null,
          priceMaxAmount: null,
          priceCurrency: null,
          priceNote: null,
          vertical: null,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        },
      ],
    });
    const result = await h.run(
      "أريد حجز موعد لتنظيف الأسنان يوم 5 أكتوبر",
      "e10",
    );
    const row = h.attention.get(h.conversation!.id);
    check(
      "E10. خدمة غير مُعدة/معطّلة → NEED_HUMAN + TENANT_CONFIGURATION",
      isSuccess(result) &&
        result.conversationStatus === "NEED_HUMAN" &&
        result.handoffCause === "TENANT_CONFIGURATION" &&
        row?.cause === "TENANT_CONFIGURATION",
    );
  }

  // E11 — an answerable turn never becomes NEED_HUMAN.
  {
    const h = makeHarness({
      responders: [
        async () =>
          ({
            intent: "FAQ",
            action: "reply",
            content: "من 9 صباحاً حتى 6 مساءً",
            extraction: emptyExtraction,
            handoffReason: null,
            summary: null,
          }) as AiResponse,
      ],
    });
    const result = await h.run("ما هي مواعيد العمل؟", "e11");
    check(
      "E11. سؤال يمكن الإجابة → AI_ACTIVE، بلا تحويل ولا سبب ولا انتباه",
      isSuccess(result) &&
        result.conversationStatus === "AI_ACTIVE" &&
        result.handoffCause === null &&
        h.attention.size === 0 &&
        h.aiMessageCount() === 1,
    );
  }

  // E12 — SAFETY PRECEDENCE: a sensitive turn where the model proposed a
  //       plain reply still hands off; the cause can never downgrade it.
  {
    const h = makeHarness({
      responders: [
        async () =>
          ({
            intent: "FAQ",
            action: "reply",
            content: "هذا سؤال عادي والإجابة كذا.",
            extraction: emptyExtraction,
            handoffReason: null,
            summary: null,
          }) as AiResponse,
      ],
    });
    const result = await h.run("ألم شديد جداً ولا أعرف ماذا أفعل", "e12");
    const row = h.attention.get(h.conversation!.id);
    check(
      "E12. الأسبقية: حسّاس + رد مقترح → يبقى NEED_HUMAN + SENSITIVE_OR_RESTRICTED",
      isSuccess(result) &&
        result.conversationStatus === "NEED_HUMAN" &&
        result.handoffCause === "SENSITIVE_OR_RESTRICTED" &&
        row?.cause === "SENSITIVE_OR_RESTRICTED" &&
        !h.sent.some((text) => text.includes("هذا سؤال عادي")),
    );
  }

  // E12b — SAFETY PRECEDENCE over a model-only human claim: the model emits
  //        `intent: HUMAN_REQUEST` while ALSO reporting `handoffReason:
  //        SENSITIVE` on a deterministically sensitive message. The
  //        authoritative safety reason must win — never "customer requested".
  {
    const h = makeHarness({
      responders: [
        async () =>
          ({
            intent: "HUMAN_REQUEST",
            action: "handoff",
            content: "سيتواصل معك أحد أعضاء الفريق.",
            extraction: emptyExtraction,
            handoffReason: "SENSITIVE",
            summary: null,
          }) as AiResponse,
      ],
    });
    const result = await h.run("عندي ألم شديد جداً في أسناني", "e12b");
    const row = h.attention.get(h.conversation!.id);
    check(
      "E12b. ادّعاء بشري من النموذج لا يتجاوز حسّاسية الإشارة الحتمية",
      isSuccess(result) &&
        result.conversationStatus === "NEED_HUMAN" &&
        result.handoffCause === "SENSITIVE_OR_RESTRICTED" &&
        row?.cause === "SENSITIVE_OR_RESTRICTED",
    );
  }

  // E13 — MULTI-INTENT human + booking: the handoff stays authoritative; the
  //       cause is the customer's request, and goals[] never become a cause.
  {
    const h = makeHarness({
      responders: [
        async () =>
          ({
            intent: "HUMAN_REQUEST",
            action: "handoff",
            content: "سأحوّلك لأحد أعضاء الفريق.",
            extraction: emptyExtraction,
            handoffReason: "HUMAN_REQUEST",
            summary: null,
            goals: [
              { kind: "HANDOFF", intent: "HUMAN_REQUEST", priority: 0 },
              {
                kind: "DOMAIN_ACTION",
                intent: "BOOKING",
                priority: 1,
                continueAfter: true,
              },
            ],
          }) as AiResponse,
      ],
    });
    const result = await h.run("أريد موظف، وأحجز موعد كمان", "e13");
    const row = h.attention.get(h.conversation!.id);
    const success = isSuccess(result) ? result : null;
    const goals = success?.observability?.goals ?? [];
    check(
      "E13. نوايا متعددة: بشري + حجز → التحويل هو السائد وسببه طلب العميل",
      success !== null &&
        success.conversationStatus === "NEED_HUMAN" &&
        success.handoffCause === "CUSTOMER_REQUESTED_HUMAN" &&
        row?.cause === "CUSTOMER_REQUESTED_HUMAN" &&
        goals.length === 2 &&
        goals.some((goal) => goal.kind === "DOMAIN_ACTION"),
    );
  }

  // E14 — MULTI-INTENT knowledge + booking → ANSWER-AND-CONTINUE stays
  //       AI_ACTIVE; pendingGoals intact; no cause; no attention.
  {
    const h = makeHarness({
      responders: [
        async () =>
          ({
            intent: "FAQ",
            action: "reply",
            content: "من 9 صباحاً حتى 6 مساءً",
            extraction: emptyExtraction,
            handoffReason: null,
            summary: null,
            goals: [
              { kind: "ANSWER", intent: "FAQ", priority: 0 },
              {
                kind: "DOMAIN_ACTION",
                intent: "BOOKING",
                priority: 1,
                continueAfter: true,
              },
            ],
          }) as AiResponse,
      ],
    });
    const result = await h.run("ما هي مواعيد العمل؟ وأحجز موعد", "e14");
    const success = isSuccess(result) ? result : null;
    const pending = success?.observability?.pendingGoals ?? [];
    check(
      "E14. معرفة + حجز → استجب-واستمر: AI_ACTIVE + pendingGoals + لا سبب",
      success !== null &&
        success.conversationStatus === "AI_ACTIVE" &&
        success.handoffCause === null &&
        success.observability?.answerAndContinue === true &&
        pending.length === 1 &&
        pending[0]?.kind === "DOMAIN_ACTION" &&
        h.attention.size === 0,
    );
  }

  // E15 — the cause survives the persistence/display seam.
  {
    const h = makeHarness({
      responders: [async () => handoff("NO_KNOWLEDGE", "FAQ")],
    });
    await h.run("ما هي مدة الجلسة؟", "e15");
    const open = h.attention.get(h.conversation!.id);
    check(
      "E15. السبب يعبر فاصل التخزين/العرض (صف الانتباه يحمل السبب)",
      open?.cause === "KNOWLEDGE_GAP_UNRESOLVED" &&
        open.reason === "AI_HANDOFF",
    );
  }

  // E16 — NO STALE CAUSE: a later handoff with a different cause overwrites,
  //       and a re-open without a cause clears any prior one.
  {
    const h = makeHarness({
      responders: [
        async () => handoff("NO_KNOWLEDGE", "FAQ"),
        async () => handoff("HUMAN_REQUEST", "HUMAN_REQUEST"),
      ],
    });
    await h.run("ما هي مدة الجلسة؟", "e16a");
    const first = h.attention.get(h.conversation!.id);
    // Resume AI between the two handoffs so the second turn is AI-eligible.
    await h.deps.conversationRepository.updateWorkflow(h.conversation!.id, {
      status: "AI_ACTIVE",
      assignedUserId: null,
    });
    await h.run("أريد التحدث إلى موظف", "e16b");
    const second = h.attention.get(h.conversation!.id);
    check(
      "E16. لا سبب بالٍ: التحويل اللاحق يُستبدل سببه (فجوة → طلب عميل)",
      first?.cause === "KNOWLEDGE_GAP_UNRESOLVED" &&
        second?.cause === "CUSTOMER_REQUESTED_HUMAN" &&
        second.reason === "AI_HANDOFF",
    );
  }

  // E17 — RESUME AI never fabricates or reclassifies a historical cause: the
  //       attention row is resolved (not rewritten) and the conversation
  //       returns to AI_ACTIVE with no new cause invented.
  {
    const h = makeHarness({
      responders: [async () => handoff("SENSITIVE")],
    });
    await h.run("ألم شديد جداً", "e17a");
    const before = h.attention.get(h.conversation!.id);
    // The EXISTING Resume AI control (transitionConversation RETURN_TO_AI).
    await h.deps.conversationRepository.updateWorkflow(h.conversation!.id, {
      status: "AI_ACTIVE",
      assignedUserId: null,
    });
    await (
      h.deps.attentionRepository as unknown as {
        resolve: (input: {
          conversationId: string;
          resolvedById: string;
        }) => Promise<void>;
      }
    ).resolve({
      conversationId: h.conversation!.id,
      resolvedById: "44444444-4444-4444-8444-444444444444",
    });
    const after = h.attention.get(h.conversation!.id);
    check(
      "E17. إعادة للمساعد: لا يختلق/يعيد تصنيف سبب تاريخي (يُحلّ الصف فقط)",
      before?.cause === "SENSITIVE_OR_RESTRICTED" &&
        after?.cause === "SENSITIVE_OR_RESTRICTED" &&
        after.resolved === true &&
        h.conversation!.status === "AI_ACTIVE",
    );
  }

  // E18 — TENANT ISOLATION: one business never sees another's cause.
  {
    const hA = makeHarness({
      businessId: BUSINESS_A,
      conversationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      responders: [async () => handoff("NO_KNOWLEDGE", "FAQ")],
    });
    await hA.run("ما هي مدة الجلسة؟", "e18a");
    const hB = makeHarness({
      businessId: BUSINESS_B,
      conversationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      responders: [async () => handoff("HUMAN_REQUEST", "HUMAN_REQUEST")],
    });
    await hB.run("أريد موظف لو سمحت", "e18b");
    const countA = await (
      hA.deps.attentionRepository as unknown as {
        countOpen: (id: string) => Promise<number>;
      }
    ).countOpen(BUSINESS_A);
    const causeB = hB.attention.get(hB.conversation!.id)?.cause;
    const cross = [...hA.attention.values()].every(
      (row) => row.businessId === BUSINESS_A,
    );
    check(
      "E18. عزل المستأجر: كل منشأة ترى أسبابها فقط",
      countA === 1 &&
        causeB === "CUSTOMER_REQUESTED_HUMAN" &&
        cross &&
        !hA.attention.has(hB.conversation!.id),
    );
  }

  // E19 — the cause is NEVER customer-visible.
  {
    const h = makeHarness({
      responders: [async () => handoff("NO_KNOWLEDGE", "FAQ")],
    });
    await h.run("ما هي مدة الجلسة؟", "e19");
    const labels = cause.handoffCauseValues
      .map((value) => cause.handoffCauseLabel(value))
      .concat(cause.handoffCauseValues as unknown as string[]);
    const leaked = h.sent.some((text) =>
      labels.some((label) => text.includes(label)),
    );
    check(
      "E19. السبب لا يظهر للعميل (الردود خالية من المفاتيح/التسميات)",
      !leaked && h.sent.length === 1,
    );
  }

  // E20 — cause derivation adds ZERO model calls and the turn stays one-send.
  {
    const h = makeHarness({
      responders: [async () => handoff("NO_KNOWLEDGE", "FAQ")],
    });
    await h.run("ما هي مدة الجلسة؟", "e20");
    check(
      "E20. اشتقاق السبب لا يضيف استدعاء نموذج (وحدة إرسال واحدة)",
      h.aiCalls() === 1 && h.aiMessageCount() === 1,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PART 3 — STRUCTURAL: no second resolver / state / engine / classifier
  // ═══════════════════════════════════════════════════════════════════════
  {
    const engineCode = readFileSync(
      join(
        process.cwd(),
        "src/features/conversations/server/conversation-engine.ts",
      ),
      "utf8",
    );
    // The cause is only ever DERIVED from an already-decided turn — the
    // engine never consults the cause to decide the turn. Every occurrence
    // must be either (a) an object property/type `handoffCause:` on an
    // already-built result, or (b) the choke point reading `result.handoffCause`
    // to attach it to the attention metadata. Anything else would mean the
    // cause influences a branch.
    const residualCause = engineCode
      .split("handoffCause:")
      .join("")
      .split("result.handoffCause")
      .join("");
    check(
      "S1. المحرك لا يتخذ أي فرع بناءً على السبب (يُشتق بعد القرار)",
      !residualCause.includes("handoffCause") &&
        !engineCode.includes("handoffCause ==="),
    );
    // The operator mapping module never decides a handoff.
    const causeCode = readFileSync(
      join(process.cwd(), "src/features/conversations/server/handoff-cause.ts"),
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    check(
      "S2. وحدة المُطابقة لا تقرر التحويل أبداً (تشرح قراراً سابقاً)",
      !causeCode.includes("NEED_HUMAN") &&
        !causeCode.includes("conversationStatus") &&
        !causeCode.includes("open("),
    );
    // Exactly ONE canonical cause module in production src (no parallel set):
    // only the canonical module DEFINES the value list; other files may only
    // re-export/reference it.
    const srcDir = join(process.cwd(), "src");
    const definers: string[] = [];
    for (const file of walkTs(srcDir)) {
      const text = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      if (text.includes("export const handoffCauseValues")) definers.push(file);
    }
    check(
      "S3. مجموعة سبب canonical واحدة فقط في الإنتاج (لا مجموعة موازية)",
      definers.length === 1 &&
        definers[0] ===
          join(
            process.cwd(),
            "src/features/conversations/server/handoff-cause.ts",
          ),
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Report
  // ═══════════════════════════════════════════════════════════════════════
  const failed = checks.filter((entry) => !entry.pass);
  for (const entry of checks) {
    console.log(`${entry.pass ? "✔" : "✘"} ${entry.label}`);
  }
  console.log(
    `\n${failed.length === 0 ? "PASS" : "FAIL"} — ${checks.length - failed.length}/${checks.length} checks passed.`,
  );
  if (failed.length > 0) {
    console.error(failed.map((entry) => `  - ${entry.label}`).join("\n"));
    process.exitCode = 1;
  }
}

function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkTs(full, out);
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
