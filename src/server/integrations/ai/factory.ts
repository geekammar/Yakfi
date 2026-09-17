/**
 * Policy-backed ConversationAi factory (PROMPT-AI-02).
 *
 * Resolves the effective AI policy at runtime (no hard-coded provider or
 * model) and builds the fallback-aware ConversationAi.
 *
 * - Primary is always `effective.primaryProvider` / `effective.primaryModel`.
 * - Secondary exists only when fallback is enabled AND provider+model are
 *   configured (the `effective.secondary` contract from
 *   `toEffectivePolicy`).
 * - Secrets are env-names only via `secretRefFor(provider)` — never keys.
 * - No DB access outside `getAiPolicy`; no Domain/Engine changes.
 */
import { deterministicConversationAi } from "@/features/conversations/server/conversation-ai";
import type { ConversationAi } from "@/features/conversations/server/conversation-ai";
import { getAiPolicy } from "@/features/platform/server/ai-policy-service";
import type { EffectiveAiPolicy } from "@/lib/validation/platform";

import { createAgentRouterAdapter } from "./agentrouter";
import { createAtriaAdapter } from "./atria";
import { createLlmConversationAi } from "./conversation-ai";
import { createOpenRouterAdapter } from "./openrouter";
import type { AiProviderAdapter } from "./types";

export type AiFactoryEnvDeps = {
  getEnvVar(name: string): string | undefined;
  fetchImpl: typeof fetch;
  endpointOverrides?: {
    openrouter?: string;
    agentrouter?: string;
    atria?: string;
  };
  timeoutMs?: number;
};

export type AiFactoryDeps = AiFactoryEnvDeps & {
  getAiPolicyImpl?: typeof getAiPolicy;
};

function adapterForProvider(
  provider: EffectiveAiPolicy["primaryProvider"],
  model: string,
  env: AiFactoryEnvDeps,
): AiProviderAdapter {
  if (provider === "openrouter") {
    return createOpenRouterAdapter({
      model,
      getEnvVar: env.getEnvVar,
      fetchImpl: env.fetchImpl,
      endpoint: env.endpointOverrides?.openrouter,
      timeoutMs: env.timeoutMs,
    });
  }
  if (provider === "atria") {
    return createAtriaAdapter({
      model,
      getEnvVar: env.getEnvVar,
      fetchImpl: env.fetchImpl,
      endpoint: env.endpointOverrides?.atria,
      timeoutMs: env.timeoutMs,
    });
  }
  return createAgentRouterAdapter({
    model,
    getEnvVar: env.getEnvVar,
    fetchImpl: env.fetchImpl,
    endpoint: env.endpointOverrides?.agentrouter,
    timeoutMs: env.timeoutMs,
  });
}

export function adaptersFromEffectivePolicy(
  effective: EffectiveAiPolicy,
  env: AiFactoryEnvDeps,
): {
  primary: AiProviderAdapter;
  secondary: AiProviderAdapter | null;
  fallbackEnabled: boolean;
} {
  const primary = adapterForProvider(
    effective.primaryProvider,
    effective.primaryModel,
    env,
  );
  const secondary = effective.secondary
    ? adapterForProvider(
        effective.secondary.provider,
        effective.secondary.model,
        env,
      )
    : null;
  return { primary, secondary, fallbackEnabled: !!effective.secondary };
}

/**
 * Resolve a ConversationAi from the live platform policy.
 * Falls back to the deterministic assistant when the policy cannot be
 * read or is invalid — the engine stays safe.
 */
export async function createPolicyBackedAi(
  deps: AiFactoryDeps,
): Promise<ConversationAi> {
  const getPolicy = deps.getAiPolicyImpl ?? getAiPolicy;
  let effective: EffectiveAiPolicy | null = null;
  try {
    const result = await getPolicy();
    if (result.success) effective = result.data.effective;
  } catch {
    effective = null;
  }
  if (!effective) return deterministicConversationAi;

  const { primary, secondary, fallbackEnabled } = adaptersFromEffectivePolicy(
    effective,
    deps,
  );
  return createLlmConversationAi({ primary, secondary, fallbackEnabled });
}

/** Alias matching the BUILD_STATE seam name. */
export async function getEffectiveAiPolicy(): Promise<EffectiveAiPolicy | null> {
  const result = await getAiPolicy();
  return result.success ? result.data.effective : null;
}

/** Synchronous helper for callers that already have the row. */
export { toEffectivePolicy } from "@/features/platform/server/ai-policy-service";
