import type { Prisma } from "@/generated/prisma/client";

import { db } from "@/server/db";

/**
 * Durable ConversationState persistence (CONV-CORE-01).
 *
 * ONE row per conversation holding the engine-owned state snapshot (JSON,
 * validated by the conversation feature on every load). The repository is a
 * dumb store: it never interprets the state. Two invariants live here:
 *
 * - TENANT SCOPE: every read/write filters by `businessId`; a row whose
 *   business does not match is invisible (load → null, save → conflict).
 * - OPTIMISTIC CONCURRENCY: `save` is a compare-and-swap on `revision`.
 *   Two concurrent turns that loaded the same revision cannot both win —
 *   exactly one save succeeds, the other gets `conflict`. The engine uses
 *   this to CLAIM an offer atomically before any booking write.
 */
export type ConversationStateRow = {
  readonly conversationId: string;
  readonly businessId: string;
  readonly revision: number;
  readonly state: unknown;
  readonly updatedAt: Date;
};

export type ConversationStateSaveResult =
  | { readonly status: "saved"; readonly revision: number }
  | { readonly status: "conflict" };

export class ConversationStateRepository {
  constructor(private readonly prisma: typeof db = db) {}

  async load(
    businessId: string,
    conversationId: string,
  ): Promise<ConversationStateRow | null> {
    const row = await this.prisma.conversationStateRecord.findFirst({
      where: { conversationId, businessId },
    });
    if (!row) return null;
    return {
      conversationId: row.conversationId,
      businessId: row.businessId,
      revision: row.revision,
      state: row.state,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Compare-and-swap save. `expectedRevision === null` means "create the
   * first row"; a concurrent creator loses on the primary key.
   */
  async save(
    businessId: string,
    conversationId: string,
    expectedRevision: number | null,
    state: unknown,
  ): Promise<ConversationStateSaveResult> {
    const json = state as Prisma.InputJsonValue;
    if (expectedRevision === null) {
      try {
        await this.prisma.conversationStateRecord.create({
          data: { conversationId, businessId, revision: 1, state: json },
        });
        return { status: "saved", revision: 1 };
      } catch (error) {
        if (isUniqueViolation(error)) return { status: "conflict" };
        throw error;
      }
    }
    const next = expectedRevision + 1;
    const updated = await this.prisma.conversationStateRecord.updateMany({
      where: { conversationId, businessId, revision: expectedRevision },
      data: { revision: next, state: json },
    });
    return updated.count === 1
      ? { status: "saved", revision: next }
      : { status: "conflict" };
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}
