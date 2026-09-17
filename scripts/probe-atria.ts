/* eslint-disable @typescript-eslint/consistent-type-imports */
/**
 * FlowPilot — Atria provider probe (PROMPT-ARCH-AI-PROVIDER-ATRIA-07).
 *
 * A minimal, CONTROLLED validation of the real Atria adapter path:
 * real endpoint, real authentication (read from the environment by the
 * secret NAME only), configured model, trivial prompt. It touches no
 * database, no conversation state, no WhatsApp transport.
 *
 * Output is deliberately sanitized — it prints ONLY:
 *   provider · endpoint hostname · model · HTTP status · latency ·
 *   success/failure · sanitized response summary
 * The API key is never read into a printed variable, never logged, and
 * never echoed. Run:  pnpm probe:atria   (after ATRIA_API_KEY is in .env.local)
 */
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

type AiRequest =
  import("../src/features/conversations/server/ai-contract").AiRequest;
type AtriaModule = typeof import("../src/server/integrations/ai/atria");

const MODEL = process.env.ATRIA_MODEL ?? "Atria-Dawn-Preview";

async function main(): Promise<void> {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const atria: AtriaModule =
    await import("../src/server/integrations/ai/atria");

  const hostname = new URL(atria.ATRIA_ENDPOINT).host;

  // Observing fetch: records the real HTTP status, then returns the raw
  // response untouched so the adapter still parses the real body itself.
  let httpStatus: number | null = null;
  const observingFetch: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    httpStatus = res.status;
    return res;
  };

  const adapter = atria.createAtriaAdapter({
    model: MODEL,
    getEnvVar: (name) => process.env[name],
    fetchImpl: observingFetch,
  });

  const request: AiRequest = {
    message: "ما هي ساعات العمل؟",
    conversationStatus: "AI_ACTIVE",
    recentMessages: [],
    businessName: "FlowPilot probe",
    services: [],
    faqs: [{ question: "ما هي ساعات العمل؟", answer: "من 9 حتى 6" }],
  };

  const result = await adapter.call(request);

  console.log("provider: atria");
  console.log(`endpoint: ${hostname}`);
  console.log(`model: ${MODEL}`);
  console.log(`http status: ${httpStatus ?? "n/a"}`);
  console.log(`latency ms: ${result.latencyMs}`);
  console.log(`success: ${result.ok}`);

  if (result.ok) {
    const r = result.response;
    console.log(
      `response: intent=${r.intent} action=${r.action} contentLength=${r.content.length} hasExtraction=${r.extraction.service !== null || r.extraction.provider !== null} inputTokens=${result.inputTokens ?? "n/a"} outputTokens=${result.outputTokens ?? "n/a"}`,
    );
    console.log("PROBE_RESULT: SUCCESS");
  } else {
    // Sanitized: error code + provider message only — never headers/keys.
    console.log(
      `error: code=${result.error.code} retryable=${result.error.retryable} httpStatus=${result.error.httpStatus ?? "n/a"}`,
    );
    console.log(`error message: ${result.error.message}`);
    console.log("PROBE_RESULT: FAILURE");
  }
}

main().catch((error: Error) => {
  console.error(`probe crashed: ${error.message}`);
  process.exit(1);
});
