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
  /** Customer appointment time display preference (START_ONLY vs FULL_RANGE). */
  appointmentTimeDisplay: "START_ONLY" | "FULL_RANGE";
  cancellationPolicy: string;
  /** Candidate appointment start-time interval in minutes (UX001-R3). */
  slotDurationMinutes: number;
  /** Automated appointment reminder enabled state (BOOK-REM-01). */
  reminderEnabled: boolean;
  /** Lead hours before appointment to send reminder (BOOK-REM-01). */
  reminderLeadHours: number;
  /** Selected message template/style id (BOOK-REM-01). */
  reminderTemplateId: string;
  /** Global server-side feature operational status (Discovery mode: false). */
  remindersOperational: boolean;
  /** Default service booking mode enabled state (CONV-PLAY-01). */
  defaultServiceBookingEnabled: boolean;
  /** Configured default service id for fast booking (CONV-PLAY-01). */
  defaultBookingServiceId: string | null;
  /** Messaging channel readiness status for automated reminders. */
  channelReadiness: {
    whatsapp: boolean;
    telegram: boolean;
    hasActiveChannel: boolean;
  };
};
