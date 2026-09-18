/**
 * Reusable JSON response NORMALIZATION ENGINE — type surface
 * (PROMPT-OPS-AI-JSON-NORMALIZATION-ENGINE-09).
 *
 * The engine is provider-agnostic by construction: the core pipeline
 * (see `pipeline.ts`) knows NOTHING about any specific provider. A provider
 * may optionally attach a bounded {@link NormalizerPolicy} — a declarative,
 * provider-scoped list of purely syntactic candidate transforms. Policies
 * are plugins: attachable/detachable without touching the core.
 *
 * Final authority ALWAYS stays with:
 *   strict JSON.parse()  +  the UNCHANGED `aiResponseSchema`.
 * No rule may bypass, weaken, or duplicate either of them.
 */
import type { AiResponse } from "@/features/conversations/server/ai-contract";

import type { AiProviderId } from "../types";

/** Stages the pipeline walks, in strict-first order. */
export type NormalizerStage =
  "STRICT_PARSE" | "GENERIC_REPAIR" | "PROVIDER_REPAIR";

/**
 * How a response was ultimately accepted. Failures carry the reserved
 * `INVALID_RESPONSE` outcome on {@link NormalizerResult.mode}.
 */
export type NormalizerMode =
  "DIRECT_PARSE" | "GENERIC_REPAIRED_PARSE" | "BOUNDED_PROVIDER_REPAIR";

/** Provider + model the policy is evaluated against (scope gate inputs). */
export type NormalizerContext = {
  readonly provider: AiProviderId;
  readonly model: string;
};

/**
 * ONE bounded, deterministic, purely-syntactic candidate transform.
 *
 * Contract every rule MUST honour:
 *  - receives the current content STRING and returns a candidate STRING, or
 *    `null` to decline (never a parsed value — the core re-parses);
 *  - never invents fields, values, intents, or structure;
 *  - never merges unrelated objects or unwraps more than one layer;
 *  - never performs semantic reconstruction or coercion;
 *  - must be free of side effects and safe to call on arbitrary input
 *    (the core isolates rule failures: a throwing rule only declines).
 */
export type NormalizerRule = {
  /** Stable machine name, surfaced in telemetry (e.g. `ATRIA_SURPLUS_BRACE`). */
  readonly name: string;
  apply(content: string, ctx: NormalizerContext): string | null;
};

/**
 * A provider/model-scoped bundle of bounded rules. The core activates a
 * policy ONLY when {@link provider} matches the request context (and
 * {@link models}, when present, also matches) — so a policy can never
 * execute accidentally for another provider.
 */
export type NormalizerPolicy = {
  readonly provider: AiProviderId;
  /** Optional allow-list restricting the policy to specific model ids. */
  readonly models?: readonly string[];
  readonly rules: readonly NormalizerRule[];
};

/**
 * Sanitized STRUCTURAL fingerprint of the raw provider content.
 * Content, keys, and values are NEVER recorded — only shape statistics.
 */
export type StructuralFingerprint = {
  readonly contentLength: number;
  readonly firstByte: string;
  readonly leadingBraceCount: number;
  readonly trailingBraceCount: number;
  readonly fenced: boolean;
  /** `JSON.parse` failure offset, when the engine exposes one. */
  readonly strictParseOffset: number | null;
  /** Number of top-level keys after parsing, when parseable. */
  readonly topLevelKeys: number | null;
};

/** One rule evaluation record (telemetry only — no content). */
export type RuleAttempt = {
  readonly rule: string;
  readonly declined: boolean;
  readonly strictParseOk: boolean;
  readonly schemaOk: boolean;
};

/**
 * Full observability trace. Lets an operator reconstruct exactly which path
 * ran, which stage produced what, and why the response was rejected —
 * without ever exposing provider content.
 */
export type NormalizerTrace = {
  readonly stage: NormalizerStage;
  readonly outcome: NormalizerMode | "INVALID_RESPONSE";
  readonly fingerprint: StructuralFingerprint;
  /** Stage 1 (strict) results on the fence-stripped content. */
  readonly strictParseOk: boolean;
  readonly schemaOk: boolean;
  /** Stage 2 (generic jsonrepair) results. */
  readonly genericRepairRan: boolean;
  readonly genericRepairProducedCandidate: boolean;
  readonly genericRepairStrictParseOk: boolean;
  readonly genericRepairSchemaOk: boolean;
  /** Stage 3 (bounded provider policy) results. */
  readonly providerRepairRan: boolean;
  readonly providerRepairRule: string | null;
  readonly ruleAttempts: readonly RuleAttempt[];
  /** Machine-readable rejection reason (no content). */
  readonly rejectReason: string;
};

export type NormalizerSuccess = {
  readonly ok: true;
  readonly value: AiResponse;
  readonly mode: NormalizerMode;
  readonly trace: NormalizerTrace;
};

export type NormalizerFailure = {
  readonly ok: false;
  readonly mode: "INVALID_RESPONSE";
  readonly trace: NormalizerTrace;
};

export type NormalizerResult = NormalizerSuccess | NormalizerFailure;
