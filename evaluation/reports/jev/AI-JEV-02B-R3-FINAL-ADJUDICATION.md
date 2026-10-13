# PROMPT-AI-JEV-02B-R3 — HOLDOUT-V4 ARTIFACT ADJUDICATION + FINAL ELIGIBILITY

> ┌────────────────────────────────────────────────────────────────────────┐
> │ OFFLINE ADJUDICATION GATE. EVALUATION / REPORTING ONLY.                │
> │ No `src/` runtime change. No production routing change. No schema or   │
> │ migration. No DB write. No booking mutation. No customer send. No      │
> │ deployment. No live model call of any kind.                            │
> │                                                                        │
> │ LIVE JEV CALLS MADE BY THIS TASK: **0**                                │
> │ Every number below was recomputed offline from the committed immutable  │
> │ artifact and from committed evaluation source. No holdout was executed  │
> │ or re-exposed; holdout-v3 and holdout-v4 were both refused at the       │
> │ retirement denial gate (verified, not assumed).                         │
> └────────────────────────────────────────────────────────────────────────┘

**Task**   PROMPT-AI-JEV-02B-R3 — adjudicate the completed sealed holdout-v4
           evidence and decide whether AI-JEV-03 DESIGN may proceed.
**Verdict** **A) READY_FOR_AI_JEV_03_DESIGN** — with a binding design contract
           in §15. Not a production-launch approval, and not a claim that JEV
           is finished. See §14 for the eligibility reasoning and §16 for the
           evidence limitations that remain open.
**Authored** 2026-10-13, AI-JEV-02B-R3 session. Ancestor release **v0.44.7**.

---

## 1. Repository / release identity — independently recomputed

Every item below was derived from live git state, not from any prior report's
prose.

| item | verified value | expected | verdict |
| ---- | -------------- | -------- | ------- |
| branch | `main` | `main` | PASS |
| HEAD | `2ffc7bc7df38f93008b1dcb6886c2d41f26b9c21` | `2ffc7bc…` | PASS |
| HEAD short | `2ffc7bc` | `2ffc7bc` | PASS |
| `origin/main` vs HEAD | equal (no ahead/behind) | equal | PASS |
| `package.json` version | `0.44.7` | `0.44.7` | PASS |
| latest release tag | `v0.44.7` | `v0.44.7` | PASS |
| working tree at entry | **clean, 0 modified, 0 untracked** | clean | PASS |
| working tree at exit | **clean, 0 modified** (this report is the only write) | clean | PASS |
| unfinished merge / rebase / cherry-pick / revert / bisect | none | none | PASS |
| `git diff --check` | exit 0, no whitespace/conflict markers | clean | PASS |

`BLOCKED_BASELINE_MISMATCH` was not triggered. Nothing was reset, checked out,
stashed, cleaned, rebased or committed by this task.

**The release commit is load-bearing and worth recording:** `2ffc7bc` is the
single commit that introduced the entire JEV evaluation surface —
`evaluation/jev/*` (5 files), the four prior JEV reports, 18 benchmark
artifacts including the holdout-v4 artifact, and the `check:jev` /
`eval:jev` scripts. So the frozen candidate and the sealed artifact were
committed **together** in the release: the artifact and the source it is bound
to ship in the same commit. There is no window in the committed history where
the artifact exists without its frozen bindings.

---

## 2. Evidence source — the committed holdout-v4 artifact

Located at:

```
evaluation/reports/jev/jev-benchmark-holdout-v4-live-live-2026-10-12T18-46-13-847Z-393e6c.json
```

git-tracked (confirmed via `git ls-files`), 10 942 lines, one immutable
`runId: live-2026-10-12T18-46-13-847Z-393e6c`.

### 2.1 Structural completeness — recomputed from the artifact's own rows

| field | artifact value | recomputed from rows | verdict |
| ---- | -------------- | -------------------- | ------- |
| `bank` / `bankId` | `holdout-v4` | rows' slice membership = 60/60 `holdout-v4` | PASS |
| `plannedFixtureCount` | 60 | — | PASS |
| `completedFixtureCount` | 60 | `completedFixtureIds.length` = 60 | PASS |
| `rows` | 60 | — | PASS |
| `failedFixtureIds` | `[]` (0) | 0 | PASS |
| `notRequestedFixtureIds` | `[]` (0) | 0 | PASS |
| `plannedRequests` | 60 | `plannedRequestCount()` on the v4 slice = 60 | PASS |
| `executedRequests` | 60 | `requests.ledger.length` = 60 | PASS |
| `requests.failed` | 0 | 0 | PASS |
| `requests.retries` | 0 | ledger `attempts` all = 1 | PASS |
| `totals.errors` | 0 | rows with `ok !== true` = 0 | PASS |
| `artifactStatus` | `COMPLETE`, `COMPLETE=true` | — | PASS |
| `SCORABLE` | `true` | — | PASS |
| `interrupted` | `false` | — | PASS |
| `finalization.ok` | `true`, `reason: null` | — | PASS |
| `resumeAllowed` | `false` | — | PASS |
| `requestedModel` | `typesafe/jev-1.13` | pinned in manifest | PASS |
| `servedModels` | `["typesafe/jev-1.13-20260917"]` | **distinct served model across all 60 rows = exactly that one** | PASS |
| `credentialPresent` | `true` (no credential serialized — see 2.4) | — | PASS |
| `startedAt` → `finishedAt` | `18:46:13.847Z` → `18:46:24.870Z` | ~11.0 s for 60 rows, p50 latency 177 ms | consistent |

Every expected characteristic from the prior post-ship audit was reproduced,
and none was copied from prose: each was recomputed from the artifact's own
rows and from committed source.

### 2.2 Cryptographic bindings — recomputed from committed source

A script outside the working tree (`/tmp/opencode/jev-r3/verify-r3.ts`)
imported the committed evaluation modules and recomputed every fingerprint the
artifact claims, then compared it against **three** independent sources: the
artifact's recorded value, the frozen manifest constant, and the freshly
derived value.

| binding | recomputed from source | artifact | frozen manifest | 3-way match |
| ------- | ---------------------- | -------- | --------------- | ----------- |
| question contract | `sha256:588222a74f4a356b` | `sha256:588222a74f4a356b` | `sha256:588222a74f4a356b` | ✅ |
| probability policy | `sha256:a01c368d17e5629e` | `sha256:a01c368d17e5629e` | `sha256:a01c368d17e5629e` | ✅ |
| slice `original` | `sha256:69341a65821179a9` | same | same | ✅ (40/40) |
| slice `calibration` | `sha256:8a76f9e4deeb94f8` | same | same | ✅ (26/26) |
| slice `holdout` | `sha256:d3f4a90715c80066` | same | same | ✅ (20/20) |
| slice `calibration-v3` | `sha256:29a8d48d1e244ee0` | same | same | ✅ (27/27) |
| slice `holdout-v3` | `sha256:1d659cc4d188bf56` | same | same | ✅ (47/47) |
| slice `holdout-v4` | `sha256:7e96dd7d89409647` | same | same | ✅ (60/60) |
| freeze manifest itself | `sha256:e8031b1f40777359` | `sha256:e8031b1f40777359` | — | ✅ |

The fingerprint algorithms are content hashes over canonicalized
`(id, message, expected)` triples (`sliceFingerprint` in
`evaluation/jev/jev-fixture-bank.ts:191`), over the canonicalized question set
(`contractFingerprint`, `jev-probability-policy.ts:301`) and over the
canonicalized policy (`policyFingerprint`, `jev-probability-policy.ts:286`).
The slice hash is order-independent (per-fixture hashes are sorted before
joining), so reordering the bank cannot break or forge a binding.

**Conclusion:** the artifact is cryptographically bound to exactly the frozen
candidate that produced it, and the frozen candidate is byte-identical to the
committed source at `2ffc7bc`. A post-hoc label edit, contract edit or policy
edit would break at least four of these nine bindings. None are broken.

### 2.3 Bank integrity and disjointness — recomputed

| check | result |
| ----- | ------ |
| `bankIntegrity(JEV_FIXTURES_V4)` over all 220 fixtures | `ok = true`, **0 problems** (no duplicate id, no duplicate message) |
| `holdout-v4` id/message overlap with all five other slices | **0** (fully disjoint) |
| `holdout-v4` fixture count | 60 (≥ the 40 fixture floor) |
| `verifyFreezeManifest(artifact's own recorded state)` | **0 mismatches** — the artifact's recorded fingerprints, counts, ids and pinned model all satisfy the frozen manifest exactly |
| `bankExecutionDenial("holdout-v3")` | denial returned — `SEAL_BROKEN`, `eligibleForExecution: false` |
| `bankExecutionDenial("holdout-v4")` | denial returned — `COMPLETED`, `eligibleForExecution: false`, `eligibleForScoring: true` |

The last two rows are the hard-rule guards. Both sealed banks are refused
re-execution at the gate, before any fetch could be constructed. This task
performed **zero** live calls (see §18).

### 2.4 Secret hygiene — recomputed

`secretScan` on the artifact: `scanned: true`, `13 probes`, `hits: []`. No
`OPENROUTER_API_KEY`, no credential, no Authorization header, no PII appears
anywhere in the artifact. `credentialPresent: true` records only that a
credential *existed in the environment at run time*; the credential itself is
not serialized. The repo-level security check (`scripts/security-check.mjs`)
also passes: no secrets, credentials, or env files at risk of being committed.

### 2.5 Class coverage

25 fixture classes are populated (`bankCoversAllClasses` covers the mandatory
contact-vs-book families). 7 optional classes are empty and are explicitly
listed in `missingClasses` — `sensitive-plus-booking`,
`non-attendance-cancellation`, `non-attendance-reschedule`,
`reschedule-cancel-paraphrase`, `greeting-plus-explicit-human-plus-booking`,
`provider-availability-plus-greeting`, `provider-availability-plus-service`.
These are **declared gaps, not silent ones**, and §16 records which of them
actually matter for the design decision.

**Evidence integrity is established. `BLOCKED_EVIDENCE_INTEGRITY` was not
triggered.**

---

## 3. Holdout-v4 metrics — recomputed offline from artifact rows

The artifact's aggregate fields were not trusted. Every figure below was
recomputed by iterating the 60 individual rows and re-deriving the verdicts
with the server-owned precedence formula (`applyServerPrecedence`, a copy of
the shipped rule kept in evaluation-only source for exactly this purpose).

| metric | recomputed | artifact field | match |
| ------ | ---------- | -------------- | ----- |
| fixtures | 60 | `fixtures = 60` | ✅ |
| scored question/expectation pairs | **220** | `scoredQuestions = 220` | ✅ |
| question agreement | **208 / 220** (94.5%) | `correctness.questionAgreement = 208 / 220` | ✅ |
| fixture-exact agreement (all facts equal) | **50 / 60** (83.3%) | `correctness.exact = 50 / 60` | ✅ |
| **final routing agreement** | **56 / 60** (93.3%) | `correctness.routing = 56 / 60` | ✅ |
| token totals | in 208 719 / out 18 985 / cost 0.008766198 | identical | ✅ |

### 3.1 Routing-relevant fact confusion — recomputed, FP/FN separated

`expected === null` is treated as *not an asserted expectation*, matching the
scorer; absent facts are treated as `false` only when the precedence formula
projects them.

| fact | disagreements | false positives | false negatives | routing-affecting? |
| ---- | ------------: | --------------: | --------------: | ------------------ |
| `supportRequested` | **0** | 0 | 0 | yes — consumed by precedence |
| `providerRequested` | 2 (asserted) + 3 (null→true) | 0 | **2** | **yes — the dominant routing fact** |
| `bookingRequested` | **0** | 0 | 0 | yes (bookingTask mask) |
| `availabilityAsked` | 5 | 2 | 3 | yes (bookingTask mask) |
| `cancellationRequested` | 0 | 0 | 0 | yes (bookingTask mask) |
| `rescheduleRequested` | 0 | 0 | 0 | yes (bookingTask mask) |
| `ambiguousTurn` | **0** | 0 | 0 | no — observability only |
| `providerPreferenceExpressed` | 4 | 3 | 1 | **no — not consumed by precedence** |
| `serviceOrPriceAsked` | 1 | 1 | 0 | no |
| `sensitiveTurn` | 0 | 0 | 0 | no (safety is a separate deterministic signal) |
| `greetingOnly` | 0 | 0 | 0 | no |
| `conversationGoal` | 0 | 0 | 0 | no — non-routing choice field |

Total asserted-fact disagreements: 12, matching `totals.disagreements = 12`
and the 12 `disagreementRows` exactly.

### 3.2 The decisive probability-shape finding

Rebinning the 60 rows on the raw `providerRequested` probability — the one
fact that drives the provider path of the precedence — gives:

| band | rows |
| ---- | ---- |
| `< 0.2` | **42** |
| `0.2 – 0.4` | 0 |
| `0.4 – 0.6` | **4** |
| `0.6 – 0.8` | 4 |
| `≥ 0.8` | 10 |

The model is **not** broadly uncertain. It is bimodal: 52 of 60 rows sit
outside any plausible threshold band, and exactly **4** rows land in the
`0.4–0.6` decision band. Three of those four are routing mismatches. The
fourth (`v4-hold-mask-talk-then-book`, p = 0.40) is rescued by the booking
mask and routes correctly. **The model's residual uncertainty is not diffuse —
it is localized to a single semantic boundary (contact-vs-book), and the
existing precedence mask already absorbs part of it.**

### 3.3 `conversationGoal` — recomputed distribution

| goal | n | confidence range |
| ---- | - | ---------------- |
| `human_handoff` | 22 | 0.47 – 1.0 (median 1.0) |
| `booking` | 18 | 0.25 – 1.0 |
| `availability` | 9 | 0.76 – 1.0 |
| `service_info` | 4 | 0.39 – 1.0 |
| `greeting` | 3 | 0.66 – 1.0 |
| `ambiguous` | 2 | 0.60 – 0.98 |
| `cancellation` | 1 | 1.0 |
| `reschedule` | 1 | 1.0 |

The `human_handoff` goal is confidently held (median 1.0). The only
`human_handoff` rows below 0.7 are the three *provider-identity* questions
(`v4-hold-id-english-cardio` 0.49, `v4-hold-id-branch-doctor` 0.47,
`v4-hold-id-who-peds` 0.66) — and those route correctly because
`providerRequested` is low (0.04–0.08) and the precedence formula, not the
goal choice, owns the verdict. This is direct evidence that the goal field and
the fact field are **independent channels**, and that the formula is the one
that matters.

---

## 4. The known failure topology — verified, not assumed

The prior post-ship analysis reported ~56/60 final routing with four
mismatches: one missed direct-contact case and three bare-ambiguity
over-handoffs. **This was independently reproduced exactly.** The recomputed
mismatch set is:

```
v4-hold-contact-meet-peds-tomorrow   عايز أقابل دكتورة أطفال بكرة      expected true  → actual false
v4-hold-ambig-need-doctor            محتاج دكتور                        expected false → actual true
v4-hold-ambig-can-doctor             ممكن دكتور؟                        expected false → actual true
v4-hold-ambig-want-the-doctor        عايز الدكتور                       expected false → actual true
```

All four fixture texts and expectations were read back from the committed bank
and the artifact; no label was altered. The three bare-ambiguity fixtures are
verbatim as described in the brief.

### 4.1 Complete routing mismatch table

#### M-1 — `v4-hold-contact-meet-peds-tomorrow` — "عايز أقابل دكتورة أطفال بكرة"

| field | value |
| ----- | ----- |
| classes | `provider-direct-contact`, `egyptian-arabic-variant` |
| exact user message | `عايز أقابل دكتورة أطفال بكرة` |
| expected facts | `providerRequested = true`, `bookingRequested = false`, `availabilityAsked = false`, `providerPreferenceExpressed = false` |
| raw JEV probabilities | provider **0.40**, booking **0.45**, availability 0.07, support 0.04, preference 0.92, ambiguousTurn **0.49** |
| derived facts (model) | `providerRequested = false`, `bookingRequested = false`, `availabilityAsked = false` → all routing facts false |
| `conversationGoal` + confidence | **`booking` @ 0.91** |
| `bookingTask` state | **false** (booking 0.45 also falls under 0.5) |
| server precedence derivation | `supportRequest` false, `providerRequest` false, `bookingTask` false → `none` |
| expected final routing | explicitHuman = **true** (`providerRequest AND NOT bookingTask`) |
| actual final routing | explicitHuman = **false** (`none`) |
| root cause | **A — semantic/model misunderstanding**, with **B** as a contributing factor |

Both decision-relevant probabilities straddle the threshold from *opposite*
sides (provider 0.40 under, booking 0.45 under), and `ambiguousTurn` = 0.49.
The model resolved "meet a pediatrician tomorrow" as an *arrangement* rather
than a *contact*: its `conversationGoal` is `booking` at **0.91**, a confident
semantic reading, not a boundary wobble. The contrast fixture
`v4-hold-ambig-meet-doctor` ("عايز أقابل دكتور", no specialty title, no time)
scored provider **0.77** and routed correctly — so the differentiator is the
*specialty title plus a future time*, which pulled this turn toward
book-to-see semantics. This is a genuine semantic miss, and it is the only one
in the bank.

#### M-2 — `v4-hold-ambig-need-doctor` — "محتاج دكتور"

| field | value |
| ----- | ----- |
| classes | `ambiguous-unsupported`, `egyptian-arabic-variant` |
| exact user message | `محتاج دكتور` |
| expected facts | `bookingRequested = false`, `availabilityAsked = false`, `supportRequested = false`, `providerPreferenceExpressed = false` — **`providerRequested` intentionally UNSET** |
| raw JEV probabilities | provider **0.53**, booking 0.11, availability 0.08, support 0.06, preference 0.62, ambiguousTurn 0.21 |
| derived facts (model) | `providerRequested = true`; all booking-family facts false |
| `conversationGoal` + confidence | **`human_handoff` @ 0.76** |
| `bookingTask` state | false |
| server precedence derivation | `providerRequest AND NOT bookingTask` → explicitHuman **true** |
| expected final routing | explicitHuman = **false** (`none`) |
| actual final routing | explicitHuman = **true** |
| root cause | **E — genuine user ambiguity**, realized as **B — threshold boundary** (0.53 barely over 0.5) |

#### M-3 — `v4-hold-ambig-can-doctor` — "ممكن دكتور؟"

| field | value |
| ----- | ----- |
| classes | `ambiguous-unsupported`, `egyptian-arabic-variant` |
| exact user message | `ممكن دكتور؟` |
| expected facts | `bookingRequested = false`, `availabilityAsked = false`, `supportRequested = false` — **`providerRequested` intentionally UNSET** |
| raw JEV probabilities | provider **0.61**, booking 0.15, availability 0.23, support 0.09, preference 0.29, ambiguousTurn 0.36 |
| derived facts (model) | `providerRequested = true`; all booking-family facts false |
| `conversationGoal` + confidence | **`human_handoff` @ 0.81** |
| `bookingTask` state | false |
| server precedence derivation | `providerRequest AND NOT bookingTask` → explicitHuman **true** |
| expected final routing | explicitHuman = **false** |
| actual final routing | explicitHuman = **true** |
| root cause | **E — genuine user ambiguity**, realized as **B — threshold boundary** (0.61). Zero fact-level disagreements recorded — the routing change comes entirely from the unset→true transition. |

#### M-4 — `v4-hold-ambig-want-the-doctor` — "عايز الدكتور"

| field | value |
| ----- | ----- |
| classes | `ambiguous-unsupported`, `egyptian-arabic-variant` |
| exact user message | `عايز الدكتور` |
| expected facts | `bookingRequested = false`, `availabilityAsked = false`, `supportRequested = false` — **`providerRequested` intentionally UNSET** |
| raw JEV probabilities | provider **0.56**, booking 0.09, availability 0.10, support 0.06, preference 0.61, ambiguousTurn 0.28 |
| derived facts (model) | `providerRequested = true`; all booking-family facts false |
| `conversationGoal` + confidence | **`human_handoff` @ 0.90** |
| `bookingTask` state | false |
| server precedence derivation | `providerRequest AND NOT bookingTask` → explicitHuman **true** |
| expected final routing | explicitHuman = **false** |
| actual final routing | explicitHuman = **true** |
| root cause | **E — genuine user ambiguity**, realized as **B — threshold boundary** (0.56) |

### 4.2 The label intent — read from the bank, not inferred

The three bare-ambiguity fixtures are not accidents. The committed bank
documents the design at `evaluation/jev/jev-fixture-bank.ts` (family G):

> Rows 1–3 are BARE provider need: no interaction verb and no arrangement
> verb. The frozen @v3 contract excludes booking, availability, support and
> preference from all three, **and does not assert providerRequested either**
> — a turn that names neither an interaction nor an arrangement is exactly the
> contact-vs-book ambiguity a future clarification step should resolve. Under
> the CURRENT precedence that derives explicitHuman = false (failure to
> understand is not a handoff), and the clarification analysis in the report
> classifies each as a CLARIFICATION_CANDIDATE.

So `providerRequested = null` is the frozen, fingerprinted expression of
**"neither automatic booking nor automatic human handoff is justified."** The
bank was authored to *measure* this surface. M-2/M-3/M-4 are therefore not
defects in the measurement — they are the measurement.

### 4.3 The reference pairs behaved correctly

The brief warned that the three bare-ambiguity strings are **not** equivalent
to the explicit-contact strings. The evidence agrees, and the separation is
clean:

| message | pProvider | routed | semantic |
| ------- | --------- | ------ | -------- |
| `عايز أقابل دكتور` (verb-bearing half of the pair) | **0.77** | handoff ✅ | contact |
| `عايز الدكتور` (bare half) | 0.56 | handoff (expected: clarify) | ambiguous |
| `I need to be seen by a doctor` (English verb-bearing) | **0.78** | handoff ✅ | contact |
| `ممكن تخليني أكلم دكتورة نسا؟` | **0.94** | handoff ✅ | contact |
| `احجزلي كشف مع دكتورة بكرة` | 0.08 | booking ✅ | booking |
| `عايز كشف عند دكتورة أطفال الأسبوع الجاي` | 0.16 | booking ✅ | booking |
| `فيه دكتورة أطفال متاحة بكرة؟` | 0.09 | availability ✅ | availability |
| `عايز أكلم الدكتور الأول وبعدين نحجز` | 0.82 / booking 0.59 | booking (mask holds) ✅ | mask |

The verb-bearing contrast fixtures (`أقابل`, `be seen by`, `أكلم`) all score
0.77–0.98 and route correctly. The bare fixtures score 0.53–0.61. **The model
already separates the two relationships semantically; it merely lacks a third
outcome for the middle.**

---

## 5. Root-cause classification — errors are not equal

| id | fixture | primary cause | contributing |
| -- | ------- | ------------- | ------------ |
| M-1 | `…meet-peds-tomorrow` | **A** semantic/model misunderstanding — "meet + specialty + tomorrow" read as an arrangement (goal `booking` @ 0.91) | **B** both decision probabilities under 0.5 (0.40 / 0.45) |
| M-2 | `محتاج دكتور` | **E** genuine contact-vs-book ambiguity | **B** 0.53 barely crosses 0.5 |
| M-3 | `ممكن دكتور؟` | **E** genuine contact-vs-book ambiguity | **B** 0.61 crosses 0.5; availability 0.23 also low |
| M-4 | `عايز الدكتور` | **E** genuine contact-vs-book ambiguity | **B** 0.56 crosses 0.5 |

**No mismatch is C (server-precedence/masking).** The mask was exercised hard
and held in every case that reached it: `v4-hold-mask-book-then-talk`
(provider 0.40 *and* booking 0.93 → booking, mask holds),
`v4-hold-mask-talk-then-book` (provider 0.82, booking 0.59 → booking, mask
holds, order-independent as documented), `v4-hold-book-peds-nextweek`
(provider 0.16, booking 0.79 → booking). The precedence formula is the most
reliable component in the chain.

**No mismatch is D (label-vs-contract disagreement).** The frozen @v3 labels
are internally consistent and the `providerRequested = null` choice is
explicitly documented and fingerprinted. (The historical
`providerPreferenceExpressed` label defect adjudicated under §10 in
AI-JEV-02B-R concerns the three *older* slices only, is recorded in the
manifest's `PROVIDER_PREFERENCE_ADJUDICATION`, and has NULL routing impact
because that fact is not consumed by the precedence. Holdout-v4 carries the
forward contract-consistent orientation throughout.)

**Classification of the remaining 8 `disagreementRows` — all routing-neutral:**

| fixture | disagreement | why routing-neutral |
| ------- | ------------ | ------------------- |
| `v4-hold-id-derm-name` | availabilityAsked FN (0.38) | `providerRequested` 0.04 → derivation `none` either way |
| `v4-hold-id-who-peds` | availabilityAsked FN (0.49) + preference FP | `providerRequested` 0.08 → `none` either way |
| `v4-hold-id-english-cardio` | availabilityAsked FN (0.41) | `providerRequested` 0.04 → `none` either way |
| `v4-hold-pref-female-not-male` | availabilityAsked FP (0.71) | preference turn, `providerRequested` 0.08 |
| `v4-hold-pref-sara-if-slot` | availabilityAsked FP (0.75) | preference turn, `providerRequested` 0.13 |
| `v4-hold-mask-book-then-talk` | providerRequested FN (0.40) | booking 0.93 → `bookingTask` masks the provider path |
| `v4-hold-neg-manager-hours` | serviceOrPriceAsked FP | not consumed by precedence |
| `v4-hold-msa-booking-titled` | providerPreferenceExpressed FN | not consumed by precedence |

**So: 4 routing-affecting errors out of 60; 8 routing-neutral disagreements;
and 50/60 fixtures fully exact.** The three `provider-identity` availability
misreadings (0.38–0.49) are the only recurring non-routing pattern, and they
are a *label-boundary* question ("who is the pediatrician?" is arguably
identity, not availability) rather than a semantic failure.

### 5.1 One measurement gap worth naming

The artifact's `contactBookMatrix` reports `routingFalseHandoff = 0`. That
counter is computed over rows with `expected.providerRequested !== null`
(`scripts/eval-jev-benchmark.ts:1561`), which **excludes exactly the three
bare-ambiguity rows**. The three false handoffs that do exist are therefore
absent from that counter. This is a reporting gap in an evaluation-only
aggregator, not an integrity defect — the 4 routing mismatches are correctly
counted in `disagreementRows` and `correctness.routing`, and the recomputation
in §3 reproduces them from raw rows. But any future instrumentation that reads
`routingFalseHandoff` alone will undercount. §16 records this; §15 item 13
requires the design's telemetry not to repeat it.

---

## 6. Product policy adjudication — the central question

The proposed principle is **LOW CONFIDENCE ≠ HUMAN HANDOFF** and **AMBIGUITY ≠
HUMAN HANDOFF**. The evidence supports it, and it is stronger than the brief
implies, for one reason the prior reports did not establish.

### 6.1 The decisive finding: the shipped seam is already worse

The shipped deterministic explicit-human detector
(`detectExplicitHumanRequest`,
`src/features/conversations/server/conversation-ai.ts:553`) is a **lexical**
rule: `providerRequest = title-word ∧ request-cue`, `bookingTask =
booking/availability/cancellation/reschedule stems`, `explicitHuman =
supportRequest ∨ (providerRequest ∧ ¬bookingTask)`. It is pure and local, so
it can be evaluated offline against the same 60 frozen expectations. It was:

| seam | agreement with holdout-v4 expected `explicitHuman` |
| ---- | -------------------------------------------------- |
| **shipped deterministic lexical seam (v0.44.7)** | **41 / 60 (68.3%)** |
| **JEV `typesafe/jev-1.13-20260917`** | **56 / 60 (93.3%)** |

The shipped seam fails **19** rows. Its failures include turns JEV gets
completely right and which the product invariants in §7 *require* to be
protected:

| message | shipped | JEV | required by §7 |
| ------- | ------- | --- | -------------- |
| `I want to speak with the doctor directly` | **no handoff** ❌ | handoff ✅ | invariant A |
| `Can you connect me to Dr Ahmed?` | **no handoff** ❌ | handoff ✅ | invariant A |
| `ممكن connect me بالدكتورة نفسها؟` | **no handoff** ❌ | handoff ✅ | invariant A |
| `ينفع أحكي للدكتور بنفسي؟` | **no handoff** ❌ | handoff ✅ | invariant A |
| `عايز حد يوصلني للدكتور` | **no handoff** ❌ | handoff ✅ | invariant A |
| `عايز أكلم خدمة العملاء` | **no handoff** ❌ | handoff ✅ | invariant A |
| `I need to talk to someone from support` | **no handoff** ❌ | handoff ✅ | invariant A |
| `عايز حد من الاستقبال يحجزلي` | **no handoff** ❌ | handoff ✅ | invariant A |
| `عايز كشف عند دكتورة أطفال الأسبوع الجاي` | **handoff** ❌ (a booking!) | booking ✅ | invariant: booking protected |

Every one of those is a protected-request failure in the *current* production
code. **JEV is not introducing a regression; it is strictly better on the
product's own stated invariants, by 15 rows, and the three bare-ambiguity
over-handoffs it makes are the same three the shipped seam already makes.**

This is the single most important fact in the adjudication. The choice is not
"JEV vs. a correct deterministic rule" — the deterministic rule already
exists, already ships, and already loses 19 rows.

### 6.2 The three bare-ambiguity rows are a policy gap, not a model defect

Evaluated against the shipped lexical seam:

| message | shipped `explicitHuman` | JEV | frozen expectation |
| ------- | ----------------------- | --- | ------------------ |
| `محتاج دكتور` | **true** (`دكتور` + `محتاج` cue) | true | false — CLARIFY candidate |
| `ممكن دكتور؟` | **true** (`دكتور` + `ممكن` cue) | true | false — CLARIFY candidate |
| `عايز الدكتور` | **true** (`دكتور` + `عايز` cue) | true | false — CLARIFY candidate |

**Production already hands these three off today**, and has done so since
before JEV. M-2/M-3/M-4 are therefore not a JEV-specific defect at all. They
are the visible cost of a missing third outcome — a product-policy gap that
CLARIFY_ONCE is designed to close. Conversely, the one case JEV loses that the
shipped seam wins is M-1 (`عايز أقابل دكتورة أطفال بكرة`), where the lexical
rule's blunt title-plus-cue match happens to land on the correct verdict.

**Net direction of travel under CLARIFY_ONCE:** the 3 bare-ambiguity rows move
from handoff → bounded clarify (matching the frozen expectation), M-1 stays a
missed contact, and the 8 protected-request failures the shipped seam makes
today become correct. Routing disagreement against the frozen expectation
falls from 4 → 1 for JEV and from 19 → 16 for the shipped seam, with the
clarify rows now counted as a correct third outcome rather than a handoff.

### 6.3 Adjudication of the four distinctions

**1. Explicit human / direct-contact request** — supported. Every unambiguous
contact turn scored provider 0.69–0.98 and routed to handoff correctly. The
`provider-direct-contact` family is **14 / 15** on the routing verdict; its one
routing failure is M-1 and its other two disagreements are routing-neutral
(`v4-hold-mask-book-then-talk` is masked by bookingTask,
`v4-hold-ambig-need-doctor` / `v4-hold-ambig-want-the-doctor` disagreements are
`providerPreferenceExpressed`, which precedence does not consume). The
`explicit-human-only` and `explicit-human-plus-booking` families are **6 / 6**
with zero disagreements. The contract's cue-plus-title semantics match the
production rule's intent while extending it to English, MSA and code-switched
turns the lexical tables do not cover. **Explicit human remains
authoritative.**

**2. Explicit booking intent** — supported and *strongly* so. `bookingRequested`
had **zero** disagreements across all 60 rows. Every booking fixture
(`احجزلي كشف مع دكتورة بكرة` 0.97, `Book an appointment with Dr Ahmed next
Thursday` 0.99, `أرغب في حجز موعد مع طبيب الأسنان` 0.97, `عايز ميعاد عند دكتور
جلدية` 0.91) routed to booking with provider probabilities of 0.04–0.16. A
provider title alone never converts a booking into a handoff. **Booking is
protected.**

**3. Provider availability / identity** — supported. All 7
`provider-availability` fixtures have 0 disagreements (`فيه دكتورة أطفال متاحة
بكرة؟` provider 0.09 / availability 0.96; `Is Dr Ahmed in today?` 0.07;
`مين متاح من الدكاترة بعد الساعة ستة؟` 0.07). Presence and identity questions
do not produce contact. The availability FP on the two preference fixtures
(0.71, 0.75) is routing-neutral. **Availability does not mean contact.**

**4. Genuine contact-vs-book ambiguity** — this is where the evidence changes
the design, and it is the one place the current system is structurally wrong.
Bare provider need has no third outcome, so the precedence formula is forced to
answer a question the turn did not ask. The model itself signals this: its
`ambiguousTurn` probabilities on the bare rows are *low* (0.21–0.36) while its
`providerRequested` sits exactly on the boundary — the model is not confused
about *what* the turn is about, it is being asked to force a binary where a
third answer exists.

**Verdict on the proposed principle: ADOPTED, with CLARIFY_ONCE as the
mechanism for distinction 4 only.** LOW CONFIDENCE ≠ HUMAN HANDOFF is upheld by
the bimodal probability shape (§3.2): genuine low confidence is rare, and when
it appears it is concentrated on exactly the boundary CLARIFY_ONCE targets.

---

## 7. Contact-vs-book analysis

The contract-vs-book distinction is carried by two independent facts
(`providerRequested`, `bookingRequested`) plus the masking family. The bank's
contrast families resolve as follows:

| relationship | example | pProvider | pBooking | routed as | correct |
| ------------ | ------- | --------- | -------- | --------- | ------- |
| direct contact (verb) | `ممكن تخليني أكلم دكتورة نسا؟` | 0.94 | 0.06 | handoff | ✅ |
| direct contact (English) | `I want to speak with the doctor directly` | 0.98 | 0.04 | handoff | ✅ |
| direct contact (MSA) | `أرغب في التحدث مع الطبيب مباشرة` | 0.97 | 0.05 | handoff | ✅ |
| direct contact (mixed) | `ممكن connect me بالدكتورة نفسها؟` | 0.96 | 0.06 | handoff | ✅ |
| contact inside booking | `عايز أكلم الدكتور الأول وبعدين نحجز` | 0.82 | 0.59 | booking (mask) | ✅ |
| contact inside booking | `عايز أحجز كشف وبعدها أكلم الدكتور` | 0.40 | 0.93 | booking (mask) | ✅ |
| booking with title | `احجزلي كشف مع دكتورة بكرة` | 0.08 | 0.97 | booking | ✅ |
| booking, named provider | `عايز الحجز مع الدكتور أحمد تحديدًا` | 0.07 | 0.82 | booking | ✅ |
| availability | `فيه دكتورة أطفال متاحة بكرة؟` | 0.09 | 0.09 | availability | ✅ |
| presence/identity | `اسم دكتور الجلدية إيه؟` | 0.04 | 0.02 | no handoff | ✅ |
| preference | `أفضل دكتورة سارة لو عندها ميعاد` | 0.13 | 0.28 | no handoff | ✅ |
| **bare ambiguity** | `محتاج دكتور` | **0.53** | 0.11 | **handoff** | ❌ should clarify |
| **meet + specialty + time** | `عايز أقابل دكتورة أطفال بكرة` | **0.40** | **0.45** | **no handoff** | ❌ should handoff |

The mask is the load-bearing structure. It held on **both** orderings of the
multi-intent pair, which is the property §7's invariants depend on: booking
presence suppresses the provider path regardless of order, and
`supportRequested` is *never* masked (the `supportRequest` disjunct is
independent, so `وصلني بموظف عشان أحجز` stays the customer's own handoff —
verified in the bank and in the shipped formula's comment).

---

## 8. Bare-ambiguity analysis

The three bare rows are minimal in the strict linguistic sense: a provider
term, a want/need/permission marker, and **nothing else** — no interaction
verb (`أكلم`, `قابل`, `تواصل`, `شوف`) and no arrangement verb (`حجز`, `ميعاد`,
`كشف`, `موعد`).

The minimal pair inside the bank proves the boundary is a real semantic
boundary and that the model finds it:

| | message | pProvider | routed |
|---|---------|-----------|--------|
| bare | `عايز الدكتور` | 0.56 | handoff (expected clarify) |
| + verb | `عايز أقابل دكتور` | **0.77** | handoff ✅ |

One word — the interaction verb `أقابل` — moves the probability by 0.21 and
moves the turn from "unresolved" to "correctly contact". The model is sensitive
to exactly the relationship the product policy cares about. It is the *outcome
space*, not the semantics, that is defective.

Three constraints any fix must satisfy, all evidenced:

1. **Do not tune the threshold.** Moving the `providerRequested` cut above
   0.61 would break `v4-hold-contact-be-connected` (0.69) and
   `v4-hold-contact-tell-doctor-self` (0.88) sits close to
   `v4-hold-mask-talk-then-book` (0.82, correctly masked). There is no cut
   point that separates 0.53/0.56/0.61 (wrong) from 0.69 (right) without
   collateral damage, and the manifest already records the formal rejection of
   this move from AI-JEV-02.
2. **Do not hand off by default.** The frozen labels assert
   `providerRequested = null` precisely because "failure to understand is not
   a handoff."
3. **Do not answer by default either.** All three rows exclude booking and
   availability, so a booking path would be equally unjustified.

Those three leave exactly one bounded option: ask once.

---

## 9. Clarify-once product analysis

### 9.1 The infrastructure already exists

This is the second decisive finding. FlowPilot already ships a first-class,
bounded clarification seam — `src/features/conversations/server/clarification.ts`
— with every property §7 invariant F requires:

| §7 invariant F requirement | existing implementation |
| -------------------------- | ---------------------- |
| at most one clarification for the same unresolved decision | `planClarification` returns a single `ClarificationPlan`; `impliedFactKey` + `missingFactsFrom` return `null` when the fact is already known — "never re-ask a fact-specific clarification whose fact the state already knows" |
| clarification state must be explicit | `ConversationState` carries the pending clarification; `clarificationForPending` re-emits only the already-recorded plan |
| the next answer should be interpreted in context | `derivePendingClarification` reconstructs the pending clarification from the persisted history, and the supplied-fact RESUME path resolves deterministically |
| do not repeatedly ask the same question | anti-repetition guard in `planClarification`; `clarificationForBookingReason` and `derivePendingClarification` never author a new question |
| explicit human request after clarification wins immediately | `NON_CLARIFIABLE_REASONS` excludes `HUMAN_REQUEST`, and the resolver applies precedence rule 2 (`EXPLICIT_HUMAN_REQUEST`) **before** rule 7 (`CLARIFY_DECISION`) |
| safety intent wins immediately | `SENSITIVE` is in `NON_CLARIFIABLE_REASONS`; precedence rule 3 (`SAFETY_RESTRICTED`) is above rule 7 |
| knowledge gap stays a handoff, not a clarify | `NO_KNOWLEDGE` is in `NON_CLARIFIABLE_REASONS` |

The resolver precedence is explicit and ordered
(`src/features/conversations/server/turn-planner.ts:132`):

```
1. CONTROL_COMMAND
2. EXPLICIT_HUMAN_REQUEST        ← beats clarify
3. SAFETY_RESTRICTED             ← beats clarify
4. DOMAIN_CONSTRAINT
5. DOMAIN_DECISION
6. PENDING_TASK_PRESERVED
7. CLARIFY_DECISION              ← reached only after 1–6 cannot fire
8. NORMAL_DECISION
```

**CLARIFY is already positioned below explicit-human, below safety, below
domain constraint and below domain decision.** It cannot override any of
invariants A–D. It is reached only as a *replacement for an ambiguous
handoff*, never as a replacement for a protected request. There is already an
evaluation-side measurement for it
(`evaluation/runner/clarify-measure.ts`, distinguishing `CLARIFY` from
`ANSWER` / `DOMAIN_ACTION` / `HUMAN_HANDOFF` / `KNOWLEDGE_GAP` /
`AI_FAILURE` / `PROVIDER_FAILURE`).

### 9.2 What the evidence adds

CLARIFY_ONCE as proposed is therefore **not a new architecture**. It is
*populating an existing seam with an existing decision class* — extending the
existing `AMBIGUOUS`-reason clarify trigger to the contact-vs-book boundary.
The new surface is bounded by construction:

- the trigger is a **semantic** condition (contact plausible ∧ booking not
  asserted ∧ no interaction verb ∧ no arrangement verb), never a lexical one;
- the outcome is an existing decision class with existing anti-repetition,
  existing resume and existing precedence guards;
- the model supplies *facts*; the server still derives the verdict and the
  resolver still owns whether a clarify fires at all.

### 9.3 The counterfactual, measured

Applying CLARIFY_ONCE to the three bare-ambiguity rows and recording the
outcome as the third decision class it is (not a handoff, not a booking):

| metric | before | after |
| ------ | ------ | ----- |
| JEV routing mismatches vs frozen expectation | 4 / 60 | **1 / 60** (M-1 remains) |
| unjustified handoffs on bare ambiguity | 3 | **0** |
| protected explicit-human requests honored | 14 / 15 | 14 / 15 (unchanged — invariant A intact; the single miss is M-1, not a protected-request regression) |
| bookings honored | all | all (unchanged — `bookingRequested` had 0 disagreements) |
| extra model calls per ambiguous turn | — | **0** (clarify is composed locally, no second round-trip) |

The one remaining error (M-1) is a confident semantic miss on a single turn,
which is measurable in production telemetry and does not compound.

---

## 10. Contrastive / minimal-pair analysis

Each pair below was evaluated against the frozen holdout-v4 evidence. The
distinguishing relationship is named, and no lexical device is proposed.

| # | pair | distinguishing semantic relationship | evidence |
| - | ---- | ------------------------------------ | -------- |
| 1 | `عايز دكتور` / `عايز أكلم دكتور` | **interaction verb presence** — `أكلم` names the *mode of resolution* (speak to); the bare form names only the *object* (a provider) | 0.56 vs 0.77+; `v4-hold-ambig-want-the-doctor` vs `v4-hold-ambig-meet-doctor` (0.77) |
| 2 | `عايز أشوف دكتور` / `عايز أحجز مع دكتور` | **arrangement verb presence** — `أحجز` makes the *appointment* the request; `أشوف` is contact-with-uncertain-arrangement | `bookingRequested` 0 disagreements; `محتاج أشوف doctor دلوقتي` → provider 0.84 handoff ✅ |
| 3 | `هل فيه دكتور متاح؟` / `ممكن توصلني بالدكتور المتاح؟` | **transfer/enablement verb** — `توصلني` requests the *act of connecting*; `فيه…متاح` queries a *property of the schedule* | availability fixtures pProvider 0.06–0.09; `عايز حد يوصلني للدكتور` → 0.69 handoff ✅ |
| 4 | `الدكتورة سارة موجودة؟` / `عايز أكلم الدكتورة سارة` | **predicate vs request** — `موجودة` is a yes/no about presence; `أكلم` is a first-person request to act | identity fixtures pProvider 0.02–0.08; contact with named provider 0.88–0.96 |
| 5 | `احجزلي عند دكتورة أطفال` / `حولني لدكتورة أطفال` | **imperative target** — `احجزلي` targets an *appointment*, `حولني` targets a *transfer of the conversation* | `احجزلي كشف مع دكتورة بكرة` 0.97 booking; `أرغب في التحدث مع الطبيب` 0.97 handoff |
| 6 | `محتاج مساعدة` / `محتاج أكلم خدمة العملاء` | **role specificity** — `خدمة العملاء` names a *non-clinical staff role* (support path); `مساعدة` is unscoped need | `supportRequested` 0 disagreements; `عايز أكلم خدمة العملاء` → support 0.97 handoff ✅ |
| 7 | `عايز أقابل دكتور بكرة` / `عايز الدكتور يكلمني بكرة` | **agency of the action** — `أقابل` has the *customer* as the actor meeting the provider; `يكلمني` has the *provider* acting on the customer (callback) | `ينفع أحكي للدكتور بنفسي؟` → 0.88 handoff; both are contact, neither is booking |
| 8 | `ممكن دكتور؟` / `ممكن أحجز مع دكتور؟` | **same permission marker, different complement** — the marker `ممكن` carries no intent; the complement (`دكتور` vs `أحجز مع دكتور`) does | `ممكن دكتور؟` pProvider 0.61 / pBooking 0.15; `ممكن تحجزلي عند أي دكتور متاح؟` pBooking 0.96 |

Two pairs deserve explicit adjudication because the brief flags them:

**PAIR 7, first half — "عايز أقابل دكتور بكرة" → adjudicated as
contact-leaning-ambiguous.** The bank contains the exact realized form
`عايز أقابل دكتورة أطفال بكرة` and it is the **one true semantic miss** (M-1):
the model read the specialty title plus the future time as book-to-see
(`conversationGoal = booking` @ 0.91) while `أقابل` alone scored 0.77 contact.
The distinguishing signal — *who is the actor of the meeting verb* — is real
but the model does not yet weight it above the arrangement reading when a
specialty and a date are present. This is a single, measurable, non-systemic
miss, and it is the reason §15 item 13 requires turn-level telemetry on the
contact-vs-book boundary.

**PAIR 7 vs PAIR 1 — the boundary is not lexical.** `أقابل` appears in both a
correctly-routed fixture (`عايز أقابل دكتور`, 0.77) and the one miss
(`عايز أقابل دكتورة أطفال بكرة`, 0.40). The same verb, opposite outcomes,
separated by *specialty + timing*. No keyword, stem list or regex can express
that; only a semantic model can, which is precisely why the lexical seam loses
19 rows. The contrastive evidence therefore **rules out lexical patching** and
confirms the semantic route.

---

## 11. Server precedence implications

The precedence formula is unchanged, unchallenged, and the strongest component
in the chain:

```
explicitHuman = supportRequest OR (providerRequest AND NOT bookingTask)
bookingTask   = bookingRequested OR availabilityAsked
               OR cancellationRequested OR rescheduleRequested
```

Findings:

1. **The mask held on every exercise.** Both multi-intent orderings, both
   masked correctly. Order-independence is verified, not assumed.
2. **`supportRequest` is never masked** — it is an independent disjunct. This
   is why invariant A survives: `وصلني بموظف عشان أحجز` and
   `عايز حد من الاستقبال يحجزلي` both route to handoff despite a booking stem
   (verified: `v4-hold-support-reception-book` → support 0.94 → handoff ✅,
   even though its `conversationGoal` is `booking` @ 0.51).
3. **The formula, not the goal field, owns the verdict.** The three
   `provider-identity` rows chose goal `human_handoff` at 0.47–0.66 and still
   routed correctly because `providerRequested` was 0.04–0.08. The goal field
   and the fact field are independent channels, and the formula reads only the
   facts. JEV must keep supplying facts, never verdicts.
4. **No precedence change is needed for CLARIFY_ONCE.** Clarify is a *new
   outcome for an unresolved fact combination*, not a new precedence rule. It
   slots into the existing rule 7 position, already below rules 2–5. The
   formula itself stays byte-identical; what changes is which fact
   combinations are allowed to reach it without first being forced to
   true/false.
5. **The derivation stays server-owned.** The evaluation copy
   (`applyServerPrecedence`) exists *to prove* the production formula is
   unchanged — it is a deliberate copy, never imported by `src/`, and
   `check:jev-strategy` A9 confirms the JEV module adds no second resolver,
   judge or classifier.

---

## 12. 0/1-call invariant implications

The invariant is **intact and verified**, not merely proposed:

- The benchmark plans **exactly one** request per fixture
  (`plannedRequestCount` = fixture count, no per-question or per-class
  multiplication). The artifact's ledger confirms `attempts: 1` on all 60
  rows, `requests.retries = 0`, and 60 executed = 60 planned.
- `check:jev-strategy` B6 asserts it directly on a mixed 7-turn corpus:
  provider calls == GENERATIVE decisions (4), no multi-call turn.
- `check:jev-strategy` C9 asserts the end-to-end engine version: bypass turn =
  0 calls, generative turn = 1 call, never 2.
- A9 asserts the JEV module "adds no second resolver/judge/classifier
  (contract + classifier only; `decide` is synchronous)."

**CLARIFY_ONCE adds zero calls.** The clarification question is composed
locally from a fixed template inside the existing turn
(`planClarification` is pure and total — no I/O, no network, no DB, no
provider, no model inference). The next customer turn is then interpreted by
the *same* single JEV pass, in context, via the existing
`derivePendingClarification` + supplied-fact resume path. There is no
classifier → JEV → LLM → judge pipeline and none is proposed.

The proposed design must therefore be evaluated as a **replacement of an
existing decision seam**, not an additional stage: JEV supplies the
semantic facts that today's lexical detector derives from keyword tables, the
precedence formula stays, and the clarify outcome reuses the existing
decision class. Net model calls per turn: 0 or 1, unchanged.

---

## 13. Regression / architecture verification — offline only

Every check below was executed by this task. All green. None was weakened,
modified or skipped.

| check | command | result |
| ----- | -------- | ------ |
| JEV strategy | `pnpm check:jev-strategy` | **28 / 28 passed** — includes A9 (no second resolver), B2 (exactly one provider call), B3 (provider failure not masked, one attempt), C4/C5 (human + safety precedence preserved), C9 (0/1-call), C10 (no JEV metadata in the customer reply) |
| JEV evaluation | `pnpm check:jev-eval` | **136 / 136 checks ok** — includes R4 (a retired bank is refused before any network invocation, fetch count 0), R6 (fingerprint change hard-stops before any call), J19l (no lexical dictionary / stem list / regex in the contract), J20b (holdout-v4 is id- and message-disjoint), J20j (the freeze manifest binds the live fingerprint) |
| Turn Planner | `pnpm check:turn-planner` | **41 / 41** (Arabic-language suite) |
| AI architecture | `pnpm check:ai-architecture` | **25 / 25** — includes 23 (0/1-call invariant) and 25 (no production import of evaluation files) |
| Turn evidence | `pnpm check:turn-evidence` | **45 / 45** |
| Clarify (Slice 4) | `pnpm check:clarify` | **27 / 27** — the existing clarify state machine is verified green |
| Security | `pnpm security` | no secrets, credentials, or env files at risk |
| Full quality gates | `pnpm verify` (lint + typecheck + format + build) | **PASSED ✅** |
| Unit tests | `npx vitest run` | 1 file, **10 / 10** passed |
| Whitespace / conflict | `git diff --check` | exit 0 |

**Hard-rule compliance, verified after the fact:**

- **No live provider/model call.** No `eval:jev`, no OpenRouter, no TypeSafe,
  no chat-completions. The only network-adjacent code exercised was importing
  pure local functions from committed source. Both sealed banks were confirmed
  refused at the retirement denial gate.
- **No sealed holdout executed or re-exposed.** holdout-v3 (`SEAL_BROKEN`) and
  holdout-v4 (`COMPLETED`) both return a denial from
  `bankExecutionDenial` before any fetch could be constructed.
- **No holdout-v5 created.** The fixture bank is byte-identical to `2ffc7bc`
  (all nine fingerprint bindings in §2.2 recompute identically).
- **No production/runtime change.** `src/` is untouched; `git status` reports
  zero modified paths at exit. The shipped `detectExplicitHumanRequest` was
  *read and evaluated*, never edited.
- **No contract / policy / label / fixture tuning against holdout-v4.** The
  contract, policy, all six slice fingerprints and every fixture label are
  unchanged — mechanically proven by §2.2.
- **No commit, push, tag, release or deployment.** `git log` is unchanged;
  the tag list is unchanged; no `pnpm ship` was run.

---

## 14. Final eligibility verdict

### A) READY_FOR_AI_JEV_03_DESIGN

The evidence is sufficient to **design** a bounded, rollback-friendly
Production integration. Answering each gate question from §9 of the brief:

| question | answer from evidence |
| -------- | -------------------- |
| Are the remaining failures concentrated and understandable? | **Yes.** 4 routing errors in 60. 3 are one phenomenon (bare contact-vs-book ambiguity, probabilities 0.53–0.61); 1 is a single semantic miss (M-1). 50/60 fixtures fully exact; `bookingRequested` and `supportRequested` have **zero** disagreements. |
| Is there evidence of broad/systemic semantic failure? | **No.** 52/60 rows sit outside the 0.2–0.8 probability band entirely. `conversationGoal` confidence is high (median 1.0 on handoff). The model separates all four distinctions in §6.3 cleanly. |
| Can explicit human requests remain protected? | **Yes, and better than today.** JEV honors 14/15 direct-contact turns and 6/6 explicit-human turns. The shipped lexical seam fails 8 protected-request turns (§6.1), including 4 English/mixed contact turns it cannot see at all. |
| Can booking remain protected? | **Yes, strongly.** `bookingRequested`: 0 disagreements across 60 rows. Both multi-intent mask orderings held. Provider titles inside bookings score 0.04–0.16. |
| Can ambiguity be routed into bounded clarification rather than automatic escalation? | **Yes.** The seam already exists with every invariant-F property (§9.1), and CLARIFY_ONCE reduces routing mismatches 4 → 1 with zero extra model calls (§9.3). |
| Can server precedence remain authoritative? | **Yes.** No mismatch is cause C. The formula held on every exercise; the goal field is provably non-authoritative; clarify slots into the existing precedence rule 7 without touching rules 1–6. |
| Can the 0/1-call invariant remain intact? | **Yes.** Verified by B6/C9/A9 today; clarify composes locally with no second round-trip (§12). |
| Can the integration replace an existing decision seam rather than adding a mandatory new model stage? | **Yes — and this is the strongest argument.** The replaced seam is `detectExplicitHumanRequest`'s lexical fact derivation (title-word ∧ request-cue, plus four stem tables), which scores **41/60** against the frozen expectations versus JEV's **56/60**. JEV is a strictly better implementation of the same three facts. |
| Are known errors measurable after integration? | **Yes.** M-1 is a single named turn type with a distinct signature (interaction verb + specialty + future time, goal `booking` ≥ 0.9, pProvider < 0.5). The existing clarify measurement (`clarify-measure.ts`) already distinguishes CLARIFY from HUMAN_HANDOFF. |
| Can the design be disabled/rolled back cleanly? | **Yes.** The seam is one pure function behind one precedence rule. `check:jev-strategy` B4 already verifies the exact fallback: `decisionStrategy` absent → prior behaviour, deterministic-bypass label, one call on a generative turn. Rollback is "stop supplying JEV facts; the lexical derivation resumes." |

**What this verdict explicitly does NOT mean:** Production implementation is
not approved, Production routing is not enabled, JEV is not perfect, and the
remaining errors are not ignored. M-1 stays open, the §16 limitations stay
open, and every constraint in §15 is binding on the design task.

---

## 15. AI-JEV-03 design contract — PROPOSED, NOT IMPLEMENTED

This is a specification for the next task. Nothing below is implemented here.

### 15.1 The decision seam JEV may replace

JEV may replace the **fact derivation** inside
`src/features/conversations/server/conversation-ai.ts` — specifically the
lexical derivations feeding `ExplicitHumanRequest`
(`detectExplicitHumanRequest:553`) and `TurnControlSignals`
(`detectTurnControlSignals:581`): `supportRequest`, `providerRequest`,
`bookingTask`, and the `sensitive` / `nonCommittal` control signals. Those
facts are today produced by normalized keyword tables
(`HUMAN_WORDS`, `HUMAN_TITLE_WORDS`, `HUMAN_REQUEST_CUES`, `HUMAN_PHRASES`,
`BOOKING_WORDS`, `AVAILABILITY_WORDS`, `CANCELLATION_WORDS`,
`RESCHEDULE_MUTATION`, `SENSITIVE_WORDS`).

JEV supplies the same facts semantically. **The precedence formula, the
verdict and the control-signal contract do not change.** Nothing else in the
decision path is in scope.

### 15.2 What JEV is forbidden from owning

JEV must not: perform a booking; perform a handoff; write to the DB or mutate
any schema; send any customer-visible message; mutate domain state; choose a
response; invoke the Turn Planner; re-resolve a decision the engine already
made (`check:jev-strategy` C7b); emit any metadata into the customer reply
(C10); or own any precedence between the facts it reports. JEV reports facts;
exactly one server-owned location derives the verdict from them.

### 15.3 Explicit-human precedence

`explicitHuman = supportRequest OR (providerRequest AND NOT bookingTask)`
stays server-owned and byte-identical. `supportRequest` remains an
independent, **never-masked** disjunct, so a support-role request survives a
booking stem on the same turn. A clear "عايز أكلم موظف" must not be blocked by
the presence of another intent — enforced by precedence rule 2 sitting above
every domain rule. A model-supplied human claim fires too, except during a
pending task where it is treated as a benign interruption (existing rule 6
behaviour, unchanged).

### 15.4 Safety precedence

Safety stays above ordinary domain routing (precedence rule 3, above rules
4–8) and stays **deterministic and authoritative** — never model-trusted. A
sensitive turn hands off even when the model proposed a clarification
(existing `SENSITIVE` handling, unchanged). Safety is not gated by the booking
task: a medical booking with «ألم شديد» is still a safety turn.

### 15.5 Booking-vs-contact behaviour

A booking stem **masks** the provider path, order-independently, on both
`bookingRequested` and the `availabilityAsked` family. A provider title inside
a booking is a *preference*, not a handoff request. A provider title plus a
booking verb must never produce a handoff. Contact-after-booking and
contact-before-booking both resolve to booking. Booking protection is the
strongest measured property in the evidence (`bookingRequested`: 0 / 60
disagreements) and must not be weakened to fix M-1.

### 15.6 Availability-vs-contact behaviour

Availability, presence and provider-identity questions do not by themselves
mean contact: `pProvider` must stay low on turns whose mode is a query about
the schedule or the practitioner's identity. A *transfer or enablement verb*
(`وصلني`, `حوّلني`, `connect me`) or an *interaction verb* (`أكلم`, `أقابل`,
`أشوف`, `be seen by`) is what promotes a provider mention into a contact
request. The design must preserve the observed separation: availability
fixtures `pProvider` 0.06–0.09, contact fixtures 0.69–0.98.

### 15.7 Ambiguity behaviour

Bare provider need — a provider term with a want/need/permission marker and
**no interaction verb and no arrangement verb** — must resolve to neither
automatic booking nor automatic handoff. Its permitted outcomes are exactly:
`CLARIFY` (first), or the current default if a clarify is not available. Low
confidence on any routing fact must not by itself produce a handoff. A
probability in the 0.4–0.6 band on the contact fact, with no booking-family
fact asserted, is the canonical clarify trigger. **Thresholds must not be
tuned to resolve this** (§8 constraint 1); the third outcome is the fix.

### 15.8 CLARIFY_ONCE behaviour

Populate the **existing** seam; do not build a second one.

- **Trigger:** semantic only. Contact plausible ∧ no booking-family fact
  asserted ∧ no interaction verb ∧ no arrangement verb. Never lexical.
- **Emission:** exactly one `ClarificationPlan` via the existing
  `planClarification`; the question is a fixed, knowledge-free template that
  names no service, price, slot, provider or policy fact.
- **At most one clarification per unresolved decision.** The existing
  anti-repetition guard applies: a fact-specific clarify whose fact is already
  known returns `null` and the pending task resumes instead.
- **Explicit state.** The pending clarification is recorded in
  `ConversationState`; `clarificationForPending` may only re-emit the
  already-recorded plan, never author a new one.
- **Contextual interpretation of the answer.** The next turn is read against
  `derivePendingClarification` and the supplied-fact resume path, so the
  customer's answer is interpreted in the context of the question that was
  asked.
- **No repetition.** Never ask the same unresolved question twice. A supplied
  fact resolves it deterministically.
- **Explicit human wins immediately.** `HUMAN_REQUEST` is in
  `NON_CLARIFIABLE_REASONS` and precedence rule 2 sits above rule 7.
- **Safety wins immediately.** `SENSITIVE` is in `NON_CLARIFIABLE_REASONS` and
  precedence rule 3 sits above rule 7.
- **Knowledge gap stays a handoff.** `NO_KNOWLEDGE` is in
  `NON_CLARIFIABLE_REASONS` — asking cannot cure a missing business fact.
- **No new precedence rules.** Clarify occupies the existing rule 7 slot,
  reached only after rules 1–6 cannot fire.

### 15.9 0/1-call invariant

Exactly one JEV pass per turn, or zero on a deterministic bypass. No
classifier → JEV → LLM → judge chain, no mandatory second semantic model, no
clarification round-trip. The clarification is composed locally in the same
turn; the customer's answer is handled by the next turn's single pass. Must
remain verifiable by the existing B6 / C9 / architecture-23 checks.

### 15.10 Turn Planner authority

The Turn Planner remains the action authority. JEV supplies semantic facts;
the resolver owns the decision class, the precedence and every action. JEV
must not directly perform booking, handoff, DB mutation, customer send or any
domain mutation (`check:jev-strategy` C7 / C7b / C8 / C10).

### 15.11 Server-owned final routing formula / derivation boundary

The routing verdict stays derived in exactly one server-owned location from
the three normalized facts. JEV may supply the facts but must never supply the
verdict, and the evaluation copy (`applyServerPrecedence`) must remain a
deliberate, never-imported copy whose purpose is to prove the production
formula is unchanged. Any proposed change to the formula is out of scope for
AI-JEV-03 and requires a new architecture decision plus a new frozen manifest
entry.

### 15.12 Rollback mechanism

Feature-gated by a single `decisionStrategy` switch, with the existing
verified fallback (`check:jev-strategy` B4): strategy absent → prior
behaviour, deterministic-bypass label, lexical fact derivation resumes, one
call on a generative turn. Rollback must require no migration, no schema
change and no deploy-coordination, and must be reversible by configuration
alone. Shadow-mode disable is the same switch.

### 15.13 Required telemetry

Per-turn, sampled deterministically by conversation id, with no customer
content and no credential:

1. the resolved `decisionStrategy` and whether JEV facts were used;
2. each routing-relevant fact, its raw probability, its derived confidence
   band, and the threshold decision;
3. the three precedence inputs (`supportRequest`, `providerRequest`,
   `bookingTask`) and the derivation string actually produced;
4. `conversationGoal` and its confidence (kept as an *independent,
   non-authoritative* channel — §11 finding 3);
5. whether a `CLARIFY` fired, its type, and whether it was an anti-repetition
   suppression or a resume;
6. a **contact-vs-book boundary flag** covering the interaction-verb /
   arrangement-verb / specialty-plus-time shape, so M-1-class misses are
   measurable in production rather than only in a sealed bank;
7. the **false-handoff counter must include rows whose expected contact fact
   was unasserted**, fixing the `routingFalseHandoff` undercount identified in
   §5.1 — a handoff on an unresolved contact fact must be visible;
8. provider attempt count per turn (the 0/1-call invariant), latency, error
   code, and the served model snapshot;
9. the fallback reason when JEV facts are unavailable.

### 15.14 Shadow / evaluation strategy before wider enablement

Ship behind the strategy switch in shadow mode: JEV facts are computed and
telemetry is recorded, but the shipped lexical derivation still owns the
verdict. Score the shadow against a **fresh, disjoint** holdout (§16) plus
production-derived turn evidence, using the existing
`clarify-measure.ts` decision-class vocabulary. Widen only when (a) routing
agreement meets the frozen expectation on the new slice, (b) the
false-handoff counter including unasserted-contact rows is at or below the
holdout-v4 rate, and (c) the 0/1-call and safety/human precedence checks
remain green. Never score against, or tune anything against, holdout-v4 — it
is spent evidence.

### 15.15 Failure behaviour

| failure | required behaviour |
| ------- | ------------------ |
| JEV credential missing | fail closed to the verified fallback (B4): lexical fact derivation resumes, deterministic-bypass label, one call on a generative turn. No handoff, no customer-visible difference, no retry loop. |
| JEV request fails | response null, failure **not masked** (B3), exactly one attempt, JEV does not retry; the turn resolves through the same single authoritative path with lexical facts. |
| JEV response invalid | rejected at the contract boundary; treated as unavailable, same fallback as a failed request. Never coerce a malformed value into a fact. |
| confidence insufficient | the turn takes the **unresolved** path — clarify where the ambiguity conditions of §15.7 hold, otherwise the existing default. Never a handoff by default, and never a booking by default. |
| semantics remain ambiguous after one clarify | resolve through the existing precedence with the facts available; do **not** re-ask. The clarify budget for the same unresolved decision is one. |

---

## 16. Evidence limitations — what stays open

These do not block the design, but the design must not paper over them.

1. **M-1 is unresolved.** "عايز أقابل دكتورة أطفال بكرة" is a confident
   semantic miss (`conversationGoal = booking` @ 0.91, pProvider 0.40). The
   same verb routes correctly without a specialty and a date. The evidence
   shows the failure exists and is isolated; it does not show how to fix it,
   and §8 forbids threshold tuning as the fix.
2. **One sealed slice, one model snapshot.** All 60 rows come from a single
   pass of `typesafe/jev-1.13-20260917`. There is no variance estimate and no
   cross-model comparison; a model-served-snapshot change would be a new
   candidate requiring a new frozen manifest entry.
3. **Seven optional classes are empty** (`missingClasses`, §2.5). The
   material ones for this design are `sensitive-plus-booking` (safety + a
   booking stem on one turn — the invariant-B interaction, unmeasured) and
   `non-attendance-cancellation` / `non-attendance-reschedule` (mutation-family
   masking beyond the two single fixtures present).
4. **The clarify surface is measured by frozen label, not by observed
   behaviour.** The bank records that the three bare rows *should* clarify;
   no live run has observed a CLARIFY emitted on them. The claim that the
   existing seam handles them is structural (§9.1), not behavioural.
5. **`routingFalseHandoff` undercounts** because it requires an asserted
   expected contact fact (§5.1). Reported as `0`; the true count on this
   evidence is 3.
6. **Single-turn only.** Every fixture is one isolated turn with no
   conversation history. The contextual-interpretation requirement of §15.8
   (reading an answer against the question that was asked) is unmeasured
   here, and so is the resume path.
7. **Contrastive pairs in §10 are analytic, not all measured.** Pairs whose
   exact messages exist in the bank are evidenced; the remainder are
   adjudicated from the relationships the bank does measure. They must be
   scored against fresh evidence before enablement.
8. **One clinic context.** All fixtures share one synthetic dental-clinic
   context. Multi-specialty or non-clinical businesses are unmeasured.
9. **The shipped-seam comparison (§6.1) is offline and structural.** It runs
   the pure local lexical detector over the frozen expectations. It is not a
   production-behaviour measurement, and it does not capture downstream
   effects beyond the explicit-human verdict.

**Smallest next evidence slice (only if the design needs it, and only if a
future task authorizes it):** a fresh, id- and message-disjoint holdout of
≥ 40 fixtures covering (a) the interaction-verb × specialty × timing cube
that produces M-1, (b) `sensitive-plus-booking`, (c) bare-ambiguity rows
paired with the *observed* CLARIFY outcome rather than the expected label,
and (d) two-turn clarify-answer sequences. **holdout-v5 is NOT created by
this task and holdout-v4 must never be re-executed.**

---

## 17. Files changed by this task

| path | change |
| ---- | ------ |
| `evaluation/reports/jev/AI-JEV-02B-R3-FINAL-ADJUDICATION.md` | **created** — this report |

That is the only repository change. Every analysis script lived outside the
working tree at `/tmp/opencode/jev-r3/` (`verify-r3.ts`, `pairs.ts`,
`shipped-seam.ts`, `final.ts`, `routing-mismatches.json`) and is not part of
the repository.

**Nothing else was touched:** no evaluation contract, no probability policy,
no fixture bank, no fixture label, no expectation, no example, no runtime
code, no test, no schema, no migration, no config, no prompt template.

---

## 18. Side-effect accounting

| side effect | count | expected |
| ----------- | ----- | -------- |
| live JEV calls | **0** | 0 |
| OpenRouter / provider calls | **0** | 0 |
| credits consumed | **0** | 0 |
| DB writes | **0** | 0 |
| migrations / schema changes | **0** | 0 |
| booking mutations | **0** | 0 |
| customer messages sent | **0** | 0 |
| Production source files modified | **0** | 0 |
| evaluation contracts / policies / labels modified | **0** | 0 |
| tests weakened or modified | **0** | 0 |
| holdouts created (v5) | **0** | 0 |
| holdouts executed or re-exposed | **0** | 0 |
| git commits | **0** | 0 |
| pushes | **0** | 0 |
| tags | **0** | 0 |
| releases | **0** | 0 |
| deployments | **0** | 0 |
| `pnpm ship` invocations | **0** | 0 |
| **files changed** | **1** (this report) | 1 |

`git status` at task exit: clean. `git log` HEAD: `2ffc7bc` (unchanged). Tag
list: `v0.44.7` latest (unchanged).

---

## 19. HARD STOP

The verdict is **A) READY_FOR_AI-JEV-03-DESIGN** with the §15 contract binding.

AI-JEV-03 is **not started**. holdout-v5 is **not created**. No live JEV call
was made. Nothing was committed, pushed, tagged, released or deployed.

The human reviews the verdict first.
