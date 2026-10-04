import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * FlowPilot — AI TARGET ARCHITECTURE SLICE 0 check (PROMPT-AI-ARCH-02).
 *
 * Focused, OFFLINE guard for the additive contract + observability
 * groundwork (docs/ai/TARGET_ARCHITECTURE.md §17 Slice 0). No DB, no network,
 * no LLM, no keys — the engine flows run against in-memory fakes.
 *
 * Proves:
 *  1. the OLD contract still works (legacy response parses; unknown keys
 *     stripped; handoff/summary refinements unchanged);
 *  2. the NEW optional fields round-trip and are bounded;
 *  3. the single-goal synthesis bridge maps reply/handoff/booking_handoff to
 *     ANSWER/HANDOFF/DOMAIN_ACTION and explicit goals always win;
 *  4. representative engine flows keep their behavior byte-for-byte
 *     (greeting, FAQ, human-request handoff, booking, availability);
 *  5. the additive fields change NO engine outcome;
 *  6. observability is additive, content-free, and never costs an AI call;
 *  7. the zero-or-one generative call invariant holds (0 bypass, 1 normal);
 *  8. there is exactly ONE canonical decision schema / provider abstraction /
 *     no ConversationState and no second state machine;
 *  9. no AI code gained domain authority (no Prisma/appointments imports);
 * 10. the evaluation boundary stays valid and passes the new observables
 *     through `.passthrough()`.
 *
 * Run: pnpm check:ai-architecture
 */
export {};

type Check = { label: string; pass: boolean };

const SRC_DIR = join(process.cwd(), "src");

function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkTs(full, out);
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

async function main(): Promise<void> {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const contract =
    await import("../src/features/conversations/server/ai-contract");
  const observability =
    await import("../src/features/conversations/server/ai-observability");
  const engine =
    await import("../src/features/conversations/server/conversation-engine");
  const convAi =
    await import("../src/features/conversations/server/conversation-ai");
  const evalSchema =
    await import("../evaluation/schema/evaluation-result-schema");

  const checks: Check[] = [];
  function check(label: string, pass: boolean): void {
    checks.push({ label, pass });
  }

  // ── Fixtures ─────────────────────────────────────────────────────────────
  const BUSINESS_A = "11111111-1111-4111-8111-111111111111";
  const BRANCH_A = "44444444-4444-4444-8444-444444444444";
  const SERVICE_CLEAN = "33333333-3333-4333-8333-333333333333";
  const P1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
  const U1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
  const WHATSAPP = "+201001111111";
  const TEST_DATE = "2026-09-14"; // Monday
  const now = new Date();

  function legacyResponse(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      intent: "FAQ",
      action: "reply",
      content: "من 9 صباحاً حتى 6 مساءً",
      extraction: {
        service: null,
        provider: null,
        date: null,
        timePreference: null,
      },
      handoffReason: null,
      summary: null,
      ...overrides,
    };
  }

  // ── 1. Legacy contract still works ───────────────────────────────────────
  {
    const parsed = contract.parseAiResponse({
      ...legacyResponse(),
      reasoning: "chain of thought must be stripped",
    });
    check(
      "1 الرد القديم يمر (بلا حقول جديدة) و reasoning يُحذف",
      parsed !== null &&
        parsed.intent === "FAQ" &&
        parsed.action === "reply" &&
        !("reasoning" in parsed),
    );
  }

  // ── 2. Existing refinements unchanged ────────────────────────────────────
  {
    const handoffNoReason = contract.parseAiResponse(
      legacyResponse({ action: "handoff", intent: "HUMAN_REQUEST" }),
    );
    const bookingNoSummary = contract.parseAiResponse(
      legacyResponse({ action: "booking_handoff", intent: "BOOKING" }),
    );
    check(
      "2 قيود العقد القديمة باقية (handoff بلا سبب / booking بلا ملخص)",
      handoffNoReason === null && bookingNoSummary === null,
    );
  }

  // ── 3. Additive fields round-trip ────────────────────────────────────────
  {
    const parsed = contract.parseAiResponse(
      legacyResponse({
        goals: [
          {
            kind: "ANSWER",
            intent: "SERVICE_DISCOVERY",
            requiredKnowledge: "SERVICE_CATALOG",
            priority: 0,
          },
          {
            kind: "DOMAIN_ACTION",
            intent: "BOOKING",
            priority: 1,
            continueAfter: true,
          },
        ],
        clarification: {
          type: "CLARIFY_SERVICE",
          missingFacts: ["service"],
        },
        handoffCause: "KNOWLEDGE_GAP_UNRESOLVED",
        factUpdates: [{ key: "date", value: "2026-10-01", isRevision: true }],
      }),
    );
    check(
      "3 الحقول الإضافية تمر كاملة (goals/clarification/handoffCause/factUpdates)",
      parsed !== null &&
        parsed.goals?.length === 2 &&
        parsed.goals[0]?.kind === "ANSWER" &&
        parsed.goals[1]?.continueAfter === true &&
        parsed.clarification?.type === "CLARIFY_SERVICE" &&
        parsed.handoffCause === "KNOWLEDGE_GAP_UNRESOLVED" &&
        parsed.factUpdates?.[0]?.isRevision === true,
    );
  }

  // ── 4. Single-goal synthesis bridge ──────────────────────────────────────
  {
    const reply = contract.synthesizeDecisionGoals(
      contract.parseAiResponse(legacyResponse())!,
    );
    const handoff = contract.synthesizeDecisionGoals(
      contract.parseAiResponse(
        legacyResponse({
          action: "handoff",
          intent: "HUMAN_REQUEST",
          handoffReason: "HUMAN_REQUEST",
        }),
      )!,
    );
    const booking = contract.synthesizeDecisionGoals(
      contract.parseAiResponse(
        legacyResponse({
          action: "booking_handoff",
          intent: "BOOKING",
          summary: "حجز",
        }),
      )!,
    );
    check(
      "4 جسر الهدف الواحد: reply→ANSWER، handoff→HANDOFF، booking_handoff→DOMAIN_ACTION",
      reply.length === 1 &&
        reply[0]?.kind === "ANSWER" &&
        reply[0]?.intent === "FAQ" &&
        handoff[0]?.kind === "HANDOFF" &&
        booking[0]?.kind === "DOMAIN_ACTION",
    );
  }

  // ── 5. Explicit goals win; turnPlan reuses the same model ────────────────
  {
    const explicit = contract.parseAiResponse(
      legacyResponse({ goals: [{ kind: "CLARIFY", priority: 0 }] }),
    )!;
    const goals = contract.synthesizeDecisionGoals(explicit);
    const plan = contract.synthesizeTurnPlan(explicit);
    check(
      "5 الأهداف الصريحة تفوز والخطة خطوة واحدة بنفس النموذج",
      goals.length === 1 &&
        goals[0]?.kind === "CLARIFY" &&
        plan.steps.length === 1 &&
        plan.steps[0]?.kind === "CLARIFY",
    );
  }

  // ── 6. Additive bounds enforced ──────────────────────────────────────────
  {
    const badKind = contract.parseAiResponse(
      legacyResponse({ goals: [{ kind: "DIAGNOSE" }] }),
    );
    const tooManyGoals = contract.parseAiResponse(
      legacyResponse({
        goals: Array.from({ length: 9 }, () => ({ kind: "ANSWER" })),
      }),
    );
    const tooManyFacts = contract.parseAiResponse(
      legacyResponse({
        factUpdates: Array.from({ length: 17 }, (_, i) => ({
          key: `k${i}`,
          value: "v",
        })),
      }),
    );
    check(
      "6 الحدود مفروضة (صنف غير معروف / >8 أهداف / >16 تحديثاً)",
      badKind === null && tooManyGoals === null && tooManyFacts === null,
    );
  }

  // ── 7. ONE canonical decision schema ─────────────────────────────────────
  {
    const contractSource = read(
      join(SRC_DIR, "features/conversations/server/ai-contract.ts"),
    );
    const definitions = [
      ...contractSource.matchAll(/export const (\w*Schema) =/g),
    ].map((match) => match[1]);
    const competing = walkTs(SRC_DIR).filter((file) => {
      const source = read(file);
      return (
        /export const (aiDecisionSchema|aiResponseV2Schema|decisionSchema)\b/.test(
          source,
        ) || /export const aiResponseSchema\b/.test(source)
      );
    });
    check(
      "7 عقد قرار واحد فقط (aiResponseSchema في ai-contract وحده)",
      definitions.includes("aiResponseSchema") &&
        definitions.includes("aiGoalSchema") &&
        competing.length === 1 &&
        competing[0]?.endsWith("ai-contract.ts") === true,
    );
  }

  // ── 8. Provider abstraction unchanged ────────────────────────────────────
  {
    const typesSource = read(join(SRC_DIR, "server/integrations/ai/types.ts"));
    const providerAdapterDefs = walkTs(SRC_DIR).filter((file) =>
      /interface \w*ProviderAdapter\b/.test(read(file)),
    );
    const factory = await import("../src/server/integrations/ai/factory");
    check(
      "8 تجريد المزود لم يتغير (AiProviderAdapter واحد + factory كما هو)",
      typesSource.includes("interface AiProviderAdapter") &&
        typesSource.includes("readonly providerId: AiProviderId") &&
        typesSource.includes("readonly secretRef: string") &&
        typesSource.includes("call(request: AiRequest)") &&
        providerAdapterDefs.length === 1 &&
        typeof factory.createPolicyBackedAi === "function" &&
        typeof factory.adaptersFromEffectivePolicy === "function",
    );
  }

  // ── 9. Exactly ONE engine-owned ConversationState (Slice 2) ──────────────
  //     Slice 2 (PROMPT-AI-ARCH-04) introduces the engine-owned
  //     ConversationState foundation. The invariant is unchanged in spirit:
  //     there must be exactly ONE such module and NO second state machine.
  {
    const definers = walkTs(SRC_DIR).filter((file) =>
      /export (type|function) (ConversationState|mergeConversationState|emptyConversationState|deriveConversationStateFromHistory)\b/.test(
        read(file),
      ),
    );
    check(
      "9 حالة محادثة واحدة مملوكة للمحرك فقط (لا آلة حالة ثانية)",
      definers.length === 1 &&
        definers[0]?.endsWith("conversation-state.ts") === true,
    );
  }

  // ── 10. No domain authority moved into AI ────────────────────────────────
  {
    const aiFiles = [
      "features/conversations/server/ai-contract.ts",
      "features/conversations/server/conversation-ai.ts",
      "features/conversations/server/ai-observability.ts",
      "features/conversations/server/conversation-state.ts",
      "features/conversations/server/turn-planner.ts",
    ].map((rel) => join(SRC_DIR, rel));
    const forbidden =
      /from ["'](@\/server\/repositories|@prisma|.*booking-options-service|.*provider-eligibility-service|.*appointment-create-service)["']/;
    const offending = aiFiles.filter((file) => forbidden.test(read(file)));
    check(
      "10 لا سلطة نطاق في طبقة الذكاء (لا Prisma/مواعيد/إتاحة)",
      offending.length === 0,
    );
  }

  // ── 11. Observability is additive + content-free ─────────────────────────
  {
    const empty = observability.buildTurnObservability({});
    const legacy = contract.parseAiResponse(legacyResponse())!;
    const record = observability.buildTurnObservability({
      routingDecision: "LLM",
      response: legacy,
      provider: "codecraft",
      model: "deepseek-v4-flash",
      fallbackUsed: true,
      retryCount: 1,
      latencyMs: 1234,
      knowledgeSourceClass: [
        "BUSINESS_FAQ_STORE",
        "BUSINESS_FAQ_STORE",
        "CONVERSATION_STATE",
      ],
    });
    const serialized = JSON.stringify(record);
    check(
      "11 سجل الرصد إضافي: فارغ عند غياب المدخلات، ومكتمل عند وجودها",
      Object.keys(empty).length === 0 &&
        record.routingDecision === "LLM" &&
        record.goals?.[0]?.kind === "ANSWER" &&
        record.turnPlan?.steps.length === 1 &&
        record.provider === "codecraft" &&
        record.model === "deepseek-v4-flash" &&
        record.fallbackUsed === true &&
        record.retryCount === 1 &&
        record.latencyMs === 1234 &&
        record.knowledgeSourceClass?.length === 2,
    );
    check(
      "12 سجل الرصد بلا محتوى/أسرار/Chain-of-thought",
      !/"content"|prompt|secret|authorization|bearer|api[_-]?key|sk-[A-Za-z0-9]/.test(
        serialized,
      ),
    );
  }

  // ── 13. Observability copies proposed future fields verbatim ─────────────
  {
    const future = contract.parseAiResponse(
      legacyResponse({
        goals: [{ kind: "CLARIFY", priority: 0 }],
        clarification: { type: "CLARIFY_DATE", missingFacts: ["date"] },
        handoffCause: "AMBIGUITY_UNRESOLVED",
        factUpdates: [{ key: "date", value: "2026-10-01" }],
      }),
    )!;
    const record = observability.buildTurnObservability({
      routingDecision: "LLM",
      response: future,
    });
    check(
      "13 الرصد ينقل الحقول المقترحة كما هي (بلا تحويل)",
      record.goals?.[0]?.kind === "CLARIFY" &&
        record.clarification?.type === "CLARIFY_DATE" &&
        record.handoffCause === "AMBIGUITY_UNRESOLVED" &&
        record.factUpdates?.[0]?.key === "date",
    );
  }

  // ── Engine harness (in-memory; no DB/network/LLM) ────────────────────────
  type ServiceRow = {
    id: string;
    businessId: string;
    name: string;
    description: null;
    durationMinutes: number;
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: null;
  };

  function openWeek(): Record<string, unknown> {
    const hours: Record<string, unknown> = {};
    for (const day of ["sat", "sun", "mon", "tue", "wed", "thu", "fri"]) {
      hours[day] = { open: "10:00", close: "18:00", closed: false };
    }
    return hours;
  }

  const services: ServiceRow[] = [
    {
      id: SERVICE_CLEAN,
      businessId: BUSINESS_A,
      name: "تنظيف أسنان",
      description: null,
      durationMinutes: 30,
      isActive: true,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
  ];
  const faqs = [
    { question: "مواعيد العمل", answer: "من 9 صباحاً حتى 6 مساءً" },
  ];

  async function runTurn(opts: {
    text: string;
    externalId: string;
    ai: {
      providerName: string;
      respond: (request: unknown) => Promise<unknown>;
    };
    expectAiNotCalled?: boolean;
  }) {
    let aiCalls = 0;
    let appointmentWrites = 0;
    const usages: Array<{ kind: string }> = [];
    const messages: Array<{ senderType: string; content: string }> = [];
    let conversation: {
      id: string;
      businessId: string;
      customerId: string;
      branchId: string | null;
      status: string;
      assignedUserId: null;
      aiSummary: null;
      lastMessageAt: Date;
      createdAt: Date;
      updatedAt: Date;
    } | null = null;
    let seq = 0;

    const business = {
      id: BUSINESS_A,
      name: "عيادة",
      vertical: null,
      city: null,
      whatsappNumber: WHATSAPP,
      timezone: "Africa/Cairo",
      about: null,
      workingHours: openWeek(),
      slotDurationMinutes: 30,
      confirmationMode: "manual",
      faqs,
      cancellationPolicy: null,
      onboardingCompletedAt: now,
      isActive: true,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      assistantName: null,
      assistantStyle: null,
      defaultBranchId: BRANCH_A,
    };
    const customer = {
      id: "cust-1",
      businessId: BUSINESS_A,
      name: "عميل",
      phone: "+201234567890",
      notes: null,
      lastConversationAt: null,
      lastAppointmentAt: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    const branch = {
      id: BRANCH_A,
      businessId: BUSINESS_A,
      name: "الفرع الرئيسي",
      isActive: true,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };

    const deps = {
      businessRepository: {
        findByWhatsappNumber: async () => business,
        findById: async () => business,
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
          seq += 1;
          conversation = {
            id: `conv-${seq}`,
            businessId: input.businessId,
            customerId: input.customerId,
            branchId: input.branchId,
            status: "AI_ACTIVE",
            assignedUserId: null,
            aiSummary: null,
            lastMessageAt: now,
            createdAt: now,
            updatedAt: now,
          };
          return conversation;
        },
        addMessage: async (
          input: { senderType: string; content: string },
          workflow?: { status?: string },
        ) => {
          const msg = {
            id: `msg-${messages.length + 1}`,
            createdAt: now,
          };
          messages.push({
            senderType: input.senderType,
            content: input.content,
          });
          if (workflow?.status && conversation) {
            conversation = { ...conversation, status: workflow.status };
          }
          return msg;
        },
        getMessages: async () => [...messages].reverse(),
        update: async () => conversation,
        updateWorkflow: async (id: string, patch: { status: string }) => {
          if (conversation && conversation.id === id) {
            conversation = { ...conversation, status: patch.status };
          }
          return conversation;
        },
      },
      serviceRepository: {
        listByBusiness: async () => services,
        findById: async (id: string) =>
          services.find((service) => service.id === id) ?? null,
      },
      inboundDedupeRepository: {
        claim: async () => ({ status: "claimed" as const, claimId: "claim-1" }),
      },
      usageRepository: {
        record: async (input: { kind: string }) => {
          usages.push(input);
          return input;
        },
      },
      providerRepository: {
        listEligibleForService: async () => [
          { id: P1, displayName: "د. سارة", user: { name: "سارة" } },
        ],
        listAssignmentSeams: async () => [{ providerId: P1, userId: U1 }],
      },
      appointmentRepository: {
        listBlockingByAssignees: async () => [],
        createWithConflictCheck: async () => {
          appointmentWrites += 1;
          return null;
        },
      },
      ai: {
        providerName: opts.ai.providerName,
        respond: async (request: unknown) => {
          aiCalls += 1;
          if (opts.expectAiNotCalled)
            throw new Error("AI must not be called on a bypass turn");
          return opts.ai.respond(request);
        },
      },
      transport: {
        providerName: "fake-transport",
        send: async () => ({ provider: "fake-transport", delivered: true }),
      },
    } as unknown as Parameters<typeof engine.receiveInboundMessage>[0];

    const result = await engine.receiveInboundMessage(deps, {
      to: WHATSAPP,
      from: "+201234567890",
      text: opts.text,
      receivedAt: now.toISOString(),
      externalId: opts.externalId,
    });
    return {
      result,
      aiCalls,
      appointmentWrites,
      usages,
      messages,
      aiTurnCount: usages.filter((u) => u.kind === "AI_TURN").length,
    };
  }

  function bookingAi(service: string | null, date: string | null) {
    return {
      intent: "BOOKING",
      action: "reply",
      content: "سيتواصل معك الفريق",
      extraction: { service, provider: null, date, timePreference: null },
      handoffReason: null,
      summary: null,
    };
  }
  function availabilityAi(service: string | null, date: string | null) {
    return {
      intent: "AVAILABILITY",
      action: "reply",
      content: "سيتواصل معك الفريق",
      extraction: { service, provider: null, date, timePreference: null },
      handoffReason: null,
      summary: null,
    };
  }
  function asResult(result: unknown): {
    ok?: boolean;
    assistantAction?: string;
    intent?: string | null;
    conversationStatus?: string;
    observability?: {
      routingDecision?: string;
      goals?: Array<{ kind?: string; intent?: string }>;
      knowledgeSourceClass?: string[];
      provider?: string;
    };
  } {
    return result as never;
  }

  // ── 14. Greeting: deterministic bypass, zero calls, unchanged outcome ────
  {
    const run = await runTurn({
      text: "السلام عليكم",
      externalId: "s0-greet",
      expectAiNotCalled: true,
      ai: { providerName: "fake-ai", respond: async () => legacyResponse() },
    });
    const result = asResult(run.result);
    check(
      "14 تحية: رد ثابت AI_ACTIVE بلا أي نداء AI (كما قبل)",
      result.ok === true &&
        result.assistantAction === "AI_REPLY" &&
        result.conversationStatus === "AI_ACTIVE" &&
        result.intent === "GREETING" &&
        run.aiCalls === 0 &&
        run.aiTurnCount === 0,
    );
    check(
      "15 رصد التحية: تجاوز حتمي + هدف ANSWER مُشتق",
      result.observability?.routingDecision === "DETERMINISTIC_BYPASS" &&
        result.observability?.goals?.[0]?.kind === "ANSWER" &&
        result.observability?.provider === "deterministic-bypass",
    );
  }

  // ── 16. FAQ: one call, unchanged outcome, observability populated ────────
  {
    const run = await runTurn({
      text: "إيه مواعيد العمل",
      externalId: "s0-faq",
      ai: {
        providerName: "fake-ai",
        respond: async () => legacyResponse(),
      },
    });
    const result = asResult(run.result);
    check(
      "16 سؤال FAQ: نداء واحد، رد AI_ACTIVE، نفس السلوك",
      result.ok === true &&
        result.assistantAction === "AI_REPLY" &&
        result.conversationStatus === "AI_ACTIVE" &&
        result.intent === "FAQ" &&
        run.aiCalls === 1 &&
        run.aiTurnCount === 1,
    );
    check(
      "17 رصد FAQ: LLM + ANSWER + مصدر المعرفة BUSINESS_FAQ_STORE",
      result.observability?.routingDecision === "LLM" &&
        result.observability?.goals?.[0]?.kind === "ANSWER" &&
        result.observability?.knowledgeSourceClass?.includes(
          "BUSINESS_FAQ_STORE",
        ) === true,
    );
  }

  // ── 18. Deterministic human request: handoff unchanged + HANDOFF goal ────
  {
    const run = await runTurn({
      text: "عايز أتكلم مع موظف",
      externalId: "s0-human",
      ai: {
        providerName: convAi.deterministicConversationAi.providerName,
        respond: (request: unknown) =>
          convAi.deterministicConversationAi.respond(request as never),
      },
    });
    const result = asResult(run.result);
    check(
      "18 طلب موظف: تحويل NEED_HUMAN كما قبل + هدف HANDOFF",
      result.ok === true &&
        result.assistantAction === "AI_HANDOFF" &&
        result.conversationStatus === "NEED_HUMAN" &&
        result.intent === "HUMAN_REQUEST" &&
        run.aiCalls === 1 &&
        result.observability?.goals?.[0]?.kind === "HANDOFF",
    );
  }

  // ── 19. Booking: unchanged options path, no appointment write ────────────
  {
    const run = await runTurn({
      text: "عايز أحجز تنظيف أسنان يوم 2026-09-14",
      externalId: "s0-book",
      ai: {
        providerName: "fake-ai",
        respond: async () => bookingAi("تنظيف أسنان", TEST_DATE),
      },
    });
    const result = asResult(run.result);
    const aiMsg =
      run.messages.find((m) => m.senderType === "AI")?.content ?? "";
    check(
      "19 حجز: خيارات AI_ACTIVE، كتابة مواعيد = 0، نفس السلوك",
      result.ok === true &&
        result.assistantAction === "AI_REPLY" &&
        result.conversationStatus === "AI_ACTIVE" &&
        run.aiCalls === 1 &&
        run.appointmentWrites === 0 &&
        aiMsg.includes("تنظيف أسنان"),
    );
    check(
      "20 رصد الحجز: هدف DOMAIN_ACTION من العقد نفسه",
      result.observability?.goals?.[0]?.kind === "DOMAIN_ACTION" &&
        result.observability?.goals?.[0]?.intent === "BOOKING",
    );
  }

  // ── 21. Availability: one call, options unchanged ────────────────────────
  {
    const run = await runTurn({
      text: "إيه الأوقات المتاحة لتنظيف أسنان يوم 2026-09-14؟",
      externalId: "s0-avail",
      ai: {
        providerName: "fake-ai",
        respond: async () => availabilityAi("تنظيف أسنان", TEST_DATE),
      },
    });
    const result = asResult(run.result);
    check(
      "21 إتاحة: نداء واحد، رد بخيارات، نفس السلوك",
      result.ok === true &&
        result.assistantAction === "AI_REPLY" &&
        result.conversationStatus === "AI_ACTIVE" &&
        run.aiCalls === 1 &&
        run.aiTurnCount === 1,
    );
  }

  // ── 22. Additive fields change NO engine outcome ─────────────────────────
  //     Slice-0 invariant: additive decision fields that do NOT request
  //     answer-and-continue leave the turn byte-for-byte identical. (The
  //     DOMAIN-continuation activation introduced in Slice 5 — a knowledge
  //     goal PLUS a domain goal — is covered by `check:multi-intent`; here the
  //     enriched decision carries two ANSWERable goals + the other additive
  //     fields, so there is no domain goal to continue and the output is
  //     unchanged.)
  {
    const runPlain = await runTurn({
      text: "إيه مواعيد العمل",
      externalId: "s0-faq-plain",
      ai: { providerName: "fake-ai", respond: async () => legacyResponse() },
    });
    const runWithGoals = await runTurn({
      text: "إيه مواعيد العمل",
      externalId: "s0-faq-goals",
      ai: {
        providerName: "fake-ai",
        respond: async () =>
          legacyResponse({
            goals: [
              { kind: "ANSWER", intent: "FAQ", priority: 0 },
              { kind: "ANSWER", intent: "FAQ", priority: 1 },
            ],
            clarification: { type: "CLARIFY_DATE", missingFacts: ["date"] },
            handoffCause: "KNOWLEDGE_GAP_UNRESOLVED",
            factUpdates: [{ key: "date", value: "2026-10-01" }],
          }),
      },
    });
    const plain = asResult(runPlain.result);
    const enriched = asResult(runWithGoals.result);
    const plainMsg = runPlain.messages.find((m) => m.senderType === "AI");
    const enrichedMsg = runWithGoals.messages.find(
      (m) => m.senderType === "AI",
    );
    check(
      "22 الحقول الإضافية (بلا هدف نطاق للاستكمال) لا تغير أي نتيجة خارجية (سلوك متطابق)",
      plain.assistantAction === enriched.assistantAction &&
        plain.intent === enriched.intent &&
        plain.conversationStatus === enriched.conversationStatus &&
        plainMsg?.content === enrichedMsg?.content &&
        runPlain.aiCalls === runWithGoals.aiCalls,
    );
  }

  // ── 23. Zero-or-one generative call invariant ────────────────────────────
  {
    const greeting = await runTurn({
      text: "السلام عليكم",
      externalId: "s0-inv-greet",
      expectAiNotCalled: true,
      ai: { providerName: "fake-ai", respond: async () => legacyResponse() },
    });
    const faq = await runTurn({
      text: "إيه مواعيد العمل",
      externalId: "s0-inv-faq",
      ai: { providerName: "fake-ai", respond: async () => legacyResponse() },
    });
    check(
      "23 ثابت الصفر أو الواحد: تحية=0، دور عادي=1، ولا نداء إضافي للرصد",
      greeting.aiCalls === 0 &&
        faq.aiCalls === 1 &&
        greeting.aiCalls <= 1 &&
        faq.aiCalls <= 1,
    );
  }

  // ── 24. Evaluation boundary stays valid + passthrough observables ────────
  {
    const parsed = evalSchema.actualOutcomeSchema.parse({
      intent: "FAQ",
      action: "reply",
      goals: [{ kind: "ANSWER" }],
      turnPlan: { steps: [{ kind: "ANSWER" }] },
      clarification: { type: "CLARIFY_SERVICE" },
      handoffCause: "KNOWLEDGE_GAP_UNRESOLVED",
      factUpdates: [{ key: "date", value: "2026-10-01" }],
      knowledgeSourceClass: ["BUSINESS_FAQ_STORE"],
      routingDecision: "LLM",
      stateTransition: { from: "GOAL_STATED", to: "MISSING_SERVICE" },
      futureSystemOnlyKey: "preserved",
    });
    check(
      "24 حدود التقييم سليمة: الحقول الجديدة تمر و passthrough باقٍ",
      Array.isArray(parsed.goals) &&
        parsed.routingDecision === "LLM" &&
        (parsed as Record<string, unknown>).futureSystemOnlyKey === "preserved",
    );
  }

  // ── 25. Production never imports evaluation ──────────────────────────────
  {
    const offenders = [
      join(SRC_DIR, "features/conversations/server/ai-contract.ts"),
      join(SRC_DIR, "features/conversations/server/ai-observability.ts"),
    ].filter((file) => /from ["'](.*evaluation.*)["']/.test(read(file)));
    check("25 لا استيراد إنتاجي لملفات التقييم", offenders.length === 0);
  }

  // ── Report ───────────────────────────────────────────────────────────────
  let failed = 0;
  for (const { label, pass } of checks) {
    if (pass) console.log(`✔ ${label}`);
    else {
      console.error(`✘ ${label}`);
      failed += 1;
    }
  }
  if (failed > 0) {
    console.error(`\nفشل ${failed} من ${checks.length} فحص.`);
    process.exit(1);
  }
  console.log(
    `\nأساسيات Slice 0 (العقد الإضافي + الرصد) صحيحة: ${checks.length}/${checks.length} فحص ناجح.`,
  );
}

main().catch((error: Error) => {
  console.error(`فشل غير متوقع: ${error.message}`);
  if (error.stack) console.error(error.stack);
  process.exit(1);
});
