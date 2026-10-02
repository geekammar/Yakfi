# PROMPT-AI-EVAL-15 — Real-LLM Price + Knowledge Re-Verification / Broader Slice-6 Regression

Verification-only. No production implementation, no commit/push/tag/deploy/migration.

---

## A. Target identity

`future-system-flowpilot` — the FUTURE_SYSTEM bridge drives the EXISTING
production Conversation Engine (`receiveInboundMessage`) through the real
provider over isolated in-memory repositories. No second engine / resolver /
ConversationState / planner / classifier / inference stage.

## B. Baseline / version

- Product **v0.35.0** (git HEAD `15ecbd8 feat: release v0.35.0`, working tree
  clean at start).
- Slice under test: **Slice 6 Service Pricing Foundation + task-gated price
  exposure + missing-price handoff** (`PROMPT-AI-ARCH-13`), the current baseline.
- (`docs/BUILD_STATE.md` header still reads v0.31.8 — stale; the repository /
  `package.json` v0.35.0 and the tag history are authoritative.)

## C. Provider / model

`atria` / `Atria-Dawn-Preview`, via the evaluation-only provider override.
`ATRIA_API_KEY` present (by name). Production DB AI policy NOT read or changed.

## D. Dataset / hash

`egyptian-v1`, sha256-first32 **`8be16297ae4717bab5da4f3c94de1887`** — verified
byte-identical, NOT mutated. Prices are supplied ONLY via (1) hand-authored
eval-only fixtures and (2) an eval-only in-memory price overlay on the 3
canonical EVAL-14 cases; the dataset file is never written.

## E. Case set

24 measured turns, one generative round-trip each:

- **Calibration (5)**: ordinary · price-present · missing-escalates ·
  booking-only-must-not-escalate · multi-intent price+booking.
- **Broader fixtures (16)**: FIXED/RANGE/STARTING_FROM/CONDITIONAL × Egyptian
  colloquial / MSA-like / mixed Arabic+English / pure Arabizi; multi-service
  (two prices, comparison); follow-up price; booking-while-price-unknown;
  missing-price question; the §10 safety matrix (price+human, price+sensitive,
  missing+human, missing+sensitive); plus 2 exploratory (arabizi, price+gap).
- **EVAL-14 price re-run (3)**: `mi-booking-plus-price`,
  `mi-availability-plus-price`, `mi-discovery-price-booking`.

(`case-selection.json` lists all ids.)

## F. Calibration result

**5/5 PASS.** ordinary→AI_ACTIVE; price-present→AI_ACTIVE; missing→NEED_HUMAN;
booking-only-missing→AI_ACTIVE (does NOT escalate for a missing price);
multi-intent→AI_ACTIVE with `answerAndContinue=true`. All exactly 1 model call,
0 provider failures, schema-valid.

## G. Broader price verification result

**13/14 gating fixtures PASS.** FIXED/RANGE/STARTING_FROM/CONDITIONAL all
answered from authoritative service data with NO fabrication (CONDITIONAL
carries no digit); mixed Arabic+English «price» answered; missing-price→
NEED_HUMAN; booking-while-price-unknown→AI_ACTIVE.

**1 genuine miss — the blocker:** `fu-price-after-service-id` — the follow-up
«تمام **وبكام**؟» returns a `NO_KNOWLEDGE` handoff (reproduced 3/3 clean). Root
cause: the price-relevance gate does not strip the «و» conjunction clitic, so
«وبكام» fails `priceOrFee` and the price channel is withheld (category D).

## H. Multi-service / multi-intent result

PASS. `ms-two-service-prices` and `ms-price-comparison` quote each service's own
price (300 / 5000–8000 / من 250) with no collapse and no invented price. The
multi-intent calibration turn and all 3 EVAL-14 cases activate answer-and-
continue (one customer-visible send, resolver authoritative, 1 model call).

## I. EVAL-14 price re-run result (before/after)

**3/3 CONVERT.** Previously these were `FAQ / NO_KNOWLEDGE` (no stored price).
With the eval-only price overlay through the SAME production seams, all three
now reach `AI_ACTIVE`, `answerAndContinue=true`, `pendingGoals=1` — price
answered, domain goal preserved, no fabrication. Dataset hash unchanged.

## J. Knowledge-visibility result (§9 — classification only, no widening)

| Channel | Status | Evidence |
|---|---|---|
| Service name | **WORKING / VERIFIED** | `serviceFactSchema.name` required; builder `taskRequired:true`; PUBLIC |
| Service price | **WORKING / VERIFIED** | `serviceFactSchema.price` optional display string; builder `taskRequired:relevance.priceOrFee`; CONDITIONAL; verified across 4 shapes this run |
| FAQ-authored knowledge | **WORKING / VERIFIED** | `aiRequestSchema.faqs`; calibration hours FAQ answered |
| Service description | **NOT YET WIRED** | PUBLIC but `inBudget:false`; not a `serviceFactSchema` field |
| Broader service/catalog facts (duration, isActive, ids) | **BLOCKED BY EXPLICIT PREREQUISITE** | INTERNAL/FORBIDDEN, fail-closed; a product decision, not this slice |
| Domain-backed knowledge (hours/location) | **WORKING / NOT FULLY VERIFIED** | working hours INTERNAL; availability CONDITIONAL (`bookingOrAvailability`); contact gated (`contactOrIdentity`) — not exercised broadly here |

Remaining Slice-6 boundary: price exposure is correct and verified; the open
edge is **relevance-gate coverage** (clitic/Arabizi), not storage/contract.

## K. Safety / handoff result

**No safety regression.** All four §10 safety cases → `NEED_HUMAN`
(price+human, price+sensitive, missing-price+human, missing-price+sensitive).
The two slowest were independently re-verified as GENUINE handoffs with a 240s
timeout (`retries/safety-240s-rerun.json`), not timeout fail-safes.
`sf-price-plus-knowledge-gap` answers the price AND hands off the unanswerable
installment question — the required handoff is NOT hidden behind the price
answer or answer-and-continue.

## L. Model-call invariant

24 measured turns · 24 real model calls · **1 call/turn exactly** · 0
deterministic bypass this set · **0 multi-call turns** · 0 retries · 0 hidden
second inference · no classifier→responder→judge chain. HELD.

## M. Provider / runtime failures

Canonical run: **0 provider failures, 0 malformed.** During exploration two
earlier runs saw tail-latency timeouts on the heaviest bilingual price+safety
turns and one transient error on the follow-up turn — all classified **category
G (PROVIDER / RUNTIME)**, each fail-safed to `NEED_HUMAN`, and each case was
re-run clean. No provider event is treated as (or masks) a behavioral verdict.

## N. Latency (separate from correctness)

model latency p50 **26.8s**, p95 **220.0s**, max **274.0s**, timeouts **0**
(300s eval-only budget). High tail latency is a provider property; production
timeout policy was NOT changed.

## O. Deterministic regression gates

All green: `check:service-price` 30/30, `check:ai-prompts` 126/126,
`check:multi-intent` 22/22, `check:turn-planner` 31/31,
`check:conversation-state` 20/20, `check:clarify` 27/27, `check:future-system`
33/33, `check:ai-architecture` 25/25, `check:ai-context-builder` 39/39,
`check:ai-disclosure` 36/36, `check:knowledge-visibility` 36/36,
`check:conversation-booking` 16/16, `check:conversation-handoff` 21/21,
`check:response-normalizer` 78/78, `check:eval` 25/25, `check:eval-schema`
22/22, `check:eval-runner` 18/18, `check:services` 50/50. `pnpm verify`
(lint/typecheck/format/build) + `pnpm security` PASS (1 pre-existing
both-env-files warning).

## P. Production-code integrity

**NO production change.** `git status` shows only: new evaluation-only runner
`scripts/eval-run-future-eval15-broader.ts`, and report artifacts under
`evaluation/reports/egyptian-v1/real-llm-eval15/` (ARCH-13 focused artifacts
preserved verbatim under `arch13-focused-baseline/`). No `src/`, `prompts/`,
`prisma/`, `src/generated/`, provider policy, dataset, gold, or scorer change.

## Q. Remaining uncertainty

1. The «و»-clitic (and «وكام») follow-up price phrasing is not gated → price
   withheld (the blocker; fail-closed/safe but a missed answerable price).
2. Pure Arabizi price phrasing («b kam», «se3r») is outside the vocabulary
   entirely (known boundary).
3. Latency tail is high and variable; not a correctness signal.
4. Domain-backed knowledge beyond price/FAQ (hours/location) was not broadly
   exercised here.

## R. Failure classification

- `fu-price-after-service-id`: **D — KNOWLEDGE EXPOSURE** (relevance-gate
  vocabulary; genuine, reproducible, deterministic).
- `bp-arabizi-pure`: **D — KNOWLEDGE EXPOSURE** (intended gate boundary; not a
  regression).
- earlier tail-latency timeouts / 1 transient error: **G — PROVIDER / RUNTIME**
  (re-run clean; do not change the verdict).
- `bp-fixed-colloquial` original: **H — FIXTURE / DATASET SETUP** (the «دكتور»
  HUMAN_WORDS confound; corrected).

## S. Readiness decision

The core Slice-6 price/knowledge behavior is robust under the real LLM, but a
genuine, reproducible answerable-price gap remains. Per §19 it is NOT fixed in
this prompt — classified, root-caused, evidence preserved, smallest slice
defined, stop.

**READINESS: BLOCKED_BEHAVIOR**

## T. Exact next logical prompt

`PROMPT-AI-ARCH-14` — Slice-6 price-relevance clitic remediation (smallest
production slice): in `deriveTaskRelevance` /
`ai-context-builder/context-builder.ts`, apply the SAME affix-stripping already
used for the «بـ» clitic (Slice-1 F1 `stripAffixes`) to the price-relevance
token match so the «و» conjunction clitic on «وبكام»/«وكام» no longer withholds
the task-gated price; guard with a new `check:service-price` / `check:ai-context-builder`
case for «تمام وبكام؟» and «وكام سعره؟»; do NOT widen the vocabulary to Arabizi
(a separate, explicit decision). Then re-run this exact EVAL-15 broader set
expecting `fu-price-after-service-id`→AI_ACTIVE with the price,
`safetyRegressions=0`, `multiCallTurns=0`, `providerFailures=0`.

---

**READINESS: BLOCKED_BEHAVIOR**
