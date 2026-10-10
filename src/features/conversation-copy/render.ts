/**
 * Conversation Copy registry — RENDER contract (UX-LAB-01B, Slice 2).
 *
 * A small, pure, DETERMINISTIC renderer: it turns one registry key + a map of
 * placeholder values into the exact customer text that key would emit, using
 * the registry's `defaultText` as the canonical default source.
 *
 * What it deliberately is not:
 *  - no database, no overrides, no platform/tenant layer (later slices);
 *  - no provider / LLM / network call;
 *  - no side effects (it never writes, sends, logs into a store, or mutates
 *    shared state);
 *  - no template language: `{name}` tokens are replaced with literal text in
 *    a single left-to-right pass and the result is never rescanned, so a
 *    placeholder VALUE is always data, never syntax (no recursive injection).
 *
 * Like the rest of the registry, this is PASSIVE infrastructure: no
 * production reply path consumes it (the offline `pnpm check:copy-lab` guard
 * proves that), so rendering cannot change what a customer sees today.
 */
import {
  scanPlaceholderTokens,
  substitutePlaceholders,
} from "@/features/conversation-copy/placeholders";
import { getCopyEntry } from "@/features/conversation-copy/registry";

export type CopyRenderFailureCode =
  /** `renderCopy` was called with a key the registry does not know. */
  | "UNKNOWN_COPY_KEY"
  /** A placeholder the entry declares was not supplied a value. */
  | "MISSING_PLACEHOLDER_VALUE"
  /** A declared placeholder could not be resolved (never for a registry default). */
  | "UNRESOLVED_PLACEHOLDER"
  /** The registry default itself is not a clean template (offline check guards this). */
  | "MALFORMED_PLACEHOLDER";

export type CopyRenderSuccess = {
  ok: true;
  /** The fully rendered customer text — no `{placeholder}` token remains. */
  readonly text: string;
};

export type CopyRenderFailure = {
  ok: false;
  readonly code: CopyRenderFailureCode;
  readonly message: string;
  /** The placeholder names that were missing / unresolved, when applicable. */
  readonly placeholders?: readonly string[];
};

export type CopyRenderResult = CopyRenderSuccess | CopyRenderFailure;

/**
 * The shared, pure substitution core: render ONE template `text` for a KNOWN
 * registry key with the supplied placeholder values.
 *
 * `renderCopy(key, values)` is this function applied to the registry default;
 * `renderCopyText(key, candidate, values)` is the same deterministic pass
 * applied to an ARBITRARY template text — the UX-LAB-01D-2 Founder Lab uses it
 * to preview a founder-edited CANDIDATE before it is ever published. There is
 * deliberately NO second substitution implementation anywhere (the Lab's
 * candidate preview and the registry-default render share this one path).
 *
 * Semantics are identical to `renderCopy`:
 *  - only placeholders the entry DECLARES are substituted (an unknown token a
 *    founder types stays literal — a draft is data, never re-scanned);
 *  - a declared placeholder with no supplied value is a typed
 *    MISSING_PLACEHOLDER_VALUE (a value is never invented);
 *  - values are substituted verbatim in one pass and are never rescanned, so
 *    a value may itself contain `{date}`, `{{date}}` or any brace text.
 *
 * Never throws, and has no DB / provider / network dependency: a candidate
 * preview causes zero writes, zero sends and zero customer messages.
 */
export function renderCopyText(
  key: string,
  text: string,
  values: Readonly<Record<string, string | number>> = {},
): CopyRenderResult {
  // A. Known key only — a candidate for an unknown key has no contract.
  const entry = getCopyEntry(key);
  if (entry === null) {
    return {
      ok: false,
      code: "UNKNOWN_COPY_KEY",
      message: `Unknown copy key: ${key}`,
    };
  }

  // Coerce every supplied value to text once. Values are DATA, never syntax.
  const textValues: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) {
    if (value === null || value === undefined) continue;
    textValues[name] = String(value);
  }

  // B. Only declared placeholders are substituted. Registry defaults are
  // authoritatively clean (the offline check verifies every template declares
  // exactly its tokens), but render fails closed rather than emit a
  // half-rendered line if that invariant ever breaks.
  const { error } = scanPlaceholderTokens(text);
  if (error !== null) {
    return {
      ok: false,
      code: "MALFORMED_PLACEHOLDER",
      message: `${key}: template is not well-formed (${error.raw}).`,
    };
  }

  // H. A required runtime value that is absent is an explicit failure — the
  // renderer never invents a value and never leaves a live `{placeholder}` in
  // customer text.
  const missing = entry.placeholders.filter(
    (name) => !Object.hasOwn(textValues, name),
  );
  if (missing.length > 0) {
    return {
      ok: false,
      code: "MISSING_PLACEHOLDER_VALUE",
      message: `${key}: missing value(s) for ${missing
        .map((name) => `{${name}}`)
        .join(", ")}.`,
      placeholders: missing,
    };
  }

  // G. One pass, no rescanning (see substitutePlaceholders).
  const { text: rendered, unresolved } = substitutePlaceholders(
    text,
    textValues,
  );

  // I. A successful render leaves no unresolved declared placeholder.
  const unresolvedDeclared = unresolved.filter((name) =>
    entry.placeholders.some((declared) => declared === name),
  );
  if (unresolvedDeclared.length > 0) {
    return {
      ok: false,
      code: "UNRESOLVED_PLACEHOLDER",
      message: `${key}: unresolved placeholder(s) ${unresolvedDeclared
        .map((name) => `{${name}}`)
        .join(", ")}.`,
      placeholders: unresolvedDeclared,
    };
  }

  return { ok: true, text: rendered };
}

/**
 * Render one canonical copy key's DEFAULT with the supplied placeholder
 * values.
 *
 *   renderCopy("booking.business_closed", { date: "2026-09-14" })
 *   // → "المنشأة مغلقة يوم 2026-09-14 — يرجى اختيار تاريخ آخر."
 *
 * This is `renderCopyText` applied to the registry default; see that function
 * for the exact semantics (values are coerced to text and substituted
 * verbatim in one pass; extra values are ignored; a value may contain
 * `{date}`, `{{date}}` or any other brace text without being treated as a
 * placeholder).
 *
 * Never throws: a missing value or an unknown key is a typed failure a future
 * runtime caller can handle safely instead of inventing wording.
 */
export function renderCopy(
  key: string,
  values: Readonly<Record<string, string | number>> = {},
): CopyRenderResult {
  const entry = getCopyEntry(key);
  if (entry === null) {
    return {
      ok: false,
      code: "UNKNOWN_COPY_KEY",
      message: `Unknown copy key: ${key}`,
    };
  }
  return renderCopyText(key, entry.defaultText, values);
}
