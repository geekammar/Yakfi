/**
 * Static FAQ suggestion catalog (B-05).
 *
 * The smallest possible "how do I start?" affordance for the knowledge
 * authoring surface: a typed, static catalog of question/answer STARTER
 * PAIRS keyed by the EXISTING business vertical (`VerticalValue` from
 * `@/lib/validation` — the same discovery enum onboarding and settings
 * use; no second business-type mechanism).
 *
 * What this is NOT (binding):
 * - NOT domain data and NOT a database table — it lives outside the
 *   domain model and is never persisted. A suggestion becomes business
 *   knowledge ONLY through the existing explicit create path.
 * - NOT AI, NOT embeddings, NOT RAG, NOT mining, NOT analytics — no
 *   LLM call is made and no customer message is read here.
 * - NOT authoritative: every answer is a DRAFT the owner reviews and
 *   edits before saving. A suggested answer NEVER silently becomes a
 *   business fact — the UI opens the prefilled create form and the
 *   entry is written only when the owner explicitly saves it.
 *
 * The questions deliberately cover ONLY explicit Q/A knowledge that is
 * NOT naturally represented elsewhere in the business model (booking
 * policy, cancellation, preparation, payment, what-to-bring). They
 * never ask the owner to re-enter canonical domain facts that already
 * live in their canonical sources: location, price, the service list,
 * service duration, opening hours, and the WhatsApp number are all
 * excluded on purpose — duplicating them here would create a second
 * source of truth and let stored knowledge drift from the domain.
 *
 * Future-ready ("frequently asked by customers" — explicitly NOT
 * implemented): the consumer-facing seam is `listFaqSuggestions`, which
 * returns plain starter pairs. A later slice may append
 * customer-derived candidates to the same pair shape without changing
 * this contract; nothing here assumes the catalog is the only source.
 */

import { VERTICAL_LABELS, type VerticalValue } from "@/lib/validation";

/** A question/answer starter pair. The answer is an editable draft. */
export type FaqSuggestion = {
  question: string;
  answer: string;
};

/** What the authoring UI renders for the business's vertical group. */
export type FaqSuggestionGroup = {
  verticalLabel: string;
  suggestions: FaqSuggestion[];
};

/**
 * Suggestions common to every vertical — booking policy questions every
 * appointment/conversion business gets. Kept small on purpose.
 */
const COMMON_SUGGESTIONS: ReadonlyArray<FaqSuggestion> = [
  {
    question: "هل يجب الحجز مسبقًا؟",
    answer:
      "نعم، الحجز يكون عن طريق الواتساب وأي حدث متاح يظهر لك في الأوقات المتاحة.",
  },
  {
    question: "هل يمكن تعديل الموعد؟",
    answer:
      "نعم، يمكن تعديل الموعد قبل وقته. راسلنا بالواتساب ونرتب لك البديل المناسب.",
  },
  {
    question: "ما سياسة الإلغاء؟",
    answer:
      "يمكنك إلغاء الموعد قبل وقته بـ ٢٤ ساعة على الأقل بدون أي رسوم. راسلنا بالواتساب للإلغاء.",
  },
  {
    question: "ماذا أحضر معي قبل الموعد؟",
    answer:
      "نصيحة سريعة قبل الحضور: تأكد من تحديد الخدمة المطلوبة، وأحضر أي بيانات قد نحتاجها.",
  },
];

/**
 * Vertical-specific starter pairs. Deliberately sparse — each entry is a
 * nudge toward the kind of question the AI cannot infer from the domain
 * (preparation, requirements, payment flow), never a restatement of the
 * service catalog, prices, or hours.
 */
const VERTICAL_SUGGESTIONS: Record<
  VerticalValue,
  ReadonlyArray<FaqSuggestion>
> = {
  dental: [
    {
      question: "ماذا أحضر معي في أول زيارة؟",
      answer:
        "في أول زيارة نحتاج نعرف تاريخك الطبي البسيط وأي أدوية بتاخدها بشكل دوري.",
    },
    {
      question: "هل الكشف بيكون مؤلم؟",
      answer:
        "الهدف راحتك. الكشف الدوري بسيط، وفي حالات معينة نستخدم تخدير موضعي حسب الحاجة.",
    },
    {
      question: "كم مرة أحتاج تنظيف الأسنان؟",
      answer:
        "المنتظم هو كل ستة أشهر مرة، بس حسب حالة أسنانك نقدر نحدد لك الفترة المناسبة.",
    },
  ],
  beauty: [
    {
      question: "كيف أعتني بنفسي بعد الجلسة؟",
      answer:
        "بعد الجلسة ننصح بتجنب الماء الساخن والمنتجات القوية لمدة ٢٤ ساعة، ونرش لك الخطوات بالتفصيل.",
    },
    {
      question: "هل تتعاملون مع الحساسية؟",
      answer:
        "نعم، أخبرينا بأي حساسية معروفة قبل الجلسة ونختار مع بعض المنتجات المناسبة لك.",
    },
    {
      question: "كم تستمر النتيجة؟",
      answer:
        "مدة الاستمرار تختلف حسب نوع الجلسة والعناية بعدها، نوضح لك التفاصيل قبل الحجز.",
    },
  ],
  coaching: [
    {
      question: "كيف تتم الجلسات؟",
      answer:
        "الجلسات تكون حسب ما نرتبه مع بعض — أونلاين أو حضوري — ونحدد الأنسب في أول جلسة.",
    },
    {
      question: "ماذا أحضر معي في أول جلسة؟",
      answer:
        "في أول جلسة نحتاج نعرف هدفك بشكل واضح، وأي معلومات سابقة تخص الموضوع.",
    },
    {
      question: "هل توجد خطة متابعة؟",
      answer:
        "نعم، بعد أول جلسة نرتب لك خطة متابعة واضحة بمعالم محددة نراجعها مع بعض.",
    },
  ],
  gym: [
    {
      question: "ماذا أحضر معي أول يوم؟",
      answer:
        "أول يوم تحتاج ملابس رياضية مريحة، وحة تغيير، وزجاجة مية. الباقي نوفره لك.",
    },
    {
      question: "هل أحتاج تقييم لياقي قبل البدء؟",
      answer:
        "نعم، نعمل تقييم بسيط أول يوم لنعرف مستواك ونختار البرنامج المناسب والآمن لك.",
    },
    {
      question: "هل توجد خطط للأعضاء الجدد؟",
      answer:
        "نعم، عندنا برامج للمبتدئين تبدأ تدريجيًا. نرشح لك الأنسب بعد التقييم.",
    },
  ],
  education: [
    {
      question: "كيف تحددي المستوى المناسب؟",
      answer:
        "نعمل اختبار تحديد مستوى بسيط أول جلسة، وبناءً عليه نختار لك المستوى المناسب.",
    },
    {
      question: "ماذا يحتاج الطالب معه؟",
      answer: "الطالب يحتاج دفتر وقلم، وأي كتاب أو مادة نحددها له بعد أول حصة.",
    },
    {
      question: "هل توجد متابعة مع ولي الأمر؟",
      answer:
        "نعم، نرسل لك فترة فترة تقرير بسيط عن المستوى والالتزام، ونتواصل معك بأي ملاحظة.",
    },
  ],
  home_services: [
    {
      question: "كيف أستعد لزيارة الفني؟",
      answer:
        "تأكد من توفير مكان العمل المناسب وعزله قليلًا، وأخبرنا بأي تفاصيلة تخص المكان قبل الحضور.",
    },
    {
      question: "هل تحضرون في نفس اليوم؟",
      answer:
        "نعتمد على الأوقات المتاحة، وأغلب الحالات نقدر ننسق لك زيارة في نفس اليوم.",
    },
    {
      question: "ماذا يحدث لو محتاج أجزاء إضافية؟",
      answer:
        "لو احتاجنا جزء إضافي، نوضح لك التكلفة قبل ما نكمل، ومشي بدون موافقتك.",
    },
  ],
  other: [],
};

/**
 * The starter pairs for a vertical — common ones plus the vertical's
 * own. An unknown/null vertical safely resolves to the common set only
 * (never throws; the caller's business may predate the field).
 *
 * Answers are DRAFTS: they are meant to be edited, not published
 * verbatim. The UI always routes them through the explicit create form.
 */
export function listFaqSuggestions(
  vertical: string | null | undefined,
): FaqSuggestion[] {
  const typed = vertical as VerticalValue;
  const verticalSuggestions = VERTICAL_SUGGESTIONS[typed] ?? [];
  return [...COMMON_SUGGESTIONS, ...verticalSuggestions];
}

/** Arabic label for the vertical's suggestion group (display only). */
export function suggestionGroupLabel(
  vertical: string | null | undefined,
): string {
  const typed = vertical as VerticalValue;
  return VERTICAL_LABELS[typed] ?? VERTICAL_LABELS.other;
}
