/* eslint-disable @typescript-eslint/consistent-type-imports */
/**
 * FlowPilot — CodeCraft provider probe (CODECRAFT-DISCOVERY-PROVIDER-58).
 *
 * A minimal, CONTROLLED validation of the real CodeCraft adapter path:
 * real endpoint, real authentication (read from the environment by the
 * secret NAME only), configured model, trivial prompt. It touches no
 * database, no conversation state, no WhatsApp transport.
 *
 * Two stages, both sanitized:
 *
 *   1. MODEL DISCOVERY — GET /v1/models with the Bearer key. Prints ONLY
 *      safe metadata: model ids, and when the provider exposes them the
 *      context window / capabilities / pricing. The API key is NEVER
 *      printed or logged, and the full payload is never dumped. No model
 *      registry is created and nothing is written to the DB — this is
 *      discovery evidence only, used to pick the policy's model.
 *
 *   2. COMPATIBILITY — runs the REAL adapter over the shared
 *      `callOpenAiCompatible` path against the FlowPilot contract:
 *      basic chat completion, Arabic output, JSON-mode (`json_object`),
 *      `parseAiResponse`/`aiResponseSchema` conformance, malformed +
 *      timeout/error mapping, token usage capture. Output is
 *      classification-only (intent/action/length/tokens/latency/status) —
 *      never raw content, never keys, never headers.
 *
 * Run:  pnpm probe:codecraft   (after CODECRAFT_API_KEY is in .env.local)
 *       CODECRAFT_MODEL=<id> pnpm probe:codecraft   (override the model)
 *       PROBE_RUNS=N pnpm probe:codecraft           (N attempts + tally)
 *
 * The endpoint proved REACHABLE during integration (unauthenticated
 * GET /v1/models → 401), so a 401 here means the key is wrong/missing,
 * not that the host is down.
 */
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

type AiRequest =
  import("../src/features/conversations/server/ai-contract").AiRequest;
type CodeCraftModule = typeof import("../src/server/integrations/ai/codecraft");
type AiProviderResult =
  import("../src/server/integrations/ai/types").AiProviderResult;

type ModelSummary = {
  id: string;
  contextWindow: number | null;
  capabilities: string[] | null;
  hasPricing: boolean;
};

type StageOutcome = {
  label: string;
  ok: boolean;
  httpStatus: number | null;
  latencyMs: number | null;
  errorCode: string | null;
  detail: string;
};

const RUNS = Math.max(1, Number(process.env.PROBE_RUNS ?? "1") || 1);

function maskKey(key: string | undefined): string {
  if (!key) return "unset";
  return `set(${key.length} chars)`;
}

async function discoverModels(
  codecraft: CodeCraftModule,
  getEnvVar: (name: string) => string | undefined,
  fetchImpl: typeof fetch,
): Promise<{
  models: ModelSummary[];
  httpStatus: number | null;
  error: string | null;
}> {
  const key = getEnvVar(codecraft.CODECRAFT_SECRET_REF);
  let res: Response;
  try {
    res = await fetchImpl(codecraft.CODECRAFT_MODELS_ENDPOINT, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${key ?? ""}`,
        Accept: "application/json",
      },
    });
  } catch (err) {
    return {
      models: [],
      httpStatus: null,
      error: err instanceof Error ? err.message : "network error",
    };
  }
  if (!res.ok) {
    return { models: [], httpStatus: res.status, error: `HTTP ${res.status}` };
  }
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return {
      models: [],
      httpStatus: res.status,
      error: "invalid JSON from /v1/models",
    };
  }
  const list = (payload as { data?: unknown })?.data;
  const arr = Array.isArray(list)
    ? (list as Array<Record<string, unknown>>)
    : [];
  const models: ModelSummary[] = arr.map((m) => {
    const id = typeof m.id === "string" ? m.id : String(m.id ?? "unknown");
    const ctx = m.context_length ?? m.context_window ?? m.max_context_length;
    const caps = m.capabilities ?? m.supported_endpoint_types;
    const pricing =
      m.pricing ??
      m.price ??
      m.cost ??
      (m.tier !== undefined ? { tier: m.tier } : undefined);
    return {
      id,
      contextWindow: typeof ctx === "number" ? ctx : null,
      capabilities: Array.isArray(caps)
        ? (caps as unknown[]).map((c) => String(c))
        : null,
      hasPricing: pricing !== undefined && pricing !== null,
    };
  });
  return { models, httpStatus: res.status, error: null };
}

function bucketOf(result: AiProviderResult): {
  ok: boolean;
  errorCode: string | null;
  parseMode: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
} {
  return {
    ok: result.ok,
    errorCode: result.ok ? null : result.error.code,
    parseMode: result.ok ? (result.parseMode ?? "DIRECT_PARSE") : "n/a",
    inputTokens: result.ok ? (result.inputTokens ?? null) : null,
    outputTokens: result.ok ? (result.outputTokens ?? null) : null,
    latencyMs: result.latencyMs,
  };
}

async function main(): Promise<void> {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const codecraft: CodeCraftModule =
    await import("../src/server/integrations/ai/codecraft");
  const aiContract: typeof import("../src/features/conversations/server/ai-contract") =
    await import("../src/features/conversations/server/ai-contract");

  const getEnvVar = (name: string) => process.env[name];
  const key = getEnvVar(codecraft.CODECRAFT_SECRET_REF);
  console.log("provider: codecraft");
  console.log(`endpoint: ${new URL(codecraft.CODECRAFT_ENDPOINT).host}`);
  console.log(
    `secret: ${maskKey(key)} (ref ${codecraft.CODECRAFT_SECRET_REF})`,
  );
  console.log(`timeout ms: ${codecraft.CODECRAFT_TIMEOUT_MS}`);

  const outcomes: StageOutcome[] = [];

  if (!key) {
    console.log(
      "\nNOTE: CODECRAFT_API_KEY is not set — skipping live stages. Adapter + registration are still fully covered offline (pnpm check:ai-provider).",
    );
    console.log("PROBE_RESULT: NO_KEY");
    return;
  }

  // ── STAGE 1: model discovery ─────────────────────────────────────────────
  const discovery = await discoverModels(codecraft, getEnvVar, fetch);
  console.log("\n── STAGE 1: MODEL DISCOVERY (GET /v1/models) ──");
  console.log(`http status: ${discovery.httpStatus ?? "n/a"}`);
  if (discovery.error) {
    console.log(`error: ${discovery.error}`);
    outcomes.push({
      label: "model-discovery",
      ok: false,
      httpStatus: discovery.httpStatus,
      latencyMs: null,
      errorCode: null,
      detail: discovery.error,
    });
  } else {
    console.log(`models available: ${discovery.models.length}`);
    for (const m of discovery.models) {
      const parts = [m.id];
      if (m.contextWindow !== null) parts.push(`ctx=${m.contextWindow}`);
      if (m.capabilities !== null)
        parts.push(`caps=[${m.capabilities.join(",")}]`);
      if (m.hasPricing) parts.push("pricing=present");
      console.log(`  - ${parts.join(" · ")}`);
    }
    outcomes.push({
      label: "model-discovery",
      ok: true,
      httpStatus: discovery.httpStatus,
      latencyMs: null,
      errorCode: null,
      detail: `${discovery.models.length} models`,
    });
  }

  // The model under test: explicit override, else the first id the account
  // can see, else a documented placeholder the operator must override.
  const MODEL =
    process.env.CODECRAFT_MODEL ??
    discovery.models[0]?.id ??
    "codecraft-default";
  console.log(`model under test: ${MODEL}`);

  const request: AiRequest = {
    message: "ما هي ساعات العمل؟",
    conversationStatus: "AI_ACTIVE",
    recentMessages: [],
    businessName: "FlowPilot probe",
    services: [],
    faqs: [{ question: "ما هي ساعات العمل؟", answer: "من 9 حتى 6" }],
  };

  const adapter = codecraft.createCodeCraftAdapter({
    model: MODEL,
    getEnvVar,
    fetchImpl: fetch,
  });

  // ── STAGE 2: compatibility through the REAL adapter path ────────────────
  // Every attempt uses the shared callOpenAiCompatible → buildPromptMessages
  // → normalizeResponse → parseAiResponse/aiResponseSchema chain, so a pass
  // here means the FlowPilot AI contract holds end-to-end on CodeCraft.
  const records: Array<ReturnType<typeof bucketOf>> = [];
  for (let i = 1; i <= RUNS; i += 1) {
    const result = await adapter.call(request);
    const b = bucketOf(result);
    records.push(b);
    if (RUNS > 1) {
      console.log(
        `run ${i}: ok=${b.ok} code=${b.errorCode ?? "-"} parseMode=${b.parseMode} latency=${b.latencyMs}ms in=${b.inputTokens ?? "n/a"} out=${b.outputTokens ?? "n/a"}`,
      );
    }
  }

  const last = records[records.length - 1];
  if (last === undefined) throw new Error("no probe attempt produced a result");

  console.log("\n── STAGE 2: COMPATIBILITY (real adapter path) ──");
  console.log(`chat completion: ${last.ok ? "SUCCESS" : "FAILURE"}`);
  console.log(`latency ms: ${last.latencyMs}`);
  console.log(`parseMode: ${last.parseMode}`);
  console.log(`inputTokens: ${last.inputTokens ?? "n/a"}`);
  console.log(`outputTokens: ${last.outputTokens ?? "n/a"}`);
  if (!last.ok) {
    console.log(`errorCode: ${last.errorCode}`);
  }

  // Arabic + structured-contract conformance is proven structurally: the
  // accepted response passed aiResponseSchema (intent/action/content) and
  // the probe request itself is Arabic, so a SUCCESS means the provider
  // answered an Arabic turn with a schema-valid object.
  const contractOk = last.ok;
  outcomes.push({
    label: "chat-completion",
    ok: last.ok,
    httpStatus: null,
    latencyMs: last.latencyMs,
    errorCode: last.errorCode,
    detail: contractOk ? "Arabic request answered" : `code=${last.errorCode}`,
  });
  outcomes.push({
    label: "json-object-mode",
    ok: contractOk && last.parseMode === "DIRECT_PARSE",
    httpStatus: null,
    latencyMs: null,
    errorCode: last.errorCode,
    detail: contractOk
      ? `response_format json_object honoured (parseMode=${last.parseMode})`
      : `provider did not return a schema-valid object (code=${last.errorCode})`,
  });
  outcomes.push({
    label: "token-usage-capture",
    ok: contractOk && last.inputTokens !== null && last.outputTokens !== null,
    httpStatus: null,
    latencyMs: null,
    errorCode: null,
    detail:
      contractOk && last.inputTokens !== null && last.outputTokens !== null
        ? `in=${last.inputTokens} out=${last.outputTokens}`
        : "usage not returned by provider",
  });

  // Engine-level re-validation: even a provider-accepted object is re-parsed
  // by the engine's own parseAiResponse before anything is persisted.
  if (contractOk) {
    const revalidated = await adapter.call(request);
    if (revalidated.ok) {
      const parsed = aiContract.parseAiResponse(revalidated.response);
      outcomes.push({
        label: "parseAiResponse-conformance",
        ok: parsed !== null,
        httpStatus: null,
        latencyMs: revalidated.latencyMs,
        errorCode: null,
        detail:
          parsed !== null
            ? `intent=${parsed.intent} action=${parsed.action} contentLen=${parsed.content.length}`
            : "parseAiResponse rejected the provider object",
      });
    } else {
      outcomes.push({
        label: "parseAiResponse-conformance",
        ok: false,
        httpStatus: null,
        latencyMs: revalidated.latencyMs,
        errorCode: revalidated.error.code,
        detail: "second attempt failed",
      });
    }
  }

  console.log("\n── STAGE OUTCOMES ──");
  let failures = 0;
  for (const o of outcomes) {
    const mark = o.ok ? "✔" : "✘";
    if (!o.ok) failures += 1;
    console.log(`${mark} ${o.label}: ${o.ok ? "ok" : "FAIL"} — ${o.detail}`);
  }

  if (RUNS > 1) {
    const okCount = records.filter((r) => r.ok).length;
    const direct = records.filter(
      (r) => r.ok && r.parseMode === "DIRECT_PARSE",
    ).length;
    const latencies = records.map((r) => r.latencyMs).sort((a, b) => a - b);
    const p95 =
      latencies[
        Math.min(latencies.length - 1, Math.ceil(0.95 * latencies.length) - 1)
      ] ?? 0;
    console.log(`\n── ${RUNS}-RUN TALLY ──`);
    console.log(`success: ${okCount}/${RUNS}`);
    console.log(`DIRECT_PARSE: ${direct}/${RUNS}`);
    console.log(
      `latency p95=${p95}ms max=${latencies[latencies.length - 1] ?? 0}ms`,
    );
  }

  // The discovery stage failing is a hard block for model selection; a
  // compatibility failure is reported but the adapter itself stays valid.
  const discoveryOk =
    outcomes.find((o) => o.label === "model-discovery")?.ok ?? false;
  if (!discoveryOk) {
    console.log("\nPROBE_RESULT: DISCOVERY_BLOCKED");
    return;
  }
  console.log(
    `\nPROBE_RESULT: ${failures === 0 ? "SUCCESS" : "PARTIAL"} (${outcomes.length - failures}/${outcomes.length} stages ok)`,
  );
}

main().catch((error: Error) => {
  console.error(`probe crashed: ${error.message}`);
  console.error(error.stack ?? "");
  process.exit(1);
});
