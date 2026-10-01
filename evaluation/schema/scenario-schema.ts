/**
 * FlowPilot AI Evaluation — Scenario schema.
 *
 * A SCENARIO is the structured source of ground truth. It defines the
 * semantic label FIRST, then the natural Egyptian surface text (utterances
 * or a conversation script). The generator expands one scenario into many
 * cases by attaching language profiles and applying controlled mutations.
 *
 *   Scenario → Gold Label → Natural Egyptian Variants → Conversation
 *   Variants → Noise/Edge Mutations → Validation → Dataset
 *
 * The gold label never comes from an LLM. Utterances are human/deterministic
 * Egyptian phrasings; mutations are deterministic string transforms.
 */

import {
  caseBusinessContextSchema,
  clarificationExpectationSchema,
  conversationStateSchema,
  currentAiExpectationSchema,
  customerBehaviorProfileSchema,
  expectedEntitiesSchema,
  futureArchitectureExpectationSchema,
  futureOutcomeSchema,
  handoffExpectationObjSchema,
  knowledgeSourceAssertionSchema,
  semanticLabelSchema,
  stateTransitionSchema,
} from "./dataset-schema";
import {
  bookingJourneyStateValues,
  difficultyValues,
  edgeCategoryValues,
  expectedDomainActionValues,
  knowledgeRequirementValues,
  languageRegisterValues,
  mutationClassValues,
  noiseCategoryValues,
  orientationValues,
  rarityValues,
  safetyExpectationValues,
} from "./taxonomy";
import { z } from "zod";

/**
 * Named mutation families the generator can apply to a base utterance.
 *
 * ADDITIVE ONLY (see `versioning.ts` RULE 3): a kind may be added; it may
 * never be removed or renamed, because committed datasets carry these names
 * in `mutationsApplied` and in `variantProvenance.mutationKind`.
 */
export const mutationKindValues = [
  "MISSING_HAMZA",
  "DROP_PUNCTUATION",
  "REPEAT_LETTERS",
  "TYPO",
  "ARABIZI",
  "MIX_ENGLISH",
  "INFORMAL_PUNCTUATION",
  "SPEECH_TO_TEXT",
  "ABBREVIATE",
  // ── PROMPT-AI-EVAL-02 additions (all SURFACE_PRESERVING)
  "CHAR_OMISSION",
  "KEYBOARD_MISTAKE",
  "SPACING",
  "PUNCTUATION_DUPLICATION",
  "SPELLING_VARIATION",
  "MIXED_NUMERALS",
] as const;

export type MutationKind = (typeof mutationKindValues)[number];

/**
 * One natural-language surface for a scenario, tagged with its register and
 * the noise it already carries as authored (before generator mutations).
 */
export const utteranceSchema = z
  .object({
    text: z.string().min(1),
    register: z.enum(languageRegisterValues),
    /** Noise present in the AUTHORED text (generator adds more on top). */
    noise: z.array(z.enum(noiseCategoryValues)).default(["CLEAN"]),
  })
  .passthrough();

export type Utterance = z.infer<typeof utteranceSchema>;

/** A prior (context) turn in a multi-turn scenario. */
export const scenarioContextTurnSchema = z
  .object({
    senderType: z.enum(["CUSTOMER", "AI", "STAFF"]),
    text: z.string().min(1),
  })
  .passthrough();

export type ScenarioContextTurn = z.infer<typeof scenarioContextTurnSchema>;

// ─── Scenario ────────────────────────────────────────────────────────────────

export const scenarioSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["SINGLE_TURN", "MULTI_TURN", "ADVERSARIAL"]),

    // ── Ground truth (defined BEFORE any surface text) ───────────────────
    semanticLabel: semanticLabelSchema,
    currentAiExpectation: currentAiExpectationSchema,
    futureOutcome: futureOutcomeSchema,
    handoff: handoffExpectationObjSchema,
    knowledgeRequirement: z.enum(knowledgeRequirementValues),
    entities: expectedEntitiesSchema.default({
      service: null,
      services: [],
      provider: null,
      date: null,
      dates: [],
      timePreference: null,
    }),
    conversationState: conversationStateSchema.optional(),

    // ── Surface text ─────────────────────────────────────────────────────
    /** For SINGLE_TURN / ADVERSARIAL: the evaluated customer utterances. */
    utterances: z.array(utteranceSchema).default([]),
    /** For MULTI_TURN: prior context turns before the evaluated utterance. */
    contextTurns: z.array(scenarioContextTurnSchema).default([]),

    // ── Classification metadata ──────────────────────────────────────────
    edgeCategories: z.array(z.enum(edgeCategoryValues)).min(1),
    difficulty: z.enum(difficultyValues),
    rarity: z.enum(rarityValues).default("COMMON"),
    orientation: z.enum(orientationValues),

    // ── Extended ground truth (optional; the case inherits whatever is set)
    expectedClarification: clarificationExpectationSchema.optional(),
    expectedStateTransition: stateTransitionSchema.optional(),
    expectedDomainAction: z.enum(expectedDomainActionValues).optional(),
    safetyExpectation: z.enum(safetyExpectationValues).default("SAFE"),
    futureArchitectureExpectation:
      futureArchitectureExpectationSchema.optional(),
    knowledgeSourceAssertion: knowledgeSourceAssertionSchema.optional(),
    customerBehavior: customerBehaviorProfileSchema.optional(),

    // ── Business context ─────────────────────────────────────────────────
    businessContext: caseBusinessContextSchema.optional(),

    /**
     * Which engine seam OWNS the evaluated turn. Most turns are owned by the
     * AI boundary; a bare slot selection (index / time / provider name after a
     * numbered offer) is owned by the engine's DETERMINISTIC
     * `tryParseBookingSelection` seam, which runs BEFORE any assistant call.
     * The runner must not score such a turn against the classifier.
     */
    engineOwner: z.enum(["AI", "BOOKING_SELECTION_SEAM"]).default("AI"),

    // ── Generation policy ────────────────────────────────────────────────
    /**
     * Mutations to apply. Each preserves the gold label by construction
     * (class SURFACE_PRESERVING). A mutation class need not be declared
     * here — `mutationClass` is carried on the emitted variant's
     * `variantProvenance` — but declaring it makes the generator's intent
     * explicit and checkable.
     */
    mutations: z.array(z.enum(mutationKindValues)).default([]),
    /**
     * The semantic class of every declared mutation. Mismatch is a harness
     * failure (a SEMANTIC_CHANGING mutation must never be emitted from a
     * scenario whose ground truth it would break — a separate scenario
     * owns the revised truth instead).
     */
    mutationClass: z.enum(mutationClassValues).default("SURFACE_PRESERVING"),
    /**
     * Booking-journey state the conversation is in at the evaluated turn.
     * Lets a bank express the journey's causal progression explicitly
     * (see `bookingJourneyStateValues`).
     */
    bookingJourneyState: z.enum(bookingJourneyStateValues).optional(),
    /** Max cases to emit from this scenario (variety cap). */
    maxCases: z.number().int().positive().default(12),

    rationale: z.string().min(1),
  })
  .passthrough();

export type Scenario = z.infer<typeof scenarioSchema>;

export function parseScenario(raw: unknown): Scenario {
  return scenarioSchema.parse(raw);
}
