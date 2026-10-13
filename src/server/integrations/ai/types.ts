/**
 * AI provider adapter types (PROMPT-AI-02).
 *
 * The `ConversationAi` contract stays provider-neutral
 * (`AiRequest -> AiResponse`). Provider specifics (HTTP shape,
 * auth, error mapping, token counts) live only in the adapters
 * below — never in Core/Engine/Domain.
 */
import type {
  AiRequest,
  AiResponse,
} from "@/features/conversations/server/ai-contract";

import type { ConversationControlOutcome } from "./conversation-control/types";
import type { JevSemanticEvidence } from "./jev-semantic-strategy";
import type { JevDecisionMode, JevDecisionReason } from "./jev-strategy";
import type { NormalizerTrace } from "./response-normalizer/types";

export type AiProviderId = "openrouter" | "agentrouter" | "atria" | "codecraft";

/** Provider call outcome taxonomy (minimum spec). */
export type AiProviderErrorCode =
  | "RETRYABLE"
  | "PERMANENT"
  | "TIMEOUT"
  | "INVALID_RESPONSE"
  | "CONFIG_ERROR"
  | "CONTROLLED_FAILURE";

export type AiProviderError = {
  code: AiProviderErrorCode;
  message: string;
  retryable: boolean;
  httpStatus?: number;
};

/**
 * How a provider response's JSON content was accepted
 * (PROMPT-OPS-AI-JSON-NORMALIZATION-ENGINE-09). Mirrors the normalization
 * engine's stages 1–3 exactly:
 * - `DIRECT_PARSE`            — strict `JSON.parse()` + `aiResponseSchema`
 *                               accepted on the first path; no repair ran.
 * - `GENERIC_REPAIRED_PARSE`  — strict failed; ONE generic `jsonrepair` pass
 *                               produced a candidate that re-parsed AND
 *                               passed the unchanged `aiResponseSchema`.
 * - `BOUNDED_PROVIDER_REPAIR` — generic repair was not enough; an
 *                               in-scope provider/model policy rule produced
 *                               a candidate that re-parsed AND passed the
 *                               unchanged `aiResponseSchema`.
 * Failures carry no parseMode — they are classified by `INVALID_RESPONSE`
 * (or another error code) on `AiProviderFailure`.
 */
export type AiParseMode =
  "DIRECT_PARSE" | "GENERIC_REPAIRED_PARSE" | "BOUNDED_PROVIDER_REPAIR";

export function isRetryableAiError(code: AiProviderErrorCode): boolean {
  return code === "RETRYABLE" || code === "TIMEOUT";
}

export type AiProviderSuccess = {
  ok: true;
  response: AiResponse;
  provider: AiProviderId;
  model: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  /** How the content JSON was accepted. Absent on failures. */
  parseMode?: AiParseMode;
  /** Sanitized structural trace (shape statistics only; never content). */
  normalizerTrace?: NormalizerTrace;
  /**
   * Sanitized attempt-level trace of the bounded retry, produced by the
   * provider-agnostic Conversation Control Layer
   * (PROMPT-OPS-CONVERSATION-CONTROL-RETRY-HANDOFF-15). Present when the
   * adapter is wrapped by Conversation Control; counters/classifications/
   * timings only.
   */
  retryTrace?: AiRetryTrace;
  /** Conversation Control outcome (handoff/notification decisions), when wrapped. */
  conversationControl?: ConversationControlOutcome;
};

export type AiProviderFailure = {
  ok: false;
  error: AiProviderError;
  provider: AiProviderId;
  model: string;
  latencyMs: number;
  /**
   * Sanitized structural trace of the content normalization attempt, when the
   * failure is content-related (shape statistics + rejection reason only;
   * never content, keys, values, secrets, or headers).
   */
  normalizerTrace?: NormalizerTrace;
  /** See {@link AiProviderSuccess.retryTrace}. */
  retryTrace?: AiRetryTrace;
  /** Conversation Control outcome (handoff/notification decisions), when wrapped. */
  conversationControl?: ConversationControlOutcome;
};

export type AiProviderResult = AiProviderSuccess | AiProviderFailure;

export interface AiProviderAdapter {
  readonly providerId: AiProviderId;
  readonly model: string;
  readonly secretRef: string;
  call(request: AiRequest): Promise<AiProviderResult>;
}

export type AiTelemetryAttempt = {
  provider: string;
  model: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  status: "SUCCESS" | "FAILURE";
  errorCode?: AiProviderErrorCode;
};

// ─── Bounded retry trace (owned by the Conversation Control Layer) ────────
// Fully sanitized attempt-level trace. Carries ONLY classification codes,
// counters and timings — never API keys, Authorization headers, DATABASE_URL,
// raw provider response bodies, or customer message content.
// Produced by conversation-control/conversation-control.ts, never by a
// provider adapter (PROMPT-OPS-CONVERSATION-CONTROL-RETRY-HANDOFF-15).

/** One physical provider call inside one logical AI turn. */
export type AiRetryAttemptRecord = {
  /** 1-based physical attempt number within the logical AI turn. */
  attempt: number;
  outcome: "SUCCESS" | "FAILURE";
  /** Sanitized failure classification (never a provider message/body). */
  errorCode?: AiProviderErrorCode;
  latencyMs: number;
};

/**
 * Why a retry was (or was not) attempted. `NONE` = no retry was considered
 * (first attempt was the last). Every other value is a positive skip reason.
 */
export type AiRetrySkipReason =
  | "NONE"
  | "DISABLED"
  | "MAX_ATTEMPTS_REACHED"
  | "NON_RETRYABLE_CLASSIFICATION"
  | "HUMAN_REQUEST"
  | "INSUFFICIENT_DEADLINE";

export type AiRetryTrace = {
  provider: AiProviderId;
  /** Hard bound on physical attempts for one logical AI turn. */
  maxAttempts: number;
  /** One record per physical provider call. */
  attempts: AiRetryAttemptRecord[];
  /** True iff at least one retry was actually started. */
  retryAttempted: boolean;
  /** The sanitized classification that triggered the retry, if any. */
  retryTriggerCode: AiProviderErrorCode | null;
  /** Why no retry happened. `NONE` when a retry ran. */
  retrySkippedReason: AiRetrySkipReason;
  /** Absolute epoch-ms deadline for the whole logical AI turn. */
  deadlineMs: number;
  /** Per-attempt timeout actually used for the second attempt. */
  retryTimeoutMs: number;
  finalOutcome: "SUCCESS" | "FAILURE";
  /** Wall-clock for the whole logical AI turn (all attempts). */
  totalElapsedMs: number;
};

export type AiTelemetry = {
  attempts: AiTelemetryAttempt[];
  fallbackUsed: boolean;
  finalProvider: string;
  finalModel: string | null;
  finalStatus: "SUCCESS" | "FAILURE";
  /**
   * Sanitized attempt-level trace of the bounded retry, when the logical
   * AI turn went through the Conversation Control Layer
   * (PROMPT-OPS-CONVERSATION-CONTROL-RETRY-HANDOFF-15). Counters/
   * classifications/timings only — no keys, headers, DATABASE_URL, raw
   * provider bodies, or customer content.
   */
  retryTrace?: AiRetryTrace;
  /**
   * The Conversation Control outcome (handoff reason, canonical handoff
   * message, sanitized notifications) for the logical turn, when the
   * primary adapter was wrapped by the control layer. Observability only —
   * the engine remains the executor of any state transition.
   */
  conversationControl?: ConversationControlOutcome;
  /**
   * The JEV decision the gateway strategy made for this turn
   * (PROMPT-AI-ARCH-17 — Slice 8). Present only when a JEV strategy was
   * configured. Closed machine keys only (`mode` / `reason`) — never content,
   * provider identity, or chain-of-thought. A `DETERMINISTIC` mode means the
   * strategy terminated the turn and NO provider call was spent (see
   * `finalProvider === "jev-deterministic"`).
   */
  jevDecision?: {
    readonly mode: JevDecisionMode;
    readonly reason: JevDecisionReason;
    /**
     * The semantic evidence block (PROMPT-AI-JEV-03B §12). Present only when a
     * semantic JEV strategy was configured AND produced a reading for this
     * turn — closed machine keys only: derived facts, sanitized probabilities,
     * the shared precedence derivation, the contact-vs-book boundary and the
     * resolver signals. Never content, provider raw output, secrets, or
     * chain-of-thought.
     */
    readonly semantic?: JevSemanticEvidence;
  };
};
