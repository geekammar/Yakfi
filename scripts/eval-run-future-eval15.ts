/**
 * FlowPilot AI Evaluation — FUTURE_SYSTEM real-LLM SERVICE-PRICE verification
 * (PROMPT-AI-ARCH-13 — Slice 6: Service Pricing Foundation + task-gated price
 * exposure + missing-price handoff).
 *
 * Measurement ONLY. This CLI drives the EXISTING production Conversation Engine
 * through the REAL Atria provider and OBSERVES whether the Slice-6 price
 * foundation makes real price questions answerable WITHOUT hallucination:
 *
 *   real Atria
 *     → FUTURE_SYSTEM bridge (future-system-adapter)
 *     → EXISTING ai-context-builder (now exposes a task-gated service price)
 *     → real provider adapter → parseAiResponse
 *     → ConversationState → resolveTurnPlan → disclosure gate (price channel)
 *     → ActualOutcome / TurnObservability
 *
 * It changes NO production behavior and mutates NO production data (isolated
 * in-memory repositories). There is NO second engine / resolver / state /
 * planner / classifier. Prices are supplied two ways, NEITHER of which mutates
 * the canonical dataset (its byte hash is still asserted):
 *   1. HAND-AUTHORED eval-only fixtures (full control of message + price shape)
 *      — the established `eval-run-future-fixtures.ts` pattern;
 *   2. an eval-only PRICE OVERLAY on the 3 canonical EVAL-14 price cases
 *      (`mi-booking-plus-price`, `mi-availability-plus-price`,
 *      `mi-discovery-price-booking`) — the dataset case's businessContext is
 *      READ then cloned-with-prices; the dataset file is never written.
 *
 *   pnpm exec dotenv -e .env.local -e .env -- tsx scripts/eval-run-future-eval15.ts \
 *     --provider atria --model Atria-Dawn-Preview --timeout-ms 120000 \
 *     --out evaluation/reports/egyptian-v1/real-llm-eval15
 *
 * STOPS + reports a BLOCKER if the configured provider is unavailable — it
 * never silently falls back to a mock or the deterministic classifier.
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

type PriceCols = {
  priceType?: string | null;
  priceAmount?: number | null;
  priceMaxAmount?: number | null;
  priceCurrency?: string | null;
  priceNote?: string | null;
};

/**
 * Eval-only price overlay for the canonical CLINIC services, covering all four
 * shapes so the dataset price cases become answerable. Keyed by service name;
 * services absent from the map carry NO price (missing-price control).
 */
const CLINIC_PRICE_OVERLAY: Record<string, PriceCols> = {
  "تنظيف الأسنان": {
    priceType: "FIXED",
    priceAmount: 300,
    priceCurrency: "EGP",
  },
  "حشو الأسنان": {
    priceType: "STARTING_FROM",
    priceAmount: 250,
    priceCurrency: "EGP",
  },
  "تقويم الأسنان": {
    priceType: "RANGE",
    priceAmount: 5000,
    priceMaxAmount: 8000,
    priceCurrency: "EGP",
  },
  "خلع الضرس": { priceType: "FIXED", priceAmount: 200, priceCurrency: "EGP" },
  "تبييض الأسنان": { priceType: "CONDITIONAL", priceNote: "حسب الحالة" },
};

/** A hand-authored eval-only fixture turn (full control of message + price). */
type Fixture = {
  id: string;
  axis: string;
  role:
    | "ANSWER_CONTROL" // ordinary answerable (calibration)
    | "PRICE_PRESENT" // price question + stored price → answer, AI_ACTIVE
    | "PRICE_MISSING_QUESTION" // price question + NO price → NEED_HUMAN
    | "PRICE_MISSING_BOOKING" // booking-only + NO price → continue (NOT handoff for price)
    | "SAFETY_REQUIRED"; // sensitive/human → NEED_HUMAN (precedence preserved)
  message: string;
  business: FutureTurnBusinessContext;
  /** The expected terminal conversation status for a PASS. */
  expect: "AI_ACTIVE" | "NEED_HUMAN";
};

function clinic(
  prices: Record<string, PriceCols> = {},
): FutureTurnBusinessContext {
  return {
    businessName: "عيادة الأمل",
    services: [
      {
        name: "تنظيف الأسنان",
        durationMinutes: 30,
        ...(prices["تنظيف الأسنان"] ?? {}),
      },
      {
        name: "حشو الأسنان",
        durationMinutes: 45,
        ...(prices["حشو الأسنان"] ?? {}),
      },
      {
        name: "تقويم الأسنان",
        durationMinutes: 60,
        ...(prices["تقويم الأسنان"] ?? {}),
      },
    ],
    faqs: [
      {
        question: "ما هي ساعات العمل؟",
        answer: "نعمل يومياً من 10 صباحاً حتى 8 مساءً ما عدا الجمعة.",
      },
    ],
  };
}

const FIXED_ONLY = { "تنظيف الأسنان": CLINIC_PRICE_OVERLAY["تنظيف الأسنان"]! };
const RANGE_ONLY = { "تقويم الأسنان": CLINIC_PRICE_OVERLAY["تقويم الأسنان"]! };
const STARTING_ONLY = { "حشو الأسنان": CLINIC_PRICE_OVERLAY["حشو الأسنان"]! };
const CONDITIONAL_ONLY = {
  "تقويم الأسنان": {
    priceType: "CONDITIONAL",
    priceNote: "حسب الحالة",
  } as PriceCols,
};

const FIXTURES: ReadonlyArray<Fixture> = [
  // ── CALIBRATION (ran FIRST) ───────────────────────────────────────────────
  {
    id: "calib-ordinary-answerable",
    axis: "ordinary answerable FAQ (hours)",
    role: "ANSWER_CONTROL",
    message: "ساعات العمل إيه؟",
    business: clinic(),
    expect: "AI_ACTIVE",
  },
  {
    id: "calib-price-present",
    axis: "price question + stored fixed price",
    role: "PRICE_PRESENT",
    message: "تنظيف الأسنان بكام؟",
    business: clinic(FIXED_ONLY),
    expect: "AI_ACTIVE",
  },
  {
    id: "calib-price-missing",
    axis: "price question + NO stored price",
    role: "PRICE_MISSING_QUESTION",
    message: "تنظيف الأسنان بكام؟",
    business: clinic(),
    expect: "NEED_HUMAN",
  },
  // ── FOCUSED price shapes (A–D) ────────────────────────────────────────────
  {
    id: "price-fixed",
    axis: "A — fixed price answered from authoritative service data",
    role: "PRICE_PRESENT",
    message: "تنظيف الأسنان بكام؟",
    business: clinic(FIXED_ONLY),
    expect: "AI_ACTIVE",
  },
  {
    id: "price-range",
    axis: "B — range represented",
    role: "PRICE_PRESENT",
    message: "تقويم الأسنان بكام؟",
    business: clinic(RANGE_ONLY),
    expect: "AI_ACTIVE",
  },
  {
    id: "price-starting-from",
    axis: "C — starting-from represented",
    role: "PRICE_PRESENT",
    message: "حشو الأسنان بيبدأ من كام؟",
    business: clinic(STARTING_ONLY),
    expect: "AI_ACTIVE",
  },
  {
    id: "price-conditional",
    axis: "D — conditional pricing (never a fabricated amount)",
    role: "PRICE_PRESENT",
    message: "تقويم الأسنان بكام؟",
    business: clinic(CONDITIONAL_ONLY),
    expect: "AI_ACTIVE",
  },
  // ── MISSING price (E, F) ──────────────────────────────────────────────────
  {
    id: "price-missing-question",
    axis: "E — missing price + explicit price question → NEED_HUMAN",
    role: "PRICE_MISSING_QUESTION",
    message: "تقويم الأسنان بكام؟",
    business: clinic(),
    expect: "NEED_HUMAN",
  },
  {
    id: "price-missing-booking-only",
    axis: "F — missing price + booking-only (not requested) → continue",
    role: "PRICE_MISSING_BOOKING",
    message: "عايز أحجز تنظيف الأسنان بكرة",
    business: clinic(),
    expect: "AI_ACTIVE",
  },
  // ── SAFETY precedence (G) ─────────────────────────────────────────────────
  {
    id: "price-plus-human",
    axis: "G — explicit human request alongside price → NEED_HUMAN",
    role: "SAFETY_REQUIRED",
    message: "عايزة أكلم حد من حضراتكم، وبالمناسبة التنظيف بكام؟",
    business: clinic(FIXED_ONLY),
    expect: "NEED_HUMAN",
  },
];

/** The 3 canonical EVAL-14 price cases, run with the eval-only price overlay. */
const DATASET_CONVERSION_IDS = [
  "mi-booking-plus-price::u0",
  "mi-availability-plus-price::u0",
  "mi-discovery-price-booking::u0",
] as const;

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
    "# FUTURE_SYSTEM EVAL-15 service-price verification — RUN STATUS",
    "",
    `## READINESS: ${kind}`,
    "",
    `The real-LLM price verification could not proceed: ${reason}`,
    "",
    "The Slice-6 foundation itself is proven offline by `pnpm check:service-price`",
    "(30/30). This blocker is about REAL-LLM execution only: the bridge MUST use",
    "the real configured provider/model and never a mock or the deterministic",
    "classifier.",
    "",
  ].join("\n");
  writeFileSync(resolve(outDir, "status.md"), `${body}\n`, "utf8");
  console.error(`\n${kind} — ${reason}`);
  process.exit(2);
}

type Observed = Record<string, unknown>;
type Obs = {
  routingDecision?: string;
  goals?: Array<{ kind?: string; intent?: string }>;
  turnPlan?: { steps?: Array<{ kind?: string; intent?: string }> };
  pendingGoals?: Array<{ kind?: string; intent?: string }>;
  answerAndContinue?: boolean;
  provider?: string;
  model?: string;
};

function observe(outcome: FutureTurnOutcome): Observed {
  const engine = outcome.engine;
  const ok = engine.ok === true;
  const success = ok && engine.duplicate !== true;
  const obs = (success ? engine.observability : undefined) as Obs | undefined;
  const goals = obs?.goals ?? [];
  const steps = obs?.turnPlan?.steps ?? [];
  const pending = obs?.pendingGoals ?? [];
  const content =
    success && engine.ok
      ? ((engine as { delivery?: unknown }).delivery, undefined)
      : undefined;
  void content;
  return {
    engineOk: ok,
    intent: success ? engine.intent : null,
    assistantAction: success ? engine.assistantAction : null,
    conversationStatus: success ? engine.conversationStatus : null,
    routingDecision: obs?.routingDecision ?? null,
    decisionClass: steps[0]?.kind ?? null,
    goalsCount: goals.length,
    goalKinds: goals.map((x) => x.kind ?? "?"),
    multiGoal: goals.length > 1,
    pendingGoalsCount: pending.length,
    answerAndContinue: obs?.answerAndContinue === true,
    replyContent: success && outcome.decision ? outcome.decision.content : null,
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

/** Does the reply contain a bare fabricated digit (used for the D guard)? */
function containsDigits(text: unknown): boolean {
  return typeof text === "string" && /[0-9٠-٩]/.test(text);
}

async function main(): Promise<void> {
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
  const args = parseArgs(process.argv.slice(2));
  const outDir = resolve(
    process.cwd(),
    args.out || "evaluation/reports/egyptian-v1/real-llm-eval15",
  );
  mkdirSync(outDir, { recursive: true });

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
      "BLOCKED_SCHEMA",
      `dataset ${args.version} failed validation`,
    );
  const dataset = parsed.data;
  const datasetHash = hashDataset(raw);
  if (datasetHash !== EXPECTED_HASH) {
    blocked(
      outDir,
      "BLOCKED_SCHEMA",
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

  const byId = new Map(dataset.cases.map((c) => [c.caseId, c] as const));
  const missing = DATASET_CONVERSION_IDS.filter((id) => !byId.has(id));
  if (missing.length > 0)
    blocked(
      outDir,
      "BLOCKED_SCHEMA",
      `conversion case ids missing from dataset: ${missing.join(", ")}`,
    );

  console.log("── PRE-EXECUTION REPORT (PROMPT-AI-ARCH-13, FUTURE_SYSTEM) ──");
  console.log(`  dataset              : ${args.version} (hash ${datasetHash})`);
  console.log(
    `  target identity      : future-system-flowpilot / ${identity.primaryProvider}/${identity.primaryModel}`,
  );
  console.log(`  real inference       : YES (live provider HTTP calls)`);
  console.log(
    `  production mutation  : NONE (isolated in-memory repositories)`,
  );
  console.log(`  hand-authored fixtures: ${FIXTURES.length}`);
  console.log(`  dataset conversions  : ${DATASET_CONVERSION_IDS.length}`);
  console.log("");

  async function runFixture(f: Fixture): Promise<Observed> {
    runner.reset();
    const outcome = await runner.runTurn({
      caseId: `eval15:${f.id}`,
      turnIndex: 0,
      message: f.message,
      history: [],
      businessContext: f.business,
    });
    return { ...observe(outcome), id: f.id, axis: f.axis, role: f.role };
  }

  /** Dataset case final turn, with the eval-only CLINIC price overlay. */
  async function runConversion(c: EvaluationCase): Promise<Observed> {
    runner.reset();
    const business: FutureTurnBusinessContext = {
      businessName: c.businessContext.businessName,
      faqs: c.businessContext.faqs,
      services: c.businessContext.services.map((s) => ({
        name: s.name,
        durationMinutes: s.durationMinutes,
        ...(CLINIC_PRICE_OVERLAY[s.name] ?? {}),
      })),
    };
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
        businessContext: business,
      });
    }
    return { ...observe(last!), id: c.caseId };
  }

  // ── CALIBRATION (ran FIRST) ───────────────────────────────────────────────
  console.log("── CALIBRATION (ordinary · price-present · price-missing) ──");
  const calibFixtures = FIXTURES.filter((f) => f.id.startsWith("calib-"));
  const calibResults: Observed[] = [];
  for (const f of calibFixtures) {
    const o = await runFixture(f);
    calibResults.push(o);
    const statusOk = o.conversationStatus === f.expect;
    console.log(
      `  ${f.id.padEnd(24)} status=${String(o.conversationStatus).padEnd(10)} ` +
        `calls=${o.modelCallsThisTurn} expect=${f.expect} ok=${statusOk}`,
    );
  }
  const calibPass = calibResults.every((o, idx) => {
    const f = calibFixtures[idx]!;
    return (
      o.engineOk === true &&
      o.conversationStatus === f.expect &&
      (o.modelCallsThisTurn as number) >= 1 &&
      (o.modelCallsThisTurn as number) <= 1 &&
      o.providerFailure !== true &&
      o.validatedNull !== true
    );
  });
  const calibration = { calibrationOk: calibPass, results: calibResults };
  writeFileSync(
    resolve(outDir, "calibration.json"),
    `${JSON.stringify(calibration, null, 2)}\n`,
    "utf8",
  );
  console.log(`  calibration OK : ${calibPass}`);
  console.log("");
  if (!calibPass)
    blocked(
      outDir,
      "BLOCKED_PROVIDER",
      "calibration gate failed (see calibration.json) — focused set NOT run",
    );
  if (args.calibrationOnly) {
    console.log("CALIBRATION_ONLY — stopping before the focused set.");
    return;
  }

  // ── FOCUSED FIXTURES ──────────────────────────────────────────────────────
  console.log("── FOCUSED FIXTURES ──");
  const focusFixtures = FIXTURES.filter((f) => !f.id.startsWith("calib-"));
  const fixtureResults: Observed[] = [];
  for (const f of focusFixtures) {
    const o = await runFixture(f);
    const statusOk = o.conversationStatus === f.expect;
    // D guard: conditional price must NOT yield a fabricated numeric amount.
    const conditionalClean =
      f.id === "price-conditional" ? !containsDigits(o.replyContent) : true;
    const roleSuccess = statusOk && conditionalClean;
    fixtureResults.push({
      ...o,
      expect: f.expect,
      roleSuccess,
      conditionalClean,
    });
    console.log(
      `  ${f.id.padEnd(28)} role=${String(f.role).padEnd(22)} ` +
        `status=${String(o.conversationStatus).padEnd(10)} calls=${o.modelCallsThisTurn} ` +
        `a&c=${o.answerAndContinue} ok=${roleSuccess} lat=${o.modelLatencyMs ?? "?"}ms`,
    );
  }

  // ── DATASET CONVERSIONS (EVAL-14 residual price block) ────────────────────
  console.log("");
  console.log("── DATASET CONVERSIONS (EVAL-14 residual price cases) ──");
  const conversionResults: Observed[] = [];
  for (const id of DATASET_CONVERSION_IDS) {
    const o = await runConversion(byId.get(id)!);
    // Success = NOT a NO_KNOWLEDGE handoff anymore (price is now answerable):
    // either answered (AI_ACTIVE) or answer-and-continue activated.
    const converted =
      o.conversationStatus === "AI_ACTIVE" || o.answerAndContinue === true;
    conversionResults.push({ ...o, converted });
    console.log(
      `  ${id.padEnd(34)} status=${String(o.conversationStatus).padEnd(10)} ` +
        `a&c=${o.answerAndContinue} pending=${o.pendingGoalsCount} calls=${o.modelCallsThisTurn} converted=${converted}`,
    );
  }

  // ── Aggregate ─────────────────────────────────────────────────────────────
  const all = [...calibResults, ...fixtureResults, ...conversionResults];
  const realModelCalls = all.reduce(
    (s, o) => s + ((o.modelCallsThisTurn as number) ?? 0),
    0,
  );
  const multiCallTurns = all.filter(
    (o) => (o.modelCallsThisTurn as number) > 1,
  ).length;
  const providerFailures = all.filter((o) => o.providerFailure === true).length;
  const malformed = all.filter((o) => o.validatedNull === true).length;
  const engineReached = all.every((o) => o.engineOk === true);

  const focusedPass = fixtureResults.filter(
    (o) => o.roleSuccess === true,
  ).length;
  const conversionsPass = conversionResults.filter(
    (o) => o.converted === true,
  ).length;
  const safetyCase = fixtureResults.find((o) => o.role === "SAFETY_REQUIRED");
  const safetyPreserved = safetyCase?.conversationStatus === "NEED_HUMAN";
  const missingBooking = fixtureResults.find(
    (o) => o.role === "PRICE_MISSING_BOOKING",
  );
  const bookingContinued = missingBooking?.conversationStatus === "AI_ACTIVE";

  const behaviorPass =
    focusedPass === fixtureResults.length &&
    conversionsPass === conversionResults.length &&
    safetyPreserved &&
    bookingContinued &&
    multiCallTurns === 0 &&
    providerFailures === 0 &&
    malformed === 0 &&
    engineReached;

  const readiness = behaviorPass
    ? "READY_FOR_PRICE_REAL_LLM_REVERIFY"
    : providerFailures > 0
      ? "BLOCKED_PROVIDER"
      : "BLOCKED_BEHAVIOR";

  const analysis = {
    slice: "PROMPT-AI-ARCH-13",
    verificationOnly: true,
    target: "future-system-flowpilot",
    systemKind: "FUTURE_SYSTEM" as const,
    provider: identity.primaryProvider,
    model: identity.primaryModel,
    datasetVersion: args.version,
    datasetHash,
    evaluatorVersion: EVALUATOR_VERSION,
    productionMutation: "NONE (isolated in-memory repositories)",
    executedAt: new Date().toISOString(),
    readiness,
    calibration,
    counts: {
      fixtures: fixtureResults.length,
      focusedPass,
      conversions: conversionResults.length,
      conversionsPass,
      realModelCalls,
      measuredTurns: all.length,
      multiCallTurns,
      providerFailures,
      malformed,
      engineReached,
      safetyPreserved,
      bookingContinued,
    },
    fixtureResults,
    conversionResults,
  };
  writeFileSync(
    resolve(outDir, "analysis.json"),
    `${JSON.stringify(analysis, null, 2)}\n`,
    "utf8",
  );

  const report = [
    "# FUTURE_SYSTEM EVAL-15 — Service-price real-LLM verification",
    "",
    `## READINESS: ${readiness}`,
    "",
    `- provider/model: ${identity.primaryProvider}/${identity.primaryModel}`,
    `- dataset: ${args.version} (hash ${datasetHash}, byte-identical — NOT mutated)`,
    `- real model calls: ${realModelCalls} · multi-call turns: ${multiCallTurns} (one send/turn)`,
    `- provider failures: ${providerFailures} · malformed: ${malformed}`,
    "",
    "## Behavioral results",
    `- focused fixtures passed: ${focusedPass}/${fixtureResults.length}`,
    `- EVAL-14 price-case conversions: ${conversionsPass}/${conversionResults.length}`,
    `- safety/human precedence preserved: ${safetyPreserved}`,
    `- booking continues when price missing but not requested: ${bookingContinued}`,
    "",
    "See analysis.json / calibration.json for the per-case observed records.",
    "",
  ].join("\n");
  writeFileSync(resolve(outDir, "report.md"), `${report}\n`, "utf8");

  console.log("");
  console.log(`── RESULT: ${readiness} ──`);
  console.log(
    `  focused ${focusedPass}/${fixtureResults.length} · conversions ${conversionsPass}/${conversionResults.length} · ` +
      `calls=${realModelCalls} multiCall=${multiCallTurns} providerFail=${providerFailures} malformed=${malformed}`,
  );
  if (!behaviorPass && providerFailures === 0) process.exitCode = 1;
}

main().catch((error: Error) => {
  console.error(`فشل غير متوقع: ${error.message}`);
  process.exit(1);
});
