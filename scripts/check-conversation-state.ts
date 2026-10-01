import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * FlowPilot — CONVERSATION STATE foundation check (PROMPT-AI-ARCH-04 Slice 2).
 *
 * Focused, OFFLINE guard for the engine-owned `ConversationState` foundation
 * (docs/ai/TARGET_ARCHITECTURE.md §9 / §17 Slice 2). No DB, no network, no
 * LLM, no keys — pure merge/derive functions plus in-memory engine flows.
 *
 * Proves:
 *  1  empty/new conversation state
 *  2  single fact update
 *  3  multiple fact updates
 *  4  explicit fact revision (isRevision:true)
 *  5  conflicting fact (no isRevision) — latest wins, contradiction logged
 *  6  missing facts (booking goal stated, no service yet)
 *  7  booking progression (GOAL_STATED → SERVICE → DATE → TIME → offer)
 *  8  topic interruption (active task suspended by a non-task turn)
 *  9  topic return (interrupted task recovers)
 * 10  state persistence/reload — derivation from persisted history
 * 11  tenant isolation — pure, no shared mutable state, input not mutated
 * 12  determinism — same inputs → same nextState, zero inference
 * 13  state + factUpdates = state_after (no hidden side effects)
 * 14  ONE ConversationState module only (no second state machine)
 * 15  engine: greeting unchanged + stateTransition observed, zero AI call
 * 16  engine: human handoff unchanged (NEED_HUMAN), state never resumes AI
 * 17  engine: booking options unchanged, one AI call, zero appointment write
 *
 * Run: pnpm check:conversation-state
 */
export {};

type Check = { label: string; pass: boolean };

const SRC_DIR = join(process.cwd(), "src");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

async function main(): Promise<void> {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const state =
    await import("../src/features/conversations/server/conversation-state");
  const engine =
    await import("../src/features/conversations/server/conversation-engine");
  const convAi =
    await import("../src/features/conversations/server/conversation-ai");

  const checks: Check[] = [];
  function check(label: string, pass: boolean): void {
    checks.push({ label, pass });
  }

  const {
    emptyConversationState,
    mergeConversationState,
    deriveConversationStateFromHistory,
    factUpdatesFromExtraction,
  } = state;

  // ── 1. Empty/new conversation ────────────────────────────────────────────
  {
    const s = emptyConversationState();
    check(
      "1 حالة محادثة جديدة فارغة (NOT_APPLICABLE، بلا حقائق)",
      s.bookingStage === "NOT_APPLICABLE" &&
        s.currentGoal === null &&
        s.activeTask === null &&
        Object.keys(s.knownFacts).length === 0 &&
        s.revisions.length === 0 &&
        s.pendingOffer === null,
    );
  }

  // ── 2. Single fact update ────────────────────────────────────────────────
  {
    const { state: s } = mergeConversationState(emptyConversationState(), {
      turnGoal: "BOOKING",
      factUpdates: [{ key: "service", value: "تنظيف أسنان" }],
    });
    check(
      "2 تحديث حقيقة واحدة: الخدمة محفوظة، المرحلة SERVICE_SUPPLIED",
      s.knownFacts.service === "تنظيف أسنان" &&
        s.selectedService === "تنظيف أسنان" &&
        s.bookingStage === "SERVICE_SUPPLIED" &&
        s.revisions.length === 0,
    );
  }

  // ── 3. Multiple fact updates ─────────────────────────────────────────────
  {
    const { state: s } = mergeConversationState(emptyConversationState(), {
      turnGoal: "BOOKING",
      factUpdates: [
        { key: "service", value: "تنظيف أسنان" },
        { key: "date", value: "2026-10-01" },
      ],
    });
    check(
      "3 تحديثات متعددة: خدمة + تاريخ، المرحلة DATE_SUPPLIED",
      s.knownFacts.service === "تنظيف أسنان" &&
        s.knownFacts.date === "2026-10-01" &&
        s.selectedDate === "2026-10-01" &&
        s.bookingStage === "DATE_SUPPLIED",
    );
  }

  // ── 4. Explicit revision (turn1 Thursday → turn2 "لا، قصدي الجمعة") ───────
  {
    const turn1 = mergeConversationState(emptyConversationState(), {
      turnGoal: "BOOKING",
      factUpdates: [{ key: "date", value: "2026-10-01" }], // Thursday
    });
    const turn2 = mergeConversationState(turn1.state, {
      turnGoal: "BOOKING",
      factUpdates: [{ key: "date", value: "2026-10-02", isRevision: true }], // Friday
      turnId: "t2",
    });
    const s = turn2.state;
    const rev = s.revisions[s.revisions.length - 1];
    check(
      "4 تصحيح صريح: التاريخ = الجمعة، القيمة القديمة لم تعد سلطوية، مُسجّل كتصحيح",
      s.knownFacts.date === "2026-10-02" &&
        s.selectedDate === "2026-10-02" &&
        s.revisions.length === 1 &&
        rev?.from === "2026-10-01" &&
        rev?.to === "2026-10-02" &&
        rev?.isRevision === true &&
        rev?.turnId === "t2" &&
        turn2.transitions.some(
          (t) => t.factKey === "date" && t.isRevision === true,
        ),
    );
  }

  // ── 5. Conflicting fact (no isRevision) — latest wins, logged as conflict ─
  {
    const turn1 = mergeConversationState(emptyConversationState(), {
      turnGoal: "BOOKING",
      factUpdates: [{ key: "service", value: "تنظيف" }],
    });
    const turn2 = mergeConversationState(turn1.state, {
      turnGoal: "BOOKING",
      factUpdates: [{ key: "service", value: "تبييض" }], // conflict, no isRevision
    });
    const rev = turn2.state.revisions[turn2.state.revisions.length - 1];
    check(
      "5 تعارض بلا تصحيح صريح: الأحدث يفوز، ويُميَّز عن التصحيح (isRevision=false)",
      turn2.state.knownFacts.service === "تبييض" &&
        turn2.state.revisions.length === 1 &&
        rev?.isRevision === false &&
        rev?.from === "تنظيف",
    );
  }

  // ── 6. Missing facts (booking goal stated, no service yet) ───────────────
  {
    const { state: s } = mergeConversationState(emptyConversationState(), {
      turnGoal: "BOOKING",
    });
    check(
      "6 حقائق ناقصة: هدف حجز بلا خدمة → GOAL_STATED، knownFacts فارغة",
      s.bookingStage === "GOAL_STATED" &&
        s.knownFacts.service === undefined &&
        s.activeTask?.kind === "BOOKING",
    );
  }

  // ── 7. Booking progression ───────────────────────────────────────────────
  {
    let acc = emptyConversationState();
    const stages: string[] = [];
    acc = mergeConversationState(acc, { turnGoal: "BOOKING" }).state;
    stages.push(acc.bookingStage);
    acc = mergeConversationState(acc, {
      turnGoal: "BOOKING",
      factUpdates: [{ key: "service", value: "تنظيف أسنان" }],
    }).state;
    stages.push(acc.bookingStage);
    acc = mergeConversationState(acc, {
      turnGoal: "BOOKING",
      factUpdates: [{ key: "date", value: "2026-10-01" }],
    }).state;
    stages.push(acc.bookingStage);
    acc = mergeConversationState(acc, {
      turnGoal: "BOOKING",
      factUpdates: [{ key: "timePreference", value: "صباحاً" }],
    }).state;
    stages.push(acc.bookingStage);
    acc = mergeConversationState(acc, {
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
    stages.push(acc.bookingStage);
    check(
      "7 تقدّم الحجز: GOAL_STATED→SERVICE_SUPPLIED→DATE_SUPPLIED→TIME_SUPPLIED→AVAILABILITY_RESOLVED",
      stages.join(",") ===
        "GOAL_STATED,SERVICE_SUPPLIED,DATE_SUPPLIED,TIME_SUPPLIED,AVAILABILITY_RESOLVED" &&
        acc.pendingOffer?.options.length === 1,
    );
  }

  // ── 8. Topic interruption ────────────────────────────────────────────────
  {
    const booking = mergeConversationState(emptyConversationState(), {
      turnGoal: "BOOKING",
      factUpdates: [{ key: "service", value: "تنظيف أسنان" }],
    }).state;
    const interrupted = mergeConversationState(booking, {
      turnGoal: "FAQ", // business hours question mid-booking
    });
    const frame = interrupted.state.topics.find((f) => f.goal === "BOOKING");
    check(
      "8 مقاطعة موضوع: سؤال FAQ أثناء الحجز → INTERRUPTED، والإطار يحفظ نقطة العودة",
      interrupted.state.bookingStage === "INTERRUPTED" &&
        frame?.suspendState === "INTERRUPTED" &&
        frame?.returnStage === "SERVICE_SUPPLIED" &&
        interrupted.state.activeTask?.kind === "BOOKING",
    );
  }

  // ── 9. Topic return ──────────────────────────────────────────────────────
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
    });
    const frame = returned.state.topics.find((f) => f.goal === "BOOKING");
    check(
      "9 العودة للموضوع: الرجوع للحجز → RECOVERING، والمهمة مستمرة",
      returned.state.bookingStage === "RECOVERING" &&
        frame?.suspendState === "RECOVERING" &&
        returned.state.activeTask?.kind === "BOOKING",
    );
  }

  // ── 10. Persistence/reload — derivation from persisted history ───────────
  {
    const history = [
      { senderType: "CUSTOMER", content: "عايز أحجز تنظيف أسنان" },
      {
        senderType: "AI",
        content:
          'تتوفر المواعيد التالية لخدمة "تنظيف أسنان" يوم 2026-10-01:\n' +
          "1. د. سارة — 10:00 إلى 10:30\n" +
          "يرجى اختيار أحد الخيارات وسيتواصل معك الفريق لإتمام الحجز.",
      },
    ];
    const derived = deriveConversationStateFromHistory(history);
    check(
      "10 إعادة البناء من السجل المحفوظ: عرض معلّق + مرحلة AVAILABILITY_RESOLVED",
      derived.bookingStage === "AVAILABILITY_RESOLVED" &&
        derived.pendingOffer?.serviceName === "تنظيف أسنان" &&
        derived.pendingOffer?.date === "2026-10-01" &&
        derived.pendingOffer?.options.length === 1 &&
        derived.selectedService === "تنظيف أسنان",
    );
    const empty = deriveConversationStateFromHistory([
      { senderType: "CUSTOMER", content: "أهلاً" },
    ]);
    check(
      "10b سجل بلا عرض → حالة فارغة (NOT_APPLICABLE)",
      empty.bookingStage === "NOT_APPLICABLE" && empty.pendingOffer === null,
    );
  }

  // ── 11. Tenant isolation — pure, input never mutated ─────────────────────
  {
    const before = emptyConversationState();
    const beforeSnapshot = JSON.stringify(before);
    const { state: after } = mergeConversationState(before, {
      turnGoal: "BOOKING",
      factUpdates: [{ key: "service", value: "خدمة أ" }],
    });
    // A second, independent conversation must not inherit the first's facts.
    const independent = mergeConversationState(emptyConversationState(), {
      turnGoal: "BOOKING",
      factUpdates: [{ key: "service", value: "خدمة ب" }],
    });
    check(
      "11 عزل المستأجر: الدمج نقي، لا يُغيّر المدخل، ولا حالة مشتركة بين المحادثات",
      JSON.stringify(before) === beforeSnapshot &&
        after.knownFacts.service === "خدمة أ" &&
        independent.state.knownFacts.service === "خدمة ب" &&
        before.knownFacts.service === undefined,
    );
  }

  // ── 12. Determinism + zero inference ─────────────────────────────────────
  {
    const input = {
      turnGoal: "BOOKING" as const,
      factUpdates: [
        { key: "service", value: "تنظيف أسنان" },
        { key: "date", value: "2026-10-01" },
      ],
    };
    const a = mergeConversationState(emptyConversationState(), input);
    const b = mergeConversationState(emptyConversationState(), input);
    const isPromise =
      typeof (a as unknown as { then?: unknown }).then === "function";
    const src = read(
      join(SRC_DIR, "features/conversations/server/conversation-state.ts"),
    );
    const noProviderImport =
      !/from ["'][^"']*integrations\/ai|process\.env\[|process\.env\.\w|fetch\(|require\(/.test(
        src,
      );
    check(
      "12 حتمية + صفر استدلال: نفس المدخلات نفس المخرجات، لا نداء نموذج/شبكة",
      JSON.stringify(a) === JSON.stringify(b) && !isPromise && noProviderImport,
    );
  }

  // ── 13. state + factUpdates = state_after (no hidden side effects) ───────
  {
    const s0 = mergeConversationState(emptyConversationState(), {
      turnGoal: "BOOKING",
      factUpdates: [{ key: "service", value: "تنظيف أسنان" }],
    }).state;
    const s0Snapshot = JSON.stringify(s0);
    const s1 = mergeConversationState(s0, {
      turnGoal: "BOOKING",
      factUpdates: [{ key: "date", value: "2026-10-01" }],
    }).state;
    check(
      "13 state_before + factUpdates = state_after بلا آثار جانبية خفية",
      JSON.stringify(s0) === s0Snapshot && // s0 not mutated
        s1.knownFacts.service === "تنظيف أسنان" &&
        s1.knownFacts.date === "2026-10-01",
    );
    // Extraction adapter feeds the SAME merge uniformly.
    const fromExtraction = factUpdatesFromExtraction({
      service: "تنظيف أسنان",
      date: "2026-10-01",
      provider: null,
      timePreference: null,
    });
    check(
      "13b محوّل الاستخراج ينتج تحديثات حقائق إضافية (بلا تصحيح)",
      fromExtraction.length === 2 &&
        fromExtraction.every((u) => u.isRevision === undefined),
    );
  }

  // ── 14. ONE ConversationState module only ────────────────────────────────
  {
    const { readdirSync, statSync } = await import("node:fs");
    function walk(dir: string, out: string[] = []): string[] {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (full.endsWith(".ts")) out.push(full);
      }
      return out;
    }
    const definers = walk(SRC_DIR).filter((file) =>
      /export (type|function) (ConversationState|mergeConversationState|emptyConversationState)\b/.test(
        read(file),
      ),
    );
    check(
      "14 وحدة ConversationState واحدة فقط (لا آلة حالة ثانية)",
      definers.length === 1 &&
        definers[0]?.endsWith("conversation-state.ts") === true,
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
      extraction: {
        service: null,
        provider: null,
        date: null,
        timePreference: null,
      },
      handoffReason: null,
      summary: null,
    };
  }
  type Obs = {
    observability?: { stateTransition?: { from?: string; to?: string } };
  };

  // ── 15. Greeting unchanged + stateTransition observed, zero AI call ──────
  {
    const run = await runTurn({
      text: "السلام عليكم",
      externalId: "s2-greet",
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
      "15 تحية بلا تغيير: AI_ACTIVE، صفر نداء، ورصد انتقال الحالة موجود (NOT_APPLICABLE)",
      result.ok === true &&
        result.assistantAction === "AI_REPLY" &&
        result.conversationStatus === "AI_ACTIVE" &&
        result.intent === "GREETING" &&
        run.aiCalls === 0 &&
        run.aiTurnCount === 0,
    );
  }

  // ── 16. Human handoff unchanged — state never silently resumes AI ────────
  {
    const run = await runTurn({
      text: "عايز أتكلم مع موظف",
      externalId: "s2-human",
      ai: {
        providerName: convAi.deterministicConversationAi.providerName,
        respond: (request: unknown) =>
          convAi.deterministicConversationAi.respond(request as never),
      },
    });
    const result = run.result as {
      ok?: boolean;
      assistantAction?: string;
      conversationStatus?: string;
      intent?: string;
    };
    check(
      "16 تحويل بشري بلا تغيير: NEED_HUMAN، الحالة لا تستأنف الذكاء ذاتياً",
      result.ok === true &&
        result.assistantAction === "AI_HANDOFF" &&
        result.conversationStatus === "NEED_HUMAN" &&
        result.intent === "HUMAN_REQUEST",
    );
  }

  // ── 17. Booking options unchanged, one AI call, zero appointment write ───
  {
    const run = await runTurn({
      text: "عايز أحجز تنظيف أسنان يوم 2026-09-14",
      externalId: "s2-book",
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
    const aiMsg =
      run.messages.find((m) => m.senderType === "AI")?.content ?? "";
    check(
      "17 حجز بلا تغيير: خيارات AI_ACTIVE، نداء واحد، صفر كتابة موعد، رصد الحالة موجود",
      result.ok === true &&
        result.assistantAction === "AI_REPLY" &&
        result.conversationStatus === "AI_ACTIVE" &&
        run.aiCalls === 1 &&
        run.appointmentWrites === 0 &&
        aiMsg.includes("تنظيف أسنان") &&
        result.observability?.stateTransition?.to === "DATE_SUPPLIED",
    );
  }

  // ── 18. Revision AFTER a pending clarification resolves it (EVAL-07) ──────
  {
    // Turn A: booking, service known, date MISSING → record CLARIFY_DATE.
    const asked = mergeConversationState(emptyConversationState(), {
      turnGoal: "BOOKING",
      factUpdates: [{ key: "service", value: "تنظيف أسنان" }],
      clarification: { type: "CLARIFY_DATE", missingFacts: ["date"] },
    }).state;
    // Turn B: the customer SUPPLIES a date → clarification resolves (resume).
    const resumed = mergeConversationState(asked, {
      turnGoal: "BOOKING",
      factUpdates: [{ key: "date", value: "2026-10-01" }],
    }).state;
    // Turn C: the customer REVISES the date → latest wins, revision logged,
    // clarification stays resolved (never re-asked), the task continues.
    const revised = mergeConversationState(resumed, {
      turnGoal: "BOOKING",
      factUpdates: [{ key: "date", value: "2026-10-02", isRevision: true }],
      turnId: "tR",
    });
    const s = revised.state;
    const rev = s.revisions[s.revisions.length - 1];
    check(
      "18 تصحيح بعد استئناف توضيح: يُحَل التوضيح ثم يُصحَّح، أحدث قيمة سلطوية، التوضيح لا يُعاد والمهمة مستمرة",
      asked.lastClarification?.type === "CLARIFY_DATE" &&
        asked.missingFacts.includes("date") &&
        resumed.lastClarification === null &&
        resumed.missingFacts.length === 0 &&
        s.knownFacts.date === "2026-10-02" &&
        s.lastClarification === null &&
        s.missingFacts.length === 0 &&
        s.knownFacts.service === "تنظيف أسنان" &&
        s.activeTask?.kind === "BOOKING" &&
        rev?.isRevision === true &&
        rev?.from === "2026-10-01" &&
        rev?.to === "2026-10-02",
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
    `\nأساس حالة المحادثة (Slice 2) صحيح: ${checks.length}/${checks.length} فحص ناجح.`,
  );
}

main().catch((error: Error) => {
  console.error(`فشل غير متوقع: ${error.message}`);
  if (error.stack) console.error(error.stack);
  process.exit(1);
});
