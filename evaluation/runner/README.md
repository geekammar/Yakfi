# FlowPilot AI Evaluation — Reusable Runner + Scoring Engine

> Slice: `PROMPT-AI-EVAL-03`. Measurement infrastructure ONLY. This directory
> changes NO production behavior, adds no migration, and is never imported by
> production code (proven by `check:eval-runner` R15/R18). It consumes the
> EVAL-01 schemas and the EVAL-02 `egyptian-v1` dataset and produces
> reproducible, machine- and human-readable evaluation reports.
>
> It does NOT publish a production baseline — the dedicated baseline/failure
> analysis is the next slice.

## Architecture

```
Evaluation (CLI: scripts/eval-run.ts)
   ↓  selectCases(dataset, filter)          filters.ts
EvaluationTarget                            target.ts        ← the seam
   ↓  runTurn(input) per CUSTOMER turn (multi-turn replay)   runner.ts
ActualOutcome (EVAL-01 evaluation-result schema)
   ↓  scoreCase(case, actual, scorers)      scoring-engine.ts
Scorers (pluggable, one per axis)           scorers/*.ts
   ↓  combine verdicts → CaseResultRecord + failureCategory
Metrics + failure taxonomy                  metrics.ts · failure-taxonomy.ts
   ↓  aggregate (explicit denominators)
EvaluationRun + manifest                    run-report.ts
```

The scoring engine, metrics, runner, and reports are **target-agnostic**: they
never know which target ran. A run is fully identified by its manifest
(dataset version + dataset hash + target identity + evaluator/scoring versions

- filter), and `runId` is a content hash of those inputs, so the same
  deterministic configuration produces byte-identical structured results
  (`check:eval-runner` R13).

## Files

| File                           | Role                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------- |
| `target.ts`                    | The `EvaluationTarget` interface + neutral turn input types                     |
| `targets/current-flowpilot.ts` | The CURRENT-AI target (offline, via the shared seam)                            |
| `current-ai-adapter.ts`        | The single production seam (`runCurrentAiTurn`) both runners share              |
| `scorers/types.ts`             | The `Scorer` contract + `ScoringContext`                                        |
| `scorers/*-scorer.ts`          | One scorer per axis (intent, action, handoff, entity, state, safety, knowledge) |
| `scorers/index.ts`             | `DEFAULT_SCORERS` in failure-priority order                                     |
| `scoring-engine.ts`            | Combines scorer verdicts → `CaseResultRecord`                                   |
| `metrics.ts`                   | Aggregate metrics with explicit numerator/denominator                           |
| `failure-taxonomy.ts`          | Aggregation over the closed `failureCategoryValues`                             |
| `filters.ts`                   | Case selection + execution-mode derivation                                      |
| `runner.ts`                    | Multi-turn replay + run assembly + reproducibility                              |
| `run-report.ts`                | Machine JSON (validated) + markdown + manifest                                  |
| `versions.ts`                  | `EVALUATOR_VERSION` / `SCORING_VERSION` stamps                                  |

The FOUNDATION baseline runner (`scoring.ts`, `report.ts`, and
`runCurrentAiForCase`) is preserved unchanged; it still backs
`pnpm eval:baseline` and `pnpm check:eval`.

## Commands

```sh
pnpm eval:run                                  # whole dataset
pnpm eval:run --case <caseId>                  # SINGLE_CASE
pnpm eval:run --scenario <scenarioId>          # SCENARIO
pnpm eval:run --category MULTI_INTENT          # CATEGORY (edge)
pnpm eval:run --intent BOOKING --rarity RARE   # FILTERED
pnpm eval:run --language ARABIZI               # FILTERED
pnpm eval:run --smoke --out /tmp/eval          # tiny sample (prove it runs)
pnpm check:eval-runner                          # 18 offline runner/scoring tests
```

All are offline: no DB, no network, no LLM, no keys.

## Adding a new TARGET (e.g. future-router, JEV, hybrid, model-comparison)

1. Create `targets/<name>.ts` exporting a class that `implements EvaluationTarget`:
   - set `id` (used in run ids + reports) and `systemIdentity`
     (`kind: "FUTURE_SYSTEM"` for anything non-production);
   - implement `runTurn(input)` → `ActualOutcome`. **Never throw** — report an
     internal failure as an outcome (`malformed: true` / a handoff class).
     **Never** perform live channel delivery; capture the structured outcome only.
2. Nothing else changes. The runner replays multi-turn conversations for you;
   the scorers and metrics are target-agnostic.
3. If the target is a live provider, keep it opt-in and behind explicit
   credentials — the offline current-AI target stays the regression floor.

## Adding a new SCORER (a new correctness axis)

1. Create `scorers/<axis>-scorer.ts` exporting a `Scorer`:
   - compare **structured behavior**, never response wording (wording is only
     used where it is objectively reliable, e.g. a safety refusal);
   - return `NOT_APPLICABLE` when the case does not exercise the axis (so its
     denominator stays honest);
   - map a failure to a value in the closed `failureCategoryValues` taxonomy
     (extend it additively if a genuinely new category is needed — never a new
     parallel taxonomy).
2. Register it in `scorers/index.ts` `DEFAULT_SCORERS` at the right **severity**
   (the first failing scorer in that order sets the case's `failureCategory`).
3. Add a metric in `metrics.ts` if the axis needs its own rate (with an explicit
   denominator), and a check in `scripts/check-eval-runner.ts`.

## Reproducibility contract

Every run records: dataset version, dataset hash, target id + identity,
evaluator version, scoring version, execution mode, filter, `executedAt`, and a
deterministic `runId`. `executedAt` is the ONLY non-deterministic field and is
excluded from `runId`, so re-running the same configuration is byte-identical.
Bump `SCORING_VERSION` when a scorer's verdict semantics change and
`EVALUATOR_VERSION` when replay behavior changes.

## FUTURE_SYSTEM engine-authored pending-state seed (PROMPT-AI-EVAL-09)

`future-system-adapter.ts` can establish an **engine-authored** pending
clarification / task state BEFORE a real-LLM turn, so the resume and
interruption behaviors are exercisable under a real LLM (EVAL-08 could prove
them deterministically only).

- `pending-state-seed.ts` — a reusable factory of DECLARATIVE seed specs
  (`resumeDateSeed`, `resumeServiceSeed`, `clarifyIntentSeed`,
  `interruptionSeed`). Each spec is a bounded list of DETERMINISTIC setup turns
  (a customer message + the normalized AI decision the engine receives).
- `FutureSystemRunner.seedPendingState({ caseId, businessContext, spec })` —
  replays those setup turns through the REAL Conversation Engine with an
  in-memory AI (**ZERO real inference**), so the ENGINE authors its own
  clarification / booking-offer template into the per-case history. A later
  `runTurn` on the SAME `caseId` resumes from that history through the SAME
  production seams the real turn uses (`derivePendingClarification` +
  `deriveConversationStateFromHistory` + the ONE `mergeConversationState`). It
  returns a `PendingStateSeedAudit` recording what the engine authored and what
  the production seams reconstructed — explicit and auditable, never a second
  state representation.

There is NO second resolver, state machine, fact model, or clarification engine;
the seed only pre-fills the engine's own history. The normal
zero-or-one-generative-call invariant is preserved (seeding is deterministic;
only the measured turns call the LLM).

`clarify-measure.ts` accepts an optional `ResumeInterruptionContext` (the
dataset-driven run passes nothing, so its measurement is byte-for-byte
unchanged). With it, a clarification that re-asks an already-supplied fact is
`RESUME_FAILED`, a lost pending task is `PENDING_TASK_LOST`, and an interruption
that incorrectly escalates is `INTERRUPTION_RECOVERY_FAILED`; a safety-required
handoff is still never a CLARIFY success.

```sh
pnpm check:future-system                                  # 33 offline tests (F23–F33 cover the seed)
pnpm eval:run-future-fixtures -- --provider atria --model <id> --out <dir>
                                                          # bounded real-LLM resume/interruption calibration
```
