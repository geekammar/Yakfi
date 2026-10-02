# FUTURE_SYSTEM EVAL-15 — Service-price real-LLM verification

## READINESS: READY_FOR_PRICE_REAL_LLM_REVERIFY

- provider/model: atria/Atria-Dawn-Preview
- dataset: egyptian-v1 (hash 8be16297ae4717bab5da4f3c94de1887, byte-identical — NOT mutated)
- real model calls: 13 · multi-call turns: 0 (one send/turn)
- provider failures: 0 · malformed: 0

## Behavioral results
- focused fixtures passed: 7/7
- EVAL-14 price-case conversions: 3/3
- safety/human precedence preserved: true
- booking continues when price missing but not requested: true

See analysis.json / calibration.json for the per-case observed records.

