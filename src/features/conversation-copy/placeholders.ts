/**
 * Conversation Copy registry — placeholder syntax (UX-LAB-01B, Slice 2).
 *
 * The registry knows exactly ONE placeholder format: a literal `{name}` token
 * whose name is one of the closed `PLACEHOLDER_VALUES` set. There is no
 * template language — no expressions, no filters, no escaping, no recursion,
 * no JavaScript evaluation. Every `{` or `}` in a copy text is either part of
 * one well-formed `{approvedName}` token or it is a syntax error.
 *
 * That single rule makes any well-formed template unambiguous and lets the
 * validator reject `{{date}}`, `{ date }`, `{date` and `date}`
 * deterministically, with no parser engine and no ambiguity.
 *
 * Pure + side-effect free: imports only the closed vocabulary.
 */
import { PLACEHOLDER_VALUES } from "@/features/conversation-copy/types";
import type { PlaceholderName } from "@/features/conversation-copy/types";

/** The closed vocabulary, as a set for O(1) membership tests. */
const KNOWN_PLACEHOLDERS: ReadonlySet<string> = new Set(PLACEHOLDER_VALUES);

/**
 * Matches one `{...}` span whose inner text contains NO brace characters.
 * A `[^{}]*` inner class (instead of `[a-zA-Z]+`) is what makes nested
 * braces like `{{date}}` detectable: the inner span sees only the nested
 * name, leaving an unbalanced outer brace pair for the caller to reject.
 */
export const PLACEHOLDER_TOKEN = /\{([^{}]*)\}/g;

/**
 * The shape of a syntax violation found while scanning a copy text.
 *  - `MALFORMED_PLACEHOLDER`  — braces that are not exactly one `{name}` pair
 *                               (`{{date}}`, `{ date }`, `{date`, `date}`).
 *  - `UNKNOWN_PLACEHOLDER`    — a well-formed token whose name is not in the
 *                               closed vocabulary (`{randomThing}`).
 */
export type PlaceholderSyntaxError = {
  readonly kind: "MALFORMED_PLACEHOLDER" | "UNKNOWN_PLACEHOLDER";
  /** The offending text span, for the failure message. */
  readonly raw: string;
};

/** A recognized `{name}` token inside a copy text. */
export type PlaceholderToken = {
  readonly name: PlaceholderName;
  readonly raw: string;
  readonly index: number;
};

/**
 * Scan `text` left to right for `{name}` tokens.
 *
 * Returns the recognized tokens (in order) and the FIRST syntax violation.
 * `error === null` guarantees the text's braces are exactly zero or more
 * well-formed `{approvedName}` tokens — nothing else may contain a brace.
 *
 * Deterministic: same input always yields the same output. Stateless: the
 * global flag is never shared between calls (`matchAll` clones the pattern).
 */
export function scanPlaceholderTokens(text: string): {
  readonly tokens: readonly PlaceholderToken[];
  readonly error: PlaceholderSyntaxError | null;
} {
  const tokens: PlaceholderToken[] = [];
  let open = 0;
  let close = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{") open += 1;
    else if (char === "}") close += 1;
  }
  for (const match of text.matchAll(PLACEHOLDER_TOKEN)) {
    const inner = match[1] ?? "";
    const raw = match[0];
    // A token name is bare ASCII letters only — no spaces, no digits, no
    // punctuation. This is what rejects `{ date }` and `{}`.
    if (!/^[a-zA-Z]+$/.test(inner)) {
      return { tokens, error: { kind: "MALFORMED_PLACEHOLDER", raw } };
    }
    if (!KNOWN_PLACEHOLDERS.has(inner)) {
      return { tokens, error: { kind: "UNKNOWN_PLACEHOLDER", raw } };
    }
    tokens.push({
      name: inner as PlaceholderName,
      raw,
      index: match.index ?? 0,
    });
  }
  // Brace balance: every `{` and every `}` must belong to a matched token.
  // This is what rejects `{date`, `date}` and `{{date}}` (two open braces,
  // one matched token).
  if (open !== tokens.length || close !== tokens.length) {
    return {
      tokens,
      error: {
        kind: "MALFORMED_PLACEHOLDER",
        raw: text.slice(0, 80),
      },
    };
  }
  return { tokens, error: null };
}

/**
 * ONE-PASS, non-recursive substitution of `{name}` tokens with literal text.
 *
 * The template is walked once, left to right; each recognized token is
 * replaced by its value verbatim and the result is never rescanned. A value
 * may therefore freely contain `{date}`, `{{date}}` or any other brace text —
 * it stays DATA and is never interpreted as a placeholder (no second pass,
 * no injection).
 *
 * Tokens without a supplied value are left verbatim in `text` AND reported in
 * `unresolved`, so a caller can render nothing partially by accident.
 */
export function substitutePlaceholders(
  template: string,
  values: Readonly<Record<string, string>>,
): { readonly text: string; readonly unresolved: readonly string[] } {
  const parts: string[] = [];
  const unresolved: string[] = [];
  let last = 0;
  for (const match of template.matchAll(PLACEHOLDER_TOKEN)) {
    const index = match.index ?? 0;
    const name = match[1] ?? "";
    parts.push(template.slice(last, index));
    const supplied = Object.hasOwn(values, name) ? values[name] : null;
    if (supplied === null || supplied === undefined) {
      if (!unresolved.includes(name)) unresolved.push(name);
      parts.push(match[0]);
    } else {
      parts.push(supplied);
    }
    last = index + match[0].length;
  }
  parts.push(template.slice(last));
  return { text: parts.join(""), unresolved };
}
