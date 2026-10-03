import { phoneSchema, uuidSchema, workingHoursSchema } from "./common";
import { z } from "zod";

/**
 * Vertical keys are discovery METADATA (operator PROMPT-07 / Local Vertical
 * Discovery strategy) — never permission for vertical-specific UI. Keys are
 * stable machine identifiers; Arabic labels are for display only. Extending
 * the list is a validation-layer change only (no migration, no Prisma enum).
 */
export const VERTICAL_VALUES = [
  "dental",
  "beauty",
  "coaching",
  "gym",
  "education",
  "home_services",
  "other",
] as const;

export type VerticalValue = (typeof VERTICAL_VALUES)[number];

export const VERTICAL_LABELS: Record<VerticalValue, string> = {
  dental: "عيادة أسنان",
  beauty: "صالون / مركز تجميل",
  coaching: "مدرب (رياضة / تعليم / حياة)",
  gym: "نادي رياضي",
  education: "مركز تعليمي",
  home_services: "خدمات منزلية",
  other: "أخرى",
};

export const VERTICALS: ReadonlyArray<{
  value: VerticalValue;
  label: string;
}> = VERTICAL_VALUES.map((value) => ({ value, label: VERTICAL_LABELS[value] }));

export const verticalSchema = z.enum(VERTICAL_VALUES, "اختر نوع المنشأة");

/**
 * Booking confirmation mode (PROMPT-09): how new appointments enter the
 * agenda. Keys are stable machine identifiers; Arabic labels are for
 * display only. Extending the list is a validation-layer change only
 * (no migration, no Prisma enum).
 */
export const CONFIRMATION_MODE_VALUES = ["manual", "automatic"] as const;

export type ConfirmationModeValue = (typeof CONFIRMATION_MODE_VALUES)[number];

export const CONFIRMATION_MODE_LABELS: Record<ConfirmationModeValue, string> = {
  manual: "تأكيد يدوي",
  automatic: "تأكيد تلقائي",
};

export const CONFIRMATION_MODES: ReadonlyArray<{
  value: ConfirmationModeValue;
  label: string;
  hint: string;
}> = [
  {
    value: "manual",
    label: CONFIRMATION_MODE_LABELS.manual,
    hint: "كل موعد جديد يضاف بانتظار التأكيد، وتؤكده أنت أو الفريق.",
  },
  {
    value: "automatic",
    label: CONFIRMATION_MODE_LABELS.automatic,
    hint: "كل موعد جديد يُؤكد تلقائياً فور إنشائه.",
  },
];

export const confirmationModeSchema = z.enum(
  CONFIRMATION_MODE_VALUES,
  "اختر طريقة تأكيد الحجز",
);

/**
 * Supported timezones (promoted from the onboarding feature in PROMPT-09
 * so the settings surface shares the same list; onboarding re-exports for
 * backward compatibility within its own feature).
 */
export const TIMEZONES = [
  { value: "Africa/Cairo", label: "القاهرة (توقيت مصر)" },
  { value: "Asia/Riyadh", label: "الرياض" },
  { value: "Asia/Dubai", label: "دبي" },
] as const;

/**
 * Business knowledge entry (Spec A §6) — the canonical plain-text
 * question/answer contract stored as JSON entries in `Business.faqs`
 * (DECISIONS #13). Exported since PROMPT-18: the knowledge feature's
 * form and workflow share this single contract.
 */
export const faqEntrySchema = z.object({
  question: z
    .string()
    .trim()
    .min(1, "اكتب السؤال")
    .min(2, "السؤال قصير جداً")
    .max(500, "السؤال طويل جداً (٥٠٠ حرف كحد أقصى)"),
  answer: z
    .string()
    .trim()
    .min(1, "اكتب الإجابة")
    .min(2, "الإجابة قصيرة جداً")
    .max(2000, "الإجابة طويلة جداً (٢٠٠٠ حرف كحد أقصى)"),
});

const createBusinessSchema = z.object({
  name: z.string().trim().min(2, "الاسم قصير جداً").max(120),
  vertical: verticalSchema.optional(),
  city: z.string().trim().min(1).max(80).optional(),
  whatsappNumber: phoneSchema,
  timezone: z.string().trim().min(1).max(64).default("Asia/Riyadh"),
  about: z.string().trim().max(2000).optional(),
  // Customer-facing location line (PROMPT-AI-OPS-21). Optional and
  // unvalidated beyond length — a free-text address the assistant quotes on
  // a location question. Never required, never bookable-critical.
  address: z.string().trim().max(500).optional(),
  workingHours: workingHoursSchema.optional(),
  slotDurationMinutes: z.number().int().min(5).max(480).optional(),
  confirmationMode: confirmationModeSchema.optional(),
  faqs: z.array(faqEntrySchema).max(50, "الحد الأقصى ٥٠ معلومة").optional(),
  cancellationPolicy: z.string().trim().max(2000).optional(),
});

const updateBusinessSchema = createBusinessSchema.partial();

export type CreateBusinessDto = z.infer<typeof createBusinessSchema>;
export type UpdateBusinessDto = z.infer<typeof updateBusinessSchema>;
export type FaqDto = z.infer<typeof faqEntrySchema>;

export const businessValidation = {
  create: createBusinessSchema,
  update: updateBusinessSchema,
  findById: z.object({ id: uuidSchema }),
} as const;
