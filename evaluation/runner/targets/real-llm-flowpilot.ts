/**
 * FlowPilot AI Evaluation — the REAL-LLM FlowPilot target (PROMPT-AI-EVAL-04B).
 *
 * The concrete `EvaluationTarget` that drives the CURRENT effective LLM
 * provider/model through the production decision flow (bypass → policy-backed
 * LLM → disclosure gate) via `createRealLlmRunner`. It normalizes the structured
 * result into the EVAL-01 `ActualOutcome` so the SAME target-agnostic scoring
 * engine used for the EVAL-04 deterministic baseline scores this run — the only
 * thing that differs between the two baselines is the subject that produced the
 * outcome.
 *
 * Kept `kind: CURRENT_SYSTEM` because this IS the shipped production chain, just
 * exercised with real inference; `modelProvider` names the resolved provider/
 * model so a report can never be confused with the offline deterministic run.
 * `runTurn` NEVER throws — a provider failure is a `PROVIDER_FAILURE` outcome.
 */

import { parseAiResponse } from "@/features/conversations/server/ai-contract";

import type {
  ActualOutcome,
  SystemIdentity,
} from "../../schema/evaluation-result-schema";
import type { RealLlmRunner } from "../real-llm-adapter";
import type { EvaluationTarget, TargetTurnInput } from "../target";

const CONTENT_PREVIEW_LIMIT = 400;

export class RealLlmFlowpilotTarget implements EvaluationTarget {
  readonly id = "real-llm-flowpilot";
  readonly systemIdentity: SystemIdentity;
  private readonly runner: RealLlmRunner;

  constructor(runner: RealLlmRunner, systemIdentity: SystemIdentity) {
    this.runner = runner;
    this.systemIdentity = systemIdentity;
  }

  async runTurn(input: TargetTurnInput): Promise<ActualOutcome> {
    const outcome = await this.runner.runTurn({
      message: input.message,
      history: input.history,
      businessContext: input.businessContext,
    });
    const response = outcome.response;
    // A provider/AI failure is NOT a malformed model output — it is the
    // engine's controlled fail-safe (null → NEED_HUMAN). `malformed` is
    // reserved for a RETURNED response that violates the response contract,
    // so provider failures are reported on their own channel and never inflate
    // the malformed-output rate.
    const malformed =
      !outcome.providerFailure && parseAiResponse(response) === null;
    const handedOff =
      response.action === "handoff" ||
      response.action === "booking_handoff" ||
      outcome.disclosure === "requires-human";

    // Preliminary handoff channel the TARGET can determine (the HandoffScorer
    // resolves TRUE vs UNNECESSARY against the gold label). A controlled
    // provider/AI failure is its own channel.
    const handoffOutcomeClass = outcome.providerFailure
      ? "PROVIDER_FAILURE"
      : malformed
        ? "AI_FAILURE"
        : handedOff
          ? undefined
          : "NO_HANDOFF";

    const actual: ActualOutcome = {
      intent: response.intent,
      action: response.action,
      handoffReason: response.handoffReason,
      content: (response.content ?? "").slice(0, CONTENT_PREVIEW_LIMIT),
      extraction: {
        service: response.extraction.service,
        provider: response.extraction.provider,
        date: response.extraction.date,
        timePreference: response.extraction.timePreference,
      },
      source: outcome.source,
      disclosure: outcome.disclosure,
      malformed,
      handoffOutcomeClass,
      // Target-architecture observables (PROMPT-AI-ARCH-02, Slice 0): the
      // bridge that surfaces the new decision fields through the UNCHANGED
      // evaluation boundary. Today's producer emits none of the optional
      // decision fields, so they stay absent.
      goals: response.goals,
      clarification: response.clarification,
      handoffCause: response.handoffCause,
      factUpdates: response.factUpdates,
      routingDecision:
        outcome.source === "deterministic-bypass"
          ? "DETERMINISTIC_BYPASS"
          : outcome.source === "llm"
            ? "LLM"
            : "NONE",
      knowledgeSourceClass: [...outcome.support],
      // ── passthrough telemetry (schema is .passthrough()) ──────────────────
      realProvider: outcome.telemetry.finalProvider,
      realModel: outcome.telemetry.finalModel,
      fallbackUsed: outcome.telemetry.fallbackUsed,
      physicalAttempts: outcome.telemetry.physicalAttempts,
      modelLatencyMs: outcome.telemetry.modelLatencyMs,
      totalLatencyMs: outcome.totalLatencyMs,
      inputTokens: outcome.telemetry.inputTokens,
      outputTokens: outcome.telemetry.outputTokens,
      providerErrorCode: outcome.telemetry.errorCode,
    } as ActualOutcome;
    return actual;
  }
}
