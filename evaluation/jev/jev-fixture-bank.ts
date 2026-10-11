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
  "service-question",
  "price-question",
  "sensitive-turn",
  "ambiguous-unsupported",
  "mixed-arabic-english",
  "egyptian-arabic-variant",
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
  /** The bounded business context the state carries. */
  readonly businessName: string;
  readonly services: ReadonlyArray<string>;
  readonly faqs: ReadonlyArray<string>;
  readonly languageHint: string;
};

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
  fixtures: ReadonlyArray<JevFixture> = JEV_FIXTURES,
): number {
  return fixtures.length;
}

/** Coverage report: which classes are satisfied, and by how many cases. */
export function classCoverage(
  fixtures: ReadonlyArray<JevFixture> = JEV_FIXTURES,
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
  fixtures: ReadonlyArray<JevFixture> = JEV_FIXTURES,
): { complete: boolean; missing: FixtureClass[] } {
  const coverage = classCoverage(fixtures);
  const missing = fixtureClassValues.filter((c) => coverage[c] === 0);
  return { complete: missing.length === 0, missing };
}
