/* eslint-disable @typescript-eslint/no-explicit-any */
import "./setup-test-env";

import { createPlaygroundHarness } from "../src/features/conversations/playground/harness";
import type { AiResponse } from "../src/features/conversations/server/ai-contract";
import type {
  DateOffer,
  ProviderOffer,
  ServiceDetailOffer,
  ServiceOffer,
  SlotOffer,
  WelcomeOffer,
} from "../src/features/conversations/server/booking-offer";
import { buildChannelChoices } from "../src/features/conversations/server/channel-choice";
import {
  detectTurnControlSignals,
  resolveTurnControlSignals,
} from "../src/features/conversations/server/conversation-ai";
import {
  parseOfferCallback,
  renderTelegramInlineKeyboard,
} from "../src/server/integrations/telegram/telegram-presentation";

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
  console.log(
    "── SUITE: Channel-Neutral Choices & Semantic Intent Ownership ──\n",
  );

  // ── Area 1: Channel-Neutral Choices Mapping ─────────────────────────────────
  console.log(
    "Area 1: Channel-neutral choice mapping across all 6 offer types",
  );

  const nowIso = new Date().toISOString();
  const futureIso = new Date(Date.now() + 600000).toISOString();

  const baseOffer = {
    id: "off_test123",
    token: "toktest12",
    businessId: "biz_1",
    conversationId: "conv_1",
    status: "ACTIVE" as const,
    issuedAt: nowIso,
    expiresAt: futureIso,
  };

  // 1.1 WELCOME offer
  const welcomeOffer: WelcomeOffer = {
    ...baseOffer,
    kind: "WELCOME",
    options: [
      { index: 1, action: "book", label: "حجز موعد" },
      { index: 2, action: "inquire", label: "استفسار عن خدمة" },
    ],
  };
  const welcomeChoices = buildChannelChoices(welcomeOffer);
  check(
    "1.1 WELCOME offer builds neutral choices without telegram markup",
    welcomeChoices.offerKind === "WELCOME" &&
      welcomeChoices.offerToken === "toktest12" &&
      welcomeChoices.groups.length === 2 &&
      welcomeChoices.groups[0]?.[0]?.id === "book" &&
      welcomeChoices.groups[1]?.[0]?.id === "inquire" &&
      !("reply_markup" in (welcomeChoices as any)) &&
      !("inline_keyboard" in (welcomeChoices as any)),
  );

  // 1.2 SERVICE offer
  const serviceOffer: ServiceOffer = {
    ...baseOffer,
    kind: "SERVICE",
    purpose: "BOOKING",
    options: [
      { index: 1, serviceId: "srv_1", name: "كشف جلدية" },
      { index: 2, serviceId: "srv_2", name: "ليزر" },
    ],
  };
  const serviceChoices = buildChannelChoices(serviceOffer);
  check(
    "1.2 SERVICE offer builds neutral choice items with stable IDs and no vendor leak",
    serviceChoices.offerKind === "SERVICE" &&
      serviceChoices.groups.length === 2 &&
      serviceChoices.groups[0]?.[0]?.id === "1" &&
      (serviceChoices.groups[0]?.[0]?.label.includes("كشف جلدية") ?? false) &&
      serviceChoices.groups[0]?.[0]?.value === "srv_1" &&
      serviceChoices.groups[1]?.[0]?.id === "2",
  );

  // 1.3 SERVICE_DETAIL offer
  const serviceDetailOffer: ServiceDetailOffer = {
    ...baseOffer,
    kind: "SERVICE_DETAIL",
    serviceId: "srv_1",
    serviceName: "كشف جلدية",
    options: [
      { index: 1, action: "book_service", label: "حجز هذه الخدمة" },
      { index: 2, action: "other_services", label: "خدمة أخرى" },
      { index: 3, action: "menu", label: "القائمة الرئيسية" },
    ],
  };
  const serviceDetailChoices = buildChannelChoices(serviceDetailOffer);
  check(
    "1.3 SERVICE_DETAIL builds action choices (book_service / other_services / menu)",
    serviceDetailChoices.offerKind === "SERVICE_DETAIL" &&
      serviceDetailChoices.groups.length === 2 &&
      serviceDetailChoices.groups[0]?.[0]?.id === "book_service" &&
      serviceDetailChoices.groups[1]?.[0]?.id === "other_services" &&
      serviceDetailChoices.groups[1]?.[1]?.id === "menu",
  );

  // 1.4 DATE offer
  const dateOffer: DateOffer = {
    ...baseOffer,
    kind: "DATE",
    serviceId: "srv_1",
    serviceName: "كشف جلدية",
    providerId: null,
    options: [
      { index: 1, date: "2026-10-25", label: "الأحد 25 أكتوبر" },
      { index: 2, date: "2026-10-26", label: "الإثنين 26 أكتوبر" },
    ],
  };
  const dateChoices = buildChannelChoices(dateOffer);
  check(
    "1.4 DATE offer maps dates to neutral choice items with secondary other_date",
    dateChoices.offerKind === "DATE" &&
      dateChoices.groups.length === 3 &&
      dateChoices.groups[0]?.[0]?.id === "1" &&
      dateChoices.groups[0]?.[0]?.value === "2026-10-25" &&
      dateChoices.groups[2]?.[0]?.id === "other_date",
  );

  // 1.5 PROVIDER offer
  const providerOffer: ProviderOffer = {
    ...baseOffer,
    kind: "PROVIDER",
    serviceId: "srv_1",
    serviceName: "كشف جلدية",
    date: "2026-10-25",
    options: [
      { index: 1, providerId: null, name: "أي مقدم خدمة متاح" },
      { index: 2, providerId: "prv_1", name: "د. سارة" },
    ],
  };
  const providerChoices = buildChannelChoices(providerOffer);
  check(
    "1.5 PROVIDER offer includes ANY provider and specific providers",
    providerChoices.offerKind === "PROVIDER" &&
      providerChoices.groups.length === 2 &&
      providerChoices.groups[0]?.[0]?.id === "1" &&
      providerChoices.groups[0]?.[0]?.value === null &&
      providerChoices.groups[1]?.[0]?.id === "2" &&
      providerChoices.groups[1]?.[0]?.value === "prv_1",
  );

  // 1.6 SLOT offer
  const slotOffer: SlotOffer = {
    ...baseOffer,
    kind: "SLOT",
    serviceId: "srv_1",
    serviceName: "كشف جلدية",
    serviceSource: "CUSTOMER",
    providerId: "prv_1",
    date: "2026-10-25",
    followUpRequestId: null,
    shownCount: 2,
    options: [
      {
        index: 1,
        providerId: "prv_1",
        displayName: "د. سارة",
        startAt: "2026-10-25T10:00:00.000Z",
        endAt: "2026-10-25T10:30:00.000Z",
      },
      {
        index: 2,
        providerId: "prv_1",
        displayName: "د. سارة",
        startAt: "2026-10-25T11:00:00.000Z",
        endAt: "2026-10-25T11:30:00.000Z",
      },
    ],
  };
  const slotChoices = buildChannelChoices(slotOffer);
  check(
    "1.6 SLOT offer includes slot items and slot navigation (more / date)",
    slotChoices.offerKind === "SLOT" &&
      slotChoices.groups.length === 2 &&
      (slotChoices.groups[0]?.length ?? 0) === 2 &&
      slotChoices.groups[0]?.[0]?.id === "1" &&
      slotChoices.groups[0]?.[0]?.value === "2026-10-25T10:00:00.000Z" &&
      slotChoices.groups[1]?.[0]?.id === "more" &&
      slotChoices.groups[1]?.[1]?.id === "date",
  );

  // ── Area 2: Telegram Presentation Boundary ──────────────────────────────────
  console.log(
    "\nArea 2: Telegram presentation boundary rendering & callback encoding",
  );

  const kb = renderTelegramInlineKeyboard(slotChoices);
  check(
    "2.1 Telegram presentation boundary renders valid InlineKeyboardMarkup",
    Array.isArray(kb.inline_keyboard) && kb.inline_keyboard.length === 2,
  );

  const firstButton = kb.inline_keyboard[0]?.[0];
  if (!firstButton) throw new Error("firstButton missing");

  check(
    "2.2 Telegram button uses compact token format fp:<token>:<action>",
    firstButton.text.includes("10:00") &&
      firstButton.callback_data === "fp:toktest12:1",
  );

  check(
    "2.3 Telegram callback_data length conforms to Telegram <= 64 byte limit",
    Buffer.byteLength(firstButton.callback_data, "utf8") <= 64,
  );

  const parsed = parseOfferCallback(firstButton.callback_data);
  check(
    "2.4 parseOfferCallback correctly parses valid index callback_data",
    parsed !== null &&
      parsed.token === "toktest12" &&
      parsed.action.kind === "index" &&
      parsed.action.index === 1,
  );

  const navButton = kb.inline_keyboard[1]?.[0];
  if (!navButton) throw new Error("navButton missing");

  const parsedNav = parseOfferCallback(navButton.callback_data);
  check(
    "2.5 parseOfferCallback correctly parses action callback_data (more)",
    parsedNav !== null &&
      parsedNav.token === "toktest12" &&
      parsedNav.action.kind === "more",
  );

  const parsedInvalid = parseOfferCallback("invalid:data:format");
  check(
    "2.6 parseOfferCallback rejects invalid non-flowpilot callback",
    parsedInvalid === null,
  );

  const parsedEmpty = parseOfferCallback("fp::1");
  check("2.7 parseOfferCallback rejects empty token", parsedEmpty === null);

  // ── Area 3: Semantic Intent Ownership (Removing Lexical Hijacking) ────────────
  console.log(
    "\nArea 3: Semantic intent ownership & resolution in structured turns",
  );

  const lexicalSignalsWithDoctor = detectTurnControlSignals(
    "ممكن اتكلم مع الدكتور حسام لو سمحت",
  );
  check(
    "3.1 Lexical detector historically triggers explicitHuman on doctor mention with request cue",
    lexicalSignalsWithDoctor.explicitHuman === true,
  );

  // Structured semantic decision correctly interprets this as BOOKING
  const structuredBookingDecision: AiResponse = {
    intent: "BOOKING",
    action: "reply",
    content: "تمام، هحجزلك مع دكتور حسام بكرة.",
    safetyAssessment: "safe",
    extraction: {
      service: null,
      provider: "دكتور حسام",
      date: "2026-10-24",
      timePreference: null,
    },
    handoffReason: null,
    summary: null,
    goals: [
      {
        kind: "DOMAIN_ACTION",
        intent: "BOOKING",
        requiredKnowledge: "NONE",
      },
    ],
  };

  const resolvedControl = resolveTurnControlSignals({
    currentMessage: "عايز احجز مع دكتور حسام بكرة",
    routing: "LLM",
    decision: structuredBookingDecision,
    isStructuredSemanticTurn: true,
  });

  check(
    "3.2 Structured semantic turn overrides lexical explicitHuman for booking intent",
    resolvedControl.explicitHuman === false &&
      resolvedControl.nonCommittal === false,
  );

  // Explicit human request from customer
  const structuredHumanDecision: AiResponse = {
    intent: "HUMAN_REQUEST",
    action: "handoff",
    content: "سأقوم بتحويلك لأحد ممثلي الخدمة.",
    safetyAssessment: "safe",
    extraction: {
      service: null,
      provider: null,
      date: null,
      timePreference: null,
    },
    handoffReason: "HUMAN_REQUEST",
    summary: "Customer requested human staff",
    goals: [
      {
        kind: "HANDOFF",
        intent: "HUMAN_REQUEST",
        requiredKnowledge: "HUMAN_REQUEST",
      },
    ],
  };

  const resolvedHumanControl = resolveTurnControlSignals({
    currentMessage: "محتاج اكلم شخص حقيقي لو سمحت",
    routing: "LLM",
    decision: structuredHumanDecision,
    isStructuredSemanticTurn: true,
  });

  check(
    "3.3 Structured turn honors explicit human request when semantic decision dictates",
    resolvedHumanControl.explicitHuman === true,
  );

  // Harmless wording with historical keywords ("أي وقت يناسبكم مش مشكلة")
  const structuredAnyTimeDecision: AiResponse = {
    intent: "BOOKING",
    action: "reply",
    content: "تم اختيار أقرب موعد متاح.",
    safetyAssessment: "safe",
    extraction: {
      service: null,
      provider: null,
      date: null,
      timePreference: null,
    },
    handoffReason: null,
    summary: null,
  };

  const resolvedAnyTimeControl = resolveTurnControlSignals({
    currentMessage: "أي وقت يناسبكم مش مشكلة",
    routing: "LLM",
    decision: structuredAnyTimeDecision,
    isStructuredSemanticTurn: true,
  });

  check(
    "3.4 Harmless wording with historical trigger words stays AI_ACTIVE without false handoff",
    resolvedAnyTimeControl.explicitHuman === false &&
      resolvedAnyTimeControl.nonCommittal === false,
  );

  // ── Area 4: Mechanical zero-model execution ──────────────────────────────────
  console.log(
    "\nArea 4: End-to-end mechanical selection zero-model verification",
  );

  const { receiveInboundMessage } =
    await import("../src/features/conversations/server/conversation-engine");

  const harness = createPlaygroundHarness({
    channel: "TELEGRAM",
  });

  // Track AI calls through the harness's ai dependency
  let aiCalls = 0;
  const originalAiRespond = harness.deps.ai.respond.bind(harness.deps.ai);
  harness.deps.ai.respond = async (req: any) => {
    aiCalls++;
    return originalAiRespond(req);
  };

  // 4.1 /start command triggers welcome offer with 0 AI calls
  const startResult = await receiveInboundMessage(
    harness.deps as any,
    {
      to: "123456789",
      from: "987654321",
      text: "/start",
      receivedAt: new Date().toISOString(),
      externalId: `tg:123456789:${Date.now()}`,
    },
    {
      businessId: harness.business.id,
      branchId: harness.business.defaultBranchId,
      connectionId: "conn-1",
    },
  );

  const firstOutbound = harness.deliveredOutbound[0];
  if (!firstOutbound) throw new Error("firstOutbound missing");

  check(
    "4.1 /start renders choices and executes 0 AI calls",
    aiCalls === 0 &&
      startResult.ok === true &&
      harness.deliveredOutbound.length > 0 &&
      firstOutbound.choices !== null,
  );

  // Check choices format in delivered outbound
  const outChoices = firstOutbound.choices;
  check(
    "4.2 Delivered outbound carries neutral ChannelChoicePresentation",
    outChoices !== null &&
      outChoices.offerKind === "WELCOME" &&
      Array.isArray(outChoices.groups),
  );

  // Check Telegram replyMarkup was produced at transport boundary
  const replyMarkup = firstOutbound.replyMarkup;
  check(
    "4.3 Delivered outbound replyMarkup was rendered by Telegram transport boundary",
    replyMarkup !== null &&
      Array.isArray(replyMarkup.inline_keyboard) &&
      replyMarkup.inline_keyboard[0][0].callback_data.startsWith("fp:"),
  );

  // 4.4 Mechanical selection of button triggers 0 AI calls
  const bookButtonCallback = replyMarkup.inline_keyboard[0][0].callback_data;
  const selectionResult = await receiveInboundMessage(
    harness.deps as any,
    {
      to: "123456789",
      from: "987654321",
      text: bookButtonCallback,
      receivedAt: new Date().toISOString(),
      externalId: `tg:123456789:${Date.now() + 1}`,
    },
    {
      businessId: harness.business.id,
      branchId: harness.business.defaultBranchId,
      connectionId: "conn-1",
    },
  );

  check(
    "4.4 Mechanical button callback executes with 0 AI calls",
    aiCalls === 0 &&
      selectionResult.ok === true &&
      harness.deliveredOutbound.length >= 2,
  );

  const allPassed = checks.every((c) => c.pass);
  console.log(
    `\n── Total: ${checks.length} | Passed: ${checks.filter((c) => c.pass).length} | Failed: ${checks.filter((c) => !c.pass).length} ──`,
  );

  if (!allPassed) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
