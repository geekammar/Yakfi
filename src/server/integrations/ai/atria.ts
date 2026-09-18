/**
 * Atria adapter — OpenAI-compatible `/chat/completions`.
 *
 * ONE adapter invocation = ONE provider attempt. This adapter owns ONLY
 * provider execution: endpoint, model, timeout, response_format wiring,
 * bounded Atria normalization, provider authentication and provider error
 * classification. It owns NO conversation policy.
 *
 * Retry / handoff / notification policy moved to the provider-agnostic
 * Conversation Control Layer
 * (`src/server/integrations/ai/conversation-control/`) — see
 * PROMPT-OPS-CONVERSATION-CONTROL-RETRY-HANDOFF-15.
 *
 * Secrets stay env-names only: the key value is resolved by
 * `getEnvVar(secretRef)` at call time and never stored in the DB, logged,
 * or returned to the client.
 */
import type { AiRequest } from "@/features/conversations/server/ai-contract";

import { callOpenAiCompatible } from "./http";
import { ATRIA_NORMALIZATION_POLICY } from "./response-normalizer";
import type { NormalizerPolicy } from "./response-normalizer";
import type { AiProviderAdapter, AiProviderResult } from "./types";

export const ATRIA_ENDPOINT = "https://api.atria-asi.ai/v1/chat/completions";
export const ATRIA_SECRET_REF = "ATRIA_API_KEY";
export const ATRIA_TIMEOUT_MS = 16000;

/**
 * Atria-only JSON-output hardening (PROMPT-OPS-ATRIA-STRUCTURED-OUTPUT).
 *
 * Augments — never replaces — the shared provider-neutral instructions.
 * The request body already carries `response_format: json_object` via the
 * shared `buildRequestBody`; this reinforces the output contract in the
 * SYSTEM message so the provider returns one directly-parseable object.
 */
export const ATRIA_JSON_INSTRUCTIONS = [
  "Return exactly ONE JSON object.",
  "Return JSON only.",
  "Do not return Markdown.",
  "Do not wrap JSON in ``` fences.",
  "Do not add explanations before or after JSON.",
  "Do not return prose.",
  "Do not return multiple JSON objects.",
  "The JSON object must conform to the FlowPilot AI response contract.",
  "Use only the allowed enum values.",
  "Do not invent unknown fields.",
  "The output must be directly parseable by JSON.parse().",
].join(" ");

export type AtriaDeps = {
  model: string;
  getEnvVar: (name: string) => string | undefined;
  fetchImpl: typeof fetch;
  endpoint?: string;
  timeoutMs?: number;
  /**
   * Optional override of the bounded normalization policy (default:
   * {@link ATRIA_NORMALIZATION_POLICY}). Used only by controlled probes to
   * A/B candidate pipelines; production wiring never overrides it.
   */
  policy?: NormalizerPolicy;
};

export function createAtriaAdapter(deps: AtriaDeps): AiProviderAdapter {
  return {
    providerId: "atria",
    model: deps.model,
    secretRef: ATRIA_SECRET_REF,
    /**
     * Exactly ONE provider attempt. The bounded retry that used to live
     * here is now a Conversation Control concern; this adapter only
     * classifies the attempt's outcome and returns it.
     */
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
        extraSystemInstructions: ATRIA_JSON_INSTRUCTIONS,
        // BOUNDED, purely-syntactic Atria rules (surplus leading brace +
        // empty-key wrapper). The engine scope-gates them to provider
        // "atria", and every candidate still passes strict JSON.parse() +
        // the unchanged aiResponseSchema. See response-normalizer/.
        policy: deps.policy ?? ATRIA_NORMALIZATION_POLICY,
      });
    },
  };
}
