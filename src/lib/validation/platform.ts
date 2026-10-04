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

export const aiProviderValues = [
  "openrouter",
  "agentrouter",
  "atria",
  "codecraft",
] as const;

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
 * An OpenRouter provider endpoint slug (PROMPT-AI-OPS-28) — the `owner/model`
 * shape OpenRouter routes on (e.g. `decart/fp4`). Validation is SHAPE ONLY:
 * the repository has no authoritative provider catalog, so there is no
 * allowlist — the full slug is preserved verbatim (the segment after the
 * slash is meaningful and must never be truncated to `owner`). Surrounding
 * whitespace is trimmed; the empty branch is accepted here and normalized to
 * null by the policy transform below (empty/whitespace-only ⇒ no pin).
 */
export const openRouterProviderOnlySchema = z
  .string()
  .trim()
  .max(120, "مرجع نقطة النهاية طويل جداً")
  .regex(
    /^([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)?$/,
    "مرجع نقطة نهاية المزود غير صالح",
  );

/**
 * Policy update input: primary provider/model (required), optional
 * secondary provider/model + fallback flag. Refinements keep the
 * configuration coherent: a fallback needs a secondary provider, and a
 * secondary provider needs its model. When no secondary is set, the
 * secondary model is normalized to null.
 *
 * `openRouterProviderOnly` (PROMPT-AI-OPS-28) is the OPTIONAL OpenRouter
 * provider endpoint pin. Empty/whitespace-only normalizes to null; a
 * non-empty value must match the endpoint slug shape. It is OpenRouter-only
 * data — persistence and validation accept it for any policy row, but the
 * runtime reads it ONLY when the effective provider is OpenRouter.
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
    openRouterProviderOnly: openRouterProviderOnlySchema.nullable().optional(),
  })
  .transform((data) => ({
    ...data,
    secondaryProvider: data.secondaryProvider ?? null,
    secondaryModel: data.secondaryProvider
      ? (data.secondaryModel ?? null)
      : null,
    // Empty/whitespace-only ⇒ null: no pin is stored and no restriction is
    // ever sent. The trimmed non-empty slug is preserved verbatim.
    openRouterProviderOnly:
      data.openRouterProviderOnly && data.openRouterProviderOnly.length > 0
        ? data.openRouterProviderOnly
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
 *
 * `openRouterProviderOnly` is the OPTIONAL OpenRouter provider endpoint pin.
 * Null/absent ⇒ no provider restriction is sent (the existing OpenRouter
 * behavior is unchanged). Read ONLY by the OpenRouter adapter; every other
 * provider never sees it. The member is itself optional so every existing
 * effective-policy producer stays valid without change.
 */
export type EffectiveAiPolicy = {
  primaryProvider: AiProviderId;
  primaryModel: string;
  secondary: { provider: AiProviderId; model: string } | null;
  openRouterProviderOnly?: string | null;
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
