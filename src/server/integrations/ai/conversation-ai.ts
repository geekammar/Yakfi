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

import type { ShadowJevStrategy } from "./jev-shadow-strategy";
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
  /**
   * OPTIONAL NON-AUTHORITATIVE shadow JEV strategy (PROMPT-AI-JEV-03D —
   * OPTION E). Absent ⇒ no shadow evaluation ever runs. Present ⇒ it runs
   * concurrently with the gateway's single generative call for admitted
   * eligible turns and attaches EVIDENCE-ONLY output to telemetry; it never
   * participates in any decision.
   */
  shadowStrategy?: ShadowJevStrategy | null;
  /** The shadow join deadline (PROMPT-AI-JEV-03C §13.4). */
  shadowTimeoutMs?: number;
  /** Injected environment getter for reading operational controls (CORE-04B). */
  getEnvVar?: (name: string) => string | undefined;
  /** Test clock seam; defaults to Date.now (CORE-04B). */
  getNow?: () => number;
  /** Operational serving timeout / deadline for the logical turn (CORE-04B). */
  servingTimeoutMs?: number;
  /** Operator-configured serving attempt ceiling (1-3; CORE-04B). */
  maxServingAttempts?: number;
}): LlmConversationAi {
  const orchestrator = createAiOrchestrator({
    primary: params.primary,
    secondary: params.secondary ?? null,
    fallbackEnabled: params.fallbackEnabled,
    decisionStrategy: params.decisionStrategy ?? null,
    shadowStrategy: params.shadowStrategy ?? null,
    ...(params.shadowTimeoutMs !== undefined
      ? { shadowTimeoutMs: params.shadowTimeoutMs }
      : {}),
    getEnvVar: params.getEnvVar,
    getNow: params.getNow,
    servingTimeoutMs: params.servingTimeoutMs,
    maxServingAttempts: params.maxServingAttempts,
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
