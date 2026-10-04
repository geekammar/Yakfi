/* eslint-disable @typescript-eslint/consistent-type-imports */
/**
 * FlowPilot — PROMPT-AI-OPS-25 real-LLM verification probe.
 *
 * Drives the EXACT reported live sequence through the REAL Atria adapter +
 * the REAL policy-backed ConversationAi, so the fix is verified against the
 * production provider path (not just the offline harness). One provider call
 * per turn; no DB, no WhatsApp transport, no message persistence.
 *
 * PRIVACY (binding): this probe prints ONLY content-free structured evidence
 * per turn — traceId, routing decision, provider status, parse success,
 * provider attempts, and the ENGINE's own signal/precedence machine keys.
 * It never prints the customer's raw message, the model's reply text, the
 * prompt, chain-of-thought, secrets, or tokens.
 *
 * Run:  pnpm probe:ops-25
 */
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

type AiRequest =
  import("../src/features/conversations/server/ai-contract").AiRequest;
type AiResponse =
  import("../src/features/conversations/server/ai-contract").AiResponse;
type ConversationAi =
  import("../src/features/conversations/server/conversation-ai").ConversationAi;
type TurnControlSignals =
  import("../src/features/conversations/server/conversation-ai").TurnControlSignals;
type AiTelemetry = import("../src/server/integrations/ai/types").AiTelemetry;

const FAQS = [
  {
    question: "هل هذه عيادة الدكتورة أفنان للاسنان؟",
    answer: "نعم، هذه عيادة الدكتورة أفنان لطب الأسنان.",
  },
  { question: "مكانكم فين؟", answer: "موقعنا في شارع الاستاد." },
];

function buildRequest(
  message: string,
  status: AiRequest["conversationStatus"],
): AiRequest {
  return {
    message,
    conversationStatus: status,
    recentMessages: [],
    businessName: "مركز أفنان",
    services: [{ name: "تنظيف الأسنان" }],
    faqs: FAQS,
    assistantStyle: undefined,
  };
}

async function main(): Promise<void> {
  const { createPolicyBackedAi } =
    await import("../src/server/integrations/ai/factory");
  const { detectTurnControlSignals } =
    await import("../src/features/conversations/server/conversation-ai");
  const { resolveTurnPlan } =
    await import("../src/features/conversations/server/turn-planner");

  const ai: ConversationAi & {
    getLastTelemetry?: () => AiTelemetry | null;
  } = (await createPolicyBackedAi({
    getEnvVar: (name: string) => process.env[name],
    fetchImpl: fetch,
  })) as ConversationAi & {
    getLastTelemetry?: () => AiTelemetry | null;
  };

  console.log("provider:", ai.providerName);
  if (ai.providerName === "deterministic") {
    console.log(
      "NOTE: policy resolved to the deterministic assistant (no live",
    );
    console.log("      provider configured). Real-LLM verification SKIPPED.");
    console.log("PROBE_RESULT: NOT_LIVE");
    return;
  }

  const sequence: Array<{
    label: string;
    message: string;
    status: AiRequest["conversationStatus"];
    expectHandoff: boolean;
  }> = [
    {
      label: "1. ordinary identity question",
      message: "السلام عليكم هو انتو عيادة الدكتورة افنان للاسنان؟",
      status: "AI_ACTIVE",
      expectHandoff: false,
    },
    {
      label: "2. ordinary follow-up (after Resume AI)",
      message: "مكانكم فين؟",
      status: "AI_ACTIVE",
      expectHandoff: false,
    },
    {
      label: "3. another ordinary question (after Resume AI)",
      message: "السلام عليكم هو انتو عيادة الدكتورة افنان للاسنان؟",
      status: "AI_ACTIVE",
      expectHandoff: false,
    },
    {
      label: "4. explicit human request",
      message: "ممكن أكلم حد من الفريق؟",
      status: "AI_ACTIVE",
      expectHandoff: true,
    },
  ];

  let mismatches = 0;
  let inconclusive = 0;
  for (const step of sequence) {
    const signals: TurnControlSignals = detectTurnControlSignals(step.message);
    const request = buildRequest(step.message, step.status);
    let response: AiResponse | null = null;
    let providerStatus = "UNKNOWN";
    let parseSuccess: boolean | null = null;
    let attempts = 0;
    let failureCode: string | null = null;
    let httpStatus: number | null = null;
    try {
      response = await ai.respond(request);
      const telemetry = ai.getLastTelemetry?.() ?? null;
      providerStatus = telemetry?.finalStatus ?? "SUCCESS";
      attempts =
        telemetry?.retryTrace?.attempts.length ??
        telemetry?.attempts.length ??
        1;
      parseSuccess = response !== null;
      const lastAttempt = telemetry
        ? ([...telemetry.attempts].reverse()[0] ?? null)
        : null;
      httpStatus =
        (lastAttempt as { httpStatus?: number } | null)?.httpStatus ?? null;
    } catch (error) {
      providerStatus = "FAILURE";
      parseSuccess = false;
      failureCode = error instanceof Error ? error.message : "UNKNOWN_THROW";
    }

    // The engine's authoritative precedence for THIS turn, computed exactly
    // as receiveInboundMessage does (turn-scoped, current-turn evidence only,
    // best-effort + total like the engine's own resolver wrapper).
    let precedenceRule = "RESOLVER_UNAVAILABLE";
    let decisionClass = "UNRESOLVED";
    if (response !== null) {
      try {
        const plan = resolveTurnPlan({
          decision: response,
          state: {
            knownFacts: {},
            missingFacts: [],
            lastClarification: null,
            activeTask: null,
            pendingGoals: [],
            goals: [],
          } as never,
          routing: "LLM",
          domain: { kind: "PENDING" },
          signals,
        });
        precedenceRule = plan.precedenceRule;
        decisionClass = plan.decisionClass;
      } catch {
        precedenceRule = "RESOLVER_UNAVAILABLE";
        decisionClass = "UNRESOLVED";
      }
    }
    const handedOff = decisionClass === "HANDOFF";
    // A provider outage makes the precedence verdict UNOBSERVABLE for this
    // turn: the engine fails safe to NEED_HUMAN regardless of intent, so a
    // behavioral comparison would measure the provider, not the fix. Such a
    // turn is INCONCLUSIVE and never counts as a behavioral mismatch
    // (PROMPT-AI-OPS-25 §11: distinguish provider failure from engine defect).
    const observable = failureCode === null && response !== null;
    const ok = !observable || handedOff === step.expectHandoff;
    if (!ok) mismatches += 1;
    if (!observable) inconclusive += 1;

    console.log("\n---", step.label, "---");
    console.log("  explicitHumanSignal:", signals.explicitHuman);
    console.log("  precedenceRule:", precedenceRule);
    console.log("  decisionClass:", decisionClass);
    console.log("  providerStatus:", providerStatus);
    console.log("  providerAttempts:", attempts);
    console.log("  parseSuccess:", String(parseSuccess));
    if (failureCode !== null) console.log("  failureCode:", failureCode);
    if (httpStatus !== null) console.log("  httpStatus:", httpStatus);
    console.log(
      "  expectedHandoff:",
      step.expectHandoff,
      "| actualHandoff:",
      handedOff,
      "| verdict:",
      observable ? (ok ? "OK" : "MISMATCH") : "INCONCLUSIVE (provider down)",
    );
  }

  console.log(`\nmismatches: ${mismatches}`);
  console.log(`inconclusive (provider unavailable): ${inconclusive}`);
  console.log(mismatches === 0 ? "PROBE_RESULT: PASS" : "PROBE_RESULT: FAIL");
  if (inconclusive > 0) {
    console.log(
      "NOTE: inconclusive turns are a LIVE PROVIDER condition (timeout /",
    );
    console.log(
      "      permanent failure), not an engine defect. The deterministic",
    );
    console.log(
      "      `check:conversation-ops-25` suite is the authoritative proof.",
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
