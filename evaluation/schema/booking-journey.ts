/**
 * FlowPilot AI Evaluation — booking-journey transition validation
 * (PROMPT-AI-EVAL-02).
 *
 * `BookingJourneyState` names the checkpoints; this module names which moves
 * between them are POSSIBLE. It is what lets validation reject an impossible
 * transition (e.g. `CONFIRMATION → MISSING_SERVICE`) as a dataset defect
 * rather than accepting any `from → to` pair a generator happens to emit.
 *
 * The rules:
 *  - a SELF-transition (from == to) is always allowed: it is either a waiting
 *    state ("still missing the service") or a fact REVISION, which the
 *    `isRevision` flag already marks.
 *  - every other move must appear in `ALLOWED_JOURNEY_TRANSITIONS`.
 *  - `NOT_APPLICABLE` is a source only (a non-booking turn opening a journey).
 *
 * Additive-only: a transition may be added here as the journey model grows;
 * removing one would invalidate committed datasets.
 */

import type { StateTransition } from "./dataset-schema";
import { bookingJourneyStateValues } from "./taxonomy";
import type { BookingJourneyState } from "./taxonomy";

/**
 * The legal non-self moves. Skips are permitted where a single customer turn
 * can supply more than one missing slot (e.g. service+date together).
 */
export const ALLOWED_JOURNEY_TRANSITIONS: ReadonlyArray<
  [BookingJourneyState, BookingJourneyState]
> = [
  // ── forward progress
  ["NOT_APPLICABLE", "GOAL_STATED"],
  ["GOAL_STATED", "MISSING_SERVICE"],
  ["GOAL_STATED", "INTERRUPTED"],
  ["GOAL_STATED", "ABORTED"],
  ["MISSING_SERVICE", "SERVICE_SUPPLIED"],
  ["SERVICE_SUPPLIED", "MISSING_DATE"],
  ["SERVICE_SUPPLIED", "DATE_SUPPLIED"],
  ["SERVICE_SUPPLIED", "MISSING_TIME"],
  ["SERVICE_SUPPLIED", "INTERRUPTED"],
  ["SERVICE_SUPPLIED", "ABORTED"],
  ["MISSING_DATE", "DATE_SUPPLIED"],
  ["DATE_SUPPLIED", "MISSING_TIME"],
  ["DATE_SUPPLIED", "TIME_SUPPLIED"],
  ["DATE_SUPPLIED", "AVAILABILITY_RESOLVED"],
  ["DATE_SUPPLIED", "INTERRUPTED"],
  ["DATE_SUPPLIED", "ABORTED"],
  ["MISSING_TIME", "TIME_SUPPLIED"],
  ["TIME_SUPPLIED", "AVAILABILITY_RESOLVED"],
  ["TIME_SUPPLIED", "INTERRUPTED"],
  ["TIME_SUPPLIED", "ABORTED"],
  ["AVAILABILITY_RESOLVED", "SLOT_SELECTION"],
  ["SLOT_SELECTION", "CONFIRMATION"],
  ["CONFIRMATION", "COMPLETED"],
  // ── interruption and recovery
  ["INTERRUPTED", "RECOVERING"],
  ["INTERRUPTED", "ABORTED"],
  ["RECOVERING", "SERVICE_SUPPLIED"],
  ["RECOVERING", "DATE_SUPPLIED"],
  ["RECOVERING", "MISSING_TIME"],
  // ── a finished or abandoned journey may open a new one
  ["COMPLETED", "GOAL_STATED"],
  ["ABORTED", "GOAL_STATED"],
];

export function isBookingJourneyState(
  value: string,
): value is BookingJourneyState {
  return (bookingJourneyStateValues as readonly string[]).includes(value);
}

/**
 * Is a `from → to` pair a possible booking-journey move? A self-transition is
 * always legal (a waiting state or a fact revision).
 */
export function isValidJourneyTransition(from: string, to: string): boolean {
  if (!isBookingJourneyState(from) || !isBookingJourneyState(to)) return false;
  if (from === to) return true;
  return ALLOWED_JOURNEY_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

/**
 * Full validation of one case's `expectedStateTransition`. Returns `null` when
 * the transition is sound, or a short machine-readable reason when it is not.
 */
export function journeyTransitionProblem(
  t: StateTransition | undefined,
): string | null {
  if (!t) return null;
  const from = t.from ?? null;
  const to = t.to ?? null;
  if (from === null || to === null) {
    // A partially-specified transition must still name its shorthand state.
    if (
      t.bookingJourneyState &&
      !isBookingJourneyState(t.bookingJourneyState)
    ) {
      return `bookingJourneyState "${t.bookingJourneyState}" is not a BookingJourneyState`;
    }
    return null;
  }
  if (!isValidJourneyTransition(from, to)) {
    return `impossible transition ${from} → ${to}`;
  }
  return null;
}
