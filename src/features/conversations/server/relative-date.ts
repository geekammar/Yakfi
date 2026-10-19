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
  "بعد يومين",
].map(normalizeArabicText);

const THREE_WEEKS_PHRASES: ReadonlyArray<string> = [
  "بعد 3 اسابيع",
  "بعد 3 أسابيع",
  "بعد ٣ اسابيع",
  "بعد ٣ أسابيع",
  "بعد تلات اسابيع",
  "بعد تلات أسابيع",
  "بعد ثلاثة اسابيع",
  "بعد ثلاثة أسابيع",
  "كمان 3 اسابيع",
  "كمان 3 أسابيع",
  "كمان ٣ اسابيع",
  "كمان ٣ أسابيع",
  "كمان تلات اسابيع",
  "كمان تلات أسابيع",
  "كمان ثلاثة اسابيع",
  "كمان ثلاثة أسابيع",
  "تلات اسابيع",
  "تلات أسابيع",
  "ثلاثة اسابيع",
  "ثلاثة أسابيع",
].map(normalizeArabicText);

const TWO_WEEKS_PHRASES: ReadonlyArray<string> = [
  "بعد اسبوعين",
  "بعد أسبوعين",
  "الاسبوع بعد القادم",
  "الأسبوع بعد القادم",
  "الاسبوع اللي بعد الجاي",
  "الأسبوع اللي بعد الجاي",
].map(normalizeArabicText);

const NEXT_WEEK_PHRASES: ReadonlyArray<string> = [
  "الاسبوع القادم",
  "الأسبوع القادم",
  "الاسبوع الجاي",
  "الأسبوع الجاي",
  "الاسبوع المقبل",
  "الأسبوع المقبل",
  "بعد اسبوع",
  "بعد أسبوع",
].map(normalizeArabicText);

const THIS_WEEK_PHRASES: ReadonlyArray<string> = [
  "هذا الاسبوع",
  "هذا الأسبوع",
  "الاسبوع ده",
  "الأسبوع ده",
  "الاسبوع الحالي",
  "الأسبوع الحالي",
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

const NEGATION_WORDS = new Set(["بلاش", "مش", "لا", "لأ", "غير", "بدل", "ما"]);

const PREPOSITIONS = new Set(["في", "ف", "من", "علي", "على", "ب", "مع"]);

/**
 * Resolve a supported colloquial Egyptian relative-date form inside a customer
 * message to a bounded ISO `YYYY-MM-DD`, relative to `today` (ISO). Returns
 * `null` when the message carries no recognized relative-date form or when the
 * only mentioned dates are explicitly negated (e.g. "بلاش بكرة", "مش بكرة").
 *
 * Recognition order: an explicit ISO date verbatim → day-after-tomorrow phrase
 * → a weekday name → week phrases → a single relative word. The first recognized form wins.
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

  const tokens = normalized.split(/\s+/);
  function isNegatedAt(idx: number): boolean {
    return (
      (idx > 0 && NEGATION_WORDS.has(tokens[idx - 1]!)) ||
      (idx > 1 &&
        NEGATION_WORDS.has(tokens[idx - 2]!) &&
        PREPOSITIONS.has(tokens[idx - 1]!))
    );
  }

  type DateCandidate = { date: string; negated: boolean };
  const candidates: DateCandidate[] = [];

  // Day-after-tomorrow is a phrase ("بعد بكرة") — match before single words.
  for (const phrase of DAY_AFTER_TOMORROW_PHRASES) {
    if (phrase.length > 0 && normalized.includes(phrase)) {
      const idx = tokens.findIndex((t) => phrase.includes(t));
      const negated = idx !== -1 ? isNegatedAt(idx) : false;
      candidates.push({ date: addDays(today, 2), negated });
      break;
    }
  }

  // If today is explicitly mentioned ("النهاردة" / "اليوم") alongside a weekday,
  // honor today if the weekday matches today's weekday.
  const isTodayMentioned = ["النهاردة", "النهارده", "اليوم"].some((w) =>
    normalized.includes(normalizeArabicText(w)),
  );

  // A weekday name anywhere in the message ("طيب نرجع للحجز الخميس").
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const day = WEEKDAY_BY_WORD.get(token);
    if (day) {
      const negated = isNegatedAt(i);
      if (isTodayMentioned && weekdayOfDate(today) === day) {
        candidates.push({ date: addDays(today, 0), negated });
      } else {
        const base = nextWeekday(today, day);
        if (THREE_WEEKS_PHRASES.some((p) => normalized.includes(p))) {
          candidates.push({ date: addDays(base, 14), negated });
        } else if (TWO_WEEKS_PHRASES.some((p) => normalized.includes(p))) {
          candidates.push({ date: addDays(base, 7), negated });
        } else {
          candidates.push({ date: base, negated });
        }
      }
    }
  }

  for (const phrase of THREE_WEEKS_PHRASES) {
    if (phrase.length > 0 && normalized.includes(phrase)) {
      candidates.push({ date: addDays(today, 21), negated: false });
      break;
    }
  }

  for (const phrase of TWO_WEEKS_PHRASES) {
    if (phrase.length > 0 && normalized.includes(phrase)) {
      candidates.push({ date: addDays(today, 14), negated: false });
      break;
    }
  }

  for (const phrase of NEXT_WEEK_PHRASES) {
    if (phrase.length > 0 && normalized.includes(phrase)) {
      candidates.push({ date: addDays(today, 7), negated: false });
      break;
    }
  }

  for (const phrase of THIS_WEEK_PHRASES) {
    if (phrase.length > 0 && normalized.includes(phrase)) {
      candidates.push({ date: addDays(today, 0), negated: false });
      break;
    }
  }

  // A single relative word (today / tomorrow).
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const offset = OFFSET_BY_WORD.get(token);
    if (offset !== undefined) {
      candidates.push({
        date: addDays(today, offset),
        negated: isNegatedAt(i),
      });
    }
  }

  // Non-negated candidate wins first
  const positive = candidates.find((c) => !c.negated);
  if (positive) return positive.date;

  return null;
}

/**
 * Extract time of day preference from customer message text (e.g. "الصبح", "بعد العصر", "بالمساء").
 * Correctly accounts for negation so that "مش الصبح، بالليل" resolves to "evening" rather than "morning",
 * and an isolated negated preference ("بلاش الصبح") returns null.
 */
export function extractTimeOfDayPreference(
  message: string,
): "morning" | "afternoon" | "evening" | null {
  const norm = normalizeArabicText(message);
  if (norm.length === 0) return null;
  const tokens = norm.split(/\s+/);

  function isNegatedAt(idx: number): boolean {
    return (
      (idx > 0 && NEGATION_WORDS.has(tokens[idx - 1]!)) ||
      (idx > 1 &&
        NEGATION_WORDS.has(tokens[idx - 2]!) &&
        PREPOSITIONS.has(tokens[idx - 1]!))
    );
  }

  type TimeCandidate = {
    pref: "morning" | "afternoon" | "evening";
    negated: boolean;
  };
  const candidates: TimeCandidate[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (
      t.includes("صبح") ||
      t.includes("صباح") ||
      t.includes("بدري") ||
      t === "اول النهار" ||
      t === "اول اليوم"
    ) {
      candidates.push({ pref: "morning", negated: isNegatedAt(i) });
    } else if (t.includes("عصر") || t.includes("ظهر") || t.includes("ضهر")) {
      candidates.push({ pref: "afternoon", negated: isNegatedAt(i) });
    } else if (t.includes("مساء") || t.includes("ليل") || t.includes("متاخر")) {
      candidates.push({ pref: "evening", negated: isNegatedAt(i) });
    }
  }

  // Also check multi-word phrases like "بعد الظهر", "بعد العصر", "اول النهار", "اول اليوم"
  if (norm.includes("اول النهار") || norm.includes("اول اليوم")) {
    const isNeg =
      /(?:بلاش|مش|لا|لأ|غير|بدل|ما)\s+(?:اول النهار|اول اليوم)/.test(norm);
    if (!candidates.some((c) => c.pref === "morning")) {
      candidates.push({ pref: "morning", negated: isNeg });
    }
  }
  if (
    norm.includes("بعد الظهر") ||
    norm.includes("بعد الضهر") ||
    norm.includes("بعد العصر")
  ) {
    const isNeg =
      /(?:بلاش|مش|لا|لأ|غير|بدل|ما)\s+(?:بعد الظهر|بعد الضهر|بعد العصر)/.test(
        norm,
      );
    if (!candidates.some((c) => c.pref === "afternoon")) {
      candidates.push({ pref: "afternoon", negated: isNeg });
    }
  }

  // Prioritize positive (un-negated) preference
  const positive = candidates.find((c) => !c.negated);
  if (positive) return positive.pref;

  return null;
}

/**
 * Extract provider preference from customer message (e.g. "مع د. سارة", "دكتور أحمد").
 * Properly respects negation (e.g. "مع د. سارة بدل د. أحمد" resolves to "د. سارة").
 */
export function extractProviderPreference(text: string): string | null {
  const regex =
    /(?:^|\s)(?:مع|عند)?\s*(د\.\s*|دكتور\s+|دكتورة\s+|الدكتور\s+|الدكتورة\s+)([^\s,،]+)/g;
  const candidates: Array<{ name: string; negated: boolean }> = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    const namePart = match[2]!;
    const startIndex = match.index;
    const precedingText = text
      .slice(Math.max(0, startIndex - 20), startIndex)
      .trim();
    const precedingWords = precedingText.split(/\s+/);
    const lastWord = precedingWords[precedingWords.length - 1] ?? "";
    const isNegated =
      NEGATION_WORDS.has(lastWord) ||
      precedingWords.some((w) => NEGATION_WORDS.has(w));
    const cleanName = `د. ${namePart.trim()}`;
    candidates.push({ name: cleanName, negated: isNegated });
  }

  const pos = candidates.find((c) => !c.negated);
  return pos ? pos.name : null;
}
