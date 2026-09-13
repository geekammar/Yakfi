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
}
