/**
 * FlowPilot AI Evaluation — egyptian-v1 MULTI-INTENT scenarios
 * (PROMPT-AI-EVAL-02).
 *
 * Turns carrying MORE THAN ONE goal. The semantic truth records the PRIMARY
 * goal (what the turn is scored on), the SECONDARY goals in priority order,
 * the ideal next action, and whether a human is genuinely required.
 *
 * The binding rule for this bank: a multi-intent turn is NOT automatically a
 * handoff. The canonical weakness — "عايز أحجز، إيه الخدمات عندكم؟" — is a
 * SERVICE_DISCOVERY turn with a BOOKING rider whose ground truth handoff is
 * NOT_REQUIRED: a competent assistant lists the catalog itself and the
 * booking continues. Only the scenarios that genuinely need a human say so.
 *
 * Every scenario populates the extended ground-truth blocks
 * (`customerBehavior`, `expectedDomainAction`, `futureArchitectureExpectation`,
 * `knowledgeSourceAssertion`) — the axes `egyptian-v1` v1.0 left unpopulated.
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
  singleTurn,
  u,
} from "./scenario-builders";
import { CLINIC_CONTEXT, EMPTY_KNOWLEDGE_CONTEXT } from "./shared-context";

/** A compact prior AI offer shared by the multi-intent journeys. */
const AI_OFFER = {
  senderType: "AI" as const,
  text: 'تتوفر المواعيد التالية لخدمة "تنظيف الأسنان" يوم 2026-10-01:\n1. د. منى — 10:00 إلى 10:30\n2. د. منى — 12:00 إلى 12:30\nيرجى اختيار أحد الخيارات.',
};

export const multiIntentScenarios: Scenario[] = [
  // ── The canonical weakness: booking intent + service discovery ──────────────
  // The current architecture sees a booking word and routes to staff; the
  // customer's real question ("what do you even offer?") is never answered.
  // Ground truth: SERVICE_DISCOVERY primary, BOOKING secondary, NO handoff.
  singleTurn({
    id: "mi-booking-plus-discovery",
    utterances: [
      ...egy(
        "عايز أحجز، إيه الخدمات اللي عندكم؟",
        "عايز أحجز ايه الخدمات اللي موجودة عندكم؟",
        "قبل ما أحجز قولي الخدمات الموجودة",
        "ممكن أعرف الخدمات وبعدين أحجز",
        "عايز أحجز حاجة، عندكم ايه؟",
        "عايز أحجز، بس الأول ايه اللي بتعملوه؟",
      ),
      u("3ayez a7gez, eih el services 3andoko?", "ARABIZI"),
      u("عايز أحجز cleaning — عندكم ايه services؟", "ARABIC_ENGLISH", [
        "MIXED_LANGUAGE",
      ]),
    ],
    semanticLabel: semantic(
      "SERVICE_DISCOVERY",
      "list the services first, then continue the booking",
      ["BOOKING"],
    ),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    handoff: handoffNotRequired(
      "The catalog is available to the assistant; a handoff for 'what do you offer' is an unnecessary handoff.",
    ),
    knowledgeRequirement: "SERVICE_CATALOG",
    knowledgeSourceAssertion: {
      source: "SERVICE_CATALOG",
      currentChannel: "services",
    },
    edgeCategories: ["MULTI_INTENT", "UNNECESSARY_HANDOFF", "BOOKING_JOURNEY"],
    difficulty: "HARD",
    rarity: "COMMON",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["CURIOUS", "CLEAR"],
      changeOfState: "NONE",
    },
    expectedDomainAction: "REPLY_FROM_KNOWLEDGE",
    futureArchitectureExpectation: {
      expectSelfService: true,
      expectClarification: false,
      expectKnowledgeLookup: true,
      expectConfirmation: false,
      expectKnowledgeGapRecorded: false,
    },
    futureOutcome: {
      intent: "SERVICE_DISCOVERY",
      expectedBehavior:
        "Answer the catalog question from the service list, then ask for the booking date.",
    },
    mutations: [
      "MISSING_HAMZA",
      "DROP_PUNCTUATION",
      "SPELLING_VARIATION",
      "KEYBOARD_MISTAKE",
    ],
    maxCases: 20,
    rationale:
      "The known FlowPilot weakness: a booking word triggers booking_handoff while the customer's actual question (the service catalog) is never answered. Secondary intent is BOOKING so a future system is credited for continuing the journey after answering.",
  }),

  // ── Booking + price (price knowledge has NO channel today) ──────────────────
  singleTurn({
    id: "mi-booking-plus-price",
    utterances: [
      ...egy(
        "عايز أحجز تنظيف، والتقويم بكام؟",
        "عايز أحجز — بس الأول التنظيف بكام؟",
        "ممكن أعرف سعر التنظيف وأحجز بعدين؟",
        "حجز تنظيف أسنان، وسعره كام؟",
      ),
      u("عايز أحجز التنظيف، price كام؟", "ARABIC_ENGLISH", ["MIXED_LANGUAGE"]),
    ],
    semanticLabel: semantic(
      "SERVICE_PRICE",
      "state the price honestly, then continue booking",
      ["BOOKING"],
    ),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    handoff: handoffEither(
      "Price has no AiRequest channel today; routing to staff to quote is defensible but so is answering from a price list.",
    ),
    knowledgeRequirement: "KNOWLEDGE_GAP",
    knowledgeSourceAssertion: { source: "PRICE_LIST", currentChannel: "NONE" },
    edgeCategories: ["MULTI_INTENT", "KNOWLEDGE_GAP", "BOOKING_JOURNEY"],
    difficulty: "HARD",
    rarity: "COMMON",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["CURIOUS", "CLEAR"],
      changeOfState: "NONE",
    },
    expectedDomainAction: "REPLY_FROM_KNOWLEDGE",
    futureArchitectureExpectation: {
      expectSelfService: true,
      expectClarification: false,
      expectKnowledgeLookup: true,
      expectConfirmation: false,
      expectKnowledgeGapRecorded: true,
    },
    futureOutcome: {
      intent: "SERVICE_PRICE",
      expectedBehavior:
        "Quote the cleaning price from the price list, then ask for the booking date.",
    },
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION", "SPELLING_VARIATION"],
    maxCases: 16,
    rationale:
      "Price + booking in one turn. The price has no current channel (an architecture gap, not a dataset defect), and the gap is recorded so a future self-improvement loop can close it.",
  }),

  // ── Booking + hours (hours ARE in the FAQ store → no handoff needed) ────────
  singleTurn({
    id: "mi-booking-plus-hours",
    utterances: [
      ...egy(
        "عايز أحجز الخميس، بالمناسبة بتفتحوا الساعة كام؟",
        "عايز أحجز — وأنتم بتفتحوا امتى؟",
        "حجز + ساعات العمل لو سمحت",
        "عايز معاد بس قولي الأول بتقفلوا إمتى",
      ),
      u("عايز أحجز، opening hours كام؟", "ARABIC_ENGLISH", ["MIXED_LANGUAGE"]),
    ],
    semanticLabel: semantic(
      "BOOKING",
      "answer the hours question, then capture the date",
      ["HOURS"],
    ),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    handoff: handoffNotRequired(
      "The hours FAQ is in the knowledge store; the assistant can answer and keep booking.",
    ),
    knowledgeRequirement: "MULTIPLE_SOURCES",
    knowledgeSourceAssertion: {
      source: "MULTIPLE_SOURCES",
      currentChannel: "faqs",
    },
    edgeCategories: ["MULTI_INTENT", "KNOWLEDGE_EXACT", "BOOKING_JOURNEY"],
    difficulty: "MEDIUM",
    rarity: "COMMON",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["CLEAR", "POLITE"],
      changeOfState: "NONE",
    },
    expectedDomainAction: "REPLY_FROM_KNOWLEDGE",
    futureArchitectureExpectation: {
      expectSelfService: true,
      expectClarification: false,
      expectKnowledgeLookup: true,
      expectConfirmation: false,
      expectKnowledgeGapRecorded: false,
    },
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION", "TYPO"],
    maxCases: 14,
    rationale:
      "Booking + hours: the hours FAQ exists, so the correct behavior is to answer it inline, not to route away. Tests that a FAQ question riding on a booking does not suppress the booking goal.",
  }),

  // ── Discovery + price + booking (three secondary intents) ───────────────────
  singleTurn({
    id: "mi-discovery-price-booking",
    utterances: [
      ...egy(
        "ممكن تقولي الأسعار وبعدين أشوف هحجز امتى",
        "إيه الخدمات وأسعارها كام؟ وأنا هحجز بعدين",
        "عايز أعرف عندكم ايه وكل حاجة بكام، وبعدين أحجز",
      ),
      u("services w prices w ba3deen a7gez", "ARABIZI"),
    ],
    semanticLabel: semantic(
      "SERVICE_DISCOVERY",
      "answer catalog then price, leave the booking open",
      ["SERVICE_PRICE", "BOOKING"],
    ),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "NO_KNOWLEDGE", {
      architecturalLimitation: true,
    }),
    handoff: handoffEither(
      "Three goals in one turn; the current 8-intent contract cannot order them.",
    ),
    knowledgeRequirement: "MULTIPLE_SOURCES",
    knowledgeSourceAssertion: {
      source: "MULTIPLE_SOURCES",
      currentChannel: "services",
    },
    edgeCategories: ["MULTI_INTENT", "KNOWLEDGE_MULTIPLE", "MULTIPLE_ENTITIES"],
    difficulty: "EXTREME",
    rarity: "UNCOMMON",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["CURIOUS", "HESITANT"],
      changeOfState: "NONE",
    },
    expectedDomainAction: "REPLY_FROM_KNOWLEDGE",
    futureArchitectureExpectation: {
      expectSelfService: true,
      expectClarification: false,
      expectKnowledgeLookup: true,
      expectConfirmation: false,
      expectKnowledgeGapRecorded: true,
    },
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    maxCases: 12,
    rationale:
      "A turn with three ranked goals: catalog, price, then booking. The primary intent is what the turn is scored on; the secondary order is what a future router must respect.",
  }),

  // ── Human request riding on a knowledge question ────────────────────────────
  singleTurn({
    id: "mi-human-plus-knowledge",
    utterances: [
      ...egy(
        "عايز موظف بس قبل ما تحوله قولي هل عندكم تقويم؟",
        "وصلني بموظف، بس قولي الأول عندكم تقويم أطفال؟",
        "عايز أتكلم مع حد — وإنتوا بتقبلوا تأمين؟",
      ),
      u("3ayez mo2awaf bas 2ablo ma t7awelni, 3andoko ta2weem?", "ARABIZI"),
    ],
    semanticLabel: semantic(
      "HUMAN_REQUEST",
      "hand off; the rider question may be answered first",
      ["SERVICE_INFO", "FAQ"],
    ),
    currentAiExpectation: current("HUMAN_REQUEST", "handoff", "HUMAN_REQUEST", {
      fullyHandledByCurrent: false,
    }),
    handoff: handoffRequired("HUMAN_REQUEST", "Explicit human request."),
    knowledgeRequirement: "SERVICE_INFO",
    knowledgeSourceAssertion: {
      source: "SERVICE_DETAILS",
      currentChannel: "NONE",
    },
    edgeCategories: ["MULTI_INTENT", "HANDOFF_EXPLICIT", "LEGITIMATE_HANDOFF"],
    difficulty: "HARD",
    rarity: "UNCOMMON",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["CLEAR", "HURRIED"],
      changeOfState: "REQUESTS_HUMAN_EXPLICITLY",
    },
    expectedDomainAction: "ESCALATE_TO_HUMAN",
    futureArchitectureExpectation: {
      expectSelfService: false,
      expectClarification: false,
      expectKnowledgeLookup: true,
      expectConfirmation: false,
      expectKnowledgeGapRecorded: false,
    },
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION", "KEYBOARD_MISTAKE"],
    maxCases: 12,
    rationale:
      "The Egyptian clitic-style human request with an attached question. The human request is primary and REQUIRED; the rider is secondary so a future system can answer it on the way out.",
  }),

  // ── Two questions in one turn (no booking) ──────────────────────────────────
  singleTurn({
    id: "mi-two-questions",
    utterances: [
      ...egy(
        "إيه الخدمات اللي عندكم وإنتوا بتفتحوا الساعة كام؟",
        "عندكم تقويم أطفال؟ وبتقبلوا تأمين؟",
        "التنظيف بكام؟ والعنوان فين بالظبط؟",
      ),
      u("services eh w el sa3a kam?", "ARABIZI"),
    ],
    semanticLabel: semantic(
      "SERVICE_DISCOVERY",
      "answer both questions in order",
      ["HOURS", "FAQ"],
    ),
    currentAiExpectation: current("FAQ", "reply", null, {
      architecturalLimitation: true,
    }),
    handoff: handoffNotRequired(
      "Both answers are in the knowledge store; no human is needed.",
    ),
    knowledgeRequirement: "MULTIPLE_SOURCES",
    knowledgeSourceAssertion: {
      source: "MULTIPLE_SOURCES",
      currentChannel: "faqs",
    },
    edgeCategories: ["MULTI_INTENT", "MULTIPLE_ENTITIES", "KNOWLEDGE_MULTIPLE"],
    difficulty: "HARD",
    rarity: "UNCOMMON",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["CURIOUS", "CLEAR"],
      changeOfState: "NONE",
    },
    expectedDomainAction: "REPLY_FROM_KNOWLEDGE",
    futureArchitectureExpectation: {
      expectSelfService: true,
      expectClarification: false,
      expectKnowledgeLookup: true,
      expectConfirmation: false,
      expectKnowledgeGapRecorded: false,
    },
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    maxCases: 12,
    rationale:
      "Two independent questions in one turn with no booking: the primary must be answered AND the secondary, not only the first one matched.",
  }),

  // ── Greeting + FAQ (the greeting must not eat the question) ─────────────────
  singleTurn({
    id: "mi-greeting-plus-faq",
    utterances: [
      ...egy(
        "السلام عليكم، إيه ساعات العمل؟",
        "أهلاً، عندكم تقويم أسنان؟",
        "صباح النور — العيادة فين؟",
      ),
      u("hi, el hours kam?", "ARABIC_ENGLISH", ["MIXED_LANGUAGE"]),
    ],
    semanticLabel: semantic("FAQ", "greet briefly and answer the question", [
      "GREETING",
    ]),
    currentAiExpectation: current("FAQ", "reply", null, {
      fullyHandledByCurrent: true,
    }),
    handoff: handoffNotRequired("A greeting must never become a handoff."),
    knowledgeRequirement: "EXACT_FAQ",
    knowledgeSourceAssertion: { source: "FAQ_STORE", currentChannel: "faqs" },
    edgeCategories: ["MULTI_INTENT", "KNOWLEDGE_EXACT"],
    difficulty: "EASY",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["POLITE", "CLEAR"],
      changeOfState: "NONE",
    },
    expectedDomainAction: "REPLY_FROM_KNOWLEDGE",
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    maxCases: 12,
    rationale:
      "Greeting + a real question: the classifier must not stop at GREETING.",
  }),

  // ── Booking + location ──────────────────────────────────────────────────────
  singleTurn({
    id: "mi-booking-plus-location",
    utterances: [
      ...egy(
        "عايز أحجز والعيادة فين بالظبط؟",
        "حجز تنظيف — بس قولي العنوان أولاً",
        "عايز معاد، وأنا مش عارف العيادة فين",
      ),
      u("3ayez a7gez w el clinic fen?", "ARABIZI"),
    ],
    semanticLabel: semantic(
      "BOOKING",
      "give the location, then capture the date",
      ["LOCATION"],
    ),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    handoff: handoffNotRequired(
      "The address is in the FAQ store; the assistant can give it and keep booking.",
    ),
    knowledgeRequirement: "BUSINESS_INFO",
    knowledgeSourceAssertion: {
      source: "BUSINESS_INFO",
      currentChannel: "faqs",
    },
    edgeCategories: ["MULTI_INTENT", "KNOWLEDGE_EXACT", "BOOKING_JOURNEY"],
    difficulty: "MEDIUM",
    rarity: "COMMON",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["CLEAR"],
      changeOfState: "NONE",
    },
    expectedDomainAction: "REPLY_FROM_KNOWLEDGE",
    futureArchitectureExpectation: {
      expectSelfService: true,
      expectClarification: false,
      expectKnowledgeLookup: true,
      expectConfirmation: false,
      expectKnowledgeGapRecorded: false,
    },
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION", "SPELLING_VARIATION"],
    maxCases: 12,
    rationale:
      "Booking + address: the address FAQ exists, so the turn must not route away just because a booking word is present.",
  }),

  // ── Reschedule + hours ──────────────────────────────────────────────────────
  singleTurn({
    id: "mi-reschedule-plus-hours",
    utterances: [
      ...egy(
        "عايز أغيّر معادي — وبتفتحوا لحد امتى؟",
        "تغيير المعاد لو سمحت، وأنتم بتقفلوا كام؟",
        "عايز أشيل المعاد تاني يوم، وبالمناسبة ساعاتكم ايه؟",
      ),
    ],
    semanticLabel: semantic(
      "RESCHEDULE",
      "answer hours, then move the appointment",
      ["HOURS"],
    ),
    currentAiExpectation: current("RESCHEDULE", "handoff", null, {
      fullyHandledByCurrent: false,
    }),
    handoff: handoffEither("Reschedule needs a staff action; hours do not."),
    knowledgeRequirement: "MULTIPLE_SOURCES",
    knowledgeSourceAssertion: {
      source: "MULTIPLE_SOURCES",
      currentChannel: "faqs",
    },
    edgeCategories: ["MULTI_INTENT", "RESCHEDULE_EDGE", "KNOWLEDGE_EXACT"],
    difficulty: "MEDIUM",
    rarity: "UNCOMMON",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["CLEAR"],
      changeOfState: "CHANGES_DATE",
    },
    expectedDomainAction: "RESCHEDULE_BOOKING",
    entities: entities({ date: null }),
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    maxCases: 12,
    rationale:
      "Reschedule with an hours rider: the reschedule stays primary (it is the domain action) while the rider is answered, not dropped.",
  }),

  // ── Cancellation + policy question ──────────────────────────────────────────
  singleTurn({
    id: "mi-cancellation-plus-policy",
    utterances: [
      ...egy(
        "عايز ألغي الحجز — بس هل فيه رسوم إلغاء؟",
        "إلغاء المعاد، ولو ألغيت بدري بيحصل إيه؟",
        "عايز ألغي، وبالمناسبة سياسة الإلغاء ايه؟",
      ),
    ],
    semanticLabel: semantic("CANCELLATION", "state the policy, then cancel", [
      "FAQ",
    ]),
    currentAiExpectation: current("CANCELLATION", "handoff", null, {
      fullyHandledByCurrent: false,
    }),
    handoff: handoffEither(
      "Cancellation is a staff action; the policy part is answerable.",
    ),
    knowledgeRequirement: "POLICY",
    knowledgeSourceAssertion: {
      source: "CANCELLATION_POLICY",
      currentChannel: "NONE",
    },
    edgeCategories: ["MULTI_INTENT", "CANCELLATION_EDGE", "KNOWLEDGE_GAP"],
    difficulty: "HARD",
    rarity: "UNCOMMON",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["CLEAR", "HESITANT"],
      changeOfState: "NONE",
    },
    expectedDomainAction: "CANCEL_BOOKING",
    futureArchitectureExpectation: {
      expectSelfService: true,
      expectClarification: false,
      expectKnowledgeLookup: true,
      expectConfirmation: true,
      expectKnowledgeGapRecorded: true,
    },
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    maxCases: 12,
    rationale:
      "Cancellation + cancellation-policy: the policy has no channel today (a documented gap), and the cancellation needs confirmation.",
  }),

  // ── Availability + price ────────────────────────────────────────────────────
  singleTurn({
    id: "mi-availability-plus-price",
    utterances: [
      ...egy(
        "إمتى ممكن آجي النظافة؟ وسعرها كام؟",
        "فيه معاد تنضيف بكرة؟ وبتكلف كام؟",
        "المتاح لتقويم الأسنان امتى، والسعر كام؟",
      ),
    ],
    semanticLabel: semantic(
      "AVAILABILITY",
      "quote the price, then resolve availability",
      ["SERVICE_PRICE"],
    ),
    currentAiExpectation: current("AVAILABILITY", "handoff", null, {
      architecturalLimitation: true,
    }),
    handoff: handoffEither(
      "Availability needs the engine; the price rider has no channel.",
    ),
    knowledgeRequirement: "MULTIPLE_SOURCES",
    knowledgeSourceAssertion: {
      source: "MULTIPLE_SOURCES",
      currentChannel: "availability",
    },
    edgeCategories: ["MULTI_INTENT", "AVAILABILITY_EDGE", "KNOWLEDGE_GAP"],
    difficulty: "HARD",
    rarity: "UNCOMMON",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["CURIOUS", "CLEAR"],
      changeOfState: "NONE",
    },
    expectedDomainAction: "RESOLVE_AVAILABILITY",
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION", "MIXED_NUMERALS"],
    maxCases: 12,
    rationale:
      "Availability + price: the turn must resolve availability (the domain action) while the price rider is recorded as a gap rather than fabricated.",
  }),

  // ── Topic switch mid-booking (multi-turn) ───────────────────────────────────
  multiTurn({
    id: "mi-topic-switch-mid-booking",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز تنظيف الأسنان" },
      { senderType: "AI", text: "تمام — أنهي يوم يناسبك؟" },
    ],
    utterances: [
      ...egy(
        "ثواني — إيه الخدمات اللي عندكم كمان؟",
        "قبل ما أحدد يوم، قولي عندكم تقويم؟",
        "ماشي على التنظيف، بس سؤال: السعر كام؟",
      ),
    ],
    semanticLabel: semantic(
      "TOPIC_SWITCH",
      "answer the switched question, then return to the date",
      ["BOOKING", "SERVICE_DISCOVERY"],
    ),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    conversationState: {
      knownEntities: entities({ service: "تنظيف الأسنان" }),
      requiresMemory: true,
      expectedStatus: "AI_ACTIVE",
    },
    handoff: handoffNotRequired(
      "The switch is answerable from knowledge; the held booking must survive it.",
    ),
    knowledgeRequirement: "SERVICE_CATALOG",
    knowledgeSourceAssertion: {
      source: "SERVICE_CATALOG",
      currentChannel: "services",
    },
    edgeCategories: ["TOPIC_SWITCH", "MULTI_INTENT", "BOOKING_JOURNEY"],
    difficulty: "EXTREME",
    rarity: "RARE",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["CURIOUS", "HESITANT"],
      changeOfState: "ASKS_UNRELATED_QUESTION",
    },
    expectedDomainAction: "REPLY_FROM_KNOWLEDGE",
    futureArchitectureExpectation: {
      expectSelfService: true,
      expectClarification: false,
      expectKnowledgeLookup: true,
      expectConfirmation: false,
      expectKnowledgeGapRecorded: false,
    },
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    maxCases: 12,
    rationale:
      "A topic switch that suspends — not abandons — an open booking. The held service must survive the interruption so the journey can resume.",
  }),

  // ── Confirmation + follow-up question ───────────────────────────────────────
  multiTurn({
    id: "mi-confirmation-plus-question",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز تنظيف الأسنان يوم الخميس" },
      AI_OFFER,
      { senderType: "CUSTOMER", text: "الخيار الأول" },
      {
        senderType: "AI",
        text: "تمام — تم حجز تنظيف الأسنان يوم الخميس الساعة 10:00 مع د. منى.",
      },
    ],
    utterances: [
      ...egy(
        "شكراً — وبالمناسبة التأمين مقبول عندكم؟",
        "تمام، سؤال أخير: فيه موقف عربيات؟",
        "تسلم — وخلع الضهر بكام لو حجزت كمان؟",
      ),
    ],
    semanticLabel: semantic(
      "FOLLOW_UP",
      "answer the follow-up; the booking is already complete",
      ["FAQ"],
    ),
    currentAiExpectation: current("FAQ", "reply", null, {
      fullyHandledByCurrent: true,
    }),
    conversationState: {
      knownEntities: entities({
        service: "تنظيف الأسنان",
        date: "الخميس",
        provider: "د. منى",
      }),
      requiresMemory: true,
      expectedStatus: "BOOKED",
    },
    handoff: handoffNotRequired(
      "The booking is done; the follow-up is answerable from the FAQ store.",
    ),
    knowledgeRequirement: "EXACT_FAQ",
    knowledgeSourceAssertion: { source: "FAQ_STORE", currentChannel: "faqs" },
    edgeCategories: ["MULTI_INTENT", "FOLLOW_UP", "CONFIRMATION"],
    difficulty: "MEDIUM",
    rarity: "UNCOMMON",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["POLITE", "CURIOUS"],
      changeOfState: "NONE",
    },
    expectedDomainAction: "REPLY_FROM_KNOWLEDGE",
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    maxCases: 12,
    rationale:
      "A completed booking followed by a knowledge question: the assistant must answer the follow-up and not re-open or re-route the finished booking.",
  }),

  // ── Greeting + booking + human request (three intents, rare) ────────────────
  singleTurn({
    id: "mi-greeting-booking-human",
    utterances: [
      ...egy(
        "السلام عليكم، عايز أحجز بس هحتكلم مع الموظف",
        "أهلاً — حجز لو سمحت، ويفضل الموظف يتواصل معايا",
      ),
      u("سلام، عايز حجز وموظف", "ARABIZI"),
    ],
    semanticLabel: semantic(
      "HUMAN_REQUEST",
      "hand off; the greeting and booking are riders",
      ["BOOKING", "GREETING"],
    ),
    currentAiExpectation: current("HUMAN_REQUEST", "handoff", "HUMAN_REQUEST", {
      fullyHandledByCurrent: true,
    }),
    handoff: handoffRequired("HUMAN_REQUEST", "Explicit human request."),
    knowledgeRequirement: "NONE",
    edgeCategories: ["MULTI_INTENT", "HANDOFF_EXPLICIT", "LEGITIMATE_HANDOFF"],
    difficulty: "EXTREME",
    rarity: "EXTREMELY_RARE",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["CLEAR", "HURRIED"],
      changeOfState: "REQUESTS_HUMAN_EXPLICITLY",
    },
    expectedDomainAction: "ESCALATE_TO_HUMAN",
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    maxCases: 8,
    rationale:
      "Three intents where the human request is primary and REQUIRED — the greeting and booking must not downgrade it.",
  }),

  // ── Empty-knowledge tenant: discovery + booking cannot be answered ──────────
  singleTurn({
    id: "mi-booking-plus-discovery-empty-kb",
    utterances: egy(
      "عايز أحجز، عندكم ايه خدمات؟",
      "قبل ما أحجز قولي بتقدموا ايه؟",
      "عايز أحجز — إيه الخدمات؟",
    ),
    semanticLabel: semantic(
      "SERVICE_DISCOVERY",
      "admit the gap honestly and route to a human",
      ["BOOKING"],
    ),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "NO_KNOWLEDGE", {
      architecturalLimitation: true,
    }),
    handoff: handoffRequired(
      "UNSUPPORTED",
      "No catalog exists to answer from.",
    ),
    knowledgeRequirement: "KNOWLEDGE_GAP",
    knowledgeSourceAssertion: { source: "NONE", currentChannel: "NONE" },
    edgeCategories: [
      "MULTI_INTENT",
      "KNOWLEDGE_GAP",
      "LEGITIMATE_HANDOFF",
      "BOOKING_JOURNEY",
    ],
    difficulty: "HARD",
    rarity: "RARE",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: EMPTY_KNOWLEDGE_CONTEXT,
    customerBehavior: {
      dispositions: ["CURIOUS", "CLEAR"],
      changeOfState: "NONE",
    },
    expectedDomainAction: "ESCALATE_TO_HUMAN",
    futureArchitectureExpectation: {
      expectSelfService: false,
      expectClarification: false,
      expectKnowledgeLookup: true,
      expectConfirmation: false,
      expectKnowledgeGapRecorded: true,
    },
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    maxCases: 10,
    rationale:
      "The counter-example to mi-booking-plus-discovery: with no catalog at all the same question becomes a legitimate handoff, not an unnecessary one.",
  }),
];
