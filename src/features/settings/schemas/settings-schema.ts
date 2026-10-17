import {
  CONFIRMATION_MODE_VALUES,
  TIMEZONES,
  phoneSchema,
  verticalSchema,
} from "@/lib/validation";

import { z } from "zod";

const TIMEZONE_VALUES = TIMEZONES.map((tz) => tz.value) as [
  (typeof TIMEZONES)[number]["value"],
  ...Array<(typeof TIMEZONES)[number]["value"]>,
];

/**
 * Business Settings form input (operator PROMPT-09, UX001-R3). The client NEVER
 * sends a `businessId`, role, or account-state field — the Business is
 * always derived server-side from the authenticated actor. Zod strips
 * every unknown key, so hostile extra fields cannot become trusted
 * input.
 */
export const businessSettingsSchema = z.object({
  name: z
    .string({ error: "اكتب اسم المنشأة" })
    .trim()
    .min(2, "اكتب اسم المنشأة")
    .max(120),
  vertical: verticalSchema,
  city: z
    .string({ error: "اكتب المدينة" })
    .trim()
    .min(2, "اكتب المدينة")
    .max(80),
  whatsappNumber: phoneSchema,
  timezone: z.enum(TIMEZONE_VALUES, "اختر المنطقة الزمنية"),
  // ── AI information (PROMPT-AI-OPS-21) ────────────────────────────────
  // Both are OPTIONAL: the owner may save partial information, and neither
  // ever blocks using FlowPilot. `about` is the customer-facing description
  // the assistant quotes on a business-profile question; `address` is the
  // location line it quotes on a location question. An empty string clears
  // the stored field (normalized to null by the service).
  about: z.string().trim().max(2000, "النبذة طويلة جداً").optional(),
  address: z.string().trim().max(500, "العنوان طويل جداً").optional(),
  // Booking behavior — إعدادات الحجز
  confirmationMode: z.enum(CONFIRMATION_MODE_VALUES, "اختر طريقة تأكيد الحجز"),
  slotDurationMinutes: z
    .union(
      [
        z.literal(15),
        z.literal(20),
        z.literal(30),
        z.literal(45),
        z.literal(60),
        z.literal(90),
        z.literal(120),
      ],
      { error: "اختر فاصلاً زمنياً صالحاً من القائمة" },
    )
    .optional(),
  cancellationPolicy: z
    .string({ error: "اكتب سياسة إلغاء مختصرة" })
    .trim()
    .min(5, "اكتب سياسة إلغاء مختصرة")
    .max(2000, "سياسة الإلغاء طويلة جداً"),
});

export type BusinessSettingsInput = z.infer<typeof businessSettingsSchema>;
