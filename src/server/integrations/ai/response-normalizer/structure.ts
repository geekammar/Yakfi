/**
 * Structural JSON analysis helpers (PROMPT-OPS-AI-JSON-NORMALIZATION-ENGINE-09).
 *
 * Pure functions, no side effects, no provider knowledge. Two jobs:
 *  1. trivial, content-preserving normalization (markdown fence stripping);
 *  2. strictly STRUCTURAL guards/statistics used to bound every repair stage.
 *
 * Nothing here ever inspects or rewrites field names or values.
 */

/** True when `raw` is wrapped in a Markdown ``` fence (json or bare). */
export function isFencedContent(raw: string): boolean {
  return raw.trim().startsWith("```");
}

/**
 * Trivial, content-preserving normalization: strip an optional Markdown
 * ``` fence wrapper. This is the ONLY pre-processing before the strict
 * parser — never a repair, never a value change.
 */
export function stripJsonFences(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const withoutOpen = trimmed.replace(/^```(?:json)?\s*/i, "");
  const withoutClose = withoutOpen.replace(/\s*```$/g, "");
  return withoutClose.trim();
}

export type StrictParseResult =
  | { ok: true; value: unknown }
  | { ok: false; offset: number | null; kind: string };

/**
 * Strict `JSON.parse()` — the single parser the engine ever trusts. Never
 * retries, never tolerates trailing content: a second top-level value is a
 * failure (`{"a":1}{"b":2}` is rejected, never merged).
 */
export function tryStrictJsonParse(content: string): StrictParseResult {
  try {
    return { ok: true, value: JSON.parse(content) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "parse error";
    const offset = /position (\d+)/.exec(message)?.[1];
    const kind = strictParseFailureKind(message);
    return {
      ok: false,
      offset: offset === undefined ? null : Number(offset),
      kind,
    };
  }
}

function strictParseFailureKind(message: string): string {
  if (message.includes("Unexpected end of JSON input")) return "unexpected-end";
  if (message.includes("non-whitespace character after JSON")) {
    return "trailing-content";
  }
  if (message.includes("not valid JSON")) return "invalid-json";
  if (message.includes("Expected property name")) return "expected-key";
  if (message.includes("Expected double-quoted")) return "expected-string";
  return "syntax-error";
}

/**
 * True when `s` is exactly ONE top-level JSON object: starts at the first
 * byte with `{`, ends at the last byte with the matching `}`, and NOTHING
 * (not even whitespace) follows that closing brace. Braces inside string
 * literals are ignored. Used to bound every repair stage: it refuses
 * merged/concatenated objects, arrays, and scalars outright.
 */
export function isSingleTopLevelObject(s: string): boolean {
  const t = s.trim();
  if (!t.startsWith("{") || !t.endsWith("}")) return false;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < t.length; i += 1) {
    const ch = t[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      // The first top-level object already closed before end-of-string →
      // a second value follows (e.g. `{"a":1}{"b":2}`) → refuse to merge.
      if (depth === 0 && i !== t.length - 1) return false;
    }
  }
  return depth === 0;
}

/** Number of top-level keys when `value` is a plain object, else null. */
export function topLevelKeyCount(value: unknown): number | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return Object.keys(value as Record<string, unknown>).length;
}

export type FingerprintInput = {
  raw: string;
  stripped: string;
  fenced: boolean;
};

/**
 * Sanitized structural fingerprint — shape statistics ONLY. Length, first
 * byte, brace runs, fence presence, the strict-parse failure offset, and the
 * top-level key count. Never content, never keys, never values, never
 * secrets, never headers.
 */
export function structuralFingerprint(input: FingerprintInput): {
  contentLength: number;
  firstByte: string;
  leadingBraceCount: number;
  trailingBraceCount: number;
  fenced: boolean;
  strictParseOffset: number | null;
  topLevelKeys: number | null;
} {
  const { raw, stripped, fenced } = input;
  const leading = stripped.match(/^\{+/)?.[0].length ?? 0;
  const trailing = stripped.match(/\}+$/)?.[0].length ?? 0;
  const parsed = tryStrictJsonParse(stripped);
  return {
    contentLength: raw.length,
    firstByte: raw[0] ?? "∅",
    leadingBraceCount: leading,
    trailingBraceCount: trailing,
    fenced,
    strictParseOffset: parsed.ok ? null : parsed.offset,
    topLevelKeys: parsed.ok ? topLevelKeyCount(parsed.value) : null,
  };
}
