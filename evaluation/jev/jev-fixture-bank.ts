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
 *  - `original`         the frozen AI-JEV-01 bank (40 cases). Labels and
 *                       messages are IMMUTABLE here; this task never edits
 *                       one, and the before/after comparison runs over
 *                       exactly this set.
 *  - `calibration`     the PROMPT-AI-JEV-02 additions used by STAGE A to
 *                       evaluate candidate question definitions and select
 *                       the probability policy. Labels were written BEFORE
 *                       any model output. FROZEN by PROMPT-AI-JEV-02B.
 *  - `holdout`         the frozen, untouched PROMPT-AI-JEV-02 set. STAGE B
 *                       ran it exactly once. FROZEN by PROMPT-AI-JEV-02B;
 *                       its one routing defect (the contact-vs-book mask on
 *                       «عايز أشوف دكتور») is the inherited evidence gap
 *                       PROMPT-AI-JEV-02B exists to close.
 *  - `calibration-v3`  the PROMPT-AI-JEV-02B STAGE A slice. Labels were
 *                       authored BEFORE any model output for these messages,
 *                       from the @v3 contract semantics. It concentrates on
 *                       the contact-vs-book minimal pair because that is the
 *                       one relationship the @v2 contract left unspecified.
 *  - `holdout-v3`      the PROMPT-AI-JEV-02B sealed holdout. FROZEN, then
 *                      RETIRED as SEAL_BROKEN by PROMPT-AI-JEV-02B-R: its first
 *                      and only execution was interrupted at 42 of 47 rows by
 *                      a SIGPIPE from the logging pipeline, so it can never
 *                      again serve as a sealed slice. It stays in the bank as
 *                      an immutable historical record and is unreachable from
 *                      any selector but its own. See `jev-freeze-manifest.ts`
 *                      `HOLDOUT_RETIREMENTS`.
 *  - `holdout-v4`      the PROMPT-AI-JEV-02B-R recovery holdout. A FRESH,
 *                      mechanically disjoint slice authored AFTER holdout-v3
 *                      was retired, measured EXACTLY ONCE against the same
 *                      frozen candidate. No selector other than
 *                      `bankSubset("holdout-v4")` returns it.
 */
export const bankSliceValues = [
  "original",
  "calibration",
  "holdout",
  "calibration-v3",
  "holdout-v3",
  "holdout-v4",
] as const;

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

// ─── 3d. The PROMPT-AI-JEV-02B calibration slice (STAGE A, @v3) ────────────────
//
// LABELING DISCIPLINE (binding): every expected fact below was AUTHORED
// BEFORE any model output for these messages was viewed, from the @v3 product
// semantics in the question contract. They are frozen for this task. A
// disagreement is recorded as a disagreement and is never edited to make a
// case pass.
//
// WHY THIS SLICE EXISTS. The frozen @v2 evidence left exactly ONE
// routing-affecting defect: «عايز أشوف دكتور» routed to NO handoff because
// bookingRequested 0.58 masked a provider contact the model had correctly
// identified at 0.79. The differential in §4 isolated the cause: the @v2
// `bookingRequested` question enumerated exclusions for availability,
// symptoms and existing appointments, but NEVER contrasted the booking
// reading with the CONTACT reading — so "seeing a provider", the one verb
// that carries both, landed in both. @v3 states the contrast as a minimal
// pair over the RELATIONSHIP (arrangement vs interaction), and this slice is
// the calibration evidence for it.
//
// Every case below is a FRESH phrasing. No message duplicates any case in the
// original, @v2 calibration or @v2 holdout slices, and none is a paraphrase
// of the known failure sentence — the bank tests the RELATIONSHIP, not the
// string.

export const JEV_CALIBRATION_V3_FIXTURES: ReadonlyArray<JevFixture> = [
  // ── the core contact-vs-book minimal pair (one relationship apart) ──────────
  // The customer wants the INTERACTION ITSELF. No arrangement is asked for, so
  // this is contact and NOT a booking — the booking mask never engages.
  v2Fixture(
    "v3-cal-contact-see-now",
    "محتاج أشوف دكتور دلوقتي",
    {
      providerRequested: true,
      bookingRequested: false,
      availabilityAsked: false,
      providerPreferenceExpressed: false,
      supportRequested: false,
    },
    ["provider-direct-contact", "egyptian-arabic-variant"],
    "§5 contact-vs-book pair (contact half): wanting to see a provider NOW, with no arrangement asked for, is contact and is not a booking.",
    "calibration-v3",
  ),
  // The SAME desire to see a provider, but the customer asks for the
  // ARRANGEMENT. One relationship apart, and the facts invert.
  v2Fixture(
    "v3-cal-book-to-see",
    "عايز أظبط ميعاد عشان أشوف الدكتور",
    {
      bookingRequested: true,
      providerRequested: false,
      availabilityAsked: false,
      providerPreferenceExpressed: true,
      supportRequested: false,
    },
    ["provider-preference-plus-booking", "egyptian-arabic-variant"],
    "§5 contact-vs-book pair (booking half): the customer asks to ARRANGE a time whose purpose is to see the provider. Booking, not contact — the mask engages and explicitHuman stays false.",
    "calibration-v3",
  ),
  // ── the same contrast on a different contact verb (generalization probe) ───
  v2Fixture(
    "v3-cal-contact-meet-plain",
    "عايز أقابل الدكتور",
    {
      providerRequested: true,
      bookingRequested: false,
      supportRequested: false,
    },
    ["provider-direct-contact", "egyptian-arabic-variant"],
    "§5: 'meet' on its own, with no arrangement asked for, is contact.",
    "calibration-v3",
  ),
  v2Fixture(
    "v3-cal-book-to-meet",
    "عايز أعمل موعد عشان أقابل الدكتور",
    {
      bookingRequested: true,
      providerRequested: false,
      providerPreferenceExpressed: true,
      supportRequested: false,
    },
    ["provider-preference-plus-booking", "egyptian-arabic-variant"],
    "§5: 'meet' redirected through an arrangement becomes booking + preference, not contact.",
    "calibration-v3",
  ),
  // ── the contact half on an impersonal availability phrasing ────────────────
  // "وصلني" is a transfer phrase — contact — but with a SUPPORT role, so this
  // probes the role-disjointness boundary at the same time.
  v2Fixture(
    "v3-cal-contact-transfer-named-provider",
    "وصلني بالدكتور سارة",
    {
      providerRequested: true,
      bookingRequested: false,
      supportRequested: false,
      providerPreferenceExpressed: false,
    },
    ["provider-direct-contact", "egyptian-arabic-variant"],
    "§5: a transfer phrase aimed at a NAMED provider is contact; the name does not turn it into a preference or a booking.",
    "calibration-v3",
  ),
  // ── booking with NO provider constraint (generic booking, no preference) ───
  v2Fixture(
    "v3-cal-booking-no-provider",
    "عايز أظبط أي ميعاد فاضي",
    {
      bookingRequested: true,
      providerPreferenceExpressed: false,
      providerRequested: false,
      supportRequested: false,
    },
    ["booking-only", "egyptian-arabic-variant"],
    "§5 required family: a generic booking carrying no provider constraint at all — preference must stay false.",
    "calibration-v3",
  ),
  // ── named-provider booking preference (the preference half) ────────────────
  v2Fixture(
    "v3-cal-booking-named-preference",
    "عايز أعمل حجز مع دكتورة سارة",
    {
      bookingRequested: true,
      providerPreferenceExpressed: true,
      providerRequested: false,
      availabilityAsked: false,
      supportRequested: false,
    },
    [
      "provider-preference-plus-booking",
      "booking-with-named-provider",
      "egyptian-arabic-variant",
    ],
    "§5 required family: a booking that names the provider constrains who performs the service — preference, never contact.",
    "calibration-v3",
  ),
  // ── availability vs contact, and availability vs preference ────────────────
  v2Fixture(
    "v3-cal-availability-generic-title",
    "في أي دكتور متاح بكرة؟",
    {
      availabilityAsked: true,
      providerRequested: false,
      providerPreferenceExpressed: false,
      bookingRequested: false,
      supportRequested: false,
    },
    ["provider-availability", "egyptian-arabic-variant"],
    "§5/§10 adjudication: a GENERIC provider inside an availability ask is availability and constrains nothing — preference is false under the @v3 contract.",
    "calibration-v3",
  ),
  v2Fixture(
    "v3-cal-availability-named-provider",
    "هل دكتورة سارة متاحة بكرة؟",
    {
      availabilityAsked: true,
      providerRequested: false,
      providerPreferenceExpressed: false,
      bookingRequested: false,
      supportRequested: false,
    },
    ["provider-availability", "provider-identity", "egyptian-arabic-variant"],
    "§10 adjudication: even a NAMED provider inside an availability ask is not a preference — the question asks what is free, not who should perform the service.",
    "calibration-v3",
  ),
  v2Fixture(
    "v3-cal-explicit-preference-verb",
    "أنا بتفضل دكتور سارة",
    {
      providerPreferenceExpressed: true,
      bookingRequested: false,
      providerRequested: false,
      availabilityAsked: false,
      supportRequested: false,
    },
    ["provider-preference-plus-booking", "egyptian-arabic-variant"],
    "§5 required family: an explicit PREFERENCE verb naming a provider is preference with no booking and no contact.",
    "calibration-v3",
  ),
  // ── provider identity / presence vs contact ────────────────────────────────
  v2Fixture(
    "v3-cal-identity-who-present",
    "مين الدكتور الموجود دلوقتي؟",
    {
      providerRequested: false,
      providerPreferenceExpressed: false,
      availabilityAsked: true,
      serviceOrPriceAsked: false,
      supportRequested: false,
    },
    ["provider-identity", "provider-availability", "egyptian-arabic-variant"],
    "§5 required family: asking WHO is present is identity/availability, never contact and never preference.",
    "calibration-v3",
  ),
  // ── clinical provider vs non-clinical support (role disjointness) ──────────
  v2Fixture(
    "v3-cal-support-reception-request",
    "عايز أكلم حد على الاستقبال",
    {
      supportRequested: true,
      providerRequested: false,
      bookingRequested: false,
    },
    ["explicit-human-only", "egyptian-arabic-variant"],
    "§5 required family: a non-clinical reception request is support, not provider contact.",
    "calibration-v3",
  ),
  v2Fixture(
    "v3-cal-clinical-vs-support-contrast",
    "عايز أكلم دكتور مش موظف",
    {
      providerRequested: true,
      supportRequested: false,
      bookingRequested: false,
    },
    ["provider-direct-contact", "egyptian-arabic-variant"],
    "§5 required family: the customer explicitly contrasts the provider against staff — contact, and the roles stay disjoint.",
    "calibration-v3",
  ),
  // ── greeting + provider request (the greeting must not swallow the ask) ────
  v2Fixture(
    "v3-cal-greeting-plus-contact",
    "السلام عليكم، محتاج أكلم دكتور",
    {
      greetingOnly: false,
      providerRequested: true,
      bookingRequested: false,
      supportRequested: false,
    },
    [
      "provider-direct-contact",
      "greeting-plus-unknown-residual",
      "egyptian-arabic-variant",
    ],
    "§5 required family: a greeting followed by a contact request — the greeting must not mask it.",
    "calibration-v3",
  ),
  // ── sensitive context + booking (both facts true together) ─────────────────
  v2Fixture(
    "v3-cal-sensitive-plus-booking-named",
    "عندي ألم وحش وعايز أعمل حجز مع دكتور أحمد",
    {
      sensitiveTurn: true,
      bookingRequested: true,
      providerPreferenceExpressed: true,
      providerRequested: false,
      supportRequested: false,
    },
    [
      "sensitive-plus-booking",
      "sensitive-turn",
      "provider-preference-plus-booking",
      "egyptian-arabic-variant",
    ],
    "§5/§12: a sensitive turn that also books with a named provider — sensitive AND booking AND preference are all true, and the mask keeps explicitHuman false.",
    "calibration-v3",
  ),
  // ── cancellation vs reschedule on the alternative-time boundary ────────────
  v2Fixture(
    "v3-cal-cancel-no-alternative",
    "ما عايز أجي الموعد خالص",
    {
      cancellationRequested: true,
      rescheduleRequested: false,
      bookingRequested: false,
    },
    ["non-attendance-cancellation", "cancellation", "egyptian-arabic-variant"],
    "§5 required family: non-attendance with NO alternative time — cancellation, not reschedule.",
    "calibration-v3",
  ),
  v2Fixture(
    "v3-cal-reschedule-with-alternative",
    "موعدي مش مناسب، ممكن نعمله تاني؟",
    {
      rescheduleRequested: true,
      cancellationRequested: false,
      bookingRequested: false,
    },
    ["non-attendance-reschedule", "reschedule", "egyptian-arabic-variant"],
    "§5 required family: an existing appointment re-asked WITH an alternative — reschedule, not cancellation.",
    "calibration-v3",
  ),
  // ── language coverage on the contact-vs-book relationship ──────────────────
  v2Fixture(
    "v3-cal-contact-english",
    "I need to see a doctor",
    {
      providerRequested: true,
      bookingRequested: false,
      supportRequested: false,
    },
    ["provider-direct-contact"],
    "§5 English coverage of the contact half.",
    "calibration-v3",
    { languageHint: "English" },
  ),
  v2Fixture(
    "v3-cal-book-to-see-english",
    "I'd like to book an appointment to see the doctor",
    {
      bookingRequested: true,
      providerRequested: false,
      providerPreferenceExpressed: true,
      supportRequested: false,
    },
    ["provider-preference-plus-booking"],
    "§5 English coverage of the booking half — the same contrast in a second language.",
    "calibration-v3",
    { languageHint: "English" },
  ),
  v2Fixture(
    "v3-cal-contact-msa",
    "أحتاج إلى رؤية الطبيب",
    {
      providerRequested: true,
      bookingRequested: false,
      supportRequested: false,
    },
    ["provider-direct-contact", "msa-variant"],
    "§5 MSA coverage of the contact half.",
    "calibration-v3",
    { languageHint: MSA_HINT },
  ),
  v2Fixture(
    "v3-cal-book-to-see-msa",
    "أريد حجز موعد لرؤية الطبيب",
    {
      bookingRequested: true,
      providerRequested: false,
      providerPreferenceExpressed: true,
      supportRequested: false,
    },
    ["provider-preference-plus-booking", "msa-variant"],
    "§5 MSA coverage of the booking half.",
    "calibration-v3",
    { languageHint: MSA_HINT },
  ),
  v2Fixture(
    "v3-cal-contact-mixed",
    "محتاج أشوف doctor بكرة",
    {
      providerRequested: true,
      bookingRequested: false,
      supportRequested: false,
    },
    ["provider-direct-contact", "mixed-arabic-english"],
    "§5 code-switched coverage of the contact half.",
    "calibration-v3",
    { languageHint: MIXED_HINT },
  ),
  v2Fixture(
    "v3-cal-book-to-see-mixed",
    "عايز أعمل appointment عشان أشوف الدكتور",
    {
      bookingRequested: true,
      providerRequested: false,
      providerPreferenceExpressed: true,
      supportRequested: false,
    },
    ["provider-preference-plus-booking", "mixed-arabic-english"],
    "§5 code-switched coverage of the booking half.",
    "calibration-v3",
    { languageHint: MIXED_HINT },
  ),
  // ── gendered and alternate provider titles on the contact relation ─────────
  v2Fixture(
    "v3-cal-contact-female-title",
    "عايزة أكلم دكتورة",
    {
      providerRequested: true,
      bookingRequested: false,
      providerPreferenceExpressed: false,
      supportRequested: false,
    },
    ["provider-direct-contact", "egyptian-arabic-variant"],
    "§5 alternate gender/title on the contact relation — a gendered title inside a CONTACT request does not create a preference, because no service is being constrained.",
    "calibration-v3",
  ),
  v2Fixture(
    "v3-cal-contact-specialist-title",
    "عايز أكلم أخصائي تقويم",
    {
      providerRequested: true,
      bookingRequested: false,
      supportRequested: false,
    },
    ["provider-direct-contact", "egyptian-arabic-variant"],
    "§5 alternate provider role (orthodontic specialist) on the contact relation.",
    "calibration-v3",
  ),
  // ── the ambiguity/greeting boundary repaired by @v3 ────────────────────────
  v2Fixture(
    "v3-cal-fragment-hesitation",
    "ااه",
    {
      ambiguousTurn: true,
      greetingOnly: false,
      bookingRequested: false,
      supportRequested: false,
    },
    ["unknown-residual", "ambiguous-unsupported", "egyptian-arabic-variant"],
    "§5/@v3: a hesitation vocalization with no greeting content and no task — ambiguous, NOT greeting-only.",
    "calibration-v3",
  ),
  v2Fixture(
    "v3-cal-pure-greeting-full",
    "مساء الخير عليكم",
    {
      greetingOnly: true,
      ambiguousTurn: false,
      bookingRequested: false,
      supportRequested: false,
      providerRequested: false,
    },
    ["pure-greeting", "egyptian-arabic-variant"],
    "§5/@v3 control: a real social opening carrying actual greeting content IS greeting-only — the boundary cut must not swallow real greetings.",
    "calibration-v3",
  ),
];

// ─── 3e. The NEW PROMPT-AI-JEV-02B sealed holdout (STAGE B, frozen) ──────────────
//
// FROZEN AND UNTOUCHED. Every label below was AUTHORED BEFORE any model
// output for these messages was viewed, from the @v3 contract semantics.
// STAGE B runs this slice EXACTLY ONCE, after the @v3 contract, the
// probability policy and these labels are frozen and fingerprinted. This
// slice is NEVER used to select a threshold, rewrite a criterion or choose an
// example; it lives in its own array and `bankSubset("holdout-v3")` is the
// only selector that returns it.
//
// DESIGN. The slice is deliberately concentrated on the four-way
// contact / book / availability / preference / identity boundary — the
// evidence gap AI-JEV-02 left open — while carrying enough CONTROL cases
// (greetings, plain bookings, cancellations, price asks, sensitive turns,
// support probes) to surface collateral regressions in the families @v2 had
// already repaired. Every message is a FRESH phrasing that appears nowhere in
// the original, @v2 calibration or @v2 holdout slices, and the cases are
// built as semantic minimal pairs that differ by ONE RELATIONSHIP rather
// than by a keyword.

export const JEV_HOLDOUT_V3_FIXTURES: ReadonlyArray<JevFixture> = [
  // ── THE CONTACT-vs-BOOK FAMILY (the target of this phase) ───────────────────
  // Eight minimal pairs over the arrangement-vs-interaction relationship,
  // spanning contact verbs, provider titles, genders and languages.
  v2Fixture(
    "v3-hold-contact-see-now",
    "لازم أشوف دكتور النهارده",
    {
      providerRequested: true,
      bookingRequested: false,
      availabilityAsked: false,
      supportRequested: false,
    },
    ["provider-direct-contact", "egyptian-arabic-variant"],
    "Contact half: seeing a provider as the requested mode of resolution, with no arrangement asked for.",
    "holdout-v3",
  ),
  v2Fixture(
    "v3-hold-book-to-see",
    "عايز أعمل ميعاد عشان أشوف دكتور",
    {
      bookingRequested: true,
      providerRequested: false,
      providerPreferenceExpressed: true,
      availabilityAsked: false,
      supportRequested: false,
    },
    ["provider-preference-plus-booking", "egyptian-arabic-variant"],
    "Booking half: one relationship apart, the customer asks to ARRANGE the appointment whose purpose is to see the provider.",
    "holdout-v3",
  ),
  v2Fixture(
    "v3-hold-contact-talk-plain",
    "عايز أتكلم مع الدكتور",
    {
      providerRequested: true,
      bookingRequested: false,
      supportRequested: false,
    },
    ["provider-direct-contact", "egyptian-arabic-variant"],
    "Contact on a speaking verb, with a definite provider reference and no arrangement.",
    "holdout-v3",
  ),
  v2Fixture(
    "v3-hold-book-to-talk",
    "عايز أظبط موعد عشان أتكلم مع الدكتور",
    {
      bookingRequested: true,
      providerRequested: false,
      providerPreferenceExpressed: true,
      supportRequested: false,
    },
    ["provider-preference-plus-booking", "egyptian-arabic-variant"],
    "Booking half of the speaking pair: the arrangement is the request, the conversation is its purpose.",
    "holdout-v3",
  ),
  v2Fixture(
    "v3-hold-contact-connect-named",
    "ممكن توصلني بالدكتور أحمد",
    {
      providerRequested: true,
      bookingRequested: false,
      supportRequested: false,
      providerPreferenceExpressed: false,
    },
    ["provider-direct-contact", "egyptian-arabic-variant"],
    "Contact via a connect phrase aimed at a named provider; the name creates neither a booking nor a preference.",
    "holdout-v3",
  ),
  v2Fixture(
    "v3-hold-contact-callback",
    "خلي الدكتور يتصل بي",
    {
      providerRequested: true,
      bookingRequested: false,
      supportRequested: false,
    },
    ["provider-direct-contact", "egyptian-arabic-variant"],
    "Contact via a provider-callback request on fresh phrasing.",
    "holdout-v3",
  ),
  v2Fixture(
    "v3-hold-contact-female",
    "عايزة أكلم دكتورة بنات",
    {
      providerRequested: true,
      bookingRequested: false,
      providerPreferenceExpressed: false,
      supportRequested: false,
    },
    ["provider-direct-contact", "egyptian-arabic-variant"],
    "Contact with a female customer and an explicitly female provider, on unseen phrasing. No service is constrained, so preference stays false.",
    "holdout-v3",
  ),
  v2Fixture(
    "v3-hold-contact-mixed-verb",
    "محتاج أقابل doctor لو سمحت",
    {
      providerRequested: true,
      bookingRequested: false,
      supportRequested: false,
    },
    ["provider-direct-contact", "mixed-arabic-english"],
    "Code-switched contact on a 'meet' verb.",
    "holdout-v3",
    { languageHint: MIXED_HINT },
  ),
  v2Fixture(
    "v3-hold-contact-msa-formal",
    "أود التحدث مع الطبيب من فضلك",
    {
      providerRequested: true,
      bookingRequested: false,
      supportRequested: false,
    },
    ["provider-direct-contact", "msa-variant"],
    "MSA contact on formal register.",
    "holdout-v3",
    { languageHint: MSA_HINT },
  ),
  v2Fixture(
    "v3-hold-contact-english-direct",
    "can I speak to the dentist please",
    {
      providerRequested: true,
      bookingRequested: false,
      supportRequested: false,
    },
    ["provider-direct-contact"],
    "English contact using a clinical role synonym (dentist) the Arabic slices do not use.",
    "holdout-v3",
    { languageHint: "English" },
  ),
  // ── CONTACT + EXPLICIT BOOKING (the precedence mask probe) ──────────────────
  v2Fixture(
    "v3-hold-contact-plus-booking",
    "عايز الدكتور يكلمني وأنا أعمل الحجز معاه",
    {
      providerRequested: true,
      bookingRequested: true,
      availabilityAsked: false,
      supportRequested: false,
    },
    ["provider-direct-contact", "provider-preference-plus-booking"],
    "§12 precedence probe: a GENUINE contact request inside a GENUINE booking. Both facts true; the server mask keeps explicitHuman FALSE.",
    "holdout-v3",
  ),
  // ── AVAILABILITY vs CONTACT, and AVAILABILITY vs PREFERENCE ─────────────────
  v2Fixture(
    "v3-hold-availability-generic",
    "في دكتور فاضي بكرة؟",
    {
      availabilityAsked: true,
      providerRequested: false,
      providerPreferenceExpressed: false,
      bookingRequested: false,
      supportRequested: false,
    },
    ["provider-availability", "egyptian-arabic-variant"],
    "Availability with a generic provider: the §10 adjudication on fresh phrasing — preference false, contact false.",
    "holdout-v3",
  ),
  v2Fixture(
    "v3-hold-availability-named",
    "هل الدكتور أحمد عنده معاد فاضي؟",
    {
      availabilityAsked: true,
      providerRequested: false,
      providerPreferenceExpressed: false,
      bookingRequested: false,
      supportRequested: false,
    },
    ["provider-availability", "provider-identity", "egyptian-arabic-variant"],
    "Availability with a NAMED provider: a name inside a bookability question creates neither preference nor contact.",
    "holdout-v3",
  ),
  v2Fixture(
    "v3-hold-availability-presence-only",
    "الدكتورة سارة في العيادة دلوقتي؟",
    {
      availabilityAsked: true,
      providerRequested: false,
      providerPreferenceExpressed: false,
      bookingRequested: false,
      supportRequested: false,
    },
    ["provider-availability", "provider-identity", "egyptian-arabic-variant"],
    "Pure presence of a named provider — availability/identity, and nothing else.",
    "holdout-v3",
  ),
  v2Fixture(
    "v3-hold-preference-plus-booking-named",
    "عايز أعمل الحجز مع دكتورة سارة",
    {
      bookingRequested: true,
      providerPreferenceExpressed: true,
      providerRequested: false,
      availabilityAsked: false,
      supportRequested: false,
    },
    [
      "provider-preference-plus-booking",
      "booking-with-named-provider",
      "egyptian-arabic-variant",
    ],
    "A booking that names the provider: preference is present, contact is not, and explicitHuman stays false.",
    "holdout-v3",
  ),
  v2Fixture(
    "v3-hold-preference-plus-booking-specialist",
    "عايز أظبط ميعاد مع أخصائي",
    {
      bookingRequested: true,
      providerPreferenceExpressed: true,
      providerRequested: false,
      supportRequested: false,
    },
    ["provider-preference-plus-booking", "egyptian-arabic-variant"],
    "A booking constraining the provider by ROLE (specialist) — preference by kind, not by name.",
    "holdout-v3",
  ),
  v2Fixture(
    "v3-hold-availability-vs-preference-identity",
    "مين الأخصائي الموجود؟",
    {
      availabilityAsked: true,
      providerRequested: false,
      providerPreferenceExpressed: false,
      supportRequested: false,
    },
    ["provider-identity", "provider-availability", "egyptian-arabic-variant"],
    "Identity/presence asked about a provider ROLE: neither contact, nor preference, nor booking.",
    "holdout-v3",
  ),
  v2Fixture(
    "v3-hold-explicit-preference-no-booking",
    "أنا بتفضل دكتور أحمد",
    {
      providerPreferenceExpressed: true,
      bookingRequested: false,
      providerRequested: false,
      availabilityAsked: false,
      supportRequested: false,
    },
    ["provider-preference-plus-booking", "egyptian-arabic-variant"],
    "A pure preference verb naming a provider, with no booking and no contact — the positive side of the §10 contract.",
    "holdout-v3",
  ),
  // ── PROVIDER IDENTITY vs CONTACT (the business-identification case) ─────────
  v2Fixture(
    "v3-hold-identity-business",
    "إنتو بتوع دكتور أحمد؟",
    {
      providerRequested: false,
      providerPreferenceExpressed: false,
      availabilityAsked: false,
      serviceOrPriceAsked: false,
      greetingOnly: false,
    },
    ["provider-identity", "provider-title-without-request-cue"],
    "A provider name used only to identify the business: no contact, no preference, no availability.",
    "holdout-v3",
  ),
  // ── CLINICAL PROVIDER vs NON-CLINICAL SUPPORT (role disjointness) ───────────
  v2Fixture(
    "v3-hold-support-explicit-request",
    "محتاج أتكلم مع مسؤول",
    {
      supportRequested: true,
      providerRequested: false,
      bookingRequested: false,
    },
    ["explicit-human-only", "egyptian-arabic-variant"],
    "A real request for a non-clinical responsible person — support fires, provider contact does not.",
    "holdout-v3",
  ),
  v2Fixture(
    "v3-hold-support-topic-news-only",
    "سمعت إن عندكم دكتور جديد",
    {
      supportRequested: false,
      providerRequested: false,
      bookingRequested: false,
      providerPreferenceExpressed: false,
    },
    ["broad-support-role-false-positive", "egyptian-arabic-variant"],
    "FALSE-POSITIVE PROBE on fresh phrasing: a provider mentioned as NEWS carries no request at all.",
    "holdout-v3",
  ),
  v2Fixture(
    "v3-hold-support-plus-booking",
    "عايز موظف يعمللي الحجز",
    {
      supportRequested: true,
      bookingRequested: true,
      providerRequested: false,
    },
    ["explicit-human-plus-booking", "egyptian-arabic-variant"],
    "§12 control: a real staff request inside a booking — the support branch must fire and explicitHuman must be TRUE.",
    "holdout-v3",
  ),
  // ── GREETING CONTROLS (the @v3 greeting-content boundary) ──────────────────
  v2Fixture(
    "v3-hold-pure-greeting",
    "تصبح على خير",
    {
      greetingOnly: true,
      ambiguousTurn: false,
      bookingRequested: false,
      supportRequested: false,
      providerRequested: false,
    },
    ["pure-greeting"],
    "CONTROL: a real parting greeting with actual greeting content stays greeting-only.",
    "holdout-v3",
  ),
  v2Fixture(
    "v3-hold-greeting-plus-availability",
    "مساء الفل، في معاد فاضي بكرة؟",
    {
      greetingOnly: false,
      availabilityAsked: true,
      providerRequested: false,
      supportRequested: false,
      bookingRequested: false,
    },
    [
      "provider-availability-plus-greeting",
      "greeting-plus-unknown-residual",
      "egyptian-arabic-variant",
    ],
    "CONTROL: a greeting must not swallow an availability ask, and the ask is not a booking.",
    "holdout-v3",
  ),
  v2Fixture(
    "v3-hold-greeting-plus-contact",
    "أهلاً، محتاج أكلم دكتور",
    {
      greetingOnly: false,
      providerRequested: true,
      bookingRequested: false,
      supportRequested: false,
    },
    [
      "provider-direct-contact",
      "greeting-plus-unknown-residual",
      "egyptian-arabic-variant",
    ],
    "CONTROL: a greeting must not swallow a contact request either.",
    "holdout-v3",
  ),
  v2Fixture(
    "v3-hold-fragment-ambiguous",
    "ااه بس",
    {
      ambiguousTurn: true,
      greetingOnly: false,
      bookingRequested: false,
      supportRequested: false,
    },
    ["unknown-residual", "ambiguous-unsupported", "egyptian-arabic-variant"],
    "CONTROL: a hesitation fragment with no greeting content and no task stays ambiguous, not greeting-only.",
    "holdout-v3",
  ),
  // ── BOOKING / TASK CONTROLS (collateral regression detection) ───────────────
  v2Fixture(
    "v3-hold-booking-plain",
    "عايز أعمل حجز تنظيف",
    {
      bookingRequested: true,
      providerRequested: false,
      providerPreferenceExpressed: false,
      supportRequested: false,
    },
    ["booking-only", "egyptian-arabic-variant"],
    "CONTROL: a plain service booking with no provider mention.",
    "holdout-v3",
  ),
  v2Fixture(
    "v3-hold-availability-plain",
    "إمتى بفتحوا بكرة؟",
    {
      availabilityAsked: true,
      bookingRequested: false,
      supportRequested: false,
    },
    ["availability", "egyptian-arabic-variant"],
    "CONTROL: opening-hours availability with no provider and no booking commitment.",
    "holdout-v3",
  ),
  v2Fixture(
    "v3-hold-reschedule-alternative",
    "الحجز مش مظبوط، ممكن نغيره الأسبوع الجاي؟",
    {
      rescheduleRequested: true,
      cancellationRequested: false,
      bookingRequested: false,
    },
    ["non-attendance-reschedule", "reschedule", "egyptian-arabic-variant"],
    "CONTROL: an existing appointment moved WITH an alternative time.",
    "holdout-v3",
  ),
  v2Fixture(
    "v3-hold-cancel-plain",
    "عايز ألغي الحجز بتاعي",
    {
      cancellationRequested: true,
      rescheduleRequested: false,
      bookingRequested: false,
    },
    ["reschedule-cancel-paraphrase", "cancellation", "egyptian-arabic-variant"],
    "CONTROL: a plain cancellation with no alternative proposed.",
    "holdout-v3",
  ),
  v2Fixture(
    "v3-hold-cancel-msa",
    "أرغب في تأجيل الموعد",
    {
      rescheduleRequested: true,
      cancellationRequested: false,
      bookingRequested: false,
    },
    ["non-attendance-reschedule", "reschedule", "msa-variant"],
    "CONTROL: MSA postponement — a deferral is a change, not a removal.",
    "holdout-v3",
    { languageHint: MSA_HINT },
  ),
  v2Fixture(
    "v3-hold-service-price",
    "بكم الحشو عندكم؟",
    {
      serviceOrPriceAsked: true,
      bookingRequested: false,
      supportRequested: false,
    },
    ["price-question", "egyptian-arabic-variant"],
    "CONTROL: a price ask on an unseen service.",
    "holdout-v3",
  ),
  v2Fixture(
    "v3-hold-service-question",
    "إنتو بتعملوا خلع ضرس العقل؟",
    {
      serviceOrPriceAsked: true,
      bookingRequested: false,
      supportRequested: false,
    },
    ["service-question", "egyptian-arabic-variant"],
    "CONTROL: a service-discovery question naming a real offered service.",
    "holdout-v3",
  ),
  v2Fixture(
    "v3-hold-sensitive-no-booking",
    "ضروسي بتوجعني جامد ومش عارف أنام",
    {
      sensitiveTurn: true,
      bookingRequested: false,
      supportRequested: false,
    },
    ["sensitive-no-booking", "sensitive-turn", "egyptian-arabic-variant"],
    "CONTROL: severe symptoms with NO booking asked for — symptoms alone are not a booking and not a handoff.",
    "holdout-v3",
  ),
  v2Fixture(
    "v3-hold-sensitive-plus-booking",
    "عندي ألم جامد وعايز أظبط ميعاد ضروري",
    {
      sensitiveTurn: true,
      bookingRequested: true,
      supportRequested: false,
    },
    ["sensitive-plus-booking", "sensitive-turn", "egyptian-arabic-variant"],
    "CONTROL: a sensitive turn that ALSO books — both facts true together, and neither erases the other.",
    "holdout-v3",
  ),
  v2Fixture(
    "v3-hold-sensitive-complaint-request",
    "أنا زعلان جداً وعايز أكلم المسؤول",
    {
      sensitiveTurn: true,
      supportRequested: true,
      providerRequested: false,
      bookingRequested: false,
    },
    [
      "sensitive-turn",
      "broad-support-role-false-positive",
      "egyptian-arabic-variant",
    ],
    "CONTROL: a complaint that DOES request a non-clinical person — the request survives, and the provider path does not fire.",
    "holdout-v3",
  ),
  v2Fixture(
    "v3-hold-urgent-booking-not-sensitive",
    "عايز ميعاد ضروري على طول",
    {
      bookingRequested: true,
      sensitiveTurn: false,
      supportRequested: false,
    },
    ["booking-only", "egyptian-arabic-variant"],
    "CONTROL: urgency without a medical severity marker must not become sensitive or a handoff.",
    "holdout-v3",
  ),
  v2Fixture(
    "v3-hold-multi-intent-booking-plus-contact",
    "عايز أعمل حجز وأكلم الدكتور بعده",
    {
      bookingRequested: true,
      providerRequested: true,
      availabilityAsked: false,
      supportRequested: false,
    },
    ["multi-intent", "provider-direct-contact", "egyptian-arabic-variant"],
    "CONTROL: two intents in one turn — a booking AND a contact. The mask keeps explicitHuman false; both facts are asserted.",
    "holdout-v3",
  ),
  v2Fixture(
    "v3-hold-multi-intent-availability-plus-price",
    "في دكتور فاضي؟ وبكم التنظيف؟",
    {
      availabilityAsked: true,
      serviceOrPriceAsked: true,
      providerRequested: false,
      providerPreferenceExpressed: false,
      bookingRequested: false,
    },
    [
      "provider-availability-plus-service",
      "multi-intent",
      "egyptian-arabic-variant",
    ],
    "CONTROL: availability + price in one turn; the generic provider still creates no preference and no contact.",
    "holdout-v3",
  ),
  v2Fixture(
    "v3-hold-ambiguous-precursor",
    "بس كنت عايز أسأل حاجة",
    {
      ambiguousTurn: true,
      bookingRequested: false,
      supportRequested: false,
    },
    ["unknown-residual", "ambiguous-unsupported", "egyptian-arabic-variant"],
    "CONTROL: an announced intent to ask with no actual ask present.",
    "holdout-v3",
  ),
  v2Fixture(
    "v3-hold-ambiguous-out-of-domain",
    "إيه أخبار الماتش؟",
    {
      ambiguousTurn: true,
      bookingRequested: false,
      supportRequested: false,
      serviceOrPriceAsked: false,
    },
    ["ambiguous-unsupported", "egyptian-arabic-variant"],
    "CONTROL: an out-of-domain turn with no supported action.",
    "holdout-v3",
  ),
  v2Fixture(
    "v3-hold-egyptian-booking-filler",
    "عايز أعمل معاد يعني بكرة",
    {
      bookingRequested: true,
      supportRequested: false,
      providerRequested: false,
    },
    ["booking-only", "egyptian-arabic-variant"],
    "CONTROL: Egyptian filler around a clear booking; lexical noise must not break it.",
    "holdout-v3",
  ),
  v2Fixture(
    "v3-hold-mixed-booking-female",
    "عايز appointment مع دكتورة بكرة",
    {
      bookingRequested: true,
      providerPreferenceExpressed: true,
      providerRequested: false,
      availabilityAsked: false,
    },
    ["mixed-arabic-english", "provider-preference-plus-booking"],
    "CONTROL: code-switched booking with a gendered title — preference, not contact.",
    "holdout-v3",
    { languageHint: MIXED_HINT },
  ),
  v2Fixture(
    "v3-hold-mixed-availability",
    "Is there a dentist available بكرة؟",
    {
      availabilityAsked: true,
      providerRequested: false,
      providerPreferenceExpressed: false,
      bookingRequested: false,
    },
    ["mixed-arabic-english", "provider-availability"],
    "CONTROL: code-switched availability using a clinical role synonym — no contact, no preference.",
    "holdout-v3",
    { languageHint: MIXED_HINT },
  ),
  v2Fixture(
    "v3-hold-msa-booking",
    "أرغب في حجز موعد جديد",
    {
      bookingRequested: true,
      supportRequested: false,
      providerRequested: false,
    },
    ["booking-only", "msa-variant"],
    "CONTROL: MSA booking with no provider.",
    "holdout-v3",
    { languageHint: MSA_HINT },
  ),
  v2Fixture(
    "v3-hold-english-booking",
    "book me a cleaning appointment",
    {
      bookingRequested: true,
      supportRequested: false,
      providerRequested: false,
    },
    ["booking-only"],
    "CONTROL: English booking on a service the context offers.",
    "holdout-v3",
    { languageHint: "English" },
  ),
  v2Fixture(
    "v3-hold-support-compliment-no-request",
    "الموظفة اللي ردت عليا كانت في قمة الذوق",
    {
      supportRequested: false,
      sensitiveTurn: false,
      bookingRequested: false,
    },
    ["broad-support-role-false-positive", "egyptian-arabic-variant"],
    "CONTROL: a staff role mentioned only in a COMPLIMENT carries no request.",
    "holdout-v3",
  ),
];

// ─── 3g. The PROMPT-AI-JEV-02B-R recovery holdout (holdout-v4, frozen) ──────────
//
// AUTHORED AFTER holdout-v3 WAS RETIRED AS SEAL_BROKEN. holdout-v3's first and
// only execution was interrupted by SIGPIPE from the session's own logging
// pipeline at 42 of 47 fixtures, and no artifact persisted, so the seal is
// broken and that slice can never be measured again. This slice is the
// RECOVERY: a completely fresh bank, measured EXACTLY ONCE against the SAME
// frozen candidate (contract sha256:588222a74f4a356b, policy
// sha256:a01c368d17e5629e). No semantic component was altered to make it
// greener — the missing evidence is a clean sealed measurement, not another
// semantic pass.
//
// DISJOINTNESS. Every id and every message below is mechanically disjoint from
// the original, calibration, holdout, calibration-v3 and holdout-v3 slices
// (verified by `bankIntegrity()` over JEV_FIXTURES_V4 and by the freeze-time
// disjointness proof in check-jev-eval J20b). Nothing is a paraphrase of a
// holdout-v3 row: each case is a fresh phrasing of the relationship.
//
// DESIGN. The slice concentrates on the same contact / book / availability /
// preference / identity boundary, plus the families the interrupted run never
// measured (MSA, English, mixed). Minimal pairs differ by ONE RELATIONSHIP
// (arrangement vs interaction), never by a keyword. The AMBIGUOUS family is
// authored deliberately with and without an interaction verb, so the holdout
// MEASURES where the contract resolves and where a future clarification step
// would help. Labels are authored from the @v3 contract ONLY; the bare
// provider-need rows assert every fact the contract excludes and leave
// `providerRequested` unset, which is the honest position for a turn that
// names neither an interaction nor an arrangement.

export const JEV_HOLDOUT_V4_FIXTURES: ReadonlyArray<JevFixture> = [
  // ── A. DIRECT PROVIDER CONTACT — the interaction itself is the request ──────
  // Each of these asks for two-way personal contact with a clinician, so the
  // frozen contract fires providerRequested and the precedence routes to a
  // handoff. Titles, genders and languages vary; the relationship does not.
  v2Fixture(
    "v4-hold-contact-talk-gyn-female",
    "ممكن تخليني أكلم دكتورة نسا؟",
    {
      providerRequested: true,
      bookingRequested: false,
      availabilityAsked: false,
      supportRequested: false,
      providerPreferenceExpressed: false,
    },
    ["provider-direct-contact", "egyptian-arabic-variant"],
    "Direct contact on a speaking verb with a gendered specialty title. The customer asks to BE the one talking, so no arrangement is requested and the gender narrows nothing — a contact request is never a preference.",
    "holdout-v4",
  ),
  v2Fixture(
    "v4-hold-contact-named-ahmed-self",
    "عايز أتواصل مع الدكتور أحمد نفسه",
    {
      providerRequested: true,
      bookingRequested: false,
      supportRequested: false,
      providerPreferenceExpressed: false,
    },
    ["provider-direct-contact", "egyptian-arabic-variant"],
    "Direct contact with a named provider and an emphatic self («نفسه»). The name identifies WHO to contact; it constrains no service, so preference stays false.",
    "holdout-v4",
  ),
  v2Fixture(
    "v4-hold-contact-tell-doctor-self",
    "ينفع أحكي للدكتور بنفسي؟",
    {
      providerRequested: true,
      bookingRequested: false,
      supportRequested: false,
    },
    ["provider-direct-contact", "egyptian-arabic-variant"],
    "Direct contact on a telling verb: the customer wants to be the one who speaks to the provider. No slot, no arrangement.",
    "holdout-v4",
  ),
  v2Fixture(
    "v4-hold-contact-be-connected",
    "عايز حد يوصلني للدكتور",
    {
      providerRequested: true,
      bookingRequested: false,
      supportRequested: false,
    },
    ["provider-direct-contact", "egyptian-arabic-variant"],
    "Contact via a connect request. «حد» here is only the means to reach the clinician; the requested TARGET is the provider, so this is provider contact, not a staff request.",
    "holdout-v4",
  ),
  v2Fixture(
    "v4-hold-contact-english-connect",
    "Can you connect me to Dr Ahmed?",
    {
      providerRequested: true,
      bookingRequested: false,
      providerPreferenceExpressed: false,
    },
    ["provider-direct-contact", "mixed-arabic-english"],
    "English contact case: a connect request aimed at a named provider. Neither the language nor the name turns it into a booking or a preference.",
    "holdout-v4",
    { languageHint: "English" },
  ),
  v2Fixture(
    "v4-hold-contact-english-speak-direct",
    "I want to speak with the doctor directly",
    {
      providerRequested: true,
      bookingRequested: false,
    },
    ["provider-direct-contact", "mixed-arabic-english"],
    "English contact case with an explicit directness adverb. The same relationship as the Arabic speaking pair, on unseen wording.",
    "holdout-v4",
    { languageHint: "English" },
  ),
  v2Fixture(
    "v4-hold-contact-see-mixed-now",
    "محتاج أشوف doctor دلوقتي",
    {
      providerRequested: true,
      bookingRequested: false,
      availabilityAsked: false,
    },
    ["provider-direct-contact", "mixed-arabic-english"],
    "Mixed-language SEEING contact with a time attached. The @v3 contract's timing invariance: «دلوقتي» states WHEN the interaction is wanted and does not convert it into an arrangement or an availability question.",
    "holdout-v4",
    { languageHint: MIXED_HINT },
  ),
  v2Fixture(
    "v4-hold-contact-meet-peds-tomorrow",
    "عايز أقابل دكتورة أطفال بكرة",
    {
      providerRequested: true,
      bookingRequested: false,
      availabilityAsked: false,
      providerPreferenceExpressed: false,
    },
    ["provider-direct-contact", "egyptian-arabic-variant"],
    "MEETING contact with a gendered specialty title and a time. Contrast v4-hold-book-peds-nextweek: the same title and the same timing, one relationship apart.",
    "holdout-v4",
  ),

  // ── B. BOOK-TO-SEE — the arrangement is the request ─────────────────────────
  // One relationship away from family A: the customer asks to ARRANGE the
  // appointment whose purpose is to reach the provider. providerRequested is
  // false and the booking mask keeps the turn off the handoff path.
  v2Fixture(
    "v4-hold-book-gyn-tomorrow",
    "احجزلي كشف مع دكتورة بكرة",
    {
      bookingRequested: true,
      providerRequested: false,
      providerPreferenceExpressed: true,
      availabilityAsked: false,
    },
    ["provider-preference-plus-booking", "egyptian-arabic-variant"],
    "Booking half of a title pair: an imperative booking verb with a gendered provider attached to the service, so the provider set IS narrowed.",
    "holdout-v4",
  ),
  v2Fixture(
    "v4-hold-book-derm",
    "عايز ميعاد عند دكتور جلدية",
    {
      bookingRequested: true,
      providerRequested: false,
      providerPreferenceExpressed: true,
      availabilityAsked: false,
    },
    ["provider-preference-plus-booking", "egyptian-arabic-variant"],
    "Booking with a specialty title after «عند». The specialty narrows who may perform the service; the turn still asks only for the slot.",
    "holdout-v4",
  ),
  v2Fixture(
    "v4-hold-book-not-talk",
    "محتاج أحجز كشف مش أكلمه دلوقتي",
    {
      bookingRequested: true,
      providerRequested: false,
      providerPreferenceExpressed: false,
      availabilityAsked: false,
    },
    ["booking-only", "egyptian-arabic-variant"],
    "The EXPLICIT contrast case: the customer names the interaction («أكلمه») only to refuse it, and asks for the arrangement instead. A contact reading here would be exactly the masking defect this phase repairs.",
    "holdout-v4",
  ),
  v2Fixture(
    "v4-hold-book-english-thursday",
    "Book an appointment with Dr Ahmed next Thursday",
    {
      bookingRequested: true,
      providerRequested: false,
      providerPreferenceExpressed: true,
      availabilityAsked: false,
    },
    ["booking-with-named-provider", "mixed-arabic-english"],
    "English booking with a named provider and a date. The named provider narrows the set; the request is the appointment.",
    "holdout-v4",
    { languageHint: "English" },
  ),
  v2Fixture(
    "v4-hold-book-peds-nextweek",
    "عايز كشف عند دكتورة أطفال الأسبوع الجاي",
    {
      bookingRequested: true,
      providerRequested: false,
      providerPreferenceExpressed: true,
      availabilityAsked: false,
    },
    ["provider-preference-plus-booking", "egyptian-arabic-variant"],
    "Booking half of the meeting pair in family A: same title, same timing, one relationship apart — the customer asks for the ARRANGEMENT, not the interaction.",
    "holdout-v4",
  ),
  v2Fixture(
    "v4-hold-book-any-available",
    "ممكن تحجزلي عند أي دكتور متاح؟",
    {
      bookingRequested: true,
      providerRequested: false,
      providerPreferenceExpressed: false,
      availabilityAsked: false,
    },
    ["booking-only", "egyptian-arabic-variant"],
    "Booking with an UNSPECIFIED provider: «أي دكتور» narrows nothing, so preference is false even though a title appears. The word «متاح» sits inside a booking request and does not turn it into an availability question.",
    "holdout-v4",
  ),

  // ── C. AVAILABILITY — a question about what is free or present ──────────────
  // A provider title appears in every row, and none of them is a request for
  // contact. The @v3 contract keeps these out of the provider path, so the
  // precedence does not hand off.
  v2Fixture(
    "v4-hold-avail-dentist-today",
    "دكتور الأسنان موجود النهارده؟",
    {
      availabilityAsked: true,
      providerRequested: false,
      bookingRequested: false,
      providerPreferenceExpressed: false,
      supportRequested: false,
    },
    ["provider-availability", "egyptian-arabic-variant"],
    "Availability as PRESENCE: a titled provider and a day, asking whether he is there. Neither the title nor the day creates contact or preference.",
    "holdout-v4",
  ),
  v2Fixture(
    "v4-hold-avail-peds-tomorrow",
    "فيه دكتورة أطفال متاحة بكرة؟",
    {
      availabilityAsked: true,
      providerRequested: false,
      providerPreferenceExpressed: false,
    },
    ["provider-availability", "egyptian-arabic-variant"],
    "Availability as bookability of a gendered specialty, on a fresh phrasing of the historically repaired family.",
    "holdout-v4",
  ),
  v2Fixture(
    "v4-hold-avail-english-ahmed",
    "Is Dr Ahmed in today?",
    {
      availabilityAsked: true,
      providerRequested: false,
      providerPreferenceExpressed: false,
    },
    ["provider-availability", "mixed-arabic-english"],
    "English presence question aimed at a named provider. A named provider in an availability question is still availability: it asks what is free and restricts nothing about who performs a service.",
    "holdout-v4",
    { languageHint: "English" },
  ),
  v2Fixture(
    "v4-hold-avail-after-six",
    "مين متاح من الدكاترة بعد الساعة ستة؟",
    {
      availabilityAsked: true,
      providerRequested: false,
      providerPreferenceExpressed: false,
    },
    ["provider-availability", "egyptian-arabic-variant"],
    "Availability over a TIME WINDOW with a plural title. The customer asks who is free, not to speak to any of them.",
    "holdout-v4",
  ),
  v2Fixture(
    "v4-hold-avail-friday",
    "هل فيه دكتور شغال الجمعة؟",
    {
      availabilityAsked: true,
      providerRequested: false,
      providerPreferenceExpressed: false,
      supportRequested: false,
    },
    ["provider-availability", "egyptian-arabic-variant"],
    "Availability as WORKING HOURS with a generic title. A weekday replaces the usual time-of-day phrasing; the relationship is unchanged.",
    "holdout-v4",
  ),

  // ── D. IDENTITY / INFORMATION — who the provider is, not a request ──────────
  // Following the bank's convention, a provider-identity question is
  // availability-shaped (it asks who is present / on the roster), and it is
  // never a preference and never a contact request.
  v2Fixture(
    "v4-hold-id-derm-name",
    "اسم دكتور الجلدية إيه؟",
    {
      availabilityAsked: true,
      providerRequested: false,
      providerPreferenceExpressed: false,
      supportRequested: false,
    },
    ["provider-identity", "egyptian-arabic-variant"],
    "Identity as a NAME question over a specialty. Asking who the provider is constrains nothing about who performs a requested service, because no service is requested.",
    "holdout-v4",
  ),
  v2Fixture(
    "v4-hold-id-who-peds",
    "مين الدكتورة اللي بتكشف أطفال؟",
    {
      availabilityAsked: true,
      providerRequested: false,
      providerPreferenceExpressed: false,
    },
    ["provider-identity", "egyptian-arabic-variant"],
    "Identity as a role question: which female provider sees children. Information only — there is no request to talk to her and no booking.",
    "holdout-v4",
  ),
  v2Fixture(
    "v4-hold-id-english-cardio",
    "Who is the cardiologist?",
    {
      availabilityAsked: true,
      providerRequested: false,
      providerPreferenceExpressed: false,
    },
    ["provider-identity", "mixed-arabic-english"],
    "English identity question over an unseen specialty. The same informational relationship as the Arabic identity pair.",
    "holdout-v4",
    { languageHint: "English" },
  ),
  v2Fixture(
    "v4-hold-id-branch-doctor",
    "مين الطبيب الموجود في الفرع ده؟",
    {
      availabilityAsked: true,
      providerRequested: false,
      providerPreferenceExpressed: false,
    },
    ["provider-identity", "egyptian-arabic-variant"],
    "Identity scoped to a BRANCH with the MSA word for physician («الطبيب»). Presence/roster information, not contact and not preference.",
    "holdout-v4",
  ),

  // ── E. PROVIDER PREFERENCE — a constraint on WHO performs a service ──────────
  // Preference without booking, preference inside booking, and the negative
  // control where NO constraint is expressed at all.
  v2Fixture(
    "v4-hold-pref-female-not-male",
    "لو فيه اختيار أفضل دكتورة مش دكتور",
    {
      providerPreferenceExpressed: true,
      bookingRequested: false,
      providerRequested: false,
      availabilityAsked: false,
    },
    ["provider-preference-plus-booking", "egyptian-arabic-variant"],
    "A conditional GENDER constraint with no booking and no contact. The customer narrows the acceptable provider set, so preference fires on a turn that asks for nothing else.",
    "holdout-v4",
  ),
  v2Fixture(
    "v4-hold-pref-sara-if-slot",
    "أفضل دكتورة سارة لو عندها ميعاد",
    {
      providerPreferenceExpressed: true,
      bookingRequested: false,
      providerRequested: false,
      availabilityAsked: false,
    },
    ["provider-preference-plus-booking", "egyptian-arabic-variant"],
    "A named preference with a conditional slot mention. Naming the provider inside a PREFERENCE does not make it a contact request, and the conditional does not make it a booking request.",
    "holdout-v4",
  ),
  v2Fixture(
    "v4-hold-pref-ahmed-exact",
    "عايز الحجز مع الدكتور أحمد تحديدًا",
    {
      bookingRequested: true,
      providerPreferenceExpressed: true,
      providerRequested: false,
      availabilityAsked: false,
    },
    ["booking-with-named-provider", "egyptian-arabic-variant"],
    "Booking with an EXPLICIT named constraint («تحديدًا»). Both facts fire and the booking mask keeps it off the handoff path.",
    "holdout-v4",
  ),
  v2Fixture(
    "v4-hold-pref-any-doctor",
    "أي دكتور ينفع، مش فارق معايا",
    {
      providerPreferenceExpressed: false,
      bookingRequested: false,
      providerRequested: false,
      availabilityAsked: false,
    },
    ["provider-title-without-request-cue", "egyptian-arabic-variant"],
    "The explicit ANTI-preference: the customer states the provider set is unconstrained. A title appears and no fact fires — the title alone must never be enough.",
    "holdout-v4",
  ),

  // ── F. SUPPORT / STAFF DIRECT REQUEST — a non-clinical person to intervene ──
  // Each row asks a staff/support role to act, so supportRequested fires and
  // the precedence hands off on the support branch alone.
  v2Fixture(
    "v4-hold-support-customer-service",
    "عايز أكلم خدمة العملاء",
    {
      supportRequested: true,
      providerRequested: false,
      bookingRequested: false,
    },
    ["explicit-human-only", "egyptian-arabic-variant"],
    "A direct customer-service request on unseen phrasing. The requested person is non-clinical, so the role separation from provider contact must hold.",
    "holdout-v4",
  ),
  v2Fixture(
    "v4-hold-support-employee-help",
    "ممكن موظف يساعدني؟",
    {
      supportRequested: true,
      providerRequested: false,
      bookingRequested: false,
    },
    ["explicit-human-only", "egyptian-arabic-variant"],
    "A polite request for an employee to help. A staff role plus a real request, on fresh wording of the historically repaired family.",
    "holdout-v4",
  ),
  v2Fixture(
    "v4-hold-support-reception-book",
    "عايز حد من الاستقبال يحجزلي",
    {
      supportRequested: true,
      bookingRequested: true,
      providerRequested: false,
      availabilityAsked: false,
    },
    ["explicit-human-plus-booking", "egyptian-arabic-variant"],
    "Support AND booking together: the staff request must win over the booking task, so the precedence hands off. Proves the support branch is not masked by booking.",
    "holdout-v4",
  ),
  v2Fixture(
    "v4-hold-support-english",
    "I need to talk to someone from support",
    {
      supportRequested: true,
      providerRequested: false,
      bookingRequested: false,
    },
    ["explicit-human-only", "mixed-arabic-english"],
    "English support request. «someone from support» is an unspecified non-clinical person, which is a support request and never a provider-contact request.",
    "holdout-v4",
    { languageHint: "English" },
  ),

  // ── G. AMBIGUOUS CONTACT-vs-BOOK — the clarification surface ────────────────
  // The family PROMPT §6 exists to measure. Rows 1–3 are BARE provider need:
  // no interaction verb and no arrangement verb. The frozen @v3 contract
  // excludes booking, availability, support and preference from all three,
  // and does not assert providerRequested either — a turn that names neither
  // an interaction nor an arrangement is exactly the contact-vs-book ambiguity
  // a future clarification step should resolve. Under the CURRENT precedence
  // that derives explicitHuman = false (failure to understand is not a
  // handoff), and the clarification analysis in the report classifies each as
  // a CLARIFICATION_CANDIDATE. Rows 4–5 carry an interaction verb («قابل» /
  // «see»), so the contract DOES resolve them to contact — measuring where the
  // boundary actually sits.
  v2Fixture(
    "v4-hold-ambig-need-doctor",
    "محتاج دكتور",
    {
      bookingRequested: false,
      availabilityAsked: false,
      supportRequested: false,
      providerPreferenceExpressed: false,
    },
    ["ambiguous-unsupported", "egyptian-arabic-variant"],
    "BARE provider need: a title with no interaction verb and no arrangement verb. The contract excludes every fact it can; providerRequested is intentionally UNSET because the message names neither a contact nor a booking.",
    "holdout-v4",
  ),
  v2Fixture(
    "v4-hold-ambig-can-doctor",
    "ممكن دكتور؟",
    {
      bookingRequested: false,
      availabilityAsked: false,
      supportRequested: false,
    },
    ["ambiguous-unsupported", "egyptian-arabic-variant"],
    "BARE provider need as a minimal permission question. Shorter still; the same unset-contact position and the same clarification surface.",
    "holdout-v4",
  ),
  v2Fixture(
    "v4-hold-ambig-want-the-doctor",
    "عايز الدكتور",
    {
      bookingRequested: false,
      availabilityAsked: false,
      supportRequested: false,
    },
    ["ambiguous-unsupported", "egyptian-arabic-variant"],
    "BARE provider want with a definite reference and no verb. Definiteness does not by itself establish a request for interaction.",
    "holdout-v4",
  ),
  v2Fixture(
    "v4-hold-ambig-meet-doctor",
    "عايز أقابل دكتور",
    {
      providerRequested: true,
      bookingRequested: false,
      availabilityAsked: false,
      supportRequested: false,
    },
    ["provider-direct-contact", "egyptian-arabic-variant"],
    "The verb-bearing half of the minimal pair: «أقابل» (meet) IS an interaction verb, so the @v3 contract resolves this to contact. One word apart from v4-hold-ambig-want-the-doctor, one relationship apart from v4-hold-book-derm.",
    "holdout-v4",
  ),
  v2Fixture(
    "v4-hold-ambig-english-see",
    "I need to be seen by a doctor",
    {
      providerRequested: true,
      bookingRequested: false,
      availabilityAsked: false,
    },
    ["provider-direct-contact", "mixed-arabic-english"],
    "The English verb-bearing half: 'be seen by a doctor' as the requested mode of resolution IS contact under the frozen contract. This is the phrasing a future clarification step is most likely to intercept.",
    "holdout-v4",
    { languageHint: "English" },
  ),

  // ── H. BOOKING + PROVIDER-TITLE COMBINATIONS — the mask cases ───────────────
  // Both facts true at once. The precedence folds booking into bookingTask,
  // which masks the provider path, so these route to NO handoff even though a
  // contact is genuinely present.
  v2Fixture(
    "v4-hold-mask-book-then-talk",
    "عايز أحجز كشف وبعدها أكلم الدكتور",
    {
      bookingRequested: true,
      providerRequested: true,
      availabilityAsked: false,
      supportRequested: false,
    },
    ["multi-intent", "provider-direct-contact", "egyptian-arabic-variant"],
    "Contact AFTER booking: the arrangement is the primary request and the conversation is sequenced after it. The mask must hold — this is the shape most sensitive to any weakening of the booking mask.",
    "holdout-v4",
  ),
  v2Fixture(
    "v4-hold-mask-talk-then-book",
    "عايز أكلم الدكتور الأول وبعدين نحجز",
    {
      providerRequested: true,
      bookingRequested: true,
      availabilityAsked: false,
      supportRequested: false,
    },
    ["multi-intent", "provider-direct-contact", "egyptian-arabic-variant"],
    "Contact BEFORE booking: the ORDER of the two intents is reversed but the mask is order-independent, because bookingTask is not a precedence over supportRequested — only over the provider path.",
    "holdout-v4",
  ),

  // ── I. MIXED LANGUAGE / CODE SWITCHING — the same relationships, bilingual ──
  v2Fixture(
    "v4-hold-mixed-book-ahmed",
    "عايز book appointment مع Dr Ahmed",
    {
      bookingRequested: true,
      providerRequested: false,
      providerPreferenceExpressed: true,
      availabilityAsked: false,
    },
    ["provider-preference-plus-booking", "mixed-arabic-english"],
    "Mixed booking: the English arrangement phrase carries the request and the named provider narrows the set. Code-switching must not blur the boundary.",
    "holdout-v4",
    { languageHint: MIXED_HINT },
  ),
  v2Fixture(
    "v4-hold-mixed-connect-her",
    "ممكن connect me بالدكتورة نفسها؟",
    {
      providerRequested: true,
      bookingRequested: false,
      providerPreferenceExpressed: false,
      supportRequested: false,
    },
    ["provider-direct-contact", "mixed-arabic-english"],
    "Mixed contact: the English connect verb carries the request and the Arabic definite provider is its target. The emphatic «نفسها» marks the contact's object, not a constraint on a service.",
    "holdout-v4",
    { languageHint: MIXED_HINT },
  ),
  v2Fixture(
    "v4-hold-mixed-avail-ahmed",
    "Dr Ahmed available النهارده؟",
    {
      availabilityAsked: true,
      providerRequested: false,
      providerPreferenceExpressed: false,
    },
    ["provider-availability", "mixed-arabic-english"],
    "Mixed availability: an English named-provider question with an Arabic day. The named provider in an availability question stays availability.",
    "holdout-v4",
    { languageHint: MIXED_HINT },
  ),
  v2Fixture(
    "v4-hold-mixed-maaid",
    "I want a موعد with دكتورة",
    {
      bookingRequested: true,
      providerRequested: false,
      providerPreferenceExpressed: true,
      availabilityAsked: false,
    },
    ["provider-preference-plus-booking", "mixed-arabic-english"],
    "Mixed booking with the Arabic noun for appointment and a gendered provider: the arrangement is the request and the gender narrows the provider set.",
    "holdout-v4",
    { languageHint: MIXED_HINT },
  ),

  // ── J. SENSITIVE TURNS WITH PRECEDENCE INTERACTIONS ─────────────────────────
  v2Fixture(
    "v4-hold-sensitive-pain-contact",
    "عندي ألم جامد وعايز أكلم الدكتور على طول",
    {
      providerRequested: true,
      bookingRequested: false,
      sensitiveTurn: true,
      availabilityAsked: false,
    },
    ["sensitive-turn", "provider-direct-contact", "egyptian-arabic-variant"],
    "Severe pain plus an immediate contact request. Sensitivity does not change the fact set: the contact branch still derives the handoff and no booking mask is present to block it.",
    "holdout-v4",
  ),
  v2Fixture(
    "v4-hold-sensitive-complaint-official",
    "عايز أعمل شكوى رسمية، ممكن حد مسؤول؟",
    {
      supportRequested: true,
      sensitiveTurn: true,
      providerRequested: false,
      bookingRequested: false,
    },
    ["sensitive-turn", "explicit-human-only", "egyptian-arabic-variant"],
    "A formal complaint asking for an official. The complaint makes the turn sensitive and the role request makes it a support request; the support branch carries the handoff.",
    "holdout-v4",
  ),

  // ── K. NEGATIVE CONTROLS — titles and roles that must NOT trigger anything ──
  v2Fixture(
    "v4-hold-neg-return-week",
    "الدكتور قال لي أرجع بعد أسبوع",
    {
      providerRequested: false,
      bookingRequested: false,
      availabilityAsked: false,
      supportRequested: false,
      providerPreferenceExpressed: false,
    },
    ["provider-title-without-request-cue", "egyptian-arabic-variant"],
    "A provider REPORTING a past instruction. The title appears inside a statement about a prior visit; nothing is being requested of anyone now.",
    "holdout-v4",
  ),
  v2Fixture(
    "v4-hold-neg-thanks-doctor",
    "شكراً يا دكتور",
    {
      supportRequested: false,
      providerRequested: false,
      bookingRequested: false,
      greetingOnly: false,
    },
    ["provider-title-without-request-cue", "egyptian-arabic-variant"],
    "Thanks addressed to a provider. It is not a social opening (greetingOnly is false) and it asks nothing of any person; the direct-address title must not become a contact request.",
    "holdout-v4",
  ),
  v2Fixture(
    "v4-hold-neg-price-of-exam",
    "عايز أعرف سعر كشف الدكتور",
    {
      serviceOrPriceAsked: true,
      providerRequested: false,
      bookingRequested: false,
      availabilityAsked: false,
      providerPreferenceExpressed: false,
    },
    ["price-question", "egyptian-arabic-variant"],
    "A price question about a provider's examination. «عايز أعرف» asks for information, so neither the wanting verb nor the title can turn it into contact or booking.",
    "holdout-v4",
  ),
  v2Fixture(
    "v4-hold-neg-help-times",
    "محتاج مساعدة في معرفة المواعيد",
    {
      availabilityAsked: true,
      bookingRequested: false,
      supportRequested: false,
    },
    [
      "availability",
      "broad-support-role-false-positive",
      "egyptian-arabic-variant",
    ],
    "The broad-role false-positive probe: «مساعدة» appears as a TOPIC of need, not as a request for a person to act, while the actual question is about the schedule. supportRequested must stay false and availability carries the turn.",
    "holdout-v4",
  ),
  v2Fixture(
    "v4-hold-neg-manager-hours",
    "المدير قال العيادة بتفتح الساعة تسعة",
    {
      supportRequested: false,
      providerRequested: false,
      bookingRequested: false,
      availabilityAsked: false,
      serviceOrPriceAsked: false,
    },
    ["broad-support-role-false-positive", "egyptian-arabic-variant"],
    "A manager RELAYING business information in a statement. No question is asked and no person is requested; the role mention is pure topic and every fact must stay false.",
    "holdout-v4",
  ),
  v2Fixture(
    "v4-hold-neg-pure-greeting",
    "نهارك سعيد",
    {
      greetingOnly: true,
      ambiguousTurn: false,
      bookingRequested: false,
      supportRequested: false,
      providerRequested: false,
    },
    ["pure-greeting", "egyptian-arabic-variant"],
    "A social opening carrying real greeting content and nothing else. A supported response exists (the assistant greets back), so it is not ambiguous.",
    "holdout-v4",
  ),
  // ── L. MODERN STANDARD ARABIC — the same relationships in a high register ──
  // The interrupted holdout-v3 pass never measured an MSA contact or booking
  // case; this family closes that gap on fresh phrasing.
  v2Fixture(
    "v4-hold-msa-contact-direct",
    "أرغب في التحدث مع الطبيب مباشرة",
    {
      providerRequested: true,
      bookingRequested: false,
      supportRequested: false,
    },
    ["provider-direct-contact", "msa-variant"],
    "MSA contact: «أرغب في التحدث» is a wanting verb over a speaking verb, so the interaction is the request. The high register must not change the relationship.",
    "holdout-v4",
    { languageHint: MSA_HINT },
  ),
  v2Fixture(
    "v4-hold-msa-booking-titled",
    "أرغب في حجز موعد مع طبيب الأسنان",
    {
      bookingRequested: true,
      providerRequested: false,
      providerPreferenceExpressed: true,
      availabilityAsked: false,
    },
    ["provider-preference-plus-booking", "msa-variant"],
    "MSA booking with a specialty title. The arrangement verb carries the request and the specialty narrows the provider set.",
    "holdout-v4",
    { languageHint: MSA_HINT },
  ),
  v2Fixture(
    "v4-hold-msa-availability-named",
    "هل الدكتور متفرغ غداً؟",
    {
      availabilityAsked: true,
      providerRequested: false,
      providerPreferenceExpressed: false,
    },
    ["provider-availability", "msa-variant"],
    "MSA availability aimed at a named provider with a formal freeness adjective («متفرغ»). Asking whether he is free is not asking to speak with him.",
    "holdout-v4",
    { languageHint: MSA_HINT },
  ),
  v2Fixture(
    "v4-hold-msa-support-official",
    "أرغب في التحدث مع أحد المسؤولين",
    {
      supportRequested: true,
      providerRequested: false,
      bookingRequested: false,
    },
    ["explicit-human-only", "msa-variant"],
    "MSA support: «أحد المسؤولين» is an unspecified OFFICIAL, a non-clinical role, so the support branch fires and the provider fact must stay false.",
    "holdout-v4",
    { languageHint: MSA_HINT },
  ),
  v2Fixture(
    "v4-hold-msa-cancel",
    "أود إلغاء موعدي القادم",
    {
      cancellationRequested: true,
      bookingRequested: false,
      providerRequested: false,
    },
    ["cancellation", "msa-variant"],
    "MSA cancellation: removing an existing appointment with no alternative proposed. Not a new booking and not a change.",
    "holdout-v4",
    { languageHint: MSA_HINT },
  ),
  v2Fixture(
    "v4-hold-msa-reschedule",
    "هل يمكن تأجيل موعدي إلى الأسبوع القادم؟",
    {
      rescheduleRequested: true,
      bookingRequested: false,
      providerRequested: false,
    },
    ["reschedule", "msa-variant"],
    "MSA reschedule: moving an existing appointment to a proposed alternative week. A different time is asked for, so this is a change and not a cancellation.",
    "holdout-v4",
    { languageHint: MSA_HINT },
  ),
  v2Fixture(
    "v4-hold-msa-service-ask",
    "ما هي الخدمات التي تقدمها العيادة؟",
    {
      serviceOrPriceAsked: true,
      bookingRequested: false,
      providerRequested: false,
    },
    ["service-question", "msa-variant"],
    "MSA service information request. Pure information; no provider and no arrangement.",
    "holdout-v4",
    { languageHint: MSA_HINT },
  ),
  v2Fixture(
    "v4-hold-msa-out-of-domain",
    "ما حالة الطقس اليوم؟",
    {
      ambiguousTurn: true,
      bookingRequested: false,
      supportRequested: false,
      serviceOrPriceAsked: false,
    },
    ["ambiguous-unsupported", "unknown-residual", "msa-variant"],
    "MSA out-of-domain question: the weather. No supported action exists, so the turn is ambiguous and nothing else fires.",
    "holdout-v4",
    { languageHint: MSA_HINT },
  ),

  // ── M. RESIDUAL CONTROLS — greeting-plus-unknown and sensitivity alone ─────
  v2Fixture(
    "v4-hold-greeting-plus-open-question",
    "السلام عليكم، عندي سؤال",
    {
      greetingOnly: false,
      bookingRequested: false,
      supportRequested: false,
      providerRequested: false,
    },
    ["greeting-plus-unknown-residual", "egyptian-arabic-variant"],
    "A real greeting followed by an unspecified question. The greeting content exists but a task follows, so greetingOnly is false and no other fact is asserted — the residual the assistant must clarify.",
    "holdout-v4",
  ),
  v2Fixture(
    "v4-hold-sensitive-complaint-only",
    "أشعر بألم في أسناني منذ يومين",
    {
      sensitiveTurn: true,
      bookingRequested: false,
      providerRequested: false,
      supportRequested: false,
    },
    ["sensitive-no-booking", "sensitive-turn", "egyptian-arabic-variant"],
    "Symptoms with NO request attached. The turn is sensitive, but sensitivity alone requests nothing: no booking, no provider, no staff, so the precedence derives NO handoff. This is the control that proves a low-confidence or sensitive turn does not by itself route to a human.",
    "holdout-v4",
  ),
];

// ─── 3f. The assembled slices and selectors ───────────────────────────────────

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
 * The full PROMPT-AI-JEV-02B bank: every frozen slice plus the two new ones.
 * The PROMPT-AI-JEV-02 slices are UNCHANGED and remain a PREFIX, so every
 * fingerprint and every historical artifact stays valid.
 */
export const JEV_FIXTURES_V3: ReadonlyArray<JevFixture> = [
  ...JEV_FIXTURES,
  ...JEV_CALIBRATION_FIXTURES,
  ...JEV_HOLDOUT_FIXTURES,
  ...JEV_CALIBRATION_V3_FIXTURES,
  ...JEV_HOLDOUT_V3_FIXTURES,
];

/**
 * The full PROMPT-AI-JEV-02B-R bank: every frozen slice plus holdout-v4.
 * JEV_FIXTURES_V3 remains defined and unchanged (it is the bank the
 * PROMPT-AI-JEV-02B artifacts were bound to); this is its superset and the
 * default the integrity and coverage helpers now guard.
 */
export const JEV_FIXTURES_V4: ReadonlyArray<JevFixture> = [
  ...JEV_FIXTURES,
  ...JEV_CALIBRATION_FIXTURES,
  ...JEV_HOLDOUT_FIXTURES,
  ...JEV_CALIBRATION_V3_FIXTURES,
  ...JEV_HOLDOUT_V3_FIXTURES,
  ...JEV_HOLDOUT_V4_FIXTURES,
];

/**
 * The mechanical slice separator (§8.6). Every holdout is reachable ONLY
 * through its own selector, so a calibration loop that iterates the default
 * bank never touches either frozen holdout.
 */
export function bankSubset(
  slice: BankSlice,
  fixtures: ReadonlyArray<JevFixture> = JEV_FIXTURES_V4,
): ReadonlyArray<JevFixture> {
  return fixtures.filter((f) => f.bank === slice);
}

/** Every slice fingerprinted, so a frozen set is provably identified. */
export function sliceFingerprints(): Record<BankSlice, string> {
  return {
    original: sliceFingerprint(bankSubset("original")),
    calibration: sliceFingerprint(bankSubset("calibration")),
    holdout: sliceFingerprint(bankSubset("holdout")),
    "calibration-v3": sliceFingerprint(bankSubset("calibration-v3")),
    "holdout-v3": sliceFingerprint(bankSubset("holdout-v3")),
    "holdout-v4": sliceFingerprint(bankSubset("holdout-v4")),
  };
}

/**
 * All fixture ids are unique and all messages are unique (globally), across
 * every slice including the recovery holdout. Defaults to the full
 * PROMPT-AI-JEV-02B-R bank so the disjointness of holdout-v4 is guarded by
 * the same check that guards the frozen slices.
 */
export function bankIntegrity(
  fixtures: ReadonlyArray<JevFixture> = JEV_FIXTURES_V4,
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
  fixtures: ReadonlyArray<JevFixture> = JEV_FIXTURES_V4,
): number {
  return fixtures.length;
}

/** Coverage report: which classes are satisfied, and by how many cases. */
export function classCoverage(
  fixtures: ReadonlyArray<JevFixture> = JEV_FIXTURES_V4,
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
  fixtures: ReadonlyArray<JevFixture> = JEV_FIXTURES_V4,
): { complete: boolean; missing: FixtureClass[] } {
  const coverage = classCoverage(fixtures);
  const missing = fixtureClassValues.filter((c) => coverage[c] === 0);
  return { complete: missing.length === 0, missing };
}
