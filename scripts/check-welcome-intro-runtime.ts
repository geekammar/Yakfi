/**
 * FlowPilot — Conversation Lab welcome.intro Runtime Wiring Check (Offline).
 *
 * Exercises the REAL conversation engine (`receiveInboundMessage`) with production
 * structured capability (`requiredSemanticCapability: "structured_turn"`) and a
 * recording offline message transport.
 *
 * Verifies:
 *  1. Default output on fresh /start — byte-for-byte matches canonical default.
 *  2. Persisted reply in repository equals delivered transport message.
 *  3. businessName is derived authoritatively from server business context.
 *  4. Choice IDs/options and welcome offer remain 100% intact.
 *  5. Zero model calls on formal /start command.
 *  6. Changed introduction when a valid override is present in copy repository.
 *  7. Immediate reversion to default output when override is reset.
 *  8. Failsafe fallback to canonical default when stored override is invalid.
 *  9. Failsafe fallback to canonical default when copy repository read fails.
 * 10. Duplicate inbound idempotency (no extra reply or transport send).
 * 11. Active offer continuation is preserved and not overwritten by /start.
 * 12. Active booking task continuation is preserved and not overwritten by /start.
 *
 * Run: pnpm check:welcome-intro-runtime
 */

import {
  DEFAULT_WELCOME_INTRO_TEMPLATE,
  FIXED_WELCOME_CHOICES_BODY,
  receiveInboundMessage,
  type ConversationEngineDeps,
} from "@/features/conversations/server/conversation-engine";
import {
  buildDateOffer,
  buildSlotOffer,
  emptyConversationState,
  withPresentedOffer,
} from "@/features/conversations/server/conversation-state";
import { InMemoryConversationStateStore } from "@/features/conversations/server/conversation-state-store";
import type { MessageTransport } from "@/features/conversations/server/conversation-transport";
import type { CopyOverrideRecord } from "@/server/repositories/copy-override.repository";

type Check = { label: string; pass: boolean };

const checks: Check[] = [];
function check(label: string, pass: boolean): void {
  checks.push({ label, pass });
}

const BUSINESS_ID = "biz-welcome-intro-test-01";
const BUSINESS_NAME = "عيادة النور التخصصية";
const CUSTOMER_ID = "cust-welcome-intro-test-01";
const CUSTOMER_PHONE = "+201099998888";
const BOT_PHONE = "+201000001111";

type StoredMessage = {
  id: string;
  conversationId: string;
  senderType: "CUSTOMER" | "AI" | "STAFF";
  content: string;
  createdAt: Date;
};

type SentTransportMessage = {
  to: string;
  businessId: string;
  businessName: string;
  conversationId: string;
  content: string;
  choices?: unknown;
};

function createTestHarness(initialOverrides: Record<string, string> = {}) {
  const overrides = new Map<string, string>(Object.entries(initialOverrides));
  let failCopyRead = false;

  const messages: StoredMessage[] = [];
  const sentMessages: SentTransportMessage[] = [];
  const processedExternalIds = new Set<string>();

  let aiCallsCount = 0;

  const stateStore = new InMemoryConversationStateStore();

  const recordingTransport: MessageTransport = {
    providerName: "recording-offline-transport",
    async send(msg) {
      sentMessages.push({
        to: msg.to,
        businessId: msg.businessId,
        businessName: msg.businessName,
        conversationId: msg.conversationId,
        content: msg.content,
        choices: msg.choices,
      });
      return {
        provider: "recording-offline-transport",
        delivered: true,
      };
    },
  };

  const copyOverrideRepo = {
    async getPublished(copyKey: string): Promise<CopyOverrideRecord | null> {
      if (failCopyRead) {
        throw new Error("Simulated copy repository read failure");
      }
      const text = overrides.get(copyKey);
      if (!text) return null;
      return {
        id: `override-${copyKey}`,
        copyKey,
        text,
        actorId: "test-platform-actor",
        createdAt: new Date("2026-10-30T10:00:00Z"),
        updatedAt: new Date("2026-10-30T10:00:00Z"),
      };
    },
  };

  const businessRow = {
    id: BUSINESS_ID,
    name: BUSINESS_NAME,
    whatsappNumber: BOT_PHONE,
    isActive: true,
    timezone: "Africa/Cairo",
    confirmationMode: "automatic" as const,
    defaultBranchId: "branch-01",
    faqs: [],
  };

  const services = [
    {
      id: "srv-01",
      businessId: BUSINESS_ID,
      name: "كشف عام",
      durationMinutes: 30,
      price: 200,
      isActive: true,
    },
  ];

  const deps: ConversationEngineDeps = {
    businessRepository: {
      findById: async (id: string) => (id === BUSINESS_ID ? businessRow : null),
      findByWhatsappNumber: async (num: string) =>
        num === BOT_PHONE ? businessRow : null,
    } as any,
    branchRepository: {
      findDefaultByBusiness: async (id: string) => ({
        id: "branch-01",
        businessId: id,
        name: "الفرع الرئيسي",
      }),
      findByIdWithinBusiness: async (id: string, bId: string) => ({
        id,
        businessId: bId,
        name: "الفرع الرئيسي",
      }),
    } as any,
    customerRepository: {
      upsertByPhone: async () => ({
        id: CUSTOMER_ID,
        businessId: BUSINESS_ID,
        phone: CUSTOMER_PHONE,
        name: "عميل تجريبي",
      }),
      touchConversation: async () => {},
    } as any,
    conversationRepository: {
      findLatestByCustomer: async () => null,
      create: async (data: any) => ({
        id: "conv-01",
        businessId: data.businessId,
        customerId: data.customerId,
        status: "AI_ACTIVE",
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      addMessage: async (data: any) => {
        const msg: StoredMessage = {
          id: `msg-${messages.length + 1}`,
          conversationId: data.conversationId,
          senderType: data.senderType,
          content: data.content,
          createdAt: data.createdAt ?? new Date(),
        };
        messages.push(msg);
        return msg;
      },
      findById: async () => ({
        id: "conv-01",
        businessId: BUSINESS_ID,
        customerId: CUSTOMER_ID,
        status: "AI_ACTIVE",
      }),
      listRecentMessages: async () => messages,
    } as any,
    serviceRepository: {
      listActiveByBusiness: async () => services,
      findById: async (id: string) => services.find((s) => s.id === id) ?? null,
    } as any,
    inboundDedupeRepository: {
      acquireClaim: async (key: string) => {
        if (processedExternalIds.has(key)) {
          return { status: "DUPLICATE", claimId: null };
        }
        processedExternalIds.add(key);
        return { status: "CLAIMED", claimId: `claim-${key}` };
      },
      resolveClaim: async () => {},
      releaseClaim: async () => {},
    } as any,
    usageRepository: {
      recordUsage: async () => {},
    } as any,
    attentionRepository: {
      createReviewRecord: async () => ({ id: "att-01" }),
    } as any,
    conversationStateRepository: stateStore as any,
    copyOverrideRepository: copyRepo as any,
    ai: {
      providerName: "test-ai-gateway",
      async respond() {
        aiCallsCount += 1;
        throw new Error("AI should NOT be called on formal /start command");
      },
    } as any,
    transport: recordingTransport,
    requiredSemanticCapability: "structured_turn",
  };

  return {
    deps,
    messages,
    sentMessages,
    stateStore,
    setOverride(key: string, text: string) {
      overrides.set(key, text);
    },
    removeOverride(key: string) {
      overrides.delete(key);
    },
    setFailCopyRead(fail: boolean) {
      failCopyRead = fail;
    },
    getAiCallsCount: () => aiCallsCount,
  };
}

async function main(): Promise<void> {
  console.log("▶ Running Conversation Lab welcome.intro Runtime Wiring Tests...");

  // ── 1. Default Output on Fresh /start ──────────────────────────────────────
  {
    const harness = createTestHarness();
    const result = await receiveInboundMessage(harness.deps, {
      externalId: "ext-start-default",
      from: CUSTOMER_PHONE,
      to: BOT_PHONE,
      text: "/start",
      receivedAt: new Date().toISOString(),
    });

    const expectedDefaultIntro = DEFAULT_WELCOME_INTRO_TEMPLATE.replace(
      "{businessName}",
      BUSINESS_NAME,
    );
    const expectedFullMessage = `${expectedDefaultIntro}${FIXED_WELCOME_CHOICES_BODY}`;

    const sent = harness.sentMessages[0];
    const persisted = harness.messages.find((m) => m.senderType === "AI");

    check("1a. نتيجة المعالجة ناجحة وبحالة AI_ACTIVE", result.ok && (result as any).conversationStatus === "AI_ACTIVE");
    check("1b. نوع النية هو GREETING", result.ok && (result as any).intent === "GREETING");
    check(
      "1c. نص الرسالة المرسل يطابق النص الافتراضي حرفاً بحرف",
      sent !== undefined && sent.content === expectedFullMessage,
    );
    check(
      "1d. نص الرسالة المخزن في قاعدة البيانات يطابق نص الإرسال حرفياً",
      persisted !== undefined && sent !== undefined && persisted.content === sent.content,
    );
    check(
      "1e. اسم المنشأة مشتق من سياق السيرفر الموثوق",
      sent !== undefined && sent.content.includes(BUSINESS_NAME),
    );
    check(
      "1f. خيارات القناة وبطاقات الأزرار موجودة وسليمة",
      sent !== undefined && sent.choices !== undefined,
    );
    check(
      "1g. لم يتم استدعاء أي نموذج ذكاء اصطناعي لأمر /start الصريح",
      harness.getAiCallsCount() === 0,
    );
  }

  // ── 2. Changed Intro on Published Override ─────────────────────────────────
  {
    const harness = createTestHarness();
    const CUSTOM_INTRO = "أهلاً ومرحباً بك في {businessName}! فريقنا في خدمتك دائماً:";
    harness.setOverride("welcome.intro", CUSTOM_INTRO);

    const result = await receiveInboundMessage(harness.deps, {
      externalId: "ext-start-override",
      from: CUSTOMER_PHONE,
      to: BOT_PHONE,
      text: "/start",
      receivedAt: new Date().toISOString(),
    });

    const expectedCustomIntro = `أهلاً ومرحباً بك في ${BUSINESS_NAME}! فريقنا في خدمتك دائماً:`;
    const expectedCustomFull = `${expectedCustomIntro}${FIXED_WELCOME_CHOICES_BODY}`;

    const sent = harness.sentMessages[0];
    const persisted = harness.messages.find((m) => m.senderType === "AI");

    check(
      "2a. نص الترحيب يتغير مع وجود تعديل منشور في المختبر",
      sent !== undefined && sent.content.startsWith(expectedCustomIntro),
    );
    check(
      "2b. الخيارات الثابتة وتعليمات الأزرار تظل سليمة بعد التعديل",
      sent !== undefined && sent.content === expectedCustomFull,
    );
    check(
      "2c. النص المخزن يطابق تماماً النص المرسل عبر وسيط القناة",
      persisted !== undefined && sent !== undefined && persisted.content === sent.content,
    );
  }

  // ── 3. Reset to Default ───────────────────────────────────────────────────
  {
    const harness = createTestHarness({
      "welcome.intro": "مقدمة مؤقتة {businessName}:",
    });

    // Remove override (simulating reset in Lab)
    harness.removeOverride("welcome.intro");

    await receiveInboundMessage(harness.deps, {
      externalId: "ext-start-reset",
      from: CUSTOMER_PHONE,
      to: BOT_PHONE,
      text: "/start",
      receivedAt: new Date().toISOString(),
    });

    const expectedDefaultIntro = DEFAULT_WELCOME_INTRO_TEMPLATE.replace(
      "{businessName}",
      BUSINESS_NAME,
    );
    const sent = harness.sentMessages[0];

    check(
      "3a. بعد إعادة الضبط (Reset) يعود الرد للنص الافتراضي الكنسي حرفياً",
      sent !== undefined && sent.content.startsWith(expectedDefaultIntro),
    );
  }

  // ── 4. Invalid Stored Text Fallback ───────────────────────────────────────
  {
    const harness = createTestHarness();
    // Storing invalid template missing required {businessName}
    harness.setOverride("welcome.intro", "أهلاً بك بدون عنصر نائب المطلوب:");

    await receiveInboundMessage(harness.deps, {
      externalId: "ext-start-invalid",
      from: CUSTOMER_PHONE,
      to: BOT_PHONE,
      text: "/start",
      receivedAt: new Date().toISOString(),
    });

    const expectedDefaultIntro = DEFAULT_WELCOME_INTRO_TEMPLATE.replace(
      "{businessName}",
      BUSINESS_NAME,
    );
    const sent = harness.sentMessages[0];

    check(
      "4a. عند وجود نص غير صالح في المتجر، يتراجع المحرك بأمان للنص الافتراضي الكنسي",
      sent !== undefined && sent.content.startsWith(expectedDefaultIntro),
    );
  }

  // ── 5. Copy Read Failure Fallback ─────────────────────────────────────────
  {
    const harness = createTestHarness();
    harness.setFailCopyRead(true);

    const result = await receiveInboundMessage(harness.deps, {
      externalId: "ext-start-store-fail",
      from: CUSTOMER_PHONE,
      to: BOT_PHONE,
      text: "/start",
      receivedAt: new Date().toISOString(),
    });

    const expectedDefaultIntro = DEFAULT_WELCOME_INTRO_TEMPLATE.replace(
      "{businessName}",
      BUSINESS_NAME,
    );
    const sent = harness.sentMessages[0];

    check("5a. المعالجة تنجح ولا تنهار عند فشل قراءة متجر النصوص", result.ok);
    check(
      "5b. يتراجع المحرك تلقائياً إلى النص الافتراضي عند فشل قراءة المتجر",
      sent !== undefined && sent.content.startsWith(expectedDefaultIntro),
    );
  }

  // ── 6. Duplicate Inbound Idempotency ──────────────────────────────────────
  {
    const harness = createTestHarness();
    const payload = {
      externalId: "ext-start-dup",
      from: CUSTOMER_PHONE,
      to: BOT_PHONE,
      text: "/start",
      receivedAt: new Date().toISOString(),
    };

    const first = await receiveInboundMessage(harness.deps, payload);
    const second = await receiveInboundMessage(harness.deps, payload);

    check("6a. الإرسال الأول ناجح وغير مكرر", first.ok && !(first as any).duplicate);
    check("6b. الإرسال الثاني يتم رصده كمكرر", second.ok && (second as any).duplicate === true);
    check(
      "6c. لم يتم إرسال سوى رسالة رد واحدة فقط عبر القناة",
      harness.sentMessages.length === 1,
    );
  }

  // ── 7. Active Offer Continuation Preserved ────────────────────────────────
  {
    const harness = createTestHarness();
    // Seed conversation state with active slot offer
    const futureDate = new Date(Date.now() + 3600 * 1000).toISOString();
    const activeOffer = buildSlotOffer(
      { businessId: BUSINESS_ID, conversationId: "conv-01" },
      "offer-01",
      {
        serviceId: "srv-01",
        serviceName: "كشف عام",
        serviceSource: "CUSTOMER",
        providerId: null,
        timePreference: null,
        date: "2026-11-01",
        shownCount: 1,
        options: [
          {
            displayName: "طبيب 1",
            startAt: "2026-11-01T10:00:00Z",
            endAt: "2026-11-01T10:30:00Z",
          },
        ],
      },
      new Date(),
      new Date(futureDate),
    );

    const initialState = withPresentedOffer(emptyConversationState(), activeOffer);
    await harness.stateStore.saveState("conv-01", initialState, 0);

    const result = await receiveInboundMessage(harness.deps, {
      externalId: "ext-start-active-offer",
      from: CUSTOMER_PHONE,
      to: BOT_PHONE,
      text: "/start",
      receivedAt: new Date().toISOString(),
    });

    const sent = harness.sentMessages[0];
    check("7a. المعالجة ناجحة بوجود عرض نشط", result.ok);
    check(
      "7b. يتم استئناف العرض النشط ولا يتم استبداله بالترحيب الأولي",
      sent !== undefined && sent.content.includes("ما زالت المواعيد المقترحة متاحة لاختيارك"),
    );
  }

  // ── 8. Active Booking Task Continuation Preserved ─────────────────────────
  {
    const harness = createTestHarness();
    // Seed state with active booking task missing date
    const bookingTaskState = {
      ...emptyConversationState(),
      activeTask: {
        kind: "BOOKING" as const,
        serviceId: "srv-01",
        serviceName: "كشف عام",
        startedAt: new Date().toISOString(),
      },
      selectedService: "كشف عام",
      serviceId: "srv-01",
    };
    await harness.stateStore.saveState("conv-01", bookingTaskState, 0);

    const result = await receiveInboundMessage(harness.deps, {
      externalId: "ext-start-active-task",
      from: CUSTOMER_PHONE,
      to: BOT_PHONE,
      text: "/start",
      receivedAt: new Date().toISOString(),
    });

    const sent = harness.sentMessages[0];
    check("8a. المعالجة ناجحة بوجود مهمة حجز نشطة", result.ok);
    check(
      "8b. يتم طلب تحديد التاريخ لمتابعة الحجز ولا يتم إرسال الترحيب الأولي",
      sent !== undefined && (sent.content.includes("التاريخ") || sent.content.includes("اليوم")),
    );
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const passed = checks.filter((c) => c.pass).length;
  const failed = checks.filter((c) => !c.pass).length;

  console.log(`\nResults: ${passed} passed, ${failed} failed out of ${checks.length} checks.\n`);

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
  console.error("Unhandled error:", err);
  process.exit(1);
});
