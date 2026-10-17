import type { Prisma } from "@/generated/prisma/client";

import { db } from "@/server/db";
import type {
  ProviderBranch,
  ProviderProfile,
  ProviderService,
} from "@/types/domain";

/**
 * Provider data primitives (DECISIONS #32, PROMPT-ARCH-02).
 *
 * A Provider is a bookable professional identity — NOT an authorization
 * role. Every operation is Business-scoped: a provider/service/branch id
 * from ANOTHER Business is indistinguishable from a missing one
 * (`*_NOT_FOUND`). Eligibility relations are validated to belong to the
 * SAME Business before linking; the `@@unique` pairs are the DB-level
 * race backstop. One Appointment carries at most one Provider — the
 * existing `assignedUserId` seam, unchanged in this pass.
 */

export type ProviderRelationCode =
  | "PROVIDER_NOT_FOUND"
  | "SERVICE_NOT_FOUND"
  | "BRANCH_NOT_FOUND"
  | "ALREADY_LINKED";

export type ProviderRelationResult =
  { ok: true } | { ok: false; code: ProviderRelationCode };

/** Minimal eligible-provider row (display fallback via the User name). */
export type EligibleProviderRow = {
  id: string;
  displayName: string | null;
  user: { name: string };
};

/**
 * The persisted-relation eligibility constraints (PROMPT-CORE-01): the
 * provider is active, owned by the Business, linked to the requested
 * Service (which must itself be active, non-deleted, same Business),
 * and linked to the Branch when a Branch scope applies. Pure so the
 * rules are verifiable without a live database (the check-harness
 * pattern); the query below is their only consumer.
 */
export function eligibleProvidersWhere(
  businessId: string,
  serviceId: string,
  options?: { branchId?: string },
): Prisma.ProviderProfileWhereInput {
  return {
    businessId,
    isActive: true,
    services: {
      some: {
        serviceId,
        service: { businessId, isActive: true, deletedAt: null },
      },
    },
    ...(options?.branchId
      ? {
          branches: {
            some: {
              branchId: options.branchId,
              branch: { businessId, deletedAt: null },
            },
          },
        }
      : {}),
  };
}

/** Prisma unique-constraint violation (the relation-race backstop). */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

export class ProviderRepository {
  async findProfileByUser(userId: string): Promise<ProviderProfile | null> {
    return db.providerProfile.findUnique({ where: { userId } });
  }

  async findProfileWithinBusiness(
    id: string,
    businessId: string,
  ): Promise<ProviderProfile | null> {
    return db.providerProfile.findFirst({ where: { id, businessId } });
  }

  async listProfilesByBusiness(businessId: string): Promise<ProviderProfile[]> {
    return db.providerProfile.findMany({
      where: { businessId, isActive: true },
      orderBy: { createdAt: "asc" },
      take: 200,
    });
  }

  /**
   * Returns true if the business has configured any provider profiles
   * (including inactive ones, so established provider-aware businesses
   * are never silently downgraded to basic booking).
   */
  async hasConfiguredProviders(businessId: string): Promise<boolean> {
    const count = await db.providerProfile.count({
      where: { businessId },
    });
    return count > 0;
  }

  async countProfilesByBusiness(
    businessId: string,
    options?: { includeInactive?: boolean },
  ): Promise<number> {
    return db.providerProfile.count({
      where: {
        businessId,
        ...(options?.includeInactive ? {} : { isActive: true }),
      },
    });
  }

  /**
   * Creates a ProviderProfile for a Business member. The User must
   * belong to the SAME Business — a provider profile can never be
   * attached to another tenant's user. One profile per user (unique).
   */
  async createProfile(
    businessId: string,
    input: { userId: string; displayName?: string },
  ): Promise<ProviderProfile | null> {
    const user = await db.user.findFirst({
      where: { id: input.userId, businessId, isActive: true },
      select: { id: true },
    });
    if (!user) return null;
    return db.providerProfile.create({
      data: {
        businessId,
        userId: input.userId,
        ...(input.displayName != null
          ? { displayName: input.displayName }
          : {}),
      },
    });
  }

  async listServices(providerId: string): Promise<ProviderService[]> {
    return db.providerService.findMany({
      where: { providerId },
      orderBy: { createdAt: "asc" },
      take: 200,
    });
  }

  async listBranches(providerId: string): Promise<ProviderBranch[]> {
    return db.providerBranch.findMany({
      where: { providerId },
      orderBy: { createdAt: "asc" },
      take: 200,
    });
  }

  /**
   * Eligible Providers for one Service (PROMPT-CORE-01): ONE query with
   * all persisted relational constraints (`eligibleProvidersWhere`) —
   * a provider from another Business can never appear, and a provider
   * row can never duplicate (unique PK rows; the `@@unique` relation
   * pairs are the write-time backstop).
   */
  async listEligibleForService(
    businessId: string,
    serviceId: string,
    options?: { branchId?: string },
  ): Promise<EligibleProviderRow[]> {
    return db.providerProfile.findMany({
      where: eligibleProvidersWhere(businessId, serviceId, options),
      select: {
        id: true,
        displayName: true,
        user: { select: { name: true } },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 200,
    });
  }

  /**
   * The assignment seam for already-resolved eligible Providers
   * (PROMPT-CORE-02): ONE batched Business-scoped projection of
   * ProviderProfile.id → userId (the Appointment.assignedUserId seam,
   * DECISIONS #32). A provider id from another Business (or an unknown
   * one) never resolves — callers skip it. This is NOT eligibility
   * re-resolution: eligibility stays CORE-01's; this is only the
   * id→seam projection the availability lookup needs.
   */
  async listAssignmentSeams(
    businessId: string,
    providerIds: string[],
  ): Promise<Array<{ providerId: string; userId: string }>> {
    if (providerIds.length === 0) return [];
    const rows = await db.providerProfile.findMany({
      where: { businessId, id: { in: providerIds } },
      select: { id: true, userId: true },
    });
    return rows.map((row) => ({ providerId: row.id, userId: row.userId }));
  }

  /** Links a Provider to a Service it is eligible to deliver. */
  async addServiceEligibility(
    businessId: string,
    providerId: string,
    serviceId: string,
  ): Promise<ProviderRelationResult> {
    return this.linkRelation(businessId, providerId, async (tx) => {
      const service = await tx.service.findFirst({
        where: { id: serviceId, businessId, deletedAt: null },
        select: { id: true },
      });
      if (!service) return { ok: false, code: "SERVICE_NOT_FOUND" as const };
      const linked = await tx.providerService
        .create({ data: { providerId, serviceId } })
        .then(
          () => true,
          (error) => isUniqueViolation(error),
        );
      return linked
        ? ({ ok: true } as const)
        : { ok: false, code: "ALREADY_LINKED" as const };
    });
  }

  /** Links a Provider to a Branch it works in. */
  async addBranchEligibility(
    businessId: string,
    providerId: string,
    branchId: string,
  ): Promise<ProviderRelationResult> {
    return this.linkRelation(businessId, providerId, async (tx) => {
      const branch = await tx.branch.findFirst({
        where: { id: branchId, businessId, deletedAt: null },
        select: { id: true },
      });
      if (!branch) return { ok: false, code: "BRANCH_NOT_FOUND" as const };
      const linked = await tx.providerBranch
        .create({ data: { providerId, branchId } })
        .then(
          () => true,
          (error) => isUniqueViolation(error),
        );
      return linked
        ? ({ ok: true } as const)
        : { ok: false, code: "ALREADY_LINKED" as const };
    });
  }

  /** Removes an eligibility relation (Business-scoped, idempotent). */
  async removeServiceEligibility(
    businessId: string,
    providerId: string,
    serviceId: string,
  ): Promise<void> {
    const provider = await this.findProfileWithinBusiness(
      providerId,
      businessId,
    );
    if (!provider) return;
    await db.providerService.deleteMany({ where: { providerId, serviceId } });
  }

  async removeBranchEligibility(
    businessId: string,
    providerId: string,
    branchId: string,
  ): Promise<void> {
    const provider = await this.findProfileWithinBusiness(
      providerId,
      businessId,
    );
    if (!provider) return;
    await db.providerBranch.deleteMany({ where: { providerId, branchId } });
  }

  /** Shared provider-exists + same-business guard for relation writes. */
  private async linkRelation(
    businessId: string,
    providerId: string,
    operation: (
      tx: Prisma.TransactionClient,
    ) => Promise<ProviderRelationResult>,
  ): Promise<ProviderRelationResult> {
    return db.$transaction(async (tx) => {
      const provider = await tx.providerProfile.findFirst({
        where: { id: providerId, businessId },
        select: { id: true },
      });
      if (!provider) return { ok: false, code: "PROVIDER_NOT_FOUND" as const };
      return operation(tx);
    });
  }
}
