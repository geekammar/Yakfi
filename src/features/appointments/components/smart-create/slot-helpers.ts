/**
 * Pure presentation helpers for Step 4 — الوقت (PROMPT-12).
 *
 * Everything here is display-only grouping/formatting of slots that the
 * PROMPT-10 availability layer produced. No slot times are invented,
 * filtered, or recalculated on the client — the helpers only arrange
 * what the server returned.
 */

import type { AvailabilitySlot } from "@/features/appointments/types";
import type { CandidateSlot } from "@/lib/scheduling/slot-grid";
import { TIMEZONES } from "@/lib/validation";

/** Business-local wall-clock times anchor on the UTC epoch date so the
 * stored "HH:mm" renders without any device-timezone drift. */
function parseWallClock(time: string): Date {
  return new Date(`1970-01-01T${time}:00.000Z`);
}

/** "10:30" → "١٠:٣٠ ص" (the agenda's Arabic time convention). */
export function formatSlotTime(time: string): string {
  return new Intl.DateTimeFormat("ar-EG", {
    timeZone: "UTC",
    hour: "numeric",
    minute: "2-digit",
  }).format(parseWallClock(time));
}

/** Minutes since midnight for a "HH:mm" wall-clock string. */
function toMinutes(time: string): number {
  const [hours = 0, minutes = 0] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

export type SlotPeriodKey = "morning" | "afternoon" | "evening";

export const SLOT_PERIOD_LABELS: Record<SlotPeriodKey, string> = {
  morning: "الصباح",
  afternoon: "بعد الظهر",
  evening: "المساء",
};

/** 12:00 separates morning from afternoon; 17:00 starts the evening. */
const AFTERNOON_START = 12 * 60;
const EVENING_START = 17 * 60;

function periodOf(time: string): SlotPeriodKey {
  const minutes = toMinutes(time);
  if (minutes < AFTERNOON_START) return "morning";
  if (minutes < EVENING_START) return "afternoon";
  return "evening";
}

export type SlotGroup<T extends AvailabilitySlot = AvailabilitySlot> = {
  period: SlotPeriodKey;
  label: string;
  slots: T[];
};

/**
 * Group server-provided slots into morning / afternoon / evening for
 * scannability. Empty groups are omitted; within a group the server's
 * chronological order is preserved untouched. Generic over the slot
 * shape so the presentational candidate grid (a candidate + its
 * availability flag) groups through the SAME helper without a second
 * grouping implementation.
 */
export function groupSlotsByPeriod<T extends AvailabilitySlot>(
  slots: T[],
): SlotGroup<T>[] {
  const grouped = new Map<SlotPeriodKey, T[]>();
  for (const slot of slots) {
    const period = periodOf(slot.startTime);
    const bucket = grouped.get(period);
    if (bucket) bucket.push(slot);
    else grouped.set(period, [slot]);
  }
  const order: SlotPeriodKey[] = ["morning", "afternoon", "evening"];
  return order
    .filter((period) => grouped.has(period))
    .map((period) => ({
      period,
      label: SLOT_PERIOD_LABELS[period],
      slots: grouped.get(period) ?? [],
    }));
}

/**
 * One candidate time carrying its PRESENTATIONAL availability state
 * (DECISIONS #56): `available` is true ONLY when the authority's
 * current result contains the candidate. An unavailable candidate is
 * still rendered (visibly muted, disabled, non-clickable) — it is never
 * dropped, and no reason is ever attached to it.
 */
export type PresentSlot = AvailabilitySlot & {
  available: boolean;
};

/**
 * Derive what the slot step renders as chips (DECISIONS #56), pure and
 * unit-verified:
 *
 * - when the candidate grid can be derived (the business's working-hours
 *   week + slot granularity + the authority's service duration), every
 *   candidate is shown, flagged by its EXACT membership in the
 *   authority's available set — selectable when returned, visibly
 *   unavailable otherwise;
 * - when the grid source is absent, the step honestly falls back to the
 *   authority's selectable slots only (available slots are never hidden
 *   because the grid could not be built, and nothing is invented);
 * - `null` when neither exists — the step's empty state answers.
 *
 * The authority contract is untouched: it still returns only genuinely
 * selectable slots, and this layer infers no reason from absence.
 */
export function derivePresentSlots(params: {
  candidateGrid: CandidateSlot[] | null;
  availableSlots: AvailabilitySlot[] | null;
}): PresentSlot[] | null {
  const { candidateGrid, availableSlots } = params;
  if (candidateGrid && candidateGrid.length > 0) {
    return candidateGrid.map((candidate) => ({
      startTime: candidate.startTime,
      endTime: candidate.endTime,
      available: availableSlots
        ? slotExistsIn(candidate, availableSlots)
        : false,
    }));
  }
  if (availableSlots && availableSlots.length > 0) {
    return availableSlots.map((slot) => ({ ...slot, available: true }));
  }
  return null;
}

/**
 * Exact-membership check for the wizard's stale-selection guard: a
 * previously selected slot is only still valid while the CURRENT
 * availability result contains it (defensive backstop — the wizard
 * already clears the selection when service or date changes).
 */
export function slotExistsIn(
  slot: Pick<AvailabilitySlot, "startTime" | "endTime"> | null,
  slots: AvailabilitySlot[],
): boolean {
  if (!slot) return false;
  return slots.some(
    (candidate) =>
      candidate.startTime === slot.startTime &&
      candidate.endTime === slot.endTime,
  );
}

/**
 * The earliest (first) slot of a server-provided list — the
 * "أقرب وقت متاح" quick pick (B-07 §C). The availability contract
 * returns slots ascending, chronologically ordered, so the first entry
 * IS the earliest valid time; this helper invents nothing and is null
 * when the day has no bookable slot.
 */
export function earliestSlot(
  slots: AvailabilitySlot[],
): AvailabilitySlot | null {
  return slots.at(0) ?? null;
}

/** Arabic label for a stored Business timezone (fallback for unknown
 * IANA values). */
export function timezoneLabel(timezone: string): string {
  return (
    TIMEZONES.find((entry) => entry.value === timezone)?.label ??
    "توقيت المنشأة"
  );
}
