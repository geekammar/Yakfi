/**
 * Atria bounded normalization POLICY (PROMPT-OPS-AI-JSON-NORMALIZATION-ENGINE-09).
 *
 * A plugin for the provider-agnostic normalization engine — the core
 * pipeline does NOT know this file exists; the Atria adapter attaches it.
 *
 * Two OBSERVED Atria serialization defects, each as ONE purely syntactic,
 * deterministic rule. Every candidate must still be re-parsed by strict
 * `JSON.parse()` and pass the UNCHANGED `aiResponseSchema` in the pipeline,
 * so neither rule can ever weaken the contract, invent business values,
 * merge unrelated objects, or silently coerce arbitrary structures.
 *
 * Removal: pass no policy to the adapter (or delete this file) and the
 * shared strict path is fully restored as-is — nothing else changes.
 */
import { isSingleTopLevelObject } from "../structure";
import type { NormalizerPolicy, NormalizerRule } from "../types";
import { jsonrepair } from "jsonrepair";

/**
 * Known Atria defect A — a surplus run of leading `{` bytes before an
 * otherwise object-intended payload (e.g. `{{"intent":"FAQ", …}}`).
 *
 * `jsonrepair` rejects `{{` outright ("Unexpected character"), so without
 * this pre-normalization the generic stage can never reach body corruption
 * on a braced payload. The rule reduces the leading brace run to exactly one
 * `{`, then lets `jsonrepair` repair remaining body corruption (trailing
 * commas, truncation, unquoted/single-quoted keys), and finally requires the
 * product to be exactly ONE top-level object.
 */
export const ATRIA_SURPLUS_BRACE_RULE: NormalizerRule = {
  name: "ATRIA_SURPLUS_BRACE",
  apply(content: string): string | null {
    const trimmed = content.trim();
    // Only object-intended content is a candidate.
    if (!trimmed.startsWith("{")) return null;
    const leadingBraces = trimmed.match(/^\{+/)?.[0].length ?? 0;
    if (leadingBraces < 2) return null;
    const normalized = trimmed.slice(leadingBraces - 1);
    let repaired: string;
    try {
      repaired = jsonrepair(normalized);
    } catch {
      return null;
    }
    // Never merge multiple objects; never accept a non-object product.
    if (!isSingleTopLevelObject(repaired)) return null;
    return repaired;
  },
};

/**
 * Known Atria defect B — an object-restart corruption: the model opens an
 * object, emits a stray `"`, and restarts the payload:
 *
 *   {"{"intent":"FAQ", "action":"reply", …}     (unparseable)
 *
 * The GENERIC stage repairs this into a syntactically valid object whose
 * ONLY key is the empty string, wrapping the real payload:
 *
 *   { "": { "intent": "…", "action": "…", … } }
 *
 * This rule promotes the wrapped value — ONE level, exactly once, and ONLY
 * when ALL of the following hold:
 *  - the candidate content strict-parses as JSON;
 *  - the top-level value is an object;
 *  - it has EXACTLY ONE key;
 *  - that key is EXACTLY `""`;
 *  - its value is an object;
 *  - the promoted object is then re-parsed by the pipeline's strict
 *    `JSON.parse()` and validated against the UNCHANGED `aiResponseSchema`.
 *
 * It never recursively unwraps more layers, never merges objects, never
 * invents fields, and never converts an arbitrary empty-string key. If the
 * promoted object fails validation, the response stays INVALID_RESPONSE.
 */
export const ATRIA_EMPTY_KEY_WRAPPER_RULE: NormalizerRule = {
  name: "ATRIA_EMPTY_KEY_WRAPPER",
  apply(content: string): string | null {
    const trimmed = content.trim();
    // Must already be parseable — this rule promotes an EXISTING empty key
    // and never reconstructs one from unparseable content.
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    const wrapper = parsed as Record<string, unknown>;
    const keys = Object.keys(wrapper);
    if (keys.length !== 1) return null;
    const onlyKey = keys[0];
    if (onlyKey !== "") return null;
    const inner = wrapper[""];
    if (typeof inner !== "object" || inner === null || Array.isArray(inner)) {
      return null;
    }
    // One level only. The pipeline re-parses + schema-validates this.
    return JSON.stringify(inner);
  },
};

/**
 * The Atria policy: rules are evaluated in declared order against the
 * generic stage's output; the FIRST candidate that strict-parses and
 * schema-validates wins. A rule's output never feeds another rule.
 */
export const ATRIA_NORMALIZATION_POLICY: NormalizerPolicy = {
  provider: "atria",
  rules: [ATRIA_SURPLUS_BRACE_RULE, ATRIA_EMPTY_KEY_WRAPPER_RULE],
};
