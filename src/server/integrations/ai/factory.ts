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
import { createCodeCraftAdapter } from "./codecraft";
import { createLlmConversationAi } from "./conversation-ai";
import { createConversationControl } from "./conversation-control";
import type { ConversationControl } from "./conversation-control";
import { createJevDecisionsProvider } from "./jev-decisions-provider";
import { createSemanticJevStrategy } from "./jev-semantic-strategy";
import { createConservativeJevStrategy } from "./jev-strategy";
import { createOpenRouterAdapter } from "./openrouter";
import type { AiProviderAdapter } from "./types";

export type AiFactoryEnvDeps = {
  getEnvVar(name: string): string | undefined;
  fetchImpl: typeof fetch;
  endpointOverrides?: {
    openrouter?: string;
    agentrouter?: string;
    atria?: string;
    codecraft?: string;
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
  /**
   * The OpenRouter provider endpoint pin (PROMPT-AI-OPS-28). Forwarded to
   * the OpenRouter adapter ONLY — every other provider never receives it,
   * so the pin cannot affect non-OpenRouter routing.
   */
  openRouterProviderOnly: string | null = null,
): AiProviderAdapter {
  if (provider === "openrouter") {
    return createOpenRouterAdapter({
      model,
      getEnvVar: env.getEnvVar,
      fetchImpl: env.fetchImpl,
      endpoint: env.endpointOverrides?.openrouter,
      timeoutMs: env.timeoutMs,
      providerOnly: openRouterProviderOnly,
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
  if (provider === "codecraft") {
    return createCodeCraftAdapter({
      model,
      getEnvVar: env.getEnvVar,
      fetchImpl: env.fetchImpl,
      endpoint: env.endpointOverrides?.codecraft,
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
  const rawPrimary = adapterForProvider(
    effective.primaryProvider,
    effective.primaryModel,
    env,
    // PROMPT-AI-OPS-28 — the pin is a policy-level value; it reaches the
    // OpenRouter adapter for BOTH the primary and the secondary slot, so a
    // pinned OpenRouter fallback executes on the same endpoint.
    effective.openRouterProviderOnly ?? null,
  );
  const secondary = effective.secondary
    ? adapterForProvider(
        effective.secondary.provider,
        effective.secondary.model,
        env,
        effective.openRouterProviderOnly ?? null,
      )
    : null;

  // Conversation Control wraps the PRIMARY adapter: bounded retry +
  // handoff + notification policy, provider-agnostic (Phase 14). One
  // adapter invocation stays one provider attempt; the orchestrator and
  // engine still receive exactly ONE result per logical turn.
  const primary: ConversationControl = createConversationControl({
    provider: rawPrimary,
    // The route budget is passed as an attempt-timeout hint only; when
    // absent the layer derives the same default as before.
    attemptTimeoutMs: env.timeoutMs,
  });

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
  // JEV (PROMPT-AI-ARCH-17 — Slice 8): the OPTIONAL conservative decision
  // strategy behind this gateway. It terminates only on turns the repository
  // already proves decidable without a provider; every other turn continues to
  // the single existing generative call. Removing this one argument is the
  // complete rollback.
  //
  // PROMPT-AI-JEV-03B §11 — the SEMANTIC JEV strategy is wired through the SAME
  // dependency-injected seam, gated by ONE explicit environment-controlled kill
  // switch that is DISABLED BY DEFAULT (ABSENT ⇒ OFF; any non-positive value ⇒
  // OFF). When disabled, customer-visible behavior reproduces the exact
  // pre-AI-JEV-03 production behavior (the conservative strategy), and the
  // semantic strategy's `enabled: false` branch never consults the provider —
  // so not supplying it is a complete rollback with no schema, migration or DB
  // coordination. The switch is NOT activated in any environment here.
  const decisionStrategy = isSemanticJevEnabled(deps.getEnvVar)
    ? createSemanticJevStrategy({
        provider: createJevDecisionsProvider({
          getEnvVar: deps.getEnvVar,
          fetchImpl: deps.fetchImpl,
          ...(deps.endpointOverrides?.openrouter
            ? { endpoint: deps.endpointOverrides.openrouter }
            : {}),
          ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}),
        }),
        enabled: true,
      })
    : createConservativeJevStrategy();
  return createLlmConversationAi({
    primary,
    secondary,
    fallbackEnabled,
    decisionStrategy,
  });
}

/**
 * The ONE explicit environment-controlled kill switch for the semantic JEV
 * strategy (PROMPT-AI-JEV-03B §11). DISABLED BY DEFAULT:
 *  · ABSENT            ⇒ OFF
 *  · any non-value     ⇒ OFF
 *  · "0"/"false"/"no"  ⇒ OFF
 *  · "1"/"true"/"yes"  ⇒ ON (the ONLY enablement)
 *
 * No schema, no DB policy row, no tenant-level widening. A disabled switch
 * yields the exact pre-AI-JEV-03 production behavior.
 */
export const SEMANTIC_JEV_FLAG = "FLOWPILOT_JEV_SEMANTIC_ENABLED";

const SEMANTIC_JEV_ENABLEMENTS = new Set(["1", "true", "yes"]);

export function isSemanticJevEnabled(
  getEnvVar: (name: string) => string | undefined,
): boolean {
  const raw = getEnvVar(SEMANTIC_JEV_FLAG);
  if (!raw) return false;
  return SEMANTIC_JEV_ENABLEMENTS.has(raw.trim().toLowerCase());
}

/** Alias matching the BUILD_STATE seam name. */
export async function getEffectiveAiPolicy(): Promise<EffectiveAiPolicy | null> {
  const result = await getAiPolicy();
  return result.success ? result.data.effective : null;
}

/** Synchronous helper for callers that already have the row. */
export { toEffectivePolicy } from "@/features/platform/server/ai-policy-service";
