/**
 * FlowPilot AI Evaluation — scenario → cases compose pipeline.
 *
 * Deterministic expansion of structured scenarios into concrete evaluation
 * cases. The pipeline is pure (no I/O): given the same scenarios + seed it
 * always produces the identical dataset, which is what makes the baseline
 * reproducible.
 *
 *   Scenario (gold-first)
 *     → for each authored Egyptian utterance
 *        → pristine case
 *        → one case per declared gold-preserving mutation (variety-capped)
 *     → attach language profile + edge categories + full message history
 */

import type {
  CaseMessage,
  EvaluationCase,
  LanguageProfile,
} from "../schema/dataset-schema";
import type { Scenario, Utterance } from "../schema/scenario-schema";
import type { ConversationType, NoiseCategory } from "../schema/taxonomy";
import { applyMutation, hashSeed, noiseForMutation } from "./mutations";

function conversationTypeFor(turnCount: number): ConversationType {
  if (turnCount <= 1) return "SINGLE_TURN";
  if (turnCount === 2) return "TWO_TURN";
  if (turnCount <= 5) return "SHORT_MULTI_TURN";
  if (turnCount <= 10) return "MEDIUM_MULTI_TURN";
  return "LONG_MULTI_TURN";
}

function mergeNoise(
  base: readonly NoiseCategory[],
  added: NoiseCategory,
): NoiseCategory[] {
  const set = new Set<NoiseCategory>(base.filter((n) => n !== "CLEAN"));
  set.add(added);
  return [...set];
}

function buildMessages(
  scenario: Scenario,
  evaluatedText: string,
): CaseMessage[] {
  const messages: CaseMessage[] = scenario.contextTurns.map((turn, index) => ({
    senderType: turn.senderType,
    content: turn.text,
    turnIndex: index,
  }));
  messages.push({
    senderType: "CUSTOMER",
    content: evaluatedText,
    turnIndex: messages.length,
  });
  return messages;
}

function defaultBusinessContext(): EvaluationCase["businessContext"] {
  return { businessName: "عيادة الأمل", services: [], faqs: [] };
}

function makeCase(input: {
  scenario: Scenario;
  datasetVersion: string;
  variantKey: string;
  evaluatedText: string;
  language: LanguageProfile;
  mutationsApplied: string[];
}): EvaluationCase {
  const { scenario, datasetVersion, variantKey, evaluatedText } = input;
  const language = input.language;
  const messages = buildMessages(scenario, evaluatedText);
  const conversationType = conversationTypeFor(messages.length);
  const caseId = `${scenario.id}::${variantKey}`;
  const mutated = input.mutationsApplied.length > 0;
  return {
    caseId,
    datasetVersion,
    scenarioId: scenario.id,
    conversationId: `${scenario.id}#${variantKey}`,
    turnId: `${caseId}@t${messages.length - 1}`,
    conversationType,
    messages,
    languageProfile: language,
    difficulty: scenario.difficulty,
    rarity: scenario.rarity,
    orientation: scenario.orientation,
    edgeCategories: scenario.edgeCategories,
    businessContext: scenario.businessContext ?? defaultBusinessContext(),
    expectedSemanticLabel: scenario.semanticLabel,
    expectedCurrentAiOutcome: scenario.currentAiExpectation,
    expectedFutureOutcome: scenario.futureOutcome,
    expectedHandoff: scenario.handoff,
    expectedKnowledgeRequirement: scenario.knowledgeRequirement,
    expectedEntities: scenario.entities,
    expectedConversationState: scenario.conversationState,
    // Extended ground truth: inherited verbatim — a surface-preserving
    // mutation must NOT alter any expectation, by construction.
    expectedClarification: scenario.expectedClarification,
    expectedStateTransition: scenario.expectedStateTransition,
    expectedDomainAction: scenario.expectedDomainAction,
    safetyExpectation: scenario.safetyExpectation ?? "SAFE",
    futureArchitectureExpectation: scenario.futureArchitectureExpectation,
    knowledgeSourceAssertion: scenario.knowledgeSourceAssertion,
    customerBehavior: scenario.customerBehavior,
    rationale: scenario.rationale,
    engineOwner: scenario.engineOwner,
    mutationsApplied: input.mutationsApplied,
    goldPreserved: true,
    variantProvenance: mutated
      ? {
          origin: "SURFACE_MUTATION",
          mutationKind: input.mutationsApplied[0],
          mutationClass: scenario.mutationClass ?? "SURFACE_PRESERVING",
        }
      : { origin: "AUTHORED" },
  };
}

/** Expand ONE scenario into its deterministic set of cases. */
export function expandScenario(
  scenario: Scenario,
  datasetVersion: string,
): EvaluationCase[] {
  const cases: EvaluationCase[] = [];
  const seenText = new Set<string>();
  const emit = (c: EvaluationCase): void => {
    // Variety over volume: never emit two cases with identical evaluated text.
    const key = c.messages[c.messages.length - 1]?.content ?? "";
    if (seenText.has(key)) return;
    seenText.add(key);
    cases.push(c);
  };

  const utterances: Utterance[] =
    scenario.utterances.length > 0
      ? scenario.utterances
      : [
          {
            text: scenario.id,
            register: "EGYPTIAN_COLLOQUIAL",
            noise: ["CLEAN"],
          },
        ];

  let counter = 0;
  for (const [uIndex, utterance] of utterances.entries()) {
    if (cases.length >= scenario.maxCases) break;
    // 1. Pristine case (authored form).
    emit(
      makeCase({
        scenario,
        datasetVersion,
        variantKey: `u${uIndex}`,
        evaluatedText: utterance.text,
        language: { register: utterance.register, noise: utterance.noise },
        mutationsApplied: [],
      }),
    );
    counter += 1;

    // 2. One case per declared mutation (deterministic per-variant seed).
    for (const mutation of scenario.mutations) {
      if (cases.length >= scenario.maxCases) break;
      const seed = hashSeed(`${scenario.id}|${uIndex}|${mutation}`);
      const mutated = applyMutation(mutation, utterance.text, seed);
      if (mutated === utterance.text) continue; // no-op mutation → skip
      // A script-changing mutation also changes the effective register, so
      // the language-robustness view stays truthful.
      const register: LanguageProfile["register"] =
        mutation === "ARABIZI"
          ? "ARABIZI"
          : mutation === "MIX_ENGLISH"
            ? "ARABIC_ENGLISH"
            : utterance.register;
      emit(
        makeCase({
          scenario,
          datasetVersion,
          variantKey: `u${uIndex}_${mutation.toLowerCase()}`,
          evaluatedText: mutated,
          language: {
            register,
            noise: mergeNoise(utterance.noise, noiseForMutation(mutation)),
          },
          mutationsApplied: [mutation],
        }),
      );
      counter += 1;
    }
  }
  void counter;
  return cases;
}

/** Expand ALL scenarios into a flat, order-stable case list. */
export function expandScenarios(
  scenarios: readonly Scenario[],
  datasetVersion: string,
): EvaluationCase[] {
  const all: EvaluationCase[] = [];
  const seenIds = new Set<string>();
  for (const scenario of scenarios) {
    for (const c of expandScenario(scenario, datasetVersion)) {
      if (seenIds.has(c.caseId)) continue;
      seenIds.add(c.caseId);
      all.push(c);
    }
  }
  return all;
}
