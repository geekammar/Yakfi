/**
 * Appointment creation workflow (PROMPT-14 — Smart Create Step 6).
 *
 * THE single appointment-creation engine: the exact rules the
 * `createAppointment` server action has enforced since v0.1.0, moved
 * into the feature's established service pattern (availability /
 * booking-flow) so the action stays a thin session wrapper while the
 * workflow logic stays verifiable without a live database. Nothing
 * about the write semantics changed:
 *
 * - Zod validation at the server boundary (`notes` required-but-
 *   emptyable, hostile keys stripped — a client can never supply
 *   `businessId`, `status`, or `assignedUserId`).
 * - The Business is ALWAYS the actor's own, derived from the
 *   authenticated session — tenant isolation means cross-business
 *   customer/service ids are indistinguishable from missing ones.
 * - Only active, non-deleted services are bookable.
 * - `endTime` is derived SERVER-side from the service's duration.
 * - The initial status is derived from `Business.confirmationMode`
 *   (PROMPT-09) — never client input.
 * - The transactional conflict check in
 *   `AppointmentRepository.createWithConflictCheck` is the final
 *   guard; a lost slot surfaces as the typed `SLOT_CONFLICT` failure.
 *
 * Repository collaborators are injectable (defaulting to the app
 * singletons) — the established invitations/services/availability
 * pattern.
 */

import { createAppointmentFormSchema } from "@/features/appointments/schemas/appointment-schema";
import type { CreateAppointmentActionResult } from "@/features/appointments/types";
import { nowTimeInTimeZone, todayInTimeZone } from "@/lib/scheduling/slot-grid";
import type {
  AppointmentRepository,
  BranchRepository,
  BusinessRepository,
  CustomerRepository,
  ProviderRepository,
  ServiceRepository,
} from "@/server/repositories";
import {
  appointmentRepository,
  branchRepository,
  businessRepository,
  customerRepository,
  providerRepository,
  serviceRepository,
} from "@/server/repositories";
import type { UserRole } from "@/types/domain";

/** Authorization context derived from the authenticated session. */
export type AppointmentCreateActor = {
  userId: string;
  role: UserRole;
  /**
   * The actor's OWN business — the only business an appointment is
   * ever created for. Client input can never supply or override it.
   */
  businessId: string | null;
};

export type AppointmentCreateServiceDeps = {
  customerRepository: Pick<CustomerRepository, "findById">;
  serviceRepository: Pick<ServiceRepository, "findById">;
  businessRepository: Pick<BusinessRepository, "findById">;
  branchRepository: Pick<BranchRepository, "findDefaultByBusiness">;
  appointmentRepository: Pick<
    AppointmentRepository,
    "createWithConflictCheck"
  > &
    Partial<Pick<AppointmentRepository, "hasConflict">>;
  providerRepository?: Pick<
    ProviderRepository,
    "listEligibleForService" | "listAssignmentSeams"
  >;
  now?: () => Date;
};

/** Production dependencies (app singletons). */
export const defaultAppointmentCreateServiceDeps: AppointmentCreateServiceDeps =
  {
    customerRepository,
    serviceRepository,
    businessRepository,
    branchRepository,
    appointmentRepository,
    providerRepository,
    now: () => new Date(),
  };

/**
 * Add minutes to a business-local "HH:mm" wall-clock time. Returns
 * null when the result would cross midnight (the service no longer
 * fits inside the day). Shared by the create workflow and the
 * reschedule action.
 */
export function addMinutes(time: string, minutes: number) {
  const [hours = 0, currentMinutes = 0] = time.split(":").map(Number);
  const total = hours * 60 + currentMinutes + minutes;
  if (total >= 24 * 60) return null;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Create an appointment for the actor's business. Composes the same
 * protected write the agenda path always used; typed failure codes
 * let the caller (Smart Create Step 6) react to domain failures —
 * `SLOT_CONFLICT` above all — without parsing message strings.
 */
export async function createAppointmentRecord(
  deps: AppointmentCreateServiceDeps,
  actor: AppointmentCreateActor,
  input: unknown,
): Promise<CreateAppointmentActionResult> {
  const parsed = createAppointmentFormSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      code: "VALIDATION",
      message: parsed.error.issues[0]?.message ?? "بيانات الموعد غير صالحة",
    };
  }
  if (!actor.businessId) {
    return {
      success: false,
      code: "NO_BUSINESS",
      message: "أكمل إعداد المنشأة أولاً",
    };
  }

  const [customer, service] = await Promise.all([
    deps.customerRepository.findById(parsed.data.customerId),
    deps.serviceRepository.findById(parsed.data.serviceId),
  ]);
  if (!customer || customer.businessId !== actor.businessId) {
    return {
      success: false,
      code: "CUSTOMER_NOT_FOUND",
      message: "العميل غير موجود",
    };
  }
  if (
    !service ||
    service.businessId !== actor.businessId ||
    !service.isActive
  ) {
    return {
      success: false,
      code: "SERVICE_UNAVAILABLE",
      message: "الخدمة غير متاحة",
    };
  }

  const endTime = addMinutes(parsed.data.startTime, service.durationMinutes);
  if (!endTime) {
    return {
      success: false,
      code: "END_OF_DAY",
      message: "الخدمة تتجاوز نهاية اليوم",
    };
  }

  // Booking confirmation mode (PROMPT-09): server-derived from the
  // Business record — never client input. "automatic" confirms new
  // appointments on creation; "manual" (default) keeps them PENDING.
  const [business, defaultBranch] = await Promise.all([
    deps.businessRepository.findById(actor.businessId),
    deps.branchRepository.findDefaultByBusiness(actor.businessId),
  ]);
  if (!business) {
    return {
      success: false,
      code: "NO_BUSINESS",
      message: "لا يمكن الوصول إلى المنشأة",
    };
  }
  // Branch-aware (DECISIONS #30, PROMPT-ARCH-02): the write is scoped to
  // the Business's Default Branch — resolved SERVER-side; a client can
  // never supply or choose a branch (single-Branch UX). A missing
  // Default Branch is impossible by construction (atomic creation +
  // ARCH-02 backfill); the generic create failure is the fail-safe.
  if (!defaultBranch) {
    return {
      success: false,
      code: "CREATE_FAILED",
      message: "تعذر إنشاء الموعد الآن",
    };
  }

  // Server-side past-date and same-day past-time validation using business timezone
  const now = deps.now ? deps.now() : new Date();
  const todayIso = todayInTimeZone(now, business.timezone);
  if (parsed.data.date < todayIso) {
    return {
      success: false,
      code: "PAST_TIME",
      message: "لا يمكن حجز موعد في تاريخ سابق",
    };
  }
  if (parsed.data.date === todayIso) {
    const currentTime = nowTimeInTimeZone(now, business.timezone);
    if (parsed.data.startTime < currentTime) {
      return {
        success: false,
        code: "PAST_TIME",
        message: "لا يمكن حجز موعد في وقت سابق",
      };
    }
  }

  // Resolve explicit provider selection server-side (never use actor.userId)
  let assignedUserId: string | null = null;
  let providerId: string | null = null;

  if (parsed.data.providerId) {
    if (!deps.providerRepository) {
      return {
        success: false,
        code: "CREATE_FAILED",
        message: "تعذر التحقق من المزود المحدد",
      };
    }
    const eligible = await deps.providerRepository.listEligibleForService(
      actor.businessId,
      service.id,
    );
    const matched = eligible.find((p) => p.id === parsed.data.providerId);
    if (!matched) {
      return {
        success: false,
        code: "PROVIDER_NOT_ELIGIBLE",
        message: "هذا المزود غير متاح لهذه الخدمة",
      };
    }
    providerId = matched.id;
    const seams = await deps.providerRepository.listAssignmentSeams(
      actor.businessId,
      [parsed.data.providerId],
    );
    const seam = seams.find((s) => s.providerId === parsed.data.providerId);
    if (seam?.userId) {
      assignedUserId = seam.userId;
    }
  } else if (deps.providerRepository) {
    const eligible = await deps.providerRepository.listEligibleForService(
      actor.businessId,
      service.id,
    );
    if (eligible.length === 0) {
      return {
        success: false,
        code: "NO_ELIGIBLE_PROVIDERS",
        message:
          "تحتاج هذه الخدمة إلى مقدم خدمة مؤهل واحد على الأقل قبل استقبال المواعيد",
      };
    }
    if (eligible.length === 1 && eligible[0]) {
      // Automatically selects the provider when exactly one is eligible
      providerId = eligible[0].id;
      const seams = await deps.providerRepository.listAssignmentSeams(
        actor.businessId,
        [eligible[0].id],
      );
      const seam = seams.find((s) => s.providerId === eligible[0]?.id);
      if (seam?.userId) {
        assignedUserId = seam.userId;
      }
    } else if (eligible.length > 1) {
      // Multiple eligible providers with no explicit preference: pick first available
      const seams = await deps.providerRepository.listAssignmentSeams(
        actor.businessId,
        eligible.map((p) => p.id),
      );
      const seamMap = new Map(seams.map((s) => [s.providerId, s.userId]));
      let pickedProviderId: string | null = null;
      let pickedAssigneeId: string | null = null;
      for (const p of eligible) {
        const seamUserId = seamMap.get(p.id);
        const isConflicted = deps.appointmentRepository.hasConflict
          ? await deps.appointmentRepository.hasConflict({
              businessId: actor.businessId,
              date: parsed.data.date,
              startTime: parsed.data.startTime,
              endTime,
              providerId: p.id,
              assignedUserId: seamUserId ?? null,
            })
          : false;
        if (!isConflicted) {
          pickedProviderId = p.id;
          pickedAssigneeId = seamUserId ?? null;
          break;
        }
      }
      if (!pickedProviderId) {
        return {
          success: false,
          code: "SLOT_CONFLICT",
          message: "الوقت المطلوب غير متاح حالياً",
        };
      }
      providerId = pickedProviderId;
      assignedUserId = pickedAssigneeId;
    }
  }

  const initialStatus =
    business.confirmationMode === "automatic" ? "CONFIRMED" : "PENDING";

  try {
    const appointment =
      await deps.appointmentRepository.createWithConflictCheck({
        businessId: actor.businessId,
        customerId: customer.id,
        serviceId: service.id,
        branchId: defaultBranch
          ? defaultBranch.id
          : (null as unknown as string),
        assignedUserId: assignedUserId ?? (null as unknown as string),
        providerId: providerId ?? (null as unknown as string),
        date: parsed.data.date,
        startTime: parsed.data.startTime,
        endTime,
        notes: parsed.data.notes || undefined,
        status: initialStatus,
      });
    if (!appointment) {
      return {
        success: false,
        code: "SLOT_CONFLICT",
        message: "يوجد موعد آخر متداخل في هذا الوقت",
      };
    }
    return {
      success: true,
      appointmentId: appointment.id,
      status: appointment.status,
    };
  } catch {
    return {
      success: false,
      code: "CREATE_FAILED",
      message: "تعذر إنشاء الموعد الآن",
    };
  }
}
