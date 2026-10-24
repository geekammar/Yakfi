import type {
  CreateTelegramConnectionDto,
  UpdateTelegramConnectionDto,
} from "@/lib/validation";
import { db } from "@/server/db";
import type { TelegramConnection } from "@/types/domain";

/**
 * TelegramConnection data primitives (DECISIONS #63/#64 — second channel).
 *
 * A transport SIBLING of `WhatsAppConnectionRepository`, deliberately NOT
 * a polymorphic connection table and NOT a column on the WhatsApp
 * connection. Business-owned Telegram identity with optional Branch
 * scope — every operation is Business-scoped (a connection of ANOTHER
 * Business is "not found", so cross-tenant use is impossible).
 *
 * TWO lifecycle surfaces, exactly like the WhatsApp connection: the
 * OPERATIONAL gate (`status`/`isActive`, consumed by the transport
 * runtime) and the ONBOARDING lifecycle (`onboardingState` + provenance,
 * consumed only by the provisioning feature). They never share a write
 * path: `markOnboardingReady` is the ONLY way to write `READY`, and it is
 * guarded by the operational gate.
 *
 * `credentialsRef` is a REFERENCE to the managed bot token (an opaque
 * `fp:<id>` RUNTIME handle) — the raw token NEVER crosses this layer, so
 * repository query logs can only ever contain the reference.
 */
const notDeleted = { deletedAt: null } as const;

export class TelegramConnectionRepository {
  async findByIdWithinBusiness(
    id: string,
    businessId: string,
  ): Promise<TelegramConnection | null> {
    return db.telegramConnection.findFirst({
      where: { id, businessId, ...notDeleted },
    });
  }

  async listByBusiness(businessId: string): Promise<TelegramConnection[]> {
    return db.telegramConnection.findMany({
      where: { businessId, ...notDeleted },
      orderBy: { createdAt: "asc" },
      take: 100,
    });
  }

  /**
   * THE connection a Business's settings surface renders (DECISIONS #66).
   * One bot per Business is the approved pilot model; this returns that
   * row, preferring an operationally active one, then the most recent —
   * so a disconnected bot is still visible (the honest DISCONNECTED
   * state), and a soft-deleted row never is. Business-scoped: a foreign
   * Business's connection is "not found".
   */
  async findPrimaryByBusiness(
    businessId: string,
  ): Promise<TelegramConnection | null> {
    const connections = await db.telegramConnection.findMany({
      where: { businessId, ...notDeleted },
      orderBy: [
        { isActive: "desc" },
        { status: "desc" },
        { createdAt: "desc" },
      ],
      take: 1,
    });
    return connections[0] ?? null;
  }

  /**
   * Resolve a connection by the managed bot's STABLE Telegram identity.
   * Called at the INBOUND boundary where the Business is not known yet —
   * the returned row's `businessId` IS the server-derived tenant (never
   * provider input). Used by the duplicate-attach guard: the SAME managed
   * bot cannot be provisioned to a second Business (a forged or replayed
   * provisioning callback would make `findByExternalId` resolution
   * ambiguous), so the provisioning boundary refuses when another
   * Business already owns the bot.
   */
  async findByExternalId(
    botExternalId: string,
  ): Promise<TelegramConnection | null> {
    return db.telegramConnection.findFirst({
      where: { botExternalId, ...notDeleted },
    });
  }

  /**
   * INBOUND webhook routing: resolve the connection server-side from the
   * SHA-256 digest of the `X-Telegram-Bot-Api-Secret-Token` header. The
   * digest is a NON-SECRET, non-reversible index — the plaintext secret
   * is generated at provisioning, handed to Telegram once, and never
   * stored. `webhookSecretHash` is UNIQUE, so an authenticated webhook
   * resolves to EXACTLY ONE connection and its `businessId` is the tenant
   * (never a client-supplied Business id, never a value from the payload).
   */
  async findByWebhookSecretHash(
    webhookSecretHash: string,
  ): Promise<TelegramConnection | null> {
    return db.telegramConnection.findFirst({
      where: { webhookSecretHash, ...notDeleted, isActive: true },
    });
  }

  async create(
    input: CreateTelegramConnectionDto,
  ): Promise<TelegramConnection> {
    const { branchId, ...rest } = input;
    return db.telegramConnection.create({
      data: { ...rest, ...(branchId != null ? { branchId } : {}) },
    });
  }

  async update(
    id: string,
    businessId: string,
    input: UpdateTelegramConnectionDto,
  ): Promise<TelegramConnection | null> {
    const existing = await this.findByIdWithinBusiness(id, businessId);
    if (!existing) return null;
    // `branchId` is handled like `create` (null = leave untouched; a
    // relation update needs an explicit value or omission, never null).
    const { branchId, ...rest } = input;
    return db.telegramConnection.update({
      where: { id },
      data: { ...rest, ...(branchId != null ? { branchId } : {}) },
    });
  }

  /**
   * Controlled update of webhook secret hash guarded by tenant, active status,
   * and optional expected previous hash to prevent overwriting disconnected
   * or concurrently changed connections.
   */
  async updateWebhookSecretHash(
    id: string,
    businessId: string,
    webhookSecretHash: string,
    options?: { expectedPreviousHash?: string | null },
  ): Promise<TelegramConnection | null> {
    const where: {
      id: string;
      businessId: string;
      deletedAt: null;
      status: "CONNECTED";
      isActive: true;
      webhookSecretHash?: string | null;
    } = {
      id,
      businessId,
      deletedAt: null,
      status: "CONNECTED",
      isActive: true,
      ...(options && "expectedPreviousHash" in options
        ? { webhookSecretHash: options.expectedPreviousHash }
        : {}),
    };
    const result = await db.telegramConnection.updateMany({
      where,
      data: { webhookSecretHash },
    });
    if (result.count === 0) return null;
    return this.findByIdWithinBusiness(id, businessId);
  }

  /**
   * DISCONNECT an operationally connected connection (DECISIONS #66 —
   * the supported lifecycle: `deleteWebhook` → disconnect → remove the
   * runtime credential reference). A conditional atomic update guarded by
   * the OPERATIONAL gate — only a row that is currently `CONNECTED` and
   * active within the caller's Business can be disconnected — so a
   * disconnected/PENDING row is never rewritten twice and a foreign row
   * is "not found". The row is RETAINED (provenance + the UI's honest
   * "disconnected" state); the transport runtime and inbound routing
   * refuse it through `isActive`/`status`, and the webhook is removed at
   * Telegram before this is called.
   */
  async disconnect(
    id: string,
    businessId: string,
  ): Promise<TelegramConnection | null> {
    const now = new Date();
    const result = await db.telegramConnection.updateMany({
      where: {
        id,
        businessId,
        ...notDeleted,
        status: "CONNECTED",
        isActive: true,
      },
      data: {
        status: "DISCONNECTED",
        isActive: false,
        onboardingState: "NOT_STARTED",
        onboardingActor: "CUSTOMER",
        onboardingStateChangedAt: now,
      },
    });
    if (result.count === 0) return null;
    return this.findByIdWithinBusiness(id, businessId);
  }

  /**
   * THE ONLY WRITE PATH TO ONBOARDING `READY` (mirrors the WhatsApp
   * connection). A conditional update guarded by the OPERATIONAL gate —
   * the row must already be `CONNECTED` AND active within the caller's
   * Business — so an onboarding-READY row can provably never exist for a
   * connection the runtime send/inbound gate would refuse. `updateMany`
   * with the guard makes this a single atomic step (no read-then-write
   * race); a guard that matches no row returns null and the caller
   * records the normalized failure instead of claiming readiness.
   */
  async markOnboardingReady(
    id: string,
    businessId: string,
  ): Promise<TelegramConnection | null> {
    const now = new Date();
    const result = await db.telegramConnection.updateMany({
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
