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
 * - Historical rate selection: rates effective after attemptTimestamp never apply.
 *   Array reversal/shuffling yields identical selection. Conflicting snapshots throw Error.
 * - Missing or unresolvable attempts evaluate to UNKNOWN (cost = null; never coerced to zero).
 * - Status codes (0, 401, 403, 429, TIMEOUT) NEVER imply zero cost unless zero dispatch is proven.
 * - Locally prevented executions (proven zero dispatch) incur 0 external cost and are excluded
 *   from dispatched attempt denominator.
 * - Token caching applies without double counting (cached vs uncached prompt tokens).
 * - Full unrounded precision in accumulators (IEEE 754 64-bit float; binary float, not exact decimal).
 * - Explicit content-free output projection stripping arbitrary caller properties.
 */

import { toCanonicalTimestampMs } from "./session-measurement";
import {
  COST_ENGINE_VERSION,
  TRAFFIC_POOLS,
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
 * Validate a ModelRateSnapshot runtime object.
 */
function validateRateSnapshot(s: unknown): ModelRateSnapshot {
  if (typeof s !== "object" || s === null) {
    throw new Error("ModelRateSnapshot must be a non-null object");
  }
  const snap = s as Record<string, unknown>;

  if (
    typeof snap.snapshotId !== "string" ||
    snap.snapshotId.trim().length === 0
  ) {
    throw new Error("ModelRateSnapshot.snapshotId must be a non-empty string");
  }
  if (typeof snap.provider !== "string" || snap.provider.trim().length === 0) {
    throw new Error("ModelRateSnapshot.provider must be a non-empty string");
  }
  if (typeof snap.model !== "string" || snap.model.trim().length === 0) {
    throw new Error("ModelRateSnapshot.model must be a non-empty string");
  }
  if (
    typeof snap.effectiveDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(snap.effectiveDate.trim())
  ) {
    throw new Error(
      `ModelRateSnapshot.effectiveDate must be in YYYY-MM-DD format; received '${String(snap.effectiveDate)}'`,
    );
  }
  if (
    typeof snap.promptCostPerMillionUsd !== "number" ||
    !Number.isFinite(snap.promptCostPerMillionUsd) ||
    snap.promptCostPerMillionUsd < 0
  ) {
    throw new Error(
      "ModelRateSnapshot.promptCostPerMillionUsd must be a finite non-negative number",
    );
  }
  if (
    typeof snap.completionCostPerMillionUsd !== "number" ||
    !Number.isFinite(snap.completionCostPerMillionUsd) ||
    snap.completionCostPerMillionUsd < 0
  ) {
    throw new Error(
      "ModelRateSnapshot.completionCostPerMillionUsd must be a finite non-negative number",
    );
  }
  if (
    snap.cachedPromptCostPerMillionUsd !== undefined &&
    snap.cachedPromptCostPerMillionUsd !== null &&
    (typeof snap.cachedPromptCostPerMillionUsd !== "number" ||
      !Number.isFinite(snap.cachedPromptCostPerMillionUsd) ||
      snap.cachedPromptCostPerMillionUsd < 0)
  ) {
    throw new Error(
      "ModelRateSnapshot.cachedPromptCostPerMillionUsd must be a finite non-negative number when specified",
    );
  }
  if (typeof snap.source !== "string" || snap.source.trim().length === 0) {
    throw new Error("ModelRateSnapshot.source must be a non-empty string");
  }

  return {
    snapshotId: snap.snapshotId.trim(),
    provider: snap.provider.trim(),
    model: snap.model.trim(),
    effectiveDate: snap.effectiveDate.trim(),
    promptCostPerMillionUsd: snap.promptCostPerMillionUsd,
    cachedPromptCostPerMillionUsd:
      snap.cachedPromptCostPerMillionUsd !== undefined &&
      snap.cachedPromptCostPerMillionUsd !== null
        ? snap.cachedPromptCostPerMillionUsd
        : null,
    completionCostPerMillionUsd: snap.completionCostPerMillionUsd,
    source: snap.source.trim(),
  };
}

/**
 * Validate rate snapshots array and detect ambiguous conflicting definitions.
 */
function validateRateSnapshots(
  rateSnapshots?: ReadonlyArray<ModelRateSnapshot>,
): ReadonlyArray<ModelRateSnapshot> {
  if (!rateSnapshots || rateSnapshots.length === 0) return [];

  const validated: ModelRateSnapshot[] = [];
  const seenSnapshots = new Map<string, ModelRateSnapshot>();

  for (const raw of rateSnapshots) {
    const snap = validateRateSnapshot(raw);
    const key = `${snap.provider.toLowerCase()}:${snap.model.toLowerCase()}:${snap.effectiveDate}`;

    const existing = seenSnapshots.get(key);
    if (existing) {
      const hasConflict =
        existing.snapshotId !== snap.snapshotId ||
        existing.promptCostPerMillionUsd !== snap.promptCostPerMillionUsd ||
        existing.cachedPromptCostPerMillionUsd !==
          snap.cachedPromptCostPerMillionUsd ||
        existing.completionCostPerMillionUsd !==
          snap.completionCostPerMillionUsd;

      if (hasConflict) {
        throw new Error(
          `Ambiguous conflicting rate snapshots for provider '${snap.provider}', model '${snap.model}', effectiveDate '${snap.effectiveDate}'`,
        );
      }
    } else {
      seenSnapshots.set(key, snap);
      validated.push(snap);
    }
  }

  return validated;
}

/**
 * Validate PhysicalAttemptFact runtime properties and check for contradictory evidence.
 */
function validateAttemptFact(raw: unknown): PhysicalAttemptFact {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("PhysicalAttemptFact must be a non-null object");
  }
  const att = raw as Record<string, unknown>;

  if (typeof att.attemptId !== "string" || att.attemptId.trim().length === 0) {
    throw new Error("PhysicalAttemptFact.attemptId must be a non-empty string");
  }
  if (
    typeof att.attemptIndex !== "number" ||
    !Number.isSafeInteger(att.attemptIndex) ||
    att.attemptIndex < 0
  ) {
    throw new Error(
      "PhysicalAttemptFact.attemptIndex must be a non-negative safe integer",
    );
  }

  const pool: TrafficPool =
    att.trafficPool === undefined
      ? "SERVING"
      : (att.trafficPool as TrafficPool);
  if (!TRAFFIC_POOLS.includes(pool)) {
    throw new Error(
      `PhysicalAttemptFact.trafficPool must be one of ${TRAFFIC_POOLS.join(", ")}; received '${String(att.trafficPool)}'`,
    );
  }

  if (typeof att.provider !== "string" || att.provider.trim().length === 0) {
    throw new Error("PhysicalAttemptFact.provider must be a non-empty string");
  }
  if (att.status !== "SUCCESS" && att.status !== "FAILURE") {
    throw new Error(
      `PhysicalAttemptFact.status must be 'SUCCESS' or 'FAILURE'; received '${String(att.status)}'`,
    );
  }

  // Token validations
  if (
    att.inputTokens !== undefined &&
    att.inputTokens !== null &&
    (typeof att.inputTokens !== "number" ||
      !Number.isSafeInteger(att.inputTokens) ||
      att.inputTokens < 0)
  ) {
    throw new Error(
      "PhysicalAttemptFact.inputTokens must be a non-negative safe integer or null",
    );
  }

  if (
    att.outputTokens !== undefined &&
    att.outputTokens !== null &&
    (typeof att.outputTokens !== "number" ||
      !Number.isSafeInteger(att.outputTokens) ||
      att.outputTokens < 0)
  ) {
    throw new Error(
      "PhysicalAttemptFact.outputTokens must be a non-negative safe integer or null",
    );
  }

  if (
    att.cachedInputTokens !== undefined &&
    att.cachedInputTokens !== null &&
    (typeof att.cachedInputTokens !== "number" ||
      !Number.isSafeInteger(att.cachedInputTokens) ||
      att.cachedInputTokens < 0)
  ) {
    throw new Error(
      "PhysicalAttemptFact.cachedInputTokens must be a non-negative safe integer or null",
    );
  }

  // Caching invariant: cachedInputTokens cannot exceed inputTokens
  if (
    att.cachedInputTokens !== undefined &&
    att.cachedInputTokens !== null &&
    att.inputTokens !== undefined &&
    att.inputTokens !== null &&
    att.cachedInputTokens > att.inputTokens
  ) {
    throw new Error(
      `cachedInputTokens (${String(att.cachedInputTokens)}) cannot exceed inputTokens (${String(att.inputTokens)})`,
    );
  }

  // Reported cost validation
  if (
    att.reportedCostUsd !== undefined &&
    att.reportedCostUsd !== null &&
    (typeof att.reportedCostUsd !== "number" ||
      !Number.isFinite(att.reportedCostUsd) ||
      att.reportedCostUsd < 0)
  ) {
    throw new Error(
      "PhysicalAttemptFact.reportedCostUsd must be a finite non-negative number or null",
    );
  }

  // Zero-dispatch contradiction check
  const isZeroDispatch = att.locallyPreventedZeroDispatch === true;
  if (isZeroDispatch) {
    if (
      att.reportedCostUsd !== undefined &&
      att.reportedCostUsd !== null &&
      att.reportedCostUsd > 0
    ) {
      throw new Error(
        "Contradictory evidence: locallyPreventedZeroDispatch is true but reportedCostUsd is positive",
      );
    }
    if (
      att.inputTokens !== undefined &&
      att.inputTokens !== null &&
      att.inputTokens > 0
    ) {
      throw new Error(
        "Contradictory evidence: locallyPreventedZeroDispatch is true but inputTokens is positive",
      );
    }
    if (
      att.outputTokens !== undefined &&
      att.outputTokens !== null &&
      att.outputTokens > 0
    ) {
      throw new Error(
        "Contradictory evidence: locallyPreventedZeroDispatch is true but outputTokens is positive",
      );
    }
    if (
      att.cachedInputTokens !== undefined &&
      att.cachedInputTokens !== null &&
      att.cachedInputTokens > 0
    ) {
      throw new Error(
        "Contradictory evidence: locallyPreventedZeroDispatch is true but cachedInputTokens is positive",
      );
    }
  }

  return {
    attemptId: att.attemptId.trim(),
    attemptIndex: att.attemptIndex,
    trafficPool: pool,
    provider: att.provider.trim(),
    model: typeof att.model === "string" ? att.model.trim() : null,
    attemptTimestamp: att.attemptTimestamp as string | Date | undefined,
    snapshotId:
      typeof att.snapshotId === "string" ? att.snapshotId.trim() : null,
    locallyPreventedZeroDispatch: isZeroDispatch,
    status: att.status,
    httpStatus: typeof att.httpStatus === "number" ? att.httpStatus : null,
    reportedCostUsd:
      typeof att.reportedCostUsd === "number" ? att.reportedCostUsd : null,
    inputTokens: typeof att.inputTokens === "number" ? att.inputTokens : null,
    cachedInputTokens:
      typeof att.cachedInputTokens === "number" ? att.cachedInputTokens : null,
    outputTokens:
      typeof att.outputTokens === "number" ? att.outputTokens : null,
    latencyMs: typeof att.latencyMs === "number" ? att.latencyMs : null,
    errorCode: typeof att.errorCode === "string" ? att.errorCode : null,
  };
}

/**
 * Find a matching rate snapshot for an attempt deterministically.
 * Rules:
 * 1. If explicit snapshotId is provided on attempt, matches by immutable snapshotId.
 * 2. If attemptTimestamp is provided, rates with effectiveDate in the future (effectiveDate > attemptTimestamp)
 *    are excluded. Among applicable historical rates, the one with the maximum effectiveDate is selected.
 * 3. Array order (reverse, shuffle) is completely invariant.
 */
function findMatchingRateSnapshot(
  attempt: PhysicalAttemptFact,
  rateSnapshots: ReadonlyArray<ModelRateSnapshot>,
): ModelRateSnapshot | undefined {
  if (rateSnapshots.length === 0) return undefined;

  // Case A: Explicit immutable snapshot reference
  if (attempt.snapshotId) {
    const targetSnapshotId = attempt.snapshotId.trim();
    return rateSnapshots.find((s) => s.snapshotId === targetSnapshotId);
  }

  if (!attempt.model) return undefined;

  const targetProvider = attempt.provider.trim().toLowerCase();
  const targetModel = attempt.model.trim().toLowerCase();

  // Filter provider and model candidates
  const matchingCandidates = rateSnapshots.filter(
    (s) =>
      s.provider.trim().toLowerCase() === targetProvider &&
      s.model.trim().toLowerCase() === targetModel,
  );

  if (matchingCandidates.length === 0) return undefined;

  // Case B: Timestamped attempt matching historical rate
  if (attempt.attemptTimestamp !== undefined) {
    const attemptMs = toCanonicalTimestampMs(attempt.attemptTimestamp);

    // Filter historical snapshots: effectiveDate at 00:00:00 UTC <= attemptMs
    const historicalCandidates = matchingCandidates.filter((s) => {
      const effectiveMs = Date.parse(`${s.effectiveDate}T00:00:00.000Z`);
      return effectiveMs <= attemptMs;
    });

    if (historicalCandidates.length === 0) {
      // All snapshots are in the future; future rates must not apply
      return undefined;
    }

    // Select candidate with the latest effectiveDate deterministically
    return historicalCandidates.reduce((latest, current) => {
      const latestMs = Date.parse(`${latest.effectiveDate}T00:00:00.000Z`);
      const currentMs = Date.parse(`${current.effectiveDate}T00:00:00.000Z`);
      return currentMs > latestMs ? current : latest;
    });
  }

  // Case C: Neither snapshotId nor attemptTimestamp is provided.
  // Without a timestamp, future rates cannot be distinguished from historical rates.
  // Rate snapshot matching is unresolvable -> evaluates to UNKNOWN.
  return undefined;
}

/**
 * Explicit content-free projection of an AttemptCostResult.
 */
function projectAttemptCostResult(r: AttemptCostResult): AttemptCostResult {
  return {
    attemptId: r.attemptId,
    attemptIndex: r.attemptIndex,
    trafficPool: r.trafficPool,
    provider: r.provider,
    model: r.model,
    isDispatched: r.isDispatched,
    costUsd: r.costUsd,
    provenance: r.provenance,
    completeness: r.completeness,
    snapshotId: r.snapshotId,
    rateEffectiveDate: r.rateEffectiveDate,
    rateSource: r.rateSource,
    uncachedInputTokens: r.uncachedInputTokens,
    cachedInputTokens: r.cachedInputTokens,
    outputTokens: r.outputTokens,
  };
}

/**
 * Evaluate cost and provenance for ONE physical attempt.
 */
export function evaluateAttemptCost(
  rawAttempt: PhysicalAttemptFact,
  rawRateSnapshots?: ReadonlyArray<ModelRateSnapshot>,
): AttemptCostResult {
  const attempt = validateAttemptFact(rawAttempt);
  const rateSnapshots = validateRateSnapshots(rawRateSnapshots);
  const pool = attempt.trafficPool;

  // Case 1: Locally prevented zero dispatch (proven zero wire requests)
  if (attempt.locallyPreventedZeroDispatch === true) {
    return projectAttemptCostResult({
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
    });
  }

  // Case 2: Provider-reported cost present directly in response payload.
  // Valid zero reported cost (reportedCostUsd === 0) is respected.
  if (
    typeof attempt.reportedCostUsd === "number" &&
    Number.isFinite(attempt.reportedCostUsd) &&
    attempt.reportedCostUsd >= 0
  ) {
    return projectAttemptCostResult({
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
    });
  }

  // Case 3: Rate snapshot derivation
  const snapshot = findMatchingRateSnapshot(attempt, rateSnapshots);
  const inputTokens = attempt.inputTokens;
  const outputTokens = attempt.outputTokens;

  const hasValidTokenCounts =
    typeof inputTokens === "number" &&
    Number.isSafeInteger(inputTokens) &&
    inputTokens >= 0 &&
    typeof outputTokens === "number" &&
    Number.isSafeInteger(outputTokens) &&
    outputTokens >= 0;

  if (snapshot && hasValidTokenCounts) {
    const rawCached = attempt.cachedInputTokens;
    const cachedTokens =
      typeof rawCached === "number" &&
      Number.isSafeInteger(rawCached) &&
      rawCached >= 0
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

    return projectAttemptCostResult({
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
      rateEffectiveDate: snapshot.effectiveDate,
      rateSource: snapshot.source,
      uncachedInputTokens: uncachedTokens,
      cachedInputTokens: cachedTokens,
      outputTokens: outputTokens,
    });
  }

  // Case 4: Unknown cost.
  // Rule: Do NOT infer zero cost from HTTP error status or timeouts.
  return projectAttemptCostResult({
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
  });
}

/**
 * Explicit content-free projection of a PoolCostSummary.
 */
function projectPoolSummary(s: PoolCostSummary): PoolCostSummary {
  return {
    trafficPool: s.trafficPool,
    dispatchedAttempts: s.dispatchedAttempts,
    knownAttempts: s.knownAttempts,
    unknownAttempts: s.unknownAttempts,
    locallyPreventedAttempts: s.locallyPreventedAttempts,
    totalCostUsd: s.totalCostUsd,
    knownSubtotalUsd: s.knownSubtotalUsd,
    costCompleteness: s.costCompleteness,
    coverageRatio: s.coverageRatio,
    coveragePercentage: s.coveragePercentage,
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

  return projectPoolSummary({
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
  });
}

/**
 * Pure turn cost calculation engine.
 * Evaluates each physical attempt, preserves pool isolation, and derives coverage.
 */
export function evaluateTurnCost(
  attempts: ReadonlyArray<PhysicalAttemptFact>,
  rateSnapshots?: ReadonlyArray<ModelRateSnapshot>,
): TurnCostResult {
  const attemptResults = attempts.map((a) =>
    evaluateAttemptCost(a, rateSnapshots),
  );

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
