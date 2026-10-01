# FlowPilot — Egyptian Evaluation Dataset: Schema, Scenario Matrix & Evaluation Model

> **Design + schema slice (PROMPT-AI-EVAL-DESIGN-01).** This document is the
> canonical design for the evaluation DATA FOUNDATION. It defines a stable,
> extensible data model and scenario coverage matrix. It does **not** generate
> the large dataset, does **not** build the evaluation runner's scoring, does
> **not** integrate JEV, and does **not** change production AI behavior.
>
> Companion to `docs/ai/EVALUATIONS.md` (the low-level deterministic-classifier
> fixtures) and `evaluation/README.md` (the operational layer). Code truth:
> `evaluation/schema/`. Everything here is evaluation-only — **nothing in
> `evaluation/` is imported by production code**; production depends on nothing
> here.

## 1. Purpose and hard boundaries

The goal is a data model that can represent **all sixteen required conversation
classes** — single-turn, multi-turn, long conversations, multi-intent messages,
ambiguity, customer corrections, topic switching, knowledge gaps, legitimate
and unnecessary human handoff, safety/sensitive cases, Egyptian language
variation, rare/low-probability edge cases, and the _future_ behaviors
(clarification, JEV routing, self-improvement) — while remaining valid for both
the **current** system and **future** systems without redesign.

Hard boundaries of this slice (all respected, all verified in §12):

- ❌ No production AI behavior change. No `src/` file is modified.
- ❌ No JEV integration, no Conversation Engine change, no prompt change.
- ❌ No change to `aiIntentValues` / `aiActionValues` / `handoffReasonValues`.
- ❌ No database migration, no UI, no large dataset generation, no runner.
- ✅ Future concepts exist **only** in the evaluation schema and its labels.

## 2. The two-layer label separation (how current and future stay apart)

This is the central design decision. **The production contract is never touched;
the future vocabulary lives beside it, in evaluation-only files.**

| Layer                               | Where                                                    | Values                                                                                                                                                                                                                | Consumed by                                             |
| ----------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **Production**                      | `src/features/conversations/server/ai-contract.ts`       | `aiIntentValues` = GREETING · FAQ · BOOKING · AVAILABILITY · RESCHEDULE · CANCELLATION · HUMAN_REQUEST · AMBIGUOUS; `aiActionValues`; `handoffReasonValues`                                                           | the Conversation Engine, providers, the disclosure gate |
| **Evaluation — current-compatible** | `evaluation/schema/taxonomy.ts` (`currentIntentValues`)  | re-exports the production enums — **never redefined**                                                                                                                                                                 | baseline scoring of the current system                  |
| **Evaluation — semantic/future**    | `evaluation/schema/taxonomy.ts` (`semanticIntentValues`) | the 8 baseline intents **plus** SERVICE_DISCOVERY · SERVICE_INFO · SERVICE_PRICE · BUSINESS_INFO · LOCATION · HOURS · CONFIRMATION · FOLLOW_UP · MULTI_INTENT · TOPIC_SWITCH · KNOWLEDGE_GAP · CLARIFICATION_REQUIRED | dataset labels only                                     |

`baselineCompatibleSemanticIntents` names the exact 1:1 subset. A case that
uses any other label **must** carry `orientation: FUTURE_ARCHITECTURE` —
`groundTruthIsConsistent()` asserts this, and `check:eval-schema` proves it.

So a case carries **two** expectations, strictly separated:

1. `expectedSemanticLabel` — what the customer actually meant (future taxonomy).
2. `expectedCurrentAiOutcome` — the best behavior the _current_ 8-intent
   contract can express, with `architecturalLimitation` marking the case where
   the gap is architectural rather than a defect.

Scoring therefore yields `PASS` / `LIMITATION` / `FAIL` / `SEAM_OWNED`, and
`LIMITATION` is reported separately from `FAIL` — a future system is measured
against the _future_ label, the current system against the _current_ one, and
**the dataset never changes between the two**.

## 3. The Ground Truth structure

`evaluation/schema/ground-truth-schema.ts` defines `GroundTruth`, a canonical
**read model** over the twelve required members. It is a _view_ over
`EvaluationCase` — it stores nothing the case does not already carry, and an
absent optional dimension collapses to `null` / `NONE` ("not asserted"), never
to a violation. That is precisely what lets an `egyptian-v1` case and an
`egyptian-v2` case be read by the same reader.

| Member                          | Field                           | Notes                                                                                    |
| ------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------- |
| semantic intent                 | `semanticIntent`                | evaluation-only taxonomy                                                                 |
| primary intent                  | `primaryIntent`                 | the goal the turn is scored on                                                           |
| secondary intent(s)             | `secondaryIntents`              | unbounded list → multi-intent                                                            |
| expected action                 | `expectedAction`                | human-readable ideal next action                                                         |
| expected handoff                | `expectedHandoff`               | REQUIRED / NOT_REQUIRED / ACCEPTABLE_EITHER + kind + rationale                           |
| expected clarification          | `expectedClarification`         | `ClarificationType`; future behavior label                                               |
| required knowledge              | `requiredKnowledge`             | `KnowledgeRequirement`                                                                   |
| expected entities/facts         | `expectedEntities`              | service(s), provider, date(s), timePreference                                            |
| expected state transition       | `expectedStateTransition`       | from / to journey state, factKey, `isRevision`                                           |
| expected domain action          | `expectedDomainAction`          | evaluation-only; production `AiAction` untouched                                         |
| safety expectation              | `safetyExpectation`             | SAFE / SENSITIVE_MEDICAL / EMOTIONAL_DISTRESS / SECURITY_ATTEMPT                         |
| future-architecture expectation | `futureArchitectureExpectation` | self-service / clarification / knowledge lookup / confirmation / knowledge-gap recording |

The **same ground truth** serves both evaluation targets: the current system is
scored on the members the production contract can express; a future system is
scored on the semantic/clarification/domain-action members. The dataset is
identical in both runs.

## 4. The scenario generation model — semantic-preserving vs semantic-changing

Generation is **never** free-form random text. It follows the required chain:

```
Scenario  →  Semantic Ground Truth  →  Language Profile  →  Behavior Profile
         →  Mutation Strategy  →  Natural-language Variant
```

The gold label is defined **before** any surface text. The critical design
requirement — that semantic-preserving mutations be **distinguishable** from
semantic-changing ones — is realized by an explicit `MutationClass`:

| Class                | Meaning                                                                                                 | Contract                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SURFACE_PRESERVING` | changes only register, orthography, punctuation, spelling                                               | gold label **unchanged**; `goldPreserved: true`; expected outcome inherited verbatim from the scenario                                                                            |
| `SEMANTIC_CHANGING`  | intentionally moves the conversation's semantic state (a contradiction, a changed date, a topic switch) | the variant is emitted from a **different scenario** whose truth describes the NEW state; `goldPreserved: false`; `variantProvenance.inheritsTruthFrom` names the source scenario |

Example (from the required spec): the scenario for «عايز أحجز تنظيف» may
surface-preserving-mutate to «ممكن أحجز تنظيف؟», «عايز احجز تنظيف», «ممكن
معاد للتنظيف؟» — all inheriting the same gold label. A **contradiction**
mutation is `SEMANTIC_CHANGING`: it is emitted from its own scenario whose
`expectedStateTransition.isRevision` is `true` and whose expected outcome
describes the revised fact, so the label moves **with** the meaning, by
construction. A generator must never relabel a surface mutation to "fix" a
mismatch — the fix is always a new scenario.

`variantProvenance` on every case records `origin` (`AUTHORED` /
`SURFACE_MUTATION` / `SEMANTIC_MUTATION`), the mutation kind, its class, and the
scenario the truth was inherited from.

## 5. The multi-turn model and the booking journey

A conversation is **not** reduced to independent messages. Each case carries its
full `messages[]` (senderType · content · turnIndex) up to and including the
evaluated turn, and each turn carries its causal context:

- `conversationState.knownEntities` — the facts the assistant must be holding.
- `conversationState.requiresMemory` — the turn depends on an earlier turn.
- `conversationState.expectedStatus` — the production conversation status.
- `expectedStateTransition` — `{ from, to, factKey, isRevision }`: the causal
  backbone. This is what makes "Turn 4: customer changes information" expressible
  as a state _revision_, not as an unrelated message.

The booking journey is modeled as an explicit state machine the dataset can walk
(`BookingJourneyState`):

```
goal → missing service → service supplied → missing date → date supplied
     → missing time → preference supplied → availability → slot selection
     → confirmation → completed
```

plus the interruption/recovery states `INTERRUPTED`, `RECOVERING`, `ABORTED`.
`NOT_APPLICABLE` covers non-booking turns. A bank authors one scenario per
journey checkpoint; the journey's causal progression is expressed by the
`from → to` transition on each.

## 6. The knowledge model

Two sides, kept distinct:

- `KnowledgeRequirement` (what the turn **needs**): NONE · EXACT_FAQ ·
  PARAPHRASED_FAQ · WEAK_FAQ · NO_FAQ · SERVICE_CATALOG · SERVICE_DETAILS ·
  SERVICE_INFO · PRICE · POLICY · BUSINESS_INFO · AVAILABILITY ·
  MULTIPLE_SOURCES · KNOWLEDGE_GAP · NOT_PRESENT · NOT_EXPOSED ·
  MULTIPLE_PLAUSIBLE.
- `KnowledgeSourceAssertion` (what the context **supplies**): `source`
  (`KnowledgeSource`: FAQ_STORE · SERVICE_CATALOG · SERVICE_DETAILS · PRICE_LIST ·
  BUSINESS_INFO · AVAILABILITY_ENGINE · CANCELLATION_POLICY · MULTIPLE_SOURCES ·
  HUMAN_OPERATOR · NONE) plus `currentChannel` — whether the _current_
  architecture exposes the fact through `AiRequest` at all (`faqs` / `services` /
  `availability` / **`NONE`**). A required fact with `currentChannel: NONE` is a
  documented **architecture gap**, not a dataset defect — this is how a
  knowledge-gap case is represented without building any retrieval system.

No retrieval system is built. The schema only records the expectation.

## 7. The handoff model — true vs unnecessary, scored separately

The ground truth is scenario-defined and **independent of what any system does**
(`expectedHandoff.expectation`: REQUIRED / NOT_REQUIRED / ACCEPTABLE_EITHER +
`kind`). The _observed_ handoff is classified separately by **why** the human got
involved (`HandoffOutcomeClass`):

| Class                       | Meaning                                                            |
| --------------------------- | ------------------------------------------------------------------ |
| `TRUE_HUMAN_REQUIRED`       | a human is genuinely required and one was routed                   |
| `UNNECESSARY_HUMAN_HANDOFF` | the system could have resolved the turn but escalated              |
| `PROVIDER_FAILURE`          | an upstream provider error forced the escalation                   |
| `AI_FAILURE`                | the assistant produced an invalid/empty output                     |
| `KNOWLEDGE_GAP`             | no knowledge backed the answer                                     |
| `AMBIGUITY`                 | the turn was genuinely ambiguous; clarifying/escalating was honest |
| `NO_HANDOFF`                | no handoff occurred                                                |

Only `TRUE_HUMAN_REQUIRED` / `UNNECESSARY_HUMAN_HANDOFF` feed handoff
precision/recall; the rest are reported as **distinct failure channels** in the
evaluation result (`aggregateMetrics.handoffOutcomeClasses`), so a future system
is credited or blamed for the right reason.

## 8. Customer behavior, language, and edge taxonomies

**Customer behavior** (`customerBehaviorProfileSchema`) separates _disposition_
(how the customer behaves — CLEAR · VAGUE · HESITANT · HURRIED · REPETITIVE ·
CORRECTIVE · CONTRADICTORY · EMOTIONAL · POLITE · CURIOUS) from _change-of-state_
(whether they revise a fact already on the table — CHANGES_MIND · CHANGES_DATE ·
CHANGES_SERVICE · CHANGES_PROVIDER · CHANGES_TIME · ASKS_UNRELATED_QUESTION ·
REQUESTS_HUMAN_EXPLICITLY · NONE). Change-of-state is the semantic counterpart of
a `SEMANTIC_CHANGING` mutation: the expected truth must move with the revised
fact.

**Language profile** (`languageProfileSchema`): `register`
(EGYPTIAN_COLLOQUIAL · EGYPTIAN_FORMALISH · MSA · MIXED_EGY_MSA · ARABIZI ·
ARABIC_ENGLISH · ENGLISH) plus `noise` (multi-label — CLEAN · MISSING_HAMZA ·
MISSING_PUNCTUATION · REPEATED_LETTERS · TYPOS · ABBREVIATIONS · SPEECH_TO_TEXT ·
INFORMAL_PUNCTUATION · VERY_SHORT · FRAGMENTED · EMOJI · KEYBOARD_MISTAKE ·
ARABIZI · MIXED_LANGUAGE · **SPELLING_VARIATION**). None of these categories is
hard-coded into the production AI — they are dataset labels only.

**Edge taxonomy** — 51 categories, arranged by family (see
`edgeCategoryValues`): a normal core; comprehension (MULTI_INTENT · AMBIGUOUS ·
CONTEXT_DEPENDENT · MISSING_INFORMATION · IMPLICIT_REFERENCE · …); conversation
behavior (TOPIC_SWITCH · SELF_CORRECTION · CONTRADICTION · STATE_RECOVERY ·
LONG_CONTEXT · …); knowledge (KNOWLEDGE_GAP · …); handoff (HANDOFF_*); safety
(SENSITIVE · ADVERSARIAL · SECURITY_INJECTION · PROMPT_INJECTION); language
(LANGUAGE_VARIATION · TYPO · ARABIZI · CODE_SWITCH · …); and domain-specific
(BOOKING_EDGE · AVAILABILITY_EDGE · RESCHEDULE_EDGE · CANCELLATION_EDGE · …).

**Rarity** (`rarityValues`): COMMON · UNCOMMON · RARE · **EXTREMELY_RARE**. Rare
cases are represented **on purpose** — the evaluation goal is robustness, not
only average-case performance.

## 9. The coverage matrix — guidance, not combinatorial explosion

`evaluation/schema/coverage-matrix.ts`. The required 11 dimensions are each
profiled **independently** (`intent`, `language`, `customer-behavior`,
`conversation-length`, `multi-intent`, `ambiguity`, `knowledge`, `booking-state`,
`handoff`, `safety`, `edge-rarity`), plus a small set of **curated joint cells**
— the combinations that actually carry signal — are declared explicitly and
checked for population.

The binding rule for future generators: **never enumerate the Cartesian
product.** Multi-label dimensions (multi-intent, edge categories, behavior) are
profiled by occupancy, never by exclusive partition, which is what keeps the
matrix a guidance tool instead of a million-cell table. `describeCoverage()`
returns the full profile including `gaps` (unpopulated vocabulary members) and
`emptyCuratedCells` (the highest-value authoring targets);
`recommendAuthoringTargets()` returns the ordered authoring plan: **empty curated
cells first** (highest signal), then unpopulated vocabulary members (breadth),
then the thinnest populated members (depth).

An `[UNLISTED]` marker surfaces drift: a member the case data occupies that the
vocabulary does not declare — a signal to extend the vocabulary, never a silent
extra cell.

## 10. Versioning rules — forward compatibility by construction

`evaluation/schema/versioning.ts`. Three rules, all structurally enforced:

1. **The schema is additive-only.** Every extensible sub-object is
   `.passthrough()` and every new ground-truth block is OPTIONAL. A field may be
   added; never deleted, renamed, or narrowed. `assertDatasetVersion()` proves
   this for a version pair: every case of the _older_ dataset must still validate
   under the current schema, else the verdict is `INCOMPATIBLE` — a **design
   failure to fix in the schema**, not a data problem to fix in the dataset.
2. **The runner is version-agnostic.** It loads
   `evaluation/datasets/<version>/<version>.dataset.json` by name and reads cases
   through `groundTruthFromCase()`, which collapses absent dimensions to "not
   asserted". A new version can only ADD cases or POPULATE previously-optional
   fields — it cannot require an engine redesign.
3. **The labels are additive-only.** A taxonomy value may be added, never removed
   or renamed. A rename is a NEW value plus the old one retained (marked
   deprecated via `isDeprecatedTaxonomyValue`), because historical reports
   reference values by string.

Scenario ids are **stable forever**: corrected ground truth is a **new** id, with
the old id kept and its revision recorded. Case ids are
`<scenarioId>::<variantKey>`. `NEW_DATASET_VERSION_STEPS` is the documented
checklist (also in `evaluation/README.md`).

## 11. The evaluation result model — comparing current vs future

`evaluation/schema/evaluation-result-schema.ts`. The comparability contract:

- **`SystemIdentity`** — the subject: `kind` (`CURRENT_SYSTEM` /
  `FUTURE_SYSTEM`) + optional `systemVersion` (release tag) · `promptVersion` ·
  `modelProvider` · `routerVersion` · `contextBuilderVersion` · `note`. The only
  required member is `kind`, so a minimal offline run (deterministic classifier,
  no provider) still validates — and a _future_ run (a JEV router, a
  clarification step) is just a different subject over the _same_ dataset.
- **`RunIdentity`** — `runId` · `datasetVersion` · `scenarioVersion` ·
  `executedAt` · `offline`.
- **`CaseResultRecord`** — `caseId` + the ground-truth **snapshot** + the actual
  outcome + `verdict` + `failureCategory` (the closed failure taxonomy:
  INTENT_MISCLASSIFIED · HANDOFF_MISSED · HANDOFF_UNNECESSARY ·
  EXTRACTION_HALLUCINATED · KNOWLEDGE_FABRICATED · CLARIFICATION_NOT_ASKED ·
  CONTEXT_LOST · SAFETY_VIOLATION · MALFORMED_OUTPUT · PROVIDER_FAILURE · …).
  Keeping the categories closed is what makes runs comparable across dataset
  _and_ system versions.
- **`compareRuns()`** — computes the comparison **only over the case ids both
  runs share**: cases added in a newer dataset are `addedCaseIds` (dataset
  growth), never regressions in the older run's numbers; per-metric `deltas`
  are sign-normalized so "positive = candidate better" holds even for the
  lower-is-better rates; and `regressions` / `improvements` are the case-level
  lists to triage first.

## 12. Self-improvement support — represented, not implemented

`evaluation/schema/self-improvement-schema.ts` is **schema only**. No pipeline,
service, queue, cron, or production import exists; the production knowledge store
(`Business.faqs`) is untouched. It models the lifecycle as labels a future slice
would emit:

```
KNOWLEDGE_GAP_DETECTED → REPEATED_QUESTION_PATTERN → HUMAN_RESOLUTION
  → CANDIDATE_ANSWER → HUMAN_APPROVED_ANSWER → REGRESSION_CASE_DERIVED
                                       ↘ REJECTED (terminal)
```

The record carries `questionShape` (a normalized representative phrasing — never
raw customer PII or a verbatim transcript), the knowledge requirement and
expected source, `recurrenceCount` (the repeated-pattern signal), the human
resolution, the candidate answer, the approval fields, and the derived regression
case. The **binding safety property** is `selfImprovementRecordIsConsistent()`:
a candidate answer is never knowledge until a human approves it (`approvedBy` +
`approvedAt`), and a regression case is never derived from an unapproved
candidate. A future regression case derived from a gap is how the dataset closes
the loop — the case that would have reopened the gap is authored from the
approved answer.

The dataset side of this is a label, nothing more:
`futureArchitectureExpectation.expectKnowledgeGapRecorded`.

## 13. Files — what this slice contains

| Artifact                                 | Path                                                      |
| ---------------------------------------- | --------------------------------------------------------- |
| Taxonomy (current + future vocabularies) | `evaluation/schema/taxonomy.ts`                           |
| Case + dataset schema                    | `evaluation/schema/dataset-schema.ts`                     |
| Scenario schema                          | `evaluation/schema/scenario-schema.ts`                    |
| Ground Truth schema                      | `evaluation/schema/ground-truth-schema.ts`                |
| Evaluation result schema                 | `evaluation/schema/evaluation-result-schema.ts`           |
| Self-improvement provenance schema       | `evaluation/schema/self-improvement-schema.ts`            |
| Coverage matrix                          | `evaluation/schema/coverage-matrix.ts`                    |
| Versioning rules                         | `evaluation/schema/versioning.ts`                         |
| Design document (this file)              | `docs/ai/EVALUATION_DESIGN.md`                            |
| Schema validation harness                | `scripts/check-eval-schema.ts` · `pnpm check:eval-schema` |

**Additive extensions to existing artifacts** (all backward-compatible —
`egyptian-v1`'s 945 cases still validate and regenerate byte-identically):
`taxonomy.ts` (new vocabularies + `EXTREMELY_RARE` + the 13 missing edge
categories + `SPELLING_VARIATION`), `dataset-schema.ts` + `scenario-schema.ts`
(optional ground-truth blocks + `variantProvenance`), `scenario-builders.ts`
(optional inputs), and `generator/compose.ts` (forwards the new blocks and emits
provenance).

## 14. How future dataset generators MUST use these schemas

Binding rules for any generator of `egyptian-v2` and beyond:

1. **Gold label first.** Define `semanticLabel` and `expectedHandoff` before any
   surface text. An LLM may help _author utterances_; it is never the source of
   a label. Every case carries a non-empty `rationale`.
2. **Use the builders.** `scenario-builders.ts` factories fill the mechanical
   defaults; only the gold label and the edge categories are mandatory input.
3. **Declare the mutation class.** A mutation listed on a scenario must match the
   scenario's `mutationClass`. A semantic-changing mutation is emitted from its
   **own scenario** with `expectedStateTransition.isRevision: true` — never by
   relabeling a surface mutation.
4. **Populate the extended ground truth where it is meaningful** —
   `bookingJourneyState`, `expectedStateTransition`, `expectedClarification`,
   `expectedDomainAction`, `safetyExpectation`, `customerBehavior`,
   `knowledgeSourceAssertion`. All are optional; populate them when the case
   actually exercises the axis.
5. **Keep the layers straight.** Any intent outside the 8 baseline ones requires
   `orientation: FUTURE_ARCHITECTURE` (`groundTruthIsConsistent`).
6. **Never invent production values.** `expectedCurrentAiOutcome` must stay
   inside `aiIntentValues` / `aiActionValues` / `handoffReasonValues`
   (`check:eval` D6 proves it for every case).
7. **Rare is intentional.** Use `RARE` / `EXTREMELY_RARE` deliberately —
   robustness cases are first-class, not leftovers.
8. **Consult the matrix before authoring.** Run `describeCoverage()` on the
   current dataset, then `recommendAuthoringTargets()`; author for the empty
   curated cells and the unpopulated vocabulary members. Never enumerate the
   product.
9. **Version properly.** Register the version in `evaluation/datasets/index.ts`,
   follow `NEW_DATASET_VERSION_STEPS`, never reuse a scenario id with different
   truth, never remove a taxonomy value.
10. **Keep it offline and safe.** No DB, no network, no LLM call, no API keys, no
    key-shaped values. `pnpm security` must stay clean.

## 15. Verification

- `pnpm check:eval-schema` — the schema-validation harness (§13): current-intent
  case, future evaluation-only intent case, multi-intent case, multi-turn case,
  knowledge-gap case, legitimate handoff, unnecessary handoff, rare edge case,
  Arabizi case, adversarial case, booking journey state — plus forward
  compatibility, label separation, self-improvement consistency, and coverage.
- `pnpm check:eval` — unchanged, 17/17, including D6 (expected outcomes stay
  inside the production enums) and D6b (the production intent family is still
  exactly 8 members).
- `pnpm verify` (lint + typecheck + format + build) and `pnpm security`.

## 16. Design risks discovered

1. **Optional-everywhere can hide under-population.** Because every new
   ground-truth block is optional (required for forward compatibility), a
   generator can produce a dataset that technically validates while populating
   none of the new axes. Mitigation: `describeCoverage()` reports unpopulated
   members as gaps, and `check:eval-schema` asserts the curated cells are
   populated.
2. **Closed failure categories can drift from real failure modes.** A future
   failure the taxonomy cannot name will be filed into the nearest bucket and
   become invisible. Mitigation: `failureCategoryValues` is additive-only, so a
   new category is a new value; the comparison layer ignores unknown values
   rather than failing.
3. **`EXTREMELY_RARE` is easy to never author.** The cheapest generator behavior
   is to produce common cases. Mitigation: `recommendAuthoringTargets()` ranks
   thin/rare members explicitly; the matrix makes absence visible.
4. **Self-improvement labels can become a promise.** The schema describes a
   pipeline that does not exist. Mitigation: the file is schema-only with no
   imports from production, the approval gate is asserted as a consistency rule,
   and the slice hard-stop forbids implementing the loop.
5. **The `[UNLISTED]` drift marker depends on the vocabularies being complete.**
   If a vocabulary omits a member the data uses, the marker fires — which is the
   intent, but it means vocabulary edits and dataset edits must move together.
6. **Scenario-id immortality constrains corrections.** Fixing a mislabeled
   scenario requires a new id, which fragments the historical narrative.
   Mitigation: `NEW_DATASET_VERSION_STEPS` documents this; the report layer keys
   on case ids, which remain stable.
