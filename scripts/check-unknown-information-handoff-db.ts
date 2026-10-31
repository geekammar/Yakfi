/* eslint-disable @typescript-eslint/no-explicit-any */
import "./setup-test-env";

/**
 * FlowPilot — Truthful Unknown-Information Replies & Handoff Real-DB Integration Check (ISS-012).
 *
 * Verifies durable database state transitions and persistence invariants
 * against a disposable/local PostgreSQL database in GitHub Actions CI:
 *
 * DB-1: Unbacked Unknown Fact Turn (False Handoff Prevention):
 *       Model produces action=reply with unknown fact and false handoff prose.
 *       The engine rejects the unbacked reply, writes status NEED_HUMAN,
 *       creates exactly one operator_attention record with reason POLICY_REFUSED,
 *       and persists canonical SAFE_HANDOFF_REPLIES.DISCLOSURE_REFUSED in DB.
 *
 * DB-2: Explicit NO_KNOWLEDGE Handoff Turn:
 *       Model recognizes gap and produces action=handoff / NO_KNOWLEDGE.
 *       Engine writes status NEED_HUMAN, creates operator_attention record
 *       with reason NO_KNOWLEDGE, and persists canonical truthful copy.
 *
 * DB-3: Staff Ownership Preservation in DB:
 *       Conversation marked NEED_HUMAN with assigned staff user.
 *       Inbound customer message preserves status and assignment in DB;
 *       AI does not intervene or overwrite conversation state.
 *
 * DB-4: Persistence Failure Boundary:
 *       Injected repository failure does not corrupt the database or report
 *       false success.
 *
 * Run:
 *   DATABASE_URL='postgresql://postgres:password@localhost:5432/flowpilot_test' \
 *     pnpm check:unknown-information-handoff-db
 */

import {
  SAFE_HANDOFF_REPLIES,
  resolveHandoffActionReply,
} from "@/features/conversations/server/conversation-ai";
import { receiveInboundMessage } from "@/features/conversations/server/conversation-engine";
import type { MessageTransport } from "@/features/conversations/server/conversation-transport";
import { db } from "@/server/db";
import {
  appointmentRepository,
  branchRepository,
  businessRepository,
  conversationRepository,
  conversationStateRepository,
  customerRepository,
  inboundDedupeRepository,
  knowledgeGapRepository,
  operatorAttentionRepository,
  providerRepository,
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

const RUN_ID = `truth-db-${Date.now()}`;
const TEST_OPERATOR_ID = `op-${RUN_ID}`;
const TEST_BUSINESS_ID = `biz-${RUN_ID}`;
const TEST_BUSINESS_NAME = "مركز الأمل التخصصي لطب الأسنان";
const TEST_PHONE = `+2010${Math.floor(10000000 + Math.random() * 90000000)}`;
const CUSTOMER_PHONE = `+2011${Math.floor(10000000 + Math.random() * 90000000)}`;

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
    "▶ Running ISS-012 Real-DB Integration Check (Disposable PostgreSQL)...",
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

  const sentMessages: string[] = [];
  const testTransport: MessageTransport = {
    providerName: "offline-db-test-transport",
    async send(msg) {
      sentMessages.push(msg.content);
      return { provider: "offline-db-test-transport", delivered: true };
    },
  };

  // ── Setup test database records ───────────────────────────────────────────
  await db.user.create({
    data: {
      id: TEST_OPERATOR_ID,
      email: `${TEST_OPERATOR_ID}@flowpilot.invalid`,
      emailVerified: false,
      accountType: "PLATFORM",
      name: "Test Operator",
    },
  });

  await db.business.create({
    data: {
      id: TEST_BUSINESS_ID,
      name: TEST_BUSINESS_NAME,
      whatsappNumber: TEST_PHONE,
      isActive: true,
      timezone: "Africa/Cairo",
    },
  });

  const branchId = `${TEST_BUSINESS_ID}-branch`;
  await db.branch.create({
    data: {
      id: branchId,
      businessId: TEST_BUSINESS_ID,
      name: "الفرع الرئيسي",
      isActive: true,
    },
  });

  await db.business.update({
    where: { id: TEST_BUSINESS_ID },
    data: { defaultBranchId: branchId },
  });

  const service1Id = `${TEST_BUSINESS_ID}-svc-1`;
  await db.service.create({
    data: {
      id: service1Id,
      businessId: TEST_BUSINESS_ID,
      name: "تنظيف أسنان",
      description: "إزالة الجير والتلميع",
      durationMinutes: 30,
      priceType: "FIXED",
      priceAmount: 400,
      priceCurrency: "EGP",
      isActive: true,
    },
  });

  // Base engine deps with real DB repositories
  const baseDeps = {
    businessRepository,
    branchRepository,
    customerRepository,
    conversationRepository,
    serviceRepository,
    inboundDedupeRepository,
    conversationStateRepository,
    attentionRepository: operatorAttentionRepository,
    appointmentRepository,
    providerRepository,
    usageRepository,
    knowledgeGapRepository,
    transport: testTransport,
  };

  // ── DB-1: Unbacked Unknown Fact Turn (False Handoff Prevention) ───────────
  {
    const customer = await customerRepository.upsertByPhone({
      businessId: TEST_BUSINESS_ID,
      phone: CUSTOMER_PHONE,
      name: "عميل تجريبي 1",
    });

    const conversation = await conversationRepository.create({
      businessId: TEST_BUSINESS_ID,
      customerId: customer.id,
      channel: "WHATSAPP",
      status: "AI_ACTIVE",
    });

    let mockModelInvoked = false;
    const deps = {
      ...baseDeps,
      ai: {
        providerName: "mock-db-ai",
        respond: async () => {
          mockModelInvoked = true;
          return {
            intent: "FAQ",
            action: "reply",
            content: "العيادة لا تملك معلومة عن سنة التأسيس، هحوّلك لواحد من الفريق.",
            extraction: {
              service: null,
              provider: null,
              date: null,
              timePreference: null,
            },
            handoffReason: null,
            summary: null,
            safetyAssessment: "safe",
          };
        },
      },
    } as unknown as Parameters<typeof receiveInboundMessage>[0];

    const result = await receiveInboundMessage(
      deps,
      {
        externalId: `ext-${RUN_ID}-db1`,
        from: CUSTOMER_PHONE,
        to: TEST_PHONE,
        receivedAt: new Date().toISOString(),
        text: "متى تأسست العيادة؟",
      },
      { businessId: TEST_BUSINESS_ID },
    );

    check(
      "DB-1.A Inbound message with unbacked prose returns AI_HANDOFF and NEED_HUMAN",
      result.ok === true &&
        !result.duplicate &&
        result.assistantAction === "AI_HANDOFF" &&
        result.conversationStatus === "NEED_HUMAN",
      result,
    );

    // Verify durable state directly in PostgreSQL:
    const dbConv = await db.conversation.findUnique({
      where: { id: conversation.id },
    });

    check(
      "DB-1.B Conversation status in PostgreSQL is durably updated to NEED_HUMAN",
      dbConv !== null && dbConv.status === "NEED_HUMAN",
      dbConv,
    );

    const dbAttention = await db.operatorAttention.findMany({
      where: { conversationId: conversation.id },
    });

    check(
      "DB-1.C Exactly one operator attention row persisted in DB with POLICY_REFUSED",
      dbAttention.length === 1 &&
        dbAttention[0]!.reason === "POLICY_REFUSED" &&
        dbAttention[0]!.status === "OPEN",
      dbAttention,
    );

    const dbMessages = await db.message.findMany({
      where: { conversationId: conversation.id, senderType: "AI" },
    });

    check(
      "DB-1.D AI message in DB carries canonical SAFE_HANDOFF_REPLIES.DISCLOSURE_REFUSED",
      dbMessages.length === 1 &&
        dbMessages[0]!.content === SAFE_HANDOFF_REPLIES.DISCLOSURE_REFUSED &&
        !dbMessages[0]!.content.includes("الآن") &&
        !dbMessages[0]!.content.includes("هحوّلك"),
      dbMessages,
    );
  }

  // ── DB-2: Explicit NO_KNOWLEDGE Handoff Turn ──────────────────────────────
  {
    const customerPhone2 = `+2011${Math.floor(10000000 + Math.random() * 90000000)}`;
    const customer2 = await customerRepository.upsertByPhone({
      businessId: TEST_BUSINESS_ID,
      phone: customerPhone2,
      name: "عميل تجريبي 2",
    });

    const conversation2 = await conversationRepository.create({
      businessId: TEST_BUSINESS_ID,
      customerId: customer2.id,
      channel: "WHATSAPP",
      status: "AI_ACTIVE",
    });

    const deps = {
      ...baseDeps,
      ai: {
        providerName: "mock-db-ai",
        respond: async () => ({
          intent: "FAQ",
          action: "handoff",
          content: "سيتصل بك موظفنا خلال دقيقة الآن للمتابعة.",
          extraction: {
            service: null,
            provider: null,
            date: null,
            timePreference: null,
          },
          handoffReason: "NO_KNOWLEDGE",
          summary: "سؤال عن أسعار عمليات غير معلنة",
          safetyAssessment: "safe",
        }),
      },
    } as unknown as Parameters<typeof receiveInboundMessage>[0];

    const result2 = await receiveInboundMessage(
      deps,
      {
        externalId: `ext-${RUN_ID}-db2`,
        from: customerPhone2,
        to: TEST_PHONE,
        receivedAt: new Date().toISOString(),
        text: "كم سعر جلسة الليزر الكربوني بالظبط؟",
      },
      { businessId: TEST_BUSINESS_ID },
    );

    check(
      "DB-2.A Explicit NO_KNOWLEDGE handoff returns AI_HANDOFF and NEED_HUMAN",
      result2.ok === true &&
        !result2.duplicate &&
        result2.assistantAction === "AI_HANDOFF" &&
        result2.conversationStatus === "NEED_HUMAN",
      result2,
    );

    const dbConv2 = await db.conversation.findUnique({
      where: { id: conversation2.id },
    });

    check(
      "DB-2.B Conversation status in PostgreSQL is durably updated to NEED_HUMAN",
      dbConv2 !== null && dbConv2.status === "NEED_HUMAN",
      dbConv2,
    );

    const dbAttention2 = await db.operatorAttention.findMany({
      where: { conversationId: conversation2.id },
    });

    check(
      "DB-2.C Operator attention record persisted in DB with reason NO_KNOWLEDGE",
      dbAttention2.length === 1 &&
        dbAttention2[0]!.reason === "NO_KNOWLEDGE" &&
        dbAttention2[0]!.status === "OPEN",
      dbAttention2,
    );

    const dbMessages2 = await db.message.findMany({
      where: { conversationId: conversation2.id, senderType: "AI" },
    });

    check(
      "DB-2.D Bounded server copy persisted in DB; model SLA/contact prose replaced",
      dbMessages2.length === 1 &&
        dbMessages2[0]!.content === resolveHandoffActionReply("NO_KNOWLEDGE") &&
        !dbMessages2[0]!.content.includes("دقيقة") &&
        !dbMessages2[0]!.content.includes("الآن"),
      dbMessages2,
    );
  }

  // ── DB-3: Staff Ownership Preservation in DB ──────────────────────────────
  {
    const customerPhone3 = `+2011${Math.floor(10000000 + Math.random() * 90000000)}`;
    const customer3 = await customerRepository.upsertByPhone({
      businessId: TEST_BUSINESS_ID,
      phone: customerPhone3,
      name: "عميل تجريبي 3",
    });

    const conversation3 = await conversationRepository.create({
      businessId: TEST_BUSINESS_ID,
      customerId: customer3.id,
      channel: "WHATSAPP",
      status: "NEED_HUMAN",
    });

    await db.conversation.update({
      where: { id: conversation3.id },
      data: { assignedUserId: TEST_OPERATOR_ID },
    });

    let aiCalledOnStaffTurn = false;
    const deps = {
      ...baseDeps,
      ai: {
        providerName: "mock-db-ai",
        respond: async () => {
          aiCalledOnStaffTurn = true;
          return {} as never;
        },
      },
    } as unknown as Parameters<typeof receiveInboundMessage>[0];

    const result3 = await receiveInboundMessage(
      deps,
      {
        externalId: `ext-${RUN_ID}-db3`,
        from: customerPhone3,
        to: TEST_PHONE,
        receivedAt: new Date().toISOString(),
        text: "هل أنتم متواجدون الآن؟",
      },
      { businessId: TEST_BUSINESS_ID },
    );

    check(
      "DB-3.A Inbound message to handed-off conversation returns DEFERRED_TO_STAFF",
      result3.ok === true &&
        result3.assistantAction === "DEFERRED_TO_STAFF" &&
        result3.conversationStatus === "NEED_HUMAN" &&
        !aiCalledOnStaffTurn,
      result3,
    );

    const dbConv3 = await db.conversation.findUnique({
      where: { id: conversation3.id },
    });

    check(
      "DB-3.B Staff ownership and assigned user preserved in PostgreSQL database",
      dbConv3 !== null &&
        dbConv3.status === "NEED_HUMAN" &&
        dbConv3.assignedUserId === TEST_OPERATOR_ID,
      dbConv3,
    );
  }

  // ── DB-4: Persistence Failure Boundary / Rollback ─────────────────────────
  {
    const customerPhone4 = `+2011${Math.floor(10000000 + Math.random() * 90000000)}`;
    const customer4 = await customerRepository.upsertByPhone({
      businessId: TEST_BUSINESS_ID,
      phone: customerPhone4,
      name: "عميل تجريبي 4",
    });

    const conversation4 = await conversationRepository.create({
      businessId: TEST_BUSINESS_ID,
      customerId: customer4.id,
      channel: "WHATSAPP",
      status: "AI_ACTIVE",
    });

    // Injected failing conversationRepository.addMessage on AI turn
    const failingDeps = {
      ...baseDeps,
      conversationRepository: {
        ...conversationRepository,
        addMessage: async (input: any, workflow: any) => {
          if (input.senderType === "AI") {
            throw new Error("Simulated database failure on assistant reply write");
          }
          return conversationRepository.addMessage(input, workflow);
        },
      },
      ai: {
        providerName: "mock-db-ai",
        respond: async () => ({
          intent: "FAQ",
          action: "handoff",
          content: "تحويل",
          extraction: {
            service: null,
            provider: null,
            date: null,
            timePreference: null,
          },
          handoffReason: "NO_KNOWLEDGE",
          summary: null,
          safetyAssessment: "safe",
        }),
      },
    } as unknown as Parameters<typeof receiveInboundMessage>[0];

    let persistenceThrew = false;
    try {
      await receiveInboundMessage(
        failingDeps,
        {
          externalId: `ext-${RUN_ID}-db4`,
          from: customerPhone4,
          to: TEST_PHONE,
          receivedAt: new Date().toISOString(),
          text: "سؤال يسبب فشل حفظ",
        },
        { businessId: TEST_BUSINESS_ID },
      );
    } catch {
      persistenceThrew = true;
    }

    check(
      "DB-4.A Persistence failure throws cleanly; no false success reported",
      persistenceThrew === true,
      { persistenceThrew },
    );

    // Verify database state: no AI message survived
    const aiMessages4 = await db.message.findMany({
      where: { conversationId: conversation4.id, senderType: "AI" },
    });

    check(
      "DB-4.B Zero partial or orphan AI messages survived failed persistence",
      aiMessages4.length === 0,
      aiMessages4,
    );
  }

  // ── Clean up test database records ────────────────────────────────────────
  await db.message.deleteMany({
    where: { conversation: { businessId: TEST_BUSINESS_ID } },
  });
  await db.operatorAttention.deleteMany({
    where: { businessId: TEST_BUSINESS_ID },
  });
  await db.conversation.deleteMany({
    where: { businessId: TEST_BUSINESS_ID },
  });
  await db.customer.deleteMany({
    where: { businessId: TEST_BUSINESS_ID },
  });
  await db.service.deleteMany({
    where: { businessId: TEST_BUSINESS_ID },
  });
  await db.branch.deleteMany({
    where: { businessId: TEST_BUSINESS_ID },
  });
  await db.business.deleteMany({
    where: { id: TEST_BUSINESS_ID },
  });
  await db.user.deleteMany({
    where: { id: TEST_OPERATOR_ID },
  });

  const failed = checks.filter((c) => !c.pass);
  console.log("\n────────────────────────────────────────────────────────────────");
  console.log(`Results: ${checks.length - failed.length}/${checks.length} passed.`);
  if (failed.length > 0) {
    console.error(`FAILED: ${failed.length} check(s) failed.`);
    process.exit(1);
  }
  console.log("All disposable PostgreSQL integration checks passed successfully.");
}

main().catch((err) => {
  console.error("FATAL in DB integration check:", err);
  process.exit(1);
});
