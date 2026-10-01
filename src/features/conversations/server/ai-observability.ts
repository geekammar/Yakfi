/**
 * Turn observability seam (PROMPT-AI-ARCH-02 — Slice 0).
 *
 * Structured, additive observables for the target AI decision architecture,
 * projected from data the EXISTING execution path already has. This module
 * adds NO inference, NO provider awareness, NO domain authority, and NO
 * behavior: it is a pure, total projection of an already-finished turn.
 *
 * What it may carry (machine keys / closed classifications only):
 *   routingDecision · goals[] · turnPlan · clarification · handoffCause ·
 *   factUpdates · knowledgeSourceClass · provider · model · fallbackUsed ·
 *   retryCount · latencyMs · stateTransition
 *
 * What it must NEVER carry (binding):
 *   secrets · authorization headers · raw provider payloads · prompt bodies ·
 *   message content · chain-of-thought. The builder copies only the contract's
 *   bounded decision labels, closed machine keys, and already-sanitized
 *   telemetry counters; it never copies `content`, prompts, or raw provider
 *   bodies.
 *
 * The record is a plain value attached to the engine's existing success
 * result (`InboundSuccess.observability?`). It is NOT a new telemetry product:
 * no table, no queue, no external call, no persistence, no extra model call.
 *
 * Docs: `docs/ai/TARGET_ARCHITECTURE.md §14/§15`, `docs/ai/ARCHITECTURE.md`.
 */

import type {
  AiClarification,
  AiFactUpdate,
  AiGoal,
  AiHandoffCause,
  AiResponse,
  AiTurnPlan,
} from "@/features/conversations/server/ai-contract";
import {
  synthesizeDecisionGoals,
  synthesizeTurnPlan,
} from "@/features/conversations/server/ai-contract";

/** Where the turn's decision came from (target §14 `routingDecision`). */
export const aiRoutingDecisionValues = [
  /** Answered with no model call (greeting / too-short bypass). */
  "DETERMINISTIC_BYPASS",
  /** The deterministic assistant answered with no provider call. */
  "DETERMINISTIC",
  /** A future JEV strategy produced the decision. */
  "JEV",
  /** A provider adapter produced the decision (the normal LLM turn). */
  "LLM",
  /** No decision ran (e.g. the thread was deferred to staff / duplicated). */
  "NONE",
] as const;

export type AiRoutingDecision = (typeof aiRoutingDecisionValues)[number];

/** A state transition already observable on the turn (later slices populate). */
export type TurnStateTransitionObservation = {
  readonly from?: string;
  readonly to?: string;
  readonly factKey?: string;
  readonly isRevision?: boolean;
};

/**
 * The additive, optional observable record for ONE turn. Every member is
 * optional: a producer that cannot observe a field simply omits it, so the
 * current system populates exactly what its existing seams expose and nothing
 * more.
 */
export type TurnObservability = {
  readonly routingDecision?: AiRoutingDecision;
  readonly goals?: readonly AiGoal[];
  readonly turnPlan?: AiTurnPlan;
  readonly clarification?: AiClarification;
  readonly handoffCause?: AiHandoffCause;
  readonly factUpdates?: readonly AiFactUpdate[];
  /**
   * The DOMAIN/booking goal(s) a turn PRESERVED for continuation
   * (PROMPT-AI-ARCH-09 — Slice 5). Populated only on an answer-and-continue
   * turn; absent otherwise. Machine labels only (the same bounded `AiGoal`),
   * never customer content.
   */
  readonly pendingGoals?: readonly AiGoal[];
  /** True on an answer-and-continue turn (knowledge answered, domain pending). */
  readonly answerAndContinue?: boolean;
  /**
   * The B-01/B-02 source classes of the facts that actually entered context
   * (closed `KnowledgeFactSource` machine keys — never content).
   */
  readonly knowledgeSourceClass?: readonly string[];
  /** Provider identity (machine key) when already known. */
  readonly provider?: string;
  /** Model identity (machine key) when already known. */
  readonly model?: string;
  readonly fallbackUsed?: boolean;
  readonly retryCount?: number;
  readonly latencyMs?: number;
  readonly stateTransition?: TurnStateTransitionObservation;
};

export type BuildTurnObservabilityInput = {
  readonly routingDecision?: AiRoutingDecision;
  /** The validated decision (or a deterministic bypass response). */
  readonly response?: AiResponse | null;
  /**
   * The ordered `TurnPlan` the Decision/Action Resolver produced for this
   * turn (PROMPT-AI-ARCH-05 — Slice 3). When present it OVERRIDES the Slice-0
   * single-goal synthesis so the resolver is the ONE owner of the plan; when
   * absent, the plan falls back to the canonical synthesis bridge (unchanged
   * Slice-0 behavior). Still the SAME canonical `AiTurnPlan` — never a second
   * representation.
   */
  readonly turnPlan?: AiTurnPlan | null;
  /**
   * The clarification the Decision/Action Resolver produced for a first-class
   * CLARIFY turn (PROMPT-AI-ARCH-06 — Slice 4). When present it OVERRIDES the
   * decision's own proposed `clarification`, so the resolver stays the ONE
   * owner of the emitted clarification. Machine keys only (`type`,
   * `missingFacts`) — never the customer-facing question text.
   */
  readonly clarification?: AiClarification | null;
  readonly provider?: string | null;
  readonly model?: string | null;
  readonly fallbackUsed?: boolean;
  readonly retryCount?: number;
  readonly latencyMs?: number;
  readonly knowledgeSourceClass?: readonly string[] | null;
  readonly stateTransition?: TurnStateTransitionObservation | null;
  /**
   * The DOMAIN/booking goal(s) the resolver preserved for continuation on an
   * answer-and-continue turn (PROMPT-AI-ARCH-09 — Slice 5). Absent otherwise.
   */
  readonly pendingGoals?: readonly AiGoal[] | null;
  /** True on an answer-and-continue turn. */
  readonly answerAndContinue?: boolean;
};

/**
 * Project a finished turn into its observable record. Pure and total: no I/O,
 * no LLM, no env, no DB, no secret. Deterministic — the same input always
 * yields the same record. `goals` / `turnPlan` are derived through the ONE
 * canonical synthesis bridge, so a no-goals decision is observed as exactly
 * one synthesized goal without inventing a second decision model.
 */
export function buildTurnObservability(
  input: BuildTurnObservabilityInput,
): TurnObservability {
  const response = input.response ?? null;
  const goalObserved = response
    ? {
        goals: synthesizeDecisionGoals(response),
        turnPlan: input.turnPlan ?? synthesizeTurnPlan(response),
      }
    : input.turnPlan
      ? { turnPlan: input.turnPlan }
      : {};
  return {
    ...(input.routingDecision
      ? { routingDecision: input.routingDecision }
      : {}),
    ...goalObserved,
    ...(input.clarification
      ? { clarification: input.clarification }
      : response?.clarification
        ? { clarification: response.clarification }
        : {}),
    ...(response?.handoffCause ? { handoffCause: response.handoffCause } : {}),
    ...(response?.factUpdates && response.factUpdates.length > 0
      ? { factUpdates: [...response.factUpdates] }
      : {}),
    ...(input.knowledgeSourceClass && input.knowledgeSourceClass.length > 0
      ? { knowledgeSourceClass: [...new Set(input.knowledgeSourceClass)] }
      : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.fallbackUsed !== undefined
      ? { fallbackUsed: input.fallbackUsed }
      : {}),
    ...(input.retryCount !== undefined ? { retryCount: input.retryCount } : {}),
    ...(input.latencyMs !== undefined ? { latencyMs: input.latencyMs } : {}),
    ...(input.stateTransition
      ? { stateTransition: input.stateTransition }
      : {}),
    ...(input.pendingGoals && input.pendingGoals.length > 0
      ? { pendingGoals: [...input.pendingGoals] }
      : {}),
    ...(input.answerAndContinue !== undefined
      ? { answerAndContinue: input.answerAndContinue }
      : {}),
  };
}
