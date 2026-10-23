/**
 * JEV SEMANTIC decision strategy — PROMPT-AI-JEV-03B §4/§5/§6/§7.
 *
 * The production semantic strategy identified by PROMPT-AI-JEV-03A (OPTION B —
 * REPLACE, DON'T CHAIN). It is an OPTIONAL strategy behind the EXISTING
 * provider gateway; the gateway (`orchestrator.ts`) keeps owning the
 * model-call budget. For one logical turn exactly one of three routes fires:
 *
 *     deterministic route : 0 model calls (the proven 0-call bypass)
 *     JEV semantic route  : exactly 1 JEV call, 0 LLM calls   ← this strategy
 *     generative route    : 0 JEV calls, exactly 1 existing LLM call
 *
 * NEVER: JEV → LLM, LLM → JEV, a mandatory JEV stage, a hidden second model
 * call behind a fallback, a second resolver, or a judge.
 *
 *
 * WHAT THIS STRATEGY OWNS (and everything it does NOT)
 *
 *  It owns ONLY:
 *   1. the PURE deterministic PRE-CALL eligibility rule (zero model calls);
 *   2. the ONE JEV model call (through `jev-decisions-provider.ts`);
 *   3. production copies of the frozen P1/P2 probability→fact semantics;
 *   4. mapping the validated semantic facts into an `AiResponse`-compatible
 *      PROPOSAL whose customer-facing text is always a fixed engine-owned
 *      template (`deterministicReplyForIntent`), never model prose.
 *
 *  It does NOT own (and never performs):
 *   - domain execution, booking mutation, handoff mutation, customer send,
 *     DB write;
 *   - the Turn Planner or the final action authority — it PROPOSES semantic
 *     facts/signals and the ONE resolver (`turn-planner.ts`) decides;
 *   - a second resolver, a judge, or any second model call.
 *
 *
 * THE PRE-CALL ELIGIBILITY GATE (§5) — this strategy can NEVER become a
 * mandatory stage. A turn is JEV-eligible only when ALL of the following hold:
 *
 *   1. `bypassDeterministicAi(request) === null` — the deterministic 0-call
 *      path does NOT resolve the turn (if it does, JEV is INELIGIBLE and the
 *      turn terminates with 0 model calls).
 *   2. the assembled, already-task-gated `AiRequest` carries NO quotable
 *      authoritative answer fact — no strong FAQ match, no carried service
 *      price, no carried service description, no `businessAbout`, no
 *      `businessAddress`, no domain-computed availability. Such a turn
 *      requires the LLM to AUTHOR a grounded knowledge/business answer, so it
 *      stays on the generative route.
 *
 * The gate asks the product question "does this turn require the LLM to
 * author a grounded knowledge/business answer?" — it does NOT use
 * `deriveTaskRelevance` or lexical service-word matching as an authority, and
 * it performs ZERO model calls.
 *
 *
 * FAIL-CLOSED SEMANTICS (§7) — after a JEV attempt has been SPENT, the turn
 * NEVER falls through to the LLM. A timeout, a network/provider failure, a
 * malformed response, a missing required semantic field, an impossible
 * semantic combination or an unsupported fact terminates the turn on the
 * DETERMINISTIC LEXICAL BASELINE (`classifyCustomerMessage`): 1 JEV attempt,
 * 0 LLM calls, total budget 1. Malformed or unsupported content is never
 * coerced into a semantic fact; no booking and no handoff is ever silently
 * created. The ONLY way a turn still reaches the LLM is a PRE-ATTEMPT
 * unavailability (a missing credential), which spends zero network calls.
 *
 *
 * PRODUCTION ISOLATION (§13) — this module imports ZERO runtime code from
 * `evaluation/*`. The frozen artifacts are spent evidence only. The P1/P2
 * semantics and the question contract are implemented here independently, as
 * production code.
 */

import type {
  AiIntent,
  AiRequest,
  AiResponse,
} from "@/features/conversations/server/ai-contract";
import {
  bookingTaskFromFamily,
  bypassDeterministicAi,
  classifyCustomerMessage,
  deterministicReplyForIntent,
  explicitHumanFromFacts,
  extractServiceFacts,
  strongFaqMatch,
} from "@/features/conversations/server/conversation-ai";

import type {
  JevAnswer,
  JevDecisionsProvider,
  JevDecisionsResult,
  JevEvaluationRequest,
  JevQuestion,
} from "./jev-decisions-provider";
import { jevDecisionFromProvenResponse } from "./jev-strategy";
import type { JevDecision, JevDecisionReason } from "./jev-strategy";
import type { AiCallOptions } from "./types";

// ─── 1. The production question contract (the approved semantics) ─────────────
//
// The closed fact set the semantic model is asked: eleven independent atomic
// facts plus the ONE bounded `conversationGoal` choice. The semantics are the
// approved ones (role disjointness between staff and provider, the
// contact-vs-book minimal pair, the availability/presence exclusions, the
// greeting-content boundary). Every question is ATOMIC and INDEPENDENT; the
// server precedence is deliberately NOT a question — Jev supplies FACTS and
// the server owns precedence (AI-SEM-02).

/**
 * The stable key of every question in the production contract. These are the
 * SAME closed keys the frozen evaluation vocabulary used, kept identical so a
 * future observable maps 1:1; the implementation here owns its own wording.
 */
export const jevSemanticQuestionKeys = [
  "supportRequested",
  "providerRequested",
  "bookingRequested",
  "availabilityAsked",
  "cancellationRequested",
  "rescheduleRequested",
  "providerPreferenceExpressed",
  "sensitiveTurn",
  "serviceOrPriceAsked",
  "greetingOnly",
  "ambiguousTurn",
  "conversationGoal",
] as const;

export type JevSemanticQuestionKey = (typeof jevSemanticQuestionKeys)[number];

export const SEMANTIC_QUESTION_CONTRACT_ID = "flowpilot.jev-semantic@v1";

export const SEMANTIC_QUESTIONS: Readonly<
  Record<JevSemanticQuestionKey, JevQuestion>
> = {
  supportRequested: {
    type: "noul",
    instructions:
      "The customer is asking for a NON-CLINICAL person to intervene — to be connected to, transferred to, or to speak with staff, support, customer service, a manager, a secretary, a receptionist, an official, or any administrative person rather than the automated assistant. TRUE only when the turn carries an actual REQUEST for such a person to intervene, by any role or phrasing. A request to reach a PROVIDER — a doctor, dentist, specialist or any clinician the customer wants to consult — is NOT this question: provider contact is the separate provider-contact fact, and the two must stay role-disjoint. Mentioning a role or a help-related word as a TOPIC, a compliment, thanks, or news is NOT a request. A booking or information turn that never asks for a person stays FALSE even when a role word appears.",
    criteria: {
      true: "The customer asks a staff, support or administrative person to intervene, take over, or be reached — a request for human action, by any such role or phrasing.",
      false:
        "The turn addresses the assistant itself, asks to reach a PROVIDER (clinician) instead of staff, or mentions a role or help only as a topic, a compliment, thanks, or news, with no request for a person to act.",
    },
  },
  providerRequested: {
    type: "noul",
    instructions:
      "The customer is asking to DIRECTLY COMMUNICATE WITH a provider or professional — a doctor, dentist, specialist or any CLINICIAN who delivers the service. TRUE only when the turn asks for two-way personal contact with that person: to SPEAK with, TALK to, SEE, MEET, be TRANSFERRED to, be CONNECTED to, or be CALLED BACK by a provider, where that interaction ITSELF is what the customer is asking for. A provider title by itself NEVER makes this true. This is FALSE when the customer merely: books or schedules an appointment with a provider; asks whether a provider is AVAILABLE, free, present, or working; expresses a PREFERENCE for which provider they would see; asks a provider's NAME, identity, or information; or asks about the business through a provider's name. The distinction is the RELATIONSHIP, not the vocabulary, and it is not altered by mixing languages: 'I want to speak with a doctor' and 'I want to book with a doctor' mention the same title, but only the first asks for contact. Wanting to SEE a provider as the requested mode of resolution — with NO appointment, slot or arrangement asked for — IS contact; asking to ARRANGE an appointment whose PURPOSE is to see a provider is NOT contact.",
    criteria: {
      true: "The customer asks for a personal, two-way interaction with a clinician — speak, talk, see, meet, be connected, transferred, or called back by that provider — where the interaction itself is the request.",
      false:
        "The turn only books, schedules, asks availability or presence, expresses a provider preference, identifies a provider, or asks to arrange an appointment in order to later see a provider. A provider title inside any of those is not a request for contact.",
    },
  },
  bookingRequested: {
    type: "noul",
    instructions:
      "The customer is asking to BOOK, RESERVE, SCHEDULE or CREATE a new appointment — to have a NEW commitment arranged. TRUE only when the turn asks for an ARRANGEMENT to be made: an appointment, a reservation, a slot held, a time set. The request must be for the ARRANGEMENT ITSELF. Asking WHEN a slot is free, or whether booking is possible, is not itself a booking request. Describing symptoms, pain, urgency or a condition is not a booking request either, even when the customer plainly needs care; the request to book must be asked for. Changing, moving or cancelling an appointment that already exists is NOT a new booking. Crucially, merely WANTING TO SEE, SPEAK WITH or MEET a provider is NOT a booking, even though an appointment would be the usual way to get there: 'I want to see a doctor' asks for the INTERACTION, not for an arrangement. Only when the customer asks to ARRANGE something is this TRUE.",
    criteria: {
      true: "The customer wants a new appointment, reservation or slot arranged for them.",
      false:
        "The customer is only asking about availability, is only describing a condition or symptoms, is asking about an appointment they already have, or only wants to see, speak with or meet a provider without asking for any arrangement to be made.",
    },
  },
  availabilityAsked: {
    type: "noul",
    instructions:
      "The customer is ASKING WHETHER something can be booked, is FREE, is AVAILABLE, is OPEN, or is PRESENT — an appointment slot, a time, a date, a day, a service, or a provider. TRUE only for a QUESTION about bookability or presence. The customer is not yet committing to book; they are asking what is possible. Asking whether a provider is available is an AVAILABILITY question, not a request to communicate with that provider. Crucially, a REQUEST to personally SEE, SPEAK with or MEET a provider is NOT an availability question, even though the customer implicitly needs the provider to be free: 'I need to see a doctor' is a request for the interaction, not a question about what is open. Only a turn that ASKS whether something is free, open, present or bookable is TRUE here.",
    criteria: {
      true: "The customer asks whether something is free, open, present, or bookable.",
      false:
        "The customer is ready to book right now, asks to personally see/speak/meet a provider rather than asking whether one is free, or is not asking about bookability, presence or times at all.",
    },
  },
  cancellationRequested: {
    type: "noul",
    instructions:
      "The customer is asking to CANCEL, revoke, withdraw or NOT ATTEND an existing appointment. TRUE when the turn removes or declines an existing appointment WITHOUT proposing an alternative time — including stating they cannot make it, will not come, or want it gone. If the customer also proposes or asks for a different time, the turn is a change request rather than a pure cancellation.",
    criteria: {
      true: "The customer wants an existing appointment removed, or states they cannot attend it, without proposing an alternative time.",
      false:
        "The customer wants to move an appointment to another time, wants a brand-new appointment, or is merely asking about an appointment.",
    },
  },
  rescheduleRequested: {
    type: "noul",
    instructions:
      "The customer is asking to CHANGE, MOVE, POSTPONE or RESCHEDULE an appointment they already have. TRUE when the turn asks for an EXISTING appointment at a DIFFERENT time — including offering an alternative, asking for another slot, or deferring without a precise new time. Stating they cannot attend WITHOUT any alternative or different-time intent is a cancellation, not a change. Booking something brand new is not a change.",
    criteria: {
      true: "The customer wants an existing appointment moved to a different time.",
      false:
        "The customer wants a brand-new appointment, is cancelling without any different-time intent, or is not asking about an existing one.",
    },
  },
  providerPreferenceExpressed: {
    type: "noul",
    instructions:
      "The turn places a CONSTRAINT on WHICH provider performs a SERVICE OR BOOKING the customer is requesting — a specific provider by NAME, or a provider by GENDER, TITLE, SPECIALTY, seniority, or language. This is a constraint on the SERVICE and is NEVER automatically a request to communicate with that provider: 'book with a doctor' expresses a preference, while 'let me speak to a doctor' asks for contact. Asking whether a provider is AVAILABLE or PRESENT is NOT a preference, whether the provider is NAMED or merely described generically: an availability question asks what is FREE and restricts nothing about who performs the service. A provider mentioned only to IDENTIFY the business is not a preference either. The test is whether the turn narrows the SET OF PROVIDERS who may perform a requested service.",
    criteria: {
      true: "The customer states which provider, or which kind of provider, they would prefer to perform a service or booking they are requesting, narrowing the set of acceptable providers.",
      false:
        "The turn names no provider, names one only to identify the business, only asks whether a provider is available or present (named or generic), or is asking to communicate with a provider (a contact request, not a preference).",
    },
  },
  sensitiveTurn: {
    type: "noul",
    instructions:
      "The turn is sensitive, urgent or high-stakes: urgent physical symptoms, an emergency, severe pain, a formal complaint, legal language, or significant distress. TRUE when the message describes urgency, harm, emergency, complaint or distress that warrants immediate human attention.",
    criteria: {
      true: "The message describes urgency, harm, emergency, complaint or distress that warrants immediate human attention.",
      false:
        "The message is an ordinary scheduling, information or greeting turn.",
    },
  },
  serviceOrPriceAsked: {
    type: "noul",
    instructions:
      "The customer is asking about the SERVICES the business offers, or about the COST or PRICE of a service. TRUE when the customer wants information about a service or its price, including what the business does, what a treatment costs, or opening hours as business information.",
    criteria: {
      true: "The customer wants information about a service, its price, or the business itself.",
      false:
        "The customer is asking to book, or is asking something unrelated to services and prices.",
    },
  },
  greetingOnly: {
    type: "noul",
    instructions:
      "The message is purely a social greeting or opening — a hello, a time-of-day greeting, a wellbeing pleasantry — and carries no request, question or task at all. TRUE when the whole message is a social opening that actually contains GREETING CONTENT. A bare hesitation, filler or minimal vocalization is NOT a greeting: it carries no greeting content and no task, and such a fragment falls to the ambiguity question instead. A greeting followed by any request, question or task makes this FALSE.",
    criteria: {
      true: "The whole message is a social opening, carrying actual greeting content and no task behind it.",
      false:
        "The message contains a greeting but also carries a request, question or task, or is only a hesitation or filler with no greeting content at all.",
    },
  },
  ambiguousTurn: {
    type: "noul",
    instructions:
      "The message is too short, vague or fragmentary to map to ANY supported action — the assistant has no defensible response available. A turn that a booking assistant CAN respond to is not ambiguous, even when it carries no task: a social greeting is supported (the assistant greets back), so a greeting-only turn is NOT ambiguous. This asks whether ANY supported action exists at all, not whether the intent is perfectly clear.",
    criteria: {
      true: "There is not enough information to identify any supported action, or the topic is entirely out of domain.",
      false:
        "A supported response exists — a clear request or question is present, or the turn is a recognizable social greeting.",
    },
  },
  conversationGoal: {
    type: "choice",
    instructions:
      "Which ONE bounded conversation goal best matches what the customer wants from this message? This is EVIDENCE about the turn's dominant goal only — it is never a routing instruction, and the server precedence formula always decides the action.",
    criteria: {
      greeting:
        "A social opening only; the customer is starting the conversation and asking for nothing yet.",
      booking: "Create a new appointment.",
      availability:
        "Find out what times or dates are free, or whether a provider or service is available.",
      reschedule: "Move an existing appointment.",
      cancellation: "Cancel an existing appointment.",
      human_handoff:
        "Reach a human person: staff, support, or a specific professional to communicate with.",
      service_info: "Ask about a service, its price, or the business itself.",
      ambiguous: "Not enough information to identify a supported goal.",
    },
  },
};

// ─── 2. The frozen P1/P2 semantics — production copies (§4.3) ─────────────────

/**
 * RULE P1 — the default orientation is 0.5 and it is not moved globally:
 *
 *     fact = probability >= 0.5
 *
 * A Noul returns P(yes); the neutral orientation is the even point. Absent
 * answers become `null` facts (never coerced to false), so a missing answer is
 * never treated as a negative.
 */
export const JEV_POLICY_THRESHOLD = 0.5;

/**
 * RULE P2 — booking-task family competition (argmax), routing-neutral. The
 * four facts are one task family: the server precedence folds them into a
 * single `bookingTask` mask. When two or more cross the threshold in the same
 * turn, the model is split between adjacent readings of ONE task, not
 * asserting two tasks — so among family members at or above the threshold,
 * only the argmax is kept. This is routing-neutral (`bookingTask` is true
 * whichever member wins) and selects by ordering, never by a tuned cut point.
 */
export const JEV_BOOKING_TASK_FAMILY: ReadonlyArray<JevSemanticQuestionKey> = [
  "bookingRequested",
  "availabilityAsked",
  "cancellationRequested",
  "rescheduleRequested",
];

/**
 * RULE P3 — confidence banding (REPORTING ONLY; never changes a fact):
 *
 *     high     p >= 0.85  or  p <= 0.15
 *     moderate 0.60 <= p < 0.85  or  0.15 < p <= 0.40
 *     low      0.40 < p < 0.60
 */
export const JEV_CONFIDENCE_HIGH_EDGE = 0.85;
export const JEV_CONFIDENCE_MODERATE_EDGE = 0.6;

export type FactConfidence = "high" | "moderate" | "low";

export function bandConfidence(probability: number): FactConfidence {
  if (
    probability >= JEV_CONFIDENCE_HIGH_EDGE ||
    probability <= 1 - JEV_CONFIDENCE_HIGH_EDGE
  )
    return "high";
  if (
    probability >= JEV_CONFIDENCE_MODERATE_EDGE ||
    probability <= 1 - JEV_CONFIDENCE_MODERATE_EDGE
  )
    return "moderate";
  return "low";
}

/**
 * The derived semantic facts (P1 + P2 applied). Every fact is `true`, `false`
 * or `null` (absent — never coerced). `bookingTask` and `explicitHuman` are
 * derived through the SAME shared server-owned derivations the lexical path
 * uses, so the two paths can never apply different formulas.
 */
export type SemanticFacts = {
  readonly supportRequested: boolean | null;
  readonly providerRequested: boolean | null;
  readonly bookingRequested: boolean | null;
  readonly availabilityAsked: boolean | null;
  readonly cancellationRequested: boolean | null;
  readonly rescheduleRequested: boolean | null;
  readonly providerPreferenceExpressed: boolean | null;
  readonly sensitiveTurn: boolean | null;
  readonly serviceOrPriceAsked: boolean | null;
  readonly greetingOnly: boolean | null;
  readonly ambiguousTurn: boolean | null;
  /** The folded booking-task mask (P2 winner included, suppressed members out). */
  readonly bookingTask: boolean;
  /** The shared server precedence verdict (AI-SEM-02). */
  readonly explicitHuman: boolean;
};

function noulProbability(
  answers: Readonly<Record<string, JevAnswer>>,
  key: string,
): number | null {
  const answer = answers[key];
  if (!answer || answer.type !== "noul") return null;
  if (Number.isNaN(answer.noul)) return null;
  return answer.noul;
}

/**
 * Apply P1 (orientation 0.5) then P2 (booking-family argmax). Pure, total,
 * zero model calls.
 */
export function deriveSemanticFacts(
  answers: Readonly<Record<string, JevAnswer>>,
): SemanticFacts {
  const probabilities: Record<string, number | null> = {};
  for (const key of jevSemanticQuestionKeys) {
    if (key === "conversationGoal") continue;
    probabilities[key] = noulProbability(answers, key);
  }

  // ── P2: booking-task family competition (argmax among members ≥ 0.5). ──────
  const familyOverThreshold = JEV_BOOKING_TASK_FAMILY.filter(
    (key) =>
      probabilities[key] !== null &&
      (probabilities[key] as number) >= JEV_POLICY_THRESHOLD,
  );
  const familyWinner =
    familyOverThreshold.length > 1
      ? familyOverThreshold.reduce((a, b) =>
          (probabilities[b] as number) > (probabilities[a] as number) ? b : a,
        )
      : null;

  const fact = (key: JevSemanticQuestionKey): boolean | null => {
    // `noUncheckedIndexedAccess`: an absent key reads as `undefined`, which is
    // a NULL fact (never coerced to a negative) exactly like an unanswered
    // question.
    const probability = probabilities[key];
    if (probability === null || probability === undefined) return null;
    if (familyWinner !== null && key !== familyWinner) {
      return familyOverThreshold.includes(key)
        ? false
        : probability >= JEV_POLICY_THRESHOLD;
    }
    return probability >= JEV_POLICY_THRESHOLD;
  };

  const bookingRequested = fact("bookingRequested");
  const availabilityAsked = fact("availabilityAsked");
  const cancellationRequested = fact("cancellationRequested");
  const rescheduleRequested = fact("rescheduleRequested");

  const bookingTask = bookingTaskFromFamily({
    bookingRequested: bookingRequested ?? false,
    availabilityAsked: availabilityAsked ?? false,
    cancellationRequested: cancellationRequested ?? false,
    rescheduleAsked: rescheduleRequested ?? false,
  });

  const supportRequested = fact("supportRequested");
  const providerRequested = fact("providerRequested");

  return {
    supportRequested,
    providerRequested,
    bookingRequested,
    availabilityAsked,
    cancellationRequested,
    rescheduleRequested,
    providerPreferenceExpressed: fact("providerPreferenceExpressed"),
    sensitiveTurn: fact("sensitiveTurn"),
    serviceOrPriceAsked: fact("serviceOrPriceAsked"),
    greetingOnly: fact("greetingOnly"),
    ambiguousTurn: fact("ambiguousTurn"),
    bookingTask,
    explicitHuman: explicitHumanFromFacts({
      supportRequest: supportRequested ?? false,
      providerRequest: providerRequested ?? false,
      bookingTask,
    }),
  };
}

// ─── 3. The PURE pre-call eligibility gate (§5) ───────────────────────────────

export const jevEligibilityReasonValues = [
  "ELIGIBLE",
  /** Turn requires structured interpretation capability (generative route required). */
  "CAPABILITY_STRUCTURED_TURN",
  /** The deterministic 0-call path already resolves this turn. */
  "DETERMINISTIC_BYPASS_RESOLVED",
  /** A strong stored-FAQ match: the LLM must quote the stored answer. */
  "QUOTABLE_FAQ_ANSWER",
  /** A carried service price: the LLM must quote the stored price. */
  "QUOTABLE_SERVICE_PRICE",
  /** A carried service description: the LLM must quote the stored copy. */
  "QUOTABLE_SERVICE_DESCRIPTION",
  /** A carried business "about" description: the LLM must quote it. */
  "QUOTABLE_BUSINESS_ABOUT",
  /** A carried business address: the LLM must quote it. */
  "QUOTABLE_BUSINESS_ADDRESS",
  /** Domain-computed availability results: the LLM must present the offer. */
  "QUOTABLE_AVAILABILITY",
] as const;

export type JevEligibilityReason = (typeof jevEligibilityReasonValues)[number];

export type JevEligibility = {
  readonly eligible: boolean;
  readonly reason: JevEligibilityReason;
};

/**
 * The deterministic pre-call eligibility rule. PURE, total, performs ZERO
 * model calls and ZERO network I/O. It reads only the already-assembled,
 * already-task-gated `AiRequest` and its authoritative available facts — it
 * never runs `deriveTaskRelevance` and never does lexical service-word
 * matching as an authority.
 *
 * The decision it answers is "does this turn require the LLM to author a
 * grounded knowledge/business answer?" — if yes, the turn is INELIGIBLE for
 * JEV and stays on the generative route; if no, the bounded semantic-routing
 * class may own the turn.
 */
export function jevEligibility(request: AiRequest): JevEligibility {
  // CORE-03B2A: Free-form turns requiring structured interpretation
  // must reach the generative structured-output assistant.
  if (request.requiredSemanticCapability === "structured_turn") {
    return { eligible: false, reason: "CAPABILITY_STRUCTURED_TURN" };
  }
  // 1. The deterministic 0-call path resolves the turn → JEV is INELIGIBLE and
  //    the turn terminates deterministically with zero model calls.
  if (bypassDeterministicAi(request) !== null) {
    return { eligible: false, reason: "DETERMINISTIC_BYPASS_RESOLVED" };
  }
  // 2. A quotable authoritative answer fact is carried → the LLM must AUTHOR
  //    the grounded answer, so the turn stays generative. Each family is an
  //    existing, already-established authoritative quotable field — no new
  //    product field is invented here.
  if (
    request.faqs.length > 0 &&
    strongFaqMatch(request.message, request.faqs)
  ) {
    return { eligible: false, reason: "QUOTABLE_FAQ_ANSWER" };
  }
  if (request.services.some((service) => service.price)) {
    return { eligible: false, reason: "QUOTABLE_SERVICE_PRICE" };
  }
  if (request.services.some((service) => service.description)) {
    return { eligible: false, reason: "QUOTABLE_SERVICE_DESCRIPTION" };
  }
  if (request.businessAbout) {
    return { eligible: false, reason: "QUOTABLE_BUSINESS_ABOUT" };
  }
  if (request.businessAddress) {
    return { eligible: false, reason: "QUOTABLE_BUSINESS_ADDRESS" };
  }
  if (request.availability && request.availability.length > 0) {
    return { eligible: false, reason: "QUOTABLE_AVAILABILITY" };
  }
  return { eligible: true, reason: "ELIGIBLE" };
}

// ─── 4. Mapping validated facts into an AiResponse-compatible proposal (§4.4) ─

/** The action class + clarification a semantic target resolves to. */
type SemanticTarget = {
  readonly intent: AiIntent;
  readonly action: "reply" | "handoff" | "booking_handoff";
  readonly handoffReason: AiResponse["handoffReason"];
  readonly clarification?: { readonly type: string };
};

/**
 * The contact-vs-book BOUNDARY INDICATOR (§12): the customer's contact intent
 * is PLAUSIBLE but NOT high-confidence — the model could not confidently rule
 * contact out (above the confident-negative edge) yet could not assert it
 * (below the fact threshold) — and no task, support or safety fact is
 * asserted. The turn genuinely sits BETWEEN contact and booking without
 * committing to either, so it is CLARIFIED once instead of guessed.
 */
export function contactVsBookBoundary(
  facts: SemanticFacts,
  answers: Readonly<Record<string, JevAnswer>>,
): boolean {
  const probability = noulProbability(answers, "providerRequested");
  return (
    probability !== null &&
    probability > 1 - JEV_CONFIDENCE_HIGH_EDGE &&
    probability < JEV_POLICY_THRESHOLD &&
    !facts.bookingTask &&
    facts.supportRequested !== true &&
    facts.sensitiveTurn !== true
  );
}

/**
 * Map the validated semantic facts onto ONE routing target, mirroring the
 * server precedence order the resolver will re-derive (safety → explicit human
 * → domain task → clarify → normal). The map is a PROPOSAL: the ONE resolver
 * (`turn-planner.ts`) still decides the actual action from this response plus
 * the signals. Returns `null` when the model produced NO actionable semantic
 * reading at all (nothing asserted, no boundary, no greeting, no ambiguity) —
 * the turn then falls back to the deterministic lexical baseline.
 *
 * `providerPreferenceExpressed` deliberately participates in NO routing
 * decision (the frozen §10 adjudication proved it is non-routing); it is
 * carried as evidence only.
 */
function semanticTarget(
  facts: SemanticFacts,
  answers: Readonly<Record<string, JevAnswer>>,
): SemanticTarget | null {
  // Safety precedence first (the resolver's rule 3).
  if (facts.sensitiveTurn === true) {
    return {
      intent: "AMBIGUOUS",
      action: "handoff",
      handoffReason: "SENSITIVE",
    };
  }
  // Explicit human request (the resolver's rule 2) — a support-role request,
  // or a provider-contact request that is NOT inside a booking task.
  if (facts.supportRequested === true) {
    return {
      intent: "HUMAN_REQUEST",
      action: "handoff",
      handoffReason: "HUMAN_REQUEST",
    };
  }
  if (facts.providerRequested === true && !facts.bookingTask) {
    return {
      intent: "HUMAN_REQUEST",
      action: "handoff",
      handoffReason: "HUMAN_REQUEST",
    };
  }
  // The booking-task family (the resolver's rule 5). The P2 winner labels the
  // task; a suppressed member never reaches here.
  if (facts.bookingRequested === true) {
    return {
      intent: "BOOKING",
      action: "booking_handoff",
      handoffReason: null,
    };
  }
  if (facts.availabilityAsked === true) {
    return {
      intent: "AVAILABILITY",
      action: "booking_handoff",
      handoffReason: null,
    };
  }
  if (facts.cancellationRequested === true) {
    return {
      intent: "CANCELLATION",
      action: "booking_handoff",
      handoffReason: null,
    };
  }
  if (facts.rescheduleRequested === true) {
    return {
      intent: "RESCHEDULE",
      action: "booking_handoff",
      handoffReason: null,
    };
  }
  // The contact-vs-book boundary: ONE bounded clarification, fired ONLY from
  // this semantic path (never from a lexical keyword/regex table).
  if (contactVsBookBoundary(facts, answers)) {
    return {
      intent: "AMBIGUOUS",
      action: "handoff",
      handoffReason: "AMBIGUOUS",
      clarification: { type: "CLARIFY_CONTACT_OR_BOOK" },
    };
  }
  // A proven-pure social opening.
  if (facts.greetingOnly === true) {
    return { intent: "GREETING", action: "reply", handoffReason: null };
  }
  // Too thin to map to any supported action → the resolver's bounded
  // CLARIFY_INTENT (an AMBIGUOUS-reason handoff is the existing clarifiable
  // signal).
  if (facts.ambiguousTurn === true) {
    return {
      intent: "AMBIGUOUS",
      action: "handoff",
      handoffReason: "AMBIGUOUS",
    };
  }
  // A service/price ask with NO quotable fact available (the eligibility gate
  // already proved none is carried) is a knowledge gap — never a guess.
  if (facts.serviceOrPriceAsked === true) {
    return {
      intent: "AMBIGUOUS",
      action: "handoff",
      handoffReason: "NO_KNOWLEDGE",
    };
  }
  return null;
}

/**
 * Build the `AiResponse`-compatible proposal for one semantic target. The
 * customer-facing `content` and the staff `summary` are ALWAYS the fixed
 * engine-owned templates the lexical classifier uses
 * (`deterministicReplyForIntent`) — the semantic model never authors customer
 * prose, so no model text and no chain-of-thought can reach the customer
 * through this channel.
 *
 * CAPABILITY BOUNDARY (CORE-03B1):
 * a. The current JEV adapter and request mapping (`buildSemanticRequest`) omits temporal context.
 * b. Configured JEV outputs in this system are bounded decisions (atomic routing questions and conversation goal).
 * c. `semanticResponse` currently delegates rich extraction to legacy lexical helpers
 *    (`classifyCustomerMessage` and `extractServiceFacts`) and does not produce the new
 *    `factUpdates` (`operation: "set" | "remove"`) itself.
 */
function semanticResponse(
  request: AiRequest,
  target: SemanticTarget,
): AiResponse {
  const baseline = classifyCustomerMessage(request.message, request.faqs);
  const matchedService = extractServiceFacts(
    request.message,
    request.services ?? [],
  );
  const extraction = matchedService
    ? { ...baseline.extraction, service: matchedService }
    : baseline.extraction;
  const template = deterministicReplyForIntent(target.intent, request.message);
  return {
    intent: target.intent,
    action: target.action,
    content: template.content,
    extraction,
    handoffReason: target.handoffReason,
    summary: template.summary,
    ...(target.clarification ? { clarification: target.clarification } : {}),
  };
}

// ─── 5. The semantic evidence block (§12 telemetry) ──────────────────────────

/**
 * CLOSED MACHINE KEYS ONLY. This block never carries: customer message
 * content, the raw provider response, secrets or Authorization data,
 * chain-of-thought, or arbitrary model text. It is additive observability,
 * never customer-visible.
 */
export type JevSemanticEvidence = {
  /** True iff the eligibility gate selected the JEV route for this turn. */
  readonly selected: boolean;
  /** The closed outcome class for this turn (audit only). */
  readonly resultClass: string;
  /** True iff a JEV network attempt was actually spent this turn. */
  readonly jevCallSpent: boolean;
  /** The derived value of each routing fact (booleans; `false` when absent). */
  readonly facts: Readonly<Record<string, boolean>>;
  /** The sanitized probabilities the model returned (evidence only). */
  readonly probabilities: Readonly<Record<string, number>>;
  /** The confidence band of the decisive facts (P3; reporting only). */
  readonly confidence: FactConfidence;
  /** The shared server precedence inputs + the derivation that fired. */
  readonly precedence: {
    readonly supportRequest: boolean;
    readonly providerRequest: boolean;
    readonly bookingTask: boolean;
    readonly explicitHuman: boolean;
    readonly derivation:
      "supportRequest" | "providerRequest AND NOT bookingTask" | "none";
  };
  /**
   * The `conversationGoal` choice + its own confidence — NON-AUTHORITATIVE
   * evidence only. It participates in no routing decision.
   */
  readonly conversationGoal: {
    readonly selection: string;
    readonly confidence: number | null;
  } | null;
  /** The contact-vs-book boundary indicator (§12 requirement 10). */
  readonly contactVsBook: boolean;
  /** True iff the strategy proposed the bounded contact-vs-book clarification. */
  readonly clarifyContactOrBookProposed: boolean;
  /**
   * The false-handoff classification required by the R3 design: does the
   * semantic reading hand off where the deterministic lexical baseline does
   * not? `SEMANTIC_ONLY_HANDOFF` is the measurable false-handoff risk.
   */
  readonly handoffAgreement:
    | "AGREE_HANDOFF"
    | "AGREE_NO_HANDOFF"
    | "SEMANTIC_ONLY_HANDOFF"
    | "LEXICAL_ONLY_HANDOFF";
  /** The closed provider failure code, when the attempt failed. */
  readonly failureCode: string | null;
  /** The served model snapshot (machine key) when the provider reported one. */
  readonly servedModel: string | null;
  /**
   * The resolver signals the engine feeds `resolveTurnPlan` for this turn.
   * Present IFF the JEV reading owns the turn (a semantic target was
   * produced). Absent when the turn terminated on the deterministic lexical
   * baseline, so the engine then uses the lexical detector — the two never
   * overwrite each other (§8). A SHADOW record (PROMPT-AI-JEV-03D) NEVER
   * carries this field: the shadow reading owns no turn and must never be
   * feedable to a resolver.
   */
  readonly signals?: {
    readonly sensitive: boolean;
    readonly explicitHuman: boolean;
    readonly nonCommittal: boolean;
  };
  /**
   * The SHADOW/AUTHORITATIVE discriminator (PROMPT-AI-JEV-03D §3.1). Absent ⇒
   * `AUTHORITATIVE`, so every existing ACTIVE record keeps its exact prior
   * shape and a sink can refuse to score a SHADOW record as authoritative
   * (and vice versa). Only SHADOW records set this to `"SHADOW"`.
   */
  readonly evidenceRole?: "AUTHORITATIVE" | "SHADOW";
  /**
   * The script-block language hint that was sent to the provider
   * (`languageHint`), hoisted onto the evidence block
   * (PROMPT-AI-JEV-03D §11.4 — the AI-JEV-03C observability gap). One closed
   * key ∈ {ar, en, mixed}: a Unicode script-block test, NOT a dialect
   * classifier — it cannot distinguish Egyptian Arabic from MSA, and no
   * dialect accuracy is claimed from it.
   */
  readonly languageHint?: string;
  /** The JEV evaluation's own reported latency (ms), when the provider ran. */
  readonly latencyMs?: number | null;
  /**
   * SHADOW-only (PROMPT-AI-JEV-03D §8): true iff the turn's opaque traceId was
   * ADMITTED by the deterministic sampler; false on the pure zero-call marker
   * records emitted for eligible-but-not-sampled turns. Absent on every
   * AUTHORITATIVE record.
   */
  readonly sampled?: boolean;
  /**
   * SHADOW-only (PROMPT-AI-JEV-03D §7.2): the evidence bucket — one closed key
   * tracking whether this observation is fresh, under investigation,
   * tuning-contaminated or evaluation-reserved. Absent ⇒ `OBSERVATION`.
   */
  readonly bucket?: string;
  /**
   * SHADOW-only: the closed machine reason an eligible turn was NOT sampled
   * (`NOT_SAMPLED` / `DAILY_CEILING_REACHED` / `SHADOW_CIRCUIT_OPEN` /
   * `NO_TRACE_ID`), or null. Absent on every AUTHORITATIVE record.
   */
  readonly notSampledReason?: string | null;
};

// ─── 6. The strategy identity + the async decision (§6) ──────────────────────

export const SEMANTIC_JEV_STRATEGY_ID = "jev-semantic@v1";

export type SemanticJevStrategyDeps = {
  readonly provider: JevDecisionsProvider;
  /**
   * The ONE explicit environment-controlled kill switch (§11). ABSENT ⇒ OFF;
   * any value other than a positive enablement ⇒ OFF. When OFF the strategy
   * never consults the provider and behaves exactly like the conservative
   * strategy, so customer-visible behavior reproduces the pre-AI-JEV-03
   * production behavior byte-for-byte.
   */
  readonly enabled: boolean;
};

export function createSemanticJevStrategy(deps: SemanticJevStrategyDeps): {
  readonly strategyId: string;
  decide(request: AiRequest, options?: AiCallOptions): Promise<JevDecision>;
} {
  return {
    strategyId: SEMANTIC_JEV_STRATEGY_ID,

    async decide(
      request: AiRequest,
      options?: AiCallOptions,
    ): Promise<JevDecision> {
      // ── KILL SWITCH (§11): OFF ⇒ the exact pre-AI-JEV-03 behaviour. ────────
      // The strategy becomes the conservative strategy: it terminates only on
      // the proven zero-call bypass and never consults the provider, so a
      // disabled semantic strategy is a complete rollback to the shipped
      // behaviour with zero JEV calls.
      if (!deps.enabled) {
        const proven = bypassDeterministicAi(request);
        if (!proven) {
          return {
            mode: "GENERATIVE",
            reason: "GENERATIVE_REQUIRED",
            response: null,
            semantic: {
              selected: false,
              resultClass: "KILL_SWITCH_OFF",
              jevCallSpent: false,
              facts: {},
              probabilities: {},
              confidence: "low",
              precedence: {
                supportRequest: false,
                providerRequest: false,
                bookingTask: false,
                explicitHuman: false,
                derivation: "none",
              },
              conversationGoal: null,
              contactVsBook: false,
              clarifyContactOrBookProposed: false,
              handoffAgreement: "AGREE_NO_HANDOFF",
              failureCode: null,
              servedModel: null,
            },
          };
        }
        return jevDecisionFromProvenResponse(proven);
      }

      // ── 1. The deterministic 0-call path resolves the turn → JEV is
      //    INELIGIBLE and the turn terminates DETERMINISTICALLY with the
      //    proven response and ZERO model calls (§5 first requirement). This
      //    MUST terminate here: the gateway skips its own built-in bypass when
      //    a strategy is configured, so a GENERATIVE return would otherwise
      //    send a proven-zero-call turn to the LLM.
      const proven = bypassDeterministicAi(request);
      if (proven) {
        // The semantic strategy was selected for the turn but the 0-call
        // bypass won, so the JEV route itself was NOT selected (`selected:
        // false`) and NO JEV call was spent. Recording the block keeps the
        // audit uniform: the strategy's identity and its zero-call outcome are
        // observable exactly like its one-call outcomes (§12).
        return {
          ...jevDecisionFromProvenResponse(proven),
          semantic: {
            selected: false,
            resultClass: "DETERMINISTIC_BYPASS_RESOLVED",
            jevCallSpent: false,
            facts: {},
            probabilities: {},
            confidence: "low",
            precedence: {
              supportRequest: false,
              providerRequest: false,
              bookingTask: false,
              explicitHuman: false,
              derivation: "none",
            },
            conversationGoal: null,
            contactVsBook: false,
            clarifyContactOrBookProposed: false,
            handoffAgreement: "AGREE_NO_HANDOFF",
            failureCode: null,
            servedModel: null,
          },
        };
      }

      // ── 2. The PURE pre-call eligibility gate (ZERO model calls). A turn
      //    that requires the LLM to author a quotable grounded answer is
      //    INELIGIBLE and stays on the generative route (0 JEV calls).
      const eligibility = jevEligibility(request);
      if (!eligibility.eligible) {
        return {
          mode: "GENERATIVE",
          reason: "GENERATIVE_REQUIRED",
          response: null,
          semantic: {
            selected: false,
            resultClass: eligibility.reason,
            jevCallSpent: false,
            facts: {},
            probabilities: {},
            confidence: "low",
            precedence: {
              supportRequest: false,
              providerRequest: false,
              bookingTask: false,
              explicitHuman: false,
              derivation: "none",
            },
            conversationGoal: null,
            contactVsBook: false,
            clarifyContactOrBookProposed: false,
            handoffAgreement: "AGREE_NO_HANDOFF",
            failureCode: null,
            servedModel: null,
          },
        };
      }

      // ── 2. THE ONE JEV MODEL CALL. ─────────────────────────────────────────
      const evaluation = await deps.provider.evaluate(
        buildSemanticRequest(request),
        options,
      );

      // The shared semantic reading (PROMPT-AI-JEV-03D §4.2): the evidence
      // block and the outcome class are computed by the ONE pure derivation
      // used by BOTH the authoritative strategy and a non-authoritative
      // shadow, so the two can never diverge for the same provider result.
      const reading = evaluateSemanticReading(request, evaluation);

      // ── 3. PRE-ATTEMPT UNAVAILABILITY: the only path that may still reach
      //    the LLM. A missing credential short-circuits BEFORE any network
      //    I/O, so zero JEV network calls were spent and the turn may retain
      //    the existing generative route (truth-table row D).
      if (reading.outcome.kind === "UNAVAILABLE_PRE_ATTEMPT") {
        return {
          mode: "GENERATIVE",
          reason: "GENERATIVE_REQUIRED",
          response: null,
          semantic: reading.evidence,
        };
      }

      // ── 4. FAILURE AFTER THE ATTEMPT WAS SPENT: FAIL CLOSED (§7). The turn
      //    NEVER falls through to the LLM: the JEV budget was already spent.
      //    It terminates on the DETERMINISTIC LEXICAL BASELINE — 1 JEV
      //    attempt, 0 LLM calls, total budget 1. Malformed content is never
      //    coerced into a semantic fact.
      if (reading.outcome.kind === "FAILURE_FAIL_CLOSED") {
        return {
          mode: "DETERMINISTIC",
          reason: "JEV_FAILURE_FAIL_CLOSED",
          response: reading.outcome.response,
          semantic: reading.evidence,
        };
      }

      // ── 5. SUCCESS: no actionable reading → the deterministic lexical
      //    baseline owns the turn (still 1 JEV call, 0 LLM calls).
      if (reading.outcome.kind === "NO_READING_BASELINE") {
        return {
          mode: "DETERMINISTIC",
          reason: "JEV_NO_READING_BASELINE",
          response: reading.outcome.response,
          semantic: reading.evidence,
        };
      }

      // A semantic target owns the turn: terminate on the fixed-template
      // proposal and attach the resolver signals the ONE resolver consumes.
      return {
        mode: "DETERMINISTIC",
        reason: reading.outcome.reason,
        response: reading.outcome.response,
        semantic: {
          ...reading.evidence,
          signals: reading.outcome.signals,
        },
      };
    },
  };
}

// ─── 7. Helpers (pure, total, no I/O) ─────────────────────────────────────────

/**
 * A neutral language hint for the semantic state (never a dialect dictionary).
 *
 * PROMPT-AI-JEV-03D §11.4 — now EXPORTED so it can be hoisted onto the
 * evidence block (`JevSemanticEvidence.languageHint`) as the closed
 * real-language observable. It is a Unicode script-block test:
 *   hasArabic ∧ hasLatin ⇒ "mixed"
 *   hasArabic             ⇒ "ar"
 *   otherwise             ⇒ "en"
 * It CANNOT distinguish Egyptian Arabic from MSA (both write in the Arabic
 * block) and no dialect accuracy is ever claimed from it.
 */
export function languageHint(message: string): string {
  const hasArabic = /[\u0600-\u06FF]/.test(message);
  const hasLatin = /[A-Za-z]/.test(message);
  if (hasArabic && hasLatin) return "mixed";
  if (hasArabic) return "ar";
  return "en";
}

/**
 * Build the provider-neutral JEV evaluation request from an assembled AiRequest.
 *
 * NOTE (CORE-03B1):
 * a. The current adapter/request mapping (`buildSemanticRequest` / `JevState`) maps
 *    `customerMessage`, `businessName`, `services`, `faqs`, `languageHint`, and
 *    `conversationContext`, and currently omits `temporalContext`.
 * b. Configured JEV outputs in this integration are bounded decisions.
 * c. `semanticResponse` currently delegates rich extraction to legacy helpers rather
 *    than producing `factUpdates` directly.
 */
export function buildSemanticRequest(request: AiRequest): JevEvaluationRequest {
  return {
    state: {
      customerMessage: request.message,
      businessName: request.businessName,
      services: request.services.map((service) => service.name),
      faqs: request.faqs.map((faq) => faq.question),
      languageHint: languageHint(request.message),
      ...(request.conversationContext
        ? { conversationContext: request.conversationContext }
        : {}),
    },
    questions: { ...SEMANTIC_QUESTIONS },
  };
}

/**
 * The NONE precedence block shared by every non-reading evidence variant.
 * Frozen so no evidence record can mutate it.
 */
const NONE_PRECEDENCE: JevSemanticEvidence["precedence"] = Object.freeze({
  supportRequest: false,
  providerRequest: false,
  bookingTask: false,
  explicitHuman: false,
  derivation: "none",
}) as JevSemanticEvidence["precedence"];

/**
 * The outcome of one JEV evaluation, structured for the strategy that OWNS
 * the turn. `response` is the `AiResponse`-compatible proposal the ACTIVE
 * strategy terminates on; SHADOW callers use ONLY `evidence` and never
 * `outcome` (the shadow owns no turn, never materializes a response, and
 * never produces resolver signals).
 */
export type SemanticReadingOutcome =
  | { readonly kind: "UNAVAILABLE_PRE_ATTEMPT" }
  | {
      readonly kind: "FAILURE_FAIL_CLOSED";
      readonly response: AiResponse;
    }
  | {
      readonly kind: "NO_READING_BASELINE";
      readonly response: AiResponse;
    }
  | {
      readonly kind: "SEMANTIC";
      readonly reason: JevDecisionReason;
      readonly response: AiResponse;
      readonly signals: {
        readonly sensitive: boolean;
        readonly explicitHuman: boolean;
        readonly nonCommittal: boolean;
      };
    };

export type SemanticReading = {
  readonly evidence: JevSemanticEvidence;
  readonly outcome: SemanticReadingOutcome;
};

/**
 * Read ONE completed JEV evaluation into evidence + outcome (PROMPT-AI-JEV-03D
 * §4.2). Extracted verbatim from the ACTIVE `decide()` body so the AUTHORITATIVE
 * strategy and a non-authoritative SHADOW evaluation compute the IDENTICAL
 * evidence for the same provider result — 1:1 comparability is the entire
 * point of the shadow experiment. PURE and total: no I/O, no model calls.
 *
 * The evidence block deliberately carries NO `signals` here; the ACTIVE
 * strategy attaches them on the SEMANTIC outcome only (the JEV reading owns
 * the turn), and the SHADOW never attaches them at all.
 */
export function evaluateSemanticReading(
  request: AiRequest,
  evaluation: JevDecisionsResult,
): SemanticReading {
  const language = languageHint(request.message);

  // ── PRE-ATTEMPT UNAVAILABILITY: zero network calls were spent.
  if (!evaluation.ok && !evaluation.attemptSpent) {
    return {
      evidence: {
        selected: true,
        resultClass: "UNAVAILABLE_PRE_ATTEMPT",
        jevCallSpent: false,
        facts: {},
        probabilities: {},
        confidence: "low",
        precedence: NONE_PRECEDENCE,
        conversationGoal: null,
        contactVsBook: false,
        clarifyContactOrBookProposed: false,
        handoffAgreement: "AGREE_NO_HANDOFF",
        failureCode: evaluation.errorCode,
        servedModel: null,
        languageHint: language,
        latencyMs: evaluation.latencyMs,
      },
      outcome: { kind: "UNAVAILABLE_PRE_ATTEMPT" },
    };
  }

  // ── FAILURE AFTER THE ATTEMPT WAS SPENT: the lexical baseline owns the
  //    reading (fail-closed; the turn never falls through to the LLM).
  if (!evaluation.ok) {
    const baseline = classifyCustomerMessage(request.message, request.faqs);
    return {
      evidence: {
        selected: true,
        resultClass: "FAILURE_FAIL_CLOSED",
        jevCallSpent: true,
        facts: {},
        probabilities: {},
        confidence: "low",
        precedence: NONE_PRECEDENCE,
        conversationGoal: null,
        contactVsBook: false,
        clarifyContactOrBookProposed: false,
        handoffAgreement: handoffAgreementFor(
          baseline.action === "handoff",
          false,
        ),
        failureCode: evaluation.errorCode,
        servedModel: evaluation.servedModel,
        languageHint: language,
        latencyMs: evaluation.latencyMs,
      },
      outcome: { kind: "FAILURE_FAIL_CLOSED", response: baseline },
    };
  }

  // ── SUCCESS: derive the facts (P1/P2), map the target, build the evidence.
  const facts = deriveSemanticFacts(evaluation.answers);
  const target = semanticTarget(facts, evaluation.answers);
  const contactVsBook = contactVsBookBoundary(facts, evaluation.answers);

  const goalAnswer = evaluation.answers["conversationGoal"];
  const conversationGoal =
    goalAnswer && goalAnswer.type === "choice"
      ? {
          selection: goalAnswer.choice,
          confidence: goalAnswer.confidence,
        }
      : null;

  // No actionable semantic reading → the deterministic lexical baseline owns
  // the turn (still 1 JEV call, 0 LLM calls).
  if (!target) {
    const baseline = classifyCustomerMessage(request.message, request.faqs);
    return {
      evidence: {
        selected: true,
        resultClass: "NO_READING_BASELINE",
        jevCallSpent: true,
        facts: closedFacts(facts),
        probabilities: closedProbabilities(evaluation.answers),
        confidence: decisiveConfidence(evaluation.answers),
        precedence: precedenceEvidence(facts),
        conversationGoal,
        contactVsBook,
        clarifyContactOrBookProposed: false,
        handoffAgreement: handoffAgreementFor(
          baseline.action === "handoff",
          false,
        ),
        failureCode: null,
        servedModel: evaluation.servedModel,
        languageHint: language,
        latencyMs: evaluation.latencyMs,
      },
      outcome: { kind: "NO_READING_BASELINE", response: baseline },
    };
  }

  const response = semanticResponse(request, target);
  const semanticHandoff = target.action === "handoff";
  const lexicalBaseline = classifyCustomerMessage(
    request.message,
    request.faqs,
  );

  return {
    evidence: {
      selected: true,
      resultClass: semanticResultClass(target),
      jevCallSpent: true,
      facts: closedFacts(facts),
      probabilities: closedProbabilities(evaluation.answers),
      confidence: decisiveConfidence(evaluation.answers),
      precedence: precedenceEvidence(facts),
      conversationGoal,
      contactVsBook,
      clarifyContactOrBookProposed: !!target.clarification,
      handoffAgreement: handoffAgreementFor(
        lexicalBaseline.action === "handoff",
        semanticHandoff,
      ),
      failureCode: null,
      servedModel: evaluation.servedModel,
      languageHint: language,
      latencyMs: evaluation.latencyMs,
    },
    outcome: {
      kind: "SEMANTIC",
      reason: semanticResultClass(target),
      response,
      signals: {
        sensitive: facts.sensitiveTurn === true,
        explicitHuman: facts.explicitHuman,
        // The semantic equivalent of the lexical non-committal fragment: a
        // turn too thin to map to ANY supported action. Used by the resolver
        // only to suppress an UNNECESSARY CLARIFY_INTENT.
        nonCommittal: facts.ambiguousTurn === true,
      },
    },
  };
}

/** Project the semantic facts into closed boolean evidence keys. */
function closedFacts(facts: SemanticFacts): Record<string, boolean> {
  return {
    supportRequested: facts.supportRequested ?? false,
    providerRequested: facts.providerRequested ?? false,
    bookingRequested: facts.bookingRequested ?? false,
    availabilityAsked: facts.availabilityAsked ?? false,
    cancellationRequested: facts.cancellationRequested ?? false,
    rescheduleRequested: facts.rescheduleRequested ?? false,
    providerPreferenceExpressed: facts.providerPreferenceExpressed ?? false,
    sensitiveTurn: facts.sensitiveTurn ?? false,
    serviceOrPriceAsked: facts.serviceOrPriceAsked ?? false,
    greetingOnly: facts.greetingOnly ?? false,
    ambiguousTurn: facts.ambiguousTurn ?? false,
    bookingTask: facts.bookingTask,
    explicitHuman: facts.explicitHuman,
  };
}

/** Project the model's raw probabilities into closed evidence keys. */
function closedProbabilities(
  answers: Readonly<Record<string, JevAnswer>>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of jevSemanticQuestionKeys) {
    if (key === "conversationGoal") continue;
    const probability = noulProbability(answers, key);
    if (probability !== null) out[key] = probability;
  }
  return out;
}

/** The confidence band of the turn's decisive facts (P3; reporting only). */
function decisiveConfidence(
  answers: Readonly<Record<string, JevAnswer>>,
): FactConfidence {
  let mostExtreme: number | null = null;
  for (const key of jevSemanticQuestionKeys) {
    if (key === "conversationGoal") continue;
    const probability = noulProbability(answers, key);
    if (probability === null) continue;
    const distance = Math.abs(probability - 0.5);
    if (mostExtreme === null || distance > Math.abs(mostExtreme - 0.5)) {
      mostExtreme = probability;
    }
  }
  return mostExtreme === null ? "low" : bandConfidence(mostExtreme);
}

/** The shared server precedence inputs + the derivation that fired. */
function precedenceEvidence(
  facts: SemanticFacts,
): JevSemanticEvidence["precedence"] {
  const providerPath = facts.providerRequested === true && !facts.bookingTask;
  const derivation =
    facts.supportRequested === true
      ? "supportRequest"
      : providerPath
        ? "providerRequest AND NOT bookingTask"
        : "none";
  return {
    supportRequest: facts.supportRequested ?? false,
    providerRequest: facts.providerRequested ?? false,
    bookingTask: facts.bookingTask,
    explicitHuman: facts.explicitHuman,
    derivation,
  };
}

function handoffAgreementFor(
  lexicalHandoff: boolean,
  semanticHandoff: boolean,
): JevSemanticEvidence["handoffAgreement"] {
  if (semanticHandoff && lexicalHandoff) return "AGREE_HANDOFF";
  if (semanticHandoff && !lexicalHandoff) return "SEMANTIC_ONLY_HANDOFF";
  if (!semanticHandoff && lexicalHandoff) return "LEXICAL_ONLY_HANDOFF";
  return "AGREE_NO_HANDOFF";
}

function semanticResultClass(target: SemanticTarget): JevDecisionReason {
  if (target.clarification) return "SEMANTIC_CLARIFY";
  if (target.action === "handoff") return "SEMANTIC_HANDOFF";
  if (target.action === "booking_handoff") return "SEMANTIC_DOMAIN";
  return "SEMANTIC_ANSWER";
}
