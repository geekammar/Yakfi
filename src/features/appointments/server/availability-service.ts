/**
 * Deterministic availability calculation (PROMPT-10).
 *
 * Answers: "For this Business, on this date, for this active Service,
 * which start times are actually bookable?"
 *
 * Rules (all deterministic — no `Date.now()` in the calculation path):
 *
 * 1. Business resolution: the actor's own Business (ADMIN or STAFF —
 *    both roles may read availability; writes stay guarded
 *    elsewhere). A client-provided businessId never overrides it.
 * 2. Working hours: the existing `Business.workingHours` JSON week
 *    (single open/close interval per weekday). Closed day → zero
 *    slots with `BUSINESS_CLOSED`.
 * 3. Service validation: only active, non-deleted services produce
 *    availability — same rule the Create Appointment write path
 *    enforces. Cross-Business service ids resolve to not-found.
 * 4. Slot generation: candidates step from `open` by the Business's
 *    canonical `slotDurationMinutes` (set in onboarding step 3) —
 *    the existing slot-granularity setting is REUSED, nothing new.
 *    A candidate is valid only when its FULL service duration fits
 *    before `close` (a 45-min service never starts 17:30 in a
 *    10:00–18:00 day).
 * 5. Conflicts: a slot must not overlap any blocking appointment
 *    (same business, same date, not soft-deleted, PENDING/CONFIRMED —
 *    the exact rule `AppointmentRepository.hasConflict` /
 *    `createWithConflictCheck` enforce for writes). Reads go through
 *    `listBlockingForDate`; repositories remain the only Prisma
 *    consumers.
 * 6. Timezone: times are business-local wall-clock "HH:mm" (the
 *    stored `@db.Time` semantics); the weekday is derived from the
 *    calendar date itself, which is timezone-independent. The
 *    Business's stored timezone travels in the result for display.
 *
 * Repository collaborators are injectable (defaulting to the app
 * singletons) so the workflow logic can be verified without a live
 * database — the established invitations/services pattern.
 */

import { getAvailabilityInputSchema } from "@/features/appointments/schemas/availability-schema";
import type {
  AvailabilityNoSlotsReason,
  AvailabilityResult,
  AvailabilitySlot,
} from "@/features/appointments/types";
import type {
  AppointmentRepository,
  BusinessRepository,
  ServiceRepository,
} from "@/server/repositories";
import {
  appointmentRepository,
  businessRepository,
  serviceRepository,
} from "@/server/repositories";
import type { Business, UserRole } from "@/types/domain";

/** Authorization context derived from the authenticated session. */
export type AvailabilityActor = {
  userId: string;
  role: UserRole;
  businessId: string | null;
};

export type AvailabilityServiceDeps = {
  businessRepository: Pick<BusinessRepository, "findById">;
  serviceRepository: Pick<ServiceRepository, "findById">;
  appointmentRepository: Pick<
    AppointmentRepository,
    "findById" | "listBlockingForDate"
  >;
};

/** Production dependencies (app singletons). */
export const defaultAvailabilityServiceDeps: AvailabilityServiceDeps = {
  businessRepository,
  serviceRepository,
  appointmentRepository,
};

/** English weekday keys, in `workingHours` JSON order. */
const WEEK_DAYS = ["sat", "sun", "mon", "tue", "wed", "thu", "fri"] as const;

type WeekDay = (typeof WEEK_DAYS)[number];

const NO_BUSINESS_MESSAGE = "أكمل إعداد المنشأة أولاً";
const SERVICE_NOT_FOUND_MESSAGE = "الخدمة غير موجودة";
const SERVICE_INACTIVE_MESSAGE = "الخدمة غير متاحة للحجز";

/** "HH:mm" → minutes since midnight. */
function toMinutes(time: string): number {
  const [hours = 0, minutes = 0] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

/** Minutes since midnight → "HH:mm". */
function toWallClock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * Weekday key for a calendar date. A "YYYY-MM-DD" string maps to one
 * exact weekday — timezone-independent by construction, so the
 * Business timezone never changes which working-hours entry applies.
 * Exported for CORE-02 (the same business-weekday logic, never
 * duplicated).
 */
export function weekdayOf(date: string): WeekDay {
  // 1970-01-03 (epoch day 2) was a Saturday.
  const daysSinceEpoch = Math.floor(
    Date.parse(`${date}T00:00:00.000Z`) / 86_400_000,
  );
  return WEEK_DAYS[(daysSinceEpoch - 2 + 7) % 7] ?? "sat";
}

/**
 * Working-hours entry for the requested weekday. Returns null when the
 * business is closed that day or has no working-hours data yet (an
 * onboarded business always has the full week persisted; a missing
 * week is treated as closed, never as 24h availability). Exported for
 * CORE-02 (the same business-hours logic, never duplicated).
 */
export function resolveWorkingDay(
  business: Business,
  weekday: WeekDay,
): { openMinutes: number; closeMinutes: number } | null {
  const raw = business.workingHours as unknown;
  if (!raw || typeof raw !== "object") return null;
  const entry = (raw as Record<string, unknown>)[weekday];
  if (!entry || typeof entry !== "object") return null;
  const { open, close, closed } = entry as {
    open?: unknown;
    close?: unknown;
    closed?: unknown;
  };
  if (closed !== false) return null;
  if (typeof open !== "string" || typeof close !== "string") return null;
  const openMinutes = toMinutes(open);
  const closeMinutes = toMinutes(close);
  if (closeMinutes <= openMinutes) return null;
  return { openMinutes, closeMinutes };
}

/**
 * Generate candidate slots inside the working interval. A candidate is
 * valid only when its complete duration fits before closing.
 */
export function generateCandidateSlots(params: {
  openMinutes: number;
  closeMinutes: number;
  durationMinutes: number;
  slotDurationMinutes: number;
}): AvailabilitySlot[] {
  const { openMinutes, closeMinutes, durationMinutes } = params;
  // The step is the Business's canonical slot granularity; never zero
  // (schema floor is 5, but a defensive guard keeps the loop finite).
  const step = Math.max(1, params.slotDurationMinutes);
  const slots: AvailabilitySlot[] = [];
  for (
    let start = openMinutes;
    start + durationMinutes <= closeMinutes;
    start += step
  ) {
    slots.push({
      startTime: toWallClock(start),
      endTime: toWallClock(start + durationMinutes),
    });
  }
  return slots;
}

/** True when [slotStart, slotEnd) overlaps [blockStart, blockEnd). */
function overlaps(
  slotStart: number,
  slotEnd: number,
  blockStart: number,
  blockEnd: number,
): boolean {
  return slotStart < blockEnd && blockStart < slotEnd;
}

/** Filter slots against blocking appointment intervals ("HH:mm" pairs). */
export function filterConflictingSlots(
  slots: AvailabilitySlot[],
  blocking: ReadonlyArray<{ startTime: string; endTime: string }>,
): AvailabilitySlot[] {
  if (blocking.length === 0) return slots;
  const blocks = blocking
    .map((block) => ({
      start: toMinutes(block.startTime),
      end: toMinutes(block.endTime),
    }))
    .sort((a, b) => a.start - b.start);
  return slots.filter((slot) => {
    const start = toMinutes(slot.startTime);
    const end = toMinutes(slot.endTime);
    return !blocks.some((block) =>
      overlaps(start, end, block.start, block.end),
    );
  });
}

/**
 * Compute deterministic availability for the actor's Business, one
 * date, one service.
 */
export async function getAvailability(
  deps: AvailabilityServiceDeps,
  actor: AvailabilityActor,
  input: unknown,
): Promise<AvailabilityResult> {
  const parsed = getAvailabilityInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: {
        code: "INVALID_INPUT",
        message: parsed.error.issues[0]?.message ?? "بيانات الطلب غير صالحة",
      },
    };
  }

  if (!actor.businessId) {
    return {
      success: false,
      error: { code: "NO_BUSINESS", message: NO_BUSINESS_MESSAGE },
    };
  }

  const [business, service] = await Promise.all([
    deps.businessRepository.findById(actor.businessId),
    deps.serviceRepository.findById(parsed.data.serviceId),
  ]);
  if (!business) {
    return {
      success: false,
      error: { code: "NO_BUSINESS", message: NO_BUSINESS_MESSAGE },
    };
  }
  // Tenant boundary: another Business's service is indistinguishable
  // from an unknown id — availability never leaks cross-tenant data.
  if (!service || service.businessId !== business.id) {
    return {
      success: false,
      error: {
        code: "SERVICE_NOT_FOUND",
        message: SERVICE_NOT_FOUND_MESSAGE,
      },
    };
  }
  if (!service.isActive) {
    return {
      success: false,
      error: { code: "SERVICE_INACTIVE", message: SERVICE_INACTIVE_MESSAGE },
    };
  }

  // B-08 — self-exclusion tenancy: a client-supplied
  // `excludeAppointmentId` is NEVER trusted as authorization. Only an
  // appointment of THIS Business, not soft-deleted and still active
  // (PENDING/CONFIRMED) may be excluded from its own conflict set;
  // anything else (foreign tenant, deleted, already-finished) is
  // "unauthorized" and widens nothing. The id is a row identity, not a
  // scope hint — `businessId` stays the actor's own throughout.
  const excludeAppointmentId = parsed.data.excludeAppointmentId ?? undefined;
  if (excludeAppointmentId) {
    const target =
      await deps.appointmentRepository.findById(excludeAppointmentId);
    // Same rule the create path enforces for customer/service scope.
    if (!target || target.businessId !== business.id) {
      return {
        success: false,
        error: {
          code: "FORBIDDEN",
          message: "لا يمكن الوصول إلى الموعد",
        },
      };
    }
    if (target.status !== "PENDING" && target.status !== "CONFIRMED") {
      return {
        success: false,
        error: {
          code: "APPOINTMENT_NOT_ACTIVE",
          message: "لا يمكن إعادة جدولة موعد منتهٍ",
        },
      };
    }
  }

  const workingDay = resolveWorkingDay(business, weekdayOf(parsed.data.date));
  if (!workingDay) {
    return {
      success: true,
      data: {
        date: parsed.data.date,
        timezone: business.timezone,
        serviceId: service.id,
        serviceDurationMinutes: service.durationMinutes,
        slots: [],
      },
      reason: "BUSINESS_CLOSED",
    };
  }

  const candidates = generateCandidateSlots({
    openMinutes: workingDay.openMinutes,
    closeMinutes: workingDay.closeMinutes,
    durationMinutes: service.durationMinutes,
    slotDurationMinutes: business.slotDurationMinutes,
  });
  if (candidates.length === 0) {
    // Open, but the service duration never fits inside the interval.
    return {
      success: true,
      data: {
        date: parsed.data.date,
        timezone: business.timezone,
        serviceId: service.id,
        serviceDurationMinutes: service.durationMinutes,
        slots: [],
      },
      reason: "SERVICE_TOO_LONG",
    };
  }

  const blocking = await deps.appointmentRepository.listBlockingForDate(
    business.id,
    parsed.data.date,
    // B-08 — self-exclusion for an availability-guided reschedule. The
    // appointment being rescheduled is re-resolved against the actor's
    // OWN Business first (below): only a same-Business, active
    // appointment's id reaches here, so it can never widen another
    // tenant's availability. A foreign / missing / inactive id is
    // treated as unauthorized and excluded from nothing.
    excludeAppointmentId ?? undefined,
  );
  const slots = filterConflictingSlots(candidates, blocking);

  const reason: AvailabilityNoSlotsReason | null =
    slots.length > 0 ? null : "FULLY_BOOKED";

  return {
    success: true,
    data: {
      date: parsed.data.date,
      timezone: business.timezone,
      serviceId: service.id,
      serviceDurationMinutes: service.durationMinutes,
      slots,
    },
    reason,
  };
}
