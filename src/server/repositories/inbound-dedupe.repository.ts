import { db } from "@/server/db";
import type { InboundMessageDedupe } from "@/types/domain";

/**
 * Inbound webhook idempotency primitives (DECISIONS #34,
 * PROMPT-ARCH-02) — the durable, tenant-scoped dedupe ledger behind the
 * provider-neutral inbound boundary.
 *
 * Contract with the conversation engine:
 * - `claim(businessId, externalKey)` runs BEFORE any irreversible
 *   processing. First delivery → "claimed". Redelivery of an ALREADY
 *   PROCESSED message → "duplicate" (with the recorded ids — the engine
 *   returns an idempotent success, zero side effects). Redelivery of a
 *   message whose previous attempt died BEFORE its customer message was
 *   persisted → "reclaim" (safe to reprocess: the claim's message ids
 *   are written in the SAME transaction as the message insert, so a
 *   claim without ids ⟺ no message row exists).
 * - The engine passes the claim id into
 *   `ConversationRepository.addMessage`, which records the message ids
 *   on the claim inside the message transaction. A concurrent duplicate
 *   that loses that race receives `InboundDuplicateError` and returns
 *   the winner's ids — a retried webhook can never double-write.
 *
 * The external key is provider-neutral: the transport's message id when
 * provided, else a deterministic hash of the canonical payload — always
 * scoped by businessId (tenant-safe).
 */

/** What a claim attempt found. */
export type InboundClaimResult =
  /** Fresh claim — proceed with processing, pass claimId to addMessage. */
  | { status: "claimed"; claimId: string }
  /** Already processed — idempotent duplicate, zero side effects. */
  | {
      status: "duplicate";
      claimId: string;
      conversationId: string | null;
      customerMessageId: string | null;
    }
  /**
   * Previous attempt crashed before persisting the customer message —
   * no message row exists; safe to reprocess with THIS claimId.
   */
  | { status: "reclaim"; claimId: string };

/**
 * Thrown by `ConversationRepository.addMessage` when a concurrent
 * duplicate already recorded a customer message for the claim — the
 * transaction rolls back (no message written) and the engine returns
 * the winner's ids. Carries the winner's provenance.
 */
export class InboundDuplicateError extends Error {
  readonly conversationId: string | null;
  readonly customerMessageId: string | null;

  constructor(provenance: {
    conversationId: string | null;
    customerMessageId: string | null;
  }) {
    super("INBOUND_DUPLICATE");
    this.name = "InboundDuplicateError";
    this.conversationId = provenance.conversationId;
    this.customerMessageId = provenance.customerMessageId;
  }
}

export class InboundDedupeRepository {
  /** Claim an external message key for a Business (before processing). */
  async claim(
    businessId: string,
    externalKey: string,
  ): Promise<InboundClaimResult> {
    try {
      const claim = await db.inboundMessageDedupe.create({
        data: { businessId, externalKey },
        select: { id: true },
      });
      return { status: "claimed", claimId: claim.id };
    } catch (error) {
      // Unique violation → an earlier attempt claimed this key.
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        (error as { code?: unknown }).code !== "P2002"
      ) {
        throw error;
      }
    }
    const existing = await this.findByBusinessAndKey(businessId, externalKey);
    if (!existing) {
      // Lost the insert race but the row vanished (business cascade in
      // flight) — treat as a fresh claim attempt failure.
      throw new Error("INBOUND_CLAIM_LOST");
    }
    if (existing.customerMessageId) {
      return {
        status: "duplicate",
        claimId: existing.id,
        conversationId: existing.conversationId,
        customerMessageId: existing.customerMessageId,
      };
    }
    return { status: "reclaim", claimId: existing.id };
  }

  async findByBusinessAndKey(
    businessId: string,
    externalKey: string,
  ): Promise<InboundMessageDedupe | null> {
    return db.inboundMessageDedupe.findUnique({
      where: { businessId_externalKey: { businessId, externalKey } },
    });
  }
}
