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

export const KNOWLEDGE_GAP_DESTINATIONS: Record<
  KnowledgeGapCategory,
  { title: string; action: string; href: string }
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
  },
  GENERAL: {
    title: "المساعد لم يجد إجابة لهذا السؤال بعد.",
    action: "إضافة الإجابة",
    href: "/settings/knowledge",
  },
};

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
