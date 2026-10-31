/**
 * The ONE canonical candidate time-grid derivation for booking (Spec A).
 *
 * This is the single source of the "which start times could this day
 * possibly offer?" grid. It is PURE: deterministic wall-clock math over
 * a stored working-hours week, a service duration and the business's
 * slot granularity — no database, no repository, no `Date.now()`, no
 * network. Both the availability AUTHORITY
 * (`features/appointments/server/availability-service.ts`, which then
 * filters out conflicts to return only genuinely selectable slots) and
 * the client-side PRESENTATIONAL grid (the booking wizard's slot step,
 * which marks authority-returned candidates as selectable and every
 * other candidate as disabled) import it — so there is exactly one slot
 * engine and one grid rule, never two.
 *
 * What this module does NOT do: decide availability. It only generates
 * the candidate grid. Whether a candidate is actually bookable is the
 * availability authority's answer (conflicts, business rules) and is
 * consulted through the one `getAvailabilityAction` contract.
 */

/** The business week, in `workingHours` JSON order (Sat–Fri). */
export const WEEK_DAYS = [
  "sat",
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
] as const;

export type Weekday = (typeof WEEK_DAYS)[number];

/** A candidate start time — business-local wall-clock "HH:mm" pair. */
export type CandidateSlot = {
  startTime: string;
  /** start + the service's duration, "HH:mm". */
  endTime: string;
};

/** "HH:mm" → minutes since midnight. */
export function toMinutes(time: string): number {
  const [hours = 0, minutes = 0] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

/** Minutes since midnight → "HH:mm". */
export function toWallClock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * Internal clock-time parser: parses wall-clock seconds from a string without
 * machine-local timezone parsing or arbitrary `new Date()` conversion.
 *
 * Supported formats:
 * - "HH:mm" (e.g. "10:00")
 * - "HH:mm:ss" (e.g. "10:00:00")
 * - ISO 8601 epoch or date strings: "YYYY-MM-DDTHH:mm:ss.sssZ", etc.
 *
 * Fails closed (returns null) on:
 * - non-string / empty values
 * - invalid hour (outside 00..23)
 * - invalid minute (outside 00..59)
 * - invalid second (outside 00..59)
 */
function parseClockSeconds(value: unknown): {
  totalSeconds: number;
  hasFractionalSeconds: boolean;
} | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const match = trimmed.match(
    /^(?:\d{4}-\d{2}-\d{2}[T ])?([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?(?:\.(\d+))?(?:Z|[+-]\d{2}:?\d{2})?$/,
  );
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = match[3] !== undefined ? Number(match[3]) : 0;
  const fractional = match[4];
  const hasFractionalSeconds = Boolean(fractional && !/^0+$/.test(fractional));

  const totalSeconds = hours * 3600 + minutes * 60 + seconds;
  return { totalSeconds, hasFractionalSeconds };
}

/**
 * Calculates the duration in whole minutes between stored appointment start and end times.
 *
 * Domain invariants (ISS-008 / BK-50):
 * 1. Single-day bounded: Appointments exist within a single calendar day; overnight
 *    intervals (end <= start) are unsupported in this domain and return null.
 * 2. Positive non-zero duration: `end > start` is strictly required. Equal or reversed
 *    times return null.
 * 3. Minute precision contract: All FlowPilot appointments and services operate on integer
 *    minutes. Unsupported fractional-minute intervals (e.g., partial seconds diff) return
 *    null rather than being rounded.
 * 4. Deterministic clock arithmetic: Operates strictly on validated clock components,
 *    avoiding device/machine-local timezone drift.
 */
export function calculateAppointmentDurationMinutes(
  startTime: unknown,
  endTime: unknown,
): number | null {
  const start = parseClockSeconds(startTime);
  const end = parseClockSeconds(endTime);

  if (!start || !end) {
    return null;
  }

  // Any non-zero fractional seconds violate the domain's minute-level contract
  if (start.hasFractionalSeconds || end.hasFractionalSeconds) {
    return null;
  }

  const diffSeconds = end.totalSeconds - start.totalSeconds;

  // The appointment domain strictly rejects end <= start (no overnight appointments,
  // no negative durations, no zero duration).
  if (diffSeconds <= 0) {
    return null;
  }

  // Domain precision contract: appointment intervals are defined in whole minutes.
  // We do not round non-integer minute intervals (e.g. 10:00:30 to 10:20:00).
  if (diffSeconds % 60 !== 0) {
    return null;
  }

  return diffSeconds / 60;
}

/**
 * Weekday key for a calendar date. A "YYYY-MM-DD" string maps to one
 * exact weekday — timezone-independent by construction, so the Business
 * timezone never changes which working-hours entry applies.
 */
export function weekdayOfDate(date: string): Weekday {
  // 1970-01-03 (epoch day 2) was a Saturday.
  const daysSinceEpoch = Math.floor(
    Date.parse(`${date}T00:00:00.000Z`) / 86_400_000,
  );
  return WEEK_DAYS[(daysSinceEpoch - 2 + 7) % 7] ?? "sat";
}

/**
 * The working-hours entry for one weekday key, read from the stored
 * `Business.workingHours` JSON week (single open/close interval per
 * weekday). Returns null when the business is closed that day or has no
 * usable working-hours data (an onboarded business always has the full
 * week persisted; a missing week is treated as closed, NEVER as 24h
 * availability).
 */
export function resolveWorkingHoursForWeekday(
  workingHours: unknown,
  weekday: Weekday,
): { openMinutes: number; closeMinutes: number } | null {
  if (!workingHours || typeof workingHours !== "object") return null;
  const entry = (workingHours as Record<string, unknown>)[weekday];
  if (!entry || typeof entry !== "object") return null;
  const { open, close, closed } = entry as {
    open?: unknown;
    close?: unknown;
    closed?: unknown;
  };
  if (closed !== false) return null;
  if (typeof open !== "string" || typeof close !== "string") return null;
  const openMinutes = toMinutes(open);
  const closeMinutes = toMinutes(close);
  if (closeMinutes <= openMinutes) return null;
  return { openMinutes, closeMinutes };
}

/** Date-based convenience wrapper over `resolveWorkingHoursForWeekday`. */
export function resolveWorkingHours(
  workingHours: unknown,
  date: string,
): { openMinutes: number; closeMinutes: number } | null {
  return resolveWorkingHoursForWeekday(workingHours, weekdayOfDate(date));
}

/**
 * Generate the candidate grid inside a working interval: candidates
 * step from `open` by the business's canonical `slotDurationMinutes`
 * (set in onboarding step 3) — the existing slot-granularity setting,
 * nothing new. A candidate appears in the grid only when its FULL
 * service duration fits before `close` (a 45-min service never starts
 * 17:30 in a 10:00–18:00 day), so the grid never offers a start time
 * the day cannot contain.
 */
export function generateCandidateSlots(params: {
  openMinutes: number;
  closeMinutes: number;
  durationMinutes: number;
  slotDurationMinutes: number;
}): CandidateSlot[] {
  const { openMinutes, closeMinutes, durationMinutes } = params;
  // The step is the business's canonical slot granularity; never zero
  // (the schema floor is 5, but a defensive guard keeps the loop finite).
  const step = Math.max(1, params.slotDurationMinutes);
  const slots: CandidateSlot[] = [];
  for (
    let start = openMinutes;
    start + durationMinutes <= closeMinutes;
    start += step
  ) {
    slots.push({
      startTime: toWallClock(start),
      endTime: toWallClock(start + durationMinutes),
    });
  }
  return slots;
}

/**
 * The candidate grid for one date, derived from the business's stored
 * working-hours week + slot granularity and a service duration. Returns
 * null when the day is closed, the working hours are absent/unusable,
 * or the service duration never fits the day — the caller renders
 * nothing grid-like rather than fabricating candidates.
 */
export function generateCandidateGrid(params: {
  workingHours: unknown;
  /** Business-local "YYYY-MM-DD". */
  date: string;
  durationMinutes: number;
  slotDurationMinutes: number;
}): CandidateSlot[] | null {
  const workingDay = resolveWorkingHours(params.workingHours, params.date);
  if (!workingDay) return null;
  const candidates = generateCandidateSlots({
    openMinutes: workingDay.openMinutes,
    closeMinutes: workingDay.closeMinutes,
    durationMinutes: params.durationMinutes,
    slotDurationMinutes: params.slotDurationMinutes,
  });
  return candidates.length > 0 ? candidates : null;
}

/**
 * Current calendar date (ISO "YYYY-MM-DD") in the business timezone.
 */
export function todayInTimeZone(now: Date, timeZone: string): string {
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return formatter.format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/**
 * Current wall-clock time ("HH:mm") in the business timezone (24-hour).
 */
export function nowTimeInTimeZone(now: Date, timeZone: string): string {
  try {
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = formatter.formatToParts(now);
    const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
    const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
    const h = hour === "24" ? "00" : hour.padStart(2, "0");
    return `${h}:${minute.padStart(2, "0")}`;
  } catch {
    return now.toISOString().slice(11, 16);
  }
}
