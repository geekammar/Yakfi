/* eslint-disable @typescript-eslint/no-explicit-any */
import "./setup-test-env";

import { createPlaygroundHarness } from "../src/features/conversations/playground/harness";
import type {
  DateOffer,
  ProviderOffer,
  ResumeOffer,
  ServiceDetailOffer,
  ServiceOffer,
  SlotOffer,
  WelcomeOffer,
} from "../src/features/conversations/server/booking-offer";
import { receiveInboundMessage } from "../src/features/conversations/server/conversation-engine";
import {
  HISTORICAL_PROTOCOL_FALLBACK_TEXT,
  isOfferProtocolText,
  isTransportInteraction,
  resolveDisplayForMessage,
  resolveInteractionDisplay,
} from "../src/features/conversations/server/interaction-display";

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
    "── SUITE: Readable Interaction History & Provenance Integrity (Yakfi) ──\n",
  );

  const now = new Date("2026-10-29T10:00:00.000Z");
  const nowIso = now.toISOString();
  const futureIso = new Date("2026-10-29T18:00:00.000Z").toISOString();
  const pastIso = new Date("2026-10-29T08:00:00.000Z").toISOString();

  const baseOffer = {
    id: "off_test123",
    token: "toktest12",
    businessId: "biz_1",
    conversationId: "conv_1",
    status: "ACTIVE" as const,
    issuedAt: nowIso,
    expiresAt: futureIso,
  };

  // ── Area 1: Transport Origin & Distinction ─────────────────────────────────
  console.log("Area 1: Transport origin distinction & typing");

  check(
    "1.1 isTransportInteraction accepts CALLBACK and INTERACTIVE",
    isTransportInteraction("CALLBACK") && isTransportInteraction("INTERACTIVE"),
  );

  check(
    "1.2 isTransportInteraction rejects TEXT, undefined, or empty",
    !isTransportInteraction("TEXT") &&
      !isTransportInteraction(undefined) &&
      !isTransportInteraction("" as any),
  );

  const typedCustomerTextWithPrefix = resolveInteractionDisplay({
    rawText: "fp:toktest12:1",
    transportOrigin: "TEXT",
    currentOffer: {
      ...baseOffer,
      kind: "SERVICE",
      options: [{ index: 1, serviceId: "srv_1", name: "كشف عام" }],
    } as ServiceOffer,
    now,
  });
  check(
    "1.3 Customer text starting with 'fp:' is never treated as interaction when transportOrigin is TEXT, has TEXT provenance",
    !typedCustomerTextWithPrefix.isInteraction &&
      typedCustomerTextWithPrefix.displayText === null &&
      (typedCustomerTextWithPrefix.metadata as any)?.provenance === "TEXT" &&
      (typedCustomerTextWithPrefix.metadata as any)?.v === 1,
  );

  const typedFpResolved = resolveDisplayForMessage({
    senderType: "CUSTOMER",
    content: "fp:toktest12:1",
    displayText: null,
    metadata: { v: 1, provenance: "TEXT" },
  });
  check(
    "1.5 Manually typed exact fp:... with TEXT provenance resolves to null (rendered as original text, NOT fallback)",
    typedFpResolved === null,
  );

  const malformedInteraction = resolveInteractionDisplay({
    rawText: "not_a_valid_fp_token",
    transportOrigin: "CALLBACK",
    currentOffer: null,
    now,
  });
  check(
    "1.4 Malformed callback returns neutral wording 'خيار تفاعلي غير صالح' with status MALFORMED",
    malformedInteraction.isInteraction &&
      malformedInteraction.displayText === "خيار تفاعلي غير صالح" &&
      malformedInteraction.metadata?.status === "MALFORMED",
  );

  // ── Area 2: Token Validation & Stale Rejection ─────────────────────────────
  console.log("\nArea 2: Token validation & stale offer handling");

  const unknownTokenInteraction = resolveInteractionDisplay({
    rawText: "fp:differenttok:1",
    transportOrigin: "CALLBACK",
    currentOffer: {
      ...baseOffer,
      kind: "SERVICE",
      options: [{ index: 1, serviceId: "srv_1", name: "كشف عام" }],
    } as ServiceOffer,
    now,
  });
  check(
    "2.1 Token mismatch against current offer returns neutral label without fabricating choice",
    unknownTokenInteraction.isInteraction &&
      unknownTokenInteraction.displayText ===
        "خيار تفاعلي منتهي الصلاحية أو غير متاح" &&
      unknownTokenInteraction.metadata?.status === "UNKNOWN_TOKEN",
  );

  const missingOfferInteraction = resolveInteractionDisplay({
    rawText: "fp:toktest12:1",
    transportOrigin: "CALLBACK",
    currentOffer: null,
    now,
  });
  check(
    "2.2 Missing offer (null state) returns neutral label",
    missingOfferInteraction.isInteraction &&
      missingOfferInteraction.displayText ===
        "خيار تفاعلي منتهي الصلاحية أو غير متاح" &&
      missingOfferInteraction.metadata?.status === "UNKNOWN_TOKEN",
  );

  const expiredOfferInteraction = resolveInteractionDisplay({
    rawText: "fp:toktest12:1",
    transportOrigin: "INTERACTIVE",
    currentOffer: {
      ...baseOffer,
      expiresAt: pastIso, // expired relative to now
      kind: "SERVICE",
      options: [{ index: 1, serviceId: "srv_1", name: "كشف عام" }],
    } as ServiceOffer,
    now,
  });
  check(
    "2.3 Expired offer returns 'خيار تفاعلي منتهي الصلاحية' with status STALE",
    expiredOfferInteraction.isInteraction &&
      expiredOfferInteraction.displayText === "خيار تفاعلي منتهي الصلاحية" &&
      expiredOfferInteraction.metadata?.status === "STALE",
  );

  const closedOfferInteraction = resolveInteractionDisplay({
    rawText: "fp:toktest12:1",
    transportOrigin: "CALLBACK",
    currentOffer: {
      ...baseOffer,
      status: "CONSUMED",
      kind: "SERVICE",
      options: [{ index: 1, serviceId: "srv_1", name: "كشف عام" }],
    } as ServiceOffer,
    now,
  });
  check(
    "2.4 Consumed/closed offer returns 'خيار تفاعلي منتهي الصلاحية' with status STALE",
    closedOfferInteraction.isInteraction &&
      closedOfferInteraction.displayText === "خيار تفاعلي منتهي الصلاحية" &&
      closedOfferInteraction.metadata?.status === "STALE",
  );

  // ── Area 3: Validated Choices across All Offer Kinds ───────────────────────
  console.log("\nArea 3: Choice snapshots across all offer types");

  // WELCOME
  const welcomeOffer: WelcomeOffer = {
    ...baseOffer,
    kind: "WELCOME",
    options: [
      { index: 1, action: "book", label: "حجز موعد" },
      { index: 2, action: "inquire", label: "استفسار عن خدمة" },
    ],
  };
  const welcomeBook = resolveInteractionDisplay({
    rawText: "fp:toktest12:book",
    transportOrigin: "CALLBACK",
    currentOffer: welcomeOffer,
    now,
  });
  check(
    "3.1 WELCOME offer 'book' action resolves to 'حجز موعد'",
    welcomeBook.displayText === "حجز موعد" &&
      welcomeBook.metadata?.status === "VALIDATED",
  );

  const welcomeInquire = resolveInteractionDisplay({
    rawText: "fp:toktest12:2",
    transportOrigin: "CALLBACK",
    currentOffer: welcomeOffer,
    now,
  });
  check(
    "3.2 WELCOME offer index 2 resolves to 'استفسار عن خدمة'",
    welcomeInquire.displayText === "استفسار عن خدمة" &&
      welcomeInquire.metadata?.status === "VALIDATED",
  );

  // RESUME
  const resumeOffer: ResumeOffer = {
    ...baseOffer,
    kind: "RESUME",
    options: [
      { index: 1, action: "continue", label: "متابعة الطلب" },
      { index: 2, action: "new_request", label: "طلب جديد" },
    ],
  };
  const resumeCont = resolveInteractionDisplay({
    rawText: "fp:toktest12:continue",
    transportOrigin: "INTERACTIVE",
    currentOffer: resumeOffer,
    now,
  });
  check(
    "3.3 RESUME offer 'continue' action resolves to 'متابعة الطلب'",
    resumeCont.displayText === "متابعة الطلب" &&
      resumeCont.metadata?.status === "VALIDATED",
  );

  // SERVICE
  const serviceOffer: ServiceOffer = {
    ...baseOffer,
    kind: "SERVICE",
    purpose: "BOOKING",
    options: [
      { index: 1, serviceId: "srv_teeth", name: "كشف أسنان" },
      { index: 2, serviceId: "srv_clean", name: "تنظيف وتلميع" },
    ],
  };
  const serviceSelect = resolveInteractionDisplay({
    rawText: "fp:toktest12:1",
    transportOrigin: "CALLBACK",
    currentOffer: serviceOffer,
    now,
  });
  check(
    "3.4 SERVICE offer index 1 resolves to 'اختيار خدمة: كشف أسنان' with frozen snapshot",
    serviceSelect.displayText === "اختيار خدمة: كشف أسنان" &&
      serviceSelect.metadata?.status === "VALIDATED" &&
      (serviceSelect.metadata?.snapshot as any)?.serviceId === "srv_teeth",
  );

  // SERVICE_DETAIL
  const serviceDetailOffer: ServiceDetailOffer = {
    ...baseOffer,
    kind: "SERVICE_DETAIL",
    serviceId: "srv_teeth",
    serviceName: "كشف أسنان",
    options: [
      { index: 1, action: "book_service", label: "حجز هذه الخدمة" },
      { index: 2, action: "other_services", label: "خدمة أخرى" },
      { index: 3, action: "menu", label: "القائمة الرئيسية" },
    ],
  };
  const serviceDetailBook = resolveInteractionDisplay({
    rawText: "fp:toktest12:book_service",
    transportOrigin: "CALLBACK",
    currentOffer: serviceDetailOffer,
    now,
  });
  check(
    "3.5 SERVICE_DETAIL offer 'book_service' resolves to 'حجز موعد: كشف أسنان'",
    serviceDetailBook.displayText === "حجز موعد: كشف أسنان" &&
      serviceDetailBook.metadata?.status === "VALIDATED",
  );

  // DATE
  const dateOffer: DateOffer = {
    ...baseOffer,
    kind: "DATE",
    serviceId: "srv_teeth",
    serviceName: "كشف أسنان",
    providerId: null,
    options: [
      { index: 1, date: "2026-10-30", label: "الجمعة، 30 أكتوبر" },
      { index: 2, date: "2026-10-31", label: "السبت، 31 أكتوبر" },
    ],
    hasMore: true,
  };
  const dateSelect = resolveInteractionDisplay({
    rawText: "fp:toktest12:1",
    transportOrigin: "CALLBACK",
    currentOffer: dateOffer,
    now,
  });
  check(
    "3.6 DATE offer index 1 resolves to 'اختيار تاريخ: الجمعة، 30 أكتوبر'",
    dateSelect.displayText === "اختيار تاريخ: الجمعة، 30 أكتوبر" &&
      dateSelect.metadata?.status === "VALIDATED",
  );

  const dateMore = resolveInteractionDisplay({
    rawText: "fp:toktest12:more_dates",
    transportOrigin: "CALLBACK",
    currentOffer: dateOffer,
    now,
  });
  check(
    "3.7 DATE offer 'more_dates' resolves to 'طلب مواعيد أخرى'",
    dateMore.displayText === "طلب مواعيد أخرى" &&
      dateMore.metadata?.status === "VALIDATED",
  );

  // PROVIDER
  const providerOffer: ProviderOffer = {
    ...baseOffer,
    kind: "PROVIDER",
    serviceId: "srv_teeth",
    serviceName: "كشف أسنان",
    date: "2026-10-30",
    options: [
      { index: 1, providerId: null, name: "أي مقدم خدمة متاح" },
      { index: 2, providerId: "p_1", name: "د. هاني شاكر" },
    ],
  };
  const providerAny = resolveInteractionDisplay({
    rawText: "fp:toktest12:1",
    transportOrigin: "CALLBACK",
    currentOffer: providerOffer,
    now,
  });
  check(
    "3.8 PROVIDER ANY option resolves to 'اختيار مقدم الخدمة: أي مقدم خدمة متاح'",
    providerAny.displayText === "اختيار مقدم الخدمة: أي مقدم خدمة متاح" &&
      providerAny.metadata?.status === "VALIDATED",
  );

  const providerSpecific = resolveInteractionDisplay({
    rawText: "fp:toktest12:2",
    transportOrigin: "CALLBACK",
    currentOffer: providerOffer,
    now,
  });
  check(
    "3.9 PROVIDER specific option resolves to 'اختيار مقدم الخدمة: د. هاني شاكر'",
    providerSpecific.displayText === "اختيار مقدم الخدمة: د. هاني شاكر" &&
      providerSpecific.metadata?.status === "VALIDATED",
  );

  // SLOT
  const slotOfferSingle: SlotOffer = {
    ...baseOffer,
    kind: "SLOT",
    serviceId: "srv_teeth",
    serviceName: "كشف أسنان",
    serviceSource: "CUSTOMER",
    providerId: "p_1",
    date: "2026-10-30",
    shownCount: 2,
    followUpRequestId: null,
    options: [
      {
        index: 1,
        providerId: "p_1",
        displayName: "د. هاني شاكر",
        startAt: "2026-10-30T10:00",
        endAt: "2026-10-30T10:30",
      },
      {
        index: 2,
        providerId: "p_1",
        displayName: "د. هاني شاكر",
        startAt: "2026-10-30T14:30",
        endAt: "2026-10-30T15:00",
      },
    ],
  };
  const slotSelect1 = resolveInteractionDisplay({
    rawText: "fp:toktest12:1",
    transportOrigin: "CALLBACK",
    currentOffer: slotOfferSingle,
    now,
  });
  check(
    "3.10 SLOT single provider selection resolves to 'اختيار موعد: 10:00 ص' without claiming booking success",
    slotSelect1.displayText === "اختيار موعد: 10:00 ص" &&
      !slotSelect1.displayText?.includes("تم الحجز") &&
      slotSelect1.metadata?.status === "VALIDATED",
  );

  const slotOfferMulti: SlotOffer = {
    ...baseOffer,
    kind: "SLOT",
    serviceId: "srv_teeth",
    serviceName: "كشف أسنان",
    serviceSource: "CUSTOMER",
    providerId: null,
    date: "2026-10-30",
    shownCount: 2,
    followUpRequestId: null,
    options: [
      {
        index: 1,
        providerId: "p_1",
        displayName: "د. هاني شاكر",
        startAt: "2026-10-30T10:00",
        endAt: "2026-10-30T10:30",
      },
      {
        index: 2,
        providerId: "p_2",
        displayName: "د. سارة خالد",
        startAt: "2026-10-30T11:00",
        endAt: "2026-10-30T11:30",
      },
    ],
  };
  const slotSelectMulti = resolveInteractionDisplay({
    rawText: "fp:toktest12:2",
    transportOrigin: "INTERACTIVE",
    currentOffer: slotOfferMulti,
    now,
  });
  check(
    "3.11 SLOT multi provider selection appends provider name 'اختيار موعد: 11:00 ص (د. سارة خالد)'",
    slotSelectMulti.displayText === "اختيار موعد: 11:00 ص (د. سارة خالد)" &&
      slotSelectMulti.metadata?.status === "VALIDATED",
  );

  const slotMore = resolveInteractionDisplay({
    rawText: "fp:toktest12:more",
    transportOrigin: "CALLBACK",
    currentOffer: slotOfferSingle,
    now,
  });
  check(
    "3.12 SLOT 'more' action resolves to 'طلب أوقات أخرى'",
    slotMore.displayText === "طلب أوقات أخرى" &&
      slotMore.metadata?.status === "VALIDATED",
  );

  const slotDate = resolveInteractionDisplay({
    rawText: "fp:toktest12:date",
    transportOrigin: "CALLBACK",
    currentOffer: slotOfferSingle,
    now,
  });
  check(
    "3.13 SLOT 'date' action resolves to 'طلب يوم آخر'",
    slotDate.displayText === "طلب يوم آخر" &&
      slotDate.metadata?.status === "VALIDATED",
  );

  const slotInvalidIndex = resolveInteractionDisplay({
    rawText: "fp:toktest12:99",
    transportOrigin: "CALLBACK",
    currentOffer: slotOfferSingle,
    now,
  });
  check(
    "3.14 Invalid index returns neutral 'خيار تفاعلي غير متاح' with status INVALID_ACTION",
    slotInvalidIndex.displayText === "خيار تفاعلي غير متاح" &&
      slotInvalidIndex.metadata?.status === "INVALID_ACTION",
  );

  // ── Area 4: Historical Messages & Query Mapping ────────────────────────────
  console.log("\nArea 4: Historical messages & query resolution");

  check(
    "4.1 Protocol detection recognizes 'fp:de392742:3'",
    isOfferProtocolText("fp:de392742:3"),
  );

  check(
    "4.2 Protocol detection rejects plain text and non-callbacks",
    !isOfferProtocolText("أريد حجز موعد") && !isOfferProtocolText("fp:"),
  );

  const historicalDisplay = resolveDisplayForMessage({
    senderType: "CUSTOMER",
    content: "fp:de392742:3",
    displayText: null,
  });
  check(
    "4.3 Historical customer callback without proven snapshot returns neutral fallback",
    historicalDisplay === HISTORICAL_PROTOCOL_FALLBACK_TEXT &&
      historicalDisplay === "محتوى تقني محفوظ؛ تفاصيل الاختيار غير متاحة",
  );

  const storedDisplay = resolveDisplayForMessage({
    senderType: "CUSTOMER",
    content: "fp:de392742:3",
    displayText: "اختيار موعد: 10:00 ص",
  });
  check(
    "4.4 Message with stored displayText returns that exact proven snapshot",
    storedDisplay === "اختيار موعد: 10:00 ص",
  );

  const ordinaryTextDisplay = resolveDisplayForMessage({
    senderType: "CUSTOMER",
    content: "السلام عليكم ورحمة الله",
    displayText: null,
  });
  check(
    "4.5 Ordinary customer text returns null (UI renders message.content directly)",
    ordinaryTextDisplay === null,
  );

  const aiMessageDisplay = resolveDisplayForMessage({
    senderType: "AI",
    content: "fp:de392742:3",
    displayText: null,
  });
  check(
    "4.6 AI message never triggers historical fallback (returns null)",
    aiMessageDisplay === null,
  );

  // 4.7 Inbox, Detail, and Staff Workspace projection agreement across all message categories
  const projectionCases = [
    {
      label: "Genuine validated interaction",
      message: {
        senderType: "CUSTOMER",
        content: "fp:tok123:1",
        displayText: "اختيار موعد: 10:00 ص",
        metadata: { v: 1, provenance: "CALLBACK", status: "VALIDATED" },
      },
      expected: "اختيار موعد: 10:00 ص",
    },
    {
      label: "Typed exact fp:... with TEXT provenance",
      message: {
        senderType: "CUSTOMER",
        content: "fp:tok123:1",
        displayText: null,
        metadata: { v: 1, provenance: "TEXT" },
      },
      expected: null,
    },
    {
      label: "Historical protocol message with absent metadata",
      message: {
        senderType: "CUSTOMER",
        content: "fp:historical:1",
        displayText: null,
        metadata: null,
      },
      expected: HISTORICAL_PROTOCOL_FALLBACK_TEXT,
    },
    {
      label: "Normal prose text",
      message: {
        senderType: "CUSTOMER",
        content: "أريد الاستفسار عن كشف الأسنان",
        displayText: null,
        metadata: { v: 1, provenance: "TEXT" },
      },
      expected: null,
    },
    {
      label: "Malformed lookalike text with absent metadata",
      message: {
        senderType: "CUSTOMER",
        content: "fp:invalid",
        displayText: null,
        metadata: null,
      },
      expected: null,
    },
  ];

  for (const tc of projectionCases) {
    const resolved = resolveDisplayForMessage(tc.message);
    check(
      `4.7 Projection agreement for '${tc.label}': resolves to ${tc.expected === null ? "null (original content)" : `"${tc.expected}"`}`,
      resolved === tc.expected,
    );
  }

  // ── Area 5: End-to-End Engine Integration ──────────────────────────────────
  console.log("\nArea 5: End-to-End engine & message persistence");

  const harness = createPlaygroundHarness({
    channel: "TELEGRAM",
    todayRef: "2026-10-30",
  });
  harness.setVirtualNow(new Date("2026-10-30T09:00:00.000Z"));

  // Step 1: Inbound /start generates a welcome offer with choices
  const startResult = await receiveInboundMessage(harness.deps, {
    from: "+201009998877",
    to: "+201000000001",
    receivedAt: "2026-10-30T09:00:00.000Z",
    text: "/start",
  });
  check("5.1 /start receives valid engine result", startResult.ok);

  // Inspect the persisted conversation state
  const convId =
    startResult.ok && "conversationId" in startResult
      ? (startResult as any).conversationId
      : harness.conversation.id;

  const stateRecord = await harness.deps.conversationStateRepository!.load(
    harness.business.id,
    convId,
  );
  const liveOffer = stateRecord?.state
    ? (stateRecord.state as any).offer
    : null;
  check(
    "5.2 Conversation has a live offer with a token",
    Boolean(liveOffer?.token),
  );

  // Step 2: Customer taps button "book" via genuine Telegram callback
  const token = liveOffer.token;
  const callbackText = `fp:${token}:book`;

  const callbackResult = await receiveInboundMessage(harness.deps, {
    from: "+201009998877",
    to: "+201000000001",
    receivedAt: "2026-10-30T09:01:00.000Z",
    text: callbackText,
    transportOrigin: "CALLBACK",
  });
  check("5.3 Callback turn completes successfully", callbackResult.ok);

  // Inspect the persisted messages in repository
  const messages = await harness.deps.conversationRepository.getMessages(
    startResult.ok && "conversationId" in startResult
      ? (startResult as any).conversationId
      : "",
  );
  const customerCallbackMsg = messages.find((m) => m.content === callbackText);

  check(
    "5.4 Customer message retains EXACT raw protocol token in content",
    customerCallbackMsg?.content === callbackText,
  );

  check(
    "5.5 Customer message persists readable displayText snapshot 'حجز موعد'",
    customerCallbackMsg?.displayText === "حجز موعد",
  );

  const meta = customerCallbackMsg?.metadata as any;
  check(
    "5.6 Customer message persists structured metadata with provenance CALLBACK and VALIDATED status",
    meta?.provenance === "CALLBACK" &&
      meta?.status === "VALIDATED" &&
      meta?.offerToken === token,
  );

  // Step 3: Customer sends raw protocol token as ordinary TEXT (typed)
  const typedCallbackText = `fp:${token}:inquire`;
  await receiveInboundMessage(harness.deps, {
    from: "+201009998877",
    to: "+201000000001",
    receivedAt: "2026-10-30T09:02:00.000Z",
    text: typedCallbackText,
    transportOrigin: "TEXT",
  });

  const updatedMessages = await harness.deps.conversationRepository.getMessages(
    startResult.ok && "conversationId" in startResult
      ? (startResult as any).conversationId
      : "",
  );
  const typedMsg = updatedMessages.find((m) => m.content === typedCallbackText);

  check(
    "5.7 Manually typed text with 'fp:' prefix has NULL displayText and TEXT provenance in database",
    (typedMsg?.displayText === null || typedMsg?.displayText === undefined) &&
      (typedMsg?.metadata as any)?.provenance === "TEXT" &&
      (typedMsg?.metadata as any)?.v === 1,
  );

  const typedMsgProjected = resolveDisplayForMessage({
    senderType: typedMsg!.senderType,
    content: typedMsg!.content,
    displayText: typedMsg!.displayText,
    metadata: typedMsg!.metadata,
  });
  check(
    "5.8 Manually typed exact fp:... with TEXT provenance projects to null (renders original text, NOT fallback)",
    typedMsgProjected === null,
  );

  // Step 4: Stale callback with unknown token preserves rejection behaviour and stores truthful neutral label
  const staleCallbackText = `fp:unknowntok:1`;
  const staleResult = await receiveInboundMessage(harness.deps, {
    from: "+201009998877",
    to: "+201000000001",
    receivedAt: "2026-10-30T09:03:00.000Z",
    text: staleCallbackText,
    transportOrigin: "CALLBACK",
  });
  check("5.9 Stale callback executed through engine", staleResult.ok);

  const staleMessages = await harness.deps.conversationRepository.getMessages(
    startResult.ok && "conversationId" in startResult
      ? (startResult as any).conversationId
      : "",
  );
  const staleMsg = staleMessages.find((m) => m.content === staleCallbackText);

  const staleMeta = staleMsg?.metadata as any;
  check(
    "5.10 Stale callback persists truthful neutral wording 'خيار تفاعلي منتهي الصلاحية أو غير متاح'",
    staleMsg?.displayText === "خيار تفاعلي منتهي الصلاحية أو غير متاح" &&
      staleMeta?.status === "UNKNOWN_TOKEN",
  );

  // Step 5: Snapshot immutability check
  // Verify that previous validated callback snapshot remains unchanged after subsequent turns
  const frozenCallbackMsg = (
    await harness.deps.conversationRepository.getMessages(convId)
  ).find((m) => m.content === callbackText);
  check(
    "5.11 Persisted interaction snapshot remains strictly immutable after subsequent turns/status changes",
    frozenCallbackMsg?.displayText === "حجز موعد" &&
      (frozenCallbackMsg?.metadata as any)?.snapshot?.action === "book" &&
      (frozenCallbackMsg?.metadata as any)?.status === "VALIDATED",
  );

  // ── Total Summary ──────────────────────────────────────────────────────────
  const failed = checks.filter((c) => !c.pass);
  console.log(
    `\n── Total: ${checks.length} | Passed: ${checks.length - failed.length} | Failed: ${failed.length} ──`,
  );

  if (failed.length > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("FATAL ERROR in test run:", err);
  process.exit(1);
});
