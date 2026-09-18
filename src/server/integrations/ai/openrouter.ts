/**
 * OpenRouter adapter — OpenAI-compatible `/chat/completions`.
 */
import type { AiRequest } from "@/features/conversations/server/ai-contract";

import { callOpenAiCompatible } from "./http";
import { OPENROUTER_NORMALIZATION_POLICY } from "./response-normalizer";
import type { AiProviderAdapter, AiProviderResult } from "./types";

export const OPENROUTER_ENDPOINT =
  "https://openrouter.ai/api/v1/chat/completions";
export const OPENROUTER_SECRET_REF = "OPENROUTER_API_KEY";
export const OPENROUTER_TIMEOUT_MS = 12000;

export type OpenRouterDeps = {
  model: string;
  getEnvVar(name: string): string | undefined;
  fetchImpl: typeof fetch;
  endpoint?: string;
  timeoutMs?: number;
};

export function createOpenRouterAdapter(
  deps: OpenRouterDeps,
): AiProviderAdapter {
  return {
    providerId: "openrouter",
    model: deps.model,
    secretRef: OPENROUTER_SECRET_REF,
    async call(request: AiRequest): Promise<AiProviderResult> {
      return callOpenAiCompatible({
        providerId: "openrouter",
        model: deps.model,
        secretRef: OPENROUTER_SECRET_REF,
        endpoint: deps.endpoint ?? OPENROUTER_ENDPOINT,
        getEnvVar: deps.getEnvVar,
        fetchImpl: deps.fetchImpl,
        timeoutMs: deps.timeoutMs ?? OPENROUTER_TIMEOUT_MS,
        request,
        // Explicit EMPTY policy: OpenRouter stays on the strict parser +
        // unchanged aiResponseSchema alone (byte-for-byte unchanged).
        policy: OPENROUTER_NORMALIZATION_POLICY,
      });
    },
  };
}
