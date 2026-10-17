/**
 * Arabic pluralization for count labels.
 *
 * Arabic noun rules: 0 → zero form, 1 → singular, 2 → dual,
 * 3–10 → plural, 11+ → singular again.
 */
export type ArabicCountNouns = {
  /** e.g. "لا توجد محادثات" */
  zero: string;
  /** e.g. "محادثة واحدة" */
  one: string;
  /** e.g. "محادثتان" */
  two: string;
  /** plural noun for 3–10, e.g. "محادثات" */
  few: string;
  /** singular noun for 11+, e.g. "محادثة" */
  many: string;
};

export function arabicCount(count: number, nouns: ArabicCountNouns): string {
  if (count === 0) return nouns.zero;
  if (count === 1) return nouns.one;
  if (count === 2) return nouns.two;
  if (count <= 10) return `${count} ${nouns.few}`;
  return `${count} ${nouns.many}`;
}

export const CONVERSATION_NOUNS: ArabicCountNouns = {
  zero: "لا توجد محادثات",
  one: "محادثة واحدة",
  two: "محادثتان",
  few: "محادثات",
  many: "محادثة",
};

export const APPOINTMENT_NOUNS: ArabicCountNouns = {
  zero: "لا توجد مواعيد",
  one: "موعد واحد",
  two: "موعدان",
  few: "مواعيد",
  many: "موعد",
};

export const SERVICE_NOUNS: ArabicCountNouns = {
  zero: "لا توجد خدمات",
  one: "خدمة واحدة",
  two: "خدمتان",
  few: "خدمات",
  many: "خدمة",
};

export const CUSTOMER_NOUNS: ArabicCountNouns = {
  zero: "لا يوجد عملاء",
  one: "عميل واحد",
  two: "عميلان",
  few: "عملاء",
  many: "عميلاً",
};

export const MEMBER_NOUNS: ArabicCountNouns = {
  zero: "لا يوجد أعضاء",
  one: "عضو واحد",
  two: "عضوان",
  few: "أعضاء",
  many: "عضواً",
};

export const SEARCH_RESULT_NOUNS: ArabicCountNouns = {
  zero: "لا توجد نتائج",
  one: "نتيجة واحدة",
  two: "نتيجتان",
  few: "نتائج",
  many: "نتيجة",
};

export const SLOT_NOUNS: ArabicCountNouns = {
  zero: "لا توجد أوقات متاحة",
  one: "وقت واحد متاح",
  two: "وقتان متاحان",
  few: "أوقات متاحة",
  many: "وقتاً متاحاً",
};

export const KNOWLEDGE_NOUNS: ArabicCountNouns = {
  zero: "لا توجد معلومات",
  one: "معلومة واحدة",
  two: "معلومتان",
  few: "معلومات",
  many: "معلومة",
};

export const PROVIDER_NOUNS: ArabicCountNouns = {
  zero: "لا يوجد مقدمو خدمة",
  one: "مقدم خدمة واحد",
  two: "مقدما خدمة",
  few: "مقدمي خدمة",
  many: "مقدم خدمة",
};
