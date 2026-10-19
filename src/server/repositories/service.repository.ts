import type { Service } from "@/generated/prisma/client";

import type { CreateServiceDto, UpdateServiceDto } from "@/lib/validation";
import { paginationSchema, paginationToSkipTake } from "@/lib/validation";
import { db } from "@/server/db";

const notDeleted = { deletedAt: null } as const;

export class ServiceRepository {
  async findById(id: string): Promise<Service | null> {
    return db.service.findFirst({ where: { id, ...notDeleted } });
  }

  async findByIdWithinBusiness(
    id: string,
    businessId: string,
  ): Promise<Service | null> {
    return db.service.findFirst({ where: { id, businessId, ...notDeleted } });
  }

  async listByBusiness(
    businessId: string,
    options?: { includeInactive?: boolean; rawPagination?: unknown },
  ): Promise<Service[]> {
    const pagination = paginationSchema.parse(options?.rawPagination ?? {});
    return db.service.findMany({
      where: {
        businessId,
        ...notDeleted,
        ...(options?.includeInactive ? {} : { isActive: true }),
      },
      orderBy: [{ name: "asc" }],
      ...paginationToSkipTake(pagination),
    });
  }

  async create(data: CreateServiceDto): Promise<Service> {
    return db.service.create({ data });
  }

  async update(id: string, data: UpdateServiceDto): Promise<Service> {
    return db.service.update({ where: { id }, data });
  }

  async setActive(id: string, isActive: boolean): Promise<Service> {
    return db.service.update({ where: { id }, data: { isActive } });
  }

  async softDelete(id: string): Promise<Service> {
    const now = new Date();
    return db.service.update({
      where: { id },
      data: { isActive: false, deletedAt: now },
    });
  }

  async restore(id: string): Promise<Service> {
    return db.service.update({
      where: { id },
      data: { deletedAt: null },
    });
  }
}
