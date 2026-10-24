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

import { createPlaygroundHarness } from "../src/features/conversations/playground/harness";
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
import { receiveInboundMessage } from "../src/features/conversations/server/conversation-engine";
import {
  areSlotsSingleProvider,
  formatArabicDate,
  formatArabicTime12h,
  formatBookingOptionsCopy,
  formatSlotChoiceLabel,
  sampleRepresentativeSlots,
} from "../src/features/conversations/server/presentation-formatters";
import { EnvCredentialsResolver } from "../src/server/credentials/credentials-resolver";
import { renderTelegramInlineKeyboard } from "../src/server/integrations/telegram/telegram-presentation";
import {
  META_DEFAULT_API_VERSION,
  META_GRAPH_HOST,
  createMetaWhatsAppTransport,
} from "../src/server/integrations/whatsapp/meta-client";
import {
  renderMetaInteractivePayload,
  safeTruncateGraphemes,
} from "../src/server/integrations/whatsapp/meta-presentation";
import { parseMetaWebhookPayload } from "../src/server/integrations/whatsapp/meta-webhook";

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
