/**
 * Conversation Copy — PLATFORM OVERRIDE service types (UX-LAB-01C, Slice 3).
 *
 * The typed boundary of the smallest safe persistence layer for the Founder
 * Conversation Lab: optional, PLATFORM-wide published overrides of the
 * deterministic customer-facing copy owned by COPY_REGISTRY.
 *
 * Architecture (binding for this slice):
 *  - CODE DEFAULT + OPTIONAL PLATFORM OVERRIDE. COPY_REGISTRY.defaultText is
 *    the only source of truth; a stored override only ever SHADOWS it.
 *  - Absence of an override row IS the documented "use the code default"
 *    state. RESET removes the row and the code default reappears.
 *  - `resolveStoredCopy` is the ONLY resolution primitive. It never makes a
 *    stored override the sole source of truth and never propagates unsafe
 *    copy: an override that is missing, unreadable, or invalid resolves to
 *    the code default with typed fallback metadata.
 *
 * These types carry NO persistence concern (no Prisma model leaks through);
 * the repository owns the storage projection, the service owns the contract.
 */
import type { CopyValidationFailure } from "@/features/conversation-copy/validation";
import type { CopyOverrideAction } from "@/lib/validation/copy-override";

/** Where a resolved copy text came from. */
export type CopyResolutionSource =
  /** A valid platform override was published for this key. */
  | "PLATFORM_OVERRIDE"
  /** No usable override — the COPY_REGISTRY code default is in effect. */
  | "CODE_DEFAULT";

/**
 * Why resolution returned the code default. Typed metadata for internal
 * diagnosis/telemetry only — it is never composed into customer copy. Every
 * CODE_DEFAULT resolution carries exactly one of these, so the consumer can
 * distinguish "nothing published yet" from "a published override is being
 * ignored" from "the store could not be read".
 */
export type CopyResolutionFallbackReason =
  /** No override row exists for this key (the normal, documented default state). */
  | "NO_OVERRIDE"
  /** A stored override exists but fails TODAY'S UX-LAB-01B contract (corrupted / stale / registry changed). */
  | "INVALID_STORED_OVERRIDE"
  /** The override store could not be read (transient persistence failure). */
  | "PERSISTENCE_UNAVAILABLE";

/** A successful resolution — always safe, renderable text. */
export type CopyResolutionSuccess = {
  ok: true;
  readonly key: string;
  /** The resolved text: a valid override, or the code default. */
  readonly text: string;
  readonly source: CopyResolutionSource;
  /** Always present when `source` is CODE_DEFAULT: which resolution branch produced the default. */
  readonly fallbackReason?: CopyResolutionFallbackReason;
  /**
   * Typed diagnostic for an INVALID_STORED_OVERRIDE fallback (the UX-LAB-01B
   * failure code + message). Lets the Lab surface "this stored override is
   * being ignored and why" without ever emitting the unsafe text.
   */
  readonly validationFailure?: CopyValidationFailure;
};

/**
 * A resolution failure. Only one shape exists: an unknown copy key has NO
 * code default to fall back to, so it is a typed programming error rather
 * than a silent empty string. This is what keeps the fallback honest — the
 * fallback target always concretely exists.
 */
export type CopyResolutionFailure = {
  ok: false;
  readonly code: "UNKNOWN_COPY_KEY";
  readonly message: string;
};

export type CopyResolutionResult =
  CopyResolutionSuccess | CopyResolutionFailure;

/** A published override as displayed/edited by the Founder Lab (storage-safe). */
export type CopyOverrideView = {
  id: string;
  copyKey: string;
  /** The published template text (placeholders preserved, unrendered). */
  text: string;
  /** The Platform Operator who last published it, when known. */
  actorId: string | null;
  updatedAt: string;
};

/** One bounded history/audit row (rollback support). */
export type CopyOverrideHistoryItem = {
  id: string;
  copyKey: string;
  action: CopyOverrideAction;
  /** Text effective BEFORE the change (null ⇒ code default was active). */
  previousText: string | null;
  /** Text effective AFTER the change (null ⇒ override removed). */
  resultText: string | null;
  actorId: string | null;
  createdAt: string;
};

// ── Service success payloads ────────────────────────────────────────────────

export type GetOverrideSuccess = {
  /** The published override, or null when none exists (code default in effect). */
  override: CopyOverrideView | null;
};

export type SaveOverrideSuccess = {
  override: CopyOverrideView;
};

export type ResetOverrideSuccess = {
  /** The override that was removed, or null when there was nothing to reset. */
  removed: CopyOverrideView | null;
};

export type ListOverrideHistorySuccess = {
  items: CopyOverrideHistoryItem[];
};

export type RestoreOverrideSuccess = {
  override: CopyOverrideView;
};

// ── Service failure vocabulary + result envelope ─────────────────────────────

/**
 * The service's typed failure codes. Deliberately a COPY-DOMAIN vocabulary
 * (not the Platform Control Plane's PlatformErrorCode): the override store
 * is its own bounded service and its failures — a PROTECTED_COPY refused, an
 * unknown key, a missing history row — are meaningful only to the Founder
 * Lab, never to the platform operator's other surfaces.
 */
export type CopyOverrideErrorCode =
  /** The actor is not a Platform Operator (writes are platform-only). */
  | "FORBIDDEN"
  /** The key is not in COPY_REGISTRY (nothing can be published to it). */
  | "UNKNOWN_COPY_KEY"
  /** The candidate failed the UX-LAB-01B validation contract. */
  | "INVALID_COPY"
  /** The history row to restore does not exist (or belongs to another key). */
  | "HISTORY_ENTRY_NOT_FOUND"
  /** The override store could not be read or written. */
  | "PERSISTENCE_FAILED";

export type CopyOverrideServiceError = {
  readonly code: CopyOverrideErrorCode;
  readonly message: string;
  /**
   * The typed UX-LAB-01B failure when `code` is INVALID_COPY — a stable
   * machine code the Lab UI maps to guidance (never to a retry).
   */
  readonly validationFailure?: CopyValidationFailure;
};

/**
 * The service result envelope. Same discriminated-union shape the Platform
 * Control Plane services use (success carries data; failure carries a typed
 * error), so the Lab UI's result handling is uniform — but with the copy
 * domain's own failure vocabulary.
 */
export type CopyOverrideServiceResult<T> =
  | { success: true; data: T }
  | { success: false; error: CopyOverrideServiceError };
