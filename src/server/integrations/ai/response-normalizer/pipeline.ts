/**
 * Reusable JSON response NORMALIZATION ENGINE — core pipeline
 * (PROMPT-OPS-AI-JSON-NORMALIZATION-ENGINE-09).
 *
 * Provider-agnostic by construction: the core knows NOTHING about any
 * specific provider, model, or defect. A provider may optionally attach a
 * bounded {@link NormalizerPolicy}; absent one, the engine is byte-for-byte
 * the strict parser + schema gate.
 *
 * Strict-first order, and NO stage ever bypasses the ones before it:
 *
 *   RAW CONTENT
 *     ↓ trivial normalization (markdown fence strip only)
 *   STRICT JSON.parse()  →  aiResponseSchema
 *     ├─ valid → DIRECT_PARSE → ACCEPT
 *     └─ invalid
 *          ↓
 *   GENERIC jsonrepair  →  STRICT JSON.parse()  →  aiResponseSchema
 *     ├─ valid → GENERIC_REPAIRED_PARSE → ACCEPT
 *     └─ invalid
 *          ↓
 *   OPTIONAL BOUNDED PROVIDER/MODEL POLICY (scope-gated by the core)
 *     ↓ every rule produces a candidate; first that STRICT-parses
 *       AND schema-validates wins
 *   STRICT JSON.parse()  →  unchanged aiResponseSchema
 *     ├─ valid → BOUNDED_PROVIDER_REPAIR → ACCEPT
 *     └─ else → INVALID_RESPONSE
 *
 * Boundedness guarantees (provable, enforced here, not by convention):
 *  - exactly ONE generic repair pass and ONE provider-policy pass;
 *  - a rule's output is NEVER fed back into any stage or into another rule
 *    (no recursive repair, no mutation chain);
 *  - rules are isolated — a throwing rule only declines;
 *  - the final authorities are always strict `JSON.parse()` and the
 *    UNCHANGED `aiResponseSchema`; no rule may weaken or duplicate them.
 */
import { parseAiResponse } from "@/features/conversations/server/ai-contract";
import type { AiResponse } from "@/features/conversations/server/ai-contract";

import { genericRepairContent } from "./generic-repair";
import {
  isFencedContent,
  stripJsonFences,
  structuralFingerprint,
  topLevelKeyCount,
  tryStrictJsonParse,
} from "./structure";
import type {
  NormalizerContext,
  NormalizerMode,
  NormalizerPolicy,
  NormalizerResult,
  NormalizerStage,
  NormalizerTrace,
  RuleAttempt,
} from "./types";

/** Internally mutable view of the (publicly readonly) trace. */
type WritableTrace = {
  -readonly [K in keyof NormalizerTrace]: NormalizerTrace[K];
};

export type NormalizeParams = {
  /** Raw model content (`choices[0].message.content`). */
  content: string;
  provider: NormalizerContext["provider"];
  model: string;
  /** Optional bounded provider/model-scoped normalization policy. */
  policy?: NormalizerPolicy;
};

/**
 * Core scope gate: a policy runs ONLY for its own provider (and, when the
 * policy declares a model allow-list, its own model). This makes accidental
 * cross-provider activation structurally impossible, independent of wiring.
 */
export function isPolicyInScope(
  policy: NormalizerPolicy | undefined,
  ctx: NormalizerContext,
): boolean {
  if (!policy) return false;
  if (policy.rules.length === 0) return false;
  if (policy.provider !== ctx.provider) return false;
  if (
    policy.models &&
    policy.models.length > 0 &&
    !policy.models.includes(ctx.model)
  ) {
    return false;
  }
  return true;
}

/**
 * Validate a candidate against the UNCHANGED `aiResponseSchema`. The single
 * acceptance gate of the whole engine — there is no second, weaker schema.
 */
function validateSchema(candidate: unknown): AiResponse | null {
  return parseAiResponse(candidate);
}

export function normalizeResponse(params: NormalizeParams): NormalizerResult {
  const { content, provider, model, policy } = params;
  const ctx: NormalizerContext = { provider, model };

  // ── Stage 0: trivial normalization only (never a repair). ───────────────
  const fenced = isFencedContent(content);
  const stripped = stripJsonFences(content);

  const trace: WritableTrace = {
    stage: "STRICT_PARSE",
    outcome: "INVALID_RESPONSE",
    fingerprint: structuralFingerprint({ raw: content, stripped, fenced }),
    strictParseOk: false,
    schemaOk: false,
    genericRepairRan: false,
    genericRepairProducedCandidate: false,
    genericRepairStrictParseOk: false,
    genericRepairSchemaOk: false,
    providerRepairRan: false,
    providerRepairRule: null,
    ruleAttempts: [],
    rejectReason: "no stage accepted the response",
  };

  const accept = (
    stage: NormalizerStage,
    mode: NormalizerMode,
    value: AiResponse,
  ): NormalizerResult => ({
    ok: true,
    value,
    mode,
    trace: { ...trace, stage, outcome: mode },
  });

  // ── Stage 1: STRICT parse + schema (always first, never bypassed). ──────
  const strict = tryStrictJsonParse(stripped);
  trace.strictParseOk = strict.ok;
  if (strict.ok) {
    const value = validateSchema(strict.value);
    trace.schemaOk = value !== null;
    if (value) {
      return accept("STRICT_PARSE", "DIRECT_PARSE", value);
    }
    trace.rejectReason = "strict parse ok; aiResponseSchema rejected";
  } else {
    trace.rejectReason = `strict parse failed (${strict.kind})`;
  }

  // ── Stage 2: GENERIC jsonrepair — exactly ONE pass. ─────────────────────
  trace.genericRepairRan = true;
  const genericCandidate = genericRepairContent(stripped);
  trace.genericRepairProducedCandidate = genericCandidate !== null;
  // The provider stage (if any) chains from the generic candidate when one
  // exists, else from the strict-stage content. One forward step only.
  const working = genericCandidate ?? stripped;
  if (genericCandidate !== null) {
    const repaired = tryStrictJsonParse(genericCandidate);
    trace.genericRepairStrictParseOk = repaired.ok;
    if (repaired.ok) {
      const value = validateSchema(repaired.value);
      trace.genericRepairSchemaOk = value !== null;
      if (value) {
        return accept("GENERIC_REPAIR", "GENERIC_REPAIRED_PARSE", value);
      }
      trace.rejectReason = "generic repair parsed; aiResponseSchema rejected";
    } else {
      trace.rejectReason = "generic repair did not produce parseable JSON";
    }
  }

  // ── Stage 3: OPTIONAL BOUNDED PROVIDER/MODEL POLICY — ONE pass. ─────────
  // The core — not the wiring — decides whether the policy is in scope.
  if (!(policy && isPolicyInScope(policy, ctx))) {
    return { ok: false, mode: "INVALID_RESPONSE", trace };
  }
  trace.providerRepairRan = true;
  trace.stage = "PROVIDER_REPAIR";

  const attempts: RuleAttempt[] = [];
  for (const rule of policy.rules) {
    // A rule's candidate is validated immediately; a rejected candidate is
    // discarded and never re-enters any stage (no recursive repair).
    let candidate: string | null = null;
    try {
      candidate = rule.apply(working, ctx);
    } catch {
      // Rules are plugins: a failure only declines, never propagates.
      candidate = null;
    }
    let attemptStrictOk = false;
    let attemptSchemaOk = false;
    if (candidate !== null) {
      const ruleParsed = tryStrictJsonParse(candidate);
      attemptStrictOk = ruleParsed.ok;
      if (ruleParsed.ok) {
        const value = validateSchema(ruleParsed.value);
        attemptSchemaOk = value !== null;
        if (value) {
          trace.providerRepairRule = rule.name;
          trace.ruleAttempts = [
            ...attempts,
            {
              rule: rule.name,
              declined: false,
              strictParseOk: true,
              schemaOk: true,
            },
          ];
          return accept("PROVIDER_REPAIR", "BOUNDED_PROVIDER_REPAIR", value);
        }
        trace.rejectReason = `rule ${rule.name} parsed; aiResponseSchema rejected`;
      } else if (trace.rejectReason.startsWith("strict parse failed")) {
        trace.rejectReason = `rule ${rule.name} did not produce parseable JSON`;
      }
    }
    attempts.push({
      rule: rule.name,
      declined: candidate === null,
      strictParseOk: attemptStrictOk,
      schemaOk: attemptSchemaOk,
    });
  }
  trace.ruleAttempts = attempts;
  if (attempts.every((a) => a.declined)) {
    trace.rejectReason = `provider policy declined all ${String(attempts.length)} rule(s)`;
  }

  return { ok: false, mode: "INVALID_RESPONSE", trace };
}

// ── telemetry helpers (sanitized; safe to persist) ──────────────────────────

/**
 * One-line, content-free summary of a normalization outcome for logs.
 * Never includes content, keys, values, secrets, or headers.
 */
export function summarizeNormalizerResult(result: NormalizerResult): string {
  const t = result.trace;
  const fp = t.fingerprint;
  return [
    `outcome=${t.outcome}`,
    `mode=${result.ok ? result.mode : "n/a"}`,
    `stage=${t.stage}`,
    `len=${fp.contentLength}`,
    `first=${fp.firstByte}`,
    `lead=${fp.leadingBraceCount}`,
    `trail=${fp.trailingBraceCount}`,
    `fenced=${fp.fenced}`,
    `strict=${t.strictParseOk ? "ok" : "fail"}`,
    `schema=${t.schemaOk ? "ok" : "fail"}`,
    `generic=${t.genericRepairRan ? (t.genericRepairProducedCandidate ? (t.genericRepairSchemaOk ? "ok" : t.genericRepairStrictParseOk ? "schema-fail" : "parse-fail") : "no-candidate") : "not-run"}`,
    `provider=${t.providerRepairRan ? (t.providerRepairRule ?? "no-rule-matched") : "not-run"}`,
    `topKeys=${fp.topLevelKeys ?? "n/a"}`,
  ].join(" ");
}

/**
 * Number of top-level keys of the ACCEPTED value — a structural sanity check
 * the caller can assert (a valid FlowPilot response has exactly one object
 * with the contract's keys; the schema already guarantees the shape).
 */
export function acceptedTopLevelKeys(result: NormalizerResult): number | null {
  if (!result.ok) return null;
  return topLevelKeyCount(result.value);
}
