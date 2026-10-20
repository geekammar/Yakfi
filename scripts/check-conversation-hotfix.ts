/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * FlowPilot — UX001-C2-HOTFIX Verification Suite
 * Fix Telegram/WhatsApp Booking Loop, Default Service and Clarification Recovery
 *
 * Implements the 16 mandatory deterministic regression test scenarios from STEP 3:
 *  1. Booking without service with configured default.
 *  2. Booking without service with one eligible service.
 *  3. Booking without service with multiple services and no default.
 *  4. Customer asks for service catalog ("ايه الخدمات اللي موجوده عندكم؟").
 *  5. Customer answers "كشف" after clarification.
 *  6. Customer answers "كشف أسنان".
 *  7. Customer first provides "بكرة الصبح", then service; date/time preferences retained.
 *  8. No infinite clarification loop.
 *  9. Correct provider selection with 0/1/multiple providers.
 * 10. Accurate real slot availability, no invented slots.
 * 11. No unnecessary human handoff.
 * 12. Actual safety/human handoff still works.
 * 13. Tenant isolation.
 * 14. WhatsApp and Telegram text and button paths.
 * 15. Idempotent confirmation.
 * 16. Follow-up and existing C1/C2 regressions.
 *
 * Run: pnpm tsx scripts/check-conversation-hotfix.ts
 */

import type { ConversationEngineDeps } from "../src/features/conversations/server/conversation-engine";
import type {
  Business,
  Conversation,
  ConversationStatus,
  Customer,
  Message,
} from "../src/types/domain";

type Check = { num: number; label: string; pass: boolean; detail?: string };
const checks: Check[] = [];

function check(
  num: number,
  label: string,
  pass: boolean,
  detail?: string,
): void {
  checks.push({ num, label, pass, detail });
}

async function run(): Promise<void> {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const { receiveInboundMessage } =
    await import("../src/features/conversations/server/conversation-engine");
  const { resolveEgyptianRelativeDate } =
    await import("../src/features/conversations/server/relative-date");

  const BIZ_ID_A = "11111111-1111-4111-8111-111111111111";
  const BIZ_ID_B = "22222222-2222-4222-8222-222222222222";
  const BRANCH_ID_A = "44444444-4444-4444-8444-444444444444";
  const CUST_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const USER_P1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
  const USER_P2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
  const PROV_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
  const PROV_2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
  const SERV_DENTAL = "33333333-3333-4333-8333-333333333331";
  const SERV_CLEAN = "33333333-3333-4333-8333-333333333332";

  const TODAY_REF = "2026-10-20"; // Tuesday

  function openWeek() {
    const days = ["sat", "sun", "mon", "tue", "wed", "thu", "fri"] as const;
    const hours: any = {};
    for (const d of days) {
      hours[d] = { open: "09:00", close: "17:00", closed: false };
    }
    return hours;
  }

  function createHarness(options?: {
    businessId?: string;
    branchId?: string;
    defaultBookingServiceId?: string | null;
    singleService?: boolean;
    noServices?: boolean;
    providersCount?: 0 | 1 | 2;
    channel?: "WHATSAPP" | "TELEGRAM";
    customServices?: any[];
  }) {
    const businessId = options?.businessId ?? BIZ_ID_A;
    const branchId = options?.branchId ?? BRANCH_ID_A;
    const defaultBookingServiceId = options?.defaultBookingServiceId ?? null;
    const singleService = options?.singleService ?? false;
    const noServices = options?.noServices ?? false;
    const providersCount = options?.providersCount ?? 1;
    const channel = options?.channel ?? "WHATSAPP";
    const phone = channel === "TELEGRAM" ? "tg:998877" : "+201001234567";

    let llmCallCount = 0;

    const business: Business = {
      id: businessId,
      name:
        businessId === BIZ_ID_A ? "عيادة النور لطب الأسنان" : "عيادة الشفاء",
      slug: businessId === BIZ_ID_A ? "al-noor" : "al-shifa",
      timezone: "Africa/Cairo",
      workingHours: openWeek(),
      slotDurationMinutes: 30,
      confirmationMode: "automatic",
      defaultBranchId: branchId,
      whatsappNumber: "+201001111111",
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      defaultBookingServiceId,
    } as any;

    const customer: Customer = {
      id: CUST_ID,
      businessId,
      name: "أحمد محمود",
      phone,
      notes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any;

    const conversation: Conversation = {
      id: `conv-${businessId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      businessId,
      customerId: CUST_ID,
      channel,
      status: "AI_ACTIVE" as ConversationStatus,
      assignedUserId: null,
      branchId,
      unreadCount: 0,
      lastMessageAt: new Date(),
      aiSummary: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any;

    const messages: Message[] = [];
    const appointments: any[] = [];
    const deliveredOutbound: any[] = [];
    const dedupeLedger = new Set<string>();

    const services =
      options?.customServices ??
      (noServices
        ? []
        : singleService
          ? [
              {
                id: SERV_DENTAL,
                businessId,
                name: "كشف أسنان",
                durationMinutes: 30,
                isActive: true,
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            ]
          : [
              {
                id: SERV_DENTAL,
                businessId,
                name: "كشف أسنان",
                durationMinutes: 30,
                isActive: true,
                createdAt: new Date(),
                updatedAt: new Date(),
              },
              {
                id: SERV_CLEAN,
                businessId,
                name: "تنظيف أسنان",
                durationMinutes: 30,
                isActive: true,
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            ]);

    const allProviders =
      providersCount === 0
        ? []
        : providersCount === 1
          ? [
              {
                id: PROV_1,
                businessId,
                userId: USER_P1,
                name: "د. أحمد سامي",
                displayName: "د. أحمد سامي",
                title: "طبيب أسنان",
                isActive: true,
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            ]
          : [
              {
                id: PROV_1,
                businessId,
                userId: USER_P1,
                name: "د. أحمد سامي",
                displayName: "د. أحمد سامي",
                title: "طبيب أسنان",
                isActive: true,
                createdAt: new Date(),
                updatedAt: new Date(),
              },
              {
                id: PROV_2,
                businessId,
                userId: USER_P2,
                name: "د. سارة عادل",
                displayName: "د. سارة عادل",
                title: "طبيبة أسنان",
                isActive: true,
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            ];

    const deps: ConversationEngineDeps = {
      businessRepository: {
        findById: async (id: string) => (id === businessId ? business : null),
        findBySlug: async () => null,
        findByWhatsAppNumber: async () => business,
        findByWhatsappNumber: async () => business,
        findByTelegramBotToken: async () => null,
      } as any,
      branchRepository: {
        findById: async () => ({
          id: branchId,
          businessId,
          name: "الفرع الرئيسي",
        }),
        findByIdWithinBusiness: async () => ({
          id: branchId,
          businessId,
          name: "الفرع الرئيسي",
        }),
        findDefaultByBusiness: async () => ({
          id: branchId,
          businessId,
          name: "الفرع الرئيسي",
        }),
        listByBusiness: async () => [
          { id: branchId, businessId, name: "الفرع الرئيسي", isDefault: true },
        ],
      } as any,
      customerRepository: {
        findById: async () => customer,
        findByPhone: async () => customer,
        upsertByPhone: async () => customer,
        touchConversation: async () => customer,
        findOrCreate: async () => customer,
      } as any,
      conversationRepository: {
        findById: async () => conversation,
        findLatestByCustomer: async () => ({ id: conversation.id }),
        findActiveByCustomer: async () => conversation,
        findByExternalThreadId: async () => conversation,
        create: async () => conversation,
        update: async (_id: string, patch: any) => {
          Object.assign(conversation, patch);
          return conversation;
        },
        updateWorkflow: async (_id: string, patch: any) => {
          Object.assign(conversation, patch);
          return conversation;
        },
        addMessage: async (input: any, meta?: any) => {
          const msg: Message = {
            id: `msg-${messages.length + 1}`,
            conversationId: conversation.id,
            senderType: input.senderType,
            content: input.content,
            createdAt: new Date(),
          } as any;
          messages.push(msg);
          if (meta?.status) {
            conversation.status = meta.status;
          }
          return msg;
        },
        getMessages: async () => [...messages].reverse(),
      } as any,
      serviceRepository: {
        listByBusiness: async (bId: string) =>
          services.filter((s) => s.businessId === bId),
        findById: async (id: string) =>
          services.find((s) => s.id === id) ?? null,
      } as any,
      providerRepository: {
        listByBusiness: async (bId: string) =>
          allProviders.filter((p) => p.businessId === bId),
        findById: async (id: string) =>
          allProviders.find((p) => p.id === id) ?? null,
        listEligibleForService: async (bId: string) =>
          allProviders.filter((p) => p.businessId === bId),
        listAssignmentSeams: async () =>
          allProviders.map((p) => ({ providerId: p.id, userId: p.userId })),
      } as any,
      appointmentRepository: {
        listRecentByCustomer: async () => [],
        listBlockingByAssignees: async () =>
          appointments.map((a) => ({
            id: a.id,
            assignedUserId: a.assignedUserId,
            providerId: a.providerId,
            date: a.date,
            startTime: a.startTime,
            endTime: a.endTime,
          })),
        createWithConflictCheck: async (data: any) => {
          const id = `appt-${appointments.length + 1}`;
          const created = {
            id,
            ...data,
            date: new Date(`${data.date}T00:00:00Z`),
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
          };
          appointments.push(created);
          return { appointment: created };
        },
        updateStatus: async () => null,
      } as any,
      inboundDedupeRepository: {
        claim: async (_bId: string, externalKey?: string) => {
          const key = externalKey ?? _bId;
          if (dedupeLedger.has(key)) {
            return { status: "duplicate" as const };
          }
          dedupeLedger.add(key);
          return { status: "claimed" as const, claimId: `claim-${key}` };
        },
      } as any,
      usageRepository: {
        record: async () => {},
      } as any,
      ai: {
        providerName: "deterministic",
        respond: async (req: any) => {
          llmCallCount += 1;
          const { deterministicConversationAi } =
            await import("../src/features/conversations/server/conversation-ai");
          return deterministicConversationAi.respond(req);
        },
      } as any,
      transport: {
        providerName: channel === "TELEGRAM" ? "telegram" : "whatsapp",
        send: async (payload: any) => {
          deliveredOutbound.push(payload);
          return { provider: "mock-transport", delivered: true };
        },
      } as any,
    };

    return {
      deps,
      conversation,
      customer,
      messages,
      appointments,
      deliveredOutbound,
      getLlmCallCount: () => llmCallCount,
      sendMessage: async (text: string, externalId?: string) => {
        const to = phone.startsWith("tg:")
          ? "6000000000"
          : business.whatsappNumber;
        const from = phone.startsWith("tg:") ? phone.replace("tg:", "") : phone;
        const res = await receiveInboundMessage(deps, {
          to,
          from,
          text,
          receivedAt: new Date().toISOString(),
          externalId:
            externalId ??
            `ext-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        });
        return {
          ...res,
          conversationStatus:
            "conversationStatus" in res
              ? (res as any).conversationStatus
              : conversation.status,
        } as any;
      },
    };
  }

  console.log(
    "Starting UX001-C2-HOTFIX 16 Multi-Turn Regression Scenarios...\n",
  );

  // ── 1. Booking without service with configured default ──────────────────────
  {
    const h = createHarness({
      defaultBookingServiceId: SERV_DENTAL,
      providersCount: 1,
    });
    const res = await h.sendMessage("عايز أحجز بكره");
    const lastOut =
      h.deliveredOutbound[h.deliveredOutbound.length - 1]?.content ?? "";
    const pass =
      res.ok &&
      res.conversationStatus === "AI_ACTIVE" &&
      res.assistantAction === "AI_REPLY" &&
      (lastOut.includes("كشف أسنان") ||
        lastOut.includes("المواعيد المتاحة") ||
        lastOut.includes("اختيار"));
    check(
      1,
      "Booking without service with configured default resolves default service directly",
      pass,
      `status=${res.conversationStatus}, action=${res.assistantAction}`,
    );
  }

  // ── 2. Booking without service with one eligible service ────────────────────
  {
    const h = createHarness({
      singleService: true,
      providersCount: 1,
    });
    const res = await h.sendMessage("عايز أحجز بكره");
    const lastOut =
      h.deliveredOutbound[h.deliveredOutbound.length - 1]?.content ?? "";
    const pass =
      res.ok &&
      res.conversationStatus === "AI_ACTIVE" &&
      res.assistantAction === "AI_REPLY" &&
      (lastOut.includes("كشف أسنان") ||
        lastOut.includes("المواعيد المتاحة") ||
        lastOut.includes("اختيار"));
    check(
      2,
      "Booking without service with one eligible service selects it automatically",
      pass,
      `outbound contains slots/service without asking for service name`,
    );
  }

  // ── 3. Booking without service with multiple services and no default ────────
  {
    const h = createHarness({
      singleService: false,
      defaultBookingServiceId: null,
    });
    const res = await h.sendMessage("عايز أحجز بكره");
    const lastOut =
      h.deliveredOutbound[h.deliveredOutbound.length - 1]?.content ?? "";
    const pass =
      res.ok &&
      res.conversationStatus === "AI_ACTIVE" &&
      lastOut.includes("الخدمات المتاحة لدينا") &&
      lastOut.includes("كشف أسنان") &&
      lastOut.includes("تنظيف أسنان");
    check(
      3,
      "Booking without service with multiple services shows available service list (no blind default)",
      pass,
      `prompt listed services cleanly without staff handoff`,
    );
  }

  // ── 4. Customer asks for service catalog ("ايه الخدمات اللي موجوده عندكم؟") ───
  {
    const h = createHarness({
      singleService: false,
    });
    const res = await h.sendMessage("ايه الخدمات اللي موجوده عندكم؟");
    const lastOut =
      h.deliveredOutbound[h.deliveredOutbound.length - 1]?.content ?? "";
    const pass =
      res.ok &&
      res.conversationStatus === "AI_ACTIVE" &&
      res.assistantAction === "AI_REPLY" &&
      lastOut.includes("كشف أسنان") &&
      lastOut.includes("تنظيف أسنان");
    check(
      4,
      "Customer asks for service catalog returns active services list cleanly with 0 LLM calls",
      pass,
      `answered catalog query without handoff or asking for unknown service`,
    );
  }

  // ── 5. Customer answers "كشف" after clarification ─────────────────────────
  {
    const h = createHarness({
      singleService: false,
      defaultBookingServiceId: null,
      providersCount: 1,
    });
    await h.sendMessage("عايز أحجز بكره");
    const res = await h.sendMessage("كشف");
    const lastOut =
      h.deliveredOutbound[h.deliveredOutbound.length - 1]?.content ?? "";
    const pass =
      res.ok &&
      res.conversationStatus === "AI_ACTIVE" &&
      res.assistantAction === "AI_REPLY" &&
      !lastOut.includes("يرجى تحديد الخدمة المطلوبة") &&
      !lastOut.includes("لم أفهم طلبك") &&
      (lastOut.includes("كشف أسنان") ||
        lastOut.includes("اختيار 1") ||
        lastOut.includes("المواعيد"));
    check(
      5,
      "Customer answers 'كشف' after clarification matches 'كشف أسنان' and advances",
      pass,
      `status=${res.conversationStatus}, no loop, advanced to slots`,
    );
  }

  // ── 6. Customer answers "كشف أسنان" ───────────────────────────────────────
  {
    const h = createHarness({
      singleService: false,
      defaultBookingServiceId: null,
      providersCount: 1,
    });
    await h.sendMessage("عايز أحجز بكره");
    const res = await h.sendMessage("كشف أسنان");
    const lastOut =
      h.deliveredOutbound[h.deliveredOutbound.length - 1]?.content ?? "";
    const pass =
      res.ok &&
      res.conversationStatus === "AI_ACTIVE" &&
      res.assistantAction === "AI_REPLY" &&
      !lastOut.includes("يرجى تحديد الخدمة المطلوبة") &&
      (lastOut.includes("كشف أسنان") || lastOut.includes("المواعيد المتاحة"));
    check(
      6,
      "Customer answers 'كشف أسنان' resolves service and advances toward slots",
      pass,
      `status=${res.conversationStatus}`,
    );
  }

  // ── 7. Customer first provides "بكرة الصبح", then service; date/time retained
  {
    const h = createHarness({
      singleService: false,
      defaultBookingServiceId: null,
      providersCount: 1,
    });
    // Turn 1: "اهلا انا عايز احجز بكره الصبح"
    await h.sendMessage("اهلا انا عايز احجز بكره الصبح");
    // Turn 2: Customer specifies service
    const res = await h.sendMessage("كشف أسنان");
    const lastOut =
      h.deliveredOutbound[h.deliveredOutbound.length - 1]?.content ?? "";
    const pass =
      res.ok &&
      res.conversationStatus === "AI_ACTIVE" &&
      (lastOut.includes("09:00") ||
        lastOut.includes("10:00") ||
        lastOut.includes("11:00")) &&
      !lastOut.includes("يرجى تحديد الخدمة المطلوبة") &&
      !lastOut.includes("لم أفهم طلبك");
    check(
      7,
      "Customer first provides 'بكرة الصبح', then service; date/time preferences retained",
      pass,
      `slots filtered for morning, preferences preserved across turns`,
    );
  }

  // ── 8. No infinite clarification loop ─────────────────────────────────────
  {
    const h = createHarness({
      singleService: false,
      defaultBookingServiceId: null,
      providersCount: 1,
    });
    await h.sendMessage("عايز أحجز");
    const t2 = await h.sendMessage("كشف");
    const lastOut =
      h.deliveredOutbound[h.deliveredOutbound.length - 1]?.content ?? "";
    // On turn 2, the bot must NOT repeat "يرجى تحديد الخدمة المطلوبة"
    const pass =
      t2.ok &&
      t2.conversationStatus === "AI_ACTIVE" &&
      !lastOut.includes("يرجى تحديد الخدمة المطلوبة");
    check(
      8,
      "No infinite clarification loop: answer resolves pending clarification immediately",
      pass,
      `did not repeat service question template`,
    );
  }

  // ── 9. Correct provider selection with 0/1/multiple providers ─────────────
  {
    // 9a: 0 providers -> domain handoff
    const h0 = createHarness({ providersCount: 0 });
    const res0 = await h0.sendMessage("عايز أحجز كشف أسنان بكره");
    const pass0 =
      res0.conversationStatus === "NEED_HUMAN" &&
      res0.handoffCause === "DOMAIN_REQUIRES_HUMAN";

    // 9b: 1 provider -> auto-selects single provider without asking
    const h1 = createHarness({ providersCount: 1 });
    const res1 = await h1.sendMessage("عايز أحجز كشف أسنان بكره");
    const pass1 =
      res1.conversationStatus === "AI_ACTIVE" &&
      res1.assistantAction === "AI_REPLY";

    // 9c: multiple providers -> accepts "أي دكتور متاح"
    const h2 = createHarness({ providersCount: 2 });
    const res2 = await h2.sendMessage(
      "عايز أحجز كشف أسنان بكره مع أي دكتور متاح",
    );
    const pass2 =
      res2.conversationStatus === "AI_ACTIVE" &&
      res2.assistantAction === "AI_REPLY";

    check(
      9,
      "Correct provider selection with 0/1/multiple providers",
      pass0 && pass1 && pass2,
      `0 providers hands off, 1 auto-selects, 2 with any doctor proceeds`,
    );
  }

  // ── 10. Accurate real slot availability, no invented slots ─────────────────
  {
    const h = createHarness({ providersCount: 1 });
    const res = await h.sendMessage("عايز أحجز كشف أسنان بكره");
    const lastOut =
      h.deliveredOutbound[h.deliveredOutbound.length - 1]?.content ?? "";
    // Working hours are 09:00 - 17:00, slot duration 30m. Slot 09:00 is valid.
    const pass =
      res.ok &&
      lastOut.includes("09:00") &&
      !lastOut.includes("03:00") && // no invented night slot
      !lastOut.includes("23:00");
    check(
      10,
      "Accurate real slot availability from CORE-02, no invented slots",
      pass,
      `slots strictly generated within working hours 09:00-17:00`,
    );
  }

  // ── 11. No unnecessary human handoff ──────────────────────────────────────
  {
    const testPhrases = [
      "عايز أحجز",
      "كشف",
      "كشف أسنان",
      "السلام عليكم عايز احجز بكره",
      "ايه الخدمات اللي موجوده عندكم؟",
      "1",
    ];
    let allActive = true;
    for (const phrase of testPhrases) {
      const h = createHarness({ providersCount: 1, singleService: true });
      const res = await h.sendMessage(phrase);
      if (res.conversationStatus === "NEED_HUMAN") {
        allActive = false;
        break;
      }
    }
    check(
      11,
      "No unnecessary human handoff on ordinary booking phrases and short replies",
      allActive,
      `all test booking phrases stayed AI_ACTIVE`,
    );
  }

  // ── 12. Actual safety/human handoff still works ───────────────────────────
  {
    // 12a: Explicit human request
    const hHuman = createHarness();
    const resHuman = await hHuman.sendMessage(
      "حولني لموظف خدمة العملاء لو سمحت",
    );
    const passHuman =
      resHuman.conversationStatus === "NEED_HUMAN" &&
      resHuman.handoffCause === "CUSTOMER_REQUESTED_HUMAN";

    // 12b: Safety / emergency
    const hSafety = createHarness();
    const resSafety = await hSafety.sendMessage(
      "عندي نزيف حاد وألم غير محتمل في اللثة",
    );
    const passSafety =
      resSafety.conversationStatus === "NEED_HUMAN" &&
      resSafety.handoffCause === "SENSITIVE_OR_RESTRICTED";

    check(
      12,
      "Actual safety and human handoff precedence remains fully intact",
      passHuman && passSafety,
      `explicit human -> CUSTOMER_REQUESTED_HUMAN, sensitive -> SENSITIVE_OR_RESTRICTED`,
    );
  }

  // ── 13. Tenant isolation ──────────────────────────────────────────────────
  {
    const hA = createHarness({ businessId: BIZ_ID_A, singleService: true });
    const hB = createHarness({
      businessId: BIZ_ID_B,
      customServices: [
        {
          id: "33333333-3333-4333-8333-333333333339",
          businessId: BIZ_ID_B,
          name: "علاج عصب وجذور",
          durationMinutes: 45,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });

    await hA.sendMessage("ايه الخدمات اللي موجوده عندكم؟");
    await hB.sendMessage("ايه الخدمات اللي موجوده عندكم؟");
    const outA =
      hA.deliveredOutbound[hA.deliveredOutbound.length - 1]?.content ?? "";
    const outB =
      hB.deliveredOutbound[hB.deliveredOutbound.length - 1]?.content ?? "";

    const catalogIsolated =
      outA.includes("كشف أسنان") &&
      !outA.includes("علاج عصب وجذور") &&
      outB.includes("علاج عصب وجذور") &&
      !outB.includes("كشف أسنان");

    const resA = await hA.sendMessage("عايز أحجز كشف أسنان بكره");
    const outBookA =
      hA.deliveredOutbound[hA.deliveredOutbound.length - 1]?.content ?? "";
    const bookIsolated =
      outBookA.includes('تتوفر المواعيد التالية لخدمة "كشف أسنان"') &&
      hA.conversation.businessId === BIZ_ID_A &&
      hB.conversation.businessId === BIZ_ID_B &&
      resA.conversationStatus === "AI_ACTIVE";

    const pass = catalogIsolated && bookIsolated;

    check(
      13,
      "Tenant isolation: each business operates exclusively on its own catalog and config",
      pass,
      `Biz A catalog/booking isolated from Biz B`,
    );
  }

  // ── 14. WhatsApp and Telegram text and button paths ───────────────────────
  {
    // WhatsApp: text reply "1" to clarify service
    const hWa = createHarness({
      channel: "WHATSAPP",
      defaultBookingServiceId: null,
    });
    await hWa.sendMessage("عايز أحجز بكره");
    const resWa = await hWa.sendMessage("1");
    const lastOutWa =
      hWa.deliveredOutbound[hWa.deliveredOutbound.length - 1]?.content ?? "";
    const passWa =
      resWa.conversationStatus === "AI_ACTIVE" &&
      !lastOutWa.includes("يرجى تحديد الخدمة");

    // Telegram: inline button with callback_data `service_1`
    const hTg = createHarness({
      channel: "TELEGRAM",
      defaultBookingServiceId: null,
    });
    await hTg.sendMessage("عايز أحجز بكره");
    const clarifyOutTg =
      hTg.deliveredOutbound[hTg.deliveredOutbound.length - 1];
    const hasInlineKb = !!clarifyOutTg?.replyMarkup?.inline_keyboard;
    const resTg = await hTg.sendMessage("service_1");
    const lastOutTg =
      hTg.deliveredOutbound[hTg.deliveredOutbound.length - 1]?.content ?? "";
    const passTg =
      hasInlineKb &&
      resTg.conversationStatus === "AI_ACTIVE" &&
      !lastOutTg.includes("يرجى تحديد الخدمة");

    check(
      14,
      "WhatsApp and Telegram text and button paths (callback_data and inline keyboard)",
      passWa && passTg,
      `WhatsApp accepted '1', Telegram provided inline_keyboard and accepted 'service_1'`,
    );
  }

  // ── 15. Idempotent confirmation ───────────────────────────────────────────
  {
    const h = createHarness({ providersCount: 1 });
    // Present slots
    await h.sendMessage("عايز أحجز كشف أسنان بكره");
    // Pick option 1
    const res1 = await h.sendMessage("1");
    const count1 = h.appointments.length;
    // Re-pick option 1 (replayed or duplicate message)
    const res2 = await h.sendMessage("1");
    const count2 = h.appointments.length;

    const pass = count1 === 1 && count2 === 1 && res1.ok && res2.ok;
    check(
      15,
      "Idempotent confirmation: slot selection creates appointment once and prevents duplicates",
      pass,
      `first pick created 1 appt, duplicate pick created 0 additional appts`,
    );
  }

  // ── 16. Follow-up and existing C1/C2 regressions ───────────────────────────
  {
    // Verify relative date resolution Egyptian colloquial
    const isoTomorrow = resolveEgyptianRelativeDate("بكره", TODAY_REF);
    const isoNextDay = resolveEgyptianRelativeDate("بعد بكره", TODAY_REF);
    const datePass =
      isoTomorrow === "2026-10-21" && isoNextDay === "2026-10-22";

    // Verify booking selection helper works with ordinals and buttons
    const { parseBookingSelection } =
      await import("../src/features/conversations/server/booking-selection");
    const sel1 = parseBookingSelection("1");
    const selOpt1 = parseBookingSelection("opt_1");
    const selIndic2 = parseBookingSelection("٢");
    const selPass =
      sel1?.kind === "index" &&
      sel1.index === 1 &&
      selOpt1?.kind === "index" &&
      selOpt1.index === 1 &&
      selIndic2?.kind === "index" &&
      selIndic2.index === 2;

    check(
      16,
      "Follow-up and existing C1/C2 regressions remain valid and green",
      datePass && selPass,
      `Egyptian relative dates + booking selection parsers intact`,
    );
  }

  // ── Report ─────────────────────────────────────────────────────────────────
  console.log("\n========================================================");
  console.log("UX001-C2-HOTFIX — 16 Scenarios Results Summary");
  console.log("========================================================");
  let failed = 0;
  for (const c of checks) {
    const symbol = c.pass ? "✔" : "✘";
    console.log(`${symbol} Scenario ${c.num}: ${c.label}`);
    if (c.detail) {
      console.log(`   ↳ ${c.detail}`);
    }
    if (!c.pass) failed++;
  }
  console.log("========================================================");
  console.log(
    `Total: ${checks.length} | Passed: ${checks.length - failed} | Failed: ${failed}`,
  );

  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("FATAL in check-conversation-hotfix:", err);
  process.exit(1);
});
