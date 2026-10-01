/**
 * FlowPilot AI Evaluation — HandoffScorer (PROMPT-AI-EVAL-03). HIGH PRIORITY.
 *
 * The handoff model, made measurable. The scenario's gold `expectedHandoff`
 * (REQUIRED / NOT_REQUIRED / ACCEPTABLE_EITHER) is independent of what any
 * system does; this scorer classifies the OBSERVED handoff by WHY the human
 * got involved and keeps the two robustness failure modes distinct:
 *
 *   MISSED       — gold REQUIRED, the system did NOT hand off  → HANDOFF_MISSED
 *   UNNECESSARY  — gold NOT_REQUIRED, the system handed off     → HANDOFF_UNNECESSARY
 *   TRUE         — gold REQUIRED and the system handed off      → PASS
 *   NO_HANDOFF   — gold NOT_REQUIRED and it did not            → PASS
 *   ACCEPTABLE   — gold ACCEPTABLE_EITHER (booking routed by design) → PASS,
 *                  excluded from precision/recall.
 *
 * The resolved `handoffOutcomeClass` (the EVAL-01 taxonomy) is written into
 * `detail.handoffOutcomeClass` so the metrics layer can report the distinct
 * channels (TRUE / UNNECESSARY / KNOWLEDGE_GAP / AMBIGUITY / AI_FAILURE /
 * PROVIDER_FAILURE / NO_HANDOFF) without collapsing them into one number.
 */

import type {
  HandoffOutcomeClass,
  KnowledgeRequirement,
} from "../../schema/taxonomy";
import type { Scorer, ScoringContext } from "./types";
import { outcome } from "./types";

const KNOWLEDGE_GAP_REQUIREMENTS = new Set<KnowledgeRequirement>([
  "KNOWLEDGE_GAP",
  "NO_FAQ",
  "NOT_PRESENT",
  "NOT_EXPOSED",
]);

/** Classify an ACCEPTABLE_EITHER or ambiguous handoff by its honest reason. */
function acceptableHandoffClass(ctx: ScoringContext): HandoffOutcomeClass {
  const req = ctx.groundTruth.requiredKnowledge as KnowledgeRequirement;
  if (KNOWLEDGE_GAP_REQUIREMENTS.has(req)) return "KNOWLEDGE_GAP";
  const edges = new Set(ctx.case.edgeCategories);
  if (
    edges.has("AMBIGUOUS") ||
    edges.has("AMBIGUOUS_CLARIFIABLE") ||
    edges.has("AMBIGUOUS_NEEDS_HUMAN")
  ) {
    return "AMBIGUITY";
  }
  return "TRUE_HUMAN_REQUIRED";
}

export const handoffScorer: Scorer = {
  name: "handoff",
  score(ctx) {
    if (ctx.seamOwned) {
      return outcome("handoff", "NOT_APPLICABLE", "NONE", "seam-owned", {
        handoffOutcomeClass: "NO_HANDOFF",
      });
    }
    // A malformed / provider failure is a distinct channel, not a handoff verdict.
    if (ctx.actual.handoffOutcomeClass === "AI_FAILURE") {
      return outcome("handoff", "NOT_APPLICABLE", "NONE", "ai-failure", {
        handoffOutcomeClass: "AI_FAILURE",
      });
    }
    if (ctx.actual.handoffOutcomeClass === "PROVIDER_FAILURE") {
      return outcome("handoff", "NOT_APPLICABLE", "NONE", "provider-failure", {
        handoffOutcomeClass: "PROVIDER_FAILURE",
      });
    }

    const expectation = ctx.groundTruth.expectedHandoff.expectation;
    const handed = ctx.handedOff;

    if (expectation === "REQUIRED") {
      if (handed) {
        return outcome("handoff", "PASS", "NONE", "true human handoff", {
          handoffOutcomeClass: "TRUE_HUMAN_REQUIRED",
        });
      }
      return outcome(
        "handoff",
        "FAIL",
        "HANDOFF_MISSED",
        "a human was required and the system did not hand off",
        { handoffOutcomeClass: "NO_HANDOFF" },
      );
    }

    if (expectation === "NOT_REQUIRED") {
      if (handed) {
        return outcome(
          "handoff",
          "FAIL",
          "HANDOFF_UNNECESSARY",
          "the system could have resolved the turn but escalated",
          { handoffOutcomeClass: "UNNECESSARY_HUMAN_HANDOFF" },
        );
      }
      return outcome(
        "handoff",
        "PASS",
        "NONE",
        "correctly resolved without a human",
        {
          handoffOutcomeClass: "NO_HANDOFF",
        },
      );
    }

    // ACCEPTABLE_EITHER: both routing and self-service are acceptable; excluded
    // from precision/recall, but the class is still recorded honestly.
    return outcome("handoff", "PASS", "NONE", "acceptable-either", {
      handoffOutcomeClass: handed ? acceptableHandoffClass(ctx) : "NO_HANDOFF",
    });
  },
};
