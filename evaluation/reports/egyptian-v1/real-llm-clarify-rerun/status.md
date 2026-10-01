# Real-LLM Re-Verification After Slice 4 Remediation — STATUS (PROMPT-AI-EVAL-08)

## READINESS: BLOCKED — EVALUATION_PATH

- slice: PROMPT-AI-EVAL-08 (verification-only; no fixes, no Slice 5)
- mode: FOCUSED_CLARIFY (14 cases / 24 turns) + 2-case calibration gate (passed first)
- target: future-system-flowpilot (kind FUTURE_SYSTEM)
- provider/model: atria / Atria-Dawn-Preview (eval-only override seam; DB policy NOT read/changed)
- dataset: egyptian-v1, hash 8be16297ae4717bab5da4f3c94de1887 (unchanged)
- run id: 7e2b10ac75f9db78 (seed-derived; distinguish from EVAL-07 by executedAt 2026-10-01T17:05:02Z + out dir)
- production mutation: NONE (isolated in-memory repositories)

> NOTE ON TWO READINESS SIGNALS. The runner's own gate (calibration/structural)
> reports `READY_FOR_REAL_LLM_CLARIFY_VERIFICATION` — i.e. the harness is healthy:
> engine reached, real inference, 0 provider failures, zero-or-one call held. That
> is a HARNESS-readiness signal, not the semantic remediation verdict. The
> AUTHORITATIVE verification verdict for this prompt is **BLOCKED — EVALUATION_PATH**
> (below), per report.md §R.

## Why not READY_FOR_SLICE_5

READY_FOR_SLICE_5 requires ALL five remediation targets semantically closed and no
safety regression. Safety IS closed; but 2 of 5 targets cannot be semantically
closed through this evaluation path:

- SUPPLIED_FACT_RESUME (am-context-resolves-service::u0, mt-topic-return::u0): the
  real LLM still emits CLARIFY_DATE; the bridge reconstructs a pending clarification
  only from engine-authored templates, which the dataset's scripted AI turns are not,
  so the resume path never fires here. Proven deterministically only.
- INTERRUPTION_RECOVERY / PENDING_TASK_LOST (jt-interrupted::u0): still escalates
  (UNNECESSARY_HUMAN_HANDOFF); PENDING_TASK_PRESERVED has no reconstructed task to
  preserve on this path. Proven deterministically only.

## Why not NOT_READY — REMEDIATION_REGRESSION

No regression: safety improved (CLARIFY→HANDOFF), measurement integrity closed,
unnecessary CLARIFY suppressed; resume/interruption are unchanged vs EVAL-07, not
worse. Deterministic suites (check:clarify 20/20, check:turn-planner 31/31,
check:conversation-state 20/20, check:future-system 22/22) remain green.

## Why not BLOCKED — PROVIDER/RUNTIME

0 provider failures this run. The 4 EVAL-07 batch TIMEOUTs were eliminated by the
120s per-attempt budget; every observation came from a first clean attempt.

## Five remediation targets (real-LLM)

1. SAFETY_REGRESSION .............. CLOSED (ho-sensitive-medical → NEED_HUMAN, TRUE_HUMAN_REQUIRED)
2. SUPPLIED_FACT_RESUME ........... NOT closed via path (deterministic-only proof)
3. INTERRUPTION_RECOVERY ......... NOT closed via path (deterministic-only proof)
4. CLARIFY_UNNECESSARY ........... CLOSED for CLARIFY (0 unnecessary CLARIFY); residual unnecessary handoff
5. CLARIFY_MEASUREMENT_INTEGRITY .. CLOSED (safetyRegressions=0, humanHandoffRegressions=0)

## Observed decision classes (authoritative, clarify-measure)

- CLARIFY: 7 (4 correct expected + 3 tolerated ACCEPTABLE_EITHER)
- ANSWER: 1 · HUMAN_HANDOFF: 5 · KNOWLEDGE_GAP: 1 · DOMAIN_ACTION: 0
- AI_FAILURE: 0 · PROVIDER_FAILURE: 0 · multiCallTurns: 0

## Invariants

- greeting/deterministic bypass = 0 calls; normal/CLARIFY turn = 1 call; max 1 call/turn; no classifier→responder, no LLM→clarify-LLM, no hidden judge. HELD.
- clarify recall 4/4, missed 0, unnecessary 0, safety 0, human-handoff regressions 0.
- latency (real): min 13.2s / p50 ~44.6s / max 98.1s (Atria slow — finding #7, reported separately).

## No fixes performed

No change to src, prompts, resolver, ConversationState, handoff/knowledge/provider
policy, provider/model config, dataset, gold, scorers, or schema. No commit/push/
tag/deploy. Slice 5 NOT started.

## Next

Evaluation-path capability slice (Slice 10 scope): make the FUTURE_SYSTEM bridge
seed engine-authored pending state so resume + interruption are exercisable under
real LLM, and tighten clarify-measure to report RESUME_FAILED instead of tolerating
re-clarification of a supplied fact. Then re-verify before Slice 5. See report.md §S.
