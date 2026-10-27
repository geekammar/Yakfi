/* eslint-disable @typescript-eslint/consistent-type-imports */
/**
 * FlowPilot — Commercial Session Measurement Contract & Cost Engine Acceptance Suite
 * (flowpilot.commercial.session.contract@v1 & flowpilot.cost.engine@v1)
 *
 * Deterministic, OFFLINE verification of:
 * - Half-open UTC 24h session intervals [start, start + 24h).
 * - Qualifying events, start-only commands, callbacks, and duplicate filtering.
 * - Batch ordering permutation invariance (sorting + tie-breaking).
 * - Period carry-in and cross-month attribution.
 * - Explicit scope identification (tenant + channel + connection + customer).
 * - Multi-attempt cost accounting (reported cost, rate snapshots, prompt caching).
 * - Zero dispatch prevention (kill switches / clamps) vs dispatched attempts.
 * - Negative rule: status codes never imply 0 cost automatically.
 * - Precision preservation (micro/sub-micro arithmetic without premature rounding).
 * - Disjoint pool separation (SERVING, SHADOW, TEST).
 * - Content-freedom and invalid input fail-closed behavior.
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

function makeEvent(overrides?: Partial<CanonicalInboundEvent>): CanonicalInboundEvent {
  return {
    eventId: overrides?.eventId ?? "evt-1",
    canonicalTimestamp: overrides?.canonicalTimestamp ?? "2026-10-01T10:00:00.000Z",
    senderType: overrides?.senderType ?? "CUSTOMER",
    actionType: overrides?.actionType ?? "MESSAGE",
    scope: overrides?.scope ?? makeScope(),
    isDuplicate: overrides?.isDuplicate ?? false,
    trafficPool: overrides?.trafficPool ?? "SERVING",
  };
}

function runSuite(): void {
  // ═══════════════════════════════════════════════════════════════════════
  // GROUP 1: Canonical Timestamp Parsing
  // ═══════════════════════════════════════════════════════════════════════
  const tIso = toCanonicalTimestampMs("2026-10-01T12:00:00.000Z");
  const tDate = toCanonicalTimestampMs(new Date("2026-10-01T12:00:00.000Z"));
  check("G1.1 toCanonicalTimestampMs parses valid ISO string and Date identically", tIso === tDate && tIso === 1790856000000);

  let throwsOnEmpty = false;
  try {
    toCanonicalTimestampMs("   ");
  } catch {
    throwsOnEmpty = true;
  }
  check("G1.2 toCanonicalTimestampMs throws on empty or whitespace string", throwsOnEmpty);

  let throwsOnInvalid = false;
  try {
    toCanonicalTimestampMs("not-a-date");
  } catch {
    throwsOnInvalid = true;
  }
  check("G1.3 toCanonicalTimestampMs throws on invalid date string", throwsOnInvalid);

  // ═══════════════════════════════════════════════════════════════════════
  // GROUP 2: Exact 24-Hour Half-Open Window [start, start + 24h)
  // ═══════════════════════════════════════════════════════════════════════
  const baseT = "2026-10-01T10:00:00.000Z";
  const insideT = new Date(Date.parse(baseT) + SESSION_DURATION_MS - 1).toISOString(); // T + 24h - 1ms
  const boundaryT = new Date(Date.parse(baseT) + SESSION_DURATION_MS).toISOString(); // T + 24h exactly

  const res24h = rollupCommercialSessions([
    makeEvent({ eventId: "e1", canonicalTimestamp: baseT }),
    makeEvent({ eventId: "e2", canonicalTimestamp: insideT }),
  ]);
  check(
    "G2.1 Event at T + 24h - 1ms falls inside active half-open window (1 session, count=2)",
    res24h.sessions.length === 1 && res24h.sessions[0].eventCount === 2,
  );

  const resNewWindow = rollupCommercialSessions([
    makeEvent({ eventId: "e1", canonicalTimestamp: baseT }),
    makeEvent({ eventId: "e2", canonicalTimestamp: insideT }),
    makeEvent({ eventId: "e3", canonicalTimestamp: boundaryT }),
  ]);
  check(
    "G2.2 Event at exact boundary T + 24h opens a new session (2 sessions total)",
    resNewWindow.sessions.length === 2 &&
      resNewWindow.sessions[0].eventCount === 2 &&
      resNewWindow.sessions[1].eventCount === 1 &&
      resNewWindow.sessions[1].initiatingEventId === "e3",
  );

  // ═══════════════════════════════════════════════════════════════════════
  // GROUP 3: Start-Only Protocol vs Interactive Choice Callbacks
  // ═══════════════════════════════════════════════════════════════════════
  const resStartOnly = rollupCommercialSessions([
    makeEvent({ eventId: "s1", actionType: "START_COMMAND", canonicalTimestamp: "2026-10-01T10:00:00Z" }),
  ]);
  check(
    "G3.1 Start-only command does not open a commercial session (0 sessions, ignored=1)",
    resStartOnly.sessions.length === 0 && resStartOnly.startOnlyIgnoredCount === 1,
  );

  const resStartThenCallback = rollupCommercialSessions([
    makeEvent({ eventId: "s1", actionType: "START_COMMAND", canonicalTimestamp: "2026-10-01T10:00:00Z" }),
    makeEvent({ eventId: "cb1", actionType: "CHOICE_CALLBACK", canonicalTimestamp: "2026-10-01T10:05:00Z" }),
  ]);
  check(
    "G3.2 Subsequent CHOICE_CALLBACK initiates session successfully",
    resStartThenCallback.sessions.length === 1 &&
      resStartThenCallback.sessions[0].initiatingEventId === "cb1" &&
      resStartThenCallback.startOnlyIgnoredCount === 1,
  );

  // ═══════════════════════════════════════════════════════════════════════
  // GROUP 4: Duplicate Interception
  // ═══════════════════════════════════════════════════════════════════════
  const resDedupe = rollupCommercialSessions([
    makeEvent({ eventId: "d1", canonicalTimestamp: "2026-10-01T10:00:00Z" }),
    makeEvent({ eventId: "d1-dup", isDuplicate: true, canonicalTimestamp: "2026-10-01T10:00:01Z" }),
  ]);
  check(
    "G4.1 Duplicate payloads are excluded from session event count (filteredDuplicateCount=1)",
    resDedupe.sessions.length === 1 &&
      resDedupe.sessions[0].eventCount === 1 &&
      resDedupe.filteredDuplicateCount === 1,
  );

  // ═══════════════════════════════════════════════════════════════════════
  // GROUP 5: Permutation Invariance (Batch Ordering & Tie-Breaking)
  // ═══════════════════════════════════════════════════════════════════════
  const rawBatch: CanonicalInboundEvent[] = [
    makeEvent({ eventId: "evt-01", canonicalTimestamp: "2026-10-01T10:00:00Z" }),
    makeEvent({ eventId: "evt-02", canonicalTimestamp: "2026-10-01T12:00:00Z" }),
    makeEvent({ eventId: "evt-03", canonicalTimestamp: "2026-10-01T12:00:00Z" }), // tie in ms
    makeEvent({ eventId: "evt-04", canonicalTimestamp: "2026-10-02T15:00:00Z" }), // session 2
    makeEvent({ eventId: "evt-05", canonicalTimestamp: "2026-10-02T16:00:00Z" }),
  ];

  const chronological = rollupCommercialSessions(rawBatch);
  const reversed = rollupCommercialSessions([...rawBatch].reverse());
  const shuffled = rollupCommercialSessions([rawBatch[3], rawBatch[0], rawBatch[4], rawBatch[2], rawBatch[1]]);

  const jsonChrono = JSON.stringify(chronological);
  const jsonReversed = JSON.stringify(reversed);
  const jsonShuffled = JSON.stringify(shuffled);

  check(
    "G5.1 Batch results are byte-for-byte invariant under input permutation",
    jsonChrono === jsonReversed && jsonChrono === jsonShuffled,
  );

  // ═══════════════════════════════════════════════════════════════════════
  // GROUP 6: Period Carry-In Support
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
    initiatingEventId: "evt-prior",
    eventCount: 3,
    eventIds: ["p1", "p2", "p3"],
  };

  const resCarryIn = rollupCommercialSessions(
    [makeEvent({ eventId: "nov-1", canonicalTimestamp: "2026-11-01T04:00:00.000Z" })],
    { priorSessions: [priorSession] },
  );

  check(
    "G6.1 Qualifying event in new month appends to unexpired carry-in session without new session creation",
    resCarryIn.sessions.length === 1 &&
      resCarryIn.sessions[0].sessionId === "sess_prior" &&
      resCarryIn.sessions[0].eventCount === 4 &&
      resCarryIn.sessions[0].eventIds.includes("nov-1"),
  );

  // ═══════════════════════════════════════════════════════════════════════
  // GROUP 7: Tenant, Channel & Connection Scope Isolation
  // ═══════════════════════════════════════════════════════════════════════
  const sameTime = "2026-10-01T10:00:00.000Z";
  const isoBatch = [
    makeEvent({ eventId: "c1", canonicalTimestamp: sameTime, scope: makeScope({ businessId: "b1", connectionId: "c1" }) }),
    makeEvent({ eventId: "c2", canonicalTimestamp: sameTime, scope: makeScope({ businessId: "b1", connectionId: "c2" }) }), // diff conn
    makeEvent({ eventId: "c3", canonicalTimestamp: sameTime, scope: makeScope({ businessId: "b2", connectionId: "c1" }) }), // diff tenant
    makeEvent({ eventId: "c4", canonicalTimestamp: sameTime, scope: makeScope({ businessId: "b1", channel: "whatsapp", connectionId: "wa1" }) }), // diff channel
  ];

  const resIso = rollupCommercialSessions(isoBatch);
  check(
    "G7.1 Different business, channel, connection, or customer maintain strictly isolated sessions",
    resIso.sessions.length === 4,
  );

  // ═══════════════════════════════════════════════════════════════════════
  // GROUP 8: Cost Engine — Retry and Fallback with Separate Rates
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
      promptCostPerMillionUsd: 0.40,
      completionCostPerMillionUsd: 0.80,
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
      status: "SUCCESS",
      inputTokens: 2000,
      outputTokens: 250,
      latencyMs: 850,
    },
  ];

  const resRetryCost = evaluateTurnCost(retryFallbackAttempts, rateSnapshots);
  const costAtt1 = (2000 * 0.2574) / 1_000_000; // 0.0005148
  const costAtt2 = (2000 * 0.40 + 250 * 0.80) / 1_000_000; // 0.001000
  const expectedTurnCost = costAtt1 + costAtt2; // 0.0015148

  check(
    "G8.1 Retry and fallback attempts evaluate with respective model rates and sum accurately",
    resRetryCost.serving.costCompleteness === "COMPLETE" &&
      Math.abs((resRetryCost.serving.totalCostUsd ?? 0) - expectedTurnCost) < 1e-9 &&
      resRetryCost.serving.knownSubtotalUsd === resRetryCost.serving.totalCostUsd,
  );

  // ═══════════════════════════════════════════════════════════════════════
  // GROUP 9: Cost Engine — Reported Cost Precedence Including Zero
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
    "G9.1 Reported cost of zero is preserved with PROVIDER_REPORTED provenance (not overridden by rate snapshot)",
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

  const resPosCost = evaluateAttemptCost(positiveReportedAttempt, rateSnapshots);
  check(
    "G9.2 Positive reported cost overrides token rate calculation",
    resPosCost.costUsd === 0.0035 && resPosCost.provenance === "PROVIDER_REPORTED",
  );

  // ═══════════════════════════════════════════════════════════════════════
  // GROUP 10: Negative Rule — Never Infer Zero Cost Solely from Status Codes
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
    "G10.1 Failed attempt with missing tokens/cost evaluates to UNKNOWN (cost=null, never coerced to 0)",
    resTimeout.costUsd === null &&
      resTimeout.provenance === "UNKNOWN" &&
      resTimeout.completeness === "UNKNOWN",
  );

  // ═══════════════════════════════════════════════════════════════════════
  // GROUP 11: All-Unknown vs Mixed Costs & Coverage Ratio
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
    "G11.1 Mixed known and unknown attempts produce PARTIAL completeness with totalCost=null and knownSubtotal preserved",
    resMixed.serving.costCompleteness === "PARTIAL" &&
      resMixed.serving.totalCostUsd === null &&
      resMixed.serving.knownSubtotalUsd === 0.0012 &&
      resMixed.serving.coveragePercentage === "50.0%",
  );

  const resAllUnknown = evaluateTurnCost([timeoutAttempt], rateSnapshots);
  check(
    "G11.2 All-unknown dispatched attempts produce UNAVAILABLE completeness with coverage 0.0%",
    resAllUnknown.serving.costCompleteness === "UNAVAILABLE" &&
      resAllUnknown.serving.totalCostUsd === null &&
      resAllUnknown.serving.coveragePercentage === "0.0%",
  );

  // ═══════════════════════════════════════════════════════════════════════
  // GROUP 12: Locally Prevented Zero Dispatch
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
    "G12.1 Locally prevented request has 0 dispatched count and null coverage (N/A, not an invented percentage)",
    resPrevented.serving.dispatchedAttempts === 0 &&
      resPrevented.serving.locallyPreventedAttempts === 1 &&
      resPrevented.serving.totalCostUsd === 0 &&
      resPrevented.serving.coverageRatio === null &&
      resPrevented.serving.coveragePercentage === null,
  );

  // ═══════════════════════════════════════════════════════════════════════
  // GROUP 13: Prompt Caching Without Double Counting
  // ═══════════════════════════════════════════════════════════════════════
  const cachedAttempt: PhysicalAttemptFact = {
    attemptId: "cache-1",
    attemptIndex: 1,
    trafficPool: "SERVING",
    provider: "openrouter",
    model: "deepseek/deepseek-chat",
    status: "SUCCESS",
    inputTokens: 10_000,
    cachedInputTokens: 8_000, // 8k cached, 2k uncached
    outputTokens: 500,
  };

  const resCached = evaluateAttemptCost(cachedAttempt, rateSnapshots);
  // Uncached: 2,000 * 0.2574 = 0.5148
  // Cached: 8,000 * 0.07 = 0.5600
  // Completion: 500 * 1.0287 = 0.51435
  // Total: (0.5148 + 0.5600 + 0.51435) / 1,000 = 0.00158915 USD
  const expectedCachedCost = (2000 * 0.2574 + 8000 * 0.07 + 500 * 1.0287) / 1_000_000;
  check(
    "G13.1 Prompt caching evaluates cached vs uncached tokens without double counting",
    resCached.uncachedInputTokens === 2000 &&
      resCached.cachedInputTokens === 8000 &&
      Math.abs((resCached.costUsd ?? 0) - expectedCachedCost) < 1e-9,
  );

  // ═══════════════════════════════════════════════════════════════════════
  // GROUP 14: Sub-Micro Precision Preservation
  // ═══════════════════════════════════════════════════════════════════════
  const tinyAttempt: PhysicalAttemptFact = {
    attemptId: "tiny-1",
    attemptIndex: 1,
    trafficPool: "SERVING",
    provider: "openrouter",
    model: "deepseek/deepseek-chat",
    status: "SUCCESS",
    inputTokens: 5,
    outputTokens: 1,
  };

  const resTiny = evaluateAttemptCost(tinyAttempt, rateSnapshots);
  const rawTinyCost = (5 * 0.2574 + 1 * 1.0287) / 1_000_000; // 0.0000023157
  check(
    "G14.1 Micro-costs are accumulated with full double precision and formatted accurately to 6 decimals",
    resTiny.costUsd === rawTinyCost && formatMicroUsd(resTiny.costUsd) === "0.000002",
  );

  // ═══════════════════════════════════════════════════════════════════════
  // GROUP 15: Traffic Pool Separation (SERVING, SHADOW, TEST)
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
    "G15.1 Serving, Shadow, and Test pools are aggregated independently without cost leakage",
    resPools.serving.knownSubtotalUsd === 0.004 &&
      resPools.shadow.knownSubtotalUsd === 0.0008 &&
      resPools.test.knownSubtotalUsd === 0.0015 &&
      resPools.serving.dispatchedAttempts === 1 &&
      resPools.shadow.dispatchedAttempts === 1 &&
      resPools.test.dispatchedAttempts === 1,
  );

  // ═══════════════════════════════════════════════════════════════════════
  // GROUP 16: Content-Free Structural Integrity
  // ═══════════════════════════════════════════════════════════════════════
  const forbiddenContentKeys = ["content", "text", "prompt", "messageText", "responseProse", "body"];
  const sessionStr = JSON.stringify(res24h);
  const costStr = JSON.stringify(resRetryCost);

  const containsForbidden = forbiddenContentKeys.some(
    (key) => sessionStr.includes(`"${key}"`) || costStr.includes(`"${key}"`),
  );

  check(
    "G16.1 Generated session and cost records are strictly content-free (machine keys, numbers, and IDs only)",
    !containsForbidden,
  );

  // ═══════════════════════════════════════════════════════════════════════
  // GROUP 17: Schema Tagging & Version Integrity
  // ═══════════════════════════════════════════════════════════════════════
  check(
    "G17.1 Output schemas match canonical version identifiers",
    res24h.schema === COMMERCIAL_SESSION_CONTRACT_VERSION &&
      resRetryCost.schema === COST_ENGINE_VERSION,
  );
}

function main(): void {
  console.log("🔍 Running Economics Measurement & Cost Engine Acceptance Suite...");
  runSuite();

  const failed = checks.filter((c) => !c.pass);
  for (const c of checks) {
    console.log(`${c.pass ? "✔" : "✘"} ${c.label}`);
    if (!c.pass && c.details) {
      console.log(`    ↳ ${c.details}`);
    }
  }

  const passedCount = checks.length - failed.length;
  console.log(`\n${failed.length === 0 ? "PASS" : "FAIL"} — ${passedCount}/${checks.length} checks passed.`);

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main();
