/**
 * FlowPilot AI Evaluation — failure taxonomy aggregation (PROMPT-AI-EVAL-03).
 *
 * The failure taxonomy is the CLOSED `failureCategoryValues` set (EVAL-01,
 * extended additively by this slice). This module aggregates scored cases into
 * that taxonomy so the report can answer "what broke, and how often" with
 * traceable sample case ids, without inventing ad-hoc buckets.
 *
 * Keeping the categories closed is what makes runs comparable across dataset
 * and system versions; unknown/new values are tolerated (the map is keyed by
 * string) so a future scorer's new category never breaks aggregation.
 */

import { failureCategoryValues } from "../schema/taxonomy";
import type { FailureCategory } from "../schema/taxonomy";
import type { ScoredCase } from "./scoring-engine";

export type FailureBucket = {
  category: string;
  count: number;
  /** Up to five case ids, for traceability back to the dataset. */
  sampleCaseIds: string[];
};

/** Aggregate FAIL verdicts by failure category (descending by count). */
export function aggregateFailures(scored: ScoredCase[]): FailureBucket[] {
  const map = new Map<string, FailureBucket>();
  for (const s of scored) {
    if (s.record.verdict !== "FAIL") continue;
    const category = s.record.failureCategory;
    const bucket = map.get(category) ?? {
      category,
      count: 0,
      sampleCaseIds: [],
    };
    bucket.count += 1;
    if (bucket.sampleCaseIds.length < 5)
      bucket.sampleCaseIds.push(s.record.caseId);
    map.set(category, bucket);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

/** The full closed taxonomy with zero-filled counts (stable report ordering). */
export function failureTaxonomyTable(scored: ScoredCase[]): FailureBucket[] {
  const found = new Map(aggregateFailures(scored).map((b) => [b.category, b]));
  return (failureCategoryValues as readonly FailureCategory[])
    .filter((c) => c !== "NONE")
    .map(
      (category) =>
        found.get(category) ?? { category, count: 0, sampleCaseIds: [] },
    );
}
