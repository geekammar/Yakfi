import { acceptInvitationInputSchema } from "@/features/invitations/schemas/invitation-schema";
import { emailSchema, uuidSchema } from "@/lib/validation";
import { updateAiPolicyDtoSchema } from "@/lib/validation/platform";

import { z } from "zod";

/**
 * Platform Control Plane input schemas (PROMPT-OPS-05).
 *
 * The activation token reuses the SHARED invitation token schema (the
 * single source of the token format — no second token system). As in
 * the business invitation flows, the persisted invitation is the sole
 * authority: callers cannot override email/role (Zod strips unknown
 * keys). Password bounds mirror Better Auth's defaults (8–128).
 *
 * The AI-policy input IS the repository DTO (`updateAiPolicyDtoSchema`,
 * lib/validation/platform) — one validated shape for client input and
 * persistence; the repository re-validates it (defense in depth).
 */

export const createOwnerInvitationInputSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(emailSchema),
  // Operator-facing memo for which business the invitation is meant —
  // optional, display-only.
  businessName: z.string().trim().max(120, "اسم المنشأة طويل جداً").optional(),
});

/** The activation schema (token + name + password) — shared format. */
export const activateOwnerInputSchema = z.object({
  token: acceptInvitationInputSchema.shape.token,
  name: z.string().trim().min(2, "الاسم قصير جداً").max(120, "الاسم طويل جداً"),
  password: z
    .string()
    .min(8, "كلمة المرور يجب ألا تقل عن 8 أحرف")
    .max(128, "كلمة المرور طويلة جداً"),
});

export const updateAiPolicyInputSchema = updateAiPolicyDtoSchema;

export type CreateOwnerInvitationInput = z.infer<
  typeof createOwnerInvitationInputSchema
>;
export type ActivateOwnerInput = z.infer<typeof activateOwnerInputSchema>;
export type UpdateAiPolicyInput = z.infer<typeof updateAiPolicyInputSchema>;

/**
 * Platform Business list input (WHATSAPP-ONBOARDING-01) — search +
 * pagination only. `businessId` is never accepted from this input: the
 * list targets are server-derived.
 */
export const platformListBusinessInputSchema = z.object({
  search: z.string().trim().max(120, "نص البحث طويل جداً").optional(),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type PlatformListBusinessInput = z.infer<
  typeof platformListBusinessInputSchema
>;

/**
 * A drill-down target from a link — validated here, then re-resolved
 * server-side. A well-formed id that matches no Business is a typed
 * not-found; an arbitrary string never reaches the repository.
 */
export const platformBusinessIdentitySchema = z.object({
  businessId: uuidSchema,
});

export type PlatformBusinessIdentityInput = z.infer<
  typeof platformBusinessIdentitySchema
>;
