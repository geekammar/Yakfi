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
  // When the adapter ran a bounded internal retry via the Conversation
  // Control Layer, the provider result's latencyMs covers only the LAST
  // physical attempt. The logical AI turn's true wall-clock is the retry
  // trace's total, so prefer it; results without a retry trace are
  // byte-for-byte unchanged.
  const logicalLatency = result.retryTrace?.totalElapsedMs ?? result.latencyMs;
  if (result.ok) {
    return {
      provider: result.provider,
      model: result.model,
      latencyMs: logicalLatency,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      status: "SUCCESS",
    };
  }
  return {
    provider: result.provider,
    model: result.model,
    latencyMs: logicalLatency,
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
    // The Conversation Control Layer's bounded retry (if any) is one
    // logical AI turn: surface its sanitized attempt trace and handoff/
    // notification outcome exactly once here, so the engine's AI_TURN
    // record can observe retry behaviour without any schema change and
    // without double-counting a provider call.
    const retryTrace = first.retryTrace;
    const conversationControl = first.conversationControl;
    if (first.ok) {
      return {
        response: first.response,
        telemetry: {
          attempts: [firstAttempt],
          fallbackUsed: false,
          finalProvider: first.provider,
          finalModel: first.model,
          finalStatus: "SUCCESS",
          retryTrace,
          conversationControl,
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
          retryTrace,
          conversationControl,
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
          retryTrace: retryTrace ?? second.retryTrace,
          conversationControl:
            conversationControl ?? second.conversationControl,
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
        retryTrace: retryTrace ?? second.retryTrace,
        conversationControl: conversationControl ?? second.conversationControl,
      },
      lastErrorCode: second.error.code,
    };
  }

  return { callWithFallback };
}
