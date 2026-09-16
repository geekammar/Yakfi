/**
 * Fallback orchestrator over two AiProviderAdapters.
 *
 * Deterministic, synchronous fallback:
 *   1. primary → if retryable/timeout and secondary configured → secondary
 *   2. else controlled failure (engine maps null → NEED_HUMAN handoff)
 *
 * No prompt rewrite, no Domain bypass, no queues.
 */
import type {
  AiRequest,
  AiResponse,
} from "@/features/conversations/server/ai-contract";
import { bypassDeterministicAi } from "@/features/conversations/server/conversation-ai";

import type {
  AiProviderAdapter,
  AiProviderResult,
  AiTelemetry,
  AiTelemetryAttempt,
} from "./types";
import { isRetryableAiError } from "./types";

export type CreateAiOrchestratorParams = {
  primary: AiProviderAdapter;
  secondary?: AiProviderAdapter | null;
  fallbackEnabled: boolean;
};

export type OrchestratorResult = {
  response: AiResponse | null;
  telemetry: AiTelemetry;
  lastErrorCode?: string;
};

function toAttempt(result: AiProviderResult): AiTelemetryAttempt {
  if (result.ok) {
    return {
      provider: result.provider,
      model: result.model,
      latencyMs: result.latencyMs,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      status: "SUCCESS",
    };
  }
  return {
    provider: result.provider,
    model: result.model,
    latencyMs: result.latencyMs,
    status: "FAILURE",
    errorCode: result.error.code,
  };
}

export function createAiOrchestrator(params: CreateAiOrchestratorParams) {
  const { primary, secondary, fallbackEnabled } = params;

  async function callWithFallback(
    request: AiRequest,
  ): Promise<OrchestratorResult> {
    const bypass = bypassDeterministicAi(request);
    if (bypass) {
      return {
        response: bypass,
        telemetry: {
          attempts: [],
          fallbackUsed: false,
          finalProvider: "deterministic-bypass",
          finalModel: null,
          finalStatus: "SUCCESS",
        },
      };
    }

    const first = await primary.call(request);
    const firstAttempt = toAttempt(first);
    if (first.ok) {
      return {
        response: first.response,
        telemetry: {
          attempts: [firstAttempt],
          fallbackUsed: false,
          finalProvider: first.provider,
          finalModel: first.model,
          finalStatus: "SUCCESS",
        },
      };
    }

    const retryable = isRetryableAiError(first.error.code);
    const canFallback = fallbackEnabled && !!secondary && retryable;
    if (!canFallback) {
      return {
        response: null,
        telemetry: {
          attempts: [firstAttempt],
          fallbackUsed: false,
          finalProvider: first.provider,
          finalModel: first.model,
          finalStatus: "FAILURE",
        },
        lastErrorCode: first.error.code,
      };
    }

    const second = await secondary!.call(request);
    const secondAttempt = toAttempt(second);
    if (second.ok) {
      return {
        response: second.response,
        telemetry: {
          attempts: [firstAttempt, secondAttempt],
          fallbackUsed: true,
          finalProvider: second.provider,
          finalModel: second.model,
          finalStatus: "SUCCESS",
        },
      };
    }
    return {
      response: null,
      telemetry: {
        attempts: [firstAttempt, secondAttempt],
        fallbackUsed: true,
        finalProvider: second.provider,
        finalModel: second.model,
        finalStatus: "FAILURE",
      },
      lastErrorCode: second.error.code,
    };
  }

  return { callWithFallback };
}
