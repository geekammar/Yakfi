# EVAL-04B Real-LLM Baseline — RUN STATUS: COMPLETE

> Measurement-only slice `PROMPT-AI-EVAL-04B`. No production behavior, prompt,
> contract, provider policy, router, knowledge retrieval, state model, or UI was
> changed. No deploy, no commit, no tag. Real model inference was used
> (`codecraft/deepseek-v4-flash-0731`, resolved live from the platform policy).

## Coverage

- 1,933 / 1,933 cases scored. 2,972 customer turns replayed (2,781 genuine LLM
  turns + 190 deterministic bypass).
- **1,932 cases produced genuine LLM/bypass outcomes; 1 case
  (`adv-two-providers-one-message::u2`) is a reproducible provider `TIMEOUT` at
  the 16s production cap, recorded on the `PROVIDER_FAILURE` channel — never
  silently excluded.**
- Result schema VALID; dataset↔result reconciliation: 0 missing / 0 extra;
  verdict sum = 1,933 = totalCases; scored (1,893) = PASS+LIMITATION+FAIL.

## Read these

- `BASELINE.md` — the full real-LLM baseline + analysis (sections A–S).
- `COMPARISON.md` — deterministic (EVAL-04) vs real-LLM (EVAL-04B).
- `evaluation-run.json` — machine artifact (EVAL-01 schema, per-case
  expected/actual/verdict/failureCategory + telemetry).
- `analysis.json` — computed breakdowns (handoff, multi-intent, ambiguity,
  knowledge, language, multi-turn/state, safety, latency, failure clusters).
- `report.md` / `manifest.json` — runner-emitted summary + reproducibility
  manifest.
- `checkpoint.ndjson` — resumable per-case execution log (source of the
  telemetry; retains the genuine per-turn outcomes).

## Getting here (execution notes)

The current effective policy is `codecraft/deepseek-v4-flash-0731` with **no
fallback**. During the run two provider conditions were encountered and handled:

1. **Balance outage** — mid-run the endpoint returned `HTTP 402
   insufficient_funds`; with no fallback, every subsequent turn failed to
   `NEED_HUMAN`. After a top-up, `pnpm eval:run-real` was re-run; it retries ONLY
   provider-failed cases (they are never frozen as failures) and skips completed
   ones.
2. **Throttling / tail latency** — sustained concurrency ≥8 triggered provider
   `INVALID_RESPONSE` cascades; concurrency 4→1 was clean. The run was completed
   in waves at low concurrency. One prompt reproducibly exceeds the 16s cap (the
   single remaining `PROVIDER_FAILURE`).

## Reproduce

```sh
pnpm eval:run-real -- --out evaluation/reports/egyptian-v1/real-llm-baseline --concurrency 4
pnpm tsx scripts/eval-analyze-real.ts
```

A CALIBRATION smoke (27 representative cases) is in `../real-llm-calibration/`
(CALIBRATION ONLY — not the official baseline).
