/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * FlowPilot — UX001 Acceptance Suite:
 * Telegram Welcome and Contextual Choices on the Existing Conversation Engine.
 *
 * Verifies all required acceptance scenarios with rigorous behavioral checks:
 * 1. Authenticated /start renders real business identity and initial choices with zero model calls + positive control evidence.
 * 2. Booking entry with a valid default skips service selection.
 * 3. Multiple services without a default show a real service choice.
 * 4. Service -> date -> real slots -> slot selection completes one isolated booking with exact fields.
 * 5. Provider selection/ANY executed through engine, clearing provider preference and querying unconstrained catalog.
 * 6. Service inquiry preserves active booking facts, displays catalog info, and resumes cleanly.
 * 7. Free-text correction updates exact durable fact, queries availability for new date, and rejects previous callback.
 * 8. /start during an active task preserves valid facts and usable offers.
 * 9. Staff-owned conversations cannot be resumed by /start or callbacks (DEFERRED_TO_STAFF).
 * 10. Foreign tokens, unknown action names, expired, and replaced offers preserve facts and create zero appointments.
 * 11. Duplicate callback delivery and repeated taps do not duplicate booking.
 * 12. Authenticated webhook -> identity -> engine -> outbound client round trip with callback acknowledgment and reply markup (<= 64 bytes).
 * 13. Non-interactive fallback works with numbers/text.
 * 14. Command boundary: /starter does not match /start and reaches semantic path; negation reaches semantic path intact.
 *
 * Run: pnpm check:telegram-ux001
 */

export {};

type Check = { label: string; pass: boolean; details?: string };
const checks: Check[] = [];

function check(label: string, pass: boolean, details?: string): void {
  checks.push({ label, pass, details });
  if (pass) {
    console.log(`✔ ${label}`);
  } else {
    console.error(`✘ ${label}${details ? ` (${details})` : ""}`);
  }
}

// ── In-Memory State Store ──────────────────────────────────────────────────

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
    const nextRevision = existing.revision + 1;
    this.rows.set(conversationId, {
      businessId,
      revision: nextRevision,
      state: JSON.parse(JSON.stringify(state)),
      updatedAt: new Date(),
    });
    return { status: "saved" as const, revision: nextRevision };
  }
}

// ── Main Test Runner ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Seed placeholder env for offline safety
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const engine =
    await import("@/features/conversations/server/conversation-engine");
  const {
    buildWelcomeOffer,
    buildServiceOffer,
    buildProviderOffer,
    offerCallbackData,
    providerOfferKeyboard,
  } = await import("@/features/conversations/server/booking-offer");
  const {
    withPresentedOffer,
    dehydrateConversationState,
    emptyConversationState,
  } = await import("@/features/conversations/server/conversation-state");
  const { hashTelegramWebhookSecret } =
    await import("@/server/integrations/telegram/telegram-webhook");
  const { handleTelegramWebhook } =
    await import("@/server/integrations/telegram/telegram-webhook-handler");

  const B_ID = "11111111-1111-4111-8111-111111111111";
  const BRANCH_ID = "22222222-2222-4222-8222-222222222222";
  const BOT_EXTERNAL_ID = "6123456789";
  const CHAT_ID = "9988776655";
  const BUSINESS_NAME = "مركز الأمل الطبي";

  const SRV_CONSULT = "33333333-3333-4333-8333-333333333331";
  const SRV_LAB = "33333333-3333-4333-8333-333333333332";
  const SRV_CHECKUP = "33333333-3333-4333-8333-333333333333";

  const PRV_1 = "44444444-4444-4444-8444-444444444441";
  const PRV_2 = "44444444-4444-4444-8444-444444444442";

  const SIMULATED_NOW = new Date("2026-10-22T10:00:00.000Z"); // Thursday morning

  function createTestHarness(opts?: {
    conversationId?: string;
    defaultServiceId?: string | null;
    defaultBookingEnabled?: boolean;
    services?: Array<{
      id: string;
      businessId: string;
      name: string;
      durationMinutes: number;
      price?: number | null;
      description?: string | null;
      isActive: boolean;
    }>;
    initialStatus?: string;
    assignedUserId?: string | null;
  }) {
    let modelCallCount = 0;
    let physicalFetchAttempts = 0;
    let customAiResponder: ((prompt: unknown) => Promise<any> | any) | null =
      null;

    const sentMessages: Array<{
      to: string;
      content: string;
      replyMarkup?: Record<string, unknown>;
    }> = [];
    const createdAppointments: Array<{
      businessId: string;
      customerId: string;
      serviceId: string;
      providerId?: string | null;
      date: string;
      startTime: string;
      endTime: string;
    }> = [];

    const availabilityQueries: Array<{
      serviceId: string;
      date?: string;
      providerId?: string | null;
    }> = [];

    const workingHours: Record<string, unknown> = {};
    for (const d of ["sat", "sun", "mon", "tue", "wed", "thu", "fri"]) {
      workingHours[d] = { open: "09:00", close: "18:00", closed: false };
    }

    const business = {
      id: B_ID,
      name: BUSINESS_NAME,
      isActive: true,
      timezone: "Africa/Cairo",
      confirmationMode: "automatic",
      defaultBranchId: BRANCH_ID,
      defaultServiceId: opts?.defaultServiceId ?? null,
      defaultBookingServiceId: opts?.defaultServiceId ?? null,
      defaultServiceBookingEnabled: opts?.defaultBookingEnabled ?? false,
      workingHours,
      slotDurationMinutes: 30,
      faqs: [],
    };

    const branch = {
      id: BRANCH_ID,
      businessId: B_ID,
      name: "الفرع الرئيسي",
      isActive: true,
    };

    const catalogServices = opts?.services ?? [
      {
        id: SRV_CONSULT,
        businessId: B_ID,
        name: "كشف عام",
        durationMinutes: 30,
        price: 150,
        description: "كشف عام مع فحص سريري كامل",
        isActive: true,
      },
      {
        id: SRV_LAB,
        businessId: B_ID,
        name: "تحاليل معملية",
        durationMinutes: 45,
        price: 300,
        description: "تحاليل دم شاملة وبول",
        isActive: true,
      },
      {
        id: SRV_CHECKUP,
        businessId: B_ID,
        name: "فحص دوري",
        durationMinutes: 30,
        price: 200,
        description: "فحص روتيني شامل",
        isActive: true,
      },
    ];

    const eligibleProviders = [
      { id: PRV_1, displayName: "د. أحمد", user: { name: "أحمد" } },
      { id: PRV_2, displayName: "د. فاطمة", user: { name: "فاطمة" } },
    ];

    const customer = {
      id: "cust-1",
      businessId: B_ID,
      name: "مستخدم تيليجرام",
      phone: CHAT_ID,
    };

    const convId = opts?.conversationId ?? "conv-ux001";
    const conversation = {
      id: convId,
      businessId: B_ID,
      customerId: customer.id,
      branchId: BRANCH_ID,
      status: opts?.initialStatus ?? "AI_ACTIVE",
      assignedUserId: opts?.assignedUserId ?? null,
      aiSummary: null as string | null,
    };

    const messagesList: Array<{
      id: string;
      conversationId: string;
      senderType: string;
      content: string;
      createdAt: Date;
    }> = [];

    const stateStore = new InMemoryConversationStateStore();
    const dedupeClaims = new Set<string>();
    let msgSeq = 0;

    const deps = {
      businessRepository: {
        findById: async () => business,
      },
      branchRepository: {
        findById: async () => branch,
        findByIdWithinBusiness: async () => branch,
      },
      customerRepository: {
        upsertByPhone: async () => customer,
        touchConversation: async () => undefined,
      },
      conversationRepository: {
        findLatestByCustomer: async () => ({ id: conversation.id }),
        findById: async () => conversation,
        create: async () => conversation,
        addMessage: async (
          input: { senderType: string; content: string },
          workflow: { status?: string } | undefined,
        ) => {
          msgSeq += 1;
          const msg = {
            id: `msg-${msgSeq}`,
            conversationId: conversation.id,
            senderType: input.senderType,
            content: input.content,
            createdAt: new Date(),
          };
          messagesList.push(msg);
          if (workflow?.status) {
            conversation.status = workflow.status;
          }
          return msg;
        },
        getMessages: async () => [...messagesList].reverse(),
        update: async (_id: string, patch: Record<string, unknown>) => {
          Object.assign(conversation, patch);
          return conversation;
        },
        updateWorkflow: async (
          _id: string,
          patch: { status?: string; assignedUserId?: string | null },
        ) => {
          if (patch.status) conversation.status = patch.status;
          if (patch.assignedUserId !== undefined)
            conversation.assignedUserId = patch.assignedUserId;
          return conversation;
        },
      },
      conversationStateRepository: stateStore,
      serviceRepository: {
        listByBusiness: async () => catalogServices,
        findById: async (id: string) =>
          catalogServices.find((s) => s.id === id) ?? null,
      },
      providerRepository: {
        listEligibleForService: async (
          serviceId: string,
          _opts?: { branchId?: string },
        ) => {
          availabilityQueries.push({ serviceId, providerId: null });
          return eligibleProviders;
        },
        listAssignmentSeams: async () => [
          { providerId: PRV_1, userId: "u-1", assignedUserId: "u-1" },
          { providerId: PRV_2, userId: "u-2", assignedUserId: "u-2" },
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
          providerId?: string | null;
        }) => {
          createdAppointments.push({
            businessId: dto.businessId,
            customerId: dto.customerId,
            serviceId: dto.serviceId,
            providerId: dto.providerId,
            date: dto.date,
            startTime: dto.startTime,
            endTime: dto.endTime,
          });
          return { id: `apt-${createdAppointments.length}` };
        },
        listBlockingByAssignees: async (
          _bId: string,
          date: string,
          assigneeIds?: string[],
        ) => {
          availabilityQueries.push({
            serviceId: "",
            date: typeof date === "string" ? date.slice(0, 10) : "",
            providerId:
              assigneeIds && assigneeIds.length === 1 ? assigneeIds[0] : null,
          });
          return [];
        },
      },
      inboundDedupeRepository: {
        claim: async (_bId: string, key: string) => {
          if (dedupeClaims.has(key)) {
            return {
              status: "duplicate" as const,
              claimId: key,
              conversationId: conversation.id,
              customerMessageId: "msg-prior",
            };
          }
          dedupeClaims.add(key);
          return { status: "claimed" as const, claimId: key };
        },
      },
      usageRepository: {
        record: async () => undefined,
      },
      ai: {
        providerName: "mock-model",
        respond: async (input: unknown) => {
          modelCallCount++;
          physicalFetchAttempts++;
          if (customAiResponder) {
            return customAiResponder(input);
          }
          return {
            intent: "FAQ" as const,
            action: "reply" as const,
            content: "أهلاً بك، كيف أساعدك اليوم؟",
            extraction: {
              service: null,
              provider: null,
              date: null,
              timePreference: null,
            },
            handoffReason: null,
            summary: null,
          };
        },
      },
      transport: {
        providerName: "telegram",
        send: async (input: {
          to: string;
          content: string;
          replyMarkup?: Record<string, unknown>;
        }) => {
          sentMessages.push({
            to: input.to,
            content: input.content,
            replyMarkup: input.replyMarkup,
          });
          return { provider: "telegram", delivered: true };
        },
      },
    };

    return {
      deps,
      convId,
      stateStore,
      business,
      catalogServices,
      eligibleProviders,
      getModelCalls: () => modelCallCount,
      getPhysicalFetchAttempts: () => physicalFetchAttempts,
      setCustomAiResponder: (
        fn: ((prompt: unknown) => Promise<any> | any) | null,
      ) => {
        customAiResponder = fn;
      },
      getAvailabilityQueries: () => [...availabilityQueries],
      clearAvailabilityQueries: () => {
        availabilityQueries.length = 0;
      },
      getSentMessages: () => sentMessages,
      getAppointments: () => createdAppointments,
      async sendInbound(text: string, updateId = Date.now()) {
        return engine.receiveInboundMessage(
          deps as unknown as Parameters<typeof engine.receiveInboundMessage>[0],
          {
            to: BOT_EXTERNAL_ID,
            from: CHAT_ID,
            text,
            receivedAt: SIMULATED_NOW.toISOString(),
            externalId: `tg:${BOT_EXTERNAL_ID}:${updateId}`,
          },
          {
            businessId: B_ID,
            branchId: BRANCH_ID,
            connectionId: "conn-1",
          },
        );
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Scenario 1: Authenticated /start renders real business identity and initial
  // buttons with zero model calls + positive control evidence
  // ══════════════════════════════════════════════════════════════════════════
  {
    const h = createTestHarness();
    const result = await h.sendInbound("/start", 1001);
    const sent = h.getSentMessages();
    const lastMsg = sent[sent.length - 1];
    const keyboard = lastMsg?.replyMarkup?.inline_keyboard as
      Array<Array<{ text: string; callback_data: string }>> | undefined;

    const hasBizName = lastMsg?.content.includes(BUSINESS_NAME);
    const hasFreeTextNotice = lastMsg?.content.includes("كتابة");
    const hasButtons =
      keyboard &&
      keyboard.length >= 2 &&
      keyboard.some((row) => row[0]?.text.includes("حجز موعد")) &&
      keyboard.some((row) => row[0]?.text.includes("استفسار عن خدمة"));

    const stateRow = await h.stateStore.load(B_ID, h.convId);
    const offer = (stateRow?.state as { offer?: { kind: string } })?.offer;

    const zeroModelCalls =
      h.getModelCalls() === 0 && h.getPhysicalFetchAttempts() === 0;

    // Positive control: normal free-text question DOES exercise the model
    await h.sendInbound("عايز استفسار بخصوص مواعيد العمل", 1002);
    const positiveControlInvoked =
      h.getModelCalls() === 1 && h.getPhysicalFetchAttempts() === 1;

    check(
      "1. /start renders real business name + initial choices with ZERO model calls (positive control verified)",
      Boolean(
        result.ok &&
        hasBizName &&
        hasFreeTextNotice &&
        hasButtons &&
        offer?.kind === "WELCOME" &&
        zeroModelCalls &&
        positiveControlInvoked,
      ),
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Scenario 2: Booking entry with valid default skips service selection
  // ══════════════════════════════════════════════════════════════════════════
  {
    const h = createTestHarness({
      defaultServiceId: SRV_CONSULT,
      defaultBookingEnabled: true,
    });
    // First turn: /start creates welcome offer
    await h.sendInbound("/start", 2001);
    const stateRow1 = await h.stateStore.load(B_ID, h.convId);
    const welcomeOffer = (stateRow1?.state as { offer: any })?.offer;

    // Second turn: customer clicks "حجز موعد"
    const bookCallback = offerCallbackData(welcomeOffer, "book");
    const result = await h.sendInbound(bookCallback, 2002);

    const sent = h.getSentMessages();
    const lastMsg = sent[sent.length - 1];
    const keyboard = lastMsg?.replyMarkup?.inline_keyboard as any[];

    const stateRow2 = await h.stateStore.load(B_ID, h.convId);
    const state = stateRow2?.state as any;

    check(
      "2. Booking entry with valid default skips service selection and presents dates",
      result.ok &&
        state?.serviceId === SRV_CONSULT &&
        state?.serviceSource === "DEFAULT" &&
        state?.offer?.kind === "DATE" &&
        keyboard &&
        keyboard.length > 0 &&
        h.getModelCalls() === 0,
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Scenario 3: Multiple services without default show real service choices
  // ══════════════════════════════════════════════════════════════════════════
  {
    const h = createTestHarness({
      defaultServiceId: null,
      defaultBookingEnabled: false,
    });
    await h.sendInbound("/start", 3001);
    const stateRow1 = await h.stateStore.load(B_ID, h.convId);
    const welcomeOffer = (stateRow1?.state as { offer: any })?.offer;

    const bookCallback = offerCallbackData(welcomeOffer, "book");
    const result = await h.sendInbound(bookCallback, 3002);

    const sent = h.getSentMessages();
    const lastMsg = sent[sent.length - 1];
    const keyboard = lastMsg?.replyMarkup?.inline_keyboard as any[];
    const stateRow2 = await h.stateStore.load(B_ID, h.convId);
    const state = stateRow2?.state as any;

    check(
      "3. Multiple services without default present genuine SERVICE choice offer",
      result.ok &&
        state?.offer?.kind === "SERVICE" &&
        state?.offer?.purpose === "BOOKING" &&
        keyboard &&
        keyboard.length === 3 &&
        h.getModelCalls() === 0,
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Scenario 4: Service -> date -> real slots -> slot selection completes booking
  // Asserting exact appointment fields
  // ══════════════════════════════════════════════════════════════════════════
  {
    const h = createTestHarness({
      defaultServiceId: null,
      defaultBookingEnabled: false,
    });
    // 1. /start
    await h.sendInbound("/start", 4001);
    let state = (await h.stateStore.load(B_ID, h.convId))?.state as any;

    // 2. Click "حجز موعد"
    await h.sendInbound(offerCallbackData(state.offer, "book"), 4002);
    state = (await h.stateStore.load(B_ID, h.convId))?.state as any;

    // 3. Choose service 1 ("كشف عام")
    const serviceCallback = offerCallbackData(state.offer, 1);
    await h.sendInbound(serviceCallback, 4003);
    state = (await h.stateStore.load(B_ID, h.convId))?.state as any;
    const isDateOffer = state?.offer?.kind === "DATE";

    // 4. Choose date 1
    const dateCallback = offerCallbackData(state.offer, 1);
    await h.sendInbound(dateCallback, 4004);
    state = (await h.stateStore.load(B_ID, h.convId))?.state as any;
    const isSlotOffer = state?.offer?.kind === "SLOT";

    // 5. Choose slot 1
    const slotCallback = offerCallbackData(state.offer, 1);
    const bookResult = await h.sendInbound(slotCallback, 4005);
    const appointments = h.getAppointments();
    const apt = appointments[0];

    check(
      "4. Service -> date -> slots -> slot selection completes one isolated booking with exact fields",
      Boolean(
        bookResult.ok &&
        isDateOffer &&
        isSlotOffer &&
        appointments.length === 1 &&
        apt &&
        apt.businessId === B_ID &&
        apt.customerId === "cust-1" &&
        apt.serviceId === SRV_CONSULT &&
        apt.date === "2026-10-22" &&
        apt.startTime === "09:00" &&
        apt.endTime === "09:30" &&
        (apt.providerId === PRV_1 || apt.providerId === PRV_2),
      ),
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Scenario 5: Provider selection / ANY executed through engine, persisted/reloaded,
  // verifying unconstrained provider queries at repository boundary
  // ══════════════════════════════════════════════════════════════════════════
  {
    const convId = "conv-prov-5";
    const h = createTestHarness({ conversationId: convId });
    const providerOffer = buildProviderOffer(
      { businessId: B_ID, conversationId: convId },
      "prov-tok-1",
      {
        serviceId: SRV_CONSULT,
        serviceName: "كشف عام",
        date: "2026-10-23",
        providers: [
          { providerId: PRV_1, name: "د. أحمد" },
          { providerId: PRV_2, name: "د. فاطمة" },
          { providerId: null, name: "أي مقدم خدمة متاح" },
        ],
      },
      SIMULATED_NOW,
    );

    const keyboard = providerOfferKeyboard(providerOffer!) as any;
    const anyBtn = keyboard.inline_keyboard?.find((row: any[]) =>
      row[0]?.text?.includes("أي مقدم خدمة متاح"),
    );

    // Seed state properly with dehydrated state
    let state = emptyConversationState();
    state = {
      ...state,
      offer: providerOffer,
      knownFacts: {
        service: "كشف عام",
        provider: "د. أحمد",
        date: "2026-10-23",
      },
      providerPreference: "د. أحمد",
      serviceId: SRV_CONSULT,
      selectedService: "كشف عام",
    };
    h.stateStore.rows.set(convId, {
      businessId: B_ID,
      revision: 1,
      state: dehydrateConversationState(state),
      updatedAt: new Date(),
    });

    // Customer selects "أي مقدم خدمة متاح" (index 3, providerId: null)
    h.clearAvailabilityQueries();
    const anyCallback = offerCallbackData(providerOffer!, 3);
    const anyTurn = await h.sendInbound(anyCallback, 5001);

    // Persist/reload: verify provider preference removed from durable state
    const reloadedState = (await h.stateStore.load(B_ID, convId))?.state as any;
    const providerFactRemoved = reloadedState.knownFacts?.provider == null;
    const providerPrefCleared = !reloadedState.providerPreference;

    // Verify unconstrained provider queries at repository boundary
    const queries = h.getAvailabilityQueries();
    const queriedUnconstrained = queries.some((q) => q.providerId === null);

    // Next turn: select slot 1 to complete booking
    const slotOffer = reloadedState.offer;
    const isSlotOffer = slotOffer?.kind === "SLOT";
    const slotCb = offerCallbackData(slotOffer, 1);
    await h.sendInbound(slotCb, 5002);
    const apt = h.getAppointments()[0];

    check(
      "5. Provider/ANY executed through engine clears provider preference and queries unconstrained catalog",
      Boolean(
        anyBtn &&
        anyTurn.ok &&
        providerFactRemoved &&
        providerPrefCleared &&
        isSlotOffer &&
        queriedUnconstrained &&
        apt &&
        apt.serviceId === SRV_CONSULT,
      ),
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Scenario 6: Service inquiry preserves active booking facts, displays catalog
  // info, and resumes cleanly
  // ══════════════════════════════════════════════════════════════════════════
  {
    const convId = "conv-inq-6";
    const h = createTestHarness({ conversationId: convId });
    // 1. Establish active booking: /start -> book -> choose service 1 -> choose date 1
    await h.sendInbound("/start", 6001);
    let state = (await h.stateStore.load(B_ID, convId))?.state as any;
    await h.sendInbound(offerCallbackData(state.offer, "book"), 6002);
    state = (await h.stateStore.load(B_ID, convId))?.state as any;
    await h.sendInbound(offerCallbackData(state.offer, 1), 6003); // Service 1 ("كشف عام")
    state = (await h.stateStore.load(B_ID, convId))?.state as any;
    await h.sendInbound(offerCallbackData(state.offer, 1), 6004); // Date 1 ("2026-10-22")
    state = (await h.stateStore.load(B_ID, convId))?.state as any;

    const bookingSlotOffer = state.offer;
    const initialBookingTask = { ...state.activeTask };
    const initialFacts = { ...state.knownFacts };
    const isInitialSlotOffer = bookingSlotOffer?.kind === "SLOT";

    // 2. Inquire about services: present catalog inquiry offer over active booking
    const inqOffer = buildServiceOffer(
      { businessId: B_ID, conversationId: convId },
      "inq-tok-1",
      h.catalogServices.map((s) => ({ id: s.id, name: s.name })),
      SIMULATED_NOW,
      "INQUIRY",
    );
    state = withPresentedOffer(state, inqOffer!);
    h.stateStore.rows.set(convId, {
      businessId: B_ID,
      revision: 10,
      state: dehydrateConversationState(state),
      updatedAt: new Date(),
    });

    const activeTaskPreservedDuringInquiry =
      state.activeTask?.kind === initialBookingTask.kind &&
      state.activeTask?.stage === initialBookingTask.stage;
    const factsPreservedDuringInquiry =
      state.knownFacts?.service === initialFacts.service;
    const suspendedOfferPreserved =
      state.suspendedOffer?.id === bookingSlotOffer.id &&
      state.suspendedOffer?.kind === "SLOT";
    const isInquiryServiceOffer =
      state.offer?.kind === "SERVICE" && state.offer?.purpose === "INQUIRY";

    // 3. Inspect service 2 ("تحاليل معملية")
    await h.sendInbound(offerCallbackData(state.offer, 2), 6006);
    state = (await h.stateStore.load(B_ID, convId))?.state as any;
    const sent = h.getSentMessages();
    const detailMsg = sent[sent.length - 1];
    const hasCatalogPrice = detailMsg?.content.includes("300");
    const hasCatalogDuration = detailMsg?.content.includes("45");
    const appointmentsDuringInquiry = h.getAppointments().length;

    // 4. Customer returns to main menu and resumes booking
    await h.sendInbound(offerCallbackData(state.offer, "menu"), 6007);
    state = (await h.stateStore.load(B_ID, convId))?.state as any;
    // Click "حجز موعد" from menu
    await h.sendInbound(offerCallbackData(state.offer, "book"), 6008);
    state = (await h.stateStore.load(B_ID, convId))?.state as any;
    const resumedSlotOffer =
      state.offer?.kind === "SLOT" && state.offer?.id === bookingSlotOffer.id;

    // Complete the resumed booking
    await h.sendInbound(offerCallbackData(state.offer, 1), 6009);
    const finalAppointments = h.getAppointments();

    check(
      "6. Service inquiry preserves active booking facts, displays catalog info, and resumes cleanly",
      Boolean(
        isInitialSlotOffer &&
        activeTaskPreservedDuringInquiry &&
        factsPreservedDuringInquiry &&
        suspendedOfferPreserved &&
        isInquiryServiceOffer &&
        hasCatalogPrice &&
        hasCatalogDuration &&
        appointmentsDuringInquiry === 0 &&
        resumedSlotOffer &&
        finalAppointments.length === 1 &&
        finalAppointments[0]!.serviceId === SRV_CONSULT,
      ),
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Scenario 7: Free-text correction updates durable state & invalidates stale offer
  // Asserting exact durable facts, availability query args, and previous callback rejection
  // ══════════════════════════════════════════════════════════════════════════
  {
    const convId = "conv-corr-7";
    const h = createTestHarness({ conversationId: convId });
    // 1. Setup active booking on Date 1
    await h.sendInbound("/start", 7001);
    let state = (await h.stateStore.load(B_ID, convId))?.state as any;
    await h.sendInbound(offerCallbackData(state.offer, "book"), 7002);
    state = (await h.stateStore.load(B_ID, convId))?.state as any;
    await h.sendInbound(offerCallbackData(state.offer, 1), 7003); // Service 1 ("كشف عام")
    state = (await h.stateStore.load(B_ID, convId))?.state as any;
    await h.sendInbound(offerCallbackData(state.offer, 1), 7004); // Date 1 ("2026-10-22")
    state = (await h.stateStore.load(B_ID, convId))?.state as any;
    const oldSlotOffer = state.offer;
    const oldSlotCallback = offerCallbackData(oldSlotOffer, 1);

    // 2. Free-text correction with controlled structured model response
    h.setCustomAiResponder(() => ({
      intent: "AVAILABILITY",
      action: "reply",
      content: "تم تغيير اليوم إلى 2026-10-25، إليك المواعيد المتاحة:",
      extraction: {
        service: "كشف عام",
        date: "2026-10-25",
        provider: null,
        timePreference: null,
      },
      handoffReason: null,
      summary: null,
    }));

    h.clearAvailabilityQueries();
    await h.sendInbound("خليه يوم 2026-10-25", 7005);
    state = (await h.stateStore.load(B_ID, convId))?.state as any;

    // Exact durable fact assertion:
    const exactFactUpdated = state.knownFacts?.date === "2026-10-25";

    // Actual availability-query argument assertion at repository boundary:
    const queries = h.getAvailabilityQueries();
    const queriedCorrectDate = queries.some((q) => q.date === "2026-10-25");

    // Rejection of previous dependent callback:
    const oldAptCount = h.getAppointments().length;
    const rejectedTurn = await h.sendInbound(oldSlotCallback, 7006);
    const newAptCount = h.getAppointments().length;
    const oldCallbackRejected =
      oldAptCount === newAptCount && oldAptCount === 0;

    check(
      "7. Free-text correction updates exact durable fact, queries availability for new date, and rejects previous callback",
      Boolean(
        exactFactUpdated &&
        queriedCorrectDate &&
        oldCallbackRejected &&
        rejectedTurn.ok,
      ),
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Scenario 8: /start during an active task preserves valid facts and usable offer
  // ══════════════════════════════════════════════════════════════════════════
  {
    const convId = "conv-start-8";
    const h = createTestHarness({ conversationId: convId });
    await h.sendInbound("/start", 8001);
    let state = (await h.stateStore.load(B_ID, convId))?.state as any;
    await h.sendInbound(offerCallbackData(state.offer, "book"), 8002);
    state = (await h.stateStore.load(B_ID, convId))?.state as any;
    await h.sendInbound(offerCallbackData(state.offer, 1), 8003); // Service 1
    state = (await h.stateStore.load(B_ID, convId))?.state as any;
    await h.sendInbound(offerCallbackData(state.offer, 1), 8004); // Date 1
    state = (await h.stateStore.load(B_ID, convId))?.state as any;

    const initialSlotOffer = state.offer;
    const initialSlotKind = initialSlotOffer?.kind;

    // Customer types /start while slots are waiting for selection
    const startResult = await h.sendInbound("/start", 8005);
    state = (await h.stateStore.load(B_ID, convId))?.state as any;

    const sent = h.getSentMessages();
    const lastMsg = sent[sent.length - 1];

    check(
      "8. /start during active task preserves valid facts and slot offer",
      Boolean(
        startResult.ok &&
        initialSlotKind === "SLOT" &&
        state.offer?.id === initialSlotOffer.id &&
        state.offer?.kind === "SLOT" &&
        lastMsg?.content.includes("المواعيد المقترحة") &&
        h.getModelCalls() === 0,
      ),
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Scenario 9: Staff-owned conversations cannot be resumed by /start or callbacks
  // ══════════════════════════════════════════════════════════════════════════
  {
    const h = createTestHarness({
      initialStatus: "NEED_HUMAN",
      assignedUserId: "staff-operator-1",
    });

    const startTurn = await h.sendInbound("/start", 9001);
    const cbTurn = await h.sendInbound("fp:tokdummy:1", 9002);

    check(
      "9. Staff-owned conversations cannot be resumed by /start or callbacks (DEFERRED_TO_STAFF)",
      Boolean(
        startTurn.ok &&
        !startTurn.duplicate &&
        startTurn.assistantAction === "DEFERRED_TO_STAFF" &&
        cbTurn.ok &&
        !cbTurn.duplicate &&
        cbTurn.assistantAction === "DEFERRED_TO_STAFF" &&
        h.getSentMessages().length === 0,
      ),
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Scenario 10: Foreign tokens, unknown action names, expired, and replaced offers
  // preserve facts and create zero appointments
  // ══════════════════════════════════════════════════════════════════════════
  {
    const convId = "conv-inv-10";
    const h = createTestHarness({ conversationId: convId });
    await h.sendInbound("/start", 10001);
    let state = (await h.stateStore.load(B_ID, convId))?.state as any;
    const initialOfferId = state.offer?.id;

    // 10a. Syntactically valid foreign token (valid format `fp:<8chars>:<action>` from another conversation)
    const foreignCb = "fp:99999999:1";
    await h.sendInbound(foreignCb, 10002);
    state = (await h.stateStore.load(B_ID, convId))?.state as any;
    const factsUnchangedAfterForeign = state.offer?.id === initialOfferId;

    // 10b. Unknown action name on current live offer
    const currentToken = state.offer?.token;
    const unknownActionCb = `fp:${currentToken}:unknown_action_xyz`;
    await h.sendInbound(unknownActionCb, 10003);
    state = (await h.stateStore.load(B_ID, convId))?.state as any;
    const factsUnchangedAfterUnknown = state.offer?.id === initialOfferId;

    // 10c. Genuinely expired offer
    const expiredWelcomeOffer = buildWelcomeOffer(
      { businessId: B_ID, conversationId: convId },
      "tokexp01",
      new Date(SIMULATED_NOW.getTime() - 3600 * 1000),
    );
    (expiredWelcomeOffer as any).expiresAt = new Date(
      SIMULATED_NOW.getTime() - 1000,
    ).toISOString();
    state = { ...state, offer: expiredWelcomeOffer };
    h.stateStore.rows.set(convId, {
      businessId: B_ID,
      revision: 5,
      state: dehydrateConversationState(state),
      updatedAt: new Date(),
    });

    const expiredCb = offerCallbackData(expiredWelcomeOffer!, "book");
    await h.sendInbound(expiredCb, 10004);
    state = (await h.stateStore.load(B_ID, convId))?.state as any;
    const factsUnchangedAfterExpired =
      state.offer?.id === expiredWelcomeOffer!.id;

    // 10d. Replaced/superseded offer
    const supersededOffer = {
      ...expiredWelcomeOffer,
      status: "INVALIDATED",
    };
    state = { ...state, offer: supersededOffer };
    h.stateStore.rows.set(convId, {
      businessId: B_ID,
      revision: 6,
      state: dehydrateConversationState(state),
      updatedAt: new Date(),
    });
    const replacedCb = offerCallbackData(supersededOffer as any, "book");
    await h.sendInbound(replacedCb, 10005);

    const zeroAppointments = h.getAppointments().length === 0;

    check(
      "10. Foreign tokens, unknown action names, expired, and replaced offers preserve facts and create zero appointments",
      Boolean(
        factsUnchangedAfterForeign &&
        factsUnchangedAfterUnknown &&
        factsUnchangedAfterExpired &&
        zeroAppointments,
      ),
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Scenario 11: Duplicate callback delivery does not duplicate booking
  // ══════════════════════════════════════════════════════════════════════════
  {
    const h = createTestHarness();
    await h.sendInbound("/start", 11001);
    let state = (await h.stateStore.load(B_ID, h.convId))?.state as any;
    await h.sendInbound(offerCallbackData(state.offer, "book"), 11002);
    state = (await h.stateStore.load(B_ID, h.convId))?.state as any;
    await h.sendInbound(offerCallbackData(state.offer, 1), 11003);
    state = (await h.stateStore.load(B_ID, h.convId))?.state as any;
    await h.sendInbound(offerCallbackData(state.offer, 1), 11004);
    state = (await h.stateStore.load(B_ID, h.convId))?.state as any;

    // First slot selection tap
    const slotCb = offerCallbackData(state.offer, 1);
    await h.sendInbound(slotCb, 11005);
    const countAfterFirst = h.getAppointments().length;

    // Second tap (or network re-delivery of the exact same callback)
    await h.sendInbound(slotCb, 11005);
    const countAfterRedelivery = h.getAppointments().length;

    // Repeated tap with new updateId but consumed offer
    await h.sendInbound(slotCb, 11006);
    const countAfterReTap = h.getAppointments().length;

    check(
      "11. Duplicate callback delivery and repeated taps do not duplicate booking",
      countAfterFirst === 1 &&
        countAfterRedelivery === 1 &&
        countAfterReTap === 1,
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Scenario 12: Telegram authenticated webhook round trip
  // (webhook -> identity -> engine -> outbound transport + answerCallbackQuery)
  // ══════════════════════════════════════════════════════════════════════════
  {
    const WEBHOOK_SECRET_TOKEN = "webhook-secret-bot-roundtrip-test";
    const SECRET_HASH = hashTelegramWebhookSecret(WEBHOOK_SECRET_TOKEN);

    const acknowledgedCallbacks: string[] = [];
    const outboundDeliveries: Array<{
      chatId: string;
      text: string;
      replyMarkup?: unknown;
    }> = [];

    const h = createTestHarness({ conversationId: "conv-roundtrip-12" });
    // Prepare a welcome offer in state
    await h.sendInbound("/start", 12001);
    const state = (await h.stateStore.load(B_ID, "conv-roundtrip-12"))
      ?.state as any;
    const bookCallbackData = offerCallbackData(state.offer, "book");

    const scheduledWork: Array<Promise<void>> = [];
    const webhookDeps = {
      connectionRepository: {
        findByWebhookSecretHash: async (hash: string) => {
          if (hash === SECRET_HASH) {
            return {
              id: "conn-tg-1",
              businessId: B_ID,
              branchId: BRANCH_ID,
              botExternalId: BOT_EXTERNAL_ID,
              webhookSecretHash: SECRET_HASH,
            };
          }
          return null;
        },
      },
      processInboundMessage: async (params: any) => {
        const turnResult = await engine.receiveInboundMessage(
          h.deps as any,
          params.engineInput,
          params.identity,
        );
        return { ok: turnResult.ok };
      },
      answerCallbackQuery: async (params: { callbackQueryId: string }) => {
        acknowledgedCallbacks.push(params.callbackQueryId);
      },
      schedule: (work: () => Promise<void> | void) => {
        scheduledWork.push(Promise.resolve(work()));
      },
    };

    h.deps.transport.send = async (input: any) => {
      outboundDeliveries.push({
        chatId: input.to,
        text: input.content,
        replyMarkup: input.replyMarkup,
      });
      return { provider: "telegram", delivered: true };
    };

    const updateBody = {
      update_id: 12002,
      callback_query: {
        id: "cq_auth_123",
        from: { id: Number(CHAT_ID), first_name: "Ammar" },
        chat_instance: "inst_123",
        data: bookCallbackData,
        message: {
          message_id: 101,
          date: 1758900000,
          chat: { id: Number(CHAT_ID), type: "private" },
        },
      },
    };

    const req = new Request("http://localhost:3000/api/telegram/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET_TOKEN,
      },
      body: JSON.stringify(updateBody),
    });

    const res = await handleTelegramWebhook(webhookDeps as any, req);
    const resJson = await res.json();
    await Promise.all(scheduledWork);

    const lastOutbound = outboundDeliveries[outboundDeliveries.length - 1];
    const hasReplyMarkup = Boolean(lastOutbound?.replyMarkup);
    const cbAcknowledged = acknowledgedCallbacks.includes("cq_auth_123");

    check(
      "12. Authenticated webhook -> identity -> engine -> outbound client round trip with callback acknowledgment and reply markup",
      res.status === 200 &&
        resJson.success === true &&
        cbAcknowledged &&
        hasReplyMarkup &&
        Buffer.byteLength(bookCallbackData, "utf8") <= 64,
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Scenario 13: Non-interactive fallback works with numbers/text
  // ══════════════════════════════════════════════════════════════════════════
  {
    const h = createTestHarness();
    h.deps.transport.providerName = "generic";

    await h.sendInbound("/start", 13001);
    let state = (await h.stateStore.load(B_ID, h.convId))?.state as any;

    // Customer types "1" to choose "حجز موعد" from welcome offer
    await h.sendInbound("1", 13002);
    state = (await h.stateStore.load(B_ID, h.convId))?.state as any;
    const isServiceOffer = state.offer?.kind === "SERVICE";

    // Customer types "1" to choose service 1
    await h.sendInbound("1", 13003);
    state = (await h.stateStore.load(B_ID, h.convId))?.state as any;
    const isDateOffer = state.offer?.kind === "DATE";

    check(
      "13. Non-interactive fallback handles number-based choices seamlessly",
      Boolean(isServiceOffer && isDateOffer),
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Scenario 14: Protocol boundaries (command boundary & ordinary prose/negation)
  // ══════════════════════════════════════════════════════════════════════════
  {
    const h1 = createTestHarness({ conversationId: "conv-bound-14a" });
    const starterCallsBefore = h1.getModelCalls();
    await h1.sendInbound("/starter", 14001);
    const starterReachedSemantic =
      h1.getModelCalls() === starterCallsBefore + 1;

    const h2 = createTestHarness({ conversationId: "conv-bound-14b" });
    const negationCallsBefore = h2.getModelCalls();
    await h2.sendInbound("بلاش بكرة خليها الأسبوع الجاي", 14002);
    const negationReachedSemantic =
      h2.getModelCalls() === negationCallsBefore + 1;

    check(
      "14. Command boundary rejects /starter from deterministic /start, and negation reaches semantic path intact",
      Boolean(starterReachedSemantic && negationReachedSemantic),
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Summary
  // ══════════════════════════════════════════════════════════════════════════
  const failed = checks.filter((c) => !c.pass);
  console.log("\n──────────────────────────────────────────");
  if (failed.length === 0) {
    console.log(
      `All ${checks.length}/${checks.length} UX001 acceptance checks PASSED.`,
    );
  } else {
    console.error(`${failed.length}/${checks.length} UX001 checks FAILED.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unexpected test failure:", err);
  process.exit(1);
});
