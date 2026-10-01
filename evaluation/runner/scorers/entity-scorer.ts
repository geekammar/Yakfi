/**
 * FlowPilot AI Evaluation — EntityScorer (PROMPT-AI-EVAL-03).
 *
 * Compares extracted FACTS (service) against the gold entities, using the
 * production Arabic normalizer so `تنظيف` / `تنضيف` are treated as equal. Two
 * distinct failure modes are kept apart:
 *
 *   EXTRACTION_MISSED       — a service was expected but none / a different one
 *                             was surfaced.
 *   EXTRACTION_HALLUCINATED — no service was expected (a greeting / FAQ turn)
 *                             but the system invented one.
 *
 * Only turns that actually exercise extraction are scored; everything else is
 * NOT_APPLICABLE, so the accuracy denominator is honest.
 */

import { normalizeArabicText } from "@/features/conversations/server/conversation-ai";

import type { Scorer } from "./types";
import { outcome } from "./types";

const NO_ENTITY_INTENTS = new Set<string>(["GREETING", "FAQ"]);

export const entityScorer: Scorer = {
  name: "entity",
  score(ctx) {
    if (ctx.seamOwned)
      return outcome("entity", "NOT_APPLICABLE", "NONE", "seam-owned");
    const gold = ctx.groundTruth.expectedEntities.service ?? null;
    const actual = ctx.actual.extraction?.service ?? null;

    if (gold !== null) {
      if (actual === null) {
        return outcome(
          "entity",
          "FAIL",
          "EXTRACTION_MISSED",
          `expected service "${gold}", got none`,
        );
      }
      if (normalizeArabicText(actual) === normalizeArabicText(gold)) {
        return outcome("entity", "PASS", "NONE", `service "${actual}"`);
      }
      return outcome(
        "entity",
        "FAIL",
        "EXTRACTION_HALLUCINATED",
        `expected service "${gold}", got a different "${actual}"`,
      );
    }

    // No service expected: only flag a hallucination on turns that clearly
    // carry no entity (greeting / FAQ). Elsewhere, absence is not scored.
    const intent = ctx.groundTruth.primaryIntent;
    if (NO_ENTITY_INTENTS.has(intent)) {
      if (actual === null)
        return outcome("entity", "PASS", "NONE", "no service, correctly");
      return outcome(
        "entity",
        "FAIL",
        "EXTRACTION_HALLUCINATED",
        `no service expected on a ${intent} turn, got "${actual}"`,
      );
    }
    return outcome(
      "entity",
      "NOT_APPLICABLE",
      "NONE",
      "extraction not exercised",
    );
  },
};
