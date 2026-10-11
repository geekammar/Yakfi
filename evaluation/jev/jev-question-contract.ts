/**
 * FlowPilot AI Evaluation — the Jev QUESTION CONTRACT (PROMPT-AI-JEV-01).
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  EVALUATION-ONLY. NEVER IMPORTED BY src/. NOT WIRED INTO PRODUCTION.  │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * This module defines the EXACT set of atomic questions the Jev benchmark
 * asks. It is a versioned, reproducible contract: every question is named,
 * typed and documented here so a future run can be re-executed against the
 * same definitions, and so the fixture bank's expected facts reference the
 * SAME keys the adapter sends.
 *
 *
 * DESIGN RULES (from TypeSafe System One + OpenRouter Jev guidance)
 *
 *  1. ATOMIC. Each question asks ONE well-scoped thing — the kind of
 *     determination a knowledgeable person makes in a few seconds given the
 *     right context. Nothing here asks "what should FlowPilot do?".
 *  2. INDEPENDENT. No question's answer depends on another question's
 *     answer. Anything that combines facts is composed in CODE (see
 *     `applyServerPrecedence` in the fixture-bank module), never asked of the
 *     model. This is exactly why the server precedence formula is NOT a
 *     question.
 *  3. NOUL-FIRST. Independent booleans use Noul, which returns the raw
 *     probability of yes. That raw probability is the evidence the benchmark
 *     retains; the 0.5 orientation in reporting is lossy and is never a
 *     production threshold.
 *  4. CHOICE ONLY WHERE BOUNDED. The one Choice question
 *     (`conversationGoal`) uses alternatives that are genuinely bounded and
 *     mutually meaningful for a booking-centric assistant. It is evidence
 *     about the turn's dominant goal, NOT a routing instruction.
 *  5. NO LEXICAL DICTIONARY. The criteria describe BEHAVIOUR, not keyword
 *     lists. Jev is a semantic model; encoding Arabic word lists here would
 *     rebuild the deterministic classifier's exact weakness inside the model.
 *  6. NO PRECEDENCE. Jev supplies semantic FACTS. The server owns precedence
 *     (AI-SEM-02): explicitHuman = supportRequest OR (providerRequest AND
 *     NOT bookingTask). That formula lives in `applyServerPrecedence`, in
 *     code, exactly once.
 *
 *
 * THE NINE FACTS + ONE CHOICE
 *
 *  supportRequested        does the customer ask to be connected to a human,
 *                           staff, support or customer-service person?
 *  providerRequested       does the customer ask to actually REACH / speak to
 *                           a specific provider or professional (title + a
 *                           request cue), as opposed to merely naming one?
 *  bookingRequested        does the customer ask to book / reserve a new
 *                           appointment?
 *  availabilityAsked       does the customer ask what slots / times are free?
 *  cancellationRequested   does the customer ask to CANCEL an existing
 *                           appointment?
 *  rescheduleRequested     does the customer ask to CHANGE / move an existing
 *                           appointment?
 *  providerPreferenceExpressed  does the turn express a PREFERENCE for a
 *                           particular provider (inside another task)?
 *  sensitiveTurn           is the turn safety/sensitive (urgent medical,
 *                           emergency, complaint, distress)?
 *  serviceOrPriceAsked     does the customer ask about a service or its cost?
 *  greetingOnly            is the turn purely a social opening carrying no
 *                           task at all?
 *  ambiguousTurn           is the turn too ambiguous / thin to map to a
 *                           supported action?
 *  conversationGoal        (CHOICE) the ONE bounded dominant goal of the turn
 *
 * Deliberate absences, and why:
 *  - NO `explicitHuman` question: that is a PRECEDENCE verdict over the three
 *    facts above, and the server owns it (AI-SEM-02). Asking Jev for it would
 *    relocate authority to the model.
 *  - NO `shouldHandoff` / `nextAction` question: action authority belongs to
 *    the Turn Planner, which combines facts with safety, domain constraints
 *    and control state.
 *  - NO dialect/Arabic dictionary questions: lexical coverage is the
 *    deterministic path's failure mode, not a semantic decision problem.
 */

import type { JevQuestion } from "./jev-decisions-adapter";

/**
 * The versioned id of this question contract. Bump when a question's
 * instructions or criteria change in any way — that invalidates
 * comparability with runs under the previous revision.
 */
export const JEV_QUESTION_CONTRACT_ID = "flowpilot.jev-questions@v1";

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
      "The customer is asking to be connected to, transferred to, or to speak with a human person — staff, support, customer service, a manager, a secretary or any person rather than the automated assistant.",
    criteria: {
      true: "The customer asks for a person to intervene or take over the conversation, by any role or phrasing.",
      false:
        "The customer is addressing the assistant itself, or the turn carries no request for a person.",
    },
  },
  providerRequested: {
    type: "noul",
    instructions:
      "The customer is asking to actually reach or speak with a specific provider or professional (such as a doctor, dentist or specialist) — a named professional title combined with an intent to communicate with that person.",
    criteria: {
      true: "A professional title is combined with a request to talk to, see, or be connected with that person.",
      false:
        "The turn merely names or identifies a professional without any request to communicate with them.",
    },
  },
  bookingRequested: {
    type: "noul",
    instructions:
      "The customer is asking to book, reserve or create a new appointment.",
    criteria: {
      true: "The customer wants a new appointment made for them.",
      false:
        "The customer is asking about existing availability, or about an appointment they already have.",
    },
  },
  availabilityAsked: {
    type: "noul",
    instructions:
      "The customer is asking what appointment times, slots or dates are currently free or available.",
    criteria: {
      true: "The customer wants to know when a slot is open.",
      false:
        "The customer is ready to book, or is not asking about times at all.",
    },
  },
  cancellationRequested: {
    type: "noul",
    instructions:
      "The customer is asking to cancel, revoke or withdraw an existing appointment.",
    criteria: {
      true: "The customer wants an existing appointment removed.",
      false:
        "The customer wants to book, move, or merely asks about an appointment.",
    },
  },
  rescheduleRequested: {
    type: "noul",
    instructions:
      "The customer is asking to change, move, postpone or reschedule an appointment they already have.",
    criteria: {
      true: "The customer wants an existing appointment moved to a different time.",
      false:
        "The customer wants a brand-new appointment, or is not asking about an existing one.",
    },
  },
  providerPreferenceExpressed: {
    type: "noul",
    instructions:
      "The turn expresses a preference for a particular provider or professional — for example asking for any doctor, or for a specific one — without that mention being a request to communicate with them.",
    criteria: {
      true: "The customer states which provider they would prefer for a task they are requesting.",
      false:
        "The turn names no provider, or names one only to identify the business.",
    },
  },
  sensitiveTurn: {
    type: "noul",
    instructions:
      "The turn is sensitive, urgent or high-stakes: urgent physical symptoms, an emergency, severe pain, a formal complaint, legal language, or significant distress.",
    criteria: {
      true: "The message describes urgency, harm, emergency, complaint or distress that warrants immediate human attention.",
      false:
        "The message is an ordinary scheduling, information or greeting turn.",
    },
  },
  serviceOrPriceAsked: {
    type: "noul",
    instructions:
      "The customer is asking about the services the business offers, or about the cost or price of a service.",
    criteria: {
      true: "The customer wants information about a service or its price.",
      false:
        "The customer is asking to book, or is asking something unrelated to services and prices.",
    },
  },
  greetingOnly: {
    type: "noul",
    instructions:
      "The message is purely a social greeting or opening — a hello, a time-of-day greeting, a wellbeing pleasantry — and carries no request, question or task at all.",
    criteria: {
      true: "The whole message is a social opening with no task behind it.",
      false:
        "The message contains a greeting but also carries a request, question or task.",
    },
  },
  ambiguousTurn: {
    type: "noul",
    instructions:
      "The message is too short, vague or fragmentary to determine what the customer wants from a booking assistant.",
    criteria: {
      true: "There is not enough information to identify a supported action.",
      false: "A clear request, question or task is present.",
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
      availability: "Find out what times or dates are free.",
      reschedule: "Move an existing appointment.",
      cancellation: "Cancel an existing appointment.",
      human_handoff:
        "Reach a human person: staff, support, or a specific professional.",
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
