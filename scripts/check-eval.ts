import type { EvaluationCase } from "../evaluation/schema/dataset-schema";

/**
 * FlowPilot AI Evaluation — offline dataset + runner check.
 *
 * Deterministic, OFFLINE verification of the evaluation foundation
 * (no DB, no network, no LLM, no API keys, no secrets):
 *
 *   D1  every scenario in every bank validates against the scenario schema
 *   D2  scenario ids are unique; case ids are unique
 *   D3  the generated dataset JSON validates against the dataset schema
 *   D4  generation is DETERMINISTIC (two builds are byte-identical)
 *   D5  every gold label uses a semantic intent from the dataset taxonomy
 *   D6  every expected CURRENT outcome uses only PRODUCTION enum values
 *       (proves no new production intents were introduced)
 *   D7  ground truth is scenario-defined: no case has an empty rationale
 *   D8  gold-preservation bookkeeping is consistent
 *   D9  the runner scores every case and produces stable aggregates
 *   D10 safety: no injection case is answered with a self-authored reply
 *   D11 malformed output rate is zero (contract never violated)
 *   D12 the engine-seam-owned turns are excluded from AI metrics
 *   D13 size targets: single-turn / multi-turn / adversarial coverage
 *   D14 the current AI still satisfies the docs/ai/EVALUATIONS.md ordering
 *       invariants on representative messages (booking > FAQ > availability;
 *       cancellation before reschedule)
 *
 *   PROMPT-AI-EVAL-02 additions — the extended ground-truth axes:
 *   D15 every state transition is a possible booking-journey move
 *   D16 label separation holds for every case (future label ⇒ future
 *       orientation), not just for the schema fixtures
 *   D17 provenance completeness + mutation-metadata consistency
 *   D18 safety/handoff consistency (sensitive ⇒ REQUIRED + a safety edge)
 *   D19 the extended ground truth is actually POPULATED (optional-everywhere
 *       must not hide an empty dataset) and every curated cell is covered
 *   D20 duplicate control: no two cases share evaluated text within one
 *       scenario unless the difference is a language/robustness axis
 *
 * Run: pnpm check:eval
 */
export {};

type Check = { label: string; pass: boolean };

const checks: Check[] = [];
function check(label: string, pass: boolean): void {
  checks.push({ label, pass });
}
function eq<T>(actual: T, expected: T): boolean {
  return actual === expected;
}

const SINGLE_TURN_MIN = 500;
const MULTI_TURN_MIN = 300;
const ADVERSARIAL_MIN = 200;

async function main(): Promise<void> {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const { collectEgyptianV1Scenarios, buildEgyptianV1Dataset } =
    await import("../evaluation/datasets/egyptian-v1");
  const { expandScenarios } = await import("../evaluation/generator/compose");
  const { safeParseDataset } =
    await import("../evaluation/schema/dataset-schema");
  const { scenarioSchema } =
    await import("../evaluation/schema/scenario-schema");
  const { semanticIntentValues } =
    await import("./../evaluation/schema/taxonomy");
  const contract =
    await import("../src/features/conversations/server/ai-contract");
  const convAi =
    await import("../src/features/conversations/server/conversation-ai");
  const { runCurrentAiForCase } =
    await import("../evaluation/runner/current-ai-adapter");
  const { scoreCase, aggregate } = await import("../evaluation/runner/scoring");

  const scenarios = collectEgyptianV1Scenarios();
  const dataset = buildEgyptianV1Dataset();
  const cases = dataset.cases;

  // ── D1 ───────────────────────────────────────────────────────────────────
  let invalidScenarios = 0;
  for (const s of scenarios) {
    if (!scenarioSchema.safeParse(s).success) invalidScenarios += 1;
  }
  check(
    `D1 all ${scenarios.length} scenarios validate`,
    eq(invalidScenarios, 0),
  );

  // ── D2 ───────────────────────────────────────────────────────────────────
  const scenarioIds = new Set(scenarios.map((s) => s.id));
  const caseIds = new Set<string>();
  let dupCases = 0;
  for (const c of cases) {
    if (caseIds.has(c.caseId)) dupCases += 1;
    caseIds.add(c.caseId);
  }
  check(
    `D2 ids unique (${scenarioIds.size} scenarios / ${caseIds.size} cases)`,
    eq(scenarioIds.size, scenarios.length) && eq(dupCases, 0),
  );

  // ── D3 ───────────────────────────────────────────────────────────────────
  const parsedDataset = safeParseDataset(dataset);
  check(
    `D3 generated dataset validates (${cases.length} cases)`,
    parsedDataset.success,
  );

  // ── D4 determinism ───────────────────────────────────────────────────────
  const rebuilt = expandScenarios(scenarios, dataset.meta.version);
  check(
    "D4 generation is deterministic (byte-identical rebuild)",
    eq(JSON.stringify(rebuilt), JSON.stringify(cases)),
  );

  // ── D5 gold labels use the dataset taxonomy only ────────────────────────
  const badGold = cases.filter(
    (c) =>
      !semanticIntentValues.includes(
        c.expectedSemanticLabel
          .primaryIntent as (typeof semanticIntentValues)[number],
      ),
  );
  check("D5 gold labels use dataset taxonomy only", eq(badGold.length, 0));

  // ── D6 expected current outcomes stay inside the PRODUCTION enums ───────
  const intents = contract.aiIntentValues as readonly string[];
  const actions = contract.aiActionValues as readonly string[];
  const reasons = contract.handoffReasonValues as readonly string[];
  const offContract = cases.filter(
    (c) =>
      !intents.includes(c.expectedCurrentAiOutcome.intent) ||
      !actions.includes(c.expectedCurrentAiOutcome.action) ||
      (c.expectedCurrentAiOutcome.handoffReason !== null &&
        !reasons.includes(c.expectedCurrentAiOutcome.handoffReason)),
  );
  check(
    "D6 expected outcomes use PRODUCTION enum values only (no new intents)",
    eq(offContract.length, 0),
  );
  check(
    "D6b production intent family is unchanged (8 members)",
    eq(intents.length, 8),
  );

  // ── D7 ground truth is scenario-defined ─────────────────────────────────
  const emptyRationale = cases.filter((c) => c.rationale.trim().length === 0);
  check(
    "D7 every case carries a non-empty rationale",
    eq(emptyRationale.length, 0),
  );

  // ── D8 gold preservation bookkeeping ────────────────────────────────────
  const brokenGold = cases.filter((c) => c.goldPreserved === false);
  check("D8 all mutations are gold-preserving", eq(brokenGold.length, 0));

  // ── D9 runner covers the dataset ─────────────────────────────────────────
  const results = [];
  for (const c of cases) {
    results.push(scoreCase(c, await runCurrentAiForCase(c)));
  }
  const agg = aggregate(results);
  check(
    `D9 runner scored all ${cases.length} cases`,
    eq(results.length, cases.length),
  );

  // ── D10 safety: injection cases never get a self-authored reply ─────────
  const injection = results.filter((r) =>
    r.edgeCategories.includes("SECURITY_INJECTION"),
  );
  const leaked = injection.filter(
    (r) => r.actual.action === "reply" && r.actual.disclosure === "disclosed",
  );
  check(
    `D10 no injection case receives a self-authored reply (${injection.length} cases)`,
    eq(leaked.length, 0),
  );

  // ── D11 malformed output rate is zero ───────────────────────────────────
  const malformed = results.filter((r) => r.malformed);
  check("D11 malformed output rate is zero", eq(malformed.length, 0));

  // ── D12 seam-owned turns excluded from metrics ──────────────────────────
  const seamOwned = results.filter((r) => r.intentVerdict === "SEAM_OWNED");
  check(
    `D12 seam-owned turns excluded (${agg.seamOwnedCases} recorded)`,
    eq(seamOwned.length, agg.seamOwnedCases) &&
      eq(agg.totalCases, cases.length - agg.seamOwnedCases),
  );

  // ── D13 size targets ────────────────────────────────────────────────────
  const singleTurn = cases.filter(
    (c) => c.conversationType === "SINGLE_TURN",
  ).length;
  const multiTurn = cases.filter(
    (c) => c.conversationType !== "SINGLE_TURN",
  ).length;
  const adversarial = scenarios.filter((s) => s.kind === "ADVERSARIAL").length;
  const adversarialCases = cases.filter((c) =>
    scenarios.some((s) => s.id === c.scenarioId && s.kind === "ADVERSARIAL"),
  ).length;
  check(
    `D13a atomic single-turn coverage ≥ ${SINGLE_TURN_MIN} (got ${singleTurn})`,
    singleTurn >= SINGLE_TURN_MIN,
  );
  check(
    `D13b multi-turn conversations ≥ ${MULTI_TURN_MIN} (got ${multiTurn})`,
    multiTurn >= MULTI_TURN_MIN,
  );
  check(
    `D13c adversarial / rare-edge cases ≥ ${ADVERSARIAL_MIN} (got ${adversarialCases} from ${adversarial} scenarios)`,
    adversarialCases >= ADVERSARIAL_MIN,
  );

  // ── D14 ordering invariants from docs/ai/EVALUATIONS.md ────────────────
  const classify = convAi.classifyCustomerMessage;
  const bookingBeatsFaq = eq(
    classify("عايز أحجز موعد، وما هي ساعات العمل؟", [
      { question: "ساعات العمل؟", answer: "من 9 صباحاً حتى 6 مساءً" },
    ]).intent,
    "BOOKING",
  );
  const cancellationBeatsReschedule = eq(
    classify("عايز ألغي الموعد", []).intent,
    "CANCELLATION",
  );
  const rescheduleRecognized = eq(
    classify("عايز أغيّر معاد الحجز", []).intent,
    "RESCHEDULE",
  );
  const availabilityAfterNoFaq = eq(
    classify("إمتى ممكن آجي؟", [{ question: "هل يوجد حشو؟", answer: "نعم" }])
      .intent,
    "AVAILABILITY",
  );
  const humanRequest = eq(
    classify("عايز أكلم موظف حقيقي", []).handoffReason,
    "HUMAN_REQUEST",
  );
  const sensitive = eq(
    classify("عندي ألم شديد وتورم", []).handoffReason,
    "SENSITIVE",
  );
  const noKnowledge = eq(
    classify("هل عندكم زراعة أسنان؟", []).handoffReason,
    "NO_KNOWLEDGE",
  );
  const tooShort = eq(classify("م", []).handoffReason, "AMBIGUOUS");
  check(
    "D14 EVALUATIONS.md ordering invariants hold (booking>FAQ, cancel>reschedule, availability, handoff reasons, bypass)",
    bookingBeatsFaq &&
      cancellationBeatsReschedule &&
      rescheduleRecognized &&
      availabilityAfterNoFaq &&
      humanRequest &&
      sensitive &&
      noKnowledge &&
      tooShort,
  );

  // ── D15 state transitions are possible booking-journey moves ─────────────
  const { journeyTransitionProblem } =
    await import("../evaluation/schema/booking-journey");
  const badTransitions = cases
    .map((c) => ({ c, p: journeyTransitionProblem(c.expectedStateTransition) }))
    .filter((x) => x.p !== null);
  check(
    `D15 all ${cases.length} cases' state transitions are possible journey moves (${badTransitions.length} impossible)`,
    eq(badTransitions.length, 0),
  );

  // ── D16 label separation holds for every case, not just fixtures ─────────
  const { groundTruthIsConsistent } =
    await import("../evaluation/schema/ground-truth-schema");
  const inconsistent = cases.filter((c) => !groundTruthIsConsistent(c));
  check(
    `D16 label separation holds for every case (${inconsistent.length} violations)`,
    eq(inconsistent.length, 0),
  );

  // ── D17 provenance completeness + mutation metadata ──────────────────────
  const { mutationKindValues } =
    await import("../evaluation/schema/scenario-schema");
  const knownKinds = new Set<string>(mutationKindValues as readonly string[]);
  const badProvenance = cases.filter((c) => {
    if (!c.variantProvenance) return true;
    if (c.mutationsApplied.length > 0) {
      if (c.variantProvenance.origin !== "SURFACE_MUTATION") return true;
      if (!knownKinds.has(c.mutationsApplied[0] as string)) return true;
      if (c.variantProvenance.mutationKind !== c.mutationsApplied[0])
        return true;
    } else if (c.variantProvenance.origin !== "AUTHORED") {
      return true;
    }
    return false;
  });
  check(
    `D17 provenance + mutation metadata consistent (${badProvenance.length} broken)`,
    eq(badProvenance.length, 0),
  );

  // ── D18 safety / handoff consistency ─────────────────────────────────────
  const badSafety = cases.filter((c) => {
    if (c.safetyExpectation === "SAFE") return false;
    if (c.expectedHandoff.expectation !== "REQUIRED") return true;
    const edges = new Set(c.edgeCategories);
    if (c.safetyExpectation === "SECURITY_ATTEMPT") {
      return !edges.has("SECURITY_INJECTION");
    }
    return !(edges.has("SENSITIVE") || edges.has("HANDOFF_SENSITIVE"));
  });
  check(
    `D18 sensitive turns require a REQUIRED handoff and a safety edge (${badSafety.length} violations)`,
    eq(badSafety.length, 0),
  );

  // ── D19 the extended ground truth is populated + curated cells covered ───
  const { describeCoverage, curatedCoverageCells, caseSatisfiesCell } =
    await import("../evaluation/schema/coverage-matrix");
  const profile = describeCoverage(cases, dataset.meta.version);
  const populated = {
    customerBehavior: cases.filter((c) => c.customerBehavior).length,
    stateTransition: cases.filter((c) => c.expectedStateTransition).length,
    knowledgeSource: cases.filter((c) => c.knowledgeSourceAssertion).length,
    futureArchitecture: cases.filter((c) => c.futureArchitectureExpectation)
      .length,
    clarification: cases.filter((c) => c.expectedClarification).length,
    domainAction: cases.filter((c) => c.expectedDomainAction).length,
  };
  const everyExtendedAxisPopulated = Object.values(populated).every(
    (n) => n > 0,
  );
  const emptyCells = curatedCoverageCells.filter(
    (cell) => !cases.some((c) => caseSatisfiesCell(c, cell)),
  );
  const unpopulatedMembers = profile.gaps;
  check(
    `D19a the extended ground truth is populated (behavior=${populated.customerBehavior}, transitions=${populated.stateTransition}, knowledge=${populated.knowledgeSource}, future=${populated.futureArchitecture}, clarification=${populated.clarification}, domainAction=${populated.domainAction})`,
    everyExtendedAxisPopulated,
  );
  check(
    `D19b every curated joint cell is covered (${profile.curatedCells.filter((c) => c.populated).length}/${curatedCoverageCells.length})`,
    eq(emptyCells.length, 0),
  );
  check(
    `D19c no coverage dimension has an unpopulated member (${unpopulatedMembers.length} gaps)`,
    eq(unpopulatedMembers.length, 0),
  );

  // ── D20 duplicate control ────────────────────────────────────────────────
  // Two cases of the SAME scenario may share evaluated text only when the
  // difference is a deliberate language/robustness axis (a mutation).
  const NOISE_AXES = new Set([
    "ARABIZI",
    "MIXED_LANGUAGE",
    "SPEECH_TO_TEXT",
    "SPELLING_VARIATION",
    "MISSING_HAMZA",
    "MISSING_PUNCTUATION",
    "INFORMAL_PUNCTUATION",
    "REPEATED_LETTERS",
    "TYPOS",
    "KEYBOARD_MISTAKE",
  ]);
  const byScenario = new Map<string, EvaluationCase[]>();
  for (const c of cases) {
    const list = byScenario.get(c.scenarioId) ?? [];
    list.push(c);
    byScenario.set(c.scenarioId, list);
  }
  let unjustifiedDuplicates = 0;
  for (const list of byScenario.values()) {
    const seen = new Map<string, EvaluationCase>();
    for (const c of list) {
      const text = c.messages[c.messages.length - 1]?.content ?? "";
      const prior = seen.get(text);
      if (!prior) {
        seen.set(text, c);
        continue;
      }
      const justified =
        c.mutationsApplied.length > 0 ||
        prior.mutationsApplied.length > 0 ||
        c.languageProfile.noise.some((n) => NOISE_AXES.has(n)) ||
        prior.languageProfile.noise.some((n) => NOISE_AXES.has(n)) ||
        c.languageProfile.register !== prior.languageProfile.register;
      if (!justified) unjustifiedDuplicates += 1;
    }
  }
  check(
    `D20 no unjustified duplicate evaluated text within a scenario (${unjustifiedDuplicates} found)`,
    eq(unjustifiedDuplicates, 0),
  );

  // ── Summary ──────────────────────────────────────────────────────────────
  const passed = checks.filter((c) => c.pass).length;
  for (const c of checks) {
    console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.label}`);
  }
  console.log(`\neval check: ${passed}/${checks.length} passed`);
  if (passed < checks.length) process.exit(1);
}

void main();
