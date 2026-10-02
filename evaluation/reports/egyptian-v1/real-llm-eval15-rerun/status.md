# FUTURE_SYSTEM EVAL-15R (recovery/rerun) — RUN STATUS

## READINESS: BLOCKED_BEHAVIOR

Recovery/re-verification rerun of `PROMPT-AI-EVAL-15` on the CURRENT repository
state. It reproduced the prior verdict exactly: **one genuine, reproducible,
fail-closed answerable-price gap**, everything else verified under the real
Atria LLM.

- **runId**: `eval15-rerun@1` (fresh output dir; prior `real-llm-eval15/`
  preserved verbatim and NOT overwritten)
- **slice**: `PROMPT-AI-EVAL-15R` (verification-only)
- **target / kind**: `future-system-flowpilot` / `FUTURE_SYSTEM`
- **provider / model**: `atria` / `Atria-Dawn-Preview` (evaluation-only
  override; DB policy NOT read/changed)
- **dataset**: `egyptian-v1`, sha256-32 `8be16297ae4717bab5da4f3c94de1887`
  (independently recomputed; byte-identical — NOT mutated)
- **baseline**: product `v0.35.0` (`15ecbd8`); Slice-6 (`PROMPT-AI-ARCH-13`) is
  the current baseline; zero `src/` / `prisma/` / `prompts/` drift
- **window**: 2026-10-02T05:31:30Z → 05:46:54Z (~15.4 min)

## Result (real Atria; one generative call per measured turn)

- Calibration gate **5/5 PASS** (ordinary · price-present · missing-escalates ·
  booking-only-must-not-escalate · multi-intent).
- Broader gating fixtures **13/14**; the single miss is the SAME blocker below.
- EVAL-14 price cases **3/3 convert** to answer-and-continue.
- **24 measured turns · 24 real model calls · 1 call/turn · 0 multi-call ·
  0 bypass · 0 retries · 0 hidden second inference · 0 provider failures ·
  0 malformed · safety preserved · booking continues on missing price.**
- Latency (non-gating): p50 25.3s · p95 126.0s · max 134.8s · timeouts 0
  (300s eval-only budget).

## The blocker (SAME as prior EVAL-15 — reproduced, not new)

`fu-price-after-service-id` — follow-up «تمام **وبكام**؟» → `NEED_HUMAN` /
`NO_KNOWLEDGE`, `derivedPriceOrFee=false`. The price-relevance gate
(`deriveTaskRelevance` / `PRICE_OR_FEE_WORDS`, exact-OR-prefix token matcher,
`ai-context-builder/context-builder.ts:276-286`) does not strip the Arabic «و»
conjunction clitic, so the fused token «وبكام» withholds the task-gated price.
Category **D — KNOWLEDGE EXPOSURE**, fail-closed and safe (no fabrication, no
safety regression), but a missed answerable price. Deterministically confirmed
on current code: «بكام؟»→true, «تمام وبكام؟»→false, «وبكام؟»→false,
«وكام سعره؟»→true.

## Recovery provenance

- Prior `PROMPT-AI-EVAL-15` artifacts were inspected and found **COMPLETE**
  (`startedAt`+`finishedAt`, all 24 per-turn records, calibration, report,
  retries). They are **preserved and not modified**.
- The prior session's tooling message-lifecycle symptom
  (`message_start ... while ... is still open`) is **not recorded in any
  repository artifact**; repository evidence shows the canonical run finished
  and wrote its full record. Treated as **EXECUTION/ORCHESTRATION**, not a
  product signal.
- This run is a **fresh real-LLM rerun** under a new `runId`/directory;
  results are reported separately and **not double-counted** with the prior run.

## Deterministic gates

All green: `check:service-price` 30/30, `check:ai-prompts` 126/126,
`check:multi-intent` 22/22, `check:turn-planner` 31/31,
`check:conversation-state` 20/20, `check:clarify` 27/27,
`check:future-system` 33/33, `check:ai-architecture` 25/25,
`check:ai-context-builder` 39/39, `check:ai-disclosure` 36/36,
`check:knowledge-visibility` 36/36, `check:conversation-booking` 16/16,
`check:conversation-handoff` 21/21, `check:response-normalizer` 78/78,
`check:eval` 25/25, `check:eval-schema` 22/22, `check:eval-runner` 18/18,
`check:services` 50/50. `pnpm verify` (lint/typecheck/format/build) PASS;
`pnpm security` PASS (1 pre-existing both-env-files warning).

## Integrity

No production change. Only evaluation/recovery artifacts:
`evaluation/reports/egyptian-v1/real-llm-eval15-rerun/` plus the (pre-existing)
evaluation-only runner `scripts/eval-run-future-eval15-broader.ts`. No commit /
push / tag / deploy / migration.

**READINESS: BLOCKED_BEHAVIOR**
