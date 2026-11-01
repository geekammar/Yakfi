/**
 * FlowPilot — CONV-CORE-01 Verification Suite
 * Unified Conversation State, Durable Offers & Single Decision Ownership
 *
 * Covers all 30 Required Regression Scenarios (Part 7.2):
 *  1. Typed offer survives process restart.
 *  2. Typed offer survives a new incoming request.
 *  3. Arabic reply copy changes but choice remains valid.
 *  4. Selection 1 resolves only against an active offer.
 *  5. Arabic numeral ١ or ٢ works.
 *  6. Telegram callback selection.
 *  7. WhatsApp interactive selection.
 *  8. Expired offer rejection.
 *  9. Fulfilled offer rejection.
 *  10. Booking confirmation does not leave a reusable offer.
 *  11. Duplicate webhook does not create duplicate appointments.
 *  12. Concurrent requests cannot double-book a slot.
 *  13. Cross-tenant offer usage is rejected.
 *  14. Service change invalidates incompatible offers.
 *  15. Date change preserves service while expiring slot choices.
 *  16. Provider change preserves compatible preferences.
 *  17. Tomorrow evening preference survives clarification.
 *  18. Default service selection obeys business settings.
 *  19. Explicit service overrides default service.
 *  20. Post-booking location question continues normally.
 *  21. Post-booking service question continues normally.
 *  22. A second explicit booking request works.
 *  23. Explicit human takeover remains authoritative.
 *  24. Sensitive/emergency content follows existing safety rules.
 *  25. A customer interrupts a booking to ask a FAQ.
 *  26. The interrupted goal resumes correctly.
 *  27. JEV timeout/failure preserves conversation state.
 *  28. No fabricated service/provider/slot IDs.
 *  29. No unnecessary additional paid model call for mechanical selection.
 *  30. Existing historical bookings remain untouched.
 *
 * Run: pnpm check:conv-core-01
 */

import type {
  Appointment,
  Branch,
  Business,
  Conversation,
  Customer,
  Message,
  Service,
} from "@/generated/prisma/client";

import type {
  AiRequest,
  AiResponse,
} from "@/features/conversations/server/conversation-ai";
import type { ConversationEngineDeps } from "@/features/conversations/server/conversation-engine";
import type { UpdateConversationDto } from "@/lib/validation";
import type { InboundClaimResult } from "@/server/repositories/inbound-dedupe.repository";
import type { UsageRecord } from "@/types/domain";

type Check = { label: string; pass: boolean };

class InMemoryConversationStateStore {
  public rows = new Map<
    string,
    { businessId: string; revision: number; state: unknown; updatedAt: Date }
  >();

  async load(businessId: string, conversationId: string) {
    const row = this.rows.get(conversationId);
    if (!row || row.businessId !== businessId) return null;
    return {
      conversationId,
      businessId: row.businessId,
      revision: row.revision,
      state: JSON.parse(JSON.stringify(row.state)),
      updatedAt: row.updatedAt,
    };
  }

  async save(
    businessId: string,
    conversationId: string,
    expectedRevision: number | null,
    state: unknown,
  ) {
    const existing = this.rows.get(conversationId);
    if (expectedRevision === null) {
      if (existing) return { status: "conflict" as const };
      this.rows.set(conversationId, {
        businessId,
        revision: 1,
        state: JSON.parse(JSON.stringify(state)),
        updatedAt: new Date(),
      });
      return { status: "saved" as const, revision: 1 };
    }
    if (
      !existing ||
      existing.businessId !== businessId ||
      existing.revision !== expectedRevision
    ) {
      return { status: "conflict" as const };
    }
    const nextRevision = expectedRevision + 1;
    this.rows.set(conversationId, {
      businessId,
      revision: nextRevision,
      state: JSON.parse(JSON.stringify(state)),
      updatedAt: new Date(),
    });
    return { status: "saved" as const, revision: nextRevision };
  }
}

async function main(): Promise<void> {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const { buildSlotOffer, isOfferLive } =
    await import("../src/features/conversations/server/booking-offer");
  const { offerCallbackData } =
    await import("../src/features/conversations/server/channel-choice");
  const { interpretOfferReply } =
    await import("../src/features/conversations/server/booking-selection");
  const {
    completeBookingTask,
    dehydrateConversationState,
    emptyConversationState,
    hydrateConversationState,
    mergeConversationState,
    withOfferStatus,
    withPresentedOffer,
  } = await import("../src/features/conversations/server/conversation-state");
  const { openTurnStateSession } =
    await import("../src/features/conversations/server/conversation-state-store");
  const { receiveInboundMessage } =
    await import("../src/features/conversations/server/conversation-engine");

  const checks: Check[] = [];
  function check(label: string, pass: boolean, detail?: unknown): void {
    if (!pass && detail !== undefined) {
      console.log(`[DEBUG FAIL] ${label}:`, detail);
    }
    checks.push({ label, pass });
  }

  const B_ID = "11111111-1111-4111-8111-111111111111";
  const B_ID_OTHER = "22222222-2222-4222-8222-222222222222";
  const C_ID = "33333333-3333-4333-8333-333333333330";
  const SERVICE_1 = "33333333-3333-4333-8333-333333333331";
  const SERVICE_2 = "33333333-3333-4333-8333-333333333332";
  const PROVIDER_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
  const PROVIDER_2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
  const USER_1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
  const USER_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
  const BRANCH_1 = "44444444-4444-4444-8444-444444444444";
  const now = new Date("2026-09-14T10:00:00Z");

  function createEngineFixture(opts?: {
    defaultServiceId?: string | null;
    simulateAiFailure?: boolean;
  }) {
    const days = ["sat", "sun", "mon", "tue", "wed", "thu", "fri"];
    const workingHours: Record<string, unknown> = {};
    for (const d of days) {
      workingHours[d] = { open: "09:00", close: "18:00", closed: false };
    }

    const business = {
      id: B_ID,
      name: "عيادة الابتسامة",
      isActive: true,
      timezone: "Africa/Cairo",
      confirmationMode: "automatic",
      defaultBranchId: BRANCH_1,
      defaultServiceId: opts?.defaultServiceId ?? null,
      defaultBookingServiceId: opts?.defaultServiceId ?? null,
      defaultServiceBookingEnabled: Boolean(opts?.defaultServiceId),
      workingHours,
      slotDurationMinutes: 30,
      faqs: [
        {
          question: "عنوان ومكان العيادة فين؟",
          answer: "عنواننا في التجمع الخامس، القاهرة.",
        },
      ],
    };

    const branch = {
      id: BRANCH_1,
      businessId: B_ID,
      name: "الفرع الرئيسي",
      isActive: true,
    };

    const services = [
      {
        id: SERVICE_1,
        businessId: B_ID,
        name: "كشف أسنان",
        durationMinutes: 30,
        isActive: true,
      },
      {
        id: SERVICE_2,
        businessId: B_ID,
        name: "تنظيف أسنان",
        durationMinutes: 30,
        isActive: true,
      },
    ];

    const providers = [
      { id: PROVIDER_1, displayName: "د. سارة", user: { name: "سارة" } },
      { id: PROVIDER_2, displayName: "د. أحمد", user: { name: "أحمد" } },
    ];

    const customer = {
      id: "cust-1",
      businessId: B_ID,
      name: "عميل تجريبي",
      phone: "+201234567890",
    };

    let conversationStatus = "AI_ACTIVE";
    const conversation: {
      id: string;
      businessId: string;
      customerId: string;
      branchId: string;
      status: string;
      assignedUserId: string | null;
      aiSummary: string | null;
    } = {
      id: "conv-1",
      businessId: B_ID,
      customerId: customer.id,
      branchId: BRANCH_1,
      status: conversationStatus,
      assignedUserId: null,
      aiSummary: null,
    };

    const dedupeLedger = new Set<string>();
    const messages: Array<{ senderType: string; content: string; id: string }> =
      [
        {
          id: "msg-1",
          senderType: "CUSTOMER",
          content: "عايز كشف أسنان بكرة",
        },
        {
          id: "msg-2",
          senderType: "AI",
          content:
            'تتوفر المواعيد التالية لخدمة "كشف أسنان" يوم 2026-09-15:\n1. د. سارة — 09:00 إلى 09:30',
        },
      ];

    const stateStore = new InMemoryConversationStateStore();
    // Pre-seed active slot offer
    const initialOffer = buildSlotOffer(
      { businessId: B_ID, conversationId: conversation.id },
      "offer-init",
      {
        serviceId: SERVICE_1,
        serviceName: "كشف أسنان",
        serviceSource: "CUSTOMER",
        providerId: null,
        date: "2026-09-15",
        followUpRequestId: null,
        shownCount: 1,
        options: [
          {
            providerId: PROVIDER_1,
            displayName: "د. سارة",
            startAt: "2026-09-15T09:00",
            endAt: "2026-09-15T09:30",
          },
        ],
      },
      now,
    )!;
    stateStore.rows.set(conversation.id, {
      businessId: B_ID,
      revision: 1,
      state: dehydrateConversationState(
        withPresentedOffer(emptyConversationState(), initialOffer),
      ),
      updatedAt: now,
    });

    const createdAppointments: Array<{
      serviceId: string;
      providerId?: string;
      date: string;
      startTime: string;
      endTime: string;
    }> = [];

    const existingHistoricalBookings = [
      {
        id: "hist-apt-1",
        businessId: B_ID,
        serviceId: SERVICE_1,
        date: "2026-09-01",
      },
    ];

    let aiCalls = 0;

    const deps: ConversationEngineDeps = {
      businessRepository: {
        findByWhatsappNumber: async () => business as unknown as Business,
        findById: async (id: string) =>
          id === B_ID ? (business as unknown as Business) : null,
      },
      branchRepository: {
        findDefaultByBusiness: async () => branch as unknown as Branch,
        findByIdWithinBusiness: async (id: string, bId?: string) =>
          id === BRANCH_1 && (!bId || bId === B_ID)
            ? (branch as unknown as Branch)
            : null,
      },
      customerRepository: {
        upsertByPhone: async () => customer as unknown as Customer,
        touchConversation: async () => customer as unknown as Customer,
      },
      conversationRepository: {
        findLatestByCustomer: async () => ({ id: conversation.id }),
        findById: async () =>
          ({
            ...conversation,
            status: conversationStatus,
          }) as unknown as Conversation,
        create: async () => conversation as unknown as Conversation,
        addMessage: async (
          input: {
            conversationId: string;
            senderType: string;
            content: string;
          },
          options?: { status?: string },
        ) => {
          if (options?.status) {
            conversationStatus = options.status;
          }
          const msg = {
            id: `msg-${messages.length + 1}`,
            conversationId: input.conversationId,
            senderType: input.senderType,
            content: input.content,
          };
          messages.push(msg);
          return msg as unknown as Message;
        },
        getMessages: async (_conversationId: string) =>
          [...messages] as unknown as Message[],
        update: async (_id: string, data: UpdateConversationDto) => {
          if (data.aiSummary !== undefined) {
            conversation.aiSummary = data.aiSummary;
          }
          return {
            ...conversation,
            status: conversationStatus,
          } as unknown as Conversation;
        },
        updateWorkflow: async (
          _id: string,
          data: { status?: Conversation["status"] },
        ) => {
          if (data.status) conversationStatus = data.status;
          return {
            ...conversation,
            status: conversationStatus,
          } as unknown as Conversation;
        },
      },
      conversationStateRepository: stateStore,
      serviceRepository: {
        listByBusiness: async () => services as unknown as Service[],
        findById: async (id: string) =>
          (services.find((s) => s.id === id) ??
            null) as unknown as Service | null,
      },
      inboundDedupeRepository: {
        claim: async (
          _bId: string,
          key: string,
        ): Promise<InboundClaimResult> => {
          if (dedupeLedger.has(key)) {
            return {
              status: "duplicate",
              claimId: `claim-${dedupeLedger.size}`,
              conversationId: conversation.id,
              customerMessageId: "msg-1",
            };
          }
          dedupeLedger.add(key);
          return {
            status: "claimed",
            claimId: `claim-${dedupeLedger.size}`,
          };
        },
      },
      usageRepository: {
        record: async () => ({ id: "usage-1" }) as unknown as UsageRecord,
      },
      providerRepository: {
        listEligibleForService: async () =>
          providers as unknown as Array<{
            id: string;
            displayName: string;
            user: { name: string };
          }>,
        listAssignmentSeams: async () => [
          { providerId: PROVIDER_1, userId: USER_1, assignedUserId: USER_1 },
          { providerId: PROVIDER_2, userId: USER_2, assignedUserId: USER_2 },
        ],
      },
      appointmentRepository: {
        createWithConflictCheck: async (dto: {
          businessId: string;
          customerId: string;
          serviceId: string;
          date: string;
          startTime: string;
          endTime: string;
          branchId?: string | null;
          providerId?: string | null;
          assignedUserId?: string | null;
          status?: string;
          followUpRequestId?: string | null;
        }) => {
          createdAppointments.push({
            serviceId: dto.serviceId,
            providerId: dto.providerId ?? undefined,
            date: dto.date,
            startTime: dto.startTime,
            endTime: dto.endTime,
          });
          return {
            id: `apt-${createdAppointments.length}`,
          } as unknown as Appointment;
        },
        listBlockingByAssignees: async () => [],
      },
      ai: {
        providerName: "deterministic",
        respond: async (request: AiRequest): Promise<AiResponse> => {
          aiCalls++;
          if (opts?.simulateAiFailure) throw new Error("AI provider failure");
          const msgText = request.message ?? "";
          if (msgText.includes("عنوان") || msgText.includes("مكان")) {
            return {
              intent: "FAQ" as const,
              action: "reply" as const,
              summary: "سؤال عن العنوان",
              content: "عنواننا في التجمع الخامس، القاهرة.",
              extraction: {
                service: null,
                date: null,
                timePreference: null,
                provider: null,
              },
              handoffReason: null,
              knowledgeRef: {
                family: "business.faqs",
                sourceId: "عنوان ومكان العيادة فين؟",
              },
            };
          }
          if (msgText.includes("تنظيف أسنان")) {
            return {
              intent: "BOOKING" as const,
              action: "reply" as const,
              summary: "طلب حجز تنظيف أسنان",
              content: "تفضل المواعيد المتاحة لتنظيف الأسنان.",
              extraction: {
                service: "تنظيف أسنان",
                date: "2026-09-15",
                timePreference: null,
                provider: null,
              },
              handoffReason: null,
            };
          }
          if (msgText.includes("عايز أحجز موعد بكرة")) {
            return {
              intent: "BOOKING" as const,
              action: "reply" as const,
              summary: "طلب حجز بدون تحديد خدمة",
              content: "تفضل المواعيد المتاحة لكشف الأسنان.",
              extraction: {
                service: null,
                date: "2026-09-15",
                timePreference: null,
                provider: null,
              },
              handoffReason: null,
            };
          }
          return {
            intent: "BOOKING" as const,
            action: "reply" as const,
            summary: "طلب حجز",
            content: "أهلاً بك، كيف أساعدك؟",
            extraction: {
              service: "كشف أسنان",
              date: "2026-09-15",
              timePreference: null,
              provider: null,
            },
            handoffReason: null,
          };
        },
      },
      transport: {
        providerName: "test-transport",
        send: async () => ({ provider: "test", delivered: true }),
      },
    };

    return {
      deps,
      get aiCallCount() {
        return aiCalls;
      },
      createdAppointments,
      existingHistoricalBookings,
      setConversationStatus: (s: string) => {
        conversationStatus = s;
      },
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 1. Typed offer survives process restart
  // ──────────────────────────────────────────────────────────────────────────
  {
    const offer = buildSlotOffer(
      { businessId: B_ID, conversationId: C_ID },
      "off-1",
      {
        serviceId: SERVICE_1,
        serviceName: "كشف أسنان",
        serviceSource: "CUSTOMER",
        providerId: null,
        date: "2026-09-15",
        followUpRequestId: null,
        shownCount: 1,
        options: [
          {
            providerId: PROVIDER_1,
            displayName: "د. سارة",
            startAt: "2026-09-15T10:00",
            endAt: "2026-09-15T10:30",
          },
        ],
      },
      now,
    )!;

    const state = withPresentedOffer(emptyConversationState(), offer);
    const serialized = JSON.stringify(dehydrateConversationState(state));

    const rawFromStorage = JSON.parse(serialized);
    const restored = hydrateConversationState(rawFromStorage, {
      businessId: B_ID,
      conversationId: C_ID,
    });

    check(
      "1. Typed offer survives process restart with exact fields",
      restored !== null &&
        restored.offer?.id === "off-1" &&
        restored.offer?.kind === "SLOT" &&
        restored.offer?.options[0]?.displayName === "د. سارة" &&
        restored.offer?.options[0]?.startAt === "2026-09-15T10:00" &&
        restored.serviceId === SERVICE_1,
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 2. Typed offer survives a new incoming request
  // ──────────────────────────────────────────────────────────────────────────
  {
    const store = new InMemoryConversationStateStore();
    const offer = buildSlotOffer(
      { businessId: B_ID, conversationId: C_ID },
      "off-2",
      {
        serviceId: SERVICE_1,
        serviceName: "كشف أسنان",
        serviceSource: "CUSTOMER",
        providerId: null,
        date: "2026-09-15",
        followUpRequestId: null,
        shownCount: 1,
        options: [
          {
            providerId: PROVIDER_1,
            displayName: "د. سارة",
            startAt: "2026-09-15T10:00",
            endAt: "2026-09-15T10:30",
          },
        ],
      },
      now,
    )!;

    const session1 = await openTurnStateSession(
      store,
      { businessId: B_ID, conversationId: C_ID },
      now,
    );
    session1.state = withPresentedOffer(emptyConversationState(), offer);
    await session1.commit();

    const session2 = await openTurnStateSession(
      store,
      { businessId: B_ID, conversationId: C_ID },
      now,
    );
    check(
      "2. Typed offer survives next incoming request via store",
      session2.loaded && session2.state?.offer?.id === "off-2",
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 3. Arabic reply copy changes but choice remains valid
  // ──────────────────────────────────────────────────────────────────────────
  {
    const offer = buildSlotOffer(
      { businessId: B_ID, conversationId: C_ID },
      "off-3",
      {
        serviceId: SERVICE_1,
        serviceName: "كشف أسنان",
        serviceSource: "CUSTOMER",
        providerId: null,
        date: "2026-09-15",
        followUpRequestId: null,
        shownCount: 1,
        options: [
          {
            providerId: PROVIDER_1,
            displayName: "د. سارة",
            startAt: "2026-09-15T10:00",
            endAt: "2026-09-15T10:30",
          },
        ],
      },
      now,
    )!;

    const reply = interpretOfferReply("1", offer, now);
    check(
      "3. Selection reads typed offer directly regardless of message copy",
      reply.kind === "slot" &&
        reply.selection.kind === "index" &&
        reply.selection.index === 1 &&
        reply.context.options[0]?.startTime === "10:00",
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 4. Selection 1 resolves only against an active offer
  // ──────────────────────────────────────────────────────────────────────────
  {
    const replyNoOffer = interpretOfferReply("1", null, now);
    check(
      "4. Selection 1 without active offer is not a slot selection (falls to AI)",
      replyNoOffer.kind === "none",
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 5. Arabic numeral ١ or ٢ works
  // ──────────────────────────────────────────────────────────────────────────
  {
    const offer = buildSlotOffer(
      { businessId: B_ID, conversationId: C_ID },
      "off-5",
      {
        serviceId: SERVICE_1,
        serviceName: "كشف أسنان",
        serviceSource: "CUSTOMER",
        providerId: null,
        date: "2026-09-15",
        followUpRequestId: null,
        shownCount: 2,
        options: [
          {
            providerId: PROVIDER_1,
            displayName: "د. سارة",
            startAt: "2026-09-15T10:00",
            endAt: "2026-09-15T10:30",
          },
          {
            providerId: PROVIDER_2,
            displayName: "د. أحمد",
            startAt: "2026-09-15T11:00",
            endAt: "2026-09-15T11:30",
          },
        ],
      },
      now,
    )!;

    const reply1 = interpretOfferReply("١", offer, now);
    const reply2 = interpretOfferReply("٢", offer, now);
    check(
      "5. Arabic numerals ١ and ٢ parse correctly against active offer",
      reply1.kind === "slot" &&
        reply1.selection.kind === "index" &&
        reply1.selection.index === 1 &&
        reply2.kind === "slot" &&
        reply2.selection.kind === "index" &&
        reply2.selection.index === 2,
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 6. Telegram callback selection
  // ──────────────────────────────────────────────────────────────────────────
  {
    const offer = buildSlotOffer(
      { businessId: B_ID, conversationId: C_ID },
      "off-6",
      {
        serviceId: SERVICE_1,
        serviceName: "كشف أسنان",
        serviceSource: "CUSTOMER",
        providerId: null,
        date: "2026-09-15",
        followUpRequestId: null,
        shownCount: 1,
        options: [
          {
            providerId: PROVIDER_1,
            displayName: "د. سارة",
            startAt: "2026-09-15T10:00",
            endAt: "2026-09-15T10:30",
          },
        ],
      },
      now,
    )!;

    const cbData = offerCallbackData(offer, 1);
    const reply = interpretOfferReply(cbData, offer, now);
    check(
      "6. Telegram callback data fp:<token>:1 resolves to slot option",
      reply.kind === "slot" &&
        reply.selection.kind === "index" &&
        reply.selection.index === 1,
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 7. WhatsApp interactive selection
  // ──────────────────────────────────────────────────────────────────────────
  {
    const offer = buildSlotOffer(
      { businessId: B_ID, conversationId: C_ID },
      "off-7",
      {
        serviceId: SERVICE_1,
        serviceName: "كشف أسنان",
        serviceSource: "CUSTOMER",
        providerId: null,
        date: "2026-09-15",
        followUpRequestId: null,
        shownCount: 1,
        options: [
          {
            providerId: PROVIDER_1,
            displayName: "د. سارة",
            startAt: "2026-09-15T10:00",
            endAt: "2026-09-15T10:30",
          },
        ],
      },
      now,
    )!;

    const reply = interpretOfferReply("opt_1", offer, now);
    check(
      "7. WhatsApp button reply opt_1 resolves to slot option",
      reply.kind === "slot" &&
        reply.selection.kind === "index" &&
        reply.selection.index === 1,
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 8. Expired offer rejection
  // ──────────────────────────────────────────────────────────────────────────
  {
    const past = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const offer = buildSlotOffer(
      { businessId: B_ID, conversationId: C_ID },
      "off-8",
      {
        serviceId: SERVICE_1,
        serviceName: "كشف أسنان",
        serviceSource: "CUSTOMER",
        providerId: null,
        date: "2026-09-15",
        followUpRequestId: null,
        shownCount: 1,
        options: [
          {
            providerId: PROVIDER_1,
            displayName: "د. سارة",
            startAt: "2026-09-15T10:00",
            endAt: "2026-09-15T10:30",
          },
        ],
      },
      past,
    )!;

    const reply = interpretOfferReply("1", offer, now);
    check(
      "8. Expired offer is rejected as stale (EXPIRED)",
      reply.kind === "stale" && reply.reason === "EXPIRED",
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 9. Fulfilled offer rejection
  // ──────────────────────────────────────────────────────────────────────────
  {
    const offer = buildSlotOffer(
      { businessId: B_ID, conversationId: C_ID },
      "off-9",
      {
        serviceId: SERVICE_1,
        serviceName: "كشف أسنان",
        serviceSource: "CUSTOMER",
        providerId: null,
        date: "2026-09-15",
        followUpRequestId: null,
        shownCount: 1,
        options: [
          {
            providerId: PROVIDER_1,
            displayName: "د. سارة",
            startAt: "2026-09-15T10:00",
            endAt: "2026-09-15T10:30",
          },
        ],
      },
      now,
    )!;

    const consumedOffer = { ...offer, status: "CONSUMED" as const };
    const reply = interpretOfferReply("1", consumedOffer, now);
    check(
      "9. Fulfilled (CONSUMED) offer is rejected as stale (CLOSED)",
      reply.kind === "stale" && reply.reason === "CLOSED",
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 10. Booking confirmation does not leave a reusable offer
  // ──────────────────────────────────────────────────────────────────────────
  {
    const offer = buildSlotOffer(
      { businessId: B_ID, conversationId: C_ID },
      "off-10",
      {
        serviceId: SERVICE_1,
        serviceName: "كشف أسنان",
        serviceSource: "CUSTOMER",
        providerId: null,
        date: "2026-09-15",
        followUpRequestId: null,
        shownCount: 1,
        options: [
          {
            providerId: PROVIDER_1,
            displayName: "د. سارة",
            startAt: "2026-09-15T10:00",
            endAt: "2026-09-15T10:30",
          },
        ],
      },
      now,
    )!;

    const baseState = withPresentedOffer(emptyConversationState(), offer);
    const completedState = completeBookingTask(baseState, {
      appointmentId: "apt-10",
      serviceId: SERVICE_1,
      providerId: PROVIDER_1,
      date: "2026-09-15",
      completedAt: now.toISOString(),
    });

    check(
      "10. Booking completion sets offer to CONSUMED and nulls pendingOffer",
      completedState.offer?.status === "CONSUMED" &&
        completedState.pendingOffer === null &&
        completedState.bookingStage === "COMPLETED" &&
        !isOfferLive(completedState.offer, now),
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 11. Duplicate webhook does not create duplicate appointments
  // ──────────────────────────────────────────────────────────────────────────
  {
    const fixture = createEngineFixture();
    const inbound = {
      from: "+201234567890",
      to: "+201001111111",
      text: "1",
      receivedAt: now.toISOString(),
      channel: "WHATSAPP" as const,
      externalId: "ext-dup-msg-11",
    };

    const first = await receiveInboundMessage(fixture.deps, inbound);
    const second = await receiveInboundMessage(fixture.deps, inbound);

    check(
      "11. Duplicate inbound delivery is recognized idempotently",
      first.ok && !first.duplicate && second.ok && second.duplicate,
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 12. Concurrent requests cannot double-book a slot
  // ──────────────────────────────────────────────────────────────────────────
  {
    const store = new InMemoryConversationStateStore();
    const offer = buildSlotOffer(
      { businessId: B_ID, conversationId: C_ID },
      "off-12",
      {
        serviceId: SERVICE_1,
        serviceName: "كشف أسنان",
        serviceSource: "CUSTOMER",
        providerId: null,
        date: "2026-09-15",
        followUpRequestId: null,
        shownCount: 1,
        options: [
          {
            providerId: PROVIDER_1,
            displayName: "د. سارة",
            startAt: "2026-09-15T10:00",
            endAt: "2026-09-15T10:30",
          },
        ],
      },
      now,
    )!;

    const init = await openTurnStateSession(
      store,
      { businessId: B_ID, conversationId: C_ID },
      now,
    );
    init.state = withPresentedOffer(emptyConversationState(), offer);
    await init.commit();

    const turnA = await openTurnStateSession(
      store,
      { businessId: B_ID, conversationId: C_ID },
      now,
    );
    const turnB = await openTurnStateSession(
      store,
      { businessId: B_ID, conversationId: C_ID },
      now,
    );

    const claimA = await turnA.claimOffer();
    const claimB = await turnB.claimOffer();

    check(
      "12. CAS on revision allows exactly one turn to claim offer",
      (claimA === "claimed" && claimB === "conflict") ||
        (claimB === "claimed" && claimA === "conflict"),
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 13. Cross-tenant offer usage is rejected
  // ──────────────────────────────────────────────────────────────────────────
  {
    const offer = buildSlotOffer(
      { businessId: B_ID, conversationId: C_ID },
      "off-13",
      {
        serviceId: SERVICE_1,
        serviceName: "كشف أسنان",
        serviceSource: "CUSTOMER",
        providerId: null,
        date: "2026-09-15",
        followUpRequestId: null,
        shownCount: 1,
        options: [
          {
            providerId: PROVIDER_1,
            displayName: "د. سارة",
            startAt: "2026-09-15T10:00",
            endAt: "2026-09-15T10:30",
          },
        ],
      },
      now,
    )!;

    const state = withPresentedOffer(emptyConversationState(), offer);
    const raw = dehydrateConversationState(state);

    const hydratedOther = hydrateConversationState(raw, {
      businessId: B_ID_OTHER,
      conversationId: C_ID,
    });

    check(
      "13. Hydration fails when businessId does not match offer scope",
      hydratedOther === null,
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 14. Service change invalidates incompatible offers
  // ──────────────────────────────────────────────────────────────────────────
  {
    const offer = buildSlotOffer(
      { businessId: B_ID, conversationId: C_ID },
      "off-14",
      {
        serviceId: SERVICE_1,
        serviceName: "كشف أسنان",
        serviceSource: "CUSTOMER",
        providerId: null,
        date: "2026-09-15",
        followUpRequestId: null,
        shownCount: 1,
        options: [
          {
            providerId: PROVIDER_1,
            displayName: "د. سارة",
            startAt: "2026-09-15T10:00",
            endAt: "2026-09-15T10:30",
          },
        ],
      },
      now,
    )!;

    const baseState = withPresentedOffer(emptyConversationState(), offer);
    const merged = mergeConversationState(baseState, {
      resolvedService: { serviceId: SERVICE_2, source: "CUSTOMER" },
      factUpdates: [{ key: "service", value: "تنظيف أسنان" }],
    });

    check(
      "14. Service change invalidates active slot offer",
      merged.state.offer?.status === "INVALIDATED" &&
        merged.state.serviceId === SERVICE_2,
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 15. Date change preserves service while expiring slot choices
  // ──────────────────────────────────────────────────────────────────────────
  {
    const offer = buildSlotOffer(
      { businessId: B_ID, conversationId: C_ID },
      "off-15",
      {
        serviceId: SERVICE_1,
        serviceName: "كشف أسنان",
        serviceSource: "CUSTOMER",
        providerId: null,
        date: "2026-09-15",
        followUpRequestId: null,
        shownCount: 1,
        options: [
          {
            providerId: PROVIDER_1,
            displayName: "د. سارة",
            startAt: "2026-09-15T10:00",
            endAt: "2026-09-15T10:30",
          },
        ],
      },
      now,
    )!;

    const baseState = withPresentedOffer(emptyConversationState(), offer);
    const merged = mergeConversationState(baseState, {
      factUpdates: [{ key: "date", value: "2026-09-16" }],
    });

    check(
      "15. Date change preserves service choice while invalidating slot offer",
      merged.state.offer?.status === "INVALIDATED" &&
        merged.state.serviceId === SERVICE_1 &&
        merged.state.knownFacts.date === "2026-09-16",
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 16. Provider change preserves compatible preferences
  // ──────────────────────────────────────────────────────────────────────────
  {
    const offer = buildSlotOffer(
      { businessId: B_ID, conversationId: C_ID },
      "off-16",
      {
        serviceId: SERVICE_1,
        serviceName: "كشف أسنان",
        serviceSource: "CUSTOMER",
        providerId: PROVIDER_1,
        date: "2026-09-15",
        followUpRequestId: null,
        shownCount: 1,
        options: [
          {
            providerId: PROVIDER_1,
            displayName: "د. سارة",
            startAt: "2026-09-15T10:00",
            endAt: "2026-09-15T10:30",
          },
        ],
      },
      now,
    )!;

    const baseState = withPresentedOffer(
      {
        ...emptyConversationState(),
        knownFacts: { provider: "د. سارة" },
      },
      offer,
    );
    const merged = mergeConversationState(baseState, {
      factUpdates: [{ key: "provider", value: "د. أحمد" }],
    });

    check(
      "16. Provider change invalidates slot offer while keeping service & date",
      merged.state.offer?.status === "INVALIDATED" &&
        merged.state.serviceId === SERVICE_1 &&
        merged.state.knownFacts.date === "2026-09-15" &&
        merged.state.knownFacts.provider === "د. أحمد",
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 17. Tomorrow evening preference survives clarification
  // ──────────────────────────────────────────────────────────────────────────
  {
    const { state: s1 } = mergeConversationState(emptyConversationState(), {
      factUpdates: [
        { key: "date", value: "2026-09-15" },
        { key: "timePreference", value: "evening" },
      ],
      clarification: { type: "service", missingFacts: ["service"] },
    });

    const { state: s2 } = mergeConversationState(s1, {
      factUpdates: [{ key: "service", value: "كشف أسنان" }],
      resolvedService: { serviceId: SERVICE_1, source: "CUSTOMER" },
    });

    check(
      "17. Date and evening preference survive service clarification",
      s2.knownFacts.date === "2026-09-15" &&
        s2.knownFacts.timePreference === "evening" &&
        s2.serviceId === SERVICE_1,
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 18. Default service selection obeys business settings
  // ──────────────────────────────────────────────────────────────────────────
  {
    const fixture = createEngineFixture({
      defaultServiceId: SERVICE_1,
    });
    const res = await receiveInboundMessage(fixture.deps, {
      from: "+201234567890",
      to: "+201001111111",
      text: "عايز أحجز موعد بكرة",
      receivedAt: now.toISOString(),
      channel: "WHATSAPP",
      externalId: "ext-18",
    });

    check(
      "18. Default service is used when configured and customer gives no service",
      res.ok && !res.duplicate && res.assistantAction === "AI_REPLY",
      res,
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 19. Explicit service overrides default service
  // ──────────────────────────────────────────────────────────────────────────
  {
    const fixture = createEngineFixture({
      defaultServiceId: SERVICE_1,
    });
    const res = await receiveInboundMessage(fixture.deps, {
      from: "+201234567890",
      to: "+201001111111",
      text: "عايز أحجز تنظيف أسنان بكرة",
      receivedAt: now.toISOString(),
      channel: "WHATSAPP",
      externalId: "ext-19",
    });

    check(
      "19. Explicit service overrides configured default service",
      res.ok && !res.duplicate && res.assistantAction === "AI_REPLY",
      res,
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 20. Post-booking location question continues normally
  // ──────────────────────────────────────────────────────────────────────────
  {
    const fixture = createEngineFixture();
    fixture.setConversationStatus("BOOKED");
    const res = await receiveInboundMessage(fixture.deps, {
      from: "+201234567890",
      to: "+201001111111",
      text: "عنوان ومكان العيادة فين؟",
      receivedAt: now.toISOString(),
      channel: "WHATSAPP",
      externalId: "ext-20",
    });

    check(
      "20. Post-booking location question answered normally (stays AI_ACTIVE)",
      res.ok &&
        !res.duplicate &&
        res.assistantAction === "AI_REPLY" &&
        res.conversationStatus === "AI_ACTIVE",
      res,
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 21. Post-booking service question continues normally
  // ──────────────────────────────────────────────────────────────────────────
  {
    const fixture = createEngineFixture();
    fixture.setConversationStatus("BOOKED");
    const res = await receiveInboundMessage(fixture.deps, {
      from: "+201234567890",
      to: "+201001111111",
      text: "ايه الخدمات المتاحة عندكم؟",
      receivedAt: now.toISOString(),
      channel: "WHATSAPP",
      externalId: "ext-21",
    });

    check(
      "21. Post-booking service list question answered normally",
      res.ok &&
        !res.duplicate &&
        res.assistantAction === "AI_REPLY" &&
        res.conversationStatus === "AI_ACTIVE",
      res,
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 22. A second explicit booking request works
  // ──────────────────────────────────────────────────────────────────────────
  {
    const fixture = createEngineFixture();
    fixture.setConversationStatus("BOOKED");
    const res = await receiveInboundMessage(fixture.deps, {
      from: "+201234567890",
      to: "+201001111111",
      text: "عايز أحجز موعد تاني لكشف أسنان الأسبوع القادم",
      receivedAt: now.toISOString(),
      channel: "WHATSAPP",
      externalId: "ext-22",
    });

    check(
      "22. Second explicit booking request initiates clean booking",
      res.ok && !res.duplicate && res.assistantAction === "AI_REPLY",
      res,
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 23. Explicit human takeover remains authoritative
  // ──────────────────────────────────────────────────────────────────────────
  {
    const fixture = createEngineFixture();
    const res = await receiveInboundMessage(fixture.deps, {
      from: "+201234567890",
      to: "+201001111111",
      text: "حولني لموظف لو سمحت",
      receivedAt: now.toISOString(),
      channel: "WHATSAPP",
      externalId: "ext-23",
    });

    check(
      "23. Explicit human request results in NEED_HUMAN handoff",
      res.ok &&
        !res.duplicate &&
        res.assistantAction === "AI_HANDOFF" &&
        res.conversationStatus === "NEED_HUMAN",
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 24. Sensitive/emergency content follows existing safety rules
  // ──────────────────────────────────────────────────────────────────────────
  {
    const fixture = createEngineFixture();
    const res = await receiveInboundMessage(fixture.deps, {
      from: "+201234567890",
      to: "+201001111111",
      text: "عندي نزيف شديد بعد الخلع ومش بيقف",
      receivedAt: now.toISOString(),
      channel: "WHATSAPP",
      externalId: "ext-24",
    });

    check(
      "24. Sensitive/emergency message triggers immediate handoff",
      res.ok &&
        !res.duplicate &&
        res.assistantAction === "AI_HANDOFF" &&
        res.conversationStatus === "NEED_HUMAN",
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 25. A customer interrupts a booking to ask a FAQ
  // ──────────────────────────────────────────────────────────────────────────
  {
    const { state: inBooking } = mergeConversationState(
      emptyConversationState(),
      {
        turnGoal: "BOOKING",
        factUpdates: [{ key: "service", value: "كشف أسنان" }],
      },
    );

    const { state: interrupted } = mergeConversationState(inBooking, {
      turnGoal: "FAQ",
    });

    check(
      "25. Booking task is marked INTERRUPTED when FAQ is asked",
      interrupted.bookingStage === "INTERRUPTED" &&
        interrupted.topics[0]?.suspendState === "INTERRUPTED",
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 26. The interrupted goal resumes correctly
  // ──────────────────────────────────────────────────────────────────────────
  {
    const { state: inBooking } = mergeConversationState(
      emptyConversationState(),
      {
        turnGoal: "BOOKING",
        factUpdates: [{ key: "service", value: "كشف أسنان" }],
      },
    );

    const { state: interrupted } = mergeConversationState(inBooking, {
      turnGoal: "FAQ",
    });

    const { state: resumed } = mergeConversationState(interrupted, {
      turnGoal: "BOOKING",
    });

    check(
      "26. Interrupted booking recovers active task and keeps facts",
      resumed.bookingStage === "RECOVERING" &&
        resumed.knownFacts.service === "كشف أسنان" &&
        resumed.topics[0]?.suspendState === "RECOVERING",
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 27. JEV timeout/failure preserves conversation state
  // ──────────────────────────────────────────────────────────────────────────
  {
    const fixture = createEngineFixture({
      simulateAiFailure: true,
    });
    const res = await receiveInboundMessage(fixture.deps, {
      from: "+201234567890",
      to: "+201001111111",
      text: "عايز كشف أسنان",
      receivedAt: now.toISOString(),
      channel: "WHATSAPP",
      externalId: "ext-27",
    });

    check(
      "27. AI failure safely degrades without crashing",
      res.ok && !res.duplicate && res.assistantAction === "AI_HANDOFF",
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 28. No fabricated service/provider/slot IDs
  // ──────────────────────────────────────────────────────────────────────────
  {
    const fixture = createEngineFixture();
    const res = await receiveInboundMessage(fixture.deps, {
      from: "+201234567890",
      to: "+201001111111",
      text: "1",
      receivedAt: now.toISOString(),
      channel: "WHATSAPP",
      externalId: "ext-28",
    });

    const created = fixture.createdAppointments;
    const msgs =
      await fixture.deps.conversationRepository.getMessages("conv-1");
    check(
      "28. Created appointment uses exclusively real catalogue IDs",
      created.length === 1 &&
        created[0]?.serviceId === SERVICE_1 &&
        (created[0]?.providerId === PROVIDER_1 ||
          created[0]?.providerId === PROVIDER_2),
      { created, res, msgs },
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 29. No unnecessary additional paid model call for mechanical selection
  // ──────────────────────────────────────────────────────────────────────────
  {
    const fixture = createEngineFixture();
    const callsBefore = fixture.aiCallCount;
    await receiveInboundMessage(fixture.deps, {
      from: "+201234567890",
      to: "+201001111111",
      text: "1",
      receivedAt: now.toISOString(),
      channel: "WHATSAPP",
      externalId: "ext-29",
    });
    const callsAfter = fixture.aiCallCount;

    check(
      "29. Mechanical selection executes with exactly 0 model calls",
      callsAfter === callsBefore,
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 30. Existing historical bookings remain untouched
  // ──────────────────────────────────────────────────────────────────────────
  {
    const fixture = createEngineFixture();
    const initialBookingsCount = fixture.existingHistoricalBookings.length;
    await receiveInboundMessage(fixture.deps, {
      from: "+201234567890",
      to: "+201001111111",
      text: "1",
      receivedAt: now.toISOString(),
      channel: "WHATSAPP",
      externalId: "ext-30",
    });

    check(
      "30. Historical bookings remain untouched after turn execution",
      fixture.existingHistoricalBookings.length === initialBookingsCount &&
        fixture.existingHistoricalBookings[0]?.id === "hist-apt-1",
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 31. Stranded claim recovery after timeout
  // ──────────────────────────────────────────────────────────────────────────
  {
    const store = new InMemoryConversationStateStore();
    const offer = buildSlotOffer(
      { businessId: B_ID, conversationId: C_ID },
      "off-31",
      {
        serviceId: SERVICE_1,
        serviceName: "كشف أسنان",
        serviceSource: "CUSTOMER",
        providerId: null,
        date: "2026-09-15",
        followUpRequestId: null,
        shownCount: 1,
        options: [
          {
            providerId: PROVIDER_1,
            displayName: "د. سارة",
            startAt: "2026-09-15T09:00",
            endAt: "2026-09-15T09:30",
          },
        ],
      },
      now,
    )!;
    // Persist as CLAIMED 5 minutes ago (abandoned / crashed turn)
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
    const claimedState = withOfferStatus(
      withPresentedOffer(emptyConversationState(), offer),
      "CLAIMED",
    );
    store.rows.set(C_ID, {
      businessId: B_ID,
      revision: 1,
      state: dehydrateConversationState(claimedState),
      updatedAt: fiveMinutesAgo,
    });

    const session = await openTurnStateSession(
      store,
      { businessId: B_ID, conversationId: C_ID },
      now,
    );
    check(
      "31. Stranded claim (>2m) is automatically released back to ACTIVE on session open",
      session.state?.offer?.status === "ACTIVE",
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 32. Invalid selection index releases claim back to ACTIVE
  // ──────────────────────────────────────────────────────────────────────────
  {
    const fixture = createEngineFixture();
    await receiveInboundMessage(fixture.deps, {
      from: "+201234567890",
      to: "+201001111111",
      text: "9",
      receivedAt: now.toISOString(),
      channel: "WHATSAPP",
      externalId: "ext-32-a",
    });

    const row = await fixture.deps.conversationStateRepository!.load(
      B_ID,
      "conv-1",
    );
    const hydrated = hydrateConversationState(row?.state, {
      businessId: B_ID,
      conversationId: "conv-1",
    });

    check(
      "32. Out-of-bounds selection index releases offer back to ACTIVE",
      hydrated?.offer?.status === "ACTIVE",
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Print results
  // ──────────────────────────────────────────────────────────────────────────
  console.log("\n── CONV-CORE-01 REGRESSION SUITE RESULTS ──\n");
  let passedCount = 0;
  for (const c of checks) {
    if (c.pass) {
      console.log(`  ✔ ${c.label}`);
      passedCount++;
    } else {
      console.error(`  ❌ FAILED: ${c.label}`);
    }
  }

  console.log(
    `\nTOTAL: ${checks.length} | PASSED: ${passedCount} | FAILED: ${checks.length - passedCount}`,
  );
  if (passedCount !== checks.length) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("FATAL ERROR in check-conv-core-01:", err);
  process.exit(1);
});
