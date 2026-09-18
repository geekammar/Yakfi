/**
 * Conversation Control — NOTIFICATION policy (Phase 11).
 *
 * A minimal, provider-agnostic event/port seam. There is NO existing
 * notification platform in the repository, so this introduces only the
 * typed boundary: sanitized payloads + an injectable
 * {@link NotificationSink} that deduplicates. It is deliberately NOT a
 * notification platform (no queue, no worker, no Redis, no webhook).
 *
 * Sanitization contract — payloads may ONLY carry:
 *   business/conversation REFERENCE (ids) · handoff reason · provider
 *   IDENTIFIER · failure CLASS · retry COUNT · timestamp.
 * They must NEVER carry:
 *   API keys · Authorization headers · DATABASE_URL · raw model responses
 *   · raw provider response bodies · secrets · customer content.
 */
import type { AiProviderErrorCode, AiProviderId } from "../types";
import type {
  HandoffReason,
  NotificationConfig,
  NotificationEvent,
  NotificationSink,
  SanitizedNotification,
} from "./types";

/**
 * Fields the notification policy needs from a finalized turn. All
 * sanitized references / classifications / counters — never content.
 */
export type NotificationPolicyInput = {
  readonly provider: AiProviderId;
  readonly handoffReason: HandoffReason | null;
  /** Sanitized classification of the final attempt (null on success). */
  readonly failureClass: AiProviderErrorCode | null;
  readonly retryCount: number;
  readonly now: number;
  readonly businessId?: string;
  readonly conversationId?: string;
  readonly settings?: Partial<NotificationConfig>;
};

/**
 * Decide which NOTIFICATION EVENTS a finalized turn must emit, given the
 * account-level notification settings. Deterministic and total: every
 * reason maps to at most one event; safe defaults apply when settings are
 * absent.
 */
export function eventsForTurn(
  input: NotificationPolicyInput,
): NotificationEvent[] {
  const events: NotificationEvent[] = [];
  const s = input.settings;
  const reason = input.handoffReason;
  if (reason === null) return events;

  switch (reason) {
    case "CUSTOMER_REQUESTED_HUMAN":
    case "AI_REQUESTED_HANDOFF":
    case "SENSITIVE_OR_RESTRICTED_REQUEST":
    case "UNSUPPORTED_REQUEST":
      if (s?.handoff !== false) events.push("HUMAN_HANDOFF_REQUESTED");
      break;
    case "RETRY_EXHAUSTED":
      if (s?.retryExhausted !== false) events.push("AI_RETRY_EXHAUSTED");
      break;
    case "PROVIDER_UNAVAILABLE":
      if (s?.aiUnavailable !== false) events.push("AI_UNAVAILABLE");
      break;
    case "QUOTA_EXHAUSTED":
      if (s?.quotaFailure !== false) events.push("AI_QUOTA_EXHAUSTED");
      break;
    case "AUTH_OR_CONFIGURATION_FAILURE":
      if (s?.configurationFailure !== false)
        events.push("AI_CONFIGURATION_FAILURE");
      break;
    default:
      // Exhaustiveness guard: unknown reasons emit the safe handoff event.
      events.push("HUMAN_HANDOFF_REQUESTED");
      break;
  }
  return events;
}

/** Build ONE sanitized payload. Pure — no secrets can enter by construction. */
export function buildNotification(
  event: NotificationEvent,
  input: NotificationPolicyInput,
): SanitizedNotification {
  return {
    event,
    ...(input.businessId === undefined ? {} : { businessId: input.businessId }),
    ...(input.conversationId === undefined
      ? {}
      : { conversationId: input.conversationId }),
    handoffReason: input.handoffReason,
    provider: input.provider,
    failureClass: input.failureClass as SanitizedNotification["failureClass"],
    retryCount: input.retryCount,
    timestamp: input.now,
  };
}

/**
 * Deterministic dedupe key. One event per (event, conversation, turn)
 * triple — the `turnKey` is a per-logical-turn nonce supplied by the
 * control layer, so a duplicate event for the SAME turn collides and is
 * dropped, while a later genuine event for a different turn still emits.
 */
export function dedupeKey(
  notification: SanitizedNotification,
  turnKey?: string,
): string {
  return [
    notification.event,
    notification.conversationId ?? "_",
    turnKey ?? "_",
  ].join("|");
}

/**
 * Default in-memory sink: deduplicates by key within the process. Safe for
 * offline tests and for the current single-route serverless execution. A
 * durable sink (DB / webhook / inbox) is a future integration point and
 * would implement the same {@link NotificationSink} interface.
 */
export function createInMemoryNotificationSink(): NotificationSink {
  const seen = new Set<string>();
  const recordedList: SanitizedNotification[] = [];
  return {
    record(notification, turnKey) {
      // Dedupe by (event, conversation, turn): a repeated emission for the
      // SAME logical turn is dropped, while a later genuine event for a
      // different turn still emits.
      if (seen.has(dedupeKey(notification, turnKey))) return false;
      seen.add(dedupeKey(notification, turnKey));
      recordedList.push(notification);
      return true;
    },
    recorded() {
      return recordedList;
    },
  };
}

/**
 * Verify a payload leaks nothing sensitive. Used by tests and as a
 * defensive assertion before a sink records anything.
 */
export function isSanitized(payload: SanitizedNotification): boolean {
  const serialized = JSON.stringify(payload);
  return (
    !serialized.includes("Authorization") &&
    !serialized.includes("Bearer") &&
    !serialized.includes("DATABASE_URL") &&
    !serialized.includes("sk-") &&
    !serialized.includes("api_key")
  );
}
