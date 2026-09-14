import type { PlatformAiPolicy } from "@/generated/prisma/client";

import { updateAiPolicyInputSchema } from "@/features/platform/schemas/platform-schema";
import type {
  AiPolicyView,
  GetAiPolicySuccess,
  PlatformActor,
  PlatformServiceResult,
  UpdateAiPolicySuccess,
} from "@/features/platform/types";
import type { EffectiveAiPolicy } from "@/lib/validation";
import { aiPolicyRepository } from "@/server/repositories";
import type { AiPolicyRepository } from "@/server/repositories/ai-policy.repository";

/**
 * Platform AI Policy service (PROMPT-OPS-05) — the platform-level,
 * DB-backed LLM provider configuration:
 *
 * - Primary LLM provider + model (required).
 * - Secondary / fallback provider + model (optional).
 * - Fallback enabled/disabled.
 * - Secret REFERENCE names only (env var names) — API keys are
 *   environment-backed secrets (OPENROUTER_API_KEY /
 *   AGENTROUTER_API_KEY) and are NEVER stored in the DB, returned by
 *   any API, or logged.
 *
 * Runtime change semantics: policy/config changes are DB-backed and
 * runtime-readable — no deployment needed. Changing the actual API
 * key is different: it is an environment configuration change and
 * requires redeploy in the current Vercel deployment model.
 *
 * The configuration remains provider-neutral: `ConversationAi`
 * continues to depend on its abstraction/interface — this row is
 * what a future LLM adapter resolves at runtime (`getEffectiveAiPolicy`),
 * with NO provider assumptions inside the Conversation Engine.
 *
 * Provider/model choices live in the DB (changeable without code);
 * the ALLOWLIST of provider identities is validation only
 * (`aiProviderValues` — extending it is integration work).
 *
 * The service composes the repository; the repository re-validates
 * every write. The actor must be a PLATFORM operator (server-derived).
 */

function toView(policy: PlatformAiPolicy): AiPolicyView {
  // getAiPolicy only succeeds when the stored configuration re-validates,
  // so the row's provider identities narrow to the validated union here.
  return {
    primaryProvider: policy.primaryProvider as AiPolicyView["primaryProvider"],
    primaryModel: policy.primaryModel,
    secondaryProvider:
      policy.secondaryProvider as AiPolicyView["secondaryProvider"],
    secondaryModel: policy.secondaryModel,
    fallbackEnabled: policy.fallbackEnabled,
    primarySecretRef: policy.primarySecretRef,
    secondarySecretRef: policy.secondarySecretRef,
    updatedAt: policy.updatedAt,
  };
}

/**
 * Deterministic effective-policy resolution (NO randomness): the
 * primary always resolves; the secondary exists only when the fallback
 * is enabled AND both its provider and model are configured. The
 * stored configuration is re-validated before any caller trusts it —
 * an invalid stored row yields null and `getAiPolicy` fails SAFE to a
 * typed INVALID_POLICY result.
 */
export function toEffectivePolicy(
  policy: PlatformAiPolicy,
): EffectiveAiPolicy | null {
  const parsed = updateAiPolicyInputSchema.safeParse({
    primaryProvider: policy.primaryProvider,
    primaryModel: policy.primaryModel,
    secondaryProvider: policy.secondaryProvider,
    secondaryModel: policy.secondaryModel,
    fallbackEnabled: policy.fallbackEnabled,
  });
  if (!parsed.success) return null;

  const {
    primaryProvider,
    primaryModel,
    secondaryProvider,
    secondaryModel,
    fallbackEnabled,
  } = parsed.data;

  return {
    primaryProvider,
    primaryModel,
    secondary:
      fallbackEnabled && secondaryProvider !== null && secondaryModel
        ? { provider: secondaryProvider, model: secondaryModel }
        : null,
  };
}

/** Narrow repository surface (injectable). */
export type AiPolicyServiceDeps = Readonly<{
  getOrCreate: () => Promise<PlatformAiPolicy>;
  update: (
    data: Parameters<AiPolicyRepository["update"]>[0],
  ) => Promise<PlatformAiPolicy>;
}>;

const defaultDeps: AiPolicyServiceDeps = {
  getOrCreate: () => aiPolicyRepository.getOrCreate(),
  update: (data) => aiPolicyRepository.update(data),
};

/**
 * Reads the effective AI policy (runtime-readable). Returns the
 * display view (secret REFERENCES only) + the deterministic effective
 * policy a future provider adapter consumes.
 */
export async function getAiPolicy(
  deps: AiPolicyServiceDeps = defaultDeps,
): Promise<PlatformServiceResult<GetAiPolicySuccess>> {
  let policy: PlatformAiPolicy;
  try {
    policy = await deps.getOrCreate();
  } catch {
    return {
      success: false,
      error: {
        code: "PERSISTENCE_FAILED",
        message: "تعذر تحميل سياسة الذكاء الاصطناعي",
      },
    };
  }

  const effective = toEffectivePolicy(policy);
  if (!effective) {
    // Fail safe: an invalid stored configuration is never trusted —
    // typed INVALID_POLICY instead of a silently broken config.
    return {
      success: false,
      error: {
        code: "INVALID_POLICY",
        message: "تكوين سياسة الذكاء الاصطناعي غير صالح",
      },
    };
  }
  return {
    success: true,
    data: { policy: toView(policy), effective },
  };
}

/**
 * Updates the AI policy. PLATFORM operators ONLY (server-derived from
 * the persisted user record — Business ADMIN/STAFF and any client
 * input can never modify platform configuration). Invalid provider or
 * model configurations are rejected by the Zod schema before any
 * write.
 */
export async function updateAiPolicy(
  actor: PlatformActor,
  input: unknown,
  deps: AiPolicyServiceDeps = defaultDeps,
): Promise<PlatformServiceResult<UpdateAiPolicySuccess>> {
  if (actor.accountType !== "PLATFORM") {
    return {
      success: false,
      error: {
        code: "FORBIDDEN",
        message: "هذه الصلاحية متاحة لمشغل المنصة فقط",
      },
    };
  }

  const parsed = updateAiPolicyInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: {
        code: "INVALID_INPUT",
        message: parsed.error.issues[0]?.message ?? "بيانات السياسة غير صالحة",
      },
    };
  }

  let policy: PlatformAiPolicy;
  try {
    policy = await deps.update(parsed.data);
  } catch {
    return {
      success: false,
      error: { code: "PERSISTENCE_FAILED", message: "تعذر حفظ السياسة الآن" },
    };
  }
  return { success: true, data: { policy: toView(policy) } };
}
