/**
 * FlowPilot — REQUEST-SCOPED PROVIDER TELEMETRY check.
 *
 * Runs the PRODUCTION policy-backed assistant wrapper
 * (`createPolicyBackedConversationAi`) against fake provider HTTP responses.
 * Two turns are interleaved so the first request is still in flight when the
 * second finishes; a third failure path follows.
 *
 * Proves: response, provider identity, model, tokens, cost and failure state
 * all belong to the SAME request. No module-level "last telemetry" state can
 * leak one turn's accounting into another.
 *
 * Run: pnpm check:request-scoped-usage
 */

import type { AiRequest } from "../src/features/conversations/server/ai-contract";
import { createPolicyBackedConversationAi } from "../src/features/conversations/server/conversation-engine";
import type { EffectiveAiPolicy } from "../src/lib/validation/platform";
import type { AiTelemetry } from "../src/server/integrations/ai/types";

export {};

type Check = { label: string; pass: boolean };
const checks: Check[] = [];
function check(label: string, pass: boolean): void {
  checks.push({ label, pass });
}

function request(message: string): AiRequest {
  return {
    message,
    conversationStatus: "AI_ACTIVE",
    recentMessages: [],
    businessName: "منشأة الاختبار",
    services: [],
    faqs: [],
  };
}

function providerContent(label: string): string {
  return JSON.stringify({
    intent: "FAQ",
    action: "reply",
    content: label,
    extraction: {
      service: null,
      provider: null,
      date: null,
      timePreference: null,
    },
    handoffReason: null,
    summary: null,
    safetyAssessment: "safe",
  });
}

function providerResponse(
  label: string,
  inputTokens: number,
  outputTokens: number,
  cost: number,
): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: providerContent(label) } }],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        cost,
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function policy(
  primaryProvider: EffectiveAiPolicy["primaryProvider"],
  primaryModel: string,
): EffectiveAiPolicy {
  return { primaryProvider, primaryModel, secondary: null };
}

async function main(): Promise<void> {
  let policyCall = 0;
  const policies: EffectiveAiPolicy[] = [
    policy("openrouter", "model-a"),
    policy("agentrouter", "model-b"),
    policy("openrouter", "model-c"),
  ];

  let releaseFirst = (): void => {};
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let markFirstStarted = (): void => {};
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });

  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    if (body.includes("REQUEST_A")) {
      markFirstStarted();
      await firstGate;
      return providerResponse("A", 101, 7, 0.0011);
    }
    if (body.includes("REQUEST_B")) {
      releaseFirst();
      return providerResponse("B", 202, 9, 0.0022);
    }
    if (body.includes("REQUEST_THROW")) {
      throw new Error("simulated network failure");
    }
    return providerResponse("UNEXPECTED", 0, 0, 0);
  }) as typeof fetch;

  const ai = createPolicyBackedConversationAi({
    fetchImpl,
    getEnvVar: (name) =>
      name === "FLOWPILOT_JEV_SEMANTIC_ENABLED"
        ? "false"
        : name === "OPENROUTER_API_KEY" || name === "AGENTROUTER_API_KEY"
          ? "test-key"
          : undefined,
    getAiPolicyImpl: (async () => ({
      success: true,
      data: {
        policy: null,
        effective: policies[
          Math.min(policyCall++, policies.length - 1)
        ]!,
      },
    })) as never,
  });

  const firstPromise = ai.respondTurn!(request("REQUEST_A"));
  await firstStarted;
  const secondPromise = ai.respondTurn!(request("REQUEST_B"));
  const [first, second] = await Promise.all([firstPromise, secondPromise]);

  const firstTelemetry = first.telemetry as AiTelemetry | null;
  const secondTelemetry = second.telemetry as AiTelemetry | null;

  check("first response belongs to request A", first.response?.content === "A");
  check(
    "second response belongs to request B",
    second.response?.content === "B",
  );
  check("first provider identity", first.providerName === "openrouter");
  check("second provider identity", second.providerName === "agentrouter");
  check(
    "first model/tokens/cost",
    firstTelemetry?.finalModel === "model-a" &&
      firstTelemetry.attempts[0]?.inputTokens === 101 &&
      firstTelemetry.attempts[0]?.outputTokens === 7 &&
      firstTelemetry.attempts[0]?.costUsd === 0.0011,
  );
  check(
    "second model/tokens/cost",
    secondTelemetry?.finalModel === "model-b" &&
      secondTelemetry.attempts[0]?.inputTokens === 202 &&
      secondTelemetry.attempts[0]?.outputTokens === 9 &&
      secondTelemetry.attempts[0]?.costUsd === 0.0022,
  );
  check(
    "no cross-request telemetry",
    firstTelemetry !== secondTelemetry &&
      firstTelemetry?.totalCostUsd !== secondTelemetry?.totalCostUsd,
  );

  const failure = await ai.respondTurn!(request("REQUEST_THROW"));
  const failureTelemetry = failure.telemetry as AiTelemetry | null;
  check("failure response is absent", failure.response === null);
  check(
    "failure keeps its own provider identity",
    failure.providerName === "openrouter",
  );
  check(
    "failure state is FAILURE",
    failureTelemetry?.finalStatus === "FAILURE",
  );
  check(
    "failure does not inherit previous tokens/cost/model",
    failureTelemetry?.finalModel === "model-c" &&
      failureTelemetry.attempts[0]?.inputTokens === undefined &&
      failureTelemetry.attempts[0]?.outputTokens === undefined &&
      failureTelemetry.attempts[0]?.costUsd === undefined,
  );
  check(
    "failure total is not a prior success total",
    failureTelemetry?.totalCostUsd !== 0.0011 &&
      failureTelemetry?.totalCostUsd !== 0.0022,
  );

  const failed = checks.filter((entry) => !entry.pass);
  for (const entry of checks) {
    console.log(`${entry.pass ? "✓" : "✗"} ${entry.label}`);
  }
  console.log(
    `\n${checks.length - failed.length}/${checks.length} request-scoped usage checks passed.`,
  );
  if (failed.length > 0) process.exitCode = 1;
}

main();
