import { usageValidation } from "@/lib/validation";
import { db } from "@/server/db";
import type { UsageRecord } from "@/types/domain";

/**
 * Usage telemetry primitives (DECISIONS #36, PROMPT-ARCH-02) —
 * append-only RAW USAGE FACTS.
 *
 * Hard rules encoded here:
 * - Input is Zod-validated at the boundary (`RecordUsageDto`): ids,
 *   counters, machine keys, status. No message content, no secrets, no
 *   chain-of-thought — the schema strips anything else.
 * - No pricing logic: cost is only ever a caller-supplied point-in-time
 *   snapshot (`estimatedCostMicros`); this layer never computes or
 *   interprets prices. Future pricing models read history, never
 *   rewrite it.
 * - Append-only: no update/delete surface. Rows disappear only via the
 *   Business cascade.
 */
export class UsageRepository {
  /** Records ONE usage fact. Validation failures throw (caller bug). */
  async record(input: unknown): Promise<UsageRecord> {
    const parsed = usageValidation.record.parse(input);
    return db.usageRecord.create({ data: parsed });
  }

  /** Read-side twin for observability (Business-scoped, bounded). */
  async countByBusiness(businessId: string): Promise<number> {
    return db.usageRecord.count({ where: { businessId } });
  }

  /**
   * Read-only delivery outcomes for a conversation's assistant messages.
   *
   * The OUTBOUND_MESSAGE usage record is the existing append-only delivery
   * evidence; it is read here to present truthful per-message delivery state
   * without mutating the immutable Message row. Tenant-scoped by `businessId`
   * and bounded to the caller-supplied message ids. Later records win, so an
   * operator sees the latest recorded outcome for each message id.
   */
  async listOutboundDeliveryStatuses(input: {
    businessId: string;
    conversationId: string;
    messageIds: readonly string[];
  }): Promise<Map<string, "SUCCESS" | "FAILURE">> {
    const messageIds = [...new Set(input.messageIds)];
    if (messageIds.length === 0) return new Map();
    const rows = await db.usageRecord.findMany({
      where: {
        businessId: input.businessId,
        conversationId: input.conversationId,
        kind: "OUTBOUND_MESSAGE",
        messageId: { in: messageIds },
      },
      select: { messageId: true, status: true, occurredAt: true },
      orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }],
    });
    const statuses = new Map<string, "SUCCESS" | "FAILURE">();
    for (const row of rows) {
      if (
        row.messageId &&
        (row.status === "SUCCESS" || row.status === "FAILURE")
      ) {
        statuses.set(row.messageId, row.status);
      }
    }
    return statuses;
  }
}
