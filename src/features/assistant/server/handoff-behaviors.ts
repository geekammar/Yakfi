/**
 * Read-only handoff behaviors (PROMPT-AI-UX-01 §7 SECTION F) — PURE data.
 *
 * These are the PLATFORM-enforced safety boundaries the architecture already
 * guarantees. They are surfaced to the owner as EXPLAINED, NON-SWITCHABLE
 * behavior so the owner understands when the assistant hands a conversation
 * to a human, and a Business Admin can never disable them: there is no
 * toggle anywhere on the surface and no write path accepts a handoff field.
 *
 * Kept free of any I/O import so it is safely consumable by the UI and by
 * offline verification.
 */

import type { HandoffBehavior } from "@/features/assistant/types";

export const HANDOFF_BEHAVIORS: ReadonlyArray<HandoffBehavior> = [
  {
    key: "customer_requested_human",
    label: "عندما يطلب العميل التحدث مع شخص",
    description:
      "يحوّل المساعد المحادثة إلى فريقك فورًا بمجرد أن يطلب العميل ذلك صراحةً.",
  },
  {
    key: "no_knowledge",
    label: "عندما لا يستطيع المساعد الإجابة",
    description:
      "إذا لم تكن المعلومة موجودة في بيانات منشأتك الموثوقة، لا يخترع المساعد جوابًا — بل يطلب من فريقك الرد.",
  },
  {
    key: "repeated_misunderstanding",
    label: "عند تكرار عدم الفهم",
    description:
      "إذا بقي طلب العميل غامضًا بعد محاولة التوضيح، يحوّل المساعد المحادثة إلى فريقك بدلاً من التخمين.",
  },
  {
    key: "sensitive",
    label: "الطلبات الحساسة",
    description:
      "بعض الطلبات تتطلب تدخلاً بشريًا مباشرًا بطبيعتها — هذه قاعدة ثابتة لسلامة العملاء ولا يمكن إيقافها.",
  },
];
