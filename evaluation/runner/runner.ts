/**
 * FlowPilot AI Evaluation — the runner (PROMPT-AI-EVAL-03).
 *
 * Orchestrates: select cases → replay each case against the target (preserving
 * multi-turn order + causal context) → score each case → aggregate → assemble a
 * reproducible `EvaluationRun` (EVAL-01 schema).
 *
 * Multi-turn replay: a case's conversation is executed one CUSTOMER turn at a
 * time, in order, feeding each turn the messages BEFORE it as `history`. The
 * evaluated outcome is the LAST customer turn (the dataset's evaluated turn),
 * but every turn is executed so a stateful target sees the real progression and
 * the turn count is honest. A single-turn case therefore invokes the target
 * exactly once.
 *
 * Reproducibility: `runId` is a CONTENT hash of the inputs (dataset version +
 * dataset hash + target identity + evaluator/scoring versions + filter), so two
 * runs of the same deterministic configuration produce byte-identical
 * structured results. `executedAt` is recorded but excluded from the id so a
 * wall-clock timestamp never perturbs repeatability.
 */

import { createHash } from "node:crypto";

import type { EvaluationCase } from "../schema/dataset-schema";
import type {
  EvaluationRun,
  RunIdentity,
} from "../schema/evaluation-result-schema";
import type { CaseFilter } from "./filters";
import { executionMode, selectCases } from "./filters";
import { aggregate } from "./metrics";
import type { ExtendedMetrics } from "./metrics";
import { DEFAULT_SCORERS } from "./scorers";
import type { Scorer } from "./scorers/types";
import { scoreCase } from "./scoring-engine";
import type { ScoredCase } from "./scoring-engine";
import type {
  EvaluationTarget,
  TargetTurnInput,
  TurnExecution,
} from "./target";
import { EVALUATOR_VERSION, SCORING_VERSION } from "./versions";

export type RunnerConfig = {
  datasetVersion: string;
  /** Stable content hash of the dataset artifact (reproducibility). */
  datasetHash: string;
  scenarioVersion?: string;
  seed?: number;
  filter?: CaseFilter;
  scorers?: readonly Scorer[];
  /** Injected clock (defaults to now) so tests can pin `executedAt`. */
  now?: () => Date;
};

/** The full result of a run: the EVAL-01 artifact + the rich scored cases. */
export type RunnerResult = {
  run: EvaluationRun;
  scored: ScoredCase[];
  metrics: ExtendedMetrics;
  mode: string;
  filter: CaseFilter;
  turnExecutions: Map<string, TurnExecution[]>;
  manifest: RunManifest;
};

/** The reproducibility manifest recorded alongside a run. */
export type RunManifest = {
  runId: string;
  datasetVersion: string;
  datasetHash: string;
  scenarioVersion: string | null;
  seed: number | null;
  targetId: string;
  systemIdentity: EvaluationRun["system"];
  evaluatorVersion: string;
  scoringVersion: string;
  executionMode: string;
  filter: CaseFilter;
  executedAt: string;
  totalCases: number;
  totalTurns: number;
};

/** Replay ONE case turn-by-turn against a target; never throws. */
export async function replayCase(
  target: EvaluationTarget,
  c: EvaluationCase,
): Promise<{ executions: TurnExecution[]; evaluatedIndex: number }> {
  const business = {
    businessName: c.businessContext.businessName,
    services: c.businessContext.services,
    faqs: c.businessContext.faqs,
  };
  const executions: TurnExecution[] = [];
  let evaluatedIndex = -1;
  for (let i = 0; i < c.messages.length; i += 1) {
    const msg = c.messages[i]!;
    if (msg.senderType !== "CUSTOMER") continue;
    const history = c.messages.slice(0, i).map((m) => ({
      senderType: m.senderType as "CUSTOMER" | "AI" | "STAFF",
      content: m.content,
    }));
    const input: TargetTurnInput = {
      caseId: c.caseId,
      turnIndex: msg.turnIndex,
      message: msg.content,
      history,
      businessContext: business,
    };
    const started = Date.now();
    const outcome = await target.runTurn(input);
    executions.push({
      turnIndex: msg.turnIndex,
      outcome,
      latencyMs: Date.now() - started,
    });
    evaluatedIndex = executions.length - 1;
  }
  return { executions, evaluatedIndex };
}

/** Run a target over a pre-selected case list. */
export async function runEvaluation(
  target: EvaluationTarget,
  cases: readonly EvaluationCase[],
  config: RunnerConfig,
): Promise<RunnerResult> {
  const filter = config.filter ?? {};
  const scorers = config.scorers ?? DEFAULT_SCORERS;
  const selected = selectCases(cases, filter);
  const mode = executionMode(filter);

  const scored: ScoredCase[] = [];
  const turnExecutions = new Map<string, TurnExecution[]>();
  let totalTurns = 0;
  for (const c of selected) {
    const { executions, evaluatedIndex } = await replayCase(target, c);
    turnExecutions.set(c.caseId, executions);
    totalTurns += executions.length;
    const evaluated =
      evaluatedIndex >= 0
        ? executions[evaluatedIndex]!.outcome
        : { intent: "AMBIGUOUS", action: "handoff", malformed: false };
    scored.push(scoreCase(c, evaluated, scorers));
  }

  const metrics = aggregate(scored, totalTurns);
  const executedAt = (config.now ? config.now() : new Date()).toISOString();

  const runId = computeRunId({
    datasetVersion: config.datasetVersion,
    datasetHash: config.datasetHash,
    targetId: target.id,
    systemIdentity: JSON.stringify(target.systemIdentity),
    filter,
  });

  const run: EvaluationRun = {
    run: buildRunIdentity({
      runId,
      datasetVersion: config.datasetVersion,
      scenarioVersion: config.scenarioVersion,
      executedAt,
    }),
    system: target.systemIdentity,
    metrics,
    caseResults: scored.map((s) => s.record),
  };

  const manifest: RunManifest = {
    runId,
    datasetVersion: config.datasetVersion,
    datasetHash: config.datasetHash,
    scenarioVersion: config.scenarioVersion ?? null,
    seed: config.seed ?? null,
    targetId: target.id,
    systemIdentity: target.systemIdentity,
    evaluatorVersion: EVALUATOR_VERSION,
    scoringVersion: SCORING_VERSION,
    executionMode: mode,
    filter,
    executedAt,
    totalCases: scored.length,
    totalTurns,
  };

  return { run, scored, metrics, mode, filter, turnExecutions, manifest };
}

function buildRunIdentity(args: {
  runId: string;
  datasetVersion: string;
  scenarioVersion?: string;
  executedAt: string;
}): RunIdentity {
  return {
    runId: args.runId,
    datasetVersion: args.datasetVersion,
    scenarioVersion: args.scenarioVersion,
    executedAt: args.executedAt,
    offline: true,
  };
}

/** A deterministic run id: a content hash of the inputs (never the clock). */
export function computeRunId(inputs: {
  datasetVersion: string;
  datasetHash: string;
  targetId: string;
  systemIdentity: string;
  filter: CaseFilter;
}): string {
  const payload = [
    inputs.datasetVersion,
    inputs.datasetHash,
    inputs.targetId,
    inputs.systemIdentity,
    EVALUATOR_VERSION,
    SCORING_VERSION,
    JSON.stringify(sortedFilter(inputs.filter)),
  ].join("|");
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

/** Stable key ordering so an equivalent filter always hashes identically. */
function sortedFilter(filter: CaseFilter): Record<string, unknown> {
  const entries = Object.entries(filter)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(entries);
}

/** A stable content hash of a dataset artifact (for the manifest). */
export function hashDataset(datasetJson: string): string {
  return createHash("sha256").update(datasetJson).digest("hex").slice(0, 32);
}
