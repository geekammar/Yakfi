/**
 * JEV decision strategy — PROMPT-AI-ARCH-17 (target §17 Slice 8).
 *
 * An OPTIONAL, provider-neutral decision strategy BEHIND the EXISTING provider
 * gateway. The gateway (`orchestrator.ts`) owns the ONE generative call budget;
 * this strategy only decides WHETHER the current turn needs that single call:
 *
 *                    ┌─────────────────────────────────────┐
 *   AiRequest  ────▶ │  AI Runtime Gateway                 │
 *                    │  (ONE generative call budget)       │
 *                    └───────────────┬─────────────────────┘
 *                     ┌──────────────┴──────────────┐
 *                     ▼                             ▼
 *               DETERMINISTIC                 GENERATIVE
 *               terminate (no LLM)            the gateway makes its
 *               — a complete contract          SINGLE existing call
 *                 response is returned         through the existing adapter
 *
 * Allowed paths (target §11):
 *   deterministic → done                     (the engine's proven fast path)
 *   deterministic → JEV → deterministic      (this strategy terminates)
 *   deterministic → JEV → LLM                (the single generative call)
 *
 * Forbidden by design:
 *   ❌ a mandatory JEV stage on every request
 *   ❌ a classifier→responder→judge chain or a second inference to judge the
 *      first (the strategy never calls a model — `decide` is synchronous)
 *   ❌ executing domain truth or fabricating an answer
 *
 * Hard invariants this module guarantees:
 *  - Zero-or-one generative call per measured turn. `decide` performs NO I/O
 *    and NO model call; a DETERMINISTIC decision costs zero calls and a
 *    GENERATIVE decision leaves the budget untouched for the gateway's one call.
 *  - Conservative. A DETERMINISTIC termination is permitted ONLY on evidence
 *    the repository ALREADY proves decidable without a provider (the shared
 *    `bypassDeterministicAi` decision set). Unknown / unsafe / ambiguous input
 *    continues to the existing generative path — never a fabricated answer.
 *  - Provider-neutral. The decision carries no provider id, endpoint, model or
 *    prompt syntax; it never knows WHICH vendor answers, only whether
 *    generation is needed.
 *  - Bounded + auditable + server-authoritative. `reason` is a closed machine
 *    key; the decision is derived from the request's own text through the SAME
 *    classifier the deterministic path uses, so the two paths can never diverge
 *    on the same message. Internal decision metadata is NEVER customer-visible
 *    (it rides only on sanitized telemetry / turn observability).
 */

import type {
  AiRequest,
  AiResponse,
} from "@/features/conversations/server/ai-contract";
import { bypassDeterministicAi } from "@/features/conversations/server/conversation-ai";

import type { JevSemanticEvidence } from "./jev-semantic-strategy";
import type { AiCallOptions } from "./types";

// ─── The bounded decision contract (the smallest justified representation) ──

export const jevDecisionModeValues = [
  /** Terminate now: a deterministic path is sufficient, no LLM call. */
  "DETERMINISTIC",
  /** Continue to the gateway's SINGLE existing generative LLM call. */
  "GENERATIVE",
] as const;

export type JevDecisionMode = (typeof jevDecisionModeValues)[number];

export const jevDecisionReasonValues = [
  /**
   * A proven knowledge-free acknowledgement (a pure Arabic social opening):
   * the repository already answers it with a FIXED reply that needs no fact.
   */
  "DETERMINISTIC_ACKNOWLEDGEMENT",
  /**
   * A proven undecidable turn (too short / no tokens): the repository already
   * routes it to a safe ambiguity handoff rather than guessing.
   */
  "DETERMINISTIC_UNDECIDABLE",
  /**
   * No deterministic evidence exists for this turn: continue to the single
   * existing generative call. This is the default and the safe fallback —
   * ambiguity never terminates deterministically.
   */
  "GENERATIVE_REQUIRED",

  // ── Semantic-strategy reasons (PROMPT-AI-JEV-03B §6/§7). A semantic JEV
  //    strategy terminates DETERMINISTICALLY on these too: after its ONE JEV
  //    attempt the turn NEVER falls through to the LLM (fail-closed), so each
  //    of these is a zero-LLM-call termination. The closed keys are the
  //    auditable outcome class of the turn.
  /**
   * A JEV attempt was SPENT and then failed (timeout / network / provider /
   * malformed / missing field). The turn terminated on the deterministic
   * lexical baseline: 1 JEV call, 0 LLM calls.
   */
  "JEV_FAILURE_FAIL_CLOSED",
  /**
   * A spent JEV call produced NO actionable semantic reading at all, so the
   * deterministic lexical baseline owns the turn: 1 JEV call, 0 LLM calls.
   */
  "JEV_NO_READING_BASELINE",
  /**
   * A spent JEV call produced a semantic domain-task reading (booking /
   * availability / cancellation / reschedule) proposed to the ONE resolver:
   * 1 JEV call, 0 LLM calls.
   */
  "SEMANTIC_DOMAIN",
  /**
   * A spent JEV call produced a semantic handoff reading (safety / explicit
   * human / ambiguity / knowledge gap): 1 JEV call, 0 LLM calls.
   */
  "SEMANTIC_HANDOFF",
  /**
   * A spent JEV call produced the bounded contact-vs-book boundary and the
   * strategy proposed ONE bounded clarification instead of guessing a handoff
   * or a booking: 1 JEV call, 0 LLM calls.
   */
  "SEMANTIC_CLARIFY",
  /**
   * A spent JEV call produced a knowledge-free semantic answer (a proven-pure
   * social opening) drawn from the fixed engine-owned templates: 1 JEV call,
   * 0 LLM calls.
   */
  "SEMANTIC_ANSWER",
] as const;

export type JevDecisionReason = (typeof jevDecisionReasonValues)[number];

/**
 * The decision the strategy made for one turn. `response` is a COMPLETE,
 * contract-valid `AiResponse` present IFF `mode === "DETERMINISTIC"` — the
 * gateway returns it without any provider call.
 *
 * `semantic` carries the closed machine-key evidence block a semantic strategy
 * produces (PROMPT-AI-JEV-03B §12): derived facts, sanitized probabilities,
 * the shared precedence derivation, and — when the JEV reading owns the turn —
 * the resolver signals the engine feeds `resolveTurnPlan`. Absent for the
 * conservative strategy and for every non-semantic decision; it is additive
 * observability and never customer-visible.
 */
export type JevDecision = {
  readonly mode: JevDecisionMode;
  readonly reason: JevDecisionReason;
  readonly response: AiResponse | null;
  readonly semantic?: JevSemanticEvidence | null;
};

export type JevStrategy = {
  /** Stable strategy identity for telemetry / audit (machine key). */
  readonly strategyId: string;
  /**
   * Pure, total and never throws. PROMPT-AI-JEV-03B §6: the seam is async so a
   * semantic strategy may perform its ONE async JEV decision; the conservative
   * strategy still performs NO I/O and NO model call (it resolves without
   * awaiting anything). The gateway (`orchestrator.ts`) owns the call budget:
   * a DETERMINISTIC decision terminates the turn with zero provider attempts
   * and a GENERATIVE decision leaves the budget untouched for the gateway's
   * single existing call.
   */
  decide(request: AiRequest, options?: AiCallOptions): Promise<JevDecision>;
};

// ─── Deterministic Baseline Strategy (CONV-JEV-01 Terminology Authority) ──
// NOTE: Under CONV-JEV-01, the word JEV means exclusively the real TypeSafe AI
// remote model. The deterministic rule-based checks and fallbacks are named
// Deterministic Baseline.

/**
 * The telemetry `finalProvider` label the gateway emits when the JEV strategy
 * terminated the turn deterministically (the sibling of the engine-side
 * `"deterministic-bypass"` label — no provider call was spent either way).
 */
export const JEV_DETERMINISTIC_PROVIDER = "jev-deterministic";

/** Authoritative name under CONV-JEV-01. */
export const DETERMINISTIC_BASELINE_PROVIDER = "deterministic-baseline";

export function isJevDeterministicProvider(
  provider: string | null | undefined,
) {
  return (
    provider === JEV_DETERMINISTIC_PROVIDER ||
    provider === DETERMINISTIC_BASELINE_PROVIDER
  );
}

/** Authoritative alias under CONV-JEV-01. */
export const isDeterministicBaselineProvider = isJevDeterministicProvider;

/**
 * Fit a proven deterministic `AiResponse` (from `bypassDeterministicAi`) into
 * the bounded decision contract, deriving the machine-readable reason from the
 * response's own declared intent. Exposed for the strategy + its guards.
 */
export function deterministicDecisionFromProvenResponse(
  proven: AiResponse,
): JevDecision {
  const reason: JevDecisionReason =
    proven.intent === "GREETING"
      ? "DETERMINISTIC_ACKNOWLEDGEMENT"
      : "DETERMINISTIC_UNDECIDABLE";
  return { mode: "DETERMINISTIC", reason, response: proven };
}

/** Legacy alias for backward compatibility. */
export const jevDecisionFromProvenResponse =
  deterministicDecisionFromProvenResponse;

// ─── The Deterministic Baseline Strategy ────────────────────────────────────

export const CONSERVATIVE_JEV_STRATEGY_ID = "jev-conservative@v1";

/** Authoritative alias under CONV-JEV-01. */
export const DETERMINISTIC_BASELINE_STRATEGY_ID = "deterministic-baseline@v1";

/**
 * The default JEV strategy (PROMPT-AI-ARCH-17). Conservative by construction:
 * it terminates deterministically ONLY on the turns the repository ALREADY
 * proves decidable without a provider — the exact decision set the engine's
 * deterministic fast path and the deterministic fallback assistant use
 * (`bypassDeterministicAi`). Everything else continues to the single existing
 * generative call.
 *
 * Authoritative name under CONV-JEV-01: Deterministic Baseline Strategy.
 */
export function createConservativeJevStrategy(): JevStrategy {
  return {
    strategyId: CONSERVATIVE_JEV_STRATEGY_ID,
    async decide(
      request: AiRequest,
      _options?: AiCallOptions,
    ): Promise<JevDecision> {
      const proven = bypassDeterministicAi(request);
      if (!proven) {
        return {
          mode: "GENERATIVE",
          reason: "GENERATIVE_REQUIRED",
          response: null,
        };
      }
      return deterministicDecisionFromProvenResponse(proven);
    },
  };
}

/** Authoritative name under CONV-JEV-01: Deterministic Baseline Strategy. */
export const createDeterministicBaselineStrategy =
  createConservativeJevStrategy;
