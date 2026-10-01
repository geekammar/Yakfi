/**
 * FlowPilot AI Evaluation — Case + Dataset schema (machine-readable).
 *
 * The stable, versioned shape of ONE evaluation case and a whole dataset.
 * Designed to be forward-compatible: unknown future fields are tolerated
 * (`.passthrough()` on the extensible sub-objects) so `egyptian-v2/v3` can
 * add fields without breaking the runner or old datasets.
 *
 * Ground-truth discipline (binding): the semantic gold label
 * (`expectedSemanticLabel`, `expectedEntities`, `expectedHandoff`, …) is
 * defined by structured SCENARIOS, never by an LLM judging itself. An LLM
 * may only help author natural-language surface text; it is never the
 * source of a label.
 */

import {
  bookingJourneyStateValues,
  clarificationTypeValues,
  conversationTypeValues,
  currentActionValues,
  currentHandoffReasonValues,
  currentIntentValues,
  customerChangeOfStateValues,
  customerDispositionValues,
  difficultyValues,
  edgeCategoryValues,
  expectedDomainActionValues,
  handoffExpectationValues,
  handoffKindValues,
  knowledgeRequirementValues,
  knowledgeSourceValues,
  languageRegisterValues,
  mutationClassValues,
  noiseCategoryValues,
  orientationValues,
  rarityValues,
  safetyExpectationValues,
  semanticIntentValues,
} from "./taxonomy";
import { z } from "zod";

// ─── Shared sub-shapes ───────────────────────────────────────────────────────

/** Entities a customer message may carry (the semantic truth). */
export const expectedEntitiesSchema = z
  .object({
    service: z.string().nullable().default(null),
    /** Additional service names when the turn names more than one. */
    services: z.array(z.string()).default([]),
    provider: z.string().nullable().default(null),
    date: z.string().nullable().default(null),
    dates: z.array(z.string()).default([]),
    timePreference: z.string().nullable().default(null),
  })
  .passthrough();

export type ExpectedEntities = z.infer<typeof expectedEntitiesSchema>;

/** One message in a (possibly multi-turn) conversation. */
export const caseMessageSchema = z
  .object({
    senderType: z.enum(["CUSTOMER", "AI", "STAFF"]),
    content: z.string(),
    /** Turn index within the conversation (0-based). */
    turnIndex: z.number().int().min(0),
  })
  .passthrough();

export type CaseMessage = z.infer<typeof caseMessageSchema>;

/** The language/noise fingerprint of the evaluated customer message. */
export const languageProfileSchema = z
  .object({
    register: z.enum(languageRegisterValues),
    noise: z.array(z.enum(noiseCategoryValues)).default(["CLEAN"]),
  })
  .passthrough();

export type LanguageProfile = z.infer<typeof languageProfileSchema>;

/** The gold semantic label — scenario-defined, LLM-independent. */
export const semanticLabelSchema = z
  .object({
    primaryIntent: z.enum(semanticIntentValues),
    secondaryIntents: z.array(z.enum(semanticIntentValues)).default([]),
    /** Human-readable semantic next action the ideal assistant should take. */
    expectedNextAction: z.string(),
  })
  .passthrough();

export type SemanticLabel = z.infer<typeof semanticLabelSchema>;

/**
 * What the CURRENT deterministic architecture is EXPECTED to output for this
 * message (baseline-compatible). `intent`/`action`/`handoffReason` are the
 * production contract values. When the current architecture genuinely cannot
 * represent the customer's goal, this records its BEST achievable behavior
 * and `architecturalLimitation` is set — the case then also demonstrates a
 * gap rather than a bug.
 */
export const currentAiExpectationSchema = z
  .object({
    intent: z.enum(currentIntentValues),
    action: z.enum(currentActionValues),
    handoffReason: z.enum(currentHandoffReasonValues).nullable().default(null),
    /** True when the expected current behavior is a design limitation. */
    architecturalLimitation: z.boolean().default(false),
    /** True when the current AI answers this fully & correctly by design. */
    fullyHandledByCurrent: z.boolean().default(false),
  })
  .passthrough();

export type CurrentAiExpectation = z.infer<typeof currentAiExpectationSchema>;

/** Optional future-architecture target (what a better arch SHOULD do). */
export const futureOutcomeSchema = z
  .object({
    intent: z.enum(semanticIntentValues),
    expectedBehavior: z.string(),
  })
  .passthrough()
  .optional();

/** The handoff ground truth — the mandatory true-vs-unnecessary split. */
export const handoffExpectationObjSchema = z
  .object({
    expectation: z.enum(handoffExpectationValues),
    kind: z.enum(handoffKindValues).default("NONE"),
    /** Why a human is (or is not) genuinely required. */
    rationale: z.string().default(""),
  })
  .passthrough();

export type HandoffExpectationObj = z.infer<typeof handoffExpectationObjSchema>;

/** Multi-turn conversation-state expectation (optional). */
export const conversationStateSchema = z
  .object({
    /** Facts the assistant should be holding by this turn. */
    knownEntities: expectedEntitiesSchema.optional(),
    /** Whether the turn depends on remembering an earlier turn. */
    requiresMemory: z.boolean().default(false),
    /** Expected conversation status after the turn (production enum). */
    expectedStatus: z
      .enum(["AI_ACTIVE", "NEED_HUMAN", "BOOKED", "INCOMPLETE"])
      .optional(),
  })
  .passthrough();

export type ConversationStateExpectation = z.infer<
  typeof conversationStateSchema
>;

// ─── The remaining ground-truth dimensions (PROMPT-AI-EVAL-DESIGN-01) ────────
//
// Every block below is OPTIONAL on the case and on the scenario. That is the
// forward-compatibility contract: `egyptian-v1` cases (which predate them)
// keep validating, `egyptian-v2` may populate them, and
// `groundTruthFromCase()` treats absence as "not asserted" rather than as a
// violation. See `ground-truth-schema.ts` for the canonical read model.

/** Expected clarification — the label future clarification behaviour. */
export const clarificationExpectationSchema = z
  .object({
    /** The kind of clarification the ideal assistant should ask for. */
    type: z.enum(clarificationTypeValues),
    /** The specific question the ideal assistant would ask (Arabic). */
    question: z.string().min(1).optional(),
    /**
     * The missing fact the clarification targets — the entity slot that
     * must be filled before the turn can proceed.
     */
    targets: z
      .array(z.enum(["service", "provider", "date", "timePreference"]))
      .default([]),
  })
  .passthrough();

export type ClarificationExpectation = z.infer<
  typeof clarificationExpectationSchema
>;

/**
 * Expected state transition — the causal backbone of the multi-turn model.
 * It names the FROM and TO journey state and the fact that moved, so a turn
 * is never reduced to an independent message: the evaluation can assert
 * that the state advanced (or that a correction moved it back).
 *
 * Optional fields let `egyptian-v1` validate unchanged while `egyptian-v2`
 * can assert the full causal chain.
 */
export const stateTransitionSchema = z
  .object({
    /** The conversation's state BEFORE the evaluated turn. */
    from: z.enum(bookingJourneyStateValues).optional(),
    /** The state the turn is expected to move the conversation to. */
    to: z.enum(bookingJourneyStateValues).optional(),
    /** The booking-journey state the turn expects (shorthand for `to`). */
    bookingJourneyState: z.enum(bookingJourneyStateValues).optional(),
    /**
     * The fact this turn supplies, revises, or consumes — e.g. the date a
     * customer supplies in the "missing date → date supplied" step.
     */
    factKey: z.enum(["service", "provider", "date", "time", "slot"]).optional(),
    /** Whether the turn revises a fact already on the table. */
    isRevision: z.boolean().default(false),
  })
  .passthrough();

export type StateTransition = z.infer<typeof stateTransitionSchema>;

/**
 * The future-architecture expectation — the system behaviour a turn
 * describes for the post-v1 architecture (clarification routing, JEV
 * routing, knowledge expansion, self-improvement). Evaluation-only labels.
 */
export const futureArchitectureExpectationSchema = z
  .object({
    /** Whether the ideal system routes the turn to itself or a human. */
    expectSelfService: z.boolean().default(true),
    /** Whether the ideal system asks a clarification before acting. */
    expectClarification: z.boolean().default(false),
    /** Whether the ideal system must consult a knowledge source first. */
    expectKnowledgeLookup: z.boolean().default(false),
    /**
     * Whether the ideal system must confirm a selection before executing
     * (the booking confirmation step).
     */
    expectConfirmation: z.boolean().default(false),
    /**
     * Whether the ideal system should record a knowledge-gap observation
     * for the self-improvement loop (see `self-improvement-schema.ts`).
     */
    expectKnowledgeGapRecorded: z.boolean().default(false),
  })
  .passthrough();

export type FutureArchitectureExpectation = z.infer<
  typeof futureArchitectureExpectationSchema
>;

/**
 * The knowledge-provenance assertion for a case: which knowledge source
 * backs the ideal answer, and whether the current architecture exposes it
 * through `AiRequest` at all. Separate from `expectedKnowledgeRequirement`
 * (what the turn NEEDS) — this asserts what the context SUPPLIES.
 */
export const knowledgeSourceAssertionSchema = z
  .object({
    source: z.enum(knowledgeSourceValues).default("NONE"),
    /**
     * The `AiRequest` channel the current architecture would carry the
     * fact through (`faqs`, `services`, `availability`), or `NONE` when a
     * required fact has no channel yet (a documented architecture gap).
     */
    currentChannel: z
      .enum(["faqs", "services", "availability", "NONE"])
      .default("NONE"),
  })
  .passthrough();

export type KnowledgeSourceAssertion = z.infer<
  typeof knowledgeSourceAssertionSchema
>;

/**
 * The customer-behavior profile of the turn — disposition (HOW the customer
 * behaves) plus change-of-state (whether they revise a fact already on the
 * table). Optional on v1 cases; v2+ banks populate it explicitly.
 */
export const customerBehaviorProfileSchema = z
  .object({
    dispositions: z.array(z.enum(customerDispositionValues)).default([]),
    changeOfState: z.enum(customerChangeOfStateValues).default("NONE"),
  })
  .passthrough();

export type CustomerBehaviorProfile = z.infer<
  typeof customerBehaviorProfileSchema
>;

/** A variant's provenance — how this natural-language surface was produced. */
export const variantProvenanceSchema = z
  .object({
    /** How the surface text came to be. */
    origin: z
      .enum(["AUTHORED", "SURFACE_MUTATION", "SEMANTIC_MUTATION"])
      .default("AUTHORED"),
    /** The mutation kind, when `origin` is a mutation. */
    mutationKind: z.string().optional(),
    /** The semantic class of the mutation (see `mutationClassValues`). */
    mutationClass: z.enum(mutationClassValues).optional(),
    /**
     * The scenario id whose ground truth the variant inherits when the
     * mutation is semantic-changing (the label moved WITH the meaning).
     */
    inheritsTruthFrom: z.string().optional(),
  })
  .passthrough();

export type VariantProvenance = z.infer<typeof variantProvenanceSchema>;

/** Business context a case is evaluated against (services + FAQs). */
export const caseBusinessContextSchema = z
  .object({
    businessName: z.string().default("عيادة الأمل"),
    services: z
      .array(
        z.object({
          name: z.string(),
          durationMinutes: z.number().int().positive().optional(),
        }),
      )
      .default([]),
    faqs: z
      .array(z.object({ question: z.string(), answer: z.string() }))
      .default([]),
  })
  .passthrough();

export type CaseBusinessContext = z.infer<typeof caseBusinessContextSchema>;

// ─── The case ────────────────────────────────────────────────────────────────

export const evaluationCaseSchema = z
  .object({
    caseId: z.string().min(1),
    datasetVersion: z.string().min(1),
    scenarioId: z.string().min(1),
    conversationId: z.string().min(1),
    /** Turn under evaluation — the LAST customer message in `messages`. */
    turnId: z.string().min(1),
    conversationType: z.enum(conversationTypeValues),

    /** Full conversation up to and including the evaluated customer turn. */
    messages: z.array(caseMessageSchema).min(1),

    languageProfile: languageProfileSchema,
    difficulty: z.enum(difficultyValues),
    rarity: z.enum(rarityValues).default("COMMON"),
    orientation: z.enum(orientationValues),
    edgeCategories: z.array(z.enum(edgeCategoryValues)).min(1),

    /** Business context the case runs against. */
    businessContext: caseBusinessContextSchema,

    // ── Expectations (ground truth) ──────────────────────────────────────
    expectedSemanticLabel: semanticLabelSchema,
    expectedCurrentAiOutcome: currentAiExpectationSchema,
    expectedFutureOutcome: futureOutcomeSchema,
    expectedHandoff: handoffExpectationObjSchema,
    expectedKnowledgeRequirement: z.enum(knowledgeRequirementValues),
    expectedEntities: expectedEntitiesSchema,
    expectedConversationState: conversationStateSchema.optional(),

    // ── Extended ground truth (PROMPT-AI-EVAL-DESIGN-01; optional so v1
    //    datasets keep validating — see ground-truth-schema.ts) ───────────
    expectedClarification: clarificationExpectationSchema.optional(),
    expectedStateTransition: stateTransitionSchema.optional(),
    expectedDomainAction: z.enum(expectedDomainActionValues).optional(),
    safetyExpectation: z.enum(safetyExpectationValues).default("SAFE"),
    futureArchitectureExpectation:
      futureArchitectureExpectationSchema.optional(),
    knowledgeSourceAssertion: knowledgeSourceAssertionSchema.optional(),
    customerBehavior: customerBehaviorProfileSchema.optional(),

    // ── Explainability metadata ──────────────────────────────────────────
    /** WHY this case exists / what edge it tests. */
    rationale: z.string().min(1),
    /** Which engine seam owns the turn (see scenario schema). */
    engineOwner: z.enum(["AI", "BOOKING_SELECTION_SEAM"]).default("AI"),

    /** Mutations applied to the base utterance (empty = pristine). */
    mutationsApplied: z.array(z.string()).default([]),
    /** Whether mutations preserved the gold label (false = intentional shift). */
    goldPreserved: z.boolean().default(true),
    /** Provenance of this variant's surface text. */
    variantProvenance: variantProvenanceSchema.optional(),
  })
  .passthrough();

export type EvaluationCase = z.infer<typeof evaluationCaseSchema>;

// ─── The dataset ─────────────────────────────────────────────────────────────

export const datasetMetaSchema = z
  .object({
    version: z.string().min(1),
    title: z.string().min(1),
    description: z.string().default(""),
    /** Deterministic generation seed (reproducibility). */
    seed: z.number().int(),
    generatedFrom: z.string().default("scenarios"),
  })
  .passthrough();

export const evaluationDatasetSchema = z
  .object({
    meta: datasetMetaSchema,
    cases: z.array(evaluationCaseSchema),
  })
  .passthrough();

export type EvaluationDataset = z.infer<typeof evaluationDatasetSchema>;

/** Parse + validate a raw dataset; throws with a readable error on failure. */
export function parseDataset(raw: unknown): EvaluationDataset {
  return evaluationDatasetSchema.parse(raw);
}

/** Non-throwing dataset validation for harnesses. */
export function safeParseDataset(
  raw: unknown,
): z.ZodSafeParseResult<EvaluationDataset> {
  return evaluationDatasetSchema.safeParse(raw);
}
