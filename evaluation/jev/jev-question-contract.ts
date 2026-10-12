/**
 * FlowPilot AI Evaluation — the Jev QUESTION CONTRACT (PROMPT-AI-JEV-02).
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  EVALUATION-ONLY. NEVER IMPORTED BY src/. NOT WIRED INTO PRODUCTION.  │
 * │  Contains SYNTHETIC, repository-authored fixtures only. NO production  │
 * │  customer text, NO database reads, NO booking data.                   │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * This module defines the EXACT set of atomic questions the Jev benchmark
 * asks. It is a versioned, reproducible contract: every question is named,
 * typed and documented here so a future run can be re-executed against the
 * same definitions, and so the fixture bank's expected facts reference the
 * SAME keys the adapter sends.
 *
 *
 * ── WHAT CHANGED IN @v2 (PROMPT-AI-JEV-02) ─────────────────────────────────
 *
 * The field set is UNCHANGED from @v1 — eleven independent facts plus the one
 * bounded `conversationGoal` choice. That is deliberately NOT an intent
 * explosion: the bundle already covers every documented routing need, and an
 * extra field is only justified by a real routing requirement (there is
 * none). What changed is the SEMANTIC PRECISION of the instructions and the
 * criteria, driven by the recomputed AI-JEV-01 disagreement table:
 *
 *  8 of the 13 frozen question-level disagreements — and the ONLY case that
 *  changed final routing — came from one confusion: the model treated a
 *  PROVIDER TITLE PRESENT as a request to COMMUNICATE WITH that provider.
 *  («عايز احجز مع دكتور» → providerRequested 0.75; «هل فيه دكتور متاح؟» →
 *  providerRequested 0.74.) Those were confident categorical errors
 *  (0.74–0.86), not near-threshold noise, so they are semantic repairs, not
 *  threshold tweaks. @v2 therefore:
 *
 *   · providerRequested now requires a DIRECT two-way communication verb
 *     (speak / talk / see / meet / connect / transfer / call back) and lists
 *     the NON-qualifying provider contexts (booking, scheduling, presence,
 *     preference, identity) as explicit contrasts.
 *   · providerPreferenceExpressed is defined as a CONSTRAINT ON THE SERVICE
 *     (which provider performs it), never a request to communicate, and never
 *     satisfied by a mere availability/presence question.
 *   · availabilityAsked covers bookability/presence generally, not only
 *     named slots, so "is a doctor free?" does not fall between categories.
 *   · supportRequested requires an actual intervention request, and contrasts
 *     a topic/role mention that carries no request.
 *   · ambiguousTurn is explicitly NOT satisfied by a recognizable social
 *     greeting (greeting back is a supported action), and NOT by
 *     non-attendance without a proposed alternative time (that is a
 *     cancellation, not ambiguity).
 *   · cancellationRequested / rescheduleRequested are separated by whether an
 *     ALTERNATIVE TIME is proposed, not by the negative phrasing alone.
 *
 *  ── The STAGE A refinement (role disjointness — structural, not fitted) ──
 *
 *  The frozen @v1 wording of `supportRequested` listed a DOCTOR among the
 *  human roles a customer could ask to reach. STAGE A live calibration on the
 *  @v2 provider-contact cases exposed what that costs: the model followed the
 *  wording and returned supportRequested ≈ 0.97 for «عايز أكلم دكتور». Because
 *  the server precedence masks only the PROVIDER branch with bookingTask
 *  (`supportRequest OR (providerRequest AND NOT bookingTask)`), routing a
 *  provider contact through the SUPPORT branch BYPASSES the booking mask and
 *  produces a false handoff — 6 of 26 calibration fixtures diverged on the
 *  final routing, all through the `supportRequest` derivation.
 *
 *  The production classifier is deliberately built the other way
 *  (conversation-ai.ts): `HUMAN_WORDS` (موظف/مدير/سكرتير/مساعدة/…) are
 *  non-clinical staff and feed `supportRequest`; `HUMAN_TITLE_WORDS`
 *  (دكتور/دكتورة) are provider titles and feed `providerRequest`. The two
 *  role sets are DISJOINT, and the disjointness is what makes the booking mask
 *  sound. @v2 therefore makes the same separation explicit in the contract:
 *  `supportRequested` is scoped to non-clinical staff, and reaching a provider
 *  belongs to `providerRequested`. This is a structural correction required by
 *  the precedence formula, evidenced by 6 routing divergences — not a
 *  threshold tuned against a benchmark.
 *
 *  The minimal-pair contrasts inside the criteria describe SEMANTIC
 *  RELATIONSHIPS, not keywords, so they generalize to unseen Egyptian Arabic,
 *  MSA, code-switching, paraphrases, provider names and provider titles. They
 *  are deliberately framed as boundary conditions rather than exhaustive
 *  exemplars, and no dialect stem list or lexical dictionary appears anywhere.
 *
 *
 * DESIGN RULES (unchanged from @v1; binding)
 *
 *  1. ATOMIC. Each question asks ONE well-scoped thing — the kind of
 *     determination a knowledgeable person makes in a few seconds given the
 *     right context. Nothing here asks "what should FlowPilot do?".
 *  2. INDEPENDENT. No question's answer depends on another question's
 *     answer. Anything that combines facts is composed in CODE (see
 *     `applyServerPrecedence` and the probability policy), never asked of the
 *     model. This is exactly why the server precedence formula is NOT a
 *     question. A criteria text may DESCRIBE the boundary of its own concept
 *     (that is part of making one question precise) but it never defers to
 *     another question's ANSWER.
 *  3. NOUL-FIRST. Independent booleans use Noul, which returns the raw
 *     probability of yes. That raw probability is the evidence the benchmark
 *     retains; the 0.5 orientation in reporting is lossy and is never a
 *     production threshold (see the probability policy module).
 *  4. CHOICE ONLY WHERE BOUNDED. The one Choice question
 *     (`conversationGoal`) uses alternatives that are genuinely bounded and
 *     mutually meaningful for a booking-centric assistant. It is evidence
 *     about the turn's dominant goal, NOT a routing instruction.
 *  5. NO LEXICAL DICTIONARY. The criteria describe BEHAVIOUR and RELATIONSHIPS,
 *     not keyword lists. Jev is a semantic model; encoding Arabic word lists
 *     here would rebuild the deterministic classifier's exact weakness inside
 *     the model. No dialect stem list appears in this file.
 *  6. NO PRECEDENCE. Jev supplies semantic FACTS. The server owns precedence
 *     (AI-SEM-02): explicitHuman = supportRequest OR (providerRequest AND
 *     NOT bookingTask). That formula lives in `applyServerPrecedence`, in
 *     code, exactly once, and is never asked of the model.
 *
 *
 * THE ELEVEN FACTS + ONE CHOICE (field set frozen since @v1)
 *
 *  supportRequested        an actual request for human/staff/support
 *                           intervention — not a role or topic mention.
 *  providerRequested       a request to DIRECTLY COMMUNICATE WITH a provider
 *                           — speak/talk/see/meet/connect/transfer/call back.
 *                           A title alone, or a title inside booking,
 *                           availability, preference or identity, never
 *                           qualifies.
 *  bookingRequested        a request to create a NEW appointment.
 *  availabilityAsked       a question about bookability, presence or free
 *                           times — slots, dates, or whether a provider is
 *                           free/present.
 *  cancellationRequested   a request to REMOVE an existing appointment.
 *  rescheduleRequested     a request to MOVE an existing appointment to a
 *                           different time.
 *  providerPreferenceExpressed  a CONSTRAINT on WHICH provider performs a
 *                           service — name, gender, title, specialty, or
 *                           "any/some provider". Never a contact request.
 *  sensitiveTurn           safety/sensitive: urgent medical, emergency,
 *                           severe pain, complaint, legal, distress.
 *  serviceOrPriceAsked     a question about a service or its cost.
 *  greetingOnly            purely a social opening carrying no task.
 *  ambiguousTurn           too thin to map to ANY supported action.
 *  conversationGoal        (CHOICE) the ONE bounded dominant goal of the turn
 *
 * Deliberate absences, and why:
 *  - NO `explicitHuman` question: that is a PRECEDENCE verdict over the facts
 *    above, and the server owns it (AI-SEM-02). Asking Jev for it would
 *    relocate authority to the model.
 *  - NO `shouldHandoff` / `nextAction` question: action authority belongs to
 *    the Turn Planner, which combines facts with safety, domain constraints
 *    and control state.
 *  - NO dialect/Arabic dictionary questions: lexical coverage is the
 *    deterministic path's failure mode, not a semantic decision problem.
 *  - NO new facts: every documented routing need is already covered. Adding a
 *    field requires a real routing requirement, and PROMPT-AI-JEV-02 found
 *    none (the failures were imprecise definitions of existing facts).
 */

import type { JevQuestion } from "./jev-decisions-adapter";

/**
 * The versioned id of this question contract. Bump when a question's
 * instructions or criteria change in any way — that invalidates
 * comparability with runs under the previous revision.
 *
 * @v1 — PROMPT-AI-JEV-01 (frozen; the shipped live artifact used this).
 * @v2 — PROMPT-AI-JEV-02: hardened provider/support/availability/ambiguity
 *       semantics. Same eleven facts + one choice; no field added or removed.
 */
export const JEV_QUESTION_CONTRACT_ID = "flowpilot.jev-questions@v2";

/** The stable key of every question in the contract (machine-readable). */
export const jevQuestionKeys = [
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

export type JevQuestionKey = (typeof jevQuestionKeys)[number];

/**
 * The documented question definitions. Each entry is the exact object the
 * adapter sends, so a run is reconstructable from this file alone.
 */
export const JEV_QUESTIONS: Readonly<Record<JevQuestionKey, JevQuestion>> = {
  supportRequested: {
    type: "noul",
    instructions:
      "The customer is asking for a NON-CLINICAL person to intervene — to be connected to, transferred to, or to speak with staff, support, customer service, a manager, a secretary, a receptionist, an official, or any administrative person rather than the automated assistant. TRUE only when the turn carries an actual REQUEST for such a person to intervene, by any role or phrasing. A request to reach a PROVIDER — a doctor, dentist, specialist or any clinician the customer wants to consult — is NOT this question: provider contact is the separate provider-contact fact, and the two must stay role-disjoint. Mentioning a role or a help-related word as a TOPIC, a compliment, thanks, or news is NOT a request: telling the assistant the manager is new, or thanking someone for help already received, asks nothing of a person. A booking or information turn that never asks for a person stays FALSE even when a role word appears.",
    criteria: {
      true: "The customer asks a staff, support or administrative person to intervene, take over, or be reached — a request for human action, by any such role or phrasing.",
      false:
        "The turn addresses the assistant itself, asks to reach a PROVIDER (clinician) instead of staff, or mentions a role or help only as a topic, a compliment, thanks, or news, with no request for a person to act.",
    },
  },
  providerRequested: {
    type: "noul",
    instructions:
      "The customer is asking to DIRECTLY COMMUNICATE WITH a provider or professional — a doctor, dentist, specialist or any CLINICIAN who delivers the service. TRUE only when the turn asks for two-way personal contact with that person: to SPEAK with, TALK to, SEE, MEET, be TRANSFERRED to, be CONNECTED to, or be CALLED BACK by a provider. A provider title by itself NEVER makes this true. In particular this is FALSE when the customer merely: books or schedules an appointment with a provider; asks whether a provider is AVAILABLE, free, present, or working; expresses a PREFERENCE for which provider they would see; asks a provider's NAME, identity, or information; or asks about the business through a provider's name. Non-clinical staff (a receptionist, manager, secretary or support agent) are NOT providers — a request to reach them is a support request, not this fact. The distinction is the relationship, not the vocabulary: 'I want to speak with a doctor' and 'I want to book with a doctor' mention the same title, but only the first asks for contact.",
    criteria: {
      true: "The customer asks for a personal, two-way interaction with a clinician — speak, talk, see, meet, be connected, transferred, or called back by that provider.",
      false:
        "The turn only books, schedules, asks availability or presence, expresses a provider preference, identifies a provider, or asks to reach non-clinical staff. A provider title inside any of those is not a request for contact.",
    },
  },
  bookingRequested: {
    type: "noul",
    instructions:
      "The customer is asking to BOOK, RESERVE or CREATE a new appointment. TRUE only when the turn asks for a NEW appointment to be made — a commitment to be scheduled. Asking WHEN a slot is free, or whether booking is possible, is not itself a booking request. Describing symptoms, pain, urgency or a condition is not a booking request either, even when the customer plainly needs care; the request to book must be asked for. Changing, moving or cancelling an appointment that already exists is NOT a new booking.",
    criteria: {
      true: "The customer wants a new appointment created for them.",
      false:
        "The customer is only asking about availability, is only describing a condition or symptoms, or is asking about an appointment they already have.",
    },
  },
  availabilityAsked: {
    type: "noul",
    instructions:
      "The customer is asking WHETHER something can be booked, is FREE, is AVAILABLE, is OPEN, or is PRESENT — an appointment slot, a time, a date, a day, a service, or a provider. TRUE for questions about when a slot is open, whether a provider works there or is present, and whether a service can be booked at all. The customer is not yet committing to book; they are asking what is possible. Note that asking whether a provider is available is an AVAILABILITY question, not a request to communicate with that provider.",
    criteria: {
      true: "The customer wants to know what is free, open, present, or bookable.",
      false:
        "The customer is ready to book right now, or is not asking about bookability, presence or times at all.",
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
      "The turn places a CONSTRAINT on WHICH provider performs the service — a specific provider by NAME, or a provider by GENDER, TITLE, SPECIALTY, seniority, or language — for a task the customer is requesting. TRUE when the customer states which provider, or which kind of provider, they would have perform the service. This is a constraint on the SERVICE, and is NEVER automatically a request to communicate with that provider: 'book with a doctor' expresses a preference, while 'let me speak to a doctor' asks for contact. Asking whether a provider is AVAILABLE or PRESENT is NOT a preference — it asks what is free, and does not itself constrain the choice. A provider mentioned only to IDENTIFY the business ('is this Dr X's clinic?') is not a preference either.",
    criteria: {
      true: "The customer states which provider, or which kind of provider, they would prefer to perform a task they are requesting.",
      false:
        "The turn names no provider, names one only to identify the business, only asks whether a provider is available or present, or is asking to communicate with a provider (a contact request, not a preference).",
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
      "The message is purely a social greeting or opening — a hello, a time-of-day greeting, a wellbeing pleasantry — and carries no request, question or task at all. TRUE when the whole message is a social opening. A greeting followed by any request, question or task makes this FALSE.",
    criteria: {
      true: "The whole message is a social opening with no task behind it.",
      false:
        "The message contains a greeting but also carries a request, question or task.",
    },
  },
  ambiguousTurn: {
    type: "noul",
    instructions:
      "The message is too short, vague or fragmentary to map to ANY supported action — the assistant has no defensible response available. A turn that a booking assistant CAN respond to is not ambiguous, even when it carries no task: a social greeting is supported (the assistant greets back), so a greeting-only turn is NOT ambiguous. An out-of-domain remark the assistant must deflect is ambiguous. This asks whether ANY supported action exists at all, not whether the intent is perfectly clear.",
    criteria: {
      true: "There is not enough information to identify any supported action, or the topic is entirely out of domain.",
      false:
        "A supported response exists — a clear request or question is present, or the turn is a recognizable social greeting.",
    },
  },
  conversationGoal: {
    type: "choice",
    instructions:
      "Which ONE bounded conversation goal best matches what the customer wants from this message?",
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

/** The provider-neutral question set the benchmark sends (order-independent). */
export function jevQuestionSet(): Record<string, JevQuestion> {
  return { ...JEV_QUESTIONS };
}

/**
 * The Choice alternative ids for `conversationGoal`, exported so a scorer can
 * enumerate the bounded set without re-typing it.
 */
export const CONVERSATION_GOAL_OPTIONS = Object.keys(
  JEV_QUESTIONS.conversationGoal.type === "choice"
    ? JEV_QUESTIONS.conversationGoal.criteria
    : {},
);
