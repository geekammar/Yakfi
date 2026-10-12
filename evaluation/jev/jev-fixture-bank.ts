/**
 * FlowPilot AI Evaluation — the labeled Jev FIXTURE BANK (PROMPT-AI-JEV-01).
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  EVALUATION-ONLY. NEVER IMPORTED BY src/. NOT WIRED INTO PRODUCTION.  │
 * │  Contains SYNTHETIC, repository-authored fixtures only. NO production  │
 * │  customer text, NO database reads, NO booking data.                   │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * The bank is the labeled evaluation corpus the Jev benchmark runs over. It
 * is deliberately SEPARATE from `evaluation/datasets/egyptian-v1`: that
 * dataset scores the FULL FlowPilot pipeline on 1,933 scenario cases, whereas
 * this bank is the small, inspectable, hand-labeled set this task needs — the
 * semantic seam cases (the AI-SEM-01 / AI-SEM-02 evidence) plus the minimum
 * coverage classes a routing-decision benchmark must cross. Keeping it small
 * and named keeps the first experiment inspectable, and keeps the number of
 * REAL Jev requests bounded and predictable (see `plannedRequestCount`).
 *
 *
 * LABELING DISCIPLINE (binding)
 *  - Expected facts are written BEFORE any model output is seen, from the
 *    scenario semantics, and are never edited afterwards to make a case
 *    pass. A disagreement is recorded as a disagreement.
 *  - The expected `explicitHuman` verdict is derived by the SERVER-OWNED
 *    precedence formula (`applyServerPrecedence`), never by the label
 *    author's intuition and never by the model. This is the non-regression
 *    proof for AI-SEM-02.
 *  - Cases are tagged with the coverage classes they satisfy, so the report
 *    can show accuracy BY CLASS.
 *
 *
 * THE SERVER-OWNED PRECEDENCE (authoritative, shipped in v0.44.4)
 *
 *     explicitHuman = supportRequest
 *                     OR (providerRequest AND NOT bookingTask)
 *
 * The bank encodes the three INDEPENDENT FACTS and derives the verdict with
 * that exact formula, then compares it with the verdict derived the SAME way
 * from Jev's three facts. The formula is never asked of the model. This
 * demonstrates concretely how a model-supplied fact set would be consumed by
 * the existing server-authoritative policy.
 */

import { createHash } from "node:crypto";

import type { JevQuestionKey } from "./jev-question-contract";

// ─── 1. The label shape ─────────────────────────────────────────────────────

/**
 * The expected semantic facts for one fixture. Each key is a Jev question key
 * and each value is the expected ORIENTATION (true/false). `null` means
 * "no expectation" — the question is not part of this case's evidence and is
 * not scored for it (e.g. `ambiguousTurn` on an obvious booking).
 *
 * These are FACTS, never precedence.
 */
export type ExpectedFacts = Partial<Record<JevQuestionKey, boolean>>;

/**
 * Which evaluation slice a fixture belongs to. Mechanical separation of the
 * calibration set from the frozen holdout (PROMPT-AI-JEV-02 §8):
 *
 *  - `original`    the frozen AI-JEV-01 bank (40 cases). Labels and messages
 *                  are IMMUTABLE here; this task never edits one, and the
 *                  before/after comparison runs over exactly this set.
 *  - `calibration` the PROMPT-AI-JEV-02 additions used by STAGE A to evaluate
 *                  candidate question definitions and select the probability
 *                  policy. Labels were written BEFORE any model output.
 *  - `holdout`     the frozen, untouched set. STAGE B runs against it EXACTLY
 *                  ONCE. It is never used to select a threshold or rewrite a
 *                  criterion, and it is stored in a separate array so a
 *                  calibration loop cannot accidentally include it.
 */
export const bankSliceValues = ["original", "calibration", "holdout"] as const;

export type BankSlice = (typeof bankSliceValues)[number];

/** The bounded coverage classes the bank must span. */
export const fixtureClassValues = [
  "pure-greeting",
  "greeting-plus-unknown-residual",
  "booking-only",
  "availability",
  "reschedule",
  "cancellation",
  "explicit-human-only",
  "explicit-human-plus-booking",
  "greeting-plus-explicit-human-plus-booking",
  "provider-preference-plus-booking",
  "provider-availability",
  "provider-title-without-request-cue",
  "provider-direct-contact",
  "provider-identity",
  "provider-availability-plus-greeting",
  "provider-availability-plus-service",
  "booking-with-named-provider",
  "reschedule-cancel-paraphrase",
  "non-attendance-cancellation",
  "non-attendance-reschedule",
  "sensitive-plus-booking",
  "sensitive-no-booking",
  "service-question",
  "price-question",
  "sensitive-turn",
  "ambiguous-unsupported",
  "unknown-residual",
  "mixed-arabic-english",
  "egyptian-arabic-variant",
  "msa-variant",
  "multi-intent",
  "broad-support-role-false-positive",
] as const;

export type FixtureClass = (typeof fixtureClassValues)[number];

export type JevFixture = {
  /** Stable, unique, human-readable id. */
  readonly id: string;
  /** The customer message text, verbatim. */
  readonly message: string;
  /** The expected semantic facts (written before any model output). */
  readonly expected: ExpectedFacts;
  /** The coverage classes this case evidences. */
  readonly classes: ReadonlyArray<FixtureClass>;
  /**
   * Free-form provenance: which shipped task or evidence the case came from,
   * so a disagreement is traceable to a real requirement.
   */
  readonly provenance: string;
  /** The evaluation slice this fixture belongs to (mechanical separation). */
  readonly bank: BankSlice;
  /** The bounded business context the state carries. */
  readonly businessName: string;
  readonly services: ReadonlyArray<string>;
  readonly faqs: ReadonlyArray<string>;
  readonly languageHint: string;
};

/**
 * A stable content fingerprint of one fixture: sha256 over the canonical
 * (id, message, expected-label) triple. This makes any later edit of a FROZEN
 * label mechanically detectable, and lets the STAGE B artifact bind itself to
 * the exact labels it was evaluated against (PROMPT-AI-JEV-02 §8.5).
 */
export function fixtureFingerprint(fixture: JevFixture): string {
  const content = JSON.stringify({
    id: fixture.id,
    message: fixture.message,
    expected: Object.fromEntries(
      Object.keys(fixture.expected)
        .sort()
        .map((k) => [k, fixture.expected[k as JevQuestionKey] ?? null]),
    ),
  });
  return `sha256:${createHash("sha256").update(content).digest("hex").slice(0, 16)}`;
}

/**
 * A fingerprint over a WHOLE slice, so a frozen bank is identified as a set
 * (order-independent).
 */
export function sliceFingerprint(fixtures: ReadonlyArray<JevFixture>): string {
  const content = fixtures
    .map((f) => fixtureFingerprint(f))
    .sort()
    .join("|");
  return `sha256:${createHash("sha256").update(content).digest("hex").slice(0, 16)}`;
}

// ─── 2. The business context the fixtures share ─────────────────────────────

/**
 * A synthetic dental-clinic context, chosen because the evidence cases from
 * AI-SEM-01 / AI-SEM-02 are dental-clinic Arabic turns. Service names and FAQ
 * questions are repository-authored synthetic values, not customer data, and
 * are present so the closed-world service/price questions are answerable.
 */
const BUSINESS = {
  businessName: "عيادة الأمل لطب الأسنان",
  services: ["تنظيف الأسنان", "حشو الأسنان", "خلع ضرس العقل", "تقويم الأسنان"],
  faqs: ["ما هي ساعات العمل؟", "أين تقع العيادة؟", "هل يوجد تخدير؟"],
  languageHint: "Arabic, predominantly Egyptian colloquial",
} as const;

function fixture(
  id: string,
  message: string,
  expected: ExpectedFacts,
  classes: ReadonlyArray<FixtureClass>,
  provenance: string,
  overrides: Partial<Pick<JevFixture, "languageHint">> = {},
): JevFixture {
  return {
    id,
    message,
    expected,
    classes,
    provenance,
    // The fixtures defined in this file's original block are the frozen
    // AI-JEV-01 bank; they are never edited by a later task.
    bank: "original",
    businessName: BUSINESS.businessName,
    services: BUSINESS.services,
    faqs: BUSINESS.faqs,
    languageHint: overrides.languageHint ?? BUSINESS.languageHint,
  };
}

// ─── 3. The bank ────────────────────────────────────────────────────────────

export const JEV_FIXTURES: ReadonlyArray<JevFixture> = [
  // ── pure greeting ─────────────────────────────────────────────────────────
  fixture(
    "greeting-pure-salam",
    "السلام عليكم",
    {
      greetingOnly: true,
      ambiguousTurn: false,
      bookingRequested: false,
      supportRequested: false,
    },
    ["pure-greeting"],
    "DECISIONS #61: a knowledge-free Arabic social opening.",
  ),
  fixture(
    "greeting-pure-sabah",
    "صباح الخير",
    { greetingOnly: true, bookingRequested: false, supportRequested: false },
    ["pure-greeting"],
    "DECISIONS #61: the canonical closed Egyptian greeting.",
  ),
  fixture(
    "greeting-pure-ahlan",
    "أهلاً وسهلاً",
    { greetingOnly: true, bookingRequested: false },
    ["pure-greeting"],
    "DECISIONS #61.",
  ),

  // ── greeting + unknown residual language ──────────────────────────────────
  // The greeting is recognized but a task-bearing residual remains, so the
  // turn is NOT greeting-only. This is the AI-SEM-01 seam: a greeting must
  // never swallow a second intent.
  fixture(
    "greeting-plus-residual-booking",
    "السلام عليكم عايزك تحجزلي",
    {
      greetingOnly: false,
      bookingRequested: true,
      supportRequested: false,
      providerRequested: false,
    },
    ["greeting-plus-unknown-residual", "egyptian-arabic-variant"],
    "AI-SEM-01 evidence: greeting + booking residual. The greeting allowance must not mask «تحجزلي».",
  ),
  fixture(
    "greeting-plus-residual-english-mixed",
    "Hello, I want to book an appointment please",
    {
      greetingOnly: false,
      bookingRequested: true,
      supportRequested: false,
    },
    ["greeting-plus-unknown-residual", "mixed-arabic-english"],
    "Mixed-language variant of the greeting-residual seam.",
  ),

  // ── booking only ──────────────────────────────────────────────────────────
  fixture(
    "booking-only-ahegez",
    "عايز أحجز موعد",
    {
      bookingRequested: true,
      availabilityAsked: false,
      supportRequested: false,
      providerRequested: false,
      greetingOnly: false,
    },
    ["booking-only", "egyptian-arabic-variant"],
    "Ordinary booking; no human request.",
  ),
  fixture(
    "booking-only-mawid-jadid",
    "أبي موعد جديد",
    { bookingRequested: true, supportRequested: false },
    ["booking-only"],
    "MSA booking phrasing.",
  ),
  fixture(
    "booking-only-english",
    "I'd like to book an appointment",
    { bookingRequested: true, supportRequested: false },
    ["booking-only"],
    "English booking (mixed-language coverage).",
  ),

  // ── availability ──────────────────────────────────────────────────────────
  fixture(
    "availability-mata-momken",
    "إمتى ممكن أجي؟",
    {
      availabilityAsked: true,
      bookingRequested: false,
      supportRequested: false,
    },
    ["availability", "egyptian-arabic-variant"],
    "Pure availability ask; the customer is not yet booking.",
  ),
  fixture(
    "availability-fe-mawid",
    "هل عندكم معادين الأسبوع الجاي؟",
    { availabilityAsked: true, bookingRequested: false },
    ["availability"],
    "Plural-slot availability ask.",
  ),

  // ── reschedule ─────────────────────────────────────────────────────────────
  fixture(
    "reschedule-taghyeer-mawid",
    "عايز أغير موعدى",
    {
      rescheduleRequested: true,
      bookingRequested: false,
      cancellationRequested: false,
      supportRequested: false,
    },
    ["reschedule", "egyptian-arabic-variant"],
    "Reschedule of an EXISTING appointment — a domain mutation, not a new booking.",
  ),
  fixture(
    "reschedule-maad-tani",
    "ممكن نأجل الموعد للأسبوع الجاي؟",
    { rescheduleRequested: true, bookingRequested: false },
    ["reschedule"],
    "Postponement phrasing.",
  ),

  // ── cancellation ───────────────────────────────────────────────────────────
  fixture(
    "cancellation-ilghaa",
    "عايز ألغى الحجز",
    {
      cancellationRequested: true,
      rescheduleRequested: false,
      bookingRequested: false,
      supportRequested: false,
    },
    ["cancellation", "egyptian-arabic-variant"],
    "Cancellation — staff owns the mutation.",
  ),
  fixture(
    "cancellation-mesh-hahdar",
    "مش هقدر أحضر بكرة",
    { cancellationRequested: true, bookingRequested: false },
    ["cancellation", "egyptian-arabic-variant"],
    "Implicit cancellation via non-attendance.",
  ),

  // ── explicit human only ────────────────────────────────────────────────────
  // The customer wants a person, with no booking in the turn. The verdict is
  // a plain supportRequest.
  fixture(
    "human-only-mwathaf",
    "عايز أكلم موظف",
    {
      supportRequested: true,
      bookingRequested: false,
      providerRequested: false,
      greetingOnly: false,
    },
    ["explicit-human-only", "egyptian-arabic-variant"],
    "AI-SEM-02: plain supportRequest ⇒ explicitHuman.",
  ),
  fixture(
    "human-only-customer-service",
    "عايز حد من خدمة العملاء",
    {
      supportRequested: true,
      bookingRequested: false,
      providerRequested: false,
    },
    ["explicit-human-only", "egyptian-arabic-variant"],
    "AI-SEM-01/02 evidence: customer-service role word ⇒ supportRequest.",
  ),
  fixture(
    "human-only-wsali-bhad",
    "وصلني بحد",
    {
      supportRequested: true,
      bookingRequested: false,
      providerRequested: false,
    },
    ["explicit-human-only", "egyptian-arabic-variant"],
    "AI-SEM-01/02 evidence: the «وصلني بحد» transfer phrase carries the request even though «حد» is not a role word.",
  ),

  // ── explicit human + booking ───────────────────────────────────────────────
  // The AI-SEM-02 non-regression core: a support-role request wins EVEN
  // INSIDE a booking turn. Booking presence must NOT erase it.
  fixture(
    "human-plus-booking-mwathaf",
    "عايز موظف يحجزلي",
    {
      supportRequested: true,
      bookingRequested: true,
      providerRequested: false,
    },
    ["explicit-human-plus-booking", "egyptian-arabic-variant"],
    "AI-SEM-01/02 evidence: supportRequest AND bookingTask ⇒ explicitHuman still TRUE (booking does not erase a support-role request).",
  ),
  fixture(
    "human-plus-booking-wsali",
    "وصلني بموظف عشان أحجز",
    {
      supportRequested: true,
      bookingRequested: true,
      providerRequested: false,
    },
    ["explicit-human-plus-booking", "egyptian-arabic-variant"],
    "AI-SEM-01/02 evidence: the canonical handoff-inside-booking case.",
  ),
  fixture(
    "human-plus-booking-customer-service",
    "عايز حد من خدمة العملاء يحجزلي",
    {
      supportRequested: true,
      bookingRequested: true,
      providerRequested: false,
    },
    ["explicit-human-plus-booking", "egyptian-arabic-variant"],
    "AI-SEM-01/02 evidence: customer-service + booking ⇒ explicitHuman still TRUE.",
  ),

  // ── greeting + explicit human + booking ────────────────────────────────────
  // Three signals in one turn. The greeting must not swallow either, and the
  // support request must survive the booking stem.
  fixture(
    "greeting-human-booking",
    "السلام عليكم، عايز موظف يحجزلي",
    {
      greetingOnly: false,
      supportRequested: true,
      bookingRequested: true,
      providerRequested: false,
    },
    [
      "greeting-plus-explicit-human-plus-booking",
      "greeting-plus-unknown-residual",
      "egyptian-arabic-variant",
    ],
    "AI-SEM-02 triple-signal case: greeting + supportRequest + bookingTask.",
  ),

  // ── provider preference + booking ──────────────────────────────────────────
  // A provider title INSIDE a booking request is a PREFERENCE, not a handoff.
  // The booking mask must suppress the title path.
  fixture(
    "provider-pref-plus-booking",
    "عايز احجز مع دكتور",
    {
      bookingRequested: true,
      providerPreferenceExpressed: true,
      providerRequested: false,
      supportRequested: false,
    },
    ["provider-preference-plus-booking", "egyptian-arabic-variant"],
    "AI-SEM-01/02 evidence: title inside booking ⇒ PREFERENCE, NOT explicitHuman (booking mask on the title path).",
  ),
  fixture(
    "provider-pref-plus-booking-female",
    "عايز ميعاد مع دكتورة",
    {
      bookingRequested: true,
      providerPreferenceExpressed: true,
      providerRequested: false,
      supportRequested: false,
    },
    ["provider-preference-plus-booking", "egyptian-arabic-variant"],
    "AI-SEM-01/02 evidence: gendered title inside booking ⇒ PREFERENCE.",
  ),

  // ── provider availability ──────────────────────────────────────────────────
  // A title inside an AVAILABILITY ask. Also a booking-task-class turn, so the
  // title path stays masked.
  fixture(
    "provider-availability",
    "هل فيه دكتور متاح؟",
    {
      availabilityAsked: true,
      providerPreferenceExpressed: true,
      providerRequested: false,
      supportRequested: false,
      bookingRequested: false,
    },
    ["provider-availability", "egyptian-arabic-variant"],
    "AI-SEM-01/02 evidence: title inside availability ⇒ preference, NOT explicitHuman.",
  ),

  // ── provider title without request cue ─────────────────────────────────────
  // The title is present but NO request-to-speak cue: provider identity, not
  // a handoff. This is the false-positive the deterministic classifier had to
  // learn (HUMAN_TITLE_WORDS + HUMAN_REQUEST_CUES split).
  fixture(
    "provider-title-identity-question",
    "السلام عليكم، هو انتو عيادة الدكتورة افنان للاسنان؟",
    {
      providerRequested: false,
      supportRequested: false,
      providerPreferenceExpressed: false,
      greetingOnly: false,
      serviceOrPriceAsked: false,
    },
    ["provider-title-without-request-cue", "greeting-plus-unknown-residual"],
    "PROMPT-AI-OPS-25: a title in an identity question must NOT fire explicitHuman (no request cue).",
  ),

  // ── service question ───────────────────────────────────────────────────────
  fixture(
    "service-question",
    "ما هي الخدمات اللي بتقدموها؟",
    {
      serviceOrPriceAsked: true,
      bookingRequested: false,
      supportRequested: false,
    },
    ["service-question", "egyptian-arabic-variant"],
    "Service-discovery ask; closed world via the business services in state.",
  ),

  // ── price question ─────────────────────────────────────────────────────────
  fixture(
    "price-question",
    "بكم تنظيف الأسنان؟",
    {
      serviceOrPriceAsked: true,
      bookingRequested: false,
      supportRequested: false,
    },
    ["price-question", "egyptian-arabic-variant"],
    "Price ask; the current product supports the semantic distinction via service.price.",
  ),

  // ── sensitive turn ─────────────────────────────────────────────────────────
  fixture(
    "sensitive-severe-pain",
    "عندي ألم شديد في ضرسى ومش قادر أنام",
    {
      sensitiveTurn: true,
      bookingRequested: false,
      supportRequested: false,
    },
    ["sensitive-turn", "egyptian-arabic-variant"],
    "Safety turn: severe pain. Safety precedence outranks every AI suggestion.",
  ),
  fixture(
    "sensitive-complaint",
    "أنا زعلان جداً من المعاملة اللي حصلت",
    {
      sensitiveTurn: true,
      supportRequested: false,
    },
    ["sensitive-turn", "egyptian-arabic-variant"],
    "Safety turn: distress/complaint.",
  ),

  // ── ambiguous / unsupported turn ───────────────────────────────────────────
  fixture(
    "ambiguous-too-short",
    "اه",
    {
      ambiguousTurn: true,
      bookingRequested: false,
      supportRequested: false,
    },
    ["ambiguous-unsupported", "egyptian-arabic-variant"],
    "Too short to understand; the engine answers ambiguity with a safe handoff, never a guess.",
  ),
  fixture(
    "ambiguous-unsupported-topic",
    "ما رأيك في الطقس اليوم؟",
    {
      ambiguousTurn: true,
      bookingRequested: false,
      supportRequested: false,
      serviceOrPriceAsked: false,
    },
    ["ambiguous-unsupported"],
    "An out-of-domain turn; no supported action exists.",
  ),

  // ── mixed Arabic/English ───────────────────────────────────────────────────
  fixture(
    "mixed-arabic-english-booking",
    "عايز أحجز appointment بكرة",
    {
      bookingRequested: true,
      supportRequested: false,
    },
    ["mixed-arabic-english", "egyptian-arabic-variant"],
    "Code-switched booking; the model must handle a mixed-script turn.",
  ),
  fixture(
    "mixed-arabic-english-human",
    "ممكن أتكلم مع حد please؟",
    {
      supportRequested: true,
      bookingRequested: false,
      providerRequested: false,
    },
    ["mixed-arabic-english", "egyptian-arabic-variant"],
    "Code-switched human request.",
  ),

  // ── Egyptian Arabic variants (dialectal robustness) ───────────────────────
  fixture(
    "egyptian-variant-ayeh",
    "عايز أحجز معاد يعني",
    {
      bookingRequested: true,
      supportRequested: false,
    },
    ["egyptian-arabic-variant", "booking-only"],
    "Egyptian filler «يعني»; lexical noise must not break a clear booking.",
  ),
  fixture(
    "egyptian-variant-3ayez",
    "عايز موعد ضروري",
    {
      bookingRequested: true,
      supportRequested: false,
    },
    ["egyptian-arabic-variant", "booking-only"],
    "Egyptian urgency without a safety condition.",
  ),

  // ── multi-intent cases ─────────────────────────────────────────────────────
  fixture(
    "multi-intent-booking-plus-service",
    "عايز أحجز تنظيف، وبكام الحشو كمان؟",
    {
      bookingRequested: true,
      serviceOrPriceAsked: true,
      supportRequested: false,
    },
    ["multi-intent", "egyptian-arabic-variant"],
    "Two intents in one turn: a booking plus a price question. The Turn Planner's answer-and-continue path owns this.",
  ),
  fixture(
    "multi-intent-greeting-plus-availability",
    "أهلاً، إمتى في معاد فاضي؟",
    {
      greetingOnly: false,
      availabilityAsked: true,
      supportRequested: false,
    },
    [
      "multi-intent",
      "greeting-plus-unknown-residual",
      "egyptian-arabic-variant",
    ],
    "Greeting co-occurring with availability; greeting-only must be FALSE.",
  ),

  // ── broad support-role false-positive probe (required by the task) ────────
  // A support-role WORD appears but NO actual human handoff is requested.
  // The deterministic classifier's HUMAN_WORDS list contains «مدير» and
  // «مساعدة»; a turn that merely mentions them must not become a handoff.
  // These are the cases a lexical matcher gets WRONG and a semantic model
  // must get RIGHT.
  fixture(
    "broad-support-role-modir-no-request",
    "سمعت إن مدير العيادة جديد، إمتى تفتحوا؟",
    {
      supportRequested: false,
      availabilityAsked: true,
      bookingRequested: false,
    },
    ["broad-support-role-false-positive", "egyptian-arabic-variant"],
    "FALSE-POSITIVE PROBE: «مدير» appears as a TOPIC (the new clinic manager), not as a request. No handoff is requested.",
  ),
  fixture(
    "broad-support-role-musaaada-no-request",
    "شكراً على المساعدة، الخدمة كانت ممتازة",
    {
      supportRequested: false,
      bookingRequested: false,
      sensitiveTurn: false,
    },
    ["broad-support-role-false-positive", "egyptian-arabic-variant"],
    "FALSE-POSITIVE PROBE: «مساعدة» appears as THANKS for help already received. No handoff is requested.",
  ),
  fixture(
    "broad-support-role-modir-complaint-context",
    "الخدمة كانت سيئة ومحتاج أتكلم مع المدير",
    {
      supportRequested: true,
      sensitiveTurn: true,
      bookingRequested: false,
    },
    [
      "broad-support-role-false-positive",
      "sensitive-turn",
      "egyptian-arabic-variant",
    ],
    "CONTROL for the probe: here «المدير» IS requested, combined with a complaint. This must be a handoff — proving the probe above is a real semantic distinction, not a blanket word-ignore.",
  ),
];

// ─── 3b. The PROMPT-AI-JEV-02 calibration slice (STAGE A) ─────────────────────
//
// LABELING DISCIPLINE (binding for this slice): every expected fact below was
// written BEFORE any model output for these messages was viewed, from the
// documented product semantics in the @v2 question contract. They are frozen
// for the duration of this task. A disagreement is recorded as a disagreement
// and is never edited to make a case pass.
//
// These cases exist to let STAGE A evaluate candidate question DEFINITIONS and
// select the probability policy. They deliberately concentrate on the provider
// semantic family — 8 of the 13 frozen AI-JEV-01 disagreements, and the only
// routing-affecting ones, came from there — and on the other families the
// recomputed disagreement table flagged (booking/availability competition,
// cancellation-vs-reschedule on non-attendance, greeting-vs-ambiguity,
// sensitive-with-booking, support-topic-mention).
//
// MINIMAL PAIRS: several cases below differ from a partner by exactly ONE
// semantic relationship (availability vs contact, preference vs contact,
// cancellation vs reschedule), not by a keyword. They are the calibration
// signal for the distinction the @v2 contract sharpens.

function v2Fixture(
  id: string,
  message: string,
  expected: ExpectedFacts,
  classes: ReadonlyArray<FixtureClass>,
  provenance: string,
  bank: BankSlice,
  overrides: Partial<Pick<JevFixture, "languageHint">> = {},
): JevFixture {
  return {
    id,
    message,
    expected,
    classes,
    provenance,
    bank,
    businessName: BUSINESS.businessName,
    services: BUSINESS.services,
    faqs: BUSINESS.faqs,
    languageHint: overrides.languageHint ?? BUSINESS.languageHint,
  };
}

const MSA_HINT = "Arabic, predominantly Modern Standard (MSA)";
const MIXED_HINT = "Mixed Arabic and English code-switching";

export const JEV_CALIBRATION_FIXTURES: ReadonlyArray<JevFixture> = [
  // ── direct provider-contact request (the contact half of the minimal pair) ──
  v2Fixture(
    "v2-cal-provider-contact-speak",
    "عايز أكلم دكتور",
    {
      providerRequested: true,
      bookingRequested: false,
      availabilityAsked: false,
      providerPreferenceExpressed: false,
      supportRequested: false,
    },
    ["provider-direct-contact", "egyptian-arabic-variant"],
    "§6 contract pair: speaking with a provider IS contact. Partner of the booking case below.",
    "calibration",
  ),
  v2Fixture(
    "v2-cal-provider-contact-connect",
    "وصلني بالدكتور",
    {
      providerRequested: true,
      bookingRequested: false,
      supportRequested: false,
    },
    ["provider-direct-contact", "egyptian-arabic-variant"],
    "§6: a transfer-to-provider phrase is direct contact, not a booking or a preference.",
    "calibration",
  ),
  v2Fixture(
    "v2-cal-provider-contact-callback",
    "خلي الدكتور يكلمني",
    {
      providerRequested: true,
      bookingRequested: false,
      supportRequested: false,
    },
    ["provider-direct-contact", "egyptian-arabic-variant"],
    "§6: asking the provider to call back is two-way contact.",
    "calibration",
  ),
  v2Fixture(
    "v2-cal-provider-contact-msa",
    "أريد التحدث مع الطبيب",
    {
      providerRequested: true,
      bookingRequested: false,
      supportRequested: false,
    },
    ["provider-direct-contact", "msa-variant"],
    "§6 MSA coverage of the direct-contact relation.",
    "calibration",
    { languageHint: MSA_HINT },
  ),

  // ── provider availability (the availability half of the minimal pair) ───────
  v2Fixture(
    "v2-cal-provider-availability-title",
    "في دكتور متاح دلوقتي؟",
    {
      availabilityAsked: true,
      providerRequested: false,
      providerPreferenceExpressed: true,
      supportRequested: false,
      bookingRequested: false,
    },
    ["provider-availability", "egyptian-arabic-variant"],
    "§6 boundary case: a title inside an availability ask is bookability + preference, NOT contact, so explicitHuman stays false. A FRESH phrasing — the original bank already carries «هل فيه دكتور متاح؟» as the frozen known-failure case, and a message may never be duplicated across slices.",
    "calibration",
  ),
  v2Fixture(
    "v2-cal-provider-availability-named",
    "الدكتور أحمد موجود النهارده؟",
    {
      availabilityAsked: true,
      providerRequested: false,
      providerPreferenceExpressed: false,
      bookingRequested: false,
    },
    ["provider-availability", "provider-identity", "egyptian-arabic-variant"],
    "§6: asking whether a NAMED provider is present is availability/identity, not contact and not a preference.",
    "calibration",
  ),
  v2Fixture(
    "v2-cal-provider-availability-msa",
    "هل يوجد طبيب متاح؟",
    {
      availabilityAsked: true,
      providerRequested: false,
      providerPreferenceExpressed: true,
      bookingRequested: false,
    },
    ["provider-availability", "msa-variant"],
    "§6 MSA coverage of the availability-vs-contact boundary.",
    "calibration",
    { languageHint: MSA_HINT },
  ),

  // ── booking with a provider title / named provider (preference, not contact) ──
  v2Fixture(
    "v2-cal-provider-booking-title",
    "عايز أحجز مع دكتور",
    {
      bookingRequested: true,
      providerPreferenceExpressed: true,
      providerRequested: false,
      availabilityAsked: false,
      supportRequested: false,
    },
    ["provider-preference-plus-booking", "egyptian-arabic-variant"],
    "§6 contract pair: booking WITH a provider constrains the service; it is not contact.",
    "calibration",
  ),
  v2Fixture(
    "v2-cal-provider-booking-named",
    "عايز أحجز مع دكتور أحمد",
    {
      bookingRequested: true,
      providerPreferenceExpressed: true,
      providerRequested: false,
    },
    [
      "provider-preference-plus-booking",
      "booking-with-named-provider",
      "egyptian-arabic-variant",
    ],
    "§6: a NAMED provider inside a booking is a preference for that provider, still not contact.",
    "calibration",
  ),
  v2Fixture(
    "v2-cal-provider-booking-female",
    "عايز أعمل ميعاد مع دكتورة",
    {
      bookingRequested: true,
      providerPreferenceExpressed: true,
      providerRequested: false,
    },
    ["provider-preference-plus-booking", "egyptian-arabic-variant"],
    "§6: a gendered provider title inside a booking is a preference. Deliberately a FRESH phrasing — the original bank already carries «عايز ميعاد مع دكتورة», and a message may never be duplicated across slices (the offline lookup keys on message).",
    "calibration",
  ),
  v2Fixture(
    "v2-cal-provider-contact-plus-booking",
    "عايز الدكتور يكلمني عشان أحجز",
    {
      providerRequested: true,
      bookingRequested: true,
      availabilityAsked: false,
      supportRequested: false,
    },
    ["provider-direct-contact", "provider-preference-plus-booking"],
    "§12 precedence probe: a genuine contact request INSIDE a booking. The server formula masks the title path (bookingTask), so explicitHuman is FALSE here — proving the mask is unchanged.",
    "calibration",
  ),

  // ── provider identity (a title that neither contacts nor prefers) ───────────
  v2Fixture(
    "v2-cal-provider-identity",
    "إنتو عيادة دكتور أحمد؟",
    {
      providerRequested: false,
      providerPreferenceExpressed: false,
      serviceOrPriceAsked: false,
      greetingOnly: false,
    },
    ["provider-identity", "provider-title-without-request-cue"],
    "§6: a provider name used only to identify the business is neither contact nor preference.",
    "calibration",
  ),

  // ── provider availability combined with other intents ──────────────────────
  v2Fixture(
    "v2-cal-greeting-plus-provider-availability",
    "السلام عليكم، في دكتور فاضي؟",
    {
      greetingOnly: false,
      availabilityAsked: true,
      providerRequested: false,
      providerPreferenceExpressed: true,
      supportRequested: false,
    },
    [
      "provider-availability-plus-greeting",
      "greeting-plus-unknown-residual",
      "egyptian-arabic-variant",
    ],
    "§8 required family: a greeting must not swallow an availability ask, and the title stays non-contact.",
    "calibration",
  ),
  v2Fixture(
    "v2-cal-availability-plus-service",
    "في دكتور فاضي؟ وكام تنظيف الأسنان؟",
    {
      availabilityAsked: true,
      serviceOrPriceAsked: true,
      providerRequested: false,
      providerPreferenceExpressed: true,
      bookingRequested: false,
    },
    [
      "provider-availability-plus-service",
      "multi-intent",
      "egyptian-arabic-variant",
    ],
    "§8 required family: availability and a price question co-occur; the title still does not become contact.",
    "calibration",
  ),

  // ── reschedule / cancellation paraphrases and the non-attendance boundary ──
  v2Fixture(
    "v2-cal-reschedule-paraphrase",
    "عايز أغير ميعاد الحجز",
    {
      rescheduleRequested: true,
      bookingRequested: false,
      cancellationRequested: false,
    },
    ["reschedule-cancel-paraphrase", "reschedule", "egyptian-arabic-variant"],
    "§8 required family: a change of an EXISTING appointment, paraphrased.",
    "calibration",
  ),
  v2Fixture(
    "v2-cal-cancel-paraphrase",
    "ما عايز الموعد يعد",
    {
      cancellationRequested: true,
      rescheduleRequested: false,
      bookingRequested: false,
    },
    ["reschedule-cancel-paraphrase", "cancellation", "egyptian-arabic-variant"],
    "§8 required family: a removal of an EXISTING appointment, paraphrased.",
    "calibration",
  ),
  // The @v2 contract's non-attendance boundary, as a one-relationship pair:
  // no alternative time proposed ⇒ cancellation; an alternative proposed ⇒ change.
  v2Fixture(
    "v2-cal-cancel-nonattendance",
    "مش هقدر أجي الموعد",
    {
      cancellationRequested: true,
      rescheduleRequested: false,
      bookingRequested: false,
    },
    ["non-attendance-cancellation", "cancellation", "egyptian-arabic-variant"],
    "§6: non-attendance WITHOUT an alternative time is a cancellation (the AI-JEV-01 disagreement #3 family).",
    "calibration",
  ),
  v2Fixture(
    "v2-cal-reschedule-nonattendance",
    "مش هقدر أجي بكرة، ممكن نعمله يوم الجمعة؟",
    {
      rescheduleRequested: true,
      cancellationRequested: false,
      bookingRequested: false,
    },
    ["non-attendance-reschedule", "reschedule", "egyptian-arabic-variant"],
    "§6: the SAME non-attendance WITH a proposed alternative time is a change — one relationship apart from the case above.",
    "calibration",
  ),

  // ── support-role mention with and without a request ─────────────────────────
  v2Fixture(
    "v2-cal-support-topic-compliment",
    "الموظف اللي رد عليا كان محترم",
    {
      supportRequested: false,
      sensitiveTurn: false,
      bookingRequested: false,
    },
    ["broad-support-role-false-positive", "egyptian-arabic-variant"],
    "§6: a staff role mentioned in a COMPLIMENT carries no request for intervention.",
    "calibration",
  ),
  v2Fixture(
    "v2-cal-support-plus-booking",
    "عايز أكلم موظف وهو يحجزلي",
    {
      supportRequested: true,
      bookingRequested: true,
      providerRequested: false,
    },
    ["explicit-human-plus-booking", "egyptian-arabic-variant"],
    "§12: a real staff request inside a booking — the support branch must fire regardless of the booking.",
    "calibration",
  ),

  // ── mixed Egyptian Arabic / MSA / English on the provider family ────────────
  v2Fixture(
    "v2-cal-mixed-provider-contact",
    "عايز أتكلم مع doctor please",
    {
      providerRequested: true,
      supportRequested: false,
      bookingRequested: false,
    },
    ["mixed-arabic-english", "provider-direct-contact"],
    "§8 required family: code-switched direct contact.",
    "calibration",
    { languageHint: MIXED_HINT },
  ),
  v2Fixture(
    "v2-cal-mixed-availability",
    "Is there a doctor available بكرة؟",
    {
      availabilityAsked: true,
      providerRequested: false,
      providerPreferenceExpressed: true,
      bookingRequested: false,
    },
    ["mixed-arabic-english", "provider-availability"],
    "§8 required family: code-switched availability — the title still does not become contact.",
    "calibration",
    { languageHint: MIXED_HINT },
  ),

  // ── sensitive + booking combinations ────────────────────────────────────────
  v2Fixture(
    "v2-cal-sensitive-plus-booking",
    "عندي ألم جامد وعايز أحجز ضروري",
    {
      sensitiveTurn: true,
      bookingRequested: true,
      supportRequested: false,
    },
    ["sensitive-plus-booking", "sensitive-turn", "egyptian-arabic-variant"],
    "§8 required family: a genuinely sensitive turn that ALSO asks to book. Both facts are true; neither erases the other.",
    "calibration",
  ),
  v2Fixture(
    "v2-cal-sensitive-no-booking",
    "عندي نزيف من الضرس",
    {
      sensitiveTurn: true,
      bookingRequested: false,
      supportRequested: false,
    },
    ["sensitive-no-booking", "sensitive-turn", "egyptian-arabic-variant"],
    "§8 required family: an emergency described with NO booking requested — symptoms alone are not a booking ask.",
    "calibration",
  ),

  // ── unknown / residual phrasing and ambiguity ───────────────────────────────
  v2Fixture(
    "v2-cal-ambiguous-fragment",
    "أها",
    {
      ambiguousTurn: true,
      greetingOnly: false,
      bookingRequested: false,
    },
    ["unknown-residual", "ambiguous-unsupported", "egyptian-arabic-variant"],
    "§8 required family: a bare fragment with no supported action.",
    "calibration",
  ),
  v2Fixture(
    "v2-cal-unknown-residual",
    "آه يعني مش عارف",
    {
      ambiguousTurn: true,
      bookingRequested: false,
    },
    ["unknown-residual", "ambiguous-unsupported", "egyptian-arabic-variant"],
    "§8 required family: hedging residual phrasing that maps to no supported action.",
    "calibration",
  ),
];

// ─── 3c. The PROMPT-AI-JEV-02 holdout slice (STAGE B, frozen) ──────────────────
//
// FROZEN AND UNTOUCHED. These labels were written before any candidate model
// result was viewed for them. STAGE B runs this slice EXACTLY ONCE, after the
// question contract and the probability policy are frozen and fingerprinted.
// This slice is NEVER used to select a threshold, rewrite a criterion, or
// choose an example. It lives in its own array so a calibration loop cannot
// accidentally include it, and `bankSubset("holdout")` is the only selector
// that returns it.
//
// The cases paraphrase and re-combine the calibrated relationships on unseen
// phrasings, titles, names and code-switching, so the holdout measures
// GENERALIZATION of the semantic definitions rather than memorized strings.

export const JEV_HOLDOUT_FIXTURES: ReadonlyArray<JevFixture> = [
  v2Fixture(
    "v2-hold-provider-contact-meet",
    "عايز أشوف دكتور",
    {
      providerRequested: true,
      bookingRequested: false,
      supportRequested: false,
    },
    ["provider-direct-contact", "egyptian-arabic-variant"],
    "Unseen contact verb (seeing a provider) on the contact relation.",
    "holdout",
  ),
  v2Fixture(
    "v2-hold-provider-contact-named",
    "وصلني بالدكتور أحمد",
    {
      providerRequested: true,
      bookingRequested: false,
      supportRequested: false,
    },
    ["provider-direct-contact", "egyptian-arabic-variant"],
    "§6 holdout pair half: contact with a NAMED provider. Partner of the presence question below — same name, opposite relationship.",
    "holdout",
  ),
  v2Fixture(
    "v2-hold-provider-named-presence",
    "الدكتور أحمد موجود؟",
    {
      availabilityAsked: true,
      providerRequested: false,
      providerPreferenceExpressed: false,
      bookingRequested: false,
    },
    ["provider-availability", "provider-identity", "egyptian-arabic-variant"],
    "§6 holdout pair half: presence of the SAME named provider is availability, not contact.",
    "holdout",
  ),
  v2Fixture(
    "v2-hold-provider-availability-female",
    "في دكتورة متاحة؟",
    {
      availabilityAsked: true,
      providerRequested: false,
      providerPreferenceExpressed: true,
      bookingRequested: false,
      supportRequested: false,
    },
    ["provider-availability", "egyptian-arabic-variant"],
    "Unseen gendered title on the availability relation.",
    "holdout",
  ),
  v2Fixture(
    "v2-hold-provider-booking-specialist",
    "عايز أحجز مع أخصائي",
    {
      bookingRequested: true,
      providerPreferenceExpressed: true,
      providerRequested: false,
    },
    ["provider-preference-plus-booking", "egyptian-arabic-variant"],
    "Unseen provider role (specialist) inside a booking — still a preference, not contact.",
    "holdout",
  ),
  v2Fixture(
    "v2-hold-booking-named-provider",
    "عايز أعمل حجز مع دكتور أحمد بكرة",
    {
      bookingRequested: true,
      providerPreferenceExpressed: true,
      providerRequested: false,
      availabilityAsked: false,
    },
    [
      "booking-with-named-provider",
      "provider-preference-plus-booking",
      "egyptian-arabic-variant",
    ],
    "Unseen booking verb with a named provider — preference, with availability explicitly absent.",
    "holdout",
  ),
  v2Fixture(
    "v2-hold-greeting-availability",
    "أهلاً، هل يوجد معاد فاضي؟",
    {
      greetingOnly: false,
      availabilityAsked: true,
      providerRequested: false,
      supportRequested: false,
    },
    ["provider-availability-plus-greeting", "greeting-plus-unknown-residual"],
    "Unseen greeting + availability combination; the greeting must not mask the ask.",
    "holdout",
  ),
  v2Fixture(
    "v2-hold-support-explicit",
    "ممكن أتكلم مع حد من الدعم؟",
    {
      supportRequested: true,
      bookingRequested: false,
      providerRequested: false,
    },
    ["explicit-human-only", "egyptian-arabic-variant"],
    "Unseen support-role phrasing carrying a real request.",
    "holdout",
  ),
  v2Fixture(
    "v2-hold-support-topic-news",
    "سمعت إن عنكم عيادة جديدة",
    {
      supportRequested: false,
      bookingRequested: false,
    },
    ["broad-support-role-false-positive", "egyptian-arabic-variant"],
    "Unseen topic mention with no request — the false-positive probe on fresh phrasing.",
    "holdout",
  ),
  v2Fixture(
    "v2-hold-reschedule-postpone",
    "أجل الموعد أسبوع",
    {
      rescheduleRequested: true,
      cancellationRequested: false,
      bookingRequested: false,
    },
    ["reschedule-cancel-paraphrase", "reschedule", "egyptian-arabic-variant"],
    "Unseen postponement phrasing for an existing appointment.",
    "holdout",
  ),
  v2Fixture(
    "v2-hold-cancel-plain",
    "ألغي الموعد",
    {
      cancellationRequested: true,
      rescheduleRequested: false,
      bookingRequested: false,
    },
    ["reschedule-cancel-paraphrase", "cancellation", "egyptian-arabic-variant"],
    "Unseen plain cancellation phrasing.",
    "holdout",
  ),
  v2Fixture(
    "v2-hold-sensitive-complaint-request",
    "أنا زعلان من الخدمة وعايز أتكلم مع المسؤول",
    {
      sensitiveTurn: true,
      supportRequested: true,
      bookingRequested: false,
    },
    [
      "sensitive-turn",
      "broad-support-role-false-positive",
      "egyptian-arabic-variant",
    ],
    "CONTROL for the probes: a complaint that DOES request a person — the request must survive on unseen phrasing.",
    "holdout",
  ),
  v2Fixture(
    "v2-hold-sensitive-symptom-booking",
    "ضروسي بتوجعني جداً وعايز ميعاد",
    {
      sensitiveTurn: true,
      bookingRequested: true,
      supportRequested: false,
    },
    ["sensitive-plus-booking", "sensitive-turn", "egyptian-arabic-variant"],
    "Unseen sensitive + booking combination; both facts true together.",
    "holdout",
  ),
  v2Fixture(
    "v2-hold-mixed-booking-female",
    "عايز appointment مع دكتورة",
    {
      bookingRequested: true,
      providerPreferenceExpressed: true,
      providerRequested: false,
    },
    ["mixed-arabic-english", "provider-preference-plus-booking"],
    "Unseen code-switched booking with a gendered title — preference, not contact.",
    "holdout",
    { languageHint: MIXED_HINT },
  ),
  v2Fixture(
    "v2-hold-mixed-contact-english",
    "connect me to the doctor لو سمحت",
    {
      providerRequested: true,
      supportRequested: false,
      bookingRequested: false,
    },
    ["mixed-arabic-english", "provider-direct-contact"],
    "Unseen code-switched direct contact.",
    "holdout",
    { languageHint: MIXED_HINT },
  ),
  v2Fixture(
    "v2-hold-msa-cancel",
    "أريد إلغاء الموعد",
    {
      cancellationRequested: true,
      rescheduleRequested: false,
      bookingRequested: false,
    },
    ["reschedule-cancel-paraphrase", "cancellation", "msa-variant"],
    "Unseen MSA cancellation phrasing.",
    "holdout",
    { languageHint: MSA_HINT },
  ),
  v2Fixture(
    "v2-hold-egyptian-urgent-booking",
    "عايز ميعاد ضروري بكرة",
    {
      bookingRequested: true,
      sensitiveTurn: false,
      supportRequested: false,
    },
    ["booking-only", "egyptian-arabic-variant"],
    "Unseen urgent booking WITHOUT a safety condition — urgency alone must not become sensitive or a handoff.",
    "holdout",
  ),
  v2Fixture(
    "v2-hold-ambiguous-precursor",
    "كنت عايز أسأل",
    {
      ambiguousTurn: true,
      bookingRequested: false,
    },
    ["unknown-residual", "ambiguous-unsupported", "egyptian-arabic-variant"],
    "Unseen residual: an announced intent to ask with no ask present.",
    "holdout",
  ),
  v2Fixture(
    "v2-hold-ambiguous-minimal",
    "امم",
    {
      ambiguousTurn: true,
      greetingOnly: false,
    },
    ["unknown-residual", "ambiguous-unsupported"],
    "Unseen minimal fragment with no supported action.",
    "holdout",
  ),
  v2Fixture(
    "v2-hold-service-price",
    "بكم التقويم؟",
    {
      serviceOrPriceAsked: true,
      bookingRequested: false,
      supportRequested: false,
    },
    ["price-question", "egyptian-arabic-variant"],
    "Unseen service price question on a different service.",
    "holdout",
  ),
];

// ─── 3d. The assembled slices and selectors ───────────────────────────────────

/**
 * The full PROMPT-AI-JEV-02 bank: the frozen original slice plus the two new
 * slices. The original 40 cases are a PREFIX and are byte-for-byte unchanged.
 */
export const JEV_FIXTURES_V2: ReadonlyArray<JevFixture> = [
  ...JEV_FIXTURES,
  ...JEV_CALIBRATION_FIXTURES,
  ...JEV_HOLDOUT_FIXTURES,
];

/**
 * The mechanical slice separator (§8.6). `holdout` is reachable ONLY through
 * this selector, so a calibration loop that iterates the default bank never
 * touches it.
 */
export function bankSubset(
  slice: BankSlice,
  fixtures: ReadonlyArray<JevFixture> = JEV_FIXTURES_V2,
): ReadonlyArray<JevFixture> {
  return fixtures.filter((f) => f.bank === slice);
}

/** Every slice fingerprinted, so a frozen set is provably identified. */
export function sliceFingerprints(): Record<BankSlice, string> {
  return {
    original: sliceFingerprint(bankSubset("original")),
    calibration: sliceFingerprint(bankSubset("calibration")),
    holdout: sliceFingerprint(bankSubset("holdout")),
  };
}

/** All fixture ids are unique and all messages are unique (globally). */
export function bankIntegrity(
  fixtures: ReadonlyArray<JevFixture> = JEV_FIXTURES_V2,
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const ids = new Set<string>();
  const msgs = new Set<string>();
  for (const f of fixtures) {
    if (ids.has(f.id)) problems.push(`duplicate id ${f.id}`);
    ids.add(f.id);
    // Messages must be unique ACROSS slices too: the benchmark answers a
    // fixture by looking its message up, so a duplicate would let one slice
    // answer another slice's case and silently mis-score it.
    if (msgs.has(f.message)) problems.push(`duplicate message: ${f.message}`);
    msgs.add(f.message);
  }
  return { ok: problems.length === 0, problems };
}

// ─── 4. The server-owned precedence (AI-SEM-02, authoritative) ──────────────

/**
 * The three independent semantic facts the precedence consumes, normalized to
 * booleans. This is the shape the model would SUPPLY.
 */
export type PrecedenceFacts = {
  readonly supportRequest: boolean;
  readonly providerRequest: boolean;
  readonly bookingTask: boolean;
};

/**
 * The SHIPPED, authoritative precedence (v0.44.4, conversation-ai.ts:571):
 *
 *     explicitHuman = supportRequest OR (providerRequest AND NOT bookingTask)
 *
 * Reproduced HERE for evaluation only, so the benchmark can derive the
 * verdict from facts both ways and prove the policy is unchanged. It is a
 * COPY OF THE FORMULA BY DESIGN — it must never be imported by production,
 * and it must never be replaced by a model call. The production source of
 * truth remains `detectExplicitHumanRequest`.
 */
export function applyServerPrecedence(facts: PrecedenceFacts): {
  explicitHuman: boolean;
  derivation: string;
} {
  const providerPath = facts.providerRequest && !facts.bookingTask;
  const explicitHuman = facts.supportRequest || providerPath;
  const derivation = facts.supportRequest
    ? "supportRequest"
    : providerPath
      ? "providerRequest AND NOT bookingTask"
      : "none";
  return { explicitHuman, derivation };
}

/**
 * The booking-task family: booking / availability / cancellation / reschedule
 * stems all mask the provider-title path (mirroring the production
 * `bookingTask` derivation in `detectExplicitHumanRequest`).
 */
export function bookingTaskFromFacts(facts: {
  bookingRequested: boolean;
  availabilityAsked: boolean;
  cancellationRequested: boolean;
  rescheduleRequested: boolean;
}): boolean {
  return (
    facts.bookingRequested ||
    facts.availabilityAsked ||
    facts.cancellationRequested ||
    facts.rescheduleRequested
  );
}

/**
 * Project a set of expected/model facts onto the precedence inputs, then
 * derive the verdict with the server formula. `present` tells the projector
 * which facts the supplier actually asserted; absent facts are treated as
 * FALSE (never as unknown) so the derivation is total and deterministic.
 */
export function projectPrecedenceFacts(
  facts: Partial<Record<JevQuestionKey, boolean>>,
): PrecedenceFacts {
  return {
    supportRequest: facts.supportRequested ?? false,
    providerRequest: facts.providerRequested ?? false,
    bookingTask: bookingTaskFromFacts({
      bookingRequested: facts.bookingRequested ?? false,
      availabilityAsked: facts.availabilityAsked ?? false,
      cancellationRequested: facts.cancellationRequested ?? false,
      rescheduleRequested: facts.rescheduleRequested ?? false,
    }),
  };
}

/**
 * The expected `explicitHuman` verdict for one fixture, derived with the
 * server-owned formula from the fixture's OWN expected facts. The label
 * author never writes this verdict; the formula does.
 */
export function expectedExplicitHuman(fixture: JevFixture): {
  explicitHuman: boolean;
  derivation: string;
} {
  return applyServerPrecedence(projectPrecedenceFacts(fixture.expected));
}

// ─── 5. Bounded-call accounting (planned before any real call) ──────────────

/**
 * The number of Jev requests the benchmark will make: exactly ONE per
 * fixture, because every question is independent and the Decisions API
 * evaluates all questions in a SINGLE request against the same state. There
 * is deliberately no per-question multiplication and no per-class repetition.
 */
export function plannedRequestCount(
  fixtures: ReadonlyArray<JevFixture> = JEV_FIXTURES_V2,
): number {
  return fixtures.length;
}

/** Coverage report: which classes are satisfied, and by how many cases. */
export function classCoverage(
  fixtures: ReadonlyArray<JevFixture> = JEV_FIXTURES_V2,
): Record<FixtureClass, number> {
  const out = {} as Record<FixtureClass, number>;
  for (const c of fixtureClassValues) out[c] = 0;
  for (const f of fixtures) {
    for (const c of f.classes) out[c] += 1;
  }
  return out;
}

/** Every required class has at least one case (the bank is complete). */
export function bankCoversAllClasses(
  fixtures: ReadonlyArray<JevFixture> = JEV_FIXTURES_V2,
): { complete: boolean; missing: FixtureClass[] } {
  const coverage = classCoverage(fixtures);
  const missing = fixtureClassValues.filter((c) => coverage[c] === 0);
  return { complete: missing.length === 0, missing };
}
