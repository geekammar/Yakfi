/**
 * FlowPilot — DURABLE TURN EVIDENCE check (offline, no DB).
 *
 * Verifies the pure projection + persistence allowlist that back the durable
 * flowpilot.turn.evidence.durable@v1 record:
 *   1. one successful attempt with provider-reported cost;
 *   2. multiple attempts / fallback identities and total;
 *   3. known + unknown => PARTIAL, never a complete total;
 *   4. real zero distinct from unknown (null);
 *   5. no-call turns create no fictitious attempt/cost;
 *   6. content-free allowlist + unknown-field stripping;
 *   7. bounded payload (attempt count / field sizes / invalid cost shapes).
 *
 * The disposable-PostgreSQL suite (`test:turn-evidence-durable-db`) covers the
 * replay, concurrency, tenant and round-trip cases that need a real database.
 *
 * Run: pnpm check:durable-turn-evidence
 */

import type { TurnExecutionAttempt } from "../src/features/conversations/server/ai-observability";
import type { InboundSuccess } from "../src/features/conversations/server/conversation-engine";
import { buildDurableTurnEvidence } from "../src/features/conversations/server/durable-turn-evidence";
import {
  buildTurnEvidence,
  type TurnEvidence,
} from "../src/features/conversations/server/turn-evidence";
import { durableTurnEvidenceValidation } from "../src/lib/validation";

export {};

type Check = { label: string; pass: boolean };
const checks: Check[] = [];
function check(label: string, pass: boolean): void {
  checks.push({ label, pass });
}

const BUSINESS = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "22222222-2222-4222-8222-222222222222";
const MESSAGE = "33333333-3333-4333-8333-333333333333";
const TRACE = "abcdef0123456789abcdef0123456789";
const META = {
  environment: "test",
  appVersion: "0.79.22",
  emittedAt: new Date("2026-11-16T10:00:00.000Z"),
};
const EXTRA_SECRET = "THIS-MUST-NEVER-BE-PERSISTED";

function attempt(
  overrides: Partial<TurnExecutionAttempt> &
    Pick<TurnExecutionAttempt, "attempt" | "provider" | "status">,
): TurnExecutionAttempt {
  return {
    model: "model-1",
    httpAttempts: 1,
    inputTokens: 100,
    outputTokens: 20,
    ...overrides,
  };
}

function evidence(
  attempts: TurnExecutionAttempt[] | null,
  costs: {
    totalCostUsd?: number | null;
    knownCostSubtotalUsd?: number | null;
    costCompleteness?: "COMPLETE" | "PARTIAL" | "UNAVAILABLE" | null;
  } = {},
  options: {
    providerStatus?: "SUCCESS" | "FAILURE" | "NOT_CALLED";
    routingDecision?: string;
    finalOutcome?: string;
    assistantAction?: string;
    noObservability?: boolean;
    policyUnavailable?: boolean;
  } = {},
): TurnEvidence {
  const result: InboundSuccess = {
    ok: true,
    duplicate: false,
    businessId: BUSINESS,
    conversationId: CONVERSATION,
    customerId: "44444444-4444-4444-8444-444444444444",
    customerMessageId: MESSAGE,
    assistantAction: (options.assistantAction ?? "AI_REPLY") as never,
    intent: "FAQ",
    conversationStatus: "AI_ACTIVE",
    handoffCause: null,
    assistantProvider: "openrouter",
    delivery: { provider: "telegram", delivered: true },
    ...(options.noObservability
      ? {}
      : {
          observability: {
            routingDecision: (options.routingDecision ?? "LLM") as never,
            traceId: TRACE,
            provider: "openrouter",
            model: "model-1",
            providerStatus: options.providerStatus ?? "SUCCESS",
            ...(options.policyUnavailable
              ? { policyUnavailable: true as const }
              : {}),
            executionAttempts: attempts ?? undefined,
            totalCostUsd: costs.totalCostUsd,
            knownCostSubtotalUsd: costs.knownCostSubtotalUsd,
            costCompleteness: costs.costCompleteness ?? undefined,
          },
        }),
  };
  const record = buildTurnEvidence(result, META);
  const finalRecord = options.finalOutcome
    ? { ...record, finalOutcome: options.finalOutcome }
    : record;
  // Simulate a hostile extra field on the source record. The projection must
  // never copy unknown keys.
  return {
    ...finalRecord,
    messageText: EXTRA_SECRET,
    prompt: EXTRA_SECRET,
    rawProviderPayload: EXTRA_SECRET,
    secret: EXTRA_SECRET,
  } as TurnEvidence;
}

function parseOk(value: unknown): boolean {
  return durableTurnEvidenceValidation.record.safeParse(value).success;
}

function main(): void {
  // ── 1. One successful model attempt with reported cost ──────────────────
  const oneCost = 0.0001234;
  const one = buildDurableTurnEvidence(
    evidence(
      [
        attempt({
          attempt: 1,
          provider: "openrouter",
          status: "SUCCESS",
          costUsd: oneCost,
          costSource: "PROVIDER_REPORTED",
        }),
      ],
      {
        totalCostUsd: oneCost,
        knownCostSubtotalUsd: oneCost,
        costCompleteness: "COMPLETE",
      },
    ),
    "SERVING",
  );
  check(
    "one attempt: schema",
    one.schema === "flowpilot.turn.evidence.durable@v1",
  );
  check("one attempt: attempts persisted", one.attempts.length === 1);
  check("one attempt: cost preserved", one.attempts[0]?.costUsd === oneCost);
  check(
    "one attempt: provenance",
    one.attempts[0]?.costProvenance === "PROVIDER_REPORTED",
  );
  check(
    "one attempt: identity anchored to trace",
    one.attempts[0]?.attemptIdentity === `${TRACE}:attempt:1`,
  );
  check("one attempt: total preserved", one.totalCostUsd === oneCost);
  check(
    "one attempt: subtotal preserved",
    one.knownCostSubtotalUsd === oneCost,
  );
  check("one attempt: completeness", one.costCompleteness === "COMPLETE");
  check("one attempt: DTO valid", parseOk(one));

  // ── 2. Multiple attempts / fallback ─────────────────────────────────────
  const multi = buildDurableTurnEvidence(
    evidence(
      [
        attempt({
          attempt: 1,
          provider: "openrouter",
          status: "FAILURE",
          costUsd: 0.0004,
          costSource: "PROVIDER_REPORTED",
          errorCode: "TIMEOUT",
          httpStatus: 504,
        }),
        attempt({
          attempt: 2,
          provider: "agentrouter",
          model: "model-2",
          status: "SUCCESS",
          costUsd: 0.0006,
          costSource: "PROVIDER_REPORTED",
        }),
      ],
      {
        totalCostUsd: 0.001,
        knownCostSubtotalUsd: 0.001,
        costCompleteness: "COMPLETE",
      },
    ),
    "SERVING",
  );
  check("multi attempt: two identities", multi.attempts.length === 2);
  check(
    "multi attempt: indices stable",
    multi.attempts[0]?.attemptIndex === 1 &&
      multi.attempts[1]?.attemptIndex === 2,
  );
  check(
    "multi attempt: providers retained",
    multi.attempts[0]?.provider === "openrouter" &&
      multi.attempts[1]?.provider === "agentrouter",
  );
  check("multi attempt: total is sum", multi.totalCostUsd === 0.001);
  check("multi attempt: DTO valid", parseOk(multi));

  // ── 3. Known + unknown => PARTIAL, not complete ─────────────────────────
  const partial = buildDurableTurnEvidence(
    evidence(
      [
        attempt({
          attempt: 1,
          provider: "openrouter",
          status: "FAILURE",
          costUsd: 0.0002,
          costSource: "PROVIDER_REPORTED",
        }),
        attempt({
          attempt: 2,
          provider: "agentrouter",
          status: "FAILURE",
          costUsd: undefined,
        }),
      ],
      {
        totalCostUsd: null,
        knownCostSubtotalUsd: 0.0002,
        costCompleteness: "PARTIAL",
      },
    ),
    "SERVING",
  );
  check("partial: completeness", partial.costCompleteness === "PARTIAL");
  check("partial: total is null", partial.totalCostUsd === null);
  check(
    "partial: known subtotal preserved",
    partial.knownCostSubtotalUsd === 0.0002,
  );
  check(
    "partial: unknown attempt cost is null",
    partial.attempts[1]?.costUsd === null,
  );
  check("partial: DTO valid", parseOk(partial));
  check(
    "partial: complete total rejected",
    !parseOk({ ...partial, totalCostUsd: 0.0002 }),
  );

  // ── 4. Real zero is distinct from unknown ───────────────────────────────
  const zero = buildDurableTurnEvidence(
    evidence(
      [
        attempt({
          attempt: 1,
          provider: "openrouter",
          status: "SUCCESS",
          costUsd: 0,
          costSource: "PROVIDER_REPORTED",
        }),
      ],
      {
        totalCostUsd: 0,
        knownCostSubtotalUsd: 0,
        costCompleteness: "COMPLETE",
      },
    ),
    "SERVING",
  );
  const unknown = buildDurableTurnEvidence(
    evidence(
      [attempt({ attempt: 1, provider: "openrouter", status: "FAILURE" })],
      {
        totalCostUsd: null,
        knownCostSubtotalUsd: null,
        costCompleteness: "UNAVAILABLE",
      },
    ),
    "SERVING",
  );
  check("zero: real zero total", zero.totalCostUsd === 0);
  check("zero: attempt known", zero.attempts[0]?.costCompleteness === "KNOWN");
  check("zero: currency explicit", zero.costCurrency === "USD");
  check("unknown: total null", unknown.totalCostUsd === null);
  check(
    "unknown: attempt unknown",
    unknown.attempts[0]?.costCompleteness === "UNKNOWN",
  );
  check("unknown: no currency", unknown.costCurrency === null);
  check("zero/unknown distinct", zero.totalCostUsd !== unknown.totalCostUsd);

  // ── 5. No-call vs unavailable execution ─────────────────────────────────
  const noCall = buildDurableTurnEvidence(
    evidence(
      null,
      {},
      {
        providerStatus: "NOT_CALLED",
        routingDecision: "DETERMINISTIC_BYPASS",
      },
    ),
    "TEST",
  );
  check("no-call: zero attempts", noCall.attempts.length === 0);
  check(
    "no-call: proven no-call",
    noCall.executionEvidence === "PROVEN_NO_CALL",
  );
  check("no-call: no total", noCall.totalCostUsd === null);
  check("no-call: no subtotal", noCall.knownCostSubtotalUsd === null);
  check("no-call: no completeness", noCall.costCompleteness === null);
  check("no-call: explicit TEST pool", noCall.trafficPool === "TEST");
  check("no-call: DTO valid", parseOk(noCall));

  const policyNoCall = buildDurableTurnEvidence(
    evidence(
      null,
      {},
      {
        providerStatus: "NOT_CALLED",
        routingDecision: "NONE",
        assistantAction: "AI_HANDOFF",
        finalOutcome: "AI_HANDOFF",
        policyUnavailable: true,
      },
    ),
    "SERVING",
  );
  check(
    "policy no-call: proven no-call",
    policyNoCall.executionEvidence === "PROVEN_NO_CALL",
  );
  check("policy no-call: zero attempts", policyNoCall.attempts.length === 0);
  check("policy no-call: no total", policyNoCall.totalCostUsd === null);
  check(
    "policy no-call: no completeness",
    policyNoCall.costCompleteness === null,
  );
  check("policy no-call: DTO valid", parseOk(policyNoCall));

  const deferred = buildDurableTurnEvidence(
    evidence(
      null,
      {},
      {
        noObservability: true,
        assistantAction: "DEFERRED_TO_STAFF",
        finalOutcome: "DEFERRED_TO_STAFF",
      },
    ),
    "TEST",
  );
  check(
    "deferred: proven no-call",
    deferred.executionEvidence === "PROVEN_NO_CALL",
  );
  check("deferred: DTO valid", parseOk(deferred));

  const absentTelemetry = buildDurableTurnEvidence(
    evidence(null, {}, { providerStatus: "SUCCESS", routingDecision: "LLM" }),
    "TEST",
  );
  check(
    "absent telemetry: execution UNAVAILABLE",
    absentTelemetry.executionEvidence === "UNAVAILABLE",
  );
  check("absent telemetry: DTO valid", parseOk(absentTelemetry));

  const unknownHttp = buildDurableTurnEvidence(
    evidence(
      [
        attempt({
          attempt: 1,
          provider: "openrouter",
          status: "SUCCESS",
          httpAttempts: undefined,
          costUsd: 0.0005,
          costSource: "PROVIDER_REPORTED",
        }),
      ],
      {
        totalCostUsd: 0.0005,
        knownCostSubtotalUsd: 0.0005,
        costCompleteness: "COMPLETE",
      },
    ),
    "SERVING",
  );
  check(
    "unknown HTTP: dispatch UNKNOWN",
    unknownHttp.attempts[0]?.dispatchState === "UNKNOWN",
  );
  check(
    "unknown HTTP: confirmed dispatches separate",
    unknownHttp.confirmedHttpDispatches === 0 &&
      unknownHttp.unknownDispatchAttemptCount === 1,
  );
  check(
    "unknown HTTP: cost still known",
    unknownHttp.attempts[0]?.costUsd === 0.0005,
  );
  check("unknown HTTP: DTO valid", parseOk(unknownHttp));

  const prevented = buildDurableTurnEvidence(
    evidence(
      [
        attempt({
          attempt: 1,
          provider: "openrouter",
          status: "FAILURE",
          httpAttempts: 0,
        }),
      ],
      {
        totalCostUsd: null,
        knownCostSubtotalUsd: null,
        costCompleteness: "UNAVAILABLE",
      },
    ),
    "SERVING",
  );
  check(
    "prevented: dispatch PREVENTED",
    prevented.attempts[0]?.dispatchState === "PREVENTED",
  );
  check(
    "prevented: provenance is proven zero",
    prevented.attempts[0]?.costProvenance === "ZERO_DISPATCH_PREVENTED" &&
      prevented.attempts[0]?.costUsd === 0,
  );
  check("prevented: count", prevented.preventedAttemptCount === 1);
  check("prevented: DTO valid", parseOk(prevented));

  // ── 6. Content-free allowlist ────────────────────────────────────────────
  const serialized = JSON.stringify(one);
  check(
    "redaction: no source message text",
    !serialized.includes(EXTRA_SECRET),
  );
  check("redaction: no prompt field", !("prompt" in one));
  check("redaction: no raw payload field", !("rawProviderPayload" in one));
  const allowedKeys = new Set([
    "schema",
    "businessId",
    "conversationId",
    "customerMessageId",
    "traceId",
    "trafficPool",
    "executionEvidence",
    "occurredAt",
    "appVersion",
    "environment",
    "intent",
    "assistantAction",
    "conversationStatus",
    "handoffCause",
    "routingDecision",
    "provider",
    "model",
    "providerStatus",
    "stopReason",
    "finalOutcome",
    "outboundSendAttempted",
    "outboundSendDelivered",
    "outboundDeliveryErrorCode",
    "totalCostUsd",
    "knownCostSubtotalUsd",
    "costCompleteness",
    "costCurrency",
    "logicalAttemptCount",
    "confirmedHttpDispatches",
    "unknownDispatchAttemptCount",
    "preventedAttemptCount",
    "attempts",
  ]);
  check(
    "redaction: parent keys are the allowlist",
    Object.keys(one).every((key) => allowedKeys.has(key)),
  );
  const attemptKeys = new Set([
    "attemptIndex",
    "attemptIdentity",
    "provider",
    "model",
    "status",
    "dispatchState",
    "httpAttempts",
    "inputTokens",
    "outputTokens",
    "costUsd",
    "costCurrency",
    "costProvenance",
    "costCompleteness",
    "errorCode",
    "httpStatus",
  ]);
  check(
    "redaction: attempt keys are the allowlist",
    Object.keys(one.attempts[0] ?? {}).every((key) => attemptKeys.has(key)),
  );
  check(
    "redaction: validation strips unknown fields",
    !(
      "messageText" in
      durableTurnEvidenceValidation.record.parse({
        ...one,
        messageText: EXTRA_SECRET,
      })
    ),
  );

  // ── 7. Payload bounds ────────────────────────────────────────────────────
  let tooManyAttempts = false;
  try {
    buildDurableTurnEvidence(
      evidence(
        Array.from({ length: 17 }, (_, index) =>
          attempt({
            attempt: index + 1,
            provider: "openrouter",
            status: "SUCCESS",
            costUsd: 0,
            costSource: "PROVIDER_REPORTED",
          }),
        ),
        {
          totalCostUsd: 0,
          knownCostSubtotalUsd: 0,
          costCompleteness: "COMPLETE",
        },
      ),
      "SERVING",
    );
  } catch {
    tooManyAttempts = true;
  }
  check("bounds: 17 attempts rejected", tooManyAttempts);
  check(
    "bounds: overlong provider rejected",
    !parseOk({
      ...one,
      attempts: [{ ...one.attempts[0]!, provider: "x".repeat(65) }],
    }),
  );
  check(
    "bounds: negative cost rejected",
    !parseOk({ ...one, totalCostUsd: -1 }),
  );
  check(
    "bounds: non-finite cost rejected",
    !parseOk({ ...one, totalCostUsd: Number.POSITIVE_INFINITY }),
  );
  check(
    "bounds: unknown attempt cannot carry cost",
    !parseOk({
      ...partial,
      attempts: [
        partial.attempts[0]!,
        { ...partial.attempts[1]!, costUsd: 0.5 },
      ],
    }),
  );

  const failed = checks.filter((entry) => !entry.pass);
  for (const entry of checks) {
    console.log(`${entry.pass ? "✓" : "✗"} ${entry.label}`);
  }
  console.log(
    `\n${checks.length - failed.length}/${checks.length} durable turn-evidence checks passed.`,
  );
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main();
