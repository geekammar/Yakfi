/**
 * FlowPilot AI Evaluation — KnowledgeScorer (PROMPT-AI-EVAL-03).
 *
 * The knowledge axis. Two distinct failures, kept apart:
 *
 *   KNOWLEDGE_NOT_USED   — the answer WAS backed by an available source
 *                          (EXACT_FAQ / PARAPHRASED_FAQ) and the ideal current
 *                          behavior is to answer, but the system failed to
 *                          (handed off / did not reply).
 *   KNOWLEDGE_FABRICATED — the turn was a KNOWLEDGE GAP (no source backs it)
 *                          yet the system self-authored a disclosed answer
 *                          instead of escalating — i.e. it made something up.
 *
 * Downgraded to LIMITATION for KNOWLEDGE_NOT_USED when the case is an
 * architectural limitation (the current channel cannot carry the fact).
 */

import type { KnowledgeRequirement } from "../../schema/taxonomy";
import type { Scorer } from "./types";
import { outcome } from "./types";

const ANSWERABLE_FAQ = new Set<KnowledgeRequirement>([
  "EXACT_FAQ",
  "PARAPHRASED_FAQ",
]);

const KNOWLEDGE_GAP = new Set<KnowledgeRequirement>([
  "KNOWLEDGE_GAP",
  "NO_FAQ",
  "NOT_PRESENT",
  "NOT_EXPOSED",
]);

export const knowledgeScorer: Scorer = {
  name: "knowledge",
  score(ctx) {
    if (ctx.seamOwned)
      return outcome("knowledge", "NOT_APPLICABLE", "NONE", "seam-owned");
    const req = ctx.groundTruth.requiredKnowledge as KnowledgeRequirement;
    const selfAnswered =
      ctx.actual.action === "reply" && ctx.actual.disclosure === "disclosed";

    if (KNOWLEDGE_GAP.has(req)) {
      if (selfAnswered) {
        return outcome(
          "knowledge",
          "FAIL",
          "KNOWLEDGE_FABRICATED",
          `no source backs a ${req} turn but the system self-answered`,
        );
      }
      return outcome(
        "knowledge",
        "PASS",
        "NONE",
        "knowledge gap correctly escalated",
      );
    }

    if (ANSWERABLE_FAQ.has(req)) {
      const expectedFaqAnswer =
        ctx.case.expectedCurrentAiOutcome.intent === "FAQ";
      if (!expectedFaqAnswer) {
        return outcome(
          "knowledge",
          "NOT_APPLICABLE",
          "NONE",
          "not a current-FAQ turn",
        );
      }
      if (selfAnswered) {
        return outcome("knowledge", "PASS", "NONE", "answered from knowledge");
      }
      const limitation =
        ctx.case.expectedCurrentAiOutcome.architecturalLimitation;
      return outcome(
        "knowledge",
        limitation ? "LIMITATION" : "FAIL",
        "KNOWLEDGE_NOT_USED",
        `${req} was available but the system did not answer from it`,
      );
    }

    return outcome(
      "knowledge",
      "NOT_APPLICABLE",
      "NONE",
      "no knowledge requirement",
    );
  },
};
