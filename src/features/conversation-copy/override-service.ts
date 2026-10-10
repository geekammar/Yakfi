/**
 * Conversation Copy — PLATFORM OVERRIDE service (UX-LAB-01C, Slice 3).
 *
 * The smallest safe persistence layer for the Founder Conversation Lab: an
 * optional, PLATFORM-wide published override of the deterministic
 * customer-facing copy owned by COPY_REGISTRY.
 *
 * Resolution hierarchy (binding):
 *
 *     VALID PLATFORM OVERRIDE  →  use the override
 *     otherwise                →  COPY_REGISTRY.defaultText (code default)
 *
 * The code default is ALWAYS the fallback and is NEVER made dependent on the
 * database: an override that is absent, unreadable, or fails TODAY'S
 * validation contract resolves to the code default, and the resolution
 * returns typed metadata describing which fallback happened (never the
 * unsafe text). An unknown key has no code default, so it is a typed
 * UNKNOWN_COPY_KEY failure rather than a silent empty string.
 *
 * Validation: every write passes the existing UX-LAB-01B contract via
 * `validateCopyCandidate`. The rules are NOT duplicated here — the registry's
 * own metadata stays the single source of the copy contract, and this
 * service is its only persistence consumer.
 *
 * BOUNDARY (critical): this service is NOT wired into any production
 * customer reply path. It is an isolated service primitive consumed only by
 * its own offline checks now, and by the Founder Lab UI (UX-LAB-01D) /
 * runtime wiring (UX-LAB-01E) later. Nothing in this module imports or
 * touches a delivery path, and no delivery path imports it.
 */
import type {
  CopyOverrideErrorCode,
  CopyOverrideHistoryItem,
  CopyOverrideServiceResult,
  CopyResolutionResult,
  GetOverrideSuccess,
  ListOverrideHistorySuccess,
  ResetOverrideSuccess,
  RestoreOverrideSuccess,
  SaveOverrideSuccess,
} from "@/features/conversation-copy/override-types";
import {
  getCopyEntry,
  getDefaultText,
} from "@/features/conversation-copy/registry";
import { validateCopyCandidate } from "@/features/conversation-copy/validation";
import type { CopyValidationFailureCode } from "@/features/conversation-copy/validation";
import type {
  ListCopyOverrideHistoryDto,
  RecordCopyOverrideHistoryDto,
  SaveCopyOverrideDto,
} from "@/lib/validation/copy-override";
import { copyOverrideRepository } from "@/server/repositories";
import type {
  CopyOverrideHistoryRecord,
  CopyOverrideRecord,
} from "@/server/repositories/copy-override.repository";

/**
 * Authorization context for an override write — a Platform Operator
 * (server-derived, never client-supplied). Mirrors the Platform Control
 * Plane actor shape so the Lab's future server action reuses one guard.
 */
export type CopyOverrideActor = {
  userId: string;
  accountType: string;
};

/** Narrow repository surface (injectable, so offline checks use fakes). */
export type CopyOverrideServiceDeps = Readonly<{
  getPublished: (copyKey: string) => Promise<CopyOverrideRecord | null>;
  save: (input: SaveCopyOverrideDto) => Promise<CopyOverrideRecord>;
  remove: (copyKey: string) => Promise<CopyOverrideRecord | null>;
  recordHistory: (
    input: RecordCopyOverrideHistoryDto,
  ) => Promise<CopyOverrideHistoryRecord | null>;
  listHistory: (
    input: ListCopyOverrideHistoryDto,
  ) => Promise<CopyOverrideHistoryRecord[]>;
  findHistoryById: (id: string) => Promise<CopyOverrideHistoryRecord | null>;
}>;

const defaultDeps: CopyOverrideServiceDeps = {
  getPublished: (copyKey) => copyOverrideRepository.getPublished(copyKey),
  save: (input) => copyOverrideRepository.save(input),
  remove: (copyKey) => copyOverrideRepository.remove(copyKey),
  recordHistory: (input) => copyOverrideRepository.recordHistory(input),
  listHistory: (input) => copyOverrideRepository.listHistory(input),
  findHistoryById: (id) => copyOverrideRepository.findHistoryById(id),
};

function toView(record: CopyOverrideRecord) {
  return {
    id: record.id,
    copyKey: record.copyKey,
    text: record.text,
    actorId: record.actorId,
    updatedAt: record.updatedAt,
  };
}

function toHistoryItem(
  record: CopyOverrideHistoryRecord,
): CopyOverrideHistoryItem {
  return {
    id: record.id,
    copyKey: record.copyKey,
    action: record.action,
    previousText: record.previousText,
    resultText: record.resultText,
    actorId: record.actorId,
    createdAt: record.createdAt,
  };
}

/** Narrow a UX-LAB-01B failure into the typed diagnostic the service reports. */
function toValidationFailure(result: {
  readonly code: CopyValidationFailureCode;
  readonly message: string;
}) {
  return { ok: false as const, code: result.code, message: result.message };
}

/** Map a UX-LAB-01B failure code to this service's typed error code. */
function toErrorCode(code: CopyValidationFailureCode): CopyOverrideErrorCode {
  return code === "UNKNOWN_COPY_KEY" ? "UNKNOWN_COPY_KEY" : "INVALID_COPY";
}

/**
 * THE resolution primitive: the CODE DEFAULT + OPTIONAL PLATFORM OVERRIDE
 * hierarchy for one key.
 *
 * Never throws, never returns unsafe text:
 *  - unknown key → typed UNKNOWN_COPY_KEY (there is no default to fall to);
 *  - persistence read failure → code default (PERSISTENCE_UNAVAILABLE);
 *  - no stored override → code default (NO_OVERRIDE);
 *  - stored override that fails TODAY'S contract → code default
 *    (INVALID_STORED_OVERRIDE) with the typed UX-LAB-01B failure attached;
 *  - a valid stored override → the override.
 *
 * The fallback boundary is explicit and narrow: only the persistence READ is
 * guarded, so a database outage degrades to the code default while a genuine
 * programmer error elsewhere still surfaces.
 */
export async function resolveStoredCopy(
  key: string,
  deps: CopyOverrideServiceDeps = defaultDeps,
): Promise<CopyResolutionResult> {
  const entry = getCopyEntry(key);
  if (entry === null) {
    return {
      ok: false,
      code: "UNKNOWN_COPY_KEY",
      message: `Unknown copy key: ${key}`,
    };
  }
  const defaultText = entry.defaultText;

  let stored: CopyOverrideRecord | null;
  try {
    stored = await deps.getPublished(key);
  } catch {
    // Database/persistence failure must NOT make the copy layer unavailable.
    return {
      ok: true,
      key,
      text: defaultText,
      source: "CODE_DEFAULT",
      fallbackReason: "PERSISTENCE_UNAVAILABLE",
    };
  }

  if (stored === null) {
    // Absence IS the documented "use the code default" state. It is reported
    // as a first-class fallback reason so the Lab can tell "nothing has been
    // published for this key yet" apart from "a published override is being
    // ignored" (INVALID_STORED_OVERRIDE) or "the store is down"
    // (PERSISTENCE_UNAVAILABLE).
    return {
      ok: true,
      key,
      text: defaultText,
      source: "CODE_DEFAULT",
      fallbackReason: "NO_OVERRIDE",
    };
  }

  // A stored override is only trusted if it passes the contract AS IT STANDS
  // TODAY. A registry evolution (new required placeholder, reclassification,
  // a marker added…) can make a previously-valid override invalid; such a row
  // is never propagated to a customer — the code default wins, and the typed
  // failure is reported for internal diagnosis.
  const revalidated = validateCopyCandidate(key, stored.text);
  if (!revalidated.ok) {
    return {
      ok: true,
      key,
      text: defaultText,
      source: "CODE_DEFAULT",
      fallbackReason: "INVALID_STORED_OVERRIDE",
      validationFailure: toValidationFailure(revalidated),
    };
  }

  return { ok: true, key, text: stored.text, source: "PLATFORM_OVERRIDE" };
}

/**
 * The currently published override for one key, or null when none exists
 * (the documented "use the code default" state). This is the Lab's read of
 * WHAT is stored, before any fallback decision — resolution is
 * `resolveStoredCopy`. Unknown keys are rejected (nothing can be stored
 * against them).
 */
export async function getPublishedOverride(
  key: string,
  deps: CopyOverrideServiceDeps = defaultDeps,
): Promise<CopyOverrideServiceResult<GetOverrideSuccess>> {
  if (getCopyEntry(key) === null) {
    return {
      success: false,
      error: {
        code: "UNKNOWN_COPY_KEY",
        message: `Unknown copy key: ${key}`,
      },
    };
  }
  try {
    const stored = await deps.getPublished(key);
    return {
      success: true,
      data: { override: stored ? toView(stored) : null },
    };
  } catch {
    return {
      success: false,
      error: {
        code: "PERSISTENCE_FAILED",
        message: "تعذر قراءة تعديل النص المنشور",
      },
    };
  }
}

/**
 * Publish a founder-edited override for one key. Platform Operator only.
 *
 * The text passes the existing UX-LAB-01B contract (`validateCopyCandidate`)
 * FIRST — validation is never duplicated, and an invalid candidate is
 * rejected before any write. Only then are the store + audit written.
 */
export async function savePublishedOverride(
  actor: CopyOverrideActor,
  key: string,
  text: unknown,
  deps: CopyOverrideServiceDeps = defaultDeps,
): Promise<CopyOverrideServiceResult<SaveOverrideSuccess>> {
  if (actor.accountType !== "PLATFORM") {
    return {
      success: false,
      error: {
        code: "FORBIDDEN",
        message: "هذه الصلاحية متاحة لمشغل المنصة فقط",
      },
    };
  }

  const validated = validateCopyCandidate(key, text);
  if (!validated.ok) {
    return {
      success: false,
      error: {
        code: toErrorCode(validated.code),
        message: validated.message,
        validationFailure: toValidationFailure(validated),
      },
    };
  }

  try {
    const previous = await deps.getPublished(key);
    const saved = await deps.save({
      copyKey: key,
      text: validated.text,
      actorId: actor.userId,
    });
    // Lightweight audit: what changed, from what, by whom. Best-effort — a
    // history write failure never rolls back a committed override.
    await deps.recordHistory({
      copyKey: key,
      action: "PUBLISH",
      previousText: previous?.text ?? null,
      resultText: saved.text,
      actorId: actor.userId,
    });
    return { success: true, data: { override: toView(saved) } };
  } catch {
    return {
      success: false,
      error: {
        code: "PERSISTENCE_FAILED",
        message: "تعذر حفظ تعديل النص الآن",
      },
    };
  }
}

/**
 * Reset one key: REMOVE the published override, so the code default is in
 * effect again. Platform Operator only. Idempotent — resetting a key that
 * has no override still succeeds and reports `removed: null`. The removal
 * itself is audited as a RESET transition.
 */
export async function resetPublishedOverride(
  actor: CopyOverrideActor,
  key: string,
  deps: CopyOverrideServiceDeps = defaultDeps,
): Promise<CopyOverrideServiceResult<ResetOverrideSuccess>> {
  if (actor.accountType !== "PLATFORM") {
    return {
      success: false,
      error: {
        code: "FORBIDDEN",
        message: "هذه الصلاحية متاحة لمشغل المنصة فقط",
      },
    };
  }
  if (getCopyEntry(key) === null) {
    return {
      success: false,
      error: {
        code: "UNKNOWN_COPY_KEY",
        message: `Unknown copy key: ${key}`,
      },
    };
  }

  try {
    const removed = await deps.remove(key);
    if (removed === null) {
      // Nothing was stored: the code default was already in effect.
      return { success: true, data: { removed: null } };
    }
    await deps.recordHistory({
      copyKey: key,
      action: "RESET",
      previousText: removed.text,
      resultText: null,
      actorId: actor.userId,
    });
    return { success: true, data: { removed: toView(removed) } };
  } catch {
    return {
      success: false,
      error: {
        code: "PERSISTENCE_FAILED",
        message: "تعذر إزالة تعديل النص الآن",
      },
    };
  }
}

/**
 * Bounded, newest-first history for one key — the rollback support surface.
 * Platform Operator only (audit data is operator-visible).
 */
export async function listOverrideHistory(
  actor: CopyOverrideActor,
  key: string,
  limit = 25,
  deps: CopyOverrideServiceDeps = defaultDeps,
): Promise<CopyOverrideServiceResult<ListOverrideHistorySuccess>> {
  if (actor.accountType !== "PLATFORM") {
    return {
      success: false,
      error: {
        code: "FORBIDDEN",
        message: "هذه الصلاحية متاحة لمشغل المنصة فقط",
      },
    };
  }
  if (getCopyEntry(key) === null) {
    return {
      success: false,
      error: {
        code: "UNKNOWN_COPY_KEY",
        message: `Unknown copy key: ${key}`,
      },
    };
  }
  try {
    const rows = await deps.listHistory({ copyKey: key, limit });
    return {
      success: true,
      data: { items: rows.map(toHistoryItem) },
    };
  } catch {
    return {
      success: false,
      error: {
        code: "PERSISTENCE_FAILED",
        message: "تعذر قراءة سجل التعديلات",
      },
    };
  }
}

/**
 * Restore a historical value: re-publish the text a history row recorded,
 * re-validated against TODAY'S UX-LAB-01B contract (a value that was valid
 * when published may have since become invalid — it is restored only if it
 * is still safe). Platform Operator only.
 *
 * Restoring a RESET row (`resultText === null`) re-creates the override from
 * the row's `previousText` — i.e. it undoes the reset. If that previous text
 * is no longer valid, the restore is refused with a typed INVALID_COPY.
 */
export async function restoreOverride(
  actor: CopyOverrideActor,
  historyId: string,
  deps: CopyOverrideServiceDeps = defaultDeps,
): Promise<CopyOverrideServiceResult<RestoreOverrideSuccess>> {
  if (actor.accountType !== "PLATFORM") {
    return {
      success: false,
      error: {
        code: "FORBIDDEN",
        message: "هذه الصلاحية متاحة لمشغل المنصة فقط",
      },
    };
  }

  let row: CopyOverrideHistoryRecord | null;
  try {
    row = await deps.findHistoryById(historyId);
  } catch {
    return {
      success: false,
      error: {
        code: "PERSISTENCE_FAILED",
        message: "تعذر قراءة سجل التعديلات",
      },
    };
  }
  if (row === null) {
    return {
      success: false,
      error: {
        code: "HISTORY_ENTRY_NOT_FOUND",
        message: "تعديل سجل غير موجود",
      },
    };
  }

  // A restore target is always the text that should become effective. For a
  // PUBLISH/RESTORE row that is its resultText; for a RESET row it is the
  // previousText the reset removed.
  const target = row.resultText ?? row.previousText;
  if (target === null) {
    return {
      success: false,
      error: {
        code: "HISTORY_ENTRY_NOT_FOUND",
        message: "السجل لا يحوي قيمة قابلة للاستعادة",
      },
    };
  }

  // Re-validate against the CURRENT contract — the same rule every publish
  // passes. Never restore an override that would be rejected on write.
  const validated = validateCopyCandidate(row.copyKey, target);
  if (!validated.ok) {
    return {
      success: false,
      error: {
        code: toErrorCode(validated.code),
        message: validated.message,
        validationFailure: toValidationFailure(validated),
      },
    };
  }

  try {
    const previous = await deps.getPublished(row.copyKey);
    const saved = await deps.save({
      copyKey: row.copyKey,
      text: validated.text,
      actorId: actor.userId,
    });
    await deps.recordHistory({
      copyKey: row.copyKey,
      action: "RESTORE",
      previousText: previous?.text ?? null,
      resultText: saved.text,
      actorId: actor.userId,
    });
    return { success: true, data: { override: toView(saved) } };
  } catch {
    return {
      success: false,
      error: {
        code: "PERSISTENCE_FAILED",
        message: "تعذر استعادة التعديل الآن",
      },
    };
  }
}

/**
 * The code default for one key — the value resolution falls back to. Exposed
 * for the Lab UI's "reset reveals this again" preview without touching the
 * store. Unknown keys yield null (there is no default).
 */
export function codeDefaultFor(key: string): string | null {
  return getDefaultText(key);
}
