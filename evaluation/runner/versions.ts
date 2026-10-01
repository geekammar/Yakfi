/**
 * FlowPilot AI Evaluation — runner / scoring / evaluator version stamps
 * (PROMPT-AI-EVAL-03).
 *
 * These constants are part of the REPRODUCIBILITY contract: every run records
 * the evaluator + scoring versions so a report can be traced back to the exact
 * scoring behavior that produced it. Bump `SCORING_VERSION` whenever a scorer's
 * PASS/FAIL semantics change (so an old and a new run are knowingly not
 * comparable); bump `EVALUATOR_VERSION` when the runner's execution/replay
 * behavior changes. Both are additive stamps — they never alter the dataset or
 * production behavior.
 */

/** The evaluation RUNNER version (execution + multi-turn replay behavior). */
export const EVALUATOR_VERSION = "eval-runner@1";

/** The SCORING engine version (scorer verdict + failure-category semantics). */
export const SCORING_VERSION = "eval-scoring@1";
