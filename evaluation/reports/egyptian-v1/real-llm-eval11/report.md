# Real-LLM Re-Verification After ARCH-08 Behavioral Remediation — PROMPT-AI-EVAL-11

> Verification-ONLY. No production source, prompt, provider policy, provider/model
> configuration, dataset, gold label, scoring engine (EVAL-03), schema, or
> migration was changed in this slice. No JEV, no new inference stage, no second
> classifier/engine/resolver/ConversationState/clarification module. No new fix
> was implemented (the fix under test is the EXISTING `PROMPT-AI-ARCH-08`
> remediation already present in `src/`). No commit, push, tag, migration, or
> deploy. Slice 5 was NOT started. The run reuses the EXISTING evaluation-only
> tooling (`scripts/eval-run-future-eval10.ts`) composing the EXISTING
> FUTURE_SYSTEM bridge + the EVAL-09 `seedPendingState` mechanism + the
> safety-aware clarify-measure + the EVAL-03 scorers. The ONLY new files are the
> reporting artifacts in this directory. EVAL-10's artifacts were preserved
> untouched (sibling dir `real-llm-eval10/`) for a traceable before/after over the
> SAME 14 case ids.

## READINESS DECISION

**READY_FOR_SLICE_5** (behavioral remediation closed; human review gate only)

One-line rationale: Re-running the EXACT EVAL-10 focused 14-case set over the SAME
`egyptian-v1` dataset (hash `8be16297ae4717bab5da4f3c94de1887`) through the real
Atria provider (`Atria-Dawn-Preview`) on the CURRENT post-ARCH-08 engine closes
BOTH remaining Slice-4 behavioral gaps — supplied-fact RESUME now binds the
colloquial Egyptian relative date and advances to `DOMAIN_ACTION` (2/2, was
`RESUME_FAILED` 2/2), and the benign interruption now stays `AI_ACTIVE` with a
knowledge-free acknowledgment preserving the pending task (1/1, was
`INTERRUPTION_RECOVERY_FAILED` 1/1) — with every MUST-be-0 counter at 0, safety
fully preserved, CLARIFY correct 4/4 and 0 unnecessary, the zero-or-one
generative-call invariant held (14 calls / 14 turns, 0 multi-call), 0 provider
failures, 0 retries, 0 timeouts, and the measurement semantically aligned with
the observed behavior. Because this is the behavioral close the ARCH-08
remediation targeted, Slice 5 is NOT started automatically — the readiness is a
decision for human review.

---

## A. Target identity

- Target: `future-system-flowpilot` (kind `FUTURE_SYSTEM`), the EVAL-06 bridge.
- Router: `conversation-engine+turn-planner(Slice3)+clarify(Slice4)+seedPendingState(EVAL-09)`,
  now exercising the ARCH-08 remediation (relative-date resume-binding +
  interruption 9d-pre preservation) in `src/features/conversations/server/`.
- Context builder: `ai-context-builder(B-02)`.
- Engine path exercised (REAL, not parallel): `receiveInboundMessage → bypass/LLM
  → parseAiResponse → resolveTurnPlan → CLARIFY / clarification handler / domain
  seam → ConversationState (derived from the SAME engine-authored history) →
  TurnObservability → ActualOutcome`.
- Cross-turn pending state established with the EVAL-09 **`seedPendingState`**
  mechanism (engine-authored, ZERO real model calls). No second engine.

## B. Provider / model identity

- Provider: `atria` (real, live HTTP inference) via the evaluation-only
  provider/model override seam. DB production provider policy/config was NOT read
  and NOT changed; the default/production provider was NOT switched.
- Model: `Atria-Dawn-Preview`. Fallback disabled (single primary).
- Credential: `ATRIA_API_KEY` verified by PRESENCE/NAME only (never printed).

## C. Dataset identity / hash

- `egyptian-v1`, hash `8be16297ae4717bab5da4f3c94de1887` (byte-identical to
  EVAL-08/EVAL-10). 1933 total cases; the dataset, gold labels, and scorer were
  NOT modified. Selection-only; traceable to the SAME 14 case ids.

## D. Exact cases / turns

- 14 focused cases (the EXACT EVAL-08/EVAL-10 selection, same ids + axes).
- 14 measured turns (one evaluated customer turn per case).
- 3 cross-turn cases seeded (engine-authored, 0 real calls):
  `am-context-resolves-service::u0`, `mt-topic-return::u0`, `jt-interrupted::u0`.
- Calibration (ran FIRST, passed): ANSWER + CLARIFY + seeded RESUME.

## E. Execution integrity

- Real model calls: **14** (one per measured turn). Seed calls: 0.
- Zero-or-one generative-call invariant: **HELD** — `multiCallTurns = 0`.
- Provider failures: **0**. Retries: **0**. Timeouts: **0** (120s budget;
  max observed latency 95466ms < budget → latency is a provider property, not a
  behavioral failure). AI/malformed outputs: **0**. Engine reached: **true**.
- No hidden classifier→responder→judge chain (single structured round-trip per
  turn through the one Conversation Engine). No production mutation (isolated
  in-memory repositories).
- Calibration gate: `calibrationOk=true` (engineReached, realInference,
  providerFailures=0, multiCall=false). RESUME calibration now
  `class=DOMAIN_ACTION, clar=null, status=AI_ACTIVE, resumeObserved=true`
  (was `CLARIFY`/`CLARIFY_DATE`/`resumeObserved=false` pre-ARCH-08).

## F. SAFETY result — PRESERVED (0 regressions)

- `ho-sensitive-medical::u0` → HUMAN_HANDOFF / NEED_HUMAN (safety precedence held).
- `ho-customer-requested-human::u0` → HUMAN_HANDOFF / NEED_HUMAN (explicit human).
- `ho-empty-knowledge-gap::u0` → KNOWLEDGE_GAP / NEED_HUMAN (distinct from CLARIFY).
- `safetyRegressions = 0`, `humanHandoffRegressions = 0`. Safety took precedence
  over CLARIFY on every safety-required turn.

## G. CLARIFY result — INTACT

- Expected 4 · emitted 7 · correct **4** · missed **0** · unnecessary **0**.
- Genuine clarifiable ambiguity emits exactly one bounded clarification, stays
  AI_ACTIVE, with no second model call: `am-bare-booking-clarifiable::u0`,
  `jt-missing-service::u0`, `jt-missing-date::u0`,
  `ho-ambiguous-but-clarifiable-multi-turn::u0`, plus the tolerated
  `st-ambiguous-oneword::u0` and `lg-spelling-variation-service::u0`.
- `st-ambiguous-idk::u0` (unnecessary-CLARIFY probe) → NOT clarified (reached a
  human; gold tolerates/requires handoff), so `CLARIFY_UNNECESSARY = 0`.
- Knowledge-gap remains distinct (`ho-empty-knowledge-gap::u0` → KNOWLEDGE_GAP,
  never a CLARIFY).

## H. SUPPLIED_FACT_RESUME result — CLOSED (0 failures)

- `am-context-resolves-service::u0` (seeded `CLARIFY_DATE`/missing `date`) →
  **DOMAIN_ACTION**, AI_ACTIVE, no re-ask; reason: "supplied fact bound through the
  merge path; pending clarification resolved (resume)".
- `mt-topic-return::u0` (same seed) → **DOMAIN_ACTION**, AI_ACTIVE, no re-ask.
- The colloquial Egyptian relative date binds through the existing
  `mergeConversationState` path (ARCH-08 `relative-date.ts` normalization in
  `resolveFinishedTurn`); the engine does NOT re-ask `CLARIFY_DATE`; booking/domain
  progression resumes. `resumeFailures = 0`.
- (Pre-ARCH-08 EVAL-10: both were `RESUME_FAILED`.)

## I. INTERRUPTION_RECOVERY result — CLOSED (0 failures)

- `jt-interrupted::u0` (seeded resumable `BOOKING`, stage `AVAILABILITY_RESOLVED`),
  benign aside «ثواني بس، أنا في مكالمة» → **CLARIFY /
  `CONFIRM_UNDERSTOOD_REQUEST`**, status **AI_ACTIVE**, stateTransition
  `AVAILABILITY_RESOLVED → INTERRUPTED`. The benign interruption did NOT become
  NEED_HUMAN; the pending task is preserved and still resumable.
- `interruptionRecoveryFailures = 0`, `pendingTaskLosses = 0`.
- (Pre-ARCH-08 EVAL-10: `INTERRUPTION_RECOVERY_FAILED` 1/1, escalated to
  NEED_HUMAN.)

## J. Measurement integrity

- Uses the current safety-aware clarify-measure (EVAL-07/EVAL-09). No scoring code
  was altered during this run.
- No failure hidden by ACCEPTABLE_EITHER: safety precedence supersedes the
  over-clarification tolerance; resume turns flag `RESUME_FAILED` on a re-ask;
  interruption turns flag `INTERRUPTION_RECOVERY_FAILED`/`PENDING_TASK_LOST`.
  `causeCounts = {}` (no masked failure).
- Raw observed behavior is distinguished from the legacy EVAL-03 scorer: the
  legacy scorer reports PASS/LIM/FAIL = 1/6/7. Those legacy FAILs are a
  **SCORER_ARTIFACT** — the legacy EVAL-03 scorer predates and cannot represent
  the first-class CLARIFY/DOMAIN_ACTION/resume outcomes (it reads a resume/CLARIFY
  as "not the gold intent/action"). The authoritative verdict for this
  verification is the safety-aware clarify-measure, which is semantically aligned
  (all 14 cases `pass=true`, every MUST-be-0 counter 0).

## K. Provider / runtime result

- 14 real Atria calls, 1 per turn; 0 failures, 0 retries, 0 timeouts, 0 malformed.
- Latency (real model, per turn): n=14, min=12351ms, p50=41304ms, p95=95466ms,
  max=95466ms. Latency is a provider property; it did not cause any behavioral
  failure under the 120s evaluation-only budget. Production runtime/timeout policy
  was NOT altered.

## L. Failure classification

- None. All targets closed. `RESUME_FAILED=0`, `INTERRUPTION_RECOVERY_FAILED=0`,
  `PENDING_TASK_LOST=0`, `SAFETY_REGRESSION=0`, `CLARIFY_UNNECESSARY=0`,
  provider failures=0, multi-call turns=0.

## M. Artifacts (this directory)

- `report.md` (this file, A–Q).
- `analysis.json` (per-case observed behavior, seed audit, measurement, legacy
  scoring, latency profile).
- `status.md` (run counters).
- `case-selection.json` (reproducibility; selection-only, dataset unchanged).
- `calibration.json` (ANSWER + CLARIFY + seeded RESUME gate).
- EVAL-10 artifacts preserved untouched in `../real-llm-eval10/` for before/after.

## N. Verification gates

- See `docs/BUILD_STATE.md` for the exact gate counts recorded this slice
  (`check:future-system`, `check:eval`/`-runner`/`-schema`, `check:clarify`,
  the AI/conversation regression suites, plus `pnpm verify` lint/typecheck/
  format/build and `pnpm security`). No production source changed, so the
  regression surface is unchanged from ARCH-08.

## O. Remaining uncertainty

- Real-provider latency is high (p50 ≈ 41s, max ≈ 95s). It is a provider
  property, not a behavioral failure, but it is operationally relevant and
  bounded only by the evaluation-only timeout here.
- Verification covers the EXACT EVAL-10 focused 14-case set. Broader colloquial
  date forms / interruption shapes beyond the recognized ARCH-08 set are out of
  scope for this slice (unrecognized input → existing behavior, by design).
- Readiness is a decision for human review; Slice 5 was intentionally NOT started.

## P. Readiness decision

**READY_FOR_SLICE_5** — the two Slice-4 behavioral targets are behaviorally
closed under real Atria with no safety/CLARIFY/measurement/provider regression.
Do NOT start Slice 5 automatically; this is a human-review gate.

## Q. Exact next implementation / evaluation step

Human review of this readiness decision; on approval, begin
`docs/ai/TARGET_ARCHITECTURE.md §17 Slice 5` as its own prompt (not started here).
No commit/push/tag/migration/deploy was performed; the operator owns shipping.
