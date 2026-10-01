/**
 * FlowPilot AI Evaluation — ATRIA baseline analysis (PROMPT-AI-EVAL-04C).
 *
 * Measurement-only. Reads the ATRIA real-LLM run + the EVAL-04B CodeCraft
 * real-LLM run + the EVAL-04 deterministic run + the dataset, and emits a
 * three-way behavioral/diagnostic analysis. Reuses the exact section logic of
 * `eval-analyze-real.ts` (unchanged EVAL-03 semantics) and only adds a second
 * comparison column (CodeCraft) alongside the deterministic column.
 *
 * Changes NO production behavior. Every number is traceable to caseIds in the
 * run JSON. No ranking, no "winner" — differences are diagnostic.
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
const readRun = (p: string): Run =>
  JSON.parse(readFileSync(resolve(ROOT, p), "utf8"));

const atriaRun = readRun(
  "evaluation/reports/egyptian-v1/atria-baseline/evaluation-run.json",
);
const ccRun = readRun(
  "evaluation/reports/egyptian-v1/real-llm-baseline/evaluation-run.json",
);
const detRun = readRun(
  "evaluation/reports/egyptian-v1/baseline/evaluation-run.json",
);

const dataset: {
  meta?: { seed?: number };
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
const ccById = new Map(ccRun.caseResults.map((r) => [r.caseId, r]));
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
const scored = atriaRun.caseResults.filter((r) => r.verdict !== "SEAM_OWNED");
const headline = {
  totalCases: atriaRun.metrics.totalCases,
  totalTurns: atriaRun.metrics.totalTurns,
  scoredCases: atriaRun.metrics.scoredCases,
  seamOwned: atriaRun.metrics.seamOwnedCount,
  PASS: atriaRun.metrics.passCount,
  LIMITATION: atriaRun.metrics.limitationCount,
  FAIL: atriaRun.metrics.failCount,
  passRate: pct(atriaRun.metrics.passCount, atriaRun.metrics.scoredCases),
  limitationRate: pct(
    atriaRun.metrics.limitationCount,
    atriaRun.metrics.scoredCases,
  ),
  failRate: pct(atriaRun.metrics.failCount, atriaRun.metrics.scoredCases),
};

// ── metric comparison (atria vs codecraft vs deterministic) ─────────────────
const metricKeys = Object.keys(atriaRun.metrics.denominators);
const comparison: Record<
  string,
  {
    atria: string;
    codecraft: string;
    deterministic: string;
    deltaVsCC: string;
    deltaVsDet: string;
  }
> = {};
const fmt = (m?: { value: number; numerator: number; denominator: number }) =>
  m
    ? `${(m.value * 100).toFixed(1)}% (${m.numerator}/${m.denominator})`
    : "n/a";
for (const k of metricKeys) {
  const a = atriaRun.metrics.denominators[k]!;
  const cc = ccRun.metrics.denominators[k];
  const d = detRun.metrics.denominators[k];
  const av = a.value * 100;
  comparison[k] = {
    atria: fmt(a),
    codecraft: fmt(cc),
    deterministic: fmt(d),
    deltaVsCC: cc
      ? `${(av - cc.value * 100 >= 0 ? "+" : "") + (av - cc.value * 100).toFixed(1)}pp`
      : "n/a",
    deltaVsDet: d
      ? `${(av - d.value * 100 >= 0 ? "+" : "") + (av - d.value * 100).toFixed(1)}pp`
      : "n/a",
  };
}

// ── verdict-level improvement / regression vs each reference ─────────────────
const rank = (v: string) =>
  v === "PASS" ? 2 : v === "LIMITATION" || v === "SEAM_OWNED" ? 1 : 0;
function verdictShift(refById: Map<string, Rec>) {
  let improved = 0;
  let regressed = 0;
  const improvedIds: string[] = [];
  const regressedIds: string[] = [];
  for (const r of atriaRun.caseResults) {
    const ref = refById.get(r.caseId);
    if (!ref) continue;
    const delta = rank(r.verdict) - rank(ref.verdict);
    if (delta > 0) {
      improved++;
      improvedIds.push(r.caseId);
    } else if (delta < 0) {
      regressed++;
      regressedIds.push(r.caseId);
    }
  }
  return {
    improved,
    regressed,
    improvedSampleIds: improvedIds.slice(0, 15),
    regressedSampleIds: regressedIds.slice(0, 15),
  };
}
const verdictShiftVsCC = verdictShift(ccById);
const verdictShiftVsDet = verdictShift(detById);

// ── agreement: where Atria and CodeCraft behave the same / differ ────────────
let sameVerdict = 0;
let bothPass = 0;
let bothFail = 0;
let bothHandoff = 0;
let bothContinue = 0;
const divergeIds: string[] = [];
for (const r of scored) {
  const cc = ccById.get(r.caseId);
  if (!cc) continue;
  if (r.verdict === cc.verdict) sameVerdict++;
  else if (divergeIds.length < 40) divergeIds.push(r.caseId);
  if (r.verdict === "PASS" && cc.verdict === "PASS") bothPass++;
  if (r.verdict === "FAIL" && cc.verdict === "FAIL") bothFail++;
  if (handed(r) && handed(cc)) bothHandoff++;
  if (!handed(r) && !handed(cc)) bothContinue++;
}
const llmAgreement = {
  scoredBoth: scored.filter((r) => ccById.has(r.caseId)).length,
  sameVerdict,
  bothPass,
  bothFail,
  bothHandoff,
  bothContinue,
  divergentSampleIds: divergeIds,
};

// ── unnecessary handoff (expectedHandoff = NOT_REQUIRED) ─────────────────────
function unnecessaryFor(run: Rec[], byId?: Map<string, Rec>) {
  const notRequired = run.filter(
    (r) => r.expected.handoffExpectation === "NOT_REQUIRED",
  );
  const out = {
    total: notRequired.length,
    continuedCorrectly: 0,
    continuedButWrong: 0,
    unnecessarilyHandedOff: 0,
    refusedOrHuman: 0,
    malformedOrProviderFail: 0,
    ids: { unnecessary: [] as string[], continued: [] as string[] },
  };
  for (const r of notRequired) {
    const pf = r.actual.handoffOutcomeClass === "PROVIDER_FAILURE";
    if (pf || r.actual.malformed) {
      out.malformedOrProviderFail++;
      continue;
    }
    if (handed(r)) {
      out.unnecessarilyHandedOff++;
      out.ids.unnecessary.push(r.caseId);
      if (r.actual.disclosure === "requires-human") out.refusedOrHuman++;
    } else if (r.verdict === "PASS" || r.verdict === "LIMITATION") {
      out.continuedCorrectly++;
      out.ids.continued.push(r.caseId);
    } else {
      out.continuedButWrong++;
    }
  }
  void byId;
  return out;
}
const unnec = unnecessaryFor(scored);
const unnecCC = unnecessaryFor(
  ccRun.caseResults.filter((r) => r.verdict !== "SEAM_OWNED"),
);
const unnecDet = unnecessaryFor(
  detRun.caseResults.filter((r) => r.verdict !== "SEAM_OWNED"),
);

// ── service discovery family (esp. SERVICE_DISCOVERY + BOOKING) ──────────────
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
    const ccs = rs.map((r) => ccById.get(r.caseId)).filter(Boolean) as Rec[];
    const ds = rs.map((r) => detById.get(r.caseId)).filter(Boolean) as Rec[];
    rows.push({
      scenario: sid,
      total: rs.length,
      atria_PASS: rs.filter((r) => r.verdict === "PASS").length,
      atria_LIM: rs.filter((r) => r.verdict === "LIMITATION").length,
      atria_FAIL: rs.filter((r) => r.verdict === "FAIL").length,
      atria_handoff: rs.filter((r) => handed(r)).length,
      cc_handoff: ccs.filter((r) => handed(r)).length,
      cc_FAIL: ccs.filter((r) => r.verdict === "FAIL").length,
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
  atriaHandoff: pct(sdAll.filter((r) => handed(r)).length, sdAll.length),
  ccHandoff: pct(
    sdAll.map((r) => ccById.get(r.caseId)).filter((r) => r && handed(r)).length,
    sdAll.length,
  ),
  detHandoff: pct(
    sdAll.map((r) => detById.get(r.caseId)).filter((r) => r && handed(r))
      .length,
    sdAll.length,
  ),
  atriaPASS: sdAll.filter((r) => r.verdict === "PASS").length,
  atriaLIM: sdAll.filter((r) => r.verdict === "LIMITATION").length,
  atriaFAIL: sdAll.filter((r) => r.verdict === "FAIL").length,
};
// The canonical SERVICE_DISCOVERY + BOOKING utterance.
const CANONICAL_SDB = "عايز احجز ايه الخدمات اللي موجوده عندكم؟";
const sdbCases = scored.filter((r) => {
  const anyText = JSON.stringify(r).includes("احجز ايه الخدمات");
  return r.scenarioId === "mi-booking-plus-discovery" || anyText;
});
const canonicalSDB = {
  utterance: CANONICAL_SDB,
  matchedCases: sdbCases.length,
  atriaHandoff: sdbCases.filter((r) => handed(r)).length,
  atriaContinued: sdbCases.filter((r) => !handed(r)).length,
  ccHandoff: sdbCases
    .map((r) => ccById.get(r.caseId))
    .filter((r) => r && handed(r)).length,
  sampleIds: sdbCases.slice(0, 6).map((r) => r.caseId),
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
const multiCC = multi.map((r) => ccById.get(r.caseId)).filter(Boolean) as Rec[];
const multiDet = multi
  .map((r) => detById.get(r.caseId))
  .filter(Boolean) as Rec[];
const successPred = (r: Rec) =>
  r.verdict !== "FAIL" &&
  r.actual.handoffOutcomeClass !== "UNNECESSARY_HUMAN_HANDOFF";
const multiIntent = {
  total: multi.length,
  atriaPrimaryIntentOk: pct(
    multi.filter((r) => r.scorers.intent === "PASS").length,
    multi.length,
  ),
  atriaNoUnnecessaryHandoff: pct(
    multi.filter(
      (r) => r.actual.handoffOutcomeClass !== "UNNECESSARY_HUMAN_HANDOFF",
    ).length,
    multi.length,
  ),
  atriaSuccess: pct(multi.filter(successPred).length, multi.length),
  ccSuccess: pct(multiCC.filter(successPred).length, multiCC.length),
  detSuccess: pct(multiDet.filter(successPred).length, multiDet.length),
  atriaHandoff: pct(multi.filter((r) => handed(r)).length, multi.length),
  ccHandoff: pct(multiCC.filter((r) => handed(r)).length, multiCC.length),
  detHandoff: pct(multiDet.filter((r) => handed(r)).length, multiDet.length),
};

// ── ambiguity ────────────────────────────────────────────────────────────────
const ambig = scored.filter((r) => {
  const c = caseById.get(r.caseId);
  return c?.edgeCategories.some((e) => e.startsWith("AMBIGUOUS")) ?? false;
});
const ambigCC = ambig.map((r) => ccById.get(r.caseId)).filter(Boolean) as Rec[];
const ambigDet = ambig
  .map((r) => detById.get(r.caseId))
  .filter(Boolean) as Rec[];
const ambigOkPred = (r: Rec) =>
  r.actual.handoffOutcomeClass !== "UNNECESSARY_HUMAN_HANDOFF" &&
  r.scorers.intent !== "FAIL";
const ambiguity = {
  total: ambig.length,
  atriaOk: pct(ambig.filter(ambigOkPred).length, ambig.length),
  ccOk: pct(ambigCC.filter(ambigOkPred).length, ambigCC.length),
  detOk: pct(ambigDet.filter(ambigOkPred).length, ambigDet.length),
  atriaHandoff: pct(ambig.filter((r) => handed(r)).length, ambig.length),
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
// fabrication proxy: knowledge scorer FAIL where no handoff (answered) → possible hallucination
const knowledgeFabrication = {
  fabricatedFailCategory: scored.filter(
    (r) => r.failureCategory === "KNOWLEDGE_FABRICATED",
  ).length,
  ids: scored
    .filter((r) => r.failureCategory === "KNOWLEDGE_FABRICATED")
    .slice(0, 15)
    .map((r) => r.caseId),
};

// ── language (register + noise) ──────────────────────────────────────────────
function facetVerdicts(
  pick: (c: NonNullable<ReturnType<typeof caseById.get>>) => string[],
) {
  const map = new Map<
    string,
    {
      total: number;
      pass: number;
      lim: number;
      fail: number;
      cc_fail: number;
      det_fail: number;
    }
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
        cc_fail: 0,
        det_fail: 0,
      };
      e.total++;
      if (r.verdict === "PASS") e.pass++;
      else if (r.verdict === "LIMITATION") e.lim++;
      else if (r.verdict === "FAIL") e.fail++;
      const cc = ccById.get(r.caseId);
      if (cc && cc.verdict === "FAIL") e.cc_fail++;
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
const multiTurnCC = multiTurn
  .map((r) => ccById.get(r.caseId))
  .filter(Boolean) as Rec[];
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
const atriaState = stateAxis(multiTurn);
const ccState = stateAxis(multiTurnCC);
const detState = stateAxis(multiTurnDet);
const multiTurnState = {
  totalMultiTurnCases: multiTurn.length,
  atriaStateOk: pct(atriaState.ok, atriaState.applicable),
  ccStateOk: pct(ccState.ok, ccState.applicable),
  detStateOk: pct(detState.ok, detState.applicable),
  atriaPASS: pct(
    multiTurn.filter((r) => r.verdict === "PASS").length,
    multiTurn.length,
  ),
  ccPASS: pct(
    multiTurnCC.filter((r) => r.verdict === "PASS").length,
    multiTurnCC.length,
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
// booking-state axis (scorers.state on booking-journey scenarios)
const bookingCases = scored.filter((r) => {
  const c = caseById.get(r.caseId);
  return c?.edgeCategories.includes("BOOKING_JOURNEY") ?? false;
});
const bookingState = {
  total: bookingCases.length,
  atriaOk: pct(stateAxis(bookingCases).ok, stateAxis(bookingCases).applicable),
  atriaHandoff: pct(
    bookingCases.filter((r) => handed(r)).length,
    bookingCases.length,
  ),
};

// ── safety ───────────────────────────────────────────────────────────────────
const safetyCases = scored.filter((r) => r.scorers.safety !== "NOT_APPLICABLE");
const safetyViolations = safetyCases.filter((r) => r.scorers.safety === "FAIL");
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
  ccViolations: safetyCases
    .map((r) => ccById.get(r.caseId))
    .filter((r) => r && r.scorers.safety === "FAIL").length,
  detViolations: safetyCases
    .map((r) => detById.get(r.caseId))
    .filter((r) => r && r.scorers.safety === "FAIL").length,
  genuineViolationIds: genuineViolations.map((r) => r.caseId),
  artifactViolationIds: artifactViolations.slice(0, 15).map((r) => r.caseId),
};

// ── latency / provider attempts (genuine LLM turns only) ─────────────────────
const latencies: number[] = [];
let retryCount = 0;
let timeoutTurns = 0;
let totalPhysical = 0;
let llmTurns = 0;
let providerFailTurns = 0;
for (const r of atriaRun.caseResults) {
  const a = r.actual;
  if (a.source === "llm" && typeof a.modelLatencyMs === "number") {
    latencies.push(a.modelLatencyMs);
    llmTurns++;
    totalPhysical += a.physicalAttempts ?? 1;
    if ((a.physicalAttempts ?? 1) > 1) retryCount++;
  }
  if (a.providerErrorCode === "TIMEOUT") timeoutTurns++;
  if (
    a.handoffOutcomeClass === "PROVIDER_FAILURE" ||
    a.source === "controlled-failure"
  )
    providerFailTurns++;
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
  evaluatedProviderFailureTurns: providerFailTurns,
  avgPhysicalAttemptsPerEvaluatedLlmTurn:
    llmTurns === 0 ? 0 : Number((totalPhysical / llmTurns).toFixed(2)),
  note: "Eval per-attempt timeout override = 45000ms (Atria-Dawn-Preview is a slow model; the production 16s cap yields frequent TIMEOUTs under concurrency — a provider-latency observation, not model behavior). Bounded retry maxAttempts=2, no cross-provider fallback.",
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

// persistence: failure categories present in BOTH atria and codecraft
const ccFailByCat: Record<string, number> = {};
for (const r of ccRun.caseResults) {
  if (r.verdict === "FAIL")
    ccFailByCat[r.failureCategory] = (ccFailByCat[r.failureCategory] ?? 0) + 1;
}
const persistentFailurePatterns = Object.keys(failByCat)
  .filter((k) => (ccFailByCat[k] ?? 0) > 0)
  .map((k) => ({
    category: k,
    atria: failByCat[k]!.count,
    codecraft: ccFailByCat[k]!,
  }))
  .sort((a, b) => b.atria - a.atria);

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
  identity: {
    atria: {
      runId: atriaRun.run.runId,
      system: atriaRun.system,
      executedAt: atriaRun.run.executedAt,
    },
    codecraft: { runId: ccRun.run.runId, system: ccRun.system },
    deterministic: { runId: detRun.run.runId, system: detRun.system },
  },
  headline,
  comparison,
  verdictShiftVsCC,
  verdictShiftVsDet,
  llmAgreement,
  handoffChannels: {
    atria: atriaRun.metrics.handoffOutcomeClasses,
    codecraft: ccRun.metrics.handoffOutcomeClasses,
    deterministic: detRun.metrics.handoffOutcomeClasses,
  },
  unnecessaryHandoff: {
    atria: unnec,
    codecraft: unnecCC,
    deterministic: unnecDet,
  },
  serviceDiscovery: {
    summary: sdSummary,
    canonicalServiceDiscoveryBooking: canonicalSDB,
    byScenario: serviceDiscovery,
  },
  multiIntent,
  ambiguity,
  knowledgeByReq,
  knowledgeFabrication,
  languageByRegister,
  languageByNoise,
  multiTurnState,
  bookingState,
  safety,
  latency,
  failureClusters: { byCategory: failByCat, topScenarios: topFailScenarios },
  persistentFailurePatterns,
  intentConfusion,
};

writeFileSync(
  resolve(ROOT, "evaluation/reports/egyptian-v1/atria-baseline/analysis.json"),
  `${JSON.stringify(analysis, null, 2)}\n`,
  "utf8",
);

// ── console summary ──────────────────────────────────────────────────────────
console.log("ATRIA ANALYSIS written. Key numbers:");
console.log("headline", JSON.stringify(headline));
console.log(
  "unnecessaryHandoff(atria)",
  JSON.stringify({
    total: unnec.total,
    continued: unnec.continuedCorrectly,
    unnecessary: unnec.unnecessarilyHandedOff,
    provFailOrMalformed: unnec.malformedOrProviderFail,
    continuedButWrong: unnec.continuedButWrong,
  }),
);
console.log("serviceDiscovery", JSON.stringify(sdSummary));
console.log("canonicalSDB", JSON.stringify(canonicalSDB));
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
    cc: safety.ccViolations,
    det: safety.detViolations,
  }),
);
console.log("latency", JSON.stringify(latency));
console.log(
  "llmAgreement",
  JSON.stringify({
    scoredBoth: llmAgreement.scoredBoth,
    sameVerdict: llmAgreement.sameVerdict,
    bothPass: llmAgreement.bothPass,
    bothFail: llmAgreement.bothFail,
  }),
);
console.log(
  "verdictShift vsCC",
  JSON.stringify({
    improved: verdictShiftVsCC.improved,
    regressed: verdictShiftVsCC.regressed,
  }),
);
console.log(
  "verdictShift vsDet",
  JSON.stringify({
    improved: verdictShiftVsDet.improved,
    regressed: verdictShiftVsDet.regressed,
  }),
);
console.log(
  "persistentFailurePatterns",
  JSON.stringify(persistentFailurePatterns),
);
console.log(
  "failCats",
  JSON.stringify(
    Object.fromEntries(Object.entries(failByCat).map(([k, v]) => [k, v.count])),
  ),
);
