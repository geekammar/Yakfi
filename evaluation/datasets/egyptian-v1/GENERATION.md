# `egyptian-v1` — Generation & Reproducibility

> The Egyptian Arabic conversation dataset behind FlowPilot's AI evaluation.
> **Dataset only** — nothing in `evaluation/` is imported by production code,
> and nothing in this file describes a production behavior change.
>
> Slice: `PROMPT-AI-EVAL-02` · version: `egyptian-v1` · seed: `20260928`

## 1. What the dataset is

A machine-readable, versioned set of **evaluation cases**. Each case is one
turn of an Egyptian customer conversation carrying its own ground truth:
what the customer meant, what the ideal assistant should do, whether a human
is genuinely required, what the turn must know, and how it moves the booking
journey's state.

```
Scenario ──► Ground Truth ──► Language Profile ──► Customer Behavior
        ──► Conversation Construction ──► Controlled Mutation
        ──► Validation ──► Dataset Case
```

The semantic gold label is **always** defined before any surface text. An LLM
may help author utterances; it is never the source of a label. Utterances are
hand-authored Egyptian phrasings, and every mutation is a deterministic,
seeded string transform that provably cannot move the meaning.

## 2. The numbers

| measure                             | value                   |
| ----------------------------------- | ----------------------- |
| scenarios                           | **278** (12 banks)      |
| cases                               | **1933**                |
| atomic single-turn                  | **1273** (target ≥ 500) |
| multi-turn conversations            | **660** (target ≥ 300)  |
| adversarial / rare-edge cases       | **256** (target ≥ 200)  |
| multi-intent turns                  | **321**                 |
| EXTREMELY_RARE / RARE               | **113 / 377**           |
| coverage dimensions fully populated | **11 / 11**             |
| curated joint cells populated       | **10 / 10**             |
| remaining coverage gaps             | **0**                   |

## 3. The scenario banks

Bank order in `index.ts` is **load-bearing** (see §5). The five `v1.0` banks
come first and regenerate their cases identically; the seven
`PROMPT-AI-EVAL-02` banks only append.

| bank                              | prefix | scenarios | cases | what it covers                                                                                                                       |
| --------------------------------- | ------ | --------: | ----: | ------------------------------------------------------------------------------------------------------------------------------------ |
| `scenarios-single-turn.ts`        | `st-`  |        29 |     — | greetings, FAQ exact/paraphrase/weak/missing, booking, availability, reschedule, cancellation, human request, sensitivity, ambiguity |
| `scenarios-language-behavior.ts`  | `lb-`  |        19 |     — | the register matrix (MSA / Arabizi / English / STT / mixed)                                                                          |
| `scenarios-extra.ts`              | `ex-`  |        18 |     — | per-FAQ paraphrases, availability, edges                                                                                             |
| `scenarios-multi-turn.ts`         | `mt-`  |        61 |     — | booking journeys, memory, topic drift, corrections                                                                                   |
| `scenarios-adversarial.ts`        | `adv-` |        39 |     — | rare-but-plausible edges + security injection                                                                                        |
| **`scenarios-multi-intent.ts`**   | `mi-`  |        15 |   163 | multi-goal turns incl. the **critical** `booking + service discovery` family                                                         |
| **`scenarios-extended-truth.ts`** | `jt-`  |        19 |   184 | the full `BookingJourneyState` machine, revisions, interruption/recovery                                                             |
| **`scenarios-knowledge.ts`**      | `kn-`  |        15 |   169 | the complete knowledge model + self-improvement labels                                                                               |
| **`scenarios-ambiguity.ts`**      | `am-`  |        11 |    70 | the four ambiguity classes + clarification expectations                                                                              |
| **`scenarios-handoff.ts`**        | `ho-`  |        16 |   131 | the eight handoff classes, deliberately heavy on NOT_REQUIRED                                                                        |
| **`scenarios-language-edges.ts`** | `lg-`  |        16 |   133 | Arabizi / code-switch / STT / spelling / emoji / very short / long                                                                   |
| **`scenarios-rare-edges.ts`**     | `re-`  |        14 |   138 | EXTREMELY_RARE, self-correction, injection, topic return                                                                             |

## 4. Reusable generation artifacts

### 4.1 Mutation strategies — `evaluation/generator/mutations.ts`

Fifteen seeded, deterministic, **gold-preserving** transforms. A `(text, seed)`
pair always yields the same output, and no transform here can move the
semantic label — intentional meaning changes are separate scenarios (§6).

| kind                          | effect                                                       |
| ----------------------------- | ------------------------------------------------------------ |
| `MISSING_HAMZA`               | strips hamza forms (`أ`→`ا`, `ؤ`→`و`, `ئ`→`ي`)               |
| `DROP_PUNCTUATION`            | removes all punctuation                                      |
| `REPEAT_LETTERS`              | elongates a long vowel (`عايز`→`عاااايز`)                    |
| `TYPO`                        | swaps two adjacent letters inside a long word                |
| `ARABIZI`                     | Latin-script Egyptian (`عايز`→`3ayez`, `الخميس`→`el khamis`) |
| `MIX_ENGLISH`                 | code-switch injection (`موعد`→`موعد (appointment)`)          |
| `INFORMAL_PUNCTUATION`        | `؟؟` / `!!` / `...` tails                                    |
| `SPEECH_TO_TEXT`              | filler prefix, no punctuation, run-on                        |
| `ABBREVIATE`                  | Egyptian chat abbreviations                                  |
| **`CHAR_OMISSION`**           | drops one interior character                                 |
| **`KEYBOARD_MISTAKE`**        | neighbouring-key slip on the Arabic layout                   |
| **`SPACING`**                 | joins two words or splits one with a stray space             |
| **`PUNCTUATION_DUPLICATION`** | duplicates terminal punctuation                              |
| **`SPELLING_VARIATION`**      | `تنظيف`↔`تنضيف`, `موعد`↔`ميعاد`, `ة`↔`ه`                     |
| **`MIXED_NUMERALS`**          | Latin↔Arabic-Indic digits (never changes the value)          |

Bold = added by `PROMPT-AI-EVAL-02`. Every emitted case records which mutation
produced it in `mutationsApplied` and `variantProvenance.mutationKind`, so a
future engineer can ask "why does this case exist?" and get an answer.

### 4.2 Deterministic configuration

- **Seed**: `EGYPTIAN_V1_SEED = 20260928` in
  `evaluation/datasets/egyptian-v1/index.ts`.
- Each mutation derives its own seed from
  `hashSeed("<scenarioId>|<utteranceIndex>|<mutation>")`, so the whole dataset
  is a pure function of the source files.
- `pnpm eval:generate` is idempotent: regenerating from the same sources
  produces the identical artifact byte-for-byte (proven by check `D4`).

```sh
pnpm eval:generate              # scenarios → egyptian-v1.dataset.json
pnpm check:eval                 # 25 dataset + runner invariants (offline)
pnpm check:eval-schema          # the schema harness
pnpm eval:coverage              # → reports/egyptian-v1/coverage-report.{json,md}
```

All commands are **fully offline**: no database, no network, no LLM call, no
API keys, no secret-shaped values.

## 5. Reproducibility contract (and the one correction it required)

The banks in `collectEgyptianV1Scenarios()` are ordered so the `v1.0` banks
expand **first and in their original order**. Every case the committed `v1.0`
artifact contained (945 cases / 171 scenarios) is regenerated at the same
position with the same case id, and `PROMPT-AI-EVAL-02` banks only **append**.

**One deliberate correction.** The label-separation rule from
`docs/ai/EVALUATION_DESIGN.md` §2 requires a case that uses a future-only
semantic intent (`HOURS`, `FOLLOW_UP`, `SERVICE_INFO`, `SERVICE_DISCOVERY`,
`KNOWLEDGE_GAP`, `CLARIFICATION_REQUIRED`, …) to carry
`orientation: FUTURE_ARCHITECTURE` — asserted by
`groundTruthIsConsistent()`. 255 of the 945 previously-committed cases
violated it, because the scenario builder defaulted `orientation` to
`BASELINE_COMPATIBLE` whenever the author did not set it. Rather than hand-patching
29 scenario files, the builder now **derives** the orientation from the labels
(`requiredOrientation()` in `scenario-builders.ts`) and throws on a genuine
contradiction, so the rule is structurally guaranteed for every future bank.
The correction changed **only** the `orientation` field of those 255 cases —
case ids, gold labels, entities, handoffs, text, and ordering are untouched.
This is the only field-level change to previously-committed data.

The previous slice's baseline reports
(`evaluation/reports/egyptian-v1/baseline-report.*`, `run-manifest.json`,
`FINDINGS.md`) describe the **945-case v1.0 snapshot** and were left untouched
(regenerating them is baseline analysis, which this slice's hard stop forbids).
The next slice must re-run `pnpm eval:baseline`.

## 6. Semantic-changing vs surface-changing mutations

`MutationClass` keeps the distinction explicit:

- **`SURFACE_PRESERVING`** — every transform in `mutations.ts`. The gold label
  is unchanged; `goldPreserved: true`; the expected outcome is inherited
  verbatim from the scenario.
- **`SEMANTIC_CHANGING`** — an intentional move of the conversation's semantic
  state (a contradiction, a changed date, a topic switch). These are **never**
  emitted by mutating text. They are their **own scenarios** whose ground truth
  describes the NEW state, with `expectedStateTransition.isRevision: true` and
  a matching `customerBehavior.changeOfState`. The label moves _with_ the
  meaning, by construction.

See `jt-revise-date` (CHANGES_DATE), `jt-revise-service` (CHANGES_SERVICE),
`jt-revise-time` (CHANGES_TIME), `jt-revise-provider` (CHANGES_PROVIDER),
`re-contradicts-stated-service`, `re-self-correction-date`.

## 7. The booking journey in data

`scenarios-extended-truth.ts` walks every `BookingJourneyState` checkpoint with
an explicit `expectedStateTransition` (`from → to`, `factKey`, `isRevision`):

```
NOT_APPLICABLE → GOAL_STATED → MISSING_SERVICE → SERVICE_SUPPLIED
              → MISSING_DATE → DATE_SUPPLIED → MISSING_TIME → TIME_SUPPLIED
              → AVAILABILITY_RESOLVED → SLOT_SELECTION → CONFIRMATION
              → COMPLETED
            plus: INTERRUPTED → RECOVERING, ABORTED → GOAL_STATED
```

`evaluation/schema/booking-journey.ts` is the reusable validator: it names the
legal moves and rejects an impossible one (e.g. `CONFIRMATION →
MISSING_SERVICE`) as a dataset defect. A self-transition is always legal — it
is either a waiting state or a fact revision. Check `D15` proves all 300
transition-bearing cases are possible moves.

## 8. The handoff split

`expectedHandoff.expectation` is scenario-defined truth, independent of what
any system does:

| ground truth        | meaning                                                                     | cases |
| ------------------- | --------------------------------------------------------------------------- | ----: |
| `REQUIRED`          | a human is genuinely needed (`HUMAN_REQUEST` / `SENSITIVE` / `UNSUPPORTED`) |   218 |
| `NOT_REQUIRED`      | a competent assistant resolves this itself — a handoff is **unnecessary**   |   619 |
| `ACCEPTABLE_EITHER` | routing is fine, so is self-service (booking creation today)                |  1096 |

The `UNNECESSARY_HUMAN_HANDOFF` family is authored heavily on purpose, because
that is where the current FlowPilot behavior is weakest: a booking-shaped word
triggers `booking_handoff` even when the customer's turn was fully answerable
(`mi-booking-plus-discovery`, `ho-unnecessary-*`, `kn-service-catalog`).

The eight `HandoffOutcomeClass` values map to the dataset as follows
(the class itself is an _observed_ evaluation-result label;
the dataset carries the ground-truth side):

| class                                     | dataset representation                                                        |
| ----------------------------------------- | ----------------------------------------------------------------------------- |
| `TRUE_HUMAN_REQUIRED`                     | `REQUIRED` + `HUMAN_REQUEST`/`SENSITIVE` + `LEGITIMATE_HANDOFF`               |
| `UNNECESSARY_HUMAN_HANDOFF`               | `NOT_REQUIRED` + `UNNECESSARY_HANDOFF`                                        |
| `KNOWLEDGE_GAP`                           | `KNOWLEDGE_GAP` requirement + `knowledgeSourceAssertion.currentChannel: NONE` |
| `AMBIGUITY` (`AMBIGUOUS_BUT_CLARIFIABLE`) | `NOT_REQUIRED` + `AMBIGUOUS_CLARIFIABLE` + a `CLARIFY_*` label                |
| `AI_FAILURE`                              | `ho-ai-failure-retry` — empty assistant turns in history, truth = resume      |
| `PROVIDER_FAILURE`                        | `ho-provider-failure-retry` — a transient-fault message, truth = retry        |
| `SENSITIVE`                               | `SENSITIVE_MEDICAL` / `EMOTIONAL_DISTRESS` + `REQUIRED` + `SENSITIVE` edge    |
| `CUSTOMER_REQUESTED_HUMAN`                | `REQUIRED` + `HUMAN_REQUEST` + `REQUESTS_HUMAN_EXPLICITLY`                    |

## 9. Self-improvement support (represented, not implemented)

For every `KNOWLEDGE_GAP` case the dataset sets
`futureArchitectureExpectation.expectKnowledgeGapRecorded` (123 cases) plus the
two-sided knowledge model: what the turn **needs**
(`expectedKnowledgeRequirement`) and what the context **supplies**
(`knowledgeSourceAssertion.source` + `currentChannel`, where `NONE` means a
required fact has no channel today — a documented **architecture gap**, not a
dataset defect).

That is exactly the evidence a future loop needs — customer question → gap →
human answer → approved candidate → derived regression case. No pipeline,
queue, service, or cron exists; `Business.faqs` is untouched; the approval gate
(`selfImprovementRecordIsConsistent()`) is asserted by the schema harness only.

## 10. Validation

`pnpm check:eval` — 25 checks, all passing:

```
D1  scenarios validate          D11 malformed output rate is zero
D2  ids unique                  D12 seam-owned turns excluded from metrics
D3  dataset validates           D13 size targets (1273 / 660 / 256)
D4  deterministic rebuild       D14 EVALUATIONS.md ordering invariants
D5  taxonomy-only labels        D15 journey transitions are possible moves
D6  production enums untouched  D16 label separation holds for every case
D7  non-empty rationale         D17 provenance + mutation metadata
D8  gold-preservation           D18 sensitive ⇒ REQUIRED + a safety edge
D9  runner scores every case    D19 extended truth populated + cells covered
D10 no self-authored injection  D20 duplicate control (no unjustified repeats)
```

`pnpm check:eval-schema` adds the schema-level proof (forward compatibility,
label separation, self-improvement consistency, coverage).

## 11. Adding a case

1. **Gold label first** — pick the scenario's `semanticLabel`, `handoff`, and
   `knowledgeRequirement` before writing any Arabic.
2. Use the builders (`singleTurn` / `multiTurn` / `adversarial` + `egy` / `u`).
   The builder derives `orientation` for you and refuses a contradiction.
3. Populate the extended blocks where they are meaningful
   (`customerBehavior`, `expectedStateTransition`, `expectedDomainAction`,
   `expectedClarification`, `knowledgeSourceAssertion`,
   `futureArchitectureExpectation`).
4. Append to an existing bank **or** add a new bank at the end of
   `collectEgyptianV1Scenarios()` — never reorder or delete one.
5. `pnpm eval:generate && pnpm check:eval && pnpm eval:coverage`.
6. A scenario id is **stable forever**. Corrected ground truth is a NEW id.
