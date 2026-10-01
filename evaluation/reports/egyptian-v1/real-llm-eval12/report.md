# Real-LLM Multi-Intent Verification After Slice 5 — PROMPT-AI-EVAL-12

> Verification-ONLY. No production source, prompt, provider policy, provider/model
> configuration, dataset, gold label, scoring engine, schema, or migration was
> changed in this slice. No JEV, no new inference stage, no second
> classifier/engine/resolver/ConversationState/planner. No fix was implemented —
> the subject under test is the EXISTING Slice-5 implementation
> (`PROMPT-AI-ARCH-09`) already present in `src/`. No commit, push, tag,
> migration, or deploy. Slice 6 was NOT started. The run reuses the EXISTING
> FUTURE_SYSTEM bridge (`evaluation/runner/future-system-adapter.ts`) + the real
> provider factory. The ONLY new files are this evaluation-only CLI
> (`scripts/eval-run-future-eval12.ts`) and the reporting artifacts in this
> directory.

## READINESS DECISION

**BLOCKED_BEHAVIOR** — Slice-5 multi-intent answer-and-continue is NOT reachable
under the real Atria LLM on the current production path.

One-line rationale: Across 15 focused cases (plus a 2-case calibration) run
through the REAL Conversation Engine with real Atria (`Atria-Dawn-Preview`), the
model emitted a SINGLE goal on **every** turn (`goals[].length = 1` on 15/15,
`decision.hasGoals = false` on 15/15), so `answerAndContinue` activated **0** times,
`pendingGoals` were preserved on **0** turns, and multi-intent success was
**0/6** — while every REQUIRED invariant held (15 real calls / 15 turns, 0
multi-call, 0 provider failures, 0 malformed, 0 retries, 0 timeouts, engine
reached on all) and safety/handoff precedence was fully preserved (5/5 required
handoffs honored, 0 safety regressions). The resolver/state/engine Slice-5
foundation is proven correct offline (`check:multi-intent` 20/20); the gap is
that **no producer emits `goals[]`** — the production system prompt
(`prompts/system/booking-assistant.prompt`) describes a contract WITHOUT `goals`
and instructs "never extra keys", so the real LLM is never asked for multiple
goals. This is the exact state `BUILD_STATE` already records: answer-and-continue
is "UNREACHABLE in production until a producer extracts multiple goals". The
remediation (updating the producer) is forbidden in this verification-only prompt.

---

## A. Target identity

- Target: `future-system-flowpilot` (kind `FUTURE_SYSTEM`), the EVAL-06 bridge.
- Engine path exercised (REAL, not a parallel harness):
  `receiveInboundMessage → ai-context-builder → real provider adapter →
  parseAiResponse → ConversationState (derived from the engine-authored history)
  → resolveTurnPlan (turn-planner, Slice 3/5) → Slice-5 multi-intent /
  answer-and-continue → existing reply/disclosure/domain seams → TurnObservability
  (goals[] · turnPlan · pendingGoals · answerAndContinue)`.
- Repository dependencies satisfied by ISOLATED in-memory stubs; NO production
  data read or written. Routing observed `LLM` on all 15 turns (never bypass),
  proving the real inference path was exercised.

## B. Provider / model

- Provider: `atria` (real, live HTTP inference) via the evaluation-only
  provider/model override seam. DB production provider policy/config was NOT read
  and NOT changed; the default/production provider was NOT switched.
- Model: `Atria-Dawn-Preview`. Fallback disabled (single primary).
- Credential: `ATRIA_API_KEY` verified by PRESENCE/NAME only (never printed).
- Observed `realProvider = atria`, `realModel = Atria-Dawn-Preview` on every turn.

## C. Dataset identity

- `egyptian-v1`, hash `8be16297ae4717bab5da4f3c94de1887` (byte-identical to
  EVAL-08/EVAL-10/EVAL-11). 1933 total cases. Dataset, gold labels, and scorer
  were NOT modified. Selection-only.

## D. Case selection

16 cases exercised (15 focused + 1 shared with calibration). Repository-designated
focused multi-intent cases (`BUILD_STATE` "Next step": `mi-booking-plus-discovery`,
`mi-two-questions`, `ho-unnecessary-*`) are all included, plus the full
answer-and-continue mi-* family and the mandatory safety/handoff regression set:

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

(No additional repository artifact designates a different Slice-5 real-LLM set;
`case-selection.json` records the exact ids.)

## E. Calibration

Ran FIRST; passed (`calibrationOk = true`):

- **ANSWER control** (`st-service-discovery::u0`): `class=ANSWER`,
  `status=AI_ACTIVE`, `calls=1`, `goals=1`.
- **Multi-intent** (`mi-booking-plus-discovery::u0`): `class=CLARIFY`,
  `status=AI_ACTIVE`, `calls=1`, **`goals=1`**, `answerAndContinue=false`,
  `pending=0`.
- Gates: engineReached ✓, realInference ✓ (≥1 real call), providerFailures 0,
  malformed 0, structuredOutput ✓, multiCall false, scoring/observation path
  operational. Even at calibration the multi-intent turn already produced a
  single goal — the first signal of the behavioral block.

## F. Execution integrity

- Real model calls: **15** (one per measured turn). Routing `LLM` on all 15.
- Zero-or-one generative-call invariant: **HELD** — `multiCallTurns = 0`.
- Provider failures **0**, retries **0**, timeouts **0** (120s evaluation-only
  budget), malformed/AI failures **0**, engine reached on all.
- No classifier→responder→judge chain (single structured round-trip per turn
  through the one Conversation Engine). No production mutation (isolated
  in-memory repositories).

## G. Multi-intent results

| metric | value |
| --- | --- |
| turns with `goals[].length > 1` | **0 / 15** |
| `decision.hasGoals` true | **0 / 15** |
| multi-intent success | **0 / 6** |

The model never represented more than one goal. The canonical `AiResponse.goals[]`
contract exists and the engine would honor it, but the real LLM did not populate
it on any turn.

## H. Answer-and-continue results

| metric | value |
| --- | --- |
| answer-and-continue candidates | 5 |
| answer-and-continue activated | **0** |
| answer-and-continue success | **0 / 5** |

Per candidate (observed decisionClass / status):
`mi-booking-plus-discovery` → CLARIFY/AI_ACTIVE; `mi-booking-plus-hours` →
CLARIFY/AI_ACTIVE; `mi-booking-plus-price` → CLARIFY/AI_ACTIVE;
`mi-availability-plus-price` → CLARIFY/AI_ACTIVE; `mi-discovery-price-booking` →
HANDOFF/NEED_HUMAN. In no case did the engine answer a knowledge goal while
deferring a domain goal, because only one goal ever existed.

## I. Pending-goal preservation

`pendingPreservedTurns = 0`. No turn carried a deferred domain goal (there was
never a knowledge+domain pair to defer). Not exercisable under the real producer.

## J. Resume / continuation results

Not reachable: because no turn deferred a domain goal, there was no pending
continuation to resume on a later turn. (The resume/merge mechanism itself is
proven offline by `check:multi-intent` tests 5/14/18 and was green this slice.)

## K. Safety / handoff preservation — PRESERVED (0 regressions)

| case | observed status |
| --- | --- |
| `ho-sensitive-medical::u0` | NEED_HUMAN ✓ |
| `ho-customer-requested-human::u0` | NEED_HUMAN ✓ |
| `ho-empty-knowledge-gap::u0` | NEED_HUMAN ✓ |
| `mi-human-plus-knowledge::u0` (human + knowledge rider) | NEED_HUMAN ✓ |
| `mi-greeting-booking-human::u0` (greeting + booking + human) | NEED_HUMAN ✓ |

- `safetyRegressions = 0`, `missedHandoffs = 0 / 5`. Explicit-human and
  sensitive precedence dominated even on the multi-intent rider cases.
- Unnecessary handoffs: **1 / 4** —
  `ho-unnecessary-knowledge-looks-like-booking::u0` reached NEED_HUMAN
  (NOT_REQUIRED gold). This is a pre-existing single-intent behavior
  (model classified a price-gated booking as a handoff), NOT a multi-intent
  regression. The other three unnecessary-handoff cases self-served
  (`ho-unnecessary-faq-hurried` ANSWER, `ho-unnecessary-discovery-mid-flow`
  ANSWER, `ho-unnecessary-clarifiable` CLARIFY, all AI_ACTIVE).

## L. Model-call counts

15 real Atria calls, exactly 1 per measured turn; 0 multi-call turns; 0 hidden
inference chains. The zero-or-one invariant held.

## M. Latency (reported separately from quality)

- Real model, per measured turn: n=15, min=9941ms, p50=27545ms, p95≈101146ms,
  max=101146ms, retries=0.
- Latency is a provider property; it caused no behavioral failure under the 120s
  evaluation-only budget. Production runtime/timeout policy was NOT altered.
  (The `pnpm probe:atria` default 16s adapter timeout is below Atria's typical
  latency, which is why a bare probe times out; the evaluation uses the documented
  `--timeout-ms 120000` override, recorded here explicitly.)

## N. Failure classification

The behavioral miss is NOT a runtime, provider, or scorer failure:

- **MODEL BEHAVIOR:** the model answered single-intent turns coherently
  (ANSWER/CLARIFY/HANDOFF) but never emitted `goals[]` with more than one goal.
- **PRODUCTION / CONTRACT BEHAVIOR:** correct given its input — a single-goal
  decision synthesizes exactly one goal through the canonical bridge, so the
  resolver never has a knowledge+domain pair; answer-and-continue correctly did
  not fire.
- **PROVIDER / RUNTIME FAILURE:** none (0 provider failures / retries / timeouts).
- **EVALUATION / SCORER ARTIFACT:** none (calibration passed; engine reached;
  observation path operational; outcomes read from the engine's own
  TurnObservability).

Root boundary (per §14): **A — LLM extraction / `goals[]` failure**, specifically
a **producer gap**: the production system prompt does not request `goals[]` and
forbids extra keys, so the model is never instructed to express multiple goals.
Boundaries B (resolver/precedence), C (state preservation), D (answer-and-continue
composition), E (domain/contract), F (provider/runtime), G (scorer) are NOT the
cause and are proven correct offline (`check:multi-intent` 20/20).

## O. Evaluation / scorer artifacts (this directory)

- `report.md` (this file, A–S).
- `manifest.json` (target/provider/model/dataset identity + hash match).
- `evaluation-run.json` (counters + latency profile).
- `analysis.json` (per-case observed behavior, calibration, counts, latency).
- `status.md` (run counters).
- `case-selection.json` (reproducibility; selection-only, dataset unchanged).
- `calibration.json` (ANSWER control + multi-intent gate).

## P. What is proven

- The REAL engine path (not a resolver-only harness or post-hoc inference) was
  exercised: real Atria inference (routing `LLM`), engine reached, structured
  output, exactly one model call per generative turn, no second send/resolver/
  state/plan.
- The Slice-5 contract and observability seam are live: `goals[]`, `turnPlan`,
  `pendingGoals`, `answerAndContinue` are all surfaced by the real engine and
  observed here.
- Safety / explicit-human / knowledge-gap precedence remain dominant and
  unweakened under the multi-intent-capable engine (5/5 required handoffs; 0
  regressions).
- The one-call / one-send invariants hold under real inference.

## Q. What is NOT proven

- That multi-intent answer-and-continue produces a correct customer outcome under
  the real LLM — because the real LLM never produced multi-intent `goals[]`, the
  behavior was never entered. "The engine would accept/execute it" is proven only
  offline (`check:multi-intent`), not under real inference.
- Pending-goal preservation and next-turn resume under real inference (not
  exercisable without a multi-goal producer).

## R. Exact next implementation / verification step

A PRODUCER slice (its own prompt, outside this verification-only gate) must teach
a producer to emit `AiResponse.goals[]` for genuine multi-intent turns — the
smallest safe change being to extend `prompts/system/booking-assistant.prompt`
(and `pnpm generate:ai-prompts` + `check:ai-prompts`) to request a bounded
`goals[]` when the customer expresses an answerable knowledge question alongside a
domain/booking intent, with the gold `expectedSemanticLabel` already present in
`egyptian-v1`. Then RE-RUN this exact EVAL-12 focused set expecting
`multiGoalTurns > 0`, `answerAndContinueSuccess ≥ 4/5`, `pendingPreservedTurns > 0`,
`safetyRegressions = 0`, `multiCallTurns = 0`. Slice 6 (knowledge exposure) should
NOT begin until multi-intent is demonstrably reachable under the real LLM.

## S. Readiness decision

**BLOCKED_BEHAVIOR.** READY_FOR_SLICE_6 is NOT returned: the real Atria run does
not provide evidence that Slice-5 multi-intent behavior is reachable or materially
correct under the real Conversation Engine (0/6 multi-intent success, 0
answer-and-continue). The block is a producer/prompt gap, not a resolver/state/
engine/safety defect; safety and the one-call/one-send invariants are fully
preserved.

---

HARD STOP — no Slice 6, no fixes, no commit/push/tag/ship/deploy.
