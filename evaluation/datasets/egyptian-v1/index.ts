/**
 * FlowPilot AI Evaluation — egyptian-v1 dataset assembly.
 *
 * Collects the scenario banks, validates every scenario against the schema,
 * and expands them into the concrete case list. Pure: no I/O — the CLI
 * writes the JSON artifact.
 *
 * REPRODUCIBILITY CONTRACT (PROMPT-AI-EVAL-02): the banks are ordered so the
 * pre-existing v1.0 scenarios expand FIRST and in their original order. Every
 * case the v1.0 artifact already contained is therefore regenerated at the
 * same position, byte-identically; PROMPT-AI-EVAL-02 banks only APPEND cases.
 * Deleting or reordering a bank would change committed case ids/positions
 * and break historical reports.
 */

import { expandScenarios } from "../../generator/compose";
import { parseScenario } from "../../schema/scenario-schema";
import { adversarialScenarios } from "./scenarios-adversarial";
import { ambiguityScenarios } from "./scenarios-ambiguity";
import { extendedTruthScenarios } from "./scenarios-extended-truth";
import { extraSingleTurnScenarios } from "./scenarios-extra";
import { handoffScenarios } from "./scenarios-handoff";
import { knowledgeScenarios } from "./scenarios-knowledge";
import { languageBehaviorScenarios } from "./scenarios-language-behavior";
import { languageEdgeScenarios } from "./scenarios-language-edges";
import { multiIntentScenarios } from "./scenarios-multi-intent";
import { multiTurnScenarios } from "./scenarios-multi-turn";
import { rareEdgeScenarios } from "./scenarios-rare-edges";
import { singleTurnScenarios } from "./scenarios-single-turn";

export const EGYPTIAN_V1_VERSION = "egyptian-v1";

/**
 * The deterministic generation seed for egyptian-v1. Every mutation derives
 * its own seed from `hashSeed("<scenarioId>|<utteranceIndex>|<mutation>")`,
 * so this single number makes the whole dataset reproducible. Regenerating
 * from the same sources produces the identical artifact byte-for-byte.
 */
export const EGYPTIAN_V1_SEED = 20260928;

/**
 * All scenarios for egyptian-v1, validated. Bank order is load-bearing (see
 * the reproducibility contract above): v1.0 banks first, PROMPT-AI-EVAL-02
 * banks appended.
 */
export function collectEgyptianV1Scenarios() {
  const banks: ReadonlyArray<{ bank: string; items: unknown[] }> = [
    // ── v1.0 banks (unchanged; their cases regenerate identically) ──────────
    { bank: "single-turn", items: singleTurnScenarios },
    { bank: "language-behavior", items: languageBehaviorScenarios },
    { bank: "single-turn-extra", items: extraSingleTurnScenarios },
    { bank: "multi-turn", items: multiTurnScenarios },
    { bank: "adversarial", items: adversarialScenarios },
    // ── PROMPT-AI-EVAL-02 banks (append-only) ──────────────────────────────
    { bank: "multi-intent", items: multiIntentScenarios },
    { bank: "extended-truth", items: extendedTruthScenarios },
    { bank: "knowledge", items: knowledgeScenarios },
    { bank: "ambiguity", items: ambiguityScenarios },
    { bank: "handoff", items: handoffScenarios },
    { bank: "language-edges", items: languageEdgeScenarios },
    { bank: "rare-edges", items: rareEdgeScenarios },
  ];
  const scenarios = [];
  const seen = new Set<string>();
  for (const { bank, items } of banks) {
    for (const item of items) {
      const scenario = parseScenario(item);
      if (seen.has(scenario.id)) {
        throw new Error(`duplicate scenario id: ${scenario.id} (${bank})`);
      }
      seen.add(scenario.id);
      scenarios.push(scenario);
    }
  }
  return scenarios;
}

export function buildEgyptianV1Dataset() {
  const scenarios = collectEgyptianV1Scenarios();
  const cases = expandScenarios(scenarios, EGYPTIAN_V1_VERSION);
  return {
    meta: {
      version: EGYPTIAN_V1_VERSION,
      title: "Egyptian Arabic conversational dataset v1",
      description:
        "Scenario-driven Egyptian customer conversations with structured gold labels: intents, entities, handoff truth, knowledge requirements, and current-AI expectations.",
      seed: EGYPTIAN_V1_SEED,
      generatedFrom: "evaluation/datasets/egyptian-v1/scenarios-*.ts",
    },
    cases,
  };
}
