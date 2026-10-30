/**
 * Team management workflow (PROMPT-16).
 *
 * The service layer enforces the authorization rules the route layer
 * relies on: only Business ADMIN users manage the team, every read and
 * write is scoped to the actor's own Business, and only STAFF members
 * may be deactivated/reactivated (an ADMIN can never lock themselves
 * or another ADMIN out — DECISIONS #02 two-role model, no membership
 * state machine). The repository collaborators are injectable
 * (established invitations/services/customers pattern) so the
 * workflow logic can be verified without a live database.
 */

import {
  createProviderSchema,
  setTeamMemberActiveSchema,
  toggleProviderActiveSchema,
  updateProviderSchema,
} from "@/features/staff/schemas/team-schema";
import type {
  ProviderItem,
  ProviderListResult,
  ProviderMutationResult,
  SetTeamMemberActiveResult,
  TeamListResult,
  TeamMemberItem,
} from "@/features/staff/types";
import type {
  BranchRepository,
  ProviderRepository,
  ServiceRepository,
  UserRepository,
} from "@/server/repositories";
import {
  branchRepository,
  providerRepository,
  serviceRepository,
  userRepository,
} from "@/server/repositories";
import type { ProviderWithDetails } from "@/server/repositories/provider.repository";
import type { UserRole } from "@/types/domain";

/** Authorization context derived from the authenticated session. */
export type TeamActor = {
  userId: string;
  role: UserRole;
  businessId: string | null;
};

export type TeamServiceDeps = {
  users: Pick<UserRepository, "listByBusiness" | "findById" | "setActive">;
  providers?: Pick<
    ProviderRepository,
    | "listWithDetailsByBusiness"
    | "findProfileWithinBusiness"
    | "createProfile"
    | "updateProfile"
    | "setServiceExclusions"
    | "setBranchEligibility"
  >;
  branches?: Pick<BranchRepository, "listByBusiness">;
  services?: Pick<ServiceRepository, "listByBusiness">;
};

/** Production dependencies (app singletons). */
export const defaultTeamServiceDeps: TeamServiceDeps = {
  users: userRepository,
  providers: providerRepository,
  branches: branchRepository,
  services: serviceRepository,
};

const FORBIDDEN_MESSAGE = "إدارة الفريق متاحة للمدير فقط";
const NO_BUSINESS_MESSAGE = "أكمل إعداد المنشأة أولاً";
const NOT_FOUND_MESSAGE = "العضو غير موجود";
const ADMIN_TARGET_MESSAGE = "يمكن تعطيل حسابات الموظفين وتنشيطها فقط";
const UPDATE_FAILED_MESSAGE = "تعذر تحديث حالة العضو الآن";
const LIST_FAILED_MESSAGE = "تعذر تحميل الفريق الآن";

/** Team size cap for one directory read (pilot scale — same as services). */
const TEAM_PAGE_SIZE = 100;

function toMemberItem(user: {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  isActive: boolean;
}): TeamMemberItem {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    isActive: user.isActive,
  };
}

/** Resolve the actor's management scope or a typed failure. */
function resolveScope(
  actor: TeamActor,
): { ok: true; businessId: string } | { ok: false; message: string } {
  if (actor.role !== "ADMIN") return { ok: false, message: FORBIDDEN_MESSAGE };
  if (!actor.businessId) return { ok: false, message: NO_BUSINESS_MESSAGE };
  return { ok: true, businessId: actor.businessId };
}

/** List the members of the actor's Business — ADMIN-only read. */
export async function listTeam(
  deps: TeamServiceDeps,
  actor: TeamActor,
): Promise<TeamListResult> {
  const scope = resolveScope(actor);
  if (!scope.ok) return { success: false, message: scope.message };

  try {
    const users = await deps.users.listByBusiness(
      { businessId: scope.businessId },
      { pageSize: TEAM_PAGE_SIZE },
    );
    return { success: true, members: users.map(toMemberItem) };
  } catch {
    return { success: false, message: LIST_FAILED_MESSAGE };
  }
}

/**
 * Deactivate/reactivate a STAFF member of the actor's Business.
 * Server-side guarantees:
 * - Only ADMIN may change member states (STAFF actors get a typed
 *   failure — UI hiding is not the authorization mechanism).
 * - The target must belong to the actor's own Business (a cross-tenant
 *   id fails safely as not-found).
 * - The target must be STAFF — ADMIN members (including the actor
 *   themselves) can never be deactivated through this path, so no
 *   ADMIN can accidentally lock the Business out.
 */
export async function setTeamMemberActive(
  deps: TeamServiceDeps,
  actor: TeamActor,
  input: unknown,
): Promise<SetTeamMemberActiveResult> {
  const scope = resolveScope(actor);
  if (!scope.ok) {
    return {
      success: false,
      code: actor.role !== "ADMIN" ? "FORBIDDEN" : "NO_BUSINESS",
      message: scope.message,
    };
  }

  const parsed = setTeamMemberActiveSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      code: "VALIDATION",
      message: parsed.error.issues[0]?.message ?? "الإجراء غير صالح",
    };
  }

  const target = await deps.users.findById(parsed.data.memberId);
  // Not found OR another Business's member: one safe not-found answer.
  if (!target || target.businessId !== scope.businessId) {
    return { success: false, code: "NOT_FOUND", message: NOT_FOUND_MESSAGE };
  }
  if (target.role !== "STAFF") {
    return {
      success: false,
      code: "ADMIN_TARGET",
      message: ADMIN_TARGET_MESSAGE,
    };
  }

  try {
    const updated = await deps.users.setActive(
      parsed.data.memberId,
      parsed.data.isActive,
    );
    return { success: true, member: toMemberItem(updated) };
  } catch {
    return {
      success: false,
      code: "UPDATE_FAILED",
      message: UPDATE_FAILED_MESSAGE,
    };
  }
}

function toProviderItem(p: ProviderWithDetails): ProviderItem {
  return {
    id: p.id,
    name: p.name || p.displayName || p.user?.name || "مقدم خدمة",
    displayName: p.displayName,
    servicePolicy: p.servicePolicy as "ALL_SERVICES" | "SPECIFIC_SERVICES",
    isActive: p.isActive,
    userId: p.userId,
    user: p.user
      ? { id: p.user.id, name: p.user.name, email: p.user.email }
      : null,
    branchId: p.branches[0]?.branchId ?? null,
    branchName: p.branches[0]?.branch?.name ?? null,
    excludedServiceIds: p.exclusions.map((e) => e.serviceId),
    excludedServiceNames: p.exclusions.map((e) => e.service.name),
    includedServiceIds: p.services.map((s) => s.serviceId),
    includedServiceNames: p.services.map((s) => s.service.name),
  };
}

/** List all service providers for the actor's Business — ADMIN-only read. */
export async function listProviders(
  deps: TeamServiceDeps,
  actor: TeamActor,
): Promise<ProviderListResult> {
  const scope = resolveScope(actor);
  if (!scope.ok) return { success: false, message: scope.message };

  try {
    const providersRepo = deps.providers ?? providerRepository;
    const providers = await providersRepo.listWithDetailsByBusiness(
      scope.businessId,
    );
    return { success: true, providers: providers.map(toProviderItem) };
  } catch {
    return { success: false, message: "تعذر تحميل مقدمي الخدمة الآن" };
  }
}

/** Create a new service provider (independent or user-linked) — ADMIN-only. */
export async function createProvider(
  deps: TeamServiceDeps,
  actor: TeamActor,
  input: unknown,
): Promise<ProviderMutationResult> {
  const scope = resolveScope(actor);
  if (!scope.ok) return { success: false, message: scope.message };

  const parsed = createProviderSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      message:
        parsed.error.issues[0]?.message ?? "بيانات مقدم الخدمة غير صالحة",
    };
  }

  try {
    const providersRepo = deps.providers ?? providerRepository;
    const profile = await providersRepo.createProfile(scope.businessId, {
      name: parsed.data.name,
      displayName: parsed.data.displayName ?? undefined,
      userId: parsed.data.userId,
      servicePolicy: parsed.data.servicePolicy,
      isActive: parsed.data.isActive,
    });
    if (!profile) {
      return { success: false, message: "تعذر إنشاء مقدم الخدمة" };
    }

    if (parsed.data.excludedServiceIds) {
      await providersRepo.setServiceExclusions(
        scope.businessId,
        profile.id,
        parsed.data.excludedServiceIds,
      );
    }

    if (parsed.data.branchId) {
      await providersRepo.setBranchEligibility(
        scope.businessId,
        profile.id,
        parsed.data.branchId,
      );
    }

    const all = await providersRepo.listWithDetailsByBusiness(scope.businessId);
    const created = all.find((p) => p.id === profile.id);
    if (!created) {
      return { success: false, message: "تعذر تحميل مقدم الخدمة بعد إنشائه" };
    }

    return { success: true, provider: toProviderItem(created) };
  } catch {
    return { success: false, message: "تعذر إنشاء مقدم الخدمة الآن" };
  }
}

/** Update an existing service provider — ADMIN-only. */
export async function updateProvider(
  deps: TeamServiceDeps,
  actor: TeamActor,
  input: unknown,
): Promise<ProviderMutationResult> {
  const scope = resolveScope(actor);
  if (!scope.ok) return { success: false, message: scope.message };

  const parsed = updateProviderSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      message: parsed.error.issues[0]?.message ?? "بيانات التعديل غير صالحة",
    };
  }

  try {
    const providersRepo = deps.providers ?? providerRepository;
    const currentProfile = await providersRepo.findProfileWithinBusiness(
      parsed.data.providerId,
      scope.businessId,
    );
    if (!currentProfile) {
      return { success: false, message: "مقدم الخدمة غير موجود" };
    }

    const effectivePolicy =
      parsed.data.servicePolicy ??
      (currentProfile.servicePolicy as "ALL_SERVICES" | "SPECIFIC_SERVICES");

    const profile = await providersRepo.updateProfile(
      parsed.data.providerId,
      scope.businessId,
      {
        name: parsed.data.name,
        displayName: parsed.data.displayName,
        userId: parsed.data.userId,
        servicePolicy: parsed.data.servicePolicy,
        isActive: parsed.data.isActive,
      },
    );
    if (!profile) {
      return { success: false, message: "مقدم الخدمة غير موجود" };
    }

    // Only update exclusions when operating under ALL_SERVICES policy
    if (
      effectivePolicy === "ALL_SERVICES" &&
      parsed.data.excludedServiceIds !== undefined
    ) {
      await providersRepo.setServiceExclusions(
        scope.businessId,
        profile.id,
        parsed.data.excludedServiceIds,
      );
    }

    if (parsed.data.branchId !== undefined) {
      await providersRepo.setBranchEligibility(
        scope.businessId,
        profile.id,
        parsed.data.branchId,
      );
    }

    const all = await providersRepo.listWithDetailsByBusiness(scope.businessId);
    const updated = all.find((p) => p.id === profile.id);
    if (!updated) {
      return { success: false, message: "تعذر تحميل بيانات مقدم الخدمة" };
    }

    return { success: true, provider: toProviderItem(updated) };
  } catch {
    return { success: false, message: "تعذر تحديث بيانات مقدم الخدمة الآن" };
  }
}

/** Toggle active status for a service provider — ADMIN-only. */
export async function setProviderActive(
  deps: TeamServiceDeps,
  actor: TeamActor,
  input: unknown,
): Promise<ProviderMutationResult> {
  const scope = resolveScope(actor);
  if (!scope.ok) return { success: false, message: scope.message };

  const parsed = toggleProviderActiveSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      message: parsed.error.issues[0]?.message ?? "الطلب غير صالح",
    };
  }

  try {
    const providersRepo = deps.providers ?? providerRepository;
    const profile = await providersRepo.updateProfile(
      parsed.data.providerId,
      scope.businessId,
      { isActive: parsed.data.isActive },
    );
    if (!profile) {
      return { success: false, message: "مقدم الخدمة غير موجود" };
    }

    const all = await providersRepo.listWithDetailsByBusiness(scope.businessId);
    const updated = all.find((p) => p.id === profile.id);
    if (!updated) {
      return { success: false, message: "تعذر تحميل بيانات مقدم الخدمة" };
    }

    return { success: true, provider: toProviderItem(updated) };
  } catch {
    return { success: false, message: "تعذر تعديل حالة مقدم الخدمة الآن" };
  }
}
