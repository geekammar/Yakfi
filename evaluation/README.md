# FlowPilot — AI Evaluation Foundation

> The permanent regression/evaluation layer for FlowPilot's AI. Dataset +
> evaluation **only** — this directory changes NO production behavior, adds no
> migration, and is never imported by production code. Production depends on
> nothing here; everything here depends on production only through the
> published AI boundary (`ai-contract.ts`, `conversation-ai.ts`,
> `ai-context-builder`, `ai-disclosure`).
>
> Slice: `PROMPT-AI-EVAL-FOUNDATION-01` · dataset version: `egyptian-v1`.

## What lives here

```
evaluation/
├── README.md                          ← this file (how to add cases)
├── schema/
│   ├── taxonomy.ts                    ← current + future label vocabularies
│   ├── dataset-schema.ts              ← the machine-readable CASE + DATASET schema (Zod)
│   └── scenario-schema.ts             ← the SCENARIO schema (ground-truth source)
├── generator/
│   ├── mutations.ts                   ← seeded, deterministic Egyptian text mutations
│   └── compose.ts                     ← scenario → cases expansion (pure)
├── datasets/egyptian-v1/
│   ├── shared-context.ts              ← reusable tenants (services + FAQs)
│   ├── scenario-builders.ts           ← concise scenario factories
│   ├── scenarios-single-turn.ts       ← atomic turns (intents, FAQ, ambiguity)
│   ├── scenarios-language-behavior.ts ← register matrix (MSA/Arabizi/English/STT)
│   ├── scenarios-extra.ts             ← per-FAQ paraphrases, availability, edges
│   ├── scenarios-multi-turn.ts        ← booking journeys, memory, topic drift
│   ├── scenarios-adversarial.ts       ← rare edges + security injection
│   ├── index.ts                       ← bank collection + dataset assembly
│   └── egyptian-v1.dataset.json       ← the GENERATED, committed artifact
├── runner/
│   ├── current-ai-adapter.ts          ← offline replay of the CURRENT AI pipeline
│   ├── scoring.ts                     ← per-case comparison + aggregate metrics
│   └── report.ts                      ← JSON + Markdown baseline reports
└── reports/egyptian-v1/               ← generated baseline reports (committed)
```

CLI entry points live in `scripts/` (`eval-generate.ts`, `eval-baseline.ts`,
`check-eval.ts`) following the repository's offline-check convention.

## Commands

```sh
pnpm eval:generate     # scenarios → egyptian-v1.dataset.json (deterministic)
pnpm eval:baseline     # run the CURRENT AI over the dataset → baseline reports
pnpm check:eval        # offline dataset + runner invariants (17 checks, no DB/network)
```

All three are fully offline: no database, no network, no LLM call, no API keys,
no secrets. The baseline is therefore reproducible on any machine.

## The ground-truth discipline (binding)

Ground truth NEVER comes from an LLM judging itself:

```
Scenario            ← a human-authored structured definition
  ↓  (semantic label defined FIRST, before any text)
Gold Label          ← primaryIntent / secondaryIntents / entities / handoff truth
  ↓
Natural Egyptian Variants   ← authored utterances (colloquial, MSA, Arabizi, …)
  ↓
Conversation Variants       ← context turns for multi-turn cases
  ↓
Noise / Edge Mutations      ← DETERMINISTIC, seeded, gold-preserving transforms
  ↓
Validation          ← Zod schema + invariant harness (pnpm check:eval)
  ↓
Dataset             ← the committed JSON artifact
```

An LLM MAY help author natural-language surface text. It is never the source of
a label. Every case carries `rationale` (why it exists), `edgeCategories` (what
edge it tests), `rarity` (common/rare), `orientation`
(baseline-compatible vs future-architecture), and `goldPreserved` (mutations
preserve truth by construction).

## The two expectation layers

Each case carries **two** expectations, kept strictly separate:

1. `expectedSemanticLabel` — the ideal semantic outcome (uses the FUTURE
   taxonomy: `SERVICE_DISCOVERY`, `SERVICE_PRICE`, `CLARIFICATION_REQUIRED`, …).
   These are **dataset labels only**; they are NOT production intents and were
   never added to `aiIntentValues`.
2. `expectedCurrentAiOutcome` — the correct behavior achievable inside the
   CURRENT 8-intent contract. When the contract cannot represent the goal,
   `architecturalLimitation: true` records that the gap is architectural, not a
   bug.

Scoring therefore produces three verdicts:

| verdict      | meaning                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `PASS`       | actual == expected current behavior                                                                                      |
| `LIMITATION` | actual differs, but the current contract cannot do better                                                                |
| `FAIL`       | actual differs and the current AI was expected to handle it                                                              |
| `SEAM_OWNED` | the engine's deterministic booking-selection seam owns the turn (excluded from AI metrics — the assistant never sees it) |

## The mandatory handoff split

`expectedHandoff.expectation` is scenario-defined truth, independent of what the
AI does:

- `REQUIRED` — a genuine human is needed (explicit request, sensitive/high-risk,
  truly unsupported). Maps to `handoffKind` `HUMAN_REQUEST` / `SENSITIVE` /
  `UNSUPPORTED`.
- `NOT_REQUIRED` — a competent assistant could resolve this itself. A handoff
  here is an **UNNECESSARY handoff**.
- `ACCEPTABLE_EITHER` — routing to staff is fine but so is self-service
  (e.g. booking, which the current architecture always routes to staff).

Metrics: `handoffPrecision`, `handoffRecall`, `unnecessaryHandoffRate`,
`missedHandoffRate`. TRUE human required is reported separately from
unnecessary handoff — this distinction is mandatory and is enforced in
`scoring.ts`.

## What the runner executes

`runCurrentAiForCase` replays the exact offline chain the engine runs for a turn:

```
case → AiRequest (message + bounded history + business context)
     → bypassDeterministicAi(request)              (deterministic bypass)
     → deterministicConversationAi.respond(request) (the safe assistant)
     → enforceDisclosure({ response, ledger })      (B-03 customer gate)
```

The policy-backed live provider (openrouter / agentrouter / atria) is a runtime
selection requiring credentials and network; the deterministic classifier above
is the engine's documented safe fallback AND the implementation
`bypassDeterministicAi` consults, so it is the correct offline-reproducible
subject for the current-AI baseline. Evaluating a live provider is a separate
mode (see "Live-provider mode" below) and is intentionally not required for the
baseline.

## Metrics

`aggregate()` computes: intent accuracy (strict + limitation-adjusted), action
accuracy (strict + limitation-adjusted), handoff precision, handoff recall,
unnecessary-handoff rate, missed-handoff rate, entity extraction accuracy, FAQ
answer correctness, multi-intent success rate, ambiguity handled acceptably,
conversation continuity accuracy, safety violation rate, malformed output rate,
deterministic bypass correctness, and the seam-owned turn count.

Every number is traceable: `baseline-report.json` carries one
`caseResults[]` record per case with `caseId`, `scenarioId`, the evaluated
message, expected vs actual outcome, and every verdict.

## How to add future cases

1. **Pick a bank** (or create `scenarios-<theme>.ts` and register it in
   `index.ts` under `collectEgyptianV1Scenarios`).
2. **Write the scenario gold label FIRST** with `scenario-builders.ts`:

   ```ts
   singleTurn({
     id: "st-my-new-case",
     utterances: egy("عايز أحجز ..."),
     semanticLabel: semantic("BOOKING", "what the ideal assistant does"),
     currentAiExpectation: current("BOOKING", "booking_handoff", null, {
       architecturalLimitation: true, // when the contract can't represent it
     }),
     handoff: handoffNotRequired("why a human is NOT needed"),
     knowledgeRequirement: "PARAPHRASED_FAQ",
     edgeCategories: ["BOOKING_JOURNEY"],
     difficulty: "MEDIUM",
     rationale: "WHY this case exists / what edge it tests",
   });
   ```

3. **Add mutations** (`mutations: [...]`) only when they preserve the gold label
   — every mutation is gold-preserving by construction. If you need a case
   whose meaning intentionally CHANGES, write a new scenario; never overload a
   mutation.
4. **Add a business context** from `shared-context.ts` (or define a new tenant)
   so knowledge-match/knowledge-gap behaviour is meaningful.
5. **Regenerate + validate**:

   ```sh
   pnpm eval:generate && pnpm check:eval && pnpm eval:baseline
   ```

6. `pnpm check:eval` must stay green. Scenario ids and case ids must be unique,
   every case needs a non-empty `rationale`, and expected current outcomes must
   stay inside the production enums (D6 proves no new production intents).

## How to add a new dataset version

The runner is version-agnostic: it loads
`evaluation/datasets/<version>/<version>.dataset.json`.

1. `mkdir evaluation/datasets/egyptian-v2`
2. Add scenario banks + an `index.ts` exporting
   `collectEgyptianV2Scenarios()` / `buildEgyptianV2Dataset()` (mirror v1).
3. Generate: `tsx scripts/eval-generate.ts --dataset egyptian-v2`
   (the generator CLI resolves `build<Version>Dataset` dynamically when the
   version is registered in `scripts/eval-generate.ts`).
4. Baseline: `tsx scripts/eval-baseline.ts egyptian-v2`.

Old datasets keep working untouched because the schema is `.passthrough()` on
every extensible sub-object: future fields never break old datasets.

## Live-provider mode (optional, not required for the baseline)

To measure a real provider instead of the deterministic path, inject a
`ConversationAi` implementation into a variant of the runner. The scoring
engine, metrics, and reports are subject-agnostic — swap
`runCurrentAiForCase` for one that calls `createPolicyBackedAi` (which needs
`CODECRAFT_API_KEY` / `OPENROUTER_API_KEY` and network). Keep the deterministic
baseline as the regression floor; treat live-provider runs as exploratory.

## Relationship to docs/ai/EVALUATIONS.md

`docs/ai/EVALUATIONS.md` and its `pnpm check:ai-prompts` fixtures are
**unchanged and intact** — they remain the low-level drift guard for the
deterministic classifier. This dataset is a HIGHER-LEVEL evaluation layer above
them: where a fixture asserts one invariant for one message, a dataset case
asserts a full semantic expectation (intent + action + handoff truth +
knowledge requirement + entities) for a realistic Egyptian turn.
`check-eval.ts` D14 re-asserts the fixture ordering invariants so the two
layers cannot drift apart.

## Invariants this layer guarantees

- No production code change (verified: nothing under `src/` was modified).
- No new production intents — D6 asserts every expected current outcome uses
  values from `aiIntentValues` / `aiActionValues` / `handoffReasonValues`.
- Determinism — D4 asserts a rebuild is byte-identical.
- No secrets — no key-shaped value exists in any dataset file; `pnpm security`
  stays clean.
- Offline — no DB, no network, no LLM, no API keys.
