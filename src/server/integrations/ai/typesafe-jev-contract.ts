/**
 * TypeSafe JEV Typed Structured Decision Contract (CONV-JEV-01 Step D).
 *
 * Exclusively represents the typed semantic decisions produced by the real TypeSafe AI JEV model
 * (or safe fallback to Deterministic Baseline when remote JEV fails / is disabled).
 *
 * Invariants:
 *  - Distinguishes TypeSafe JEV from Deterministic Baseline and Goal-Driven State.
 *  - NEVER lets the model invent service IDs, provider IDs, slots, or appointments.
 *  - All factual booking data is validated and fulfilled exclusively by FlowPilot
 *    repositories and Booking Core.
 */

import type { JevAnswer } from "./jev-decisions-provider";

export type TypeSafeJevIntent =
  | "BOOKING"
  | "AVAILABILITY"
  | "CATALOG_INQUIRY"
  | "FAQ_INQUIRY"
  | "RESCHEDULE"
  | "CANCELLATION"
  | "FOLLOW_UP"
  | "EXPLICIT_HUMAN"
  | "SENSITIVE_EMERGENCY"
  | "CLARIFICATION"
  | "GREETING"
  | "UNKNOWN_ABSTAIN";

export type TimingPreferenceHint = {
  readonly datePhrase?: string | null;
  readonly timePreference?: "morning" | "afternoon" | "evening" | null;
  readonly explicitTime?: string | null;
};

export type ProviderPreferenceHint = {
  readonly preference: "SPECIFIC" | "ANY" | "SAME_AS_LAST" | null;
  readonly providerNameHint?: string | null;
};

export type ServicePreferenceHint = {
  readonly serviceNameHint?: string | null;
};

export type TypeSafeJevStructuredDecision = {
  /** The primary semantic intent resolved from JEV model facts or fallback. */
  readonly intent: TypeSafeJevIntent;
  /** Confidence score between 0.0 and 1.0. */
  readonly confidence: number;
  /** True when the model abstained or confidence was below actionable threshold. */
  readonly isAbstention: boolean;
  /** Source of this decision: genuine TypeSafe JEV, Deterministic Baseline, or Fallback. */
  readonly source: "TYPESAFE_JEV" | "DETERMINISTIC_BASELINE" | "FALLBACK";
  /** Machine-readable rationale for this decision. */
  readonly reason: string;
  /** If fallback occurred, explicit reason why JEV was bypassed/failed. */
  readonly fallbackReason?: string | null;
  /** Raw probabilities returned by TypeSafe JEV. */
  readonly rawProbabilities?: Record<string, number>;
  /** The single conversationGoal choice if answered by JEV. */
  readonly conversationGoal?: string | null;
  /** Extracted customer preferences (to be validated against repositories). */
  readonly timingPreference?: TimingPreferenceHint;
  readonly providerPreference?: ProviderPreferenceHint;
  readonly servicePreference?: ServicePreferenceHint;
  readonly optionSelection?: number | null;
  /** Execution latency in ms. */
  readonly latencyMs?: number;
  /** Real provider billing tokens if available. */
  readonly tokens?: { input: number; output: number };
  /** Cost in USD if available or estimated. */
  readonly costUsd?: number;
  readonly isCostEstimate?: boolean;
};

/**
 * Maps raw TypeSafe JEV OpenRouter Decisions API answers into the structured decision contract.
 */
export function mapJevAnswersToStructuredDecision(
  answers: Record<string, JevAnswer>,
  _customerText: string,
  options?: {
    latencyMs?: number;
    tokens?: { input: number; output: number };
    costUsd?: number;
    isCostEstimate?: boolean;
  },
): TypeSafeJevStructuredDecision {
  const getProb = (key: string): number => {
    const a = answers[key];
    if (!a) return 0.0;
    if (a.type === "noul") return a.noul;
    return 0.0;
  };

  const probSupport = getProb("supportRequested");
  const probProvider = getProb("providerRequested");
  const probBooking = getProb("bookingRequested");
  const probAvail = getProb("availabilityAsked");
  const probCancel = getProb("cancellationRequested");
  const probReschedule = getProb("rescheduleRequested");
  const probSensitive = getProb("sensitiveTurn");
  const probServicePrice = getProb("serviceOrPriceAsked");
  const probGreeting = getProb("greetingOnly");
  const probAmbiguous = getProb("ambiguousTurn");

  let conversationGoal: string | null = null;
  const goalAnswer = answers["conversationGoal"];
  if (goalAnswer && goalAnswer.type === "choice") {
    conversationGoal = goalAnswer.choice;
  }

  const rawProbabilities: Record<string, number> = {
    supportRequested: probSupport,
    providerRequested: probProvider,
    bookingRequested: probBooking,
    availabilityAsked: probAvail,
    cancellationRequested: probCancel,
    rescheduleRequested: probReschedule,
    sensitiveTurn: probSensitive,
    serviceOrPriceAsked: probServicePrice,
    greetingOnly: probGreeting,
    ambiguousTurn: probAmbiguous,
  };

  // Precedence Evaluation (Calibrated P1/P2 Decision Logic)
  // 1. Safety & Sensitive Emergency (Top Priority)
  if (probSensitive >= 0.7) {
    return {
      intent: "SENSITIVE_EMERGENCY",
      confidence: probSensitive,
      isAbstention: false,
      source: "TYPESAFE_JEV",
      reason: "SENSITIVE_EMERGENCY_DETECTED",
      rawProbabilities,
      conversationGoal,
      ...options,
    };
  }

  // 2. Explicit Human Request (Staff or Provider direct contact)
  if (probSupport >= 0.7 || probProvider >= 0.8) {
    return {
      intent: "EXPLICIT_HUMAN",
      confidence: Math.max(probSupport, probProvider),
      isAbstention: false,
      source: "TYPESAFE_JEV",
      reason:
        probSupport >= 0.7 ? "SUPPORT_REQUESTED" : "PROVIDER_CONTACT_REQUESTED",
      rawProbabilities,
      conversationGoal,
      ...options,
    };
  }

  // 3. Cancellation / Reschedule
  if (probCancel >= 0.75) {
    return {
      intent: "CANCELLATION",
      confidence: probCancel,
      isAbstention: false,
      source: "TYPESAFE_JEV",
      reason: "CANCELLATION_REQUESTED",
      rawProbabilities,
      conversationGoal,
      ...options,
    };
  }
  if (probReschedule >= 0.75) {
    return {
      intent: "RESCHEDULE",
      confidence: probReschedule,
      isAbstention: false,
      source: "TYPESAFE_JEV",
      reason: "RESCHEDULE_REQUESTED",
      rawProbabilities,
      conversationGoal,
      ...options,
    };
  }

  // 4. Booking & Availability
  if (
    probBooking >= 0.7 ||
    conversationGoal === "book_appointment" ||
    conversationGoal === "booking"
  ) {
    return {
      intent: "BOOKING",
      confidence: Math.max(probBooking, 0.85),
      isAbstention: false,
      source: "TYPESAFE_JEV",
      reason: "BOOKING_REQUESTED",
      rawProbabilities,
      conversationGoal,
      ...options,
    };
  }
  if (probAvail >= 0.7) {
    return {
      intent: "AVAILABILITY",
      confidence: probAvail,
      isAbstention: false,
      source: "TYPESAFE_JEV",
      reason: "AVAILABILITY_ASKED",
      rawProbabilities,
      conversationGoal,
      ...options,
    };
  }

  // 5. Catalog / Price / FAQ Inquiry
  if (probServicePrice >= 0.7 || conversationGoal === "ask_question") {
    return {
      intent: "CATALOG_INQUIRY",
      confidence: Math.max(probServicePrice, 0.8),
      isAbstention: false,
      source: "TYPESAFE_JEV",
      reason: "CATALOG_OR_PRICE_ASKED",
      rawProbabilities,
      conversationGoal,
      ...options,
    };
  }

  // 6. Ambiguity / Clarification
  if (probAmbiguous >= 0.7) {
    return {
      intent: "CLARIFICATION",
      confidence: probAmbiguous,
      isAbstention: false,
      source: "TYPESAFE_JEV",
      reason: "AMBIGUOUS_TURN",
      rawProbabilities,
      conversationGoal,
      ...options,
    };
  }

  // 7. Greeting Only
  if (probGreeting >= 0.8) {
    return {
      intent: "GREETING",
      confidence: probGreeting,
      isAbstention: false,
      source: "TYPESAFE_JEV",
      reason: "GREETING_ONLY",
      rawProbabilities,
      conversationGoal,
      ...options,
    };
  }

  // 8. Low Confidence / Abstention
  return {
    intent: "UNKNOWN_ABSTAIN",
    confidence: 0.3,
    isAbstention: true,
    source: "TYPESAFE_JEV",
    reason: "CONFIDENCE_BELOW_THRESHOLD",
    rawProbabilities,
    conversationGoal,
    ...options,
  };
}

/**
 * Creates a safe fallback decision when TypeSafe JEV is disabled, unreachable, or timed out.
 * Explicitly marks source as "FALLBACK" or "DETERMINISTIC_BASELINE" so the system NEVER
 * falsely claims a fallback decision came from JEV.
 */
export function createSafeFallbackDecision(
  fallbackReason: string,
  baselineIntent: TypeSafeJevIntent = "UNKNOWN_ABSTAIN",
  options?: {
    latencyMs?: number;
  },
): TypeSafeJevStructuredDecision {
  return {
    intent: baselineIntent,
    confidence: 1.0,
    isAbstention: false,
    source: "FALLBACK",
    reason: "SAFE_BASELINE_FALLBACK",
    fallbackReason,
    latencyMs: options?.latencyMs ?? 0,
    costUsd: 0,
    isCostEstimate: false,
  };
}
