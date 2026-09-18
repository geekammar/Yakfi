/**
 * Conversation Control — ACCOUNT-LEVEL SETTINGS seam (Phase 12).
 *
 * Defines the minimal typed configuration contract and its SAFE defaults.
 *
 * Persistence / UI status: the repository HAS an account settings surface
 * (`src/features/settings`, Business-level `businessSettingsSchema`) and a
 * platform-level `PlatformAiPolicy`, but NEITHER currently carries
 * conversation-control fields. Extending either would require a schema
 * migration + form work — out of scope here, and explicitly disallowed by
 * the session's no-migration / no-DB-write safety constraints.
 *
 * So this file provides ONLY the configuration SEAM:
 *  - the typed contract,
 *  - safe defaults (used by every caller that has no stored config),
 *  - an env override used by probes/tests (can only LOWER the bound),
 *  - a documented future admin-settings integration point.
 *
 * No settings platform is built here.
 */
import { MAX_ATTEMPTS_HARD_CEILING, clampMaxAttempts } from "./retry-policy";
import type {
  ConversationControlConfig,
  ConversationControlSettings,
  NotificationConfig,
} from "./types";

/**
 * The safe DEFAULT configuration. Retry bounded to one extra attempt,
 * every documented handoff reason enabled, every notification enabled.
 * This is what a caller with no stored config receives.
 */
export const DEFAULT_CONVERSATION_CONTROL_SETTINGS: ConversationControlSettings =
  {
    conversationControl: {
      enabled: true,
      retryEnabled: true,
      maxAttempts: MAX_ATTEMPTS_HARD_CEILING,
      handoffOnRetryExhausted: true,
      handoffOnProviderUnavailable: true,
      handoffOnAiRequested: true,
      handoffOnCustomerRequest: true,
    },
    notifications: {
      handoff: true,
      aiUnavailable: true,
      retryExhausted: true,
      configurationFailure: true,
      quotaFailure: true,
    },
  };

/**
 * Resolve effective settings over the safe defaults. Any unknown / partial
 * stored configuration is merged so a missing key can NEVER weaken the
 * safe defaults — only an explicit `false` disables a behaviour.
 */
export function resolveSettings(
  stored?: {
    conversationControl?: Partial<ConversationControlConfig>;
    notifications?: Partial<NotificationConfig>;
  },
  getEnvVar?: (name: string) => string | undefined,
): ConversationControlSettings {
  const base = DEFAULT_CONVERSATION_CONTROL_SETTINGS;
  const storedCc: Partial<ConversationControlConfig> =
    stored?.conversationControl ?? {};
  const storedN: Partial<NotificationConfig> = stored?.notifications ?? {};

  const conversationControl: ConversationControlConfig = {
    enabled: storedCc.enabled ?? base.conversationControl.enabled,
    retryEnabled:
      storedCc.retryEnabled ?? base.conversationControl.retryEnabled,
    // The bound is ALWAYS clamped to the hard ceiling, then merged.
    maxAttempts: clampMaxAttempts(
      storedCc.maxAttempts ?? readEnvMaxAttempts(getEnvVar),
    ),
    handoffOnRetryExhausted:
      storedCc.handoffOnRetryExhausted ??
      base.conversationControl.handoffOnRetryExhausted,
    handoffOnProviderUnavailable:
      storedCc.handoffOnProviderUnavailable ??
      base.conversationControl.handoffOnProviderUnavailable,
    handoffOnAiRequested:
      storedCc.handoffOnAiRequested ??
      base.conversationControl.handoffOnAiRequested,
    handoffOnCustomerRequest:
      storedCc.handoffOnCustomerRequest ??
      base.conversationControl.handoffOnCustomerRequest,
  };

  const notifications: NotificationConfig = {
    handoff: storedN.handoff ?? base.notifications.handoff,
    aiUnavailable: storedN.aiUnavailable ?? base.notifications.aiUnavailable,
    retryExhausted: storedN.retryExhausted ?? base.notifications.retryExhausted,
    configurationFailure:
      storedN.configurationFailure ?? base.notifications.configurationFailure,
    quotaFailure: storedN.quotaFailure ?? base.notifications.quotaFailure,
  };

  return { conversationControl, notifications };
}

/**
 * Env override, used only by controlled probes/tests. As with the previous
 * Atria-specific knob, the env can DISABLE the retry (`1`) but can NEVER
 * raise the ceiling above {@link MAX_ATTEMPTS_HARD_CEILING}.
 */
function readEnvMaxAttempts(
  getEnvVar?: (name: string) => string | undefined,
): number | undefined {
  if (!getEnvVar) return undefined;
  const raw = getEnvVar("CONVERSATION_CONTROL_MAX_ATTEMPTS");
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : undefined;
}

/*
 * ── FUTURE ADMIN-SETTINGS INTEGRATION POINT ──────────────────────────────
 * To make this configurable per account/business in production:
 *   1. Add a nullable JSON/JSONB column (e.g. `conversation_control_settings`)
 *      to the Business settings surface — one migration, no engine change.
 *   2. Extend `businessSettingsSchema` with an OPTIONAL nested Zod object
 *      mirroring `ConversationControlSettings` (unknown keys stripped).
 *   3. Read it where the factory already resolves business context and
 *      pass it here as `stored`.
 * The control layer, retry policy, handoff policy and notification policy
 * require NO change — they already consume this seam.
 */
