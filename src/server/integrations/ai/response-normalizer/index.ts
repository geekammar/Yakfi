/**
 * Reusable JSON response NORMALIZATION ENGINE — public surface
 * (PROMPT-OPS-AI-JSON-NORMALIZATION-ENGINE-09).
 *
 * ONE engine, provider-agnostic at its core, with optional bounded
 * provider/model-scoped normalization policies attachable as plugins:
 *
 *   normalizeResponse({ provider, model, content, policy })
 *
 * STRICT `JSON.parse()` and the UNCHANGED `aiResponseSchema` are the only
 * authorities. No repair path may bypass either.
 *
 * Usage:
 *   import { normalizeResponse, ATRIA_NORMALIZATION_POLICY } from
 *     "@/server/integrations/ai/response-normalizer";
 */
export { genericRepairContent } from "./generic-repair";
export {
  acceptedTopLevelKeys,
  isPolicyInScope,
  normalizeResponse,
  summarizeNormalizerResult,
} from "./pipeline";
export type { NormalizeParams } from "./pipeline";
export {
  isFencedContent,
  isSingleTopLevelObject,
  structuralFingerprint,
  stripJsonFences,
  topLevelKeyCount,
  tryStrictJsonParse,
} from "./structure";
export type { FingerprintInput, StrictParseResult } from "./structure";
export type {
  NormalizerContext,
  NormalizerFailure,
  NormalizerMode,
  NormalizerPolicy,
  NormalizerResult,
  NormalizerRule,
  NormalizerStage,
  NormalizerSuccess,
  NormalizerTrace,
  RuleAttempt,
  StructuralFingerprint,
} from "./types";
export { AGENTROUTER_NORMALIZATION_POLICY } from "./policies/agentrouter";
export {
  ATRIA_EMPTY_KEY_WRAPPER_RULE,
  ATRIA_NORMALIZATION_POLICY,
  ATRIA_SURPLUS_BRACE_RULE,
} from "./policies/atria";
export { OPENROUTER_NORMALIZATION_POLICY } from "./policies/openrouter";
export { CODECRAFT_NORMALIZATION_POLICY } from "./policies/codecraft";
