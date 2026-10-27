/**
 * FlowPilot — Economics & Measurement Domain Types
 * (flowpilot.commercial.session.contract@v1 & flowpilot.cost.engine@v1)
 *
 * Canonical pure contracts for internal usage metering and cost calculation.
 * Preserves the hard separation: Usage ≠ Cost ≠ Price ≠ Entitlement ≠ Billing (ECONOMICS.md).
 * No Prisma, no DB access, no network, no UI dependencies.
 */

export const COMMERCIAL_SESSION_CONTRACT_VERSION =
  "flowpilot.commercial.session.contract@v1" as const;

export const COST_ENGINE_VERSION = "flowpilot.cost.engine@v1" as const;

export const SESSION_DURATION_MS = 24 * 60 * 60 * 1000; // 86,400,000 ms (exactly 24 UTC hours)

export const TRAFFIC_POOLS = ["SERVING", "SHADOW", "TEST"] as const;
export type TrafficPool = (typeof TRAFFIC_POOLS)[number];

export const INBOUND_ACTION_TYPES = [
  "MESSAGE",
  "CHOICE_CALLBACK",
  "START_COMMAND",
  "ASSISTANT_REPLY",
] as const;
export type InboundActionType = (typeof INBOUND_ACTION_TYPES)[number];

export const SENDER_TYPES = ["CUSTOMER", "ASSISTANT"] as const;
export type SenderType = (typeof SENDER_TYPES)[number];

export const CHANNEL_TYPES = ["telegram", "whatsapp"] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

/**
 * Explicit scope identity anchored to tenant, customer, transport channel,
 * and exact connection instance (never assumes channel type alone identifies connection).
 */
export interface IdentityScope {
  readonly businessId: string;
  readonly customerId: string;
  readonly channel: ChannelType;
  readonly connectionId: string;
}

/**
 * Build a canonical, deterministic scope key for session grouping.
 */
export function buildIdentityScopeKey(scope: IdentityScope): string {
  return `${scope.businessId}:${scope.channel}:${scope.connectionId}:${scope.customerId}`;
}

/**
 * Normalized canonical inbound event for session measurement.
 * Carries exactly ONE canonical timestamp field to eliminate fallback ambiguity.
 */
export interface CanonicalInboundEvent {
  readonly eventId: string;
  /** Explicit canonical event instant (ISO string with timezone offset or Date). */
  readonly canonicalTimestamp: string | Date;
  readonly senderType: SenderType;
  readonly actionType: InboundActionType;
  readonly scope: IdentityScope;
  /** True if deduplication ledger intercepted this payload. */
  readonly isDuplicate?: boolean;
  /** Operational pool. Defaults to SERVING if unspecified. */
  readonly trafficPool?: TrafficPool;
}

/**
 * Measured commercial session spanning a half-open UTC window [start, start + 24h).
 */
export interface CommercialSession {
  readonly sessionId: string;
  readonly scopeKey: string;
  readonly scope: IdentityScope;
  readonly trafficPool: TrafficPool;
  readonly startAtUtc: string;
  readonly startMs: number;
  readonly endAtUtc: string;
  readonly endMs: number;
  readonly initiatingEventId: string;
  /** Number of qualifying substantive customer events (MESSAGE, CHOICE_CALLBACK) in this session. */
  readonly qualifyingEventCount: number;
  /** Total number of all accepted events in this session (initiating, assistant, start commands). */
  readonly totalEventCount: number;
  /** Backwards-compatible alias for totalEventCount. */
  readonly eventCount: number;
  readonly eventIds: ReadonlyArray<string>;
}

export interface SessionRollupOptions {
  /**
   * Prior active sessions from previous measurement periods for period carry-in.
   * If a qualifying event falls inside a prior unexpired session, it is appended
   * rather than generating an artificial new session.
   */
  readonly priorSessions?: ReadonlyArray<CommercialSession>;
}

export interface PoolSessionMetrics {
  readonly sessionCount: number;
  readonly qualifyingEventCount: number;
  readonly totalEventCount: number;
  readonly eventCount: number;
}

export interface SessionRollupResult {
  readonly schema: typeof COMMERCIAL_SESSION_CONTRACT_VERSION;
  readonly sessions: ReadonlyArray<CommercialSession>;
  readonly openSessions: ReadonlyArray<CommercialSession>;
  readonly filteredDuplicateCount: number;
  readonly startOnlyIgnoredCount: number;
  readonly nonCustomerIgnoredCount: number;
  readonly totalEventsProcessed: number;
  readonly metricsByPool: Record<TrafficPool, PoolSessionMetrics>;
}

/**
 * Physical attempt execution facts emitted by the execution layer.
 */
export interface PhysicalAttemptFact {
  readonly attemptId: string;
  readonly attemptIndex: number;
  readonly trafficPool: TrafficPool;
  readonly provider: string;
  readonly model?: string | null;
  /** Optional attempt execution timestamp with explicit timezone offset or Date instance. */
  readonly attemptTimestamp?: string | Date;
  /** Optional explicit reference to an immutable rate snapshot. */
  readonly snapshotId?: string | null;
  /**
   * True ONLY if proven that no HTTP request left the host process
   * (e.g. halted by FLOWPILOT_AI_GLOBAL_STOP, max attempt ceiling clamp, or deterministic bypass).
   */
  readonly locallyPreventedZeroDispatch?: boolean;
  readonly status: "SUCCESS" | "FAILURE";
  readonly httpStatus?: number | null;
  /** Provider-reported cost directly parsed from response payload (e.g. OpenRouter cost in USD). */
  readonly reportedCostUsd?: number | null;
  readonly inputTokens?: number | null;
  /** Subset of inputTokens served from provider prompt cache. */
  readonly cachedInputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly latencyMs?: number | null;
  readonly errorCode?: string | null;
}

/**
 * Versioned, dated rate snapshot for model token cost estimation.
 */
export interface ModelRateSnapshot {
  readonly snapshotId: string;
  readonly provider: string;
  readonly model: string;
  readonly effectiveDate: string; // YYYY-MM-DD
  readonly promptCostPerMillionUsd: number;
  readonly cachedPromptCostPerMillionUsd?: number | null;
  readonly completionCostPerMillionUsd: number;
  readonly source: string;
}

export type AttemptCostProvenance =
  "PROVIDER_REPORTED" | "RATE_SNAPSHOT" | "ZERO_DISPATCH_PREVENTED" | "UNKNOWN";

export type AttemptCostCompleteness = "KNOWN" | "UNKNOWN";

export interface AttemptCostResult {
  readonly attemptId: string;
  readonly attemptIndex: number;
  readonly trafficPool: TrafficPool;
  readonly provider: string;
  readonly model: string | null;
  readonly isDispatched: boolean;
  /** Raw high-precision unrounded USD cost (IEEE 754 64-bit float). Null if unknown. */
  readonly costUsd: number | null;
  readonly provenance: AttemptCostProvenance;
  readonly completeness: AttemptCostCompleteness;
  readonly snapshotId?: string;
  readonly rateEffectiveDate?: string;
  readonly rateSource?: string;
  readonly uncachedInputTokens?: number | null;
  readonly cachedInputTokens?: number | null;
  readonly outputTokens?: number | null;
}

export type CostCompleteness = "COMPLETE" | "PARTIAL" | "UNAVAILABLE";

export interface PoolCostSummary {
  readonly trafficPool: TrafficPool;
  readonly dispatchedAttempts: number;
  readonly knownAttempts: number;
  readonly unknownAttempts: number;
  readonly locallyPreventedAttempts: number;
  /** Total cost if all dispatched attempts are known. Null if any attempt is unknown. */
  readonly totalCostUsd: number | null;
  /** Sum of all known attempt costs in this pool (unrounded float). Preserved separately from total. */
  readonly knownSubtotalUsd: number;
  readonly costCompleteness: CostCompleteness;
  /** Null when dispatchedAttempts === 0 (N/A); otherwise knownAttempts / dispatchedAttempts. */
  readonly coverageRatio: number | null;
  readonly coveragePercentage: string | null;
}

export interface TurnCostResult {
  readonly schema: typeof COST_ENGINE_VERSION;
  readonly attempts: ReadonlyArray<AttemptCostResult>;
  readonly pools: Record<TrafficPool, PoolCostSummary>;
  readonly serving: PoolCostSummary;
  readonly shadow: PoolCostSummary;
  readonly test: PoolCostSummary;
}
