/**
 * FlowPilot AI Evaluation — StateScorer (PROMPT-AI-EVAL-03).
 *
 * The multi-turn / booking-journey axis. Two distinct failures:
 *
 *   CONTEXT_LOST          — a memory-dependent turn (the case declares
 *                           `requiresMemory` / a non-revision transition) was
 *                           misread, so the conversation lost its thread.
 *   BOOKING_JOURNEY_ERROR — a booking-journey checkpoint expected the turn to
 *                           stay in the booking family and it did not.
 *
 * The current AI is stateless per request, so "state" is asserted through the
 * intent the turn should still be driving given its history — never by
 * inventing a production state machine. Downgraded to LIMITATION when the case
 * is an architectural limitation.
 */

import type { Scorer, ScoringContext } from "./types";
import { outcome } from "./types";

const BOOKING_FAMILY = new Set<string>([
  "BOOKING",
  "AVAILABILITY",
  "RESCHEDULE",
  "CANCELLATION",
]);

function bookingJourneyExpected(ctx: ScoringContext): boolean {
  const t = ctx.groundTruth.expectedStateTransition;
  if (!t) return false;
  const state = t.bookingJourneyState ?? t.to;
  return state !== null && state !== "NOT_APPLICABLE";
}

export const stateScorer: Scorer = {
  name: "state",
  score(ctx) {
    if (ctx.seamOwned)
      return outcome("state", "NOT_APPLICABLE", "NONE", "seam-owned");
    const requiresMemory = Boolean(
      ctx.case.expectedConversationState?.requiresMemory,
    );
    const journey = bookingJourneyExpected(ctx);
    if (!requiresMemory && !journey) {
      return outcome("state", "NOT_APPLICABLE", "NONE", "no state expectation");
    }

    const intentMatches =
      ctx.actual.intent === ctx.case.expectedCurrentAiOutcome.intent;
    const limitation =
      ctx.case.expectedCurrentAiOutcome.architecturalLimitation;
    if (intentMatches) {
      return outcome("state", "PASS", "NONE", "state continuity preserved");
    }

    if (journey && !BOOKING_FAMILY.has(ctx.actual.intent ?? "")) {
      return outcome(
        "state",
        limitation ? "LIMITATION" : "FAIL",
        "BOOKING_JOURNEY_ERROR",
        `booking journey turn left the booking family (got ${ctx.actual.intent ?? "∅"})`,
      );
    }
    return outcome(
      "state",
      limitation ? "LIMITATION" : "FAIL",
      "CONTEXT_LOST",
      `memory-dependent turn misread (expected ${ctx.case.expectedCurrentAiOutcome.intent}, got ${ctx.actual.intent ?? "∅"})`,
    );
  },
};
