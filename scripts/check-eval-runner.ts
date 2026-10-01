import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type {
  EvaluationTarget,
  TargetTurnInput,
} from "../evaluation/runner/target";
import type { EvaluationCase } from "../evaluation/schema/dataset-schema";
import type { ActualOutcome } from "../evaluation/schema/evaluation-result-schema";

/**
 * FlowPilot AI Evaluation — runner + scoring engine checks (PROMPT-AI-EVAL-03).
 *
 * Focused, OFFLINE tests for the reusable evaluation runner and scoring
 * engine (no DB, no network, no LLM, no keys). Small fixtures + a FakeTarget
 * exercise the scorers deterministically; a handful of REAL egyptian-v1 cases
 * exercise the CurrentFlowpilotTarget end-to-end. The full dataset is NEVER
 * run here.
 *
 *   R1  single-turn execution
 *   R2  multi-turn execution (order + causal context preserved)
 *   R3  case filtering (mode selection + subset)
 *   R4  expected-vs-actual comparison recorded
 *   R5  intent scoring (FAIL + LIMITATION)
 *   R6  action scoring
 *   R7  handoff scoring (TRUE + MISSED)
 *   R8  unnecessary handoff detection
 *   R9  entity scoring (missed + hallucinated)
 *   R10 state-transition scoring (context lost + booking journey)
 *   R11 safety scoring (violation + correct refusal)
 *   R12 report generation (machine JSON validates + markdown non-empty)
 *   R13 deterministic repeatability (identical structured results)
 *   R14 invalid dataset / unknown case rejection
 *   R15 production→evaluation boundary (no src import of evaluation/)
 *   R16 no secrets in result artifacts
 *   R17 no raw chain-of-thought in results (bounded content, no reasoning keys)
 *   R18 no production runtime import of evaluation-only code (thorough scan)
 *
 * Run: pnpm check:eval-runner
 */
export {};

type Check = { label: string; pass: boolean };
const checks: Check[] = [];
function check(label: string, pass: boolean): void {
  checks.push({ label, pass });
}

const FIXED_NOW = () => new Date("2026-01-01T00:00:00.000Z");

async function main(): Promise<void> {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const { evaluationCaseSchema } =
    await import("../evaluation/schema/dataset-schema");
  const { parseEvaluationRun } =
    await import("../evaluation/schema/evaluation-result-schema");
  const { scoreCase } = await import("../evaluation/runner/scoring-engine");
  const { runEvaluation, replayCase } =
    await import("../evaluation/runner/runner");
  const { selectCases, executionMode } =
    await import("../evaluation/runner/filters");
  const { writeRunArtifacts, renderMarkdown } =
    await import("../evaluation/runner/run-report");
  const { createCurrentFlowpilotTarget } =
    await import("../evaluation/runner/targets/current-flowpilot");
  const { buildEgyptianV1Dataset } =
    await import("../evaluation/datasets/egyptian-v1");
  const { safeParseDataset } =
    await import("../evaluation/schema/dataset-schema");

  // ── fixtures ───────────────────────────────────────────────────────────
  function makeCase(overrides: Record<string, unknown>): EvaluationCase {
    const base = {
      caseId: "fix::0",
      datasetVersion: "egyptian-v1",
      scenarioId: "fix",
      conversationId: "conv",
      turnId: "turn",
      conversationType: "SINGLE_TURN",
      messages: [
        { senderType: "CUSTOMER", content: "عايز أحجز", turnIndex: 0 },
      ],
      languageProfile: { register: "EGYPTIAN_COLLOQUIAL" },
      difficulty: "EASY",
      orientation: "BASELINE_COMPATIBLE",
      edgeCategories: ["NORMAL"],
      businessContext: { businessName: "عيادة", services: [], faqs: [] },
      expectedSemanticLabel: {
        primaryIntent: "BOOKING",
        expectedNextAction: "book",
      },
      expectedCurrentAiOutcome: {
        intent: "BOOKING",
        action: "booking_handoff",
      },
      expectedHandoff: { expectation: "ACCEPTABLE_EITHER" },
      expectedKnowledgeRequirement: "NONE",
      expectedEntities: {},
      rationale: "fixture",
    };
    return evaluationCaseSchema.parse({ ...base, ...overrides });
  }

  class FakeTarget implements EvaluationTarget {
    readonly id = "fake";
    readonly systemIdentity = { kind: "FUTURE_SYSTEM" as const, note: "fake" };
    readonly seen: TargetTurnInput[] = [];
    constructor(
      private readonly fn: (input: TargetTurnInput) => ActualOutcome,
    ) {}
    async runTurn(input: TargetTurnInput): Promise<ActualOutcome> {
      this.seen.push(input);
      return this.fn(input);
    }
  }

  const reply = (o: Partial<ActualOutcome> = {}): ActualOutcome => ({
    intent: "BOOKING",
    action: "booking_handoff",
    handoffReason: null,
    content: "تمام",
    extraction: {
      service: null,
      provider: null,
      date: null,
      timePreference: null,
    },
    source: "deterministic-assistant",
    disclosure: "disclosed",
    malformed: false,
    ...o,
  });

  const cfg = (extra: Record<string, unknown> = {}) => ({
    datasetVersion: "egyptian-v1",
    datasetHash: "testhash",
    now: FIXED_NOW,
    ...extra,
  });

  // ── R1 single-turn execution ─────────────────────────────────────────────
  {
    const c = makeCase({ caseId: "st::0" });
    const target = new FakeTarget(() => reply());
    const res = await runEvaluation(target, [c], cfg());
    check(
      "R1 single-turn execution (1 case, 1 turn, PASS)",
      res.run.caseResults.length === 1 &&
        res.metrics.totalTurns === 1 &&
        res.run.caseResults[0]!.verdict === "PASS" &&
        target.seen.length === 1,
    );
  }

  // ── R2 multi-turn execution (order + context) ────────────────────────────
  {
    const c = makeCase({
      caseId: "mt::0",
      conversationType: "SHORT_MULTI_TURN",
      messages: [
        { senderType: "CUSTOMER", content: "عايز أحجز", turnIndex: 0 },
        { senderType: "AI", content: "أي خدمة؟", turnIndex: 1 },
        { senderType: "CUSTOMER", content: "تنظيف بكرة", turnIndex: 2 },
      ],
    });
    const target = new FakeTarget((input) =>
      reply({ content: `turn-${input.turnIndex}` }),
    );
    const { executions, evaluatedIndex } = await replayCase(target, c);
    const ordered =
      executions.length === 2 &&
      executions[0]!.turnIndex === 0 &&
      executions[1]!.turnIndex === 2 &&
      target.seen[1]!.history.length === 2; // second customer turn sees 2 prior msgs
    check(
      "R2 multi-turn execution preserves order + causal context",
      ordered && evaluatedIndex === 1,
    );
  }

  // ── R3 case filtering ─────────────────────────────────────────────────────
  {
    const cases = [
      makeCase({
        caseId: "a::0",
        scenarioId: "a",
        edgeCategories: ["MULTI_INTENT"],
        rarity: "RARE",
      }),
      makeCase({ caseId: "b::0", scenarioId: "b", edgeCategories: ["NORMAL"] }),
      makeCase({ caseId: "a::1", scenarioId: "a", edgeCategories: ["NORMAL"] }),
    ];
    const byScenario = selectCases(cases, { scenarioId: "a" });
    const byCategory = selectCases(cases, { edgeCategory: "MULTI_INTENT" });
    const byCase = selectCases(cases, { caseId: "b::0" });
    const modeOk =
      executionMode({ caseId: "x" }) === "SINGLE_CASE" &&
      executionMode({ scenarioId: "a" }) === "SCENARIO" &&
      executionMode({ edgeCategory: "MULTI_INTENT" }) === "CATEGORY" &&
      executionMode({ intent: "BOOKING" }) === "FILTERED" &&
      executionMode({}) === "DATASET";
    check(
      "R3 case filtering + mode selection",
      byScenario.length === 2 &&
        byCategory.length === 1 &&
        byCase.length === 1 &&
        modeOk,
    );
  }

  // ── R4 expected-vs-actual recorded ────────────────────────────────────────
  {
    const c = makeCase({});
    const scored = scoreCase(c, reply({ intent: "FAQ" }));
    const rec = scored.record;
    check(
      "R4 expected + actual recorded per case",
      rec.expected.primaryIntent === "BOOKING" &&
        rec.actual.intent === "FAQ" &&
        typeof rec.verdict === "string",
    );
  }

  // ── R5 intent scoring ─────────────────────────────────────────────────────
  {
    const fail = scoreCase(makeCase({}), reply({ intent: "CANCELLATION" }));
    const limitationCase = makeCase({
      orientation: "FUTURE_ARCHITECTURE",
      expectedSemanticLabel: {
        primaryIntent: "SERVICE_PRICE",
        expectedNextAction: "answer",
      },
      expectedCurrentAiOutcome: {
        intent: "FAQ",
        action: "reply",
        architecturalLimitation: true,
      },
    });
    const limitation = scoreCase(
      limitationCase,
      reply({
        intent: "AMBIGUOUS",
        action: "handoff",
        handoffReason: "AMBIGUOUS",
      }),
    );
    check(
      "R5 intent scoring: mismatch → FAIL/INTENT_MISCLASSIFIED, limitation → LIMITATION",
      fail.record.verdict === "FAIL" &&
        fail.record.failureCategory === "INTENT_MISCLASSIFIED" &&
        limitation.record.verdict === "LIMITATION",
    );
  }

  // ── R6 action scoring ─────────────────────────────────────────────────────
  {
    const c = makeCase({
      expectedCurrentAiOutcome: { intent: "BOOKING", action: "reply" },
    });
    const scored = scoreCase(
      c,
      reply({ intent: "BOOKING", action: "booking_handoff" }),
    );
    check(
      "R6 action scoring: action mismatch → FAIL/ACTION_WRONG",
      scored.record.verdict === "FAIL" &&
        scored.record.failureCategory === "ACTION_WRONG",
    );
  }

  // ── R7 handoff scoring (TRUE + MISSED) ────────────────────────────────────
  {
    const requiredCase = makeCase({
      expectedSemanticLabel: {
        primaryIntent: "HUMAN_REQUEST",
        expectedNextAction: "route",
      },
      expectedCurrentAiOutcome: {
        intent: "HUMAN_REQUEST",
        action: "handoff",
        handoffReason: "HUMAN_REQUEST",
      },
      expectedHandoff: { expectation: "REQUIRED", kind: "HUMAN_REQUEST" },
    });
    const trueH = scoreCase(
      requiredCase,
      reply({
        intent: "HUMAN_REQUEST",
        action: "handoff",
        handoffReason: "HUMAN_REQUEST",
      }),
    );
    const missed = scoreCase(
      requiredCase,
      reply({ intent: "HUMAN_REQUEST", action: "reply" }),
    );
    check(
      "R7 handoff scoring: REQUIRED+handed → TRUE, REQUIRED+not → HANDOFF_MISSED",
      trueH.handoffOutcomeClass === "TRUE_HUMAN_REQUIRED" &&
        trueH.scorerOutcomes.find((o) => o.scorer === "handoff")?.verdict ===
          "PASS" &&
        missed.record.failureCategory === "HANDOFF_MISSED" &&
        missed.handoffOutcomeClass === "NO_HANDOFF",
    );
  }

  // ── R8 unnecessary handoff detection ──────────────────────────────────────
  {
    const notRequired = makeCase({
      expectedSemanticLabel: {
        primaryIntent: "FAQ",
        expectedNextAction: "answer",
      },
      expectedCurrentAiOutcome: { intent: "FAQ", action: "reply" },
      expectedHandoff: { expectation: "NOT_REQUIRED" },
      expectedKnowledgeRequirement: "EXACT_FAQ",
    });
    const unnecessary = scoreCase(
      notRequired,
      reply({
        intent: "FAQ",
        action: "handoff",
        handoffReason: "NO_KNOWLEDGE",
      }),
    );
    check(
      "R8 unnecessary handoff → FAIL/HANDOFF_UNNECESSARY + UNNECESSARY_HUMAN_HANDOFF",
      unnecessary.record.failureCategory === "HANDOFF_UNNECESSARY" &&
        unnecessary.handoffOutcomeClass === "UNNECESSARY_HUMAN_HANDOFF",
    );
  }

  // ── R9 entity scoring ─────────────────────────────────────────────────────
  {
    const withService = makeCase({
      expectedEntities: { service: "تنظيف" },
    });
    const missed = scoreCase(
      withService,
      reply({
        extraction: {
          service: null,
          provider: null,
          date: null,
          timePreference: null,
        },
      }),
    );
    const hallucinatedDiff = scoreCase(
      withService,
      reply({
        extraction: {
          service: "تبييض",
          provider: null,
          date: null,
          timePreference: null,
        },
      }),
    );
    const faqCase = makeCase({
      expectedSemanticLabel: {
        primaryIntent: "FAQ",
        expectedNextAction: "answer",
      },
      expectedCurrentAiOutcome: { intent: "FAQ", action: "reply" },
    });
    const hallucinatedFaq = scoreCase(
      faqCase,
      reply({
        intent: "FAQ",
        action: "reply",
        extraction: {
          service: "زرع",
          provider: null,
          date: null,
          timePreference: null,
        },
      }),
    );
    const missedOk =
      missed.scorerOutcomes.find((o) => o.scorer === "entity")
        ?.failureCategory === "EXTRACTION_MISSED";
    const hallDiffOk =
      hallucinatedDiff.scorerOutcomes.find((o) => o.scorer === "entity")
        ?.failureCategory === "EXTRACTION_HALLUCINATED";
    const hallFaqOk =
      hallucinatedFaq.scorerOutcomes.find((o) => o.scorer === "entity")
        ?.failureCategory === "EXTRACTION_HALLUCINATED";
    check(
      "R9 entity scoring: missed + hallucinated detected",
      missedOk && hallDiffOk && hallFaqOk,
    );
  }

  // ── R10 state-transition scoring ──────────────────────────────────────────
  {
    const memoryCase = makeCase({
      conversationType: "SHORT_MULTI_TURN",
      expectedConversationState: { requiresMemory: true },
      messages: [
        { senderType: "CUSTOMER", content: "عايز أحجز تنظيف", turnIndex: 0 },
        { senderType: "AI", content: "امتى؟", turnIndex: 1 },
        { senderType: "CUSTOMER", content: "بكرة", turnIndex: 2 },
      ],
    });
    const contextLost = scoreCase(
      memoryCase,
      reply({
        intent: "AMBIGUOUS",
        action: "handoff",
        handoffReason: "AMBIGUOUS",
      }),
    );
    const journeyCase = makeCase({
      edgeCategories: ["BOOKING_JOURNEY"],
      expectedStateTransition: {
        from: "SERVICE_SUPPLIED",
        to: "DATE_SUPPLIED",
        factKey: "date",
      },
    });
    const journeyErr = scoreCase(
      journeyCase,
      reply({ intent: "FAQ", action: "reply" }),
    );
    const clOk =
      contextLost.scorerOutcomes.find((o) => o.scorer === "state")
        ?.failureCategory === "CONTEXT_LOST";
    const bjOk =
      journeyErr.scorerOutcomes.find((o) => o.scorer === "state")
        ?.failureCategory === "BOOKING_JOURNEY_ERROR";
    check(
      "R10 state scoring: CONTEXT_LOST + BOOKING_JOURNEY_ERROR",
      clOk && bjOk,
    );
  }

  // ── R11 safety scoring ─────────────────────────────────────────────────────
  {
    const injection = makeCase({
      edgeCategories: ["SECURITY_INJECTION"],
      safetyExpectation: "SECURITY_ATTEMPT",
      expectedCurrentAiOutcome: {
        intent: "AMBIGUOUS",
        action: "handoff",
        handoffReason: "AMBIGUOUS",
      },
      expectedHandoff: { expectation: "REQUIRED", kind: "SENSITIVE" },
    });
    const violation = scoreCase(
      injection,
      reply({ intent: "FAQ", action: "reply", disclosure: "disclosed" }),
    );
    const safe = scoreCase(
      injection,
      reply({
        intent: "AMBIGUOUS",
        action: "handoff",
        handoffReason: "AMBIGUOUS",
        disclosure: "requires-human",
      }),
    );
    check(
      "R11 safety scoring: injection self-answer → SAFETY_VIOLATION; refuse+escalate → not",
      violation.record.failureCategory === "SAFETY_VIOLATION" &&
        safe.scorerOutcomes.find((o) => o.scorer === "safety")?.verdict ===
          "PASS",
    );
  }

  // ── real dataset + current target (used by R12/R13) ──────────────────────
  const dataset = buildEgyptianV1Dataset();
  const sample = dataset.cases.slice(0, 8);
  const target = createCurrentFlowpilotTarget();

  // ── R12 report generation ─────────────────────────────────────────────────
  {
    const res = await runEvaluation(target, sample, cfg());
    const dir = mkdtempSync(join(tmpdir(), "eval-run-"));
    const written = writeRunArtifacts(res, dir);
    const roundTrip = parseEvaluationRun(
      JSON.parse(readFileSync(written.jsonPath, "utf8")),
    );
    const md = renderMarkdown(res);
    check(
      "R12 report generation: machine JSON validates + markdown non-empty",
      roundTrip.caseResults.length === sample.length &&
        md.includes("Failure-category") &&
        md.length > 200,
    );
  }

  // ── R13 deterministic repeatability ───────────────────────────────────────
  {
    const a = await runEvaluation(target, sample, cfg());
    const b = await runEvaluation(target, sample, cfg());
    check(
      "R13 deterministic repeatability (identical structured run incl. runId)",
      JSON.stringify(a.run) === JSON.stringify(b.run),
    );
  }

  // ── R14 invalid dataset / unknown case rejection ──────────────────────────
  {
    const badDataset = safeParseDataset({
      meta: { version: 1 },
      cases: "nope",
    });
    const emptySelection = selectCases(sample, { caseId: "does-not-exist" });
    let threw = false;
    try {
      parseEvaluationRun({ run: {}, system: {}, metrics: {}, caseResults: [] });
    } catch {
      threw = true;
    }
    check(
      "R14 invalid dataset rejected, unknown case selects nothing, malformed run rejected",
      !badDataset.success && emptySelection.length === 0 && threw,
    );
  }

  // ── R15 / R18 production → evaluation boundary ────────────────────────────
  {
    const offenders = scanForEvaluationImports(resolve(process.cwd(), "src"));
    check(
      `R15 no src/ file imports evaluation/ (${offenders.length} offenders)`,
      offenders.length === 0,
    );
    check(
      `R18 no production runtime import of evaluation-only code (${offenders.length} offenders)`,
      offenders.length === 0,
    );
  }

  // ── R16 no secrets in result artifacts ────────────────────────────────────
  {
    const res = await runEvaluation(target, sample, cfg());
    const serialized = JSON.stringify(res.run) + JSON.stringify(res.manifest);
    const secretPatterns = [
      /sk-[A-Za-z0-9]{16,}/,
      /AKIA[0-9A-Z]{12,}/,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      /"(api[_-]?key|secret|password|token)"\s*:\s*"[^"]{12,}"/i,
      /AIza[0-9A-Za-z_-]{20,}/,
    ];
    const leaked = secretPatterns.filter((p) => p.test(serialized));
    check(
      `R16 no secrets in result artifacts (${leaked.length} matches)`,
      leaked.length === 0,
    );
  }

  // ── R17 no raw chain-of-thought in results ────────────────────────────────
  {
    const res = await runEvaluation(target, sample, cfg());
    const serialized = JSON.stringify(res.run);
    const cotKeys =
      /"(reasoning|chain_of_thought|thoughts?|scratchpad|deliberation)"\s*:/i;
    const contentTooLong = res.run.caseResults.some(
      (r) => (r.actual.content ?? "").length > 400,
    );
    check(
      "R17 no chain-of-thought keys + content bounded (≤400)",
      !cotKeys.test(serialized) && !contentTooLong,
    );
  }

  // ── summary ────────────────────────────────────────────────────────────
  const passed = checks.filter((c) => c.pass).length;
  for (const c of checks)
    console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.label}`);
  console.log(`\neval-runner check: ${passed}/${checks.length} passed`);
  if (passed < checks.length) process.exit(1);
}

/** Walk `src/` and return files that import from the evaluation/ tree. */
function scanForEvaluationImports(root: string): string[] {
  const offenders: string[] = [];
  const importRe =
    /(?:from|require\()\s*["'][^"']*evaluation\/(schema|runner|datasets|generator|reports)[^"']*["']/;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry)) {
        const text = readFileSync(full, "utf8");
        if (importRe.test(text)) offenders.push(full);
      }
    }
  };
  walk(root);
  return offenders;
}

void main();
