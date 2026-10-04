/* eslint-disable @typescript-eslint/consistent-type-imports */
/**
 * FlowPilot — OpenRouter provider probe + provider-pin verification
 * (PROMPT-AI-OPS-28).
 *
 * A minimal, CONTROLLED validation of the real OpenRouter adapter path and
 * the OPTIONAL provider endpoint pin: real endpoint, real authentication
 * (read from the environment by the secret NAME only), configured model,
 * trivial SYNTHETIC probe message. It touches no database, no conversation
 * state, and NO customer channel — it never sends a WhatsApp/Telegram
 * message; it only calls the OpenRouter inference API directly.
 *
 * What it proves (the bounded verification path):
 *   selected provider · selected model · provider pin · the ACTUAL request
 *   body routing semantics that left the adapter.
 *
 * Output is ROUTING-ONLY and sanitized. It NEVER prints:
 *   the API key · authorization headers · the prompt body · message
 *   contents · customer PII · raw provider payloads. Only the `provider`
 *   routing object and closed classifications (status/latency/tokens) are
 *   reported.
 *
 * Run:  pnpm probe:openrouter   (after OPENROUTER_API_KEY is in .env.local)
 *       OPENROUTER_MODEL=deepseek/deepseek-v4.1-flash \
 *         OPENROUTER_PROVIDER_PIN=decart/fp4 pnpm probe:openrouter
 *       PROBE_RUNS=N pnpm probe:openrouter   (N attempts + tally)
 *
 * With no OPENROUTER_PROVIDER_PIN set, Stage A alone runs and proves the
 * DEFAULT routing is unchanged (no `provider` key is sent).
 */
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

type AiRequest =
  import("../src/features/conversations/server/ai-contract").AiRequest;
type OpenRouterModule =
  typeof import("../src/server/integrations/ai/openrouter");
type AiProviderResult =
  import("../src/server/integrations/ai/types").AiProviderResult;

type RoutingSent = {
  model: string | null;
  hasProviderKey: boolean;
  only: string[] | null;
  allowFallbacks: boolean | null;
};

type StageOutcome = {
  label: string;
  ok: boolean;
  detail: string;
};

const RUNS = Math.max(1, Number(process.env.PROBE_RUNS ?? "1") || 1);

function maskKey(key: string | undefined): string {
  if (!key) return "unset";
  return `set(${key.length} chars)`;
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

  const openrouter: OpenRouterModule =
    await import("../src/server/integrations/ai/openrouter");
  const aiContract: typeof import("../src/features/conversations/server/ai-contract") =
    await import("../src/features/conversations/server/ai-contract");

  const getEnvVar = (name: string) => process.env[name];
  const key = getEnvVar(openrouter.OPENROUTER_SECRET_REF);
  const MODEL = process.env.OPENROUTER_MODEL ?? "openrouter/auto";
  // The pin under test. Empty/absent ⇒ default OpenRouter routing.
  const rawPin = process.env.OPENROUTER_PROVIDER_PIN ?? "";
  const PIN = rawPin.trim().length > 0 ? rawPin.trim() : null;

  // ── EVIDENCE (sanitized): provider/model/pin identity only ──────────────
  // The request BODY is inspected for the routing object ONLY — never the
  // prompt, never the headers, never the key.
  console.log("provider: openrouter");
  console.log(`endpoint: ${new URL(openrouter.OPENROUTER_ENDPOINT).host}`);
  console.log(
    `secret: ${maskKey(key)} (ref ${openrouter.OPENROUTER_SECRET_REF})`,
  );
  console.log(`model: ${MODEL}`);
  console.log(`providerPin: ${PIN ?? "(none — default routing)"}`);
  console.log(`timeout ms: ${openrouter.OPENROUTER_TIMEOUT_MS}`);

  const outcomes: StageOutcome[] = [];

  if (!key) {
    console.log(
      "\nNOTE: OPENROUTER_API_KEY is not set — skipping live stages. The adapter + provider pin are still fully covered offline (pnpm check:ai-provider / pnpm check:policy).",
    );
    console.log("PROBE_RESULT: NO_KEY");
    return;
  }

  const request: AiRequest = {
    message: "ما هي ساعات العمل؟",
    conversationStatus: "AI_ACTIVE",
    recentMessages: [],
    businessName: "FlowPilot probe",
    services: [],
    faqs: [{ question: "ما هي ساعات العمل؟", answer: "من 9 حتى 6" }],
  };

  /**
   * Wraps the real fetch to capture the ROUTING semantics actually sent, then
   * delegates. Only `model` + the `provider` object are read out — the prompt
   * body and the Authorization header are never inspected or printed.
   */
  function captureRoutingFetch(realFetch: typeof fetch): {
    fetch: typeof fetch;
    lastRouting: () => RoutingSent;
  } {
    let sent: RoutingSent | null = null;
    const f = (async (url: string, init?: RequestInit) => {
      try {
        const body = JSON.parse(init?.body as string) as {
          model?: string;
          provider?: { only?: unknown[]; allow_fallbacks?: boolean };
        };
        const provider = body.provider;
        sent = {
          model: body.model ?? null,
          hasProviderKey:
            typeof provider === "object" && provider !== null && !!provider,
          only: Array.isArray(provider?.only)
            ? [...provider!.only!].map((v) => String(v))
            : null,
          allowFallbacks: provider?.allow_fallbacks ?? null,
        };
      } catch {
        sent = {
          model: null,
          hasProviderKey: false,
          only: null,
          allowFallbacks: null,
        };
      }
      void url; // endpoint already reported above; not re-printed
      return realFetch(url, init);
    }) as unknown as typeof fetch;
    return {
      fetch: f,
      lastRouting: () =>
        sent ?? {
          model: null,
          hasProviderKey: false,
          only: null,
          allowFallbacks: null,
        },
    };
  }

  async function runStage(label: string, pin: string | null): Promise<void> {
    const cap = captureRoutingFetch(fetch);
    const adapter = openrouter.createOpenRouterAdapter({
      model: MODEL,
      getEnvVar,
      fetchImpl: cap.fetch,
      providerOnly: pin,
    });
    let last: AiProviderResult | null = null;
    for (let i = 1; i <= RUNS; i += 1) {
      last = await adapter.call(request);
    }
    if (last === null) throw new Error(`stage ${label} produced no result`);
    const bucket = bucketOf(last);
    const r = cap.lastRouting();

    console.log(`\n── STAGE ${label} ──`);
    console.log(`providerPin applied: ${pin ?? "(none)"}`);
    console.log(
      `routing sent: ${r.hasProviderKey ? "provider key present" : "no provider key (default routing)"}`,
    );
    if (r.hasProviderKey) {
      console.log(`  provider.only: ${JSON.stringify(r.only)}`);
      console.log(`  provider.allow_fallbacks: ${r.allowFallbacks}`);
    }
    console.log(`model sent: ${r.model ?? "n/a"}`);
    console.log(`chat completion: ${bucket.ok ? "SUCCESS" : "FAILURE"}`);
    console.log(`latency ms: ${bucket.latencyMs}`);
    console.log(`parseMode: ${bucket.parseMode}`);
    console.log(
      `inputTokens: ${bucket.inputTokens ?? "n/a"} outputTokens: ${bucket.outputTokens ?? "n/a"}`,
    );
    if (!bucket.ok) console.log(`errorCode: ${bucket.errorCode}`);

    if (RUNS > 1) {
      console.log(`runs: ${RUNS} attempted`);
    }

    // Stage assertions: the routing semantics that actually left the adapter.
    const modelUntouched = r.model === MODEL;
    outcomes.push({
      label: `${label}: model unchanged by the pin`,
      ok: modelUntouched,
      detail: modelUntouched
        ? `model=${r.model}`
        : `model=${r.model} (expected ${MODEL})`,
    });
    if (pin) {
      const pinnedOk =
        r.hasProviderKey &&
        r.only?.length === 1 &&
        r.only[0] === pin &&
        r.allowFallbacks === false;
      outcomes.push({
        label: `${label}: provider.only=[${pin}] + allow_fallbacks=false`,
        ok: pinnedOk,
        detail: pinnedOk
          ? "exact provider pin sent"
          : `hasProviderKey=${r.hasProviderKey} only=${JSON.stringify(r.only)} allowFallbacks=${r.allowFallbacks}`,
      });
    } else {
      outcomes.push({
        label: `${label}: no provider key sent (default routing)`,
        ok: !r.hasProviderKey,
        detail: r.hasProviderKey
          ? "unexpected provider key on an unpinned request"
          : "provider restriction absent",
      });
    }
    const contractOk = bucket.ok;
    outcomes.push({
      label: `${label}: schema-valid Arabic turn answered`,
      ok: contractOk,
      detail: contractOk
        ? `parseMode=${bucket.parseMode} in=${bucket.inputTokens ?? "n/a"} out=${bucket.outputTokens ?? "n/a"}`
        : `code=${bucket.errorCode}`,
    });
    if (last.ok) {
      // Engine-level re-validation of the accepted object — a PURE local
      // schema check over the last result, so no extra model call is spent.
      const parsed = aiContract.parseAiResponse(last.response);
      outcomes.push({
        label: `${label}: parseAiResponse accepts the provider object`,
        ok: parsed !== null,
        detail:
          parsed !== null
            ? `intent=${parsed.intent} action=${parsed.action} contentLen=${parsed.content.length}`
            : "parseAiResponse rejected the provider object",
      });
    }
  }

  // STAGE A — the unchanged baseline: no pin ⇒ default OpenRouter routing.
  await runStage("A: default routing (no pin)", null);

  // STAGE B — the pinned path (only when the operator configured a pin).
  if (PIN) {
    await runStage(`B: pinned (${PIN})`, PIN);
  } else {
    console.log("\n── STAGE B skipped: OPENROUTER_PROVIDER_PIN not set ──");
    console.log(
      "Set OPENROUTER_PROVIDER_PIN=owner/model to verify the pinned path live.",
    );
  }

  console.log("\n── STAGE OUTCOMES ──");
  let failures = 0;
  for (const o of outcomes) {
    const mark = o.ok ? "✔" : "✘";
    if (!o.ok) failures += 1;
    console.log(`${mark} ${o.label}: ${o.ok ? "ok" : "FAIL"} — ${o.detail}`);
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
