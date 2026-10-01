# FUTURE_SYSTEM CLARIFY evaluation bridge (PROMPT-AI-EVAL-06)

Evaluation-only artifacts for the `future-system-flowpilot` target: the real
FlowPilot AI driven **through the real Conversation Engine** so a turn actually
traverses Slices 0–4 (ConversationState → `resolveTurnPlan()` → first-class
CLARIFY → clarification handler → `TurnObservability`).

## Why FUTURE_SYSTEM exists

The existing real-LLM target (`real-llm-flowpilot`) runs
`bypass → policy-backed LLM → disclosure gate` and **returns** — it never
reaches `turn-planner.ts`, `clarification.ts`, or `conversation-state.ts`, so it
cannot measure Slice 4 (first-class CLARIFY). This target closes that gap by
invoking the production entry point `receiveInboundMessage(...)`.

It is **additive**: the two CURRENT_SYSTEM targets (`current-flowpilot`,
`real-llm-flowpilot`), the dataset, the gold labels, and the EVAL-03 scoring
engine are all unchanged.

## Exact execution path

```
customer turn
  → receiveInboundMessage (REAL Conversation Engine)
  → ai-context-builder (B-02) AiRequest
  → deterministic bypass OR policy-backed LLM (REAL provider adapter)
  → parseAiResponse (AI response normalization)
  → deriveConversationStateFromHistory + mergeConversationState (Slice 2)
  → resolveTurnPlan() (Slice 3)
  → first-class CLARIFY / existing decision (Slice 4, clarification.ts)
  → clarification handler (engine-owned, stays AI_ACTIVE)
  → disclosure gate / booking seam / reply-handoff (unchanged)
  → buildTurnObservability (Slice 0)
  → ActualOutcome
```

## Production modules reused (NO second implementation)

`conversation-engine.ts`, `turn-planner.ts` (`resolveTurnPlan`),
`clarification.ts`, `conversation-state.ts`, `ai-observability.ts`,
`ai-context-builder/`, `ai-contract.ts` (`parseAiResponse`), the provider
factory (`adaptersFromEffectivePolicy` + `createLlmConversationAi`), CORE-01 /
CORE-02 booking, and the B-03 disclosure gate.

## What the bridge may observe

`decisionClass` / `turnPlan`, `clarification` (type + `missingFacts`), routing
decision, knowledge-source classes, handoff cause, state transition, provider /
model machine keys, retry / fallback counters, latency, and model-call counts.

## What the bridge is forbidden to mutate

NO appointment / booking / customer / provider / conversation / tenant / usage
persistence reaches a database. All engine repository dependencies are satisfied
by **isolated in-memory stubs** (`future-system-adapter.ts`); the only
"persistence" is an in-memory conversation that lets a multi-turn case resume
the clarification the engine itself authored. No channel delivery, no secrets,
no prompts, no chain-of-thought.

## Focused case IDs (recorded in the manifest / analysis)

`am-bare-booking-clarifiable::u0` (ambiguous booking),
`jt-missing-service::u0` (missing service),
`jt-missing-date::u0` (missing date),
`st-service-discovery::u0` (answerable-without-clarification),
`ho-customer-requested-human::u0` (explicit human),
`ho-sensitive-medical::u0` (sensitive/restricted),
`ho-empty-knowledge-gap::u0` (knowledge gap),
`ho-ambiguous-but-clarifiable-multi-turn::u0` (multi-turn clarification),
`am-context-resolves-service::u0` (clarification answer / resume),
`mt-topic-return::u0` (topic return),
`st-ambiguous-oneword::u0` (Egyptian colloquial ambiguity),
`lg-spelling-variation-service::u0` (Arabic spelling/noise),
`jt-interrupted::u0` (interruption after clarification),
`st-ambiguous-idk::u0` (clarifiable ambiguity).

## How to run

```
# offline structural validation of the bridge (stub ai — not scored)
pnpm check:future-system

# real-LLM calibration (one non-CLARIFY + one CLARIFY case)
pnpm eval:run-future -- --calibration --out evaluation/reports/egyptian-v1/future-system-clarify

# focused real-LLM CLARIFY run (the NEXT prompt owns this)
pnpm eval:run-future -- --out evaluation/reports/egyptian-v1/future-system-clarify
```

A `--provider/--model` override measures a specific provider without reading or
changing the DB-backed production policy.

## Calibration result (recorded in `status.md` / `analysis.json`)

The committed `status.md` / `analysis.json` were produced by a real-LLM
calibration (`--provider atria --model Atria-Dawn-Preview --timeout-ms 45000`):

- `am-bare-booking-clarifiable::u0` → real LLM → engine → **CLARIFY** (type
  `CLARIFY_SERVICE`, `missingFacts=[service]`), stayed `AI_ACTIVE`, 1 model call.
- `st-service-discovery::u0` → real LLM → **ANSWER**, `AI_ACTIVE`, 1 model call.
- Zero-or-one generative round-trip held (0 multi-call turns), 0 provider
  failures, engine reached on both, schema valid, scoring operating.

### Provider note (runtime, not a bridge defect)

The bridge is provider-neutral and was exercised with two providers through the
same seam:

- `atria/Atria-Dawn-Preview` returns schema-valid completions → CLARIFY proven.
- The DB-default `codecraft/deepseek-v4-flash-0731` returns `INVALID_RESPONSE`
  on chat completions in this environment (confirmed independently by
  `pnpm probe:codecraft`: model discovery OK, chat-completion FAIL). The bridge
  correctly reports that on the `PROVIDER_FAILURE` channel and never as an
  AI/handoff regression.

### Legacy-verdict caveat

EVAL-03 legacy PASS/FAIL verdicts measure the FUTURE behavior against the
CURRENT-architecture gold (`expectedCurrentAiOutcome`), where CLARIFY did not
exist, so a FUTURE CLARIFY/answer scores FAIL on the legacy scorers. The
authoritative CLARIFY signal is the additive clarify-emission measurement in
`analysis.json` (observed, not inferred).
