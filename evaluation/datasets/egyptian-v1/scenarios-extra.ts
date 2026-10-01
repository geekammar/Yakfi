/**
 * FlowPilot AI Evaluation — egyptian-v1 EXTRA single-turn scenarios.
 *
 * Additional atomic coverage: per-FAQ paraphrase matrix, availability
 * phrasing variety, time-word booking, greeting variants, and a set of
 * "unnecessary handoff" evidence scenarios (social/advisory turns the
 * current architecture can only escalate).
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
import {
  CLINIC_CONTEXT,
  EMPTY_KNOWLEDGE_CONTEXT,
  SPARSE_CONTEXT,
} from "./shared-context";

export const extraSingleTurnScenarios: Scenario[] = [
  // ── Per-FAQ paraphrase matrix (knowledge robustness) ─────────────────────
  singleTurn({
    id: "ex-faq-hours-paraphrase-1",
    utterances: egy(
      "بتشتغلوا امتى؟",
      "فيار وقت الدوام؟",
      "الدوام بيبدأ الساعة كام؟",
    ),
    semanticLabel: semantic("HOURS", "answer hours (paraphrase)"),
    currentAiExpectation: current("FAQ", "reply", null, {
      fullyHandledByCurrent: true,
    }),
    knowledgeRequirement: "PARAPHRASED_FAQ",
    edgeCategories: ["KNOWLEDGE_PARAPHRASE"],
    difficulty: "MEDIUM",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    rationale:
      "Colloquial hours paraphrases still sharing tokens with the FAQ.",
  }),
  singleTurn({
    id: "ex-faq-hours-paraphrase-2",
    utterances: egy(
      "بتقفلوا امتى؟",
      "آخر موعد عندكم الساعة كام؟",
      "تقفلوا الساعة كام بالليل؟",
    ),
    semanticLabel: semantic("HOURS", "answer closing time"),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "NO_KNOWLEDGE", {
      architecturalLimitation: true,
    }),
    knowledgeRequirement: "PARAPHRASED_FAQ",
    edgeCategories: ["KNOWLEDGE_PARAPHRASE"],
    difficulty: "HARD",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale: "Closing-time asks use no shared token with the hours FAQ.",
  }),
  singleTurn({
    id: "ex-faq-insurance-paraphrase",
    utterances: egy(
      "التأمين عندكم شغال؟",
      "شركة تأمين بتاعتكم ايه؟",
      "بيتحاسبوا لي على التأمين؟",
    ),
    semanticLabel: semantic("FAQ", "answer insurance (paraphrase)"),
    currentAiExpectation: current("FAQ", "reply", null, {
      fullyHandledByCurrent: true,
    }),
    knowledgeRequirement: "PARAPHRASED_FAQ",
    edgeCategories: ["KNOWLEDGE_PARAPHRASE"],
    difficulty: "MEDIUM",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    rationale: "Insurance paraphrases share التأمين with the stored question.",
  }),
  singleTurn({
    id: "ex-faq-location-paraphrase",
    utterances: egy("في أي شارع؟", "أقرب محطة ليكم فين؟", "الدور التالت صح؟"),
    semanticLabel: semantic("LOCATION", "answer address (paraphrase)"),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "NO_KNOWLEDGE", {
      architecturalLimitation: true,
    }),
    knowledgeRequirement: "PARAPHRASED_FAQ",
    edgeCategories: ["KNOWLEDGE_PARAPHRASE"],
    difficulty: "HARD",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale: "Address details share no token with the stored location FAQ.",
  }),
  singleTurn({
    id: "ex-faq-parking-paraphrase",
    utterances: egy("في موقف؟", "أركن فين؟", "الموقف متاح؟"),
    semanticLabel: semantic("FAQ", "answer parking (paraphrase)"),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "NO_KNOWLEDGE", {
      architecturalLimitation: true,
    }),
    knowledgeRequirement: "PARAPHRASED_FAQ",
    edgeCategories: ["KNOWLEDGE_PARAPHRASE"],
    difficulty: "HARD",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale: "Short parking asks fall under the FAQ overlap threshold.",
  }),
  singleTurn({
    id: "ex-faq-multiple-plausible",
    utterances: egy(
      "ساعات العمل والتأمين؟",
      "عنوانكم ومواعيدكم؟",
      "المواقف والساعات؟",
    ),
    semanticLabel: semantic("FAQ", "answer multiple knowledge asks"),
    currentAiExpectation: current("FAQ", "reply", null, {
      fullyHandledByCurrent: true,
    }),
    knowledgeRequirement: "MULTIPLE_PLAUSIBLE",
    edgeCategories: ["KNOWLEDGE_MULTIPLE", "MULTI_INTENT"],
    difficulty: "EXTREME",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    rationale: "Two FAQ topics in one message — earliest match wins.",
  }),
  singleTurn({
    id: "ex-faq-sparse-tenant",
    utterances: egy("هتفونا على رقمكم ايه؟", "لون الصبغات بتاعكم ايه؟"),
    semanticLabel: semantic("KNOWLEDGE_GAP", "no knowledge at this tenant"),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "NO_KNOWLEDGE", {
      fullyHandledByCurrent: true,
    }),
    knowledgeRequirement: "NOT_PRESENT",
    edgeCategories: ["KNOWLEDGE_MISSING"],
    difficulty: "MEDIUM",
    businessContext: SPARSE_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale: "Questions a tenant's sparse store cannot answer.",
  }),

  // ── Availability phrasing variety ────────────────────────────────────────
  singleTurn({
    id: "ex-availability-phrasings",
    utterances: egy(
      "فين المواعيد الفاضية؟",
      "مفيش معاد فادي بكرة؟",
      "تحبوا نحدد معاد",
      "عايز أعرف الأوقات المتاحة هذا الأسبوع",
      "استخرتكم على موعد مناسب",
    ),
    semanticLabel: semantic("AVAILABILITY", "return real slots"),
    currentAiExpectation: current("AVAILABILITY", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    handoff: handoffEither("Availability routed to staff by design."),
    edgeCategories: ["BOOKING_JOURNEY"],
    difficulty: "HARD",
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION", "TYPO"],
    maxCases: 14,
    rationale: "Availability expressed without the exact keywords (فاضي/متاح).",
  }),

  // ── Booking with explicit time words ─────────────────────────────────────
  singleTurn({
    id: "ex-booking-time-words",
    utterances: egy(
      "عايز أحجز الصبح بدري",
      "محتاج ميعاد بعد العصر",
      "ينفع موعد بالليل؟",
      "عايز حجر المساء",
    ),
    semanticLabel: semantic("BOOKING", "capture time-of-day words"),
    currentAiExpectation: current("BOOKING", "booking_handoff", null, {
      architecturalLimitation: true,
    }),
    entities: entities({ timePreference: "الصبح" }),
    handoff: handoffEither("Booking routed to staff by design."),
    edgeCategories: ["BOOKING_JOURNEY", "PARTIAL_INFORMATION"],
    difficulty: "MEDIUM",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    rationale: "Egyptian time-of-day vocabulary (صباحي/عصري/مسائي).",
  }),

  // ── Greeting variants (هاي / هلا / اخبارك) ───────────────────────────────
  singleTurn({
    id: "ex-greeting-variants",
    utterances: [
      u("هاي", "ARABIC_ENGLISH"),
      u("هلا", "EGYPTIAN_COLLOQUIAL"),
      u("اهلين", "EGYPTIAN_COLLOQUIAL"),
      u("منورين", "EGYPTIAN_COLLOQUIAL"),
      u("صباحو", "EGYPTIAN_COLLOQUIAL"),
    ],
    semanticLabel: semantic("GREETING", "acknowledge informal greeting"),
    currentAiExpectation: current("GREETING", "reply", null, {
      fullyHandledByCurrent: true,
    }),
    edgeCategories: ["NORMAL"],
    difficulty: "MEDIUM",
    mutations: ["MISSING_HAMZA", "REPEAT_LETTERS"],
    maxCases: 14,
    rationale: "Informal Egyptian greetings (هاي/هلا/منورين).",
  }),
  singleTurn({
    id: "ex-greeting-question-risk",
    utterances: [
      u("السلام عليكم؟", "EGYPTIAN_COLLOQUIAL", ["INFORMAL_PUNCTUATION"]),
      u("اخبارك؟", "EGYPTIAN_COLLOQUIAL", ["INFORMAL_PUNCTUATION"]),
      u("عامل ايه؟", "EGYPTIAN_COLLOQUIAL", ["INFORMAL_PUNCTUATION"]),
    ],
    semanticLabel: semantic(
      "GREETING",
      "a question-marked greeting is still social",
    ),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "NO_KNOWLEDGE", {
      fullyHandledByCurrent: false,
    }),
    handoff: handoffNotRequired(
      "A '؟' blocks the pure-greeting path — an unnecessary handoff.",
    ),
    edgeCategories: ["HANDOFF_UNNECESSARY_RISK", "AMBIGUOUS_CLARIFIABLE"],
    difficulty: "HARD",
    orientation: "FUTURE_ARCHITECTURE",
    mutations: [],
    rationale:
      "The question-mark guard (isPureGreeting) escalates social openings — evidence for unnecessary handoff.",
  }),

  // ── Human request variants ───────────────────────────────────────────────
  singleTurn({
    id: "ex-human-variants",
    utterances: egy(
      "عايز أعرف مين بيرد عليا",
      "في حد ممكن يساعدني",
      "ممكن حد يكلمني ضروري",
      "محتاج مساعدة عاجلة",
    ),
    semanticLabel: semantic("HUMAN_REQUEST", "hand off to a human"),
    currentAiExpectation: current("HUMAN_REQUEST", "handoff", "HUMAN_REQUEST", {
      fullyHandledByCurrent: true,
    }),
    handoff: handoffRequired("HUMAN_REQUEST", "Human-seeking phrasings."),
    edgeCategories: ["HANDOFF_EXPLICIT"],
    difficulty: "MEDIUM",
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    rationale: "'مساعدة' is a human-word; 'ضروري' adds urgency.",
  }),

  // ── Unnecessary-handoff evidence: advisory / social turns ────────────────
  singleTurn({
    id: "ex-advisory-asks",
    utterances: egy(
      "تنصحني بأيه؟",
      "أحسن حاجة تعملها ايه؟",
      "أنا محتار أختر ايه",
      "ايه الأنسب لي",
    ),
    semanticLabel: semantic("SERVICE_DISCOVERY", "recommend a service"),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "AMBIGUOUS", {
      architecturalLimitation: true,
    }),
    handoff: handoffNotRequired(
      "Recommendation is answerable from the catalog — currently escalated.",
    ),
    knowledgeRequirement: "NOT_EXPOSED",
    edgeCategories: ["HANDOFF_UNNECESSARY_RISK", "KNOWLEDGE_NOT_EXPOSED"],
    difficulty: "HARD",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale: "Advisory asks the catalog could answer.",
  }),
  singleTurn({
    id: "ex-booking-status-ask",
    utterances: egy(
      "وصل حجزي؟",
      "الميعاد بتاعي اتأكد؟",
      "نفسي أعرف حالة الحجز",
    ),
    semanticLabel: semantic("FOLLOW_UP", "report booking status"),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "AMBIGUOUS", {
      architecturalLimitation: true,
    }),
    handoff: handoffEither("Status requires lookup the arch doesn't perform."),
    edgeCategories: ["FOLLOW_UP", "KNOWLEDGE_NOT_EXPOSED"],
    difficulty: "HARD",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale: "Status enquiry — needs record access, not keywords.",
  }),

  // ── Sensitive variants ───────────────────────────────────────────────────
  singleTurn({
    id: "ex-sensitive-variants",
    utterances: egy(
      "عندي مشكلة كبيرة",
      "أنا زعلان جداً من الخدمة",
      "مستاء من المعاملة",
      "الوضع خطير ومحتاج تدخل",
    ),
    semanticLabel: semantic("HUMAN_REQUEST", "escalate sensitive"),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "SENSITIVE", {
      fullyHandledByCurrent: true,
    }),
    handoff: handoffRequired(
      "SENSITIVE",
      "Complaint/risk language is staff-owned.",
    ),
    edgeCategories: ["HANDOFF_SENSITIVE"],
    difficulty: "MEDIUM",
    rarity: "UNCOMMON",
    mutations: ["MISSING_HAMZA"],
    rationale: "Sensitive-word coverage (مشكلة/زعلان/مستاء/خطير).",
  }),

  // ── Empty knowledge across registers ─────────────────────────────────────
  singleTurn({
    id: "ex-no-knowledge-variants",
    utterances: [
      u("هل تقدمون جراحة الفم؟", "MSA"),
      u("عندكم تخدير؟", "EGYPTIAN_COLLOQUIAL"),
      u("do you do root canal?", "ENGLISH"),
      u("3andoko 7asho el asnan?", "ARABIZI"),
    ],
    semanticLabel: semantic("KNOWLEDGE_GAP", "no knowledge → hand off"),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "NO_KNOWLEDGE", {
      fullyHandledByCurrent: true,
    }),
    knowledgeRequirement: "NOT_PRESENT",
    handoff: handoffEither("Genuine gap — handoff is correct."),
    edgeCategories: ["KNOWLEDGE_MISSING"],
    difficulty: "MEDIUM",
    businessContext: EMPTY_KNOWLEDGE_CONTEXT,
    mutations: ["MISSING_HAMZA"],
    rationale: "Out-of-catalog services across four registers.",
  }),

  // ── Service discovery variants (future category) ─────────────────────────
  singleTurn({
    id: "ex-service-discovery-variants",
    utterances: egy(
      "بتعملوا أيه بالظبط؟",
      "قائمة الخدمات ايه؟",
      "عندكم ايه من علاجات الأسنان؟",
      "ممكن أعرف كل الخدمات",
    ),
    semanticLabel: semantic("SERVICE_DISCOVERY", "list available services"),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "NO_KNOWLEDGE", {
      architecturalLimitation: true,
    }),
    handoff: handoffNotRequired(
      "Catalog exists in context; the arch has no listing intent.",
    ),
    knowledgeRequirement: "NOT_EXPOSED",
    edgeCategories: ["KNOWLEDGE_NOT_EXPOSED", "HANDOFF_UNNECESSARY_RISK"],
    difficulty: "HARD",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    rationale: "Service discovery — the highest-volume future gap.",
  }),

  // ── Service info variants (description, duration, prep) ──────────────────
  singleTurn({
    id: "ex-service-info-variants",
    utterances: egy(
      "التقويم بيخد كام شهر؟",
      "الحشو بياخد وقت طويل؟",
      "التبييض بيعمل حساسية؟",
      "تنظيف الأسنان بيتعمل إزاي",
    ),
    semanticLabel: semantic("SERVICE_INFO", "answer service detail"),
    currentAiExpectation: current("AMBIGUOUS", "handoff", "NO_KNOWLEDGE", {
      architecturalLimitation: true,
    }),
    knowledgeRequirement: "SERVICE_INFO",
    handoff: handoffEither("Service descriptions are not in the FAQ store."),
    edgeCategories: ["KNOWLEDGE_NOT_EXPOSED"],
    difficulty: "HARD",
    orientation: "FUTURE_ARCHITECTURE",
    businessContext: CLINIC_CONTEXT,
    mutations: ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    rationale: "Service-detail questions the catalog doesn't answer.",
  }),
];
