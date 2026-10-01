/**
 * FlowPilot AI Evaluation — metrics aggregation (PROMPT-AI-EVAL-03).
 *
 * Aggregates scored cases into the EVAL-01 `AggregateMetrics` plus an extended
 * block. EVERY metric is reported WITH its explicit numerator / denominator
 * (the `extended` map): a rate without a denominator is not allowed, because a
 * "100% safety" over zero safety cases means nothing. A metric whose axis is
 * not exercised has denominator 0 and value 0, and its denominator says so.
 *
 * The handoff channels are counted SEPARATELY (`handoffOutcomeClasses`) so an
 * unnecessary handoff is never hidden inside a single "handoff rate".
 */

import type { AggregateMetrics } from "../schema/evaluation-result-schema";
import type { HandoffOutcomeClass } from "../schema/taxonomy";
import type { ScorerVerdict } from "./scorers/types";
import type { ScoredCase } from "./scoring-engine";

/** A metric value carrying its explicit denominator (no naked percentages). */
export type MetricWithDenominator = {
  value: number;
  numerator: number;
  denominator: number;
};

export type ExtendedMetrics = AggregateMetrics & {
  totalTurns: number;
  actionAccuracyLimitationAdjusted: number;
  entityExtractionAccuracy: number;
  multiIntentSuccessRate: number;
  ambiguityHandlingAccuracy: number;
  clarificationAccuracy: number;
  knowledgeRequirementAccuracy: number;
  conversationStateAccuracy: number;
  bookingStateAccuracy: number;
  providerFailureRate: number;
  deterministicBypassCorrectness: number;
  /** Every rate above, with its explicit numerator + denominator. */
  denominators: Record<string, MetricWithDenominator>;
};

function ratio(numerator: number, denominator: number): MetricWithDenominator {
  return {
    numerator,
    denominator,
    value: denominator === 0 ? 0 : numerator / denominator,
  };
}

function verdictOf(sc: ScoredCase, scorer: string): ScorerVerdict | undefined {
  return sc.scorerOutcomes.find((o) => o.scorer === scorer)?.verdict;
}

/** Aggregate scored cases (and the turn count the runner replayed). */
export function aggregate(
  scored: ScoredCase[],
  totalTurns: number,
): ExtendedMetrics {
  const totalCases = scored.length;
  const nonSeam = scored.filter((s) => !s.facets.seamOwned);
  const scoredCases = nonSeam.length;

  const passCount = scored.filter((s) => s.record.verdict === "PASS").length;
  const limitationCount = scored.filter(
    (s) => s.record.verdict === "LIMITATION",
  ).length;
  const failCount = scored.filter((s) => s.record.verdict === "FAIL").length;
  const seamOwnedCount = scored.filter(
    (s) => s.record.verdict === "SEAM_OWNED",
  ).length;

  // ── intent / action ────────────────────────────────────────────────────
  const intentApplicable = nonSeam.filter(
    (s) => verdictOf(s, "intent") !== "NOT_APPLICABLE",
  );
  const intentPass = intentApplicable.filter(
    (s) => verdictOf(s, "intent") === "PASS",
  ).length;
  const intentLimit = intentApplicable.filter(
    (s) => verdictOf(s, "intent") === "LIMITATION",
  ).length;
  const actionApplicable = nonSeam.filter(
    (s) => verdictOf(s, "action") !== "NOT_APPLICABLE",
  );
  const actionPass = actionApplicable.filter(
    (s) => verdictOf(s, "action") === "PASS",
  ).length;
  const actionLimit = actionApplicable.filter(
    (s) => verdictOf(s, "action") === "LIMITATION",
  ).length;

  const intentAccuracy = ratio(intentPass, intentApplicable.length);
  const intentAccuracyLimitationAdjusted = ratio(
    intentPass + intentLimit,
    intentApplicable.length,
  );
  const actionAccuracy = ratio(actionPass, actionApplicable.length);
  const actionAccuracyLimitationAdjusted = ratio(
    actionPass + actionLimit,
    actionApplicable.length,
  );

  // ── handoff (the mandatory split) ────────────────────────────────────────
  const handed = (s: ScoredCase): boolean =>
    s.record.actual.action === "handoff" ||
    s.record.actual.action === "booking_handoff" ||
    s.record.actual.disclosure === "requires-human";
  let trueH = 0;
  let missed = 0;
  let unnecessary = 0;
  let noHandoffCorrect = 0;
  for (const s of nonSeam) {
    const exp = s.record.expected.handoffExpectation;
    const h = handed(s);
    if (exp === "REQUIRED") {
      if (h) trueH += 1;
      else missed += 1;
    } else if (exp === "NOT_REQUIRED") {
      if (h) unnecessary += 1;
      else noHandoffCorrect += 1;
    }
  }
  const handoffPrecision = ratio(trueH, trueH + unnecessary);
  const handoffRecall = ratio(trueH, trueH + missed);
  const unnecessaryHandoffRate = ratio(
    unnecessary,
    unnecessary + noHandoffCorrect,
  );
  const missedHandoffRate = ratio(missed, trueH + missed);

  // ── entity / knowledge / state axes ──────────────────────────────────────
  const axisAccuracy = (scorer: string): MetricWithDenominator => {
    const applicable = nonSeam.filter(
      (s) => verdictOf(s, scorer) !== "NOT_APPLICABLE",
    );
    const pass = applicable.filter(
      (s) => verdictOf(s, scorer) === "PASS",
    ).length;
    const limit = applicable.filter(
      (s) => verdictOf(s, scorer) === "LIMITATION",
    ).length;
    // limitation counts as "not a defect" for accuracy on these axes.
    return ratio(pass + limit, applicable.length);
  };
  const entityExtractionAccuracy = axisAccuracy("entity");
  const knowledgeRequirementAccuracy = axisAccuracy("knowledge");
  const conversationStateAccuracy = axisAccuracy("state");

  // ── booking-state accuracy (state axis restricted to booking journeys) ────
  const bookingCases = nonSeam.filter((s) => s.facets.bookingJourney);
  const bookingStatePass = bookingCases.filter(
    (s) =>
      verdictOf(s, "state") === "PASS" ||
      verdictOf(s, "state") === "LIMITATION",
  ).length;
  const bookingStateAccuracy = ratio(bookingStatePass, bookingCases.length);

  // ── multi-intent ─────────────────────────────────────────────────────────
  const multiCases = nonSeam.filter(
    (s) =>
      s.facets.isMultiIntent ||
      s.facets.edgeCategories.includes("MULTI_INTENT"),
  );
  const multiOk = multiCases.filter(
    (s) =>
      s.record.verdict !== "FAIL" &&
      s.handoffOutcomeClass !== "UNNECESSARY_HUMAN_HANDOFF",
  ).length;
  const multiIntentSuccessRate = ratio(multiOk, multiCases.length);

  // ── ambiguity ─────────────────────────────────────────────────────────────
  const ambigCases = nonSeam.filter((s) =>
    s.facets.edgeCategories.some((e) => e.startsWith("AMBIGUOUS")),
  );
  const ambigOk = ambigCases.filter(
    (s) =>
      s.handoffOutcomeClass !== "UNNECESSARY_HUMAN_HANDOFF" &&
      verdictOf(s, "intent") !== "FAIL",
  ).length;
  const ambiguityHandlingAccuracy = ratio(ambigOk, ambigCases.length);

  // ── clarification (future axis: current arch cannot CLARIFY) ─────────────
  const clarifyCases = nonSeam.filter((s) => s.facets.clarificationExpected);
  const clarifyOk = clarifyCases.filter(
    (s) => s.record.verdict === "PASS" || s.record.verdict === "LIMITATION",
  ).length;
  const clarificationAccuracy = ratio(clarifyOk, clarifyCases.length);

  // ── safety ─────────────────────────────────────────────────────────────
  const safetyCases = nonSeam.filter(
    (s) => verdictOf(s, "safety") !== "NOT_APPLICABLE",
  );
  const safetyViolations = safetyCases.filter(
    (s) => verdictOf(s, "safety") === "FAIL",
  ).length;
  const safetyViolationRate = ratio(safetyViolations, safetyCases.length);

  // ── provider / malformed / bypass ────────────────────────────────────────
  const providerFailures = nonSeam.filter(
    (s) => s.handoffOutcomeClass === "PROVIDER_FAILURE",
  ).length;
  const providerFailureRate = ratio(providerFailures, scoredCases);
  const malformed = nonSeam.filter(
    (s) => s.record.actual.malformed === true,
  ).length;
  const malformedOutputRate = ratio(malformed, scoredCases);

  const bypassCases = nonSeam.filter((s) => {
    const bypassExpected =
      (s.record.expected as Record<string, unknown>).currentIntent ===
      "GREETING";
    const bypassFired = s.record.actual.source === "deterministic-bypass";
    return bypassExpected || bypassFired;
  });
  const bypassOk = bypassCases.filter((s) => {
    const bypassExpected =
      (s.record.expected as Record<string, unknown>).currentIntent ===
      "GREETING";
    const bypassFired = s.record.actual.source === "deterministic-bypass";
    return bypassExpected === bypassFired;
  }).length;
  const deterministicBypassCorrectness = ratio(bypassOk, bypassCases.length);

  // ── handoff outcome classes (the distinct channels) ──────────────────────
  const handoffOutcomeClasses: Record<string, number> = {};
  for (const s of nonSeam) {
    const cls: HandoffOutcomeClass = s.handoffOutcomeClass;
    handoffOutcomeClasses[cls] = (handoffOutcomeClasses[cls] ?? 0) + 1;
  }

  const denominators: Record<string, MetricWithDenominator> = {
    intentAccuracy,
    intentAccuracyLimitationAdjusted,
    actionAccuracy,
    actionAccuracyLimitationAdjusted,
    handoffPrecision,
    handoffRecall,
    unnecessaryHandoffRate,
    missedHandoffRate,
    entityExtractionAccuracy,
    multiIntentSuccessRate,
    ambiguityHandlingAccuracy,
    clarificationAccuracy,
    knowledgeRequirementAccuracy,
    conversationStateAccuracy,
    bookingStateAccuracy,
    safetyViolationRate,
    providerFailureRate,
    malformedOutputRate,
    deterministicBypassCorrectness,
  };

  return {
    totalCases,
    totalTurns,
    scoredCases,
    passCount,
    limitationCount,
    failCount,
    seamOwnedCount,
    intentAccuracy: intentAccuracy.value,
    intentAccuracyLimitationAdjusted: intentAccuracyLimitationAdjusted.value,
    actionAccuracy: actionAccuracy.value,
    actionAccuracyLimitationAdjusted: actionAccuracyLimitationAdjusted.value,
    handoffPrecision: handoffPrecision.value,
    handoffRecall: handoffRecall.value,
    unnecessaryHandoffRate: unnecessaryHandoffRate.value,
    missedHandoffRate: missedHandoffRate.value,
    entityExtractionAccuracy: entityExtractionAccuracy.value,
    multiIntentSuccessRate: multiIntentSuccessRate.value,
    ambiguityHandlingAccuracy: ambiguityHandlingAccuracy.value,
    clarificationAccuracy: clarificationAccuracy.value,
    knowledgeRequirementAccuracy: knowledgeRequirementAccuracy.value,
    conversationStateAccuracy: conversationStateAccuracy.value,
    bookingStateAccuracy: bookingStateAccuracy.value,
    safetyViolationRate: safetyViolationRate.value,
    providerFailureRate: providerFailureRate.value,
    malformedOutputRate: malformedOutputRate.value,
    deterministicBypassCorrectness: deterministicBypassCorrectness.value,
    handoffOutcomeClasses,
    denominators,
  };
}
