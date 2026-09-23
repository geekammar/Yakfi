import type {
  AttentionReason,
  OpenAttentionDto,
  ResolveAttentionDto,
} from "@/lib/validation";
import { operatorAttentionValidation } from "@/lib/validation";
import { db } from "@/server/db";
import type { OperatorAttention } from "@/types/domain";

/**
 * Operator attention persistence (PROMPT-B04) — the notification layer on
 * the EXISTING NEED_HUMAN / AI_HANDOFF handoff.
 *
 * Repository rules (unchanged from the layer convention): validated DTOs in,
 * typed models out; tenant scope is always a server-derived `businessId`;
 * one row per conversation (`conversation_id` UNIQUE) so the open operation
 * is structurally idempotent. No Prisma access outside this layer.
 */

/** An attention row that is still OPEN (the operator has not acknowledged it). */
export type OpenAttention = {
  id: string;
  conversationId: string;
  reason: AttentionReason;
  createdAt: string;
};

function toOpenAttention(row: OperatorAttention): OpenAttention {
  return {
    id: row.id,
    conversationId: row.conversationId,
    reason: row.reason as AttentionReason,
    createdAt: row.createdAt.toISOString(),
  };
}

export class OperatorAttentionRepository {
  /**
   * Idempotently open operator attention for a conversation.
   *
   * ONE row per conversation: an already-open handoff refreshes the same row
   * (new reason + timestamp); a resolved one is re-opened. A stuck thread
   * receiving many inbound messages therefore produces exactly ONE live
   * alert, never a storm. `businessId` is always the server-derived tenant
   * scope — never client input.
   */
  async open(input: OpenAttentionDto): Promise<OpenAttention> {
    const parsed = operatorAttentionValidation.open.parse(input);
    const now = new Date();
    const row = await db.operatorAttention.upsert({
      where: { conversationId: parsed.conversationId },
      create: {
        businessId: parsed.businessId,
        conversationId: parsed.conversationId,
        reason: parsed.reason,
        createdAt: now,
        resolvedAt: null,
        resolvedById: null,
      },
      update: {
        // Re-open / refresh: a new unresolved handoff supersedes any prior
        // acknowledgment state for this conversation.
        reason: parsed.reason,
        createdAt: now,
        resolvedAt: null,
        resolvedById: null,
      },
    });
    return toOpenAttention(row);
  }

  /**
   * Resolve (acknowledge) the open attention for a conversation —
   * server-authorized only: the caller proves the actor's business owns the
   * thread before calling. No-op when there is no open attention.
   */
  async resolve(input: ResolveAttentionDto): Promise<void> {
    const parsed = operatorAttentionValidation.resolve.parse(input);
    await db.operatorAttention.updateMany({
      where: {
        conversationId: parsed.conversationId,
        resolvedAt: null,
      },
      data: {
        resolvedAt: new Date(),
        resolvedById: parsed.resolvedById,
      },
    });
  }

  /** Resolve any open attention for a conversation (no actor recorded). */
  async resolveByConversation(conversationId: string): Promise<void> {
    await db.operatorAttention.updateMany({
      where: { conversationId, resolvedAt: null },
      data: { resolvedAt: new Date() },
    });
  }

  /** Count OPEN (unacknowledged) attentions for a business — the badge count. */
  async countOpen(businessId: string): Promise<number> {
    return db.operatorAttention.count({
      where: { businessId, resolvedAt: null },
    });
  }

  /** The open attention for a conversation, if any (null when acknowledged). */
  async findOpen(conversationId: string): Promise<OpenAttention | null> {
    const row = await db.operatorAttention.findFirst({
      where: { conversationId, resolvedAt: null },
    });
    return row ? toOpenAttention(row) : null;
  }

  /**
   * OPEN attentions grouped by conversation id — used to mark inbox/queue
   * rows that still need the operator's attention. Tenant-scoped.
   */
  async findOpenByConversations(
    businessId: string,
    conversationIds: string[],
  ): Promise<Map<string, OpenAttention>> {
    if (conversationIds.length === 0) return new Map();
    const rows = await db.operatorAttention.findMany({
      where: {
        businessId,
        resolvedAt: null,
        conversationId: { in: conversationIds },
      },
    });
    return new Map(
      rows.map((row) => [row.conversationId, toOpenAttention(row)]),
    );
  }
}
