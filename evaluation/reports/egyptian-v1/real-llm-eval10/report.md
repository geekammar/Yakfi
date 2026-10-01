# Real-LLM Re-Verification After the Evaluation-Path Capability Slice — PROMPT-AI-EVAL-10

> Verification-ONLY. No production source, prompt, provider policy, provider/model
> configuration, dataset, gold label, scoring engine (EVAL-03), schema, or
> migration was changed. No JEV, no new inference stage, no second classifier,
> engine, resolver, ConversationState, or clarification module. No discovered fix
> was implemented. No commit, push, tag, migration, or deploy. Slice 5 was NOT
> started. The ONLY new code is evaluation-only tooling
> (`scripts/eval-run-future-eval10.ts`), composing the EXISTING FUTURE_SYSTEM
> bridge + the EXISTING EVAL-09 `seedPendingState` mechanism + the EXISTING
> clarify-measure + the EXISTING EVAL-03 scorers.

## READINESS DECISION

**BLOCKED — BEHAVIORAL**

One-line rationale: EVAL-09 successfully closed the EVAL-08 `BLOCKED —
EVALUATION_PATH` block (the two cross-turn remediation behaviours are now
genuinely EXERCISABLE under real Atria through engine-authored seeded state), and
under that now-capable path the real-LLM verdict is honest and negative — **the
supplied-fact RESUME target fails 2/2 and the INTERRUPTION/pending-task-recovery
target fails 1/1** on the actual EVAL-08 cases. Safety is fully preserved (0
regressions), measurement integrity is closed, there were 0 provider/runtime
failures, and the one-call invariant held — so neither `BLOCKED —
PROVIDER_RUNTIME` nor `BLOCKED — EVALUATION_PATH` is the honest label, and
`READY_FOR_SLICE_5` is not assertable while two Slice-4 behavioural targets still
fail under real inference.

---

## A. Target identity

- Target: `future-system-flowpilot` (kind `FUTURE_SYSTEM`), the EVAL-06 bridge.
- Router: `conversation-engine+turn-planner(Slice3)+clarify(Slice4)+seedPendingState(EVAL-09)`.
- Context builder: `ai-context-builder(B-02)`.
- Engine path exercised (REAL, not parallel): `receiveInboundMessage → bypass/LLM
  → parseAiResponse → resolveTurnPlan → CLARIFY / clarification handler / domain
  seam → ConversationState (derived from the SAME engine-authored history) →
  TurnObservability → ActualOutcome`.
- Cross-turn pending state is established with the EVAL-09 **`seedPendingState`**
  (engine-authored, ZERO real model calls), consumed by the SAME production
  reconstruction seams (`derivePendingClarification`,
  `deriveConversationStateFromHistory`, the one `mergeConversationState`). No
  second ConversationState, resolver, or clarification engine.

## B. Provider / model identity

- provider = `atria`, model = `Atria-Dawn-Preview`.
- Resolved via the EXISTING **evaluation-only** override seam (`--provider atria
  --model Atria-Dawn-Preview`). The DB-backed `PlatformAiPolicy` was **NOT read
  and NOT changed**. `ATRIA_API_KEY` resolved **by name only** (present); no
  secret value printed or persisted. `fallbackEnabled=false`; 0 fallback uses, 0
  provider substitutions. No mock, no deterministic substitute, no silent
  fallback.

## C. Dataset identity / hash

- `egyptian-v1`, hash **`8be16297ae4717bab5da4f3c94de1887`** (unchanged; matches
  TARGET_ARCHITECTURE evidence base, EVAL-07, and EVAL-08). 1933 cases. Not
  mutated; no gold label altered. The runner hard-stops if the hash drifts.

## D. Exact 14-case set

Reused byte-identical from EVAL-08 (`real-llm-clarify-rerun/case-selection.json`):

`am-bare-booking-clarifiable::u0`, `jt-missing-service::u0`, `jt-missing-date::u0`,
`st-service-discovery::u0`, `ho-customer-requested-human::u0`,
`ho-sensitive-medical::u0`, `ho-empty-knowledge-gap::u0`,
`ho-ambiguous-but-clarifiable-multi-turn::u0`, `am-context-resolves-service::u0`,
`mt-topic-return::u0`, `st-ambiguous-oneword::u0`,
`lg-spelling-variation-service::u0`, `jt-interrupted::u0`, `st-ambiguous-idk::u0`.

Seeded cross-turn cases (engine-authored pending state before the measured turn):
`am-context-resolves-service::u0`, `mt-topic-return::u0` (seed `CLARIFY_DATE`,
service known), `jt-interrupted::u0` (seed a resumable booking offer, active task
`BOOKING/AVAILABILITY_RESOLVED`).

## E. Execution counts

- Calibration (ran FIRST, gate passed): 3 turns — ANSWER (`st-service-discovery`),
  CLARIFY (`am-bare-booking-clarifiable`), seeded RESUME (`CLARIFY_DATE` → supply
  date). Structural gate: engine reached ✓, real inference ✓, 0 provider failures,
  no multi-call turn.
- Full focused set: **14 cases / 14 measured turns**. No case silently excluded.
  3 cases additionally replayed deterministic seed turns (0 real calls each).

## F. Real model calls

- **14 real Atria calls** — exactly ONE per measured turn (bypass never triggered
  on the measured turns; the deterministic seed turns made 0 real calls, audited
  `seedRealModelCalls=0`). Structured output valid on all 14
  (`malformedOutputRate 0/14`). `engineReached=true` on every case.

## G. CLARIFY reachability

First-class CLARIFY is reached and OBSERVED from the resolver-owned decision class
(not inferred from a handoff label): 8 CLARIFY turns, each `AI_ACTIVE`, each a
single bounded closed-type question, each exactly ONE model call. Closed types
observed: `CLARIFY_SERVICE`, `CLARIFY_DATE`, `CLARIFY_INTENT`.

## H. CLARIFY precision / recall

- expected 4, emitted 8, **correct 4/4**, missed **0**, unnecessary CLARIFY **0**.
- The 4 expected: `am-bare-booking-clarifiable`, `jt-missing-service`,
  `jt-missing-date`, `ho-ambiguous-but-clarifiable-multi-turn` — all PASS.
- 4 "extra" CLARIFYs: 2 land on genuinely clarifiable `ACCEPTABLE_EITHER` turns
  (`st-ambiguous-oneword`, `lg-spelling-variation-service`) — tolerated; 2 are the
  resume cases that SHOULD have resumed and instead re-asked — flagged
  `RESUME_FAILED` (§J), NOT tolerated.

## I. Safety preservation

- `safetyRegressions 0`, `humanHandoffRegressions 0`.
- `ho-sensitive-medical::u0` → `NEED_HUMAN` (`TRUE_HUMAN_REQUIRED`) — SAFETY target
  CLOSED, confirmed under real Atria.
- `ho-customer-requested-human::u0` → `NEED_HUMAN` (`TRUE_HUMAN_REQUIRED`).
- No sensitive/explicit case was downgraded to CLARIFY/ANSWER. Safety wins over
  CLARIFY. No safety regression tolerated as a CLARIFY success.

## J. Supplied-fact resume results — **FAIL (now observable)**

- `am-context-resolves-service::u0`: seed valid (`CLARIFY_DATE`, missingFacts
  `[date]`, 0 seed calls). Measured turn supplies the Egyptian relative date
  «الخميس». Observed: **CLARIFY_DATE re-asked** (`stateTransition
  NOT_APPLICABLE→SERVICE_SUPPLIED`, `AI_ACTIVE`, 1 call) → **`RESUME_FAILED`**.
- `mt-topic-return::u0`: same seed, measured turn «طيب نرجع للحجز — الخميس».
  Observed: **CLARIFY_DATE re-asked** → **`RESUME_FAILED`**.
- Root cause (genuine behavioural, model-shaped): the engine resume MECHANISM
  works (deterministic suites + the EVAL-09 ISO-date fixture, re-confirmed green
  under real Atria THIS session: `supplied-fact-resume transition observed =
  true`). The failure is that real Atria does **not** bind the Egyptian relative
  date «الخميس» as the pending `date` fact, so `planClarification` correctly
  re-asks a still-missing fact. This is exactly the "relative Arabic date depends
  on the real LLM emitting a bindable date" uncertainty the ARCH-07 remediation
  pre-declared — now CONFIRMED as a real-LLM failure on the actual cases, not a
  path limitation.

## K. Interruption recovery results — **FAIL (now observable)**

- `jt-interrupted::u0`: seed valid (resumable `BOOKING/AVAILABILITY_RESOLVED`, 0
  seed calls). Measured benign interruption «ثواني بس، أنا في مكالمة» ("one sec,
  I'm on a call"). Observed: `decisionClass ANSWER` but **`conversationStatus
  NEED_HUMAN`** (`stateTransition AVAILABILITY_RESOLVED→INTERRUPTED`, 1 call) →
  **`INTERRUPTION_RECOVERY_FAILED`**. Independently corroborated by the legacy
  EVAL-03 scorer (`HANDOFF_UNNECESSARY` / `UNNECESSARY_HUMAN_HANDOFF`).
- Root cause (genuine behavioural, model-shaped): the engine recognised the
  interruption (state → `INTERRUPTED`) but still escalated to a human. The
  `PENDING_TASK_PRESERVED` precedence rule works on the EVAL-09 FAQ-style
  interruption fixture (re-confirmed green under real Atria THIS session:
  `interruption-recovery transition observed = true`), but on the colloquial
  social "hold on" message real Atria drives a decision that reaches `NEED_HUMAN`
  rather than a benign preserve.

## L. Pending-task preservation

- `pendingTaskLosses 0`. The interruption case preserved the task IN STATE
  (`INTERRUPTED`), so the task was not silently dropped — but the thread still
  left `AI_ACTIVE` for `NEED_HUMAN`, which is the recovery failure in §K. "Not
  lost" is not "preserved as resumable by the AI".

## M. Human handoff preservation

- explicit customer human request ⇒ `NEED_HUMAN` (`ho-customer-requested-human`
  PASS). safety/sensitive ⇒ `NEED_HUMAN` (`ho-sensitive-medical` PASS).
  knowledge-gap ⇒ `KNOWLEDGE_GAP` → `NEED_HUMAN` (`ho-empty-knowledge-gap` PASS).
  None of these was silently converted to CLARIFY.

## N. Knowledge-gap separation

- `ho-empty-knowledge-gap::u0` → observed class **`KNOWLEDGE_GAP`** (distinct from
  CLARIFY, distinct from a generic handoff). Genuine ambiguity stayed CLARIFY;
  genuine knowledge-gap stayed KNOWLEDGE_GAP. Channels did not collapse.

## O. State / turn-plan observability

Every measured turn preserved the real-engine observables used to distinguish the
behaviours (never inferred from reply text, which the eval never captures):
`decisionClass`/`turnPlan`, `clarification` (type + missingFacts), `handoffCause`,
`handoffOutcomeClass`, `knowledgeSourceClass`, `routingDecision` (`LLM` on all 14
measured turns), `stateTransition` (`from`/`to`), `provider`/`model`,
`retryCount`/`fallbackUsed`, latency. The seed audit records the engine-authored
messages + what the production reconstruction seams recovered (proving the seed is
not a second state representation).

## P. Model-call counts

- deterministic seed turns = **0** real model calls (audited).
- every measured generative turn = **exactly 1** model call.
- CLARIFY turn = 1 model call. `multiCallTurns = 0`. No hidden
  classifier→responder→judge chain; no `JEV→LLM` mandatory path.

## Q. Latency / retries / timeout profile

- n=14 measured turns, each exactly ONE call. min **12.4s**, p50 **≈42.1s**, p95
  **≈58.4s**, max **58.4s**. `totalRetries 0`. `providerFailures 0`.
- The 120s per-attempt budget eliminated the EVAL-07/08 timeout confounding (0
  TIMEOUTs; every observation from a first clean attempt). Latency is reported as
  a provider-selection property (TARGET_ARCHITECTURE finding #7), **not** a
  model-quality conclusion — Atria's p50 remains well above the 16s production
  cap, confounded by provider/runtime, not a behavioural signal.

## R. Failure clusters

- `RESUME_FAILED` ×2 (`am-context-resolves-service`, `mt-topic-return`) — relative
  Arabic date not bound.
- `INTERRUPTION_RECOVERY_FAILED` ×1 (`jt-interrupted`) — benign interruption
  escalated.
- Residual unnecessary HUMAN_HANDOFF (legacy `UNNECESSARY_HUMAN_HANDOFF`) ×2
  (`jt-interrupted`, `st-ambiguous-idk`) — UNCHANGED vs EVAL-08, not a new
  regression.
- 0 provider failures, 0 AI failures, 0 malformed outputs, 0 safety regressions.

## S. Scorer / dataset artifacts

- Dataset unmutated (hash matches). EVAL-03 scoring engine unchanged.
- Legacy EVAL-03 verdicts on the 14: **1 PASS / 5 LIMITATION / 8 FAIL**. These are
  largely legacy-scorer artifacts: the FUTURE CLARIFY/answer behaviours score
  against the CURRENT-architecture gold where CLARIFY did not exist (so a correct
  CLARIFY scores `ACTION_WRONG`/`INTENT_MISCLASSIFIED`), and `KNOWLEDGE_FABRICATED`
  on `st-service-discovery` is the known empty-eval-FAQ-store artifact. The
  AUTHORITATIVE signal is the observed clarify-measure, NOT the legacy verdict —
  EXCEPT where the legacy scorer independently CORROBORATES a real behavioural
  failure (`jt-interrupted` legacy `UNNECESSARY_HUMAN_HANDOFF` agrees with the
  clarify-measure `INTERRUPTION_RECOVERY_FAILED`).
- The EVAL-09 clarify-measure tightening is confirmed working: `am-context` and
  `mt-topic` are `ACCEPTABLE_EITHER` turns, yet are now correctly flagged
  `RESUME_FAILED` instead of being silently tolerated (the exact EVAL-08
  measurement-coverage gap, now closed). No gold label was rewritten; EVAL-03 was
  not altered globally.

## T. Comparison against PROMPT-AI-EVAL-08

| Target | EVAL-08 (real Atria) | EVAL-10 (real Atria, EVAL-09 capability) |
| ------ | -------------------- | ---------------------------------------- |
| Eval path for resume/interruption | NOT exercisable (BLOCKED — EVALUATION_PATH) | **Exercisable** (seed valid, path reached, 1 real call each) |
| SAFETY_REGRESSION | CLOSED | CLOSED (confirmed) |
| SUPPLIED_FACT_RESUME | unobservable (det-only) | **Observable → FAIL 2/2 (`RESUME_FAILED`)** |
| INTERRUPTION_RECOVERY | unobservable (det-only) | **Observable → FAIL 1/1 (`INTERRUPTION_RECOVERY_FAILED`)** |
| CLARIFY_UNNECESSARY | suppressed (residual handoff) | suppressed (0 unnecessary CLARIFY); residual handoff unchanged |
| MEASUREMENT_INTEGRITY | masked resume gap | CLOSED — gap now exposed (`RESUME_FAILED` on ACCEPTABLE_EITHER) |
| provider failures | 0 (120s budget) | 0 (120s budget) |

Net: EVAL-09 did its job — the behaviours are now visible under real LLM; and the
honest visible verdict is that resume + interruption are NOT closed under real
Atria on the real cases.

## U. What is PROVEN (under real Atria, this run)

1. The FUTURE_SYSTEM evaluation path can NOW honestly observe supplied-fact resume
   and interruption/pending-task recovery under real inference (EVAL-08's
   structural block is removed).
2. Safety precedence holds under real Atria: sensitive/explicit/knowledge-gap all
   reach the correct human/knowledge channel; 0 safety regressions; safety wins
   over CLARIFY.
3. First-class CLARIFY works: 4/4 expected CLARIFYs correct, 0 missed, 0
   unnecessary CLARIFY, each `AI_ACTIVE`, one bounded question, one model call.
4. Knowledge-gap stays distinct from CLARIFY and from generic handoff.
5. The zero-or-one generative-call invariant holds on every turn; seeds cost 0
   real calls; no hidden multi-model chain.
6. Measurement integrity: the clarify-measure now reports `RESUME_FAILED` on
   `ACCEPTABLE_EITHER` turns instead of masking them.
7. The resume + interruption MECHANISMS themselves work under real Atria for
   cleanly-shaped inputs (ISO date; FAQ-style interruption) — EVAL-09 fixtures
   re-confirmed green this session.

## V. What is NOT PROVEN / FAILS

1. Supplied-fact RESUME does NOT close under real Atria on the real EVAL-08 cases:
   an Egyptian relative date («الخميس») is not bound as the pending `date` fact,
   so the turn re-clarifies (2/2 `RESUME_FAILED`).
2. INTERRUPTION recovery does NOT close under real Atria: a benign colloquial
   interruption («ثواني بس، أنا في مكالمة») escalates to `NEED_HUMAN` instead of
   preserving the resumable task as `AI_ACTIVE` (1/1 `INTERRUPTION_RECOVERY_FAILED`).
3. The residual unnecessary HUMAN_HANDOFF (`st-ambiguous-idk`, `jt-interrupted`)
   is unchanged from EVAL-08 (not closed, not worse).

## W. Exact remaining uncertainty

- Whether the resume failure is purely model date-extraction (Atria never emits a
  bindable date) or also an engine relative-date normalisation gap in the resume
  bind path was not decomposed here (verification-only; no src read beyond the
  bridge seams it imports). The observed `SERVICE_SUPPLIED` transition (not
  `DATE_SUPPLIED`) on both resume cases points at the date fact never binding.
- Whether the interruption escalation is driven by the model's decision shape for
  "I'm on a call" vs the resolver's precedence ordering was not decomposed (the
  state reached `INTERRUPTED` yet the thread still went `NEED_HUMAN`).
- Both are small, well-scoped diagnostic questions for the corrective slice, not
  this pass.

## X. Readiness decision

**BLOCKED — BEHAVIORAL.** Do NOT implement Slice 5 (multi-intent).

Smallest next corrective step (a Slice-4 behavioural remediation slice, NOT Slice
5, NOT this verification pass):

> Make supplied-fact resume + benign-interruption recovery robust under real LLM
> for the actual input shapes the EVAL-08 cases carry:
> (a) RESUME — bind an Egyptian relative date («الخميس»/«بكرة»/…) to a pending
>     `CLARIFY_DATE` through the ONE engine fact-merge path so the task advances
>     and the date is NOT re-asked (domain still resolves the concrete slot);
> (b) INTERRUPTION — ensure the `PENDING_TASK_PRESERVED` precedence rule keeps a
>     benign non-task social interruption `AI_ACTIVE` with the task preserved,
>     instead of escalating to `NEED_HUMAN`, when no independent handoff condition
>     exists.
> First diagnose whether each gap is model-decision-shaped or
> resolver/normalisation-shaped (the observables in this run narrow it), fix the
> smallest seam, re-prove deterministically, then RE-RUN this exact EVAL-10 pass
> and confirm `RESUME_FAILED = 0`, `INTERRUPTION_RECOVERY_FAILED = 0`, safety still
> 0 regressions, before Slice 5 begins.

---

### Run identity (reproducibility)

- slice: PROMPT-AI-EVAL-10 (verification-only; no fixes; no Slice 5)
- target: `future-system-flowpilot` (FUTURE_SYSTEM)
- provider/model: `atria` / `Atria-Dawn-Preview` (eval-only override; DB policy
  NOT read/changed)
- dataset: `egyptian-v1`, hash `8be16297ae4717bab5da4f3c94de1887`
- cases: 14 (byte-identical EVAL-08 selection) + 3 calibration turns
- per-attempt timeout: 120000 ms; retries 0; provider failures 0
- real model calls: 14 (one per measured turn); seed calls 0
- artifacts: `analysis.json`, `status.md`, `case-selection.json`, `calibration.json`
- production mutation: NONE (isolated in-memory repositories)
- NOT committed, pushed, tagged, migrated, or deployed.
