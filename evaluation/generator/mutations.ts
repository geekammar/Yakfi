/**
 * FlowPilot AI Evaluation — deterministic mutation engine.
 *
 * Reusable, SEEDED string transforms that turn one clean Egyptian utterance
 * into realistic messy variants (missing hamza, dropped punctuation,
 * repeated letters, typos, Arabizi, Arabic/English mixing, informal
 * punctuation, speech-to-text phrasing, abbreviations, character omission,
 * neighbouring-key slips, spacing slips, punctuation duplication, spelling
 * variation, mixed Arabic/Latin numerals).
 *
 * Two hard rules:
 *  1. DETERMINISTIC — a `(text, seed)` pair always yields the same output,
 *     so the whole dataset is reproducible.
 *  2. GOLD-PRESERVING — every mutation here changes only the SURFACE FORM,
 *     never the semantic meaning. Intentional meaning changes are modelled
 *     as separate scenarios, never as mutations.
 */

import type { MutationKind } from "../schema/scenario-schema";
import type { NoiseCategory } from "../schema/taxonomy";

// ─── Seeded PRNG (mulberry32 — tiny, deterministic, dependency-free) ─────────

export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit string hash → seed derivation. */
export function hashSeed(input: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)] as T;
}

// ─── Mutation primitives ─────────────────────────────────────────────────────

/** Restore-common-typos: strip the hamza off common alef/hamza forms. */
export function missingHamza(text: string): string {
  return text
    .replace(/[أإآ]/g, "ا")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ء/g, "");
}

/** Remove terminal + inner punctuation (very common in chat). */
export function dropPunctuation(text: string): string {
  return text
    .replace(/[؟?.!،,؛;:]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Elongate a random long vowel/letter run (e.g. "عايز" → "عاااايز"). */
export function repeatLetters(text: string, rng: () => number): string {
  const elongatable = "اويةهلبنمرع";
  const chars = [...text];
  const candidates: number[] = [];
  for (let i = 0; i < chars.length; i += 1) {
    if (elongatable.includes(chars[i] as string)) candidates.push(i);
  }
  if (candidates.length === 0) return text;
  const idx = pick(rng, candidates);
  const times = 2 + Math.floor(rng() * 3);
  chars[idx] = (chars[idx] as string).repeat(times);
  return chars.join("");
}

/** Introduce one realistic adjacent-letter swap typo. */
export function typo(text: string, rng: () => number): string {
  const words = text.split(" ");
  const long = words.map((w, i) => ({ w, i })).filter((x) => x.w.length >= 4);
  if (long.length === 0) return text;
  const target = pick(rng, long);
  const chars = [...target.w];
  const j = 1 + Math.floor(rng() * (chars.length - 2));
  const tmp = chars[j] as string;
  chars[j] = chars[j + 1] as string;
  chars[j + 1] = tmp;
  words[target.i] = chars.join("");
  return words.join(" ");
}

/** Common Egyptian Arabizi transliteration of frequent words. */
const ARABIZI_MAP: ReadonlyArray<[RegExp, string]> = [
  [/عايز/g, "3ayez"],
  [/عايزة/g, "3ayza"],
  [/أحجز|احجز/g, "a7gez"],
  [/موعد/g, "maw3ed"],
  [/معاد/g, "me3ad"],
  [/الخميس/g, "el khamis"],
  [/بكرة|بكره/g, "bokra"],
  [/إمتى|امتى/g, "emta"],
  [/الساعة|الساعه/g, "el sa3a"],
  [/كام/g, "kam"],
  [/ازيك|إزيك/g, "ezayak"],
  [/تمام/g, "tamam"],
  [/شكرا|شكراً/g, "shokran"],
  [/تنظيف/g, "tanzeef"],
  [/أسنان|اسنان/g, "asnan"],
  [/عندكم|عندكو/g, "3andoko"],
];

export function toArabizi(text: string): string {
  let out = text;
  for (const [re, rep] of ARABIZI_MAP) out = out.replace(re, rep);
  return out;
}

/** Insert a common English word alongside the Arabic (code-switching). */
const ENGLISH_INJECTIONS: ReadonlyArray<[RegExp, string]> = [
  [/موعد/g, "appointment"],
  [/حجز/g, "booking"],
  [/الأسعار|الاسعار|السعر/g, "price"],
  [/متاح/g, "available"],
  [/تأكيد|تاكيد/g, "confirm"],
  [/إلغاء|الغاء/g, "cancel"],
];

export function mixEnglish(text: string, rng: () => number): string {
  const applicable = ENGLISH_INJECTIONS.filter(([re]) => re.test(text));
  if (applicable.length === 0) return `${text} please`;
  const [re, en] = pick(rng, applicable);
  return text.replace(re, (m) => `${m} (${en})`);
}

/** Replace terminal punctuation with informal repeated marks. */
export function informalPunctuation(text: string, rng: () => number): string {
  const base = text.replace(/[؟?.!،]+$/g, "").trim();
  const tail = pick(rng, ["؟؟", "!!", "..", "؟!", "..."]);
  return `${base}${tail}`;
}

/** Speech-to-text style: no punctuation, run-on, filler words. */
export function speechToText(text: string, rng: () => number): string {
  const fillers = ["يعني", "بص", "طيب", "اه", "ماشي"];
  const filler = pick(rng, fillers);
  return dropPunctuation(`${filler} ${text.toLowerCase()}`).replace(
    /\s+/g,
    " ",
  );
}

/** Common Egyptian chat abbreviations. */
export function abbreviate(text: string): string {
  return text
    .replace(/إن شاء الله|ان شاء الله/g, "ان شا الله")
    .replace(/السلام عليكم/g, "سلام")
    .replace(/شكراً جزيلاً|شكرا جزيلا/g, "متشكر")
    .replace(/ممكن/g, "ممكن")
    .replace(/الموعد/g, "الميعاد");
}

// ─── PROMPT-AI-EVAL-02 mutation strategies ───────────────────────────────────
//
// Six additional SURFACE_PRESERVING transforms covering the noise axes the
// v1 bank did not exercise: character omission, neighbouring-key slips,
// spacing slips, punctuation duplication, inconsistent Egyptian spelling,
// and mixed Arabic/Latin numerals. All deterministic + seeded; none of them
// can move the semantic gold label.

/** Drop one interior character from a long word (mobile mis-tap). */
export function charOmission(text: string, rng: () => number): string {
  const words = text.split(" ");
  const long = words.map((w, i) => ({ w, i })).filter((x) => x.w.length >= 4);
  if (long.length === 0) return text;
  const target = pick(rng, long);
  const chars = [...target.w];
  const j = 1 + Math.floor(rng() * (chars.length - 2));
  chars.splice(j, 1);
  words[target.i] = chars.join("");
  return words.join(" ");
}

/**
 * Neighbouring-key substitution on the standard Arabic keyboard layout
 * (the 3-row PC/mobile layout Egyptians actually type on).
 */
const ARABIC_KEYBOARD_NEIGHBORS: Readonly<Record<string, string>> = {
  ض: "صثقش",
  ص: "ضثقسي",
  ث: "ضصقف ي".replace(/\s/g, ""),
  ق: "ضصثفغر",
  ف: "ثقغعب",
  غ: "قفعهل",
  ع: "فغهخا",
  ه: "غعخحت",
  خ: "عهجحن",
  ح: "هخجبم",
  ج: "خحبم",
  ش: "ضسيب",
  س: "ضصشيب",
  ي: "صشسبلت",
  ب: "شسيلاات".replace(/\s/g, ""),
  ل: "يباتمن",
  ا: "بلت مه".replace(/\s/g, ""),
  ت: "بلاما ن".replace(/\s/g, ""),
  ن: "تملهاي",
  م: "نتلها",
  ك: "نمة",
  ة: "حمتن",
  ر: "قلاي",
  ذ: "ظطدا ز".replace(/\s/g, ""),
  د: "ظطذ زي".replace(/\s/g, ""),
  ز: "ظطذد",
  ط: "كظذد",
  ظ: "طذد",
  ء: "ذدزي",
  ؤ: "ضصش",
  ئ: "شس",
};

export function keyboardMistake(text: string, rng: () => number): string {
  const chars = [...text];
  const candidates: number[] = [];
  for (let i = 0; i < chars.length; i += 1) {
    if (ARABIC_KEYBOARD_NEIGHBORS[chars[i] as string]) candidates.push(i);
  }
  if (candidates.length === 0) return text;
  const idx = pick(rng, candidates);
  const current = chars[idx] as string;
  const neighbors = ARABIC_KEYBOARD_NEIGHBORS[current] as string;
  chars[idx] = neighbors[Math.floor(rng() * neighbors.length)] as string;
  return chars.join("");
}

/**
 * Spacing slip: either join two words (a missing space — very common when
 * Arabic autocomplete is off) or split one long word with a stray space.
 */
export function spacing(text: string, rng: () => number): string {
  const spaceIdx: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === " ") spaceIdx.push(i);
  }
  if (spaceIdx.length > 0 && rng() < 0.6) {
    const at = pick(rng, spaceIdx);
    return `${text.slice(0, at)}${text.slice(at + 1)}`;
  }
  const words = text.split(" ");
  const long = words.map((w, i) => ({ w, i })).filter((x) => x.w.length >= 5);
  if (long.length === 0) return text;
  const target = pick(rng, long);
  const chars = [...target.w];
  const at = 2 + Math.floor(rng() * (chars.length - 4));
  words[target.i] =
    `${chars.slice(0, at).join("")} ${chars.slice(at).join("")}`;
  return words.join(" ");
}

/**
 * Duplicate terminal punctuation (an enthusiastic / sloppy chat habit). A
 * turn with no terminal punctuation is left untouched — adding a question
 * mark would change the sentence type, not just its surface.
 */
export function punctuationDuplication(
  text: string,
  rng: () => number,
): string {
  const trimmed = text.trim();
  const tail = trimmed.slice(-1);
  if (!/[؟?.!،,]/.test(tail)) return text;
  const times = 2 + Math.floor(rng() * 2);
  return `${trimmed.slice(0, -1)}${tail.repeat(times)}`;
}

/**
 * Inconsistent Egyptian spelling — the same word realized with a different
 * accepted orthography (تنظيف/تنضيف, موعد/ميعاد, ة/ه, أ/ا). Real customers
 * are not consistent even inside one sentence.
 */
const SPELLING_VARIANTS: ReadonlyArray<[RegExp, string]> = [
  [/تنظيف/g, "تنضيف"],
  [/موعد/g, "ميعاد"],
  [/أسنان/g, "اسنان"],
  [/الساعة/g, "الساعه"],
  [/بكرة/g, "بكره"],
  [/أوي/g, "اوي"],
  [/كده/g, "كدة"],
  [/شوية/g, "شويه"],
  [/العيادة/g, "العياده"],
  [/إمتى/g, "امتى"],
  [/تأكيد/g, "تاكيد"],
  [/الظهر/g, "الضهر"],
  [/أحجز/g, "احجز"],
  [/إلغاء/g, "الغاء"],
  [/تقويم/g, "تقويم"],
];

export function spellingVariation(text: string, rng: () => number): string {
  const applicable = SPELLING_VARIANTS.filter(([re]) => re.test(text));
  if (applicable.length === 0) return text;
  const [re, rep] = pick(rng, applicable);
  return text.replace(re, rep);
}

const LATIN_TO_ARABIC_INDIC: Readonly<Record<string, string>> = {
  "0": "٠",
  "1": "١",
  "2": "٢",
  "3": "٣",
  "4": "٤",
  "5": "٥",
  "6": "٦",
  "7": "٧",
  "8": "٨",
  "9": "٩",
};

/**
 * Mixed numerals — Latin digits written in Arabic-Indic form (or one digit
 * left Latin inside an otherwise Arabic-Indic number), which is what Arabic
 * keyboards with a long-press digit row actually produce.
 */
export function mixedNumerals(text: string, rng: () => number): string {
  const numbers = text.match(/\d+/g);
  if (!numbers || numbers.length === 0) return text;
  const target = pick(rng, numbers);
  const converted = [...target]
    .map((d) => (rng() < 0.75 ? (LATIN_TO_ARABIC_INDIC[d] ?? d) : d))
    .join("");
  // Never alter the numeric VALUE (a no-op is skipped by the compose step).
  if (converted === target) return text;
  return text.replace(target, converted);
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────

const MUTATION_NOISE: Record<MutationKind, NoiseCategory> = {
  MISSING_HAMZA: "MISSING_HAMZA",
  DROP_PUNCTUATION: "MISSING_PUNCTUATION",
  REPEAT_LETTERS: "REPEATED_LETTERS",
  TYPO: "TYPOS",
  ARABIZI: "ARABIZI",
  MIX_ENGLISH: "MIXED_LANGUAGE",
  INFORMAL_PUNCTUATION: "INFORMAL_PUNCTUATION",
  SPEECH_TO_TEXT: "SPEECH_TO_TEXT",
  ABBREVIATE: "ABBREVIATIONS",
  CHAR_OMISSION: "TYPOS",
  KEYBOARD_MISTAKE: "KEYBOARD_MISTAKE",
  SPACING: "TYPOS",
  PUNCTUATION_DUPLICATION: "INFORMAL_PUNCTUATION",
  SPELLING_VARIATION: "SPELLING_VARIATION",
  MIXED_NUMERALS: "TYPOS",
};

export function noiseForMutation(kind: MutationKind): NoiseCategory {
  return MUTATION_NOISE[kind];
}

/** Apply one mutation deterministically given a per-mutation seed. */
export function applyMutation(
  kind: MutationKind,
  text: string,
  seed: number,
): string {
  const rng = makeRng(seed);
  switch (kind) {
    case "MISSING_HAMZA":
      return missingHamza(text);
    case "DROP_PUNCTUATION":
      return dropPunctuation(text);
    case "REPEAT_LETTERS":
      return repeatLetters(text, rng);
    case "TYPO":
      return typo(text, rng);
    case "ARABIZI":
      return toArabizi(text);
    case "MIX_ENGLISH":
      return mixEnglish(text, rng);
    case "INFORMAL_PUNCTUATION":
      return informalPunctuation(text, rng);
    case "SPEECH_TO_TEXT":
      return speechToText(text, rng);
    case "ABBREVIATE":
      return abbreviate(text);
    case "CHAR_OMISSION":
      return charOmission(text, rng);
    case "KEYBOARD_MISTAKE":
      return keyboardMistake(text, rng);
    case "SPACING":
      return spacing(text, rng);
    case "PUNCTUATION_DUPLICATION":
      return punctuationDuplication(text, rng);
    case "SPELLING_VARIATION":
      return spellingVariation(text, rng);
    case "MIXED_NUMERALS":
      return mixedNumerals(text, rng);
  }
}
