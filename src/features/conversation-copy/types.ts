/**
 * Conversation Copy Registry — types contract (UX-LAB-01A, Slice 1).
 *
 * The canonical, code-only contract for deterministic CUSTOMER-FACING copy
 * (DISC-UX-01). This is PASSIVE infrastructure: it only describes the copy
 * the conversation engine already emits. Nothing imports it at runtime yet
 * (Slice 2+ wires the Founder Conversation Lab to it), so it can never
 * change what a customer sees today.
 *
 * Design rules honored here (from the approved discovery):
 *  - classifications are the DISC-UX-01 set; `NOT_COPY` is intentionally NOT
 *    a registry classification — parser/state markers are excluded from the
 *    registry entirely (see `NOT_COPY_EXCLUSIONS` in `registry.ts`).
 *  - the placeholder vocabulary is the closed DISC-UX-01 set, enforced as a
 *    `const` tuple so a non-approved placeholder is a compile-time error.
 *  - types are `readonly` / `as const` derived unions — no classes, no
 *    framework abstractions, no new dependencies.
 */

// ─── Classification (DISC-UX-01) ─────────────────────────────────────────────

/**
 * EDITABLE_COPY      — plain, placeholder-free customer text the founder may
 *                      reword freely (a greeting acknowledgement, a booking
 *                      failure line, …).
 * EDITABLE_TEMPLATE  — customer text that interpolates approved placeholders
 *                      ({serviceName}, {date}, …). Editable, but a rewording
 *                      must keep the placeholders the engine fills in.
 * PROTECTED_COPY     — handoff / safety copy that must stay non-editable. It
 *                      is the engine's safe-handoff acknowledgment promising
 *                      human follow-up; weakening it would break the safety
 *                      guarantee, so the Lab must not reword it.
 */
export const COPY_CLASSIFICATION_VALUES = [
  "EDITABLE_COPY",
  "EDITABLE_TEMPLATE",
  "PROTECTED_COPY",
] as const;

export type CopyClassification = (typeof COPY_CLASSIFICATION_VALUES)[number];

// ─── Category (the canonical copy families) ──────────────────────────────────

/**
 * The canonical families the discovery established (greeting.*, identity.*,
 * clarify.*, interruption.*, continue.*, booking.*, handoff.*). The booking
 * family splits its outcomes across `booking` (the offer, the confirmations,
 * the booking-request acknowledgments) and `error` (the booking failure /
 * clarification-outcome lines).
 *
 * `channel` (UX-LAB-01A2) is the smallest sensible family for deterministic
 * CHANNEL-LEVEL copy — copy a transport/channel owns outright and emits
 * itself, outside the shared Conversation Engine (e.g. a Telegram `/start`
 * welcome). One family for all channels; there is no per-channel registry.
 */
export const COPY_CATEGORY_VALUES = [
  "greeting",
  "identity",
  "clarification",
  "interruption",
  "continuation",
  "booking",
  "handoff",
  "error",
  "channel",
] as const;

export type CopyCategory = (typeof COPY_CATEGORY_VALUES)[number];

// ─── Placeholder vocabulary (closed DISC-UX-01 set) ──────────────────────────

/**
 * The ONLY placeholders an EDITABLE_TEMPLATE may interpolate. This is the
 * approved discovery set — adding a placeholder here is a design decision,
 * never a registry-authoring accident.
 */
export const PLACEHOLDER_VALUES = [
  "businessName",
  "serviceName",
  "date",
  "startTime",
  "endTime",
  "providerName",
  "candidateNames",
  "maxIndex",
  "offer",
] as const;

export type PlaceholderName = (typeof PLACEHOLDER_VALUES)[number];

// ─── Marker metadata ─────────────────────────────────────────────────────────

/**
 * A PROTECTED SUBSTRING inside an editable entry's default text that the
 * deterministic parser / state-derivation depends on. The customer-facing
 * entry stays editable, but a future rewording MUST retain this substring or
 * the engine's history-derived state breaks silently.
 *
 * Examples (DISC-UX-01 sensitive cases):
 *  - `clarify.date` must keep «يرجى تحديد التاريخ المطلوب» because
 *    `derivePendingClarification` recognizes a pending CLARIFY_DATE by that
 *    exact phrase.
 *  - `booking.offer` must keep «تتوفر المواعيد التالية لخدمة» because the
 *    OFFER_HEADER parser (`booking-selection.ts`) recognizes a presented
 *    offer by that header.
 *
 * `carriedByPlaceholder` marks a marker that lives in the RENDERED VALUE of a
 * placeholder rather than in this entry's own text — e.g. a re-offer message
 * interpolates `{offer}`, whose rendered value is `booking.offer` text and
 * therefore must still carry the offer-header marker. `sourceKey` names the
 * canonical key whose default text is authoritative for the substring.
 */
export type CopyMarker = {
  /** Stable marker id (e.g. `clarify.date.pending-date-phrase`). */
  readonly id: string;
  /** The substring that must survive any rewording. */
  readonly substring: string;
  /** Why it must survive (which parser / derivation depends on it). */
  readonly reason: string;
  /** When set, the substring is carried by this placeholder's rendered value. */
  readonly carriedByPlaceholder?: PlaceholderName;
  /** The canonical key whose default text must retain the substring. */
  readonly sourceKey?: string;
};

// ─── Registry entry ──────────────────────────────────────────────────────────

/**
 * Where a canonical default lives in production today. `symbol` is the
 * constant / function / inline site that authors the text; `exported` tells
 * whether an offline check may import it directly (true) or must fall back to
 * a source scan / behavioral mapping (false).
 */
export type CopySource = {
  /** Repo-relative path, e.g. `src/features/conversations/server/clarification.ts`. */
  readonly file: string;
  /** The production symbol, e.g. `CLARIFY_DATE_QUESTION` or `REPLIES.HUMAN_REQUEST`. */
  readonly symbol: string;
  /** Whether the symbol is an importable `export`. */
  readonly exported: boolean;
};

/**
 * ONE canonical customer-facing copy entry. Only metadata the approved design
 * needs — no precedence, no behavior, no runtime concern.
 */
export type CopyRegistryEntry = {
  /** Stable dotted key, e.g. `greeting.invite`. Unique across the registry. */
  readonly key: string;
  /** Canonical family. */
  readonly category: CopyCategory;
  /** Short Arabic human label for the Founder Conversation Lab UI. */
  readonly humanLabel: string;
  /**
   * The current production default. For EDITABLE_TEMPLATE this is the
   * TEMPLATE with `{placeholder}` tokens (not a rendered instance). Preserved
   * byte-for-byte from production — wording improvements happen later
   * (BOOK-UX-01), never in Slice 1.
   */
  readonly defaultText: string;
  readonly classification: CopyClassification;
  /** Placeholders the template interpolates (empty for EDITABLE_COPY / PROTECTED_COPY). */
  readonly placeholders: readonly PlaceholderName[];
  /** Placeholders the engine always fills in (must be a subset of `placeholders`). */
  readonly requiredPlaceholders: readonly PlaceholderName[];
  /** Protected substrings a future rewording must retain. */
  readonly markers?: readonly CopyMarker[];
  /** Where the default lives in production today. */
  readonly source: CopySource;
};
