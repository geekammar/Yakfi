/* eslint-disable @typescript-eslint/consistent-type-imports */
/**
 * FlowPilot — Commercial Session Measurement Contract & Cost Engine Acceptance Suite
 * (flowpilot.commercial.session.contract@v1 & flowpilot.cost.engine@v1)
 *
 * Deterministic, OFFLINE verification of:
 * - Half-open UTC 24h session intervals [start, start + 24h).
 * - Qualifying events, start-only commands, callbacks, and duplicate filtering.
 * - Batch ordering permutation invariance (sorting + tie-breaking).
 * - Period carry-in, deterministic prior ordering, watermark enforcement, and verifiable replay.
 * - Explicit scope identification (tenant + channel + connection + customer).
 * - Operational pool isolation: SERVING, SHADOW, and TEST maintain disjoint sessions.
 * - Tenant-scoped idempotency: identical replay is skipped; conflicting facts throw Error.
 * - Event count semantics: qualifyingEventCount vs totalEventCount / eventCount.
 * - Explicit snapshot references: provider/model matching, applicability, and immutable ID uniqueness.
 * - Real calendar date validation (YYYY-MM-DD day limits).
 * - Fail-closed runtime validation and arithmetic overflow protection.
 * - Zero dispatch contradiction rejection.
 * - Full IEEE 754 precision preservation without premature micro-cost rounding.
 * - Strict content-free output projection stripping arbitrary runtime properties.
 *
 * Zero DB, zero network, zero AI calls, zero external side effects.
 */

import {
  COMMERCIAL_SESSION_CONTRACT_VERSION,
  COST_ENGINE_VERSION,
  SESSION_DURATION_MS,
  buildIdentityScopeKey,
  evaluateAttemptCost,
  evaluateTurnCost,
  formatMicroUsd,
  rollupCommercialSessions,
  toCanonicalTimestampMs,
  type CanonicalInboundEvent,
  type CommercialSession,
  type IdentityScope,
  type ModelRateSnapshot,
  type PhysicalAttemptFact,
} from "../src/features/economics";

interface CheckResult {
  readonly label: string;
  readonly pass: boolean;
  readonly details?: string;
}

const checks: CheckResult[] = [];

function check(label: string, pass: boolean, details?: string): void {
  checks.push({ label, pass, details });
}

function makeScope(overrides?: Partial<IdentityScope>): IdentityScope {
  return {
    businessId: overrides?.businessId ?? "biz-1",
    customerId: overrides?.customerId ?? "cust-1",
    channel: overrides?.channel ?? "telegram",
    connectionId: overrides?.connectionId ?? "bot-conn-1",
  };
}

function makeEvent(
  overrides?: Partial<CanonicalInboundEvent>,
): CanonicalInboundEvent {
  return {
    eventId: overrides?.eventId ?? "evt-1",
    canonicalTimestamp:
      overrides?.canonicalTimestamp ?? "2026-10-01T10:00:00.000Z",
    senderType: overrides?.senderType ?? "CUSTOMER",
    actionType: overrides?.actionType ?? "MESSAGE",
    scope: overrides?.scope ?? makeScope(),
    isDuplicate: overrides?.isDuplicate ?? false,
    trafficPool: overrides?.trafficPool ?? "SERVING",
  };
}

function runSuite(): void {
  // ═══════════════════════════════════════════════════════════════════════
  // GROUP 1: Canonical Timestamp Parsing & Timezone Offset Enforcement
  // ═══════════════════════════════════════════════════════════════════════
  const tIso = toCanonicalTimestampMs("2026-10-01T12:00:00.000Z");
  const tDate = toCanonicalTimestampMs(new Date("2026-10-01T12:00:00.000Z"));
  check(
    "G1.1 toCanonicalTimestampMs parses valid ISO string and Date identically",
    tIso === tDate && tIso === 1790856000000,
  );

  let throwsOnNaive = false;
  try {
    // Naive ISO string without timezone offset
    toCanonicalTimestampMs("2026-10-01T12:00:00.000");
  } catch {
    throwsOnNaive = true;
  }
  check(
    "G1.2 toCanonicalTimestampMs throws on naive timestamp missing explicit timezone offset",
    throwsOnNaive,
  );

  let throwsOnEmpty = false;
  try {
    toCanonicalTimestampMs("   ");
  } catch {
    throwsOnEmpty = true;
  }
  check(
    "G1.3 toCanonicalTimestampMs throws on empty or whitespace string",
    throwsOnEmpty,
  );

  let throwsOnInvalid = false;
  try {
    toCanonicalTimestampMs("not-a-date");
  } catch {
    throwsOnInvalid = true;
  }
  check(
    "G1.4 toCanonicalTimestampMs throws on invalid date string",
    throwsOnInvalid,
  );

  // ═══════════════════════════════════════════════════════════════════════
  // GROUP 2: Exact 24-Hour Half-Open Window [start, start + 24h)
  // ═══════════════════════════════════════════════════════════════════════
  const baseT = "2026-10-01T10:00:00.000Z";
  const insideT = new Date(
    Date.parse(baseT) + SESSION_DURATION_MS - 1,
  ).toISOString(); // T + 24h - 1ms
  const boundaryT = new Date(
    Date.parse(baseT) + SESSION_DURATION_MS,
  ).toISOString(); // T + 24h exactly

  const res24h = rollupCommercialSessions([
    makeEvent({ eventId: "e1", canonicalTimestamp: baseT }),
    makeEvent({ eventId: "e2", canonicalTimestamp: insideT }),
  ]);
  check(
    "G2.1 Event at T + 24h - 1ms falls inside active half-open window (1 session, count=2)",
    res24h.sessions.length === 1 &&
      res24h.sessions[0]?.eventCount === 2 &&
      res24h.sessions[0]?.qualifyingEventCount === 2,
  );

  const resNewWindow = rollupCommercialSessions([
    makeEvent({ eventId: "e1", canonicalTimestamp: baseT }),
    makeEvent({ eventId: "e2", canonicalTimestamp: insideT }),
    makeEvent({ eventId: "e3", canonicalTimestamp: boundaryT }),
  ]);
  check(
    "G2.2 Event at exact boundary T + 24h opens a new session (2 sessions total)",
    resNewWindow.sessions.length === 2 &&
      resNewWindow.sessions[0]?.eventCount === 2 &&
      resNewWindow.sessions[1]?.eventCount === 1 &&
      resNewWindow.sessions[1]?.initiatingEventId === "e3",
  );

  // ═══════════════════════════════════════════════════════════════════════
  // GROUP 3: Start-Only Protocol vs Interactive Choice Callbacks
  // ═══════════════════════════════════════════════════════════════════════
  const resStartOnly = rollupCommercialSessions([
    makeEvent({
      eventId: "s1",
      actionType: "START_COMMAND",
      canonicalTimestamp: "2026-10-01T10:00:00Z",
    }),
  ]);
  check(
    "G3.1 Start-only command does not open a commercial session (0 sessions, ignored=1)",
    resStartOnly.sessions.length === 0 &&
      resStartOnly.startOnlyIgnoredCount === 1,
  );

  const resStartThenCallback = rollupCommercialSessions([
    makeEvent({
      eventId: "s1",
      actionType: "START_COMMAND",
      canonicalTimestamp: "2026-10-01T10:00:00Z",
    }),
    makeEvent({
      eventId: "cb1",
      actionType: "CHOICE_CALLBACK",
      canonicalTimestamp: "2026-10-01T10:05:00Z",
    }),
  ]);
  check(
    "G3.2 Subsequent CHOICE_CALLBACK initiates session successfully",
    resStartThenCallback.sessions.length === 1 &&
      resStartThenCallback.sessions[0]?.initiatingEventId === "cb1" &&
      resStartThenCallback.sessions[0]?.qualifyingEventCount === 1 &&
      resStartThenCallback.startOnlyIgnoredCount === 1,
  );

  // ═══════════════════════════════════════════════════════════════════════
  // GROUP 4: Idempotency, Duplicate Interception & Tenant Conflict Detection
  // ═══════════════════════════════════════════════════════════════════════
  const resFlaggedDedupe = rollupCommercialSessions([
    makeEvent({ eventId: "d1", canonicalTimestamp: "2026-10-01T10:00:00Z" }),
    makeEvent({
      eventId: "d1-dup",
      isDuplicate: true,
      canonicalTimestamp: "2026-10-01T10:00:01Z",
    }),
  ]);
  check(
    "G4.1 Explicit isDuplicate flag excludes payload (filteredDuplicateCount=1)",
    resFlaggedDedupe.sessions.length === 1 &&
      resFlaggedDedupe.sessions[0]?.eventCount === 1 &&
      resFlaggedDedupe.filteredDuplicateCount === 1,
  );

  // Repeated identical event identity in batch (idempotent replay)
  const resIdenticalReplay = rollupCommercialSessions([
    makeEvent({ eventId: "rep-1", canonicalTimestamp: "2026-10-01T10:00:00Z" }),
    makeEvent({ eventId: "rep-1", canonicalTimestamp: "2026-10-01T10:00:00Z" }),
  ]);
  check(
    "G4.2 Repeated identical event identity in batch is idempotent (filteredDuplicateCount=1, eventCount=1)",
    resIdenticalReplay.sessions.length === 1 &&
      resIdenticalReplay.sessions[0]?.eventCount === 1 &&
      resIdenticalReplay.filteredDuplicateCount === 1,
  );

  // Conflicting facts for the same tenant event identity must fail explicitly
  let throwsOnConflict = false;
  try {
    rollupCommercialSessions([
      makeEvent({
        eventId: "conf-1",
        canonicalTimestamp: "2026-10-01T10:00:00Z",
        actionType: "MESSAGE",
      }),
      makeEvent({
        eventId: "conf-1",
        canonicalTimestamp: "2026-10-01T10:05:00Z", // conflicting timestamp
        actionType: "MESSAGE",
      }),
    ]);
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.message.includes("Event fact conflict detected")
    ) {
      throwsOnConflict = true;
    }
  }
  check(
    "G4.3 Conflicting facts for same tenant eventId throw explicit conflict Error",
    throwsOnConflict,
  );

  // Cross-tenant eventId collision is safe (different tenants)
  const resCrossTenant = rollupCommercialSessions([
    makeEvent({
      eventId: "shared-id",
      canonicalTimestamp: "2026-10-01T10:00:00Z",
      scope: makeScope({ businessId: "tenant-a" }),
    }),
    makeEvent({
      eventId: "shared-id",
      canonicalTimestamp: "2026-10-01T10:00:00Z",
      scope: makeScope({ businessId: "tenant-b" }),
    }),
  ]);
  check(
    "G4.4 Identical eventId across different tenants is isolated without false conflict",
    resCrossTenant.sessions.length === 2 &&
      resCrossTenant.filteredDuplicateCount === 0,
  );

  // ═══════════════════════════════════════════════════════════════════════
  // GROUP 5: Operational Traffic Pool Isolation (SERVING, SHADOW, TEST)
  // ═══════════════════════════════════════════════════════════════════════
  const poolScope = makeScope();
  const poolTime = "2026-10-01T10:00:00.000Z";

  // Identical scope and timestamp across SERVING, TEST, SHADOW in order 1: SERVING then TEST
  const resServingThenTest = rollupCommercialSessions([
    makeEvent({
      eventId: "e-serv",
      trafficPool: "SERVING",
      scope: poolScope,
      canonicalTimestamp: poolTime,
    }),
    makeEvent({
      eventId: "e-test",
      trafficPool: "TEST",
      scope: poolScope,
      canonicalTimestamp: poolTime,
    }),
  ]);

  // Order 2: TEST then SERVING
  const resTestThenServing = rollupCommercialSessions([
    makeEvent({
      eventId: "e-test",
      trafficPool: "TEST",
      scope: poolScope,
      canonicalTimestamp: poolTime,
    }),
    makeEvent({
      eventId: "e-serv",
      trafficPool: "SERVING",
      scope: poolScope,
      canonicalTimestamp: poolTime,
    }),
  ]);

  check(
    "G5.1 Traffic pools SERVING and TEST maintain strictly isolated sessions regardless of input order",
    resServingThenTest.sessions.length === 2 &&
      resTestThenServing.sessions.length === 2 &&
      resServingThenTest.metricsByPool.SERVING.sessionCount === 1 &&
      resServingThenTest.metricsByPool.TEST.sessionCount === 1 &&
      resTestThenServing.metricsByPool.SERVING.sessionCount === 1 &&
      resTestThenServing.metricsByPool.TEST.sessionCount === 1 &&
      resServingThenTest.sessions.some(
        (s) => s.trafficPool === "SERVING" && s.initiatingEventId === "e-serv",
      ) &&
      resServingThenTest.sessions.some(
        (s) => s.trafficPool === "TEST" && s.initiatingEventId === "e-test",
      ),
  );

  // ═══════════════════════════════════════════════════════════════════════
  // GROUP 6: Permutation Invariance (Batch Ordering & Tie-Breaking)
  // ═══════════════════════════════════════════════════════════════════════
  const rawBatch: CanonicalInboundEvent[] = [
    makeEvent({
      eventId: "evt-01",
      canonicalTimestamp: "2026-10-01T10:00:00Z",
    }),
    makeEvent({
      eventId: "evt-02",
      canonicalTimestamp: "2026-10-01T12:00:00Z",
    }),
    makeEvent({
      eventId: "evt-03",
      canonicalTimestamp: "2026-10-01T12:00:00Z",
    }), // tie in ms
    makeEvent({
      eventId: "evt-04",
      canonicalTimestamp: "2026-10-02T15:00:00Z",
    }), // session 2
    makeEvent({
      eventId: "evt-05",
      canonicalTimestamp: "2026-10-02T16:00:00Z",
    }),
  ];

  const chronological = rollupCommercialSessions(rawBatch);
  const reversed = rollupCommercialSessions([...rawBatch].reverse());
  const shuffled = rollupCommercialSessions([
    rawBatch[3]!,
    rawBatch[0]!,
    rawBatch[4]!,
    rawBatch[2]!,
    rawBatch[1]!,
  ]);

  const jsonChrono = JSON.stringify(chronological);
  const jsonReversed = JSON.stringify(reversed);
  const jsonShuffled = JSON.stringify(shuffled);

  check(
    "G6.1 Batch results are byte-for-byte invariant under input permutation",
    jsonChrono === jsonReversed && jsonChrono === jsonShuffled,
  );

  // ═══════════════════════════════════════════════════════════════════════
  // GROUP 7: Event Counts & In-Session Assistant / Start Events
  // ═══════════════════════════════════════════════════════════════════════
  const resInSessionAssistant = rollupCommercialSessions([
    makeEvent({
      eventId: "cust-start",
      senderType: "CUSTOMER",
      actionType: "MESSAGE",
      canonicalTimestamp: "2026-10-01T10:00:00Z",
    }),
    makeEvent({
      eventId: "bot-reply",
      senderType: "ASSISTANT",
      actionType: "ASSISTANT_REPLY",
      canonicalTimestamp: "2026-10-01T10:00:05Z",
    }),
    makeEvent({
      eventId: "cust-start-cmd",
      senderType: "CUSTOMER",
      actionType: "START_COMMAND",
      canonicalTimestamp: "2026-10-01T10:01:00Z",
    }),
  ]);

  check(
    "G7.1 In-session assistant reply and start command increment totalEventCount but not qualifyingEventCount",
    resInSessionAssistant.sessions.length === 1 &&
      resInSessionAssistant.sessions[0]?.qualifyingEventCount === 1 &&
      resInSessionAssistant.sessions[0]?.totalEventCount === 3 &&
      resInSessionAssistant.sessions[0]?.eventCount === 3 &&
      resInSessionAssistant.sessions[0]?.eventIds.length === 3,
  );

  // Assistant reply arriving outside open session is ignored and does not open a session
  const resAssistantOnly = rollupCommercialSessions([
    makeEvent({
      eventId: "bot-orphan",
      senderType: "ASSISTANT",
      actionType: "ASSISTANT_REPLY",
      canonicalTimestamp: "2026-10-01T10:00:00Z",
    }),
  ]);
  check(
    "G7.2 Orphan assistant reply outside open session does not initiate a session (nonCustomerIgnoredCount=1)",
    resAssistantOnly.sessions.length === 0 &&
      resAssistantOnly.nonCustomerIgnoredCount === 1,
  );

  // ═══════════════════════════════════════════════════════════════════════
  // GROUP 8: Period Carry-In, Deterministic Prior Ordering & Overlap Rejection
  // ═══════════════════════════════════════════════════════════════════════
  const priorStart = Date.parse("2026-10-31T20:00:00.000Z");
  const priorScope = makeScope();
  const priorSession: CommercialSession = {
    sessionId: `sess_prior`,
    scopeKey: buildIdentityScopeKey(priorScope),
    scope: priorScope,
    trafficPool: "SERVING",
    startAtUtc: new Date(priorStart).toISOString(),
    startMs: priorStart,
    endAtUtc: new Date(priorStart + SESSION_DURATION_MS).toISOString(),
    endMs: priorStart + SESSION_DURATION_MS,
    initiatingEventId: "p1",
    qualifyingEventCount: 3,
    totalEventCount: 3,
    eventCount: 3,
    eventIds: ["p1", "p2", "p3"],
  };

  const resCarryIn = rollupCommercialSessions(
    [
      makeEvent({
        eventId: "nov-1",
        canonicalTimestamp: "2026-11-01T04:00:00.000Z",
      }),
    ],
    { priorSessions: [priorSession] },
  );

  check(
    "G8.1 Qualifying event in new month appends to unexpired carry-in session without new session creation",
    resCarryIn.sessions.length === 1 &&
      resCarryIn.sessions[0]?.sessionId === "sess_prior" &&
      resCarryIn.sessions[0]?.totalEventCount === 4 &&
      resCarryIn.sessions[0]?.qualifyingEventCount === 4 &&
      Boolean(resCarryIn.sessions[0]?.eventIds.includes("nov-1")),
  );

  // Overlapping carry-in sessions for the same pool and scope must throw Error
  let throwsOnOverlappingPrior = false;
  try {
    const overlappingPrior: CommercialSession = {
      ...priorSession,
      sessionId: "sess_prior_overlap",
      startMs: priorStart + 10_000,
      endMs: priorStart + 10_000 + SESSION_DURATION_MS,
      startAtUtc: new Date(priorStart + 10_000).toISOString(),
      endAtUtc: new Date(
        priorStart + 10_000 + SESSION_DURATION_MS,
      ).toISOString(),
      initiatingEventId: "p1",
      qualifyingEventCount: 3,
      totalEventCount: 3,
      eventCount: 3,
      eventIds: ["p1", "p2", "p3"],
    };
    rollupCommercialSessions([], {
      priorSessions: [priorSession, overlappingPrior],
    });
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.message.includes("Contradictory or overlapping prior session")
    ) {
      throwsOnOverlappingPrior = true;
    }
  }
  check(
    "G8.2 Overlapping prior carry-in sessions in same pool and scope throw explicit Error",
    throwsOnOverlappingPrior,
  );

  // ═══════════════════════════════════════════════════════════════════════
  // GROUP 9: Tenant, Channel & Connection Scope Isolation
  // ═══════════════════════════════════════════════════════════════════════
  const sameTime = "2026-10-01T10:00:00.000Z";
  const isoBatch = [
    makeEvent({
      eventId: "c1",
      canonicalTimestamp: sameTime,
      scope: makeScope({ businessId: "b1", connectionId: "c1" }),
    }),
    makeEvent({
      eventId: "c2",
      canonicalTimestamp: sameTime,
      scope: makeScope({ businessId: "b1", connectionId: "c2" }),
    }), // diff conn
    makeEvent({
      eventId: "c3",
      canonicalTimestamp: sameTime,
      scope: makeScope({ businessId: "b2", connectionId: "c1" }),
    }), // diff tenant
    makeEvent({
      eventId: "c4",
      canonicalTimestamp: sameTime,
      scope: makeScope({
        businessId: "b1",
        channel: "whatsapp",
        connectionId: "wa1",
      }),
    }), // diff channel
  ];

  const resIso = rollupCommercialSessions(isoBatch);
  check(
    "G9.1 Different business, channel, connection, or customer maintain strictly isolated sessions",
    resIso.sessions.length === 4,
  );

  // ═══════════════════════════════════════════════════════════════════════
  // GROUP 10: Cost Engine — Retry and Fallback with Historical Rate Provenance
  // ═══════════════════════════════════════════════════════════════════════
  const rateSnapshots: ModelRateSnapshot[] = [
    {
      snapshotId: "rate-deepseek-v3",
      provider: "openrouter",
      model: "deepseek/deepseek-chat",
      effectiveDate: "2026-10-22",
      promptCostPerMillionUsd: 0.2574,
      cachedPromptCostPerMillionUsd: 0.07,
      completionCostPerMillionUsd: 1.0287,
      source: "openrouter_audited",
    },
    {
      snapshotId: "rate-llama-70b",
      provider: "openrouter",
      model: "meta-llama/llama-3.1-70b-instruct",
      effectiveDate: "2026-10-22",
      promptCostPerMillionUsd: 0.4,
      completionCostPerMillionUsd: 0.8,
      source: "openrouter_audited",
    },
  ];

  const retryFallbackAttempts: PhysicalAttemptFact[] = [
    {
      attemptId: "att-1",
      attemptIndex: 1,
      trafficPool: "SERVING",
      provider: "openrouter",
      model: "deepseek/deepseek-chat",
      attemptTimestamp: "2026-10-22T10:00:00Z",
      status: "FAILURE",
      inputTokens: 2000,
      outputTokens: 0,
      latencyMs: 1200,
    },
    {
      attemptId: "att-2",
      attemptIndex: 2,
      trafficPool: "SERVING",
      provider: "openrouter",
      model: "meta-llama/llama-3.1-70b-instruct",
      attemptTimestamp: "2026-10-22T10:00:00Z",
      status: "SUCCESS",
      inputTokens: 2000,
      outputTokens: 250,
      latencyMs: 850,
    },
  ];

  const resRetryCost = evaluateTurnCost(retryFallbackAttempts, rateSnapshots);
  const costAtt1 = (2000 * 0.2574) / 1_000_000; // 0.0005148
  const costAtt2 = (2000 * 0.4 + 250 * 0.8) / 1_000_000; // 0.001000
  const expectedTurnCost = costAtt1 + costAtt2; // 0.0015148

  check(
    "G10.1 Retry and fallback attempts evaluate with respective model rates, sum accurately and preserve provenance",
    resRetryCost.serving.costCompleteness === "COMPLETE" &&
      Math.abs((resRetryCost.serving.totalCostUsd ?? 0) - expectedTurnCost) <
        1e-9 &&
      resRetryCost.serving.knownSubtotalUsd ===
        resRetryCost.serving.totalCostUsd &&
      resRetryCost.attempts[0]?.snapshotId === "rate-deepseek-v3" &&
      resRetryCost.attempts[0]?.rateEffectiveDate === "2026-10-22" &&
      resRetryCost.attempts[0]?.rateSource === "openrouter_audited",
  );

  // ═══════════════════════════════════════════════════════════════════════
  // GROUP 11: Historical Rate Selection & Reversal Invariance
  // ═══════════════════════════════════════════════════════════════════════
  const multiVersionRates: ModelRateSnapshot[] = [
    {
      snapshotId: "rate-old",
      provider: "openrouter",
      model: "test/model",
      effectiveDate: "2026-09-01",
      promptCostPerMillionUsd: 1.0,
      completionCostPerMillionUsd: 2.0,
      source: "v1",
    },
    {
      snapshotId: "rate-current",
      provider: "openrouter",
      model: "test/model",
      effectiveDate: "2026-10-01",
      promptCostPerMillionUsd: 0.5,
      completionCostPerMillionUsd: 1.0,
      source: "v2",
    },
    {
      snapshotId: "rate-future",
      provider: "openrouter",
      model: "test/model",
      effectiveDate: "2026-11-01",
      promptCostPerMillionUsd: 0.1,
      completionCostPerMillionUsd: 0.2,
      source: "v3",
    },
  ];

  // Attempt on 2026-10-15 should match rate-current (2026-10-01), NOT rate-future (2026-11-01) or rate-old (2026-09-01)
  const testAttempt: PhysicalAttemptFact = {
    attemptId: "att-hist",
    attemptIndex: 1,
    trafficPool: "SERVING",
    provider: "openrouter",
    model: "test/model",
    attemptTimestamp: "2026-10-15T10:00:00Z",
    status: "SUCCESS",
    inputTokens: 1000,
    outputTokens: 1000,
  };

  const resForward = evaluateAttemptCost(testAttempt, multiVersionRates);
  const resReversed = evaluateAttemptCost(
    testAttempt,
    [...multiVersionRates].reverse(),
  );

  check(
    "G11.1 Historical rate selection ignores future rates, picks newest applicable snapshot, and is invariant under array reversal",
    resForward.snapshotId === "rate-current" &&
      resReversed.snapshotId === "rate-current" &&
      resForward.costUsd === (1000 * 0.5 + 1000 * 1.0) / 1_000_000 &&
      resForward.costUsd === resReversed.costUsd,
  );

  // Attempt before any snapshot was effective cannot match future rates -> UNKNOWN
  const preAttempt: PhysicalAttemptFact = {
    ...testAttempt,
    attemptTimestamp: "2026-08-01T10:00:00Z",
  };
  const resPre = evaluateAttemptCost(preAttempt, multiVersionRates);
  check(
    "G11.2 Attempt predating all snapshots does not apply future rates (evaluates to UNKNOWN)",
    resPre.completeness === "UNKNOWN" && resPre.costUsd === null,
  );

  // Ambiguous conflicting snapshots at the same effective date throw Error
  let throwsOnSnapshotConflict = false;
  try {
    const conflictingRates: ModelRateSnapshot[] = [
      multiVersionRates[0]!,
      {
        ...multiVersionRates[0]!,
        snapshotId: "rate-conflict-id",
        promptCostPerMillionUsd: 9.99, // conflict
      },
    ];
    evaluateAttemptCost(testAttempt, conflictingRates);
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.message.includes("Ambiguous conflicting rate snapshots")
    ) {
      throwsOnSnapshotConflict = true;
    }
  }
  check(
    "G11.3 Ambiguous conflicting rate snapshots at same effectiveDate throw explicit Error",
    throwsOnSnapshotConflict,
  );

  // ═══════════════════════════════════════════════════════════════════════
  // GROUP 12: Cost Engine — Reported Cost Precedence Including Zero
  // ═══════════════════════════════════════════════════════════════════════
  const zeroReportedAttempt: PhysicalAttemptFact = {
    attemptId: "att-zero",
    attemptIndex: 1,
    trafficPool: "SERVING",
    provider: "openrouter",
    model: "deepseek/deepseek-chat",
    status: "SUCCESS",
    reportedCostUsd: 0.0, // valid zero cost
    inputTokens: 1500,
    outputTokens: 100,
  };

  const resZeroCost = evaluateAttemptCost(zeroReportedAttempt, rateSnapshots);
  check(
    "G12.1 Reported cost of zero is preserved with PROVIDER_REPORTED provenance (not overridden by rate snapshot)",
    resZeroCost.costUsd === 0.0 &&
      resZeroCost.provenance === "PROVIDER_REPORTED" &&
      resZeroCost.completeness === "KNOWN",
  );

  const positiveReportedAttempt: PhysicalAttemptFact = {
    attemptId: "att-pos",
    attemptIndex: 1,
    trafficPool: "SERVING",
    provider: "openrouter",
    model: "deepseek/deepseek-chat",
    status: "SUCCESS",
    reportedCostUsd: 0.0035,
    inputTokens: 1500,
    outputTokens: 100,
  };

  const resPosCost = evaluateAttemptCost(
    positiveReportedAttempt,
    rateSnapshots,
  );
  check(
    "G12.2 Positive reported cost overrides token rate calculation",
    resPosCost.costUsd === 0.0035 &&
      resPosCost.provenance === "PROVIDER_REPORTED",
  );

  // ═══════════════════════════════════════════════════════════════════════
  // GROUP 13: Negative Rule — Never Infer Zero Cost Solely from Status Codes
  // ═══════════════════════════════════════════════════════════════════════
  const timeoutAttempt: PhysicalAttemptFact = {
    attemptId: "att-to",
    attemptIndex: 1,
    trafficPool: "SERVING",
    provider: "openrouter",
    model: "deepseek/deepseek-chat",
    status: "FAILURE",
    httpStatus: 429,
    errorCode: "RATE_LIMITED",
    inputTokens: null, // missing tokens
    outputTokens: null,
  };

  const resTimeout = evaluateAttemptCost(timeoutAttempt, rateSnapshots);
  check(
    "G13.1 Failed attempt with missing tokens/cost evaluates to UNKNOWN (cost=null, never coerced to 0)",
    resTimeout.costUsd === null &&
      resTimeout.provenance === "UNKNOWN" &&
      resTimeout.completeness === "UNKNOWN",
  );

  // ═══════════════════════════════════════════════════════════════════════
  // GROUP 14: All-Unknown vs Mixed Costs & Coverage Ratio
  // ═══════════════════════════════════════════════════════════════════════
  const mixedAttempts: PhysicalAttemptFact[] = [
    {
      attemptId: "m1",
      attemptIndex: 1,
      trafficPool: "SERVING",
      provider: "openrouter",
      model: "deepseek/deepseek-chat",
      status: "SUCCESS",
      reportedCostUsd: 0.0012,
    },
    timeoutAttempt,
  ];

  const resMixed = evaluateTurnCost(mixedAttempts, rateSnapshots);
  check(
    "G14.1 Mixed known and unknown attempts produce PARTIAL completeness with totalCost=null and knownSubtotal preserved",
    resMixed.serving.costCompleteness === "PARTIAL" &&
      resMixed.serving.totalCostUsd === null &&
      resMixed.serving.knownSubtotalUsd === 0.0012 &&
      resMixed.serving.coveragePercentage === "50.0%",
  );

  const resAllUnknown = evaluateTurnCost([timeoutAttempt], rateSnapshots);
  check(
    "G14.2 All-unknown dispatched attempts produce UNAVAILABLE completeness with coverage 0.0%",
    resAllUnknown.serving.costCompleteness === "UNAVAILABLE" &&
      resAllUnknown.serving.totalCostUsd === null &&
      resAllUnknown.serving.coveragePercentage === "0.0%",
  );

  // ═══════════════════════════════════════════════════════════════════════
  // GROUP 15: Locally Prevented Zero Dispatch & Contradiction Rejection
  // ═══════════════════════════════════════════════════════════════════════
  const preventedAttempt: PhysicalAttemptFact = {
    attemptId: "prev-1",
    attemptIndex: 1,
    trafficPool: "SERVING",
    provider: "openrouter",
    locallyPreventedZeroDispatch: true,
    status: "FAILURE",
    errorCode: "GLOBAL_STOP",
  };

  const resPrevented = evaluateTurnCost([preventedAttempt], rateSnapshots);
  check(
    "G15.1 Locally prevented request has 0 dispatched count and null coverage (N/A, not an invented percentage)",
    resPrevented.serving.dispatchedAttempts === 0 &&
      resPrevented.serving.locallyPreventedAttempts === 1 &&
      resPrevented.serving.totalCostUsd === 0 &&
      resPrevented.serving.coverageRatio === null &&
      resPrevented.serving.coveragePercentage === null,
  );

  // Reject contradictory zero dispatch combined with positive cost or tokens
  let throwsOnContradiction = false;
  try {
    evaluateAttemptCost({
      attemptId: "prev-bad",
      attemptIndex: 1,
      trafficPool: "SERVING",
      provider: "openrouter",
      locallyPreventedZeroDispatch: true,
      status: "FAILURE",
      reportedCostUsd: 0.01, // contradictory!
    });
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.message.includes("Contradictory evidence")
    ) {
      throwsOnContradiction = true;
    }
  }
  check(
    "G15.2 Contradictory locallyPreventedZeroDispatch=true with positive cost throws explicit Error",
    throwsOnContradiction,
  );

  // ═══════════════════════════════════════════════════════════════════════
  // GROUP 16: Prompt Caching Without Double Counting & Invariant Enforcement
  // ═══════════════════════════════════════════════════════════════════════
  const cachedAttempt: PhysicalAttemptFact = {
    attemptId: "cache-1",
    attemptIndex: 1,
    trafficPool: "SERVING",
    provider: "openrouter",
    model: "deepseek/deepseek-chat",
    attemptTimestamp: "2026-10-22T10:00:00Z",
    status: "SUCCESS",
    inputTokens: 10_000,
    cachedInputTokens: 8_000, // 8k cached, 2k uncached
    outputTokens: 500,
  };

  const resCached = evaluateAttemptCost(cachedAttempt, rateSnapshots);
  const expectedCachedCost =
    (2000 * 0.2574 + 8000 * 0.07 + 500 * 1.0287) / 1_000_000;
  check(
    "G16.1 Prompt caching evaluates cached vs uncached tokens without double counting",
    resCached.uncachedInputTokens === 2000 &&
      resCached.cachedInputTokens === 8000 &&
      Math.abs((resCached.costUsd ?? 0) - expectedCachedCost) < 1e-9,
  );

  // Reject cachedInputTokens > inputTokens without silent clamping
  let throwsOnCacheExceeded = false;
  try {
    evaluateAttemptCost({
      attemptId: "cache-bad",
      attemptIndex: 1,
      trafficPool: "SERVING",
      provider: "openrouter",
      model: "deepseek/deepseek-chat",
      status: "SUCCESS",
      inputTokens: 100,
      cachedInputTokens: 200, // exceeds inputTokens!
    });
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.message.includes("cannot exceed inputTokens")
    ) {
      throwsOnCacheExceeded = true;
    }
  }
  check(
    "G16.2 cachedInputTokens exceeding inputTokens throws explicit Error (never silently clamped)",
    throwsOnCacheExceeded,
  );

  // ═══════════════════════════════════════════════════════════════════════
  // GROUP 17: Monetary Policy & Sub-Micro Accumulation
  // ═══════════════════════════════════════════════════════════════════════
  // 1 token at $0.25 / 1,000,000 = $0.00000025 USD (genuine positive sub-micro cost)
  const singleSubMicroAttempt: PhysicalAttemptFact = {
    attemptId: "micro-1",
    attemptIndex: 1,
    trafficPool: "SERVING",
    provider: "openrouter",
    model: "deepseek/deepseek-chat",
    attemptTimestamp: "2026-10-22T10:00:00Z",
    status: "SUCCESS",
    inputTokens: 1,
    cachedInputTokens: 0,
    outputTokens: 0,
  };

  const microSnapshot: ModelRateSnapshot = {
    snapshotId: "rate-micro",
    provider: "openrouter",
    model: "deepseek/deepseek-chat",
    effectiveDate: "2026-10-22",
    promptCostPerMillionUsd: 0.25,
    completionCostPerMillionUsd: 1.0,
    source: "micro_test",
  };

  const resSingleMicro = evaluateAttemptCost(singleSubMicroAttempt, [
    microSnapshot,
  ]);
  const rawSingleCost = 0.00000025;

  // 4 identical sub-micro attempts summed
  const fourMicroAttempts: PhysicalAttemptFact[] = [
    { ...singleSubMicroAttempt, attemptId: "m-1", attemptIndex: 1 },
    { ...singleSubMicroAttempt, attemptId: "m-2", attemptIndex: 2 },
    { ...singleSubMicroAttempt, attemptId: "m-3", attemptIndex: 3 },
    { ...singleSubMicroAttempt, attemptId: "m-4", attemptIndex: 4 },
  ];

  const resFourMicro = evaluateTurnCost(fourMicroAttempts, [microSnapshot]);
  const expectedFourSum = 0.000001; // exactly $0.00000100 USD

  check(
    "G17.1 Single sub-micro cost is strictly positive ($0.00000025), and 4 attempts aggregate to $0.000001 without premature zero-clamping",
    resSingleMicro.costUsd === rawSingleCost &&
      formatMicroUsd(resSingleMicro.costUsd) === "0.000000" && // presentation formats to 6 decimals
      resFourMicro.serving.totalCostUsd !== null &&
      Math.abs(resFourMicro.serving.totalCostUsd - expectedFourSum) < 1e-12 &&
      formatMicroUsd(resFourMicro.serving.totalCostUsd) === "0.000001",
  );

  // ═══════════════════════════════════════════════════════════════════════
  // GROUP 18: Disjoint Operational Pool Aggregation
  // ═══════════════════════════════════════════════════════════════════════
  const multiPoolAttempts: PhysicalAttemptFact[] = [
    {
      attemptId: "serv-1",
      attemptIndex: 1,
      trafficPool: "SERVING",
      provider: "openrouter",
      reportedCostUsd: 0.004,
      status: "SUCCESS",
    },
    {
      attemptId: "shad-1",
      attemptIndex: 2,
      trafficPool: "SHADOW",
      provider: "openrouter",
      reportedCostUsd: 0.0008,
      status: "SUCCESS",
    },
    {
      attemptId: "test-1",
      attemptIndex: 3,
      trafficPool: "TEST",
      provider: "openrouter",
      reportedCostUsd: 0.0015,
      status: "SUCCESS",
    },
  ];

  const resPools = evaluateTurnCost(multiPoolAttempts, rateSnapshots);
  check(
    "G18.1 Serving, Shadow, and Test pools are aggregated independently without cost leakage",
    resPools.serving.knownSubtotalUsd === 0.004 &&
      resPools.shadow.knownSubtotalUsd === 0.0008 &&
      resPools.test.knownSubtotalUsd === 0.0015 &&
      resPools.serving.dispatchedAttempts === 1 &&
      resPools.shadow.dispatchedAttempts === 1 &&
      resPools.test.dispatchedAttempts === 1,
  );

  // ═══════════════════════════════════════════════════════════════════════
  // GROUP 19: Content-Free Structural Integrity & Output Projection
  // ═══════════════════════════════════════════════════════════════════════
  // Pass an event and attempt with extra forbidden runtime properties (simulating malicious or un-sanitized input)
  const dirtyEvent = {
    ...makeEvent({ eventId: "clean-id" }),
    content: "raw prompt and customer chat prose",
    text: "hello world",
    prompt: "system prompt text",
  } as unknown as CanonicalInboundEvent;

  const dirtySessionResult = rollupCommercialSessions([dirtyEvent]);
  const dirtySessionStr = JSON.stringify(dirtySessionResult);

  const dirtyAttempt = {
    ...testAttempt,
    unapprovedKey: "leaked value",
    promptText: "system instructions",
  } as unknown as PhysicalAttemptFact;

  const dirtyAttemptResult = evaluateAttemptCost(dirtyAttempt, rateSnapshots);
  const dirtyAttemptStr = JSON.stringify(dirtyAttemptResult);

  const forbiddenContentKeys = [
    "content",
    "text",
    "prompt",
    "promptText",
    "unapprovedKey",
    "messageText",
    "responseProse",
  ];

  const leaksForbidden = forbiddenContentKeys.some(
    (key) =>
      dirtySessionStr.includes(`"${key}"`) ||
      dirtyAttemptStr.includes(`"${key}"`),
  );

  check(
    "G19.1 Output projections strip arbitrary extra runtime properties and remain strictly content-free",
    !leaksForbidden,
  );

  // ═══════════════════════════════════════════════════════════════════════
  // GROUP 20: Schema Tagging & Version Integrity
  // ═══════════════════════════════════════════════════════════════════════
  check(
    "G20.1 Output schemas match canonical version identifiers",
    res24h.schema === COMMERCIAL_SESSION_CONTRACT_VERSION &&
      resRetryCost.schema === COST_ENGINE_VERSION,
  );

  // ═══════════════════════════════════════════════════════════════════════
  // GROUP 21: Explicit Rate Snapshot References & Calendar Date Validation
  // ═══════════════════════════════════════════════════════════════════════
  // Provider mismatch when referencing snapshotId
  let throwsOnProviderMismatch = false;
  try {
    evaluateAttemptCost(
      {
        attemptId: "att-prov-mismatch",
        attemptIndex: 1,
        trafficPool: "SERVING",
        provider: "anthropic", // mismatch from openrouter
        snapshotId: "rate-deepseek-v3",
        status: "SUCCESS",
        inputTokens: 100,
        outputTokens: 10,
      },
      rateSnapshots,
    );
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("provider mismatch")) {
      throwsOnProviderMismatch = true;
    }
  }
  check(
    "G21.1 Explicit snapshotId reference with provider mismatch throws explicit Error",
    throwsOnProviderMismatch,
  );

  // Model mismatch when referencing snapshotId
  let throwsOnModelMismatch = false;
  try {
    evaluateAttemptCost(
      {
        attemptId: "att-model-mismatch",
        attemptIndex: 1,
        trafficPool: "SERVING",
        provider: "openrouter",
        model: "openai/gpt-4o", // mismatch from deepseek/deepseek-chat
        snapshotId: "rate-deepseek-v3",
        status: "SUCCESS",
        inputTokens: 100,
        outputTokens: 10,
      },
      rateSnapshots,
    );
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("model mismatch")) {
      throwsOnModelMismatch = true;
    }
  }
  check(
    "G21.2 Explicit snapshotId reference with model mismatch throws explicit Error",
    throwsOnModelMismatch,
  );

  // Attempt time predating snapshot effective date when referencing snapshotId
  let throwsOnPrematureSnapshotRef = false;
  try {
    evaluateAttemptCost(
      {
        attemptId: "att-time-mismatch",
        attemptIndex: 1,
        trafficPool: "SERVING",
        provider: "openrouter",
        model: "deepseek/deepseek-chat",
        snapshotId: "rate-deepseek-v3", // effective 2026-10-22
        attemptTimestamp: "2026-10-20T10:00:00Z", // attempt was 2 days prior!
        status: "SUCCESS",
        inputTokens: 100,
        outputTokens: 10,
      },
      rateSnapshots,
    );
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.message.includes("is not yet effective at attempt time")
    ) {
      throwsOnPrematureSnapshotRef = true;
    }
  }
  check(
    "G21.3 Explicit snapshotId reference that is not yet effective at attempt time throws Error",
    throwsOnPrematureSnapshotRef,
  );

  // Non-existent calendar date (February 31)
  let throwsOnFeb31 = false;
  try {
    evaluateAttemptCost(testAttempt, [
      {
        snapshotId: "rate-bad-date",
        provider: "openrouter",
        model: "test/model",
        effectiveDate: "2026-02-31", // invalid calendar date!
        promptCostPerMillionUsd: 1.0,
        completionCostPerMillionUsd: 1.0,
        source: "bad_date_test",
      },
    ]);
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.message.includes("is not a valid calendar date")
    ) {
      throwsOnFeb31 = true;
    }
  }
  check(
    "G21.4 Rate snapshot with invalid calendar date (2026-02-31) throws explicit Error",
    throwsOnFeb31,
  );

  // Conflicting definition for the same snapshotId across provider/model/rate
  let throwsOnSnapshotIdConflict = false;
  try {
    evaluateAttemptCost(testAttempt, [
      rateSnapshots[0]!,
      {
        ...rateSnapshots[0]!,
        promptCostPerMillionUsd: 99.9, // conflicting rate for same ID!
      },
    ]);
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.message.includes("Conflicting definition for rate snapshotId")
    ) {
      throwsOnSnapshotIdConflict = true;
    }
  }
  check(
    "G21.5 Conflicting redefinition of the same snapshotId throws explicit Error",
    throwsOnSnapshotIdConflict,
  );

  // ═══════════════════════════════════════════════════════════════════════
  // GROUP 22: Carry-In Watermark, Verifiable Replay & Count Integrity
  // ═══════════════════════════════════════════════════════════════════════
  // Watermark check: Event before carried session start must fail closed
  let throwsOnBeforeWatermark = false;
  try {
    rollupCommercialSessions(
      [
        makeEvent({
          eventId: "old-event",
          canonicalTimestamp: "2026-10-31T19:59:59.000Z", // 1 second before carried session start!
          scope: priorScope,
        }),
      ],
      { priorSessions: [priorSession] },
    );
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.message.includes("Out-of-contract event before carry-in window start")
    ) {
      throwsOnBeforeWatermark = true;
    }
  }
  check(
    "G22.1 Event timestamped earlier than carried prior session start throws watermark violation Error",
    throwsOnBeforeWatermark,
  );

  // Replaying event from prior session without fingerprints is unverifiable -> fails closed
  let throwsOnUnverifiableReplay = false;
  try {
    rollupCommercialSessions(
      [
        makeEvent({
          eventId: "p2", // present in priorSession.eventIds, but priorSession lacks eventFingerprints!
          canonicalTimestamp: "2026-10-31T21:00:00.000Z",
          scope: priorScope,
        }),
      ],
      { priorSessions: [priorSession] },
    );
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.message.includes("Unverifiable event replay")
    ) {
      throwsOnUnverifiableReplay = true;
    }
  }
  check(
    "G22.2 Replaying an event ID from a prior session lacking fingerprints throws explicit Unverifiable replay Error",
    throwsOnUnverifiableReplay,
  );

  // Verifiable replay with fingerprints: identical replay succeeds; changed fact throws conflict
  const verifiablePrior: CommercialSession = {
    ...priorSession,
    sessionId: "sess_verifiable",
    eventFingerprints: [
      {
        eventId: "p1",
        canonicalTimestampMs: priorStart,
        actionType: "MESSAGE",
        senderType: "CUSTOMER",
      },
      {
        eventId: "p2",
        canonicalTimestampMs: priorStart + 1000,
        actionType: "MESSAGE",
        senderType: "CUSTOMER",
      },
      {
        eventId: "p3",
        canonicalTimestampMs: priorStart + 2000,
        actionType: "MESSAGE",
        senderType: "CUSTOMER",
      },
    ],
  };

  const resVerifiableReplay = rollupCommercialSessions(
    [
      makeEvent({
        eventId: "p2",
        canonicalTimestamp: new Date(priorStart + 1000).toISOString(),
        actionType: "MESSAGE",
        senderType: "CUSTOMER",
        scope: priorScope,
      }),
    ],
    { priorSessions: [verifiablePrior] },
  );
  check(
    "G22.3 Verifiable identical replay matching prior fingerprint is deduplicated without count inflation",
    resVerifiableReplay.sessions.length === 1 &&
      resVerifiableReplay.sessions[0]?.totalEventCount === 3 &&
      resVerifiableReplay.filteredDuplicateCount === 1,
  );

  let throwsOnChangedFingerprint = false;
  try {
    rollupCommercialSessions(
      [
        makeEvent({
          eventId: "p2",
          canonicalTimestamp: new Date(priorStart + 9999).toISOString(), // changed timestamp!
          actionType: "MESSAGE",
          senderType: "CUSTOMER",
          scope: priorScope,
        }),
      ],
      { priorSessions: [verifiablePrior] },
    );
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.message.includes("Event fact conflict detected")
    ) {
      throwsOnChangedFingerprint = true;
    }
  }
  check(
    "G22.4 Replaying an absorbed event with changed facts against prior fingerprint throws conflict Error",
    throwsOnChangedFingerprint,
  );

  // Prior session count validation
  let throwsOnInvalidPriorCounts = false;
  try {
    rollupCommercialSessions([], {
      priorSessions: [
        {
          ...priorSession,
          totalEventCount: 2, // mismatch: eventIds has 3 items!
        },
      ],
    });
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.message.includes("must equal eventIds.length")
    ) {
      throwsOnInvalidPriorCounts = true;
    }
  }
  check(
    "G22.5 Prior session with totalEventCount mismatching eventIds.length throws validation Error",
    throwsOnInvalidPriorCounts,
  );

  // Deterministic prior session ordering: reversing prior sessions array produces identical results
  const prior2Start = priorStart + SESSION_DURATION_MS;
  const priorSession2: CommercialSession = {
    ...priorSession,
    sessionId: "sess_prior_2",
    startMs: prior2Start,
    endMs: prior2Start + SESSION_DURATION_MS,
    startAtUtc: new Date(prior2Start).toISOString(),
    endAtUtc: new Date(prior2Start + SESSION_DURATION_MS).toISOString(),
    initiatingEventId: "p4",
    totalEventCount: 1,
    qualifyingEventCount: 1,
    eventCount: 1,
    eventIds: ["p4"],
  };

  const resPriorsForward = rollupCommercialSessions([], {
    priorSessions: [priorSession, priorSession2],
  });
  const resPriorsReversed = rollupCommercialSessions([], {
    priorSessions: [priorSession2, priorSession],
  });
  check(
    "G22.6 Prior carry-in sessions passed in reverse order are sorted deterministically and produce byte-for-byte identical output",
    JSON.stringify(resPriorsForward) === JSON.stringify(resPriorsReversed),
  );

  // ═══════════════════════════════════════════════════════════════════════
  // GROUP 23: Arithmetic Overflow & Non-Finite Cost Result Protection
  // ═══════════════════════════════════════════════════════════════════════
  let throwsOnOverflowCost = false;
  try {
    evaluateAttemptCost(
      {
        attemptId: "att-overflow",
        attemptIndex: 1,
        trafficPool: "SERVING",
        provider: "openrouter",
        model: "deepseek/deepseek-chat",
        attemptTimestamp: "2026-10-22T10:00:00Z",
        status: "SUCCESS",
        inputTokens: 10_000,
        outputTokens: 10_000,
      },
      [
        {
          snapshotId: "rate-huge",
          provider: "openrouter",
          model: "deepseek/deepseek-chat",
          effectiveDate: "2026-10-22",
          promptCostPerMillionUsd: Number.MAX_VALUE, // arithmetic overflow to Infinity!
          completionCostPerMillionUsd: Number.MAX_VALUE,
          source: "overflow_test",
        },
      ],
    );
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("Arithmetic overflow")) {
      throwsOnOverflowCost = true;
    }
  }
  check(
    "G23.1 Attempt cost calculation overflowing to Infinity throws explicit Arithmetic overflow Error",
    throwsOnOverflowCost,
  );
}

function main(): void {
  console.log(
    "🔍 Running Economics Measurement & Cost Engine Acceptance Suite...",
  );
  runSuite();

  const failed = checks.filter((c) => !c.pass);
  for (const c of checks) {
    console.log(`${c.pass ? "✔" : "✘"} ${c.label}`);
    if (!c.pass && c.details) {
      console.log(`    ↳ ${c.details}`);
    }
  }

  const passedCount = checks.length - failed.length;
  console.log(
    `\n${failed.length === 0 ? "PASS" : "FAIL"} — ${passedCount}/${checks.length} checks passed.`,
  );

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main();
