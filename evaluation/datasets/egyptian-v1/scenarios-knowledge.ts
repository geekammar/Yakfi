/**
 * FlowPilot AI Evaluation — egyptian-v1 KNOWLEDGE scenarios
 * (PROMPT-AI-EVAL-02).
 *
 * The full knowledge model in data: what a turn NEEDS
 * (`expectedKnowledgeRequirement`) versus what the context SUPPLIES
 * (`knowledgeSourceAssertion.source` + `currentChannel`). A required fact
 * whose `currentChannel` is NONE is a documented ARCHITECTURE GAP — not a
 * dataset defect — and is how a knowledge gap is represented without any
 * retrieval system being built.
 *
 * For every KNOWLEDGE_GAP case the dataset also sets
 * `futureArchitectureExpectation.expectKnowledgeGapRecorded`, which is the
 * label a future self-improvement loop keys on:
 *
 *   customer question → gap → human answer → candidate → approved → regression
 *
 * That loop is NOT implemented here (schema-only, per the slice hard-stop);
 * the dataset preserves the evidence it will need.
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

export const knowledgeScenarios: Scenario[] = [
  // ── SERVICE_CATALOG: "what do you offer?" (answerable, NO handoff) ──────────
  singleTurn({
    id: "kn-service-catalog",
    utterances: [
      ...egy(
        "إيه الخدمات اللي عندكم؟",
        "ممكن أعرف بتقدموا ايه؟",
        "الخدمات اللي موجودة عندكم ايه",
        "عندكم خدمات ايه؟",
        "هو عندكم تنظيف وتقويم؟",
        "ايه اللي بتعملوه عندكم؟",
      ),
      u("eih el services 3andoko?", "ARABIZI"),
      u("what services do you have?", "ENGLISH"),
      u("عايز أعرف services كام موجود", "ARABIC_ENGLISH", ["MIXED_LANGUAGE"]),
    ],
    semanticLabel: semantic(
      "SERVICE_DISCOVERY",
      "list the services from the catalog",
    ),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "NO_KNOWLEDGE", {
      architecturalLimitation: true,
    }),
    handoff: handoffNotRequired(
      "The catalog is in the service store; the assistant can list it itself.",
    ),
    knowledgeRequirement: "SERVICE_CATALOG",
    knowledgeSourceAssertion: {
      source: "SERVICE_CATALOG",
      currentChannel: "services",
    },
    edgeCategories: ["KNOWLEDGE_EXACT", "UNNECESSARY_HANDOFF"],
    difficulty: "MEDIUM",
    rarity: "COMMON",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["CURIOUS", "CLEAR"],
      changeOfState: "NONE",
    },
    expectedDomainAction: "REPLY_FROM_KNOWLEDGE",
    expectedClarification: { type: "NONE", targets: [] },
    futureArchitectureExpectation: {
      expectSelfService: true,
      expectClarification: false,
      expectKnowledgeLookup: true,
      expectConfirmation: false,
      expectKnowledgeGapRecorded: false,
    },
    mutations: [
      "MISSING_HAMZA",
      "DROP_PUNCTUATION",
      "SPELLING_VARIATION",
      "KEYBOARD_MISTAKE",
    ],
    maxCases: 20,
    rationale:
      "The single highest-frequency knowledge question in Egyptian channels. The service list is exposed through AiRequest.services, so a handoff here is unnecessary — this is the direct probe for the known weakness.",
  }),

  // ── SERVICE_DETAILS: duration / how-it-works (partially exposed) ────────────
  singleTurn({
    id: "kn-service-details-duration",
    utterances: [
      ...egy(
        "تنظيف الأسنان بياخد وقت قد إيه؟",
        "التقويم بيعيش كام ساعة؟",
        "الحشو أقصى مدته كام؟",
        "التبييض محتاج جلسات كتير؟",
        "خلع الضهر ساعة كام؟",
      ),
      u("el tanzeef byakhod add eih?", "ARABIZI"),
    ],
    semanticLabel: semantic(
      "SERVICE_INFO",
      "answer the duration from the service record",
    ),
    currentAiExpectation: current("FAQ", "reply", null, {
      architecturalLimitation: true,
    }),
    handoff: handoffNotRequired(
      "Duration is part of the service record; the assistant can answer directly.",
    ),
    knowledgeRequirement: "SERVICE_DETAILS",
    knowledgeSourceAssertion: {
      source: "SERVICE_DETAILS",
      currentChannel: "services",
    },
    edgeCategories: ["KNOWLEDGE_EXACT", "SERVICE_NAME_ENGLISH"],
    difficulty: "MEDIUM",
    rarity: "COMMON",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: { dispositions: ["CURIOUS"], changeOfState: "NONE" },
    expectedDomainAction: "REPLY_FROM_KNOWLEDGE",
    futureArchitectureExpectation: {
      expectSelfService: true,
      expectClarification: false,
      expectKnowledgeLookup: true,
      expectConfirmation: false,
      expectKnowledgeGapRecorded: false,
    },
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION", "SPELLING_VARIATION"],
    maxCases: 14,
    rationale:
      "Duration is carried on the service record, so 'how long does it take' is answerable — a question about process details (not duration) is the gap variant below.",
  }),

  singleTurn({
    id: "kn-service-details-process",
    utterances: [
      ...egy(
        "التقويم بيمشي إزاي بالظبط؟",
        "تنظيف الأسنان بيعملوا فيه إيه؟",
        "التبييض خطواته ايه؟",
        "الحشو بيترمم إزاي؟",
      ),
    ],
    semanticLabel: semantic(
      "SERVICE_INFO",
      "admit the gap; process detail is not in the catalog",
    ),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "NO_KNOWLEDGE", {
      architecturalLimitation: true,
    }),
    handoff: handoffEither(
      "Process detail has no channel today; routing to staff is defensible but so is a honest 'I don't know'.",
    ),
    knowledgeRequirement: "KNOWLEDGE_GAP",
    knowledgeSourceAssertion: {
      source: "SERVICE_DETAILS",
      currentChannel: "NONE",
    },
    edgeCategories: ["KNOWLEDGE_GAP", "KNOWLEDGE_NOT_EXPOSED"],
    difficulty: "HARD",
    rarity: "UNCOMMON",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: { dispositions: ["CURIOUS"], changeOfState: "NONE" },
    expectedDomainAction: "ESCALATE_TO_HUMAN",
    futureArchitectureExpectation: {
      expectSelfService: false,
      expectClarification: false,
      expectKnowledgeLookup: true,
      expectConfirmation: false,
      expectKnowledgeGapRecorded: true,
    },
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    maxCases: 12,
    rationale:
      "The gap twin of the duration case: the same service-detail family, but no channel carries the answer, so the gap is recorded for the self-improvement loop.",
    futureOutcome: {
      intent: "SERVICE_INFO",
      expectedBehavior:
        "Either answer from authored service detail or record the gap and route; never invent a process description.",
    },
  }),

  // ── PRICE: the canonical knowledge gap ──────────────────────────────────────
  singleTurn({
    id: "kn-price-gap",
    utterances: [
      ...egy(
        "تنظيف الأسنان بكام؟",
        "سعر التقويم كام؟",
        "الحشو بيكلف كام؟",
        "أسعاركم ايه؟",
        "التبييض بكام الجلسة؟",
        "خلع الضرس سعره قد إيه؟",
      ),
      u("el tanzeef bekam?", "ARABIZI"),
      u("price of cleaning?", "ENGLISH"),
      u("عايز أعرف price التنظيف", "ARABIC_ENGLISH", ["MIXED_LANGUAGE"]),
    ],
    semanticLabel: semantic(
      "SERVICE_PRICE",
      "never invent a price; record the gap and route honestly",
    ),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "NO_KNOWLEDGE", {
      architecturalLimitation: true,
    }),
    handoff: handoffEither(
      "No price list channel exists; routing to staff to quote is honest. So is admitting the gap.",
    ),
    knowledgeRequirement: "KNOWLEDGE_GAP",
    knowledgeSourceAssertion: { source: "PRICE_LIST", currentChannel: "NONE" },
    edgeCategories: [
      "KNOWLEDGE_GAP",
      "KNOWLEDGE_NOT_EXPOSED",
      "KNOWLEDGE_MISSING",
    ],
    difficulty: "HARD",
    rarity: "COMMON",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
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
    futureOutcome: {
      intent: "SERVICE_PRICE",
      expectedBehavior:
        "Quote from a price list when one exists; otherwise record the gap and route. Never fabricate a number.",
    },
    mutations: [
      "MISSING_HAMZA",
      "DROP_PUNCTUATION",
      "SPELLING_VARIATION",
      "MIXED_NUMERALS",
    ],
    maxCases: 20,
    rationale:
      "The price family: the highest-value knowledge-gap cell, because a fabricated price is the most damaging hallucination a booking assistant can produce.",
  }),

  // ── POLICY: cancellation / late / insurance policy ──────────────────────────
  singleTurn({
    id: "kn-policy-gap",
    utterances: [
      ...egy(
        "لو جالي ظرف وعجزت أجي بيحصل إيه؟",
        "إيه سياسة الإلغاء عندكم؟",
        "لو اتأخرت على المعاد؟",
        "فيه رسوم إلغاء؟",
        "لو عايز أرجع المعاد قبلها بيوم؟",
      ),
    ],
    semanticLabel: semantic(
      "FAQ",
      "answer the policy if authored; otherwise record the gap",
    ),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "NO_KNOWLEDGE", {
      architecturalLimitation: true,
    }),
    handoff: handoffEither(
      "No cancellation-policy channel exists today; either outcome is honest.",
    ),
    knowledgeRequirement: "POLICY",
    knowledgeSourceAssertion: {
      source: "CANCELLATION_POLICY",
      currentChannel: "NONE",
    },
    edgeCategories: [
      "KNOWLEDGE_GAP",
      "KNOWLEDGE_NOT_EXPOSED",
      "CANCELLATION_EDGE",
    ],
    difficulty: "HARD",
    rarity: "COMMON",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["HESITANT", "CLEAR"],
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
    maxCases: 14,
    rationale:
      "Policy questions are the second knowledge-gap family: the customer's phrasing is idiomatic Egyptian ('لو جالي ظرف') and must not be answered with an invented policy.",
  }),

  // ── AVAILABILITY as a knowledge requirement ─────────────────────────────────
  singleTurn({
    id: "kn-availability-direct",
    utterances: [
      ...egy(
        "فيه معاد فاضي بكرة؟",
        "إمتى أقدر أجي النظافة؟",
        "المتاح لتقويم الأسنان امتى؟",
        "أول معاد فاضي إمتى؟",
        "فيه حجز مفتوح الخميس؟",
      ),
      u("fi maw3ed fady bokra?", "ARABIZI"),
    ],
    semanticLabel: semantic(
      "AVAILABILITY",
      "resolve from the availability engine",
    ),
    currentAiExpectation: current("AVAILABILITY", "handoff", null, {
      fullyHandledByCurrent: false,
    }),
    handoff: handoffEither(
      "Availability is resolved by the engine; the current arch routes it to staff.",
    ),
    knowledgeRequirement: "AVAILABILITY",
    knowledgeSourceAssertion: {
      source: "AVAILABILITY_ENGINE",
      currentChannel: "availability",
    },
    edgeCategories: ["AVAILABILITY_EDGE", "KNOWLEDGE_EXACT"],
    difficulty: "MEDIUM",
    rarity: "COMMON",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["CLEAR", "HURRIED"],
      changeOfState: "NONE",
    },
    expectedDomainAction: "RESOLVE_AVAILABILITY",
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION", "MIXED_NUMERALS"],
    maxCases: 14,
    rationale:
      "Availability is the one knowledge family the current architecture DOES expose through a channel — so a miss here is a real failure, not a limitation.",
  }),

  // ── MULTIPLE_SOURCES: an answer that needs two stores ──────────────────────
  singleTurn({
    id: "kn-multiple-sources",
    utterances: [
      ...egy(
        "العنوان بتاعكم ايه وساعاتكم كام؟",
        "التقويم موجود والعيادة فين؟",
        "فيه موقف عربيات وبتفتحوا لحد امتى؟",
        "التنظيف موجود، وسعره كام؟",
      ),
    ],
    semanticLabel: semantic(
      "FAQ",
      "compose an answer from more than one knowledge source",
    ),
    currentAiExpectation: current("FAQ", "reply", null, {
      architecturalLimitation: true,
    }),
    handoff: handoffNotRequired(
      "Both facts are in the FAQ store; the assistant can compose the answer.",
    ),
    knowledgeRequirement: "MULTIPLE_SOURCES",
    knowledgeSourceAssertion: {
      source: "MULTIPLE_SOURCES",
      currentChannel: "faqs",
    },
    edgeCategories: ["KNOWLEDGE_MULTIPLE", "MULTIPLE_ENTITIES"],
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
      "A turn whose answer must join two stored facts; answering only one half is a partial answer and counts as a failure.",
  }),

  // ── NO_FAQ: an empty knowledge base (honest handoff) ────────────────────────
  singleTurn({
    id: "kn-no-faq-empty-kb",
    utterances: [
      ...egy("عندكم خدمة كذا؟", "بتقدموا نوع معين؟", "فيه عرض خاص دلوقتي؟"),
    ],
    semanticLabel: semantic(
      "FAQ",
      "no knowledge exists at all — route honestly",
    ),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "NO_KNOWLEDGE", {
      fullyHandledByCurrent: true,
    }),
    handoff: handoffRequired(
      "UNSUPPORTED",
      "No knowledge store exists to answer from.",
    ),
    knowledgeRequirement: "NO_FAQ",
    knowledgeSourceAssertion: { source: "NONE", currentChannel: "NONE" },
    edgeCategories: ["KNOWLEDGE_MISSING", "LEGITIMATE_HANDOFF"],
    difficulty: "MEDIUM",
    rarity: "RARE",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: EMPTY_KNOWLEDGE_CONTEXT,
    customerBehavior: { dispositions: ["CURIOUS"], changeOfState: "NONE" },
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
      "A business with an empty knowledge base: the correct behavior is the honest gap, and the gap is recorded.",
  }),

  // ── WEAK_FAQ: a near-miss the matcher should not over-trust ─────────────────
  singleTurn({
    id: "kn-weak-faq-near-miss",
    utterances: [
      ...egy(
        "أنا شغال في شركة عندها تأمين، بتقبلوا؟",
        "عندي بطاقة تأمين من شركة تانية، تنفع؟",
        "التأمين بتاعي مشغطط، ممكن؟",
      ),
    ],
    semanticLabel: semantic(
      "FAQ",
      "weak similarity to the insurance FAQ — answer carefully, do not bluff",
    ),
    currentAiExpectation: current("FAQ", "reply", null, {
      architecturalLimitation: true,
    }),
    handoff: handoffEither(
      "The stored answer covers most cases but not the specifics; either resolving or routing is honest.",
    ),
    knowledgeRequirement: "WEAK_FAQ",
    knowledgeSourceAssertion: { source: "FAQ_STORE", currentChannel: "faqs" },
    edgeCategories: ["KNOWLEDGE_WEAK", "KNOWLEDGE_PARAPHRASE"],
    difficulty: "HARD",
    rarity: "UNCOMMON",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["HESITANT", "CLEAR"],
      changeOfState: "NONE",
    },
    expectedDomainAction: "REPLY_FROM_KNOWLEDGE",
    futureArchitectureExpectation: {
      expectSelfService: true,
      expectClarification: true,
      expectKnowledgeLookup: true,
      expectConfirmation: false,
      expectKnowledgeGapRecorded: false,
    },
    expectedClarification: {
      type: "CONFIRM_UNDERSTOOD_REQUEST",
      question: "تقصد بطاقة تأمين من شركة معينة؟",
      targets: [],
    },
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    maxCases: 10,
    rationale:
      "A near-miss paraphrase: the words overlap the insurance FAQ but the customer's situation differs, so over-trusting the match would mis-answer.",
  }),

  // ── MULTIPLE_PLAUSIBLE: two FAQs could answer, only one is right ────────────
  singleTurn({
    id: "kn-multiple-plausible",
    utterances: [
      ...egy(
        "أنا عايز أعرف عن تقويم العيال، وإنتوا فين بالظبط؟",
        "التقويم للأطفال بيتباع كام، وعندكم موقف؟",
      ),
    ],
    semanticLabel: semantic(
      "FAQ",
      "two plausible FAQs — disambiguate before answering",
    ),
    currentAiExpectation: current("FAQ", "reply", null, {
      architecturalLimitation: true,
    }),
    handoff: handoffNotRequired(
      "Both facts are stored; the assistant should answer the right one or ask which.",
    ),
    knowledgeRequirement: "MULTIPLE_PLAUSIBLE",
    knowledgeSourceAssertion: {
      source: "MULTIPLE_SOURCES",
      currentChannel: "faqs",
    },
    edgeCategories: [
      "KNOWLEDGE_MULTIPLE",
      "MULTIPLE_ENTITIES",
      "AMBIGUOUS_CLARIFIABLE",
    ],
    difficulty: "EXTREME",
    rarity: "RARE",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["CURIOUS", "HESITANT"],
      changeOfState: "NONE",
    },
    expectedDomainAction: "REPLY_FROM_KNOWLEDGE",
    expectedClarification: {
      type: "CLARIFY_DISAMBIGUATE_MULTI_INTENT",
      question: "أول سؤال عن تقويم الأطفال ولا العنوان؟",
      targets: [],
    },
    futureArchitectureExpectation: {
      expectSelfService: true,
      expectClarification: true,
      expectKnowledgeLookup: true,
      expectConfirmation: false,
      expectKnowledgeGapRecorded: false,
    },
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    maxCases: 8,
    rationale:
      "Two stored FAQs are both plausible: the ideal assistant answers in order or disambiguates, never picks one silently.",
  }),

  // ── NOT_EXPOSED: knowledge that must NEVER be disclosed ────────────────────
  singleTurn({
    id: "kn-not-exposed-revenue",
    utterances: [
      ...egy(
        "إيه أرباح العيادة في الشهر؟",
        "دخلوا كام الشهر ده؟",
        "كام عدد العملاء بتوعكم؟",
        "إيه أسماء الدكاترة عندهم شركات؟",
      ),
    ],
    semanticLabel: semantic(
      "FAQ",
      "politely decline — business-internal data is never disclosed",
    ),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "AMBIGUOUS", {
      fullyHandledByCurrent: true,
    }),
    handoff: handoffNotRequired(
      "The assistant declines; a human is not required for a refusal.",
    ),
    knowledgeRequirement: "NOT_EXPOSED",
    knowledgeSourceAssertion: { source: "NONE", currentChannel: "NONE" },
    edgeCategories: ["KNOWLEDGE_NOT_EXPOSED", "ADVERSARIAL"],
    difficulty: "MEDIUM",
    rarity: "RARE",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: { dispositions: ["CURIOUS"], changeOfState: "NONE" },
    expectedDomainAction: "NONE",
    safetyExpectation: "SAFE",
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    maxCases: 10,
    rationale:
      "Business-internal data must never be disclosed. The correct behavior is a polite refusal — not a handoff, and never a number.",
  }),

  // ── PARAPHRASE depth: business-info questions the matcher must catch ──────
  singleTurn({
    id: "kn-business-info-paraphrase",
    utterances: [
      ...egy(
        "أنا رايح العيادة، أركن فين؟",
        "أقرب موقف ليكم فين؟",
        "بجوار المحطة صح؟",
        "الدور التالت إزاي أوصل؟",
      ),
    ],
    semanticLabel: semantic(
      "LOCATION",
      "answer from the address FAQ despite a very different wording",
    ),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "NO_KNOWLEDGE", {
      architecturalLimitation: true,
    }),
    handoff: handoffNotRequired(
      "The address FAQ is stored; the assistant can answer despite weak lexical overlap.",
    ),
    knowledgeRequirement: "PARAPHRASED_FAQ",
    knowledgeSourceAssertion: {
      source: "BUSINESS_INFO",
      currentChannel: "faqs",
    },
    edgeCategories: ["KNOWLEDGE_PARAPHRASE", "LANGUAGE_VARIATION"],
    difficulty: "HARD",
    rarity: "COMMON",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["CLEAR", "HURRIED"],
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
      "Location questions phrased as navigation needs ('أركن فين') rather than FAQ-shaped questions — the classic unnecessary-handoff shape.",
  }),

  // ── Repeated gap (the self-improvement recurrence signal) ───────────────────
  multiTurn({
    id: "kn-gap-recurrence",
    contextTurns: [
      { senderType: "CUSTOMER", text: "تنظيف الأسنان بكام؟" },
      {
        senderType: "AI",
        text: "للأسف لا أملك قائمة الأسعار — سأحولك لموظف للإفادة.",
      },
      {
        senderType: "STAFF",
        text: "أهلاً بك — التنظيف بـ 300 جنيه ويشمل إزالة الجير.",
      },
      { senderType: "CUSTOMER", text: "تمام، شكراً" },
      {
        senderType: "AI",
        text: "سعيد بمساعدتك! تحتاج أي شيء آخر؟",
      },
    ],
    utterances: [
      ...egy(
        "والتقويم بكام؟",
        "وحشو الضرس سعره كام؟",
        "التبييض كام زي التنظيف؟",
      ),
    ],
    semanticLabel: semantic(
      "SERVICE_PRICE",
      "the same gap shape recurs after a human resolution",
    ),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "NO_KNOWLEDGE", {
      architecturalLimitation: true,
    }),
    conversationState: {
      knownEntities: entities({ service: null }),
      requiresMemory: true,
      expectedStatus: "NEED_HUMAN",
    },
    handoff: handoffEither(
      "The gap repeats after one human resolution; routing again is honest, but the recurrence is the signal a self-improvement loop keys on.",
    ),
    knowledgeRequirement: "KNOWLEDGE_GAP",
    knowledgeSourceAssertion: { source: "PRICE_LIST", currentChannel: "NONE" },
    edgeCategories: [
      "KNOWLEDGE_GAP",
      "REPETITION",
      "FOLLOW_UP",
      "LONG_CONTEXT",
    ],
    difficulty: "EXTREME",
    rarity: "RARE",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: {
      dispositions: ["REPETITIVE", "CURIOUS"],
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
      "The recurrence shape: the customer already asked, a human answered, and the same gap returns for the next service. This is the evidence a repeated-question-pattern detector needs.",
  }),

  // ── Sparse tenant: a service the catalog simply does not list ──────────────
  singleTurn({
    id: "kn-service-not-in-catalog",
    utterances: [
      ...egy(
        "بتعملوا حمام كريم للشعر؟",
        "عندكم مانيكير وباديكير؟",
        "صبغة شعر بألوان خاصة؟",
      ),
    ],
    semanticLabel: semantic(
      "SERVICE_DISCOVERY",
      "the service is absent from the catalog — do not invent it",
    ),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "NO_KNOWLEDGE", {
      fullyHandledByCurrent: true,
    }),
    handoff: handoffEither(
      "The catalog lists no such service; routing to confirm is honest.",
    ),
    knowledgeRequirement: "NOT_PRESENT",
    knowledgeSourceAssertion: {
      source: "SERVICE_CATALOG",
      currentChannel: "services",
    },
    edgeCategories: ["KNOWLEDGE_MISSING", "SERVICE_NAME_ENGLISH"],
    difficulty: "MEDIUM",
    rarity: "UNCOMMON",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: SPARSE_CONTEXT,
    customerBehavior: { dispositions: ["CURIOUS"], changeOfState: "NONE" },
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
      "A service the catalog does not list: absence of a match must not become an invented 'yes' or 'no'.",
  }),

  // ── BUSINESS_INFO: questions about the business itself ─────────────────────
  singleTurn({
    id: "kn-business-about",
    utterances: [
      ...egy(
        "إيه قصة العيادة دي؟",
        "العيادة تابعة لمين؟",
        "من كم سنة أنتم شغالين هنا",
        "كم فرع عندكم؟",
        "إيه تخصص العيادة الأساسي",
      ),
    ],
    semanticLabel: semantic(
      "BUSINESS_INFO",
      "answer from business information, or record the gap",
    ),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "NO_KNOWLEDGE", {
      architecturalLimitation: true,
    }),
    handoff: handoffEither(
      "Business-profile facts have no dedicated channel today; routing is defensible, but so is an honest 'I don't know'.",
    ),
    knowledgeRequirement: "BUSINESS_INFO",
    knowledgeSourceAssertion: {
      source: "BUSINESS_INFO",
      currentChannel: "NONE",
    },
    edgeCategories: ["KNOWLEDGE_GAP", "KNOWLEDGE_NOT_EXPOSED"],
    difficulty: "MEDIUM",
    rarity: "UNCOMMON",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    customerBehavior: { dispositions: ["CURIOUS"], changeOfState: "NONE" },
    expectedDomainAction: "ESCALATE_TO_HUMAN",
    futureArchitectureExpectation: {
      expectSelfService: false,
      expectClarification: false,
      expectKnowledgeLookup: true,
      expectConfirmation: false,
      expectKnowledgeGapRecorded: true,
    },
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    maxCases: 12,
    rationale:
      "Business-profile questions (history, ownership, branches, specialty) have no channel at all — the thinnest populated intent cell in the dataset, filled deliberately.",
  }),
];
