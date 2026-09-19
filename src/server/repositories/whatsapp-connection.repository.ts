import type {
  CreateWhatsAppConnectionDto,
  UpdateWhatsAppConnectionDto,
} from "@/lib/validation";
import { db } from "@/server/db";
import type { WhatsAppConnection } from "@/types/domain";

/**
 * WhatsAppConnection data primitives (DECISIONS #31, PROMPT-ARCH-02).
 *
 * Business-owned WhatsApp identity with optional Branch scope — all
 * operations are Business-scoped (a connection of ANOTHER Business is
 * "not found"). Provider-neutral: provider/external ids are opaque
 * machine keys; `credentialsRef` stores a REFERENCE to a secret, never
 * the secret itself. No connection-management UI exists yet; no vendor
 * is integrated.
 */
const notDeleted = { deletedAt: null } as const;

export class WhatsAppConnectionRepository {
  async findByIdWithinBusiness(
    id: string,
    businessId: string,
  ): Promise<WhatsAppConnection | null> {
    return db.whatsAppConnection.findFirst({
      where: { id, businessId, ...notDeleted },
    });
  }

  async findByPhone(
    businessId: string,
    phoneNumber: string,
  ): Promise<WhatsAppConnection | null> {
    return db.whatsAppConnection.findFirst({
      where: { businessId, phoneNumber, ...notDeleted },
    });
  }

  /**
   * Resolve a connection by its provider-owned stable identity (e.g. the
   * Meta `phone_number_id`). Called at the INBOUND boundary where the
   * Business is not known yet — the returned row's `businessId` IS the
   * server-derived tenant (never provider input). Provider ids are
   * globally unique in practice; `findFirst` keeps the boundary flat.
   */
  async findByExternalId(
    externalId: string,
  ): Promise<WhatsAppConnection | null> {
    return db.whatsAppConnection.findFirst({
      where: { externalId, ...notDeleted },
    });
  }

  async listByBusiness(businessId: string): Promise<WhatsAppConnection[]> {
    return db.whatsAppConnection.findMany({
      where: { businessId, ...notDeleted },
      orderBy: { createdAt: "asc" },
      take: 100,
    });
  }

  async create(
    input: CreateWhatsAppConnectionDto,
  ): Promise<WhatsAppConnection> {
    const { branchId, ...rest } = input;
    return db.whatsAppConnection.create({
      data: { ...rest, ...(branchId != null ? { branchId } : {}) },
    });
  }

  async update(
    id: string,
    businessId: string,
    input: UpdateWhatsAppConnectionDto,
  ): Promise<WhatsAppConnection | null> {
    const existing = await this.findByIdWithinBusiness(id, businessId);
    if (!existing) return null;
    // `branchId` is handled like `create` (null = leave untouched; a
    // relation update needs an explicit value or omission, never null).
    const { branchId, ...rest } = input;
    return db.whatsAppConnection.update({
      where: { id },
      data: { ...rest, ...(branchId != null ? { branchId } : {}) },
    });
  }
}
