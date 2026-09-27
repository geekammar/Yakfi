/**
 * Telegram connection feature types (DECISIONS #66 — slice TELEGRAM 03).
 *
 * The customer-facing provisioning surface for the managed-bot model: the
 * Business Admin launches a single-use provisioning attempt, FlowPilot
 * opens the Manager Bot deep link, the Admin confirms inside Telegram's
 * own creation UI, and the `managed_bot` event completes everything
 * server-side. The customer NEVER sees a bot token, NEVER visits
 * BotFather, and NEVER configures a webhook.
 *
 * Invariants (DECISIONS #63/#47, AGENT_RULES):
 * - The Business is ALWAYS server-derived from the authenticated actor.
 *   A client-supplied businessId can never redirect a read or a write
 *   (the UI payload carries no identity at all).
 * - This view is SECRET-FREE: no bot token, no webhook secret, no
 *   credential reference, no provider error text — only non-secret bot
 *   metadata (@username, display name, state, the safe failure summary).
 * - The operational gate (`status === "CONNECTED" && isActive`) is what
 *   the transport runtime consumes; `onboardingState` is a SEPARATE
 *   surface for the provisioning UX only (exactly like the WhatsApp
 *   connection).
 */

/**
 * The ONE UI state machine (DECISIONS #66). Derived server-side from the
 * connection row + the latest provisioning attempt — the browser never
 * interprets raw provider state, and no spinner runs forever: every state
 * has an action or an honest terminal label.
 */
export type TelegramConnectionUiState =
  | "EMPTY" // no connection and no attempt → the primary CTA is «اربط تيليجرام»
  | "PROVISIONING" // an in-flight attempt: the Admin has the deep link open
  | "CONNECTED" // operationally connected + active: the bot is live
  | "ACTION_REQUIRED" // the last attempt failed with a retryable reason
  | "DISCONNECTED"; // a previously connected bot the Admin disconnected

/**
 * The secret-free view the settings UI renders. Nothing here can be used
 * to impersonate the bot or reach the provider.
 */
export type TelegramConnectionView = {
  connectionId: string;
  uiState: TelegramConnectionUiState;
  /** The bot's @username — non-secret, provider-reported. */
  botUsername: string | null;
  /** The bot's Telegram display name — non-secret, provider-reported. */
  botDisplayName: string | null;
  /** Safe, customer-appropriate Arabic summary of the current state. */
  summary: string | null;
  /** True only when the operational gate passes (CONNECTED + active). */
  operationallyConnected: boolean;
  /** The last attempt's typed outcome code (no provider text). */
  lastOutcomeCode: string | null;
  /** When the state last changed (safe, non-secret timestamp). */
  stateChangedAt: string | null;
};

/** The launch result: only safe, non-secret information crosses to the UI. */
export type BeginTelegramProvisioningResult =
  | {
      success: true;
      launched: true;
      /** The Manager Bot deep link — its ONLY payload is the opaque token. */
      authorizationUrl: string;
      /** When the attempt expires (the UI's honest countdown). */
      expiresAt: string;
    }
  | {
      success: true;
      launched: false;
      /** The Business is already connected — nothing to launch. */
      reason: "ALREADY_CONNECTED";
    }
  | { success: false; message: string };

export type TelegramDisconnectionResult =
  | {
      success: true;
      /** A cleanup step at Telegram or the credential store did not
       *  confirm; the connection is STILL disconnected locally. */
      cleanupWarning: string | null;
    }
  | { success: false; message: string };

/** The read result (the status action + the launch surface share it). */
export type TelegramConnectionReadResult =
  | { success: true; view: TelegramConnectionView }
  | { success: false; message: string };
