import type {
  KnowledgeGapCategory,
  KnowledgeGapStatus,
  ListKnowledgeGapsDto,
  RecordKnowledgeGapDto,
  ReviewKnowledgeGapDto,
} from "@/lib/validation";
import {
  knowledgeGapValidation,
  parseKnowledgeGapCategory,
  parseKnowledgeGapStatus,
} from "@/lib/validation";
import { db } from "@/server/db";
import type { KnowledgeGap } from "@/types/domain";

/**
 * Knowledge-gap persistence (PROMPT-AI-ARCH-18 — Slice 9).
 *
 * The ONE storage boundary for the record-only knowledge-gap signal. It is
 * deliberately NOT a knowledge store, NOT a queue, NOT a second operator
 * system, and NOT an event bus: it appends bounded, tenant-scoped review rows
 * and exposes a deterministic, tenant-scoped review transition. Nothing here
 * can promote a gap into business knowledge (FAQ / business / service / prompt)
 * — that is a future, explicitly human-approved workflow.
 *
 * Repository rules (unchanged from the layer convention): validated DTOs in,
 * typed records out; tenant scope is always a server-derived `businessId`;
 * cross-tenant reads/writes are structurally impossible because every query
 * filters by `businessId`. No Prisma access outside this layer.
 *
 * The `(conversationId, customerMessageId)` unique key makes recording
 * structurally idempotent per turn: a crash replay of the SAME turn upserts the
 * SAME row (an already-recorded observation is never duplicated, and a human
 * review is never clobbered). A DIFFERENT turn is a different record.
 */

/** A knowledge-gap row projected for the review boundary. */
export type KnowledgeGapRecord = {
  id: string;
  businessId: string;
  conversationId: string;
  customerMessageId: string;
  category: KnowledgeGapCategory | null;
  subjectText: string | null;
  status: KnowledgeGapStatus | null;
  createdAt: string;
  reviewedAt: string | null;
};

function toKnowledgeGapRecord(row: KnowledgeGap): KnowledgeGapRecord {
  return {
    id: row.id,
    businessId: row.businessId,
    conversationId: row.conversationId,
    customerMessageId: row.customerMessageId,
    // Fail safe: an unknown/legacy stored value yields null, never a
    // misleading category/status.
    category: parseKnowledgeGapCategory(row.category),
    subjectText: row.subjectText,
    status: parseKnowledgeGapStatus(row.status),
    createdAt: row.createdAt.toISOString(),
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
  };
}

export class KnowledgeGapRepository {
  /**
   * Append (or idempotently refresh) a knowledge-gap observation. `businessId`
   * is always the server-derived tenant scope — never client input. Best-effort
   * by contract: the caller (the engine's post-turn recorder) swallows any
   * failure so a recording problem can never affect the customer turn.
   */
  async record(input: RecordKnowledgeGapDto): Promise<KnowledgeGapRecord> {
    const parsed = knowledgeGapValidation.record.parse(input);
    const row = await db.knowledgeGap.upsert({
      where: {
        conversationId_customerMessageId: {
          conversationId: parsed.conversationId,
          customerMessageId: parsed.customerMessageId,
        },
      },
      create: {
        businessId: parsed.businessId,
        conversationId: parsed.conversationId,
        customerMessageId: parsed.customerMessageId,
        category: parsed.category,
        subjectText: parsed.subjectText ?? null,
        status: "UNRESOLVED",
      },
      // A replay of the SAME turn is a no-op: the original observation stands
      // and any human review is preserved. `(conversationId,
      // customerMessageId)` is unique, so no duplicate row is ever created.
      update: {},
    });
    return toKnowledgeGapRecord(row);
  }

  /**
   * Deterministic, tenant-scoped review retrieval. Defaults to UNRESOLVED
   * (the human review queue); the caller may narrow by category. Bounded by
   * `limit`. Business A can never see business B's gaps — the `businessId`
   * filter is mandatory.
   */
  async list(input: ListKnowledgeGapsDto): Promise<KnowledgeGapRecord[]> {
    const parsed = knowledgeGapValidation.list.parse(input);
    const rows = await db.knowledgeGap.findMany({
      where: {
        businessId: parsed.businessId,
        ...(parsed.status ? { status: parsed.status } : {}),
        ...(parsed.category ? { category: parsed.category } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: parsed.limit,
    });
    return rows.map(toKnowledgeGapRecord);
  }

  /** Count UNRESOLVED gaps for a business (the operator review badge). */
  async countUnresolved(businessId: string): Promise<number> {
    return db.knowledgeGap.count({
      where: { businessId, status: "UNRESOLVED" },
    });
  }

  /**
   * Mark an UNRESOLVED gap as REVIEWED. Tenant-scoped AND status-guarded: a row
   * in another business, or one already reviewed/rejected, is never touched.
   * Review is terminal — it does NOT promote knowledge, and there is no
   * un-review.
   */
  async markReviewed(input: ReviewKnowledgeGapDto): Promise<void> {
    await this.review(input, "REVIEWED");
  }

  /**
   * Mark an UNRESOLVED gap as REJECTED — an operator decided it is not a real
   * gap. Terminal; it does not promote knowledge and is never retried
   * automatically.
   */
  async markRejected(input: ReviewKnowledgeGapDto): Promise<void> {
    await this.review(input, "REJECTED");
  }

  private async review(
    input: ReviewKnowledgeGapDto,
    status: "REVIEWED" | "REJECTED",
  ): Promise<void> {
    const parsed = knowledgeGapValidation.review.parse(input);
    await db.knowledgeGap.updateMany({
      where: {
        id: parsed.id,
        businessId: parsed.businessId,
        status: "UNRESOLVED",
      },
      data: {
        status,
        reviewedAt: new Date(),
        reviewedById: parsed.reviewedById,
      },
    });
  }
}
