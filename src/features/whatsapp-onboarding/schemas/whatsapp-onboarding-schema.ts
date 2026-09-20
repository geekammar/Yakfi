import { z } from "zod";

/**
 * WhatsApp onboarding input schemas (WHATSAPP-ONBOARDING-01).
 *
 * The client NEVER sends a `businessId`, `connectionId`, `externalId`,
 * `status`, or `isActive`: the target Business is derived from the
 * authenticated actor (BEGIN) or from the persisted authorization
 * ledger (CALLBACK). Zod strips unknown keys, so hostile identity keys
 * (businessId/branchId/role/accountType/status) can never become
 * trusted input.
 */

/**
 * The provider callback payload. `state` is the ONLY thing that
 * identifies the target — `code` is the opaque provider authorization
 * code. No businessId, no connectionId, no externalId: the server
 * resolves all of them from the persisted authorization ledger.
 */
export const whatsappAuthorizationCallbackSchema = z
  .object({
    state: z.string().trim().min(8, "حالة التفويض غير صالحة").max(128),
    code: z.string().trim().min(1, "رمز التفويض مطلوب").max(1024),
  })
  .strict();

export type WhatsAppAuthorizationCallbackInput = z.infer<
  typeof whatsappAuthorizationCallbackSchema
>;

export const whatsappOnboardingValidation = {
  callback: whatsappAuthorizationCallbackSchema,
} as const;
