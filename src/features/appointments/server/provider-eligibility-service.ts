/**
 * Deterministic Provider / Service Eligibility Resolver
 * (PROMPT-CORE-01).
 *
 * Answers: "Which Providers are eligible for this requested Service
 * within the current Business / operational scope?"
 *
 * Rules (all relation-driven — persisted relations are the authority;
 * names, AI text, role labels, and client payloads are never sources
 * of eligibility):
 *
 * 1. Business resolution: the actor's own Business, derived
 *    SERVER-side (session + persisted user — the availability
 *    pattern). A client-provided businessId never overrides it, and
 *    the input schema strips identity keys by construction.
 * 2. Service validation: the Service must exist (not soft-deleted),
 *    belong to the SAME Business, and be active — a cross-Business
 *    service id is indistinguishable from an unknown one
 *    (`SERVICE_NOT_FOUND`); cross-tenant existence never leaks.
 * 3. Branch scope (optional): when the conversation/booking flow has
 *    a Branch, it must belong to the SAME Business
 *    (`BRANCH_NOT_FOUND` otherwise) — the existing Branch semantics
 *    (selective operational scoping) are reused unchanged.
 * 4. Eligibility: ONE repository query with all persisted relational
 *    constraints (`eligibleProvidersWhere`) — Provider active +
 *    Business-owned + ProviderService relation (service active,
 *    non-deleted, same Business) + ProviderBranch relation when a
 *    Branch scope applies. A provider row can never duplicate (unique
 *    PK rows; `@@unique` pairs are the write-time backstop).
 *
 * The result is a compact DTO for low-token downstream AI use — never
 * raw Prisma records, never credentials/auth fields. This resolver
 * does NOT inspect availability, rank slots, create appointments, or
 * call any LLM/WhatsApp boundary (DECISIONS #32/#33) — it is the
 * deterministic foundation CORE-02 (Any-Provider Booking Options)
 * builds on.
 *
 * Repository collaborators are injectable (defaulting to the app
 * singletons) so the workflow logic can be verified without a live
 * database — the established availability/invitations pattern.
 */

import { resolveEligibleProvidersInputSchema } from "@/features/appointments/schemas/provider-eligibility-schema";
import type {
  EligibleProvider,
  ProviderEligibilityResult,
} from "@/features/appointments/types";
import type {
  BranchRepository,
  ProviderRepository,
  ServiceRepository,
} from "@/server/repositories";
import {
  branchRepository,
  providerRepository,
  serviceRepository,
} from "@/server/repositories";

/**
 * Server-resolved authorization context. The Business is the tenant
 * boundary and comes ONLY from server-side resolution — never from a
 * client payload. Role/accountType are deliberately absent: eligibility
 * is relation-driven and identity never influences it.
 */
export type ProviderEligibilityActor = {
  businessId: string | null;
};

export type ProviderEligibilityServiceDeps = {
  serviceRepository: Pick<ServiceRepository, "findById">;
  branchRepository: Pick<BranchRepository, "findByIdWithinBusiness">;
  providerRepository: Pick<ProviderRepository, "listEligibleForService">;
};

/** Production dependencies (app singletons). */
export const defaultProviderEligibilityServiceDeps: ProviderEligibilityServiceDeps =
  {
    serviceRepository,
    branchRepository,
    providerRepository,
  };

const NO_BUSINESS_MESSAGE = "أكمل إعداد المنشأة أولاً";
const SERVICE_NOT_FOUND_MESSAGE = "الخدمة غير موجودة";
const SERVICE_INACTIVE_MESSAGE = "الخدمة غير متاحة للحجز";
const BRANCH_NOT_FOUND_MESSAGE = "الفرع غير موجود";

/**
 * Resolve the eligible Providers for one Service within the actor's
 * Business (and optional Branch scope), deterministically.
 */
export async function resolveEligibleProviders(
  deps: ProviderEligibilityServiceDeps,
  actor: ProviderEligibilityActor,
  input: unknown,
): Promise<ProviderEligibilityResult> {
  const parsed = resolveEligibleProvidersInputSchema.safeParse(input);
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

  const { serviceId, branchId } = parsed.data;

  const service = await deps.serviceRepository.findById(serviceId);
  // Tenant boundary: another Business's service is indistinguishable
  // from an unknown id — eligibility never leaks cross-tenant data.
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

  if (branchId) {
    const branch = await deps.branchRepository.findByIdWithinBusiness(
      branchId,
      actor.businessId,
    );
    if (!branch) {
      return {
        success: false,
        error: { code: "BRANCH_NOT_FOUND", message: BRANCH_NOT_FOUND_MESSAGE },
      };
    }
  }

  const rows = await deps.providerRepository.listEligibleForService(
    actor.businessId,
    serviceId,
    branchId ? { branchId } : undefined,
  );

  const providers: EligibleProvider[] = rows.map((row) => ({
    providerId: row.id,
    displayName: row.displayName ?? row.user.name,
  }));

  return {
    success: true,
    data: {
      serviceId: service.id,
      branchId: branchId ?? null,
      providers,
    },
  };
}
