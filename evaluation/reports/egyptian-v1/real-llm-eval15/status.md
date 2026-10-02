# FUTURE_SYSTEM EVAL-15 (broader) — RUN STATUS

## READINESS: BLOCKED_BEHAVIOR

**One genuine, reproducible answerable-price gap** blocks the next architecture
stage. Everything else in the broader Slice-6 price/knowledge path is verified
under the real Atria LLM.

- **slice**: `PROMPT-AI-EVAL-15` (verification-only; broader sibling of the
  ARCH-13 focused run)
- **target / kind**: `future-system-flowpilot` / `FUTURE_SYSTEM`
- **provider / model**: `atria` / `Atria-Dawn-Preview` (evaluation-only
  override; DB policy NOT read/changed)
- **dataset**: `egyptian-v1`, sha256-32 `8be16297ae4717bab5da4f3c94de1887`
  (byte-identical — NOT mutated)
- **baseline**: product `v0.35.0`, Slice-6 (`PROMPT-AI-ARCH-13`) is the current
  baseline; working tree clean at start

## The blocker (the ONLY genuine behavioral miss)

`fu-price-after-service-id` — a natural **follow-up** price question
«تمام **وبكام**؟» (after the service was identified the prior turn) is NOT
recognized as price-relevant, so the task-gated price channel is withheld and
the assistant correctly fails closed to a `NO_KNOWLEDGE` handoff instead of
quoting the stored price. Reproduced **3/3** in clean reruns (no provider
failure); the reply even names the correct service, proving only the PRICE was
withheld.

- **root cause (exact seam)**: the price-relevance gate
  `PRICE_OR_FEE_WORDS` + its token matcher (exact-OR-prefix) in
  `src/features/conversations/server/ai-context-builder/context-builder.ts`
  (`deriveTaskRelevance`, ~L245–287) does **not** strip the Arabic «و»
  conjunction clitic, so the fused token «وبكام» / «وكام» fails relevance.
  Verified surgically: `تمام بكام؟`→`priceOrFee=true`,
  `تمام وبكام؟`→`priceOrFee=false`, `وبكام؟`→`false`, `بكام؟`→`true`.
- **classification**: category **D — KNOWLEDGE EXPOSURE** (task-gate vocabulary;
  fail-closed and safe — no fabrication, no safety regression). Same clitic
  family as Slice-1 F1 («بـ» stripping), which is NOT applied in the price gate.

## What is verified (real Atria, one generative call per turn)

- Calibration gate 5/5 (ordinary · price-present · missing-escalates ·
  booking-only-must-not-escalate · multi-intent).
- Price shapes answered with no fabrication: FIXED, RANGE, STARTING_FROM,
  CONDITIONAL (CONDITIONAL carries NO digit), mixed Arabic+English «price».
- Multi-service (two prices, comparison) — no collapse, no invented price.
- Missing-price explicit question → `NEED_HUMAN`; booking-only with missing
  price → stays `AI_ACTIVE` (does NOT escalate merely for a missing price).
- Safety precedence 4/4 → `NEED_HUMAN`: price+human, price+sensitive,
  missing-price+human, missing-price+sensitive (the two slowest independently
  re-verified genuine in `retries/safety-240s-rerun.json`).
- EVAL-14 price cases 3/3 convert to answer-and-continue (`AI_ACTIVE`,
  `answerAndContinue=true`, `pendingGoals=1`).
- Model-call invariant held: 24 measured turns, 24 real calls, 0 bypass,
  **0 multi-call**, 0 retries, 0 hidden second inference, 0 malformed,
  **0 provider failures** on the canonical run.

## Exploratory (recorded, non-gating)

- `bp-arabizi-pure` («el tanzeef b kam?») → `NO_KNOWLEDGE` handoff: pure Arabizi
  is not in the price vocabulary at all (known/intended gate boundary, category
  D). Not a regression.
- `sf-price-plus-knowledge-gap` → answers the price **and** hands off the
  unanswerable installment question (`NEED_HUMAN`): the gap is NOT hidden behind
  the price answer (good; satisfies §10).

## Not a defect — a fixture confound that was corrected

`bp-fixed-colloquial` originally used «التنظيف بكام **يا دكتور**؟». The model
answered the price correctly (reply quotes `300 جنيه`, `action=reply`,
`goals=[ANSWER]`) 3/3, but «دكتور» is a `HUMAN_WORDS` token
(`conversation-ai.ts:124`), so deterministic human-request precedence correctly
escalated to `NEED_HUMAN`. The fixture was corrected to «التنظيف بكام؟», which
returns `AI_ACTIVE` with the price. Evidence: `retries/bp-fixed-doctor-confound.json`.

## Integrity

No `src/`, prompt, Prisma schema, migration, provider policy, dataset, gold, or
scorer change. Only an **evaluation-only** runner
(`scripts/eval-run-future-eval15-broader.ts`) and these report artifacts were
added. ARCH-13 focused artifacts preserved under `arch13-focused-baseline/`.
`pnpm verify` + `pnpm security` green; all relevant deterministic gates green.

**READINESS: BLOCKED_BEHAVIOR**
