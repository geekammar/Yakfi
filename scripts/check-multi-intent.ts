import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * FlowPilot — MULTI-INTENT (goals + answer-and-continue) check
 * (PROMPT-AI-ARCH-09 — Slice 5).
 *
 * Focused, OFFLINE guard for the smallest production-side multi-intent
 * foundation (docs/ai/TARGET_ARCHITECTURE.md §17 Slice 5). No DB, no network,
 * no LLM, no keys — the pure resolver + state merge plus in-memory engine
 * flows against fakes.
 *
 * Proves (at least):
 *  1  single goal remains unchanged (ANSWER, no pending, no continue)
 *  2  two answerable goals are REPRESENTED (both kept; no domain pending)
 *  3  knowledge + booking → ANSWER-AND-CONTINUE (ANSWER + pending domain)
 *  4  the booking goal remains PENDING (pendingGoals carries DOMAIN_ACTION)
 *  5  pending booking SURVIVES next-turn continuation (merge resume clears it)
 *  6  knowledge + explicit human → HUMAN wins (no answer-and-continue)
 *  7  knowledge + sensitive → SAFETY wins (no answer-and-continue)
 *  8  knowledge + knowledge gap → knowledge-gap handoff preserved
 *  9  multi-intent does NOT cause a double send (one persisted AI message)
 * 10  multi-intent does NOT cause a second model call (exactly one)
 * 11  ONE ConversationState module only
 * 12  ONE TurnPlan representation only (single step, canonical AiTurnPlan)
 * 13  tenant isolation preserved (resolver pure, input never mutated)
 * 14  interruption + pending secondary goal preserved (survives a topic switch)
 * 15  goal ordering / precedence is DETERMINISTIC (order-independent select)
 * 16  deterministic bypass remains zero-call (greeting never continues)
 * 17  engine: answer-and-continue E2E — one send, AI_ACTIVE, invite appended
 * 18  history derivation reconstructs the pending domain goal (migration-safe)
 * 19  no second resolver / state / planner schema / classifier / inference
 * 20  no provider identifier in the decision contract; resolver has no domain
 *     mutation (no Prisma/repository/booking-service imports)
 * 21  ANSWER + BOOKING with top-level action=reply → answer-and-continue fires
 *     (PROMPT-AI-ARCH-11 remediated producer shape: ANSWER now, BOOKING pending)
 * 22  conflicting producer output (action=booking_handoff + [ANSWER,DOMAIN])
 *     does NOT weaken server precedence (resolver UNCHANGED; no a&c fabricated)
 *
 * Run: pnpm check:multi-intent
 */
export {};

type Check = { label: string; pass: boolean };

const SRC_DIR = join(process.cwd(), "src");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** Source with comments stripped — purity is a property of CODE, not docs. */
function readCode(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
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
  const state =
    await import("../src/features/conversations/server/conversation-state");
  const clarification =
    await import("../src/features/conversations/server/clarification");
  const engine =
    await import("../src/features/conversations/server/conversation-engine");

  const { resolveTurnPlan } = planner;
  const { emptyConversationState, mergeConversationState } = state;
  const { CONTINUE_DOMAIN_INVITE, derivePendingContinuation } = clarification;

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
  function resolve(
    decision: Decision,
    opts: {
      routing?: string;
      domain?: unknown;
      state?: unknown;
      signals?: unknown;
    } = {},
  ) {
    return resolveTurnPlan({
      decision: decision as never,
      state: (opts.state ?? S) as never,
      routing: (opts.routing ?? "LLM") as never,
      ...(opts.domain ? { domain: opts.domain as never } : {}),
      ...(opts.signals ? { signals: opts.signals as never } : {}),
    });
  }

  // The canonical multi-intent decision: a knowledge answer PLUS a domain goal.
  const KNOWLEDGE_PLUS_BOOKING = reply("FAQ", {
    goals: [
      { kind: "ANSWER", intent: "FAQ", priority: 0 },
      {
        kind: "DOMAIN_ACTION",
        intent: "BOOKING",
        priority: 1,
        continueAfter: true,
      },
    ],
  });

  // ── 1. Single goal remains unchanged ─────────────────────────────────────
  {
    const r = resolve(reply("FAQ"));
    check(
      "1 هدف واحد بلا تغيير: ANSWER، لا أهداف معلّقة، لا استكمال",
      r.decisionClass === "ANSWER" &&
        r.plan.steps.length === 1 &&
        r.pendingGoals.length === 0 &&
        r.answerAndContinue === false,
    );
  }

  // ── 2. Two answerable goals are REPRESENTED ──────────────────────────────
  {
    const twoAnswers = reply("FAQ", {
      goals: [
        { kind: "ANSWER", intent: "FAQ", priority: 0 },
        { kind: "ANSWER", intent: "FAQ", priority: 1 },
      ],
    });
    const r = resolve(twoAnswers);
    check(
      "2 هدفان قابلان للإجابة ممثَّلان: ANSWER، بلا هدف نطاق معلّق، العقد يحمل الهدفين",
      r.decisionClass === "ANSWER" &&
        r.pendingGoals.length === 0 &&
        r.answerAndContinue === false &&
        Array.isArray((twoAnswers as { goals?: unknown[] }).goals) &&
        (twoAnswers as { goals: unknown[] }).goals.length === 2,
    );
  }

  // ── 3. Knowledge + booking → ANSWER-AND-CONTINUE ─────────────────────────
  {
    const r = resolve(KNOWLEDGE_PLUS_BOOKING);
    check(
      "3 معرفة + حجز → استجب-واستمر: ANSWER + answerAndContinue، خطوة واحدة",
      r.decisionClass === "ANSWER" &&
        r.precedenceRule === "NORMAL_DECISION" &&
        r.plan.steps.length === 1 &&
        r.plan.steps[0]?.kind === "ANSWER" &&
        r.answerAndContinue === true,
    );
  }

  // ── 4. The booking goal remains PENDING ──────────────────────────────────
  {
    const r = resolve(KNOWLEDGE_PLUS_BOOKING);
    check(
      "4 هدف الحجز يبقى معلّقاً: pendingGoals يحمل DOMAIN_ACTION/BOOKING، والعقد غير مُعدَّل",
      r.pendingGoals.length === 1 &&
        r.pendingGoals[0]?.kind === "DOMAIN_ACTION" &&
        r.pendingGoals[0]?.intent === "BOOKING" &&
        (KNOWLEDGE_PLUS_BOOKING as { goals: unknown[] }).goals.length === 2,
    );
  }

  // ── 5. Pending booking SURVIVES next-turn continuation ───────────────────
  {
    // Turn 1: answer-and-continue defers the booking goal into state.
    const afterAnswer = mergeConversationState(emptyConversationState(), {
      turnGoal: "FAQ",
      deferredGoals: [{ kind: "DOMAIN_ACTION", intent: "BOOKING" }],
    }).state;
    const deferred =
      afterAnswer.pendingGoals.length === 1 &&
      afterAnswer.pendingGoals[0]?.intent === "BOOKING";
    // Turn 2: the customer continues the booking (a task goal) → the pending
    // goal is RESUMED (consumed), never re-asked, never lost.
    const afterResume = mergeConversationState(afterAnswer, {
      turnGoal: "BOOKING",
      factUpdates: [{ key: "service", value: "تنظيف أسنان" }],
    }).state;
    check(
      "5 الحجز المعلّق ينجو حتى الاستكمال: يُحفظ ثم يُستأنف فيُستهلك (لا يُفقد ولا يُعاد)",
      deferred && afterResume.pendingGoals.length === 0,
    );
  }

  // ── 6. Knowledge + explicit human → HUMAN wins ───────────────────────────
  {
    // Even with an answerable knowledge goal present, the deterministic
    // explicit-human signal (authoritative) hands off — never answer-and-continue.
    const r = resolve(KNOWLEDGE_PLUS_BOOKING, {
      signals: { explicitHuman: true },
    });
    check(
      "6 معرفة + طلب إنسان صريح → HUMAN يفوز (HANDOFF)، بلا استجب-واستمر",
      r.decisionClass === "HANDOFF" &&
        r.precedenceRule === "EXPLICIT_HUMAN_REQUEST" &&
        r.handoffReason === "HUMAN_REQUEST" &&
        r.answerAndContinue === false &&
        r.pendingGoals.length === 0,
    );
  }

  // ── 7. Knowledge + sensitive → SAFETY wins ───────────────────────────────
  {
    const r = resolve(KNOWLEDGE_PLUS_BOOKING, { signals: { sensitive: true } });
    check(
      "7 معرفة + محتوى حساس → السلامة تفوز (SAFETY_RESTRICTED)، بلا استجب-واستمر",
      r.decisionClass === "HANDOFF" &&
        r.precedenceRule === "SAFETY_RESTRICTED" &&
        r.handoffReason === "SENSITIVE" &&
        r.answerAndContinue === false &&
        r.pendingGoals.length === 0,
    );
  }

  // ── 8. Knowledge + knowledge gap → knowledge-gap handoff preserved ───────
  {
    // The knowledge question cannot be answered (NO_KNOWLEDGE) → the turn is a
    // handoff even though a domain goal exists. answer-and-continue only fires
    // for a genuine `reply` (action === "reply").
    const gap = handoff("FAQ", "NO_KNOWLEDGE", {
      goals: [
        { kind: "ANSWER", intent: "FAQ", priority: 0 },
        { kind: "DOMAIN_ACTION", intent: "BOOKING", priority: 1 },
      ],
    });
    const r = resolve(gap);
    check(
      "8 معرفة + فجوة معرفة → تحويل فجوة المعرفة محفوظ (NO_KNOWLEDGE)، بلا استجب-واستمر",
      r.decisionClass === "HANDOFF" &&
        r.handoffReason === "NO_KNOWLEDGE" &&
        r.answerAndContinue === false,
    );
  }

  // ── 21. ANSWER + BOOKING with top-level action=reply → ANSWER-AND-CONTINUE ─
  //      PROMPT-AI-ARCH-11: the exact REMEDIATED producer shape. When the model
  //      pins the TOP-LEVEL action to `reply` (the answerable knowledge goal)
  //      and defers the BOOKING goal via goals[] + continueAfter, the resolver's
  //      EXISTING answer-and-continue guard (`baseClass === "ANSWER" &&
  //      action === "reply"`) fires: ANSWER now, BOOKING preserved as pending.
  {
    const answerPlusBooking = reply("FAQ", {
      goals: [
        { kind: "ANSWER", intent: "FAQ", priority: 0 },
        {
          kind: "DOMAIN_ACTION",
          intent: "BOOKING",
          priority: 1,
          continueAfter: true,
        },
      ],
    });
    const r = resolve(answerPlusBooking);
    check(
      "21 إجابة + حجز بـ action=reply أعلى → استجب-واستمر: ANSWER + الحجز معلّق",
      r.decisionClass === "ANSWER" &&
        r.answerAndContinue === true &&
        r.pendingGoals.length === 1 &&
        r.pendingGoals[0]?.intent === "BOOKING",
    );
  }

  // ── 22. CONFLICTING producer output does NOT weaken server precedence ──────
  //      This is the EXACT EVAL-13 gap the ARCH-11 producer remediation closes
  //      at the PROMPT boundary: when the model emits a correct
  //      `[ANSWER, DOMAIN_ACTION]` pair but sets the TOP-LEVEL action to
  //      `booking_handoff` (not `reply`), the deterministic resolver — UNCHANGED
  //      — correctly DECLINES answer-and-continue (it never fabricates an answer
  //      the model did not back with a `reply`). The server stays authoritative:
  //      no answer-and-continue, no pending-goal fabrication, no double send.
  //      The remediation is PRODUCER-side (pin action=reply); the resolver
  //      guard is deliberately NOT relaxed.
  {
    const conflicting = {
      intent: "BOOKING",
      action: "booking_handoff",
      content: "تحويل للحجز",
      extraction: emptyExtraction,
      handoffReason: null,
      summary: "حجز + سؤال",
      goals: [
        { kind: "ANSWER", intent: "FAQ", priority: 0 },
        {
          kind: "DOMAIN_ACTION",
          intent: "BOOKING",
          priority: 1,
          continueAfter: true,
        },
      ],
    };
    const r = resolve(conflicting);
    check(
      "22 مخرَج متضارب (action=booking_handoff مع [ANSWER,DOMAIN]) لا يُضعف أسبقية الخادم: بلا استجب-واستمر",
      r.answerAndContinue === false && r.pendingGoals.length === 0,
    );
  }

  // ── 11. ONE ConversationState module only ────────────────────────────────
  {
    const definers = walkTs(SRC_DIR).filter((file) =>
      /export (type|function) (ConversationState|mergeConversationState|emptyConversationState|deriveConversationStateFromHistory)\b/.test(
        read(file),
      ),
    );
    check(
      "11 حالة محادثة واحدة فقط (لا نموذج حالة ثانٍ)",
      definers.length === 1 &&
        definers[0]?.endsWith("conversation-state.ts") === true,
    );
  }

  // ── 12. ONE TurnPlan representation only (single step, canonical) ─────────
  {
    const r = resolve(KNOWLEDGE_PLUS_BOOKING);
    const plannerSrc = read(
      join(SRC_DIR, "features/conversations/server/turn-planner.ts"),
    );
    const reusesCanonical =
      /AiTurnPlan/.test(plannerSrc) &&
      !/export const \w*TurnPlanSchema|export type \w*Plan =\s*{/.test(
        plannerSrc,
      );
    check(
      "12 تمثيل خطة واحد: خطوة واحدة منفَّذة + إعادة استخدام AiTurnPlan (لا مخطط ثانٍ)",
      r.plan.steps.length === 1 && reusesCanonical,
    );
  }

  // ── 13. Tenant isolation preserved — pure, input never mutated ───────────
  {
    const decision = JSON.parse(JSON.stringify(KNOWLEDGE_PLUS_BOOKING));
    const snapshot = JSON.stringify(decision);
    const inState = emptyConversationState();
    const stateSnapshot = JSON.stringify(inState);
    const r = resolve(decision, { state: inState });
    check(
      "13 عزل المستأجر محفوظ: المحلّل نقي، لا يُغيّر العقد ولا الحالة",
      JSON.stringify(decision) === snapshot &&
        JSON.stringify(inState) === stateSnapshot &&
        r.plan.steps.length === 1,
    );
  }

  // ── 14. Interruption + pending secondary goal preserved ──────────────────
  {
    // A booking goal was deferred (pending). A later NON-task interruption
    // (FAQ) must NOT drop the pending booking goal — it survives the topic
    // switch and remains recoverable.
    const deferred = mergeConversationState(emptyConversationState(), {
      turnGoal: "FAQ",
      deferredGoals: [{ kind: "DOMAIN_ACTION", intent: "BOOKING" }],
    }).state;
    const interrupted = mergeConversationState(deferred, {
      turnGoal: "FAQ",
    }).state;
    check(
      "14 مقاطعة + هدف ثانوي معلّق محفوظ: الحجز المعلّق ينجو من تبديل الموضوع",
      deferred.pendingGoals.length === 1 &&
        interrupted.pendingGoals.length === 1 &&
        interrupted.pendingGoals[0]?.intent === "BOOKING",
    );
  }

  // ── 15. Goal ordering / precedence is DETERMINISTIC ──────────────────────
  {
    // Regardless of the decision's goal ARRAY order, the knowledge ANSWER is
    // selected over a coexisting domain goal (answer-and-continue), and a
    // HANDOFF goal would outrank both. Order-independent → deterministic.
    const domainFirst = reply("FAQ", {
      goals: [
        { kind: "DOMAIN_ACTION", intent: "BOOKING", priority: 0 },
        { kind: "ANSWER", intent: "FAQ", priority: 1 },
      ],
    });
    const answerFirst = reply("FAQ", {
      goals: [
        { kind: "ANSWER", intent: "FAQ", priority: 0 },
        { kind: "DOMAIN_ACTION", intent: "BOOKING", priority: 1 },
      ],
    });
    const a = resolve(domainFirst);
    const b = resolve(answerFirst);
    check(
      "15 ترتيب الأهداف حتمي: ANSWER يُختار فوق DOMAIN_ACTION مهما كان ترتيب المصفوفة",
      a.decisionClass === "ANSWER" &&
        a.answerAndContinue === true &&
        a.pendingGoals[0]?.intent === "BOOKING" &&
        b.decisionClass === "ANSWER" &&
        b.answerAndContinue === true &&
        b.pendingGoals[0]?.intent === "BOOKING",
    );
  }

  // ── 18. History derivation reconstructs the pending domain goal ──────────
  {
    const withInvite = derivePendingContinuation([
      { senderType: "CUSTOMER", content: "إيه مواعيدكم وينفع أحجز؟" },
      {
        senderType: "AI",
        content: `من 9 لـ 6\n\n${CONTINUE_DOMAIN_INVITE}`,
      },
      { senderType: "CUSTOMER", content: "تمام" },
    ]);
    const without = derivePendingContinuation([
      { senderType: "AI", content: "من 9 لـ 6" },
    ]);
    check(
      "18 اشتقاق من التاريخ يعيد بناء الهدف المعلّق (علامة آمنة للهجرة)",
      withInvite?.intent === "BOOKING" && without === null,
    );
  }

  // ── 19. No second resolver / state / planner schema / classifier / inference
  {
    const resolverDefiners = walkTs(SRC_DIR).filter((file) =>
      /export (type|function|const) (resolveTurnPlan|ResolvedTurn|turnPrecedenceRules)\b/.test(
        read(file),
      ),
    );
    const plannerSrc = readCode(
      join(SRC_DIR, "features/conversations/server/turn-planner.ts"),
    );
    const clarificationSrc = readCode(
      join(SRC_DIR, "features/conversations/server/clarification.ts"),
    );
    const stateSrc = readCode(
      join(SRC_DIR, "features/conversations/server/conversation-state.ts"),
    );
    // No hidden inference / provider / classifier in the pure modules.
    const noInference = (src: string) =>
      !/integrations\/ai|process\.env|fetch\(|require\(|\.respond\(/.test(src);
    check(
      "19 لا محلّل/حالة/مخطط/مصنّف/استدلال ثانٍ (الوحدات النقية بلا استدلال)",
      resolverDefiners.length === 1 &&
        resolverDefiners[0]?.endsWith("turn-planner.ts") === true &&
        noInference(plannerSrc) &&
        noInference(clarificationSrc) &&
        noInference(stateSrc),
    );
  }

  // ── 20. No provider id in the contract; resolver has no domain mutation ──
  {
    const contractSrc = readCode(
      join(SRC_DIR, "features/conversations/server/ai-contract.ts"),
    );
    const plannerSrc = readCode(
      join(SRC_DIR, "features/conversations/server/turn-planner.ts"),
    );
    const noProviderInContract =
      !/AiProviderId|providerName|secretRef|atria|codecraft|deepseek/i.test(
        contractSrc,
      );
    const noDomainMutation =
      !/from ["'](@\/server\/repositories|@prisma|.*booking-options-service|.*provider-eligibility-service|.*appointment-create-service)["']/.test(
        plannerSrc,
      ) && !/createWithConflictCheck|prisma\./.test(plannerSrc);
    check(
      "20 لا معرّف مزود في العقد + المحلّل بلا طفرة نطاق (لا Prisma/مستودع/كتابة موعد)",
      noProviderInContract && noDomainMutation,
    );
  }

  // ── Engine harness (in-memory; no DB/network/LLM) ────────────────────────
  const BUSINESS_A = "11111111-1111-4111-8111-111111111111";
  const BRANCH_A = "44444444-4444-4444-8444-444444444444";
  const SERVICE_CLEAN = "33333333-3333-4333-8333-333333333333";
  const P1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
  const U1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
  const WHATSAPP = "+201001111111";
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

  // A persistent in-memory harness so a conversation survives across turns.
  function makeHarness() {
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
        providerName: "fake-ai",
        respond: async (request: unknown) => {
          aiCalls += 1;
          return currentResponder(request);
        },
      },
      transport: {
        providerName: "fake-transport",
        send: async () => ({ provider: "fake-transport", delivered: true }),
      },
    } as unknown as Parameters<typeof engine.receiveInboundMessage>[0];

    let currentResponder: (request: unknown) => Promise<unknown> = async () =>
      reply("FAQ");

    async function runTurn(opts: {
      text: string;
      externalId: string;
      respond: (request: unknown) => Promise<unknown>;
    }) {
      currentResponder = opts.respond;
      const result = await engine.receiveInboundMessage(deps, {
        to: WHATSAPP,
        from: "+201234567890",
        text: opts.text,
        receivedAt: now.toISOString(),
        externalId: opts.externalId,
      });
      return result as Record<string, unknown>;
    }

    return {
      runTurn,
      snapshot: () => ({
        aiCalls,
        appointmentWrites,
        aiTurnCount: usages.filter((u) => u.kind === "AI_TURN").length,
        messages: [...messages],
      }),
    };
  }

  // The multi-intent producer: a FAQ answer (disclosable) + a booking goal.
  function knowledgePlusBookingResponder(): Promise<unknown> {
    return Promise.resolve({
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
    });
  }

  type Res = {
    ok?: boolean;
    assistantAction?: string;
    conversationStatus?: string;
    intent?: string;
    observability?: {
      answerAndContinue?: boolean;
      pendingGoals?: Array<{ kind?: string; intent?: string }>;
      turnPlan?: { steps?: Array<{ kind?: string }> };
      routingDecision?: string;
    };
  };

  // ── 9/10/17. Answer-and-continue E2E: one send, one call, invite appended ─
  {
    const h = makeHarness();
    const result = (await h.runTurn({
      text: "إيه مواعيد العمل وينفع أحجز؟",
      externalId: "mi-knowledge-booking",
      respond: () => knowledgePlusBookingResponder(),
    })) as Res;
    const snap = h.snapshot();
    const aiMessages = snap.messages.filter((m) => m.senderType === "AI");
    const aiMsg = aiMessages[0]?.content ?? "";
    check(
      "9 لا إرسال مزدوج: رسالة AI واحدة فقط رغم تعدد النوايا",
      aiMessages.length === 1,
    );
    check(
      "10 لا نداء نموذج ثانٍ: نداء واحد بالضبط لتعدد النوايا",
      snap.aiCalls === 1 && snap.aiTurnCount === 1,
    );
    check(
      "17 استجب-واستمر عبر المحرك: AI_ACTIVE، إجابة المعرفة + دعوة الاستكمال في رسالة واحدة",
      result.ok === true &&
        result.assistantAction === "AI_REPLY" &&
        result.conversationStatus === "AI_ACTIVE" &&
        result.intent === "FAQ" &&
        aiMsg.includes("من 9 صباحاً حتى 6 مساءً") &&
        aiMsg.includes(CONTINUE_DOMAIN_INVITE) &&
        result.observability?.answerAndContinue === true &&
        result.observability?.pendingGoals?.[0]?.intent === "BOOKING" &&
        result.observability?.turnPlan?.steps?.length === 1,
    );
  }

  // ── 16. Deterministic bypass remains zero-call (greeting never continues) ─
  {
    const h = makeHarness();
    const result = (await h.runTurn({
      text: "السلام عليكم",
      externalId: "mi-greet",
      respond: () => knowledgePlusBookingResponder(),
    })) as Res;
    const snap = h.snapshot();
    check(
      "16 تجاوز حتمي يبقى صفر نداء: التحية لا تستجب-وتستمر، صفر نداء AI",
      result.ok === true &&
        result.conversationStatus === "AI_ACTIVE" &&
        result.intent === "GREETING" &&
        snap.aiCalls === 0 &&
        result.observability?.routingDecision === "DETERMINISTIC_BYPASS" &&
        result.observability?.answerAndContinue !== true,
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
    `\nتعدد النوايا + استجب-واستمر (Slice 5) صحيح: ${checks.length}/${checks.length} فحص ناجح.`,
  );
}

main().catch((error: Error) => {
  console.error(`فشل غير متوقع: ${error.message}`);
  if (error.stack) console.error(error.stack);
  process.exit(1);
});
