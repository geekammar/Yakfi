/**
 * FlowPilot AI Evaluation — dataset version registry.
 *
 * Register each new dataset version here. The generator CLI resolves a
 * builder by version name; the runner CLI reads the generated JSON artifact
 * by version name, so adding `egyptian-v2` touches only this file plus a new
 * dataset directory.
 */

import type { EvaluationDataset } from "../schema/dataset-schema";
import { buildEgyptianV1Dataset } from "./egyptian-v1";

export type DatasetBuilder = () => EvaluationDataset;

export const DATASET_BUILDERS: Record<string, DatasetBuilder> = {
  "egyptian-v1": buildEgyptianV1Dataset,
};

export function resolveDatasetBuilder(version: string): DatasetBuilder {
  const builder = DATASET_BUILDERS[version];
  if (!builder) {
    throw new Error(
      `unknown dataset version "${version}"; register it in evaluation/datasets/index.ts`,
    );
  }
  return builder;
}

export const AVAILABLE_DATASET_VERSIONS = Object.keys(DATASET_BUILDERS);
