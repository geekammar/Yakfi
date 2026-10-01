/**
 * FlowPilot AI Evaluation — FUTURE_SYSTEM real-LLM FOCUSED re-verification AFTER
 * the EVAL-09 evaluation-path capability slice (PROMPT-AI-EVAL-10).
 *
 * Measurement ONLY. Verification-only. This CLI re-runs the EXACT EVAL-08
 * focused 14-case selection through the now-capable FUTURE_SYSTEM real-LLM path
 * and — crucially — uses the PROMPT-AI-EVAL-09 evaluation-only `seedPendingState`
 * mechanism to establish ENGINE-AUTHORED pending state BEFORE the measured turn
 * for the cross-turn cases (supplied-fact resume + interruption/pending-task),
 * which EVAL-08 could prove deterministically only.
 *
 *   real Atria
 *     → FUTURE_SYSTEM target
 *     → existing AI/context seam
 *     → real Conversation Engine (receiveInboundMessage)
 *     → ConversationState (derived from the SAME history the engine authored)
 *     → resolveTurnPlan()
 *     → first-class CLARIFY / existing decision path
 *     → clarification handler / domain seam
 *     → ActualOutcome
 *     → EVAL-03 scoring engine (unchanged) + CLARIFY/resume clarify-measure
 *
 * It changes NO production behavior and mutates NO production data (the engine
 * runs against ISOLATED in-memory repositories). Real inference happens; nothing
 * is deployed. Keys are read by NAME only (never printed). The seed uses ZERO
 * real model calls; only the measured turns use the real Atria call. There is NO
 * second Conversation Engine, resolver, ConversationState, or clarification
 * module — only the EVAL-09 seed + the existing bridge.
 *
 *   pnpm exec dotenv -e .env.local -e .env -- tsx scripts/eval-run-future-eval10.ts \
 *     --provider atria --model Atria-Dawn-Preview --timeout-ms 120000 \
 *     --out evaluation/reports/egyptian-v1/real-llm-eval10
 *
 * STOPS + reports a BLOCKER if the configured provider is unavailable — it never
 * silently falls back to a mock or the deterministic classifier.
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
  type ResumeInterruptionContext,
} from "../evaluation/runner/clarify-measure";
import {
  createFutureSystemRunner,
  type FutureTurnBusinessContext,
} from "../evaluation/runner/future-system-adapter";
import {
  interruptionSeed,
  resumeDateSeed,
  type PendingStateSeedSpec,
} from "../evaluation/runner/pending-state-seed";
import { hashDataset } from "../evaluation/runner/runner";
import { DEFAULT_SCORERS } from "../evaluation/runner/scorers";
import { scoreCase } from "../evaluation/runner/scoring-engine";
import { FutureSystemFlowpilotTarget } from "../evaluation/runner/targets/future-system-flowpilot";
import {
  EVALUATOR_VERSION,
  SCORING_VERSION,
} from "../evaluation/runner/versions";
import type { EvaluationCase } from "../evaluation/schema/dataset-schema";
import { safeParseDataset } from "../evaluation/schema/dataset-schema";
import type { ActualOutcome } from "../evaluation/schema/evaluation-result-schema";
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

const DATASET_VERSION = "egyptian-v1";
const EXPECTED_HASH = "8be16297ae4717bab5da4f3c94de1887";

/** The EXACT EVAL-08 focused 14-case selection (byte-identical ids + axes). */
const FOCUS_CASE_IDS: ReadonlyArray<{ caseId: string; axis: string }> = [
  {
    caseId: "am-bare-booking-clarifiable::u0",
    axis: "ambiguous booking (CLARIFY control)",
  },
  { caseId: "jt-missing-service::u0", axis: "missing service (CLARIFY)" },
  { caseId: "jt-missing-date::u0", axis: "missing date (CLARIFY)" },
  {
    caseId: "st-service-discovery::u0",
    axis: "answerable-without-clarification (ANSWER control)",
  },
  {
    caseId: "ho-customer-requested-human::u0",
    axis: "explicit human request (HANDOFF — preservation)",
  },
  {
    caseId: "ho-sensitive-medical::u0",
    axis: "sensitive/restricted (SAFETY — target 1)",
  },
  {
    caseId: "ho-empty-knowledge-gap::u0",
    axis: "knowledge gap (distinct from CLARIFY)",
  },
  {
    caseId: "ho-ambiguous-but-clarifiable-multi-turn::u0",
    axis: "multi-turn clarification",
  },
  {
    caseId: "am-context-resolves-service::u0",
    axis: "clarification answer / resume (SUPPLIED_FACT_RESUME — target 2)",
  },
  {
    caseId: "mt-topic-return::u0",
    axis: "topic return / resume (SUPPLIED_FACT_RESUME — target 2)",
  },
  { caseId: "st-ambiguous-oneword::u0", axis: "Egyptian colloquial ambiguity" },
  {
    caseId: "lg-spelling-variation-service::u0",
    axis: "Arabic spelling/noise",
  },
  {
    caseId: "jt-interrupted::u0",
    axis: "interruption after clarification (INTERRUPTION_RECOVERY — target 3)",
  },
  {
    caseId: "st-ambiguous-idk::u0",
    axis: "non-committal / unnecessary CLARIFY (CLARIFY_UNNECESSARY — target 4)",
  },
];

/**
 * The cross-turn cases that REQUIRE an engine-authored pending state before the
 * measured turn (the EVAL-08 structural gap EVAL-09 closed). Each spec is built
 * from the SAME canonical business service the dataset case carries so the
 * engine resolves it; the seed uses ZERO real inference.
 */
type SeedPlan = {
  spec: (ctx: FutureTurnBusinessContext) => PendingStateSeedSpec;
  resumeCtx: ResumeInterruptionContext;
};

const CANONICAL_SERVICE = "تنظيف الأسنان";
const SEED_DATE = "2026-09-14"; // same ISO date EVAL-09 proved establishes an active task

const SEED_PLANS: Record<string, SeedPlan> = {
  "am-context-resolves-service::u0": {
    spec: () => resumeDateSeed(CANONICAL_SERVICE),
    resumeCtx: {
      suppliedFacts: ["service", "date"],
      pendingTask: { kind: "BOOKING" },
      expectResume: true,
    },
  },
  "mt-topic-return::u0": {
    spec: () => resumeDateSeed(CANONICAL_SERVICE),
    resumeCtx: {
      suppliedFacts: ["service", "date"],
      pendingTask: { kind: "BOOKING" },
      expectResume: true,
    },
  },
  "jt-interrupted::u0": {
    spec: () => interruptionSeed(CANONICAL_SERVICE, SEED_DATE),
    resumeCtx: {
      pendingTask: { kind: "BOOKING" },
      expectInterruptionPreserved: true,
    },
  },
};

type Args = {
  version: string;
  out: string;
  providerOverride: AiProviderId | null;
  modelOverride: string | null;
  timeoutMs: number | null;
  calibrationOnly: boolean;
};

function parseArgs(argv: string[]): Args {
  let version = DATASET_VERSION;
  let out = "";
  let providerOverride: AiProviderId | null = null;
  let modelOverride: string | null = null;
  let timeoutMs: number | null = null;
  let calibrationOnly = false;
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
      case "--calibration-only":
        calibrationOnly = true;
        break;
      default:
        break;
    }
  }
  return {
    version,
    out,
    providerOverride,
    modelOverride,
    timeoutMs,
    calibrationOnly,
  };
}

function blocked(outDir: string, reason: string): never {
  mkdirSync(outDir, { recursive: true });
  const body = [
    "# FUTURE_SYSTEM EVAL-10 re-verification — RUN STATUS",
    "",
    "## READINESS: BLOCKED — PROVIDER_RUNTIME",
    "",
    `The real-LLM re-verification could not proceed: ${reason}`,
    "",
    "The seeding capability itself is proven offline by `pnpm check:future-system`",
    "and `pnpm eval:run-future-fixtures` (EVAL-09). This blocker is about REAL-LLM",
    "execution only: the bridge MUST use the real configured provider/model and",
    "never a mock or the deterministic classifier.",
    "",
  ].join("\n");
  writeFileSync(resolve(outDir, "status.md"), `${body}\n`, "utf8");
  console.error(`\nBLOCKED — ${reason}`);
  process.exit(2);
}

type Observed = Record<string, unknown>;

function toBusinessContext(c: EvaluationCase): FutureTurnBusinessContext {
  return {
    businessName: c.businessContext.businessName,
    services: c.businessContext.services,
    faqs: c.businessContext.faqs,
  };
}

/** The final CUSTOMER message of a case = the dataset's evaluated turn. */
function evaluatedCustomerTurn(c: EvaluationCase): {
  message: string;
  turnIndex: number;
} {
  const customers = c.messages.filter((m) => m.senderType === "CUSTOMER");
  const last = customers[customers.length - 1]!;
  return { message: last.content, turnIndex: last.turnIndex };
}

async function main(): Promise<void> {
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const args = parseArgs(process.argv.slice(2));
  const outDir = resolve(
    process.cwd(),
    args.out || "evaluation/reports/egyptian-v1/real-llm-eval10",
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
  if (!parsed.success)
    blocked(outDir, `dataset ${args.version} failed validation`);
  const dataset = parsed.data;
  const datasetHash = hashDataset(raw);
  if (datasetHash !== EXPECTED_HASH) {
    blocked(
      outDir,
      `dataset hash ${datasetHash} != expected ${EXPECTED_HASH} (the egyptian-v1 dataset must be byte-identical)`,
    );
  }

  // ── resolve the REAL effective policy (never a mock) ─────────────────────
  let effective: EffectiveAiPolicy | null = null;
  if (args.providerOverride) {
    if (!args.modelOverride)
      blocked(outDir, "--model <id> is required when --provider is supplied");
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
    if (!effective)
      blocked(
        outDir,
        "no effective AI policy could be resolved (DB unreachable or INVALID_POLICY).",
      );
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
  const systemIdentity = {
    kind: "FUTURE_SYSTEM" as const,
    modelProvider: `${identity.primaryProvider}/${identity.primaryModel}`,
    routerVersion:
      "conversation-engine+turn-planner(Slice3)+clarify(Slice4)+seedPendingState(EVAL-09)",
    contextBuilderVersion: "ai-context-builder(B-02)",
    note:
      "FUTURE_SYSTEM EVAL-10 re-verification (eval-only): real LLM → Conversation Engine → " +
      "ConversationState → resolveTurnPlan() → CLARIFY → clarification handler → TurnObservability. " +
      "Cross-turn cases seed engine-authored pending state (EVAL-09). No production mutation.",
  };
  const target = new FutureSystemFlowpilotTarget(runner, systemIdentity);

  const byId = new Map(dataset.cases.map((c) => [c.caseId, c] as const));
  const selected = FOCUS_CASE_IDS.map((f) => byId.get(f.caseId)).filter(
    (c): c is EvaluationCase => !!c,
  );
  const missing = FOCUS_CASE_IDS.filter((f) => !byId.has(f.caseId)).map(
    (f) => f.caseId,
  );
  if (missing.length > 0)
    blocked(
      outDir,
      `focused case ids missing from dataset: ${missing.join(", ")}`,
    );

  console.log("── PRE-EXECUTION REPORT (PROMPT-AI-EVAL-10, FUTURE_SYSTEM) ──");
  console.log(`  dataset              : ${args.version} (hash ${datasetHash})`);
  console.log(
    `  target identity      : future-system-flowpilot / ${systemIdentity.modelProvider}`,
  );
  console.log(
    `  provider/model       : ${identity.primaryProvider}/${identity.primaryModel}`,
  );
  console.log(`  fallback enabled     : ${identity.fallbackEnabled}`);
  console.log(`  real inference       : YES (live provider HTTP calls)`);
  console.log(
    `  production mutation  : NONE (isolated in-memory repositories)`,
  );
  console.log(`  focused cases        : ${selected.length}`);
  console.log(`  seeded cross-turn    : ${Object.keys(SEED_PLANS).join(", ")}`);
  console.log("");

  // ── CALIBRATION (ran FIRST): ANSWER + CLARIFY + supplied-fact RESUME ──────
  console.log("── CALIBRATION (ANSWER + CLARIFY + seeded RESUME) ──");
  const calib: Record<string, Observed> = {};

  // ANSWER control
  {
    const c = byId.get("st-service-discovery::u0")!;
    runner.reset();
    const t = evaluatedCustomerTurn(c);
    const a = (await target.runTurn({
      caseId: "calib-answer",
      turnIndex: t.turnIndex,
      message: t.message,
      history: [],
      businessContext: toBusinessContext(c),
    })) as unknown as ActualOutcome & Observed;
    calib.answer = {
      decisionClass: a.decisionClass,
      conversationStatus: a.conversationStatus,
      modelCalls: a.modelCallsThisTurn,
      providerFailure: a.providerFailure,
      engineOk: a.engineOk,
    };
  }
  // CLARIFY control
  {
    const c = byId.get("am-bare-booking-clarifiable::u0")!;
    runner.reset();
    const t = evaluatedCustomerTurn(c);
    const a = (await target.runTurn({
      caseId: "calib-clarify",
      turnIndex: t.turnIndex,
      message: t.message,
      history: [],
      businessContext: toBusinessContext(c),
    })) as unknown as ActualOutcome & Observed;
    calib.clarify = {
      decisionClass: a.decisionClass,
      conversationStatus: a.conversationStatus,
      modelCalls: a.modelCallsThisTurn,
      providerFailure: a.providerFailure,
      engineOk: a.engineOk,
    };
  }
  // Supplied-fact RESUME (seeded)
  {
    const c = byId.get("am-context-resolves-service::u0")!;
    runner.reset();
    const seedAudit = await runner.seedPendingState({
      caseId: "calib-resume",
      businessContext: toBusinessContext(c),
      spec: resumeDateSeed(CANONICAL_SERVICE),
    });
    const a = (await target.runTurn({
      caseId: "calib-resume",
      turnIndex: 4,
      message: "الخميس",
      history: [],
      businessContext: toBusinessContext(c),
    })) as unknown as ActualOutcome & Observed;
    const clarType =
      (a.clarification as { type?: string } | undefined)?.type ?? null;
    calib.resume = {
      seedValid: seedAudit.seedValid,
      reconstructedClarification: seedAudit.reconstructedClarification,
      seedRealModelCalls: seedAudit.seedRealModelCalls,
      decisionClass: a.decisionClass,
      conversationStatus: a.conversationStatus,
      clarificationType: clarType,
      modelCalls: a.modelCallsThisTurn,
      providerFailure: a.providerFailure,
      // resume succeeded if the date was NOT re-asked and the thread stayed AI_ACTIVE
      resumeObserved:
        seedAudit.seedValid === true &&
        clarType !== "CLARIFY_DATE" &&
        a.conversationStatus === "AI_ACTIVE",
    };
  }

  const calibrationRealInference =
    ((calib.clarify!.modelCalls as number) ?? 0) >= 1 ||
    ((calib.resume!.modelCalls as number) ?? 0) >= 1;
  const calibrationProviderFailures =
    (calib.answer!.providerFailure ? 1 : 0) +
    (calib.clarify!.providerFailure ? 1 : 0) +
    (calib.resume!.providerFailure ? 1 : 0);
  const calibrationMultiCall = [calib.answer, calib.clarify, calib.resume].some(
    (o) => ((o!.modelCalls as number) ?? 0) > 1,
  );
  const calibrationEngineReached = [
    calib.answer,
    calib.clarify,
    calib.resume,
  ].every((o) => o!.engineOk !== false);
  const calibrationOk =
    calibrationEngineReached &&
    calibrationRealInference &&
    calibrationProviderFailures === 0 &&
    !calibrationMultiCall;

  console.log(
    `  ANSWER  : class=${calib.answer!.decisionClass} status=${calib.answer!.conversationStatus} calls=${calib.answer!.modelCalls}`,
  );
  console.log(
    `  CLARIFY : class=${calib.clarify!.decisionClass} status=${calib.clarify!.conversationStatus} calls=${calib.clarify!.modelCalls}`,
  );
  console.log(
    `  RESUME  : seedValid=${calib.resume!.seedValid} class=${calib.resume!.decisionClass} clar=${calib.resume!.clarificationType} status=${calib.resume!.conversationStatus} calls=${calib.resume!.modelCalls} resumeObserved=${calib.resume!.resumeObserved}`,
  );
  console.log(
    `  calibration OK: ${calibrationOk} (engineReached=${calibrationEngineReached} realInference=${calibrationRealInference} providerFailures=${calibrationProviderFailures} multiCall=${calibrationMultiCall})`,
  );
  console.log("");

  if (!calibrationOk) {
    writeFileSync(
      resolve(outDir, "calibration.json"),
      `${JSON.stringify({ calibrationOk, calib }, null, 2)}\n`,
      "utf8",
    );
    blocked(
      outDir,
      "calibration gate failed (see calibration.json) — the full 14-case set was NOT run",
    );
  }
  writeFileSync(
    resolve(outDir, "calibration.json"),
    `${JSON.stringify({ calibrationOk, calib }, null, 2)}\n`,
    "utf8",
  );

  if (args.calibrationOnly) {
    console.log("CALIBRATION_ONLY — stopping before the full 14-case set.");
    return;
  }

  // ── FULL FOCUSED 14-CASE SET ──────────────────────────────────────────────
  const measurements: ClarifyEmissionMeasurement[] = [];
  const perCase: Observed[] = [];
  const scoredRecords: Observed[] = [];
  let legacyPass = 0;
  let legacyLimitation = 0;
  let legacyFail = 0;

  for (const f of FOCUS_CASE_IDS) {
    const c = byId.get(f.caseId)!;
    runner.reset();
    const seedPlan = SEED_PLANS[f.caseId];
    let seedAudit: Awaited<ReturnType<typeof runner.seedPendingState>> | null =
      null;
    let actual: ActualOutcome & Observed;

    if (seedPlan) {
      // Seed engine-authored pending state (ZERO real model calls), then run the
      // measured turn through the real engine on the SAME per-case history.
      seedAudit = await runner.seedPendingState({
        caseId: f.caseId,
        businessContext: toBusinessContext(c),
        spec: seedPlan.spec(toBusinessContext(c)),
      });
      const t = evaluatedCustomerTurn(c);
      actual = (await target.runTurn({
        caseId: f.caseId,
        turnIndex: t.turnIndex,
        message: t.message,
        history: [],
        businessContext: toBusinessContext(c),
      })) as unknown as ActualOutcome & Observed;
    } else {
      // Non-seeded: replay all customer turns in order; the engine accumulates
      // its OWN authored state. Measure the final (evaluated) turn.
      let last: (ActualOutcome & Observed) | null = null;
      let lastIndex = -1;
      for (let i = 0; i < c.messages.length; i += 1) {
        const m = c.messages[i]!;
        if (m.senderType !== "CUSTOMER") continue;
        const history = c.messages.slice(0, i).map((h) => ({
          senderType: h.senderType as "CUSTOMER" | "AI" | "STAFF",
          content: h.content,
        }));
        last = (await target.runTurn({
          caseId: f.caseId,
          turnIndex: m.turnIndex,
          message: m.content,
          history,
          businessContext: toBusinessContext(c),
        })) as unknown as ActualOutcome & Observed;
        lastIndex = i;
      }
      void lastIndex;
      actual = last!;
    }

    const measurement = measureClarifyEmission(c, actual, seedPlan?.resumeCtx);
    measurements.push(measurement);

    const scored = scoreCase(c, actual, DEFAULT_SCORERS);
    if (scored.record.verdict === "PASS") legacyPass += 1;
    else if (scored.record.verdict === "LIMITATION") legacyLimitation += 1;
    else if (scored.record.verdict === "FAIL") legacyFail += 1;

    scoredRecords.push({
      caseId: f.caseId,
      legacyVerdict: scored.record.verdict,
      legacyFailureCategory: scored.record.failureCategory,
      handoffOutcomeClass: scored.handoffOutcomeClass,
    });

    const clar =
      (actual.clarification as
        { type?: string; missingFacts?: string[] } | undefined) ?? undefined;
    perCase.push({
      caseId: f.caseId,
      axis: f.axis,
      seeded: !!seedPlan,
      seed: seedAudit
        ? {
            specId: seedAudit.specId,
            specKind: seedAudit.specKind,
            seedValid: seedAudit.seedValid,
            seedRealModelCalls: seedAudit.seedRealModelCalls,
            reconstructedClarification: seedAudit.reconstructedClarification,
            reconstructedActiveTask: seedAudit.reconstructedActiveTask,
          }
        : null,
      observed: {
        decisionClass: actual.decisionClass,
        conversationStatus: actual.conversationStatus,
        clarificationType: clar?.type ?? null,
        missingFacts: clar?.missingFacts ?? [],
        routingDecision: actual.routingDecision,
        handoffOutcomeClass: actual.handoffOutcomeClass,
        handoffCause: actual.handoffCause ?? null,
        knowledgeSourceClass: actual.knowledgeSourceClass ?? null,
        stateTransition: actual.stateTransition ?? null,
        modelCallsThisTurn: actual.modelCallsThisTurn,
        providerFailure: actual.providerFailure,
        realProvider: actual.realProvider,
        realModel: actual.realModel,
        retryCount: actual.retryCount,
        fallbackUsed: actual.fallbackUsed,
        modelLatencyMs: actual.modelLatencyMs,
        totalLatencyMs: actual.totalLatencyMs,
      },
      measurement: {
        expectedClarification: measurement.expectedClarification,
        expectClarify: measurement.expectClarify,
        observedClass: measurement.observedClass,
        pass: measurement.pass,
        cause: measurement.cause,
        reason: measurement.reason,
        handoffExpectation: measurement.handoffExpectation,
        safetyExpectation: measurement.safetyExpectation,
      },
    });

    console.log(
      `  ${f.caseId.padEnd(42)} obs=${(measurement.observedClass as string).padEnd(14)} ` +
        `pass=${measurement.pass} cause=${measurement.cause} calls=${actual.modelCallsThisTurn} ` +
        `lat=${actual.modelLatencyMs ?? "?"}ms`,
    );
  }

  const clarifyAgg = aggregateClarify(measurements);

  // ── latency / retries / timeout profile ───────────────────────────────────
  const latencies = perCase
    .map((p) => (p.observed as Observed).modelLatencyMs as number | null)
    .filter((x): x is number => typeof x === "number" && x > 0)
    .sort((a, b) => a - b);
  const p = (q: number) =>
    latencies.length === 0
      ? null
      : latencies[
          Math.min(latencies.length - 1, Math.floor(q * latencies.length))
        ];
  const retries = perCase.reduce(
    (s, pc) => s + (((pc.observed as Observed).retryCount as number) ?? 0),
    0,
  );
  const providerFailures = measurements.filter(
    (m) => m.observedClass === "PROVIDER_FAILURE",
  ).length;
  const aiFailures = measurements.filter(
    (m) => m.observedClass === "AI_FAILURE",
  ).length;
  const realModelCalls = perCase.reduce(
    (s, pc) =>
      s + (((pc.observed as Observed).modelCallsThisTurn as number) ?? 0),
    0,
  );
  const engineReached = perCase.every(
    (pc) => (pc.observed as Observed).conversationStatus !== undefined,
  );

  const analysis = {
    slice: "PROMPT-AI-EVAL-10",
    verificationOnly: true,
    target: target.id,
    systemKind: "FUTURE_SYSTEM" as const,
    provider: identity.primaryProvider,
    model: identity.primaryModel,
    fallbackEnabled: identity.fallbackEnabled,
    datasetVersion: args.version,
    datasetHash,
    evaluatorVersion: EVALUATOR_VERSION,
    scoringVersion: SCORING_VERSION,
    enginePath:
      "receiveInboundMessage → bypass/LLM → parseAiResponse → resolveTurnPlan → CLARIFY → clarification handler → TurnObservability (seeded cross-turn via EVAL-09 seedPendingState)",
    productionMutation: "NONE (isolated in-memory repositories)",
    executedAt: new Date().toISOString(),
    calibration: { calibrationOk, calib },
    counts: {
      cases: measurements.length,
      realModelCalls,
      engineReached,
      providerFailures,
      aiFailures,
      multiCallTurns: clarifyAgg.multiCallTurns,
    },
    clarifyAggregate: clarifyAgg,
    legacyScoring: {
      pass: legacyPass,
      limitation: legacyLimitation,
      fail: legacyFail,
    },
    latencyProfile: {
      n: latencies.length,
      minMs: latencies[0] ?? null,
      p50Ms: p(0.5),
      p95Ms: p(0.95),
      maxMs: latencies[latencies.length - 1] ?? null,
      totalRetries: retries,
    },
    perCase,
    scoredRecords,
  };
  writeFileSync(
    resolve(outDir, "analysis.json"),
    `${JSON.stringify(analysis, null, 2)}\n`,
    "utf8",
  );

  // ── case-selection.json (reproducibility; selection-only, dataset unchanged)
  writeFileSync(
    resolve(outDir, "case-selection.json"),
    `${JSON.stringify(
      {
        purpose:
          "PROMPT-AI-EVAL-10 real-LLM re-verification after the EVAL-09 evaluation-path capability slice. REUSES the EXACT EVAL-08 focused 14-case ids. SELECTION ONLY — the canonical dataset is NEVER modified.",
        datasetVersion: args.version,
        datasetHash,
        totalCasesInDataset: dataset.cases.length,
        reusedFrom:
          "evaluation/reports/egyptian-v1/real-llm-clarify-rerun/case-selection.json (EVAL-08)",
        seededCrossTurnCases: Object.keys(SEED_PLANS),
        focusedCaseIds: FOCUS_CASE_IDS,
        focusedCaseIdCount: FOCUS_CASE_IDS.length,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  // ── status.md ─────────────────────────────────────────────────────────────
  const safety = clarifyAgg.safetyRegressions;
  const handoffReg = clarifyAgg.humanHandoffRegressions;
  const resumeFailures = clarifyAgg.resumeFailures;
  const interruptionFailures = clarifyAgg.interruptionRecoveryFailures;
  const pendingLost = clarifyAgg.pendingTaskLosses;

  const status = [
    "# FUTURE_SYSTEM EVAL-10 real-LLM re-verification — RUN STATUS",
    "",
    `## provider/model: ${identity.primaryProvider}/${identity.primaryModel}`,
    `- dataset: ${args.version} (hash ${datasetHash})`,
    `- cases: ${measurements.length}`,
    `- real model calls: ${realModelCalls}`,
    `- engine reached: ${engineReached}`,
    `- provider failures: ${providerFailures}`,
    `- AI failures: ${aiFailures}`,
    `- multi-call turns (must be 0): ${clarifyAgg.multiCallTurns}`,
    "",
    "## Observed decision classes",
    ...Object.entries(clarifyAgg.observedClassCounts).map(
      ([k, v]) => `- ${k}: ${v}`,
    ),
    "",
    "## Critical remediation counters (all MUST be 0)",
    `- safetyRegressions: ${safety}`,
    `- humanHandoffRegressions: ${handoffReg}`,
    `- resumeFailures: ${resumeFailures}`,
    `- interruptionRecoveryFailures: ${interruptionFailures}`,
    `- pendingTaskLosses: ${pendingLost}`,
    "",
    "## CLARIFY emission (observed)",
    `- expected: ${clarifyAgg.clarifyExpected} · emitted: ${clarifyAgg.clarifyEmitted} · correct: ${clarifyAgg.clarifyCorrect} · missed: ${clarifyAgg.clarifyMissed} · unnecessary: ${clarifyAgg.clarifyUnnecessary}`,
    "",
    "## Cause counts",
    ...(Object.keys(clarifyAgg.causeCounts).length === 0
      ? ["- none"]
      : Object.entries(clarifyAgg.causeCounts).map(([k, v]) => `- ${k}: ${v}`)),
    "",
    "## Latency (real model, per measured turn)",
    `- n=${latencies.length} min=${latencies[0] ?? "?"}ms p50=${p(0.5) ?? "?"}ms p95=${p(0.95) ?? "?"}ms max=${latencies[latencies.length - 1] ?? "?"}ms retries=${retries}`,
    "",
  ].join("\n");
  writeFileSync(resolve(outDir, "status.md"), `${status}\n`, "utf8");

  console.log("");
  console.log(`eval10 → ${args.version}`);
  console.log(
    `  observed classes       : ${Object.entries(clarifyAgg.observedClassCounts)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ")}`,
  );
  console.log(
    `  clarify exp/emit/correct: ${clarifyAgg.clarifyExpected} / ${clarifyAgg.clarifyEmitted} / ${clarifyAgg.clarifyCorrect}`,
  );
  console.log(`  safetyReg/handoffReg   : ${safety} / ${handoffReg}`);
  console.log(
    `  resumeFail/interruptFail/pendingLost: ${resumeFailures} / ${interruptionFailures} / ${pendingLost}`,
  );
  console.log(`  provider failures      : ${providerFailures}`);
  console.log(
    `  multi-call turns       : ${clarifyAgg.multiCallTurns} (must be 0)`,
  );
  console.log(
    `  legacy PASS/LIM/FAIL   : ${legacyPass} / ${legacyLimitation} / ${legacyFail}`,
  );
  console.log(
    `  latency p50/max        : ${p(0.5)}ms / ${latencies[latencies.length - 1]}ms`,
  );
  console.log(`  artifacts              : ${resolve(outDir, "analysis.json")}`);
  console.log(`                           ${resolve(outDir, "status.md")}`);
  console.log(
    `                           ${resolve(outDir, "case-selection.json")}`,
  );
}

void main();
