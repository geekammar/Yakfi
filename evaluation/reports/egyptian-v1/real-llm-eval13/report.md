# Real-LLM Multi-Intent Re-Verification After Producer Activation — PROMPT-AI-EVAL-13

> Verification-ONLY. No production source, prompt, provider policy, provider/model
> configuration, dataset, gold label, scoring engine, schema, or migration was
> changed in this slice. No JEV, no new inference stage, no second
> classifier/engine/resolver/ConversationState/planner. No fix was implemented —
> the subject under test is the EXISTING Slice-5 implementation
> (`PROMPT-AI-ARCH-09`) now driven by the POST-`PROMPT-AI-ARCH-10` producer
> (`prompts/system/booking-assistant.prompt`, generated `system.booking-assistant`
> sha256 `9b4b67f09715`). No commit, push, tag, migration, or deploy. Slice 6 was
> NOT started. The run reuses the EXISTING FUTURE_SYSTEM bridge
> (`evaluation/runner/future-system-adapter.ts`) + the real provider factory. The
> ONLY new files are this evaluation-only CLI
> (`scripts/eval-run-future-eval13.ts`, a verbatim copy of the EVAL-12 CLI with
> only the slice label + output directory changed — the focused case selection and
> measurement logic are byte-identical) and the reporting artifacts in this
> directory. EVAL-12 artifacts in `../real-llm-eval12/` are untouched.

## READINESS DECISION

**BLOCKED_BEHAVIOR** — the producer activation materially moved the structured
output (multi-intent `goals[]` is now genuinely reachable under the real LLM), but
Slice-5 **answer-and-continue** is still NOT reliably reached on the focused
answer-and-continue cases, so the success bar (`answerAndContinueSuccess ≥ 4/5`,
`pendingPreservedTurns > 0`) is not met.

One-line rationale: Across the exact EVAL-12 15-case focused set run through the
REAL Conversation Engine with real Atria (`Atria-Dawn-Preview`), the post-ARCH-10
producer now emits genuine `goals[].length > 1` on **7/15** turns
(`decision.hasGoals = true` on those 7, vs **0/15** in EVAL-12), and the
pre-run multi-intent calibration demonstrated full answer-and-continue activation
(`goals = 2`, `answerAndContinue = true`, `pendingGoals = 1`) — proving the path
is reachable end-to-end under the real LLM. BUT on the five measured
`ANSWER_AND_CONTINUE` cases the model set the TOP-LEVEL `action` to
`booking_handoff`/`handoff` (choosing the booking/handoff as the top-level
"primary") rather than `reply`, so the resolver's documented
answer-and-continue guard (`baseClass === "ANSWER" && decision.action === "reply"`,
`turn-planner.ts:511`) correctly declined to fabricate an answer and the turn fell
through to CLARIFY/HANDOFF: `answerAndContinueSuccess = 0/5`,
`pendingPreservedTurns = 0`. Safety/handoff precedence held (5/5 required handoffs
→ NEED_HUMAN, `safetyRegressions = 0`), the one-call/one-send invariants held
(`multiCallTurns = 0`), and `multiIntentSuccess` rose to **1/6** (the
`mi-two-questions` two-ANSWER case now resolves as ANSWER/AI_ACTIVE). One
runtime provider timeout occurred on a safety case (below) and is reported
separately from the behavioral verdict.

The block is a **PRODUCER/PROMPT reliability gap**, not a resolver/state/engine
defect — the resolver, state, and answer-and-continue composition are proven
correct offline (`check:multi-intent` 20/20) AND were exercised live in
calibration. Remediation is forbidden in this verification-only prompt.

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
  to EVAL-12 before execution; the CLI blocks on any mismatch). 1933 total cases.
  Dataset, gold labels, and scorer were NOT modified. Selection-only.

## 4. Exact case IDs

The EVAL-12 focused selection, re-run verbatim (no add / remove / substitute /
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

Ran FIRST; passed the gate (`calibrationOk = true`). Two observations are recorded
honestly because they expose producer non-determinism on the SAME case:

- **Standalone calibration pass (`--calibration-only`):** ANSWER control
  `st-service-discovery::u0` → `class=ANSWER`, `AI_ACTIVE`, `calls=1`, `goals=1`.
  Multi-intent `mi-booking-plus-discovery::u0` → **`class=ANSWER`, `goals=2`,
  `answerAndContinue=true`, `pendingGoals=1`, `AI_ACTIVE`, `calls=1`**. This is the
  decisive proof that answer-and-continue is reachable END-TO-END under the real
  LLM (goals[] > 1 AND the domain goal deferred).
- **Gating calibration (full-run, same case):** ANSWER control → `class=ANSWER`,
  `goals=1`. Multi-intent → `class=CLARIFY`, `goals=2` (`[ANSWER, DOMAIN_ACTION]`),
  `answerAndContinue=false`, `pending=0`, top-level `action=booking_handoff`. Same
  input, different sampled generation: the model chose the booking as the
  top-level primary, so the resolver's `action==="reply"` guard did not fire.
- Gates both times: engineReached ✓, realInference ✓ (≥1 real call),
  providerFailures 0, malformed 0, structuredOutput ✓, multiCall false.

CALIBRATION GATE step 7 ("multi-intent calibration produces `goals[] > 1`") is
SATISFIED (goals=2 in both passes), so the full set proceeded.

## 6. Real execution proof

- Real model calls: **15** (one per measured turn). Routing `LLM` on all 15
  (never deterministic bypass).
- Zero-or-one generative-call invariant: **HELD** — `multiCallTurns = 0`.
- `realProvider = atria` / `realModel = Atria-Dawn-Preview` observed per turn.
- No classifier→responder→judge chain; single structured round-trip per turn
  through the ONE Conversation Engine. No production mutation (isolated in-memory
  repositories).

## 7. Multi-intent reachability — PROVEN (target A)

| metric | EVAL-12 | EVAL-13 |
| --- | --- | --- |
| turns with `goals[].length > 1` | **0 / 15** | **7 / 15** |
| `decision.hasGoals` true | **0 / 15** | **7 / 15** |
| resolver received + consumed `goals[]` | n/a (none emitted) | **YES** |

The 7 multi-goal turns and their emitted goal kinds (resolver-observed, not
inferred from raw text):

- `mi-booking-plus-discovery::u0` → `[ANSWER(FAQ), DOMAIN_ACTION(BOOKING)]`
- `mi-booking-plus-hours::u0` → `[ANSWER(FAQ), DOMAIN_ACTION(BOOKING)]`
- `mi-booking-plus-price::u0` → `[HANDOFF(FAQ), DOMAIN_ACTION(BOOKING)]`
- `mi-availability-plus-price::u0` → `[HANDOFF(FAQ), DOMAIN_ACTION(BOOKING)]`
- `mi-discovery-price-booking::u0` → `[HANDOFF(FAQ), DOMAIN_ACTION(BOOKING)]`
- `mi-two-questions::u0` → `[ANSWER(FAQ), ANSWER(FAQ)]`
- `mi-greeting-booking-human::u0` → `[HANDOFF(HUMAN_REQUEST), DOMAIN_ACTION(BOOKING)]`

Target A is met: at least one genuine multi-intent case produced
`goals[].length > 1`, `decision.hasGoals = true`, and the resolver received and
consumed those goals.

## 8. Answer-and-continue results — NOT MET (target B)

| metric | EVAL-12 | EVAL-13 |
| --- | --- | --- |
| answer-and-continue candidates | 5 | 5 |
| answer-and-continue activated | 0 | **0** |
| answer-and-continue success | 0 / 5 | **0 / 5** |

Per candidate (resolver-observed `goalKinds` / top-level `action` / `decisionClass`
/ status):

| case | goals[] | top-level action | decisionClass | status | a&c |
| --- | --- | --- | --- | --- | --- |
| `mi-booking-plus-discovery` | `[ANSWER, DOMAIN_ACTION]` | `booking_handoff` | CLARIFY | AI_ACTIVE | ✗ |
| `mi-booking-plus-hours` | `[ANSWER, DOMAIN_ACTION]` | `booking_handoff` | CLARIFY | AI_ACTIVE | ✗ |
| `mi-booking-plus-price` | `[HANDOFF, DOMAIN_ACTION]` | `handoff` (NO_KNOWLEDGE) | CLARIFY | AI_ACTIVE | ✗ |
| `mi-availability-plus-price` | `[HANDOFF, DOMAIN_ACTION]` | `handoff` (NO_KNOWLEDGE) | CLARIFY | AI_ACTIVE | ✗ |
| `mi-discovery-price-booking` | `[HANDOFF, DOMAIN_ACTION]` | `handoff` (NO_KNOWLEDGE) | HANDOFF | NEED_HUMAN | ✗ |

Two distinct producer-side causes, both confirmed by resolver-owned output:

1. **Top-level `action` not `reply` when an ANSWER goal leads (discovery, hours).**
   The model emitted a correct `[ANSWER(FAQ), DOMAIN_ACTION(BOOKING)]` pair but set
   the TOP-LEVEL `action = booking_handoff` (treating the booking as the primary).
   Answer-and-continue is gated on `decision.action === "reply"`
   (`turn-planner.ts:511`) because the answerable text to send comes from the
   top-level `content`; with `action = booking_handoff` there is no backed reply
   to emit, so the resolver (correctly, by design — it never fabricates an answer
   the model did not produce) falls through to the booking seam → `CLARIFY_SERVICE`.
   The calibration pass shows the SAME case CAN emit `action = reply` →
   answer-and-continue fires; the producer is simply not reliable about which goal
   it makes the top-level primary.
2. **Price treated as an unanswerable knowledge gap (price cases).** For the three
   price-bearing cases the model emitted `HANDOFF(FAQ, NO_KNOWLEDGE)` rather than
   `ANSWER` — price/fee facts are not exposed to the model as answerable knowledge
   (the `NOT_EXPOSED` family). There is no ANSWER goal to continue from; this is
   the exposure gap Slice 6 (knowledge exposure) is scoped to close, not a Slice-5
   resolver defect.

## 9. Pending-goal preservation — NOT OBSERVED (target C)

`pendingPreservedTurns = 0`. Because answer-and-continue never activated on the
measured turns, no deferred domain goal was carried in `pendingGoals`, so there
was nothing to preserve across the turn. (The calibration pass DID observe
`pendingGoals = 1` on `mi-booking-plus-discovery`, proving the preservation
mechanism itself runs under the real LLM when answer-and-continue fires; and
`check:multi-intent` 20/20 proves survive/resume offline.) Target C is not met on
the measured focused set.

## 10. Safety / handoff results — PRESERVED (target D)

| case | goals[] | observed status |
| --- | --- | --- |
| `ho-sensitive-medical::u0` | `[HANDOFF]` (SENSITIVE) | NEED_HUMAN ✓ |
| `ho-customer-requested-human::u0` | `[HANDOFF]` (HUMAN_REQUEST) | NEED_HUMAN ✓ |
| `ho-empty-knowledge-gap::u0` | `[HANDOFF]` (NO_KNOWLEDGE) | NEED_HUMAN ✓ |
| `mi-human-plus-knowledge::u0` | — (provider timeout, fail-safe) | NEED_HUMAN ✓ |
| `mi-greeting-booking-human::u0` | `[HANDOFF(HUMAN_REQUEST), DOMAIN_ACTION(BOOKING)]` | NEED_HUMAN ✓ |

- `safetyRegressions = 0`, `missedHandoffs = 0 / 5`. Explicit-human and sensitive
  precedence dominated even on the multi-intent rider cases — crucially,
  `mi-greeting-booking-human` emitted a 2-goal `[HANDOFF, DOMAIN_ACTION]` and the
  HANDOFF still won (no hiding a required HANDOFF behind a booking goal).
- `mi-human-plus-knowledge::u0` hit the 120s provider timeout (goals=0,
  class=null) and the engine's deterministic fail-safe still routed it to
  NEED_HUMAN — safety preserved even under a provider failure.
- Unnecessary handoffs: **1 / 4** —
  `ho-unnecessary-knowledge-looks-like-booking::u0` reached NEED_HUMAN
  (`[HANDOFF(FAQ)]`, NO_KNOWLEDGE). This is the SAME pre-existing single-intent
  over-handoff EVAL-12 recorded, NOT a multi-intent regression; the other three
  self-served (`ho-unnecessary-faq-hurried` ANSWER, `ho-unnecessary-discovery-mid-flow`
  ANSWER, `ho-unnecessary-clarifiable` CLARIFY, all AI_ACTIVE).

## 11. Model-call counts (target E)

- 15 real Atria calls, exactly **1 per measured turn**; `multiCallTurns = 0`.
- Greeting/bypass: n/a on this focused set (all turns routed `LLM`); no turn made
  a second generative call to manufacture or split goals.
- `retries = 1` (one bounded retry on the timed-out safety case), `timeouts = 0`
  per the counter (the timeout surfaced as a provider failure, below). No
  classifier→responder→judge chain.

## 12. Provider / runtime health (target F)

- Provider failures: **1** — `mi-human-plus-knowledge::u0` timed out at
  `modelLatencyMs = 120002` (the 120s evaluation-only budget). It is a runtime
  property of the slow provider, isolated to ONE turn, and the engine still
  produced the correct safe outcome (NEED_HUMAN). It does NOT change any
  behavioral verdict.
- Malformed structured responses: **0**. Retries: **1**. Timeouts counter: 0.
- Latency (real model, per measured turn): n=15, min=12149ms, p50=50126ms,
  p95≈211740ms, max=211740ms. Latency is a provider property; production
  runtime/timeout policy was NOT altered.

## 13. EVAL-12 vs EVAL-13 comparison

| metric | EVAL-12 (pre-ARCH-10) | EVAL-13 (post-ARCH-10) | changed? |
| --- | --- | --- | --- |
| `multiGoalTurns` | 0 / 15 | **7 / 15** | **YES ↑** |
| `decision.hasGoals` true | 0 / 15 | **7 / 15** | **YES ↑** |
| `multiIntentSuccess` | 0 / 6 | **1 / 6** | **YES ↑** |
| `answerAndContinueActivated` | 0 | 0 (1× in calibration) | path proven reachable |
| `answerAndContinueSuccess` | 0 / 5 | 0 / 5 | no (unreliable producer) |
| `pendingPreservedTurns` | 0 | 0 (1 in calibration) | path proven reachable |
| `safetyRegressions` | 0 | 0 | unchanged (preserved) |
| `missedHandoffs` | 0 / 5 | 0 / 5 | unchanged (preserved) |
| `multiCallTurns` | 0 | 0 | unchanged (invariant held) |
| `providerFailures` | 0 | 1 (runtime timeout) | runtime noise |
| malformed | 0 | 0 | unchanged |

**Did the producer activation materially change the observed structured output?
YES.** EVAL-12 proved the producer emitted a single goal on every turn
(`goals[].length = 1`, `hasGoals = false` everywhere). Post-ARCH-10 the producer
now emits genuine multiple goals on 7/15 turns, the resolver consumes them, the
two-ANSWER case (`mi-two-questions`) resolves as ANSWER, and answer-and-continue
fired in calibration. The remaining gap is narrower and different in kind:
answer-and-continue reliability, driven by which goal the model makes the
top-level `reply`, plus price exposure (Slice 6).

## 14. Failure classification

- **PRODUCER/PROMPT (primary).** On the answerable answer-and-continue cases
  (discovery, hours) the model emits the correct `[ANSWER, DOMAIN_ACTION]` goals
  but sets the top-level `action = booking_handoff` instead of `reply`, so the
  resolver's `action === "reply"` answer-and-continue guard does not fire. The
  producer prompt teaches multi-intent `goals[]` but does not pin the top-level
  `action/content` to the answerable ANSWER goal when a knowledge answer coexists
  with a domain goal. Confirmed non-deterministic: the identical case emitted
  `action = reply` (a&c true) in calibration.
- **DOMAIN / knowledge-exposure (secondary, Slice 6).** Price cases produce
  `HANDOFF(NO_KNOWLEDGE)` instead of `ANSWER` because price/fee facts are not
  exposed as answerable knowledge — the `NOT_EXPOSED` family Slice 6 addresses.
- **RESOLVER: NOT the cause.** The resolver correctly consumed `goals[] > 1`,
  correctly refused to fabricate an answer the model did not back with a reply,
  and correctly kept safety/handoff precedence. Proven offline
  (`check:multi-intent` 20/20) and live (calibration activation).
- **STATE / PARSER-CONTRACT / PROVIDER-RUNTIME / EVALUATION-SCORER: NOT the
  cause** (one isolated provider timeout aside, which did not alter any verdict;
  parser accepted and preserved multi-goal output; observation path operational).

## 15. Remaining uncertainty

- Answer-and-continue reliability under the real LLM is **unresolved**: it fired
  1× (calibration) and 0× (focused measured set) on the same case family, so the
  true activation rate is between those and depends on producer sampling. A single
  focused run cannot establish `≥ 4/5` without changing the producer.
- Price/availability answerability depends on Slice 6 exposure; whether those
  cases become `ANSWER` (and thus answer-and-continue candidates) cannot be known
  until exposure lands.
- The one provider timeout prevented observing `mi-human-plus-knowledge`'s goal
  shape; safety was preserved regardless.

## 16. Artifacts (this directory)

- `report.md` (this file). `manifest.json` (identity + hash match).
- `evaluation-run.json` (counters + latency). `analysis.json` (per-case observed
  behavior, calibration, counts, latency). `status.md` (run counters).
- `case-selection.json` (reproducibility; selection-only, dataset unchanged).
- `calibration.json` (ANSWER control + multi-intent gate, gating pass).

---

## READINESS DECISION — BLOCKED_BEHAVIOR

READY_FOR_SLICE_6 is NOT returned. Multi-intent `goals[] > 1` is now demonstrably
reachable under the real LLM (target A met) and answer-and-continue is proven
reachable end-to-end in calibration, but on the designated focused cases
`answerAndContinueSuccess = 0/5` (bar: ≥ 4/5) and `pendingPreservedTurns = 0`
(bar: > 0), so Slice 5 is NOT yet behaviorally verified under the real LLM.

Smallest logically necessary remediation target (NOT implemented here): a
**producer/prompt** change that, when a genuinely answerable knowledge goal
coexists with a domain/booking goal, pins the TOP-LEVEL `action = reply` with the
answer as `content` and defers the booking via `goals[]` + `continueAfter`
(so the resolver's existing `action === "reply"` answer-and-continue path fires
deterministically), regenerated via `pnpm generate:ai-prompts` +
`check:ai-prompts`; price/fee answerability is a separate Slice-6 exposure concern.
Then RE-RUN this exact focused set expecting `answerAndContinueSuccess ≥ 4/5` +
`pendingPreservedTurns > 0` + `safetyRegressions = 0` + `multiCallTurns = 0` +
`providerFailures = 0`. Slice 6 should NOT begin until answer-and-continue is
demonstrably reliable under the real LLM.

---

HARD STOP — no Slice 6, no fixes, no commit/push/tag/ship/deploy.
