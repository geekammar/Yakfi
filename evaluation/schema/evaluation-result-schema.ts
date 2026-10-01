/**
 * FlowPilot AI Evaluation — Evaluation Result schema (PROMPT-AI-EVAL-DESIGN-01).
 *
 * The machine-readable outcome of running ONE SYSTEM against ONE DATASET.
 * Its job is comparability: the same dataset must be able to score the
 * CURRENT system and a FUTURE system WITHOUT the dataset changing, and a
 * `egyptian-v3` run must be diffable against a `egyptian-v1` run.
 *
 * That is achieved by two design rules:
 *
 * 1. The SUBJECT is fully identified by a version tuple (dataset / scenario
 *    / system / prompt / model / router) carried on the run — never implied
 *    by the dataset. Every identity component is OPTIONAL except the kind,
 *    so a minimal offline run (deterministic classifier, no provider, no
 *    router) still validates.
 * 2. The ground truth is never re-derived at scoring time — it is READ from
 *    the case via `groundTruthFromCase`. The result only records expected /
 *    actual / verdict / failure category, so a dataset version bump can
 *    never silently re-label history.
 */

import {
  failureCategoryValues,
  handoffOutcomeClassValues,
  systemKindValues,
} from "./taxonomy";
import { z } from "zod";

/**
 * What was evaluated. `kind` is the only required member: CURRENT_SYSTEM for
 * the shipped production chain, FUTURE_SYSTEM for an experimental
 * architecture (a new router, a clarification step, JEV routing). The rest
 * pins the exact build so two runs are comparable or knowingly not.
 */
export const systemIdentitySchema = z.object({
  kind: z.enum(systemKindValues),
  /** FlowPilot release tag (e.g. `v0.31.8`) — CURRENT_SYSTEM only. */
  systemVersion: z.string().min(1).optional(),
  /** Prompt workspace version (the `@vN` family, e.g. `booking-intent@v1`). */
  promptVersion: z.string().min(1).optional(),
  /** Provider + model, e.g. `codecraft/deepseek-v4-flash-0731`. */
  modelProvider: z.string().min(1).optional(),
  /** Router version — the intent/escalation routing layer. */
  routerVersion: z.string().min(1).optional(),
  /** Knowledge/context builder version (B-02) if the run varies it. */
  contextBuilderVersion: z.string().min(1).optional(),
  /** Free-form note (must never carry a secret or a key shape). */
  note: z.string().max(500).optional(),
});

export type SystemIdentity = z.infer<typeof systemIdentitySchema>;

/**
 * The version tuple that makes a run replayable and diffable. The dataset
 * and scenario versions are recorded SEPARATELY because a scenario bank may
 * be revised within the same dataset version (a scenario is versioned by id
 * + a revision suffix, never by reusing an id with different truth).
 */
export const runIdentitySchema = z.object({
  /** An opaque run id (uuid or a content hash of the inputs). */
  runId: z.string().min(1),
  /** The dataset artifact version, e.g. `egyptian-v1`. */
  datasetVersion: z.string().min(1),
  /** Scenario bank revision the cases were generated from. */
  scenarioVersion: z.string().min(1).optional(),
  /** ISO timestamp of the run (UTC). */
  executedAt: z.string().min(1),
  /** Whether the run was offline (no DB/network/LLM/keys). */
  offline: z.boolean().default(true),
});

export type RunIdentity = z.infer<typeof runIdentitySchema>;

/**
 * The ACTUAL outcome a system produced for one case — the mirror of the
 * ground truth, expressed in the SAME terms so the comparison is symmetric.
 * Every member is optional because a future system may not emit a
 * production intent at all (it may emit a clarification action instead);
 * absence means "the system made no assertion on this axis".
 */
export const actualOutcomeSchema = z
  .object({
    intent: z.string().optional(),
    action: z.string().optional(),
    handoffReason: z.string().nullable().optional(),
    /** What the system actually replied (bounded; never a chain-of-thought). */
    content: z.string().optional(),
    /** Extracted facts the system surfaced. */
    extraction: z
      .object({
        service: z.string().nullable().optional(),
        provider: z.string().nullable().optional(),
        date: z.string().nullable().optional(),
        timePreference: z.string().nullable().optional(),
      })
      .optional(),
    /**
     * The classification of the handoff the system produced, by WHY the
     * human got involved. Scored separately from pass/fail.
     */
    handoffOutcomeClass: z.enum(handoffOutcomeClassValues).optional(),
    /** Which engine seam produced the turn. */
    source: z.string().optional(),
    /** The disclosure gate verdict, when the system is the current one. */
    disclosure: z.enum(["disclosed", "requires-human"]).optional(),
    /** True when the output violated the response contract. */
    malformed: z.boolean().optional(),
    // ── Target-architecture observables (PROMPT-AI-ARCH-02, Slice 0) ────────
    // Additive and OPTIONAL: a future system may populate them; the current
    // system leaves them absent (it emits no goals/clarification/cause). The
    // object stays `.passthrough()`, so an unlisted future observable is
    // never dropped. Deliberately loose types — the evaluation boundary must
    // not force the future production enums before their slices land.
    goals: z.array(z.unknown()).optional(),
    turnPlan: z.unknown().optional(),
    clarification: z.unknown().optional(),
    handoffCause: z.string().optional(),
    factUpdates: z.array(z.unknown()).optional(),
    knowledgeSourceClass: z.array(z.string()).optional(),
    routingDecision: z.string().optional(),
    stateTransition: z.unknown().optional(),
  })
  .passthrough();

export type ActualOutcome = z.infer<typeof actualOutcomeSchema>;

/**
 * One case-level result. The ground truth is carried by reference (`caseId`
 * + `expected` snapshot) so a report stays interpretable even after the
 * dataset moves on.
 */
export const caseResultRecordSchema = z
  .object({
    caseId: z.string().min(1),
    scenarioId: z.string().min(1),
    /** The dataset version the case belongs to. */
    datasetVersion: z.string().min(1),
    /** Snapshot of the ground truth as asserted by this run. */
    expected: z
      .object({
        primaryIntent: z.string(),
        secondaryIntents: z.array(z.string()),
        expectedAction: z.string(),
        handoffExpectation: z.string(),
        safetyExpectation: z.string(),
      })
      .passthrough(),
    /** What the system actually did. */
    actual: actualOutcomeSchema,
    /** PASS / LIMITATION / FAIL / SEAM_OWNED (SEAM_OWNED = engine-owned turn). */
    verdict: z.enum(["PASS", "LIMITATION", "FAIL", "SEAM_OWNED"]),
    /** Why the verdict is what it is; NONE only for PASS/SEAM_OWNED. */
    failureCategory: z.enum(failureCategoryValues),
    /** A short traceable reason (never customer content, never a secret). */
    reason: z.string().max(500).default(""),
  })
  .passthrough();

export type CaseResultRecord = z.infer<typeof caseResultRecordSchema>;

/**
 * The aggregate metrics a run reports. Kept flat and additive — a future
 * metric is a new field, never a redefinition — so two runs across dataset
 * versions remain row-comparable on the metrics they share.
 */
export const aggregateMetricsSchema = z
  .object({
    totalCases: z.number().int().min(0),
    scoredCases: z.number().int().min(0),
    passCount: z.number().int().min(0),
    limitationCount: z.number().int().min(0),
    failCount: z.number().int().min(0),
    seamOwnedCount: z.number().int().min(0),
    intentAccuracy: z.number().min(0).max(1),
    intentAccuracyLimitationAdjusted: z.number().min(0).max(1),
    actionAccuracy: z.number().min(0).max(1),
    handoffPrecision: z.number().min(0).max(1),
    handoffRecall: z.number().min(0).max(1),
    unnecessaryHandoffRate: z.number().min(0).max(1),
    missedHandoffRate: z.number().min(0).max(1),
    safetyViolationRate: z.number().min(0).max(1),
    malformedOutputRate: z.number().min(0).max(1),
    /** Per-class handoff outcome counts (the separate failure channels). */
    handoffOutcomeClasses: z
      .record(z.string(), z.number().int().min(0))
      .default({}),
  })
  .passthrough();

export type AggregateMetrics = z.infer<typeof aggregateMetricsSchema>;

/**
 * A whole run: identity × subject × per-case results × aggregates. This is
 * the artifact a comparison consumes.
 */
export const evaluationRunSchema = z.object({
  run: runIdentitySchema,
  system: systemIdentitySchema,
  metrics: aggregateMetricsSchema,
  caseResults: z.array(caseResultRecordSchema),
});

export type EvaluationRun = z.infer<typeof evaluationRunSchema>;

/**
 * The comparison contract: score one system against another over the SAME
 * dataset, or one system across two dataset versions. Only the case ids the
 * two runs SHARE are compared — a case added in v2 is reported as an
 * addition, never as a regression in v1's numbers.
 */
export const runComparisonSchema = z.object({
  baseline: z.object({
    runId: z.string().min(1),
    systemVersion: z.string().min(1).optional(),
    datasetVersion: z.string().min(1),
  }),
  candidate: z.object({
    runId: z.string().min(1),
    systemVersion: z.string().min(1).optional(),
    datasetVersion: z.string().min(1),
  }),
  /** Case ids present in both runs (the comparable set). */
  sharedCaseIds: z.array(z.string()).default([]),
  /** Case ids only in the candidate (dataset growth). */
  addedCaseIds: z.array(z.string()).default([]),
  /** Per-metric deltas: positive = candidate better. */
  deltas: z.record(z.string(), z.number()).default({}),
  /** Case ids whose verdict got worse (regressions to triage first). */
  regressions: z.array(z.string()).default([]),
  /** Case ids whose verdict got better. */
  improvements: z.array(z.string()).default([]),
});

export type RunComparison = z.infer<typeof runComparisonSchema>;

// ── Parsing helpers ───────────────────────────────────────────────────────────

/** Parse + validate a full run; throws with a readable error on failure. */
export function parseEvaluationRun(raw: unknown): EvaluationRun {
  return evaluationRunSchema.parse(raw);
}

/** Non-throwing run validation for harnesses. */
export function safeParseEvaluationRun(
  raw: unknown,
): z.ZodSafeParseResult<EvaluationRun> {
  return evaluationRunSchema.safeParse(raw);
}

/**
 * Build a comparison from two runs. The comparison is computed ONLY over the
 * shared case ids, so a dataset version bump cannot manufacture regressions
 * from cases the baseline never contained.
 */
export function compareRuns(
  baseline: EvaluationRun,
  candidate: EvaluationRun,
): RunComparison {
  const baselineById = new Map(
    baseline.caseResults.map((r) => [r.caseId, r] as const),
  );
  const candidateById = new Map(
    candidate.caseResults.map((r) => [r.caseId, r] as const),
  );
  const shared: string[] = [];
  const added: string[] = [];
  const regressions: string[] = [];
  const improvements: string[] = [];
  for (const [caseId, candidateResult] of candidateById) {
    const baselineResult = baselineById.get(caseId);
    if (!baselineResult) {
      added.push(caseId);
      continue;
    }
    shared.push(caseId);
    const delta =
      verdictRank(candidateResult.verdict) -
      verdictRank(baselineResult.verdict);
    if (delta < 0) regressions.push(caseId);
    else if (delta > 0) improvements.push(caseId);
  }
  const deltas: Record<string, number> = {};
  const metricKeys: (keyof AggregateMetrics)[] = [
    "intentAccuracy",
    "intentAccuracyLimitationAdjusted",
    "actionAccuracy",
    "handoffPrecision",
    "handoffRecall",
    "unnecessaryHandoffRate",
    "missedHandoffRate",
    "safetyViolationRate",
    "malformedOutputRate",
  ];
  for (const key of metricKeys) {
    const b = baseline.metrics[key];
    const c = candidate.metrics[key];
    if (typeof b === "number" && typeof c === "number") {
      // For the two "lower is better" rates, a positive delta must mean
      // "candidate better", so the sign is flipped.
      const inverted =
        key === "unnecessaryHandoffRate" ||
        key === "missedHandoffRate" ||
        key === "safetyViolationRate" ||
        key === "malformedOutputRate";
      deltas[key] = inverted ? b - c : c - b;
    }
  }
  return {
    baseline: {
      runId: baseline.run.runId,
      systemVersion: baseline.system.systemVersion,
      datasetVersion: baseline.run.datasetVersion,
    },
    candidate: {
      runId: candidate.run.runId,
      systemVersion: candidate.system.systemVersion,
      datasetVersion: candidate.run.datasetVersion,
    },
    sharedCaseIds: shared,
    addedCaseIds: added,
    deltas,
    regressions,
    improvements,
  };
}

/** Verdict ordering used only for regression detection (higher = better). */
function verdictRank(verdict: CaseResultRecord["verdict"]): number {
  switch (verdict) {
    case "PASS":
      return 2;
    case "LIMITATION":
      return 1;
    case "SEAM_OWNED":
      return 1;
    case "FAIL":
      return 0;
  }
}
