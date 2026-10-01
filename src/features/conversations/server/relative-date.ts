/**
 * Egyptian colloquial relative-date recognizer (PROMPT-AI-ARCH-08 — Slice 4
 * behavioral remediation).
 *
 * The SMALLEST deterministic seam that lets a supplied-fact RESUME bind a
 * colloquial Egyptian relative date to a pending `CLARIFY_DATE` instead of
 * re-clarifying (docs/ai/TARGET_ARCHITECTURE.md §7 / §9). The AI contract's
 * `extraction.date` only crosses the boundary as a bounded ISO `YYYY-MM-DD`
 * (`ai-contract.ts`), so a model can never carry «الخميس» as a date — the
 * engine (Conversation orchestration) must normalize the recognized colloquial
 * form into the ISO the booking DOMAIN already requires. This preserves the
 * invariant: AI interprets → Conversation orchestrates → Domain decides.
 *
 * Deliberate NON-goals (binding):
 * - This is NOT a generalized date-language framework and NOT a parser for
 *   free-form natural-language dates. It recognizes exactly the concrete
 *   colloquial Egyptian relative forms the failing evaluation cases exercise
 *   (weekday names, "today / tomorrow / the day after"), plus their obvious
 *   MSA/Egyptian spelling siblings. Unrecognized input returns `null` and the
 *   existing behavior (raw bind / re-clarify) is unchanged.
 * - It never guesses, never invents a date for ambiguous text, and never emits
 *   anything but a bounded ISO date the DOMAIN re-validates and executes.
 *
 * Everything here is PURE and TOTAL: no I/O, no network, no DB, no provider,
 * no `process.env`, no secret, and ZERO model inference. The resolution is
 * relative to an explicit reference `today` (ISO), so the same inputs always
 * yield the same ISO date — deterministic and offline-testable in isolation.
 */

import { normalizeArabicText } from "@/features/conversations/server/conversation-ai";
import {
  WEEK_DAYS,
  weekdayOfDate,
  type Weekday,
} from "@/lib/scheduling/slot-grid";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Colloquial Egyptian + MSA weekday names → the canonical weekday key. Written
 * naturally; normalized through the SAME `normalizeArabicText` pipeline the
 * classifier uses, so diacritic/alef/ta-marbuta variants compare equal.
 */
const RAW_WEEKDAYS: ReadonlyArray<readonly [string, Weekday]> = [
  ["السبت", "sat"],
  ["الأحد", "sun"],
  ["الاحد", "sun"],
  ["الإثنين", "mon"],
  ["الاثنين", "mon"],
  ["الاتنين", "mon"],
  ["الثلاثاء", "tue"],
  ["التلات", "tue"],
  ["التلاتاء", "tue"],
  ["الأربعاء", "wed"],
  ["الاربعاء", "wed"],
  ["الأربع", "wed"],
  ["الخميس", "thu"],
  ["الجمعة", "fri"],
];

const WEEKDAY_BY_WORD: ReadonlyMap<string, Weekday> = new Map(
  RAW_WEEKDAYS.map(([word, day]) => [normalizeArabicText(word), day]),
);

/**
 * Colloquial Egyptian + MSA single-word relative offsets (days from `today`).
 * Day-after-tomorrow is a PHRASE (checked first) because its second token
 * ("بكرة") is itself a +1 word.
 */
const RAW_RELATIVE: ReadonlyArray<readonly [string, number]> = [
  ["النهاردة", 0],
  ["النهارده", 0],
  ["اليوم", 0],
  ["بكرة", 1],
  ["بكره", 1],
  ["بكرا", 1],
  ["غدا", 1],
  ["غداً", 1],
];

const OFFSET_BY_WORD: ReadonlyMap<string, number> = new Map(
  RAW_RELATIVE.map(([word, offset]) => [normalizeArabicText(word), offset]),
);

/** Day-after-tomorrow phrases (normalized), checked before single words. */
const DAY_AFTER_TOMORROW_PHRASES: ReadonlyArray<string> = [
  "بعد بكرة",
  "بعد بكره",
  "بعد غد",
].map(normalizeArabicText);

/** Add `days` to an ISO `YYYY-MM-DD`, returning the ISO date (UTC-anchored). */
function addDays(iso: string, days: number): string {
  const ms = Date.parse(`${iso}T00:00:00.000Z`) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The next calendar occurrence of `target` STRICTLY after `today`. When the
 * target weekday is today, resolve to next week (delta 7) — a booking "يوم
 * الخميس" means an upcoming Thursday, never a day whose slots may already be
 * in the past.
 */
function nextWeekday(today: string, target: Weekday): string {
  const todayIndex = WEEK_DAYS.indexOf(weekdayOfDate(today));
  const targetIndex = WEEK_DAYS.indexOf(target);
  let delta = (targetIndex - todayIndex + 7) % 7;
  if (delta === 0) delta = 7;
  return addDays(today, delta);
}

/**
 * The current calendar date (ISO `YYYY-MM-DD`) in a business timezone. Pure
 * given `now`; falls back to the UTC date if the timezone is unusable.
 */
export function todayIsoInTimeZone(now: Date, timeZone: string): string {
  try {
    // en-CA renders `YYYY-MM-DD`.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/**
 * Resolve a supported colloquial Egyptian relative-date form inside a customer
 * message to a bounded ISO `YYYY-MM-DD`, relative to `today` (ISO). Returns
 * `null` when the message carries no recognized relative-date form — the caller
 * then keeps its existing behavior and never fabricates a date.
 *
 * Recognition order: an explicit ISO date verbatim → day-after-tomorrow phrase
 * → a weekday name → a single relative word. The first recognized form wins.
 */
export function resolveEgyptianRelativeDate(
  message: string,
  today: string,
): string | null {
  if (!ISO_DATE.test(today)) return null;
  const trimmed = message.trim();
  if (trimmed.length === 0) return null;

  // An explicit ISO date supplied verbatim is already the DOMAIN form.
  if (ISO_DATE.test(trimmed)) return trimmed;

  const normalized = normalizeArabicText(message);
  if (normalized.length === 0) return null;

  // Day-after-tomorrow is a phrase ("بعد بكرة") — match before single words.
  for (const phrase of DAY_AFTER_TOMORROW_PHRASES) {
    if (phrase.length > 0 && normalized.includes(phrase)) {
      return addDays(today, 2);
    }
  }

  const tokens = normalized.split(" ").filter(Boolean);

  // A weekday name anywhere in the message ("طيب نرجع للحجز الخميس").
  for (const token of tokens) {
    const day = WEEKDAY_BY_WORD.get(token);
    if (day) return nextWeekday(today, day);
  }

  // A single relative word (today / tomorrow).
  for (const token of tokens) {
    const offset = OFFSET_BY_WORD.get(token);
    if (offset !== undefined) return addDays(today, offset);
  }

  return null;
}
