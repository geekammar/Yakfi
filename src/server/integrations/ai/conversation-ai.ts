/**
 * LLM-backed ConversationAi (PROMPT-AI-02).
 *
 * Implements the same `ConversationAi` interface as
 * `deterministicConversationAi` — no engine/domain change.
 * Uses the orchestrator (primary → secondary on retryable/timeout)
 * and exposes last telemetry for the engine's AI_TURN record.
 */
import type {
  AiRequest,
  AiResponse,
} from "@/features/conversations/server/ai-contract";
import type { ConversationAi } from "@/features/conversations/server/conversation-ai";

import type { JevStrategy } from "./jev-strategy";
import { createAiOrchestrator } from "./orchestrator";
import type { AiProviderAdapter, AiTelemetry } from "./types";

export type LlmConversationAi = ConversationAi & {
  getLastTelemetry(): AiTelemetry | null;
};

export function createLlmConversationAi(params: {
  primary: AiProviderAdapter;
  secondary?: AiProviderAdapter | null;
  fallbackEnabled: boolean;
  /**
   * OPTIONAL JEV decision strategy (PROMPT-AI-ARCH-17 — Slice 8). Absent ⇒ the
   * gateway keeps its exact prior behaviour; present ⇒ the strategy decides
   * whether a turn terminates deterministically or continues to the single
   * existing generative call.
   */
  decisionStrategy?: JevStrategy | null;
}): LlmConversationAi {
  const orchestrator = createAiOrchestrator({
    primary: params.primary,
    secondary: params.secondary ?? null,
    fallbackEnabled: params.fallbackEnabled,
    decisionStrategy: params.decisionStrategy ?? null,
  });

  let lastTelemetry: AiTelemetry | null = null;

  const providerName = params.primary.providerId;

  return {
    providerName,
    async respond(request: AiRequest): Promise<AiResponse> {
      const result = await orchestrator.callWithFallback(request);
      lastTelemetry = result.telemetry;
      if (!result.response) {
        throw new Error(result.lastErrorCode ?? "AI_FAILURE");
      }
      return result.response;
    },
    getLastTelemetry() {
      return lastTelemetry;
    },
  } as LlmConversationAi;
}

// Exposed for tests that want direct orchestrator telemetry without throwing
export function createLlmConversationAiWithNullOnFailure(params: {
  primary: AiProviderAdapter;
  secondary?: AiProviderAdapter | null;
  fallbackEnabled: boolean;
}): ConversationAi & {
  getLastTelemetry(): AiTelemetry | null;
  callRaw(
    request: AiRequest,
  ): Promise<{ response: AiResponse | null; telemetry: AiTelemetry }>;
} {
  const orchestrator = createAiOrchestrator(params as never);
  let lastTelemetry: AiTelemetry | null = null;
  return {
    providerName: params.primary.providerId,
    async respond(request: AiRequest): Promise<AiResponse> {
      const result = await orchestrator.callWithFallback(request);
      lastTelemetry = result.telemetry;
      if (!result.response)
        throw new Error(result.lastErrorCode ?? "AI_FAILURE");
      return result.response;
    },
    getLastTelemetry() {
      return lastTelemetry;
    },
    async callRaw(request: AiRequest) {
      const result = await orchestrator.callWithFallback(request);
      lastTelemetry = result.telemetry;
      return result;
    },
  };
}
