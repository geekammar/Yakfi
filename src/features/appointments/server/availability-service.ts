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
import {
  generateCandidateSlots,
  resolveWorkingHoursForWeekday,
  toMinutes,
  weekdayOfDate,
} from "@/lib/scheduling/slot-grid";
import type { Weekday } from "@/lib/scheduling/slot-grid";
import type {
  AppointmentRepository,
  BusinessRepository,
  ProviderRepository,
  ServiceRepository,
} from "@/server/repositories";
import {
  appointmentRepository,
  businessRepository,
  providerRepository,
  serviceRepository,
} from "@/server/repositories";
import type { Business, UserRole } from "@/types/domain";

/**
 * The slot-grid rule is OWNED by `@/lib/scheduling/slot-grid` (the one
 * canonical derivation) and re-exported here so the authority's existing
 * consumers keep their imports. `weekdayOf` is the date → weekday key
 * the working-hours week is indexed by; `generateCandidateSlots` is the
 * pre-conflict candidate grid. The client presentational grid imports
 * the SAME module — never a second engine.
 */
export {
  generateCandidateSlots,
  weekdayOfDate as weekdayOf,
} from "@/lib/scheduling/slot-grid";

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
  > &
    Partial<Pick<AppointmentRepository, "listBlockingByAssignees">>;
  providerRepository?: Pick<
    ProviderRepository,
    "listEligibleForService" | "listAssignmentSeams"
  >;
};

/** Production dependencies (app singletons). */
export const defaultAvailabilityServiceDeps: AvailabilityServiceDeps = {
  businessRepository,
  serviceRepository,
  appointmentRepository,
  providerRepository,
};

const NO_BUSINESS_MESSAGE = "أكمل إعداد المنشأة أولاً";
const SERVICE_NOT_FOUND_MESSAGE = "الخدمة غير موجودة";
const SERVICE_INACTIVE_MESSAGE = "الخدمة غير متاحة للحجز";

/**
 * Working-hours entry for a weekday, resolved from the stored
 * `Business.workingHours` JSON week through the ONE shared grid module
 * (kept exported for CORE-02 — the same business-hours logic, never
 * duplicated).
 */
export function resolveWorkingDay(
  business: Business,
  weekday: Weekday,
): { openMinutes: number; closeMinutes: number } | null {
  return resolveWorkingHoursForWeekday(business.workingHours, weekday);
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

  const workingDay = resolveWorkingDay(
    business,
    weekdayOfDate(parsed.data.date),
  );
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

  const { date, providerId } = parsed.data;

  // Provider-scoped availability if providerId is requested
  if (providerId) {
    if (!deps.providerRepository) {
      return {
        success: false,
        error: {
          code: "PROVIDER_NOT_ELIGIBLE",
          message: "هذا المزود غير متاح لهذه الخدمة",
        },
      };
    }
    const eligible = await deps.providerRepository.listEligibleForService(
      business.id,
      service.id,
    );
    const matched = eligible.find((p) => p.id === providerId);
    if (!matched) {
      return {
        success: false,
        error: {
          code: "PROVIDER_NOT_ELIGIBLE",
          message: "هذا المزود غير متاح لهذه الخدمة",
        },
      };
    }
    const seams = await deps.providerRepository.listAssignmentSeams(
      business.id,
      [providerId],
    );
    const seam = seams.find((s) => s.providerId === providerId);
    const assigneeId = seam?.userId || providerId;
    let blocking: Array<{ startTime: string; endTime: string }> = [];
    if (deps.appointmentRepository.listBlockingByAssignees) {
      const assigneeRows =
        await deps.appointmentRepository.listBlockingByAssignees(
          business.id,
          date,
          [assigneeId],
          excludeAppointmentId ?? undefined,
        );
      blocking = assigneeRows.map((r) => ({
        startTime: r.startTime,
        endTime: r.endTime,
      }));
    } else {
      blocking = await deps.appointmentRepository.listBlockingForDate(
        business.id,
        date,
        excludeAppointmentId ?? undefined,
      );
    }
    const filteredSlots = filterConflictingSlots(candidates, blocking);
    const slots: AvailabilitySlot[] = filteredSlots.map((slot) => ({
      ...slot,
      availableProviderIds: [providerId],
    }));
    const reason: AvailabilityNoSlotsReason | null =
      slots.length > 0 ? null : "FULLY_BOOKED";

    return {
      success: true,
      data: {
        date,
        timezone: business.timezone,
        serviceId: service.id,
        serviceDurationMinutes: service.durationMinutes,
        slots,
      },
      reason,
    };
  }

  // Unified PROVIDER_AWARE_BOOKING availability
  if (
    deps.providerRepository &&
    deps.appointmentRepository.listBlockingByAssignees
  ) {
    const eligible = await deps.providerRepository.listEligibleForService(
      business.id,
      service.id,
    );
    if (eligible.length === 0) {
      return {
        success: true,
        data: {
          date,
          timezone: business.timezone,
          serviceId: service.id,
          serviceDurationMinutes: service.durationMinutes,
          slots: [],
        },
        reason: "NO_ELIGIBLE_PROVIDERS",
      };
    }
    const seams = await deps.providerRepository.listAssignmentSeams(
      business.id,
      eligible.map((p) => p.id),
    );
    const seamMap = new Map(seams.map((s) => [s.providerId, s.userId]));
    const seamUserIds = [
      ...new Set(
        eligible.map((p) => seamMap.get(p.id) || p.id).filter(Boolean),
      ),
    ];
    if (seamUserIds.length === 0) {
      return {
        success: true,
        data: {
          date,
          timezone: business.timezone,
          serviceId: service.id,
          serviceDurationMinutes: service.durationMinutes,
          slots: [],
        },
        reason: "NO_ELIGIBLE_PROVIDERS",
      };
    }

    const blockingRows =
      await deps.appointmentRepository.listBlockingByAssignees(
        business.id,
        date,
        seamUserIds,
        excludeAppointmentId ?? undefined,
      );
    const blockingByAssignee = new Map<
      string,
      Array<{ startTime: string; endTime: string }>
    >();
    for (const row of blockingRows) {
      const list = blockingByAssignee.get(row.assignedUserId) ?? [];
      list.push({ startTime: row.startTime, endTime: row.endTime });
      blockingByAssignee.set(row.assignedUserId, list);
    }

    // Map assigneeId back to providerId(s)
    const providerIdByAssigneeId = new Map<string, string[]>();
    for (const p of eligible) {
      const assigneeId = seamMap.get(p.id) || p.id;
      const list = providerIdByAssigneeId.get(assigneeId) ?? [];
      list.push(p.id);
      providerIdByAssigneeId.set(assigneeId, list);
    }

    const slots: AvailabilitySlot[] = [];
    for (const candidate of candidates) {
      const candidateSlot = [candidate];
      const availableProviderIds: string[] = [];
      for (const assigneeId of seamUserIds) {
        const blocks = blockingByAssignee.get(assigneeId) ?? [];
        if (filterConflictingSlots(candidateSlot, blocks).length > 0) {
          const pIds = providerIdByAssigneeId.get(assigneeId) ?? [];
          availableProviderIds.push(...pIds);
        }
      }
      if (availableProviderIds.length > 0) {
        slots.push({
          startTime: candidate.startTime,
          endTime: candidate.endTime,
          availableProviderIds: [...new Set(availableProviderIds)],
        });
      }
    }
    const reason: AvailabilityNoSlotsReason | null =
      slots.length > 0 ? null : "FULLY_BOOKED";
    return {
      success: true,
      data: {
        date,
        timezone: business.timezone,
        serviceId: service.id,
        serviceDurationMinutes: service.durationMinutes,
        slots,
      },
      reason,
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
