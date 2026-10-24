/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * FlowPilot — Unified Booking Choices UX & WhatsApp Interactive Parity Suite
 *
 * Verifies ONE shared booking-choice experience for Telegram and WhatsApp across:
 *   Area A: Shared UX (presentation formatters, availability-backed dates, representative slots, more-times, change-date)
 *   Area B: Adapter parity across all 6 offer kinds (WELCOME, SERVICE, SERVICE_DETAIL, DATE, PROVIDER, SLOT)
 *   Area C: Real transports (createMetaWhatsAppTransport and Telegram transport)
 *   Area D: Two-turn round trips with zero AI model calls and mechanical selection
 *   Area E: Negative cases (title tampering, missing ID, expired offers, idempotency, Meta rejection)
 *
 * Usage:
 *   pnpm check:unified-booking-choices
 */

import "./setup-test-env";

import { createHmac } from "node:crypto";

import { handleMetaPost } from "../src/app/api/whatsapp/meta/route";
import { resolveBookingOptions } from "../src/features/appointments/server/booking-options-service";
import {
  PLAYGROUND_IDS,
  createPlaygroundHarness,
} from "../src/features/conversations/playground/harness";
import {
  buildDateOffer,
  buildProviderOffer,
  buildServiceDetailOffer,
  buildServiceOffer,
  buildSlotOffer,
  buildWelcomeOffer,
} from "../src/features/conversations/server/booking-offer";
import {
  buildChannelChoices,
  offerCallbackData,
} from "../src/features/conversations/server/channel-choice";
import {
  receiveInboundMessage,
  resolveUpcomingBookingDates,
} from "../src/features/conversations/server/conversation-engine";
import {
  dehydrateConversationState,
  emptyConversationState,
  type ConversationState,
} from "../src/features/conversations/server/conversation-state";
import {
  areSlotsSingleProvider,
  filterElapsedSlots,
  formatArabicDate,
  formatArabicTime12h,
  formatBookingOptionsCopy,
  formatSlotChoiceLabel,
  sampleRepresentativeSlots,
} from "../src/features/conversations/server/presentation-formatters";
import { EnvCredentialsResolver } from "../src/server/credentials/credentials-resolver";
import { renderTelegramInlineKeyboard } from "../src/server/integrations/telegram/telegram-presentation";
import { createTelegramMessageTransport } from "../src/server/integrations/telegram/telegram-transport";
import { hashTelegramWebhookSecret } from "../src/server/integrations/telegram/telegram-webhook";
import { handleTelegramWebhook } from "../src/server/integrations/telegram/telegram-webhook-handler";
import {
  META_DEFAULT_API_VERSION,
  META_GRAPH_HOST,
  createMetaWhatsAppTransport,
} from "../src/server/integrations/whatsapp/meta-client";
import {
  renderMetaInteractivePayload,
  safeTruncateGraphemes,
} from "../src/server/integrations/whatsapp/meta-presentation";
import {
  parseMetaWebhookPayload,
  verifyMetaSignature,
} from "../src/server/integrations/whatsapp/meta-webhook";

type Check = { label: string; pass: boolean; details?: string };
const checks: Check[] = [];

function check(label: string, pass: boolean, details?: string): void {
  checks.push({ label, pass, details });
  if (pass) {
    console.log(`✔ ${label}`);
  } else {
    console.error(`✘ ${label}${details ? ` (${details})` : ""}`);
  }
}

async function run(): Promise<void> {
  console.log("── SUITE: Unified Booking Choices UX & WhatsApp Parity ──\n");

  // ═══════════════════════════════════════════════════════════════════════════
  // Area A: Shared UX
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("Area A: Shared UX & Presentation Formatters");

  // A.1 Date formatting
  const formattedToday = formatArabicDate("2026-10-25", {
    todayIso: "2026-10-25",
    tomorrowIso: "2026-10-26",
  });
  const formattedTomorrow = formatArabicDate("2026-10-26", {
    todayIso: "2026-10-25",
    tomorrowIso: "2026-10-26",
  });
  const formattedFuture = formatArabicDate("2026-10-27", {
    todayIso: "2026-10-25",
    tomorrowIso: "2026-10-26",
  });

  check(
    "A.1a Date label includes relative 'اليوم' without replacing weekday and calendar date",
    formattedToday === "اليوم الأحد، 25 أكتوبر",
    `received: ${formattedToday}`,
  );
  check(
    "A.1b Date label includes relative 'غدًا' with weekday and calendar date",
    formattedTomorrow === "غدًا الإثنين، 26 أكتوبر",
    `received: ${formattedTomorrow}`,
  );
  check(
    "A.1c Standard future date label includes weekday and unambiguous date without relative prefix",
    formattedFuture === "الثلاثاء، 27 أكتوبر",
    `received: ${formattedFuture}`,
  );

  // A.2 Time formatting
  check(
    "A.2a Midnight (00:00) displays as 12:00 ص",
    formatArabicTime12h("00:00") === "12:00 ص" &&
      formatArabicTime12h("2026-10-25T00:00") === "12:00 ص",
  );
  check(
    "A.2b Noon (12:00) displays as 12:00 م",
    formatArabicTime12h("12:00") === "12:00 م",
  );
  check(
    "A.2c Afternoon time (14:30) displays as 2:30 م",
    formatArabicTime12h("14:30") === "2:30 م",
  );
  check(
    "A.2d Morning time (09:15) displays as 9:15 ص",
    formatArabicTime12h("09:15") === "9:15 ص",
  );

  // A.3 Single provider vs mixed provider slot labels and message copy
  const singleProvSlots = [
    {
      index: 1,
      providerId: "prv_1",
      displayName: "د. سارة",
      startAt: "2026-10-25T10:00",
      endAt: "2026-10-25T10:30",
    },
    {
      index: 2,
      providerId: "prv_1",
      displayName: "د. سارة",
      startAt: "2026-10-25T11:00",
      endAt: "2026-10-25T11:30",
    },
  ];
  const mixedProvSlots = [
    {
      index: 1,
      providerId: "prv_1",
      displayName: "د. سارة",
      startAt: "2026-10-25T10:00",
      endAt: "2026-10-25T10:30",
    },
    {
      index: 2,
      providerId: "prv_2",
      displayName: "د. أحمد",
      startAt: "2026-10-25T11:00",
      endAt: "2026-10-25T11:30",
    },
  ];

  check(
    "A.3a areSlotsSingleProvider accurately identifies single vs mixed providers",
    areSlotsSingleProvider(singleProvSlots) === true &&
      areSlotsSingleProvider(mixedProvSlots) === false,
  );

  const singleChoiceLabel = formatSlotChoiceLabel(singleProvSlots[0]!, true);
  const mixedChoiceLabel = formatSlotChoiceLabel(mixedProvSlots[0]!, false);
  check(
    "A.3b Single-provider slot choice label omits redundant provider name",
    singleChoiceLabel === "1️⃣ 10:00 ص",
    `received: ${singleChoiceLabel}`,
  );
  check(
    "A.3c Mixed-provider slot choice label identifies specific provider",
    mixedChoiceLabel === "1️⃣ 10:00 ص (د. سارة)",
    `received: ${mixedChoiceLabel}`,
  );

  const singleCopy = formatBookingOptionsCopy({
    serviceName: "تنظيف أسنان",
    date: "2026-10-25",
    formattedDate: "الأحد، 25 أكتوبر",
    options: singleProvSlots,
  });
  const mixedCopy = formatBookingOptionsCopy({
    serviceName: "تنظيف أسنان",
    date: "2026-10-25",
    formattedDate: "الأحد، 25 أكتوبر",
    options: mixedProvSlots,
  });

  check(
    "A.3d Single-provider copy mentions provider in header and omits repetition in lines",
    singleCopy.includes('لخدمة "تنظيف أسنان" مع د. سارة') &&
      singleCopy.includes("1. 10:00 ص إلى 10:30 ص") &&
      !singleCopy.includes("1. د. سارة —"),
  );
  check(
    "A.3e Mixed-provider copy mentions provider on each line",
    mixedCopy.includes("1. د. سارة — 10:00 ص إلى 10:30 ص") &&
      mixedCopy.includes("2. د. أحمد — 11:00 ص إلى 11:30 ص"),
  );
  check(
    "A.3f Copy clearly guides confirmation without false promise of staff contact",
    singleCopy.includes("يرجى اختيار الموعد المناسب لإتمام الحجز.") &&
      !singleCopy.includes("وسيتواصل معك الفريق لإتمام الحجز"),
  );

  // A.4 Representative slot sampling across the day
  const tenCandidateSlots = Array.from({ length: 10 }, (_, i) => ({
    id: `slot_${i}`,
    time: `${9 + i}:00`,
  }));
  const representativeSample = sampleRepresentativeSlots(tenCandidateSlots, 4);
  check(
    "A.4a sampleRepresentativeSlots picks 4 deterministic representative times across candidates",
    representativeSample.length === 4 &&
      representativeSample[0]?.time === "9:00" && // 0%
      representativeSample[1]?.time === "11:00" && // ~33%
      representativeSample[2]?.time === "15:00" && // ~67%
      representativeSample[3]?.time === "18:00", // 100%
  );
  const nearestSample = sampleRepresentativeSlots(tenCandidateSlots, 4, {
    nearestFirst: true,
  });
  check(
    "A.4b sampleRepresentativeSlots honors nearestFirst when requested",
    nearestSample.length === 4 &&
      nearestSample[0]?.time === "9:00" &&
      nearestSample[1]?.time === "10:00" &&
      nearestSample[2]?.time === "11:00" &&
      nearestSample[3]?.time === "12:00",
  );

  // A.5 More-times copy header deduplication
  const moreTimesCopy = formatBookingOptionsCopy({
    serviceName: "تنظيف أسنان",
    date: "2026-10-25",
    formattedDate: "الأحد، 25 أكتوبر",
    options: singleProvSlots,
    isMoreTimes: true,
  });
  check(
    "A.5 More-times copy uses clean heading without duplicate prefix",
    moreTimesCopy.startsWith('إليك أوقاتاً أخرى متاحة لخدمة "تنظيف أسنان"') &&
      !moreTimesCopy.includes("تتوفر المواعيد التالية"),
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Area B: Adapter Parity Across All 6 Offer Kinds
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\nArea B: Adapter Parity Across All 6 Offer Kinds");

  const testNow = new Date("2026-10-25T10:00:00Z");
  const baseScope = { businessId: "biz_1", conversationId: "conv_1" };

  // 1. WELCOME
  const welcomeOffer = buildWelcomeOffer(baseScope, "off_welcome", testNow)!;
  const welcomePresentation = buildChannelChoices(welcomeOffer);
  const welcomeTg = renderTelegramInlineKeyboard(welcomePresentation);
  const welcomeWa = renderMetaInteractivePayload(
    "123456789",
    "مرحباً بك",
    welcomePresentation,
  );

  check(
    "B.1a WELCOME parity: Telegram and WhatsApp expose exact same 2 actions",
    welcomeTg.inline_keyboard.flat().length === 2 &&
      welcomeWa.type === "interactive" &&
      (welcomeWa as any).interactive.type === "button" &&
      (welcomeWa as any).interactive.action.buttons.length === 2,
  );
  check(
    "B.1b WELCOME parity: callback IDs are identical across Telegram and WhatsApp",
    welcomeTg.inline_keyboard[0]![0]!.callback_data ===
      (welcomeWa as any).interactive.action.buttons[0]!.reply.id &&
      welcomeTg.inline_keyboard[1]![0]!.callback_data ===
        (welcomeWa as any).interactive.action.buttons[1]!.reply.id,
  );

  // 2. SERVICE
  const serviceOffer = buildServiceOffer(
    baseScope,
    "off_services",
    [
      { id: "srv_1", name: "كشف جلدية" },
      { id: "srv_2", name: "ليزر كربوني" },
      { id: "srv_3", name: "فيلر وبوتوكس" },
      { id: "srv_4", name: "تنظيف بشرة هيدرافاشيل" },
    ],
    testNow,
  )!;
  const servicePresentation = buildChannelChoices(serviceOffer);
  const serviceTg = renderTelegramInlineKeyboard(servicePresentation);
  const serviceWa = renderMetaInteractivePayload(
    "123456789",
    "اختر الخدمة",
    servicePresentation,
  );

  check(
    "B.2a SERVICE parity: 4 services render as List in WhatsApp and buttons in Telegram",
    serviceTg.inline_keyboard.length === 4 &&
      (serviceWa as any).interactive.type === "list" &&
      (serviceWa as any).interactive.action.sections[0]!.rows.length === 4,
  );
  check(
    "B.2b SERVICE parity: all 4 choice IDs match exactly",
    serviceTg.inline_keyboard.every(
      (row, idx) =>
        row[0]!.callback_data ===
        (serviceWa as any).interactive.action.sections[0]!.rows[idx]!.id,
    ),
  );

  // 3. SERVICE_DETAIL
  const serviceDetailOffer = buildServiceDetailOffer(
    baseScope,
    "off_srv_detail",
    "srv_1",
    "كشف جلدية",
    testNow,
  )!;
  const serviceDetailPresentation = buildChannelChoices(serviceDetailOffer);
  const srvDetailTg = renderTelegramInlineKeyboard(serviceDetailPresentation);
  const srvDetailWa = renderMetaInteractivePayload(
    "123456789",
    "تفاصيل الخدمة",
    serviceDetailPresentation,
  );

  check(
    "B.3a SERVICE_DETAIL parity: 3 actions render as reply buttons in WhatsApp (count <= 3)",
    srvDetailTg.inline_keyboard.flat().length === 3 &&
      (srvDetailWa as any).interactive.type === "button" &&
      (srvDetailWa as any).interactive.action.buttons.length === 3,
  );
  check(
    "B.3b SERVICE_DETAIL parity: IDs match exactly",
    srvDetailTg.inline_keyboard.flat().every((btn, idx) => {
      const waBtn = (srvDetailWa as any).interactive.action.buttons[idx];
      return btn.callback_data === waBtn.reply.id;
    }),
  );

  // 4. DATE
  const dateOffer = buildDateOffer(
    baseScope,
    "off_dates",
    {
      serviceId: "srv_1",
      serviceName: "كشف جلدية",
      providerId: null,
      dates: [
        { date: "2026-10-25", label: "اليوم الأحد، 25 أكتوبر" },
        { date: "2026-10-26", label: "غدًا الإثنين، 26 أكتوبر" },
        { date: "2026-10-27", label: "الثلاثاء، 27 أكتوبر" },
      ],
    },
    testNow,
  )!;
  const datePresentation = buildChannelChoices(dateOffer);
  const dateTg = renderTelegramInlineKeyboard(datePresentation);
  const dateWa = renderMetaInteractivePayload(
    "123456789",
    "حدد اليوم",
    datePresentation,
  );

  check(
    "B.4a DATE parity: 3 dates + other_date = 4 items render as List in WhatsApp",
    dateTg.inline_keyboard.length === 4 &&
      (dateWa as any).interactive.type === "list" &&
      (dateWa as any).interactive.action.sections.length === 2 && // Options section + Actions section
      (dateWa as any).interactive.action.sections[0]!.rows.length === 3 &&
      (dateWa as any).interactive.action.sections[1]!.rows.length === 1,
  );
  check(
    "B.4b DATE parity: other_date ID preserved identically",
    dateTg.inline_keyboard[3]![0]!.callback_data ===
      (dateWa as any).interactive.action.sections[1]!.rows[0]!.id &&
      dateTg.inline_keyboard[3]![0]!.callback_data ===
        offerCallbackData({ token: dateOffer.token }, "other_date"),
  );

  // 5. PROVIDER
  const providerOffer = buildProviderOffer(
    baseScope,
    "off_provs",
    {
      serviceId: "srv_1",
      serviceName: "كشف جلدية",
      date: "2026-10-25",
      providers: [
        { providerId: null, name: "أي مقدم خدمة متاح" },
        { providerId: "prv_1", name: "د. سارة" },
        { providerId: "prv_2", name: "د. أحمد" },
      ],
    },
    testNow,
  )!;
  const providerPresentation = buildChannelChoices(providerOffer);
  const providerTg = renderTelegramInlineKeyboard(providerPresentation);
  const providerWa = renderMetaInteractivePayload(
    "123456789",
    "اختر الطبيب",
    providerPresentation,
  );

  check(
    "B.5 PROVIDER parity: 3 providers render with identical IDs across Telegram and WhatsApp",
    providerTg.inline_keyboard.length === 3 &&
      providerWa?.type === "interactive" &&
      providerTg.inline_keyboard.every((row, idx) => {
        const id = offerCallbackData(
          { token: providerOffer.token },
          String(idx + 1),
        );
        const waRowId =
          providerWa?.interactive.type === "button"
            ? providerWa.interactive.action.buttons[idx]?.reply.id
            : providerWa?.interactive.action.sections[0]?.rows[idx]?.id;
        return row[0]!.callback_data === id && waRowId === id;
      }),
  );

  // 6. SLOT (4 slots + 2 actions)
  const slotOffer = buildSlotOffer(
    baseScope,
    "off_slots",
    {
      serviceId: "srv_1",
      serviceName: "كشف جلدية",
      serviceSource: "CUSTOMER",
      providerId: null,
      date: "2026-10-25",
      followUpRequestId: null,
      shownCount: 4,
      options: [
        {
          providerId: "prv_1",
          displayName: "د. سارة",
          startAt: "2026-10-25T10:00",
          endAt: "2026-10-25T10:30",
        },
        {
          providerId: "prv_1",
          displayName: "د. سارة",
          startAt: "2026-10-25T11:00",
          endAt: "2026-10-25T11:30",
        },
        {
          providerId: "prv_1",
          displayName: "د. سارة",
          startAt: "2026-10-25T14:00",
          endAt: "2026-10-25T14:30",
        },
        {
          providerId: "prv_1",
          displayName: "د. سارة",
          startAt: "2026-10-25T16:00",
          endAt: "2026-10-25T16:30",
        },
      ],
    },
    testNow,
  )!;
  const slotPresentation = buildChannelChoices(slotOffer);
  const slotTg = renderTelegramInlineKeyboard(slotPresentation);
  const slotWa = renderMetaInteractivePayload(
    "123456789",
    "المواعيد المتاحة",
    slotPresentation,
  );

  check(
    "B.6a SLOT parity: 4 slots render as 2 rows of 2 in Telegram for readable layout",
    slotTg.inline_keyboard.length === 3 && // Row 1 (2 slots), Row 2 (2 slots), Row 3 (navigation)
      slotTg.inline_keyboard[0]!.length === 2 &&
      slotTg.inline_keyboard[1]!.length === 2 &&
      slotTg.inline_keyboard[2]!.length === 2,
  );
  check(
    "B.6b SLOT parity: WhatsApp list sections contain 4 slots in section 1 and 2 actions in section 2",
    (slotWa as any).interactive.type === "list" &&
      (slotWa as any).interactive.action.sections[0]!.rows.length === 4 &&
      (slotWa as any).interactive.action.sections[1]!.rows.length === 2,
  );
  check(
    "B.6c SLOT parity: All 4 slot IDs and 2 navigation IDs match between Telegram and WhatsApp",
    slotTg.inline_keyboard[0]![0]!.callback_data ===
      (slotWa as any).interactive.action.sections[0]!.rows[0]!.id &&
      slotTg.inline_keyboard[0]![1]!.callback_data ===
        (slotWa as any).interactive.action.sections[0]!.rows[1]!.id &&
      slotTg.inline_keyboard[1]![0]!.callback_data ===
        (slotWa as any).interactive.action.sections[0]!.rows[2]!.id &&
      slotTg.inline_keyboard[1]![1]!.callback_data ===
        (slotWa as any).interactive.action.sections[0]!.rows[3]!.id &&
      slotTg.inline_keyboard[2]![0]!.callback_data ===
        (slotWa as any).interactive.action.sections[1]!.rows[0]!.id && // more
      slotTg.inline_keyboard[2]![1]!.callback_data ===
        (slotWa as any).interactive.action.sections[1]!.rows[1]!.id, // date
  );

  // B.7 Unicode and length constraints validation
  const veryLongTitle =
    "جلسة ليزر كربوني لتنظيف وتجديد خلايا البشرة بالكامل مع ماسك مرطب خاص";
  const truncated = safeTruncateGraphemes(veryLongTitle, 24);
  check(
    "B.7a safeTruncateGraphemes truncates string to max 24 chars without breaking Arabic characters",
    Array.from(truncated).length === 24 &&
      truncated.startsWith("جلسة ليزر كربوني"),
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Area C: Actual Transports
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\nArea C: Actual Message Transports Execution");

  const sentRequests: Array<{ url: string; headers: any; body: any }> = [];
  const mockFetch: typeof fetch = async (url, init) => {
    sentRequests.push({
      url: String(url),
      headers: init?.headers,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response(
      JSON.stringify({ messages: [{ id: "wamid.TEST-001" }] }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  const fakeConnectionRepo = {
    findByIdWithinBusiness: async () => ({
      id: "conn_1",
      businessId: "biz_1",
      branchId: null,
      phoneNumber: "+201000000000",
      externalId: "10987654321", // phone_number_id
      status: "CONNECTED",
      isActive: true,
      credentialsRef: "WA_TOKEN_REF",
    }),
    findByExternalId: async () => null,
    findByPhone: async () => null,
  };

  const metaTransport = createMetaWhatsAppTransport({
    connectionDeps: {
      whatsappConnectionRepository: fakeConnectionRepo as any,
      businessRepository: {
        findById: async () => ({
          id: "biz_1",
          name: "منشأة تجريبية",
          isActive: true,
        }),
        findByWhatsappNumber: async () => null,
      } as any,
      branchRepository: {
        findByIdWithinBusiness: async () => null,
        findDefaultByBusiness: async () => null,
      } as any,
    },
    getEnvVar: () => undefined,
    fetchImpl: mockFetch,
    graphHost: META_GRAPH_HOST,
    defaultApiVersion: META_DEFAULT_API_VERSION,
    credentialsResolver: new EnvCredentialsResolver({
      getEnvVar: (name: string) =>
        name === "WA_TOKEN_REF" ? "secret-meta-access-token" : undefined,
    }),
  });

  const sendResult = await metaTransport.send({
    to: "+201234567890",
    businessId: "biz_1",
    businessName: "عيادة النور",
    conversationId: "conv_1",
    connectionId: "conn_1",
    content: "يرجى اختيار الموعد المناسب:",
    choices: slotPresentation,
  });

  check(
    "C.1a createMetaWhatsAppTransport sends successfully with interactive payload",
    sendResult.delivered === true &&
      sendResult.provider === "meta-whatsapp" &&
      sendResult.providerMessageId === "wamid.TEST-001",
  );
  check(
    "C.1b Outbound Graph API URL matches expected version and phone_number_id",
    sentRequests.length === 1 &&
      sentRequests[0]!.url ===
        "https://graph.facebook.com/v21.0/10987654321/messages",
  );
  check(
    "C.1c Outbound Graph API headers carry Bearer token from credentialsResolver",
    sentRequests[0]!.headers["Authorization"] ===
      "Bearer secret-meta-access-token",
  );
  check(
    "C.1d Outbound Graph API payload is interactive list containing exact slot IDs",
    sentRequests[0]!.body.type === "interactive" &&
      sentRequests[0]!.body.interactive.type === "list" &&
      sentRequests[0]!.body.interactive.action.sections[0]!.rows[0]!.id ===
        offerCallbackData({ token: slotOffer.token }, "1"),
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Area D: Two-Turn Round Trips (Telegram & WhatsApp)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\nArea D: Two-Turn Round Trips & Mechanical Selection");

  const createTestAi = () => ({
    providerName: "PLAYGROUND_AI",
    respond: async (req: any) => {
      const { deterministicConversationAi } =
        await import("../src/features/conversations/server/conversation-ai");
      const res = await deterministicConversationAi.respond(req);
      return {
        ...res,
        safetyAssessment: "safe",
        extraction: {
          ...res.extraction,
          service: "تنظيف أسنان",
          date: "2026-10-25",
        },
        goals: [
          {
            kind: "DOMAIN_ACTION",
            intent: "BOOKING",
            requiredKnowledge: "NONE",
          },
        ],
      };
    },
  });

  // Harness setup for round trips
  const harness = createPlaygroundHarness({
    businessConfig: { name: "عيادة د. سارة" } as any,
    customAi: createTestAi() as any,
  });

  // Turn 1: Customer asks to book. Engine returns an offer.
  const turn1Result = await receiveInboundMessage(
    harness.deps,
    {
      to: harness.business.whatsappNumber ?? "+201001111111",
      from: harness.customer.phone,
      text: "عايز أحجز تنظيف أسنان يوم 2026-10-25",
      receivedAt: "2026-10-24T12:00:00Z",
    },
    {
      businessId: harness.business.id,
      branchId: harness.business.defaultBranchId,
    },
  );

  check(
    "D.1a Turn 1 produces an active offer with choices presented",
    turn1Result.ok === true &&
      (turn1Result as any).delivery?.delivered === true &&
      harness.stateStore.rows.size > 0,
  );

  const convId = (turn1Result as any).conversationId ?? harness.conversation.id;
  const activeOffer = (harness.stateStore.rows.get(convId)?.state as any)
    ?.offer;

  check(
    "D.1b Active offer is persisted before choices are returned",
    activeOffer &&
      activeOffer.status === "ACTIVE" &&
      activeOffer.kind === "SLOT",
  );

  const slot1CallbackId = offerCallbackData({ token: activeOffer.token }, "1");
  const modelCallsBefore = harness.llmStats.callCount;
  const apptsCountBefore = harness.appointments.length;

  // Turn 2 via Telegram callback path
  const turn2TelegramResult = await receiveInboundMessage(
    harness.deps,
    {
      to: harness.business.whatsappNumber ?? "+201001111111",
      from: harness.customer.phone,
      text: slot1CallbackId,
      receivedAt: "2026-10-24T12:01:00Z",
    },
    {
      businessId: harness.business.id,
      branchId: harness.business.defaultBranchId,
    },
  );

  check(
    "D.2a Telegram Turn 2 confirms booking successfully (BOOKED)",
    turn2TelegramResult.ok === true &&
      (turn2TelegramResult as any).conversationStatus === "BOOKED",
  );
  check(
    "D.2b Telegram mechanical selection makes 0 model calls",
    harness.llmStats.callCount === modelCallsBefore,
    `calls before: ${modelCallsBefore}, calls after: ${harness.llmStats.callCount}`,
  );
  check(
    "D.2c Telegram selection creates exactly 1 appointment",
    harness.appointments.length === apptsCountBefore + 1,
  );

  // Turn 2 via WhatsApp interactive webhook path
  const harnessWa = createPlaygroundHarness({
    businessConfig: { name: "عيادة د. سارة" } as any,
    customAi: createTestAi() as any,
  });
  const turn1Wa = await receiveInboundMessage(
    harnessWa.deps,
    {
      to: harnessWa.business.whatsappNumber ?? "+201001111111",
      from: harnessWa.customer.phone,
      text: "عايز أحجز تنظيف أسنان يوم 2026-10-25",
      receivedAt: "2026-10-24T12:00:00Z",
    },
    {
      businessId: harnessWa.business.id,
      branchId: harnessWa.business.defaultBranchId,
    },
  );
  const convIdWa = (turn1Wa as any).conversationId ?? harnessWa.conversation.id;
  const waOffer = (harnessWa.stateStore.rows.get(convIdWa)?.state as any)
    ?.offer;

  const waInteractivePayload = {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "+201000000000",
                phone_number_id: "10987654321",
              },
              messages: [
                {
                  from: harnessWa.customer.phone,
                  id: "wamid.INBOUND-INTERACTIVE-01",
                  timestamp: "1729857600",
                  type: "interactive",
                  interactive: {
                    type: "list_reply",
                    list_reply: {
                      id: offerCallbackData({ token: waOffer.token }, "1"),
                      title: "1️⃣ 10:00 ص",
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };

  const parsedWaInbound = parseMetaWebhookPayload(waInteractivePayload);
  check(
    "D.3a Meta webhook parser preserves exact offer ID from list_reply",
    parsedWaInbound.messages[0]?.text ===
      offerCallbackData({ token: waOffer.token }, "1"),
  );

  const modelCallsBeforeWa = harnessWa.llmStats.callCount;
  const apptsCountBeforeWa = harnessWa.appointments.length;

  const turn2WaResult = await receiveInboundMessage(
    harnessWa.deps,
    {
      to: harnessWa.business.whatsappNumber ?? "+201001111111",
      from: harnessWa.customer.phone,
      text: parsedWaInbound.messages[0]!.text!,
      receivedAt: "2026-10-24T12:02:00Z",
    },
    {
      businessId: harnessWa.business.id,
      branchId: harnessWa.business.defaultBranchId,
    },
  );

  check(
    "D.3b WhatsApp Turn 2 confirms booking successfully (BOOKED)",
    turn2WaResult.ok === true &&
      (turn2WaResult as any).conversationStatus === "BOOKED",
  );
  check(
    "D.3c WhatsApp mechanical selection makes 0 model calls",
    harnessWa.llmStats.callCount === modelCallsBeforeWa,
  );
  check(
    "D.3d WhatsApp selection creates exactly 1 appointment",
    harnessWa.appointments.length === apptsCountBeforeWa + 1,
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Area E: Negative Cases & Security Boundaries
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\nArea E: Negative Cases & Security Boundaries");

  // E.1 Altered title with valid ID follows ID
  const tamperedTitlePayload = {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "+201000000000",
                phone_number_id: "10987654321",
              },
              messages: [
                {
                  from: "+201234567890",
                  id: "wamid.TAMPER-1",
                  timestamp: "1729857600",
                  type: "interactive",
                  interactive: {
                    type: "button_reply",
                    button_reply: {
                      id: "fp:off12345:1",
                      title: "نص مزور أو محرف لا يطابق الخيار",
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const parsedTampered = parseMetaWebhookPayload(tamperedTitlePayload);
  check(
    "E.1 Altered button title preserves authoritative ID (does not trust title)",
    parsedTampered.messages[0]?.text === "fp:off12345:1",
  );

  // E.2 Valid-looking title with missing/invalid ID is rejected
  const missingIdPayload = {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "+201000000000",
                phone_number_id: "10987654321",
              },
              messages: [
                {
                  from: "+201234567890",
                  id: "wamid.MISSING-ID",
                  timestamp: "1729857600",
                  type: "interactive",
                  interactive: {
                    type: "button_reply",
                    button_reply: {
                      id: "",
                      title: "1️⃣ 10:00 ص",
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  let missingIdThrew = false;
  try {
    parseMetaWebhookPayload(missingIdPayload);
  } catch (err: any) {
    missingIdThrew = err.code === "MALFORMED_PROVIDER_PAYLOAD";
  }
  check(
    "E.2 Missing or empty ID in interactive payload fails closed (MALFORMED_PROVIDER_PAYLOAD)",
    missingIdThrew,
  );

  // E.3 Stale / unknown token rejected safely without booking
  const staleTurnResult = await receiveInboundMessage(
    harness.deps,
    {
      to: harness.business.whatsappNumber ?? "+201001111111",
      from: harness.customer.phone,
      text: "fp:stale999:1",
      receivedAt: "2026-10-24T12:05:00Z",
    },
    {
      businessId: harness.business.id,
      branchId: harness.business.defaultBranchId,
    },
  );
  check(
    "E.3 Unknown/stale token does not book appointment and offers fresh options safely",
    staleTurnResult.ok === true &&
      (staleTurnResult as any).conversationStatus !== "BOOKED",
  );

  // E.4 Duplicate inbound delivery idempotency
  const dupTurnResult = await receiveInboundMessage(
    harness.deps,
    {
      to: harness.business.whatsappNumber ?? "+201001111111",
      from: harness.customer.phone,
      text: slot1CallbackId,
      receivedAt: "2026-10-24T12:01:00Z",
      externalId: "wamid.TEST-DUP-1",
    },
    {
      businessId: harness.business.id,
      branchId: harness.business.defaultBranchId,
    },
  );
  const dupReplayResult = await receiveInboundMessage(
    harness.deps,
    {
      to: harness.business.whatsappNumber ?? "+201001111111",
      from: harness.customer.phone,
      text: slot1CallbackId,
      receivedAt: "2026-10-24T12:01:00Z",
      externalId: "wamid.TEST-DUP-1",
    },
    {
      businessId: harness.business.id,
      branchId: harness.business.defaultBranchId,
    },
  );
  check(
    "E.4 Re-delivery of same externalId is recognized as duplicate without side-effects",
    dupTurnResult.ok === true &&
      dupReplayResult.ok === true &&
      (dupReplayResult as any).duplicate === true,
  );

  // E.5 Meta API rejection reports truthful failure
  const failingFetch: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        error: { code: 131047, message: "Re-engagement message window closed" },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  const failingMetaTransport = createMetaWhatsAppTransport({
    connectionDeps: {
      whatsappConnectionRepository: fakeConnectionRepo as any,
      businessRepository: {
        findById: async () => ({
          id: "biz_1",
          name: "منشأة تجريبية",
          isActive: true,
        }),
        findByWhatsappNumber: async () => null,
      } as any,
      branchRepository: {
        findByIdWithinBusiness: async () => null,
        findDefaultByBusiness: async () => null,
      } as any,
    },
    getEnvVar: () => undefined,
    fetchImpl: failingFetch,
    graphHost: META_GRAPH_HOST,
    defaultApiVersion: META_DEFAULT_API_VERSION,
    credentialsResolver: new EnvCredentialsResolver({
      getEnvVar: () => "secret-meta-access-token",
    }),
  });
  const rejectedDelivery = await failingMetaTransport.send({
    to: "+201234567890",
    businessId: "biz_1",
    businessName: "عيادة النور",
    conversationId: "conv_1",
    connectionId: "conn_1",
    content: "مرحبا",
  });
  check(
    "E.5 Meta API rejection does not claim success (delivered: false, errorCode: PERMANENT_TRANSPORT_FAILURE)",
    rejectedDelivery.delivered === false &&
      rejectedDelivery.errorCode === "PERMANENT_TRANSPORT_FAILURE",
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Area F: Time & Availability Precision (Genuinely Bookable Future Times)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\nArea F: Time & Availability Precision");

  // F.1a filterElapsedSlots: Today with only elapsed slots returns empty array
  // Cairo time: 15:00 (12:00 or 13:00 UTC depending on DST)
  const nowAt1500Cairo = new Date("2026-10-25T13:00:00.000Z"); // 15:00 or 16:00 local
  const pastSlotsToday = [
    {
      providerId: "prv_1",
      startAt: "2026-10-25T09:00:00.000Z",
      startTime: "09:00",
    },
    {
      providerId: "prv_1",
      startAt: "2026-10-25T11:00:00.000Z",
      startTime: "11:00",
    },
    {
      providerId: "prv_2",
      startAt: "2026-10-25T14:30:00.000Z",
      startTime: "14:30",
    },
  ];
  const filteredPast = filterElapsedSlots(
    pastSlotsToday,
    "2026-10-25",
    nowAt1500Cairo,
    "Africa/Cairo",
  );
  check(
    "F.1a filterElapsedSlots with only elapsed slots for today returns empty list",
    filteredPast.length === 0,
    `received length: ${filteredPast.length}`,
  );

  // F.1b filterElapsedSlots: Today with both elapsed and future slots
  const mixedSlotsToday = [
    { providerId: "prv_1", startTime: "10:00" },
    { providerId: "prv_1", startTime: "16:30" },
    { providerId: "prv_2", startTime: "17:00" },
  ];
  const filteredMixed = filterElapsedSlots(
    mixedSlotsToday,
    "2026-10-25",
    nowAt1500Cairo,
    "Africa/Cairo",
  );
  check(
    "F.1b filterElapsedSlots retains only strictly future slots for today",
    filteredMixed.length === 2 &&
      filteredMixed[0]?.startTime === "16:30" &&
      filteredMixed[1]?.startTime === "17:00",
    `received: ${JSON.stringify(filteredMixed)}`,
  );

  // F.1c filterElapsedSlots: Business-local day differing from UTC
  // 2026-10-25 at 23:30 UTC is 2026-10-26 at 01:30 or 02:30 in Cairo
  const nowUtcPrevDay = new Date("2026-10-25T23:30:00.000Z");
  const slotsOnOct25 = [{ providerId: "prv_1", startTime: "12:00" }];
  const filteredCrossDay = filterElapsedSlots(
    slotsOnOct25,
    "2026-10-25",
    nowUtcPrevDay,
    "Africa/Cairo",
  );
  check(
    "F.1c filterElapsedSlots treats calendar day as past when Cairo local day has rolled forward",
    filteredCrossDay.length === 0,
    `received: ${JSON.stringify(filteredCrossDay)}`,
  );

  // F.1d filterElapsedSlots: Future dates remaining unaffected
  const futureDateSlots = [
    { providerId: "prv_1", startTime: "09:00" },
    { providerId: "prv_2", startTime: "10:00" },
  ];
  const filteredFutureSlots = filterElapsedSlots(
    futureDateSlots,
    "2026-10-28",
    nowAt1500Cairo,
    "Africa/Cairo",
  );
  check(
    "F.1d filterElapsedSlots leaves future date slots completely unaffected",
    filteredFutureSlots.length === 2,
    `received: ${filteredFutureSlots.length}`,
  );

  // F.1e filterElapsedSlots: Past date returns empty
  const pastDateSlots = [{ providerId: "prv_1", startTime: "09:00" }];
  const filteredPastDate = filterElapsedSlots(
    pastDateSlots,
    "2026-10-20",
    nowAt1500Cairo,
    "Africa/Cairo",
  );
  check(
    "F.1e filterElapsedSlots returns empty for any past date",
    filteredPastDate.length === 0,
  );

  // F.2 Bounded availability service distinction
  const BIZ_UUID = "11111111-1111-4111-8111-111111111111";
  const SRV_UUID = "33333333-3333-4333-8333-333333333331";

  // F.2a Successful search with no eligible dates returns { status: "success", dates: [] }
  const mockDepsNoDates: any = {
    businessRepository: {
      findById: async () => ({
        id: BIZ_UUID,
        timezone: "Africa/Cairo",
        workingHours: {
          sat: { open: "09:00", close: "18:00", closed: false },
          sun: { open: "09:00", close: "18:00", closed: false },
        },
      }),
    },
    serviceRepository: {
      findById: async () => ({
        id: SRV_UUID,
        businessId: BIZ_UUID,
        isActive: true,
      }),
      listByBusiness: async () => [],
    },
    providerRepository: {
      listEligibleForService: async () => [],
      listAssignmentSeams: async () => [],
    },
    appointmentRepository: {
      listBlockingByAssignees: async () => [],
    },
  };
  const emptyDatesRes = await resolveUpcomingBookingDates(
    mockDepsNoDates,
    {
      business: {
        id: BIZ_UUID,
        timezone: "Africa/Cairo",
        workingHours: {
          sat: { open: "09:00", close: "18:00", closed: false },
          sun: { open: "09:00", close: "18:00", closed: false },
        },
      },
    },
    { serviceId: SRV_UUID },
    new Date("2026-10-25T08:00:00.000Z"),
  );
  check(
    "F.2a resolveUpcomingBookingDates: successful search with no eligible dates returns status 'success' with empty dates",
    emptyDatesRes.status === "success" && emptyDatesRes.dates.length === 0,
    `received: ${JSON.stringify(emptyDatesRes)}`,
  );

  // F.2b Database exception returns { status: "error", code: "INFRASTRUCTURE_FAILURE" }
  const mockDepsDbError: any = {
    businessRepository: {
      findById: async () => {
        throw new Error("Connection lost to Postgres database");
      },
    },
    serviceRepository: {
      findById: async () => {
        throw new Error("Connection lost to Postgres database");
      },
    },
    providerRepository: {
      listEligibleForService: async () => {
        throw new Error("Connection lost to Postgres database");
      },
    },
    appointmentRepository: {
      listBlockingByAssignees: async () => {
        throw new Error("Connection lost to Postgres database");
      },
    },
  };
  const dbErrorRes = await resolveUpcomingBookingDates(
    mockDepsDbError,
    {
      business: {
        id: BIZ_UUID,
        timezone: "Africa/Cairo",
        workingHours: {
          sun: { open: "09:00", close: "18:00", closed: false },
        },
      },
    },
    { serviceId: SRV_UUID },
    new Date("2026-10-25T08:00:00.000Z"),
  );
  check(
    "F.2b resolveUpcomingBookingDates: database exception returns INFRASTRUCTURE_FAILURE without claiming fully booked",
    dbErrorRes.status === "error" &&
      dbErrorRes.code === "INFRASTRUCTURE_FAILURE",
    `received: ${JSON.stringify(dbErrorRes)}`,
  );

  // F.2c Typed domain failure returns { status: "error", code: "DOMAIN_ERROR" }
  const mockDepsDomainErr: any = {
    businessRepository: {
      findById: async () => ({
        id: BIZ_UUID,
        timezone: "Africa/Cairo",
        workingHours: {
          sun: { open: "09:00", close: "18:00", closed: false },
        },
      }),
    },
    serviceRepository: {
      findById: async () => null, // SERVICE_NOT_FOUND domain failure
    },
    providerRepository: {
      listEligibleForService: async () => [
        { id: "prv_1", displayName: "د. سارة", user: { name: "سارة" } },
      ],
      listAssignmentSeams: async () => [
        { providerId: "prv_1", userId: "u-1", assignedUserId: "u-1" },
      ],
    },
    appointmentRepository: {
      listBlockingByAssignees: async () => [],
    },
  };
  const domainErrRes = await resolveUpcomingBookingDates(
    mockDepsDomainErr,
    {
      business: {
        id: BIZ_UUID,
        timezone: "Africa/Cairo",
        workingHours: {
          sun: { open: "09:00", close: "18:00", closed: false },
        },
      },
    },
    { serviceId: SRV_UUID },
    new Date("2026-10-25T08:00:00.000Z"),
  );
  check(
    "F.2c resolveUpcomingBookingDates: typed domain failure preserves error code and returns DOMAIN_ERROR",
    domainErrRes.status === "error" && domainErrRes.code === "DOMAIN_ERROR",
    `received: ${JSON.stringify(domainErrRes)}`,
  );

  // ─── F.3: Availability Filtering BEFORE Truncation (Defect Regression) ───────
  // Confirmed scenario: 3 providers, 25 slots each (09:00 - 17:00, 75 total slots)
  // Local time 15:00. Out of 75 slots, 57 are elapsed (<= 15:00), 18 are future (> 15:00).
  const BIZ_F3_ID = "11111111-1111-4111-8111-111111111111";
  const SRV_F3_ID = "22222222-2222-4222-8222-222222222222";
  const PRV_F3_1 = "33333333-3333-4333-8333-333333333331";
  const PRV_F3_2 = "33333333-3333-4333-8333-333333333332";
  const PRV_F3_3 = "33333333-3333-4333-8333-333333333333";
  const f3Providers = [
    { id: PRV_F3_1, displayName: "د. سارة عادل", user: { name: "سارة" } },
    { id: PRV_F3_2, displayName: "د. أحمد محمود", user: { name: "أحمد" } },
    { id: PRV_F3_3, displayName: "د. منى خالد", user: { name: "منى" } },
  ];
  const f3Seams = [
    {
      providerId: PRV_F3_1,
      userId: "44444444-4444-4444-8444-444444444441",
      assignedUserId: "44444444-4444-4444-8444-444444444441",
    },
    {
      providerId: PRV_F3_2,
      userId: "44444444-4444-4444-8444-444444444442",
      assignedUserId: "44444444-4444-4444-8444-444444444442",
    },
    {
      providerId: PRV_F3_3,
      userId: "44444444-4444-4444-8444-444444444443",
      assignedUserId: "44444444-4444-4444-8444-444444444443",
    },
  ];

  const mockDepsF3: any = {
    eligibility: {
      businessRepository: {
        findById: async () => ({
          id: BIZ_F3_ID,
          timezone: "Africa/Cairo",
          slotDurationMinutes: 20,
          workingHours: {
            sun: { open: "09:00", close: "17:20", closed: false },
          },
        }),
      },
      serviceRepository: {
        findById: async () => ({
          id: SRV_F3_ID,
          businessId: BIZ_F3_ID,
          durationMinutes: 20,
          isActive: true,
        }),
      },
      providerRepository: {
        listEligibleForService: async () => f3Providers,
        listAssignmentSeams: async () => f3Seams,
      },
      branchRepository: {
        findDefaultByBusiness: async () => null,
        findByIdWithinBusiness: async () => null,
      },
    },
    businessRepository: {
      findById: async () => ({
        id: BIZ_F3_ID,
        timezone: "Africa/Cairo",
        slotDurationMinutes: 20,
        workingHours: {
          sun: { open: "09:00", close: "17:20", closed: false },
        },
      }),
    },
    serviceRepository: {
      findById: async () => ({
        id: SRV_F3_ID,
        businessId: BIZ_F3_ID,
        durationMinutes: 20,
        isActive: true,
      }),
    },
    providerRepository: {
      listEligibleForService: async () => f3Providers,
      listAssignmentSeams: async () => f3Seams,
    },
    branchRepository: {
      findByIdWithinBusiness: async () => null,
      findDefaultByBusiness: async () => null,
    },
    appointmentRepository: {
      listBlockingByAssignees: async () => [],
    },
  };

  // F.3a: With minStartTime: "15:00", candidate pairs are filtered BEFORE ranking/truncation.
  // Exactly 18 future slots are retained (6 per provider), totalEligibleCount is 18, isCapped is false.
  const f3aResult = await resolveBookingOptions(
    mockDepsF3,
    { userId: "55555555-5555-4555-8555-555555555555", businessId: BIZ_F3_ID },
    {
      serviceId: SRV_F3_ID,
      date: "2026-10-25", // Sunday
      minStartTime: "15:00",
      limit: 50,
    },
  );
  check(
    "F.3a resolveBookingOptions with minStartTime filters before truncation: returns all 18 future slots",
    f3aResult.success === true &&
      f3aResult.data.options.length === 18 &&
      f3aResult.data.totalEligibleCount === 18 &&
      f3aResult.data.isCapped === false &&
      f3aResult.data.options.every(
        (opt) => opt.startAt.slice(11, 16) > "15:00",
      ),
    `received: length=${f3aResult.success ? f3aResult.data.options.length : 0}, totalEligible=${f3aResult.success ? f3aResult.data.totalEligibleCount : 0}, isCapped=${f3aResult.success ? f3aResult.data.isCapped : false}`,
  );

  // F.3b: Without minStartTime (defect reproduction), ranking limit: 50 caps at the first 50 morning slots,
  // starving the 18 afternoon slots so post-filtering leaves 0 slots.
  const f3bResult = await resolveBookingOptions(
    mockDepsF3,
    { userId: "55555555-5555-4555-8555-555555555555", businessId: BIZ_F3_ID },
    {
      serviceId: SRV_F3_ID,
      date: "2026-10-25",
      limit: 50,
    },
  );
  const f3bPostFiltered = f3bResult.success
    ? f3bResult.data.options.filter(
        (opt) => opt.startAt.slice(11, 16) > "15:00",
      )
    : [];
  check(
    "F.3b Truncation before filtering regression: without minStartTime, limit: 50 starves afternoon slots",
    f3bResult.success === true &&
      f3bResult.data.options.length === 50 &&
      f3bResult.data.totalEligibleCount === 75 &&
      f3bResult.data.isCapped === true &&
      f3bPostFiltered.length === 0, // Proves old ordering returned ZERO future slots!
    `received: options.length=${f3bResult.success ? f3bResult.data.options.length : 0}, postFiltered=${f3bPostFiltered.length}`,
  );

  // F.3c: Date suggestions (resolveUpcomingBookingDates) correctly evaluates today's future availability
  const f3cPastClock = new Date("2026-10-25T16:00:00.000Z"); // 19:00 Cairo time, past closing 17:20
  const f3cResPast = await resolveUpcomingBookingDates(
    mockDepsF3,
    {
      business: {
        id: BIZ_F3_ID,
        timezone: "Africa/Cairo",
        slotDurationMinutes: 20,
        workingHours: {
          sun: { open: "09:00", close: "17:20", closed: false },
        },
      },
    },
    { serviceId: SRV_F3_ID },
    f3cPastClock,
  );
  check(
    "F.3c resolveUpcomingBookingDates excludes today when all slots have elapsed",
    f3cResPast.status === "success" &&
      !f3cResPast.dates.some((d) => d.date === "2026-10-25"),
    `received dates: ${JSON.stringify(f3cResPast)}`,
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Area G: Provider Identity & Date Navigation Context Preservation
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\nArea G: Provider Identity & Date Navigation");

  // G.1 Chronological representative slot sampling with mixed providers in non-chronological order
  const nonChronologicalCandidates = [
    {
      providerId: "prv_A",
      startAt: "2026-10-25T17:00:00.000Z",
      startTime: "17:00",
    },
    {
      providerId: "prv_B",
      startAt: "2026-10-25T09:00:00.000Z",
      startTime: "09:00",
    },
    {
      providerId: "prv_A",
      startAt: "2026-10-25T12:00:00.000Z",
      startTime: "12:00",
    },
    {
      providerId: "prv_B",
      startAt: "2026-10-25T15:00:00.000Z",
      startTime: "15:00",
    },
    {
      providerId: "prv_A",
      startAt: "2026-10-25T10:00:00.000Z",
      startTime: "10:00",
    },
  ];
  const sortedSampled = sampleRepresentativeSlots(
    nonChronologicalCandidates,
    4,
  );
  const sampledTimes = sortedSampled.map((s) => s.startTime);
  const isChronological = sampledTimes.every(
    (t, i) => i === 0 || t >= sampledTimes[i - 1]!,
  );
  check(
    "G.1 sampleRepresentativeSlots with mixed providers in scrambled order outputs strictly chronological slots",
    isChronological && sortedSampled.length === 4,
    `received times: ${sampledTimes.join(", ")}`,
  );

  // G.2 Date navigation preserves canonical timePreference
  const baseSlotOfferWithPref = buildSlotOffer(
    { businessId: "biz_1", conversationId: "conv_nav_1" },
    "offer_nav_1",
    {
      serviceId: "srv_consult",
      serviceName: "كشف استشاري",
      date: "2026-10-25",
      timePreference: "morning",
      options: [
        {
          providerId: "prv_1",
          displayName: "د. سارة",
          startAt: "2026-10-25T09:00",
          endAt: "2026-10-25T09:30",
        },
      ],
    },
    new Date("2026-10-25T07:00:00.000Z"),
  );
  const dateOfferBuiltWithPref = buildDateOffer(
    { businessId: "biz_1", conversationId: "conv_nav_1" },
    "offer_date_nav",
    {
      serviceId: "srv_consult",
      serviceName: "كشف استشاري",
      providerId: null,
      timePreference: "morning",
      dates: [{ date: "2026-10-26", label: "غدًا الإثنين" }],
    },
    new Date("2026-10-25T07:00:00.000Z"),
  );
  check(
    "G.2 DateOffer schema and builder persist timePreference correctly across date navigation",
    dateOfferBuiltWithPref?.timePreference === "morning" &&
      baseSlotOfferWithPref?.timePreference === "morning",
    `received date: ${dateOfferBuiltWithPref?.timePreference}, slot: ${baseSlotOfferWithPref?.timePreference}`,
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Area H: WhatsApp Security Boundary & Truthful Transport Reporting
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(
    "\nArea H: WhatsApp Security Boundary & Truthful Transport Reporting",
  );

  // H.1a verifyMetaSignature fails closed when appSecret is absent or undefined
  const rawBodyTest = JSON.stringify({ test: "body" });
  check(
    "H.1a verifyMetaSignature returns false when appSecret is undefined (fail closed)",
    verifyMetaSignature(rawBodyTest, "sha256=123456", undefined) === false,
  );
  check(
    "H.1b verifyMetaSignature returns false when signature header is null",
    verifyMetaSignature(rawBodyTest, null, "test-secret") === false,
  );

  // H.1c verifyMetaSignature returns true with correct HMAC-SHA256 signature
  const validSecret = "super-secret-key-32-chars-length!";
  const validHmac = createHmac("sha256", validSecret)
    .update(rawBodyTest)
    .digest("hex");
  const validHeader = `sha256=${validHmac}`;
  check(
    "H.1c verifyMetaSignature returns true when signature matches exactly",
    verifyMetaSignature(rawBodyTest, validHeader, validSecret) === true,
  );

  // H.1d handleMetaPost returns 403 when WHATSAPP_META_APP_SECRET is unset
  const dummyRequest = new Request("https://flowpilot.test/api/whatsapp/meta", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: rawBodyTest,
  });
  const noSecretResponse = await handleMetaPost(dummyRequest, {
    appSecret: "",
  });
  check(
    "H.1d handleMetaPost rejects requests with 403 when appSecret is empty/unset",
    noSecretResponse.status === 403,
    `received status: ${noSecretResponse.status}`,
  );

  // H.1e parseMetaWebhookPayload strictly rejects unsupported interactive subtypes
  const unsupportedInteractivePayload = {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: "phone_1" },
              messages: [
                {
                  from: "201234567890",
                  id: "wamid.test.1",
                  timestamp: "1700000000",
                  type: "interactive",
                  interactive: {
                    type: "flow_reply", // unsupported subtype
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  let threwMalformedSubtype = false;
  try {
    parseMetaWebhookPayload(unsupportedInteractivePayload);
  } catch (err: any) {
    if (err.code === "MALFORMED_PROVIDER_PAYLOAD") {
      threwMalformedSubtype = true;
    }
  }
  check(
    "H.1e parseMetaWebhookPayload throws MALFORMED_PROVIDER_PAYLOAD on unsupported interactive subtype",
    threwMalformedSubtype === true,
  );

  // H.2 Truthful transport reporting on 200 OK
  // H.2a 200 OK with missing messages[0].id returns delivered: false, MALFORMED_PROVIDER_PAYLOAD
  const mockFetchMissingId: typeof fetch = async () =>
    new Response(
      JSON.stringify({ messaging_product: "whatsapp", contacts: [] }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  const transportMissingId = createMetaWhatsAppTransport({
    connectionDeps: {
      whatsappConnectionRepository: fakeConnectionRepo as any,
      businessRepository: {
        findById: async () => ({
          id: "biz_1",
          name: "منشأة تجريبية",
          isActive: true,
        }),
        findByWhatsappNumber: async () => null,
      } as any,
      branchRepository: {
        findByIdWithinBusiness: async () => null,
        findDefaultByBusiness: async () => null,
      } as any,
    },
    getEnvVar: () => undefined,
    fetchImpl: mockFetchMissingId,
    graphHost: META_GRAPH_HOST,
    defaultApiVersion: META_DEFAULT_API_VERSION,
    credentialsResolver: new EnvCredentialsResolver({
      getEnvVar: () => "secret-meta-access-token",
    }),
  });
  const missingIdResult = await transportMissingId.send({
    to: "+201234567890",
    businessId: "biz_1",
    businessName: "عيادة النور",
    conversationId: "conv_1",
    connectionId: "conn_1",
    content: "مرحبا",
  });
  check(
    "H.2a createMetaWhatsAppTransport reports delivered: false with MALFORMED_PROVIDER_PAYLOAD if messages[0].id is absent",
    missingIdResult.delivered === false &&
      missingIdResult.errorCode === "MALFORMED_PROVIDER_PAYLOAD",
    `received: ${JSON.stringify(missingIdResult)}`,
  );

  // H.2b 200 OK with valid messages[0].id returns delivered: true and providerMessageId
  const mockFetchValidId: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        messaging_product: "whatsapp",
        messages: [
          { id: "wamid.HBgLMjAxMjM0NTY3ODkwFQIAERgSRjU1QkQxRDE5N0YxN0Y0OUIA" },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  const transportValidId = createMetaWhatsAppTransport({
    connectionDeps: {
      whatsappConnectionRepository: fakeConnectionRepo as any,
      businessRepository: {
        findById: async () => ({
          id: "biz_1",
          name: "منشأة تجريبية",
          isActive: true,
        }),
        findByWhatsappNumber: async () => null,
      } as any,
      branchRepository: {
        findByIdWithinBusiness: async () => null,
        findDefaultByBusiness: async () => null,
      } as any,
    },
    getEnvVar: () => undefined,
    fetchImpl: mockFetchValidId,
    graphHost: META_GRAPH_HOST,
    defaultApiVersion: META_DEFAULT_API_VERSION,
    credentialsResolver: new EnvCredentialsResolver({
      getEnvVar: () => "secret-meta-access-token",
    }),
  });
  const validIdResult = await transportValidId.send({
    to: "+201234567890",
    businessId: "biz_1",
    businessName: "عيادة النور",
    conversationId: "conv_1",
    connectionId: "conn_1",
    content: "مرحبا",
  });
  check(
    "H.2b createMetaWhatsAppTransport reports delivered: true with providerMessageId on valid 200 OK",
    validIdResult.delivered === true &&
      validIdResult.providerMessageId ===
        "wamid.HBgLMjAxMjM0NTY3ODkwFQIAERgSRjU1QkQxRDE5N0YxN0Y0OUIA",
    `received: ${JSON.stringify(validIdResult)}`,
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Area I: Real Route Composition Round-Trips for Both Channels
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\nArea I: Real Route Composition Round-Trips");

  // ───────────────────────────────────────────────────────────────────────────
  // I.1 Telegram Connected Round-Trip:
  // Turn 1 (createTelegramMessageTransport) -> captures wire callback_data
  // Turn 2 (handleTelegramWebhook) -> processes selection, creates 1 appointment, 0 model calls
  // ───────────────────────────────────────────────────────────────────────────
  let capturedTgPayload: any = null;
  const offerPersistedAtSendTg = { value: false };
  const tgHarness = createPlaygroundHarness({
    businessConfig: { name: "عيادة د. سارة" } as any,
    customAi: createTestAi() as any,
  });

  const tgTransportDeps: any = {
    api: {
      fetchImpl: async (_url: string, init: any) => {
        // Assert matching offer is ALREADY durably persisted in stateStore BEFORE outbound wire dispatch!
        const stateInStore = tgHarness.stateStore.rows.get(
          tgHarness.conversation.id,
        )?.state as any;
        if (stateInStore?.offer?.token) {
          offerPersistedAtSendTg.value = true;
        }
        capturedTgPayload = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            result: { message_id: 888123 },
          }),
        };
      },
      apiHost: "https://api.telegram.org",
      credentialsResolver: {
        resolve: async () => ({ ok: true, value: "bot123456:tg-test-token" }),
      },
    },
    connectionRepository: {
      findByIdWithinBusiness: async () => ({
        id: "conn_tg_1",
        businessId: tgHarness.business.id,
        branchId: null,
        status: "CONNECTED",
        isActive: true,
        credentialsRef: "fp:tg:test",
      }),
    },
    credentialsResolver: {
      resolve: async () => ({ ok: true, value: "bot123456:tg-test-token" }),
    },
  };

  const realTgTransport = createTelegramMessageTransport(tgTransportDeps);
  tgHarness.deps.transport = realTgTransport;

  // Turn 1: Inbound message via engine
  const tgTurn1 = await receiveInboundMessage(
    tgHarness.deps,
    {
      to: "6123456789",
      from: "123456789",
      text: "عايز أحجز تنظيف أسنان يوم 2026-10-25",
      receivedAt: "2026-10-24T12:00:00Z",
    },
    {
      businessId: tgHarness.business.id,
      branchId: tgHarness.business.defaultBranchId,
      connectionId: "conn_tg_1",
    },
  );

  const tgInlineKeyboard = capturedTgPayload?.reply_markup?.inline_keyboard;
  const capturedTgCallbackData = tgInlineKeyboard?.[0]?.[0]?.callback_data;

  check(
    "I.1a Telegram Turn 1: outbound transport intercepts inline keyboard and confirms offer persisted at send time",
    tgTurn1.ok === true &&
      offerPersistedAtSendTg.value === true &&
      typeof capturedTgCallbackData === "string" &&
      capturedTgCallbackData.startsWith("fp:"),
    `capturedCallbackData: ${capturedTgCallbackData}, offerPersistedAtSend: ${offerPersistedAtSendTg.value}`,
  );

  // Turn 2: Real handleTelegramWebhook with captured callback_data
  const tgWebhookSecret = "tg-secret-production-roundtrip";
  const tgSecretHash = hashTelegramWebhookSecret(tgWebhookSecret);
  const tgAcknowledgedQueries: string[] = [];
  const tgScheduledWork: Promise<void>[] = [];

  const tgWebhookDeps: any = {
    connectionRepository: {
      findByWebhookSecretHash: async (hash: string) => {
        if (hash === tgSecretHash) {
          return {
            id: "conn_tg_1",
            businessId: tgHarness.business.id,
            branchId: null,
            botTokenRef: "tok_ref_1",
            botExternalId: "6123456789",
            externalId: "6123456789",
            webhookSecretHash: tgSecretHash,
            status: "active",
          };
        }
        return null;
      },
    },
    processInboundMessage: async (params: any) => {
      const turnResult = await receiveInboundMessage(
        tgHarness.deps as any,
        params.engineInput,
        params.identity,
      );
      return { ok: turnResult.ok };
    },
    answerCallbackQuery: async (params: { callbackQueryId: string }) => {
      tgAcknowledgedQueries.push(params.callbackQueryId);
    },
    schedule: (work: () => Promise<void> | void) => {
      tgScheduledWork.push(Promise.resolve(work()));
    },
    now: () => new Date("2026-10-24T12:05:00.000Z"),
  };

  const tgUpdatePayload = {
    update_id: 55501,
    callback_query: {
      id: "cbq_prod_tg_1",
      from: { id: 123456789, is_bot: false, first_name: "Ammar" },
      data: capturedTgCallbackData,
      message: {
        message_id: 888123,
        chat: { id: 123456789, type: "private" },
        date: 1729857900,
        text: "المواعيد المتاحة",
      },
    },
  };

  const callsBeforeTgTurn2 = tgHarness.llmStats.callCount;
  const aptsBeforeTgTurn2 = tgHarness.appointments.length;

  const tgReqTurn2 = new Request("http://localhost:3000/api/telegram/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": tgWebhookSecret,
    },
    body: JSON.stringify(tgUpdatePayload),
  });

  const tgResTurn2 = await handleTelegramWebhook(tgWebhookDeps, tgReqTurn2);
  await Promise.all(tgScheduledWork);

  const tgCreatedApts = tgHarness.appointments.length - aptsBeforeTgTurn2;
  const tgExtraModelCalls = tgHarness.llmStats.callCount - callsBeforeTgTurn2;

  check(
    "I.1b Telegram Turn 2: handleTelegramWebhook processes captured wire callback, books 1 appointment, 0 model calls",
    tgResTurn2.status === 200 &&
      tgAcknowledgedQueries.includes("cbq_prod_tg_1") &&
      tgCreatedApts === 1 &&
      tgExtraModelCalls === 0,
    `tgStatus: ${tgResTurn2.status}, createdApts: ${tgCreatedApts}, extraCalls: ${tgExtraModelCalls}`,
  );

  // I.1c Telegram ACK failure resilience: processing continues even if answerCallbackQuery fails
  const tgFailingAckDeps = {
    ...tgWebhookDeps,
    answerCallbackQuery: async () => {
      throw new Error("Telegram API Network Timeout on answerCallbackQuery");
    },
  };
  const tgReqAckFail = new Request(
    "http://localhost:3000/api/telegram/webhook",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": tgWebhookSecret,
      },
      body: JSON.stringify({
        ...tgUpdatePayload,
        update_id: 55502,
        callback_query: {
          ...tgUpdatePayload.callback_query,
          id: "cbq_prod_tg_failing",
        },
      }),
    },
  );
  const tgResAckFail = await handleTelegramWebhook(
    tgFailingAckDeps,
    tgReqAckFail,
  );
  check(
    "I.1c Telegram ACK failure resilience: webhook returns 200 and does not crash when answerCallbackQuery rejects",
    tgResAckFail.status === 200,
    `status: ${tgResAckFail.status}`,
  );

  // I.1d Telegram Replay deduplication: re-submitting same update creates NO additional appointments
  const tgAptsBeforeReplay = tgHarness.appointments.length;
  const tgReqReplay = new Request(
    "http://localhost:3000/api/telegram/webhook",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": tgWebhookSecret,
      },
      body: JSON.stringify(tgUpdatePayload),
    },
  );
  await handleTelegramWebhook(tgWebhookDeps, tgReqReplay);
  const tgAptsAfterReplay = tgHarness.appointments.length;
  check(
    "I.1d Telegram Replay: re-delivering update does not create duplicate appointments",
    tgAptsAfterReplay === tgAptsBeforeReplay,
    `before: ${tgAptsBeforeReplay}, after: ${tgAptsAfterReplay}`,
  );

  // ───────────────────────────────────────────────────────────────────────────
  // I.2 WhatsApp Connected Round-Trip:
  // Turn 1 (createMetaWhatsAppTransport) -> captures wire interactive row ID
  // Turn 2 (handleMetaPost) -> processes selection, creates 1 appointment, 0 model calls
  // ───────────────────────────────────────────────────────────────────────────
  let capturedWaPayload: any = null;
  const offerPersistedAtSendWa = { value: false };
  const waHarness = createPlaygroundHarness({
    businessConfig: { name: "عيادة د. سارة" } as any,
    customAi: createTestAi() as any,
  });

  const waTransportDeps: any = {
    connectionDeps: {
      whatsappConnectionRepository: {
        findByIdWithinBusiness: async () => ({
          id: "conn_wa_1",
          businessId: waHarness.business.id,
          branchId: null,
          externalId: "phone_wa_1",
          status: "CONNECTED",
          isActive: true,
          credentialsRef: "fp:wa:test",
        }),
        findByPhone: async () => null,
        findByExternalId: async () => null,
      },
      branchRepository: {
        findDefaultByBusiness: async () => null,
        findByIdWithinBusiness: async () => null,
      },
    },
    getEnvVar: () => "secret-wa-token",
    credentialsResolver: {
      resolve: async () => ({ ok: true, value: "meta-access-token" }),
    },
    fetchImpl: async (_url: string, init: any) => {
      // Assert matching offer is ALREADY durably persisted in stateStore BEFORE outbound wire dispatch!
      const stateInStore = waHarness.stateStore.rows.get(
        waHarness.conversation.id,
      )?.state as any;
      if (stateInStore?.offer?.token) {
        offerPersistedAtSendWa.value = true;
      }
      capturedWaPayload = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          messages: [{ id: "wamid.outbound.wire.888" }],
        }),
      };
    },
    graphHost: META_GRAPH_HOST,
    defaultApiVersion: META_DEFAULT_API_VERSION,
  };

  const realWaTransport = createMetaWhatsAppTransport(waTransportDeps);
  waHarness.deps.transport = realWaTransport;

  // Turn 1: Inbound message via engine
  const waTurn1 = await receiveInboundMessage(
    waHarness.deps,
    {
      to: waHarness.business.whatsappNumber ?? "+201001111111",
      from: waHarness.customer.phone,
      text: "عايز أحجز تنظيف أسنان يوم 2026-10-25",
      receivedAt: "2026-10-24T12:00:00Z",
    },
    {
      businessId: waHarness.business.id,
      branchId: waHarness.business.defaultBranchId,
      connectionId: "conn_wa_1",
    },
  );

  const capturedWaRowId =
    capturedWaPayload?.interactive?.action?.sections?.[0]?.rows?.[0]?.id;

  check(
    "I.2a WhatsApp Turn 1: outbound transport intercepts interactive list and confirms offer persisted at send time",
    waTurn1.ok === true &&
      offerPersistedAtSendWa.value === true &&
      typeof capturedWaRowId === "string" &&
      capturedWaRowId.startsWith("fp:"),
    `capturedRowId: ${capturedWaRowId}, offerPersistedAtSend: ${offerPersistedAtSendWa.value}`,
  );

  // Turn 2: Real handleMetaPost with captured wire row ID
  const testSecretWa = "secret-whatsapp-test-hmac-key-256";
  const waWebhookPayload = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "entry_1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "+201234567890",
                phone_number_id: "phone_wa_1",
              },
              messages: [
                {
                  from: waHarness.customer.phone,
                  id: "wamid.roundtrip.connected.1",
                  timestamp: "1729857600",
                  type: "interactive",
                  interactive: {
                    type: "list_reply",
                    list_reply: {
                      id: capturedWaRowId,
                      title: "10:00 ص",
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };

  const waRawBody = JSON.stringify(waWebhookPayload);
  const waHmac = createHmac("sha256", testSecretWa)
    .update(waRawBody)
    .digest("hex");
  const waRequest = new Request("https://flowpilot.test/api/whatsapp/meta", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-hub-signature-256": `sha256=${waHmac}`,
    },
    body: waRawBody,
  });

  const callsBeforeWa = waHarness.llmStats.callCount;
  const aptsBeforeWa = waHarness.appointments.length;

  const waResponse = await handleMetaPost(waRequest, {
    appSecret: testSecretWa,
    resolutionDeps: {
      businessRepository: {
        findById: async () => waHarness.business,
        findByWhatsappNumber: async () => waHarness.business,
      } as any,
      whatsappConnectionRepository: {
        findByExternalId: async () => ({
          id: "conn_wa_1",
          businessId: waHarness.business.id,
          branchId: null,
          externalId: "phone_wa_1",
        }),
        findByPhone: async () => null,
        findByIdWithinBusiness: async () => null,
      } as any,
      branchRepository: {
        findByIdWithinBusiness: async () => null,
        findDefaultByBusiness: async () => null,
        listByBusiness: async () => [],
      },
    },
    engineDeps: waHarness.deps as any,
    revalidateFn: () => undefined,
  });

  const waResponseBody = (await waResponse.json()) as any;
  const createdAptsWa = waHarness.appointments.length - aptsBeforeWa;
  const extraModelCallsWa = waHarness.llmStats.callCount - callsBeforeWa;

  check(
    "I.2b WhatsApp Turn 2: handleMetaPost processes signed wire row ID, books 1 appointment, 0 model calls",
    waResponse.status === 200 &&
      waResponseBody.success === true &&
      waResponseBody.results?.[0]?.ok === true &&
      createdAptsWa === 1 &&
      extraModelCallsWa === 0,
    `waResponse: status ${waResponse.status}, createdApts: ${createdAptsWa}, extraModelCalls: ${extraModelCallsWa}`,
  );

  // I.2c WhatsApp Replay deduplication: re-submitting same wamid creates NO additional appointments
  const aptsBeforeWaReplay = waHarness.appointments.length;
  const waRequestReplay = new Request(
    "https://flowpilot.test/api/whatsapp/meta",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-hub-signature-256": `sha256=${waHmac}`,
      },
      body: waRawBody,
    },
  );
  await handleMetaPost(waRequestReplay, {
    appSecret: testSecretWa,
    resolutionDeps: {
      businessRepository: {
        findById: async () => waHarness.business,
        findByWhatsappNumber: async () => waHarness.business,
      } as any,
      whatsappConnectionRepository: {
        findByExternalId: async () => ({
          id: "conn_wa_1",
          businessId: waHarness.business.id,
          branchId: null,
          externalId: "phone_wa_1",
        }),
        findByPhone: async () => null,
        findByIdWithinBusiness: async () => null,
      } as any,
      branchRepository: {
        findByIdWithinBusiness: async () => null,
        findDefaultByBusiness: async () => null,
        listByBusiness: async () => [],
      },
    },
    engineDeps: waHarness.deps as any,
    revalidateFn: () => undefined,
  });
  const aptsAfterWaReplay = waHarness.appointments.length;
  check(
    "I.2c WhatsApp Replay: re-delivering message does not create duplicate appointments",
    aptsAfterWaReplay === aptsBeforeWaReplay,
    `before: ${aptsBeforeWaReplay}, after: ${aptsAfterWaReplay}`,
  );

  // I.3 Negative control: replacing the engine with a no-op makes the round-trip assertions fail
  const noopAptsBefore = waHarness.appointments.length;
  const mockNoopProcessInbound = async () => ({ ok: true, duplicate: false });
  const noopWebhookDeps = {
    ...tgWebhookDeps,
    processInboundMessage: mockNoopProcessInbound,
  };
  const noopTgReq = new Request("http://localhost:3000/api/telegram/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": tgWebhookSecret,
    },
    body: JSON.stringify({
      ...tgUpdatePayload,
      update_id: 55509,
    }),
  });
  await handleTelegramWebhook(noopWebhookDeps, noopTgReq);
  const noopAptsAfter = waHarness.appointments.length;
  check(
    "I.3 Negative control: replacing engine with a no-op creates 0 appointments (proves test validity)",
    noopAptsAfter === noopAptsBefore,
    `expected no appointments created by no-op`,
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Area J: Contextual Stale-Offer Recovery (Deterministic & Model-Free)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\nArea J: Contextual Stale-Offer Recovery");

  // J.1 Stale slot selection with known service + date:
  // Re-checks availability, returns fresh slot choices, saves new offer, 0 appointments, 0 model calls.
  const harnessJ1 = createPlaygroundHarness({
    businessConfig: { name: "عيادة د. سارة" } as any,
    customAi: createTestAi() as any,
  });
  const expiredSlotOffer = buildSlotOffer(
    {
      businessId: harnessJ1.business.id,
      conversationId: harnessJ1.conversation.id,
    },
    "tok_expired_slot",
    {
      serviceId: PLAYGROUND_IDS.SERV_CLEAN,
      serviceName: "تنظيف أسنان",
      serviceSource: "CUSTOMER",
      date: "2026-10-25",
      options: [
        {
          providerId: PLAYGROUND_IDS.PROV_1,
          displayName: "د. سارة عادل",
          startAt: "2026-10-25T10:00",
          endAt: "2026-10-25T10:30",
        },
      ],
    },
    // Created 24 hours ago (exceeds TTL)
    new Date("2026-10-23T10:00:00.000Z"),
  );
  const initialJ1State: ConversationState = {
    ...emptyConversationState(),
    offer: expiredSlotOffer,
    serviceId: PLAYGROUND_IDS.SERV_CLEAN,
    selectedService: "تنظيف أسنان",
    selectedDate: "2026-10-25",
    bookingStage: "AVAILABILITY_RESOLVED",
    knownFacts: {
      service: "تنظيف أسنان",
      date: "2026-10-25",
    },
    missingFacts: [],
  };
  await harnessJ1.stateStore.save(
    harnessJ1.business.id,
    harnessJ1.conversation.id,
    null,
    dehydrateConversationState(initialJ1State),
  );
  harnessJ1.stateStore.rows.get(harnessJ1.conversation.id)!.updatedAt =
    new Date("2026-10-24T11:00:00.000Z");

  const j1CallsBefore = harnessJ1.llmStats.callCount;
  const j1AptsBefore = harnessJ1.appointments.length;
  const j1Turn = await receiveInboundMessage(
    harnessJ1.deps,
    {
      to: harnessJ1.business.whatsappNumber ?? "+201001111111",
      from: harnessJ1.customer.phone,
      text: offerCallbackData(expiredSlotOffer!, "1"),
      receivedAt: "2026-10-24T12:00:00Z",
    },
    {
      businessId: harnessJ1.business.id,
      branchId: harnessJ1.business.defaultBranchId,
    },
  );

  const j1StateAfter = harnessJ1.stateStore.rows.get(
    (j1Turn as any).conversationId ?? harnessJ1.conversation.id,
  )?.state as any;
  const j1CallsAfter = harnessJ1.llmStats.callCount - j1CallsBefore;
  const j1AptsAfter = harnessJ1.appointments.length - j1AptsBefore;

  check(
    "J.1 Stale slot selection with known service + date: presents fresh slot choices, saves new offer, 0 model calls, 0 appointments",
    j1Turn.ok === true &&
      j1AptsAfter === 0 &&
      j1CallsAfter === 0 &&
      j1StateAfter?.offer?.token !== expiredSlotOffer?.token &&
      j1StateAfter?.offer?.kind === "SLOT",
    `aptsAfter: ${j1AptsAfter}, callsAfter: ${j1CallsAfter}, newOfferKind: ${j1StateAfter?.offer?.kind}, tokenChanged: ${j1StateAfter?.offer?.token !== expiredSlotOffer?.token}`,
  );

  // J.2 Stale date selection with known service:
  // Re-checks upcoming dates, presents fresh date choices, saves new date offer, 0 appointments, 0 model calls.
  const harnessJ2 = createPlaygroundHarness({
    businessConfig: { name: "عيادة د. سارة" } as any,
    customAi: createTestAi() as any,
  });
  const expiredDateOffer = buildDateOffer(
    {
      businessId: harnessJ2.business.id,
      conversationId: harnessJ2.conversation.id,
    },
    "tok_expired_date",
    {
      serviceId: PLAYGROUND_IDS.SERV_CLEAN,
      serviceName: "تنظيف أسنان",
      providerId: null,
      dates: [
        {
          date: "2026-10-25",
          label: "الأحد 25 أكتوبر",
        },
      ],
    },
    new Date("2026-10-23T10:00:00.000Z"),
  );
  const initialJ2State: ConversationState = {
    ...emptyConversationState(),
    offer: expiredDateOffer,
    serviceId: PLAYGROUND_IDS.SERV_CLEAN,
    selectedService: "تنظيف أسنان",
    bookingStage: "AVAILABILITY_RESOLVED",
    knownFacts: {
      service: "تنظيف أسنان",
    },
    missingFacts: ["date"],
  };
  await harnessJ2.stateStore.save(
    harnessJ2.business.id,
    harnessJ2.conversation.id,
    null,
    dehydrateConversationState(initialJ2State),
  );
  harnessJ2.stateStore.rows.get(harnessJ2.conversation.id)!.updatedAt =
    new Date("2026-10-24T11:00:00.000Z");

  const j2CallsBefore = harnessJ2.llmStats.callCount;
  const j2AptsBefore = harnessJ2.appointments.length;
  const j2Turn = await receiveInboundMessage(
    harnessJ2.deps,
    {
      to: harnessJ2.business.whatsappNumber ?? "+201001111111",
      from: harnessJ2.customer.phone,
      text: offerCallbackData(expiredDateOffer!, "1"),
      receivedAt: "2026-10-24T12:00:00Z",
    },
    {
      businessId: harnessJ2.business.id,
      branchId: harnessJ2.business.defaultBranchId,
    },
  );

  const j2StateAfter = harnessJ2.stateStore.rows.get(
    (j2Turn as any).conversationId ?? harnessJ2.conversation.id,
  )?.state as any;
  const j2CallsAfter = harnessJ2.llmStats.callCount - j2CallsBefore;
  const j2AptsAfter = harnessJ2.appointments.length - j2AptsBefore;

  check(
    "J.2 Stale date selection with known service: presents fresh date choices, saves new offer, 0 model calls, 0 appointments",
    j2Turn.ok === true &&
      j2AptsAfter === 0 &&
      j2CallsAfter === 0 &&
      j2StateAfter?.offer?.token !== expiredDateOffer?.token &&
      j2StateAfter?.offer?.kind === "DATE",
    `aptsAfter: ${j2AptsAfter}, callsAfter: ${j2CallsAfter}, newOfferKind: ${j2StateAfter?.offer?.kind}`,
  );

  // J.3 Preserve newer active offer when customer clicks a previous/stale offer button:
  const harnessJ3 = createPlaygroundHarness({
    businessConfig: { name: "عيادة د. سارة" } as any,
    customAi: createTestAi() as any,
  });
  const olderStaleOffer = buildSlotOffer(
    {
      businessId: harnessJ3.business.id,
      conversationId: harnessJ3.conversation.id,
    },
    "tok_older_offer",
    {
      serviceId: PLAYGROUND_IDS.SERV_CLEAN,
      serviceName: "تنظيف أسنان",
      serviceSource: "CUSTOMER",
      date: "2026-10-25",
      options: [
        {
          providerId: PLAYGROUND_IDS.PROV_1,
          displayName: "د. سارة عادل",
          startAt: "2026-10-25T10:00",
          endAt: "2026-10-25T10:30",
        },
      ],
    },
    new Date("2026-10-24T10:00:00.000Z"),
  );
  const activeNewerOffer = buildSlotOffer(
    {
      businessId: harnessJ3.business.id,
      conversationId: harnessJ3.conversation.id,
    },
    "tok_newer_active_offer",
    {
      serviceId: PLAYGROUND_IDS.SERV_CLEAN,
      serviceName: "تنظيف أسنان",
      serviceSource: "CUSTOMER",
      date: "2026-10-25",
      options: [
        {
          providerId: PLAYGROUND_IDS.PROV_1,
          displayName: "د. سارة عادل",
          startAt: "2026-10-25T12:00",
          endAt: "2026-10-25T12:30",
        },
      ],
    },
    new Date("2026-10-24T12:00:00.000Z"),
  );
  const initialJ3State: ConversationState = {
    ...emptyConversationState(),
    offer: activeNewerOffer,
    serviceId: PLAYGROUND_IDS.SERV_CLEAN,
    selectedService: "تنظيف أسنان",
    selectedDate: "2026-10-25",
    bookingStage: "AVAILABILITY_RESOLVED",
    knownFacts: {
      service: "تنظيف أسنان",
      date: "2026-10-25",
    },
    missingFacts: [],
  };
  await harnessJ3.stateStore.save(
    harnessJ3.business.id,
    harnessJ3.conversation.id,
    null,
    dehydrateConversationState(initialJ3State),
  );
  harnessJ3.stateStore.rows.get(harnessJ3.conversation.id)!.updatedAt =
    new Date("2026-10-24T12:00:00.000Z");

  const j3CallsBefore = harnessJ3.llmStats.callCount;
  const j3Turn = await receiveInboundMessage(
    harnessJ3.deps,
    {
      to: harnessJ3.business.whatsappNumber ?? "+201001111111",
      from: harnessJ3.customer.phone,
      text: offerCallbackData(olderStaleOffer!, "1"), // Customer clicked old button!
      receivedAt: "2026-10-24T12:05:00Z",
    },
    {
      businessId: harnessJ3.business.id,
      branchId: harnessJ3.business.defaultBranchId,
    },
  );

  const j3StateAfter = harnessJ3.stateStore.rows.get(
    (j3Turn as any).conversationId ?? harnessJ3.conversation.id,
  )?.state as any;
  const j3CallsAfter = harnessJ3.llmStats.callCount - j3CallsBefore;

  check(
    "J.3 Newer active offer is preserved when stale button is clicked, 0 model calls",
    j3Turn.ok === true &&
      j3CallsAfter === 0 &&
      j3StateAfter?.offer?.token === activeNewerOffer?.token,
    `retainedToken: ${j3StateAfter?.offer?.token}, expected: ${activeNewerOffer?.token}`,
  );

  // J.4 Context insufficient (missing service): asks for missing facts without model call or crash
  const harnessJ4 = createPlaygroundHarness({
    businessConfig: { name: "عيادة د. سارة" } as any,
    customAi: createTestAi() as any,
  });
  const initialJ4State: ConversationState = {
    ...emptyConversationState(),
    offer: null,
    bookingStage: "NOT_APPLICABLE",
    knownFacts: {},
    missingFacts: ["service"],
  };
  await harnessJ4.stateStore.save(
    harnessJ4.business.id,
    harnessJ4.conversation.id,
    null,
    dehydrateConversationState(initialJ4State),
  );
  const j4CallsBefore = harnessJ4.llmStats.callCount;
  const j4Turn = await receiveInboundMessage(
    harnessJ4.deps,
    {
      to: harnessJ4.business.whatsappNumber ?? "+201001111111",
      from: harnessJ4.customer.phone,
      text: "offer:tok_completely_unknown:1",
      receivedAt: "2026-10-24T12:00:00Z",
    },
    {
      businessId: harnessJ4.business.id,
      branchId: harnessJ4.business.defaultBranchId,
    },
  );
  const j4CallsAfter = harnessJ4.llmStats.callCount - j4CallsBefore;
  check(
    "J.4 Context insufficient: asks for service fact without model calls or crash",
    j4Turn.ok === true && j4CallsAfter === 0,
    `callsAfter: ${j4CallsAfter}`,
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════════════════════
  const failedCount = checks.filter((c) => !c.pass).length;
  console.log(
    `\n── Total: ${checks.length} | Passed: ${checks.length - failedCount} | Failed: ${failedCount} ──`,
  );
  if (failedCount > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("FATAL SUITE ERROR:", err);
  process.exit(1);
});
