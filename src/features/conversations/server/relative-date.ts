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
const PREPOSITIONS = new Set([
  "في",
  "ف",
  "من",
  "علي",
  "على",
  "ب",
  "مع",
  "عند",
  "ل",
]);
const VOLITION_WORDS = new Set(["عايز", "عاوز", "حابب", "محتاج"]);

function matchSequenceAt(
  tokens: string[],
  start: number,
  phraseTokens: string[],
): boolean {
  if (start + phraseTokens.length > tokens.length) return false;
  for (let j = 0; j < phraseTokens.length; j++) {
    if (tokens[start + j] !== phraseTokens[j]) return false;
  }
  return true;
}

function isNegatedAt(tokens: string[], idx: number): boolean {
  if (idx > 0 && NEGATION_WORDS.has(tokens[idx - 1]!)) {
    return true;
  }
  if (
    idx > 1 &&
    NEGATION_WORDS.has(tokens[idx - 2]!) &&
    (PREPOSITIONS.has(tokens[idx - 1]!) || VOLITION_WORDS.has(tokens[idx - 1]!))
  ) {
    return true;
  }
  return false;
}

export type RelativeDateResolution = {
  positiveDate: string | null;
  negatedDates: string[];
};

/**
 * Resolve supported colloquial Egyptian relative-date forms inside a customer message,
 * returning both the unambiguous positive date (if any) and all negated dates.
 *
 * Prevents double-counting component words of recognized multi-token phrases,
 * respects localized negation spans, and rejects contradictory dates.
 */
export function resolveEgyptianRelativeDateDetailed(
  message: string,
  today: string,
): RelativeDateResolution {
  if (!ISO_DATE.test(today)) return { positiveDate: null, negatedDates: [] };
  const trimmed = message.trim();
  if (trimmed.length === 0) return { positiveDate: null, negatedDates: [] };

  // An explicit ISO date supplied verbatim is already the DOMAIN form.
  if (ISO_DATE.test(trimmed)) {
    return { positiveDate: trimmed, negatedDates: [] };
  }

  const normalized = normalizeArabicText(message);
  if (normalized.length === 0) return { positiveDate: null, negatedDates: [] };

  const tokens = normalized.split(/\s+/).filter(Boolean);
  const consumed = new Set<number>();
  type Candidate = { date: string; negated: boolean };
  const candidates: Candidate[] = [];

  // 1. Day-after-tomorrow phrases (exact sequential token matches, checked before single words)
  for (const phrase of DAY_AFTER_TOMORROW_PHRASES) {
    const pTokens = phrase.split(/\s+/).filter(Boolean);
    for (let i = 0; i <= tokens.length - pTokens.length; i++) {
      if (consumed.has(i)) continue;
      if (matchSequenceAt(tokens, i, pTokens)) {
        const negated = isNegatedAt(tokens, i);
        candidates.push({ date: addDays(today, 2), negated });
        for (let k = 0; k < pTokens.length; k++) consumed.add(i + k);
      }
    }
  }

  // 2. Weekdays (with optional multi-week modifiers)
  const isTodayMentioned = ["النهاردة", "النهارده", "اليوم"].some((w) =>
    normalized.includes(normalizeArabicText(w)),
  );

  for (let i = 0; i < tokens.length; i++) {
    if (consumed.has(i)) continue;
    const token = tokens[i]!;
    const day = WEEKDAY_BY_WORD.get(token);
    if (day) {
      const negated = isNegatedAt(tokens, i);
      consumed.add(i);
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

  // 3. Multi-week phrases alone
  const multiWeekPatterns: Array<{
    phrases: ReadonlyArray<string>;
    offsetDays: number;
  }> = [
    { phrases: THREE_WEEKS_PHRASES, offsetDays: 21 },
    { phrases: TWO_WEEKS_PHRASES, offsetDays: 14 },
    { phrases: NEXT_WEEK_PHRASES, offsetDays: 7 },
    { phrases: THIS_WEEK_PHRASES, offsetDays: 0 },
  ];

  for (const { phrases, offsetDays } of multiWeekPatterns) {
    for (const phrase of phrases) {
      const pTokens = phrase.split(/\s+/).filter(Boolean);
      for (let i = 0; i <= tokens.length - pTokens.length; i++) {
        let anyConsumed = false;
        for (let k = 0; k < pTokens.length; k++) {
          if (consumed.has(i + k)) {
            anyConsumed = true;
            break;
          }
        }
        if (anyConsumed) continue;
        if (matchSequenceAt(tokens, i, pTokens)) {
          const negated = isNegatedAt(tokens, i);
          candidates.push({ date: addDays(today, offsetDays), negated });
          for (let k = 0; k < pTokens.length; k++) consumed.add(i + k);
        }
      }
    }
  }

  // 4. Single relative word (today / tomorrow)
  for (let i = 0; i < tokens.length; i++) {
    if (consumed.has(i)) continue;
    const token = tokens[i]!;
    const offset = OFFSET_BY_WORD.get(token);
    if (offset !== undefined) {
      const negated = isNegatedAt(tokens, i);
      candidates.push({ date: addDays(today, offset), negated });
      consumed.add(i);
    }
  }

  const positive = candidates.filter((c) => !c.negated);
  const negated = candidates.filter((c) => c.negated);
  const uniquePositive = Array.from(new Set(positive.map((c) => c.date)));
  const uniqueNegated = Array.from(new Set(negated.map((c) => c.date)));

  // If there are contradictory positive dates, prefer safe clarification (return null)
  const positiveDate = uniquePositive.length === 1 ? uniquePositive[0]! : null;

  return {
    positiveDate,
    negatedDates: uniqueNegated,
  };
}

/**
 * Resolve a supported colloquial Egyptian relative-date form inside a customer
 * message to a bounded ISO `YYYY-MM-DD`, relative to `today` (ISO). Returns
 * `null` when the message carries no recognized relative-date form or when the
 * only mentioned dates are explicitly negated (e.g. "بلاش بكرة", "مش بكرة").
 */
export function resolveEgyptianRelativeDate(
  message: string,
  today: string,
): string | null {
  return resolveEgyptianRelativeDateDetailed(message, today).positiveDate;
}

export type TimeOfDayResolution = {
  positiveTime: "morning" | "afternoon" | "evening" | null;
  negatedTimes: Array<"morning" | "afternoon" | "evening">;
};

const MULTI_WORD_TIME_PHRASES: ReadonlyArray<{
  phrase: string;
  pref: "morning" | "afternoon" | "evening";
}> = [
  // Afternoon
  { phrase: "بعد الظهر", pref: "afternoon" },
  { phrase: "بعد الضهر", pref: "afternoon" },
  { phrase: "بعد العصر", pref: "afternoon" },
  // Morning
  { phrase: "اول النهار", pref: "morning" },
  { phrase: "اول اليوم", pref: "morning" },
  { phrase: "الصبح بدري", pref: "morning" },
  // Evening
  { phrase: "في الليل", pref: "evening" },
  { phrase: "ف الليل", pref: "evening" },
  { phrase: "في المساء", pref: "evening" },
  { phrase: "ف المساء", pref: "evening" },
].map((item) => ({
  phrase: normalizeArabicText(item.phrase),
  pref: item.pref as "morning" | "afternoon" | "evening",
}));

/**
 * Extract time of day preference with detailed resolution (positive & negated).
 */
export function extractTimeOfDayPreferenceDetailed(
  message: string,
): TimeOfDayResolution {
  const norm = normalizeArabicText(message);
  if (norm.length === 0) return { positiveTime: null, negatedTimes: [] };
  const tokens = norm.split(/\s+/).filter(Boolean);
  const consumed = new Set<number>();

  type Candidate = {
    pref: "morning" | "afternoon" | "evening";
    negated: boolean;
  };
  const candidates: Candidate[] = [];

  // 1. Multi-word phrases
  for (const { phrase, pref } of MULTI_WORD_TIME_PHRASES) {
    const pTokens = phrase.split(/\s+/).filter(Boolean);
    for (let i = 0; i <= tokens.length - pTokens.length; i++) {
      let anyConsumed = false;
      for (let k = 0; k < pTokens.length; k++) {
        if (consumed.has(i + k)) {
          anyConsumed = true;
          break;
        }
      }
      if (anyConsumed) continue;
      if (matchSequenceAt(tokens, i, pTokens)) {
        const negated = isNegatedAt(tokens, i);
        candidates.push({ pref, negated });
        for (let k = 0; k < pTokens.length; k++) consumed.add(i + k);
      }
    }
  }

  // 2. Single token words
  for (let i = 0; i < tokens.length; i++) {
    if (consumed.has(i)) continue;
    const t = tokens[i]!;
    let pref: "morning" | "afternoon" | "evening" | null = null;
    if (t.includes("صبح") || t.includes("صباح") || t.includes("بدري")) {
      pref = "morning";
    } else if (t.includes("عصر") || t.includes("ظهر") || t.includes("ضهر")) {
      pref = "afternoon";
    } else if (
      t.includes("مساء") ||
      t.includes("ليل") ||
      t.includes("متاخر") ||
      t.includes("سهرة")
    ) {
      pref = "evening";
    }

    if (pref) {
      const negated = isNegatedAt(tokens, i);
      candidates.push({ pref, negated });
      consumed.add(i);
    }
  }

  const positive = candidates.filter((c) => !c.negated);
  const negated = candidates.filter((c) => c.negated);
  const uniquePositive = Array.from(new Set(positive.map((c) => c.pref)));
  const uniqueNegated = Array.from(new Set(negated.map((c) => c.pref)));

  const positiveTime = uniquePositive.length === 1 ? uniquePositive[0]! : null;

  return {
    positiveTime,
    negatedTimes: uniqueNegated,
  };
}

/**
 * Extract time of day preference from customer message text (e.g. "الصبح", "بعد العصر", "بالمساء").
 * Correctly accounts for negation so that "مش الصبح، بالليل" resolves to "evening" rather than "morning",
 * and an isolated negated preference ("بلاش الصبح") returns null.
 */
export function extractTimeOfDayPreference(
  message: string,
): "morning" | "afternoon" | "evening" | null {
  return extractTimeOfDayPreferenceDetailed(message).positiveTime;
}

export type ProviderPreferenceResolution = {
  positiveProvider: string | null;
  negatedProviders: string[];
};

/**
 * Extract provider preference with detailed resolution (positive & negated).
 * Respects local clause negation without incorrectly negating positive replacements.
 */
export function extractProviderPreferenceDetailed(
  text: string,
): ProviderPreferenceResolution {
  const norm = normalizeArabicText(text);
  if (norm.length === 0)
    return { positiveProvider: null, negatedProviders: [] };

  const regex =
    /(?:^|\s)(?:مع|عند)?\s*(د\.\s*|دكتور\s+|دكتورة\s+|الدكتور\s+|الدكتورة\s+)([^\s,،.]+)/g;

  type Candidate = { name: string; negated: boolean };
  const candidates: Candidate[] = [];

  let match;
  while ((match = regex.exec(text)) !== null) {
    const namePart = match[2]!;
    const startIndex = match.index;

    // Look at tokens strictly immediately preceding the title/preposition
    const precedingSlice = text
      .slice(Math.max(0, startIndex - 30), startIndex)
      .trim();
    const precedingNorm = normalizeArabicText(precedingSlice);
    const precedingTokens = precedingNorm.split(/\s+/).filter(Boolean);

    const lastToken = precedingTokens[precedingTokens.length - 1];
    const secondLastToken = precedingTokens[precedingTokens.length - 2];

    const isNegated =
      (lastToken && NEGATION_WORDS.has(lastToken)) ||
      (lastToken &&
        (PREPOSITIONS.has(lastToken) || VOLITION_WORDS.has(lastToken)) &&
        secondLastToken &&
        NEGATION_WORDS.has(secondLastToken));

    const cleanName = `د. ${namePart.trim()}`;
    candidates.push({ name: cleanName, negated: Boolean(isNegated) });
  }

  const positive = candidates.filter((c) => !c.negated);
  const negated = candidates.filter((c) => c.negated);
  const uniquePositive = Array.from(new Set(positive.map((c) => c.name)));
  const uniqueNegated = Array.from(new Set(negated.map((c) => c.name)));

  // If contradictory positive providers, prefer safe clarification (return null)
  const positiveProvider =
    uniquePositive.length === 1 ? uniquePositive[0]! : null;

  return {
    positiveProvider,
    negatedProviders: uniqueNegated,
  };
}

/**
 * Extract provider preference from customer message (e.g. "مع د. سارة", "دكتور أحمد").
 * Properly respects negation (e.g. "مش د. أحمد، مع د. سارة" resolves to "د. سارة").
 */
export function extractProviderPreference(text: string): string | null {
  return extractProviderPreferenceDetailed(text).positiveProvider;
}
