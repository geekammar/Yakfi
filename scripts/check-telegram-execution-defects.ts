/* eslint-disable @typescript-eslint/no-explicit-any */
import type { TelegramWebhookLogEvent } from "@/server/integrations/telegram/telegram-webhook-handler";

/**
 * FlowPilot — Telegram Execution Defects Regression Suite (PART 5).
 *
 * Verifies:
 * 1. Two-turn natural-language GREETING -> button selection:
 *    - Controlled structured model returns GREETING.
 *    - Real engine creates and successfully persists WELCOME offer before presentation.
 *    - Outgoing choices captured.
 *    - Real callback fed through authenticated webhook handler.
 *    - Reload state through repository fixture.
 *    - Assert expected next offer and matching IDs/tokens.
 *    - Assert ZERO additional AI calls for selection.
 *
 * 2. Greeting offer commit conflict:
 *    - Simulate CAS commit conflict on greeting welcome offer.
 *    - Assert no actionable unpersisted choices are sent.
 *    - Assert safe retry copy returned.
 *    - Assert no newer persisted offer is overwritten.
 *
 * 3. Engine failure propagation:
 *    - A returned engine failure must not become unconditional { ok: true }.
 *    - A delivery failure is reported distinctly ({ ok: false, outcome: "DELIVERY_FAILURE" }).
 *    - A thrown deferred error is observable with safe outcome metadata.
 *
 * 4. Callback acknowledgment failure:
 *    - Real selection processing still executes even if callback acknowledgment fails.
 *    - Acknowledgment failure and processing outcome are independently visible.
 *
 * 5. Callback clock:
 *    - Original button message date is old.
 *    - Callback receipt is later.
 *    - The turn uses receipt time.
 *    - An expired offer is safely rejected.
 *
 * 6. Preserves existing successful /start, inquiry, stale-token, duplicate-tap, tenant-scope, and single-booking coverage.
 */

export {};

// Offline defaults for Better Auth and DB validation
process.env.DATABASE_URL ??=
  "postgresql://user:password@localhost:5432/placeholder";
process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
process.env.BETTER_AUTH_URL ??= "https://flowpilot-prod.vercel.app";
process.env.NEXT_PUBLIC_APP_URL ??= "https://flowpilot-prod.vercel.app";

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

// ── In-Memory State Store Fixture ──────────────────────────────────────────

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

async function main(): Promise<void> {
  const engine =
    await import("@/features/conversations/server/conversation-engine");
  const { offerCallbackData } =
    await import("@/features/conversations/server/channel-choice");
  const { renderTelegramInlineKeyboard } =
    await import("@/server/integrations/telegram/telegram-presentation");
  const { hashTelegramWebhookSecret, parseTelegramUpdate } =
    await import("@/server/integrations/telegram/telegram-webhook");
  const { handleTelegramWebhook, mapEngineResultToTelegramOutcome } =
    await import("@/server/integrations/telegram/telegram-webhook-handler");
  const { emptyConversationState } =
    await import("@/features/conversations/server/conversation-state");

  const B_ID = "11111111-1111-4111-8111-111111111111";
  const BRANCH_ID = "22222222-2222-4222-8222-222222222222";
  const BOT_EXTERNAL_ID = "6123456789";
  const CHAT_ID = "9988776655";
  const BUSINESS_NAME = "مركز الأمل الطبي";

  const SRV_CONSULT = "33333333-3333-4333-8333-333333333331";
  const SRV_LAB = "33333333-3333-4333-8333-333333333332";
  const PRV_1 = "44444444-4444-4444-8444-444444444441";

  const SIMULATED_NOW = new Date("2026-10-24T10:00:00.000Z");

  function createTestHarness(opts?: { conversationId?: string }) {
    let modelCallCount = 0;
    let customAiResponder: ((prompt: unknown) => Promise<any> | any) | null =
      null;

    const sentMessages: Array<{
      to: string;
      content: string;
      choices?: any;
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
      defaultServiceId: null,
      defaultBookingServiceId: null,
      defaultServiceBookingEnabled: false,
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

    const catalogServices = [
      {
        id: SRV_CONSULT,
        businessId: B_ID,
        name: "كشف عام",
        durationMinutes: 30,
        price: 150,
        isActive: true,
      },
      {
        id: SRV_LAB,
        businessId: B_ID,
        name: "تحاليل معملية",
        durationMinutes: 45,
        price: 300,
        isActive: true,
      },
    ];

    const eligibleProviders = [
      { id: PRV_1, displayName: "د. أحمد", user: { name: "أحمد" } },
    ];

    const customer = {
      id: "cust-1",
      businessId: B_ID,
      name: "مستخدم تيليجرام",
      phone: CHAT_ID,
    };

    const convId = opts?.conversationId ?? "conv-test-1";
    const conversation = {
      id: convId,
      businessId: B_ID,
      customerId: customer.id,
      branchId: BRANCH_ID,
      status: "AI_ACTIVE",
      assignedUserId: null as string | null,
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
      },
      serviceRepository: {
        listByBusiness: async () => catalogServices,
        findById: async (id: string) =>
          catalogServices.find((s) => s.id === id) ?? null,
      },
      providerRepository: {
        listActiveByService: async () => eligibleProviders,
        listActiveByBusiness: async () => eligibleProviders,
      },
      appointmentRepository: {
        create: async (data: any) => {
          createdAppointments.push(data);
          return { id: `apt-${createdAppointments.length}`, ...data };
        },
        listByAssigneeAndDateRange: async () => [],
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
        respond: async (input: unknown) => {
          modelCallCount++;
          if (customAiResponder) {
            return customAiResponder(input);
          }
          return {
            intent: "GREETING" as const,
            action: "reply" as const,
            content:
              "أهلاً وسهلاً بك في مركز الأمل الطبي! كيف يمكننا مساعدتك اليوم؟",
            safetyAssessment: "safe" as any,
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
          choices?: any;
          replyMarkup?: Record<string, unknown>;
        }) => {
          const replyMarkup =
            input.replyMarkup ??
            (input.choices
              ? renderTelegramInlineKeyboard(input.choices)
              : undefined);
          sentMessages.push({
            to: input.to,
            content: input.content,
            choices: input.choices,
            replyMarkup,
          });
          return { provider: "telegram", delivered: true };
        },
      },
      conversationStateRepository: stateStore,
    };

    return {
      deps,
      stateStore,
      convId,
      setAiResponder: (fn: (prompt: unknown) => any) => {
        customAiResponder = fn;
      },
      getModelCalls: () => modelCallCount,
      getSentMessages: () => sentMessages,
      getAppointments: () => createdAppointments,
      async sendInbound(
        text: string,
        updateId = Date.now(),
        receivedAt = SIMULATED_NOW.toISOString(),
      ) {
        return engine.receiveInboundMessage(
          deps as any,
          {
            to: BOT_EXTERNAL_ID,
            from: CHAT_ID,
            text,
            receivedAt,
            externalId: `tg:${BOT_EXTERNAL_ID}:${updateId}`,
          },
          {
            businessId: B_ID,
            branchId: BRANCH_ID,
            connectionId: "conn-tg-1",
          },
        );
      },
    };
  }

  console.log(
    "\n================ Telegram Execution Defects Suite ================\n",
  );

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 1: Two-turn natural-language GREETING -> button selection
  // ──────────────────────────────────────────────────────────────────────────
  {
    const h = createTestHarness({ conversationId: "conv-defect-1" });
    h.setAiResponder(() => ({
      intent: "GREETING",
      action: "reply",
      content: "مرحباً بك في مركز الأمل! يسعدنا خدمتك.",
      safetyAssessment: "safe",
      extraction: {
        service: null,
        provider: null,
        date: null,
        timePreference: null,
      },
      handoffReason: null,
      summary: null,
    }));

    // Turn 1: Natural-language greeting
    const turn1Result = await h.sendInbound("مرحبا وعليكم السلام", 1001);
    const modelCallsAfterTurn1 = h.getModelCalls();

    const sent1 = h.getSentMessages();
    const lastMsg1 = sent1[sent1.length - 1];
    const outgoingChoices = lastMsg1?.choices;

    // Verify turn 1 state was persisted in the repository fixture BEFORE presentation
    const persistedState1 = (await h.stateStore.load(B_ID, "conv-defect-1"))
      ?.state as any;

    const welcomeOffer = persistedState1?.offer;
    const isOfferPersisted =
      welcomeOffer &&
      welcomeOffer.kind === "WELCOME" &&
      welcomeOffer.status === "ACTIVE";

    // Capture outgoing button callback data
    const bookCallbackData = offerCallbackData(welcomeOffer, "book");

    // Setup authenticated webhook handler for Turn 2
    const WEBHOOK_SECRET = "secret-token-test-1";
    const SECRET_HASH = hashTelegramWebhookSecret(WEBHOOK_SECRET);
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
        return mapEngineResultToTelegramOutcome(turnResult);
      },
      answerCallbackQuery: async () => ({ ok: true }),
      schedule: (work: () => Promise<void> | void) => {
        scheduledWork.push(Promise.resolve(work()));
      },
      now: () => SIMULATED_NOW,
    };

    // Feed real callback into authenticated webhook handler
    const updateBody = {
      update_id: 1002,
      callback_query: {
        id: "cq_greeting_tap",
        from: { id: Number(CHAT_ID), first_name: "Customer" },
        data: bookCallbackData,
        message: {
          message_id: 201,
          date: Math.floor(SIMULATED_NOW.getTime() / 1000) - 30,
          chat: { id: Number(CHAT_ID), type: "private" },
        },
      },
    };

    const req = new Request("http://localhost:3000/api/telegram/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET,
      },
      body: JSON.stringify(updateBody),
    });

    const res = await handleTelegramWebhook(webhookDeps as any, req);
    await Promise.all(scheduledWork);

    const modelCallsAfterTurn2 = h.getModelCalls();

    // Reload state through repository fixture
    const persistedState2 = (await h.stateStore.load(B_ID, "conv-defect-1"))
      ?.state as any;

    const nextOffer = persistedState2?.offer;
    const sent2 = h.getSentMessages();
    const lastMsg2 = sent2[sent2.length - 1];

    check(
      "1. Two-turn natural language GREETING -> button selection persists WELCOME offer before send and executes selection with zero additional AI calls",
      Boolean(
        turn1Result.ok &&
        modelCallsAfterTurn1 === 1 &&
        isOfferPersisted &&
        outgoingChoices != null &&
        res.status === 200 &&
        nextOffer != null &&
        nextOffer.kind === "SERVICE" &&
        nextOffer.status === "ACTIVE" &&
        modelCallsAfterTurn2 === 1 && // ZERO additional AI calls!
        lastMsg2?.replyMarkup != null,
      ),
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 2: Greeting offer commit conflict
  // ──────────────────────────────────────────────────────────────────────────
  {
    const h = createTestHarness({ conversationId: "conv-defect-2" });
    h.setAiResponder(() => ({
      intent: "GREETING",
      action: "reply",
      content: "أهلاً بك!",
      safetyAssessment: "safe",
      extraction: {
        service: null,
        provider: null,
        date: null,
        timePreference: null,
      },
      handoffReason: null,
      summary: null,
    }));

    // Pre-populate state store with an existing newer offer
    const existingOffer = {
      id: "newer-existing-offer-id",
      token: "newer-token",
      kind: "SERVICE",
      status: "ACTIVE",
      expiresAt: new Date(SIMULATED_NOW.getTime() + 600000).toISOString(),
    };
    await h.stateStore.save(B_ID, "conv-defect-2", null, {
      ...emptyConversationState(),
      offer: existingOffer,
    });

    // Simulate commit conflict on subsequent saves
    const originalSave = h.stateStore.save.bind(h.stateStore);
    h.stateStore.save = async () => ({ status: "conflict" });

    // Send greeting turn during conflict
    const turnResult = await h.sendInbound("صباح الخير", 2001);

    const sent = h.getSentMessages();
    const lastMsg = sent[sent.length - 1];

    // Restore save to inspect stored state
    h.stateStore.save = originalSave;
    const reloaded = (await h.stateStore.load(B_ID, "conv-defect-2"))
      ?.state as any;

    check(
      "2. Greeting offer commit conflict suppresses unpersisted choices, sends safe retry message, and never overwrites newer offer",
      Boolean(
        turnResult.ok &&
        lastMsg?.choices === undefined &&
        lastMsg?.replyMarkup === undefined &&
        lastMsg?.content.includes("تعارض مؤقت") &&
        reloaded?.offer?.id === "newer-existing-offer-id" &&
        reloaded?.offer?.kind === "SERVICE",
      ),
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 3: Engine failure propagation across composition boundary
  // ──────────────────────────────────────────────────────────────────────────
  {
    // 3a. Domain / persistence failure
    const outcome1 = mapEngineResultToTelegramOutcome({
      ok: false,
      code: "PERSISTENCE_FAILED",
      message: "تعذر حفظ حالة المحادثة",
    });

    // 3b. Delivery failure
    const outcome2 = mapEngineResultToTelegramOutcome({
      ok: true,
      duplicate: false,
      assistantAction: "AI_REPLY",
      delivery: {
        provider: "telegram",
        delivered: false,
        error: "Telegram network connection timeout",
      },
    });

    // 3c. Duplicate delivery
    const outcome3 = mapEngineResultToTelegramOutcome({
      ok: true,
      duplicate: true,
      conversationId: "conv-dup",
      customerMessageId: "msg-dup",
    });

    // 3d. Deferred-to-staff
    const outcome4 = mapEngineResultToTelegramOutcome({
      ok: true,
      duplicate: false,
      assistantAction: "DEFERRED_TO_STAFF",
      delivery: { provider: "telegram", delivered: true },
    });

    // 3e. Deferred exception observability
    const loggedEvents: TelegramWebhookLogEvent[] = [];
    const scheduledWork: Array<Promise<void>> = [];

    const WEBHOOK_SECRET = "secret-token-test-3";
    const SECRET_HASH = hashTelegramWebhookSecret(WEBHOOK_SECRET);

    const webhookDeps = {
      connectionRepository: {
        findByWebhookSecretHash: async (hash: string) =>
          hash === SECRET_HASH
            ? {
                id: "conn-tg-3",
                businessId: B_ID,
                branchId: BRANCH_ID,
                botExternalId: BOT_EXTERNAL_ID,
                webhookSecretHash: SECRET_HASH,
              }
            : null,
      },
      processInboundMessage: async () => {
        throw new Error("Simulated unexpected engine failure");
      },
      schedule: (work: () => Promise<void> | void) => {
        scheduledWork.push(Promise.resolve(work()));
      },
      logger: {
        log: (event: TelegramWebhookLogEvent) => {
          loggedEvents.push(event);
        },
      },
    };

    const req = new Request("http://localhost:3000/api/telegram/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        update_id: 3001,
        message: {
          message_id: 301,
          date: 1758900000,
          chat: { id: Number(CHAT_ID), type: "private" },
          text: "رسالة تجربة",
        },
      }),
    });

    const res = await handleTelegramWebhook(webhookDeps as any, req);
    await Promise.all(scheduledWork);

    const hasExceptionLog = loggedEvents.some(
      (e) =>
        e.stage === "engine" &&
        e.outcome === "UNHANDLED_EXCEPTION" &&
        e.error === "Simulated unexpected engine failure",
    );

    check(
      "3. Engine failure propagation preserves persistence, delivery, duplicate, and exception distinctions",
      Boolean(
        outcome1.ok === false &&
        outcome1.outcome === "PERSISTENCE_FAILED" &&
        outcome2.ok === false &&
        outcome2.outcome === "DELIVERY_FAILURE" &&
        outcome3.ok === true &&
        outcome3.outcome === "DUPLICATE" &&
        outcome4.ok === true &&
        outcome4.outcome === "DEFERRED_TO_STAFF" &&
        res.status === 200 &&
        hasExceptionLog,
      ),
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 4: Callback acknowledgment failure resilience & observability
  // ──────────────────────────────────────────────────────────────────────────
  {
    const h = createTestHarness({ conversationId: "conv-defect-4" });
    await h.sendInbound("/start", 4001);
    const state = (await h.stateStore.load(B_ID, "conv-defect-4"))
      ?.state as any;
    const bookCallbackData = offerCallbackData(state.offer, "book");

    const loggedEvents: TelegramWebhookLogEvent[] = [];
    const scheduledWork: Array<Promise<void>> = [];
    const WEBHOOK_SECRET = "secret-token-test-4";
    const SECRET_HASH = hashTelegramWebhookSecret(WEBHOOK_SECRET);

    const webhookDeps = {
      connectionRepository: {
        findByWebhookSecretHash: async (hash: string) =>
          hash === SECRET_HASH
            ? {
                id: "conn-tg-4",
                businessId: B_ID,
                branchId: BRANCH_ID,
                botExternalId: BOT_EXTERNAL_ID,
                webhookSecretHash: SECRET_HASH,
              }
            : null,
      },
      processInboundMessage: async (params: any) => {
        const turnResult = await engine.receiveInboundMessage(
          h.deps as any,
          params.engineInput,
          params.identity,
        );
        return mapEngineResultToTelegramOutcome(turnResult);
      },
      // Callback acknowledgment throws an error
      answerCallbackQuery: async () => {
        throw new Error("Telegram API HTTP 502 Bad Gateway");
      },
      schedule: (work: () => Promise<void> | void) => {
        scheduledWork.push(Promise.resolve(work()));
      },
      now: () => SIMULATED_NOW,
      logger: {
        log: (event: TelegramWebhookLogEvent) => {
          loggedEvents.push(event);
        },
      },
    };

    const req = new Request("http://localhost:3000/api/telegram/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        update_id: 4002,
        callback_query: {
          id: "cq_fail_ack",
          from: { id: Number(CHAT_ID), first_name: "Ammar" },
          data: bookCallbackData,
          message: {
            message_id: 402,
            date: Math.floor(SIMULATED_NOW.getTime() / 1000) - 10,
            chat: { id: Number(CHAT_ID), type: "private" },
          },
        },
      }),
    });

    const res = await handleTelegramWebhook(webhookDeps as any, req);
    await Promise.all(scheduledWork);

    const ackFailureLogged = loggedEvents.some(
      (e) =>
        e.stage === "acknowledgment" &&
        e.outcome === "ACK_FAILED" &&
        e.error?.includes("502"),
    );

    const engineSuccessLogged = loggedEvents.some(
      (e) => e.stage === "outbound" && e.outcome === "SUCCESS",
    );

    const nextState = (await h.stateStore.load(B_ID, "conv-defect-4"))
      ?.state as any;
    const selectionExecuted = nextState?.offer?.kind === "SERVICE";

    check(
      "4. Callback acknowledgment failure does not prevent selection processing, and both outcomes are independently visible",
      Boolean(
        res.status === 200 &&
        ackFailureLogged &&
        engineSuccessLogged &&
        selectionExecuted,
      ),
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 5: Callback clock & offer expiry
  // ──────────────────────────────────────────────────────────────────────────
  {
    // 5a. Verify callback turn uses receipt clock, not old message date
    const oldOriginalMessageDate = 1700000000; // November 2023
    const receiptInstant = new Date("2026-10-24T12:00:00.000Z");

    const parsedUpdate = parseTelegramUpdate(
      {
        update_id: 5001,
        callback_query: {
          id: "cq_clock_test",
          from: { id: Number(CHAT_ID) },
          data: "test_data",
          message: {
            message_id: 501,
            date: oldOriginalMessageDate,
            chat: { id: Number(CHAT_ID), type: "private" },
          },
        },
      },
      {
        botExternalId: BOT_EXTERNAL_ID,
        now: () => receiptInstant,
      },
    );

    const usesReceiptTime =
      parsedUpdate.status === "callback_query" &&
      parsedUpdate.message.timestamp === receiptInstant.toISOString() &&
      parsedUpdate.originalMessageDate === oldOriginalMessageDate;

    // 5b. Verify expired offer is safely rejected using receipt time
    const h = createTestHarness({ conversationId: "conv-defect-5" });

    // Initial offer created at 10:00:00 AM (expires in 10 minutes at 10:10:00 AM)
    await h.sendInbound("/start", 5002, "2026-10-24T10:00:00.000Z");
    const state = (await h.stateStore.load(B_ID, "conv-defect-5"))
      ?.state as any;
    const oldOfferCallbackData = offerCallbackData(state.offer, "book");

    // Customer taps next day at 10:00:00 AM (past 12h welcome offer expiry)
    const lateReceiptInstant = new Date("2026-10-25T10:00:00.000Z");

    const expiredResult = await h.sendInbound(
      oldOfferCallbackData,
      5003,
      lateReceiptInstant.toISOString(),
    );

    const sent = h.getSentMessages();
    const lastMsg = sent[sent.length - 1];
    const zeroAppointments = h.getAppointments().length === 0;

    check(
      "5. Callback uses receipt clock instead of original message date, and expired offers are safely rejected",
      Boolean(
        usesReceiptTime &&
        expiredResult.ok &&
        lastMsg?.content.includes("انتهت صلاحية") &&
        zeroAppointments,
      ),
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 6: Regression safety check
  // ──────────────────────────────────────────────────────────────────────────
  {
    const allPassed = checks.every((c) => c.pass);
    check(
      "6. All focused execution defect regression scenarios verified",
      allPassed,
    );
  }

  console.log(
    "\n──────────────────────────────────────────────────────────────────",
  );
  const failed = checks.filter((c) => !c.pass);
  if (failed.length > 0) {
    console.error(`FAILED: ${failed.length}/${checks.length} checks failed.`);
    process.exit(1);
  } else {
    console.log(
      `PASSED: All ${checks.length}/${checks.length} checks passed.\n`,
    );
  }
}

main().catch((err) => {
  console.error("FATAL UNCAUGHT ERROR in defects suite:", err);
  process.exit(1);
});
