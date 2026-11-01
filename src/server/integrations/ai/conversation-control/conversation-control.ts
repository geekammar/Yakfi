/**
 * Conversation Control — the core layer
 * (PROMPT-OPS-CONVERSATION-CONTROL-RETRY-HANDOFF-15, Phases 2/5/6/8/13).
 *
 * One logical customer turn, expressed as a provider-agnostic state
 * machine over a single {@link AiProviderAdapter}:
 *
 *     executeTurn(request)
 *       ↓ already in human handoff? ──yes──▶ no AI execution (deduped)
 *       ↓ explicit human request?  ──yes──▶ retry BYPASSED
 *       ↓ provider attempt #1 (ONE adapter call)
 *       ↓ retry policy: NO_RETRY | RETRY | EXHAUSTED
 *       ↓ RETRY (+ budget) ────────────────▶ provider attempt #2
 *       ↓ final AiProviderResult
 *       ↓ handoff policy → handoffReason | null
 *       ↓ notification policy → deduped sanitized events
 *       → ONE outcome (one result, one decision, one message seam)
 *
 * Invariants this file guarantees:
 *  - ONE logical turn → ONE final {@link AiProviderResult}. Persistence,
 *    delivery and the state transition happen only AFTER this returns, so
 *    no duplicate AI messages, OUTBOUND_MESSAGE rows, Meta sends, or
 *    conversation state transitions can occur (Phase 5).
 *  - Retry is bounded by a hard ceiling; no recursion, no unbounded loop.
 *  - The layer depends only on the provider INTERFACE — it never imports
 *    an adapter module, never inspects raw provider JSON, never branches
 *    on a provider id (Phase 14).
 *  - Normalization stays inside the provider boundary: this layer only
 *    reads the already-structured {@link AiProviderResult} (Phase 15).
 *  - No DB writes, no transport calls, no queues.
 */
import type { AiRequest } from "@/features/conversations/server/ai-contract";

import { computeCostAggregation } from "../http";
import type {
  AiCallOptions,
  AiProviderAdapter,
  AiProviderErrorCode,
  AiProviderResult,
  AiRetryAttemptRecord,
  AiRetrySkipReason,
  AiRetryTrace,
} from "../types";
import {
  failureCodeToHandoffReason,
  handoffFromAiResponse,
  handoffMessageFor,
  refineRetryableFailure,
} from "./handoff-policy";
import {
  buildNotification,
  createInMemoryNotificationSink,
  eventsForTurn,
} from "./notification-policy";
import { clampMaxAttempts, decideRetry } from "./retry-policy";
import { resolveSettings } from "./settings";
import type {
  ConversationControlDeps,
  ConversationControlOutcome,
  HandoffReason,
  NotificationSink,
} from "./types";

/**
 * The platform route budget default, used ONLY when the caller cannot
 * supply a deadline. Preserves the previous application behaviour
 * (300s fluid-compute budget) without introducing a new global timeout
 * system. This is a platform constant, not a provider one.
 */
const DEFAULT_ROUTE_BUDGET_MS = 300_000;
/** Reserved for persistence, the Meta send, and teardown. */
const ROUTE_BUDGET_SAFETY_MARGIN_MS = 20_000;

/**
 * Default deterministic human-request detector: returns false.
 * Provider retry decisions and failure classification have zero lexical authority
 * over customer prose. Retry policy is strictly governed by technical error
 * classification and bounded retry limits.
 */
function defaultIsHumanRequest(_request: AiRequest): boolean {
  return false;
}

export type ConversationControl = AiProviderAdapter & {
  /** The full policy outcome for one logical turn. */
  executeTurn(
    request: AiRequest,
    options?: AiCallOptions,
  ): Promise<ConversationControlOutcome>;
  /** The notification sink in use (telemetry / tests). */
  getNotificationSink(): NotificationSink;
  /** Configured max attempts for this control layer. */
  readonly maxAttempts: number;
};

export function createConversationControl(
  deps: ConversationControlDeps,
): ConversationControl {
  const provider = deps.provider;
  const getNow = deps.getNow ?? Date.now;
  const isHumanRequest = deps.isHumanRequest ?? defaultIsHumanRequest;
  const sink = deps.notificationSink ?? createInMemoryNotificationSink();
  const settings = resolveSettings(deps.settings);
  const config = settings.conversationControl;

  // Per-turn unique key so duplicate events for the SAME turn collide.
  let turnCounter = 0;

  /**
   * The deterministic retry loop. Bounded countdown: the loop body runs at
   * most `maxAttempts` times, and only a RETRY verdict advances it.
   */
  async function runAttempts(
    request: AiRequest,
    options?: AiCallOptions,
  ): Promise<{
    result: AiProviderResult;
    trace: AiRetryTrace;
    skipped: AiRetrySkipReason;
    retriesStarted: number;
  }> {
    const started = getNow();
    const deadline =
      options?.session?.deadlineMs ??
      deps.deadlineMs ??
      (options?.timeoutMs !== undefined
        ? getNow() + options.timeoutMs
        : getNow() + DEFAULT_ROUTE_BUDGET_MS - ROUTE_BUDGET_SAFETY_MARGIN_MS);
    const attemptTimeoutMs = deps.attemptTimeoutMs ?? null;
    const maxAttempts = config.enabled
      ? clampMaxAttempts(config.maxAttempts)
      : 1;

    const attemptRecords: AiRetryAttemptRecord[] = [];
    let triggerCode: AiProviderErrorCode | null = null;
    let skipReason: AiRetrySkipReason = "NONE";
    let retryTimeoutUsed = attemptTimeoutMs ?? 0;
    let last: AiProviderResult | null = null;
    let retriesStarted = 0;

    // Hard-bounded countdown. `remaining` only decreases; no recursion.
    for (let remaining = maxAttempts; remaining > 0; remaining -= 1) {
      const attemptNumber = maxAttempts - remaining + 1;

      // Check session allowance and stop condition before dispatch (CORE-04B)
      if (options?.session) {
        const check = options.session.canDispatch();
        if (!check.allowed) {
          skipReason =
            check.reason === "ATTEMPT_LIMIT_EXHAUSTED"
              ? "MAX_ATTEMPTS_REACHED"
              : check.reason === "DEADLINE_EXHAUSTED"
                ? "INSUFFICIENT_DEADLINE"
                : (check.reason as AiRetrySkipReason);
          break;
        }
      }

      const remainingBudgetMs = deadline - getNow();
      if (attemptNumber > 1 && remainingBudgetMs <= 0) {
        skipReason = "INSUFFICIENT_DEADLINE";
        break;
      }

      const attemptTimeout =
        attemptTimeoutMs !== null
          ? Math.min(attemptTimeoutMs, remainingBudgetMs)
          : remainingBudgetMs;

      // ── ONE adapter invocation = ONE provider attempt.
      const result = await provider.call(request, {
        ...options,
        timeoutMs: attemptTimeout,
      });
      last = result;
      const rawStatus = result.ok ? undefined : result.error.httpStatus;
      const validStatus =
        typeof rawStatus === "number" &&
        Number.isInteger(rawStatus) &&
        rawStatus >= 300 &&
        rawStatus <= 599
          ? rawStatus
          : undefined;

      attemptRecords.push({
        attempt: attemptNumber,
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
      });

      if (result.ok) break;

      // Ask the RETRY POLICY (never the adapter) what to do next.
      // Provider retry decisions are based strictly on technical failure classification
      // and bounded retry policy, not customer-message wording.
      const remainingAfterAttemptMs = deadline - getNow();
      const verdict = decideRetry({
        attempt: attemptNumber,
        errorCode: result.error.code,
        maxAttempts,
        retryEnabled: config.retryEnabled,
        remainingBudgetMs: remainingAfterAttemptMs,
        attemptTimeoutMs: options?.session ? null : attemptTimeoutMs,
        explicitHumanRequest: false,
      });

      if (verdict.decision === "NO_RETRY") {
        skipReason =
          verdict.reason === "HUMAN_REQUEST"
            ? "HUMAN_REQUEST"
            : verdict.reason === "RETRY_DISABLED"
              ? "DISABLED"
              : "NON_RETRYABLE_CLASSIFICATION";
        break;
      }
      if (verdict.decision === "EXHAUSTED") {
        skipReason =
          verdict.reason === "INSUFFICIENT_BUDGET"
            ? "INSUFFICIENT_DEADLINE"
            : "MAX_ATTEMPTS_REACHED";
        break;
      }

      // decision === "RETRY": record the trigger and loop once more.
      triggerCode = result.error.code;
      retriesStarted += 1;
      retryTimeoutUsed =
        attemptTimeoutMs === null
          ? (attemptTimeoutMs ?? 0)
          : Math.min(attemptTimeoutMs, Math.max(0, remainingAfterAttemptMs));
    }

    if (last === null) {
      const idle = idleFailure(provider.providerId, provider.model);
      const idleTrace: AiRetryTrace = {
        provider: provider.providerId,
        maxAttempts,
        attempts: [],
        retryAttempted: false,
        retryTriggerCode: null,
        retrySkippedReason: skipReason,
        deadlineMs: deadline,
        retryTimeoutMs: 0,
        finalOutcome: "FAILURE",
        totalElapsedMs: getNow() - started,
        totalHttpAttempts: 0,
        totalCostUsd: null,
        knownCostSubtotalUsd: null,
        costCompleteness: "UNAVAILABLE",
        stopReason:
          options?.session?.getStopReason() ??
          (skipReason === "INSUFFICIENT_DEADLINE"
            ? "DEADLINE_EXHAUSTED"
            : skipReason === "MAX_ATTEMPTS_REACHED"
              ? "ATTEMPT_LIMIT_EXHAUSTED"
              : null),
      };
      return {
        result: idle,
        trace: idleTrace,
        skipped: skipReason,
        retriesStarted: 0,
      };
    }

    const allKnown = attemptRecords.every(
      (a) => a.httpAttempts !== undefined && a.httpAttempts !== null,
    );
    const totalHttpAttempts = allKnown
      ? attemptRecords.reduce((acc, a) => acc + (a.httpAttempts ?? 0), 0)
      : undefined;
    const costAgg = computeCostAggregation(attemptRecords);

    const trace: AiRetryTrace = {
      provider: provider.providerId,
      maxAttempts,
      attempts: attemptRecords,
      retryAttempted: attemptRecords.length > 1,
      retryTriggerCode: triggerCode,
      retrySkippedReason: skipReason,
      deadlineMs: deadline,
      retryTimeoutMs: retryTimeoutUsed,
      finalOutcome: last.ok ? "SUCCESS" : "FAILURE",
      totalElapsedMs: getNow() - started,
      totalHttpAttempts,
      totalCostUsd: costAgg.totalCostUsd,
      knownCostSubtotalUsd: costAgg.knownCostSubtotalUsd,
      costCompleteness: costAgg.costCompleteness,
      stopReason:
        options?.session?.getStopReason() ??
        (skipReason === "INSUFFICIENT_DEADLINE"
          ? "DEADLINE_EXHAUSTED"
          : skipReason === "MAX_ATTEMPTS_REACHED" &&
              attemptRecords.length >= maxAttempts
            ? "ATTEMPT_LIMIT_EXHAUSTED"
            : null),
    };

    return { result: last, trace, skipped: skipReason, retriesStarted };
  }

  async function executeTurn(
    request: AiRequest,
    options?: AiCallOptions,
  ): Promise<ConversationControlOutcome> {
    const now = getNow();
    const turnKey = `t${(turnCounter += 1)}`;

    // ── Phase 13 / A12: already in a human-handoff state → NO AI
    // execution. The engine guards this too; this is the defensive,
    // provider-agnostic authority. No provider call, no new customer
    // handoff message, no duplicate notification.
    const alreadyInHandoff = request.conversationStatus === "NEED_HUMAN";
    if (alreadyInHandoff || !config.enabled) {
      const reason: HandoffReason | null = alreadyInHandoff
        ? "CUSTOMER_REQUESTED_HUMAN"
        : null;
      const idleTrace: AiRetryTrace = {
        provider: provider.providerId,
        maxAttempts: 0,
        attempts: [],
        retryAttempted: false,
        retryTriggerCode: null,
        // Already in handoff: nothing was skipped, nothing was attempted.
        retrySkippedReason: alreadyInHandoff ? "NONE" : "DISABLED",
        deadlineMs: deps.deadlineMs ?? now,
        retryTimeoutMs: 0,
        finalOutcome: "FAILURE",
        totalElapsedMs: 0,
        totalCostUsd: null,
        knownCostSubtotalUsd: null,
        costCompleteness: "UNAVAILABLE",
      };
      return {
        result: {
          ...idleFailure(provider.providerId, provider.model),
          retryTrace: idleTrace,
        },
        retryTrace: idleTrace,
        handoffReason: reason,
        // Suppressed: the customer already received their handoff message.
        handoffMessage: null,
        notifications: [],
        alreadyInHandoff,
        retrySkippedReason: alreadyInHandoff ? "NONE" : "DISABLED",
      };
    }

    // ── Phase 6: deterministic explicit human request → retry bypassed.
    const explicitHuman = isHumanRequest(request);

    const { result, trace, skipped, retriesStarted } = await runAttempts(
      request,
      options,
    );

    // ── Phases 7–9: the handoff DECISION (the engine executes it).
    let handoffReason: HandoffReason | null;
    if (result.ok) {
      handoffReason = handoffFromAiResponse(result.response);
      // A customer who explicitly asked for a human and got an AI handoff
      // is recorded as the customer's own request.
      if (explicitHuman && handoffReason === "AI_REQUESTED_HANDOFF") {
        handoffReason = "CUSTOMER_REQUESTED_HUMAN";
      }
    } else {
      // Phase 9: map the final failure classification onto a handoff
      // reason. When no validated semantic decision exists, do not assert
      // that the customer explicitly requested a human. `failureCodeToHandoffReason`
      // is total (never null), so a TIMEOUT that reached here already exhausted its retries.
      handoffReason = refineRetryableFailure(
        failureCodeToHandoffReason(result.error.code),
        result.error.httpStatus,
      );
    }

    // Apply the account-level handoff toggles (safe defaults all ON).
    handoffReason = applyHandoffToggles(handoffReason, config);
    const handoffMessage =
      handoffReason === null ? null : handoffMessageFor(handoffReason);

    // ── Phase 11: sanitized, deduplicated notifications.
    const failureClass: AiProviderErrorCode | null = result.ok
      ? null
      : result.error.code;
    const events = eventsForTurn({
      provider: provider.providerId,
      handoffReason,
      failureClass,
      retryCount: retriesStarted,
      now,
      settings: settings.notifications,
    });
    const notifications = events.map((event) => {
      const payload = buildNotification(event, {
        provider: provider.providerId,
        handoffReason,
        failureClass,
        retryCount: retriesStarted,
        now,
        settings: settings.notifications,
      });
      // The sink deduplicates by (event, conversation, turn); a repeated
      // emission for the same turn is a no-op (Phase 11 / A16).
      sink.record(payload, turnKey);
      return payload;
    });

    // The final result carries the sanitized trace exactly once, so any
    // consumer of `result` (orchestrator / engine) observes ONE logical
    // turn. `call()` additionally attaches this outcome; kept separate to
    // avoid a circular reference in the plain result.
    const finalResult: AiProviderResult = {
      ...result,
      retryTrace: trace,
      ...(trace.totalHttpAttempts !== undefined
        ? { httpAttempts: trace.totalHttpAttempts }
        : {}),
    };

    return {
      result: finalResult,
      retryTrace: trace,
      handoffReason,
      handoffMessage,
      notifications,
      alreadyInHandoff: false,
      retrySkippedReason: skipped,
    };
  }

  return {
    providerId: provider.providerId,
    model: provider.model,
    secretRef: provider.secretRef,
    /**
     * AiProviderAdapter surface: returns exactly ONE final result per
     * logical turn, so the orchestrator and engine are byte-for-byte
     * compatible with the previous (adapter-internal) retry — but the
     * policy now lives here. The sanitized trace and the control outcome
     * ride on the result exactly once (never per attempt).
     */
    async call(
      request: AiRequest,
      options?: AiCallOptions,
    ): Promise<AiProviderResult> {
      const outcome = await executeTurn(request, options);
      return {
        ...outcome.result,
        retryTrace: outcome.retryTrace,
        conversationControl: outcome,
      };
    },
    executeTurn,
    maxAttempts: config.enabled ? clampMaxAttempts(config.maxAttempts) : 1,
    getNotificationSink() {
      return sink;
    },
  };
}

/** Handoff toggles from the account-level config (Phase 12). */
function applyHandoffToggles(
  reason: HandoffReason | null,
  config: {
    handoffOnCustomerRequest: boolean;
    handoffOnAiRequested: boolean;
    handoffOnRetryExhausted: boolean;
    handoffOnProviderUnavailable: boolean;
  },
): HandoffReason | null {
  if (reason === null) return null;
  switch (reason) {
    case "CUSTOMER_REQUESTED_HUMAN":
      return config.handoffOnCustomerRequest ? reason : null;
    case "AI_REQUESTED_HANDOFF":
      return config.handoffOnAiRequested ? reason : null;
    case "RETRY_EXHAUSTED":
      return config.handoffOnRetryExhausted ? reason : null;
    case "PROVIDER_UNAVAILABLE":
    case "QUOTA_EXHAUSTED":
    case "AUTH_OR_CONFIGURATION_FAILURE":
      return config.handoffOnProviderUnavailable ? reason : null;
    default:
      return reason;
  }
}

/** A minimal failure result used when no provider attempt is executed. */
function idleFailure(
  providerId: AiProviderResult["provider"],
  model: string,
): AiProviderResult {
  return {
    ok: false,
    provider: providerId,
    model,
    latencyMs: 0,
    error: {
      code: "CONTROLLED_FAILURE",
      message: "conversation control did not execute a provider attempt",
      retryable: false,
    },
  };
}
