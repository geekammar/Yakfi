/**
 * Conversation Control Layer — public surface
 * (PROMPT-OPS-CONVERSATION-CONTROL-RETRY-HANDOFF-15).
 *
 * Provider-agnostic policy layer: bounded RETRY + HUMAN HANDOFF +
 * NOTIFICATIONS over any single {@link AiProviderAdapter}.
 *
 * Boundary contract:
 *   import { createConversationControl } from
 *     "@/server/integrations/ai/conversation-control";
 *
 * This module NEVER imports a concrete provider adapter (atria /
 * openrouter / agentrouter). It consumes only the provider INTERFACE and
 * the shared error taxonomy. Adding a provider changes nothing here.
 */
export { createConversationControl } from "./conversation-control";
export type { ConversationControl } from "./conversation-control";

// Retry policy (Phase 3–4)
export {
  clampMaxAttempts,
  decideRetry,
  DEFAULT_MAX_ATTEMPTS,
  isNonRetryableClass,
  isRetryableClass,
  MAX_ATTEMPTS_HARD_CEILING,
} from "./retry-policy";

// Handoff policy (Phases 7–10)
export {
  failureCodeToHandoffReason,
  fromContractHandoffReason,
  handoffFromAiResponse,
  handoffMessageFor,
  handoffReasonForFailure,
  HANDOFF_MESSAGES,
  refineRetryableFailure,
} from "./handoff-policy";

// Notification policy (Phase 11)
export {
  buildNotification,
  createInMemoryNotificationSink,
  dedupeKey,
  eventsForTurn,
  isSanitized,
} from "./notification-policy";

// Account settings seam (Phase 12)
export {
  DEFAULT_CONVERSATION_CONTROL_SETTINGS,
  resolveSettings,
} from "./settings";

// Type surface
export type {
  ConversationControlConfig,
  ConversationControlDeps,
  ConversationControlOutcome,
  ConversationControlSettings,
  HandoffReason,
  NotificationConfig,
  NotificationEvent,
  NotificationSink,
  RetryDecision,
  RetryDecisionReason,
  RetryPolicyInput,
  SanitizedNotification,
} from "./types";
