# FUTURE_SYSTEM EVAL-15 (broader) — ARCH-14 CLITIC REMEDIATION RUN STATUS

## READINESS: READY_FOR_NEXT_STAGE

Slice-6 price-relevance «و» clitic remediation (`PROMPT-AI-ARCH-14`), re-verified
under the real Atria LLM on the EXISTING EVAL-15 broader runner and the
UNCHANGED canonical dataset. Implementation + verification only; no release.

- **runId**: `eval15-broader@1` (runner) · output dir
  `evaluation/reports/egyptian-v1/real-llm-eval15-arch14/` (prior
  `real-llm-eval15/` and `real-llm-eval15-rerun/` preserved, not overwritten)
- **slice**: `PROMPT-AI-ARCH-14` (implementation + verification)
- **target / kind**: `future-system-flowpilot` / `FUTURE_SYSTEM`
- **provider / model**: `atria` / `Atria-Dawn-Preview` (evaluation-only
  override; production DB policy NOT read/changed)
- **dataset**: `egyptian-v1`, sha256-32 `8be16297ae4717bab5da4f3c94de1887`
  (byte-identical — NOT mutated); fixtures/gold/case-selection unchanged
- **baseline**: product `v0.35.0` (`15ecbd8`); Slice-6 (`PROMPT-AI-ARCH-13`)
  was the baseline
- **fixture set**: unchanged — 5 calibration + 16 broader + 3 dataset
  conversions = **24 measured turns**
- **window**: 2026-10-02T11:37:15Z → 2026-10-02T11:57:11Z (~19.9 min)

## Result (clean full run — the authoritative `analysis.json`)

- Calibration gate **5/5 PASS**.
- Broader gating fixtures **14/14 PASS** (was **13/14**): the previously failing
  `fu-price-after-service-id` («تمام وبكام؟») now → `AI_ACTIVE`,
  `derivedPriceOrFee=true`, reply carries the stored price «300 جنيه».
- EVAL-14 price cases **3/3 convert** to answer-and-continue (`a&c=true`,
  `pending=1`).
- **24 measured turns · 24 real model calls · 1 call/turn · 0 multi-call ·
  0 bypass · 0 provider failures · 0 malformed.**
- Safety **4/4 → NEED_HUMAN** (`sf-price-plus-human`, `sf-price-plus-sensitive`,
  `sf-missing-price-plus-human`, `sf-missing-price-plus-sensitive`); price
  answerability never outranks the human/sensitive handoff.
- Booking-only with missing price → `AI_ACTIVE` (`bk-while-price-unknown`);
  missing-price explicit question → `NEED_HUMAN` with **no digits**
  (`mp-explicit-question`).
- Exploratory, unchanged and non-gating: `bp-arabizi-pure` → `NEED_HUMAN`
  (intended out-of-vocabulary boundary — NOT widened); `sf-price-plus-knowledge-gap`
  → `NEED_HUMAN` (gap not hidden).
- Latency (non-gating, provider property): p50 30.8s · p95 199.4s · max 252.4s ·
  timeouts 0 (300s eval-only route budget). Production timeout policy unchanged.

## Provider runtime note (honest accounting)

Earlier attempts hit transient Atria runtime events (fast-fail
`providerFailure=true` at <2s, and one ~300s route-budget timeout on the
slowest safety turn) that the calibration/aggregate gate correctly BLOCKED
(`BLOCKED_PROVIDER`) — these are external provider/runtime conditions, not
behavioral regressions and not caused by this change. The slow safety case was
independently re-verified GENUINE in isolation
(`retries/sf-price-plus-human-run1/`: `providerFail=0`, 80.6s, `NEED_HUMAN`),
and the final full pass above completed with **0 provider failures**.

## Implementation (what changed)

- `src/features/conversations/server/conversation-ai.ts`: the EXISTING Slice-1
  F1 `stripAffixes` seam gained a length-guarded Egyptian conjunction «و» strip
  (the «بـ» clitic handling is unchanged) and is now exported.
- `src/features/conversations/server/ai-context-builder/context-builder.ts`:
  `deriveTaskRelevance` maps the price-gate tokens through that seam, so
  «وبكام»/«وكام» matches the price vocabulary. Scoped to `priceOrFee` only —
  the other relevance families keep their exact prior matching.

No generic Arabizi layer, no new Arabic NLP subsystem, no Unicode rewriting, no
second resolver/engine/state/planner/classifier, no second model call, no
schema/migration/pricing-semantics/prompt/provider/dataset/gold/scorer change.
