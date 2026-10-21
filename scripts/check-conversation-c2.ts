/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * FlowPilot — UX001-C2 Verification Suite
 * Customer Chat Booking UX Polish — WhatsApp & Telegram
 *
 * Covers:
 * - Group A: Customer intent & Egyptian expressions ("عايز أحجز بكرة", "الأسبوع الجاي", "الأحد بعد العصر", "مع نفس الدكتور", "فيه معاد النهاردة؟")
 * - Group B: Single active service auto-resolution without extra questions
 * - Group C: Provider selection ("أي مقدم خدمة متاح", single provider, previous doctor)
 * - Group D: Egyptian Relative Dates (Today, Tomorrow, Day after tomorrow, 2 weeks, 3 weeks, weekday offset)
 * - Group E: Slot Navigation ("أوقات أخرى" pagination, "يوم آخر" date reset with preserved service)
 * - Group F: Arabic Ordinals & Structured Selectors ("الأول", "التاني", "opt_1", "slot_2")
 * - Group G: Telegram inline buttons & callback deduplication
 * - Group H: WhatsApp button_reply id precedence
 * - Group I: Zero paid LLM calls on navigation & selection turns
 * - Group J: Confirmation summary contains business name ("لدى...")
 */

import type { ConversationEngineDeps } from "../src/features/conversations/server/conversation-engine";
import type {
  Business,
  Conversation,
  ConversationStatus,
  Customer,
  Message,
} from "../src/types/domain";

export {};

type Check = { group: string; label: string; pass: boolean; detail?: string };
const checks: Check[] = [];

function check(
  group: string,
  label: string,
  pass: boolean,
  detail?: string,
): void {
  checks.push({ group, label, pass, detail });
}

async function run(): Promise<void> {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const { receiveInboundMessage, formatBookingOptionsMessage } =
    await import("../src/features/conversations/server/conversation-engine");
  const { resolveEgyptianRelativeDate, extractTimeOfDayPreference } =
    await import("../src/features/conversations/server/relative-date");
  const { parseBookingSelection } =
    await import("../src/features/conversations/server/booking-selection");
  const { parseTelegramUpdate } =
    await import("../src/server/integrations/telegram/telegram-webhook");
  const { parseMetaWebhookPayload } =
    await import("../src/server/integrations/whatsapp/meta-webhook");

  const BIZ_ID = "11111111-1111-4111-8111-111111111111";
  const BRANCH_ID = "44444444-4444-4444-8444-444444444444";
  const CUST_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const USER_P1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
  const USER_P2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
  const PROV_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
  const PROV_2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
  const SERV_DENTAL = "33333333-3333-4333-8333-333333333331";
  const SERV_CLEAN = "33333333-3333-4333-8333-333333333332";

  const TODAY_REF = "2026-10-20"; // Tuesday

  // =========================================================================
  // Test Harness Builder
  // =========================================================================
  function createHarness(options?: {
    singleService?: boolean;
    confirmationMode?: "automatic" | "manual";
    providersCount?: 1 | 2;
    priorAppointment?: boolean;
  }) {
    const singleService = options?.singleService ?? false;
    const confirmationMode = options?.confirmationMode ?? "automatic";
    const providersCount = options?.providersCount ?? 2;
    const priorAppointment = options?.priorAppointment ?? false;

    let llmCallCount = 0;

    function openWeek(_slotMins = 30) {
      const days = ["sat", "sun", "mon", "tue", "wed", "thu", "fri"] as const;
      const hours: any = {};
      for (const d of days) {
        hours[d] = { open: "09:00", close: "17:00", closed: false };
      }
      return hours;
    }

    const business: Business = {
      id: BIZ_ID,
      name: "عيادة النور لطب الأسنان",
      slug: "al-noor",
      timezone: "Africa/Cairo",
      workingHours: openWeek(30),
      slotDurationMinutes: 30,
      bookingLeadTimeHours: 1,
      bookingHorizonDays: 30,
      bookingIntervalMinutes: 30,
      confirmationMode,
      defaultBranchId: BRANCH_ID,
      whatsappNumber: "+201001111111",
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any;

    const customer: Customer = {
      id: CUST_ID,
      businessId: BIZ_ID,
      name: "أحمد محمود",
      phone: "+201001234567",
      notes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any;

    const conversation: Conversation = {
      id: "conv-c2-test",
      businessId: BIZ_ID,
      customerId: CUST_ID,
      channel: "WHATSAPP",
      status: "AI_ACTIVE" as ConversationStatus,
      assignedUserId: null,
      branchId: BRANCH_ID,
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

    if (priorAppointment) {
      appointments.push({
        id: "appt-prior-1",
        businessId: BIZ_ID,
        branchId: BRANCH_ID,
        customerId: CUST_ID,
        serviceId: SERV_DENTAL,
        providerId: PROV_1,
        assignedUserId: USER_P1,
        date: new Date("2026-10-10T00:00:00Z"),
        startTime: "10:00",
        endTime: "10:30",
        status: "CONFIRMED",
        notes: null,
        followUpRequestId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      });
    }

    const services = [
      {
        id: SERV_DENTAL,
        businessId: BIZ_ID,
        name: "كشف أسنان",
        durationMinutes: 30,
        price: 200,
        currency: "EGP",
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      ...(singleService
        ? []
        : [
            {
              id: SERV_CLEAN,
              businessId: BIZ_ID,
              name: "تنظيف أسنان",
              durationMinutes: 30,
              price: 300,
              currency: "EGP",
              isActive: true,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ]),
    ];

    const allProviders = [
      {
        id: PROV_1,
        businessId: BIZ_ID,
        userId: USER_P1,
        name: "د. أحمد سامي",
        displayName: "د. أحمد سامي",
        title: "طبيب أسنان",
        bio: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      ...(providersCount === 2
        ? [
            {
              id: PROV_2,
              businessId: BIZ_ID,
              userId: USER_P2,
              name: "د. سارة عادل",
              displayName: "د. سارة عادل",
              title: "طبيبة أسنان",
              bio: null,
              isActive: true,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ]
        : []),
    ];

    const deps: ConversationEngineDeps = {
      businessRepository: {
        findById: async (id: string) => (id === BIZ_ID ? business : null),
        findBySlug: async () => null,
        findByWhatsAppNumber: async () => business,
        findByWhatsappNumber: async () => business,
        findByTelegramBotToken: async () => null,
      } as any,
      branchRepository: {
        findById: async () => ({
          id: BRANCH_ID,
          businessId: BIZ_ID,
          name: "الفرع الرئيسي",
        }),
        findByIdWithinBusiness: async (brId: string, bId: string) =>
          bId === BIZ_ID && brId === BRANCH_ID
            ? { id: BRANCH_ID, businessId: BIZ_ID }
            : null,
        listByBusiness: async () => [],
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
        findByCustomer: async () => conversation,
        findLatestByCustomer: async () => ({ id: conversation.id }),
        findOpenByCustomer: async () => conversation,
        create: async () => conversation,
        update: async (_id: string, patch: any) => {
          Object.assign(conversation, patch);
          return conversation;
        },
        updateWorkflow: async (_id: string, patch: any) => {
          Object.assign(conversation, patch);
          return conversation;
        },
        addMessage: async (input: any, workflow?: any) => {
          if (workflow?.status) conversation.status = workflow.status;
          const m = {
            id: `msg-${messages.length + 1}`,
            conversationId: conversation.id,
            senderType: input.senderType,
            content: input.content,
            sentAt: new Date(),
            createdAt: new Date(),
          } as any;
          messages.push(m);
          return m;
        },
        listRecentMessages: async () => messages.slice(-10),
        getMessages: async () => [...messages].reverse(),
      } as any,
      serviceRepository: {
        listByBusiness: async () => services,
        findById: async (id: string) =>
          services.find((s) => s.id === id) ?? null,
        findByIdWithinBusiness: async (sId: string, bId: string) =>
          bId === BIZ_ID ? (services.find((s) => s.id === sId) ?? null) : null,
      } as any,
      inboundDedupeRepository: {
        claim: async (businessId: string, key: string) => {
          const ledgerKey = `${businessId}|${key}`;
          if (dedupeLedger.has(ledgerKey)) {
            return {
              status: "duplicate" as const,
              claimId: "claim-dup",
              conversationId: null,
              customerMessageId: null,
            };
          }
          dedupeLedger.add(ledgerKey);
          return {
            status: "claimed" as const,
            claimId: `claim-${dedupeLedger.size}`,
          };
        },
        release: async () => {},
        complete: async () => {},
      } as any,
      usageRepository: {
        record: async () => ({ id: "usage-1" }),
        getMonthlyTurnCount: async () => 0,
      } as any,
      attentionRepository: {
        record: async () => {},
      } as any,
      knowledgeGapRepository: {
        record: async () => {},
      } as any,
      turnTelemetry: {
        record: async () => {},
      } as any,
      providerRepository: {
        listEligibleForService: async (_bId: string, sId: string) => {
          if (sId === SERV_DENTAL || sId === SERV_CLEAN) return allProviders;
          return [];
        },
        findByIdWithinBusiness: async (pId: string, bId: string) => {
          if (bId !== BIZ_ID) return null;
          return allProviders.find((p) => p.id === pId) ?? null;
        },
        listAssignmentSeams: async () =>
          allProviders.map((p) => ({
            providerId: p.id,
            userId: p.userId,
            isActive: true,
          })),
      } as any,
      appointmentRepository: {
        listBlockingForDate: async () => [],
        listBlockingByAssignees: async () =>
          appointments.map((a) => ({
            id: a.id,
            assignedUserId: a.assignedUserId!,
            providerId: a.providerId ?? undefined,
            date:
              a.date instanceof Date
                ? a.date.toISOString().slice(0, 10)
                : String(a.date),
            startTime: a.startTime,
            endTime: a.endTime,
            status: a.status,
          })),
        createWithConflictCheck: async (dto: any) => {
          const appt = {
            id: `appt-${appointments.length + 1}`,
            businessId: dto.businessId,
            branchId: dto.branchId,
            customerId: dto.customerId,
            serviceId: dto.serviceId,
            providerId: dto.providerId ?? null,
            assignedUserId: dto.assignedUserId ?? null,
            date: new Date(`${dto.date}T00:00:00Z`),
            startTime: dto.startTime,
            endTime: dto.endTime,
            status: dto.status,
            notes: dto.notes ?? null,
            followUpRequestId: dto.followUpRequestId ?? null,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
          } as any;
          appointments.push(appt);
          return appt;
        },
        listRecentByCustomer: async (_bId: string, _cId: string, take = 3) => {
          return appointments.slice(-take);
        },
      } as any,
      followUpRequestRepository: {
        getEligibleForChannel: async () => [],
        findById: async () => null,
        updateStatus: async () => {},
      } as any,
      ai: {
        providerName: "TEST_AI",
        respond: async () => {
          llmCallCount++;
          return {
            intent: "BOOKING",
            action: "reply",
            content: "طلب حجز",
            summary: "طلب حجز تجريبي",
            extraction: {
              service: null,
              provider: null,
              date: null,
              timePreference: null,
            },
            handoffReason: null,
          };
        },
      } as any,
      transport: {
        providerName: "TEST_TRANSPORT",
        send: async (out: any) => {
          deliveredOutbound.push(out);
          return { provider: "TEST_TRANSPORT", delivered: true };
        },
      } as any,
      requiredSemanticCapability: null,
    };

    return {
      deps,
      business,
      customer,
      conversation,
      messages,
      appointments,
      deliveredOutbound,
      getLlmCallCount: () => llmCallCount,
      sendMessage: async (text: string, externalId?: string) => {
        const to = customer.phone.startsWith("tg:")
          ? "6000000000"
          : (business as any).whatsappNumber;
        const from = customer.phone.startsWith("tg:")
          ? customer.phone.replace("tg:", "")
          : customer.phone;
        const res = await receiveInboundMessage(deps, {
          to,
          from,
          text,
          receivedAt: new Date().toISOString(),
          externalId: externalId ?? `msg-in-${Date.now()}-${Math.random()}`,
        });
        return {
          ...res,
          conversationStatus:
            "conversationStatus" in res
              ? (res as any).conversationStatus
              : null,
        } as any;
      },
    };
  }

  // =========================================================================
  // Group A: Intent & Egyptian Expressions
  // =========================================================================
  {
    // "عايز أحجز بكرة"
    const rel1 = resolveEgyptianRelativeDate("عايز أحجز بكرة", TODAY_REF);
    check(
      "A",
      "عايز أحجز بكرة -> resolves tomorrow (+1 day)",
      rel1 === "2026-10-21",
    );

    // "الأسبوع الجاي"
    const rel2 = resolveEgyptianRelativeDate("ممكن الأسبوع الجاي؟", TODAY_REF);
    check(
      "A",
      "الأسبوع الجاي -> resolves next week (+7 days)",
      rel2 === "2026-10-27",
    );

    // "الأحد بعد العصر" -> timeOfDayPref = afternoon
    const timePref = extractTimeOfDayPreference("الأحد بعد العصر");
    check(
      "A",
      "الأحد بعد العصر -> extracts afternoon time preference",
      timePref === "afternoon",
    );

    // "فيه معاد النهاردة؟"
    const relToday = resolveEgyptianRelativeDate(
      "فيه معاد النهاردة؟",
      TODAY_REF,
    );
    check("A", "فيه معاد النهاردة؟ -> resolves today", relToday === TODAY_REF);

    // "النهاردة الثلاثاء" when today is Tuesday (2026-10-20)
    const relTodayWeekday = resolveEgyptianRelativeDate(
      "النهاردة الثلاثاء",
      TODAY_REF,
    );
    check(
      "A",
      "النهاردة الثلاثاء when today is Tuesday -> stays today (+0)",
      relTodayWeekday === TODAY_REF,
    );
  }

  // =========================================================================
  // Group B: Three-Week & Egyptian Relative Date Resolution
  // =========================================================================
  {
    const d3w1 = resolveEgyptianRelativeDate("بعد ٣ أسابيع", TODAY_REF);
    check("B", "بعد ٣ أسابيع -> +21 days", d3w1 === "2026-11-10");

    const d3w2 = resolveEgyptianRelativeDate("كمان 3 أسابيع", TODAY_REF);
    check("B", "كمان 3 أسابيع -> +21 days", d3w2 === "2026-11-10");

    const d3w3 = resolveEgyptianRelativeDate("بعد تلات اسابيع", TODAY_REF);
    check("B", "بعد تلات اسابيع -> +21 days", d3w3 === "2026-11-10");

    const dAfterTomorrow = resolveEgyptianRelativeDate(
      "بعد بكرة إن شاء الله",
      TODAY_REF,
    );
    check("B", "بعد بكرة -> +2 days", dAfterTomorrow === "2026-10-22");
  }

  // =========================================================================
  // Group C: Single Active Service Auto-Resolution
  // =========================================================================
  {
    const h = createHarness({ singleService: true });
    // AI extracts date "2026-10-22" but NO service
    h.deps.ai.respond = async () => ({
      intent: "BOOKING",
      action: "reply",
      content: "تفضل",
      summary: "طلب حجز",
      extraction: {
        service: null,
        provider: null,
        date: "2026-10-22",
        timePreference: null,
      },
      handoffReason: null,
    });

    const res = await h.sendMessage("عايز أحجز بعد بكرة");
    check(
      "C",
      "Single service auto-resolution proceeds to booking options without asking service",
      res.ok === true && res.assistantAction === "AI_REPLY",
    );
    const lastReply =
      h.deliveredOutbound[h.deliveredOutbound.length - 1]?.content ?? "";
    check(
      "C",
      "Response presents booking options for the single active service",
      lastReply.includes("كشف أسنان") &&
        lastReply.includes("تتوفر المواعيد التالية"),
    );
  }

  // =========================================================================
  // Group D: Same Doctor Seam ("مع نفس الدكتور")
  // =========================================================================
  {
    const h = createHarness({ priorAppointment: true });
    // Customer asks for "مع نفس الدكتور"
    h.deps.ai.respond = async () => ({
      intent: "BOOKING",
      action: "reply",
      content: "تمام",
      summary: "طلب حجز",
      extraction: {
        service: "كشف أسنان",
        provider: null,
        date: "2026-10-22",
        timePreference: null,
      },
      handoffReason: null,
    });

    await h.sendMessage("عايز أحجز كشف أسنان بعد بكرة مع نفس الدكتور");
    const lastReply =
      h.deliveredOutbound[h.deliveredOutbound.length - 1]?.content ?? "";
    check(
      "D",
      "مع نفس الدكتور -> locks to prior doctor (د. أحمد سامي)",
      lastReply.includes("د. أحمد سامي") && !lastReply.includes("د. سارة عادل"),
    );
  }

  // =========================================================================
  // Group E: Any Provider Variations
  // =========================================================================
  {
    const { matchProviderByName } =
      await import("../src/features/conversations/server/booking-mapper");
    const m1 = matchProviderByName("أي مقدم خدمة متاح", []);
    check(
      "E",
      "أي مقدم خدمة متاح -> matches any provider",
      m1.status === "any",
    );

    const m2 = matchProviderByName("اي مقدم خدمة", []);
    check("E", "اي مقدم خدمة -> matches any provider", m2.status === "any");

    const m3 = matchProviderByName("مش فارقة", []);
    check("E", "مش فارقة -> matches any provider", m3.status === "any");
  }

  // =========================================================================
  // Group F: Selection Parsing (Protocols, Numbers, Safe Boundaries)
  // =========================================================================
  {
    const s1 = parseBookingSelection("1");
    check("F", "1 -> slot index 1", s1?.kind === "index" && s1.index === 1);

    const s2 = parseBookingSelection("٢");
    check(
      "F",
      "٢ (indic) -> slot index 2",
      s2?.kind === "index" && s2.index === 2,
    );

    const s3 = parseBookingSelection("3");
    check("F", "3 -> slot index 3", s3?.kind === "index" && s3.index === 3);

    const sOpt = parseBookingSelection("opt_1");
    check(
      "F",
      "opt_1 -> slot index 1",
      sOpt?.kind === "index" && sOpt.index === 1,
    );

    const sSlot = parseBookingSelection("slot_2");
    check(
      "F",
      "slot_2 -> slot index 2",
      sSlot?.kind === "index" && sSlot.index === 2,
    );

    const sFree = parseBookingSelection("مش عايز يوم تاني");
    check(
      "F",
      "مش عايز يوم تاني -> null (free-form negative reaches semantic route)",
      sFree === null,
    );

    const sMixed = parseBookingSelection("٢ بس غير اليوم");
    check(
      "F",
      "٢ بس غير اليوم -> null (mixed numeric reaches semantic route)",
      sMixed === null,
    );

    const sOrdinal = parseBookingSelection("الاول");
    check("F", "الاول -> null (ordinal dictionary removed)", sOrdinal === null);

    const sMoreTg = parseBookingSelection("more_times");
    check(
      "F",
      "more_times (callback) -> more_times",
      sMoreTg?.kind === "more_times",
    );

    const sChangeDateTg = parseBookingSelection("change_date");
    check(
      "F",
      "change_date (callback) -> change_date",
      sChangeDateTg?.kind === "change_date",
    );
  }

  // =========================================================================
  // Group G: Slot Navigation & Pagination at Zero Paid LLM Calls
  // =========================================================================
  {
    const h = createHarness();
    const offerMsg = formatBookingOptionsMessage("كشف أسنان", "2026-10-22", [
      {
        index: 1,
        startTime: "09:00",
        endTime: "09:30",
        displayName: "د. أحمد سامي",
        providerId: PROV_1,
      },
      {
        index: 2,
        startTime: "09:30",
        endTime: "10:00",
        displayName: "د. أحمد سامي",
        providerId: PROV_1,
      },
      {
        index: 3,
        startTime: "10:00",
        endTime: "10:30",
        displayName: "د. أحمد سامي",
        providerId: PROV_1,
      },
    ]);
    await h.deps.conversationRepository.addMessage({
      conversationId: h.conversation.id,
      senderType: "AI",
      content: offerMsg,
    });

    const llmCallsBefore = h.getLlmCallCount();

    // 1. Customer triggers button protocol "more_times"
    const moreRes = await h.sendMessage("more_times", "ext-nav-more");
    check(
      "G",
      "more_times handled deterministically",
      moreRes.ok === true && moreRes.assistantAction === "AI_REPLY",
    );
    const lastReply =
      h.deliveredOutbound[h.deliveredOutbound.length - 1]?.content ?? "";
    check(
      "G",
      "Pagination shows subsequent times or indicates all available",
      lastReply.includes("أوقات") || lastReply.includes("المواعيد المتاحة"),
    );
    check(
      "G",
      "Zero LLM calls on 'more_times'",
      h.getLlmCallCount() === llmCallsBefore,
    );

    // 2. Customer triggers button protocol "change_date"
    const changeRes = await h.sendMessage("change_date", "ext-nav-day");
    check(
      "G",
      "change_date handled deterministically",
      changeRes.ok === true && changeRes.assistantAction === "AI_REPLY",
    );
    const changeReply =
      h.deliveredOutbound[h.deliveredOutbound.length - 1]?.content ?? "";
    check(
      "G",
      "Prompts for new day with service preserved",
      changeReply.includes("كشف أسنان") && changeReply.includes("تحديد اليوم"),
    );
    check(
      "G",
      "Zero LLM calls on 'change_date'",
      h.getLlmCallCount() === llmCallsBefore,
    );
  }

  // =========================================================================
  // Group H: Telegram & WhatsApp Channel Integration
  // =========================================================================
  {
    // Telegram callback_query normalization & dedup key
    const tgUpdate = {
      update_id: 888001,
      callback_query: {
        id: "cq-999",
        from: { id: 12345678, is_bot: false },
        message: {
          message_id: 50,
          date: 1758900000,
          chat: { id: 12345678, type: "private" },
          text: "المواعيد المتاحة",
        },
        data: "opt_1",
      },
    };
    const parsedTg = parseTelegramUpdate(tgUpdate, {
      botExternalId: "6000000000",
    });
    check(
      "H",
      "Telegram callback_query parses as normalized TEXT with tg:bot:updateId externalId",
      parsedTg.status === "message" &&
        parsedTg.message.externalMessageId === "tg:6000000000:888001" &&
        parsedTg.message.text === "opt_1",
    );

    // Telegram options outbound carries replyMarkup inline keyboard
    const hTg = createHarness();
    hTg.customer.phone = "tg:12345678";
    hTg.deps.ai.respond = async () => ({
      intent: "BOOKING",
      action: "reply",
      content: "تمام",
      summary: "طلب حجز",
      extraction: {
        service: "كشف أسنان",
        provider: null,
        date: "2026-10-22",
        timePreference: null,
      },
      handoffReason: null,
    });
    await hTg.sendMessage("عايز أحجز كشف أسنان يوم 2026-10-22");
    const tgOutbound = hTg.deliveredOutbound[hTg.deliveredOutbound.length - 1];
    check(
      "H",
      "Telegram options outbound delivers inline_keyboard replyMarkup",
      tgOutbound?.replyMarkup?.inline_keyboard !== undefined &&
        Array.isArray(tgOutbound.replyMarkup.inline_keyboard),
    );

    // WhatsApp interactive button_reply uses clean id over title
    const waPayload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-1",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "+201001112233",
                  phone_number_id: "111",
                },
                messages: [
                  {
                    from: "+201001234567",
                    id: "wamid-btn-1",
                    timestamp: "1758900000",
                    type: "interactive",
                    interactive: {
                      type: "button_reply",
                      button_reply: {
                        id: "1",
                        title: "09:00 إلى 09:30 د. أحمد سامي",
                      },
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const parsedWa = parseMetaWebhookPayload(waPayload);
    check(
      "H",
      "WhatsApp button_reply uses button id ('1') rather than long title",
      parsedWa.messages.length === 1 &&
        parsedWa.messages[0]?.kind === "TEXT" &&
        parsedWa.messages[0]?.text === "1",
    );
  }

  // =========================================================================
  // Group I: Confirmation Summary & Booking Core Correctness
  // =========================================================================
  {
    const h = createHarness({ confirmationMode: "automatic" });
    const offerMsg = formatBookingOptionsMessage("كشف أسنان", "2026-10-22", [
      {
        displayName: "د. أحمد سامي",
        start: "09:00",
        end: "09:30",
        providerId: PROV_1,
      },
      {
        displayName: "د. أحمد سامي",
        start: "09:30",
        end: "10:00",
        providerId: PROV_1,
      },
    ]);
    await h.deps.conversationRepository.addMessage({
      conversationId: h.conversation.id,
      senderType: "AI",
      content: offerMsg,
    });

    const llmBeforeSelection = h.getLlmCallCount();
    // Select option 1
    const res = await h.sendMessage("1", "ext-confirm-1");
    check(
      "I",
      "Option selection turn succeeds with BOOKED status",
      res.ok === true && res.conversationStatus === "BOOKED",
    );
    check(
      "I",
      "Zero paid LLM calls on option selection",
      h.getLlmCallCount() === llmBeforeSelection,
    );

    // Verify appointment was created in repository
    check(
      "I",
      "Real appointment created in appointment repository",
      h.appointments.length === 1,
    );
    const appt = h.appointments[0];
    check(
      "I",
      "Created appointment has status CONFIRMED",
      appt?.status === "CONFIRMED",
    );

    // Verify confirmation message contains business name
    const confirmReply =
      h.deliveredOutbound[h.deliveredOutbound.length - 1]?.content ?? "";
    check(
      "I",
      "Confirmation summary includes 'لدى عيادة النور لطب الأسنان'",
      confirmReply.includes("لدى عيادة النور لطب الأسنان") &&
        confirmReply.includes("2026-10-22") &&
        confirmReply.includes("09:00"),
    );
  }

  // =========================================================================
  // Summary Report
  // =========================================================================
  console.log("\n========================================================");
  console.log("FLOWPILOT UX001-C2 VERIFICATION REPORT");
  console.log("Customer Chat Booking UX Polish — WhatsApp & Telegram");
  console.log("========================================================\n");

  let passedCount = 0;
  for (let i = 0; i < checks.length; i++) {
    const c = checks[i]!;
    const numStr = (i + 1).toString().padStart(2, "0");
    if (c.pass) {
      passedCount++;
      console.log(`✔ [${c.group}-${numStr}] ${c.label}`);
    } else {
      console.error(`✖ [${c.group}-${numStr}] FAIL: ${c.label}`);
      if (c.detail) console.error(`  Detail: ${c.detail}`);
    }
  }

  console.log(`\nResults: ${passedCount}/${checks.length} passed.`);
  if (passedCount !== checks.length) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("Fatal test runner error:", err);
  process.exit(1);
});
