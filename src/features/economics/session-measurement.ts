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
 * - Multi-interval carry-in resolution: events resolve deterministically against all accepted prior sessions;
 *   events between priors cannot initiate overlapping sessions (fail closed).
 * - Output-to-input closure: legacy un-fingerprinted prior sessions preserve undefined fingerprint status;
 *   rollup output is 100% reusable as prior state across successive batches.
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
  type EventFingerprint,
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
 * Rejects coerced strings, invented defaults, invalid counts, or unverified event relationships.
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

  if (!Array.isArray(s.eventIds) || s.eventIds.length === 0) {
    throw new Error(
      "Prior session eventIds must be a non-empty array of strings",
    );
  }

  const cleanEventIds: string[] = [];
  for (const id of s.eventIds) {
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new Error(
        "Prior session eventIds must contain only non-empty strings",
      );
    }
    cleanEventIds.push(id.trim());
  }
  if (new Set(cleanEventIds).size !== cleanEventIds.length) {
    throw new Error(
      "Prior session eventIds must contain unique identifiers without duplicates",
    );
  }

  if (
    typeof s.totalEventCount !== "number" ||
    !Number.isSafeInteger(s.totalEventCount) ||
    s.totalEventCount < 1
  ) {
    throw new Error(
      "Prior session totalEventCount must be a positive safe integer",
    );
  }
  if (s.totalEventCount !== cleanEventIds.length) {
    throw new Error(
      `Prior session totalEventCount (${s.totalEventCount}) must equal eventIds.length (${cleanEventIds.length})`,
    );
  }

  if (
    typeof s.qualifyingEventCount !== "number" ||
    !Number.isSafeInteger(s.qualifyingEventCount) ||
    s.qualifyingEventCount < 1
  ) {
    throw new Error(
      "Prior session qualifyingEventCount must be a positive safe integer",
    );
  }
  if (s.qualifyingEventCount > s.totalEventCount) {
    throw new Error(
      `Prior session qualifyingEventCount (${s.qualifyingEventCount}) cannot exceed totalEventCount (${s.totalEventCount})`,
    );
  }

  if (s.eventCount !== undefined && s.eventCount !== s.totalEventCount) {
    throw new Error(
      `Prior session eventCount (${String(s.eventCount)}) must equal totalEventCount (${s.totalEventCount})`,
    );
  }

  if (s.initiatingEventId.trim() !== cleanEventIds[0]) {
    throw new Error(
      `Prior session initiatingEventId '${s.initiatingEventId.trim()}' must match the first eventId '${cleanEventIds[0]}'`,
    );
  }

  let cleanFingerprints: EventFingerprint[] | undefined;
  if (s.eventFingerprints !== undefined) {
    if (!Array.isArray(s.eventFingerprints)) {
      throw new Error(
        "Prior session eventFingerprints must be an array when specified",
      );
    }
    if (s.eventFingerprints.length !== cleanEventIds.length) {
      throw new Error(
        `Prior session eventFingerprints length (${s.eventFingerprints.length}) must match eventIds.length (${cleanEventIds.length})`,
      );
    }
    cleanFingerprints = [];
    for (let i = 0; i < s.eventFingerprints.length; i++) {
      const rawFp = s.eventFingerprints[i] as Record<string, unknown>;
      if (typeof rawFp !== "object" || rawFp === null) {
        throw new Error("EventFingerprint must be a non-null object");
      }
      if (
        typeof rawFp.eventId !== "string" ||
        rawFp.eventId.trim() !== cleanEventIds[i]
      ) {
        throw new Error(
          `EventFingerprint eventId '${String(rawFp.eventId)}' does not match eventIds[${i}] '${cleanEventIds[i]}'`,
        );
      }
      if (
        typeof rawFp.canonicalTimestampMs !== "number" ||
        !Number.isSafeInteger(rawFp.canonicalTimestampMs) ||
        rawFp.canonicalTimestampMs < s.startMs ||
        rawFp.canonicalTimestampMs >= s.endMs
      ) {
        throw new Error(
          `EventFingerprint canonicalTimestampMs must fall within prior session window [${s.startMs}, ${s.endMs})`,
        );
      }
      if (
        typeof rawFp.actionType !== "string" ||
        !INBOUND_ACTION_TYPES.includes(rawFp.actionType as InboundActionType)
      ) {
        throw new Error(
          `Invalid EventFingerprint actionType '${String(rawFp.actionType)}'`,
        );
      }
      if (
        typeof rawFp.senderType !== "string" ||
        !SENDER_TYPES.includes(rawFp.senderType as SenderType)
      ) {
        throw new Error(
          `Invalid EventFingerprint senderType '${String(rawFp.senderType)}'`,
        );
      }
      cleanFingerprints.push({
        eventId: cleanEventIds[i]!,
        canonicalTimestampMs: rawFp.canonicalTimestampMs,
        actionType: rawFp.actionType as InboundActionType,
        senderType: rawFp.senderType as SenderType,
      });
    }
  }

  return projectCommercialSession({
    sessionId: s.sessionId.trim(),
    scopeKey: expectedScopeKey,
    scope,
    trafficPool: s.trafficPool as TrafficPool,
    startAtUtc: expectedStartIso,
    startMs: s.startMs,
    endAtUtc: expectedEndIso,
    endMs: s.endMs,
    initiatingEventId: cleanEventIds[0]!,
    qualifyingEventCount: s.qualifyingEventCount,
    totalEventCount: s.totalEventCount,
    eventCount: s.totalEventCount,
    eventIds: cleanEventIds,
    eventFingerprints: cleanFingerprints,
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
    ...(s.eventFingerprints !== undefined
      ? {
          eventFingerprints: s.eventFingerprints.map((f) => ({
            eventId: f.eventId,
            canonicalTimestampMs: f.canonicalTimestampMs,
            actionType: f.actionType,
            senderType: f.senderType,
          })),
        }
      : {}),
  };
}

interface EventIdentityRecord {
  readonly timestampMs: number;
  readonly actionType: InboundActionType;
  readonly senderType: SenderType;
  readonly scopeKey: string;
  readonly trafficPool: TrafficPool;
  readonly isPriorUnverifiable?: boolean;
  readonly priorSessionId?: string;
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

  // 2. Initialize tracking structures partitioned by operational traffic pool and scope.
  // sessionsByPoolScope tracks all non-overlapping sessions for each pool:scope.
  const sessionsByPoolScope = new Map<string, CommercialSession[]>();
  const sessionList: CommercialSession[] = [];
  const seenTenantEvents = new Map<string, EventIdentityRecord>();
  const scopeWatermark = new Map<string, number>();

  // 3. Validate and seed prior sessions (period carry-in) deterministically.
  if (options?.priorSessions && options.priorSessions.length > 0) {
    const validatedPriors = options.priorSessions.map((raw) =>
      validatePriorSession(raw),
    );

    // Sort prior sessions deterministically to make input ordering invariant
    const sortedPriors = [...validatedPriors].sort((a, b) => {
      if (a.startMs !== b.startMs) {
        return a.startMs - b.startMs;
      }
      return a.sessionId.localeCompare(b.sessionId);
    });

    for (const prior of sortedPriors) {
      const poolScopeKey = `${prior.trafficPool}:${prior.scopeKey}`;

      const existingGroup = sessionsByPoolScope.get(poolScopeKey) ?? [];
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
      sessionsByPoolScope.set(poolScopeKey, existingGroup);

      // Track the earliest carry-in watermark per pool and scope
      if (
        !scopeWatermark.has(poolScopeKey) ||
        prior.startMs < scopeWatermark.get(poolScopeKey)!
      ) {
        scopeWatermark.set(poolScopeKey, prior.startMs);
      }

      // Record absorbed events: if fingerprints are present, record comparable facts;
      // if absent, flag as unverifiable so any replay attempts fail closed.
      if (prior.eventFingerprints && prior.eventFingerprints.length > 0) {
        for (const fp of prior.eventFingerprints) {
          seenTenantEvents.set(`${prior.scope.businessId}:${fp.eventId}`, {
            timestampMs: fp.canonicalTimestampMs,
            actionType: fp.actionType,
            senderType: fp.senderType,
            scopeKey: prior.scopeKey,
            trafficPool: prior.trafficPool,
          });
        }
      } else {
        for (const absorbedId of prior.eventIds) {
          seenTenantEvents.set(`${prior.scope.businessId}:${absorbedId}`, {
            timestampMs: -1,
            actionType: "MESSAGE",
            senderType: "CUSTOMER",
            scopeKey: prior.scopeKey,
            trafficPool: prior.trafficPool,
            isPriorUnverifiable: true,
            priorSessionId: prior.sessionId,
          });
        }
      }

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

    // Boundary check: Enforce carry-in watermark. Out-of-contract events predating the prior start fail closed.
    const watermarkMs = scopeWatermark.get(poolScopeKey);
    if (watermarkMs !== undefined && timestampMs < watermarkMs) {
      throw new Error(
        `Out-of-contract event before carry-in window start: event '${event.eventId}' timestamp (${new Date(timestampMs).toISOString()}) is earlier than prior session start (${new Date(watermarkMs).toISOString()})`,
      );
    }

    // Tenant-scoped idempotency and conflict verification
    const existingRecord = seenTenantEvents.get(tenantEventKey);
    if (existingRecord) {
      if (existingRecord.isPriorUnverifiable) {
        throw new Error(
          `Unverifiable event replay: eventId '${event.eventId}' was recorded in carry-in session '${existingRecord.priorSessionId}' without comparable facts/fingerprints`,
        );
      }

      const isIdentical =
        existingRecord.scopeKey === scopeKey &&
        existingRecord.trafficPool === pool &&
        existingRecord.timestampMs === timestampMs &&
        existingRecord.actionType === event.actionType &&
        existingRecord.senderType === event.senderType;

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

    const poolSessions = sessionsByPoolScope.get(poolScopeKey) ?? [];

    // Find if the event falls inside ANY existing accepted session interval [startMs, endMs)
    const matchingSession = poolSessions.find(
      (s) => timestampMs >= s.startMs && timestampMs < s.endMs,
    );

    if (matchingSession) {
      // Event falls inside an active or prior open session -> append
      const isQualifying =
        event.senderType === "CUSTOMER" &&
        (event.actionType === "MESSAGE" ||
          event.actionType === "CHOICE_CALLBACK");

      const newTotal = matchingSession.totalEventCount + 1;
      const newFp: EventFingerprint = {
        eventId: event.eventId,
        canonicalTimestampMs: timestampMs,
        actionType: event.actionType,
        senderType: event.senderType,
      };

      const updatedSession: CommercialSession = projectCommercialSession({
        ...matchingSession,
        qualifyingEventCount:
          matchingSession.qualifyingEventCount + (isQualifying ? 1 : 0),
        totalEventCount: newTotal,
        eventCount: newTotal,
        eventIds: [...matchingSession.eventIds, event.eventId],
        // Output-to-input closure: if matching session had fingerprints, append new fingerprint;
        // if it lacked fingerprints (legacy un-fingerprinted prior), preserve undefined status
        eventFingerprints:
          matchingSession.eventFingerprints !== undefined
            ? [...matchingSession.eventFingerprints, newFp]
            : undefined,
      });

      const poolIdx = poolSessions.findIndex(
        (s) => s.sessionId === matchingSession.sessionId,
      );
      if (poolIdx !== -1) {
        poolSessions[poolIdx] = updatedSession;
      }

      const listIdx = sessionList.findIndex(
        (s) => s.sessionId === matchingSession.sessionId,
      );
      if (listIdx !== -1) {
        sessionList[listIdx] = updatedSession;
      }
      continue;
    }

    // Event does not fall inside any accepted session interval.
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

      // Interval collision check: Never silently create overlapping sessions with any accepted session!
      for (const existing of poolSessions) {
        const hasOverlap =
          Math.max(startMs, existing.startMs) < Math.min(endMs, existing.endMs);
        if (hasOverlap) {
          throw new Error(
            `Event '${event.eventId}' at ${new Date(startMs).toISOString()} cannot initiate session: interval [${new Date(startMs).toISOString()}, ${new Date(endMs).toISOString()}) overlaps with existing session '${existing.sessionId}' [${existing.startAtUtc}, ${existing.endAtUtc})`,
          );
        }
      }

      const sessionId = generateDeterministicSessionId(
        pool,
        scopeKey,
        startMs,
        event.eventId,
      );

      const initialFp: EventFingerprint = {
        eventId: event.eventId,
        canonicalTimestampMs: timestampMs,
        actionType: event.actionType,
        senderType: event.senderType,
      };

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
        eventFingerprints: [initialFp],
      });

      poolSessions.push(newSession);
      poolSessions.sort((a, b) => a.startMs - b.startMs);
      sessionsByPoolScope.set(poolScopeKey, poolSessions);
      sessionList.push(newSession);
    }
  }

  // 5. Compute metrics strictly partitioned per traffic pool
  type MutableMetrics = {
    sessionCount: number;
    qualifyingEventCount: number;
    totalEventCount: number;
    eventCount: number;
  };

  const poolAccumulators: Record<TrafficPool, MutableMetrics> = {
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
    const acc = poolAccumulators[targetPool];
    acc.sessionCount += 1;
    acc.qualifyingEventCount += session.qualifyingEventCount;
    acc.totalEventCount += session.totalEventCount;
    acc.eventCount += session.eventCount;
  }

  const metricsByPool: Record<TrafficPool, PoolSessionMetrics> = {
    SERVING: { ...poolAccumulators.SERVING },
    SHADOW: { ...poolAccumulators.SHADOW },
    TEST: { ...poolAccumulators.TEST },
  };

  const lastBatchTimestampMs =
    sorted.length > 0 ? sorted[sorted.length - 1]!.timestampMs : undefined;

  const sortedSessions = [...sessionList].sort((a, b) => {
    if (a.startMs !== b.startMs) {
      return a.startMs - b.startMs;
    }
    return a.sessionId.localeCompare(b.sessionId);
  });

  const openSessions = sortedSessions.filter((s) =>
    lastBatchTimestampMs === undefined
      ? true
      : lastBatchTimestampMs >= s.startMs && lastBatchTimestampMs < s.endMs,
  );

  return {
    schema: COMMERCIAL_SESSION_CONTRACT_VERSION,
    sessions: sortedSessions.map(projectCommercialSession),
    openSessions: openSessions.map(projectCommercialSession),
    filteredDuplicateCount,
    startOnlyIgnoredCount,
    nonCustomerIgnoredCount,
    totalEventsProcessed: events.length,
    metricsByPool,
  };
}
