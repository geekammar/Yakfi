/**
 * CodeCraft adapter — OpenAI-compatible `/chat/completions`
 * (CODECRAFT-DISCOVERY-PROVIDER-58).
 *
 * ONE adapter invocation = ONE provider attempt. This adapter owns ONLY
 * provider execution: endpoint, secret reference, timeout and the shared
 * request/response/error semantics. It owns NO conversation policy.
 *
 * Retry / handoff / notification policy stays with the provider-agnostic
 * Conversation Control Layer
 * (`src/server/integrations/ai/conversation-control/`), exactly as for the
 * other adapters. Removing this file and its registration touches nothing
 * else — see `docs/ai/PROVIDERS.md`.
 *
 * Secrets stay env-names only: the key value is resolved by
 * `getEnvVar(secretRef)` at call time and never stored in the DB, logged,
 * or returned to the client.
 */
import type { AiRequest } from "@/features/conversations/server/ai-contract";

import { callOpenAiCompatible } from "./http";
import { CODECRAFT_NORMALIZATION_POLICY } from "./response-normalizer";
import type {
  AiCallOptions,
  AiProviderAdapter,
  AiProviderResult,
} from "./types";

export const CODECRAFT_ENDPOINT =
  "https://codecraftapi.com/v1/chat/completions";
export const CODECRAFT_SECRET_REF = "CODECRAFT_API_KEY";
export const CODECRAFT_TIMEOUT_MS = 16000;

/**
 * Model discovery endpoint (GET, Bearer auth) — the source of truth for
 * models actually available to the account. Used only by the offline/
 * discovery probes (`scripts/probe-codecraft.ts`); the application never
 * hard-codes a model catalog and the policy keeps storing provider + model.
 */
export const CODECRAFT_MODELS_ENDPOINT = "https://codecraftapi.com/v1/models";

export type CodeCraftDeps = {
  model: string;
  getEnvVar: (name: string) => string | undefined;
  fetchImpl: typeof fetch;
  endpoint?: string;
  timeoutMs?: number;
};

export function createCodeCraftAdapter(deps: CodeCraftDeps): AiProviderAdapter {
  return {
    providerId: "codecraft",
    model: deps.model,
    secretRef: CODECRAFT_SECRET_REF,
    /**
     * Exactly ONE provider attempt. The bounded retry is a Conversation
     * Control concern; this adapter only classifies the attempt's outcome
     * and returns it.
     */
    async call(
      request: AiRequest,
      options?: AiCallOptions,
    ): Promise<AiProviderResult> {
      return callOpenAiCompatible({
        providerId: "codecraft",
        model: deps.model,
        secretRef: CODECRAFT_SECRET_REF,
        endpoint: deps.endpoint ?? CODECRAFT_ENDPOINT,
        getEnvVar: deps.getEnvVar,
        fetchImpl: deps.fetchImpl,
        timeoutMs: deps.timeoutMs ?? CODECRAFT_TIMEOUT_MS,
        request,
        policy: CODECRAFT_NORMALIZATION_POLICY,
        options,
      });
    },
  };
}
