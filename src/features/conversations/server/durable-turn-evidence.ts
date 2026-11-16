/**
 * Durable turn usage/cost evidence — a bounded, content-free projection of the
 * existing finished-turn evidence record.
 *
 * WHY THIS EXISTS. `flowpilot.turn.evidence@v1` already carries the truthful
 * per-attempt execution facts and the existing cost-engine result, but its
 * default sink is runtime logs with finite retention. Historical
 * `usage_records` therefore cannot answer "what did this turn cost, and what
 * is still unknown?" after the log window expires.
 *
 * WHAT IT IS. A PURE projection from ONE already-built `TurnEvidence` record
 * (plus the caller's explicit traffic pool) into the durable DTO. It performs
 * no I/O, no provider call, no cost estimation, no content inference and no
 * accounting of its own:
 *   - totals/subtotals/completeness are COPIED from the existing cost result;
 *   - per-attempt costs are COPIED from the existing attempt projection;
 *   - tokens/dispatch/status/error facts are COPIED as-is.
 *
 * CONTENT-FREE BY CONSTRUCTION. Only the persistence allowlist in
 * `src/lib/validation/turn-evidence.ts` can leave this module. Message text,
 * prompts, responses, raw provider payloads, secrets, arbitrary JSON and hidden
 * reasoning are structurally absent.
 *
 * IDENTITY. The durable parent is keyed by `(businessId, customerMessageId)` —
 * the authoritative inbound message id. Attempts carry `traceId:<index>` (or
 * the customer message id when no trace exists), never text, timestamps alone
 * or provider/model names.
 */

import type { TurnEvidence } from "@/features/conversations/server/turn-evidence";
import type {
  DurableTurnEvidenceAttemptDto,
  DurableTurnEvidenceDto,
} from "@/lib/validation";
import {
  DURABLE_TURN_EVIDENCE_MAX_ATTEMPTS,
  DURABLE_TURN_EVIDENCE_SCHEMA,
  durableTurnEvidenceValidation,
} from "@/lib/validation";

type DispatchState = DurableTurnEvidenceAttemptDto["dispatchState"];

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function readDispatchState(httpAttempts: number | null): DispatchState {
  if (httpAttempts === 0) return "PREVENTED";
  if (typeof httpAttempts === "number" && httpAttempts > 0) return "DISPATCHED";
  return "UNKNOWN";
}

function projectAttempt(
  record: TurnEvidence,
  attempt: NonNullable<TurnEvidence["executionAttempts"]>[number],
): DurableTurnEvidenceAttemptDto {
  const httpAttempts =
    typeof attempt.httpAttempts === "number" ? attempt.httpAttempts : null;
  const dispatchState = readDispatchState(httpAttempts);

  // A proven local prevention has zero external cost by the EXISTING cost
  // semantics. Anything else is known only when the attempt projection says
  // the provider reported it; costUsd without that explicit provenance is
  // treated as unknown rather than silently re-labelled.
  if (dispatchState === "PREVENTED") {
    if (isFiniteNonNegative(attempt.costUsd) && attempt.costUsd > 0) {
      throw new Error(
        "contradictory evidence: PREVENTED dispatch cannot carry a positive cost",
      );
    }
    return {
      attemptIndex: attempt.attempt,
      attemptIdentity: `${record.traceId ?? record.customerMessageId}:attempt:${attempt.attempt}`,
      provider: attempt.provider,
      model: attempt.model ?? null,
      status: attempt.status,
      dispatchState,
      httpAttempts: 0,
      inputTokens: attempt.inputTokens ?? null,
      outputTokens: attempt.outputTokens ?? null,
      costUsd: 0,
      costCurrency: "USD",
      costProvenance: "ZERO_DISPATCH_PREVENTED",
      costCompleteness: "KNOWN",
      errorCode: attempt.errorCode ?? null,
      httpStatus: attempt.httpStatus ?? null,
    };
  }

  const costKnown =
    isFiniteNonNegative(attempt.costUsd) &&
    attempt.costSource === "PROVIDER_REPORTED";
  return {
    attemptIndex: attempt.attempt,
    attemptIdentity: `${record.traceId ?? record.customerMessageId}:attempt:${attempt.attempt}`,
    provider: attempt.provider,
    model: attempt.model ?? null,
    status: attempt.status,
    dispatchState,
    httpAttempts,
    inputTokens: attempt.inputTokens ?? null,
    outputTokens: attempt.outputTokens ?? null,
    costUsd: costKnown ? attempt.costUsd! : null,
    costCurrency: costKnown ? "USD" : null,
    costProvenance: costKnown ? "PROVIDER_REPORTED" : "UNKNOWN",
    costCompleteness: costKnown ? "KNOWN" : "UNKNOWN",
    errorCode: attempt.errorCode ?? null,
    httpStatus: attempt.httpStatus ?? null,
  };
}

/**
 * Proven no-call is reserved for authoritative engine decisions:
 * - a deferred-to-staff turn never attempted AI;
 * - a deterministic/JEV routing with providerStatus NOT_CALLED proves no
 *   provider dispatch.
 * An empty attempt list WITHOUT one of these proofs is UNAVAILABLE execution
 * evidence, never a fabricated no-call.
 */
function hasProvenNoCall(record: TurnEvidence): boolean {
  if (record.finalOutcome === "DEFERRED_TO_STAFF") return true;
  if (record.providerStatus !== "NOT_CALLED") return false;
  return (
    record.routingDecision === "DETERMINISTIC_BYPASS" ||
    record.routingDecision === "DETERMINISTIC" ||
    record.routingDecision === "JEV"
  );
}

/**
 * Project a finished turn into the durable evidence DTO. Pure; the caller is
 * responsible for bounded persistence (the repository validates again).
 */
export function buildDurableTurnEvidence(
  record: TurnEvidence,
  trafficPool: DurableTurnEvidenceDto["trafficPool"],
): DurableTurnEvidenceDto {
  const sourceAttempts = record.executionAttempts ?? [];
  if (sourceAttempts.length > DURABLE_TURN_EVIDENCE_MAX_ATTEMPTS) {
    throw new Error(
      `durable turn evidence exceeds ${DURABLE_TURN_EVIDENCE_MAX_ATTEMPTS} attempts`,
    );
  }
  const attempts = sourceAttempts.map((attempt) =>
    projectAttempt(record, attempt),
  );
  const executionEvidence =
    attempts.length > 0
      ? ("RECORDED" as const)
      : hasProvenNoCall(record)
        ? ("PROVEN_NO_CALL" as const)
        : ("UNAVAILABLE" as const);
  const dispatchCounts = attempts.reduce(
    (acc, attempt) => {
      if (attempt.dispatchState === "PREVENTED") acc.prevented += 1;
      else if (attempt.dispatchState === "UNKNOWN") acc.unknown += 1;
      else acc.confirmed += attempt.httpAttempts ?? 0;
      return acc;
    },
    { confirmed: 0, unknown: 0, prevented: 0 },
  );
  const costCompleteness =
    record.costCompleteness === "COMPLETE" ||
    record.costCompleteness === "PARTIAL" ||
    record.costCompleteness === "UNAVAILABLE"
      ? record.costCompleteness
      : attempts.length > 0
        ? ("UNAVAILABLE" as const)
        : null;
  const providerStatus =
    record.providerStatus === "SUCCESS" ||
    record.providerStatus === "FAILURE" ||
    record.providerStatus === "NOT_CALLED"
      ? record.providerStatus
      : null;
  const hasCostValue =
    record.totalCostUsd !== null ||
    attempts.some(
      (attempt) =>
        attempt.dispatchState !== "PREVENTED" &&
        attempt.costCompleteness === "KNOWN",
    ) ||
    costCompleteness === "COMPLETE" ||
    costCompleteness === "PARTIAL";

  return {
    schema: DURABLE_TURN_EVIDENCE_SCHEMA,
    businessId: record.businessId,
    conversationId: record.conversationId,
    customerMessageId: record.customerMessageId,
    traceId: record.traceId,
    trafficPool,
    executionEvidence,
    occurredAt: new Date(record.emittedAt),
    appVersion: record.appVersion,
    environment: record.environment,
    intent: record.intent,
    assistantAction: record.assistantAction,
    conversationStatus: record.conversationStatus,
    handoffCause: record.handoffCause,
    routingDecision: record.routingDecision,
    provider: record.provider,
    model: record.model,
    providerStatus,
    stopReason: record.stopReason,
    finalOutcome: record.finalOutcome,
    outboundSendAttempted: record.outboundSendAttempted,
    outboundSendDelivered: record.outboundSendDelivered,
    outboundDeliveryErrorCode: record.outboundDeliveryErrorCode,
    totalCostUsd: record.totalCostUsd,
    knownCostSubtotalUsd: record.knownCostSubtotalUsd,
    costCompleteness,
    costCurrency: hasCostValue ? "USD" : null,
    logicalAttemptCount: attempts.length,
    confirmedHttpDispatches: dispatchCounts.confirmed,
    unknownDispatchAttemptCount: dispatchCounts.unknown,
    preventedAttemptCount: dispatchCounts.prevented,
    attempts,
  };
}

/**
 * Validate a built DTO at the boundary. The repository calls this after its
 * own parse; exporting it keeps the pure check scriptable without a DB.
 */
export function validateDurableTurnEvidence(
  dto: unknown,
): DurableTurnEvidenceDto {
  return durableTurnEvidenceValidation.record.parse(dto);
}
