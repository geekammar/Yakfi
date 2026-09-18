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
 *   success/failure · sanitized response summary · normalization stage
 * The API key is never read into a printed variable, never logged, and
 * never echoed. Run:  pnpm probe:atria   (after ATRIA_API_KEY is in .env.local)
 *
 * Set PROBE_RUNS=N to run N controlled attempts of the SAME request and
 * print an aggregate tally (methodology, request, model, endpoint, prompt,
 * response_format, temperature and timeout are identical for every attempt).
 *
 * Normalization classification is read from the engine's OWN trace
 * (`result.normalizerTrace`) — it never duplicates pipeline internals, and it
 * reveals NO content, NO keys, NO values, NO headers.
 */
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

type AiRequest =
  import("../src/features/conversations/server/ai-contract").AiRequest;
type AtriaModule = typeof import("../src/server/integrations/ai/atria");
type NormalizerModule =
  typeof import("../src/server/integrations/ai/response-normalizer");
type NormalizerPolicy =
  import("../src/server/integrations/ai/response-normalizer").NormalizerPolicy;
type NormalizerTrace =
  import("../src/server/integrations/ai/response-normalizer").NormalizerTrace;

const MODEL = process.env.ATRIA_MODEL ?? "Atria-Dawn-Preview";
const RUNS = Math.max(1, Number(process.env.PROBE_RUNS ?? "1") || 1);
/**
 * PROBE_BASELINE=1 reproduces the PREVIOUS pipeline (the single
 * brace-normalize + jsonrepair seam, with NO empty-key-wrapper rule) using
 * the SAME adapter, endpoint, model, request, response_format, temperature
 * and timeout — an apples-to-apples A/B against the new engine. Only the
 * normalization policy differs.
 *
 * PROBE_PAIRED=1 is the rigorous variant: the adapter runs the NEW engine,
 * and every captured response is ALSO classified in-memory against the
 * BASELINE policy (the previous seam). Content never leaves the process and
 * is never printed — only a paired contingency tally of verdicts.
 */
const BASELINE = process.env.PROBE_BASELINE === "1";
const PAIRED = process.env.PROBE_PAIRED === "1";

/**
 * Sanitized normalization-outcome category for a single attempt, derived
 * from the engine's authoritative trace.
 */
type NormalizerClass =
  | "strict_ok" // DIRECT_PARSE: strict parse + schema accepted first time
  | "strict_ok_schema_fail" // strict parse ok, schema rejected (repair ran)
  | "generic_no_candidate" // jsonrepair produced no single-object candidate
  | "generic_parse_fail" // candidate did not strict-parse
  | "generic_schema_fail" // candidate parsed; schema still rejected
  | "generic_ok" // GENERIC_REPAIRED_PARSE
  | "provider_not_in_scope" // policy absent / out of scope
  | "provider_no_candidate" // every rule declined
  | "provider_parse_fail" // a rule candidate did not strict-parse
  | "provider_schema_fail" // a rule candidate parsed; schema rejected
  | "provider_ok" // BOUNDED_PROVIDER_REPAIR
  | "not_classified";

type OutcomeBucket =
  | "SUCCESS"
  | "INVALID_RESPONSE"
  | "TIMEOUT"
  | "AUTH_FAILURE"
  | "NETWORK_ERROR"
  | "PROVIDER_HTTP_ERROR";

type RunRecord = {
  run: number;
  httpStatus: number | null;
  latencyMs: number;
  ok: boolean;
  parseMode: string;
  bucket: OutcomeBucket;
  normalizerClass: NormalizerClass;
  rejectReason: string;
  wireFingerprint: string;
  rule: string | null;
};

function bucketOf(
  ok: boolean,
  errorCode: string | undefined,
  httpStatus: number | null,
): OutcomeBucket {
  if (ok) return "SUCCESS";
  if (errorCode === "TIMEOUT") return "TIMEOUT";
  if (errorCode === "INVALID_RESPONSE") return "INVALID_RESPONSE";
  if (errorCode === "CONFIG_ERROR") return "AUTH_FAILURE";
  if (errorCode === "RETRYABLE") {
    return httpStatus === null ? "NETWORK_ERROR" : "PROVIDER_HTTP_ERROR";
  }
  return "PROVIDER_HTTP_ERROR";
}

/** Exact two-sided binomial CDF (P(X <= k) for X ~ Binom(n, 0.5)). */
function binomCdf(k: number, n: number, p = 0.5): number {
  if (n <= 0) return 1;
  const kk = Math.min(k, n - k);
  let c = 1;
  let sum = 0;
  for (let i = 0; i <= kk; i += 1) {
    sum += c * Math.pow(p, i) * Math.pow(1 - p, n - i);
    c = (c * (n - i)) / (i + 1);
  }
  return Math.min(1, 2 * sum);
}

function classify(trace: NormalizerTrace | undefined): NormalizerClass {
  if (!trace) return "not_classified";
  if (trace.outcome === "DIRECT_PARSE") return "strict_ok";
  if (trace.outcome === "GENERIC_REPAIRED_PARSE") return "generic_ok";
  if (trace.outcome === "BOUNDED_PROVIDER_REPAIR") return "provider_ok";
  // INVALID_RESPONSE: report the furthest stage reached and why it failed.
  if (!trace.strictParseOk && !trace.genericRepairRan) return "not_classified";
  if (trace.strictParseOk && !trace.schemaOk && !trace.genericRepairRan) {
    return "strict_ok_schema_fail";
  }
  if (trace.genericRepairRan) {
    if (!trace.genericRepairProducedCandidate) return "generic_no_candidate";
    if (!trace.genericRepairStrictParseOk) return "generic_parse_fail";
    if (!trace.genericRepairSchemaOk) return "generic_schema_fail";
  }
  if (trace.providerRepairRan) {
    const attempts = trace.ruleAttempts;
    if (attempts.length === 0) return "provider_no_candidate";
    if (attempts.some((a) => !a.declined && a.strictParseOk && !a.schemaOk)) {
      return "provider_schema_fail";
    }
    if (attempts.some((a) => !a.declined && !a.strictParseOk)) {
      return "provider_parse_fail";
    }
    return "provider_no_candidate";
  }
  return "not_classified";
}

async function main(): Promise<void> {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const atria: AtriaModule =
    await import("../src/server/integrations/ai/atria");
  const normalizer: NormalizerModule =
    await import("../src/server/integrations/ai/response-normalizer");

  const hostname = new URL(atria.ATRIA_ENDPOINT).host;

  // Observing fetch: records the real HTTP status, then returns the raw
  // response untouched so the adapter still parses the real body itself.
  // Also records a SANITIZED STRUCTURAL fingerprint of the WIRE content
  // (independent evidence of what the provider actually sent): length,
  // leading/trailing brace counts, first byte, and the JSON.parse failure
  // position. It reveals NO content, NO keys, NO headers.
  let httpStatus: number | null = null;
  let wireFingerprint = "n/a";
  // In-memory only: the raw model content of the current attempt, used by
  // PAIRED mode to classify the SAME response under the baseline pipeline.
  // It is NEVER printed, NEVER logged, and dropped after each attempt.
  let wireContent: string | null = null;
  const observingFetch: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    httpStatus = res.status;
    try {
      const body = (await res.clone().json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const t = (body.choices?.[0]?.message?.content ?? "").trim();
      if (PAIRED) wireContent = t;
      const lead = t.match(/^\{+/)?.[0].length ?? 0;
      const trail = t.match(/\}+$/)?.[0].length ?? 0;
      // Same fence-stripping the engine applies, so the wire view is
      // faithful to what the pipeline actually received.
      const stripped = normalizer.stripJsonFences(t);
      let parseState = "ok";
      try {
        JSON.parse(stripped);
      } catch (e) {
        const pos = /position (\d+)/.exec((e as Error).message)?.[1];
        parseState = `fail@${pos ?? "?"}`;
      }
      wireFingerprint = `len=${t.length} first=${t[0] ?? "∅"} lead=${lead} trail=${trail} fenced=${t.startsWith("```")} parse=${parseState}`;
    } catch {
      wireFingerprint = "unreadable-body";
    }
    return res;
  };

  // The BASELINE policy = the previous single seam (brace normalization +
  // jsonrepair), which the engine evaluates identically except for the
  // absent empty-key-wrapper rule. Used for the paired A/B.
  const BASELINE_POLICY: NormalizerPolicy = {
    provider: "atria",
    rules: [normalizer.ATRIA_SURPLUS_BRACE_RULE],
  };

  const adapter = atria.createAtriaAdapter({
    model: MODEL,
    getEnvVar: (name) => process.env[name],
    fetchImpl: observingFetch,
    // Baseline A/B: the previous pipeline behaviour is exactly the new
    // engine minus the empty-key-wrapper rule (brace normalization +
    // jsonrepair, still strict-parse + schema gated).
    policy: BASELINE ? BASELINE_POLICY : undefined,
  });

  const request: AiRequest = {
    message: "ما هي ساعات العمل؟",
    conversationStatus: "AI_ACTIVE",
    recentMessages: [],
    businessName: "FlowPilot probe",
    services: [],
    faqs: [{ question: "ما هي ساعات العمل؟", answer: "من 9 حتى 6" }],
  };

  const records: RunRecord[] = [];
  const paired: Array<{ newOk: boolean; baselineOk: boolean }> = [];
  let lastResult:
    | import("../src/server/integrations/ai/types").AiProviderSuccess
    | import("../src/server/integrations/ai/types").AiProviderFailure
    | null = null;
  for (let i = 1; i <= RUNS; i += 1) {
    // Fresh observability state per attempt; request/endpoint/model/timeout
    // are identical across attempts (same controlled methodology).
    httpStatus = null;
    wireFingerprint = "n/a";
    const result = await adapter.call(request);
    lastResult = result;
    const trace = result.normalizerTrace;
    const parseMode = result.ok ? (result.parseMode ?? "DIRECT_PARSE") : "n/a";
    const bucket = bucketOf(
      result.ok,
      result.ok ? undefined : result.error.code,
      httpStatus,
    );
    const rec: RunRecord = {
      run: i,
      httpStatus,
      latencyMs: result.latencyMs,
      ok: result.ok,
      parseMode,
      bucket,
      normalizerClass: classify(trace),
      // Rejection reasons are only meaningful for failures; successes keep
      // the trace's last interim reason, so never report it as a rejection.
      rejectReason: result.ok
        ? `accepted:${parseMode}`
        : (trace?.rejectReason ?? "no content trace"),
      wireFingerprint,
      rule: trace?.providerRepairRule ?? null,
    };
    records.push(rec);
    if (PAIRED) {
      // Classify the SAME wire response under the baseline pipeline. Content
      // stays in memory; only the paired verdict is recorded.
      const baselineOk =
        wireContent !== null &&
        normalizer.normalizeResponse({
          content: wireContent,
          provider: "atria",
          model: MODEL,
          policy: BASELINE_POLICY,
        }).ok;
      paired.push({ newOk: result.ok, baselineOk });
      wireContent = null;
    }
    if (RUNS > 1) {
      console.log(
        `run ${i}: ${bucket} parseMode=${parseMode} latency=${rec.latencyMs}ms http=${rec.httpStatus ?? "n/a"} class=${rec.normalizerClass}${rec.rule ? ` rule=${rec.rule}` : ""}`,
      );
      // Sanitized structural detail for failures (shape statistics only).
      if (!result.ok && trace) {
        console.log(
          `        ${normalizer.summarizeNormalizerResult({ ok: false, mode: "INVALID_RESPONSE", trace })}`,
        );
      }
    }
  }

  const result = lastResult;
  if (result === null) throw new Error("no probe attempt produced a result");
  const summary = records[records.length - 1];
  if (summary === undefined) throw new Error("no run record captured");

  console.log("provider: atria");
  console.log(
    `pipeline: ${PAIRED ? "NEW engine + PAIRED baseline classification" : BASELINE ? "BASELINE (previous seam)" : "NEW normalization engine"}`,
  );
  console.log(`endpoint: ${hostname}`);
  console.log(`model: ${MODEL}`);
  console.log(`http status: ${summary.httpStatus ?? "n/a"}`);
  console.log(`latency ms: ${result.latencyMs}`);
  console.log(`success: ${result.ok}`);

  if (result.ok) {
    const r = result.response;
    console.log(
      `response: intent=${r.intent} action=${r.action} contentLength=${r.content.length} inputTokens=${result.inputTokens ?? "n/a"} outputTokens=${result.outputTokens ?? "n/a"}`,
    );
    // Sanitized classification only — never raw content/keys.
    console.log(`parseMode: ${result.parseMode ?? "DIRECT_PARSE"}`);
    console.log(`wireFingerprint: ${wireFingerprint}`);
    console.log("PROBE_RESULT: SUCCESS");
  } else {
    // Sanitized: error code + provider message only — never headers/keys.
    console.log(
      `error: code=${result.error.code} retryable=${result.error.retryable} httpStatus=${result.error.httpStatus ?? "n/a"}`,
    );
    console.log(`error message: ${result.error.message}`);
    console.log(`rejectReason: ${summary.rejectReason}`);
    console.log(`wireFingerprint: ${wireFingerprint}`);
    console.log("PROBE_RESULT: FAILURE");
  }

  if (RUNS > 1) {
    const tally = new Map<OutcomeBucket, number>();
    const classTally = new Map<NormalizerClass, number>();
    const reasonTally = new Map<string, number>();
    const ruleTally = new Map<string, number>();
    const latencies: number[] = [];
    for (const rec of records) {
      tally.set(rec.bucket, (tally.get(rec.bucket) ?? 0) + 1);
      classTally.set(
        rec.normalizerClass,
        (classTally.get(rec.normalizerClass) ?? 0) + 1,
      );
      reasonTally.set(
        rec.rejectReason,
        (reasonTally.get(rec.rejectReason) ?? 0) + 1,
      );
      if (rec.rule) ruleTally.set(rec.rule, (ruleTally.get(rec.rule) ?? 0) + 1);
      latencies.push(rec.latencyMs);
    }
    const direct = records.filter(
      (r) => r.ok && r.parseMode === "DIRECT_PARSE",
    ).length;
    const genericOk = records.filter(
      (r) => r.ok && r.parseMode === "GENERIC_REPAIRED_PARSE",
    ).length;
    const providerOk = records.filter(
      (r) => r.ok && r.parseMode === "BOUNDED_PROVIDER_REPAIR",
    ).length;
    const repairInvocations = records.filter(
      (r) => r.normalizerClass !== "strict_ok",
    ).length;
    const repairSuccesses = records.filter(
      (r) =>
        r.normalizerClass === "generic_ok" ||
        r.normalizerClass === "provider_ok",
    ).length;
    const schemaFailuresAfterRepair = records.filter(
      (r) =>
        r.normalizerClass === "generic_schema_fail" ||
        r.normalizerClass === "provider_schema_fail",
    ).length;
    const sorted = [...latencies].sort((a, b) => a - b);
    const p95 =
      sorted[
        Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)
      ] ?? 0;
    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;

    console.log(`\n── ${RUNS}-RUN CONTROLLED PROBE TALLY ──`);
    console.log(`runs: ${RUNS}`);
    for (const b of [
      "SUCCESS",
      "INVALID_RESPONSE",
      "TIMEOUT",
      "AUTH_FAILURE",
      "NETWORK_ERROR",
      "PROVIDER_HTTP_ERROR",
    ] as OutcomeBucket[]) {
      console.log(`${b}: ${tally.get(b) ?? 0}/${RUNS}`);
    }
    console.log("--- normalization paths ---");
    console.log(`DIRECT_PARSE: ${direct}/${RUNS}`);
    console.log(`GENERIC_REPAIRED_PARSE: ${genericOk}/${RUNS}`);
    console.log(`BOUNDED_PROVIDER_REPAIR: ${providerOk}/${RUNS}`);
    console.log("--- repair accounting ---");
    console.log(`repair invocations: ${repairInvocations}/${RUNS}`);
    console.log(`repair successes: ${repairSuccesses}/${RUNS}`);
    console.log(
      `schema failures after repair: ${schemaFailuresAfterRepair}/${RUNS}`,
    );
    console.log("--- latency ---");
    console.log(
      `latency avg=${Math.round(avg)}ms p95=${p95}ms max=${sorted[sorted.length - 1] ?? 0}ms`,
    );
    console.log("normalizer class:");
    for (const [cls, n] of classTally) {
      console.log(`  ${cls}: ${n}`);
    }
    if (ruleTally.size > 0) {
      console.log("provider rule fired:");
      for (const [rule, n] of ruleTally) {
        console.log(`  ${rule}: ${n}`);
      }
    }
    console.log("rejection reason (failures only):");
    for (const [reason, n2] of reasonTally) {
      if (reason.startsWith("accepted:")) continue;
      console.log(`  ${reason}: ${n2}`);
    }
    if (PAIRED && paired.length > 0) {
      const both = paired.filter((p) => p.newOk && p.baselineOk).length;
      const newOnly = paired.filter((p) => p.newOk && !p.baselineOk).length;
      const baseOnly = paired.filter((p) => !p.newOk && p.baselineOk).length;
      const neither = paired.filter((p) => !p.newOk && !p.baselineOk).length;
      console.log("\n── PAIRED A/B (identical responses) ──");
      console.log(`content-bearing attempts classified: ${paired.length}`);
      console.log(`both pipelines accept: ${both}`);
      console.log(`NEW only accepts: ${newOnly}`);
      console.log(`baseline only accepts: ${baseOnly}`);
      console.log(`neither accepts: ${neither}`);
      const bOk = paired.filter((p) => p.baselineOk).length;
      const nOk = paired.filter((p) => p.newOk).length;
      console.log(
        `accept rate on the SAME responses: baseline ${bOk}/${paired.length} → new ${nOk}/${paired.length}`,
      );
      // McNemar's test on the discordant pairs (exact binomial, b < 25).
      const discordant = newOnly + baseOnly;
      if (discordant > 0) {
        const p = binomCdf(baseOnly, discordant, 0.5);
        console.log(
          `McNemar exact p = ${p.toExponential(3)} (discordant=${discordant}: new-only=${newOnly}, baseline-only=${baseOnly})`,
        );
      }
    }
  }
}

main().catch((error: Error) => {
  console.error(`probe crashed: ${error.message}`);
  console.error(error.stack ?? "");
  process.exit(1);
});
