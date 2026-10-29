/**
 * Day-level capacity derivation for the booking date step (B-09).
 *
 * PURE presentation logic over an `AvailabilityResult` produced by the
 * ONE availability authority (`getAvailabilityAction` → `getAvailability`,
 * PROMPT-10). This module invents no slots, reads no database, and
 * recomputes no availability — it only translates the authority's
 * already-computed answer for one date into a chip state + Arabic label
 * so a day with no selectable capacity is visibly distinct BEFORE the
 * user spends a tap on it.
 *
 * The date step remains availability-uncoupled in its DATE MATH:
 * `date-format.ts` (the relative choices + windows) is pure calendar
 * arithmetic and knows nothing about availability. Only the rendered
 * chips consult the authority's result through this helper.
 */

import type { AvailabilityResult } from "@/features/appointments/types";

/**
 * The capacity state of one offered day, derived from the authority's
 * result:
 * - `available` — the authority returned at least one bookable slot.
 * - `closed` — `BUSINESS_CLOSED`: the business does not work that day.
 * - `full` — `FULLY_BOOKED`: open, but every candidate slot is taken.
 * - `too-long` — `SERVICE_TOO_LONG`: open, but this service's duration
 *   never fits the day's hours (a service-specific capacity fact).
 * - `unknown` — not loaded yet, or the authority returned an error/the
 *   day was not requested. The chip stays undecorated and selectable
 *   rather than fabricating a state; the slot step remains the honest
 *   authority for the chosen day.
 */
export type DayCapacityState =
  | "available"
  | "closed"
  | "full"
  | "too-long"
  | "no-providers"
  | "no-remaining"
  | "unknown";

/** Arabic labels — never rely on color alone to convey the state. */
export const DAY_CAPACITY_LABELS: Record<
  Exclude<DayCapacityState, "unknown">,
  string
> = {
  available: "متاح",
  closed: "مغلق",
  full: "ممتلئ",
  "too-long": "غير متاح",
  "no-providers": "غير متاح",
  "no-remaining": "غير متاح",
};

/** A day is not selectable when the authority reported zero capacity. */
export function isDayUnselectable(
  state: DayCapacityState,
): state is "closed" | "full" | "too-long" | "no-providers" | "no-remaining" {
  return (
    state === "closed" ||
    state === "full" ||
    state === "too-long" ||
    state === "no-providers" ||
    state === "no-remaining"
  );
}

/**
 * Derive one day's capacity state from the authority's result. Any
 * non-success or absent result yields `unknown` — the UI never guesses
 * a state it cannot prove (fail open to "selectable", with the slot
 * step still giving the honest answer for the chosen day).
 */
export function dayCapacityState(
  result: AvailabilityResult | undefined,
): DayCapacityState {
  if (!result || !result.success) return "unknown";
  if (result.data.slots.length > 0) return "available";
  // Zero slots always carry an explicit reason by the availability
  // contract; the defensive fallback is "full" (an open day with no
  // free capacity) never "closed".
  if (result.reason === "BUSINESS_CLOSED") return "closed";
  if (result.reason === "SERVICE_TOO_LONG") return "too-long";
  if (result.reason === "NO_ELIGIBLE_PROVIDERS") return "no-providers";
  if (result.reason === "NO_REMAINING_TIMES") return "no-remaining";
  return "full";
}
