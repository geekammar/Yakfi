/**
 * FlowPilot AI Evaluation — ActionScorer (PROMPT-AI-EVAL-03).
 *
 * Compares the actual production action (`reply` | `handoff` |
 * `booking_handoff`) against `expectedCurrentAiOutcome.action`. Downgraded to
 * LIMITATION when the case is an architectural limitation.
 */

import type { Scorer } from "./types";
import { outcome } from "./types";

export const actionScorer: Scorer = {
  name: "action",
  score(ctx) {
    if (ctx.seamOwned)
      return outcome("action", "NOT_APPLICABLE", "NONE", "seam-owned");
    const expected = ctx.case.expectedCurrentAiOutcome.action;
    const actual = ctx.actual.action ?? "";
    const limitation =
      ctx.case.expectedCurrentAiOutcome.architecturalLimitation;
    if (actual === expected) {
      return outcome("action", "PASS", "NONE", `action ${actual}`);
    }
    return outcome(
      "action",
      limitation ? "LIMITATION" : "FAIL",
      "ACTION_WRONG",
      `expected ${expected}, got ${actual || "∅"}`,
    );
  },
};
