/**
 * Shared OpenAI-compatible HTTP helper (PROMPT-AI-02).
 *
 * Provider specifics (host, auth header) are parameterized — the
 * mapping of HTTP semantics to `AiProviderError` lives here so both
 * adapters share the same taxonomy.
 */
import type { AiRequest } from "@/features/conversations/server/ai-contract";

import { buildPromptMessages, buildRequestBody } from "./prompt";
import { normalizeResponse } from "./response-normalizer";
import type { NormalizerPolicy } from "./response-normalizer";
import type {
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
};

function mapHttpStatusToError(status: number, body: unknown): AiProviderError {
  const b = body as {
    error?: { message?: string; code?: string | number; type?: string };
  } | null;
  const msg = b?.error?.message ?? `HTTP ${status}`;
  if (status === 401 || status === 403) {
    return {
      code: "CONFIG_ERROR",
      message: msg,
      retryable: false,
      httpStatus: status,
    };
  }
  if (status === 408 || status === 429) {
    return {
      code: "RETRYABLE",
      message: msg,
      retryable: true,
      httpStatus: status,
    };
  }
  if (status >= 500 && status < 600) {
    return {
      code: "RETRYABLE",
      message: msg,
      retryable: true,
      httpStatus: status,
    };
  }
  if (status === 400) {
    const code = b?.error?.code;
    if (code === 429 || code === "rate_limit_exceeded") {
      return {
        code: "RETRYABLE",
        message: msg,
        retryable: true,
        httpStatus: status,
      };
    }
    return {
      code: "PERMANENT",
      message: msg,
      retryable: false,
      httpStatus: status,
    };
  }
  return {
    code: "PERMANENT",
    message: msg,
    retryable: false,
    httpStatus: status,
  };
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
  } = params;
  const started = Date.now();
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

  const messages = buildPromptMessages(request, extraSystemInstructions);
  const body = buildRequestBody(model, messages) as Record<string, unknown>;
  // A provider extension (OpenRouter pin) is merged, never restructured —
  // absent an extension the shared body is serialized exactly as before.
  const requestBody = extraBody ? { ...body, ...extraBody } : body;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let httpResponse: Response;
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
  } catch (err) {
    clearTimeout(timeout);
    const isAbort =
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
  }

  const latencyMs = Date.now() - started;

  let json: unknown = null;
  let rawText = "";
  try {
    rawText = await httpResponse.text();
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
        httpStatus: httpResponse.status,
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
    parseMode,
    normalizerTrace: normalized.trace,
  };
}

export function isRetryableResult(result: AiProviderResult): boolean {
  if (result.ok) return false;
  return isRetryableAiError(result.error.code);
}
