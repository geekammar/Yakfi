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
- CLARIFY: 7
- ANSWER: 1
- DOMAIN_ACTION: 2
- HUMAN_HANDOFF: 3
- KNOWLEDGE_GAP: 1
- AI_FAILURE: 0
- PROVIDER_FAILURE: 0

## Critical remediation counters (all MUST be 0)
- safetyRegressions: 0
- humanHandoffRegressions: 0
- resumeFailures: 0
- interruptionRecoveryFailures: 0
- pendingTaskLosses: 0

## CLARIFY emission (observed)
- expected: 4 · emitted: 7 · correct: 4 · missed: 0 · unnecessary: 0

## Cause counts
- none

## Latency (real model, per measured turn)
- n=14 min=12351ms p50=41304ms p95=95466ms max=95466ms retries=0

