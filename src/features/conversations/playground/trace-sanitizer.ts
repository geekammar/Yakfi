import type { ScenarioTrace } from "./types";

/**
 * Key names for token counts and metrics that must never be treated as secrets.
 */
const TOKEN_USAGE_KEY_REGEX =
  /^(tokenUsage|tokenUsageEstimate|totalTokens|promptTokens|completionTokens|knownTokensSubtotal|tokenCompleteness|tokens|knownAttemptsCount|unknownAttemptsCount|llmCalls|totalLlmCalls|totalTurns|jevCalls|totalJevCalls)$/i;

/**
 * Sensitive field key patterns that must be redacted.
 * Token usage keys are explicitly excluded by checking TOKEN_USAGE_KEY_REGEX first.
 */
const SENSITIVE_KEY_REGEX =
  /(authorization|api[-_]?key|secret|clientSecret|password|cookie|nonce|claimNonce|claim_nonce|token)/i;

/**
 * Value patterns that match credentials or synthetic tokens in freeform strings.
 */
const BEARER_REGEX = /Bearer\s+([A-Za-z0-9_\-\.]+)/gi;
const SK_KEY_REGEX = /sk-[a-zA-Z0-9_\-\.]+/gi;
const SK_OR_KEY_REGEX = /sk-or-v1-[a-f0-9]+/gi;

/**
 * Recursively scans a trace structure to collect all offer IDs/tokens,
 * claim nonces, and callback payload identifiers that represent sensitive protocol values.
 */
function collectSensitiveIdentifiers(
  value: unknown,
  offerMap: Map<string, string>,
  counterRef: { offer: number; nonce: number },
): void {
  if (value === null || value === undefined) return;

  if (typeof value === "string") {
    // Scan for Telegram/WhatsApp offer callback format: fp:<token>:<action>
    const fpMatches = value.matchAll(
      /fp:([a-zA-Z0-9_\-]+):([1-9]\d?|more|date)/g,
    );
    for (const match of fpMatches) {
      const tok = match[1];
      if (tok && !offerMap.has(tok)) {
        counterRef.offer += 1;
        offerMap.set(tok, `[REDACTED_OFFER_${counterRef.offer}]`);
      }
    }
    // Scan for synthetic tokens
    const offerTokenMatches = value.matchAll(/offer_token_[a-zA-Z0-9_\-]+/g);
    for (const match of offerTokenMatches) {
      const tok = match[0];
      if (tok && !offerMap.has(tok)) {
        counterRef.offer += 1;
        offerMap.set(tok, `[REDACTED_OFFER_${counterRef.offer}]`);
      }
    }
    const nonceMatches = value.matchAll(/claim_nonce_[a-zA-Z0-9_\-]+/g);
    for (const match of nonceMatches) {
      const tok = match[0];
      if (tok && !offerMap.has(tok)) {
        counterRef.nonce += 1;
        offerMap.set(tok, `[REDACTED_NONCE_${counterRef.nonce}]`);
      }
    }
    const secretTokenMatches = value.matchAll(/secret_token_[a-zA-Z0-9_\-]+/g);
    for (const match of secretTokenMatches) {
      const tok = match[0];
      if (tok && !offerMap.has(tok)) {
        counterRef.nonce += 1;
        offerMap.set(tok, `[REDACTED_TOKEN_${counterRef.nonce}]`);
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectSensitiveIdentifiers(item, offerMap, counterRef);
    }
    return;
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      // 1. Offer objects (offer, offerBefore, offerAfter)
      if (
        (k === "offer" || k === "offerBefore" || k === "offerAfter") &&
        v &&
        typeof v === "object"
      ) {
        const off = v as Record<string, unknown>;
        if (typeof off.id === "string" && off.id.trim().length > 0) {
          if (!offerMap.has(off.id)) {
            counterRef.offer += 1;
            offerMap.set(off.id, `[REDACTED_OFFER_${counterRef.offer}]`);
          }
        }
        if (typeof off.token === "string" && off.token.trim().length > 0) {
          if (!offerMap.has(off.token)) {
            counterRef.offer += 1;
            offerMap.set(off.token, `[REDACTED_OFFER_${counterRef.offer}]`);
          }
        }
      }

      // 2. Direct claim nonces
      if (
        (k === "claimNonce" || k === "claim_nonce") &&
        typeof v === "string" &&
        v.trim().length > 0
      ) {
        if (!offerMap.has(v)) {
          counterRef.nonce += 1;
          offerMap.set(v, `[REDACTED_NONCE_${counterRef.nonce}]`);
        }
      }

      // Recurse into nested structures
      collectSensitiveIdentifiers(v, offerMap, counterRef);
    }
  }
}

/**
 * Deeply redact sensitive credentials, tokens, nonces, and secrets from any value.
 * Preserves structural shapes and numeric usage metrics while replacing sensitive content with safe markers.
 */
export function redactValue(
  value: unknown,
  offerMap: Map<string, string>,
  counterRef: { offer: number; nonce: number },
): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    let sanitized = value;

    // Redact bearer tokens
    sanitized = sanitized.replace(BEARER_REGEX, "Bearer [REDACTED]");
    // Redact standard sk- keys
    sanitized = sanitized.replace(SK_OR_KEY_REGEX, "[REDACTED_API_KEY]");
    sanitized = sanitized.replace(SK_KEY_REGEX, "[REDACTED_API_KEY]");
    sanitized = sanitized.replace(
      /test-[a-zA-Z0-9_\-]+-key/g,
      "[REDACTED_TEST_KEY]",
    );

    // Redact mapped sensitive values (offer tokens/ids, nonces)
    // Sort keys by descending length so substrings don't preempt longer matches
    const sortedEntries = Array.from(offerMap.entries()).sort(
      (a, b) => b[0].length - a[0].length,
    );
    for (const [sensitiveVal, replacement] of sortedEntries) {
      if (sanitized.includes(sensitiveVal)) {
        sanitized = sanitized.split(sensitiveVal).join(replacement);
      }
    }

    // Redact any remaining raw fp:<token>:<action> callbacks where token was not pre-registered
    sanitized = sanitized.replace(
      /fp:([a-zA-Z0-9_\-]+):([1-9]\d?|more|date)/g,
      (_match, tok, action) => {
        let replacement = offerMap.get(tok);
        if (!replacement) {
          counterRef.offer += 1;
          replacement = `[REDACTED_OFFER_${counterRef.offer}]`;
          offerMap.set(tok, replacement);
        }
        return `fp:${replacement}:${action}`;
      },
    );

    return sanitized;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, offerMap, counterRef));
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactValue(value.message, offerMap, counterRef),
      stack: value.stack
        ? String(redactValue(value.stack, offerMap, counterRef))
        : undefined,
    };
  }

  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // 1. Token usage and numeric metrics are never redacted
      if (TOKEN_USAGE_KEY_REGEX.test(k)) {
        output[k] = redactValue(v, offerMap, counterRef);
        continue;
      }

      // 2. Sensitive authorization / secret keys
      if (SENSITIVE_KEY_REGEX.test(k)) {
        if (typeof v === "string" && v.trim().length > 0) {
          let stableRef = offerMap.get(v);
          if (!stableRef) {
            counterRef.nonce += 1;
            stableRef = `[REDACTED_SECRET_${counterRef.nonce}]`;
            offerMap.set(v, stableRef);
          }
          output[k] = stableRef;
        } else {
          output[k] = "[REDACTED]";
        }
        continue;
      }

      // 3. Normal properties: recurse
      output[k] = redactValue(v, offerMap, counterRef);
    }
    return output;
  }

  return value;
}

/**
 * Deeply redact a full ScenarioTrace before saving to disk or emitting publicly.
 * Uses a single unified pass with stable local references across turns.
 */
export function redactTrace(trace: ScenarioTrace): ScenarioTrace {
  const offerMap = new Map<string, string>();
  const counterRef = { offer: 0, nonce: 0 };

  // First pass: register known sensitive offer IDs, offer tokens, and nonces
  collectSensitiveIdentifiers(trace, offerMap, counterRef);

  // Second pass: deep redaction using the registered stable references
  return redactValue(trace, offerMap, counterRef) as ScenarioTrace;
}
