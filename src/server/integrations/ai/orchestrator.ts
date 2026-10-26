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

import {
  DEFAULT_SERVING_ROUTE_BUDGET_MS,
  HARD_CEILING_SERVING_ATTEMPTS,
  createServingExecutionSession,
} from "./execution-limits";
import { computeCostAggregation, type CostAggregation } from "./http";
import type { JevSemanticEvidence } from "./jev-semantic-strategy";
import type { ShadowJevStrategy } from "./jev-shadow-strategy";
import {
  JEV_SHADOW_TIMEOUT_MS,
  shadowMarkerEvidence,
} from "./jev-shadow-strategy";
import type { JevStrategy } from "./jev-strategy";
import { JEV_DETERMINISTIC_PROVIDER } from "./jev-strategy";
import type {
  AiCallOptions,
  AiProviderAdapter,
  AiProviderResult,
  AiRetryAttemptRecord,
  AiRetryTrace,
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
  /** Injected environment getter for reading operational controls (CORE-04B). */
  getEnvVar?: (name: string) => string | undefined;
  /** Test clock seam; defaults to Date.now (CORE-04B). */
  getNow?: () => number;
  /** Operational serving timeout / deadline for the logical turn (CORE-04B). */
  servingTimeoutMs?: number;
  /** Operator-configured serving attempt ceiling (1-3; CORE-04B). */
  maxServingAttempts?: number;
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
  const httpAttempts =
    result.retryTrace?.totalHttpAttempts !== undefined
      ? result.retryTrace.totalHttpAttempts
      : result.httpAttempts;
  if (result.ok) {
    return {
      provider: result.provider,
      model: result.model,
      latencyMs: logicalLatency,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      status: "SUCCESS",
      ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
      ...(httpAttempts !== undefined ? { httpAttempts } : {}),
    };
  }
  const rawStatus =
    result.error.httpStatus ??
    (result.retryTrace?.attempts
      ? [...result.retryTrace.attempts]
          .reverse()
          .find((a) => a.httpStatus !== undefined)?.httpStatus
      : undefined);
  const validStatus =
    typeof rawStatus === "number" &&
    Number.isInteger(rawStatus) &&
    rawStatus >= 300 &&
    rawStatus <= 599
      ? rawStatus
      : undefined;

  return {
    provider: result.provider,
    model: result.model,
    latencyMs: logicalLatency,
    status: "FAILURE",
    errorCode: result.error.code,
    ...(validStatus !== undefined ? { httpStatus: validStatus } : {}),
    ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
    ...(result.inputTokens !== undefined
      ? { inputTokens: result.inputTokens }
      : {}),
    ...(result.outputTokens !== undefined
      ? { outputTokens: result.outputTokens }
      : {}),
    ...(httpAttempts !== undefined ? { httpAttempts } : {}),
  };
}

function extractAttemptsFrom(result: AiProviderResult): AiRetryAttemptRecord[] {
  if (result.retryTrace?.attempts && result.retryTrace.attempts.length > 0) {
    return result.retryTrace.attempts;
  }
  const rawStatus = result.ok ? undefined : result.error.httpStatus;
  const validStatus =
    typeof rawStatus === "number" &&
    Number.isInteger(rawStatus) &&
    rawStatus >= 300 &&
    rawStatus <= 599
      ? rawStatus
      : undefined;
  return [
    {
      attempt: 1,
      outcome: result.ok ? "SUCCESS" : "FAILURE",
      errorCode: result.ok ? undefined : result.error.code,
      latencyMs: result.latencyMs,
      httpAttempts: result.httpAttempts,
      provider: result.provider,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: result.costUsd,
      ...(validStatus !== undefined ? { httpStatus: validStatus } : {}),
    },
  ];
}

function aggregateExecutionTrace(
  first: AiProviderResult,
  second?: AiProviderResult | null,
): {
  retryTrace: AiRetryTrace | undefined;
  totalHttpAttempts: number | null;
  costAgg: CostAggregation;
} {
  const firstAttempts = extractAttemptsFrom(first);
  if (!second) {
    const allKnown = firstAttempts.every(
      (a) => a.httpAttempts !== undefined && a.httpAttempts !== null,
    );
    const totalHttpAttempts = allKnown
      ? firstAttempts.reduce((acc, a) => acc + (a.httpAttempts ?? 0), 0)
      : null;
    const costAgg = computeCostAggregation(firstAttempts);

    if (first.retryTrace) {
      return {
        retryTrace: {
          ...first.retryTrace,
          totalCostUsd: first.retryTrace.totalCostUsd ?? costAgg.totalCostUsd,
          knownCostSubtotalUsd:
            first.retryTrace.knownCostSubtotalUsd ??
            costAgg.knownCostSubtotalUsd,
          costCompleteness:
            first.retryTrace.costCompleteness ?? costAgg.costCompleteness,
        },
        totalHttpAttempts,
        costAgg,
      };
    }
    return {
      retryTrace: undefined,
      totalHttpAttempts,
      costAgg,
    };
  }

  // Fallback: aggregate primary and secondary attempt traces truthfully
  const secondAttempts = extractAttemptsFrom(second);
  const combinedAttempts: AiRetryAttemptRecord[] = [];
  let seq = 1;
  for (const a of firstAttempts) {
    combinedAttempts.push({ ...a, attempt: seq++ });
  }
  for (const a of secondAttempts) {
    combinedAttempts.push({ ...a, attempt: seq++ });
  }

  const allKnown = combinedAttempts.every(
    (a) => a.httpAttempts !== undefined && a.httpAttempts !== null,
  );
  const totalHttpAttempts = allKnown
    ? combinedAttempts.reduce((acc, a) => acc + (a.httpAttempts ?? 0), 0)
    : null;

  const costAgg = computeCostAggregation(combinedAttempts);

  const totalElapsedMs =
    (first.retryTrace?.totalElapsedMs ?? first.latencyMs) +
    (second.retryTrace?.totalElapsedMs ?? second.latencyMs);

  const retryTrace: AiRetryTrace = {
    provider: second.provider,
    maxAttempts:
      (first.retryTrace?.maxAttempts ?? 1) +
      (second.retryTrace?.maxAttempts ?? 1),
    attempts: combinedAttempts,
    retryAttempted: combinedAttempts.length > 1,
    retryTriggerCode:
      first.retryTrace?.retryTriggerCode ??
      (first.ok ? null : first.error.code),
    retrySkippedReason:
      second.retryTrace?.retrySkippedReason ??
      (second.ok ? "NONE" : "MAX_ATTEMPTS_REACHED"),
    deadlineMs:
      second.retryTrace?.deadlineMs ??
      first.retryTrace?.deadlineMs ??
      Date.now(),
    retryTimeoutMs:
      second.retryTrace?.retryTimeoutMs ??
      first.retryTrace?.retryTimeoutMs ??
      0,
    finalOutcome: second.ok ? "SUCCESS" : "FAILURE",
    totalElapsedMs,
    ...(totalHttpAttempts !== null ? { totalHttpAttempts } : {}),
    totalCostUsd: costAgg.totalCostUsd,
    knownCostSubtotalUsd: costAgg.knownCostSubtotalUsd,
    costCompleteness: costAgg.costCompleteness,
  };

  return { retryTrace, totalHttpAttempts, costAgg };
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
    options?: AiCallOptions,
  ): Promise<OrchestratorResult> {
    const primaryMax = (primary as { maxAttempts?: number }).maxAttempts ?? 2;
    const secondaryMax =
      fallbackEnabled && secondary
        ? ((secondary as { maxAttempts?: number }).maxAttempts ?? 1)
        : 0;
    const derivedMaxAttempts = Math.min(
      HARD_CEILING_SERVING_ATTEMPTS,
      primaryMax + secondaryMax,
    );

    const session =
      options?.session ??
      createServingExecutionSession({
        getEnvVar: params.getEnvVar,
        getNow: params.getNow,
        timeoutMs: options?.timeoutMs ?? params.servingTimeoutMs,
        maxAttemptsOverride:
          params.maxServingAttempts !== undefined
            ? params.maxServingAttempts
            : params.getEnvVar
              ? undefined
              : derivedMaxAttempts,
      });

    const requiresStructuredTurn =
      request.requiredSemanticCapability === "structured_turn";

    let jevDecision: AiTelemetry["jevDecision"];

    if (!requiresStructuredTurn) {
      // Mechanical / deterministic bypass first (DECISIONS #33, CORE-04B §5).
      // Zero-call offer selection and greetings proceed deterministically without AI
      // even when the external model global stop is engaged.
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
            totalHttpAttempts: 0,
            stopReason: null,
          },
        };
      }

      // Check operational limits before external model dispatch (JEV / LLM)
      const dispatchCheck = session.canDispatch();
      if (!dispatchCheck.allowed) {
        return {
          response: null,
          telemetry: {
            attempts: [],
            fallbackUsed: false,
            finalProvider: primary.providerId,
            finalModel: primary.model,
            finalStatus: "FAILURE",
            totalHttpAttempts: 0,
            stopReason: session.getStopReason(),
          },
          lastErrorCode: "CONTROLLED_FAILURE",
        };
      }

      // JEV decision strategy (Slice 8, PROMPT-AI-JEV-03B, CORE-04B §3)
      const attemptsBeforeJev = session.getDispatchedAttempts();
      const jev = decisionStrategy
        ? await decisionStrategy.decide(request, {
            ...options,
            session,
            timeoutMs: session.getRemainingTimeoutMs(
              options?.timeoutMs ??
                params.servingTimeoutMs ??
                DEFAULT_SERVING_ROUTE_BUDGET_MS,
            ),
          })
        : null;
      jevDecision = jev
        ? {
            mode: jev.mode,
            reason: jev.reason,
            ...(jev.semantic ? { semantic: jev.semantic } : {}),
          }
        : undefined;

      const jevCallSpent = !!jev?.semantic?.jevCallSpent;
      // If JEV spent an attempt but provider did not record it via session (legacy/mock provider):
      if (
        jevCallSpent &&
        session.getDispatchedAttempts() === attemptsBeforeJev
      ) {
        session.recordDispatch(1);
      }

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
            totalHttpAttempts: session.getDispatchedAttempts(),
            stopReason: session.getStopReason(),
          },
        };
      }

      // If JEV spent a serving attempt, NO serving LLM request may follow it! (CORE-04B §3/§8)
      if (jevCallSpent) {
        return {
          response: jev?.response ?? null,
          telemetry: {
            attempts: [],
            fallbackUsed: false,
            finalProvider: JEV_DETERMINISTIC_PROVIDER,
            finalModel: null,
            finalStatus: jev?.response ? "SUCCESS" : "FAILURE",
            jevDecision,
            totalHttpAttempts: session.getDispatchedAttempts() || 1,
            stopReason: session.getStopReason(),
          },
          lastErrorCode: jev?.response ? undefined : "CONTROLLED_FAILURE",
        };
      }
    } else {
      // Structured turn: check operational limits before external model dispatch
      const dispatchCheck = session.canDispatch();
      if (!dispatchCheck.allowed) {
        return {
          response: null,
          telemetry: {
            attempts: [],
            fallbackUsed: false,
            finalProvider: primary.providerId,
            finalModel: primary.model,
            finalStatus: "FAILURE",
            totalHttpAttempts: 0,
            stopReason: session.getStopReason(),
          },
          lastErrorCode: "CONTROLLED_FAILURE",
        };
      }
    }

    // Shadow evaluation (OPTION E) — global stop blocks shadow too (CORE-04B §8)
    const stopReasonBeforeShadow = session.getStopReason();
    const isGloballyStopped =
      stopReasonBeforeShadow === "GLOBAL_STOP" ||
      stopReasonBeforeShadow === "INVALID_CONTROL_CONFIG";

    const shadowAdmission =
      shadowStrategy && !requiresStructuredTurn && !isGloballyStopped
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
    const shadowMarker =
      shadowAdmission !== null && !shadowWillRun
        ? shadowMarkerEvidence(shadowAdmission, request)
        : null;

    // Primary LLM dispatch: check remaining serving allowance and deadline
    const canDispatchPrimary = session.canDispatch();
    if (!canDispatchPrimary.allowed) {
      return {
        response: null,
        telemetry: {
          attempts: [],
          fallbackUsed: false,
          finalProvider: primary.providerId,
          finalModel: primary.model,
          finalStatus: "FAILURE",
          totalHttpAttempts: 0,
          stopReason: session.getStopReason(),
          shadow: await joinShadow(shadowPromise, shadowMarker),
        },
        lastErrorCode: "CONTROLLED_FAILURE",
      };
    }

    const primaryRemainingTimeout = session.getRemainingTimeoutMs(
      options?.timeoutMs ??
        params.servingTimeoutMs ??
        DEFAULT_SERVING_ROUTE_BUDGET_MS,
    );
    const first = await primary.call(request, {
      ...options,
      session,
      timeoutMs: primaryRemainingTimeout,
    });
    // Record physical attempt if adapter did not already record via session
    if (first.httpAttempts && session.getDispatchedAttempts() === 0) {
      session.recordDispatch(first.httpAttempts);
    }
    const firstAttempt = toAttempt(first);
    const conversationControl = first.conversationControl;
    if (first.ok) {
      const {
        retryTrace: aggregatedTrace,
        totalHttpAttempts,
        costAgg,
      } = aggregateExecutionTrace(first);
      return {
        response: first.response,
        telemetry: {
          attempts: [firstAttempt],
          fallbackUsed: false,
          finalProvider: first.provider,
          finalModel: first.model,
          finalStatus: "SUCCESS",
          retryTrace: aggregatedTrace,
          conversationControl,
          jevDecision,
          shadow: await joinShadow(shadowPromise, shadowMarker),
          totalHttpAttempts,
          totalCostUsd: costAgg.totalCostUsd,
          knownCostSubtotalUsd: costAgg.knownCostSubtotalUsd,
          costCompleteness: costAgg.costCompleteness,
          stopReason: null,
        },
      };
    }

    const retryable = isRetryableAiError(first.error.code);
    const canFallback = fallbackEnabled && !!secondary && retryable;
    if (!canFallback) {
      const {
        retryTrace: aggregatedTrace,
        totalHttpAttempts,
        costAgg,
      } = aggregateExecutionTrace(first);
      return {
        response: null,
        telemetry: {
          attempts: [firstAttempt],
          fallbackUsed: false,
          finalProvider: first.provider,
          finalModel: first.model,
          finalStatus: "FAILURE",
          retryTrace: aggregatedTrace,
          conversationControl,
          jevDecision,
          shadow: await joinShadow(shadowPromise, shadowMarker),
          totalHttpAttempts,
          totalCostUsd: costAgg.totalCostUsd,
          knownCostSubtotalUsd: costAgg.knownCostSubtotalUsd,
          costCompleteness: costAgg.costCompleteness,
          stopReason: session.getStopReason() ?? null,
        },
        lastErrorCode: first.error.code,
      };
    }

    // Shared per-execution serving-attempt allowance and deadline check before fallback (CORE-04B)
    const canDispatchSecondary = session.canDispatch();
    if (!canDispatchSecondary.allowed) {
      const {
        retryTrace: aggregatedTrace,
        totalHttpAttempts,
        costAgg,
      } = aggregateExecutionTrace(first);
      return {
        response: null,
        telemetry: {
          attempts: [firstAttempt],
          fallbackUsed: false,
          finalProvider: first.provider,
          finalModel: first.model,
          finalStatus: "FAILURE",
          retryTrace: aggregatedTrace,
          conversationControl,
          jevDecision,
          shadow: await joinShadow(shadowPromise, shadowMarker),
          totalHttpAttempts,
          totalCostUsd: costAgg.totalCostUsd,
          knownCostSubtotalUsd: costAgg.knownCostSubtotalUsd,
          costCompleteness: costAgg.costCompleteness,
          stopReason: session.getStopReason() ?? canDispatchSecondary.reason,
        },
        lastErrorCode: first.error.code,
      };
    }

    const secondaryRemainingTimeout = session.getRemainingTimeoutMs(
      options?.timeoutMs ??
        params.servingTimeoutMs ??
        DEFAULT_SERVING_ROUTE_BUDGET_MS,
    );
    const second = await secondary!.call(request, {
      ...options,
      session,
      timeoutMs: secondaryRemainingTimeout,
    });
    if (
      second.httpAttempts &&
      session.getDispatchedAttempts() <= (first.httpAttempts ?? 0)
    ) {
      session.recordDispatch(second.httpAttempts);
    }
    const secondAttempt = toAttempt(second);
    const {
      retryTrace: aggregatedTrace,
      totalHttpAttempts,
      costAgg,
    } = aggregateExecutionTrace(first, second);
    if (second.ok) {
      return {
        response: second.response,
        telemetry: {
          attempts: [firstAttempt, secondAttempt],
          fallbackUsed: true,
          finalProvider: second.provider,
          finalModel: second.model,
          finalStatus: "SUCCESS",
          retryTrace: aggregatedTrace,
          conversationControl:
            conversationControl ?? second.conversationControl,
          jevDecision,
          shadow: await joinShadow(shadowPromise, shadowMarker),
          totalHttpAttempts,
          totalCostUsd: costAgg.totalCostUsd,
          knownCostSubtotalUsd: costAgg.knownCostSubtotalUsd,
          costCompleteness: costAgg.costCompleteness,
          stopReason: null,
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
        retryTrace: aggregatedTrace,
        conversationControl: conversationControl ?? second.conversationControl,
        jevDecision,
        shadow: await joinShadow(shadowPromise, shadowMarker),
        totalHttpAttempts,
        totalCostUsd: costAgg.totalCostUsd,
        knownCostSubtotalUsd: costAgg.knownCostSubtotalUsd,
        costCompleteness: costAgg.costCompleteness,
        stopReason: session.getStopReason() ?? null,
      },
      lastErrorCode: second.error.code,
    };
  }

  return { callWithFallback };
}
