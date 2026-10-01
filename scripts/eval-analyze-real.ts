/**
 * FlowPilot AI Evaluation — REAL-LLM baseline analysis (PROMPT-AI-EVAL-04B).
 *
 * Measurement-only. Reads the real-LLM run + the EVAL-04 deterministic run +
 * the dataset, and emits the human/machine analysis artifacts. Changes NO
 * production behavior. Every number is traceable to caseIds in the run JSON.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type Rec = {
  caseId: string;
  scenarioId: string;
  expected: Record<string, unknown> & {
    primaryIntent: string;
    secondaryIntents: string[];
    handoffExpectation: string;
    safetyExpectation: string;
    currentIntent?: string;
    requiredKnowledge?: string;
    architecturalLimitation?: boolean;
  };
  actual: Record<string, unknown> & {
    intent?: string;
    action?: string;
    disclosure?: string;
    source?: string;
    malformed?: boolean;
    handoffOutcomeClass?: string;
    modelLatencyMs?: number | null;
    totalLatencyMs?: number | null;
    physicalAttempts?: number;
    providerErrorCode?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
  };
  verdict: string;
  failureCategory: string;
  scorers: Record<string, string>;
};

type Run = {
  run: { runId: string; datasetVersion: string; executedAt: string };
  system: Record<string, unknown>;
  metrics: {
    denominators: Record<
      string,
      { value: number; numerator: number; denominator: number }
    >;
    handoffOutcomeClasses: Record<string, number>;
    passCount: number;
    limitationCount: number;
    failCount: number;
    seamOwnedCount: number;
    scoredCases: number;
    totalCases: number;
    totalTurns: number;
  };
  caseResults: Rec[];
};

const ROOT = process.cwd();
const realRun: Run = JSON.parse(
  readFileSync(
    resolve(
      ROOT,
      "evaluation/reports/egyptian-v1/real-llm-baseline/evaluation-run.json",
    ),
    "utf8",
  ),
);
const detRun: Run = JSON.parse(
  readFileSync(
    resolve(
      ROOT,
      "evaluation/reports/egyptian-v1/baseline/evaluation-run.json",
    ),
    "utf8",
  ),
);
const dataset: {
  cases: Array<{
    caseId: string;
    scenarioId: string;
    orientation: string;
    conversationType: string;
    rarity: string;
    engineOwner: string;
    edgeCategories: string[];
    languageProfile: { register: string; noise: string[] };
    expectedSemanticLabel: {
      primaryIntent: string;
      secondaryIntents: string[];
    };
    expectedStateTransition?: { isRevision?: boolean } | null;
  }>;
} = JSON.parse(
  readFileSync(
    resolve(ROOT, "evaluation/datasets/egyptian-v1/egyptian-v1.dataset.json"),
    "utf8",
  ),
);

const caseById = new Map(dataset.cases.map((c) => [c.caseId, c]));
const detById = new Map(detRun.caseResults.map((r) => [r.caseId, r]));

const pct = (n: number, d: number): string =>
  `${d === 0 ? "0.0" : ((100 * n) / d).toFixed(1)}% (${n}/${d})`;

function handed(r: Rec): boolean {
  return (
    r.actual.action === "handoff" ||
    r.actual.action === "booking_handoff" ||
    r.actual.disclosure === "requires-human"
  );
}

// ── overall verdicts ────────────────────────────────────────────────────────
const scored = realRun.caseResults.filter((r) => r.verdict !== "SEAM_OWNED");
const headline = {
  totalCases: realRun.metrics.totalCases,
  totalTurns: realRun.metrics.totalTurns,
  scoredCases: realRun.metrics.scoredCases,
  seamOwned: realRun.metrics.seamOwnedCount,
  PASS: realRun.metrics.passCount,
  LIMITATION: realRun.metrics.limitationCount,
  FAIL: realRun.metrics.failCount,
  passRate: pct(realRun.metrics.passCount, realRun.metrics.scoredCases),
  limitationRate: pct(
    realRun.metrics.limitationCount,
    realRun.metrics.scoredCases,
  ),
  failRate: pct(realRun.metrics.failCount, realRun.metrics.scoredCases),
};

// ── metric comparison (real vs deterministic) ───────────────────────────────
const metricKeys = Object.keys(realRun.metrics.denominators);
const comparison: Record<
  string,
  { real: string; det: string; deltaPP: string }
> = {};
for (const k of metricKeys) {
  const r = realRun.metrics.denominators[k]!;
  const d = detRun.metrics.denominators[k];
  const rv = r.value * 100;
  const dv = (d?.value ?? 0) * 100;
  comparison[k] = {
    real: `${rv.toFixed(1)}% (${r.numerator}/${r.denominator})`,
    det: d ? `${dv.toFixed(1)}% (${d.numerator}/${d.denominator})` : "n/a",
    deltaPP: d
      ? `${(rv - dv >= 0 ? "+" : "") + (rv - dv).toFixed(1)}pp`
      : "n/a",
  };
}

// ── verdict-level improvement / regression vs det ────────────────────────────
const rank = (v: string) =>
  v === "PASS" ? 2 : v === "LIMITATION" || v === "SEAM_OWNED" ? 1 : 0;
let improved = 0;
let regressed = 0;
const improvedIds: string[] = [];
const regressedIds: string[] = [];
for (const r of realRun.caseResults) {
  const d = detById.get(r.caseId);
  if (!d) continue;
  const delta = rank(r.verdict) - rank(d.verdict);
  if (delta > 0) {
    improved++;
    improvedIds.push(r.caseId);
  } else if (delta < 0) {
    regressed++;
    regressedIds.push(r.caseId);
  }
}

// ── unnecessary handoff (expectedHandoff = NOT_REQUIRED) ─────────────────────
const notRequired = scored.filter(
  (r) => r.expected.handoffExpectation === "NOT_REQUIRED",
);
const unnec = {
  total: notRequired.length,
  continuedCorrectly: 0, // no handoff + verdict PASS/LIMITATION
  continuedButWrong: 0, // no handoff but verdict FAIL (other error)
  unnecessarilyHandedOff: 0,
  refusedOrHuman: 0, // requires-human disclosure specifically
  malformedOrProviderFail: 0,
  ids: { unnecessary: [] as string[], continued: [] as string[] },
};
for (const r of notRequired) {
  const pf = r.actual.handoffOutcomeClass === "PROVIDER_FAILURE";
  if (pf || r.actual.malformed) {
    unnec.malformedOrProviderFail++;
    continue;
  }
  if (handed(r)) {
    unnec.unnecessarilyHandedOff++;
    unnec.ids.unnecessary.push(r.caseId);
    if (r.actual.disclosure === "requires-human") unnec.refusedOrHuman++;
  } else if (r.verdict === "PASS" || r.verdict === "LIMITATION") {
    unnec.continuedCorrectly++;
    unnec.ids.continued.push(r.caseId);
  } else {
    unnec.continuedButWrong++;
  }
}

// ── service discovery family ─────────────────────────────────────────────────
const SD_SCENARIOS = [
  "st-service-discovery",
  "mi-booking-plus-discovery",
  "kn-service-catalog",
  "ex-service-discovery-variants",
  "mi-two-questions",
  "ex-advisory-asks",
  "ho-unnecessary-discovery-mid-flow",
  "lg-arabizi-service-name",
  "mi-discovery-price-booking",
  "mi-booking-plus-discovery-empty-kb",
  "kn-service-not-in-catalog",
  "mt-second-service",
];
function scenarioBreakdown(scenarioIds: string[]) {
  const rows: Array<Record<string, unknown>> = [];
  for (const sid of scenarioIds) {
    const rs = scored.filter((r) => r.scenarioId === sid);
    if (rs.length === 0) continue;
    const ds = rs.map((r) => detById.get(r.caseId)).filter(Boolean) as Rec[];
    rows.push({
      scenario: sid,
      total: rs.length,
      real_PASS: rs.filter((r) => r.verdict === "PASS").length,
      real_LIM: rs.filter((r) => r.verdict === "LIMITATION").length,
      real_FAIL: rs.filter((r) => r.verdict === "FAIL").length,
      real_handoff: rs.filter((r) => handed(r)).length,
      det_handoff: ds.filter((r) => handed(r)).length,
      det_FAIL: ds.filter((r) => r.verdict === "FAIL").length,
      sampleIds: rs.slice(0, 3).map((r) => r.caseId),
    });
  }
  return rows;
}
const serviceDiscovery = scenarioBreakdown(SD_SCENARIOS);
const sdAll = scored.filter((r) => SD_SCENARIOS.includes(r.scenarioId));
const sdSummary = {
  total: sdAll.length,
  realHandoff: pct(sdAll.filter((r) => handed(r)).length, sdAll.length),
  detHandoff: pct(
    sdAll.map((r) => detById.get(r.caseId)).filter((r) => r && handed(r))
      .length,
    sdAll.length,
  ),
  realPASS: sdAll.filter((r) => r.verdict === "PASS").length,
  realLIM: sdAll.filter((r) => r.verdict === "LIMITATION").length,
  realFAIL: sdAll.filter((r) => r.verdict === "FAIL").length,
};

// ── multi-intent ─────────────────────────────────────────────────────────────
function isMulti(r: Rec): boolean {
  const c = caseById.get(r.caseId);
  return (
    (c?.edgeCategories.includes("MULTI_INTENT") ?? false) ||
    (r.expected.secondaryIntents?.length ?? 0) > 0
  );
}
const multi = scored.filter(isMulti);
const multiDet = multi
  .map((r) => detById.get(r.caseId))
  .filter(Boolean) as Rec[];
const multiIntent = {
  total: multi.length,
  realPrimaryIntentOk: pct(
    multi.filter((r) => r.scorers.intent === "PASS").length,
    multi.length,
  ),
  realNoUnnecessaryHandoff: pct(
    multi.filter(
      (r) => r.actual.handoffOutcomeClass !== "UNNECESSARY_HUMAN_HANDOFF",
    ).length,
    multi.length,
  ),
  realSuccess: pct(
    multi.filter(
      (r) =>
        r.verdict !== "FAIL" &&
        r.actual.handoffOutcomeClass !== "UNNECESSARY_HUMAN_HANDOFF",
    ).length,
    multi.length,
  ),
  detSuccess: pct(
    multiDet.filter(
      (r) =>
        r.verdict !== "FAIL" &&
        r.actual.handoffOutcomeClass !== "UNNECESSARY_HUMAN_HANDOFF",
    ).length,
    multiDet.length,
  ),
  realHandoff: pct(multi.filter((r) => handed(r)).length, multi.length),
  detHandoff: pct(multiDet.filter((r) => handed(r)).length, multiDet.length),
};

// ── ambiguity ────────────────────────────────────────────────────────────────
const ambig = scored.filter((r) => {
  const c = caseById.get(r.caseId);
  return c?.edgeCategories.some((e) => e.startsWith("AMBIGUOUS")) ?? false;
});
const ambigDet = ambig
  .map((r) => detById.get(r.caseId))
  .filter(Boolean) as Rec[];
const ambiguity = {
  total: ambig.length,
  realOk: pct(
    ambig.filter(
      (r) =>
        r.actual.handoffOutcomeClass !== "UNNECESSARY_HUMAN_HANDOFF" &&
        r.scorers.intent !== "FAIL",
    ).length,
    ambig.length,
  ),
  detOk: pct(
    ambigDet.filter(
      (r) =>
        r.actual.handoffOutcomeClass !== "UNNECESSARY_HUMAN_HANDOFF" &&
        r.scorers.intent !== "FAIL",
    ).length,
    ambigDet.length,
  ),
  realHandoff: pct(ambig.filter((r) => handed(r)).length, ambig.length),
};

// ── knowledge (by requiredKnowledge bucket) ──────────────────────────────────
const knowledgeByReq: Record<
  string,
  { total: number; pass: number; lim: number; fail: number }
> = {};
for (const r of scored) {
  const req = (r.expected.requiredKnowledge as string) ?? "NONE";
  if (r.scorers.knowledge === "NOT_APPLICABLE" && req === "NONE") continue;
  const e = (knowledgeByReq[req] ??= { total: 0, pass: 0, lim: 0, fail: 0 });
  e.total++;
  if (r.scorers.knowledge === "PASS") e.pass++;
  else if (r.scorers.knowledge === "LIMITATION") e.lim++;
  else if (r.scorers.knowledge === "FAIL") e.fail++;
}

// ── language (register + noise) ──────────────────────────────────────────────
function facetVerdicts(
  pick: (c: NonNullable<ReturnType<typeof caseById.get>>) => string[],
) {
  const map = new Map<
    string,
    { total: number; pass: number; lim: number; fail: number; det_fail: number }
  >();
  for (const r of scored) {
    const c = caseById.get(r.caseId);
    if (!c) continue;
    for (const key of pick(c)) {
      const e = map.get(key) ?? {
        total: 0,
        pass: 0,
        lim: 0,
        fail: 0,
        det_fail: 0,
      };
      e.total++;
      if (r.verdict === "PASS") e.pass++;
      else if (r.verdict === "LIMITATION") e.lim++;
      else if (r.verdict === "FAIL") e.fail++;
      const d = detById.get(r.caseId);
      if (d && d.verdict === "FAIL") e.det_fail++;
      map.set(key, e);
    }
  }
  return Object.fromEntries(
    [...map.entries()].sort((a, b) => b[1].total - a[1].total),
  );
}
const languageByRegister = facetVerdicts((c) => [c.languageProfile.register]);
const languageByNoise = facetVerdicts((c) => c.languageProfile.noise);

// ── multi-turn / state ───────────────────────────────────────────────────────
const multiTurn = scored.filter((r) => {
  const ct = caseById.get(r.caseId)?.conversationType ?? "SINGLE_TURN";
  return ct !== "SINGLE_TURN";
});
const multiTurnDet = multiTurn
  .map((r) => detById.get(r.caseId))
  .filter(Boolean) as Rec[];
const revisionCases = scored.filter(
  (r) => caseById.get(r.caseId)?.expectedStateTransition?.isRevision === true,
);
const stateAxis = (rs: Rec[]) => {
  const applicable = rs.filter((r) => r.scorers.state !== "NOT_APPLICABLE");
  return {
    applicable: applicable.length,
    ok: applicable.filter(
      (r) => r.scorers.state === "PASS" || r.scorers.state === "LIMITATION",
    ).length,
  };
};
const realState = stateAxis(multiTurn);
const detState = stateAxis(multiTurnDet);
const multiTurnState = {
  totalMultiTurnCases: multiTurn.length,
  realStateOk: pct(realState.ok, realState.applicable),
  detStateOk: pct(detState.ok, detState.applicable),
  realPASS: pct(
    multiTurn.filter((r) => r.verdict === "PASS").length,
    multiTurn.length,
  ),
  detPASS: pct(
    multiTurnDet.filter((r) => r.verdict === "PASS").length,
    multiTurnDet.length,
  ),
  revisionCases: revisionCases.length,
  revisionStateOk: pct(
    stateAxis(revisionCases).ok,
    stateAxis(revisionCases).applicable,
  ),
};

// ── safety ───────────────────────────────────────────────────────────────────
const safetyCases = scored.filter((r) => r.scorers.safety !== "NOT_APPLICABLE");
const safetyViolations = safetyCases.filter((r) => r.scorers.safety === "FAIL");
// Split genuine violations from scorer artifacts. The SafetyScorer hard-fails
// ANY disclosed reply on a case tagged with an ADVERSARIAL/INJECTION edge — even
// when the case's own ground-truth `safetyExpectation` is SAFE and the expected
// behavior is to answer (e.g. an injection-framed but benign "what are your
// hours"). Those flags are evaluation artifacts, not production safety failures.
const genuineViolations = safetyViolations.filter(
  (r) => r.expected.safetyExpectation !== "SAFE",
);
const artifactViolations = safetyViolations.filter(
  (r) => r.expected.safetyExpectation === "SAFE",
);
const safety = {
  total: safetyCases.length,
  reportedViolations: safetyViolations.length,
  reportedRate: pct(safetyViolations.length, safetyCases.length),
  genuineViolations: genuineViolations.length,
  genuineRate: pct(genuineViolations.length, safetyCases.length),
  scorerArtifactViolations: artifactViolations.length,
  detViolations: safetyCases
    .map((r) => detById.get(r.caseId))
    .filter((r) => r && r.scorers.safety === "FAIL").length,
  genuineViolationIds: genuineViolations.map((r) => r.caseId),
  artifactViolationIds: artifactViolations.map((r) => r.caseId),
};

// ── latency / provider attempts (genuine LLM turns only) ─────────────────────
const latencies: number[] = [];
let retryCount = 0;
let timeoutTurns = 0;
let totalPhysical = 0;
let llmTurns = 0;
for (const r of realRun.caseResults) {
  // evaluated-turn telemetry only (the run's actual is the evaluated turn)
  const a = r.actual;
  if (a.source === "llm" && typeof a.modelLatencyMs === "number") {
    latencies.push(a.modelLatencyMs);
    llmTurns++;
    totalPhysical += a.physicalAttempts ?? 1;
    if ((a.physicalAttempts ?? 1) > 1) retryCount++;
  }
  if (a.providerErrorCode === "TIMEOUT") timeoutTurns++;
}
latencies.sort((a, b) => a - b);
const q = (p: number) => latencies[Math.floor(latencies.length * p)] ?? 0;
const latency = {
  evaluatedLlmTurns: llmTurns,
  p50Ms: q(0.5),
  p90Ms: q(0.9),
  p95Ms: q(0.95),
  p99Ms: q(0.99),
  maxMs: latencies[latencies.length - 1] ?? 0,
  evaluatedTurnsWithRetry: retryCount,
  evaluatedTimeoutTurns: timeoutTurns,
  avgPhysicalAttemptsPerEvaluatedLlmTurn:
    llmTurns === 0 ? 0 : (totalPhysical / llmTurns).toFixed(2),
  note: "16s production per-attempt cap (CODECRAFT_TIMEOUT_MS); bounded retry maxAttempts=2 (no cross-provider fallback).",
};

// ── failure clusters ─────────────────────────────────────────────────────────
const failByCat: Record<string, { count: number; ids: string[] }> = {};
for (const r of scored) {
  if (r.verdict !== "FAIL") continue;
  const e = (failByCat[r.failureCategory] ??= { count: 0, ids: [] });
  e.count++;
  if (e.ids.length < 5) e.ids.push(r.caseId);
}
const failByScenario: Record<string, number> = {};
for (const r of scored) {
  if (r.verdict === "FAIL")
    failByScenario[r.scenarioId] = (failByScenario[r.scenarioId] ?? 0) + 1;
}
const topFailScenarios = Object.entries(failByScenario)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 20);

// ── intent confusion (semantic → real intent) ────────────────────────────────
const intentConfusion: Record<string, Record<string, number>> = {};
for (const r of scored) {
  const exp = r.expected.currentIntent ?? r.expected.primaryIntent;
  const act = r.actual.intent ?? "∅";
  if (exp === act) continue;
  (intentConfusion[exp] ??= {})[act] =
    ((intentConfusion[exp] ?? {})[act] ?? 0) + 1;
}

const analysis = {
  headline,
  provider: realRun.system,
  comparison,
  verdictShift: {
    improved,
    regressed,
    improvedSampleIds: improvedIds.slice(0, 15),
    regressedSampleIds: regressedIds.slice(0, 15),
  },
  handoffChannels: {
    real: realRun.metrics.handoffOutcomeClasses,
    det: detRun.metrics.handoffOutcomeClasses,
  },
  unnecessaryHandoff: unnec,
  serviceDiscovery: { summary: sdSummary, byScenario: serviceDiscovery },
  multiIntent,
  ambiguity,
  knowledgeByReq,
  languageByRegister,
  languageByNoise,
  multiTurnState,
  safety,
  latency,
  failureClusters: { byCategory: failByCat, topScenarios: topFailScenarios },
  intentConfusion,
};

writeFileSync(
  resolve(
    ROOT,
    "evaluation/reports/egyptian-v1/real-llm-baseline/analysis.json",
  ),
  `${JSON.stringify(analysis, null, 2)}\n`,
  "utf8",
);

// ── console summary ──────────────────────────────────────────────────────────
console.log("REAL-LLM ANALYSIS written. Key numbers:");
console.log("headline", JSON.stringify(headline));
console.log(
  "unnecessaryHandoff",
  JSON.stringify({
    total: unnec.total,
    continued: unnec.continuedCorrectly,
    unnecessary: unnec.unnecessarilyHandedOff,
    providerFailOrMalformed: unnec.malformedOrProviderFail,
    continuedButWrong: unnec.continuedButWrong,
  }),
);
console.log("serviceDiscovery", JSON.stringify(sdSummary));
console.log("multiIntent", JSON.stringify(multiIntent));
console.log("ambiguity", JSON.stringify(ambiguity));
console.log("multiTurnState", JSON.stringify(multiTurnState));
console.log(
  "safety",
  JSON.stringify({
    total: safety.total,
    reported: safety.reportedViolations,
    genuine: safety.genuineViolations,
    artifact: safety.scorerArtifactViolations,
    det: safety.detViolations,
  }),
);
console.log("latency", JSON.stringify(latency));
console.log("verdictShift", JSON.stringify({ improved, regressed }));
console.log(
  "failCats",
  JSON.stringify(
    Object.fromEntries(Object.entries(failByCat).map(([k, v]) => [k, v.count])),
  ),
);
