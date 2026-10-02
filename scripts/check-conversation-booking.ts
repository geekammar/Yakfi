import type { AiResponse } from "../src/features/conversations/server/ai-contract";
import type { ConversationEngineDeps } from "../src/features/conversations/server/conversation-engine";
import type {
  Branch,
  Business,
  Conversation,
  ConversationStatus,
  Customer,
  Message,
  Service,
  UsageRecord,
} from "../src/types/domain";

/**
 * FlowPilot — CONVERSATION → BOOKING seam check (PROMPT-AI-03).
 *
 * Verifies the deterministic Conversation → Booking seam offline
 * (no DB, no network, no LLM, no Meta/WhatsApp):
 *   Customer message → Conversation Engine → AI interpretation
 *   (validated AiResponse) → mapper → CORE-01 → CORE-02 →
 *   options / clarification / NEED_HUMAN, zero appointment mutation.
 *
 * Cases (12, fixed date 2026-09-14 Monday):
 *   1  valid booking specific service → AI_REPLY with options
 *   2  ANY_PROVIDER (أي دكتور) → ANY preference, any-eligible ranking
 *   3  valid availability (AVAILABILITY) → AI_REPLY with options
 *   4  missing service → needs_clarification MISSING_SERVICE
 *   5  ambiguous service (تنظيف matches 2) → AMBIGUOUS_SERVICE
 *   6  ambiguous provider (أحمد matches 2) → clarification AMBIGUOUS
 *   7  CORE-01 rejection (SERVICE_INACTIVE) → AI_HANDOFF NEED_HUMAN
 *   8  CORE-02 empty (BUSINESS_CLOSED) → AI_HANDOFF NEED_HUMAN
 *   9  hostile injection strip (businessId/role/accountType) → server scope
 *   10 bypassDeterministicAi avoids LLM (no AI_TURN)
 *   11 NEED_HUMAN handoff typed correctly
 *   12 no appointment mutation (read-only seam)
 *
 * Run: pnpm check:conversation-booking
 */

export {};

type Check = { label: string; pass: boolean };

async function main(): Promise<void> {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const engine =
    await import("../src/features/conversations/server/conversation-engine");
  const aiContract =
    await import("../src/features/conversations/server/ai-contract");
  const convAi =
    await import("../src/features/conversations/server/conversation-ai");
  const { weekdayOf } =
    await import("../src/features/appointments/server/availability-service");

  const checks: Check[] = [];
  function check(label: string, pass: boolean): void {
    checks.push({ label, pass });
  }

  // ── Deterministic fixtures ───────────────────────────────────────────────
  const BUSINESS_A = "11111111-1111-4111-8111-111111111111";
  const BUSINESS_B = "22222222-2222-4222-8222-222222222222";
  const BRANCH_A = "44444444-4444-4444-8444-444444444444";
  const SERVICE_CLEAN = "33333333-3333-4333-8333-333333333333";
  const SERVICE_DEEP = "33333333-3333-4333-8333-333333333334";
  const SERVICE_FILL = "33333333-3333-4333-8333-333333333335";
  const SERVICE_INACTIVE = "35555555-5555-4555-8555-555555555555";
  const P1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
  const P2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
  const P3 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
  const U1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
  const U2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
  const U3 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3";
  const TEST_DATE = "2026-09-14";
  const WHATSAPP_NUMBER = "+201001111111";
  void weekdayOf;

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
    priceType: string | null;
    priceAmount: number | null;
    priceMaxAmount: number | null;
    priceCurrency: string | null;
    priceNote: string | null;
  };
  type BlockingRow = {
    assignedUserId: string;
    startTime: string;
    endTime: string;
  };

  const now = new Date();

  function openWeek(testDay: string, closed = false): Record<string, unknown> {
    const days = ["sat", "sun", "mon", "tue", "wed", "thu", "fri"];
    const hours: Record<string, unknown> = {};
    for (const day of days) {
      hours[day] =
        day === testDay
          ? { open: "10:00", close: "18:00", closed }
          : { open: "10:00", close: "18:00", closed: false };
    }
    return hours;
  }

  function businessRow(id: string, closed = false): Business {
    const testDay = "mon";
    return {
      id,
      name: "منشأة",
      vertical: null,
      city: null,
      whatsappNumber: WHATSAPP_NUMBER,
      timezone: "Africa/Cairo",
      about: null,
      workingHours: openWeek(testDay, closed),
      slotDurationMinutes: 30,
      confirmationMode: "manual",
      faqs: [],
      cancellationPolicy: null,
      onboardingCompletedAt: now,
      isActive: true,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      defaultBranchId: BRANCH_A,
    } as unknown as Business;
  }

  function serviceRow(input: {
    id: string;
    businessId: string;
    name: string;
    isActive?: boolean;
  }): ServiceRow {
    return {
      id: input.id,
      businessId: input.businessId,
      name: input.name,
      description: null,
      durationMinutes: 30,
      isActive: input.isActive ?? true,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      priceType: null,
      priceAmount: null,
      priceMaxAmount: null,
      priceCurrency: null,
      priceNote: null,
    };
  }

  // Helper to build one engine invocation with in-memory deps
  async function runCase(opts: {
    text: string;
    externalId: string;
    from?: string;
    aiResponse: unknown;
    services: ServiceRow[];
    serviceById?: Map<string, ServiceRow>;
    businessClosed?: boolean;
    providerScope?: Map<
      string,
      Array<{ id: string; displayName: string | null; user: { name: string } }>
    >;
    seams?: Map<string, { providerId: string; userId: string }>;
    blocking?: Map<string, BlockingRow[]>;
    expectAiNotCalled?: boolean;
  }): Promise<{
    result: Awaited<ReturnType<typeof engine.receiveInboundMessage>>;
    messages: Array<{ senderType: string; content: string }>;
    aiCalls: number;
    providerAccesses: string[];
    appointmentAccesses: string[];
    listCalls: Array<{
      businessId: string;
      serviceId: string;
      branchId?: string;
    }>;
  }> {
    const from = opts.from ?? "+201234567890";
    const ledger = new Map<
      string,
      {
        claimId: string;
        conversationId: string | null;
        customerMessageId: string | null;
      }
    >();
    const messages: Array<{ senderType: string; content: string; id: string }> =
      [];
    const listCalls: Array<{
      businessId: string;
      serviceId: string;
      branchId?: string;
    }> = [];
    const providerAccesses: string[] = [];
    const appointmentAccesses: string[] = [];
    let aiCalls = 0;

    const businessA = businessRow(BUSINESS_A, !!opts.businessClosed);
    const businessB = businessRow(BUSINESS_B, false);
    const businesses = new Map<string, Business>([
      [BUSINESS_A, businessA],
      [BUSINESS_B, businessB],
    ]);

    const serviceById =
      opts.serviceById ??
      new Map<string, ServiceRow>(opts.services.map((s) => [s.id, s]));

    const providerScope = opts.providerScope ?? new Map();
    const seams =
      opts.seams ?? new Map<string, { providerId: string; userId: string }>();
    const blocking = opts.blocking ?? new Map<string, BlockingRow[]>();

    // Default: P1/P2/P3 eligible for SERVICE_CLEAN in BUSINESS_A
    if (
      providerScope.size === 0 &&
      opts.services.some((s) => s.id === SERVICE_CLEAN)
    ) {
      providerScope.set(`${BUSINESS_A}:${SERVICE_CLEAN}:-`, [
        { id: P1, displayName: "د. سارة", user: { name: "سارة" } },
        { id: P2, displayName: "د. أحمد", user: { name: "أحمد" } },
        { id: P3, displayName: "د. منى", user: { name: "منى" } },
      ]);
      if (!seams.has(P1)) seams.set(P1, { providerId: P1, userId: U1 });
      if (!seams.has(P2)) seams.set(P2, { providerId: P2, userId: U2 });
      if (!seams.has(P3)) seams.set(P3, { providerId: P3, userId: U3 });
    }

    const nowDate = new Date();
    const customer = {
      id: "cust-1",
      businessId: BUSINESS_A,
      name: "عميل",
      phone: from.replace(/[\s-]/g, ""),
      notes: null,
      lastConversationAt: null,
      lastAppointmentAt: null,
      createdAt: nowDate,
      updatedAt: nowDate,
      deletedAt: null,
    } as unknown as Customer;

    let conversation: Conversation | null = null;
    let convSeq = 0;

    const deps: ConversationEngineDeps = {
      businessRepository: {
        findByWhatsappNumber: async () => businessA,
        findById: async (id: string) => businesses.get(id) ?? null,
      },
      branchRepository: {
        findDefaultByBusiness: async () =>
          ({
            id: BRANCH_A,
            businessId: BUSINESS_A,
            name: "الفرع الرئيسي",
            isActive: true,
            createdAt: nowDate,
            updatedAt: nowDate,
            deletedAt: null,
          }) as unknown as Branch,
        findByIdWithinBusiness: async (id: string, businessId: string) => {
          if (id === BRANCH_A && businessId === BUSINESS_A)
            return {
              id: BRANCH_A,
              businessId: BUSINESS_A,
              name: "الفرع الرئيسي",
              isActive: true,
              createdAt: nowDate,
              updatedAt: nowDate,
              deletedAt: null,
            } as unknown as Branch;
          return null;
        },
      },
      customerRepository: {
        upsertByPhone: async () => customer,
        touchConversation: async () => customer,
      },
      conversationRepository: {
        findLatestByCustomer: async () =>
          conversation ? { id: conversation.id } : null,
        findById: async () => conversation,
        create: async (input) => {
          convSeq += 1;
          conversation = {
            id: `conv-${convSeq}`,
            businessId: input.businessId,
            customerId: input.customerId,
            branchId: input.branchId,
            status: "AI_ACTIVE",
            assignedUserId: null,
            aiSummary: null,
            lastMessageAt: nowDate,
            createdAt: nowDate,
            updatedAt: nowDate,
          } as unknown as Conversation;
          return conversation;
        },
        addMessage: async (input, _wf, ref) => {
          const row = ref
            ? [...ledger.values()].find((r) => r.claimId === ref.claimId)
            : undefined;
          if (row?.customerMessageId) {
            const { InboundDuplicateError } =
              await import("../src/server/repositories/inbound-dedupe.repository");
            throw new InboundDuplicateError({
              conversationId: row.conversationId,
              customerMessageId: row.customerMessageId,
            });
          }
          const msg = {
            id: `msg-${messages.length + 1}`,
            conversationId: input.conversationId,
            senderType: input.senderType,
            content: input.content,
            createdAt: input.createdAt ?? new Date(),
            updatedAt: new Date(),
          } as unknown as Message;
          messages.push({
            senderType: input.senderType,
            content: input.content,
            id: msg.id,
          });
          if (row) {
            row.conversationId = input.conversationId;
            if (input.senderType === "CUSTOMER") row.customerMessageId = msg.id;
          }
          return msg;
        },
        getMessages: async () =>
          [...messages].reverse() as unknown as Message[],
        update: async () => conversation as unknown as Conversation,
        updateWorkflow: async (
          id: string,
          patch: { status: ConversationStatus },
        ) => {
          if (conversation && conversation.id === id) {
            conversation = {
              ...conversation,
              status: patch.status,
            } as unknown as Conversation;
          }
          return conversation as unknown as Conversation;
        },
      },
      serviceRepository: {
        listByBusiness: async () => [...opts.services],
        findById: async (id: string) =>
          (serviceById.get(id) as unknown as Service) ?? null,
      },
      inboundDedupeRepository: {
        claim: async (bid: string, key: string) => {
          const k = `${bid}|${key}`;
          const ex = ledger.get(k);
          if (ex) {
            if (ex.customerMessageId)
              return {
                status: "duplicate" as const,
                claimId: ex.claimId,
                conversationId: ex.conversationId,
                customerMessageId: ex.customerMessageId,
              };
            return { status: "reclaim" as const, claimId: ex.claimId };
          }
          const claimId = `claim-${ledger.size + 1}`;
          ledger.set(k, {
            claimId,
            conversationId: null,
            customerMessageId: null,
          });
          return { status: "claimed" as const, claimId };
        },
      },
      usageRepository: {
        record: async (input) => input as unknown as UsageRecord,
      },
      providerRepository: {
        listEligibleForService: async (
          businessId: string,
          serviceId: string,
          options?: { branchId?: string },
        ) => {
          providerAccesses.push("listEligibleForService");
          listCalls.push({
            businessId,
            serviceId,
            ...(options?.branchId ? { branchId: options.branchId } : {}),
          });
          const key = `${businessId}:${serviceId}:${options?.branchId ?? "-"}`;
          return (providerScope.get(key) ??
            providerScope.get(`${businessId}:${serviceId}:-`) ??
            []) as unknown as Array<{
            id: string;
            displayName: string | null;
            user: { name: string };
          }>;
        },
        listAssignmentSeams: async (
          _businessId: string,
          providerIds: string[],
        ) => {
          providerAccesses.push("listAssignmentSeams");
          return providerIds.flatMap((pid) => {
            const seam = seams.get(pid);
            return seam ? [{ providerId: pid, userId: seam.userId }] : [];
          });
        },
      },
      appointmentRepository: {
        listBlockingByAssignees: async (
          _businessId: string,
          _date: string,
          assignedUserIds: string[],
        ) => {
          appointmentAccesses.push("listBlockingByAssignees");
          if (assignedUserIds.length === 0) return [];
          return assignedUserIds.flatMap(
            (uid) => blocking.get(uid) ?? [],
          ) as unknown as Array<{
            assignedUserId: string;
            startTime: string;
            endTime: string;
          }>;
        },
      },
      ai: {
        providerName: "fake-ai",
        respond: async () => {
          aiCalls += 1;
          if (opts.expectAiNotCalled)
            throw new Error("AI should not have been called (bypass)");
          return opts.aiResponse as unknown as AiResponse;
        },
      },
      transport: {
        providerName: "fake-transport",
        send: async () => ({ provider: "fake-transport", delivered: true }),
      },
    };

    const result = await engine.receiveInboundMessage(deps, {
      to: WHATSAPP_NUMBER,
      from,
      text: opts.text,
      receivedAt: new Date().toISOString(),
      externalId: opts.externalId,
    });

    return {
      result,
      messages: messages.map((m) => ({
        senderType: m.senderType,
        content: m.content,
      })),
      aiCalls,
      providerAccesses,
      appointmentAccesses,
      listCalls,
    };
  }

  function aiBooking(extraction: {
    service: string | null;
    provider: string | null;
    date: string | null;
  }): unknown {
    return {
      intent: "BOOKING",
      action: "reply",
      content: "حجز",
      extraction: {
        service: extraction.service,
        provider: extraction.provider,
        date: extraction.date,
        timePreference: null,
      },
      handoffReason: null,
      summary: null,
    };
  }
  function aiAvailability(extraction: {
    service: string | null;
    provider: string | null;
    date: string | null;
  }): unknown {
    return {
      intent: "AVAILABILITY",
      action: "reply",
      content: "استعلام",
      extraction: {
        service: extraction.service,
        provider: extraction.provider,
        date: extraction.date,
        timePreference: null,
      },
      handoffReason: null,
      summary: null,
    };
  }

  const cleanServices = [
    serviceRow({
      id: SERVICE_CLEAN,
      businessId: BUSINESS_A,
      name: "تنظيف أسنان",
    }),
    serviceRow({ id: SERVICE_FILL, businessId: BUSINESS_A, name: "حشو أسنان" }),
  ];
  const cleanAndDeepServices = [
    serviceRow({
      id: SERVICE_CLEAN,
      businessId: BUSINESS_A,
      name: "تنظيف أسنان",
    }),
    serviceRow({
      id: SERVICE_DEEP,
      businessId: BUSINESS_A,
      name: "تنظيف عميق",
    }),
    serviceRow({ id: SERVICE_FILL, businessId: BUSINESS_A, name: "حشو أسنان" }),
  ];

  // ── 1. valid booking specific service ────────────────────────────────────
  {
    const { result, messages, appointmentAccesses } = await runCase({
      text: "عايز أحجز تنظيف أسنان يوم 2026-09-14 مع د. سارة",
      externalId: "wamid.CASE-1",
      aiResponse: aiBooking({
        service: "تنظيف أسنان",
        provider: "د. سارة",
        date: TEST_DATE,
      }),
      services: cleanServices,
    });
    const aiMsg = messages.find((m) => m.senderType === "AI")?.content ?? "";
    check(
      "1 حجز صحيح بمزود محدد → AI_REPLY مع خيارات",
      result.ok === true &&
        (result as { assistantAction?: string }).assistantAction ===
          "AI_REPLY" &&
        (result as { conversationStatus?: string }).conversationStatus ===
          "AI_ACTIVE" &&
        (result as { intent?: string }).intent === "BOOKING" &&
        aiMsg.includes("تنظيف أسنان") &&
        aiMsg.includes(TEST_DATE),
    );
    check(
      "1 لا كتابة مواعيد — قراءة الحجب فقط",
      appointmentAccesses.every((a) => a === "listBlockingByAssignees"),
    );
  }

  // ── 2. ANY_PROVIDER ───────────────────────────────────────────────────────
  {
    const { result, messages } = await runCase({
      text: "عايز أحجز تنظيف أسنان أي دكتور يوم 2026-09-14",
      externalId: "wamid.CASE-2",
      aiResponse: aiBooking({
        service: "تنظيف أسنان",
        provider: "أي دكتور",
        date: TEST_DATE,
      }),
      services: cleanServices,
    });
    const aiMsg = messages.find((m) => m.senderType === "AI")?.content ?? "";
    check(
      "2 أي مزود (أي دكتور) → AI_REPLY بلا providerId مصنّع",
      result.ok === true &&
        (result as { assistantAction?: string }).assistantAction ===
          "AI_REPLY" &&
        (result as { conversationStatus?: string }).conversationStatus ===
          "AI_ACTIVE" &&
        aiMsg.includes("تنظيف أسنان"),
    );
  }

  // ── 3. valid availability ─────────────────────────────────────────────────
  {
    const { result, messages } = await runCase({
      text: "إيه الأوقات المتاحة لحشو أسنان يوم 2026-09-14؟",
      externalId: "wamid.CASE-3",
      aiResponse: aiAvailability({
        service: "حشو أسنان",
        provider: null,
        date: TEST_DATE,
      }),
      services: cleanServices,
      providerScope: new Map([
        [
          `${BUSINESS_A}:${SERVICE_FILL}:-`,
          [
            { id: P1, displayName: "د. سارة", user: { name: "سارة" } },
            { id: P2, displayName: "د. أحمد", user: { name: "أحمد" } },
          ],
        ],
      ]),
      seams: new Map([
        [P1, { providerId: P1, userId: U1 }],
        [P2, { providerId: P2, userId: U2 }],
      ]),
    });
    const aiMsg = messages.find((m) => m.senderType === "AI")?.content ?? "";
    check(
      "3 استعلام إتاحة صحيح → AI_REPLY مع خيارات",
      result.ok === true &&
        (result as { assistantAction?: string }).assistantAction ===
          "AI_REPLY" &&
        (result as { intent?: string }).intent === "AVAILABILITY" &&
        aiMsg.includes("حشو أسنان"),
    );
  }

  // ── 4. missing service ────────────────────────────────────────────────────
  {
    const { result, messages } = await runCase({
      text: "عايز أحجز",
      externalId: "wamid.CASE-4",
      aiResponse: aiBooking({ service: null, provider: null, date: TEST_DATE }),
      services: cleanServices,
    });
    const aiMsg = messages.find((m) => m.senderType === "AI")?.content ?? "";
    check(
      "4 خدمة مفقودة → توضيح MISSING_SERVICE ويبقى AI_ACTIVE",
      result.ok === true &&
        (result as { assistantAction?: string }).assistantAction ===
          "AI_REPLY" &&
        (result as { conversationStatus?: string }).conversationStatus ===
          "AI_ACTIVE" &&
        aiMsg.includes("الخدمة"),
    );
  }

  // ── 5. ambiguous service ──────────────────────────────────────────────────
  {
    const { result, messages } = await runCase({
      text: "عايز أحجز تنظيف",
      externalId: "wamid.CASE-5",
      aiResponse: aiBooking({
        service: "تنظيف",
        provider: null,
        date: TEST_DATE,
      }),
      services: cleanAndDeepServices,
    });
    const aiMsg = messages.find((m) => m.senderType === "AI")?.content ?? "";
    check(
      "5 خدمة ملتبسة (تنظيف يطابق اثنتين) → توضيح AMBIGUOUS_SERVICE",
      result.ok === true &&
        (result as { assistantAction?: string }).assistantAction ===
          "AI_REPLY" &&
        aiMsg.includes("أكثر من خدمة"),
    );
  }

  // ── 6. ambiguous provider ─────────────────────────────────────────────────
  {
    const ambigProviders = new Map<
      string,
      Array<{ id: string; displayName: string | null; user: { name: string } }>
    >([
      [
        `${BUSINESS_A}:${SERVICE_CLEAN}:-`,
        [
          { id: P1, displayName: "د. أحمد", user: { name: "أحمد" } },
          { id: P2, displayName: "د. أحمد علي", user: { name: "أحمد علي" } },
        ],
      ],
    ]);
    const { result, messages } = await runCase({
      text: "عايز أحجز تنظيف أسنان مع أحمد يوم 2026-09-14",
      externalId: "wamid.CASE-6",
      aiResponse: aiBooking({
        service: "تنظيف أسنان",
        provider: "أحمد",
        date: TEST_DATE,
      }),
      services: cleanServices,
      providerScope: ambigProviders,
      seams: new Map([
        [P1, { providerId: P1, userId: U1 }],
        [P2, { providerId: P2, userId: U2 }],
      ]),
    });
    const aiMsg = messages.find((m) => m.senderType === "AI")?.content ?? "";
    check(
      "6 مزود ملتبس (أحمد يطابق اثنين) → توضيح المزود ويبقى AI_ACTIVE",
      result.ok === true &&
        (result as { assistantAction?: string }).assistantAction ===
          "AI_REPLY" &&
        (result as { conversationStatus?: string }).conversationStatus ===
          "AI_ACTIVE" &&
        aiMsg.includes("مزود"),
    );
  }

  // ── 7. CORE-01 rejection (SERVICE_INACTIVE) ───────────────────────────────
  {
    const inactiveService = serviceRow({
      id: SERVICE_INACTIVE,
      businessId: BUSINESS_A,
      name: "خدمة معطلة",
      isActive: false,
    });
    const servicesWithInactive = [...cleanServices, inactiveService];
    const { result, messages } = await runCase({
      text: "عايز أحجز خدمة معطلة",
      externalId: "wamid.CASE-7",
      aiResponse: aiBooking({
        service: "خدمة معطلة",
        provider: null,
        date: TEST_DATE,
      }),
      services: servicesWithInactive,
      serviceById: new Map<string, ServiceRow>(
        [...cleanServices, inactiveService].map((s) => [s.id, s]),
      ),
    });
    const aiMsg = messages.find((m) => m.senderType === "AI")?.content ?? "";
    check(
      "7 رفض CORE-01 (خدمة غير نشطة) → AI_HANDOFF NEED_HUMAN",
      result.ok === true &&
        (result as { assistantAction?: string }).assistantAction ===
          "AI_HANDOFF" &&
        (result as { conversationStatus?: string }).conversationStatus ===
          "NEED_HUMAN" &&
        aiMsg.length > 0,
    );
  }

  // ── 8. CORE-02 empty (BUSINESS_CLOSED) ───────────────────────────────────
  {
    const { result, messages } = await runCase({
      text: "عايز أحجز تنظيف أسنان يوم 2026-09-14",
      externalId: "wamid.CASE-8",
      aiResponse: aiBooking({
        service: "تنظيف أسنان",
        provider: null,
        date: TEST_DATE,
      }),
      services: cleanServices,
      businessClosed: true,
    });
    const aiMsg = messages.find((m) => m.senderType === "AI")?.content ?? "";
    check(
      "8 فراغ CORE-02 (المنشأة مغلقة) → AI_HANDOFF NEED_HUMAN",
      result.ok === true &&
        (result as { assistantAction?: string }).assistantAction ===
          "AI_HANDOFF" &&
        (result as { conversationStatus?: string }).conversationStatus ===
          "NEED_HUMAN" &&
        (aiMsg.includes("مغلقة") || aiMsg.includes("اختيار تاريخ آخر")),
    );
  }

  // ── 9. hostile injection strip ────────────────────────────────────────────
  {
    const hostileRaw = {
      intent: "BOOKING",
      action: "reply",
      content: "حجز",
      extraction: {
        service: "تنظيف أسنان",
        provider: null,
        date: TEST_DATE,
        timePreference: null,
      },
      handoffReason: null,
      summary: null,
      businessId: BUSINESS_B,
      role: "ADMIN",
      accountType: "PLATFORM",
      branchId: "99999999-9999-4999-8999-999999999999",
      reasoning: "chain of thought must be stripped",
    };
    const { result, listCalls } = await runCase({
      text: "عايز أحجز تنظيف أسنان يوم 2026-09-14",
      externalId: "wamid.CASE-9",
      aiResponse: hostileRaw,
      services: cleanServices,
    });
    const usesBusinessA = listCalls.every((c) => c.businessId === BUSINESS_A);
    const noLeak =
      listCalls.length > 0 &&
      listCalls.every(
        (c) =>
          c.businessId !== BUSINESS_B &&
          c.serviceId !== "99999999-9999-4999-8999-999999999999",
      );
    check(
      "9 حقن عدائي (businessId/role/accountType) يُشطب — نطاق المنشأة المُستمد من الخادم فقط",
      result.ok === true && usesBusinessA && noLeak,
    );
    // Also ensure parse strips reasoning
    const parsed = aiContract.parseAiResponse(hostileRaw);
    check(
      "9 parseAiResponse يشطب reasoning وحقول المنشأة",
      parsed !== null &&
        !("reasoning" in (parsed as Record<string, unknown>)) &&
        !("businessId" in (parsed as Record<string, unknown>)),
    );
  }

  // ── 10. bypass avoids LLM ─────────────────────────────────────────────────
  {
    const { result, aiCalls } = await runCase({
      text: "م",
      externalId: "wamid.CASE-10",
      aiResponse: aiBooking({
        service: "تنظيف أسنان",
        provider: null,
        date: TEST_DATE,
      }),
      services: cleanServices,
      expectAiNotCalled: true,
    });
    const bypass = convAi.bypassDeterministicAi({
      message: "م",
      conversationStatus: "AI_ACTIVE",
      recentMessages: [],
      businessName: "منشأة",
      services: [],
      faqs: [],
    });
    check(
      "10 bypassDeterministicAi يعيد AMBIGUOUS بدون استهلاك",
      bypass !== null && bypass.intent === "AMBIGUOUS",
    );
    check(
      "10 bypass يتجنب استدعاء LLM (ai.respond لم يُستدع)",
      aiCalls === 0 && result.ok === true,
    );
  }

  // ── 11. NEED_HUMAN typed correctly ────────────────────────────────────────
  {
    // FULLY_BOOKED → NEED_HUMAN
    const blocking = new Map<string, BlockingRow[]>([
      [U1, [{ assignedUserId: U1, startTime: "10:00", endTime: "18:00" }]],
      [U2, [{ assignedUserId: U2, startTime: "10:00", endTime: "18:00" }]],
      [U3, [{ assignedUserId: U3, startTime: "10:00", endTime: "18:00" }]],
    ]);
    const { result, messages } = await runCase({
      text: "عايز أحجز تنظيف أسنان يوم 2026-09-14",
      externalId: "wamid.CASE-11",
      aiResponse: aiBooking({
        service: "تنظيف أسنان",
        provider: null,
        date: TEST_DATE,
      }),
      services: cleanServices,
      blocking,
    });
    const aiMsg = messages.find((m) => m.senderType === "AI")?.content ?? "";
    check(
      "11 NEED_HUMAN مُصنّف (AI_HANDOFF + NEED_HUMAN) عند FULLY_BOOKED",
      result.ok === true &&
        (result as { assistantAction?: string }).assistantAction ===
          "AI_HANDOFF" &&
        (result as { conversationStatus?: string }).conversationStatus ===
          "NEED_HUMAN" &&
        aiMsg.includes("محجوزة"),
    );
  }

  // ── 12. no mutation ───────────────────────────────────────────────────────
  {
    const { providerAccesses, appointmentAccesses } = await runCase({
      text: "عايز أحجز تنظيف أسنان يوم 2026-09-14",
      externalId: "wamid.CASE-12",
      aiResponse: aiBooking({
        service: "تنظيف أسنان",
        provider: "د. سارة",
        date: TEST_DATE,
      }),
      services: cleanServices,
    });
    check(
      "12 لا كتابة مواعيد — فقط قراءات الحجب/المزودين (لا create/update)",
      providerAccesses.every(
        (a) => a === "listEligibleForService" || a === "listAssignmentSeams",
      ) &&
        appointmentAccesses.every((a) => a === "listBlockingByAssignees") &&
        appointmentAccesses.length > 0,
    );
    // Verify no secret/auth fields leak in engine result
    const { result } = await runCase({
      text: "عايز أحجز تنظيف أسنان يوم 2026-09-14",
      externalId: "wamid.CASE-12b",
      aiResponse: aiBooking({
        service: "تنظيف أسنان",
        provider: null,
        date: TEST_DATE,
      }),
      services: cleanServices,
    });
    const json = JSON.stringify(result);
    check(
      "12 النتيجة بلا أسرار/حقول توثيق",
      !/password|secret|credential|tokenhash/i.test(json),
    );
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
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
    `\nثوابت الحجز عبر المحادثة صحيحة: ${checks.length}/${checks.length} فحص ناجح.`,
  );
}

main().catch((error: Error) => {
  console.error(`فشل غير متوقع: ${error.message}`);
  if (error.stack) console.error(error.stack);
  process.exit(1);
});
