/**
 * FlowPilot — Physical Attempt Cost Calculation Engine
 * (flowpilot.cost.engine@v1)
 *
 * Implements pure, per-attempt cost evaluation with explicit provenance,
 * strict pool separation, and non-zero unknown cost accounting.
 *
 * Binding rules:
 * - Provider-reported cost is evaluated first (including valid zero cost).
 * - Matching dated rate snapshot is evaluated second.
 * - Missing or unresolvable attempts evaluate to UNKNOWN (cost = null; never coerced to zero).
 * - Status codes (0, 401, 403, 429, TIMEOUT) NEVER imply zero cost unless zero dispatch is proven.
 * - Locally prevented executions (proven zero dispatch) incur 0 external cost and are excluded
 *   from dispatched attempt denominator.
 * - Token caching applies without double counting (cached vs uncached prompt tokens).
 * - High-precision arithmetic: micro-costs are not rounded prematurely.
 * - Coverage numerator and denominator count the exact same dispatched unit; zero denominator yields null (N/A).
 */

import {
  COST_ENGINE_VERSION,
  type AttemptCostResult,
  type CostCompleteness,
  type ModelRateSnapshot,
  type PhysicalAttemptFact,
  type PoolCostSummary,
  type TrafficPool,
  type TurnCostResult,
} from "./types";

/**
 * Format a USD cost value with standard 6-decimal micro-precision ($0.000000).
 * Preserves high precision internally; formats for export/reporting only.
 */
export function formatMicroUsd(cost: number | null): string | null {
  if (cost === null || !Number.isFinite(cost)) return null;
  return cost.toFixed(6);
}

/**
 * Find a matching rate snapshot for an attempt.
 */
function findMatchingRateSnapshot(
  attempt: PhysicalAttemptFact,
  rateSnapshots?: ReadonlyArray<ModelRateSnapshot>,
): ModelRateSnapshot | undefined {
  if (!rateSnapshots || rateSnapshots.length === 0 || !attempt.model) return undefined;
  const targetProvider = attempt.provider.trim().toLowerCase();
  const targetModel = attempt.model.trim().toLowerCase();

  return rateSnapshots.find(
    (s) =>
      s.provider.trim().toLowerCase() === targetProvider &&
      s.model.trim().toLowerCase() === targetModel,
  );
}

/**
 * Evaluate cost and provenance for ONE physical attempt.
 */
export function evaluateAttemptCost(
  attempt: PhysicalAttemptFact,
  rateSnapshots?: ReadonlyArray<ModelRateSnapshot>,
): AttemptCostResult {
  const pool = attempt.trafficPool ?? "SERVING";

  // Case 1: Locally prevented zero dispatch (proven zero wire requests).
  if (attempt.locallyPreventedZeroDispatch === true) {
    return {
      attemptId: attempt.attemptId,
      attemptIndex: attempt.attemptIndex,
      trafficPool: pool,
      provider: attempt.provider,
      model: attempt.model ?? null,
      isDispatched: false,
      costUsd: 0,
      provenance: "ZERO_DISPATCH_PREVENTED",
      completeness: "KNOWN",
      uncachedInputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    };
  }

  // Case 2: Provider-reported cost present directly in response payload.
  // Note: reportedCostUsd === 0 is valid and respected.
  if (
    typeof attempt.reportedCostUsd === "number" &&
    Number.isFinite(attempt.reportedCostUsd) &&
    attempt.reportedCostUsd >= 0
  ) {
    return {
      attemptId: attempt.attemptId,
      attemptIndex: attempt.attemptIndex,
      trafficPool: pool,
      provider: attempt.provider,
      model: attempt.model ?? null,
      isDispatched: true,
      costUsd: attempt.reportedCostUsd,
      provenance: "PROVIDER_REPORTED",
      completeness: "KNOWN",
      uncachedInputTokens: attempt.inputTokens ?? null,
      cachedInputTokens: attempt.cachedInputTokens ?? null,
      outputTokens: attempt.outputTokens ?? null,
    };
  }

  // Case 3: Rate snapshot derivation.
  const snapshot = findMatchingRateSnapshot(attempt, rateSnapshots);
  const inputTokens = attempt.inputTokens;
  const outputTokens = attempt.outputTokens;

  const hasValidTokenCounts =
    typeof inputTokens === "number" &&
    Number.isFinite(inputTokens) &&
    inputTokens >= 0 &&
    typeof outputTokens === "number" &&
    Number.isFinite(outputTokens) &&
    outputTokens >= 0;

  if (snapshot && hasValidTokenCounts) {
    const rawCached = attempt.cachedInputTokens;
    const cachedTokens =
      typeof rawCached === "number" && Number.isFinite(rawCached) && rawCached >= 0
        ? Math.min(rawCached, inputTokens)
        : 0;

    const uncachedTokens = inputTokens - cachedTokens;
    const promptRate = snapshot.promptCostPerMillionUsd;
    const cachedPromptRate =
      typeof snapshot.cachedPromptCostPerMillionUsd === "number" &&
      snapshot.cachedPromptCostPerMillionUsd >= 0
        ? snapshot.cachedPromptCostPerMillionUsd
        : promptRate;
    const completionRate = snapshot.completionCostPerMillionUsd;

    // High precision calculation in USD:
    // (uncachedTokens * promptRate + cachedTokens * cachedPromptRate + outputTokens * completionRate) / 1,000,000
    const calculatedCost =
      (uncachedTokens * promptRate +
        cachedTokens * cachedPromptRate +
        outputTokens * completionRate) /
      1_000_000;

    return {
      attemptId: attempt.attemptId,
      attemptIndex: attempt.attemptIndex,
      trafficPool: pool,
      provider: attempt.provider,
      model: attempt.model ?? null,
      isDispatched: true,
      costUsd: calculatedCost,
      provenance: "RATE_SNAPSHOT",
      completeness: "KNOWN",
      snapshotId: snapshot.snapshotId,
      uncachedInputTokens: uncachedTokens,
      cachedInputTokens: cachedTokens,
      outputTokens: outputTokens,
    };
  }

  // Case 4: Unknown cost.
  // Rule: Do NOT infer zero cost from HTTP error status or timeouts.
  return {
    attemptId: attempt.attemptId,
    attemptIndex: attempt.attemptIndex,
    trafficPool: pool,
    provider: attempt.provider,
    model: attempt.model ?? null,
    isDispatched: true,
    costUsd: null,
    provenance: "UNKNOWN",
    completeness: "UNKNOWN",
    uncachedInputTokens: attempt.inputTokens ?? null,
    cachedInputTokens: attempt.cachedInputTokens ?? null,
    outputTokens: attempt.outputTokens ?? null,
  };
}

/**
 * Aggregate attempts into pool summaries.
 */
function aggregatePoolSummary(
  pool: TrafficPool,
  attemptResults: ReadonlyArray<AttemptCostResult>,
): PoolCostSummary {
  const poolAttempts = attemptResults.filter((a) => a.trafficPool === pool);

  let dispatchedAttempts = 0;
  let knownAttempts = 0;
  let unknownAttempts = 0;
  let locallyPreventedAttempts = 0;
  let knownSubtotalUsd = 0;

  for (const a of poolAttempts) {
    if (!a.isDispatched) {
      locallyPreventedAttempts += 1;
      continue;
    }
    dispatchedAttempts += 1;
    if (a.completeness === "KNOWN" && a.costUsd !== null) {
      knownAttempts += 1;
      knownSubtotalUsd += a.costUsd;
    } else {
      unknownAttempts += 1;
    }
  }

  // Determine completeness
  let costCompleteness: CostCompleteness;
  let totalCostUsd: number | null = null;
  let coverageRatio: number | null = null;
  let coveragePercentage: string | null = null;

  if (dispatchedAttempts === 0) {
    costCompleteness = "COMPLETE";
    totalCostUsd = knownSubtotalUsd; // 0
    coverageRatio = null;
    coveragePercentage = null; // N/A
  } else if (unknownAttempts === 0) {
    costCompleteness = "COMPLETE";
    totalCostUsd = knownSubtotalUsd;
    coverageRatio = 1.0;
    coveragePercentage = "100.0%";
  } else if (knownAttempts > 0) {
    costCompleteness = "PARTIAL";
    totalCostUsd = null; // Cannot state total cost if some dispatched attempts are unknown
    coverageRatio = knownAttempts / dispatchedAttempts;
    coveragePercentage = `${(coverageRatio * 100).toFixed(1)}%`;
  } else {
    costCompleteness = "UNAVAILABLE";
    totalCostUsd = null;
    coverageRatio = 0.0;
    coveragePercentage = "0.0%";
  }

  return {
    trafficPool: pool,
    dispatchedAttempts,
    knownAttempts,
    unknownAttempts,
    locallyPreventedAttempts,
    totalCostUsd,
    knownSubtotalUsd,
    costCompleteness,
    coverageRatio,
    coveragePercentage,
  };
}

/**
 * Pure turn cost calculation engine.
 * Evaluates each physical attempt, preserves pool isolation, and derives coverage.
 */
export function evaluateTurnCost(
  attempts: ReadonlyArray<PhysicalAttemptFact>,
  rateSnapshots?: ReadonlyArray<ModelRateSnapshot>,
): TurnCostResult {
  const attemptResults = attempts.map((a) => evaluateAttemptCost(a, rateSnapshots));

  const pools: Record<TrafficPool, PoolCostSummary> = {
    SERVING: aggregatePoolSummary("SERVING", attemptResults),
    SHADOW: aggregatePoolSummary("SHADOW", attemptResults),
    TEST: aggregatePoolSummary("TEST", attemptResults),
  };

  return {
    schema: COST_ENGINE_VERSION,
    attempts: attemptResults,
    pools,
    serving: pools.SERVING,
    shadow: pools.SHADOW,
    test: pools.TEST,
  };
}
