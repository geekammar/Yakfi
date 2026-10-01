/**
 * FlowPilot AI Evaluation — egyptian-v1 MULTI-TURN scenarios.
 *
 * Each scenario is ONE conversation shape; every authored utterance becomes a
 * separate conversation variant (same gold label, different surface text) so
 * the bank multiplies into 300+ distinct conversations. `contextTurns` are the
 * prior turns; the evaluated turn is the LAST customer utterance.
 *
 * Covered: full booking journeys, booking failures (service/date/time
 * corrections, unavailable, change-of-mind), topic switching + return,
 * self-correction, partial information, refusal, repetition, implicit
 * references ("نفس المعاد", "اللي قولتلي عليه"), "تمام" after a domain
 * result, "لا" after an offer, and "اه" in ambiguous context.
 */

import type { Scenario } from "../../schema/scenario-schema";
import {
  current,
  egy,
  entities,
  handoffEither,
  handoffNotRequired,
  handoffRequired,
  multiTurn,
  semantic,
  u,
} from "./scenario-builders";
import { CLINIC_CONTEXT } from "./shared-context";

/** A compact prior AI offer used by several journeys. */
const AI_OFFER = {
  senderType: "AI" as const,
  text: 'تتوفر المواعيد التالية لخدمة "تنظيف الأسنان" يوم 2026-10-01:\n1. د. منى — 10:00 إلى 10:30\n2. د. منى — 12:00 إلى 12:30\nيرجى اختيار أحد الخيارات.',
};

const AI_ASK_DATE = {
  senderType: "AI" as const,
  text: "تمام — أنهي يوم يناسبك؟",
};

const AI_ASK_SERVICE = {
  senderType: "AI" as const,
  text: "أهلاً بك!  أنا مساعدك للحجز والمواعيد — كيف يمكنني مساعدتك اليوم؟",
};

export const multiTurnScenarios: Scenario[] = [
  // ── 1. Full booking journey: missing service → provided ──────────────────
  multiTurn({
    id: "mt-booking-journey-service-then-date",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز موعد" },
      AI_ASK_SERVICE,
    ],
    utterances: egy("تنظيف الأسنان", "عايز تنظيف أسنان", "تنظيف"),
    semanticLabel: semantic("BOOKING", "capture service, ask for date"),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "AMBIGUOUS", {
      architecturalLimitation: true,
    }),
    conversationState: {
      knownEntities: entities({}),
      requiresMemory: true,
      expectedStatus: "AI_ACTIVE",
    },
    handoff: handoffEither(
      "Booking flow continues; current arch can only hand off.",
    ),
    edgeCategories: ["BOOKING_JOURNEY", "PARTIAL_INFORMATION"],
    difficulty: "HARD",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale:
      "Follow-up with ONLY the service name — needs memory of the prior booking request; current arch sees a bare noun and hands off.",
  }),

  // ── 2. Journey: service + date, then time preference ─────────────────────
  multiTurn({
    id: "mt-booking-journey-time-preference",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز تنظيف الأسنان" },
      { senderType: "AI", text: "تمام — أنهي يوم يناسبك؟" },
      { senderType: "CUSTOMER", text: "الخميس" },
      { senderType: "AI", text: "طيب — تفضل صباحاً ولا مساءً؟" },
    ],
    utterances: egy(
      "الصبح لو ينفع",
      "بعد الضهر أحسن",
      "الساعة ١٠",
      "أي وقت الصبح تمام",
    ),
    semanticLabel: semantic(
      "BOOKING",
      "capture time preference, check availability",
    ),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    conversationState: {
      knownEntities: entities({ service: "تنظيف الأسنان", date: "الخميس" }),
      requiresMemory: true,
    },
    handoff: handoffEither("Current arch routes the whole booking to staff."),
    edgeCategories: ["BOOKING_JOURNEY", "PARTIAL_INFORMATION"],
    difficulty: "MEDIUM",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    rationale:
      "Time-of-day preference after service+date are known; 'الساعة ١٠' uses Arabic-Indic digits.",
  }),

  // ── 3. Journey: post-offer confirmation ("تمام" after a domain result) ───
  multiTurn({
    id: "mt-booking-post-offer-tamam",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز تنظيف الأسنان يوم الخميس" },
      AI_OFFER,
    ],
    utterances: egy("تمام", "ماشي", "اوكي تمام كده", "الخيار الأول مناسب"),
    semanticLabel: semantic(
      "CONFIRMATION",
      "confirm the selected slot / close booking",
    ),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "AMBIGUOUS", {
      architecturalLimitation: true,
    }),
    conversationState: {
      knownEntities: entities({
        service: "تنظيف الأسنان",
        date: "2026-10-01",
      }),
      requiresMemory: true,
    },
    handoff: handoffEither(
      "Current arch cannot consume a bare 'تمام' as a selection.",
    ),
    edgeCategories: ["CONFIRMATION", "IMPLICIT_REFERENCE"],
    difficulty: "HARD",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    mutations: [],
    rationale:
      "'تمام' immediately after a numbered slot offer — a real assistant confirms; the current arch has no state to bind it to.",
  }),

  // ── 4. Journey: slot selection by number ─────────────────────────────────
  multiTurn({
    id: "mt-booking-select-index",
    contextTurns: [
      {
        senderType: "CUSTOMER",
        text: "عايز أحجز تنظيف الأسنان يوم 2026-10-01",
      },
      AI_OFFER,
    ],
    utterances: egy("١", "رقم ٢", "الخيار التاني", "الأول لو سمحت"),
    semanticLabel: semantic("BOOKING", "bind selection to offer, book"),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: false,
    }),
    conversationState: {
      knownEntities: entities({
        service: "تنظيف الأسنان",
        date: "2026-10-01",
      }),
      requiresMemory: true,
    },
    handoff: handoffEither(
      "Index selection is handled deterministically by the engine when the offer shape matches.",
    ),
    edgeCategories: ["BOOKING_JOURNEY", "IMPLICIT_REFERENCE"],
    difficulty: "MEDIUM",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    engineOwner: "BOOKING_SELECTION_SEAM",
    rationale:
      "Numeric/Arabic-Indic slot selections after an offer — owned by the engine's deterministic selection seam, not the AI.",
  }),

  // ── 5. Journey: slot selection by time ───────────────────────────────────
  multiTurn({
    id: "mt-booking-select-time",
    contextTurns: [
      {
        senderType: "CUSTOMER",
        text: "عايز أحجز تنظيف الأسنان يوم 2026-10-01",
      },
      AI_OFFER,
    ],
    utterances: egy("١٢:٠٠", "الساعة ١٢", "12:00", "عايز معاد 12 الضهر"),
    semanticLabel: semantic("BOOKING", "bind time selection to offer, book"),
    currentAiExpectation: current("BOOKING", "booking_handoff", null),
    conversationState: {
      knownEntities: entities({
        service: "تنظيف الأسنان",
        date: "2026-10-01",
      }),
      requiresMemory: true,
    },
    handoff: handoffEither(
      "Time selection handled by the deterministic parser.",
    ),
    edgeCategories: ["BOOKING_JOURNEY", "IMPLICIT_REFERENCE"],
    difficulty: "MEDIUM",
    businessContext: CLINIC_CONTEXT,
    mutations: ["DROP_PUNCTUATION"],
    engineOwner: "BOOKING_SELECTION_SEAM",
    rationale:
      "Time-based selections (Arabic-Indic, Latin, colloquial 'الضهر') — owned by the selection seam.",
  }),

  // ── 6. Booking failure: service not recognized ───────────────────────────
  multiTurn({
    id: "mt-booking-service-not-recognized",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز موعد" },
      AI_ASK_SERVICE,
    ],
    utterances: egy(
      "عايز أعمل كشف عام",
      "محتاج جلسة تنظير",
      "عايز حاجة للأسنان",
    ),
    semanticLabel: semantic("BOOKING", "no matching service → ask/clarify"),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "AMBIGUOUS", {
      architecturalLimitation: true,
    }),
    conversationState: {
      knownEntities: entities({}),
      requiresMemory: true,
    },
    handoff: handoffEither("No matching service — clarify or route."),
    edgeCategories: ["BOOKING_FAILURE", "PARTIAL_INFORMATION"],
    difficulty: "HARD",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale:
      "Customer names a service the catalog does not contain — current arch cannot offer alternatives.",
  }),

  // ── 7. Booking failure: date correction ──────────────────────────────────
  multiTurn({
    id: "mt-booking-date-correction",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز تنظيف الأسنان يوم الخميس" },
      { senderType: "AI", text: "تمام — الخميس 2026-10-01." },
    ],
    utterances: egy(
      "لا قصدي الجمعة",
      "لا مش كده — بكرة",
      "قصدي الأسبوع الجاي مش الخميس",
      "بكرة... لا الجمعة",
    ),
    semanticLabel: semantic("BOOKING", "supersede prior date with correction"),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    conversationState: {
      knownEntities: entities({
        service: "تنظيف الأسنان",
        date: "الجمعة (مصحَّح)",
      }),
      requiresMemory: true,
    },
    handoff: handoffEither("Date correction still a booking turn."),
    edgeCategories: ["SELF_CORRECTION", "BOOKING_JOURNEY"],
    difficulty: "HARD",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    rationale:
      "Self-correction ('لا قصدي...', 'بكرة... لا الجمعة') — tests whether the last-stated date wins; current arch cannot track state.",
  }),

  // ── 8. Booking failure: time correction ──────────────────────────────────
  multiTurn({
    id: "mt-booking-time-correction",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز يوم 2026-10-01 الساعة 10" },
      { senderType: "AI", text: "تمام — 10:00." },
    ],
    utterances: egy(
      "لا خليها 12",
      "قصدي ١١ مش ١٠",
      "لا بلاش الصبح خليها بعد الضهر",
    ),
    semanticLabel: semantic("BOOKING", "supersede prior time with correction"),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    conversationState: {
      knownEntities: entities({
        date: "2026-10-01",
        timePreference: "12:00 (مصحَّح)",
      }),
      requiresMemory: true,
    },
    handoff: handoffEither("Time correction still a booking turn."),
    edgeCategories: ["SELF_CORRECTION", "BOOKING_JOURNEY"],
    difficulty: "HARD",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale: "Time correction after prior time stated.",
  }),

  // ── 9. Booking failure: conflicting preferences ──────────────────────────
  multiTurn({
    id: "mt-booking-conflicting-prefs",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز مع د. منى يوم الخميس الصبح" },
      { senderType: "AI", text: "طيب." },
    ],
    utterances: egy(
      "لا عايز يوم الجمعة الصبح مع د. أحمد",
      "خليها مساء مع أي دكتور تاني مش منى",
      "أي وقت بس مش مع د. منى",
    ),
    semanticLabel: semantic(
      "BOOKING",
      "resolve conflicting provider/date preference",
    ),
    currentAiExpectation: current("RESCHEDULE", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    conversationState: {
      knownEntities: entities({ service: "تنظيف الأسنان" }),
      requiresMemory: true,
    },
    handoff: handoffEither(
      "Conflicting preferences need clarification or staff.",
    ),
    edgeCategories: ["CONTRADICTION", "BOOKING_FAILURE"],
    difficulty: "EXTREME",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale:
      "Conflicting provider/date constraints; note 'خليها' can falsely trigger the RESCHEDULE branch ('تحويل'-like words are not present, but 'تاني' + appointment word can).",
  }),

  // ── 10. Booking failure: unavailable date ────────────────────────────────
  multiTurn({
    id: "mt-booking-unavailable-date",
    contextTurns: [
      {
        senderType: "CUSTOMER",
        text: "عايز أحجز تنظيف الأسنان يوم 2026-10-02",
      },
      {
        senderType: "AI",
        text: "المنشأة مغلقة يوم 2026-10-02 — يرجى اختيار تاريخ آخر.",
      },
    ],
    utterances: egy(
      "طب يوم تاني",
      "خلاص أفضل يوم الأحد",
      "طيب الأسبوع الجاي في أي يوم فاضي؟",
    ),
    semanticLabel: semantic(
      "AVAILABILITY",
      "re-offer dates after unavailability",
    ),
    currentAiExpectation: current("AVAILABILITY", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    conversationState: {
      knownEntities: entities({ service: "تنظيف الأسنان" }),
      requiresMemory: true,
    },
    handoff: handoffEither("Alternative-date lookup routed by design."),
    edgeCategories: ["BOOKING_FAILURE", "FOLLOW_UP"],
    difficulty: "MEDIUM",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale: "Recovery after a closed day.",
  }),

  // ── 11. Booking failure: customer changes mind ───────────────────────────
  multiTurn({
    id: "mt-booking-change-mind",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز تنظيف الأسنان يوم الخميس" },
      AI_OFFER,
    ],
    utterances: egy(
      "خلاص مش عايز أحجز",
      "بلاش الحجز ده",
      "استنى — هأجل الحجز لحد ما أشوف",
    ),
    semanticLabel: semantic("CANCELLATION", "abandon/keep pending"),
    currentAiExpectation: current("CANCELLATION", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    conversationState: {
      knownEntities: entities({ service: "تنظيف الأسنان" }),
      requiresMemory: true,
    },
    handoff: handoffEither("Change of mind — staff/unwind may be needed."),
    edgeCategories: ["BOOKING_FAILURE", "CONTRADICTION"],
    difficulty: "MEDIUM",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale: "Customer abandons an in-flight booking.",
  }),

  // ── 12. Customer changes service mid-conversation ────────────────────────
  multiTurn({
    id: "mt-change-service",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز تنظيف الأسنان يوم الخميس" },
      { senderType: "AI", text: "تمام — تنظيف الأسنان. أنهي وقت؟" },
    ],
    utterances: egy(
      "لا خليها تبييض بدل التنظيف",
      "غيّر الخدمة لحشو",
      "مش تنظيف — عايز تقويم",
    ),
    semanticLabel: semantic("BOOKING", "replace service in the active booking"),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    conversationState: {
      knownEntities: entities({ service: "تبييض الأسنان (مصحَّح)" }),
      requiresMemory: true,
    },
    handoff: handoffEither("Service change is still a booking turn."),
    edgeCategories: ["SELF_CORRECTION", "BOOKING_JOURNEY"],
    difficulty: "HARD",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale: "Service replacement mid-flow.",
  }),

  // ── 13. Customer changes provider preference ─────────────────────────────
  multiTurn({
    id: "mt-change-provider",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز مع د. منى" },
      { senderType: "AI", text: "تمام — د. منى. أنهي يوم؟" },
    ],
    utterances: egy(
      "لا مع د. أحمد",
      "خليها مع أي دكتور",
      "مش منى — عايز الدكتور التاني",
    ),
    semanticLabel: semantic("BOOKING", "replace provider preference"),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    conversationState: {
      knownEntities: entities({ provider: "د. أحمد (مصحَّح)" }),
      requiresMemory: true,
    },
    handoff: handoffEither("Provider change is a booking turn."),
    edgeCategories: ["SELF_CORRECTION", "BOOKING_JOURNEY"],
    difficulty: "HARD",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale: "Provider replacement mid-flow.",
  }),

  // ── 14. Customer gives partial information (only a date) ─────────────────
  multiTurn({
    id: "mt-partial-date-only",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز" },
      AI_ASK_SERVICE,
    ],
    utterances: egy("الخميس", "بكرة", "يوم 15", "الأسبوع الجاي"),
    semanticLabel: semantic("BOOKING", "store date, still need service"),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "AMBIGUOUS", {
      architecturalLimitation: true,
    }),
    conversationState: {
      knownEntities: entities({ date: "الخميس" }),
      requiresMemory: true,
    },
    handoff: handoffEither("Partial info; needs memory + clarification."),
    edgeCategories: ["PARTIAL_INFORMATION", "AMBIGUOUS_STATE_RESOLVES"],
    difficulty: "HARD",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale:
      "Date alone after a booking question — resolvable only from conversation state.",
  }),

  // ── 15. Customer refuses to answer ───────────────────────────────────────
  multiTurn({
    id: "mt-refusal",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز" },
      { senderType: "AI", text: "ممكن اسمك ورقمك؟" },
    ],
    utterances: egy(
      "مش عايز أقول",
      "ليه لازم تعرف؟",
      "مش هقولك حاجة",
      "سيبه ده دلوقتي",
    ),
    semanticLabel: semantic("AMBIGUOUS", "respect refusal, route or continue"),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "AMBIGUOUS", {
      fullyHandledByCurrent: true,
    }),
    conversationState: { requiresMemory: true },
    handoff: handoffEither("Refusal may legitimately need a human."),
    edgeCategories: ["REFUSAL", "AMBIGUOUS_NEEDS_HUMAN"],
    difficulty: "MEDIUM",
    mutations: ["MISSING_HAMZA"],
    rationale: "Customer refuses to provide information.",
  }),

  // ── 16. Customer repeats themselves ──────────────────────────────────────
  multiTurn({
    id: "mt-repetition",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز تنظيف الأسنان" },
      { senderType: "AI", text: "تمام — أنهي يوم يناسبك؟" },
      { senderType: "CUSTOMER", text: "عايز أحجز تنظيف الأسنان" },
    ],
    utterances: egy(
      "عايز أحجز تنظيف الأسنان",
      "أنا قلت عايز أحجز تنظيف",
      "يعني حجز تنظيف أسنان",
    ),
    semanticLabel: semantic("FOLLOW_UP", "re-acknowledge and progress"),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    conversationState: {
      knownEntities: entities({ service: "تنظيف الأسنان" }),
      requiresMemory: true,
    },
    handoff: handoffEither("Booking still routed to staff by design."),
    edgeCategories: ["REPETITION", "FOLLOW_UP"],
    difficulty: "MEDIUM",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale:
      "Repeated booking request — should not be treated as new/confused.",
  }),

  // ── 17. Topic switch (booking → unrelated question) ──────────────────────
  multiTurn({
    id: "mt-topic-switch-booking-to-hours",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز موعد" },
      AI_ASK_SERVICE,
    ],
    utterances: egy(
      "بالمناسبة بتفتحوا الساعة كام؟",
      "سؤال تاني — ساعات العمل ايه؟",
      "قبل ما أحجز — انتوا بتفتحوا إمتى؟",
    ),
    semanticLabel: semantic(
      "TOPIC_SWITCH",
      "answer hours, then resume booking",
      ["HOURS", "BOOKING"],
    ),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "NO_KNOWLEDGE", {
      architecturalLimitation: true,
    }),
    conversationState: { requiresMemory: true },
    handoff: handoffNotRequired(
      "Knowledge exists (hours FAQ) — current token matcher may still miss the colloquial form.",
    ),
    edgeCategories: ["TOPIC_SWITCH", "MULTI_INTENT"],
    difficulty: "HARD",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    rationale:
      "Question injected mid-booking — tests topic switching and whether hours knowledge is reachable in a booking context.",
  }),

  // ── 18. Topic return (back to an earlier topic) ──────────────────────────
  multiTurn({
    id: "mt-topic-return",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز تنظيف" },
      { senderType: "AI", text: "تمام — أنهي يوم؟" },
      { senderType: "CUSTOMER", text: "استنى — عندكم موقف؟" },
      {
        senderType: "AI",
        text: "نعم يوجد موقف مجاني للعملاء أمام المبنى.",
      },
    ],
    utterances: egy(
      "طيب نرجع للحجز — الخميس",
      "خلاص كمّل الحجز يوم الخميس",
      "المهم الحجز — ينفع الخميس؟",
    ),
    semanticLabel: semantic("TOPIC_SWITCH", "resume the earlier booking"),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    conversationState: {
      knownEntities: entities({ service: "تنظيف الأسنان", date: "الخميس" }),
      requiresMemory: true,
    },
    handoff: handoffEither("Returning to booking still routes to staff."),
    edgeCategories: ["TOPIC_RETURN", "IMPLICIT_REFERENCE"],
    difficulty: "HARD",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale:
      "Explicit return to a suspended booking — needs the earlier state.",
  }),

  // ── 19. Implicit reference: "نفس المعاد" ─────────────────────────────────
  multiTurn({
    id: "mt-implicit-same-slot",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز تنظيف الأسنان" },
      {
        senderType: "AI",
        text: "تم تسجيل ميعادك السابق: د. منى — 10:00. تحب نفس الميعاد؟",
      },
    ],
    utterances: egy(
      "اه نفس المعاد",
      "نفس الميعاد بالظبط",
      "زي المرة اللي فاتت",
    ),
    semanticLabel: semantic(
      "FOLLOW_UP",
      "resolve implicit reference to prior slot",
    ),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "AMBIGUOUS", {
      architecturalLimitation: true,
    }),
    conversationState: {
      knownEntities: entities({ timePreference: "10:00" }),
      requiresMemory: true,
    },
    handoff: handoffEither("Implicit reference needs memory."),
    edgeCategories: ["IMPLICIT_REFERENCE", "FOLLOW_UP"],
    difficulty: "EXTREME",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale:
      "'نفس المعاد' only means something with the prior offer in state.",
  }),

  // ── 20. Implicit reference: "اللي قولتلي عليه" ───────────────────────────
  multiTurn({
    id: "mt-implicit-mentioned",
    contextTurns: [
      {
        senderType: "AI",
        text: "أنصحك بخدمة تبييض الأسنان، ومتاحة يوم الخميس.",
      },
    ],
    utterances: egy(
      "طيب عايز اللي قولتلي عليه",
      "خلاص احجزلي اللي قلت عليه",
      "الخدمة اللي نصحتني بيها",
    ),
    semanticLabel: semantic(
      "FOLLOW_UP",
      "resolve reference to AI-suggested item",
    ),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "AMBIGUOUS", {
      architecturalLimitation: true,
    }),
    conversationState: {
      knownEntities: entities({ service: "تبييض الأسنان" }),
      requiresMemory: true,
    },
    handoff: handoffEither("Reference resolution needs memory."),
    edgeCategories: ["IMPLICIT_REFERENCE", "FOLLOW_UP"],
    difficulty: "EXTREME",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale: "Reference to something the AI said earlier.",
  }),

  // ── 21. "لا" after an offered option ─────────────────────────────────────
  multiTurn({
    id: "mt-no-after-offer",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز تنظيف يوم 2026-10-01" },
      AI_OFFER,
    ],
    utterances: egy(
      "لا",
      "لا مش مناسب",
      "لأ مفيش حاجة تانية؟",
      "لا أنا عايز وقت تاني",
    ),
    semanticLabel: semantic("FOLLOW_UP", "reject offer, ask for alternatives"),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "AMBIGUOUS", {
      architecturalLimitation: true,
    }),
    conversationState: { requiresMemory: true },
    handoff: handoffEither("Rejection + alternative request needs state."),
    edgeCategories: ["IMPLICIT_REFERENCE", "FOLLOW_UP"],
    difficulty: "HARD",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale: "Bare rejection after an offer — meaningful only with state.",
  }),

  // ── 22. "اه" in an ambiguous context ─────────────────────────────────────
  multiTurn({
    id: "mt-ambiguous-yes",
    contextTurns: [
      { senderType: "AI", text: "تحب أرشحلك خدمة تقويم الأسنان؟" },
    ],
    utterances: egy("اه", "اه ينفع", "ايوه"),
    semanticLabel: semantic("CONFIRMATION", "accept suggestion, continue"),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "AMBIGUOUS", {
      architecturalLimitation: true,
    }),
    conversationState: { requiresMemory: true },
    handoff: handoffEither("Affirmation bound to a prior question."),
    edgeCategories: ["IMPLICIT_REFERENCE", "CONFIRMATION"],
    difficulty: "HARD",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    mutations: [],
    rationale: "'اه' answering a yes/no question.",
  }),

  // ── 23. Customer submits multiple questions in one turn ──────────────────
  multiTurn({
    id: "mt-multi-question-one-turn",
    contextTurns: [{ senderType: "CUSTOMER", text: "مساء الخير" }],
    utterances: egy(
      "عايز أحجز، بالمناسبة بتفتحوا الساعة كام؟",
      "ممكن تقولي الأسعار وبعدين أشوف هحجز امتى",
      "عايز أحجز الخميس، بالمناسبة بتفتحوا الساعة كام؟",
      "عايز موظف بس الأول قولي هل عندكم تقويم؟",
    ),
    semanticLabel: semantic(
      "MULTI_INTENT",
      "handle both: booking + hours, or human + service info",
      ["BOOKING", "HOURS", "HUMAN_REQUEST", "SERVICE_INFO"],
    ),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    conversationState: { requiresMemory: true },
    handoff: handoffEither(
      "Multi-intent — current arch collapses to the highest-priority single intent.",
    ),
    edgeCategories: ["MULTI_INTENT", "TOPIC_SWITCH"],
    difficulty: "EXTREME",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    maxCases: 8,
    rationale:
      "Two intents in one message; the current arch loses the secondary one.",
    futureOutcome: {
      intent: "MULTI_INTENT",
      expectedBehavior: "Answer both asks and keep the booking thread.",
    },
  }),

  // ── 24. Long support conversation (5+ turns) ─────────────────────────────
  multiTurn({
    id: "mt-long-support-conversation",
    contextTurns: [
      { senderType: "CUSTOMER", text: "مساء الخير" },
      {
        senderType: "AI",
        text: "أهلاً بك!  أنا مساعدك للحجز والمواعيد — كيف يمكنني مساعدتك اليوم؟",
      },
      { senderType: "CUSTOMER", text: "عندي سؤالين" },
      { senderType: "AI", text: "اتفضل." },
      { senderType: "CUSTOMER", text: "عندكم تقويم أسنان؟" },
      {
        senderType: "AI",
        text: "نعم نوفر تقويم الأسنان للأطفال والكبار مع أخصائي متخصص.",
      },
      { senderType: "CUSTOMER", text: "وبتقبلوا تأمين؟" },
      {
        senderType: "AI",
        text: "نعم نقبل معظم شركات التأمين الطبي، يرجى إحضار بطاقتك.",
      },
      { senderType: "CUSTOMER", text: "آخر سؤال" },
      { senderType: "AI", text: "اتفضل." },
    ],
    utterances: egy(
      "هل تنظيف الأسنان مؤلم؟",
      "الحشو بياخد وقت قد إيه؟",
      "في ضمان للخدمة؟",
    ),
    semanticLabel: semantic("KNOWLEDGE_GAP", "answer if known else route"),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "NO_KNOWLEDGE", {
      fullyHandledByCurrent: true,
    }),
    conversationState: { requiresMemory: true },
    handoff: handoffEither("Unknown knowledge — handoff is acceptable."),
    edgeCategories: ["LONG_CONTEXT", "KNOWLEDGE_MISSING"],
    difficulty: "MEDIUM",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    rationale:
      "Deep in a long thread, an unanswerable question — tests context window handling.",
  }),

  // ── 25. Reschedule journey (provider offered → date change) ──────────────
  multiTurn({
    id: "mt-reschedule-journey",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أعدل ميعادي" },
      { senderType: "AI", text: "تمام — أنهي يوم يناسبك؟" },
    ],
    utterances: egy(
      "خليه يوم الأحد",
      "يوم الاتنين الصبح",
      "أي يوم الأسبوع الجاي",
    ),
    semanticLabel: semantic("RESCHEDULE", "capture new date, re-offer"),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "AMBIGUOUS", {
      architecturalLimitation: true,
    }),
    conversationState: {
      knownEntities: entities({ date: "الأحد (الموعد الجديد)" }),
      requiresMemory: true,
    },
    handoff: handoffEither("New date for a reschedule."),
    edgeCategories: ["BOOKING_JOURNEY", "PARTIAL_INFORMATION"],
    difficulty: "HARD",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale:
      "Standalone date in a reschedule context; current arch can't bind it.",
  }),

  // ── 26. Cancellation journey (confirm intent) ────────────────────────────
  multiTurn({
    id: "mt-cancellation-confirm",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز ألغي الموعد" },
      { senderType: "AI", text: "متأكد إنك عايز تلغي؟" },
    ],
    utterances: egy("اه متأكد", "تمام الغيه", "ايوه بلاش الموعد"),
    semanticLabel: semantic("CANCELLATION", "confirm cancellation"),
    currentAiExpectation: current("CANCELLATION", "booking_handoff", null, {
      fullyHandledByCurrent: false,
    }),
    conversationState: { requiresMemory: true },
    handoff: handoffEither("Cancellation confirmation."),
    edgeCategories: ["CONFIRMATION", "BOOKING_JOURNEY"],
    difficulty: "HARD",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale:
      "Confirmation of a cancellation — 'تمام الغيه' contains the cancellation word, but 'اه متأكد' alone cannot be bound.",
  }),

  // ── 27. Mixed Arabic/English mid-conversation ────────────────────────────
  multiTurn({
    id: "mt-mixed-english",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز cleaning" },
      { senderType: "AI", text: "تمام — أنهي يوم؟" },
    ],
    utterances: [
      u("book me Thursday", "ARABIC_ENGLISH"),
      u("الخميس ok؟", "ARABIC_ENGLISH"),
      u("prefer morning please", "ENGLISH"),
    ],
    semanticLabel: semantic("BOOKING", "continue booking in mixed language"),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    conversationState: {
      knownEntities: entities({ service: "cleaning" }),
      requiresMemory: true,
    },
    handoff: handoffEither("Mixed language booking."),
    edgeCategories: ["TOPIC_SWITCH", "SERVICE_NAME_ENGLISH"],
    difficulty: "HARD",
    orientation: "FUTURE_ARCHITECTURE",
    rarity: "UNCOMMON",
    businessContext: CLINIC_CONTEXT,
    mutations: [],
    rationale: "English/Arabic code-switching mid-booking.",
  }),

  // ── 28. Booking + unrelated question (adversarial-ish multi) ─────────────
  multiTurn({
    id: "mt-booking-plus-unrelated",
    contextTurns: [{ senderType: "CUSTOMER", text: "السلام عليكم" }],
    utterances: egy(
      "عايز أحجز، وعايز أعرف بتقفلوا امتى",
      "عايز أحجز وخلي بالك أنا مسافر الجمعة",
      "حجز من فضلك — وبعدين هسألك سؤال عن التأمين",
    ),
    semanticLabel: semantic("MULTI_INTENT", "booking + closing-time question", [
      "BOOKING",
      "HOURS",
    ]),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    conversationState: { requiresMemory: true },
    handoff: handoffEither("Booking wins; secondary question swallowed."),
    edgeCategories: ["MULTI_INTENT", "TOPIC_SWITCH"],
    difficulty: "EXTREME",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale: "Booking + closing time in one turn.",
  }),

  // ── 29. Availability follow-up: "أي وقت" ────────────────────────────────
  multiTurn({
    id: "mt-any-time",
    contextTurns: [{ senderType: "AI", text: "أنهي وقت يناسبك يوم الخميس؟" }],
    utterances: egy("أي وقت", "أي حاجة", "زي ما تحب", "اللي يناسبكم"),
    semanticLabel: semantic("AVAILABILITY", "pick earliest available"),
    currentAiExpectation: current("AVAILABILITY", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    conversationState: { requiresMemory: true },
    handoff: handoffEither("Indifferent customer — offer earliest."),
    edgeCategories: ["FOLLOW_UP", "AMBIGUOUS_STATE_RESOLVES"],
    difficulty: "HARD",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale: "'أي وقت' resolves only against a pending time question.",
  }),

  // ── 30. Two dates / two services in one message ──────────────────────────
  multiTurn({
    id: "mt-two-dates-two-services",
    contextTurns: [{ senderType: "CUSTOMER", text: "مساء الخير" }],
    utterances: egy(
      "عايز أحجز تنظيف الخميس وتقويم الأحد",
      "ينفع حشو النهاردة وتبييض بكرة؟",
      "عايز موعد الأحد أو الاتنين مش فارقة",
    ),
    semanticLabel: semantic("MULTI_INTENT", "disambiguate multiple bookings"),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    entities: entities({
      service: "تنظيف الأسنان",
      services: ["تقويم الأسنان"],
      date: "الخميس",
      dates: ["الأحد"],
    }),
    conversationState: { requiresMemory: false },
    handoff: handoffEither("Multiple bookings need clarification."),
    edgeCategories: ["MULTI_INTENT", "MULTIPLE_ENTITIES"],
    difficulty: "EXTREME",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    maxCases: 8,
    rationale: "Two services/two dates in one message.",
  }),

  // ── 31. Human request + normal question in one turn ──────────────────────
  multiTurn({
    id: "mt-human-plus-question",
    contextTurns: [{ senderType: "CUSTOMER", text: "مساء الخير" }],
    utterances: egy(
      "عايز أكلم موظف بس الأول قولي بتقبلوا تأمين؟",
      "وصلني بحد — وبعدين عايز أعرف ساعات العمل",
      "عايز موظف ولو عندكم تقويم قولي",
    ),
    semanticLabel: semantic(
      "HUMAN_REQUEST",
      "hand off, but answer the simple question first if possible",
      ["FAQ", "SERVICE_INFO"],
    ),
    currentAiExpectation: current("HUMAN_REQUEST", "handoff", "HUMAN_REQUEST", {
      fullyHandledByCurrent: false,
    }),
    handoff: handoffRequired(
      "HUMAN_REQUEST",
      "Explicit human request must be honored even with an extra question.",
    ),
    conversationState: { requiresMemory: false },
    edgeCategories: ["MULTI_INTENT", "HANDOFF_EXPLICIT"],
    difficulty: "HARD",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale:
      "Human request + question: current arch hands off entirely and the question is lost.",
  }),

  // ── 32. Sensitive + normal question ──────────────────────────────────────
  multiTurn({
    id: "mt-sensitive-plus-question",
    contextTurns: [{ senderType: "CUSTOMER", text: "السلام عليكم" }],
    utterances: egy(
      "عندي ألم شديد — بالمناسبة التبييض بيوجع؟",
      "في تورم، وعايز أعرف بكام التنظيف",
    ),
    semanticLabel: semantic(
      "HUMAN_REQUEST",
      "escalate sensitive, ignore price for now",
      ["SERVICE_PRICE"],
    ),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "SENSITIVE", {
      fullyHandledByCurrent: false,
    }),
    handoff: handoffRequired("SENSITIVE", "Medical/high-risk takes priority."),
    conversationState: { requiresMemory: false },
    edgeCategories: ["HANDOFF_SENSITIVE", "MULTI_INTENT"],
    difficulty: "EXTREME",
    rarity: "RARE",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale: "Sensitive + question; sensitivity must win.",
  }),

  // ── 33. Customer sends emoji-only / punctuation-only ─────────────────────
  multiTurn({
    id: "mt-emoji-only",
    contextTurns: [{ senderType: "CUSTOMER", text: "عايز أحجز تنظيف" }],
    utterances: [
      u("🙂", "EGYPTIAN_COLLOQUIAL", ["EMOJI"]),
      u("؟؟؟", "EGYPTIAN_COLLOQUIAL", ["INFORMAL_PUNCTUATION"]),
      u("...", "EGYPTIAN_COLLOQUIAL", ["INFORMAL_PUNCTUATION"]),
      u("م", "EGYPTIAN_COLLOQUIAL", ["VERY_SHORT"]),
    ],
    semanticLabel: semantic("CLARIFICATION_REQUIRED", "ask what they need"),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "AMBIGUOUS", {
      fullyHandledByCurrent: true,
    }),
    conversationState: { requiresMemory: true },
    handoff: handoffEither("Contentless turn — clarify or hand off."),
    edgeCategories: ["ADVERSARIAL", "AMBIGUOUS_CLARIFIABLE"],
    difficulty: "MEDIUM",
    mutations: [],
    rationale: "Non-linguistic turns must never be guessed.",
  }),

  // ── 34. Repeated contradictory information ───────────────────────────────
  multiTurn({
    id: "mt-contradiction",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز يوم الخميس" },
      { senderType: "AI", text: "تمام الخميس." },
      { senderType: "CUSTOMER", text: "لا الجمعة أحسن" },
      { senderType: "AI", text: "تمام الجمعة." },
      { senderType: "CUSTOMER", text: "لا أرجع الخميس" },
    ],
    utterances: egy(
      "لا خلاص الجمعة",
      "أنا مش قادر أقرر — خليها الجمعة",
      "الخميس خلاص مش هغير",
    ),
    semanticLabel: semantic(
      "BOOKING",
      "resolve latest contradictory preference",
    ),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    conversationState: { requiresMemory: true },
    handoff: handoffEither("Latest stated date wins or staff takes over."),
    edgeCategories: ["CONTRADICTION", "SELF_CORRECTION"],
    difficulty: "EXTREME",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale: "Flip-flopping dates across turns.",
  }),

  // ── 35. Greeting + booking in the SAME message ───────────────────────────
  multiTurn({
    id: "mt-greeting-plus-booking",
    contextTurns: [{ senderType: "CUSTOMER", text: "صباح الخير، عايز أحجز" }],
    utterances: egy(
      "السلام عليكم، عايز أحجز تنظيف",
      "ازيك — عايز ميعاد بكرة",
      "مساء الخير، ممكن أحجز؟",
    ),
    semanticLabel: semantic(
      "BOOKING",
      "acknowledge greeting AND start booking",
    ),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    conversationState: { requiresMemory: false },
    handoff: handoffEither("Greeting must not swallow booking."),
    edgeCategories: ["MULTI_INTENT", "BOOKING_JOURNEY"],
    difficulty: "MEDIUM",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    rationale:
      "Greeting+booking in one turn — booking must win (isPureGreeting disqualification).",
  }),

  // ── 36. Human request + sensitive blend ──────────────────────────────────
  multiTurn({
    id: "mt-human-sensitive-blend",
    contextTurns: [{ senderType: "CUSTOMER", text: "مساء الخير" }],
    utterances: egy(
      "عايز أكلم المدير عندي شكوى",
      "عايز أتكلم مع حد مسؤول في مشكلة",
      "الشكوى دي محتاجة حد كبير",
    ),
    semanticLabel: semantic("HUMAN_REQUEST", "escalate to a human (sensitive)"),
    currentAiExpectation: current("HUMAN_REQUEST", "handoff", "HUMAN_REQUEST", {
      fullyHandledByCurrent: true,
    }),
    handoff: handoffRequired(
      "HUMAN_REQUEST",
      "Explicit manager/complaint request.",
    ),
    conversationState: { requiresMemory: false },
    edgeCategories: ["HANDOFF_EXPLICIT", "HANDOFF_SENSITIVE"],
    difficulty: "MEDIUM",
    rarity: "UNCOMMON",
    mutations: ["MISSING_HAMZA"],
    rationale: "Human request phrased as a complaint.",
  }),

  // ── 37. Booking after a completed FAQ answer ─────────────────────────────
  multiTurn({
    id: "mt-faq-then-booking",
    contextTurns: [
      { senderType: "CUSTOMER", text: "بتقبلوا تأمين؟" },
      {
        senderType: "AI",
        text: "نعم نقبل معظم شركات التأمين الطبي، يرجى إحضار بطاقتك.",
      },
    ],
    utterances: egy(
      "تمام — طيب عايز أحجز",
      "شكراً، وعايز أحجز موعد",
      "ماشي — أحجزلي بكرة",
    ),
    semanticLabel: semantic("BOOKING", "convert FAQ satisfaction into booking"),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    conversationState: { requiresMemory: true },
    handoff: handoffEither("Booking routed to staff by design."),
    edgeCategories: ["FOLLOW_UP", "BOOKING_JOURNEY"],
    difficulty: "MEDIUM",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale: "Natural FAQ→booking conversion.",
  }),

  // ── 38. Arabic-Indic digits & colloquial time ────────────────────────────
  multiTurn({
    id: "mt-arabic-indic-time",
    contextTurns: [
      { senderType: "AI", text: "أنهي وقت يناسبك يوم 2026-10-01؟" },
    ],
    utterances: egy("الساعة ١١", "١١ ونص", "بعد الضهر على طول"),
    semanticLabel: semantic("BOOKING", "capture Arabic-Indic time"),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    conversationState: { requiresMemory: true },
    handoff: handoffEither("Time selection in Arabic-Indic digits."),
    edgeCategories: ["BOOKING_JOURNEY", "PARTIAL_INFORMATION"],
    difficulty: "MEDIUM",
    businessContext: CLINIC_CONTEXT,
    mutations: ["DROP_PUNCTUATION"],
    rationale: "Arabic-Indic numeral time input.",
  }),

  // ── 39. Returning customer with prior booking reference ──────────────────
  multiTurn({
    id: "mt-returning-customer",
    contextTurns: [
      { senderType: "CUSTOMER", text: "مساء الخير، أنا كنت عندكم قبل كده" },
      {
        senderType: "AI",
        text: "أهلاً بك!  أنا مساعدك للحجز والمواعيد — كيف يمكنني مساعدتك اليوم؟",
      },
    ],
    utterances: egy(
      "عايز أحجز تاني",
      "نفس الدكتور اللي قبل كده",
      "عايز أعيد نفس التجربة",
    ),
    semanticLabel: semantic(
      "FOLLOW_UP",
      "recognize returning customer context",
    ),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    conversationState: { requiresMemory: true },
    handoff: handoffEither(
      "Returning context needs history beyond the window.",
    ),
    edgeCategories: ["IMPLICIT_REFERENCE", "FOLLOW_UP"],
    difficulty: "EXTREME",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale: "Reference to a PREVIOUS relationship, not this thread.",
  }),

  // ── 40. Long conversation with topic drift and return ────────────────────
  multiTurn({
    id: "mt-long-drift",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز تنظيف" },
      { senderType: "AI", text: "تمام — أنهي يوم؟" },
      { senderType: "CUSTOMER", text: "الخميس" },
      { senderType: "AI", text: "طيب — الصبح ولا بعد الضهر؟" },
      { senderType: "CUSTOMER", text: "الصبح" },
      { senderType: "AI", text: "تم." },
      { senderType: "CUSTOMER", text: "بالمناسبة عندكم موقف؟" },
      {
        senderType: "AI",
        text: "نعم يوجد موقف مجاني للعملاء أمام المبنى.",
      },
      { senderType: "CUSTOMER", text: "شكراً" },
      { senderType: "AI", text: "العفو." },
      { senderType: "CUSTOMER", text: "آه نسيت — ينفع مع د. منى؟" },
    ],
    utterances: egy(
      "آه نسيت — ينفع مع د. منى؟",
      "على فكرة عايز مع د. منى",
      "ينفع أغير الدكتور لمنى؟",
    ),
    semanticLabel: semantic(
      "BOOKING",
      "late provider preference on existing booking",
    ),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    conversationState: {
      knownEntities: entities({
        service: "تنظيف الأسنان",
        date: "الخميس",
        timePreference: "الصبح",
        provider: "د. منى",
      }),
      requiresMemory: true,
    },
    handoff: handoffEither("Late constraint addition on an in-flight booking."),
    edgeCategories: ["LONG_CONTEXT", "TOPIC_RETURN", "PARTIAL_INFORMATION"],
    difficulty: "EXTREME",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale:
      "Deep context (12 messages) with a late provider constraint — tests the 20-message window and memory.",
  }),

  // ── 41. Customer provides contact details when asked ─────────────────────
  multiTurn({
    id: "mt-provides-name",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز" },
      { senderType: "AI", text: "تمام — ممكن الاسم؟" },
    ],
    utterances: egy(
      "أحمد محمد",
      "انا اسمي سارة",
      "محمود عبد الله",
      "اسمي كريم وعندي رقم",
    ),
    semanticLabel: semantic("BOOKING", "store identity, continue booking"),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "AMBIGUOUS", {
      architecturalLimitation: true,
    }),
    conversationState: { requiresMemory: true },
    handoff: handoffEither("Free-text identity turn is not a booking keyword."),
    edgeCategories: ["PARTIAL_INFORMATION", "BOOKING_JOURNEY"],
    difficulty: "MEDIUM",
    businessContext: CLINIC_CONTEXT,
    mutations: [],
    rationale: "Name/identity provision mid-booking.",
  }),

  // ── 42. Customer asks whether the message was received ───────────────────
  multiTurn({
    id: "mt-delivery-check",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز تنظيف الأسنان" },
      { senderType: "AI", text: "تمام — أنهي يوم يناسبك؟" },
      { senderType: "CUSTOMER", text: "الخميس" },
    ],
    utterances: egy(
      "وصلت الرسالة؟",
      "أنت هنا؟",
      "محتاج رد لو سمحت",
      "في حد معايا؟",
    ),
    semanticLabel: semantic("FOLLOW_UP", "acknowledge presence, repeat ask"),
    currentAiExpectation: current("HUMAN_REQUEST", "handoff", "HUMAN_REQUEST", {
      architecturalLimitation: true,
    }),
    conversationState: { requiresMemory: true },
    handoff: handoffEither(
      "'في حد معايا' hits the human-word table → handoff.",
    ),
    edgeCategories: ["FOLLOW_UP", "HANDOFF_EXPLICIT"],
    difficulty: "MEDIUM",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale:
      "Delivery/presence checks — 'معايا حد' is a human-request phrase and triggers an unnecessary handoff.",
  }),

  // ── 43. Availability then immediate booking intent ───────────────────────
  multiTurn({
    id: "mt-availability-then-booking",
    contextTurns: [
      { senderType: "CUSTOMER", text: "إيه الأوقات المتاحة بكرة؟" },
      {
        senderType: "AI",
        text: "شكراً لسؤالك — سيرسل لك أحد أعضاء الفريق الأوقات المتاحة قريباً.",
      },
    ],
    utterances: egy(
      "طيب عايز أحجز أول معاد",
      "ماشي أحجزلي اللي يناسبكم",
      "تمام — احجزلي بكرة",
    ),
    semanticLabel: semantic(
      "BOOKING",
      "convert availability answer into booking",
    ),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    conversationState: { requiresMemory: true },
    handoff: handoffEither("Booking routed to staff by design."),
    edgeCategories: ["FOLLOW_UP", "BOOKING_JOURNEY"],
    difficulty: "MEDIUM",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale: "Availability → booking conversion.",
  }),

  // ── 44. FAQ then unrelated FAQ (topic chain) ─────────────────────────────
  multiTurn({
    id: "mt-faq-chain",
    contextTurns: [
      { senderType: "CUSTOMER", text: "ما هي ساعات العمل؟" },
      {
        senderType: "AI",
        text: "نعمل يومياً من 10 صباحاً حتى 8 مساءً ما عدا الجمعة.",
      },
    ],
    utterances: egy(
      "طيب هل تقبلون التأمين؟",
      "تمام — وبالنسبة للمواقف؟",
      "شكراً، وعنوانكم فين؟",
    ),
    semanticLabel: semantic("FAQ", "answer the next knowledge question"),
    currentAiExpectation: current("FAQ", "reply", null, {
      fullyHandledByCurrent: true,
    }),
    knowledgeRequirement: "EXACT_FAQ",
    conversationState: { requiresMemory: true },
    handoff: handoffNotRequired("Answerable from the store."),
    edgeCategories: ["FOLLOW_UP", "KNOWLEDGE_EXACT"],
    difficulty: "EASY",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    rationale: "A chain of distinct FAQ asks.",
  }),

  // ── 45. Customer asks about a second service after booking one ───────────
  multiTurn({
    id: "mt-second-service",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز تنظيف الأسنان" },
      { senderType: "AI", text: "تمام — أنهي يوم يناسبك؟" },
    ],
    utterances: egy(
      "وبعدين عايز أحجز تبييض كمان",
      "وأي خدمة تانية متاحة؟",
      "عايز أعرف الخدمات التانية كمان",
    ),
    semanticLabel: semantic(
      "SERVICE_DISCOVERY",
      "list other services / second booking",
      ["BOOKING", "SERVICE_INFO"],
    ),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    conversationState: { requiresMemory: true },
    handoff: handoffEither("Second-service ask has no dedicated intent."),
    edgeCategories: ["FOLLOW_UP", "KNOWLEDGE_NOT_EXPOSED"],
    difficulty: "HARD",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale: "Follow-on service discovery after an active booking.",
  }),

  // ── 46. Booking confirmed, then customer reopens ─────────────────────────
  multiTurn({
    id: "mt-post-confirmation-reopen",
    contextTurns: [
      {
        senderType: "CUSTOMER",
        text: "عايز أحجز تنظيف الأسنان يوم 2026-10-01",
      },
      AI_OFFER,
      { senderType: "CUSTOMER", text: "١" },
      {
        senderType: "AI",
        text: 'تم تأكيد حجزك لخدمة "تنظيف الأسنان" يوم 2026-10-01 من 10:00 إلى 10:30 مع د. منى.',
      },
    ],
    utterances: egy(
      "طيب ممكن أعدله بعدين؟",
      "لو حبيت ألغيه أعمل ايه؟",
      "الميعاد ده ثابت ولا ممكن أغيره؟",
    ),
    semanticLabel: semantic("RESCHEDULE", "post-booking mutation intent"),
    currentAiExpectation: current("RESCHEDULE", "booking_handoff", null, {
      fullyHandledByCurrent: false,
    }),
    conversationState: {
      knownEntities: entities({
        service: "تنظيف الأسنان",
        date: "2026-10-01",
        timePreference: "10:00",
      }),
      requiresMemory: true,
      expectedStatus: "BOOKED",
    },
    handoff: handoffEither("Post-confirmation change is a staff mutation."),
    edgeCategories: ["CONFIRMATION", "BOOKING_JOURNEY"],
    difficulty: "HARD",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale: "Reopening a BOOKED thread for reschedule/cancellation.",
  }),

  // ── 47. Long monologue turn inside a long conversation ───────────────────
  multiTurn({
    id: "mt-long-monologue",
    contextTurns: [
      { senderType: "CUSTOMER", text: "السلام عليكم" },
      {
        senderType: "AI",
        text: "أهلاً بك!  أنا مساعدك للحجز والمواعيد — كيف يمكنني مساعدتك اليوم؟",
      },
      { senderType: "CUSTOMER", text: "عندي قصة طويلة" },
      { senderType: "AI", text: "اتفضل." },
      { senderType: "CUSTOMER", text: "أنا جيت قبل كده وعملت تنظيف" },
      { senderType: "AI", text: "تمام." },
    ],
    utterances: egy(
      "و بعدين الدكتور قالي محتاج تبييض فأنا عايز أعرف التكلفة ومدة الجلسة وهل ينفع أعمله في نفس اليوم ولا لأ",
      "المهم أنا عايز أحجز تبييض بس مش عارف الأسعار غالية ولا رخيصة وكل واحد بيقولي حاجة",
      "يعني الخلاصة عايز موعد للتبييض يوم ما يناسبني الصبح لو ينفع وشكراً مقدماً على سعت الصدر",
    ),
    semanticLabel: semantic(
      "MULTI_INTENT",
      "book whitening + price + duration question",
      ["BOOKING", "SERVICE_PRICE", "SERVICE_INFO"],
    ),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    conversationState: { requiresMemory: true },
    handoff: handoffEither("Long monologue collapses to one intent."),
    edgeCategories: ["LONG_CONTEXT", "MULTI_INTENT"],
    difficulty: "EXTREME",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    mutations: ["DROP_PUNCTUATION"],
    maxCases: 6,
    rationale:
      "A 200+ character monologue with 3 intents; only the booking keyword survives.",
  }),

  // ── 48. Customer corrects provider name after AI echo ────────────────────
  multiTurn({
    id: "mt-provider-name-echo",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز مع الدكتور منى" },
      { senderType: "AI", text: "تمام — د. منى. أنهي يوم يناسبك؟" },
    ],
    utterances: egy(
      "لا مش منى — د. أحمد",
      "قصدي الدكتورة سارة",
      "لا الدكتور التاني",
    ),
    semanticLabel: semantic("BOOKING", "correct provider in active booking"),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    conversationState: { requiresMemory: true },
    handoff: handoffEither("Provider correction mid-booking."),
    edgeCategories: ["SELF_CORRECTION", "BOOKING_JOURNEY"],
    difficulty: "HARD",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale: "Provider-name correction after the AI echoed the wrong one.",
  }),

  // ── 49. Customer answers only part of the question ───────────────────────
  multiTurn({
    id: "mt-partial-answer",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز تنظيف" },
      {
        senderType: "AI",
        text: "تمام — يوم كام الساعة كام؟",
      },
    ],
    utterances: egy("الخميس", "الساعة 12", "أي يوم"),
    semanticLabel: semantic(
      "BOOKING",
      "store partial answer, ask for the rest",
    ),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "AMBIGUOUS", {
      architecturalLimitation: true,
    }),
    conversationState: { requiresMemory: true },
    handoff: handoffEither("One of two requested fields — needs state."),
    edgeCategories: ["PARTIAL_INFORMATION", "AMBIGUOUS_STATE_RESOLVES"],
    difficulty: "HARD",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale: "Answers only the date or only the time of a two-part ask.",
  }),

  // ── 50. Customer asks the same FAQ again later (memory of answers) ───────
  multiTurn({
    id: "mt-repeat-faq",
    contextTurns: [
      { senderType: "CUSTOMER", text: "ما هي ساعات العمل؟" },
      {
        senderType: "AI",
        text: "نعمل يومياً من 10 صباحاً حتى 8 مساءً ما عدا الجمعة.",
      },
      { senderType: "CUSTOMER", text: "شكراً" },
      { senderType: "AI", text: "العفو." },
    ],
    utterances: egy(
      "تفتكر بتفتحوا امتى؟",
      "نسيت — ساعات العمل ايه تاني؟",
      "ممكن تعيدلي أوقات العمل",
    ),
    semanticLabel: semantic("FOLLOW_UP", "repeat the earlier answer"),
    currentAiExpectation: current("FAQ", "reply", null, {
      fullyHandledByCurrent: true,
    }),
    knowledgeRequirement: "EXACT_FAQ",
    conversationState: { requiresMemory: true },
    handoff: handoffNotRequired("Re-answering from the store is free."),
    edgeCategories: ["REPETITION", "KNOWLEDGE_EXACT"],
    difficulty: "EASY",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale: "Repeated FAQ — should answer again, not escalate.",
  }),

  // ── 51. Bot-identity question (false human handoff trigger) ──────────────
  multiTurn({
    id: "mt-bot-identity-question",
    contextTurns: [{ senderType: "CUSTOMER", text: "السلام عليكم" }],
    utterances: egy(
      "إنت إنسان ولا روبوت؟",
      "أنا بتكلم مع حد حقيقي؟",
      "إنتي بوت ولا موظف؟",
      "مين بيرد عليا؟",
    ),
    semanticLabel: semantic(
      "FAQ",
      "answer identity honestly without escalation",
    ),
    currentAiExpectation: current("HUMAN_REQUEST", "handoff", "HUMAN_REQUEST", {
      fullyHandledByCurrent: false,
    }),
    handoff: handoffNotRequired(
      "An identity question mentioning 'إنسان'/'موظف' triggers the human-word table — an UNNECESSARY handoff.",
    ),
    knowledgeRequirement: "NONE",
    edgeCategories: ["HANDOFF_UNNECESSARY_RISK", "ADVERSARIAL"],
    difficulty: "HARD",
    orientation: "FUTURE_ARCHITECTURE",
    rarity: "UNCOMMON",
    mutations: ["MISSING_HAMZA"],
    rationale:
      "The customer is asking ABOUT the assistant, not FOR a human — evidence for the unnecessary-handoff metric.",
  }),

  // ── 52. Booking for a third party ────────────────────────────────────────
  multiTurn({
    id: "mt-third-party-booking",
    contextTurns: [{ senderType: "CUSTOMER", text: "السلام عليكم" }],
    utterances: egy(
      "عايز أحجز لوالدي تنظيف أسنان",
      "محتاج ميعاد لابني الصغير",
      "عايزة أحجز لمراتي تقويم",
      "الحجز مش لي — لأختي",
    ),
    semanticLabel: semantic("BOOKING", "book for another person"),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    conversationState: { requiresMemory: false },
    handoff: handoffEither("Third-party booking still routes to staff."),
    edgeCategories: ["BOOKING_JOURNEY", "PARTIAL_INFORMATION"],
    difficulty: "MEDIUM",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale:
      "Booking on behalf of a relative — the named person is not the customer.",
  }),

  // ── 53. Payment-methods knowledge gap ────────────────────────────────────
  multiTurn({
    id: "mt-payment-methods",
    contextTurns: [
      { senderType: "CUSTOMER", text: "أنا عايز أحجز" },
      AI_ASK_SERVICE,
    ],
    utterances: egy(
      "بتقبلوا فيزا ولا كاش؟",
      "الدفع كاش ولا بطاقة؟",
      "ممكن أدفع بالفيزا؟",
      "عندكم دفع إلكتروني؟",
    ),
    semanticLabel: semantic("SERVICE_INFO", "answer payment options"),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "NO_KNOWLEDGE", {
      fullyHandledByCurrent: true,
    }),
    knowledgeRequirement: "NOT_PRESENT",
    conversationState: { requiresMemory: true },
    handoff: handoffEither("No payment knowledge — handoff is correct."),
    edgeCategories: ["KNOWLEDGE_MISSING", "FOLLOW_UP"],
    difficulty: "MEDIUM",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale: "Payment-method knowledge is absent from the store.",
  }),

  // ── 54. Holiday / special-hours question ─────────────────────────────────
  multiTurn({
    id: "mt-holiday-hours",
    contextTurns: [{ senderType: "CUSTOMER", text: "مساء الخير" }],
    utterances: egy(
      "بتفتحوا في رمضان إمتى؟",
      "أيام العيد عندكم شغل؟",
      "في الإجازة بتفتحوا؟",
      "رمضان أوقاتكم بتتغير؟",
    ),
    semanticLabel: semantic("HOURS", "answer holiday hours"),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "NO_KNOWLEDGE", {
      architecturalLimitation: true,
    }),
    knowledgeRequirement: "NOT_PRESENT",
    conversationState: { requiresMemory: false },
    handoff: handoffEither("No holiday-hours knowledge exists in the store."),
    edgeCategories: ["KNOWLEDGE_MISSING", "KNOWLEDGE_NOT_EXPOSED"],
    difficulty: "HARD",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale: "Seasonal hours — a knowledge gap the store does not cover.",
  }),

  // ── 55. Compliment then ask (sensitive-word false positive risk) ─────────
  multiTurn({
    id: "mt-compliment-then-ask",
    contextTurns: [{ senderType: "CUSTOMER", text: "السلام عليكم" }],
    utterances: egy(
      "أنت رائع — بس عندي سؤال، السعر كام؟",
      "خدمة ممتازة منكم — التبييض متاح امتى؟",
      "أنا سعيد جداً بالخدمة وعايز أحجز تاني",
    ),
    semanticLabel: semantic(
      "BOOKING",
      "handle praise + continue the real intent",
    ),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    conversationState: { requiresMemory: false },
    handoff: handoffEither("Praise + booking still routes to staff."),
    edgeCategories: ["MULTI_INTENT", "BOOKING_JOURNEY"],
    difficulty: "MEDIUM",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale: "Social praise must not be read as a sensitive complaint.",
  }),

  // ── 56. Off-topic / small talk with no service intent ────────────────────
  multiTurn({
    id: "mt-off-topic",
    contextTurns: [{ senderType: "CUSTOMER", text: "السلام عليكم" }],
    utterances: egy(
      "إيه أخبار الدنيا؟",
      "الجو حلو النهاردة",
      "تعرف نتيجة الماتش امبارح؟",
    ),
    semanticLabel: semantic("AMBIGUOUS", "steer back or hand off politely"),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "AMBIGUOUS", {
      fullyHandledByCurrent: true,
    }),
    conversationState: { requiresMemory: false },
    handoff: handoffEither("Off-domain small talk — handoff acceptable."),
    edgeCategories: ["TOPIC_SWITCH", "ADVERSARIAL"],
    difficulty: "EASY",
    mutations: ["MISSING_HAMZA"],
    rationale: "Completely off-domain turns must never be fabricated.",
  }),

  // ── 57. Waitlist / earliest-slot request ─────────────────────────────────
  multiTurn({
    id: "mt-waitlist-earliest",
    contextTurns: [
      { senderType: "CUSTOMER", text: "الأسبوع ده مفيش حاجة فاضية؟" },
      { senderType: "AI", text: "للأسف كل المواعيد محجوزة." },
    ],
    utterances: egy(
      "طيب حطني في لستة الانتظار",
      "لو حصل إلغاء كلموني",
      "أقرب موعد متاح امتى؟",
      "ماشي — أقرب حاجة عندكم",
    ),
    semanticLabel: semantic(
      "AVAILABILITY",
      "capture waitlist / find earliest slot",
    ),
    currentAiExpectation: current("AVAILABILITY", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    conversationState: { requiresMemory: true },
    handoff: handoffEither("Waitlist has no current-arch capability."),
    edgeCategories: ["BOOKING_FAILURE", "FOLLOW_UP"],
    difficulty: "HARD",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale: "Post-saturation recovery — waitlist/earliest-slot behaviour.",
  }),

  // ── 58. Reminder / notification preference ──────────────────────────────
  multiTurn({
    id: "mt-reminder-preference",
    contextTurns: [
      { senderType: "CUSTOMER", text: "الحجز اتبعت؟" },
      { senderType: "AI", text: "تم." },
    ],
    utterances: egy(
      "بعتولي تذكير قبل الميعاد",
      "كلموني قبل الموعد بساعة",
      "محتاج ريميندر",
      "نبهوني قبل المعاد",
    ),
    semanticLabel: semantic("FOLLOW_UP", "acknowledge reminder preference"),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "AMBIGUOUS", {
      architecturalLimitation: true,
    }),
    conversationState: { requiresMemory: true },
    handoff: handoffEither("Reminders are an unmodeled capability."),
    edgeCategories: ["FOLLOW_UP", "KNOWLEDGE_NOT_EXPOSED"],
    difficulty: "HARD",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale: "Reminder preferences have no intent representation.",
  }),

  // ── 59. Recap request mid-conversation ───────────────────────────────────
  multiTurn({
    id: "mt-recap-request",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز تنظيف" },
      { senderType: "AI", text: "تمام — أنهي يوم؟" },
      { senderType: "CUSTOMER", text: "الخميس" },
      { senderType: "AI", text: "طيب — الصبح ولا بعد الضهر؟" },
    ],
    utterances: egy(
      "اكتبلي اللي اتافق عليه لحد دلوقتي",
      "لخصلي اللي قلناه",
      "فين وصلنا في الحجز",
      "ذكرني اتفقنا على ايه",
    ),
    semanticLabel: semantic("FOLLOW_UP", "recap the conversation state"),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "AMBIGUOUS", {
      architecturalLimitation: true,
    }),
    conversationState: {
      knownEntities: entities({ service: "تنظيف الأسنان", date: "الخميس" }),
      requiresMemory: true,
    },
    handoff: handoffNotRequired(
      "A recap is a state read — currently escalated because no state is held.",
    ),
    edgeCategories: ["IMPLICIT_REFERENCE", "FOLLOW_UP"],
    difficulty: "EXTREME",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale:
      "Conversation-state summarization — impossible without held state.",
  }),

  // ── 60. Location ask injected into a booking flow ────────────────────────
  multiTurn({
    id: "mt-location-in-booking",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز تنظيف يوم الخميس" },
      { senderType: "AI", text: "تمام — الصبح ولا بعد الضهر؟" },
    ],
    utterances: egy(
      "العيادة فين بالمناسبة؟",
      "أود أعرف العنوان الأول",
      "قبل ما أحدد — انتوا فين؟",
    ),
    semanticLabel: semantic("TOPIC_SWITCH", "answer location then resume"),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "NO_KNOWLEDGE", {
      architecturalLimitation: true,
    }),
    knowledgeRequirement: "PARAPHRASED_FAQ",
    conversationState: { requiresMemory: true },
    handoff: handoffNotRequired(
      "Location FAQ exists; colloquial phrasing likely misses the matcher.",
    ),
    edgeCategories: ["TOPIC_SWITCH", "KNOWLEDGE_PARAPHRASE"],
    difficulty: "HARD",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale:
      "Location question mid-booking; current arch drops both threads.",
  }),

  // ── 61. "وبعدين?" — open-ended continuation prompt ──────────────────────
  multiTurn({
    id: "mt-open-continuation",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز" },
      AI_ASK_SERVICE,
    ],
    utterances: egy("وبعدين؟", "ثم؟", "اكمل", "نعم وكمل"),
    semanticLabel: semantic(
      "FOLLOW_UP",
      "prompt continuation without new content",
    ),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "AMBIGUOUS", {
      fullyHandledByCurrent: true,
    }),
    conversationState: { requiresMemory: true },
    handoff: handoffEither("Empty continuation prompt — no new information."),
    edgeCategories: ["FOLLOW_UP", "AMBIGUOUS_CLARIFIABLE"],
    difficulty: "MEDIUM",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale: "Customer pushing the conversation forward with no payload.",
  }),
];

void AI_ASK_DATE;
void handoffNotRequired;
