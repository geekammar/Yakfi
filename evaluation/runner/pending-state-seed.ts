/**
 * FlowPilot AI Evaluation — ENGINE-AUTHORED pending-state seed factory
 * (PROMPT-AI-EVAL-09).
 *
 * Evaluation-ONLY. NOT imported by production. This is the SMALLEST reusable
 * mechanism that lets the FUTURE_SYSTEM bridge establish an ENGINE-AUTHORED
 * pending clarification / task state BEFORE a real-LLM turn, closing the
 * structural EVAL-08 gap: the bridge could reconstruct a pending clarification
 * only from the engine's OWN authored templates, which the dataset's scripted
 * AI turns are not — so under a real LLM the resume / interruption paths never
 * fired and could be proven deterministically only.
 *
 * How it stays faithful (and why it is NOT a second state representation):
 *
 *  - It does NOT invent any ConversationState. It emits a bounded list of
 *    DETERMINISTIC "setup turns" (a customer message + the normalized AI
 *    decision the engine would receive for it). The caller replays each setup
 *    turn through the REAL Conversation Engine (`receiveInboundMessage`) with a
 *    DETERMINISTIC in-memory AI — ZERO real inference — so the ENGINE ITSELF
 *    authors the clarification / booking-offer message into the per-case
 *    history, exactly as production does.
 *  - The pending state is therefore reconstructed later through the SAME
 *    production seams the real turn uses: `derivePendingClarification`
 *    (clarification.ts) + `deriveConversationStateFromHistory`
 *    (conversation-state.ts) + the ONE `mergeConversationState` resume path.
 *    There is NO second resolver, no second state machine, no second fact
 *    model, and no second clarification engine.
 *  - The seed is EXPLICIT and AUDITABLE: each spec names the intended state and
 *    the runner records what the engine actually authored + what the production
 *    seams reconstructed (see `PendingStateSeedAudit`).
 *
 * The spec can establish at least: a pending clarification, a missing fact, an
 * active task, a resumable booking task, and an interruption + later return.
 */

import type { AiResponse } from "@/features/conversations/server/ai-contract";

/** A single DETERMINISTIC setup turn the engine replays to author state. */
export type PendingStateSeedTurn = {
  /** The customer message for the setup turn (never a real-LLM input). */
  readonly message: string;
  /** The normalized AI decision the engine receives (no real inference). */
  readonly decision: AiResponse;
  /** A short, human-readable note for the audit (never message content). */
  readonly note: string;
};

/** The declarative intent of a seed — recorded verbatim in the manifest. */
export type PendingStateSeedSpec = {
  /** Stable id for the seed scenario (auditable in the manifest). */
  readonly id: string;
  /** Which engine-authored state this seed establishes. */
  readonly kind:
    "PENDING_CLARIFICATION_MISSING_FACT" | "RESUMABLE_BOOKING_OFFER";
  /** The intended reconstructed clarification type (null for an offer). */
  readonly intendedClarification: string | null;
  /** The conversation facts intended to be MISSING after the seed. */
  readonly intendedMissingFacts: readonly string[];
  /** The ordered deterministic setup turns the engine replays. */
  readonly turns: readonly PendingStateSeedTurn[];
};

const EMPTY_EXTRACTION = {
  service: null,
  provider: null,
  date: null,
  timePreference: null,
} as const;

/** A booking decision the deterministic seed AI returns (never a real call). */
function bookingDecision(
  service: string | null,
  date: string | null,
): AiResponse {
  return {
    intent: "BOOKING",
    action: "reply",
    content: "حجز",
    extraction: { service, provider: null, date, timePreference: null },
    handoffReason: null,
    summary: null,
  } as AiResponse;
}

/** An ambiguous decision the deterministic seed AI returns (→ CLARIFY_INTENT). */
function ambiguousDecision(): AiResponse {
  return {
    intent: "AMBIGUOUS",
    action: "handoff",
    content: "تحويل",
    extraction: { ...EMPTY_EXTRACTION },
    handoffReason: "AMBIGUOUS",
    summary: null,
  } as AiResponse;
}

/**
 * Seed a pending CLARIFY_DATE: the customer stated a BOOKING with a known
 * service but NO date, so the engine authors its CLARIFY_DATE template. A later
 * real-LLM turn that supplies the date must RESUME (never re-ask the date).
 */
export function resumeDateSeed(service: string): PendingStateSeedSpec {
  return {
    id: "resume-missing-date",
    kind: "PENDING_CLARIFICATION_MISSING_FACT",
    intendedClarification: "CLARIFY_DATE",
    intendedMissingFacts: ["date"],
    turns: [
      {
        message: `عايز أحجز ${service}`,
        decision: bookingDecision(service, null),
        note: "booking with service known, date missing → engine authors CLARIFY_DATE",
      },
    ],
  };
}

/**
 * Seed a pending CLARIFY_SERVICE: the customer stated a BOOKING with NO service,
 * so the engine authors its CLARIFY_SERVICE template. A later real-LLM turn that
 * supplies the service must RESUME (never re-ask the service).
 */
export function resumeServiceSeed(): PendingStateSeedSpec {
  return {
    id: "resume-missing-service",
    kind: "PENDING_CLARIFICATION_MISSING_FACT",
    intendedClarification: "CLARIFY_SERVICE",
    intendedMissingFacts: ["service"],
    turns: [
      {
        message: "عايز أحجز",
        decision: bookingDecision(null, null),
        note: "booking with no service → engine authors CLARIFY_SERVICE",
      },
    ],
  };
}

/**
 * Seed a pending CLARIFY_INTENT: a genuinely unclear turn so the engine authors
 * its intent clarification. A later real-LLM turn either resolves it or asks a
 * genuine clarification — used for the "unresolved CLARIFY stays CLARIFY" axis.
 */
export function clarifyIntentSeed(): PendingStateSeedSpec {
  return {
    id: "clarify-intent",
    kind: "PENDING_CLARIFICATION_MISSING_FACT",
    intendedClarification: "CLARIFY_INTENT",
    intendedMissingFacts: [],
    turns: [
      {
        message: "حاجة غير واضحة خالص",
        decision: ambiguousDecision(),
        note: "unclear turn → engine authors CLARIFY_INTENT",
      },
    ],
  };
}

/**
 * Seed a RESUMABLE booking task with a presented offer: the customer stated a
 * full booking (service + date), so the engine presents its booking-options
 * offer and keeps the task ACTIVE. A later real-LLM INTERRUPTION (a non-task
 * question) must PRESERVE the pending task; a later RETURN must resume it.
 */
export function interruptionSeed(
  service: string,
  date: string,
): PendingStateSeedSpec {
  return {
    id: "interruption-resumable-booking",
    kind: "RESUMABLE_BOOKING_OFFER",
    intendedClarification: null,
    intendedMissingFacts: [],
    turns: [
      {
        message: `عايز أحجز ${service} يوم ${date}`,
        decision: bookingDecision(service, date),
        note: "full booking → engine presents a booking offer (active, resumable task)",
      },
    ],
  };
}
