/**
 * CodeCraft normalization POLICY — intentionally EMPTY
 * (CODECRAFT-DISCOVERY-PROVIDER-58).
 *
 * Mirrors the OpenRouter/AgentRouter posture: no CodeCraft serialization
 * defect has been observed that requires bounded normalization, so this
 * policy declares zero rules. It exists to make the posture explicit and
 * importable, and to prove the isolation invariant: attaching it changes
 * NOTHING, because the core skips any policy with no rules and CodeCraft
 * content is therefore held to the strict parser + `aiResponseSchema`
 * alone — byte-for-byte the shared behaviour.
 *
 * To add a rule later: append it to `rules` here. Nothing else in the
 * codebase changes. A rule is justified ONLY by a proven, reproducible
 * defect observed against the live endpoint — never added speculatively.
 */
import type { NormalizerPolicy } from "../types";

export const CODECRAFT_NORMALIZATION_POLICY: NormalizerPolicy = {
  provider: "codecraft",
  rules: [],
};
