/**
 * Global server-side feature flag for Appointment Reminders (BOOK-REM-01).
 *
 * Reminders are intentionally DISABLED by default during the Discovery phase.
 * Even if an individual Business has reminderEnabled = true in settings,
 * no reminders will be scheduled, claimed, or dispatched unless the global
 * feature flag APPOINTMENT_REMINDERS_ENABLED is explicitly set to "true".
 *
 * Required semantics:
 * - Missing / undefined / empty -> disabled (false).
 * - "false" -> disabled (false).
 * - "true" -> enabled only if production scheduler and channels are ready (true).
 * - Any other value -> disabled (false) with safe diagnostics.
 */

export type EnvSource = { [key: string]: string | undefined };

export type ReminderOperationalDiagnostics = {
  operational: boolean;
  value: string | undefined;
  reason: string;
};

/**
 * Diagnostic inspector for the appointment reminder feature flag.
 * Server-only, safe, deterministic. Does not expose secrets.
 */
export function getAppointmentRemindersDiagnostics(
  env: EnvSource = process.env,
): ReminderOperationalDiagnostics {
  const raw = env.APPOINTMENT_REMINDERS_ENABLED;

  // 1. Missing / undefined / empty string -> disabled
  if (raw === undefined || raw === null || raw.trim() === "") {
    return {
      operational: false,
      value: raw,
      reason:
        "FLAG_NOT_SET: Appointment reminders are disabled by default during Discovery.",
    };
  }

  const normalized = raw.trim().toLowerCase();

  // 2. Explicit "false" -> disabled
  if (normalized === "false") {
    return {
      operational: false,
      value: raw,
      reason: "FLAG_EXPLICIT_FALSE: Appointment reminders explicitly disabled.",
    };
  }

  // 3. Explicit "true" -> operational
  if (normalized === "true") {
    return {
      operational: true,
      value: raw,
      reason: "FLAG_EXPLICIT_TRUE: Appointment reminders operational.",
    };
  }

  // 4. Any other value -> disabled with safe diagnostic
  return {
    operational: false,
    value: raw,
    reason: `FLAG_INVALID_VALUE: Unexpected value "${raw.slice(0, 32)}" (safe fallback: disabled).`,
  };
}

/**
 * Centralized server-side operational check for appointment reminders.
 * Returns true ONLY if APPOINTMENT_REMINDERS_ENABLED is strictly "true".
 */
export function areAppointmentRemindersOperational(
  env: EnvSource = process.env,
): boolean {
  return getAppointmentRemindersDiagnostics(env).operational;
}
