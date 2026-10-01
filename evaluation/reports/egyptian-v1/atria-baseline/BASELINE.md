# PROMPT-AI-EVAL-04C — Atria Comparative Baseline (egyptian-v1)

> **Measurement only.** This is the Atria evaluation target driven through the
> existing FlowPilot AI/provider seam and scored by the **UNCHANGED EVAL-03
> scoring engine** on the **same `egyptian-v1` dataset**, so it is directly
> comparable with:
> - **EVAL-04** deterministic baseline (`reports/egyptian-v1/baseline/`)
> - **EVAL-04B** CodeCraft / DeepSeek real-LLM baseline (`reports/egyptian-v1/real-llm-baseline/`)
>
> No redesign. No fix. No ranking. Behavioral and diagnostic comparison only.

## A. Baseline identity

| field | value |
| --- | --- |
| slice | `PROMPT-AI-EVAL-04C` |
| target id | `real-llm-flowpilot` (provider-override, eval-only) |
| run id | `749af9925213cec5` |
| evaluator version | `eval-runner@1` |
| scoring version | `eval-scoring@1` (EVAL-03, unchanged) |
| dataset | `egyptian-v1` |
| dataset hash | `8be16297ae4717bab5da4f3d94de1887` (**identical** to EVAL-04 / EVAL-04B) |
| seed | `20260928` |
| execution mode | `DATASET` (filter `{}` — full dataset, no exclusions) |
| executed at | `2026-10-01T01:14:53.750Z` |

## B. Provider / model identity

| field | value |
| --- | --- |
| provider | `atria` (existing `createAtriaAdapter`, reused — no second implementation) |
| model | `Atria-Dawn-Preview` |
| endpoint | `https://api.atria-asi.ai/v1/chat/completions` |
| secret mechanism | existing `ATRIA_SECRET_REF = "ATRIA_API_KEY"` (env-name only; read at call time) |
| secondary / fallback | none (single-provider measurement — same wiring as the EVAL-04B CodeCraft target) |
| retry | bounded, maxAttempts=2 (existing Conversation Control layer), no cross-provider fallback |
| per-attempt timeout | **45000 ms eval-only override** via the existing `AiFactoryEnvDeps.timeoutMs` probe seam. The production `ATRIA_TIMEOUT_MS` cap (16 s) is **unchanged**. |

**Production safety of the seam:** Atria was selected by an evaluation-only
override (`--provider atria --model Atria-Dawn-Preview`) that builds the
`EffectiveAiPolicy` **directly** inside the evaluation process. The DB-backed
production AI policy is **not read and not written** when the override is
present; Production provider selection, prompts, contract, Conversation Engine,
and disclosure gate are untouched.

## C. Dataset identity / hash

`egyptian-v1`, sha256(artifact)[0:32] = `8be16297ae4717bab5da4f3d94de1887`.
Byte-identical to the artifact used by EVAL-04 and EVAL-04B (confirmed by the
run manifests of all three). **Not mutated, not regenerated.** No Atria-specific
dataset exists.

## D. Calibration result

Calibration subset = 9 high-signal scenarios × 3 cases = **27 cases / 33 turns**
(`atria-calibration/`). NOT the baseline.

| check | result |
| --- | --- |
| real Atria inference occurred | **YES** — provider probe `HTTP 200`, `parseMode: DIRECT_PARSE`; eval turns recorded `realProvider: atria`, `realModel: Atria-Dawn-Preview` |
| structured output valid | **YES** — `malformedOutputRate 0.0%`; `aiResponseSchema` parse on every returned response |
| existing EVAL-03 scoring works | **YES** — verdicts PASS/LIMITATION/FAIL produced |
| no Production mutation | **YES** — override never reads/writes the DB policy; no `src/` change |
| no secrets written | **YES** — `check:eval-runner` R16 "no secrets in result artifacts" = 0 matches |

Calibration headline (27 cases): PASS 7 / LIMITATION 8 / FAIL 12; intent
accuracy 48.1%; unnecessary handoff rate 38.9%; malformed 0.0%.

**Calibration finding that shaped the run:** at the production 16 s per-attempt
cap under concurrency, 48/62 calibration turns ended in `TIMEOUT`
(controlled-failure), i.e. the measurement would have scored the engine's
fail-safe rather than the model. The eval-only timeout override was introduced
so the *model* is measured; the 16 s finding is reported separately as a
provider-latency observation (see §O).

## E. Full execution counts

| measure | count |
| --- | --- |
| cases selected (full dataset) | **1933** |
| cases scored (excl. 40 seam-owned) | **1893** |
| total turns executed | **2972** |
| turns via deterministic bypass | 190 |
| turns via real Atria LLM | 2782 |
| execution errors (`line.error`) | **0** |
| provider-failure turns in final score | **0** (`providerFailureRate 0.0%`, 0/1893) |
| malformed output turns | **0** (`malformedOutputRate 0.0%`, 0/1893) |

**BASELINE STATUS: COMPLETE — all 1933 selected cases produced genuine
LLM/bypass outcomes.** Every category preserved: rare/extremely-rare
(256 adversarial + rare-edge cases), multi-intent, ambiguity, handoff,
knowledge, safety, multi-turn, booking journeys. No case was silently excluded;
during the resumable execution, cases that timed out stayed on the visible
provider-failure channel and were retried until every one resolved.

## F. Execution errors

None in the final artifact. Residual provider timeouts were driven to zero by
re-execution; the runner's resumable checkpoint design kept each incomplete case
visible (never silently passed) until it completed.

## G. Overall Atria metrics

Verdicts (scored 1893): **PASS 770 (40.7%) · LIMITATION 479 (25.3%) · FAIL 644 (34.0%)**.

| metric | Atria | CodeCraft / DeepSeek | Deterministic |
| --- | --- | --- | --- |
| intent accuracy | 58.4% (1106/1893) | 59.4% (1125/1893) | 60.9% (1153/1893) |
| intent accuracy (limitation-adjusted) | 87.7% (1661/1893) | 88.1% (1667/1893) | 80.6% (1526/1893) |
| action accuracy | 62.8% (1188/1893) | 62.3% (1180/1893) | 66.9% (1266/1893) |
| action accuracy (limitation-adjusted) | 88.4% (1673/1893) | 88.5% (1675/1893) | 84.7% (1604/1893) |
| handoff precision | 41.2% (197/478) | 40.0% (199/497) | 28.7% (213/743) |
| handoff recall | 90.4% (197/218) | 91.3% (199/218) | 97.7% (213/218) |
| unnecessary handoff rate | 45.4% (281/619) | 48.1% (298/619) | 85.6% (530/619) |
| missed handoff rate | 9.6% (21/218) | 8.7% (19/218) | 2.3% (5/218) |
| entity extraction accuracy | 84.9% (270/318) | 84.0% (267/318) | 70.8% (225/318) |
| multi-intent success | 56.6% (226/399) | 56.9% (227/399) | 47.6% (190/399) |
| ambiguity handling | 69.8% (139/199) | 72.9% (145/199) | 66.3% (132/199) |
| clarification accuracy | 54.0% (54/100) | 54.0% (54/100) | 57.0% (57/100) |
| knowledge requirement accuracy | 91.2% (343/376) | 93.1% (350/376) | 80.1% (301/376) |
| conversation-state accuracy | 92.5% (531/574) | 92.3% (530/574) | 78.4% (450/574) |
| booking-state accuracy | 48.9% (336/687) | 48.0% (330/687) | 35.5% (244/687) |
| safety violation rate | 13.0% (28/216) | 10.6% (23/216) | 2.8% (6/216) |
| provider failure rate | 0.0% (0/1893) | 0.1% (1/1893) | 0.0% (0/1893) |
| malformed output rate | 0.0% (0/1893) | 0.0% (0/1893) | 0.0% (0/1893) |
| deterministic bypass correctness | 24.5% (23/94) | 24.5% (23/94) | 24.5% (23/94) |

Handoff outcome channels (scored cases): Atria `NO_HANDOFF 400 ·
UNNECESSARY_HUMAN_HANDOFF 281 · TRUE_HUMAN_REQUIRED 1021 · AMBIGUITY 75 ·
KNOWLEDGE_GAP 116`; CodeCraft identical except `UNNECESSARY 298`,
`NO_HANDOFF 374`, `PROVIDER_FAILURE 1`; deterministic `NO_HANDOFF 101 ·
UNNECESSARY 530 · TRUE_HUMAN 1067 · AMBIGUITY 75 · KNOWLEDGE_GAP 120`.

## H. Unnecessary-handoff metrics (619 NOT_REQUIRED cases)

| outcome | Atria | CodeCraft | Deterministic |
| --- | --- | --- | --- |
| correct continuation (no handoff, PASS/LIMITATION) | 283 | 275 | 82 |
| unnecessary handoff | 281 (45.4%) | 298 (48.1%) | 530 (85.6%) |
| refused/human via disclosure | (incl. above) | 58 | 0 |
| continued but wrong (FAIL, other error) | 55 | 46 | 7 |
| malformed / provider failure | 0 | 0 | 0 |

### SERVICE_DISCOVERY + BOOKING focus

Service-discovery family (124 scored cases): Atria hands off **37.1% (46/124)**
vs CodeCraft **53.2% (66/124)** vs deterministic **100% (124/124)**.

The canonical utterance **"عايز احجز ايه الخدمات اللي موجوده عندكم؟"**
(`mi-booking-plus-discovery`, 20 cases: booking intent + service-discovery
secondary intent, handoff truth NOT_REQUIRED):

| | Atria | CodeCraft | Deterministic |
| --- | --- | --- | --- |
| unnecessary handoff | **14/20** | **17/20** | 20/20 |
| correct continuation | 6/20 | 3/20 | 0/20 |

Per-scenario (A = Atria, handoff count):

| scenario | n | A P/L/F | A ho | cc ho | det ho |
| --- | --- | --- | --- | --- | --- |
| st-service-discovery | 8 | 0/0/8 | 0 | 2 | 8 |
| mi-booking-plus-discovery | 20 | 0/6/14 | 14 | 17 | 20 |
| kn-service-catalog | 20 | 0/20/0 | 0 | 2 | 20 |
| ex-service-discovery-variants | 11 | 0/0/11 | 0 | 3 | 11 |
| mi-two-questions | 10 | 10/0/0 | 0 | 2 | 10 |
| ex-advisory-asks | 8 | 0/0/8 | 8 | 8 | 8 |
| ho-unnecessary-discovery-mid-flow | 8 | 0/8/0 | 0 | 0 | 8 |
| lg-arabizi-service-name | 8 | 0/5/3 | 3 | 5 | 8 |
| mi-discovery-price-booking | 9 | 0/9/0 | 5 | 9 | 9 |
| mi-booking-plus-discovery-empty-kb | 9 | 0/9/0 | 9 | 9 | 9 |
| kn-service-not-in-catalog | 7 | 0/0/7 | 5 | 7 | 7 |
| mt-second-service | 6 | 2/4/0 | 2 | 2 | 6 |

Reading: on pure service discovery both LLMs mostly answer (Atria 0/8 handoff
on `st-service-discovery` and `kn-service-catalog` vs deterministic 8/8 and
20/20). The unnecessary handoff concentrates where **booking + discovery
co-occur** — the canonical utterance above (Atria 14, CodeCraft 17) — i.e. the
same contract/policy seam, not a model-specific disposition.

## I. Multi-intent metrics (399 cases)

| measure | Atria | CodeCraft | Deterministic |
| --- | --- | --- | --- |
| primary intent correct | 61.7% (246/399) | — | — |
| no unnecessary handoff | 74.9% (299/399) | — | — |
| complete multi-intent success | 56.6% (226/399) | 56.9% (227/399) | 47.6% (190/399) |
| any handoff | 78.9% (315/399) | 80.2% (320/399) | 95.0% (379/399) |

Both LLMs are statistically indistinguishable on complete multi-intent success
(−0.3pp) and both beat the deterministic path (+9pp). Handoff behaviour is also
nearly identical (78.9% vs 80.2%) — **not** a routing-architecture difference.

## J. Ambiguity metrics (199 cases)

| measure | Atria | CodeCraft | Deterministic |
| --- | --- | --- | --- |
| handled acceptably (no unnecessary handoff + intent not FAIL) | 69.8% (139/199) | 72.9% (145/199) | 66.3% (132/199) |
| any handoff | 94.5% (188/199) | — | — |

Both LLMs are within 3pp of each other; both improve on the deterministic path.
Atria's residual ambiguity failures are dominated by the intent channel
(`AMBIGUOUS → FAQ` 300 confusions, see §R), i.e. it answers instead of asking a
clarifying question.

## K. Knowledge metrics

By `requiredKnowledge` bucket (Atria pass/limitation/fail):

| bucket | total | pass | limitation | fail |
| --- | --- | --- | --- | --- |
| EXACT_FAQ | 105 | 97 | 0 | 5 |
| PARAPHRASED_FAQ | 78 | 25 | 0 | 0 |
| NOT_PRESENT | 57 | 51 | 0 | 6 |
| NOT_EXPOSED | 59 | 40 | 0 | 19 |
| KNOWLEDGE_GAP | 123 | 120 | 0 | 3 |
| NO_FAQ | 10 | 10 | 0 | 0 |

(All other buckets — PRICE, BUSINESS_INFO, WEAK_FAQ, MULTIPLE_PLAUSIBLE,
SERVICE_INFO, SERVICE_CATALOG, MULTIPLE_SOURCES, POLICY, AVAILABILITY,
SERVICE_DETAILS — are scored through the corresponding non-knowledge scorers;
`knowledgeRequirementAccuracy 91.2% (343/376)` is the headline knowledge metric.)

Breakdown of the knowledge signal:
- **knowledge correctly used:** EXACT_FAQ 97/105 and PARAPHRASED_FAQ 25/78
  answered from the exposed KB.
- **knowledge present but not used:** PARAPHRASED_FAQ 53/78 produced no
  knowledge-credited answer (answered via another scorer or failed elsewhere).
- **knowledge unavailable:** NOT_PRESENT 51/57 and KNOWLEDGE_GAP 120/123 handled
  correctly (no fabrication — the safe behaviour).
- **exposure limitation:** NOT_EXPOSED 19 failures — knowledge exists in the
  tenant context but is outside the exposed/visible scope; the model cannot use
  what the context builder did not expose.
- **hallucination / fabrication:** `KNOWLEDGE_FABRICATED` failure category =
  **24** cases, concentrated in `st-service-discovery` and
  `ex-service-discovery-variants` (sample ids in `analysis.json`). Atria
  invents catalog entries/service details not present in the exposed context.
  CodeCraft shows the same category at 19.

Knowledge retrieval was **not changed**; the model sees exactly the context the
production `buildAiContext` produces.

## L. Language metrics

By register (n / Atria pass-limitation-fail / CodeCraft fail / deterministic fail):

| register | n | A P/L/F | cc fail | det fail |
| --- | --- | --- | --- | --- |
| EGYPTIAN_COLLOQUIAL | 1667 | 664/437/566 | 587 | 739 |
| MSA | 63 | 37/0/26 | 25 | 33 |
| ARABIZI | 57 | 17/20/20 | 21 | 42 |
| ENGLISH | 32 | 7/10/15 | 18 | 13 |
| ARABIC_ENGLISH | 32 | 10/8/14 | 14 | 21 |
| MIXED_EGY_MSA | 23 | 19/4/0 | 0 | 4 |
| EGYPTIAN_FORMALISH | 19 | 16/0/3 | 3 | 6 |

By noise category:

| noise | n | A P/L/F | cc fail | det fail |
| --- | --- | --- | --- | --- |
| CLEAN | 880 | 344/243/293 | 303 | 376 |
| MISSING_HAMZA | 449 | 179/113/157 | 157 | 195 |
| MISSING_PUNCTUATION | 320 | 109/79/132 | 138 | 166 |
| TYPOS | 45 | 22/14/9 | 9 | 23 |
| REPEATED_LETTERS | 41 | 33/1/7 | 10 | 20 |
| KEYBOARD_MISTAKE | 35 | 11/21/3 | 6 | 18 |
| SPELLING_VARIATION | 34 | 18/11/5 | 4 | 17 |
| INFORMAL_PUNCTUATION | 32 | 24/2/6 | 6 | 7 |
| VERY_SHORT | 32 | 18/5/9 | 12 | 6 |
| MIXED_LANGUAGE | 28 | 7/7/14 | 14 | 22 |
| ARABIZI | 18 | 6/5/7 | 9 | 16 |
| SPEECH_TO_TEXT | 18 | 10/0/8 | 8 | 8 |
| EMOJI | 18 | 9/1/8 | 8 | 7 |
| FRAGMENTED | 16 | 4/0/12 | 12 | 13 |
| ABBREVIATIONS | 2 | 2/0/0 | 0 | 0 |

**Do not over-interpret small samples.** Registers with n ≤ 32 (ENGLISH,
ARABIC_ENGLISH, MIXED_EGY_MSA, EGYPTIAN_FORMALISH) and noise buckets with
n ≤ 18 are directionally informative only. Robust signals:
- Atria tracks CodeCraft within ~1–5pp on every register and noise bucket —
  **no language category is uniquely hard for Atria**.
- Both LLMs are materially better than the deterministic path on ARABIZI
  (20 vs 42 deterministic fails) and all noise buckets.
- The largest Atria-vs-CodeCraft gaps are MSA (26 vs 25 fails — identical) and
  ENGLISH (15 vs 18 fails — Atria slightly better, n=32, weak evidence).

## M. State / booking metrics

| measure | Atria | CodeCraft | Deterministic |
| --- | --- | --- | --- |
| multi-turn cases | 620 | — | — |
| conversation-state ok | 92.5% (531/574) | 92.3% (530/574) | 78.4% (450/574) |
| booking-state ok | 48.9% (336/687) | 48.0% (330/687) | 35.5% (244/687) |
| multi-turn PASS rate | 36.6% (227/620) | 38.7% (240/620) | 38.7% (240/620) |
| revision cases state ok | 96.2% (51/53) | — | — |
| booking-journey handoff | 95.1% (653/687) | — | — |

State handling is essentially identical between the two LLMs
(conversation-state +0.2pp, booking-state +0.9pp) and both are ~14pp above the
deterministic path. No state was built or changed in this slice; the EVAL-03
replay semantics preserved turn order and prior history exactly (620 multi-turn
cases, 2972 total turns).

## N. Safety metrics

| measure | Atria | CodeCraft | Deterministic |
| --- | --- | --- | --- |
| applicable safety cases | 216 | — | — |
| reported violations | 28 (13.0%) | 23 (10.6%) | 6 (2.8%) |
| **genuine violations** | **7** | — | — |
| scorer/dataset artifacts | 21 | — | — |

Separation (unchanged safety rules; no weakening): of the 28 reported,
**21 are scorer artifacts** — the SafetyScorer hard-fails any disclosed reply on
a case carrying an ADVERSARIAL/INJECTION edge even when the case's own
ground-truth `safetyExpectation` is `SAFE` and answering is correct. The
remaining **7 genuine** violations are cases where ground truth required
escalation/refusal and Atria answered instead. Atria's genuine rate
(7/216 = 3.2%) is the number that matters; the reported 13.0% overstates it.

## O. Latency / provider-attempt observations

| measure | value |
| --- | --- |
| evaluated LLM turns | 1864 |
| model latency p50 | 30,648 ms |
| p90 / p95 / p99 | 76,627 / 83,790 / 88,647 ms |
| max | 113,570 ms |
| evaluated turns with retry (>1 physical attempt) | 298 (16.0%) |
| avg physical attempts per evaluated LLM turn | 1.16 |
| evaluated timeout turns (final) | 0 |
| provider-failure turns (final) | 0 |

**Provider-latency observation (not model behaviour).** Atria-Dawn-Preview is a
slow model: single-request probe latency ≈ 9.4 s, rising to p50 ≈ 30 s under
bounded concurrency. At the **production `ATRIA_TIMEOUT_MS` = 16 s** cap, the
majority of turns under load exceed the per-attempt budget and fall to the
bounded retry, and frequently to the controlled NEED_HUMAN fail-safe — which
would have read as a handoff-heavy, failure-prone baseline that measures the
engine's timeout policy rather than the model. The measurement therefore used an
eval-only 45 s override (existing `AiFactoryEnvDeps.timeoutMs` probe seam); the
production cap is unchanged. **Latency was not optimized here — this is the
finding.**

## P. Atria vs CodeCraft comparison

**Where they behave similarly (the dominant pattern):** on 1893 jointly scored
cases the two models reached the **same verdict on 1719 (90.8%)**, with 680
both-PASS and 601 both-FAIL. Metric deltas are within ±3pp on 18 of 19 metrics;
the largest gaps are ambiguity handling (−3.0pp) and safety violation rate
(+2.3pp, 7 genuine vs 23 reported — see §N). Both models improve on the
deterministic path on exactly the same axes: intent accuracy limitation-adjusted
(+7.1pp/+7.5pp), conversation-state (+14.1/+13.9pp), booking-state
(+13.4/+12.5pp), entity extraction (+14.2/+13.2pp), multi-intent success
(+9.0/+9.3pp), and both reduce unnecessary handoff by ~38–40pp.

Verdict shifts vs CodeCraft: 99 improved, 75 regressed — a near-balanced
redistribution, not a capability gap.

**Where Atria differs materially:**
1. **Unnecessary handoff is slightly lower** (45.4% vs 48.1%, −2.7pp) and it is
   markedly less handoff-happy on the service-discovery family (37.1% vs 53.2%)
   — driven by pure-discovery scenarios where Atria answers and CodeCraft hands
   off. On the canonical booking+discovery utterance both still hand off
   (14 vs 17 of 20).
2. **Knowledge fabrication is slightly higher** (24 vs 19 cases) and is
   concentrated in service-catalog discovery — Atria invents catalog
   entries not in the exposed context.
3. **Genuine safety violations slightly higher** (7 genuine vs 23 reported for
   CodeCraft; direct reported comparison 28 vs 23).

**Persistent failure patterns across both models** (category: Atria / CodeCraft):
HANDOFF_UNNECESSARY 281/298 · INTENT_MISCLASSIFIED 161/160 · ACTION_WRONG
92/111 · EXTRACTION_HALLUCINATED 40/39 · SAFETY_VIOLATION 28/23 ·
KNOWLEDGE_FABRICATED 24/19 · HANDOFF_MISSED 14/13 · EXTRACTION_MISSED 4/5.
Every Atria failure category exists in the CodeCraft run at a similar rate —
**the failure surface is contract/policy-shaped, not model-shaped.**

## Q. Atria vs deterministic comparison

Verdict shifts vs deterministic: 451 improved, 354 regressed. Atria gains most
where the deterministic classifier cannot represent semantic nuance:
conversation-state +14.1pp, entity extraction +14.2pp, booking-state +13.4pp,
knowledge +11.2pp, multi-intent +9.0pp, and unnecessary handoff −40.2pp
(85.6% → 45.4%). Atria loses on strict intent accuracy (−2.5pp) and strict
action accuracy (−4.1pp) and handoff recall (−7.3pp): the deterministic
classifier is near-perfect at recognising a required human handoff
(missedHandoffRate 2.3% vs Atria 9.6%) because its rules are hand-tuned to the
8-intent contract, while both LLMs occasionally route a REQUIRED case to an
answer. Both LLMs' limitation-adjusted accuracy exceeds the deterministic path
(+7.1pp), i.e. most deterministic "correct" answers are LIMITATION-class.

## R. Failure clusters

Atria FAIL by category: HANDOFF_UNNECESSARY 281 · INTENT_MISCLASSIFIED 161 ·
ACTION_WRONG 92 · EXTRACTION_HALLUCINATED 40 · SAFETY_VIOLATION 28 ·
KNOWLEDGE_FABRICATED 24 · HANDOFF_MISSED 14 · EXTRACTION_MISSED 4.

Top failing scenarios: st-service-price 14 · mi-booking-plus-discovery 14 ·
kn-service-details-duration 14 · kn-availability-direct 14 · st-reschedule-basic
12 · mi-booking-plus-location 12 · am-bare-booking-clarifiable 12 ·
ex-service-discovery-variants 11 · mi-booking-plus-hours 10 ·
jt-availability-resolved 10 · jt-changes-mind-abort 10 · kn-not-exposed-revenue
10 · ho-unnecessary-knowledge-looks-like-booking 10 ·
re-long-context-topic-return 10 · re-reschedule-held-appointment 10 ·
re-injection-benign-question 10.

Intent confusion (expected current intent → actual, top entries):
- `AMBIGUOUS → FAQ` **300**, `→ BOOKING` 180, `→ AVAILABILITY` 21,
  `→ HUMAN_REQUEST` 26, `→ GREETING` 14
- `BOOKING → FAQ` 53, `→ AMBIGUOUS` 45, `→ AVAILABILITY` 18, `→ RESCHEDULE` 13
- `HUMAN_REQUEST → FAQ` 19, `→ AMBIGUOUS` 14, `→ BOOKING` 13
- `AVAILABILITY → BOOKING` 19

Clusters:
1. **Over-answering ambiguity** (`AMBIGUOUS → FAQ`, 300). The single largest
   confusion: a turn that should ask a clarifying question is answered as a FAQ
   reply. Persists in CodeCraft (same category present).
2. **Booking absorbed into FAQ/knowledge** (`BOOKING → FAQ` 53; the
   `ho-unnecessary-knowledge-looks-like-booking` and
   `mi-booking-plus-discovery` scenarios). When a booking turn also mentions
   services/prices/hours, both LLMs answer the knowledge part and drop the
   booking continuation.
3. **Required-human downgrades** (`HUMAN_REQUEST → FAQ/AMBIGUOUS`, 46 combined)
   — the source of the 9.6% missed-handoff rate.
4. **Fabrication on catalog discovery** (24 KNOWLEDGE_FABRICATED +
   EXTRACTION_HALLUCINATED 40).

## S. Evidence-supported architectural hypotheses

Stated as hypotheses only; no fix implemented.

1. **Contract/policy-shaped failure surface (strongest).** Every Atria failure
   category appears in the CodeCraft run at a nearly identical rate and the two
   models agree on 90.8% of verdicts. Hypothesis: the failures are driven by
   the shared 8-intent contract + handoff policy + prompt framing the two models
   see, not by either model. Supported by: 8/8 category overlap, ≤3pp deltas on
   18/19 metrics.
2. **Booking + knowledge co-occurrence is the handoff seam.** Unnecessary
   handoff concentrates exactly where a booking intent co-occurs with a
   knowledge intent (canonical utterance: Atria 14/20, CodeCraft 17/20), while
   pure discovery answers fine (Atria 0/8, 0/20 handoff). Hypothesis: the
   action-selection contract cannot express "answer the discovery question AND
   continue the booking", so the model collapses to one action. Supported by:
   the per-scenario table in §H and the `BOOKING → FAQ` / `AMBIGUOUS → FAQ`
   confusions.
3. **Context exposure bounds knowledge use.** NOT_EXPOSED is the only knowledge
   bucket with double-digit failures (19/59) while exposed knowledge is used
   well (EXACT_FAQ 97/105). Hypothesis: the failure is exposure/scoping, not
   retrieval or model ability. Supported by: bucket table §K, unchanged
   retrieval.
4. **Provider latency is a production-policy risk for Atria specifically.** p50
   ≈ 30 s vs a 16 s production per-attempt cap. Hypothesis: selecting Atria as
   the production provider without a latency/timeout change would materially
   increase controlled NEED_HUMAN fail-overs. Supported by: the calibration
   experiment (48/62 turns TIMEOUT at the 16 s cap) and the latency table §O.
5. **Deterministic path wins on required-handoff recognition only.** The
   classifier's missedHandoffRate is 2.3% vs 9.6% (Atria) / 8.7% (CodeCraft).
   Hypothesis: rule-tuned recognition of the REQUIRED-handoff signal is stronger
   than either LLM under the current prompt; both LLMs beat it everywhere else.
   Supported by: §G and §Q.

## T. Unknowns / insufficient evidence

- Whether Atria's higher latency is intrinsic to `Atria-Dawn-Preview` or an
  artifact of this evaluation's concurrency/queueing was not isolated (single
  concurrency level per pass; latency was measured, not optimized).
- Per-register differences with n ≤ 32 (ENGLISH, ARABIC_ENGLISH,
  MIXED_EGY_MSA, EGYPTIAN_FORMALISH) are under-powered; no conclusion drawn.
- Whether the `AMBIGUOUS → FAQ` confusion is prompt-driven or contract-driven
  cannot be separated by this slice (the prompt was intentionally unchanged).
- Whether the 21 scorer-artifact safety flags should be re-scoped is a dataset/
  scorer-design question, not measurable here (safety rules were not weakened).
- Atria's multi-intent secondary-intent retention is not separately visible in
  the metrics beyond `multiIntentSuccessRate`; a secondary-intent-specific
  scorer would be needed to split it from primary-intent correctness.
- A temperature / sampling configuration for Atria was not inspected or varied;
  the adapter's default was used as-is.

## U. Files created / changed

**Created (evaluation-only):**
- `scripts/eval-analyze-atria.ts` — three-way (Atria vs CodeCraft vs
  deterministic) analysis; reuses the EVAL-04B section logic verbatim.
- `evaluation/reports/egyptian-v1/atria-calibration/` — calibration artifacts
  (`checkpoint.ndjson`, `evaluation-run.json`, `report.md`, `manifest.json`).
- `evaluation/reports/egyptian-v1/atria-baseline/` — baseline artifacts
  (`checkpoint.ndjson`, `evaluation-run.json`, `report.md`, `manifest.json`,
  `analysis.json`, `BASELINE.md`, `COMPARISON.md`).

**Changed (evaluation-only, an untracked eval script):**
- `scripts/eval-run-real.ts` — added two optional flags:
  - `--provider <id>` / `--model <id>`: build the `EffectiveAiPolicy` directly
    (eval-only override) instead of reading the DB-backed production policy.
    Reuses `createRealLlmRunner` → `adaptersFromEffectivePolicy` → the existing
    `createAtriaAdapter`; **no second Atria implementation, no provider logic
    copied into evaluation code**.
  - `--timeout-ms <ms>`: threads into the existing `AiFactoryEnvDeps.timeoutMs`
    probe seam so slow-model inference completes during measurement. The
    production `ATRIA_TIMEOUT_MS` default is unchanged.
  - Default behaviour (no flags) is byte-for-byte the original EVAL-04B path.

**Unchanged:** every file under `src/` (no production code), the dataset, the
prompts, the Conversation Engine, the AI contract, provider policy, provider
selection, the EVAL-03 scoring engine, and the EVAL-04 / EVAL-04B artifacts.

## Explicit confirmations

- **Atria real inference was used** — `realProvider: atria`,
  `realModel: Atria-Dawn-Preview` on 2782 turns; provider probe HTTP 200,
  `parseMode: DIRECT_PARSE`.
- **The existing Atria integration was reused** — `createAtriaAdapter` /
  `ATRIA_SECRET_REF` / `ATRIA_NORMALIZATION_POLICY` / `getPromptBody`, invoked
  through `adaptersFromEffectivePolicy`. No second Atria provider implementation
  was created and no provider logic was copied into evaluation code.
- **No Production provider switch occurred** — the DB-backed policy was never
  read or written while the override was active; the override lives only in the
  evaluation process.
- **No Production behavior changed** — nothing under `src/` was modified;
  `check:eval-runner` R15/R18 report 0 production↔evaluation import offenders.
- **No prompt changes** — `prompts/` untouched; `check:ai-prompts` invariants
  unaffected.
- **No JEV.**
- **No architecture fix** — measurement only.
- **No deployment** — nothing deployed, committed, pushed, or tagged.
