/**
 * FlowPilot AI Evaluation — FUTURE_SYSTEM real-LLM MULTI-INTENT verification
 * AFTER PRODUCER TOP-LEVEL ACTION REMEDIATION (PROMPT-AI-EVAL-14, re-run of EVAL-13 after PROMPT-AI-ARCH-11).
 *
 * Measurement ONLY. Verification-only. This CLI drives the EXISTING Slice-5
 * production engine (multi-intent goals[] + answer-and-continue) through the
 * REAL Atria provider over the canonical egyptian-v1 dataset and OBSERVES — from
 * the real Conversation Engine's own TurnObservability — whether multi-intent
 * answer-and-continue is reachable and materially correct.
 *
 *   real Atria
 *     → FUTURE_SYSTEM bridge (future-system-adapter)
 *     → existing ai-context-builder
 *     → real provider adapter
 *     → parseAiResponse
 *     → ConversationState derivation/merge
 *     → resolveTurnPlan (turn-planner, Slice 3/5)
 *     → Slice-5 multi-intent handling / answer-and-continue
 *     → existing response/disclosure/domain seams
 *     → ActualOutcome / TurnObservability (goals[] · pendingGoals · answerAndContinue)
 *
 * It changes NO production behavior and mutates NO production data (the engine
 * runs against ISOLATED in-memory repositories). Real inference happens; nothing
 * is deployed. Keys are read by NAME only (never printed). There is NO second
 * Conversation Engine, resolver, ConversationState, planner, or classifier — the
 * ONLY new file is this evaluation-only CLI plus the reporting artifacts.
 *
 *   pnpm exec dotenv -e .env.local -e .env -- tsx scripts/eval-run-future-eval14.ts \
 *     --provider atria --model Atria-Dawn-Preview --timeout-ms 120000 \
 *     --out evaluation/reports/egyptian-v1/real-llm-eval14
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
  createFutureSystemRunner,
  type FutureTurnBusinessContext,
  type FutureTurnOutcome,
} from "../evaluation/runner/future-system-adapter";
import { hashDataset } from "../evaluation/runner/runner";
import { EVALUATOR_VERSION } from "../evaluation/runner/versions";
import type { EvaluationCase } from "../evaluation/schema/dataset-schema";
import { safeParseDataset } from "../evaluation/schema/dataset-schema";
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

const DATASET_VERSION = "egyptian-v1";
const EXPECTED_HASH = "8be16297ae4717bab5da4f3c94de1887";

/**
 * The focused Slice-5 real-LLM verification set. The repository (BUILD_STATE
 * "Next step") names `mi-booking-plus-discovery`, `mi-two-questions`,
 * `ho-unnecessary-*` as the focused multi-intent cases; we add the full
 * answer-and-continue mi-* family (knowledge + domain) and the mandatory
 * safety/handoff regression set. Selection ONLY — the dataset is never changed.
 */
type FocusCase = {
  caseId: string;
  axis: string;
  /** The verification role this case plays. */
  role:
    | "ANSWER_AND_CONTINUE" // knowledge answerable + domain goal → defer domain
    | "MULTI_ANSWER" // two answerable knowledge goals, no domain pending
    | "UNNECESSARY_HANDOFF" // a competent assistant resolves this; handoff = regression
    | "SAFETY_REQUIRED" // explicit-human / sensitive / knowledge-gap → MUST hand off
    | "ANSWER_CONTROL"; // single answerable goal (calibration-style control)
  /** Scenario handoff truth, carried for the measurement. */
  handoff: "NOT_REQUIRED" | "REQUIRED" | "ACCEPTABLE_EITHER";
};

const FOCUS_CASES: ReadonlyArray<FocusCase> = [
  // ── answer-and-continue candidates (knowledge answerable + domain goal) ────
  {
    caseId: "mi-booking-plus-discovery::u0",
    axis: "booking + discovery (answer catalog, defer booking)",
    role: "ANSWER_AND_CONTINUE",
    handoff: "NOT_REQUIRED",
  },
  {
    caseId: "mi-booking-plus-hours::u0",
    axis: "booking + hours (answer hours, defer booking)",
    role: "ANSWER_AND_CONTINUE",
    handoff: "NOT_REQUIRED",
  },
  {
    caseId: "mi-booking-plus-price::u0",
    axis: "booking + price (answer price, defer booking)",
    role: "ANSWER_AND_CONTINUE",
    handoff: "ACCEPTABLE_EITHER",
  },
  {
    caseId: "mi-availability-plus-price::u0",
    axis: "availability + price (answer price, resolve availability)",
    role: "ANSWER_AND_CONTINUE",
    handoff: "ACCEPTABLE_EITHER",
  },
  {
    caseId: "mi-discovery-price-booking::u0",
    axis: "discovery + price + booking (answer, leave booking open)",
    role: "ANSWER_AND_CONTINUE",
    handoff: "ACCEPTABLE_EITHER",
  },
  // ── multiple answerable questions (no domain pending) ─────────────────────
  {
    caseId: "mi-two-questions::u0",
    axis: "two questions (answer both in order)",
    role: "MULTI_ANSWER",
    handoff: "NOT_REQUIRED",
  },
  // ── unnecessary-handoff multi-intent cases (ho-unnecessary-*) ─────────────
  {
    caseId: "ho-unnecessary-knowledge-looks-like-booking::u0",
    axis: "knowledge that looks like booking (answer, not handoff)",
    role: "UNNECESSARY_HANDOFF",
    handoff: "NOT_REQUIRED",
  },
  {
    caseId: "ho-unnecessary-faq-hurried::u0",
    axis: "hurried FAQ (answer from stored FAQ)",
    role: "UNNECESSARY_HANDOFF",
    handoff: "NOT_REQUIRED",
  },
  {
    caseId: "ho-unnecessary-discovery-mid-flow::u0",
    axis: "discovery mid-flow (answer discovery)",
    role: "UNNECESSARY_HANDOFF",
    handoff: "NOT_REQUIRED",
  },
  {
    caseId: "ho-unnecessary-clarifiable::u0",
    axis: "clarifiable booking reference (clarify, not handoff)",
    role: "UNNECESSARY_HANDOFF",
    handoff: "NOT_REQUIRED",
  },
  // ── SAFETY / HANDOFF regression (MUST stay NEED_HUMAN) ────────────────────
  {
    caseId: "ho-sensitive-medical::u0",
    axis: "sensitive/restricted (SAFETY precedence)",
    role: "SAFETY_REQUIRED",
    handoff: "REQUIRED",
  },
  {
    caseId: "ho-customer-requested-human::u0",
    axis: "explicit human request (HUMAN precedence)",
    role: "SAFETY_REQUIRED",
    handoff: "REQUIRED",
  },
  {
    caseId: "ho-empty-knowledge-gap::u0",
    axis: "knowledge gap (KNOWLEDGE_GAP handoff)",
    role: "SAFETY_REQUIRED",
    handoff: "REQUIRED",
  },
  {
    caseId: "mi-human-plus-knowledge::u0",
    axis: "human + knowledge rider (human precedence dominates multi-intent)",
    role: "SAFETY_REQUIRED",
    handoff: "REQUIRED",
  },
  {
    caseId: "mi-greeting-booking-human::u0",
    axis: "greeting + booking + human (human precedence dominates multi-intent)",
    role: "SAFETY_REQUIRED",
    handoff: "REQUIRED",
  },
];

/** The ANSWER control used in calibration (single answerable goal). */
const CALIB_ANSWER_ID = "st-service-discovery::u0";
/** The multi-intent calibration case. */
const CALIB_MULTI_ID = "mi-booking-plus-discovery::u0";

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

function blocked(outDir: string, kind: string, reason: string): never {
  mkdirSync(outDir, { recursive: true });
  const body = [
    "# FUTURE_SYSTEM EVAL-14 multi-intent verification — RUN STATUS",
    "",
    `## READINESS: ${kind}`,
    "",
    `The real-LLM multi-intent verification could not proceed: ${reason}`,
    "",
    "The Slice-5 production foundation itself is proven offline by",
    "`pnpm check:multi-intent` (20/20). This blocker is about REAL-LLM execution",
    "only: the bridge MUST use the real configured provider/model and never a",
    "mock or the deterministic classifier.",
    "",
  ].join("\n");
  writeFileSync(resolve(outDir, "status.md"), `${body}\n`, "utf8");
  console.error(`\n${kind} — ${reason}`);
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

type Obs = {
  routingDecision?: string;
  goals?: Array<{ kind?: string; intent?: string }>;
  turnPlan?: { steps?: Array<{ kind?: string; intent?: string }> };
  pendingGoals?: Array<{ kind?: string; intent?: string }>;
  answerAndContinue?: boolean;
  clarification?: { type?: string; missingFacts?: string[] };
  handoffCause?: string;
  provider?: string;
  model?: string;
};

/** Project the engine success result + observability into the measured record. */
function observe(outcome: FutureTurnOutcome): Observed {
  const engine = outcome.engine;
  const ok = engine.ok === true;
  const success = ok && engine.duplicate !== true;
  const obs = (success ? engine.observability : undefined) as Obs | undefined;
  const goals = obs?.goals ?? [];
  const steps = obs?.turnPlan?.steps ?? [];
  const pending = obs?.pendingGoals ?? [];
  return {
    engineOk: ok,
    duplicate: ok && engine.duplicate === true,
    engineFailureCode: ok ? null : ((engine as { code?: string }).code ?? null),
    intent: success ? engine.intent : null,
    assistantAction: success ? engine.assistantAction : null,
    conversationStatus: success ? engine.conversationStatus : null,
    routingDecision: obs?.routingDecision ?? null,
    decisionClass: steps[0]?.kind ?? null,
    goalsCount: goals.length,
    goalKinds: goals.map((g) => g.kind ?? "?"),
    goalIntents: goals.map((g) => g.intent ?? "?"),
    multiGoal: goals.length > 1,
    turnPlanSteps: steps.length,
    pendingGoalsCount: pending.length,
    pendingGoalIntents: pending.map((g) => g.intent ?? "?"),
    answerAndContinue: obs?.answerAndContinue === true,
    clarificationType: obs?.clarification?.type ?? null,
    handoffCause: obs?.handoffCause ?? null,
    decision: outcome.decision
      ? {
          intent: outcome.decision.intent,
          action: outcome.decision.action,
          handoffReason: outcome.decision.handoffReason ?? null,
          hasGoals:
            Array.isArray(outcome.decision.goals) &&
            outcome.decision.goals.length > 0,
          goalsLength: Array.isArray(outcome.decision.goals)
            ? outcome.decision.goals.length
            : 0,
        }
      : null,
    modelCallsThisTurn: outcome.modelCallsThisTurn,
    providerFailure: outcome.providerFailure,
    validatedNull: outcome.validatedNull,
    realProvider: obs?.provider ?? outcome.telemetry.finalProvider,
    realModel: obs?.model ?? outcome.telemetry.finalModel,
    retryCount: outcome.telemetry.retryCount,
    modelLatencyMs: outcome.telemetry.modelLatencyMs,
    totalLatencyMs: outcome.totalLatencyMs,
  };
}

async function main(): Promise<void> {
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const args = parseArgs(process.argv.slice(2));
  const outDir = resolve(
    process.cwd(),
    args.out || "evaluation/reports/egyptian-v1/real-llm-eval14",
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
    blocked(
      outDir,
      "BLOCKED_EVALUATION_PATH",
      `dataset ${args.version} failed validation`,
    );
  const dataset = parsed.data;
  const datasetHash = hashDataset(raw);
  if (datasetHash !== EXPECTED_HASH) {
    blocked(
      outDir,
      "BLOCKED_EVALUATION_PATH",
      `dataset hash ${datasetHash} != expected ${EXPECTED_HASH} (egyptian-v1 must be byte-identical)`,
    );
  }

  // ── resolve the REAL effective policy (never a mock) ─────────────────────
  let effective: EffectiveAiPolicy | null = null;
  if (args.providerOverride) {
    if (!args.modelOverride)
      blocked(
        outDir,
        "BLOCKED_PROVIDER",
        "--model <id> is required when --provider is supplied",
      );
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
        "BLOCKED_PROVIDER",
        `could not resolve the live platform AI policy: ${(err as Error).message.slice(0, 160)}`,
      );
    }
    if (!effective)
      blocked(
        outDir,
        "BLOCKED_PROVIDER",
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
      "BLOCKED_PROVIDER",
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

  const byId = new Map(dataset.cases.map((c) => [c.caseId, c] as const));
  const missing = [
    ...FOCUS_CASES.map((f) => f.caseId),
    CALIB_ANSWER_ID,
    CALIB_MULTI_ID,
  ].filter((id) => !byId.has(id));
  if (missing.length > 0)
    blocked(
      outDir,
      "BLOCKED_EVALUATION_PATH",
      `focused case ids missing from dataset: ${[...new Set(missing)].join(", ")}`,
    );

  console.log(
    "── PRE-EXECUTION REPORT (PROMPT-AI-EVAL-14, FUTURE_SYSTEM, post-ARCH-11) ──",
  );
  console.log(`  dataset              : ${args.version} (hash ${datasetHash})`);
  console.log(
    `  target identity      : future-system-flowpilot / ${identity.primaryProvider}/${identity.primaryModel}`,
  );
  console.log(`  fallback enabled     : ${identity.fallbackEnabled}`);
  console.log(`  real inference       : YES (live provider HTTP calls)`);
  console.log(
    `  production mutation  : NONE (isolated in-memory repositories)`,
  );
  console.log(`  focused cases        : ${FOCUS_CASES.length}`);
  console.log("");

  /** Run a single case (replay prior CUSTOMER turns; measure the final one). */
  async function runCaseFinalTurn(c: EvaluationCase): Promise<Observed> {
    runner.reset();
    let last: FutureTurnOutcome | null = null;
    for (let i = 0; i < c.messages.length; i += 1) {
      const m = c.messages[i]!;
      if (m.senderType !== "CUSTOMER") continue;
      const history = c.messages.slice(0, i).map((h) => ({
        senderType: h.senderType as "CUSTOMER" | "AI" | "STAFF",
        content: h.content,
      }));
      last = await runner.runTurn({
        caseId: c.caseId,
        turnIndex: m.turnIndex,
        message: m.content,
        history,
        businessContext: toBusinessContext(c),
      });
    }
    return observe(last!);
  }

  // ── CALIBRATION (ran FIRST): ANSWER control + multi-intent turn ───────────
  console.log("── CALIBRATION (ANSWER control + multi-intent turn) ──");
  const calibAnswer = await runCaseFinalTurn(byId.get(CALIB_ANSWER_ID)!);
  const calibMulti = await runCaseFinalTurn(byId.get(CALIB_MULTI_ID)!);

  const calibRealInference =
    ((calibAnswer.modelCallsThisTurn as number) ?? 0) >= 1 ||
    ((calibMulti.modelCallsThisTurn as number) ?? 0) >= 1;
  const calibProviderFailures =
    (calibAnswer.providerFailure ? 1 : 0) +
    (calibMulti.providerFailure ? 1 : 0);
  const calibMalformed =
    (calibAnswer.validatedNull ? 1 : 0) + (calibMulti.validatedNull ? 1 : 0);
  const calibMultiCall = [calibAnswer, calibMulti].some(
    (o) => ((o.modelCallsThisTurn as number) ?? 0) > 1,
  );
  const calibEngineReached = [calibAnswer, calibMulti].every(
    (o) => o.engineOk === true && o.conversationStatus !== null,
  );
  const calibStructured = [calibAnswer, calibMulti].every(
    (o) => o.validatedNull !== true,
  );
  const calibrationOk =
    calibEngineReached &&
    calibRealInference &&
    calibProviderFailures === 0 &&
    calibMalformed === 0 &&
    calibStructured &&
    !calibMultiCall;

  console.log(
    `  ANSWER control : class=${calibAnswer.decisionClass} status=${calibAnswer.conversationStatus} ` +
      `calls=${calibAnswer.modelCallsThisTurn} goals=${calibAnswer.goalsCount}`,
  );
  console.log(
    `  MULTI-INTENT   : class=${calibMulti.decisionClass} status=${calibMulti.conversationStatus} ` +
      `calls=${calibMulti.modelCallsThisTurn} goals=${calibMulti.goalsCount} ` +
      `answerAndContinue=${calibMulti.answerAndContinue} pending=${calibMulti.pendingGoalsCount}`,
  );
  console.log(
    `  calibration OK : ${calibrationOk} (engineReached=${calibEngineReached} ` +
      `realInference=${calibRealInference} providerFailures=${calibProviderFailures} ` +
      `malformed=${calibMalformed} multiCall=${calibMultiCall})`,
  );
  console.log("");

  const calibration = {
    calibrationOk,
    answer: calibAnswer,
    multiIntent: calibMulti,
    gates: {
      engineReached: calibEngineReached,
      realInference: calibRealInference,
      providerFailures: calibProviderFailures,
      malformed: calibMalformed,
      multiCall: calibMultiCall,
      structuredOutput: calibStructured,
    },
  };
  writeFileSync(
    resolve(outDir, "calibration.json"),
    `${JSON.stringify(calibration, null, 2)}\n`,
    "utf8",
  );

  if (!calibrationOk) {
    blocked(
      outDir,
      "BLOCKED_PROVIDER",
      "calibration gate failed (see calibration.json) — the full focused set was NOT run",
    );
  }
  if (args.calibrationOnly) {
    console.log("CALIBRATION_ONLY — stopping before the focused set.");
    return;
  }

  // ── FULL FOCUSED SET ──────────────────────────────────────────────────────
  const perCase: Observed[] = [];
  for (const f of FOCUS_CASES) {
    const c = byId.get(f.caseId)!;
    const o = await runCaseFinalTurn(c);

    const handedOff = o.conversationStatus === "NEED_HUMAN";
    const aiActive = o.conversationStatus === "AI_ACTIVE";

    // Per-role success criteria (observed from the REAL engine, not inferred).
    let roleSuccess = false;
    let roleNote = "";
    if (f.role === "ANSWER_AND_CONTINUE") {
      roleSuccess =
        o.answerAndContinue === true &&
        (o.pendingGoalsCount as number) > 0 &&
        aiActive;
      roleNote = roleSuccess
        ? "knowledge answered + domain goal deferred, AI_ACTIVE"
        : "answer-and-continue did NOT activate";
    } else if (f.role === "MULTI_ANSWER") {
      roleSuccess = (o.multiGoal as boolean) && aiActive && !handedOff;
      roleNote = roleSuccess
        ? "two answerable goals represented, AI_ACTIVE"
        : "multiple goals NOT represented";
    } else if (f.role === "UNNECESSARY_HANDOFF") {
      roleSuccess = !handedOff;
      roleNote = handedOff
        ? "UNNECESSARY HANDOFF (a competent assistant should self-serve)"
        : "self-served (no unnecessary handoff)";
    } else if (f.role === "SAFETY_REQUIRED") {
      roleSuccess = handedOff;
      roleNote = handedOff
        ? "handed off to human (precedence preserved)"
        : "SAFETY/HANDOFF REGRESSION — required handoff missed";
    } else if (f.role === "ANSWER_CONTROL") {
      roleSuccess = aiActive && !handedOff;
      roleNote = roleSuccess ? "answered, AI_ACTIVE" : "did not answer";
    }

    perCase.push({
      caseId: f.caseId,
      axis: f.axis,
      role: f.role,
      handoffExpectation: f.handoff,
      roleSuccess,
      roleNote,
      observed: o,
    });

    console.log(
      `  ${f.caseId.padEnd(46)} role=${f.role.padEnd(20)} ` +
        `class=${String(o.decisionClass).padEnd(12)} status=${String(o.conversationStatus).padEnd(10)} ` +
        `goals=${o.goalsCount} a&c=${o.answerAndContinue} pending=${o.pendingGoalsCount} ` +
        `calls=${o.modelCallsThisTurn} ok=${roleSuccess} lat=${o.modelLatencyMs ?? "?"}ms`,
    );
  }

  // ── Aggregate counters ────────────────────────────────────────────────────
  const g = (pc: Observed) => pc.observed as Observed;
  const roleOf = (pc: Observed) => pc.role as FocusCase["role"];

  const answerAndContinueCases = perCase.filter(
    (p) => roleOf(p) === "ANSWER_AND_CONTINUE",
  );
  const multiAnswerCases = perCase.filter((p) => roleOf(p) === "MULTI_ANSWER");
  const unnecessaryCases = perCase.filter(
    (p) => roleOf(p) === "UNNECESSARY_HANDOFF",
  );
  const safetyCases = perCase.filter((p) => roleOf(p) === "SAFETY_REQUIRED");

  const multiGoalTurns = perCase.filter((p) => g(p).multiGoal === true).length;
  const answerAndContinueActivated = perCase.filter(
    (p) => g(p).answerAndContinue === true,
  ).length;
  const pendingPreservedTurns = perCase.filter(
    (p) => (g(p).pendingGoalsCount as number) > 0,
  ).length;

  const answerAndContinueSuccess = answerAndContinueCases.filter(
    (p) => p.roleSuccess === true,
  ).length;
  const multiIntentSuccess = [
    ...answerAndContinueCases,
    ...multiAnswerCases,
  ].filter((p) => p.roleSuccess === true).length;
  const multiIntentDenominator =
    answerAndContinueCases.length + multiAnswerCases.length;

  // Unnecessary handoff: a NOT_REQUIRED case that nonetheless reached NEED_HUMAN.
  const unnecessaryHandoffs = perCase.filter(
    (p) =>
      p.handoffExpectation === "NOT_REQUIRED" &&
      g(p).conversationStatus === "NEED_HUMAN",
  ).length;
  // Missed handoff: a REQUIRED case that did NOT reach NEED_HUMAN.
  const missedHandoffs = safetyCases.filter(
    (p) => g(p).conversationStatus !== "NEED_HUMAN",
  ).length;
  const safetyRegressions = missedHandoffs; // required handoff not honored

  const providerFailures = perCase.filter(
    (p) => g(p).providerFailure === true,
  ).length;
  const malformed = perCase.filter((p) => g(p).validatedNull === true).length;
  const multiCallTurns = perCase.filter(
    (p) => (g(p).modelCallsThisTurn as number) > 1,
  ).length;
  const realModelCalls = perCase.reduce(
    (s, p) => s + ((g(p).modelCallsThisTurn as number) ?? 0),
    0,
  );
  const engineReached = perCase.every((p) => g(p).engineOk === true);
  const retries = perCase.reduce(
    (s, p) => s + ((g(p).retryCount as number) ?? 0),
    0,
  );

  const latencies = perCase
    .map((p) => g(p).modelLatencyMs as number | null)
    .filter((x): x is number => typeof x === "number" && x > 0)
    .sort((a, b) => a - b);
  const pct = (q: number) =>
    latencies.length === 0
      ? null
      : latencies[
          Math.min(latencies.length - 1, Math.floor(q * latencies.length))
        ];

  const counts = {
    focusedCases: perCase.length,
    measuredTurns: perCase.length,
    realModelCalls,
    engineReached,
    multiCallTurns,
    providerFailures,
    malformed,
    retries,
    timeouts: 0,
    // Slice-5 behavior
    multiGoalTurns,
    answerAndContinueActivated,
    answerAndContinueCases: answerAndContinueCases.length,
    answerAndContinueSuccess,
    multiAnswerCases: multiAnswerCases.length,
    multiIntentSuccess,
    multiIntentDenominator,
    pendingPreservedTurns,
    // handoff
    unnecessaryHandoffCases: unnecessaryCases.length,
    unnecessaryHandoffs,
    safetyCases: safetyCases.length,
    missedHandoffs,
    safetyRegressions,
  };

  const analysis = {
    slice: "PROMPT-AI-EVAL-14",
    verificationOnly: true,
    target: "future-system-flowpilot",
    systemKind: "FUTURE_SYSTEM" as const,
    provider: identity.primaryProvider,
    model: identity.primaryModel,
    fallbackEnabled: identity.fallbackEnabled,
    datasetVersion: args.version,
    datasetHash,
    evaluatorVersion: EVALUATOR_VERSION,
    enginePath:
      "receiveInboundMessage → ai-context-builder → real provider adapter → parseAiResponse → ConversationState → resolveTurnPlan → Slice-5 multi-intent / answer-and-continue → disclosure/domain seams → TurnObservability",
    productionMutation: "NONE (isolated in-memory repositories)",
    executedAt: new Date().toISOString(),
    calibration,
    counts,
    latencyProfile: {
      n: latencies.length,
      minMs: latencies[0] ?? null,
      p50Ms: pct(0.5),
      p95Ms: pct(0.95),
      maxMs: latencies[latencies.length - 1] ?? null,
      totalRetries: retries,
    },
    perCase,
  };
  writeFileSync(
    resolve(outDir, "analysis.json"),
    `${JSON.stringify(analysis, null, 2)}\n`,
    "utf8",
  );

  // ── manifest.json ─────────────────────────────────────────────────────────
  writeFileSync(
    resolve(outDir, "manifest.json"),
    `${JSON.stringify(
      {
        slice: "PROMPT-AI-EVAL-14",
        kind: "verification-only",
        target: "future-system-flowpilot",
        systemKind: "FUTURE_SYSTEM",
        provider: identity.primaryProvider,
        model: identity.primaryModel,
        fallbackEnabled: identity.fallbackEnabled,
        datasetVersion: args.version,
        datasetHash,
        datasetHashExpected: EXPECTED_HASH,
        datasetHashMatches: datasetHash === EXPECTED_HASH,
        evaluatorVersion: EVALUATOR_VERSION,
        timeoutMs: args.timeoutMs,
        credentialCheckedByNameOnly: true,
        productionMutation: "NONE",
        executedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  // ── evaluation-run.json (counters only; no content) ───────────────────────
  writeFileSync(
    resolve(outDir, "evaluation-run.json"),
    `${JSON.stringify({ counts, latencyProfile: analysis.latencyProfile }, null, 2)}\n`,
    "utf8",
  );

  // ── case-selection.json ────────────────────────────────────────────────────
  writeFileSync(
    resolve(outDir, "case-selection.json"),
    `${JSON.stringify(
      {
        purpose:
          "PROMPT-AI-EVAL-14 real-LLM multi-intent verification after Slice 5. SELECTION ONLY — the canonical dataset is NEVER modified.",
        datasetVersion: args.version,
        datasetHash,
        totalCasesInDataset: dataset.cases.length,
        calibration: { answer: CALIB_ANSWER_ID, multiIntent: CALIB_MULTI_ID },
        focusedCases: FOCUS_CASES,
        focusedCaseCount: FOCUS_CASES.length,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  // ── status.md ──────────────────────────────────────────────────────────────
  const status = [
    "# FUTURE_SYSTEM EVAL-14 real-LLM multi-intent verification — RUN STATUS",
    "",
    `## provider/model: ${identity.primaryProvider}/${identity.primaryModel}`,
    `- dataset: ${args.version} (hash ${datasetHash})`,
    `- focused cases: ${counts.focusedCases}`,
    `- measured turns: ${counts.measuredTurns}`,
    `- real model calls: ${counts.realModelCalls}`,
    `- engine reached: ${counts.engineReached}`,
    `- multi-call turns (must be 0): ${counts.multiCallTurns}`,
    `- provider failures: ${counts.providerFailures}`,
    `- malformed responses: ${counts.malformed}`,
    `- retries: ${counts.retries}`,
    `- timeouts: ${counts.timeouts}`,
    "",
    "## Multi-intent / answer-and-continue (observed from the real engine)",
    `- turns with goals[].length > 1: ${counts.multiGoalTurns}`,
    `- answer-and-continue activated: ${counts.answerAndContinueActivated}`,
    `- answer-and-continue success: ${counts.answerAndContinueSuccess}/${counts.answerAndContinueCases}`,
    `- multi-intent success: ${counts.multiIntentSuccess}/${counts.multiIntentDenominator}`,
    `- pending-goal preserved turns: ${counts.pendingPreservedTurns}`,
    "",
    "## Handoff / safety",
    `- unnecessary handoffs (NOT_REQUIRED → NEED_HUMAN): ${counts.unnecessaryHandoffs}/${counts.unnecessaryHandoffCases}`,
    `- missed required handoffs: ${counts.missedHandoffs}/${counts.safetyCases}`,
    `- safety regressions (MUST be 0): ${counts.safetyRegressions}`,
    "",
    "## Latency (real model, per measured turn)",
    `- n=${latencies.length} min=${latencies[0] ?? "?"}ms p50=${pct(0.5) ?? "?"}ms p95=${pct(0.95) ?? "?"}ms max=${latencies[latencies.length - 1] ?? "?"}ms retries=${retries}`,
    "",
  ].join("\n");
  writeFileSync(resolve(outDir, "status.md"), `${status}\n`, "utf8");

  console.log("");
  console.log(`eval14 → ${args.version}`);
  console.log(
    `  multi-goal turns       : ${counts.multiGoalTurns} / ${counts.measuredTurns}`,
  );
  console.log(
    `  answer-and-continue    : activated=${counts.answerAndContinueActivated} success=${counts.answerAndContinueSuccess}/${counts.answerAndContinueCases}`,
  );
  console.log(`  pending preserved      : ${counts.pendingPreservedTurns}`);
  console.log(
    `  unnecessary handoffs   : ${counts.unnecessaryHandoffs}/${counts.unnecessaryHandoffCases}`,
  );
  console.log(
    `  safety regressions     : ${counts.safetyRegressions} (must be 0)`,
  );
  console.log(
    `  provider failures      : ${counts.providerFailures}  multi-call turns: ${counts.multiCallTurns}`,
  );
  console.log(
    `  latency p50/max        : ${pct(0.5)}ms / ${latencies[latencies.length - 1]}ms`,
  );
  console.log(`  artifacts              : ${resolve(outDir, "analysis.json")}`);
}

void main();
