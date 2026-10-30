import type { Prisma } from "@/generated/prisma/client";

import { db } from "@/server/db";
import type {
  ProviderBranch,
  ProviderProfile,
  ProviderService,
  ProviderServiceExclusion,
} from "@/types/domain";

/**
 * Provider data primitives (STAFF-PROVIDER-01 / DECISIONS #32).
 *
 * A Provider is a bookable professional identity — independent of
 * authentication or User login accounts. Every operation is Business-scoped:
 * a provider/service/branch id from ANOTHER Business is indistinguishable
 * from a missing one (`*_NOT_FOUND`).
 *
 * Policies:
 * - ALL_SERVICES (default): eligible for all current and future active services
 *   except explicit exclusions.
 * - SPECIFIC_SERVICES (legacy/inclusion): eligible only for services explicitly
 *   listed in ProviderService.
 */

export type ProviderRelationCode =
  | "PROVIDER_NOT_FOUND"
  | "SERVICE_NOT_FOUND"
  | "BRANCH_NOT_FOUND"
  | "ALREADY_LINKED";

export type ProviderRelationResult =
  { ok: true } | { ok: false; code: ProviderRelationCode };

/** Minimal eligible-provider row (display fallback via name or User name). */
export type EligibleProviderRow = {
  id: string;
  name?: string;
  displayName: string | null;
  user?: { name: string } | null;
};

/**
 * The persisted-relation eligibility constraints (STAFF-PROVIDER-01 / CORE-01).
 * Supports ALL_SERVICES (with exclusions) and legacy SPECIFIC_SERVICES.
 */
export function eligibleProvidersWhere(
  businessId: string,
  serviceId: string,
  options?: { branchId?: string },
): Prisma.ProviderProfileWhereInput {
  return {
    businessId,
    isActive: true,
    OR: [
      {
        servicePolicy: "ALL_SERVICES",
        exclusions: {
          none: {
            serviceId,
          },
        },
      },
      {
        servicePolicy: "SPECIFIC_SERVICES",
        services: {
          some: {
            serviceId,
            service: { businessId, isActive: true, deletedAt: null },
          },
        },
      },
    ],
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

export type ProviderWithDetails = ProviderProfile & {
  user: { id: string; name: string; email: string } | null;
  branches: Array<{ branchId: string; branch: { id: string; name: string } }>;
  exclusions: Array<{
    serviceId: string;
    service: { id: string; name: string };
  }>;
  services: Array<{ serviceId: string; service: { id: string; name: string } }>;
};

export class ProviderRepository {
  private readonly client: typeof db;

  constructor(client: typeof db = db) {
    this.client = client;
  }

  async findProfileByUser(userId: string): Promise<ProviderProfile | null> {
    return (this.client ?? db).providerProfile.findUnique({
      where: { userId },
    });
  }

  async findProfileWithinBusiness(
    id: string,
    businessId: string,
  ): Promise<ProviderProfile | null> {
    return db.providerProfile.findFirst({ where: { id, businessId } });
  }

  async listProfilesByBusiness(
    businessId: string,
    options?: { includeInactive?: boolean },
  ): Promise<ProviderProfile[]> {
    return db.providerProfile.findMany({
      where: {
        businessId,
        ...(options?.includeInactive ? {} : { isActive: true }),
      },
      orderBy: { createdAt: "asc" },
      take: 200,
    });
  }

  async listWithDetailsByBusiness(
    businessId: string,
  ): Promise<ProviderWithDetails[]> {
    return db.providerProfile.findMany({
      where: { businessId },
      include: {
        user: { select: { id: true, name: true, email: true } },
        branches: {
          include: { branch: { select: { id: true, name: true } } },
        },
        exclusions: {
          include: { service: { select: { id: true, name: true } } },
        },
        services: {
          include: { service: { select: { id: true, name: true } } },
        },
      },
      orderBy: { createdAt: "asc" },
      take: 200,
    });
  }

  /**
   * Returns true if the business has configured any provider profiles
   * (including inactive ones).
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
   * Creates a ProviderProfile. Can be completely independent of User accounts.
   * If userId is provided, validates that the user belongs to the same business.
   */
  async createProfile(
    businessId: string,
    input: {
      name?: string;
      userId?: string | null;
      displayName?: string;
      servicePolicy?: "ALL_SERVICES" | "SPECIFIC_SERVICES";
      isActive?: boolean;
    },
  ): Promise<ProviderProfile | null> {
    let resolvedName = input.name?.trim() || "";
    if (input.userId) {
      const user = await db.user.findFirst({
        where: { id: input.userId, businessId, isActive: true },
        select: { id: true, name: true },
      });
      if (!user) return null;
      if (!resolvedName) resolvedName = user.name;
    }
    if (!resolvedName) resolvedName = input.displayName?.trim() || "مقدم خدمة";

    return db.providerProfile.create({
      data: {
        businessId,
        name: resolvedName,
        userId: input.userId || null,
        displayName: input.displayName?.trim() || null,
        servicePolicy: input.servicePolicy || "ALL_SERVICES",
        isActive: input.isActive ?? true,
      },
    });
  }

  /** Updates an existing provider profile. */
  async updateProfile(
    id: string,
    businessId: string,
    input: {
      name?: string;
      displayName?: string | null;
      userId?: string | null;
      servicePolicy?: "ALL_SERVICES" | "SPECIFIC_SERVICES";
      isActive?: boolean;
    },
  ): Promise<ProviderProfile | null> {
    const existing = await this.findProfileWithinBusiness(id, businessId);
    if (!existing) return null;
    if (input.userId) {
      const user = await db.user.findFirst({
        where: { id: input.userId, businessId, isActive: true },
        select: { id: true },
      });
      if (!user) return null;
    }
    return db.providerProfile.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.displayName !== undefined
          ? { displayName: input.displayName?.trim() || null }
          : {}),
        ...(input.userId !== undefined ? { userId: input.userId || null } : {}),
        ...(input.servicePolicy !== undefined
          ? { servicePolicy: input.servicePolicy }
          : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
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

  async listExclusions(
    providerId: string,
  ): Promise<ProviderServiceExclusion[]> {
    return db.providerServiceExclusion.findMany({
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
   * Eligible Providers for one Service (STAFF-PROVIDER-01 / CORE-01).
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
        name: true,
        displayName: true,
        user: { select: { name: true } },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 200,
    });
  }

  /**
   * Batched per-service provider eligibility counts (STAFF-PROVIDER-01).
   * Replaces N queries with 1 bounded query.
   */
  async countEligiblePerService(
    businessId: string,
    serviceIds: string[],
    options?: { branchId?: string },
  ): Promise<Map<string, number>> {
    if (serviceIds.length === 0) return new Map();

    const providers = await (this.client ?? db).providerProfile.findMany({
      where: {
        businessId,
        isActive: true,
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
      },
      select: {
        id: true,
        servicePolicy: true,
        exclusions: { select: { serviceId: true } },
        services: { select: { serviceId: true } },
      },
    });

    const counts = new Map<string, number>();
    for (const serviceId of serviceIds) {
      counts.set(serviceId, 0);
    }

    for (const provider of providers) {
      if (provider.servicePolicy === "ALL_SERVICES") {
        const excludedSet = new Set(
          provider.exclusions.map((e) => e.serviceId),
        );
        for (const serviceId of serviceIds) {
          if (!excludedSet.has(serviceId)) {
            counts.set(serviceId, (counts.get(serviceId) ?? 0) + 1);
          }
        }
      } else if (provider.servicePolicy === "SPECIFIC_SERVICES") {
        const includedSet = new Set(provider.services.map((s) => s.serviceId));
        for (const serviceId of serviceIds) {
          if (includedSet.has(serviceId)) {
            counts.set(serviceId, (counts.get(serviceId) ?? 0) + 1);
          }
        }
      }
    }

    return counts;
  }

  /**
   * The assignment seam for already-resolved eligible Providers.
   * Maps ProviderProfile.id → userId when present, or null for independent providers.
   */
  async listAssignmentSeams(
    businessId: string,
    providerIds: string[],
  ): Promise<Array<{ providerId: string; userId: string | null }>> {
    if (providerIds.length === 0) return [];
    const rows = await (this.client ?? db).providerProfile.findMany({
      where: { businessId, id: { in: providerIds } },
      select: { id: true, userId: true },
    });
    return rows.map((row) => ({
      providerId: row.id,
      userId: row.userId ?? null,
    }));
  }

  /** Links a Provider to a Service it is eligible to deliver (SPECIFIC_SERVICES). */
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

  /** Removes an eligibility inclusion relation (Business-scoped, idempotent). */
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

  /** Adds an explicit service exclusion (for ALL_SERVICES policy). */
  async addServiceExclusion(
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
      const linked = await tx.providerServiceExclusion
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

  /** Removes a service exclusion (re-enabling eligibility under ALL_SERVICES). */
  async removeServiceExclusion(
    businessId: string,
    providerId: string,
    serviceId: string,
  ): Promise<void> {
    const provider = await this.findProfileWithinBusiness(
      providerId,
      businessId,
    );
    if (!provider) return;
    await db.providerServiceExclusion.deleteMany({
      where: { providerId, serviceId },
    });
  }

  /** Atomically sets the exact list of excluded services for a provider. */
  async setServiceExclusions(
    businessId: string,
    providerId: string,
    serviceIds: string[],
  ): Promise<void> {
    const provider = await this.findProfileWithinBusiness(
      providerId,
      businessId,
    );
    if (!provider) return;

    await db.$transaction(async (tx) => {
      await tx.providerServiceExclusion.deleteMany({ where: { providerId } });
      if (serviceIds.length > 0) {
        // Only exclude valid services belonging to the business
        const validServices = await tx.service.findMany({
          where: { businessId, id: { in: serviceIds }, deletedAt: null },
          select: { id: true },
        });
        if (validServices.length > 0) {
          await tx.providerServiceExclusion.createMany({
            data: validServices.map((s) => ({
              providerId,
              serviceId: s.id,
            })),
            skipDuplicates: true,
          });
        }
      }
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

  /** Sets a single primary branch or clears branches for a provider. */
  async setBranchEligibility(
    businessId: string,
    providerId: string,
    branchId: string | null,
  ): Promise<void> {
    const provider = await this.findProfileWithinBusiness(
      providerId,
      businessId,
    );
    if (!provider) return;

    await db.$transaction(async (tx) => {
      await tx.providerBranch.deleteMany({ where: { providerId } });
      if (branchId) {
        const branch = await tx.branch.findFirst({
          where: { id: branchId, businessId, deletedAt: null },
          select: { id: true },
        });
        if (branch) {
          await tx.providerBranch.create({
            data: { providerId, branchId: branch.id },
          });
        }
      }
    });
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
