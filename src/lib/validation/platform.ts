import { z } from "zod";

/**
 * Platform Control Plane validation (PROMPT-OPS-05).
 *
 * Provider identities: the operator-approved allowlist — a stable
 * machine-key union like `CONFIRMATION_MODE_VALUES`. The CHOICE of
 * primary/secondary lives in the DB-backed policy (runtime-changeable);
 * the allowlist is validation, not a hard-coded choice. Adding a new
 * provider is integration work and extends this union.
 *
 * SECRETS: policy rows carry secret REFERENCE NAMES only (env var
 * names) — never API keys. `secretRefSchema` enforces the env-var-name
 * shape so an actual credential can never be persisted as config.
 */

export const aiProviderValues = ["openrouter", "agentrouter"] as const;

export type AiProviderId = (typeof aiProviderValues)[number];

/** Env-var-name shape for secret references (UPPER_SNAKE_CASE). */
export const secretRefSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{2,63}$/, "مرجع المفتاح غير صالح");

const modelSchema = z
  .string()
  .trim()
  .min(1, "معرّف النموذج مطلوب")
  .max(120, "معرّف النموذج طويل جداً");

/**
 * Policy update input: primary provider/model (required), optional
 * secondary provider/model + fallback flag. Refinements keep the
 * configuration coherent: a fallback needs a secondary provider, and a
 * secondary provider needs its model. When no secondary is set, the
 * secondary model is normalized to null.
 */
export const updateAiPolicyDtoSchema = z
  .object({
    primaryProvider: z.enum(aiProviderValues, "المزود غير مدعوم"),
    primaryModel: modelSchema,
    secondaryProvider: z
      .enum(aiProviderValues, "المزود غير مدعوم")
      .nullable()
      .optional(),
    secondaryModel: modelSchema.nullable().optional(),
    fallbackEnabled: z.boolean(),
  })
  .transform((data) => ({
    ...data,
    secondaryProvider: data.secondaryProvider ?? null,
    secondaryModel: data.secondaryProvider
      ? (data.secondaryModel ?? null)
      : null,
  }))
  .refine(
    (data) => !data.fallbackEnabled || data.secondaryProvider !== null,
    "التراجع للاحتياطي يتطلب مزوداً احتياطياً",
  )
  .refine(
    (data) => data.secondaryProvider === null || data.secondaryModel !== null,
    "معرّف نموذج المزود الاحتياطي مطلوب",
  );

export type UpdateAiPolicyDto = z.infer<typeof updateAiPolicyDtoSchema>;

/**
 * The effective policy as consumed at runtime (deterministic): the
 * primary always resolves; the secondary exists only when the fallback
 * is enabled AND both its provider and model are configured.
 */
export type EffectiveAiPolicy = {
  primaryProvider: AiProviderId;
  primaryModel: string;
  secondary: { provider: AiProviderId; model: string } | null;
};

/** PlatformInvitation creation (repository DTO). */
export const createPlatformInvitationDtoSchema = z.object({
  email: z.string(),
  businessName: z.string().nullable().optional(),
  tokenHash: z.string(),
  expiresAt: z.date(),
  createdById: z.string().nullable().optional(),
});

export type CreatePlatformInvitationDto = z.infer<
  typeof createPlatformInvitationDtoSchema
>;
