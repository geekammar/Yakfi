import type { AiProviderId } from "@/lib/validation";
import { aiProviderValues } from "@/lib/validation";

/**
 * Operator-approved AI provider identities (PROMPT-OPS-05): Arabic
 * display labels for the Platform UI + the deterministic secret
 * reference each provider resolves to.
 *
 * The CHOICE of primary/secondary lives in the DB-backed policy
 * (runtime-changeable without code); this list is the validation
 * allowlist — adding a provider is integration work and extends it.
 */

export const AI_PROVIDER_LABELS: Record<AiProviderId, string> = {
  openrouter: "OpenRouter",
  agentrouter: "AgentRouter",
  atria: "Atria",
  codecraft: "CodeCraft",
};

export const AI_PROVIDER_OPTIONS = aiProviderValues.map((value) => ({
  value,
  label: AI_PROVIDER_LABELS[value],
}));

/**
 * The deterministic secret reference (env var name) for a provider —
 * the NAME only, never a key. Keys stay environment-backed:
 * OPENROUTER_API_KEY / AGENTROUTER_API_KEY / ATRIA_API_KEY /
 * CODECRAFT_API_KEY.
 */
export function secretRefFor(provider: AiProviderId): string {
  if (provider === "openrouter") return "OPENROUTER_API_KEY";
  if (provider === "atria") return "ATRIA_API_KEY";
  if (provider === "codecraft") return "CODECRAFT_API_KEY";
  return "AGENTROUTER_API_KEY";
}
