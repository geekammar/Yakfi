/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * FlowPilot — Conversation Lab welcome.intro Runtime Wiring Check (Offline).
 *
 * Exercises the REAL conversation engine (`receiveInboundMessage`) with production
 * structured capability (`requiredSemanticCapability: "structured_turn"`) and a
 * recording offline message transport.
 *
 * Verifies:
 *  1. Default output on fresh /start — byte-for-byte matches independent baseline.
 *  2. Persisted reply in repository equals delivered transport message.
 *  3. businessName is derived authoritatively from server business context.
 *  4. Choice IDs/options, callback semantics, and welcome offer match persisted state.
 *  5. Zero model calls and zero appointment writes on formal /start command.
 *  6. Isolated dependency path without copy repository strictly uses canonical default.
 *  7. Changed introduction when a valid override is present in copy repository.
 *  8. Immediate reversion to default output when override is reset.
 *  9. Failsafe fallback to canonical default when stored override is invalid.
 * 10. Failsafe fallback to canonical default when copy repository read fails.
 * 11. Duplicate inbound idempotency (no extra reply or transport send).
 * 12. Active offer continuation is preserved, distinct override is unconsumed, offer identity preserved.
 * 13. Active booking task continuation is preserved, distinct override is unconsumed, task identity preserved.
 *
 * Run: pnpm check:welcome-intro-runtime
 */

import {
  PLAYGROUND_IDS,
  createPlaygroundHarness,
} from "@/features/conversations/playground/harness";
import { buildSlotOffer } from "@/features/conversations/server/booking-offer";
import {
  DEFAULT_WELCOME_INTRO_TEMPLATE,
  FIXED_WELCOME_CHOICES_BODY,
  receiveInboundMessage,
  type ConversationEngineDeps,
} from "@/features/conversations/server/conversation-engine";
import {
  dehydrateConversationState,
  emptyConversationState,
  withPresentedOffer,
} from "@/features/conversations/server/conversation-state";
import type { MessageTransport } from "@/features/conversations/server/conversation-transport";
import type { CopyOverrideRecord } from "@/server/repositories/copy-override.repository";

type Check = { label: string; pass: boolean };

const checks: Check[] = [];
function check(label: string, pass: boolean): void {
  checks.push({ label, pass });
}

const BUSINESS_ID = "biz-welcome-intro-test-01";
const BUSINESS_NAME = "عيادة النور التخصصية";
const CUSTOMER_PHONE = "+201099998888";
const BOT_PHONE = "+201000001111";

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
  let aiCallsCount = 0;

  const harness = createPlaygroundHarness({
    todayRef: "2026-10-30",
    businessConfig: {
      id: BUSINESS_ID,
      name: BUSINESS_NAME,
      whatsappNumber: BOT_PHONE,
    },
  });

  const sentMessages: SentTransportMessage[] = [];
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
        createdAt: "2026-10-30T10:00:00.000Z",
        updatedAt: "2026-10-30T10:00:00.000Z",
      };
    },
  };

  const deps: ConversationEngineDeps = {
    ...harness.deps,
    copyOverrideRepository: copyOverrideRepo as any,
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
    conversation: harness.conversation,
    messages: harness.messages,
    sentMessages,
    stateStore: harness.stateStore,
    now: harness.getVirtualNow(),
    nowIso: harness.getVirtualNow().toISOString(),
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
    getAppointmentWritesCount: () => harness.capturedAppointmentWrites.length,
    appointments: harness.appointments,
  };
}

const INDEPENDENT_BASELINE_WELCOME =
  `أهلاً بك في ${BUSINESS_NAME}!\nيسعدنا مساعدتك في حجز موعد أو الإجابة عن استفساراتك:` +
  `\n1️⃣ حجز موعد\n2️⃣ استفسار عن خدمة\n(يمكنك الاختيار من الخيارات أعلاه أو كتابة طلبك مباشرة في أي وقت)`;

async function main(): Promise<void> {
  console.log(
    "▶ Running Conversation Lab welcome.intro Runtime Wiring Tests...",
  );

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
    const persistedState = await harness.stateStore.load(
      BUSINESS_ID,
      harness.conversation.id,
    );
    const offer = persistedState?.offer;
    const choices = sent?.choices as any;

    check(
      "1a. نتيجة المعالجة ناجحة وبحالة AI_ACTIVE",
      result.ok && (result as any).conversationStatus === "AI_ACTIVE",
    );
    check(
      "1b. نوع النية هو GREETING",
      result.ok && (result as any).intent === "GREETING",
    );
    check(
      "1c. نص الرسالة المرسل يطابق التوقع الكنسي المستقل (ولا يعتمد فقط على ثوابت الملف)",
      sent !== undefined &&
        sent.content === INDEPENDENT_BASELINE_WELCOME &&
        sent.content === expectedFullMessage,
    );
    check(
      "1d. نص الرسالة المخزن في قاعدة البيانات يطابق نص الإرسال حرفياً",
      persisted !== undefined &&
        sent !== undefined &&
        persisted.content === sent.content,
    );
    check(
      "1e. اسم المنشأة مشتق من سياق السيرفر الموثوق",
      sent !== undefined && sent.content.includes(BUSINESS_NAME),
    );
    check(
      "1f. خيارات القناة وبطاقات الأزرار مطابقة لدلالات عرض الترحيب وحالة المحادثة المحفوظة",
      choices !== undefined &&
        choices.offerKind === "WELCOME" &&
        offer !== null &&
        offer?.kind === "WELCOME" &&
        choices.offerId === offer?.id &&
        choices.offerToken === offer?.token &&
        Array.isArray(choices.groups) &&
        choices.groups.length === 2 &&
        choices.groups[0][0]?.id === "book" &&
        choices.groups[0][0]?.label === "حجز موعد" &&
        choices.groups[1][0]?.id === "inquire" &&
        choices.groups[1][0]?.label === "استفسار عن خدمة",
    );
    check(
      "1g. لم يتم استدعاء أي نموذج ذكاء اصطناعي لأمر /start الصريح",
      harness.getAiCallsCount() === 0,
    );
    check(
      "1h. لم يتم إنشاء أو تعديل أي موعد في مسار الترحيب الأولي",
      harness.getAppointmentWritesCount() === 0,
    );
  }

  // ── 1-bis. No Injected Copy Repository Path (Strict Isolation) ────────────
  {
    const harness = createTestHarness();
    // Explicitly delete copyOverrideRepository to prove the isolated path uses
    // the canonical default without consulting any repository singleton
    delete (harness.deps as any).copyOverrideRepository;

    const result = await receiveInboundMessage(harness.deps, {
      externalId: "ext-start-no-repo",
      from: "+201011112222",
      to: BOT_PHONE,
      text: "/start",
      receivedAt: new Date().toISOString(),
    });

    const sent = harness.sentMessages[0];
    const persisted = harness.messages.find((m) => m.senderType === "AI");

    check(
      "1i. غياب مستودع التجاوزات ينتج النص الكنسي الافتراضي مباشرة دون استدعاء أي قاعدة بيانات",
      result.ok &&
        sent !== undefined &&
        sent.content === INDEPENDENT_BASELINE_WELCOME &&
        persisted !== undefined &&
        persisted.content === sent.content &&
        harness.deps.copyOverrideRepository === undefined,
    );
  }

  // ── 2. Changed Intro on Published Override ─────────────────────────────────
  {
    const harness = createTestHarness();
    const CUSTOM_INTRO =
      "أهلاً ومرحباً بك في {businessName}! فريقنا في خدمتك دائماً:";
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
      result.ok &&
        sent !== undefined &&
        sent.content.startsWith(expectedCustomIntro),
    );
    check(
      "2b. الخيارات الثابتة وتعليمات الأزرار تظل سليمة بعد التعديل",
      sent !== undefined && sent.content === expectedCustomFull,
    );
    check(
      "2c. النص المخزن يطابق تماماً النص المرسل عبر وسيط القناة",
      persisted !== undefined &&
        sent !== undefined &&
        persisted.content === sent.content,
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

    check(
      "6a. الإرسال الأول ناجح وغير مكرر",
      first.ok && !(first as any).duplicate,
    );
    check(
      "6b. الإرسال الثاني يتم رصده كمكرر",
      second.ok && (second as any).duplicate === true,
    );
    check(
      "6c. لم يتم إرسال سوى رسالة رد واحدة فقط عبر القناة",
      harness.sentMessages.length === 1,
    );
  }

  // ── 7. Active Offer Continuation Preserved (With Distinctive Override Seeded) ──
  {
    const harness = createTestHarness();
    const DISTINCTIVE_OVERRIDE =
      "تجاوز ترحيبي مميز جداً {businessName} XYZ_OFFER_INTRUSION_GUARD";
    harness.setOverride("welcome.intro", DISTINCTIVE_OVERRIDE);

    const conversationId = harness.conversation.id;
    // Seed conversation state with active slot offer
    const activeOffer = buildSlotOffer(
      { businessId: BUSINESS_ID, conversationId },
      "offer-01",
      {
        serviceId: PLAYGROUND_IDS.SERV_DENTAL,
        serviceName: "كشف أسنان",
        serviceSource: "CUSTOMER",
        providerId: PLAYGROUND_IDS.PROV_1,
        timePreference: null,
        date: "2026-11-01",
        shownCount: 1,
        options: [
          {
            providerId: PLAYGROUND_IDS.PROV_1,
            displayName: "د. أحمد سامي",
            startAt: "2026-11-01T10:00",
            endAt: "2026-11-01T10:30",
          },
        ],
      },
      harness.now,
    );

    if (!activeOffer) throw new Error("Failed to build active offer in test");
    const initialState = withPresentedOffer(
      emptyConversationState(),
      activeOffer,
    );
    await harness.stateStore.save(
      BUSINESS_ID,
      conversationId,
      null,
      dehydrateConversationState(initialState),
    );

    const result = await receiveInboundMessage(harness.deps, {
      externalId: "ext-start-active-offer",
      from: CUSTOMER_PHONE,
      to: BOT_PHONE,
      text: "/start",
      receivedAt: harness.nowIso,
    });

    const sent = harness.sentMessages[0];
    const persisted = harness.messages.find((m) => m.senderType === "AI");
    const currentState = await harness.stateStore.load(
      BUSINESS_ID,
      conversationId,
    );

    check("7a. المعالجة ناجحة بوجود عرض نشط", result.ok);
    check(
      "7b. يتم استئناف العرض النشط ولا يتم استهلاك أو تسريب تجاوز الترحيب المميز",
      sent !== undefined &&
        !sent.content.includes("XYZ_OFFER_INTRUSION_GUARD") &&
        sent.content.includes("ما زالت المواعيد المقترحة متاحة لاختيارك"),
    );
    check(
      "7c. هوية العرض النشط وحالة المحادثة محفوظة تماماً",
      currentState?.offer?.id === "offer-01" &&
        currentState?.offer?.kind === "SLOT",
    );
    check(
      "7d. نص الرسالة المخزن يطابق نص الإرسال حرفياً دون أي تعديل على المواعيد",
      persisted !== undefined &&
        sent !== undefined &&
        persisted.content === sent.content &&
        harness.getAppointmentWritesCount() === 0,
    );
    check(
      "7e. لم يتم استدعاء أي نموذج ذكاء اصطناعي لأمر /start بوجود عرض نشط",
      harness.getAiCallsCount() === 0,
    );
  }

  // ── 8. Active Booking Task Continuation Preserved (With Distinctive Override Seeded) ──
  {
    const harness = createTestHarness();
    const DISTINCTIVE_OVERRIDE =
      "تجاوز ترحيبي مميز جداً {businessName} XYZ_BOOKING_TASK_INTRUSION_GUARD";
    harness.setOverride("welcome.intro", DISTINCTIVE_OVERRIDE);

    const conversationId = harness.conversation.id;
    // Seed state with active booking task missing date
    const bookingTaskState = {
      ...emptyConversationState(),
      currentGoal: "BOOKING",
      bookingStage: "SERVICE_SUPPLIED" as const,
      activeTask: {
        kind: "BOOKING",
        stage: "SERVICE_SUPPLIED" as const,
      },
      knownFacts: {
        service: "كشف أسنان",
      },
      selectedService: "كشف أسنان",
      serviceId: PLAYGROUND_IDS.SERV_DENTAL,
    };
    await harness.stateStore.save(
      BUSINESS_ID,
      conversationId,
      null,
      dehydrateConversationState(bookingTaskState),
    );

    const result = await receiveInboundMessage(harness.deps, {
      externalId: "ext-start-active-task",
      from: CUSTOMER_PHONE,
      to: BOT_PHONE,
      text: "/start",
      receivedAt: harness.nowIso,
    });

    const sent = harness.sentMessages[0];
    const persisted = harness.messages.find((m) => m.senderType === "AI");
    const currentState = await harness.stateStore.load(
      BUSINESS_ID,
      conversationId,
    );

    check("8a. المعالجة ناجحة بوجود مهمة حجز نشطة", result.ok);
    check(
      "8b. يتم طلب تحديد التاريخ ولا يتم استهلاك أو تسريب تجاوز الترحيب المميز",
      sent !== undefined &&
        !sent.content.includes("XYZ_BOOKING_TASK_INTRUSION_GUARD") &&
        (sent.content.includes("التاريخ") || sent.content.includes("اليوم")),
    );
    check(
      "8c. هوية مهمة الحجز ومرحلتها والخدمة المحددة محفوظة تماماً",
      currentState?.activeTask?.kind === "BOOKING" &&
        currentState?.bookingStage === "SERVICE_SUPPLIED" &&
        currentState?.serviceId === PLAYGROUND_IDS.SERV_DENTAL,
    );
    check(
      "8d. نص الرسالة المخزن يطابق نص الإرسال ولم يتم إنشاء أو تعديل أي موعد",
      persisted !== undefined &&
        sent !== undefined &&
        persisted.content === sent.content &&
        harness.getAppointmentWritesCount() === 0,
    );
    check(
      "8e. لم يتم استدعاء أي نموذج ذكاء اصطناعي لأمر /start بوجود مهمة حجز نشطة",
      harness.getAiCallsCount() === 0,
    );
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
  console.error("Unhandled error:", err);
  process.exit(1);
});
