/**
 * FlowPilot AI Evaluation — FUTURE_SYSTEM real-LLM RESUME + INTERRUPTION fixture
 * calibration CLI (PROMPT-AI-EVAL-09).
 *
 * Measurement ONLY. This is the BOUNDED real-LLM calibration that proves the
 * evaluation-path capability added by PROMPT-AI-EVAL-09 is actually connected:
 *
 *   real Atria → FUTURE_SYSTEM → real Conversation Engine → ENGINE-AUTHORED
 *   seeded pending state → resolver → CLARIFY/resume/interruption → observable
 *   ActualOutcome.
 *
 * It drives the REAL configured provider/model THROUGH the real Conversation
 * Engine (`receiveInboundMessage`). It changes NO production behavior and
 * mutates NO production data (isolated in-memory repositories). It does NOT run
 * the full egyptian-v1 baseline or the 14-case EVAL-08 suite — only three tiny
 * fixtures:
 *
 *   1. a normal/answer calibration (greeting → deterministic bypass answer)
 *   2. a real supplied-fact-resume case (seed CLARIFY_DATE → supply the date)
 *   3. a real interruption/recovery case (seed a resumable offer → interrupt →
 *      return)
 *
 * The pending state for (2)/(3) is ENGINE-AUTHORED by the deterministic seed
 * (zero real inference); only the measured turns use the real LLM.
 *
 *   pnpm eval:run-future-fixtures -- --provider atria --model <id> --out <dir>
 *
 * STOPS + reports a BLOCKER if the configured provider is unavailable — it
 * never silently falls back to a mock or the deterministic classifier.
 */

import { mkdirSync, writeFileSync } from "node:fs";
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

import { createFutureSystemRunner } from "../evaluation/runner/future-system-adapter";
import {
  interruptionSeed,
  resumeDateSeed,
} from "../evaluation/runner/pending-state-seed";
import { FutureSystemFlowpilotTarget } from "../evaluation/runner/targets/future-system-flowpilot";
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

const SERVICE = "تنظيف أسنان";
const TEST_DATE = "2026-09-14";

const BUSINESS = {
  businessName: "عيادة التقييم",
  services: [{ name: SERVICE, durationMinutes: 30 }],
  faqs: [{ question: "مواعيد العمل", answer: "من 9 صباحاً حتى 6 مساءً" }],
};

type Args = {
  out: string;
  providerOverride: AiProviderId | null;
  modelOverride: string | null;
  timeoutMs: number | null;
};

function parseArgs(argv: string[]): Args {
  let out = "";
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
      default:
        break;
    }
  }
  return { out, providerOverride, modelOverride, timeoutMs };
}

function blocked(outDir: string, reason: string): never {
  mkdirSync(outDir, { recursive: true });
  const body = [
    "# FUTURE_SYSTEM resume/interruption fixtures — RUN STATUS",
    "",
    "## READINESS: BLOCKED",
    "",
    `The real-LLM fixture calibration could not proceed: ${reason}`,
    "",
    "The seeding capability itself is proven offline by",
    "`pnpm check:future-system` (F23–F33). This blocker is about REAL-LLM",
    "execution only: the bridge MUST use the real configured provider/model and",
    "never a mock or the deterministic classifier.",
    "",
    "Resolve the provider (DB-backed platform AI policy or `--provider/--model`",
    "override with valid credentials), then re-run.",
    "",
  ].join("\n");
  writeFileSync(resolve(outDir, "status.md"), `${body}\n`, "utf8");
  console.error(`\nBLOCKED — ${reason}`);
  process.exit(2);
}

type Observed = Record<string, unknown>;

async function main(): Promise<void> {
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const args = parseArgs(process.argv.slice(2));
  const outDir = resolve(
    process.cwd(),
    args.out ||
      "evaluation/reports/egyptian-v1/future-system-resume-interruption",
  );
  mkdirSync(outDir, { recursive: true });

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
        "no effective AI policy could be resolved (DB unreachable or INVALID_POLICY).",
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
  const systemIdentity = {
    kind: "FUTURE_SYSTEM" as const,
    modelProvider: `${identity.primaryProvider}/${identity.primaryModel}`,
    note: "FUTURE_SYSTEM resume/interruption fixtures (eval-only, PROMPT-AI-EVAL-09)",
  };
  const target = new FutureSystemFlowpilotTarget(runner, systemIdentity);

  console.log("── PRE-EXECUTION REPORT (PROMPT-AI-EVAL-09, FUTURE_SYSTEM) ──");
  console.log(`  provider/model : ${systemIdentity.modelProvider}`);
  console.log(`  real inference : YES (live provider HTTP calls)`);
  console.log(`  mutation       : NONE (isolated in-memory repositories)`);
  console.log(
    `  fixtures       : normal-answer, supplied-fact-resume, interruption-recovery`,
  );
  console.log("");

  const results: Record<string, unknown> = {};
  let totalModelCalls = 0;

  // ── FIXTURE 1: normal/answer calibration (greeting → bypass answer) ───────
  runner.reset();
  const normal = (await target.runTurn({
    caseId: "fx-normal",
    turnIndex: 0,
    message: "السلام عليكم",
    history: [],
    businessContext: BUSINESS,
  })) as Observed;
  totalModelCalls += (normal.modelCallsThisTurn as number) ?? 0;
  results.normalAnswer = {
    caseId: "fx-normal",
    engineOk: normal.engineOk,
    decisionClass: normal.decisionClass,
    conversationStatus: normal.conversationStatus,
    routingDecision: normal.routingDecision,
    modelCallsThisTurn: normal.modelCallsThisTurn,
    expectedTransitionObserved:
      normal.engineOk === true && normal.conversationStatus === "AI_ACTIVE",
  };

  // ── FIXTURE 2: real supplied-fact-resume ──────────────────────────────────
  runner.reset();
  const resumeAudit = await runner.seedPendingState({
    caseId: "fx-resume",
    businessContext: BUSINESS,
    spec: resumeDateSeed(SERVICE),
  });
  const resumeTurn = (await target.runTurn({
    caseId: "fx-resume",
    turnIndex: 2,
    message: TEST_DATE,
    history: [],
    businessContext: BUSINESS,
  })) as Observed;
  totalModelCalls += (resumeTurn.modelCallsThisTurn as number) ?? 0;
  const resumeClar = (resumeTurn.clarification as { type?: string } | undefined)
    ?.type;
  results.suppliedFactResume = {
    caseId: "fx-resume",
    seed: {
      specId: resumeAudit.specId,
      seedValid: resumeAudit.seedValid,
      reconstructedClarification: resumeAudit.reconstructedClarification,
      seedRealModelCalls: resumeAudit.seedRealModelCalls,
    },
    observed: {
      decisionClass: resumeTurn.decisionClass,
      conversationStatus: resumeTurn.conversationStatus,
      clarificationType: resumeClar ?? null,
      modelCallsThisTurn: resumeTurn.modelCallsThisTurn,
    },
    // The resume succeeded if the date was NOT re-asked and the thread stayed
    // AI_ACTIVE (the engine bound the supplied fact through the merge path).
    expectedTransitionObserved:
      resumeAudit.seedValid === true &&
      resumeClar !== "CLARIFY_DATE" &&
      resumeTurn.conversationStatus === "AI_ACTIVE",
  };

  // ── FIXTURE 3: real interruption/recovery ─────────────────────────────────
  runner.reset();
  const interruptAudit = await runner.seedPendingState({
    caseId: "fx-interrupt",
    businessContext: BUSINESS,
    spec: interruptionSeed(SERVICE, TEST_DATE),
  });
  const interruption = (await target.runTurn({
    caseId: "fx-interrupt",
    turnIndex: 2,
    message: "إيه مواعيد العمل؟",
    history: [],
    businessContext: BUSINESS,
  })) as Observed;
  totalModelCalls += (interruption.modelCallsThisTurn as number) ?? 0;
  const ret = (await target.runTurn({
    caseId: "fx-interrupt",
    turnIndex: 4,
    message: "تمام نكمل الحجز",
    history: [],
    businessContext: BUSINESS,
  })) as Observed;
  totalModelCalls += (ret.modelCallsThisTurn as number) ?? 0;
  results.interruptionRecovery = {
    caseId: "fx-interrupt",
    seed: {
      specId: interruptAudit.specId,
      seedValid: interruptAudit.seedValid,
      reconstructedActiveTask: interruptAudit.reconstructedActiveTask,
      seedRealModelCalls: interruptAudit.seedRealModelCalls,
    },
    interruptionTurn: {
      decisionClass: interruption.decisionClass,
      conversationStatus: interruption.conversationStatus,
      modelCallsThisTurn: interruption.modelCallsThisTurn,
      pendingTaskPreserved: interruption.conversationStatus !== "NEED_HUMAN",
    },
    returnTurn: {
      decisionClass: ret.decisionClass,
      conversationStatus: ret.conversationStatus,
      modelCallsThisTurn: ret.modelCallsThisTurn,
      resumed: ret.conversationStatus !== "NEED_HUMAN",
    },
    expectedTransitionObserved:
      interruptAudit.seedValid === true &&
      interruption.conversationStatus !== "NEED_HUMAN" &&
      ret.conversationStatus !== "NEED_HUMAN",
  };

  const anyProviderFailure = [normal, resumeTurn, interruption, ret].some(
    (o) => o.providerFailure === true,
  );
  const multiCallTurn = [normal, resumeTurn, interruption, ret].some(
    (o) => ((o.modelCallsThisTurn as number) ?? 0) > 1,
  );

  const analysis = {
    slice: "PROMPT-AI-EVAL-09",
    provider: identity.primaryProvider,
    model: identity.primaryModel,
    productionMutation: "NONE (isolated in-memory repositories)",
    totalRealModelCalls: totalModelCalls,
    multiCallTurn,
    anyProviderFailure,
    fixtures: results,
  };
  writeFileSync(
    resolve(outDir, "analysis.json"),
    `${JSON.stringify(analysis, null, 2)}\n`,
    "utf8",
  );

  const capabilityConnected =
    !anyProviderFailure &&
    !multiCallTurn &&
    (results.normalAnswer as Observed).expectedTransitionObserved === true;

  const status = [
    "# FUTURE_SYSTEM resume/interruption fixtures — RUN STATUS",
    "",
    `## CAPABILITY CONNECTED: ${capabilityConnected ? "YES" : "NO"}`,
    "",
    `- provider/model: ${identity.primaryProvider}/${identity.primaryModel}`,
    `- total real model calls: ${totalModelCalls}`,
    `- any provider failure: ${anyProviderFailure}`,
    `- any multi-call turn (must be false): ${multiCallTurn}`,
    "",
    "## Fixture results",
    `- normal-answer: transition observed = ${(results.normalAnswer as Observed).expectedTransitionObserved}`,
    `- supplied-fact-resume: transition observed = ${(results.suppliedFactResume as Observed).expectedTransitionObserved}`,
    `- interruption-recovery: transition observed = ${(results.interruptionRecovery as Observed).expectedTransitionObserved}`,
    "",
    "See analysis.json for the per-fixture seed audit + observed decisions.",
    "",
  ].join("\n");
  writeFileSync(resolve(outDir, "status.md"), `${status}\n`, "utf8");

  console.log(`eval:run-future-fixtures → ${systemIdentity.modelProvider}`);
  console.log(`  total real model calls : ${totalModelCalls}`);
  console.log(`  provider failures      : ${anyProviderFailure}`);
  console.log(`  multi-call turn        : ${multiCallTurn} (must be false)`);
  console.log(
    `  normal-answer          : ${(results.normalAnswer as Observed).expectedTransitionObserved}`,
  );
  console.log(
    `  supplied-fact-resume   : ${(results.suppliedFactResume as Observed).expectedTransitionObserved}`,
  );
  console.log(
    `  interruption-recovery  : ${(results.interruptionRecovery as Observed).expectedTransitionObserved}`,
  );
  console.log(`  artifacts              : ${resolve(outDir, "analysis.json")}`);
  console.log(`                           ${resolve(outDir, "status.md")}`);
  console.log("");
  console.log(`CAPABILITY CONNECTED: ${capabilityConnected ? "YES" : "NO"}`);
  if (!capabilityConnected) process.exit(2);
}

void main();
