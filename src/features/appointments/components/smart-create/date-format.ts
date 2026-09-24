/** Shared calendar-date helpers for the booking wizard ("YYYY-MM-DD"). */

/**
 * Relative scheduling choices (B-07). Each resolves to one concrete
 * business-local date through `resolveRelativeDate` — the user never
 * counts days manually. The anchor is server-derived business today
 * for the date step, or the just-created appointment's date for a
 * follow-up (a follow-up "after 1 week" means one week after THAT
 * appointment, not after today).
 */
export type RelativeDateOption =
  | "today"
  | "tomorrow"
  | "this-week"
  | "next-week"
  | "after-1-week"
  | "after-2-weeks"
  | "after-1-month";

/** Quick relative choices offered on the date step (B-07 §C). */
export const RELATIVE_DATE_OPTIONS: ReadonlyArray<{
  option: RelativeDateOption;
  label: string;
}> = [
  { option: "today", label: "اليوم" },
  { option: "tomorrow", label: "غداً" },
  { option: "this-week", label: "هذا الأسبوع" },
  { option: "next-week", label: "الأسبوع القادم" },
  { option: "after-1-week", label: "بعد أسبوع" },
  { option: "after-2-weeks", label: "بعد أسبوعين" },
  { option: "after-1-month", label: "بعد شهر" },
];

/**
 * Follow-up relative choices (B-07 §6) — a subset of the scheduling
 * options, relative to the created appointment's date. "Choose date"
 * and "Skip" are separate UI actions (not date computations).
 */
export const FOLLOW_UP_OPTIONS: ReadonlyArray<{
  option: Extract<
    RelativeDateOption,
    "after-1-week" | "after-2-weeks" | "after-1-month"
  >;
  label: string;
}> = [
  { option: "after-1-week", label: "بعد أسبوع" },
  { option: "after-2-weeks", label: "بعد أسبوعين" },
  { option: "after-1-month", label: "بعد شهر" },
];

/** Shift a "YYYY-MM-DD" date by N days (timezone-independent math). */
export function moveDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/**
 * Shift a "YYYY-MM-DD" date by N calendar months, clamping the day to
 * the target month's last day (Jan 31 + 1 month → Feb 28) — the
 * timezone-independent "after 1 month" scheduling choice.
 */
export function addMonths(date: string, months: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  const year = value.getUTCFullYear();
  const month = value.getUTCMonth(); // 0-based
  const day = value.getUTCDate();
  const total = year * 12 + month + months;
  const nextYear = Math.floor(total / 12);
  const nextMonth = total % 12;
  const lastDayOfMonth = new Date(
    Date.UTC(nextYear, nextMonth + 1, 0),
  ).getUTCDate();
  return `${nextYear}-${String(nextMonth + 1).padStart(2, "0")}-${String(
    Math.min(day, lastDayOfMonth),
  ).padStart(2, "0")}`;
}

/**
 * The Saturday starting the Sat–Fri business week containing `date`
 * (the Arabic/Egyptian work week — the same `sat…fri` order the
 * availability layer's `workingHours` uses). 1970-01-03 (epoch day 2)
 * was a Saturday.
 */
export function startOfBusinessWeek(date: string): string {
  const daysSinceEpoch = Math.floor(
    Date.parse(`${date}T00:00:00.000Z`) / 86_400_000,
  );
  const offset = (((daysSinceEpoch - 2) % 7) + 7) % 7; // 0 = Saturday
  return moveDate(date, -offset);
}

/**
 * Resolve one relative scheduling choice to a concrete
 * "YYYY-MM-DD" date (B-07 §B). Deterministic, timezone-independent
 * math only — no availability is consulted here (the slot step does
 * that), and the resolved date is always shown to the user before
 * booking.
 *
 * - `today` / `tomorrow` — the anchor itself / the next day.
 * - `this-week` — the earliest day of the current Sat–Fri week that is
 *   strictly after tomorrow (distinct from today/tomorrow, already
 *   covered by their own choices). When the week has no such day left
 *   (the anchor is Thursday/Friday), it falls forward to the start of
 *   the NEXT week rather than silently meaning "today + 2".
 * - `next-week` — the Saturday starting the next Sat–Fri week (an
 *   unambiguous "beginning of next week").
 * - `after-1-week` / `after-2-weeks` — anchor + 7 / + 14 days.
 * - `after-1-month` — one calendar month after the anchor.
 */
export function resolveRelativeDate(
  anchor: string,
  option: RelativeDateOption,
): string {
  switch (option) {
    case "today":
      return anchor;
    case "tomorrow":
      return moveDate(anchor, 1);
    case "this-week": {
      const weekStart = startOfBusinessWeek(anchor);
      const weekEnd = moveDate(weekStart, 6); // Friday
      const earliest = moveDate(anchor, 2);
      // "YYYY-MM-DD" compares chronologically.
      return earliest > weekEnd ? moveDate(weekStart, 7) : earliest;
    }
    case "next-week":
      return moveDate(startOfBusinessWeek(anchor), 7);
    case "after-1-week":
      return moveDate(anchor, 7);
    case "after-2-weeks":
      return moveDate(anchor, 14);
    case "after-1-month":
      return addMonths(anchor, 1);
  }
}

/** Long Arabic display for a "YYYY-MM-DD" date (e.g. "الجمعة، 4 سبتمبر 2026"). */
export function formatArabicDate(date: string): string {
  return new Intl.DateTimeFormat("ar-EG", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(`${date}T00:00:00.000Z`));
}

/** Short Arabic weekday for a date chip (e.g. "الجمعة"). */
export function formatArabicWeekday(date: string): string {
  return new Intl.DateTimeFormat("ar-EG", {
    timeZone: "UTC",
    weekday: "short",
  }).format(new Date(`${date}T00:00:00.000Z`));
}

/** Short Arabic month for a date chip (e.g. "سبتمبر"). */
export function formatArabicMonth(date: string): string {
  return new Intl.DateTimeFormat("ar-EG", {
    timeZone: "UTC",
    month: "short",
  }).format(new Date(`${date}T00:00:00.000Z`));
}

/** Compact Arabic day + month for a relative-choice caption (e.g. "٤ سبتمبر"). */
export function formatArabicDayMonth(date: string): string {
  return new Intl.DateTimeFormat("ar-EG", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
  }).format(new Date(`${date}T00:00:00.000Z`));
}

/**
 * Relative choices that denote a PERIOD rather than one exact day (B-07
 * polish): tapping one offers the days of that period as candidates so
 * the user can fine-tune, with the deterministic resolved date selected
 * by default. `today` / `tomorrow` name exact days and offer no window.
 */
export const RELATIVE_WINDOW_OPTIONS: ReadonlyArray<RelativeDateOption> = [
  "this-week",
  "next-week",
  "after-1-week",
  "after-2-weeks",
  "after-1-month",
];

/**
 * The candidate days of a relative period (B-07 polish) — the seven days
 * starting at the period's resolved date. Deterministic,
 * timezone-independent math ONLY: availability is deliberately NOT
 * consulted here (Step 4 owns the availability authority, and no second
 * engine may live in the client). The resolved date — the FIRST entry —
 * is the default selection. Returns `null` for exact-day choices.
 */
export function relativeDateWindow(
  anchor: string,
  option: RelativeDateOption,
): string[] | null {
  if (!RELATIVE_WINDOW_OPTIONS.includes(option)) return null;
  const start = resolveRelativeDate(anchor, option);
  return Array.from({ length: 7 }, (_, index) => moveDate(start, index));
}
