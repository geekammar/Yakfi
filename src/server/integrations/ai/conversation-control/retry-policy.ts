/**
 * Conversation Control — bounded RETRY policy (Phases 3–4).
 *
 * Provider-agnostic by construction: it consumes ONLY the sanitized
 * {@link AiProviderErrorCode} taxonomy that every adapter already emits.
 * It never inspects raw provider JSON, never branches on a provider id,
 * and never calls an adapter.
 *
 * Contract:
 *   attempt fails
 *     ↓ classify (adapter-owned) → errorCode
 *     ↓ decideRetry (this file) → NO_RETRY | RETRY | EXHAUSTED
 *   NO_RETRY   → stop immediately (non-retryable class, or config)
 *   RETRY      → start exactly ONE more bounded attempt
 *   EXHAUSTED  → budget/attempts spent → handoff policy decides
 *
 * Only `TIMEOUT` is retryable today — the single class the previous
 * Atria-specific experiment proved recoverable. Every other code stays
 * non-retryable unless repository evidence re-classifies it.
 */
import type { AiProviderErrorCode } from "../types";
import type {
  RetryDecision,
  RetryDecisionReason,
  RetryPolicyInput,
} from "./types";

/**
 * Hard safety ceiling on physical provider attempts for ONE logical
 * customer turn. No configuration, environment variable, or account
 * setting can EVER raise this — mirrors the previous
 * `ATRIA_MAX_ATTEMPTS = 2` bound, now generalized.
 */
export const MAX_ATTEMPTS_HARD_CEILING = 2;

/**
 * Default configured attempts (= one initial attempt + one retry).
 * Matches the deployed bounded-retry behaviour exactly.
 */
export const DEFAULT_MAX_ATTEMPTS = 2;

/**
 * The retryable set — a STRICT, evidence-based subset of the provider
 * error taxonomy. `RETRYABLE` (generic network / 5xx / 429) is
 * deliberately EXCLUDED here: those classes already drive the
 * orchestrator's primary→secondary fallback, and the previous experiment
 * only ever retried `TIMEOUT`. Adding a class requires repository
 * evidence, never speculation.
 */
const RETRYABLE_CLASSES: ReadonlySet<AiProviderErrorCode> = new Set([
  "TIMEOUT",
]);

/**
 * Non-retryable classes — listed explicitly so the intent is auditable.
 * AUTH_FAILURE / PROVIDER_HTTP_ERROR / INVALID_RESPONSE / configuration
 * and credential errors NEVER earn a retry: a second identical request
 * cannot fix them, and retrying a 401 would only burn budget.
 */
const NON_RETRYABLE_CLASSES: ReadonlySet<AiProviderErrorCode> = new Set([
  "PERMANENT",
  "INVALID_RESPONSE",
  "CONFIG_ERROR",
  "CONTROLLED_FAILURE",
]);

/** True iff a failure class is part of the retryable set. */
export function isRetryableClass(
  code: AiProviderErrorCode | undefined,
): boolean {
  return code !== undefined && RETRYABLE_CLASSES.has(code);
}

/** True iff a failure class is explicitly non-retryable. */
export function isNonRetryableClass(
  code: AiProviderErrorCode | undefined,
): boolean {
  return code !== undefined && NON_RETRYABLE_CLASSES.has(code);
}

/**
 * Clamp a requested attempt count to the hard ceiling. A caller can LOWER
 * the count (down to 1 = retry disabled) but can NEVER escalate it.
 */
export function clampMaxAttempts(requested: number | undefined): number {
  if (requested === undefined || !Number.isInteger(requested)) {
    return DEFAULT_MAX_ATTEMPTS;
  }
  return Math.min(MAX_ATTEMPTS_HARD_CEILING, Math.max(1, requested));
}

/**
 * The deterministic retry verdict. Pure: same inputs → same output, no
 * side effects, no recursion, no unbounded loop possible downstream
 * (callers consume the verdict to perform at most one extra attempt).
 */
export function decideRetry(input: RetryPolicyInput): {
  decision: RetryDecision;
  reason: RetryDecisionReason;
} {
  // Success never earns a retry (this branch is defensive; the loop only
  // asks after a failure).
  if (input.errorCode === undefined) {
    return { decision: "NO_RETRY", reason: "SUCCESS" };
  }
  // Configuration disabled the retry entirely.
  if (!input.retryEnabled || input.maxAttempts <= 1) {
    return { decision: "NO_RETRY", reason: "RETRY_DISABLED" };
  }
  // The customer asked for a human — never buy more time for the AI.
  if (input.explicitHumanRequest) {
    return { decision: "NO_RETRY", reason: "HUMAN_REQUEST" };
  }
  // Only the evidence-based retryable class earns another attempt.
  if (!isRetryableClass(input.errorCode)) {
    return { decision: "NO_RETRY", reason: "NON_RETRYABLE_CLASSIFICATION" };
  }
  // The budget for retries is already spent.
  if (input.attempt >= input.maxAttempts) {
    return { decision: "EXHAUSTED", reason: "MAX_ATTEMPTS_REACHED" };
  }
  // Remaining-deadline guard: never start an attempt the route budget
  // cannot host. When the caller cannot supply a budget, preserve the
  // existing behaviour (only require that some time remains).
  if (input.remainingBudgetMs !== null) {
    const needs = input.attemptTimeoutMs !== null ? input.attemptTimeoutMs : 1;
    if (input.remainingBudgetMs < needs) {
      return { decision: "EXHAUSTED", reason: "INSUFFICIENT_BUDGET" };
    }
  }
  // Retryable class + attempts remaining + budget available → one more.
  return { decision: "RETRY", reason: "SUCCESS" };
}
