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

import type { JevSemanticEvidence } from "./jev-semantic-strategy";
import type { ShadowJevStrategy } from "./jev-shadow-strategy";
import {
  JEV_SHADOW_TIMEOUT_MS,
  shadowMarkerEvidence,
} from "./jev-shadow-strategy";
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
  /**
   * OPTIONAL NON-AUTHORITATIVE shadow JEV strategy
   * (PROMPT-AI-JEV-03D — OPTION E). NEVER consulted for any decision: the
   * authoritative `decisionStrategy` (or the built-in bypass) always decides,
   * and the shadow's result is attached ONLY to the `telemetry.shadow`
   * evidence slot that no decision / resolver / routing / transport code
   * reads. Absent ⇒ the gateway keeps its exact prior behaviour.
   */
  shadowStrategy?: ShadowJevStrategy | null;
  /**
   * The shadow join deadline (PROMPT-AI-JEV-03C §13.4). Bounds how long the
   * gateway waits for shadow evidence AFTER the authoritative result; it
   * never bounds or delays the authoritative call itself.
   */
  shadowTimeoutMs?: number;
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
  const {
    primary,
    secondary,
    fallbackEnabled,
    decisionStrategy,
    shadowStrategy,
  } = params;
  const shadowTimeoutMs = params.shadowTimeoutMs ?? JEV_SHADOW_TIMEOUT_MS;

  /**
   * PROMPT-AI-JEV-03D — OPTION E: join the NON-AUTHORITATIVE shadow evaluation
   * exactly once, at a single choke point, UNDER TOTAL ISOLATION. This can
   * only ever yield `JevSemanticEvidence | null`: the shadow promise is
   * pre-guarded against rejection, the race is bounded by the shadow deadline
   * (cleared on settle so no timer outlives the turn), and any escape is
   * swallowed. A `null` result is a LOST evidence record (funnel
   * not-completed), NEVER a customer-visible event: the authoritative result
   * was already computed from data the shadow never touched.
   */
  async function joinShadow(
    shadowPromise: Promise<JevSemanticEvidence | null> | null,
    shadowMarker: JevSemanticEvidence | null,
  ): Promise<JevSemanticEvidence | null> {
    if (shadowPromise === null) return shadowMarker;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        shadowPromise,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), shadowTimeoutMs);
        }),
      ]);
    } catch {
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async function callWithFallback(
    request: AiRequest,
  ): Promise<OrchestratorResult> {
    // JEV decision strategy (PROMPT-AI-ARCH-17 — Slice 8; PROMPT-AI-JEV-03B):
    // an OPTIONAL, provider-neutral decision behind this gateway. A
    // DETERMINISTIC decision terminates the turn with a complete response and
    // ZERO provider attempts; a GENERATIVE decision falls through to the
    // gateway's single existing call. The strategy never calls the generative
    // provider, so the one-call budget is held HERE (the gateway), never by the
    // strategy.
    //
    // PROMPT-AI-JEV-03B §6: the seam is async so a SEMANTIC strategy may spend
    // its ONE JEV call inside `decide`. The truth table is then exact:
    //   · a proven 0-call bypass (or a JEV success / fail-closed termination)
    //     returns DETERMINISTIC → ZERO generative attempts;
    //   · a pre-attempt unavailability or a JEV-ineligible turn returns
    //     GENERATIVE → the gateway's ONE existing call;
    //   · a JEV failure AFTER an attempt was spent also returns DETERMINISTIC
    //     (the strategy terminates on the lexical baseline) → the LLM is NEVER
    //     called after a spent JEV attempt. There is no two-call row.
    const jev = decisionStrategy
      ? await decisionStrategy.decide(request)
      : null;
    const jevDecision = jev
      ? {
          mode: jev.mode,
          reason: jev.reason,
          ...(jev.semantic ? { semantic: jev.semantic } : {}),
        }
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

    // PROMPT-AI-JEV-03D — OPTION E: the NON-AUTHORITATIVE shadow seam. The
    // authoritative decision ALREADY returned GENERATIVE above, so this turn
    // provably spends the gateway's one generative call — exactly the turn
    // class a semantic activation would replace. Admission is PURE and
    // zero-cost (the ACTIVE eligibility gate + a deterministic sampler), and
    // when admitted the shadow evaluation is STARTED BUT NOT AWAITED right
    // here, so it overlaps `primary.call` instead of serializing after it:
    // the turn's wall clock is max(serving, shadow), never serving + shadow.
    // A deterministic bypass turn (both early returns above) and an ACTIVE
    // semantic turn (the factory installs no shadow in that state) NEVER
    // reach here, so neither can start a shadow model call.
    const shadowAdmission = shadowStrategy
      ? shadowStrategy.admit(request)
      : null;
    const shadowWillRun =
      shadowAdmission !== null &&
      shadowAdmission.eligible &&
      shadowAdmission.sampled;
    const shadowPromise =
      shadowStrategy && shadowWillRun
        ? shadowStrategy.evaluate(request).catch(() => null)
        : null;
    // The pure zero-call marker keeps the eligible → sampled → completed
    // funnel observable for turns that were NOT evaluated.
    const shadowMarker =
      shadowAdmission !== null && !shadowWillRun
        ? shadowMarkerEvidence(shadowAdmission, request)
        : null;

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
          shadow: await joinShadow(shadowPromise, shadowMarker),
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
          shadow: await joinShadow(shadowPromise, shadowMarker),
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
          shadow: await joinShadow(shadowPromise, shadowMarker),
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
        shadow: await joinShadow(shadowPromise, shadowMarker),
      },
      lastErrorCode: second.error.code,
    };
  }

  return { callWithFallback };
}
