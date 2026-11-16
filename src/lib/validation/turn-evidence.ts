import { uuidSchema } from "./common";
import { z } from "zod";

/**
 * Durable per-turn usage/cost evidence (flowpilot.turn.evidence.durable@v1).
 *
 * BOUNDED, CONTENT-FREE projection ONLY. This schema is the persistence
 * allowlist for the existing `flowpilot.turn.evidence@v1` record: tenant and
 * turn correlation ids, closed machine keys, counters, booleans and monetary
 * facts that the authoritative cost engine already produced. It never accepts
 * message text, prompts, model responses, raw provider payloads, secrets,
 * arbitrary JSON or hidden reasoning.
 *
 * The DTO is intentionally NOT a second cost engine. `totalCostUsd`,
 * `knownCostSubtotalUsd` and `costCompleteness` are copied from the existing
 * turn-cost projection; per-attempt `costUsd` is copied from the existing
 * attempt projection. USD is the only supported currency today; a future
 * currency needs an explicit compatible schema change.
 */

export const DURABLE_TURN_EVIDENCE_SCHEMA =
  "flowpilot.turn.evidence.durable@v1" as const;

/** Hard payload bound: an inbound turn can never persist an unbounded list. */
export const DURABLE_TURN_EVIDENCE_MAX_ATTEMPTS = 16;

/** Provider-reported costs are IEEE-754 USD doubles in the existing engine. */
export const durableTurnEvidenceCurrencyValues = ["USD"] as const;
export const durableTurnEvidenceTrafficPoolValues = [
  "SERVING",
  "SHADOW",
  "TEST",
] as const;
export const durableTurnEvidenceStatusValues = ["SUCCESS", "FAILURE"] as const;
export const durableTurnEvidenceDispatchStates = [
  "DISPATCHED",
  "PREVENTED",
] as const;
export const durableTurnEvidenceCostProvenanceValues = [
  "PROVIDER_REPORTED",
  "ZERO_DISPATCH_PREVENTED",
  "UNKNOWN",
] as const;
export const durableTurnEvidenceAttemptCompletenessValues = [
  "KNOWN",
  "UNKNOWN",
] as const;
export const durableTurnEvidenceCompletenessValues = [
  "COMPLETE",
  "PARTIAL",
  "UNAVAILABLE",
] as const;
export const durableTurnEvidenceProviderStatusValues = [
  "SUCCESS",
  "FAILURE",
  "NOT_CALLED",
] as const;

const boundedMachineKey = (max: number) => z.string().trim().min(1).max(max);

const usdSchema = z
  .number()
  .refine((value) => Number.isFinite(value), {
    error: "cost must be a finite number",
  })
  .refine((value) => value >= 0, { error: "cost must be non-negative" });

const optionalText = (max: number) => boundedMachineKey(max).nullish();
const optionalTokens = z
  .number()
  .int()
  .min(0)
  .max(2_147_483_647)
  .nullish();

const durableAttemptSchema = z
  .object({
    attemptIndex: z
      .number()
      .int()
      .min(1)
      .max(DURABLE_TURN_EVIDENCE_MAX_ATTEMPTS),
    /** Stable content-free identity: trace/conversation anchor + index. */
    attemptIdentity: boundedMachineKey(256),
    provider: boundedMachineKey(64),
    model: optionalText(128),
    status: z.enum(durableTurnEvidenceStatusValues),
    dispatchState: z.enum(durableTurnEvidenceDispatchStates),
    httpAttempts: z
      .number()
      .int()
      .min(0)
      .max(DURABLE_TURN_EVIDENCE_MAX_ATTEMPTS)
      .nullish(),
    inputTokens: optionalTokens,
    outputTokens: optionalTokens,
    costUsd: usdSchema.nullish(),
    costCurrency: z.enum(durableTurnEvidenceCurrencyValues).nullish(),
    costProvenance: z.enum(durableTurnEvidenceCostProvenanceValues),
    costCompleteness: z.enum(durableTurnEvidenceAttemptCompletenessValues),
    errorCode: optionalText(64),
    httpStatus: z.number().int().min(300).max(599).nullish(),
  })
  .superRefine((attempt, ctx) => {
    const costKnown = attempt.costCompleteness === "KNOWN";
    if (costKnown) {
      if (typeof attempt.costUsd !== "number") {
        ctx.addIssue({
          code: "custom",
          path: ["costUsd"],
          message: "KNOWN attempt cost requires a numeric costUsd",
        });
      }
      if (attempt.costCurrency !== "USD") {
        ctx.addIssue({
          code: "custom",
          path: ["costCurrency"],
          message: "KNOWN attempt cost requires explicit USD currency",
        });
      }
      if (attempt.costProvenance === "UNKNOWN") {
        ctx.addIssue({
          code: "custom",
          path: ["costProvenance"],
          message: "KNOWN attempt cost cannot have UNKNOWN provenance",
        });
      }
    } else {
      if (attempt.costUsd !== null && attempt.costUsd !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["costUsd"],
          message: "UNKNOWN attempt cost must not carry a cost value",
        });
      }
      if (attempt.costCurrency !== null && attempt.costCurrency !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["costCurrency"],
          message: "UNKNOWN attempt cost must not carry a currency",
        });
      }
      if (attempt.costProvenance !== "UNKNOWN") {
        ctx.addIssue({
          code: "custom",
          path: ["costProvenance"],
          message: "UNKNOWN attempt cost requires UNKNOWN provenance",
        });
      }
    }

    if (attempt.dispatchState === "PREVENTED") {
      if (attempt.httpAttempts !== 0) {
        ctx.addIssue({
          code: "custom",
          path: ["httpAttempts"],
          message: "PREVENTED dispatch requires httpAttempts = 0",
        });
      }
      if (
        attempt.costProvenance === "ZERO_DISPATCH_PREVENTED" &&
        attempt.costUsd !== 0
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["costUsd"],
          message: "ZERO_DISPATCH_PREVENTED requires a real zero cost",
        });
      }
    } else if (attempt.httpAttempts === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["dispatchState"],
        message: "httpAttempts = 0 must be recorded as PREVENTED",
      });
    }
    if (
      attempt.costProvenance === "ZERO_DISPATCH_PREVENTED" &&
      attempt.dispatchState !== "PREVENTED"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["costProvenance"],
        message: "ZERO_DISPATCH_PREVENTED requires PREVENTED dispatch",
      });
    }
  });

const durableTurnEvidenceSchema = z
  .object({
    schema: z.literal(DURABLE_TURN_EVIDENCE_SCHEMA),
    businessId: uuidSchema,
    conversationId: uuidSchema,
    customerMessageId: uuidSchema,
    /** Stable trace id when the turn produced one; never content. */
    traceId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._:-]{1,128}$/, "traceId is not a bounded machine id")
      .nullish(),
    trafficPool: z.enum(durableTurnEvidenceTrafficPoolValues),
    occurredAt: z.date(),
    appVersion: boundedMachineKey(64),
    environment: boundedMachineKey(64),
    intent: optionalText(64),
    assistantAction: boundedMachineKey(64),
    conversationStatus: boundedMachineKey(64),
    handoffCause: optionalText(64),
    routingDecision: optionalText(64),
    provider: optionalText(64),
    model: optionalText(128),
    providerStatus: z.enum(durableTurnEvidenceProviderStatusValues).nullish(),
    stopReason: optionalText(64),
    finalOutcome: boundedMachineKey(64),
    outboundSendAttempted: z.boolean(),
    outboundSendDelivered: z.boolean().nullish(),
    outboundDeliveryErrorCode: optionalText(64),
    totalCostUsd: usdSchema.nullish(),
    knownCostSubtotalUsd: usdSchema.nullish(),
    costCompleteness: z
      .enum(durableTurnEvidenceCompletenessValues)
      .nullish(),
    costCurrency: z.enum(durableTurnEvidenceCurrencyValues).nullish(),
    attempts: z
      .array(durableAttemptSchema)
      .max(DURABLE_TURN_EVIDENCE_MAX_ATTEMPTS),
  })
  .superRefine((record, ctx) => {
    const indexes = new Set<number>();
    const identities = new Set<string>();
    for (const attempt of record.attempts) {
      if (indexes.has(attempt.attemptIndex)) {
        ctx.addIssue({
          code: "custom",
          path: ["attempts"],
          message: "attemptIndex must be unique within a turn",
        });
      }
      indexes.add(attempt.attemptIndex);
      if (identities.has(attempt.attemptIdentity)) {
        ctx.addIssue({
          code: "custom",
          path: ["attempts"],
          message: "attemptIdentity must be unique within a turn",
        });
      }
      identities.add(attempt.attemptIdentity);
    }

    const knownAttempts = record.attempts.filter(
      (attempt) => attempt.costCompleteness === "KNOWN",
    ).length;
    const unknownAttempts = record.attempts.length - knownAttempts;

    if (record.attempts.length === 0) {
      if (
        record.totalCostUsd !== null &&
        record.totalCostUsd !== undefined
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["totalCostUsd"],
          message: "a no-call turn must not carry a total cost",
        });
      }
      if (
        record.knownCostSubtotalUsd !== null &&
        record.knownCostSubtotalUsd !== undefined
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["knownCostSubtotalUsd"],
          message: "a no-call turn must not carry a known subtotal",
        });
      }
      if (
        record.costCompleteness !== null &&
        record.costCompleteness !== undefined
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["costCompleteness"],
          message: "a no-call turn has no cost completeness (not applicable)",
        });
      }
      if (record.costCurrency !== null && record.costCurrency !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["costCurrency"],
          message: "a no-call turn must not carry a currency",
        });
      }
      return;
    }

    if (!record.costCompleteness) {
      ctx.addIssue({
        code: "custom",
        path: ["costCompleteness"],
        message: "an attempted turn requires explicit cost completeness",
      });
      return;
    }

    if (record.costCompleteness === "COMPLETE") {
      if (unknownAttempts > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["costCompleteness"],
          message: "COMPLETE cannot hide an unknown attempt cost",
        });
      }
      if (typeof record.totalCostUsd !== "number") {
        ctx.addIssue({
          code: "custom",
          path: ["totalCostUsd"],
          message: "COMPLETE requires a numeric total cost",
        });
      }
      if (typeof record.knownCostSubtotalUsd !== "number") {
        ctx.addIssue({
          code: "custom",
          path: ["knownCostSubtotalUsd"],
          message: "COMPLETE requires a numeric known subtotal",
        });
      }
      if (
        typeof record.totalCostUsd === "number" &&
        typeof record.knownCostSubtotalUsd === "number" &&
        record.totalCostUsd !== record.knownCostSubtotalUsd
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["totalCostUsd"],
          message: "COMPLETE total must equal the known subtotal",
        });
      }
      if (record.costCurrency !== "USD") {
        ctx.addIssue({
          code: "custom",
          path: ["costCurrency"],
          message: "COMPLETE cost requires explicit USD currency",
        });
      }
    }

    if (record.costCompleteness === "PARTIAL") {
      if (knownAttempts === 0 || unknownAttempts === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["costCompleteness"],
          message: "PARTIAL requires both known and unknown attempts",
        });
      }
      if (
        record.totalCostUsd !== null &&
        record.totalCostUsd !== undefined
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["totalCostUsd"],
          message: "PARTIAL must not present a subtotal as a complete total",
        });
      }
      if (typeof record.knownCostSubtotalUsd !== "number") {
        ctx.addIssue({
          code: "custom",
          path: ["knownCostSubtotalUsd"],
          message: "PARTIAL requires a numeric known subtotal",
        });
      }
      if (record.costCurrency !== "USD") {
        ctx.addIssue({
          code: "custom",
          path: ["costCurrency"],
          message: "PARTIAL cost requires explicit USD currency",
        });
      }
    }

    if (record.costCompleteness === "UNAVAILABLE") {
      if (knownAttempts > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["costCompleteness"],
          message: "UNAVAILABLE cannot hide a known attempt cost",
        });
      }
      if (
        record.totalCostUsd !== null &&
        record.totalCostUsd !== undefined
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["totalCostUsd"],
          message: "UNAVAILABLE must not carry a total cost",
        });
      }
      if (
        record.knownCostSubtotalUsd !== null &&
        record.knownCostSubtotalUsd !== undefined &&
        record.knownCostSubtotalUsd !== 0
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["knownCostSubtotalUsd"],
          message: "UNAVAILABLE cannot carry a positive known subtotal",
        });
      }
      if (
        record.costCurrency !== null &&
        record.costCurrency !== undefined
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["costCurrency"],
          message: "UNAVAILABLE must not carry a currency",
        });
      }
    }
  });

/** Bounded tenant/conversation/time-window reconciliation request. */
export const MAX_TURN_EVIDENCE_RECONCILIATION_WINDOW_MS =
  31 * 24 * 60 * 60 * 1000;

const reconcileTurnEvidenceSchema = z
  .object({
    businessId: uuidSchema,
    conversationId: uuidSchema.nullish(),
    from: z.date(),
    to: z.date(),
    limit: z.number().int().min(1).max(500).default(200),
  })
  .superRefine((value, ctx) => {
    if (value.from.getTime() >= value.to.getTime()) {
      ctx.addIssue({
        code: "custom",
        path: ["to"],
        message: "time window must be non-empty",
      });
    }
    if (
      value.to.getTime() - value.from.getTime() >
      MAX_TURN_EVIDENCE_RECONCILIATION_WINDOW_MS
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["to"],
        message: "time window exceeds the 31-day reconciliation bound",
      });
    }
  });

export type DurableTurnEvidenceAttemptDto = z.infer<
  typeof durableAttemptSchema
>;
export type DurableTurnEvidenceDto = z.infer<
  typeof durableTurnEvidenceSchema
>;
export type ReconcileTurnEvidenceDto = z.infer<
  typeof reconcileTurnEvidenceSchema
>;

export const durableTurnEvidenceValidation = {
  record: durableTurnEvidenceSchema,
  reconcile: reconcileTurnEvidenceSchema,
} as const;
