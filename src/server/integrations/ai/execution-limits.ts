/**
 * Global AI Stop and Shared Serving Execution Limits (CORE-04B).
 *
 * Operational exposure controls for production external AI invocations:
 * 1. Global external-model stop (FLOWPILOT_AI_GLOBAL_STOP):
 *    Authoritative gate stopping all external serving LLM, serving JEV,
 *    and shadow model HTTP requests when engaged.
 * 2. Shared per-execution serving-attempt allowance (FLOWPILOT_AI_MAX_SERVING_ATTEMPTS):
 *    Single allowance per inbound turn shared across initial dispatch,
 *    internal retries, and secondary fallback. Defaults to 3 (2 primary + 1 secondary).
 * 3. Shared serving deadline:
 *    One deadline per inbound execution that is not reset by retry or fallback.
 * 4. Machine-readable stop reasons and honest execution accounting:
 *    Distinguishes provider failures from prevented requests without incrementing
 *    physical HTTP attempt counts or fabricating costs.
 */

export const FLOWPILOT_AI_GLOBAL_STOP_FLAG = "FLOWPILOT_AI_GLOBAL_STOP";
export const FLOWPILOT_AI_MAX_SERVING_ATTEMPTS_FLAG =
  "FLOWPILOT_AI_MAX_SERVING_ATTEMPTS";

export const DEFAULT_MAX_SERVING_ATTEMPTS = 3;
export const HARD_CEILING_SERVING_ATTEMPTS = 3;
export const MIN_SERVING_ATTEMPTS = 1;

/** Platform route budget default for a whole logical turn. */
export const DEFAULT_SERVING_ROUTE_BUDGET_MS = 300_000;
/** Reserved safety margin for persistence and delivery. */
export const SERVING_ROUTE_SAFETY_MARGIN_MS = 20_000;

export type AiStopReason =
  | "GLOBAL_STOP"
  | "ATTEMPT_LIMIT_EXHAUSTED"
  | "DEADLINE_EXHAUSTED"
  | "INVALID_CONTROL_CONFIG";

export const GLOBAL_STOP_ENABLEMENTS = new Set(["1", "true", "yes", "on"]);
export const GLOBAL_STOP_DISABLEMENTS = new Set(["0", "false", "no", "off"]);

export type GlobalStopConfig = {
  readonly stopped: boolean;
  readonly malformed: boolean;
  readonly stopReason: AiStopReason | null;
};

/**
 * Parses the global AI stop environment setting.
 *
 * Requirements:
 * - Absence / undefined / empty string preserves normal authorized operation.
 * - Explicit truthy values actively stop external model dispatch (GLOBAL_STOP).
 * - Explicit falsy values actively allow external model dispatch.
 * - Malformed explicitly supplied values FAIL CLOSED with INVALID_CONTROL_CONFIG
 *   and must never silently permit AI calls.
 */
export function parseGlobalAiStop(
  getEnvVar?: (name: string) => string | undefined,
): GlobalStopConfig {
  if (!getEnvVar) {
    return { stopped: false, malformed: false, stopReason: null };
  }
  const raw = getEnvVar(FLOWPILOT_AI_GLOBAL_STOP_FLAG);
  if (raw === undefined) {
    return { stopped: false, malformed: false, stopReason: null };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { stopped: false, malformed: false, stopReason: null };
  }
  const normalized = trimmed.toLowerCase();
  if (GLOBAL_STOP_ENABLEMENTS.has(normalized)) {
    return { stopped: true, malformed: false, stopReason: "GLOBAL_STOP" };
  }
  if (GLOBAL_STOP_DISABLEMENTS.has(normalized)) {
    return { stopped: false, malformed: false, stopReason: null };
  }
  // Malformed explicitly supplied control value: fail closed
  return {
    stopped: true,
    malformed: true,
    stopReason: "INVALID_CONTROL_CONFIG",
  };
}

export type MaxServingAttemptsConfig = {
  readonly maxAttempts: number;
  readonly malformed: boolean;
  readonly stopReason: AiStopReason | null;
};

/**
 * Parses the operator-configured serving attempt ceiling.
 *
 * Requirements:
 * - Absence defaults to the production upper bound (3 attempts).
 * - Allows a validated operator configuration to LOWER the bound (1 or 2).
 * - Cannot increase beyond the production hard ceiling (3).
 * - Malformed explicit values FAIL CLOSED with INVALID_CONTROL_CONFIG.
 */
export function parseMaxServingAttempts(
  getEnvVar?: (name: string) => string | undefined,
): MaxServingAttemptsConfig {
  if (!getEnvVar) {
    return {
      maxAttempts: DEFAULT_MAX_SERVING_ATTEMPTS,
      malformed: false,
      stopReason: null,
    };
  }
  const raw = getEnvVar(FLOWPILOT_AI_MAX_SERVING_ATTEMPTS_FLAG);
  if (raw === undefined) {
    return {
      maxAttempts: DEFAULT_MAX_SERVING_ATTEMPTS,
      malformed: false,
      stopReason: null,
    };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return {
      maxAttempts: DEFAULT_MAX_SERVING_ATTEMPTS,
      malformed: false,
      stopReason: null,
    };
  }
  const num = Number(trimmed);
  if (
    !Number.isInteger(num) ||
    !Number.isFinite(num) ||
    Number.isNaN(num) ||
    num < 1
  ) {
    return {
      maxAttempts: 0,
      malformed: true,
      stopReason: "INVALID_CONTROL_CONFIG",
    };
  }
  const clamped = Math.min(
    HARD_CEILING_SERVING_ATTEMPTS,
    Math.max(MIN_SERVING_ATTEMPTS, num),
  );
  return {
    maxAttempts: clamped,
    malformed: false,
    stopReason: null,
  };
}

export interface ServingExecutionSession {
  readonly maxAttempts: number;
  readonly deadlineMs: number;
  getDispatchedAttempts(): number;
  getRemainingAttempts(): number;
  getStopReason(): AiStopReason | null;
  canDispatch(): { allowed: boolean; reason: AiStopReason | null };
  recordDispatch(httpAttempts: number): void;
  getRemainingTimeoutMs(configuredTimeoutMs: number): number;
}

export type CreateServingExecutionSessionParams = {
  getEnvVar?: (name: string) => string | undefined;
  getNow?: () => number;
  timeoutMs?: number;
  deadlineMs?: number;
  maxAttemptsOverride?: number;
};

/**
 * Instantiates one request-scoped serving execution session.
 * Tracks physical dispatch allowance and deadline across initial dispatch,
 * internal retries, and secondary fallback.
 */
export function createServingExecutionSession(
  params: CreateServingExecutionSessionParams = {},
): ServingExecutionSession {
  const getNow = params.getNow ?? Date.now;
  const now = getNow();

  const stopConfig = parseGlobalAiStop(params.getEnvVar);
  const attemptsConfig = parseMaxServingAttempts(params.getEnvVar);

  let initialStopReason: AiStopReason | null = null;
  if (stopConfig.malformed || attemptsConfig.malformed) {
    initialStopReason = "INVALID_CONTROL_CONFIG";
  } else if (stopConfig.stopped) {
    initialStopReason = "GLOBAL_STOP";
  }

  // Validate programmatic maxAttemptsOverride if provided
  let validatedOverride: number | undefined = undefined;
  if (params.maxAttemptsOverride !== undefined) {
    const o = params.maxAttemptsOverride;
    if (
      typeof o !== "number" ||
      !Number.isFinite(o) ||
      !Number.isInteger(o) ||
      Number.isNaN(o) ||
      o < 1
    ) {
      initialStopReason = "INVALID_CONTROL_CONFIG";
    } else {
      // Programmatic override is clamped to hard ceiling of 3
      validatedOverride = Math.min(HARD_CEILING_SERVING_ATTEMPTS, o);
    }
  }

  // Max attempts calculation:
  // - If invalid config: 0 attempts
  // - Programmatic override can only tighten the operator limit, never weaken it
  // - Hard ceiling of 3 is strictly enforced across all paths
  const maxAttempts =
    initialStopReason === "INVALID_CONTROL_CONFIG"
      ? 0
      : validatedOverride !== undefined
        ? Math.min(attemptsConfig.maxAttempts, validatedOverride)
        : attemptsConfig.maxAttempts;

  const deadlineMs =
    params.deadlineMs !== undefined
      ? params.deadlineMs
      : params.timeoutMs !== undefined
        ? now + params.timeoutMs
        : now +
          DEFAULT_SERVING_ROUTE_BUDGET_MS -
          SERVING_ROUTE_SAFETY_MARGIN_MS;

  let dispatchedAttempts = 0;
  let activeStopReason: AiStopReason | null = initialStopReason;

  return {
    maxAttempts,
    deadlineMs,
    getDispatchedAttempts(): number {
      return dispatchedAttempts;
    },
    getRemainingAttempts(): number {
      return Math.max(0, maxAttempts - dispatchedAttempts);
    },
    getStopReason(): AiStopReason | null {
      return activeStopReason;
    },
    canDispatch(): { allowed: boolean; reason: AiStopReason | null } {
      if (initialStopReason) {
        return { allowed: false, reason: initialStopReason };
      }
      if (dispatchedAttempts >= maxAttempts) {
        activeStopReason = "ATTEMPT_LIMIT_EXHAUSTED";
        return { allowed: false, reason: "ATTEMPT_LIMIT_EXHAUSTED" };
      }
      if (getNow() >= deadlineMs) {
        activeStopReason = "DEADLINE_EXHAUSTED";
        return { allowed: false, reason: "DEADLINE_EXHAUSTED" };
      }
      return { allowed: true, reason: null };
    },
    recordDispatch(httpAttempts: number): void {
      if (httpAttempts > 0) {
        dispatchedAttempts += httpAttempts;
      }
    },
    getRemainingTimeoutMs(configuredTimeoutMs: number): number {
      const remainingMs = deadlineMs - getNow();
      if (remainingMs <= 0) return 0;
      return Math.min(configuredTimeoutMs, remainingMs);
    },
  };
}
