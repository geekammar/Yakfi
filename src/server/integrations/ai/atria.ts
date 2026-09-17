/**
 * Atria adapter — OpenAI-compatible `/chat/completions` (PROMPT-ARCH-AI-PROVIDER-ATRIA-07).
 *
 * Isolated from AgentRouter: this adapter owns ONLY the Atria endpoint,
 * auth reference, and timeout. It reuses the shared OpenAI-compatible
 * HTTP helper, so request construction, response normalization, and the
 * error taxonomy stay identical to the other adapters — the conversation
 * engine keeps consuming a provider-neutral `AiProviderResult`.
 *
 * The API key is read by NAME via `getEnvVar(ATRIA_SECRET_REF)` and is
 * never stored in the DB, logged, or returned to the client.
 */
import type { AiRequest } from "@/features/conversations/server/ai-contract";

import { callOpenAiCompatible } from "./http";
import type { AiProviderAdapter, AiProviderResult } from "./types";

export const ATRIA_ENDPOINT = "https://api.atria-asi.ai/v1/chat/completions";
export const ATRIA_SECRET_REF = "ATRIA_API_KEY";
export const ATRIA_TIMEOUT_MS = 12000;

export type AtriaDeps = {
  model: string;
  getEnvVar(name: string): string | undefined;
  fetchImpl: typeof fetch;
  endpoint?: string;
  timeoutMs?: number;
};

export function createAtriaAdapter(deps: AtriaDeps): AiProviderAdapter {
  return {
    providerId: "atria",
    model: deps.model,
    secretRef: ATRIA_SECRET_REF,
    async call(request: AiRequest): Promise<AiProviderResult> {
      return callOpenAiCompatible({
        providerId: "atria",
        model: deps.model,
        secretRef: ATRIA_SECRET_REF,
        endpoint: deps.endpoint ?? ATRIA_ENDPOINT,
        getEnvVar: deps.getEnvVar,
        fetchImpl: deps.fetchImpl,
        timeoutMs: deps.timeoutMs ?? ATRIA_TIMEOUT_MS,
        request,
      });
    },
  };
}
