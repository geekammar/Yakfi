/**
 * FlowPilot AI Evaluation — IntentScorer (PROMPT-AI-EVAL-03).
 *
 * Compares the actual production intent against the case's
 * `expectedCurrentAiOutcome.intent`. When the case is marked
 * `architecturalLimitation`, a mismatch is a LIMITATION (the current 8-intent
 * contract cannot represent the customer's goal), reported separately from a
 * genuine FAIL.
 */

import type { Scorer } from "./types";
import { outcome } from "./types";

export const intentScorer: Scorer = {
  name: "intent",
  score(ctx) {
    if (ctx.seamOwned)
      return outcome("intent", "NOT_APPLICABLE", "NONE", "seam-owned");
    const expected = ctx.case.expectedCurrentAiOutcome.intent;
    const actual = ctx.actual.intent ?? "";
    const limitation =
      ctx.case.expectedCurrentAiOutcome.architecturalLimitation;
    if (actual === expected) {
      return outcome("intent", "PASS", "NONE", `intent ${actual}`);
    }
    return outcome(
      "intent",
      limitation ? "LIMITATION" : "FAIL",
      "INTENT_MISCLASSIFIED",
      `expected ${expected}, got ${actual || "∅"}`,
    );
  },
};
