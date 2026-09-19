/**
 * WhatsApp connection onboarding feature types
 * (Business Admin → connect/configure WhatsApp; DECISIONS #31, #42).
 *
 * Everything here is provider-neutral and secret-free: the view never
 * carries an access token, and `credentialsRef` is an env-var NAME (the
 * reference, never the secret).
 */

import type { ConnectionVerificationResult } from "@/server/transport/whatsapp-transport";

/**
 * Serializable, secret-free view of a Business-owned WhatsApp connection
 * for the settings UI. Only non-secret identifiers cross to the client.
 */
export type WhatsAppConnectionView = {
  id: string;
  /** Provider machine key (e.g. "meta-whatsapp") — label only. */
  provider: string | null;
  displayName: string | null;
  /** The WhatsApp number (E.164) — a display label, NOT the identity. */
  phoneNumber: string;
  /**
   * The provider's STABLE connection identity (Meta `phone_number_id`)
   * — AUTHORITATIVE for resolution. Masked in the UI; the full value is
   * never needed by a Business Admin.
   */
  externalId: string | null;
  /** Masked externalId for safe display (never the raw full id). */
  externalIdMasked: string | null;
  /** Lifecycle machine key: PENDING / CONNECTED / DISCONNECTED. */
  status: string;
  isActive: boolean;
  /** Last time the connection record changed (verification updates it). */
  updatedAt: string;
};

export type WhatsAppConnectionListResult =
  { connections: WhatsAppConnectionView[] } | { message: string };

export type WhatsAppConnectionActionResult =
  | { success: true; connection: WhatsAppConnectionView }
  | { success: false; message: string };

export type WhatsAppVerificationResult =
  | {
      success: true;
      connection: WhatsAppConnectionView;
      verification: Extract<ConnectionVerificationResult, { ok: true }>;
    }
  | {
      success: false;
      message: string;
      /** Normalized failure category for a clear UI state. */
      verificationCode: Extract<
        ConnectionVerificationResult,
        { ok: false }
      >["code"];
    };
