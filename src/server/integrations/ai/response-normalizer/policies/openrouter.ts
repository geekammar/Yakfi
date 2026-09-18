/**
 * OpenRouter normalization POLICY — intentionally EMPTY
 * (PROMPT-OPS-AI-JSON-NORMALIZATION-ENGINE-09).
 *
 * OpenRouter has NO observed serialization defect requiring bounded
 * normalization, so this policy declares zero rules. It exists to make the
 * posture explicit and importable, and to prove the isolation invariant:
 * attaching it changes NOTHING, because the core skips any policy with no
 * rules and OpenRouter content is therefore held to the strict parser +
 * `aiResponseSchema` alone — byte-for-byte the pre-engine behaviour.
 *
 * To add a rule later: append it to `rules` here and wire the policy into
 * the OpenRouter adapter. Nothing else in the codebase changes.
 */
import type { NormalizerPolicy } from "../types";

export const OPENROUTER_NORMALIZATION_POLICY: NormalizerPolicy = {
  provider: "openrouter",
  rules: [],
};
