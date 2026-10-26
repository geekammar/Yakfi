/**
 * Shared OpenAI-compatible HTTP helper (PROMPT-AI-02).
 *
 * Provider specifics (host, auth header) are parameterized — the
 * mapping of HTTP semantics to `AiProviderError` lives here so both
 * adapters share the same taxonomy.
 */
import type { AiRequest } from "@/features/conversations/server/ai-contract";

import { evaluateResponseCompletion } from "./execution-limits";
import { buildPromptMessages, buildRequestBody } from "./prompt";
import { normalizeResponse } from "./response-normalizer";
import type { NormalizerPolicy } from "./response-normalizer";
import type {
  AiCallOptions,
  AiParseMode,
  AiProviderError,
  AiProviderId,
  AiProviderResult,
} from "./types";
import { isRetryableAiError } from "./types";

export type CallOpenAiCompatibleParams = {
  providerId: AiProviderId;
  model: string;
  secretRef: string;
  endpoint: string;
  getEnvVar: (name: string) => string | undefined;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  request: AiRequest;
  /** Optional provider-specific system-message augmentation (Atria only). */
  extraSystemInstructions?: string;
  /**
   * Optional provider-specific request-body extension, merged AFTER the
   * shared body (PROMPT-AI-OPS-28). The helper stays provider-neutral: it
   * only merges the object, so the OpenRouter `provider` pin is BUILT by the
   * OpenRouter adapter and no routing knowledge lives here. Absent ⇒ the
   * shared body is sent exactly as before.
   */
  extraBody?: Record<string, unknown>;
  /**
   * Optional provider/model-scoped BOUNDED normalization policy
   * (PROMPT-OPS-AI-JSON-NORMALIZATION-ENGINE-09). The engine — not the
   * wiring — decides whether the policy is in scope, and every candidate it
   * produces must still pass strict `JSON.parse()` and the UNCHANGED
   * `aiResponseSchema`. Absent a policy (all providers except Atria today),
   * the shared strict path is byte-for-byte unchanged.
   */
  policy?: NormalizerPolicy;
  /** Optional per-call options (CORE-04B shared session, deadline, signal). */
  options?: AiCallOptions;
};

function mapHttpStatusToError(status: number, body: unknown): AiProviderError {
  const b = body as {
    error?: { message?: string; code?: string | number; type?: string };
  } | null;
  const msg = b?.error?.message ?? `HTTP ${status}`;
  const validStatus =
    typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 300 &&
    status <= 599
      ? status
      : undefined;

  if (status === 401 || status === 402 || status === 403) {
    return {
      code: "CONFIG_ERROR",
      message: msg,
      retryable: false,
      httpStatus: validStatus,
    };
  }
  if (status === 408 || status === 429) {
    return {
      code: "RETRYABLE",
      message: msg,
      retryable: true,
      httpStatus: validStatus,
    };
  }
  if (status >= 500 && status < 600) {
    return {
      code: "RETRYABLE",
      message: msg,
      retryable: true,
      httpStatus: validStatus,
    };
  }
  if (status === 400) {
    const code = b?.error?.code;
    if (code === 429 || code === "rate_limit_exceeded") {
      return {
        code: "RETRYABLE",
        message: msg,
        retryable: true,
        httpStatus: validStatus,
      };
    }
    return {
      code: "PERMANENT",
      message: msg,
      retryable: false,
      httpStatus: validStatus,
    };
  }
  return {
    code: "PERMANENT",
    message: msg,
    retryable: false,
    httpStatus: validStatus,
  };
}

export function parseReportedCost(usage: unknown): number | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const raw = u.cost ?? u.total_cost;
  if (
    typeof raw === "number" &&
    Number.isFinite(raw) &&
    !Number.isNaN(raw) &&
    raw >= 0
  ) {
    return raw;
  }
  return undefined;
}

export async function callOpenAiCompatible(
  params: CallOpenAiCompatibleParams,
): Promise<AiProviderResult> {
  const {
    providerId,
    model,
    secretRef,
    endpoint,
    getEnvVar,
    fetchImpl,
    timeoutMs,
    request,
    extraSystemInstructions,
    extraBody,
    policy,
    options,
  } = params;
  const session = options?.session;
  const nowFn = session ? () => session.getNow() : Date.now;
  const started = nowFn();
  const apiKey = getEnvVar(secretRef);
  if (!apiKey) {
    return {
      ok: false,
      provider: providerId,
      model,
      latencyMs: Date.now() - started,
      httpAttempts: 0,
      error: {
        code: "CONFIG_ERROR",
        message: `secret ${secretRef} not configured`,
        retryable: false,
      },
    };
  }

  // Pre-dispatch session checks (CORE-04B: Global Stop, Allowance, and Deadline)
  if (options?.session) {
    const check = options.session.canDispatch();
    if (!check.allowed) {
      return {
        ok: false,
        provider: providerId,
        model,
        latencyMs: Date.now() - started,
        httpAttempts: 0,
        error: {
          code: "CONTROLLED_FAILURE",
          message: check.reason ?? "execution stopped",
          retryable: false,
        },
      };
    }
  }

  // Bound request timeout by remaining serving deadline (CORE-04B)
  const remainingDeadlineMs = options?.session
    ? options.session.getRemainingTimeoutMs(timeoutMs)
    : options?.timeoutMs !== undefined
      ? Math.min(timeoutMs, options.timeoutMs)
      : timeoutMs;
  const effectiveTimeoutMs = Math.min(timeoutMs, remainingDeadlineMs);

  if (effectiveTimeoutMs <= 0) {
    return {
      ok: false,
      provider: providerId,
      model,
      latencyMs: Date.now() - started,
      httpAttempts: 0,
      error: {
        code: "TIMEOUT",
        message: "deadline exhausted before dispatch",
        retryable: false,
      },
    };
  }

  const messages = buildPromptMessages(request, extraSystemInstructions);
  const body = buildRequestBody(model, messages) as Record<string, unknown>;
  // A provider extension (OpenRouter pin) is merged, never restructured —
  // absent an extension the shared body is serialized exactly as before.
  const requestBody = extraBody ? { ...body, ...extraBody } : body;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), effectiveTimeoutMs);
  const onSignalAbort = () => controller.abort();
  if (options?.signal) {
    if (options.signal.aborted) {
      controller.abort();
    } else {
      options.signal.addEventListener("abort", onSignalAbort, {
        once: true,
      });
    }
  }

  // Reserve/record physical HTTP dispatch immediately before wire call (CORE-04B)
  const dispatchStarted = nowFn();
  if (options?.session) {
    options.session.recordDispatch(1);
  }

  let httpResponse: Response;
  let rawText = "";
  try {
    httpResponse = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    rawText = await httpResponse.text();
  } catch (err) {
    const isAbort =
      controller.signal.aborted ||
      (err instanceof DOMException && err.name === "AbortError") ||
      (err instanceof Error && err.name === "AbortError") ||
      (err instanceof Error && err.message.includes("aborted"));
    if (isAbort) {
      return {
        ok: false,
        provider: providerId,
        model,
        latencyMs: Date.now() - started,
        httpAttempts: 1,
        error: {
          code: "TIMEOUT",
          message: "provider timeout",
          retryable: true,
        },
      };
    }
    return {
      ok: false,
      provider: providerId,
      model,
      latencyMs: Date.now() - started,
      httpAttempts: 1,
      error: {
        code: "RETRYABLE",
        message: err instanceof Error ? err.message : "network error",
        retryable: true,
      },
    };
  } finally {
    clearTimeout(timeout);
    if (options?.signal) {
      options.signal.removeEventListener("abort", onSignalAbort);
    }
  }

  const completedAt = nowFn();
  const latencyMs = completedAt - started;

  // Do not accept a response that completes after the effective deadline or was cancelled
  const completionVerdict = evaluateResponseCompletion({
    startedAtMs: dispatchStarted,
    effectiveTimeoutMs,
    completedAtMs: completedAt,
    session: options?.session,
    signal: options?.signal,
    controllerSignal: controller.signal,
  });

  if (!completionVerdict.ok) {
    return {
      ok: false,
      provider: providerId,
      model,
      latencyMs,
      httpAttempts: 1,
      error: {
        code: "TIMEOUT",
        message: completionVerdict.message,
        retryable: false,
      },
    };
  }

  let json: unknown = null;
  try {
    json = rawText ? JSON.parse(rawText) : null;
  } catch {
    return {
      ok: false,
      provider: providerId,
      model,
      latencyMs,
      httpAttempts: 1,
      error: {
        code: "INVALID_RESPONSE",
        message: "invalid JSON from provider",
        retryable: false,
        httpStatus:
          typeof httpResponse.status === "number" &&
          Number.isInteger(httpResponse.status) &&
          httpResponse.status >= 300 &&
          httpResponse.status <= 599
            ? httpResponse.status
            : undefined,
      },
    };
  }

  const j = json as {
    choices?: Array<{
      message?: { content?: string | null; reasoning?: string };
    }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      input_tokens?: number;
      output_tokens?: number;
    };
    error?: { message?: string };
  } | null;

  const inputTokens =
    j?.usage?.prompt_tokens ?? j?.usage?.input_tokens ?? undefined;
  const outputTokens =
    j?.usage?.completion_tokens ?? j?.usage?.output_tokens ?? undefined;
  const costUsd = parseReportedCost(j?.usage);

  if (!httpResponse.ok) {
    const mapped = mapHttpStatusToError(httpResponse.status, json);
    return {
      ok: false,
      provider: providerId,
      model,
      latencyMs,
      httpAttempts: 1,
      inputTokens,
      outputTokens,
      costUsd,
      error: mapped,
    };
  }

  const contentRaw = j?.choices?.[0]?.message?.content;
  if (typeof contentRaw !== "string" || contentRaw.trim().length === 0) {
    return {
      ok: false,
      provider: providerId,
      model,
      latencyMs,
      httpAttempts: 1,
      inputTokens,
      outputTokens,
      costUsd,
      error: {
        code: "INVALID_RESPONSE",
        message: "empty content from provider",
        retryable: false,
      },
    };
  }

  // ── content normalization: ONE reusable engine, strict-first.
  // Trivial fence stripping, strict JSON.parse(), ONE generic jsonrepair
  // pass, then an optional in-scope bounded provider policy — every
  // candidate is re-parsed by strict JSON.parse() and validated against the
  // UNCHANGED aiResponseSchema. Absent a policy, byte-for-byte the strict
  // path. See response-normalizer/pipeline.ts.
  const normalized = normalizeResponse({
    content: contentRaw,
    provider: providerId,
    model,
    policy,
  });
  if (!normalized.ok) {
    const t = normalized.trace;
    const message = t.strictParseOk
      ? "structured output failed validation"
      : t.genericRepairRan && t.genericRepairProducedCandidate
        ? "model did not return JSON (generic repair schema-invalid)"
        : t.providerRepairRan
          ? "model did not return JSON (bounded normalization rejected)"
          : "model did not return JSON";
    return {
      ok: false,
      provider: providerId,
      model,
      latencyMs,
      httpAttempts: 1,
      inputTokens,
      outputTokens,
      costUsd,
      error: {
        code: "INVALID_RESPONSE",
        message,
        retryable: false,
      },
      normalizerTrace: t,
    };
  }

  const parseMode: AiParseMode = normalized.mode;

  return {
    ok: true,
    provider: providerId,
    model,
    latencyMs,
    httpAttempts: 1,
    response: normalized.value,
    inputTokens,
    outputTokens,
    costUsd,
    parseMode,
    normalizerTrace: normalized.trace,
  };
}

export function isRetryableResult(result: AiProviderResult): boolean {
  if (result.ok) return false;
  return isRetryableAiError(result.error.code);
}

export type CostAggregation = {
  totalCostUsd: number | null;
  knownCostSubtotalUsd: number | null;
  costCompleteness: "COMPLETE" | "PARTIAL" | "UNAVAILABLE";
};

export function computeCostAggregation(
  attempts: Array<{ costUsd?: number | null }>,
): CostAggregation {
  if (attempts.length === 0) {
    return {
      totalCostUsd: null,
      knownCostSubtotalUsd: null,
      costCompleteness: "UNAVAILABLE",
    };
  }
  let knownCount = 0;
  let subtotal = 0;
  for (const a of attempts) {
    if (
      typeof a.costUsd === "number" &&
      Number.isFinite(a.costUsd) &&
      !Number.isNaN(a.costUsd) &&
      a.costUsd >= 0
    ) {
      knownCount += 1;
      subtotal += a.costUsd;
    }
  }
  if (knownCount === attempts.length) {
    return {
      totalCostUsd: subtotal,
      knownCostSubtotalUsd: subtotal,
      costCompleteness: "COMPLETE",
    };
  }
  if (knownCount > 0) {
    return {
      totalCostUsd: null,
      knownCostSubtotalUsd: subtotal,
      costCompleteness: "PARTIAL",
    };
  }
  return {
    totalCostUsd: null,
    knownCostSubtotalUsd: null,
    costCompleteness: "UNAVAILABLE",
  };
}
