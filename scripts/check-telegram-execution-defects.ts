/* eslint-disable @typescript-eslint/no-explicit-any */
import { spawnSync } from "node:child_process";

import { offerCallbackData } from "@/features/conversations/server/channel-choice";
import * as engine from "@/features/conversations/server/conversation-engine";
import { emptyConversationState } from "@/features/conversations/server/conversation-state";
import { createPrismaProxy } from "@/server/db";
import { renderTelegramInlineKeyboard } from "@/server/integrations/telegram/telegram-presentation";
import {
  hashTelegramWebhookSecret,
  parseTelegramUpdate,
} from "@/server/integrations/telegram/telegram-webhook";
import {
  createSafeTelegramWebhookLogger,
  handleTelegramWebhook,
  mapEngineResultToTelegramOutcome,
  type TelegramWebhookLogEvent,
} from "@/server/integrations/telegram/telegram-webhook-handler";

import {
  createProductionTelegramWebhookDeps,
  defaultTelegramWebhookLogger,
} from "@/app/api/telegram/webhook/route";

/**
 * FlowPilot — Telegram Execution Defects Regression Suite.
 *
 * Verifies:
 * 1. Two-turn natural-language GREETING -> button selection:
 *    - Controlled structured model returns GREETING.
 *    - Invariant: Persist-before-send asserted AT TRANSPORT INVOCATION TIME.
 *    - Capture outgoing choices.
 *    - Feed real callback through authenticated webhook handler.
 *    - Reload state through repository fixture.
 *    - Assert expected next offer and matching IDs/tokens.
 *    - Assert ZERO additional AI calls for selection.
 *
 * 2. Greeting offer persistence resilience:
 *    - State save returns conflict: choices suppressed, safe retry copy sent, newer state not overwritten.
 *    - State save throws: choices suppressed, safe retry copy sent.
 *    - State load throws (store unavailable): choices suppressed, plain text preserved.
 *
 * 3. Truthful outcome reporting & delivery mapping:
 *    - Engine delivery: null is not reported as confirmed delivered: true.
 *    - Delivery failure is not success.
 *    - Duplicate, deferred-to-staff, domain/persistence failure remain distinct.
 *    - Avoid catch-all result types.
 *
 * 4. Production composition, logger wiring & callback ACK:
 *    - Production composition actually supplies the logger.
 *    - Logger receives safe events without arbitrary exception-message leakage.
 *    - Non-throwing Telegram ACK failure maps to ACK_FAILED.
 *    - ACK failure still allows real selection processing.
 *    - Logger failure does not prevent callback processing.
 *
 * 5. Callback clock & offer expiry:
 *    - Callback turn uses receipt clock instead of message date.
 *    - Preserves originalMessageDate.
 *    - Expired offer safely rejected using receipt time.
 *
 * 6. Database client lifetime & development reuse:
 *    - Production database-client proxy preserves lazy singleton lifetime.
 *    - Delegates, $disconnect, and $transaction address that same instance.
 *    - Retains development hot-reload convention without making real DB connections.
 *
 * 7. Fresh child-process maintenance bootstrap & CLI invocation:
 *    - Removes auth environment variables before loading maintenance paths.
 *    - Clean child process executes CLI entry point with zero auth variables.
 *    - Controlled repository seam resolves exact match without network or DB calls.
 */

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
  const B_ID = "11111111-1111-4111-8111-111111111111";
  const BRANCH_ID = "22222222-2222-4222-8222-222222222222";
  const BOT_EXTERNAL_ID = "6123456789";
  const CHAT_ID = "9988776655";
  const BUSINESS_NAME = "مركز الأمل الطبي";

  const SRV_CONSULT = "33333333-3333-4333-8333-333333333331";
  const SRV_LAB = "33333333-3333-4333-8333-333333333332";
  const PRV_1 = "44444444-4444-4444-8444-444444444441";

  const SIMULATED_NOW = new Date("2026-10-24T10:00:00.000Z");

  function createTestHarness(opts?: {
    conversationId?: string;
    stateStore?: any;
  }) {
    let modelCallCount = 0;
    let customAiResponder: ((prompt: unknown) => Promise<any> | any) | null =
      null;

    const sentMessages: Array<{
      to: string;
      content: string;
      choices?: any;
      replyMarkup?: Record<string, unknown>;
      persistedAtSendTime?: any;
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

    const stateStore = opts?.stateStore ?? new InMemoryConversationStateStore();
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
          // Assert AT SEND TIME: inspect stateStore at the exact moment of delivery
          let persistedAtSendTime: any = null;
          if (input.choices?.offerId) {
            try {
              persistedAtSendTime = (await stateStore.load(B_ID, convId))
                ?.state;
            } catch {
              persistedAtSendTime = null;
            }
          }
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
            persistedAtSendTime,
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
  // TEST 1: Two-turn natural language GREETING -> button selection
  // Invariant: Persist-before-send is verified AT SEND TIME
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

    // Turn 1: Natural language greeting
    const turn1Result = await h.sendInbound("مرحبا وعليكم السلام", 1001);
    const modelCallsAfterTurn1 = h.getModelCalls();

    const sent1 = h.getSentMessages();
    const lastMsg1 = sent1[sent1.length - 1];
    const outgoingChoices = lastMsg1?.choices;

    // Verify persist-before-send invariant AT SEND TIME:
    // When send was invoked, persistedAtSendTime must ALREADY contain the offer
    const offerPersistedAtSendTime =
      lastMsg1?.persistedAtSendTime?.offer?.id === outgoingChoices?.offerId &&
      lastMsg1?.persistedAtSendTime?.offer?.status === "ACTIVE";

    // Capture outgoing button callback data
    const welcomeOffer = lastMsg1?.persistedAtSendTime?.offer;
    const bookCallbackData = offerCallbackData(welcomeOffer, "book");

    // Setup authenticated webhook handler for Turn 2 using shared composition
    const WEBHOOK_SECRET = "secret-token-test-1";
    const SECRET_HASH = hashTelegramWebhookSecret(WEBHOOK_SECRET);
    const scheduledWork: Array<Promise<void>> = [];

    const webhookDeps = createProductionTelegramWebhookDeps({
      connectionRepository: {
        findByWebhookSecretHash: async (hash: string) => {
          if (hash === SECRET_HASH) {
            return {
              id: "conn-tg-1",
              businessId: B_ID,
              branchId: BRANCH_ID,
              botExternalId: BOT_EXTERNAL_ID,
              webhookSecretHash: SECRET_HASH,
              credentialsRef: "fp:mock-ref",
              createdAt: new Date(),
              updatedAt: new Date(),
            } as any;
          }
          return null;
        },
        findByIdWithinBusiness: async () =>
          ({
            id: "conn-tg-1",
            businessId: B_ID,
            credentialsRef: "fp:mock-ref",
            isActive: true,
            status: "CONNECTED",
          }) as any,
      },
      engineDeps: h.deps as any,
      telegramApiDeps: {
        apiHost: "https://api.telegram.org",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          }),
        credentialsResolver: {
          resolve: async () => ({ ok: true, value: "mock-token" }) as any,
        },
      },
      schedule: (work) => {
        scheduledWork.push(Promise.resolve(work()));
      },
      now: () => SIMULATED_NOW,
      revalidatePaths: false,
    });

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

    const res = await handleTelegramWebhook(webhookDeps, req);
    await Promise.all(scheduledWork);

    const modelCallsAfterTurn2 = h.getModelCalls();

    // Reload state through repository fixture
    const persistedState2 = (await h.stateStore.load(B_ID, "conv-defect-1"))
      ?.state as any;

    const nextOffer = persistedState2?.offer;
    const sent2 = h.getSentMessages();
    const lastMsg2 = sent2[sent2.length - 1];

    check(
      "1. Two-turn natural language GREETING -> button selection asserts persist-before-send at send time and executes selection with zero additional AI calls",
      Boolean(
        turn1Result.ok &&
        modelCallsAfterTurn1 === 1 &&
        offerPersistedAtSendTime &&
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
  // TEST 2: Greeting offer persistence failure and unavailable store resilience
  // ──────────────────────────────────────────────────────────────────────────
  {
    // 2a. State save returns conflict
    const h1 = createTestHarness({ conversationId: "conv-conflict-1" });
    h1.setAiResponder(() => ({
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

    // Pre-populate with existing newer offer
    const existingOffer = {
      id: "newer-existing-offer-id",
      token: "newer-token",
      kind: "SERVICE",
      status: "ACTIVE",
      expiresAt: new Date(SIMULATED_NOW.getTime() + 600000).toISOString(),
    };
    await h1.stateStore.save(B_ID, "conv-conflict-1", null, {
      ...emptyConversationState(),
      offer: existingOffer,
    });

    // Simulate CAS conflict
    const origSave = h1.stateStore.save.bind(h1.stateStore);
    h1.stateStore.save = async () => ({ status: "conflict" });
    const resConflict = await h1.sendInbound("صباح الخير", 2001);
    const sentConflict = h1.getSentMessages();
    const lastMsgConflict = sentConflict[sentConflict.length - 1];

    h1.stateStore.save = origSave;
    const reloadedAfterConflict = (
      await h1.stateStore.load(B_ID, "conv-conflict-1")
    )?.state as any;

    const conflictPassed =
      resConflict.ok &&
      lastMsgConflict?.choices === undefined &&
      lastMsgConflict?.content.includes("تعارض مؤقت") &&
      reloadedAfterConflict?.offer?.id === "newer-existing-offer-id";

    // 2b. State save throws
    const h2 = createTestHarness({ conversationId: "conv-save-throw" });
    h2.setAiResponder(() => ({
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
    h2.stateStore.save = async () => {
      throw new Error("DB write timeout");
    };
    const resSaveThrow = await h2.sendInbound("مرحبا", 2002);
    const sentSaveThrow = h2.getSentMessages();
    const lastMsgSaveThrow = sentSaveThrow[sentSaveThrow.length - 1];

    const saveThrowPassed =
      resSaveThrow.ok &&
      lastMsgSaveThrow?.choices === undefined &&
      lastMsgSaveThrow?.content.includes("تعارض مؤقت");

    // 2c. State load throws (durable store unavailable)
    const brokenStore = {
      load: async () => {
        throw new Error("Relation does not exist");
      },
      save: async () => ({ status: "saved", revision: 1 }),
    };
    const h3 = createTestHarness({
      conversationId: "conv-load-throw",
      stateStore: brokenStore,
    });
    h3.setAiResponder(() => ({
      intent: "GREETING",
      action: "reply",
      content: "أهلاً وسهلاً بك في العيادة!",
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
    const resLoadThrow = await h3.sendInbound("السلام عليكم", 2003);
    const sentLoadThrow = h3.getSentMessages();
    const lastMsgLoadThrow = sentLoadThrow[sentLoadThrow.length - 1];

    const storeUnavailablePassed =
      resLoadThrow.ok &&
      lastMsgLoadThrow?.choices === undefined &&
      lastMsgLoadThrow?.replyMarkup === undefined &&
      lastMsgLoadThrow?.content.includes("أهلاً وسهلاً بك في العيادة!"); // Preserves plain text without buttons

    check(
      "2. Unavailable or failing state storage suppresses actionable choices, preserves plain text, and never overwrites newer offers",
      Boolean(conflictPassed && saveThrowPassed && storeUnavailablePassed),
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 3: Truthful outcome reporting across composition boundary
  // ──────────────────────────────────────────────────────────────────────────
  {
    // 3a. Null delivery must report delivered: false (never true)
    const outcomeNullDelivery = mapEngineResultToTelegramOutcome({
      ok: true,
      duplicate: false,
      assistantAction: "AI_REPLY",
      delivery: null,
    });

    // 3b. Delivery failure
    const outcomeDeliveryFail = mapEngineResultToTelegramOutcome({
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
    const outcomeDuplicate = mapEngineResultToTelegramOutcome({
      ok: true,
      duplicate: true,
      conversationId: "conv-dup",
      customerMessageId: "msg-dup",
    });

    // 3d. Deferred-to-staff
    const outcomeDeferred = mapEngineResultToTelegramOutcome({
      ok: true,
      duplicate: false,
      assistantAction: "DEFERRED_TO_STAFF",
      delivery: { provider: "telegram", delivered: true },
    });

    // 3e. Domain / persistence failure
    const outcomePersistence = mapEngineResultToTelegramOutcome({
      ok: false,
      code: "PERSISTENCE_FAILED",
      message: "تعذر حفظ حالة المحادثة",
    });

    check(
      "3. Truthful outcome mapping: null delivery is delivered:false, delivery failure is distinct, duplicate and staff deferrals preserved without catch-alls",
      Boolean(
        outcomeNullDelivery.ok === true &&
        outcomeNullDelivery.outcome === "SUCCESS" &&
        outcomeNullDelivery.delivered === false && // NOT confirmed delivered: true!
        outcomeDeliveryFail.ok === false &&
        outcomeDeliveryFail.outcome === "DELIVERY_FAILURE" &&
        outcomeDuplicate.ok === true &&
        outcomeDuplicate.outcome === "DUPLICATE" &&
        outcomeDuplicate.duplicate === true &&
        outcomeDeferred.ok === true &&
        outcomeDeferred.outcome === "DEFERRED_TO_STAFF" &&
        outcomePersistence.ok === false &&
        outcomePersistence.outcome === "PERSISTENCE_FAILED",
      ),
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 4: Production logger wiring, safe event filtering & ACK failure mapping
  // ──────────────────────────────────────────────────────────────────────────
  {
    const loggedEvents: TelegramWebhookLogEvent[] = [];
    const safeLogger = createSafeTelegramWebhookLogger((ev) => {
      loggedEvents.push(ev);
    });

    // 4a. Production composition supplies logger
    const prodDeps = createProductionTelegramWebhookDeps();
    const prodSuppliesLogger = Boolean(
      prodDeps.logger &&
      typeof prodDeps.logger.log === "function" &&
      defaultTelegramWebhookLogger,
    );

    // 4b. Non-throwing Telegram ACK failure ({ ok: false }) maps to ACK_FAILED and does not crash
    const WEBHOOK_SECRET = "secret-token-test-4";
    const SECRET_HASH = hashTelegramWebhookSecret(WEBHOOK_SECRET);
    const scheduledWork: Array<Promise<void>> = [];

    const mockApiReturningFailure = {
      apiHost: "https://api.telegram.org",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error_code: 400,
            description: "QUERY_TOO_OLD",
          }),
          { status: 400 },
        ),
      credentialsResolver: {
        resolve: async () => ({ ok: true, value: "mock-token" }) as any,
      },
    };

    const webhookDeps = createProductionTelegramWebhookDeps({
      connectionRepository: {
        findByWebhookSecretHash: async (hash: string) =>
          hash === SECRET_HASH
            ? ({
                id: "conn-tg-4",
                businessId: B_ID,
                branchId: BRANCH_ID,
                botExternalId: BOT_EXTERNAL_ID,
                webhookSecretHash: SECRET_HASH,
                credentialsRef: "fp:mock-ref",
                createdAt: new Date(),
                updatedAt: new Date(),
              } as any)
            : null,
        findByIdWithinBusiness: async () =>
          ({
            id: "conn-tg-4",
            businessId: B_ID,
            credentialsRef: "fp:mock-ref",
            isActive: true,
            status: "CONNECTED",
          }) as any,
      },
      telegramApiDeps: mockApiReturningFailure as any,
      logger: safeLogger,
      schedule: (work) => {
        scheduledWork.push(Promise.resolve(work()));
      },
      now: () => SIMULATED_NOW,
      revalidatePaths: false,
    });

    // Test direct answerCallbackQuery wrapper on non-throwing failure
    const ackWrapperResult = await webhookDeps.answerCallbackQuery!({
      callbackQueryId: "cq_test_ack_fail",
      connectionId: "conn-tg-4",
      businessId: B_ID,
    });

    // Feed callback through webhook to verify selection processing continues and logger records ACK_FAILED
    const h = createTestHarness({ conversationId: "conv-defect-4" });
    await h.sendInbound("/start", 4001);
    const state = (await h.stateStore.load(B_ID, "conv-defect-4"))
      ?.state as any;
    const bookCallbackData = offerCallbackData(state.offer, "book");

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
          from: { id: Number(CHAT_ID), first_name: "Customer" },
          data: bookCallbackData,
          message: {
            message_id: 402,
            date: Math.floor(SIMULATED_NOW.getTime() / 1000) - 10,
            chat: { id: Number(CHAT_ID), type: "private" },
          },
        },
      }),
    });

    const res = await handleTelegramWebhook(
      {
        ...webhookDeps,
        processInboundMessage: async (params) => {
          const turn = await engine.receiveInboundMessage(
            h.deps as any,
            params.engineInput,
            params.identity,
          );
          return mapEngineResultToTelegramOutcome(turn);
        },
      },
      req,
    );
    await Promise.all(scheduledWork);

    const hasAckFailedLog = loggedEvents.some(
      (e) => e.stage === "acknowledgment" && e.outcome === "ACK_FAILED",
    );
    const hasOutboundSuccessLog = loggedEvents.some(
      (e) => e.stage === "outbound" && e.outcome === "SUCCESS",
    );
    const noRawErrorMessageLeak = loggedEvents.every((e) => {
      return (
        !e.error ||
        [
          "TELEGRAM_ACK_FAILED",
          "ANSWER_CALLBACK_FAILED",
          "UNHANDLED_EXCEPTION",
          "RATE_LIMITED",
          "UNKNOWN_ERROR",
        ].includes(e.error)
      );
    });

    // 4c. Logger failure resilience (logger throws)
    const throwingLogger = {
      log: () => {
        throw new Error("Disk full in logger sink");
      },
    };
    const reqThrowLogger = new Request(
      "http://localhost:3000/api/telegram/webhook",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET,
        },
        body: JSON.stringify({
          update_id: 4003,
          callback_query: {
            id: "cq_logger_throw",
            from: { id: Number(CHAT_ID) },
            data: bookCallbackData,
            message: {
              message_id: 403,
              date: Math.floor(SIMULATED_NOW.getTime() / 1000) - 5,
              chat: { id: Number(CHAT_ID), type: "private" },
            },
          },
        }),
      },
    );

    const scheduledThrowLogger: Array<Promise<void>> = [];
    const resThrowLogger = await handleTelegramWebhook(
      {
        ...webhookDeps,
        logger: throwingLogger,
        schedule: (work) => {
          scheduledThrowLogger.push(Promise.resolve(work()));
        },
        processInboundMessage: async (params) => {
          const turn = await engine.receiveInboundMessage(
            h.deps as any,
            params.engineInput,
            params.identity,
          );
          return mapEngineResultToTelegramOutcome(turn);
        },
      },
      reqThrowLogger,
    );
    await Promise.all(scheduledThrowLogger);

    check(
      "4. Production composition supplies logger, safe allowlisted events prevent leakage, non-throwing ACK failure maps to ACK_FAILED, and logger exceptions never abort processing",
      Boolean(
        prodSuppliesLogger &&
        ackWrapperResult != null &&
        ackWrapperResult.ok === false &&
        res.status === 200 &&
        hasAckFailedLog &&
        hasOutboundSuccessLog &&
        noRawErrorMessageLeak &&
        resThrowLogger.status === 200,
      ),
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 5: Callback clock & offer expiry
  // ──────────────────────────────────────────────────────────────────────────
  {
    // 5a. Verify callback turn uses receipt clock, not old message date
    const oldOriginalMessageDate = 1700000000;
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
  // TEST 6: Production database-client lifetime and development reuse
  // ──────────────────────────────────────────────────────────────────────────
  {
    const savedNodeEnv = process.env.NODE_ENV;
    try {
      // 6a. Production mode: singleton client across accesses and method bindings
      (process.env as any).NODE_ENV = "production";

      let prodFactoryCalls = 0;
      const createdProdInstances: any[] = [];
      const prodFactory = () => {
        prodFactoryCalls++;
        const id = `prod-prisma-instance-${prodFactoryCalls}`;
        const instance = {
          id,
          user: { name: "user-delegate" },
          appointment: { name: "appointment-delegate" },
          $disconnect: async function (this: any) {
            return { ok: true, instanceId: this?.id };
          },
          $transaction: async function (this: any, callback: any) {
            return callback(this);
          },
        };
        createdProdInstances.push(instance);
        return instance as any;
      };

      const prodDb = createPrismaProxy(prodFactory);

      // Invariant 1: Proxy creation / import alone creates no client
      const zeroCallsAtInit = prodFactoryCalls === 0;

      // Invariant 2: Repeated accesses to different delegates create exactly one client
      const userDelegate1 = prodDb.user;
      const oneCallAfterFirstAccess = prodFactoryCalls === 1;

      const apptDelegate = prodDb.appointment;
      const stillOneCallAfterSecondAccess =
        prodFactoryCalls === 1 && apptDelegate != null;

      const userDelegate2 = prodDb.user;
      const stillOneCallAfterThirdAccess = prodFactoryCalls === 1;
      const delegatesIdentical = userDelegate1 === userDelegate2;

      // Invariant 3: Repeated method access / calls reuse the same client
      const disconnectFn = prodDb.$disconnect;
      const disconnectResult: any = await prodDb.$disconnect();
      const stillOneCallAfterDisconnect =
        prodFactoryCalls === 1 && typeof disconnectFn === "function";
      const disconnectAddressedSameInstance =
        disconnectResult?.instanceId === createdProdInstances[0]?.id;

      // Invariant 4: $transaction addresses the same instance
      let txInstanceId = "";
      await prodDb.$transaction(async (tx: any) => {
        txInstanceId = tx?.id;
      });
      const stillOneCallAfterTransaction = prodFactoryCalls === 1;
      const transactionAddressedSameInstance =
        txInstanceId === createdProdInstances[0]?.id;

      const prodModePassed =
        zeroCallsAtInit &&
        oneCallAfterFirstAccess &&
        stillOneCallAfterSecondAccess &&
        stillOneCallAfterThirdAccess &&
        delegatesIdentical &&
        stillOneCallAfterDisconnect &&
        disconnectAddressedSameInstance &&
        stillOneCallAfterTransaction &&
        transactionAddressedSameInstance;

      // 6b. Development mode: global convention reuse across hot-reload / new proxy instances
      (process.env as any).NODE_ENV = "development";
      (globalThis as any).prisma = undefined;

      let devFactoryCalls = 0;
      const createdDevInstances: any[] = [];
      const devFactory = () => {
        devFactoryCalls++;
        const id = `dev-prisma-instance-${devFactoryCalls}`;
        const instance = {
          id,
          user: { name: "dev-user-delegate" },
          appointment: { name: "dev-appointment-delegate" },
          $disconnect: async function (this: any) {
            return { ok: true, instanceId: this?.id };
          },
        };
        createdDevInstances.push(instance);
        return instance as any;
      };

      const devDb1 = createPrismaProxy(devFactory);
      const devZeroAtInit = devFactoryCalls === 0;

      const devUser1 = devDb1.user;
      const devOneCall = devFactoryCalls === 1 && devUser1 != null;
      const devAppt1 = devDb1.appointment;
      const devStillOneCall = devFactoryCalls === 1 && devAppt1 != null;

      // Emulate hot-reload: a second proxy created in development reuses global client
      const devDb2 = createPrismaProxy(devFactory);
      const devUser2 = devDb2.user;
      const devReusedGlobal = devFactoryCalls === 1 && devUser2 != null;
      const devCachedOnGlobal =
        (globalThis as any).prisma === createdDevInstances[0];

      const devModePassed =
        devZeroAtInit &&
        devOneCall &&
        devStillOneCall &&
        devReusedGlobal &&
        devCachedOnGlobal;

      check(
        "6. Production database-client proxy preserves lazy singleton lifetime, binds $disconnect/$transaction to same instance, and retains development hot-reload reuse",
        Boolean(prodModePassed && devModePassed),
      );
    } finally {
      (process.env as any).NODE_ENV = savedNodeEnv;
      delete (globalThis as any).prisma;
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 7: Fresh child-process maintenance bootstrap and CLI invocation
  // ──────────────────────────────────────────────────────────────────────────
  {
    // Prepare a stripped environment completely lacking Better Auth and public app variables
    const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
    delete cleanEnv.BETTER_AUTH_SECRET;
    delete cleanEnv.BETTER_AUTH_URL;
    delete cleanEnv.NEXT_PUBLIC_APP_URL;

    // Supply only the minimal database configuration required by the schema validator
    cleanEnv.DATABASE_URL =
      "postgresql://user:password@localhost:5432/flowpilot_test";
    (cleanEnv as any).NODE_ENV = "production";

    // 7a. Verify CLI entry point execution path without auth variables
    // Command path: pnpm exec tsx scripts/repair-telegram-webhook.ts --help
    const cliResult = spawnSync(
      "pnpm",
      ["exec", "tsx", "scripts/repair-telegram-webhook.ts", "--help"],
      {
        env: cleanEnv,
        encoding: "utf8",
      },
    );

    const cliCleanExit = cliResult.status === 0;
    const cliOutputValid =
      typeof cliResult.stdout === "string" &&
      cliResult.stdout.includes(
        "FlowPilot Telegram Webhook Repair & Reconciliation CLI",
      );

    // 7b. Verify candidate lookup module pipeline in fresh child process
    // Command path: pnpm exec tsx -e "<script>" importing telegram-repair and repositories
    const childInspectionScript = `
import { lookupTelegramBotTarget, lookupTelegramBotTargetDefault } from "./src/server/integrations/telegram/telegram-repair.ts";
import { telegramConnectionRepository } from "./src/server/repositories/index.ts";

async function verifyFreshProcess() {
  // Ensure missing auth environment variables were not quietly loaded by .env or modules
  if (
    process.env.BETTER_AUTH_SECRET ||
    process.env.BETTER_AUTH_URL ||
    process.env.NEXT_PUBLIC_APP_URL
  ) {
    console.error("LEAK: Auth environment variables are present in fresh process");
    process.exit(2);
  }

  // 1. Controlled repository seam invocation
  let reachedRepositorySeam = false;
  const mockRepo = {
    findCandidatesByBotIdentifier: async (params: any) => {
      reachedRepositorySeam = true;
      if (params.botUsername === "Drafnanafnanbot") {
        return [
          {
            connectionId: "conn-reconcile-child-1",
            businessId: "11111111-1111-1111-1111-111111111111",
            botUsername: "Drafnanafnanbot",
            botExternalId: "987654321",
            status: "ACTIVE",
            isActive: true,
          },
        ];
      }
      return [];
    },
  };

  const seamOutcome = await lookupTelegramBotTarget(
    { connectionRepository: mockRepo },
    { botUsername: "@Drafnanafnanbot" },
  );

  // 2. Default lookup pipeline through telegramConnectionRepository seam
  let reachedDefaultSeam = false;
  telegramConnectionRepository.findCandidatesByBotIdentifier = async (params: any) => {
    reachedDefaultSeam = true;
    if (params.botUsername === "Drafnanafnanbot") {
      return [
        {
          connectionId: "conn-default-child-2",
          businessId: "11111111-1111-1111-1111-111111111111",
          botUsername: "Drafnanafnanbot",
          botExternalId: "987654321",
          status: "ACTIVE",
          isActive: true,
        },
      ];
    }
    return [];
  };

  const defaultOutcome = await lookupTelegramBotTargetDefault({
    botUsername: "@Drafnanafnanbot",
  });

  const passed =
    reachedRepositorySeam &&
    seamOutcome.ok &&
    seamOutcome.status === "EXACT_MATCH" &&
    seamOutcome.target?.connectionId === "conn-reconcile-child-1" &&
    reachedDefaultSeam &&
    defaultOutcome.ok &&
    defaultOutcome.status === "EXACT_MATCH" &&
    defaultOutcome.target?.connectionId === "conn-default-child-2";

  if (!passed) {
    console.error("FAIL: Candidate lookup outcomes did not match expected invariants");
    process.exit(3);
  }

  console.log(JSON.stringify({ ok: true }));
}

verifyFreshProcess().catch((err) => {
  console.error("UNCAUGHT_CHILD_ERROR:", err);
  process.exit(1);
});
`;

    const lookupChildResult = spawnSync(
      "pnpm",
      ["exec", "tsx", "-e", childInspectionScript],
      {
        env: cleanEnv,
        encoding: "utf8",
      },
    );

    const lookupCleanExit = lookupChildResult.status === 0;
    let childJsonOk = false;
    try {
      const parsed = JSON.parse(lookupChildResult.stdout?.trim() ?? "{}");
      childJsonOk = parsed.ok === true;
    } catch {
      childJsonOk = false;
    }

    check(
      "7. Fresh child-process maintenance bootstrap and CLI invocation verify clean startup and candidate lookup without web auth environment variables",
      Boolean(cliCleanExit && cliOutputValid && lookupCleanExit && childJsonOk),
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 8: Regression safety check
  // ──────────────────────────────────────────────────────────────────────────
  {
    const allPassed = checks.every((c) => c.pass);
    check(
      "8. All focused execution defect regression scenarios verified",
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
