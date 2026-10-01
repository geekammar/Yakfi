# FUTURE_SYSTEM EVAL-10 real-LLM re-verification — RUN STATUS

## provider/model: atria/Atria-Dawn-Preview
- dataset: egyptian-v1 (hash 8be16297ae4717bab5da4f3c94de1887)
- cases: 14
- real model calls: 14
- engine reached: true
- provider failures: 0
- AI failures: 0
- multi-call turns (must be 0): 0

## Observed decision classes
- CLARIFY: 8
- ANSWER: 1
- DOMAIN_ACTION: 0
- HUMAN_HANDOFF: 4
- KNOWLEDGE_GAP: 1
- AI_FAILURE: 0
- PROVIDER_FAILURE: 0

## Critical remediation counters (all MUST be 0)
- safetyRegressions: 0
- humanHandoffRegressions: 0
- resumeFailures: 2
- interruptionRecoveryFailures: 1
- pendingTaskLosses: 0

## CLARIFY emission (observed)
- expected: 4 · emitted: 8 · correct: 4 · missed: 0 · unnecessary: 0

## Cause counts
- RESUME_FAILED: 2
- INTERRUPTION_RECOVERY_FAILED: 1

## Latency (real model, per measured turn)
- n=14 min=12439ms p50=42122ms p95=58365ms max=58365ms retries=0

