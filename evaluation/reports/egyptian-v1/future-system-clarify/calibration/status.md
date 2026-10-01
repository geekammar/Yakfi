# FUTURE_SYSTEM CLARIFY bridge — RUN STATUS

## READINESS: READY_FOR_REAL_LLM_CLARIFY_VERIFICATION

- mode: CALIBRATION_ONLY
- target: future-system-flowpilot (FUTURE_SYSTEM)
- provider/model: atria/Atria-Dawn-Preview
- cases: 2
- engine reached (turnPlan observable on every case): true
- real inference occurred (≥1 model call): true
- provider failures: 0
- zero-or-one call invariant held (no multi-call turns): true
- scoring operating: true
- schema valid: true

## Observed decision classes
- CLARIFY: 1
- ANSWER: 1
- DOMAIN_ACTION: 0
- HUMAN_HANDOFF: 0
- KNOWLEDGE_GAP: 0
- AI_FAILURE: 0
- PROVIDER_FAILURE: 0

## CLARIFY emission (ACTUAL observed, not inferred)
- clarify expected: 1
- clarify emitted: 1
- clarify correct: 1
- clarify missed: 0
- clarify unnecessary: 0

## Failure causes
- none

## Notes
- The bridge itself is proven offline by `pnpm check:future-system`
  (stub-ai wiring: CLARIFY/resume/interruption/handoff/knowledge-gap).
- EVAL-03 legacy PASS/FAIL verdicts measure the FUTURE behavior against the
  CURRENT-architecture gold (`expectedCurrentAiOutcome`), where CLARIFY did
  not exist; a FUTURE CLARIFY/answer therefore scores FAIL on the legacy
  scorers. The AUTHORITATIVE CLARIFY signal is the clarify-emission
  measurement above (observed, not inferred), NOT the legacy verdict.
- `PROVIDER_FAILURE` is its own channel: a provider that returns
  schema-invalid completions (INVALID_RESPONSE) is reported here and never
  mislabelled as an AI/handoff-policy regression.

