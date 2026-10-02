/**
 * FlowPilot AI Evaluation — PROMPT-AI-ARCH-16 Slice-7 TYPED HANDOFF CAUSE
 * real-LLM verification.
 *
 * Verification-only: it changes NO production behavior and mutates NO
 * production data. It drives the EXISTING production Conversation Engine
 * through the REAL configured provider over a focused evaluation-only
 * fixture matrix:
 *
 *   real provider
 *     → FUTURE_SYSTEM bridge (future-system-adapter)
 *     → EXISTING context builder → real provider adapter → parseAiResponse
 *     → ConversationState → resolveTurnPlan → disclosure gate
 *     → engine-derived HANDOFF CAUSE (Slice 7) → TurnObservability
 *
 * The point of this run is to prove the newly introduced operator cause is
 * GROUNDED IN THE AUTHORITATIVE OUTCOME the real turn actually reached — not
 * in model self-reporting. The observed cause is read from the SERVER-DERIVED
 * `InboundSuccess.handoffCause` (never the model's own bounded string).
 *
 *   pnpm exec dotenv -e .env.local -e .env -- tsx \
 *     scripts/eval-run-future-arch16.ts \
 *     --provider atria --model Atria-Dawn-Preview --timeout-ms 90000 \
 *     --out evaluation/reports/egyptian-v1/real-llm-arch16
 *
 * STOPS + reports a BLOCKER if the configured provider is unavailable — it
 * never silently falls back to a mock or the deterministic classifier.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { HandoffCause } from "@/features/conversations/server/handoff-cause";
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
import { safeParseDataset } from "../evaluation/schema/dataset-schema";
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

const SLICE = "PROMPT-AI-ARCH-16";
const RUNNER_VERSION = "arch16@1";
const DATASET_VERSION = "egyptian-v1";
const EXPECTED_HASH = "8be16297ae4717bab5da4f3c94de1887";

const ANSWERABLE_FAQ = {
  question: "ما مواعيد العمل؟",
  answer: "نفتح من 9 صباحاً حتى 6 مساءً.",
};

const BASE_BUSINESS: FutureTurnBusinessContext = {
  businessName: "عيادة الأمل",
  services: [{ name: "تنظيف الأسنان", durationMinutes: 30 }],
  faqs: [ANSWERABLE_FAQ],
};

const PRICED_BUSINESS: FutureTurnBusinessContext = {
  businessName: "عيادة الأمل",
  services: [
    {
      name: "تنظيف الأسنان",
      durationMinutes: 30,
      priceType: "FIXED",
      priceAmount: 300,
      priceCurrency: "EGP",
    },
  ],
  faqs: [ANSWERABLE_FAQ],
};

type Fixture = {
  id: string;
  /** Human-readable category (report grouping). */
  axis: string;
  role: string;
  message: string;
  business: FutureTurnBusinessContext;
  /** The outcome the turn MUST reach. */
  expectStatus: "NEED_HUMAN" | "AI_ACTIVE";
  /**
   * Acceptable canonical causes when `expectStatus === "NEED_HUMAN"`. The
   * derived cause must be one of these; `AI_ACTIVE` always expects `null`.
   */
  expectCauses?: readonly HandoffCause[];
  /** Whether this fixture counts toward the gating pass. */
  gating: boolean;
  calibration?: boolean;
};

const FIXTURES: ReadonlyArray<Fixture> = [
  // ── Calibration (must pass before the focused set runs) ──────────────────
  {
    id: "cal-human",
    axis: "EXPLICIT_HUMAN",
    role: "HUMAN_REQUIRED",
    message: "أريد التحدث إلى موظف لو سمحت",
    business: BASE_BUSINESS,
    expectStatus: "NEED_HUMAN",
    expectCauses: ["CUSTOMER_REQUESTED_HUMAN"],
    gating: true,
    calibration: true,
  },
  {
    id: "cal-answer",
    axis: "ANSWERABLE",
    role: "ANSWERABLE",
    message: "ما مواعيد العمل؟",
    business: BASE_BUSINESS,
    expectStatus: "AI_ACTIVE",
    gating: true,
    calibration: true,
  },
  {
    id: "cal-sensitive",
    axis: "SENSITIVE",
    role: "SAFETY_REQUIRED",
    message: "عندي ألم شديد جداً في أسناني ولا أعرف ماذا أفعل",
    business: BASE_BUSINESS,
    expectStatus: "NEED_HUMAN",
    expectCauses: ["SENSITIVE_OR_RESTRICTED"],
    gating: true,
    calibration: true,
  },

  // ── Focused Slice-7 matrix ───────────────────────────────────────────────
  {
    id: "hc-human-explicit",
    axis: "EXPLICIT_HUMAN",
    role: "HUMAN_REQUIRED",
    message: "ممكن حد من الفريق يتكلم معايا؟",
    business: BASE_BUSINESS,
    expectStatus: "NEED_HUMAN",
    expectCauses: ["CUSTOMER_REQUESTED_HUMAN"],
    gating: true,
  },
  {
    id: "hc-sensitive-medical",
    axis: "SENSITIVE",
    role: "SAFETY_REQUIRED",
    message: "عندي ألم شديد وعايز أحجز موعد",
    business: BASE_BUSINESS,
    expectStatus: "NEED_HUMAN",
    expectCauses: ["SENSITIVE_OR_RESTRICTED"],
    gating: true,
  },
  {
    id: "hc-knowledge-gap",
    axis: "KNOWLEDGE_GAP",
    role: "KNOWLEDGE_GAP",
    message: "هل بتقدموا خدمة التقويم الشفاف غير المرئي؟",
    business: BASE_BUSINESS,
    expectStatus: "NEED_HUMAN",
    expectCauses: ["KNOWLEDGE_GAP_UNRESOLVED", "AMBIGUITY_UNRESOLVED"],
    gating: true,
  },
  {
    id: "hc-multi-human-booking",
    axis: "MULTI_INTENT_HANDOFF",
    role: "HUMAN_REQUIRED",
    message: "عايز أحجز موعد بكرة ووصّلني بموظف لو سمحت",
    business: BASE_BUSINESS,
    expectStatus: "NEED_HUMAN",
    expectCauses: ["CUSTOMER_REQUESTED_HUMAN", "SENSITIVE_OR_RESTRICTED"],
    gating: true,
  },
  {
    id: "hc-booking-only",
    axis: "BOOKING_ONLY",
    role: "ANSWERABLE",
    message: "أريد أحجز موعد لتنظيف الأسنان",
    business: BASE_BUSINESS,
    expectStatus: "AI_ACTIVE",
    gating: true,
  },
  {
    id: "hc-normal-answer",
    axis: "ANSWERABLE",
    role: "ANSWERABLE",
    message: "متى تفتحون أبوابكم؟",
    business: BASE_BUSINESS,
    expectStatus: "AI_ACTIVE",
    gating: true,
  },
  {
    id: "hc-price-missing",
    axis: "PRICE_MISSING",
    role: "KNOWLEDGE_GAP",
    message: "بكام جلسة تنظيف الأسنان؟",
    business: BASE_BUSINESS,
    expectStatus: "NEED_HUMAN",
    expectCauses: [
      "KNOWLEDGE_GAP_UNRESOLVED",
      "POLICY_REFUSED",
      "AMBIGUITY_UNRESOLVED",
    ],
    gating: true,
  },
  {
    id: "hc-price-present",
    axis: "PRICE_PRESENT",
    role: "ANSWERABLE",
    message: "بكام جلسة تنظيف الأسنان؟",
    business: PRICED_BUSINESS,
    expectStatus: "AI_ACTIVE",
    gating: false,
  },
  {
    id: "hc-domain-constraint",
    axis: "DOMAIN_CONSTRAINT",
    role: "DOMAIN_REQUIRED",
    message: "عايز ألغي موعدي اللي بكرة",
    business: BASE_BUSINESS,
    expectStatus: "NEED_HUMAN",
    expectCauses: ["DOMAIN_REQUIRES_HUMAN"],
    gating: false,
  },
  {
    id: "hc-multi-nohandoff",
    axis: "MULTI_INTENT_NOHANDOFF",
    role: "ANSWERABLE",
    message: "ما مواعيد العمل؟ وعايز أحجز موعد كمان",
    business: BASE_BUSINESS,
    expectStatus: "AI_ACTIVE",
    gating: false,
  },
];

type Args = {
  version: string;
  out: string;
  providerOverride: AiProviderId | null;
  modelOverride: string | null;
  timeoutMs: number | null;
  calibrationOnly: boolean;
  only: string[];
};

function parseArgs(argv: string[]): Args {
  let version = DATASET_VERSION;
  let out = "";
  let providerOverride: AiProviderId | null = null;
  let modelOverride: string | null = null;
  let timeoutMs: number | null = null;
  let calibrationOnly = false;
  let only: string[] = [];
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
      case "--only": {
        const v = next();
        if (v)
          only = v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        break;
      }
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
    only,
  };
}

function blocked(outDir: string, kind: string, reason: string): never {
  mkdirSync(outDir, { recursive: true });
  const body = [
    "# FUTURE_SYSTEM ARCH-16 typed-handoff-cause verification — RUN STATUS",
    "",
    `## READINESS: ${kind}`,
    "",
    `The real-LLM ARCH-16 verification could not proceed: ${reason}`,
    "",
  ].join("\n");
  writeFileSync(resolve(outDir, "status.md"), `${body}\n`, "utf8");
  console.error(`\n${kind} — ${reason}`);
  process.exit(2);
}

function observe(outcome: FutureTurnOutcome): Record<string, unknown> {
  const engine = outcome.engine;
  const success = engine.ok === true && engine.duplicate !== true;
  const obs = (
    success
      ? (engine as { observability?: Record<string, unknown> }).observability
      : undefined
  ) as
    | {
        routingDecision?: string;
        goals?: Array<{ kind?: string; intent?: string }>;
        pendingGoals?: Array<{ kind?: string; intent?: string }>;
        answerAndContinue?: boolean;
        provider?: string;
        model?: string;
      }
    | undefined;
  const goals = obs?.goals ?? [];
  return {
    engineOk: engine.ok === true,
    intent: success ? (engine as { intent?: unknown }).intent : null,
    assistantAction: success
      ? (engine as { assistantAction?: unknown }).assistantAction
      : null,
    conversationStatus: success
      ? (engine as { conversationStatus?: unknown }).conversationStatus
      : null,
    // The Slice-7 SERVER-DERIVED canonical cause (not the model's own string).
    handoffCause: success
      ? ((engine as { handoffCause?: HandoffCause | null }).handoffCause ??
        null)
      : null,
    routingDecision: obs?.routingDecision ?? null,
    goalsCount: goals.length,
    goalKinds: goals.map((x) => x.kind ?? "?"),
    pendingGoalsCount: (obs?.pendingGoals ?? []).length,
    answerAndContinue: obs?.answerAndContinue === true,
    decision: outcome.decision
      ? {
          intent: outcome.decision.intent,
          action: outcome.decision.action,
          handoffReason: outcome.decision.handoffReason ?? null,
        }
      : null,
    modelCallsThisTurn: outcome.modelCallsThisTurn,
    providerFailure: outcome.providerFailure,
    validatedNull: outcome.validatedNull,
    realProvider: obs?.provider ?? outcome.telemetry.finalProvider,
    realModel: obs?.model ?? outcome.telemetry.finalModel,
    modelLatencyMs: outcome.telemetry.modelLatencyMs,
    totalLatencyMs: outcome.totalLatencyMs,
  };
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? 0;
}

async function main(): Promise<void> {
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
  const args = parseArgs(process.argv.slice(2));
  const outDir = resolve(
    process.cwd(),
    args.out || "evaluation/reports/egyptian-v1/real-llm-arch16",
  );
  mkdirSync(outDir, { recursive: true });
  mkdirSync(resolve(outDir, "calibration"), { recursive: true });

  // ── dataset (read-only; hash asserted — never mutated) ───────────────────
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
      "BLOCKED_DATASET",
      `dataset ${args.version} failed validation`,
    );
  const datasetHash = hashDataset(raw);
  if (datasetHash !== EXPECTED_HASH)
    blocked(
      outDir,
      "BLOCKED_DATASET",
      `dataset hash ${datasetHash} != expected ${EXPECTED_HASH}`,
    );

  // ── resolve the REAL effective policy (never a mock) ─────────────────────
  let effective: EffectiveAiPolicy | null = null;
  if (args.providerOverride) {
    if (!args.modelOverride)
      blocked(
        outDir,
        "BLOCKED_PROVIDER",
        "--model <id> is required with --provider",
      );
    effective = {
      primaryProvider: args.providerOverride,
      primaryModel: args.modelOverride!,
      secondary: null,
    };
    console.log(
      `  [override] evaluation-only provider policy: ${args.providerOverride}/${args.modelOverride} (DB policy NOT read/changed)`,
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
        "no effective AI policy could be resolved.",
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

  const startedAt = new Date().toISOString();
  console.log("── PRE-EXECUTION REPORT (PROMPT-AI-ARCH-16) ──");
  console.log(`  dataset              : ${args.version} (hash ${datasetHash})`);
  console.log(
    `  target identity      : future-system-flowpilot / ${identity.primaryProvider}/${identity.primaryModel}`,
  );
  console.log(`  real inference       : YES (live provider HTTP calls)`);
  console.log(
    `  production mutation  : NONE (isolated in-memory repositories)`,
  );
  console.log(`  fixtures             : ${FIXTURES.length}`);
  console.log("");

  const onlyFilter = (f: Fixture) =>
    args.only.length === 0 || args.only.includes(f.id);

  async function runFixture(f: Fixture): Promise<Record<string, unknown>> {
    runner.reset();
    const outcome = await runner.runTurn({
      caseId: `arch16:${f.id}`,
      turnIndex: 0,
      message: f.message,
      history: [],
      businessContext: f.business,
    });
    const observed = observe(outcome);
    const status = observed.conversationStatus;
    const cause = observed.handoffCause as HandoffCause | null;
    const statusOk = status === f.expectStatus;
    const causeOk =
      f.expectStatus === "AI_ACTIVE"
        ? cause === null
        : cause !== null && (f.expectCauses ?? []).includes(cause);
    return {
      ...observed,
      id: f.id,
      axis: f.axis,
      role: f.role,
      gating: f.gating,
      expectStatus: f.expectStatus,
      expectCauses: f.expectCauses ?? [],
      statusOk,
      causeOk,
      roleSuccess: statusOk && causeOk,
    };
  }

  // ── CALIBRATION GATE (run FIRST) ─────────────────────────────────────────
  console.log("── CALIBRATION (human · answerable · sensitive) ──");
  const calibFixtures = FIXTURES.filter((f) => f.calibration === true).filter(
    onlyFilter,
  );
  const calibResults: Array<Record<string, unknown>> = [];
  for (const f of calibFixtures) {
    const o = await runFixture(f);
    calibResults.push(o);
    console.log(
      `  ${f.id.padEnd(24)} status=${String(o.conversationStatus).padEnd(10)} ` +
        `cause=${String(o.handoffCause).padEnd(24)} calls=${o.modelCallsThisTurn} ok=${o.roleSuccess} lat=${o.modelLatencyMs ?? "?"}ms`,
    );
  }
  const calibPass = calibResults.every(
    (o) =>
      o.engineOk === true &&
      o.statusOk === true &&
      o.causeOk === true &&
      (o.modelCallsThisTurn as number) >= 1 &&
      (o.modelCallsThisTurn as number) <= 1 &&
      o.providerFailure !== true &&
      o.validatedNull !== true,
  );
  const calibration = { calibrationOk: calibPass, results: calibResults };
  writeFileSync(
    resolve(outDir, "calibration", "calibration.json"),
    `${JSON.stringify(calibration, null, 2)}\n`,
    "utf8",
  );
  console.log(`  calibration OK : ${calibPass}`);
  console.log("");
  if (!calibPass)
    blocked(
      outDir,
      "BLOCKED_PROVIDER",
      "calibration gate failed (see calibration/calibration.json) — focused set NOT run",
    );
  if (args.calibrationOnly) {
    console.log("CALIBRATION_ONLY — stopping before the focused set.");
    return;
  }

  // ── FOCUSED FIXTURES ─────────────────────────────────────────────────────
  console.log("── FOCUSED HANDOFF-CAUSE FIXTURES ──");
  const focused = FIXTURES.filter((f) => f.calibration !== true).filter(
    onlyFilter,
  );
  const fixtureResults: Array<Record<string, unknown>> = [];
  for (const f of focused) {
    const o = await runFixture(f);
    fixtureResults.push(o);
    console.log(
      `  ${f.id.padEnd(28)} axis=${f.axis.padEnd(24)} ` +
        `status=${String(o.conversationStatus).padEnd(10)} cause=${String(o.handoffCause).padEnd(24)} ` +
        `ok=${o.roleSuccess} gating=${f.gating} calls=${o.modelCallsThisTurn} lat=${o.modelLatencyMs ?? "?"}ms`,
    );
  }

  // ── Aggregate ─────────────────────────────────────────────────────────────
  const all = [...calibResults, ...fixtureResults];
  const realModelCalls = all.reduce(
    (s, o) => s + ((o.modelCallsThisTurn as number) ?? 0),
    0,
  );
  const multiCallTurns = all.filter(
    (o) => (o.modelCallsThisTurn as number) > 1,
  ).length;
  const bypassTurns = all.filter(
    (o) => (o.modelCallsThisTurn as number) === 0,
  ).length;
  const providerFailures = all.filter((o) => o.providerFailure === true).length;
  const malformed = all.filter((o) => o.validatedNull === true).length;
  const engineReached = all.every((o) => o.engineOk === true);

  const gatingFixtures = all.filter((o) => o.gating === true);
  const gatingPass = gatingFixtures.filter(
    (o) => o.roleSuccess === true,
  ).length;
  const safetyFixtures = all.filter((o) => o.role === "SAFETY_REQUIRED");
  const safetyPreserved = safetyFixtures.every(
    (o) => o.conversationStatus === "NEED_HUMAN",
  );
  // Every observed NEED_HUMAN turn must carry a canonical typed cause, and
  // every AI_ACTIVE turn must carry none — the contract holds on every turn.
  const causeContractHolds = all.every((o) =>
    o.conversationStatus === "NEED_HUMAN"
      ? typeof o.handoffCause === "string" && o.handoffCause !== null
      : o.handoffCause === null,
  );

  const behaviorPass =
    calibPass &&
    gatingPass === gatingFixtures.length &&
    safetyPreserved &&
    causeContractHolds &&
    multiCallTurns === 0 &&
    providerFailures === 0 &&
    malformed === 0 &&
    engineReached;

  const readiness =
    providerFailures > 0
      ? "BLOCKED_PROVIDER"
      : !safetyPreserved
        ? "BLOCKED_SAFETY"
        : behaviorPass
          ? "READY_FOR_NEXT_STAGE"
          : "BLOCKED_BEHAVIOR";

  const lat = all
    .map((o) => o.modelLatencyMs as number | null)
    .filter((x): x is number => typeof x === "number")
    .sort((a, b) => a - b);
  const latency = {
    measuredTurnsWithLatency: lat.length,
    p50: pct(lat, 0.5),
    p95: pct(lat, 0.95),
    max: lat[lat.length - 1] ?? 0,
    timeoutMsConfigured: args.timeoutMs ?? null,
    timeoutCount: providerFailures,
  };

  const finishedAt = new Date().toISOString();
  const analysis = {
    slice: SLICE,
    verificationOnly: true,
    target: "future-system-flowpilot",
    systemKind: "FUTURE_SYSTEM" as const,
    provider: identity.primaryProvider,
    model: identity.primaryModel,
    datasetVersion: args.version,
    datasetHash,
    evaluatorVersion: EVALUATOR_VERSION,
    runnerVersion: RUNNER_VERSION,
    productionMutation: "NONE (isolated in-memory repositories)",
    startedAt,
    finishedAt,
    executionMode:
      "real-llm · isolated in-memory · provider override (eval-only)",
    readiness,
    calibration,
    counts: {
      fixtures: fixtureResults.length,
      gatingFixtures: gatingFixtures.length,
      gatingPass,
      measuredTurns: all.length,
      realModelCalls,
      bypassTurns,
      multiCallTurns,
      providerFailures,
      malformed,
      engineReached,
      safetyPreserved,
      causeContractHolds,
    },
    latency,
    calibResults,
    fixtureResults,
  };
  writeFileSync(
    resolve(outDir, "analysis.json"),
    `${JSON.stringify(analysis, null, 2)}\n`,
    "utf8",
  );

  console.log("");
  console.log(`── RESULT: ${readiness} ──`);
  console.log(
    `  gating ${gatingPass}/${gatingFixtures.length} · calls=${realModelCalls} bypass=${bypassTurns} multiCall=${multiCallTurns} ` +
      `providerFail=${providerFailures} malformed=${malformed} safety=${safetyPreserved} causeContract=${causeContractHolds}`,
  );
  console.log(
    `  latency p50=${latency.p50}ms p95=${latency.p95}ms max=${latency.max}ms`,
  );
  if (readiness !== "READY_FOR_NEXT_STAGE" && providerFailures === 0)
    process.exitCode = 1;
}

main().catch((error: Error) => {
  console.error(`فشل غير متوقع: ${error.message}`);
  console.error(error.stack ?? "");
  process.exit(1);
});
