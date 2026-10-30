/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * FlowPilot — Conversation Lab welcome.intro Real-DB Integration Check.
 *
 * Verifies the complete real database path against a disposable/local PostgreSQL
 * database in GitHub Actions / local development:
 *
 *   publish (savePublishedOverride)
 *     -> PostgreSQL platform_copy_overrides row persisted
 *     -> conversation engine receiveInboundMessage re-reads through copyOverrideRepository
 *     -> output introduction changes with businessName from DB business row
 *     -> reset (resetPublishedOverride)
 *     -> PostgreSQL row removed
 *     -> engine re-reads and returns byte-for-byte canonical default output.
 *
 * Also verifies authorization & protection invariants:
 *   - Non-platform actor cannot publish overrides (FORBIDDEN).
 *   - Platform actor cannot edit protected copy (PROTECTED_COPY_NOT_EDITABLE).
 *
 * Run:
 *   DATABASE_URL='postgresql://postgres:password@localhost:5432/flowpilot_test' \
 *     pnpm check:welcome-intro-db
 */

import {
  resetPublishedOverride,
  savePublishedOverride,
} from "@/features/conversation-copy/override-service";
import {
  DEFAULT_WELCOME_INTRO_TEMPLATE,
  FIXED_WELCOME_CHOICES_BODY,
  receiveInboundMessage,
} from "@/features/conversations/server/conversation-engine";
import type { MessageTransport } from "@/features/conversations/server/conversation-transport";
import { db } from "@/server/db";
import {
  appointmentRepository,
  branchRepository,
  businessRepository,
  conversationRepository,
  conversationStateRepository,
  copyOverrideRepository,
  customerRepository,
  followUpRequestRepository,
  inboundDedupeRepository,
  knowledgeGapRepository,
  operatorAttentionRepository,
  providerRepository,
  serviceRepository,
  usageRepository,
} from "@/server/repositories";

type Check = { label: string; pass: boolean };

const checks: Check[] = [];
function check(label: string, pass: boolean): void {
  checks.push({ label, pass });
}

const RUN_ID = `dbcheck-${Date.now()}`;
const TEST_OPERATOR_ID = `op-${RUN_ID}`;
const TEST_BUSINESS_ACTOR_ID = `biz-op-${RUN_ID}`;
const PLATFORM_ACTOR = {
  userId: TEST_OPERATOR_ID,
  accountType: "PLATFORM" as const,
};
const BUSINESS_ACTOR = {
  userId: TEST_BUSINESS_ACTOR_ID,
  accountType: "BUSINESS" as const,
};

const TEST_BUSINESS_ID = `biz-${RUN_ID}`;
const TEST_BUSINESS_NAME = "مركز الأمل الطبي";
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
    "▶ Running Conversation Lab welcome.intro Real-DB Integration Check...",
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

  // Recording transport for verifying delivered text
  const sentMessages: string[] = [];
  const testTransport: MessageTransport = {
    providerName: "offline-db-test-transport",
    async send(msg) {
      sentMessages.push(msg.content);
      return { provider: "offline-db-test-transport", delivered: true };
    },
  };

  // Setup test records in database
  await db.user.create({
    data: {
      id: TEST_OPERATOR_ID,
      email: `${TEST_OPERATOR_ID}@flowpilot.invalid`,
      emailVerified: false,
      accountType: "PLATFORM",
      name: "Test Platform Operator",
    },
  });

  await db.user.create({
    data: {
      id: TEST_BUSINESS_ACTOR_ID,
      email: `${TEST_BUSINESS_ACTOR_ID}@flowpilot.invalid`,
      emailVerified: false,
      accountType: "BUSINESS",
      name: "Test Business User",
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

  const engineDeps = {
    businessRepository,
    branchRepository,
    customerRepository,
    conversationRepository,
    serviceRepository,
    inboundDedupeRepository,
    usageRepository,
    attentionRepository: operatorAttentionRepository,
    knowledgeGapRepository,
    conversationStateRepository,
    providerRepository,
    appointmentRepository,
    followUpRequestRepository,
    copyOverrideRepository,
    ai: {
      providerName: "offline-mock-ai",
      async respond() {
        throw new Error("AI provider should not be called for formal /start");
      },
    } as any,
    transport: testTransport,
    requiredSemanticCapability: "structured_turn" as const,
  };

  try {
    // ── 1. Initial State: No Override in Database ─────────────────────────────
    sentMessages.length = 0;
    const initialResult = await receiveInboundMessage(engineDeps, {
      externalId: `${RUN_ID}-msg-1`,
      from: CUSTOMER_PHONE,
      to: TEST_PHONE,
      text: "/start",
      receivedAt: new Date().toISOString(),
    });

    const expectedDefaultIntro = DEFAULT_WELCOME_INTRO_TEMPLATE.replace(
      "{businessName}",
      TEST_BUSINESS_NAME,
    );
    const expectedDefaultFull = `${expectedDefaultIntro}${FIXED_WELCOME_CHOICES_BODY}`;

    check("1a. الإرسال الأولي ناجح", initialResult.ok);
    check(
      "1b. عند عدم وجود تجاوز في قاعدة البيانات، يخرج النص الافتراضي الكنسي حرفياً",
      sentMessages[0] === expectedDefaultFull,
    );

    // ── 2. Authorization & Protection Guard (Requirement C) ──────────────────
    const unauthorizedSave = await savePublishedOverride(
      BUSINESS_ACTOR,
      "welcome.intro",
      "محاولة تعديل غير مصرح بها {businessName}:",
    );
    check(
      "2a. رفض تعديل النصوص لمستخدم غير مشغل منصة برمز FORBIDDEN",
      !unauthorizedSave.success && unauthorizedSave.error.code === "FORBIDDEN",
    );

    const protectedSave = await savePublishedOverride(
      PLATFORM_ACTOR,
      "handoff.sensitive",
      "محاولة تعديل نص محمي",
    );
    check(
      "2b. رفض تعديل النصوص المحمية (handoff.sensitive) حتى لمشغل المنصة",
      !protectedSave.success &&
        protectedSave.error.code === "INVALID_COPY" &&
        protectedSave.error.validationFailure?.code ===
          "PROTECTED_COPY_NOT_EDITABLE",
    );

    const protectedRow = await db.platformCopyOverride.findUnique({
      where: { copyKey: "handoff.sensitive" },
    });
    check(
      "2c. لم يتم كتابة أي صف في قاعدة البيانات للنصوص المحمية",
      protectedRow === null,
    );

    // ── 3. Publish Override to Real PostgreSQL ───────────────────────────────
    const CUSTOM_INTRO =
      "أهلاً وسهلاً بك في {businessName}! سعداء بتشريفك ومستعدون لخدمتك:";
    const publishRes = await savePublishedOverride(
      PLATFORM_ACTOR,
      "welcome.intro",
      CUSTOM_INTRO,
    );
    check("3a. عملية نشر التجاوز في قاعدة البيانات ناجحة", publishRes.success);

    const dbRow = await db.platformCopyOverride.findUnique({
      where: { copyKey: "welcome.intro" },
    });
    check(
      "3b. الصف تم حفظه فعلياً في جدول platform_copy_overrides",
      dbRow !== null && dbRow.text === CUSTOM_INTRO,
    );

    // ── 4. Engine Consumes Real DB Override ───────────────────────────────────
    sentMessages.length = 0;
    const overriddenResult = await receiveInboundMessage(engineDeps, {
      externalId: `${RUN_ID}-msg-2`,
      from: CUSTOMER_PHONE,
      to: TEST_PHONE,
      text: "/start",
      receivedAt: new Date().toISOString(),
    });

    const expectedCustomIntro = `أهلاً وسهلاً بك في ${TEST_BUSINESS_NAME}! سعداء بتشريفك ومستعدون لخدمتك:`;
    const expectedCustomFull = `${expectedCustomIntro}${FIXED_WELCOME_CHOICES_BODY}`;

    check("4a. معالجة الرسالة بعد النشر ناجحة", overriddenResult.ok);
    check(
      "4b. مخرجات المحرك تعكس التعديل المنشور المحفوظ في قاعدة البيانات الحقيقية",
      sentMessages[0] === expectedCustomFull,
    );

    // ── 5. Reset Override in Real PostgreSQL ─────────────────────────────────
    const resetRes = await resetPublishedOverride(
      PLATFORM_ACTOR,
      "welcome.intro",
    );
    check("5a. عملية إعادة الضبط (reset) ناجحة", resetRes.success);

    const dbRowAfterReset = await db.platformCopyOverride.findUnique({
      where: { copyKey: "welcome.intro" },
    });
    check(
      "5b. تم حذف الصف من platform_copy_overrides بعد إعادة الضبط",
      dbRowAfterReset === null,
    );

    // ── 6. Engine Returns to Default ─────────────────────────────────────────
    sentMessages.length = 0;
    const finalResult = await receiveInboundMessage(engineDeps, {
      externalId: `${RUN_ID}-msg-3`,
      from: CUSTOMER_PHONE,
      to: TEST_PHONE,
      text: "/start",
      receivedAt: new Date().toISOString(),
    });

    check("6a. معالجة الرسالة بعد إعادة الضبط ناجحة", finalResult.ok);
    check(
      "6b. بعد إعادة الضبط في قاعدة البيانات، يعود المحرك للنص الافتراضي الكنسي حرفياً",
      sentMessages[0] === expectedDefaultFull,
    );
  } finally {
    // Cleanup test records
    await db.platformCopyOverrideHistory.deleteMany({
      where: { actorId: { in: [TEST_OPERATOR_ID, TEST_BUSINESS_ACTOR_ID] } },
    });
    await db.platformCopyOverride.deleteMany({
      where: { copyKey: "welcome.intro" },
    });
    await db.message.deleteMany({
      where: { conversation: { businessId: TEST_BUSINESS_ID } },
    });
    await db.conversation.deleteMany({
      where: { businessId: TEST_BUSINESS_ID },
    });
    await db.customer.deleteMany({
      where: { businessId: TEST_BUSINESS_ID },
    });
    await db.business.deleteMany({
      where: { id: TEST_BUSINESS_ID },
    });
    await db.user.deleteMany({
      where: { id: { in: [TEST_OPERATOR_ID, TEST_BUSINESS_ACTOR_ID] } },
    });
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const passed = checks.filter((c) => c.pass).length;
  const failed = checks.filter((c) => !c.pass).length;

  console.log(
    `\nResults: ${passed} passed, ${failed} failed out of ${checks.length} checks.\n`,
  );

  for (const c of checks) {
    if (!c.pass) {
      console.error(`❌ FAILED: ${c.label}`);
    } else {
      console.log(`✅ ${c.label}`);
    }
  }

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unhandled DB test error:", err);
  process.exit(1);
});
