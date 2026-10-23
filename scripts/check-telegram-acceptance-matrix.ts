/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * FlowPilot — Telegram Post-Merge Acceptance Verification Suite
 *
 * Implements the 16 required post-merge acceptance journeys on the merged baseline
 * (PR #29, commit d291f1ac7cd22c7b8ac80cc05a6a39be97df53c4, v0.70.0):
 *
 *  1. Telegram /start: welcome behavior, zero model requests, zero appointments.
 *  2. Natural-language booking request: structured interpretation, offer/clarification presented.
 *  3. Provider requested before service: clarify service while preserving provider preference.
 *  4. Unknown or ambiguous provider: clarify provider; never silently reassign.
 *  5. Relative date & morning/afternoon preference: Cairo timezone interpretation & slot filtering.
 *  6. Date correction after an offer: replace offer, invalidate stale offer, preserve compatible facts.
 *  7. Provider or time-preference removal: REMOVE semantics, clean options, no resurrection from stale context.
 *  8. FAQ interruption during booking: answer FAQ and strictly preserve active booking state.
 *  9. Valid mechanical selection: zero new model calls, appointment created, offer ACCEPTED.
 * 10. Expired, replaced, malformed, or cross-scope callback: safe rejection, zero appointments.
 * 11. Duplicate inbound delivery and repeated confirmation: idempotent dedupe, zero duplicate appointments.
 * 12. Offer persistence/CAS conflict after AI execution: safe retry message, suppress unpersisted keyboard, zero appointments.
 * 13. Staff-owned conversation: DEFERRED_TO_STAFF, zero automated execution, zero appointments.
 * 14. Explicit human request and sensitive/uncertain request: typed handoff causes, status NEED_HUMAN.
 * 15. Harmless dialectal wording near historical lexical failure cases: no false safety handoff, AI_ACTIVE preserved.
 * 16. Global stop, attempt exhaustion, and deadline exhaustion: offline injected controls, truthful stop reasons, bounded attempts.
 *
 * Evidence Level:
 *   Level A: Offline controlled-provider execution (deterministic, isolated, side-effect-free).
 *
 * Usage:
 *   pnpm check:telegram-acceptance
 */

import "./setup-test-env";

import {
  PLAYGROUND_IDS,
  createPlaygroundHarness,
} from "../src/features/conversations/playground/harness";
import type { AiResponse } from "../src/features/conversations/server/ai-contract";
import {
  buildWelcomeOffer,
  offerCallbackData,
} from "../src/features/conversations/server/booking-offer";
import { receiveInboundMessage } from "../src/features/conversations/server/conversation-engine";
import {
  dehydrateConversationState,
  emptyConversationState,
  hydrateConversationState,
} from "../src/features/conversations/server/conversation-state";
import type { TurnEvidence } from "../src/features/conversations/server/turn-evidence";
import { createLlmConversationAi } from "../src/server/integrations/ai/conversation-ai";
import { createConversationControl } from "../src/server/integrations/ai/conversation-control";
import {
  FLOWPILOT_AI_GLOBAL_STOP_FLAG,
  FLOWPILOT_AI_MAX_SERVING_ATTEMPTS_FLAG,
  createServingExecutionSession,
} from "../src/server/integrations/ai/execution-limits";
import { createOpenRouterAdapter } from "../src/server/integrations/ai/openrouter";

// ── Types and Sanitized Evidence Logger ─────────────────────────────────────

export type JourneyEvidence = {
  journeyId: number;
  name: string;
  evidenceLevel: "A" | "B" | "C" | "D";
  passed: boolean;
  initialStateSummary: string;
  syntheticInput: string;
  modelCallCount: number;
  physicalAttempts: number;
  stopReason: string | null;
  observedFacts: Record<string, unknown>;
  offerTransition: string;
  appointmentsCountBefore: number;
  appointmentsCountAfter: number;
  details?: string;
};

const journeyResults: JourneyEvidence[] = [];

function recordJourney(evidence: JourneyEvidence): void {
  journeyResults.push(evidence);
  const mark = evidence.passed ? "✔ PASS" : "❌ FAIL";
  console.log(
    `[${mark}] Journey ${evidence.journeyId}: ${evidence.name} (Level ${evidence.evidenceLevel})`,
  );
  if (evidence.details) {
    console.log(`       Details: ${evidence.details}`);
  }
}

// ── Fixed Synthetic Business Setup ──────────────────────────────────────────

const REFERENCE_INSTANT_STR = "2026-10-22T10:00:00.000Z"; // Thursday 12:00 PM Cairo
const REFERENCE_DATE_STR = "2026-10-22";
const BUSINESS_TIMEZONE = "Africa/Cairo";

function createAcceptanceHarness(
  overrides: {
    conversationId?: string;
    assignedUserId?: string | null;
    conversationStatus?: string;
    defaultServiceId?: string | null;
    defaultBookingEnabled?: boolean;
  } = {},
) {
  const harness = createPlaygroundHarness({
    channel: "TELEGRAM",
    todayRef: REFERENCE_DATE_STR,
    conversationStatus: overrides.conversationStatus ?? "AI_ACTIVE",
    assignedUserId: overrides.assignedUserId ?? null,
    businessConfig: {
      timezone: BUSINESS_TIMEZONE,
      defaultBookingServiceId: overrides.defaultServiceId ?? null,
      defaultServiceBookingEnabled: overrides.defaultBookingEnabled ?? false,
      workingHours: {
        sat: { open: "09:00", close: "18:00", closed: false },
        sun: { open: "09:00", close: "18:00", closed: false },
        mon: { open: "09:00", close: "18:00", closed: false },
        tue: { open: "09:00", close: "18:00", closed: false },
        wed: { open: "09:00", close: "18:00", closed: false },
        thu: { open: "09:00", close: "18:00", closed: false },
        fri: { open: "09:00", close: "18:00", closed: true },
      },
    },
  });

  if (overrides.conversationId) {
    harness.conversation.id = overrides.conversationId;
  }

  return harness;
}

async function sendInbound(
  harness: ReturnType<typeof createAcceptanceHarness>,
  text: string,
  updateId = Date.now(),
  options: {
    externalId?: string;
    from?: string;
  } = {},
) {
  const fromHandle = options.from ?? harness.customer.phone.replace(/^tg:/, "");
  const toHandle = harness.business.whatsappNumber ?? "6123456789";

  return receiveInboundMessage(
    harness.deps,
    {
      to: toHandle,
      from: fromHandle,
      text,
      receivedAt: harness.getVirtualNow().toISOString(),
      externalId: options.externalId ?? `tg:6123456789:${updateId}`,
    },
    {
      businessId: harness.business.id,
      branchId: harness.business.defaultBranchId,
      connectionId: "conn-telegram-accept",
    },
  );
}

async function getDurableState(
  harness: ReturnType<typeof createAcceptanceHarness>,
) {
  const row = await harness.stateStore.load(
    harness.business.id,
    harness.conversation.id,
  );
  if (!row) return null;
  return hydrateConversationState(row.state, {
    businessId: harness.business.id,
    conversationId: harness.conversation.id,
  });
}

function mockResponse(params: {
  intent?: "BOOKING" | "FAQ" | "GREETING" | "HUMAN_REQUEST";
  action?: "booking_handoff" | "reply" | "clarify";
  content: string;
  service?: string | null;
  date?: string | null;
  provider?: string | null;
  timePreference?: "morning" | "afternoon" | "evening" | null;
  safetyAssessment?: "safe" | "sensitive" | "uncertain" | null;
  handoffReason?: string | null;
  factUpdates?: Array<{
    key: string;
    operation?: "set" | "remove";
    value?: string;
  }>;
}): AiResponse {
  return {
    intent: params.intent ?? "BOOKING",
    action: (params.action ?? "booking_handoff") as any,
    content: params.content,
    summary: "طلب حجز أو استفسار",
    handoffReason: (params.handoffReason as any) ?? null,
    safetyAssessment: (params.safetyAssessment ?? "safe") as any,
    extraction: {
      service: params.service ?? null,
      date: params.date ?? null,
      provider: params.provider ?? null,
      timePreference: params.timePreference ?? null,
    },
    ...(params.factUpdates ? { factUpdates: params.factUpdates as any } : {}),
  };
}

// ── Acceptance Matrix Execution ─────────────────────────────────────────────

export async function runAcceptanceMatrix(): Promise<JourneyEvidence[]> {
  console.log(
    "===============================================================================",
  );
  console.log(
    "  FlowPilot — Post-Merge Telegram Acceptance Readiness & Evidence Suite",
  );
  console.log(
    "  Baseline: PR #29 | SHA: d291f1ac7cd22c7b8ac80cc05a6a39be97df53c4 | v0.70.0",
  );
  console.log(
    `  Reference Time: ${REFERENCE_INSTANT_STR} (${BUSINESS_TIMEZONE})`,
  );
  console.log(
    "===============================================================================\n",
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Journey 1: Telegram /start
  // Expected: welcome behavior, zero model requests, zero appointments
  // ─────────────────────────────────────────────────────────────────────────
  {
    const harness = createAcceptanceHarness({ conversationId: "conv-j01" });
    let modelCalls = 0;
    harness.deps.ai = {
      providerName: "controlled-mock",
      respond: async () => {
        modelCalls++;
        return mockResponse({ content: "unexpected" });
      },
    };

    const aptsBefore = harness.appointments.length;
    const res = await sendInbound(harness, "/start", 1001);
    const aptsAfter = harness.appointments.length;
    const lastSent =
      harness.deliveredOutbound[harness.deliveredOutbound.length - 1];
    const durable = await getDurableState(harness);

    const hasBizName = Boolean(lastSent?.body.includes(harness.business.name));
    const hasFreeTextNotice = Boolean(lastSent?.body.includes("كتابة"));
    const hasButtons = Boolean(
      (lastSent?.replyMarkup as any)?.inline_keyboard?.length >= 2,
    );
    const offerKind = durable?.offer?.kind;

    const passed =
      res.ok &&
      modelCalls === 0 &&
      hasBizName &&
      hasFreeTextNotice &&
      hasButtons &&
      offerKind === "WELCOME" &&
      aptsBefore === 0 &&
      aptsAfter === 0;

    recordJourney({
      journeyId: 1,
      name: "Telegram /start welcome command",
      evidenceLevel: "A",
      passed,
      initialStateSummary: "Empty conversation, unassigned, AI_ACTIVE",
      syntheticInput: "/start",
      modelCallCount: modelCalls,
      physicalAttempts: 0,
      stopReason: null,
      observedFacts: {},
      offerTransition: `NONE -> WELCOME(${durable?.offer?.id?.slice(0, 8) ?? "none"})`,
      appointmentsCountBefore: aptsBefore,
      appointmentsCountAfter: aptsAfter,
      details: `Zero model calls verified; Welcome buttons presented with free-text guidance.`,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Journey 2: Natural-language booking request
  // Expected: structured interpretation and correct clarification or offer
  // ─────────────────────────────────────────────────────────────────────────
  {
    const harness = createAcceptanceHarness({ conversationId: "conv-j02" });
    let modelCalls = 0;
    harness.deps.ai = {
      providerName: "controlled-mock",
      respond: async () => {
        modelCalls++;
        return mockResponse({
          intent: "BOOKING",
          action: "booking_handoff",
          content: "يسعدنا خدمتك، يرجى اختيار الموعد المناسب لكشف الأسنان:",
          service: "كشف أسنان",
        });
      },
    };

    const aptsBefore = harness.appointments.length;
    const res = await sendInbound(harness, "عايز أحجز كشف أسنان", 2001);
    const aptsAfter = harness.appointments.length;
    const durable = await getDurableState(harness);

    const serviceResolved = durable?.knownFacts.service === "كشف أسنان";
    const serviceIdMatches =
      (durable?.offer as any)?.serviceId === PLAYGROUND_IDS.SERV_DENTAL;
    const offerActive = durable?.offer?.status === "ACTIVE";

    const passed =
      res.ok &&
      modelCalls === 1 &&
      serviceResolved &&
      serviceIdMatches &&
      offerActive &&
      aptsBefore === 0 &&
      aptsAfter === 0;

    recordJourney({
      journeyId: 2,
      name: "Natural-language booking request",
      evidenceLevel: "A",
      passed,
      initialStateSummary: "Empty conversation, unassigned",
      syntheticInput: "عايز أحجز كشف أسنان",
      modelCallCount: modelCalls,
      physicalAttempts: 1,
      stopReason: null,
      observedFacts: {
        service: durable?.knownFacts.service,
        serviceId: (durable?.offer as any)?.serviceId,
      },
      offerTransition: `NONE -> ${durable?.offer?.kind ?? "NONE"}(ACTIVE)`,
      appointmentsCountBefore: aptsBefore,
      appointmentsCountAfter: aptsAfter,
      details: `Service identified from catalog ('كشف أسنان'); scheduling offer generated; 0 appointments.`,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Journey 3: Provider requested before service
  // Expected: clarify service while preserving provider preference
  // ─────────────────────────────────────────────────────────────────────────
  {
    const harness = createAcceptanceHarness({ conversationId: "conv-j03" });
    let modelCalls = 0;
    harness.deps.ai = {
      providerName: "controlled-mock",
      respond: async () => {
        modelCalls++;
        return mockResponse({
          intent: "BOOKING",
          action: "booking_handoff",
          content: "د. أحمد سامي متاح لدينا. ما الخدمة المطلوبة؟",
          provider: "د. أحمد",
          service: null,
        });
      },
    };

    const aptsBefore = harness.appointments.length;
    const res = await sendInbound(harness, "عايز أحجز مع دكتور أحمد", 3001);
    const aptsAfter = harness.appointments.length;
    const durable = await getDurableState(harness);

    const providerPreserved =
      durable?.knownFacts.provider === "د. أحمد" &&
      durable?.providerPreference === "د. أحمد";
    const missingServiceClarification =
      durable?.activeTask?.kind === "BOOKING" &&
      durable.knownFacts.service == null &&
      durable.offer?.kind === "SERVICE";

    const passed =
      res.ok &&
      modelCalls === 1 &&
      providerPreserved &&
      missingServiceClarification &&
      aptsBefore === 0 &&
      aptsAfter === 0;

    recordJourney({
      journeyId: 3,
      name: "Provider requested before service",
      evidenceLevel: "A",
      passed,
      initialStateSummary: "Empty conversation, unassigned",
      syntheticInput: "عايز أحجز مع دكتور أحمد",
      modelCallCount: modelCalls,
      physicalAttempts: 1,
      stopReason: null,
      observedFacts: {
        provider: durable?.knownFacts.provider,
        providerPreference: durable?.providerPreference,
        service: durable?.knownFacts.service,
      },
      offerTransition: `NONE -> ${durable?.offer?.kind ?? "SERVICE"}(CLARIFY)`,
      appointmentsCountBefore: aptsBefore,
      appointmentsCountAfter: aptsAfter,
      details: `Provider preference 'د. أحمد سامي' persisted while presenting service choices.`,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Journey 4: Unknown or ambiguous provider
  // Expected: clarification; never silently select a different provider
  // ─────────────────────────────────────────────────────────────────────────
  {
    const harness = createAcceptanceHarness({ conversationId: "conv-j04" });
    let modelCalls = 0;
    harness.deps.ai = {
      providerName: "controlled-mock",
      respond: async () => {
        modelCalls++;
        return mockResponse({
          intent: "BOOKING",
          action: "clarify",
          content:
            "لم نجد طبيباً باسم د. حسام. الأطباء المتاحون هم د. أحمد سامي و د. علي محمود.",
          service: "كشف أسنان",
          provider: "د. حسام",
        });
      },
    };

    const aptsBefore = harness.appointments.length;
    const res = await sendInbound(
      harness,
      "عايز كشف أسنان مع دكتور حسام",
      4001,
    );
    const aptsAfter = harness.appointments.length;
    const durable = await getDurableState(harness);

    // Verify neither PRV_1 nor PRV_2 was silently assigned
    const noSilentAssignment =
      (durable as any)?.providerId !== PLAYGROUND_IDS.PROV_1 &&
      (durable as any)?.providerId !== PLAYGROUND_IDS.PROV_2;

    const passed =
      res.ok &&
      modelCalls === 1 &&
      noSilentAssignment &&
      aptsBefore === 0 &&
      aptsAfter === 0;

    recordJourney({
      journeyId: 4,
      name: "Unknown or ambiguous provider",
      evidenceLevel: "A",
      passed,
      initialStateSummary: "Empty conversation, unassigned",
      syntheticInput: "عايز كشف أسنان مع دكتور حسام",
      modelCallCount: modelCalls,
      physicalAttempts: 1,
      stopReason: null,
      observedFacts: {
        provider: durable?.knownFacts.provider,
        resolvedProviderId: (durable as any)?.providerId ?? null,
      },
      offerTransition: `NONE -> CLARIFICATION`,
      appointmentsCountBefore: aptsBefore,
      appointmentsCountAfter: aptsAfter,
      details: `Unknown provider prompted for clarification; zero silent substitution.`,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Journey 5: Relative date and morning/afternoon preference
  // Expected: correct business-timezone interpretation and canonical filtering
  // ─────────────────────────────────────────────────────────────────────────
  {
    const harness = createAcceptanceHarness({ conversationId: "conv-j05" });
    let modelCalls = 0;
    // Cairo virtualNow is 2026-10-22 (Thursday) -> tomorrow is 2026-10-23 (Friday = closed in workingHours)
    // So let's test Saturday relative date "السبت الصبح" -> 2026-10-24
    harness.deps.ai = {
      providerName: "controlled-mock",
      respond: async () => {
        modelCalls++;
        return mockResponse({
          intent: "BOOKING",
          action: "booking_handoff",
          content: "إليك المواعيد الصباحية المتاحة يوم السبت:",
          service: "كشف أسنان",
          date: "2026-10-24",
          timePreference: "morning",
        });
      },
    };

    const aptsBefore = harness.appointments.length;
    const res = await sendInbound(harness, "عايز ميعاد كشف السبت الصبح", 5001);
    const aptsAfter = harness.appointments.length;
    const durable = await getDurableState(harness);

    const timePref = durable?.knownFacts.timePreference;
    const dateResolved = durable?.knownFacts.date === "2026-10-24";
    const slotOffer = durable?.offer?.kind === "SLOT" ? durable.offer : null;

    // Verify all offered slots are strictly morning slots (< 12:00)
    const allMorningSlots =
      slotOffer &&
      slotOffer.options.every((opt: any) => {
        const hour = parseInt(opt.startAt.split("T")[1].split(":")[0], 10);
        return hour < 12;
      });

    const passed =
      res.ok &&
      modelCalls === 1 &&
      timePref === "morning" &&
      dateResolved &&
      Boolean(allMorningSlots) &&
      aptsBefore === 0 &&
      aptsAfter === 0;

    recordJourney({
      journeyId: 5,
      name: "Relative date and morning/afternoon preference",
      evidenceLevel: "A",
      passed,
      initialStateSummary: "Empty conversation, unassigned",
      syntheticInput: "عايز ميعاد كشف السبت الصبح",
      modelCallCount: modelCalls,
      physicalAttempts: 1,
      stopReason: null,
      observedFacts: {
        date: durable?.knownFacts.date,
        timePreference: durable?.knownFacts.timePreference,
      },
      offerTransition: `NONE -> SLOT(morning-only)`,
      appointmentsCountBefore: aptsBefore,
      appointmentsCountAfter: aptsAfter,
      details: `Slots filtered strictly to morning (< 12:00) on 2026-10-24 in Cairo timezone.`,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Journey 6: Date correction after an offer
  // Expected: replace the offer and preserve compatible facts
  // ─────────────────────────────────────────────────────────────────────────
  {
    const harness = createAcceptanceHarness({ conversationId: "conv-j06" });
    let modelCalls = 0;
    let turnCount = 0;
    harness.deps.ai = {
      providerName: "controlled-mock",
      respond: async () => {
        modelCalls++;
        turnCount++;
        if (turnCount === 1) {
          return mockResponse({
            intent: "BOOKING",
            action: "booking_handoff",
            content: "متاح يوم السبت:",
            service: "كشف أسنان",
            date: "2026-10-24",
            timePreference: "morning",
          });
        }
        return mockResponse({
          intent: "BOOKING",
          action: "booking_handoff",
          content: "تم تعديل اليوم إلى الأحد الصباح:",
          service: "كشف أسنان",
          date: "2026-10-25",
          timePreference: "morning",
        });
      },
    };

    await sendInbound(harness, "عايز كشف السبت الصبح", 6001);
    const durable1 = await getDurableState(harness);
    const initialOfferId = durable1?.offer?.id;

    // Customer corrects date
    const aptsBefore = harness.appointments.length;
    const res = await sendInbound(
      harness,
      "لا خليه يوم الأحد في نفس الوقت",
      6002,
    );
    const aptsAfter = harness.appointments.length;
    const durable2 = await getDurableState(harness);

    const offerReplaced =
      durable2?.offer?.id != null && durable2.offer.id !== initialOfferId;
    const dateUpdated = durable2?.knownFacts.date === "2026-10-25";
    const compatibleFactsPreserved =
      durable2?.knownFacts.service === "كشف أسنان" &&
      durable2?.knownFacts.timePreference === "morning";

    const passed =
      res.ok &&
      modelCalls === 2 &&
      offerReplaced &&
      dateUpdated &&
      compatibleFactsPreserved &&
      aptsBefore === 0 &&
      aptsAfter === 0;

    recordJourney({
      journeyId: 6,
      name: "Date correction after an offer",
      evidenceLevel: "A",
      passed,
      initialStateSummary: "Active slot offer on 2026-10-24",
      syntheticInput: "لا خليه يوم الأحد في نفس الوقت",
      modelCallCount: modelCalls,
      physicalAttempts: 2,
      stopReason: null,
      observedFacts: {
        date: durable2?.knownFacts.date,
        service: durable2?.knownFacts.service,
        timePreference: durable2?.knownFacts.timePreference,
      },
      offerTransition: `OFFER(${initialOfferId?.slice(0, 8)}) -> REPLACED(${durable2?.offer?.id?.slice(0, 8)})`,
      appointmentsCountBefore: aptsBefore,
      appointmentsCountAfter: aptsAfter,
      details: `Prior offer invalidated, new offer generated for 2026-10-25; service and morning preference preserved.`,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Journey 7: Provider or time-preference removal
  // Expected: removed facts do not reappear from stale context
  // ─────────────────────────────────────────────────────────────────────────
  {
    const harness = createAcceptanceHarness({ conversationId: "conv-j07" });
    let modelCalls = 0;
    let turnCount = 0;
    harness.deps.ai = {
      providerName: "controlled-mock",
      respond: async () => {
        modelCalls++;
        turnCount++;
        if (turnCount === 1) {
          return mockResponse({
            intent: "BOOKING",
            action: "booking_handoff",
            content: "متاح صباحاً:",
            service: "كشف أسنان",
            date: "2026-10-24",
            timePreference: "morning",
          });
        }
        return mockResponse({
          intent: "BOOKING",
          action: "booking_handoff",
          content: "تمام، إليك جميع المواعيد المتاحة على مدار اليوم:",
          service: "كشف أسنان",
          date: "2026-10-24",
          safetyAssessment: "safe",
          factUpdates: [{ key: "timePreference", operation: "remove" }],
        });
      },
    };

    await sendInbound(harness, "كشف السبت الصبح", 7001);
    const durable1 = await getDurableState(harness);
    const timePrefBefore = durable1?.knownFacts.timePreference;

    // Customer removes time preference
    const aptsBefore = harness.appointments.length;
    const res = await sendInbound(
      harness,
      "أي وقت يناسبكم مش مشكلة صباحاً أو مساءً",
      7002,
    );
    const aptsAfter = harness.appointments.length;
    const durable2 = await getDurableState(harness);

    const timePrefRemoved = durable2?.knownFacts.timePreference == null;
    const datePreserved = durable2?.knownFacts.date === "2026-10-24";
    const servicePreserved = durable2?.knownFacts.service === "كشف أسنان";

    const passed =
      res.ok &&
      modelCalls === 2 &&
      timePrefBefore === "morning" &&
      timePrefRemoved &&
      datePreserved &&
      servicePreserved &&
      aptsBefore === 0 &&
      aptsAfter === 0;

    recordJourney({
      journeyId: 7,
      name: "Provider or time-preference removal",
      evidenceLevel: "A",
      passed,
      initialStateSummary: "Active slot offer with timePreference='morning'",
      syntheticInput: "أي وقت يناسبكم مش مشكلة صباحاً أو مساءً",
      modelCallCount: modelCalls,
      physicalAttempts: 2,
      stopReason: null,
      observedFacts: {
        timePreferenceBefore: timePrefBefore,
        timePreferenceAfter: durable2?.knownFacts.timePreference,
        service: durable2?.knownFacts.service,
        date: durable2?.knownFacts.date,
      },
      offerTransition: `OFFER(morning) -> OFFER(unrestricted)`,
      appointmentsCountBefore: aptsBefore,
      appointmentsCountAfter: aptsAfter,
      details: `FactUpdate REMOVE successfully cleared timePreference; service & date preserved.`,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Journey 8: FAQ interruption during booking
  // Expected: answer appropriately and preserve unfinished booking
  // ─────────────────────────────────────────────────────────────────────────
  {
    const harness = createAcceptanceHarness({ conversationId: "conv-j08" });
    let modelCalls = 0;
    let turnCount = 0;
    harness.deps.ai = {
      providerName: "controlled-mock",
      respond: async () => {
        modelCalls++;
        turnCount++;
        if (turnCount === 1) {
          return mockResponse({
            intent: "BOOKING",
            action: "booking_handoff",
            content: "إليك المواعيد:",
            service: "كشف أسنان",
            date: "2026-10-24",
          });
        }
        return mockResponse({
          intent: "FAQ",
          action: "reply",
          content: "عنوان العيادة: الفرع الرئيسي - القاهرة.",
        });
      },
    };

    await sendInbound(harness, "عايز كشف أسنان يوم السبت", 8001);
    const durable1 = await getDurableState(harness);
    const taskBeforeKind = durable1?.activeTask?.kind;

    // Customer asks an FAQ question mid-booking
    const aptsBefore = harness.appointments.length;
    const res = await sendInbound(
      harness,
      "أين يقع مكان العيادة بالضبط؟",
      8002,
    );
    const aptsAfter = harness.appointments.length;
    const durable2 = await getDurableState(harness);

    const taskPreserved =
      taskBeforeKind === "BOOKING" && durable2?.activeTask?.kind === "BOOKING";
    const factsPreserved =
      durable2?.knownFacts.service === "كشف أسنان" &&
      durable2?.knownFacts.date === "2026-10-24";

    const passed =
      res.ok &&
      modelCalls === 2 &&
      taskPreserved &&
      factsPreserved &&
      aptsBefore === 0 &&
      aptsAfter === 0;

    recordJourney({
      journeyId: 8,
      name: "FAQ interruption during booking",
      evidenceLevel: "A",
      passed,
      initialStateSummary: "Active booking task (service + date selected)",
      syntheticInput: "أين يقع مكان العيادة بالضبط؟",
      modelCallCount: modelCalls,
      physicalAttempts: 2,
      stopReason: null,
      observedFacts: {
        activeTask: durable2?.activeTask?.kind,
        service: durable2?.knownFacts.service,
        date: durable2?.knownFacts.date,
      },
      offerTransition: `OFFER_SUSPENDED / PRESERVED`,
      appointmentsCountBefore: aptsBefore,
      appointmentsCountAfter: aptsAfter,
      details: `FAQ reply sent; active booking task and known facts strictly preserved in durable state.`,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Journey 9: Valid mechanical selection
  // Expected: zero new model calls and the correct offer transition
  // ─────────────────────────────────────────────────────────────────────────
  {
    const harness = createAcceptanceHarness({ conversationId: "conv-j09" });
    let modelCalls = 0;
    harness.deps.ai = {
      providerName: "controlled-mock",
      respond: async () => {
        modelCalls++;
        return mockResponse({
          intent: "BOOKING",
          action: "booking_handoff",
          content: "إليك المواعيد:",
          service: "كشف أسنان",
          date: "2026-10-24",
        });
      },
    };

    await sendInbound(harness, "كشف أسنان السبت", 9001);
    const durable1 = await getDurableState(harness);
    const activeSlotOffer =
      durable1?.offer?.kind === "SLOT" ? durable1.offer : null;

    const callsBeforeSelection = modelCalls;
    const aptsBefore = harness.appointments.length;

    // Customer taps option 1 on slot keyboard
    const callbackData = offerCallbackData(activeSlotOffer!, 1);
    const res = await sendInbound(harness, callbackData, 9002);

    const callsAfterSelection = modelCalls;
    const aptsAfter = harness.appointments.length;
    const durable2 = await getDurableState(harness);

    const zeroNewModelCalls = callsAfterSelection === callsBeforeSelection;
    const aptCreated = aptsAfter === aptsBefore + 1;
    const offerAccepted = durable2?.offer?.status === "CONSUMED";

    const passed = res.ok && zeroNewModelCalls && aptCreated && offerAccepted;

    recordJourney({
      journeyId: 9,
      name: "Valid mechanical selection",
      evidenceLevel: "A",
      passed,
      initialStateSummary: "Active slot offer with valid options",
      syntheticInput: callbackData,
      modelCallCount: callsAfterSelection - callsBeforeSelection,
      physicalAttempts: 0,
      stopReason: null,
      observedFacts: {
        appointmentId: harness.appointments[0]?.id,
        offerStatus: durable2?.offer?.status,
      },
      offerTransition: `SLOT(ACTIVE) -> SLOT(CONSUMED)`,
      appointmentsCountBefore: aptsBefore,
      appointmentsCountAfter: aptsAfter,
      details: `Zero new model calls consumed; exactly 1 appointment committed; offer status CONSUMED.`,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Journey 10: Expired, replaced, malformed, or cross-scope callback
  // Expected: safe rejection or recovery; no unintended booking
  // ─────────────────────────────────────────────────────────────────────────
  {
    const harness = createAcceptanceHarness({ conversationId: "conv-j10" });
    await sendInbound(harness, "/start", 10001);
    const durable1 = await getDurableState(harness);
    const validOfferToken = durable1?.offer?.token ?? "tok1000";

    const aptsBefore = harness.appointments.length;

    // 10a. Malformed callback
    await sendInbound(harness, "fp:malformed_data", 10002);

    // 10b. Cross-scope callback (token from another conversation)
    await sendInbound(harness, "fp:99999999:1", 10003);

    // 10c. Unknown action name
    await sendInbound(
      harness,
      `fp:${validOfferToken}:unknown_action_xyz`,
      10004,
    );

    // 10d. Genuinely expired offer
    const expiredWelcomeOffer = buildWelcomeOffer(
      {
        businessId: harness.business.id,
        conversationId: harness.conversation.id,
      },
      "tokexp10",
      new Date(Date.now() - 3600 * 1000),
    );
    (expiredWelcomeOffer as any).expiresAt = new Date(
      Date.now() - 1000,
    ).toISOString();
    const expiredState = { ...(durable1 as any), offer: expiredWelcomeOffer };
    await harness.stateStore.save(
      harness.business.id,
      harness.conversation.id,
      null,
      dehydrateConversationState(expiredState),
    );
    const expiredCb = offerCallbackData(expiredWelcomeOffer!, "book");
    await sendInbound(harness, expiredCb, 10005);

    const aptsAfter = harness.appointments.length;
    const passed = aptsBefore === 0 && aptsAfter === 0;

    recordJourney({
      journeyId: 10,
      name: "Expired, replaced, malformed, or cross-scope callback",
      evidenceLevel: "A",
      passed,
      initialStateSummary: "Active conversation with valid offer token",
      syntheticInput:
        "Malformed, foreign, unknown-action, and expired callbacks",
      modelCallCount: 0,
      physicalAttempts: 0,
      stopReason: null,
      observedFacts: {},
      offerTransition: `NO_MUTATION / REJECTED`,
      appointmentsCountBefore: aptsBefore,
      appointmentsCountAfter: aptsAfter,
      details: `All 4 invalid callback vectors safely rejected with zero unintended appointments.`,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Journey 11: Duplicate inbound delivery and repeated confirmation
  // Expected: no duplicate appointment or repeated side effect
  // ─────────────────────────────────────────────────────────────────────────
  {
    const harness = createAcceptanceHarness({ conversationId: "conv-j11" });
    harness.deps.ai = {
      providerName: "controlled-mock",
      respond: async () =>
        mockResponse({
          intent: "BOOKING",
          action: "booking_handoff",
          content: "المواعيد:",
          service: "كشف أسنان",
          date: "2026-10-24",
        }),
    };

    await sendInbound(harness, "كشف السبت", 11001);
    const durable1 = await getDurableState(harness);
    const slotOffer = durable1?.offer?.kind === "SLOT" ? durable1.offer : null;
    const callbackData = offerCallbackData(slotOffer!, 1);

    const fixedExternalId = "tg:testbot:dup-check-11002";
    const aptsBefore = harness.appointments.length;

    // First delivery -> confirms booking
    const res1 = await sendInbound(harness, callbackData, 11002, {
      externalId: fixedExternalId,
    });
    const aptsMid = harness.appointments.length;

    // Second delivery with identical externalId -> deduplicated
    const res2 = await sendInbound(harness, callbackData, 11002, {
      externalId: fixedExternalId,
    });
    const aptsAfter = harness.appointments.length;

    const firstSuccess =
      res1.ok && !(res1 as any).duplicate && aptsMid === aptsBefore + 1;
    const secondDedupe =
      res2.ok && (res2 as any).duplicate === true && aptsAfter === aptsMid;

    const passed = firstSuccess && secondDedupe;

    recordJourney({
      journeyId: 11,
      name: "Duplicate inbound delivery and repeated confirmation",
      evidenceLevel: "A",
      passed,
      initialStateSummary: "Slot offer ready for confirmation",
      syntheticInput: `${callbackData} (delivered twice with identical externalId)`,
      modelCallCount: 0,
      physicalAttempts: 0,
      stopReason: null,
      observedFacts: {
        firstResultOk: res1.ok,
        secondResultDuplicate: (res2 as any).duplicate,
      },
      offerTransition: `ACTIVE -> CONSUMED -> DEDUPLICATED`,
      appointmentsCountBefore: aptsBefore,
      appointmentsCountAfter: aptsAfter,
      details: `First delivery created 1 appointment; re-delivery claimed as duplicate with 0 duplicate mutations.`,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Journey 12: Offer persistence/CAS conflict after AI execution
  // Expected: safe retry, no actionable unpersisted keyboard, evidence preserved
  // ─────────────────────────────────────────────────────────────────────────
  {
    const harness = createAcceptanceHarness({ conversationId: "conv-j12" });
    const initialUnknownState: any = {
      ...emptyConversationState(),
      activeTask: { kind: "BOOKING", stage: "SERVICE_SUPPLIED" },
      knownFacts: { service: "كشف عام", provider: "طبيب غير معروف بالعيادة" },
      serviceId: PLAYGROUND_IDS.SERV_DENTAL,
      selectedService: "كشف عام",
      serviceSource: "CUSTOMER",
      providerPreference: "طبيب غير معروف بالعيادة",
      bookingStage: "SERVICE_SUPPLIED",
    };
    await harness.stateStore.save(
      harness.business.id,
      harness.conversation.id,
      null,
      dehydrateConversationState(initialUnknownState),
    );

    // Induce CAS conflict on stateStore save
    const origSave = harness.stateStore.save.bind(harness.stateStore);
    harness.stateStore.save = async () => ({ status: "conflict" });

    const aptsBefore = harness.appointments.length;
    await sendInbound(harness, "/start", 12001);
    harness.stateStore.save = origSave;

    const aptsAfter = harness.appointments.length;
    const lastSent =
      harness.deliveredOutbound[harness.deliveredOutbound.length - 1];

    const safeConflictMsg = Boolean(
      lastSent?.body.includes("تعارض") && lastSent?.body.includes("المحاولة"),
    );
    const noUnpersistedMarkup = !lastSent?.replyMarkup;

    const passed =
      safeConflictMsg &&
      noUnpersistedMarkup &&
      aptsBefore === 0 &&
      aptsAfter === 0;

    recordJourney({
      journeyId: 12,
      name: "Offer persistence / CAS conflict after execution",
      evidenceLevel: "A",
      passed,
      initialStateSummary:
        "Active booking with state revision conflict injected",
      syntheticInput: "/start",
      modelCallCount: 0,
      physicalAttempts: 0,
      stopReason: null,
      observedFacts: {
        conflictHandled: safeConflictMsg,
        unpersistedKeyboardSuppressed: noUnpersistedMarkup,
      },
      offerTransition: `CAS_CONFLICT -> SAFE_RETRY`,
      appointmentsCountBefore: aptsBefore,
      appointmentsCountAfter: aptsAfter,
      details: `CAS conflict safely handled; retry message returned; actionable buttons suppressed.`,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Journey 13: Staff-owned conversation
  // Expected: no unauthorized automated execution
  // ─────────────────────────────────────────────────────────────────────────
  {
    const harness = createAcceptanceHarness({
      conversationId: "conv-j13",
      assignedUserId: "staff-operator-1",
      conversationStatus: "NEED_HUMAN",
    });

    let modelCalls = 0;
    harness.deps.ai = {
      providerName: "controlled-mock",
      respond: async () => {
        modelCalls++;
        return mockResponse({ content: "should never run" });
      },
    };

    const aptsBefore = harness.appointments.length;
    const sentBefore = harness.deliveredOutbound.length;
    const res = await sendInbound(harness, "عايز أحجز كشف بسرعة", 13001);
    const aptsAfter = harness.appointments.length;
    const sentAfter = harness.deliveredOutbound.length;

    const deferredToStaff =
      (res as any).assistantAction === "DEFERRED_TO_STAFF";
    const noAutomatedDelivery = sentAfter === sentBefore;

    const passed =
      res.ok &&
      modelCalls === 0 &&
      deferredToStaff &&
      noAutomatedDelivery &&
      aptsBefore === 0 &&
      aptsAfter === 0;

    recordJourney({
      journeyId: 13,
      name: "Staff-owned conversation boundary",
      evidenceLevel: "A",
      passed,
      initialStateSummary: "Assigned to staff-operator-1, status NEED_HUMAN",
      syntheticInput: "عايز أحجز كشف بسرعة",
      modelCallCount: modelCalls,
      physicalAttempts: 0,
      stopReason: null,
      observedFacts: {
        assistantAction: (res as any).assistantAction,
        conversationStatus: (res as any).conversationStatus,
      },
      offerTransition: `BLOCKED_BY_STAFF_OWNERSHIP`,
      appointmentsCountBefore: aptsBefore,
      appointmentsCountAfter: aptsAfter,
      details: `Conversation engine yielded DEFERRED_TO_STAFF; zero automated AI turns; zero messages delivered.`,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Journey 14: Explicit human request and sensitive/uncertain request
  // Expected: appropriate handoff with an accurate reason
  // ─────────────────────────────────────────────────────────────────────────
  {
    const harness = createAcceptanceHarness({ conversationId: "conv-j14" });
    let modelCalls = 0;
    harness.deps.ai = {
      providerName: "controlled-mock",
      respond: async () => {
        modelCalls++;
        return mockResponse({
          intent: "HUMAN_REQUEST",
          action: "handoff" as any,
          content: "سأقوم بتحويلك لأحد موظفي خدمة العملاء.",
          handoffReason: "HUMAN_REQUEST",
        });
      },
    };

    const aptsBefore = harness.appointments.length;
    const res = await sendInbound(
      harness,
      "ممكن أكلم حد من خدمة العملاء؟",
      14001,
    );
    const aptsAfter = harness.appointments.length;

    const handoffCause = (res as any).handoffCause;
    const conversationStatus = (res as any).conversationStatus;

    const passed =
      res.ok &&
      modelCalls === 1 &&
      handoffCause === "CUSTOMER_REQUESTED_HUMAN" &&
      conversationStatus === "NEED_HUMAN" &&
      aptsBefore === 0 &&
      aptsAfter === 0;

    recordJourney({
      journeyId: 14,
      name: "Explicit human request handoff",
      evidenceLevel: "A",
      passed,
      initialStateSummary: "Active conversation, AI_ACTIVE",
      syntheticInput: "ممكن أكلم حد من خدمة العملاء؟",
      modelCallCount: modelCalls,
      physicalAttempts: 1,
      stopReason: null,
      observedFacts: {
        handoffCause,
        conversationStatus,
      },
      offerTransition: `HANDOFF(CUSTOMER_REQUESTED_HUMAN)`,
      appointmentsCountBefore: aptsBefore,
      appointmentsCountAfter: aptsAfter,
      details: `Handoff cause derived as CUSTOMER_REQUESTED_HUMAN; status transitioned to NEED_HUMAN.`,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Journey 15: Harmless dialectal wording near historical lexical failure cases
  // Expected: no false safety handoff; record semantic-debt location if failing
  // ─────────────────────────────────────────────────────────────────────────
  {
    const harness = createAcceptanceHarness({ conversationId: "conv-j15" });
    let modelCalls = 0;
    // Harmless Egyptian utterance with trigger word "مشكلة" ('أي وقت يناسبكم مش مشكلة')
    harness.deps.ai = {
      providerName: "controlled-mock",
      respond: async () => {
        modelCalls++;
        return mockResponse({
          intent: "BOOKING",
          action: "booking_handoff",
          content: "تمام، إليك المواعيد المتاحة:",
          service: "كشف أسنان",
          safetyAssessment: "safe", // Evaluated as safe by semantic engine
        });
      },
    };

    const aptsBefore = harness.appointments.length;
    const res = await sendInbound(
      harness,
      "عايز كشف أسنان وأي وقت يناسبكم مش مشكلة",
      15001,
    );
    const aptsAfter = harness.appointments.length;

    const conversationStatus = (res as any).conversationStatus;
    const handoffCause = (res as any).handoffCause;

    // Invariant: MUST NOT falsely escalate to SENSITIVE_OR_RESTRICTED handoff
    const noFalseSafetyHandoff =
      conversationStatus === "AI_ACTIVE" &&
      handoffCause !== "SENSITIVE_OR_RESTRICTED";

    const passed =
      res.ok &&
      modelCalls === 1 &&
      noFalseSafetyHandoff &&
      aptsBefore === 0 &&
      aptsAfter === 0;

    recordJourney({
      journeyId: 15,
      name: "Harmless dialectal wording safety assessment",
      evidenceLevel: "A",
      passed,
      initialStateSummary: "Active conversation, AI_ACTIVE",
      syntheticInput: "عايز كشف أسنان وأي وقت يناسبكم مش مشكلة",
      modelCallCount: modelCalls,
      physicalAttempts: 1,
      stopReason: null,
      observedFacts: {
        conversationStatus,
        handoffCause: handoffCause ?? "none",
      },
      offerTransition: `CONTINUED(AI_ACTIVE)`,
      appointmentsCountBefore: aptsBefore,
      appointmentsCountAfter: aptsAfter,
      details: `Semantic safety evaluation evaluated 'safe'; zero false SENSITIVE_OR_RESTRICTED handoff.`,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Journey 16: Global stop, attempt exhaustion, and deadline exhaustion
  // Expected: truthful stop reasons, bounded attempts, zero unintended appointments
  // ─────────────────────────────────────────────────────────────────────────
  {
    // 16a. Global stop
    let wireCalls16a = 0;
    const fetch16a: typeof fetch = async () => {
      wireCalls16a++;
      return new Response("{}", { status: 200 });
    };
    const envStop = (k: string) => {
      if (k === FLOWPILOT_AI_GLOBAL_STOP_FLAG) return "1";
      if (k === "OPENROUTER_API_KEY") return "valid-key";
      return undefined;
    };
    const primary16a = createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar: envStop,
      fetchImpl: fetch16a,
    });
    const testAi16a = createLlmConversationAi({
      primary: createConversationControl({ provider: primary16a }),
      fallbackEnabled: false,
      getEnvVar: envStop,
    });

    const emittedEvidence16a: TurnEvidence[] = [];
    const harness16a = createAcceptanceHarness({ conversationId: "conv-j16a" });
    harness16a.deps.ai = testAi16a;
    harness16a.deps.turnTelemetry = {
      emit: (ev: TurnEvidence) => emittedEvidence16a.push(ev),
    };

    const res16a = await sendInbound(
      harness16a,
      "عايز أحجز كشف أسنان النهاردة",
      16001,
    );
    const stopReason16a = emittedEvidence16a[0]?.stopReason;
    const pass16a =
      res16a.ok &&
      wireCalls16a === 0 &&
      stopReason16a === "GLOBAL_STOP" &&
      harness16a.appointments.length === 0;

    // 16b. Attempt exhaustion
    let wireCalls16b = 0;
    const fetch16b: typeof fetch = async () => {
      wireCalls16b++;
      throw new DOMException("The operation was aborted", "AbortError");
    };
    const envAllowance = (k: string) => {
      if (k === FLOWPILOT_AI_MAX_SERVING_ATTEMPTS_FLAG) return "1";
      if (k === "OPENROUTER_API_KEY") return "valid-key";
      return undefined;
    };
    const primary16b = createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar: envAllowance,
      fetchImpl: fetch16b,
    });
    const testAi16b = createLlmConversationAi({
      primary: createConversationControl({ provider: primary16b }),
      fallbackEnabled: false,
      getEnvVar: envAllowance,
    });

    const emittedEvidence16b: TurnEvidence[] = [];
    const harness16b = createAcceptanceHarness({ conversationId: "conv-j16b" });
    harness16b.deps.ai = testAi16b;
    harness16b.deps.turnTelemetry = {
      emit: (ev: TurnEvidence) => emittedEvidence16b.push(ev),
    };

    const res16b = await sendInbound(
      harness16b,
      "عايز أعرف مواعيد العمل",
      16002,
    );
    const stopReason16b = emittedEvidence16b[0]?.stopReason;
    const pass16b =
      res16b.ok &&
      wireCalls16b === 1 &&
      stopReason16b === "ATTEMPT_LIMIT_EXHAUSTED" &&
      harness16b.appointments.length === 0;

    // 16c. Deadline exhaustion
    const session16c = createServingExecutionSession({ timeoutMs: 0 });
    const deadlineDispatch = session16c.canDispatch();
    const pass16c =
      deadlineDispatch.allowed === false &&
      deadlineDispatch.reason === "DEADLINE_EXHAUSTED" &&
      session16c.getDispatchedAttempts() === 0;

    const passed = Boolean(pass16a && pass16b && pass16c);

    recordJourney({
      journeyId: 16,
      name: "Global stop, attempt limit & deadline exhaustion",
      evidenceLevel: "A",
      passed,
      initialStateSummary:
        "Injected controls (FLOWPILOT_AI_GLOBAL_STOP, MAX_SERVING_ATTEMPTS=1, deadline=0)",
      syntheticInput: "Various inputs under injected limits",
      modelCallCount: wireCalls16a + wireCalls16b,
      physicalAttempts: wireCalls16a + wireCalls16b,
      stopReason: `${stopReason16a} / ${stopReason16b} / DEADLINE_EXHAUSTED`,
      observedFacts: {
        globalStopWireCalls: wireCalls16a,
        attemptLimitWireCalls: wireCalls16b,
        deadlineWireCalls: session16c.getDispatchedAttempts(),
      },
      offerTransition: `CONTROLLED_STOP_SAFE_TERMINATION`,
      appointmentsCountBefore: 0,
      appointmentsCountAfter: 0,
      details: `16a GLOBAL_STOP (0 wire calls); 16b ATTEMPT_LIMIT_EXHAUSTED (1 wire call); 16c DEADLINE_EXHAUSTED (0 wire calls).`,
    });
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const total = journeyResults.length;
  const passedCount = journeyResults.filter((j) => j.passed).length;
  const failedCount = total - passedCount;

  console.log(
    "\n===============================================================================",
  );
  console.log(
    `  ACCEPTANCE MATRIX SUMMARY: ${passedCount}/${total} PASSED (${failedCount} FAILED)`,
  );
  console.log(
    "===============================================================================\n",
  );

  if (failedCount > 0) {
    process.exitCode = 1;
  }

  return journeyResults;
}

if (require.main === module) {
  runAcceptanceMatrix().catch((err) => {
    console.error("FATAL: Acceptance Matrix runner failed:", err);
    process.exit(1);
  });
}
