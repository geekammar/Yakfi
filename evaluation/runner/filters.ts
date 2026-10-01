/**
 * FlowPilot AI Evaluation — case selection / filtering (PROMPT-AI-EVAL-03).
 *
 * One filter object expresses every execution mode the slice requires, so a
 * single runner covers SINGLE_CASE, SCENARIO, CATEGORY, and DATASET without
 * incompatible commands. The mode is DERIVED from which fields are set, and is
 * recorded on the run for reproducibility.
 */

import type { EvaluationCase } from "../schema/dataset-schema";

export type ExecutionMode =
  "SINGLE_CASE" | "SCENARIO" | "CATEGORY" | "FILTERED" | "DATASET";

/** The selection filter. Every field is optional; absent = "no constraint". */
export type CaseFilter = {
  /** Exact case id (SINGLE_CASE). */
  caseId?: string;
  /** Exact scenario id (SCENARIO). */
  scenarioId?: string;
  /** Case must carry this edge category (CATEGORY). */
  edgeCategory?: string;
  /** Semantic primary intent. */
  intent?: string;
  /** Rarity band. */
  rarity?: string;
  /** Language register. */
  language?: string;
  /** Orientation (BASELINE_COMPATIBLE / FUTURE_ARCHITECTURE). */
  orientation?: string;
  /** Cap on the number of cases (applied last; SMOKE runs). */
  limit?: number;
};

/** Derive the execution mode from the filter fields that are set. */
export function executionMode(filter: CaseFilter): ExecutionMode {
  if (filter.caseId) return "SINGLE_CASE";
  if (filter.scenarioId) return "SCENARIO";
  if (filter.edgeCategory) return "CATEGORY";
  if (filter.intent || filter.rarity || filter.language || filter.orientation) {
    return "FILTERED";
  }
  return "DATASET";
}

/** Apply the filter to a case list, preserving dataset order. */
export function selectCases(
  cases: readonly EvaluationCase[],
  filter: CaseFilter,
): EvaluationCase[] {
  let out = cases.filter((c) => {
    if (filter.caseId && c.caseId !== filter.caseId) return false;
    if (filter.scenarioId && c.scenarioId !== filter.scenarioId) return false;
    if (
      filter.edgeCategory &&
      !c.edgeCategories.includes(filter.edgeCategory as never)
    )
      return false;
    if (
      filter.intent &&
      c.expectedSemanticLabel.primaryIntent !== filter.intent
    )
      return false;
    if (filter.rarity && c.rarity !== filter.rarity) return false;
    if (filter.language && c.languageProfile.register !== filter.language)
      return false;
    if (filter.orientation && c.orientation !== filter.orientation)
      return false;
    return true;
  });
  if (typeof filter.limit === "number" && filter.limit >= 0) {
    out = out.slice(0, filter.limit);
  }
  return out;
}
