/**
 * FlowPilot AI Evaluation — FUTURE_SYSTEM real-LLM CLARIFY bridge runner CLI
 * (PROMPT-AI-EVAL-06).
 *
 * Measurement ONLY. Drives the REAL configured provider/model THROUGH the real
 * Conversation Engine (`receiveInboundMessage`) so a turn actually traverses
 * resolveTurnPlan() + first-class CLARIFY + ConversationState (Slices 0–4),
 * then scores with the UNCHANGED EVAL-03 scoring engine and ADDITIONALLY
 * measures CLARIFY emission from the ACTUAL observed resolver-owned decision.
 *
 * It changes NO production behavior and mutates NO production data: the engine
 * runs against ISOLATED in-memory repositories (no appointment/booking/customer
 * /conversation/provider/tenant persistence ever reaches a database). Real
 * inference happens; nothing is deployed. Keys are read by NAME only and never
 * printed.
 *
 *   pnpm eval:run-future -- --calibration --out <dir>  # CALIBRATION (2 cases)
 *   pnpm eval:run-future -- --out <dir>                # focused CLARIFY subset
 *   pnpm eval:run-future -- --provider atria --model <id> --out <dir>
 *
 * This CLI STOPS and reports a BLOCKER if the configured provider is
 * unavailable — it never silently falls back to a mock or the deterministic
 * classifier (that would make the measurement meaningless).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  aiProviderValues,
  type AiProviderId,
  type EffectiveAiPolicy,
} from "@/lib/validation/platform";
import { createLlmConversationAi } from "@/server/integrations/ai/conversation-ai";
import {
  adaptersFromEffectivePolicy,
  type AiFactoryEnvDeps,
} from "@/server/integrations/ai/factory";

import {
  aggregateClarify,
  measureClarifyEmission,
  type ClarifyEmissionMeasurement,
} from "../evaluation/runner/clarify-measure";
import { createFutureSystemRunner } from "../evaluation/runner/future-system-adapter";
import { writeRunArtifacts } from "../evaluation/runner/run-report";
import { hashDataset, runEvaluation } from "../evaluation/runner/runner";
import { FutureSystemFlowpilotTarget } from "../evaluation/runner/targets/future-system-flowpilot";
import {
  EVALUATOR_VERSION,
  SCORING_VERSION,
} from "../evaluation/runner/versions";
import type { EvaluationCase } from "../evaluation/schema/dataset-schema";
import { safeParseDataset } from "../evaluation/schema/dataset-schema";
import type { SystemIdentity } from "../evaluation/schema/evaluation-result-schema";
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

const DEFAULT_VERSION = "egyptian-v1";

/**
 * The focused CLARIFY-axis subset (recorded verbatim in the manifest). Each id
 * covers one of the required axes (TARGET_ARCHITECTURE §7 / the brief). The
 * subset is additive-read-only — the canonical dataset is NEVER modified.
 */
const FOCUS_CASE_IDS: ReadonlyArray<{ caseId: string; axis: string }> = [
  { caseId: "am-bare-booking-clarifiable::u0", axis: "ambiguous booking" },
  { caseId: "jt-missing-service::u0", axis: "missing service" },
  { caseId: "jt-missing-date::u0", axis: "missing date" },
  {
    caseId: "st-service-discovery::u0",
    axis: "answerable-without-clarification",
  },
  { caseId: "ho-customer-requested-human::u0", axis: "explicit human request" },
  { caseId: "ho-sensitive-medical::u0", axis: "sensitive/restricted" },
  { caseId: "ho-empty-knowledge-gap::u0", axis: "knowledge gap" },
  {
    caseId: "ho-ambiguous-but-clarifiable-multi-turn::u0",
    axis: "multi-turn clarification",
  },
  {
    caseId: "am-context-resolves-service::u0",
    axis: "clarification answer / resume",
  },
  { caseId: "mt-topic-return::u0", axis: "topic return" },
  { caseId: "st-ambiguous-oneword::u0", axis: "Egyptian colloquial ambiguity" },
  {
    caseId: "lg-spelling-variation-service::u0",
    axis: "Arabic spelling/noise",
  },
  { caseId: "jt-interrupted::u0", axis: "interruption after clarification" },
  { caseId: "st-ambiguous-idk::u0", axis: "clarifiable ambiguity" },
];

/** The smallest calibration gate: one non-CLARIFY + one CLARIFY-oriented case. */
const CALIBRATION_CASE_IDS: ReadonlyArray<string> = [
  "st-service-discovery::u0", // known non-CLARIFY (answerable / knowledge)
  "am-bare-booking-clarifiable::u0", // known CLARIFY-oriented
];

type Args = {
  version: string;
  out: string;
  calibration: boolean;
  caseId: string | null;
  scenarioId: string | null;
  providerOverride: AiProviderId | null;
  modelOverride: string | null;
  timeoutMs: number | null;
};

function parseArgs(argv: string[]): Args {
  let version = DEFAULT_VERSION;
  let out = "";
  let calibration = false;
  let caseId: string | null = null;
  let scenarioId: string | null = null;
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
      case "--out":
        out = next() ?? "";
        break;
      case "--calibration":
        calibration = true;
        break;
      case "--case":
        caseId = next() ?? null;
        break;
      case "--scenario":
        scenarioId = next() ?? null;
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
    out,
    calibration,
    caseId,
    scenarioId,
    providerOverride,
    modelOverride,
    timeoutMs,
  };
}

/** Write a BLOCKED status.md and exit — the bridge requires a real provider. */
function blocked(outDir: string, reason: string): never {
  mkdirSync(outDir, { recursive: true });
  const body = [
    "# FUTURE_SYSTEM CLARIFY bridge — RUN STATUS",
    "",
    "## READINESS: BLOCKED",
    "",
    `The real-LLM CLARIFY run could not proceed: ${reason}`,
    "",
    "The FUTURE_SYSTEM bridge itself is built and structurally validated",
    "(`pnpm check:future-system`). This blocker is about REAL-LLM execution",
    "only: the bridge MUST use the real configured provider/model and never a",
    "mock or the deterministic classifier.",
    "",
    "Resolve the provider (DB-backed platform AI policy or `--provider/--model`",
    "override with valid credentials), then re-run `pnpm eval:run-future`.",
    "",
  ].join("\n");
  writeFileSync(resolve(outDir, "status.md"), `${body}\n`, "utf8");
  console.error(`\nBLOCKED — ${reason}`);
  console.error(`Wrote ${resolve(outDir, "status.md")}`);
  process.exit(2);
}

async function main(): Promise<void> {
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const args = parseArgs(process.argv.slice(2));
  const outDir = resolve(
    process.cwd(),
    args.out || "evaluation/reports/egyptian-v1/future-system-clarify",
  );
  mkdirSync(outDir, { recursive: true });

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
    blocked(outDir, `dataset ${args.version} failed validation`);
  }
  const dataset = parsed.data;
  const datasetHash = hashDataset(raw);

  // ── resolve the REAL effective policy (never a mock) ─────────────────────
  let effective: EffectiveAiPolicy | null;
  if (args.providerOverride) {
    if (!args.modelOverride) {
      blocked(outDir, "--model <id> is required when --provider is supplied");
    }
    effective = {
      primaryProvider: args.providerOverride,
      primaryModel: args.modelOverride!,
      secondary: null,
    };
    console.log(
      `  [override] evaluation-only provider policy: ${args.providerOverride}/${args.modelOverride} ` +
        `(DB production policy NOT read, NOT changed)`,
    );
  } else {
    try {
      const { getEffectiveAiPolicy } =
        await import("@/server/integrations/ai/factory");
      effective = await getEffectiveAiPolicy();
    } catch (err) {
      blocked(
        outDir,
        `could not resolve the live platform AI policy: ${(err as Error).message.slice(0, 160)}`,
      );
    }
    if (!effective) {
      blocked(
        outDir,
        "no effective AI policy could be resolved (DB unreachable or INVALID_POLICY). " +
          "The FUTURE_SYSTEM bridge requires the live provider policy or a --provider/--model override.",
      );
    }
  }

  const envDeps: AiFactoryEnvDeps = {
    getEnvVar: (name: string) => process.env[name],
    fetchImpl: globalThis.fetch as unknown as typeof fetch,
    ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
  };

  let ai;
  try {
    const { primary, secondary, fallbackEnabled } = adaptersFromEffectivePolicy(
      effective!,
      envDeps,
    );
    ai = createLlmConversationAi({ primary, secondary, fallbackEnabled });
  } catch (err) {
    blocked(
      outDir,
      `failed to build the real provider adapter: ${(err as Error).message.slice(0, 160)}`,
    );
  }

  const identity = {
    primaryProvider: effective!.primaryProvider,
    primaryModel: effective!.primaryModel,
    secondaryProvider: effective!.secondary?.provider ?? null,
    secondaryModel: effective!.secondary?.model ?? null,
    fallbackEnabled: !!effective!.secondary,
  };

  const runner = createFutureSystemRunner({ ai: ai!, identity });

  const systemIdentity: SystemIdentity = {
    kind: "FUTURE_SYSTEM",
    modelProvider: `${identity.primaryProvider}/${identity.primaryModel}`,
    routerVersion: "conversation-engine+turn-planner(Slice3)+clarify(Slice4)",
    contextBuilderVersion: "ai-context-builder(B-02)",
    note:
      "FUTURE_SYSTEM bridge (eval-only): real LLM → Conversation Engine → " +
      "ConversationState → resolveTurnPlan() → CLARIFY → clarification handler " +
      "→ TurnObservability. No production mutation.",
  };

  // ── case selection ───────────────────────────────────────────────────────
  const byId = new Map(dataset.cases.map((c) => [c.caseId, c] as const));
  let selected: EvaluationCase[];
  let modeLabel: string;
  if (args.caseId) {
    const c = byId.get(args.caseId);
    selected = c ? [c] : [];
    modeLabel = "SINGLE_CASE";
  } else if (args.scenarioId) {
    selected = dataset.cases.filter((c) => c.scenarioId === args.scenarioId);
    modeLabel = "SCENARIO";
  } else if (args.calibration) {
    selected = CALIBRATION_CASE_IDS.map((id) => byId.get(id)).filter(
      (c): c is EvaluationCase => !!c,
    );
    modeLabel = "CALIBRATION_ONLY";
  } else {
    selected = FOCUS_CASE_IDS.map((f) => byId.get(f.caseId)).filter(
      (c): c is EvaluationCase => !!c,
    );
    modeLabel = "FOCUSED_CLARIFY";
  }
  if (selected.length === 0) {
    blocked(
      outDir,
      "no cases selected (check --case/--scenario or the focus list)",
    );
  }

  // ── PRE-EXECUTION REPORT ─────────────────────────────────────────────────
  console.log("── PRE-EXECUTION REPORT (PROMPT-AI-EVAL-06, FUTURE_SYSTEM) ──");
  console.log(`  mode                    : ${modeLabel}`);
  console.log(
    `  dataset                 : ${args.version} (hash ${datasetHash})`,
  );
  console.log(
    `  target identity         : future-system-flowpilot / ${systemIdentity.modelProvider}`,
  );
  console.log(`  system kind             : FUTURE_SYSTEM`);
  console.log(`  provider (primary)      : ${identity.primaryProvider}`);
  console.log(`  model   (primary)       : ${identity.primaryModel}`);
  console.log(`  fallback enabled        : ${identity.fallbackEnabled}`);
  console.log(
    `  engine path             : receiveInboundMessage → resolveTurnPlan → CLARIFY`,
  );
  console.log(`  real inference          : YES (live provider HTTP calls)`);
  console.log(
    `  production mutation     : NONE (isolated in-memory repositories)`,
  );
  console.log(`  selected cases          : ${selected.length}`);
  console.log(
    `  case ids                : ${selected.map((c) => c.caseId).join(", ")}`,
  );
  console.log("");

  // ── EXECUTION (sequential — per-case engine state must not interleave) ───
  runner.reset();
  const target = new FutureSystemFlowpilotTarget(runner, systemIdentity);
  const result = await runEvaluation(target, selected, {
    datasetVersion: args.version,
    datasetHash,
    scenarioVersion: args.version,
    seed: dataset.meta.seed,
    filter: {},
  });

  // ── CLARIFY-emission measurement (additive; NOT the scoring engine) ──────
  const measurements: ClarifyEmissionMeasurement[] = [];
  for (const c of selected) {
    const scored = result.scored.find((s) => s.record.caseId === c.caseId);
    if (!scored) continue;
    measurements.push(measureClarifyEmission(c, scored.record.actual));
  }
  const clarifyAgg = aggregateClarify(measurements);

  // ── write artifacts (evaluation-run.json, report.md, manifest.json) ──────
  const written = writeRunArtifacts(result, outDir);

  // analysis.json — the CLARIFY-specific measurement + model-call accounting.
  const analysis = {
    runId: result.run.run.runId,
    target: target.id,
    systemKind: "FUTURE_SYSTEM" as const,
    provider: identity.primaryProvider,
    model: identity.primaryModel,
    datasetVersion: args.version,
    datasetHash,
    evaluatorVersion: EVALUATOR_VERSION,
    scoringVersion: SCORING_VERSION,
    executionMode: modeLabel,
    enginePath:
      "receiveInboundMessage → bypass/LLM → parseAiResponse → resolveTurnPlan → CLARIFY → clarification handler → TurnObservability",
    productionMutation: "NONE (isolated in-memory repositories)",
    caseAxes: Object.fromEntries(FOCUS_CASE_IDS.map((f) => [f.caseId, f.axis])),
    clarifyAggregate: clarifyAgg,
    perCase: measurements,
    modelCallAccounting: {
      maxModelCallsObservedPerTurn: Math.max(
        0,
        ...measurements.map((m) => m.modelCalls ?? 0),
      ),
      multiCallTurns: clarifyAgg.multiCallTurns,
      invariantHeld: clarifyAgg.multiCallTurns === 0,
    },
  };
  const analysisPath = resolve(outDir, "analysis.json");
  writeFileSync(analysisPath, `${JSON.stringify(analysis, null, 2)}\n`, "utf8");

  // ── calibration gate (prove the 10 structural conditions on real inference)
  const realInferenceOccurred = measurements.some(
    (m) => (m.modelCalls ?? 0) >= 1,
  );
  const engineReached = result.scored.every(
    (s) =>
      (s.record.actual as Record<string, unknown>).engineOk === true &&
      (s.record.actual as Record<string, unknown>).turnPlan !== undefined,
  );
  const providerFailures = measurements.filter(
    (m) => m.observedClass === "PROVIDER_FAILURE",
  );
  const schemaValid = true; // writeRunArtifacts validated against EVAL-01 already.
  const scoringOperating = result.metrics.totalCases === selected.length;

  const calibrationOk =
    engineReached &&
    scoringOperating &&
    clarifyAgg.multiCallTurns === 0 &&
    providerFailures.length === 0 &&
    realInferenceOccurred;

  // status.md — human-readable readiness.
  const status = [
    "# FUTURE_SYSTEM CLARIFY bridge — RUN STATUS",
    "",
    `## READINESS: ${calibrationOk ? "READY_FOR_REAL_LLM_CLARIFY_VERIFICATION" : "BLOCKED"}`,
    "",
    `- mode: ${modeLabel}`,
    `- target: future-system-flowpilot (FUTURE_SYSTEM)`,
    `- provider/model: ${identity.primaryProvider}/${identity.primaryModel}`,
    `- cases: ${selected.length}`,
    `- engine reached (turnPlan observable on every case): ${engineReached}`,
    `- real inference occurred (≥1 model call): ${realInferenceOccurred}`,
    `- provider failures: ${providerFailures.length}`,
    `- zero-or-one call invariant held (no multi-call turns): ${clarifyAgg.multiCallTurns === 0}`,
    `- scoring operating: ${scoringOperating}`,
    `- schema valid: ${schemaValid}`,
    "",
    "## Observed decision classes",
    ...Object.entries(clarifyAgg.observedClassCounts).map(
      ([k, v]) => `- ${k}: ${v}`,
    ),
    "",
    "## CLARIFY emission (ACTUAL observed, not inferred)",
    `- clarify expected: ${clarifyAgg.clarifyExpected}`,
    `- clarify emitted: ${clarifyAgg.clarifyEmitted}`,
    `- clarify correct: ${clarifyAgg.clarifyCorrect}`,
    `- clarify missed: ${clarifyAgg.clarifyMissed}`,
    `- clarify unnecessary: ${clarifyAgg.clarifyUnnecessary}`,
    "",
    "## Failure causes",
    ...(Object.keys(clarifyAgg.causeCounts).length === 0
      ? ["- none"]
      : Object.entries(clarifyAgg.causeCounts).map(([k, v]) => `- ${k}: ${v}`)),
    "",
    "## Notes",
    "- The bridge itself is proven offline by `pnpm check:future-system`",
    "  (stub-ai wiring: CLARIFY/resume/interruption/handoff/knowledge-gap).",
    "- EVAL-03 legacy PASS/FAIL verdicts measure the FUTURE behavior against the",
    "  CURRENT-architecture gold (`expectedCurrentAiOutcome`), where CLARIFY did",
    "  not exist; a FUTURE CLARIFY/answer therefore scores FAIL on the legacy",
    "  scorers. The AUTHORITATIVE CLARIFY signal is the clarify-emission",
    "  measurement above (observed, not inferred), NOT the legacy verdict.",
    "- `PROVIDER_FAILURE` is its own channel: a provider that returns",
    "  schema-invalid completions (INVALID_RESPONSE) is reported here and never",
    "  mislabelled as an AI/handoff-policy regression.",
    "",
  ].join("\n");
  const statusPath = resolve(outDir, "status.md");
  writeFileSync(statusPath, `${status}\n`, "utf8");

  // ── console summary ───────────────────────────────────────────────────────
  const met = result.metrics;
  console.log(`eval:run-future → ${args.version} (${modeLabel})`);
  console.log(`  run id                 : ${result.run.run.runId}`);
  console.log(
    `  cases / turns          : ${met.totalCases} / ${met.totalTurns}`,
  );
  console.log(
    `  PASS / LIMITATION / FAIL: ${met.passCount} / ${met.limitationCount} / ${met.failCount}`,
  );
  console.log(`  engine reached         : ${engineReached}`);
  console.log(`  real inference         : ${realInferenceOccurred}`);
  console.log(`  provider failures      : ${providerFailures.length}`);
  console.log(
    `  observed classes       : ${Object.entries(clarifyAgg.observedClassCounts)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ")}`,
  );
  console.log(
    `  clarify exp/emit/correct: ${clarifyAgg.clarifyExpected} / ${clarifyAgg.clarifyEmitted} / ${clarifyAgg.clarifyCorrect}`,
  );
  console.log(
    `  multi-call turns       : ${clarifyAgg.multiCallTurns} (must be 0)`,
  );
  console.log(`  artifacts              : ${written.jsonPath}`);
  console.log(`                           ${written.markdownPath}`);
  console.log(`                           ${written.manifestPath}`);
  console.log(`                           ${analysisPath}`);
  console.log(`                           ${statusPath}`);
  console.log("");
  console.log(
    `READINESS: ${calibrationOk ? "READY_FOR_REAL_LLM_CLARIFY_VERIFICATION" : "BLOCKED"}`,
  );
  if (!calibrationOk) process.exit(2);
}

void main();
