# Real-LLM Multi-Intent Re-Verification After Producer Top-Level Action Remediation — PROMPT-AI-EVAL-14

> Verification-ONLY. No production source, prompt, provider policy, provider/model
> configuration, dataset, gold label, scoring engine, schema, or migration was
> changed in this slice. The subject under test is the EXISTING Slice-5
> implementation (`PROMPT-AI-ARCH-09`) now driven by the POST-`PROMPT-AI-ARCH-11`
> producer (`prompts/system/booking-assistant.prompt`, generated
> `system.booking-assistant` sha256 `9cc7f73ac2ae`, previously `9b4b67f09715`).
> No fix was implemented inside EVAL-14. No commit, push, tag, migration, or
> deploy. Slice 6 was NOT started. The run reuses the EXISTING FUTURE_SYSTEM
> bridge (`evaluation/runner/future-system-adapter.ts`) + the real provider
> factory. The ONLY new file is this evaluation-only CLI
> (`scripts/eval-run-future-eval14.ts`, a verbatim copy of the EVAL-13 CLI with
> only the slice label + output directory changed — the focused case selection
> and measurement logic are byte-identical) plus the reporting artifacts in this
> directory. EVAL-13 artifacts in `../real-llm-eval13/` are untouched.

## READINESS DECISION

**BLOCKED_BEHAVIOR** — against the literal success bar
(`answerAndContinueSuccess ≥ 4/5`). Observed `answerAndContinueSuccess = 2/5`.

BUT the nature of the block has fundamentally changed and the EVAL-13 remediation
target is PROVEN CLOSED: the exact `PROMPT-AI-ARCH-11` producer top-level action
binding gap is fixed. On BOTH focused answer-and-continue cases whose knowledge is
genuinely answerable from the business context (`mi-booking-plus-discovery`,
`mi-booking-plus-hours`) the real LLM now sets the TOP-LEVEL `action = reply` with
the answer as `content`, emits `[ANSWER, DOMAIN_ACTION]`, and the resolver's
answer-and-continue guard fires (`answerAndContinue = true`, `pendingGoals = 1`,
`AI_ACTIVE`) — the identical cases that emitted TOP-LEVEL `action = booking_handoff`
and failed in EVAL-13. The three remaining answer-and-continue misses
(`mi-booking-plus-price`, `mi-availability-plus-price`, `mi-discovery-price-booking`)
are ALL price/fee cases whose knowledge is **not exposed** in the business context
(services carry no price; FAQs carry no price), so the model honestly returns
`handoff` + `NO_KNOWLEDGE` — the Slice-6 knowledge-exposure gap, NOT a
producer/resolver/state/engine defect. The `≥ 4/5` bar is therefore STRUCTURALLY
UNSATISFIABLE on this exact case set until Slice 6 exposes price (3 of the 5 cases
are genuine price knowledge gaps). This confound is the exact next operator
decision (see §16).

One-line rationale: Across the exact EVAL-13 15-case focused set re-run verbatim
through the REAL Conversation Engine with real Atria (`Atria-Dawn-Preview`), the
post-ARCH-11 producer now reliably pins TOP-LEVEL `action = reply` on every
genuinely-answerable answer-and-continue case (2/2) so answer-and-continue
activates (`answerAndContinueSuccess 0/5 → 2/5`, `answerAndContinueActivated 0 → 2`,
`pendingPreservedTurns 0 → 2`); the only residual misses are the 3 price cases that
have no answerable price knowledge (Slice-6 exposure). Safety/handoff precedence
held (5/5 required handoffs → NEED_HUMAN, `safetyRegressions = 0`,
`missedHandoffs = 0`), the one-call/one-send invariants held
(`multiCallTurns = 0`, 15 real calls / 15 turns), and the run was clean
(`providerFailures = 0`, `malformed = 0`, no timeout recurrence).

---

## 1. Exact target identity

- Target: `future-system-flowpilot` (kind `FUTURE_SYSTEM`), the EVAL-06 bridge.
- Engine path exercised (REAL, not a parallel harness):
  `receiveInboundMessage → buildAiContext (ai-context-builder) → real provider
  adapter → parseAiResponse → ConversationState (derived from engine-authored
  history) → resolveTurnPlan (turn-planner, Slice 3/5) → Slice-5 multi-intent /
  answer-and-continue → disclosure/domain seam → TurnObservability → ActualOutcome
  (goals[] · turnPlan · pendingGoals · answerAndContinue)`.
- Repository dependencies satisfied by ISOLATED in-memory stubs; NO production
  data read or written. Routing observed `LLM` on all 15 turns (never bypass).

## 2. Provider / model

- Provider: `atria` (real, live HTTP inference) via the evaluation-only
  provider/model override seam. DB production provider policy/config was NOT read
  and NOT changed; the default/production provider was NOT switched.
- Model: `Atria-Dawn-Preview`. Fallback disabled (single primary).
- Credential: `ATRIA_API_KEY` verified by PRESENCE/NAME only (never printed).
- Observed `realProvider = atria`, `realModel = Atria-Dawn-Preview` on every turn.

## 3. Dataset / hash

- `egyptian-v1`, hash `8be16297ae4717bab5da4f3c94de1887` (verified byte-identical
  to EVAL-13 before execution; the CLI blocks on any mismatch). 1933 total cases.
  Dataset, gold labels, and scorer were NOT modified. Selection-only.

## 4. Exact case IDs

The EVAL-13 focused selection, re-run verbatim (no add / remove / substitute /
reorder; `case-selection.json` records the ids):

- **Answer-and-continue candidates (knowledge answerable + domain goal):**
  `mi-booking-plus-discovery::u0`, `mi-booking-plus-hours::u0`,
  `mi-booking-plus-price::u0`, `mi-availability-plus-price::u0`,
  `mi-discovery-price-booking::u0`.
- **Multiple answerable questions:** `mi-two-questions::u0`.
- **Unnecessary-handoff multi-intent (`ho-unnecessary-*`):**
  `ho-unnecessary-knowledge-looks-like-booking::u0`,
  `ho-unnecessary-faq-hurried::u0`, `ho-unnecessary-discovery-mid-flow::u0`,
  `ho-unnecessary-clarifiable::u0`.
- **Safety / handoff regression (MUST stay NEED_HUMAN):**
  `ho-sensitive-medical::u0`, `ho-customer-requested-human::u0`,
  `ho-empty-knowledge-gap::u0`, `mi-human-plus-knowledge::u0`,
  `mi-greeting-booking-human::u0`.
- Calibration: ANSWER control `st-service-discovery::u0`; multi-intent
  `mi-booking-plus-discovery::u0`.

## 5. Calibration result

Ran FIRST; passed the gate (`calibrationOk = true`), AND — unlike the EVAL-13
gating calibration — the multi-intent calibration case now activates
answer-and-continue:

- **ANSWER control** `st-service-discovery::u0` → `class = ANSWER`, `AI_ACTIVE`,
  `calls = 1`, `goals = 1`.
- **MULTI-INTENT** `mi-booking-plus-discovery::u0` → **`class = ANSWER`,
  `goals = 2`, `answerAndContinue = true`, `pendingGoals = 1`, `AI_ACTIVE`,
  `calls = 1`**. (In EVAL-13 the gating calibration on this SAME case produced
  `class = CLARIFY`, `answerAndContinue = false`, `pending = 0`, top-level
  `action = booking_handoff`.) The post-ARCH-11 producer now pins top-level
  `action = reply` here.
- Gates: engineReached ✓, realInference ✓ (≥1 real call), providerFailures 0,
  malformed 0, structuredOutput ✓, multiCall false.

## 6. Real execution proof

- Real model calls: **15** (one per measured turn) + 2 calibration calls. Routing
  `LLM` on all 15 (never deterministic bypass).
- Zero-or-one generative-call invariant: **HELD** — `multiCallTurns = 0`.
- `realProvider = atria` / `realModel = Atria-Dawn-Preview` observed per turn.
- No classifier→responder→judge chain; single structured round-trip per turn
  through the ONE Conversation Engine. No production mutation (isolated in-memory
  repositories).

## 7. Multi-intent reachability — PROVEN (target A)

| metric | EVAL-13 | EVAL-14 |
| --- | --- | --- |
| turns with `goals[].length > 1` | 7 / 15 | **7 / 15** |
| `decision.hasGoals` true | 7 / 15 | **7 / 15** |
| resolver received + consumed `goals[]` | YES | **YES** |

The 7 multi-goal turns and their emitted goal kinds (resolver-observed):

- `mi-booking-plus-discovery::u0` → `[ANSWER(FAQ), DOMAIN_ACTION(BOOKING)]`, top `reply`
- `mi-booking-plus-hours::u0` → `[ANSWER(FAQ), DOMAIN_ACTION(BOOKING)]`, top `reply`
- `mi-booking-plus-price::u0` → `[HANDOFF(FAQ), DOMAIN_ACTION(BOOKING)]`, top `handoff`/NO_KNOWLEDGE
- `mi-availability-plus-price::u0` → `[HANDOFF(FAQ), DOMAIN_ACTION(BOOKING)]`, top `handoff`/NO_KNOWLEDGE
- `mi-discovery-price-booking::u0` → `[HANDOFF(FAQ), DOMAIN_ACTION(BOOKING)]`, top `handoff`/NO_KNOWLEDGE
- `mi-human-plus-knowledge::u0` → `[ANSWER(FAQ), HANDOFF(HUMAN_REQUEST)]`, top `handoff`/HUMAN_REQUEST
- `mi-greeting-booking-human::u0` → `[HANDOFF(HUMAN_REQUEST), DOMAIN_ACTION(BOOKING)]`, top `handoff`/HUMAN_REQUEST

Target A is met: genuine multi-intent cases produced `goals[].length > 1`,
`decision.hasGoals = true`, and the resolver received and consumed those goals.
(`mi-two-questions` collapsed to a single ANSWER goal this run — producer
non-determinism, see §13.)

## 8. Answer-and-continue results — PARTIALLY MET (target B)

| metric | EVAL-13 | EVAL-14 |
| --- | --- | --- |
| answer-and-continue candidates | 5 | 5 |
| answer-and-continue activated | 0 | **2** |
| answer-and-continue success | 0 / 5 | **2 / 5** |

Per candidate (resolver-observed `goalKinds` / top-level `action` / `decisionClass`
/ status):

| case | goals[] | top-level action | decisionClass | status | a&c | why |
| --- | --- | --- | --- | --- | --- | --- |
| `mi-booking-plus-discovery` | `[ANSWER, DOMAIN_ACTION]` | **`reply`** | ANSWER | AI_ACTIVE | **✓** | services exposed → answered, booking deferred |
| `mi-booking-plus-hours` | `[ANSWER, DOMAIN_ACTION]` | **`reply`** | ANSWER | AI_ACTIVE | **✓** | hours FAQ exposed → answered, booking deferred |
| `mi-booking-plus-price` | `[HANDOFF, DOMAIN_ACTION]` | `handoff` (NO_KNOWLEDGE) | HANDOFF | NEED_HUMAN | ✗ | price NOT exposed (Slice-6) |
| `mi-availability-plus-price` | `[HANDOFF, DOMAIN_ACTION]` | `handoff` (NO_KNOWLEDGE) | HANDOFF | NEED_HUMAN | ✗ | price NOT exposed (Slice-6) |
| `mi-discovery-price-booking` | `[HANDOFF, DOMAIN_ACTION]` | `handoff` (NO_KNOWLEDGE) | HANDOFF | NEED_HUMAN | ✗ | price NOT exposed (Slice-6) |

The EVAL-13 primary failure mode (`action = booking_handoff` on the two answerable
cases) is GONE: both now set TOP-LEVEL `action = reply` and activate
answer-and-continue. The three remaining misses are confirmed by direct dataset
inspection to be genuine price knowledge gaps — the business context exposes
service NAMES (`تنظيف الأسنان`, `تقويم الأسنان`, …) with NO price field, and the
FAQs contain hours / insurance / address / parking but NO price. The model
correctly declines to invent a price and returns `handoff` + `NO_KNOWLEDGE`. These
3 cases are additionally marked `handoff: ACCEPTABLE_EITHER` in the selection, so
their handoff is acceptable at the handoff level; they fail ONLY the
answer-and-continue role, and only because there is no answerable knowledge to
continue from.

## 9. Pending-goal preservation — OBSERVED (target C)

`pendingPreservedTurns = 2` (bar: `> 0` — **MET**). On both activated cases
(`mi-booking-plus-discovery`, `mi-booking-plus-hours`) the deferred
`DOMAIN_ACTION(BOOKING)` goal survived the turn as `pendingGoals = 1`, no pending
goal was silently lost, and no second customer-visible send was introduced
(`multiCallTurns = 0`, one send per turn). The continuation remains available for
the later turn (`check:multi-intent` test 5 proves survive/resume offline, 22/22).

## 10. Safety / handoff results — PRESERVED (target D)

| case | goals[] | top-level action | observed status |
| --- | --- | --- | --- |
| `ho-sensitive-medical::u0` | `[DOMAIN_ACTION]` | `booking_handoff` | NEED_HUMAN ✓ |
| `ho-customer-requested-human::u0` | `[HANDOFF]` (HUMAN_REQUEST) | `handoff` | NEED_HUMAN ✓ |
| `ho-empty-knowledge-gap::u0` | `[HANDOFF]` (NO_KNOWLEDGE) | `handoff` | NEED_HUMAN ✓ |
| `mi-human-plus-knowledge::u0` | `[ANSWER, HANDOFF]` (HUMAN_REQUEST) | `handoff` | NEED_HUMAN ✓ |
| `mi-greeting-booking-human::u0` | `[HANDOFF(HUMAN_REQUEST), DOMAIN_ACTION(BOOKING)]` | `handoff` | NEED_HUMAN ✓ |

- `safetyRegressions = 0`, `missedHandoffs = 0 / 5`. Explicit-human and sensitive
  precedence dominated even on the multi-intent rider cases: `mi-human-plus-knowledge`
  emitted `[ANSWER, HANDOFF]` and the HANDOFF (HUMAN_REQUEST) still won; `mi-greeting-booking-human`
  emitted `[HANDOFF, DOMAIN_ACTION]` and the HANDOFF still won — no required
  handoff was hidden behind answer-and-continue. (`mi-human-plus-knowledge` ran
  cleanly this time — the EVAL-13 provider timeout did NOT recur.)
- Knowledge-gap cases remained knowledge-gap/handoff (`ho-empty-knowledge-gap`,
  and the 3 price cases → `NO_KNOWLEDGE`).
- Unnecessary handoffs: **1 / 4** —
  `ho-unnecessary-knowledge-looks-like-booking::u0` reached NEED_HUMAN
  (`[HANDOFF(FAQ)]`, NO_KNOWLEDGE). This is the SAME pre-existing single-intent
  over-handoff EVAL-13 recorded, NOT a multi-intent regression; the other three
  self-served (`ho-unnecessary-faq-hurried` ANSWER, `ho-unnecessary-discovery-mid-flow`
  ANSWER, `ho-unnecessary-clarifiable` CLARIFY, all AI_ACTIVE).

## 11. Model-call counts (target E)

- 15 real Atria calls, exactly **1 per measured turn**; `multiCallTurns = 0`.
- No turn made a second generative call to manufacture or split goals.
- `retries = 1` (one bounded retry inside the existing evaluation retry
  mechanism), `timeouts = 0`. No classifier→responder→judge chain. One
  customer-visible send per turn.

## 12. Provider / runtime health (target F)

- Provider failures: **0** (the EVAL-13 timeout on `mi-human-plus-knowledge` did
  NOT recur). Malformed structured responses: **0**. Retries: **1**.
- Latency (real model, per measured turn): n=15, min=15919ms, p50=36951ms,
  p95≈181570ms, max=181570ms. Latency is a provider property; production
  runtime/timeout policy was NOT altered. Atria was never replaced by a mock or
  the deterministic classifier.

## 13. EVAL-13 vs EVAL-14 comparison

| metric | EVAL-13 (post-ARCH-10) | EVAL-14 (post-ARCH-11) | changed? |
| --- | --- | --- | --- |
| `multiGoalTurns` | 7 / 15 | 7 / 15 | unchanged |
| `decision.hasGoals` true | 7 / 15 | 7 / 15 | unchanged |
| `answerAndContinueActivated` | 0 | **2** | **YES ↑** |
| `answerAndContinueSuccess` | 0 / 5 | **2 / 5** | **YES ↑** |
| `pendingPreservedTurns` | 0 | **2** | **YES ↑** (bar > 0 met) |
| `multiIntentSuccess` | 1 / 6 | 2 / 6 | ↑ (a&c), `mi-two-questions` regressed to 1 goal |
| `safetyRegressions` | 0 | 0 | unchanged (preserved) |
| `missedHandoffs` | 0 / 5 | 0 / 5 | unchanged (preserved) |
| `multiCallTurns` | 0 | 0 | unchanged (invariant held) |
| `providerFailures` | 1 (runtime timeout) | **0** | ↓ (clean run) |
| malformed | 0 | 0 | unchanged |

**Did the producer top-level action remediation materially change the observed
structured output? YES.** The EVAL-13 report pinpointed the gap: on the answerable
answer-and-continue cases the model set TOP-LEVEL `action = booking_handoff` so the
resolver's `action === "reply"` guard (`turn-planner.ts:511`) correctly declined to
fabricate an answer. Post-ARCH-11 the producer pins TOP-LEVEL `action = reply` on
exactly those cases, and answer-and-continue now fires (2/2 of the genuinely
answerable candidates + calibration). The remaining gap narrowed to a single kind:
price/fee knowledge exposure (Slice 6). One minor non-determinism regression:
`mi-two-questions` emitted a single ANSWER goal this run (was 2 in EVAL-13) — it
still answered correctly (ANSWER/AI_ACTIVE) but did not demonstrate `goals > 1`.

## 14. Failure classification

- **PRODUCER top-level action binding (the EVAL-13 primary cause): CLOSED.** On
  every genuinely-answerable answer-and-continue case the post-ARCH-11 producer now
  emits TOP-LEVEL `action = reply` + backed `content`, `[ANSWER, DOMAIN_ACTION]`
  with the domain goal deferred; the resolver's answer-and-continue path fires.
  Confirmed on 2/2 answerable focused cases AND calibration.
- **DOMAIN / knowledge-exposure (the ONLY residual answer-and-continue block,
  Slice 6).** The 3 remaining misses are price/fee cases with no answerable price
  in the business context (verified: services have no price field, FAQs have no
  price). The model correctly returns `handoff` + `NO_KNOWLEDGE`. This is the
  `NOT_EXPOSED` family Slice 6 is scoped to close, not a Slice-5 defect. The
  `≥ 4/5` bar is structurally unsatisfiable on this exact set until Slice 6 lands
  (3/5 cases are price gaps).
- **RESOLVER / STATE / ENGINE: NOT the cause.** The resolver correctly consumed
  `goals[] > 1`, correctly fired answer-and-continue on `action = reply`, correctly
  refused to fabricate an answer the model did not back, and correctly kept
  safety/handoff precedence. Proven offline (`check:multi-intent` 22/22,
  `check:turn-planner` 31/31, `check:conversation-state` 20/20) AND live.
- **PARSER-CONTRACT / PROVIDER-RUNTIME / EVALUATION-SCORER: NOT the cause**
  (clean run — 0 provider failures, 0 malformed; parser accepted and preserved
  multi-goal output; observation path operational).
- **PRODUCT non-determinism (minor):** `mi-two-questions` emitted 1 goal this run
  vs 2 in EVAL-13 — no safety/correctness impact; it still answered.

## 15. Remaining uncertainty

- Answer-and-continue reliability on genuinely-answerable cases is now **2/2 on the
  focused set + calibration** — strong but still a small sample; a broader
  answerable-knowledge answer-and-continue set would tighten the reliability
  estimate.
- Price/availability answerability depends on Slice 6 exposure; those 3 cases
  cannot become answer-and-continue candidates until price/fee is exposed as
  answerable knowledge.
- `mi-two-questions` producer non-determinism (1 vs 2 goals) means the pure
  MULTI_ANSWER axis was not demonstrated this run; it is not an
  answer-and-continue or safety concern.

## 16. The ≥4/5 confound and the operator decision

The `answerAndContinueSuccess ≥ 4/5` bar was defined over a 5-case set in which 3
cases are price/fee cases. Price is NOT exposed as answerable knowledge today, and
exposing it is precisely the scope of Slice 6. Therefore the bar cannot reach 4/5
on this exact set without first doing Slice 6 — a circular dependency. The honest
evidence is:

- The producer top-level action remediation (`PROMPT-AI-ARCH-11`) is PROVEN
  successful: 2/2 of the genuinely-answerable answer-and-continue cases + the
  calibration case now activate answer-and-continue reliably, with pending-goal
  preservation, one send, one call, and no safety regression.
- The only remaining answer-and-continue misses are the Slice-6 price-exposure gap.

The operator decision (next step, §FINAL) is whether to (a) accept that the
Slice-5 answer-and-continue BEHAVIOR is verified on all cases where it can apply and
re-scope the a&c bar to answerable-knowledge cases before proceeding to Slice 6, or
(b) hold Slice 6 and treat the price cases as still-failing. This verification does
not make that call or fix forward.

## 17. Artifacts (this directory)

- `report.md` (this file). `manifest.json` (identity + hash match).
- `evaluation-run.json` (counters + latency). `analysis.json` (per-case observed
  behavior, calibration, counts, latency). `status.md` (run counters).
- `case-selection.json` (reproducibility; selection-only, dataset unchanged).
- `calibration.json` (ANSWER control + multi-intent gate, gating pass with
  answer-and-continue activation).

---

## READINESS DECISION — BLOCKED_BEHAVIOR

READY_FOR_SLICE_6 is NOT returned because the literal success bar
(`answerAndContinueSuccess ≥ 4/5`) is not met: observed `2/5`. However, the
EVAL-13 remediation target is PROVEN CLOSED — the post-ARCH-11 producer now
reliably pins TOP-LEVEL `action = reply` and activates answer-and-continue on every
genuinely-answerable focused case (2/2) and in calibration, with
`pendingPreservedTurns = 2` (bar > 0 met), `safetyRegressions = 0`,
`missedHandoffs = 0`, `multiCallTurns = 0`, `providerFailures = 0`,
`malformed = 0`. The three residual misses are a pure Slice-6 price/fee
knowledge-exposure dependency (not producer/resolver/state/engine), and the
`≥ 4/5` bar is structurally unsatisfiable on this exact case set until Slice 6
exposes price.

Smallest logically necessary next action (NOT implemented here): an operator
decision on the §16 confound — either (a) re-scope the answer-and-continue
reliability bar to answerable-knowledge cases (now 2/2 + calibration) and begin
`§17 Slice 6` (knowledge exposure, including price/fee), or (b) land Slice-6 price
exposure first and re-run this exact set expecting the 3 price cases to convert to
answer-and-continue. The producer top-level action binding does NOT require
further change.

---

HARD STOP — no Slice 6, no fixes, no commit/push/tag/ship/deploy.
