import type {
  CopyOverrideAction,
  ListCopyOverrideHistoryDto,
  RecordCopyOverrideHistoryDto,
  SaveCopyOverrideDto,
} from "@/lib/validation/copy-override";
import {
  copyOverrideActionSchema,
  listCopyOverrideHistoryDtoSchema,
  recordCopyOverrideHistoryDtoSchema,
  saveCopyOverrideDtoSchema,
} from "@/lib/validation/copy-override";
import { db } from "@/server/db";

/**
 * Platform-wide published conversation-copy overrides (UX-LAB-01C).
 *
 * The ONE storage boundary for the Founder Conversation Lab's published
 * overrides. It is deliberately NOT a CMS: there is no draft state, no
 * approval workflow, no branching, no A/B, and NO business/tenant scoping —
 * every row is a PLATFORM-level published override for one canonical copy
 * key. Absence of a row is the documented "use the code default" state;
 * RESET is a row removal that reveals the code default again.
 *
 * Repository rules (unchanged from the layer convention): validated DTOs in,
 * typed records out. The repository validates the STORAGE SHAPE only. The
 * semantic UX-LAB-01B copy contract (`validateCopyCandidate`) is enforced by
 * the override service before any write reaches this layer, so a stored row
 * is trusted by construction. No Prisma access outside this layer.
 *
 * History is append-only and bounded per key
 * (`COPY_OVERRIDE_HISTORY_RETENTION`): enough for Founder-Lab rollback, not
 * a version-control system.
 */

/**
 * The bounded number of history rows retained per copy key. Each published
 * change appends one row; the oldest rows past this bound are pruned per
 * key so the audit table stays small and predictable.
 */
export const COPY_OVERRIDE_HISTORY_RETENTION = 50;

/** A published-override row projected for the service boundary. */
export type CopyOverrideRecord = {
  id: string;
  copyKey: string;
  text: string;
  actorId: string | null;
  createdAt: string;
  updatedAt: string;
};

/** One append-only history row projected for the service boundary. */
export type CopyOverrideHistoryRecord = {
  id: string;
  copyKey: string;
  action: CopyOverrideAction;
  previousText: string | null;
  resultText: string | null;
  actorId: string | null;
  createdAt: string;
};

function toOverrideRecord(row: {
  id: string;
  copyKey: string;
  text: string;
  updatedById: string | null;
  createdAt: Date;
  updatedAt: Date;
}): CopyOverrideRecord {
  return {
    id: row.id,
    copyKey: row.copyKey,
    text: row.text,
    actorId: row.updatedById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toHistoryRecord(row: {
  id: string;
  copyKey: string;
  action: string;
  previousText: string | null;
  resultText: string | null;
  actorId: string | null;
  createdAt: Date;
}): CopyOverrideHistoryRecord {
  return {
    id: row.id,
    copyKey: row.copyKey,
    // Fail safe: an unknown/legacy stored action yields a typed PUBLISH,
    // never an untyped string leaking into the service boundary. The Zod
    // parse on write keeps the vocabulary closed, so this is defense in
    // depth for rows written outside the current code path.
    action: (copyOverrideActionSchema.safeParse(row.action).data ??
      "PUBLISH") as CopyOverrideAction,
    previousText: row.previousText,
    resultText: row.resultText,
    actorId: row.actorId,
    createdAt: row.createdAt.toISOString(),
  };
}

export class CopyOverrideRepository {
  /**
   * The currently published override for one canonical key, or null when no
   * override exists (the documented "use the code default" state). This is
   * the ONLY read the resolution path needs.
   */
  async getPublished(copyKey: string): Promise<CopyOverrideRecord | null> {
    const row = await db.platformCopyOverride.findUnique({
      where: { copyKey },
    });
    return row ? toOverrideRecord(row) : null;
  }

  /**
   * Publish (or republish) the override for one key. The service layer has
   * already validated the text against the UX-LAB-01B contract; this method
   * re-validates the storage shape only (defense in depth, per the layer
   * convention).
   */
  async save(input: SaveCopyOverrideDto): Promise<CopyOverrideRecord> {
    const parsed = saveCopyOverrideDtoSchema.parse(input);
    const row = await db.platformCopyOverride.upsert({
      where: { copyKey: parsed.copyKey },
      create: {
        copyKey: parsed.copyKey,
        text: parsed.text,
        updatedById: parsed.actorId ?? null,
      },
      update: {
        text: parsed.text,
        updatedById: parsed.actorId ?? null,
      },
    });
    return toOverrideRecord(row);
  }

  /**
   * Remove the published override for one key — RESET. Reveals the code
   * default again. Idempotent: resetting a key with no stored override is a
   * no-op (still returns the previous record when something was removed).
   */
  async remove(copyKey: string): Promise<CopyOverrideRecord | null> {
    const existing = await db.platformCopyOverride.findUnique({
      where: { copyKey },
    });
    if (!existing) return null;
    await db.platformCopyOverride.delete({ where: { copyKey } });
    return toOverrideRecord(existing);
  }

  /**
   * Append one bounded history row describing a key transition, then prune
   * the oldest rows past the per-key retention bound. Never throws into the
   * caller's publish path: history is best-effort audit, so a failure here
   * must not undo a successfully published override.
   */
  async recordHistory(
    input: RecordCopyOverrideHistoryDto,
  ): Promise<CopyOverrideHistoryRecord | null> {
    const parsed = recordCopyOverrideHistoryDtoSchema.parse(input);
    try {
      const row = await db.platformCopyOverrideHistory.create({
        data: {
          copyKey: parsed.copyKey,
          action: parsed.action,
          previousText: parsed.previousText ?? null,
          resultText: parsed.resultText ?? null,
          actorId: parsed.actorId ?? null,
        },
      });
      await this.trimHistory(parsed.copyKey);
      return toHistoryRecord(row);
    } catch {
      // Audit-only: a history write failure is surfaced to the caller as a
      // null record, never as a thrown error that would roll back an
      // already-committed override.
      return null;
    }
  }

  /**
   * Bounded, newest-first history read for one key (rollback support).
   */
  async listHistory(
    input: ListCopyOverrideHistoryDto,
  ): Promise<CopyOverrideHistoryRecord[]> {
    const parsed = listCopyOverrideHistoryDtoSchema.parse(input);
    const rows = await db.platformCopyOverrideHistory.findMany({
      where: { copyKey: parsed.copyKey },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: parsed.limit,
    });
    return rows.map(toHistoryRecord);
  }

  /**
   * Read one history row by id (the restore path needs the exact previous /
   * resulting value). Returns null when the row does not exist.
   */
  async findHistoryById(id: string): Promise<CopyOverrideHistoryRecord | null> {
    const row = await db.platformCopyOverrideHistory.findUnique({
      where: { id },
    });
    return row ? toHistoryRecord(row) : null;
  }

  /**
   * Prune the oldest history rows beyond the per-key retention bound. Kept
   * simple and bounded on purpose: this is rollback support, not a
   * version-control system.
   */
  private async trimHistory(copyKey: string): Promise<void> {
    const kept = await db.platformCopyOverrideHistory.findMany({
      where: { copyKey },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: COPY_OVERRIDE_HISTORY_RETENTION,
      select: { id: true },
    });
    if (kept.length < COPY_OVERRIDE_HISTORY_RETENTION) return;
    await db.platformCopyOverrideHistory.deleteMany({
      where: {
        copyKey,
        id: { notIn: kept.map((row) => row.id) },
      },
    });
  }
}
