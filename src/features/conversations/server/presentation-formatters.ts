/**
 * Presentation Formatters for Unified Booking Choices UX (CONV-UX-01).
 *
 * Implements authoritative, channel-neutral date, time, provider and copy
 * formatting across Telegram and WhatsApp:
 *
 * - Dates: Arabic weekday + unambiguous calendar date (e.g. "الأحد، 25 أكتوبر").
 *   Optional relative prefix "اليوم" / "غدًا" without replacing weekday/date.
 * - Times: 12-hour Arabic display with explicit "ص" / "م" (e.g. "10:00 ص", "2:30 م").
 *   Midnight 00:00 -> "12:00 ص", noon 12:00 -> "12:00 م".
 *   Existing slot timestamps are business-local wall-clock values: string-based
 *   pure extraction prevents unintended UTC shifts or double-conversions.
 * - Provider: If all slots share the same providerId, mention that provider once
 *   in the message header and omit repetition from individual slot labels.
 *   If providers differ, identify each provider on each relevant choice.
 * - Copy: Clear next action instructions, no duplicated headings, no staff contact
 *   promises unless the domain workflow requires it.
 */

import { weekdayOf } from "@/features/appointments/server/availability-service";
import {
  resolveValidTimeZone,
  todayIsoInTimeZone,
} from "@/features/conversations/server/temporal-context";
import { nowTimeInTimeZone } from "@/lib/scheduling/slot-grid";

export const ARABIC_WEEKDAYS: Record<string, string> = {
  sat: "السبت",
  sun: "الأحد",
  mon: "الإثنين",
  tue: "الثلاثاء",
  wed: "الأربعاء",
  thu: "الخميس",
  fri: "الجمعة",
};

export const ARABIC_MONTHS = [
  "يناير",
  "فبراير",
  "مارس",
  "أبريل",
  "مايو",
  "يونيو",
  "يوليو",
  "أغسطس",
  "سبتمبر",
  "أكتوبر",
  "نوفمبر",
  "ديسمبر",
] as const;

/**
 * Format a 24-hour wall-clock time ("HH:mm" or "YYYY-MM-DDTHH:mm") into 12-hour
 * Arabic display with explicit "ص" / "م".
 */
export function formatArabicTime12h(timeStr: string): string {
  if (!timeStr) return "";
  const rawTime = timeStr.includes("T")
    ? timeStr.slice(11, 16)
    : timeStr.slice(0, 5);
  const parts = rawTime.split(":");
  if (parts.length < 2) return rawTime;

  const rawH = parseInt(parts[0]!, 10);
  const mm = parts[1]!.padStart(2, "0");
  if (Number.isNaN(rawH)) return rawTime;

  const period = rawH < 12 ? "ص" : "م";
  const displayH = rawH === 0 ? 12 : rawH > 12 ? rawH - 12 : rawH;

  return `${displayH}:${mm} ${period}`;
}

export type ArabicDateOptions = {
  todayIso?: string;
  tomorrowIso?: string;
  withRelativePrefix?: boolean;
};

/**
 * Format an ISO calendar date ("YYYY-MM-DD") into unambiguous Arabic calendar display
 * with weekday, day of month, and Arabic month name.
 *
 * Example:
 * - "2026-10-25" -> "الأحد، 25 أكتوبر"
 * - with todayIso="2026-10-25" -> "اليوم الأحد، 25 أكتوبر"
 * - with tomorrowIso="2026-10-25" -> "غدًا الأحد، 25 أكتوبر"
 */
export function formatArabicDate(
  dateIso: string,
  options?: ArabicDateOptions,
): string {
  const trimmed = dateIso.trim().slice(0, 10);
  const [, mStr, dStr] = trimmed.split("-");
  const m = parseInt(mStr ?? "", 10);
  const d = parseInt(dStr ?? "", 10);

  if (Number.isNaN(m) || Number.isNaN(d) || m < 1 || m > 12) {
    return trimmed;
  }

  const weekdayKey = weekdayOf(trimmed);
  const weekdayName = ARABIC_WEEKDAYS[weekdayKey] ?? weekdayKey;
  const monthName = ARABIC_MONTHS[m - 1] ?? mStr;

  const standardDate = `${weekdayName}، ${d} ${monthName}`;

  if (options?.withRelativePrefix !== false) {
    if (options?.todayIso && trimmed === options.todayIso) {
      return `اليوم ${standardDate}`;
    }
    if (options?.tomorrowIso && trimmed === options.tomorrowIso) {
      return `غدًا ${standardDate}`;
    }
  }

  return standardDate;
}

export type SlotOptionPresentation = {
  index: number;
  providerId?: string | null;
  displayName?: string | null;
  startAt: string;
  endAt?: string | null;
};

/**
 * Check whether all displayed slots belong to the same stable provider ID.
 */
export function areSlotsSingleProvider(
  slots: ReadonlyArray<{ providerId?: string | null }>,
): boolean {
  if (slots.length <= 1) return true;
  const ids = new Set(
    slots.map((s) => (s.providerId ? s.providerId.trim() : "")),
  );
  return ids.size <= 1;
}

/**
 * Format a customer-visible slot choice label.
 *
 * If `isSingleProvider` is true, omits provider name repetition.
 * If false (different providers), appends the provider's display name.
 */
export function formatSlotChoiceLabel(
  slot: SlotOptionPresentation,
  isSingleProvider: boolean,
): string {
  const time = formatArabicTime12h(slot.startAt);
  if (isSingleProvider || !slot.displayName) {
    return `${slot.index}️⃣ ${time}`;
  }
  return `${slot.index}️⃣ ${time} (${slot.displayName})`;
}

function extractNormalizedSlotTime(item: unknown): string {
  const obj = item as Record<string, unknown> | null | undefined;
  const raw =
    (typeof obj?.startAt === "string" && obj.startAt) ||
    (typeof obj?.startTime === "string" && obj.startTime) ||
    (typeof obj?.time === "string" && obj.time) ||
    "";
  if (!raw) return "";
  const t = raw.includes("T") ? raw.slice(11, 16) : raw.trim();
  const match = /^(\d{1,2}):(\d{2})/.exec(t);
  if (match) {
    return `${match[1]!.padStart(2, "0")}:${match[2]!}`;
  }
  return t;
}

/**
 * Exclude past/elapsed slots for today based on business-local wall-clock time.
 * Future dates remain unaffected. Past dates return empty.
 */
export function filterElapsedSlots<
  T extends { startAt?: string; startTime?: string; time?: string },
>(slots: ReadonlyArray<T>, date: string, now: Date, timeZone: string): T[] {
  const tz = resolveValidTimeZone(timeZone);
  const todayIso = todayIsoInTimeZone(now, tz);
  if (date !== todayIso) {
    if (date < todayIso) return [];
    return [...slots];
  }
  const currentTime = nowTimeInTimeZone(now, tz);
  return slots.filter((slot) => {
    const slotTime = extractNormalizedSlotTime(slot);
    return slotTime > currentTime;
  });
}

/**
 * Deterministically select up to `max` representative slots spread across the
 * available eligible set rather than adjacent early times.
 *
 * Normalizes candidates into stable chronological order before sampling,
 * deduplicates candidates by stable slot identity, and displays selected
 * items chronologically.
 *
 * If `nearestFirst` is explicitly requested, preserves nearest-first order.
 */
export function sampleRepresentativeSlots<
  T extends {
    startAt?: string;
    startTime?: string;
    time?: string;
    providerId?: string | null;
  },
>(
  candidates: ReadonlyArray<T>,
  max = 4,
  options?: { nearestFirst?: boolean },
): T[] {
  if (candidates.length === 0) return [];

  // Deduplicate by stable slot key (providerId + normalized start time)
  const seen = new Set<string>();
  const deduplicated: T[] = [];
  for (const c of candidates) {
    const slotTime = extractNormalizedSlotTime(c);
    const key = `${c.providerId ?? ""}:${slotTime}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduplicated.push(c);
    }
  }

  // Normalize into stable chronological order (chronological by time, tie-break by providerId)
  const sorted = [...deduplicated].sort((a, b) => {
    const timeA = extractNormalizedSlotTime(a);
    const timeB = extractNormalizedSlotTime(b);
    if (timeA !== timeB) return timeA.localeCompare(timeB);
    return (a.providerId ?? "").localeCompare(b.providerId ?? "");
  });

  if (sorted.length <= max) return sorted;
  if (options?.nearestFirst) {
    return sorted.slice(0, max);
  }

  const N = sorted.length;
  const indices = [
    0,
    Math.floor((N - 1) * 0.33),
    Math.floor((N - 1) * 0.67),
    N - 1,
  ];
  const uniqueIndices = Array.from(new Set(indices)).sort((a, b) => a - b);
  const picked = uniqueIndices.map((i) => sorted[i]!);

  if (picked.length < max) {
    const pickedSet = new Set(uniqueIndices);
    for (let i = 0; i < N && picked.length < max; i++) {
      if (!pickedSet.has(i)) {
        picked.push(sorted[i]!);
        pickedSet.add(i);
      }
    }
    // Re-sort chronologically
    picked.sort((a, b) => {
      const timeA = extractNormalizedSlotTime(a);
      const timeB = extractNormalizedSlotTime(b);
      if (timeA !== timeB) return timeA.localeCompare(timeB);
      return (a.providerId ?? "").localeCompare(b.providerId ?? "");
    });
  }

  return picked.slice(0, max);
}

/**
 * Format the booking options message copy.
 */
export function formatBookingOptionsCopy(params: {
  serviceName: string;
  date: string;
  formattedDate?: string;
  options: ReadonlyArray<SlotOptionPresentation>;
  followUpRequestId?: string | null;
  isMoreTimes?: boolean;
}): string {
  const { serviceName, date, options, followUpRequestId, isMoreTimes } = params;
  const singleProvider = areSlotsSingleProvider(options);
  const providerName =
    singleProvider && options[0]?.displayName
      ? options[0].displayName.trim()
      : null;

  const displayDate = params.formattedDate ?? date;
  const providerMention = providerName ? ` مع ${providerName}` : "";

  let header: string;
  if (isMoreTimes) {
    header = `إليك أوقاتاً أخرى متاحة لخدمة "${serviceName}"${providerMention} يوم ${displayDate}:`;
  } else if (followUpRequestId) {
    header = `تتوفر المواعيد التالية لمتابعة "${serviceName}"${providerMention} يوم ${displayDate}:`;
  } else {
    header = `تتوفر المواعيد التالية لخدمة "${serviceName}"${providerMention} يوم ${displayDate}:`;
  }

  const lines = options.map((opt) => {
    const start12 = formatArabicTime12h(opt.startAt);
    const end12 = opt.endAt ? formatArabicTime12h(opt.endAt) : "";
    const timeSpan = end12 ? `${start12} إلى ${end12}` : start12;

    if (singleProvider || !opt.displayName) {
      return `${opt.index}. ${timeSpan}`;
    }
    return `${opt.index}. ${opt.displayName} — ${timeSpan}`;
  });

  const followUpTag = followUpRequestId
    ? `\n[متابعة: ${followUpRequestId}]`
    : "";
  const instructions = "يرجى اختيار الموعد المناسب لإتمام الحجز.";

  return `${header}\n${lines.join("\n")}${followUpTag}\n${instructions}`;
}
