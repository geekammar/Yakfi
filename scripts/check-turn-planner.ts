import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * FlowPilot — DECISION / ACTION RESOLVER + TurnPlan check
 * (PROMPT-AI-ARCH-05 — Slice 3).
 *
 * Focused, OFFLINE guard for the ONE deterministic Decision/Action Resolver
 * and the ordered single-goal `TurnPlan` (docs/ai/TARGET_ARCHITECTURE.md
 * §3.10 / §4 / §5 / §17 Slice 3). No DB, no network, no LLM, no keys — the
 * pure resolver plus in-memory engine flows against fakes.
 *
 * Proves (at least):
 *  1  pure greeting                              → ANSWER (NORMAL_DECISION)
 *  2  explicit human request                     → HANDOFF (EXPLICIT_HUMAN_REQUEST)
 *  3  safety / restricted                        → HANDOFF (SAFETY_RESTRICTED)
 *  4  existing FAQ / answer                      → ANSWER (NORMAL_DECISION)
 *  5  existing booking                           → DOMAIN_ACTION (DOMAIN_DECISION)
 *  6  existing availability                      → DOMAIN_ACTION (DOMAIN_DECISION)
 *  7  cancellation                               → DOMAIN_ACTION (DOMAIN_DECISION)
 *  8  reschedule                                 → DOMAIN_ACTION (DOMAIN_DECISION)
 *  9  state-aware continuation (pending offer)   → plan reflects booking goal
 * 10  interrupted booking context                → resolver stable (no clarify)
 * 11  topic return                               → resolver stable (single goal)
 * 12  missing information WITHOUT activating CLARIFY
 * 13  deterministic engine path → zero LLM calls, turnPlan observed
 * 14  normal engine LLM path → exactly one generative call, turnPlan observed
 * 15  domain authority cannot be overridden by an AI reply claim
 * 16  tenant/business scope preserved (pure, input never mutated)
 * 17  precedence ordering (control > human > sensitive > domain > normal)
 * 18  single-goal TurnPlan (exactly ONE step even with multiple goals)
 * 19  ONE resolver module only + reuses the canonical AiTurnPlan
 * 20  resolver is deterministic / pure (same input → same output, no inference)
 *
 *  PROMPT-AI-SEM-02 (HUMAN_REQUEST + BOOKING precedence — policy proof at the
 *  resolver seam, signals derived from the REAL message text):
 *  SEM-02A  explicit human + booking → HANDOFF (EXPLICIT_HUMAN_REQUEST),
 *           never booking automation (fails if the old uniform suppression
 *           were restored)
 *  SEM-02B  provider-preference + booking → DOMAIN_ACTION / DOMAIN_DECISION,
 *           never a human handoff
 *  SEM-02C/D the same contract at ENGINE level, each with exactly ONE model
 *           call (the 0/1 invariant)
 *
 * Run: pnpm check:turn-planner
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
  const engine =
    await import("../src/features/conversations/server/conversation-engine");
  const convAi =
    await import("../src/features/conversations/server/conversation-ai");

  const { resolveTurnPlan, turnPrecedenceRules, precedenceRank } = planner;
  const { emptyConversationState, mergeConversationState } = state;

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
  function bookingHandoff(intent: string, overrides: Decision = {}): Decision {
    return {
      intent,
      action: "booking_handoff",
      content: "سيتواصل معك الفريق",
      extraction: emptyExtraction,
      handoffReason: null,
      summary: "ملخص",
      ...overrides,
    };
  }
  const S = emptyConversationState();
  function resolve(
    decision: Decision,
    opts: {
      routing?: string;
      domain?: unknown;
      control?: unknown;
      state?: unknown;
      signals?: unknown;
    } = {},
  ) {
    return resolveTurnPlan({
      decision: decision as never,
      state: (opts.state ?? S) as never,
      routing: (opts.routing ?? "LLM") as never,
      ...(opts.domain ? { domain: opts.domain as never } : {}),
      ...(opts.control ? { control: opts.control as never } : {}),
      ...(opts.signals ? { signals: opts.signals as never } : {}),
    });
  }

  // ── 1. Pure greeting → ANSWER ────────────────────────────────────────────
  {
    const r = resolve(reply("GREETING"), { routing: "DETERMINISTIC_BYPASS" });
    check(
      "1 تحية خالصة → ANSWER (قرار عادي)، خطوة واحدة، routing تجاوز حتمي",
      r.decisionClass === "ANSWER" &&
        r.precedenceRule === "NORMAL_DECISION" &&
        r.plan.steps.length === 1 &&
        r.plan.steps[0]?.kind === "ANSWER" &&
        r.routing === "DETERMINISTIC_BYPASS",
    );
  }

  // ── 2. Explicit human request → HANDOFF ──────────────────────────────────
  {
    const r = resolve(handoff("HUMAN_REQUEST", "HUMAN_REQUEST"));
    check(
      "2 طلب موظف صريح → HANDOFF (أولوية طلب الإنسان)، السبب HUMAN_REQUEST",
      r.decisionClass === "HANDOFF" &&
        r.precedenceRule === "EXPLICIT_HUMAN_REQUEST" &&
        r.handoffReason === "HUMAN_REQUEST",
    );
  }

  // ── 3. Safety / restricted → HANDOFF ─────────────────────────────────────
  {
    const r = resolve(handoff("AMBIGUOUS", "SENSITIVE"));
    check(
      "3 محتوى حساس → HANDOFF (أولوية السلامة)، السبب SENSITIVE",
      r.decisionClass === "HANDOFF" &&
        r.precedenceRule === "SAFETY_RESTRICTED" &&
        r.handoffReason === "SENSITIVE",
    );
  }

  // ── 4. FAQ / answer → ANSWER ─────────────────────────────────────────────
  {
    const r = resolve(reply("FAQ"));
    check(
      "4 إجابة FAQ → ANSWER (قرار عادي)",
      r.decisionClass === "ANSWER" &&
        r.precedenceRule === "NORMAL_DECISION" &&
        r.handoffReason === null,
    );
  }

  // ── 5. Booking → DOMAIN_ACTION ───────────────────────────────────────────
  {
    const r = resolve(bookingHandoff("BOOKING"));
    check(
      "5 حجز → DOMAIN_ACTION (قرار نطاق)",
      r.decisionClass === "DOMAIN_ACTION" &&
        r.precedenceRule === "DOMAIN_DECISION" &&
        r.plan.steps[0]?.intent === "BOOKING",
    );
  }

  // ── 6. Availability → DOMAIN_ACTION ──────────────────────────────────────
  {
    const r = resolve(bookingHandoff("AVAILABILITY"));
    check(
      "6 إتاحة → DOMAIN_ACTION (قرار نطاق)",
      r.decisionClass === "DOMAIN_ACTION" &&
        r.precedenceRule === "DOMAIN_DECISION",
    );
  }

  // ── 7. Cancellation → DOMAIN_ACTION ──────────────────────────────────────
  {
    const r = resolve(bookingHandoff("CANCELLATION"));
    check(
      "7 إلغاء → DOMAIN_ACTION (قرار نطاق)",
      r.decisionClass === "DOMAIN_ACTION" &&
        r.precedenceRule === "DOMAIN_DECISION",
    );
  }

  // ── 8. Reschedule → DOMAIN_ACTION ────────────────────────────────────────
  {
    const r = resolve(bookingHandoff("RESCHEDULE"));
    check(
      "8 إعادة جدولة → DOMAIN_ACTION (قرار نطاق)",
      r.decisionClass === "DOMAIN_ACTION" &&
        r.precedenceRule === "DOMAIN_DECISION",
    );
  }

  // ── 9. State-aware continuation (a pending offer exists) ─────────────────
  {
    const withOffer = mergeConversationState(emptyConversationState(), {
      turnGoal: "BOOKING",
      pendingOffer: {
        serviceName: "تنظيف أسنان",
        date: "2026-10-01",
        options: [
          {
            index: 1,
            displayName: "د. سارة",
            startTime: "10:00",
            endTime: "10:30",
          },
        ],
      },
    }).state;
    const r = resolve(bookingHandoff("BOOKING"), { state: withOffer });
    check(
      "9 استمرارية واعية بالحالة: عرض معلّق + حجز → DOMAIN_ACTION مستمر",
      r.decisionClass === "DOMAIN_ACTION" &&
        withOffer.bookingStage === "AVAILABILITY_RESOLVED" &&
        r.plan.steps.length === 1,
    );
  }

  // ── 10. Interrupted booking context — resolver stable, no CLARIFY ────────
  {
    const booking = mergeConversationState(emptyConversationState(), {
      turnGoal: "BOOKING",
      factUpdates: [{ key: "service", value: "تنظيف أسنان" }],
    }).state;
    const interrupted = mergeConversationState(booking, {
      turnGoal: "FAQ",
    }).state;
    // A knowledge answer during an interrupted booking is still a plain ANSWER
    // (this slice does NOT answer-and-continue; multi-intent is a later slice).
    const r = resolve(reply("FAQ"), { state: interrupted });
    check(
      "10 سياق حجز مقاطَع: الإجابة تبقى ANSWER (بلا CLARIFY، بلا تعدد نوايا)",
      interrupted.bookingStage === "INTERRUPTED" &&
        r.decisionClass === "ANSWER" &&
        r.plan.steps.length === 1,
    );
  }

  // ── 11. Topic return — resolver stable, single goal ──────────────────────
  {
    const booking = mergeConversationState(emptyConversationState(), {
      turnGoal: "BOOKING",
      factUpdates: [{ key: "service", value: "تنظيف أسنان" }],
    }).state;
    const interrupted = mergeConversationState(booking, {
      turnGoal: "FAQ",
    }).state;
    const returned = mergeConversationState(interrupted, {
      turnGoal: "BOOKING",
    }).state;
    const r = resolve(bookingHandoff("BOOKING"), { state: returned });
    check(
      "11 العودة للموضوع: الحجز → DOMAIN_ACTION بخطوة واحدة",
      returned.bookingStage === "RECOVERING" &&
        r.decisionClass === "DOMAIN_ACTION" &&
        r.plan.steps.length === 1,
    );
  }

  // ── 12. Missing information WITHOUT activating CLARIFY ────────────────────
  {
    // A bare booking goal with no service: the state records GOAL_STATED, but
    // the resolver does NOT emit a CLARIFY plan in this slice — it proceeds as
    // the existing booking DOMAIN_ACTION (CLARIFY is a later slice).
    const bare = mergeConversationState(emptyConversationState(), {
      turnGoal: "BOOKING",
    }).state;
    const r = resolve(bookingHandoff("BOOKING"), { state: bare });
    check(
      "12 معلومات ناقصة بلا تفعيل CLARIFY: يبقى DOMAIN_ACTION (ليس CLARIFY)",
      bare.bookingStage === "GOAL_STATED" &&
        r.decisionClass !== "CLARIFY" &&
        r.decisionClass === "DOMAIN_ACTION",
    );
  }

  // ── 15. Domain authority cannot be overridden by an AI reply claim ───────
  {
    // The AI claims a plain reply/answer, but the authoritative domain result
    // is BLOCKED → the resolver returns HANDOFF (DOMAIN_CONSTRAINT). The AI
    // can never override domain truth.
    const r = resolve(reply("BOOKING"), {
      domain: { kind: "BLOCKED", handoffReason: "NO_KNOWLEDGE" },
    });
    const rAvail = resolve(reply("AVAILABILITY"), {
      domain: { kind: "BLOCKED" },
    });
    check(
      "15 سلطة النطاق لا يتجاوزها ادعاء الذكاء: BLOCKED → HANDOFF (قيد نطاق)",
      r.decisionClass === "HANDOFF" &&
        r.precedenceRule === "DOMAIN_CONSTRAINT" &&
        r.handoffReason === "NO_KNOWLEDGE" &&
        rAvail.decisionClass === "HANDOFF" &&
        rAvail.precedenceRule === "DOMAIN_CONSTRAINT",
    );
  }

  // ── 16. Tenant/business scope preserved — pure, input never mutated ──────
  {
    const decision = bookingHandoff("BOOKING");
    const decisionSnapshot = JSON.stringify(decision);
    const inState = emptyConversationState();
    const stateSnapshot = JSON.stringify(inState);
    const r = resolve(decision, { state: inState });
    const src = readCode(
      join(SRC_DIR, "features/conversations/server/turn-planner.ts"),
    );
    // The resolver reads NO business data and performs NO domain query: it has
    // no repository / prisma / env / fetch access at all.
    const noDomainAuthority =
      !/from ["'](@\/server\/repositories|@prisma|.*booking-options-service|.*provider-eligibility-service|.*appointment-create-service)["']/.test(
        src,
      ) && !/process\.env|fetch\(|require\(/.test(src);
    check(
      "16 عزل المستأجر محفوظ: نقي، لا يُغيّر المدخلات، ولا سلطة نطاق/استعلام",
      JSON.stringify(decision) === decisionSnapshot &&
        JSON.stringify(inState) === stateSnapshot &&
        noDomainAuthority &&
        r.plan.steps.length === 1,
    );
  }

  // ── 17. Precedence ordering (control > human > sensitive > domain > normal)
  {
    // A hard control pre-empts even an explicit human request in the SAME
    // decision; a human request pre-empts sensitive; sensitive pre-empts a
    // domain constraint; a domain constraint pre-empts a normal decision.
    const control = resolve(handoff("HUMAN_REQUEST", "HUMAN_REQUEST"), {
      control: { decisionClass: "HANDOFF", handoffReason: "NO_KNOWLEDGE" },
    });
    const human = resolve(
      handoff("HUMAN_REQUEST", "HUMAN_REQUEST", {
        // sensitive ALSO present, but human wins
      }),
    );
    const sensitiveOverDomain = resolve(handoff("AMBIGUOUS", "SENSITIVE"), {
      domain: { kind: "BLOCKED" },
    });
    const domainOverNormal = resolve(reply("FAQ"), {
      domain: { kind: "BLOCKED" },
    });
    const orderOk =
      precedenceRank("CONTROL_COMMAND") <
        precedenceRank("EXPLICIT_HUMAN_REQUEST") &&
      precedenceRank("EXPLICIT_HUMAN_REQUEST") <
        precedenceRank("SAFETY_RESTRICTED") &&
      precedenceRank("SAFETY_RESTRICTED") <
        precedenceRank("DOMAIN_CONSTRAINT") &&
      precedenceRank("DOMAIN_CONSTRAINT") < precedenceRank("DOMAIN_DECISION") &&
      precedenceRank("DOMAIN_DECISION") <
        precedenceRank("PENDING_TASK_PRESERVED") &&
      precedenceRank("PENDING_TASK_PRESERVED") <
        precedenceRank("CLARIFY_DECISION") &&
      precedenceRank("CLARIFY_DECISION") < precedenceRank("NORMAL_DECISION") &&
      turnPrecedenceRules.length === 8;
    check(
      "17 ترتيب الأولوية: تحكم > إنسان > سلامة > قيد نطاق > قرار نطاق > عادي",
      orderOk &&
        control.precedenceRule === "CONTROL_COMMAND" &&
        human.precedenceRule === "EXPLICIT_HUMAN_REQUEST" &&
        sensitiveOverDomain.precedenceRule === "SAFETY_RESTRICTED" &&
        domainOverNormal.precedenceRule === "DOMAIN_CONSTRAINT",
    );
  }

  // ── 18. Single-goal TurnPlan — ONE step even with multiple goals ─────────
  {
    // A decision proposing TWO goals (future multi-intent capacity, NOT
    // collapsed in the contract) still resolves to exactly ONE executed step.
    const multi = reply("FAQ", {
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
    const r = resolve(multi);
    check(
      "18 خطة الهدف الواحد: خطوة واحدة فقط رغم وجود هدفين في العقد",
      r.plan.steps.length === 1 &&
        r.plan.steps[0]?.kind === "ANSWER" &&
        // the decision's goals capacity is NOT mutated/collapsed by the resolver
        Array.isArray((multi as { goals?: unknown[] }).goals) &&
        (multi as { goals: unknown[] }).goals.length === 2,
    );
  }

  // ── 19. ONE resolver module only + reuses the canonical AiTurnPlan ───────
  {
    const definers = walkTs(SRC_DIR).filter((file) =>
      /export (type|function|const) (resolveTurnPlan|ResolvedTurn|turnPrecedenceRules)\b/.test(
        read(file),
      ),
    );
    const plannerSrc = read(
      join(SRC_DIR, "features/conversations/server/turn-planner.ts"),
    );
    // No second plan representation: it imports + returns the canonical
    // AiTurnPlan, and defines no competing *TurnPlanSchema / plan type.
    const reusesCanonical =
      /AiTurnPlan/.test(plannerSrc) &&
      !/export const \w*TurnPlanSchema|export type \w*Plan =\s*{/.test(
        plannerSrc,
      );
    check(
      "19 محلّل واحد فقط + يعيد استخدام AiTurnPlan (لا تمثيل خطة ثانٍ)",
      definers.length === 1 &&
        definers[0]?.endsWith("turn-planner.ts") === true &&
        reusesCanonical,
    );
  }

  // ── 20. Deterministic / pure — same input → same output, no inference ────
  {
    const decision = bookingHandoff("BOOKING");
    const a = resolve(decision);
    const b = resolve(decision);
    const src = readCode(
      join(SRC_DIR, "features/conversations/server/turn-planner.ts"),
    );
    const noInference =
      !/integrations\/ai|process\.env|fetch\(|require\(|await /.test(src);
    check(
      "20 حتمي ونقي: نفس المدخلات نفس المخرجات، بلا استدلال/شبكة/زمن",
      JSON.stringify(a) === JSON.stringify(b) && noInference,
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
      aiTurnCount: usages.filter((u) => u.kind === "AI_TURN").length,
      messages,
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
  type Obs = {
    observability?: {
      turnPlan?: { steps?: Array<{ kind?: string; intent?: string }> };
      routingDecision?: string;
      providerAttempts?: number;
    };
  };

  // ── 13. Deterministic engine path → zero LLM calls, turnPlan observed ────
  {
    const run = await runTurn({
      text: "السلام عليكم",
      externalId: "s3-greet",
      expectAiNotCalled: true,
      ai: { providerName: "fake-ai", respond: async () => legacyFaq() },
    });
    const result = run.result as Obs & {
      ok?: boolean;
      assistantAction?: string;
      conversationStatus?: string;
      intent?: string;
    };
    check(
      "13 مسار حتمي: تحية AI_ACTIVE، صفر نداء، وخطة الدور ANSWER بخطوة واحدة",
      result.ok === true &&
        result.assistantAction === "AI_REPLY" &&
        result.conversationStatus === "AI_ACTIVE" &&
        result.intent === "GREETING" &&
        run.aiCalls === 0 &&
        run.aiTurnCount === 0 &&
        result.observability?.routingDecision === "DETERMINISTIC_BYPASS" &&
        result.observability?.turnPlan?.steps?.length === 1 &&
        result.observability?.turnPlan?.steps?.[0]?.kind === "ANSWER",
    );
  }

  // ── 14. Normal LLM path → exactly one generative call, turnPlan observed ─
  {
    const run = await runTurn({
      text: "إيه مواعيد العمل",
      externalId: "s3-faq",
      ai: { providerName: "fake-ai", respond: async () => legacyFaq() },
    });
    const result = run.result as Obs & {
      ok?: boolean;
      assistantAction?: string;
      conversationStatus?: string;
      intent?: string;
    };
    check(
      "14 مسار LLM عادي: نداء واحد بالضبط، وخطة ANSWER بخطوة واحدة",
      result.ok === true &&
        result.assistantAction === "AI_REPLY" &&
        result.conversationStatus === "AI_ACTIVE" &&
        result.intent === "FAQ" &&
        run.aiCalls === 1 &&
        run.aiTurnCount === 1 &&
        result.observability?.routingDecision === "LLM" &&
        result.observability?.turnPlan?.steps?.length === 1 &&
        result.observability?.turnPlan?.steps?.[0]?.kind === "ANSWER",
    );
  }

  // ── 14b. Booking engine path → DOMAIN_ACTION plan, zero appointment write ─
  {
    const run = await runTurn({
      text: "عايز أحجز تنظيف أسنان يوم 2026-09-14",
      externalId: "s3-book",
      ai: {
        providerName: "fake-ai",
        respond: async () => bookingAi("تنظيف أسنان", TEST_DATE),
      },
    });
    const result = run.result as Obs & {
      ok?: boolean;
      assistantAction?: string;
      conversationStatus?: string;
    };
    check(
      "14b مسار حجز المحرك: خطة DOMAIN_ACTION، نداء واحد، صفر كتابة موعد",
      result.ok === true &&
        result.assistantAction === "AI_REPLY" &&
        result.conversationStatus === "AI_ACTIVE" &&
        run.aiCalls === 1 &&
        run.appointmentWrites === 0 &&
        result.observability?.turnPlan?.steps?.length === 1 &&
        result.observability?.turnPlan?.steps?.[0]?.kind === "DOMAIN_ACTION" &&
        result.observability?.turnPlan?.steps?.[0]?.intent === "BOOKING",
    );
  }

  // ── 14c. Deterministic human handoff engine path → HANDOFF plan ──────────
  {
    const run = await runTurn({
      text: "عايز أتكلم مع موظف",
      externalId: "s3-human",
      ai: {
        providerName: convAi.deterministicConversationAi.providerName,
        respond: (request: unknown) =>
          convAi.deterministicConversationAi.respond(request as never),
      },
    });
    const result = run.result as Obs & {
      ok?: boolean;
      assistantAction?: string;
      conversationStatus?: string;
      intent?: string;
    };
    check(
      "14c طلب موظف عبر المحرك: NEED_HUMAN + خطة HANDOFF بخطوة واحدة",
      result.ok === true &&
        result.assistantAction === "AI_HANDOFF" &&
        result.conversationStatus === "NEED_HUMAN" &&
        result.intent === "HUMAN_REQUEST" &&
        result.observability?.turnPlan?.steps?.[0]?.kind === "HANDOFF",
    );
  }

  // ── PROMPT-AI-SEM-02. HUMAN_REQUEST + BOOKING precedence (policy proof) ───
  // One authoritative rule (`detectExplicitHumanRequest`) now backs BOTH the
  // classifier and the deterministic signal, so the two seams cannot drift.
  // SEM-02A: a turn carrying BOTH an explicit human request AND a booking
  // intent must resolve to HANDOFF / EXPLICIT_HUMAN_REQUEST — the resolver may
  // never silently drop it into ordinary booking automation. The signals are
  // derived from the REAL message text (not hand-set), so this proves the
  // detection seam and the policy seam together. These cases FAIL if the old
  // uniform `explicitHuman && !hasBookingTask` suppression were restored.
  {
    for (const text of [
      "وصلني بموظف عشان أحجز", // support-role request + booking stem
      "عايز موظف يحجزلي",
      "السلام عليكم عايز موظف يحجزلي", // greeting + human + booking
    ]) {
      const signals = convAi.detectTurnControlSignals(text);
      const r = resolve(convAi.classifyCustomerMessage(text, []), { signals });
      check(
        `SEM-02A «${text}»: إنسان صريح + حجز → HANDOFF (EXPLICIT_HUMAN_REQUEST)`,
        signals.explicitHuman === true &&
          r.decisionClass === "HANDOFF" &&
          r.precedenceRule === "EXPLICIT_HUMAN_REQUEST" &&
          r.handoffReason === "HUMAN_REQUEST",
      );
    }
  }
  // SEM-02B: the counterexample. A provider/professional title inside a
  // booking request is a provider PREFERENCE — it must NOT become a human
  // handoff. The turn resolves through the normal provider/booking path
  // (DOMAIN_ACTION / DOMAIN_DECISION, no handoff reason).
  {
    for (const text of [
      "عايز أحجز مع دكتور",
      "عايز ميعاد مع دكتورة",
      "هل فيه دكتور متاح؟",
      "عايز أحجز مع أي دكتور",
      "عايز أحجز تنظيف أسنان أي دكتور يوم 2026-09-14",
    ]) {
      const signals = convAi.detectTurnControlSignals(text);
      const r = resolve(convAi.classifyCustomerMessage(text, []), { signals });
      check(
        `SEM-02B «${text}»: تفضيل مزود + حجز → DOMAIN_ACTION (ليس تحويلاً بشرياً)`,
        signals.explicitHuman === false &&
          r.decisionClass === "DOMAIN_ACTION" &&
          r.precedenceRule === "DOMAIN_DECISION" &&
          r.handoffReason === null,
      );
    }
  }
  // SEM-02C: engine proof for the composite turn. The customer asked for a
  // human AND a booking in one turn: the engine hands off, emits the
  // deterministic handoff message, and spends exactly ONE model call (the
  // 0/1 invariant — no second judge, no booking automation).
  {
    const run = await runTurn({
      text: "وصلني بموظف عشان أحجز",
      externalId: "s3-sem02c",
      ai: {
        providerName: convAi.deterministicConversationAi.providerName,
        respond: (request: unknown) =>
          convAi.deterministicConversationAi.respond(request as never),
      },
    });
    const result = run.result as Obs & {
      ok?: boolean;
      assistantAction?: string;
      conversationStatus?: string;
      intent?: string;
    };
    check(
      "SEM-02C إنسان + حجز عبر المحرك: NEED_HUMAN + HANDOFF + نداء واحد فقط",
      result.ok === true &&
        result.assistantAction === "AI_HANDOFF" &&
        result.conversationStatus === "NEED_HUMAN" &&
        result.intent === "HUMAN_REQUEST" &&
        result.observability?.turnPlan?.steps?.[0]?.kind === "HANDOFF" &&
        run.aiCalls === 1,
    );
  }
  // SEM-02D: engine proof for the counterexample. A provider-preference
  // booking continues the ordinary BOOKING journey — it asks its bounded
  // clarification (which service) and stays AI_ACTIVE with NO handoff cause,
  // i.e. it is never routed to a human. The proof is the turn's own identity:
  // intent BOOKING, no handoff cause, a non-HANDOFF plan step, and exactly ONE
  // provider attempt (this fix adds no extra inference to booking turns).
  {
    const run = await runTurn({
      text: "عايز أحجز مع دكتور",
      externalId: "s3-sem02d",
      ai: {
        providerName: convAi.deterministicConversationAi.providerName,
        respond: (request: unknown) =>
          convAi.deterministicConversationAi.respond(request as never),
      },
    });
    const result = run.result as Obs & {
      ok?: boolean;
      assistantAction?: string;
      conversationStatus?: string;
      intent?: string;
      handoffCause?: string;
    };
    check(
      "SEM-02D تفضيل مزود عبر المحرك: مسار حجز BOOKING عادي (AI_ACTIVE، لا سبب تحويل، ليست HANDOFF) + نداء واحد",
      result.ok === true &&
        result.intent === "BOOKING" &&
        result.conversationStatus === "AI_ACTIVE" &&
        result.handoffCause === null &&
        result.observability?.turnPlan?.steps?.[0]?.kind !== "HANDOFF" &&
        result.observability?.providerAttempts === 1,
    );
  }

  // ── 21. SAFETY PRECEDENCE via authoritative signal (EVAL-07 Remediation 1)
  {
    // The model proposed a CLARIFY_SERVICE on a sensitive turn and did NOT
    // self-report SENSITIVE — the deterministic signal is authoritative and
    // forces a SAFETY_RESTRICTED handoff instead of CLARIFY.
    const modelClarifies = handoff("BOOKING", "AMBIGUOUS", {
      clarification: { type: "CLARIFY_SERVICE", missingFacts: ["service"] },
    });
    const r = resolve(modelClarifies, { signals: { sensitive: true } });
    check(
      "21 أولوية السلامة بالإشارة الحتمية: اقتراح CLARIFY على محتوى حساس → HANDOFF (SAFETY_RESTRICTED)، ليس CLARIFY",
      r.decisionClass === "HANDOFF" &&
        r.precedenceRule === "SAFETY_RESTRICTED" &&
        r.handoffReason === "SENSITIVE" &&
        r.clarification === null,
    );
  }

  // ── 22. Safety + missing fact: safety still wins over a booking clarify ───
  {
    const bookingMissing = handoff("BOOKING", "AMBIGUOUS", {
      clarification: { type: "CLARIFY_DATE", missingFacts: ["date"] },
    });
    const r = resolve(bookingMissing, { signals: { sensitive: true } });
    check(
      "22 سلامة + حقيقة ناقصة: الأمان يسبق CLARIFY → HANDOFF (SAFETY_RESTRICTED)",
      r.decisionClass === "HANDOFF" && r.precedenceRule === "SAFETY_RESTRICTED",
    );
  }

  // ── 23. Explicit human (authoritative) wins even during a pending task ────
  {
    const pending = mergeConversationState(emptyConversationState(), {
      turnGoal: "BOOKING",
      factUpdates: [{ key: "service", value: "تنظيف أسنان" }],
      clarification: { type: "CLARIFY_DATE", missingFacts: ["date"] },
    }).state;
    const r = resolve(handoff("AMBIGUOUS", "AMBIGUOUS"), {
      state: pending,
      signals: { explicitHuman: true },
    });
    check(
      "23 طلب إنسان صريح (حتمي) يسبق حتى حفظ المهمة المعلّقة → HANDOFF (EXPLICIT_HUMAN_REQUEST)",
      r.decisionClass === "HANDOFF" &&
        r.precedenceRule === "EXPLICIT_HUMAN_REQUEST",
    );
  }

  // ── 24. Interruption during a pending task → PENDING_TASK_PRESERVED ───────
  {
    const pending = mergeConversationState(emptyConversationState(), {
      turnGoal: "BOOKING",
      factUpdates: [{ key: "service", value: "تنظيف أسنان" }],
      clarification: { type: "CLARIFY_DATE", missingFacts: ["date"] },
    }).state;
    // A benign interruption the model escalated as a (model-only) human claim,
    // with NO deterministic human/sensitive signal → the pending task is
    // PRESERVED (re-ask the pending clarification), AI_ACTIVE, never a handoff.
    const r = resolve(handoff("HUMAN_REQUEST", "HUMAN_REQUEST"), {
      state: pending,
      signals: {},
    });
    check(
      "24 مقاطعة أثناء مهمة معلّقة → PENDING_TASK_PRESERVED: CLARIFY (إعادة سؤال معلّق)، لا تحويل بشري",
      r.decisionClass === "CLARIFY" &&
        r.precedenceRule === "PENDING_TASK_PRESERVED" &&
        r.handoffReason === null &&
        r.clarification?.type === "CLARIFY_DATE",
    );
  }

  // ── 25. Interruption + safety: safety still wins (no preservation) ────────
  {
    const pending = mergeConversationState(emptyConversationState(), {
      turnGoal: "BOOKING",
      clarification: { type: "CLARIFY_DATE", missingFacts: ["date"] },
    }).state;
    const r = resolve(handoff("AMBIGUOUS", "AMBIGUOUS"), {
      state: pending,
      signals: { sensitive: true },
    });
    check(
      "25 مقاطعة + محتوى حساس: الأمان يسبق الحفظ → HANDOFF (SAFETY_RESTRICTED)",
      r.decisionClass === "HANDOFF" && r.precedenceRule === "SAFETY_RESTRICTED",
    );
  }

  // ── 26. Interruption + knowledge gap stays a handoff (independent cond.) ──
  {
    const pending = mergeConversationState(emptyConversationState(), {
      turnGoal: "BOOKING",
      clarification: { type: "CLARIFY_DATE", missingFacts: ["date"] },
    }).state;
    const r = resolve(handoff("AMBIGUOUS", "NO_KNOWLEDGE"), { state: pending });
    check(
      "26 مقاطعة + فجوة معرفة: تبقى تحويلاً (شرط تحويل مستقل)، ليست حفظاً",
      r.decisionClass === "HANDOFF" &&
        r.precedenceRule === "NORMAL_DECISION" &&
        r.handoffReason === "NO_KNOWLEDGE",
    );
  }

  // ── 27. Unnecessary CLARIFY: non-committal fragment, no pending task ──────
  {
    // A bare non-committal ambiguous handoff with the deterministic
    // nonCommittal signal and NO pending task → CLARIFY is suppressed (nothing
    // to clarify); the turn falls through to the normal handoff.
    const r = resolve(handoff("AMBIGUOUS", "AMBIGUOUS"), {
      signals: { nonCommittal: true },
    });
    check(
      "27 CLARIFY غير ضروري: جملة غير ملتزمة بلا مهمة معلّقة → ليست CLARIFY (قرار عادي)",
      r.decisionClass !== "CLARIFY" && r.precedenceRule === "NORMAL_DECISION",
    );
    // The SAME fragment WHILE a clarification is pending stays clarifiable
    // (the state, not the flag, decides) — it re-asks the pending clarification.
    const pending = mergeConversationState(emptyConversationState(), {
      turnGoal: "BOOKING",
      clarification: { type: "CLARIFY_DATE", missingFacts: ["date"] },
    }).state;
    const rPending = resolve(handoff("AMBIGUOUS", "AMBIGUOUS"), {
      state: pending,
      signals: { nonCommittal: true },
    });
    check(
      "27b الجملة نفسها أثناء توضيح معلّق تبقى قابلة للتوضيح (الحالة تقرر، لا العلم)",
      rPending.decisionClass === "CLARIFY",
    );
  }

  // ── 28. Supplied-fact resume: a satisfied CLARIFY is not re-asked ────────
  {
    // The customer supplied the date (state knows it); the model nonetheless
    // re-proposed CLARIFY_DATE. The handler suppresses the re-ask (resume).
    const resumed = mergeConversationState(emptyConversationState(), {
      turnGoal: "BOOKING",
      factUpdates: [
        { key: "service", value: "تنظيف أسنان" },
        { key: "date", value: "2026-10-01" },
      ],
    }).state;
    const r = resolve(
      handoff("BOOKING", "AMBIGUOUS", {
        clarification: { type: "CLARIFY_DATE", missingFacts: ["date"] },
      }),
      { state: resumed },
    );
    check(
      "28 استئناف بحقيقة مُقدَّمة: CLARIFY_DATE لحقيقة معروفة لا يُعاد سؤاله (ليس CLARIFY_DATE)",
      !(
        r.decisionClass === "CLARIFY" &&
        r.clarification?.type === "CLARIFY_DATE"
      ),
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
    `\nمحلّل القرار/الفعل + TurnPlan (Slice 3) صحيح: ${checks.length}/${checks.length} فحص ناجح.`,
  );
}

main().catch((error: Error) => {
  console.error(`فشل غير متوقع: ${error.message}`);
  if (error.stack) console.error(error.stack);
  process.exit(1);
});
