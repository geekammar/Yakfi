/**
 * Conversation Control Layer — type surface
 * (PROMPT-OPS-CONVERSATION-CONTROL-RETRY-HANDOFF-15).
 *
 * A provider-AGNOSTIC policy layer that sits ABOVE a single
 * {@link AiProviderAdapter} and BELOW the fallback orchestrator /
 * conversation engine:
 *
 *   engine → ConversationAi → orchestrator → CONVERSATION CONTROL
 *                                                ↓ retry / handoff / notify
 *                                             ONE AiProviderAdapter
 *                                                ↓ exactly ONE provider call
 *                                             AiProviderResult
 *
 * Hard boundary rules enforced by this module:
 *  - Conversation Control depends ONLY on the {@link AiProviderAdapter}
 *    interface. It NEVER imports `atria.ts` / `openrouter.ts` /
 *    `agentrouter.ts`, never inspects raw provider JSON, and never
 *    branches on a provider id.
 *  - ONE adapter invocation = ONE provider attempt. Retry, handoff and
 *    notification decisions live HERE, never in an adapter.
 *  - ONE logical customer turn → ONE final {@link AiProviderResult} →
 *    ONE engine outcome. Persistence / delivery / handoff run only AFTER
 *    this layer returns.
 *  - No DB writes, no transport calls, no background jobs. This layer is
 *    a pure policy decider; the engine remains the executor.
 */
import type { AiRequest } from "@/features/conversations/server/ai-contract";

import type {
  AiProviderAdapter,
  AiProviderErrorCode,
  AiProviderId,
  AiProviderResult,
  AiRetrySkipReason,
  AiRetryTrace,
} from "../types";

// ─── Handoff reason taxonomy (Phase 9) ───────────────────────────────────────
/**
 * Minimal, evidence-based set of reasons a conversation leaves the AI
 * thread. Deliberately small — no speculative taxonomy. Each maps to an
 * existing provider error classification or a deterministic customer/AI
 * signal.
 */
export type HandoffReason =
  /** The customer explicitly asked for a human (deterministic match). */
  | "CUSTOMER_REQUESTED_HUMAN"
  /** The AI's own structured response carried a supported handoff action. */
  | "AI_REQUESTED_HANDOFF"
  /** Every bounded provider attempt failed with a retryable class. */
  | "RETRY_EXHAUSTED"
  /** Provider unreachable / network class failure after the final attempt. */
  | "PROVIDER_UNAVAILABLE"
  /** Provider signalled a quota / rate-limit exhaustion. */
  | "QUOTA_EXHAUSTED"
  /** Missing/invalid credentials or configuration (never retried). */
  | "AUTH_OR_CONFIGURATION_FAILURE"
  /** The provider answered in a shape the contract rejects. */
  | "UNSUPPORTED_REQUEST"
  /** Deterministic detection of a sensitive / restricted topic. */
  | "SENSITIVE_OR_RESTRICTED_REQUEST";

// ─── Retry decision (Phase 3) ────────────────────────────────────────────────
/**
 * The deterministic verdict of the retry policy for one attempt. The
 * provider adapter never computes this — it only classifies the attempt.
 */
export type RetryDecision = "NO_RETRY" | "RETRY" | "EXHAUSTED";

/** Inputs the retry policy needs — all provider-neutral. */
export type RetryPolicyInput = {
  /** 1-based index of the attempt that just completed. */
  attempt: number;
  /** Sanitized classification of the attempt's result. */
  errorCode: AiProviderErrorCode | undefined;
  /** Effective configured ceiling on physical attempts. */
  maxAttempts: number;
  /** True iff this configuration allows any retry at all. */
  retryEnabled: boolean;
  /**
   * Wall-clock ms still available in the route budget, or `null` when the
   * caller cannot supply a budget. `null` preserves the pre-existing
   * application behaviour rather than inventing a new global timeout.
   */
  remainingBudgetMs: number | null;
  /**
   * Expected duration of ONE provider attempt, when the caller knows it.
   * Used only to decide whether the budget can host another attempt.
   */
  attemptTimeoutMs: number | null;
  /** True iff the customer's message is an explicit human request (optional; defaults to false). */
  explicitHumanRequest?: boolean;
};

/** Why the retry policy returned its verdict (telemetry only). */
export type RetryDecisionReason =
  | "SUCCESS"
  | "NON_RETRYABLE_CLASSIFICATION"
  | "RETRY_DISABLED"
  | "MAX_ATTEMPTS_REACHED"
  | "INSUFFICIENT_BUDGET"
  | "HUMAN_REQUEST";

// ─── Notification events (Phase 11) ──────────────────────────────────────────
export type NotificationEvent =
  | "HUMAN_HANDOFF_REQUESTED"
  | "AI_UNAVAILABLE"
  | "AI_RETRY_EXHAUSTED"
  | "AI_QUOTA_EXHAUSTED"
  | "AI_CONFIGURATION_FAILURE";

/**
 * A SANITIZED notification payload. Only references, classifications,
 * counters and timestamps — NEVER keys, headers, `DATABASE_URL`, raw
 * model responses, raw provider bodies, or customer content.
 */
export type SanitizedNotification = {
  readonly event: NotificationEvent;
  /** Business / conversation REFERENCE (ids only), when the caller has one. */
  readonly businessId?: string;
  readonly conversationId?: string;
  readonly handoffReason: HandoffReason | null;
  /** Provider identifier (enum name) — never a secret or endpoint. */
  readonly provider: AiProviderId;
  /** Sanitized failure class of the final attempt, if any. */
  readonly failureClass: AiProviderErrorCode | null;
  /** Number of retries actually started (0 = none). */
  readonly retryCount: number;
  /** Epoch ms. */
  readonly timestamp: number;
};

/**
 * Minimal typed notification PORT. The production sink is a future
 * integration point (admin settings / webhook / inbox); the default
 * in-memory implementation deduplicates and records events for tests.
 * Implementations must be side-effect-free with respect to the turn —
 * a sinking failure must never change the conversation outcome.
 */
export interface NotificationSink {
  /**
   * Record one sanitized notification. Returns true iff the event was
   * newly recorded (false = suppressed as a duplicate). The optional
   * `turnKey` scopes dedupe to one logical customer turn. A sinking
   * failure must never change the conversation outcome.
   */
  record(notification: SanitizedNotification, turnKey?: string): boolean;
  /** Snapshot of everything recorded so far (telemetry / tests). */
  recorded(): readonly SanitizedNotification[];
}

// ─── Account-level configuration seam (Phase 12) ─────────────────────────────
export type ConversationControlConfig = {
  enabled: boolean;
  retryEnabled: boolean;
  maxAttempts: number;
  handoffOnRetryExhausted: boolean;
  handoffOnProviderUnavailable: boolean;
  handoffOnAiRequested: boolean;
  handoffOnCustomerRequest: boolean;
};

export type NotificationConfig = {
  handoff: boolean;
  aiUnavailable: boolean;
  retryExhausted: boolean;
  configurationFailure: boolean;
  quotaFailure: boolean;
};

/** The full account-level policy surface; defaults are always safe. */
export type ConversationControlSettings = {
  conversationControl: ConversationControlConfig;
  notifications: NotificationConfig;
};

// ─── Turn inputs / outcome (Phases 2, 5, 13) ─────────────────────────────────
/** Injected dependencies — every one provider-neutral and side-effect-free. */
export type ConversationControlDeps = {
  /** The ONE adapter this layer retries / hands off around. */
  provider: AiProviderAdapter;
  /**
   * Effective account-level settings (safe defaults merged over any
   * partial stored configuration).
   */
  settings?: {
    conversationControl?: Partial<ConversationControlConfig>;
    notifications?: Partial<NotificationConfig>;
  };
  /**
   * Optional absolute epoch-ms deadline for the whole logical turn.
   * The caller may pass the route's remaining budget. When omitted, the
   * layer derives the same default route budget the previous adapter-level
   * implementation used — no new global timeout system is introduced.
   */
  deadlineMs?: number;
  /** Expected duration of one provider attempt, when the caller knows it. */
  attemptTimeoutMs?: number;
  /** Test seam; defaults to `Date.now`. */
  getNow?: () => number;
  /** Optional sink; a fresh in-memory dedup sink is used otherwise. */
  notificationSink?: NotificationSink;
  /**
   * Optional deterministic human-request classifier. Defaults to false —
   * provider retry and failure handling have zero lexical authority over customer prose.
   */
  isHumanRequest?: (request: AiRequest) => boolean;
};

/**
 * The outcome of ONE logical customer turn. Carries the single final
 * provider result plus the policy decisions the engine may consume.
 * The engine stays the executor of state transitions; this layer is
 * authoritative for the DECISION.
 */
export type ConversationControlOutcome = {
  /** The single final provider result (success or failure). */
  readonly result: AiProviderResult;
  /** Sanitized bounded-retry trace (now owned here, not the adapter). */
  readonly retryTrace: AiRetryTrace;
  /** Non-null iff the turn resolves to a human handoff. */
  readonly handoffReason: HandoffReason | null;
  /** Canonical customer-facing handoff message, or null when none applies. */
  readonly handoffMessage: string | null;
  /** Notifications emitted for this turn (already deduplicated). */
  readonly notifications: readonly SanitizedNotification[];
  /** True when the turn was already in a human-handoff state (suppressed). */
  readonly alreadyInHandoff: boolean;
  /** Skip reason surfaced for the retry, for telemetry parity. */
  readonly retrySkippedReason: AiRetrySkipReason;
};
