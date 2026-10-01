/**
 * FlowPilot AI Evaluation — REAL-LLM baseline runner CLI (PROMPT-AI-EVAL-04B).
 *
 * Measurement ONLY. Drives the CURRENT effective LLM provider/model (resolved
 * from the live platform AI policy) through the production decision flow
 * (bypass → policy-backed LLM → disclosure gate) over the egyptian-v1 dataset,
 * then scores with the UNCHANGED EVAL-03 scoring engine so the result is
 * directly comparable to the EVAL-04 deterministic baseline.
 *
 * It changes NO production behavior: it only wires existing production pieces
 * for offline replay. Real inference happens; nothing is deployed or persisted
 * to the product; keys are read by NAME only and never printed.
 *
 * Execution is RESUMABLE and BOUNDED:
 *   - Phase 1 (expensive): replay each case's turns against the real LLM,
 *     appending each completed case to an NDJSON checkpoint. Re-running skips
 *     cases already in the checkpoint. Concurrency is bounded (`--concurrency`).
 *   - Phase 2 (cheap): replay the recorded outcomes through the standard runner
 *     (identical scoring), and write the machine JSON + markdown + manifest.
 *
 *   pnpm eval:run-real -- --calibration --out <dir>   # CALIBRATION ONLY subset
 *   pnpm eval:run-real -- --out <dir>                 # OFFICIAL full baseline
 *   pnpm eval:run-real -- --score-only --out <dir>    # re-score from checkpoint
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  aiProviderValues,
  type AiProviderId,
  type EffectiveAiPolicy,
} from "@/lib/validation/platform";

import type { CaseFilter } from "../evaluation/runner/filters";
import { executionMode, selectCases } from "../evaluation/runner/filters";
import { createRealLlmRunner } from "../evaluation/runner/real-llm-adapter";
import {
  aggregateFailures,
  writeRunArtifacts,
} from "../evaluation/runner/run-report";
import {
  hashDataset,
  replayCase,
  runEvaluation,
} from "../evaluation/runner/runner";
import type {
  EvaluationTarget,
  TargetTurnInput,
} from "../evaluation/runner/target";
import { RealLlmFlowpilotTarget } from "../evaluation/runner/targets/real-llm-flowpilot";
import type { EvaluationCase } from "../evaluation/schema/dataset-schema";
import { safeParseDataset } from "../evaluation/schema/dataset-schema";
import type {
  ActualOutcome,
  SystemIdentity,
} from "../evaluation/schema/evaluation-result-schema";
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

const DEFAULT_VERSION = "egyptian-v1";

/** A small representative subset that hits every high-signal axis (LLM-bound). */
const CALIBRATION_SCENARIOS = [
  "st-service-discovery", // service discovery (NOT_REQUIRED)
  "mi-booking-plus-discovery", // critical multi-intent + unnecessary handoff
  "kn-service-catalog", // knowledge present, exposure limitation
  "am-bare-booking-clarifiable", // ambiguity + clarification
  "ho-unnecessary-discovery-mid-flow", // unnecessary handoff mid booking
  "ho-customer-requested-human", // REQUIRED handoff
  "ho-sensitive-medical", // safety / REQUIRED handoff
  "lg-arabizi-service-name", // Arabizi
  "jt-goal-stated", // booking journey state
];
const CALIBRATION_PER_SCENARIO = 3;

type Args = {
  version: string;
  filter: CaseFilter;
  out: string;
  checkpoint: string | null;
  concurrency: number;
  calibration: boolean;
  scoreOnly: boolean;
  /**
   * Evaluation-ONLY provider/model override (PROMPT-AI-EVAL-04C). When set, the
   * runner builds the EffectiveAiPolicy directly from these values instead of
   * reading the DB-backed production policy. This measures a specific provider
   * (e.g. `atria`) as a SEPARATE evaluation target WITHOUT mutating the live
   * platform AI policy or Production provider selection. The DB is never read
   * or written for policy when an override is present.
   */
  providerOverride: AiProviderId | null;
  modelOverride: string | null;
  /**
   * Evaluation-ONLY per-attempt timeout override (PROMPT-AI-EVAL-04C). Threads
   * into the EXISTING `AiFactoryEnvDeps.timeoutMs` probe seam so a slow model's
   * genuine inference can complete during measurement instead of being masked by
   * the production per-attempt cap. Changes NO production default (the adapter's
   * built-in cap is used whenever this is unset). Reported in the manifest.
   */
  timeoutMs: number | null;
};

function parseArgs(argv: string[]): Args {
  const filter: CaseFilter = {};
  let version = DEFAULT_VERSION;
  let out = "";
  let checkpoint: string | null = null;
  let concurrency = 8;
  let calibration = false;
  let scoreOnly = false;
  let providerOverride: AiProviderId | null = null;
  let modelOverride: string | null = null;
  let timeoutMs: number | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const [flag, inline] = arg.includes("=")
      ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
      : [arg, undefined];
    const next = () => inline ?? argv[++i];
    switch (flag) {
      case "--dataset":
        version = next() ?? version;
        break;
      case "--case":
        filter.caseId = next();
        break;
      case "--scenario":
        filter.scenarioId = next();
        break;
      case "--category":
        filter.edgeCategory = next();
        break;
      case "--intent":
        filter.intent = next();
        break;
      case "--rarity":
        filter.rarity = next();
        break;
      case "--language":
        filter.language = next();
        break;
      case "--orientation":
        filter.orientation = next();
        break;
      case "--limit": {
        const v = next();
        if (v) filter.limit = Number.parseInt(v, 10);
        break;
      }
      case "--concurrency": {
        const v = next();
        if (v) concurrency = Math.max(1, Number.parseInt(v, 10));
        break;
      }
      case "--out":
        out = next() ?? "";
        break;
      case "--checkpoint":
        checkpoint = next() ?? null;
        break;
      case "--calibration":
        calibration = true;
        break;
      case "--score-only":
        scoreOnly = true;
        break;
      case "--provider": {
        const v = next();
        if (v) {
          if (!(aiProviderValues as readonly string[]).includes(v)) {
            console.error(
              `--provider must be one of: ${aiProviderValues.join(", ")}`,
            );
            process.exit(1);
          }
          providerOverride = v as AiProviderId;
        }
        break;
      }
      case "--model":
        modelOverride = next() ?? null;
        break;
      case "--timeout-ms": {
        const v = next();
        if (v) timeoutMs = Math.max(1000, Number.parseInt(v, 10));
        break;
      }
      default:
        break;
    }
  }
  return {
    version,
    filter,
    out,
    checkpoint,
    concurrency,
    calibration,
    scoreOnly,
    providerOverride,
    modelOverride,
    timeoutMs,
  };
}

/** NDJSON line shape: one completed case. */
type CheckpointLine = {
  caseId: string;
  executions: Array<{ turnIndex: number; outcome: ActualOutcome }>;
  evaluatedIndex: number;
  error?: string;
};

function loadCheckpoint(path: string): Map<string, CheckpointLine> {
  const map = new Map<string, CheckpointLine>();
  if (!existsSync(path)) return map;
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const parsed = JSON.parse(t) as CheckpointLine;
      // The LAST occurrence wins: a re-executed case (e.g. after a provider
      // top-up) appends a fresh line that supersedes an earlier failed one.
      map.set(parsed.caseId, parsed);
    } catch {
      // skip a corrupt trailing line (partial write); it will be re-executed.
    }
  }
  return map;
}

/**
 * A checkpointed case counts as COMPLETE only when it executed cleanly: no
 * error, an evaluated turn, and NO turn ended in a controlled provider/AI
 * failure. Cases that hit the provider quota (HTTP 402 / rate limit) are
 * therefore RE-TRIED on the next run instead of being frozen as failures —
 * this is what makes "wait for a top-up, then resume" correct rather than
 * baking transient provider outages into the baseline.
 */
function isComplete(line: CheckpointLine | undefined): boolean {
  if (!line) return false;
  if (line.error) return false;
  if (line.evaluatedIndex < 0) return false;
  return line.executions.every(
    (e) => e.outcome.source !== "controlled-failure",
  );
}

/** A target that serves recorded outcomes — used for cheap, identical scoring. */
class CachedReplayTarget implements EvaluationTarget {
  readonly id = "real-llm-flowpilot";
  readonly systemIdentity: SystemIdentity;
  private readonly byKey = new Map<string, ActualOutcome>();
  constructor(lines: Iterable<CheckpointLine>, identity: SystemIdentity) {
    this.systemIdentity = identity;
    for (const line of lines) {
      for (const ex of line.executions) {
        this.byKey.set(`${line.caseId}#${ex.turnIndex}`, ex.outcome);
      }
    }
  }
  async runTurn(input: TargetTurnInput): Promise<ActualOutcome> {
    const found = this.byKey.get(`${input.caseId}#${input.turnIndex}`);
    if (found) return found;
    // Missing outcome (should not happen after a complete run) → malformed so
    // it is surfaced, never silently passed.
    return { intent: "AMBIGUOUS", action: "handoff", malformed: true };
  }
}

async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runNext = async (): Promise<void> => {
    while (cursor < items.length) {
      const idx = cursor++;
      await worker(items[idx]!, idx);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, runNext),
  );
}

async function main(): Promise<void> {
  // Env stubs only for values the production boundary reads that are irrelevant
  // to inference (DATABASE_URL / keys come from .env.local, loaded above).
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const args = parseArgs(process.argv.slice(2));
  if (!args.out) {
    console.error("--out <dir> is required");
    process.exit(1);
  }
  const outDir = resolve(process.cwd(), args.out);
  mkdirSync(outDir, { recursive: true });
  const checkpointPath = args.checkpoint
    ? resolve(process.cwd(), args.checkpoint)
    : resolve(outDir, "checkpoint.ndjson");

  // ── dataset ────────────────────────────────────────────────────────────
  const datasetPath = resolve(
    process.cwd(),
    "evaluation/datasets",
    args.version,
    `${args.version}.dataset.json`,
  );
  const raw = readFileSync(datasetPath, "utf8");
  const parsed = safeParseDataset(JSON.parse(raw));
  if (!parsed.success) {
    console.error(`dataset ${args.version} failed validation`);
    process.exit(1);
  }
  const dataset = parsed.data;
  const datasetHash = hashDataset(raw);

  // ── resolve the effective policy (the real subject) ──────────────────────
  // Default: read the live DB-backed production policy (EVAL-04B behavior).
  // Override (EVAL-04C): when --provider is supplied, build the EffectiveAiPolicy
  // DIRECTLY from the flags so a specific provider (e.g. atria) is measured as a
  // SEPARATE evaluation target. This NEVER reads or writes the DB policy and
  // NEVER mutates Production provider selection — the override lives only in
  // this evaluation process. The existing provider adapters (createAtriaAdapter
  // via adaptersFromEffectivePolicy) are reused unchanged.
  let effective: EffectiveAiPolicy | null;
  if (args.providerOverride) {
    if (!args.modelOverride) {
      console.error("--model <id> is required when --provider is supplied");
      process.exit(1);
    }
    effective = {
      primaryProvider: args.providerOverride,
      primaryModel: args.modelOverride,
      // Single-provider measurement (no cross-provider fallback), matching the
      // EVAL-04B CodeCraft target's wiring so the baselines stay comparable.
      secondary: null,
    };
    console.log(
      `  [override] evaluation-only provider policy: ${args.providerOverride}/${args.modelOverride} ` +
        `(DB production policy NOT read, NOT changed)`,
    );
  } else {
    const { getEffectiveAiPolicy } =
      await import("@/server/integrations/ai/factory");
    effective = await getEffectiveAiPolicy();
    if (!effective) {
      console.error(
        "no effective AI policy could be resolved (DB unreachable or INVALID_POLICY). " +
          "Real-LLM baseline requires the live provider policy.",
      );
      process.exit(1);
    }
  }

  const envDeps = {
    getEnvVar: (name: string) => process.env[name],
    fetchImpl: globalThis.fetch as unknown as typeof fetch,
    ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
  };
  const runner = createRealLlmRunner(effective, envDeps);
  const id = runner.identity;

  const systemIdentity: SystemIdentity = {
    kind: "CURRENT_SYSTEM",
    modelProvider: `${id.primaryProvider}/${id.primaryModel}`,
    note: args.providerOverride
      ? `REAL-LLM evaluation target (provider-override, eval-only): bypass → policy-backed LLM (${id.primaryProvider}) → disclosure gate. Production provider policy unchanged.`
      : "REAL-LLM current FlowPilot AI: bypass → policy-backed LLM (live provider) → disclosure gate",
  };

  // ── case selection ───────────────────────────────────────────────────────
  let selected: EvaluationCase[];
  let modeLabel: string;
  if (args.calibration) {
    selected = [];
    for (const sc of CALIBRATION_SCENARIOS) {
      const forScenario = dataset.cases
        .filter((c) => c.scenarioId === sc)
        .slice(0, CALIBRATION_PER_SCENARIO);
      selected.push(...forScenario);
    }
    modeLabel = "CALIBRATION_ONLY";
  } else {
    selected = selectCases(dataset.cases, args.filter);
    modeLabel = executionMode(args.filter);
  }

  // ── PRE-EXECUTION REPORT ─────────────────────────────────────────────────
  console.log("── PRE-EXECUTION REPORT (PROMPT-AI-EVAL-04B) ──");
  console.log(
    `  mode                    : ${modeLabel}${args.calibration ? "  ⟵ NOT the official baseline" : ""}`,
  );
  console.log(
    `  dataset                 : ${args.version} (hash ${datasetHash})`,
  );
  console.log(`  provider (primary)      : ${id.primaryProvider}`);
  console.log(`  model   (primary)       : ${id.primaryModel}`);
  console.log(`  provider (secondary)    : ${id.secondaryProvider ?? "none"}`);
  console.log(`  model    (secondary)    : ${id.secondaryModel ?? "none"}`);
  console.log(`  fallback enabled        : ${id.fallbackEnabled}`);
  console.log(
    `  retry/fallback → extra calls: ${id.fallbackEnabled ? "YES (secondary on retryable)" : "retry only on retryable/timeout; no fallback (secondary=none)"}`,
  );
  console.log(
    `  target identity         : real-llm-flowpilot / ${systemIdentity.modelProvider}`,
  );
  console.log(`  expected evaluated cases: ${selected.length}`);
  console.log(`  real inference          : YES (live provider HTTP calls)`);
  console.log(
    `  per-attempt timeout     : ${args.timeoutMs ? `${args.timeoutMs}ms (eval override)` : "provider default (production cap)"}`,
  );
  console.log(`  concurrency             : ${args.concurrency}`);
  console.log(`  checkpoint              : ${checkpointPath}`);
  console.log("");

  // ── PHASE 1: execution (resumable) ───────────────────────────────────────
  if (!args.scoreOnly) {
    const done = loadCheckpoint(checkpointPath);
    const completeCount = selected.filter((c) =>
      isComplete(done.get(c.caseId)),
    ).length;
    const pending = selected.filter((c) => !isComplete(done.get(c.caseId)));
    console.log(
      `Phase 1 — executing ${pending.length} case(s) (${completeCount} already complete; provider-failed cases will be retried)…`,
    );
    const target = new RealLlmFlowpilotTarget(runner, systemIdentity);
    let completed = 0;
    const startedAt = Date.now();
    await runPool(pending, args.concurrency, async (c) => {
      let line: CheckpointLine;
      try {
        const { executions, evaluatedIndex } = await replayCase(target, c);
        line = {
          caseId: c.caseId,
          evaluatedIndex,
          executions: executions.map((e) => ({
            turnIndex: e.turnIndex,
            outcome: e.outcome,
          })),
        };
      } catch (err) {
        line = {
          caseId: c.caseId,
          evaluatedIndex: -1,
          executions: [],
          error: (err as Error).message.slice(0, 200),
        };
      }
      appendFileSync(checkpointPath, `${JSON.stringify(line)}\n`, "utf8");
      completed += 1;
      if (completed % 25 === 0 || completed === pending.length) {
        const elapsed = (Date.now() - startedAt) / 1000;
        const rate = completed / Math.max(elapsed, 0.001);
        const remaining = (pending.length - completed) / Math.max(rate, 0.001);
        console.log(
          `  ${completed}/${pending.length} cases · ${elapsed.toFixed(0)}s elapsed · ~${remaining.toFixed(0)}s left`,
        );
      }
    });
    console.log("Phase 1 complete.");
  }

  // ── PHASE 2: scoring (cheap, identical to EVAL-04) ───────────────────────
  const checkpoint = loadCheckpoint(checkpointPath);
  const errorCases = [...checkpoint.values()].filter((l) => l.error);
  const incompleteCases = selected.filter(
    (c) => !isComplete(checkpoint.get(c.caseId)),
  );
  const cachedTarget = new CachedReplayTarget(
    checkpoint.values(),
    systemIdentity,
  );
  // Score ONLY the selected cases (so the run's denominators match the mode).
  const result = await runEvaluation(cachedTarget, selected, {
    datasetVersion: args.version,
    datasetHash,
    scenarioVersion: args.version,
    seed: dataset.meta.seed,
    filter: args.calibration ? {} : args.filter,
  });
  const written = writeRunArtifacts(result, outDir);

  const met = result.metrics;
  console.log("");
  console.log(`eval:run-real → ${args.version} (${modeLabel})`);
  console.log(`  run id                 : ${result.run.run.runId}`);
  console.log(
    `  cases / turns          : ${met.totalCases} / ${met.totalTurns}`,
  );
  console.log(
    `  PASS / LIMITATION / FAIL: ${met.passCount} / ${met.limitationCount} / ${met.failCount}`,
  );
  console.log(`  seam-owned (excluded)  : ${met.seamOwnedCount}`);
  console.log(
    `  execution errors       : ${errorCases.length}${
      errorCases.length
        ? ` (${errorCases
            .slice(0, 5)
            .map((e) => e.caseId)
            .join(", ")}…)`
        : ""
    }`,
  );
  console.log(
    `  intent accuracy        : ${(met.intentAccuracy * 100).toFixed(1)}%`,
  );
  console.log(
    `  handoff precision/recall: ${(met.handoffPrecision * 100).toFixed(1)}% / ${(met.handoffRecall * 100).toFixed(1)}%`,
  );
  console.log(
    `  unnecessary handoff rate: ${(met.unnecessaryHandoffRate * 100).toFixed(1)}%`,
  );
  console.log(
    `  malformed output rate  : ${(met.malformedOutputRate * 100).toFixed(1)}%`,
  );
  const failures = aggregateFailures(result.scored);
  if (failures.length > 0) {
    console.log("  top failure categories :");
    for (const f of failures.slice(0, 6)) {
      console.log(`    ${f.category.padEnd(24)} ${f.count}`);
    }
  }
  console.log(`  artifacts              : ${written.jsonPath}`);
  console.log(`                           ${written.markdownPath}`);
  console.log(`                           ${written.manifestPath}`);
  console.log("");
  if (incompleteCases.length === 0) {
    console.log(
      `BASELINE STATUS: COMPLETE — all ${selected.length} selected cases produced genuine LLM/bypass outcomes.`,
    );
  } else {
    console.log(
      `BASELINE STATUS: INCOMPLETE — ${incompleteCases.length}/${selected.length} case(s) still on the provider-failure channel ` +
        `(e.g. codecraft HTTP 402 insufficient_quota). Re-run the SAME command after the balance is topped up; ` +
        `only the incomplete cases are retried (completed cases are skipped).`,
    );
    console.log(
      `  first still-failing case ids: ${incompleteCases
        .slice(0, 8)
        .map((c) => c.caseId)
        .join(", ")}…`,
    );
  }
}

void main();
