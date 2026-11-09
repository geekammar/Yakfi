/* eslint-disable @typescript-eslint/no-explicit-any */
import "./setup-test-env";

/**
 * FlowPilot — Safe Telegram Staff Reply Delivery Real-DB Integration Check (ISS-018).
 *
 * Verifies route authority, durable submission claiming, provider dispatch,
 * failure boundaries, and staff ownership preservation against a disposable PostgreSQL DB:
 *
 * 1. Authenticated ingress to the correct Telegram route -> accepted delivery
 * 2. Missing route / ambiguous conflicting route -> unroutable, 0 network calls
 * 3. Foreign / inactive connection -> unroutable, 0 network calls
 * 4. Duplicate submissions (same key + same payload) -> 0 extra network calls, reconciled
 * 5. Same key with different payload -> definite rejection, 0 network calls
 * 6. Provider timeout -> outcome unknown, unconfirmed, no auto-resend
 * 7. Acceptance followed by result write failure -> outcome unknown, unconfirmed, no auto-resend
 * 8. Staff ownership preservation -> existing assignee never silently overwritten
 * 9. Physical call counts strictly asserted across all scenarios.
 *
 * Run:
 *   DATABASE_URL='postgresql://postgres:password@localhost:5432/flowpilot_test' \
 *     pnpm check:safe-telegram-reply-db
 */

import { createHash, randomUUID } from "node:crypto";

import { receiveInboundMessage } from "@/features/conversations/server/conversation-engine";
import {
  lookupStaffReplyStatus,
  resolveConversationRoute,
  submitStaffReply,
} from "@/features/conversations/server/staff-reply-delivery";
import type {
  CredentialsResolver,
  ResolvedCredential,
} from "@/server/credentials/credentials-resolver";
import { db } from "@/server/db";
import { hashTelegramWebhookSecret } from "@/server/integrations/telegram/telegram-webhook";
import {
  branchRepository,
  businessRepository,
  conversationRepository,
  conversationStateRepository,
  customerRepository,
  inboundDedupeRepository,
  serviceRepository,
  usageRepository,
} from "@/server/repositories";

type Check = { label: string; pass: boolean; details?: unknown };
const checks: Check[] = [];

function check(label: string, pass: boolean, details?: unknown): void {
  checks.push({ label, pass, details });
  if (pass) {
    console.log(`✔ ${label}`);
  } else {
    console.error(`✘ ${label}`);
    if (details !== undefined) {
      console.error("  details:", JSON.stringify(details, null, 2));
    }
  }
}

function classifyTarget(
  url: string,
): { host: string; local: boolean; reason: string } | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const loopback = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
    const isLocal =
      loopback.has(host) ||
      host.endsWith(".local") ||
      host.endsWith(".localhost") ||
      host === "";
    return {
      host,
      local: isLocal,
      reason: isLocal
        ? "local / disposable test database"
        : "remote host rejected",
    };
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  console.log(
    "▶ Running ISS-018 Safe Telegram Staff Reply Delivery Integration Check...",
  );

  const url = process.env.DATABASE_URL ?? "";
  const target = classifyTarget(url);
  if (!target || !target.local) {
    console.error(
      "❌ DEV_DB_INTEGRATION_BLOCKED: DATABASE_URL must point to a local disposable test database.",
    );
    process.exit(1);
  }
  console.log(`🔒 Target database verified local: ${target.host}`);

  // Test identities
  const TEST_BUSINESS_ID = randomUUID();
  const FOREIGN_BUSINESS_ID = randomUUID();
  const STAFF_USER_A_ID = randomUUID();
  const STAFF_USER_B_ID = randomUUID();
  const DEFAULT_BRANCH_ID = randomUUID();
  const FOREIGN_BRANCH_ID = randomUUID();

  const BOT_EXTERNAL_ID = String(Date.now());
  const FOREIGN_BOT_EXTERNAL_ID = String(Date.now() + 100000);
  const TELEGRAM_CHAT_ID = "987654321";
  const TEST_TOKEN = "test_bot_token_secret_123";

  // Fake credentials resolver
  const testCredentialsResolver: CredentialsResolver = {
    async resolve(ref: string): Promise<ResolvedCredential> {
      if (ref === "fp:test-telegram-token") {
        return { ok: true, kind: "RUNTIME", reference: ref, value: TEST_TOKEN };
      }
      if (ref === "fp:foreign-telegram-token") {
        return {
          ok: true,
          kind: "RUNTIME",
          reference: ref,
          value: "foreign_token",
        };
      }
      return {
        ok: false,
        code: "UNRESOLVED_REFERENCE",
        message: "مرجع غير معروف",
      };
    },
    async store() {
      return { ok: true, reference: "fp:mock" };
    },
    async delete() {
      return { ok: true };
    },
  };

  // Track provider HTTP calls
  let providerCallCount = 0;
  const providerCalls: Array<{ url: string; body: any }> = [];

  const fakeFetchImpl = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    providerCallCount++;
    const urlStr = String(input);
    const bodyStr = typeof init?.body === "string" ? init.body : "{}";
    const body = JSON.parse(bodyStr);
    providerCalls.push({ url: urlStr, body });

    // Handle injected test behaviors based on body text
    if (body.text?.includes("FAIL_TIMEOUT")) {
      throw new Error("ETIMEDOUT: Connection timed out");
    }

    if (body.text?.includes("FAIL_500")) {
      return new Response(
        JSON.stringify({
          ok: false,
          error_code: 500,
          description: "Internal Server Error",
        }),
        { status: 500 },
      );
    }

    if (body.text?.includes("FAIL_403_BLOCKED")) {
      return new Response(
        JSON.stringify({
          ok: false,
          error_code: 403,
          description: "Forbidden: bot was blocked by the user",
        }),
        { status: 403 },
      );
    }

    // Default successful response
    return new Response(
      JSON.stringify({
        ok: true,
        result: {
          message_id: 1000 + providerCallCount,
          date: Math.floor(Date.now() / 1000),
          chat: { id: Number(body.chat_id) || 123 },
          text: body.text,
        },
      }),
      { status: 200 },
    );
  };

  const fakeApi = {
    fetchImpl: fakeFetchImpl as any,
    apiHost: "https://api.telegram.org",
    credentialsResolver: testCredentialsResolver,
  };

  try {
    // ── Setup: Create test businesses and users ──
    await db.business.create({
      data: {
        id: TEST_BUSINESS_ID,
        name: "مركز الفحص الآمن لتيليجرام",
        whatsappNumber: `+2010${Math.floor(10000000 + Math.random() * 90000000)}`,
      },
    });

    await db.branch.create({
      data: {
        id: DEFAULT_BRANCH_ID,
        businessId: TEST_BUSINESS_ID,
        name: "الفرع الرئيسي",
      },
    });

    await db.business.update({
      where: { id: TEST_BUSINESS_ID },
      data: { defaultBranchId: DEFAULT_BRANCH_ID },
    });

    await db.business.create({
      data: {
        id: FOREIGN_BUSINESS_ID,
        name: "منشأة أجنبية",
        whatsappNumber: `+2011${Math.floor(10000000 + Math.random() * 90000000)}`,
      },
    });

    await db.branch.create({
      data: {
        id: FOREIGN_BRANCH_ID,
        businessId: FOREIGN_BUSINESS_ID,
        name: "فرع أجنبي",
      },
    });

    await db.business.update({
      where: { id: FOREIGN_BUSINESS_ID },
      data: { defaultBranchId: FOREIGN_BRANCH_ID },
    });

    // Create staff users
    await db.user.create({
      data: {
        id: STAFF_USER_A_ID,
        businessId: TEST_BUSINESS_ID,
        email: `staff.a.${Date.now()}@example.com`,
        emailVerified: false,
        name: "موظف أ",
        role: "STAFF",
      },
    });

    await db.user.create({
      data: {
        id: STAFF_USER_B_ID,
        businessId: TEST_BUSINESS_ID,
        email: `staff.b.${Date.now()}@example.com`,
        emailVerified: false,
        name: "موظف ب",
        role: "STAFF",
      },
    });

    // Create active connected TelegramConnection for test business
    const connection = await db.telegramConnection.create({
      data: {
        businessId: TEST_BUSINESS_ID,
        branchId: DEFAULT_BRANCH_ID,
        displayName: "بوت العيادة",
        botExternalId: BOT_EXTERNAL_ID,
        botUsername: "test_clinic_bot",
        status: "CONNECTED",
        isActive: true,
        credentialsRef: "fp:test-telegram-token",
        credentialKind: "runtime_token",
        webhookSecretHash: hashTelegramWebhookSecret("secret_token_123"),
      },
    });

    // Create foreign TelegramConnection for foreign business
    const foreignConnection = await db.telegramConnection.create({
      data: {
        businessId: FOREIGN_BUSINESS_ID,
        branchId: FOREIGN_BRANCH_ID,
        displayName: "بوت أجنبي",
        botExternalId: FOREIGN_BOT_EXTERNAL_ID,
        botUsername: "foreign_bot",
        status: "CONNECTED",
        isActive: true,
        credentialsRef: "fp:foreign-telegram-token",
        credentialKind: "runtime_token",
        webhookSecretHash: hashTelegramWebhookSecret("foreign_secret_token"),
      },
    });

    // Create inactive connection
    const inactiveConnection = await db.telegramConnection.create({
      data: {
        businessId: TEST_BUSINESS_ID,
        branchId: DEFAULT_BRANCH_ID,
        displayName: "بوت معطل",
        botExternalId: `inactive_${Date.now()}`,
        status: "PENDING",
        isActive: false,
        credentialsRef: null,
      },
    });

    // ── Scenario 1: Authenticated Ingress -> Bound Route -> Accepted Reply ──
    console.log(
      "\n--- Scenario 1: Ingress -> Route Authority -> Accepted Reply ---",
    );
    const engineDeps = {
      businessRepository,
      branchRepository,
      customerRepository,
      conversationRepository,
      serviceRepository,
      inboundDedupeRepository,
      usageRepository,
      conversationStateRepository,
      transport: {
        providerName: "test-transport",
        async send() {
          return { provider: "test-transport", delivered: true };
        },
      },
      ai: {
        providerName: "mock-ai",
        respond: async () => ({
          action: "handoff",
          intent: "HUMAN_REQUEST",
          confidence: 1,
          extractedEntities: {},
          handoffReason: "HUMAN_REQUEST",
          summary: "طلب التحدث مع موظف",
          safetyAssessment: "safe",
        }),
      },
    } as unknown as Parameters<typeof receiveInboundMessage>[0];

    const ingressResult = await receiveInboundMessage(
      engineDeps,
      {
        to: BOT_EXTERNAL_ID,
        from: TELEGRAM_CHAT_ID,
        text: "مرحبا، أود الاستفسار",
        receivedAt: new Date().toISOString(),
        externalId: `tg:${BOT_EXTERNAL_ID}:update_1`,
      },
      {
        businessId: TEST_BUSINESS_ID,
        branchId: DEFAULT_BRANCH_ID,
        connectionId: connection.id,
      },
    );

    check(
      "1.1 Inbound Telegram message processed successfully",
      ingressResult.ok === true && !ingressResult.duplicate,
    );

    const conv1Id = ingressResult.ok ? ingressResult.conversationId : "";
    const boundRoute = await db.conversationDeliveryRoute.findUnique({
      where: { conversationId: conv1Id },
    });

    check(
      "1.2 Route bound correctly in DB with channel telegram, connectionId, botExternalId, and recipientExternalId",
      boundRoute !== null &&
        boundRoute.channel === "telegram" &&
        boundRoute.connectionId === connection.id &&
        boundRoute.botExternalId === BOT_EXTERNAL_ID &&
        boundRoute.recipientExternalId === TELEGRAM_CHAT_ID,
    );

    // Verify resolveConversationRoute succeeds
    const routeRes1 = await resolveConversationRoute(
      conv1Id,
      TEST_BUSINESS_ID,
      {
        credentialsResolver: testCredentialsResolver,
      },
    );
    check(
      "1.3 resolveConversationRoute returns routable: true",
      routeRes1.routable === true,
    );

    // Submit staff reply
    const initialCallCount = providerCallCount;
    const reply1Result = await submitStaffReply({
      businessId: TEST_BUSINESS_ID,
      conversationId: conv1Id,
      staffUserId: STAFF_USER_A_ID,
      content: "أهلاً بك! كيف نساعدك؟",
      clientSubmissionId: "sub_key_1",
      deps: {
        api: fakeApi,
        credentialsResolver: testCredentialsResolver,
      },
    });

    check(
      "1.4 submitStaffReply returns ok: true, outcome: accepted",
      reply1Result.ok === true && reply1Result.outcome === "accepted",
    );
    check(
      "1.5 Provider physical HTTP called exactly 1 time",
      providerCallCount === initialCallCount + 1,
    );
    check(
      "1.6 Provider call payload targets correct chatId and text",
      providerCalls[providerCalls.length - 1]?.body?.chat_id ===
        TELEGRAM_CHAT_ID &&
        providerCalls[providerCalls.length - 1]?.body?.text ===
          "أهلاً بك! كيف نساعدك؟",
    );

    // Verify database state
    const conv1After = await db.conversation.findUnique({
      where: { id: conv1Id },
      include: { messages: true, replySubmissions: true },
    });

    const staffMessage = conv1After?.messages.find(
      (m) => m.senderType === "STAFF",
    );
    check(
      "1.7 Staff message persisted in conversation messages",
      staffMessage !== undefined &&
        staffMessage.content === "أهلاً بك! كيف نساعدك؟",
    );
    check(
      "1.8 Conversation assigned to staff user A",
      conv1After?.assignedUserId === STAFF_USER_A_ID,
    );
    check(
      "1.9 Conversation status set to NEED_HUMAN",
      conv1After?.status === "NEED_HUMAN",
    );

    const sub1 = conv1After?.replySubmissions.find(
      (s) => s.submissionKey === "sub_key_1",
    );
    check(
      "1.10 StaffReplySubmission row has status ACCEPTED and providerMessageId",
      sub1?.status === "ACCEPTED" &&
        typeof sub1?.providerMessageId === "string" &&
        sub1.providerMessageId.length > 0,
    );

    // ── Scenario 2: Ambiguous or Missing Route ──
    console.log("\n--- Scenario 2: Ambiguous or Missing Route ---");

    // 2a: Missing route (thread created without ingress/route)
    const customer2 = await db.customer.create({
      data: {
        businessId: TEST_BUSINESS_ID,
        name: "عميل بدون مسار",
        phone: "+201099999999",
      },
    });

    const convMissingRoute = await db.conversation.create({
      data: {
        businessId: TEST_BUSINESS_ID,
        customerId: customer2.id,
        branchId: DEFAULT_BRANCH_ID,
        status: "NEED_HUMAN",
      },
    });

    const callsBeforeMissing = providerCallCount;
    const missingRes = await submitStaffReply({
      businessId: TEST_BUSINESS_ID,
      conversationId: convMissingRoute.id,
      staffUserId: STAFF_USER_A_ID,
      content: "رد على محادثة مجهولة المسار",
      deps: { api: fakeApi, credentialsResolver: testCredentialsResolver },
    });

    check(
      "2.1 Missing route returns outcome: unroutable",
      missingRes.ok === false && missingRes.outcome === "unroutable",
    );
    check(
      "2.2 Zero network calls issued for missing route",
      providerCallCount === callsBeforeMissing,
    );

    // 2b: Ambiguous route with conflicting Telegram bots
    const convConflictingBot = await db.conversation.create({
      data: {
        businessId: TEST_BUSINESS_ID,
        customerId: customer2.id,
        branchId: DEFAULT_BRANCH_ID,
        status: "NEED_HUMAN",
      },
    });

    // Create a delivery route
    await db.conversationDeliveryRoute.create({
      data: {
        businessId: TEST_BUSINESS_ID,
        conversationId: convConflictingBot.id,
        channel: "telegram",
        connectionId: connection.id,
        botExternalId: BOT_EXTERNAL_ID,
        recipientExternalId: TELEGRAM_CHAT_ID,
      },
    });

    // Insert dedupe rows from DIFFERENT bot
    await db.inboundMessageDedupe.create({
      data: {
        businessId: TEST_BUSINESS_ID,
        conversationId: convConflictingBot.id,
        externalKey: `tg:different_bot_id:update_99`,
        customerMessageId: "msg_conflict_1",
      },
    });

    const callsBeforeConflictBot = providerCallCount;
    const conflictBotRes = await submitStaffReply({
      businessId: TEST_BUSINESS_ID,
      conversationId: convConflictingBot.id,
      staffUserId: STAFF_USER_A_ID,
      content: "رد على محادثة متعارضة البوتات",
      deps: { api: fakeApi, credentialsResolver: testCredentialsResolver },
    });

    check(
      "2.3 Conflicting bot dedupe evidence returns outcome: unroutable",
      conflictBotRes.ok === false && conflictBotRes.outcome === "unroutable",
    );
    check(
      "2.4 Zero network calls issued for conflicting bots",
      providerCallCount === callsBeforeConflictBot,
    );

    // 2c: Ambiguous route with conflicting channels (WhatsApp + Telegram)
    const convConflictingChannel = await db.conversation.create({
      data: {
        businessId: TEST_BUSINESS_ID,
        customerId: customer2.id,
        branchId: DEFAULT_BRANCH_ID,
        status: "NEED_HUMAN",
      },
    });

    await db.conversationDeliveryRoute.create({
      data: {
        businessId: TEST_BUSINESS_ID,
        conversationId: convConflictingChannel.id,
        channel: "telegram",
        connectionId: connection.id,
        botExternalId: BOT_EXTERNAL_ID,
        recipientExternalId: TELEGRAM_CHAT_ID,
      },
    });

    // Insert WhatsApp wamid dedupe row
    await db.inboundMessageDedupe.create({
      data: {
        businessId: TEST_BUSINESS_ID,
        conversationId: convConflictingChannel.id,
        externalKey: "wamid.HBgLMjAxMTAwMTIzNDU2FQIAEhggM0Y",
        customerMessageId: "msg_conflict_wa",
      },
    });

    const callsBeforeConflictChannel = providerCallCount;
    const conflictChannelRes = await submitStaffReply({
      businessId: TEST_BUSINESS_ID,
      conversationId: convConflictingChannel.id,
      staffUserId: STAFF_USER_A_ID,
      content: "رد على محادثة متعددة القنوات",
      deps: { api: fakeApi, credentialsResolver: testCredentialsResolver },
    });

    check(
      "2.5 Conflicting channel dedupe evidence returns outcome: unroutable",
      conflictChannelRes.ok === false &&
        conflictChannelRes.outcome === "unroutable",
    );
    check(
      "2.6 Zero network calls issued for conflicting channels",
      providerCallCount === callsBeforeConflictChannel,
    );

    // ── Scenario 3: Foreign / Inactive Connection ──
    console.log("\n--- Scenario 3: Foreign / Inactive Connection ---");

    // 3a: Foreign connection (pointing to another business's connection)
    const convForeignConn = await db.conversation.create({
      data: {
        businessId: TEST_BUSINESS_ID,
        customerId: customer2.id,
        branchId: DEFAULT_BRANCH_ID,
        status: "NEED_HUMAN",
      },
    });

    await db.conversationDeliveryRoute.create({
      data: {
        businessId: TEST_BUSINESS_ID,
        conversationId: convForeignConn.id,
        channel: "telegram",
        connectionId: foreignConnection.id, // Foreign!
        botExternalId: FOREIGN_BOT_EXTERNAL_ID,
        recipientExternalId: TELEGRAM_CHAT_ID,
      },
    });

    const callsBeforeForeign = providerCallCount;
    const foreignRes = await submitStaffReply({
      businessId: TEST_BUSINESS_ID,
      conversationId: convForeignConn.id,
      staffUserId: STAFF_USER_A_ID,
      content: "رد عبر اتصال أجنبي",
      deps: { api: fakeApi, credentialsResolver: testCredentialsResolver },
    });

    check(
      "3.1 Foreign connection returns outcome: unroutable",
      foreignRes.ok === false && foreignRes.outcome === "unroutable",
    );
    check(
      "3.2 Zero network calls issued for foreign connection",
      providerCallCount === callsBeforeForeign,
    );

    // 3b: Inactive connection
    const convInactiveConn = await db.conversation.create({
      data: {
        businessId: TEST_BUSINESS_ID,
        customerId: customer2.id,
        branchId: DEFAULT_BRANCH_ID,
        status: "NEED_HUMAN",
      },
    });

    await db.conversationDeliveryRoute.create({
      data: {
        businessId: TEST_BUSINESS_ID,
        conversationId: convInactiveConn.id,
        channel: "telegram",
        connectionId: inactiveConnection.id, // Inactive!
        botExternalId: inactiveConnection.botExternalId,
        recipientExternalId: TELEGRAM_CHAT_ID,
      },
    });

    const callsBeforeInactive = providerCallCount;
    const inactiveRes = await submitStaffReply({
      businessId: TEST_BUSINESS_ID,
      conversationId: convInactiveConn.id,
      staffUserId: STAFF_USER_A_ID,
      content: "رد عبر اتصال غير مفعّل",
      deps: { api: fakeApi, credentialsResolver: testCredentialsResolver },
    });

    check(
      "3.3 Inactive connection returns outcome: unroutable",
      inactiveRes.ok === false && inactiveRes.outcome === "unroutable",
    );
    check(
      "3.4 Zero network calls issued for inactive connection",
      providerCallCount === callsBeforeInactive,
    );

    // ── Scenario 4: Duplicate Submissions (Reconciliation & Idempotency) ──
    console.log("\n--- Scenario 4: Duplicate Submissions ---");
    const callsBeforeDup = providerCallCount;

    // Resubmit sub_key_1 with same payload on conv1
    const dupRes = await submitStaffReply({
      businessId: TEST_BUSINESS_ID,
      conversationId: conv1Id,
      staffUserId: STAFF_USER_A_ID,
      content: "أهلاً بك! كيف نساعدك؟",
      clientSubmissionId: "sub_key_1",
      deps: { api: fakeApi, credentialsResolver: testCredentialsResolver },
    });

    check(
      "4.1 Duplicate submission returns outcome: accepted",
      dupRes.ok === true && dupRes.outcome === "accepted",
    );
    check(
      "4.2 Zero additional network calls made for duplicate submission",
      providerCallCount === callsBeforeDup,
    );

    // Concurrent in-progress duplicate check:
    // Create pre-existing CLAIMED row
    const inProgText = "رسالة قيد الإرسال";
    const inProgHash = createHash("sha256").update(inProgText).digest("hex");
    await db.staffReplySubmission.create({
      data: {
        businessId: TEST_BUSINESS_ID,
        conversationId: conv1Id,
        submissionKey: "sub_in_prog_key",
        payloadHash: inProgHash,
        content: inProgText,
        status: "CLAIMED",
        provider: "telegram",
      },
    });

    const callsBeforeInProg = providerCallCount;
    const inProgRes = await submitStaffReply({
      businessId: TEST_BUSINESS_ID,
      conversationId: conv1Id,
      staffUserId: STAFF_USER_A_ID,
      content: "رسالة قيد الإرسال",
      clientSubmissionId: "sub_in_prog_key",
      deps: { api: fakeApi, credentialsResolver: testCredentialsResolver },
    });

    check(
      "4.3 Concurrent submission with status CLAIMED returns outcome: in-progress",
      inProgRes.ok === false && inProgRes.outcome === "in-progress",
    );
    check(
      "4.4 Zero network calls made for in-progress concurrent submission",
      providerCallCount === callsBeforeInProg,
    );

    // ── Scenario 5: Same Key with Different Payload ──
    console.log("\n--- Scenario 5: Same Key with Different Payload ---");
    const callsBeforePayloadDiff = providerCallCount;

    const diffPayloadRes = await submitStaffReply({
      businessId: TEST_BUSINESS_ID,
      conversationId: conv1Id,
      staffUserId: STAFF_USER_A_ID,
      content: "نص مختلف تماماً لنفس المعرّف",
      clientSubmissionId: "sub_key_1", // Reusing sub_key_1 with different payload!
      deps: { api: fakeApi, credentialsResolver: testCredentialsResolver },
    });

    check(
      "5.1 Reused key with different payload returns outcome: definite_rejection",
      diffPayloadRes.ok === false &&
        diffPayloadRes.outcome === "definite_rejection",
    );
    check(
      "5.2 Error code indicates PAYLOAD_MISMATCH",
      (diffPayloadRes as any).code === "PAYLOAD_MISMATCH",
    );
    check(
      "5.3 Zero network calls issued on payload mismatch",
      providerCallCount === callsBeforePayloadDiff,
    );

    // ── Scenario 6: Provider Timeout (Transient Failure / Unknown Outcome) ──
    console.log("\n--- Scenario 6: Provider Timeout ---");
    const callsBeforeTimeout = providerCallCount;

    const timeoutRes = await submitStaffReply({
      businessId: TEST_BUSINESS_ID,
      conversationId: conv1Id,
      staffUserId: STAFF_USER_A_ID,
      content: "رسالة ستفشل بالمهلة FAIL_TIMEOUT",
      clientSubmissionId: "sub_timeout_key",
      deps: { api: fakeApi, credentialsResolver: testCredentialsResolver },
    });

    check(
      "6.1 Provider timeout returns outcome: unknown",
      timeoutRes.ok === false && timeoutRes.outcome === "unknown",
    );
    check(
      "6.2 Exactly 1 wire attempt made before timeout",
      providerCallCount === callsBeforeTimeout + 1,
    );

    const timeoutSub = await db.staffReplySubmission.findUnique({
      where: {
        businessId_conversationId_submissionKey: {
          businessId: TEST_BUSINESS_ID,
          conversationId: conv1Id,
          submissionKey: "sub_timeout_key",
        },
      },
    });

    check(
      "6.3 Submission persisted with status UNCONFIRMED in DB",
      timeoutSub?.status === "UNCONFIRMED",
    );

    // Replaying the unconfirmed submission must NOT auto-resend
    const callsBeforeReplay = providerCallCount;
    const replayTimeoutRes = await submitStaffReply({
      businessId: TEST_BUSINESS_ID,
      conversationId: conv1Id,
      staffUserId: STAFF_USER_A_ID,
      content: "رسالة ستفشل بالمهلة FAIL_TIMEOUT",
      clientSubmissionId: "sub_timeout_key",
      deps: { api: fakeApi, credentialsResolver: testCredentialsResolver },
    });

    check(
      "6.4 Replaying unconfirmed submission returns outcome: unknown without resending",
      replayTimeoutRes.ok === false && replayTimeoutRes.outcome === "unknown",
    );
    check(
      "6.5 Zero network calls issued on replaying unconfirmed submission",
      providerCallCount === callsBeforeReplay,
    );

    // ── Scenario 7: Acceptance followed by Result Write Failure ──
    console.log(
      "\n--- Scenario 7: Acceptance Followed by Result Write Failure ---",
    );
    const callsBeforeWriteFail = providerCallCount;

    const writeFailRes = await submitStaffReply({
      businessId: TEST_BUSINESS_ID,
      conversationId: conv1Id,
      staffUserId: STAFF_USER_A_ID,
      content: "رسالة مقبولة ولكن كتابة النتيجة ستفشل",
      clientSubmissionId: "sub_write_fail_key",
      deps: {
        api: fakeApi,
        credentialsResolver: testCredentialsResolver,
        onBeforeResultWrite: async () => {
          throw new Error("SIMULATED_DATABASE_DISCONNECT");
        },
      },
    });

    check(
      "7.1 Write failure after provider acceptance returns outcome: unknown",
      writeFailRes.ok === false && writeFailRes.outcome === "unknown",
    );
    check(
      "7.2 Exactly 1 provider attempt made before write failure",
      providerCallCount === callsBeforeWriteFail + 1,
    );

    const writeFailSub = await db.staffReplySubmission.findUnique({
      where: {
        businessId_conversationId_submissionKey: {
          businessId: TEST_BUSINESS_ID,
          conversationId: conv1Id,
          submissionKey: "sub_write_fail_key",
        },
      },
    });

    check(
      "7.3 Submission persisted as UNCONFIRMED with providerMessageId preserved",
      writeFailSub?.status === "UNCONFIRMED" &&
        typeof writeFailSub?.providerMessageId === "string",
    );

    // ── Scenario 8: Staff Ownership Preservation ──
    console.log("\n--- Scenario 8: Staff Ownership Preservation ---");

    // Assign conv1 explicitly to Staff User B
    await db.conversation.update({
      where: { id: conv1Id },
      data: { assignedUserId: STAFF_USER_B_ID },
    });

    const callsBeforeOwnerTest = providerCallCount;
    // Staff User A sends a reply to this thread already owned by User B
    const ownerReplyRes = await submitStaffReply({
      businessId: TEST_BUSINESS_ID,
      conversationId: conv1Id,
      staffUserId: STAFF_USER_A_ID, // User A replies
      content: "رد موظف أ على محادثة يملكها موظف ب",
      clientSubmissionId: "sub_ownership_preserve_key",
      deps: { api: fakeApi, credentialsResolver: testCredentialsResolver },
    });

    check(
      "8.1 Reply submitted successfully",
      ownerReplyRes.ok === true && ownerReplyRes.outcome === "accepted",
    );
    check(
      "8.2 Network call count advanced by exactly 1",
      providerCallCount === callsBeforeOwnerTest + 1,
    );

    const convAfterOwnerReply = await db.conversation.findUnique({
      where: { id: conv1Id },
      select: { assignedUserId: true },
    });

    check(
      "8.3 Staff User B remains the assignee — thread was NOT silently stolen by User A",
      convAfterOwnerReply?.assignedUserId === STAFF_USER_B_ID,
    );

    // ── Scenario 9: Definite Rejection (403 Forbidden) ──
    console.log("\n--- Scenario 9: Definite Rejection (403) ---");
    const callsBefore403 = providerCallCount;

    const rejectionRes = await submitStaffReply({
      businessId: TEST_BUSINESS_ID,
      conversationId: conv1Id,
      staffUserId: STAFF_USER_A_ID,
      content: "رسالة محظورة FAIL_403_BLOCKED",
      clientSubmissionId: "sub_403_key",
      deps: { api: fakeApi, credentialsResolver: testCredentialsResolver },
    });

    check(
      "9.1 Permanent rejection returns outcome: definite_rejection",
      rejectionRes.ok === false &&
        rejectionRes.outcome === "definite_rejection",
    );
    check(
      "9.2 Provider called exactly 1 time before 403",
      providerCallCount === callsBefore403 + 1,
    );

    const rejectedSub = await db.staffReplySubmission.findUnique({
      where: {
        businessId_conversationId_submissionKey: {
          businessId: TEST_BUSINESS_ID,
          conversationId: conv1Id,
          submissionKey: "sub_403_key",
        },
      },
    });

    check(
      "9.3 Submission status is REJECTED in DB",
      rejectedSub?.status === "REJECTED",
    );

    // ── Scenario 10: Disposable-Postgres Race (Two Requests Starting Before Claim Exists) ──
    console.log("\n--- Scenario 10: Disposable-Postgres Concurrent Race ---");
    const raceSubmissionKey = "sub_race_" + randomUUID();
    const raceContent = "رسالة سباق التزامن المتوازي الفريدة";
    const callsBeforeRace = providerCallCount;
    const staffMessagesBeforeRace = await db.message.count({
      where: {
        conversationId: conv1Id,
        senderType: "STAFF",
        content: raceContent,
      },
    });

    // Controlled fake provider with a brief 50ms wire delay ensuring
    // Request 1 is actively in-flight with provider when Request 2 attempts claim
    const controlledFakeApi = {
      fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
        await new Promise((r) => setTimeout(r, 50));
        return fakeFetchImpl(input, init);
      },
      apiHost: fakeApi.apiHost,
      credentialsResolver: testCredentialsResolver,
    };

    // Both requests start concurrently before either claim exists in DB
    const [raceRes1, raceRes2] = await Promise.all([
      submitStaffReply({
        businessId: TEST_BUSINESS_ID,
        conversationId: conv1Id,
        staffUserId: STAFF_USER_A_ID,
        content: raceContent,
        clientSubmissionId: raceSubmissionKey,
        deps: {
          api: controlledFakeApi,
          credentialsResolver: testCredentialsResolver,
        },
      }),
      submitStaffReply({
        businessId: TEST_BUSINESS_ID,
        conversationId: conv1Id,
        staffUserId: STAFF_USER_A_ID,
        content: raceContent,
        clientSubmissionId: raceSubmissionKey,
        deps: {
          api: controlledFakeApi,
          credentialsResolver: testCredentialsResolver,
        },
      }),
    ]);

    const callsAfterRace = providerCallCount;
    const raceCallsIssued = callsAfterRace - callsBeforeRace;

    check(
      "10.1 Exactly one provider network call made across concurrent race",
      raceCallsIssued === 1,
      { raceCallsIssued },
    );

    const staffMessagesAfterRace = await db.message.count({
      where: {
        conversationId: conv1Id,
        senderType: "STAFF",
        content: raceContent,
      },
    });
    const newStaffRows = staffMessagesAfterRace - staffMessagesBeforeRace;

    check(
      "10.2 At most one (exactly 1) accepted STAFF row created in database",
      newStaffRows === 1,
      { newStaffRows },
    );

    const raceOutcomes = [raceRes1.outcome, raceRes2.outcome];
    check(
      "10.3 One request accepted and concurrent request handled safely without duplicate send",
      raceOutcomes.includes("accepted"),
      { raceRes1, raceRes2 },
    );

    // ────────────────────────────────────────────────────────────────
    // Scenario 11: Read-Only Recheck with Missing Claim (Zero DB Writes & Zero Provider Calls)
    // ────────────────────────────────────────────────────────────────
    console.log(
      "\n▶ Scenario 11: Read-Only Recheck with Missing Claim (0 DB writes, 0 provider calls)",
    );

    const submissionsCountBefore11 = await db.staffReplySubmission.count();
    const messagesCountBefore11 = await db.message.count();
    const convBefore11 = await db.conversation.findUnique({
      where: { id: conv1Id },
      select: { status: true, assignedUserId: true, lastMessageAt: true },
    });
    const fakeApiCallsBefore11 = providerCallCount;

    const missingKey = "missing-attempt-" + randomUUID();
    const missingLookupResult = await lookupStaffReplyStatus({
      businessId: TEST_BUSINESS_ID,
      conversationId: conv1Id,
      clientSubmissionId: missingKey,
    });

    check(
      "11.1 Missing claim returns found: false and NO_CLAIM_FOUND",
      !missingLookupResult.found &&
        missingLookupResult.code === "NO_CLAIM_FOUND",
      missingLookupResult,
    );

    const submissionsCountAfter11 = await db.staffReplySubmission.count();
    const messagesCountAfter11 = await db.message.count();
    const convAfter11 = await db.conversation.findUnique({
      where: { id: conv1Id },
      select: { status: true, assignedUserId: true, lastMessageAt: true },
    });
    const fakeApiCallsAfter11 = providerCallCount;

    check(
      "11.2 Recheck missing claim performs ZERO provider calls",
      fakeApiCallsAfter11 === fakeApiCallsBefore11,
      { before: fakeApiCallsBefore11, after: fakeApiCallsAfter11 },
    );

    check(
      "11.3 Recheck missing claim performs ZERO DB writes to submissions, messages, or conversation",
      submissionsCountAfter11 === submissionsCountBefore11 &&
        messagesCountAfter11 === messagesCountBefore11 &&
        convAfter11?.status === convBefore11?.status &&
        convAfter11?.assignedUserId === convBefore11?.assignedUserId,
      {
        submissionsDiff: submissionsCountAfter11 - submissionsCountBefore11,
        messagesDiff: messagesCountAfter11 - messagesCountBefore11,
      },
    );

    // ────────────────────────────────────────────────────────────────
    // Scenario 12: Read-Only Recheck of Active, Stale, and Accepted Claims (Bounded Window & Tenant Isolation)
    // ────────────────────────────────────────────────────────────────
    console.log(
      "\n▶ Scenario 12: Read-Only Recheck of Active, Stale, and Accepted Claims",
    );

    const fixedNow = new Date("2026-11-09T14:00:00.000Z");

    // 1. Active claim within window (<60s)
    const activeKey = "active-attempt-" + randomUUID();
    await db.staffReplySubmission.create({
      data: {
        businessId: TEST_BUSINESS_ID,
        conversationId: conv1Id,
        submissionKey: activeKey,
        payloadHash: createHash("sha256").update("active text").digest("hex"),
        content: "active text",
        status: "CLAIMED",
        provider: "telegram",
        claimedAt: new Date(fixedNow.getTime() - 15_000), // 15s ago
      },
    });

    const activeLookup = await lookupStaffReplyStatus({
      businessId: TEST_BUSINESS_ID,
      conversationId: conv1Id,
      clientSubmissionId: activeKey,
      deps: { now: () => fixedNow },
    });

    check(
      "12.1 Active claim (<60s) evaluated as in-progress",
      activeLookup.found && activeLookup.status === "in-progress",
      activeLookup,
    );

    // 2. Stale/aged claim (>60s)
    const staleKey = "stale-attempt-" + randomUUID();
    await db.staffReplySubmission.create({
      data: {
        businessId: TEST_BUSINESS_ID,
        conversationId: conv1Id,
        submissionKey: staleKey,
        payloadHash: createHash("sha256").update("stale text").digest("hex"),
        content: "stale text",
        status: "CLAIMED",
        provider: "telegram",
        claimedAt: new Date(fixedNow.getTime() - 75_000), // 75s ago
      },
    });

    const staleLookup = await lookupStaffReplyStatus({
      businessId: TEST_BUSINESS_ID,
      conversationId: conv1Id,
      clientSubmissionId: staleKey,
      deps: { now: () => fixedNow },
    });

    check(
      "12.2 Stale claim (>60s) evaluated as unknown (ABANDONED_CLAIM) without allowing redispatch",
      staleLookup.found &&
        staleLookup.status === "unknown" &&
        staleLookup.code === "ABANDONED_CLAIM",
      staleLookup,
    );

    // 3. Accepted claim
    const acceptedKey = "accepted-attempt-" + randomUUID();
    await db.staffReplySubmission.create({
      data: {
        businessId: TEST_BUSINESS_ID,
        conversationId: conv1Id,
        submissionKey: acceptedKey,
        payloadHash: createHash("sha256").update("accepted text").digest("hex"),
        content: "accepted text",
        status: "ACCEPTED",
        provider: "telegram",
        providerMessageId: "tg-msg-accepted-12345",
        completedAt: fixedNow,
      },
    });

    const acceptedLookup = await lookupStaffReplyStatus({
      businessId: TEST_BUSINESS_ID,
      conversationId: conv1Id,
      clientSubmissionId: acceptedKey,
      deps: { now: () => fixedNow },
    });

    check(
      "12.3 Accepted claim evaluated as accepted with messageId",
      acceptedLookup.found &&
        acceptedLookup.status === "accepted" &&
        acceptedLookup.messageId === "tg-msg-accepted-12345",
      acceptedLookup,
    );

    // 4. Tenant isolation: foreign business cannot find accepted claim
    const foreignLookup = await lookupStaffReplyStatus({
      businessId: FOREIGN_BUSINESS_ID,
      conversationId: conv1Id,
      clientSubmissionId: acceptedKey,
      deps: { now: () => fixedNow },
    });

    check(
      "12.4 Tenant isolation: lookup with foreign businessId fails closed (NO_CLAIM_FOUND)",
      !foreignLookup.found && foreignLookup.code === "NO_CLAIM_FOUND",
      foreignLookup,
    );

    // Assert zero provider network calls during all status lookups
    const fakeApiFinal = providerCallCount;
    check(
      "12.5 Zero provider network calls issued during all status reconciliations",
      fakeApiFinal === fakeApiCallsAfter11,
      { before: fakeApiCallsAfter11, final: fakeApiFinal },
    );

    // ── Scenario 13: Controlled PostgreSQL Assignment Race ──
    console.log("\n--- Scenario 13: Controlled PostgreSQL Assignment Race ---");

    // 1. Reset conv1 to unassigned (assignedUserId: null)
    await db.conversation.update({
      where: { id: conv1Id },
      data: { assignedUserId: null },
    });

    const callsBeforeRace13 = providerCallCount;
    const race13Key = "sub_race_assignment_" + randomUUID();

    // 2. Staff User A submits reply. In onBeforeResultWrite hook (after provider accepts, right before write),
    // Staff User B concurrently assigns the conversation.
    const race13Res = await submitStaffReply({
      businessId: TEST_BUSINESS_ID,
      conversationId: conv1Id,
      staffUserId: STAFF_USER_A_ID,
      content: "رسالة موظف أ أثناء سباق التعيين",
      clientSubmissionId: race13Key,
      deps: {
        api: fakeApi,
        credentialsResolver: testCredentialsResolver,
        onBeforeResultWrite: async () => {
          // Concurrent assignment occurs right before accepted-write transaction
          await db.conversation.update({
            where: { id: conv1Id },
            data: { assignedUserId: STAFF_USER_B_ID },
          });
        },
      },
    });

    check(
      "13.1 Reply submitted and accepted by provider",
      race13Res.ok === true && race13Res.outcome === "accepted",
      race13Res,
    );

    check(
      "13.2 Network call count advanced by exactly 1",
      providerCallCount === callsBeforeRace13 + 1,
      { before: callsBeforeRace13, after: providerCallCount },
    );

    const convAfterRace13 = await db.conversation.findUnique({
      where: { id: conv1Id },
      select: { assignedUserId: true },
    });

    check(
      "13.3 Concurrent assignment to Staff User B is preserved (NOT overwritten by User A)",
      convAfterRace13?.assignedUserId === STAFF_USER_B_ID,
      convAfterRace13,
    );

    const messages13 = await db.message.findMany({
      where: {
        conversationId: conv1Id,
        content: "رسالة موظف أ أثناء سباق التعيين",
      },
    });

    check(
      "13.4 Exactly one STAFF message row exists in DB",
      messages13.length === 1 && messages13[0]?.senderType === "STAFF",
      messages13,
    );

    const sub13 = await db.staffReplySubmission.findUnique({
      where: {
        businessId_conversationId_submissionKey: {
          businessId: TEST_BUSINESS_ID,
          conversationId: conv1Id,
          submissionKey: race13Key,
        },
      },
    });

    check(
      "13.5 Submission record persisted as ACCEPTED with providerMessageId",
      sub13?.status === "ACCEPTED" &&
        typeof sub13?.providerMessageId === "string",
      sub13,
    );
  } finally {
    // Cleanup test data
    console.log("\nCleaning up test data...");
    await db.staffReplySubmission.deleteMany({
      where: { businessId: { in: [TEST_BUSINESS_ID, FOREIGN_BUSINESS_ID] } },
    });
    await db.conversationDeliveryRoute.deleteMany({
      where: { businessId: { in: [TEST_BUSINESS_ID, FOREIGN_BUSINESS_ID] } },
    });
    await db.inboundMessageDedupe.deleteMany({
      where: { businessId: { in: [TEST_BUSINESS_ID, FOREIGN_BUSINESS_ID] } },
    });
    await db.message.deleteMany({
      where: {
        conversation: {
          businessId: { in: [TEST_BUSINESS_ID, FOREIGN_BUSINESS_ID] },
        },
      },
    });
    await db.conversation.deleteMany({
      where: { businessId: { in: [TEST_BUSINESS_ID, FOREIGN_BUSINESS_ID] } },
    });
    await db.customer.deleteMany({
      where: { businessId: { in: [TEST_BUSINESS_ID, FOREIGN_BUSINESS_ID] } },
    });
    await db.telegramConnection.deleteMany({
      where: { businessId: { in: [TEST_BUSINESS_ID, FOREIGN_BUSINESS_ID] } },
    });
    await db.business.updateMany({
      where: { id: { in: [TEST_BUSINESS_ID, FOREIGN_BUSINESS_ID] } },
      data: { defaultBranchId: null },
    });
    await db.branch.deleteMany({
      where: { businessId: { in: [TEST_BUSINESS_ID, FOREIGN_BUSINESS_ID] } },
    });
    await db.user.deleteMany({
      where: { id: { in: [STAFF_USER_A_ID, STAFF_USER_B_ID] } },
    });
    await db.business.deleteMany({
      where: { id: { in: [TEST_BUSINESS_ID, FOREIGN_BUSINESS_ID] } },
    });
  }

  const failed = checks.filter((c) => !c.pass);
  console.log(
    "\n────────────────────────────────────────────────────────────────",
  );
  console.log(
    `Results: ${checks.length - failed.length}/${checks.length} passed.`,
  );
  if (failed.length > 0) {
    console.error(`FAILED: ${failed.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(
    "All ISS-018 Safe Telegram Staff Reply Delivery integration checks passed successfully.",
  );
}

main().catch((err) => {
  console.error("FATAL in DB integration check:", err);
  process.exit(1);
});
