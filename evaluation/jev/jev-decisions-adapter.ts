/**
 * FlowPilot AI Evaluation — REAL TypeSafe Jev adapter, OpenRouter Decisions
 * API (PROMPT-AI-JEV-01).
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  EVALUATION-ONLY. NEVER IMPORTED BY src/. NOT WIRED INTO PRODUCTION.  │
 * │  This module makes REAL external model calls when a credential is     │
 * │  present, and performs NO customer messaging, NO booking mutation,    │
 * │  NO database write and NO production routing change.                  │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * PURPOSE
 * A provider-neutral adapter for the REAL TypeSafe Jev model, reached through
 * OpenRouter's Decisions API. It isolates everything vendor-specific behind
 * one seam so the benchmark, the fixture bank and the reporting never learn
 * which vendor answered:
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │ JevEvaluationRequest (provider-neutral, FlowPilot-owned)         │
 *   │   state + atomic questions                                       │
 *   └───────────────────────────────┬──────────────────────────────────┘
 *                                   ▼
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │ THIS ADAPTER                                                     │
 *   │  · provider/model identifier (PINNED, never an alias)            │
 *   │  · request mapping  → DecisionsRequest ({state, questions})      │
 *   │  · response mapping ← DecisionsResponse (typed answers + probs)  │
 *   │  · timeout / error handling (AbortController + status taxonomy)  │
 *   │  · usage / cost metadata (input_tokens, output_tokens, cost)     │
 *   └───────────────────────────────┬──────────────────────────────────┘
 *                                   ▼
 *   POST https://openrouter.ai/api/alpha/decisions
 *   Authorization: Bearer $OPENROUTER_API_KEY   (read by NAME, never stored)
 *
 * WHY A DECISIONS-API ADAPTER AND NOT A CHAT ADAPTER
 * Jev is a System One structured decision model, NOT a prose generator. The
 * OpenRouter `/chat/completions` surface is the WRONG contract for it: Jev
 * does not generate text, does not return reasoning, and cannot be coaxed
 * into a typed answer through a prompt. OpenRouter exposes it through the
 * dedicated Decisions endpoint (`POST /api/alpha/decisions`), which takes a
 * `state` object plus typed `questions` (Noul / Choice / Score) and returns
 * typed answers with probability distributions directly. Sending Jev a
 * chat-completions payload would not be a real Jev call.
 *
 * CREDENTIALS
 * The adapter reads ONE secret by NAME through the same server-side convention
 * every FlowPilot provider adapter uses (`getEnvVar(secretRef)` at call time).
 * The default is `OPENROUTER_API_KEY` — the existing project mechanism. A
 * separate TypeSafe key is NOT required: OpenRouter authenticates Jev with
 * the same OpenRouter key. The value is never held on the adapter, never
 * logged, never serialized into a result, and never returned to a caller; a
 * missing credential fails closed with `JevErrorCode.MISSING_CREDENTIAL`
 * before any network I/O.
 *
 * MODEL PINNING (binding for reproducibility)
 * The PRIMARY measured model is the PINNED release `typesafe/jev-1.13`, never
 * the `~typesafe/jev-latest` alias. An alias can be re-pointed to a newer Jev
 * release at any time, which would silently invalidate every longitudinal
 * threshold and benchmark comparison built on top of it. The response's
 * `model` field names the DATED SNAPSHOT that actually served the request
 * (e.g. `typesafe/jev-1.13-20260917`); the adapter records BOTH the requested
 * id and the served snapshot so a run is always reconstructable.
 */

// ─── 1. The provider-neutral evaluation request (FlowPilot-owned) ───────────

/**
 * One atomic Jev question, expressed provider-neutrally. The three Jev
 * primitives, named for what they ASK rather than how a vendor spells them:
 *
 *  - `noul`:   "Is this statement true?" → a probability of yes (0–1). Use
 *              for every independent boolean semantic fact. Preferred: a
 *              Noul is evaluated in isolation and cannot interfere with
 *              another question's answer.
 *  - `choice`: "Which ONE of these bounded, mutually-exclusive options?"
 *              → the selected option + a probability per option + a
 *              confidence. Use ONLY where the alternatives are genuinely
 *              bounded and mutually meaningful.
 *  - `score`:  "Where does this fall on this ORDERED scale?" → a
 *              probability-weighted position + confidence. Use ONLY where an
 *              ordered scale adds evidence a boolean cannot.
 *
 * INVARIANT: each question must be ATOMIC and INDEPENDENT. Never ask one
 * question whose answer depends on another question's answer — compose those
 * in CODE instead. The server precedence contract is deliberately NOT a
 * question here; Jev supplies semantic FACTS and the server owns precedence.
 */
export type JevQuestion =
  | {
      readonly type: "noul";
      /** The plain yes/no statement to evaluate against the state. */
      readonly instructions: string;
      /**
       * Optional criteria describing what TRUE and FALSE mean here. Keeping
       * these short and behavioural (not lexical) is what keeps a question
       * atomic and stops it from becoming a dialect dictionary entry.
       */
      readonly criteria?: { readonly true: string; readonly false: string };
    }
  | {
      readonly type: "choice";
      readonly instructions: string;
      /** Bounded, mutually-exclusive options keyed by a short stable id. */
      readonly criteria: Readonly<Record<string, string>>;
    }
  | {
      readonly type: "score";
      readonly instructions: string;
      /** Ordered levels, first element is index 0. */
      readonly criteria: ReadonlyArray<string>;
    };

/**
 * The provider-neutral evaluation request: the state to evaluate plus the
 * atomic questions about it. All questions are evaluated against the SAME
 * state, in parallel, in ONE request — so independent facts cost ONE call.
 */
export type JevEvaluationRequest = {
  /** The state under evaluation (the turn text + bounded structured context). */
  readonly state: JevState;
  /** Atomic, independent questions. */
  readonly questions: Readonly<Record<string, JevQuestion>>;
};

/**
 * The state sent to Jev. Deliberately SMALL and SEMANTIC: only the fields a
 * decision needs, so the model is not asked to reason about engine internals,
 * telemetry, tenant ids or anything customer-identifying. Business context is
 * included ONLY where a question genuinely cannot be answered without it
 * (a service/price question needs to know what the business actually offers).
 */
export type JevState = {
  /** The customer's message text, verbatim. The primary object of evaluation. */
  readonly customerMessage: string;
  readonly businessName: string;
  /** Service names, so a service/price question is answerable in closed world. */
  readonly services: ReadonlyArray<string>;
  /** FAQ questions, so a knowledge question is answerable in closed world. */
  readonly faqs: ReadonlyArray<string>;
  /** A neutral language hint (never a dialect dictionary). */
  readonly languageHint: string;
};

// ─── 2. The provider-neutral evaluation result ──────────────────────────────

/** The typed answer to one question, in provider-neutral terms. */
export type JevAnswer =
  | { readonly type: "noul"; readonly noul: number }
  | {
      readonly type: "choice";
      readonly choice: string;
      readonly confidence: number | null;
      readonly probabilities: Readonly<Record<string, number>>;
    }
  | {
      readonly type: "score";
      readonly score: number;
      readonly confidence: number | null;
      readonly probabilities: Readonly<Record<string, number>>;
    };

/** The full provider-neutral result of one Jev request. */
export type JevEvaluationResult = {
  /** The model id the adapter REQUESTED (the pinned release). */
  readonly requestedModel: string;
  /** The dated snapshot the provider actually SERVED (from the response). */
  readonly servedModel: string | null;
  /** The provider name the endpoint reported (e.g. `TypeSafe`). */
  readonly provider: string | null;
  /** One typed answer per requested question key. */
  readonly answers: Record<string, JevAnswer>;
  /** Token + cost accounting, exactly as the endpoint reported it. */
  readonly usage: JevUsage;
  /** Wall-clock round trip in milliseconds. */
  readonly latencyMs: number;
  /** True when the request errored (see `errorCode`); answers are then empty. */
  readonly ok: boolean;
  readonly errorCode: JevErrorCode | null;
  readonly errorMessage: string | null;
  /** The endpoint request id, when the endpoint returned one. */
  readonly requestId: string | null;
};

export type JevUsage = {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /** The USD cost the endpoint reported for THIS response. */
  readonly cost: number | null;
};

/**
 * A closed error taxonomy so a benchmark can account for failures without
 * leaking vendor payload. `retryable` marks the statuses a bounded retry may
 * re-attempt; everything else fails immediately.
 */
export const jevErrorCodeValues = [
  /** The OpenRouter credential is absent. NO network I/O happens. */
  "MISSING_CREDENTIAL",
  /** HTTP 400 — the request body did not satisfy the Decisions schema. */
  "BAD_REQUEST",
  /** HTTP 401/403 — the credential was rejected or lacks permission. */
  "AUTH_FAILED",
  /** HTTP 402 — the account has insufficient credits. */
  "INSUFFICIENT_CREDITS",
  /** HTTP 404 — the pinned model id is not served. */
  "MODEL_NOT_FOUND",
  /** HTTP 413 — the state + questions exceed the request size limit. */
  "PAYLOAD_TOO_LARGE",
  /** HTTP 429 — rate limited; retryable. */
  "RATE_LIMITED",
  /** A response that did not validate against the documented answer schema. */
  "INVALID_RESPONSE",
  /** The endpoint returned no usable answer body. */
  "EMPTY_RESPONSE",
  /** Request exceeded the timeout; retryable. */
  "TIMEOUT",
  /** Network-level failure (DNS/connection/abort); retryable. */
  "NETWORK",
  /** HTTP 5xx / 524 / 529 — the provider or edge failed; retryable. */
  "PROVIDER",
] as const;

export type JevErrorCode = (typeof jevErrorCodeValues)[number];

const RETRYABLE_CODES: ReadonlySet<JevErrorCode> = new Set([
  "RATE_LIMITED",
  "TIMEOUT",
  "NETWORK",
  "PROVIDER",
]);

export function isRetryableJevError(code: JevErrorCode | null): boolean {
  return code !== null && RETRYABLE_CODES.has(code);
}

// ─── 3. The vendor contract (typed from the documented Decisions schema) ────

export const JEV_DECISIONS_ENDPOINT =
  "https://openrouter.ai/api/alpha/decisions";

/**
 * The PINNED primary model. Deliberately NOT the `~typesafe/jev-latest`
 * alias: an alias is a moving target and would invalidate longitudinal
 * comparisons. This constant is the single source of truth for the measured
 * model id; the adapter never accepts an alias as the primary.
 */
export const JEV_PINNED_MODEL = "typesafe/jev-1.13";

/**
 * The alias, exposed ONLY for the optional secondary comparison column. It is
 * never the primary measured model; a run that measures the alias is recorded
 * as such and is NOT comparable to a pinned run.
 */
export const JEV_ALIAS_MODEL = "~typesafe/jev-latest";

/** The secret NAME the adapter reads. The project's existing convention. */
export const JEV_SECRET_REF = "OPENROUTER_API_KEY";

/** Bounded request timeout. Jev answers in well under a second; 15s is generous. */
export const JEV_TIMEOUT_MS = 15_000;

/** Bounded retries for retryable statuses only (never for auth/config errors). */
export const JEV_MAX_ATTEMPTS = 3;

type DecisionsNoulQuestion = {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
};
type DecisionsChoiceQuestion = {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
};
type DecisionsScoreQuestion = {
  type: "score";
  instructions: string;
  criteria: string[];
};
type DecisionsQuestion =
  DecisionsNoulQuestion | DecisionsChoiceQuestion | DecisionsScoreQuestion;

type DecisionsRequest = {
  model: string;
  state: unknown;
  questions: Record<string, DecisionsQuestion>;
  provider?: Record<string, unknown>;
};

type DecisionsNoulAnswer = { type: "noul"; noul: number };
type DecisionsChoiceAnswer = {
  type: "choice";
  choice: string;
  confidence?: number;
  probabilities?: Record<string, number>;
};
type DecisionsScoreAnswer = {
  type: "score";
  score: number;
  confidence?: number;
  probabilities?: Record<string, number>;
  legend?: Record<string, string>;
};
type DecisionsAnswer =
  DecisionsNoulAnswer | DecisionsChoiceAnswer | DecisionsScoreAnswer;

type DecisionsResponse = {
  id?: string;
  model: string;
  provider?: string;
  answers: Record<string, DecisionsAnswer>;
  usage: { input_tokens: number; output_tokens: number; cost?: number };
};

// ─── 4. Request mapping (provider-neutral → vendor) ─────────────────────────

/**
 * Map the FlowPilot-owned state to the vendor `state` object. Structured form
 * (not a free string): the documented Decisions schema accepts an object, and
 * keyed fields let each question reference exactly the context it needs. The
 * keys are deliberately semantic so a question's `instructions` can name them.
 */
function mapState(state: JevState): Record<string, unknown> {
  return {
    customer_message: state.customerMessage,
    business_name: state.businessName,
    services: state.services,
    faqs: state.faqs,
    language_hint: state.languageHint,
  };
}

function mapQuestion(question: JevQuestion): DecisionsQuestion {
  switch (question.type) {
    case "noul":
      return question.criteria
        ? {
            type: "noul",
            instructions: question.instructions,
            criteria: {
              true: question.criteria.true,
              false: question.criteria.false,
            },
          }
        : { type: "noul", instructions: question.instructions };
    case "choice":
      return {
        type: "choice",
        instructions: question.instructions,
        criteria: { ...question.criteria },
      };
    case "score":
      return {
        type: "score",
        instructions: question.instructions,
        criteria: [...question.criteria],
      };
  }
}

function buildDecisionsRequestBody(
  request: JevEvaluationRequest,
  model: string,
): DecisionsRequest {
  const body: DecisionsRequest = {
    model,
    state: mapState(request.state),
    questions: Object.fromEntries(
      Object.entries(request.questions).map(([key, q]) => [
        key,
        mapQuestion(q),
      ]),
    ),
  };
  return body;
}

// ─── 5. Response mapping (vendor → provider-neutral) ────────────────────────

function mapAnswer(answer: DecisionsAnswer): JevAnswer | null {
  switch (answer.type) {
    case "noul":
      if (typeof answer.noul !== "number" || Number.isNaN(answer.noul))
        return null;
      return { type: "noul", noul: answer.noul };
    case "choice":
      if (typeof answer.choice !== "string") return null;
      return {
        type: "choice",
        choice: answer.choice,
        confidence:
          typeof answer.confidence === "number" ? answer.confidence : null,
        probabilities: answer.probabilities ?? {},
      };
    case "score":
      if (typeof answer.score !== "number" || Number.isNaN(answer.score))
        return null;
      return {
        type: "score",
        score: answer.score,
        confidence:
          typeof answer.confidence === "number" ? answer.confidence : null,
        probabilities: answer.probabilities ?? {},
      };
    default:
      return null;
  }
}

function classifyHttpStatus(status: number): JevErrorCode {
  if (status === 400) return "BAD_REQUEST";
  if (status === 401 || status === 403) return "AUTH_FAILED";
  if (status === 402) return "INSUFFICIENT_CREDITS";
  if (status === 404) return "MODEL_NOT_FOUND";
  if (status === 413) return "PAYLOAD_TOO_LARGE";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "PROVIDER";
  return "PROVIDER";
}

// ─── 6. The adapter ─────────────────────────────────────────────────────────

export type JevAdapterDeps = {
  /**
   * Reads a secret by NAME at call time — the same injected convention every
   * FlowPilot provider adapter takes. The adapter NEVER holds the value and
   * NEVER logs it.
   */
  readonly getEnvVar: (name: string) => string | undefined;
  readonly fetchImpl: typeof fetch;
  readonly endpoint?: string;
  /** Override the pinned model ONLY for a recorded secondary comparison. */
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
};

export type JevAdapter = {
  /** Stable adapter identity for the run manifest (never a secret). */
  readonly adapterId: string;
  /** The model id this adapter requests. */
  readonly model: string;
  /** The secret NAME it reads (never the value). */
  readonly secretRef: string;
  /**
   * Evaluate one provider-neutral request. NEVER throws: a failure is
   * returned as `{ ok: false, errorCode }` so one bad fixture can never abort
   * a benchmark run.
   */
  evaluate(request: JevEvaluationRequest): Promise<JevEvaluationResult>;
};

export function createJevAdapter(deps: JevAdapterDeps): JevAdapter {
  const model = deps.model?.trim() || JEV_PINNED_MODEL;
  const endpoint = deps.endpoint ?? JEV_DECISIONS_ENDPOINT;
  const timeoutMs = deps.timeoutMs ?? JEV_TIMEOUT_MS;
  const maxAttempts = Math.max(1, deps.maxAttempts ?? JEV_MAX_ATTEMPTS);
  const adapterId = `jev-decisions/${model}`;

  return {
    adapterId,
    model,
    secretRef: JEV_SECRET_REF,

    async evaluate(
      request: JevEvaluationRequest,
    ): Promise<JevEvaluationResult> {
      const started = Date.now();

      // ── Credential gate: fails closed BEFORE any network I/O. ──────────
      const apiKey = deps.getEnvVar(JEV_SECRET_REF);
      if (!apiKey || apiKey.trim().length === 0) {
        return {
          requestedModel: model,
          servedModel: null,
          provider: null,
          answers: {},
          usage: {
            inputTokens: null,
            outputTokens: null,
            cost: null,
          },
          latencyMs: Date.now() - started,
          ok: false,
          errorCode: "MISSING_CREDENTIAL",
          errorMessage: `secret ${JEV_SECRET_REF} is not configured; no external model call was attempted`,
          requestId: null,
        };
      }

      const body = buildDecisionsRequestBody(request, model);
      const payload = JSON.stringify(body);

      let lastCode: JevErrorCode | null = null;
      let lastMessage: string | null = null;
      let attempts = 0;

      while (attempts < maxAttempts) {
        attempts += 1;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await deps.fetchImpl(endpoint, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: payload,
            signal: controller.signal,
          });

          const text = await response.text();
          if (!response.ok) {
            lastCode = classifyHttpStatus(response.status);
            lastMessage =
              extractErrorMessage(text) ?? `HTTP ${response.status}`;
            // Non-retryable: stop immediately, do not spend another call.
            if (!isRetryableJevError(lastCode)) break;
            await backoff(attempts);
            continue;
          }

          // ── Response validation (strict; never trust an unvalidated body) ─
          const parsed = safeParseJson(text);
          if (parsed === null) {
            lastCode = "INVALID_RESPONSE";
            lastMessage = "response body is not valid JSON";
            break;
          }
          const validated = validateDecisionsResponse(parsed);
          if (validated === null) {
            lastCode = "INVALID_RESPONSE";
            lastMessage =
              "response does not match the documented Decisions schema";
            break;
          }

          const answers: Record<string, JevAnswer> = {};
          let rejected = 0;
          for (const key of Object.keys(request.questions)) {
            const raw = validated.answers[key];
            if (raw === undefined) {
              rejected += 1;
              continue;
            }
            const mapped = mapAnswer(raw);
            if (mapped === null) {
              rejected += 1;
              continue;
            }
            answers[key] = mapped;
          }
          // An answer set that is empty or short of what was asked is not
          // usable evidence — fail closed rather than silently scoring gaps.
          if (Object.keys(answers).length === 0 || rejected > 0) {
            lastCode = "EMPTY_RESPONSE";
            lastMessage = `${rejected} of ${Object.keys(request.questions).length} questions had no usable answer`;
            break;
          }

          return {
            requestedModel: model,
            servedModel: validated.model,
            provider: validated.provider ?? null,
            answers,
            usage: {
              inputTokens: validated.usage.input_tokens,
              outputTokens: validated.usage.output_tokens,
              cost:
                typeof validated.usage.cost === "number"
                  ? validated.usage.cost
                  : null,
            },
            latencyMs: Date.now() - started,
            ok: true,
            errorCode: null,
            errorMessage: null,
            requestId: validated.id ?? null,
          };
        } catch (err) {
          // Distinguish a timeout abort from any other network failure.
          if (controller.signal.aborted) {
            lastCode = "TIMEOUT";
            lastMessage = `request exceeded ${timeoutMs}ms`;
          } else {
            lastCode = "NETWORK";
            lastMessage = describeError(err);
          }
          if (!isRetryableJevError(lastCode) || attempts >= maxAttempts) break;
          await backoff(attempts);
        } finally {
          clearTimeout(timer);
        }
      }

      return {
        requestedModel: model,
        servedModel: null,
        provider: null,
        answers: {},
        usage: { inputTokens: null, outputTokens: null, cost: null },
        latencyMs: Date.now() - started,
        ok: false,
        errorCode: lastCode,
        errorMessage: lastMessage,
        requestId: null,
      };
    },
  };
}

// ─── 7. Helpers (strict, total, no I/O) ─────────────────────────────────────

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate the response against the documented Decisions schema. Deliberately
 * hand-written (no new dependency): the shape is small, and validating it
 * here is what lets the benchmark reject an unexpected vendor change instead
 * of scoring garbage as a Jev answer.
 */
function validateDecisionsResponse(value: unknown): DecisionsResponse | null {
  if (!isObject(value)) return null;
  const model = value["model"];
  const answers = value["answers"];
  const usage = value["usage"];
  if (typeof model !== "string" || model.length === 0) return null;
  if (!isObject(answers)) return null;
  if (!isObject(usage)) return null;
  const inputTokens = usage["input_tokens"];
  const outputTokens = usage["output_tokens"];
  if (typeof inputTokens !== "number") return null;
  if (typeof outputTokens !== "number") return null;
  if (value["provider"] !== undefined && typeof value["provider"] !== "string")
    return null;
  if (value["id"] !== undefined && typeof value["id"] !== "string") return null;
  if (usage["cost"] !== undefined && typeof usage["cost"] !== "number")
    return null;

  const out: DecisionsResponse = {
    model,
    answers: {},
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost: typeof usage["cost"] === "number" ? usage["cost"] : undefined,
    },
  };
  if (typeof value["id"] === "string") out.id = value["id"];
  if (typeof value["provider"] === "string") out.provider = value["provider"];

  for (const key of Object.keys(answers)) {
    const a = answers[key];
    if (!isObject(a)) continue;
    const type = a["type"];
    if (type === "noul") {
      if (typeof a["noul"] !== "number") return null;
      out.answers[key] = { type: "noul", noul: a["noul"] as number };
    } else if (type === "choice") {
      if (typeof a["choice"] !== "string") return null;
      const probabilities = a["probabilities"];
      out.answers[key] = {
        type: "choice",
        choice: a["choice"] as string,
        confidence:
          typeof a["confidence"] === "number" ? a["confidence"] : undefined,
        probabilities: isObject(probabilities)
          ? (probabilities as Record<string, number>)
          : undefined,
      };
    } else if (type === "score") {
      if (typeof a["score"] !== "number") return null;
      const probabilities = a["probabilities"];
      out.answers[key] = {
        type: "score",
        score: a["score"] as number,
        confidence:
          typeof a["confidence"] === "number" ? a["confidence"] : undefined,
        probabilities: isObject(probabilities)
          ? (probabilities as Record<string, number>)
          : undefined,
      };
    } else {
      // An answer of an unknown primitive type is a contract change: reject.
      return null;
    }
  }
  return out;
}

function extractErrorMessage(text: string): string | null {
  const parsed = safeParseJson(text);
  if (isObject(parsed)) {
    const error = parsed["error"];
    if (isObject(error)) {
      const message = error["message"];
      if (typeof message === "string" && message.length > 0) {
        return message.slice(0, 200);
      }
    }
  }
  return null;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 200);
  return "network request failed";
}

async function backoff(attempt: number): Promise<void> {
  // Bounded, small, deterministic-ish: 200ms, 400ms. Never exponential blowup.
  const ms = Math.min(200 * 2 ** (attempt - 1), 800);
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── 8. Reporting helpers (used by the benchmark + offline checks) ──────────

/**
 * Read a Noul answer as an orientation boolean at 0.5. Provided for REPORTING
 * ONLY: it is a lossy projection of the raw probability and is deliberately
 * NOT a production threshold. AI-JEV-02 owns confidence calibration.
 */
export function noulOrientation(
  result: JevEvaluationResult,
  key: string,
): boolean | null {
  const answer = result.answers[key];
  if (!answer || answer.type !== "noul") return null;
  return answer.noul >= 0.5;
}

/** Read the raw Noul probability (the value a benchmark must retain). */
export function noulProbability(
  result: JevEvaluationResult,
  key: string,
): number | null {
  const answer = result.answers[key];
  if (!answer || answer.type !== "noul") return null;
  return answer.noul;
}

/** Read a Choice answer's selected option. */
export function choiceSelection(
  result: JevEvaluationResult,
  key: string,
): string | null {
  const answer = result.answers[key];
  if (!answer || answer.type !== "choice") return null;
  return answer.choice;
}

/** Read a Choice/Score confidence when the endpoint supplied one. */
export function answerConfidence(
  result: JevEvaluationResult,
  key: string,
): number | null {
  const answer = result.answers[key];
  if (!answer || answer.type === "noul") return null;
  return answer.confidence;
}
