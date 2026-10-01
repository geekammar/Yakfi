/**
 * FlowPilot AI Evaluation — shared business context for egyptian-v1.
 *
 * A realistic Egyptian dental/clinic-style business (vertical-agnostic engine,
 * but a concrete tenant makes FAQ/service matching testable). Kept separate so
 * many scenarios reuse the SAME services + FAQs, which is what makes
 * knowledge-match vs knowledge-gap cases meaningful.
 */

import type { CaseBusinessContext } from "../../schema/dataset-schema";

/** The canonical tenant most scenarios run against. */
export const CLINIC_CONTEXT: CaseBusinessContext = {
  businessName: "عيادة الأمل",
  services: [
    { name: "تنظيف الأسنان", durationMinutes: 30 },
    { name: "حشو الأسنان", durationMinutes: 45 },
    { name: "تقويم الأسنان", durationMinutes: 60 },
    { name: "خلع الضرس", durationMinutes: 30 },
    { name: "تبييض الأسنان", durationMinutes: 45 },
  ],
  faqs: [
    {
      question: "ما هي ساعات العمل؟",
      answer: "نعمل يومياً من 10 صباحاً حتى 8 مساءً ما عدا الجمعة.",
    },
    {
      question: "هل تقبلون التأمين الطبي؟",
      answer: "نعم نقبل معظم شركات التأمين الطبي، يرجى إحضار بطاقتك.",
    },
    {
      question: "أين يقع العنوان؟",
      answer: "العيادة في شارع الجيش، بجوار محطة المترو، الدور الثالث.",
    },
    {
      question: "هل يوجد موقف سيارات؟",
      answer: "نعم يوجد موقف مجاني للعملاء أمام المبنى.",
    },
    {
      question: "هل تقدمون خدمة تقويم الأسنان للأطفال؟",
      answer: "نعم نوفر تقويم الأسنان للأطفال والكبار مع أخصائي متخصص.",
    },
  ],
};

/** A tenant deliberately WITHOUT a matching FAQ (knowledge-gap cases). */
export const SPARSE_CONTEXT: CaseBusinessContext = {
  businessName: "مركز النور",
  services: [
    { name: "قص شعر", durationMinutes: 30 },
    { name: "صبغة شعر", durationMinutes: 90 },
  ],
  faqs: [
    {
      question: "ما هي مواعيد العمل؟",
      answer: "من 11 صباحاً حتى 9 مساءً طوال الأسبوع.",
    },
  ],
};

/** An empty-knowledge tenant (every question is a NO_KNOWLEDGE handoff). */
export const EMPTY_KNOWLEDGE_CONTEXT: CaseBusinessContext = {
  businessName: "منشأة تجريبية",
  services: [],
  faqs: [],
};
