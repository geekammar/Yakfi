/**
 * FlowPilot — Commercial Session Measurement Contract Engine
 * (flowpilot.commercial.session.contract@v1)
 *
 * Implements pure, deterministic 24-hour customer session measurement.
 *
 * Binding rules:
 * - Half-open UTC interval [start, start + 24h).
 * - Qualifying events: substantive customer messages and validated callbacks / numeric choices.
 * - Start-only commands cannot open a session.
 * - Intercepted duplicate events are excluded.
 * - Test traffic is tracked in an isolated TEST pool.
 * - Permutation invariance: batch ordering is stabilized by canonical timestamp + eventId tie-breaker.
 * - Explicit prior session state for period carry-in without re-opening expired windows.
 * - Content-free: zero NLP, regexes, keyword dictionaries, or chat prose dependencies.
 */

import {
  COMMERCIAL_SESSION_CONTRACT_VERSION,
  SESSION_DURATION_MS,
  TRAFFIC_POOLS,
  buildIdentityScopeKey,
  type CanonicalInboundEvent,
  type CommercialSession,
  type SessionRollupOptions,
  type SessionRollupResult,
  type TrafficPool,
} from "./types";

/**
 * Parse and validate a canonical timestamp into UTC epoch milliseconds.
 * Throws a clear Error on invalid or non-finite inputs.
 */
export function toCanonicalTimestampMs(ts: string | Date): number {
  if (ts instanceof Date) {
    const ms = ts.getTime();
    if (Number.isNaN(ms)) throw new Error("Invalid Date instance provided as canonical timestamp");
    return ms;
  }
  if (typeof ts === "string") {
    const trimmed = ts.trim();
    if (trimmed.length === 0) throw new Error("Empty string provided as canonical timestamp");
    const ms = Date.parse(trimmed);
    if (Number.isNaN(ms)) throw new Error(`Invalid ISO timestamp string: '${ts}'`);
    return ms;
  }
  throw new Error("canonicalTimestamp must be a valid ISO string or Date instance");
}

/**
 * Generate a stable, deterministic session identifier.
 */
function generateDeterministicSessionId(
  scopeKey: string,
  startMs: number,
  initiatingEventId: string,
): string {
  return `sess_${scopeKey}_${startMs}_${initiatingEventId}`;
}

/**
 * Pure session rollup function.
 * Given an arbitrary batch of canonical inbound events, groups them into
 * 24-hour commercial sessions under the versioned measurement contract.
 */
export function rollupCommercialSessions(
  events: ReadonlyArray<CanonicalInboundEvent>,
  options?: SessionRollupOptions,
): SessionRollupResult {
  // 1. Sort deterministically: primary = timestampMs, secondary = eventId tie-breaker.
  // This guarantees complete invariance under any input permutation (shuffled, reverse, etc.).
  const sorted = [...events].map((evt) => ({
    event: evt,
    timestampMs: toCanonicalTimestampMs(evt.canonicalTimestamp),
  })).sort((a, b) => {
    if (a.timestampMs !== b.timestampMs) {
      return a.timestampMs - b.timestampMs;
    }
    return a.event.eventId.localeCompare(b.event.eventId);
  });

  // 2. Initialize tracking maps.
  // activeByScope tracks the currently open session per scopeKey.
  const activeByScope = new Map<string, CommercialSession>();
  // allSessions tracks all completed and active sessions created or carried in.
  const sessionList: CommercialSession[] = [];

  // Seed with prior sessions if provided (period carry-in).
  if (options?.priorSessions) {
    for (const prior of options.priorSessions) {
      activeByScope.set(prior.scopeKey, prior);
      sessionList.push(prior);
    }
  }

  let filteredDuplicateCount = 0;
  let startOnlyIgnoredCount = 0;
  let nonCustomerIgnoredCount = 0;

  // 3. Process ordered events.
  for (const { event, timestampMs } of sorted) {
    // Rule: Exclude duplicate payloads.
    if (event.isDuplicate) {
      filteredDuplicateCount += 1;
      continue;
    }

    const scopeKey = buildIdentityScopeKey(event.scope);
    const pool: TrafficPool = event.trafficPool ?? "SERVING";
    const currentActive = activeByScope.get(scopeKey);

    // Check if the currently active session for this scope is still valid.
    // Interval is strictly half-open: [startMs, startMs + 24h).
    const isWithinActiveSession =
      currentActive !== undefined &&
      timestampMs >= currentActive.startMs &&
      timestampMs < currentActive.endMs;

    if (isWithinActiveSession && currentActive) {
      // Event falls inside existing open session -> append.
      const updatedSession: CommercialSession = {
        ...currentActive,
        eventCount: currentActive.eventCount + 1,
        eventIds: [...currentActive.eventIds, event.eventId],
      };
      activeByScope.set(scopeKey, updatedSession);

      // Update in-place in sessionList.
      const idx = sessionList.findIndex((s) => s.sessionId === currentActive.sessionId);
      if (idx !== -1) {
        sessionList[idx] = updatedSession;
      }
      continue;
    }

    // Beyond active session window (or no active session exists).
    if (currentActive && !isWithinActiveSession) {
      // The prior session is now closed for this scope.
      activeByScope.delete(scopeKey);
    }

    // Rule: Non-customer events cannot initiate a session.
    if (event.senderType !== "CUSTOMER") {
      nonCustomerIgnoredCount += 1;
      continue;
    }

    // Rule: Start-only command cannot initiate a session.
    if (event.actionType === "START_COMMAND") {
      startOnlyIgnoredCount += 1;
      continue;
    }

    // Rule: Qualifying customer actions (MESSAGE or CHOICE_CALLBACK) initiate a new 24h session.
    if (event.actionType === "MESSAGE" || event.actionType === "CHOICE_CALLBACK") {
      const startMs = timestampMs;
      const endMs = startMs + SESSION_DURATION_MS;
      const sessionId = generateDeterministicSessionId(scopeKey, startMs, event.eventId);

      const newSession: CommercialSession = {
        sessionId,
        scopeKey,
        scope: event.scope,
        trafficPool: pool,
        startAtUtc: new Date(startMs).toISOString(),
        startMs,
        endAtUtc: new Date(endMs).toISOString(),
        endMs,
        initiatingEventId: event.eventId,
        eventCount: 1,
        eventIds: [event.eventId],
      };

      activeByScope.set(scopeKey, newSession);
      sessionList.push(newSession);
    }
  }

  // 4. Compute metrics per traffic pool.
  const metricsByPool: Record<TrafficPool, { sessionCount: number; eventCount: number }> = {
    SERVING: { sessionCount: 0, eventCount: 0 },
    SHADOW: { sessionCount: 0, eventCount: 0 },
    TEST: { sessionCount: 0, eventCount: 0 },
  };

  for (const session of sessionList) {
    const targetPool = TRAFFIC_POOLS.includes(session.trafficPool)
      ? session.trafficPool
      : "SERVING";
    metricsByPool[targetPool].sessionCount += 1;
    metricsByPool[targetPool].eventCount += session.eventCount;
  }

  return {
    schema: COMMERCIAL_SESSION_CONTRACT_VERSION,
    sessions: sessionList,
    openSessions: Array.from(activeByScope.values()),
    filteredDuplicateCount,
    startOnlyIgnoredCount,
    nonCustomerIgnoredCount,
    totalEventsProcessed: events.length,
    metricsByPool,
  };
}
