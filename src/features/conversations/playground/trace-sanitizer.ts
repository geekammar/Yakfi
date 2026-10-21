import type { ScenarioTrace } from "./types";

/**
 * Sensitive field key patterns that must be redacted.
 */
const SENSITIVE_KEY_REGEX =
  /(authorization|api[-_]?key|token|secret|clientSecret|password|cookie|nonce)/i;

/**
 * Value patterns that match credentials, secrets, or nonces in freeform strings.
 */
const BEARER_REGEX = /Bearer\s+([A-Za-z0-9_\-\.]+)/gi;
const SK_KEY_REGEX = /sk-[a-zA-Z0-9_\-\.]+/gi;
const SK_OR_KEY_REGEX = /sk-or-v1-[a-f0-9]+/gi;
const CLAIM_NONCE_REGEX = /claim_nonce_[a-zA-Z0-9_\-]+/gi;
const SECRET_TOKEN_REGEX = /secret_token_[a-zA-Z0-9_\-]+/gi;
const OFFER_TOKEN_REGEX = /offer_token_[a-zA-Z0-9_\-]+/gi;

/**
 * Deeply redact sensitive credentials, tokens, nonces, and secrets from any value.
 * Preserves structural shapes while replacing sensitive content with safe markers.
 */
export function redactValue(
  value: unknown,
  stableMap = new Map<string, string>(),
  counterRef = { counter: 0 },
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
    // Redact secret tokens
    sanitized = sanitized.replace(SECRET_TOKEN_REGEX, (match) => {
      let ref = stableMap.get(match);
      if (!ref) {
        counterRef.counter += 1;
        ref = `[REDACTED_TOKEN_${counterRef.counter}]`;
        stableMap.set(match, ref);
      }
      return ref;
    });
    // Redact claim nonces
    sanitized = sanitized.replace(CLAIM_NONCE_REGEX, (match) => {
      let ref = stableMap.get(match);
      if (!ref) {
        counterRef.counter += 1;
        ref = `[REDACTED_NONCE_${counterRef.counter}]`;
        stableMap.set(match, ref);
      }
      return ref;
    });
    // Redact offer tokens
    sanitized = sanitized.replace(OFFER_TOKEN_REGEX, (match) => {
      let ref = stableMap.get(match);
      if (!ref) {
        counterRef.counter += 1;
        ref = `[REDACTED_OFFER_TOKEN_${counterRef.counter}]`;
        stableMap.set(match, ref);
      }
      return ref;
    });
    // Redact placeholder test keys if present
    sanitized = sanitized.replace(
      /test-[a-zA-Z0-9_\-]+-key/g,
      "[REDACTED_TEST_KEY]",
    );
    return sanitized;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, stableMap, counterRef));
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactValue(value.message, stableMap, counterRef),
      stack: value.stack
        ? String(redactValue(value.stack, stableMap, counterRef))
        : undefined,
    };
  }

  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_REGEX.test(k)) {
        if (typeof v === "string" && v.trim().length > 0) {
          let stableRef = stableMap.get(v);
          if (!stableRef) {
            counterRef.counter += 1;
            const normalizedKey = k.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
            stableRef = `[REDACTED_${normalizedKey}_${counterRef.counter}]`;
            stableMap.set(v, stableRef);
          }
          output[k] = stableRef;
        } else {
          output[k] = "[REDACTED]";
        }
      } else {
        output[k] = redactValue(v, stableMap, counterRef);
      }
    }
    return output;
  }

  return value;
}

/**
 * Deeply redact a full ScenarioTrace before saving to disk or emitting publicly.
 */
export function redactTrace(trace: ScenarioTrace): ScenarioTrace {
  const stableMap = new Map<string, string>();
  const counterRef = { counter: 0 };
  return redactValue(trace, stableMap, counterRef) as ScenarioTrace;
}
