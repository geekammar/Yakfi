/* eslint-disable @typescript-eslint/no-explicit-any */
import "./setup-test-env";

import { createPlaygroundHarness } from "../src/features/conversations/playground/harness";
import { buildAiContext } from "../src/features/conversations/server/ai-context-builder/context-builder";
import type { AiResponse } from "../src/features/conversations/server/ai-contract";
import type {
  DateOffer,
  ProviderOffer,
  ResumeOffer,
  ServiceDetailOffer,
  ServiceOffer,
  SlotOffer,
  WelcomeOffer,
} from "../src/features/conversations/server/booking-offer";
import {
  buildChannelChoices,
  offerCallbackData,
  parseOfferCallback,
} from "../src/features/conversations/server/channel-choice";
import {
  detectTurnControlSignals,
  resolveTurnControlSignals,
} from "../src/features/conversations/server/conversation-ai";
import { createTelegramMessageTransport } from "../src/server/integrations/telegram/telegram-transport";

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

  // 1.7 RESUME offer
  const resumeOffer: ResumeOffer = {
    ...baseOffer,
    kind: "RESUME",
    options: [
      { index: 1, action: "continue", label: "متابعة الطلب" },
      { index: 2, action: "new_request", label: "طلب جديد" },
    ],
  };
  const resumeChoices = buildChannelChoices(resumeOffer);
  check(
    "1.7 RESUME offer builds neutral choices for continue and new_request",
    resumeChoices.offerKind === "RESUME" &&
      resumeChoices.groups.length === 2 &&
      resumeChoices.groups[0]?.[0]?.id === "continue" &&
      resumeChoices.groups[1]?.[0]?.id === "new_request",
  );

  // ── Area 2: Reusable Token Codec ────────────────────────────────────────────
  console.log(
    "\nArea 2: Reusable offer-bound token codec in channel-choice boundary",
  );

  const formattedToken = offerCallbackData(slotOffer, 1);
  check(
    "2.1 offerCallbackData formats compact fp:<token>:<action> token",
    formattedToken === "fp:toktest12:1",
  );

  check(
    "2.2 formatted token adheres to <= 64 bytes limit",
    Buffer.byteLength(formattedToken, "utf8") <= 64,
  );

  const parsed = parseOfferCallback(formattedToken);
  check(
    "2.3 parseOfferCallback parses index action correctly",
    parsed !== null &&
      parsed.token === "toktest12" &&
      parsed.action.kind === "index" &&
      parsed.action.index === 1,
  );

  const actionToken = offerCallbackData(welcomeOffer, "book");
  const parsedAction = parseOfferCallback(actionToken);
  check(
    "2.4 parseOfferCallback parses action name correctly",
    parsedAction !== null &&
      parsedAction.token === "toktest12" &&
      parsedAction.action.kind === "action" &&
      parsedAction.action.name === "book",
  );

  check(
    "2.5 parseOfferCallback rejects invalid tokens",
    parseOfferCallback("invalid") === null,
  );
  check(
    "2.6 parseOfferCallback rejects empty token",
    parseOfferCallback("fp::1") === null,
  );

  // ── Area 3: Real Telegram Transport Boundary Execution ──────────────────────
  console.log(
    "\nArea 3: createTelegramMessageTransport edge rendering & delivery",
  );

  const capturedSends: Array<{ url: string; body: any }> = [];
  const resolver = {
    resolve: async (ref: string) => {
      if (ref === "fp:cred_tg_1") {
        return { ok: true, value: "bot123456:secret-token" };
      }
      return {
        ok: false,
        error: {
          code: "UNAUTHORIZED_CREDENTIALS",
          message: "invalid credentials",
        },
      } as any;
    },
  };

  const realTransport = createTelegramMessageTransport({
    api: {
      fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        const body = init?.body ? JSON.parse(init.body as string) : {};
        capturedSends.push({ url: urlStr, body });
        return new Response(
          JSON.stringify({ ok: true, result: { message_id: 12345 } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
      apiHost: "https://api.telegram.org",
      credentialsResolver: resolver as any,
    },
    connectionRepository: {
      findByIdWithinBusiness: async (id: string, bizId: string) => {
        if (id !== "conn_biz1" || bizId !== "biz_1") return null;
        return {
          id: "conn_biz1",
          businessId: "biz_1",
          branchId: null,
          isActive: true,
          status: "CONNECTED",
          credentialsRef: "fp:cred_tg_1",
        } as any;
      },
    },
    credentialsResolver: resolver as any,
  });

  const sendResult = await realTransport.send({
    to: "987654321",
    content: "اختر خدمة مناسبة:",
    businessId: "biz_1",
    businessName: "عيادة الشفاء",
    conversationId: "conv_1",
    connectionId: "conn_biz1",
    choices: serviceChoices,
  });

  check(
    "3.1 Real Telegram transport accepts neutral choices and delivers successfully",
    sendResult.delivered === true && capturedSends.length === 1,
  );

  const sentPayload = capturedSends[0]?.body;
  check(
    "3.2 Real Telegram transport renders reply_markup.inline_keyboard correctly",
    sentPayload != null &&
      Array.isArray(sentPayload.reply_markup?.inline_keyboard) &&
      sentPayload.reply_markup.inline_keyboard.length === 2 &&
      sentPayload.reply_markup.inline_keyboard[0][0].callback_data ===
        "fp:toktest12:1",
  );

  // Cross-tenant send refusal
  const foreignSendResult = await realTransport.send({
    to: "987654321",
    content: "مرحبا",
    businessId: "biz_FOREIGN",
    businessName: "عيادة أخرى",
    conversationId: "conv_1",
    connectionId: "conn_biz1",
  });
  check(
    "3.3 Cross-tenant connection access is refused by transport boundary",
    foreignSendResult.delivered === false &&
      foreignSendResult.errorCode === "INVALID_CONNECTION",
  );

  // ── Area 4: Structured Context Assembly & Ownership ─────────────────────────
  console.log(
    "\nArea 4: Structured context assembly, cold-start & disclosure bounds",
  );

  const sampleServices = [
    {
      id: "srv_1",
      businessId: "biz_1",
      name: "كشف عام",
      description: "فحص طبي شامل مع قياس الضغط",
      priceType: "FIXED",
      priceAmount: 300,
      priceMaxAmount: null,
      priceCurrency: "EGP",
      priceNote: null,
      isActive: true,
    },
    {
      id: "srv_2",
      businessId: "biz_1",
      name: "استشارة",
      description: "متابعة طبية سريعة",
      priceType: "FIXED",
      priceAmount: 150,
      priceMaxAmount: null,
      priceCurrency: "EGP",
      priceNote: null,
      isActive: true,
    },
    {
      id: "srv_foreign",
      businessId: "biz_OTHER",
      name: "خدمة منشأة أخرى",
      description: "بيانات مسربة",
      priceType: "FIXED",
      priceAmount: 1000,
      priceMaxAmount: null,
      priceCurrency: "EGP",
      priceNote: null,
      isActive: true,
    },
  ];

  const sampleBusiness = {
    id: "biz_1",
    businessId: "biz_1",
    name: "عيادة الشفاء التخصصية",
    about: "عيادة رائدة لطب الأسرة والجلدية في القاهرة",
    address: "15 شارع النصر، المعادي",
    timezone: "Africa/Cairo",
    faqs: [{ question: "مواعيد العمل؟", answer: "من 9 صباحاً حتى 9 مساءً" }],
  };

  // 4.1 Cold-start with NO recognized booking/price/identity keywords
  // Utterance: "ممكن تساعدني؟" (Could you help me?)
  const coldStartBuilt = buildAiContext({
    scope: { businessId: "biz_1" },
    sources: {
      business: sampleBusiness as any,
      services: sampleServices as any,
      conversation: {
        id: "conv_cold",
        status: "AI_ACTIVE",
        recentMessages: [],
      },
      message: "ممكن تساعدني؟",
      now: new Date("2026-10-23T12:00:00Z"),
      requiredSemanticCapability: "structured_turn",
    },
  });

  check(
    "4.1 Structured cold-start provides bounded catalog and business info without keywords",
    coldStartBuilt.request.businessName === "عيادة الشفاء التخصصية" &&
      coldStartBuilt.request.businessAddress === "15 شارع النصر، المعادي" &&
      coldStartBuilt.request.businessAbout ===
        "عيادة رائدة لطب الأسرة والجلدية في القاهرة" &&
      coldStartBuilt.request.services.length === 2 &&
      coldStartBuilt.request.services[0]?.price === "300 جنيه",
  );

  // Check disclosure ledger allows backed replies on structured turn
  const catalogRecord = coldStartBuilt.facts.find(
    (f) => f.key === "service.name",
  );
  const addressRecord = coldStartBuilt.facts.find(
    (f) => f.key === "business.address",
  );
  const priceRecord = coldStartBuilt.facts.find(
    (f) => f.key === "service.price",
  );
  check(
    "4.2 Structured cold-start ledger marks authorized business facts disclosable",
    catalogRecord?.disclosable === true &&
      addressRecord?.disclosable === true &&
      priceRecord?.disclosable === true,
  );

  // Contrast with legacy path: where cold start without keywords has address and catalog excluded
  const legacyColdStart = buildAiContext({
    scope: { businessId: "biz_1" },
    sources: {
      business: sampleBusiness as any,
      services: sampleServices as any,
      conversation: {
        id: "conv_cold",
        status: "AI_ACTIVE",
        recentMessages: [],
      },
      message: "ممكن تساعدني؟",
      now: new Date("2026-10-23T12:00:00Z"),
      // No requiredSemanticCapability
    },
  });
  check(
    "4.3 Legacy path without capability remains keyword-gated (address excluded)",
    legacyColdStart.request.businessAddress === undefined,
  );

  // 4.4 Active booking followed by location question
  const activeBookingWithLocation = buildAiContext({
    scope: { businessId: "biz_1" },
    sources: {
      business: sampleBusiness as any,
      services: sampleServices as any,
      conversation: {
        id: "conv_booking",
        status: "AI_ACTIVE",
        recentMessages: [],
      },
      conversationState: {
        activeTask: { kind: "BOOKING", stage: "DATE" },
        knownFacts: { service: "كشف عام" },
        offer: null,
      } as any,
      conversationStateEnvelope: {
        businessId: "biz_1",
        conversationId: "conv_booking",
      },
      message: "مكانكم فين بالضبط؟",
      now: new Date("2026-10-23T12:00:00Z"),
      requiredSemanticCapability: "structured_turn",
    },
  });
  check(
    "4.4 Active booking followed by location question preserves both booking state & address",
    activeBookingWithLocation.request.businessAddress ===
      "15 شارع النصر، المعادي" &&
      activeBookingWithLocation.request.conversationContext?.activeTask
        ?.kind === "BOOKING" &&
      activeBookingWithLocation.request.conversationContext?.knownService ===
        "كشف عام",
  );

  // 4.5 Cross-tenant services strictly excluded
  const foreignServiceInRequest = coldStartBuilt.request.services.some(
    (s) => s.name === "خدمة منشأة أخرى",
  );
  const foreignServiceRecord = coldStartBuilt.facts.find((f) =>
    f.key.includes("خدمة منشأة أخرى"),
  );
  check(
    "4.5 Cross-tenant service excluded with UNPROVEN_TENANT",
    foreignServiceInRequest === false &&
      foreignServiceRecord?.included === false &&
      foreignServiceRecord?.exclusionReason === "UNPROVEN_TENANT",
  );

  // 4.6 Missing data remains missing (never invented)
  const businessWithoutAddress = {
    ...sampleBusiness,
    address: null,
  };
  const missingAddressBuilt = buildAiContext({
    scope: { businessId: "biz_1" },
    sources: {
      business: businessWithoutAddress as any,
      services: sampleServices as any,
      conversation: {
        id: "conv_cold",
        status: "AI_ACTIVE",
        recentMessages: [],
      },
      message: "عنوانكم ايه؟",
      now: new Date("2026-10-23T12:00:00Z"),
      requiredSemanticCapability: "structured_turn",
    },
  });
  check(
    "4.6 Missing business address is omitted from request (not invented)",
    missingAddressBuilt.request.businessAddress === undefined,
  );

  // ── Area 5: Semantic Intent Ownership (Exact-Message Counterexamples) ────────
  console.log(
    "\nArea 5: Semantic intent ownership & resolution in structured turns",
  );

  // Exact same test message: "ممكن اتكلم مع الدكتور حسام لو سمحت"
  const doctorUtterance = "ممكن اتكلم مع الدكتور حسام لو سمحت";

  // 5.1 Historical lexical detection flags explicitHuman because of doctor title + request cue
  const lexicalDoctorResult = detectTurnControlSignals(doctorUtterance);
  check(
    "5.1 Lexical detector historically flags explicitHuman on doctor + request cue",
    lexicalDoctorResult.explicitHuman === true,
  );

  // 5.2 Structured semantic decision on the EXACT SAME utterance
  const structuredDoctorBooking: AiResponse = {
    intent: "BOOKING",
    action: "reply",
    content: "تمام يا فندم، هساعدك تحجز استشارة مع دكتور حسام.",
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

  const resolvedDoctorBooking = resolveTurnControlSignals({
    currentMessage: doctorUtterance,
    routing: "LLM",
    decision: structuredDoctorBooking,
    isStructuredSemanticTurn: true,
  });

  check(
    "5.2 Structured decision overrides lexical detection: BOOKING intent stays AI_ACTIVE",
    resolvedDoctorBooking.explicitHuman === false &&
      resolvedDoctorBooking.nonCommittal === false,
  );

  // 5.3 Genuine human request
  const genuineHumanText = "محتاج اكلم شخص بشري ضروري لو سمحت";
  const structuredHumanDecision: AiResponse = {
    intent: "HUMAN_REQUEST",
    action: "handoff",
    content: "سأقوم بتحويلك لأحد ممثلي الخدمة لمساعدتك.",
    safetyAssessment: "safe",
    extraction: {
      service: null,
      provider: null,
      date: null,
      timePreference: null,
    },
    handoffReason: "HUMAN_REQUEST",
    summary: "Customer requested human representative",
    goals: [
      {
        kind: "HANDOFF",
        intent: "HUMAN_REQUEST",
        requiredKnowledge: "HUMAN_REQUEST",
      },
    ],
  };

  const resolvedHumanControl = resolveTurnControlSignals({
    currentMessage: genuineHumanText,
    routing: "LLM",
    decision: structuredHumanDecision,
    isStructuredSemanticTurn: true,
  });

  check(
    "5.3 Structured turn honors explicit customer human request when semantic decision dictates",
    resolvedHumanControl.explicitHuman === true,
  );

  // 5.4 Contradictory output: safe assessment but sensitive handoffReason
  const contradictoryDecision: AiResponse = {
    intent: "BOOKING",
    action: "handoff",
    content: "تحويل لطبيب الطوارئ",
    safetyAssessment: "safe",
    extraction: {
      service: null,
      provider: null,
      date: null,
      timePreference: null,
    },
    handoffReason: "SENSITIVE",
    summary: "Customer mentioned acute chest pain",
  };

  const resolvedContradiction = resolveTurnControlSignals({
    currentMessage: "عندي وجع شديد في صدري وعايز ميعاد",
    routing: "LLM",
    decision: contradictoryDecision,
    isStructuredSemanticTurn: true,
  });

  check(
    "5.4 Contradictory output fails safe: sensitive handoffReason forces sensitive escalation",
    resolvedContradiction.sensitive === true,
  );

  // ── Area 6: Mechanical Execution & Regressions ───────────────────────────────
  console.log("\nArea 6: Mechanical zero-model execution & regressions");

  const { receiveInboundMessage } =
    await import("../src/features/conversations/server/conversation-engine");

  const harness = createPlaygroundHarness({
    channel: "TELEGRAM",
  });

  let aiCalls = 0;
  const originalAiRespond = harness.deps.ai.respond.bind(harness.deps.ai);
  harness.deps.ai.respond = async (req: any) => {
    aiCalls++;
    return originalAiRespond(req);
  };

  // 6.1 /start command triggers welcome offer with 0 AI calls
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
    "6.1 /start renders choices and executes 0 AI calls",
    aiCalls === 0 &&
      startResult.ok === true &&
      harness.deliveredOutbound.length > 0 &&
      firstOutbound.choices !== null,
  );

  // 6.2 Button callback executes mechanically with 0 AI calls
  const bookButtonCallback =
    firstOutbound.replyMarkup?.inline_keyboard[0][0].callback_data;
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
    "6.2 Mechanical button callback executes with 0 AI calls",
    aiCalls === 0 &&
      selectionResult.ok === true &&
      harness.deliveredOutbound.length >= 2,
  );

  // 6.3 Stale button rejection on superseded token
  const staleButtonResult = await receiveInboundMessage(
    harness.deps as any,
    {
      to: "123456789",
      from: "987654321",
      text: bookButtonCallback, // old welcome offer token was superseded
      receivedAt: new Date().toISOString(),
      externalId: `tg:123456789:${Date.now() + 2}`,
    },
    {
      businessId: harness.business.id,
      branchId: harness.business.defaultBranchId,
      connectionId: "conn-1",
    },
  );

  check(
    "6.3 Superseded offer token callback is rejected safely",
    staleButtonResult.ok === true && harness.appointments.length === 0,
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
