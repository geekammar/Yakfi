/**
 * FlowPilot AI Evaluation — egyptian-v1 EXTENDED-TRUTH scenarios
 * (PROMPT-AI-EVAL-02).
 *
 * This bank walks the BookingJourneyState machine explicitly. Every scenario
 * asserts `expectedStateTransition` (`from → to`, `factKey`, `isRevision`) and
 * a `customerBehavior` profile, so the causal progression of a booking —
 * including revisions, interruptions, recovery, and abandonment — is encoded
 * in the DATA instead of being implied by prose.
 *
 *            goal → missing service → service supplied → missing date
 *                → date supplied → missing time → time supplied
 *                → availability → slot selection → confirmation → completed
 *            plus: interrupted / recovering / aborted
 *
 * Revision rule (binding): a turn that revises a fact already on the table is
 * its OWN scenario with `isRevision: true` and a `changes_*` behavior — the
 * expected truth moves WITH the revised fact. No mutation ever relabels it.
 */

import type { Scenario } from "../../schema/scenario-schema";
import {
  current,
  egy,
  entities,
  handoffEither,
  handoffNotRequired,
  multiTurn,
  semantic,
  u,
} from "./scenario-builders";
import { CLINIC_CONTEXT } from "./shared-context";

const AI_GREETING = {
  senderType: "AI" as const,
  text: "أهلاً بك!  أنا مساعدك للحجز والمواعيد — كيف يمكنني مساعدتك اليوم؟",
};
const AI_ASK_SERVICE = {
  senderType: "AI" as const,
  text: "تمام — أنهي خدمة تحتاجها؟",
};
const AI_ASK_DATE = {
  senderType: "AI" as const,
  text: "حاضر — أنهي يوم يناسبك؟",
};
const AI_ASK_TIME = {
  senderType: "AI" as const,
  text: "طيب — تفضل صباحاً ولا مساءً؟",
};
const AI_OFFER = {
  senderType: "AI" as const,
  text: 'تتوفر المواعيد التالية لخدمة "تنظيف الأسنان" يوم 2026-10-01:\n1. د. منى — 10:00 إلى 10:30\n2. د. منى — 12:00 إلى 12:30\nيرجى اختيار أحد الخيارات.',
};
const AI_CONFIRM_ASK = {
  senderType: "AI" as const,
  text: "تمام — تأكد الحجز: تنظيف الأسنان يوم 2026-10-01 الساعة 10:00 مع د. منى. أؤكد؟",
};
const AI_DONE = {
  senderType: "AI" as const,
  text: "تم تأكيد حجزك ✓ ستجد التفاصيل في رسالة منفصلة. تحتاج أي شيء آخر؟",
};

export const extendedTruthScenarios: Scenario[] = [
  // ── GOAL_STATED: the journey opens ───────────────────────────────────────────
  multiTurn({
    id: "jt-goal-stated",
    contextTurns: [
      { senderType: "CUSTOMER", text: "السلام عليكم" },
      AI_GREETING,
    ],
    utterances: [
      ...egy("عايز أحجز موعد", "عايز أحجز", "ممكن أحجز؟", "عايز ميعاد"),
      u("3ayez a7gez", "ARABIZI"),
    ],
    semanticLabel: semantic("BOOKING", "open the booking journey"),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      fullyHandledByCurrent: false,
    }),
    conversationState: {
      knownEntities: entities({}),
      requiresMemory: false,
      expectedStatus: "AI_ACTIVE",
    },
    handoff: handoffEither("The current architecture routes booking to staff."),
    knowledgeRequirement: "NONE",
    edgeCategories: ["BOOKING_JOURNEY", "NORMAL"],
    difficulty: "EASY",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: { dispositions: ["CLEAR"], changeOfState: "NONE" },
    expectedDomainAction: "REQUEST_MISSING_SERVICE",
    expectedStateTransition: {
      from: "NOT_APPLICABLE",
      to: "GOAL_STATED",
      bookingJourneyState: "GOAL_STATED",
      isRevision: false,
    },
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION", "REPEAT_LETTERS"],
    maxCases: 12,
    rationale:
      "The journey's entry checkpoint: a bare booking goal with no service, no date, no time. The ideal next move is to ask for the service.",
  }),

  // ── MISSING_SERVICE: goal held, service still absent ─────────────────────────
  multiTurn({
    id: "jt-missing-service",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز موعد" },
      AI_ASK_SERVICE,
    ],
    utterances: [
      ...egy("الخميس لو سمحت", "بعد بكرة", "أي يوم الأسبوع الجاي"),
      u("el 3'o5a?", "ARABIZI"),
    ],
    semanticLabel: semantic(
      "BOOKING",
      "the date arrives but the service is still missing — ask for it",
    ),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "AMBIGUOUS", {
      architecturalLimitation: true,
    }),
    conversationState: {
      knownEntities: entities({}),
      requiresMemory: true,
      expectedStatus: "AI_ACTIVE",
    },
    handoff: handoffEither(
      "Booking continues; the current arch can only hand off.",
    ),
    knowledgeRequirement: "NONE",
    edgeCategories: [
      "BOOKING_JOURNEY",
      "MISSING_INFORMATION",
      "AMBIGUOUS_STATE_RESOLVES",
    ],
    difficulty: "HARD",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["CLEAR", "HURRIED"],
      changeOfState: "NONE",
    },
    expectedDomainAction: "REQUEST_MISSING_SERVICE",
    expectedClarification: {
      type: "CLARIFY_SERVICE",
      question: "أنهي خدمة تحتاجها — تنظيف ولا حشو ولا تقويم؟",
      targets: ["service"],
    },
    expectedStateTransition: {
      from: "GOAL_STATED",
      to: "MISSING_SERVICE",
      bookingJourneyState: "MISSING_SERVICE",
      isRevision: false,
    },
    futureArchitectureExpectation: {
      expectSelfService: true,
      expectClarification: true,
      expectKnowledgeLookup: false,
      expectConfirmation: false,
      expectKnowledgeGapRecorded: false,
    },
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    maxCases: 12,
    rationale:
      "The customer answers the date question with a date while the service slot is still empty — context resolves the goal, but the ideal assistant asks for the service rather than guessing.",
  }),

  // ── SERVICE_SUPPLIED: the service slot is filled ────────────────────────────
  multiTurn({
    id: "jt-service-supplied",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز موعد" },
      AI_ASK_SERVICE,
    ],
    utterances: [
      ...egy(
        "تنظيف الأسنان",
        "عايز تنظيف",
        "تنضيف أسنان لو سمحت",
        "حشو الضرس",
        "تقويم",
      ),
      u("tanzeef", "ARABIZI"),
      u("cleaning لو سمحت", "ARABIC_ENGLISH", ["MIXED_LANGUAGE"]),
    ],
    semanticLabel: semantic("BOOKING", "capture the service, ask for the date"),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "AMBIGUOUS", {
      architecturalLimitation: true,
    }),
    conversationState: {
      knownEntities: entities({}),
      requiresMemory: true,
      expectedStatus: "AI_ACTIVE",
    },
    handoff: handoffEither(
      "Booking continues; the current arch can only hand off.",
    ),
    knowledgeRequirement: "SERVICE_CATALOG",
    knowledgeSourceAssertion: {
      source: "SERVICE_CATALOG",
      currentChannel: "services",
    },
    edgeCategories: ["BOOKING_JOURNEY", "PARTIAL_INFORMATION"],
    difficulty: "MEDIUM",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: { dispositions: ["CLEAR"], changeOfState: "NONE" },
    expectedDomainAction: "REQUEST_MISSING_DATE",
    expectedStateTransition: {
      from: "MISSING_SERVICE",
      to: "SERVICE_SUPPLIED",
      bookingJourneyState: "SERVICE_SUPPLIED",
      factKey: "service",
      isRevision: false,
    },
    mutations: [
      "MISSING_HAMZA",
      "DROP_PUNCTUATION",
      "SPELLING_VARIATION",
      "KEYBOARD_MISTAKE",
    ],
    maxCases: 18,
    rationale:
      "The service checkpoint: a bare or noisy service name after the goal was stated. 'تنضيف' and 'cleaning' must all resolve to the same catalog entry.",
  }),

  // ── MISSING_DATE: service held, date absent ─────────────────────────────────
  multiTurn({
    id: "jt-missing-date",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز تنظيف الأسنان" },
      { senderType: "AI", text: "تمام — أنهي يوم يناسبك؟" },
      { senderType: "CUSTOMER", text: "الصبح أحسن" },
      AI_ASK_DATE,
    ],
    utterances: [
      ...egy(
        "أي يوم مناسب",
        "مش فارق معايا اليوم",
        "حددلي إنت يوم حلو",
        "أول ما يتيسر",
      ),
    ],
    semanticLabel: semantic(
      "BOOKING",
      "no date offered — propose days from availability",
    ),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "AMBIGUOUS", {
      architecturalLimitation: true,
    }),
    conversationState: {
      knownEntities: entities({
        service: "تنظيف الأسنان",
        timePreference: "الصبح",
      }),
      requiresMemory: true,
      expectedStatus: "AI_ACTIVE",
    },
    handoff: handoffEither(
      "Booking continues; the current arch can only hand off.",
    ),
    knowledgeRequirement: "AVAILABILITY",
    knowledgeSourceAssertion: {
      source: "AVAILABILITY_ENGINE",
      currentChannel: "availability",
    },
    edgeCategories: [
      "BOOKING_JOURNEY",
      "MISSING_INFORMATION",
      "AVAILABILITY_EDGE",
    ],
    difficulty: "HARD",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["VAGUE", "POLITE"],
      changeOfState: "NONE",
    },
    expectedDomainAction: "PROPOSE_SLOTS",
    expectedClarification: {
      type: "CLARIFY_DATE",
      question: "أقدر أقترح عليك أول متاح صباحاً — أنهي يوم أنسب لك؟",
      targets: ["date"],
    },
    expectedStateTransition: {
      from: "SERVICE_SUPPLIED",
      to: "MISSING_DATE",
      bookingJourneyState: "MISSING_DATE",
      isRevision: false,
    },
    futureArchitectureExpectation: {
      expectSelfService: true,
      expectClarification: true,
      expectKnowledgeLookup: true,
      expectConfirmation: false,
      expectKnowledgeGapRecorded: false,
    },
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    maxCases: 10,
    rationale:
      "The customer has a time preference but no date: the ideal assistant proposes concrete days instead of handing off on 'أي يوم'.",
  }),

  // ── DATE_SUPPLIED: the date slot is filled ──────────────────────────────────
  multiTurn({
    id: "jt-date-supplied",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز تنظيف الأسنان" },
      AI_ASK_DATE,
    ],
    utterances: [
      ...egy(
        "الخميس",
        "بكرة",
        "الخميس الجاي",
        "تاني يوم",
        "الخميس ٢ أكتوبر",
        "بعد بكرة",
      ),
      u("el khamis", "ARABIZI"),
      u("الخميس 2 أكتوبر", "MIXED_EGY_MSA", ["TYPOS", "MIXED_LANGUAGE"]),
    ],
    semanticLabel: semantic("BOOKING", "capture the date, ask for the time"),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      fullyHandledByCurrent: false,
    }),
    conversationState: {
      knownEntities: entities({ service: "تنظيف الأسنان" }),
      requiresMemory: true,
      expectedStatus: "AI_ACTIVE",
    },
    handoff: handoffEither(
      "Booking continues; the current arch can only hand off.",
    ),
    knowledgeRequirement: "AVAILABILITY",
    knowledgeSourceAssertion: {
      source: "AVAILABILITY_ENGINE",
      currentChannel: "availability",
    },
    edgeCategories: ["BOOKING_JOURNEY", "PARTIAL_INFORMATION"],
    difficulty: "MEDIUM",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: { dispositions: ["CLEAR"], changeOfState: "NONE" },
    expectedDomainAction: "REQUEST_MISSING_TIME",
    expectedStateTransition: {
      from: "MISSING_DATE",
      to: "DATE_SUPPLIED",
      bookingJourneyState: "DATE_SUPPLIED",
      factKey: "date",
      isRevision: false,
    },
    mutations: [
      "MISSING_HAMZA",
      "DROP_PUNCTUATION",
      "MIXED_NUMERALS",
      "SPELLING_VARIATION",
    ],
    maxCases: 18,
    rationale:
      "The date checkpoint: colloquial relative dates ('بكرة', 'تاني يوم'), Arabizi, and Arabic-Indic/Latin digit mixtures must all bind to a date.",
  }),

  // ── MISSING_TIME: date held, time absent ────────────────────────────────────
  multiTurn({
    id: "jt-missing-time",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز تنظيف الأسنان" },
      AI_ASK_DATE,
      { senderType: "CUSTOMER", text: "الخميس" },
      AI_ASK_TIME,
    ],
    utterances: [
      ...egy(
        "أي معاد",
        "أي وقت ينفع",
        "مش فارق المعاد",
        "حددلي إنت",
        "اللي يبقى مناسب",
      ),
    ],
    semanticLabel: semantic(
      "BOOKING",
      "no time offered — propose slots from availability",
    ),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    conversationState: {
      knownEntities: entities({ service: "تنظيف الأسنان", date: "الخميس" }),
      requiresMemory: true,
      expectedStatus: "AI_ACTIVE",
    },
    handoff: handoffEither(
      "Booking continues; the current arch can only hand off.",
    ),
    knowledgeRequirement: "AVAILABILITY",
    knowledgeSourceAssertion: {
      source: "AVAILABILITY_ENGINE",
      currentChannel: "availability",
    },
    edgeCategories: [
      "BOOKING_JOURNEY",
      "MISSING_INFORMATION",
      "AVAILABILITY_EDGE",
    ],
    difficulty: "HARD",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["VAGUE", "POLITE"],
      changeOfState: "NONE",
    },
    expectedDomainAction: "PROPOSE_SLOTS",
    expectedClarification: {
      type: "CLARIFY_TIME",
      question: "أقدر أقترح عليك المعاد — 10 الصبح ولا 12 الضهر يناسبك؟",
      targets: ["timePreference"],
    },
    expectedStateTransition: {
      from: "DATE_SUPPLIED",
      to: "MISSING_TIME",
      bookingJourneyState: "MISSING_TIME",
      isRevision: false,
    },
    futureArchitectureExpectation: {
      expectSelfService: true,
      expectClarification: true,
      expectKnowledgeLookup: true,
      expectConfirmation: false,
      expectKnowledgeGapRecorded: false,
    },
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    maxCases: 10,
    rationale:
      "'أي معاد' after a date: the ideal assistant proposes concrete slots rather than routing on the vagueness.",
  }),

  // ── TIME_SUPPLIED: the time preference is filled ────────────────────────────
  multiTurn({
    id: "jt-time-supplied",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز تنظيف الأسنان" },
      AI_ASK_DATE,
      { senderType: "CUSTOMER", text: "الخميس" },
      AI_ASK_TIME,
    ],
    utterances: [
      ...egy(
        "الساعة ١٠",
        "الصبح",
        "بعد الضهر",
        "بعد العصر",
        "الضهر",
        "آخر النهار",
        "الساعة 12",
      ),
      u("el 3asr", "ARABIZI"),
      u("الساعة ١٠", "MIXED_EGY_MSA", ["TYPOS"]),
    ],
    semanticLabel: semantic(
      "BOOKING",
      "capture the time preference, resolve availability",
    ),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      fullyHandledByCurrent: false,
    }),
    conversationState: {
      knownEntities: entities({
        service: "تنظيف الأسنان",
        date: "الخميس",
      }),
      requiresMemory: true,
      expectedStatus: "AI_ACTIVE",
    },
    handoff: handoffEither(
      "Booking continues; the current arch can only hand off.",
    ),
    knowledgeRequirement: "AVAILABILITY",
    knowledgeSourceAssertion: {
      source: "AVAILABILITY_ENGINE",
      currentChannel: "availability",
    },
    edgeCategories: ["BOOKING_JOURNEY", "PARTIAL_INFORMATION"],
    difficulty: "MEDIUM",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: { dispositions: ["CLEAR"], changeOfState: "NONE" },
    expectedDomainAction: "RESOLVE_AVAILABILITY",
    expectedStateTransition: {
      from: "MISSING_TIME",
      to: "TIME_SUPPLIED",
      bookingJourneyState: "TIME_SUPPLIED",
      factKey: "time",
      isRevision: false,
    },
    mutations: [
      "MISSING_HAMZA",
      "DROP_PUNCTUATION",
      "MIXED_NUMERALS",
      "SPELLING_VARIATION",
    ],
    maxCases: 18,
    rationale:
      "The time checkpoint: colloquial dayparts ('بعد العصر', 'آخر النهار') and mixed digit forms must all bind to a time preference.",
  }),

  // ── AVAILABILITY_RESOLVED: the customer asks what is free ───────────────────
  multiTurn({
    id: "jt-availability-resolved",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز تنظيف الأسنان يوم الخميس" },
      { senderType: "AI", text: "تمام — تفضل صباحاً ولا مساءً؟" },
      { senderType: "CUSTOMER", text: "الصبح" },
      {
        senderType: "AI",
        text: "لحظة، بفاضي المعادات المتاحة...",
      },
    ],
    utterances: [
      ...egy(
        "إمتى المتاح بالظبط؟",
        "المعادات اللي فاضية ايه؟",
        "قولي اللي يتيسر",
        "فيه ايه متاح؟",
      ),
      u("emta el mawgood?", "ARABIZI"),
    ],
    semanticLabel: semantic(
      "AVAILABILITY",
      "list the free slots for the held daypart",
    ),
    currentAiExpectation: current("AVAILABILITY", "handoff", null, {
      fullyHandledByCurrent: false,
    }),
    conversationState: {
      knownEntities: entities({
        service: "تنظيف الأسنان",
        date: "الخميس",
        timePreference: "الصبح",
      }),
      requiresMemory: true,
      expectedStatus: "AI_ACTIVE",
    },
    handoff: handoffEither(
      "Availability needs the engine; either path is fine.",
    ),
    knowledgeRequirement: "AVAILABILITY",
    knowledgeSourceAssertion: {
      source: "AVAILABILITY_ENGINE",
      currentChannel: "availability",
    },
    edgeCategories: [
      "BOOKING_JOURNEY",
      "AVAILABILITY_EDGE",
      "IMPLICIT_REFERENCE",
    ],
    difficulty: "MEDIUM",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: { dispositions: ["CLEAR"], changeOfState: "NONE" },
    expectedDomainAction: "PROPOSE_SLOTS",
    expectedStateTransition: {
      from: "TIME_SUPPLIED",
      to: "AVAILABILITY_RESOLVED",
      bookingJourneyState: "AVAILABILITY_RESOLVED",
      isRevision: false,
    },
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    maxCases: 12,
    rationale:
      "The availability checkpoint: 'المتاح' is relative to the held service/date/daypart, so the turn needs memory and the availability engine, not a handoff.",
  }),

  // ── SLOT_SELECTION: choosing from a numbered offer (seam-owned) ─────────────
  multiTurn({
    id: "jt-slot-selection-seam",
    contextTurns: [
      {
        senderType: "CUSTOMER",
        text: "عايز أحجز تنظيف الأسنان يوم 2026-10-01",
      },
      AI_OFFER,
    ],
    utterances: [
      ...egy("١", "الأول", "الخيار الأول", "الأول لو سمحت", "١٢:٠٠", "2"),
      u("el awal", "ARABIZI"),
    ],
    semanticLabel: semantic("BOOKING", "bind the selection to the offer, book"),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      fullyHandledByCurrent: false,
    }),
    conversationState: {
      knownEntities: entities({
        service: "تنظيف الأسنان",
        date: "2026-10-01",
      }),
      requiresMemory: true,
      expectedStatus: "AI_ACTIVE",
    },
    handoff: handoffEither(
      "Booking continues; the current arch can only hand off.",
    ),
    knowledgeRequirement: "NONE",
    edgeCategories: ["BOOKING_JOURNEY", "BOOKING_EDGE", "IMPLICIT_REFERENCE"],
    difficulty: "MEDIUM",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: { dispositions: ["CLEAR"], changeOfState: "NONE" },
    expectedDomainAction: "SELECT_SLOT",
    expectedStateTransition: {
      from: "AVAILABILITY_RESOLVED",
      to: "SLOT_SELECTION",
      bookingJourneyState: "SLOT_SELECTION",
      factKey: "slot",
      isRevision: false,
    },
    engineOwner: "BOOKING_SELECTION_SEAM",
    mutations: ["MISSING_HAMZA", "MIXED_NUMERALS"],
    maxCases: 12,
    rationale:
      "Slot selection after a numbered offer is owned by the engine's deterministic selection seam, not the assistant — the runner must not score it as a classification turn.",
  }),

  // ── CONFIRMATION: the customer confirms the proposed booking ────────────────
  multiTurn({
    id: "jt-confirmation",
    contextTurns: [
      {
        senderType: "CUSTOMER",
        text: "عايز أحجز تنظيف الأسنان يوم 2026-10-01",
      },
      AI_OFFER,
      { senderType: "CUSTOMER", text: "الخيار الأول" },
      AI_CONFIRM_ASK,
    ],
    utterances: [
      ...egy(
        "أيوه أكد",
        "تمام أكدلي",
        "أكّد يا فندم",
        "ماشي، أكد",
        "ايوة تمام",
      ),
      u("tamam akked", "ARABIZI"),
    ],
    semanticLabel: semantic("CONFIRMATION", "create the booking"),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      fullyHandledByCurrent: false,
    }),
    conversationState: {
      knownEntities: entities({
        service: "تنظيف الأسنان",
        date: "2026-10-01",
        provider: "د. منى",
        timePreference: "10:00",
      }),
      requiresMemory: true,
      expectedStatus: "AI_ACTIVE",
    },
    handoff: handoffEither("Booking confirmation is a staff action today."),
    knowledgeRequirement: "NONE",
    edgeCategories: ["BOOKING_JOURNEY", "CONFIRMATION"],
    difficulty: "MEDIUM",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["CLEAR", "POLITE"],
      changeOfState: "NONE",
    },
    expectedDomainAction: "CONFIRM_BOOKING",
    expectedStateTransition: {
      from: "SLOT_SELECTION",
      to: "CONFIRMATION",
      bookingJourneyState: "CONFIRMATION",
      isRevision: false,
    },
    futureArchitectureExpectation: {
      expectSelfService: true,
      expectClarification: false,
      expectKnowledgeLookup: false,
      expectConfirmation: true,
      expectKnowledgeGapRecorded: false,
    },
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    maxCases: 12,
    rationale:
      "The confirmation checkpoint: colloquial affirmations ('أيوه أكد', 'أكّد يا فندم') must be read as YES against the held offer.",
  }),

  // ── COMPLETED: the journey is done; a polite close ──────────────────────────
  multiTurn({
    id: "jt-completed",
    contextTurns: [
      {
        senderType: "CUSTOMER",
        text: "عايز أحجز تنظيف الأسنان يوم 2026-10-01",
      },
      AI_OFFER,
      { senderType: "CUSTOMER", text: "الأول" },
      { senderType: "CUSTOMER", text: "أكد" },
      AI_DONE,
    ],
    utterances: [
      ...egy("شكراً جزيلاً", "تسلم إيدك", "تمام متشكر", "شكراً، في أمان الله"),
      u("shokran gazilan", "ARABIZI"),
      u("thank you!", "ENGLISH"),
    ],
    semanticLabel: semantic(
      "GREETING",
      "close politely; the journey is complete",
    ),
    currentAiExpectation: current("GREETING", "reply", null, {
      fullyHandledByCurrent: true,
    }),
    conversationState: {
      knownEntities: entities({
        service: "تنظيف الأسنان",
        date: "2026-10-01",
        provider: "د. منى",
      }),
      requiresMemory: true,
      expectedStatus: "BOOKED",
    },
    handoff: handoffNotRequired(
      "A thank-you after a completed booking must never become a handoff.",
    ),
    knowledgeRequirement: "NONE",
    edgeCategories: ["BOOKING_JOURNEY", "CONFIRMATION", "FOLLOW_UP"],
    difficulty: "EASY",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: { dispositions: ["POLITE"], changeOfState: "NONE" },
    expectedDomainAction: "REPLY_FROM_KNOWLEDGE",
    expectedStateTransition: {
      from: "CONFIRMATION",
      to: "COMPLETED",
      bookingJourneyState: "COMPLETED",
      isRevision: false,
    },
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    maxCases: 12,
    rationale:
      "The terminal checkpoint: gratitude after BOOKED must stay AI_ACTIVE and not reopen the booking or escalate.",
  }),

  // ── INTERRUPTED: the customer stops mid-journey ─────────────────────────────
  multiTurn({
    id: "jt-interrupted",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز تنظيف الأسنان" },
      AI_ASK_DATE,
      { senderType: "CUSTOMER", text: "الخميس" },
      AI_ASK_TIME,
    ],
    utterances: [
      ...egy(
        "ثواني بس، أنا في مكالمة",
        "لحظة واحدة",
        "اتركني دقيقة",
        "ثانية وارجعلك",
      ),
    ],
    semanticLabel: semantic(
      "BOOKING",
      "pause the journey; hold the gathered facts",
    ),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    conversationState: {
      knownEntities: entities({ service: "تنظيف الأسنان", date: "الخميس" }),
      requiresMemory: true,
      expectedStatus: "AI_ACTIVE",
    },
    handoff: handoffNotRequired(
      "A pause is not a request for a human; the assistant should hold the facts.",
    ),
    knowledgeRequirement: "NONE",
    edgeCategories: ["BOOKING_JOURNEY", "INTERRUPTION", "BOOKING_EDGE"],
    difficulty: "HARD",
    rarity: "RARE",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: { dispositions: ["HURRIED"], changeOfState: "NONE" },
    expectedDomainAction: "REQUEST_MISSING_TIME",
    expectedStateTransition: {
      from: "DATE_SUPPLIED",
      to: "INTERRUPTED",
      bookingJourneyState: "INTERRUPTED",
      isRevision: false,
    },
    futureArchitectureExpectation: {
      expectSelfService: true,
      expectClarification: false,
      expectKnowledgeLookup: false,
      expectConfirmation: false,
      expectKnowledgeGapRecorded: false,
    },
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    maxCases: 10,
    rationale:
      "An interruption that is NOT a human request: the ideal assistant waits and preserves the service + date already gathered.",
  }),

  // ── RECOVERING: the customer resumes after an interruption ──────────────────
  multiTurn({
    id: "jt-recovering",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز تنظيف الأسنان" },
      AI_ASK_DATE,
      { senderType: "CUSTOMER", text: "الخميس" },
      AI_ASK_TIME,
      { senderType: "CUSTOMER", text: "ثواني بس" },
      { senderType: "AI", text: "خد راحتك — أنا موجود." },
    ],
    utterances: [
      ...egy(
        "رجعت، نكمل؟",
        "اعتذر، نكمل الحجز",
        "تقدر تكمل؟",
        "ماشي، نكمل المعاد",
        "أنا جاهز، أكمل",
      ),
    ],
    semanticLabel: semantic(
      "BOOKING",
      "resume from the interrupted state with the held facts",
    ),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "AMBIGUOUS", {
      architecturalLimitation: true,
    }),
    conversationState: {
      knownEntities: entities({ service: "تنظيف الأسنان", date: "الخميس" }),
      requiresMemory: true,
      expectedStatus: "AI_ACTIVE",
    },
    handoff: handoffEither(
      "Booking resumes; the current arch can only hand off.",
    ),
    knowledgeRequirement: "NONE",
    edgeCategories: ["BOOKING_JOURNEY", "STATE_RECOVERY", "IMPLICIT_REFERENCE"],
    difficulty: "EXTREME",
    rarity: "RARE",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["POLITE", "CLEAR"],
      changeOfState: "NONE",
    },
    expectedDomainAction: "REQUEST_MISSING_TIME",
    expectedStateTransition: {
      from: "INTERRUPTED",
      to: "RECOVERING",
      bookingJourneyState: "RECOVERING",
      isRevision: false,
    },
    futureArchitectureExpectation: {
      expectSelfService: true,
      expectClarification: false,
      expectKnowledgeLookup: false,
      expectConfirmation: false,
      expectKnowledgeGapRecorded: false,
    },
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    maxCases: 10,
    rationale:
      "State recovery: 'نكمل' must re-enter the journey at the MISSING_TIME step with the service and date still held, not start over.",
  }),

  // ── ABORTED: the customer abandons the journey ──────────────────────────────
  multiTurn({
    id: "jt-aborted",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز تنظيف الأسنان" },
      AI_ASK_DATE,
      { senderType: "CUSTOMER", text: "الخميس" },
      AI_ASK_TIME,
    ],
    utterances: [
      ...egy(
        "سيبك من الحجز ده",
        "لا ألغيت الفكرة",
        "مش هحجز دلوقتي",
        "خلاص يا عم سيبها",
        "أنا راجعلك بعدين",
      ),
    ],
    semanticLabel: semantic(
      "CANCELLATION",
      "abort the in-progress booking without creating one",
    ),
    currentAiExpectation: current("CANCELLATION", "handoff", null, {
      fullyHandledByCurrent: false,
    }),
    conversationState: {
      knownEntities: entities({ service: "تنظيف الأسنان", date: "الخميس" }),
      requiresMemory: true,
      expectedStatus: "INCOMPLETE",
    },
    handoff: handoffNotRequired(
      "Abandoning an unconfirmed booking needs no human; nothing exists to cancel yet.",
    ),
    knowledgeRequirement: "NONE",
    edgeCategories: [
      "BOOKING_JOURNEY",
      "BOOKING_FAILURE",
      "REFUSAL",
      "CANCELLATION_EDGE",
    ],
    difficulty: "HARD",
    rarity: "UNCOMMON",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["HURRIED", "CONTRADICTORY"],
      changeOfState: "CHANGES_MIND",
    },
    expectedDomainAction: "NONE",
    expectedStateTransition: {
      from: "DATE_SUPPLIED",
      to: "ABORTED",
      bookingJourneyState: "ABORTED",
      isRevision: false,
    },
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    maxCases: 12,
    rationale:
      "Abandonment mid-journey: no appointment was ever created, so the correct behavior is to close the flow cleanly — not to route to staff for a cancellation.",
  }),

  // ── REVISIONS: the truth moves WITH the revised fact ────────────────────────

  // Date revision: "لا قصدي الجمعة"
  multiTurn({
    id: "jt-revise-date",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز تنظيف الأسنان" },
      AI_ASK_DATE,
      { senderType: "CUSTOMER", text: "الخميس" },
      { senderType: "AI", text: "تمام — الخميس. تفضل صباحاً ولا مساءً؟" },
    ],
    utterances: [
      ...egy(
        "لا قصدي الجمعة",
        "بكرة... لا الجمعة",
        "لا الخميس ده مش هينفع، الجمعة أحسن",
        "نسيت — الجمعة",
        "مش ده اللي أقصده، الجمعة",
      ),
      u("la 2asdy el gom3a", "ARABIZI"),
    ],
    semanticLabel: semantic(
      "BOOKING",
      "move the held date to the revised one, then continue",
    ),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    conversationState: {
      knownEntities: entities({ service: "تنظيف الأسنان", date: "الجمعة" }),
      requiresMemory: true,
      expectedStatus: "AI_ACTIVE",
    },
    handoff: handoffEither(
      "A date revision keeps the journey on the AI; either outcome is acceptable today.",
    ),
    knowledgeRequirement: "NONE",
    edgeCategories: ["BOOKING_JOURNEY", "SELF_CORRECTION", "CONTRADICTION"],
    difficulty: "HARD",
    rarity: "UNCOMMON",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["CORRECTIVE"],
      changeOfState: "CHANGES_DATE",
    },
    expectedDomainAction: "REQUEST_MISSING_TIME",
    entities: entities({ service: "تنظيف الأسنان", date: "الجمعة" }),
    expectedStateTransition: {
      from: "DATE_SUPPLIED",
      to: "DATE_SUPPLIED",
      bookingJourneyState: "DATE_SUPPLIED",
      factKey: "date",
      isRevision: true,
    },
    futureArchitectureExpectation: {
      expectSelfService: true,
      expectClarification: false,
      expectKnowledgeLookup: false,
      expectConfirmation: true,
      expectKnowledgeGapRecorded: false,
    },
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION", "KEYBOARD_MISTAKE"],
    maxCases: 14,
    rationale:
      "A date revision is a SEMANTIC-changing turn emitted from its own scenario: the expected date moves to الجمعة and isRevision marks the supersession.",
  }),

  // Service revision
  multiTurn({
    id: "jt-revise-service",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز تنظيف الأسنان" },
      { senderType: "AI", text: "تمام — أنهي يوم يناسبك؟" },
    ],
    utterances: [
      ...egy(
        "لا قصدي تقويم",
        "بصراحة التقويم أحسنلي",
        "نسيت، عايز حشو الضرس",
        "مش التنظيف — تبييض",
      ),
    ],
    semanticLabel: semantic(
      "BOOKING",
      "move the held service to the revised one, then continue",
    ),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "AMBIGUOUS", {
      architecturalLimitation: true,
    }),
    conversationState: {
      knownEntities: entities({ service: "تقويم الأسنان" }),
      requiresMemory: true,
      expectedStatus: "AI_ACTIVE",
    },
    handoff: handoffEither("A service revision keeps the journey on the AI."),
    knowledgeRequirement: "SERVICE_CATALOG",
    knowledgeSourceAssertion: {
      source: "SERVICE_CATALOG",
      currentChannel: "services",
    },
    edgeCategories: ["BOOKING_JOURNEY", "SELF_CORRECTION", "CONTRADICTION"],
    difficulty: "HARD",
    rarity: "UNCOMMON",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["CORRECTIVE"],
      changeOfState: "CHANGES_SERVICE",
    },
    expectedDomainAction: "REQUEST_MISSING_DATE",
    entities: entities({ service: "تقويم الأسنان" }),
    expectedStateTransition: {
      from: "SERVICE_SUPPLIED",
      to: "SERVICE_SUPPLIED",
      bookingJourneyState: "SERVICE_SUPPLIED",
      factKey: "service",
      isRevision: true,
    },
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    maxCases: 12,
    rationale:
      "A service revision: the expected service moves with the turn, proving the truth tracks the customer's latest word.",
  }),

  // Time revision
  multiTurn({
    id: "jt-revise-time",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز تنظيف الأسنان يوم الخميس" },
      { senderType: "AI", text: "تمام — تفضل صباحاً ولا مساءً؟" },
      { senderType: "CUSTOMER", text: "الصبح" },
      { senderType: "AI", text: "حاضر — معاد صباحاً." },
    ],
    utterances: [
      ...egy(
        "لا بعد العصر أحسن",
        "بصراحة الضهر أريحلي",
        "غيّر المعاد لمساء",
        "لا مش الصبح",
      ),
    ],
    semanticLabel: semantic(
      "BOOKING",
      "move the held time preference, then re-resolve availability",
    ),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    conversationState: {
      knownEntities: entities({
        service: "تنظيف الأسنان",
        date: "الخميس",
        timePreference: "بعد العصر",
      }),
      requiresMemory: true,
      expectedStatus: "AI_ACTIVE",
    },
    handoff: handoffEither("A time revision keeps the journey on the AI."),
    knowledgeRequirement: "AVAILABILITY",
    knowledgeSourceAssertion: {
      source: "AVAILABILITY_ENGINE",
      currentChannel: "availability",
    },
    edgeCategories: [
      "BOOKING_JOURNEY",
      "SELF_CORRECTION",
      "CONTRADICTION",
      "AVAILABILITY_EDGE",
    ],
    difficulty: "HARD",
    rarity: "UNCOMMON",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["CORRECTIVE"],
      changeOfState: "CHANGES_TIME",
    },
    expectedDomainAction: "RESOLVE_AVAILABILITY",
    entities: entities({
      service: "تنظيف الأسنان",
      date: "الخميس",
      timePreference: "بعد العصر",
    }),
    expectedStateTransition: {
      from: "TIME_SUPPLIED",
      to: "TIME_SUPPLIED",
      bookingJourneyState: "TIME_SUPPLIED",
      factKey: "time",
      isRevision: true,
    },
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    maxCases: 12,
    rationale:
      "A time-of-day revision: availability must be re-resolved against the new daypart, not the abandoned one.",
  }),

  // Provider revision ("أي دكتور" → named provider)
  multiTurn({
    id: "jt-revise-provider",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز تنظيف الأسنان يوم الخميس" },
      AI_OFFER,
    ],
    utterances: [
      ...egy(
        "أي دكتور ينفع",
        "مش فارق معايا الدكتور",
        "اللي يكون فاضي",
        "دكتور تاني غير ده",
        "أي حد مناسب",
      ),
    ],
    semanticLabel: semantic(
      "BOOKING",
      "record no provider preference (or a changed one), then select a slot",
    ),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      fullyHandledByCurrent: false,
    }),
    conversationState: {
      knownEntities: entities({ service: "تنظيف الأسنان", date: "الخميس" }),
      requiresMemory: true,
      expectedStatus: "AI_ACTIVE",
    },
    handoff: handoffEither(
      "Slot selection continues; the current arch routes to staff.",
    ),
    knowledgeRequirement: "AVAILABILITY",
    knowledgeSourceAssertion: {
      source: "AVAILABILITY_ENGINE",
      currentChannel: "availability",
    },
    edgeCategories: [
      "BOOKING_JOURNEY",
      "BOOKING_EDGE",
      "AMBIGUOUS_STATE_RESOLVES",
    ],
    difficulty: "MEDIUM",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["VAGUE", "POLITE"],
      changeOfState: "CHANGES_PROVIDER",
    },
    expectedDomainAction: "SELECT_SLOT",
    expectedStateTransition: {
      from: "AVAILABILITY_RESOLVED",
      to: "SLOT_SELECTION",
      bookingJourneyState: "SLOT_SELECTION",
      factKey: "provider",
      isRevision: false,
    },
    engineOwner: "BOOKING_SELECTION_SEAM",
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    maxCases: 12,
    rationale:
      "'أي دكتور' is an explicit no-preference that resolves the provider slot by context — the availability engine, not a handoff, owns it.",
  }),

  // Change of mind that aborts
  multiTurn({
    id: "jt-changes-mind-abort",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز تنظيف الأسنان" },
      AI_ASK_DATE,
      { senderType: "CUSTOMER", text: "الخميس" },
      AI_ASK_TIME,
      { senderType: "CUSTOMER", text: "الصبح" },
      { senderType: "AI", text: "تمام — معاد صباحاً يوم الخميس." },
    ],
    utterances: [
      ...egy(
        "بصراحة أنا متردد، هفكر وأرجعلك",
        "مش متأكد خلصني وترجعلي",
        "أنا لسه بفكر، اتأخر شوية",
        "طيب خلني أفكر",
      ),
    ],
    semanticLabel: semantic(
      "BOOKING",
      "hold the gathered facts; the customer defers the decision",
    ),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    conversationState: {
      knownEntities: entities({
        service: "تنظيف الأسنان",
        date: "الخميس",
        timePreference: "الصبح",
      }),
      requiresMemory: true,
      expectedStatus: "INCOMPLETE",
    },
    handoff: handoffNotRequired(
      "Deferral is not a human request; the assistant should hold the draft and let the customer return.",
    ),
    knowledgeRequirement: "NONE",
    edgeCategories: [
      "BOOKING_JOURNEY",
      "BOOKING_FAILURE",
      "HESITATION",
      "BOOKING_EDGE",
    ],
    difficulty: "HARD",
    rarity: "UNCOMMON",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["HESITANT"],
      changeOfState: "CHANGES_MIND",
    },
    expectedDomainAction: "NONE",
    expectedStateTransition: {
      from: "TIME_SUPPLIED",
      to: "INTERRUPTED",
      bookingJourneyState: "INTERRUPTED",
      isRevision: false,
    },
    futureArchitectureExpectation: {
      expectSelfService: true,
      expectClarification: false,
      expectKnowledgeLookup: false,
      expectConfirmation: false,
      expectKnowledgeGapRecorded: false,
    },
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    maxCases: 10,
    rationale:
      "Hesitation at the last step: the journey pauses (not aborts) so the customer can resume later with every fact intact.",
  }),
];
