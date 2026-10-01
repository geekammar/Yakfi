import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * FlowPilot — FIRST-CLASS CLARIFY check (PROMPT-AI-ARCH-06 — Slice 4).
 *
 * Focused, OFFLINE guard for the first-class CLARIFY behavior
 * (docs/ai/TARGET_ARCHITECTURE.md §3.11 / §7 / §17 Slice 4). No DB, no
 * network, no LLM, no keys — the pure resolver + clarification handler +
 * ConversationState merge, plus in-memory engine flows against fakes.
 *
 * Proves CLARIFY is emitted ONLY when justified, never causes an unnecessary
 * handoff, preserves state, resumes correctly, and costs ZERO extra model
 * calls:
 *
 *  1  ambiguous request               → CLARIFY (not handoff), stays AI_ACTIVE
 *  2  booking missing one fact (date) → CLARIFY (not handoff), stays AI_ACTIVE
 *  3  ambiguous/ missing service      → CLARIFY (not handoff), stays AI_ACTIVE
 *  4  answerable ambiguity            → ANSWER (never CLARIFY)
 *  5  explicit human request          → HANDOFF (never CLARIFY)
 *  6  sensitive / restricted          → HANDOFF (never CLARIFY)
 *  7  knowledge gap (not clarifiable) → HANDOFF (never CLARIFY)
 *  8  clarification → customer answer → resumes (missing fact resolved)
 *  9  clarification → unrelated topic → task suspended, clarification pending
 * 10  return to pending task after interruption → RECOVERING, still pending
 * 11  no duplicate ConversationState (ONE module)
 * 12  no duplicate TurnPlan / resolver (ONE resolver, canonical AiTurnPlan)
 * 13  CLARIFY costs ZERO extra model calls (bypass=0, LLM=1, no 2nd call)
 * 14  existing greeting behavior unchanged (zero-call bypass, AI_ACTIVE)
 * 15  existing booking/availability behavior unchanged (one call, options)
 * 16  existing handoff behavior unchanged (explicit human / sensitive)
 *
 * Run: pnpm check:clarify
 */
export {};

type Check = { label: string; pass: boolean };

const SRC_DIR = join(process.cwd(), "src");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkTs(full, out);
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

async function main(): Promise<void> {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const planner =
    await import("../src/features/conversations/server/turn-planner");
  const stateMod =
    await import("../src/features/conversations/server/conversation-state");
  const clarify =
    await import("../src/features/conversations/server/clarification");
  const engine =
    await import("../src/features/conversations/server/conversation-engine");
  const relativeDate =
    await import("../src/features/conversations/server/relative-date");

  const { resolveTurnPlan } = planner;
  const { emptyConversationState, mergeConversationState } = stateMod;

  const checks: Check[] = [];
  function check(label: string, pass: boolean): void {
    checks.push({ label, pass });
  }

  // ── Decision factories (the normalized AI contract shape) ────────────────
  type Decision = Record<string, unknown>;
  const emptyExtraction = {
    service: null,
    provider: null,
    date: null,
    timePreference: null,
  };
  function reply(intent: string, overrides: Decision = {}): Decision {
    return {
      intent,
      action: "reply",
      content: "رد",
      extraction: emptyExtraction,
      handoffReason: null,
      summary: null,
      ...overrides,
    };
  }
  function handoff(
    intent: string,
    handoffReason: string,
    overrides: Decision = {},
  ): Decision {
    return {
      intent,
      action: "handoff",
      content: "تحويل",
      extraction: emptyExtraction,
      handoffReason,
      summary: null,
      ...overrides,
    };
  }
  const S = emptyConversationState();
  function resolve(decision: Decision, routing = "LLM") {
    return resolveTurnPlan({
      decision: decision as never,
      state: S as never,
      routing: routing as never,
      domain: { kind: "PENDING" } as never,
    });
  }

  // ── 1. Ambiguous request → CLARIFY (resolver) ────────────────────────────
  {
    const r = resolve(handoff("AMBIGUOUS", "AMBIGUOUS"));
    check(
      "1 طلب ملتبس → CLARIFY (قرار توضيح)، خطوة CLARIFY، سبب تحويل = null، سؤال واحد",
      r.decisionClass === "CLARIFY" &&
        r.precedenceRule === "CLARIFY_DECISION" &&
        r.plan.steps.length === 1 &&
        r.plan.steps[0]?.kind === "CLARIFY" &&
        r.handoffReason === null &&
        r.clarification?.type === "CLARIFY_INTENT" &&
        typeof r.clarification?.question === "string" &&
        r.clarification!.question.length > 0,
    );
  }

  // ── 4. Answerable ambiguity → ANSWER (never CLARIFY) ─────────────────────
  {
    const r = resolve(reply("FAQ"));
    // Even a reply that ALSO proposes a clarification keeps the answer.
    const rWithProposed = resolve(
      reply("FAQ", {
        clarification: { type: "CLARIFY_DATE", missingFacts: ["date"] },
      }),
    );
    check(
      "4 التباس قابل للإجابة → ANSWER (ليس CLARIFY)، حتى مع اقتراح توضيح",
      r.decisionClass === "ANSWER" &&
        r.clarification === null &&
        rWithProposed.decisionClass === "ANSWER" &&
        rWithProposed.clarification === null,
    );
  }

  // ── 5. Explicit human request → HANDOFF (never CLARIFY) ──────────────────
  {
    const r = resolve(handoff("HUMAN_REQUEST", "HUMAN_REQUEST"));
    check(
      "5 طلب موظف صريح → HANDOFF (أولوية الإنسان)، ليس CLARIFY",
      r.decisionClass === "HANDOFF" &&
        r.precedenceRule === "EXPLICIT_HUMAN_REQUEST" &&
        r.clarification === null,
    );
  }

  // ── 6. Sensitive / restricted → HANDOFF (never CLARIFY) ──────────────────
  {
    const r = resolve(handoff("AMBIGUOUS", "SENSITIVE"));
    check(
      "6 محتوى حساس → HANDOFF (أولوية السلامة)، ليس CLARIFY",
      r.decisionClass === "HANDOFF" &&
        r.precedenceRule === "SAFETY_RESTRICTED" &&
        r.handoffReason === "SENSITIVE" &&
        r.clarification === null,
    );
  }

  // ── 7. Knowledge gap (NOT clarifiable) → HANDOFF ─────────────────────────
  {
    const r = resolve(handoff("AMBIGUOUS", "NO_KNOWLEDGE"));
    check(
      "7 فجوة معرفة (NO_KNOWLEDGE) → HANDOFF (قرار عادي)، ليست قابلة للتوضيح",
      r.decisionClass === "HANDOFF" &&
        r.precedenceRule === "NORMAL_DECISION" &&
        r.handoffReason === "NO_KNOWLEDGE" &&
        r.clarification === null,
    );
    // The handler agrees in isolation.
    check(
      "7b معالج التوضيح يرفض فجوة المعرفة والحساس وطلب الإنسان صراحةً",
      clarify.planClarification(
        handoff("AMBIGUOUS", "NO_KNOWLEDGE") as never,
        S,
      ) === null &&
        clarify.planClarification(
          handoff("AMBIGUOUS", "SENSITIVE") as never,
          S,
        ) === null &&
        clarify.planClarification(
          handoff("HUMAN_REQUEST", "HUMAN_REQUEST") as never,
          S,
        ) === null,
    );
  }

  // ── 8. Clarification → customer answer → resumes ─────────────────────────
  {
    // Turn A: booking goal, service known, date MISSING → record CLARIFY_DATE.
    const asked = mergeConversationState(emptyConversationState(), {
      turnGoal: "BOOKING",
      factUpdates: [{ key: "service", value: "تنظيف أسنان" }],
      clarification: { type: "CLARIFY_DATE", missingFacts: ["date"] },
      turnId: "tA",
    }).state;
    // Turn B: the customer supplies the date → clarification resolves (resume).
    const resumed = mergeConversationState(asked, {
      turnGoal: "BOOKING",
      factUpdates: [{ key: "date", value: "2026-10-01" }],
      turnId: "tB",
    }).state;
    check(
      "8 توضيح ثم إجابة العميل: يُسجَّل الناقص ثم يُحَل ويُستأنف (مع حفظ الحقائق)",
      asked.missingFacts.length === 1 &&
        asked.missingFacts[0] === "date" &&
        asked.lastClarification?.type === "CLARIFY_DATE" &&
        asked.knownFacts.service === "تنظيف أسنان" &&
        // resumed: date supplied → nothing missing, clarification cleared…
        resumed.missingFacts.length === 0 &&
        resumed.lastClarification === null &&
        // …known facts preserved, task continued (not restarted)…
        resumed.knownFacts.service === "تنظيف أسنان" &&
        resumed.knownFacts.date === "2026-10-01" &&
        resumed.activeTask?.kind === "BOOKING" &&
        resumed.bookingStage === "DATE_SUPPLIED",
    );
  }

  // ── 9. Clarification → unrelated topic → suspended, still pending ────────
  {
    const asked = mergeConversationState(emptyConversationState(), {
      turnGoal: "BOOKING",
      factUpdates: [{ key: "service", value: "تنظيف أسنان" }],
      clarification: { type: "CLARIFY_DATE", missingFacts: ["date"] },
    }).state;
    // Unrelated FAQ turn: no date supplied → the pending clarification persists
    // and the booking task is suspended (interrupted), not erased.
    const interrupted = mergeConversationState(asked, {
      turnGoal: "FAQ",
    }).state;
    const frame = interrupted.topics.find((f) => f.goal === "BOOKING");
    check(
      "9 توضيح ثم موضوع مختلف: المهمة تُعلَّق (INTERRUPTED) والتوضيح يبقى معلّقاً",
      interrupted.bookingStage === "INTERRUPTED" &&
        frame?.suspendState === "INTERRUPTED" &&
        interrupted.missingFacts.includes("date") &&
        interrupted.lastClarification?.type === "CLARIFY_DATE" &&
        interrupted.knownFacts.service === "تنظيف أسنان" &&
        interrupted.activeTask?.kind === "BOOKING",
    );
  }

  // ── 10. Return to pending task after interruption → RECOVERING ───────────
  {
    const asked = mergeConversationState(emptyConversationState(), {
      turnGoal: "BOOKING",
      factUpdates: [{ key: "service", value: "تنظيف أسنان" }],
      clarification: { type: "CLARIFY_DATE", missingFacts: ["date"] },
    }).state;
    const interrupted = mergeConversationState(asked, {
      turnGoal: "FAQ",
    }).state;
    const returned = mergeConversationState(interrupted, {
      turnGoal: "BOOKING",
    }).state;
    const frame = returned.topics.find((f) => f.goal === "BOOKING");
    check(
      "10 العودة بعد المقاطعة: RECOVERING، المهمة مستمرة، التوضيح ما زال معلّقاً",
      returned.bookingStage === "RECOVERING" &&
        frame?.suspendState === "RECOVERING" &&
        returned.activeTask?.kind === "BOOKING" &&
        returned.missingFacts.includes("date") &&
        returned.lastClarification?.type === "CLARIFY_DATE",
    );
  }

  // ── 11. ONE ConversationState module (no duplicate state) ────────────────
  {
    const definers = walkTs(SRC_DIR).filter((file) =>
      /export (type|function) (ConversationState|mergeConversationState|emptyConversationState)\b/.test(
        read(file),
      ),
    );
    check(
      "11 حالة محادثة واحدة فقط (لا تكرار للحالة، لا آلة حالة ثانية)",
      definers.length === 1 &&
        definers[0]?.endsWith("conversation-state.ts") === true,
    );
  }

  // ── 12. ONE resolver + canonical AiTurnPlan (no duplicate TurnPlan) ──────
  {
    const resolverDefiners = walkTs(SRC_DIR).filter((file) =>
      /export (type|function|const) (resolveTurnPlan|ResolvedTurn|turnPrecedenceRules)\b/.test(
        read(file),
      ),
    );
    const plannerSrc = read(
      join(SRC_DIR, "features/conversations/server/turn-planner.ts"),
    );
    const reusesCanonical =
      /AiTurnPlan/.test(plannerSrc) &&
      !/export const \w*TurnPlanSchema|export type \w*Plan =\s*{/.test(
        plannerSrc,
      );
    // The clarification handler is its OWN module — it defines no resolver and
    // no state/plan model, so there is still exactly ONE of each.
    const clarificationDefiners = walkTs(SRC_DIR).filter((file) =>
      /export (type|function|const) (resolveTurnPlan|ConversationState|aiResponseSchema)\b/.test(
        read(file),
      ),
    );
    check(
      "12 محلّل واحد + AiTurnPlan القانونية (لا تمثيل خطة ثانٍ، لا تكرار TurnPlan)",
      resolverDefiners.length === 1 &&
        resolverDefiners[0]?.endsWith("turn-planner.ts") === true &&
        reusesCanonical &&
        !clarificationDefiners.some((f) => f.endsWith("clarification.ts")),
    );
  }

  // ── Engine harness (in-memory; no DB/network/LLM) ────────────────────────
  const BUSINESS_A = "11111111-1111-4111-8111-111111111111";
  const BRANCH_A = "44444444-4444-4444-8444-444444444444";
  const SERVICE_CLEAN = "33333333-3333-4333-8333-333333333333";
  const P1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
  const U1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
  const WHATSAPP = "+201001111111";
  const TEST_DATE = "2026-09-14"; // Monday
  const now = new Date();

  function openWeek(): Record<string, unknown> {
    const hours: Record<string, unknown> = {};
    for (const day of ["sat", "sun", "mon", "tue", "wed", "thu", "fri"]) {
      hours[day] = { open: "10:00", close: "18:00", closed: false };
    }
    return hours;
  }

  const services = [
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
    /**
     * Pre-seed the conversation history (newest LAST) so a RESUME / INTERRUPTION
     * turn runs through the REAL engine against prior engine-authored state
     * (a pending CLARIFY question, or a presented booking offer). The engine
     * re-derives ConversationState from this history exactly as production does.
     */
    seedMessages?: Array<{ senderType: string; content: string }>;
  }) {
    let aiCalls = 0;
    let appointmentWrites = 0;
    const usages: Array<{ kind: string }> = [];
    const messages: Array<{ senderType: string; content: string }> = [
      ...(opts.seedMessages ?? []),
    ];
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
    } | null = opts.seedMessages
      ? {
          id: "conv-seed",
          businessId: BUSINESS_A,
          customerId: "cust-1",
          branchId: BRANCH_A,
          status: "AI_ACTIVE",
          assignedUserId: null,
          aiSummary: null,
          lastMessageAt: now,
          createdAt: now,
          updatedAt: now,
        }
      : null;
    let seq = 0;
    let attentionOpens = 0;

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
          const msg = { id: `msg-${messages.length + 1}`, createdAt: now };
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
      attentionRepository: {
        open: async () => {
          attentionOpens += 1;
          return { id: "att-1" };
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
      result: result as Record<string, unknown>,
      aiCalls,
      appointmentWrites,
      attentionOpens,
      aiTurnCount: usages.filter((u) => u.kind === "AI_TURN").length,
      messages,
    };
  }

  type Obs = {
    ok?: boolean;
    assistantAction?: string;
    conversationStatus?: string;
    intent?: string | null;
    observability?: {
      turnPlan?: { steps?: Array<{ kind?: string; intent?: string }> };
      clarification?: { type?: string; missingFacts?: string[] };
      routingDecision?: string;
    };
  };

  // The ambiguous handoff the classifier/LLM would emit for an unclear turn.
  function ambiguousHandoff() {
    return {
      intent: "AMBIGUOUS",
      action: "handoff",
      content:
        "لم أفهم طلبك تماماً — سيرد عليك أحد أعضاء الفريق لمساعدتك قريباً.",
      extraction: emptyExtraction,
      handoffReason: "AMBIGUOUS",
      summary: null,
    };
  }
  function humanHandoff() {
    return {
      intent: "HUMAN_REQUEST",
      action: "handoff",
      content: "تحويل",
      extraction: emptyExtraction,
      handoffReason: "HUMAN_REQUEST",
      summary: null,
    };
  }
  function sensitiveHandoff() {
    return {
      intent: "AMBIGUOUS",
      action: "handoff",
      content: "تحويل",
      extraction: emptyExtraction,
      handoffReason: "SENSITIVE",
      summary: null,
    };
  }
  function knowledgeGapHandoff() {
    return {
      intent: "AMBIGUOUS",
      action: "handoff",
      content: "تحويل",
      extraction: emptyExtraction,
      handoffReason: "NO_KNOWLEDGE",
      summary: null,
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
  function legacyFaq() {
    return {
      intent: "FAQ",
      action: "reply",
      content: "من 9 صباحاً حتى 6 مساءً",
      extraction: emptyExtraction,
      handoffReason: null,
      summary: null,
    };
  }
  // A model `reply` the disclosure gate refuses (AMBIGUOUS discloses no backing
  // fact) — the shape a real LLM produces when it tries to answer a benign
  // social aside it cannot ground. Classified ANSWER, then disclosure-refused.
  function ambiguousReply() {
    return {
      intent: "AMBIGUOUS",
      action: "reply",
      content: "تمام، أنا في انتظارك.",
      extraction: emptyExtraction,
      handoffReason: null,
      summary: null,
    };
  }

  // ── 1 (engine). Ambiguous turn → CLARIFY reply, AI_ACTIVE, no handoff ────
  {
    const run = await runTurn({
      text: "دراجة نارية زرقاء",
      externalId: "clar-ambiguous",
      ai: { providerName: "fake-ai", respond: async () => ambiguousHandoff() },
    });
    const result = run.result as Obs;
    const aiMsg =
      run.messages.find((m) => m.senderType === "AI")?.content ?? "";
    check(
      "1e طلب ملتبس عبر المحرك: CLARIFY AI_ACTIVE (ليس NEED_HUMAN)، سؤال واحد، لا اهتمام",
      result.ok === true &&
        result.assistantAction === "AI_REPLY" &&
        result.conversationStatus === "AI_ACTIVE" &&
        run.attentionOpens === 0 &&
        aiMsg === clarify.CLARIFY_INTENT_QUESTION &&
        result.observability?.turnPlan?.steps?.[0]?.kind === "CLARIFY" &&
        result.observability?.clarification?.type === "CLARIFY_INTENT",
    );
  }

  // ── 2 (engine). Booking missing one fact (date) → CLARIFY, AI_ACTIVE ─────
  {
    const run = await runTurn({
      text: "عايز أحجز تنظيف أسنان",
      externalId: "clar-missing-date",
      ai: {
        providerName: "fake-ai",
        respond: async () => bookingAi("تنظيف أسنان", null),
      },
    });
    const result = run.result as Obs;
    const aiMsg =
      run.messages.find((m) => m.senderType === "AI")?.content ?? "";
    check(
      "2e حجز بحقيقة ناقصة (تاريخ): CLARIFY AI_ACTIVE (ليس تحويلاً)، نوع CLARIFY_DATE",
      result.ok === true &&
        result.assistantAction === "AI_REPLY" &&
        result.conversationStatus === "AI_ACTIVE" &&
        run.appointmentWrites === 0 &&
        aiMsg.includes("التاريخ") &&
        result.observability?.clarification?.type === "CLARIFY_DATE" &&
        result.observability?.clarification?.missingFacts?.includes("date") ===
          true &&
        result.observability?.turnPlan?.steps?.[0]?.kind === "CLARIFY",
    );
  }

  // ── 3 (engine). Missing service → CLARIFY_SERVICE, AI_ACTIVE ─────────────
  {
    const run = await runTurn({
      text: "عايز أحجز",
      externalId: "clar-missing-service",
      ai: {
        providerName: "fake-ai",
        respond: async () => bookingAi(null, TEST_DATE),
      },
    });
    const result = run.result as Obs;
    check(
      "3e خدمة ناقصة/ملتبسة: CLARIFY_SERVICE AI_ACTIVE (ليس تحويلاً)",
      result.ok === true &&
        result.assistantAction === "AI_REPLY" &&
        result.conversationStatus === "AI_ACTIVE" &&
        result.observability?.clarification?.type === "CLARIFY_SERVICE" &&
        result.observability?.clarification?.missingFacts?.includes(
          "service",
        ) === true,
    );
  }

  // ── 13. CLARIFY costs ZERO extra model calls ─────────────────────────────
  {
    // (a) LLM path: exactly ONE generative call, no second round-trip.
    const llm = await runTurn({
      text: "حاجة غير واضحة",
      externalId: "clar-zero-llm",
      ai: { providerName: "fake-ai", respond: async () => ambiguousHandoff() },
    });
    const llmResult = llm.result as Obs;
    // (b) Deterministic bypass: a too-short message clarifies with ZERO calls.
    const bypass = await runTurn({
      text: "؟",
      externalId: "clar-zero-bypass",
      expectAiNotCalled: true,
      ai: { providerName: "fake-ai", respond: async () => ambiguousHandoff() },
    });
    const bypassResult = bypass.result as Obs;
    check(
      "13 CLARIFY بلا نداء إضافي: مسار LLM = نداء واحد، مسار التجاوز = صفر نداء",
      llmResult.conversationStatus === "AI_ACTIVE" &&
        llm.aiCalls === 1 &&
        llm.aiTurnCount === 1 &&
        bypassResult.conversationStatus === "AI_ACTIVE" &&
        bypassResult.assistantAction === "AI_REPLY" &&
        bypass.aiCalls === 0 &&
        bypass.aiTurnCount === 0 &&
        bypassResult.observability?.routingDecision === "DETERMINISTIC_BYPASS",
    );
  }

  // ── 14. Existing greeting behavior unchanged ─────────────────────────────
  {
    const run = await runTurn({
      text: "السلام عليكم",
      externalId: "clar-greet",
      expectAiNotCalled: true,
      ai: { providerName: "fake-ai", respond: async () => legacyFaq() },
    });
    const result = run.result as Obs;
    check(
      "14 الترحيب كما هو: تجاوز حتمي، AI_ACTIVE، صفر نداء، خطة ANSWER",
      result.ok === true &&
        result.assistantAction === "AI_REPLY" &&
        result.conversationStatus === "AI_ACTIVE" &&
        result.intent === "GREETING" &&
        run.aiCalls === 0 &&
        result.observability?.turnPlan?.steps?.[0]?.kind === "ANSWER",
    );
  }

  // ── 15. Existing booking/availability behavior unchanged ─────────────────
  {
    const run = await runTurn({
      text: "عايز أحجز تنظيف أسنان يوم 2026-09-14",
      externalId: "clar-book",
      ai: {
        providerName: "fake-ai",
        respond: async () => bookingAi("تنظيف أسنان", TEST_DATE),
      },
    });
    const result = run.result as Obs;
    const aiMsg =
      run.messages.find((m) => m.senderType === "AI")?.content ?? "";
    check(
      "15 الحجز الكامل كما هو: خيارات AI_ACTIVE، نداء واحد، صفر كتابة، DOMAIN_ACTION",
      result.ok === true &&
        result.assistantAction === "AI_REPLY" &&
        result.conversationStatus === "AI_ACTIVE" &&
        run.aiCalls === 1 &&
        run.appointmentWrites === 0 &&
        aiMsg.includes("تنظيف أسنان") &&
        result.observability?.turnPlan?.steps?.[0]?.kind === "DOMAIN_ACTION",
    );
  }

  // ── 16. Existing handoff behavior unchanged (human + sensitive) ──────────
  {
    const human = await runTurn({
      text: "عايز أتكلم مع الدكتور نفسه رجاءً",
      externalId: "clar-human",
      ai: { providerName: "fake-ai", respond: async () => humanHandoff() },
    });
    const humanResult = human.result as Obs;
    const sensitive = await runTurn({
      text: "عندي ألم شديد",
      externalId: "clar-sensitive",
      ai: { providerName: "fake-ai", respond: async () => sensitiveHandoff() },
    });
    const sensitiveResult = sensitive.result as Obs;
    const gap = await runTurn({
      text: "سؤال بلا معرفة؟",
      externalId: "clar-gap",
      ai: {
        providerName: "fake-ai",
        respond: async () => knowledgeGapHandoff(),
      },
    });
    const gapResult = gap.result as Obs;
    check(
      "16 التحويل البشري كما هو: إنسان/حساس/فجوة-معرفة → NEED_HUMAN + اهتمام (لا CLARIFY)",
      humanResult.conversationStatus === "NEED_HUMAN" &&
        humanResult.assistantAction === "AI_HANDOFF" &&
        human.attentionOpens === 1 &&
        sensitiveResult.conversationStatus === "NEED_HUMAN" &&
        sensitive.attentionOpens === 1 &&
        gapResult.conversationStatus === "NEED_HUMAN" &&
        gap.attentionOpens === 1,
    );
  }

  // ── 17. SAFETY precedence: a model CLARIFY proposal on a sensitive turn ──
  //        (PROMPT-AI-EVAL-07 safety regression) → NEED_HUMAN, never CLARIFY.
  {
    const clarifyProposalOnSensitive = () => ({
      intent: "BOOKING",
      action: "handoff",
      content: "تحويل",
      extraction: emptyExtraction,
      handoffReason: "AMBIGUOUS",
      clarification: { type: "CLARIFY_SERVICE", missingFacts: ["service"] },
      summary: null,
    });
    const run = await runTurn({
      text: "عندي ألم شديد جداً في ضرسي من أمس",
      externalId: "clar-safety-regress",
      ai: {
        providerName: "fake-ai",
        respond: async () => clarifyProposalOnSensitive(),
      },
    });
    const result = run.result as Obs;
    check(
      "17 أولوية السلامة: اقتراح CLARIFY على محتوى حساس → NEED_HUMAN + اهتمام، ليس CLARIFY/AI_ACTIVE",
      result.ok === true &&
        result.conversationStatus === "NEED_HUMAN" &&
        result.assistantAction === "AI_HANDOFF" &&
        run.attentionOpens === 1 &&
        result.observability?.turnPlan?.steps?.[0]?.kind !== "CLARIFY",
    );
  }

  // ── 18. UNNECESSARY CLARIFY: a bare non-committal fragment, no pending ───
  //        task (PROMPT-AI-EVAL-07 st-ambiguous-idk) → NOT a CLARIFY.
  {
    const run = await runTurn({
      text: "مش عارف",
      externalId: "clar-noncommittal",
      ai: { providerName: "fake-ai", respond: async () => ambiguousHandoff() },
    });
    const result = run.result as Obs;
    check(
      "18 جملة غير ملتزمة بلا مهمة معلّقة → ليست CLARIFY (لا توضيح غير ضروري)",
      result.ok === true &&
        result.observability?.turnPlan?.steps?.[0]?.kind !== "CLARIFY" &&
        result.observability?.clarification === undefined &&
        result.conversationStatus === "NEED_HUMAN",
    );
  }

  // ══ PROMPT-AI-ARCH-08 — Slice 4 behavioral remediation ═══════════════════
  // Supplied-fact RESUME (colloquial Egyptian relative date) + INTERRUPTION
  // recovery, driven through the REAL engine against engine-authored state.

  const CLARIFY_DATE_MSG =
    clarify.CLARIFY_DATE_QUESTION ??
    "يرجى تحديد التاريخ المطلوب — مثال: 2026-09-14.";

  /** The canonical booking offer the engine authors (resumable task state). */
  function offerMessage(): string {
    return (
      'تتوفر المواعيد التالية لخدمة "تنظيف أسنان" يوم 2026-09-14:\n' +
      "1. د. سارة — 10:00 إلى 10:30\n" +
      "2. د. سارة — 10:30 إلى 11:00\n" +
      "يرجى اختيار أحد الخيارات وسيتواصل معك الفريق لإتمام الحجز."
    );
  }

  // ── 19. SUPPLIED-FACT RESUME: bare colloquial weekday «الخميس» binds the ──
  //        pending CLARIFY_DATE → booking advances, date NOT re-asked.
  {
    const run = await runTurn({
      text: "الخميس",
      externalId: "resume-weekday",
      seedMessages: [
        { senderType: "CUSTOMER", content: "عايز أحجز تنظيف أسنان" },
        { senderType: "AI", content: CLARIFY_DATE_MSG },
      ],
      ai: {
        providerName: "fake-ai",
        respond: async () => bookingAi("تنظيف أسنان", null),
      },
    });
    const result = run.result as Obs;
    const aiMsg =
      [...run.messages].reverse().find((m) => m.senderType === "AI")?.content ??
      "";
    check(
      "19 استئناف بتاريخ عامي «الخميس»: يُربط التاريخ ويتقدم الحجز (خيارات)، AI_ACTIVE، لا إعادة سؤال CLARIFY_DATE",
      result.ok === true &&
        result.conversationStatus === "AI_ACTIVE" &&
        result.assistantAction === "AI_REPLY" &&
        run.appointmentWrites === 0 &&
        aiMsg.includes("تتوفر المواعيد التالية") &&
        result.observability?.clarification?.type !== "CLARIFY_DATE" &&
        result.observability?.turnPlan?.steps?.[0]?.kind === "DOMAIN_ACTION",
    );
  }

  // ── 20. SUPPLIED-FACT RESUME: weekday inside a return phrase ──────────────
  //        «طيب نرجع للحجز — الخميس» → still binds, still advances.
  {
    const run = await runTurn({
      text: "طيب نرجع للحجز — الخميس",
      externalId: "resume-return-phrase",
      seedMessages: [
        { senderType: "CUSTOMER", content: "عايز أحجز تنظيف أسنان" },
        { senderType: "AI", content: CLARIFY_DATE_MSG },
      ],
      ai: {
        providerName: "fake-ai",
        respond: async () => bookingAi("تنظيف أسنان", null),
      },
    });
    const result = run.result as Obs;
    const aiMsg =
      [...run.messages].reverse().find((m) => m.senderType === "AI")?.content ??
      "";
    check(
      "20 استئناف بعبارة عودة «نرجع للحجز — الخميس»: يُربط التاريخ ويتقدم الحجز، AI_ACTIVE، لا إعادة سؤال",
      result.ok === true &&
        result.conversationStatus === "AI_ACTIVE" &&
        result.assistantAction === "AI_REPLY" &&
        aiMsg.includes("تتوفر المواعيد التالية") &&
        result.observability?.clarification?.type !== "CLARIFY_DATE",
    );
  }

  // ── 21. INTERRUPTION RECOVERY: a benign social pause during a resumable ───
  //        booking offer → preserved AI_ACTIVE (never NEED_HUMAN), task kept.
  {
    const run = await runTurn({
      text: "ثواني بس، أنا في مكالمة",
      externalId: "interrupt-social",
      seedMessages: [
        {
          senderType: "CUSTOMER",
          content: "عايز أحجز تنظيف أسنان يوم 2026-09-14",
        },
        { senderType: "AI", content: offerMessage() },
      ],
      // The model tries to answer the aside; it is unbacked (AMBIGUOUS reply)
      // and would be disclosure-refused → the interruption-recovery seam
      // preserves it instead of escalating.
      ai: { providerName: "fake-ai", respond: async () => ambiguousReply() },
    });
    const result = run.result as Obs;
    const offerStillPresent = run.messages.some((m) =>
      m.content.includes("تتوفر المواعيد التالية"),
    );
    check(
      "21 مقاطعة اجتماعية حميدة أثناء عرض حجز قابل للاستئناف: AI_ACTIVE (ليس NEED_HUMAN)، لا اهتمام، المهمة محفوظة",
      result.ok === true &&
        result.conversationStatus === "AI_ACTIVE" &&
        result.assistantAction === "AI_REPLY" &&
        run.attentionOpens === 0 &&
        offerStillPresent &&
        result.observability?.clarification?.type ===
          "CONFIRM_UNDERSTOOD_REQUEST",
    );
  }

  // ── 22. INTERRUPTION RETURN: after the preserved pause, the customer picks ─
  //        an offered slot → the booking resumes deterministically.
  {
    const run = await runTurn({
      text: "1",
      externalId: "interrupt-return",
      seedMessages: [
        {
          senderType: "CUSTOMER",
          content: "عايز أحجز تنظيف أسنان يوم 2026-09-14",
        },
        { senderType: "AI", content: offerMessage() },
        { senderType: "CUSTOMER", content: "ثواني بس، أنا في مكالمة" },
        {
          senderType: "AI",
          content: clarify.INTERRUPTION_ACK_QUESTION,
        },
      ],
      // A deterministic selection close-the-loop: no model call is expected.
      expectAiNotCalled: true,
      ai: { providerName: "fake-ai", respond: async () => legacyFaq() },
    });
    const result = run.result as Obs;
    check(
      "22 العودة بعد المقاطعة: اختيار «1» يستأنف الحجز حتمياً (صفر نداء نموذج)، ليس NEED_HUMAN بسبب فجوة",
      result.ok === true &&
        run.aiCalls === 0 &&
        result.conversationStatus !== "NEED_HUMAN",
    );
  }

  // ── 23. REGRESSION: a knowledge QUESTION during an interruption stays a ───
  //        NEED_HUMAN knowledge gap (never over-preserved). An unbacked reply
  //        to a «؟» question is refused and, because it is a question, the
  //        interruption-recovery seam deliberately does NOT preserve it.
  {
    const run = await runTurn({
      text: "عندكم خصومات؟",
      externalId: "interrupt-question-gap",
      seedMessages: [
        {
          senderType: "CUSTOMER",
          content: "عايز أحجز تنظيف أسنان يوم 2026-09-14",
        },
        { senderType: "AI", content: offerMessage() },
      ],
      ai: { providerName: "fake-ai", respond: async () => ambiguousReply() },
    });
    const result = run.result as Obs;
    check(
      "23 سؤال معرفي أثناء المقاطعة (بعلامة استفهام، غير مُسنَد) → NEED_HUMAN (فجوة معرفة لا تُحفظ خطأً)",
      result.ok === true && result.conversationStatus === "NEED_HUMAN",
    );
  }

  // ── 24. REGRESSION: an explicit human request during a resumable task ─────
  //        still → NEED_HUMAN (explicit human is never preserved as benign).
  {
    const run = await runTurn({
      text: "عايز أكلم موظف",
      externalId: "interrupt-human",
      seedMessages: [
        {
          senderType: "CUSTOMER",
          content: "عايز أحجز تنظيف أسنان يوم 2026-09-14",
        },
        { senderType: "AI", content: offerMessage() },
      ],
      ai: { providerName: "fake-ai", respond: async () => humanHandoff() },
    });
    const result = run.result as Obs;
    check(
      "24 طلب موظف صريح أثناء مهمة قابلة للاستئناف → NEED_HUMAN + اهتمام (أولوية الإنسان، لا حفظ حميد)",
      result.ok === true &&
        result.conversationStatus === "NEED_HUMAN" &&
        run.attentionOpens === 1,
    );
  }

  // ── 25. The colloquial relative-date normalizer (pure, deterministic) ─────
  {
    const today = "2026-09-13"; // Sunday (weekdayOfDate: sun)
    const thu = relativeDate.resolveEgyptianRelativeDate("الخميس", today);
    const thuPhrase = relativeDate.resolveEgyptianRelativeDate(
      "طيب نرجع للحجز — الخميس",
      today,
    );
    const tomorrow = relativeDate.resolveEgyptianRelativeDate("بكرة", today);
    const dayAfter = relativeDate.resolveEgyptianRelativeDate(
      "بعد بكرة",
      today,
    );
    const todayWord = relativeDate.resolveEgyptianRelativeDate(
      "النهاردة",
      today,
    );
    const isoVerbatim = relativeDate.resolveEgyptianRelativeDate(
      "2026-09-14",
      today,
    );
    const unknown = relativeDate.resolveEgyptianRelativeDate("حاجة", today);
    check(
      "25 مُطَبِّع التاريخ العامي: الخميس→2026-09-17، بكرة→14، بعد بكرة→15، النهاردة→13، ISO حرفي، غير معروف→null",
      thu === "2026-09-17" &&
        thuPhrase === "2026-09-17" &&
        tomorrow === "2026-09-14" &&
        dayAfter === "2026-09-15" &&
        todayWord === "2026-09-13" &&
        isoVerbatim === "2026-09-14" &&
        unknown === null,
    );
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
    `\nCLARIFY من الدرجة الأولى (Slice 4) صحيح: ${checks.length}/${checks.length} فحص ناجح.`,
  );
}

main().catch((error: Error) => {
  console.error(`فشل غير متوقع: ${error.message}`);
  if (error.stack) console.error(error.stack);
  process.exit(1);
});
