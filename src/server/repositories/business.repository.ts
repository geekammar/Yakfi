import type { Business, Prisma } from "@/generated/prisma/client";

import type { CreateBusinessDto, UpdateBusinessDto } from "@/lib/validation";
import { db } from "@/server/db";
import { DEFAULT_BRANCH_NAME } from "@/server/repositories/branch.repository";

/** Soft-deleted rows are excluded from all reads by default. */
const notDeleted = { deletedAt: null } as const;

/**
 * Creates the Business's Default Branch and sets the pointer — ONE
 * atomic step used by every Business-creation path. Runs inside the
 * caller's transaction; the invariant "every Business has exactly one
 * Default Branch" is structural (Business + Branch + pointer commit or
 * roll back together).
 */
async function createDefaultBranch(
  tx: Prisma.TransactionClient,
  businessId: string,
): Promise<string> {
  const branch = await tx.branch.create({
    data: { businessId, name: DEFAULT_BRANCH_NAME },
    select: { id: true },
  });
  await tx.business.update({
    where: { id: businessId },
    data: { defaultBranchId: branch.id },
  });
  return branch.id;
}

export class BusinessRepository {
  async findById(id: string): Promise<Business | null> {
    return db.business.findFirst({ where: { id, ...notDeleted } });
  }

  async findByWhatsappNumber(number: string): Promise<Business | null> {
    return db.business.findFirst({
      where: { whatsappNumber: number, ...notDeleted },
    });
  }

  async create(data: CreateBusinessDto): Promise<Business> {
    return db.$transaction(async (tx) => {
      const business = await tx.business.create({ data });
      await createDefaultBranch(tx, business.id);
      return business;
    });
  }

  async createForUser(
    userId: string,
    data: CreateBusinessDto,
  ): Promise<Business> {
    return db.$transaction(async (tx) => {
      const business = await tx.business.create({ data });
      const assignment = await tx.user.updateMany({
        where: { id: userId, businessId: null },
        data: { businessId: business.id, role: "ADMIN" },
      });

      if (assignment.count !== 1) {
        throw new Error("USER_ALREADY_ASSIGNED");
      }

      await createDefaultBranch(tx, business.id);
      return business;
    });
  }

  async update(id: string, data: UpdateBusinessDto): Promise<Business> {
    return db.business.update({ where: { id }, data });
  }

  /** Deactivates first (fail-safe), then flags as deleted. */
  async softDelete(id: string): Promise<Business> {
    const now = new Date();
    return db.business.update({
      where: { id },
      data: { isActive: false, deletedAt: now },
    });
  }

  async restore(id: string): Promise<Business> {
    return db.business.update({
      where: { id },
      data: { deletedAt: null, isActive: true },
    });
  }

  async completeOnboarding(id: string): Promise<Business> {
    return db.business.update({
      where: { id },
      data: { onboardingCompletedAt: new Date() },
    });
  }
}
