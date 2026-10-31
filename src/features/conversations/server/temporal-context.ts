/**
 * Server-Derived Temporal Context & Timezone Utilities (CORE-03B1).
 *
 * Provides a provider-neutral, trusted temporal anchor for the current turn.
 * Ensures relative date interpretation in AI providers is anchored to the
 * business timezone and canonical turn clock instant.
 */

import { z } from "zod";

/**
 * Validates whether an unknown value is a real calendar ISO date ("YYYY-MM-DD").
 * Rejects non-strings, incorrect formats, impossible dates (e.g. 2026-11-31, 2026-02-30),
 * and non-leap day dates (e.g. 2025-02-29).
 */
export function isValidIsoCalendarDate(val: unknown): val is string {
  if (typeof val !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(val)) {
    return false;
  }
  const d = new Date(`${val}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === val;
}

/**
 * Validates a "YYYY-MM-DD" real calendar date.
 */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "التاريخ غير صالح")
  .refine(isValidIsoCalendarDate, { error: "التاريخ غير صالح" });

/**
 * Validates a real calendar date range with start <= end.
 */
export const dateRangeSchema = z
  .object({
    startDate: z.string().refine(isValidIsoCalendarDate, {
      message: "تاريخ بداية الفترة غير صالح",
    }),
    endDate: z.string().refine(isValidIsoCalendarDate, {
      message: "تاريخ نهاية الفترة غير صالح",
    }),
  })
  .refine((r) => r.startDate <= r.endDate, {
    message: "تاريخ بداية الفترة يجب أن يكون قبل أو يطابق تاريخ النهاية",
  });

export type DateRange = z.infer<typeof dateRangeSchema>;

/**
 * Checks whether an IANA timezone string is recognized by the runtime Intl engine.
 */
export function isValidTimeZone(timeZone: string): boolean {
  if (
    !timeZone ||
    typeof timeZone !== "string" ||
    timeZone.trim().length === 0
  ) {
    return false;
  }
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timeZone.trim() });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves a safe, validated IANA timezone for the turn.
 * Reuses the existing policy: when missing or invalid, falls back to "UTC".
 */
export function resolveValidTimeZone(timeZone?: string | null): string {
  if (typeof timeZone === "string" && isValidTimeZone(timeZone)) {
    return timeZone.trim();
  }
  return "UTC";
}

/**
 * Formats a Date into a calendar date string (ISO `YYYY-MM-DD`) in the given timezone.
 * Pure given `now`; falls back to the UTC date if the timezone is unusable.
 */
export function todayIsoInTimeZone(now: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return Number.isNaN(now.getTime()) ? "" : now.toISOString().slice(0, 10);
  }
}

/**
 * Derives the local calendar date ("YYYY-MM-DD") for an instant in a given timezone.
 */
export function deriveLocalDate(
  referenceInstant: Date | string,
  timeZone: string,
): string {
  const date =
    typeof referenceInstant === "string"
      ? new Date(referenceInstant)
      : referenceInstant;
  return todayIsoInTimeZone(date, timeZone);
}

/**
 * Server-derived, provider-neutral temporal context block for AiRequest (CORE-03B1).
 * Carries an explicit reference instant and business timezone so models can resolve
 * relative dates deterministically.
 */
export const aiTemporalContextSchema = z
  .object({
    /** Validated UTC ISO timestamp representing the canonical turn clock instant. */
    referenceInstant: z.iso.datetime(),
    /** Validated IANA timezone (e.g. 'Africa/Cairo', 'Asia/Riyadh', or 'UTC'). */
    timeZone: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .refine(isValidTimeZone, { message: "منطقة زمنية غير صالحة" }),
    /** Business-local calendar date 'YYYY-MM-DD' derived from referenceInstant and timeZone. */
    localDate: isoDateSchema,
  })
  .refine(
    (ctx) => {
      try {
        const date = new Date(ctx.referenceInstant);
        if (Number.isNaN(date.getTime())) return false;
        const derived = todayIsoInTimeZone(date, ctx.timeZone);
        return ctx.localDate === derived;
      } catch {
        return false;
      }
    },
    { message: "تاريخ محلي غير متطابق مع اللحظة المرجعية والمنطقة الزمنية" },
  );

export type AiTemporalContext = z.infer<typeof aiTemporalContextSchema>;

/**
 * Builds the canonical temporal context for an inbound turn from the server clock.
 */
export function buildAiTemporalContext(
  now: Date,
  businessTimeZone?: string | null,
): AiTemporalContext {
  const timeZone = resolveValidTimeZone(businessTimeZone);
  const referenceInstant = now.toISOString();
  const localDate = todayIsoInTimeZone(now, timeZone);
  return {
    referenceInstant,
    timeZone,
    localDate,
  };
}

/**
 * Add positive or negative days to an ISO YYYY-MM-DD date. Pure and UTC-anchored.
 */
export function addDaysToIso(iso: string, days: number): string {
  const ms = Date.parse(`${iso}T00:00:00.000Z`) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Number of days between iso1 and iso2 (iso2 - iso1). Pure and UTC-anchored.
 */
export function daysBetweenIso(iso1: string, iso2: string): number {
  const ms1 = Date.parse(`${iso1}T00:00:00.000Z`);
  const ms2 = Date.parse(`${iso2}T00:00:00.000Z`);
  return Math.round((ms2 - ms1) / 86_400_000);
}

/**
 * The Saturday starting the Sat–Fri business week containing isoDate.
 * 1970-01-03 (epoch day 2) was a Saturday.
 */
export function startOfSaturdayWeek(isoDate: string): string {
  const daysSinceEpoch = Math.floor(
    Date.parse(`${isoDate}T00:00:00.000Z`) / 86_400_000,
  );
  const offset = (((daysSinceEpoch - 2) % 7) + 7) % 7; // 0 = Saturday
  return addDaysToIso(isoDate, -offset);
}

/**
 * The Friday ending the Sat–Fri business week containing isoDate.
 */
export function endOfSaturdayWeek(isoDate: string): string {
  const sat = startOfSaturdayWeek(isoDate);
  return addDaysToIso(sat, 6);
}

/**
 * Determines whether a given 4-digit year is a leap year in the Gregorian calendar.
 */
export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Returns the maximum number of days in a given Gregorian month (1..12).
 */
export function daysInMonth(month: number, year: number): number {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  if ([4, 6, 9, 11].includes(month)) {
    return 30;
  }
  return 31;
}

/**
 * Validates whether day/month/year components form a real calendar date.
 */
export function isValidCalendarComponents(
  day: number,
  month: number,
  year: number,
): boolean {
  if (month < 1 || month > 12) return false;
  const maxDays = daysInMonth(month, year);
  return day >= 1 && day <= maxDays;
}

function formatIsoDate(year: number, month: number, day: number): string {
  const m = String(month).padStart(2, "0");
  const d = String(day).padStart(2, "0");
  return `${year}-${m}-${d}`;
}

export type ServerTemporalInput =
  | { type: "exact_date"; date: string }
  | { type: "relative_day"; offsetDays: number }
  | { type: "calendar_week"; weekOffset: number }
  | { type: "date_range"; startDate: string; endDate: string }
  | {
      type: "unresolved_date";
      day?: number;
      month?: number;
      year?: number;
      rawText?: string;
    }
  | {
      type: "invalid_date";
      day?: number;
      month?: number;
      year?: number;
      reason?: string;
      rawText?: string;
    };

export type ResolvedServerTemporal =
  | {
      kind: "single_date";
      date: string;
      source: "exact_date" | "relative_day" | "legacy_date" | "unresolved_date";
    }
  | {
      kind: "date_range";
      startDate: string;
      endDate: string;
      source: "calendar_week" | "date_range";
      weekOffset?: number;
    }
  | {
      kind: "range_too_broad";
      requestedDays: number;
      maxDays: number;
      startDate: string;
      endDate: string;
    }
  | {
      kind: "invalid";
      reason:
        | "CONTRADICTION"
        | "PAST_DATE"
        | "OUT_OF_BOUNDS"
        | "INVALID_ORDER"
        | "INVALID_FORMAT"
        | "IMPOSSIBLE_DATE";
      error: string;
    }
  | {
      kind: "ambiguous";
      reason:
        | "MISSING_MONTH"
        | "MISSING_YEAR"
        | "MISSING_DAY"
        | "AMBIGUOUS_RANGE_MONTH";
      field: "month" | "year" | "day";
      day?: number;
      month?: number;
      year?: number;
      message: string;
    }
  | {
      kind: "none";
    };

export type PriorTemporalContext = {
  date?: string | null;
  dateRange?: { startDate: string; endDate: string } | null;
  offerDate?: string | null;
  unresolvedDate?: {
    day?: number;
    month?: number;
    year?: number;
  } | null;
};

/**
 * Server-authoritative resolution of a model-proposed temporal request against
 * the trusted turn clock and business timezone.
 *
 * Enforces:
 * - Real calendar dates (ISO YYYY-MM-DD).
 * - Temporal bounds (not in past, max 60-day booking horizon).
 * - Range scan ceiling (maximum 14 days per search; flags range_too_broad if larger).
 * - Precedence: valid temporalRequest takes semantic precedence; legacy date acts as fallback.
 * - Safe fail-closed rejection on contradiction between legacy date and temporalRequest.
 */
export function resolveServerTemporalRequest(
  temporalRequest: ServerTemporalInput | null | undefined,
  legacyDate: string | null | undefined,
  referenceInstant: Date | string,
  timeZoneInput?: string | null,
  maxBookingHorizonDays = 60,
  priorContext?: PriorTemporalContext | null,
): ResolvedServerTemporal {
  const timeZone = resolveValidTimeZone(timeZoneInput);
  const todayIso = deriveLocalDate(referenceInstant, timeZone);

  const cleanLegacyDate =
    typeof legacyDate === "string" && legacyDate.trim().length > 0
      ? legacyDate.trim()
      : null;

  if (temporalRequest) {
    if (temporalRequest.type === "exact_date") {
      const date = temporalRequest.date.trim();
      if (!isValidIsoCalendarDate(date)) {
        return {
          kind: "invalid",
          reason: "INVALID_FORMAT",
          error: "صيغة التاريخ غير صالحة",
        };
      }
      if (date < todayIso) {
        return {
          kind: "invalid",
          reason: "PAST_DATE",
          error: "التاريخ المطلوب في الماضي",
        };
      }
      if (daysBetweenIso(todayIso, date) > maxBookingHorizonDays) {
        return {
          kind: "invalid",
          reason: "OUT_OF_BOUNDS",
          error: "التاريخ يتجاوز أفق الحجز المتاح",
        };
      }
      if (cleanLegacyDate !== null && cleanLegacyDate !== date) {
        return {
          kind: "invalid",
          reason: "CONTRADICTION",
          error: "تعارض بين التاريخ المحدد والطلب الزمني",
        };
      }
      return { kind: "single_date", date, source: "exact_date" };
    }

    if (temporalRequest.type === "relative_day") {
      const offset = temporalRequest.offsetDays;
      if (offset < 0) {
        return {
          kind: "invalid",
          reason: "PAST_DATE",
          error: "الإزاحة النسبية تشير إلى تاريخ ماضٍ",
        };
      }
      const targetDate = addDaysToIso(todayIso, offset);
      if (!isValidIsoCalendarDate(targetDate)) {
        return {
          kind: "invalid",
          reason: "INVALID_FORMAT",
          error: "التاريخ المحسوب غير صالح",
        };
      }
      if (daysBetweenIso(todayIso, targetDate) > maxBookingHorizonDays) {
        return {
          kind: "invalid",
          reason: "OUT_OF_BOUNDS",
          error: "التاريخ النسبي يتجاوز أفق الحجز المتاح",
        };
      }
      if (cleanLegacyDate !== null && cleanLegacyDate !== targetDate) {
        return {
          kind: "invalid",
          reason: "CONTRADICTION",
          error: "تعارض بين التاريخ واليوم النسبي",
        };
      }
      return { kind: "single_date", date: targetDate, source: "relative_day" };
    }

    if (temporalRequest.type === "calendar_week") {
      const weekOffset = temporalRequest.weekOffset;
      if (weekOffset < 0) {
        return {
          kind: "invalid",
          reason: "PAST_DATE",
          error: "الأسبوع المطلوب في الماضي",
        };
      }
      const weekStartSat = addDaysToIso(
        startOfSaturdayWeek(todayIso),
        weekOffset * 7,
      );
      const weekEndFri = addDaysToIso(weekStartSat, 6);

      if (
        !isValidIsoCalendarDate(weekStartSat) ||
        !isValidIsoCalendarDate(weekEndFri)
      ) {
        return {
          kind: "invalid",
          reason: "INVALID_FORMAT",
          error: "تواريخ الأسبوع المحسوب غير صالحة",
        };
      }
      if (weekEndFri < todayIso) {
        return {
          kind: "invalid",
          reason: "PAST_DATE",
          error: "الأسبوع المطلوب قد انتهى بالكامل",
        };
      }
      if (daysBetweenIso(todayIso, weekEndFri) > maxBookingHorizonDays) {
        return {
          kind: "invalid",
          reason: "OUT_OF_BOUNDS",
          error: "الأسبوع المطلوب يتجاوز أفق الحجز المتاح",
        };
      }
      if (
        cleanLegacyDate !== null &&
        (cleanLegacyDate < weekStartSat || cleanLegacyDate > weekEndFri)
      ) {
        return {
          kind: "invalid",
          reason: "CONTRADICTION",
          error: "تعارض: التاريخ المحدد يقع خارج الأسبوع المطلوب",
        };
      }
      return {
        kind: "date_range",
        startDate: weekStartSat,
        endDate: weekEndFri,
        source: "calendar_week",
        weekOffset,
      };
    }

    if (temporalRequest.type === "date_range") {
      const { startDate, endDate } = temporalRequest;
      if (
        !isValidIsoCalendarDate(startDate) ||
        !isValidIsoCalendarDate(endDate)
      ) {
        return {
          kind: "invalid",
          reason: "INVALID_FORMAT",
          error: "صيغة التواريخ في الفترة غير صالحة",
        };
      }
      if (startDate > endDate) {
        return {
          kind: "invalid",
          reason: "INVALID_ORDER",
          error: "تاريخ بداية الفترة يجب أن يكون قبل أو يطابق تاريخ النهاية",
        };
      }
      if (endDate < todayIso) {
        return {
          kind: "invalid",
          reason: "PAST_DATE",
          error: "الفترة المطلوبة قد انتهت بالكامل",
        };
      }
      const spanDays = daysBetweenIso(startDate, endDate) + 1;
      if (spanDays > 14) {
        return {
          kind: "range_too_broad",
          requestedDays: spanDays,
          maxDays: 14,
          startDate,
          endDate,
        };
      }
      if (daysBetweenIso(todayIso, endDate) > maxBookingHorizonDays) {
        return {
          kind: "invalid",
          reason: "OUT_OF_BOUNDS",
          error: "الفترة المطلوبة تتجاوز أفق الحجز المتاح",
        };
      }
      if (
        cleanLegacyDate !== null &&
        (cleanLegacyDate < startDate || cleanLegacyDate > endDate)
      ) {
        return {
          kind: "invalid",
          reason: "CONTRADICTION",
          error: "تعارض: التاريخ المحدد يقع خارج الفترة المطلوبة",
        };
      }
      return {
        kind: "date_range",
        startDate,
        endDate,
        source: "date_range",
      };
    }

    if (temporalRequest.type === "invalid_date") {
      return {
        kind: "invalid",
        reason: "IMPOSSIBLE_DATE",
        error:
          temporalRequest.reason ??
          "التاريخ المطلوب غير صالح في التقويم، يرجى اختيار تاريخ صحيح.",
      };
    }

    if (temporalRequest.type === "unresolved_date") {
      const rawDay = temporalRequest.day;
      const rawMonth = temporalRequest.month;
      const rawYear = temporalRequest.year;

      const day = rawDay ?? priorContext?.unresolvedDate?.day;
      let month = rawMonth ?? priorContext?.unresolvedDate?.month;
      let year = rawYear;
      if (
        year === undefined &&
        priorContext?.unresolvedDate?.year !== undefined
      ) {
        year = priorContext.unresolvedDate.year;
      }

      if (day === undefined) {
        return {
          kind: "ambiguous",
          reason: "MISSING_DAY",
          field: "day",
          month,
          year,
          message: "يرجى تحديد اليوم المطلوب للحجز.",
        };
      }

      if (day < 1 || day > 31) {
        return {
          kind: "invalid",
          reason: "IMPOSSIBLE_DATE",
          error: "اليوم المطلوب غير صحيح في التقويم.",
        };
      }

      // If month is omitted, attempt resolution via authoritative prior context
      if (month === undefined) {
        let resolvedMonthFromContext: number | null = null;
        let resolvedYearFromContext: number | null = null;

        if (priorContext?.date && isValidIsoCalendarDate(priorContext.date)) {
          const [py, pm] = priorContext.date.split("-").map(Number);
          resolvedYearFromContext = py!;
          resolvedMonthFromContext = pm!;
        } else if (
          priorContext?.offerDate &&
          isValidIsoCalendarDate(priorContext.offerDate)
        ) {
          const [py, pm] = priorContext.offerDate.split("-").map(Number);
          resolvedYearFromContext = py!;
          resolvedMonthFromContext = pm!;
        } else if (
          priorContext?.dateRange &&
          isValidIsoCalendarDate(priorContext.dateRange.startDate) &&
          isValidIsoCalendarDate(priorContext.dateRange.endDate) &&
          priorContext.dateRange.startDate <= priorContext.dateRange.endDate
        ) {
          const { startDate, endDate } = priorContext.dateRange;
          const [startYear, startMonth] = startDate
            .split("-")
            .map(Number) as [number, number];
          const [endYear, endMonth] = endDate
            .split("-")
            .map(Number) as [number, number];

          const matchingCandidates: {
            year: number;
            month: number;
            iso: string;
          }[] = [];

          for (let y = startYear; y <= endYear; y++) {
            const mStart = y === startYear ? startMonth : 1;
            const mEnd = y === endYear ? endMonth : 12;
            for (let m = mStart; m <= mEnd; m++) {
              if (year !== undefined && y !== year) continue;
              if (!isValidCalendarComponents(day, m, y)) continue;
              const candIso = formatIsoDate(y, m, day);
              if (
                candIso >= startDate &&
                candIso <= endDate &&
                candIso >= todayIso &&
                daysBetweenIso(todayIso, candIso) <= maxBookingHorizonDays
              ) {
                matchingCandidates.push({ year: y, month: m, iso: candIso });
              }
            }
          }

          if (matchingCandidates.length === 1) {
            resolvedYearFromContext = matchingCandidates[0]!.year;
            resolvedMonthFromContext = matchingCandidates[0]!.month;
          } else if (matchingCandidates.length > 1) {
            return {
              kind: "ambiguous",
              reason: "AMBIGUOUS_RANGE_MONTH",
              field: "month",
              day,
              year,
              message:
                `يرجى توضيح الشهر المطلوب ليوم ${day} ضمن الفترة المحددة.`,
            };
          }
        }

        if (resolvedMonthFromContext !== null) {
          month = resolvedMonthFromContext;
          if (year === undefined && resolvedYearFromContext !== null) {
            year = resolvedYearFromContext;
          }
        } else {
          return {
            kind: "ambiguous",
            reason: "MISSING_MONTH",
            field: "month",
            day,
            year,
            message:
              `يرجى توضيح الشهر المطلوب ليوم ${day} (مثال: ${day} نوفمبر).`,
          };
        }
      }

      if (month < 1 || month > 12) {
        return {
          kind: "invalid",
          reason: "IMPOSSIBLE_DATE",
          error: "الشهر المطلوب غير صالح في التقويم.",
        };
      }
      if (month === 2 && day > 29) {
        return {
          kind: "invalid",
          reason: "IMPOSSIBLE_DATE",
          error: "شهر فبراير لا يتجاوز 29 يوماً في أي سنة تقويمية.",
        };
      }
      if ([4, 6, 9, 11].includes(month) && day > 30) {
        return {
          kind: "invalid",
          reason: "IMPOSSIBLE_DATE",
          error: "هذا الشهر يضم 30 يوماً فقط.",
        };
      }

      const [currentYear] = todayIso.split("-").map(Number) as [number];
      let resolvedCandidateIso: string | null = null;

      if (year !== undefined) {
        if (!isValidCalendarComponents(day, month, year)) {
          let error =
            "التاريخ المطلوب غير موجود في التقويم، يرجى اختيار تاريخ صحيح.";
          if (month === 2 && day === 29 && !isLeapYear(year)) {
            error =
              `شهر فبراير في عام ${year} يضم 28 يوماً فقط (سنة غير كبيسة).`;
          }
          return {
            kind: "invalid",
            reason: "IMPOSSIBLE_DATE",
            error,
          };
        }
        const candIso = formatIsoDate(year, month, day);
        if (candIso < todayIso) {
          return {
            kind: "invalid",
            reason: "PAST_DATE",
            error: "التاريخ المطلوب في الماضي",
          };
        }
        if (daysBetweenIso(todayIso, candIso) > maxBookingHorizonDays) {
          return {
            kind: "invalid",
            reason: "OUT_OF_BOUNDS",
            error: "التاريخ يتجاوز أفق الحجز المتاح",
          };
        }
        resolvedCandidateIso = candIso;
      } else {
        const cand1Valid = isValidCalendarComponents(day, month, currentYear);
        const candIso1 = cand1Valid
          ? formatIsoDate(currentYear, month, day)
          : null;

        const cand2Valid = isValidCalendarComponents(
          day,
          month,
          currentYear + 1,
        );
        const candIso2 = cand2Valid
          ? formatIsoDate(currentYear + 1, month, day)
          : null;

        if (candIso1 !== null && candIso1 >= todayIso) {
          if (daysBetweenIso(todayIso, candIso1) <= maxBookingHorizonDays) {
            resolvedCandidateIso = candIso1;
          } else {
            return {
              kind: "invalid",
              reason: "OUT_OF_BOUNDS",
              error: "التاريخ يتجاوز أفق الحجز المتاح",
            };
          }
        } else if (candIso2 !== null && candIso2 >= todayIso) {
          if (daysBetweenIso(todayIso, candIso2) <= maxBookingHorizonDays) {
            resolvedCandidateIso = candIso2;
          } else {
            return {
              kind: "invalid",
              reason: "OUT_OF_BOUNDS",
              error: "التاريخ يتجاوز أفق الحجز المتاح",
            };
          }
        } else {
          if (month === 2 && day === 29) {
            if (
              isLeapYear(currentYear) &&
              candIso1 !== null &&
              candIso1 < todayIso
            ) {
              return {
                kind: "invalid",
                reason: "PAST_DATE",
                error: "تاريخ 29 فبراير لهذا العام قد مضى.",
              };
            }
            if (isLeapYear(currentYear + 1) && candIso2 !== null) {
              return {
                kind: "invalid",
                reason: "OUT_OF_BOUNDS",
                error: "تاريخ 29 فبراير القادم يتجاوز أفق الحجز المتاح.",
              };
            }
            return {
              kind: "invalid",
              reason: "IMPOSSIBLE_DATE",
              error:
                `شهر فبراير في عام ${currentYear} يضم 28 يوماً فقط، ` +
                "والعام القادم سنة غير كبيسة.",
            };
          }

          if (candIso1 !== null && candIso1 < todayIso) {
            return {
              kind: "invalid",
              reason: "PAST_DATE",
              error: "التاريخ المطلوب في الماضي",
            };
          }
          return {
            kind: "invalid",
            reason: "OUT_OF_BOUNDS",
            error: "التاريخ يتجاوز أفق الحجز المتاح",
          };
        }
      }

      if (
        cleanLegacyDate !== null &&
        cleanLegacyDate !== resolvedCandidateIso
      ) {
        return {
          kind: "invalid",
          reason: "CONTRADICTION",
          error: "تعارض بين التاريخ المحدد والطلب الزمني",
        };
      }

      return {
        kind: "single_date",
        date: resolvedCandidateIso,
        source: "unresolved_date",
      };
    }
  }

  // Fallback to legacy date when temporalRequest is absent
  if (cleanLegacyDate !== null) {
    if (!isValidIsoCalendarDate(cleanLegacyDate)) {
      return {
        kind: "invalid",
        reason: "INVALID_FORMAT",
        error: "صيغة التاريخ غير صالحة",
      };
    }
    if (cleanLegacyDate < todayIso) {
      return {
        kind: "invalid",
        reason: "PAST_DATE",
        error: "التاريخ المطلوب في الماضي",
      };
    }
    if (daysBetweenIso(todayIso, cleanLegacyDate) > maxBookingHorizonDays) {
      return {
        kind: "invalid",
        reason: "OUT_OF_BOUNDS",
        error: "التاريخ يتجاوز أفق الحجز المتاح",
      };
    }
    return {
      kind: "single_date",
      date: cleanLegacyDate,
      source: "legacy_date",
    };
  }

  return { kind: "none" };
}
