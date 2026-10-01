/**
 * FlowPilot AI Evaluation — egyptian-v1 SINGLE-TURN scenarios.
 *
 * Gold-first Egyptian scenarios covering greetings, FAQ (exact/paraphrase/
 * weak/missing), booking, availability, reschedule, cancellation, explicit
 * human requests, sensitive turns, ambiguity, and the FUTURE evaluation
 * categories (service discovery/info/price, business info, location, hours).
 *
 * `expectedCurrentAiOutcome` encodes the CORRECT behavior achievable in the
 * current 8-intent contract. Where the current architecture cannot represent
 * the customer's real goal (price, service discovery, clarifiable ambiguity),
 * `architecturalLimitation` is set — the mutated variants generated on top of
 * each utterance are what surface dialect/noise failures at baseline time.
 */

import type { Scenario } from "../../schema/scenario-schema";
import {
  current,
  egy,
  entities,
  handoffEither,
  handoffNotRequired,
  handoffRequired,
  semantic,
  singleTurn,
  u,
} from "./scenario-builders";
import { CLINIC_CONTEXT, EMPTY_KNOWLEDGE_CONTEXT } from "./shared-context";

export const singleTurnScenarios: Scenario[] = [
  // ── A. GREETING ────────────────────────────────────────────────────────
  singleTurn({
    id: "st-greeting-basic",
    utterances: [
      ...egy("السلام عليكم", "أهلاً", "صباح الخير", "مساء الخير", "ازيك"),
      u("hello", "ENGLISH"),
      u("hi 3amo", "ARABIZI"),
    ],
    semanticLabel: semantic("GREETING", "acknowledge and invite to continue"),
    currentAiExpectation: current("GREETING", "reply", null, {
      fullyHandledByCurrent: true,
    }),
    edgeCategories: ["NORMAL"],
    difficulty: "EASY",
    knowledgeRequirement: "NONE",
    mutations: ["MISSING_HAMZA", "REPEAT_LETTERS", "TYPO"],
    maxCases: 12,
    rationale:
      "Pure social openings must stay AI_ACTIVE and never spend a provider call.",
  }),

  // ── B. FAQ — exact match ─────────────────────────────────────────────────
  singleTurn({
    id: "st-faq-hours-exact",
    utterances: egy(
      "ما هي ساعات العمل؟",
      "ساعات العمل ايه؟",
      "بتفتحوا الساعة كام؟",
      "المواعيد بتاعتكم ايه؟",
    ),
    semanticLabel: semantic("HOURS", "answer verbatim from stored FAQ"),
    currentAiExpectation: current("FAQ", "reply", null, {
      fullyHandledByCurrent: true,
    }),
    knowledgeRequirement: "EXACT_FAQ",
    edgeCategories: ["KNOWLEDGE_EXACT"],
    difficulty: "EASY",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION", "TYPO", "REPEAT_LETTERS"],
    maxCases: 12,
    rationale:
      "Stored hours FAQ must be answered verbatim; messy variants test the token overlap threshold.",
  }),
  singleTurn({
    id: "st-faq-insurance-exact",
    utterances: egy(
      "هل تقبلون التأمين الطبي؟",
      "بتاخدوا تأمين؟",
      "في تأمين طبي عندكم؟",
    ),
    semanticLabel: semantic("FAQ", "answer verbatim from stored FAQ"),
    currentAiExpectation: current("FAQ", "reply", null, {
      fullyHandledByCurrent: true,
    }),
    knowledgeRequirement: "EXACT_FAQ",
    edgeCategories: ["KNOWLEDGE_EXACT"],
    difficulty: "EASY",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    rationale: "Insurance FAQ exact + colloquial rephrasings.",
  }),
  singleTurn({
    id: "st-faq-parking-paraphrase",
    utterances: egy(
      "أقدر أركن العربية فين؟",
      "في مكان أركن فيه؟",
      "عندكم جراج للعربيات؟",
    ),
    semanticLabel: semantic("FAQ", "answer from paraphrased FAQ"),
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
      "Parking FAQ paraphrased with words that don't token-overlap the stored question — current token matcher likely misses it (unnecessary handoff).",
    futureOutcome: {
      intent: "FAQ",
      expectedBehavior:
        "Semantic match to the parking FAQ and answer directly.",
    },
  }),
  singleTurn({
    id: "st-faq-orthodontics-kids-paraphrase",
    utterances: egy(
      "بتعملوا تقويم لعيالي الصغيرين؟",
      "ابني عايز يركب تقويم ينفع؟",
    ),
    semanticLabel: semantic("SERVICE_INFO", "answer from paraphrased FAQ"),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    knowledgeRequirement: "PARAPHRASED_FAQ",
    edgeCategories: ["KNOWLEDGE_PARAPHRASE", "SERVICE_NAME_ENGLISH"],
    difficulty: "HARD",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale:
      "Kids-orthodontics FAQ paraphrase; current arch may catch a booking word and route to booking instead of answering knowledge.",
  }),

  // ── FAQ — weak / no match ────────────────────────────────────────────────
  singleTurn({
    id: "st-faq-no-match-empty-kb",
    utterances: egy("هل عندكم زراعة أسنان؟", "بتعملوا زراعة؟"),
    semanticLabel: semantic("SERVICE_INFO", "no knowledge → route to human"),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "NO_KNOWLEDGE", {
      fullyHandledByCurrent: true,
    }),
    knowledgeRequirement: "NOT_PRESENT",
    edgeCategories: ["KNOWLEDGE_MISSING"],
    difficulty: "MEDIUM",
    businessContext: EMPTY_KNOWLEDGE_CONTEXT,
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    rationale:
      "A question with no matching knowledge must never be fabricated — a NO_KNOWLEDGE handoff is correct.",
  }),

  // ── C. BOOKING ───────────────────────────────────────────────────────────
  singleTurn({
    id: "st-booking-basic",
    utterances: egy(
      "عايز أحجز موعد",
      "ممكن أحجز؟",
      "محتاج حجز",
      "عايز ميعاد",
      "نفسي أحجز عندكم",
    ),
    semanticLabel: semantic("BOOKING", "start booking, collect service+date"),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    handoff: handoffEither(
      "Current arch always routes booking to staff; a future arch could collect slots autonomously.",
    ),
    edgeCategories: ["BOOKING_JOURNEY"],
    difficulty: "EASY",
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION", "TYPO", "ARABIZI"],
    maxCases: 12,
    rationale:
      "Bare booking intent; Arabizi variant tests keyword robustness (3ayez a7gez).",
  }),
  singleTurn({
    id: "st-booking-with-service-date",
    utterances: egy(
      "عايز أحجز تنظيف الأسنان يوم الخميس",
      "محتاج ميعاد لتقويم الأسنان بكرة",
      "ممكن حجز خلع الضرس الأسبوع الجاي",
    ),
    semanticLabel: semantic("BOOKING", "extract service+date, offer slots"),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    entities: entities({ service: "تنظيف الأسنان" }),
    handoff: handoffEither("Booking routed to staff by design."),
    edgeCategories: ["BOOKING_JOURNEY", "PARTIAL_INFORMATION"],
    difficulty: "MEDIUM",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION", "TYPO"],
    rationale:
      "Booking with a named service — tests verbatim service extraction and that a date word does not derail intent.",
  }),

  // ── D. AVAILABILITY ──────────────────────────────────────────────────────
  singleTurn({
    id: "st-availability-basic",
    utterances: egy(
      "إيه الأوقات المتاحة بكرة؟",
      "إمتى ممكن آجي؟",
      "عندكم معاد فاضي؟",
      "في مواعيد متاحة الأسبوع ده؟",
    ),
    semanticLabel: semantic("AVAILABILITY", "return real domain slots"),
    currentAiExpectation: current("AVAILABILITY", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    handoff: handoffEither(
      "Real slots come from the domain; staff sends them.",
    ),
    edgeCategories: ["BOOKING_JOURNEY"],
    difficulty: "MEDIUM",
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION", "REPEAT_LETTERS"],
    rationale:
      "Availability questions must be recognized and routed to the availability path.",
  }),

  // ── E. RESCHEDULE / CANCELLATION ─────────────────────────────────────────
  singleTurn({
    id: "st-reschedule-basic",
    utterances: egy(
      "عايز أغيّر معاد الحجز",
      "ممكن أأجل الموعد؟",
      "محتاج أعدل ميعادي",
      "عايز معاد تاني",
    ),
    semanticLabel: semantic("RESCHEDULE", "route reschedule to staff"),
    currentAiExpectation: current("RESCHEDULE", "booking_handoff", null, {
      fullyHandledByCurrent: true,
    }),
    edgeCategories: ["BOOKING_JOURNEY"],
    difficulty: "MEDIUM",
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION", "TYPO"],
    rationale:
      "Reschedule requires a mutation word + appointment word or explicit phrase.",
  }),
  singleTurn({
    id: "st-cancellation-basic",
    utterances: egy(
      "عايز ألغي الموعد",
      "محتاج أكنسل الحجز",
      "مش هقدر أحضر",
      "اعتذر عن الميعاد",
    ),
    semanticLabel: semantic("CANCELLATION", "route cancellation to staff"),
    currentAiExpectation: current("CANCELLATION", "booking_handoff", null, {
      fullyHandledByCurrent: true,
    }),
    edgeCategories: ["BOOKING_JOURNEY"],
    difficulty: "MEDIUM",
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    rationale: "Cancellation keywords + the colloquial 'مش هقدر أحضر' phrase.",
  }),

  // ── F. HUMAN REQUEST / SENSITIVE ─────────────────────────────────────────
  singleTurn({
    id: "st-human-explicit",
    utterances: egy(
      "عايز أكلم موظف حقيقي",
      "ممكن حد من حضرتكم يكلمني؟",
      "عايز أتكلم مع الدكتور نفسه",
      "وصلني بموظف",
    ),
    semanticLabel: semantic("HUMAN_REQUEST", "hand off to a human"),
    currentAiExpectation: current("HUMAN_REQUEST", "handoff", "HUMAN_REQUEST", {
      fullyHandledByCurrent: true,
    }),
    handoff: handoffRequired(
      "HUMAN_REQUEST",
      "Customer explicitly asked for a human.",
    ),
    edgeCategories: ["HANDOFF_EXPLICIT"],
    difficulty: "EASY",
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    rationale: "Explicit human request is a true, mandatory handoff.",
  }),
  singleTurn({
    id: "st-sensitive-pain",
    utterances: egy(
      "عندي ألم شديد وتورم",
      "في نزيف ومش عارف أعمل ايه",
      "عندي حالة طوارئ",
    ),
    semanticLabel: semantic("HUMAN_REQUEST", "escalate to staff immediately"),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "SENSITIVE", {
      fullyHandledByCurrent: true,
    }),
    handoff: handoffRequired(
      "SENSITIVE",
      "High-risk/medical — never AI-triaged.",
    ),
    edgeCategories: ["HANDOFF_SENSITIVE"],
    difficulty: "MEDIUM",
    rarity: "UNCOMMON",
    mutations: ["MISSING_HAMZA"],
    rationale:
      "Sensitive/high-stakes language must go to staff, never triaged.",
  }),

  // ── G. AMBIGUITY ─────────────────────────────────────────────────────────
  singleTurn({
    id: "st-ambiguous-oneword",
    utterances: egy("التنظيف", "الخميس", "أي وقت", "معاد تاني", "ممكن؟"),
    semanticLabel: semantic(
      "CLARIFICATION_REQUIRED",
      "ask a clarifying question",
    ),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "AMBIGUOUS", {
      architecturalLimitation: true,
    }),
    handoff: handoffEither(
      "Clarifiable ambiguity — ideal arch clarifies; current arch hands off.",
    ),
    knowledgeRequirement: "NONE",
    edgeCategories: ["AMBIGUOUS_CLARIFIABLE"],
    difficulty: "HARD",
    orientation: "FUTURE_ARCHITECTURE",
    mutations: ["MISSING_HAMZA"],
    maxCases: 10,
    rationale:
      "Single fragments that a competent assistant would clarify; current arch can only hand off (or misroute 'معاد تاني' as reschedule).",
    futureOutcome: {
      intent: "CLARIFICATION_REQUIRED",
      expectedBehavior: "Ask which service/date the customer means.",
    },
  }),
  singleTurn({
    id: "st-ambiguous-idk",
    utterances: egy("مش عارف", "مش متأكد", "زي ما تشوفوا"),
    semanticLabel: semantic("AMBIGUOUS", "clarify or hand off"),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "AMBIGUOUS", {
      fullyHandledByCurrent: true,
    }),
    edgeCategories: ["AMBIGUOUS_CLARIFIABLE"],
    difficulty: "MEDIUM",
    mutations: ["MISSING_HAMZA"],
    rationale: "Non-committal answers with no actionable content.",
  }),

  // ── FUTURE categories: service discovery / info / price ──────────────────
  singleTurn({
    id: "st-service-discovery",
    utterances: egy(
      "بتعملوا ايه من الخدمات؟",
      "عندكم ايه؟",
      "الخدمات المتاحة عندكم ايه؟",
      "ممكن تقولي بتقدموا ايه؟",
    ),
    semanticLabel: semantic("SERVICE_DISCOVERY", "list available services"),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "NO_KNOWLEDGE", {
      architecturalLimitation: true,
    }),
    handoff: handoffNotRequired(
      "Listing services is knowledge the arch has but cannot expose today.",
    ),
    knowledgeRequirement: "NOT_EXPOSED",
    edgeCategories: ["KNOWLEDGE_NOT_EXPOSED"],
    difficulty: "HARD",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    rationale:
      "Service catalog exists in context but the current AI has no service-listing intent — an unnecessary handoff.",
    futureOutcome: {
      intent: "SERVICE_DISCOVERY",
      expectedBehavior: "List the catalog service names from context.",
    },
  }),
  singleTurn({
    id: "st-service-price",
    utterances: egy(
      "تنظيف الأسنان بكام؟",
      "سعر التقويم كام؟",
      "الأسعار عندكم ايه؟",
      "خلع الضرس بكام؟",
    ),
    semanticLabel: semantic("SERVICE_PRICE", "answer price from knowledge"),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "NO_KNOWLEDGE", {
      architecturalLimitation: true,
    }),
    knowledgeRequirement: "PRICE",
    edgeCategories: ["KNOWLEDGE_MISSING"],
    difficulty: "MEDIUM",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION", "ARABIZI"],
    rationale:
      "Price questions have no price knowledge channel — correct current behavior is a handoff, but it is an architectural gap.",
    futureOutcome: {
      intent: "SERVICE_PRICE",
      expectedBehavior: "Answer price when a price field is exposed.",
    },
  }),

  // ── FUTURE: business info / location / hours (non-FAQ phrasings) ─────────
  singleTurn({
    id: "st-location",
    utterances: egy(
      "العيادة فين؟",
      "العنوان ايه؟",
      "إزاي أوصلكم؟",
      "انتوا فين بالظبط؟",
    ),
    semanticLabel: semantic("LOCATION", "answer address from FAQ"),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "NO_KNOWLEDGE", {
      architecturalLimitation: true,
    }),
    knowledgeRequirement: "PARAPHRASED_FAQ",
    edgeCategories: ["KNOWLEDGE_PARAPHRASE"],
    difficulty: "HARD",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    rationale:
      "Location FAQ exists but colloquial 'العيادة فين' rarely token-overlaps the stored 'أين يقع العنوان' — likely miss.",
    futureOutcome: {
      intent: "LOCATION",
      expectedBehavior: "Match the address FAQ semantically and answer.",
    },
  }),
  singleTurn({
    id: "st-business-info",
    utterances: egy("احكيلي عن العيادة", "انتوا مين؟", "ممكن نبذة عنكم؟"),
    semanticLabel: semantic("BUSINESS_INFO", "share business about text"),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "AMBIGUOUS", {
      architecturalLimitation: true,
    }),
    knowledgeRequirement: "BUSINESS_INFO",
    edgeCategories: ["KNOWLEDGE_NOT_EXPOSED"],
    difficulty: "HARD",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale:
      "'About' is PUBLIC but not in the context budget — the AI cannot introduce the business.",
  }),

  // ── English + mixed single-turn ──────────────────────────────────────────
  singleTurn({
    id: "st-booking-english",
    utterances: [
      u("I want to book an appointment", "ENGLISH"),
      u("can I book a cleaning tomorrow", "ENGLISH"),
      u("I need to reschedule my booking", "ENGLISH"),
    ],
    semanticLabel: semantic("BOOKING", "start booking (English)"),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "AMBIGUOUS", {
      architecturalLimitation: true,
    }),
    handoff: handoffEither("English is not covered by the Arabic classifier."),
    edgeCategories: ["BOOKING_JOURNEY"],
    difficulty: "HARD",
    orientation: "FUTURE_ARCHITECTURE",
    rarity: "UNCOMMON",
    mutations: [],
    rationale:
      "English booking requests are not handled by the Arabic keyword classifier — expected to fall through to ambiguous.",
    futureOutcome: {
      intent: "BOOKING",
      expectedBehavior: "Recognize English booking intent too.",
    },
  }),

  // ── Per-service booking coverage (distinct services, real extraction) ────
  singleTurn({
    id: "st-booking-service-filling",
    utterances: egy(
      "عايز أحجز حشو الأسنان",
      "محتاج ميعاد لحشو ضرس",
      "ممكن أحجز حشو؟",
    ),
    semanticLabel: semantic("BOOKING", "extract service, offer slots"),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    entities: entities({ service: "حشو الأسنان" }),
    handoff: handoffEither("Booking routed to staff by design."),
    edgeCategories: ["BOOKING_JOURNEY"],
    difficulty: "MEDIUM",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION", "TYPO"],
    rationale: "Booking a filling — service extraction for حشو الأسنان.",
  }),
  singleTurn({
    id: "st-booking-service-whitening",
    utterances: egy(
      "عايز أحجز تبييض الأسنان",
      "نفسي أعمل تبييض للأسنان",
      "ممكن ميعاد لتبييض؟",
    ),
    semanticLabel: semantic("BOOKING", "extract service, offer slots"),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    entities: entities({ service: "تبييض الأسنان" }),
    handoff: handoffEither("Booking routed to staff by design."),
    edgeCategories: ["BOOKING_JOURNEY"],
    difficulty: "MEDIUM",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    rationale: "Booking whitening — service extraction for تبييض الأسنان.",
  }),

  // ── FAQ variety: kids orthodontics exact, insurance colloquial ───────────
  singleTurn({
    id: "st-faq-kids-ortho-exact",
    utterances: egy(
      "هل تقدمون خدمة تقويم الأسنان للأطفال؟",
      "بتقدموا تقويم أسنان للأطفال؟",
    ),
    semanticLabel: semantic("SERVICE_INFO", "answer verbatim from FAQ"),
    currentAiExpectation: current("FAQ", "reply", null, {
      fullyHandledByCurrent: true,
    }),
    knowledgeRequirement: "EXACT_FAQ",
    edgeCategories: ["KNOWLEDGE_EXACT"],
    difficulty: "EASY",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    rationale: "Kids-orthodontics FAQ near-exact match.",
  }),

  // ── Colloquial expressions / slang ───────────────────────────────────────
  singleTurn({
    id: "st-booking-slang",
    utterances: egy(
      "يا جماعة عايز أظبط معاد",
      "ممكن تحجزولي؟",
      "عايز أخش أحجز",
      "ينفع أجيلكم امتى واحجز",
    ),
    semanticLabel: semantic("BOOKING", "start booking"),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    handoff: handoffEither("Booking routed to staff by design."),
    edgeCategories: ["BOOKING_JOURNEY", "NORMAL"],
    difficulty: "MEDIUM",
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION", "REPEAT_LETTERS"],
    rationale:
      "Colloquial booking phrasings that still contain a booking word.",
  }),

  // ── Very short / fragmented ──────────────────────────────────────────────
  singleTurn({
    id: "st-very-short",
    utterances: egy("حجز", "موعد", "تقويم", "اسعار"),
    semanticLabel: semantic("AMBIGUOUS", "clarify — too little context"),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    handoff: handoffEither("Single keyword — clarifiable."),
    edgeCategories: ["PARTIAL_INFORMATION", "AMBIGUOUS_CLARIFIABLE"],
    difficulty: "HARD",
    orientation: "FUTURE_ARCHITECTURE",
    mutations: ["MISSING_HAMZA"],
    rationale:
      "One-word messages: 'حجز'/'موعد' trigger BOOKING; 'تقويم'/'اسعار' likely ambiguous — tests over-triggering on a single token.",
  }),

  // ── Arabizi-heavy ────────────────────────────────────────────────────────
  singleTurn({
    id: "st-arabizi-booking",
    utterances: [
      u("3ayez a7gez maw3ed", "ARABIZI"),
      u("momken a7gez bokra", "ARABIZI"),
      u("3ayez me3ad el khamis", "ARABIZI"),
    ],
    semanticLabel: semantic("BOOKING", "start booking (Arabizi)"),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "AMBIGUOUS", {
      architecturalLimitation: true,
    }),
    handoff: handoffEither("Arabizi is not covered by the Arabic classifier."),
    edgeCategories: ["BOOKING_JOURNEY"],
    difficulty: "EXTREME",
    orientation: "FUTURE_ARCHITECTURE",
    rarity: "UNCOMMON",
    mutations: [],
    rationale:
      "Latin-script Egyptian (Arabizi) booking — the normalizer keeps Latin letters, so keyword tables miss it entirely.",
    futureOutcome: {
      intent: "BOOKING",
      expectedBehavior: "Understand Arabizi transliteration of booking intent.",
    },
  }),

  // ── Speech-to-text style ─────────────────────────────────────────────────
  singleTurn({
    id: "st-speech-to-text-availability",
    utterances: egy(
      "يعني انا عايز اعرف في مواعيد متاحة ولا لأ",
      "طيب بص انا محتاج اعرف اقرب معاد فاضي عندكم",
    ),
    semanticLabel: semantic("AVAILABILITY", "return real slots"),
    currentAiExpectation: current("AVAILABILITY", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    handoff: handoffEither("Availability routed to staff by design."),
    edgeCategories: ["BOOKING_JOURNEY", "LONG_CONTEXT"],
    difficulty: "MEDIUM",
    mutations: ["DROP_PUNCTUATION", "SPEECH_TO_TEXT"],
    rationale: "Run-on speech-to-text style with an availability keyword.",
  }),

  // ── FAQ weak match (partial overlap, below threshold) ────────────────────
  singleTurn({
    id: "st-faq-weak-hours",
    utterances: egy("العمل؟", "مفتوح؟"),
    semanticLabel: semantic("HOURS", "answer hours (weak signal)"),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "NO_KNOWLEDGE", {
      architecturalLimitation: true,
    }),
    knowledgeRequirement: "WEAK_FAQ",
    edgeCategories: ["KNOWLEDGE_WEAK", "AMBIGUOUS_CLARIFIABLE"],
    difficulty: "HARD",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale:
      "Weak single-token hours question below the FAQ overlap threshold — clarify vs handoff.",
  }),

  // ── Confirmation-style single turn ("تمام", "اه") w/o prior offer ────────
  singleTurn({
    id: "st-bare-affirmation",
    utterances: egy("تمام", "اه", "ماشي", "اوكي"),
    semanticLabel: semantic("CONFIRMATION", "acknowledge / clarify context"),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "AMBIGUOUS", {
      architecturalLimitation: true,
    }),
    handoff: handoffEither("Bare affirmation with no prior offer to confirm."),
    edgeCategories: ["AMBIGUOUS_CLARIFIABLE", "IMPLICIT_REFERENCE"],
    difficulty: "HARD",
    orientation: "FUTURE_ARCHITECTURE",
    mutations: [],
    rationale:
      "A bare 'تمام'/'اه' with no offer on the table has nothing to confirm — current arch treats as ambiguous.",
  }),
];
