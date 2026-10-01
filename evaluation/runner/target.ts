/**
 * FlowPilot AI Evaluation — the EvaluationTarget abstraction (PROMPT-AI-EVAL-03).
 *
 * A TARGET is the thing being measured. It is provider-neutral by design: the
 * scoring engine, metrics, runner, and reports never know which target ran, so
 * a future target (a new router, a JEV target, a hybrid AI, a model comparison)
 * can be added WITHOUT changing the runner or the scorers.
 *
 *   Evaluation
 *      ↓
 *   EvaluationTarget           ← this file (the seam)
 *      ↓
 *   Current AI / future system
 *      ↓
 *   ActualOutcome (EVAL-01 evaluation-result schema)
 *      ↓
 *   Evaluator (scorers)
 *      ↓
 *   Score
 *
 * A target executes ONE turn at a time and returns the structured
 * `ActualOutcome` (never chain-of-thought, never secrets). Multi-turn replay —
 * preserving order and causal context — is the RUNNER's job (`runner.ts`): the
 * runner feeds each customer turn's prior messages as `history`, so the target
 * itself stays stateless and simple. That keeps a target a pure function of its
 * input, which is what makes runs reproducible.
 *
 * A target NEVER performs live WhatsApp/Telegram delivery: it captures the
 * structured AI outcome only. Live-provider execution (network + credentials)
 * is a target implementation detail, opt-in, and out of scope for the offline
 * regression floor.
 */

import type {
  ActualOutcome,
  SystemIdentity,
} from "../schema/evaluation-result-schema";

/** The sender roles a replayed conversation history may contain. */
export type TurnSenderType = "CUSTOMER" | "AI" | "STAFF";

/** One prior message in the conversation, fed to a target as causal context. */
export type TurnHistoryMessage = {
  senderType: TurnSenderType;
  content: string;
};

/** The business knowledge a turn is evaluated against (services + FAQs). */
export type TurnBusinessContext = {
  businessName: string;
  services: ReadonlyArray<{ name: string; durationMinutes?: number | null }>;
  faqs: ReadonlyArray<{ question: string; answer: string }>;
};

/**
 * The provider-neutral input for ONE turn. `history` is the ordered set of
 * messages BEFORE the evaluated `message` (the causal context); `turnIndex` is
 * the message's position in the full conversation. A target must treat this as
 * the complete, bounded context it is allowed to see for the turn.
 */
export type TargetTurnInput = {
  caseId: string;
  turnIndex: number;
  message: string;
  history: ReadonlyArray<TurnHistoryMessage>;
  businessContext: TurnBusinessContext;
};

/**
 * The abstract evaluation target. The only two things a target must publish:
 * its identity (so the run records WHAT was measured) and a `runTurn` that maps
 * one turn's input to a structured `ActualOutcome`. `runTurn` MUST NOT throw:
 * an internal failure is reported as an outcome (`malformed`/handoff class),
 * never as an exception, so one bad case can never abort a dataset run.
 */
export interface EvaluationTarget {
  /** Stable target id, e.g. `current-flowpilot`. Used in reports + run ids. */
  readonly id: string;
  /** The subject identity recorded on the run (EVAL-01 SystemIdentity). */
  readonly systemIdentity: SystemIdentity;
  /** Execute one turn and return its structured outcome. Never throws. */
  runTurn(input: TargetTurnInput): Promise<ActualOutcome>;
}

/** A latency-annotated single-turn result (the runner records timing here). */
export type TurnExecution = {
  turnIndex: number;
  outcome: ActualOutcome;
  /** Wall-clock milliseconds the target took for this turn (diagnostics). */
  latencyMs: number;
};
