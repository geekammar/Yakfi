/**
 * Deterministic Any-Provider Booking Options Resolver
 * (PROMPT-CORE-02).
 *
 * Answers: "Among the eligible Providers, what are the best useful
 * appointment options available to the customer?" — the second step of
 * the any-provider flow (DECISIONS #32): requested Service → CORE-01
 * eligible Providers → availability → deterministic ranking → a small
 * option set → the customer chooses.
 *
 * Rules:
 *
 * 1. Eligibility is CORE-01's: this resolver CONSUMES
 *    `resolveEligibleProviders` (relation-driven ProviderService /
 *    ProviderBranch eligibility within the server-resolved Business
 *    scope) and never re-resolves eligibility. Its typed errors
 *    (INVALID_INPUT / NO_BUSINESS / SERVICE_NOT_FOUND /
 *    SERVICE_INACTIVE / BRANCH_NOT_FOUND) pass through unchanged.
 * 2. Provider preference: an absent `providerId` is the Any-Provider
 *    preference (`preference: "ANY"`). A present one is verified
 *    against the CORE-01 eligible set — a Provider that is not
 *    eligible (including one from another Business) is
 *    `PROVIDER_NOT_ELIGIBLE` (no cross-tenant existence leak).
 * 3. Availability uses the EXISTING deterministic Availability layer —
 *    the same business-hours logic, slot model, and conflict rule
 *    (`resolveWorkingDay` / `weekdayOf` / `generateCandidateSlots` /
 *    `filterConflictingSlots`), never a second engine. Conflicts are
 *    provider-scoped exactly like the booking write path
 *    (`hasConflict` / `createWithConflictCheck`): a Provider's
 *    calendar is blocked only by its own PENDING/CONFIRMED
 *    appointments (`listBlockingByAssignees` — the read counterpart of
 *    the existing `assignedUserId` scoping).
 * 4. Ranking is deterministic (nearest useful appointment): each
 *    Provider's earliest available slot ranks first (start time
 *    ascending, then the stable CORE-01 Provider order); when fewer
 *    than `MAX_BOOKING_OPTIONS` distinct options exist, later slots
 *    backfill in global time order. No ML, no LLM, no learned
 *    recommendation. Provider creation order is only a tie-breaker,
 *    never a quality ranking.
 * 5. The result is a small set (normally 2–3, `MAX_BOOKING_OPTIONS`)
 *    of compact options — never the full availability list, never raw
 *    Prisma records, never credentials/auth fields.
 * 6. READ-ONLY: no Appointment write, no reservation, no hold, no
 *    message, no LLM, no WhatsApp. The concurrency guarantee belongs
 *    to the booking write boundary (existing SERIALIZABLE
 *    transactions), not here.
 *
 * Repository collaborators are injectable (defaulting to the app
 * singletons and the CORE-01 defaults) so the workflow logic can be
 * verified without a live database — the established
 * availability/eligibility pattern.
 */

import { resolveBookingOptionsInputSchema } from "@/features/appointments/schemas/booking-options-schema";
import {
  filterConflictingSlots,
  generateCandidateSlots,
  resolveWorkingDay,
  weekdayOf,
} from "@/features/appointments/server/availability-service";
import {
  defaultProviderEligibilityServiceDeps,
  resolveEligibleProviders,
  type ProviderEligibilityServiceDeps,
} from "@/features/appointments/server/provider-eligibility-service";
import type {
  BookingOption,
  BookingOptionsData,
  BookingOptionsNoOptionsReason,
  BookingOptionsResult,
} from "@/features/appointments/types";
import { MAX_BOOKING_OPTIONS } from "@/features/appointments/types";
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

/**
 * Server-resolved authorization context. The Business is the tenant
 * boundary and comes ONLY from server-side resolution — never from a
 * client payload. Role/accountType are deliberately absent: options
 * resolution is read-only and identity never influences availability.
 */
export type BookingOptionsActor = {
  userId: string;
  businessId: string | null;
};

export type BookingOptionsServiceDeps = {
  /** CORE-01 — the eligibility source of truth. */
  eligibility: ProviderEligibilityServiceDeps;
  businessRepository: Pick<BusinessRepository, "findById">;
  serviceRepository: Pick<ServiceRepository, "findById">;
  providerRepository: Pick<ProviderRepository, "listAssignmentSeams">;
  appointmentRepository: Pick<AppointmentRepository, "listBlockingByAssignees">;
};

/** Production dependencies (app singletons + CORE-01 defaults). */
export const defaultBookingOptionsServiceDeps: BookingOptionsServiceDeps = {
  eligibility: defaultProviderEligibilityServiceDeps,
  businessRepository,
  serviceRepository,
  providerRepository,
  appointmentRepository,
};

const NO_BUSINESS_MESSAGE = "أكمل إعداد المنشأة أولاً";
const SERVICE_NOT_FOUND_MESSAGE = "الخدمة غير موجودة";
const SERVICE_INACTIVE_MESSAGE = "الخدمة غير متاحة للحجز";
const PROVIDER_NOT_ELIGIBLE_MESSAGE = "هذا المزود غير متاح لهذه الخدمة";

/**
 * One available (Provider, slot) pair before ranking. `providerOrder`
 * is the Provider's index in the CORE-01 eligible set (stable creation
 * order, then id) — the deterministic tie-breaker, never a quality
 * rank. `startTime`/`endTime` are the existing business-local
 * "HH:mm" wall-clock slots (zero-padded, so string comparison is
 * chronological).
 */
export type RankedBookingPair = {
  providerOrder: number;
  providerId: string;
  displayName: string;
  startTime: string;
  endTime: string;
};

/**
 * Deterministic ranking (PROMPT-CORE-02): nearest useful appointment.
 * Phase 1 picks each Provider's earliest available slot and ranks
 * those globally (start time ascending, then the stable CORE-01
 * Provider order) — diverse Providers win ties. Phase 2 backfills
 * from the remaining pairs in global time order when fewer than
 * `max` options exist (e.g. one eligible Provider → its 2–3 nearest
 * slots). Pure so the policy is verifiable without a database.
 */
export function rankBookingOptions(
  pairs: RankedBookingPair[],
  max: number,
): RankedBookingPair[] {
  const earlier = (a: RankedBookingPair, b: RankedBookingPair): number =>
    a.startTime < b.startTime
      ? -1
      : a.startTime > b.startTime
        ? 1
        : a.providerOrder - b.providerOrder;
  const sorted = [...pairs].sort(earlier);
  const earliestByProvider = new Map<number, RankedBookingPair>();
  for (const pair of sorted) {
    if (!earliestByProvider.has(pair.providerOrder)) {
      earliestByProvider.set(pair.providerOrder, pair);
    }
  }
  const picked = [...earliestByProvider.values()].sort(earlier).slice(0, max);
  if (picked.length < max) {
    const chosen = new Set(
      picked.map((p) => `${p.providerOrder}:${p.startTime}`),
    );
    for (const pair of sorted) {
      if (picked.length >= max) break;
      const key = `${pair.providerOrder}:${pair.startTime}`;
      if (!chosen.has(key)) {
        picked.push(pair);
        chosen.add(key);
      }
    }
  }
  return picked;
}

/**
 * Resolve the best useful booking options for one Service among the
 * CORE-01 eligible Providers, deterministically.
 */
export async function resolveBookingOptions(
  deps: BookingOptionsServiceDeps,
  actor: BookingOptionsActor,
  input: unknown,
): Promise<BookingOptionsResult> {
  const parsed = resolveBookingOptionsInputSchema.safeParse(input);
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

  const { serviceId, branchId, providerId, date } = parsed.data;
  const preference: BookingOptionsData["preference"] = providerId
    ? "PROVIDER"
    : "ANY";

  // CORE-01 — the eligibility source of truth (never re-resolved).
  const eligibility = await resolveEligibleProviders(
    deps.eligibility,
    { businessId: actor.businessId },
    { serviceId, ...(branchId ? { branchId } : {}) },
  );
  if (!eligibility.success) return eligibility;

  const [business, service] = await Promise.all([
    deps.businessRepository.findById(actor.businessId),
    deps.serviceRepository.findById(serviceId),
  ]);
  if (!business) {
    return {
      success: false,
      error: { code: "NO_BUSINESS", message: NO_BUSINESS_MESSAGE },
    };
  }
  // Tenant boundary: another Business's service is indistinguishable
  // from an unknown id — options never leak cross-tenant data.
  if (!service || service.businessId !== actor.businessId) {
    return {
      success: false,
      error: { code: "SERVICE_NOT_FOUND", message: SERVICE_NOT_FOUND_MESSAGE },
    };
  }
  if (!service.isActive) {
    return {
      success: false,
      error: { code: "SERVICE_INACTIVE", message: SERVICE_INACTIVE_MESSAGE },
    };
  }

  const eligible = eligibility.data.providers;
  const toEmpty = (
    reason: BookingOptionsNoOptionsReason,
  ): BookingOptionsResult => ({
    success: true,
    data: {
      serviceId,
      branchId: branchId ?? null,
      date,
      timezone: business.timezone,
      preference,
      options: [],
    },
    reason,
  });

  if (eligible.length === 0) {
    if (providerId) {
      return {
        success: false,
        error: {
          code: "PROVIDER_NOT_ELIGIBLE",
          message: PROVIDER_NOT_ELIGIBLE_MESSAGE,
        },
      };
    }
    return toEmpty("NO_ELIGIBLE_PROVIDERS");
  }

  const scoped = providerId
    ? eligible.filter((provider) => provider.providerId === providerId)
    : eligible;
  if (providerId && scoped.length === 0) {
    return {
      success: false,
      error: {
        code: "PROVIDER_NOT_ELIGIBLE",
        message: PROVIDER_NOT_ELIGIBLE_MESSAGE,
      },
    };
  }

  // The assignment seam (ProviderProfile.id → userId) for the scoped
  // Providers — ONE batched Business-scoped projection. A Provider
  // whose profile has no resolvable seam is skipped (no availability
  // can be computed for it).
  const seams = await deps.providerRepository.listAssignmentSeams(
    actor.businessId,
    scoped.map((provider) => provider.providerId),
  );
  const seamByProvider = new Map(
    seams.map((seam) => [seam.providerId, seam.userId]),
  );

  const workingDay = resolveWorkingDay(business, weekdayOf(date));
  if (!workingDay) return toEmpty("BUSINESS_CLOSED");

  const candidates = generateCandidateSlots({
    openMinutes: workingDay.openMinutes,
    closeMinutes: workingDay.closeMinutes,
    durationMinutes: service.durationMinutes,
    slotDurationMinutes: business.slotDurationMinutes,
  });
  if (candidates.length === 0) return toEmpty("SERVICE_TOO_LONG");

  // ONE batched provider-scoped conflict read — the read counterpart
  // of the booking write path's assignee scoping. Grouped by assignee
  // in application memory (no N+1).
  const assigneeIds = [
    ...new Set(
      scoped.map((p) => seamByProvider.get(p.providerId) || p.providerId),
    ),
  ];
  const blockingRows = await deps.appointmentRepository.listBlockingByAssignees(
    actor.businessId,
    date,
    assigneeIds,
  );
  const blockingByAssignee = new Map<
    string,
    Array<{ startTime: string; endTime: string }>
  >();
  for (const row of blockingRows) {
    const blocks = blockingByAssignee.get(row.assignedUserId) ?? [];
    blocks.push({ startTime: row.startTime, endTime: row.endTime });
    blockingByAssignee.set(row.assignedUserId, blocks);
  }

  const pairs: RankedBookingPair[] = [];
  scoped.forEach((provider, providerOrder) => {
    const assigneeId =
      seamByProvider.get(provider.providerId) || provider.providerId;
    if (!assigneeId) return;
    const available = filterConflictingSlots(
      candidates,
      blockingByAssignee.get(assigneeId) ?? [],
    );
    for (const slot of available) {
      pairs.push({
        providerOrder,
        providerId: provider.providerId,
        displayName: provider.displayName,
        startTime: slot.startTime,
        endTime: slot.endTime,
      });
    }
  });

  const ranked = rankBookingOptions(pairs, MAX_BOOKING_OPTIONS);
  const options: BookingOption[] = ranked.map((pair) => ({
    providerId: pair.providerId,
    displayName: pair.displayName,
    startAt: `${date}T${pair.startTime}`,
    endAt: `${date}T${pair.endTime}`,
  }));

  return {
    success: true,
    data: {
      serviceId,
      branchId: branchId ?? null,
      date,
      timezone: business.timezone,
      preference,
      options,
    },
    reason: options.length > 0 ? null : "FULLY_BOOKED",
  };
}
