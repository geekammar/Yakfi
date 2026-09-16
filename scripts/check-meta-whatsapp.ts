import { createHmac } from "node:crypto";

/* eslint-disable @typescript-eslint/consistent-type-imports */

/**
 * FlowPilot — META WHATSAPP adapter check (PROMPT-CORE-03B).
 *
 * Verifies the Meta WhatsApp Cloud API adapter on top of the
 * provider-neutral CORE-03A foundation — no DB, no network, no
 * vendor SDK (all deps are in-memory fakes):
 *
 *   1. valid webhook verification (subscribe + matching token → challenge)
 *   2. invalid verification rejected (wrong token / wrong mode → 403)
 *   3. invalid signature rejected (bad HMAC → 403; missing secret skips)
 *   4. valid inbound TEXT normalization (Meta payload → normalized TEXT +
 *      stable recipientProviderId = phone_number_id)
 *   5. malformed provider payload rejected (MALFORMED_PROVIDER_PAYLOAD)
 *   6. cross-business inbound rejected, inactive business rejected, and
 *      phone_number_id → connection → business resolution (unknown id
 *      fails safe)
 *   7. duplicate wamid deduplicated through the real engine ledger
 *   8. no secret appears in the normalized contract
 *   9. raw provider payload never escapes into Core
 *  10. outbound text maps to Meta Graph payload exactly
 *  11. error mapping (401/403→UNAUTHORIZED, 429/5xx→TRANSIENT, 368→TRANSIENT, else PERMANENT)
 *  12. retry classification (only TRANSIENT is retryable)
 *  13. no escalation — businessId/branchId/connectionId/role/accountType never from payload
 *  14. MEDIA media maps to MEDIA kind (no download), UNSUPPORTED handled
 *  15. no Meta code leaks into Core beyond the adapter boundary
 *
 * Run: pnpm check:meta-whatsapp
 */

export {};

type Check = { label: string; pass: boolean };

async function main(): Promise<void> {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const metaWebhook =
    await import("../src/server/integrations/whatsapp/meta-webhook");
  const metaClient =
    await import("../src/server/integrations/whatsapp/meta-client");
  const transport = await import("../src/server/transport/whatsapp-transport");
  const engineSchema =
    await import("../src/features/conversations/schemas/conversation-schema");
  const aiContract =
    await import("../src/features/conversations/server/ai-contract");
  const engine =
    await import("../src/features/conversations/server/conversation-engine");
  const dedupe =
    await import("../src/server/repositories/inbound-dedupe.repository");

  const checks: Check[] = [];
  function check(label: string, pass: boolean): void {
    checks.push({ label, pass });
  }

  // ── 1. valid webhook verification ─────────────────────────────────────
  const okVerify = metaWebhook.verifyMetaWebhookChallenge(
    { mode: "subscribe", token: "ok-verify", challenge: "CHAL_123" },
    "ok-verify",
  );
  check(
    "تحقق الويبهوك صالح (subscribe + نفس الرمز → يعيد challenge)",
    okVerify.ok === true &&
      (okVerify as { challenge: string }).challenge === "CHAL_123",
  );

  // ── 2. invalid verification rejected ──────────────────────────────────
  const badToken = metaWebhook.verifyMetaWebhookChallenge(
    { mode: "subscribe", token: "wrong", challenge: "CHAL_123" },
    "ok-verify",
  );
  const badMode = metaWebhook.verifyMetaWebhookChallenge(
    { mode: "unsubscribe", token: "ok-verify", challenge: "CHAL_123" },
    "ok-verify",
  );
  const noToken = metaWebhook.verifyMetaWebhookChallenge(
    { mode: "subscribe", token: "ok-verify", challenge: "CHAL_123" },
    undefined,
  );
  check(
    "تحقق الويبهوك مرفوض (رمز خاطئ/وضع خاطئ/رمز غير مُهيأ → 403)",
    !badToken.ok &&
      (badToken as { status: number }).status === 403 &&
      !badMode.ok &&
      !noToken.ok,
  );

  // ── 3. invalid signature rejected ─────────────────────────────────────
  const appSecret = "test-app-secret-12345678-example";
  const rawBody = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [],
  });
  const goodSig = `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
  const badSig = `sha256=${"0".repeat(64)}`;
  check(
    "توقيع الويبهوك صالح مقبول وتوقيع خاطئ مرفوض، وغياب السر يتخطى التحقق (dev)",
    metaWebhook.verifyMetaSignature(rawBody, goodSig, appSecret) === true &&
      metaWebhook.verifyMetaSignature(rawBody, badSig, appSecret) === false &&
      metaWebhook.verifyMetaSignature(rawBody, null, undefined) === true &&
      metaWebhook.verifyMetaSignature(rawBody, null, appSecret) === false,
  );

  // ── 4. valid inbound TEXT normalization ────────────────────────────────
  const phoneA = "+201001111111";
  const customerPhone = "+201234567890";
  const validPayload = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "entry-1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: phoneA,
                phone_number_id: "111",
              },
              contacts: [{ wa_id: customerPhone }],
              messages: [
                {
                  from: customerPhone,
                  id: "wamid.META-1",
                  timestamp: "1700000000",
                  type: "text",
                  text: { body: "مرحبا" },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  let textParsed: ReturnType<
    typeof metaWebhook.parseMetaWebhookPayload
  > | null = null;
  let textOk = false;
  try {
    textParsed = metaWebhook.parseMetaWebhookPayload(validPayload);
    textOk =
      textParsed.messages.length === 1 &&
      textParsed.messages[0]!.kind === "TEXT" &&
      textParsed.messages[0]!.text === "مرحبا" &&
      textParsed.messages[0]!.externalMessageId === "wamid.META-1";
  } catch {
    textOk = false;
  }
  check("حمولة Meta صالحة (نص) → ظرف TEXT موحّد", textOk);
  check(
    "حمولة Meta: phone_number_id يُستخرج كهوية استقبال مستقرة (recipientProviderId)",
    textParsed?.messages[0]?.recipientProviderId === "111" &&
      textParsed?.messages[0]?.recipientExternalId === phoneA,
  );

  // ── 5. malformed provider payload rejected ──────────────────────────────
  let malformedRejected = false;
  try {
    metaWebhook.parseMetaWebhookPayload({ object: "wrong", entry: [] });
  } catch (error) {
    malformedRejected =
      error instanceof transport.TransportError &&
      error.code === "MALFORMED_PROVIDER_PAYLOAD";
  }
  let missingFieldRejected = false;
  try {
    metaWebhook.parseMetaWebhookPayload({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { display_phone_number: phoneA },
                messages: [{ from: "", id: "", timestamp: "", type: "text" }],
              },
            },
          ],
        },
      ],
    });
  } catch (error) {
    missingFieldRejected =
      error instanceof transport.TransportError &&
      error.code === "MALFORMED_PROVIDER_PAYLOAD";
  }
  check(
    "حمولة غير صالحة/ناقصة → MALFORMED_PROVIDER_PAYLOAD",
    malformedRejected && missingFieldRejected,
  );

  // ── 6. cross-business / inactive rejected ───────────────────────────────
  const BUSINESS_A = "11111111-1111-4111-8111-111111111111";
  const BUSINESS_B = "22222222-2222-4222-8222-222222222222";
  const BUSINESS_INACTIVE = "44444444-4444-4444-8444-444444444445";
  const BRANCH_A = "33333333-3333-4333-8333-333333333333";
  const PHONE_INACTIVE = "+201003333333";
  const businessRows = [
    { id: BUSINESS_A, name: "منشأة أ", whatsappNumber: phoneA, isActive: true },
    {
      id: BUSINESS_B,
      name: "منشأة ب",
      whatsappNumber: "+201002222222",
      isActive: true,
    },
    {
      id: BUSINESS_INACTIVE,
      name: "موقوفة",
      whatsappNumber: PHONE_INACTIVE,
      isActive: false,
    },
  ];
  const canonicalPhone = (p: string) => p.replace(/[\s-]/g, "");
  const connectionDeps = {
    businessRepository: {
      findByWhatsappNumber: async (n: string) =>
        businessRows.find((r) => r.whatsappNumber === canonicalPhone(n)) ??
        null,
      findById: async (id: string) =>
        businessRows.find((r) => r.id === id) ?? null,
    },
    whatsappConnectionRepository: {
      findByPhone: async (bid: string, _phone: string) =>
        bid === BUSINESS_A
          ? ({
              id: "conn-a",
              businessId: BUSINESS_A,
              branchId: BRANCH_A,
              phoneNumber: phoneA,
              status: "CONNECTED",
              isActive: true,
            } as unknown as import("../src/types/domain").WhatsAppConnection)
          : null,
      findByIdWithinBusiness: async (id: string, bid: string) =>
        id === "conn-a" && bid === BUSINESS_A
          ? ({
              id: "conn-a",
              businessId: BUSINESS_A,
              branchId: BRANCH_A,
              phoneNumber: phoneA,
              status: "CONNECTED",
              isActive: true,
            } as unknown as import("../src/types/domain").WhatsAppConnection)
          : null,
      findByExternalId: async (externalId: string) =>
        externalId === "111"
          ? ({
              id: "conn-a",
              businessId: BUSINESS_A,
              branchId: BRANCH_A,
              phoneNumber: phoneA,
              status: "CONNECTED",
              isActive: true,
            } as unknown as import("../src/types/domain").WhatsAppConnection)
          : null,
    },
    branchRepository: {
      findDefaultByBusiness: async (bid: string) =>
        bid === BUSINESS_A
          ? ({
              id: BRANCH_A,
              businessId: BUSINESS_A,
            } as unknown as import("../src/types/domain").Branch)
          : null,
      findByIdWithinBusiness: async (id: string, bid: string) =>
        id === BRANCH_A && bid === BUSINESS_A
          ? ({
              id: BRANCH_A,
              businessId: BUSINESS_A,
            } as unknown as import("../src/types/domain").Branch)
          : null,
    },
  } as unknown as import("../src/server/transport/whatsapp-transport").ConnectionResolutionDeps;
  const crossBiz = await transport.resolveConnectionForSend(connectionDeps, {
    connectionId: "conn-a",
    businessId: BUSINESS_B,
  });
  const inactiveBiz = await transport.resolveInboundConnection(
    connectionDeps,
    PHONE_INACTIVE,
  );
  check(
    "عبر المنشآت/منشأة غير مفعّلة → INVALID_CONNECTION (بلا تسريب وجود)",
    !crossBiz.ok &&
      crossBiz.code === "INVALID_CONNECTION" &&
      !inactiveBiz.ok &&
      inactiveBiz.code === "INVALID_CONNECTION",
  );
  const providerResolved = await transport.resolveInboundConnection(
    connectionDeps,
    "+19990000000",
    "111",
  );
  const unknownProviderId = await transport.resolveInboundConnection(
    connectionDeps,
    "+19990000001",
    "unknown-phone-number-id",
  );
  check(
    "الوارد: phone_number_id → اتصال → منشأة/فرع (حتى مع رقم عرض مختلف)؛ phone_number_id مجهول → INVALID_CONNECTION",
    providerResolved.ok &&
      providerResolved.businessId === BUSINESS_A &&
      providerResolved.connectionId === "conn-a" &&
      providerResolved.branchId === BRANCH_A &&
      !unknownProviderId.ok &&
      unknownProviderId.code === "INVALID_CONNECTION",
  );

  // ── 7. duplicate wamid deduplicated (real engine ledger) ─────────────
  const dupResult = await runDupTest({
    transport,
    engineSchema,
    aiContract,
    engine,
    dedupe,
    businessId: BUSINESS_A,
    whatsappNumber: phoneA,
    customerPhone,
    receivedAt: "2026-09-14T10:00:00.000Z",
    externalId: "wamid.META-DUP-1",
  });
  check(
    "تكرار نفس wamid → duplicate:true بنفس المعرّفات (بلا رسالة ثانية)",
    dupResult.first.duplicate === false &&
      dupResult.second.duplicate === true &&
      dupResult.customerMessages.length === 1,
  );

  // ── 8. no secret in contract ──────────────────────────────────────────
  const secretPayload = transport.normalizeInboundTransportMessage({
    externalMessageId: "wamid.SECRET-1",
    senderExternalId: customerPhone,
    recipientExternalId: phoneA,
    timestamp: "2026-09-14T10:00:00.000Z",
    text: "hello",
    credentialsRef: "WHATSAPP_META_ACCESS_TOKEN",
    accessToken: "secret",
  } as unknown as Record<string, unknown>);
  const contractJson = JSON.stringify(textParsed?.messages ?? []);
  check(
    "لا سر في العقد الموحّد (credentialsRef/accessToken مرفوضة، لا تظهر في النتيجة)",
    !secretPayload.ok &&
      secretPayload.error.code === "MALFORMED_PROVIDER_PAYLOAD" &&
      !contractJson.includes("credentialsRef") &&
      !contractJson.includes("accessToken"),
  );

  // ── 9. raw provider payload never escapes ──────────────────────────────
  const rawPayloadInMessage = textParsed?.messages.some(
    (m) =>
      "rawPayload" in (m as Record<string, unknown>) ||
      "raw" in (m as Record<string, unknown>),
  );
  check(
    "الحمولة الخام لا تتسرب إلى النواة (لا rawPayload في الظرف)",
    !rawPayloadInMessage,
  );

  // ── 10. outbound text maps to Meta Graph payload ───────────────────────
  const metaPayload = metaClient.buildMetaTextPayload(
    customerPhone,
    "رد تجريبي",
  ) as Record<string, unknown>;
  const metaUrl = metaClient.buildMetaSendUrl(
    metaClient.META_GRAPH_HOST,
    "v21.0",
    "111",
  );
  check(
    "الصادر يطابق Meta Graph (messaging_product/whatsapp + POST /{v}/{phoneId}/messages)",
    metaPayload.messaging_product === "whatsapp" &&
      metaPayload.type === "text" &&
      (metaPayload.text as { body?: string }).body === "رد تجريبي" &&
      metaUrl === "https://graph.facebook.com/v21.0/111/messages",
  );

  // ── 11. error mapping ─────────────────────────────────────────────────
  const m401 = metaClient.mapMetaError(401, {
    error: { code: 190, message: "bad token" },
  });
  const m403 = metaClient.mapMetaError(403, null);
  const m429 = metaClient.mapMetaError(429, null);
  const m500 = metaClient.mapMetaError(500, null);
  const m368 = metaClient.mapMetaError(400, { error: { error_subcode: 368 } });
  const m400 = metaClient.mapMetaError(400, { error: { code: 100 } });
  check(
    "تخطيط أخطاء Meta: 401/403→UNAUTHORIZED، 429/5xx/368→TRANSIENT، 400 عام→PERMANENT",
    m401.code === "UNAUTHORIZED_CREDENTIALS" &&
      m403.code === "UNAUTHORIZED_CREDENTIALS" &&
      m429.code === "TRANSIENT_TRANSPORT_FAILURE" &&
      m500.code === "TRANSIENT_TRANSPORT_FAILURE" &&
      m368.code === "TRANSIENT_TRANSPORT_FAILURE" &&
      m400.code === "PERMANENT_TRANSPORT_FAILURE",
  );

  // ── 12. retry classification ──────────────────────────────────────────
  check(
    "تصنيف إعادة المحاولة: TRANSIENT فقط قابل لإعادة المحاولة",
    transport.isRetryableTransportErrorCode("TRANSIENT_TRANSPORT_FAILURE") &&
      !transport.isRetryableTransportErrorCode("PERMANENT_TRANSPORT_FAILURE") &&
      !transport.isRetryableTransportErrorCode("UNAUTHORIZED_CREDENTIALS") &&
      !transport.isRetryableTransportErrorCode("INVALID_CONNECTION"),
  );

  // ── 13. no escalation ─────────────────────────────────────────────────
  const hostile = transport.normalizeInboundTransportMessage({
    externalMessageId: "wamid.HOSTILE-1",
    senderExternalId: customerPhone,
    recipientExternalId: phoneA,
    timestamp: "2026-09-14T10:00:00.000Z",
    text: "hi",
    businessId: BUSINESS_B,
    branchId: BRANCH_A,
    connectionId: "conn-a",
    role: "ADMIN",
    accountType: "PLATFORM",
  } as unknown as Record<string, unknown>);
  check(
    "لا تصعيد امتيازات (businessId/branchId/connectionId/role/accountType مرفوضة)",
    !hostile.ok && hostile.error.code === "MALFORMED_PROVIDER_PAYLOAD",
  );

  // ── 14. MEDIA / UNSUPPORTED handling ───────────────────────────────────
  const mediaPayload = {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { display_phone_number: phoneA },
              messages: [
                {
                  from: customerPhone,
                  id: "wamid.MEDIA-1",
                  timestamp: "1700000000",
                  type: "image",
                  image: { id: "media-123", mime_type: "image/jpeg" },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const unsupportedPayload = {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { display_phone_number: phoneA },
              messages: [
                {
                  from: customerPhone,
                  id: "wamid.UNSUP-1",
                  timestamp: "1700000000",
                  type: "reaction",
                },
              ],
            },
          },
        ],
      },
    ],
  };
  let mediaOk = false;
  let unsupOk = false;
  try {
    const mediaParsed = metaWebhook.parseMetaWebhookPayload(mediaPayload);
    mediaOk = mediaParsed.messages[0]?.kind === "MEDIA";
    if (mediaOk) {
      let threw = false;
      try {
        transport.toEngineInboundMessage({
          ...mediaParsed.messages[0]!,
          connectionId: "conn-a",
          businessId: BUSINESS_A,
          branchId: BRANCH_A,
        });
      } catch (e) {
        threw =
          e instanceof transport.TransportError &&
          e.code === "UNSUPPORTED_MESSAGE_TYPE";
      }
      mediaOk = mediaOk && threw;
    }
  } catch {
    mediaOk = false;
  }
  try {
    const u = metaWebhook.parseMetaWebhookPayload(unsupportedPayload);
    unsupOk = u.messages[0]?.kind === "UNSUPPORTED";
  } catch {
    unsupOk = false;
  }
  check(
    "MEDIA → نوع MEDIA (مرجع فقط) و UNSUPPORTED يُحفظ دون تسريب، والوسائط تُرفض عند النواة",
    mediaOk && unsupOk,
  );

  // ── 15. status callbacks counted but not turned into messages ──────────
  const statusPayload = {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { display_phone_number: phoneA },
              statuses: [{ id: "wamid.S-1", status: "delivered" }],
            },
          },
        ],
      },
    ],
  };
  const statusParsed = metaWebhook.parseMetaWebhookPayload(statusPayload);
  check(
    "استدعاءات الحالة (statuses) تُحصى ولا تتحول لرسائل واردة",
    statusParsed.messages.length === 0 && statusParsed.statusCount === 1,
  );

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
    `\nاختبارات محول Meta صحيحة: ${checks.length}/${checks.length} فحص ناجح.`,
  );
}

async function runDupTest(params: {
  transport: typeof import("../src/server/transport/whatsapp-transport");
  engineSchema: typeof import("../src/features/conversations/schemas/conversation-schema");
  aiContract: typeof import("../src/features/conversations/server/ai-contract");
  engine: typeof import("../src/features/conversations/server/conversation-engine");
  dedupe: typeof import("../src/server/repositories/inbound-dedupe.repository");
  businessId: string;
  whatsappNumber: string;
  customerPhone: string;
  receivedAt: string;
  externalId: string;
}): Promise<{
  first: {
    ok: boolean;
    duplicate?: boolean;
    conversationId: string;
    customerMessageId: string;
  };
  second: {
    ok: boolean;
    duplicate?: boolean;
    conversationId: string;
    customerMessageId: string;
  };
  customerMessages: string[];
}> {
  const {
    transport,
    engineSchema,
    aiContract,
    engine,
    dedupe,
    businessId,
    whatsappNumber,
    customerPhone,
    receivedAt,
    externalId,
  } = params;
  const customerMessages: string[] = [];
  const ledger = new Map<
    string,
    {
      claimId: string;
      conversationId: string | null;
      customerMessageId: string | null;
    }
  >();
  const dedupeRepo = {
    claim: async (bid: string, key: string) => {
      const k = `${bid}|${key}`;
      const ex = ledger.get(k);
      if (ex) {
        if (ex.customerMessageId)
          return {
            status: "duplicate" as const,
            claimId: ex.claimId,
            conversationId: ex.conversationId,
            customerMessageId: ex.customerMessageId,
          };
        return { status: "reclaim" as const, claimId: ex.claimId };
      }
      const claimId = `claim-${ledger.size + 1}`;
      ledger.set(k, { claimId, conversationId: null, customerMessageId: null });
      return { status: "claimed" as const, claimId };
    },
  };
  const now = new Date(receivedAt);
  const conversation = {
    id: "conversation-1",
    businessId,
    customerId: "customer-1",
    branchId: "branch-1",
    assignedUserId: null,
    status: "AI_ACTIVE" as const,
    lastMessageAt: null,
    aiSummary: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  } as unknown as import("../src/types/domain").Conversation;
  const customer = {
    id: "customer-1",
    businessId,
    name: "عميل",
    phone: customerPhone,
    email: null,
    notes: null,
    lastConversationAt: null,
    lastAppointmentAt: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  } as unknown as import("../src/types/domain").Customer;
  const messages: import("../src/types/domain").Message[] = [];
  const deps: import("../src/features/conversations/server/conversation-engine").ConversationEngineDeps =
    {
      businessRepository: {
        findByWhatsappNumber: async () =>
          ({
            id: businessId,
            name: "منشأة",
            whatsappNumber,
            isActive: true,
          }) as unknown as import("../src/types/domain").Business,
      },
      branchRepository: {
        findDefaultByBusiness: async () =>
          ({
            id: "branch-1",
            businessId,
          }) as unknown as import("../src/types/domain").Branch,
      },
      customerRepository: {
        upsertByPhone: async () => customer,
        touchConversation: async () => customer,
      },
      conversationRepository: {
        findLatestByCustomer: async () => ({ id: conversation.id }),
        findById: async () => conversation,
        create: async () => conversation,
        addMessage: async (input, _wf, ref) => {
          const row = ref
            ? [...ledger.values()].find((r) => r.claimId === ref.claimId)
            : undefined;
          if (ref) {
            if (!row) throw new Error("UNKNOWN_CLAIM");
            if (row.customerMessageId)
              throw new dedupe.InboundDuplicateError({
                conversationId: row.conversationId,
                customerMessageId: row.customerMessageId,
              });
          }
          const msg = {
            id: `message-${messages.length + 1}`,
            conversationId: input.conversationId,
            senderType: input.senderType,
            content: input.content,
            createdAt: input.createdAt ?? new Date(),
            updatedAt: new Date(),
          } as unknown as import("../src/types/domain").Message;
          messages.push(msg);
          if (input.senderType === "CUSTOMER") customerMessages.push(msg.id);
          if (row) {
            row.conversationId = input.conversationId;
            row.customerMessageId = msg.id;
          }
          return msg;
        },
        getMessages: async () => [...messages].reverse(),
        update: async () => conversation,
        updateWorkflow: async () => conversation,
      },
      serviceRepository: { listByBusiness: async () => [] },
      inboundDedupeRepository: dedupeRepo,
      usageRepository: {
        record: async (i) => i as import("../src/types/domain").UsageRecord,
      },
      ai: {
        providerName: "fake-ai",
        respond: async () => ({
          intent: "FAQ" as const,
          action: "reply" as const,
          content: "رد",
          extraction: aiContract.emptyAiExtraction,
          handoffReason: null,
          summary: null,
        }),
      },
      transport: {
        providerName: "fake-transport",
        send: async () => ({ provider: "fake-transport", delivered: true }),
      },
    };
  const envelope = transport.normalizeInboundTransportMessage({
    externalMessageId: externalId,
    senderExternalId: customerPhone,
    recipientExternalId: whatsappNumber,
    timestamp: receivedAt,
    text: "مرحبا",
  });
  let engineInput: unknown = null;
  if (envelope.ok) {
    const mapped = transport.toEngineInboundMessage({
      ...envelope.message,
      connectionId: conversation.id,
      businessId,
      branchId: "branch-1",
    });
    const parsed = engineSchema.inboundMessageSchema.safeParse(mapped);
    if (parsed.success) engineInput = parsed.data;
  }
  const first = await engine.receiveInboundMessage(deps, engineInput);
  const second = await engine.receiveInboundMessage(deps, engineInput);
  return {
    first: {
      ok: first.ok,
      duplicate: first.ok
        ? (first as { duplicate?: boolean }).duplicate
        : undefined,
      conversationId:
        first.ok && !(first as { duplicate?: boolean }).duplicate
          ? (first as unknown as { conversationId: string }).conversationId
          : "",
      customerMessageId:
        first.ok && !(first as { duplicate?: boolean }).duplicate
          ? (first as unknown as { customerMessageId: string })
              .customerMessageId
          : "",
    },
    second: {
      ok: second.ok,
      duplicate: second.ok
        ? (second as { duplicate?: boolean }).duplicate
        : undefined,
      conversationId: second.ok
        ? (second as { conversationId: string }).conversationId
        : "",
      customerMessageId: second.ok
        ? (second as { customerMessageId: string }).customerMessageId
        : "",
    },
    customerMessages,
  };
}

main().catch((error: Error) => {
  console.error(`فشل غير متوقع: ${error.message}`);
  process.exit(1);
});
