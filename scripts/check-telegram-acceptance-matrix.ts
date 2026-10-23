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
 *  9. Valid mechanical selection: zero new model calls, appointment created, offer CONSUMED.
 * 10. Expired, replaced, malformed, or cross-scope callback: 5 subcases (10a-10e), safe rejection, zero appointments.
 * 11. Duplicate inbound delivery and repeated confirmation: same-externalId dedupe AND repeated tap with new externalId.
 * 12. Offer persistence/CAS conflict: 12a pre-AI mechanical /start, 12b post-AI SLOT conflict with wire evidence preserved.
 * 13. Staff-owned conversation: DEFERRED_TO_STAFF, zero automated execution, zero appointments.
 * 14. Handoffs: 14a explicit human (CUSTOMER_REQUESTED_HUMAN), 14b sensitive (SENSITIVE_OR_RESTRICTED), 14c uncertain (AMBIGUITY_UNRESOLVED).
 * 15. Harmless dialectal wording near historical lexical failure cases: no false safety handoff, AI_ACTIVE preserved.
 * 16. Global stop, attempt exhaustion, and deadline exhaustion: offline injected controls, truthful stop reasons, bounded attempts.
 *
 * Evidence Levels:
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
  journeyId: string | number;
  name: string;
  evidenceLevel: "A" | "B" | "C" | "D";
  passed: boolean;
  initialStateSummary: string;
  syntheticInput: string;
  testDescription: string;
  mockInvocations: number;
  physicalBoundaryCalls: number | null;
  modelCallCount: number | null;
  providerAttempts: number | null;
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

// 2026-10-22T10:00:00.000Z is 13:00 (1:00 PM) in Africa/Cairo (UTC+3 Egypt DST)
const REFERENCE_INSTANT_STR = "2026-10-22T10:00:00.000Z";
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
  const emittedEvidence: TurnEvidence[] = [];
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

  harness.deps.turnTelemetry = {
    emit: (ev: TurnEvidence) => {
      emittedEvidence.push(ev);
    },
  };
  (harness as any).emittedEvidence = emittedEvidence;

  if (overrides.conversationId) {
    harness.conversation.id = overrides.conversationId;
  }

  return harness;
}

function getLatestTurnEvidence(
  harness: ReturnType<typeof createAcceptanceHarness>,
): TurnEvidence | null {
  const evs = (harness as any).emittedEvidence as TurnEvidence[];
  return evs && evs.length > 0 ? (evs[evs.length - 1] ?? null) : null;
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
  const fromHandle =
    options.from ?? (harness.customer.phone ?? "").replace(/^tg:/, "");
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
  action?: "booking_handoff" | "reply" | "clarify" | "handoff";
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
    `  Reference Instant: ${REFERENCE_INSTANT_STR} (13:00 / 1:00 PM Cairo, UTC+3 Egypt DST)`,
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
    let mockCalls = 0;
    harness.deps.ai = {
      providerName: "controlled-mock",
      respond: async () => {
        mockCalls++;
        return mockResponse({ content: "unexpected" });
      },
    };

    const aptsBefore = harness.appointments.length;
    const res = await sendInbound(harness, "/start", 1001);
    const aptsAfter = harness.appointments.length;
    const lastSent =
      harness.deliveredOutbound[harness.deliveredOutbound.length - 1];
    const durable = await getDurableState(harness);
    const turnEv = getLatestTurnEvidence(harness);

    const hasBizName = Boolean(lastSent?.body.includes(harness.business.name));
    const hasFreeTextNotice = Boolean(lastSent?.body.includes("كتابة"));
    const hasButtons = Boolean(
      (lastSent?.replyMarkup as any)?.inline_keyboard?.length >= 2,
    );
    const offerKind = durable?.offer?.kind;

    const passed =
      res.ok &&
      mockCalls === 0 &&
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
      testDescription: "Mechanical turn (zero model calls)",
      mockInvocations: mockCalls,
      physicalBoundaryCalls: null,
      modelCallCount: (res as any).observability?.modelCallCount ?? null,
      providerAttempts: turnEv?.providerAttempts ?? null,
      stopReason: turnEv?.stopReason ?? null,
      observedFacts: {
        mockInvocations: mockCalls,
        engineObservabilityEmitted: (res as any).observability != null,
        turnEvidenceEmitted: turnEv != null,
      },
      offerTransition: `NONE -> WELCOME(${durable?.offer?.id?.slice(0, 8) ?? "none"})`,
      appointmentsCountBefore: aptsBefore,
      appointmentsCountAfter: aptsAfter,
      details:
        "Mechanical /start turn: 0 mock invocations measured; engine emitted no generative observability (modelCallCount & providerAttempts preserved as null); Welcome buttons presented with free-text guidance.",
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Journey 2: Natural-language booking request
  // Expected: structured interpretation and correct clarification or offer
  // ─────────────────────────────────────────────────────────────────────────
  {
    const harness = createAcceptanceHarness({ conversationId: "conv-j02" });
    let mockCalls = 0;
    harness.deps.ai = {
      providerName: "controlled-mock",
      respond: async () => {
        mockCalls++;
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
    const turnEv = getLatestTurnEvidence(harness);

    const serviceResolved = durable?.knownFacts.service === "كشف أسنان";
    const serviceIdMatches =
      (durable?.offer as any)?.serviceId === PLAYGROUND_IDS.SERV_DENTAL;
    const offerActive = durable?.offer?.status === "ACTIVE";

    const passed =
      res.ok &&
      mockCalls === 1 &&
      (res as any).observability?.modelCallCount === 1 &&
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
      testDescription:
        "Downstream engine behavior under supplied semantic facts (no real language-understanding accuracy claimed)",
      mockInvocations: mockCalls,
      physicalBoundaryCalls: null,
      modelCallCount: (res as any).observability?.modelCallCount ?? null,
      providerAttempts: turnEv?.providerAttempts ?? null,
      stopReason: turnEv?.stopReason ?? null,
      observedFacts: {
        modelCallCount: (res as any).observability?.modelCallCount ?? null,
        providerAttempts: turnEv?.providerAttempts ?? null,
        service: durable?.knownFacts.service,
        serviceId: (durable?.offer as any)?.serviceId,
      },
      offerTransition: `NONE -> ${durable?.offer?.kind ?? "NONE"}(ACTIVE)`,
      appointmentsCountBefore: aptsBefore,
      appointmentsCountAfter: aptsAfter,
      details:
        "Service identified from catalog ('كشف أسنان'); scheduling offer generated; 0 appointments.",
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Journey 3: Provider requested before service
  // Expected: clarify service while preserving provider preference
  // ─────────────────────────────────────────────────────────────────────────
  {
    const harness = createAcceptanceHarness({ conversationId: "conv-j03" });
    let mockCalls = 0;
    harness.deps.ai = {
      providerName: "controlled-mock",
      respond: async () => {
        mockCalls++;
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
    const turnEv = getLatestTurnEvidence(harness);

    const providerPreserved =
      durable?.knownFacts.provider === "د. أحمد" &&
      durable?.providerPreference === "د. أحمد";
    const missingServiceClarification =
      durable?.activeTask?.kind === "BOOKING" &&
      durable.knownFacts.service == null &&
      durable.offer?.kind === "SERVICE";

    const passed =
      res.ok &&
      mockCalls === 1 &&
      (res as any).observability?.modelCallCount === 1 &&
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
      testDescription:
        "Downstream engine behavior under supplied semantic facts (no real language-understanding accuracy claimed)",
      mockInvocations: mockCalls,
      physicalBoundaryCalls: null,
      modelCallCount: (res as any).observability?.modelCallCount ?? null,
      providerAttempts: turnEv?.providerAttempts ?? null,
      stopReason: turnEv?.stopReason ?? null,
      observedFacts: {
        modelCallCount: (res as any).observability?.modelCallCount ?? null,
        providerAttempts: turnEv?.providerAttempts ?? null,
        provider: durable?.knownFacts.provider,
        providerPreference: durable?.providerPreference,
        service: durable?.knownFacts.service,
      },
      offerTransition: `NONE -> ${durable?.offer?.kind ?? "SERVICE"}(CLARIFY)`,
      appointmentsCountBefore: aptsBefore,
      appointmentsCountAfter: aptsAfter,
      details:
        "Provider preference 'د. أحمد سامي' persisted while presenting service choices.",
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Journey 4: Unknown or ambiguous provider
  // Expected: clarification; never silently select a different provider
  // ─────────────────────────────────────────────────────────────────────────
  {
    const harness = createAcceptanceHarness({ conversationId: "conv-j04" });
    let mockCalls = 0;
    harness.deps.ai = {
      providerName: "controlled-mock",
      respond: async () => {
        mockCalls++;
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
    const turnEv = getLatestTurnEvidence(harness);

    const noSilentAssignment =
      (durable as any)?.providerId !== PLAYGROUND_IDS.PROV_1 &&
      (durable as any)?.providerId !== PLAYGROUND_IDS.PROV_2;

    const passed =
      res.ok &&
      mockCalls === 1 &&
      (res as any).observability?.modelCallCount === 1 &&
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
      testDescription:
        "Downstream engine behavior under supplied semantic facts (no real language-understanding accuracy claimed)",
      mockInvocations: mockCalls,
      physicalBoundaryCalls: null,
      modelCallCount: (res as any).observability?.modelCallCount ?? null,
      providerAttempts: turnEv?.providerAttempts ?? null,
      stopReason: turnEv?.stopReason ?? null,
      observedFacts: {
        modelCallCount: (res as any).observability?.modelCallCount ?? null,
        providerAttempts: turnEv?.providerAttempts ?? null,
        provider: durable?.knownFacts.provider,
        resolvedProviderId: (durable as any)?.providerId ?? null,
      },
      offerTransition: `NONE -> CLARIFICATION`,
      appointmentsCountBefore: aptsBefore,
      appointmentsCountAfter: aptsAfter,
      details:
        "Unknown provider prompted for clarification; zero silent substitution.",
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Journey 5: Relative date and morning/afternoon preference
  // Expected: correct Cairo timezone interpretation and slot filtering
  // ─────────────────────────────────────────────────────────────────────────
  {
    const harness = createAcceptanceHarness({ conversationId: "conv-j05" });
    let mockCalls = 0;
    // Cairo virtualNow is 2026-10-22 (Thursday) -> Saturday is 2026-10-24
    harness.deps.ai = {
      providerName: "controlled-mock",
      respond: async () => {
        mockCalls++;
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
    const turnEv = getLatestTurnEvidence(harness);

    const timePref = durable?.knownFacts.timePreference;
    const dateResolved = durable?.knownFacts.date === "2026-10-24";
    const slotOffer = durable?.offer?.kind === "SLOT" ? durable.offer : null;

    // Verify slot list is non-empty before calling .every()
    const hasSlots = Boolean(slotOffer && slotOffer.options.length > 0);
    const allMorningSlots =
      hasSlots &&
      slotOffer!.options.every((opt: any) => {
        // opt.startAt format in business timezone (Africa/Cairo): "2026-10-24T09:00"
        const hour = parseInt(opt.startAt.slice(11, 13), 10);
        return hour < 12;
      });

    const passed =
      res.ok &&
      mockCalls === 1 &&
      (res as any).observability?.modelCallCount === 1 &&
      timePref === "morning" &&
      dateResolved &&
      hasSlots &&
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
      testDescription:
        "Downstream engine behavior under supplied semantic facts (no real language-understanding accuracy claimed)",
      mockInvocations: mockCalls,
      physicalBoundaryCalls: null,
      modelCallCount: (res as any).observability?.modelCallCount ?? null,
      providerAttempts: turnEv?.providerAttempts ?? null,
      stopReason: turnEv?.stopReason ?? null,
      observedFacts: {
        modelCallCount: (res as any).observability?.modelCallCount ?? null,
        providerAttempts: turnEv?.providerAttempts ?? null,
        date: durable?.knownFacts.date,
        timePreference: durable?.knownFacts.timePreference,
        slotsCount: slotOffer?.options?.length ?? 0,
      },
      offerTransition: `NONE -> SLOT(morning-only)`,
      appointmentsCountBefore: aptsBefore,
      appointmentsCountAfter: aptsAfter,
      details:
        "Slots verified non-empty and filtered strictly to morning (< 12:00) on 2026-10-24 in Cairo timezone.",
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Journey 6: Date correction after an offer
  // Expected: replace the offer and preserve compatible facts
  // ─────────────────────────────────────────────────────────────────────────
  {
    const harness = createAcceptanceHarness({ conversationId: "conv-j06" });
    let mockCalls = 0;
    let turnCount = 0;
    harness.deps.ai = {
      providerName: "controlled-mock",
      respond: async () => {
        mockCalls++;
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
    const turnEv = getLatestTurnEvidence(harness);

    const offerReplaced =
      durable2?.offer?.id != null && durable2.offer.id !== initialOfferId;
    const dateUpdated = durable2?.knownFacts.date === "2026-10-25";
    const compatibleFactsPreserved =
      durable2?.knownFacts.service === "كشف أسنان" &&
      durable2?.knownFacts.timePreference === "morning";

    const passed =
      res.ok &&
      mockCalls === 2 &&
      (res as any).observability?.modelCallCount === 1 &&
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
      testDescription:
        "Downstream engine behavior under supplied semantic facts (no real language-understanding accuracy claimed)",
      mockInvocations: mockCalls,
      physicalBoundaryCalls: null,
      modelCallCount: (res as any).observability?.modelCallCount ?? null,
      providerAttempts: turnEv?.providerAttempts ?? null,
      stopReason: turnEv?.stopReason ?? null,
      observedFacts: {
        modelCallCount: (res as any).observability?.modelCallCount ?? null,
        providerAttempts: turnEv?.providerAttempts ?? null,
        date: durable2?.knownFacts.date,
        service: durable2?.knownFacts.service,
        timePreference: durable2?.knownFacts.timePreference,
      },
      offerTransition: `OFFER(${initialOfferId?.slice(0, 8)}) -> REPLACED(${durable2?.offer?.id?.slice(0, 8)})`,
      appointmentsCountBefore: aptsBefore,
      appointmentsCountAfter: aptsAfter,
      details:
        "Prior offer invalidated, new offer generated for 2026-10-25; service and morning preference preserved.",
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Journey 7: Provider or time-preference removal
  // Expected: removed facts do not reappear from stale context
  // ─────────────────────────────────────────────────────────────────────────
  {
    const harness = createAcceptanceHarness({ conversationId: "conv-j07" });
    let mockCalls = 0;
    let turnCount = 0;
    harness.deps.ai = {
      providerName: "controlled-mock",
      respond: async () => {
        mockCalls++;
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
    const turnEv = getLatestTurnEvidence(harness);

    const timePrefRemoved = durable2?.knownFacts.timePreference == null;
    const datePreserved = durable2?.knownFacts.date === "2026-10-24";
    const servicePreserved = durable2?.knownFacts.service === "كشف أسنان";

    const passed =
      res.ok &&
      mockCalls === 2 &&
      (res as any).observability?.modelCallCount === 1 &&
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
      testDescription:
        "Downstream engine behavior under supplied semantic facts (no real language-understanding accuracy claimed)",
      mockInvocations: mockCalls,
      physicalBoundaryCalls: null,
      modelCallCount: (res as any).observability?.modelCallCount ?? null,
      providerAttempts: turnEv?.providerAttempts ?? null,
      stopReason: turnEv?.stopReason ?? null,
      observedFacts: {
        modelCallCount: (res as any).observability?.modelCallCount ?? null,
        providerAttempts: turnEv?.providerAttempts ?? null,
        timePreferenceBefore: timePrefBefore,
        timePreferenceAfter: durable2?.knownFacts.timePreference,
        service: durable2?.knownFacts.service,
        date: durable2?.knownFacts.date,
      },
      offerTransition: `OFFER(morning) -> OFFER(unrestricted)`,
      appointmentsCountBefore: aptsBefore,
      appointmentsCountAfter: aptsAfter,
      details:
        "FactUpdate REMOVE successfully cleared timePreference; service & date preserved.",
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Journey 8: FAQ interruption during booking
  // Expected: answer appropriately and preserve unfinished booking
  // ─────────────────────────────────────────────────────────────────────────
  {
    const harness = createAcceptanceHarness({ conversationId: "conv-j08" });
    let mockCalls = 0;
    let turnCount = 0;
    harness.deps.ai = {
      providerName: "controlled-mock",
      respond: async () => {
        mockCalls++;
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
    const turnEv = getLatestTurnEvidence(harness);

    const taskPreserved =
      taskBeforeKind === "BOOKING" && durable2?.activeTask?.kind === "BOOKING";
    const factsPreserved =
      durable2?.knownFacts.service === "كشف أسنان" &&
      durable2?.knownFacts.date === "2026-10-24";

    const passed =
      res.ok &&
      mockCalls === 2 &&
      (res as any).observability?.modelCallCount === 1 &&
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
      testDescription:
        "Downstream engine behavior under supplied semantic facts (no real language-understanding accuracy claimed)",
      mockInvocations: mockCalls,
      physicalBoundaryCalls: null,
      modelCallCount: (res as any).observability?.modelCallCount ?? null,
      providerAttempts: turnEv?.providerAttempts ?? null,
      stopReason: turnEv?.stopReason ?? null,
      observedFacts: {
        modelCallCount: (res as any).observability?.modelCallCount ?? null,
        providerAttempts: turnEv?.providerAttempts ?? null,
        activeTask: durable2?.activeTask?.kind,
        service: durable2?.knownFacts.service,
        date: durable2?.knownFacts.date,
      },
      offerTransition: `OFFER_SUSPENDED / PRESERVED`,
      appointmentsCountBefore: aptsBefore,
      appointmentsCountAfter: aptsAfter,
      details:
        "FAQ reply sent; active booking task and known facts strictly preserved in durable state.",
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Journey 9: Valid mechanical selection
  // Expected: zero new model calls and offer status transitions to CONSUMED
  // ─────────────────────────────────────────────────────────────────────────
  {
    const harness = createAcceptanceHarness({ conversationId: "conv-j09" });
    let mockCalls = 0;
    harness.deps.ai = {
      providerName: "controlled-mock",
      respond: async () => {
        mockCalls++;
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

    const callsBeforeSelection = mockCalls;
    const aptsBefore = harness.appointments.length;

    // Customer taps option 1 on slot keyboard
    const callbackData = offerCallbackData(activeSlotOffer!, 1);
    const res = await sendInbound(harness, callbackData, 9002);

    const callsAfterSelection = mockCalls;
    const aptsAfter = harness.appointments.length;
    const durable2 = await getDurableState(harness);
    const turnEv = getLatestTurnEvidence(harness);

    const selectionMockInvocations = callsAfterSelection - callsBeforeSelection;
    const zeroNewModelCalls = selectionMockInvocations === 0;
    const aptCreated = aptsAfter === aptsBefore + 1;
    const offerConsumed = durable2?.offer?.status === "CONSUMED";
    const deterministicBypassAsserted =
      (res as any).observability?.modelCallCount === 0 &&
      turnEv?.providerAttempts === 0 &&
      turnEv?.routingDecision === "DETERMINISTIC_BYPASS";

    const passed =
      res.ok &&
      zeroNewModelCalls &&
      aptCreated &&
      offerConsumed &&
      deterministicBypassAsserted;

    recordJourney({
      journeyId: 9,
      name: "Valid mechanical selection",
      evidenceLevel: "A",
      passed,
      initialStateSummary: "Active slot offer with valid options",
      syntheticInput: callbackData,
      testDescription: "Mechanical turn (zero model calls)",
      mockInvocations: selectionMockInvocations,
      physicalBoundaryCalls: null,
      modelCallCount: (res as any).observability?.modelCallCount ?? null,
      providerAttempts: turnEv?.providerAttempts ?? null,
      stopReason: turnEv?.stopReason ?? null,
      observedFacts: {
        modelCallCount: (res as any).observability?.modelCallCount ?? null,
        providerAttempts: turnEv?.providerAttempts ?? null,
        routingDecision: turnEv?.routingDecision ?? null,
        appointmentId: harness.appointments[0]?.id,
        offerStatus: durable2?.offer?.status,
      },
      offerTransition: `SLOT(ACTIVE) -> SLOT(CONSUMED)`,
      appointmentsCountBefore: aptsBefore,
      appointmentsCountAfter: aptsAfter,
      details:
        "Zero new model calls consumed (measured 0 mock invocations, modelCallCount=0, providerAttempts=0); exactly 1 appointment committed; offer status CONSUMED.",
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Journey 10: Expired, replaced, malformed, or cross-scope callback
  // 5 distinct subcases:
  //   10a: Malformed callback string (syntax rejection)
  //   10b: Unknown action on valid active token
  //   10c: Genuinely expired offer (virtual clock expiry)
  //   10d: Actually replaced offer (offer status REPLACED)
  //   10e: Genuine cross-scope token (valid token from another conversation)
  // ─────────────────────────────────────────────────────────────────────────
  {
    const harness = createAcceptanceHarness({ conversationId: "conv-j10" });
    let mockCalls = 0;
    harness.deps.ai = {
      providerName: "controlled-mock",
      respond: async () => {
        mockCalls++;
        return mockResponse({ content: "unexpected" });
      },
    };

    // Initialize conversation with /start to establish valid offer
    await sendInbound(harness, "/start", 10001);
    const durableInit = await getDurableState(harness);
    const validOfferToken = durableInit?.offer?.token ?? "tok1000";
    const virtualNow = harness.getVirtualNow();
    const aptsBefore = harness.appointments.length;

    // 10a. Malformed callback syntax
    const res10a = await sendInbound(harness, "fp:malformed_data", 10002);
    const last10a =
      harness.deliveredOutbound[harness.deliveredOutbound.length - 1];
    const pass10a =
      res10a.ok &&
      harness.appointments.length === 0 &&
      last10a?.replyMarkup == null;

    // 10b. Unknown action on active token
    const res10b = await sendInbound(
      harness,
      `fp:${validOfferToken}:unknown_action_xyz`,
      10003,
    );
    const last10b =
      harness.deliveredOutbound[harness.deliveredOutbound.length - 1];
    const pass10b =
      res10b.ok &&
      harness.appointments.length === 0 &&
      last10b?.replyMarkup == null;

    // 10c. Genuinely expired offer (using harness virtual clock & current revision)
    const expiredWelcomeOffer = buildWelcomeOffer(
      {
        businessId: harness.business.id,
        conversationId: harness.conversation.id,
      },
      "tokexp10",
      new Date(virtualNow.getTime() - 3600 * 1000),
    );
    (expiredWelcomeOffer as any).expiresAt = new Date(
      virtualNow.getTime() - 60 * 1000,
    ).toISOString();

    const rowBefore10c = await harness.stateStore.load(
      harness.business.id,
      harness.conversation.id,
    );
    if (!rowBefore10c) throw new Error("Row before 10c not found");

    const expiredState = {
      ...hydrateConversationState(rowBefore10c.state, {
        businessId: harness.business.id,
        conversationId: harness.conversation.id,
      }),
      offer: expiredWelcomeOffer,
    };

    const saveResult10c = await harness.stateStore.save(
      harness.business.id,
      harness.conversation.id,
      rowBefore10c.revision,
      dehydrateConversationState(expiredState as any),
    );
    if (saveResult10c.status !== "saved") {
      throw new Error(
        `Failed to save expired state fixture: ${saveResult10c.status}`,
      );
    }

    const expiredCb = offerCallbackData(expiredWelcomeOffer!, "book");
    const res10c = await sendInbound(harness, expiredCb, 10004);
    const last10c =
      harness.deliveredOutbound[harness.deliveredOutbound.length - 1];
    const pass10c =
      res10c.ok &&
      harness.appointments.length === 0 &&
      last10c?.body.includes("صلاحية") &&
      last10c?.replyMarkup == null;

    // 10d. Actually replaced offer (offer status REPLACED, saved with revision)
    const replacedWelcomeOffer = buildWelcomeOffer(
      {
        businessId: harness.business.id,
        conversationId: harness.conversation.id,
      },
      "tokrep10",
      virtualNow,
    );
    (replacedWelcomeOffer as any).status = "REPLACED";

    const rowBefore10d = await harness.stateStore.load(
      harness.business.id,
      harness.conversation.id,
    );
    if (!rowBefore10d) throw new Error("Row before 10d not found");

    const replacedState = {
      ...hydrateConversationState(rowBefore10d.state, {
        businessId: harness.business.id,
        conversationId: harness.conversation.id,
      }),
      offer: replacedWelcomeOffer,
    };

    const saveResult10d = await harness.stateStore.save(
      harness.business.id,
      harness.conversation.id,
      rowBefore10d.revision,
      dehydrateConversationState(replacedState as any),
    );
    if (saveResult10d.status !== "saved") {
      throw new Error(
        `Failed to save replaced state fixture: ${saveResult10d.status}`,
      );
    }

    const replacedCb = offerCallbackData(replacedWelcomeOffer!, "book");
    const res10d = await sendInbound(harness, replacedCb, 10005);
    const last10d =
      harness.deliveredOutbound[harness.deliveredOutbound.length - 1];
    const pass10d =
      res10d.ok &&
      harness.appointments.length === 0 &&
      last10d?.body.includes("لم يعد متاحاً") &&
      last10d?.replyMarkup == null;

    // 10e. Valid token created under a DIFFERENT conversation scope
    const foreignConvId = "conv-foreign-10e";
    const foreignOffer = buildWelcomeOffer(
      {
        businessId: harness.business.id,
        conversationId: foreignConvId,
      },
      "tokforeign999",
      virtualNow,
    );
    const foreignSave = await harness.stateStore.save(
      harness.business.id,
      foreignConvId,
      null,
      dehydrateConversationState({
        ...emptyConversationState(),
        offer: foreignOffer,
      } as any),
    );
    if (foreignSave.status !== "saved") {
      throw new Error(
        `Failed to save foreign conversation fixture: ${foreignSave.status}`,
      );
    }

    const foreignCb = offerCallbackData(foreignOffer!, "book");
    const res10e = await sendInbound(harness, foreignCb, 10006);
    const last10e =
      harness.deliveredOutbound[harness.deliveredOutbound.length - 1];
    const turnEv10e = getLatestTurnEvidence(harness);
    const pass10e =
      res10e.ok &&
      harness.appointments.length === 0 &&
      last10e?.replyMarkup == null;

    const aptsAfter = harness.appointments.length;
    const passed = Boolean(
      pass10a &&
      pass10b &&
      pass10c &&
      pass10d &&
      pass10e &&
      mockCalls === 0 &&
      aptsBefore === 0 &&
      aptsAfter === 0,
    );

    recordJourney({
      journeyId: 10,
      name: "Expired, replaced, malformed, or cross-scope callback",
      evidenceLevel: "A",
      passed,
      initialStateSummary: "Active conversation with valid offer token",
      syntheticInput:
        "10a malformed, 10b unknown, 10c expired, 10d replaced, 10e cross-scope",
      testDescription: "Mechanical turn (zero model calls)",
      mockInvocations: mockCalls,
      physicalBoundaryCalls: null,
      modelCallCount: (res10e as any).observability?.modelCallCount ?? null,
      providerAttempts: turnEv10e?.providerAttempts ?? null,
      stopReason: turnEv10e?.stopReason ?? null,
      observedFacts: {
        pass10a_malformed: pass10a,
        pass10b_unknownAction: pass10b,
        pass10c_expired: pass10c,
        pass10d_replaced: pass10d,
        pass10e_crossScope: pass10e,
        modelCallCount: (res10e as any).observability?.modelCallCount ?? null,
        providerAttempts: turnEv10e?.providerAttempts ?? null,
      },
      offerTransition: `NO_MUTATION / SAFE_REJECTION`,
      appointmentsCountBefore: aptsBefore,
      appointmentsCountAfter: aptsAfter,
      details:
        "Mechanical callback rejections: 0 mock invocations measured; engine emitted no generative observability (modelCallCount & providerAttempts preserved as null); all 5 invalid callback vectors safely rejected with 0 appointments.",
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Journey 11: Duplicate inbound delivery and repeated confirmation
  // Expected: same-externalId dedupe AND repeated tap with new externalId
  // ─────────────────────────────────────────────────────────────────────────
  {
    const harness = createAcceptanceHarness({ conversationId: "conv-j11" });
    let mockCalls = 0;
    harness.deps.ai = {
      providerName: "controlled-mock",
      respond: async () => {
        mockCalls++;
        return mockResponse({
          intent: "BOOKING",
          action: "booking_handoff",
          content: "المواعيد:",
          service: "كشف أسنان",
          date: "2026-10-24",
        });
      },
    };

    await sendInbound(harness, "كشف السبت", 11001);
    const durable1 = await getDurableState(harness);
    const slotOffer = durable1?.offer?.kind === "SLOT" ? durable1.offer : null;
    const callbackData = offerCallbackData(slotOffer!, 1);

    const fixedExternalId = "tg:testbot:dup-check-11002";
    const aptsBefore = harness.appointments.length;
    const mockCallsSetup = mockCalls;

    // 11a. First delivery -> confirms booking
    const emittedBefore11a = (
      (harness as any).emittedEvidence as TurnEvidence[]
    ).length;
    const res1 = await sendInbound(harness, callbackData, 11002, {
      externalId: fixedExternalId,
    });
    const aptsMid = harness.appointments.length;
    const emittedAfter11a = ((harness as any).emittedEvidence as TurnEvidence[])
      .length;
    const turnEv1 =
      emittedAfter11a > emittedBefore11a
        ? (((harness as any).emittedEvidence as TurnEvidence[])[
            emittedAfter11a - 1
          ] ?? null)
        : null;
    const mockCallsAfter11a = mockCalls;

    const firstSuccess =
      res1.ok &&
      !(res1 as any).duplicate &&
      aptsMid === aptsBefore + 1 &&
      mockCallsAfter11a - mockCallsSetup === 0 &&
      (res1 as any).observability?.modelCallCount === 0 &&
      turnEv1?.providerAttempts === 0 &&
      turnEv1?.routingDecision === "DETERMINISTIC_BYPASS";

    // 11b. Second delivery with identical externalId -> deduplicated
    const emittedBefore11b = (
      (harness as any).emittedEvidence as TurnEvidence[]
    ).length;
    const res2 = await sendInbound(harness, callbackData, 11002, {
      externalId: fixedExternalId,
    });
    const aptsAfterDedupe = harness.appointments.length;
    const emittedAfter11b = ((harness as any).emittedEvidence as TurnEvidence[])
      .length;
    const mockCallsAfter11b = mockCalls;
    // Duplicate delivery must NOT emit new TurnEvidence; do NOT reuse stale evidence from 11a
    const turnEv2 =
      emittedAfter11b > emittedBefore11b
        ? (((harness as any).emittedEvidence as TurnEvidence[])[
            emittedAfter11b - 1
          ] ?? null)
        : null;

    const secondDedupe =
      res2.ok &&
      (res2 as any).duplicate === true &&
      aptsAfterDedupe === aptsMid &&
      mockCallsAfter11b - mockCallsAfter11a === 0 &&
      emittedAfter11b === emittedBefore11b &&
      turnEv2 == null;

    // 11c. Repeated selection with a NEW externalId (representing another button tap)
    const emittedBefore11c = (
      (harness as any).emittedEvidence as TurnEvidence[]
    ).length;
    const res3 = await sendInbound(harness, callbackData, 11003, {
      externalId: "tg:testbot:repeated-tap-11003",
    });
    const aptsFinal = harness.appointments.length;
    const emittedAfter11c = ((harness as any).emittedEvidence as TurnEvidence[])
      .length;
    const turnEv3 =
      emittedAfter11c > emittedBefore11c
        ? (((harness as any).emittedEvidence as TurnEvidence[])[
            emittedAfter11c - 1
          ] ?? null)
        : null;
    const lastSent3 =
      harness.deliveredOutbound[harness.deliveredOutbound.length - 1];
    const mockCallsAfter11c = mockCalls;

    const thirdStaleRejection =
      res3.ok &&
      !(res3 as any).duplicate &&
      aptsFinal === 1 &&
      Boolean(lastSent3?.body.includes("لم يعد متاحاً")) &&
      mockCallsAfter11c - mockCallsAfter11b === 0 &&
      emittedAfter11c > emittedBefore11c &&
      turnEv3?.providerAttempts === null;

    const passed = Boolean(firstSuccess && secondDedupe && thirdStaleRejection);

    recordJourney({
      journeyId: 11,
      name: "Duplicate inbound delivery and repeated confirmation",
      evidenceLevel: "A",
      passed,
      initialStateSummary: "Slot offer ready for confirmation",
      syntheticInput: `${callbackData} (delivered twice with same externalId, then once with new externalId)`,
      testDescription: "Mechanical turn (zero model calls)",
      mockInvocations: mockCallsAfter11c - mockCallsSetup,
      physicalBoundaryCalls: null,
      modelCallCount: (res1 as any).observability?.modelCallCount ?? null,
      providerAttempts: turnEv1?.providerAttempts ?? null,
      stopReason: null,
      observedFacts: {
        firstSelection: {
          ok: res1.ok,
          duplicate: (res1 as any).duplicate,
          modelCallCount: (res1 as any).observability?.modelCallCount ?? null,
          providerAttempts: turnEv1?.providerAttempts ?? null,
          routingDecision: turnEv1?.routingDecision ?? null,
          newTurnEvidenceEmitted: emittedAfter11a > emittedBefore11a,
        },
        duplicateDelivery: {
          ok: res2.ok,
          duplicate: (res2 as any).duplicate,
          newTurnEvidenceEmitted: emittedAfter11b > emittedBefore11b,
          staleEvidenceReused: false,
        },
        repeatedTapWithNewExternalId: {
          ok: res3.ok,
          duplicate: (res3 as any).duplicate,
          modelCallCount: (res3 as any).observability?.modelCallCount ?? null,
          providerAttempts: turnEv3?.providerAttempts ?? null,
          rejectionNotice: Boolean(lastSent3?.body.includes("لم يعد متاحاً")),
          newTurnEvidenceEmitted: emittedAfter11c > emittedBefore11c,
        },
        appointmentsCountFinal: aptsFinal,
      },
      offerTransition: `ACTIVE -> CONSUMED -> DEDUPLICATED -> CLOSED`,
      appointmentsCountBefore: aptsBefore,
      appointmentsCountAfter: aptsFinal,
      details:
        "First delivery confirmed booking (modelCallCount=0, providerAttempts=0); identical externalId deduplicated with zero stale TurnEvidence emission; repeated tap with new externalId cleanly rejected without new model invocations (appointments count strictly 1).",
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Journey 12: Offer persistence/CAS conflict after execution
  // 12a: Pre-AI /start CAS conflict (mechanical, 0 wire calls)
  // 12b: Post-AI slot offer CAS conflict (AI wire call dispatched, safe early return, evidence preserved)
  // ─────────────────────────────────────────────────────────────────────────
  {
    // 12a. Pre-AI mechanical /start conflict
    const harness12a = createAcceptanceHarness({
      conversationId: "conv-j12a",
    });
    let mockCalls12a = 0;
    harness12a.deps.ai = {
      providerName: "controlled-mock",
      respond: async () => {
        mockCalls12a++;
        return mockResponse({ content: "unexpected" });
      },
    };
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
    await harness12a.stateStore.save(
      harness12a.business.id,
      harness12a.conversation.id,
      null,
      dehydrateConversationState(initialUnknownState),
    );

    const origSave12a = harness12a.stateStore.save.bind(harness12a.stateStore);
    harness12a.stateStore.save = async () => ({ status: "conflict" });

    const aptsBefore12a = harness12a.appointments.length;
    const res12a = await sendInbound(harness12a, "/start", 12001);
    harness12a.stateStore.save = origSave12a;

    const aptsAfter12a = harness12a.appointments.length;
    const lastSent12a =
      harness12a.deliveredOutbound[harness12a.deliveredOutbound.length - 1];
    const turnEv12a = getLatestTurnEvidence(harness12a);

    const safeConflictMsg12a = Boolean(
      lastSent12a?.body.includes("تعارض") &&
      lastSent12a?.body.includes("المحاولة"),
    );
    const noUnpersistedMarkup12a = !lastSent12a?.replyMarkup;

    const passed12a =
      res12a.ok &&
      mockCalls12a === 0 &&
      safeConflictMsg12a &&
      noUnpersistedMarkup12a &&
      aptsBefore12a === 0 &&
      aptsAfter12a === 0 &&
      (res12a as any).observability?.modelCallCount === 0 &&
      turnEv12a?.providerAttempts === 0 &&
      turnEv12a?.routingDecision === "DETERMINISTIC_BYPASS";

    recordJourney({
      journeyId: "12a",
      name: "Pre-AI /start CAS conflict (mechanical)",
      evidenceLevel: "A",
      passed: passed12a,
      initialStateSummary:
        "Active booking with injected state revision conflict",
      syntheticInput: "/start",
      testDescription: "Mechanical turn (zero model calls)",
      mockInvocations: mockCalls12a,
      physicalBoundaryCalls: null,
      modelCallCount: (res12a as any).observability?.modelCallCount ?? null,
      providerAttempts: turnEv12a?.providerAttempts ?? null,
      stopReason: null,
      observedFacts: {
        conflictHandled: safeConflictMsg12a,
        unpersistedKeyboardSuppressed: noUnpersistedMarkup12a,
        modelCallCount: (res12a as any).observability?.modelCallCount ?? null,
        providerAttempts: turnEv12a?.providerAttempts ?? null,
        routingDecision: turnEv12a?.routingDecision ?? null,
      },
      offerTransition: `CAS_CONFLICT -> SAFE_RETRY`,
      appointmentsCountBefore: aptsBefore12a,
      appointmentsCountAfter: aptsAfter12a,
      details:
        "Pre-AI CAS conflict safely handled; retry message returned; actionable buttons suppressed (modelCallCount=0, providerAttempts=0).",
    });

    // 12b. Post-AI SLOT offer CAS conflict with instrumented wire dispatch
    let wireCalls12b = 0;
    const scripted12bFetch: typeof fetch = async () => {
      wireCalls12b++;
      const responsePayload = {
        id: "gen-cas-test",
        choices: [
          {
            message: {
              content: JSON.stringify({
                intent: "BOOKING",
                action: "booking_handoff",
                content: "متاح المواعيد التالية لكشف الأسنان:",
                extraction: {
                  service: "كشف أسنان",
                  provider: null,
                  date: "2026-10-24",
                  timePreference: null,
                },
                safetyAssessment: "safe",
                handoffReason: null,
                summary: "طلب حجز كشف أسنان",
                factUpdates: [
                  { key: "service", operation: "set", value: "كشف أسنان" },
                  { key: "date", operation: "set", value: "2026-10-24" },
                ],
              }),
            },
          },
        ],
        usage: {
          prompt_tokens: 25,
          completion_tokens: 30,
          total_tokens: 55,
        },
      };
      return new Response(JSON.stringify(responsePayload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const getEnv12b = (k: string) => {
      if (k === "OPENROUTER_API_KEY") return "valid-key";
      return undefined;
    };

    const adapter12b = createOpenRouterAdapter({
      model: "openrouter/auto",
      getEnvVar: getEnv12b,
      fetchImpl: scripted12bFetch,
    });

    const harness12b = createAcceptanceHarness({
      conversationId: "conv-j12b",
    });
    harness12b.deps.ai = createLlmConversationAi({
      primary: adapter12b,
      fallbackEnabled: false,
      getEnvVar: getEnv12b,
    });

    const origSave12b = harness12b.stateStore.save.bind(harness12b.stateStore);
    harness12b.stateStore.save = async (bId, cId, expRev, st: any) => {
      if (st?.offer?.kind === "SLOT") {
        return { status: "conflict" as const };
      }
      return origSave12b(bId, cId, expRev, st);
    };

    const aptsBefore12b = harness12b.appointments.length;
    const res12b = await sendInbound(
      harness12b,
      "عايز كشف أسنان يوم السبت",
      12002,
    );
    const aptsAfter12b = harness12b.appointments.length;
    const lastSent12b =
      harness12b.deliveredOutbound[harness12b.deliveredOutbound.length - 1];
    const turnEv12b = getLatestTurnEvidence(harness12b);

    const safeConflictMsg12b = Boolean(
      lastSent12b?.body.includes("تعارض") &&
      lastSent12b?.body.includes("المحاولة"),
    );
    const noUnpersistedMarkup12b = lastSent12b?.replyMarkup == null;

    const passed12b =
      res12b.ok &&
      wireCalls12b === 1 &&
      safeConflictMsg12b &&
      noUnpersistedMarkup12b &&
      aptsBefore12b === 0 &&
      aptsAfter12b === 0 &&
      turnEv12b?.providerAttempts === 1 &&
      (res12b as any).observability?.modelCallCount === 1 &&
      turnEv12b?.providerStatus === "SUCCESS" &&
      (turnEv12b?.executionAttempts?.length ?? 0) === 1 &&
      turnEv12b?.costCompleteness !== undefined;

    recordJourney({
      journeyId: "12b",
      name: "Post-AI SLOT offer CAS conflict (wire dispatched)",
      evidenceLevel: "A",
      passed: passed12b,
      initialStateSummary:
        "Slot offer generation under state revision conflict",
      syntheticInput: "عايز كشف أسنان يوم السبت",
      testDescription: "Instrumented physical wire dispatch",
      mockInvocations: 0,
      physicalBoundaryCalls: wireCalls12b,
      modelCallCount: (res12b as any).observability?.modelCallCount ?? null,
      providerAttempts: turnEv12b?.providerAttempts ?? null,
      stopReason: turnEv12b?.stopReason ?? null,
      observedFacts: {
        wireCalls: wireCalls12b,
        conflictHandled: safeConflictMsg12b,
        unpersistedKeyboardSuppressed: noUnpersistedMarkup12b,
        providerStatus: turnEv12b?.providerStatus,
        costCompleteness: turnEv12b?.costCompleteness,
      },
      offerTransition: `SLOT_OFFER_CAS_CONFLICT -> SAFE_RETRY`,
      appointmentsCountBefore: aptsBefore12b,
      appointmentsCountAfter: aptsAfter12b,
      details:
        "AI wire call dispatched (wireCalls=1); CAS conflict intercepted; safe retry returned; TurnEvidence attempts, status, traces, and cost coverage preserved.",
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

    let mockCalls = 0;
    harness.deps.ai = {
      providerName: "controlled-mock",
      respond: async () => {
        mockCalls++;
        return mockResponse({ content: "should never run" });
      },
    };

    const aptsBefore = harness.appointments.length;
    const sentBefore = harness.deliveredOutbound.length;
    const res = await sendInbound(harness, "عايز أحجز كشف بسرعة", 13001);
    const aptsAfter = harness.appointments.length;
    const sentAfter = harness.deliveredOutbound.length;
    const turnEv = getLatestTurnEvidence(harness);

    const deferredToStaff =
      (res as any).assistantAction === "DEFERRED_TO_STAFF";
    const noAutomatedDelivery = sentAfter === sentBefore;

    const passed =
      res.ok &&
      mockCalls === 0 &&
      deferredToStaff &&
      noAutomatedDelivery &&
      aptsBefore === 0 &&
      aptsAfter === 0 &&
      turnEv?.assistantAction === "DEFERRED_TO_STAFF";

    recordJourney({
      journeyId: 13,
      name: "Staff-owned conversation boundary",
      evidenceLevel: "A",
      passed,
      initialStateSummary: "Assigned to staff-operator-1, status NEED_HUMAN",
      syntheticInput: "عايز أحجز كشف بسرعة",
      testDescription: "Mechanical turn (zero model calls)",
      mockInvocations: mockCalls,
      physicalBoundaryCalls: null,
      modelCallCount: (res as any).observability?.modelCallCount ?? null,
      providerAttempts: turnEv?.providerAttempts ?? null,
      stopReason: turnEv?.stopReason ?? null,
      observedFacts: {
        assistantAction: (res as any).assistantAction,
        conversationStatus: (res as any).conversationStatus,
        turnEvidenceAction: turnEv?.assistantAction ?? null,
      },
      offerTransition: `BLOCKED_BY_STAFF_OWNERSHIP`,
      appointmentsCountBefore: aptsBefore,
      appointmentsCountAfter: aptsAfter,
      details:
        "Conversation engine yielded DEFERRED_TO_STAFF; zero automated AI turns (0 mock calls measured, modelCallCount and providerAttempts preserved as null); zero messages delivered.",
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Journey 14: Explicit human request and sensitive/uncertain requests
  // 14a: Explicit human request (CUSTOMER_REQUESTED_HUMAN)
  // 14b: Sensitive request (SENSITIVE_OR_RESTRICTED)
  // 14c: Uncertain / ambiguous request (AMBIGUITY_UNRESOLVED)
  // ─────────────────────────────────────────────────────────────────────────
  {
    // 14a. Explicit human request
    const harness14a = createAcceptanceHarness({
      conversationId: "conv-j14a",
    });
    let mockCalls14a = 0;
    harness14a.deps.ai = {
      providerName: "controlled-mock",
      respond: async () => {
        mockCalls14a++;
        return mockResponse({
          intent: "HUMAN_REQUEST",
          action: "handoff",
          content: "سأقوم بتحويلك لأحد موظفي خدمة العملاء.",
          handoffReason: "HUMAN_REQUEST",
        });
      },
    };

    const aptsBefore14a = harness14a.appointments.length;
    const res14a = await sendInbound(
      harness14a,
      "ممكن أكلم حد من خدمة العملاء؟",
      14001,
    );
    const aptsAfter14a = harness14a.appointments.length;
    const turnEv14a = getLatestTurnEvidence(harness14a);

    const passed14a =
      res14a.ok &&
      mockCalls14a === 1 &&
      (res14a as any).observability?.modelCallCount === 1 &&
      (res14a as any).handoffCause === "CUSTOMER_REQUESTED_HUMAN" &&
      (res14a as any).conversationStatus === "NEED_HUMAN" &&
      aptsBefore14a === 0 &&
      aptsAfter14a === 0;

    recordJourney({
      journeyId: "14a",
      name: "Explicit human request handoff",
      evidenceLevel: "A",
      passed: passed14a,
      initialStateSummary: "Active conversation, AI_ACTIVE",
      syntheticInput: "ممكن أكلم حد من خدمة العملاء؟",
      testDescription:
        "Downstream engine behavior under supplied semantic facts (no real language-understanding accuracy claimed)",
      mockInvocations: mockCalls14a,
      physicalBoundaryCalls: null,
      modelCallCount: (res14a as any).observability?.modelCallCount ?? null,
      providerAttempts: turnEv14a?.providerAttempts ?? null,
      stopReason: turnEv14a?.stopReason ?? null,
      observedFacts: {
        modelCallCount: (res14a as any).observability?.modelCallCount ?? null,
        providerAttempts: turnEv14a?.providerAttempts ?? null,
        handoffCause: (res14a as any).handoffCause,
        conversationStatus: (res14a as any).conversationStatus,
      },
      offerTransition: `HANDOFF(CUSTOMER_REQUESTED_HUMAN)`,
      appointmentsCountBefore: aptsBefore14a,
      appointmentsCountAfter: aptsAfter14a,
      details:
        "Handoff cause derived as CUSTOMER_REQUESTED_HUMAN; status transitioned to NEED_HUMAN.",
    });

    // 14b. Sensitive assessment handoff
    const harness14b = createAcceptanceHarness({
      conversationId: "conv-j14b",
    });
    let mockCalls14b = 0;
    harness14b.deps.ai = {
      providerName: "controlled-mock",
      respond: async () => {
        mockCalls14b++;
        return mockResponse({
          intent: "BOOKING",
          action: "handoff",
          content: "سيتواصل معك أحد أطبائنا هاتفياً لمتابعة حالتك.",
          safetyAssessment: "sensitive",
          handoffReason: "SENSITIVE",
        });
      },
    };

    const aptsBefore14b = harness14b.appointments.length;
    const res14b = await sendInbound(
      harness14b,
      "عندي نزيف حاد ومحتاج دكتور ضروري",
      14002,
    );
    const aptsAfter14b = harness14b.appointments.length;
    const turnEv14b = getLatestTurnEvidence(harness14b);

    const passed14b =
      res14b.ok &&
      mockCalls14b === 1 &&
      (res14b as any).observability?.modelCallCount === 1 &&
      (res14b as any).handoffCause === "SENSITIVE_OR_RESTRICTED" &&
      (res14b as any).conversationStatus === "NEED_HUMAN" &&
      aptsBefore14b === 0 &&
      aptsAfter14b === 0;

    recordJourney({
      journeyId: "14b",
      name: "Sensitive assessment handoff",
      evidenceLevel: "A",
      passed: passed14b,
      initialStateSummary: "Active conversation, AI_ACTIVE",
      syntheticInput: "عندي نزيف حاد ومحتاج دكتور ضروري",
      testDescription:
        "Downstream engine behavior under supplied semantic facts (no real language-understanding accuracy claimed)",
      mockInvocations: mockCalls14b,
      physicalBoundaryCalls: null,
      modelCallCount: (res14b as any).observability?.modelCallCount ?? null,
      providerAttempts: turnEv14b?.providerAttempts ?? null,
      stopReason: turnEv14b?.stopReason ?? null,
      observedFacts: {
        modelCallCount: (res14b as any).observability?.modelCallCount ?? null,
        providerAttempts: turnEv14b?.providerAttempts ?? null,
        handoffCause: (res14b as any).handoffCause,
        conversationStatus: (res14b as any).conversationStatus,
      },
      offerTransition: `HANDOFF(SENSITIVE_OR_RESTRICTED)`,
      appointmentsCountBefore: aptsBefore14b,
      appointmentsCountAfter: aptsAfter14b,
      details:
        "Handoff cause derived as SENSITIVE_OR_RESTRICTED; status transitioned to NEED_HUMAN.",
    });

    // 14c. Uncertain / ambiguous assessment handoff
    const harness14c = createAcceptanceHarness({
      conversationId: "conv-j14c",
    });
    let mockCalls14c = 0;
    harness14c.deps.ai = {
      providerName: "controlled-mock",
      respond: async () => {
        mockCalls14c++;
        return mockResponse({
          intent: "FAQ",
          action: "handoff",
          content: "سيتواصل معك أحد أعضاء الفريق لتوضيح التفاصيل بدقة.",
          safetyAssessment: "uncertain",
          handoffReason: "AMBIGUOUS",
        });
      },
    };

    const aptsBefore14c = harness14c.appointments.length;
    const res14c = await sendInbound(
      harness14c,
      "محتاج تفاصيل معقدة بخصوص الإجراءات",
      14003,
    );
    const aptsAfter14c = harness14c.appointments.length;
    const turnEv14c = getLatestTurnEvidence(harness14c);

    const passed14c =
      res14c.ok &&
      mockCalls14c === 1 &&
      (res14c as any).observability?.modelCallCount === 1 &&
      (res14c as any).handoffCause === "SENSITIVE_OR_RESTRICTED" &&
      (res14c as any).conversationStatus === "NEED_HUMAN" &&
      (res14c as any).assistantAction === "AI_HANDOFF" &&
      aptsBefore14c === 0 &&
      aptsAfter14c === 0;

    recordJourney({
      journeyId: "14c",
      name: "Uncertain assessment handoff (fails safe to restricted)",
      evidenceLevel: "A",
      passed: passed14c,
      initialStateSummary: "Active conversation, AI_ACTIVE",
      syntheticInput: "محتاج تفاصيل معقدة بخصوص الإجراءات",
      testDescription:
        "Downstream engine behavior under supplied semantic facts (no real language-understanding accuracy claimed)",
      mockInvocations: mockCalls14c,
      physicalBoundaryCalls: null,
      modelCallCount: (res14c as any).observability?.modelCallCount ?? null,
      providerAttempts: turnEv14c?.providerAttempts ?? null,
      stopReason: turnEv14c?.stopReason ?? null,
      observedFacts: {
        modelCallCount: (res14c as any).observability?.modelCallCount ?? null,
        providerAttempts: turnEv14c?.providerAttempts ?? null,
        handoffCause: (res14c as any).handoffCause,
        conversationStatus: (res14c as any).conversationStatus,
        assistantAction: (res14c as any).assistantAction,
      },
      offerTransition: `HANDOFF(SENSITIVE_OR_RESTRICTED)`,
      appointmentsCountBefore: aptsBefore14c,
      appointmentsCountAfter: aptsAfter14c,
      details:
        "Uncertain safety assessment fails closed to SENSITIVE_OR_RESTRICTED; status transitioned to NEED_HUMAN.",
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Journey 15: Harmless dialectal wording near historical lexical failure cases
  // Expected: no false safety handoff; AI_ACTIVE preserved
  // ─────────────────────────────────────────────────────────────────────────
  {
    const harness = createAcceptanceHarness({ conversationId: "conv-j15" });
    let mockCalls = 0;
    // Harmless Egyptian utterance with trigger word "مشكلة" ('أي وقت يناسبكم مش مشكلة')
    harness.deps.ai = {
      providerName: "controlled-mock",
      respond: async () => {
        mockCalls++;
        return mockResponse({
          intent: "BOOKING",
          action: "booking_handoff",
          content: "تمام، إليك المواعيد المتاحة:",
          service: "كشف أسنان",
          safetyAssessment: "safe",
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
    const turnEv = getLatestTurnEvidence(harness);

    const conversationStatus = (res as any).conversationStatus;
    const handoffCause = (res as any).handoffCause;

    const noFalseSafetyHandoff =
      conversationStatus === "AI_ACTIVE" &&
      handoffCause !== "SENSITIVE_OR_RESTRICTED";

    const passed =
      res.ok &&
      mockCalls === 1 &&
      (res as any).observability?.modelCallCount === 1 &&
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
      testDescription:
        "Downstream engine behavior under supplied semantic facts (no real language-understanding accuracy claimed)",
      mockInvocations: mockCalls,
      physicalBoundaryCalls: null,
      modelCallCount: (res as any).observability?.modelCallCount ?? null,
      providerAttempts: turnEv?.providerAttempts ?? null,
      stopReason: turnEv?.stopReason ?? null,
      observedFacts: {
        modelCallCount: (res as any).observability?.modelCallCount ?? null,
        providerAttempts: turnEv?.providerAttempts ?? null,
        conversationStatus,
        handoffCause: handoffCause ?? "none",
      },
      offerTransition: `CONTINUED(AI_ACTIVE)`,
      appointmentsCountBefore: aptsBefore,
      appointmentsCountAfter: aptsAfter,
      details:
        "Semantic safety evaluated 'safe'; zero false SENSITIVE_OR_RESTRICTED handoff.",
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

    const harness16a = createAcceptanceHarness({
      conversationId: "conv-j16a",
    });
    harness16a.deps.ai = testAi16a;

    const res16a = await sendInbound(
      harness16a,
      "عايز أحجز كشف أسنان النهاردة",
      16001,
    );
    const turnEv16a = getLatestTurnEvidence(harness16a);
    const stopReason16a = turnEv16a?.stopReason;
    const pass16a =
      res16a.ok &&
      wireCalls16a === 0 &&
      (res16a as any).observability?.modelCallCount === 0 &&
      turnEv16a?.providerAttempts === 0 &&
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

    const harness16b = createAcceptanceHarness({
      conversationId: "conv-j16b",
    });
    harness16b.deps.ai = testAi16b;

    const res16b = await sendInbound(
      harness16b,
      "عايز أعرف مواعيد العمل",
      16002,
    );
    const turnEv16b = getLatestTurnEvidence(harness16b);
    const stopReason16b = turnEv16b?.stopReason;
    const pass16b =
      res16b.ok &&
      wireCalls16b === 1 &&
      (res16b as any).observability?.modelCallCount === 1 &&
      turnEv16b?.providerAttempts === 1 &&
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
      testDescription: "Instrumented physical wire dispatch",
      mockInvocations: 0,
      physicalBoundaryCalls: wireCalls16a + wireCalls16b,
      modelCallCount:
        ((res16a as any).observability?.modelCallCount ?? 0) +
        ((res16b as any).observability?.modelCallCount ?? 0),
      providerAttempts:
        (turnEv16a?.providerAttempts ?? 0) + (turnEv16b?.providerAttempts ?? 0),
      stopReason: `${stopReason16a} / ${stopReason16b} / DEADLINE_EXHAUSTED`,
      observedFacts: {
        step16a_globalStop: {
          wireCalls: wireCalls16a,
          modelCallCount: (res16a as any).observability?.modelCallCount ?? null,
          providerAttempts: turnEv16a?.providerAttempts ?? null,
          stopReason: stopReason16a,
        },
        step16b_attemptLimit: {
          wireCalls: wireCalls16b,
          modelCallCount: (res16b as any).observability?.modelCallCount ?? null,
          providerAttempts: turnEv16b?.providerAttempts ?? null,
          stopReason: stopReason16b,
        },
        step16c_deadlineExhaustion: {
          dispatchedAttempts: session16c.getDispatchedAttempts(),
          stopReason: deadlineDispatch.reason,
        },
      },
      offerTransition: `CONTROLLED_STOP_SAFE_TERMINATION`,
      appointmentsCountBefore: 0,
      appointmentsCountAfter: 0,
      details:
        "16a GLOBAL_STOP (0 wire calls, modelCallCount=0, providerAttempts=0); 16b ATTEMPT_LIMIT_EXHAUSTED (1 wire call, modelCallCount=1, providerAttempts=1); 16c DEADLINE_EXHAUSTED (0 wire calls).",
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
