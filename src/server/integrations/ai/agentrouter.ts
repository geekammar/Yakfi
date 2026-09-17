/**
 * AgentRouter adapter — OpenAI-compatible `/chat/completions`.
 * Kept separate so endpoint/auth differences stay isolated.
 */
import type { AiRequest } from "@/features/conversations/server/ai-contract";

import { callOpenAiCompatible } from "./http";
import type { AiProviderAdapter, AiProviderResult } from "./types";

export const AGENTROUTER_ENDPOINT =
  "https://agentrouter.org/v1/chat/completions";
export const AGENTROUTER_SECRET_REF = "AGENTROUTER_API_KEY";
export const AGENTROUTER_TIMEOUT_MS = 12000;

export type AgentRouterDeps = {
  model: string;
  getEnvVar(name: string): string | undefined;
  fetchImpl: typeof fetch;
  endpoint?: string;
  timeoutMs?: number;
};

export function createAgentRouterAdapter(
  deps: AgentRouterDeps,
): AiProviderAdapter {
  return {
    providerId: "agentrouter",
    model: deps.model,
    secretRef: AGENTROUTER_SECRET_REF,
    async call(request: AiRequest): Promise<AiProviderResult> {
      return callOpenAiCompatible({
        providerId: "agentrouter",
        model: deps.model,
        secretRef: AGENTROUTER_SECRET_REF,
        endpoint: deps.endpoint ?? AGENTROUTER_ENDPOINT,
        getEnvVar: deps.getEnvVar,
        fetchImpl: deps.fetchImpl,
        timeoutMs: deps.timeoutMs ?? AGENTROUTER_TIMEOUT_MS,
        request,
      });
    },
  };
}
