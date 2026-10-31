/**
 * AI assistant boundary for the conversation engine (PROMPT-19; contract
 * strengthened in PROMPT-ARCH-02 — DECISIONS #33).
 *
 * The domain depends on the `ConversationAi` interface — never on an LLM
 * vendor SDK. The only implementation today is
 * `deterministicConversationAi`: a transparent rule-based Arabic
 * classifier (keyword/phrase matching + FAQ answer matching against
 * `Business.faqs`). It is NOT live LLM inference; a real AI provider is
 * a future operator decision (see DECISIONS.md) and will implement the
 * SAME typed contract (`ai-contract.ts`) without changing the engine.
 *
 * Non-negotiable behavior encoded here (DECISIONS #03, PRODUCT_STRATEGY):
 * - FAQ answers are the VERBATIM stored `Business.faqs` answer text —
 *   the assistant never fabricates business information.
 * - No matching knowledge, ambiguity, sensitive/high-stakes language, or
 *   an explicit human request → typed handoff; the assistant never
 *   forces an answer and never fakes certainty.
 * - Booking-related intents produce a typed `booking_handoff` — the
 *   assistant orchestrates, it never creates appointments itself.
 * - Extraction returns FACTS ONLY (matched service name at most) — the
 *   deterministic classifier never guesses dates, times, or providers,
 *   and never emits chain-of-thought.
 */

import type {
  AiIntent,
  AiRequest,
  AiResponse,
  HandoffReason as ContractHandoffReason,
} from "@/features/conversations/server/ai-contract";
import {
  emptyAiExtraction,
  parseAiRequest,
} from "@/features/conversations/server/ai-contract";
import type { AiRoutingDecision } from "@/features/conversations/server/ai-observability";
import type { HandoffCause } from "@/features/conversations/server/handoff-cause";
import type { HandoffReason as ControlHandoffReason } from "@/server/integrations/ai/conversation-control/types";
import type { AiTelemetry } from "@/server/integrations/ai/types";

export type {
  AiIntent,
  AiRequest,
  AiResponse,
  HandoffReason,
} from "@/features/conversations/server/ai-contract";

/** Provider-neutral assistant over the structured AI contract. */
export interface ConversationAi {
  /** Honest reporting of WHICH assistant implementation answered. */
  readonly providerName: string;
  respond(request: AiRequest): Promise<AiResponse>;
}

// ─── Arabic text normalization ───────────────────────────────────────────────

/**
 * Normalizes Arabic (and mixed Arabic/Latin) text for deterministic
 * matching: strips diacritics + tatweel, unifies alef/ya/hamza variants
 * and ta-marbuta, drops punctuation, collapses whitespace.
 */
export function normalizeArabicText(text: string): string {
  return text
    .replace(/[\u064B-\u0652\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ئ/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ة/g, "ه")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Strips the definite article / waw prefix so tokens compare equally, the
 * Egyptian conjunction «و» ("and"), and the Egyptian single-letter clitic
 * «بـ» ("with/by"). The clitic matters for safety (F1, DECISIONS:
 * TARGET_ARCHITECTURE Slice 1): «بموظف» is "with an employee" and must
 * normalize to the bare noun «موظف» so an explicit human request is never
 * missed. The conjunction matters for task relevance (ARCH-14): «وبكام» is
 * "and how much" and must normalize to «كام» so a price question hidden
 * behind «و» is not withheld. The length guards keep short function words
 * (e.g. «بس», «وقت») intact — only words long enough to carry a real stem
 * after the affix are stripped.
 */
export function stripAffixes(token: string): string {
  let word = token;
  if (word.length > 3 && word.startsWith("و")) word = word.slice(1);
  if (word.length > 4 && word.startsWith("وال")) word = word.slice(3);
  else if (word.length > 3 && word.startsWith("ال")) word = word.slice(2);
  else if (word.length > 3 && word.startsWith("ب")) word = word.slice(1);
  return word;
}

function tokenize(text: string): string[] {
  return normalizeArabicText(text)
    .split(" ")
    .filter(Boolean)
    .map(stripAffixes)
    .filter((word) => word.length > 1 && !STOPWORDS.has(word));
}

/** Whole-word (with light morphology) match against a keyword list. */
function hasWord(tokens: string[], keywords: string[]): boolean {
  return tokens.some((token) =>
    keywords.some(
      (keyword) =>
        token === keyword || (keyword.length >= 3 && token.startsWith(keyword)),
    ),
  );
}

/** Substring phrase match against normalized text. */
function hasPhrase(normalized: string, phrases: string[]): boolean {
  return phrases.some((phrase) => normalized.includes(phrase));
}

/**
 * Does the turn carry a first-person request-to-speak cue? Matched against the
 * RAW normalized tokens (NOT the STOPWORD-filtered `tokenize` output) because
 * the cue verbs themselves are stopwords («عايز»، «ممكن»، «أبغي»). Used only to
 * promote a provider TITLE mention into an explicit human request
 * (PROMPT-AI-OPS-25) — it never fires a handoff on its own.
 */
function hasRequestCue(normalized: string): boolean {
  const rawTokens = normalized.split(" ").filter(Boolean);
  return rawTokens.some((token) =>
    HUMAN_REQUEST_CUES_N.some(
      (cue) => token === cue || (cue.length >= 3 && token.startsWith(cue)),
    ),
  );
}

// ─── Keyword tables (written naturally; normalized at module load) ──────────

// NOTE: provider/professional TITLE words («دكتور»/«دكتورة») live in
// `HUMAN_TITLE_WORDS` below, NOT here. A bare title NAMES a practitioner
// (a provider-identity or provider-preference turn) and carries no handoff
// intent by itself; admitting it here made the deterministic explicit-human
// precedence fire on ordinary identity questions (PROMPT-AI-OPS-25).
const HUMAN_WORDS = [
  "موظف",
  "موظفة",
  "مسؤول",
  "مسئول",
  "شخص",
  "بشري",
  "إنسان",
  "مدير",
  "مديرة",
  "سكرتير",
  "سكرتيرة",
  "مساعدة",
];

/**
 * Provider/professional TITLE words. A title mention alone is NOT an explicit
 * human request: «السلام عليكم هو انتو عيادة الدكتورة افنان للاسنان؟» is a
 * provider-IDENTITY question and «أي دكتور» inside a booking request is a
 * provider PREFERENCE (already gated by the booking-task mask). A title counts
 * as the customer's own handoff ONLY when the turn ALSO carries a
 * request-to-speak cue (`HUMAN_REQUEST_CUES`) — the intent that actually asks
 * to reach the person (PROMPT-AI-OPS-25).
 *
 * Without this split, the deterministic explicit-human precedence
 * (`turn-planner` rule 2 / `detectTurnControlSignals`) fired on EVERY turn that
 * merely named the provider, the engine's safe-handoff fallback echoed the
 * customer-request handoff message, and "Resume AI" could not restore the AI
 * thread — the next turn re-derived the SAME false signal from the SAME
 * message text, so the handoff repeated indefinitely.
 */
const HUMAN_TITLE_WORDS = ["دكتور", "دكتورة"];

/**
 * First-person request-to-speak cues that promote a provider-title mention
 * into an explicit human request («أكلم الدكتور»، «أبغي أتكلم مع الدكتور»،
 * «ممكن أكلم الدكتور؟»). A closed, high-precision set of request verbs;
 * a title alone never fires and a title without one of these is a normal
 * business turn.
 */
const HUMAN_REQUEST_CUES = [
  "أكلم",
  "اكلم", // I call / speak to
  "أتكلم",
  "اتكلم", // I converse with
  "أبغي",
  "ابغي",
  "أبي",
  "ابي", // I want
  "عايز",
  "عايه", // I want (Egyptian)
  "أحب",
  "احب", // I would like
  "محتاج", // I need
  "ممكن", // may I
  "لو سمحت", // please
  "رجاء",
  "أرجو",
  "ارجو", // I request
  "أقدر",
  "اقدر", // can I
];

const HUMAN_PHRASES = [
  "حد يكلمني",
  "كلموني",
  "أتكلم مع حد",
  "اتكلم مع حد",
  "كلام مع حد",
  "شخص حقيقي",
  "موظف حقيقي",
  "الدكتور نفسه",
  "معايا حد",
  // "connect me with someone" — the transfer verb «وصّلني بـ» carries the
  // human request even when the object is the bare «حد» ("anyone"), which
  // is not a HUMAN_WORDS entry on its own (F1, TARGET_ARCHITECTURE Slice 1).
  "وصلني بحد",
  "حولني لموظف",
  "حولني لشخص",
  "خدمة العملاء",
  "خدمه العملاء",
  "تحدث إلى موظف",
  "تحدث الى موظف",
  "التحدث إلى موظف",
  "التحدث الى موظف",
  "تكلم مع موظف",
  "التكلم مع موظف",
];

const SENSITIVE_WORDS = [
  "شكوى",
  "مشكلة",
  "زعلان",
  "زعلانة",
  "غاضب",
  "مستاء",
  "نزيف",
  "تورم",
  "مكسور",
  "طوارئ",
  "طارئ",
  "إسعاف",
  "خطير",
  "دعوى",
  "قضية",
  "سيء",
];

const SENSITIVE_PHRASES = ["ألم شديد", "ألم رهيب", "ألم حاد", "مساعدة عاجلة"];

const CANCELLATION_WORDS = [
  "إلغاء",
  "ألغي",
  "ألغيه",
  "كنسل",
  "اعتذر",
  "اعتذار",
];

const CANCELLATION_PHRASES = [
  "مش هاحضر",
  "مش هقدر أحضر",
  "مش هقدر أجي",
  "إلغاء الموعد",
  "إلغاء الحجز",
  "الاعتذار عن الموعد",
];

const RESCHEDULE_MUTATION_WORDS = [
  "تغيير",
  "تأجيل",
  "تعديل",
  "تبديل",
  "تحويل",
  "غير",
  "أغير",
  "أعدل",
];

const APPOINTMENT_PREFIXES = ["موعد", "معاد", "مواعيد", "حجز"];

const RESCHEDULE_PHRASES = [
  "تغيير الموعد",
  "تعديل الموعد",
  "تبديل الموعد",
  "تحويل الموعد",
  "إعادة جدولة",
  "تأجيل الموعد",
  "معاد تاني",
  "وقت تاني",
];

const BOOKING_WORDS = [
  "حجز",
  "أحجز",
  "احجز",
  "موعد",
  "معاد",
  "ميعاد",
  "متابعة",
  "متابعه",
  "زيارة",
  "ازور",
  "أزور",
  "كشف",
  "أكشف",
  "اكشف",
];

const BOOKING_PHRASES = [
  "عايز موعد",
  "عايز أحجز",
  "عايز احجز",
  "عايز معاد",
  "أبي موعد",
  "موعد جديد",
  "حجز موعد",
  "عايز أزور",
  "عايز ازور",
  "عايز متابعة",
  "عايز متابعه",
  "حجز متابعة",
  "حجز متابعه",
  "موعد متابعة",
  "موعد متابعه",
  "ميعاد متابعة",
  "ميعاد متابعه",
  "عايز كشف",
  "عايزة كشف",
  "عايزه كشف",
  "حجز كشف",
  "كشف اسنان",
  "كشف أسنان",
  "كشف دكتور",
  "كشف طبي",
];

const AVAILABILITY_WORDS = [
  "متاح",
  "متاحين",
  "فاضي",
  "فاضية",
  "أوقات",
  "معادين",
  "مواعيد",
  "معاد",
  "ميعاد",
  "متى",
  "إمتى",
];

const AVAILABILITY_PHRASES = [
  "عندكم معاد",
  "عندكم ميعاد",
  "في معاد",
  "في ميعاد",
  "فيه معاد",
  "فيه ميعاد",
  "فيه حجز",
  "في حجز",
  "فيه مواعيد",
  "في مواعيد",
  "عندكم مواعيد",
  "أي وقت يناسب",
  "الأوقات المتاحة",
  "إمتى ممكن",
  "متى ممكن",
  "معاد النهاردة",
  "ميعاد النهاردة",
  "معاد بكرة",
  "ميعاد بكرة",
];

// GREETING (DECISIONS #61) — Arabic social openings. A greeting is the
// one conversational turn that is safely answerable WITHOUT any business
// knowledge: the reply acknowledges the customer and invites them to
// continue. It never names a service, price, slot, policy, or fact, so it
// crosses the disclosure boundary as a declared knowledge-free social
// protocol (the gate passes it by intent, never by inspecting text).
const GREETING_WORDS = [
  "اهلا",
  "أهلا",
  "مرحبا",
  "أهلاً",
  "السلام",
  "سلام",
  "صباح",
  "مساء",
  "هاي",
  "هلا",
  "ازيك",
  "اخبارك",
  "كيفك",
  "كيف حالك",
  "عامل",
];

const GREETING_PHRASES = [
  "السلام عليكم",
  "سلام عليكم",
  "صباح الخير",
  "مساء الخير",
  "صباح النور",
  "مساء النور",
  "اهلا وسهلا",
  "أهلاً وسهلاً",
  "ازيك يا",
  "عامل ايه",
  "عامل إيه",
  "اخبارك ايه",
  "كيف حالك",
  "كيفك يا",
];

/**
 * Egyptian/MSA greetings that ALSO carry a closed question (صباح/مساء +
 * الخير are the canonical forms). A bare "صباح" or "مساء" alone is NOT a
 * greeting — it is the start of a time-of-day question the classifier must
 * not swallow ("صباح الخير" yes, "صباح" alone no).
 */
const GREETING_TIME_WORDS = ["صباح", "مساء"];

/**
 * A BOUNDED, explicit allowance of harmless social-protocol phrases that may
 * accompany a recognized Arabic greeting WITHOUT turning the turn into a task
 * — the canonical religious benedictions that trail «السلام عليكم»
 * («ورحمة الله» / the full «ورحمة الله وبركاته»). These are purely social
 * openings: they name no service, price, slot, person, place, or fact and
 * carry no request, so a greeting that carries one is still a knowledge-free
 * social protocol (DECISIONS #61) and still costs zero provider calls.
 *
 * Deliberately PHRASE-level, never a bare token list, and deliberately tiny:
 * an entry explains ONLY its OWN tokens, and ONLY when the phrase actually
 * occurs in the turn. So «السلام عليكم، عايزك تحجزلي» keeps «تحجزلي» as
 * unexplained residual and falls through to the semantic path — the allowance
 * can never mask a second intent, because it claims nothing about any word it
 * did not itself bring.
 *
 * Widening this is an explicit, evidence-gated decision; it is NOT the growth
 * path for new dialects or new intents (the semantic path owns those).
 */
const GREETING_SOCIAL_ALLOWANCE = ["ورحمة الله", "ورحمة الله وبركاته"];

/** Small Egyptian/MSA stopword set (normalized) for FAQ token scoring. */
const STOPWORDS = new Set(
  [
    "ايه",
    "ما",
    "هو",
    "هي",
    "في",
    "من",
    "الي",
    "علي",
    "عن",
    "و",
    "او",
    "هل",
    "اي",
    "اديه",
    "بس",
    "لو",
    "مع",
    "عند",
    "كل",
    "انا",
    "انت",
    "انتي",
    "احنا",
    "هما",
    "بيتك",
    "ممكن",
    "عايز",
    "عايزة",
    "ابغي",
    "ابي",
    "ازاي",
    "ليه",
    "بتاع",
  ].map((word) => stripAffixes(normalizeArabicText(word))),
);

/**
 * Keywords run through the SAME pipeline as message tokens (normalize +
 * affix stripping) so forms like "ألغي" and "إلغاء" compare equal on both
 * sides despite the definite-article stripper.
 */
function tokenizedKeywords(words: string[]): string[] {
  return words
    .map((word) => {
      const token = tokenize(word)[0];
      return token ?? normalizeArabicText(word);
    })
    .filter(Boolean);
}

const HUMAN_WORDS_N = tokenizedKeywords(HUMAN_WORDS);
const HUMAN_TITLE_WORDS_N = tokenizedKeywords(HUMAN_TITLE_WORDS);
const HUMAN_REQUEST_CUES_N = HUMAN_REQUEST_CUES.map(normalizeArabicText);
const HUMAN_PHRASES_N = HUMAN_PHRASES.map(normalizeArabicText);
const SENSITIVE_WORDS_N = tokenizedKeywords(SENSITIVE_WORDS);
const SENSITIVE_PHRASES_N = SENSITIVE_PHRASES.map(normalizeArabicText);
const CANCELLATION_WORDS_N = tokenizedKeywords(CANCELLATION_WORDS);
const CANCELLATION_PHRASES_N = CANCELLATION_PHRASES.map(normalizeArabicText);
const RESCHEDULE_MUTATION_N = tokenizedKeywords(RESCHEDULE_MUTATION_WORDS);
const APPOINTMENT_PREFIXES_N = tokenizedKeywords(APPOINTMENT_PREFIXES);
const RESCHEDULE_PHRASES_N = RESCHEDULE_PHRASES.map(normalizeArabicText);
const BOOKING_WORDS_N = tokenizedKeywords(BOOKING_WORDS);
const BOOKING_PHRASES_N = BOOKING_PHRASES.map(normalizeArabicText);
const AVAILABILITY_WORDS_N = tokenizedKeywords(AVAILABILITY_WORDS);
const AVAILABILITY_PHRASES_N = AVAILABILITY_PHRASES.map(normalizeArabicText);
const GREETING_WORDS_N = tokenizedKeywords(GREETING_WORDS);
const GREETING_PHRASES_N = GREETING_PHRASES.map(normalizeArabicText);
const GREETING_TIME_WORDS_N = tokenizedKeywords(GREETING_TIME_WORDS);
const GREETING_SOCIAL_ALLOWANCE_N =
  GREETING_SOCIAL_ALLOWANCE.map(normalizeArabicText);

/**
 * Bare NON-COMMITTAL fragments ("مش عارف" / "I don't know", "مش متأكد" /
 * "not sure", "زي ما تشوفوا" / "whatever you think"). They carry NO actionable
 * content and name NO task. The resolver uses this signal to suppress an
 * UNNECESSARY CLARIFY (PROMPT-AI-EVAL-07 `st-ambiguous-idk`) in the EXACT
 * situation where there is nothing to clarify: a fragment with no pending
 * clarification and no active task. A non-committal reply TO a pending
 * clarification stays clarifiable — the conversation state, never this flag,
 * decides that (the resolver gates on `hasPendingTask`).
 */
const NON_COMMITTAL_PHRASES = [
  "مش عارف",
  "مش عارفة",
  "مش عارفه",
  "مش متأكد",
  "مش متأكدة",
  "مش متاكد",
  "زي ما تشوفوا",
  "زي ما تشوف",
  "زي ما تحب",
  "اللي تشوفوا",
];
const NON_COMMITTAL_PHRASES_N = NON_COMMITTAL_PHRASES.map(normalizeArabicText);

/**
 * The deterministic, authoritative control/safety classification of ONE
 * customer message — reused BY VALUE from the same keyword tables the
 * deterministic classifier already applies, so the LLM path and the
 * deterministic path can never diverge on safety. It introduces NO new
 * classifier and NO model inference: it is a pure, total projection of the
 * EXISTING sensitive / human / non-committal vocabulary.
 *
 * Why it exists (PROMPT-AI-EVAL-07): in the LLM path the model AUTHORS the
 * decision, so a safety-required turn can reach the engine WITHOUT the model
 * self-reporting `handoffReason: "SENSITIVE"` (EVAL-07 `ho-sensitive-medical`
 * reached CLARIFY_SERVICE + AI_ACTIVE). The resolver consults THIS signal so a
 * sensitive / explicit-human turn is handed off deterministically, regardless
 * of what the model proposed — safety precedence is authoritative, not
 * model-trusted.
 */
export type TurnControlSignals = {
  /** The turn carries sensitive / high-stakes language (safety precedence). */
  readonly sensitive: boolean;
  /** The customer explicitly asked for a human (explicit-human precedence). */
  readonly explicitHuman: boolean;
  /** A bare non-committal fragment with no task vocabulary (nothing to clarify). */
  readonly nonCommittal: boolean;
};

/**
 * The ONE authoritative semantic rule for a GENUINE EXPLICIT HUMAN REQUEST
 * (PROMPT-AI-SEM-02). Detection produces INDEPENDENT facts; the precedence
 * between them is owned HERE, exactly once, so `classifyCustomerMessage` and
 * `detectTurnControlSignals` — and any future model-supplied fact — can never
 * drift apart again.
 *
 * Evidence classes (independent facts, never precedence):
 *  - `supportRequest`: a support/staff role word or transfer phrase
 *    («موظف»، «وصلني بحد»). The customer asked to be connected to a person.
 *  - `providerRequest`: a provider/professional TITLE («دكتور»/«دكتورة»)
 *    PLUS a first-person request-to-speak cue («عايز»، «أكلم»). Naming the
 *    practitioner alone is provider identity; the cue is what makes it a
 *    request to actually REACH that person.
 *  - `bookingTask`: the turn carries a booking / availability / cancellation /
 *    reschedule task stem.
 *
 * Precedence (server-owned, deterministic):
 *
 *     explicitHuman = supportRequest OR (providerRequest AND NOT bookingTask)
 *
 * Why the booking mask is applied ONLY to the title path: inside a booking
 * request a provider mention («أي دكتور») is a PROVIDER PREFERENCE, so the
 * explicit-human precedence must not fire there («عايز أحجز مع دكتور» is an
 * ordinary booking). But a support-role request is a genuine explicit human
 * request in its own right — booking presence must NOT erase it, so
 * «وصلني بموظف عشان أحجز» is still the customer's own handoff. Encoding
 * `booking => not human` uniformly made the authoritative deterministic signal
 * lose the customer's request whenever a booking stem shared the turn, and the
 * classifier's un-gated title check simultaneously misfired a handoff on a
 * pure provider-preference booking — the two seams had drifted in opposite
 * directions. This is the single place that no longer happens.
 *
 * The shape is deliberately facts-plus-one-verdict so a future model (JEV) can
 * SUPPLY `humanRequested` / `providerPreference` / `booking` as facts while the
 * precedence formula stays server-authoritative here.
 */
export type ExplicitHumanRequest = {
  /** A support/staff role word or transfer phrase («موظف»، «وصلني بحد»). */
  readonly supportRequest: boolean;
  /** A provider/professional title PLUS a request-to-speak cue («أكلم الدكتور»). */
  readonly providerRequest: boolean;
  /** A booking / availability / cancellation / reschedule task stem is present. */
  readonly bookingTask: boolean;
  /** The canonical verdict: `supportRequest || (providerRequest && !bookingTask)`. */
  readonly explicitHuman: boolean;
};

/**
 * The ONE server-owned precedence derivation over the three independent
 * explicit-human facts (AI-SEM-02; extracted as a shared derivation by
 * PROMPT-AI-JEV-03B §2):
 *
 *     explicitHuman = supportRequest OR (providerRequest AND NOT bookingTask)
 *
 * Extracted so the lexical detector (`detectExplicitHumanRequest`, facts from
 * the keyword tables) and the semantic JEV strategy (facts from the JEV
 * decisions model) call the SAME server-owned derivation. The formula exists
 * exactly once in production; a lexical reading and a semantic reading can
 * never apply two different formulas to the same three facts. Pure, total,
 * zero model calls.
 */
export function explicitHumanFromFacts(facts: {
  readonly supportRequest: boolean;
  readonly providerRequest: boolean;
  readonly bookingTask: boolean;
}): boolean {
  return facts.supportRequest || (facts.providerRequest && !facts.bookingTask);
}

/**
 * The booking-task family fold: booking / availability / cancellation /
 * reschedule stems all mask the provider-title path in the precedence formula
 * (the same mask the lexical detector always applied as one OR). Extracted as
 * a shared derivation by PROMPT-AI-JEV-03B §2 so the semantic JEV strategy
 * folds its own four semantic family facts through the SAME function —
 * `bookingTask` means one thing on both paths. Pure, total, zero model calls.
 */
export function bookingTaskFromFamily(family: {
  readonly bookingRequested: boolean;
  readonly availabilityAsked: boolean;
  readonly cancellationRequested: boolean;
  readonly rescheduleAsked: boolean;
}): boolean {
  return (
    family.bookingRequested ||
    family.availabilityAsked ||
    family.cancellationRequested ||
    family.rescheduleAsked
  );
}

export function detectExplicitHumanRequest(
  message: string,
): ExplicitHumanRequest {
  const normalized = normalizeArabicText(message);
  const tokens = tokenize(message);
  const supportRequest =
    hasWord(tokens, HUMAN_WORDS_N) || hasPhrase(normalized, HUMAN_PHRASES_N);
  const providerRequest =
    hasWord(tokens, HUMAN_TITLE_WORDS_N) && hasRequestCue(normalized);
  const bookingTask = bookingTaskFromFamily({
    bookingRequested:
      hasWord(tokens, BOOKING_WORDS_N) ||
      hasPhrase(normalized, BOOKING_PHRASES_N),
    availabilityAsked:
      hasWord(tokens, AVAILABILITY_WORDS_N) ||
      hasPhrase(normalized, AVAILABILITY_PHRASES_N),
    cancellationRequested:
      hasWord(tokens, CANCELLATION_WORDS_N) ||
      hasPhrase(normalized, CANCELLATION_PHRASES_N),
    rescheduleAsked:
      hasWord(tokens, RESCHEDULE_MUTATION_N) ||
      hasPhrase(normalized, RESCHEDULE_PHRASES_N),
  });
  const explicitHuman = explicitHumanFromFacts({
    supportRequest,
    providerRequest,
    bookingTask,
  });
  return { supportRequest, providerRequest, bookingTask, explicitHuman };
}

export function detectTurnControlSignals(message: string): TurnControlSignals {
  const normalized = normalizeArabicText(message);
  const tokens = tokenize(message);
  const sensitive =
    hasWord(tokens, SENSITIVE_WORDS_N) ||
    hasPhrase(normalized, SENSITIVE_PHRASES_N);
  // The canonical explicit-human rule — the SAME predicate
  // `classifyCustomerMessage` applies, so the two seams cannot diverge.
  const human = detectExplicitHumanRequest(message);
  // Sensitive is NOT gated by the booking task: a medical booking with
  // «ألم شديد» is still a safety turn.
  // Non-committal ONLY when the fragment carries no other task / safety / human
  // vocabulary — a bare "I don't know" with nothing actionable to clarify.
  const nonCommittal =
    !sensitive &&
    !human.supportRequest &&
    !human.providerRequest &&
    !human.bookingTask &&
    hasPhrase(normalized, NON_COMMITTAL_PHRASES_N);
  return {
    sensitive,
    explicitHuman: human.explicitHuman,
    nonCommittal,
  };
}

export type ResolveTurnControlSignalsOptions = {
  currentMessage: string;
  routing: AiRoutingDecision;
  decision?: AiResponse | null;
  turnTelemetry?: AiTelemetry | null;
  isStructuredSemanticTurn?: boolean;
};

/**
 * Pure source-selection helper for turn control signals (CORE-03D2).
 *
 * Centralizes source-selection and contradiction rules:
 * 1. JEV semantic strategy owns signals when routing === "JEV" and valid JEV telemetry is present.
 * 2. Structured generative turns (isStructuredSemanticTurn === true):
 *    - A validated "safe" assessment replaces the broad lexical sensitive interpretation for that turn,
 *      provided there are no contradictions (decision.handoffReason !== "SENSITIVE" and no sensitive handoff goal).
 *    - A "sensitive" assessment escalates through the existing Planner (signals.sensitive = true).
 *    - An "uncertain" assessment must not execute booking and safely escalates (signals.sensitive = true).
 *    - A missing/undefined assessment on a structured turn must not be treated as safe and must not execute booking;
 *      it safely escalates (signals.sensitive = true).
 *    - Explicit human requests remain authoritatively governed by the deterministic lexical classifier.
 *    - Non-committal fragments remain governed by the lexical classifier.
 * 3. Legacy and non-structured turns fall back to the deterministic lexical detector (detectTurnControlSignals).
 */
export function resolveTurnControlSignals(
  options: ResolveTurnControlSignalsOptions,
): TurnControlSignals {
  const lexical = detectTurnControlSignals(options.currentMessage);

  // 1. JEV semantic ownership (CONV-CORE-02 / PROMPT-AI-JEV-03B §8)
  if (options.routing === "JEV") {
    const semantic = options.turnTelemetry?.jevDecision?.semantic?.signals;
    if (semantic) {
      return semantic;
    }
    return lexical;
  }

  // 2. Structured generative semantic turn ownership (CORE-03D2)
  if (options.isStructuredSemanticTurn && options.decision) {
    const decision = options.decision;
    const assessment = decision.safetyAssessment;

    // Contradiction detection: a safe top-level assessment cannot downgrade a required handoff
    const hasSensitiveContradiction =
      (decision.handoffReason as string) === "SENSITIVE" ||
      (decision.intent as string) === "SENSITIVE" ||
      (decision.goals != null &&
        decision.goals.some(
          (g) =>
            g.kind === "HANDOFF" &&
            (g.intent === "SENSITIVE" || g.requiredKnowledge === "SENSITIVE"),
        ));

    let sensitive: boolean;
    if (hasSensitiveContradiction) {
      // Contradictory output must not downgrade a required handoff
      sensitive = true;
    } else if (assessment === "safe") {
      // Validated no-sensitive assessment replaces broad lexical interpretation
      sensitive = false;
    } else if (assessment === "sensitive") {
      // Sensitive handling required
      sensitive = true;
    } else if (assessment === "uncertain") {
      // Uncertainty must not execute a booking; safely escalate
      sensitive = true;
    } else {
      // Missing or unrecognized assessment on structured turn: must NOT be treated as safe
      // and must NOT fall back to lexical absence to authorize execution.
      sensitive = true;
    }

    // Semantic intent ownership (CORE-CHOICE-02 & E12b signal authority reconciliation):
    // On structured turns with a valid decision, a model-derived human request
    // proposal cannot masquerade as a higher-authority explicit customer request
    // when effective sensitivity is active (which would otherwise bypass server-authoritative
    // safety precedence in TurnPlanner). When safe, semantic human request ownership is preserved.
    const hasModelHumanRequest =
      decision.intent === "HUMAN_REQUEST" ||
      decision.handoffReason === "HUMAN_REQUEST" ||
      (decision.goals != null &&
        decision.goals.some(
          (g) =>
            g.kind === "HANDOFF" &&
            (g.intent === "HUMAN_REQUEST" ||
              g.requiredKnowledge === "HUMAN_REQUEST"),
        ));

    const explicitHuman = !sensitive && hasModelHumanRequest;

    const hasAnyExtractionFact = Boolean(
      decision.extraction?.service ||
      decision.extraction?.provider ||
      decision.extraction?.date ||
      decision.extraction?.timePreference,
    );
    const hasDomainGoal = Boolean(
      decision.goals?.some(
        (g) => g.kind === "DOMAIN_ACTION" || g.intent === "BOOKING",
      ),
    );
    const nonCommittal =
      (decision.intent === "AMBIGUOUS" ||
        decision.handoffReason === "AMBIGUOUS") &&
      !hasAnyExtractionFact &&
      !hasDomainGoal;

    return {
      sensitive,
      explicitHuman,
      nonCommittal,
    };
  }

  // 3. Fallback: deterministic lexical detector
  return lexical;
}

// ─── Task relevance (deterministic, text-derived — never AI-derived) ────────

/**
 * Which task families the current turn makes relevant. The relevance flags are
 * derived deterministically from the turn's text — never by the AI (DECISIONS
 * #50). This is NOT the intent classifier above: it does not choose a
 * response, it only gates CONDITIONAL context facts (the context builder) and
 * the deterministic identity decision set (`isPureBusinessIdentityQuestion`).
 *
 * The derivation lives here, next to the other Arabic text-classification
 * primitives, so there is exactly ONE place the relevance vocabulary is
 * defined and every consumer (the context builder, the deterministic seam, the
 * knowledge-gap recorder) reads the SAME flags for the SAME text.
 */
export type TaskRelevance = {
  /** Booking / availability asks → the `availability` fact family. */
  readonly bookingOrAvailability: boolean;
  /** Cancellation / reschedule asks → the `cancellationPolicy` fact. */
  readonly cancellationOrReschedule: boolean;
  /** Provider-choice asks → the `providerPreference` fact. */
  readonly providerChoice: boolean;
  /** Contact / identity / location asks → the `whatsappNumber` fact. */
  readonly contactOrIdentity: boolean;
  /**
   * Business-identity asks ("ما اسمكم؟" / "انتو مين؟") → the PUBLIC
   * `business.name` disclosure family (PROMPT-AI-UX-02). The business name is
   * ALWAYS carried in the request for phrasing, but this flag gates the
   * aggregate disclosure family that may BACK a self-authored identity reply —
   * the same budget-gate pattern `serviceCatalog` uses for `service.name`.
   */
  readonly businessIdentity: boolean;
  /** Price / fee / cost asks → the service `price` fact (Slice 6). */
  readonly priceOrFee: boolean;
  /**
   * Business-profile asks ("tell me about you") → the PUBLIC `business.about`
   * fact (PROMPT-AI-ARCH-15 — Slice 6). Gated so an unrelated turn never
   * carries the business description.
   */
  readonly businessInfo: boolean;
  /**
   * Service-detail asks ("what does it include?") → the PUBLIC service
   * `description` fact (PROMPT-AI-ARCH-15 — Slice 6). Gated so a booking or
   * price-only turn never carries descriptive catalog copy.
   */
  readonly serviceInfo: boolean;
  /**
   * Service-catalog listing asks ("what services do you have?") → the PUBLIC
   * service-catalog `name` family (PROMPT-AI-OPS-20). Gated so ONLY a
   * catalog-listing turn arms the name disclosure family.
   */
  readonly serviceCatalog: boolean;
};

const BOOKING_OR_AVAILABILITY_WORDS = [
  "حجز",
  "احجز",
  "موعد",
  "معاد",
  "ميعاد",
  "متاح",
  "متاحين",
  "فاضي",
  "فاضيه",
  "فاضية",
  "أوقات",
  "اوقات",
  "متى",
  "إمتى",
  "امتى",
];

const CANCELLATION_OR_RESCHEDULE_WORDS = [
  "إلغاء",
  "الغاء",
  "ألغي",
  "الغي",
  "كنسل",
  "تغيير",
  "تأجيل",
  "تاجيل",
  "تعديل",
  "تبديل",
  "تحويل",
  "إعادة",
  "اعادة",
];

const PROVIDER_CHOICE_WORDS = [
  "دكتور",
  "دكتورة",
  "دكتوره",
  "طبيب",
  "طبيبة",
  "طبيبه",
  "أخصائي",
  "اخصائي",
  "أخصائيه",
  "مزود",
  "أي",
  "اي",
];

const CONTACT_OR_IDENTITY_WORDS = [
  "رقم",
  "هاتف",
  "واتس",
  "واتساب",
  "تواصل",
  "كلمني",
  "كلموني",
  "العنوان",
  "عنوان",
  "مكان",
  "أين",
  "اين",
  "وين",
];

/**
 * Business-identity vocabulary (PROMPT-AI-UX-02). Matches asks about the
 * business's OWN identity — "what is your name?", "who are you?" — so the
 * PUBLIC `business.name` disclosure family is armed ONLY on those turns.
 * Deliberately a tight, identity-only set: it does not match a booking, price,
 * location, or catalog ask, so the disclosure backstop stays intact for every
 * other question (an unbacked answer on those turns is still refused).
 */
const BUSINESS_IDENTITY_WORDS = [
  "اسم", // اسم / اسمك / اسمكم / اسمها / الاسم (name)
  "مين", // مين / مينكم — "who": «انتو مين؟»
  "انتو", // انتو / إنتو — "you (plural)"
  "عرفني", // «عرفني بنفسك»
  "نفسك", // «عرفني بنفسك»
  "name", // mixed-language "what is your name"
];

/**
 * Price / fee / cost vocabulary (Slice 6). Egyptian colloquial + MSA + the
 * common Arabizi/English "price". Matched against normalized tokens by exact
 * equality OR prefix (so "سعر" catches "سعره"/"سعرها", "تكلف" catches
 * "تكلفه"/"بتكلف"). Deliberately bounded — it gates ONLY the CONDITIONAL
 * exposure of an already-stored price; it never invents one.
 */
const PRICE_OR_FEE_WORDS = [
  "كام", // بكام / كام — "how much"
  "بكام",
  "بكم",
  "سعر", // سعر / سعره / سعرها / السعر
  "اسعار", // أسعار / الأسعار (hamza normalized to ا)
  "الاسعار",
  "تكلف", // تكلفة / التكلفة / بتكلف / يكلف
  "التكلفه",
  "تمن", // ثمن (normalized) / التمن
  "فلوس",
  "price",
  "prices",
  "pricing",
  "cost",
];

/**
 * Business-profile vocabulary (PROMPT-AI-ARCH-15 — Slice 6). Matches asks that
 * are ABOUT the business itself ("tell me about you", "how old are you",
 * "how many branches") so the PUBLIC `business.about` fact is carried only on
 * those turns. Deliberately excludes generic service words (`خدمة`/`خدمات`)
 * and location words — those stay on their own existing channels.
 */
const BUSINESS_INFO_WORDS = [
  "نبذه", // نبذة / النبذة (ta-marbuta normalized to ه)
  "احكيلي", // احكيلي عن العيادة
  "قصه", // قصة / القصة
  "تابعه", // تابعة / تابعين
  "فروع", // فروع / الفروع
  "فرع", // فرع / الفرع
  "تخصص", // تخصص / التخصص
  "شغالين", // "من كم سنة أنتم شغالين"
  "about", // mixed-language "about you"
];

/**
 * Service-detail vocabulary (PROMPT-AI-ARCH-15 — Slice 6). Matches asks for
 * what a service INCLUDES / how it is carried out, so the PUBLIC service
 * `description` is carried only on service-info turns. A plain service NAME
 * mention is NOT enough (that is discovery/booking), and a price ask is NOT
 * enough (price has its own channel) — so a booking or price turn never gains
 * descriptive copy.
 */
const SERVICE_INFO_WORDS = [
  "بتشمل", // "الخدمة دي بتشمل ايه؟"
  "بيشمل", // بيشمل / بيشملوا
  "تشمل",
  "يشمل",
  "شامل", // شامل
  "خطوات", // خطواته / الخطوات
  "بيمشي", // بيمشي إزاي
  "بيتعمل", // بيعملوا فيه إيه / بيتعمل إزاي
  "يتعمل",
  "بيعمل", // بيعملوا فيه إيه
  "بتعمل", // بتعملوا فيه إيه
  "بترمم", // الحشو بيترمم إزاي
  "بيترمم",
  "تفاصيل", // تفاصيل / التفاصيل
  "include", // mixed-language "what does it include"
  "includes",
  "details",
  "detail",
];

/**
 * Service-catalog listing vocabulary (PROMPT-AI-OPS-20). Matches asks for the
 * CATALOG ITSELF ("what services do you have?") so the PUBLIC service-name
 * disclosure family is armed only on those turns. Deliberately a tight,
 * catalog-only set: it does NOT match a price ask (its own channel), a
 * service-detail ask (`SERVICE_INFO_WORDS`), or a booking ask — and it does
 * not match location/hours/about questions, which is what keeps a
 * self-authored reply on those topics unbacked and refused.
 */
const SERVICE_CATALOG_WORDS = [
  "خدمه", // خدمة / الخدمة (ta-marbuta normalized to ه)
  "الخدمه",
  "خدمات", // خدمات / الخدمات
  "الخدمات",
  "خدماتكم", // "ايه الخدمات اللي عندكم"
  "خدماتنا",
  "service", // mixed-language
  "services",
];

/**
 * Deterministic relevance derivation from the customer message (Arabic
 * normalized + light morphology, same pipeline the classifier uses for
 * text). Pure: same input ⇒ same output, no I/O, no LLM.
 *
 * The price gate additionally runs the token through the existing Slice-1 F1
 * `stripAffixes` seam so a price word carrying the Egyptian conjunction «و»
 * clitic is recognized («وبكام» → «كام»). Scoped to the price family only —
 * the other relevance families keep their exact previous matching, so the
 * remediation does not widen task-gated exposure beyond the concrete
 * EVAL-15R price-relevance edge case.
 */
export function deriveTaskRelevance(message: string): TaskRelevance {
  const normalized = normalizeArabicText(message);
  const tokens = normalized.split(" ").filter(Boolean);
  const priceTokens = tokens.map(stripAffixes);
  const matches = (
    words: ReadonlyArray<string>,
    candidates: ReadonlyArray<string> = tokens,
  ): boolean =>
    candidates.some((token) =>
      words.some((word) => {
        if (word === "اي" || word === "أي") return token === word;
        return token === word || token.startsWith(word);
      }),
    );
  return {
    bookingOrAvailability: matches(BOOKING_OR_AVAILABILITY_WORDS),
    cancellationOrReschedule: matches(CANCELLATION_OR_RESCHEDULE_WORDS),
    providerChoice: matches(PROVIDER_CHOICE_WORDS),
    contactOrIdentity: matches(CONTACT_OR_IDENTITY_WORDS),
    businessIdentity: matches(BUSINESS_IDENTITY_WORDS),
    priceOrFee: matches(PRICE_OR_FEE_WORDS, priceTokens),
    businessInfo: matches(BUSINESS_INFO_WORDS),
    serviceInfo: matches(SERVICE_INFO_WORDS),
    serviceCatalog: matches(SERVICE_CATALOG_WORDS),
  };
}

// ─── Reply / summary templates (assistant voice, vertical-agnostic) ─────────

/**
 * Safe, deterministic handoff & failure reply constants (Arabic-first).
 * Sourced byte-for-byte from canonical product voice (REPLIES / HANDOFF_MESSAGES / COPY_REGISTRY).
 * Runtime seam: used on structured turns to replace lexical re-classification
 * of customer text when choosing a safe fallback message.
 */
export const SAFE_HANDOFF_REPLIES = {
  HUMAN_REQUEST: "تحت أمرك — تم تحويل المحادثة لفريق العمل للمتابعة.",
  SENSITIVE: "سنعتني بطلبك — تم تحويل المحادثة لفريق العمل للمتابعة.",
  PROVIDER_FAILURE:
    "واجهت صعوبة مؤقتة في الرد — تم تحويل المحادثة لفريق العمل للمتابعة.",
  INVALID_OUTPUT: "سنعتني بطلبك — تم تحويل المحادثة لفريق العمل للمتابعة.",
  DISCLOSURE_REFUSED: "شكراً لسؤالك — تم تحويل استفسارك لفريق العمل للمتابعة.",
} as const;

export type SafeFailureReplyInput = {
  controlHandoffReason?: ControlHandoffReason | null;
  failureCause?: HandoffCause | null;
};

/**
 * Pure resolver mapping typed execution failure outcomes to safe canonical replies.
 * Never inspects or re-interprets customer prose with regex or keyword dictionaries.
 */
export function resolveSafeFailureReply(input: SafeFailureReplyInput): string {
  const reason = input.controlHandoffReason;
  if (reason === "CUSTOMER_REQUESTED_HUMAN") {
    return SAFE_HANDOFF_REPLIES.HUMAN_REQUEST;
  }
  if (reason === "SENSITIVE_OR_RESTRICTED_REQUEST") {
    return SAFE_HANDOFF_REPLIES.SENSITIVE;
  }
  if (
    reason === "PROVIDER_UNAVAILABLE" ||
    reason === "RETRY_EXHAUSTED" ||
    reason === "QUOTA_EXHAUSTED" ||
    reason === "AUTH_OR_CONFIGURATION_FAILURE" ||
    input.failureCause === "PROVIDER_FAILURE" ||
    input.failureCause === "RETRY_EXHAUSTED"
  ) {
    return SAFE_HANDOFF_REPLIES.PROVIDER_FAILURE;
  }
  return SAFE_HANDOFF_REPLIES.INVALID_OUTPUT;
}

/**
 * Canonical customer-facing reply for authoritative action=handoff decisions.
 * Guarantees that model-generated handoff prose cannot invent immediate SLAs
 * or false contact promises.
 */
export function resolveHandoffActionReply(
  reason: ContractHandoffReason | null,
): string {
  switch (reason) {
    case "HUMAN_REQUEST":
      return SAFE_HANDOFF_REPLIES.HUMAN_REQUEST;
    case "SENSITIVE":
      return SAFE_HANDOFF_REPLIES.SENSITIVE;
    case "NO_KNOWLEDGE":
      return REPLIES.NO_KNOWLEDGE;
    case "AMBIGUOUS":
      return REPLIES.AMBIGUOUS;
    default:
      return SAFE_HANDOFF_REPLIES.DISCLOSURE_REFUSED;
  }
}

const REPLIES = {
  BOOKING:
    "يسعدنا خدمتك! سيتواصل معك أحد أعضاء الفريق لإتمام الحجز وتحديد الوقت المناسب.",
  AVAILABILITY:
    "شكراً لسؤالك — سيرسل لك أحد أعضاء الفريق الأوقات المتاحة قريباً.",
  RESCHEDULE: "بالطبع — سيتولى أحد أعضاء الفريق تعديل موعدك والتواصل معك.",
  CANCELLATION: "تمام — سيتواصل معك أحد أعضاء الفريق لإتمام إلغاء الموعد.",
  HUMAN_REQUEST: "تحت أمرك — تم تحويل المحادثة لفريق العمل للمتابعة.",
  SENSITIVE: "سنعتني بطلبك — تم تحويل المحادثة لفريق العمل للمتابعة.",
  NO_KNOWLEDGE: "شكراً لسؤالك — تم تحويل استفسارك لفريق العمل للمتابعة.",
  AMBIGUOUS: "لم أفهم طلبك تماماً — تم تحويل المحادثة لفريق العمل للمساعدة.",
} as const;

const BOOKING_SUMMARIES = {
  BOOKING: "طلب العميل حجز موعد جديد",
  AVAILABILITY: "استفسر العميل عن الأوقات المتاحة",
  RESCHEDULE: "طلب العميل تعديل موعده",
  CANCELLATION: "طلب العميل إلغاء موعده",
} as const;

// ─── FAQ matching ────────────────────────────────────────────────────────────

/**
 * The tokens the greeting vocabulary ITSELF accounts for — the positive
 * coverage basis for the closed-world pure-greeting proof below.
 *
 * Derived exclusively from the SAME greeting tables the detection uses
 * (`GREETING_WORDS` + the `GREETING_PHRASES` that actually occur in the turn),
 * so it is never a parallel dictionary and can never drift from the detection:
 * any token the greeting detector claimed is, by construction, explained here.
 *
 * Coverage uses the SAME light-morphology rule `hasWord` applies (exact, or a
 * prefix of a stem ≥ 3 chars), so the proof never contradicts the detection.
 * Phrase constituents are explained ONLY for a phrase that actually matched
 * the turn — that match is the positive evidence that the trailing noun
 * («الخير» / «النور» / «عليكم») belongs to the recognized social opening and
 * is not a second, unexplained intent.
 */
function greetingExplainedTokens(
  normalized: string,
  tokens: string[],
): Set<string> {
  const explained = new Set<string>();
  const cover = (stem: string): void => {
    for (const token of tokens) {
      if (token === stem || (stem.length >= 3 && token.startsWith(stem))) {
        explained.add(token);
      }
    }
  };
  for (const word of GREETING_WORDS) {
    for (const stem of tokenize(word)) cover(stem);
  }
  for (const phrase of GREETING_PHRASES_N) {
    if (!normalized.includes(phrase)) continue;
    for (const stem of tokenize(phrase)) cover(stem);
  }
  return explained;
}

/**
 * The whole meaningful utterance is a PURE social opening (DECISIONS #61).
 *
 * CLOSED-WORLD POSITIVE PROOF (PROMPT-AI-SEM-01): a deterministic greeting
 * bypass is allowed ONLY when the complete meaningful turn is POSITIVELY
 * proven to belong to the safe greeting family. Greeting vocabulary alone is
 * NOT sufficient — the turn may ALSO carry a second intent the tables do not
 * know. So after the greeting is recognized, every remaining MEANINGFUL token
 * must be accounted for, either by the greeting vocabulary itself or by the
 * bounded harmless-social allowance above. Any unexplained residual means the
 * turn is NOT a pure greeting and this returns false, yielding the turn to the
 * existing semantic/generative path.
 *
 * This is fail-open-to-SEMANTICS, not fail-open-to-handoff: unknown language
 * is never treated as proof that no second intent exists. «السلام عليكم
 * عايزك تحجزلي» recognizes the greeting but cannot explain «تحجزلي», so it is
 * NOT answered as a greeting; the single existing model call sees it instead.
 * The product then grows across phrasings, dialects, and languages WITHOUT a
 * dictionary of every possible booking expression.
 *
 * A greeting is the one conversational turn safely answerable without business
 * knowledge, so a PROVEN pure greeting crosses the disclosure boundary as a
 * declared knowledge-free social protocol (the gate passes it by intent, never
 * by inspecting text) and costs zero provider calls.
 *
 * A bare time-of-day noun (صباح / مساء) is deliberately NOT a greeting — the
 * canonical forms are the phrases (صباح الخير / مساء الخير), so a one-word
 * «صباح» falls through to the normal path rather than being answered as one.
 */
function isPureGreeting(
  message: string,
  normalized: string,
  tokens: string[],
): boolean {
  const hasGreetingPhrase = GREETING_PHRASES_N.some((phrase) =>
    normalized.includes(phrase),
  );
  const hasGreetingWord = hasWord(tokens, GREETING_WORDS_N);
  if (!hasGreetingPhrase && !hasGreetingWord) return false;
  // A question mark means the turn is asking something, not opening a
  // conversation — never answer it as a greeting. (The normalized form
  // strips punctuation, so the RAW message is the only reliable signal.)
  if (message.includes("؟") || message.includes("?")) return false;
  // A lone time-of-day noun is not a greeting on its own.
  if (
    !hasGreetingPhrase &&
    tokens.length === 1 &&
    GREETING_TIME_WORDS_N.includes(tokens[0]!)
  ) {
    return false;
  }
  // THE CLOSED-WORLD TEST: every meaningful token must be positively accounted
  // for by the recognized greeting itself (or the bounded social allowance).
  // Anything the greeting vocabulary cannot explain is a possible second
  // intent — including vocabulary no table here has ever listed — so the turn
  // is not proven pure and the semantic path owns it.
  const explained = greetingExplainedTokens(normalized, tokens);
  if (explained.size === 0) return false;
  const allowance = new Set<string>();
  for (const phrase of GREETING_SOCIAL_ALLOWANCE_N) {
    if (!normalized.includes(phrase)) continue;
    for (const token of tokenize(phrase)) allowance.add(token);
  }
  return tokens.every((token) => explained.has(token) || allowance.has(token));
}

/**
 * The etiquette ACKNOWLEDGEMENT for a recognized greeting family
 * (PROMPT-AI-UX-03B). A greeting is a knowledge-free social protocol, so its
 * acknowledgement names no business fact, service, price, slot, or policy —
 * exactly the same disclosure boundary the previous generic greeting crossed.
 * It is chosen DETERMINISTICALLY from the SAME normalized vocabulary that
 * recognizes the greeting, so the classifier and the LLM bypass can never
 * disagree on the wording. The salam, morning, and evening openings have a
 * fixed culturally-expected reply; every other recognized opening falls back
 * to «أهلاً بك».
 */
function greetingAcknowledgement(normalized: string, tokens: string[]): string {
  if (
    normalized.includes("السلام عليكم") ||
    normalized.includes("سلام عليكم") ||
    tokens.includes("سلام")
  ) {
    return "وعليكم السلام ورحمة الله وبركاته";
  }
  if (normalized.includes("صباح")) return "صباح النور";
  if (normalized.includes("مساء")) return "مساء النور";
  return "أهلاً بك";
}

/** The ONE knowledge-free invite appended after a greeting acknowledgement. */
const GREETING_INVITE =
  "أنا مساعدك للحجز والمواعيد — كيف يمكنني مساعدتك اليوم؟";

/** The complete deterministic GREETING copy for one recognized opening. */
function buildGreetingContent(message: string): string {
  const normalized = normalizeArabicText(message);
  const tokens = tokenize(message);
  return `${greetingAcknowledgement(normalized, tokens)}! ${GREETING_INVITE}`;
}

/**
 * The ONE GREETING response shared by the deterministic classifier and the
 * LLM bypass (`bypassDeterministicAi`). Both call THIS function, so they can
 * never diverge on the greeting wording. It stays a `reply` (never a handoff),
 * names no business knowledge, and keeps the thread AI_ACTIVE.
 */
function greetingResponse(message: string): AiResponse {
  return {
    action: "reply",
    intent: "GREETING",
    content: buildGreetingContent(message),
    extraction: emptyAiExtraction,
    handoffReason: null,
    summary: null,
  };
}

// ─── Business identity (PROMPT-AI-UX-04B) ───────────────────────────────────

/**
 * The deterministic BUSINESS-IDENTITY reply — the smallest correct fix for the
 * proven LLM-hedging failure on a direct identity question
 * (PROMPT-AI-UX-04A forensics): the LLM was writing hedge/handoff wording
 * («الاسم المسجل عندي هو…» / «بحسب البيانات الموجودة») for a turn the
 * repository ALREADY answers authoritatively, and no downstream layer rewrites
 * provider text. So the turn is answered deterministically, exactly like a
 * pure greeting, BEFORE any provider is consulted.
 *
 * The reply is a FIXED, confident, Egyptian-natural acknowledgement built from
 * the ONE authoritative fact the turn is about: `request.businessName`
 * (Business.name, proven + carried by the context builder). It names NOTHING
 * the business did not store — no owner, specialty, license, accreditation or
 * legal/official-status claim — and it invites the customer to continue. It
 * crosses the disclosure boundary as a self-authored `reply` on the existing
 * `business.identity` channel (intent FAQ → the gate's identity candidate
 * family), so the gate's backstop stays fully in force: an identity reply is
 * emitted ONLY when the name is actually carried, and a non-identity turn can
 * never lean on it.
 *
 * Determinism is the point: the wording never varies with the provider, the
 * model, the catalog or the knowledge store, so the customer always meets the
 * same confident voice — zero provider calls, one send, AI_ACTIVE.
 */
const IDENTITY_INVITE = "تحب نساعدك إزاي؟";

/** The complete deterministic identity copy for one authoritative name. */
export function buildBusinessIdentityContent(businessName: string): string {
  return `أيوه، ${businessName} معاك. ${IDENTITY_INVITE}`;
}

/** Server-authoritative rendering for business address (ISS-012). */
export function buildBusinessAddressContent(address: string): string {
  return `عنواننا: ${address.trim()}.`;
}

/** Server-authoritative rendering for business about description (ISS-012). */
export function buildBusinessAboutContent(about: string): string {
  return about.trim();
}

/** Server-authoritative rendering for service price (ISS-012). */
export function buildServicePriceContent(
  serviceName: string,
  price: string,
): string {
  return `سعر ${serviceName.trim()}: ${price.trim()}.`;
}

/** Server-authoritative rendering for service description (ISS-012). */
export function buildServiceDescriptionContent(
  serviceName: string,
  description: string,
): string {
  return `${serviceName.trim()}: ${description.trim()}.`;
}

/** Server-authoritative rendering for service catalog list (ISS-012). */
export function buildServiceCatalogContent(
  services: ReadonlyArray<{ name: string }>,
): string {
  const names = services.map((s) => s.name.trim()).filter((n) => n.length > 0);
  return `نقدم الخدمات التالية: ${names.join("، ")}.`;
}

/**
 * The deterministic identity reply. `intent: "FAQ"` is the established
 * contract label for an identity answer (the same intent the provider prompt
 * uses), so the disclosure gate backs it from the `business.identity` family
 * and the resolver classifies it as a plain ANSWER.
 */
function businessIdentityResponse(businessName: string): AiResponse {
  return {
    action: "reply",
    intent: "FAQ",
    content: buildBusinessIdentityContent(businessName),
    extraction: emptyAiExtraction,
    handoffReason: null,
    summary: null,
  };
}

/**
 * Is this turn a PURE business-identity question — an ask (or a confirmation
 * ask) about the business's OWN identity, with no other task in play?
 *
 * Reuses the ONE relevance derivation (`deriveTaskRelevance`) the context
 * builder runs on the same text, so the deterministic decision set and the
 * disclosure ledger's `business.identity` arming can never disagree: this
 * fires ONLY when the turn arms `businessIdentity` (which is what gates the
 * name disclosure family), and it yields to EVERY other task family. No new
 * classifier, no new vocabulary, no second inference — a pure projection of
 * the existing tables.
 *
 * MULTI-INTENT RULE (binding): a mixed turn stays on the generative path. A
 * message that also arms booking/availability, cancellation/reschedule,
 * provider-choice, contact/location, price, business-profile, service-detail
 * or service-catalog vocabulary is NOT a pure identity turn — the existing
 * multi-intent path keeps it so the assistant can confirm the identity AND
 * continue the other task (answer-and-continue). This branch therefore never
 * swallows a real task.
 *
 * Note on `providerChoice`: its vocabulary («دكتور»/«دكتورة»/«أي») is part of
 * many businesses' NAMES («هو انتو عيادة الدكتورة أفنان؟»). The relevance
 * derivation only matches the BARE title (the definite-article form does not
 * arm it), and a turn that arms provider-choice still yields here — it stays
 * on the generative path rather than risk answering a provider-choice turn as
 * a pure identity confirmation.
 */
function isPureBusinessIdentityQuestion(message: string): boolean {
  const relevance = deriveTaskRelevance(message);
  if (!relevance.businessIdentity) return false;
  return !(
    relevance.bookingOrAvailability ||
    relevance.cancellationOrReschedule ||
    relevance.providerChoice ||
    relevance.contactOrIdentity ||
    relevance.priceOrFee ||
    relevance.businessInfo ||
    relevance.serviceInfo ||
    relevance.serviceCatalog
  );
}

/**
 * PURE SERVICE-CATALOG ASKS ("ايه الخدمات اللي عندكم؟" / "الخدمات المتاحة").
 * Matches when the turn asks about services without carrying another task intent.
 */
export function isPureServiceCatalogQuestion(message: string): boolean {
  const relevance = deriveTaskRelevance(message);
  if (!relevance.serviceCatalog) return false;
  if (
    relevance.bookingOrAvailability ||
    relevance.cancellationOrReschedule ||
    relevance.providerChoice ||
    relevance.contactOrIdentity ||
    relevance.priceOrFee ||
    relevance.businessIdentity
  ) {
    return false;
  }
  const norm = normalizeArabicText(message);
  return /(?:ايه|إيه|ما\s+هي|ماهي|عرض|قائمة|قائمه|كل|جميع|عايز\s+اعرف|ممكن\s+اعرف)\s+(?:ال)?خدمات|خدماتكم|الخدمات\s+(?:المتاحة|المتاحه|الموجودة|الموجوده|المتوفرة|المتوفره|المقدمة|المقدمه)|عندكم\s+خدمات|خدمات\s+ايه|اسعار\s+الخدمات|service\s+catalog|what\s+services|available\s+services/i.test(
    norm,
  );
}

export function formatServiceCatalogContent(
  businessName: string,
  services: ReadonlyArray<{
    name: string;
    durationMinutes?: number;
    price?: string | null;
  }>,
): string {
  const lines = services.map((s, idx) => {
    const duration = s.durationMinutes ? ` (${s.durationMinutes} دقيقة)` : "";
    const price = s.price ? ` — ${s.price}` : "";
    return `${idx + 1}. ${s.name}${duration}${price}`;
  });
  const header =
    businessName && businessName.trim().length > 0
      ? `الخدمات المتاحة لدينا في ${businessName.trim()}:`
      : `الخدمات المتاحة لدينا:`;
  return `${header}\n${lines.join("\n")}\n\nلحجز أي خدمة، أخبرنا باسم الخدمة أو رقمها وسنساعدك في اختيار الموعد المناسب.`;
}

/** Distinctive-token overlap score between a message and an FAQ question. */
function faqMatchScore(
  messageTokens: string[],
  questionTokens: string[],
): number {
  const questionSet = new Set(questionTokens);
  let shared = 0;
  for (const token of new Set(messageTokens)) {
    if (questionSet.has(token)) shared += 1;
  }
  return shared;
}

/**
 * Best FAQ match: at least 2 shared distinctive tokens, or at least half
 * of a short question's tokens. Ties keep the earliest entry.
 */
function matchFaq(
  messageTokens: string[],
  faqs: ReadonlyArray<{ question: string; answer: string }>,
): { question: string; answer: string } | null {
  let best: { question: string; answer: string } | null = null;
  let bestScore = 0;
  for (const entry of faqs) {
    const questionTokens = tokenize(entry.question);
    if (questionTokens.length === 0) continue;
    const score = faqMatchScore(messageTokens, questionTokens);
    const threshold =
      questionTokens.length <= 2
        ? questionTokens.length
        : Math.max(2, Math.ceil(questionTokens.length / 2));
    if (score >= threshold && score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  return best;
}

// ─── The deterministic assistant ─────────────────────────────────────────────

/**
 * Deterministic, provider-independent extraction of FACTS: a service
 * name is returned only when the message contains it verbatim
 * (normalized). Dates, times, and provider preferences are never
 * guessed — they stay null for the domain to resolve.
 */
export function extractServiceFacts(
  message: string,
  services: ReadonlyArray<{ name: string }>,
): string | null {
  const normalized = normalizeArabicText(message);
  if (!normalized) return null;
  const messageTokens = new Set(normalized.split(" ").filter(Boolean));

  for (const service of services) {
    const name = normalizeArabicText(service.name);
    if (name.length > 0 && normalized.includes(name)) {
      return service.name;
    }
  }

  const matches: Array<{ name: string }> = [];
  for (const service of services) {
    const hay = normalizeArabicText(service.name);
    if (hay.length === 0) continue;
    const tokens = hay
      .split(" ")
      .filter(
        (t) => t.length >= 3 && t !== "اسنان" && t !== "طبي" && t !== "عياده",
      );
    if (tokens.some((t) => messageTokens.has(t))) {
      matches.push(service);
    }
  }

  if (matches.length === 1) {
    return matches[0]!.name;
  }
  return null;
}

/**
 * Pure classification of one customer message into a structured AI
 * response (PROMPT-ARCH-02 contract). Exported for verification;
 * production callers go through `deterministicConversationAi.respond`.
 */
export function classifyCustomerMessage(
  message: string,
  faqs: ReadonlyArray<{ question: string; answer: string }>,
): AiResponse {
  const normalized = normalizeArabicText(message);
  const tokens = tokenize(message);

  // Too short to understand → ambiguous, never a guess.
  if (normalized.length < 2 || tokens.length === 0) {
    return {
      action: "handoff",
      intent: "AMBIGUOUS",
      content: REPLIES.AMBIGUOUS,
      extraction: emptyAiExtraction,
      handoffReason: "AMBIGUOUS",
      summary: null,
    };
  }

  // Explicit human request first — the customer's own handoff. This runs
  // BEFORE the pure-greeting branch so a greeting can never swallow an
  // explicit human request (F1 safety precedence, TARGET_ARCHITECTURE
  // Slice 1): "أهلاً، وصلني بموظف" is a HUMAN_REQUEST, not a GREETING. The
  // tokenizer strips the «بـ» clitic so «بموظف» matches «موظف», and the
  // «وصلني بحد» transfer phrase is recognized explicitly.
  //
  // The verdict comes from the ONE canonical predicate
  // (`detectExplicitHumanRequest`) — the SAME rule
  // `detectTurnControlSignals` applies — so the classifier and the
  // authoritative deterministic signal can never disagree (PROMPT-AI-SEM-02).
  // A support-role request wins even inside a booking turn (booking presence
  // must not erase it), while a provider TITLE only hands off when the turn
  // is NOT a booking/availability/cancellation/reschedule request — there the
  // title is a provider PREFERENCE («عايز أحجز مع دكتور» → BOOKING).
  if (detectExplicitHumanRequest(message).explicitHuman) {
    return {
      action: "handoff",
      intent: "HUMAN_REQUEST",
      content: REPLIES.HUMAN_REQUEST,
      extraction: emptyAiExtraction,
      handoffReason: "HUMAN_REQUEST",
      summary: null,
    };
  }

  // GREETING (DECISIONS #61) — a pure social opening is answered
  // deterministically and stays AI_ACTIVE. It runs AFTER the safety
  // intents (an explicit human request above; sensitive language below) and
  // BEFORE booking/FAQ: a real booking or knowledge turn carries meaningful
  // tokens the greeting vocabulary cannot explain, so the closed-world proof
  // in `isPureGreeting` yields it to this branch instead of answering it as a
  // greeting (see `isPureGreeting`). This branch never spends an LLM call.
  if (isPureGreeting(message, normalized, tokens)) {
    return greetingResponse(message);
  }

  // Sensitive / high-stakes language — staff, immediately.
  if (
    hasWord(tokens, SENSITIVE_WORDS_N) ||
    hasPhrase(normalized, SENSITIVE_PHRASES_N)
  ) {
    return {
      action: "handoff",
      intent: "AMBIGUOUS",
      content: REPLIES.SENSITIVE,
      extraction: emptyAiExtraction,
      handoffReason: "SENSITIVE",
      summary: null,
    };
  }

  // Cancellation — modifies an existing booking: staff decides.
  if (
    hasWord(tokens, CANCELLATION_WORDS_N) ||
    hasPhrase(normalized, CANCELLATION_PHRASES_N)
  ) {
    return {
      action: "booking_handoff",
      intent: "CANCELLATION",
      content: REPLIES.CANCELLATION,
      extraction: emptyAiExtraction,
      handoffReason: null,
      summary: BOOKING_SUMMARIES.CANCELLATION,
    };
  }

  // Reschedule — mutation word + appointment word, or an explicit phrase.
  const mentionsAppointment = tokens.some((token) =>
    APPOINTMENT_PREFIXES_N.some(
      (prefix) => token === prefix || token.startsWith(prefix),
    ),
  );
  if (
    hasPhrase(normalized, RESCHEDULE_PHRASES_N) ||
    (hasWord(tokens, RESCHEDULE_MUTATION_N) && mentionsAppointment)
  ) {
    return {
      action: "booking_handoff",
      intent: "RESCHEDULE",
      content: REPLIES.RESCHEDULE,
      extraction: emptyAiExtraction,
      handoffReason: null,
      summary: BOOKING_SUMMARIES.RESCHEDULE,
    };
  }

  // Booking intent — staff complete it through the existing booking flow.
  // Booking signals win over FAQ so a booking request is never swallowed
  // by a knowledge answer.
  if (
    hasWord(tokens, BOOKING_WORDS_N) ||
    hasPhrase(normalized, BOOKING_PHRASES_N)
  ) {
    return {
      action: "booking_handoff",
      intent: "BOOKING",
      content: REPLIES.BOOKING,
      extraction: emptyAiExtraction,
      handoffReason: null,
      summary: BOOKING_SUMMARIES.BOOKING,
    };
  }

  // Strong stored-knowledge match answers from Business.faqs — verbatim.
  const faq = matchFaq(tokens, faqs);
  if (faq) {
    return {
      action: "reply",
      intent: "FAQ",
      content: faq.answer,
      extraction: emptyAiExtraction,
      handoffReason: null,
      summary: null,
      requiredKnowledge: "business.faqs",
      sourceId: (faq as { id?: string }).id ?? faq.question,
    };
  }

  // Availability — real slots come from the availability engine, so staff.
  if (
    hasWord(tokens, AVAILABILITY_WORDS_N) ||
    hasPhrase(normalized, AVAILABILITY_PHRASES_N)
  ) {
    return {
      action: "booking_handoff",
      intent: "AVAILABILITY",
      content: REPLIES.AVAILABILITY,
      extraction: emptyAiExtraction,
      handoffReason: null,
      summary: BOOKING_SUMMARIES.AVAILABILITY,
    };
  }

  // A question with no matching knowledge — never fabricate an answer.
  if (message.includes("؟") || message.includes("?")) {
    return {
      action: "handoff",
      intent: "AMBIGUOUS",
      content: REPLIES.NO_KNOWLEDGE,
      extraction: emptyAiExtraction,
      handoffReason: "NO_KNOWLEDGE",
      summary: null,
    };
  }

  // Everything else is ambiguous — staff, never a guess.
  return {
    action: "handoff",
    intent: "AMBIGUOUS",
    content: REPLIES.AMBIGUOUS,
    extraction: emptyAiExtraction,
    handoffReason: "AMBIGUOUS",
    summary: null,
  };
}

// ─── Shared deterministic template accessors (PROMPT-AI-JEV-03B) ──────────────

/**
 * Does the message carry a STRONG FAQ match against the carried knowledge
 * store — the exact condition under which `classifyCustomerMessage` answers
 * verbatim from `Business.faqs`? Exposed so the semantic JEV eligibility gate
 * asks the SAME question the lexical classifier already answers, and the two
 * paths can never disagree on what a "strong FAQ match" is. Pure, total, and
 * performs ZERO model calls.
 */
export function strongFaqMatch(
  message: string,
  faqs: ReadonlyArray<{ question: string; answer: string }>,
): boolean {
  const classification = classifyCustomerMessage(message, faqs);
  if (classification.intent === "FAQ") return true;

  const norm = normalizeArabicText(message);
  const asksQuestion =
    norm.includes("بكام") ||
    norm.includes("سعر") ||
    norm.includes("تكلفة") ||
    norm.includes("تكلفه") ||
    norm.includes("عنوان") ||
    norm.includes("مكان") ||
    norm.includes("فين") ||
    norm.includes("مواعيد العمل");

  if (asksQuestion && matchFaq(tokenize(message), faqs) !== null) {
    return true;
  }
  return false;
}

/**
 * The deterministic customer-facing reply + staff summary for ONE routing
 * intent, drawn from the SAME fixed templates the lexical classifier uses
 * (`REPLIES` / `BOOKING_SUMMARIES` / the greeting acknowledgement). Exposed by
 * PROMPT-AI-JEV-03B so the semantic JEV strategy maps semantic facts into an
 * `AiResponse`-compatible proposal WITHOUT ever authoring customer prose: its
 * `content` is always one of these knowledge-free, engine-owned templates, so
 * no model text and no chain-of-thought can reach the customer through the
 * semantic channel. `GREETING` builds the same acknowledgement the greeting
 * bypass emits. `FAQ` carries no template here (a strong-FAQ turn is JEV-
 * ineligible by construction), so it resolves to the safe knowledge-gap
 * refusal. Pure, total, zero model calls.
 */
export function deterministicReplyForIntent(
  intent: AiIntent,
  message: string,
): { readonly content: string; readonly summary: string | null } {
  if (intent === "GREETING") {
    return { content: buildGreetingContent(message), summary: null };
  }
  if (intent === "FAQ") {
    return { content: REPLIES.NO_KNOWLEDGE, summary: null };
  }
  const content = REPLIES[intent as keyof typeof REPLIES];
  const summary =
    BOOKING_SUMMARIES[intent as keyof typeof BOOKING_SUMMARIES] ?? null;
  return { content, summary };
}

/**
 * Deterministic LLM bypass (DECISIONS #33, PROMPT-ARCH-02): returns a
 * COMPLETE structured response when the turn is safely decidable
 * without any AI provider call, else null. The engine consults this
 * BEFORE calling the assistant, so deterministic turns never spend an
 * LLM call. Covers three provider-independent cases:
 *  - a message too short to understand (→ ambiguous handoff),
 *  - a pure Arabic social opening (→ GREETING reply, DECISIONS #61),
 *  - a pure business-identity question with an authoritative stored name
 *    (→ confident FAQ reply from `businessName`, PROMPT-AI-UX-04B).
 *
 * All are classified from the request's own text through the shared
 * classifier / relevance tables, so the deterministic path and the
 * provider path can never diverge on the same message. A turn that is not
 * safely decidable here returns null and the single existing generative
 * call owns it.
 */
export function bypassDeterministicAi(request: AiRequest): AiResponse | null {
  const normalized = normalizeArabicText(request.message);
  if (normalized.length < 2 || tokenize(request.message).length === 0) {
    return {
      action: "handoff",
      intent: "AMBIGUOUS",
      content: REPLIES.AMBIGUOUS,
      extraction: emptyAiExtraction,
      handoffReason: "AMBIGUOUS",
      summary: null,
    };
  }
  const tokens = tokenize(request.message);
  if (isPureGreeting(request.message, normalized, tokens)) {
    return greetingResponse(request.message);
  }
  // PURE SERVICE-CATALOG QUESTION (UX001-C2-HOTFIX): a direct ask about available
  // services ("إيه الخدمات اللي عندكم؟") is answered deterministically from the
  // authoritative `request.services` list — before any provider is consulted,
  // so the turn spends ZERO provider calls and never leaves the customer without
  // options.
  if (isPureServiceCatalogQuestion(request.message)) {
    if (request.services && request.services.length > 0) {
      return {
        action: "reply",
        intent: "FAQ",
        content: formatServiceCatalogContent(
          request.businessName,
          request.services,
        ),
        extraction: emptyAiExtraction,
        handoffReason: null,
        summary: null,
        requiredKnowledge: "service.name",
      };
    }
  }
  // PURE BUSINESS-IDENTITY QUESTION (PROMPT-AI-UX-04B): a direct ask about the
  // business's own identity is answered here with a FIXED, confident reply
  // built from the authoritative `businessName` — before any provider is
  // consulted, so the turn spends ZERO provider calls and never risks the
  // hedge/disclaimer wording a model authors on this exact turn. The turn must
  // arm `businessIdentity` and yield to every other task family
  // (`isPureBusinessIdentityQuestion`), so a mixed turn (identity + booking,
  // price, catalog, …) stays on the generative multi-intent path. When the
  // business stored no name there is nothing authoritative to confirm from, so
  // this yields too — the existing safe path (NO_KNOWLEDGE handoff) owns the
  // turn and no name is ever invented.
  if (isPureBusinessIdentityQuestion(request.message)) {
    const businessName = request.businessName.trim();
    if (businessName.length > 0) {
      return businessIdentityResponse(businessName);
    }
  }
  return null;
}

/**
 * The current assistant: deterministic rules, fully typed results, safe
 * handoffs. Drop-in replaceable by a real provider adapter later without
 * changing the engine (the ai-contract is the contract).
 */
export const deterministicConversationAi: ConversationAi = {
  providerName: "deterministic",
  async respond(rawRequest: AiRequest): Promise<AiResponse> {
    // Defensive re-validation: an adapter must still satisfy the request
    // contract before its output is trusted downstream.
    const request = parseAiRequest(rawRequest) ?? {
      ...rawRequest,
      services: rawRequest.services ?? [],
      faqs: rawRequest.faqs ?? [],
    };
    if (
      isPureServiceCatalogQuestion(request.message) &&
      request.services &&
      request.services.length > 0
    ) {
      return {
        action: "reply",
        intent: "FAQ",
        content: formatServiceCatalogContent(
          request.businessName,
          request.services,
        ),
        extraction: emptyAiExtraction,
        handoffReason: null,
        summary: null,
        requiredKnowledge: "service.name",
      };
    }
    const result = classifyCustomerMessage(request.message, request.faqs);
    const service = extractServiceFacts(request.message, request.services);
    if (service === null) return result;
    return {
      ...result,
      extraction: { ...result.extraction, service },
    };
  },
};
