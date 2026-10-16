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

export type SmartTimeSuggestion = {
  slot: AvailabilitySlot;
  providerId: string | null;
  providerName?: string;
  badge: string;
  reason:
    | "earliest"
    | "same_time_alternative"
    | "preferred_provider_alternative"
    | "nearby";
};

/**
 * Derive a small group (normally 2–3) of genuinely useful, valid
 * suggestions first (UX001-R1 Requirement 2).
 *
 * Prioritizes:
 * - Closest requested time when provided.
 * - Earliest suitable time otherwise.
 * - Same time with another eligible provider if relevant.
 * - Nearby time with the preferred provider.
 * Avoids redundant suggestions if more useful distinct alternatives exist.
 * Pure derivation over the server's availability slots — no N+1 queries.
 */
export function deriveSmartSuggestions(params: {
  slots: AvailabilitySlot[];
  eligibleProviders: Array<{ providerId: string; displayName: string }>;
  selectedProviderId: string | null;
  requestedTime?: string | null;
  maxSuggestions?: number;
}): SmartTimeSuggestion[] {
  const {
    slots,
    eligibleProviders,
    selectedProviderId,
    requestedTime,
    maxSuggestions = 3,
  } = params;
  if (!slots || slots.length === 0) return [];

  const providerMap = new Map(
    eligibleProviders.map((p) => [p.providerId, p.displayName]),
  );
  const isSingleProvider = eligibleProviders.length === 1;
  const suggestions: SmartTimeSuggestion[] = [];
  const addedKeys = new Set<string>();

  function addSuggestion(
    slot: AvailabilitySlot,
    providerId: string | null,
    badge: string,
    reason: SmartTimeSuggestion["reason"],
  ) {
    const key = `${slot.startTime}:${providerId ?? "any"}`;
    if (!addedKeys.has(key) && suggestions.length < maxSuggestions) {
      addedKeys.add(key);
      const providerName = providerId ? providerMap.get(providerId) : undefined;
      suggestions.push({ slot, providerId, providerName, badge, reason });
    }
  }

  // Case 1: Single eligible provider — no alternative provider suggestions
  if (isSingleProvider) {
    const onlyProvider = eligibleProviders[0];
    const pid = onlyProvider?.providerId ?? null;
    const first = slots[0];
    if (first) {
      addSuggestion(first, pid, "أقرب وقت متاح", "earliest");
    }
    // Pick spaced distinct slots if available
    for (
      let i = 1;
      i < slots.length && suggestions.length < maxSuggestions;
      i++
    ) {
      const slot = slots[i];
      if (slot) {
        addSuggestion(slot, pid, "وقت متاح", "nearby");
      }
    }
    return suggestions;
  }

  // Case 2: Specific provider selected among multiple
  if (selectedProviderId) {
    const preferredName =
      providerMap.get(selectedProviderId) ?? "الموظف المفضل";

    // 2a. If requested time provided, check if it's available or offer same-time alternative
    if (requestedTime) {
      const targetSlot = slots.find((s) => s.startTime === requestedTime);
      if (targetSlot) {
        const canPreferred =
          targetSlot.availableProviderIds?.includes(selectedProviderId) ??
          false;
        if (canPreferred) {
          addSuggestion(
            targetSlot,
            selectedProviderId,
            "الوقت المطلوب",
            "earliest",
          );
        } else {
          // Same time with another eligible provider
          const altId = targetSlot.availableProviderIds?.find(
            (id) => id !== selectedProviderId,
          );
          if (altId) {
            const altName = providerMap.get(altId) ?? "موظف آخر";
            addSuggestion(
              targetSlot,
              altId,
              `متاح مع ${altName}`,
              "same_time_alternative",
            );
          }
        }
      }
    }

    // 2b. Earliest available slot with preferred provider
    const preferredSlots = slots.filter((s) =>
      s.availableProviderIds
        ? s.availableProviderIds.includes(selectedProviderId)
        : true,
    );
    const earliestPreferred = preferredSlots[0];
    if (earliestPreferred) {
      addSuggestion(
        earliestPreferred,
        selectedProviderId,
        `أقرب وقت مع ${preferredName}`,
        "preferred_provider_alternative",
      );
    }

    // 2c. If the earliest day slot is with another provider (and not preferred)
    const dayFirst = slots[0];
    if (
      dayFirst &&
      (!dayFirst.availableProviderIds ||
        !dayFirst.availableProviderIds.includes(selectedProviderId))
    ) {
      const altId = dayFirst.availableProviderIds?.[0] ?? null;
      const altName = altId ? providerMap.get(altId) : null;
      addSuggestion(
        dayFirst,
        altId,
        altName ? `أقرب وقت اليوم (مع ${altName})` : "أقرب وقت متاح",
        "same_time_alternative",
      );
    }

    // 2d. Backfill with remaining preferred provider slots
    for (
      let i = 1;
      i < preferredSlots.length && suggestions.length < maxSuggestions;
      i++
    ) {
      const nextSlot = preferredSlots[i];
      if (nextSlot) {
        addSuggestion(
          nextSlot,
          selectedProviderId,
          `متاح مع ${preferredName}`,
          "nearby",
        );
      }
    }

    // 2e. If still not full, backfill with any available slots
    for (const slot of slots) {
      if (suggestions.length >= maxSuggestions) break;
      const altId = slot.availableProviderIds?.[0] ?? null;
      const altName = altId ? providerMap.get(altId) : null;
      addSuggestion(
        slot,
        altId,
        altName ? `متاح مع ${altName}` : "وقت متاح",
        "nearby",
      );
    }

    return suggestions;
  }

  // Case 3: "Any available provider" selected among multiple
  const firstSlot = slots[0];
  if (firstSlot) {
    const firstPid = firstSlot.availableProviderIds?.[0] ?? null;
    const firstPname = firstPid ? providerMap.get(firstPid) : null;
    addSuggestion(
      firstSlot,
      firstPid,
      firstPname ? `أقرب وقت · مع ${firstPname}` : "أقرب وقت متاح",
      "earliest",
    );
  }

  // Prioritize diverse providers for distinct suggestions
  const seenProviders = new Set<string>();
  if (firstSlot?.availableProviderIds?.[0]) {
    seenProviders.add(firstSlot.availableProviderIds[0]);
  }

  // Try to find earliest slot for each other provider
  for (const slot of slots.slice(1)) {
    if (suggestions.length >= maxSuggestions) break;
    const otherPid = slot.availableProviderIds?.find(
      (pid) => !seenProviders.has(pid),
    );
    if (otherPid) {
      seenProviders.add(otherPid);
      const otherName = providerMap.get(otherPid);
      addSuggestion(
        slot,
        otherPid,
        otherName ? `متاح مع ${otherName}` : "وقت متاح",
        "nearby",
      );
    }
  }

  // Backfill with chronologically earliest remaining slots
  for (const slot of slots.slice(1)) {
    if (suggestions.length >= maxSuggestions) break;
    const pid = slot.availableProviderIds?.[0] ?? null;
    const pname = pid ? providerMap.get(pid) : null;
    addSuggestion(slot, pid, pname ? `متاح مع ${pname}` : "وقت متاح", "nearby");
  }

  return suggestions;
}
