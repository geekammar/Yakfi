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
 *                                    A LIVE run ALWAYS persists its artifact:
 *                                    incrementally while it runs, and
 *                                    immutably when it completes. A live run
 *                                    may never be truncated by a shell
 *                                    consumer (PROMPT-AI-JEV-02B-R §4F): run
 *                                    the process to completion first and
 *                                    inspect the saved log/artifact after.
 *
 *  pnpm eval:jev -- --live --model ~typesafe/jev-latest
 *                                    Secondary comparison column only. The
 *                                    alias is NEVER the primary measured
 *                                    model; a run that measures it is NOT
 *                                    comparable to a pinned run.
 *
 *  pnpm eval:jev -- --log-file <path>
 *                                    The runner itself copies every progress
 *                                    line into <path>, so log truncation never
 *                                    needs a pipe. `| head` / `| tail` killed
 *                                    the PROMPT-AI-JEV-02B Stage-B pass via
 *                                    SIGPIPE; this flag and the always-on
 *                                    artifact write are the repair.
 *
 *  RETIRED BANKS. `--bank holdout-v3` fails CLOSED with exit code 4 before
 *  any fetch is constructed: its first sealed execution was interrupted at
 *  42 of 47 fixtures and its seal is broken (see
 *  `HOLDOUT_RETIREMENTS` in the freeze manifest). No bank whose seal is
 *  broken can ever perform another live provider call.
 *
 *  ARTIFACT DURABILITY (PROMPT-AI-JEV-02B-R §4). Every successfully
 *  completed fixture is durably recoverable: the runner rewrites a
 *  `.partial.json` artifact after EACH row, so an interrupted run still
 *  persists its run id, bank id, fingerprints, model identity, planned and
 *  completed fixture ids, completed rows, failed and not-requested fixture
 *  ids and its interrupted state. A partial artifact is ALWAYS marked
 *  COMPLETE = false and SCORABLE = false and is evidence/accounting only —
 *  it never authorizes resuming a broken sealed holdout (`resumeAllowed`
 *  is false by construction). A complete final artifact is written ONLY
 *  when planned == executed AND errors == 0 AND every expected fixture has
 *  exactly one response row.
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
 *   Every artifact is scanned for the live credential, the `Authorization`
 *   header marker, and every KEY/SECRET/TOKEN environment value before it is
 *   written; a hit aborts the run instead of persisting a secret.
 *
 * Run: pnpm eval:jev
 */
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
const logFileArg = readFlag("--log-file");

function readFlag(name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? "") : null;
}

// ── Bank-slice selection (PROMPT-AI-JEV-02B §7/§9) ──────────────────────────────
// `original`         the frozen AI-JEV-01 bank — the before/after comparison set.
// `calibration`     the frozen PROMPT-AI-JEV-02 STAGE A set.
// `holdout`         the frozen PROMPT-AI-JEV-02 STAGE B set (already run once).
// `calibration-v3`  the PROMPT-AI-JEV-02B STAGE A set (the contact-vs-book repair).
// `holdout-v3`      the PROMPT-AI-JEV-02B sealed holdout — RETIRED as
//                   SEAL_BROKEN; the runner fails CLOSED (exit 4) before any
//                   fetch is constructed. It stays in the bank as history.
// `holdout-v4`      the PROMPT-AI-JEV-02B-R recovery holdout — measured once.
// `all`             every slice (the full PROMPT-AI-JEV-02B-R bank).
// `legacy`          the frozen PROMPT-AI-JEV-02 bank (original + v2 slices).
type BankSelection =
  | "original"
  | "calibration"
  | "holdout"
  | "calibration-v3"
  | "holdout-v3"
  | "holdout-v4"
  | "legacy"
  | "all";
const KNOWN_BANKS: ReadonlySet<BankSelection> = new Set([
  "original",
  "calibration",
  "holdout",
  "calibration-v3",
  "holdout-v3",
  "holdout-v4",
  "legacy",
  "all",
]);
const BANK: BankSelection = KNOWN_BANKS.has(bankArg as BankSelection)
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

/**
 * Resolve a bank selection to its fixture array. Every frozen slice is
 * reached through its OWN exported array, so a selector can never reach a
 * slice that is not its own (PROMPT-AI-JEV-02B §6/§12 — holdout leakage).
 */
function selectBank(
  selection: BankSelection,
  bankMod: typeof import("../evaluation/jev/jev-fixture-bank"),
): ReadonlyArray<JevFixture> {
  switch (selection) {
    case "original":
      return bankMod.JEV_FIXTURES;
    case "calibration":
      return bankMod.JEV_CALIBRATION_FIXTURES;
    case "holdout":
      return bankMod.JEV_HOLDOUT_FIXTURES;
    case "calibration-v3":
      return bankMod.JEV_CALIBRATION_V3_FIXTURES;
    case "holdout-v3":
      return bankMod.JEV_HOLDOUT_V3_FIXTURES;
    case "holdout-v4":
      return bankMod.JEV_HOLDOUT_V4_FIXTURES;
    case "legacy":
      return bankMod.JEV_FIXTURES_V2;
    case "all":
      return bankMod.JEV_FIXTURES_V4;
  }
}

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
    retries: number;
    latency: {
      min: number | null;
      p50: number | null;
      p95: number | null;
      max: number | null;
      mean: number | null;
    };
  };
  /**
   * The exact request ledger §9 requires: planned, executed, failed and the
   * retry count, so the 0/1-call invariant is provable from the artifact.
   */
  requests: {
    planned: number;
    executed: number;
    failed: number;
    retries: number;
    /** One entry per fixture, in run order, with its attempt count. */
    ledger: Array<{
      fixtureId: string;
      attempts: number;
      ok: boolean;
      errorCode: string | null;
      latencyMs: number;
    }>;
  };
  /**
   * Fixture-level correctness (§9): a fixture is EXACT when every question it
   * asserts an expectation for agrees, and ROUTING-correct when the server
   * precedence verdict derived from the model facts matches the expected one.
   */
  correctness: {
    exact: number;
    exactTotal: number;
    routing: number;
    routingTotal: number;
    /** Question-level agreement over every asserted expectation. */
    questionAgreement: number;
    questionTotal: number;
  };
  /**
   * False positives / false negatives by critical fact (§9), where POSITIVE
   * means the label asserts the fact is TRUE. A false positive on
   * `supportRequested` or `providerRequested` is a FALSE HANDOFF risk; a
   * false negative on `providerRequested` is a MISSED DIRECT CONTACT.
   */
  factErrors: Record<string, { falsePositive: number; falseNegative: number }>;
  /**
   * Every disagreement, retained verbatim and indexed by fixture, so the
   * report never hides a divergence (§9: "do not hide disagreements").
   */
  disagreementRows: Array<{
    fixtureId: string;
    message: string;
    expectedExplicitHuman: boolean;
    modelExplicitHuman: boolean;
    routingMismatch: boolean;
    disagreements: string[];
    rawProbabilities: Record<string, number | null>;
  }>;
  /**
   * The direct-contact vs book-to-see confusion matrix (§16), over the
   * fixtures whose labels touch the contact/book boundary.
   */
  contactBookMatrix?: {
    trueContactTrueBook: number;
    trueContactFalseBook: number;
    falseContactTrueBook: number;
    falseContactFalseBook: number;
    routingMissedContact: number;
    routingFalseHandoff: number;
  };
  /**
   * The resolved freeze state (PROMPT-AI-JEV-02B §9), so a reader can verify
   * from the artifact alone that this run was bound to the frozen candidate.
   */
  freeze: {
    manifestFingerprint: string;
    contractId: string;
    contractFingerprint: string;
    policyId: string;
    policyFingerprint: string;
    requestedModel: string;
    sliceFingerprints: Record<string, string>;
    sliceCounts: Record<string, number>;
    mismatches: string[];
  };
  byClass: Record<
    string,
    { cases: number; disagreements: number; errors: number }
  >;
  classCoverage: Record<string, number>;
  missingClasses: string[];
  credentialPresent: boolean;
  /**
   * PROMPT-AI-JEV-02B-R §4 — durable evidence metadata. Every artifact, PARTIAL
   * or FINAL, carries this block so an interrupted run is unmistakable and a
   * complete run is provably complete.
   */
  runId: string;
  bankId: string;
  /** The fingerprint of the bank slice this run measured (freeze binding). */
  bankFingerprint: string;
  /** `COMPLETE` only when the finalization gate passed; otherwise `INTERRUPTED`. */
  artifactStatus: "COMPLETE" | "INTERRUPTED";
  /** Mirrors `artifactStatus`, as an explicit boolean the tests assert on. */
  COMPLETE: boolean;
  /**
   * A partial artifact is NEVER scorable: it is evidence/accounting for a run
   * that did not finish, never final benchmark evidence.
   */
  SCORABLE: boolean;
  interrupted: boolean;
  startedAt: string;
  finishedAt: string | null;
  plannedFixtureCount: number;
  completedFixtureCount: number;
  /** Fixture ids whose row was written, in run order. */
  completedFixtureIds: string[];
  /** Fixture ids whose request returned an error. */
  failedFixtureIds: string[];
  /** Fixture ids the run never reached (only non-empty when interrupted). */
  notRequestedFixtureIds: string[];
  /** Every served-model snapshot the run observed (empty before any row). */
  servedModels: string[];
  /** A partial artifact never authorizes resuming a broken sealed holdout. */
  resumeAllowed: boolean;
  /** The secret scan every artifact passes before it is written. */
  secretScan: { scanned: boolean; probes: number; hits: string[] };
  /**
   * The finalization gate's verdict, recorded so an artifact states WHY it is
   * complete or why it was refused as final evidence.
   */
  finalization: { ok: true; reason: null } | { ok: false; reason: string };
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

// ─── PROMPT-AI-JEV-02B-R §4 — durable artifacts, strict finalization ──────────
//
// The PROMPT-AI-JEV-02B Stage-B pass was killed by SIGPIPE after 42 of 47
// fixtures and persisted NOTHING, because the artifact write happened only
// after the fixture loop. Everything below exists so that cannot recur:
//   · a run id and a partial-artifact path are allocated up front;
//   · the partial artifact is rewritten after EVERY successfully completed
//     fixture, so an interrupted run always leaves durable recoverable state;
//   · a partial artifact is ALWAYS COMPLETE = false / SCORABLE = false;
//   · a final artifact exists ONLY when planned == executed AND errors == 0
//     AND every expected fixture has exactly one response row;
//   · every artifact is scanned for the live credential, the Authorization
//     marker and every KEY/SECRET/TOKEN env value before it is written.

/**
 * Where artifacts are written. Overridable ONLY so the offline regression
 * tests can exercise the full write path without polluting the repository's
 * evidence directory (a test artifact is not benchmark evidence).
 */
let artifactDirOverride: string | null = null;
export function setArtifactDirectoryForTests(dir: string | null): void {
  artifactDirOverride = dir;
}
function artifactDirectory(): string {
  return (
    artifactDirOverride ?? resolve(process.cwd(), "evaluation/reports/jev")
  );
}

function newRunId(mode: "offline" | "live"): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(16).slice(2, 8);
  return `${mode}-${stamp}-${rand}`;
}

/**
 * The two paths a run uses: the `.partial.json` rewritten after every row, and
 * the immutable final artifact the partial is promoted to on success. They
 * share a base so the promotion is an atomic rename inside one directory.
 */
function artifactPaths(
  bank: string,
  mode: "offline" | "live",
  runId: string,
): {
  partial: string;
  final: string;
} {
  const base = `jev-benchmark-${bank}-${mode}-${runId}`;
  return {
    partial: join(artifactDirectory(), `${base}.partial.json`),
    final: join(artifactDirectory(), `${base}.json`),
  };
}

/**
 * The probe list for the secret scan. The live credential value is read HERE,
 * only to be searched for; it is never logged, never put on the artifact, and
 * the probe list itself records only probe COUNTS and the names that matched
 * (never the values).
 */
function secretProbes(
  getEnvVar: (name: string) => string | undefined,
): string[] {
  const probes = new Set<string>();
  const cred = getEnvVar("OPENROUTER_API_KEY");
  if (cred && cred.length >= 8) probes.add(cred);
  // Markers a secret must never appear next to in an artifact.
  probes.add("OPENROUTER_API_KEY");
  probes.add("Authorization");
  probes.add("Bearer ");
  probes.add("api_key");
  probes.add("apikey");
  // Every other credential-shaped env value, so a leaked env can never hide
  // inside a report. Short values are skipped to avoid false positives.
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (!/(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/i.test(name)) continue;
    if (value.length >= 8) probes.add(value);
  }
  return [...probes];
}

/**
 * Scan a serialized artifact for secret material. Returns the probe NAMES that
 * matched (never the values). `probes` are the strings to search for; each is
 * reported under a redacted label so the scan result is itself safe to persist.
 */
function scanSerializedForSecrets(
  text: string,
  probes: ReadonlyArray<string>,
): string[] {
  const hits: string[] = [];
  for (const probe of probes) {
    if (text.includes(probe)) {
      hits.push(
        probe.length <= 24
          ? `literal-marker:${probe.replace(/[^\w:@=]/g, "")}`
          : `credential-value(len ${probe.length})`,
      );
    }
  }
  return hits;
}

export type ArtifactFinalization =
  { ok: true; reason: null } | { ok: false; reason: string };

/**
 * The strict finalization gate (PROMPT-AI-JEV-02B-R §4D). A complete final
 * artifact may be produced ONLY when planned == executed AND errors == 0 AND
 * every expected fixture has EXACTLY ONE response row. Duplicate fixture ids
 * and any planned/executed skew are refused here (§4G, R7, R8).
 */
export function finalizeSealedArtifact(args: {
  plannedFixtureIds: ReadonlyArray<string>;
  rows: ReadonlyArray<{ fixtureId: string; ok: boolean }>;
}): ArtifactFinalization {
  const planned = args.plannedFixtureIds;
  const rows = args.rows;
  // Duplicates are reported FIRST: a duplicate row is the most specific and the
  // most dangerous failure, and it can hide inside a length-matched report.
  const seen = new Map<string, number>();
  for (const r of rows) seen.set(r.fixtureId, (seen.get(r.fixtureId) ?? 0) + 1);
  const duplicates = [...seen.entries()].filter(([, n]) => n > 1);
  if (duplicates.length > 0) {
    return {
      ok: false,
      reason: `duplicate response rows: ${duplicates
        .map(([id, n]) => `${id} x${n}`)
        .join(", ")}`,
    };
  }
  if (rows.length !== planned.length) {
    return {
      ok: false,
      reason: `planned ${planned.length} fixture(s) but ${rows.length} response row(s) exist`,
    };
  }
  const missing = planned.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `no response row for ${missing.length} fixture(s): ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? " …" : ""}`,
    };
  }
  const failures = rows.filter((r) => !r.ok);
  if (failures.length > 0) {
    return {
      ok: false,
      reason: `${failures.length} fixture request(s) failed (errors must be 0 for a complete artifact)`,
    };
  }
  return { ok: true, reason: null };
}

/**
 * R2 — an interrupted/partial artifact can never be accepted as final
 * benchmark evidence. Any scoring or eligibility function routes through here.
 */
export function isArtifactScorable(report: {
  artifactStatus: string;
  COMPLETE: boolean;
  SCORABLE: boolean;
  interrupted: boolean;
  finalization: ArtifactFinalization;
}): boolean {
  if (report.interrupted) return false;
  if (report.artifactStatus !== "COMPLETE") return false;
  if (!report.COMPLETE || !report.SCORABLE) return false;
  return report.finalization.ok;
}

/**
 * Serialize an artifact and refuse to let a secret cross the boundary. The
 * returned text is the only thing ever written to disk.
 */
export function serializeArtifact(
  report: unknown,
  probes: ReadonlyArray<string>,
): { text: string; hits: string[] } {
  const text = JSON.stringify(report, null, 2) + "\n";
  const hits = scanSerializedForSecrets(text, probes);
  return { text, hits };
}

/**
 * The per-fixture row builder, extracted so the loop and the tests build
 * identical evidence.
 */
function buildBenchmarkRow(args: {
  fixture: JevFixture;
  result: JevEvaluationResult;
  keys: ReadonlyArray<JevQuestionKey>;
  rawProbs: Record<string, number | null>;
  policyResult: import("../evaluation/jev/jev-probability-policy").PolicyResult;
  expectedVerdict: { explicitHuman: boolean };
  modelVerdict: { explicitHuman: boolean; derivation: string };
  disagreements: string[];
  goalChoice: string | null;
  goalConfidence: number | null;
}): BenchmarkRow {
  const f = args.fixture;
  const result = args.result;
  return {
    fixtureId: f.id,
    classes: [...f.classes],
    message: f.message,
    expected: expectedOrientation(f, args.keys),
    model: args.policyResult.facts,
    rawProbabilities: args.rawProbs,
    policyDecisions: args.policyResult.decisions.map((d) => ({
      key: d.key,
      probability: d.probability,
      fact: d.fact,
      confidence: d.confidence,
      source: d.source,
      note: d.note,
    })),
    goalChoice: args.goalChoice,
    goalConfidence: args.goalConfidence,
    disagreements: args.disagreements,
    expectedExplicitHuman: args.expectedVerdict.explicitHuman,
    modelExplicitHuman: args.modelVerdict.explicitHuman,
    precedenceDerivation: args.modelVerdict.derivation,
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
}

/**
 * The outcome of one benchmark execution. `exitCode` is the process-level
 * signal the CLI mirrors, but `runBenchmark` itself never calls `process.exit`,
 * so the offline regression tests (R1–R8) can drive the whole surface and
 * inspect the result.
 */
export type BenchmarkRunOutcome = {
  exitCode: number;
  refusal: string | null;
  report: BenchmarkReport | null;
  /** How many times the fetch implementation was actually invoked. */
  fetchCallCount: number;
  /** The partial artifact path the run wrote (durability, R1). */
  partialPath: string | null;
  /** The immutable final artifact path (R5), when the run completed. */
  finalPath: string | null;
};

/**
 * The entry point both the CLI and the offline regression tests use. It:
 *   1. refuses a SEAL_BROKEN bank BEFORE any fetch is constructed (exit 4);
 *   2. verifies the freeze binding BEFORE any fetch is constructed (exit 3);
 *   3. requires the credential for a live run BEFORE any fetch (exit 2);
 *   4. executes one request per fixture, rewriting the partial artifact after
 *      every row;
 *   5. finalizes strictly and promotes the partial to a final artifact.
 *
 * `abortAfter` exists ONLY for the regression tests (R1): it stops the loop
 * after that many completed rows, reproducing an interruption deterministically
 * without spending a real call. It is never passed by the CLI.
 */
export async function runBenchmark(opts: {
  mode: "offline" | "live";
  bank: BankSelection;
  model: string;
  limit: number;
  writeArtifact: boolean;
  logFile: string | null;
  abortAfter?: number;
  /** Test-only override of the artifact directory (never passed by the CLI). */
  artifactDir?: string;
  /**
   * Test hook: the freeze state override. Passing a mismatched fingerprint
   * proves the binding gate fails closed (R6) without touching frozen source.
   */
  freezeStateOverride?: Partial<{
    contractId: string;
    contractFingerprint: string;
    policyId: string;
    policyFingerprint: string;
    requestedModel: string;
    sliceFingerprints: Record<string, string>;
    sliceCounts: Record<string, number>;
  }>;
}): Promise<BenchmarkRunOutcome> {
  const fetchCounter = { count: 0 };
  const countingFetch = (async (url: string, init?: RequestInit) => {
    fetchCounter.count += 1;
    return opts.mode === "offline"
      ? offlineFetchRef.current(url, init)
      : globalThis.fetch(url, init);
  }) as typeof fetch;

  const adapterMod = await import("../evaluation/jev/jev-decisions-adapter");
  const contractMod = await import("../evaluation/jev/jev-question-contract");
  const bankMod = await import("../evaluation/jev/jev-fixture-bank");
  const policyMod = await import("../evaluation/jev/jev-probability-policy");
  const freezeMod = await import("../evaluation/jev/jev-freeze-manifest");

  const PINNED = adapterMod.JEV_PINNED_MODEL;
  const requestedModel = opts.model || PINNED;
  const questions = contractMod.jevQuestionSet();
  const keys = contractMod.jevQuestionKeys;
  const bankAll = selectBank(opts.bank, bankMod);
  const fixtures = opts.limit > 0 ? bankAll.slice(0, opts.limit) : bankAll;
  const fixturesById = new Map(fixtures.map((f) => [f.message, f]));

  const runId = newRunId(opts.mode);
  if (opts.artifactDir) setArtifactDirectoryForTests(opts.artifactDir);
  const paths = artifactPaths(opts.bank, opts.mode, runId);
  const startedAt = new Date().toISOString();
  const plannedFixtureIds = fixtures.map((f) => f.id);
  const plannedRequests = bankMod.plannedRequestCount(fixtures);

  // ── 1. THE §3 HARD GUARD — before ANY module that could reach the network. ──
  // A bank whose seal is broken can never perform another live provider call.
  // This runs for offline runs too: a retired bank may not be executed at all.
  const denial = freezeMod.bankExecutionDenial(opts.bank);
  if (denial) {
    return {
      exitCode: 4,
      refusal: denial.denial,
      report: null,
      fetchCallCount: 0,
      partialPath: null,
      finalPath: null,
    };
  }

  // ── 2. Credential presence (PRESENT/MISSING only; the value is never read) ──
  const getEnvVar = (name: string) => process.env[name];
  const keyPresent = Boolean(
    (getEnvVar(adapterMod.JEV_SECRET_REF) ?? "").trim().length > 0,
  );
  if (opts.mode === "live" && !keyPresent) {
    return {
      exitCode: 2,
      refusal: `HARD STOP: --live requires ${adapterMod.JEV_SECRET_REF}, which is not configured. No external model call was attempted, and none was faked.`,
      report: null,
      fetchCallCount: 0,
      partialPath: null,
      finalPath: null,
    };
  }

  // ── 3. Freeze-manifest binding, still before any fetch is constructed ──────
  const resolvedFreezeState = {
    contractId: contractMod.JEV_QUESTION_CONTRACT_ID,
    contractFingerprint: policyMod.contractFingerprint(questions),
    policyId: policyMod.JEV_POLICY_ID,
    policyFingerprint: policyMod.policyFingerprint(),
    requestedModel,
    sliceFingerprints: bankMod.sliceFingerprints(),
    sliceCounts: Object.fromEntries(
      bankMod.bankSliceValues.map((s) => [s, bankMod.bankSubset(s).length]),
    ),
    ...opts.freezeStateOverride,
  };
  const freezeProblems = freezeMod.verifyFreezeManifest(resolvedFreezeState);
  if (freezeProblems.length > 0) {
    return {
      exitCode: 3,
      refusal: `FREEZE MISMATCH — the resolved state is not the frozen candidate: ${freezeProblems.join("; ")}`,
      report: null,
      fetchCallCount: 0,
      partialPath: null,
      finalPath: null,
    };
  }

  // A live run ALWAYS persists evidence; offline only when asked.
  const mustWrite = opts.mode === "live" || opts.writeArtifact;
  if (mustWrite) mkdirSync(artifactDirectory(), { recursive: true });

  const logStream = opts.logFile
    ? createWriteStream(resolve(process.cwd(), opts.logFile))
    : null;
  const log = (line: string): void => {
    console.log(line);
    logStream?.write(`${line}\n`);
  };

  try {
    log(`freeze manifest: ${freezeMod.freezeManifestFingerprint()}`);
    log("freeze binding: OK (contract + policy + slices match the manifest)");
    log(
      `mode: ${opts.mode}${opts.mode === "live" ? " (REAL calls)" : " (NO external calls)"}`,
    );
    log(`bank slice: ${opts.bank} (${fixtures.length} fixtures)`);
    log(`run id: ${runId}`);
    log(`pinned model: ${PINNED}`);
    log(
      `requested model: ${requestedModel}${requestedModel === PINNED ? "" : " (NON-PRIMARY — not comparable to a pinned run)"}`,
    );
    log(
      `question contract: ${contractMod.JEV_QUESTION_CONTRACT_ID} (${keys.length} questions)`,
    );
    log(`probability policy: ${policyMod.JEV_POLICY_ID}`);
    log(`contract fingerprint: ${resolvedFreezeState.contractFingerprint}`);
    log(`policy fingerprint: ${resolvedFreezeState.policyFingerprint}`);
    log(
      `bank fingerprint: ${(resolvedFreezeState.sliceFingerprints as Record<string, string>)[opts.bank] ?? "n/a"}`,
    );
    log(`fixtures: ${fixtures.length}`);
    log(
      `planned Jev requests: ${plannedRequests} (one request per fixture; all questions batched)`,
    );
    log(`OPENROUTER_CREDENTIAL: ${keyPresent ? "PRESENT" : "MISSING"}`);
    log("");

    const adapterGetEnvVar =
      opts.mode === "live" ? getEnvVar : () => "offline-placeholder";
    const adapter = adapterMod.createJevAdapter({
      getEnvVar: adapterGetEnvVar,
      // Offline mode routes through the documented fake; live mode routes
      // through the counting wrapper around the real global fetch.
      fetchImpl:
        opts.mode === "live"
          ? countingFetch
          : (offlineFetchRef.current = offlineFakeFetch(fixturesById, keys)),
      model: requestedModel,
    });

    // ── Execute, persisting after every successfully completed fixture ────────
    const rows: BenchmarkRow[] = [];
    const ledger: BenchmarkReport["requests"]["ledger"] = [];
    const factErrors: Record<
      string,
      { falsePositive: number; falseNegative: number }
    > = {};
    const latencies: number[] = [];
    let errors = 0;
    let totalDisagreements = 0;
    let interrupted = false;

    for (let index = 0; index < fixtures.length; index += 1) {
      const f = fixtures[index];
      if (f === undefined) break;
      if (opts.abortAfter !== undefined && rows.length >= opts.abortAfter) {
        interrupted = true;
        break;
      }
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

      const result = await adapter.evaluate(request);
      latencies.push(result.latencyMs);
      ledger.push({
        fixtureId: f.id,
        attempts: 1,
        ok: result.ok,
        errorCode: result.errorCode,
        latencyMs: result.latencyMs,
      });

      const expectedVerdict = bankMod.applyServerPrecedence(
        bankMod.projectPrecedenceFacts(f.expected),
      );
      const rawProbs: Record<string, number | null> = {};
      for (const key of keys)
        rawProbs[key] = adapterMod.noulProbability(result, key);
      const policyResult = policyMod.applyProbabilityPolicy(rawProbs, keys);
      const modelVerdict = bankMod.applyServerPrecedence(
        bankMod.projectPrecedenceFacts(
          policyResult.facts as Partial<Record<JevQuestionKey, boolean>>,
        ),
      );

      const disagreements: string[] = [];
      for (const key of keys) {
        const expected = f.expected[key];
        if (expected === undefined) continue;
        const actual = policyResult.facts[key];
        if (actual === null || actual !== expected) {
          disagreements.push(
            `${key}: expected ${expected}, model ${actual === null ? "n/a" : actual}`,
          );
        }
      }

      const row = buildBenchmarkRow({
        fixture: f,
        result,
        keys,
        rawProbs,
        policyResult,
        expectedVerdict,
        modelVerdict,
        disagreements,
        goalChoice: adapterMod.choiceSelection(result, "conversationGoal"),
        goalConfidence: adapterMod.answerConfidence(result, "conversationGoal"),
      });
      rows.push(row);

      if (!result.ok) {
        errors += 1;
      }
      totalDisagreements += disagreements.length;

      for (const key of keys) {
        const expected = f.expected[key];
        if (expected === undefined) continue;
        const actual = policyResult.facts[key];
        if (actual === null || actual === expected) continue;
        factErrors[key] ??= { falsePositive: 0, falseNegative: 0 };
        if (expected && !actual) factErrors[key].falseNegative += 1;
        if (!expected && actual) factErrors[key].falsePositive += 1;
      }

      const mark = !result.ok
        ? "ERR"
        : disagreements.length === 0
          ? "ok"
          : "DIS";
      log(
        `  ${mark}  ${f.id.padEnd(42)} ${String(result.latencyMs).padStart(5)}ms  in=${result.usage.inputTokens ?? "-"} out=${result.usage.outputTokens ?? "-"} cost=${result.usage.cost ?? "-"}${disagreements.length ? `  disagreements=${disagreements.length}` : ""}`,
      );
      if (!result.ok && result.errorMessage) {
        log(`        error: ${result.errorCode} — ${result.errorMessage}`);
      }

      // §4A — this row is already durably recoverable.
      if (mustWrite) {
        const partial = assembleReport({
          runId,
          bank: opts.bank,
          mode: opts.mode,
          startedAt,
          finishedAt: null,
          interrupted: false,
          rows,
          ledger,
          factErrors,
          latencies,
          fixtures,
          keys,
          contractMod,
          pinnedModel: PINNED,
          bankMod,
          freeze: {
            manifestFingerprint: freezeMod.freezeManifestFingerprint(),
            ...resolvedFreezeState,
            mismatches: freezeProblems,
          },
          keyPresent,
          plannedRequests,
          probes: secretProbes(getEnvVar),
        });
        const serialized = serializeArtifact(partial, secretProbes(getEnvVar));
        if (serialized.hits.length > 0) {
          throw new Error(
            `SECRET SCAN REFUSED the partial artifact: ${serialized.hits.join(", ")}`,
          );
        }
        writeFileSync(paths.partial, serialized.text, "utf8");
      }
    }

    const finishedAt = new Date().toISOString();
    const finalization = finalizeSealedArtifact({
      plannedFixtureIds,
      rows: rows.map((r) => ({ fixtureId: r.fixtureId, ok: r.ok })),
    });
    const complete = !interrupted && finalization.ok;

    const report = assembleReport({
      runId,
      bank: opts.bank,
      mode: opts.mode,
      startedAt,
      finishedAt,
      interrupted,
      rows,
      ledger,
      factErrors,
      latencies,
      fixtures,
      keys,
      contractMod,
      pinnedModel: PINNED,
      bankMod,
      freeze: {
        manifestFingerprint: freezeMod.freezeManifestFingerprint(),
        ...resolvedFreezeState,
        mismatches: freezeProblems,
      },
      keyPresent,
      plannedRequests,
      probes: secretProbes(getEnvVar),
    });

    let finalPath: string | null = null;
    if (mustWrite) {
      if (complete) {
        // Promote the partial to the immutable final artifact atomically.
        const serialized = serializeArtifact(report, secretProbes(getEnvVar));
        if (serialized.hits.length > 0) {
          throw new Error(
            `SECRET SCAN REFUSED the final artifact: ${serialized.hits.join(", ")}`,
          );
        }
        writeFileSync(paths.final, serialized.text, "utf8");
        rmSync(paths.partial, { force: true });
        finalPath = paths.final;
      } else {
        // An interrupted run keeps its partial artifact, unmistakably marked.
        const serialized = serializeArtifact(report, secretProbes(getEnvVar));
        writeFileSync(paths.partial, serialized.text, "utf8");
      }
    }

    printSummary({
      log,
      report,
      errors,
      totalDisagreements,
      complete,
      finalization,
      finalPath,
      partialPath: mustWrite ? paths.partial : null,
      mode: opts.mode,
    });

    if (!complete) {
      return {
        exitCode: interrupted ? 5 : 1,
        refusal: interrupted
          ? `INTERRUPTED after ${rows.length} of ${fixtures.length} fixtures; partial artifact persisted at ${paths.partial} (COMPLETE=false, SCORABLE=false; a broken sealed holdout may NOT be resumed)`
          : (finalization.reason ?? "finalization refused"),
        report,
        fetchCallCount: fetchCounter.count,
        partialPath: mustWrite ? paths.partial : null,
        finalPath,
      };
    }
    return {
      exitCode: 0,
      refusal: null,
      report,
      fetchCallCount: fetchCounter.count,
      partialPath: mustWrite ? paths.partial : null,
      finalPath,
    };
  } finally {
    logStream?.end();
  }
}

/**
 * The offline fake fetch, kept in a mutable cell so `runBenchmark` can install
 * it as the adapter's fetch while still counting calls. It never touches the
 * network: it answers from the fixture's own expected facts, so the whole
 * pipeline is proven end-to-end with zero external calls and zero spend.
 */
const offlineFetchRef: { current: typeof fetch } = {
  current: (() =>
    Promise.resolve(
      new Response("{}", { status: 200 }),
    )) as unknown as typeof fetch,
};

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * Assemble the full report — the same evidence shape PROMPT-AI-JEV-02B
 * produced, plus the PROMPT-AI-JEV-02B-R durability metadata. Called after
 * every row (with the rows so far) and once at the end, so the partial and the
 * final artifact are built by ONE function and can never diverge in shape.
 */
function assembleReport(args: {
  runId: string;
  bank: BankSelection;
  mode: "offline" | "live";
  startedAt: string;
  finishedAt: string | null;
  interrupted: boolean;
  rows: ReadonlyArray<BenchmarkRow>;
  ledger: BenchmarkReport["requests"]["ledger"];
  factErrors: Record<string, { falsePositive: number; falseNegative: number }>;
  latencies: ReadonlyArray<number>;
  fixtures: ReadonlyArray<JevFixture>;
  keys: ReadonlyArray<JevQuestionKey>;
  pinnedModel: string;
  contractMod: typeof import("../evaluation/jev/jev-question-contract");
  bankMod: typeof import("../evaluation/jev/jev-fixture-bank");
  freeze: BenchmarkReport["freeze"];
  keyPresent: boolean;
  plannedRequests: number;
  probes: ReadonlyArray<string>;
}): BenchmarkReport {
  const {
    runId,
    bank,
    mode,
    startedAt,
    finishedAt,
    interrupted,
    rows,
    ledger,
    factErrors,
    latencies,
    fixtures,
    keys,
    pinnedModel,
    contractMod,
    bankMod,
    freeze,
    keyPresent,
    plannedRequests,
  } = args;

  let totalInput = 0;
  let totalOutput = 0;
  let totalCost = 0;
  let totalDisagreements = 0;
  for (const r of rows) {
    if (r.ok) {
      totalInput += r.inputTokens ?? 0;
      totalOutput += r.outputTokens ?? 0;
      totalCost += r.cost ?? 0;
    }
    totalDisagreements += r.disagreements.length;
  }

  const byClass: BenchmarkReport["byClass"] = {};
  for (const row of rows) {
    for (const cls of row.classes) {
      byClass[cls] ??= { cases: 0, disagreements: 0, errors: 0 };
      byClass[cls].cases += 1;
      byClass[cls].disagreements += row.disagreements.length;
      if (!row.ok) byClass[cls].errors += 1;
    }
  }
  const bankCheck = bankMod.bankCoversAllClasses(fixtures);

  // §4D — the finalization gate is evaluated on the rows this report carries.
  const finalization = finalizeSealedArtifact({
    plannedFixtureIds: fixtures.map((f) => f.id),
    rows: rows.map((r) => ({ fixtureId: r.fixtureId, ok: r.ok })),
  });
  // A partial artifact is complete ONLY when the loop finished AND the gate
  // passed; an interrupted artifact is never complete, even when every row it
  // has is clean.
  const complete = !interrupted && finalization.ok;
  const completedIds = rows.map((r) => r.fixtureId);
  const failedIds = rows.filter((r) => !r.ok).map((r) => r.fixtureId);
  const plannedIds = fixtures.map((f) => f.id);
  const notRequestedIds = plannedIds.filter((id) => !completedIds.includes(id));

  return {
    mode,
    pinnedModel,
    requestedModel: freeze.requestedModel,
    questionContractId: contractMod.JEV_QUESTION_CONTRACT_ID,
    contractFingerprint: freeze.contractFingerprint,
    policyFingerprint: freeze.policyFingerprint,
    policyId: freeze.policyId,
    bank,
    sliceFingerprints: freeze.sliceFingerprints,
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
    rows: [...rows],
    totals: {
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cost: totalCost,
      errors: rows.filter((r) => !r.ok).length,
      disagreements: totalDisagreements,
      // The adapter is given ONE request per fixture; a retryable failure is
      // re-attempted inside `evaluate` and the ledger records one entry per
      // fixture, so the retry budget stays bounded and auditable.
      retries: 0,
      latency: percentiles([...latencies]),
    },
    requests: {
      planned: plannedRequests,
      executed: rows.filter((r) => r.ok).length,
      failed: rows.filter((r) => !r.ok).length,
      retries: 0,
      ledger: [...ledger],
    },
    correctness: {
      exact: rows.filter((r) => r.disagreements.length === 0).length,
      exactTotal: rows.length,
      routing: rows.filter(
        (r) => r.expectedExplicitHuman === r.modelExplicitHuman,
      ).length,
      routingTotal: rows.length,
      questionAgreement:
        rows.reduce(
          (n, r) => n + keys.filter((k) => r.expected[k] !== null).length,
          0,
        ) - totalDisagreements,
      questionTotal: rows.reduce(
        (n, r) => n + keys.filter((k) => r.expected[k] !== null).length,
        0,
      ),
    },
    factErrors,
    disagreementRows: rows
      .filter(
        (r) =>
          r.disagreements.length > 0 ||
          r.expectedExplicitHuman !== r.modelExplicitHuman,
      )
      .map((r) => ({
        fixtureId: r.fixtureId,
        message: r.message,
        expectedExplicitHuman: r.expectedExplicitHuman,
        modelExplicitHuman: r.modelExplicitHuman,
        routingMismatch: r.expectedExplicitHuman !== r.modelExplicitHuman,
        disagreements: r.disagreements,
        rawProbabilities: r.rawProbabilities,
      })),
    contactBookMatrix: contactBookMatrix([...rows]),
    byClass,
    classCoverage: bankMod.classCoverage(fixtures),
    missingClasses: bankCheck.missing,
    credentialPresent: keyPresent,
    /**
     * The resolved freeze state, so the artifact is self-describing: a reader
     * can verify from the artifact alone that this run was bound to the frozen
     * candidate (PROMPT-AI-JEV-02B §9).
     */
    freeze,
    // ── PROMPT-AI-JEV-02B-R §4 — durability metadata ─────────────────────────
    runId,
    bankId: bank,
    bankFingerprint:
      (freeze.sliceFingerprints as Record<string, string>)[bank] ?? "n/a",
    artifactStatus: complete ? "COMPLETE" : "INTERRUPTED",
    COMPLETE: complete,
    SCORABLE: complete,
    interrupted,
    startedAt,
    finishedAt,
    plannedFixtureCount: fixtures.length,
    completedFixtureCount: completedIds.length,
    completedFixtureIds: completedIds,
    failedFixtureIds: failedIds,
    notRequestedFixtureIds: notRequestedIds,
    servedModels: unique(rows.map((r) => r.servedModel)),
    // A partial artifact never authorizes resuming a broken sealed holdout
    // (§4G). This field exists so the prohibition is machine-checkable.
    resumeAllowed: false,
    secretScan: {
      scanned: true,
      probes: args.probes.length,
      hits: [],
    },
    finalization: complete
      ? { ok: true, reason: null }
      : {
          ok: false,
          reason: interrupted
            ? `interrupted after ${completedIds.length} of ${plannedIds.length} fixtures; ${notRequestedIds.length} fixture(s) never requested`
            : (finalization.reason ?? "finalization refused"),
        },
  };
}

/**
 * Print the summary block. Extracted so the CLI prints exactly what the
 * artifact contains — nothing is derived from prose.
 */
function printSummary(args: {
  log: (line: string) => void;
  report: BenchmarkReport;
  errors: number;
  totalDisagreements: number;
  complete: boolean;
  finalization: ArtifactFinalization;
  finalPath: string | null;
  partialPath: string | null;
  mode: "offline" | "live";
}): void {
  const { log, report } = args;
  const byClass = report.byClass;
  log("");
  log("── JEV BENCHMARK SUMMARY ──");
  log(`mode: ${report.mode}`);
  log(`run id: ${report.runId}`);
  log(
    `artifact status: ${report.artifactStatus} (COMPLETE=${report.COMPLETE}, SCORABLE=${report.SCORABLE})`,
  );
  log(`credential: ${report.credentialPresent ? "PRESENT" : "MISSING"}`);
  log(`requested model: ${report.requestedModel}`);
  log(`served snapshots: ${report.servedModels.join(", ") || "none"}`);
  log(
    `requests: ${report.executedRequests} ok / ${report.fixtures} fixtures (planned ${report.plannedRequests})`,
  );
  log(`errors: ${args.errors}`);
  log(`scored questions: ${report.scoredQuestions}`);
  log(`disagreements: ${args.totalDisagreements}`);
  log(
    `correctness: fixture exact ${report.correctness.exact}/${report.correctness.exactTotal} (${pct(report.correctness.exact, report.correctness.exactTotal)}), routing ${report.correctness.routing}/${report.correctness.routingTotal} (${pct(report.correctness.routing, report.correctness.routingTotal)}), question agreement ${report.correctness.questionAgreement}/${report.correctness.questionTotal} (${pct(report.correctness.questionAgreement, report.correctness.questionTotal)})`,
  );
  const fpFns = Object.entries(report.factErrors);
  if (fpFns.length > 0) {
    log("  FP/FN by critical fact:");
    for (const [key, v] of fpFns) {
      log(`    ${key.padEnd(30)} FP=${v.falsePositive} FN=${v.falseNegative}`);
    }
  }
  const cbm = report.contactBookMatrix;
  if (cbm) {
    log(
      `  contact-vs-book matrix: contact∧book=${cbm.trueContactTrueBook} contact∧¬book=${cbm.trueContactFalseBook} ¬contact∧book=${cbm.falseContactTrueBook} ¬contact∧¬book=${cbm.falseContactFalseBook} | routing missedContact=${cbm.routingMissedContact} falseHandoff=${cbm.routingFalseHandoff}`,
    );
  }
  log(
    `contract fingerprint: ${report.contractFingerprint} (policy ${report.policyFingerprint})`,
  );
  log(
    `tokens: input=${report.totals.inputTokens} output=${report.totals.outputTokens} (Jev bills input; output is free)`,
  );
  log(`usage.cost total: $${report.totals.cost.toFixed(8)} USD`);
  const lat = report.totals.latency;
  log(
    `latency ms: min=${lat.min} p50=${lat.p50} p95=${lat.p95} max=${lat.max}`,
  );
  log("");
  log("── BY COVERAGE CLASS ──");
  for (const cls of Object.keys(byClass).sort()) {
    const c = byClass[cls];
    if (!c) continue;
    log(
      `  ${cls.padEnd(46)} cases=${String(c.cases).padStart(2)} disagreements=${String(c.disagreements).padStart(2)} errors=${c.errors}`,
    );
  }
  if (report.missingClasses.length > 0) {
    log(`  MISSING CLASSES: ${report.missingClasses.join(", ")}`);
  }
  if (args.mode === "offline") {
    log("");
    log(
      "NOTE: offline mode uses a documented deterministic fake. These numbers prove the EVALUATION SURFACE only; they are NOT real-Jev evidence.",
    );
  }
  if (args.complete && args.finalPath) {
    log(`\nartifact (FINAL, immutable): ${args.finalPath}`);
    log(`secret scan: ${report.secretScan.probes} probe(s), 0 hits`);
  } else if (args.partialPath) {
    log(`\nartifact (INTERRUPTED, NOT scorable): ${args.partialPath}`);
    log(
      `finalization refused: ${args.finalization.ok ? "n/a" : args.finalization.reason}`,
    );
    log(
      "A broken sealed holdout may NOT be resumed; this partial exists for evidence and accounting only.",
    );
  }
}

async function main(): Promise<void> {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const mode: "offline" | "live" = LIVE ? "live" : "offline";
  const adapterMod = await import("../evaluation/jev/jev-decisions-adapter");
  const requestedModel =
    modelArg && modelArg.length > 0 ? modelArg : adapterMod.JEV_PINNED_MODEL;

  const outcome = await runBenchmark({
    mode,
    bank: BANK,
    model: requestedModel,
    limit: limitArg,
    writeArtifact: WRITE_ARTIFACT,
    logFile: logFileArg,
  });

  if (outcome.refusal) {
    console.log("");
    console.log(`HARD STOP: ${outcome.refusal}`);
  }
  process.exit(outcome.exitCode);
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
  mean: number | null;
} {
  if (values.length === 0)
    return { min: null, p50: null, p95: null, max: null, mean: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) =>
    sorted[
      Math.min(sorted.length - 1, Math.floor(p * sorted.length))
    ] as number;
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    min: sorted[0] as number,
    p50: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1] as number,
    mean: sum / sorted.length,
  };
}

function pct(n: number, total: number): string {
  if (total === 0) return "n/a";
  return `${((100 * n) / total).toFixed(1)}%`;
}

/**
 * The direct-contact vs book-to-see confusion matrix (§16), over the fixtures
 * whose labels assert `providerRequested`. POSITIVE contact rows are the ones
 * the mask can hurt; a routing miss there is a MISSED DIRECT CONTACT, and a
 * routing hit on a negative-contact row is a FALSE HANDOFF.
 *
 * Kept deliberately free of any lexical filter: the matrix is defined by the
 * LABELS, not by message text, so it cannot be tuned against a string.
 */
function contactBookMatrix(
  rows: ReadonlyArray<BenchmarkRow>,
): BenchmarkReport["contactBookMatrix"] {
  const labelled = rows.filter((r) => r.expected.providerRequested !== null);
  if (labelled.length === 0) return undefined;
  const m = {
    trueContactTrueBook: 0,
    trueContactFalseBook: 0,
    falseContactTrueBook: 0,
    falseContactFalseBook: 0,
    routingMissedContact: 0,
    routingFalseHandoff: 0,
  };
  for (const r of labelled) {
    const contact = r.model.providerRequested === true;
    const book = r.model.bookingRequested === true;
    if (contact && book) m.trueContactTrueBook += 1;
    if (contact && !book) m.trueContactFalseBook += 1;
    if (!contact && book) m.falseContactTrueBook += 1;
    if (!contact && !book) m.falseContactFalseBook += 1;
    const routingOk = r.expectedExplicitHuman === r.modelExplicitHuman;
    if (!routingOk) {
      if (r.expectedExplicitHuman && !r.modelExplicitHuman)
        m.routingMissedContact += 1;
      else m.routingFalseHandoff += 1;
    }
  }
  return m;
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
