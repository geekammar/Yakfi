/**
 * Shared OpenAI-compatible HTTP helper (PROMPT-AI-02).
 *
 * Provider specifics (host, auth header) are parameterized — the
 * mapping of HTTP semantics to `AiProviderError` lives here so both
 * adapters share the same taxonomy.
 */
import { parseAiResponse } from "@/features/conversations/server/ai-contract";
import type { AiRequest } from "@/features/conversations/server/ai-contract";

import { buildPromptMessages, buildRequestBody } from "./prompt";
import type { AiProviderError, AiProviderId, AiProviderResult } from "./types";
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
};

function stripJsonFences(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("```")) {
    const withoutOpen = trimmed.replace(/^```(?:json)?\s*/i, "");
    const withoutClose = withoutOpen.replace(/\s*```$/g, "");
    return withoutClose.trim();
  }
  return trimmed;
}

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
  } = params;
  const started = Date.now();
  const apiKey = getEnvVar(secretRef);
  if (!apiKey) {
    return {
      ok: false,
      provider: providerId,
      model,
      latencyMs: Date.now() - started,
      error: {
        code: "CONFIG_ERROR",
        message: `secret ${secretRef} not configured`,
        retryable: false,
      },
    };
  }

  const messages = buildPromptMessages(request);
  const body = buildRequestBody(model, messages);

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
      body: JSON.stringify(body),
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
      error: {
        code: "INVALID_RESPONSE",
        message: "invalid JSON from provider",
        retryable: false,
        httpStatus: httpResponse.status,
      },
    };
  }

  if (!httpResponse.ok) {
    const mapped = mapHttpStatusToError(httpResponse.status, json);
    return { ok: false, provider: providerId, model, latencyMs, error: mapped };
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
  };

  const contentRaw = j?.choices?.[0]?.message?.content;
  if (typeof contentRaw !== "string" || contentRaw.trim().length === 0) {
    return {
      ok: false,
      provider: providerId,
      model,
      latencyMs,
      error: {
        code: "INVALID_RESPONSE",
        message: "empty content from provider",
        retryable: false,
      },
    };
  }

  const stripped = stripJsonFences(contentRaw);
  let parsedContent: unknown;
  try {
    parsedContent = JSON.parse(stripped);
  } catch {
    return {
      ok: false,
      provider: providerId,
      model,
      latencyMs,
      error: {
        code: "INVALID_RESPONSE",
        message: "model did not return JSON",
        retryable: false,
      },
    };
  }

  const validated = parseAiResponse(parsedContent);
  if (!validated) {
    return {
      ok: false,
      provider: providerId,
      model,
      latencyMs,
      error: {
        code: "INVALID_RESPONSE",
        message: "structured output failed validation",
        retryable: false,
      },
    };
  }

  const inputTokens =
    j.usage?.prompt_tokens ?? j.usage?.input_tokens ?? undefined;
  const outputTokens =
    j.usage?.completion_tokens ?? j.usage?.output_tokens ?? undefined;

  return {
    ok: true,
    provider: providerId,
    model,
    latencyMs,
    response: validated,
    inputTokens,
    outputTokens,
  };
}

export function isRetryableResult(result: AiProviderResult): boolean {
  if (result.ok) return false;
  return isRetryableAiError(result.error.code);
}
