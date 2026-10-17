"use server";

import {
  defaultProviderEligibilityServiceDeps,
  resolveEligibleProviders,
  type ProviderEligibilityActor,
} from "@/features/appointments/server/provider-eligibility-service";
import type { ProviderEligibilityResult } from "@/features/appointments/types";
import { requireUser } from "@/server/auth/guards";
import { userRepository } from "@/server/repositories";

/**
 * Provider eligibility read action (PROMPT-CORE-01) — the integration
 * hook for the Conversation layer and the Any-Provider flow (CORE-02).
 * Thin wrapper only: the actor's Business is ALWAYS derived
 * server-side from the persisted user (a client-provided businessId
 * can never override it), and all rules live in the eligibility
 * resolver.
 */
export async function resolveEligibleProvidersAction(
  input: unknown,
): Promise<ProviderEligibilityResult> {
  const session = await requireUser();
  const user = await userRepository.findById(session.user.id);
  // No user record (deleted mid-session) → least privilege: no
  // Business can never read eligibility.
  const actor: ProviderEligibilityActor = {
    businessId: user?.businessId ?? null,
  };
  return resolveEligibleProviders(
    defaultProviderEligibilityServiceDeps,
    actor,
    input,
  );
}

/**
 * List active team members of the business available for provider profile setup.
 * ADMIN-only action.
 */
export async function listAssignableUsersAction(): Promise<
  | { success: true; users: Array<{ id: string; name: string; email: string }> }
  | { success: false; message: string }
> {
  const session = await requireUser();
  if (session.user.role !== "ADMIN") {
    return { success: false, message: "إعداد مقدمي الخدمة متاح للمدير فقط" };
  }
  if (!session.user.businessId) {
    return { success: false, message: "أكمل إعداد المنشأة أولاً" };
  }
  const users = await userRepository.listByBusiness(
    { businessId: session.user.businessId },
    { pageSize: 100 },
  );
  return {
    success: true,
    users: users
      .filter((u) => u.isActive)
      .map((u) => ({ id: u.id, name: u.name, email: u.email })),
  };
}

/**
 * Just-in-Time Provider Setup action: connects an existing team member as a
 * provider and associates them with the specified service.
 * ADMIN-only action.
 */
export async function setupServiceProviderAction(input: {
  userId: string;
  displayName?: string;
  serviceId: string;
}): Promise<
  { success: true; providerId: string } | { success: false; message: string }
> {
  const session = await requireUser();
  if (session.user.role !== "ADMIN") {
    return { success: false, message: "إعداد مقدمي الخدمة متاح للمدير فقط" };
  }
  if (!session.user.businessId) {
    return { success: false, message: "أكمل إعداد المنشأة أولاً" };
  }
  const businessId = session.user.businessId;

  // Validate user belongs to the same business
  const user = await userRepository.findById(input.userId);
  if (!user || user.businessId !== businessId || !user.isActive) {
    return { success: false, message: "الموظف غير موجود أو غير نشط" };
  }

  // Validate service belongs to the same business
  const { serviceRepository, branchRepository } =
    await import("@/server/repositories");
  const service = await serviceRepository.findById(input.serviceId);
  if (!service || service.businessId !== businessId || !service.isActive) {
    return { success: false, message: "الخدمة غير موجودة أو غير نشطة" };
  }

  // Find existing profile or create one
  const { providerRepository } = await import("@/server/repositories");
  let profile = await providerRepository.findProfileByUser(user.id);
  if (!profile) {
    profile = await providerRepository.createProfile(businessId, {
      userId: user.id,
      displayName: input.displayName?.trim() || user.name,
    });
  }
  if (!profile) {
    return { success: false, message: "تعذر إنشاء مِلف مقدم الخدمة" };
  }

  // Link to service
  const serviceLink = await providerRepository.addServiceEligibility(
    businessId,
    profile.id,
    service.id,
  );
  if (!serviceLink.ok && serviceLink.code !== "ALREADY_LINKED") {
    return { success: false, message: "تعذر ربط مقدم الخدمة بالخدمة" };
  }

  // Link to default branch if exists
  const defaultBranch =
    await branchRepository.findDefaultByBusiness(businessId);
  if (defaultBranch) {
    await providerRepository.addBranchEligibility(
      businessId,
      profile.id,
      defaultBranch.id,
    );
  }

  return { success: true, providerId: profile.id };
}
