# Focused Real-LLM CLARIFY Verification — Post Slice 4 (PROMPT-AI-EVAL-05)

> **Decision: BLOCKED.** Verification-only slice. No production source, prompt,
> provider, contract, dataset, or scoring code was modified. No commit, push,
> tag, or deploy. No model inference was performed and no production data was
> mutated.

- **Run ID:** `ad531b3c0adbd922`
- **Executed at:** `2026-10-01T13:18:06Z`
- **Execution mode:** `NOT_EXECUTED_BLOCKED`
- **Model calls:** `0` (the blocker is structural; running the harness would
  not have produced CLARIFY evidence — see §F)

---

## Blocker (why the specified verification cannot run through the existing path)

**Code: `HARNESS_DOES_NOT_EXERCISE_CODE_UNDER_TEST`.**

The existing real-LLM evaluation path does **not** invoke the Slice 4 CLARIFY
integration point, so it cannot reach, observe, or score first-class CLARIFY.

The real-LLM target chain is, verbatim from `real-llm-adapter.ts` `runTurn()`:

```
turn → AiRequest
     → bypassDeterministicAi(request)        (deterministic bypass)
     → llm.respond(request)                  (REAL provider/model call)
     → enforceDisclosure({response, context})(B-03 gate)
     → return RealTurnOutcome
```

First-class CLARIFY (Slice 4, `PROMPT-AI-ARCH-06`) lives downstream of this
chain, **only inside `conversation-engine.ts`**:

- `conversation-engine.ts:617` — `resolveTurnPlan({...})` (the Slice 3 resolver)
- `conversation-engine.ts:1612–1648` — the `decisionClass === "CLARIFY"` branch
  that emits ONE bounded question and stays `AI_ACTIVE`
- `conversation-engine.ts:1661–1709` — the booking-seam
  `needs_clarification` → `clarificationForBookingReason(...)` first-class
  CLARIFY branch

The real-LLM adapter imports **none** of `turn-planner.ts`,
`clarification.ts`, or `conversation-engine.ts`. It stops at the disclosure
gate. The engine (which owns the CLARIFY branch, state persistence, and the
`AI_ACTIVE` vs `NEED_HUMAN` decision) is never executed by the eval runner.

### Exact evidence

1. `evaluation/runner/real-llm-adapter.ts` imports only: `buildAiContext`,
   `enforceDisclosure`, `bypassDeterministicAi`, `createLlmConversationAi`,
   `adaptersFromEffectivePolicy`. No resolver, no clarification handler.
2. `evaluation/runner/real-llm-adapter.ts` `runTurn()` returns immediately
   after `enforceDisclosure(...)`; there is no `resolveTurnPlan` call on the
   path (confirmed by grep: the only `resolveTurnPlan`/`turn-planner` token in
   `evaluation/**` is a comment reference, and `clarification` appears only as
   `response.clarification` passthrough).
3. `evaluation/runner/targets/real-llm-flowpilot.ts:89` sets
   `clarification: response.clarification` — i.e. the **LLM-proposed**
   structured field. The Slice 4 slice changed **no prompt**, so the
   production prompts never emit `clarification`; this field is always absent
   in a real run. The resolver's CLARIFY output is not surfaced here at all.
4. `evaluation/runner/metrics.ts:182` is explicit:
   `// ── clarification (future axis: current arch cannot CLARIFY)`. The
   `clarificationAccuracy` metric keys off a case's PASS/LIMITATION verdict,
   **not** off whether a CLARIFY action was actually emitted.
5. `evaluation/runner/scorers/handoff-scorer.ts` scores a clarifiable turn by
   its gold `expectedHandoff`. A clarifiable turn that (in the eval path) still
   produces `action: handoff` is scored `HANDOFF_UNNECESSARY` /
   `UNNECESSARY_HUMAN_HANDOFF` — i.e. the harness measures the **pre-Slice-4**
   behavior, by construction.

### Why this is not fixable within the slice's constraints

Making CLARIFY reachable in the real-LLM eval would require either (a) routing
the eval target through `conversation-engine.ts`/`resolveTurnPlan`, or (b)
teaching the real-LLM adapter to call the resolver + clarification handler.
Both are changes to evaluation infrastructure (`real-llm-adapter.ts` /
`targets/real-llm-flowpilot.ts`) and the mission mandates using the **existing**
real-LLM target/runner unchanged and performing no implementation. This is
therefore reported as a blocker rather than worked around by modifying
infrastructure (per the STOP CONDITIONS and NO-IMPLEMENTATION rules).

---

## Harness validity (regression guard — smallest relevant checks only)

The Slice 4 code itself is correct in isolation **and** under the engine with
the deterministic driver; the gap is purely that the real-LLM eval target does
not route through the engine/resolver. Deterministic checks re-run (no src
changes were made):

| Check                 | Result | Covers                                                              |
| --------------------- | ------ | ------------------------------------------------------------------- |
| `pnpm check:clarify`      | 18/18  | CLARIFY emitted only when justified; never for human/sensitive/knowledge-gap/answerable; state preserved + resumed; interruption/return; zero extra model call; greeting/booking/handoff unchanged. **Includes engine-level cases** (`1e`,`2e`,`3e`). |
| `pnpm check:turn-planner` | 22/22  | Resolver precedence (7 rules), single-goal, domain authority, zero-call, incl. engine LLM/booking/human cases. |
| `pnpm check:eval-runner`  | 18/18  | Runner/scoring validity; no production import of eval code; no secrets; content bounded. |

These prove the resolver + clarification handler behave correctly when
exercised — but they are deterministic unit/engine harnesses, **not** the
real-LLM evaluation path, and so do not satisfy the mission's "real-LLM
reachability" requirement.

---

## Final report (A–W)

- **A. Run identity:** `ad531b3c0adbd922`, PROMPT-AI-EVAL-05, `2026-10-01T13:18:06Z`, mode `NOT_EXECUTED_BLOCKED`.
- **B. Provider/model identity:** Not resolved live. The real-LLM target
  resolves the effective policy from the live DB-backed `PlatformAiPolicy`
  (`getEffectiveAiPolicy()`); provider keys present by name in `.env.local`
  (`OPENROUTER_API_KEY`, `AGENTROUTER_API_KEY`, `ATRIA_API_KEY`,
  `CODECRAFT_API_KEY`). No inference was performed because the harness does not
  exercise the code under test, so a live provider identity would add no
  CLARIFY evidence.
- **C. Dataset identity:** `egyptian-v1`, hash `8be16297ae4717bab5da4f3c94de1887`
  (matches the TARGET_ARCHITECTURE evidence base), 1933 cases / 278 scenarios,
  unmutated.
- **D. Selected case IDs/scenarios:** 84 focused case IDs across 32 existing
  scenarios covering all 14 required boundary categories — recorded in
  `case-selection.json`. Selection was **proven present** in the dataset but
  **not executed** (blocker). Highlights: `am-bare-booking-clarifiable`,
  `jt-missing-service`, `jt-missing-date`, `st-service-discovery`,
  `am-vague-time-clarifiable`/`mt-any-time`, `ho-customer-requested-human`,
  `ho-sensitive-medical`/`ho-sensitive-emotional`,
  `ho-empty-knowledge-gap`/`ho-knowledge-gap-no-channel`/`kn-no-faq-empty-kb`,
  `jt-interrupted`/`mt-topic-return`, `jt-date-supplied`/`jt-service-supplied`,
  `re-long-context-topic-return`/`re-resume-next-day`,
  `lg-arabizi-service-name`/`adv-arabizi-service-name`,
  `st-very-short`/`lg-very-short-turn`/`st-ambiguous-oneword`,
  `ho-ambiguous-but-clarifiable-multi-turn`/`mt-ambiguous-yes`/`jt-revise-date`.
- **E. Real inference confirmation:** NOT CONFIRMED — no inference was run (0
  model calls). Blocker precedes execution.
- **F. CLARIFY reachability:** **NOT REACHABLE via the existing real-LLM eval
  path.** The target chain terminates at the disclosure gate, before the
  engine's `resolveTurnPlan`/CLARIFY branch. UNPROVEN for the real-LLM path.
  (Proven only for the deterministic/engine unit path via `check:clarify`.)
- **G. CLARIFY precision/recall:** Not measurable through this path (the
  harness scores clarifiable turns as handoffs; `clarificationAccuracy` is a
  verdict-derived "future axis", not a CLARIFY-emission measure). UNPROVEN.
- **H. Unnecessary-handoff findings:** Not re-measured; prior real-LLM baseline
  (unnecessary handoff ≈48.1% CodeCraft / ≈45.4% Atria) reflects the pre-CLARIFY
  path, which is still what this harness exercises. No new finding.
- **I. Missing-fact preservation:** UNPROVEN on real-LLM path (state lives in
  the engine, not exercised). Proven deterministically (`check:clarify` case 8).
- **J. Pending-task preservation:** UNPROVEN on real-LLM path. Proven
  deterministically (`check:clarify` cases 9–10).
- **K. Resume results:** UNPROVEN on real-LLM path. Proven deterministically
  (`check:clarify` case 8).
- **L. Interruption/recovery results:** UNPROVEN on real-LLM path. Proven
  deterministically (`check:clarify` cases 9–10, `INTERRUPTED`/`RECOVERING`).
- **M. Human-handoff preservation:** UNPROVEN on real-LLM path for the CLARIFY
  interaction specifically. Proven deterministically (`check:clarify` cases 5,
  6, 7b — human/sensitive/knowledge-gap stay HANDOFF, never CLARIFY).
- **N. Knowledge-gap separation:** UNPROVEN on real-LLM path. Proven
  deterministically (`check:clarify` case 7 — `NO_KNOWLEDGE` stays HANDOFF).
- **O. Safety results:** UNPROVEN on real-LLM path for CLARIFY precedence.
  Proven deterministically (`check:clarify` case 6; `check:turn-planner`
  precedence `SAFETY_RESTRICTED` above `CLARIFY_DECISION`).
- **P. Model-call counts:** 0 (not executed). Invariant unverified on the
  real-LLM path for CLARIFY turns specifically; deterministically the clarify
  branch adds zero calls (`check:clarify` case 13).
- **Q. Latency:** N/A (no inference).
- **R. Provider/runtime failures:** None observed (nothing executed). Provider
  availability not probed; keys present by name only.
- **S. Case-level failure clusters:** N/A — no cases executed. (Had the harness
  run, clarifiable cases would cluster into `HANDOFF_UNNECESSARY` by
  construction, which is a harness-coverage artifact, not product behavior.)
- **T. Scorer/dataset artifacts:** Dataset unmutated (hash matches). Scorer
  artifact identified: `clarificationAccuracy` is a verdict-derived proxy
  labelled "current arch cannot CLARIFY" and does not measure CLARIFY emission;
  the real-LLM target has no resolver-CLARIFY observable. These are
  evaluation-infrastructure gaps, not model regressions.
- **U. Exact evidence for every important failure:** See the Blocker section
  (five enumerated code citations) and `manifest.json → blocker.evidence`.
- **V. Decision:** **BLOCKED.** Not `READY_FOR_SLICE_5`.
- **W. Required next action:** Add an evaluation-only `FUTURE_SYSTEM` target
  (per TARGET_ARCHITECTURE §3.17 / §14 / Slice 10) that drives the real LLM
  **through** `resolveTurnPlan` + the clarification handler (or through the
  engine seam), surfacing the resolver-owned `turnPlan`/`clarification`/
  `decisionClass` into `ActualOutcome`, plus an additive CLARIFY-emission
  scorer (or extend the existing clarification metric to key off the emitted
  decision class). This is a separate, reviewable change — explicitly a
  **Slice 10 (evaluation targets)** item in the migration plan — and is a
  prerequisite before a real-LLM CLARIFY verdict (and thus before advancing to
  Slice 5 multi-intent with real-LLM evidence) is possible. The deterministic
  `check:clarify`/`check:turn-planner` suites remain the current proof of
  correctness in the interim.

---

## Result interpretation (kept separate, per mission)

1. **Real product behavior:** Not measured on the real-LLM path. The engine's
   CLARIFY branch exists and is correct under deterministic drive; whether a
   real LLM's `AMBIGUOUS`-reason handoff (or a future structured `clarification`
   proposal) reaches it in production is unverified by this slice.
2. **Runner/provider failure:** None — nothing ran. Not a provider outage.
3. **Scorer artifact:** The missing CLARIFY-emission observable + the
   "future axis" clarification metric are evaluation gaps, not model
   regressions.
4. **Dataset issue:** None — dataset present, unmutated, covers all 14
   categories.

No overall pass/fail score is asserted. **Proven:** the dataset supports the
focused subset; the Slice 4 code is correct in isolation and under the engine
with the deterministic driver; the eval harness is structurally valid.
**Unproven:** every real-LLM CLARIFY question (A–N above), because the existing
real-LLM evaluation target does not execute the Slice 4 integration point.
