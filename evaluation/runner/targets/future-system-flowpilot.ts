/**
 * FlowPilot AI Evaluation — the FUTURE_SYSTEM FlowPilot target
 * (PROMPT-AI-EVAL-06).
 *
 * The evaluation-only `EvaluationTarget` that measures the FUTURE architecture
 * (Slices 0–4: Conversation Engine + ConversationState + resolveTurnPlan +
 * first-class CLARIFY) with the REAL configured provider/model. It is the
 * sibling of — and deliberately DISTINCT from — the two CURRENT_SYSTEM targets:
 *
 *   current-flowpilot    → deterministic classifier baseline (offline)
 *   real-llm-flowpilot    → real LLM, but STOPS at the disclosure gate
 *                           (bypass → LLM → disclosure); it never reaches
 *                           resolveTurnPlan / clarification.ts / CLARIFY, so it
 *                           cannot measure Slice 4.
 *   future-system-flowpilot (THIS)
 *                        → real LLM driven THROUGH the real Conversation Engine
 *                          so the turn actually traverses TurnPlan + CLARIFY +
 *                          ConversationState, surfacing the resolver-owned
 *                          decision into `ActualOutcome`.
 *
 * `kind: FUTURE_SYSTEM` marks it as a non-production experimental architecture
 * (TARGET_ARCHITECTURE §14). `runTurn` NEVER throws: a provider failure is a
 * `PROVIDER_FAILURE` outcome; an invalid model output is an `AI_FAILURE`
 * outcome; the engine's safe NEED_HUMAN fail-safe is preserved.
 *
 * It records ONLY sanitized observables — intent/action/handoff + the
 * resolver-owned turn plan, clarification type + missing facts, routing,
 * knowledge-source classes, provider/model machine keys, retry/fallback
 * counters, latency. NEVER secrets, auth headers, raw provider payloads,
 * prompts, or chain-of-thought.
 */

import type {
  ActualOutcome,
  SystemIdentity,
} from "../../schema/evaluation-result-schema";
import type {
  FutureSystemRunner,
  FutureTurnOutcome,
} from "../future-system-adapter";
import type { EvaluationTarget, TargetTurnInput } from "../target";

/** The stable FUTURE_SYSTEM target id — distinct from the CURRENT targets. */
export const FUTURE_SYSTEM_TARGET_ID = "future-system-flowpilot";

type Observability = {
  routingDecision?: string;
  goals?: unknown[];
  turnPlan?: { steps?: Array<{ kind?: string; intent?: string }> };
  clarification?: { type?: string; missingFacts?: string[] };
  handoffCause?: string;
  factUpdates?: unknown[];
  knowledgeSourceClass?: string[];
  provider?: string;
  model?: string;
  fallbackUsed?: boolean;
  retryCount?: number;
  latencyMs?: number;
  stateTransition?: unknown;
};

/** The decision class the resolver OWNED for the turn (observed, not inferred). */
function decisionClassOf(obs: Observability | undefined): string | undefined {
  const kind = obs?.turnPlan?.steps?.[0]?.kind;
  return typeof kind === "string" ? kind : undefined;
}

export class FutureSystemFlowpilotTarget implements EvaluationTarget {
  readonly id = FUTURE_SYSTEM_TARGET_ID;
  readonly systemIdentity: SystemIdentity;
  private readonly runner: FutureSystemRunner;

  constructor(runner: FutureSystemRunner, systemIdentity: SystemIdentity) {
    this.runner = runner;
    this.systemIdentity = systemIdentity;
  }

  async runTurn(input: TargetTurnInput): Promise<ActualOutcome> {
    const outcome: FutureTurnOutcome = await this.runner.runTurn({
      caseId: input.caseId,
      turnIndex: input.turnIndex,
      message: input.message,
      history: input.history,
      businessContext: input.businessContext,
    });

    const engine = outcome.engine;

    // A harness/engine failure (ok:false) is reported on the AI_FAILURE channel
    // so it is surfaced, never silently passed.
    if (!engine.ok) {
      return {
        intent: "AMBIGUOUS",
        action: "handoff",
        handoffReason: null,
        malformed: true,
        handoffOutcomeClass: "AI_FAILURE",
        source: "engine-failure",
        engineOk: false,
        engineFailureCode: engine.code,
      } as ActualOutcome;
    }

    // An idempotent duplicate should not occur in a fresh per-case run; if it
    // does, surface it rather than scoring a phantom outcome.
    if (engine.duplicate) {
      return {
        intent: "AMBIGUOUS",
        action: "handoff",
        malformed: true,
        handoffOutcomeClass: "AI_FAILURE",
        source: "unexpected-duplicate",
        engineOk: true,
      } as ActualOutcome;
    }

    const obs = engine.observability as Observability | undefined;
    const decision = outcome.decision;
    const handedOff = engine.conversationStatus === "NEED_HUMAN";
    const isBooking =
      engine.intent === "BOOKING" || engine.intent === "AVAILABILITY";

    // Map the engine's AUTHORITATIVE outcome into the symmetric scoring terms.
    const action = handedOff
      ? isBooking
        ? "booking_handoff"
        : "handoff"
      : "reply";
    const disclosure: "disclosed" | "requires-human" = handedOff
      ? "requires-human"
      : "disclosed";

    // Preliminary handoff channel the TARGET can determine (the HandoffScorer
    // resolves TRUE vs UNNECESSARY against the gold label). Provider/AI failure
    // are their own channels.
    const handoffOutcomeClass = outcome.providerFailure
      ? "PROVIDER_FAILURE"
      : outcome.validatedNull
        ? "AI_FAILURE"
        : handedOff
          ? undefined
          : "NO_HANDOFF";

    const routing = obs?.routingDecision;
    const source =
      routing === "DETERMINISTIC_BYPASS"
        ? "deterministic-bypass"
        : routing === "LLM"
          ? "llm"
          : routing === "DETERMINISTIC"
            ? "deterministic-assistant"
            : outcome.providerFailure
              ? "controlled-failure"
              : "engine";

    const clarification = obs?.clarification;
    const missingFacts = clarification?.missingFacts ?? [];

    const actual: ActualOutcome = {
      intent: engine.intent ?? decision?.intent,
      action,
      handoffReason: decision?.handoffReason ?? null,
      // Content is NOT surfaced by the engine success result; the eval boundary
      // deliberately records none (no customer-facing text, no leakage).
      content: "",
      extraction: decision
        ? {
            service: decision.extraction.service,
            provider: decision.extraction.provider,
            date: decision.extraction.date,
            timePreference: decision.extraction.timePreference,
          }
        : {
            service: null,
            provider: null,
            date: null,
            timePreference: null,
          },
      source,
      disclosure,
      malformed: outcome.validatedNull,
      handoffOutcomeClass,
      // ── Target-architecture observables (resolver-owned, Slices 0–4) ───────
      goals: obs?.goals,
      turnPlan: obs?.turnPlan,
      clarification: obs?.clarification,
      // PROMPT-AI-ARCH-16 (Slice 7) — the SERVER-AUTHORITATIVE typed cause
      // the engine derived for this turn's handoff (the model's own bounded
      // cause string is only a fallback and is never trusted as canonical).
      handoffCause: engine.handoffCause ?? obs?.handoffCause,
      factUpdates: obs?.factUpdates,
      knowledgeSourceClass: obs?.knowledgeSourceClass,
      routingDecision: routing,
      stateTransition: obs?.stateTransition,
      // ── FUTURE_SYSTEM passthrough (schema is .passthrough()) ──────────────
      decisionClass: decisionClassOf(obs),
      conversationStatus: engine.conversationStatus,
      assistantAction: engine.assistantAction,
      missingFacts,
      clarificationEmitted: decisionClassOf(obs) === "CLARIFY",
      modelCallsThisTurn: outcome.modelCallsThisTurn,
      providerFailure: outcome.providerFailure,
      // sanitized telemetry
      realProvider: obs?.provider ?? outcome.telemetry.finalProvider,
      realModel: obs?.model ?? outcome.telemetry.finalModel,
      fallbackUsed: obs?.fallbackUsed ?? outcome.telemetry.fallbackUsed,
      retryCount: obs?.retryCount ?? outcome.telemetry.retryCount,
      physicalAttempts: outcome.telemetry.physicalAttempts,
      modelLatencyMs: outcome.telemetry.modelLatencyMs,
      totalLatencyMs: outcome.totalLatencyMs,
      inputTokens: outcome.telemetry.inputTokens,
      outputTokens: outcome.telemetry.outputTokens,
      providerErrorCode: outcome.telemetry.errorCode,
      engineOk: true,
    } as ActualOutcome;

    return actual;
  }
}
