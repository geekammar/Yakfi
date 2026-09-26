/* eslint-disable @typescript-eslint/consistent-type-imports */

/**
 * FlowPilot — WHATSAPP INBOUND end-to-end reproduction harness
 * (PROMPT-OPS-WHATSAPP-INBOUND-DEBUG-01, Phase 10).
 *
 * Reproduces the REAL production inbound failure boundary offline — no
 * DB, no network, no real credentials (in-memory fakes only):
 *
 *   1. valid Meta inbound message (parser → normalized TEXT +
 *      `recipientProviderId` = Meta `phone_number_id`);
 *   2. invalid/missing `X-Hub-Signature-256` rejected;
 *   3. wrong `phone_number_id` + unknown display number → safe refusal;
 *   4. unknown connection, legacy phone mapping fallback (compat);
 *   5. duplicate Meta message id → idempotent replay (one message);
 *   6. valid inbound → phone_number_id → WhatsAppConnection → Business
 *      → Branch (the production mismatch case: the Meta display number
 *      does NOT equal the stored `Business.whatsappNumber`);
 *   7. valid inbound → REAL Conversation Engine with resolved identity;
 *   8. deterministic AI bypass → zero provider calls;
 *   9. AI provider success → assistant reply persisted + delivered;
 *  10. AI provider failure → controlled NEED_HUMAN, no outbound;
 *  11. outbound Meta transport failure (Graph 400) → truthful failure,
 *      no false success/BOOKED;
 *  12. successful end-to-end mocked inbound processing → real Meta
 *      transport issues the exact Graph request (URL/body/tenant).
 *
 * Run: pnpm check:whatsapp-inbound
 */

export {};

type Check = { label: string; pass: boolean };

// ── Fixtures (no real credentials) ──────────────────────────────────────────

const BUSINESS_A = "11111111-1111-4111-8111-111111111111";
const BRANCH_A = "33333333-3333-4333-8333-333333333333";
const CONN_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PHONE_A = "+201001111111";
const PROVIDER_ID = "1286861067846638";
/** The Meta display number deliberately differs from `PHONE_A` — the
 *  exact production symptom (display formatting ≠ stored mapping). */
const META_DISPLAY = "12025550123";
const CUSTOMER_PHONE = "+201234567890";
const RECEIVED_AT = "2026-09-16T10:00:00.000Z";
const APP_SECRET = "test-app-secret-12345678";
const CREDENTIALS_REF = "TEST_WHATSAPP_ACCESS_TOKEN";
const TEST_TOKEN = "test-access-token-not-a-real-secret";

async function main(): Promise<void> {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const transport = await import("../src/server/transport/whatsapp-transport");
  const metaWebhook =
    await import("../src/server/integrations/whatsapp/meta-webhook");
  const metaClient =
    await import("../src/server/integrations/whatsapp/meta-client");
  const credentialsResolver =
    await import("../src/server/credentials/credentials-resolver");
  const engine =
    await import("../src/features/conversations/server/conversation-engine");
  const engineSchema =
    await import("../src/features/conversations/schemas/conversation-schema");
  const aiContract =
    await import("../src/features/conversations/server/ai-contract");
  const conversationAi =
    await import("../src/features/conversations/server/conversation-ai");
  const dedupe =
    await import("../src/server/repositories/inbound-dedupe.repository");
  const { createHmac } = await import("node:crypto");

  const checks: Check[] = [];
  function check(label: string, pass: boolean): void {
    checks.push({ label, pass });
  }

  // ── Fakes: persisted rows + repositories ─────────────────────────────────

  const businessRows = [
    {
      id: BUSINESS_A,
      name: "منشأة أ",
      whatsappNumber: PHONE_A,
      isActive: true,
      // A knowledge store is required for an assistant-authored FAQ reply to
      // be disclosable (PROMPT-B03): an empty store cannot source an answer,
      // so the boundary routes such a reply to a human instead of letting the
      // assistant invent one.
      faqs: [
        {
          question: "ما هي مواعيد العمل؟",
          answer: "نعمل من السبت إلى الخميس.",
        },
      ],
    },
  ];
  const connectionRows = [
    {
      id: CONN_A,
      businessId: BUSINESS_A,
      branchId: BRANCH_A,
      phoneNumber: PHONE_A,
      externalId: PROVIDER_ID,
      status: "CONNECTED",
      isActive: true,
      credentialsRef: CREDENTIALS_REF,
    },
  ];
  const branchRows = [{ id: BRANCH_A, businessId: BUSINESS_A }];

  const resolutionDeps = {
    businessRepository: {
      findByWhatsappNumber: async (number: string) =>
        businessRows.find((row) => row.whatsappNumber === number) ?? null,
      findById: async (id: string) =>
        businessRows.find((row) => row.id === id) ?? null,
    },
    whatsappConnectionRepository: {
      findByPhone: async (businessId: string, phoneNumber: string) =>
        connectionRows.find(
          (row) =>
            row.businessId === businessId && row.phoneNumber === phoneNumber,
        ) ?? null,
      findByIdWithinBusiness: async (id: string, businessId: string) =>
        connectionRows.find(
          (row) => row.id === id && row.businessId === businessId,
        ) ?? null,
      findByExternalId: async (externalId: string) =>
        connectionRows.find((row) => row.externalId === externalId) ?? null,
    },
    branchRepository: {
      findDefaultByBusiness: async (businessId: string) =>
        branchRows.find((row) => row.businessId === businessId) ?? null,
      findByIdWithinBusiness: async (id: string, businessId: string) =>
        branchRows.find(
          (row) => row.id === id && row.businessId === businessId,
        ) ?? null,
    },
  } as unknown as import("../src/server/transport/whatsapp-transport").ConnectionResolutionDeps;

  const identity = {
    businessId: BUSINESS_A,
    branchId: BRANCH_A,
    connectionId: CONN_A,
  };

  // ── Meta payload builder (real webhook shape) ─────────────────────────────

  function metaPayload(params: {
    wamid: string;
    text: string;
    display?: string;
    providerId?: string;
  }): unknown {
    return {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-entry-1",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: params.display ?? META_DISPLAY,
                  phone_number_id: params.providerId ?? PROVIDER_ID,
                },
                contacts: [{ wa_id: CUSTOMER_PHONE }],
                messages: [
                  {
                    from: CUSTOMER_PHONE,
                    id: params.wamid,
                    timestamp: "1789552800",
                    type: "text",
                    text: { body: params.text },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
  }

  function buildEngineInput(wamid: string, text: string): unknown {
    const envelope = transport.normalizeInboundTransportMessage({
      externalMessageId: wamid,
      senderExternalId: CUSTOMER_PHONE,
      recipientExternalId: META_DISPLAY,
      recipientProviderId: PROVIDER_ID,
      timestamp: RECEIVED_AT,
      text,
    });
    if (!envelope.ok) throw new Error("fixture envelope rejected");
    const mapped = transport.toEngineInboundMessage({
      ...envelope.message,
      connectionId: CONN_A,
      businessId: BUSINESS_A,
      branchId: BRANCH_A,
    });
    const parsed = engineSchema.inboundMessageSchema.safeParse(mapped);
    if (!parsed.success) throw new Error("fixture engine input rejected");
    return parsed.data;
  }

  // ── Engine harness (real engine + fake collaborators) ─────────────────────

  type AiLike = {
    providerName: string;
    respond: (request: unknown) => Promise<unknown>;
  };

  function createEngineHarness(options: {
    ai: AiLike;
    transport: import("../src/server/transport/whatsapp-transport").MessageTransport;
    findById?: (id: string) => Promise<unknown>;
  }) {
    const state = {
      messages: [] as Array<{
        id: string;
        senderType: string;
        content: string;
        conversationId: string;
      }>,
      customerMessages: 0,
      assistantMessages: 0,
      assistantContents: [] as string[],
      sends: [] as Array<Record<string, unknown>>,
    };
    const ledger = new Map<
      string,
      {
        claimId: string;
        conversationId: string | null;
        customerMessageId: string | null;
      }
    >();
    const conversation = {
      id: "conversation-1",
      businessId: BUSINESS_A,
      customerId: "customer-1",
      branchId: BRANCH_A,
      assignedUserId: null,
      status: "AI_ACTIVE",
      lastMessageAt: null,
      aiSummary: null,
      createdAt: new Date(RECEIVED_AT),
      updatedAt: new Date(RECEIVED_AT),
      deletedAt: null,
    };
    const customer = {
      id: "customer-1",
      businessId: BUSINESS_A,
      name: "عميل تجريبي",
      phone: CUSTOMER_PHONE,
      email: null,
      notes: null,
      lastConversationAt: null,
      lastAppointmentAt: null,
      createdAt: new Date(RECEIVED_AT),
      updatedAt: new Date(RECEIVED_AT),
      deletedAt: null,
    };

    const deps = {
      businessRepository: {
        findByWhatsappNumber: async (number: string) =>
          businessRows.find((row) => row.whatsappNumber === number) ?? null,
        findById: options.findById ?? (async () => null),
      },
      branchRepository: {
        findDefaultByBusiness: async () => ({
          id: BRANCH_A,
          businessId: BUSINESS_A,
        }),
        findByIdWithinBusiness: async () => ({
          id: BRANCH_A,
          businessId: BUSINESS_A,
        }),
      },
      customerRepository: {
        upsertByPhone: async () => customer,
        touchConversation: async () => customer,
      },
      conversationRepository: {
        findLatestByCustomer: async () => ({ id: conversation.id }),
        findById: async () => conversation,
        create: async () => conversation,
        addMessage: async (
          input: {
            conversationId: string;
            senderType: string;
            content: string;
          },
          _workflow: unknown,
          ref?: { claimId: string },
        ) => {
          const row = ref
            ? [...ledger.values()].find(
                (entry) => entry.claimId === ref.claimId,
              )
            : undefined;
          if (ref) {
            if (!row) throw new Error("UNKNOWN_CLAIM");
            if (row.customerMessageId) {
              throw new dedupe.InboundDuplicateError({
                conversationId: row.conversationId,
                customerMessageId: row.customerMessageId,
              });
            }
          }
          const message = {
            id: `message-${state.messages.length + 1}`,
            conversationId: input.conversationId,
            senderType: input.senderType,
            content: input.content,
          };
          state.messages.push(message);
          if (input.senderType === "CUSTOMER") state.customerMessages += 1;
          if (input.senderType === "AI") {
            state.assistantMessages += 1;
            state.assistantContents.push(input.content);
          }
          if (row) {
            row.conversationId = input.conversationId;
            row.customerMessageId = message.id;
          }
          return {
            ...message,
            createdAt: new Date(RECEIVED_AT),
            updatedAt: new Date(),
          };
        },
        getMessages: async () => [...state.messages].reverse(),
        update: async () => conversation,
        updateWorkflow: async () => conversation,
      },
      serviceRepository: { listByBusiness: async () => [] },
      inboundDedupeRepository: {
        claim: async (businessId: string, externalKey: string) => {
          const key = `${businessId}|${externalKey}`;
          const existing = ledger.get(key);
          if (existing) {
            if (existing.customerMessageId) {
              return {
                status: "duplicate" as const,
                claimId: existing.claimId,
                conversationId: existing.conversationId,
                customerMessageId: existing.customerMessageId,
              };
            }
            return { status: "reclaim" as const, claimId: existing.claimId };
          }
          const claimId = `claim-${ledger.size + 1}`;
          ledger.set(key, {
            claimId,
            conversationId: null,
            customerMessageId: null,
          });
          return { status: "claimed" as const, claimId };
        },
      },
      usageRepository: { record: async (input: unknown) => input },
      ai: options.ai,
      transport: {
        providerName: options.transport.providerName,
        send: async (message: Record<string, unknown>) => {
          state.sends.push(message);
          return options.transport.send(
            message as unknown as import("../src/server/transport/whatsapp-transport").OutboundMessage,
          );
        },
      },
    };

    return { deps, state };
  }

  function makeAi(options?: { fail?: boolean; onCall?: () => void }): AiLike {
    return {
      providerName: "fake-ai",
      respond: async () => {
        options?.onCall?.();
        if (options?.fail) throw new Error("provider unavailable");
        return {
          intent: "FAQ",
          action: "reply",
          content: "رد تجريبي",
          extraction: aiContract.emptyAiExtraction,
          handoffReason: null,
          summary: null,
        };
      },
    };
  }

  const noopTransport = {
    providerName: "fake-transport",
    send: async () => ({ provider: "fake-transport", delivered: true }),
  };

  // ── 1. valid Meta inbound message ─────────────────────────────────────────
  const parsedValid = metaWebhook.parseMetaWebhookPayload(
    metaPayload({ wamid: "wamid.E2E-1", text: "مرحبا، أريد حجز موعد" }),
  );
  check(
    "وارد Meta صالح → ظرف TEXT موحّد + recipientProviderId (phone_number_id) — والعرض المنسق لا يطابق رقم المنشأة المخزّن",
    parsedValid.messages.length === 1 &&
      parsedValid.messages[0]!.kind === "TEXT" &&
      parsedValid.messages[0]!.recipientProviderId === PROVIDER_ID &&
      parsedValid.messages[0]!.recipientExternalId === META_DISPLAY &&
      (parsedValid.messages[0]!.recipientExternalId as string) !== PHONE_A,
  );

  // ── 2. invalid/missing signature ──────────────────────────────────────────
  const rawBody = JSON.stringify(
    metaPayload({ wamid: "wamid.E2E-1", text: "مرحبا" }),
  );
  const goodSignature = `sha256=${createHmac("sha256", APP_SECRET).update(rawBody).digest("hex")}`;
  const badSignature = `sha256=${"0".repeat(64)}`;
  check(
    "توقيع الويبهوك: صالح مقبول، خاطئ/مفقود مرفوض (لا يمر وارد غير موقّع)",
    metaWebhook.verifyMetaSignature(rawBody, goodSignature, APP_SECRET) ===
      true &&
      metaWebhook.verifyMetaSignature(rawBody, badSignature, APP_SECRET) ===
        false &&
      metaWebhook.verifyMetaSignature(rawBody, null, APP_SECRET) === false,
  );

  // ── 3/4. wrong phone_number_id / unknown connection ───────────────────────
  const unknownProvider = await transport.resolveInboundConnection(
    resolutionDeps,
    "12025559999",
    "9999999999999999",
  );
  const unknownConnectionLegacy = await transport.resolveInboundConnection(
    resolutionDeps,
    PHONE_A,
    "9999999999999999",
  );
  check(
    "phone_number_id غير مسجّل + رقم عرض مجهول → INVALID_CONNECTION (فشل آمن)",
    !unknownProvider.ok && unknownProvider.code === "INVALID_CONNECTION",
  );
  check(
    "اتصال غير معروف مع رقم منشأة مسجّل → المسار القديم (Business.whatsappNumber) يعمل",
    unknownConnectionLegacy.ok &&
      unknownConnectionLegacy.businessId === BUSINESS_A,
  );

  // ── 6. phone_number_id → connection → business → branch ───────────────────
  const resolvedByIdentity = await transport.resolveInboundConnection(
    resolutionDeps,
    META_DISPLAY,
    PROVIDER_ID,
  );
  check(
    "phone_number_id → WhatsAppConnection (externalId) → Business + Branch (رغم اختلاف رقم العرض عن الرقم المخزّن)",
    resolvedByIdentity.ok &&
      resolvedByIdentity.businessId === BUSINESS_A &&
      resolvedByIdentity.connectionId === CONN_A &&
      resolvedByIdentity.branchId === BRANCH_A,
  );

  // ── 7 + 9. valid inbound → REAL engine → persisted + delivered ────────────
  const successHarness = createEngineHarness({
    ai: makeAi(),
    transport: noopTransport,
    findById: async (id) => businessRows.find((row) => row.id === id) ?? null,
  });
  const firstResult = await engine.receiveInboundMessage(
    successHarness.deps as unknown as Parameters<
      typeof engine.receiveInboundMessage
    >[0],
    buildEngineInput("wamid.E2E-10", "مرحبا"),
    identity,
  );
  check(
    "وارد صالح → هوية محسومة خادميًا → المحرك ينشئ/يعيد استخدام المحادثة ويحفظ رسالة العميل",
    firstResult.ok &&
      firstResult.duplicate === false &&
      successHarness.state.customerMessages === 1 &&
      successHarness.state.sends.length === 1,
  );
  check(
    "نجاح مزود الذكاء الاصطناعي → رد مساعد محفوظ + تسليم عبر النقل",
    firstResult.ok &&
      firstResult.duplicate === false &&
      firstResult.assistantAction === "AI_REPLY" &&
      successHarness.state.assistantMessages === 1 &&
      firstResult.delivery?.delivered === true,
  );

  // ── 5. duplicate Meta message id → idempotent ─────────────────────────────
  const duplicateResult = await engine.receiveInboundMessage(
    successHarness.deps as unknown as Parameters<
      typeof engine.receiveInboundMessage
    >[0],
    buildEngineInput("wamid.E2E-10", "مرحبا"),
    identity,
  );
  check(
    "تكرار نفس wamid → duplicate بلا رسالة عميل ثانية وبلا إرسال إضافي",
    duplicateResult.ok &&
      duplicateResult.duplicate === true &&
      successHarness.state.customerMessages === 1 &&
      successHarness.state.sends.length === 1,
  );

  // ── 8. deterministic bypass → zero provider calls ─────────────────────────
  let bypassAiCalls = 0;
  const bypassHarness = createEngineHarness({
    ai: makeAi({ onCall: () => (bypassAiCalls += 1) }),
    transport: noopTransport,
    findById: async (id) => businessRows.find((row) => row.id === id) ?? null,
  });
  const bypassResponse = conversationAi.bypassDeterministicAi({
    message: "؟",
    conversationStatus: "AI_ACTIVE",
    recentMessages: [],
    businessName: "منشأة أ",
    services: [],
    faqs: [],
  });
  const bypassResult = await engine.receiveInboundMessage(
    bypassHarness.deps as unknown as Parameters<
      typeof engine.receiveInboundMessage
    >[0],
    buildEngineInput("wamid.BYPASS-1", "؟"),
    identity,
  );
  check(
    "المسار الحتمي (bypassDeterministicAi) يعمل بدون استدعاء مزود الذكاء الاصطناعي",
    bypassResponse !== null &&
      bypassResult.ok &&
      bypassAiCalls === 0 &&
      bypassHarness.state.assistantMessages === 1,
  );

  // ── 10. AI provider failure → controlled NEED_HUMAN + safe acknowledgment ─
  // The AI-authored content is never trusted, but the customer is not left
  // in silence: exactly one deterministic safe handoff acknowledgment is
  // persisted and delivered (DECISIONS #60 — the #58 invariant extended to
  // the AI-failure path).
  const failureHarness = createEngineHarness({
    ai: makeAi({ fail: true }),
    transport: noopTransport,
    findById: async (id) => businessRows.find((row) => row.id === id) ?? null,
  });
  const failureResult = await engine.receiveInboundMessage(
    failureHarness.deps as unknown as Parameters<
      typeof engine.receiveInboundMessage
    >[0],
    buildEngineInput("wamid.AIFAIL-1", "مرحبا"),
    identity,
  );
  check(
    "فشل مزود الذكاء الاصطناعي → NEED_HUMAN متحكَّم به مع إقرار آمن واحد (لا صمت)",
    failureResult.ok &&
      failureResult.duplicate === false &&
      failureResult.conversationStatus === "NEED_HUMAN" &&
      failureResult.assistantAction === "AI_HANDOFF" &&
      // no fabricated AI content, but exactly ONE deterministic safe
      // acknowledgment persisted and delivered
      failureHarness.state.assistantMessages === 1 &&
      failureHarness.state.sends.length === 1 &&
      failureHarness.state.sends[0]!.content ===
        failureHarness.state.assistantContents[0],
  );

  // ── 11. outbound Meta transport failure → truthful failure ────────────────
  const failingFetch: typeof fetch = async () =>
    new Response(
      JSON.stringify({ error: { code: 100, message: "invalid recipient" } }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  const failingTransport = metaClient.createMetaWhatsAppTransport({
    connectionDeps: resolutionDeps,
    getEnvVar: (name: string) =>
      ({
        [CREDENTIALS_REF]: TEST_TOKEN,
        WHATSAPP_META_API_VERSION: "v21.0",
      })[name],
    fetchImpl: failingFetch,
    graphHost: metaClient.META_GRAPH_HOST,
    defaultApiVersion: metaClient.META_DEFAULT_API_VERSION,
    credentialsResolver: new credentialsResolver.EnvCredentialsResolver({
      getEnvVar: (name: string) =>
        ({
          [CREDENTIALS_REF]: TEST_TOKEN,
          WHATSAPP_META_API_VERSION: "v21.0",
        })[name],
    }),
  });
  const outboundFailureHarness = createEngineHarness({
    ai: makeAi(),
    transport: failingTransport,
    findById: async (id) => businessRows.find((row) => row.id === id) ?? null,
  });
  const outboundFailureResult = await engine.receiveInboundMessage(
    outboundFailureHarness.deps as unknown as Parameters<
      typeof engine.receiveInboundMessage
    >[0],
    buildEngineInput("wamid.OUTFAIL-1", "مرحبا"),
    identity,
  );
  check(
    "فشل الإرسال (Graph 400) → delivered:false بلا نجاح زائف، والحالة لا تتحول إلى BOOKED",
    outboundFailureResult.ok &&
      outboundFailureResult.duplicate === false &&
      outboundFailureResult.delivery?.delivered === false &&
      outboundFailureResult.delivery?.provider === "meta-whatsapp" &&
      outboundFailureResult.conversationStatus === "AI_ACTIVE",
  );

  // ── 12. successful mocked end-to-end → exact Graph request ────────────────
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const succeedingFetch: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ messages: [{ id: "wamid.OUT-1" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const metaTransport = metaClient.createMetaWhatsAppTransport({
    connectionDeps: resolutionDeps,
    getEnvVar: (name: string) =>
      ({
        [CREDENTIALS_REF]: TEST_TOKEN,
        WHATSAPP_META_API_VERSION: "v21.0",
      })[name],
    fetchImpl: succeedingFetch,
    graphHost: metaClient.META_GRAPH_HOST,
    defaultApiVersion: metaClient.META_DEFAULT_API_VERSION,
    credentialsResolver: new credentialsResolver.EnvCredentialsResolver({
      getEnvVar: (name: string) =>
        ({
          [CREDENTIALS_REF]: TEST_TOKEN,
          WHATSAPP_META_API_VERSION: "v21.0",
        })[name],
    }),
  });
  const e2eHarness = createEngineHarness({
    ai: makeAi(),
    transport: metaTransport,
    findById: async (id) => businessRows.find((row) => row.id === id) ?? null,
  });
  const payloadRaw = JSON.stringify(
    metaPayload({ wamid: "wamid.E2E-FULL-1", text: "مرحبا" }),
  );
  const signature = `sha256=${createHmac("sha256", APP_SECRET).update(payloadRaw).digest("hex")}`;
  const signatureOk = metaWebhook.verifyMetaSignature(
    payloadRaw,
    signature,
    APP_SECRET,
  );
  const parsedE2e = metaWebhook.parseMetaWebhookPayload(
    JSON.parse(payloadRaw) as unknown,
  );
  const e2eResolution = await transport.resolveInboundConnection(
    resolutionDeps,
    parsedE2e.messages[0]!.recipientExternalId,
    parsedE2e.messages[0]!.recipientProviderId,
  );
  const e2eInput = buildEngineInput("wamid.E2E-FULL-1", "مرحبا");
  const e2eResult =
    signatureOk && e2eResolution.ok
      ? await engine.receiveInboundMessage(
          e2eHarness.deps as unknown as Parameters<
            typeof engine.receiveInboundMessage
          >[0],
          e2eInput,
          identity,
        )
      : null;
  const graphCall = calls[0];
  const graphBody = graphCall
    ? (JSON.parse(String(graphCall.init.body)) as Record<string, unknown>)
    : null;
  const authHeader = graphCall
    ? ((graphCall.init.headers as Record<string, string>)?.["Authorization"] ??
      "")
    : "";
  const resultJson = JSON.stringify(e2eResult);
  check(
    "نجاح كامل (توقيع → phone_number_id → المحرك → Graph 200): طلب الرسم يطابق العقد (URL/الهاتف/النص/المرجع السري)",
    e2eResult?.ok === true &&
      e2eResult.duplicate === false &&
      e2eResult.delivery?.delivered === true &&
      calls.length === 1 &&
      graphCall?.url ===
        `https://graph.facebook.com/v21.0/${PROVIDER_ID}/messages` &&
      graphBody?.to === CUSTOMER_PHONE &&
      graphBody?.type === "text" &&
      (graphBody?.text as { body?: string } | undefined)?.body ===
        "رد تجريبي" &&
      authHeader === `Bearer ${TEST_TOKEN}`,
  );
  check(
    "لا سر في أي نتيجة أو حمولة مسجّلة خارج حدود الإرسال",
    !resultJson.includes(TEST_TOKEN) && !resultJson.includes(CREDENTIALS_REF),
  );

  // ── Report ────────────────────────────────────────────────────────────────
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
    `\nمسار الوارد E2E محاكى بنجاح: ${checks.length}/${checks.length} فحص ناجح.`,
  );
}

main().catch((error: Error) => {
  console.error(`فشل غير متوقع: ${error.message}`);
  process.exit(1);
});
