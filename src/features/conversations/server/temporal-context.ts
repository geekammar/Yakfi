/**
 * Server-Derived Temporal Context & Timezone Utilities (CORE-03B1).
 *
 * Provides a provider-neutral, trusted temporal anchor for the current turn.
 * Ensures relative date interpretation in AI providers is anchored to the
 * business timezone and canonical turn clock instant.
 */

import { z } from "zod";

/**
 * Validates a "YYYY-MM-DD" calendar date.
 */
const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "التاريخ غير صالح")
  .refine(
    (value) =>
      !Number.isNaN(new Date(`${value}T00:00:00.000Z`).getTime()) &&
      new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value,
    { error: "التاريخ غير صالح" },
  );

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
