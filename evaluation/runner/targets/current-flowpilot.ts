/**
 * FlowPilot AI Evaluation — the CURRENT FlowPilot target (PROMPT-AI-EVAL-03).
 *
 * The first concrete `EvaluationTarget`: the shipped production AI, executed
 * OFFLINE through the shared `runCurrentAiTurn` seam (bypass → deterministic
 * assistant → disclosure gate). It does NOT re-implement any AI logic — it
 * invokes the real production chain and NORMALIZES the structured result into
 * the EVAL-01 `ActualOutcome` shape so the scoring engine is target-agnostic.
 *
 * What is captured (and, deliberately, what is NOT):
 *  - intent / action / handoffReason / extraction / bounded content
 *  - the engine seam that produced the turn + the disclosure verdict
 *  - a preliminary handoff outcome class (NO_HANDOFF / AI_FAILURE only — the
 *    TRUE-vs-UNNECESSARY split needs the gold label and is decided by the
 *    HandoffScorer, never by the target)
 *  - `malformed` when the output violates the response contract
 *  - NEVER chain-of-thought (Zod strips it at the contract), NEVER secrets,
 *    NEVER live channel delivery.
 */

import { parseAiResponse } from "@/features/conversations/server/ai-contract";

import type {
  ActualOutcome,
  SystemIdentity,
} from "../../schema/evaluation-result-schema";
import { runCurrentAiTurn } from "../current-ai-adapter";
import type { EvaluationTarget, TargetTurnInput } from "../target";

/** How much of the assistant reply is retained in a result (traceability). */
const CONTENT_PREVIEW_LIMIT = 400;

/**
 * The identity of the offline current-AI subject. `modelProvider` names the
 * deterministic classifier explicitly so a report can never be mistaken for a
 * live-provider run. No release tag is asserted here — the CLI may enrich the
 * identity with a `systemVersion` when a caller knows the build.
 */
export const CURRENT_FLOWPILOT_IDENTITY: SystemIdentity = {
  kind: "CURRENT_SYSTEM",
  modelProvider: "deterministic-classifier (offline)",
  note: "current FlowPilot AI: bypass → deterministic assistant → disclosure gate",
};

export class CurrentFlowpilotTarget implements EvaluationTarget {
  readonly id = "current-flowpilot";
  readonly systemIdentity: SystemIdentity;

  constructor(systemIdentity: SystemIdentity = CURRENT_FLOWPILOT_IDENTITY) {
    this.systemIdentity = systemIdentity;
  }

  async runTurn(input: TargetTurnInput): Promise<ActualOutcome> {
    const outcome = await runCurrentAiTurn({
      message: input.message,
      history: input.history,
      businessContext: input.businessContext,
    });
    const response = outcome.response;
    const malformed = parseAiResponse(response) === null;
    const handedOff =
      response.action === "handoff" ||
      response.action === "booking_handoff" ||
      outcome.disclosure === "requires-human";

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
      // Only the target-determinable classes; the HandoffScorer resolves
      // TRUE_HUMAN_REQUIRED / UNNECESSARY_HUMAN_HANDOFF against the gold label.
      handoffOutcomeClass: malformed
        ? "AI_FAILURE"
        : handedOff
          ? undefined
          : "NO_HANDOFF",
      // Target-architecture observables (PROMPT-AI-ARCH-02, Slice 0): the
      // bridge that lets the UNCHANGED evaluation boundary surface the new
      // decision fields. Today's producer emits none of the optional decision
      // fields, so they stay absent; `routingDecision` / `knowledgeSourceClass`
      // are derived from the existing `source` / disclosure support.
      goals: response.goals,
      clarification: response.clarification,
      handoffCause: response.handoffCause,
      factUpdates: response.factUpdates,
      routingDecision:
        outcome.source === "deterministic-bypass"
          ? "DETERMINISTIC_BYPASS"
          : "DETERMINISTIC",
      knowledgeSourceClass: [...outcome.support],
    };
    return actual;
  }
}

/** Convenience factory for the default offline current-AI target. */
export function createCurrentFlowpilotTarget(
  systemIdentity?: SystemIdentity,
): CurrentFlowpilotTarget {
  return new CurrentFlowpilotTarget(systemIdentity);
}
