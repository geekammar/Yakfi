import { createHash } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";

import type {
  DurableTurnEvidenceDto,
  ReconcileTurnEvidenceDto,
} from "@/lib/validation";
import { durableTurnEvidenceValidation } from "@/lib/validation";
import { db } from "@/server/db";

/**
 * Durable turn usage/cost evidence persistence and bounded reconciliation.
 *
 * The repository is the ONLY Prisma consumer for `turn_evidence_records` and
 * `turn_evidence_attempts`. It accepts the validated DTO from
 * `src/lib/validation/turn-evidence.ts`, enforces the authoritative identity
 * chain (customer message → conversation → business), persists one parent row
 * plus its bounded attempt rows, and exposes a read-only, content-free
 * reconciliation summary.
 *
 * IDEMPOTENCY / CONFLICTS:
 * - `(businessId, customerMessageId)` is the stable replay key.
 * - An identical replay is a no-op that increments `replayCount`; it never
 *   duplicates accounting.
 * - A replay whose substantive facts differ is a CONFLICT: the historical row
 *   and its attempts are left untouched, `conflictCount`/`lastConflictAt` are
 *   incremented, and the caller gets a typed CONFLICT result so the engine can
 *   emit a sanitized signal.
 *
 * COST SEMANTICS: the DTO is validated to preserve null vs real zero vs
 * not-applicable and to prevent a partial subtotal being stated as a complete
 * total. This layer never computes, estimates or backfills a provider cost.
 */

export const TURN_EVIDENCE_RECONCILIATION_SCHEMA =
  "flowpilot.turn.evidence.reconciliation@v1" as const;

export type RecordTurnEvidenceResult = {
  status: "RECORDED" | "DUPLICATE" | "CONFLICT";
  id: string;
  customerMessageId: string;
};

/**
 * Test-only seam used to prove that reconciliation reads a consistent
 * snapshot. Production constructs the repository without options. The hook
 * runs inside the repeatable-read transaction after the evidence aggregate
 * and before the usage aggregate; it must never be used for writes in
 * production paths.
 */
export type TurnEvidenceRepositoryOptions = {
  readonly beforeUsageAggregate?: () => Promise<void>;
};

type AttemptRow = {
  attemptIndex: number;
  attemptIdentity: string;
  provider: string;
  model: string | null;
  status: string;
  dispatchState: string;
  httpAttempts: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  costCurrency: string | null;
  costProvenance: string;
  costCompleteness: string;
  errorCode: string | null;
  httpStatus: number | null;
};

type EvidenceRow = {
  id: string;
  businessId: string;
  conversationId: string;
  customerMessageId: string;
  traceId: string | null;
  trafficPool: string;
  executionEvidence: string;
  occurredAt: Date;
  appVersion: string;
  environment: string;
  intent: string | null;
  assistantAction: string;
  conversationStatus: string;
  handoffCause: string | null;
  routingDecision: string | null;
  provider: string | null;
  model: string | null;
  providerStatus: string | null;
  stopReason: string | null;
  finalOutcome: string;
  outboundSendAttempted: boolean;
  outboundSendDelivered: boolean | null;
  outboundDeliveryErrorCode: string | null;
  totalCostUsd: number | null;
  knownCostSubtotalUsd: number | null;
  costCompleteness: string | null;
  costCurrency: string | null;
  logicalAttemptCount: number;
  confirmedHttpDispatches: number;
  unknownDispatchAttemptCount: number;
  preventedAttemptCount: number;
  factFingerprint: string;
  replayCount: number;
  conflictCount: number;
  lastConflictAt: Date | null;
  createdAt: Date;
  attempts: AttemptRow[];
};

export type TurnEvidenceAttemptRecord = AttemptRow;

export type TurnEvidenceRecord = Omit<
  EvidenceRow,
  "factFingerprint" | "attempts"
> & {
  attempts: TurnEvidenceAttemptRecord[];
};

export type TurnEvidenceReconciliation = {
  schema: typeof TURN_EVIDENCE_RECONCILIATION_SCHEMA;
  scope: {
    businessId: string;
    conversationId: string | null;
    trafficPool: string;
    from: string;
    to: string;
    /** Every aggregate below describes the FULL requested window. */
    aggregateScope: "FULL_WINDOW";
  };
  evidence: {
    logicalTurns: number;
    /** Bounded logical attempt records (not necessarily dispatched). */
    physicalAttemptRecords: number;
    /** Sum of known HTTP calls across DISPATCHED attempt records. */
    confirmedHttpDispatches: number;
    /** Attempt records whose physical HTTP count is genuinely unknown. */
    unknownDispatchAttempts: number;
    /** Proven locally prevented dispatches (zero external cost). */
    preventedDispatches: number;
    duplicateEmissions: number;
    identityConflicts: number;
    /** Selected-pool evidence rows whose replay facts conflicted. */
    conflictedTurns: number;
    executionEvidence: {
      recorded: number;
      provenNoCall: number;
      unavailable: number;
    };
    cost: {
      currency: "USD" | null;
      /** Sum of authoritative known subtotals (may include PARTIAL turns). */
      knownCostSubtotalUsd: number | null;
      /** Sum of COMPLETE turn totals only; never a partial subtotal. */
      completeTurnTotalUsd: number | null;
      /** Complete total ONLY when selected-scope coverage and conflicts are fully resolved. */
      scopedWindowTotalCostUsd: number | null;
      scopedWindowCostStatus: "COMPLETE" | "PARTIAL" | "UNAVAILABLE";
      completeness: {
        complete: number;
        partial: number;
        unavailable: number;
        notApplicable: number;
      };
      unknownCostTurns: number;
      unknownCostAttempts: number;
      providerReportedOnly: true;
      invoiceReconciliation: "NOT_PERFORMED";
    };
  };
  usage: {
    /** Window counts. usage_records carry no pool; these are NOT pool totals. */
    window: {
      inbound: number;
      outbound: number;
      aiTurn: number;
    };
    aiTurnLinks: {
      linkedScoped: number;
      linkedOtherPool: number;
      withoutEvidence: number;
      missingMessageId: number;
      /** Selected-pool evidence proving no-call but carrying an AI_TURN row. */
      noCallWithAiTurn: number;
    };
    evidenceWithoutAiTurn: {
      /** Proven deterministic/deferred no-call turns (expected). */
      expectedNoCall: number;
      /** Execution recorded/unavailable but no AI_TURN link exists. */
      unresolved: number;
    };
    /**
     * Usage rows that cannot be attributed to selected-pool evidence:
     * `withoutEvidence + missingMessageId`. Known other-pool links are
     * excluded; this value decides selected-scope coverage completeness.
     */
    unresolvedUsageRows: number;
    /** AI_TURN rows with no authoritative message identity (historical). */
    unresolvedHistoricalIdentity: number;
    /** AI_TURN rows with a message id but no evidence row (new/missing). */
    unresolvedMissingEvidence: number;
    /** Known AI_TURN rows linked to evidence outside the requested pool. */
    knownOtherPoolLinks: number;
  };
};

type RawEvidenceAggregate = {
  logical_turns: number | bigint;
  physical_attempt_records: number | bigint;
  confirmed_http_dispatches: number | bigint;
  unknown_dispatch_attempts: number | bigint;
  prevented_dispatches: number | bigint;
  duplicate_emissions: number | bigint;
  identity_conflicts: number | bigint;
  conflicted_turns: number | bigint;
  execution_recorded: number | bigint;
  execution_proven_no_call: number | bigint;
  execution_unavailable: number | bigint;
  cost_complete: number | bigint;
  cost_partial: number | bigint;
  cost_unavailable: number | bigint;
  cost_not_applicable: number | bigint;
  usd_turns: number | bigint;
  known_cost_subtotal: number | string | null;
  complete_turn_total: number | string | null;
};

type RawUsageAggregate = {
  inbound: number | bigint;
  outbound: number | bigint;
  ai_turn: number | bigint;
  ai_linked_scoped: number | bigint;
  ai_linked_other_pool: number | bigint;
  ai_without_evidence: number | bigint;
  ai_missing_message_id: number | bigint;
};

function toCount(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
}

function toCost(value: number | string | null): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toAttemptRows(record: DurableTurnEvidenceDto): AttemptRow[] {
  return record.attempts
    .slice()
    .sort((a, b) => a.attemptIndex - b.attemptIndex)
    .map((attempt) => ({
      attemptIndex: attempt.attemptIndex,
      attemptIdentity: attempt.attemptIdentity,
      provider: attempt.provider,
      model: attempt.model ?? null,
      status: attempt.status,
      dispatchState: attempt.dispatchState,
      httpAttempts: attempt.httpAttempts ?? null,
      inputTokens: attempt.inputTokens ?? null,
      outputTokens: attempt.outputTokens ?? null,
      costUsd: attempt.costUsd ?? null,
      costCurrency: attempt.costCurrency ?? null,
      costProvenance: attempt.costProvenance,
      costCompleteness: attempt.costCompleteness,
      errorCode: attempt.errorCode ?? null,
      httpStatus: attempt.httpStatus ?? null,
    }));
}

/**
 * Stable fingerprint of the ACCOUNTING-RELEVANT facts. `occurredAt` is the
 * distinct act of emission, not a turn fact, so a legitimate replay at a later
 * instant is idempotent rather than a conflict. Attempt order is normalized by
 * index so array ordering cannot create a false conflict.
 */
function computeFactFingerprint(record: DurableTurnEvidenceDto): string {
  const canonical = {
    schema: record.schema,
    businessId: record.businessId,
    conversationId: record.conversationId,
    customerMessageId: record.customerMessageId,
    traceId: record.traceId ?? null,
    trafficPool: record.trafficPool,
    executionEvidence: record.executionEvidence,
    appVersion: record.appVersion,
    environment: record.environment,
    intent: record.intent ?? null,
    assistantAction: record.assistantAction,
    conversationStatus: record.conversationStatus,
    handoffCause: record.handoffCause ?? null,
    routingDecision: record.routingDecision ?? null,
    provider: record.provider ?? null,
    model: record.model ?? null,
    providerStatus: record.providerStatus ?? null,
    stopReason: record.stopReason ?? null,
    finalOutcome: record.finalOutcome,
    outboundSendAttempted: record.outboundSendAttempted,
    outboundSendDelivered: record.outboundSendDelivered ?? null,
    outboundDeliveryErrorCode: record.outboundDeliveryErrorCode ?? null,
    totalCostUsd: record.totalCostUsd ?? null,
    knownCostSubtotalUsd: record.knownCostSubtotalUsd ?? null,
    costCompleteness: record.costCompleteness ?? null,
    costCurrency: record.costCurrency ?? null,
    logicalAttemptCount: record.logicalAttemptCount,
    confirmedHttpDispatches: record.confirmedHttpDispatches,
    unknownDispatchAttemptCount: record.unknownDispatchAttemptCount,
    preventedAttemptCount: record.preventedAttemptCount,
    attempts: toAttemptRows(record),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Verify the authoritative identity chain before ANY write. A caller can never
 * attach evidence to another tenant's conversation/message by passing
 * mismatched ids.
 */
async function assertAuthoritativeIdentity(
  record: DurableTurnEvidenceDto,
): Promise<void> {
  const message = await db.message.findUnique({
    where: { id: record.customerMessageId },
    select: {
      conversationId: true,
      conversation: { select: { businessId: true } },
    },
  });
  if (
    !message ||
    message.conversationId !== record.conversationId ||
    message.conversation.businessId !== record.businessId
  ) {
    throw new Error("TURN_EVIDENCE_IDENTITY_MISMATCH");
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

function toEvidenceRecord(row: EvidenceRow): TurnEvidenceRecord {
  const { factFingerprint: _fingerprint, attempts, ...rest } = row;
  void _fingerprint;
  return { ...rest, attempts };
}

export class TurnEvidenceRepository {
  constructor(private readonly options: TurnEvidenceRepositoryOptions = {}) {}

  /**
   * Persist ONE finished turn's bounded evidence. Validation and identity
   * failures throw (caller bug / forged identity). A genuine storage failure
   * also throws; the engine catches it and keeps the customer outcome intact.
   */
  async record(input: unknown): Promise<RecordTurnEvidenceResult> {
    const record = durableTurnEvidenceValidation.record.parse(input);
    await assertAuthoritativeIdentity(record);

    const factFingerprint = computeFactFingerprint(record);
    const attempts = toAttemptRows(record);

    try {
      const created = await db.turnEvidenceRecord.create({
        data: {
          schemaVersion: record.schema,
          businessId: record.businessId,
          conversationId: record.conversationId,
          customerMessageId: record.customerMessageId,
          traceId: record.traceId ?? null,
          trafficPool: record.trafficPool,
          executionEvidence: record.executionEvidence,
          occurredAt: record.occurredAt,
          appVersion: record.appVersion,
          environment: record.environment,
          intent: record.intent ?? null,
          assistantAction: record.assistantAction,
          conversationStatus: record.conversationStatus,
          handoffCause: record.handoffCause ?? null,
          routingDecision: record.routingDecision ?? null,
          provider: record.provider ?? null,
          model: record.model ?? null,
          providerStatus: record.providerStatus ?? null,
          stopReason: record.stopReason ?? null,
          finalOutcome: record.finalOutcome,
          outboundSendAttempted: record.outboundSendAttempted,
          outboundSendDelivered: record.outboundSendDelivered ?? null,
          outboundDeliveryErrorCode: record.outboundDeliveryErrorCode ?? null,
          totalCostUsd: record.totalCostUsd ?? null,
          knownCostSubtotalUsd: record.knownCostSubtotalUsd ?? null,
          costCompleteness: record.costCompleteness ?? null,
          costCurrency: record.costCurrency ?? null,
          logicalAttemptCount: record.logicalAttemptCount,
          confirmedHttpDispatches: record.confirmedHttpDispatches,
          unknownDispatchAttemptCount: record.unknownDispatchAttemptCount,
          preventedAttemptCount: record.preventedAttemptCount,
          factFingerprint,
          attempts: { create: attempts },
        },
        select: { id: true, customerMessageId: true },
      });
      return {
        status: "RECORDED",
        id: created.id,
        customerMessageId: created.customerMessageId,
      };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }

    const existing = await db.turnEvidenceRecord.findUnique({
      where: {
        businessId_customerMessageId: {
          businessId: record.businessId,
          customerMessageId: record.customerMessageId,
        },
      },
      select: {
        id: true,
        customerMessageId: true,
        factFingerprint: true,
      },
    });
    if (!existing) throw new Error("TURN_EVIDENCE_REPLAY_LOOKUP_FAILED");

    if (existing.factFingerprint === factFingerprint) {
      await db.turnEvidenceRecord.update({
        where: { id: existing.id },
        data: { replayCount: { increment: 1 } },
      });
      return {
        status: "DUPLICATE",
        id: existing.id,
        customerMessageId: existing.customerMessageId,
      };
    }

    await db.turnEvidenceRecord.update({
      where: { id: existing.id },
      data: {
        conflictCount: { increment: 1 },
        lastConflictAt: new Date(),
      },
    });
    return {
      status: "CONFLICT",
      id: existing.id,
      customerMessageId: existing.customerMessageId,
    };
  }

  /**
   * EXACT, tenant-scoped, single-pool reconciliation over the FULL requested
   * window. No page/membership heuristics classify missing links. Link
   * existence is checked by authoritative ids without constraining the other
   * side's timestamp, so a usage/evidence boundary crossing is never called
   * missing.
   */
  async reconcile(input: unknown): Promise<TurnEvidenceReconciliation> {
    const parsed: ReconcileTurnEvidenceDto =
      durableTurnEvidenceValidation.reconcile.parse(input);
    return db.$transaction((tx) => this.reconcileSnapshot(tx, parsed), {
      isolationLevel: "RepeatableRead",
    });
  }

  private async reconcileSnapshot(
    tx: Prisma.TransactionClient,
    parsed: ReconcileTurnEvidenceDto,
  ): Promise<TurnEvidenceReconciliation> {
    const conversationId = parsed.conversationId ?? null;

    const evidenceRows = await tx.$queryRaw<RawEvidenceAggregate[]>`
      SELECT
        COUNT(*)::int AS logical_turns,
        COALESCE(SUM(e.logical_attempt_count), 0)::int AS physical_attempt_records,
        COALESCE(SUM(e.confirmed_http_dispatches), 0)::int AS confirmed_http_dispatches,
        COALESCE(SUM(e.unknown_dispatch_attempt_count), 0)::int AS unknown_dispatch_attempts,
        COALESCE(SUM(e.prevented_attempt_count), 0)::int AS prevented_dispatches,
        COALESCE(SUM(e.replay_count), 0)::int AS duplicate_emissions,
        COALESCE(SUM(e.conflict_count), 0)::int AS identity_conflicts,
        COUNT(*) FILTER (WHERE e.conflict_count > 0)::int AS conflicted_turns,
        COUNT(*) FILTER (WHERE e.execution_evidence = 'RECORDED')::int AS execution_recorded,
        COUNT(*) FILTER (WHERE e.execution_evidence = 'PROVEN_NO_CALL')::int AS execution_proven_no_call,
        COUNT(*) FILTER (WHERE e.execution_evidence = 'UNAVAILABLE')::int AS execution_unavailable,
        COUNT(*) FILTER (WHERE e.cost_completeness = 'COMPLETE')::int AS cost_complete,
        COUNT(*) FILTER (WHERE e.cost_completeness = 'PARTIAL')::int AS cost_partial,
        COUNT(*) FILTER (WHERE e.cost_completeness = 'UNAVAILABLE')::int AS cost_unavailable,
        COUNT(*) FILTER (WHERE e.cost_completeness IS NULL)::int AS cost_not_applicable,
        COUNT(*) FILTER (WHERE e.cost_currency = 'USD')::int AS usd_turns,
        SUM(e.known_cost_subtotal_usd) AS known_cost_subtotal,
        SUM(e.total_cost_usd) FILTER (WHERE e.cost_completeness = 'COMPLETE') AS complete_turn_total
      FROM turn_evidence_records e
      WHERE e.business_id = ${parsed.businessId}
        AND e.traffic_pool = ${parsed.trafficPool}
        AND e.occurred_at >= ${parsed.from}
        AND e.occurred_at < ${parsed.to}
        AND (${conversationId}::text IS NULL OR e.conversation_id = ${conversationId}::text)
    `;
    const evidenceAgg = evidenceRows[0];

    // Test-only snapshot seam: a write committed here must not appear in the
    // remaining aggregates because the transaction holds a repeatable-read
    // snapshot established by the first query.
    await this.options.beforeUsageAggregate?.();

    const usageRows = await tx.$queryRaw<RawUsageAggregate[]>`
      SELECT
        COUNT(*) FILTER (WHERE u.kind = 'INBOUND_MESSAGE')::int AS inbound,
        COUNT(*) FILTER (WHERE u.kind = 'OUTBOUND_MESSAGE')::int AS outbound,
        COUNT(*) FILTER (WHERE u.kind = 'AI_TURN')::int AS ai_turn,
        COUNT(*) FILTER (
          WHERE u.kind = 'AI_TURN' AND u.message_id IS NULL
        )::int AS ai_missing_message_id,
        COUNT(*) FILTER (
          WHERE u.kind = 'AI_TURN' AND u.message_id IS NOT NULL
            AND e.id IS NOT NULL AND e.traffic_pool = ${parsed.trafficPool}
        )::int AS ai_linked_scoped,
        COUNT(*) FILTER (
          WHERE u.kind = 'AI_TURN' AND u.message_id IS NOT NULL
            AND e.id IS NOT NULL AND e.traffic_pool <> ${parsed.trafficPool}
        )::int AS ai_linked_other_pool,
        COUNT(*) FILTER (
          WHERE u.kind = 'AI_TURN' AND u.message_id IS NOT NULL AND e.id IS NULL
        )::int AS ai_without_evidence
      FROM usage_records u
      LEFT JOIN turn_evidence_records e
        ON e.business_id = u.business_id
       AND e.customer_message_id = u.message_id
      WHERE u.business_id = ${parsed.businessId}
        AND u.occurred_at >= ${parsed.from}
        AND u.occurred_at < ${parsed.to}
        AND (${conversationId}::text IS NULL OR u.conversation_id = ${conversationId}::text)
    `;
    const usageAgg = usageRows[0];

    const evidenceUsageRows = await tx.$queryRaw<
      Array<{
        expected_no_call: number | bigint;
        unresolved_missing_usage: number | bigint;
        contradictory_no_call: number | bigint;
      }>
    >`
      SELECT
        COUNT(*) FILTER (
          WHERE e.execution_evidence = 'PROVEN_NO_CALL'
            AND NOT EXISTS (
              SELECT 1 FROM usage_records u
              WHERE u.business_id = e.business_id
                AND u.kind = 'AI_TURN'
                AND u.message_id = e.customer_message_id
            )
        )::int AS expected_no_call,
        COUNT(*) FILTER (
          WHERE e.execution_evidence <> 'PROVEN_NO_CALL'
            AND NOT EXISTS (
              SELECT 1 FROM usage_records u
              WHERE u.business_id = e.business_id
                AND u.kind = 'AI_TURN'
                AND u.message_id = e.customer_message_id
            )
        )::int AS unresolved_missing_usage,
        COUNT(*) FILTER (
          WHERE e.execution_evidence = 'PROVEN_NO_CALL'
            AND EXISTS (
              SELECT 1 FROM usage_records u
              WHERE u.business_id = e.business_id
                AND u.kind = 'AI_TURN'
                AND u.message_id = e.customer_message_id
            )
        )::int AS contradictory_no_call
      FROM turn_evidence_records e
      WHERE e.business_id = ${parsed.businessId}
        AND e.traffic_pool = ${parsed.trafficPool}
        AND e.occurred_at >= ${parsed.from}
        AND e.occurred_at < ${parsed.to}
        AND (${conversationId}::text IS NULL OR e.conversation_id = ${conversationId}::text)
    `;
    const evidenceUsageAgg = evidenceUsageRows[0];

    const unknownCostRows = await tx.$queryRaw<
      Array<{ unknown_cost_attempts: number | bigint }>
    >`
      SELECT COALESCE(COUNT(*), 0)::int AS unknown_cost_attempts
      FROM turn_evidence_attempts a
      JOIN turn_evidence_records e ON e.id = a.turn_evidence_id
      WHERE e.business_id = ${parsed.businessId}
        AND e.traffic_pool = ${parsed.trafficPool}
        AND e.occurred_at >= ${parsed.from}
        AND e.occurred_at < ${parsed.to}
        AND (${conversationId}::text IS NULL OR e.conversation_id = ${conversationId}::text)
        AND a.cost_completeness <> 'KNOWN'
    `;

    const unknownCostAgg = unknownCostRows[0];
    if (!evidenceAgg || !usageAgg || !evidenceUsageAgg || !unknownCostAgg) {
      throw new Error("TURN_EVIDENCE_RECONCILIATION_QUERY_FAILED");
    }

    const logicalTurns = toCount(evidenceAgg.logical_turns);
    const complete = toCount(evidenceAgg.cost_complete);
    const partial = toCount(evidenceAgg.cost_partial);
    const unavailable = toCount(evidenceAgg.cost_unavailable);
    const notApplicable = toCount(evidenceAgg.cost_not_applicable);
    const executionUnavailable = toCount(evidenceAgg.execution_unavailable);
    const unresolvedMissingUsage = toCount(
      evidenceUsageAgg.unresolved_missing_usage,
    );
    const expectedNoCall = toCount(evidenceUsageAgg.expected_no_call);
    const noCallWithAiTurn = toCount(evidenceUsageAgg.contradictory_no_call);
    const conflictedTurns = toCount(evidenceAgg.conflicted_turns);
    const identityConflicts = toCount(evidenceAgg.identity_conflicts);
    const aiTurn = toCount(usageAgg.ai_turn);
    const missingMessageId = toCount(usageAgg.ai_missing_message_id);
    const withoutEvidence = toCount(usageAgg.ai_without_evidence);
    const linkedOtherPool = toCount(usageAgg.ai_linked_other_pool);
    const unresolvedUsageRows = missingMessageId + withoutEvidence;
    const hasKnownScopedCost = complete > 0 || partial > 0;
    const hasUnresolvedCoverage =
      unavailable > 0 ||
      executionUnavailable > 0 ||
      unresolvedMissingUsage > 0 ||
      unresolvedUsageRows > 0 ||
      conflictedTurns > 0 ||
      noCallWithAiTurn > 0;

    let scopedWindowCostStatus: "COMPLETE" | "PARTIAL" | "UNAVAILABLE";
    if (logicalTurns === 0) {
      // A genuinely empty selected scope is complete with zero. Usage that
      // cannot be attributed to a known pool is NOT proof of emptiness, while
      // known other-pool links never become selected-pool activity.
      scopedWindowCostStatus =
        unresolvedUsageRows > 0 ? "UNAVAILABLE" : "COMPLETE";
    } else if (hasUnresolvedCoverage) {
      scopedWindowCostStatus = hasKnownScopedCost ? "PARTIAL" : "UNAVAILABLE";
    } else if (partial > 0) {
      scopedWindowCostStatus = "PARTIAL";
    } else {
      scopedWindowCostStatus = "COMPLETE";
    }

    const completeTurnTotalUsd = toCost(evidenceAgg.complete_turn_total);
    const scopedWindowTotalCostUsd =
      scopedWindowCostStatus === "COMPLETE"
        ? (completeTurnTotalUsd ?? 0)
        : null;

    return {
      schema: TURN_EVIDENCE_RECONCILIATION_SCHEMA,
      scope: {
        businessId: parsed.businessId,
        conversationId,
        trafficPool: parsed.trafficPool,
        from: parsed.from.toISOString(),
        to: parsed.to.toISOString(),
        aggregateScope: "FULL_WINDOW",
      },
      evidence: {
        logicalTurns,
        physicalAttemptRecords: toCount(evidenceAgg.physical_attempt_records),
        confirmedHttpDispatches: toCount(evidenceAgg.confirmed_http_dispatches),
        unknownDispatchAttempts: toCount(evidenceAgg.unknown_dispatch_attempts),
        preventedDispatches: toCount(evidenceAgg.prevented_dispatches),
        duplicateEmissions: toCount(evidenceAgg.duplicate_emissions),
        identityConflicts,
        conflictedTurns,
        executionEvidence: {
          recorded: toCount(evidenceAgg.execution_recorded),
          provenNoCall: toCount(evidenceAgg.execution_proven_no_call),
          unavailable: executionUnavailable,
        },
        cost: {
          currency: toCount(evidenceAgg.usd_turns) > 0 ? "USD" : null,
          knownCostSubtotalUsd: toCost(evidenceAgg.known_cost_subtotal),
          completeTurnTotalUsd,
          scopedWindowTotalCostUsd,
          scopedWindowCostStatus,
          completeness: {
            complete,
            partial,
            unavailable,
            notApplicable,
          },
          unknownCostTurns: partial + unavailable,
          unknownCostAttempts: toCount(unknownCostAgg.unknown_cost_attempts),
          providerReportedOnly: true,
          invoiceReconciliation: "NOT_PERFORMED",
        },
      },
      usage: {
        window: {
          inbound: toCount(usageAgg.inbound),
          outbound: toCount(usageAgg.outbound),
          aiTurn,
        },
        aiTurnLinks: {
          linkedScoped: toCount(usageAgg.ai_linked_scoped),
          linkedOtherPool,
          withoutEvidence,
          missingMessageId,
          noCallWithAiTurn,
        },
        evidenceWithoutAiTurn: {
          expectedNoCall,
          unresolved: unresolvedMissingUsage,
        },
        unresolvedUsageRows,
        unresolvedHistoricalIdentity: missingMessageId,
        unresolvedMissingEvidence: withoutEvidence,
        knownOtherPoolLinks: linkedOtherPool,
      },
    };
  }

  /**
   * Bounded, tenant-scoped, single-pool diagnostic page (limit + 1 probe for
   * truthful truncation). This is a SAMPLE, never a full-window total.
   */
  async listByConversationWindow(input: unknown): Promise<{
    items: TurnEvidenceRecord[];
    hasMore: boolean;
    limit: number;
    trafficPool: string;
  }> {
    const parsed = durableTurnEvidenceValidation.list.parse(input);
    const rows = (await db.turnEvidenceRecord.findMany({
      where: {
        businessId: parsed.businessId,
        trafficPool: parsed.trafficPool,
        ...(parsed.conversationId
          ? { conversationId: parsed.conversationId }
          : {}),
        occurredAt: { gte: parsed.from, lt: parsed.to },
      },
      include: { attempts: { orderBy: { attemptIndex: "asc" } } },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      take: parsed.limit + 1,
    })) as EvidenceRow[];
    const hasMore = rows.length > parsed.limit;
    return {
      items: rows.slice(0, parsed.limit).map(toEvidenceRecord),
      hasMore,
      limit: parsed.limit,
      trafficPool: parsed.trafficPool,
    };
  }
}
