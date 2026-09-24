/**
 * Pure presentation helpers for Step 4 — الوقت (PROMPT-12).
 *
 * Everything here is display-only grouping/formatting of slots that the
 * PROMPT-10 availability layer produced. No slot times are invented,
 * filtered, or recalculated on the client — the helpers only arrange
 * what the server returned.
 */

import type { AvailabilitySlot } from "@/features/appointments/types";
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

export type SlotGroup = {
  period: SlotPeriodKey;
  label: string;
  slots: AvailabilitySlot[];
};

/**
 * Group server-provided slots into morning / afternoon / evening for
 * scannability. Empty groups are omitted; within a group the server's
 * chronological order is preserved untouched.
 */
export function groupSlotsByPeriod(slots: AvailabilitySlot[]): SlotGroup[] {
  const grouped = new Map<SlotPeriodKey, AvailabilitySlot[]>();
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
