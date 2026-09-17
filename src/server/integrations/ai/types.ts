/**
 * AI provider adapter types (PROMPT-AI-02).
 *
 * The `ConversationAi` contract stays provider-neutral
 * (`AiRequest -> AiResponse`). Provider specifics (HTTP shape,
 * auth, error mapping, token counts) live only in the adapters
 * below — never in Core/Engine/Domain.
 */
import type {
  AiRequest,
  AiResponse,
} from "@/features/conversations/server/ai-contract";

export type AiProviderId = "openrouter" | "agentrouter" | "atria";

/** Provider call outcome taxonomy (minimum spec). */
export type AiProviderErrorCode =
  | "RETRYABLE"
  | "PERMANENT"
  | "TIMEOUT"
  | "INVALID_RESPONSE"
  | "CONFIG_ERROR"
  | "CONTROLLED_FAILURE";

export type AiProviderError = {
  code: AiProviderErrorCode;
  message: string;
  retryable: boolean;
  httpStatus?: number;
};

export function isRetryableAiError(code: AiProviderErrorCode): boolean {
  return code === "RETRYABLE" || code === "TIMEOUT";
}

export type AiProviderSuccess = {
  ok: true;
  response: AiResponse;
  provider: AiProviderId;
  model: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
};

export type AiProviderFailure = {
  ok: false;
  error: AiProviderError;
  provider: AiProviderId;
  model: string;
  latencyMs: number;
};

export type AiProviderResult = AiProviderSuccess | AiProviderFailure;

export interface AiProviderAdapter {
  readonly providerId: AiProviderId;
  readonly model: string;
  readonly secretRef: string;
  call(request: AiRequest): Promise<AiProviderResult>;
}

export type AiTelemetryAttempt = {
  provider: string;
  model: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  status: "SUCCESS" | "FAILURE";
  errorCode?: AiProviderErrorCode;
};

export type AiTelemetry = {
  attempts: AiTelemetryAttempt[];
  fallbackUsed: boolean;
  finalProvider: string;
  finalModel: string | null;
  finalStatus: "SUCCESS" | "FAILURE";
};
