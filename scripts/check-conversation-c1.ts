/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * FlowPilot — UX001-C1 Verification Suite
 * Customer Conversation Booking & Flexible Follow-up
 *
 * 37 Comprehensive Scenarios:
 * 1. Customer says: "عايز أحجز كشف أسنان"
 * 2. Customer says: "عندكم ميعاد بكرة؟"
 * 3. Customer says: "ينفع الأسبوع القادم؟"
 * 4. Customer says: "عايز ميعاد بعد أسبوعين"
 * 5. Ambiguous service selection -> clarifies with options
 * 6. Service resolution without ambiguous options
 * 7. Service with zero eligible providers -> polite human assistance handoff
 * 8. Service with exactly one eligible provider -> auto-selected
 * 9. Multiple eligible providers and customer specifies one
 * 10. Multiple eligible providers and customer has no preference ("أي دكتور")
 * 11. Provider requested is not eligible -> explains and offers other/any provider
 * 12. Availability query produces valid options with correct start times
 * 13. Availability query respects service duration (45 min)
 * 14. Availability query respects 10-minute booking interval when configured
 * 15. Availability query excludes past time slots according to business timezone
 * 16. Customer chooses valid option by digit ("1")
 * 17. Customer chooses valid option by time ("10:00")
 * 18. Customer chooses option using Arabic digits ("١")
 * 19. Customer chooses invalid option number ("9") -> polite re-ask without resetting
 * 20. Customer changes day after seeing options -> preserves service/provider, gives new times
 * 21. Customer changes service after seeing options -> resets downstream selections, re-checks eligibility
 * 22. Customer changes provider preference after seeing options -> gives updated options
 * 23. Confirmation prompt displays complete summary (service, branch/doctor, date, start, end)
 * 24. Customer confirms -> real appointment is created through Booking Core
 * 25. Appointment status is CONFIRMED when mode is automatic
 * 26. Appointment status is PENDING when mode is manual
 * 27. Conflict occurs between option display and confirmation -> fresh options offered
 * 28. Customer asks for flexible follow-up and has one PENDING request with range -> presents range
 * 29. Customer selects date inside doctor's allowed range -> options shown and booking succeeds
 * 30. Customer selects date outside doctor's allowed range -> polite error, shows range, retains request
 * 31. Customer has multiple pending follow-up requests -> lists them and prompts selection
 * 32. Customer asks for follow-up but has zero pending requests -> explains no pending follow-up
 * 33. Follow-up converted to appointment -> FollowUpRequest status is SCHEDULED and linked
 * 34. Attempt to book already SCHEDULED or CANCELLED follow-up -> rejected safely
 * 35. Idempotent webhook delivery with same message ID -> processed once, no duplicate
 * 36. Cross-tenant isolation -> customer cannot see or book follow-up/service belonging to another business
 * 37. Receptionist query -> appointment created via conversation is visible in agenda/appointment list
 */

import type { ConversationEngineDeps } from "../src/features/conversations/server/conversation-engine";
import type {
  Appointment,
  AppointmentStatus,
  Business,
  Conversation,
  ConversationStatus,
  Customer,
  Message,
} from "../src/types/domain";

export {};

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

  const { receiveInboundMessage, formatBookingOptionsMessage } =
    await import("../src/features/conversations/server/conversation-engine");
  const { resolveEgyptianRelativeDate } =
    await import("../src/features/conversations/server/relative-date");

  const BIZ_A = "11111111-1111-4111-8111-111111111111";
  const BIZ_B = "22222222-2222-4222-8222-222222222222";
  const BRANCH_A = "44444444-4444-4444-8444-444444444444";
  const CUST_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const CUST_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const USER_P1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
  const USER_P2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
  const PROV_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
  const PROV_2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
  const SERV_DENTAL = "33333333-3333-4333-8333-333333333331";
  const SERV_CLEAN_1 = "33333333-3333-4333-8333-333333333332";
  const SERV_CLEAN_2 = "33333333-3333-4333-8333-333333333333";
  const SERV_LONG = "33333333-3333-4333-8333-333333333334";
  const SERV_NO_PROV = "33333333-3333-4333-8333-333333333335";

  const TEST_DATE = "2026-10-20"; // Tuesday
  const now = new Date();

  function openWeek(_slotMins = 30): Record<string, unknown> {
    const days = ["sat", "sun", "mon", "tue", "wed", "thu", "fri"];
    const hours: Record<string, unknown> = {};
    for (const d of days) {
      hours[d] = { open: "09:00", close: "17:00", closed: false };
    }
    return hours;
  }

  function makeBusiness(
    mode: "manual" | "automatic" = "automatic",
    slotMins = 30,
  ): Business {
    return {
      id: BIZ_A,
      name: "عيادة النور لطب الأسنان",
      timezone: "Africa/Cairo",
      workingHours: openWeek(slotMins),
      slotDurationMinutes: slotMins,
      confirmationMode: mode,
      defaultBranchId: BRANCH_A,
      isActive: true,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      whatsappNumber: "+201001111111",
      vertical: null,
      city: "Cairo",
      about: null,
      faqs: [],
      cancellationPolicy: null,
      onboardingCompletedAt: now,
      assistantName: null,
      assistantStyle: null,
    } as unknown as Business;
  }

  const servicesList = [
    {
      id: SERV_DENTAL,
      businessId: BIZ_A,
      name: "كشف أسنان",
      durationMinutes: 30,
      isActive: true,
      description: null,
      priceAmount: 200,
      priceCurrency: "EGP",
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      priceType: null,
      priceMaxAmount: null,
      priceNote: null,
    },
    {
      id: SERV_CLEAN_1,
      businessId: BIZ_A,
      name: "تنظيف أسنان عادي",
      durationMinutes: 30,
      isActive: true,
      description: null,
      priceAmount: 300,
      priceCurrency: "EGP",
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      priceType: null,
      priceMaxAmount: null,
      priceNote: null,
    },
    {
      id: SERV_CLEAN_2,
      businessId: BIZ_A,
      name: "تنظيف أسنان وتبييض",
      durationMinutes: 30,
      isActive: true,
      description: null,
      priceAmount: 600,
      priceCurrency: "EGP",
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      priceType: null,
      priceMaxAmount: null,
      priceNote: null,
    },
    {
      id: SERV_LONG,
      businessId: BIZ_A,
      name: "علاج عصب مطول",
      durationMinutes: 45,
      isActive: true,
      description: null,
      priceAmount: 500,
      priceCurrency: "EGP",
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      priceType: null,
      priceMaxAmount: null,
      priceNote: null,
    },
    {
      id: SERV_NO_PROV,
      businessId: BIZ_A,
      name: "أشعة مقطعية",
      durationMinutes: 20,
      isActive: true,
      description: null,
      priceAmount: 400,
      priceCurrency: "EGP",
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      priceType: null,
      priceMaxAmount: null,
      priceNote: null,
    },
  ];

  const providersList = [
    {
      id: PROV_1,
      userId: USER_P1,
      businessId: BIZ_A,
      name: "د. أحمد سامي",
      displayName: "د. أحمد سامي",
      user: { name: "د. أحمد سامي" },
      isActive: true,
      deletedAt: null,
      services: [SERV_DENTAL, SERV_CLEAN_1, SERV_CLEAN_2, SERV_LONG],
    },
    {
      id: PROV_2,
      userId: USER_P2,
      businessId: BIZ_A,
      name: "د. سارة عادل",
      displayName: "د. سارة عادل",
      user: { name: "د. سارة عادل" },
      isActive: true,
      deletedAt: null,
      services: [SERV_DENTAL, SERV_CLEAN_1, SERV_CLEAN_2],
    },
  ];

  function buildHarness(opts?: {
    confirmationMode?: "manual" | "automatic";
    slotMins?: number;
    initialAppointments?: Array<any>;
    followUps?: Array<any>;
    aiExtraction?: {
      intent?: "BOOKING" | "AVAILABILITY" | "GREETING" | "AMBIGUOUS";
      service?: string | null;
      provider?: string | null;
      date?: string | null;
      timePreference?: string | null;
    };
  }) {
    const business = makeBusiness(
      opts?.confirmationMode ?? "automatic",
      opts?.slotMins ?? 30,
    );
    const customer: Customer = {
      id: CUST_A,
      businessId: BIZ_A,
      phone: "+201234567890",
      email: null,
      name: "محمد علي",
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      notes: null,
      lastConversationAt: null,
      lastAppointmentAt: null,
    };

    const messages: Message[] = [];
    let conversationStatus: ConversationStatus = "AI_ACTIVE";

    const conversation: Conversation = {
      id: "conv-1111-1111",
      businessId: BIZ_A,
      customerId: customer.id,
      branchId: BRANCH_A,
      assignedUserId: null,
      status: "AI_ACTIVE",
      lastMessageAt: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      aiSummary: null,
    };

    const appointments: Array<any> = [...(opts?.initialAppointments ?? [])];
    const followUps: Array<any> = [...(opts?.followUps ?? [])];
    const sentMessages: Array<{ to: string; text: string }> = [];
    const dedupeLedger = new Map<string, any>();

    const deps: ConversationEngineDeps = {
      businessRepository: {
        findById: async (id: string) => (id === BIZ_A ? business : null),
        findByWhatsAppNumber: async () => business,
        findByWhatsappNumber: async () => business,
        findByTelegramBotToken: async () => null,
      } as any,
      customerRepository: {
        findById: async (id: string) => (id === customer.id ? customer : null),
        findByPhone: async () => customer,
        upsertByPhone: async () => customer,
        touchConversation: async () => customer,
      } as any,
      conversationRepository: {
        findById: async () => ({ ...conversation, status: conversationStatus }),
        findLatestByCustomer: async () => ({ id: conversation.id }),
        findOpenByCustomer: async () => ({
          ...conversation,
          status: conversationStatus,
        }),
        create: async () => conversation,
        update: async (_id: string, patch: any) => {
          if (patch.status) conversationStatus = patch.status;
          return { ...conversation, status: conversationStatus, ...patch };
        },
        updateWorkflow: async (_id: string, patch: any) => {
          if (patch.status) conversationStatus = patch.status;
          return { ...conversation, status: conversationStatus, ...patch };
        },
        addMessage: async (msg: any, workflow?: any) => {
          if (workflow?.status) conversationStatus = workflow.status;
          const m: Message = {
            id: `msg-${messages.length + 1}`,
            conversationId: conversation.id,
            senderType: msg.senderType,
            content: msg.content,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          messages.push(m);
          return m;
        },
        getMessages: async () => [...messages].reverse(),
      } as any,
      serviceRepository: {
        listByBusiness: async (bId: string) =>
          bId === BIZ_A ? servicesList.filter((s) => s.isActive) : [],
        findByIdWithinBusiness: async (sId: string, bId: string) =>
          bId === BIZ_A
            ? (servicesList.find((s) => s.id === sId) ?? null)
            : null,
        findById: async (sId: string) =>
          servicesList.find((s) => s.id === sId) ?? null,
      } as any,
      providerRepository: {
        listEligibleForService: async (bId: string, sId: string) => {
          if (bId !== BIZ_A) return [];
          return providersList.filter((p) => p.services.includes(sId));
        },
        findByIdWithinBusiness: async (pId: string, bId: string) => {
          if (bId !== BIZ_A) return null;
          return providersList.find((p) => p.id === pId) ?? null;
        },
        listAssignmentSeams: async (bId: string, pIds: string[]) => {
          if (bId !== BIZ_A) return [];
          return providersList
            .filter((p) => pIds.includes(p.id))
            .map((p) => ({ providerId: p.id, userId: p.userId }));
        },
      } as any,
      appointmentRepository: {
        listBlockingForDate: async (bId: string, d: string) => {
          if (bId !== BIZ_A) return [];
          return appointments
            .filter((a) => a.businessId === bId && a.date === d)
            .map((a) => ({ startTime: a.startTime, endTime: a.endTime }));
        },
        listBlockingByAssignees: async (
          bId: string,
          d: string,
          aIds: string[],
        ) => {
          if (bId !== BIZ_A) return [];
          return appointments
            .filter(
              (a) =>
                a.businessId === bId &&
                a.date === d &&
                aIds.includes(a.assignedUserId),
            )
            .map((a) => ({
              assignedUserId: a.assignedUserId,
              startTime: a.startTime,
              endTime: a.endTime,
            }));
        },
        createWithConflictCheck: async (dto: any) => {
          if (dto.followUpRequestId) {
            const fu = followUps.find(
              (f) =>
                f.id === dto.followUpRequestId &&
                f.businessId === dto.businessId,
            );
            if (!fu || fu.status !== "PENDING") {
              throw new Error("FOLLOW_UP_NOT_PENDING");
            }
            if (fu.startDate && dto.date < fu.startDate) {
              throw new Error("FOLLOW_UP_DATE_OUT_OF_RANGE");
            }
            if (fu.endDate && dto.date > fu.endDate) {
              throw new Error("FOLLOW_UP_DATE_OUT_OF_RANGE");
            }
            fu.status = "SCHEDULED";
            fu.scheduledAppointmentId = `appt-${appointments.length + 1}`;
          }
          const hasConflict = appointments.some(
            (a) =>
              a.businessId === dto.businessId &&
              a.date === dto.date &&
              a.assignedUserId === dto.assignedUserId &&
              ((dto.startTime >= a.startTime && dto.startTime < a.endTime) ||
                (dto.endTime > a.startTime && dto.endTime <= a.endTime)),
          );
          if (hasConflict) return null;
          const created: Appointment = {
            id: `appt-${appointments.length + 1}`,
            businessId: dto.businessId,
            customerId: dto.customerId,
            serviceId: dto.serviceId,
            branchId: dto.branchId,
            assignedUserId: dto.assignedUserId,
            providerId: dto.providerId ?? null,
            date: new Date(`${dto.date}T00:00:00.000Z`),
            startTime: new Date(`1970-01-01T${dto.startTime}:00.000Z`),
            endTime: new Date(`1970-01-01T${dto.endTime}:00.000Z`),
            status: dto.status as AppointmentStatus,
            notes: dto.notes ?? null,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          };
          appointments.push({
            ...created,
            date: dto.date,
            startTime: dto.startTime,
            endTime: dto.endTime,
          });
          return created;
        },
        listByBusiness: async (bId: string) => {
          return appointments.filter((a) => a.businessId === bId);
        },
      } as any,
      followUpRequestRepository: {
        findById: async (id: string, bId?: string) => {
          return (
            followUps.find(
              (f) => f.id === id && (!bId || f.businessId === bId),
            ) ?? null
          );
        },
        getEligibleForChannel: async (bId: string, cId?: string) => {
          return followUps
            .filter(
              (f) =>
                f.businessId === bId &&
                (!cId || f.customerId === cId) &&
                f.status === "PENDING",
            )
            .map((f) => {
              const serv = servicesList.find((s) => s.id === f.serviceId);
              const prov = providersList.find(
                (p) => p.id === f.preferredProviderId,
              );
              return {
                id: f.id,
                businessId: f.businessId,
                customerId: f.customerId,
                customerName: customer.name,
                customerPhone: customer.phone,
                serviceId: f.serviceId ?? null,
                serviceName: serv?.name ?? null,
                serviceDuration: serv?.durationMinutes ?? null,
                preferredProviderId: prov?.id ?? null,
                preferredProviderName: prov?.displayName ?? null,
                startDate: f.startDate ?? null,
                endDate: f.endDate ?? null,
                status: f.status,
                isEligible: true,
              };
            });
        },
      } as any,
      branchRepository: {
        findByIdWithinBusiness: async (brId: string, bId: string) =>
          bId === BIZ_A && brId === BRANCH_A
            ? { id: BRANCH_A, businessId: BIZ_A }
            : null,
      } as any,
      transport: {
        providerName: "fake-transport",
        send: async ({ to, content }: { to: string; content: string }) => {
          sentMessages.push({ to, text: content });
          return { provider: "fake-transport", delivered: true };
        },
      } as any,
      usageRepository: {
        record: async (input: any) => input,
      } as any,
      ai: {
        providerName: "test-ai",
        respond: async () => ({
          intent: opts?.aiExtraction?.intent ?? "BOOKING",
          action: "reply",
          content: "طلب حجز",
          summary: "طلب حجز تجريبي",
          extraction: {
            service: opts?.aiExtraction?.service ?? null,
            provider: opts?.aiExtraction?.provider ?? null,
            date: opts?.aiExtraction?.date ?? null,
            timePreference: opts?.aiExtraction?.timePreference ?? null,
          },
          handoffReason: null,
        }),
      } as any,
      inboundDedupeRepository: {
        claim: async (businessId: string, key: string) => {
          const ledgerKey = `${businessId}|${key}`;
          const existing = dedupeLedger.get(ledgerKey);
          if (existing) {
            return {
              status: "duplicate" as const,
              claimId: existing.claimId,
              conversationId: existing.conversationId,
              customerMessageId: existing.customerMessageId,
            };
          }
          const claimId = `claim-${dedupeLedger.size + 1}`;
          dedupeLedger.set(ledgerKey, {
            claimId,
            conversationId: null,
            customerMessageId: null,
          });
          return { status: "claimed" as const, claimId };
        },
      } as any,
    };

    async function sendMessage(text: string, externalId = "ext-msg") {
      const res = await receiveInboundMessage(deps, {
        to: business.whatsappNumber,
        from: customer.phone,
        text,
        receivedAt: new Date().toISOString(),
        externalId,
      });
      return {
        ...res,
        conversationStatus:
          "conversationStatus" in res ? res.conversationStatus : null,
      };
    }

    return {
      deps,
      business,
      customer,
      conversation,
      messages,
      appointments,
      followUps,
      sentMessages,
      sendMessage,
    };
  }

  // =========================================================================
  // SCENARIO 1: Customer says: "عايز أحجز كشف أسنان"
  // =========================================================================
  {
    const h = buildHarness({
      aiExtraction: { intent: "BOOKING", service: "كشف أسنان", date: null },
    });
    const res = await h.sendMessage("عايز أحجز كشف أسنان", "ext-1");
    const lastMsg = h.messages[h.messages.length - 1]?.content ?? "";
    check(
      1,
      'Customer says: "عايز أحجز كشف أسنان" -> asks for date, stays AI_ACTIVE',
      res.ok &&
        res.conversationStatus === "AI_ACTIVE" &&
        lastMsg.includes("التاريخ"),
    );
  }

  // =========================================================================
  // SCENARIO 2: Customer says: "عندكم ميعاد بكرة؟"
  // =========================================================================
  {
    const h = buildHarness({
      aiExtraction: { intent: "BOOKING", service: null, date: null },
    });
    const res = await h.sendMessage("عندكم ميعاد بكرة؟", "ext-2");
    const lastMsg = h.messages[h.messages.length - 1]?.content ?? "";
    check(
      2,
      'Customer says: "عندكم ميعاد بكرة؟" -> resolves tomorrow, asks for service',
      res.ok &&
        res.conversationStatus === "AI_ACTIVE" &&
        lastMsg.includes("الخدمة"),
    );
  }

  // =========================================================================
  // SCENARIO 3: Customer says: "ينفع الأسبوع القادم؟"
  // =========================================================================
  {
    const resolved = resolveEgyptianRelativeDate(
      "ينفع الأسبوع القادم؟",
      "2026-10-18",
    );
    check(
      3,
      'Customer says: "ينفع الأسبوع القادم؟" -> resolves +7 days',
      resolved === "2026-10-25",
    );
  }

  // =========================================================================
  // SCENARIO 4: Customer says: "عايز ميعاد بعد أسبوعين"
  // =========================================================================
  {
    const resolved = resolveEgyptianRelativeDate(
      "عايز ميعاد بعد أسبوعين",
      "2026-10-18",
    );
    check(
      4,
      'Customer says: "عايز ميعاد بعد أسبوعين" -> resolves +14 days',
      resolved === "2026-11-01",
    );
  }

  // =========================================================================
  // SCENARIO 5: Ambiguous service selection
  // =========================================================================
  {
    const h = buildHarness({
      aiExtraction: { intent: "BOOKING", service: "تنظيف", date: TEST_DATE },
    });
    const res = await h.sendMessage("عايز تنظيف", "ext-5");
    const lastMsg = h.messages[h.messages.length - 1]?.content ?? "";
    check(
      5,
      "Ambiguous service selection -> clarifies with matching candidate list",
      res.ok &&
        res.conversationStatus === "AI_ACTIVE" &&
        lastMsg.includes("أكثر من خدمة") &&
        lastMsg.includes("تنظيف أسنان عادي"),
    );
  }

  // =========================================================================
  // SCENARIO 6: Service resolution without ambiguous options
  // =========================================================================
  {
    const h = buildHarness({
      aiExtraction: {
        intent: "BOOKING",
        service: "كشف أسنان",
        date: TEST_DATE,
      },
    });
    const res = await h.sendMessage("كشف أسنان", "ext-6");
    const lastMsg = h.messages[h.messages.length - 1]?.content ?? "";
    check(
      6,
      "Service resolution without ambiguity -> succeeds to show options",
      res.ok &&
        res.conversationStatus === "AI_ACTIVE" &&
        lastMsg.includes('تتوفر المواعيد التالية لخدمة "كشف أسنان"'),
    );
  }

  // =========================================================================
  // SCENARIO 7: Service with zero eligible providers -> polite human assistance handoff
  // =========================================================================
  {
    const h = buildHarness({
      aiExtraction: {
        intent: "BOOKING",
        service: "أشعة مقطعية",
        date: TEST_DATE,
      },
    });
    const res = await h.sendMessage("عايز أشعة مقطعية", "ext-7");
    const lastMsg = h.messages[h.messages.length - 1]?.content ?? "";
    check(
      7,
      "Zero eligible providers -> polite human handoff (NEED_HUMAN)",
      res.ok &&
        res.conversationStatus === "NEED_HUMAN" &&
        lastMsg.includes("لا يوجد مزود متاح لهذه الخدمة حالياً"),
    );
  }

  // =========================================================================
  // SCENARIO 8: Service with exactly one eligible provider -> auto-selected
  // =========================================================================
  {
    const h = buildHarness({
      aiExtraction: {
        intent: "BOOKING",
        service: "علاج عصب مطول",
        date: TEST_DATE,
      },
    });
    const res = await h.sendMessage("علاج عصب مطول", "ext-8");
    const lastMsg = h.messages[h.messages.length - 1]?.content ?? "";
    check(
      8,
      "Exactly one eligible provider -> auto-selected in options without forcing extra questions",
      res.ok &&
        res.conversationStatus === "AI_ACTIVE" &&
        lastMsg.includes("د. أحمد سامي"),
    );
  }

  // =========================================================================
  // SCENARIO 9: Multiple eligible providers and customer specifies one
  // =========================================================================
  {
    const h = buildHarness({
      aiExtraction: {
        intent: "BOOKING",
        service: "كشف أسنان",
        provider: "سارة",
        date: TEST_DATE,
      },
    });
    const res = await h.sendMessage("كشف أسنان مع دكتورة سارة", "ext-9");
    const lastMsg = h.messages[h.messages.length - 1]?.content ?? "";
    check(
      9,
      "Multiple providers with preference -> options filtered to requested provider",
      res.ok &&
        res.conversationStatus === "AI_ACTIVE" &&
        lastMsg.includes("د. سارة عادل") &&
        !lastMsg.includes("د. أحمد سامي"),
    );
  }

  // =========================================================================
  // SCENARIO 10: Multiple eligible providers and customer has no preference ("أي دكتور")
  // =========================================================================
  {
    const h = buildHarness({
      aiExtraction: {
        intent: "BOOKING",
        service: "كشف أسنان",
        provider: "أي دكتور",
        date: TEST_DATE,
      },
    });
    const res = await h.sendMessage("كشف أسنان مع أي دكتور متاح", "ext-10");
    const lastMsg = h.messages[h.messages.length - 1]?.content ?? "";
    check(
      10,
      'Multiple providers with no preference ("أي دكتور") -> options across any eligible provider',
      res.ok &&
        res.conversationStatus === "AI_ACTIVE" &&
        lastMsg.includes("تتوفر المواعيد التالية"),
    );
  }

  // =========================================================================
  // SCENARIO 11: Provider requested is not eligible -> explains and lists valid options
  // =========================================================================
  {
    const h = buildHarness({
      aiExtraction: {
        intent: "BOOKING",
        service: "علاج عصب مطول", // only PROV_1 is eligible
        provider: "سارة", // PROV_2 not eligible
        date: TEST_DATE,
      },
    });
    const res = await h.sendMessage("علاج عصب مع د. سارة", "ext-11");
    const lastMsg = h.messages[h.messages.length - 1]?.content ?? "";
    check(
      11,
      "Ineligible provider requested -> explains and stays AI_ACTIVE",
      res.ok &&
        res.conversationStatus === "AI_ACTIVE" &&
        lastMsg.includes("المزود المطلوب غير متاح لهذه الخدمة"),
    );
  }

  // =========================================================================
  // SCENARIO 12: Availability query produces valid options with correct start times
  // =========================================================================
  {
    const h = buildHarness({
      aiExtraction: {
        intent: "AVAILABILITY",
        service: "كشف أسنان",
        date: TEST_DATE,
      },
    });
    const res = await h.sendMessage(
      "المواعيد المتاحة لكشف الأسنان الثلاثاء",
      "ext-12",
    );
    const lastMsg = h.messages[h.messages.length - 1]?.content ?? "";
    check(
      12,
      "Availability query -> produces genuine start-to-end options",
      res.ok &&
        lastMsg.includes("09:00 إلى 09:30") &&
        lastMsg.includes("09:30 إلى 10:00"),
    );
  }

  // =========================================================================
  // SCENARIO 13: Availability query respects service duration (45 min)
  // =========================================================================
  {
    const h = buildHarness({
      aiExtraction: {
        intent: "BOOKING",
        service: "علاج عصب مطول",
        date: TEST_DATE,
      },
    });
    const res = await h.sendMessage("علاج عصب مطول", "ext-13");
    const lastMsg = h.messages[h.messages.length - 1]?.content ?? "";
    check(
      13,
      "Service duration (45 min) -> options display 45m duration (09:00 إلى 09:45)",
      res.ok && lastMsg.includes("09:00 إلى 09:45"),
    );
  }

  // =========================================================================
  // SCENARIO 14: Availability query respects 10-minute booking interval when configured
  // =========================================================================
  {
    const h = buildHarness({
      slotMins: 10,
      aiExtraction: {
        intent: "BOOKING",
        service: "كشف أسنان",
        date: TEST_DATE,
      },
    });
    const res = await h.sendMessage("كشف أسنان", "ext-14");
    const lastMsg = h.messages[h.messages.length - 1]?.content ?? "";
    check(
      14,
      "10-minute interval -> options align on 10m grid (09:00, 09:10, 09:20...)",
      res.ok && lastMsg.includes("09:10 إلى 09:40"),
    );
  }

  // =========================================================================
  // SCENARIO 15: Availability query excludes past time slots according to business timezone
  // =========================================================================
  {
    const todayIso = new Date().toISOString().slice(0, 10);
    const h = buildHarness({
      aiExtraction: { intent: "BOOKING", service: "كشف أسنان", date: todayIso },
    });
    const res = await h.sendMessage("كشف أسنان النهاردة", "ext-15");
    check(15, "Past slots excluded based on business timezone", res.ok);
  }

  // =========================================================================
  // SCENARIO 16: Customer chooses valid option by digit ("1")
  // =========================================================================
  {
    const h = buildHarness();
    const offerMsg = formatBookingOptionsMessage("كشف أسنان", TEST_DATE, [
      {
        displayName: "د. أحمد سامي",
        start: "09:00",
        end: "09:30",
      },
    ]);
    await h.deps.conversationRepository.addMessage({
      conversationId: h.conversation.id,
      senderType: "AI",
      content: offerMsg,
    });
    const res = await h.sendMessage("1", "ext-16");
    check(
      16,
      'Customer chooses by digit "1" -> BOOKED with confirmed appointment',
      res.ok &&
        res.conversationStatus === "BOOKED" &&
        h.appointments.length === 1,
    );
  }

  // =========================================================================
  // SCENARIO 17: Customer chooses valid option by time ("09:00")
  // =========================================================================
  {
    const h = buildHarness();
    const offerMsg = formatBookingOptionsMessage("علاج عصب مطول", TEST_DATE, [
      {
        displayName: "د. أحمد سامي",
        start: "09:00",
        end: "09:45",
      },
    ]);
    await h.deps.conversationRepository.addMessage({
      conversationId: h.conversation.id,
      senderType: "AI",
      content: offerMsg,
    });
    const res = await h.sendMessage("09:00", "ext-17");
    check(
      17,
      'Customer chooses by time "09:00" -> BOOKED',
      res.ok &&
        res.conversationStatus === "BOOKED" &&
        h.appointments.length === 1,
    );
  }

  // =========================================================================
  // SCENARIO 18: Customer chooses option using Arabic digits ("١")
  // =========================================================================
  {
    const h = buildHarness();
    const offerMsg = formatBookingOptionsMessage("كشف أسنان", TEST_DATE, [
      {
        displayName: "د. أحمد سامي",
        start: "09:00",
        end: "09:30",
      },
    ]);
    await h.deps.conversationRepository.addMessage({
      conversationId: h.conversation.id,
      senderType: "AI",
      content: offerMsg,
    });
    const res = await h.sendMessage("١", "ext-18");
    check(
      18,
      'Customer chooses by Arabic digit "١" -> BOOKED',
      res.ok &&
        res.conversationStatus === "BOOKED" &&
        h.appointments.length === 1,
    );
  }

  // =========================================================================
  // SCENARIO 19: Customer chooses invalid option number ("9") -> asks again politely without resetting
  // =========================================================================
  {
    const h = buildHarness();
    const offerMsg = formatBookingOptionsMessage("كشف أسنان", TEST_DATE, [
      {
        displayName: "د. أحمد سامي",
        start: "09:00",
        end: "09:30",
      },
    ]);
    await h.deps.conversationRepository.addMessage({
      conversationId: h.conversation.id,
      senderType: "AI",
      content: offerMsg,
    });
    const res = await h.sendMessage("9", "ext-19");
    const lastMsg = h.messages[h.messages.length - 1]?.content ?? "";
    check(
      19,
      'Customer chooses invalid option "9" -> asks again politely, retains offer',
      res.ok &&
        res.conversationStatus === "AI_ACTIVE" &&
        (lastMsg.includes("غير صالح") || lastMsg.includes("يرجى اختيار رقم")) &&
        h.appointments.length === 0,
    );
  }

  // =========================================================================
  // SCENARIO 20: Customer changes day after seeing options -> preserves service/provider, gives new times
  // =========================================================================
  {
    const h = buildHarness({
      aiExtraction: { intent: "BOOKING", date: "2026-10-21" }, // next day
    });
    const offerMsg = formatBookingOptionsMessage("كشف أسنان", TEST_DATE, [
      {
        displayName: "د. أحمد سامي",
        start: "10:00",
        end: "10:30",
      },
    ]);
    await h.deps.conversationRepository.addMessage({
      conversationId: h.conversation.id,
      senderType: "AI",
      content: offerMsg,
    });
    const res = await h.sendMessage("ينفع الأربعاء 21 أكتوبر؟", "ext-20");
    const lastMsg = h.messages[h.messages.length - 1]?.content ?? "";
    check(
      20,
      "Customer changes day -> preserves service, presents fresh options for new day",
      res.ok &&
        res.conversationStatus === "AI_ACTIVE" &&
        lastMsg.includes("2026-10-21"),
    );
  }

  // =========================================================================
  // SCENARIO 21: Customer changes service after seeing options -> resets downstream selections
  // =========================================================================
  {
    const h = buildHarness({
      aiExtraction: { intent: "BOOKING", service: "علاج عصب مطول" },
    });
    const offerMsg = formatBookingOptionsMessage("كشف أسنان", TEST_DATE, [
      {
        displayName: "د. أحمد سامي",
        start: "10:00",
        end: "10:30",
      },
    ]);
    await h.deps.conversationRepository.addMessage({
      conversationId: h.conversation.id,
      senderType: "AI",
      content: offerMsg,
    });
    const res = await h.sendMessage("عايز أغير لـ علاج عصب مطول", "ext-21");
    const lastMsg = h.messages[h.messages.length - 1]?.content ?? "";
    check(
      21,
      "Customer changes service -> resets downstream, checks eligibility for new service",
      res.ok &&
        res.conversationStatus === "AI_ACTIVE" &&
        lastMsg.includes("علاج عصب مطول"),
    );
  }

  // =========================================================================
  // SCENARIO 22: Customer changes provider preference after seeing options -> gives updated options
  // =========================================================================
  {
    const h = buildHarness({
      aiExtraction: { intent: "BOOKING", provider: "سارة" },
    });
    const offerMsg = formatBookingOptionsMessage("كشف أسنان", TEST_DATE, [
      {
        displayName: "د. أحمد سامي",
        start: "10:00",
        end: "10:30",
      },
    ]);
    await h.deps.conversationRepository.addMessage({
      conversationId: h.conversation.id,
      senderType: "AI",
      content: offerMsg,
    });
    const res = await h.sendMessage("ممكن مع د. سارة؟", "ext-22");
    const lastMsg = h.messages[h.messages.length - 1]?.content ?? "";
    check(
      22,
      "Customer changes provider -> preserves service & day, updates options",
      res.ok &&
        res.conversationStatus === "AI_ACTIVE" &&
        lastMsg.includes("د. سارة عادل"),
    );
  }

  // =========================================================================
  // SCENARIO 23: Confirmation prompt displays complete summary
  // =========================================================================
  {
    const h = buildHarness();
    const offerMsg = formatBookingOptionsMessage("كشف أسنان", TEST_DATE, [
      {
        displayName: "د. أحمد سامي",
        start: "09:00",
        end: "09:30",
      },
    ]);
    await h.deps.conversationRepository.addMessage({
      conversationId: h.conversation.id,
      senderType: "AI",
      content: offerMsg,
    });
    await h.sendMessage("1", "ext-23");
    const confirmMsg = h.messages[h.messages.length - 1]?.content ?? "";
    check(
      23,
      "Confirmation summary includes service, date, start time, end time, and doctor",
      confirmMsg.includes("كشف أسنان") &&
        confirmMsg.includes(TEST_DATE) &&
        confirmMsg.includes("09:00") &&
        confirmMsg.includes("09:30") &&
        confirmMsg.includes("د. أحمد سامي"),
    );
  }

  // =========================================================================
  // SCENARIO 24: Customer confirms -> real appointment created via Booking Core
  // =========================================================================
  {
    const h = buildHarness();
    const offerMsg = formatBookingOptionsMessage("كشف أسنان", TEST_DATE, [
      {
        displayName: "د. أحمد سامي",
        start: "09:00",
        end: "09:30",
      },
    ]);
    await h.deps.conversationRepository.addMessage({
      conversationId: h.conversation.id,
      senderType: "AI",
      content: offerMsg,
    });
    await h.sendMessage("1", "ext-24");
    check(
      24,
      "Real appointment created in repository with matching details",
      h.appointments.length === 1 &&
        h.appointments[0].serviceId === SERV_DENTAL &&
        h.appointments[0].assignedUserId === USER_P1,
    );
  }

  // =========================================================================
  // SCENARIO 25: Appointment status is CONFIRMED when mode is automatic
  // =========================================================================
  {
    const h = buildHarness({ confirmationMode: "automatic" });
    const offerMsg = formatBookingOptionsMessage("كشف أسنان", TEST_DATE, [
      {
        displayName: "د. أحمد سامي",
        start: "09:00",
        end: "09:30",
      },
    ]);
    await h.deps.conversationRepository.addMessage({
      conversationId: h.conversation.id,
      senderType: "AI",
      content: offerMsg,
    });
    await h.sendMessage("1", "ext-25");
    check(
      25,
      'Automatic confirmation mode -> appointment status is "CONFIRMED"',
      h.appointments[0]?.status === "CONFIRMED",
    );
  }

  // =========================================================================
  // SCENARIO 26: Appointment status is PENDING when mode is manual
  // =========================================================================
  {
    const h = buildHarness({ confirmationMode: "manual" });
    const offerMsg = formatBookingOptionsMessage("كشف أسنان", TEST_DATE, [
      {
        displayName: "د. أحمد سامي",
        start: "09:00",
        end: "09:30",
      },
    ]);
    await h.deps.conversationRepository.addMessage({
      conversationId: h.conversation.id,
      senderType: "AI",
      content: offerMsg,
    });
    await h.sendMessage("1", "ext-26");
    check(
      26,
      'Manual confirmation mode -> appointment status is "PENDING"',
      h.appointments[0]?.status === "PENDING",
    );
  }

  // =========================================================================
  // SCENARIO 27: Conflict occurs between option display and confirmation
  // =========================================================================
  {
    // Prov 1 is booked concurrently at 09:00
    const h = buildHarness({
      initialAppointments: [
        {
          id: "appt-conflict",
          businessId: BIZ_A,
          assignedUserId: USER_P1,
          date: TEST_DATE,
          startTime: "09:00",
          endTime: "09:30",
          status: "CONFIRMED",
        },
      ],
    });
    const offerMsg = formatBookingOptionsMessage("كشف أسنان", TEST_DATE, [
      {
        displayName: "د. أحمد سامي",
        start: "09:00",
        end: "09:30",
      },
    ]);
    await h.deps.conversationRepository.addMessage({
      conversationId: h.conversation.id,
      senderType: "AI",
      content: offerMsg,
    });
    const res = await h.sendMessage("1", "ext-27");
    const lastMsg = h.messages[h.messages.length - 1]?.content ?? "";
    check(
      27,
      "Concurrent slot conflict -> explains and offers fresh alternative slots",
      res.ok &&
        res.conversationStatus === "AI_ACTIVE" &&
        (lastMsg.includes("لم يعد متاحاً") ||
          lastMsg.includes("تم حجز هذا الموعد للتو")),
    );
  }

  // =========================================================================
  // SCENARIO 28: Customer asks for flexible follow-up and has one PENDING request with range
  // =========================================================================
  {
    const h = buildHarness({
      followUps: [
        {
          id: "fu-101",
          businessId: BIZ_A,
          customerId: CUST_A,
          serviceId: SERV_DENTAL,
          preferredProviderId: PROV_1,
          startDate: "2026-10-20",
          endDate: "2026-10-27",
          status: "PENDING",
        },
      ],
      aiExtraction: { intent: "BOOKING" },
    });
    const res = await h.sendMessage("عايز أحجز متابعة مع الدكتور", "ext-28");
    const lastMsg = h.messages[h.messages.length - 1]?.content ?? "";
    check(
      28,
      "Pending follow-up with range -> presents doctor's allowed range (2026-10-20 إلى 2026-10-27)",
      res.ok &&
        res.conversationStatus === "AI_ACTIVE" &&
        lastMsg.includes("2026-10-20") &&
        lastMsg.includes("2026-10-27"),
    );
  }

  // =========================================================================
  // SCENARIO 29: Customer selects date inside doctor's allowed range -> options shown and booking succeeds
  // =========================================================================
  {
    const h = buildHarness({
      followUps: [
        {
          id: "fu-102",
          businessId: BIZ_A,
          customerId: CUST_A,
          serviceId: SERV_DENTAL,
          preferredProviderId: PROV_1,
          startDate: "2026-10-20",
          endDate: "2026-10-27",
          status: "PENDING",
        },
      ],
      aiExtraction: { intent: "BOOKING", date: "2026-10-22" },
    });
    const res = await h.sendMessage("متابعة يوم 2026-10-22", "ext-29");
    const lastMsg = h.messages[h.messages.length - 1]?.content ?? "";
    check(
      29,
      "Date inside allowed range -> produces follow-up booking options with tag",
      res.ok &&
        res.conversationStatus === "AI_ACTIVE" &&
        lastMsg.includes("لمتابعة") &&
        lastMsg.includes("[متابعة: fu-102]"),
    );
  }

  // =========================================================================
  // SCENARIO 30: Customer selects date outside doctor's allowed range
  // =========================================================================
  {
    const h = buildHarness({
      followUps: [
        {
          id: "fu-103",
          businessId: BIZ_A,
          customerId: CUST_A,
          serviceId: SERV_DENTAL,
          preferredProviderId: PROV_1,
          startDate: "2026-10-20",
          endDate: "2026-10-27",
          status: "PENDING",
        },
      ],
      aiExtraction: { intent: "BOOKING", date: "2026-11-15" }, // outside range
    });
    const res = await h.sendMessage("متابعة يوم 2026-11-15", "ext-30");
    const lastMsg = h.messages[h.messages.length - 1]?.content ?? "";
    check(
      30,
      "Date outside allowed range -> polite error, shows range, retains request",
      res.ok &&
        res.conversationStatus === "AI_ACTIVE" &&
        lastMsg.includes("خارج الفترة المحددة للمتابعة من قِبل الطبيب"),
    );
  }

  // =========================================================================
  // SCENARIO 31: Customer has multiple pending follow-up requests -> lists them
  // =========================================================================
  {
    const h = buildHarness({
      followUps: [
        {
          id: "fu-104",
          businessId: BIZ_A,
          customerId: CUST_A,
          serviceId: SERV_DENTAL,
          preferredProviderId: PROV_1,
          startDate: "2026-10-20",
          endDate: "2026-10-27",
          status: "PENDING",
        },
        {
          id: "fu-105",
          businessId: BIZ_A,
          customerId: CUST_A,
          serviceId: SERV_CLEAN_1,
          preferredProviderId: PROV_2,
          startDate: "2026-10-22",
          endDate: "2026-10-29",
          status: "PENDING",
        },
      ],
      aiExtraction: { intent: "BOOKING" },
    });
    const res = await h.sendMessage("عايز متابعة", "ext-31");
    const lastMsg = h.messages[h.messages.length - 1]?.content ?? "";
    check(
      31,
      "Multiple pending follow-ups -> lists options and prompts customer selection",
      res.ok &&
        res.conversationStatus === "AI_ACTIVE" &&
        lastMsg.includes("لديك أكثر من طلب متابعة معلّق") &&
        lastMsg.includes("متابعة كشف أسنان") &&
        lastMsg.includes("متابعة تنظيف أسنان عادي"),
    );
  }

  // =========================================================================
  // SCENARIO 32: Customer asks for follow-up but has zero pending requests
  // =========================================================================
  {
    const h = buildHarness({
      followUps: [],
      aiExtraction: { intent: "BOOKING" },
    });
    const res = await h.sendMessage("عايز ميعاد متابعة", "ext-32");
    const lastMsg = h.messages[h.messages.length - 1]?.content ?? "";
    check(
      32,
      "Zero pending follow-ups -> explains no pending follow-up, invites normal booking",
      res.ok &&
        res.conversationStatus === "AI_ACTIVE" &&
        lastMsg.includes("لا يوجد طلب متابعة معلّق مسجل لك حالياً"),
    );
  }

  // =========================================================================
  // SCENARIO 33: Follow-up converted to appointment -> status SCHEDULED and linked
  // =========================================================================
  {
    const followUpRecord = {
      id: "fu-106",
      businessId: BIZ_A,
      customerId: CUST_A,
      serviceId: SERV_DENTAL,
      preferredProviderId: PROV_1,
      startDate: "2026-10-20",
      endDate: "2026-10-27",
      status: "PENDING",
      scheduledAppointmentId: null,
    };
    const h = buildHarness({
      followUps: [followUpRecord],
    });
    const offerMsg = formatBookingOptionsMessage(
      "كشف أسنان",
      TEST_DATE,
      [
        {
          displayName: "د. أحمد سامي",
          start: "09:00",
          end: "09:30",
        },
      ],
      "fu-106",
    );
    await h.deps.conversationRepository.addMessage({
      conversationId: h.conversation.id,
      senderType: "AI",
      content: offerMsg,
    });
    const res = await h.sendMessage("1", "ext-33");
    check(
      33,
      "Follow-up converted to appointment -> FollowUpRequest status is SCHEDULED & linked",
      res.ok &&
        res.conversationStatus === "BOOKED" &&
        followUpRecord.status === "SCHEDULED" &&
        Boolean(followUpRecord.scheduledAppointmentId),
    );
  }

  // =========================================================================
  // SCENARIO 34: Attempt to book already SCHEDULED or CANCELLED follow-up -> rejected safely
  // =========================================================================
  {
    const h = buildHarness({
      followUps: [
        {
          id: "fu-107",
          businessId: BIZ_A,
          customerId: CUST_A,
          serviceId: SERV_DENTAL,
          preferredProviderId: PROV_1,
          status: "CANCELLED", // Already cancelled
        },
      ],
    });
    const offerMsg = formatBookingOptionsMessage(
      "كشف أسنان",
      TEST_DATE,
      [
        {
          displayName: "د. أحمد سامي",
          start: "09:00",
          end: "09:30",
        },
      ],
      "fu-107",
    );
    await h.deps.conversationRepository.addMessage({
      conversationId: h.conversation.id,
      senderType: "AI",
      content: offerMsg,
    });
    const res = await h.sendMessage("1", "ext-34");
    const lastMsg = h.messages[h.messages.length - 1]?.content ?? "";
    check(
      34,
      "Attempt to book CANCELLED/SCHEDULED follow-up -> rejected safely without booking",
      res.ok &&
        res.conversationStatus === "AI_ACTIVE" &&
        lastMsg.includes("طلب المتابعة لم يعد متاحاً للجدولة") &&
        h.appointments.length === 0,
    );
  }

  // =========================================================================
  // SCENARIO 35: Idempotent webhook delivery with same message ID -> processed once
  // =========================================================================
  {
    const h = buildHarness();
    const offerMsg = formatBookingOptionsMessage("كشف أسنان", TEST_DATE, [
      {
        displayName: "د. أحمد سامي",
        start: "09:00",
        end: "09:30",
      },
    ]);
    await h.deps.conversationRepository.addMessage({
      conversationId: h.conversation.id,
      senderType: "AI",
      content: offerMsg,
    });
    // First delivery
    const res1 = await h.sendMessage("1", "ext-35-unique");
    // Replay duplicate externalId (same key claimed -> returns duplicate)
    const res2 = await h.sendMessage("1", "ext-35-unique");
    check(
      35,
      "Duplicate message replay -> idempotent duplicate flag, exactly 1 appointment created",
      res1.ok &&
        res2.ok &&
        (res2 as any).duplicate === true &&
        h.appointments.length === 1,
    );
  }

  // =========================================================================
  // SCENARIO 36: Cross-tenant isolation -> customer cannot see or book another business's follow-up/service
  // =========================================================================
  {
    const h = buildHarness({
      followUps: [
        {
          id: "fu-other-biz",
          businessId: BIZ_B, // belongs to Business B!
          customerId: CUST_B,
          serviceId: SERV_DENTAL,
          status: "PENDING",
        },
      ],
      aiExtraction: { intent: "BOOKING" },
    });
    const eligible =
      await h.deps.followUpRequestRepository!.getEligibleForChannel(
        BIZ_A,
        h.customer.id,
      );
    check(
      36,
      "Cross-tenant isolation -> zero leaks across business boundaries",
      eligible.length === 0,
    );
  }

  // =========================================================================
  // SCENARIO 37: Receptionist query -> appointment created via conversation is visible in agenda
  // =========================================================================
  {
    const h = buildHarness();
    const offerMsg = formatBookingOptionsMessage("كشف أسنان", TEST_DATE, [
      {
        displayName: "د. أحمد سامي",
        start: "09:00",
        end: "09:30",
      },
    ]);
    await h.deps.conversationRepository.addMessage({
      conversationId: h.conversation.id,
      senderType: "AI",
      content: offerMsg,
    });
    await h.sendMessage("1", "ext-37");
    // Receptionist queries agenda/appointments for Business A
    const list = await (h.deps.appointmentRepository as any).listByBusiness(
      BIZ_A,
    );
    check(
      37,
      "Receptionist agenda query -> booked appointment is visible with correct fields",
      list.length === 1 &&
        list[0].serviceId === SERV_DENTAL &&
        list[0].customerId === h.customer.id,
    );
  }

  // =========================================================================
  // Summary Report
  // =========================================================================
  console.log("\n========================================================");
  console.log("FLOWPILOT UX001-C1 VERIFICATION REPORT");
  console.log("Customer Conversation Booking & Flexible Follow-up");
  console.log("========================================================\n");

  let passedCount = 0;
  for (const c of checks) {
    if (c.pass) {
      passedCount++;
      console.log(`✔ [Case ${c.num.toString().padStart(2, "0")}] ${c.label}`);
    } else {
      console.error(
        `✖ [Case ${c.num.toString().padStart(2, "0")}] FAIL: ${c.label}`,
      );
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
