/**
 * FlowPilot AI Evaluation — egyptian-v1 LANGUAGE-BEHAVIOR scenarios.
 *
 * A register matrix: the SAME semantic goals expressed across Egyptian
 * language behaviors (MSA, mixed Egyptian/MSA, Arabizi, Arabic+English,
 * English, speech-to-text style, abbreviations, very short, fragmented).
 * This is genuine language-coverage variety (dataset principle B), not
 * duplication: each variant exercises the normalizer + keyword tables
 * differently.
 */

import type { Scenario } from "../../schema/scenario-schema";
import {
  current,
  entities,
  handoffEither,
  handoffNotRequired,
  semantic,
  singleTurn,
  u,
} from "./scenario-builders";
import { CLINIC_CONTEXT } from "./shared-context";

export const languageBehaviorScenarios: Scenario[] = [
  // ── Booking across registers ─────────────────────────────────────────────
  singleTurn({
    id: "lb-booking-msa",
    utterances: [
      u("أرغب في حجز موعد", "MSA"),
      u("أود حجز موعد للتنظيف", "MSA"),
      u("أريد حجز موعد يوم الخميس", "MSA"),
      u("هل يمكنني حجز موعد؟", "MSA"),
    ],
    semanticLabel: semantic("BOOKING", "start booking (MSA)"),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    handoff: handoffEither("Booking routed to staff by design."),
    edgeCategories: ["BOOKING_JOURNEY"],
    difficulty: "MEDIUM",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    rationale: "MSA booking phrasings still contain حجز/موعد keywords.",
  }),
  singleTurn({
    id: "lb-booking-mixed",
    utterances: [
      u("أرغب في حجز موعد بس مش عارف الأوقات", "MIXED_EGY_MSA"),
      u("أود حجز موعد وكنت حابب أعرف الأسعار", "MIXED_EGY_MSA"),
      u("عايز أحجز موعد لو تكرمت", "MIXED_EGY_MSA"),
    ],
    semanticLabel: semantic("BOOKING", "start booking (mixed register)"),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    handoff: handoffEither("Booking routed to staff by design."),
    edgeCategories: ["BOOKING_JOURNEY", "MULTI_INTENT"],
    difficulty: "HARD",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    rationale: "MSA verb + Egyptian particles in one sentence.",
  }),
  singleTurn({
    id: "lb-booking-stt",
    utterances: [
      u("انا يعني عايز احجز موعد التنظيف ده", "EGYPTIAN_COLLOQUIAL", [
        "SPEECH_TO_TEXT",
      ]),
      u("طيب انا محتاج احجز ميعاد امتى ينفع", "EGYPTIAN_COLLOQUIAL", [
        "SPEECH_TO_TEXT",
      ]),
      u("بص انا عايز احجز لو سمحت", "EGYPTIAN_COLLOQUIAL", ["SPEECH_TO_TEXT"]),
    ],
    semanticLabel: semantic("BOOKING", "start booking (speech-to-text)"),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    handoff: handoffEither("Booking routed to staff by design."),
    edgeCategories: ["BOOKING_JOURNEY"],
    difficulty: "MEDIUM",
    mutations: ["DROP_PUNCTUATION", "SPEECH_TO_TEXT"],
    rationale: "Run-on, unpunctuated, filler-laden booking requests.",
  }),

  // ── Availability across registers ────────────────────────────────────────
  singleTurn({
    id: "lb-availability-msa",
    utterances: [
      u("ما هي الأوقات المتاحة؟", "MSA"),
      u("متى يمكنني الحضور؟", "MSA"),
      u("هل توجد مواعيد متاحة؟", "MSA"),
    ],
    semanticLabel: semantic("AVAILABILITY", "return real slots (MSA)"),
    currentAiExpectation: current("AVAILABILITY", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    handoff: handoffEither("Availability routed to staff by design."),
    edgeCategories: ["BOOKING_JOURNEY"],
    difficulty: "MEDIUM",
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    rationale: "MSA availability phrasings.",
  }),
  singleTurn({
    id: "lb-availability-arabizi",
    utterances: [
      u("fe maw3ed fady?", "ARABIZI"),
      u("enta khames fady?", "ARABIZI"),
      u("momken a3raf el aw2at el met7a", "ARABIZI"),
    ],
    semanticLabel: semantic("AVAILABILITY", "return real slots (Arabizi)"),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "AMBIGUOUS", {
      architecturalLimitation: true,
    }),
    handoff: handoffEither("Arabizi not covered by the Arabic classifier."),
    edgeCategories: ["BOOKING_JOURNEY"],
    difficulty: "EXTREME",
    orientation: "FUTURE_ARCHITECTURE",
    rarity: "UNCOMMON",
    mutations: [],
    rationale: "Latin-script availability questions.",
  }),

  // ── FAQ across registers ─────────────────────────────────────────────────
  singleTurn({
    id: "lb-faq-msa",
    utterances: [
      u("ما هي ساعات العمل لديكم؟", "MSA"),
      u("هل تقبلون التأمين الطبي؟", "MSA"),
      u("أين تقع العيادة؟", "MSA"),
    ],
    semanticLabel: semantic("FAQ", "answer verbatim (MSA)"),
    currentAiExpectation: current("FAQ", "reply", null, {
      fullyHandledByCurrent: true,
    }),
    knowledgeRequirement: "EXACT_FAQ",
    edgeCategories: ["KNOWLEDGE_EXACT"],
    difficulty: "EASY",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    rationale: "Near-verbatim MSA FAQ questions must match the store.",
  }),
  singleTurn({
    id: "lb-faq-egy-formalish",
    utterances: [
      u("لو سمحت، عايز أعرف ساعات العمل", "EGYPTIAN_FORMALISH"),
      u("من فضلك، هل تقبلوا التأمين الطبي؟", "EGYPTIAN_FORMALISH"),
      u("ممكن أعرف عنوان العيادة؟", "EGYPTIAN_FORMALISH"),
    ],
    semanticLabel: semantic("FAQ", "answer from paraphrase (formal Egyptian)"),
    currentAiExpectation: current("FAQ", "reply", null, {
      fullyHandledByCurrent: true,
    }),
    knowledgeRequirement: "PARAPHRASED_FAQ",
    edgeCategories: ["KNOWLEDGE_PARAPHRASE"],
    difficulty: "MEDIUM",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    rationale: "Polite Egyptian FAQ paraphrases.",
  }),
  singleTurn({
    id: "lb-faq-mixed",
    utterances: [
      u("ساعات العمل ايه بالظبط؟", "MIXED_EGY_MSA"),
      u("التأمين الطبي مقبول ولا لأ؟", "MIXED_EGY_MSA"),
      u("العنوان فين بالظبط لو سمحت", "MIXED_EGY_MSA"),
    ],
    semanticLabel: semantic("FAQ", "answer from paraphrase (mixed)"),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "NO_KNOWLEDGE", {
      architecturalLimitation: true,
    }),
    knowledgeRequirement: "PARAPHRASED_FAQ",
    edgeCategories: ["KNOWLEDGE_PARAPHRASE"],
    difficulty: "HARD",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale:
      "Mixed-register FAQ asks below the token-overlap threshold — measures unnecessary-handoff rate.",
  }),

  // ── Cancellation / reschedule across registers ───────────────────────────
  singleTurn({
    id: "lb-cancel-msa",
    utterances: [
      u("أرغب في إلغاء موعدي", "MSA"),
      u("أود إلغاء الحجز", "MSA"),
      u("لا أستطيع الحضور", "MSA"),
    ],
    semanticLabel: semantic("CANCELLATION", "route cancellation (MSA)"),
    currentAiExpectation: current("CANCELLATION", "booking_handoff", null, {
      fullyHandledByCurrent: true,
    }),
    edgeCategories: ["BOOKING_JOURNEY"],
    difficulty: "MEDIUM",
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    rationale: "MSA cancellation phrasings.",
  }),
  singleTurn({
    id: "lb-reschedule-msa",
    utterances: [
      u("أرغب في تعديل موعد الحجز", "MSA"),
      u("أود تأجيل الموعد", "MSA"),
      u("هل يمكن تغيير موعدي؟", "MSA"),
    ],
    semanticLabel: semantic("RESCHEDULE", "route reschedule (MSA)"),
    currentAiExpectation: current("RESCHEDULE", "booking_handoff", null, {
      fullyHandledByCurrent: true,
    }),
    edgeCategories: ["BOOKING_JOURNEY"],
    difficulty: "MEDIUM",
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    rationale: "MSA reschedule phrasings (mutation word + appointment word).",
  }),

  // ── Greeting across registers ────────────────────────────────────────────
  singleTurn({
    id: "lb-greeting-msa",
    utterances: [
      u("السلام عليكم ورحمة الله", "MSA"),
      u("صباح الخير", "MSA"),
      u("مساء الخير", "MSA"),
      u("أهلاً وسهلاً", "MSA"),
    ],
    semanticLabel: semantic("GREETING", "acknowledge (MSA)"),
    currentAiExpectation: current("GREETING", "reply", null, {
      fullyHandledByCurrent: true,
    }),
    edgeCategories: ["NORMAL"],
    difficulty: "EASY",
    mutations: ["MISSING_HAMZA", "REPEAT_LETTERS"],
    rationale: "MSA greetings must stay AI_ACTIVE.",
  }),
  singleTurn({
    id: "lb-greeting-mixed",
    utterances: [
      u("اهلا وسهلا وكل سنة وانت طيب", "MIXED_EGY_MSA"),
      u("صباح الفل يا فندم", "MIXED_EGY_MSA"),
      u("مساء الورد", "MIXED_EGY_MSA"),
    ],
    semanticLabel: semantic("GREETING", "acknowledge (Egyptian warm)"),
    currentAiExpectation: current("GREETING", "reply", null, {
      fullyHandledByCurrent: true,
    }),
    edgeCategories: ["NORMAL"],
    difficulty: "EASY",
    mutations: ["MISSING_HAMZA"],
    rationale: "Warm Egyptian greetings with no other intent vocabulary.",
  }),

  // ── Human request across registers ───────────────────────────────────────
  singleTurn({
    id: "lb-human-msa",
    utterances: [
      u("أرغب في التحدث إلى موظف", "MSA"),
      u("أود التحدث مع شخص حقيقي", "MSA"),
      u("هل يمكنني التحدث إلى المسؤول؟", "MSA"),
    ],
    semanticLabel: semantic("HUMAN_REQUEST", "hand off (MSA)"),
    currentAiExpectation: current("HUMAN_REQUEST", "handoff", "HUMAN_REQUEST", {
      fullyHandledByCurrent: true,
    }),
    handoff: handoffNotRequired(
      "MSA human request words overlap the human keyword table.",
    ),
    edgeCategories: ["HANDOFF_EXPLICIT"],
    difficulty: "EASY",
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    rationale: "MSA human requests contain موظف/مسؤول keywords.",
  }),

  // ── Abbreviations + fragmented ───────────────────────────────────────────
  singleTurn({
    id: "lb-abbreviated",
    utterances: [
      u("عايز حجز 3ayz a7gez", "ARABIC_ENGLISH"),
      u("موعد + تنظيف", "EGYPTIAN_COLLOQUIAL", ["ABBREVIATIONS"]),
      u("حجز بكرة الصبح", "EGYPTIAN_COLLOQUIAL", ["ABBREVIATIONS"]),
    ],
    semanticLabel: semantic("BOOKING", "start booking (abbreviated)"),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    handoff: handoffEither("Booking routed to staff by design."),
    edgeCategories: ["BOOKING_JOURNEY"],
    difficulty: "HARD",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    rationale: "Telegraphic/abbreviated booking requests.",
  }),
  singleTurn({
    id: "lb-fragmented",
    utterances: [
      u("تنظيف... الخميس... الصبح", "EGYPTIAN_COLLOQUIAL", ["FRAGMENTED"]),
      u("حجز. بكرة. 10 الصبح", "EGYPTIAN_COLLOQUIAL", ["FRAGMENTED"]),
      u("تقويم للأطفال بس مش عارف السعر", "EGYPTIAN_COLLOQUIAL", [
        "FRAGMENTED",
      ]),
    ],
    semanticLabel: semantic("BOOKING", "assemble fragments into a booking"),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    entities: entities({ service: "تنظيف الأسنان" }),
    handoff: handoffEither("Fragmented booking still routes to staff."),
    edgeCategories: ["PARTIAL_INFORMATION", "BOOKING_JOURNEY"],
    difficulty: "EXTREME",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale:
      "Elliptical multi-fragment messages; a future arch would fuse the fragments.",
  }),

  // ── English full turns (service discovery / FAQ / booking) ───────────────
  singleTurn({
    id: "lb-english-faq",
    utterances: [
      u("what are your working hours?", "ENGLISH"),
      u("do you accept insurance?", "ENGLISH"),
      u("where is the clinic?", "ENGLISH"),
    ],
    semanticLabel: semantic("FAQ", "answer verbatim (English)"),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "NO_KNOWLEDGE", {
      architecturalLimitation: true,
    }),
    knowledgeRequirement: "EXACT_FAQ",
    handoff: handoffEither("English FAQ questions miss the Arabic matcher."),
    edgeCategories: ["KNOWLEDGE_EXACT"],
    difficulty: "HARD",
    orientation: "FUTURE_ARCHITECTURE",
    rarity: "UNCOMMON",
    businessContext: CLINIC_CONTEXT,
    mutations: [],
    rationale: "English FAQ asks the knowledge store cannot match.",
  }),
  singleTurn({
    id: "lb-english-human",
    utterances: [
      u("I want to speak to a human", "ENGLISH"),
      u("please connect me to an agent", "ENGLISH"),
    ],
    semanticLabel: semantic("HUMAN_REQUEST", "hand off (English)"),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "AMBIGUOUS", {
      architecturalLimitation: true,
    }),
    handoff: handoffEither("English human request — still hands off (safe)."),
    edgeCategories: ["HANDOFF_EXPLICIT"],
    difficulty: "MEDIUM",
    orientation: "FUTURE_ARCHITECTURE",
    rarity: "UNCOMMON",
    mutations: [],
    rationale:
      "English human request lands on ambiguous handoff — safe outcome.",
  }),

  // ── Service names with colloquial variants (extraction robustness) ───────
  singleTurn({
    id: "lb-service-variants",
    utterances: [
      u("عايز أحجز تننظيف الأسنان", "EGYPTIAN_COLLOQUIAL", ["TYPOS"]),
      u("عايز أحجز تنظيف الاسنان", "EGYPTIAN_COLLOQUIAL", ["MISSING_HAMZA"]),
      u("عايز أحجز تنيضف الأسنان", "EGYPTIAN_COLLOQUIAL", ["TYPOS"]),
      u("عايز حجز التقويم", "EGYPTIAN_COLLOQUIAL"),
    ],
    semanticLabel: semantic("BOOKING", "extract service despite misspelling"),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    entities: entities({ service: "تنظيف الأسنان" }),
    handoff: handoffEither("Booking routed to staff by design."),
    edgeCategories: ["BOOKING_JOURNEY", "KEYBOARD_MISTAKE"],
    difficulty: "HARD",
    businessContext: CLINIC_CONTEXT,
    mutations: ["DROP_PUNCTUATION"],
    rationale:
      "Misspelled service names test verbatim service extraction (نormalizer does not repair typos).",
  }),

  // ── Noise-only stress (punctuation + repetition on a FAQ ask) ───────────
  singleTurn({
    id: "lb-noise-stress-faq",
    utterances: [
      u("ماااا هي ساعات العمل؟؟؟", "EGYPTIAN_COLLOQUIAL", [
        "REPEATED_LETTERS",
        "INFORMAL_PUNCTUATION",
      ]),
      u("ساعات العمل !!!", "EGYPTIAN_COLLOQUIAL", ["INFORMAL_PUNCTUATION"]),
      u("التأميييين مقبول؟", "EGYPTIAN_COLLOQUIAL", ["REPEATED_LETTERS"]),
    ],
    semanticLabel: semantic("FAQ", "answer despite orthographic noise"),
    currentAiExpectation: current("FAQ", "reply", null, {
      fullyHandledByCurrent: true,
    }),
    knowledgeRequirement: "EXACT_FAQ",
    edgeCategories: ["KNOWLEDGE_EXACT"],
    difficulty: "HARD",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale: "Repeated letters + informal punctuation on FAQ asks.",
  }),
];
