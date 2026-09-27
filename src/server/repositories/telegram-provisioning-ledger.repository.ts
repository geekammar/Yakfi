import { db } from "@/server/db";
import type { TelegramProvisioningLedger } from "@/types/domain";

/**
 * Telegram managed-bot provisioning ledger primitives
 * (DECISIONS #63 (D) — the single-use provisioning ledger).
 *
 * The exact analogue of `WhatsAppOnboardingAuthorizationRepository` for
 * the managed-bot path. One row per LAUNCHED provisioning attempt. The
 * customer-facing deep link (`https://t.me/<manager>?start=<token>`)
 * carries ONLY the opaque `startToken`; the target Business and the bound
 * creator are resolved from THIS server-persisted row — never from a
 * query parameter, a client payload, or the webhook body.
 *
 * Invariants, all structural (no reliance on caller discipline):
 * - SINGLE-USE: `consume` is a conditional update on (startToken, bound
 *   creator, unconsumed, unexpired), so a replayed or hostile callback
 *   matches no row, nothing is written, and the caller records a
 *   normalized failure instead of provisioning anything.
 * - CREATOR IDENTITY BINDING: `bindCreator` records the Telegram `user.id`
 *   that STARTed the Manager Bot; the later `managed_bot` event's creator
 *   `user.id` MUST equal it, so a forged callback cannot attach a managed
 *   bot to a Business it was never launched for (cross-tenant forgery).
 * - TENANT ISOLATION: `businessId` comes ONLY from this row; no caller
 *   may choose a Business for a provisioning attempt.
 * - IDEMPOTENT LAUNCH: one in-flight attempt per Business resumes instead
 *   of duplicating (`findActiveByBusiness`).
 */

/** Lifetime of one provisioning attempt (a human tap in Telegram). */
export const TELEGRAM_PROVISIONING_EXPIRY_MINUTES = 15;

export type NewTelegramProvisioningLedger = {
  businessId: string;
  startToken: string;
  expiresAt: Date;
};

export type TelegramProvisioningRecord = Pick<
  TelegramProvisioningLedger,
  | "id"
  | "businessId"
  | "connectionId"
  | "startToken"
  | "creatorTelegramUserId"
  | "expiresAt"
  | "consumedAt"
  | "outcomeCode"
  | "createdAt"
>;

const recordSelect = {
  id: true,
  businessId: true,
  connectionId: true,
  startToken: true,
  creatorTelegramUserId: true,
  expiresAt: true,
  consumedAt: true,
  outcomeCode: true,
  createdAt: true,
} as const;

export class TelegramProvisioningLedgerRepository {
  async create(
    input: NewTelegramProvisioningLedger,
  ): Promise<TelegramProvisioningRecord> {
    return db.telegramProvisioningLedger.create({
      data: input,
      select: recordSelect,
    });
  }

  async findByStartToken(
    startToken: string,
  ): Promise<TelegramProvisioningRecord | null> {
    return db.telegramProvisioningLedger.findUnique({
      where: { startToken },
      select: recordSelect,
    });
  }

  /**
   * The in-flight (unconsumed, unexpired) attempt for a Business — the
   * resume target of a relaunched flow. Returns null when the previous
   * attempt was consumed, expired, or never existed.
   */
  async findActiveByBusiness(
    businessId: string,
    now: Date = new Date(),
  ): Promise<TelegramProvisioningRecord | null> {
    return db.telegramProvisioningLedger.findFirst({
      where: {
        businessId,
        consumedAt: null,
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: "desc" },
      select: recordSelect,
    });
  }

  /**
   * The MOST RECENT attempt for a Business, whatever its state — the
   * UI's honest pre-connection state signal. When no connection exists
   * yet, this row alone distinguishes "never started" (null), "in flight"
   * (unconsumed + unexpired), "abandoned" (unconsumed but expired), and
   * "terminated with a typed failure" (consumed without a connection).
   * `findActiveByBusiness` stays the resume target; this is the
   * read-only view of the last attempt's outcome.
   */
  async findLatestByBusiness(
    businessId: string,
  ): Promise<TelegramProvisioningRecord | null> {
    return db.telegramProvisioningLedger.findFirst({
      where: { businessId },
      orderBy: { createdAt: "desc" },
      select: recordSelect,
    });
  }

  /**
   * Bind the Telegram `user.id` that opened the deep link and STARTed the
   * Manager Bot to this attempt. Conditional on (startToken, unconsumed,
   * unexpired, UNBOUND-or-already-bound-to-THIS-same-creator): an
   * already-consumed or expired token is never re-bound, a token that never
   * existed matches nothing, and — the single-use guarantee — a token that
   * is ALREADY BOUND to a different chat is never re-bound to this one.
   *
   * Without the unbound-or-same-creator condition a SHARED deep link would
   * let a second Telegram account steal the attempt: it would re-bind the
   * creator to itself, then its own `managed_bot` event would match the
   * bound creator and attach a bot to a Business it was never launched for.
   * The condition keeps the ONE legitimate replay idempotent (the SAME
   * Admin re-opens the link → the same row, the same bound creator, the
   * keyboard is re-sent) while making a second account's `/start` match no
   * row. Returns whether THIS call bound (or already had) the creator —
   * the caller treats a miss as a normalized failure and provisions
   * nothing.
   */
  async bindCreator(
    startToken: string,
    creatorTelegramUserId: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    const result = await db.telegramProvisioningLedger.updateMany({
      where: {
        startToken,
        consumedAt: null,
        expiresAt: { gt: now },
        OR: [{ creatorTelegramUserId: null }, { creatorTelegramUserId }],
      },
      data: { creatorTelegramUserId },
    });
    return result.count === 1;
  }

  /**
   * The in-flight (unconsumed, unexpired) attempt whose creator is ALREADY
   * bound to this Telegram `user.id` — the row a `managed_bot` event must
   * match to complete provisioning. The event carries the creator but NOT
   * the start token, so the bound creator is the lookup key; the expected
   * shape is exactly ONE in-flight attempt per creator (the deep link is
   * single-use and a relaunch resumes the same attempt), and the
   * single-use `consume` below still refuses anything that no longer
   * matches, so a stale or racing row can never provision a bot.
   */
  async findActiveByCreator(
    creatorTelegramUserId: string,
    now: Date = new Date(),
  ): Promise<TelegramProvisioningRecord | null> {
    return db.telegramProvisioningLedger.findFirst({
      where: {
        creatorTelegramUserId,
        consumedAt: null,
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: "desc" },
      select: recordSelect,
    });
  }

  /**
   * Consume the attempt EXACTLY ONCE: a conditional update matching the
   * unconsumed, unexpired row for this `startToken` whose BOUND creator
   * equals the `managed_bot` event's creator — so only the creator who
   * launched the attempt can consume it, and only once. Returns whether
   * THIS call was the consumer; a replay (already consumed), an expired
   * attempt, an unbound attempt, or a hostile token that never existed
   * all fail to match and the caller records a normalized failure instead
   * of provisioning anything.
   */
  async consume(
    startToken: string,
    creatorTelegramUserId: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    const result = await db.telegramProvisioningLedger.updateMany({
      where: {
        startToken,
        creatorTelegramUserId,
        consumedAt: null,
        expiresAt: { gt: now },
      },
      data: { consumedAt: now },
    });
    return result.count === 1;
  }

  /**
   * Record the typed OUTCOME of a TERMINATED attempt (DECISIONS #66).
   * Sets `consumedAt` (if it is not already terminal) + `outcomeCode`, so
   * the attempt leaves the in-flight state exactly once: `PROVISIONED` on
   * the provisioning boundary's success path (after `consume` already
   * marked it terminal — this write only adds the typed code), or a
   * failure code on a terminal failure (this write IS the terminal mark,
   * so the UI's honest state stops being "in flight" and becomes an
   * actionable, retryable failure instead of a permanent spinner).
   *
   * The `startToken` is `@unique`, so the conditional write affects
   * exactly one row; single-USE is still owned by the creator-bound
   * `consume` (this method carries no creator check — it is called only
   * by the completion boundary, which has already verified the creator).
   */
  async recordOutcome(
    startToken: string,
    outcomeCode: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    const result = await db.telegramProvisioningLedger.updateMany({
      where: { startToken },
      data: { consumedAt: now, outcomeCode },
    });
    return result.count === 1;
  }

  /**
   * Record the provisioned connection id on the ledger — provenance only
   * (best-effort: the connection already exists; a failure here never
   * undoes provisioning).
   */
  async recordConnectionId(
    startToken: string,
    connectionId: string,
  ): Promise<void> {
    await db.telegramProvisioningLedger.updateMany({
      where: { startToken },
      data: { connectionId },
    });
  }
}
