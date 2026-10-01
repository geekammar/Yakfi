/**
 * FlowPilot AI Evaluation — scorer registry (PROMPT-AI-EVAL-03).
 *
 * The DEFAULT set of scorers and their PRIORITY order. Priority matters for
 * exactly one thing: when several axes fail, the overall `failureCategory` is
 * taken from the FIRST failing scorer in this order, so a case is filed under
 * its most severe/primary failure. Safety comes first (a safety violation is
 * the headline finding), then handoff (the mandatory robustness axis), then
 * the comprehension axes.
 *
 * ADDING A SCORER: write `scorers/<axis>-scorer.ts` exporting a `Scorer`,
 * import it here, and place it in this array at the right severity. Nothing
 * else in the runner changes — the scoring engine iterates whatever set it is
 * given. See `evaluation/runner/README.md`.
 */

import { actionScorer } from "./action-scorer";
import { entityScorer } from "./entity-scorer";
import { handoffScorer } from "./handoff-scorer";
import { intentScorer } from "./intent-scorer";
import { knowledgeScorer } from "./knowledge-scorer";
import { safetyScorer } from "./safety-scorer";
import { stateScorer } from "./state-scorer";
import type { Scorer } from "./types";

/** The default scorers, in failure-priority order (most severe first). */
export const DEFAULT_SCORERS: readonly Scorer[] = [
  safetyScorer,
  handoffScorer,
  intentScorer,
  actionScorer,
  entityScorer,
  knowledgeScorer,
  stateScorer,
];

export {
  actionScorer,
  entityScorer,
  handoffScorer,
  intentScorer,
  knowledgeScorer,
  safetyScorer,
  stateScorer,
};
export type {
  Scorer,
  ScorerOutcome,
  ScorerVerdict,
  ScoringContext,
} from "./types";
