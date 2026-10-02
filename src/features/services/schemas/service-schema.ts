import { refineServicePrice } from "@/lib/service-price";
import { serviceValidation, uuidSchema } from "@/lib/validation";

import { z } from "zod";

/**
 * Form-level input for create/edit — the businessId is NEVER accepted
 * from the client; the server derives it from the authenticated
 * session's business membership. Field constraints (Arabic messages,
 * name 2–120, optional description ≤ 2000, duration 5–480 minutes,
 * OPTIONAL structured price) come from the shared service validation
 * contract; duration is re-declared only to give empty number inputs an
 * Arabic message, and the price invariants are re-applied via
 * `refineServicePrice` (ZodEffects cannot be reshaped, so the form builds
 * from the plain field object).
 */
export const serviceFormSchema = serviceValidation.createObject
  .omit({ businessId: true })
  .extend({
    durationMinutes: z
      .number({ error: "أدخل مدة الخدمة بالدقائق" })
      .int("المدة يجب أن تكون بالدقائق الكاملة")
      .min(5, "أقل مدة هي 5 دقائق")
      .max(480, "أقصى مدة هي 8 ساعات"),
  })
  .superRefine((value, ctx) => refineServicePrice(value, ctx));

export const updateServiceSchema = z.object({
  id: uuidSchema,
  service: serviceFormSchema,
});

export const setServiceActiveSchema = z.object({
  id: uuidSchema,
  isActive: z.boolean(),
});

/**
 * Removal is addressed by id (never by a client-supplied name); the
 * service layer re-owns the row before touching it.
 */
export const removeServiceSchema = z.object({
  id: uuidSchema,
});

/**
 * Normalized identity key for the duplicate-name guard. Service names
 * are matched on their TRIMMED form only — the owner's own catalog is
 * a small list of distinct names, so a duplicate is a real conflict,
 * not a storage constraint (DECISIONS #23's check-then-create).
 */
export function serviceIdentityKey(name: string): string {
  return name.trim();
}

export type ServiceFormInput = z.infer<typeof serviceFormSchema>;
