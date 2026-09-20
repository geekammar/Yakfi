import type { UserRole } from "@/generated/prisma/client";

import type {
  CreateUserDto,
  ListUsersDto,
  UpdateUserDto,
} from "@/lib/validation";
import { paginationSchema, paginationToSkipTake } from "@/lib/validation";
import { db } from "@/server/db";

/**
 * The shared `users` table is owned by Better Auth for identity
 * (credentials/sessions). This repository covers FlowPilot domain
 * data only: business assignment, role, activation.
 */
export class UserRepository {
  async findById(id: string) {
    return db.user.findUnique({ where: { id } });
  }

  /**
   * Identity lookup by email (Better Auth owns uniqueness). Used by the
   * invitation activation workflow to detect existing identities before
   * creating one — the collision cases are classified there, not here.
   */
  async findByEmail(email: string) {
    return db.user.findUnique({ where: { email } });
  }

  async listByBusiness(input: ListUsersDto, rawPagination?: unknown) {
    const pagination = paginationSchema.parse(rawPagination ?? {});
    return db.user.findMany({
      where: {
        businessId: input.businessId,
        ...(input.role ? { role: input.role } : {}),
      },
      orderBy: [{ createdAt: "asc" }],
      ...paginationToSkipTake(pagination),
    });
  }

  async countByBusiness(businessId: string): Promise<number> {
    return db.user.count({ where: { businessId } });
  }

  /**
   * The Business's first ADMIN (the owner the invitation-first flow
   * attached) — a non-secret display REFERENCE for the platform read
   * surface. Never an authorization subject: platform operators never
   * act through it and the email is never exposed raw beyond the
   * operator projection.
   */
  async findAdminByBusiness(businessId: string) {
    return db.user.findFirst({
      where: { businessId, role: "ADMIN", isActive: true },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, email: true },
    });
  }

  /**
   * Batched admin reference for the platform list (one query per page —
   * no N+1). Missing rows are simply absent from the map.
   */
  async findAdminsByBusinesses(businessIds: string[]) {
    if (businessIds.length === 0) return [];
    return db.user.findMany({
      where: {
        businessId: { in: businessIds },
        role: "ADMIN",
        isActive: true,
      },
      orderBy: [{ businessId: "asc" }, { createdAt: "asc" }],
      select: { id: true, name: true, email: true, businessId: true },
    });
  }

  /** Links an authenticated user to a business during onboarding. */
  async assignToBusiness(
    userId: string,
    businessId: string,
    role: UserRole = "ADMIN",
  ) {
    return db.user.update({
      where: { id: userId },
      data: { businessId, role },
    });
  }

  async updateProfile(userId: string, data: UpdateUserDto) {
    return db.user.update({ where: { id: userId }, data });
  }

  async setActive(userId: string, isActive: boolean) {
    return db.user.update({ where: { id: userId }, data: { isActive } });
  }
}

export type { CreateUserDto };
