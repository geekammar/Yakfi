/**
 * FlowPilot — CTX-01 check: CURRENT MESSAGE DE-DUPLICATION (PERF-04).
 *
 * Focused, OFFLINE guard for the history/current separation at the
 * `buildAiContext` seam (no DB, no network, no LLM, no keys, no live
 * messaging). PERF-04 proved the current customer message was persisted
 * BEFORE `getMessages` ran, so the bounded history window already contained
 * it, and the SAME text was then sent again as the CURRENT message. CTX-01
 * narrows only the AI-facing window to PRIOR turns.
 *
 * Proves:
 *   A  CURRENT MESSAGE APPEARS ONCE — the rendered `buildPromptMessages`
 *      output carries the current message exactly once (CURRENT slot only).
 *   B  PRIOR HISTORY PRESERVED — earlier turns remain, in order, with their
 *      sender types intact.
 *   C  BOOKING SELECTION UNCHANGED — the deterministic 1/2/3 selection still
 *      reads the FULL window (offer detection + index parse), and the engine
 *      still routes the full window to that path.
 *   D  CLARIFICATION / CONTINUATION UNCHANGED — the AI marker / state
 *      detectors still resolve on the full window.
 *   E  DUPLICATE TEXT EDGE CASE — an earlier message repeating the current
 *      text is NOT removed; only this turn's row is excluded.
 *   F  EMPTY / FIRST TURN — the first message yields an EMPTY history window
 *      and a correct CURRENT message.
 *
 * Run: pnpm check:ctx-01
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { AiRequest } from "../src/features/conversations/server/ai-contract";

export {};

type Check = { label: string; pass: boolean };

async function main(): Promise<void> {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const engine =
    await import("../src/features/conversations/server/conversation-engine");
  const prompt = await import("../src/server/integrations/ai/prompt");
  const bookingSelection =
    await import("../src/features/conversations/server/booking-selection");
  const clarification =
    await import("../src/features/conversations/server/clarification");
  const conversationState =
    await import("../src/features/conversations/server/conversation-state");

  const checks: Check[] = [];
  function check(label: string, pass: boolean): void {
    checks.push({ label, pass });
  }

  // ── Engine harness (in-memory; no DB/network/LLM) ────────────────────────
  const BUSINESS_A = "11111111-1111-4111-8111-111111111111";
  const BRANCH_A = "44444444-4444-4444-8444-444444444444";
  const SERVICE_CLEAN = "33333333-3333-4333-8333-333333333333";
  const WHATSAPP = "+201001111111";
  const now = new Date();

  function openWeek(): Record<string, unknown> {
    const hours: Record<string, unknown> = {};
    for (const day of ["sat", "sun", "mon", "tue", "wed", "thu", "fri"]) {
      hours[day] = { open: "10:00", close: "18:00", closed: false };
    }
    return hours;
  }

  const business = {
    id: BUSINESS_A,
    name: "عيادة النور",
    vertical: null,
    city: null,
    whatsappNumber: WHATSAPP,
    timezone: "Africa/Cairo",
    about: null,
    workingHours: openWeek(),
    slotDurationMinutes: 30,
    confirmationMode: "manual",
    faqs: [{ question: "كم سعر التنظيف؟", answer: "سعر التنظيف ٣٠٠ جنيه." }],
    cancellationPolicy: null,
    onboardingCompletedAt: now,
    isActive: true,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    assistantName: null,
    assistantStyle: null,
    defaultBranchId: BRANCH_A,
  };

  const services = [
    {
      id: SERVICE_CLEAN,
      businessId: BUSINESS_A,
      name: "تنظيف أسنان",
      description: null,
      durationMinutes: 30,
      isActive: true,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      priceType: null,
      priceAmount: null,
      priceMaxAmount: null,
      priceCurrency: null,
      priceNote: null,
    },
  ];

  type StoredMessage = { id: string; senderType: string; content: string };

  /**
   * Runs a multi-turn conversation through the engine with in-memory deps.
   * Every AI request is captured; the AI replies with `action: reply` so the
   * assistant message is persisted and history accumulates like production.
   */
  async function runConversation(
    turns: Array<{ text: string; reply: string }>,
  ): Promise<{
    requests: AiRequest[];
    messages: StoredMessage[];
    results: Array<Record<string, unknown>>;
  }> {
    const requests: AiRequest[] = [];
    const messages: StoredMessage[] = [];
    const replies = turns.map((turn) => turn.reply);
    let conversation: Record<string, unknown> | null = null;
    let convSeq = 0;

    const deps = {
      businessRepository: {
        findByWhatsappNumber: async () => business,
        findById: async () => business,
      },
      branchRepository: {
        findDefaultByBusiness: async () => ({
          id: BRANCH_A,
          businessId: BUSINESS_A,
          name: "الفرع الرئيسي",
          isActive: true,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        }),
        findByIdWithinBusiness: async () => null,
      },
      customerRepository: {
        upsertByPhone: async () => ({
          id: "cust-1",
          businessId: BUSINESS_A,
          name: "عميل",
          phone: "+201234567890",
          notes: null,
          lastConversationAt: null,
          lastAppointmentAt: null,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        }),
        touchConversation: async () => undefined,
      },
      conversationRepository: {
        findLatestByCustomer: async () =>
          conversation ? { id: conversation.id } : null,
        findById: async () => conversation,
        create: async (input: {
          businessId: string;
          customerId: string;
          branchId: string | null;
        }) => {
          convSeq += 1;
          conversation = {
            id: `conv-${convSeq}`,
            businessId: input.businessId,
            customerId: input.customerId,
            branchId: input.branchId,
            status: "AI_ACTIVE",
            assignedUserId: null,
            aiSummary: null,
            lastMessageAt: now,
            createdAt: now,
            updatedAt: now,
          };
          return conversation;
        },
        addMessage: async (input: {
          conversationId: string;
          senderType: string;
          content: string;
          createdAt?: Date;
        }) => {
          const msg = {
            id: `msg-${messages.length + 1}`,
            conversationId: input.conversationId,
            senderType: input.senderType,
            content: input.content,
            createdAt: input.createdAt ?? new Date(),
            updatedAt: new Date(),
          };
          messages.push({
            id: msg.id,
            senderType: input.senderType,
            content: input.content,
          });
          return msg;
        },
        getMessages: async () => [...messages].reverse(),
        update: async () => conversation,
        updateWorkflow: async () => conversation,
      },
      serviceRepository: {
        listByBusiness: async () => [...services],
        findById: async () => null,
      },
      inboundDedupeRepository: {
        claim: async () => ({ status: "claimed" as const, claimId: "claim-1" }),
      },
      usageRepository: {
        record: async (input: { kind: string }) => input,
      },
      ai: {
        providerName: "fake-ai",
        respond: async (request: AiRequest) => {
          requests.push(request);
          return {
            intent: "FAQ",
            action: "reply",
            content: replies.shift() ?? "تمام",
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
        providerName: "fake-transport",
        send: async () => ({ provider: "fake-transport", delivered: true }),
      },
    } as unknown as Parameters<typeof engine.receiveInboundMessage>[0];

    const results: Array<Record<string, unknown>> = [];
    for (const [index, turn] of turns.entries()) {
      const result = (await engine.receiveInboundMessage(deps, {
        to: WHATSAPP,
        from: "+201234567890",
        text: turn.text,
        receivedAt: new Date().toISOString(),
        externalId: `wamid.CTX01-${index}`,
      })) as Record<string, unknown>;
      results.push(result);
    }
    return { requests, messages, results };
  }

  /** The rendered provider-facing user content for one request. */
  function renderedUserContent(request: AiRequest): string {
    const messages = prompt.buildPromptMessages(request);
    return messages.find((message) => message.role === "user")?.content ?? "";
  }

  /** How many rendered history lines carry this exact text. */
  function historyLineCount(request: AiRequest, text: string): number {
    return request.recentMessages.filter((message) => message.content === text)
      .length;
  }

  // ── F. EMPTY / FIRST TURN ────────────────────────────────────────────────
  {
    const first = await runConversation([
      { text: "عايز أحجز تنظيف أسنان", reply: "تمام، إنت عايز يوم إيه؟" },
    ]);
    const request = first.requests[0]!;
    const rendered = renderedUserContent(request);
    check(
      "F1 أول رسالة: نافذة التاريخ فارغة (recentMessages = [])",
      Array.isArray(request.recentMessages) &&
        request.recentMessages.length === 0,
    );
    check(
      "F2 أول رسالة: الرسالة الحالية تصل في خانة CURRENT مرة واحدة",
      request.message === "عايز أحجز تنظيف أسنان" &&
        rendered.includes("CURRENT message: عايز أحجز تنظيف أسنان"),
    );
    check(
      "F3 أول رسالة: لا يوجد سطر CUSTOMER مكرر في التاريخ المعروض",
      !rendered.includes("CUSTOMER: عايز أحجز تنظيف أسنان"),
    );
  }

  // ── A + B. CURRENT ONCE, PRIOR HISTORY PRESERVED ─────────────────────────
  {
    const run = await runConversation([
      { text: "عايز أحجز تنظيف أسنان", reply: "تمام، إنت عايز يوم إيه؟" },
      { text: "عايز يوم 2026-09-14", reply: "تمام جداً." },
      { text: "إكتبلي تفاصيل الموعد", reply: "حاضر، هكلموك." },
    ]);
    const request = run.requests[2]!;
    const rendered = renderedUserContent(request);
    const currentText = "إكتبلي تفاصيل الموعد";

    // A — the current message appears exactly once overall: once in the
    // CURRENT slot, and zero times as a history line.
    check(
      "A1 الرسالة الحالية تظهر مرة واحدة فقط في كامل البرومبت",
      rendered.split(`CURRENT message: ${currentText}`).length === 2 &&
        historyLineCount(request, currentText) === 0,
    );
    check(
      "A2 سجل التاريخ يحتوي 4 رسائل سابقة (عميل/مساعد/عميل/مساعد)",
      request.recentMessages.length === 4,
    );
    // B — prior turns preserved, in order, with their sender types. Customer
    // text is asserted verbatim; assistant text only by prefix (the engine
    // may append a fixed continuation invite to a knowledge answer).
    check(
      "B1 الرسائل السابقة محفوظة بالترتيب الصحيح ومن المرسل الصحيح",
      request.recentMessages.map((message) => message.senderType).join(",") ===
        "CUSTOMER,AI,CUSTOMER,AI" &&
        request.recentMessages[0]?.content === "عايز أحجز تنظيف أسنان" &&
        request.recentMessages[2]?.content === "عايز يوم 2026-09-14",
    );
    check(
      "B2 ردود المساعد السابقة محفوظة (بادئة النص الأصلية)",
      (request.recentMessages[1]?.content ?? "").startsWith(
        "تمام، إنت عايز يوم إيه؟",
      ) && (request.recentMessages[3]?.content ?? "").startsWith("تمام جداً."),
    );
    // The engine's own persisted window still contains the current row —
    // the de-duplication happens only at the AI context seam. (The assistant
    // reply is persisted AFTER it, so the customer row is the last CUSTOMER
    // row, not the final row.)
    check(
      "A3 الرسالة الحالية ما زالت محفوظة في السجل (الإزالة في السياق فقط)",
      run.messages.some(
        (message) =>
          message.senderType === "CUSTOMER" && message.content === currentText,
      ) &&
        [...run.messages]
          .reverse()
          .find((message) => message.senderType === "CUSTOMER")?.content ===
          currentText,
    );
  }

  // ── E. DUPLICATE TEXT EDGE CASE ──────────────────────────────────────────
  // An earlier turn already said "نعم"; this turn says "نعم" again. Only the
  // CURRENT row is dropped — the earlier "نعم" must survive in history.
  {
    const run = await runConversation([
      { text: "نعم", reply: "تمام." },
      { text: "عايز أحجز موعد", reply: "تمام." },
      { text: "نعم", reply: "تمام." },
    ]);
    const request = run.requests[2]!;
    const rendered = renderedUserContent(request);
    check(
      "E1 الرسالة السابقة المتطابقة نصاً (نعم) لم تُحذف من التاريخ",
      historyLineCount(request, "نعم") === 1,
    );
    check(
      "E2 الرسالة الحالية (نعم) تظهر مرة واحدة في خانة CURRENT فقط",
      rendered.split("CURRENT message: نعم").length === 2 &&
        request.message === "نعم",
    );
    check(
      "E3 التاريخ يحتوي الرسالتين السابقتين للعميل في موضعهما الصحيح",
      request.recentMessages.length === 4 &&
        request.recentMessages[0]?.content === "نعم" &&
        request.recentMessages[0]?.senderType === "CUSTOMER" &&
        request.recentMessages[2]?.content === "عايز أحجز موعد" &&
        request.recentMessages[2]?.senderType === "CUSTOMER",
    );
  }

  // ── C. BOOKING SELECTION UNCHANGED (deterministic, full window) ──────────
  {
    const OFFER =
      'تتوفر المواعيد التالية لخدمة "تنظيف أسنان" يوم 2026-09-14:\n' +
      "1. د. سارة — 10:00 إلى 10:30\n" +
      "2. د. أحمد — 11:00 إلى 11:30\n" +
      "3. د. منى — 12:00 إلى 12:30\n" +
      "يرجى اختيار أحد الخيارات وسيتواصل معك الفريق لإتمام الحجز.";
    // The FULL window the deterministic path receives: the customer's "1" is
    // the trailing entry, the offer sits right before it.
    const fullWindow = [
      { senderType: "CUSTOMER", content: "عايز أحجز تنظيف أسنان" },
      { senderType: "AI", content: OFFER },
      { senderType: "CUSTOMER", content: "1" },
    ];
    const context = bookingSelection.extractLastBookingOffer(fullWindow);
    const parsed = bookingSelection.tryParseBookingSelection("1", fullWindow);
    check(
      "C1 عرض الحجز يُكتشف من النافذة الكاملة (الرسالة الحالية آخر عنصر)",
      context !== null &&
        context.serviceName === "تنظيف أسنان" &&
        context.date === "2026-09-14" &&
        context.options.length === 3,
    );
    check(
      "C2 اختيار 1/2/3 ما زال يعتمد على recentChronological الكامل",
      parsed !== null &&
        parsed.selection.kind === "index" &&
        parsed.selection.index === 1,
    );
    // The index is resolved against the OFFERED options (not the window tail).
    const parsedThree = bookingSelection.tryParseBookingSelection(
      "3",
      fullWindow,
    );
    check(
      "C3 اختيار 3 يُحل من قائمة الخيارات المعروضة",
      parsedThree !== null &&
        parsedThree.selection.kind === "index" &&
        parsedThree.selection.index === 3,
    );
    // No offer in history ⇒ no selection context (falls through to the AI).
    check(
      "C4 بلا عرض في التاريخ لا يوجد سياق اختيار (مسار الذكاء)",
      bookingSelection.extractLastBookingOffer([
        { senderType: "CUSTOMER", content: "1" },
      ]) === null,
    );
  }

  // ── D. CLARIFICATION / CONTINUATION / STATE UNCHANGED (full window) ──────
  {
    const CLARIFY = clarification.CLARIFY_INTENT_QUESTION;
    const fullWindowWithClarify = [
      { senderType: "CUSTOMER", content: "عايز أسأل" },
      { senderType: "AI", content: CLARIFY },
      { senderType: "CUSTOMER", content: "عايز أحجز موعد" },
    ];
    check(
      "D1 كشف التوضيح المعلق ما زال يعمل على النافذة الكاملة",
      clarification.derivePendingClarification(fullWindowWithClarify)?.type ===
        "CLARIFY_INTENT",
    );
    const fullWindowWithContinue = [
      { senderType: "CUSTOMER", content: "كم سعر التنظيف؟" },
      {
        senderType: "AI",
        content: `سعر التنظيف ٣٠٠ جنيه.\n\n${clarification.CONTINUE_DOMAIN_INVITE}`,
      },
      { senderType: "CUSTOMER", content: "عايز أحجز" },
    ];
    check(
      "D2 كشف الاستئناف المعلق (answer-and-continue) ما زال يعمل",
      clarification.derivePendingContinuation(fullWindowWithContinue)
        ?.intent === "BOOKING",
    );
    const OFFER_D =
      'تتوفر المواعيد التالية لخدمة "تنظيف أسنان" يوم 2026-09-14:\n' +
      "1. د. سارة — 10:00 إلى 10:30\n" +
      "يرجى اختيار أحد الخيارات وسيتواصل معك الفريق لإتمام الحجز.";
    const state = conversationState.deriveConversationStateFromHistory([
      { senderType: "CUSTOMER", content: "عايز أحجز تنظيف أسنان" },
      { senderType: "AI", content: OFFER_D },
      { senderType: "CUSTOMER", content: "1" },
    ]);
    check(
      "D3 اشتقاق حالة المحادثة من التاريخ الكامل غير متأثر",
      state.bookingStage === "AVAILABILITY_RESOLVED" &&
        state.selectedService === "تنظيف أسنان",
    );
    // A non-marker last AI message yields nothing pending — unchanged.
    check(
      "D4 رسالة مساعد عادية لا تنتج توضيحاً ولا استئنافاً",
      clarification.derivePendingClarification([
        { senderType: "CUSTOMER", content: "أهلاً" },
        { senderType: "AI", content: "أهلاً بك!" },
        { senderType: "CUSTOMER", content: "شكراً" },
      ]) === null &&
        clarification.derivePendingContinuation([
          { senderType: "CUSTOMER", content: "أهلاً" },
          { senderType: "AI", content: "أهلاً بك!" },
          { senderType: "CUSTOMER", content: "شكراً" },
        ]) === null,
    );
  }

  // ── C/D wiring: the engine routes the FULL window to the deterministic
  //    paths and the PRIOR-only window to the AI context seam. A static guard
  //    against a future regression that narrows the wrong consumer.
  {
    const source = readFileSync(
      join(
        process.cwd(),
        "src/features/conversations/server/conversation-engine.ts",
      ),
      "utf8",
    );
    const priorOnlyName = "recentMessagesBeforeCurrent";
    const definitions = source.match(
      new RegExp(`const ${priorOnlyName} =`, "g"),
    );
    const priorUsages = source.match(new RegExp(`\\b${priorOnlyName}\\b`, "g"));
    check(
      "W1 النافذة السابقة (قبل الرسالة الحالية) معرَّفة ومستخدمة مرة واحدة فقط",
      definitions !== null &&
        definitions.length === 1 &&
        priorUsages !== null &&
        priorUsages.length === 2,
    );
    check(
      "W2 مسار buildAiContext يستقبل النافذة السابقة (قبل الحالية)",
      /conversation:\s*\{\s*status:\s*conversation\.status,\s*recentMessages:\s*recentMessagesBeforeCurrent,/.test(
        source,
      ),
    );
    check(
      "W3 اختيار الحجز الحتمي يستقبل recentChronological الكامل",
      /tryParseBookingSelection\(\s*inbound\.text,\s*recentChronological\s*,?\s*\)/.test(
        source,
      ),
    );
    check(
      "W4 حلَّال الدورة + اشتقاق الحالة يستقبلان recentChronological الكامل",
      /resolveFinishedTurn\(\s*recentChronological\s*,/.test(source) &&
        /observeConversationStateTransition\(\s*recentChronological\s*,/.test(
          source,
        ),
    );
    check(
      "W5 الاستبعاد يتم بمعرّف الصف (identity) وليس بحذف العنصر الأخير أو نصه",
      new RegExp(
        `\\.filter\\(\\(message\\) => message\\.id !== customerMessage\\.id\\)`,
      ).test(source) && !/slice\(0,\s*-1\)/.test(source),
    );
  }

  // ── Report ───────────────────────────────────────────────────────────────
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
    `\nCTX-01 فصل التاريخ/الحالية سليم: ${checks.length}/${checks.length} فحص ناجح.`,
  );
}

main().catch((error: Error) => {
  console.error(`فشل غير متوقع: ${error.message}`);
  process.exit(1);
});
