import { readFileSync, readdirSync, statSync } from "node:fs";
/* eslint-disable @typescript-eslint/consistent-type-imports */
import { join } from "node:path";

/**
 * FlowPilot — WHATSAPP TRANSPORT check (PROMPT-CORE-03A).
 *
 * Verifies the provider-neutral WhatsApp transport foundation with
 * in-memory repositories (no DB, no network, no vendor):
 *   1. valid inbound normalization (TEXT envelope, exact field set);
 *   2. valid outbound normalization (connectionId/correlationId/kind);
 *   3. hostile identity keys (businessId/branchId/connectionId/role/
 *      accountType) are REJECTED at the boundary — never injected;
 *   4. same-Business send connection accepted;
 *   5. cross-Business connection rejected (no existence leak);
 *   6. optional Branch scope validated (own branch accepted / foreign
 *      branch refused / Business-shared → Default Branch fallback);
 *   7. duplicate inbound external message deduplicated through the REAL
 *      conversation engine (one customer message, idempotent redelivery
 *      with the original ids);
 *   8. provider payloads never leak into the Core contract (strict key
 *      set; non-TEXT kinds refused at the engine mapping);
 *   9. secrets never appear in normalized results;
 *  10. retryable vs permanent transport errors are distinguishable;
 *  11. no Meta-specific code/imports in Core source;
 *  12. no external network capability in the transport boundary.
 *
 * The idempotency source of truth is the EXISTING durable dedupe model
 * (`inbound_message_dedupe` semantics mirrored in the fake ledger); the
 * duplicate test runs the REAL `receiveInboundMessage` with fake repos —
 * the engine input itself goes through the REAL normalized boundary
 * (`normalizeInboundTransportMessage` → `toEngineInboundMessage`) first.
 * Run: pnpm check:whatsapp-transport
 *
 * Dummy env vars satisfy the fail-fast env validation of the imported
 * modules — no real connection is ever made (fake deps only).
 */

export {};

type Check = { label: string; pass: boolean };

type TransportModule =
  typeof import("../src/server/transport/whatsapp-transport");
type ConnectionResolutionDeps =
  import("../src/server/transport/whatsapp-transport").ConnectionResolutionDeps;
type MessageTransportType =
  import("../src/server/transport/whatsapp-transport").MessageTransport;
type EngineSchemaModule =
  typeof import("../src/features/conversations/schemas/conversation-schema");
type EngineModule =
  typeof import("../src/features/conversations/server/conversation-engine");
type AiContractModule =
  typeof import("../src/features/conversations/server/ai-contract");
type DedupeModule =
  typeof import("../src/server/repositories/inbound-dedupe.repository");

async function main(): Promise<void> {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const transport: TransportModule =
    await import("../src/server/transport/whatsapp-transport");
  const engineSchema: EngineSchemaModule =
    await import("../src/features/conversations/schemas/conversation-schema");
  const aiContract: AiContractModule =
    await import("../src/features/conversations/server/ai-contract");
  const engine: EngineModule =
    await import("../src/features/conversations/server/conversation-engine");
  const dedupe: DedupeModule =
    await import("../src/server/repositories/inbound-dedupe.repository");

  const checks: Check[] = [];
  function check(label: string, pass: boolean): void {
    checks.push({ label, pass });
  }

  // ── Deterministic fixtures (valid UUIDs) ─────────────────────────────────
  const BUSINESS_A = "11111111-1111-4111-8111-111111111111";
  const BUSINESS_B = "22222222-2222-4222-8222-222222222222";
  const BRANCH_A = "33333333-3333-4333-8333-333333333333";
  const BRANCH_B = "34444444-4444-4444-8444-444444444444";
  const CONN_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
  const CONN_A_SHARED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
  const CONN_B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
  const CONN_B_INACTIVE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4";
  const BUSINESS_INACTIVE = "44444444-4444-4444-8444-444444444445";
  const SECRET_REF = "env:WHATSAPP_TOKEN_REF";
  const PHONE_A = "+201001111111";
  const PHONE_A_SHARED = "+201005555555";
  const PHONE_B = "+201002222222";
  const PHONE_INACTIVE = "+201003333333";
  const CUSTOMER_PHONE = "+201234567890";
  const RECEIVED_AT = "2026-09-14T10:00:00.000Z";
  const EXTERNAL_ID = "wamid.CORE03A-1";

  // ── In-memory connection/tenant fixtures (fake deps only) ────────────────
  type ConnectionRow = {
    id: string;
    businessId: string;
    branchId: string | null;
    phoneNumber: string;
    status: string;
    isActive: boolean;
    credentialsRef: string;
  };

  const businessRows: Array<{
    id: string;
    name: string;
    whatsappNumber: string;
    isActive: boolean;
  }> = [
    {
      id: BUSINESS_A,
      name: "منشأة أ",
      whatsappNumber: PHONE_A,
      isActive: true,
    },
    {
      id: BUSINESS_B,
      name: "منشأة ب",
      whatsappNumber: PHONE_B,
      isActive: true,
    },
    {
      id: BUSINESS_INACTIVE,
      name: "منشأة موقوفة",
      whatsappNumber: PHONE_INACTIVE,
      isActive: false,
    },
  ];
  const connectionRows: ConnectionRow[] = [
    {
      id: CONN_A,
      businessId: BUSINESS_A,
      branchId: BRANCH_A,
      phoneNumber: PHONE_A,
      status: "CONNECTED",
      isActive: true,
      credentialsRef: SECRET_REF,
    },
    {
      id: CONN_A_SHARED,
      businessId: BUSINESS_A,
      branchId: null,
      phoneNumber: PHONE_A_SHARED,
      status: "CONNECTED",
      isActive: true,
      credentialsRef: SECRET_REF,
    },
    {
      id: CONN_B,
      businessId: BUSINESS_B,
      branchId: BRANCH_B,
      phoneNumber: PHONE_B,
      status: "DISCONNECTED",
      isActive: true,
      credentialsRef: SECRET_REF,
    },
    {
      id: CONN_B_INACTIVE,
      businessId: BUSINESS_B,
      branchId: null,
      phoneNumber: "+201006666666",
      status: "PENDING",
      isActive: false,
      credentialsRef: SECRET_REF,
    },
  ];
  const branchRows: Array<{ id: string; businessId: string }> = [
    { id: BRANCH_A, businessId: BUSINESS_A },
    { id: BRANCH_B, businessId: BUSINESS_B },
  ];

  const canonicalPhone = (phone: string): string => phone.replace(/[\s-]/g, "");

  const connectionDeps = {
    businessRepository: {
      findByWhatsappNumber: async (number: string) => {
        const hit = businessRows.find(
          (row) => row.whatsappNumber === canonicalPhone(number),
        );
        if (hit) return hit;
        // Business-shared connection number (branchId=null) is still
        // Business-owned — the Business row keeps its legacy whatsappNumber,
        // but the transport boundary resolves via the same lookup. For the
        // harness the shared number belongs to BUSINESS_A (no second tenant).
        if (canonicalPhone(number) === canonicalPhone(PHONE_A_SHARED)) {
          return businessRows.find((row) => row.id === BUSINESS_A) ?? null;
        }
        return null;
      },
    },
    whatsappConnectionRepository: {
      findByPhone: async (businessId: string, phoneNumber: string) =>
        connectionRows.find(
          (row) =>
            row.businessId === businessId &&
            row.phoneNumber === canonicalPhone(phoneNumber),
        ) ?? null,
      findByIdWithinBusiness: async (id: string, businessId: string) =>
        connectionRows.find(
          (row) => row.id === id && row.businessId === businessId,
        ) ?? null,
    },
    branchRepository: {
      findDefaultByBusiness: async (businessId: string) =>
        branchRows.find((row) => row.businessId === businessId) ?? null,
      findByIdWithinBusiness: async (id: string, businessId: string) =>
        branchRows.find(
          (row) => row.id === id && row.businessId === businessId,
        ) ?? null,
    },
  } as unknown as ConnectionResolutionDeps;

  // ── 1. Valid inbound normalization ───────────────────────────────────────
  const validRaw = {
    externalMessageId: EXTERNAL_ID,
    senderExternalId: CUSTOMER_PHONE,
    recipientExternalId: PHONE_A,
    timestamp: RECEIVED_AT,
    text: "مرحبا، أريد حجز موعد",
  };
  const normalized = transport.normalizeInboundTransportMessage(validRaw);
  check(
    "رسالة نصية واردة صالحة → ظرف موحّد بالحقول الأساسية (معرّف خارجي/مرسل/مستقبل/وقت/نوع/نص)",
    normalized.ok &&
      normalized.message.externalMessageId === EXTERNAL_ID &&
      normalized.message.senderExternalId === CUSTOMER_PHONE &&
      normalized.message.recipientExternalId === PHONE_A &&
      normalized.message.timestamp === RECEIVED_AT &&
      normalized.message.kind === "TEXT" &&
      normalized.message.text === "مرحبا، أريد حجز موعد",
  );
  const defaultKind = transport.normalizeInboundTransportMessage({
    senderExternalId: CUSTOMER_PHONE,
    recipientExternalId: PHONE_A,
    timestamp: RECEIVED_AT,
    text: "بدون kind",
    externalMessageId: "wamid.DEFAULT-1",
  });
  check(
    "kind محذوف → TEXT افتراضيًا",
    defaultKind.ok && defaultKind.message.kind === "TEXT",
  );

  // ── 3. Hostile identity keys are REJECTED (never injected) ───────────────
  const hostile = transport.normalizeInboundTransportMessage({
    ...validRaw,
    businessId: BUSINESS_B,
    branchId: BRANCH_B,
    connectionId: CONN_B,
    role: "ADMIN",
    accountType: "PLATFORM",
    assignedUserId: "55555555-5555-4555-8555-555555555555",
  });
  check(
    "مفاتيح الهوية العدائية مرفوضة عند الحدود (businessId/branchId/connectionId/role/accountType)",
    !hostile.ok && hostile.error.code === "MALFORMED_PROVIDER_PAYLOAD",
  );
  const malformed = transport.normalizeInboundTransportMessage({
    senderExternalId: CUSTOMER_PHONE,
    recipientExternalId: PHONE_A,
    timestamp: RECEIVED_AT,
    text: "بدون معرّف خارجي",
  });
  check(
    "حمولة ناقصة (بلا معرّف رسالة خارجي) → MALFORMED_PROVIDER_PAYLOAD",
    !malformed.ok && malformed.error.code === "MALFORMED_PROVIDER_PAYLOAD",
  );

  // ── 8. Provider payloads never leak into the Core contract ──────────────
  const mediaEnvelope = transport.normalizeInboundTransportMessage({
    externalMessageId: "wamid.MEDIA-1",
    senderExternalId: CUSTOMER_PHONE,
    recipientExternalId: PHONE_A,
    timestamp: RECEIVED_AT,
    kind: "MEDIA",
    media: {
      mimeType: "image/jpeg",
      externalReference: "provider-media-locator-1",
    },
  });
  check(
    "رسالة وسائط → عقد مرجعي مصغّر فقط (بلا تنزيل/بلا حمولة خام في العقد)",
    mediaEnvelope.ok &&
      mediaEnvelope.message.media?.mimeType === "image/jpeg" &&
      !("rawPayload" in mediaEnvelope.message) &&
      mediaEnvelope.message.text === undefined,
  );
  if (mediaEnvelope.ok) {
    let refused: Error | null = null;
    try {
      transport.toEngineInboundMessage({
        ...mediaEnvelope.message,
        connectionId: CONN_A,
        businessId: BUSINESS_A,
        branchId: BRANCH_A,
      });
    } catch (error) {
      refused = error as Error;
    }
    check(
      "الوسائط تُرفض عند حدود النواة (UNSUPPORTED_MESSAGE_TYPE — لا معالجة وسائط بعد)",
      refused instanceof transport.TransportError &&
        refused.code === "UNSUPPORTED_MESSAGE_TYPE" &&
        !refused.retryable,
    );
  }

  // ── 2. Valid outbound normalization + boundary shapes ───────────────────
  const recordedOutbound: Array<{
    to: string;
    connectionId?: string;
    correlationId?: string;
    kind?: string;
  }> = [];
  const fakeAdapter: MessageTransportType = {
    providerName: "fake-adapter",
    async send(
      message: import("../src/server/transport/whatsapp-transport").OutboundMessage,
    ) {
      recordedOutbound.push({
        to: message.to,
        connectionId: message.connectionId,
        correlationId: message.correlationId,
        kind: message.kind,
      });
      return { provider: "fake-adapter", delivered: true };
    },
  };
  const sent = await fakeAdapter.send({
    to: CUSTOMER_PHONE,
    businessName: "منشأة أ",
    conversationId: "conversation-1",
    content: "رد تجريبي",
    connectionId: CONN_A,
    correlationId: "message-2",
    kind: "TEXT",
  });
  check(
    "عقد الصادر يقبل connectionId/correlationId/kind (حقول اختيارية — المحرك دون تغيير)",
    sent.delivered &&
      recordedOutbound[0]?.connectionId === CONN_A &&
      recordedOutbound[0]?.correlationId === "message-2" &&
      recordedOutbound[0]?.kind === "TEXT",
  );

  // ── 4/5. Connection tenancy: same-Business accepted, cross-Business refused
  const sameBusinessSend = await transport.resolveConnectionForSend(
    connectionDeps,
    { connectionId: CONN_A, businessId: BUSINESS_A },
  );
  check(
    "اتصال نفس المنشأة للإرسال مقبول (id + رقم المنشأة — بلا مرجع سر في النتيجة)",
    sameBusinessSend.ok &&
      sameBusinessSend.connectionId === CONN_A &&
      sameBusinessSend.phoneNumber === PHONE_A,
  );
  const crossBusinessSend = await transport.resolveConnectionForSend(
    connectionDeps,
    { connectionId: CONN_A, businessId: BUSINESS_B },
  );
  const unknownConnection = await transport.resolveConnectionForSend(
    connectionDeps,
    {
      connectionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9",
      businessId: BUSINESS_B,
    },
  );
  check(
    "اتصال منشأة أخرى مرفوض (INVALID_CONNECTION — بلا تسريب وجود، كالمعرّف المجهول)",
    !crossBusinessSend.ok &&
      crossBusinessSend.code === "INVALID_CONNECTION" &&
      !unknownConnection.ok &&
      unknownConnection.code === "INVALID_CONNECTION",
  );
  const disconnectedSend = await transport.resolveConnectionForSend(
    connectionDeps,
    { connectionId: CONN_B, businessId: BUSINESS_B },
  );
  const inactiveSend = await transport.resolveConnectionForSend(
    connectionDeps,
    { connectionId: CONN_B_INACTIVE, businessId: BUSINESS_B },
  );
  check(
    "اتصال غير موصول/غير مفعّل مرفوض للإرسال (INVALID_CONNECTION)",
    !disconnectedSend.ok &&
      disconnectedSend.code === "INVALID_CONNECTION" &&
      !inactiveSend.ok &&
      inactiveSend.code === "INVALID_CONNECTION",
  );

  // ── 6. Optional Branch scope (validated, not silently trusted) ──────────
  const inboundOwnBranch = await transport.resolveInboundConnection(
    connectionDeps,
    PHONE_A,
  );
  check(
    "الوارد: اتصال بنطاق فرع من نفس المنشأة → الفرع مُتحقّق منه",
    inboundOwnBranch.ok &&
      inboundOwnBranch.businessId === BUSINESS_A &&
      inboundOwnBranch.connectionId === CONN_A &&
      inboundOwnBranch.branchId === BRANCH_A,
  );
  const foreignBranchResolution = await transport.resolveInboundConnection(
    {
      ...connectionDeps,

      whatsappConnectionRepository: {
        ...connectionDeps.whatsappConnectionRepository,
        findByPhone: async () =>
          ({
            ...connectionRows[0]!,
            branchId: BRANCH_B,
          }) as unknown as import("../src/types/domain").WhatsAppConnection,
      },
    } as unknown as ConnectionResolutionDeps,
    PHONE_A,
  );
  check(
    "branchId أجنبي (منشأة أخرى) على الاتصال → INVALID_CONNECTION (النطاق مُتحقّق منه)",
    !foreignBranchResolution.ok &&
      foreignBranchResolution.code === "INVALID_CONNECTION",
  );
  const sharedConnection = await transport.resolveInboundConnection(
    connectionDeps,
    PHONE_A_SHARED,
  );
  check(
    "اتصال مشترك على مستوى المنشأة (branchId=null ممكن معماريًا) → الفرع الافتراضي",
    sharedConnection.ok &&
      sharedConnection.connectionId === CONN_A_SHARED &&
      sharedConnection.branchId === BRANCH_A,
  );
  const noConnectionRow = await transport.resolveInboundConnection(
    {
      ...connectionDeps,
      whatsappConnectionRepository: {
        ...connectionDeps.whatsappConnectionRepository,
        findByPhone: async () => null,
      },
    } as unknown as ConnectionResolutionDeps,
    PHONE_A,
  );
  check(
    "لا صف اتصال بعد → connectionId=null مع تعيين رقم المنشأة القائم (الخريطة الحالية)",
    noConnectionRow.ok &&
      noConnectionRow.connectionId === null &&
      noConnectionRow.branchId === BRANCH_A,
  );
  const unknownNumber = await transport.resolveInboundConnection(
    connectionDeps,
    "+209999999999",
  );
  const inactiveBusiness = await transport.resolveInboundConnection(
    connectionDeps,
    PHONE_INACTIVE,
  );
  check(
    "رقم لا يخص أي منشأة / منشأة غير مفعّلة → INVALID_CONNECTION",
    !unknownNumber.ok &&
      unknownNumber.code === "INVALID_CONNECTION" &&
      !inactiveBusiness.ok &&
      inactiveBusiness.code === "INVALID_CONNECTION",
  );

  // ── 7. Duplicate inbound external message is deduplicated (REAL engine) ─
  const engineResult = await runEngineDuplicateTest({
    transport,
    engineSchema,
    aiContract,
    engine,
    dedupe,
    businessId: BUSINESS_A,
    whatsappNumber: PHONE_A,
    customerPhone: CUSTOMER_PHONE,
    receivedAt: RECEIVED_AT,
    externalId: EXTERNAL_ID,
  });
  check(
    "المحرك يُغذّى عبر الحدود الموحّدة (normalize → toEngine → مخطط المحرك الحقيقي)",
    engineResult.engineInputAccepted,
  );
  check(
    "أول تسليم → duplicate:false + رسالة عميل واحدة",
    engineResult.first.ok &&
      engineResult.first.duplicate === false &&
      engineResult.customerMessages.length === 1,
  );
  check(
    "إعادة تسليم نفس المعرّف الخارجي → duplicate:true بنفس المعرّفات (بلا معالجة ثانية)",
    engineResult.second.ok &&
      engineResult.second.duplicate === true &&
      engineResult.second.conversationId ===
        engineResult.first.conversationId &&
      engineResult.second.customerMessageId ===
        engineResult.first.customerMessageId,
  );
  check(
    "إعادة التسليم لا تنشئ رسالة عميل ثانية ولا أثرًا جانبيًا (رسالة واحدة فقط)",
    engineResult.customerMessages.length === 1,
  );
  check(
    "الادعاء المتين قبل المعالجة: claimed ثم duplicate (دلالات إلغاء التكرار القائمة)",
    engineResult.claimStatuses[0] === "claimed" &&
      engineResult.claimStatuses[1] === "duplicate",
  );
  check(
    "المعرّف الخارجي الموحّد هو مفتاح إلغاء التكرار (externalId → المفتاح الخارجي القائم)",
    engineResult.dedupeKeys.length > 0 &&
      engineResult.dedupeKeys.every((key) => key.includes(EXTERNAL_ID)),
  );

  // ── 9. Secrets never appear in normalized results ────────────────────────
  const secretPayload = transport.normalizeInboundTransportMessage({
    ...validRaw,
    accessToken: SECRET_REF,
    credentialsRef: SECRET_REF,
  });
  const normalizedResults = JSON.stringify([
    sameBusinessSend,
    inboundOwnBranch,
    sharedConnection,
    noConnectionRow,
    normalized.ok ? normalized.message : null,
  ]);
  check(
    "أسرار الحمولة مرفوضة عند الحدود (مفاتيح السر لا تدخل الظرف)",
    !secretPayload.ok &&
      secretPayload.error.code === "MALFORMED_PROVIDER_PAYLOAD",
  );
  check(
    "لا مرجع سر/رمز وصول في أي نتيجة موحّدة (rows تحمل credentialsRef والنتائج لا تحمله)",
    !normalizedResults.includes("credentialsRef") &&
      !normalizedResults.includes("accessToken") &&
      !normalizedResults.includes(SECRET_REF),
  );

  // ── 10. Retryable vs permanent transport errors ─────────────────────────
  const transient = new transport.TransportError("TRANSIENT_TRANSPORT_FAILURE");
  const permanent = new transport.TransportError("PERMANENT_TRANSPORT_FAILURE");
  const retryableCount = transport.whatsappTransportErrorCodes.filter(
    transport.isRetryableTransportErrorCode,
  ).length;
  check(
    "أخطاء النقل قابلة للتمييز: فئة عابرة وحيدة قابلة لإعادة المحاولة، والباقي دائم",
    transient.retryable &&
      !permanent.retryable &&
      retryableCount === 1 &&
      transport.isRetryableTransportErrorCode("TRANSIENT_TRANSPORT_FAILURE") &&
      !transport.isRetryableTransportErrorCode("PERMANENT_TRANSPORT_FAILURE") &&
      !transport.isRetryableTransportErrorCode("INVALID_CONNECTION") &&
      !transport.isRetryableTransportErrorCode("UNSUPPORTED_MESSAGE_TYPE") &&
      !transport.isRetryableTransportErrorCode("MALFORMED_PROVIDER_PAYLOAD") &&
      !transport.isRetryableTransportErrorCode("UNAUTHORIZED_CREDENTIALS") &&
      !transport.isRetryableTransportErrorCode("DUPLICATE_INBOUND"),
  );

  // ── 11. No Meta-specific code/imports in Core source ────────────────────
  const metaMarkers =
    /graph\.facebook\.com|@\/server\/transport\/meta|x-hub-signature|meta_cloud|metaGraph/i;
  const coreHits = scanSourceTree(
    join(process.cwd(), "src"),
    (relPath) =>
      !relPath.startsWith("generated") &&
      !relPath.startsWith("server/integrations/whatsapp/") &&
      relPath !== "app/api/whatsapp/meta/route.ts",
    (content) => metaMarkers.test(content),
  );
  check(
    "لا كود خاص بمزوّد Meta في مصدر النواة (فحص ثابت — خارج generated)",
    coreHits.length === 0,
  );

  // ── 12. No external network capability in the transport boundary ────────
  const networkMarkers =
    /fetch\s*\(|axios|XMLHttpRequest|node:http|node:https|node:net/;
  const boundaryFiles = [
    "src/server/transport/whatsapp-transport.ts",
    "src/features/conversations/server/conversation-transport.ts",
    "src/features/conversations/server/conversation-engine.ts",
    "src/features/conversations/schemas/conversation-schema.ts",
  ];
  const networkHits = boundaryFiles.filter((rel) =>
    networkMarkers.test(readFileSync(join(process.cwd(), rel), "utf8")),
  );
  check(
    "حدود النقل/المحرك بلا قدرة شبكة خارجية (فحص ثابت — لا fetch/axios/http)",
    networkHits.length === 0,
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
    `\nثوابت نقل واتساب صحيحة: ${checks.length}/${checks.length} فحص ناجح.`,
  );
}

// ── Real-engine duplicate test (in-memory fake deps) ────────────────────────

type EngineHarnessParams = {
  transport: TransportModule;
  engineSchema: EngineSchemaModule;
  aiContract: AiContractModule;
  engine: EngineModule;
  dedupe: DedupeModule;
  businessId: string;
  whatsappNumber: string;
  customerPhone: string;
  receivedAt: string;
  externalId: string;
};

type EngineHarnessResult = {
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
  claimStatuses: string[];
  dedupeKeys: string[];
  engineInputAccepted: boolean;
};

async function runEngineDuplicateTest(
  params: EngineHarnessParams,
): Promise<EngineHarnessResult> {
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
  const claimStatuses: string[] = [];
  const dedupeKeys: string[] = [];

  // Durable-ledger semantics mirror (inbound_message_dedupe): ONE row per
  // (businessId, externalKey); "duplicate" only when the customer message
  // was persisted (claim-coupled write); "reclaim" = crashed attempt.
  const ledger = new Map<
    string,
    {
      claimId: string;
      conversationId: string | null;
      customerMessageId: string | null;
    }
  >();

  const dedupeRepo = {
    claim: async (scopedBusinessId: string, externalKey: string) => {
      const key = `${scopedBusinessId}|${externalKey}`;
      dedupeKeys.push(key);
      const existing = ledger.get(key);
      if (existing) {
        if (existing.customerMessageId) {
          claimStatuses.push("duplicate");
          return {
            status: "duplicate" as const,
            claimId: existing.claimId,
            conversationId: existing.conversationId,
            customerMessageId: existing.customerMessageId,
          };
        }
        claimStatuses.push("reclaim");
        return { status: "reclaim" as const, claimId: existing.claimId };
      }
      const claimId = `claim-${ledger.size + 1}`;
      ledger.set(key, {
        claimId,
        conversationId: null,
        customerMessageId: null,
      });
      claimStatuses.push("claimed");
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
    name: "عميل تجريبي",
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
            name: "منشأة أ",
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
        addMessage: async (input, _workflow, dedupeRef) => {
          const claimRow = dedupeRef
            ? [...ledger.values()].find(
                (row) => row.claimId === dedupeRef.claimId,
              )
            : undefined;
          if (dedupeRef) {
            if (!claimRow) throw new Error("UNKNOWN_CLAIM");
            if (claimRow.customerMessageId) {
              throw new dedupe.InboundDuplicateError({
                conversationId: claimRow.conversationId,
                customerMessageId: claimRow.customerMessageId,
              });
            }
          }
          const message = {
            id: `message-${messages.length + 1}`,
            conversationId: input.conversationId,
            senderType: input.senderType,
            content: input.content,
            createdAt: input.createdAt ?? new Date(),
            updatedAt: new Date(),
          } as unknown as import("../src/types/domain").Message;
          messages.push(message);
          if (input.senderType === "CUSTOMER")
            customerMessages.push(message.id);
          if (claimRow) {
            claimRow.conversationId = input.conversationId;
            claimRow.customerMessageId = message.id;
          }
          return message;
        },
        getMessages: async () => [...messages].reverse(),
        update: async () => conversation,
        updateWorkflow: async () => conversation,
      },
      serviceRepository: {
        listByBusiness: async () => [],
      },
      inboundDedupeRepository: dedupeRepo,
      usageRepository: {
        record: async (input) =>
          input as import("../src/types/domain").UsageRecord,
      },
      ai: {
        providerName: "fake-ai",
        respond: async () => ({
          intent: "FAQ" as const,
          action: "reply" as const,
          content: "رد تجريبي",
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

  // The engine input goes through the REAL normalized boundary first —
  // proving the transport mapping feeds the REAL engine contract.
  const envelope = transport.normalizeInboundTransportMessage({
    externalMessageId: externalId,
    senderExternalId: customerPhone,
    recipientExternalId: whatsappNumber,
    timestamp: receivedAt,
    text: "مرحبا",
  });
  let engineInput: unknown = null;
  let engineInputAccepted = false;
  if (envelope.ok) {
    const mapped = transport.toEngineInboundMessage({
      ...envelope.message,
      connectionId: conversation.id,
      businessId,
      branchId: "branch-1",
    });
    const parsed = engineSchema.inboundMessageSchema.safeParse(mapped);
    engineInputAccepted = parsed.success;
    engineInput = parsed.success ? parsed.data : null;
  }

  const first = await engine.receiveInboundMessage(deps, engineInput);
  const second = await engine.receiveInboundMessage(deps, engineInput);

  const firstDuplicate = first.ok ? first.duplicate : undefined;
  const firstConversationId =
    first.ok && first.duplicate === false ? first.conversationId : "";
  const firstCustomerMessageId =
    first.ok && first.duplicate === false ? first.customerMessageId : "";
  const secondConversationId = second.ok ? second.conversationId : "";
  const secondCustomerMessageId = second.ok ? second.customerMessageId : "";

  return {
    first: {
      ok: first.ok,
      duplicate: firstDuplicate,
      conversationId: firstConversationId,
      customerMessageId: firstCustomerMessageId,
    },
    second: {
      ok: second.ok,
      duplicate: second.ok ? second.duplicate : undefined,
      conversationId: secondConversationId,
      customerMessageId: secondCustomerMessageId,
    },
    customerMessages,
    claimStatuses,
    dedupeKeys,
    engineInputAccepted,
  };
}

// ── Source-tree scan (static, dependency-free) ───────────────────────────────

function scanSourceTree(
  root: string,
  include: (relPath: string) => boolean,
  hit: (content: string) => boolean,
): string[] {
  const results: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const relPath = rel ? `${rel}/${entry}` : entry;
      if (statSync(full).isDirectory()) {
        walk(full, relPath);
      } else if (entry.endsWith(".ts") && include(relPath)) {
        if (hit(readFileSync(full, "utf8"))) results.push(relPath);
      }
    }
  };
  walk(root, "");
  return results;
}

main().catch((error: Error) => {
  console.error(`فشل غير متوقع: ${error.message}`);
  process.exit(1);
});
