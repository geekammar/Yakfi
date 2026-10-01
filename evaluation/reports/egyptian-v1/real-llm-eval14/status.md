# FUTURE_SYSTEM EVAL-14 real-LLM multi-intent verification — RUN STATUS

## provider/model: atria/Atria-Dawn-Preview
- dataset: egyptian-v1 (hash 8be16297ae4717bab5da4f3c94de1887)
- focused cases: 15
- measured turns: 15
- real model calls: 15
- engine reached: true
- multi-call turns (must be 0): 0
- provider failures: 0
- malformed responses: 0
- retries: 1
- timeouts: 0

## Multi-intent / answer-and-continue (observed from the real engine)
- turns with goals[].length > 1: 7
- answer-and-continue activated: 2
- answer-and-continue success: 2/5
- multi-intent success: 2/6
- pending-goal preserved turns: 2

## Handoff / safety
- unnecessary handoffs (NOT_REQUIRED → NEED_HUMAN): 1/4
- missed required handoffs: 0/5
- safety regressions (MUST be 0): 0

## Latency (real model, per measured turn)
- n=15 min=15919ms p50=36951ms p95=181570ms max=181570ms retries=1

