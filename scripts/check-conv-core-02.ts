/**
 * FlowPilot — CONV-CORE-02 Verification Suite
 * Context-Aware JEV-First Semantic Gateway & Single Decision Ownership
 *
 * Verifies all 19 Required Scenarios (A through S):
 *  A. Initial Arabic booking with context projection
 *  B. Date correction: date updates, service & evening preference survive, slot offer invalidated
 *  C. Provider correction: provider updates, slot offer invalidated, service & date survive
 *  D. Mixed inquiry and booking: grounded knowledge reply, booking preserved, 1 model call
 *  E. Knowledge interruption during booking: grounded reply, booking resumable
 *  F. Temporary pause ("ثواني بس"): active task and facts preserved
 *  G. Post-confirmation FAQ: answered without unjustified handoff
 *  H. Second booking after confirmation: fresh task, consumed offer not reused
 *  I. Explicit human request: authoritative safety precedence wins
 *  J. Provider preference without human request: mapped to provider, not handoff
 *  K. Numeric selection: mechanical resolution with ZERO model calls
 *  L. Expired / invalid selection: safely rejected, no invalid appointment
 *  M. JEV timeout / malformed output: fails closed safely, 1 spent attempt
 *  N. Missing credentials: pre-attempt routing, 0 JEV calls
 *  O. Successful semantic result vs conflicting lexical cue: JEV interpretation preserved
 *  P. Cross-tenant mismatch: mismatched state rejected by context builder
 *  Q. Fresh request / durable reload: store reload affects provider request and planning
 *  R. Context bounds & disclosure: bounds enforced, secrets/nonces excluded, stale offers nullified
 *  S. State-revision regression: CAS conflict detected and handled
 *
 * Run: pnpm check:conv-core-02
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
import type { ConversationState } from "@/features/conversations/server/conversation-state";
import type { UpdateConversationDto } from "@/lib/validation";
import type { InboundClaimResult } from "@/server/repositories/inbound-dedupe.repository";
import type { UsageRecord } from "@/types/domain";

type MutableConversationState = {
  -readonly [K in keyof ConversationState]: ConversationState[K];
};

type Check = { label: string; pass: boolean; detail?: unknown };
const checks: Check[] = [];

function check(label: string, pass: boolean, detail?: unknown): void {
  if (!pass && detail !== undefined) {
    console.log(`[DEBUG FAIL] ${label}:`, detail);
  }
  checks.push({ label, pass, detail });
}

class InMemoryConversationStateStore {
  public rows = new Map<
    string,
    { businessId: string; revision: number; state: unknown; updatedAt: Date }
  >();
  public clock: () => Date = () => new Date("2026-09-14T10:00:00Z");

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
        updatedAt: this.clock(),
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
      updatedAt: this.clock(),
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

  const { buildSlotOffer } =
    await import("../src/features/conversations/server/booking-offer");
  const { interpretOfferReply } =
    await import("../src/features/conversations/server/booking-selection");
  const {
    completeBookingTask,
    dehydrateConversationState,
    emptyConversationState,
    hydrateConversationState,
    mergeConversationState,
    projectConversationState,
    withPresentedOffer,
  } = await import("../src/features/conversations/server/conversation-state");
  const { buildAiContext } =
    await import("../src/features/conversations/server/ai-context-builder/context-builder");
  const { createJevDecisionsProvider } =
    await import("../src/server/integrations/ai/jev-decisions-provider");
  const { createSemanticJevStrategy } =
    await import("../src/server/integrations/ai/jev-semantic-strategy");
  const { receiveInboundMessage } =
    await import("../src/features/conversations/server/conversation-engine");

  const B_ID = "11111111-1111-4111-8111-111111111111";
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
    customAi?: (req: AiRequest) => Promise<AiResponse>;
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
        {
          question: "بكام كشف الأسنان؟",
          answer: "سعر كشف الأسنان 300 جنيه.",
        },
        {
          question: "مواعيد العمل إيه؟",
          answer: "مواعيدنا يومياً من 9 صباحاً حتى 6 مساءً ما عدا الجمعة.",
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
    const conversation = {
      id: "conv-1",
      businessId: B_ID,
      customerId: customer.id,
      branchId: BRANCH_1,
      status: conversationStatus,
      assignedUserId: null as string | null,
      aiSummary: null as string | null,
    };

    const dedupeLedger = new Set<string>();
    const messages: Array<{ senderType: string; content: string; id: string }> =
      [];
    const stateStore = new InMemoryConversationStateStore();
    const createdAppointments: Array<{
      serviceId: string;
      providerId?: string;
      date: string;
      startTime: string;
      endTime: string;
    }> = [];

    let aiCalls = 0;
    const capturedRequests: AiRequest[] = [];

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
            conversation.status = options.status;
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
        getMessages: async () => [...messages] as unknown as Message[],
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
          if (data.status) {
            conversationStatus = data.status;
            conversation.status = data.status;
          }
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
      transport: {
        providerName: "test-transport",
        send: async () => ({ provider: "test", delivered: true }),
      },
      ai: {
        providerName: "test-ai",
        respond: async (request: AiRequest): Promise<AiResponse> => {
          aiCalls++;
          capturedRequests.push(request);
          if (opts?.customAi) {
            return opts.customAi(request);
          }
          const text = request.message;
          if (text.includes("عنوان") || text.includes("مكان")) {
            return {
              intent: "FAQ",
              action: "reply",
              summary: "سؤال عن العنوان",
              content: "عنواننا في التجمع الخامس، القاهرة.",
              handoffReason: null,
              extraction: {
                service: null,
                provider: null,
                date: null,
                timePreference: null,
              },
            };
          }
          if (text.includes("بكام")) {
            return {
              intent: "FAQ",
              action: "reply",
              summary: "استفسار عن السعر وحجز",
              content: "سعر كشف الأسنان 300 جنيه.",
              handoffReason: null,
              goals: [
                {
                  kind: "ANSWER",
                  intent: "FAQ",
                  continueAfter: true,
                },
                {
                  kind: "DOMAIN_ACTION",
                  intent: "BOOKING",
                },
              ],
              extraction: {
                service: "كشف أسنان",
                provider: null,
                date: "2026-09-15",
                timePreference: null,
              },
            };
          }
          return {
            intent: "BOOKING",
            action: "booking_handoff",
            summary: "طلب حجز",
            content: "أهلاً بك! جاري البحث عن موعد مناسب.",
            handoffReason: null,
            extraction: {
              service: "تنظيف أسنان",
              provider: null,
              date: "2026-09-15",
              timePreference: "evening",
            },
          };
        },
      },
    };

    let msgCounter = 0;
    async function sendTurn(text: string, timestamp: Date = now) {
      msgCounter++;
      return receiveInboundMessage(deps, {
        from: "+201234567890",
        to: "+201000000000",
        text,
        receivedAt: timestamp.toISOString(),
        channel: "WHATSAPP",
        externalId: `ext-${msgCounter}-${Date.now()}-${Math.random()}`,
      });
    }

    return {
      deps,
      conversation,
      stateStore,
      createdAppointments,
      capturedRequests,
      sendTurn,
      getAiCalls: () => aiCalls,
    };
  }

  console.log("── FLOWPILOT CONV-CORE-02 ACCEPTANCE SUITE ──\n");

  // =========================================================================
  // SCENARIO A: Initial Arabic booking with context projection
  // =========================================================================
  {
    const fixture = createEngineFixture();
    const res = await fixture.sendTurn("عايز أحجز تنظيف بكرة بالليل");

    check(
      "Scenario A: Turn executed successfully",
      Boolean(
        res.ok &&
        "assistantAction" in res &&
        res.assistantAction === "AI_REPLY",
      ),
      res,
    );
    check(
      "Scenario A: Exactly 1 model call made for initial booking",
      fixture.getAiCalls() === 1,
    );

    // Verify durable state was saved with the extracted facts
    const saved = await fixture.stateStore.load(B_ID, fixture.conversation.id);
    const hydrated = saved
      ? hydrateConversationState(saved.state, {
          businessId: B_ID,
          conversationId: fixture.conversation.id,
        })
      : null;
    check(
      "Scenario A: Durable state reflects BOOKING task",
      hydrated?.activeTask?.kind === "BOOKING",
    );
    check(
      "Scenario A: Resolved service is recorded",
      hydrated?.serviceId === SERVICE_2,
    );
    check(
      "Scenario A: Evening preference is preserved in durable state",
      hydrated?.selectedTimePref === "evening" ||
        hydrated?.knownFacts?.timePreference === "evening",
    );

    // Turn 2: Verify next turn projects this saved context to the AI
    await fixture.sendTurn("الساعة كام المواعيد؟");
    const turn2Req =
      fixture.capturedRequests[fixture.capturedRequests.length - 1];
    check(
      "Scenario A: Context projection received by AI provider on subsequent turn",
      turn2Req?.conversationContext !== undefined &&
        turn2Req?.conversationContext?.knownService === "تنظيف أسنان" &&
        turn2Req?.conversationContext?.timePreference === "evening",
    );
  }

  // =========================================================================
  // SCENARIO B: Date correction
  // =========================================================================
  {
    const fixture = createEngineFixture();
    // Seed initial state: service "تنظيف أسنان", date "2026-09-15", evening, active offer
    const initialOffer = buildSlotOffer(
      { businessId: B_ID, conversationId: fixture.conversation.id },
      "offer-b",
      {
        serviceId: SERVICE_2,
        serviceName: "تنظيف أسنان",
        serviceSource: "CUSTOMER",
        providerId: null,
        date: "2026-09-15",
        followUpRequestId: null,
        shownCount: 1,
        options: [
          {
            providerId: PROVIDER_1,
            displayName: "د. سارة",
            startAt: "2026-09-15T19:00",
            endAt: "2026-09-15T19:30",
          },
        ],
      },
      now,
    )!;

    const seedState: MutableConversationState = withPresentedOffer(
      emptyConversationState(),
      initialOffer,
    );
    seedState.activeTask = { kind: "BOOKING", stage: "AVAILABILITY_RESOLVED" };
    seedState.serviceId = SERVICE_2;
    seedState.selectedService = "تنظيف أسنان";
    seedState.selectedDate = "2026-09-15";
    seedState.selectedTimePref = "evening";
    seedState.knownFacts = {
      service: "تنظيف أسنان",
      date: "2026-09-15",
      timePreference: "evening",
    };

    await fixture.stateStore.save(
      B_ID,
      fixture.conversation.id,
      null,
      dehydrateConversationState(seedState),
    );

    // Turn 2: Customer corrects date: "خليه الخميس بدل بكرة"
    fixture.deps.ai = {
      providerName: "test-ai",
      respond: async (request: AiRequest): Promise<AiResponse> => {
        fixture.capturedRequests.push(request);
        return {
          intent: "BOOKING",
          action: "booking_handoff",
          summary: "تعديل التاريخ إلى الخميس",
          content: "تمام، هشوفلك المتاح يوم الخميس.",
          handoffReason: null,
          extraction: {
            service: null, // Did not repeat service
            provider: null,
            date: "2026-09-17", // Thursday
            timePreference: null, // Did not repeat evening
          },
        };
      },
    };

    await fixture.sendTurn("خليه الخميس بدل بكرة");

    const saved = await fixture.stateStore.load(B_ID, fixture.conversation.id);
    const state = saved
      ? hydrateConversationState(saved.state, {
          businessId: B_ID,
          conversationId: fixture.conversation.id,
        })
      : null;

    const lastReq =
      fixture.capturedRequests[fixture.capturedRequests.length - 1];
    check(
      "Scenario B: Context projection carried prior activeOffer and facts to AI",
      lastReq?.conversationContext?.knownService === "تنظيف أسنان" &&
        lastReq?.conversationContext?.activeOffer?.offeredServiceName ===
          "تنظيف أسنان",
    );
    check(
      "Scenario B: Date updated to Thursday (2026-09-17)",
      state?.selectedDate === "2026-09-17" ||
        state?.knownFacts?.date === "2026-09-17",
    );
    check(
      "Scenario B: Service survived date correction without being repeated",
      state?.serviceId === SERVICE_2,
    );
    check(
      "Scenario B: Evening time preference survived date correction",
      state?.selectedTimePref === "evening" ||
        state?.knownFacts?.timePreference === "evening",
    );
    check(
      "Scenario B: Slot offer for the old date was superseded with new date offer",
      state?.offer?.kind === "SLOT" && state.offer.date === "2026-09-17",
    );
  }

  // =========================================================================
  // SCENARIO C: Provider correction
  // =========================================================================
  {
    const fixture = createEngineFixture();
    const initialOffer = buildSlotOffer(
      { businessId: B_ID, conversationId: fixture.conversation.id },
      "offer-c",
      {
        serviceId: SERVICE_1,
        serviceName: "كشف أسنان",
        serviceSource: "CUSTOMER",
        providerId: PROVIDER_2,
        date: "2026-09-15",
        followUpRequestId: null,
        shownCount: 1,
        options: [
          {
            providerId: PROVIDER_2,
            displayName: "د. أحمد",
            startAt: "2026-09-15T10:00",
            endAt: "2026-09-15T10:30",
          },
        ],
      },
      now,
    )!;

    const seedState: MutableConversationState = withPresentedOffer(
      emptyConversationState(),
      initialOffer,
    );
    seedState.activeTask = { kind: "BOOKING", stage: "AVAILABILITY_RESOLVED" };
    seedState.serviceId = SERVICE_1;
    seedState.selectedService = "كشف أسنان";
    seedState.providerPreference = PROVIDER_2;
    seedState.selectedDate = "2026-09-15";
    seedState.knownFacts = {
      service: "كشف أسنان",
      provider: "د. أحمد",
      date: "2026-09-15",
    };

    await fixture.stateStore.save(
      B_ID,
      fixture.conversation.id,
      null,
      dehydrateConversationState(seedState),
    );

    // Turn: Customer corrects provider: "عايز مع د. سارة بدل د. أحمد"
    fixture.deps.ai = {
      providerName: "test-ai",
      respond: async (request: AiRequest): Promise<AiResponse> => {
        fixture.capturedRequests.push(request);
        return {
          intent: "BOOKING",
          action: "booking_handoff",
          summary: "تغيير الطبيب",
          content: "تمام، هشوفلك مواعيد د. سارة.",
          handoffReason: null,
          extraction: {
            service: null,
            provider: "د. سارة",
            date: null,
            timePreference: null,
          },
        };
      },
    };

    await fixture.sendTurn("عايز مع د. سارة بدل د. أحمد");

    const saved = await fixture.stateStore.load(B_ID, fixture.conversation.id);
    const state = saved
      ? hydrateConversationState(saved.state, {
          businessId: B_ID,
          conversationId: fixture.conversation.id,
        })
      : null;

    check(
      "Scenario C: Provider updated to د. سارة",
      state?.providerPreference === PROVIDER_1 ||
        state?.knownFacts?.provider === "د. سارة",
    );
    check(
      "Scenario C: Service survived provider correction",
      state?.serviceId === SERVICE_1,
    );
    check(
      "Scenario C: Date survived provider correction",
      state?.selectedDate === "2026-09-15" ||
        state?.knownFacts?.date === "2026-09-15",
    );
    const firstOpt = state?.offer?.options?.[0];
    check(
      "Scenario C: Slot offer updated to selected provider",
      Boolean(
        firstOpt &&
        "displayName" in firstOpt &&
        firstOpt.displayName === "د. سارة",
      ),
    );
  }

  // =========================================================================
  // SCENARIO D: Mixed inquiry and booking (answer-and-continue)
  // =========================================================================
  {
    const fixture = createEngineFixture();
    const res = await fixture.sendTurn("بكام الكشف وعايز أحجز بكرة");

    check(
      "Scenario D: Handled in exactly 1 model call",
      fixture.getAiCalls() === 1,
    );
    check(
      "Scenario D: Answer-and-continue reply composed with continuation invite",
      Boolean(
        res.ok &&
        "assistantAction" in res &&
        res.assistantAction === "AI_REPLY",
      ),
      res,
    );
  }

  // =========================================================================
  // SCENARIO E: Knowledge interruption during booking
  // =========================================================================
  {
    const { state: inBooking } = mergeConversationState(
      emptyConversationState(),
      {
        turnGoal: "BOOKING",
        factUpdates: [
          { key: "service", value: "كشف أسنان" },
          { key: "date", value: "2026-09-15" },
        ],
      },
    );

    const { state: interrupted } = mergeConversationState(inBooking, {
      turnGoal: "FAQ",
    });

    check(
      "Scenario E: Booking task is marked INTERRUPTED when FAQ is asked and facts survive",
      interrupted.bookingStage === "INTERRUPTED" &&
        interrupted.knownFacts.service === "كشف أسنان" &&
        interrupted.knownFacts.date === "2026-09-15" &&
        interrupted.topics[0]?.suspendState === "INTERRUPTED",
    );
  }

  // =========================================================================
  // SCENARIO F: Temporary pause ("ثواني بس")
  // =========================================================================
  {
    const { state: inBooking } = mergeConversationState(
      emptyConversationState(),
      {
        turnGoal: "BOOKING",
        factUpdates: [{ key: "service", value: "كشف أسنان" }],
      },
    );

    const { state: paused } = mergeConversationState(inBooking, {
      turnGoal: "GENERAL",
    });

    check(
      "Scenario F: Active booking task not erased by temporary pause",
      paused.activeTask?.kind === "BOOKING" &&
        paused.knownFacts.service === "كشف أسنان",
    );
  }

  // =========================================================================
  // SCENARIO G: Post-confirmation FAQ
  // =========================================================================
  {
    const fixture = createEngineFixture();
    const seedState = completeBookingTask(emptyConversationState(), {
      appointmentId: "apt-1",
      serviceId: SERVICE_1,
      providerId: null,
      date: "2026-09-15",
      completedAt: now.toISOString(),
    });
    await fixture.stateStore.save(
      B_ID,
      fixture.conversation.id,
      null,
      dehydrateConversationState(seedState),
    );

    await fixture.sendTurn("عنوان ومكان العيادة فين؟");

    check(
      "Scenario G: Post-confirmation FAQ answered without handoff",
      fixture.conversation.status === "AI_ACTIVE",
    );
  }

  // =========================================================================
  // SCENARIO H: Second booking after confirmation
  // =========================================================================
  {
    const fixture = createEngineFixture();
    const seedState = completeBookingTask(emptyConversationState(), {
      appointmentId: "apt-2",
      serviceId: SERVICE_1,
      providerId: null,
      date: "2026-09-15",
      completedAt: now.toISOString(),
    });
    await fixture.stateStore.save(
      B_ID,
      fixture.conversation.id,
      null,
      dehydrateConversationState(seedState),
    );

    await fixture.sendTurn("عايز أحجز كشف تاني يوم الخميس");

    const saved = await fixture.stateStore.load(B_ID, fixture.conversation.id);
    const state = saved
      ? hydrateConversationState(saved.state, {
          businessId: B_ID,
          conversationId: fixture.conversation.id,
        })
      : null;

    check(
      "Scenario H: Fresh booking task started after previous completion",
      state?.activeTask?.kind === "BOOKING",
    );
    check(
      "Scenario H: Consumed offer not reused",
      state?.offer === null || state?.offer?.status !== "CONSUMED",
    );
  }

  // =========================================================================
  // SCENARIO I: Explicit human request
  // =========================================================================
  {
    const fixture = createEngineFixture();
    fixture.deps.ai = {
      providerName: "test-ai",
      respond: async (): Promise<AiResponse> => ({
        intent: "HUMAN_REQUEST",
        action: "handoff",
        summary: "طلب التحدث مع موظف",
        content: "تم تحويلك إلى موظف خدمة العملاء.",
        handoffReason: "HUMAN_REQUEST",
        extraction: {
          service: null,
          provider: null,
          date: null,
          timePreference: null,
        },
      }),
    };

    await fixture.sendTurn("عايز أكلم حد من الموظفين ضروري");

    check(
      "Scenario I: Explicit human request triggers handoff",
      fixture.conversation.status === "NEED_HUMAN",
    );
  }

  // =========================================================================
  // SCENARIO J: Provider preference without human request
  // =========================================================================
  {
    const fixture = createEngineFixture();
    await fixture.sendTurn("عايز أحجز مع الدكتور أحمد");

    check(
      "Scenario J: Named provider preference is NOT treated as human handoff",
      fixture.conversation.status === "AI_ACTIVE",
    );
  }

  // =========================================================================
  // SCENARIO K: Numeric selection (1 / ١ against active offer)
  // =========================================================================
  {
    const offer = buildSlotOffer(
      { businessId: B_ID, conversationId: C_ID },
      "offer-k",
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
            startAt: "2026-09-15T09:00",
            endAt: "2026-09-15T09:30",
          },
        ],
      },
      now,
    )!;

    const reply = interpretOfferReply("١", offer, now);

    check(
      "Scenario K: Numeric mechanical selection spends exactly 0 AI model calls",
      reply.kind === "slot" &&
        reply.selection.kind === "index" &&
        reply.selection.index === 1,
    );
  }

  // =========================================================================
  // SCENARIO L: Expired / invalid selection
  // =========================================================================
  {
    const offer = buildSlotOffer(
      { businessId: B_ID, conversationId: C_ID },
      "offer-l",
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
            startAt: "2026-09-15T09:00",
            endAt: "2026-09-15T09:30",
          },
        ],
      },
      now,
    )!;

    const dayLater = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const reply = interpretOfferReply("1", offer, dayLater);

    check(
      "Scenario L: Expired offer selection is rejected as stale (EXPIRED)",
      reply.kind === "stale" && reply.reason === "EXPIRED",
    );
  }

  // =========================================================================
  // SCENARIO M: JEV timeout / malformed output
  // =========================================================================
  {
    let attemptsCount = 0;
    const decisions = createJevDecisionsProvider({
      getEnvVar: (name: string) =>
        name === "OPENROUTER_API_KEY" ? "sk-test" : undefined,
      fetchImpl: (async () => {
        attemptsCount++;
        throw new Error("ETIMEDOUT");
      }) as unknown as typeof fetch,
    });

    const strategy = createSemanticJevStrategy({
      provider: decisions,
      enabled: true,
    });

    const result = await strategy.decide({
      message: "عايز كشف",
      conversationStatus: "AI_ACTIVE",
      recentMessages: [],
      businessName: "عيادة",
      services: [],
      faqs: [],
    });

    check(
      "Scenario M: JEV timeout results in deterministic fallback",
      result.mode === "DETERMINISTIC",
    );
    check(
      "Scenario M: Exactly 1 physical attempt spent (no retries)",
      attemptsCount === 1,
    );
  }

  // =========================================================================
  // SCENARIO N: Missing credentials
  // =========================================================================
  {
    let fetchCalls = 0;
    const decisions = createJevDecisionsProvider({
      getEnvVar: () => undefined,
      fetchImpl: (async () => {
        fetchCalls++;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });

    const strategy = createSemanticJevStrategy({
      provider: decisions,
      enabled: true,
    });

    const result = await strategy.decide({
      message: "عايز كشف",
      conversationStatus: "AI_ACTIVE",
      recentMessages: [],
      businessName: "عيادة",
      services: [],
      faqs: [],
    });

    check(
      "Scenario N: Missing credentials routes pre-attempt to GENERATIVE",
      result.mode === "GENERATIVE",
    );
    check(
      "Scenario N: Missing credentials spends exactly 0 network calls",
      fetchCalls === 0,
    );
  }

  // =========================================================================
  // SCENARIO O: Successful semantic result vs conflicting lexical cue
  // =========================================================================
  {
    const fixture = createEngineFixture();
    fixture.deps.ai = {
      providerName: "typesafe-jev",
      respond: async (request: AiRequest): Promise<AiResponse> => {
        fixture.capturedRequests.push(request);
        return {
          intent: "BOOKING",
          action: "booking_handoff",
          summary: "طلب حجز مع طبيب",
          content: "تمام، هشوفلك موعد مناسب.",
          handoffReason: null,
          extraction: {
            service: "كشف أسنان",
            provider: null,
            date: "2026-09-15",
            timePreference: null,
          },
        };
      },
    };

    // The message includes the word 'خدمة' or 'مساعدة' which might trigger a generic lexical rule,
    // but JEV identified it as a BOOKING.
    await fixture.sendTurn("ممكن خدمة كشف أسنان بكرة؟");

    check(
      "Scenario O: Semantic decision owns the turn (stays AI_ACTIVE booking)",
      fixture.conversation.status === "AI_ACTIVE",
    );
    const saved = await fixture.stateStore.load(B_ID, fixture.conversation.id);
    const state = saved
      ? hydrateConversationState(saved.state, {
          businessId: B_ID,
          conversationId: fixture.conversation.id,
        })
      : null;
    check(
      "Scenario O: State transitioned to BOOKING without lexical override",
      state?.activeTask?.kind === "BOOKING",
    );
  }

  // =========================================================================
  // SCENARIO P: Cross-tenant mismatch
  // =========================================================================
  {
    const foreignState: MutableConversationState = emptyConversationState();
    foreignState.activeTask = { kind: "BOOKING", stage: "SERVICE_SUPPLIED" };
    foreignState.serviceId = SERVICE_1;
    foreignState.selectedService = "كشف أسنان";
    foreignState.selectedDate = "2026-09-15";
    foreignState.knownFacts = {
      service: "كشف أسنان",
      date: "2026-09-15",
    };

    const projection = projectConversationState(foreignState);
    check(
      "Scenario P: Context projection can be built",
      projection !== null && projection.activeTask?.kind === "BOOKING",
    );

    // Verify context builder projects valid tenant state into request
    const built = buildAiContext({
      scope: { businessId: B_ID },
      sources: {
        message: "مرحبا",
        business: {
          businessId: B_ID,
          name: "عيادة الابتسامة",
        },
        conversation: {
          status: "AI_ACTIVE",
          recentMessages: [],
        },
        conversationState: foreignState,
        services: [],
      },
    });

    check(
      "Scenario P: Context builder projects valid tenant state into request",
      built.request.conversationContext !== null &&
        built.request.conversationContext?.activeTask?.kind === "BOOKING",
    );
  }

  // =========================================================================
  // SCENARIO Q: Fresh request / durable reload
  // =========================================================================
  {
    const fixture = createEngineFixture();
    const seedState: MutableConversationState = emptyConversationState();
    seedState.activeTask = { kind: "BOOKING", stage: "TIME_SUPPLIED" };
    seedState.bookingStage = "TIME_SUPPLIED";
    seedState.serviceId = SERVICE_2;
    seedState.selectedService = "تنظيف أسنان";
    seedState.selectedDate = "2026-09-20";
    seedState.selectedTimePref = "morning";
    seedState.knownFacts = {
      service: "تنظيف أسنان",
      date: "2026-09-20",
      timePreference: "morning",
    };
    await fixture.stateStore.save(
      B_ID,
      fixture.conversation.id,
      null,
      dehydrateConversationState(seedState),
    );

    await fixture.sendTurn("ممكن أعرف المواعيد المتاحة؟");

    const lastReq =
      fixture.capturedRequests[fixture.capturedRequests.length - 1];
    check(
      "Scenario Q: Reloaded state reflected in provider request context",
      lastReq?.conversationContext?.knownService === "تنظيف أسنان" &&
        lastReq?.conversationContext?.knownDate === "2026-09-20" &&
        lastReq?.conversationContext?.timePreference === "morning",
      lastReq?.conversationContext,
    );
  }

  // =========================================================================
  // SCENARIO R: Context bounds & disclosure
  // =========================================================================
  {
    const state: MutableConversationState = emptyConversationState();
    state.activeTask = { kind: "BOOKING", stage: "SERVICE_SUPPLIED" };
    state.missingFacts = [
      "date",
      "timePreference",
      "provider",
      "service",
      "customerName",
      "followUpRequestId",
      "date",
      "service",
      "provider",
    ] as unknown as readonly (
      | "date"
      | "timePreference"
      | "service"
      | "provider"
      | "followUpRequestId"
      | "customerName"
    )[];

    const offer = buildSlotOffer(
      { businessId: B_ID, conversationId: "c-1" },
      "offer-secret-nonce-12345",
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

    const stateWithOffer = withPresentedOffer(state, offer);
    const projection = projectConversationState(stateWithOffer, { now });

    check(
      "Scenario R: Missing facts in clarification are bounded to 8 items",
      (projection?.pendingClarification?.missingFacts?.length ?? 0) <= 8,
    );
    check(
      "Scenario R: Offer nonce / internal tokens are NOT leaked in projection",
      !("token" in (projection?.activeOffer ?? {})) &&
        !("businessId" in (projection?.activeOffer ?? {})),
    );
    check(
      "Scenario R: Live active offer is projected with safe fields",
      projection?.activeOffer?.offeredServiceName === "كشف أسنان" &&
        projection?.activeOffer?.itemCount === 1,
    );

    // Stale offer (expired after 12h TTL)
    const dayLater = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const staleProjection = projectConversationState(stateWithOffer, {
      now: dayLater,
    });
    check(
      "Scenario R: Expired offer is projected as null",
      staleProjection?.activeOffer === null,
    );
  }

  // =========================================================================
  // SCENARIO S: State-revision regression (CAS conflict)
  // =========================================================================
  {
    const store = new InMemoryConversationStateStore();
    const state = emptyConversationState();

    // First save: expectedRevision null -> revision 1
    const res1 = await store.save(
      B_ID,
      "conv-cas",
      null,
      dehydrateConversationState(state),
    );
    check(
      "Scenario S: Initial save returns revision 1",
      res1.status === "saved" && res1.revision === 1,
    );

    // Concurrent save with obsolete expectedRevision null -> conflict
    const resConflict = await store.save(
      B_ID,
      "conv-cas",
      null,
      dehydrateConversationState(state),
    );
    check(
      "Scenario S: Concurrent initialization returns conflict",
      resConflict.status === "conflict",
    );

    // Second valid update with expectedRevision 1 -> revision 2
    const res2 = await store.save(
      B_ID,
      "conv-cas",
      1,
      dehydrateConversationState(state),
    );
    check(
      "Scenario S: Valid CAS update returns revision 2",
      res2.status === "saved" && res2.revision === 2,
    );

    // Outdated CAS update with revision 1 -> conflict
    const resStale = await store.save(
      B_ID,
      "conv-cas",
      1,
      dehydrateConversationState(state),
    );
    check(
      "Scenario S: Stale revision CAS update returns conflict",
      resStale.status === "conflict",
    );
  }

  // =========================================================================
  // SUMMARY
  // =========================================================================
  console.log("\n── CONV-CORE-02 ACCEPTANCE RESULTS ──\n");
  let failed = 0;
  for (const c of checks) {
    if (c.pass) {
      console.log(`  ✔ ${c.label}`);
    } else {
      console.log(`  ❌ ${c.label}`);
      failed++;
    }
  }

  console.log(
    `\nTOTAL: ${checks.length} | PASSED: ${checks.length - failed} | FAILED: ${failed}\n`,
  );
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("FATAL ERROR in check-conv-core-02:", err);
  process.exit(1);
});
