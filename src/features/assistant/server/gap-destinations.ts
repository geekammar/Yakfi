/**
 * Knowledge-gap category → destination routing (PROMPT-AI-UX-01 §13) — PURE
 * data. Kept free of any I/O import so it is safely consumable by the UI and
 * by offline verification.
 *
 * Each entry is business language (never a technical category name) and
 * points at the ONE EXISTING authoritative editor. A price/hours gap NEVER
 * routes to the FAQ editor — that would duplicate Domain facts into the
 * knowledge store (the single-source-of-truth rule). A FAQ/general gap routes
 * to the Knowledge editor. No entry creates or promotes knowledge: the owner
 * types the fact into its canonical source.
 */

import type { KnowledgeGapCategory } from "@/lib/validation";

/**
 * One category's review destination — business language (never a technical
 * category name) pointing at the ONE EXISTING authoritative editor.
 */
export type KnowledgeGapDestination = {
  title: string;
  action: string;
  href: string;
  /**
   * Whether this editor participates in the ANSWER flow
   * (PROMPT-AI-UX-02): the discovered customer question is carried into the
   * existing authoring surface, prefilled, and the unresolved item is closed
   * when the owner saves an answer. Only the knowledge editor does — a
   * price/hours/description gap is Domain data that must be typed into its own
   * canonical editor, never into the FAQ store.
   */
  readonly answerFlow?: boolean;
};

export const KNOWLEDGE_GAP_DESTINATIONS: Record<
  KnowledgeGapCategory,
  KnowledgeGapDestination
> = {
  SERVICE_PRICE: {
    title: "السعر غير مضاف لهذه الخدمة.",
    action: "إضافة السعر",
    href: "/services",
  },
  BUSINESS_INFO: {
    title: "معلومات النشاط غير مضافة.",
    action: "إضافة المعلومات",
    href: "/settings",
  },
  SERVICE_INFO: {
    title: "تفاصيل هذه الخدمة غير مضافة.",
    action: "مراجعة الخدمات",
    href: "/services",
  },
  AVAILABILITY: {
    title: "مواعيد العمل غير مضافة.",
    action: "إضافة ساعات العمل",
    href: "/onboarding/hours",
  },
  FAQ: {
    title: "المساعد لم يجد إجابة لهذا السؤال بعد.",
    action: "إضافة الإجابة",
    href: "/settings/knowledge",
    answerFlow: true,
  },
  GENERAL: {
    title: "المساعد لم يجد إجابة لهذا السؤال بعد.",
    action: "إضافة الإجابة",
    href: "/settings/knowledge",
    answerFlow: true,
  },
};

/**
 * The search-param names the answer flow carries on the knowledge-editor href
 * (PROMPT-AI-UX-02): the discovered customer question (prefilled as an
 * editable draft) and the id of the unresolved gap (so saving the answer can
 * close it through its EXISTING lifecycle). Both are re-validated server-side
 * at the page boundary — a crafted URL can only ever prefill a draft.
 */
export const ANSWER_FLOW_QUESTION_PARAM = "question";
export const ANSWER_FLOW_GAP_PARAM = "gap";

/**
 * Compose the knowledge-editor href for the answer flow: the base destination
 * plus the discovered question and the gap id. The question is omitted when
 * the gap recorded no subject (the editor then opens blank — the owner still
 * types the question, and the gap still closes on save). PURE: no I/O, so it
 * is safely consumable by the UI and by offline verification.
 */
export function buildAnswerFlowHref(input: {
  subject: string | null;
  gapId: string;
}): string {
  const params = new URLSearchParams();
  const question = input.subject?.trim() ?? "";
  if (question.length > 0) {
    params.set(ANSWER_FLOW_QUESTION_PARAM, question);
  }
  params.set(ANSWER_FLOW_GAP_PARAM, input.gapId);
  return `${KNOWLEDGE_GAP_DESTINATIONS.FAQ.href}?${params.toString()}`;
}

export const KNOWLEDGE_GAP_CATEGORY_LABELS: Record<
  KnowledgeGapCategory,
  string
> = {
  SERVICE_PRICE: "الأسعار",
  BUSINESS_INFO: "معلومات النشاط",
  SERVICE_INFO: "تفاصيل الخدمات",
  AVAILABILITY: "مواعيد العمل",
  FAQ: "سؤال شائع",
  GENERAL: "سؤال عام",
};
