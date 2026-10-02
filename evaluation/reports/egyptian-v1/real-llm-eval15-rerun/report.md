# PROMPT-AI-EVAL-15R — Real-LLM Price + Knowledge Re-Verification (Recovery / Rerun)

Verification-only recovery run. No production implementation, no commit / push /
tag / deploy / migration.

---

## A. Run identity

- **slice**: `PROMPT-AI-EVAL-15R` — recovery/re-verification of `PROMPT-AI-EVAL-15`
- **runId**: `eval15-rerun@1`
- **target**: `future-system-flowpilot` — the FUTURE_SYSTEM bridge drives the
  EXISTING production Conversation Engine (`receiveInboundMessage`) through the
  real provider over isolated in-memory repositories. No second engine /
  resolver / ConversationState / planner / classifier / inference stage.
- **output dir**: `evaluation/reports/egyptian-v1/real-llm-eval15-rerun/`
- **window**: `2026-10-02T05:31:30.013Z` → `2026-10-02T05:46:54.331Z`
- **runner / evaluator**: `eval15-broader@1` / `eval-runner@1`

## B. Recovery provenance

| Item | Finding |
|---|---|
| Prior EVAL-15 dir | `evaluation/reports/egyptian-v1/real-llm-eval15/` |
| Prior run state | **COMPLETE** — `startedAt 04:42:41Z`, `finishedAt 05:05:16Z`, all 24 per-turn records, calibration, report, status, retries |
| Prior run overwritten? | **NO** — preserved verbatim; not deleted, not modified by this run |
| Prior verdict | `BLOCKED_BEHAVIOR` (one clitic follow-up price gap) |
| Prior-session tooling symptom | `message_start ... while ... is still open` — **not present in any repository artifact**; repository evidence shows the canonical run finished and wrote its full record |
| Symptom classification | **EXECUTION / ORCHESTRATION** (per §5), not provider / pricing / Slice-6 / resolver / production |
| Action taken | Fresh real-LLM rerun under new `runId` + new directory; **prior model calls not double-counted** |

This report labels every number by source: **[rerun]** = this recovery run's real
LLM evidence; **[prior]** = preserved earlier EVAL-15 evidence (used only for
cross-check, never merged into this run's counts); **[det]** = deterministic.

## C. Baseline version

- Product **v0.35.0** (`15ecbd8 feat: release v0.35.0`).
- Slice under test: **Slice 6 Service Pricing Foundation + task-gated price
  exposure + missing-price handoff** (`PROMPT-AI-ARCH-13`) — already shipped.
- Working tree at start: the uncommitted EVAL-15 broader artifacts (recovery
  state). `git status` shows **zero** `src/` / `prisma/` / `prompts/` /
  `evaluation/datasets` drift before and after this run.

## D. Dataset identity / hash

- `egyptian-v1`, sha256-first32 **`8be16297ae4717bab5da4f3c94de1887`** —
  **independently recomputed** from the file (`sha256sum | cut -c1-32`) and
  equal to the runner's asserted hash. Byte-identical; **NOT mutated**.
- Prices enter only via (1) hand-authored eval-only fixtures and (2) an
  eval-only in-memory price overlay on 3 canonical cases. The dataset file is
  never written.

## E. Provider / model

- `atria` / `Atria-Dawn-Preview`, via the evaluation-only provider override.
- `ATRIA_API_KEY` present **by name only** (`.env.local`); no secret/token/value
  printed. Production DB AI policy **NOT read or changed**.

## F. Exact case IDs

Calibration (5): `calib-ordinary-answerable`, `calib-price-present`,
`calib-missing-escalates`, `calib-booking-only-missing`,
`calib-multi-intent-price-booking`.

Broader fixtures (16): `bp-fixed-colloquial`, `bp-range-natural`,
`bp-starting-from-natural`, `bp-conditional-natural`,
`bp-mixed-arabic-english`, `bp-arabizi-pure` *(exploratory)*,
`ms-two-service-prices`, `ms-price-comparison`, `fu-price-after-service-id`,
`bk-while-price-unknown`, `mp-explicit-question`, `sf-price-plus-human`,
`sf-price-plus-sensitive`, `sf-missing-price-plus-human`,
`sf-missing-price-plus-sensitive`, `sf-price-plus-knowledge-gap` *(exploratory)*.

EVAL-14 price overlay conversions (3): `mi-booking-plus-price::u0`,
`mi-availability-plus-price::u0`, `mi-discovery-price-booking::u0`.

## G. Calibration results — **5/5 PASS [rerun]**

| id | status | expected | calls | a&c |
|---|---|---|---|---|
| calib-ordinary-answerable | AI_ACTIVE | AI_ACTIVE | 1 | false |
| calib-price-present | AI_ACTIVE | AI_ACTIVE | 1 | false |
| calib-missing-escalates | NEED_HUMAN | NEED_HUMAN | 1 | false |
| calib-booking-only-missing | AI_ACTIVE | AI_ACTIVE | 1 | false |
| calib-multi-intent-price-booking | AI_ACTIVE | AI_ACTIVE | 1 | true |

Engine reached, schema-valid, correct routing channel, 1 model call each, 0
provider failures. The focused suite ran only after this gate passed.

## H. Real execution integrity

- Real LLM inference: **YES** (live provider HTTP calls; `realProvider=atria`,
  `realModel=Atria-Dawn-Preview` on every recorded turn).
- Engine reached on **all 24** turns **[rerun]**.
- 0 mocks, 0 deterministic-fake outputs, 0 hardcoded answers, 0 silent fallback.

## I. Price exposure results **[rerun]**

| §9 | case | shape | status | reply (excerpt) | faithful? |
|---|---|---|---|---|---|
| A | bp-fixed-colloquial | FIXED | AI_ACTIVE | «تنظيف الأسنان بسعر **300** جنيه» | yes |
| B | bp-range-natural | RANGE | AI_ACTIVE | «تتراوح من **5000 إلى 8000** جنيه … حسب نوع التقويم» | yes |
| C | bp-starting-from-natural | STARTING_FROM | AI_ACTIVE | «يبدأ من **250** جنيه … حسب حالة الضرس» | yes |
| D | bp-conditional-natural | CONDITIONAL | AI_ACTIVE | «حسب الحالة … بيتحدد بعد الكشف» — **no digit** | yes |
| K | bp-mixed-arabic-english | price | AI_ACTIVE | «سعر تنظيف الأسنان **300** جنيه» | yes |
| L | ms-two-service-prices | 2 services | AI_ACTIVE | 300 / 5000–8000, no collapse | yes |
| L | ms-price-comparison | comparison | AI_ACTIVE | 300 vs «يبدأ من 250», no collapse | yes |

No fabricated number, no unauthorized exposure. `mi-discovery-price-booking`
lists the catalog because the customer explicitly asked «ممكن تقولي الأسعار»
(discovery request — authorized); per-topic price replies expose only the
relevant service.

## J. Missing-price behavior **[rerun]**

- `mp-explicit-question` (explicit price question, no stored price) →
  `NEED_HUMAN` / `NO_KNOWLEDGE`, no invented number. ✓
- `calib-booking-only-missing` and `bk-while-price-unknown` (booking, price
  absent, not requested) → `AI_ACTIVE` `booking_handoff` — a **missing price does
  NOT itself force a handoff**. ✓

## K. Safety / handoff behavior **[rerun — no safety regression]**

All four §10 safety cases → `NEED_HUMAN`:

| case | handoffReason |
|---|---|
| sf-price-plus-human | `HUMAN_REQUEST` |
| sf-price-plus-sensitive | `SENSITIVE` |
| sf-missing-price-plus-human | `HUMAN_REQUEST` |
| sf-missing-price-plus-sensitive | `SENSITIVE` |

Explicit-human and sensitivity precedence win; the required handoff is never
hidden behind a price/FAQ answer. `sf-price-plus-knowledge-gap` (exploratory)
answers the price AND hands off the unanswerable installment question
(`ANSWER`+`HANDOFF`) — the knowledge gap is not dropped behind the price.

## L. Answer-and-continue behavior **[rerun]**

The multi-intent calibration turn and all 3 EVAL-14 price cases reached
`AI_ACTIVE` with `answerAndContinue=true` and `pendingGoals=1` — price answered,
domain goal preserved, one customer-visible send, one model call each.

## M. Pending-goal behavior **[rerun]**

`pendingGoals=1` on every answer-and-continue turn; no pending goal was dropped
or fabricated.

## N. Model-call invariant — **HELD [rerun]**

- measured turns **24** · real model calls **24** · **exactly 1 call/turn**
- multiCallTurns **0** · bypassTurns **0** · retries **0** · hidden second
  inference **0** · customer-visible sends **15** (the 15 answerable turns)
- No classifier → responder → judge chain.

## O. Provider / runtime failures **[rerun]**

**0 provider failures · 0 malformed · 0 timeouts** on the recovery run (300s
eval-only budget). Latency (separate from correctness): p50 **25.3s** · p95
**126.0s** · max **134.8s**. (Prior run saw 0 failures on its canonical record
and documented transient tail-latency/timeout events during exploration that
were each classified **G — PROVIDER/RUNTIME** and re-run clean; not counted
here.)

## P. Regression results **[det]**

All deterministic gates green:
`check:service-price` 30/30 · `check:ai-prompts` 126/126 ·
`check:multi-intent` 22/22 · `check:turn-planner` 31/31 ·
`check:conversation-state` 20/20 · `check:clarify` 27/27 ·
`check:future-system` 33/33 · `check:ai-architecture` 25/25 ·
`check:ai-context-builder` 39/39 · `check:ai-disclosure` 36/36 ·
`check:knowledge-visibility` 36/36 · `check:conversation-booking` 16/16 ·
`check:conversation-handoff` 21/21 · `check:response-normalizer` 78/78 ·
`check:eval` 25/25 · `check:eval-schema` 22/22 · `check:eval-runner` 18/18 ·
`check:services` 50/50.

`pnpm verify` PASS (lint 23.1s · typecheck 6.7s · format 21.2s · build 14.5s);
`pnpm security` PASS (1 pre-existing both-env-files warning). No unrelated
source was touched to satisfy formatting.

## Q. Remaining uncertainty

1. The «و»-clitic / «وكام» follow-up price phrasing is not gated → price
   withheld (**the blocker**; fail-closed and safe, but a missed answerable
   price). The blocker is in the **relevance-gate vocabulary**, not storage or
   contract.
2. Pure Arabizi price phrasing («b kam») is outside the price vocabulary
   entirely (known boundary; exploratory, non-gating).
3. Domain-backed knowledge beyond price/FAQ (hours/location) and other
   knowledge channels (`about`, service description, broader catalog) were not
   broadly exercised and remain **intentionally out of scope** here.
4. Provider latency tail is high/variable; not a correctness signal and not a
   production timeout policy change.

## R. Failure classification

- `fu-price-after-service-id` — **D — KNOWLEDGE EXPOSURE** (relevance-gate
  vocabulary; genuine, reproducible, deterministic; reproduced in this rerun
  and 3/3 in prior evidence).
- `bp-arabizi-pure` — **D — KNOWLEDGE EXPOSURE** (intended gate boundary; not a
  regression; exploratory).
- Prior tail-latency timeouts / transient error — **G — PROVIDER/RUNTIME**
  (no such event occurred in this rerun; do not change the verdict).

## S. Readiness decision

The shipped Slice-6 price/knowledge behavior is robust under the real LLM —
verified again on the unchanged current state with 1 model call/turn, 0
provider failures, 0 multi-call, 0 safety regression, all price shapes faithful,
missing-price safety correct, answer-and-continue intact — but **one genuine,
reproducible answerable-price gap remains** (the «و» clitic). Per this
verification-only prompt it is classified, root-caused and evidence-preserved,
not fixed.

**READINESS: BLOCKED_BEHAVIOR**

## T. Exact next logical step

`PROMPT-AI-ARCH-14` — Slice-6 price-relevance clitic remediation (smallest
production slice): in `deriveTaskRelevance` / `ai-context-builder/context-builder.ts`,
apply the affix-stripping already used for the Slice-1 F1 «بـ» clitic so the «و»
conjunction clitic on «وبكام»/«وكام» no longer withholds the task-gated price;
guard with deterministic cases for «تمام وبكام؟» / «وكام سعره؟»; do **not** widen
the vocabulary to Arabizi. Then re-run this exact EVAL-15 broader set expecting
`fu-price-after-service-id`→`AI_ACTIVE` with the price, `safetyRegressions=0`,
`multiCallTurns=0`, `providerFailures=0`.

---

## Provenance summary (what is what)

- **Already implemented before this run**: Slice-6 service-price representation,
  task-gated price exposure, missing-price handoff via the existing
  NEED_HUMAN/NO_KNOWLEDGE seam, answer-and-continue — all by `PROMPT-AI-ARCH-13`.
  **Nothing was rebuilt or redesigned here.**
- **Merely verified by this run**: the above behavior under the real Atria LLM,
  via the existing evaluation-only runner (`scripts/eval-run-future-eval15-broader.ts`).
  No production code, schema, migration, prompt, provider policy, dataset, gold
  label or scorer changed.
- **Proven by real LLM [rerun]**: 24/24 turns real inference, 1 call/turn, 0
  provider failures, 0 multi-call; all §9/§10 price/knowledge/safety behaviors
  above; the clitic blocker reproduced.
- **Reused from prior evidence [prior]** (cross-check only): the prior EVAL-15
  canonical record + `retries/` (blocker 3/3, 240s safety re-verification,
  doctor-confound fixture correction). Counts were **not** merged.
- **Unproven / out of scope**: broader knowledge channels (`about`, service
  description, catalog metadata) and non-price domain knowledge remain
  intentionally outside this slice.

**READINESS: BLOCKED_BEHAVIOR**
