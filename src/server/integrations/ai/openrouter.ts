/**
 * OpenRouter adapter — OpenAI-compatible `/chat/completions`.
 */
import type { AiRequest } from "@/features/conversations/server/ai-contract";

import { callOpenAiCompatible } from "./http";
import { OPENROUTER_NORMALIZATION_POLICY } from "./response-normalizer";
import type {
  AiCallOptions,
  AiProviderAdapter,
  AiProviderResult,
} from "./types";

export const OPENROUTER_ENDPOINT =
  "https://openrouter.ai/api/v1/chat/completions";
export const OPENROUTER_SECRET_REF = "OPENROUTER_API_KEY";
export const OPENROUTER_TIMEOUT_MS = 18000;

export type OpenRouterDeps = {
  model: string;
  getEnvVar(name: string): string | undefined;
  fetchImpl: typeof fetch;
  endpoint?: string;
  timeoutMs?: number;
  /**
   * OPTIONAL OpenRouter provider endpoint pin (PROMPT-AI-OPS-28) — a
   * `owner/model` slug such as `decart/fp4`. When non-empty, inference is
   * restricted to that ONE provider endpoint (`provider.only` +
   * `allow_fallbacks: false`). When null/empty, NO provider restriction is
   * sent and OpenRouter keeps its default routing — byte-for-byte the
   * prior behavior. This is the ONLY place OpenRouter routing semantics
   * live; no engine/orchestrator/prompt layer learns them.
   */
  providerOnly?: string | null;
  /**
   * OPTIONAL output token limit (max_tokens). When supplied, bounds
   * completion length to enforce spending limits.
   */
  maxTokens?: number;
};

export function createOpenRouterAdapter(
  deps: OpenRouterDeps,
): AiProviderAdapter {
  return {
    providerId: "openrouter",
    model: deps.model,
    secretRef: OPENROUTER_SECRET_REF,
    async call(
      request: AiRequest,
      options?: AiCallOptions,
    ): Promise<AiProviderResult> {
      const pinned = deps.providerOnly ? deps.providerOnly.trim() : null;
      const extraBody: Record<string, unknown> = {};
      if (pinned) {
        extraBody.provider = { only: [pinned], allow_fallbacks: false };
      }
      if (typeof deps.maxTokens === "number" && deps.maxTokens > 0) {
        extraBody.max_tokens = deps.maxTokens;
      }
      return callOpenAiCompatible({
        providerId: "openrouter",
        model: deps.model,
        secretRef: OPENROUTER_SECRET_REF,
        endpoint: deps.endpoint ?? OPENROUTER_ENDPOINT,
        getEnvVar: deps.getEnvVar,
        fetchImpl: deps.fetchImpl,
        timeoutMs: deps.timeoutMs ?? OPENROUTER_TIMEOUT_MS,
        request,
        policy: OPENROUTER_NORMALIZATION_POLICY,
        extraBody: Object.keys(extraBody).length > 0 ? extraBody : undefined,
        options,
      });
    },
  };
}
