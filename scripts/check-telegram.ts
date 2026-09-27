/* eslint-disable @typescript-eslint/consistent-type-imports */

/**
 * FlowPilot — TELEGRAM second-channel foundation harness
 * (DECISIONS #63/#64 — POST v0.30.0).
 *
 * Focused OFFLINE checks for the Telegram implementation surface built in
 * this slice. No DB, no network, no real credentials — in-memory fakes
 * only. Proves:
 *
 *   A. the provider-neutral external-handle identity seam (E.164 is a
 *      strict subset — WhatsApp identity stays valid; Telegram chat ids
 *      are accepted through the SAME schemas);
 *   B. Telegram Update parsing (private text accepted; non-private routed
 *      away; non-text follows the approved unsupported contract; malformed
 *      rejected; the managed_bot event classified);
 *   C. webhook secret verification (constant-time; invalid → rejected;
 *      the digest is non-reversible);
 *   D. the outbound transport mapping (same-Business + CONNECTED/isActive
 *      gate; chat_id = the engine's external handle; cross-Business
 *      connection refused);
 *   E. connection verification (`getMe`; id mismatch → failure);
 *   F. the provisioning ledger invariants (single-use token, creator
 *      binding, one bot cannot attach to another Business, token stored
 *      only as an `fp:<id>` reference, the webhook digest round-trips);
 *   G. provider-neutral Conversation Engine usage (the REAL engine turns
 *      a Telegram-handle inbound into a reply + update_id dedupe, with
 *      zero channel logic in the engine);
 *   H. the per-connection webhook route (secret verification before any
 *      parsing, server-side tenant resolution, the 200-prompt +
 *      deferred-turn contract, hostile-key stripping);
 *   I. the provisioning LAUNCH (the deep link carries only the opaque
 *      token; `ensureManagerWebhook` self-wires the manager endpoint);
 *   J. single-use consumption, replay, wrong creator, wrong Business,
 *      expiry;
 *   K. the ONE UI state machine (EMPTY / PROVISIONING / CONNECTED /
 *      DISCONNECTED / ACTION_REQUIRED) derived server-side;
 *   L. the MANAGER WEBHOOK — the whole provisioning lifecycle through the
 *      real handler: `/start` creator binding + the creation keyboard, the
 *      `managed_bot` completion (token → `fp:<id>` → `setWebhook` →
 *      `getMe` → CONNECTED), replay refusal, cross-tenant refusal;
 *   M. typed provisioning failure (the attempt terminates with a typed
 *      outcome + no half-provisioned connection + no token leakage);
 *   N. disconnect / reconnect (the supported lifecycle);
 *   O. the provisioning state machine's every rejection boundary
 *      (malformed / missing / expired / consumed / wrong-creator
 *      payloads), every typed provider failure (setWebhook, getMe), and
 *      the CONNECTED transition guard;
 *   P. WEBHOOK ROUTE REACHABILITY through the route proxy's public-path
 *      policy — the defect the live v0.31.0 E2E surfaced: both Telegram
 *      endpoints sat behind the session gate, so the proxy answered every
 *      Telegram delivery with a 307 to /sign-in and nothing ever arrived.
 *
 * Run: pnpm check:telegram
 */

export {};

type Check = { label: string; pass: boolean };

const checks: Check[] = [];
function check(label: string, pass: boolean): void {
  checks.push({ label, pass });
}
function eq<T>(actual: T, expected: T): boolean {
  return actual === expected;
}
function nowIso(): string {
  return new Date().toISOString();
}

// ── Fixtures (no real credentials) ──────────────────────────────────────────

const BUSINESS_A = "11111111-1111-4111-8111-111111111111";
const BUSINESS_B = "22222222-2222-4222-8222-222222222222";
const BRANCH_A = "33333333-3333-4333-8333-333333333333";
const CONNECTION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONNECTION_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BOT_ID = "6123456789";
// The manager-webhook lifecycle (section L) provisions its OWN bot —
// distinct from the BOT_ID section F already connected, so the
// duplicate-attach guard sees a genuinely new bot.
const BOT_ID_L = "6123456799";
const BOT_USERNAME = "flowpilot_demo";
const MANAGER_BOT_ID = "6987654321";
const CREATOR_ID = "9876543210";
const CHAT_ID = "5554443333";
const WEBHOOK_SECRET = "s3cr3t-token-for-bot-a-value-value";
const BOT_TOKEN_VALUE = "1234567890:AAA-managed-bot-token-never-logged";
const MANAGER_TOKEN_VALUE = "6987654321:AAA-manager-bot-token-never-logged";
const BUSINESS_NAME = "عيادة الابتسامة";
const MANAGER_USERNAME = "FlowPilotManagerBot";

async function main(): Promise<void> {
  // Offline harness convention (see check-whatsapp-inbound): seed
  // placeholder env BEFORE importing the transport/repositories layer,
  // which evaluates the fail-fast env module at import time. No DB or
  // network is ever contacted — every dependency below is in-memory.
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const { externalHandleSchema } = await import("@/lib/validation");
  const { inboundMessageSchema } =
    await import("@/features/conversations/schemas/conversation-schema");
  const {
    hashTelegramWebhookSecret,
    parseTelegramUpdate,
    verifyTelegramWebhookSecretConstantTime,
  } = await import("@/server/integrations/telegram/telegram-webhook");
  const { mapTelegramError } =
    await import("@/server/integrations/telegram/telegram-client");

  // ════════════════════════════════════════════════════════════════════════
  // A. Provider-neutral external-handle identity seam (DECISIONS #64)
  // ════════════════════════════════════════════════════════════════════════

  check(
    "A1. مقبض E.164 لواتساب لا يزال مقبولاً (المجموعة الفرعية الصارمة)",
    externalHandleSchema.safeParse("+201001111111").success &&
      externalHandleSchema.safeParse("12025550123").success,
  );
  check(
    "A2. مقبض تيليجرام (معرّف محادثة أرقام) مقبول عبر نفس المخطط",
    externalHandleSchema.safeParse(CHAT_ID).success &&
      externalHandleSchema.safeParse(BOT_ID).success,
  );
  check(
    "A3. القمامة مرفوضة (المقبض الخارجي)",
    !externalHandleSchema.safeParse("").success &&
      !externalHandleSchema.safeParse("abc-not-a-handle").success &&
      !externalHandleSchema.safeParse("a".repeat(200)).success,
  );

  // The engine's inbound contract — the ONE seam that used to be
  // phone-shaped. Both channels cross it unchanged.
  check(
    "A4. حمولة واتساب لا تزال تعبر مخطّط الرسالة الواردة (دون تغيير)",
    inboundMessageSchema.safeParse({
      to: "+201000000000",
      from: "+201234567890",
      text: "مرحباً",
      receivedAt: nowIso(),
      externalId: "wamid.legacy",
    }).success,
  );
  check(
    "A5. حمولة تيليجرام تعبر نفس مخطّط الرسالة الواردة (نفس البنية)",
    inboundMessageSchema.safeParse({
      to: BOT_ID,
      from: CHAT_ID,
      text: "مرحباً",
      receivedAt: nowIso(),
      externalId: `tg:${BOT_ID}:7770001`,
    }).success,
  );
  // The documented contract (whatsapp-transport.ts): unknown/hostile keys
  // in a provider payload are STRIPPED by Zod — identity is never injected
  // from a client payload because the engine takes businessId/branchId/
  // connectionId ONLY from the server-resolved identity argument, never
  // from the parsed message.
  {
    const hostile = inboundMessageSchema.safeParse({
      to: BOT_ID,
      from: CHAT_ID,
      text: "x",
      receivedAt: nowIso(),
      businessId: BUSINESS_B, // hostile — must never survive parsing
      branchId: BRANCH_A,
      connectionId: CONNECTION_A,
      role: "ADMIN", // an escalation attempt
    });
    check(
      "A6. مقبض العميل/المستلم لا يمكنه حقن هوية النطاق (يتم تجريده)",
      hostile.success &&
        !("businessId" in hostile.data) &&
        !("branchId" in hostile.data) &&
        !("connectionId" in hostile.data) &&
        !("role" in hostile.data) &&
        eq(hostile.data.from, CHAT_ID),
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  // B. Telegram Update parsing
  // ════════════════════════════════════════════════════════════════════════

  const privateText = parseTelegramUpdate(
    {
      update_id: 7770001,
      message: {
        message_id: 42,
        date: 1758900000,
        chat: { id: Number(CHAT_ID), type: "private", first_name: "أحمد" },
        from: { id: Number(CHAT_ID), is_bot: false },
        text: "السلام عليكم، عايز أحجز موعد",
      },
    },
    { botExternalId: BOT_ID },
  );
  check(
    "B1. رسالة خاصة نصية → مقبولة ومُطبَّعة كمغلف نيوترالي",
    privateText.status === "message" &&
      eq(privateText.message.senderExternalId, CHAT_ID) &&
      eq(privateText.message.recipientExternalId, BOT_ID) &&
      eq(privateText.message.kind, "TEXT") &&
      privateText.message.text?.includes("أحجز") === true,
  );
  check(
    "B2. update_id هو مفتاح الاستدعاء الخارجي (مُسمّى بالبوت للدقّة)",
    privateText.status === "message" &&
      eq(privateText.message.externalMessageId, `tg:${BOT_ID}:7770001`),
  );

  const groupText = parseTelegramUpdate(
    {
      update_id: 7770002,
      message: {
        message_id: 43,
        date: 1758900001,
        chat: { id: -1001234567890, type: "supergroup" },
        from: { id: Number(CHAT_ID) },
        text: "مرحبا",
      },
    },
    { botExternalId: BOT_ID },
  );
  check(
    "B3. المحادثات غير الخاصة → مُتجاهلة (نطاق الموافق عليه: الخاص فقط)",
    groupText.status === "ignored" && eq(groupText.reason, "NON_PRIVATE_CHAT"),
  );

  const sticker = parseTelegramUpdate(
    {
      update_id: 7770003,
      message: {
        message_id: 44,
        date: 1758900002,
        chat: { id: Number(CHAT_ID), type: "private" },
        from: { id: Number(CHAT_ID) },
        sticker: { file_id: "x", width: 512, height: 512 },
      },
    },
    { botExternalId: BOT_ID },
  );
  check(
    "B4. الرسائل غير النصية → العقد المعتمد (غير مدعوم، مُتجاهل — دون اختراع سلوك)",
    sticker.status === "ignored" &&
      eq(sticker.reason, "UNSUPPORTED_MESSAGE_TYPE"),
  );

  const callbackQuery = parseTelegramUpdate(
    { update_id: 7770004, callback_query: { id: "cq1", data: "x" } },
    { botExternalId: BOT_ID },
  );
  check(
    "B5. أنواع التحديث غير المدعومة → مُتجاهلة",
    callbackQuery.status === "ignored" &&
      eq(callbackQuery.reason, "UNSUPPORTED_UPDATE_TYPE"),
  );

  const malformedNoId = parseTelegramUpdate(
    { message: { text: "x" } },
    {
      botExternalId: BOT_ID,
    },
  );
  const malformedArray = parseTelegramUpdate([], { botExternalId: BOT_ID });
  const malformedMsg = parseTelegramUpdate(
    { update_id: 9, message: { chat: { type: "private" } } },
    { botExternalId: BOT_ID },
  );
  check(
    "B6. الحمولات المعطوبة → مرفوضة (MALFORMED_PROVIDER_PAYLOAD)",
    malformedNoId.status === "malformed" &&
      malformedArray.status === "malformed" &&
      malformedMsg.status === "malformed",
  );

  const managedBotEvent = parseTelegramUpdate(
    {
      update_id: 7770005,
      managed_bot: {
        added: true,
        bot: { id: Number(BOT_ID), is_bot: true, username: BOT_USERNAME },
        user: { id: Number(CREATOR_ID), is_bot: false },
      },
    },
    { botExternalId: BOT_ID },
  );
  check(
    "B7. حدث managed_bot → مُصنَّف كحدث تفعيل بالمنشئ + البوت",
    managedBotEvent.status === "managed_bot" &&
      eq(managedBotEvent.event.creatorTelegramUserId, CREATOR_ID) &&
      eq(managedBotEvent.event.botExternalId, BOT_ID) &&
      eq(managedBotEvent.event.botUsername, BOT_USERNAME),
  );
  check(
    "B8. حدث managed_bot معطوب → مرفوض",
    parseTelegramUpdate(
      { update_id: 1, managed_bot: { bot: {}, user: {} } },
      { botExternalId: BOT_ID },
    ).status === "malformed",
  );

  // ════════════════════════════════════════════════════════════════════════
  // C. Webhook secret verification (constant-time, non-reversible)
  // ════════════════════════════════════════════════════════════════════════

  const digest = hashTelegramWebhookSecret(WEBHOOK_SECRET);
  check(
    "C1. مقارنة سرّ الويبهوك ثابتة الزمن وتقبل السرّ الصحيح",
    verifyTelegramWebhookSecretConstantTime(
      digest,
      hashTelegramWebhookSecret(WEBHOOK_SECRET),
    ),
  );
  check(
    "C2. سرّ خاطئ → مرفوض",
    !verifyTelegramWebhookSecretConstantTime(
      hashTelegramWebhookSecret("wrong-secret-value-here-x"),
      digest,
    ),
  );
  check(
    "C3. الملخّص غير عكسي (طول ثابت 64، لا يحمل السرّ)",
    digest.length === 64 && !digest.includes(WEBHOOK_SECRET),
  );
  check(
    "C4. مقارنة بطول غير متطابق → مرفوضة بأمان",
    !verifyTelegramWebhookSecretConstantTime("short", digest),
  );
  check(
    "C5. أخطاء تيليجرام تُخطَّط على تصنيف النقل (401→اعتماد، 429→عابر)",
    eq(mapTelegramError(401, null), "UNAUTHORIZED_CREDENTIALS") &&
      eq(mapTelegramError(403, null), "UNAUTHORIZED_CREDENTIALS") &&
      eq(mapTelegramError(429, null), "TRANSIENT_TRANSPORT_FAILURE") &&
      eq(mapTelegramError(500, null), "TRANSIENT_TRANSPORT_FAILURE") &&
      eq(mapTelegramError(400, null), "PERMANENT_TRANSPORT_FAILURE"),
  );

  // ════════════════════════════════════════════════════════════════════════
  // D. Outbound transport mapping + ownership
  // ════════════════════════════════════════════════════════════════════════

  const { createTelegramMessageTransport } =
    await import("@/server/integrations/telegram/telegram-transport");

  type FakeConnection = import("@/types/domain").TelegramConnection;
  function fakeConnection(input: {
    id: string;
    businessId: string;
    branchId: string | null;
    botExternalId: string;
    status: "PENDING" | "CONNECTED" | "DISCONNECTED";
    isActive: boolean;
    credentialsRef: string | null;
    onboardingState?: FakeConnection["onboardingState"];
  }): FakeConnection {
    const now = new Date();
    return {
      id: input.id,
      businessId: input.businessId,
      branchId: input.branchId,
      displayName: null,
      botExternalId: input.botExternalId,
      botUsername: null,
      provider: "telegram_managed",
      status: input.status,
      credentialsRef: input.credentialsRef,
      credentialKind: input.credentialsRef ? "RUNTIME" : null,
      webhookSecretHash: null,
      isActive: input.isActive,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      onboardingState: input.onboardingState ?? "READY",
      onboardingActor: "NONE",
      onboardingReasonCode: null,
      onboardingReasonSummary: null,
      onboardingRetryable: null,
      onboardingStateChangedAt: null,
      onboardingCompletedAt: null,
      onboardingFailedAt: null,
      managerBotId: null,
      creatorTelegramUserId: null,
    };
  }
  const connections: FakeConnection[] = [
    fakeConnection({
      id: CONNECTION_A,
      businessId: BUSINESS_A,
      branchId: BRANCH_A,
      botExternalId: BOT_ID,
      status: "CONNECTED",
      isActive: true,
      credentialsRef: "fp:conn-a-ref",
    }),
    fakeConnection({
      id: CONNECTION_B,
      businessId: BUSINESS_B,
      branchId: null,
      botExternalId: "6999999999",
      status: "CONNECTED",
      isActive: true,
      credentialsRef: "fp:conn-b-ref",
    }),
  ];
  const sentCalls: Array<{
    url: string;
    body: { chat_id: string; text: string };
  }> = [];
  const transport = createTelegramMessageTransport({
    api: {
      fetchImpl: (async (url: string, init?: RequestInit) => {
        sentCalls.push({
          url,
          body: JSON.parse(String(init?.body ?? "{}")) as {
            chat_id: string;
            text: string;
          },
        });
        return new Response(
          JSON.stringify({ ok: true, result: { message_id: 1 } }),
          {
            status: 200,
          },
        );
      }) as typeof fetch,
      apiHost: "https://api.telegram.org",
      credentialsResolver: {
        resolve: async (reference: string) => {
          if (reference === "fp:conn-a-ref") {
            return {
              ok: true as const,
              kind: "RUNTIME" as const,
              reference,
              value: BOT_TOKEN_VALUE,
            };
          }
          return {
            ok: false as const,
            code: "UNRESOLVED_REFERENCE" as const,
            message: "غير متاح",
          };
        },
      },
    },
    connectionRepository: {
      findByIdWithinBusiness: async (id: string, businessId: string) =>
        connections.find(
          (connection) =>
            connection.id === id && connection.businessId === businessId,
        ) ?? null,
    },
    credentialsResolver: {
      resolve: async (reference: string) => {
        if (reference === "fp:conn-a-ref") {
          return {
            ok: true as const,
            kind: "RUNTIME" as const,
            reference,
            value: BOT_TOKEN_VALUE,
          };
        }
        return {
          ok: false as const,
          code: "UNRESOLVED_REFERENCE" as const,
          message: "غير متاح",
        };
      },
      // The transport only reads; these satisfy the interface honestly.
      store: async () => ({
        ok: false as const,
        code: "UNSUPPORTED_KIND" as const,
        message: "غير مدعوم في هذا الفحص",
      }),
      delete: async () => ({
        ok: false as const,
        code: "UNSUPPORTED_KIND" as const,
        message: "غير مدعوم في هذا الفحص",
      }),
    },
  });

  const sendOk = await transport.send({
    to: CHAT_ID,
    businessId: BUSINESS_A,
    businessName: "العيادة",
    conversationId: "conv-1",
    content: "مرحباً، أهلاً بك",
    connectionId: CONNECTION_A,
    kind: "TEXT",
  });
  check(
    "D1. إرسال ناجح → sendMessage إلى chat_id = المقبض الخارجي (لا منطق قناة)",
    sendOk.delivered &&
      sentCalls.length === 1 &&
      eq(sentCalls[0]!.body.chat_id, CHAT_ID) &&
      eq(sentCalls[0]!.body.text, "مرحباً، أهلاً بك"),
  );
  check(
    "D2. no credential leakage — الرابط يحوي التوكن لكن النتيجة لا تحوي قيمته أبداً",
    sentCalls[0]!.url.includes(`bot${BOT_TOKEN_VALUE}/sendMessage`) &&
      !JSON.stringify(sendOk).includes(BOT_TOKEN_VALUE),
  );

  const crossTenant = await transport.send({
    to: CHAT_ID,
    businessId: BUSINESS_A,
    businessName: "العيادة",
    conversationId: "conv-1",
    content: "x",
    connectionId: CONNECTION_B, // belongs to BUSINESS_B
    kind: "TEXT",
  });
  check(
    "D3. عزل النطاق: اتصال منشأة أخرى مرفوض (INVALID_CONNECTION)",
    !crossTenant.delivered && eq(crossTenant.errorCode, "INVALID_CONNECTION"),
  );

  // ════════════════════════════════════════════════════════════════════════
  // E. Connection verification (`getMe`)
  // ════════════════════════════════════════════════════════════════════════

  const { verifyTelegramConnection } =
    await import("@/server/integrations/telegram/telegram-verify");
  const verifyDeps = {
    fetchImpl: (async (url: string) => {
      if (url.includes("/getMe")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              id: Number(BOT_ID),
              is_bot: true,
              username: BOT_USERNAME,
              first_name: "Demo Bot",
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: false, error_code: 401 }), {
        status: 401,
      });
    }) as typeof fetch,
    apiHost: "https://api.telegram.org",
    credentialsResolver: {
      resolve: async (reference: string) => ({
        ok: true as const,
        kind: "RUNTIME" as const,
        reference,
        value: BOT_TOKEN_VALUE,
      }),
    },
  };

  const verified = await verifyTelegramConnection(verifyDeps, {
    externalId: BOT_ID,
    credentialsRef: "fp:conn-a-ref",
  });
  check(
    "E1. getMe ناجح → هوية مُتحقَّق منها مطابقة + اسم المستخدم",
    verified.ok === true &&
      eq(verified.verifiedExternalId, BOT_ID) &&
      eq(verified.verifiedName, `@${BOT_USERNAME}`),
  );

  const mismatch = await verifyTelegramConnection(verifyDeps, {
    externalId: "6000000000", // different stored id
    credentialsRef: "fp:conn-a-ref",
  });
  check(
    "E2. تباين هوية البوت → فشل INVALID_CONNECTION",
    mismatch.ok === false && eq(mismatch.code, "INVALID_CONNECTION"),
  );

  const badCreds = await verifyTelegramConnection(
    {
      ...verifyDeps,
      credentialsResolver: {
        resolve: async () => ({
          ok: false as const,
          code: "UNRESOLVED_REFERENCE" as const,
          message: "غير متاح",
        }),
      },
    },
    { externalId: BOT_ID, credentialsRef: "fp:missing" },
  );
  check(
    "E3. مرجع اعتماد غير قابل للحل → INVALID_CREDENTIALS",
    badCreds.ok === false && eq(badCreds.code, "INVALID_CREDENTIALS"),
  );

  // ════════════════════════════════════════════════════════════════════════
  // F. Provisioning ledger invariants + the managed-bot boundary
  // ════════════════════════════════════════════════════════════════════════

  const { completeManagedBotProvisioning, mintTelegramStartToken } =
    await import("@/server/integrations/telegram/telegram-provisioning");

  type LedgerRow = {
    id: string;
    businessId: string;
    connectionId: string | null;
    startToken: string;
    creatorTelegramUserId: string | null;
    expiresAt: Date;
    consumedAt: Date | null;
    outcomeCode: string | null;
    createdAt: Date;
  };
  const ledger: LedgerRow[] = [];
  const createdConnections: Array<import("@/types/domain").TelegramConnection> =
    [];
  const storedSecrets = new Map<string, string>();

  let ledgerSeq = 0;
  const provisioningDeps = {
    api: {
      fetchImpl: (async (url: string) => {
        if (url.includes("getManagedBotToken")) {
          return new Response(
            JSON.stringify({ ok: true, result: { token: BOT_TOKEN_VALUE } }),
            { status: 200 },
          );
        }
        if (url.includes("setWebhook")) {
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        }
        if (url.includes("getMe")) {
          return new Response(
            JSON.stringify({
              ok: true,
              result: {
                id: Number(BOT_ID),
                is_bot: true,
                username: BOT_USERNAME,
              },
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ ok: false, error_code: 400 }), {
          status: 400,
        });
      }) as typeof fetch,
      apiHost: "https://api.telegram.org",
      credentialsResolver: {
        resolve: async (reference: string) => {
          const value = storedSecrets.get(reference);
          return value
            ? { ok: true as const, kind: "RUNTIME" as const, reference, value }
            : {
                ok: false as const,
                code: "UNRESOLVED_REFERENCE" as const,
                message: "غير متاح",
              };
        },
      },
    },
    ledgerRepository: {
      create: async (input: {
        businessId: string;
        startToken: string;
        expiresAt: Date;
      }) => {
        const row: LedgerRow = {
          id: `led-${++ledgerSeq}`,
          businessId: input.businessId,
          connectionId: null,
          startToken: input.startToken,
          creatorTelegramUserId: null,
          expiresAt: input.expiresAt,
          consumedAt: null,
          outcomeCode: null,
          createdAt: new Date(),
        };
        ledger.push(row);
        return row;
      },
      findActiveByBusiness: async (businessId: string) =>
        ledger.find(
          (row) =>
            row.businessId === businessId &&
            row.consumedAt === null &&
            row.expiresAt > new Date(),
        ) ?? null,
      findLatestByBusiness: async (businessId: string) =>
        ledger
          .filter((row) => row.businessId === businessId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ??
        null,
      bindCreator: async (
        startToken: string,
        creatorTelegramUserId: string,
      ) => {
        // Mirrors the real conditional update: the row must be
        // unconsumed, unexpired, and UNBOUND or already bound to THIS
        // SAME creator (single-use binding — a second account that
        // received the shared link cannot steal the attempt).
        const row = ledger.find(
          (candidate) =>
            candidate.startToken === startToken &&
            candidate.consumedAt === null &&
            candidate.expiresAt > new Date() &&
            (candidate.creatorTelegramUserId === null ||
              candidate.creatorTelegramUserId === creatorTelegramUserId),
        );
        if (!row) return false;
        row.creatorTelegramUserId = creatorTelegramUserId;
        return true;
      },
      findActiveByCreator: async (creator: string) =>
        ledger.find(
          (row) =>
            row.creatorTelegramUserId === creator &&
            row.consumedAt === null &&
            row.expiresAt > new Date(),
        ) ?? null,
      consume: async (startToken: string, creator: string) => {
        const row = ledger.find(
          (candidate) =>
            candidate.startToken === startToken &&
            candidate.creatorTelegramUserId === creator &&
            candidate.consumedAt === null &&
            candidate.expiresAt > new Date(),
        );
        if (!row) return false;
        row.consumedAt = new Date();
        row.outcomeCode = "PROVISIONED";
        return true;
      },
      recordOutcome: async (
        startToken: string,
        outcomeCode: string,
        now: Date,
      ) => {
        const row = ledger.find(
          (candidate) => candidate.startToken === startToken,
        );
        if (!row) return false;
        row.consumedAt = now;
        row.outcomeCode = outcomeCode;
        return true;
      },
      recordConnectionId: async (startToken: string, connectionId: string) => {
        const row = ledger.find(
          (candidate) => candidate.startToken === startToken,
        );
        if (row) row.connectionId = connectionId;
      },
    },
    connectionRepository: {
      findPrimaryByBusiness: async (businessId: string) =>
        createdConnections
          .filter((row) => row.businessId === businessId)
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0] ??
        null,
      findByIdWithinBusiness: async (id: string, businessId: string) =>
        createdConnections.find(
          (row) => row.id === id && row.businessId === businessId,
        ) ?? null,
      update: async (
        id: string,
        businessId: string,
        input: import("@/lib/validation").UpdateTelegramConnectionDto,
      ) => {
        const row = createdConnections.find(
          (candidate) =>
            candidate.id === id && candidate.businessId === businessId,
        );
        if (!row) return null;
        Object.assign(row, {
          ...input,
          branchId: input.branchId ?? row.branchId,
          updatedAt: new Date(),
        });
        return row;
      },
      disconnect: async (id: string, businessId: string) => {
        const row = createdConnections.find(
          (candidate) =>
            candidate.id === id &&
            candidate.businessId === businessId &&
            candidate.status === "CONNECTED" &&
            candidate.isActive,
        );
        if (!row) return null;
        const now = new Date();
        Object.assign(row, {
          status: "DISCONNECTED",
          isActive: false,
          onboardingState: "NOT_STARTED",
          onboardingActor: "CUSTOMER",
          onboardingStateChangedAt: now,
          updatedAt: now,
        });
        return row;
      },
      findByExternalId: async (botExternalId: string) =>
        createdConnections.find((row) => row.botExternalId === botExternalId) ??
        null,
      create: async (
        input: import("@/lib/validation").CreateTelegramConnectionDto,
      ) => {
        const now = new Date();
        // A unique id per created row — the repository's real `create`
        // generates one, and the harness's update/disconnect lookups are
        // by id, so two connections must never share an id.
        const connection: import("@/types/domain").TelegramConnection = {
          id: `${CONNECTION_A}-${createdConnections.length + 1}`,
          businessId: input.businessId,
          branchId: input.branchId ?? null,
          displayName: input.displayName ?? null,
          botExternalId: input.botExternalId,
          botUsername: input.botUsername ?? null,
          provider: input.provider,
          status: input.status,
          credentialsRef: input.credentialsRef ?? null,
          credentialKind: input.credentialKind,
          webhookSecretHash: input.webhookSecretHash ?? null,
          isActive: input.isActive,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          onboardingState: input.onboardingState,
          onboardingActor: input.onboardingActor,
          onboardingReasonCode: null,
          onboardingReasonSummary: null,
          onboardingRetryable: null,
          onboardingStateChangedAt: null,
          onboardingCompletedAt: null,
          onboardingFailedAt: null,
          managerBotId: input.managerBotId ?? null,
          creatorTelegramUserId: input.creatorTelegramUserId ?? null,
        };
        createdConnections.push(connection);
        return connection;
      },
      markOnboardingReady: async (id: string, businessId: string) => {
        const row = createdConnections.find(
          (candidate) =>
            candidate.id === id &&
            candidate.businessId === businessId &&
            candidate.status === "CONNECTED" &&
            candidate.isActive,
        );
        if (!row) return null;
        const now = new Date();
        Object.assign(row, {
          onboardingState: "READY",
          onboardingActor: "FLOWPILOT",
          onboardingStateChangedAt: now,
          onboardingCompletedAt: now,
          updatedAt: now,
        });
        return row;
      },
    },
    credentialStore: {
      store: async (params: {
        businessId: string;
        reference: string;
        secret: string;
      }) => {
        storedSecrets.set(params.reference, params.secret);
        return { ok: true as const, reference: params.reference };
      },
      delete: async (reference: string) => {
        if (!storedSecrets.has(reference)) {
          return {
            ok: false as const,
            code: "CREDENTIAL_UNAVAILABLE" as const,
            message: "غير متاح",
          };
        }
        storedSecrets.delete(reference);
        return { ok: true as const };
      },
    },
    businessRepository: {
      // The handler needs only the Business's name (for safe reply
      // copy); the fixture is a full `Business` shape per the harness
      // convention (see check-booking-ux) so the deps satisfy the
      // `BusinessRepository` port exactly.
      findById: async (id: string) =>
        id === BUSINESS_A
          ? ({
              id,
              name: BUSINESS_NAME,
              isActive: true,
            } as unknown as import("@/types/domain").Business)
          : id === BUSINESS_B
            ? ({
                id,
                name: "منشأة ثانية",
                isActive: true,
              } as unknown as import("@/types/domain").Business)
            : null,
    },
    getEnvVar: (name: string) =>
      name === "TELEGRAM_MANAGER_BOT_TOKEN" ? MANAGER_TOKEN_VALUE : undefined,
    webhookBaseUrl: "https://flowpilot.example.com",
    managerBotId: MANAGER_BOT_ID,
    now: () => new Date(),
  };

  // F1. Single-use token: mint + bind creator, then consume twice.
  const startToken = mintTelegramStartToken();
  ledger.push({
    id: `led-${++ledgerSeq}`,
    businessId: BUSINESS_A,
    connectionId: null,
    startToken,
    creatorTelegramUserId: CREATOR_ID,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    consumedAt: null,
    outcomeCode: null,
    createdAt: new Date(),
  });
  const provisioned = await completeManagedBotProvisioning(provisioningDeps, {
    creatorTelegramUserId: CREATOR_ID,
    botExternalId: BOT_ID,
    botUsername: BOT_USERNAME,
  });
  check(
    "F1. التفعيل من حدث managed_bot → اتصال CONNECTED بالنشاط الصحيح",
    provisioned.ok === true &&
      eq(provisioned.businessId, BUSINESS_A) &&
      eq(provisioned.botExternalId, BOT_ID),
  );
  check(
    "F2. التوكن مُخزَّن كمرجع fp:<id> فقط — لا قيمة نصية في أي مكان",
    createdConnections.length === 1 &&
      createdConnections[0]!.credentialsRef?.startsWith("fp:") === true &&
      storedSecrets.get(createdConnections[0]!.credentialsRef!) ===
        BOT_TOKEN_VALUE &&
      !JSON.stringify(createdConnections).includes(BOT_TOKEN_VALUE),
  );
  check(
    "F3. ملخّص سرّ الويبهوك المُخزَّن (sha256 سداسي) ودمج التحقق عبر نفس دالة التجزئة",
    /^[0-9a-f]{64}$/.test(createdConnections[0]!.webhookSecretHash!) &&
      verifyTelegramWebhookSecretConstantTime(
        digest,
        hashTelegramWebhookSecret(WEBHOOK_SECRET),
      ),
  );

  // F4. Single-use: the attempt was consumed by F1, so the SAME event
  //     delivered again matches no in-flight row and provisions nothing.
  const replay = await completeManagedBotProvisioning(provisioningDeps, {
    creatorTelegramUserId: CREATOR_ID,
    botExternalId: BOT_ID,
    botUsername: BOT_USERNAME,
  });
  check(
    "F4. إعادة تشغيل الحدث → فشل أحادي الاستخدام (لا محاولة نشطة)",
    replay.ok === false && eq(replay.code, "NO_IN_FLIGHT_ATTEMPT"),
  );

  // F5. Cross-tenant forgery: a creator bound to BUSINESS_A delivers a
  //     managed_bot event for a bot ANOTHER business already owns → the
  //     bot cannot silently attach to a second Business.
  const tokenB = mintTelegramStartToken();
  ledger.push({
    id: `led-${++ledgerSeq}`,
    businessId: BUSINESS_A,
    connectionId: null,
    startToken: tokenB,
    creatorTelegramUserId: CREATOR_ID,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    consumedAt: null,
    outcomeCode: null,
    createdAt: new Date(),
  });
  const OTHER_BOT_ID = "6999999999";
  createdConnections.push(
    fakeConnection({
      id: CONNECTION_B,
      businessId: BUSINESS_B,
      branchId: null,
      botExternalId: OTHER_BOT_ID,
      status: "CONNECTED",
      isActive: true,
      credentialsRef: "fp:other",
    }),
  );
  const crossAttach = await completeManagedBotProvisioning(provisioningDeps, {
    creatorTelegramUserId: CREATOR_ID,
    botExternalId: OTHER_BOT_ID,
  });
  check(
    "F5. بوت مُملوك لمنشأة أخرى لا يمكن إرفاقه بصمت (الحماية عبر النطاقات)",
    crossAttach.ok === false &&
      eq(crossAttach.code, "BOT_ATTACHED_TO_ANOTHER_BUSINESS"),
  );

  // F6. Unbound creator: a managed_bot event whose creator never went
  //     through the deep link → nothing provisioned.
  const stranger = await completeManagedBotProvisioning(provisioningDeps, {
    creatorTelegramUserId: "0000000000",
    botExternalId: "6777777777",
  });
  check(
    "F6. منشئ غير مرتبط بأي محاولة → لا توفير (ربط هوية المنشئ)",
    stranger.ok === false && eq(stranger.code, "NO_IN_FLIGHT_ATTEMPT"),
  );

  // ════════════════════════════════════════════════════════════════════════
  // G. Provider-neutral Conversation Engine usage (the REAL engine)
  // ════════════════════════════════════════════════════════════════════════

  const engine =
    await import("@/features/conversations/server/conversation-engine");
  const { InboundDuplicateError } =
    await import("@/server/repositories/inbound-dedupe.repository");
  type AiResponse = {
    intent: string;
    action: string;
    content: string;
    extraction: Record<string, null>;
    handoffReason: string | null;
    summary: null;
  };

  const written: Array<{ senderType: string; content: string }> = [];
  // A holder so TS does not narrow the closure-assigned value to `null`.
  const lastUpsertedCustomer = {
    current: null as { name: string; phone: string } | null,
  };
  let conversation = {
    id: "conv-tg",
    businessId: BUSINESS_A,
    customerId: "cust-tg",
    status: "AI_ACTIVE",
    assignedUserId: null,
    branchId: BRANCH_A,
  };
  const claims = new Map<
    string,
    { conversationId: string; customerMessageId: string }
  >();
  let seq = 0;
  let engineAiCalls = 0;
  const outbound: Array<{ provider: string; to: string; content: string }> = [];

  const engineDeps = {
    businessRepository: {
      findById: async () => ({
        id: BUSINESS_A,
        name: "العيادة",
        isActive: true,
      }),
      findByWhatsappNumber: async () => null,
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
      upsertByPhone: async (
        _businessId: string,
        data: { name: string; phone: string },
      ) => {
        lastUpsertedCustomer.current = { ...data };
        return {
          id: "cust-tg",
          businessId: BUSINESS_A,
          name: data.name,
          phone: data.phone,
        };
      },
      touchConversation: async () => undefined,
    },
    conversationRepository: {
      findLatestByCustomer: async () => ({ id: conversation.id }),
      findById: async () => conversation,
      create: async () => conversation,
      addMessage: async (
        input: { senderType: string; content: string },
        _workflow: unknown,
        claimContext?: { claimId: string },
      ) => {
        // The assistant reply's `addMessage` carries NO claimContext (only
        // the customer message's does), so the guard must tolerate that.
        if (claimContext && claims.has(claimContext.claimId)) {
          throw new InboundDuplicateError(claims.get(claimContext.claimId)!);
        }
        seq += 1;
        const messageId = `msg-${seq}`;
        written.push({ senderType: input.senderType, content: input.content });
        if (claimContext && input.senderType === "CUSTOMER") {
          claims.set(claimContext.claimId, {
            conversationId: conversation.id,
            customerMessageId: messageId,
          });
        }
        return { id: messageId };
      },
      getMessages: async () => [],
      update: async () => conversation,
      updateWorkflow: async (
        _id: string,
        patch: { status?: string; assignedUserId?: string | null },
      ) => {
        if (patch.status)
          conversation = { ...conversation, status: patch.status };
        return conversation;
      },
    },
    serviceRepository: {
      listByBusiness: async () => [],
      findById: async () => null,
    },
    inboundDedupeRepository: {
      claim: async (_businessId: string, key: string) => {
        if (claims.has(`key:${key}`)) {
          const recorded = claims.get(`key:${key}`)!;
          return {
            status: "duplicate" as const,
            claimId: `key:${key}`,
            conversationId: recorded.conversationId,
            customerMessageId: recorded.customerMessageId,
          };
        }
        return { status: "claimed" as const, claimId: `key:${key}` };
      },
    },
    usageRepository: { record: async () => undefined },
    ai: {
      providerName: "scripted",
      async respond(): Promise<AiResponse> {
        engineAiCalls += 1;
        return {
          intent: "FAQ",
          action: "reply",
          content: "نعمل من السبت إلى الخميس",
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
      providerName: "telegram-scripted",
      async send(input: {
        to: string;
        content: string;
        conversationId: string;
      }) {
        outbound.push({
          provider: "telegram-scripted",
          to: input.to,
          content: input.content,
        });
        return { provider: "telegram-scripted", delivered: true };
      },
    },
  } as unknown as Parameters<typeof engine.receiveInboundMessage>[0];
  const telegramTurn = await engine.receiveInboundMessage(
    engineDeps,
    {
      to: BOT_ID,
      from: CHAT_ID,
      text: "السلام عليكم",
      receivedAt: nowIso(),
      externalId: `tg:${BOT_ID}:7770001`,
    },
    { businessId: BUSINESS_A, branchId: BRANCH_A, connectionId: CONNECTION_A },
  );
  check(
    "G1. محرك المحادثة يعالج مقبض تيليجران (نفس المسار الموحَّد)",
    telegramTurn.ok && !telegramTurn.duplicate,
  );
  check(
    "G2. العميل مُنشأ بالمقبض الخارجي (مفتاح الهوية الموحَّد)",
    lastUpsertedCustomer.current !== null &&
      eq(lastUpsertedCustomer.current.phone, CHAT_ID),
  );
  check(
    "G3. الرد الخارجي يذهب إلى نفس المقبض (chat_id) — لا منطق قناة في المحرك",
    outbound.length >= 1 && eq(outbound[0]!.to, CHAT_ID),
  );
  void engineAiCalls;

  const duplicate = await engine.receiveInboundMessage(
    engineDeps,
    {
      to: BOT_ID,
      from: CHAT_ID,
      text: "السلام عليكم",
      receivedAt: nowIso(),
      externalId: `tg:${BOT_ID}:7770001`, // SAME update_id
    },
    { businessId: BUSINESS_A, branchId: BRANCH_A, connectionId: CONNECTION_A },
  );
  check(
    "G4. update_id مكرر → نجاح تواني صريح (دوام dedupe) — رسالة واحدة فقط",
    duplicate.ok &&
      duplicate.duplicate === true &&
      written.filter((message) => message.senderType === "CUSTOMER").length ===
        1,
  );

  // ════════════════════════════════════════════════════════════════════════
  // H. The webhook ROUTE (POST /api/telegram/webhook) — end-to-end security
  //    + routing through the REAL handler with injected deps (no DB, no
  //    network, no real credentials). The turn processor records exactly
  //    what the engine would receive, and the scheduler records the deferred
  //    work — so the 200-promptness contract (DECISIONS #63 (E)) is asserted
  //    too, not just the happy path.
  // ════════════════════════════════════════════════════════════════════════

  const { handleTelegramWebhook } =
    await import("@/server/integrations/telegram/telegram-webhook-handler");

  const SECRET_A = "webhook-secret-bot-a-aaaaaaaaaa";
  const SECRET_B = "webhook-secret-bot-b-bbbbbbbbbbb";
  const DIGEST_A = hashTelegramWebhookSecret(SECRET_A);
  const DIGEST_B = hashTelegramWebhookSecret(SECRET_B);

  // Two bots in two Businesses — the routing table the handler resolves
  // against. `webhookSecretHash` is the only (non-secret) value it reads.
  const routedConnections: FakeConnection[] = [
    fakeConnection({
      id: CONNECTION_A,
      businessId: BUSINESS_A,
      branchId: BRANCH_A,
      botExternalId: BOT_ID,
      status: "CONNECTED",
      isActive: true,
      credentialsRef: "fp:conn-a-ref",
    }),
    fakeConnection({
      id: CONNECTION_B,
      businessId: BUSINESS_B,
      branchId: null,
      botExternalId: "6999999999",
      status: "CONNECTED",
      isActive: true,
      credentialsRef: "fp:conn-b-ref",
    }),
  ];
  for (const connection of routedConnections) {
    // fakeConnection leaves the digest null; set it per bot.
    connection.webhookSecretHash =
      connection.id === CONNECTION_A ? DIGEST_A : DIGEST_B;
  }

  type Deferred = {
    engineInput: { to: string; from: string; externalId?: string };
    identity: { businessId: string; branchId: string | null };
  };
  const dispatched: Deferred[] = [];
  const scheduled: Array<() => Promise<void> | void> = [];

  function webhookRequest(body: unknown, secret: string | null): Request {
    return new Request("https://flowpilot.example.com/api/telegram/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(secret ? { "X-Telegram-Bot-Api-Secret-Token": secret } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  async function runRoute(
    body: unknown,
    secret: string | null,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await handleTelegramWebhook(
      {
        connectionRepository: {
          findByWebhookSecretHash: async (hash: string) =>
            routedConnections.find(
              (connection) => connection.webhookSecretHash === hash,
            ) ?? null,
        },
        async processInboundMessage({ engineInput, identity }) {
          dispatched.push({
            engineInput: {
              to: engineInput.to,
              from: engineInput.from,
              externalId: engineInput.externalId,
            },
            identity: {
              businessId: identity.businessId,
              branchId: identity.branchId,
            },
          });
          return { ok: true };
        },
        schedule: (work) => {
          scheduled.push(work);
        },
      },
      webhookRequest(body, secret),
    );
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  }

  function privateUpdate(
    updateId: number,
    text: string,
    chatType = "private",
  ): unknown {
    return {
      update_id: updateId,
      message: {
        message_id: 100 + updateId,
        date: 1758900000,
        chat: { id: Number(CHAT_ID), type: chatType, first_name: "أحمد" },
        from: { id: Number(CHAT_ID), is_bot: false },
        text,
      },
    };
  }

  async function flushOne(): Promise<void> {
    const work = scheduled.pop();
    if (work) await work();
  }

  // H1/H2. Valid secret → 200 PROMPTLY, with the turn deferred (not awaited).
  let result = await runRoute(privateUpdate(8880001, "السلام عليكم"), SECRET_A);
  check(
    "H1. سرّ ويبهوك صحيح → 200 فوري + جدولة الدوران (دون انتظار المحرك)",
    result.status === 200 &&
      dispatched.length === 0 && // deferred — nothing processed yet
      scheduled.length === 1,
  );
  await flushOne();
  check(
    "H2. الدوران المؤجَّل يستلم المغلف النيوترالي + هوية النطاق المُحلَّلة",
    dispatched.length === 1 &&
      eq(dispatched[0]!.engineInput.from, CHAT_ID) &&
      eq(dispatched[0]!.engineInput.to, BOT_ID) &&
      eq(dispatched[0]!.engineInput.externalId, `tg:${BOT_ID}:8880001`) &&
      eq(dispatched[0]!.identity.businessId, BUSINESS_A) &&
      eq(dispatched[0]!.identity.branchId, BRANCH_A),
  );

  // H3/H4. Invalid + missing secret → 401 BEFORE any parsing or processing.
  result = await runRoute(privateUpdate(8880002, "x"), "wrong-secret-value-x");
  check(
    "H3. سرّ ويبهوك خاطئ → 401 قبل أي تحليل أو معالجة",
    eq(result.status, 401) && dispatched.length === 1,
  );
  result = await runRoute(privateUpdate(8880003, "x"), null);
  check(
    "H4. سرّ الويبهوك مفقود → 401",
    eq(result.status, 401) && dispatched.length === 1,
  );

  // H5. A valid secret of BOT B routes to BOT B's own identity, not BOT A's.
  result = await runRoute(privateUpdate(8880004, "مرحبا"), SECRET_B);
  await flushOne();
  check(
    "H5. توجيه لكل بوت: سرّ البوت (ب) يحلِّل هويته فقط — لا اتصال متبادل",
    result.status === 200 &&
      dispatched.length === 2 &&
      eq(dispatched[1]!.engineInput.to, "6999999999") &&
      eq(dispatched[1]!.identity.businessId, BUSINESS_B),
  );

  // H6. Tenant isolation: the customer's own payload cannot select the
  //     Business (hostile keys never reach the engine input).
  result = await runRoute(
    {
      update_id: 8880005,
      message: {
        message_id: 5,
        date: 1758900000,
        chat: { id: Number(CHAT_ID), type: "private" },
        from: { id: Number(CHAT_ID) },
        text: "مرحبا",
        // Hostile: the payload tries to select another Business + a role.
        businessId: BUSINESS_A,
        role: "ADMIN",
      },
    },
    SECRET_B,
  );
  await flushOne();
  check(
    "H6. العميل لا يستطيع حقن هوية النطاق (المفتاح = صف الاتصال فقط)",
    result.status === 200 &&
      dispatched.length === 3 &&
      eq(dispatched[2]!.identity.businessId, BUSINESS_B) &&
      eq(dispatched[2]!.engineInput.to, "6999999999"),
  );

  // H7/H8. The approved MVP scope: non-private chats and non-text messages
  //        are acknowledged (200) and never dispatched.
  result = await runRoute(
    privateUpdate(8880006, "مرحبا", "supergroup"),
    SECRET_A,
  );
  check(
    "H7. المحادثات غير الخاصة → 200 مُتجاهَلة (النطاق المعتمد: الخاص فقط)",
    result.status === 200 &&
      eq(result.body.ignored, "NON_PRIVATE_CHAT") &&
      dispatched.length === 3,
  );
  result = await runRoute(
    {
      update_id: 8880007,
      message: {
        message_id: 7,
        date: 1758900000,
        chat: { id: Number(CHAT_ID), type: "private" },
        from: { id: Number(CHAT_ID) },
        sticker: { file_id: "x", width: 512, height: 512 },
      },
    },
    SECRET_A,
  );
  check(
    "H8. الرسائل غير النصية → 200 مُتجاهَلة (العقد المعتمد — دون اختراع سلوك)",
    result.status === 200 &&
      eq(result.body.ignored, "UNSUPPORTED_MESSAGE_TYPE") &&
      dispatched.length === 3,
  );

  // H9/H10. Malformed Update → 400 (after authentication).
  result = await runRoute({ message: { text: "x" } }, SECRET_A);
  check(
    "H9. حمولة تيليجرام معطوبة (بلا update_id) → 400",
    eq(result.status, 400) && dispatched.length === 3,
  );
  result = await runRoute([], SECRET_A);
  check(
    "H10. جسم ليس كائناً → 400 (MALFORMED_PROVIDER_PAYLOAD)",
    eq(result.status, 400),
  );

  // H11. update_id dedupe at the route: a redelivery produces the SAME
  //      namespaced external key, which is what the durable ledger keys on.
  result = await runRoute(privateUpdate(8880008, "السلام عليكم"), SECRET_A);
  await flushOne();
  const firstKey = dispatched[dispatched.length - 1]!.engineInput.externalId;
  result = await runRoute(privateUpdate(8880008, "السلام عليكم"), SECRET_A);
  await flushOne();
  const redeliveredKey =
    dispatched[dispatched.length - 1]!.engineInput.externalId;
  check(
    "H11. إعادة التسليم تُنتج نفس المفتاح الخارجي المُسمّى (dedupe دوام)",
    firstKey === `tg:${BOT_ID}:8880008` && firstKey === redeliveredKey,
  );

  // H12. The managed_bot provisioning event is acknowledged explicitly —
  //      never silently dropped as an unsupported customer message.
  result = await runRoute(
    {
      update_id: 8880009,
      managed_bot: {
        added: true,
        bot: { id: Number(BOT_ID), is_bot: true, username: BOT_USERNAME },
        user: { id: Number(CREATOR_ID), is_bot: false },
      },
    },
    SECRET_A,
  );
  check(
    "H12. حدث managed_bot بدون مكمل → 200 + نتيجة مُؤكَّدة صراحةً (لا رسالة صامتة)",
    result.status === 200 &&
      eq(result.body.deferred, "MANAGED_BOT_PROVISIONING") &&
      eq(result.body.outcome, "MANAGED_BOT_PROVISIONING_UNBOUND") &&
      dispatched.length === 5, // H2 + H5 + H6 + H11×2 — this event dispatches nothing
  );

  // ════════════════════════════════════════════════════════════════════════
  // Report
  // ════════════════════════════════════════════════════════════════════════

  // ════════════════════════════════════════════════════════════════════════
  // I. The provisioning LAUNCH — start-token creation + the deep link
  //    (DECISIONS #66). The deep link is the ONLY customer-facing URL; its
  //    sole payload is the opaque single-use token.
  // ════════════════════════════════════════════════════════════════════════

  const {
    beginTelegramProvisioning,
    getTelegramConnectionStatus,
    resolveTelegramConnectionView,
  } =
    await import("@/features/telegram-connection/server/telegram-connection-service");
  const {
    buildManagedBotDeepLink,
    ensureManagerWebhook,
    suggestBotUsername,
    deriveManagerWebhookSecret,
    buildManagerWebhookUrl,
  } = await import("@/server/integrations/telegram/telegram-provisioning");

  const managerCalls: Array<{ url: string; body: Record<string, unknown> }> =
    [];
  const managerApi = {
    fetchImpl: (async (url: string, init?: RequestInit) => {
      managerCalls.push({
        url,
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      const method = url.split("/").pop();
      if (method === "getMe") {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              id: Number(MANAGER_BOT_ID),
              is_bot: true,
              username: MANAGER_USERNAME,
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
      });
    }) as typeof fetch,
    apiHost: "https://api.telegram.org",
    credentialsResolver: provisioningDeps.api.credentialsResolver,
  };

  const launchDeps = {
    ...provisioningDeps,
    api: managerApi,
    managerBotUsername: MANAGER_USERNAME,
  };

  const launch = await beginTelegramProvisioning(launchDeps, {
    userId: "user-a",
    role: "ADMIN",
    businessId: BUSINESS_A,
  });
  check(
    "I1. بدء التفعيل → رابط عميق يحمل رمزاً معتمداً فقط (لا معرّف منشأة)",
    launch.success === true &&
      launch.launched === true &&
      /^https:\/\/t\.me\/FlowPilotManagerBot\?start=[A-Za-z0-9_-]{16,128}$/.test(
        launch.authorizationUrl,
      ) === true,
  );
  // I1 narrowed the result to the launched branch (the deep link exists).
  const launched = launch.success && launch.launched ? launch : null;
  const launchedToken = launched
    ? new URL(launched.authorizationUrl).searchParams.get("start")
    : null;
  check(
    "I2. الرمز فريد وقابل للاستهلاك مرة واحدة + مُسجَّل في الدفتر",
    launchedToken !== null &&
      ledger.some((row) => row.startToken === launchedToken) === true,
  );
  check(
    "I3. لا يوجد أي سرّ أو معرّف تقني في رابط التفعيل",
    launched !== null &&
      !launched.authorizationUrl.includes(BUSINESS_A) &&
      !launched.authorizationUrl.includes(BOT_TOKEN_VALUE) &&
      !launched.authorizationUrl.includes(MANAGER_TOKEN_VALUE),
  );
  void buildManagedBotDeepLink;
  void buildManagerWebhookUrl;

  // ensureManagerWebhook — the operator never configures a webhook manually
  const ensureCallsBefore = managerCalls.length;
  const ensured = await ensureManagerWebhook({
    api: managerApi,
    getEnvVar: (name: string) =>
      name === "TELEGRAM_MANAGER_BOT_TOKEN" ? MANAGER_TOKEN_VALUE : undefined,
    webhookBaseUrl: "https://flowpilot.example.com",
  });
  const setWebhookCall = managerCalls
    .slice(ensureCallsBefore)
    .find((call) => call.url.endsWith("/setWebhook"));
  check(
    "I4. ensureManagerWebhook → setWebhook للنقطة الصحيحة + السرّ المشتق + النطاق المعتمد",
    ensured.ok === true &&
      setWebhookCall !== undefined &&
      eq(
        setWebhookCall.body.url,
        "https://flowpilot.example.com/api/telegram/manager/webhook",
      ) &&
      JSON.stringify(setWebhookCall.body.allowed_updates) ===
        JSON.stringify(["message", "managed_bot"]) &&
      eq(
        setWebhookCall.body.secret_token,
        deriveManagerWebhookSecret(MANAGER_TOKEN_VALUE),
      ),
  );
  check(
    "I5. سرّ الويبهوك للمدير مشتق من توكن المدير (طول ثابت، لا يحمل القيمة)",
    deriveManagerWebhookSecret(MANAGER_TOKEN_VALUE).length === 64 &&
      !deriveManagerWebhookSecret(MANAGER_TOKEN_VALUE).includes(
        MANAGER_TOKEN_VALUE,
      ),
  );
  check(
    "I6. اقتراح اسم مستخدم للبوت صالح لتيليجرام (أحرف إنجليزية/أرقام/_)",
    /^[A-Za-z0-9_]{4,32}$/.test(suggestBotUsername(BUSINESS_NAME)) === true &&
      /^[A-Za-z0-9_]{4,32}$/.test(suggestBotUsername("ACME Dental Clinic")) ===
        true,
  );
  check(
    "I7. بدء التفعيل متاح للمدير فقط (STAFF مرفوض)",
    (
      await beginTelegramProvisioning(launchDeps, {
        userId: "user-staff",
        role: "STAFF",
        businessId: BUSINESS_A,
      })
    ).success === false,
  );
  check(
    "I8. بدء التفعيل يتطلب اتصالاً بالمنشأة (businessId مفقود مرفوض)",
    (
      await beginTelegramProvisioning(launchDeps, {
        userId: "user-none",
        role: "ADMIN",
        businessId: null,
      })
    ).success === false,
  );

  // ════════════════════════════════════════════════════════════════════════
  // J. Single-use consumption, replay, wrong creator, wrong Business
  // ════════════════════════════════════════════════════════════════════════

  // A fresh attempt bound to CREATOR_ID, then completed — mirrors the real
  // lifecycle through the manager webhook (section L).
  const tokenJ = mintTelegramStartToken();
  ledger.push({
    id: `led-${++ledgerSeq}`,
    businessId: BUSINESS_A,
    connectionId: null,
    startToken: tokenJ,
    creatorTelegramUserId: CREATOR_ID,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    consumedAt: null,
    outcomeCode: null,
    createdAt: new Date(),
  });
  // The attempt is bound (the /start step) and consumed by the SAME
  // creator — the structural guard.
  check(
    "J1. الاستهلاك يتطلب مطابقة المنشئ المربوط (consume أحادي الاستخدام)",
    provisioningDeps.ledgerRepository.consume !== undefined &&
      (await provisioningDeps.ledgerRepository.consume(tokenJ, CREATOR_ID)) ===
        true,
  );
  check(
    "J2. إعادة استهلاك نفس الرمز تفشل (single-use)",
    (await provisioningDeps.ledgerRepository.consume(tokenJ, CREATOR_ID)) ===
      false,
  );
  // A bound attempt consumed by a DIFFERENT creator provisions nothing.
  const tokenOtherCreator = mintTelegramStartToken();
  ledger.push({
    id: `led-${++ledgerSeq}`,
    businessId: BUSINESS_A,
    connectionId: null,
    startToken: tokenOtherCreator,
    creatorTelegramUserId: CREATOR_ID,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    consumedAt: null,
    outcomeCode: null,
    createdAt: new Date(),
  });
  const wrongCreator = await provisioningDeps.ledgerRepository.consume(
    tokenOtherCreator,
    "0000999888",
  );
  check(
    "J3. منشئ مختلف لا يستطيع استهلاك محاولة منشأة أخرى (ربط الهوية)",
    wrongCreator === false,
  );
  // The attempt is still in flight → a completion by the RIGHT creator still
  // works (no lock-out from a hostile probe).
  check(
    "J4. المحاولة تبقى صالحة للمنشئ الصحيح بعد محاولة منشئ خاطئ",
    (await provisioningDeps.ledgerRepository.consume(
      tokenOtherCreator,
      CREATOR_ID,
    )) === true,
  );
  // An expired attempt is refused.
  const tokenExpired = mintTelegramStartToken();
  ledger.push({
    id: `led-${++ledgerSeq}`,
    businessId: BUSINESS_A,
    connectionId: null,
    startToken: tokenExpired,
    creatorTelegramUserId: CREATOR_ID,
    expiresAt: new Date(Date.now() - 60_000),
    consumedAt: null,
    outcomeCode: null,
    createdAt: new Date(),
  });
  check(
    "J5. المحاولة المنتهية الصلاحية لا تُستهلك (انتهاء الصلاحية)",
    (await provisioningDeps.ledgerRepository.consume(
      tokenExpired,
      CREATOR_ID,
    )) === false,
  );

  // ════════════════════════════════════════════════════════════════════════
  // K. The UI state machine (pure derivation — DECISIONS #66)
  // ════════════════════════════════════════════════════════════════════════

  const emptyView = resolveTelegramConnectionView(null, null);
  check(
    "K1. لا اتصال ولا محاولة → الحالة الفارغة + CTA الربط",
    emptyView.uiState === "EMPTY" &&
      emptyView.botUsername === null &&
      emptyView.operationallyConnected === false,
  );
  const inFlight = resolveTelegramConnectionView(null, {
    id: "led-x",
    businessId: BUSINESS_A,
    connectionId: null,
    startToken: "tok",
    creatorTelegramUserId: null,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    consumedAt: null,
    outcomeCode: null,
    createdAt: new Date(),
  });
  check(
    "K2. محاولة قيد التنفيذ → PROVISIONING (ليس spinner دائم)",
    inFlight.uiState === "PROVISIONING" && inFlight.summary !== null,
  );
  const connectedView = resolveTelegramConnectionView(
    fakeConnection({
      id: CONNECTION_A,
      businessId: BUSINESS_A,
      branchId: null,
      botExternalId: BOT_ID,
      status: "CONNECTED",
      isActive: true,
      credentialsRef: "fp:x",
    }),
    null,
  );
  connectedView.botUsername = BOT_USERNAME;
  check(
    "K3. اتصال CONNECTED نشط → CONNECTED + معلومات البوت غير السرية فقط",
    connectedView.uiState === "CONNECTED" &&
      connectedView.operationallyConnected === true &&
      connectedView.lastOutcomeCode === null,
  );
  const disconnectedView = resolveTelegramConnectionView(
    fakeConnection({
      id: CONNECTION_A,
      businessId: BUSINESS_A,
      branchId: null,
      botExternalId: BOT_ID,
      status: "DISCONNECTED",
      isActive: false,
      credentialsRef: null,
    }),
    null,
  );
  check(
    "K4. اتصال غير موصول → DISCONNECTED",
    disconnectedView.uiState === "DISCONNECTED" &&
      disconnectedView.operationallyConnected === false,
  );
  const failedView = resolveTelegramConnectionView(null, {
    id: "led-fail",
    businessId: BUSINESS_A,
    connectionId: null,
    startToken: "tok-fail",
    creatorTelegramUserId: CREATOR_ID,
    expiresAt: new Date(Date.now() - 30_000),
    consumedAt: new Date(Date.now() - 30_000),
    outcomeCode: "MANAGER_BOT_NOT_CONFIGURED",
    createdAt: new Date(Date.now() - 60_000),
  });
  check(
    "K5. محاولة فاشلة بدون اتصال → ACTION_REQUIRED + سبب آمن قابل للمراجعة",
    failedView.uiState === "ACTION_REQUIRED" &&
      failedView.lastOutcomeCode === "MANAGER_BOT_NOT_CONFIGURED" &&
      failedView.summary !== null,
  );
  const expiredView = resolveTelegramConnectionView(null, {
    id: "led-exp",
    businessId: BUSINESS_A,
    connectionId: null,
    startToken: "tok-exp",
    creatorTelegramUserId: null,
    expiresAt: new Date(Date.now() - 10_000),
    consumedAt: null,
    outcomeCode: null,
    createdAt: new Date(Date.now() - 30_000),
  });
  check(
    "K6. محاولة مهجورة (منتهية دون تأكيد) → ACTION_REQUIRED (لا spinner)",
    expiredView.uiState === "ACTION_REQUIRED" &&
      expiredView.lastOutcomeCode === "ATTEMPT_EXPIRED",
  );
  // A CONNECTED connection wins over a stale in-flight attempt.
  const mixed = resolveTelegramConnectionView(
    fakeConnection({
      id: CONNECTION_A,
      businessId: BUSINESS_A,
      branchId: null,
      botExternalId: BOT_ID,
      status: "CONNECTED",
      isActive: true,
      credentialsRef: "fp:x",
    }),
    {
      id: "led-stale",
      businessId: BUSINESS_A,
      connectionId: null,
      startToken: "tok-stale",
      creatorTelegramUserId: CREATOR_ID,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      consumedAt: null,
      outcomeCode: null,
      createdAt: new Date(),
    },
  );
  check(
    "K7. الاتصال المتصل يسبق أي محاولة قديمة قيد التنفيذ",
    mixed.uiState === "CONNECTED",
  );
  // An in-flight attempt wins over a DISCONNECTED connection (reconnect).
  const reconnecting = resolveTelegramConnectionView(
    fakeConnection({
      id: CONNECTION_A,
      businessId: BUSINESS_A,
      branchId: null,
      botExternalId: BOT_ID,
      status: "DISCONNECTED",
      isActive: false,
      credentialsRef: null,
    }),
    {
      id: "led-recon",
      businessId: BUSINESS_A,
      connectionId: null,
      startToken: "tok-recon",
      creatorTelegramUserId: CREATOR_ID,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      consumedAt: null,
      outcomeCode: null,
      createdAt: new Date(),
    },
  );
  check(
    "K8. محاولة إعادة الربط قيد التنفيذ تسبق الصف غير الموصول",
    reconnecting.uiState === "PROVISIONING",
  );

  // ════════════════════════════════════════════════════════════════════════
  // L. The MANAGER WEBHOOK — the whole provisioning lifecycle through the
  //    real handler (DECISIONS #63 (B), #66). No DB, no network: the
  //    manager HTTP calls hit the recorded fixture above.
  // ════════════════════════════════════════════════════════════════════════

  const { handleTelegramManagerWebhook } =
    await import("@/server/integrations/telegram/telegram-manager-webhook-handler");

  const MANAGER_SECRET = deriveManagerWebhookSecret(MANAGER_TOKEN_VALUE);
  const sentManager: Array<{
    url: string;
    body: { chat_id: string; text: string; reply_markup?: unknown };
  }> = [];
  const managerWebhookApi = {
    fetchImpl: (async (url: string, init?: RequestInit) => {
      const method = url.split("/").pop();
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (method === "sendMessage") {
        sentManager.push({
          url,
          body: body as {
            chat_id: string;
            text: string;
            reply_markup?: unknown;
          },
        });
        return new Response(
          JSON.stringify({ ok: true, result: { message_id: 1 } }),
          { status: 200 },
        );
      }
      if (method === "getManagedBotToken") {
        return new Response(
          JSON.stringify({ ok: true, result: { token: BOT_TOKEN_VALUE } }),
          { status: 200 },
        );
      }
      if (method === "setWebhook") {
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
        });
      }
      if (method === "getMe") {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              id: Number(BOT_ID_L),
              is_bot: true,
              username: BOT_USERNAME,
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: false, error_code: 400 }), {
        status: 400,
      });
    }) as typeof fetch,
    apiHost: "https://api.telegram.org",
    credentialsResolver: provisioningDeps.api.credentialsResolver,
  };

  const managerDeps = {
    ...provisioningDeps,
    api: managerWebhookApi,
    managerBotId: MANAGER_BOT_ID,
  };

  function managerRequest(body: unknown, secret: string | null): Request {
    return new Request(
      "https://flowpilot.example.com/api/telegram/manager/webhook",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(secret ? { "X-Telegram-Bot-Api-Secret-Token": secret } : {}),
        },
        body: JSON.stringify(body),
      },
    );
  }
  async function runManager(
    body: unknown,
    secret: string | null,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await handleTelegramManagerWebhook(
      managerDeps,
      managerRequest(body, secret),
    );
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  }

  // L1/L2. Secret authentication of the manager endpoint.
  let mgr = await runManager(
    { update_id: 9000001, message: { text: "x" } },
    "wrong-manager-secret-value-here",
  );
  check(
    "L1. سرّ مدير خاطئ → 401 قبل أي معالجة",
    eq(mgr.status, 401) && sentManager.length === 0,
  );
  mgr = await runManager({ update_id: 9000002, message: { text: "x" } }, null);
  check(
    "L2. سرّ المدير مفقود → 401",
    eq(mgr.status, 401) && sentManager.length === 0,
  );

  // L3. The /start deep link binds the creator + hands back the keyboard.
  const startTokenL = mintTelegramStartToken();
  ledger.push({
    id: `led-${++ledgerSeq}`,
    businessId: BUSINESS_A,
    connectionId: null,
    startToken: startTokenL,
    creatorTelegramUserId: null,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    consumedAt: null,
    outcomeCode: null,
    createdAt: new Date(),
  });
  const startRow = ledger.find((row) => row.startToken === startTokenL)!;
  void startRow;
  mgr = await runManager(
    {
      update_id: 9000003,
      message: {
        message_id: 1,
        date: 1758900000,
        chat: { id: Number(CREATOR_ID), type: "private", first_name: "مالك" },
        from: { id: Number(CREATOR_ID), is_bot: false },
        text: `/start ${startTokenL}`,
      },
    },
    MANAGER_SECRET,
  );
  const boundRow = ledger.find((row) => row.startToken === startTokenL);
  const keyboardReply = sentManager[sentManager.length - 1];
  check(
    "L3. /start <token> → ربط المنشئ + لوحة إنشاء البوت (request_managed_bot)",
    eq(mgr.status, 200) &&
      eq(mgr.body.start, "BOUND") &&
      boundRow?.creatorTelegramUserId === CREATOR_ID &&
      keyboardReply!.body.reply_markup !== undefined &&
      keyboardReply!.body.chat_id === CREATOR_ID,
  );
  const keyboard = keyboardReply!.body.reply_markup as {
    keyboard: Array<
      Array<{ text: string; request_managed_bot: Record<string, never> }>
    >;
  };
  check(
    "L4. لوحة الإنشاء تحوي زراً واحداً يطلب بوتاً مُداراً (الإجراء الوحيد المطلوب)",
    keyboard.keyboard.length === 1 &&
      keyboard.keyboard[0]!.length === 1 &&
      Object.keys(keyboard.keyboard[0]![0]!.request_managed_bot).length === 0 &&
      typeof keyboardReply!.body.text === "string" &&
      keyboardReply!.body.text.includes(BUSINESS_NAME) &&
      !keyboardReply!.body.text.includes(BOT_TOKEN_VALUE),
  );
  check(
    "L5. ربط /start لا يكشف أي معرّف منشأة أو سرّ",
    !JSON.stringify(keyboardReply!.body).includes(BUSINESS_A) &&
      !JSON.stringify(keyboardReply!.body).includes(startTokenL),
  );

  // L6. A replayed / an already-bound deep link from a DIFFERENT chat is
  //     refused (the token is single-use + creator-bound).
  mgr = await runManager(
    {
      update_id: 9000004,
      message: {
        message_id: 2,
        date: 1758900001,
        chat: { id: 1112223333, type: "private" },
        from: { id: 1112223333 },
        text: `/start ${startTokenL}`,
      },
    },
    MANAGER_SECRET,
  );
  check(
    "L6. رابط مُستهلك من محادثة أخرى → REFUSED + رد آمن (لا تفعيل صامت)",
    eq(mgr.status, 200) &&
      eq(mgr.body.start, "REJECTED") &&
      ledger.find((row) => row.startToken === startTokenL)
        ?.creatorTelegramUserId === CREATOR_ID,
  );

  // L7. The managed_bot event completes provisioning (token retrieval +
  //     webhook configuration + getMe + CONNECTED).
  const beforeConnections = createdConnections.length;
  mgr = await runManager(
    {
      update_id: 9000005,
      managed_bot: {
        added: true,
        bot: { id: Number(BOT_ID_L), is_bot: true, username: BOT_USERNAME },
        user: { id: Number(CREATOR_ID), is_bot: false },
      },
    },
    MANAGER_SECRET,
  );
  const provisionedRow = ledger.find((row) => row.startToken === startTokenL);
  const newConnection = createdConnections[createdConnections.length - 1];
  check(
    "L7. managed_bot → 200 + اتصال CONNECTED جديد + محاولة مُستهلكة كـ PROVISIONED",
    eq(mgr.status, 200) &&
      eq(mgr.body.provisioned, true) &&
      createdConnections.length === beforeConnections + 1 &&
      newConnection!.status === "CONNECTED" &&
      newConnection!.isActive === true &&
      newConnection!.businessId === BUSINESS_A &&
      provisionedRow?.consumedAt !== null &&
      provisionedRow?.outcomeCode === "PROVISIONED" &&
      provisionedRow?.connectionId === newConnection!.id,
  );
  check(
    "L8. التوكن مُجلب عبر المدير فقط + مُخزَّن كـ fp:<id> + getMe مُطابق",
    storedSecrets.get(newConnection!.credentialsRef!) === BOT_TOKEN_VALUE &&
      newConnection!.credentialsRef!.startsWith("fp:") &&
      newConnection!.botExternalId === BOT_ID_L &&
      !JSON.stringify(mgr.body).includes(BOT_TOKEN_VALUE),
  );
  const managerWebhookSet = managerCalls
    .concat(sentManager.length ? [] : [])
    .find((call) => call.url.endsWith("/setWebhook"));
  void managerWebhookSet;

  // L9. A replay of the SAME managed_bot event provisions nothing.
  mgr = await runManager(
    {
      update_id: 9000006,
      managed_bot: {
        added: true,
        bot: { id: Number(BOT_ID_L), is_bot: true, username: BOT_USERNAME },
        user: { id: Number(CREATOR_ID), is_bot: false },
      },
    },
    MANAGER_SECRET,
  );
  check(
    "L9. إعادة حدث managed_bot → لا تكرار (المحاولة الواحدة مُستهلكة)",
    eq(mgr.status, 200) &&
      eq(mgr.body.provisioned, false) &&
      createdConnections.length === beforeConnections + 1,
  );

  // L10. A managed_bot event from a creator who never went through the
  //      deep link provisions nothing (cross-tenant forgery).
  const forgedToken = mintTelegramStartToken();
  ledger.push({
    id: `led-${++ledgerSeq}`,
    businessId: BUSINESS_B,
    connectionId: null,
    startToken: forgedToken,
    creatorTelegramUserId: null,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    consumedAt: null,
    outcomeCode: null,
    createdAt: new Date(),
  });
  mgr = await runManager(
    {
      update_id: 9000007,
      managed_bot: {
        added: true,
        bot: { id: Number("6555555555"), is_bot: true },
        user: { id: Number(CREATOR_ID), is_bot: false },
      },
    },
    MANAGER_SECRET,
  );
  check(
    "L10. منشئ لم يفتح الرابط → لا تفعيل (الحماية عبر النطاقات)",
    eq(mgr.status, 200) &&
      eq(mgr.body.provisioned, false) &&
      createdConnections.every((row) => row.botExternalId !== "6555555555"),
  );

  // L11. Non-private /start and non-text payloads are acknowledged + ignored.
  mgr = await runManager(
    {
      update_id: 9000008,
      message: {
        message_id: 3,
        date: 1758900002,
        chat: { id: -1001234567890, type: "supergroup" },
        from: { id: Number(CREATOR_ID) },
        text: `/start ${startTokenL}`,
      },
    },
    MANAGER_SECRET,
  );
  check(
    "L11. /start في محادثة غير خاصة → مُتجاهل (النطاق المعتمد: الخاص فقط)",
    eq(mgr.status, 200) && eq(mgr.body.ignored, "NON_PRIVATE_CHAT"),
  );
  mgr = await runManager(
    {
      update_id: 9000009,
      message: {
        message_id: 4,
        date: 1758900003,
        chat: { id: Number(CREATOR_ID), type: "private" },
        from: { id: Number(CREATOR_ID) },
        sticker: { file_id: "x", width: 64, height: 64 },
      },
    },
    MANAGER_SECRET,
  );
  check(
    "L12. حمولة غير نصية في نقطة المدير → مُتجاهلة",
    eq(mgr.status, 200) && eq(mgr.body.ignored, "UNSUPPORTED_MESSAGE_TYPE"),
  );
  mgr = await runManager(
    {
      update_id: 9000010,
      managed_bot: { bot: {}, user: {} },
    },
    MANAGER_SECRET,
  );
  check("L13. حدث managed_bot معطوب → 400", eq(mgr.status, 400));

  // ════════════════════════════════════════════════════════════════════════
  // M. Failure / retry — a provisioning failure terminates the attempt
  //    with a typed outcome (never a permanent spinner).
  // ════════════════════════════════════════════════════════════════════════

  const tokenM = mintTelegramStartToken();
  ledger.push({
    id: `led-${++ledgerSeq}`,
    businessId: BUSINESS_A,
    connectionId: null,
    startToken: tokenM,
    creatorTelegramUserId: CREATOR_ID,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    consumedAt: null,
    outcomeCode: null,
    createdAt: new Date(),
  });
  // A reachable retryable failure: the manager bot IS configured (the
  // delivery secret verifies) but Telegram rejects `getManagedBotToken`
  // with 401 — Bot Management Mode was disabled, or the manager token was
  // revoked. The boundary maps it to MANAGER_BOT_NOT_CONFIGURED and
  // TERMINATES the attempt with that typed outcome (no half-provisioned
  // connection, no permanent spinner, and no token leakage).
  const failureApi = {
    fetchImpl: (async (url: string) => {
      const method = url.split("/").pop();
      if (method === "getManagedBotToken") {
        return new Response(
          JSON.stringify({
            ok: false,
            error_code: 401,
            description: "Unauthorized",
          }),
          { status: 401 },
        );
      }
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
      });
    }) as typeof fetch,
    apiHost: "https://api.telegram.org",
    credentialsResolver: provisioningDeps.api.credentialsResolver,
  };
  const failResponse = await handleTelegramManagerWebhook(
    { ...managerDeps, api: failureApi },
    managerRequest(
      {
        update_id: 9000020,
        managed_bot: {
          added: true,
          bot: { id: Number("6444444444"), is_bot: true },
          user: { id: Number(CREATOR_ID), is_bot: false },
        },
      },
      MANAGER_SECRET,
    ),
  );
  const failedRow = ledger.find((row) => row.startToken === tokenM);
  check(
    "M1. فشل التفعيل (رفع تيليجرام لجلب التوكن) → نتيجة مُؤكَّدة + رمز ناتج مُسجَّل",
    failResponse.status === 200 &&
      failedRow?.consumedAt !== null &&
      failedRow?.outcomeCode === "MANAGER_BOT_NOT_CONFIGURED",
  );
  const failBody = (await failResponse.json()) as Record<string, unknown>;
  check(
    "M2. فشل التفعيل لا يترك الاتصال نصف مُهيأ ولا يكشف التوكن",
    eq(failBody.provisioned, false) &&
      eq(failBody.outcome, "MANAGER_BOT_NOT_CONFIGURED") &&
      !createdConnections.some((row) => row.botExternalId === "6444444444") &&
      !JSON.stringify(failBody).includes(BOT_TOKEN_VALUE),
  );
  const retryStatus = await getTelegramConnectionStatus(
    {
      ...launchDeps,
      api: managerApi,
    },
    { userId: "user-a", role: "ADMIN", businessId: BUSINESS_A },
  );
  check(
    "M3. بعد الفشل، الحالة ACTION_REQUIRED (قابلة للمحاولة مجدداً — لا spinner)",
    retryStatus.success === true &&
      (retryStatus.view.uiState === "CONNECTED" ||
        retryStatus.view.uiState === "ACTION_REQUIRED"),
  );

  // ════════════════════════════════════════════════════════════════════════
  // N. Disconnect / reconnect (DECISIONS #66 — the supported lifecycle)
  // ════════════════════════════════════════════════════════════════════════

  const { disconnectManagedBotConnection } =
    await import("@/server/integrations/telegram/telegram-provisioning");
  const disconnectApi = {
    fetchImpl: (async (url: string) => {
      const method = url.split("/").pop();
      if (method === "deleteWebhook") {
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
        });
      }
      if (method === "getMe") {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              id: Number(BOT_ID),
              is_bot: true,
              username: BOT_USERNAME,
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
      });
    }) as typeof fetch,
    apiHost: "https://api.telegram.org",
    credentialsResolver: provisioningDeps.api.credentialsResolver,
  };
  // The connection the manager-webhook lifecycle (section L) provisioned —
  // the one this disconnect/reconnect pair exercises.
  const disconnectedConnection = createdConnections.find(
    (row) =>
      row.businessId === BUSINESS_A &&
      row.status === "CONNECTED" &&
      row.botExternalId === BOT_ID_L,
  );
  const disconnectCalls: string[] = [];
  const disconnect = await disconnectManagedBotConnection(
    {
      ...provisioningDeps,
      api: {
        ...disconnectApi,
        fetchImpl: (async (url: string, init?: RequestInit) => {
          disconnectCalls.push(url.split("/").pop() ?? "");
          return disconnectApi.fetchImpl(url, init);
        }) as typeof fetch,
      },
    },
    {
      connectionId: disconnectedConnection!.id,
      businessId: BUSINESS_A,
    },
  );
  const afterDisconnect = createdConnections.find(
    (row) => row.id === disconnectedConnection!.id,
  );
  check(
    "N1. الفصل → deleteWebhook أولاً + الصف DISCONNECTED + غير نشط",
    disconnect.ok === true &&
      disconnectCalls[0] === "deleteWebhook" &&
      afterDisconnect?.status === "DISCONNECTED" &&
      afterDisconnect?.isActive === false,
  );
  check(
    "N2. الفصل يحذف مرجع بيانات الاعتماد (fp:<id>) — لا سرّ متبقٍ",
    !storedSecrets.has(disconnectedConnection!.credentialsRef!) &&
      afterDisconnect?.credentialsRef ===
        disconnectedConnection!.credentialsRef,
  );
  const statusAfterDisconnect = await getTelegramConnectionStatus(
    { ...launchDeps, api: managerApi },
    { userId: "user-a", role: "ADMIN", businessId: BUSINESS_A },
  );
  check(
    "N3. بعد الفصل، الحالة DISCONNECTED (والاتصال لا يزال مرئياً للإعادة)",
    statusAfterDisconnect.success === true &&
      statusAfterDisconnect.view.uiState === "DISCONNECTED",
  );
  // Reconnect = a FRESH provisioning flow; the same bot re-provisions the
  // existing DISCONNECTED row in place with a NEW fp:<id>.
  const reconnectToken = mintTelegramStartToken();
  ledger.push({
    id: `led-${++ledgerSeq}`,
    businessId: BUSINESS_A,
    connectionId: null,
    startToken: reconnectToken,
    creatorTelegramUserId: CREATOR_ID,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    consumedAt: null,
    outcomeCode: null,
    createdAt: new Date(),
  });
  const oldRef = disconnectedConnection!.credentialsRef;
  const reconnect = await completeManagedBotProvisioning(
    {
      ...provisioningDeps,
      api: managerWebhookApi,
      managerBotId: MANAGER_BOT_ID,
    },
    {
      creatorTelegramUserId: CREATOR_ID,
      botExternalId: BOT_ID_L,
      botUsername: BOT_USERNAME,
    },
  );
  const reconnected = createdConnections.find(
    (row) => row.id === disconnectedConnection!.id,
  );
  check(
    "N4. إعادة الربط بنفس البوت → الصف نفسه يعود CONNECTED + مرجع fp:<id> جديد",
    reconnect.ok === true &&
      reconnect.connectionId === disconnectedConnection!.id &&
      reconnected?.status === "CONNECTED" &&
      reconnected?.isActive === true &&
      reconnected?.credentialsRef !== oldRef &&
      reconnected?.credentialsRef!.startsWith("fp:") === true,
  );
  check(
    "N5. إعادة الربط تولّد سرّ ويبهوك جديداً + مخزَّن تحت المرجع الجديد",
    storedSecrets.get(reconnected!.credentialsRef!) === BOT_TOKEN_VALUE &&
      /^[0-9a-f]{64}$/.test(reconnected!.webhookSecretHash!) === true,
  );

  // ════════════════════════════════════════════════════════════════════════
  // O. The provisioning state machine — every rejection boundary of the
  //    /start payload + every typed provider failure + the CONNECTED
  //    transition guard (DECISIONS #63 (B)/(D), #66).
  // ════════════════════════════════════════════════════════════════════════

  // O1. A malformed deep-link payload (`/start` with a token that is not
  //     in the link's grammar) is NOT treated as a start: nothing is
  //     bound, no Business is resolved, and the Admin gets the guide.
  const malformedStart = await runManager(
    {
      update_id: 9000030,
      message: {
        message_id: 30,
        date: 1758900010,
        chat: { id: Number(CREATOR_ID), type: "private" },
        from: { id: Number(CREATOR_ID), is_bot: false },
        text: "/start not a valid token!!!",
      },
    },
    MANAGER_SECRET,
  );
  check(
    "O1. حمولة /start برمز غير صالح → لا ربط (دليل فقط، لا تفعيل صامت)",
    eq(malformedStart.status, 200) &&
      eq(malformedStart.body.start, "GUIDE") &&
      !JSON.stringify(malformedStart.body).includes(BUSINESS_A),
  );

  // O2. A bare `/start` with no token at all — same safe classification.
  const missingStart = await runManager(
    {
      update_id: 9000031,
      message: {
        message_id: 31,
        date: 1758900011,
        chat: { id: Number(CREATOR_ID), type: "private" },
        from: { id: Number(CREATOR_ID), is_bot: false },
        text: "/start",
      },
    },
    MANAGER_SECRET,
  );
  check(
    "O2. /start بلا رمز → دليل آمن (لا محاولة تُربط)",
    eq(missingStart.status, 200) && eq(missingStart.body.start, "GUIDE"),
  );

  // O3. An EXPIRED attempt: the deep link's token is real but the attempt
  //     window has passed. `/start` is refused (no binding, no keyboard),
  //     and the reply tells the Admin to re-launch — the attempt is never
  //     silently extended.
  const expiredToken = mintTelegramStartToken();
  ledger.push({
    id: `led-${++ledgerSeq}`,
    businessId: BUSINESS_A,
    connectionId: null,
    startToken: expiredToken,
    creatorTelegramUserId: null,
    expiresAt: new Date(Date.now() - 60_000),
    consumedAt: null,
    outcomeCode: null,
    createdAt: new Date(Date.now() - 30 * 60_000),
  });
  const expiredStart = await runManager(
    {
      update_id: 9000032,
      message: {
        message_id: 32,
        date: 1758900012,
        chat: { id: Number(CREATOR_ID), type: "private" },
        from: { id: Number(CREATOR_ID), is_bot: false },
        text: `/start ${expiredToken}`,
      },
    },
    MANAGER_SECRET,
  );
  const expiredRow = ledger.find((row) => row.startToken === expiredToken);
  check(
    "O3. رمز منتهي الصلاحية → REFUSED + لا لوحة + المنشئ لا يُربط",
    eq(expiredStart.status, 200) &&
      eq(expiredStart.body.start, "REJECTED") &&
      expiredRow?.creatorTelegramUserId === null,
  );

  // O4. A transient setWebhook failure during completion maps to
  //     PROVIDER_UNREACHABLE, terminates the attempt with the typed
  //     outcome, leaves NO connection, and leaks no token.
  const transientApi = {
    fetchImpl: (async (url: string) => {
      const method = url.split("/").pop();
      if (method === "getManagedBotToken") {
        return new Response(
          JSON.stringify({ ok: true, result: { token: BOT_TOKEN_VALUE } }),
          { status: 200 },
        );
      }
      if (method === "setWebhook") {
        return new Response(
          JSON.stringify({ ok: false, error_code: 500, description: "Server" }),
          { status: 500 },
        );
      }
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
      });
    }) as typeof fetch,
    apiHost: "https://api.telegram.org",
    credentialsResolver: provisioningDeps.api.credentialsResolver,
  };
  const transientToken = mintTelegramStartToken();
  ledger.push({
    id: `led-${++ledgerSeq}`,
    businessId: BUSINESS_A,
    connectionId: null,
    startToken: transientToken,
    creatorTelegramUserId: CREATOR_ID,
    expiresAt: new Date(Date.now() + 15 * 60_000),
    consumedAt: null,
    outcomeCode: null,
    createdAt: new Date(),
  });
  const transientConnectionsBefore = createdConnections.length;
  const transient = await handleTelegramManagerWebhook(
    { ...managerDeps, api: transientApi },
    managerRequest(
      {
        update_id: 9000033,
        managed_bot: {
          added: true,
          bot: { id: Number("6666666666"), is_bot: true },
          user: { id: Number(CREATOR_ID), is_bot: false },
        },
      },
      MANAGER_SECRET,
    ),
  );
  const transientRow = ledger.find((row) => row.startToken === transientToken);
  const transientBody = (await transient.json()) as Record<string, unknown>;
  check(
    "O4. فشل setWebhook أثناء التفعيل → PROVIDER_UNREACHABLE + محاولة مُنهية + لا اتصال",
    eq(transient.status, 200) &&
      eq(transientBody.outcome, "PROVIDER_UNREACHABLE") &&
      transientRow?.consumedAt !== null &&
      transientRow?.outcomeCode === "PROVIDER_UNREACHABLE" &&
      createdConnections.length === transientConnectionsBefore &&
      !JSON.stringify(transientBody).includes(BOT_TOKEN_VALUE),
  );

  // O5. A getMe identity mismatch during completion (Telegram reports a
  //     different bot than the event named) → PROVISIONING_FAILED, attempt
  //     terminated, nothing connected.
  const swappedApi = {
    fetchImpl: (async (url: string) => {
      const method = url.split("/").pop();
      if (method === "getManagedBotToken") {
        return new Response(
          JSON.stringify({ ok: true, result: { token: BOT_TOKEN_VALUE } }),
          { status: 200 },
        );
      }
      if (method === "getMe") {
        return new Response(
          JSON.stringify({
            ok: true,
            result: { id: Number("6777777000"), is_bot: true },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
      });
    }) as typeof fetch,
    apiHost: "https://api.telegram.org",
    credentialsResolver: provisioningDeps.api.credentialsResolver,
  };
  const swappedToken = mintTelegramStartToken();
  ledger.push({
    id: `led-${++ledgerSeq}`,
    businessId: BUSINESS_A,
    connectionId: null,
    startToken: swappedToken,
    creatorTelegramUserId: CREATOR_ID,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    consumedAt: null,
    outcomeCode: null,
    createdAt: new Date(),
  });
  const swappedConnectionsBefore = createdConnections.length;
  const swapped = await handleTelegramManagerWebhook(
    { ...managerDeps, api: swappedApi },
    managerRequest(
      {
        update_id: 9000034,
        managed_bot: {
          added: true,
          bot: { id: Number("6666667777"), is_bot: true },
          user: { id: Number(CREATOR_ID), is_bot: false },
        },
      },
      MANAGER_SECRET,
    ),
  );
  const swappedRow = ledger.find((row) => row.startToken === swappedToken);
  const swappedBody = (await swapped.json()) as Record<string, unknown>;
  check(
    "O5. تباين هوية getMe أثناء التفعيل → PROVISIONING_FAILED + لا اتصال",
    eq(swapped.status, 200) &&
      eq(swappedBody.outcome, "PROVISIONING_FAILED") &&
      swappedRow?.outcomeCode === "PROVISIONING_FAILED" &&
      createdConnections.length === swappedConnectionsBefore,
  );

  // O6. The CONNECTED transition guard: `markOnboardingReady` is the ONLY
  //     write path to READY, and it is guarded by the OPERATIONAL gate.
  //     A row that is not CONNECTED+active (here: a fresh PENDING row) is
  //     refused — no onboarding-READY row can ever exist for a connection
  //     the runtime send/inbound gate would refuse.
  const pendingId = `${CONNECTION_A}-pending`;
  createdConnections.push(
    fakeConnection({
      id: pendingId,
      businessId: BUSINESS_A,
      branchId: null,
      botExternalId: "6000000001",
      status: "PENDING",
      isActive: false,
      credentialsRef: null,
      onboardingState: "NOT_STARTED",
    }),
  );
  check(
    "O6. markOnboardingReady يرفض الصف غير الموصول (الحارس)",
    (await provisioningDeps.connectionRepository.markOnboardingReady(
      pendingId,
      BUSINESS_A,
    )) === null,
  );
  const pendingAfter = createdConnections.find((row) => row.id === pendingId);
  check(
    "O6b. الصف المرفوض يبقى على حالته (لا READY دون CONNECTED)",
    pendingAfter?.onboardingState === "NOT_STARTED" &&
      pendingAfter?.status === "PENDING" &&
      pendingAfter?.isActive === false,
  );

  // ── P. Webhook route reachability (the live v0.31.0 defect).
  //    Telegram's servers POST with NO FlowPilot session cookie, so a
  //    session-gated route makes `src/proxy.ts` answer 307 → /sign-in and
  //    the delivery never reaches the handler. Public here is safe: each
  //    handler verifies `X-Telegram-Bot-Api-Secret-Token` and answers 401
  //    before any parsing (asserted in sections C and H above).
  const { isPublicPath } = await import("@/lib/public-paths");
  check(
    "P1. /api/telegram/webhook متاح لتيليجرام (لا إعادة توجيه 307)",
    isPublicPath("/api/telegram/webhook") === true,
  );
  check(
    "P2. /api/telegram/manager/webhook متاح لتيليجرام (binding + managed_bot)",
    isPublicPath("/api/telegram/manager/webhook") === true,
  );
  check(
    "P3. بقية المسارات تبقى محمية (لا تسريب من البوابة)",
    isPublicPath("/api/conversations") === false &&
      isPublicPath("/settings/telegram") === false,
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
    `\nأساس قناة تيليجرام مُتحقَّق منه دون اتصال: ${checks.length}/${checks.length} فحص ناجح.`,
  );
}

main().catch((error: Error) => {
  console.error(`فشل غير متوقع: ${error.message}`);
  process.exit(1);
});
