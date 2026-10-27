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
 * - Deduplication: repeated event identities in batch or carry-in are idempotent; conflicting facts throw an Error.
 * - Operational traffic pool isolation: SERVING, SHADOW, and TEST pools maintain disjoint sessions and IDs.
 * - Permutation invariance: batch ordering is stabilized by canonical timestamp + eventId tie-breaker.
 * - Explicit prior session state for period carry-in without re-opening expired windows or allowing overlaps.
 * - Content-free projection: pure machine identifiers, timestamps, and counts; zero NLP, regexes, or prose.
 */

import {
  CHANNEL_TYPES,
  COMMERCIAL_SESSION_CONTRACT_VERSION,
  INBOUND_ACTION_TYPES,
  SENDER_TYPES,
  SESSION_DURATION_MS,
  TRAFFIC_POOLS,
  buildIdentityScopeKey,
  type CanonicalInboundEvent,
  type ChannelType,
  type CommercialSession,
  type IdentityScope,
  type InboundActionType,
  type PoolSessionMetrics,
  type SenderType,
  type SessionRollupOptions,
  type SessionRollupResult,
  type TrafficPool,
} from "./types";

const ISO_TZ_REGEX =
  /^(?:\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?)(?:Z|[+-]\d{2}:?(?:\d{2})?)$/i;

/**
 * Parse and validate a canonical timestamp into UTC epoch milliseconds.
 * Requires an explicit timezone offset (e.g. 'Z' or '+00:00').
 * Throws a clear Error on naive, invalid, or non-finite inputs.
 */
export function toCanonicalTimestampMs(ts: string | Date): number {
  if (ts instanceof Date) {
    const ms = ts.getTime();
    if (Number.isNaN(ms) || !Number.isFinite(ms)) {
      throw new Error("Invalid Date instance provided as canonical timestamp");
    }
    return ms;
  }
  if (typeof ts === "string") {
    const trimmed = ts.trim();
    if (trimmed.length === 0) {
      throw new Error("Empty string provided as canonical timestamp");
    }
    if (!ISO_TZ_REGEX.test(trimmed)) {
      throw new Error(
        `Timestamp must include explicit timezone offset (e.g. 'Z' or '+00:00'): '${ts}'`,
      );
    }
    const ms = Date.parse(trimmed);
    if (Number.isNaN(ms) || !Number.isFinite(ms)) {
      throw new Error(`Invalid ISO timestamp string: '${ts}'`);
    }
    return ms;
  }
  throw new Error(
    "canonicalTimestamp must be a valid ISO string with timezone offset or Date instance",
  );
}

/**
 * Validate and project an IdentityScope runtime object.
 * Rejects empty fields, invalid channels, or non-object structures.
 */
export function validateIdentityScope(raw: unknown): IdentityScope {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("IdentityScope must be a non-null object");
  }
  const scope = raw as Record<string, unknown>;

  if (
    typeof scope.businessId !== "string" ||
    scope.businessId.trim().length === 0
  ) {
    throw new Error("IdentityScope.businessId must be a non-empty string");
  }
  if (
    typeof scope.customerId !== "string" ||
    scope.customerId.trim().length === 0
  ) {
    throw new Error("IdentityScope.customerId must be a non-empty string");
  }
  if (
    typeof scope.connectionId !== "string" ||
    scope.connectionId.trim().length === 0
  ) {
    throw new Error("IdentityScope.connectionId must be a non-empty string");
  }
  if (
    typeof scope.channel !== "string" ||
    !CHANNEL_TYPES.includes(scope.channel as ChannelType)
  ) {
    throw new Error(
      `IdentityScope.channel must be one of ${CHANNEL_TYPES.join(", ")}; received '${String(scope.channel)}'`,
    );
  }

  return {
    businessId: scope.businessId.trim(),
    customerId: scope.customerId.trim(),
    channel: scope.channel as ChannelType,
    connectionId: scope.connectionId.trim(),
  };
}

/**
 * Validate a canonical inbound event structure and return validated fields.
 */
function validateCanonicalEvent(raw: unknown): {
  event: CanonicalInboundEvent;
  timestampMs: number;
  pool: TrafficPool;
  scope: IdentityScope;
} {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("CanonicalInboundEvent must be a non-null object");
  }
  const evt = raw as Record<string, unknown>;

  if (typeof evt.eventId !== "string" || evt.eventId.trim().length === 0) {
    throw new Error("CanonicalInboundEvent.eventId must be a non-empty string");
  }
  if (
    typeof evt.senderType !== "string" ||
    !SENDER_TYPES.includes(evt.senderType as SenderType)
  ) {
    throw new Error(
      `CanonicalInboundEvent.senderType must be one of ${SENDER_TYPES.join(", ")}; received '${String(evt.senderType)}'`,
    );
  }
  if (
    typeof evt.actionType !== "string" ||
    !INBOUND_ACTION_TYPES.includes(evt.actionType as InboundActionType)
  ) {
    throw new Error(
      `CanonicalInboundEvent.actionType must be one of ${INBOUND_ACTION_TYPES.join(", ")}; received '${String(evt.actionType)}'`,
    );
  }

  const pool: TrafficPool =
    evt.trafficPool === undefined
      ? "SERVING"
      : (evt.trafficPool as TrafficPool);

  if (!TRAFFIC_POOLS.includes(pool)) {
    throw new Error(
      `CanonicalInboundEvent.trafficPool must be one of ${TRAFFIC_POOLS.join(", ")}; received '${String(evt.trafficPool)}'`,
    );
  }

  const scope = validateIdentityScope(evt.scope);
  const timestampMs = toCanonicalTimestampMs(
    evt.canonicalTimestamp as string | Date,
  );

  const cleanEvent: CanonicalInboundEvent = {
    eventId: evt.eventId.trim(),
    canonicalTimestamp: evt.canonicalTimestamp as string | Date,
    senderType: evt.senderType as SenderType,
    actionType: evt.actionType as InboundActionType,
    scope,
    isDuplicate: evt.isDuplicate === true,
    trafficPool: pool,
  };

  return { event: cleanEvent, timestampMs, pool, scope };
}

/**
 * Validate a prior carry-in session.
 */
function validatePriorSession(raw: unknown): CommercialSession {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Prior session must be a non-null object");
  }
  const s = raw as Record<string, unknown>;

  if (typeof s.sessionId !== "string" || s.sessionId.trim().length === 0) {
    throw new Error("Prior session sessionId must be a non-empty string");
  }
  if (
    typeof s.trafficPool !== "string" ||
    !TRAFFIC_POOLS.includes(s.trafficPool as TrafficPool)
  ) {
    throw new Error(
      `Prior session trafficPool '${String(s.trafficPool)}' is invalid`,
    );
  }
  const scope = validateIdentityScope(s.scope);
  const expectedScopeKey = buildIdentityScopeKey(scope);
  if (s.scopeKey !== expectedScopeKey) {
    throw new Error(
      `Prior session scopeKey '${String(s.scopeKey)}' does not match computed scopeKey '${expectedScopeKey}'`,
    );
  }

  if (typeof s.startMs !== "number" || !Number.isSafeInteger(s.startMs)) {
    throw new Error("Prior session startMs must be a safe integer");
  }
  if (
    typeof s.endMs !== "number" ||
    !Number.isSafeInteger(s.endMs) ||
    s.endMs !== s.startMs + SESSION_DURATION_MS
  ) {
    throw new Error(
      `Prior session endMs must exactly equal startMs + 24 hours (${s.startMs + SESSION_DURATION_MS}); received ${String(s.endMs)}`,
    );
  }

  const expectedStartIso = new Date(s.startMs).toISOString();
  const expectedEndIso = new Date(s.endMs).toISOString();
  if (s.startAtUtc !== expectedStartIso) {
    throw new Error(
      `Prior session startAtUtc '${String(s.startAtUtc)}' does not match startMs ISO string '${expectedStartIso}'`,
    );
  }
  if (s.endAtUtc !== expectedEndIso) {
    throw new Error(
      `Prior session endAtUtc '${String(s.endAtUtc)}' does not match endMs ISO string '${expectedEndIso}'`,
    );
  }

  if (
    typeof s.initiatingEventId !== "string" ||
    s.initiatingEventId.trim().length === 0
  ) {
    throw new Error(
      "Prior session initiatingEventId must be a non-empty string",
    );
  }
  if (!Array.isArray(s.eventIds)) {
    throw new Error("Prior session eventIds must be an array of strings");
  }

  const rawCount =
    typeof s.totalEventCount === "number" ? s.totalEventCount : s.eventCount;
  const totalEventCount =
    typeof rawCount === "number" && Number.isSafeInteger(rawCount)
      ? rawCount
      : s.eventIds.length;
  const qualifyingEventCount =
    typeof s.qualifyingEventCount === "number" &&
    Number.isSafeInteger(s.qualifyingEventCount)
      ? s.qualifyingEventCount
      : 1;

  return projectCommercialSession({
    sessionId: s.sessionId.trim(),
    scopeKey: expectedScopeKey,
    scope,
    trafficPool: s.trafficPool as TrafficPool,
    startAtUtc: expectedStartIso,
    startMs: s.startMs,
    endAtUtc: expectedEndIso,
    endMs: s.endMs,
    initiatingEventId: s.initiatingEventId.trim(),
    qualifyingEventCount,
    totalEventCount,
    eventCount: totalEventCount,
    eventIds: s.eventIds.map((id) => String(id)),
  });
}

/**
 * Generate a stable, deterministic session identifier including traffic pool.
 */
function generateDeterministicSessionId(
  trafficPool: TrafficPool,
  scopeKey: string,
  startMs: number,
  initiatingEventId: string,
): string {
  return `sess_${trafficPool}_${scopeKey}_${startMs}_${initiatingEventId}`;
}

/**
 * Explicit content-free projection of a CommercialSession object.
 * Strips any extra runtime fields, retaining only contract-specified properties.
 */
function projectCommercialSession(s: CommercialSession): CommercialSession {
  return {
    sessionId: s.sessionId,
    scopeKey: s.scopeKey,
    scope: {
      businessId: s.scope.businessId,
      customerId: s.scope.customerId,
      channel: s.scope.channel,
      connectionId: s.scope.connectionId,
    },
    trafficPool: s.trafficPool,
    startAtUtc: s.startAtUtc,
    startMs: s.startMs,
    endAtUtc: s.endAtUtc,
    endMs: s.endMs,
    initiatingEventId: s.initiatingEventId,
    qualifyingEventCount: s.qualifyingEventCount,
    totalEventCount: s.totalEventCount,
    eventCount: s.totalEventCount,
    eventIds: [...s.eventIds],
  };
}

interface EventIdentityRecord {
  readonly timestampMs: number;
  readonly actionType: InboundActionType;
  readonly senderType: SenderType;
  readonly scopeKey: string;
  readonly trafficPool: TrafficPool;
  readonly isPrior?: boolean;
}

/**
 * Pure session rollup function.
 * Groups canonical inbound events into 24-hour commercial sessions under
 * flowpilot.commercial.session.contract@v1.
 */
export function rollupCommercialSessions(
  events: ReadonlyArray<CanonicalInboundEvent>,
  options?: SessionRollupOptions,
): SessionRollupResult {
  // 1. Validate and sort deterministically: primary = timestampMs, secondary = eventId tie-breaker.
  // Permutation invariance: guarantees identical output regardless of input array ordering.
  const validated = events.map((raw) => validateCanonicalEvent(raw));

  const sorted = [...validated].sort((a, b) => {
    if (a.timestampMs !== b.timestampMs) {
      return a.timestampMs - b.timestampMs;
    }
    return a.event.eventId.localeCompare(b.event.eventId);
  });

  // 2. Initialize tracking maps partitioned by operational traffic pool and scope.
  // Key: `${trafficPool}:${scopeKey}`
  const activeByPoolScope = new Map<string, CommercialSession>();
  const sessionList: CommercialSession[] = [];
  const seenTenantEvents = new Map<string, EventIdentityRecord>();

  // 3. Validate and seed prior sessions (period carry-in)
  if (options?.priorSessions) {
    // Check for overlapping prior sessions within the same pool and scope
    const priorByPoolScope = new Map<string, CommercialSession[]>();

    for (const rawPrior of options.priorSessions) {
      const prior = validatePriorSession(rawPrior);
      const poolScopeKey = `${prior.trafficPool}:${prior.scopeKey}`;

      const existingGroup = priorByPoolScope.get(poolScopeKey) ?? [];
      for (const existing of existingGroup) {
        const hasOverlap =
          Math.max(prior.startMs, existing.startMs) <
          Math.min(prior.endMs, existing.endMs);
        if (hasOverlap) {
          throw new Error(
            `Contradictory or overlapping prior session carry-in state detected for pool '${prior.trafficPool}' and scope '${prior.scopeKey}'`,
          );
        }
      }
      existingGroup.push(prior);
      priorByPoolScope.set(poolScopeKey, existingGroup);

      // Record prior absorbed event IDs to enforce tenant-scoped idempotency
      for (const absorbedId of prior.eventIds) {
        seenTenantEvents.set(`${prior.scope.businessId}:${absorbedId}`, {
          timestampMs: prior.startMs,
          actionType: "MESSAGE",
          senderType: "CUSTOMER",
          scopeKey: prior.scopeKey,
          trafficPool: prior.trafficPool,
          isPrior: true,
        });
      }

      activeByPoolScope.set(poolScopeKey, prior);
      sessionList.push(prior);
    }
  }

  let filteredDuplicateCount = 0;
  let startOnlyIgnoredCount = 0;
  let nonCustomerIgnoredCount = 0;

  // 4. Process ordered events
  for (const { event, timestampMs, pool, scope } of sorted) {
    const scopeKey = buildIdentityScopeKey(scope);
    const tenantEventKey = `${scope.businessId}:${event.eventId}`;
    const poolScopeKey = `${pool}:${scopeKey}`;

    // Tenant-scoped idempotency and conflict verification
    const existingRecord = seenTenantEvents.get(tenantEventKey);
    if (existingRecord) {
      const isIdentical =
        existingRecord.scopeKey === scopeKey &&
        existingRecord.trafficPool === pool &&
        (existingRecord.isPrior ||
          (existingRecord.timestampMs === timestampMs &&
            existingRecord.actionType === event.actionType &&
            existingRecord.senderType === event.senderType));

      if (isIdentical) {
        // Idempotent duplicate replay -> skip without increasing counts
        filteredDuplicateCount += 1;
        continue;
      }

      // Conflicting facts for the same event identity within tenant
      throw new Error(
        `Event fact conflict detected for tenant '${scope.businessId}', eventId '${event.eventId}'`,
      );
    }

    if (event.isDuplicate === true) {
      filteredDuplicateCount += 1;
      seenTenantEvents.set(tenantEventKey, {
        timestampMs,
        actionType: event.actionType,
        senderType: event.senderType,
        scopeKey,
        trafficPool: pool,
      });
      continue;
    }

    seenTenantEvents.set(tenantEventKey, {
      timestampMs,
      actionType: event.actionType,
      senderType: event.senderType,
      scopeKey,
      trafficPool: pool,
    });

    const currentActive = activeByPoolScope.get(poolScopeKey);

    // Strictly half-open interval: [startMs, startMs + 24h)
    const isWithinActiveSession =
      currentActive !== undefined &&
      timestampMs >= currentActive.startMs &&
      timestampMs < currentActive.endMs;

    if (isWithinActiveSession && currentActive) {
      // Event falls inside existing open session -> append
      const isQualifying =
        event.senderType === "CUSTOMER" &&
        (event.actionType === "MESSAGE" ||
          event.actionType === "CHOICE_CALLBACK");

      const newTotal = currentActive.totalEventCount + 1;
      const updatedSession: CommercialSession = projectCommercialSession({
        ...currentActive,
        qualifyingEventCount:
          currentActive.qualifyingEventCount + (isQualifying ? 1 : 0),
        totalEventCount: newTotal,
        eventCount: newTotal,
        eventIds: [...currentActive.eventIds, event.eventId],
      });

      activeByPoolScope.set(poolScopeKey, updatedSession);

      const idx = sessionList.findIndex(
        (s) => s.sessionId === currentActive.sessionId,
      );
      if (idx !== -1) {
        sessionList[idx] = updatedSession;
      }
      continue;
    }

    // Beyond active session window (or no active session exists for this pool + scope)
    if (currentActive && !isWithinActiveSession) {
      activeByPoolScope.delete(poolScopeKey);
    }

    // Rule: Non-customer events cannot initiate a session
    if (event.senderType !== "CUSTOMER") {
      nonCustomerIgnoredCount += 1;
      continue;
    }

    // Rule: Start-only command cannot initiate a session
    if (event.actionType === "START_COMMAND") {
      startOnlyIgnoredCount += 1;
      continue;
    }

    // Rule: Qualifying customer actions (MESSAGE or CHOICE_CALLBACK) initiate a new 24h session
    if (
      event.actionType === "MESSAGE" ||
      event.actionType === "CHOICE_CALLBACK"
    ) {
      const startMs = timestampMs;
      const endMs = startMs + SESSION_DURATION_MS;
      const sessionId = generateDeterministicSessionId(
        pool,
        scopeKey,
        startMs,
        event.eventId,
      );

      const newSession: CommercialSession = projectCommercialSession({
        sessionId,
        scopeKey,
        scope,
        trafficPool: pool,
        startAtUtc: new Date(startMs).toISOString(),
        startMs,
        endAtUtc: new Date(endMs).toISOString(),
        endMs,
        initiatingEventId: event.eventId,
        qualifyingEventCount: 1,
        totalEventCount: 1,
        eventCount: 1,
        eventIds: [event.eventId],
      });

      activeByPoolScope.set(poolScopeKey, newSession);
      sessionList.push(newSession);
    }
  }

  // 5. Compute metrics strictly partitioned per traffic pool
  const metricsByPool: Record<TrafficPool, PoolSessionMetrics> = {
    SERVING: {
      sessionCount: 0,
      qualifyingEventCount: 0,
      totalEventCount: 0,
      eventCount: 0,
    },
    SHADOW: {
      sessionCount: 0,
      qualifyingEventCount: 0,
      totalEventCount: 0,
      eventCount: 0,
    },
    TEST: {
      sessionCount: 0,
      qualifyingEventCount: 0,
      totalEventCount: 0,
      eventCount: 0,
    },
  };

  for (const session of sessionList) {
    const targetPool = TRAFFIC_POOLS.includes(session.trafficPool)
      ? session.trafficPool
      : "SERVING";
    metricsByPool[targetPool].sessionCount += 1;
    metricsByPool[targetPool].qualifyingEventCount +=
      session.qualifyingEventCount;
    metricsByPool[targetPool].totalEventCount += session.totalEventCount;
    metricsByPool[targetPool].eventCount += session.eventCount;
  }

  return {
    schema: COMMERCIAL_SESSION_CONTRACT_VERSION,
    sessions: sessionList.map(projectCommercialSession),
    openSessions: Array.from(activeByPoolScope.values()).map(
      projectCommercialSession,
    ),
    filteredDuplicateCount,
    startOnlyIgnoredCount,
    nonCustomerIgnoredCount,
    totalEventsProcessed: events.length,
    metricsByPool,
  };
}
