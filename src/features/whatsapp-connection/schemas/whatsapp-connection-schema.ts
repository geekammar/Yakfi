import { phoneSchema } from "@/lib/validation";

import { z } from "zod";

/**
 * WhatsApp connection setup input (Business Admin onboarding).
 *
 * The client NEVER sends a `businessId`, `connectionId`, `status`, or
 * `isActive` — the Business is always derived server-side from the
 * authenticated actor, and lifecycle fields are set only by the server
 * workflow. Zod strips every unknown key, so hostile identity keys
 * (businessId/branchId/role/accountType) can never become trusted input.
 *
 * Identity rule: `externalId` (the Meta `phone_number_id`) is the
 * AUTHORITATIVE provider identity. `phoneNumber` is a display label.
 */
const envVarNameSchema = z
  .string({ error: "اكتب اسم متغيّر البيئة السري" })
  .trim()
  .regex(
    /^[A-Z][A-Z0-9_]{2,63}$/,
    "اسم متغيّر البيئة: أحرف إنجليزية كبيرة وأرقام وشرطة سفلية فقط",
  );

export const saveWhatsAppConnectionSchema = z.object({
  /** Optional when updating an existing connection. */
  connectionId: z.uuid("معرّف غير صالح").optional(),
  displayName: z
    .string({ error: "اكتب اسماً مختصراً للاتصال" })
    .trim()
    .min(2, "اكتب اسماً مختصراً للاتصال")
    .max(120, "الاسم طويل جداً")
    .optional(),
  phoneNumber: phoneSchema,
  /**
   * The provider's STABLE connection identity. Required — the connection
   * cannot be resolved inbound without it, and verification proves it.
   */
  externalId: z
    .string({ error: "اكتب معرّف رقم واتساب (phone_number_id)" })
    .trim()
    .min(1, "اكتب معرّف رقم واتساب (phone_number_id)")
    .max(256, "معرّف الاتصال طويل جداً"),
  /**
   * REFERENCE to the stored access token — an environment-variable NAME
   * only. A raw token shape (mixed case, long alphanumeric blob) is
   * rejected by the pattern above: the Business Admin supplies the NAME
   * of the secret the operator stored in the deployment environment,
   * never the secret itself.
   */
  credentialsRef: envVarNameSchema,
});

export type SaveWhatsAppConnectionInput = z.infer<
  typeof saveWhatsAppConnectionSchema
>;

export const whatsappConnectionValidation = {
  save: saveWhatsAppConnectionSchema,
} as const;
