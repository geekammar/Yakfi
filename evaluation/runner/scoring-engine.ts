/**
 * FlowPilot AI Evaluation — scoring engine (PROMPT-AI-EVAL-03).
 *
 * Turns one case's ACTUAL outcome into a closed, comparable `CaseResultRecord`
 * (EVAL-01 schema) by running the pluggable scorers and combining their
 * verdicts:
 *
 *   verdict          = SEAM_OWNED (engine-owned turn) OR the worst scorer
 *                      verdict: any FAIL → FAIL; else any LIMITATION →
 *                      LIMITATION; else PASS.
 *   failureCategory  = the failure category of the FIRST failing scorer in the
 *                      registry's severity order (safety → handoff → …), so a
 *                      case is filed under its primary failure. Closed set, so
 *                      runs stay comparable across dataset + system versions.
 *
 * The engine never reads response wording as the correctness gate — it only
 * combines the structured scorer outcomes. It never throws.
 */

import type { EvaluationCase } from "../schema/dataset-schema";
import type {
  ActualOutcome,
  CaseResultRecord,
} from "../schema/evaluation-result-schema";
import { groundTruthFromCase } from "../schema/ground-truth-schema";
import type { FailureCategory, HandoffOutcomeClass } from "../schema/taxonomy";
import { DEFAULT_SCORERS } from "./scorers";
import type { Scorer, ScorerOutcome, ScoringContext } from "./scorers/types";

export type ScoredCase = {
  record: CaseResultRecord;
  /** Per-scorer breakdown, retained for filtered reporting + debugging. */
  scorerOutcomes: ScorerOutcome[];
  /** The resolved handoff outcome class (the distinct channel). */
  handoffOutcomeClass: HandoffOutcomeClass;
  /** Convenience mirror of the case's axes used by report filters. */
  facets: {
    edgeCategories: string[];
    rarity: string;
    languageRegister: string;
    orientation: string;
    conversationType: string;
    semanticPrimaryIntent: string;
    isMultiIntent: boolean;
    seamOwned: boolean;
    clarificationExpected: boolean;
    bookingJourney: boolean;
  };
};

function handedOffFrom(actual: ActualOutcome): boolean {
  return (
    actual.action === "handoff" ||
    actual.action === "booking_handoff" ||
    actual.disclosure === "requires-human"
  );
}

/** Score ONE case against its actual outcome with the given scorer set. */
export function scoreCase(
  c: EvaluationCase,
  actual: ActualOutcome,
  scorers: readonly Scorer[] = DEFAULT_SCORERS,
): ScoredCase {
  const groundTruth = groundTruthFromCase(c);
  const seamOwned = c.engineOwner !== "AI";
  const handedOff = handedOffFrom(actual);
  const malformed = actual.malformed === true;

  const ctx: ScoringContext = {
    case: c,
    groundTruth,
    actual,
    seamOwned,
    handedOff,
    malformed,
  };

  const scorerOutcomes = scorers.map((s) => s.score(ctx));

  // Resolve the handoff channel from the handoff scorer (fallback to whatever
  // the target already asserted, else NO_HANDOFF).
  const handoffDetail = scorerOutcomes.find((o) => o.scorer === "handoff");
  const handoffOutcomeClass: HandoffOutcomeClass =
    (handoffDetail?.detail?.handoffOutcomeClass as HandoffOutcomeClass) ??
    (actual.handoffOutcomeClass as HandoffOutcomeClass) ??
    "NO_HANDOFF";

  // Combine verdicts.
  let verdict: CaseResultRecord["verdict"];
  let failureCategory: FailureCategory;
  let reason: string;
  if (seamOwned) {
    verdict = "SEAM_OWNED";
    failureCategory = "NONE";
    reason = `engine-owned seam (${c.engineOwner})`;
  } else if (malformed) {
    verdict = "FAIL";
    failureCategory = "MALFORMED_OUTPUT";
    reason = "the output violated the response contract";
  } else {
    const firstFail = scorerOutcomes.find((o) => o.verdict === "FAIL");
    const firstLimitation = scorerOutcomes.find(
      (o) => o.verdict === "LIMITATION",
    );
    if (firstFail) {
      verdict = "FAIL";
      failureCategory = firstFail.failureCategory;
      reason = `${firstFail.scorer}: ${firstFail.reason}`;
    } else if (firstLimitation) {
      verdict = "LIMITATION";
      failureCategory = firstLimitation.failureCategory;
      reason = `${firstLimitation.scorer}: ${firstLimitation.reason}`;
    } else {
      verdict = "PASS";
      failureCategory = "NONE";
      reason = "all axes passed";
    }
  }

  const enrichedActual: ActualOutcome = {
    ...actual,
    handoffOutcomeClass,
  };

  const record: CaseResultRecord = {
    caseId: c.caseId,
    scenarioId: c.scenarioId,
    datasetVersion: c.datasetVersion,
    expected: {
      primaryIntent: groundTruth.primaryIntent,
      secondaryIntents: groundTruth.secondaryIntents,
      expectedAction: groundTruth.expectedAction,
      handoffExpectation: groundTruth.expectedHandoff.expectation,
      safetyExpectation: groundTruth.safetyExpectation,
      // passthrough extras — the current-contract expectation the scorers used
      currentIntent: c.expectedCurrentAiOutcome.intent,
      currentAction: c.expectedCurrentAiOutcome.action,
      currentHandoffReason: c.expectedCurrentAiOutcome.handoffReason,
      architecturalLimitation:
        c.expectedCurrentAiOutcome.architecturalLimitation,
      requiredKnowledge: groundTruth.requiredKnowledge,
    },
    actual: enrichedActual,
    verdict,
    failureCategory,
    reason: reason.slice(0, 500),
    // passthrough: compact scorer breakdown for traceability
    scorers: Object.fromEntries(
      scorerOutcomes.map((o) => [o.scorer, o.verdict]),
    ),
  };

  return {
    record,
    scorerOutcomes,
    handoffOutcomeClass,
    facets: {
      edgeCategories: c.edgeCategories,
      rarity: c.rarity,
      languageRegister: c.languageProfile.register,
      orientation: c.orientation,
      conversationType: c.conversationType,
      semanticPrimaryIntent: c.expectedSemanticLabel.primaryIntent,
      isMultiIntent: groundTruth.isMultiIntent,
      seamOwned,
      clarificationExpected: groundTruth.expectedClarification !== "NONE",
      bookingJourney: c.edgeCategories.includes("BOOKING_JOURNEY"),
    },
  };
}
