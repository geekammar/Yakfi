/**
 * Business Settings feature types (operator PROMPT-09).
 */

export type SettingsActionResult =
  { success: true } | { success: false; message: string };

/**
 * Serializable settings view of the Business record for the settings
 * screen — no ids of other tenants, no internal fields.
 */
export type BusinessSettingsView = {
  name: string;
  vertical: string;
  city: string;
  whatsappNumber: string;
  timezone: string;
  /** Customer-facing description (PROMPT-AI-OPS-21). "" when not set. */
  about: string;
  /** Customer-facing location line (PROMPT-AI-OPS-21). "" when not set. */
  address: string;
  confirmationMode: string;
  cancellationPolicy: string;
  /** Candidate appointment start-time interval in minutes (UX001-R3). */
  slotDurationMinutes: number;
};
