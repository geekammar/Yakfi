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
export const businessSettingsSchema = z
  .object({
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
    confirmationMode: z.enum(
      CONFIRMATION_MODE_VALUES,
      "اختر طريقة تأكيد الحجز",
    ),
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
    // Appointment reminders (BOOK-REM-01)
    reminderEnabled: z.boolean().optional(),
    reminderLeadHours: z
      .union(
        [
          z.literal(1),
          z.literal(2),
          z.literal(4),
          z.literal(12),
          z.literal(24),
          z.literal(48),
        ],
        { error: "اختر مدة صالحة لإرسال التذكير" },
      )
      .optional(),
    reminderTemplateId: z
      .enum(["standard", "compact"], {
        error: "اختر قالباً صالحاً لرسالة التذكير",
      })
      .optional(),
    // ── Default Service Booking Mode (CONV-PLAY-01) ──────────────
    // "الحجز السريع بالخدمة الافتراضية"
    defaultServiceBookingEnabled: z.boolean().optional(),
    defaultBookingServiceId: z.string().nullable().optional(),
  })
  .refine(
    (data) => {
      if (data.defaultServiceBookingEnabled) {
        return (
          typeof data.defaultBookingServiceId === "string" &&
          data.defaultBookingServiceId.trim().length > 0
        );
      }
      return true;
    },
    {
      message: "يرجى اختيار الخدمة الافتراضية عند تفعيل الحجز السريع",
      path: ["defaultBookingServiceId"],
    },
  );

export const REMINDER_LEAD_HOURS_OPTIONS = [
  { value: 1, label: "قبل الموعد بساعة واحدة" },
  { value: 2, label: "قبل الموعد بساعتين" },
  { value: 4, label: "قبل الموعد بـ 4 ساعات" },
  { value: 12, label: "قبل الموعد بـ 12 ساعة" },
  { value: 24, label: "قبل الموعد بـ 24 ساعة (يوم واحد)" },
  { value: 48, label: "قبل الموعد بـ 48 ساعة (يومان)" },
] as const;

export const REMINDER_TEMPLATE_OPTIONS = [
  {
    id: "standard",
    name: "النموذج المعتمد (الأساسي)",
    description:
      "تذكير ودود ومكتمل يحتوي اسم المنشأة، التاريخ، الوقت، واسم الخدمة.",
    preview:
      "مرحباً بك! نود تذكيرك بموعدك لدى {businessName} يوم {date} الساعة {startTime} (خدمة: {serviceName}). يسعدنا حضورك في الموعد المحدد.",
  },
  {
    id: "compact",
    name: "النموذج المعتمد (المختصر)",
    description: "صيغة مختصرة ومباشرة للمواعيد السريعة.",
    preview:
      "تذكير بموعدك: لدى {businessName} يوم {date} الساعة {startTime} لخدمة {serviceName}. نرجو الحضور قبل الموعد بـ 10 دقائق.",
  },
] as const;

export type BusinessSettingsInput = z.infer<typeof businessSettingsSchema>;
