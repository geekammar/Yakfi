/**
 * FlowPilot AI Evaluation — scorer contract (PROMPT-AI-EVAL-03).
 *
 * A SCORER judges ONE axis of a case (intent, action, handoff, entities,
 * state, safety, knowledge). Each scorer is independent and pluggable: the
 * scoring engine runs the registered set and combines their verdicts, so a new
 * axis is a new scorer file registered in `index.ts` — never a rewrite of the
 * runner. This is the extensibility the slice requires.
 *
 * Discipline:
 *  - A scorer compares STRUCTURED behavior, never response wording. Wording is
 *    checked only where it is objectively reliable (e.g. a safety refusal), and
 *    it never becomes the main correctness gate.
 *  - A scorer returns `NOT_APPLICABLE` when the case does not exercise its
 *    axis; it is then excluded from that axis's denominator.
 *  - `LIMITATION` means "differs, but the current contract cannot do better"
 *    (`architecturalLimitation`). It is reported separately from `FAIL`.
 */

import type { EvaluationCase } from "../../schema/dataset-schema";
import type { ActualOutcome } from "../../schema/evaluation-result-schema";
import type { GroundTruth } from "../../schema/ground-truth-schema";
import type { FailureCategory } from "../../schema/taxonomy";

/** A single-axis verdict. `NOT_APPLICABLE` = the axis is not exercised. */
export type ScorerVerdict = "PASS" | "LIMITATION" | "FAIL" | "NOT_APPLICABLE";

/** The result one scorer produces for one case. */
export type ScorerOutcome = {
  /** The scorer name (`intent`, `handoff`, …). */
  scorer: string;
  verdict: ScorerVerdict;
  /** The failure taxonomy bucket; `NONE` unless the verdict is FAIL. */
  failureCategory: FailureCategory;
  /** A short, traceable reason — never customer content, never a secret. */
  reason: string;
  /** Optional structured detail (e.g. the resolved handoff outcome class). */
  detail?: Record<string, unknown>;
};

/**
 * Everything a scorer may read. Derived flags (`handedOff`, `seamOwned`) are
 * computed once by the engine so every scorer agrees on them.
 */
export type ScoringContext = {
  case: EvaluationCase;
  groundTruth: GroundTruth;
  actual: ActualOutcome;
  /** True when the deterministic booking-selection seam owns the turn. */
  seamOwned: boolean;
  /** True when the system routed the turn to a human (any handoff path). */
  handedOff: boolean;
  /** True when the actual output violated the response contract. */
  malformed: boolean;
};

/** The pluggable scorer interface. Pure + synchronous: no I/O, no throw. */
export interface Scorer {
  readonly name: string;
  score(ctx: ScoringContext): ScorerOutcome;
}

/** Small helper: build a scorer outcome. */
export function outcome(
  scorer: string,
  verdict: ScorerVerdict,
  failureCategory: FailureCategory,
  reason: string,
  detail?: Record<string, unknown>,
): ScorerOutcome {
  return { scorer, verdict, failureCategory, reason, detail };
}
