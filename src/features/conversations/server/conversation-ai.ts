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
  AiRequest,
  AiResponse,
} from "@/features/conversations/server/ai-contract";
import {
  emptyAiExtraction,
  parseAiRequest,
} from "@/features/conversations/server/ai-contract";

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

/** Strips the definite article / waw prefix so tokens compare equally. */
function stripAffixes(token: string): string {
  let word = token;
  if (word.length > 4 && word.startsWith("وال")) word = word.slice(3);
  else if (word.length > 3 && word.startsWith("ال")) word = word.slice(2);
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

// ─── Keyword tables (written naturally; normalized at module load) ──────────

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
  "دكتور",
  "دكتورة",
  "مساعدة",
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

const BOOKING_WORDS = ["حجز", "أحجز", "موعد", "معاد", "ميعاد"];

const BOOKING_PHRASES = [
  "عايز موعد",
  "عايز أحجز",
  "عايز معاد",
  "أبي موعد",
  "موعد جديد",
  "حجز موعد",
];

const AVAILABILITY_WORDS = [
  "متاح",
  "متاحين",
  "فاضي",
  "فاضية",
  "أوقات",
  "معادين",
  "متى",
  "إمتى",
];

const AVAILABILITY_PHRASES = [
  "عندكم معاد",
  "في معاد",
  "أي وقت يناسب",
  "الأوقات المتاحة",
  "إمتى ممكن",
  "متى ممكن",
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
    "كم",
    "بكام",
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
  ].map(normalizeArabicText),
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

// ─── Reply / summary templates (assistant voice, vertical-agnostic) ─────────

const REPLIES = {
  BOOKING:
    "يسعدنا خدمتك! سيتواصل معك أحد أعضاء الفريق لإتمام الحجز وتحديد الوقت المناسب.",
  AVAILABILITY:
    "شكراً لسؤالك — سيرسل لك أحد أعضاء الفريق الأوقات المتاحة قريباً.",
  RESCHEDULE: "بالطبع — سيتولى أحد أعضاء الفريق تعديل موعدك والتواصل معك.",
  CANCELLATION: "تمام — سيتواصل معك أحد أعضاء الفريق لإتمام إلغاء الموعد.",
  HUMAN_REQUEST: "تحت أمرك — جارٍ تحويلك الآن لأحد أعضاء الفريق.",
  SENSITIVE: "سنعتني بطلبك — سيتواصل معك أحد أعضاء الفريق في أقرب وقت.",
  NO_KNOWLEDGE: "شكراً لسؤالك — سيرد عليك أحد أعضاء الفريق قريباً.",
  AMBIGUOUS:
    "لم أفهم طلبك تماماً — سيرد عليك أحد أعضاء الفريق لمساعدتك قريباً.",
  /**
   * A knowledge-free social protocol (DECISIONS #61): acknowledges the
   * customer, states that the assistant is ready, and invites them to
   * continue. It never claims to be human, never invents business
   * information, and stays AI_ACTIVE so the next message is handled by
   * the normal classification path.
   */
  GREETING: "أهلاً بك!  أنا مساعدك للحجز والمواعيد — كيف يمكنني مساعدتك اليوم؟",
} as const;

const BOOKING_SUMMARIES = {
  BOOKING: "طلب العميل حجز موعد جديد",
  AVAILABILITY: "استفسر العميل عن الأوقات المتاحة",
  RESCHEDULE: "طلب العميل تعديل موعده",
  CANCELLATION: "طلب العميل إلغاء موعده",
} as const;

// ─── FAQ matching ────────────────────────────────────────────────────────────

/**
 * A whole message is a GREETING only when it carries no other intent
 * vocabulary (DECISIONS #61). This is what keeps the greeting path from
 * swallowing real turns: "عايز أحجز" and "كم سعر التنظيف" contain no
 * greeting token at all (verified below), while "السلام عليكم، عايز أحجز"
 * keeps its booking intent because a booking word is present.
 *
 * A bare time-of-day noun (صباح / مساء) is deliberately NOT a greeting —
 * the canonical forms are the phrases (صباح الخير / مساء الخير), so a
 * one-word "صباح" falls through to the normal path rather than being
 * answered as a greeting.
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
  // The greeting vocabulary is the ONLY intent vocabulary in the message.
  // Any booking / availability / cancellation / reschedule / human /
  // sensitive word disqualifies the pure-greeting reading.
  if (
    hasWord(tokens, BOOKING_WORDS_N) ||
    hasPhrase(normalized, BOOKING_PHRASES_N) ||
    hasWord(tokens, AVAILABILITY_WORDS_N) ||
    hasPhrase(normalized, AVAILABILITY_PHRASES_N) ||
    hasWord(tokens, CANCELLATION_WORDS_N) ||
    hasPhrase(normalized, CANCELLATION_PHRASES_N) ||
    hasWord(tokens, RESCHEDULE_MUTATION_N) ||
    hasPhrase(normalized, RESCHEDULE_PHRASES_N) ||
    hasWord(tokens, HUMAN_WORDS_N) ||
    hasPhrase(normalized, HUMAN_PHRASES_N) ||
    hasWord(tokens, SENSITIVE_WORDS_N) ||
    hasPhrase(normalized, SENSITIVE_PHRASES_N)
  ) {
    return false;
  }
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
  return true;
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
      questionTokens.length <= 3
        ? Math.max(1, Math.ceil(questionTokens.length / 2))
        : 2;
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
function extractServiceFacts(
  message: string,
  services: ReadonlyArray<{ name: string }>,
): string | null {
  const normalized = normalizeArabicText(message);
  for (const service of services) {
    const name = normalizeArabicText(service.name);
    if (name.length > 0 && normalized.includes(name)) return service.name;
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

  // GREETING (DECISIONS #61) — a pure social opening is answered
  // deterministically and stays AI_ACTIVE. It must run AFTER the safety
  // intents (an explicit human request or a sensitive message is never
  // swallowed by a greeting) and BEFORE booking/FAQ: a real booking or
  // knowledge turn carries its own keywords and does not match a pure
  // greeting (see isPureGreeting — a message with any other intent
  // vocabulary is not a greeting). This branch never spends an LLM call.
  if (isPureGreeting(message, normalized, tokens)) {
    return {
      action: "reply",
      intent: "GREETING",
      content: REPLIES.GREETING,
      extraction: emptyAiExtraction,
      handoffReason: null,
      summary: null,
    };
  }

  // Explicit human request first — the customer's own handoff.
  if (
    hasWord(tokens, HUMAN_WORDS_N) ||
    hasPhrase(normalized, HUMAN_PHRASES_N)
  ) {
    return {
      action: "handoff",
      intent: "HUMAN_REQUEST",
      content: REPLIES.HUMAN_REQUEST,
      extraction: emptyAiExtraction,
      handoffReason: "HUMAN_REQUEST",
      summary: null,
    };
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

/**
 * Deterministic LLM bypass (DECISIONS #33, PROMPT-ARCH-02): returns a
 * COMPLETE structured response when the turn is safely decidable
 * without any AI provider call, else null. The engine consults this
 * BEFORE calling the assistant, so deterministic turns never spend an
 * LLM call. Covers two provider-independent cases:
 *  - a pure Arabic social opening (→ GREETING reply, DECISIONS #61),
 *  - a message too short to understand (→ ambiguous handoff).
 *
 * Both are classified from the request's own text through the shared
 * `classifyCustomerMessage` classifier, so the deterministic path and
 * the provider path can never diverge on the same message.
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
    return {
      action: "reply",
      intent: "GREETING",
      content: REPLIES.GREETING,
      extraction: emptyAiExtraction,
      handoffReason: null,
      summary: null,
    };
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
    const result = classifyCustomerMessage(request.message, request.faqs);
    const service = extractServiceFacts(request.message, request.services);
    if (service === null) return result;
    return {
      ...result,
      extraction: { ...result.extraction, service },
    };
  },
};
