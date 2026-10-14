/**
 * JEV SHADOW strategy — PROMPT-AI-JEV-03D (OPTION E — CONCURRENT
 * NON-AUTHORITATIVE SEMANTIC-JEV SHADOW).
 *
 * A NON-AUTHORITATIVE semantic-JEV evaluation that runs ALONGSIDE the current
 * customer-serving route through the EXISTING async JEV / orchestrator seam.
 * Its result is EVIDENCE ONLY. For a normal generative turn in SHADOW state:
 *
 *                  ┌── existing generative provider call ─── authoritative
 *   request ───────┤
 *                  └── semantic JEV shadow evaluation ───── evidence only
 *
 * HARD CONTRACT (binding; verified by scripts/check-jev-shadow.ts):
 *
 *  · NON-AUTHORITATIVE. The shadow result can NEVER: choose the customer
 *    response, change the Turn Planner result, change routing, create or
 *    cancel a booking, create or suppress a handoff, send a customer message,
 *    cause a second resolver, become a judge, or write business/domain state.
 *    It is attached to a telemetry slot (`AiTelemetry.shadow`) that NO
 *    decision, resolver, routing or transport code reads.
 *
 *  · STARTED ONLY WHEN ELIGIBLE. The shadow starts only AFTER the
 *    authoritative `decide()` returned GENERATIVE and only for turns the
 *    ACTIVE gate (`jevEligibility`) would serve — the shadow population IS
 *    the population an activation would serve. Deterministic zero-call
 *    bypass turns and ACTIVE semantic turns NEVER start a shadow call.
 *
 *  · DETERMINISTIC, STATELESS SAMPLING. `admit(traceId)` is a sha256 hash
 *    over a stable opaque turn id + a domain-separation salt. No DB, no
 *    counter, no customer-specific permanent state; the same turn always
 *    yields the same admit decision (recomputable offline).
 *
 *  · ONE CALL, ZERO RETRY. A shadowed turn spends AT MOST ONE shadow JEV
 *    call, through the same pinned, zero-retry Decisions provider the ACTIVE
 *    path would use. A second attempt would be a second model call and would
 *    corrupt the disjoint accounting.
 *
 *  · TOTAL FAILURE ISOLATION. Every shadow failure class (timeout, network,
 *    4xx/5xx, rate limit, missing credential, malformed, empty, unsupported,
 *    internal exception) is OBSERVATIONAL ONLY: the customer turn completes
 *    according to its existing rules, byte-for-byte.
 *
 *  · DISJOINT ACCOUNTING. The shadow call is accounted in
 *    `shadowModelCallCount`, NEVER in the serving `modelCallCount`.
 *
 *  · CLOSED-KEY EVIDENCE ONLY. The evidence block carries machine keys,
 *    sanitized probabilities and booleans — never customer raw text, prompt
 *    text, raw provider payload, secrets, Authorization headers,
 *    chain-of-thought, or model prose.
 *
 * PRODUCTION ISOLATION: this module imports ZERO runtime code from
 * `evaluation/*` and holdsout nothing; the frozen artifacts are spent
 * historical evidence only.
 */

import { createHash } from "node:crypto";

import type { AiRequest } from "@/features/conversations/server/ai-contract";

import type { JevDecisionsProvider } from "./jev-decisions-provider";
import {
  buildSemanticRequest,
  evaluateSemanticReading,
  jevEligibility,
  languageHint,
} from "./jev-semantic-strategy";
import type { JevSemanticEvidence } from "./jev-semantic-strategy";

// ─── 1. Identity + the join deadline ──────────────────────────────────────────

export const SHADOW_JEV_STRATEGY_ID = "jev-shadow@v1";

/**
 * The shadow join deadline (PROMPT-AI-JEV-03C §13.4). Deliberately BELOW the
 * customer path's own 15s bound: a shadow sample is not worth a second of
 * customer latency. The join is bounded by this value, and the shadow's JEV
 * provider is constructed with the SAME deadline as its own request timeout,
 * so a slow provider still yields a complete `TIMEOUT` evidence record.
 */
export const JEV_SHADOW_TIMEOUT_MS = 6_000;

export const SHADOW_TIMEOUT_ENV = "JEV_SHADOW_TIMEOUT_MS";

// ─── 2. The deterministic sampler + budget guards (§8.1 / §13.4) ───────────────

export const SHADOW_SALT_ENV = "SHADOW_SALT";
export const SHADOW_SAMPLE_RATE_ENV = "SHADOW_SAMPLE_RATE";
export const SHADOW_MAX_CALLS_PER_DAY_ENV = "SHADOW_MAX_CALLS_PER_DAY";

/**
 * Domain-separation constant for the sampling hash. A deployed constant, NOT
 * a secret: its only purpose is that the admit decision cannot be predicted
 * or steered from outside. Changing it resets the sample (and must be
 * recorded). Overridable through `SHADOW_SALT` for exactly that purpose.
 */
export const DEFAULT_SHADOW_SALT = "flowpilot.jev-shadow.v1";

/** The AI-JEV-03C stage-0 sampling rate: 1/100 of eligible turns. */
export const DEFAULT_SHADOW_SAMPLE_RATE = 0.01;

/** The AI-JEV-03C recommended daily call ceiling. */
export const DEFAULT_SHADOW_MAX_CALLS_PER_DAY = 200;

/** The trailing window for the error-rate circuit breaker. */
const CIRCUIT_TRAILING_WINDOW = 50;

/** Trip the circuit when the trailing failure rate exceeds 25%. */
const CIRCUIT_FAILURE_RATE = 0.25;

export type ShadowNotSampledReason =
  | "NOT_SAMPLED"
  | "DAILY_CEILING_REACHED"
  | "SHADOW_CIRCUIT_OPEN"
  | "SAMPLER_DISABLED"
  | "NO_TRACE_ID";

function parseSampleRate(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_SHADOW_SAMPLE_RATE;
  const parsed = Number.parseFloat(raw.trim());
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    // Fail-closed: a malformed rate admits NOTHING rather than everything.
    return 0;
  }
  return parsed;
}

function parseMaxCallsPerDay(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_SHADOW_MAX_CALLS_PER_DAY;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    // Fail-closed: a malformed ceiling admits NOTHING.
    return 0;
  }
  return parsed;
}

/**
 * The deterministic sampling hash: `leading32(sha256(salt ∥ traceId))` compared
 * against `ceil(2^32 × rate)`. Statelesss, content-free (the input is the
 * opaque turn id, never the message text), and recomputable offline.
 */
export function sampleUint32(salt: string, traceId: string): number {
  return createHash("sha256")
    .update(`${salt}${traceId}`, "utf8")
    .digest()
    .readUInt32BE(0);
}

export type ShadowSampler = {
  /**
   * Admit one turn. Deterministic: the same (salt, traceId, rate) always
   * yields the same decision, across runs and process restarts. Pure modulo
   * the in-process budget guards (daily ceiling + error-rate circuit), which
   * are the AI-JEV-03C fail-open controls.
   */
  admit(traceId: string): boolean;
  /** Why the most recent `admit` returned false (null when it returned true). */
  notAdmittedReason(): ShadowNotSampledReason | null;
  /** Record ONE completed shadow evaluation (every failure class included). */
  record(result: { ok: boolean; attemptSpent: boolean }): void;
  /** True when the trailing error-rate circuit breaker is open. */
  circuitOpen(): boolean;
};

export function createShadowSampler(deps: {
  readonly getEnvVar: (name: string) => string | undefined;
  /** Injection point for deterministic tests; defaults to the wall clock. */
  readonly now?: () => Date;
}): ShadowSampler {
  const salt =
    (deps.getEnvVar(SHADOW_SALT_ENV) ?? "").trim() || DEFAULT_SHADOW_SALT;
  const rate = parseSampleRate(deps.getEnvVar(SHADOW_SAMPLE_RATE_ENV));
  const maxCallsPerDay = parseMaxCallsPerDay(
    deps.getEnvVar(SHADOW_MAX_CALLS_PER_DAY_ENV),
  );
  const now = deps.now ?? (() => new Date());

  let windowDate = "";
  let callsToday = 0;
  let lastNotAdmitted: ShadowNotSampledReason | null = null;
  const trailing: Array<boolean> = [];

  function resetWindowIfNewDay(): void {
    const today = now().toISOString().slice(0, 10);
    if (today !== windowDate) {
      windowDate = today;
      callsToday = 0;
    }
  }

  function failureRate(): number {
    if (trailing.length < CIRCUIT_TRAILING_WINDOW) return 0;
    let failures = 0;
    for (const ok of trailing) if (!ok) failures += 1;
    return failures / trailing.length;
  }

  return {
    admit(traceId) {
      resetWindowIfNewDay();
      // `SHADOW_MAX_CALLS_PER_DAY=0` is an explicit operator off-switch: it
      // admits nothing (AI-JEV-03C §15.3 belt-and-braces).
      if (maxCallsPerDay <= 0) {
        lastNotAdmitted = "SAMPLER_DISABLED";
        return false;
      }
      if (callsToday >= maxCallsPerDay) {
        lastNotAdmitted = "DAILY_CEILING_REACHED";
        return false;
      }
      if (failureRate() > CIRCUIT_FAILURE_RATE) {
        lastNotAdmitted = "SHADOW_CIRCUIT_OPEN";
        return false;
      }
      const threshold = Math.ceil(2 ** 32 * rate);
      if (sampleUint32(salt, traceId) >= threshold) {
        lastNotAdmitted = "NOT_SAMPLED";
        return false;
      }
      lastNotAdmitted = null;
      return true;
    },
    notAdmittedReason() {
      return lastNotAdmitted;
    },
    record(result) {
      resetWindowIfNewDay();
      // The daily ceiling bounds CALLS, so only a spent attempt counts.
      if (result.attemptSpent) callsToday += 1;
      trailing.push(result.ok);
      if (trailing.length > CIRCUIT_TRAILING_WINDOW) trailing.shift();
    },
    circuitOpen() {
      return failureRate() > CIRCUIT_FAILURE_RATE;
    },
  };
}

// ─── 3. Admission + the shadow evaluation ──────────────────────────────────────

export type ShadowAdmission = {
  /** True iff the turn is on the generative route AND JEV-eligible. */
  readonly eligible: boolean;
  /** The closed ineligibility reason when not eligible (null otherwise). */
  readonly ineligibilityReason: string | null;
  /** True iff the deterministic sampler admitted this turn. */
  readonly sampled: boolean;
  /** The closed reason an eligible turn was NOT sampled (null otherwise). */
  readonly notSampledReason: ShadowNotSampledReason | null;
};

export type ShadowJevStrategy = {
  readonly strategyId: string;
  /**
   * PURE, total, performs ZERO model calls and ZERO network I/O. Decides
   * whether THIS turn may be shadow-evaluated: the ACTIVE eligibility gate +
   * the deterministic sampler. The orchestrator consults this BEFORE any
   * shadow promise exists, so a non-admitted turn never spends a call.
   */
  admit(request: AiRequest): ShadowAdmission;
  /**
   * The ONE non-authoritative JEV evaluation. TOTAL: never throws — every
   * failure class (including an internal exception) is absorbed and surfaced
   * as closed-key evidence or a lost-record null. The shadow NEVER returns a
   * decision, a response, or resolver signals; it returns comparison
   * evidence only.
   */
  evaluate(request: AiRequest): Promise<JevSemanticEvidence | null>;
};

export type ShadowJevStrategyDeps = {
  readonly provider: JevDecisionsProvider;
  readonly sampler: ShadowSampler;
  /** The shadow deadline (defaults to JEV_SHADOW_TIMEOUT_MS). */
  readonly timeoutMs?: number;
};

/**
 * The pure ZERO-CALL evidence marker for a turn that reached the shadow seam
 * but was NOT evaluated (ineligible, or eligible but not sampled). It exists
 * so the eligible → sampled → completed funnel is measurable from evidence
 * without spending a model call on non-sampled turns. Closed machine keys
 * only; `jevCallSpent` is always false and `shadowModelCallCount` is 0.
 */
export function shadowMarkerEvidence(
  admission: ShadowAdmission,
  request: AiRequest,
): JevSemanticEvidence {
  return {
    selected: admission.eligible,
    resultClass: admission.eligible
      ? "NOT_SAMPLED"
      : (admission.ineligibilityReason ?? "INELIGIBLE"),
    jevCallSpent: false,
    facts: {},
    probabilities: {},
    confidence: "low",
    precedence: {
      supportRequest: false,
      providerRequest: false,
      bookingTask: false,
      explicitHuman: false,
      derivation: "none",
    },
    conversationGoal: null,
    contactVsBook: false,
    clarifyContactOrBookProposed: false,
    handoffAgreement: "AGREE_NO_HANDOFF",
    failureCode: null,
    servedModel: null,
    languageHint: languageHint(request.message),
    latencyMs: null,
    evidenceRole: "SHADOW",
    sampled: admission.sampled,
    bucket: "OBSERVATION",
    notSampledReason: admission.notSampledReason,
  };
}

export function createShadowJevStrategy(
  deps: ShadowJevStrategyDeps,
): ShadowJevStrategy {
  return {
    strategyId: SHADOW_JEV_STRATEGY_ID,

    admit(request) {
      // The SAME gate ACTIVE uses (PROMPT-AI-JEV-03C §6): the shadow
      // population is the population an activation would serve.
      const eligibility = jevEligibility(request);
      if (!eligibility.eligible) {
        return {
          eligible: false,
          ineligibilityReason: eligibility.reason,
          sampled: false,
          notSampledReason: null,
        };
      }
      // No opaque turn id ⇒ no deterministic sampling key ⇒ fail closed.
      // (Pre-03D request producers never set one, so nothing is shadowed.)
      const traceId = request.traceId;
      if (!traceId) {
        return {
          eligible: true,
          ineligibilityReason: null,
          sampled: false,
          notSampledReason: "NO_TRACE_ID",
        };
      }
      if (!deps.sampler.admit(traceId)) {
        return {
          eligible: true,
          ineligibilityReason: null,
          sampled: false,
          notSampledReason: deps.sampler.notAdmittedReason(),
        };
      }
      return {
        eligible: true,
        ineligibilityReason: null,
        sampled: true,
        notSampledReason: null,
      };
    },

    async evaluate(request) {
      try {
        const evaluation = await deps.provider.evaluate(
          buildSemanticRequest(request),
        );
        deps.sampler.record({
          ok: evaluation.ok,
          attemptSpent: evaluation.attemptSpent,
        });
        const reading = evaluateSemanticReading(request, evaluation);
        // Mark SHADOW. The evidence deliberately drops `outcome` (the shadow
        // owns no turn) and NEVER attaches resolver `signals`.
        return {
          ...reading.evidence,
          evidenceRole: "SHADOW" as const,
          sampled: true,
          bucket: "OBSERVATION",
        };
      } catch {
        // Total isolation (PROMPT-AI-JEV-03C §14): an internal shadow
        // exception is a LOST evidence record, never a customer event.
        return null;
      }
    },
  };
}

// ─── 4. The shadow timeout knob ─────────────────────────────────────────────────

/**
 * Read the shadow join deadline from the injected env seam. Absent ⇒ the
 * recommended 6 000 ms; present but not a positive integer ⇒ fail-closed to
 * the recommended default (never an unbounded join).
 */
export function parseShadowTimeoutMs(
  getEnvVar: (name: string) => string | undefined,
): number {
  const raw = getEnvVar(SHADOW_TIMEOUT_ENV);
  if (raw === undefined) return JEV_SHADOW_TIMEOUT_MS;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return JEV_SHADOW_TIMEOUT_MS;
  return parsed;
}
