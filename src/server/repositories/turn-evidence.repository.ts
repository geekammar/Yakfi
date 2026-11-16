import { createHash } from "node:crypto";

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
  businessId: string;
  conversationId: string | null;
  from: string;
  to: string;
  usageCounts: {
    inbound: number;
    outbound: number;
    aiTurn: number;
  };
  logicalTurns: number;
  /** True when the bounded evidence query hit `limit`. */
  logicalTurnsTruncated: boolean;
  physicalAttempts: number;
  duplicateEmissions: number;
  identityConflicts: number;
  cost: {
    currency: "USD" | null;
    /** Sum of authoritative known subtotals (may include PARTIAL turns). */
    knownCostSubtotalUsd: number | null;
    /** Sum of totals from COMPLETE turns only; never a subtotal. */
    completeTotalUsd: number | null;
    completeness: {
      complete: number;
      partial: number;
      unavailable: number;
      notApplicable: number;
    };
    unknownCostTurns: number;
    unknownCostAttempts: number;
    /** Provider-reported evidence only; invoices are a separate process. */
    providerReportedOnly: true;
    invoiceReconciliation: "NOT_PERFORMED";
  };
  links: {
    aiTurnsWithMessageId: number;
    aiTurnsLinkedToEvidence: number;
    aiTurnsMissingMessageId: number;
    aiTurnsWithoutEvidence: number;
    evidenceWithoutAiTurn: number;
    /** AI_TURN rows actually inspected (bounded; see `analysisTruncated`). */
    aiTurnsAnalyzed: number;
    analysisTruncated: boolean;
  };
  /** Historical usage rows that cannot be linked by a stable identity. */
  unresolvedHistoricalRows: number;
};

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

function addFinite(
  current: number | null,
  value: number | null,
): number | null {
  if (value === null) return current;
  if (!Number.isFinite(value)) {
    throw new Error("TURN_EVIDENCE_NON_FINITE_COST");
  }
  return current === null ? value : current + value;
}

export class TurnEvidenceRepository {
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
   * Bounded, tenant-scoped reconciliation over the durable evidence and the
   * existing usage rows. Read-only and content-free. Joins by stable ids only;
   * it never inspects message text.
   */
  async reconcile(input: unknown): Promise<TurnEvidenceReconciliation> {
    const parsed: ReconcileTurnEvidenceDto =
      durableTurnEvidenceValidation.reconcile.parse(input);
    const conversationFilter = parsed.conversationId
      ? { conversationId: parsed.conversationId }
      : {};

    const usageWhere = {
      businessId: parsed.businessId,
      occurredAt: { gte: parsed.from, lt: parsed.to },
      ...conversationFilter,
    };
    const [usageGroups, aiTurnRows] = await Promise.all([
      db.usageRecord.groupBy({
        by: ["kind"],
        where: usageWhere,
        _count: { _all: true },
      }),
      db.usageRecord.findMany({
        where: { ...usageWhere, kind: "AI_TURN" },
        select: { messageId: true },
        orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
        take: 5000,
      }),
    ]);

    const evidence = (await db.turnEvidenceRecord.findMany({
      where: {
        businessId: parsed.businessId,
        occurredAt: { gte: parsed.from, lt: parsed.to },
        ...conversationFilter,
      },
      select: {
        customerMessageId: true,
        totalCostUsd: true,
        knownCostSubtotalUsd: true,
        costCompleteness: true,
        costCurrency: true,
        replayCount: true,
        conflictCount: true,
        attempts: { select: { costCompleteness: true } },
      },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: parsed.limit,
    })) as Array<{
      customerMessageId: string;
      totalCostUsd: number | null;
      knownCostSubtotalUsd: number | null;
      costCompleteness: string | null;
      costCurrency: string | null;
      replayCount: number;
      conflictCount: number;
      attempts: Array<{ costCompleteness: string }>;
    }>;

    const usageCounts = { inbound: 0, outbound: 0, aiTurn: 0 };
    for (const group of usageGroups) {
      const count = group._count._all;
      if (group.kind === "INBOUND_MESSAGE") usageCounts.inbound = count;
      else if (group.kind === "OUTBOUND_MESSAGE") usageCounts.outbound = count;
      else if (group.kind === "AI_TURN") usageCounts.aiTurn = count;
    }

    const evidenceMessageIds = new Set(
      evidence.map((row) => row.customerMessageId),
    );
    const aiTurnMessageIds = new Set<string>();
    let aiTurnsWithMessageId = 0;
    let aiTurnsLinkedToEvidence = 0;
    let aiTurnsMissingMessageId = 0;
    let aiTurnsWithoutEvidence = 0;

    for (const row of aiTurnRows) {
      if (!row.messageId) {
        aiTurnsMissingMessageId += 1;
        continue;
      }
      aiTurnsWithMessageId += 1;
      aiTurnMessageIds.add(row.messageId);
      if (evidenceMessageIds.has(row.messageId)) {
        aiTurnsLinkedToEvidence += 1;
      } else {
        aiTurnsWithoutEvidence += 1;
      }
    }

    let logicalTurns = 0;
    let physicalAttempts = 0;
    let duplicateEmissions = 0;
    let identityConflicts = 0;
    let knownSubtotalUsd: number | null = null;
    let completeTotalUsd: number | null = null;
    let unknownCostTurns = 0;
    let unknownCostAttempts = 0;
    let anyKnownCurrency = false;
    const completeness = {
      complete: 0,
      partial: 0,
      unavailable: 0,
      notApplicable: 0,
    };

    for (const row of evidence) {
      logicalTurns += 1;
      physicalAttempts += row.attempts.length;
      duplicateEmissions += row.replayCount;
      identityConflicts += row.conflictCount;
      unknownCostAttempts += row.attempts.filter(
        (attempt) => attempt.costCompleteness !== "KNOWN",
      ).length;
      knownSubtotalUsd = addFinite(
        knownSubtotalUsd,
        row.knownCostSubtotalUsd,
      );

      if (row.costCompleteness === "COMPLETE") {
        completeness.complete += 1;
        completeTotalUsd = addFinite(completeTotalUsd, row.totalCostUsd);
      } else if (row.costCompleteness === "PARTIAL") {
        completeness.partial += 1;
        unknownCostTurns += 1;
      } else if (row.costCompleteness === "UNAVAILABLE") {
        completeness.unavailable += 1;
        unknownCostTurns += 1;
      } else {
        completeness.notApplicable += 1;
      }
      if (row.costCurrency === "USD") anyKnownCurrency = true;
    }

    const evidenceWithoutAiTurn = evidence.filter(
      (row) => !aiTurnMessageIds.has(row.customerMessageId),
    ).length;

    return {
      schema: TURN_EVIDENCE_RECONCILIATION_SCHEMA,
      businessId: parsed.businessId,
      conversationId: parsed.conversationId ?? null,
      from: parsed.from.toISOString(),
      to: parsed.to.toISOString(),
      usageCounts,
      logicalTurns,
      logicalTurnsTruncated: evidence.length === parsed.limit,
      physicalAttempts,
      duplicateEmissions,
      identityConflicts,
      cost: {
        currency: anyKnownCurrency ? "USD" : null,
        knownCostSubtotalUsd: knownSubtotalUsd,
        completeTotalUsd,
        completeness,
        unknownCostTurns,
        unknownCostAttempts,
        providerReportedOnly: true,
        invoiceReconciliation: "NOT_PERFORMED",
      },
      links: {
        aiTurnsWithMessageId,
        aiTurnsLinkedToEvidence,
        aiTurnsMissingMessageId,
        aiTurnsWithoutEvidence,
        evidenceWithoutAiTurn,
        aiTurnsAnalyzed: aiTurnRows.length,
        analysisTruncated: aiTurnRows.length < usageCounts.aiTurn,
      },
      unresolvedHistoricalRows:
        aiTurnsMissingMessageId + aiTurnsWithoutEvidence,
    };
  }

  /** Bounded, tenant-scoped read of persisted evidence (diagnostics). */
  async listByConversationWindow(
    input: unknown,
  ): Promise<TurnEvidenceRecord[]> {
    const parsed = durableTurnEvidenceValidation.reconcile.parse(input);
    const rows = (await db.turnEvidenceRecord.findMany({
      where: {
        businessId: parsed.businessId,
        ...(parsed.conversationId
          ? { conversationId: parsed.conversationId }
          : {}),
        occurredAt: { gte: parsed.from, lt: parsed.to },
      },
      include: { attempts: { orderBy: { attemptIndex: "asc" } } },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      take: parsed.limit,
    })) as EvidenceRow[];
    return rows.map(toEvidenceRecord);
  }
}
