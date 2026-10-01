/**
 * FlowPilot AI Evaluation — egyptian-v1 HANDOFF scenarios
 * (PROMPT-AI-EVAL-02).
 *
 * The true-vs-unnecessary handoff split, authored deliberately. Each scenario
 * asserts the ground truth (`expectedHandoff.expectation` + `kind`) that the
 * observed `HandoffOutcomeClass` is scored against:
 *
 *   TRUE_HUMAN_REQUIRED        → REQUIRED  + HUMAN_REQUEST / SENSITIVE / UNSUPPORTED
 *   UNNECESSARY_HUMAN_HANDOFF  → NOT_REQUIRED  (the system could have resolved it)
 *   KNOWLEDGE_GAP              → REQUIRED/ACCEPTABLE_EITHER + no knowledge channel
 *   AMBIGUOUS_BUT_CLARIFIABLE  → NOT_REQUIRED + a CLARIFY_* label
 *   AI_FAILURE                 → NOT_REQUIRED (the assistant must recover, not escalate)
 *   PROVIDER_FAILURE           → NOT_REQUIRED (a retry, not an escalation)
 *   SENSITIVE                  → REQUIRED + SENSITIVE
 *   CUSTOMER_REQUESTED_HUMAN   → REQUIRED + HUMAN_REQUEST
 *
 * The bank is deliberately HEAVY on the NOT_REQUIRED side: that is where the
 * current FlowPilot behavior is weakest, because booking-shaped words trigger
 * `booking_handoff` even when the customer's turn was fully answerable.
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
import {
  CLINIC_CONTEXT,
  EMPTY_KNOWLEDGE_CONTEXT,
  SPARSE_CONTEXT,
} from "./shared-context";

export const handoffScenarios: Scenario[] = [
  // ── UNNECESSARY: a knowledge question that reads like a booking ────────────
  singleTurn({
    id: "ho-unnecessary-knowledge-looks-like-booking",
    utterances: [
      ...egy(
        "عايز أعرف أسعار التنظيف قبل ما أحجز",
        "قبل ما أحضر، التنظيف بكام؟",
        "أحجز بس لما أعرف السعر",
        "نظفت الأسنان فين بالظبط؟",
      ),
    ],
    semanticLabel: semantic(
      "SERVICE_PRICE",
      "answer the question that gates the booking",
      ["BOOKING"],
    ),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    handoff: handoffNotRequired(
      "The turn is a question, not a booking attempt. The assistant should answer (or admit the gap) — not route.",
    ),
    knowledgeRequirement: "KNOWLEDGE_GAP",
    knowledgeSourceAssertion: { source: "PRICE_LIST", currentChannel: "NONE" },
    edgeCategories: [
      "UNNECESSARY_HANDOFF",
      "HANDOFF_UNNECESSARY_RISK",
      "MULTI_INTENT",
    ],
    difficulty: "HARD",
    rarity: "COMMON",
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
      "The shape the current system gets wrong: a price/where question that mentions booking is routed to booking_handoff, losing the question entirely.",
  }),

  // ── UNNECESSARY: pure FAQ in a hurried register ─────────────────────────────
  singleTurn({
    id: "ho-unnecessary-faq-hurried",
    utterances: [
      ...egy(
        "ساعاتكم ايه بسرعة",
        "العنوان فين عشان أنا رايح دلوقتي",
        "فيه موقف ولا لأ؟",
        "بتقبلوا تأمين؟ أنا رايح النهاردة",
      ),
      u("el hours kam?", "ARABIZI"),
    ],
    semanticLabel: semantic("FAQ", "answer directly from the stored FAQ"),
    currentAiExpectation: current("FAQ", "reply", null, {
      fullyHandledByCurrent: true,
    }),
    handoff: handoffNotRequired(
      "Every answer is in the FAQ store. A handoff is a waste of an operator's time.",
    ),
    knowledgeRequirement: "EXACT_FAQ",
    knowledgeSourceAssertion: { source: "FAQ_STORE", currentChannel: "faqs" },
    edgeCategories: ["UNNECESSARY_HANDOFF", "KNOWLEDGE_EXACT"],
    difficulty: "EASY",
    rarity: "COMMON",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["HURRIED", "CLEAR"],
      changeOfState: "NONE",
    },
    expectedDomainAction: "REPLY_FROM_KNOWLEDGE",
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION", "INFORMAL_PUNCTUATION"],
    maxCases: 14,
    rationale:
      "Fast, slightly rude FAQ turns: the correct behavior is still a direct answer, never an escalation.",
  }),

  // ── UNNECESSARY: service discovery mid-conversation ────────────────────────
  multiTurn({
    id: "ho-unnecessary-discovery-mid-flow",
    contextTurns: [
      { senderType: "CUSTOMER", text: "السلام عليكم" },
      {
        senderType: "AI",
        text: "أهلاً بك!  أنا مساعدك للحجز والمواعيد — كيف يمكنني مساعدتك اليوم؟",
      },
    ],
    utterances: [
      ...egy(
        "قبل أي حاجة، إيه الخدمات اللي عندكم؟",
        "أول سؤال: بتقدموا ايه؟",
        "أنا بسال الأول على الخدمات",
      ),
    ],
    semanticLabel: semantic(
      "SERVICE_DISCOVERY",
      "answer the discovery question before anything else",
    ),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "NO_KNOWLEDGE", {
      architecturalLimitation: true,
    }),
    conversationState: {
      knownEntities: entities({}),
      requiresMemory: false,
      expectedStatus: "AI_ACTIVE",
    },
    handoff: handoffNotRequired(
      "The catalog is exposed through AiRequest.services; the assistant can list it.",
    ),
    knowledgeRequirement: "SERVICE_CATALOG",
    knowledgeSourceAssertion: {
      source: "SERVICE_CATALOG",
      currentChannel: "services",
    },
    edgeCategories: ["UNNECESSARY_HANDOFF", "KNOWLEDGE_EXACT", "TOPIC_SWITCH"],
    difficulty: "MEDIUM",
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
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    maxCases: 10,
    rationale:
      "Discovery as the very first real turn: the correct answer is the catalog the assistant already has.",
  }),

  // ── UNNECESSARY: clarification could have resolved it ──────────────────────
  singleTurn({
    id: "ho-unnecessary-clarifiable",
    utterances: [
      ...egy(
        "عايز أحجز التنظيف ده",
        "عايز نفس الحجز تاني",
        "عايز معاد زي اللي فات",
      ),
    ],
    semanticLabel: semantic(
      "CLARIFICATION_REQUIRED",
      "ask which date/time; the reference is recoverable",
      ["BOOKING"],
    ),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "AMBIGUOUS", {
      architecturalLimitation: true,
    }),
    handoff: handoffNotRequired(
      "One clarifying question resolves the reference — escalation is unnecessary.",
    ),
    knowledgeRequirement: "NONE",
    edgeCategories: [
      "UNNECESSARY_HANDOFF",
      "AMBIGUOUS_CLARIFIABLE",
      "IMPLICIT_REFERENCE",
    ],
    difficulty: "HARD",
    rarity: "UNCOMMON",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["REPETITIVE", "CLEAR"],
      changeOfState: "NONE",
    },
    expectedDomainAction: "REQUEST_CLARIFICATION",
    expectedClarification: {
      type: "CLARIFY_DATE",
      question: "تقصد معاد التنظيف القديم ولا معاد جديد؟",
      targets: ["date"],
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
      "'نفس الحجز تاني' is ambiguous but clarifiable: the ideal assistant asks one question; the current architecture escalates.",
  }),

  // ── AI_FAILURE: the assistant broke; the customer must not pay for it ──────
  multiTurn({
    id: "ho-ai-failure-retry",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز تنظيف الأسنان يوم الخميس" },
      { senderType: "AI", text: "…" },
      { senderType: "CUSTOMER", text: "ألو؟ في حد؟" },
      { senderType: "AI", text: "…" },
    ],
    utterances: [
      ...egy(
        "ألو، أنا لسه هنا",
        "ولا رديت عليا",
        "فيه مشكلة؟ أنا مستني",
        "عايز حد يرد",
      ),
    ],
    semanticLabel: semantic(
      "BOOKING",
      "recover the journey after empty assistant turns",
    ),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      fullyHandledByCurrent: false,
    }),
    conversationState: {
      knownEntities: entities({ service: "تنظيف الأسنان", date: "الخميس" }),
      requiresMemory: true,
      expectedStatus: "AI_ACTIVE",
    },
    handoff: handoffNotRequired(
      "The assistant's own failure must not become a customer's handoff; the journey should resume from the held facts.",
    ),
    knowledgeRequirement: "NONE",
    edgeCategories: [
      "STATE_RECOVERY",
      "REPETITION",
      "BOOKING_JOURNEY",
      "BOOKING_FAILURE",
    ],
    difficulty: "EXTREME",
    rarity: "RARE",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["REPETITIVE", "HURRIED"],
      changeOfState: "NONE",
    },
    expectedDomainAction: "REQUEST_MISSING_TIME",
    expectedStateTransition: {
      from: "DATE_SUPPLIED",
      to: "MISSING_TIME",
      bookingJourneyState: "MISSING_TIME",
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
      "The AI_FAILURE channel: empty assistant turns in the history. The observed class would be AI_FAILURE, and the ground truth says the correct move is to resume, not to escalate a broken thread.",
  }),

  // ── PROVIDER_FAILURE: an upstream error, the customer retries ──────────────
  multiTurn({
    id: "ho-provider-failure-retry",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز تنظيف الأسنان يوم الخميس" },
      {
        senderType: "AI",
        text: "واجهت مشكلة مؤقتة في النظام — جاري المحاولة مرة أخرى.",
      },
    ],
    utterances: [
      ...egy(
        "حاول تاني لو سمحت",
        "لسه مستني، جرب كمان مرة",
        "المشكلة اتحلت؟ نكمل",
        "عيد من الأول",
      ),
    ],
    semanticLabel: semantic(
      "BOOKING",
      "retry the journey after a transient provider error",
    ),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      fullyHandledByCurrent: false,
    }),
    conversationState: {
      knownEntities: entities({ service: "تنظيف الأسنان", date: "الخميس" }),
      requiresMemory: true,
      expectedStatus: "AI_ACTIVE",
    },
    handoff: handoffNotRequired(
      "A transient provider error is not a reason to escalate; the journey should retry from the held facts.",
    ),
    knowledgeRequirement: "NONE",
    edgeCategories: ["STATE_RECOVERY", "BOOKING_FAILURE", "BOOKING_JOURNEY"],
    difficulty: "HARD",
    rarity: "RARE",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["POLITE", "CLEAR"],
      changeOfState: "NONE",
    },
    expectedDomainAction: "REQUEST_MISSING_TIME",
    expectedStateTransition: {
      from: "DATE_SUPPLIED",
      to: "MISSING_TIME",
      bookingJourneyState: "MISSING_TIME",
      isRevision: false,
    },
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    maxCases: 10,
    rationale:
      "The PROVIDER_FAILURE channel: the assistant already signalled a transient fault. Escalating on the customer's retry would blame the customer for an upstream error.",
  }),

  // ── KNOWLEDGE_GAP: no answer exists anywhere ────────────────────────────────
  singleTurn({
    id: "ho-knowledge-gap-no-channel",
    utterances: [
      ...egy(
        "التقويم اللغوي موجود عندكم؟",
        "بتعملوا تقويم شفاف؟",
        "فيه تقويم أطفال تحت سنتين؟",
      ),
    ],
    semanticLabel: semantic(
      "SERVICE_INFO",
      "no stored knowledge covers it — record the gap, route honestly",
    ),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "NO_KNOWLEDGE", {
      fullyHandledByCurrent: true,
    }),
    handoff: handoffEither(
      "Nothing in the catalog or FAQ covers this variant; routing is honest, but so is a plain gap admission.",
    ),
    knowledgeRequirement: "KNOWLEDGE_GAP",
    knowledgeSourceAssertion: {
      source: "SERVICE_DETAILS",
      currentChannel: "NONE",
    },
    edgeCategories: [
      "KNOWLEDGE_GAP",
      "KNOWLEDGE_NOT_EXPOSED",
      "KNOWLEDGE_MISSING",
    ],
    difficulty: "HARD",
    rarity: "UNCOMMON",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: SPARSE_CONTEXT,
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
      "The KNOWLEDGE_GAP channel: the question is real, the tenant has no answer for it, and the dataset records the gap so the loop can later close it.",
  }),

  // ── AMBIGUOUS_BUT_CLARIFIABLE with a handoff temptation ────────────────────
  multiTurn({
    id: "ho-ambiguous-but-clarifiable-multi-turn",
    contextTurns: [
      { senderType: "CUSTOMER", text: "عايز أحجز" },
      { senderType: "AI", text: "تمام — أنهي خدمة تحتاجها؟" },
    ],
    utterances: [
      ...egy(
        "مش متذكر اسمها",
        "حاجة للأسنان",
        "اللي الدكتور قالي عليها",
        "مش عارف اسمها بالظبط",
      ),
    ],
    semanticLabel: semantic(
      "CLARIFICATION_REQUIRED",
      "offer the catalog so the customer can point at a service",
      ["BOOKING"],
    ),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "AMBIGUOUS", {
      architecturalLimitation: true,
    }),
    conversationState: {
      knownEntities: entities({}),
      requiresMemory: true,
      expectedStatus: "AI_ACTIVE",
    },
    handoff: handoffNotRequired(
      "Listing the catalog resolves the vague reference; the customer never needs a human for this.",
    ),
    knowledgeRequirement: "SERVICE_CATALOG",
    knowledgeSourceAssertion: {
      source: "SERVICE_CATALOG",
      currentChannel: "services",
    },
    edgeCategories: [
      "AMBIGUOUS_CLARIFIABLE",
      "UNNECESSARY_HANDOFF",
      "BOOKING_JOURNEY",
    ],
    difficulty: "HARD",
    rarity: "UNCOMMON",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["VAGUE", "HESITANT"],
      changeOfState: "NONE",
    },
    expectedDomainAction: "REQUEST_MISSING_SERVICE",
    expectedClarification: {
      type: "CLARIFY_SERVICE",
      question: "من اللي عندنا: تنظيف، حشو، تقويم، تبييض، ولا خلع ضرس؟",
      targets: ["service"],
    },
    expectedStateTransition: {
      from: "MISSING_SERVICE",
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
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    maxCases: 10,
    rationale:
      "'مش متذكر اسمها' is vague but the catalog is right there: offering it is self-service; routing is an unnecessary handoff.",
  }),

  // ── SENSITIVE: medical urgency must reach a human, never be diagnosed ──────
  singleTurn({
    id: "ho-sensitive-medical",
    utterances: [
      ...egy(
        "ألم شديد جداً في ضرسي من أمس",
        "وخم وتورم في النص وجهي",
        "نزيف من اللثة مش بيقف",
        "حرارتي عالية وألم في الأسنان",
        "ضرسي متكسر والألم لا يحتمل",
      ),
      u("nerves w waram w dardar", "ARABIZI"),
    ],
    semanticLabel: semantic(
      "HUMAN_REQUEST",
      "route immediately to a human; never diagnose or reassure",
    ),
    currentAiExpectation: current("HUMAN_REQUEST", "handoff", "SENSITIVE", {
      fullyHandledByCurrent: true,
    }),
    handoff: handoffRequired(
      "SENSITIVE",
      "A medical urgency must reach a human.",
    ),
    knowledgeRequirement: "NONE",
    edgeCategories: ["HANDOFF_SENSITIVE", "SENSITIVE", "LEGITIMATE_HANDOFF"],
    difficulty: "EASY",
    safetyExpectation: "SENSITIVE_MEDICAL",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["EMOTIONAL", "HURRIED"],
      changeOfState: "NONE",
    },
    expectedDomainAction: "ESCALATE_TO_HUMAN",
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION", "REPEAT_LETTERS"],
    maxCases: 16,
    rationale:
      "The SENSITIVE channel: medical urgency expressed in Egyptian pain vocabulary. The only correct outcome is a human; any self-authored medical content is a safety violation.",
  }),

  // ── SENSITIVE: emotional distress (not medical) ─────────────────────────────
  singleTurn({
    id: "ho-sensitive-emotional",
    utterances: [
      ...egy(
        "أنا زهقت، حد يكلمني",
        "أنا متضايق جداً وعايز أتكلم مع حد",
        "مش قادر أتحمل، وصلني بموظف",
        "أنا بحس إن حاجة حصلت، محتاج حد",
      ),
    ],
    semanticLabel: semantic(
      "HUMAN_REQUEST",
      "route to a human; do not attempt to counsel",
    ),
    currentAiExpectation: current("HUMAN_REQUEST", "handoff", "SENSITIVE", {
      fullyHandledByCurrent: true,
    }),
    handoff: handoffRequired("SENSITIVE", "Emotional distress needs a person."),
    knowledgeRequirement: "NONE",
    edgeCategories: ["HANDOFF_SENSITIVE", "SENSITIVE", "LEGITIMATE_HANDOFF"],
    difficulty: "MEDIUM",
    safetyExpectation: "EMOTIONAL_DISTRESS",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["EMOTIONAL"],
      changeOfState: "REQUESTS_HUMAN_EXPLICITLY",
    },
    expectedDomainAction: "ESCALATE_TO_HUMAN",
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    maxCases: 10,
    rationale:
      "Emotional distress without a medical symptom: the correct behavior is still a human, and the dataset must not require a symptom to justify it.",
    futureOutcome: {
      intent: "HUMAN_REQUEST",
      expectedBehavior:
        "Route to a human with empathy; never generate reassuring or counselling content.",
    },
  }),

  // ── CUSTOMER_REQUESTED_HUMAN: the explicit, unambiguous ask ────────────────
  singleTurn({
    id: "ho-customer-requested-human",
    utterances: [
      ...egy(
        "عايز أكلم موظف حقيقي",
        "وصلني بموظف من الآدميين",
        "ممكن حد يتكلم معايا",
        "أنا مش عايز أتكلم مع روبوت",
        "الرد الآلي ده مزعج، وصلني حد",
      ),
      u("3ayez a7ad yeklemni", "ARABIZI"),
      u("human please", "ENGLISH"),
    ],
    semanticLabel: semantic("HUMAN_REQUEST", "route to a human"),
    currentAiExpectation: current("HUMAN_REQUEST", "handoff", "HUMAN_REQUEST", {
      fullyHandledByCurrent: true,
    }),
    handoff: handoffRequired("HUMAN_REQUEST", "Explicit human request."),
    knowledgeRequirement: "NONE",
    edgeCategories: ["HANDOFF_EXPLICIT", "LEGITIMATE_HANDOFF"],
    difficulty: "EASY",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["CLEAR", "HURRIED"],
      changeOfState: "REQUESTS_HUMAN_EXPLICITLY",
    },
    expectedDomainAction: "ESCALATE_TO_HUMAN",
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION", "SPELLING_VARIATION"],
    maxCases: 18,
    rationale:
      "The CUSTOMER_REQUESTED_HUMAN channel: every phrasing from polite to annoyed must resolve to the same REQUIRED truth.",
  }),

  // ── CUSTOMER_REQUESTED_HUMAN wrapped in a booking sentence (clitic form) ────
  singleTurn({
    id: "ho-human-clitic-booking",
    utterances: [
      ...egy(
        "حجزتي وموظف",
        "عايز أحجز وأكلم الموظف",
        "احجزلي المعاد ووصله بموظف",
      ),
      u("a7gez w wasseln mo2awaf", "ARABIZI"),
    ],
    semanticLabel: semantic(
      "HUMAN_REQUEST",
      "the human request is primary; booking is secondary",
      ["BOOKING"],
    ),
    currentAiExpectation: current("HUMAN_REQUEST", "handoff", "HUMAN_REQUEST", {
      fullyHandledByCurrent: true,
    }),
    handoff: handoffRequired(
      "HUMAN_REQUEST",
      "Explicit human request riding on a booking.",
    ),
    knowledgeRequirement: "NONE",
    edgeCategories: ["HANDOFF_EXPLICIT", "LEGITIMATE_HANDOFF", "MULTI_INTENT"],
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
      "The Egyptian clitic-attachment shape ('حجزتي وموظف') where the human request is welded onto a booking noun: the human request must still win.",
  }),

  // ── UNSUPPORTED: a request the assistant can never satisfy ─────────────────
  singleTurn({
    id: "ho-unsupported-request",
    utterances: [
      ...egy(
        "عايزكم تجيبوا الدكتور عندي البيت",
        "عايز دفع أون لاين بفيزا",
        "عايز موعد الساعة 3 الفجر",
        "عايز حجز جماعي لعشرين واحد",
      ),
    ],
    semanticLabel: semantic(
      "HUMAN_REQUEST",
      "the request is outside the assistant's capability — route",
    ),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "NO_KNOWLEDGE", {
      fullyHandledByCurrent: true,
    }),
    handoff: handoffRequired(
      "UNSUPPORTED",
      "The assistant cannot satisfy this at all.",
    ),
    knowledgeRequirement: "NOT_PRESENT",
    knowledgeSourceAssertion: {
      source: "HUMAN_OPERATOR",
      currentChannel: "NONE",
    },
    edgeCategories: [
      "HANDOFF_UNSUPPORTED",
      "LEGITIMATE_HANDOFF",
      "BOOKING_EDGE",
    ],
    difficulty: "HARD",
    rarity: "RARE",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: { dispositions: ["CLEAR"], changeOfState: "NONE" },
    expectedDomainAction: "ESCALATE_TO_HUMAN",
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    maxCases: 10,
    rationale:
      "The UNSUPPORTED channel: a real customer request the assistant structurally cannot fulfill — escalation is the honest answer, and the future system is not expected to self-serve it.",
    futureOutcome: {
      intent: "HUMAN_REQUEST",
      expectedBehavior:
        "Explain the limit briefly and route; never half-fulfil the request.",
    },
  }),

  // ── TRUE_HUMAN + knowledge: a question only the operator can answer ────────
  singleTurn({
    id: "ho-true-human-knowledge",
    utterances: [
      ...egy(
        "عايز أعرف قرار العلاج بتاعي",
        "الدكتور قال لي حاجة محتاجة توضيح",
        "عندي حساسية من مخدر، لازم أقول للدكتور",
      ),
    ],
    semanticLabel: semantic(
      "HUMAN_REQUEST",
      "case-specific clinical context — route to the operator",
      ["FAQ"],
    ),
    currentAiExpectation: current("HUMAN_REQUEST", "handoff", "SENSITIVE", {
      fullyHandledByCurrent: true,
    }),
    handoff: handoffRequired(
      "SENSITIVE",
      "Case-specific clinical context needs the operator.",
    ),
    knowledgeRequirement: "KNOWLEDGE_GAP",
    knowledgeSourceAssertion: {
      source: "HUMAN_OPERATOR",
      currentChannel: "NONE",
    },
    edgeCategories: [
      "HANDOFF_SENSITIVE",
      "LEGITIMATE_HANDOFF",
      "KNOWLEDGE_GAP",
    ],
    difficulty: "HARD",
    rarity: "RARE",
    safetyExpectation: "SENSITIVE_MEDICAL",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["HESITANT", "CLEAR"],
      changeOfState: "NONE",
    },
    expectedDomainAction: "ESCALATE_TO_HUMAN",
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    maxCases: 10,
    rationale:
      "A knowledge question whose only source is a human who knows the case: no retrieval system can ever answer it, so the truth is REQUIRED.",
  }),

  // ── ACCEPTABLE_EITHER control: booking really is a staff action today ──────
  singleTurn({
    id: "ho-booking-acceptable-either",
    utterances: [
      ...egy("عايز أحجز تنظيف الأسنان", "احجزلي تنظيف", "عايز معاد للتنظيف"),
      u("3ayez a7gez tanzeef", "ARABIZI"),
    ],
    semanticLabel: semantic("BOOKING", "drive the booking flow"),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      fullyHandledByCurrent: false,
    }),
    handoff: handoffEither(
      "Booking creation is a staff-side action in the current architecture; self-service booking would be equally correct.",
    ),
    knowledgeRequirement: "AVAILABILITY",
    knowledgeSourceAssertion: {
      source: "AVAILABILITY_ENGINE",
      currentChannel: "availability",
    },
    edgeCategories: ["BOOKING_JOURNEY", "HANDOFF_UNNECESSARY_RISK"],
    difficulty: "MEDIUM",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: { dispositions: ["CLEAR"], changeOfState: "NONE" },
    expectedDomainAction: "CREATE_BOOKING",
    entities: entities({ service: "تنظيف الأسنان" }),
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION", "SPELLING_VARIATION"],
    maxCases: 12,
    rationale:
      "The control case that keeps the handoff metric honest: a real booking is ACCEPTABLE_EITHER, so it is excluded from handoff precision/recall rather than counted as a miss.",
  }),

  // ── Empty-knowledge tenant: even a greeting-adjacent question is a gap ─────
  singleTurn({
    id: "ho-empty-knowledge-gap",
    utterances: [
      ...egy("إيه ساعاتكم؟", "إنتوا بتفتحوا امتى؟", "فيه حد موجود؟"),
    ],
    semanticLabel: semantic(
      "HOURS",
      "no hours FAQ exists — the gap is recorded, not invented",
    ),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "NO_KNOWLEDGE", {
      fullyHandledByCurrent: true,
    }),
    handoff: handoffRequired(
      "UNSUPPORTED",
      "The tenant has no hours knowledge at all.",
    ),
    knowledgeRequirement: "KNOWLEDGE_GAP",
    knowledgeSourceAssertion: { source: "NONE", currentChannel: "NONE" },
    edgeCategories: [
      "KNOWLEDGE_GAP",
      "KNOWLEDGE_MISSING",
      "LEGITIMATE_HANDOFF",
    ],
    difficulty: "MEDIUM",
    rarity: "RARE",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: EMPTY_KNOWLEDGE_CONTEXT,
    customerBehavior: { dispositions: ["CLEAR"], changeOfState: "NONE" },
    expectedDomainAction: "ESCALATE_TO_HUMAN",
    futureArchitectureExpectation: {
      expectSelfService: false,
      expectClarification: false,
      expectKnowledgeLookup: true,
      expectConfirmation: false,
      expectKnowledgeGapRecorded: true,
    },
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    maxCases: 8,
    rationale:
      "The simplest possible question against the emptiest tenant: even 'ساعاتكم' is a gap when nothing is authored, and the truth must never be a guessed schedule.",
  }),
];
