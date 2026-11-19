import "./setup-test-env";

/**
 * FlowPilot — REQUEST-SCOPED POLICY-FAILURE EVIDENCE.
 *
 * Exercises the REAL stateless production wrapper
 * (`createPolicyBackedConversationAi`) with controlled/deferred policy and
 * provider promises. It proves that concurrent invocations cannot exchange:
 *
 * - response content;
 * - provider identity;
 * - model;
 * - tokens;
 * - attempts / telemetry;
 * - policy-unavailable status / failure cause.
 *
 * Orders covered:
 *   A. policy failure overlapping a successful model request (both orders);
 *   B. policy failure overlapping a real provider failure (both orders);
 *   C. two successful requests with different provider/model/token evidence.
 *
 * Run: pnpm check:policy-failure-scope
 */

import type { AiRequest } from "../src/features/conversations/server/ai-contract";
import type { ConversationAiExecution } from "../src/features/conversations/server/conversation-ai";
import { createPolicyBackedConversationAi } from "../src/features/conversations/server/conversation-engine";
import type { EffectiveAiPolicy } from "../src/lib/validation/platform";
import { POLICY_UNAVAILABLE_AI_PROVIDER } from "../src/server/integrations/ai/factory";

type Check = { label: string; pass: boolean };

const checks: Check[] = [];

function check(label: string, pass: boolean): void {
  checks.push({ label, pass });
  console.log(`${pass ? "✔" : "✘"} ${label}`);
}

function offlineEnv(name: string): string | undefined {
  if (name === "FLOWPILOT_JEV_SEMANTIC_ENABLED") return "0";
  if (
    name === "OPENROUTER_API_KEY" ||
    name === "AGENTROUTER_API_KEY" ||
    name === "ATRIA_API_KEY" ||
    name === "CODECRAFT_API_KEY"
  ) {
    return "test-key";
  }
  return process.env[name];
}

type Deferred<T> = {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type PolicyResult =
  | { success: true; data: { effective: EffectiveAiPolicy } }
  | { success: false; error: { code: string; message: string } };

function policySuccess(effective: EffectiveAiPolicy): PolicyResult {
  return { success: true, data: { effective } };
}

function policyFailure(code = "PERSISTENCE_FAILED"): PolicyResult {
  return {
    success: false,
    error: { code, message: "policy unavailable" },
  };
}

type PolicyGate = {
  readonly getAiPolicyImpl: () => Promise<PolicyResult>;
  readonly gates: [Deferred<PolicyResult>, Deferred<PolicyResult>];
};

function policyGate(): PolicyGate {
  const gates: [Deferred<PolicyResult>, Deferred<PolicyResult>] = [
    deferred<PolicyResult>(),
    deferred<PolicyResult>(),
  ];
  let calls = 0;
  return {
    gates,
    getAiPolicyImpl: () => {
      const gate = gates[Math.min(calls, gates.length - 1)] ?? gates[0];
      calls += 1;
      return gate.promise;
    },
  };
}

function requestFor(message: string): AiRequest {
  return {
    message,
    conversationStatus: "AI_ACTIVE",
    recentMessages: [],
    businessName: "عيادة النور لطب الأسنان",
    services: [],
    faqs: [],
  };
}

function aiReply(content: string): string {
  return JSON.stringify({
    intent: "GREETING",
    action: "reply",
    content,
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

function openAiEnvelope(
  content: string,
  promptTokens: number,
  completionTokens: number,
): Record<string, unknown> {
  return {
    choices: [{ message: { content } }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
    },
  };
}

type FetchOutcome = { status: number; body: unknown } | { error: unknown };

type ManualFetch = {
  readonly fetchImpl: typeof fetch;
  readonly started: Promise<void>;
  resolveResponse(status: number, body: unknown): void;
  reject(error: unknown): void;
  readonly calls: () => number;
};

function manualFetch(): ManualFetch {
  let calls = 0;
  const started = deferred<void>();
  const outcome = deferred<FetchOutcome>();
  const fetchImpl = (async () => {
    calls += 1;
    if (calls === 1) started.resolve(undefined);
    const result = await outcome.promise;
    if ("error" in result) throw result.error;
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;

  return {
    fetchImpl,
    started: started.promise,
    resolveResponse: (status, body) => outcome.resolve({ status, body }),
    reject: (error) => outcome.reject(error),
    calls: () => calls,
  };
}

function providerFetch(): {
  readonly fetchImpl: typeof fetch;
  readonly openrouter: ManualFetch;
  readonly agentrouter: ManualFetch;
} {
  const openrouter = manualFetch();
  const agentrouter = manualFetch();
  const fetchImpl = (async (url: string | URL | Request) => {
    const target = String(url);
    return target.includes("agentrouter")
      ? agentrouter.fetchImpl(url as never)
      : openrouter.fetchImpl(url as never);
  }) as unknown as typeof fetch;
  return { fetchImpl, openrouter, agentrouter };
}

function makeWrapper(
  fetchImpl: typeof fetch,
  getAiPolicyImpl: () => Promise<PolicyResult>,
) {
  return createPolicyBackedConversationAi({
    getEnvVar: offlineEnv,
    fetchImpl,
    getAiPolicyImpl: getAiPolicyImpl as never,
  });
}

async function execute(
  wrapper: ReturnType<typeof makeWrapper>,
  request: AiRequest,
): Promise<ConversationAiExecution> {
  const run = wrapper.respondWithExecution;
  if (!run) throw new Error("wrapper must expose respondWithExecution");
  return run.call(wrapper, request);
}

const OPENROUTER_POLICY: EffectiveAiPolicy = {
  primaryProvider: "openrouter",
  primaryModel: "openrouter/auto",
  secondary: null,
  openRouterProviderOnly: null,
};

const AGENTROUTER_POLICY: EffectiveAiPolicy = {
  primaryProvider: "agentrouter",
  primaryModel: "custom-model",
  secondary: null,
  openRouterProviderOnly: null,
};

function isPolicyFailure(execution: ConversationAiExecution): boolean {
  return (
    execution.response === null &&
    execution.policyUnavailable === true &&
    execution.telemetry === null &&
    execution.providerName === POLICY_UNAVAILABLE_AI_PROVIDER
  );
}

async function policyFailureBeforeSuccess(): Promise<void> {
  const policies = policyGate();
  const fetch = manualFetch();
  const wrapper = makeWrapper(fetch.fetchImpl, policies.getAiPolicyImpl);

  const failure = execute(wrapper, requestFor("policy failure request"));
  const success = execute(wrapper, requestFor("successful request"));

  policies.gates[1]!.resolve(policySuccess(OPENROUTER_POLICY));
  await fetch.started;

  policies.gates[0]!.resolve(policyFailure());
  const failedExecution = await failure;

  check(
    "A1 policy failure completes first → no-call result has no borrowed model evidence",
    isPolicyFailure(failedExecution) && fetch.calls() === 1,
  );

  fetch.resolveResponse(
    200,
    openAiEnvelope(aiReply("openrouter answer"), 11, 3),
  );
  const successExecution = await success;

  check(
    "A1 model request keeps its own response/provider/model/tokens",
    successExecution.response?.content === "openrouter answer" &&
      successExecution.providerName === "openrouter" &&
      successExecution.policyUnavailable === false &&
      successExecution.telemetry?.finalProvider === "openrouter" &&
      successExecution.telemetry?.finalModel === "openrouter/auto" &&
      successExecution.telemetry?.attempts.length === 1 &&
      successExecution.telemetry?.attempts[0]?.inputTokens === 11 &&
      successExecution.telemetry?.attempts[0]?.outputTokens === 3,
  );
}

async function successBeforePolicyFailure(): Promise<void> {
  const policies = policyGate();
  const fetch = manualFetch();
  const wrapper = makeWrapper(fetch.fetchImpl, policies.getAiPolicyImpl);

  const failure = execute(wrapper, requestFor("policy failure request"));
  const success = execute(wrapper, requestFor("successful request"));

  policies.gates[1]!.resolve(policySuccess(OPENROUTER_POLICY));
  await fetch.started;
  fetch.resolveResponse(
    200,
    openAiEnvelope(aiReply("openrouter answer"), 12, 4),
  );

  const successExecution = await success;
  check(
    "A2 model success completes first → response/provider/tokens are correct",
    successExecution.response?.content === "openrouter answer" &&
      successExecution.providerName === "openrouter" &&
      successExecution.telemetry?.attempts[0]?.inputTokens === 12 &&
      successExecution.telemetry?.attempts[0]?.outputTokens === 4,
  );

  policies.gates[0]!.resolve(policyFailure("INVALID_POLICY"));
  const failedExecution = await failure;

  check(
    "A2 later policy failure remains a pure no-call result",
    isPolicyFailure(failedExecution),
  );
}

async function policyFailureBeforeProviderFailure(): Promise<void> {
  const policies = policyGate();
  const fetch = manualFetch();
  const wrapper = makeWrapper(fetch.fetchImpl, policies.getAiPolicyImpl);

  const failure = execute(wrapper, requestFor("policy failure request"));
  const providerFailure = execute(
    wrapper,
    requestFor("provider failure request"),
  );

  policies.gates[1]!.resolve(policySuccess(OPENROUTER_POLICY));
  await fetch.started;

  policies.gates[0]!.resolve(policyFailure());
  const failedExecution = await failure;
  check(
    "B1 policy failure completes first → zero-call result stays isolated",
    isPolicyFailure(failedExecution),
  );

  fetch.resolveResponse(401, { error: "unauthorized" });
  const providerExecution = await providerFailure;
  check(
    "B1 real provider failure keeps its own provider/attempt evidence",
    providerExecution.response === null &&
      providerExecution.policyUnavailable === false &&
      providerExecution.providerName === "openrouter" &&
      providerExecution.telemetry?.finalProvider === "openrouter" &&
      providerExecution.telemetry?.finalStatus === "FAILURE" &&
      (providerExecution.telemetry?.attempts.length ?? 0) >= 1 &&
      providerExecution.error !== null,
  );
}

async function providerFailureBeforePolicyFailure(): Promise<void> {
  const policies = policyGate();
  const fetch = manualFetch();
  const wrapper = makeWrapper(fetch.fetchImpl, policies.getAiPolicyImpl);

  const failure = execute(wrapper, requestFor("policy failure request"));
  const providerFailure = execute(
    wrapper,
    requestFor("provider failure request"),
  );

  policies.gates[1]!.resolve(policySuccess(OPENROUTER_POLICY));
  await fetch.started;
  fetch.resolveResponse(401, { error: "unauthorized" });

  const providerExecution = await providerFailure;
  check(
    "B2 provider failure completes first → real failure evidence is preserved",
    providerExecution.response === null &&
      providerExecution.policyUnavailable === false &&
      providerExecution.providerName === "openrouter" &&
      providerExecution.telemetry?.finalStatus === "FAILURE" &&
      (providerExecution.telemetry?.attempts.length ?? 0) >= 1,
  );

  policies.gates[0]!.resolve(policyFailure("INVALID_POLICY"));
  const failedExecution = await failure;
  check(
    "B2 later policy failure never inherits the provider failure cause",
    isPolicyFailure(failedExecution),
  );
}

async function twoSuccessesDifferentEvidence(
  resolveOpenRouterFirst: boolean,
): Promise<void> {
  const policies = policyGate();
  const fetch = providerFetch();
  const wrapper = makeWrapper(fetch.fetchImpl, policies.getAiPolicyImpl);

  const openrouterRequest = execute(wrapper, requestFor("openrouter request"));
  const agentrouterRequest = execute(
    wrapper,
    requestFor("agentrouter request"),
  );

  policies.gates[0]!.resolve(policySuccess(OPENROUTER_POLICY));
  policies.gates[1]!.resolve(policySuccess(AGENTROUTER_POLICY));

  await Promise.all([fetch.openrouter.started, fetch.agentrouter.started]);

  const resolveOpenRouter = () =>
    fetch.openrouter.resolveResponse(
      200,
      openAiEnvelope(aiReply("openrouter answer"), 21, 5),
    );
  const resolveAgentRouter = () =>
    fetch.agentrouter.resolveResponse(
      200,
      openAiEnvelope(aiReply("agentrouter answer"), 33, 8),
    );

  if (resolveOpenRouterFirst) {
    resolveOpenRouter();
    resolveAgentRouter();
  } else {
    resolveAgentRouter();
    resolveOpenRouter();
  }

  const [openrouterExecution, agentrouterExecution] = await Promise.all([
    openrouterRequest,
    agentrouterRequest,
  ]);

  check(
    `C ${resolveOpenRouterFirst ? "openrouter" : "agentrouter"} completion order → provider identity/model/tokens never cross requests`,
    openrouterExecution.response?.content === "openrouter answer" &&
      openrouterExecution.providerName === "openrouter" &&
      openrouterExecution.telemetry?.finalProvider === "openrouter" &&
      openrouterExecution.telemetry?.finalModel === "openrouter/auto" &&
      openrouterExecution.telemetry?.attempts.length === 1 &&
      openrouterExecution.telemetry?.attempts[0]?.inputTokens === 21 &&
      openrouterExecution.telemetry?.attempts[0]?.outputTokens === 5 &&
      agentrouterExecution.response?.content === "agentrouter answer" &&
      agentrouterExecution.providerName === "agentrouter" &&
      agentrouterExecution.telemetry?.finalProvider === "agentrouter" &&
      agentrouterExecution.telemetry?.finalModel === "custom-model" &&
      agentrouterExecution.telemetry?.attempts.length === 1 &&
      agentrouterExecution.telemetry?.attempts[0]?.inputTokens === 33 &&
      agentrouterExecution.telemetry?.attempts[0]?.outputTokens === 8,
  );
}

async function main(): Promise<void> {
  console.log("=== Request-scoped policy-failure evidence ===\n");

  await policyFailureBeforeSuccess();
  await successBeforePolicyFailure();
  await policyFailureBeforeProviderFailure();
  await providerFailureBeforePolicyFailure();
  await twoSuccessesDifferentEvidence(true);
  await twoSuccessesDifferentEvidence(false);

  const failures = checks.filter((entry) => !entry.pass);
  console.log(
    `\n${checks.length - failures.length}/${checks.length} checks passed.`,
  );
  if (failures.length > 0) {
    console.error("FAILED:");
    for (const failure of failures) console.error(`- ${failure.label}`);
    process.exit(1);
  }
  console.log("RESULT: PASS");
}

main().catch((error) => {
  console.error("UNEXPECTED FAILURE:", error);
  process.exit(1);
});
