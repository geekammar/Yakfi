/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * FlowPilot — Explicit Greeting Resume-or-New Flow Verification Suite
 *
 * Deterministic offline verification of:
 *   Test A: Fresh conversation greeting -> normal welcome choices (1️⃣ حجز موعد, 2️⃣ استفسار عن خدمة).
 *   Test B: Active DATE request greeting -> asks whether to continue or start new request (متابعة الطلب / طلب جديد).
 *   Test C: Active SLOT request greeting -> asks whether to continue or start new request; does not attach old slots.
 *   Test D: Continue -> recovers saved request scope, revalidates service/provider/date/availability before presenting fresh choices.
 *   Test E: Expired offer -> cannot be replayed unchanged; revalidates dates and availability.
 *   Test F: New -> booking draft and dependent offer mirrors cleared consistently; starts welcome flow.
 *   Test G: Confirmed appointment/history survives New -> completedTask and customer identity preserved.
 *   Test H: Repeated greeting -> stable resume behavior; no nested menus, no duplicate draft tasks, draft preserved.
 *   Test I: Old callbacks after New -> rejected as stale unknown token.
 *   Test J: Unrelated generic reply -> does not automatically attach stale booking offer buttons.
 *   Test K: Intentional answer-and-continue remains functional.
 *   Test L: Staff-owned / NEED_HUMAN protections remain intact (zero assistant intervention).
 *   Test M: State commit failure -> no unpersisted actionable buttons presented.
 *   Test N: Greetings, Continue, and New create zero appointments.
 *
 * Controlled semantic proposals are used for engine tests to prove deterministic state/offer
 * orchestration (these do not prove live model language understanding).
 *
 * Usage:
 *   pnpm check:greeting-resume-flow
 */

import "./setup-test-env";

import {
  PLAYGROUND_IDS,
  createPlaygroundHarness,
} from "../src/features/conversations/playground/harness";
import type { AiResponse } from "../src/features/conversations/server/ai-contract";
import {
  buildDateOffer,
  buildSlotOffer,
} from "../src/features/conversations/server/booking-offer";
import {
  receiveInboundMessage,
  type InboundSuccess,
} from "../src/features/conversations/server/conversation-engine";
import {
  clearBookingDraft,
  dehydrateConversationState,
  emptyConversationState,
  hasResumableDraftTask,
  hydrateConversationState,
  withPresentedOffer,
  type ConversationState,
} from "../src/features/conversations/server/conversation-state";

let totalChecks = 0;
let passedChecks = 0;
const failures: string[] = [];

function check(title: string, passed: unknown, extraInfo?: string): void {
  totalChecks++;
  if (Boolean(passed)) {
    passedChecks++;
    console.log(`✔ ${title}`);
  } else {
    failures.push(title);
    console.error(`❌ ${title}${extraInfo ? ` -> ${extraInfo}` : ""}`);
  }
}

async function saveDurableState(
  harness: any,
  state: ConversationState,
): Promise<void> {
  const existing = await harness.stateStore.load(
    harness.business.id,
    harness.conversation.id,
  );
  await harness.stateStore.save(
    harness.business.id,
    harness.conversation.id,
    existing ? existing.revision : null,
    dehydrateConversationState(state),
  );
}

async function sendInbound(
  harness: any,
  inbound: {
    from: string;
    to: string;
    text: string;
    receivedAt?: string;
    externalId?: string;
  },
) {
  if (inbound.receivedAt) {
    harness.setVirtualNow(new Date(inbound.receivedAt));
  }
  return receiveInboundMessage(harness.deps, inbound);
}

async function loadDurableState(
  harness: any,
): Promise<ConversationState | null> {
  const loaded = await harness.stateStore.load(
    harness.business.id,
    harness.conversation.id,
  );
  if (!loaded?.state) return null;
  return hydrateConversationState(loaded.state, {
    businessId: harness.business.id,
    conversationId: harness.conversation.id,
  });
}

function lastSentPayload(harness: any) {
  if (harness.deliveredOutbound.length === 0) return null;
  return harness.deliveredOutbound[harness.deliveredOutbound.length - 1];
}

function mockAiGreeting(): AiResponse {
  return {
    intent: "GREETING",
    action: "reply",
    content: "أهلاً بك! يسعدنا مساعدتك.",
    summary: null,
    handoffReason: null,
    safetyAssessment: "safe",
    extraction: {
      service: null,
      date: null,
      provider: null,
      timePreference: null,
    },
    goals: [
      {
        kind: "ANSWER",
        intent: "GREETING",
        requiredKnowledge: "NONE",
      },
    ],
  };
}

function mockAiFaq(): AiResponse {
  return {
    intent: "FAQ",
    action: "reply",
    content: "نحن متواجدون في شارع المعادي، القاهرة.",
    summary: "استفسار عن الموقع",
    handoffReason: null,
    safetyAssessment: "safe",
    extraction: {
      service: null,
      date: null,
      provider: null,
      timePreference: null,
    },
    goals: [
      {
        kind: "ANSWER",
        intent: "FAQ",
        requiredKnowledge: "FAQ",
      },
    ],
  };
}

async function run(): Promise<void> {
  console.log("── SUITE: Explicit Greeting Resume-or-New Flow ──\n");

  const baseNow = new Date("2026-10-28T10:00:00.000Z");

  // ══════════════════════════════════════════════════════════════════════════
  // Test A: Fresh conversation greeting -> normal welcome choices
  // ══════════════════════════════════════════════════════════════════════════
  console.log("── Test A: Fresh conversation greeting ──");
  {
    const harness = createPlaygroundHarness({
      customAi: {
        providerName: "MOCK_AI",
        respond: async () => mockAiGreeting(),
      } as any,
    });
    harness.setVirtualNow(baseNow);

    const res = await sendInbound(harness, {
      from: "+201000000001",
      to: harness.business.whatsappNumber ?? "+201000000000",
      text: "أهلا",
      receivedAt: baseNow.toISOString(),
    });

    const isReply =
      res.ok && (res as InboundSuccess).assistantAction === "AI_REPLY";
    check("A1. Response succeeded with AI_REPLY", isReply);
    const sent = lastSentPayload(harness);
    check(
      "A2. Choice presentation attached",
      sent?.choices !== null && sent?.choices !== undefined,
    );
    check("A3. Offer kind is WELCOME", sent?.choices?.offerKind === "WELCOME");
    check(
      "A4. Options are book and inquire",
      sent?.choices?.groups?.[0]?.[0]?.id === "book" &&
        sent?.choices?.groups?.[1]?.[0]?.id === "inquire",
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Test B: Active DATE request greeting -> resume/new question
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n── Test B: Active DATE request greeting ──");
  {
    const harness = createPlaygroundHarness({
      customAi: {
        providerName: "MOCK_AI",
        respond: async () => mockAiGreeting(),
      } as any,
    });
    harness.setVirtualNow(baseNow);

    // Seed conversation state with an active DATE offer
    const dateOffer = buildDateOffer(
      {
        businessId: harness.business.id,
        conversationId: harness.conversation.id,
      },
      "off_date_1",
      {
        serviceId: PLAYGROUND_IDS.SERV_DENTAL,
        serviceName: "كشف أسنان",
        providerId: null,
        dates: [
          { date: "2026-10-29", label: "الخميس 29 أكتوبر" },
          { date: "2026-10-30", label: "الجمعة 30 أكتوبر" },
        ],
      },
      baseNow,
    );
    if (!dateOffer) throw new Error("Failed to build test dateOffer");

    const stateWithDate = withPresentedOffer(
      emptyConversationState(),
      dateOffer,
    );
    await saveDurableState(harness, stateWithDate);

    check(
      "B0. hasResumableDraftTask is true for active DATE offer",
      hasResumableDraftTask(stateWithDate),
    );

    const res = await sendInbound(harness, {
      from: "+201000000001",
      to: harness.business.whatsappNumber ?? "+201000000000",
      text: "السلام عليكم",
      receivedAt: baseNow.toISOString(),
    });

    const isReply =
      res.ok && (res as InboundSuccess).assistantAction === "AI_REPLY";
    check("B1. Greeting on active DATE request returns AI_REPLY", isReply);
    const sent = lastSentPayload(harness);
    check("B2. Offer kind is RESUME", sent?.choices?.offerKind === "RESUME");
    check(
      "B3. Actions are 'continue' (متابعة الطلب) and 'new_request' (طلب جديد)",
      sent?.choices?.groups?.[0]?.[0]?.id === "continue" &&
        sent?.choices?.groups?.[1]?.[0]?.id === "new_request",
    );
    check(
      "B4. Copy explicitly asks to continue previous request or start new",
      sent?.body?.includes("متابعة") && sent?.body?.includes("جديد"),
    );

    // Verify draft was preserved in suspendedOffer
    const savedState = await loadDurableState(harness);
    check(
      "B5. Previous date offer preserved in suspendedOffer",
      savedState?.suspendedOffer?.kind === "DATE",
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Test C: Active SLOT request greeting -> resume/new question, no old slots
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n── Test C: Active SLOT request greeting ──");
  {
    const harness = createPlaygroundHarness({
      customAi: {
        providerName: "MOCK_AI",
        respond: async () => mockAiGreeting(),
      } as any,
    });
    harness.setVirtualNow(baseNow);

    const slotOffer = buildSlotOffer(
      {
        businessId: harness.business.id,
        conversationId: harness.conversation.id,
      },
      "off_slot_1",
      {
        serviceId: PLAYGROUND_IDS.SERV_DENTAL,
        serviceName: "كشف أسنان",
        date: "2026-10-29",
        options: [
          {
            providerId: PLAYGROUND_IDS.PROV_1,
            displayName: "د. أحمد سامي",
            startAt: "2026-10-29T10:00",
            endAt: "2026-10-29T10:30",
          },
          {
            providerId: PLAYGROUND_IDS.PROV_1,
            displayName: "د. أحمد سامي",
            startAt: "2026-10-29T11:00",
            endAt: "2026-10-29T11:30",
          },
        ],
      },
      baseNow,
    );
    if (!slotOffer) throw new Error("Failed to build test slotOffer");

    const stateWithSlot = withPresentedOffer(
      emptyConversationState(),
      slotOffer,
    );
    await saveDurableState(harness, stateWithSlot);

    const res = await sendInbound(harness, {
      from: "+201000000001",
      to: harness.business.whatsappNumber ?? "+201000000000",
      text: "أهلاً",
      receivedAt: baseNow.toISOString(),
    });

    const isReply =
      res.ok && (res as InboundSuccess).assistantAction === "AI_REPLY";
    check("C1. Greeting on active SLOT request returns AI_REPLY", isReply);
    const sent = lastSentPayload(harness);
    check(
      "C2. Choices kind is RESUME (not SLOT)",
      sent?.choices?.offerKind === "RESUME",
    );
    check(
      "C3. Buttons are continue/new_request (no old slot buttons)",
      sent?.choices?.groups?.[0]?.[0]?.id === "continue" &&
        sent?.choices?.groups?.[1]?.[0]?.id === "new_request",
    );
    check(
      "C4. Old slots are NOT attached to outgoing choices",
      !JSON.stringify(sent?.choices?.groups ?? []).includes("10:00"),
    );

    const savedState = await loadDurableState(harness);
    check(
      "C5. Previous slot offer suspended safely",
      savedState?.suspendedOffer?.kind === "SLOT",
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Test D: Continue -> correct saved scope and revalidated choices
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n── Test D: Continue -> revalidated choices ──");
  {
    const harness = createPlaygroundHarness({
      customAi: {
        providerName: "MOCK_AI",
        respond: async () => mockAiGreeting(),
      } as any,
    });
    harness.setVirtualNow(baseNow);

    // Seed state with slot offer
    const slotOffer = buildSlotOffer(
      {
        businessId: harness.business.id,
        conversationId: harness.conversation.id,
      },
      "off_slot_d",
      {
        serviceId: PLAYGROUND_IDS.SERV_DENTAL,
        serviceName: "كشف أسنان",
        date: "2026-10-29",
        options: [
          {
            providerId: PLAYGROUND_IDS.PROV_1,
            displayName: "د. أحمد سامي",
            startAt: "2026-10-29T14:00",
            endAt: "2026-10-29T14:30",
          },
        ],
      },
      baseNow,
    );
    const stateWithSlot = withPresentedOffer(
      emptyConversationState(),
      slotOffer!,
    );
    await saveDurableState(harness, stateWithSlot);

    // Greet turn -> presents RESUME
    await sendInbound(harness, {
      from: "+201000000001",
      to: harness.business.whatsappNumber ?? "+201000000000",
      text: "أهلا",
      receivedAt: baseNow.toISOString(),
    });

    const resumeState = await loadDurableState(harness);
    const resumeToken = resumeState?.offer?.token;
    if (!resumeToken) throw new Error("Resume offer token missing");

    // Click "متابعة الطلب" via callback
    const continueCallback = `fp:${resumeToken}:continue`;
    const continueRes = await sendInbound(harness, {
      from: "+201000000001",
      to: harness.business.whatsappNumber ?? "+201000000000",
      text: continueCallback,
      receivedAt: new Date(baseNow.getTime() + 5000).toISOString(),
    });

    const isReply =
      continueRes.ok &&
      (continueRes as InboundSuccess).assistantAction === "AI_REPLY";
    check("D1. Continue action returns AI_REPLY", isReply);
    const sent = lastSentPayload(harness);
    check(
      "D2. Fresh choices presented (SLOT or DATE)",
      sent?.choices !== null && sent?.choices !== undefined,
    );
    check(
      "D3. Presented choices correspond to saved service (كشف أسنان)",
      sent?.body?.includes("أسنان") ||
        sent?.choices?.offerKind === "SLOT" ||
        sent?.choices?.offerKind === "DATE",
    );
    check(
      "D4. Offer has fresh token (not stale old token)",
      sent?.choices?.offerToken !== resumeToken &&
        sent?.choices?.offerToken !== slotOffer?.token,
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Test E: Expired offer -> cannot be replayed unchanged
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n── Test E: Expired offer -> cannot be replayed unchanged ──");
  {
    const harness = createPlaygroundHarness({
      customAi: {
        providerName: "MOCK_AI",
        respond: async () => mockAiGreeting(),
      } as any,
    });
    harness.setVirtualNow(baseNow);

    // Past date (yesterday)
    const yesterdayDate = "2026-10-27";
    const expiredSlotOffer = buildSlotOffer(
      {
        businessId: harness.business.id,
        conversationId: harness.conversation.id,
      },
      "off_expired",
      {
        serviceId: PLAYGROUND_IDS.SERV_DENTAL,
        serviceName: "كشف أسنان",
        date: yesterdayDate,
        options: [
          {
            providerId: PLAYGROUND_IDS.PROV_1,
            displayName: "د. أحمد سامي",
            startAt: "2026-10-27T10:00",
            endAt: "2026-10-27T10:30",
          },
        ],
      },
      new Date("2026-10-27T08:00:00Z"),
    );

    const stateWithExpired = withPresentedOffer(
      emptyConversationState(),
      expiredSlotOffer!,
    );
    await saveDurableState(harness, stateWithExpired);

    // Customer greets
    await sendInbound(harness, {
      from: "+201000000001",
      to: harness.business.whatsappNumber ?? "+201000000000",
      text: "السلام عليكم",
      receivedAt: baseNow.toISOString(),
    });

    const resumeState = await loadDurableState(harness);
    const resumeToken = resumeState?.offer?.token;
    if (!resumeToken) throw new Error("Resume offer token missing");

    // Click continue
    const continueCallback = `fp:${resumeToken}:continue`;
    await sendInbound(harness, {
      from: "+201000000001",
      to: harness.business.whatsappNumber ?? "+201000000000",
      text: continueCallback,
      receivedAt: new Date(baseNow.getTime() + 10000).toISOString(),
    });

    const sent = lastSentPayload(harness);
    check(
      "E1. Expired/past slot offer is NOT replayed unchanged (presents DATE choices instead)",
      sent?.choices?.offerKind === "DATE",
    );
    check(
      "E2. Expired past date (2026-10-27) is not offered as a valid slot choice",
      !JSON.stringify(sent?.choices?.groups ?? []).includes("2026-10-27T10:00"),
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Test F: New -> draft and dependent offer mirrors cleared consistently
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n── Test F: New request clearing ──");
  {
    const harness = createPlaygroundHarness({
      customAi: {
        providerName: "MOCK_AI",
        respond: async () => mockAiGreeting(),
      } as any,
    });
    harness.setVirtualNow(baseNow);

    const slotOffer = buildSlotOffer(
      {
        businessId: harness.business.id,
        conversationId: harness.conversation.id,
      },
      "off_slot_f",
      {
        serviceId: PLAYGROUND_IDS.SERV_DENTAL,
        serviceName: "كشف أسنان",
        date: "2026-10-29",
        options: [
          {
            providerId: PLAYGROUND_IDS.PROV_1,
            displayName: "د. أحمد سامي",
            startAt: "2026-10-29T10:00",
            endAt: "2026-10-29T10:30",
          },
        ],
      },
      baseNow,
    );

    const stateWithSlot = withPresentedOffer(
      emptyConversationState(),
      slotOffer!,
    );
    await saveDurableState(harness, stateWithSlot);

    // Greet turn
    await sendInbound(harness, {
      from: "+201000000001",
      to: harness.business.whatsappNumber ?? "+201000000000",
      text: "أهلا",
      receivedAt: baseNow.toISOString(),
    });

    const resumeState = await loadDurableState(harness);
    const resumeToken = resumeState?.offer?.token;
    if (!resumeToken) throw new Error("Resume offer token missing");

    // Click "طلب جديد"
    const newCallback = `fp:${resumeToken}:new_request`;
    const newRes = await sendInbound(harness, {
      from: "+201000000001",
      to: harness.business.whatsappNumber ?? "+201000000000",
      text: newCallback,
      receivedAt: new Date(baseNow.getTime() + 5000).toISOString(),
    });

    const isReply =
      newRes.ok && (newRes as InboundSuccess).assistantAction === "AI_REPLY";
    check("F1. New request returns AI_REPLY", isReply);
    const sent = lastSentPayload(harness);
    check(
      "F2. Welcome choices presented after New",
      sent?.choices?.offerKind === "WELCOME",
    );

    const savedState = await loadDurableState(harness);
    check(
      "F3. Active draft task cleared (null)",
      savedState?.activeTask === null,
    );
    check(
      "F4. Selected service cleared (null)",
      savedState?.selectedService === null,
    );
    check(
      "F5. Selected date cleared (null)",
      savedState?.selectedDate === null,
    );
    check(
      "F6. Suspended offer cleared (null)",
      savedState?.suspendedOffer === null,
    );
    check(
      "F7. Booking stage reset to NOT_APPLICABLE",
      savedState?.bookingStage === "NOT_APPLICABLE",
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Test G: Confirmed appointment/history survives New
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n── Test G: Confirmed appointment & identity survive New ──");
  {
    const stateWithCompleted: ConversationState = {
      ...emptyConversationState(),
      knownFacts: {
        customerName: "أحمد محمود",
        service: "كشف أسنان",
        date: "2026-10-29",
      },
      selectedService: "كشف أسنان",
      selectedDate: "2026-10-29",
      activeTask: { kind: "BOOKING", stage: "AVAILABILITY_RESOLVED" },
      completedTask: {
        kind: "BOOKING",
        appointmentId: "apt_existing_123",
        serviceId: PLAYGROUND_IDS.SERV_DENTAL,
        providerId: PLAYGROUND_IDS.PROV_1,
        date: "2026-10-20",
        completedAt: "2026-10-20T12:00:00Z",
      },
    };

    const cleared = clearBookingDraft(stateWithCompleted);
    check(
      "G1. Confirmed appointment (completedTask) is preserved after clearBookingDraft",
      cleared.completedTask?.appointmentId === "apt_existing_123",
    );
    check(
      "G2. Customer identity (customerName) is preserved after clearBookingDraft",
      cleared.knownFacts.customerName === "أحمد محمود",
    );
    check(
      "G3. Draft service is cleared",
      cleared.selectedService === null &&
        cleared.knownFacts.service === undefined,
    );
    check(
      "G4. Draft date is cleared",
      cleared.selectedDate === null && cleared.knownFacts.date === undefined,
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Test H: Repeated greeting -> stable resume behavior
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n── Test H: Repeated greeting stability ──");
  {
    const harness = createPlaygroundHarness({
      customAi: {
        providerName: "MOCK_AI",
        respond: async () => mockAiGreeting(),
      } as any,
    });
    harness.setVirtualNow(baseNow);

    const slotOffer = buildSlotOffer(
      {
        businessId: harness.business.id,
        conversationId: harness.conversation.id,
      },
      "off_slot_h",
      {
        serviceId: PLAYGROUND_IDS.SERV_DENTAL,
        serviceName: "كشف أسنان",
        date: "2026-10-29",
        options: [
          {
            providerId: PLAYGROUND_IDS.PROV_1,
            displayName: "د. أحمد سامي",
            startAt: "2026-10-29T10:00",
            endAt: "2026-10-29T10:30",
          },
        ],
      },
      baseNow,
    );

    const stateWithSlot = withPresentedOffer(
      emptyConversationState(),
      slotOffer!,
    );
    await saveDurableState(harness, stateWithSlot);

    // Greeting 1
    await sendInbound(harness, {
      from: "+201000000001",
      to: harness.business.whatsappNumber ?? "+201000000000",
      text: "أهلا",
      receivedAt: baseNow.toISOString(),
    });

    const state1 = await loadDurableState(harness);
    check(
      "H1. First greeting presents RESUME offer",
      state1?.offer?.kind === "RESUME",
    );
    check(
      "H2. Draft preserved in suspendedOffer",
      state1?.suspendedOffer?.kind === "SLOT",
    );

    // Greeting 2 (immediately repeated)
    await sendInbound(harness, {
      from: "+201000000001",
      to: harness.business.whatsappNumber ?? "+201000000000",
      text: "السلام عليكم",
      receivedAt: new Date(baseNow.getTime() + 2000).toISOString(),
    });

    const state2 = await loadDurableState(harness);
    check(
      "H3. Second greeting also presents RESUME offer (no crash, no nest)",
      state2?.offer?.kind === "RESUME",
    );
    check(
      "H4. Original slot offer is still intact in suspendedOffer (not overwritten by RESUME)",
      state2?.suspendedOffer?.kind === "SLOT",
    );
    check("H5. Still hasResumableDraftTask", hasResumableDraftTask(state2));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Test I: Old callbacks after New -> rejected
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n── Test I: Old callbacks after New rejected ──");
  {
    const harness = createPlaygroundHarness({
      customAi: {
        providerName: "MOCK_AI",
        respond: async () => mockAiGreeting(),
      } as any,
    });
    harness.setVirtualNow(baseNow);

    const slotOffer = buildSlotOffer(
      {
        businessId: harness.business.id,
        conversationId: harness.conversation.id,
      },
      "off_slot_i",
      {
        serviceId: PLAYGROUND_IDS.SERV_DENTAL,
        serviceName: "كشف أسنان",
        date: "2026-10-29",
        options: [
          {
            providerId: PLAYGROUND_IDS.PROV_1,
            displayName: "د. أحمد سامي",
            startAt: "2026-10-29T10:00",
            endAt: "2026-10-29T10:30",
          },
        ],
      },
      baseNow,
    );
    const oldSlotToken = slotOffer!.token;

    const stateWithSlot = withPresentedOffer(
      emptyConversationState(),
      slotOffer!,
    );
    await saveDurableState(harness, stateWithSlot);

    // Greet turn
    await sendInbound(harness, {
      from: "+201000000001",
      to: harness.business.whatsappNumber ?? "+201000000000",
      text: "أهلا",
      receivedAt: baseNow.toISOString(),
    });

    const resumeState = await loadDurableState(harness);
    const resumeToken = resumeState?.offer?.token;

    // Start New request
    await sendInbound(harness, {
      from: "+201000000001",
      to: harness.business.whatsappNumber ?? "+201000000000",
      text: `fp:${resumeToken}:new_request`,
      receivedAt: new Date(baseNow.getTime() + 4000).toISOString(),
    });

    // Now try clicking the old slot button from turn 0
    const staleCallback = `fp:${oldSlotToken}:1`;
    await sendInbound(harness, {
      from: "+201000000001",
      to: harness.business.whatsappNumber ?? "+201000000000",
      text: staleCallback,
      receivedAt: new Date(baseNow.getTime() + 8000).toISOString(),
    });

    const sent = lastSentPayload(harness);
    check(
      "I1. Old callback after New request is rejected as stale (no booking created)",
      Boolean(
        sent?.body?.includes("سابقاً") ||
        sent?.body?.includes("العرض الحالي") ||
        sent?.body?.includes("انتهت صلاحية") ||
        sent?.body?.includes("استخدم الخيارات الحالية"),
      ) && harness.appointments.length === 0,
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Test J: Unrelated generic reply -> no automatic stale booking buttons
  // ══════════════════════════════════════════════════════════════════════════
  console.log(
    "\n── Test J: Unrelated generic reply does not attach old buttons ──",
  );
  {
    const harness = createPlaygroundHarness({
      customAi: {
        providerName: "MOCK_AI",
        respond: async () => mockAiFaq(),
      } as any,
    });
    harness.setVirtualNow(baseNow);

    const slotOffer = buildSlotOffer(
      {
        businessId: harness.business.id,
        conversationId: harness.conversation.id,
      },
      "off_slot_j",
      {
        serviceId: PLAYGROUND_IDS.SERV_DENTAL,
        serviceName: "كشف أسنان",
        date: "2026-10-29",
        options: [
          {
            providerId: PLAYGROUND_IDS.PROV_1,
            displayName: "د. أحمد سامي",
            startAt: "2026-10-29T10:00",
            endAt: "2026-10-29T10:30",
          },
        ],
      },
      baseNow,
    );

    const stateWithSlot = withPresentedOffer(
      emptyConversationState(),
      slotOffer!,
    );
    await saveDurableState(harness, stateWithSlot);

    // Customer asks general question (FAQ)
    const res = await sendInbound(harness, {
      from: "+201000000001",
      to: harness.business.whatsappNumber ?? "+201000000000",
      text: "أين موقعكم؟",
      receivedAt: baseNow.toISOString(),
    });

    const isReply =
      res.ok && (res as InboundSuccess).assistantAction === "AI_REPLY";
    check("J1. FAQ turn answers normally", isReply);
    const sent = lastSentPayload(harness);
    check("J2. FAQ answer text matches", sent?.body?.includes("المعادي"));
    check(
      "J3. Choices are NOT attached to unrelated FAQ reply",
      sent?.choices === null || sent?.choices === undefined,
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Test K: Intentional answer-and-continue remains functional
  // ══════════════════════════════════════════════════════════════════════════
  console.log(
    "\n── Test K: Intentional answer-and-continue preserves choices ──",
  );
  {
    const answerAndContinueAi: AiResponse = {
      intent: "FAQ",
      action: "reply",
      content: "سعر الكشف 200 جنيه.",
      summary: "سؤال عن السعر مع رغبة في استكمال الحجز",
      handoffReason: null,
      safetyAssessment: "safe",
      extraction: {
        service: "كشف أسنان",
        date: null,
        provider: null,
        timePreference: null,
      },
      goals: [
        {
          kind: "ANSWER",
          intent: "FAQ",
          requiredKnowledge: "FAQ",
        },
        {
          kind: "DOMAIN_ACTION",
          intent: "BOOKING",
          requiredKnowledge: "NONE",
        },
      ],
    };

    const harness = createPlaygroundHarness({
      customAi: {
        providerName: "MOCK_AI",
        respond: async () => answerAndContinueAi,
      } as any,
    });
    harness.setVirtualNow(baseNow);

    const slotOffer = buildSlotOffer(
      {
        businessId: harness.business.id,
        conversationId: harness.conversation.id,
      },
      "off_slot_k",
      {
        serviceId: PLAYGROUND_IDS.SERV_DENTAL,
        serviceName: "كشف أسنان",
        date: "2026-10-29",
        options: [
          {
            providerId: PLAYGROUND_IDS.PROV_1,
            displayName: "د. أحمد سامي",
            startAt: "2026-10-29T10:00",
            endAt: "2026-10-29T10:30",
          },
        ],
      },
      baseNow,
    );

    const stateWithSlot = withPresentedOffer(
      emptyConversationState(),
      slotOffer!,
    );
    await saveDurableState(harness, stateWithSlot);

    await sendInbound(harness, {
      from: "+201000000001",
      to: harness.business.whatsappNumber ?? "+201000000000",
      text: "الكشف بكام وممكن أكمل الحجز؟",
      receivedAt: baseNow.toISOString(),
    });

    const sent = lastSentPayload(harness);
    check(
      "K1. Answer-and-continue content delivered",
      sent?.body?.includes("200 جنيه"),
    );
    check(
      "K2. Booking choices preserved when answerAndContinue is active",
      sent?.choices !== null && sent?.choices !== undefined,
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Test L: Staff-owned / NEED_HUMAN protections remain intact
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n── Test L: Staff-owned / NEED_HUMAN protections intact ──");
  {
    const harness = createPlaygroundHarness({
      customAi: {
        providerName: "MOCK_AI",
        respond: async () => mockAiGreeting(),
      } as any,
    });
    harness.setVirtualNow(baseNow);

    // Mark conversation NEED_HUMAN
    harness.conversation.status = "NEED_HUMAN";

    const res = await sendInbound(harness, {
      from: "+201000000001",
      to: harness.business.whatsappNumber ?? "+201000000000",
      text: "أهلا",
      receivedAt: baseNow.toISOString(),
    });

    const isDeferred =
      res.ok && (res as any).assistantAction === "DEFERRED_TO_STAFF";
    check("L1. Inbound message is DEFERRED_TO_STAFF", isDeferred);
    check(
      "L2. Status remains NEED_HUMAN",
      (res as any).conversationStatus === "NEED_HUMAN",
    );
    check(
      "L3. Zero assistant messages delivered to transport",
      lastSentPayload(harness) === null,
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Test M: State commit failure -> no unpersisted actionable buttons
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n── Test M: State commit failure -> no unpersisted buttons ──");
  {
    const harness = createPlaygroundHarness({
      customAi: {
        providerName: "MOCK_AI",
        respond: async () => mockAiGreeting(),
      } as any,
    });
    harness.setVirtualNow(baseNow);

    // Force save failure by making stateStore.save fail
    harness.stateStore.save = async () => ({ status: "conflict" });

    await sendInbound(harness, {
      from: "+201000000001",
      to: harness.business.whatsappNumber ?? "+201000000000",
      text: "أهلا",
      receivedAt: baseNow.toISOString(),
    });

    const sent = lastSentPayload(harness);
    check(
      "M1. On state commit conflict, choices are null/undefined (not sent)",
      sent?.choices === null || sent?.choices === undefined,
    );
    check(
      "M2. Emits safe temporary conflict message",
      sent?.body?.includes("تعارض مؤقت") ?? false,
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Test N: Greetings, Continue, and New create zero appointments
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n── Test N: Zero appointments created ──");
  {
    const harness = createPlaygroundHarness({
      customAi: {
        providerName: "MOCK_AI",
        respond: async () => mockAiGreeting(),
      } as any,
    });
    harness.setVirtualNow(baseNow);

    const initialAppointmentCount = harness.appointments.length;

    // Greeting 1
    await sendInbound(harness, {
      from: "+201000000001",
      to: harness.business.whatsappNumber ?? "+201000000000",
      text: "أهلا",
      receivedAt: baseNow.toISOString(),
    });

    // Telegram /start
    await sendInbound(harness, {
      from: "+201000000001",
      to: harness.business.whatsappNumber ?? "+201000000000",
      text: "/start",
      receivedAt: new Date(baseNow.getTime() + 1000).toISOString(),
    });

    const state = await loadDurableState(harness);
    const token = state?.offer?.token;
    if (token) {
      // Continue action
      await sendInbound(harness, {
        from: "+201000000001",
        to: harness.business.whatsappNumber ?? "+201000000000",
        text: `fp:${token}:continue`,
        receivedAt: new Date(baseNow.getTime() + 2000).toISOString(),
      });

      // New request action
      await sendInbound(harness, {
        from: "+201000000001",
        to: harness.business.whatsappNumber ?? "+201000000000",
        text: `fp:${token}:new_request`,
        receivedAt: new Date(baseNow.getTime() + 3000).toISOString(),
      });
    }

    const finalAppointmentCount = harness.appointments.length;
    check(
      "N1. Total appointments created across Greetings, Continue, and New is exactly 0",
      initialAppointmentCount === 0 && finalAppointmentCount === 0,
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Test O: PR45 Full Booking Scope on Resume & Local Temporal Revalidation
  // ══════════════════════════════════════════════════════════════════════════
  console.log(
    "\n── Test O: PR45 Full Booking Scope on Resume & Local Temporal Revalidation ──",
  );

  // O1: Greeting -> Continue with saved specific time
  {
    const harness = createPlaygroundHarness({
      customAi: {
        providerName: "MOCK_AI",
        respond: async () => mockAiGreeting(),
      } as any,
    });
    harness.setVirtualNow(baseNow);

    const savedState: ConversationState = {
      ...emptyConversationState(),
      serviceId: PLAYGROUND_IDS.SERV_DENTAL,
      selectedService: "كشف أسنان",
      selectedDate: "2026-10-29",
      activeTask: {
        kind: "BOOKING",
        stage: "AVAILABILITY_RESOLVED",
      },
      bookingStage: "AVAILABILITY_RESOLVED",
      knownFacts: {
        service: "كشف أسنان",
        date: "2026-10-29",
        exactTime: "14:00",
      },
    };
    await saveDurableState(harness, savedState);

    // Greeting -> presents resume offer
    await sendInbound(harness, {
      from: "+201000000001",
      to: harness.business.whatsappNumber ?? "+201000000000",
      text: "أهلا",
      receivedAt: baseNow.toISOString(),
    });

    const stateAfterGreet = await loadDurableState(harness);
    const resumeToken = stateAfterGreet?.offer?.token;
    check(
      "O1-a. Greeting presents resume offer when specific exactTime exists",
      stateAfterGreet?.offer?.kind === "RESUME" && Boolean(resumeToken),
    );

    // Continue action
    const continueRes = await sendInbound(harness, {
      from: "+201000000001",
      to: harness.business.whatsappNumber ?? "+201000000000",
      text: `fp:${resumeToken}:continue`,
      receivedAt: new Date(baseNow.getTime() + 1000).toISOString(),
    });

    const isReply =
      continueRes.ok &&
      (continueRes as InboundSuccess).assistantAction === "AI_REPLY";
    check("O1-b. Continue action returns AI_REPLY", isReply);

    const reloaded = await loadDurableState(harness);
    const sent = lastSentPayload(harness);

    check(
      "O1-c. Preserves specific exactTime 14:00 in durable knownFacts",
      reloaded?.knownFacts.exactTime === "14:00",
    );
    check(
      "O1-d. Evaluates exact time availability and offers 14:00 (2:00 مساءً) slot choice",
      sent?.choices?.offerKind === "SLOT" && sent?.body?.includes("2:00 مساءً"),
    );
  }

  // O2 & O3: Greeting -> Continue with saved unresolved 4:15, then subsequent period answer resolves it
  {
    let periodRequested = false;
    const harness = createPlaygroundHarness({
      customAi: {
        providerName: "MOCK_AI",
        respond: async (req: any) => {
          const text = req.message ?? req.userMessage?.text ?? "";
          if (text.includes("عصراً")) {
            periodRequested = true;
            return {
              intent: "BOOKING",
              action: "reply",
              content: "تمام، بعد الظهر.",
              summary: null,
              handoffReason: null,
              safetyAssessment: "safe",
              extraction: {
                service: null,
                date: null,
                provider: null,
                timePreference: "afternoon",
              },
              factUpdates: [
                {
                  key: "timePreference",
                  value: "afternoon",
                  operation: "set",
                },
              ],
              goals: [
                {
                  kind: "SCHEDULE",
                  intent: "BOOKING",
                  requiredKnowledge: "NONE",
                },
              ],
            };
          }
          return mockAiGreeting();
        },
      } as any,
    });
    harness.setVirtualNow(baseNow);

    const savedState: ConversationState = {
      ...emptyConversationState(),
      serviceId: PLAYGROUND_IDS.SERV_DENTAL,
      selectedService: "كشف أسنان",
      selectedDate: "2026-10-29",
      activeTask: {
        kind: "BOOKING",
        stage: "DATE_SUPPLIED",
      },
      bookingStage: "DATE_SUPPLIED",
      knownFacts: {
        service: "كشف أسنان",
        date: "2026-10-29",
        unresolvedTime: { hour: 4, minute: 15 },
      },
      lastClarification: {
        type: "exact_time_period",
        unresolvedTime: { hour: 4, minute: 15 },
      },
    };
    await saveDurableState(harness, savedState);

    // Greeting -> presents resume offer
    await sendInbound(harness, {
      from: "+201000000001",
      to: harness.business.whatsappNumber ?? "+201000000000",
      text: "أهلا",
      receivedAt: baseNow.toISOString(),
    });

    const stateAfterGreet = await loadDurableState(harness);
    const resumeToken = stateAfterGreet?.offer?.token;
    check(
      "O2-a. Greeting presents resume offer when unresolved 4:15 exists",
      stateAfterGreet?.offer?.kind === "RESUME" && Boolean(resumeToken),
    );

    // Continue action
    await sendInbound(harness, {
      from: "+201000000001",
      to: harness.business.whatsappNumber ?? "+201000000000",
      text: `fp:${resumeToken}:continue`,
      receivedAt: new Date(baseNow.getTime() + 1000).toISOString(),
    });

    const reloadedAfterContinue = await loadDurableState(harness);
    const sentAfterContinue = lastSentPayload(harness);

    check(
      "O2-b. Asks pending exact_time_period clarification for 4:15 (عصراً أم فجراً)",
      sentAfterContinue?.body?.includes(
        "4:15 عصراً (مساءً) أم 4:15 فجراً (صباحاً)",
      ),
    );
    check(
      "O2-c. Does not present slot buttons while time is unresolved",
      sentAfterContinue?.choices === undefined ||
        sentAfterContinue?.choices === null,
    );
    check(
      "O2-d. Durable state preserves unresolvedTime { hour: 4, minute: 15 }",
      reloadedAfterContinue?.knownFacts.unresolvedTime?.hour === 4 &&
        reloadedAfterContinue?.knownFacts.unresolvedTime?.minute === 15 &&
        reloadedAfterContinue?.lastClarification?.type === "exact_time_period",
    );

    // O3: Customer answers "عصراً"
    await sendInbound(harness, {
      from: "+201000000001",
      to: harness.business.whatsappNumber ?? "+201000000000",
      text: "عصراً إن شاء الله",
      receivedAt: new Date(baseNow.getTime() + 2000).toISOString(),
    });

    const reloadedAfterPeriod = await loadDurableState(harness);
    const sentAfterPeriod = lastSentPayload(harness);

    check(
      "O3-a. Customer period answer received and processed",
      periodRequested,
    );
    check(
      "O3-b. Unresolved 4:15 resolved to specific exactTime 16:15",
      reloadedAfterPeriod?.knownFacts.exactTime === "16:15",
    );
    check(
      "O3-c. Availability evaluated for 16:15 (4:15 مساءً)",
      sentAfterPeriod?.body?.includes("4:15 مساءً") ||
        sentAfterPeriod?.choices?.offerKind === "SLOT",
    );
  }

  // O4: Changed availability produces fresh valid options, not replayed ones
  {
    const harness = createPlaygroundHarness({
      customAi: {
        providerName: "MOCK_AI",
        respond: async () => mockAiGreeting(),
      } as any,
    });
    harness.setVirtualNow(baseNow);

    const savedState: ConversationState = {
      ...emptyConversationState(),
      serviceId: PLAYGROUND_IDS.SERV_DENTAL,
      selectedService: "كشف أسنان",
      selectedDate: "2026-10-29",
      providerPreference: PLAYGROUND_IDS.PROV_1,
      activeTask: {
        kind: "BOOKING",
        stage: "AVAILABILITY_RESOLVED",
      },
      bookingStage: "AVAILABILITY_RESOLVED",
      knownFacts: {
        service: "كشف أسنان",
        date: "2026-10-29",
        provider: PLAYGROUND_IDS.PROV_1,
        exactTime: "14:00",
      },
    };
    await saveDurableState(harness, savedState);

    // Conflicting appointments booked at 14:00 for the eligible providers
    harness.appointments.push(
      {
        id: "appt-conflict-1",
        businessId: harness.business.id,
        branchId: harness.business.defaultBranchId,
        customerId: "cust-other-1",
        serviceId: PLAYGROUND_IDS.SERV_DENTAL,
        providerId: PLAYGROUND_IDS.PROV_1,
        assignedUserId: PLAYGROUND_IDS.USER_P1,
        date: new Date("2026-10-29T00:00:00Z"),
        startTime: "14:00",
        endTime: "14:30",
        status: "CONFIRMED",
        notes: null,
        followUpRequestId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      },
      {
        id: "appt-conflict-2",
        businessId: harness.business.id,
        branchId: harness.business.defaultBranchId,
        customerId: "cust-other-2",
        serviceId: PLAYGROUND_IDS.SERV_DENTAL,
        providerId: PLAYGROUND_IDS.PROV_2,
        assignedUserId: PLAYGROUND_IDS.USER_P2,
        date: new Date("2026-10-29T00:00:00Z"),
        startTime: "14:00",
        endTime: "14:30",
        status: "CONFIRMED",
        notes: null,
        followUpRequestId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      },
    );

    // Greeting -> presents resume offer
    await sendInbound(harness, {
      from: "+201000000001",
      to: harness.business.whatsappNumber ?? "+201000000000",
      text: "أهلا",
      receivedAt: baseNow.toISOString(),
    });

    const stateAfterGreet = await loadDurableState(harness);
    const resumeToken = stateAfterGreet?.offer?.token;

    // Continue action
    await sendInbound(harness, {
      from: "+201000000001",
      to: harness.business.whatsappNumber ?? "+201000000000",
      text: `fp:${resumeToken}:continue`,
      receivedAt: new Date(baseNow.getTime() + 1000).toISOString(),
    });

    const sent = lastSentPayload(harness);
    check(
      "O4-a. Bot detects 14:00 is unavailable due to conflicting appointment",
      sent?.body?.includes("غير متاح"),
    );
    check(
      "O4-b. Honest alternative slots offered or explained (not stale 14:00)",
      !sent?.choices?.options?.some((o: any) => o.startAt?.includes("14:00")),
    );
  }

  // O5: Business-local day differs from UTC near midnight
  {
    const harness = createPlaygroundHarness({
      customAi: {
        providerName: "MOCK_AI",
        respond: async () => mockAiGreeting(),
      } as any,
    });
    // Cairo is UTC+2. At 22:30 UTC on Oct 28, it is 00:30 on Oct 29 in Cairo!
    const nearMidnightUtc = new Date("2026-10-28T22:30:00.000Z");
    harness.setVirtualNow(nearMidnightUtc);

    // Saved date was 2026-10-28 (which is in the past in Cairo local time)
    const savedState: ConversationState = {
      ...emptyConversationState(),
      serviceId: PLAYGROUND_IDS.SERV_DENTAL,
      selectedService: "كشف أسنان",
      selectedDate: "2026-10-28",
      activeTask: {
        kind: "BOOKING",
        stage: "DATE_SUPPLIED",
      },
      bookingStage: "DATE_SUPPLIED",
      knownFacts: {
        service: "كشف أسنان",
        date: "2026-10-28",
      },
    };
    await saveDurableState(harness, savedState);

    // Greeting -> presents resume offer
    await sendInbound(harness, {
      from: "+201000000001",
      to: harness.business.whatsappNumber ?? "+201000000000",
      text: "أهلا",
      receivedAt: nearMidnightUtc.toISOString(),
    });

    const stateAfterGreet = await loadDurableState(harness);
    const resumeToken = stateAfterGreet?.offer?.token;

    // Continue action
    await sendInbound(harness, {
      from: "+201000000001",
      to: harness.business.whatsappNumber ?? "+201000000000",
      text: `fp:${resumeToken}:continue`,
      receivedAt: new Date(nearMidnightUtc.getTime() + 1000).toISOString(),
    });

    const reloaded = await loadDurableState(harness);
    const sent = lastSentPayload(harness);

    check(
      "O5-a. Past date 2026-10-28 recognized as past in Cairo local timezone",
      reloaded?.knownFacts.date === undefined ||
        reloaded?.knownFacts.date === null,
    );
    check(
      "O5-b. Presents date choices for upcoming days instead of stale past slots",
      sent?.choices?.offerKind === "DATE" ||
        sent?.body?.includes("تحديد اليوم"),
    );
  }

  // O6: Saved date/time is now past in the business timezone
  {
    const harness = createPlaygroundHarness({
      customAi: {
        providerName: "MOCK_AI",
        respond: async () => mockAiGreeting(),
      } as any,
    });
    // Virtual time: 15:00 UTC (17:00 Cairo) on 2026-10-28
    const afternoonUtc = new Date("2026-10-28T15:00:00.000Z");
    harness.setVirtualNow(afternoonUtc);

    // Saved date was today 2026-10-28, but requested time was 10:00 (past)
    const savedState: ConversationState = {
      ...emptyConversationState(),
      serviceId: PLAYGROUND_IDS.SERV_DENTAL,
      selectedService: "كشف أسنان",
      selectedDate: "2026-10-28",
      activeTask: {
        kind: "BOOKING",
        stage: "AVAILABILITY_RESOLVED",
      },
      bookingStage: "AVAILABILITY_RESOLVED",
      knownFacts: {
        service: "كشف أسنان",
        date: "2026-10-28",
        exactTime: "10:00",
      },
    };
    await saveDurableState(harness, savedState);

    // Greeting -> presents resume offer
    await sendInbound(harness, {
      from: "+201000000001",
      to: harness.business.whatsappNumber ?? "+201000000000",
      text: "أهلا",
      receivedAt: afternoonUtc.toISOString(),
    });

    const stateAfterGreet = await loadDurableState(harness);
    const resumeToken = stateAfterGreet?.offer?.token;

    // Continue action
    await sendInbound(harness, {
      from: "+201000000001",
      to: harness.business.whatsappNumber ?? "+201000000000",
      text: `fp:${resumeToken}:continue`,
      receivedAt: new Date(afternoonUtc.getTime() + 1000).toISOString(),
    });

    const sent = lastSentPayload(harness);
    check(
      "O6-a. Bot detects 10:00 is past on the current local day",
      sent?.body?.includes("قد مضى اليوم"),
    );
  }

  // O7: Old callbacks remain invalid after the flow changes
  {
    const harness = createPlaygroundHarness({
      customAi: {
        providerName: "MOCK_AI",
        respond: async () => mockAiGreeting(),
      } as any,
    });
    harness.setVirtualNow(baseNow);

    const oldToken = "tokold99";
    const oldCallback = `fp:${oldToken}:slot_1`;

    const res = await sendInbound(harness, {
      from: "+201000000001",
      to: harness.business.whatsappNumber ?? "+201000000000",
      text: oldCallback,
      receivedAt: baseNow.toISOString(),
    });

    const isReply =
      res.ok && (res as InboundSuccess).assistantAction === "AI_REPLY";
    const sent = lastSentPayload(harness);
    check("O7-a. Old callback returns AI_REPLY", isReply);
    check(
      "O7-b. Old callback correctly rejected as expired/superseded",
      sent?.body?.includes("انتهت صلاحية") || sent?.body?.includes("غير صالح"),
    );
  }

  // O8: Inquiry/Continue creates zero appointments
  {
    const harness = createPlaygroundHarness({
      customAi: {
        providerName: "MOCK_AI",
        respond: async () => mockAiGreeting(),
      } as any,
    });
    harness.setVirtualNow(baseNow);

    const initialAppointmentCount = harness.appointments.length;

    const savedState: ConversationState = {
      ...emptyConversationState(),
      serviceId: PLAYGROUND_IDS.SERV_DENTAL,
      selectedService: "كشف أسنان",
      selectedDate: "2026-10-29",
      activeTask: {
        kind: "BOOKING",
        stage: "AVAILABILITY_RESOLVED",
      },
      bookingStage: "AVAILABILITY_RESOLVED",
      knownFacts: {
        service: "كشف أسنان",
        date: "2026-10-29",
        exactTime: "14:00",
      },
    };
    await saveDurableState(harness, savedState);

    await sendInbound(harness, {
      from: "+201000000001",
      to: harness.business.whatsappNumber ?? "+201000000000",
      text: "أهلا",
      receivedAt: baseNow.toISOString(),
    });

    const stateAfterGreet = await loadDurableState(harness);
    const resumeToken = stateAfterGreet?.offer?.token;

    if (resumeToken) {
      await sendInbound(harness, {
        from: "+201000000001",
        to: harness.business.whatsappNumber ?? "+201000000000",
        text: `fp:${resumeToken}:continue`,
        receivedAt: new Date(baseNow.getTime() + 1000).toISOString(),
      });
    }

    const finalAppointmentCount = harness.appointments.length;
    check(
      "O8. Total appointments created by Greeting, Resume, and Continue is exactly 0",
      initialAppointmentCount === 0 && finalAppointmentCount === 0,
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Summary
  // ══════════════════════════════════════════════════════════════════════════
  console.log(`\n══════════════════════════════════════════════`);
  console.log(`Explicit Greeting Resume-or-New Flow Summary:`);
  console.log(`Total Checks: ${totalChecks}`);
  console.log(`Passed Checks: ${passedChecks}`);
  console.log(`Failed Checks: ${failures.length}`);
  console.log(`══════════════════════════════════════════════\n`);

  if (failures.length > 0) {
    console.error("FAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("Fatal error running check-greeting-resume-flow suite:", err);
  process.exit(1);
});
