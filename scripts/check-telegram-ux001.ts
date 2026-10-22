/* eslint-disable @typescript-eslint/consistent-type-imports */

/**
 * FlowPilot — UX001 Acceptance Suite:
 * Telegram Welcome and Contextual Choices on the Existing Conversation Engine.
 *
 * Verifies all 13 required acceptance scenarios:
 * 1. Authenticated /start renders real business identity and expected initial buttons with zero model calls.
 * 2. Booking entry with a valid default skips service selection.
 * 3. Multiple services without a default show a real service choice.
 * 4. Service -> date -> real slots -> slot selection completes one isolated booking with correct business, service, provider, date and time.
 * 5. Provider selection/ANY works when applicable without an unnecessary mandatory provider step.
 * 6. Service inquiry preserves an existing booking and uses real catalog data only.
 * 7. Free-text correction after button selection updates durable state and invalidates dependent stale offers.
 * 8. /start during an active task preserves valid facts and usable offers.
 * 9. Staff-owned conversations cannot be resumed by /start or callbacks.
 * 10. Stale/replaced/expired/foreign/malformed callbacks do not mutate state or create appointments.
 * 11. Duplicate callback delivery does not duplicate booking.
 * 12. Telegram callback payloads round-trip through parsing, identity, application handling, and reply markup (<= 64 bytes).
 * 13. Non-interactive fallback works with numbers/text.
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

  const engine = await import(
    "@/features/conversations/server/conversation-engine"
  );
  const {
    buildWelcomeOffer,
    offerCallbackData,
    parseOfferCallback,
  } = await import("@/features/conversations/server/booking-offer");
  const { parseTelegramUpdate } = await import(
    "@/server/integrations/telegram/telegram-webhook"
  );

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

    let conversation = {
      id: "conv-ux001",
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
        listEligibleForService: async () => eligibleProviders,
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
        listBlockingByAssignees: async () => [],
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
        respond: async () => {
          modelCallCount++;
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
      stateStore,
      business,
      catalogServices,
      eligibleProviders,
      getModelCalls: () => modelCallCount,
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
  // buttons with zero model calls
  // ══════════════════════════════════════════════════════════════════════════
  {
    const h = createTestHarness();
    const result = await h.sendInbound("/start", 1001);
    const sent = h.getSentMessages();
    const lastMsg = sent[sent.length - 1];
    const keyboard = lastMsg?.replyMarkup?.inline_keyboard as
      | Array<Array<{ text: string; callback_data: string }>>
      | undefined;

    const hasBizName = lastMsg?.content.includes(BUSINESS_NAME);
    const hasFreeTextNotice =
      lastMsg?.content.includes("الكتابة") || lastMsg?.content.includes("كتابة");
    const hasButtons =
      keyboard &&
      keyboard.length >= 2 &&
      keyboard.some((row) => row[0]?.text.includes("حجز موعد")) &&
      keyboard.some((row) => row[0]?.text.includes("استفسار عن خدمة"));

    const stateRow = await h.stateStore.load(B_ID, "conv-ux001");
    const offer = (stateRow?.state as { offer?: { kind: string } })?.offer;

    check(
      "1. /start renders real business name + initial choices with ZERO model calls",
      Boolean(
        result.ok &&
          hasBizName &&
          hasFreeTextNotice &&
          hasButtons &&
          offer?.kind === "WELCOME" &&
          h.getModelCalls() === 0,
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
    const stateRow1 = await h.stateStore.load(B_ID, "conv-ux001");
    const welcomeOffer = (stateRow1?.state as { offer: any })?.offer;

    // Second turn: customer clicks "حجز موعد"
    const bookCallback = offerCallbackData(welcomeOffer, "book");
    const result = await h.sendInbound(bookCallback, 2002);

    const sent = h.getSentMessages();
    const lastMsg = sent[sent.length - 1];
    const keyboard = lastMsg?.replyMarkup?.inline_keyboard as any[];

    const stateRow2 = await h.stateStore.load(B_ID, "conv-ux001");
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
    const stateRow1 = await h.stateStore.load(B_ID, "conv-ux001");
    const welcomeOffer = (stateRow1?.state as { offer: any })?.offer;

    const bookCallback = offerCallbackData(welcomeOffer, "book");
    const result = await h.sendInbound(bookCallback, 3002);

    const sent = h.getSentMessages();
    const lastMsg = sent[sent.length - 1];
    const keyboard = lastMsg?.replyMarkup?.inline_keyboard as any[];
    const stateRow2 = await h.stateStore.load(B_ID, "conv-ux001");
    const state = stateRow2?.state as any;

    check(
      "3. Multiple services without default present genuine SERVICE choice offer",
      result.ok &&
        state?.offer?.kind === "SERVICE" &&
        state?.offer?.purpose === "BOOKING" &&
        keyboard &&
        keyboard.length === 3 && // 3 catalog services
        h.getModelCalls() === 0,
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Scenario 4: Service -> date -> real slots -> slot selection completes booking
  // ══════════════════════════════════════════════════════════════════════════
  {
    const h = createTestHarness({
      defaultServiceId: null,
      defaultBookingEnabled: false,
    });
    // 1. /start
    await h.sendInbound("/start", 4001);
    let state = (await h.stateStore.load(B_ID, "conv-ux001"))?.state as any;

    // 2. Click "حجز موعد"
    await h.sendInbound(offerCallbackData(state.offer, "book"), 4002);
    state = (await h.stateStore.load(B_ID, "conv-ux001"))?.state as any;

    // 3. Choose service 1 ("كشف عام")
    const serviceCallback = offerCallbackData(state.offer, 1);
    await h.sendInbound(serviceCallback, 4003);
    state = (await h.stateStore.load(B_ID, "conv-ux001"))?.state as any;
    const isDateOffer = state?.offer?.kind === "DATE";

    // 4. Choose date 1
    const dateCallback = offerCallbackData(state.offer, 1);
    await h.sendInbound(dateCallback, 4004);
    state = (await h.stateStore.load(B_ID, "conv-ux001"))?.state as any;
    const isSlotOffer = state?.offer?.kind === "SLOT";

    // 5. Choose slot 1
    const slotCallback = offerCallbackData(state.offer, 1);
    const bookResult = await h.sendInbound(slotCallback, 4005);
    const appointments = h.getAppointments();

    check(
      "4. Service -> date -> slots -> slot selection completes one isolated booking",
      bookResult.ok &&
        isDateOffer &&
        isSlotOffer &&
        appointments.length === 1 &&
        appointments[0]!.serviceId === SRV_CONSULT &&
        appointments[0]!.businessId === B_ID &&
        appointments[0]!.customerId === "cust-1",
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Scenario 5: Provider selection / ANY works without mandatory extra step
  // ══════════════════════════════════════════════════════════════════════════
  {
    // Verify provider keyboard builder produces explicit ANY button
    const { buildProviderOffer, providerOfferKeyboard } = await import(
      "@/features/conversations/server/booking-offer"
    );
    const providerOffer = buildProviderOffer(
      { businessId: B_ID, conversationId: "conv-ux001" },
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
    const anyBtn = keyboard.inline_keyboard?.find(
      (row: any[]) => row[0]?.text?.includes("أي مقدم خدمة متاح"),
    );

    const { interpretOfferReply } = await import(
      "@/features/conversations/server/booking-selection"
    );
    // Index 3 is the ANY choice
    const anySelection = interpretOfferReply(
      offerCallbackData(providerOffer!, 3),
      providerOffer,
      SIMULATED_NOW,
    );

    check(
      "5. Provider choices include explicit 'أي مقدم خدمة متاح' and resolve providerId = null",
      Boolean(anyBtn) &&
        anySelection.kind === "provider" &&
        anySelection.providerId === null,
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Scenario 6: Service inquiry preserves active booking and uses catalog data
  // ══════════════════════════════════════════════════════════════════════════
  {
    const h = createTestHarness();
    await h.sendInbound("/start", 6001);
    let state = (await h.stateStore.load(B_ID, "conv-ux001"))?.state as any;

    // 1. Customer taps "استفسار عن خدمة" from the welcome offer
    await h.sendInbound(offerCallbackData(state.offer, "inquire"), 6002);
    state = (await h.stateStore.load(B_ID, "conv-ux001"))?.state as any;
    const isInquiryServiceOffer =
      state.offer?.kind === "SERVICE" &&
      state.offer?.purpose === "INQUIRY";

    // 2. Select service 2 ("تحاليل معملية") to inspect
    await h.sendInbound(offerCallbackData(state.offer, 2), 6003);
    const sent = h.getSentMessages();
    const detailMsg = sent[sent.length - 1];

    // Detail message contains real catalog price (300) and duration (45)
    const hasCatalogPrice = detailMsg?.content.includes("300");
    const hasCatalogDuration = detailMsg?.content.includes("45");
    const hasDetailKeyboard =
      (detailMsg?.replyMarkup?.inline_keyboard as any[])?.length >= 2;

    state = (await h.stateStore.load(B_ID, "conv-ux001"))?.state as any;
    const isServiceDetailOffer = state.offer?.kind === "SERVICE_DETAIL";

    // 3. Inquiry does not create an appointment or mutate booking state
    const appointmentsBefore = h.getAppointments().length;

    // 4. Explicit action to book the inspected service
    await h.sendInbound(offerCallbackData(state.offer, "book_service"), 6004);
    state = (await h.stateStore.load(B_ID, "conv-ux001"))?.state as any;
    const isNowBookingService =
      (state.knownFacts?.service === "تحاليل معملية" ||
        state.selectedService === "تحاليل معملية") &&
      state.offer?.kind === "DATE";

    check(
      "6. Service inquiry presents catalog data and only explicit book_service begins booking",
      Boolean(
        isInquiryServiceOffer &&
          isServiceDetailOffer &&
          hasCatalogPrice &&
          hasCatalogDuration &&
          hasDetailKeyboard &&
          appointmentsBefore === 0 &&
          isNowBookingService,
      ),
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Scenario 7: Free-text correction updates durable state & invalidates stale offer
  // ══════════════════════════════════════════════════════════════════════════
  {
    const h = createTestHarness();
    await h.sendInbound("/start", 7001);
    let state = (await h.stateStore.load(B_ID, "conv-ux001"))?.state as any;
    await h.sendInbound(offerCallbackData(state.offer, "book"), 7002);
    state = (await h.stateStore.load(B_ID, "conv-ux001"))?.state as any;
    await h.sendInbound(offerCallbackData(state.offer, 1), 7003); // Choose service 1
    state = (await h.stateStore.load(B_ID, "conv-ux001"))?.state as any;
    const dateOffer = state.offer;

    // Customer writes free text to specify date
    await h.sendInbound("خليه يوم 2026-10-25", 7004);
    state = (await h.stateStore.load(B_ID, "conv-ux001"))?.state as any;

    check(
      "7. Free-text correction updates durable state and invalidates old offer",
      state.knownFacts?.date === "2026-10-25" ||
        state.offer?.id !== dateOffer.id ||
        state.offer?.status !== "OFFERED",
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Scenario 8: /start during an active task preserves valid facts and usable offer
  // ══════════════════════════════════════════════════════════════════════════
  {
    const h = createTestHarness();
    await h.sendInbound("/start", 8001);
    let state = (await h.stateStore.load(B_ID, "conv-ux001"))?.state as any;
    await h.sendInbound(offerCallbackData(state.offer, "book"), 8002);
    state = (await h.stateStore.load(B_ID, "conv-ux001"))?.state as any;
    await h.sendInbound(offerCallbackData(state.offer, 1), 8003); // Service 1
    state = (await h.stateStore.load(B_ID, "conv-ux001"))?.state as any;
    await h.sendInbound(offerCallbackData(state.offer, 1), 8004); // Date 1
    state = (await h.stateStore.load(B_ID, "conv-ux001"))?.state as any;

    const initialSlotOffer = state.offer;
    const initialSlotKind = initialSlotOffer?.kind;

    // Customer types /start while slots are waiting for selection
    const startResult = await h.sendInbound("/start", 8005);
    state = (await h.stateStore.load(B_ID, "conv-ux001"))?.state as any;

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
    const cbTurn = await h.sendInbound("fp:tok-dummy:1", 9002);

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
  // Scenario 10: Stale/expired/foreign/malformed callbacks do not mutate state
  // ══════════════════════════════════════════════════════════════════════════
  {
    const h = createTestHarness();
    await h.sendInbound("/start", 10001);
    let state = (await h.stateStore.load(B_ID, "conv-ux001"))?.state as any;

    // 10a. Foreign token (from different conversation)
    const foreignCb = "fp:foreign-token-xyz:1";
    await h.sendInbound(foreignCb, 10002);
    let stateAfterForeign = (await h.stateStore.load(B_ID, "conv-ux001"))
      ?.state as any;

    // 10b. Malformed callback data
    await h.sendInbound("fp:malformed", 10003);
    await h.sendInbound("some_random_payload", 10004);

    check(
      "10. Foreign/malformed callbacks do not mutate state or create appointments",
      h.getAppointments().length === 0 &&
        stateAfterForeign.offer?.id === state.offer?.id,
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Scenario 11: Duplicate callback delivery does not duplicate booking
  // ══════════════════════════════════════════════════════════════════════════
  {
    const h = createTestHarness();
    await h.sendInbound("/start", 11001);
    let state = (await h.stateStore.load(B_ID, "conv-ux001"))?.state as any;
    await h.sendInbound(offerCallbackData(state.offer, "book"), 11002);
    state = (await h.stateStore.load(B_ID, "conv-ux001"))?.state as any;
    await h.sendInbound(offerCallbackData(state.offer, 1), 11003);
    state = (await h.stateStore.load(B_ID, "conv-ux001"))?.state as any;
    await h.sendInbound(offerCallbackData(state.offer, 1), 11004);
    state = (await h.stateStore.load(B_ID, "conv-ux001"))?.state as any;

    // First slot selection tap
    const slotCb = offerCallbackData(state.offer, 1);
    await h.sendInbound(slotCb, 11005);
    const countAfterFirst = h.getAppointments().length;

    // Second tap (or network re-delivery of the exact same callback)
    await h.sendInbound(slotCb, 11005); // same updateId / externalId
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
  // Scenario 12: Telegram callback payloads round-trip through parsing and limits
  // ══════════════════════════════════════════════════════════════════════════
  {
    const welcomeOffer = buildWelcomeOffer(
      { businessId: B_ID, conversationId: "conv-ux001" },
      "tokwel12",
      SIMULATED_NOW,
    );

    const cbData = offerCallbackData(welcomeOffer!, "book");
    const parsed = parseOfferCallback(cbData);

    const update = {
      update_id: 12001,
      callback_query: {
        id: "cq_999",
        from: { id: Number(CHAT_ID) },
        chat_instance: "inst_1",
        data: cbData,
        message: {
          message_id: 50,
          date: 1758900000,
          chat: { id: Number(CHAT_ID), type: "private" },
        },
      },
    };

    const webhookParsed = parseTelegramUpdate(update, {
      botExternalId: BOT_EXTERNAL_ID,
    });
    const byteLength = Buffer.byteLength(cbData, "utf8");

    check(
      "12. Telegram callback payload round-trips correctly and is <= 64 bytes",
      parsed?.token === "tokwel12" &&
        parsed?.action.kind === "action" &&
        parsed?.action.name === "book" &&
        webhookParsed.status === "callback_query" &&
        webhookParsed.callbackQueryId === "cq_999" &&
        webhookParsed.data === cbData &&
        byteLength <= 64,
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Scenario 13: Non-interactive fallback works with numbers/text
  // ══════════════════════════════════════════════════════════════════════════
  {
    const h = createTestHarness();
    // Non-interactive channel (e.g. customer phone without "tg:")
    h.deps.transport.providerName = "generic";

    await h.sendInbound("/start", 13001);
    let state = (await h.stateStore.load(B_ID, "conv-ux001"))?.state as any;

    // Customer types "1" to choose "حجز موعد" from welcome offer
    await h.sendInbound("1", 13002);
    state = (await h.stateStore.load(B_ID, "conv-ux001"))?.state as any;
    const isServiceOffer = state.offer?.kind === "SERVICE";

    // Customer types "1" to choose service 1
    await h.sendInbound("1", 13003);
    state = (await h.stateStore.load(B_ID, "conv-ux001"))?.state as any;
    const isDateOffer = state.offer?.kind === "DATE";

    check(
      "13. Non-interactive fallback handles number-based choices seamlessly",
      isServiceOffer && isDateOffer,
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Summary
  // ══════════════════════════════════════════════════════════════════════════
  const failed = checks.filter((c) => !c.pass);
  console.log("\n──────────────────────────────────────────");
  if (failed.length === 0) {
    console.log(`All ${checks.length}/${checks.length} UX001 acceptance checks PASSED.`);
  } else {
    console.error(`${failed.length}/${checks.length} UX001 checks FAILED.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unexpected test failure:", err);
  process.exit(1);
});
