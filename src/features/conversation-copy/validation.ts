/**
 * Conversation Copy registry — VALIDATION contract (UX-LAB-01B, Slice 2).
 *
 * Pure, dependency-free validation of a CANDIDATE copy text for one registry
 * key: is this text something the Founder Conversation Lab could safely store
 * as an override for this key?
 *
 * Every rule is derived from the registry's own metadata (classification,
 * declared placeholders, required placeholders, protected markers) — there is
 * no hand-maintained duplicate rule set that could drift out of sync.
 *
 * The validator is PASSIVE infrastructure. Nothing in production calls it
 * (the offline `pnpm check:copy-lab` guard proves that), so it can never
 * change what a customer sees today. It never throws: every failure is a
 * returned typed result, so a future caller can fail safely.
 *
 * Design bounds (from the approved discovery):
 *  - max 400 characters — every current registry default fits (the offline
 *    check proves the longest is far below this), so the bound represents
 *    today's defaults without needing to be widened.
 *  - the placeholder vocabulary is the closed PLACEHOLDER_VALUES set; a
 *    candidate may only use placeholders the entry declares.
 *  - protected parser/state markers must survive any rewording, including
 *    markers a placeholder carries indirectly (a rendered `{offer}` value
 *    still has to carry the offer header).
 */
import {
  scanPlaceholderTokens,
  type PlaceholderSyntaxError,
} from "@/features/conversation-copy/placeholders";
import { getCopyEntry } from "@/features/conversation-copy/registry";
import type { PlaceholderName } from "@/features/conversation-copy/types";

/**
 * The maximum character length a founder-edited copy candidate may have.
 * Every current registry default is far below this (see the offline check),
 * so the bound can represent today's defaults exactly.
 */
export const MAX_COPY_LENGTH = 400;

export type CopyValidationFailureCode =
  /** `validateCopyCandidate` was called with a key the registry does not know. */
  | "UNKNOWN_COPY_KEY"
  /** The key is PROTECTED_COPY: visible for a future read-only preview, but not editable. */
  | "PROTECTED_COPY_NOT_EDITABLE"
  /** The candidate is not a string. */
  | "INVALID_TEXT"
  /** The candidate is empty (after trimming). */
  | "EMPTY_TEXT"
  /** The candidate is longer than MAX_COPY_LENGTH characters. */
  | "TEXT_TOO_LONG"
  /** A `{...}` token is not well-formed (`{{date}}`, `{ date }`, `{date`, `date}`). */
  | "MALFORMED_PLACEHOLDER"
  /** A well-formed token whose name is outside the closed vocabulary (`{randomThing}`). */
  | "UNKNOWN_PLACEHOLDER"
  /** A known placeholder this registry entry does not declare. */
  | "PLACEHOLDER_NOT_ALLOWED"
  /** A requiredPlaceholder the candidate dropped. */
  | "MISSING_REQUIRED_PLACEHOLDER"
  /** A protected parser/state marker the candidate removed or corrupted. */
  | "MARKER_REMOVED";

export type CopyValidationSuccess = {
  ok: true;
  readonly key: string;
  /** The validated candidate text, exactly as supplied. */
  readonly text: string;
};

export type CopyValidationFailure = {
  ok: false;
  /** Stable machine code — a founder UI maps it to guidance, never to a retry. */
  readonly code: CopyValidationFailureCode;
  /** English developer text; it names the key/token/marker that failed. */
  readonly message: string;
};

export type CopyValidationResult =
  CopyValidationSuccess | CopyValidationFailure;

/**
 * Validate a candidate copy text for one canonical registry key.
 *
 * Returns `{ ok: true, key, text }` when the text is a legal founder edit for
 * this key, or `{ ok: false, code, message }` — deterministic, and never an
 * exception.
 *
 * Rule order is fixed so the same input always yields the same failure:
 *  1. known key
 *  2. classification (PROTECTED_COPY is not founder-editable)
 *  3. text bounds (a string, non-empty when trimmed, ≤ 400 characters)
 *  4. placeholder syntax (closed vocabulary, well-formed `{name}` tokens only)
 *  5. per-key allowed placeholders
 *  6. required placeholders still present
 *  7. protected markers still present
 */
export function validateCopyCandidate(
  key: string,
  text: unknown,
): CopyValidationResult {
  // 1. Known key — an unknown key is always a failure, never a new entry.
  const entry = getCopyEntry(key);
  if (entry === null) {
    return {
      ok: false,
      code: "UNKNOWN_COPY_KEY",
      message: `Unknown copy key: ${key}`,
    };
  }

  // 2. Classification — PROTECTED_COPY stays visible in the registry (a future
  // read-only preview) but is never accepted as founder-editable copy.
  if (entry.classification === "PROTECTED_COPY") {
    return {
      ok: false,
      code: "PROTECTED_COPY_NOT_EDITABLE",
      message: `${key} is PROTECTED_COPY (safe-handoff copy) and cannot be edited.`,
    };
  }

  // 3. Text bounds.
  if (typeof text !== "string") {
    return {
      ok: false,
      code: "INVALID_TEXT",
      message: `${key}: copy text must be a string.`,
    };
  }
  if (text.trim().length === 0) {
    return {
      ok: false,
      code: "EMPTY_TEXT",
      message: `${key}: copy text must not be empty.`,
    };
  }
  const length = [...text].length;
  if (length > MAX_COPY_LENGTH) {
    return {
      ok: false,
      code: "TEXT_TOO_LONG",
      message: `${key}: copy text is ${length} characters; the maximum is ${MAX_COPY_LENGTH}.`,
    };
  }

  // 4. Placeholder syntax (closed vocabulary + well-formed braces).
  const { tokens, error } = scanPlaceholderTokens(text);
  if (error !== null) {
    return {
      ok: false,
      code: syntaxCode(error),
      message: `${key}: ${syntaxMessage(error)}`,
    };
  }

  // 5. Per-key allowed placeholders — a candidate may only use placeholders
  // this entry declares (`{date}` is not legal for a key that does not
  // declare it).
  const allowed: ReadonlySet<PlaceholderName> = new Set(entry.placeholders);
  for (const token of tokens) {
    if (!allowed.has(token.name)) {
      return {
        ok: false,
        code: "PLACEHOLDER_NOT_ALLOWED",
        message: `${key}: placeholder {${token.name}} is not declared for this copy key (declared: ${
          entry.placeholders.map((p) => `{${p}}`).join(", ") || "none"
        }).`,
      };
    }
  }

  // 6. Required placeholders — a founder must not delete a placeholder the
  // engine's runtime correctness depends on.
  const present = new Set(tokens.map((token) => token.name));
  for (const required of entry.requiredPlaceholders) {
    if (!present.has(required)) {
      return {
        ok: false,
        code: "MISSING_REQUIRED_PLACEHOLDER",
        message: `${key}: required placeholder {${required}} is missing.`,
      };
    }
  }

  // 7. Marker protection — the parser/state substrings a rewording must keep.
  for (const marker of entry.markers ?? []) {
    if (marker.carriedByPlaceholder) {
      // The marker lives in the placeholder's RENDERED VALUE (e.g. a re-offer
      // interpolates {offer}, whose value is `booking.offer` text and so must
      // still carry the offer header). The candidate keeps the marker by
      // keeping the placeholder — it is carried indirectly, so do not require
      // a literal duplicate substring here.
      if (!present.has(marker.carriedByPlaceholder)) {
        return {
          ok: false,
          code: "MARKER_REMOVED",
          message: `${key}: marker «${marker.substring}» is carried by {${marker.carriedByPlaceholder}}; that placeholder must stay in the copy (${marker.reason}).`,
        };
      }
      continue;
    }
    if (!text.includes(marker.substring)) {
      return {
        ok: false,
        code: "MARKER_REMOVED",
        message: `${key}: marker «${marker.substring}» is missing (${marker.reason}).`,
      };
    }
  }

  return { ok: true, key, text };
}

function syntaxCode(error: PlaceholderSyntaxError): CopyValidationFailureCode {
  return error.kind;
}

function syntaxMessage(error: PlaceholderSyntaxError): string {
  if (error.kind === "UNKNOWN_PLACEHOLDER") {
    return `${error.raw} is not an approved placeholder.`;
  }
  return `${error.raw} is not a well-formed {name} placeholder.`;
}
