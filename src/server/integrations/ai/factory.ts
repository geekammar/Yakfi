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
import {
  createShadowJevStrategy,
  createShadowSampler,
  parseShadowTimeoutMs,
} from "./jev-shadow-strategy";
import { createDeterministicBaselineStrategy } from "./jev-strategy";
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
  // CONV-JEV-01: TypeSafe JEV is the PREFERRED semantic engine by default.
  // Gated by:
  // 1. Emergency kill switch: FLOWPILOT_JEV_SEMANTIC_ENABLED=false (or 0/no/off) immediately disables JEV.
  // 2. Production budget safety: in production environments (VERCEL_ENV=production or NODE_ENV=production),
  //    live paid spending remains blocked unless FLOWPILOT_JEV_APPROVED_MONTHLY_BUDGET is configured by the operator.
  // 3. Fallback: if credentials are missing, unreachable, timeout, or invalid response, the engine falls back
  //    safely to the Deterministic Baseline without lost context or unvalidated bookings.
  const semanticPreferred = isTypeSafeJevPreferred(deps.getEnvVar);
  const decisionStrategy = semanticPreferred
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
    : createDeterministicBaselineStrategy();
  // PROMPT-AI-JEV-03D — OPTION E: the NON-AUTHORITATIVE shadow JEV evaluation.
  // The shadow switch is a SEPARATE kill switch, intentionally distinct from
  // the AUTHORITY switch above: the {DISABLED, SHADOW, ACTIVE} lifecycle needs
  // two bits, and turning the shadow off must NEVER change customer routing.
  // The shadow is installed ONLY in the `else` arm of the semantic branch, so:
  //   · semantic=OFF, shadow=OFF ⇒ DISABLED (exact v0.45.0 behaviour);
  //   · semantic=OFF, shadow=ON  ⇒ SHADOW (evidence only, conservative remains
  //     authoritative);
  //   · semantic=ON (any shadow) ⇒ ACTIVE and NO shadow is installed at all —
  //     the real JEV call IS the evidence, so no duplicate evaluation exists.
  // The pair therefore collapses deterministically to ACTIVE; there is no
  // fourth state and no code path from the shadow flag to the semantic
  // strategy.
  const shadowTimeoutMs = parseShadowTimeoutMs(deps.getEnvVar);
  const shadowStrategy =
    !semanticPreferred && isShadowJevEnabled(deps.getEnvVar)
      ? createShadowJevStrategy({
          // The shadow's JEV provider is the SAME pinned, zero-retry Decisions
          // seam the ACTIVE path would use, with the SHADOW deadline as its
          // own request timeout — the provider's AbortController is the shadow
          // deadline, so a slow provider still yields a complete TIMEOUT
          // evidence record instead of a hanging join.
          provider: createJevDecisionsProvider({
            getEnvVar: deps.getEnvVar,
            fetchImpl: deps.fetchImpl,
            ...(deps.endpointOverrides?.openrouter
              ? { endpoint: deps.endpointOverrides.openrouter }
              : {}),
            timeoutMs: shadowTimeoutMs,
          }),
          sampler: createShadowSampler({ getEnvVar: deps.getEnvVar }),
          timeoutMs: shadowTimeoutMs,
        })
      : null;
  return createLlmConversationAi({
    primary,
    secondary,
    fallbackEnabled,
    decisionStrategy,
    shadowStrategy,
    shadowTimeoutMs,
  });
}

/**
 * The ONE explicit environment-controlled kill switch for the semantic JEV
 * strategy (CONV-JEV-01).
 *
 * Emergency kill switch:
 *  · "0"/"false"/"no"/"off" ⇒ OFF (emergency override; JEV is NEVER called)
 *
 * When not explicitly disabled:
 *  · In non-production (dev/eval/preview/playground) ⇒ ON (preferred by default)
 *  · In production (VERCEL_ENV=production or NODE_ENV=production) ⇒ ON only if
 *    FLOWPILOT_JEV_APPROVED_MONTHLY_BUDGET is configured, otherwise safely blocked.
 */
export const SEMANTIC_JEV_FLAG = "FLOWPILOT_JEV_SEMANTIC_ENABLED";

/** Operator approved monthly budget flag for production spending safety (CONV-JEV-01). */
export const JEV_BUDGET_APPROVAL_FLAG = "FLOWPILOT_JEV_APPROVED_MONTHLY_BUDGET";

/** Per-request budget ceiling (USD) for JEV decisions. */
export const JEV_PER_REQUEST_CEILING_USD = 0.005;

/**
 * The SEPARATE, NON-AUTHORITATIVE shadow switch (PROMPT-AI-JEV-03D §15.2).
 */
export const SHADOW_JEV_FLAG = "FLOWPILOT_JEV_SHADOW_ENABLED";

export const SEMANTIC_JEV_ENABLEMENTS = new Set(["1", "true", "yes"]);
export const SEMANTIC_JEV_DISABLEMENTS = new Set(["0", "false", "no", "off"]);

/**
 * Checks whether the emergency kill switch is actively engaged to disable JEV.
 * Returns true if FLOWPILOT_JEV_SEMANTIC_ENABLED is explicitly 0, false, no, or off.
 */
export function isSemanticJevEmergencyDisabled(
  getEnvVar: (name: string) => string | undefined,
): boolean {
  const raw = getEnvVar(SEMANTIC_JEV_FLAG);
  if (!raw) return false;
  return SEMANTIC_JEV_DISABLEMENTS.has(raw.trim().toLowerCase());
}

/**
 * Checks whether TypeSafe JEV is the preferred semantic decision engine (CONV-JEV-01 Step C).
 * Preferred by default unless:
 * 1. Explicit emergency kill switch is engaged (FLOWPILOT_JEV_SEMANTIC_ENABLED=false)
 * 2. In production without an approved operator budget.
 */
export function isTypeSafeJevPreferred(
  getEnvVar: (name: string) => string | undefined,
): boolean {
  if (isSemanticJevEmergencyDisabled(getEnvVar)) return false;

  // Production budget safety rule (CONV-JEV-01 Step C):
  // Unbudgeted live production spending is blocked until an approved budget is supplied.
  const isProd =
    getEnvVar("NODE_ENV") === "production" ||
    getEnvVar("VERCEL_ENV") === "production";
  if (isProd) {
    const approvedBudget = getEnvVar(JEV_BUDGET_APPROVAL_FLAG);
    if (!approvedBudget || approvedBudget.trim().length === 0) {
      return false; // Leave live production spending safely blocked
    }
  }

  return true;
}

/**
 * Explicit positive enablement checker (legacy compatibility).
 */
export function isSemanticJevEnabled(
  getEnvVar: (name: string) => string | undefined,
): boolean {
  const raw = getEnvVar(SEMANTIC_JEV_FLAG);
  if (!raw) return false;
  return SEMANTIC_JEV_ENABLEMENTS.has(raw.trim().toLowerCase());
}

/**
 * The shadow kill switch — a sibling of {@link isSemanticJevEnabled} sharing
 * the identical enablement set (PROMPT-AI-JEV-03C §15.2).
 */
export function isShadowJevEnabled(
  getEnvVar: (name: string) => string | undefined,
): boolean {
  const raw = getEnvVar(SHADOW_JEV_FLAG);
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
