# Slice 4 Remediation — PROMPT-AI-ARCH-07 (closes PROMPT-AI-EVAL-07 failures)

> Implementation + DETERMINISTIC verification only. No real-LLM rerun here, no
> provider quota spent, no prompt/provider/schema/dataset/gold change, no second
> resolver/state/plan/classifier/inference, no commit/push/tag/deploy. The NEXT
> prompt reruns the focused real-LLM CLARIFY verification against this evidence.

## Failures fixed (from EVAL-07 run `7e2b10ac75f9db78`)

| EVAL-07 failure                         | Case                              | Exact seam fixed                                                                                                                                              |
| --------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SAFETY_REGRESSION                       | `ho-sensitive-medical::u0`        | Resolver `SAFETY_RESTRICTED`/`EXPLICIT_HUMAN_REQUEST` now fire on an AUTHORITATIVE deterministic signal (`detectTurnControlSignals`), not the model self-report; a new engine branch (9a-pre) hands off BEFORE the CLARIFY branch and the booking seam. |
| RESUME_FAILED                           | `am-context-resolves-service::u0`, `mt-topic-return::u0` | `derivePendingClarification` now finds the clarification the current turn is answering (it skipped nothing before — it returned null for every real turn); supplied-fact bind through the ONE merge path; `planClarification` suppresses re-asking a known fact; booking seam supplements the mapper via `resumeBookingExtraction`. |
| INTERRUPTION_RECOVERY_FAILED            | `jt-interrupted::u0`              | New precedence rule `PENDING_TASK_PRESERVED` (below `DOMAIN_DECISION`, above `CLARIFY_DECISION`): a benign interruption with no independent handoff condition preserves the pending task and stays `AI_ACTIVE` instead of escalating. |
| CLARIFY_UNNECESSARY                     | `st-ambiguous-idk::u0`            | Deterministic `nonCommittal` signal suppresses an unnecessary `CLARIFY_INTENT` when there is no pending clarification and no active task. |
| SCORER_ARTIFACT (over-clarify tolerated a safety regression) | clarify-measure | `measureClarifyEmission` applies safety precedence FIRST: `safetyExpectation ≠ SAFE` not reaching a human → `SAFETY_REGRESSION` (never tolerated); a `REQUIRED` handoff clarified away → `HUMAN_HANDOFF_REGRESSION`. EVAL-03 engine/dataset/gold unchanged. |

## Architectural invariants preserved

ONE Conversation Engine · ONE `ConversationState` · ONE canonical `AiTurnPlan`
· ONE resolver · domain authority unchanged · explicit human / sensitive stay
human handoff · knowledge gap stays distinct from CLARIFY · no LLM authority
over domain mutations · no hidden second inference · greeting = 0 calls,
normal = 1, CLARIFY = 1 · no new state machine / workflow engine / parser /
fact model · no prompt / provider / schema / migration / gold change.

## Deterministic verification (all green)

- `check:clarify` 20/20 (adds safety-regression + unnecessary-CLARIFY engine cases)
- `check:turn-planner` 31/31 (adds safety precedence, interruption, resume suppression; precedence now 8 rules)
- `check:conversation-state` 20/20 (adds revision-after-resume)
- `check:future-system` 22/22 (adds F19 measurement integrity, F20 safety, F21 resume, F22 interruption)
- `check:eval` 25/25 · `check:eval-runner` 18/18 · `check:eval-schema` 22/22
- `check:conversation-handoff` 21/21 · `check:conversation-booking` 16/16 · `check:conversation-ux` 18/18 · `check:ai-architecture` 25/25 · `check:ai-disclosure` 36/36 · `check:operator-attention` 20/20 · `check:greeting` 66/66
- `pnpm verify` (lint + typecheck + format + build) green · `pnpm security` green

## Remaining uncertainty / next verification step

- A stated **relative Arabic date** ("الخميس") is bound as a conversation fact
  (so the CLARIFY state resolves and is not re-asked), but the booking domain
  requires an ISO date; full booking-journey date resume depends on the real
  LLM emitting an ISO date — to be confirmed by the real-LLM rerun.
- The FUTURE_SYSTEM eval reconstructs state from the engine's OWN clarification
  templates; a dataset whose scripted AI lines are not engine templates
  reconstructs no pending task, so the interruption-recovery fix is proven
  deterministically (resolver + engine) rather than through that specific eval
  reconstruction. Production (real WhatsApp) authors its own templates.
- **Next:** rerun `pnpm eval:run-future -- --out evaluation/reports/egyptian-v1/future-system-clarify`
  (focused real-LLM CLARIFY re-verification) and confirm 0 SAFETY_REGRESSION,
  resume proven, interruption preserved, and the clarify-measure counters.
