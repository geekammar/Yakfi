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
  getConversationDetail,
  getConversationInbox,
} from "../src/features/conversations/server/conversation-queries";
import {
  HISTORICAL_PROTOCOL_FALLBACK_TEXT,
  isOfferProtocolText,
  isTransportInteraction,
  resolveDisplayForMessage,
  resolveInteractionDisplay,
} from "../src/features/conversations/server/interaction-display";
import {
  getStaffWorkspace,
  type StaffWorkspaceDeps,
} from "../src/features/staff/server/workspace-service";
import {
  appointmentRepository,
  conversationRepository,
  operatorAttentionRepository,
  userRepository,
} from "../src/server/repositories";

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

  // ── Area 6: Actual Read Path Projections (Inbox, Detail, Staff Workspace) ──
  console.log(
    "\nArea 6: Actual read path projections (inbox, detail, staff workspace)",
  );

  const fixtureMessages = [
    // 1. Validated button selection
    {
      id: "msg_val_1",
      senderType: "CUSTOMER" as const,
      content: "fp:tokval123:1",
      displayText: "اختيار موعد: 10:00 ص",
      metadata: {
        v: 1,
        provenance: "CALLBACK",
        status: "VALIDATED",
        offerToken: "tokval123",
        snapshot: { action: 1, label: "10:00 ص" },
      },
      createdAt: new Date("2026-10-29T10:00:00.000Z"),
    },
    // 2. Known TEXT provenance whose content is an exact valid-shaped fp token
    {
      id: "msg_text_exact_1",
      senderType: "CUSTOMER" as const,
      content: "fp:tokval123:1",
      displayText: null,
      metadata: {
        v: 1,
        provenance: "TEXT",
      },
      createdAt: new Date("2026-10-29T10:01:00.000Z"),
    },
    // 3. Historical protocol message with absent metadata
    {
      id: "msg_hist_1",
      senderType: "CUSTOMER" as const,
      content: "fp:de392742:3",
      displayText: null,
      metadata: null,
      createdAt: new Date("2026-10-29T10:02:00.000Z"),
    },
    // 4. Normal Arabic prose
    {
      id: "msg_prose_1",
      senderType: "CUSTOMER" as const,
      content: "السلام عليكم، أريد الاستفسار عن كشف الأسنان",
      displayText: null,
      metadata: {
        v: 1,
        provenance: "TEXT",
      },
      createdAt: new Date("2026-10-29T10:03:00.000Z"),
    },
    // 5. Malformed metadata
    {
      id: "msg_malformed_1",
      senderType: "CUSTOMER" as const,
      content: "fp:tokcorrupt:99",
      displayText: null,
      metadata: "CORRUPTED_NON_OBJECT_METADATA",
      createdAt: new Date("2026-10-29T10:04:00.000Z"),
    },
  ];

  // Save original repository methods
  const origListInbox = conversationRepository.listInbox;
  const origFindDetail = conversationRepository.findDetailByBusiness;
  const origListUsers = userRepository.listByBusiness;
  const origFindOpenByConv =
    operatorAttentionRepository.findOpenByConversations;
  const origFindOpen = operatorAttentionRepository.findOpen;
  const origResolve = operatorAttentionRepository.resolve;
  const origListRecentAppointments = appointmentRepository.listRecentByCustomer;

  try {
    // 6.1 getConversationInbox read path
    conversationRepository.listInbox = (async (bizId: string) => {
      if (bizId !== "biz_read_test") return [];
      return fixtureMessages.map((msg, index) => ({
        id: `conv_inbox_${index + 1}`,
        businessId: "biz_read_test",
        status: "NEED_HUMAN" as const,
        createdAt: msg.createdAt,
        lastMessageAt: msg.createdAt,
        customerId: `cust_${index + 1}`,
        customer: {
          id: `cust_${index + 1}`,
          name: `عميل ${index + 1}`,
          phone: `+96650000000${index + 1}`,
        },
        assignedTo: null,
        messages: [
          {
            content: msg.content,
            displayText: msg.displayText,
            metadata: msg.metadata,
            senderType: msg.senderType,
            createdAt: msg.createdAt,
          },
        ],
      }));
    }) as any;

    userRepository.listByBusiness = async () => [
      {
        id: "user_staff_1",
        name: "الموظف المشرف",
        email: "staff@example.com",
        isActive: true,
        image: null,
      } as any,
    ];

    operatorAttentionRepository.findOpenByConversations = async () => new Map();

    const inboxResult = await getConversationInbox("biz_read_test");

    check(
      "6.1 getConversationInbox executes and returns 5 projected items",
      inboxResult.items.length === 5,
    );

    check(
      "6.2 Inbox: Validated interaction projects readable snapshot 'اختيار موعد: 10:00 ص' and forwards metadata",
      inboxResult.items[0]?.lastMessage?.displayText ===
        "اختيار موعد: 10:00 ص" &&
        inboxResult.items[0]?.lastMessage?.content === "fp:tokval123:1" &&
        (inboxResult.items[0]?.lastMessage?.metadata as any)?.provenance ===
          "CALLBACK",
    );

    check(
      "6.3 Inbox: Exact fp-shaped ordinary TEXT projects null displayText (verbatim display, never fallback)",
      inboxResult.items[1]?.lastMessage?.displayText === null &&
        inboxResult.items[1]?.lastMessage?.content === "fp:tokval123:1" &&
        (inboxResult.items[1]?.lastMessage?.metadata as any)?.provenance ===
          "TEXT",
    );

    check(
      "6.4 Inbox: Historical protocol message with absent metadata projects neutral fallback",
      inboxResult.items[2]?.lastMessage?.displayText ===
        HISTORICAL_PROTOCOL_FALLBACK_TEXT &&
        inboxResult.items[2]?.lastMessage?.content === "fp:de392742:3" &&
        inboxResult.items[2]?.lastMessage?.metadata === null,
    );

    check(
      "6.5 Inbox: Normal Arabic prose projects null displayText (rendered directly)",
      inboxResult.items[3]?.lastMessage?.displayText === null &&
        inboxResult.items[3]?.lastMessage?.content ===
          "السلام عليكم، أريد الاستفسار عن كشف الأسنان",
    );

    check(
      "6.6 Inbox: Malformed metadata does not crash the inbox read path",
      inboxResult.items[4]?.lastMessage?.displayText ===
        HISTORICAL_PROTOCOL_FALLBACK_TEXT &&
        inboxResult.items[4]?.lastMessage?.content === "fp:tokcorrupt:99",
    );

    // 6.2 getConversationDetail read path
    conversationRepository.findDetailByBusiness = async (
      convId: string,
      bizId: string,
    ) => {
      if (bizId !== "biz_read_test" || convId !== "conv_detail_all") {
        return null;
      }
      return {
        id: "conv_detail_all",
        businessId: "biz_read_test",
        status: "AI_ACTIVE" as const,
        aiSummary: "ملخص المحادثة",
        customerId: "cust_detail_1",
        customer: {
          id: "cust_detail_1",
          name: "سارة عبد الله",
          phone: "+966501112233",
          notes: null,
        },
        assignedTo: null,
        messages: fixtureMessages.map((msg) => ({
          id: msg.id,
          senderType: msg.senderType,
          content: msg.content,
          displayText: msg.displayText,
          metadata: msg.metadata,
          createdAt: msg.createdAt,
        })),
      } as any;
    };

    operatorAttentionRepository.findOpen = async () => null;
    operatorAttentionRepository.resolve = async () => {};
    appointmentRepository.listRecentByCustomer = async () => [];

    const detailResult = await getConversationDetail(
      "biz_read_test",
      "conv_detail_all",
      "user_staff_1",
    );

    check(
      "6.7 getConversationDetail executes and returns projected messages array",
      detailResult !== null && detailResult.messages.length === 5,
    );

    check(
      "6.8 Detail: Validated interaction has displayText and forwards metadata",
      detailResult?.messages[0]?.displayText === "اختيار موعد: 10:00 ص" &&
        (detailResult?.messages[0]?.metadata as any)?.provenance === "CALLBACK",
    );

    check(
      "6.9 Detail: Typed fp-shaped text has null displayText (renders original text, not fallback)",
      detailResult?.messages[1]?.displayText === null &&
        detailResult?.messages[1]?.content === "fp:tokval123:1" &&
        (detailResult?.messages[1]?.metadata as any)?.provenance === "TEXT",
    );

    check(
      "6.10 Detail: Historical protocol message has neutral fallback",
      detailResult?.messages[2]?.displayText ===
        HISTORICAL_PROTOCOL_FALLBACK_TEXT &&
        detailResult?.messages[2]?.content === "fp:de392742:3",
    );

    check(
      "6.11 Detail: Malformed metadata does not crash getConversationDetail",
      detailResult?.messages[4]?.displayText ===
        HISTORICAL_PROTOCOL_FALLBACK_TEXT &&
        detailResult?.messages[4]?.content === "fp:tokcorrupt:99",
    );

    // Tenant scoping check
    const wrongTenantDetail = await getConversationDetail(
      "biz_unauthorized_other",
      "conv_detail_all",
      "user_staff_1",
    );
    check(
      "6.12 Detail: Tenant scoping enforced (accessing thread from wrong business returns null)",
      wrongTenantDetail === null,
    );

    // 6.3 getStaffWorkspace read path
    const mockStaffDeps: StaffWorkspaceDeps = {
      conversations: {
        listInbox: async (bizId: string) => {
          if (bizId !== "biz_read_test") return [];
          return fixtureMessages.map((msg, index) => ({
            id: `conv_staff_${index + 1}`,
            businessId: "biz_read_test",
            status: "NEED_HUMAN" as const,
            createdAt: msg.createdAt,
            lastMessageAt: msg.createdAt,
            customerId: `cust_${index + 1}`,
            customer: {
              id: `cust_${index + 1}`,
              name: `عميل ${index + 1}`,
              phone: `+96650000000${index + 1}`,
            },
            assignedUserId: null,
            assignedTo: null,
            messages: [
              {
                content: msg.content,
                displayText: msg.displayText,
                metadata: msg.metadata,
                senderType: msg.senderType,
                createdAt: msg.createdAt,
              },
            ],
          })) as any;
        },
      },
      appointments: {
        listLatestByCustomers: async () => [],
      },
      attention: {
        findOpenByConversations: async () => new Map(),
      },
    };

    const staffResult = await getStaffWorkspace(mockStaffDeps, {
      userId: "user_staff_1",
      businessId: "biz_read_test",
      role: "STAFF",
    });

    check(
      "6.13 getStaffWorkspace executes and returns populated queue",
      staffResult.success && (staffResult as any).queue?.length === 5,
    );

    const queue = (staffResult as any).queue;
    check(
      "6.14 Staff Workspace: Validated interaction displays readable text 'اختيار موعد: 10:00 ص'",
      queue?.[0]?.lastMessage?.displayText === "اختيار موعد: 10:00 ص" &&
        queue?.[0]?.lastMessage?.content === "fp:tokval123:1",
    );

    check(
      "6.15 Staff Workspace: Typed fp-shaped text displays null (verbatim original text)",
      queue?.[1]?.lastMessage?.displayText === null &&
        queue?.[1]?.lastMessage?.content === "fp:tokval123:1",
    );

    check(
      "6.16 Staff Workspace: Historical message displays neutral fallback",
      queue?.[2]?.lastMessage?.displayText ===
        HISTORICAL_PROTOCOL_FALLBACK_TEXT &&
        queue?.[2]?.lastMessage?.content === "fp:de392742:3",
    );

    check(
      "6.17 Staff Workspace: Malformed metadata does not crash staff queue projection",
      queue?.[4]?.lastMessage?.displayText ===
        HISTORICAL_PROTOCOL_FALLBACK_TEXT &&
        queue?.[4]?.lastMessage?.content === "fp:tokcorrupt:99",
    );

    // Authorization check
    const unauthorizedStaff = await getStaffWorkspace(mockStaffDeps, {
      userId: "user_cust_1",
      businessId: "biz_read_test",
      role: "CUSTOMER" as any,
    });
    check(
      "6.18 Staff Workspace: Role authorization enforced (non-staff role rejected with success=false)",
      unauthorizedStaff.success === false,
    );
  } finally {
    // Restore original repository methods
    conversationRepository.listInbox = origListInbox;
    conversationRepository.findDetailByBusiness = origFindDetail;
    userRepository.listByBusiness = origListUsers;
    operatorAttentionRepository.findOpenByConversations = origFindOpenByConv;
    operatorAttentionRepository.findOpen = origFindOpen;
    operatorAttentionRepository.resolve = origResolve;
    appointmentRepository.listRecentByCustomer = origListRecentAppointments;
  }

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
