/**
 * WhatsApp onboarding feature types (WHATSAPP-ONBOARDING-01).
 *
 * The SEPARATE onboarding lifecycle of a Business-owned WhatsApp
 * connection: the Business Admin authorizes the provider → the
 * callback provisions the provider identity → read-only verification
 * completes operational readiness.
 *
 * Invariants (DECISIONS #31/#47, AGENT_RULES):
 * - `onboardingState` is NEVER consumed by `resolveConnectionForSend`,
 *   `resolveInboundConnection`, the conversation engine, booking, or
 *   AI. It is a separate surface; the operational gate stays
 *   `status === "CONNECTED" && isActive`.
 * - Everything here is secret-free: no access token, no authorization
 *   code, no raw provider response. `credentialsRef` is a REFERENCE.
 * - The target Business is always server-derived (the authenticated
 *   actor for BEGIN, the persisted authorization ledger for CALLBACK).
 */

import type {
  CredentialKind,
  WhatsAppOnboardingFailureCategory,
  WhatsAppOnboardingState,
} from "@/lib/validation";
import type {
  AuthorizationErrorCode,
  AuthorizationProvenance,
} from "@/server/transport/whatsapp-transport";

/** Authorization context derived from the authenticated session. */
export type WhatsAppOnboardingActor = {
  userId: string;
  role: "ADMIN" | "STAFF";
  businessId: string | null;
};

/**
 * Serializable, secret-free view of the onboarding lifecycle for the
 * Business-facing UI (settings / onboarding review). The customer never
 * sees WABA ids, phone_number_id, system users, access tokens, or
 * provider error text — only the simplified lifecycle below.
 */
export type WhatsAppOnboardingView = {
  connectionId: string;
  /** Simplified customer-facing lifecycle label (Arabic). */
  statusLabel: string;
  /** The machine key behind the label (UI state routing only). */
  onboardingState: WhatsAppOnboardingState;
  /** True only when the operational gate passes (CONNECTED + active). */
  operationallyConnected: boolean;
  /** Safe, customer-appropriate next action (never operator detail). */
  cta: WhatsAppOnboardingCta;
  /** Safe human summary when the last attempt failed (no provider text). */
  reasonSummary: string | null;
};

export type WhatsAppOnboardingCta =
  | "CONFIGURE" // the last attempt is not retryable → start over in settings
  | "BEGIN" // no connection yet → launch the provider authorization
  | "RESUME" // authorization in flight → return to the provider
  | "VERIFY" // provider identity ready → verify the connection
  | "ACT" // the provider needs an action from the business
  | "RETRY" // the last attempt failed and can be retried
  | "DONE"; // connected and ready — nothing to do

export type BeginWhatsAppOnboardingResult =
  | {
      success: true;
      launched: true;
      /** Where the Business Admin's browser goes next. */
      authorizationUrl: string;
      /** Opaque single-use state reference (the callback credential). */
      stateRef: string;
      connectionId: string;
      /** Resumed an in-flight attempt instead of launching a new one. */
      resumed: boolean;
    }
  | {
      success: true;
      launched: false;
      /** The lifecycle is already complete — nothing to launch. */
      reason: "ALREADY_READY";
      connectionId: string;
    }
  | { success: false; message: string };

export type WhatsAppCallbackErrorCode =
  | AuthorizationErrorCode
  /** Unknown/hostile stateRef — no persisted attempt matched it. */
  | "AUTHORIZATION_STATE_UNKNOWN"
  /** The attempt expired before the callback arrived. */
  | "AUTHORIZATION_EXPIRED"
  /** Replay: the attempt was already consumed once. */
  | "AUTHORIZATION_ALREADY_CONSUMED"
  /** The ledger's connection does not belong to its Business. */
  | "AUTHORIZATION_CONNECTION_MISMATCH"
  /** The provider identity is already claimed by another Business. */
  | "DUPLICATE_EXTERNAL_ID"
  /** Persistence failed. */
  | "PERSISTENCE_FAILED";

export type HandleWhatsAppAuthorizationCallbackResult =
  | {
      success: true;
      businessId: string;
      connectionId: string;
      onboardingState: WhatsAppOnboardingState;
      /** Safe customer-facing summary of the outcome. */
      summary: string;
    }
  | {
      success: false;
      code: WhatsAppCallbackErrorCode;
      message: string;
    };

/** Normalized LAST onboarding failure (WHATSAPP-ONBOARDING-01 §8). */
export type OnboardingFailure = {
  category: WhatsAppOnboardingFailureCategory;
  /** Stable internal code — never a raw provider response. */
  reasonCode: string;
  /** Safe human-readable summary (customer-appropriate). */
  reasonSummary: string;
  retryable: boolean;
  failedAt: Date;
  /** The safe correlation id (the connection row id). */
  operationRef: string;
};

export type CredentialReferenceDescriptor = {
  reference: string;
  kind: CredentialKind;
};

export type { AuthorizationProvenance };
