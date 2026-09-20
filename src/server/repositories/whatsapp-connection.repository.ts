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
 * the secret itself.
 *
 * TWO lifecycle surfaces (WHATSAPP-ONBOARDING-01): the OPERATIONAL gate
 * (`status`/`isActive`, consumed by the transport runtime) and the
 * ONBOARDING lifecycle (`onboardingState` + provenance, consumed only by
 * the onboarding feature and the platform read surface). They never
 * share a write path: `markOnboardingReady` is the ONLY way to write
 * `READY`, and it is guarded by the operational gate.
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

  /**
   * The Business's connection used by the onboarding flow. One WhatsApp
   * connection per Business is the current product shape (DECISIONS
   * #31/#47 — multiple connections are out of scope), so "the oldest
   * connection" is the onboarding target and a second row is never
   * silently created.
   */
  async findPrimaryByBusiness(
    businessId: string,
  ): Promise<WhatsAppConnection | null> {
    return db.whatsAppConnection.findFirst({
      where: { businessId, ...notDeleted },
      orderBy: { createdAt: "asc" },
    });
  }

  /**
   * Batched read for the platform read surface (one query for a page of
   * Businesses — no N+1). Business-scoped by construction; the caller
   * groups the result rows server-side.
   */
  async listByBusinessIds(
    businessIds: string[],
  ): Promise<WhatsAppConnection[]> {
    if (businessIds.length === 0) return [];
    return db.whatsAppConnection.findMany({
      where: { businessId: { in: businessIds }, ...notDeleted },
      orderBy: [{ businessId: "asc" }, { createdAt: "asc" }],
      take: 500,
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

  /**
   * THE ONLY WRITE PATH TO ONBOARDING `READY` (WHATSAPP-ONBOARDING-01).
   * A conditional update guarded by the OPERATIONAL gate — the row must
   * already be `CONNECTED` AND active within the caller's Business — so
   * an onboarding-READY row can provably never exist for a connection
   * that the runtime send/inbound gate would refuse. `updateMany` with
   * the guard makes this a single atomic step (no read-then-write race);
   * a guard that fails to match any row returns null and the caller
   * records the normalized failure instead of claiming readiness.
   */
  async markOnboardingReady(
    id: string,
    businessId: string,
  ): Promise<WhatsAppConnection | null> {
    const now = new Date();
    const result = await db.whatsAppConnection.updateMany({
      where: {
        id,
        businessId,
        ...notDeleted,
        status: "CONNECTED",
        isActive: true,
      },
      data: {
        onboardingState: "READY",
        onboardingActor: "FLOWPILOT",
        onboardingReasonCode: null,
        onboardingReasonSummary: null,
        onboardingRetryable: null,
        onboardingStateChangedAt: now,
        onboardingCompletedAt: now,
        onboardingFailedAt: null,
      },
    });
    if (result.count === 0) return null;
    return this.findByIdWithinBusiness(id, businessId);
  }
}
