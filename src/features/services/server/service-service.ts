/**
 * Services management workflow.
 *
 * The service layer enforces the authorization rules that the route
 * layer relies on: only Business ADMIN users manage services, and
 * every read/write is scoped to the actor's own Business. The
 * repository collaborators are injectable so the workflow logic can be
 * verified without a live database (invitations-feature pattern).
 */

import {
  removeServiceSchema,
  serviceFormSchema,
  serviceIdentityKey,
  setServiceActiveSchema,
  updateServiceSchema,
} from "@/features/services/schemas/service-schema";
import type {
  ServiceActionResult,
  ServiceListItem,
} from "@/features/services/types";
import type { ServiceRepository } from "@/server/repositories";
import { serviceRepository } from "@/server/repositories";
import type { Service, UserRole } from "@/types/domain";

/** Authorization context derived from the authenticated session. */
export type ServiceActor = {
  userId: string;
  role: UserRole;
  businessId: string | null;
};

export type ServiceServiceDeps = {
  serviceRepository: Pick<
    ServiceRepository,
    | "listByBusiness"
    | "create"
    | "update"
    | "setActive"
    | "findById"
    | "softDelete"
  >;
};

/** Production dependencies (app singletons). */
export const defaultServiceServiceDeps: ServiceServiceDeps = {
  serviceRepository,
};

const FORBIDDEN_MESSAGE = "إدارة الخدمات متاحة للمدير فقط";
const NO_BUSINESS_MESSAGE = "أكمل إعداد المنشأة أولاً";
const NOT_FOUND_MESSAGE = "الخدمة غير موجودة";
const DUPLICATE_MESSAGE = "في خدمة بنفس الاسم موجودة بالفعل";
const REMOVE_FAILED_MESSAGE = "تعذر حذف الخدمة الآن";

function toListItem(service: Service): ServiceListItem {
  return {
    id: service.id,
    name: service.name,
    description: service.description ?? null,
    durationMinutes: service.durationMinutes,
    isActive: service.isActive,
  };
}

/** Resolve the actor's Business or a typed failure. */
function resolveBusiness(
  actor: ServiceActor,
): { ok: true; businessId: string } | { ok: false; message: string } {
  if (actor.role !== "ADMIN") return { ok: false, message: FORBIDDEN_MESSAGE };
  if (!actor.businessId) return { ok: false, message: NO_BUSINESS_MESSAGE };
  return { ok: true, businessId: actor.businessId };
}

/** Load a service and require it to belong to the actor's Business. */
async function findOwnedService(
  deps: ServiceServiceDeps,
  businessId: string,
  id: string,
): Promise<Service | null> {
  const service = await deps.serviceRepository.findById(id);
  if (!service || service.businessId !== businessId) return null;
  return service;
}

function invalidInput(message: string): ServiceActionResult {
  return { success: false, message };
}

/** List every service of the actor's Business, inactive ones included. */
export async function listServices(
  deps: ServiceServiceDeps,
  actor: ServiceActor,
): Promise<ServiceListItem[] | { message: string }> {
  const scope = resolveBusiness(actor);
  if (!scope.ok) return { message: scope.message };
  const services = await deps.serviceRepository.listByBusiness(
    scope.businessId,
    { includeInactive: true, rawPagination: { pageSize: 100 } },
  );
  return services.map(toListItem);
}

export async function createService(
  deps: ServiceServiceDeps,
  actor: ServiceActor,
  input: unknown,
): Promise<ServiceActionResult> {
  const scope = resolveBusiness(actor);
  if (!scope.ok) return { success: false, message: scope.message };

  const parsed = serviceFormSchema.safeParse(input);
  if (!parsed.success) {
    return invalidInput(
      parsed.error.issues[0]?.message ?? "بيانات الخدمة غير صالحة",
    );
  }

  // Duplicate-name guard (check-then-create): two same-named services
  // would make the deterministic booking matcher ambiguous, so the
  // conflict is rejected here rather than at the DB. Soft-deleted
  // (removed) names are free again — they are gone from the catalog.
  const existing = await deps.serviceRepository.listByBusiness(
    scope.businessId,
    { includeInactive: true, rawPagination: { pageSize: 100 } },
  );
  const key = serviceIdentityKey(parsed.data.name);
  if (existing.some((service) => serviceIdentityKey(service.name) === key)) {
    return { success: false, message: DUPLICATE_MESSAGE };
  }

  try {
    const service = await deps.serviceRepository.create({
      businessId: scope.businessId,
      name: parsed.data.name,
      description: parsed.data.description || undefined,
      durationMinutes: parsed.data.durationMinutes,
    });
    return { success: true, service: toListItem(service) };
  } catch {
    return { success: false, message: "تعذر حفظ الخدمة الآن" };
  }
}

export async function updateService(
  deps: ServiceServiceDeps,
  actor: ServiceActor,
  input: unknown,
): Promise<ServiceActionResult> {
  const scope = resolveBusiness(actor);
  if (!scope.ok) return { success: false, message: scope.message };

  const parsed = updateServiceSchema.safeParse(input);
  if (!parsed.success) {
    return invalidInput(
      parsed.error.issues[0]?.message ?? "بيانات الخدمة غير صالحة",
    );
  }

  const existing = await findOwnedService(
    deps,
    scope.businessId,
    parsed.data.id,
  );
  if (!existing) return { success: false, message: NOT_FOUND_MESSAGE };

  // Renaming onto ANOTHER live service's name is the same conflict a
  // duplicate create would create (the row always keeps its own name).
  const key = serviceIdentityKey(parsed.data.service.name);
  if (serviceIdentityKey(existing.name) !== key) {
    const catalog = await deps.serviceRepository.listByBusiness(
      scope.businessId,
      { includeInactive: true, rawPagination: { pageSize: 100 } },
    );
    if (
      catalog.some(
        (service) =>
          service.id !== parsed.data.id &&
          serviceIdentityKey(service.name) === key,
      )
    ) {
      return { success: false, message: DUPLICATE_MESSAGE };
    }
  }

  try {
    const service = await deps.serviceRepository.update(parsed.data.id, {
      name: parsed.data.service.name,
      description: parsed.data.service.description || "",
      durationMinutes: parsed.data.service.durationMinutes,
    });
    return { success: true, service: toListItem(service) };
  } catch {
    return { success: false, message: "تعذر حفظ الخدمة الآن" };
  }
}

export async function setServiceActive(
  deps: ServiceServiceDeps,
  actor: ServiceActor,
  input: unknown,
): Promise<ServiceActionResult> {
  const scope = resolveBusiness(actor);
  if (!scope.ok) return { success: false, message: scope.message };

  const parsed = setServiceActiveSchema.safeParse(input);
  if (!parsed.success) {
    return invalidInput(parsed.error.issues[0]?.message ?? "الإجراء غير صالح");
  }

  const existing = await findOwnedService(
    deps,
    scope.businessId,
    parsed.data.id,
  );
  if (!existing) return { success: false, message: NOT_FOUND_MESSAGE };

  try {
    const service = await deps.serviceRepository.setActive(
      parsed.data.id,
      parsed.data.isActive,
    );
    return { success: true, service: toListItem(service) };
  } catch {
    return { success: false, message: "تعذر تحديث حالة الخدمة الآن" };
  }
}

/**
 * Remove a service.
 *
 * Removal is a SOFT DELETE (`deletedAt`), never a hard row delete:
 * `Appointment.service` is `onDelete: Restrict`, so a booked service
 * row is the integrity anchor of every past appointment (its name and
 * duration stay readable on history). Soft-deleting also keeps the
 * operational contract the booking engine relies on — the row stops
 * being catalog/bookable (`isActive: false` + `deletedAt` set, both
 * honored by the repository's catalog reads) without orphaning history.
 *
 * An owner who needs the service bookable again re-creates it; the
 * duplicate guard keeps removed names free for that.
 */
export async function removeService(
  deps: ServiceServiceDeps,
  actor: ServiceActor,
  input: unknown,
): Promise<ServiceActionResult> {
  const scope = resolveBusiness(actor);
  if (!scope.ok) return { success: false, message: scope.message };

  const parsed = removeServiceSchema.safeParse(input);
  if (!parsed.success) {
    return invalidInput(parsed.error.issues[0]?.message ?? "الإجراء غير صالح");
  }

  const existing = await findOwnedService(
    deps,
    scope.businessId,
    parsed.data.id,
  );
  if (!existing) return { success: false, message: NOT_FOUND_MESSAGE };

  try {
    const service = await deps.serviceRepository.softDelete(parsed.data.id);
    return { success: true, service: toListItem(service) };
  } catch {
    return { success: false, message: REMOVE_FAILED_MESSAGE };
  }
}
