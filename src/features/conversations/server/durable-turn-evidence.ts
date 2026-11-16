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

type AttemptCompleteness = "KNOWN" | "UNKNOWN";

function isFiniteNonNegative(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && value >= 0
  );
}

function normalizeAttemptCost(attempt: {
  readonly costUsd?: number;
}): { costUsd: number | null; completeness: AttemptCompleteness } {
  if (isFiniteNonNegative(attempt.costUsd)) {
    return { costUsd: attempt.costUsd, completeness: "KNOWN" };
  }
  return { costUsd: null, completeness: "UNKNOWN" };
}

function projectAttempt(
  record: TurnEvidence,
  attempt: NonNullable<TurnEvidence["executionAttempts"]>[number],
): DurableTurnEvidenceAttemptDto {
  const httpAttempts =
    typeof attempt.httpAttempts === "number" ? attempt.httpAttempts : null;
  const dispatchState =
    httpAttempts === 0 ? ("PREVENTED" as const) : ("DISPATCHED" as const);
  const cost = normalizeAttemptCost(attempt);
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
    costUsd: cost.costUsd,
    costCurrency: cost.costUsd === null ? null : "USD",
    costProvenance:
      cost.costUsd === null ? "UNKNOWN" : "PROVIDER_REPORTED",
    costCompleteness: cost.completeness,
    errorCode: attempt.errorCode ?? null,
    httpStatus: attempt.httpStatus ?? null,
  };
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
    attempts.some((attempt) => attempt.costCompleteness === "KNOWN") ||
    costCompleteness === "COMPLETE" ||
    costCompleteness === "PARTIAL";

  return {
    schema: DURABLE_TURN_EVIDENCE_SCHEMA,
    businessId: record.businessId,
    conversationId: record.conversationId,
    customerMessageId: record.customerMessageId,
    traceId: record.traceId,
    trafficPool,
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
