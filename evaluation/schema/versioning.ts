/**
 * FlowPilot AI Evaluation — Dataset versioning rules (PROMPT-AI-EVAL-DESIGN-01).
 *
 * The versioning contract that keeps `egyptian-v1` artifacts usable as
 * `egyptian-v2` / `egyptian-v3` are produced — without redesigning the
 * evaluation engine for every version.
 *
 * The three rules that make it work:
 *
 * RULE 1 — the SCHEMA is additive-only. Every extensible sub-object is
 * `.passthrough()`, and every new ground-truth block is OPTIONAL. A field may
 * be ADDED; a field may never be deleted, renamed, or have its type narrowed.
 * `assertDatasetVersion` proves this structurally for a pair of versions.
 *
 * RULE 2 — the RUNNER is version-agnostic. It loads
 * `evaluation/datasets/<version>/<version>.dataset.json` by NAME and reads
 * the case through `groundTruthFromCase()`, which collapses absent
 * dimensions to "not asserted". A new version therefore cannot require an
 * engine change; it can only ADD cases or POPULATE previously-optional
 * fields.
 *
 * RULE 3 — the LABELS are additive-only. A taxonomy value may be added; it
 * may never be removed or renamed. A rename is a NEW value plus the old one
 * retained (the old one marked deprecated in the design doc), because
 * historical reports reference the old spelling by value.
 */

import {
  evaluationCaseSchema,
  evaluationDatasetSchema,
} from "./dataset-schema";

/** The dataset versions currently registered in `evaluation/datasets/index.ts`. */
export const KNOWN_DATASET_VERSIONS = ["egyptian-v1"] as const;

export type DatasetVersion = (typeof KNOWN_DATASET_VERSIONS)[number];

/**
 * The shape of a version id. Enforced so a version is always a stable,
 * sortable, machine-comparable token: `egyptian-v<positive integer>`.
 */
export const DATASET_VERSION_PATTERN = /^egyptian-v(\d+)$/;

/**
 * Is a string a well-formed dataset version id? (Does NOT imply it is
 * registered — registration is `evaluation/datasets/index.ts`.)
 */
export function isValidDatasetVersion(version: string): boolean {
  return DATASET_VERSION_PATTERN.test(version);
}

/** The ordinal of a version id, for "is this newer" comparisons. */
export function versionOrdinal(version: string): number {
  const match = DATASET_VERSION_PATTERN.exec(version);
  if (!match) return -1;
  return Number.parseInt(match[1] ?? "", 10);
}

/** Is `candidate` a strictly newer version than `baseline`? */
export function isNewerThan(candidate: string, baseline: string): boolean {
  return (
    isValidDatasetVersion(candidate) &&
    isValidDatasetVersion(baseline) &&
    versionOrdinal(candidate) > versionOrdinal(baseline)
  );
}

/**
 * The compatibility verdict between two dataset versions.
 * - FORWARD_COMPATIBLE — an older dataset's cases all validate under the
 *   current schema (the common, required case).
 * - INCOMPATIBLE — a case shape the older version produced no longer
 *   validates: a field was removed/renamed/narrowed. This is a DESIGN
 *   FAILURE to fix in the schema, not a data problem to fix in the dataset.
 */
export type CompatibilityVerdict =
  "FORWARD_COMPATIBLE" | "INCOMPATIBLE" | "NOT_A_VERSION";

/**
 * Prove RULE 1 holds for a pair of versions: every case of the OLDER dataset
 * must still validate under the CURRENT (newer) schema. This is the check
 * that catches an accidental breaking change at authoring time, and it is
 * the reason the evaluation engine never needs redesigning per version.
 */
export function assertDatasetVersion(args: {
  olderVersion: string;
  olderCases: unknown[];
}): CompatibilityVerdict {
  if (!isValidDatasetVersion(args.olderVersion)) return "NOT_A_VERSION";
  for (const raw of args.olderCases) {
    if (!evaluationCaseSchema.safeParse(raw).success) {
      return "INCOMPATIBLE";
    }
  }
  return "FORWARD_COMPATIBLE";
}

/**
 * Validate a whole dataset artifact of a named version. Throws a readable
 * error naming the version on the first invalid case.
 */
export function validateDatasetArtifact(args: {
  version: string;
  raw: unknown;
}): void {
  if (!isValidDatasetVersion(args.version)) {
    throw new Error(`not a valid dataset version id: "${args.version}"`);
  }
  const parsed = evaluationDatasetSchema.safeParse(args.raw);
  if (!parsed.success) {
    throw new Error(
      `dataset "${args.version}" failed schema validation: ${parsed.error.message}`,
    );
  }
}

/**
 * The scenario-versioning rule. A scenario id is STABLE FOREVER: its ground
 * truth may be corrected only by a NEW id (with the old one kept and its
 * revision recorded), because a historical report references the id, not the
 * truth. This is what makes a regression in `egyptian-v3` traceable back to
 * the exact `egyptian-v1` scenario it regressed against.
 */
export const SCENARIO_ID_IS_STABLE =
  "A scenario id is immutable. Corrected ground truth is a new id; the old id stays in the bank with its revision recorded.";

/**
 * The case-id rule. A case id is `<scenarioId>::<variantKey>`, so it is
 * globally unique iff both the scenario id and the variant key are. The
 * generator guarantees this; `check:eval` D2 proves it.
 */
export const CASE_ID_FORMAT = "<scenarioId>::<variantKey>";

/** Parse a case id into its scenario id and variant key. */
export function parseCaseId(
  caseId: string,
): { scenarioId: string; variantKey: string } | null {
  const separatorIndex = caseId.indexOf("::");
  if (separatorIndex < 0) return null;
  const scenarioId = caseId.slice(0, separatorIndex);
  const variantKey = caseId.slice(separatorIndex + 2);
  if (scenarioId.length === 0 || variantKey.length === 0) return null;
  return { scenarioId, variantKey };
}

/**
 * The deprecation rule for taxonomy values. A value may be marked
 * deprecated (kept in the vocabulary, excluded from new authoring) but it
 * may never be removed, because historical evaluation reports reference it.
 */
export function isDeprecatedTaxonomyValue(_value: string): boolean {
  // No value is deprecated today. This exists so the deprecation CONTRACT is
  // expressible and checkable from day one, not so anything is deprecated.
  return false;
}

/** The documented migration checklist for adding a new dataset version. */
export const NEW_DATASET_VERSION_STEPS = [
  "mkdir evaluation/datasets/egyptian-v<N>",
  "Add scenario banks + an index.ts exporting collectEgyptianV<N>Scenarios() / buildEgyptianV<N>Dataset()",
  "Register the version in evaluation/datasets/index.ts (DATASET_BUILDERS)",
  "Generate: tsx scripts/eval-generate.ts --dataset egyptian-v<N>",
  "Validate: pnpm check:eval + pnpm check:eval-schema",
  "Baseline: tsx scripts/eval-baseline.ts egyptian-v<N>",
  "Never delete or rename a scenario id; corrected truth is a NEW id",
  "Never remove a taxonomy value; mark it deprecated at most",
] as const;
