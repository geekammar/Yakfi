/**
 * JEV DECISIONS provider — the production OpenRouter Decisions-API adapter
 * (PROMPT-AI-JEV-03B §3; the semantic decision strategy's ONLY model seam).
 *
 * This is a DECISIONS endpoint (`POST /api/alpha/decisions`), not a chat
 * completions endpoint: it answers atomic, independent questions about a
 * bounded state and returns probabilities — it never authors customer prose
 * and never returns chain-of-thought. That is exactly why the semantic
 * strategy uses it as its single model call: one request answers every
 * independent semantic fact at once, so the JEV route spends exactly ONE
 * logical model call while the generative route spends its one existing LLM
 * call, and the two never chain (PROMPT-AI-JEV-03A — OPTION B).
 *
 *
 * HARD RULES (binding; verified by scripts/check-jev-semantic.ts)
 *
 *  · PINNED MODEL. The requested model is `typesafe/jev-1.13`. The
 *    `~typesafe/jev-latest` alias is FORBIDDEN as the primary model: an alias
 *    is a moving target that would silently change the semantics behind the
 *    pinned contract. The provider rejects an alias configured as primary.
 *
 *  · SECRET BY NAME. The credential is read by NAME (`OPENROUTER_API_KEY`)
 *    through the injected `getEnvVar` at call time. This module NEVER holds
 *    the value, NEVER logs it, and NEVER puts it in a result, a telemetry
 *    record, or an error message.
 *
 *  · MISSING CREDENTIAL SHORT-CIRCUITS BEFORE NETWORK I/O. When the secret is
 *    absent the provider returns `MISSING_CREDENTIAL` with
 *    `attemptSpent === false` and performs ZERO network calls — the strategy
 *    may then treat that as a pre-attempt unavailability (the existing
 *    generative route), which is the ONLY way a JEV-ineligible turn still
 *    reaches the LLM.
 *
 *  · ONE ATTEMPT. A JEV turn spends AT MOST ONE provider attempt. There is no
 *    retry: a second attempt would be a second model call and would break the
 *    0/1 model-call invariant the gateway owns. A failure after the attempt
 *    reports `attemptSpent === true`, and the strategy FAILS CLOSED on the
 *    deterministic lexical baseline instead of falling through to the LLM.
 *
 *  · CLOSED ERROR TAXONOMY. Failures surface ONLY as a closed `JevErrorCode`
 *    plus a generic non-sensitive message. A raw provider response body is
 *    never copied into a result, a log, or customer-visible output.
 *
 *  · CONTRACT BOUNDARY. The vendor body is validated against the documented
 *    Decisions schema before any answer is trusted; a malformed, partial or
 *    empty answer set is REJECTED (`INVALID_RESPONSE` / `EMPTY_RESPONSE`),
 *    never coerced into a fact.
 *
 *  · ISOLATION. This module imports NO evaluation code. It is the production
 *    implementation of the approved semantics and owns its own typed
 *    request/response contract.
 *
 * Everything is dependency-injected (`getEnvVar` / `fetchImpl`), matching the
 * existing provider convention (`openrouter.ts`, `http.ts`); no second generic
 * AI stack is created.
 */

import type { ConversationContextProjection } from "@/features/conversations/server/conversation-state";

import type { AiCallOptions } from "./types";

export const JEV_DECISIONS_ENDPOINT =
  "https://openrouter.ai/api/alpha/decisions";

/**
 * The PINNED primary model identity. Deliberately NOT the
 * `~typesafe/jev-latest` alias: the semantic strategy's contract is bound to a
 * dated release, and an alias would let the provider swap semantics silently.
 */
export const JEV_PINNED_MODEL = "typesafe/jev-1.13";

/** The alias is forbidden as the primary model (allowed only for comparison). */
export const JEV_FORBIDDEN_ALIAS = "~typesafe/jev-latest";

/** The secret NAME the provider reads — the project's existing convention. */
export const JEV_SECRET_REF = "OPENROUTER_API_KEY";

/** Bounded request timeout. A decisions answer is fast; 15s is generous. */
export const JEV_TIMEOUT_MS = 15_000;

// ─── 1. The provider-neutral request/response contract (production-owned) ────

/**
 * One atomic Jev question. A `noul` asks "is this statement true?" and returns
 * a probability of yes; a `choice` asks "which ONE of these bounded,
 * mutually-exclusive options?" and returns the selection plus per-option
 * probabilities. Every question is ATOMIC and INDEPENDENT — no question's
 * answer may depend on another's; anything that combines facts is composed in
 * CODE (the strategy's precedence derivation), never asked of the model.
 */
export type JevQuestion =
  | {
      readonly type: "noul";
      readonly instructions: string;
      readonly criteria?: { readonly true: string; readonly false: string };
    }
  | {
      readonly type: "choice";
      readonly instructions: string;
      readonly criteria: Readonly<Record<string, string>>;
    };

/**
 * The bounded, semantic state under evaluation. Deliberately SMALL: only what
 * a routing decision needs. It carries no tenant ids, no customer
 * identifiers, no engine internals, and no secrets.
 */
export type JevState = {
  readonly customerMessage: string;
  readonly businessName: string;
  readonly services: ReadonlyArray<string>;
  readonly faqs: ReadonlyArray<string>;
  readonly languageHint: string;
  /** CONV-CORE-02: Bounded context projection of durable conversation state. */
  readonly conversationContext?: ConversationContextProjection | null;
};

export type JevEvaluationRequest = {
  readonly state: JevState;
  readonly questions: Readonly<Record<string, JevQuestion>>;
};

/** The typed answer to one question. */
export type JevAnswer =
  | { readonly type: "noul"; readonly noul: number }
  | {
      readonly type: "choice";
      readonly choice: string;
      readonly confidence: number | null;
      readonly probabilities: Readonly<Record<string, number>>;
    };

// ─── 2. The closed error taxonomy ─────────────────────────────────────────────

export const jevErrorCodeValues = [
  /** The credential is absent. NO network I/O happened (attemptSpent=false). */
  "MISSING_CREDENTIAL",
  /** The alias was configured as the primary model — refused before I/O. */
  "ALIAS_MODEL_FORBIDDEN",
  /** HTTP 400 — the request body did not satisfy the Decisions schema. */
  "BAD_REQUEST",
  /** HTTP 401/403 — the credential was rejected or lacks permission. */
  "AUTH_FAILED",
  /** HTTP 402 — the account has insufficient credits. */
  "INSUFFICIENT_CREDITS",
  /** HTTP 404 — the pinned model id is not served. */
  "MODEL_NOT_FOUND",
  /** HTTP 429 — rate limited. */
  "RATE_LIMITED",
  /** A response that did not validate against the documented schema. */
  "INVALID_RESPONSE",
  /** The endpoint returned no usable answer body. */
  "EMPTY_RESPONSE",
  /** Request exceeded the bounded timeout. */
  "TIMEOUT",
  /** Network-level failure (DNS/connection/abort). */
  "NETWORK",
  /** HTTP 5xx — the provider or edge failed. */
  "PROVIDER",
  /** Operationally stopped or prevented before dispatch (attemptSpent=false). */
  "OPERATIONALLY_PREVENTED",
] as const;

export type JevErrorCode = (typeof jevErrorCodeValues)[number];

/**
 * The outcome of ONE Jev decisions call. `attemptSpent` is the field the
 * strategy's fail-closed logic depends on: it is TRUE iff a network attempt
 * was actually made (a success, or any failure other than a pre-attempt
 * credential/alias refusal). A failure with `attemptSpent === true` MUST NOT
 * fall through to the LLM — the JEV call was already spent.
 */
export type JevDecisionsResult = {
  readonly ok: boolean;
  readonly errorCode: JevErrorCode | null;
  /** A generic, non-sensitive description. Never a raw provider body. */
  readonly errorMessage: string | null;
  /** One typed answer per requested question key (empty on any failure). */
  readonly answers: Readonly<Record<string, JevAnswer>>;
  readonly latencyMs: number;
  /** The dated snapshot the provider actually served, when reported. */
  readonly servedModel: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /** True iff a network attempt was made (see the type doc). */
  readonly attemptSpent: boolean;
};

export type JevDecisionsProvider = {
  /** The pinned model id this provider requests. */
  readonly model: string;
  /** The secret NAME it reads (never the value). */
  readonly secretRef: string;
  /**
   * Evaluate one provider-neutral request. NEVER throws: a failure is returned
   * as `{ ok: false, errorCode, attemptSpent }` so one bad turn can never
   * abort the conversation, and the strategy can account for it exactly.
   */
  evaluate(
    request: JevEvaluationRequest,
    options?: AiCallOptions,
  ): Promise<JevDecisionsResult>;
};

export type JevDecisionsProviderDeps = {
  readonly getEnvVar: (name: string) => string | undefined;
  readonly fetchImpl: typeof fetch;
  readonly endpoint?: string;
  /** Override the pinned model ONLY for a recorded comparison (never alias). */
  readonly model?: string;
  readonly timeoutMs?: number;
};

// ─── 3. The vendor contract (typed from the documented Decisions schema) ──────

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
type DecisionsQuestion = DecisionsNoulQuestion | DecisionsChoiceQuestion;

type DecisionsRequest = {
  model: string;
  state: unknown;
  questions: Record<string, DecisionsQuestion>;
};

type DecisionsNoulAnswer = { type: "noul"; noul: number };
type DecisionsChoiceAnswer = {
  type: "choice";
  choice: string;
  confidence?: number;
  probabilities?: Record<string, number>;
};
type DecisionsAnswer = DecisionsNoulAnswer | DecisionsChoiceAnswer;

type DecisionsResponse = {
  id?: string;
  model: string;
  provider?: string;
  answers: Record<string, DecisionsAnswer>;
  usage: { input_tokens: number; output_tokens: number; cost?: number };
};

// ─── 4. Request mapping (provider-neutral → vendor) ──────────────────────────

function mapState(state: JevState): Record<string, unknown> {
  return {
    customer_message: state.customerMessage,
    business_name: state.businessName,
    services: state.services,
    faqs: state.faqs,
    language_hint: state.languageHint,
    ...(state.conversationContext
      ? {
          conversation_context: {
            active_task: state.conversationContext.activeTask
              ? {
                  kind: state.conversationContext.activeTask.kind,
                  stage: state.conversationContext.activeTask.stage,
                }
              : null,
            booking_stage: state.conversationContext.bookingStage ?? null,
            current_goal: state.conversationContext.currentGoal ?? null,
            known_service: state.conversationContext.knownService ?? null,
            resolved_service_id:
              state.conversationContext.resolvedServiceId ?? null,
            known_date: state.conversationContext.knownDate ?? null,
            time_preference: state.conversationContext.timePreference ?? null,
            provider_preference:
              state.conversationContext.providerPreference ?? null,
            pending_clarification: state.conversationContext
              .pendingClarification
              ? {
                  type: state.conversationContext.pendingClarification.type,
                  missing_facts:
                    state.conversationContext.pendingClarification
                      .missingFacts ?? [],
                }
              : null,
            pending_goals:
              state.conversationContext.pendingGoals?.map((g) => ({
                kind: g.kind,
                intent: g.intent,
              })) ?? [],
            active_offer: state.conversationContext.activeOffer
              ? {
                  type: state.conversationContext.activeOffer.type,
                  item_count: state.conversationContext.activeOffer.itemCount,
                  offered_date:
                    state.conversationContext.activeOffer.offeredDate ?? null,
                  offered_service_name:
                    state.conversationContext.activeOffer.offeredServiceName ??
                    null,
                }
              : null,
            last_completed_task: state.conversationContext.lastCompletedTask
              ? {
                  kind: state.conversationContext.lastCompletedTask.kind,
                  service_id:
                    state.conversationContext.lastCompletedTask.serviceId,
                  date: state.conversationContext.lastCompletedTask.date,
                  completed_at:
                    state.conversationContext.lastCompletedTask.completedAt,
                }
              : null,
          },
        }
      : {}),
  };
}

function mapQuestion(question: JevQuestion): DecisionsQuestion {
  if (question.type === "noul") {
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
  }
  return {
    type: "choice",
    instructions: question.instructions,
    criteria: { ...question.criteria },
  };
}

// ─── 5. Response validation (strict; the contract boundary) ──────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Validate the vendor body against the documented Decisions schema by hand
 * (no new dependency). This is what lets the provider REJECT an unexpected
 * vendor change instead of coercing garbage into a semantic fact.
 */
function validateDecisionsResponse(value: unknown): DecisionsResponse | null {
  if (!isObject(value)) return null;
  const model = value["model"];
  const answers = value["answers"];
  const usage = value["usage"];
  if (typeof model !== "string" || model.length === 0) return null;
  if (!isObject(answers)) return null;
  if (!isObject(usage)) return null;
  if (typeof usage["input_tokens"] !== "number") return null;
  if (typeof usage["output_tokens"] !== "number") return null;
  if (value["provider"] !== undefined && typeof value["provider"] !== "string")
    return null;
  if (value["id"] !== undefined && typeof value["id"] !== "string") return null;
  if (usage["cost"] !== undefined && typeof usage["cost"] !== "number")
    return null;

  const out: DecisionsResponse = {
    model,
    answers: {},
    usage: {
      input_tokens: usage["input_tokens"] as number,
      output_tokens: usage["output_tokens"] as number,
    },
  };
  if (typeof value["id"] === "string") out.id = value["id"];
  if (typeof value["provider"] === "string") out.provider = value["provider"];

  for (const key of Object.keys(answers)) {
    const answer = answers[key];
    if (!isObject(answer)) continue;
    if (answer["type"] === "noul") {
      if (typeof answer["noul"] !== "number" || Number.isNaN(answer["noul"]))
        continue;
      out.answers[key] = {
        type: "noul",
        noul: answer["noul"] as number,
      };
    } else if (answer["type"] === "choice") {
      if (typeof answer["choice"] !== "string") continue;
      out.answers[key] = {
        type: "choice",
        choice: answer["choice"] as string,
        confidence:
          typeof answer["confidence"] === "number"
            ? (answer["confidence"] as number)
            : undefined,
        probabilities:
          isObject(answer["probabilities"]) &&
          Object.values(answer["probabilities"]).every(
            (probability) => typeof probability === "number",
          )
            ? (answer["probabilities"] as Record<string, number>)
            : undefined,
      };
    }
  }
  return out;
}

function mapAnswer(answer: DecisionsAnswer): JevAnswer | null {
  if (answer.type === "noul") {
    if (typeof answer.noul !== "number" || Number.isNaN(answer.noul))
      return null;
    return { type: "noul", noul: answer.noul };
  }
  if (typeof answer.choice !== "string") return null;
  return {
    type: "choice",
    choice: answer.choice,
    confidence:
      typeof answer.confidence === "number" ? answer.confidence : null,
    probabilities: answer.probabilities ?? {},
  };
}

function classifyHttpStatus(status: number): JevErrorCode {
  if (status === 400) return "BAD_REQUEST";
  if (status === 401 || status === 403) return "AUTH_FAILED";
  if (status === 402) return "INSUFFICIENT_CREDITS";
  if (status === 404) return "MODEL_NOT_FOUND";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "PROVIDER";
  return "PROVIDER";
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "network error";
}

// ─── 6. The provider ──────────────────────────────────────────────────────────

export function createJevDecisionsProvider(
  deps: JevDecisionsProviderDeps,
): JevDecisionsProvider {
  const model = deps.model?.trim() || JEV_PINNED_MODEL;
  const endpoint = deps.endpoint ?? JEV_DECISIONS_ENDPOINT;
  const timeoutMs = deps.timeoutMs ?? JEV_TIMEOUT_MS;

  return {
    model,
    secretRef: JEV_SECRET_REF,

    async evaluate(
      request: JevEvaluationRequest,
      options?: AiCallOptions,
    ): Promise<JevDecisionsResult> {
      const started = Date.now();

      // ── Check serving execution session allowance & deadline before dispatch
      if (options?.session) {
        const check = options.session.canDispatch();
        if (!check.allowed) {
          return {
            ok: false,
            errorCode: "OPERATIONALLY_PREVENTED",
            errorMessage: `request prevented: ${check.reason ?? "LIMIT_EXHAUSTED"}`,
            answers: {},
            latencyMs: Date.now() - started,
            servedModel: null,
            inputTokens: null,
            outputTokens: null,
            attemptSpent: false,
          };
        }
      }

      // ── Pinned-model guard: the alias is never the primary model. ────────
      if (model === JEV_FORBIDDEN_ALIAS) {
        return {
          ok: false,
          errorCode: "ALIAS_MODEL_FORBIDDEN",
          errorMessage: `the alias ${JEV_FORBIDDEN_ALIAS} is forbidden as the primary model; the pinned ${JEV_PINNED_MODEL} is required`,
          answers: {},
          latencyMs: Date.now() - started,
          servedModel: null,
          inputTokens: null,
          outputTokens: null,
          attemptSpent: false,
        };
      }

      // ── Credential gate: fails closed BEFORE any network I/O. ────────────
      const apiKey = deps.getEnvVar(JEV_SECRET_REF);
      if (!apiKey || apiKey.trim().length === 0) {
        return {
          ok: false,
          errorCode: "MISSING_CREDENTIAL",
          errorMessage: `secret ${JEV_SECRET_REF} is not configured; no external model call was attempted`,
          answers: {},
          latencyMs: Date.now() - started,
          servedModel: null,
          inputTokens: null,
          outputTokens: null,
          attemptSpent: false,
        };
      }

      // ── Bound JEV timeout by remaining serving deadline (CORE-04B §7) ─────
      const remainingDeadlineMs = options?.session
        ? options.session.getRemainingTimeoutMs(timeoutMs)
        : options?.timeoutMs !== undefined
          ? Math.min(timeoutMs, options.timeoutMs)
          : timeoutMs;
      const effectiveTimeoutMs = Math.min(timeoutMs, remainingDeadlineMs);

      if (effectiveTimeoutMs <= 0) {
        return {
          ok: false,
          errorCode: "OPERATIONALLY_PREVENTED",
          errorMessage: "deadline exhausted before dispatch",
          answers: {},
          latencyMs: Date.now() - started,
          servedModel: null,
          inputTokens: null,
          outputTokens: null,
          attemptSpent: false,
        };
      }

      const body: DecisionsRequest = {
        model,
        state: mapState(request.state),
        questions: Object.fromEntries(
          Object.entries(request.questions).map(([key, question]) => [
            key,
            mapQuestion(question),
          ]),
        ),
      };
      const payload = JSON.stringify(body);

      // Reserve physical HTTP attempt immediately before wire dispatch (CORE-04B)
      if (options?.session) {
        options.session.recordDispatch(1);
      }

      // ── ONE attempt. No retry: a second attempt would be a second model
      //    call and would break the 0/1 model-call budget the gateway owns.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), effectiveTimeoutMs);
      const onUserAbort = () => controller.abort();
      if (options?.signal) {
        if (options.signal.aborted) {
          controller.abort();
        } else {
          options.signal.addEventListener("abort", onUserAbort, { once: true });
        }
      }

      try {
        const httpResponse = await deps.fetchImpl(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: payload,
          signal: controller.signal,
        });

        const text = await httpResponse.text();

        // Check if deadline was exceeded while waiting for response body
        if (options?.session) {
          const check = options.session.canDispatch();
          if (!check.allowed && check.reason === "DEADLINE_EXHAUSTED") {
            return {
              ok: false,
              errorCode: "TIMEOUT",
              errorMessage: `request completed after deadline (${effectiveTimeoutMs}ms)`,
              answers: {},
              latencyMs: Date.now() - started,
              servedModel: null,
              inputTokens: null,
              outputTokens: null,
              attemptSpent: true,
            };
          }
        }

        if (!httpResponse.ok) {
          return {
            ok: false,
            errorCode: classifyHttpStatus(httpResponse.status),
            errorMessage: `HTTP ${httpResponse.status}`,
            answers: {},
            latencyMs: Date.now() - started,
            servedModel: null,
            inputTokens: null,
            outputTokens: null,
            attemptSpent: true,
          };
        }

        const parsed = safeParseJson(text);
        if (parsed === null) {
          return {
            ok: false,
            errorCode: "INVALID_RESPONSE",
            errorMessage: "response body is not valid JSON",
            answers: {},
            latencyMs: Date.now() - started,
            servedModel: null,
            inputTokens: null,
            outputTokens: null,
            attemptSpent: true,
          };
        }

        const validated = validateDecisionsResponse(parsed);
        if (validated === null) {
          return {
            ok: false,
            errorCode: "INVALID_RESPONSE",
            errorMessage:
              "response does not match the documented Decisions schema",
            answers: {},
            latencyMs: Date.now() - started,
            servedModel: null,
            inputTokens: null,
            outputTokens: null,
            attemptSpent: true,
          };
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
        // An answer set that is empty or short of what was asked is not usable
        // evidence — fail closed rather than silently scoring gaps as facts.
        if (Object.keys(answers).length === 0 || rejected > 0) {
          return {
            ok: false,
            errorCode: "EMPTY_RESPONSE",
            errorMessage: `${rejected} of ${Object.keys(request.questions).length} questions had no usable answer`,
            answers: {},
            latencyMs: Date.now() - started,
            servedModel: null,
            inputTokens: null,
            outputTokens: null,
            attemptSpent: true,
          };
        }

        return {
          ok: true,
          errorCode: null,
          errorMessage: null,
          answers,
          latencyMs: Date.now() - started,
          servedModel: validated.model,
          inputTokens: validated.usage.input_tokens,
          outputTokens: validated.usage.output_tokens,
          attemptSpent: true,
        };
      } catch (err) {
        const isAbort =
          controller.signal.aborted ||
          (err instanceof DOMException && err.name === "AbortError") ||
          (err instanceof Error && err.name === "AbortError") ||
          (err instanceof Error && err.message.includes("aborted"));
        return {
          ok: false,
          errorCode: isAbort ? "TIMEOUT" : "NETWORK",
          errorMessage: isAbort
            ? `request exceeded ${effectiveTimeoutMs}ms`
            : describeError(err),
          answers: {},
          latencyMs: Date.now() - started,
          servedModel: null,
          inputTokens: null,
          outputTokens: null,
          attemptSpent: true,
        };
      } finally {
        clearTimeout(timer);
        if (options?.signal) {
          options.signal.removeEventListener("abort", onUserAbort);
        }
      }
    },
  };
}
