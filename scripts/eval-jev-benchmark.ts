/* eslint-disable @typescript-eslint/consistent-type-imports */
/**
 * FlowPilot AI Evaluation — the REAL JEV BENCHMARK runner (PROMPT-AI-JEV-01).
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  EVALUATION-ONLY. Runs from scripts/, never imported by src/.         │
 * │  Makes REAL external Jev calls ONLY when OPENROUTER_API_KEY is        │
 * │  present AND --live is passed. Performs NO customer messaging, NO     │
 * │  booking mutation, NO database write and NO production routing change. │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * MODES
 *
 *  pnpm eval:jev                     OFFLINE (default). Proves the whole
 *                                    evaluation surface end-to-end with NO
 *                                    external call: request bodies, response
 *                                    mapping, precedence consumption, cost
 *                                    accounting and class coverage all run
 *                                    against a documented fake Jev. This is
 *                                    the mode this task can run.
 *
 *  pnpm eval:jev -- --live           LIVE. Requires OPENROUTER_API_KEY in
 *                                    .env.local. Sends the PINNED model
 *                                    `typesafe/jev-1.13` one request per
 *                                    fixture through the OpenRouter Decisions
 *                                    API and records raw probabilities,
 *                                    served snapshot, latency and usage.cost.
 *
 *  pnpm eval:jev -- --live --model ~typesafe/jev-latest
 *                                    Secondary comparison column only. The
 *                                    alias is NEVER the primary measured
 *                                    model; a run that measures it is NOT
 *                                    comparable to a pinned run.
 *
 * WHAT IT RECORDS (per fixture, when live)
 *   requested model · served model snapshot · provider · every raw Noul
 *   probability · Choice selection + per-option probabilities + confidence ·
 *   input tokens · output tokens · usage.cost · latency · pass/disagreement
 *   notes · the server-precedence verdict derived from BOTH the expected
 *   facts and the model facts.
 *
 * WHAT IT NEVER RECORDS
 *   the API key · authorization headers · .env contents · any secret value.
 *
 * Run: pnpm eval:jev
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { config } from "dotenv";

// ── Credential loading (EVAL-ONLY repair) ─────────────────────────────────
// `dotenv` defaults to `override: false`, which means a variable ALREADY
// present in the ambient environment wins over the file. Some shells export
// `OPENROUTER_API_KEY` as an EMPTY string, which would then shadow the real
// value in .env.local and silently make a live run fail closed. `override:
// true` is scoped to THIS evaluation script only (it never runs in, and is
// never imported by, src/), and it makes the .env.local value authoritative
// for a benchmark that must measure the real key the operator configured.
config({ path: ".env.local", override: true });
config({ path: ".env" });

export {};

type JevEvaluationResult =
  import("../evaluation/jev/jev-decisions-adapter").JevEvaluationResult;
type JevEvaluationRequest =
  import("../evaluation/jev/jev-decisions-adapter").JevEvaluationRequest;
type JevFixture = import("../evaluation/jev/jev-fixture-bank").JevFixture;
type JevQuestionKey =
  import("../evaluation/jev/jev-question-contract").JevQuestionKey;

// ─── CLI ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const LIVE = args.includes("--live");
const WRITE_ARTIFACT = args.includes("--write-artifact");
const modelArg = readFlag("--model");
const limitArg = Number(readFlag("--limit") ?? "0") || 0;
const bankArg = readFlag("--bank");

function readFlag(name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? "") : null;
}

// ── Bank-slice selection (PROMPT-AI-JEV-02 §8/§9) ─────────────────────────────
// `original`    the frozen AI-JEV-01 bank — the before/after comparison set.
// `calibration` STAGE A only: evaluate candidate definitions + select policy.
// `holdout`     STAGE B only: frozen, run exactly once after the freeze.
// `all`         every slice (the full PROMPT-AI-JEV-02 bank).
type BankSelection = "original" | "calibration" | "holdout" | "all";
const BANK: BankSelection =
  bankArg === "calibration" ||
  bankArg === "holdout" ||
  bankArg === "original" ||
  bankArg === "all"
    ? (bankArg as BankSelection)
    : "original";

// ─── Row shape (the benchmark's evidence record) ─────────────────────────────

type BenchmarkRow = {
  fixtureId: string;
  classes: string[];
  message: string;
  /** Every question key → the raw orientation this run derived. */
  expected: Record<string, boolean | null>;
  model: Record<string, boolean | null>;
  /** Raw Noul probabilities, retained verbatim (never reduced to a boolean). */
  rawProbabilities: Record<string, number | null>;
  /** Choice selection + confidence when the question is the goal Choice. */
  goalChoice: string | null;
  goalConfidence: number | null;
  /** Disagreements on scored questions only. */
  disagreements: string[];
  /** The policy decisions for each derived fact (auditable). */
  policyDecisions: Array<{
    key: string;
    probability: number | null;
    fact: boolean | null;
    confidence: string | null;
    source: string;
    note: string | null;
  }>;
  /** The server-owned precedence verdict derived from each fact set. */
  expectedExplicitHuman: boolean;
  modelExplicitHuman: boolean;
  precedenceDerivation: string;
  ok: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  requestedModel: string;
  servedModel: string | null;
  provider: string | null;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cost: number | null;
};

type BenchmarkReport = {
  mode: "offline" | "live";
  pinnedModel: string;
  requestedModel: string;
  questionContractId: string;
  plannedRequests: number;
  executedRequests: number;
  fixtures: number;
  scoredQuestions: number;
  /** The frozen contract + policy fingerprints this run is bound to (§9/§10). */
  contractFingerprint: string;
  policyFingerprint: string;
  /** The probability→fact policy id that derived the model facts. */
  policyId: string;
  /** The bank slice(s) this run measured. */
  bank: BankSelection;
  /** Slice fingerprints, so a frozen set is provably identified. */
  sliceFingerprints: Record<string, string>;
  rows: BenchmarkRow[];
  totals: {
    inputTokens: number;
    outputTokens: number;
    cost: number;
    errors: number;
    disagreements: number;
    latency: {
      min: number | null;
      p50: number | null;
      p95: number | null;
      max: number | null;
    };
  };
  byClass: Record<
    string,
    { cases: number; disagreements: number; errors: number }
  >;
  classCoverage: Record<string, number>;
  missingClasses: string[];
  credentialPresent: boolean;
};

// ─── The offline fake Jev (documented, deterministic, never a real call) ─────

/**
 * A deterministic stand-in used ONLY in offline mode. It answers from the
 * fixture's own expected facts plus one documented injected error, so the
 * offline run proves the FULL pipeline (mapping, validation, precedence,
 * accounting, reporting) end-to-end with zero external calls and zero spend.
 *
 * It is NOT real-Jev evidence and the report labels it loudly as offline.
 */
function offlineAnswers(
  fixture: JevFixture,
  keys: ReadonlyArray<JevQuestionKey>,
): Record<string, { type: "noul"; noul: number }> {
  const out: Record<string, { type: "noul"; noul: number }> = {};
  for (const key of keys) {
    const expected = fixture.expected[key];
    if (expected === undefined) {
      // An unscored question: emit a neutral probability so the full contract
      // round-trips, but it is excluded from scoring.
      out[key] = { type: "noul", noul: 0.5 };
    } else {
      out[key] = { type: "noul", noul: expected ? 0.97 : 0.03 };
    }
  }
  return out;
}

function offlineFakeFetch(
  fixturesById: Map<string, JevFixture>,
  keys: ReadonlyArray<JevQuestionKey>,
): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      state: { customer_message: string };
      questions: Record<string, unknown>;
    };
    const message = body.state.customer_message;
    const fixture = fixturesById.get(message) ?? null;

    const answers = fixture
      ? offlineAnswers(fixture, keys)
      : Object.fromEntries(
          Object.keys(body.questions).map((k) => [
            k,
            { type: "noul" as const, noul: 0.5 },
          ]),
        );

    const usage = {
      input_tokens: 320 + message.length,
      output_tokens: 24,
      cost: 0.0000128,
    };
    return new Response(
      JSON.stringify({
        id: `offline-${Date.now()}`,
        model: "typesafe/jev-1.13-OFFLINE-FAKE",
        provider: "OfflineFake",
        answers,
        usage,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }) as unknown as typeof fetch;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const adapterMod = await import("../evaluation/jev/jev-decisions-adapter");
  const contractMod = await import("../evaluation/jev/jev-question-contract");
  const bankMod = await import("../evaluation/jev/jev-fixture-bank");
  const policyMod = await import("../evaluation/jev/jev-probability-policy");

  const PINNED = adapterMod.JEV_PINNED_MODEL;
  const requestedModel = modelArg && modelArg.length > 0 ? modelArg : PINNED;
  const questions = contractMod.jevQuestionSet();
  const keys = contractMod.jevQuestionKeys;
  const bankAll =
    BANK === "original"
      ? bankMod.JEV_FIXTURES
      : BANK === "calibration"
        ? bankMod.JEV_CALIBRATION_FIXTURES
        : BANK === "holdout"
          ? bankMod.JEV_HOLDOUT_FIXTURES
          : bankMod.JEV_FIXTURES_V2;
  const fixtures = limitArg > 0 ? bankAll.slice(0, limitArg) : bankAll;
  const fixturesById = new Map(fixtures.map((f) => [f.message, f]));

  // ── Credential gate (PRESENT/MISSING only; the value is never touched) ────
  const keyPresent = Boolean(
    (process.env[adapterMod.JEV_SECRET_REF] ?? "").trim().length > 0,
  );

  // SAFETY: a live run requires the credential. Without it, the runner HARD
  // STOPS at zero external calls — it never fakes a live result.
  if (LIVE && !keyPresent) {
    console.log("OPENROUTER_CREDENTIAL: MISSING");
    console.log(
      `HARD STOP: --live requires ${adapterMod.JEV_SECRET_REF}, which is not configured. No external model call was attempted, and none was faked.`,
    );
    console.log(
      "Re-run without --live for the offline surface check, or configure the credential server-side (see the report's credential section).",
    );
    process.exit(2);
  }

  // Offline mode still runs when the credential is present; --live opts IN.
  const mode: "offline" | "live" = LIVE ? "live" : "offline";

  // ── Planned-call accounting (computed BEFORE any call is made) ────────────
  const plannedRequests = bankMod.plannedRequestCount(fixtures);
  console.log("PROMPT-AI-JEV-02 — Jev benchmark");
  console.log(
    `mode: ${mode}${mode === "live" ? " (REAL calls)" : " (NO external calls)"}`,
  );
  console.log(`bank slice: ${BANK} (${fixtures.length} fixtures)`);
  console.log(`pinned model: ${PINNED}`);
  console.log(
    `requested model: ${requestedModel}${requestedModel === PINNED ? "" : " (NON-PRIMARY — not comparable to a pinned run)"}`,
  );
  console.log(
    `question contract: ${contractMod.JEV_QUESTION_CONTRACT_ID} (${keys.length} questions)`,
  );
  console.log(`probability policy: ${policyMod.JEV_POLICY_ID}`);
  console.log(
    `contract fingerprint: ${policyMod.contractFingerprint(questions)}`,
  );
  console.log(`policy fingerprint: ${policyMod.policyFingerprint()}`);
  console.log(`fixtures: ${fixtures.length}`);
  console.log(
    `planned Jev requests: ${plannedRequests} (one request per fixture; all questions batched)`,
  );
  console.log(`OPENROUTER_CREDENTIAL: ${keyPresent ? "PRESENT" : "MISSING"}`);
  console.log();

  const getEnvVar = (name: string) => process.env[name];
  const fetchImpl =
    mode === "live" ? fetch : offlineFakeFetch(fixturesById, keys);

  // In OFFLINE mode the adapter's credential gate would stop the run before
  // the fake fetch is ever consulted, which would prove nothing about the
  // pipeline. So offline mode injects a PLACEHOLDER through a SEPARATE getter
  // that the adapter sees as "present". The REAL credential presence is
  // reported independently above (`keyPresent`), and no placeholder is ever
  // sent anywhere real — the offline fetch never touches the network.
  const adapterGetEnvVar =
    mode === "live" ? getEnvVar : () => "offline-placeholder";

  const adapter = adapterMod.createJevAdapter({
    getEnvVar: adapterGetEnvVar,
    fetchImpl,
    model: requestedModel,
  });

  // ── Execute ────────────────────────────────────────────────────────────────
  const rows: BenchmarkRow[] = [];
  let totalInput = 0;
  let totalOutput = 0;
  let totalCost = 0;
  let errors = 0;
  let totalDisagreements = 0;
  const latencies: number[] = [];

  for (const f of fixtures) {
    const request: JevEvaluationRequest = {
      state: {
        customerMessage: f.message,
        businessName: f.businessName,
        services: f.services,
        faqs: f.faqs,
        languageHint: f.languageHint,
      },
      questions,
    };

    const result: JevEvaluationResult = await adapter.evaluate(request);
    latencies.push(result.latencyMs);

    const expectedProj = bankMod.projectPrecedenceFacts(f.expected);
    const expectedVerdict = bankMod.applyServerPrecedence(expectedProj);

    // Model-derived facts → the SAME server formula.
    // The raw Noul probabilities are reduced to facts by the EXPLICIT
    // probability→fact policy (PROMPT-AI-JEV-02 §7), never by a bare 0.5 cut
    // inline. The policy records a decision per fact so every derived value
    // is auditable.
    const rawProbs: Record<string, number | null> = {};
    for (const key of keys) {
      rawProbs[key] = adapterMod.noulProbability(result, key);
    }
    const policyResult = policyMod.applyProbabilityPolicy(rawProbs, keys);
    const modelFacts: Record<string, boolean | null> = policyResult.facts;
    const modelProj = bankMod.projectPrecedenceFacts(
      modelFacts as Partial<Record<JevQuestionKey, boolean>>,
    );
    const modelVerdict = bankMod.applyServerPrecedence(modelProj);

    // Score ONLY the questions this fixture asserts an expectation for.
    const disagreements: string[] = [];
    for (const key of keys) {
      const expected = f.expected[key];
      if (expected === undefined) continue;
      const actual = modelFacts[key];
      if (actual === null || actual !== expected) {
        disagreements.push(
          `${key}: expected ${expected}, model ${actual === null ? "n/a" : actual}`,
        );
      }
    }

    const goalChoice = adapterMod.choiceSelection(result, "conversationGoal");
    const goalConfidence = adapterMod.answerConfidence(
      result,
      "conversationGoal",
    );

    const row: BenchmarkRow = {
      fixtureId: f.id,
      classes: [...f.classes],
      message: f.message,
      expected: expectedOrientation(f, keys),
      model: modelFacts,
      rawProbabilities: rawProbs,
      policyDecisions: policyResult.decisions.map((d) => ({
        key: d.key,
        probability: d.probability,
        fact: d.fact,
        confidence: d.confidence,
        source: d.source,
        note: d.note,
      })),
      goalChoice,
      goalConfidence,
      disagreements,
      expectedExplicitHuman: expectedVerdict.explicitHuman,
      modelExplicitHuman: modelVerdict.explicitHuman,
      precedenceDerivation: modelVerdict.derivation,
      ok: result.ok,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      requestedModel: result.requestedModel,
      servedModel: result.servedModel,
      provider: result.provider,
      latencyMs: result.latencyMs,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cost: result.usage.cost,
    };
    rows.push(row);

    if (!result.ok) {
      errors += 1;
    } else {
      totalInput += result.usage.inputTokens ?? 0;
      totalOutput += result.usage.outputTokens ?? 0;
      totalCost += result.usage.cost ?? 0;
    }
    totalDisagreements += disagreements.length;

    const mark = !result.ok ? "ERR" : disagreements.length === 0 ? "ok" : "DIS";
    console.log(
      `  ${mark}  ${f.id.padEnd(42)} ${String(result.latencyMs).padStart(5)}ms  in=${result.usage.inputTokens ?? "-"} out=${result.usage.outputTokens ?? "-"} cost=${result.usage.cost ?? "-"}${disagreements.length ? `  disagreements=${disagreements.length}` : ""}`,
    );
    if (!result.ok && result.errorMessage) {
      console.log(
        `        error: ${result.errorCode} — ${result.errorMessage}`,
      );
    }
  }

  // ── Aggregate ──────────────────────────────────────────────────────────────
  const byClass: BenchmarkReport["byClass"] = {};
  for (const row of rows) {
    for (const cls of row.classes) {
      byClass[cls] ??= { cases: 0, disagreements: 0, errors: 0 };
      byClass[cls].cases += 1;
      byClass[cls].disagreements += row.disagreements.length;
      if (!row.ok) byClass[cls].errors += 1;
    }
  }
  const coverage = bankMod.classCoverage(fixtures);
  const bankCheck = bankMod.bankCoversAllClasses(fixtures);

  const report: BenchmarkReport = {
    mode,
    pinnedModel: PINNED,
    requestedModel,
    questionContractId: contractMod.JEV_QUESTION_CONTRACT_ID,
    contractFingerprint: policyMod.contractFingerprint(questions),
    policyFingerprint: policyMod.policyFingerprint(),
    policyId: policyMod.JEV_POLICY_ID,
    bank: BANK,
    sliceFingerprints: bankMod.sliceFingerprints(),
    plannedRequests,
    executedRequests: rows.filter((r) => r.ok).length,
    fixtures: fixtures.length,
    // SCORED-QUESTION ACCOUNTING (PROMPT-AI-JEV-02 §4).
    // Count the question/expectation pairs the bank actually asserts an
    // expectation for. A row's serialized `expected` maps every question key
    // to `null` when the fixture asserts nothing for it (see
    // `expectedOrientation`), so "scored" is exactly "expected is non-null".
    // NOTE: this MUST be read off `row.expected`, never off the row object's
    // own property set — the row has top-level fields named `expected`,
    // `model`, …, and NO field named after a question key, so a
    // `hasOwnProperty(row, questionKey)` test is identically FALSE and
    // silently reports zero. That was the AI-JEV-01-S accounting defect
    // (reported scoredQuestions = 0 while the rows recompute to 125).
    scoredQuestions: rows.reduce(
      (n, r) => n + keys.filter((k) => r.expected[k] !== null).length,
      0,
    ),
    rows,
    totals: {
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cost: totalCost,
      errors,
      disagreements: totalDisagreements,
      latency: percentiles(latencies),
    },
    byClass,
    classCoverage: coverage,
    missingClasses: bankCheck.missing,
    credentialPresent: keyPresent,
  };

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log();
  console.log("── JEV BENCHMARK SUMMARY ──");
  console.log(`mode: ${mode}`);
  console.log(`credential: ${keyPresent ? "PRESENT" : "MISSING"}`);
  console.log(`requested model: ${requestedModel}`);
  console.log(
    `served snapshots: ${unique(rows.filter((r) => r.servedModel).map((r) => r.servedModel)).join(", ") || "none"}`,
  );
  console.log(
    `providers seen: ${unique(rows.filter((r) => r.provider).map((r) => r.provider)).join(", ") || "none"}`,
  );
  console.log(
    `requests: ${report.executedRequests} ok / ${fixtures.length} fixtures (planned ${plannedRequests})`,
  );
  console.log(`errors: ${errors}`);
  console.log(`scored questions: ${report.scoredQuestions}`);
  console.log(`disagreements: ${totalDisagreements}`);
  console.log(
    `contract fingerprint: ${report.contractFingerprint} (policy ${report.policyFingerprint})`,
  );
  console.log(
    `tokens: input=${totalInput} output=${totalOutput} (Jev bills input; output is free)`,
  );
  console.log(`usage.cost total: $${totalCost.toFixed(8)} USD`);
  const lat = report.totals.latency;
  console.log(
    `latency ms: min=${lat.min} p50=${lat.p50} p95=${lat.p95} max=${lat.max}`,
  );
  console.log();
  console.log("── BY COVERAGE CLASS ──");
  for (const cls of Object.keys(byClass).sort()) {
    const c = byClass[cls];
    if (!c) continue;
    console.log(
      `  ${cls.padEnd(46)} cases=${String(c.cases).padStart(2)} disagreements=${String(c.disagreements).padStart(2)} errors=${c.errors}`,
    );
  }
  if (bankCheck.missing.length > 0) {
    console.log(`  MISSING CLASSES: ${bankCheck.missing.join(", ")}`);
  }

  if (mode === "offline") {
    console.log();
    console.log(
      "NOTE: offline mode uses a documented deterministic fake. These numbers prove the EVALUATION SURFACE only; they are NOT real-Jev evidence.",
    );
  }

  if (WRITE_ARTIFACT) {
    const dir = resolve(process.cwd(), "evaluation/reports/jev");
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const suffix = mode === "live" ? "live" : "offline";
    const file = join(dir, `jev-benchmark-${BANK}-${suffix}-${stamp}.json`);
    writeFileSync(file, JSON.stringify(report, null, 2) + "\n", "utf8");
    console.log(`\nartifact: ${file}`);
  }

  // Exit non-zero on any error so CI catches a broken surface.
  if (errors > 0) {
    console.log(`\nRESULT: ${errors} fixture error(s)`);
    process.exit(1);
  }
  console.log("\nRESULT: OK");
}

/**
 * Recompute the scored-question count directly from a report's rows, WITHOUT
 * trusting the report's own `scoredQuestions` field. This is the independent
 * recomputation path (PROMPT-AI-JEV-02 §4): the committed AI-JEV-01 live
 * artifact reports `scoredQuestions: 0` while its rows recompute to 125, so
 * the repair must remain verifiable from rows alone.
 */
export function recomputeScoredQuestionsFromRows(
  rows: ReadonlyArray<{ expected: Record<string, boolean | null> }>,
  keys: ReadonlyArray<string>,
): number {
  return rows.reduce(
    (n, r) => n + keys.filter((k) => r.expected[k] !== null).length,
    0,
  );
}

/**
 * The regression guard (PROMPT-AI-JEV-02 §4): a report that contains scored
 * expectations may NEVER report `scoredQuestions: 0`. Returns a violation
 * description, or `null` when the accounting is consistent.
 */
export function scoredQuestionsAccountingDefect(
  report: {
    scoredQuestions: number;
    rows: ReadonlyArray<{ expected: Record<string, boolean | null> }>;
  },
  keys: ReadonlyArray<string>,
): string | null {
  const recomputed = recomputeScoredQuestionsFromRows(report.rows, keys);
  if (report.scoredQuestions !== recomputed) {
    return `scoredQuestions=${report.scoredQuestions} but rows recompute to ${recomputed}`;
  }
  if (recomputed > 0 && report.scoredQuestions === 0) {
    return `scoredQuestions is 0 while ${recomputed} expectations exist`;
  }
  return null;
}

function expectedOrientation(
  f: JevFixture,
  keys: ReadonlyArray<JevQuestionKey>,
): Record<string, boolean | null> {
  const out: Record<string, boolean | null> = {};
  for (const key of keys) out[key] = f.expected[key] ?? null;
  return out;
}

function percentiles(values: number[]): {
  min: number | null;
  p50: number | null;
  p95: number | null;
  max: number | null;
} {
  if (values.length === 0)
    return { min: null, p50: null, p95: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) =>
    sorted[
      Math.min(sorted.length - 1, Math.floor(p * sorted.length))
    ] as number;
  return {
    min: sorted[0] as number,
    p50: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1] as number,
  };
}

function unique(values: Array<string | null>): string[] {
  return [...new Set(values.filter((v): v is string => v !== null))];
}

// ── Entry point ──────────────────────────────────────────────────────────────
// Guarded so the exported accounting helpers can be imported by the offline
// check (`check:jev-eval`) WITHOUT executing a benchmark run.
const isMainModule =
  import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMainModule) {
  main().catch((error: Error) => {
    console.error(`benchmark crashed: ${error.message}`);
    console.error(error.stack ?? "");
    process.exit(1);
  });
}
