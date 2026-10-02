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

import type { JevStrategy } from "./jev-strategy";
import { JEV_DETERMINISTIC_PROVIDER } from "./jev-strategy";
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
  /**
   * OPTIONAL JEV decision strategy (PROMPT-AI-ARCH-17 — Slice 8). When absent
   * the gateway keeps its exact prior behaviour (the built-in deterministic
   * bypass), so the strategy is never a mandatory stage. When present it
   * decides whether a turn terminates deterministically (no provider call) or
   * continues to the gateway's SINGLE existing generative call.
   */
  decisionStrategy?: JevStrategy | null;
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
  const { primary, secondary, fallbackEnabled, decisionStrategy } = params;

  async function callWithFallback(
    request: AiRequest,
  ): Promise<OrchestratorResult> {
    // JEV decision strategy (PROMPT-AI-ARCH-17 — Slice 8): an OPTIONAL,
    // provider-neutral decision behind this gateway. A DETERMINISTIC decision
    // terminates the turn with a complete response and ZERO provider attempts;
    // a GENERATIVE decision falls through to the gateway's single existing
    // call. The strategy never calls a model, so the one-call budget is held
    // HERE (the gateway), never by the strategy.
    const jev = decisionStrategy ? decisionStrategy.decide(request) : null;
    const jevDecision = jev
      ? { mode: jev.mode, reason: jev.reason }
      : undefined;
    if (jev && jev.mode === "DETERMINISTIC" && jev.response) {
      return {
        response: jev.response,
        telemetry: {
          attempts: [],
          fallbackUsed: false,
          finalProvider: JEV_DETERMINISTIC_PROVIDER,
          finalModel: null,
          finalStatus: "SUCCESS",
          jevDecision,
        },
      };
    }

    // No strategy configured: the built-in deterministic bypass is the exact
    // prior behaviour (disabling JEV changes nothing but the audit field).
    const bypass = !decisionStrategy ? bypassDeterministicAi(request) : null;
    if (bypass) {
      return {
        response: bypass,
        telemetry: {
          attempts: [],
          fallbackUsed: false,
          finalProvider: "deterministic-bypass",
          finalModel: null,
          finalStatus: "SUCCESS",
          jevDecision,
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
          jevDecision,
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
          jevDecision,
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
          jevDecision,
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
        jevDecision,
      },
      lastErrorCode: second.error.code,
    };
  }

  return { callWithFallback };
}
