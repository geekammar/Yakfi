/**
 * GENERIC repair stage — jsonrepair (PROMPT-OPS-AI-JSON-NORMALIZATION-ENGINE-09).
 *
 * `jsonrepair` is a generic SYNTAX-repair library. It is deliberately NOT the
 * source of truth here: this stage only ever yields a candidate STRING, and
 * acceptance still requires strict `JSON.parse()` + `aiResponseSchema` in
 * the pipeline. It runs exactly ONCE per response, and only after the strict
 * stage failed.
 *
 * Bounded by three hard guards so it can never weaken the contract:
 *  - only object-intended content (leading `{`) is a candidate — arrays,
 *    scalars, strings, and prose are refused, never coerced into an object;
 *  - the repaired product must be exactly ONE top-level object — concatenated
 *    / restarted multi-object content is refused, never merged;
 *  - jsonrepair may not invent missing business values; any candidate the
 *    unchanged schema rejects keeps flowing to the next stage or fails.
 */
import { isSingleTopLevelObject } from "./structure";
import { jsonrepair } from "jsonrepair";

/**
 * One generic syntax-repair pass. Returns a candidate STRING (never a parsed
 * value) or `null` to decline. Callers MUST re-parse with strict
 * `JSON.parse()` before trusting anything.
 */
export function genericRepairContent(content: string): string | null {
  const trimmed = content.trim();
  // Refuse to coerce arrays, scalars, strings, and prose into an object.
  if (!trimmed.startsWith("{")) return null;
  let repaired: string;
  try {
    repaired = jsonrepair(trimmed);
  } catch {
    // Syntactically unrecoverable → decline; the response may still be
    // recoverable by a bounded provider policy, else INVALID_RESPONSE.
    return null;
  }
  // Never merge multiple objects; never accept a non-object repair product.
  if (!isSingleTopLevelObject(repaired)) return null;
  return repaired;
}
