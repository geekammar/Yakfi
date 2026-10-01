/**
 * FlowPilot AI Evaluation — egyptian-v1 AMBIGUITY scenarios
 * (PROMPT-AI-EVAL-02).
 *
 * The four ambiguity classes the ground truth must keep apart:
 *
 *   1. AMBIGUOUS_CLARIFIABLE   — the turn is vague but a question would fix it.
 *                                Ground truth: NOT_REQUIRED + a CLARIFY_* label.
 *   2. AMBIGUOUS_STATE_RESOLVES— the conversation already supplies the answer.
 *                                Ground truth: requiresMemory, no clarification.
 *   3. AMBIGUOUS_NEEDS_HUMAN   — genuinely unsupported; honest escalation.
 *                                Ground truth: REQUIRED / UNSUPPORTED.
 *   4. legitimate human        — the ambiguity IS the customer asking for a
 *                                person. Ground truth: REQUIRED / HUMAN_REQUEST.
 *
 * The distinction is the whole point: the current 8-intent contract collapses
 * all four into one `AMBIGUOUS` bucket, so every case here carries
 * `orientation: FUTURE_ARCHITECTURE` and the clarification the ideal assistant
 * would ask, which is what a future clarification step is measured against.
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

/** A compact prior AI offer shared by the ambiguity journeys. */
const AI_OFFER = {
  senderType: "AI" as const,
  text: 'تتوفر المواعيد التالية لخدمة "تنظيف الأسنان" يوم 2026-10-01:\n1. د. منى — 10:00 إلى 10:30\n2. د. منى — 12:00 إلى 12:30\nيرجى اختيار أحد الخيارات.',
};

export const ambiguityScenarios: Scenario[] = [
  // ── 1. CLARIFIABLE: a bare goal; one question resolves it ───────────────────
  singleTurn({
    id: "am-bare-booking-clarifiable",
    utterances: [
      ...egy("عايز أحجز", "عايز أحجز حاجة", "ممكن أحجز؟", "عايز ميعاد"),
      u("3ayez a7gez", "ARABIZI"),
    ],
    semanticLabel: semantic(
      "CLARIFICATION_REQUIRED",
      "ask which service the booking is for",
      ["BOOKING"],
    ),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      fullyHandledByCurrent: false,
    }),
    handoff: handoffNotRequired(
      "The turn is vague but a single question — which service — resolves it. A handoff here is unnecessary.",
    ),
    knowledgeRequirement: "SERVICE_CATALOG",
    knowledgeSourceAssertion: {
      source: "SERVICE_CATALOG",
      currentChannel: "services",
    },
    edgeCategories: [
      "AMBIGUOUS_CLARIFIABLE",
      "BOOKING_JOURNEY",
      "PARTIAL_INFORMATION",
    ],
    difficulty: "MEDIUM",
    rarity: "COMMON",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["CLEAR", "VAGUE"],
      changeOfState: "NONE",
    },
    expectedDomainAction: "REQUEST_MISSING_SERVICE",
    expectedClarification: {
      type: "CLARIFY_SERVICE",
      question: "أنهي خدمة تحب أحجزها — تنظيف ولا حشو ولا تقويم؟",
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
      expectKnowledgeLookup: true,
      expectConfirmation: false,
      expectKnowledgeGapRecorded: false,
    },
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION", "REPEAT_LETTERS"],
    maxCases: 12,
    rationale:
      "The canonical clarifiable turn: 'عايز أحجز' with nothing else. The ideal move is a service question, not an escalation.",
  }),

  // ── CLARIFIABLE: bare service, no goal stated yet ───────────────────────────
  singleTurn({
    id: "am-bare-service-clarifiable",
    utterances: [
      ...egy("التنظيف", "تقويم", "حشو", "التبييض", "خلع الضرس"),
      u("tanzeef", "ARABIZI"),
    ],
    semanticLabel: semantic(
      "CLARIFICATION_REQUIRED",
      "ask whether the bare noun is a booking goal or a question",
      ["BOOKING", "SERVICE_INFO"],
    ),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "AMBIGUOUS", {
      fullyHandledByCurrent: false,
    }),
    handoff: handoffNotRequired(
      "One short question — booking or enquiry — resolves the turn without a human.",
    ),
    knowledgeRequirement: "SERVICE_CATALOG",
    knowledgeSourceAssertion: {
      source: "SERVICE_CATALOG",
      currentChannel: "services",
    },
    edgeCategories: [
      "AMBIGUOUS_CLARIFIABLE",
      "VERY_SHORT_INPUT",
      "BOOKING_JOURNEY",
    ],
    difficulty: "HARD",
    rarity: "COMMON",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["VAGUE", "HURRIED"],
      changeOfState: "NONE",
    },
    expectedDomainAction: "REQUEST_CLARIFICATION",
    expectedClarification: {
      type: "CLARIFY_INTENT",
      question: "تقصد حجز معاد للتنظيف ولا سؤال عن التنظيف؟",
      targets: ["service"],
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
      "A bare service noun with no context: the current arch hands off, the ideal assistant asks whether it is a booking or an enquiry.",
  }),

  // ── CLARIFIABLE: "أي وقت" / "مش عارف" after the date ask ───────────────────
  multiTurn({
    id: "am-vague-time-clarifiable",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز تنظيف الأسنان" },
      {
        senderType: "AI",
        text: "تمام — أنهي يوم يناسبك؟",
      },
    ],
    utterances: [
      ...egy("أي وقت", "مش عارف", "اللي يبقى مناسب", "أي حاجة", "مش فارق"),
      u("any time", "ENGLISH"),
    ],
    semanticLabel: semantic(
      "CLARIFICATION_REQUIRED",
      "offer concrete slots instead of escalating the vagueness",
      ["BOOKING"],
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
      "Vagueness about time is not a reason to escalate; the assistant should propose slots.",
    ),
    knowledgeRequirement: "AVAILABILITY",
    knowledgeSourceAssertion: {
      source: "AVAILABILITY_ENGINE",
      currentChannel: "availability",
    },
    edgeCategories: [
      "AMBIGUOUS_CLARIFIABLE",
      "BOOKING_JOURNEY",
      "MISSING_INFORMATION",
      "AVAILABILITY_EDGE",
    ],
    difficulty: "HARD",
    rarity: "COMMON",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["VAGUE", "POLITE"],
      changeOfState: "NONE",
    },
    expectedDomainAction: "PROPOSE_SLOTS",
    expectedClarification: {
      type: "CLARIFY_TIME",
      question: "أقترح عليك أول معادين متاحين — 10 الصبح ولا 12 الضهر؟",
      targets: ["timePreference"],
    },
    expectedStateTransition: {
      from: "SERVICE_SUPPLIED",
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
    maxCases: 12,
    rationale:
      "'أي وقت' after a service is stated: the ideal assistant converts vagueness into a proposal. Handing off here is the unnecessary-handoff shape.",
  }),

  // ── 2. STATE RESOLVES: the context supplies the missing half ────────────────
  multiTurn({
    id: "am-context-resolves-date",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز تنظيف الأسنان" },
      {
        senderType: "AI",
        text: "تمام — أنهي يوم يناسبك؟",
      },
      { senderType: "CUSTOMER", text: "الخميس" },
      { senderType: "AI", text: "حاضر — الخميس. تفضل صباحاً ولا مساءً؟" },
    ],
    utterances: [
      ...egy(
        "اللي اتكلمنا عليه",
        "نفس المعاد اللي قولتلي عليه",
        "زي ما اتفقنا",
        "المعاد القديم",
      ),
    ],
    semanticLabel: semantic(
      "BOOKING",
      "resolve the implicit reference against the held date and daypart",
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
      "Booking continues; the current arch can only hand off.",
    ),
    knowledgeRequirement: "AVAILABILITY",
    knowledgeSourceAssertion: {
      source: "AVAILABILITY_ENGINE",
      currentChannel: "availability",
    },
    edgeCategories: [
      "AMBIGUOUS_STATE_RESOLVES",
      "IMPLICIT_REFERENCE",
      "BOOKING_JOURNEY",
    ],
    difficulty: "EXTREME",
    rarity: "RARE",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["REPETITIVE", "POLITE"],
      changeOfState: "NONE",
    },
    expectedDomainAction: "RESOLVE_AVAILABILITY",
    expectedStateTransition: {
      from: "DATE_SUPPLIED",
      to: "TIME_SUPPLIED",
      bookingJourneyState: "TIME_SUPPLIED",
      factKey: "time",
      isRevision: false,
    },
    futureArchitectureExpectation: {
      expectSelfService: true,
      expectClarification: false,
      expectKnowledgeLookup: true,
      expectConfirmation: false,
      expectKnowledgeGapRecorded: false,
    },
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    maxCases: 10,
    rationale:
      "'نفس المعاد' is only ambiguous without memory: with the held date it resolves completely, so the truth is BOOKING — not AMBIGUOUS.",
    futureOutcome: {
      intent: "BOOKING",
      expectedBehavior:
        "Bind 'نفس المعاد' to the held date/daypart and continue, never ask the customer to repeat themselves.",
    },
  }),

  // ── STATE RESOLVES: a bare date after the service ask ───────────────────────
  multiTurn({
    id: "am-context-resolves-service",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز" },
      { senderType: "AI", text: "تمام — أنهي خدمة تحتاجها؟" },
      { senderType: "CUSTOMER", text: "تنظيف" },
      { senderType: "AI", text: "حاضر — تنظيف الأسنان. أنهي يوم؟" },
    ],
    utterances: [...egy("الخميس", "بكرة", "تاني يوم", "الخميس الجاي")],
    semanticLabel: semantic(
      "BOOKING",
      "the bare date binds to the open booking, not to a new topic",
    ),
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
    edgeCategories: [
      "AMBIGUOUS_STATE_RESOLVES",
      "IMPLICIT_REFERENCE",
      "BOOKING_JOURNEY",
    ],
    difficulty: "HARD",
    rarity: "COMMON",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["CLEAR", "HURRIED"],
      changeOfState: "NONE",
    },
    expectedDomainAction: "REQUEST_MISSING_TIME",
    expectedStateTransition: {
      from: "SERVICE_SUPPLIED",
      to: "DATE_SUPPLIED",
      bookingJourneyState: "DATE_SUPPLIED",
      factKey: "date",
      isRevision: false,
    },
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION", "MIXED_NUMERALS"],
    maxCases: 12,
    rationale:
      "A bare weekday after the service is settled: context resolves it to the booking's date slot. Classifying it as ambiguous is a memory failure.",
  }),

  // ── 3. NEEDS A HUMAN: genuinely unsupported ambiguity ───────────────────────
  singleTurn({
    id: "am-genuinely-unsupported",
    utterances: [
      ...egy(
        "طب والتقويم؟",
        "والحاجات التانية؟",
        "والباقي ايه؟",
        "وكل الخدمات التانية؟",
      ),
    ],
    semanticLabel: semantic(
      "AMBIGUOUS",
      "the reference is unresolvable — route honestly",
    ),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "AMBIGUOUS", {
      fullyHandledByCurrent: true,
    }),
    handoff: handoffRequired(
      "UNSUPPORTED",
      "Nothing in the context pins the reference.",
    ),
    knowledgeRequirement: "NONE",
    edgeCategories: ["AMBIGUOUS_NEEDS_HUMAN", "AMBIGUOUS"],
    difficulty: "HARD",
    rarity: "UNCOMMON",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["REPETITIVE", "VAGUE"],
      changeOfState: "NONE",
    },
    expectedDomainAction: "ESCALATE_TO_HUMAN",
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    maxCases: 10,
    rationale:
      "The counter-example: an anaphora with no antecedent ('والتاني؟' with nothing prior). Clarification cannot invent the referent, so escalation is honest.",
  }),

  // ── NEEDS A HUMAN: two services, one slot, no way to choose ────────────────
  singleTurn({
    id: "am-two-services-one-slot",
    utterances: [
      ...egy(
        "عايز تنظيف وحشو في نفس المعاد",
        "تنظيف وتقويم مع بعض",
        "ممكن تنظيف وتبييض معاد واحد؟",
      ),
    ],
    semanticLabel: semantic(
      "CLARIFICATION_REQUIRED",
      "ask which service the single slot is for",
      ["BOOKING"],
    ),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "AMBIGUOUS", {
      architecturalLimitation: true,
    }),
    handoff: handoffEither(
      "Two services for one slot is a scheduling decision; either disambiguating or routing is honest.",
    ),
    knowledgeRequirement: "AVAILABILITY",
    knowledgeSourceAssertion: {
      source: "AVAILABILITY_ENGINE",
      currentChannel: "availability",
    },
    edgeCategories: [
      "AMBIGUOUS_CLARIFIABLE",
      "MULTIPLE_ENTITIES",
      "BOOKING_EDGE",
      "MULTI_INTENT",
    ],
    difficulty: "EXTREME",
    rarity: "RARE",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["CLEAR", "HURRIED"],
      changeOfState: "NONE",
    },
    expectedDomainAction: "REQUEST_CLARIFICATION",
    expectedClarification: {
      type: "CLARIFY_DISAMBIGUATE_MULTI_INTENT",
      question: "المعاد للتنظيف ولا للحشو؟ التاني ممكن نعمله معاد تاني.",
      targets: ["service"],
    },
    futureArchitectureExpectation: {
      expectSelfService: true,
      expectClarification: true,
      expectKnowledgeLookup: false,
      expectConfirmation: false,
      expectKnowledgeGapRecorded: false,
    },
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    maxCases: 10,
    rationale:
      "Two services competing for one slot: the ideal assistant asks which one the slot is for; the current arch can only route.",
  }),

  // ── 4. LEGITIMATE HUMAN: the ambiguity is the customer asking for a person ─
  singleTurn({
    id: "am-legitimate-human",
    utterances: [
      ...egy(
        "مش عارف، وصلني بموظف",
        "أنا محتار، عايز أتكلم مع حد",
        "كلمني موظف أحسن",
        "أنا مش فاهم، وصلني حد",
      ),
      u("msh 3aref, wasselni mo2awaf", "ARABIZI"),
    ],
    semanticLabel: semantic(
      "HUMAN_REQUEST",
      "hand off — the customer asked for a person",
    ),
    currentAiExpectation: current("HUMAN_REQUEST", "handoff", "HUMAN_REQUEST", {
      fullyHandledByCurrent: true,
    }),
    handoff: handoffRequired("HUMAN_REQUEST", "Explicit human request."),
    knowledgeRequirement: "NONE",
    edgeCategories: [
      "HANDOFF_EXPLICIT",
      "LEGITIMATE_HANDOFF",
      "AMBIGUOUS_NEEDS_HUMAN",
    ],
    difficulty: "EASY",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["VAGUE", "HURRIED"],
      changeOfState: "REQUESTS_HUMAN_EXPLICITLY",
    },
    expectedDomainAction: "ESCALATE_TO_HUMAN",
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    maxCases: 10,
    rationale:
      "Ambiguity plus an explicit human request: the request wins, the ambiguity does not need resolving first.",
  }),

  // ── CONTEXT_DEPENDENT: the same words mean different things by position ────
  multiTurn({
    id: "am-context-dependent-tamam",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز تنظيف الأسنان يوم الخميس" },
      AI_OFFER,
    ],
    utterances: [...egy("تمام", "ماشي", "أوكي", "تمام كده")],
    semanticLabel: semantic(
      "CONFIRMATION",
      "assent binds to the offer, not to an earlier question",
    ),
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
      "Slot confirmation continues; the current arch routes to staff.",
    ),
    knowledgeRequirement: "NONE",
    edgeCategories: [
      "AMBIGUOUS_STATE_RESOLVES",
      "CONTEXT_DEPENDENT",
      "BOOKING_JOURNEY",
      "CONFIRMATION",
    ],
    difficulty: "EXTREME",
    rarity: "RARE",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["CLEAR", "POLITE"],
      changeOfState: "NONE",
    },
    expectedDomainAction: "SELECT_SLOT",
    expectedStateTransition: {
      from: "AVAILABILITY_RESOLVED",
      to: "SLOT_SELECTION",
      bookingJourneyState: "SLOT_SELECTION",
      factKey: "slot",
      isRevision: false,
    },
    engineOwner: "BOOKING_SELECTION_SEAM",
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    maxCases: 10,
    rationale:
      "'تمام' is pure context-dependence: after a numbered offer it is a slot selection, after a question it is an answer, at the start it is noise. Position determines the truth.",
  }),

  // ── "لا" after an offer: refusal, not a slot ────────────────────────────────
  multiTurn({
    id: "am-context-dependent-no",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز تنظيف الأسنان يوم الخميس" },
      AI_OFFER,
    ],
    utterances: [
      ...egy(
        "لا، في معاد تاني؟",
        "لا دول مش مناسبين",
        "لا عايز معاد تاني",
        "المعادات دي مش مضبوطة",
      ),
    ],
    semanticLabel: semantic(
      "AVAILABILITY",
      "the refusal rejects the offer; propose alternatives",
    ),
    currentAiExpectation: current("AVAILABILITY", "handoff", null, {
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
      "Availability needs the engine; either path is fine.",
    ),
    knowledgeRequirement: "AVAILABILITY",
    knowledgeSourceAssertion: {
      source: "AVAILABILITY_ENGINE",
      currentChannel: "availability",
    },
    edgeCategories: [
      "AMBIGUOUS_STATE_RESOLVES",
      "CONTEXT_DEPENDENT",
      "REFUSAL",
      "AVAILABILITY_EDGE",
    ],
    difficulty: "EXTREME",
    rarity: "RARE",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["CORRECTIVE", "CLEAR"],
      changeOfState: "CHANGES_TIME",
    },
    expectedDomainAction: "PROPOSE_SLOTS",
    expectedStateTransition: {
      from: "AVAILABILITY_RESOLVED",
      to: "AVAILABILITY_RESOLVED",
      bookingJourneyState: "AVAILABILITY_RESOLVED",
      factKey: "slot",
      isRevision: true,
    },
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    maxCases: 10,
    rationale:
      "'لا' after an offer is a slot refusal with an implicit request for more slots — never a cancellation and never a no-op.",
  }),

  // ─ـ EMPTY-KNOWLEDGE ambiguity: nothing to resolve against at all ───────────
  singleTurn({
    id: "am-empty-kb-ambiguous",
    utterances: [...egy("عايز حاجة", "محتاج مساعدة", "مش عارف أبدأ منين")],
    semanticLabel: semantic(
      "AMBIGUOUS",
      "no context and no catalog — route and let a human triage",
    ),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "AMBIGUOUS", {
      fullyHandledByCurrent: true,
    }),
    handoff: handoffRequired(
      "UNSUPPORTED",
      "Nothing in the context or catalog resolves the turn.",
    ),
    knowledgeRequirement: "NO_FAQ",
    knowledgeSourceAssertion: { source: "NONE", currentChannel: "NONE" },
    edgeCategories: ["AMBIGUOUS_NEEDS_HUMAN", "AMBIGUOUS", "KNOWLEDGE_MISSING"],
    difficulty: "MEDIUM",
    rarity: "RARE",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: EMPTY_KNOWLEDGE_CONTEXT,
    customerBehavior: {
      dispositions: ["VAGUE", "HESITANT"],
      changeOfState: "NONE",
    },
    expectedDomainAction: "ESCALATE_TO_HUMAN",
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    maxCases: 8,
    rationale:
      "Total ambiguity against an empty tenant: the honest answer is escalation, and the truth says so without a clarification label.",
  }),
];
