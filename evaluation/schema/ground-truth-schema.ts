/**
 * FlowPilot AI Evaluation — Ground Truth schema (PROMPT-AI-EVAL-DESIGN-01).
 *
 * The canonical GROUND TRUTH read model for one evaluated turn. It is a
 * VIEW over `EvaluationCase`: it does not store anything the case does not
 * already carry, and it treats an absent optional dimension as "not
 * asserted" rather than as a violation. That is what makes it work for
 * BOTH evaluation targets without changing the dataset:
 *
 * - CURRENT system  → the fields the production contract can express
 *   (`primaryIntent`, `expectedAction`, `expectedHandoff`, `requiredKnowledge`,
 *   `expectedEntities`, `expectedStateTransition`, `safetyExpectation`) are
 *   asserted directly against `AiResponse`.
 * - FUTURE system   → the evaluation-only fields (`semanticIntent`,
 *   `secondaryIntents`, `expectedDomainAction`, `expectedClarification`,
 *   `futureArchitectureExpectation`) become assertable. They exist ONLY here,
 *   never in `aiIntentValues` (the production contract is untouched).
 *
 * The twelve required members and where they live:
 *
 *   semantic intent            → semanticIntent
 *   primary intent             → primaryIntent
 *   secondary intent(s)        → secondaryIntents
 *   expected action            → expectedAction
 *   expected handoff           → expectedHandoff
 *   expected clarification     → expectedClarification
 *   required knowledge         → requiredKnowledge
 *   expected entities/facts    → expectedEntities
 *   expected state transition  → expectedStateTransition
 *   expected domain action     → expectedDomainAction
 *   safety expectation         → safetyExpectation
 *   future-architecture        → futureArchitectureExpectation
 */

import type { EvaluationCase } from "./dataset-schema";
import type {
  ClarificationType,
  ExpectedDomainAction,
  SafetyExpectation,
} from "./taxonomy";

/**
 * The shape of the ground truth for one turn. Every field is optional EXCEPT
 * the ones the v1 contract can always express, so an `egyptian-v1` case
 * yields a complete-enough record and an `egyptian-v2` case yields a richer
 * one from the SAME reader.
 */
export type GroundTruth = {
  // ── What the customer means ─────────────────────────────────────────────
  /** The semantic intent — the ideal goal, from the evaluation taxonomy. */
  semanticIntent: string;
  /** The primary intent — the single goal the turn is scored on. */
  primaryIntent: string;
  /** Secondary intents, in priority order (may be empty; unbounded). */
  secondaryIntents: string[];
  /** True when the turn carries more than one goal (multi-intent model). */
  isMultiIntent: boolean;

  // ── What the assistant should do ────────────────────────────────────────
  /** Human-readable next action the ideal assistant takes. */
  expectedAction: string;
  /**
   * The DOMAIN action the ideal assistant drives (evaluation-only; the
   * production `AiAction` family stays `reply` | `handoff` | `booking_handoff`).
   */
  expectedDomainAction: ExpectedDomainAction | null;
  /** The clarification the ideal assistant asks for, or NONE. */
  expectedClarification: ClarificationType;

  // ── Who should own the turn ─────────────────────────────────────────────
  /**
   * The handoff ground truth: REQUIRED / NOT_REQUIRED / ACCEPTABLE_EITHER,
   * with the specific TRUE-handoff kind and a rationale. Independent of
   * what any evaluated system actually does.
   */
  expectedHandoff: {
    expectation: string;
    kind: string;
    rationale: string;
  };

  // ── What the turn needs to know ─────────────────────────────────────────
  requiredKnowledge: string;
  /**
   * The knowledge source backing the ideal answer, plus whether the CURRENT
   * architecture exposes a channel for it (`faqs` / `services` /
   * `availability` / `NONE`). `NONE` for a required fact with no channel is
   * a documented architecture gap, not a dataset defect.
   */
  knowledgeSource: {
    source: string;
    currentChannel: "faqs" | "services" | "availability" | "NONE";
  } | null;

  // ── Facts the turn carries or revises ───────────────────────────────────
  expectedEntities: EvaluationCase["expectedEntities"];
  /** How the turn moves the conversation's state (the multi-turn backbone). */
  expectedStateTransition: {
    from: string | null;
    to: string | null;
    bookingJourneyState: string | null;
    factKey: string | null;
    isRevision: boolean;
  } | null;

  // ── Constraints and future targets ─────────────────────────────────────
  /** The safety/sensitive expectation for the turn. */
  safetyExpectation: SafetyExpectation;
  /**
   * The post-v1 architecture behaviour the turn describes (self-service,
   * clarification, knowledge lookup, confirmation, knowledge-gap recording).
   * Evaluation-only labels; never production behaviour.
   */
  futureArchitectureExpectation: {
    expectSelfService: boolean;
    expectClarification: boolean;
    expectKnowledgeLookup: boolean;
    expectConfirmation: boolean;
    expectKnowledgeGapRecorded: boolean;
  } | null;
};

/**
 * Read the canonical ground truth off a case. Absent optional dimensions
 * collapse to `null` / NONE — never to a violation — so `egyptian-v1` cases
 * (which predate the extended blocks) parse exactly as well as `egyptian-v2`.
 */
export function groundTruthFromCase(c: EvaluationCase): GroundTruth {
  const transition = c.expectedStateTransition ?? null;
  return {
    semanticIntent: c.expectedSemanticLabel.primaryIntent,
    primaryIntent: c.expectedSemanticLabel.primaryIntent,
    secondaryIntents: c.expectedSemanticLabel.secondaryIntents,
    isMultiIntent: c.expectedSemanticLabel.secondaryIntents.length > 0,
    expectedAction: c.expectedSemanticLabel.expectedNextAction,
    expectedDomainAction: c.expectedDomainAction ?? null,
    expectedClarification: c.expectedClarification?.type ?? "NONE",
    expectedHandoff: {
      expectation: c.expectedHandoff.expectation,
      kind: c.expectedHandoff.kind,
      rationale: c.expectedHandoff.rationale,
    },
    requiredKnowledge: c.expectedKnowledgeRequirement,
    knowledgeSource: c.knowledgeSourceAssertion
      ? {
          source: c.knowledgeSourceAssertion.source,
          currentChannel: c.knowledgeSourceAssertion.currentChannel,
        }
      : null,
    expectedEntities: c.expectedEntities,
    expectedStateTransition: transition
      ? {
          from: transition.from ?? null,
          to: transition.to ?? null,
          bookingJourneyState: transition.bookingJourneyState ?? null,
          factKey: transition.factKey ?? null,
          isRevision: transition.isRevision,
        }
      : null,
    safetyExpectation: c.safetyExpectation ?? "SAFE",
    futureArchitectureExpectation: c.futureArchitectureExpectation ?? null,
  };
}

/**
 * Asserts the two layers are kept STRAIGHT: a case whose ground truth uses a
 * future-only semantic intent must carry a `FUTURE_ARCHITECTURE` orientation
 * OR be one of the baseline-compatible intents. Returns false when a case
 * would silently measure a capability the current system does not have.
 */
export function groundTruthIsConsistent(c: EvaluationCase): boolean {
  const baseline = new Set<string>([
    "GREETING",
    "FAQ",
    "BOOKING",
    "AVAILABILITY",
    "RESCHEDULE",
    "CANCELLATION",
    "HUMAN_REQUEST",
    "AMBIGUOUS",
  ]);
  const used = new Set<string>([
    c.expectedSemanticLabel.primaryIntent,
    ...c.expectedSemanticLabel.secondaryIntents,
  ]);
  const usesFutureLabel = [...used].some((i) => !baseline.has(i));
  if (!usesFutureLabel) return true;
  return c.orientation === "FUTURE_ARCHITECTURE";
}
