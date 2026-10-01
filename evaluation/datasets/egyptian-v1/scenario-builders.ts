/**
 * FlowPilot AI Evaluation — concise scenario builders.
 *
 * Thin factories that fill the verbose `Scenario` defaults so the scenario
 * banks stay readable. The gold label is always explicit; only mechanical
 * defaults (empty arrays, `NONE` handoff) are filled in.
 */

import type {
  CaseBusinessContext,
  ConversationStateExpectation,
  CurrentAiExpectation,
  ExpectedEntities,
  HandoffExpectationObj,
  SemanticLabel,
} from "../../schema/dataset-schema";
import type {
  MutationKind,
  Scenario,
  ScenarioContextTurn,
  Utterance,
} from "../../schema/scenario-schema";
import type {
  CurrentAction,
  CurrentHandoffReason,
  CurrentIntent,
  Difficulty,
  EdgeCategory,
  KnowledgeRequirement,
  Orientation,
  Rarity,
  SemanticIntent,
} from "../../schema/taxonomy";
import { currentIntentValues } from "../../schema/taxonomy";

const NO_ENTITIES: ExpectedEntities = {
  service: null,
  services: [],
  provider: null,
  date: null,
  dates: [],
  timePreference: null,
};

export function entities(partial: Partial<ExpectedEntities>): ExpectedEntities {
  return { ...NO_ENTITIES, ...partial };
}

const NO_HANDOFF: HandoffExpectationObj = {
  expectation: "NOT_REQUIRED",
  kind: "NONE",
  rationale: "",
};

export function handoffRequired(
  kind: HandoffExpectationObj["kind"],
  rationale: string,
): HandoffExpectationObj {
  return { expectation: "REQUIRED", kind, rationale };
}

export function handoffNotRequired(rationale = ""): HandoffExpectationObj {
  return { ...NO_HANDOFF, rationale };
}

export function handoffEither(rationale: string): HandoffExpectationObj {
  return { expectation: "ACCEPTABLE_EITHER", kind: "NONE", rationale };
}

export function semantic(
  primaryIntent: SemanticIntent,
  expectedNextAction: string,
  secondaryIntents: SemanticIntent[] = [],
): SemanticLabel {
  return { primaryIntent, secondaryIntents, expectedNextAction };
}

/**
 * The orientation a scenario's labels REQUIRE (the label-separation rule from
 * `docs/ai/EVALUATION_DESIGN.md` §2): any intent outside the 8 production
 * intents makes the case a `FUTURE_ARCHITECTURE` measurement. Derived here so
 * the two-layer split is structurally guaranteed for every bank — an author
 * cannot forget it, and `groundTruthIsConsistent()` holds for every case.
 */
export function requiredOrientation(label: SemanticLabel): Orientation {
  const used: SemanticIntent[] = [
    label.primaryIntent,
    ...label.secondaryIntents,
  ];
  return used.some(
    (i) => !(currentIntentValues as readonly string[]).includes(i),
  )
    ? "FUTURE_ARCHITECTURE"
    : "BASELINE_COMPATIBLE";
}

export function current(
  intent: CurrentIntent,
  action: CurrentAction,
  handoffReason: CurrentHandoffReason | null = null,
  flags: {
    architecturalLimitation?: boolean;
    fullyHandledByCurrent?: boolean;
  } = {},
): CurrentAiExpectation {
  return {
    intent,
    action,
    handoffReason,
    architecturalLimitation: flags.architecturalLimitation ?? false,
    fullyHandledByCurrent: flags.fullyHandledByCurrent ?? false,
  };
}

export type SingleTurnInput = {
  id: string;
  utterances: Utterance[];
  semanticLabel: SemanticLabel;
  currentAiExpectation: CurrentAiExpectation;
  handoff?: HandoffExpectationObj;
  knowledgeRequirement?: KnowledgeRequirement;
  entities?: ExpectedEntities;
  edgeCategories: EdgeCategory[];
  difficulty: Difficulty;
  rarity?: Rarity;
  orientation?: Orientation;
  mutations?: MutationKind[];
  maxCases?: number;
  businessContext?: CaseBusinessContext;
  engineOwner?: Scenario["engineOwner"];
  rationale: string;
  futureOutcome?: Scenario["futureOutcome"];
  // ── extended ground truth (DESIGN-01; all optional, v1-safe)
  safetyExpectation?: Scenario["safetyExpectation"];
  bookingJourneyState?: Scenario["bookingJourneyState"];
  expectedDomainAction?: Scenario["expectedDomainAction"];
  expectedClarification?: Scenario["expectedClarification"];
  expectedStateTransition?: Scenario["expectedStateTransition"];
  futureArchitectureExpectation?: Scenario["futureArchitectureExpectation"];
  knowledgeSourceAssertion?: Scenario["knowledgeSourceAssertion"];
  customerBehavior?: Scenario["customerBehavior"];
  mutationClass?: Scenario["mutationClass"];
};

const DEFAULT_MUTATIONS: MutationKind[] = [
  "MISSING_HAMZA",
  "DROP_PUNCTUATION",
  "TYPO",
];

export function singleTurn(input: SingleTurnInput): Scenario {
  const orientation = requiredOrientation(input.semanticLabel);
  // The label-separation rule is one-directional: a future-only label REQUIRES
  // `FUTURE_ARCHITECTURE`, but a baseline-labelled case may still OPT IN (its
  // ideal behaviour can be a future capability — memory binding, clarification
  // — even when the intent itself is one of the eight). Only the contradiction
  // is an authoring error.
  if (
    input.orientation === "BASELINE_COMPATIBLE" &&
    orientation !== input.orientation
  ) {
    throw new Error(
      `scenario "${input.id}" sets orientation "BASELINE_COMPATIBLE" but its labels require "${orientation}" (a future-only intent needs FUTURE_ARCHITECTURE)`,
    );
  }
  return {
    id: input.id,
    kind: "SINGLE_TURN",
    semanticLabel: input.semanticLabel,
    currentAiExpectation: input.currentAiExpectation,
    futureOutcome: input.futureOutcome,
    handoff: input.handoff ?? handoffNotRequired(),
    knowledgeRequirement: input.knowledgeRequirement ?? "NONE",
    entities: input.entities ?? NO_ENTITIES,
    utterances: input.utterances,
    contextTurns: [],
    edgeCategories: input.edgeCategories,
    difficulty: input.difficulty,
    rarity: input.rarity ?? "COMMON",
    orientation,
    businessContext: input.businessContext,
    mutations: input.mutations ?? DEFAULT_MUTATIONS,
    engineOwner: input.engineOwner ?? "AI",
    maxCases: input.maxCases ?? 16,
    rationale: input.rationale,
    safetyExpectation: input.safetyExpectation ?? "SAFE",
    mutationClass: input.mutationClass ?? "SURFACE_PRESERVING",
    bookingJourneyState: input.bookingJourneyState,
    expectedDomainAction: input.expectedDomainAction,
    expectedClarification: input.expectedClarification,
    expectedStateTransition: input.expectedStateTransition,
    futureArchitectureExpectation: input.futureArchitectureExpectation,
    knowledgeSourceAssertion: input.knowledgeSourceAssertion,
    customerBehavior: input.customerBehavior,
  };
}

export type MultiTurnInput = Omit<SingleTurnInput, "id"> & {
  id: string;
  contextTurns: ScenarioContextTurn[];
  conversationState?: ConversationStateExpectation;
};

export function multiTurn(input: MultiTurnInput): Scenario {
  const base = singleTurn(input);
  return {
    ...base,
    kind: "MULTI_TURN",
    contextTurns: input.contextTurns,
    conversationState: input.conversationState,
    mutations: input.mutations ?? ["MISSING_HAMZA", "DROP_PUNCTUATION", "TYPO"],
  };
}

export function adversarial(input: SingleTurnInput): Scenario {
  const base = singleTurn(input);
  return {
    ...base,
    kind: "ADVERSARIAL",
    rarity: input.rarity ?? "RARE",
    mutations: input.mutations ?? ["MISSING_HAMZA", "DROP_PUNCTUATION"],
    maxCases: input.maxCases ?? 12,
  };
}

/** Shorthand for a list of Egyptian-colloquial utterances (all CLEAN). */
export function egy(...texts: string[]): Utterance[] {
  return texts.map((text) => ({
    text,
    register: "EGYPTIAN_COLLOQUIAL",
    noise: ["CLEAN"],
  }));
}

/** Utterance with an explicit register/noise tag. */
export function u(
  text: string,
  register: Utterance["register"],
  noise: Utterance["noise"] = ["CLEAN"],
): Utterance {
  return { text, register, noise };
}
