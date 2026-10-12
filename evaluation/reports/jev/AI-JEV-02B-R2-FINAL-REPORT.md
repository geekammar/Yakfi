# PROMPT-AI-JEV-02B-R2 — SEALED HOLDOUT-V4 ONE-PASS + FINAL ELIGIBILITY VERDICT

> ┌────────────────────────────────────────────────────────────────────────┐
> │ EVALUATION / REPORTING ONLY. Contains NO secret values.                │
> │ No `OPENROUTER_API_KEY`, no credential, no Authorization header, no PII │
> │ appears anywhere below. Nothing in `src/` imports this file or anything │
> │ it describes.                                                         │
> │                                                                        │
> │ LIVE JEV CALLS MADE BY THIS PROMPT: **0**                             │
> │ Both runner invocations were refused at the retirement denial gate     │
> │ (exit 4) before any fetch was constructed. Zero network I/O.          │
> └────────────────────────────────────────────────────────────────────────┘

**Task**   PROMPT-AI-JEV-02B-R2 — execute the sealed holdout-v4 one-pass and
           deliver the final eligibility verdict.
**State**  Entry gate FAILED on three independent items. Holdout-v4 was
           already executed to completion by the interrupted AI-JEV-02B-R
           session; the seal is spent and the runner refuses re-execution.
**Verdict** **C) BLOCKED_EXECUTION_INTEGRITY** (§16) — returned without a
           single live provider call, exactly as §0 demands on any gate
           failure.
**Authored** 2026-10-12, AI-JEV-02B-R2 session.

---

## 0. ENTRY GATE — the verdict that decided everything

§0 of the prompt is explicit and disjunctive-by-failure: **if ANY listed item
fails, do not call JEV, return C) BLOCKED_EXECUTION_INTEGRITY and stop.** Every
item below was independently verified against live source and current
repository state — none was trusted from the R1 handoff's prose.

| # | §0 required item | independently verified value | verdict |
| - | ---------------- | ---------------------------- | ------- |
| 1 | previous durable verdict is `READY_FOR_HOLDOUT_V4_ONE_PASS` | R1 §3 verdict is **`HOLDOUT_V4_ALREADY_COMPLETED`** | **FAIL** |
| 2 | holdout-v4 exists and is frozen | exists; 60 fixtures; `sha256:7e96dd7d89409647` | PASS |
| 3 | holdout-v4 fixture count >= 40 | **60** | PASS |
| 4 | holdout-v4 **exposure count = 0** | **exposure = 60** (retirement register `exposedRows: 60`) | **FAIL** |
| 5 | no complete/partial/live artifact contains holdout-v4 result rows | one `COMPLETE` artifact contains **all 60** rows | **FAIL** |
| 6 | holdout-v4 fingerprint matches frozen handoff | recomputed live = `sha256:7e96dd7d89409647` = frozen | PASS |
| 7 | contract fingerprint matches | `sha256:588222a74f4a356b` recomputed from `jevQuestionSet()` | PASS |
| 8 | policy fingerprint matches | `sha256:a01c368d17e5629e` recomputed | PASS |
| 9 | requested model still `typesafe/jev-1.13` | pinned in manifest; artifact records same | PASS |
| 10 | working candidate has not drifted since R1 | all four fingerprints recompute identical to R1's recorded values | PASS |
| 11 | holdout-v3 remains `SEAL_BROKEN` and non-runnable | `bankIsExecutable("holdout-v3") === false`; runner exits 4, 0 fetches | PASS |

**Three items fail (1, 4, 5).** Items 4 and 5 are the load-bearing pair: the
sealed holdout is not an unexposed bank waiting for its one pass — it is a
**spent** seal that already produced its one immutable artifact. A single
failure would have been sufficient for the hard stop; three independent
failures removes any ambiguity.

Therefore, per §0: **no JEV call was made, and this report returns
C) BLOCKED_EXECUTION_INTEGRITY.**

---

## 1. Repository identity (recomputed, not assumed)

| item | value |
| ---- | ----- |
| branch | `main` |
| HEAD | `5c8eaf9578222eba6f7e5cce6108d74c05a8298a` |
| origin/main | `5c8eaf9578222eba6f7e5cce6108d74c05a8298a` (equal) |
| package.json version | `0.44.6` |
| latest release tag | `v0.44.6` |
| staged files | 0 |
| `src/` files modified | **0** |
| working tree | 4 modified + 17 untracked (21 paths; `pre-ship` agrees) |

Nothing was reset, stashed, cleaned, restored, rebased or committed by this
prompt.

---

## 2. R1 handoff verification — claims reproduced from live source

The R1 handoff was read and its material claims were each re-derived rather
than trusted. The verification script lived **outside** the working tree at
`/tmp/opencode/verify-r2.ts` and imported the repository modules directly.

| R1 claim | independent recompute | holds? |
| -------- | --------------------- | ------ |
| contract fp `sha256:588222a74f4a356b` | `contractFingerprint(jevQuestionSet())` → same | ✓ |
| policy fp `sha256:a01c368d17e5629e` | `policyFingerprint()` → same | ✓ |
| freeze manifest fp `sha256:e8031b1f40777359` | `freezeManifestFingerprint()` → same | ✓ |
| holdout-v4 = 60 fixtures, `sha256:7e96dd7d89409647` | `sliceFingerprint(JEV_HOLDOUT_V4_FIXTURES)` → same | ✓ |
| all six slice fingerprints frozen | `sliceFingerprints()` → all six identical | ✓ |
| `verifyFreezeManifest` over the artifact's recorded state → 0 problems | **0** | ✓ |
| `bankIntegrity(JEV_FIXTURES_V3)` (160) ok | `{"ok":true,"problems":[]}` | ✓ |
| `bankIntegrity(JEV_FIXTURES_V4)` (220) ok | `{"ok":true,"problems":[]}` | ✓ |
| holdout-v4 disjoint from all five prior slices (id and message) | **0 / 0 / 0 / 0 / 0** both axes | ✓ |
| no duplicate ids / messages inside holdout-v4 | 0 / 0 | ✓ |
| holdout-v3 retired `SEAL_BROKEN`, non-executable | `bankIsExecutable` → false; exit 4 | ✓ |
| holdout-v4 retired `COMPLETED`, non-executable, scorable | register + exit 4 confirm | ✓ |
| no `.partial.json` left on disk | 0 found anywhere in the tree | ✓ |

**Every verifiable R1 claim reproduces.** The R1 handoff is accurate. Its
central finding — that the interrupted R session completed holdout-v4 — is
confirmed, and it is precisely that finding which blocks this prompt.

### 2.1 The mtime anomaly is benign (re-verified)

`jev-fixture-bank.ts` (mtime 18:56:58) was touched ~11 min **after** the
holdout-v4 artifact (started 18:46:13). R1 attributed this to a
content-preserving edit. This prompt re-derived the fingerprint from the
current file and obtained `sha256:7e96dd7d89409647` — the frozen value — so the
touch did not alter any fixture, label or ordering. The freeze binding is
intact. The candidate has **not** drifted since R1 (§0 item 10, PASS).

---

## 3. Exposure audit before execution (§2, all offline, zero network)

Performed across every artifact, the retirement register and the runner's own
denial gate — before any work that could reach a provider.

| evidence sought | finding |
| --------------- | ------- |
| artifacts whose `bank` is `holdout-v4` | **1** — `jev-benchmark-holdout-v4-live-live-2026-10-12T18-46-13-847Z-393e6c.json` |
| that artifact's `mode` | **`"live"`** (real calls) |
| `plannedRequests` / `executedRequests` | **60 / 60** |
| `plannedFixtureCount` / `completedFixtureCount` | **60 / 60** |
| `notRequestedFixtureIds` / `failedFixtureIds` | `[]` / `[]` |
| holdout-v4 ids occurring in ANY report JSON on disk | **60 occurrences, all in that one artifact**; **0** in any other |
| artifact rows vs live bank ids | set-equal both directions (in-art-not-in-live = 0; in-live-not-in-art = 0); 60 unique |
| `artifactStatus` / `COMPLETE` / `SCORABLE` / `interrupted` | `COMPLETE` / **true** / **true** / false |
| `finalization` | `{ok: true, reason: null}` |
| `secretScan` | `{scanned: true, probes: 13, hits: []}` |
| `freeze.mismatches` | `[]` |
| `.partial.json` files anywhere in the tree | **0** |
| holdout-v3 artifacts on disk | **0** (seal left no valid artifact — consistent with `SEAL_BROKEN`) |

**Exposure count for holdout-v4 is 60, not 0.** The exposure the prompt's §0
requires to be absent is not merely present — it is *complete, validated and
immutable*.

### 3.1 Authenticity of the existing artifact (why it cannot be ignored)

The artifact is not a stray or a fabrication; it is internally consistent in
ways that are expensive to fake:

- **Timing arithmetic.** Wall clock 11 023 ms vs the sum of per-call latencies
  10 832 ms (ratio 1.018) — exactly what 60 sequential ~181 ms calls with small
  bookkeeping overhead should look like.
- **Aggregates recompute from rows.** input tokens 208 719, output 18 985, cost
  $0.008 766 198 — all three recomputed from the 60 rows and matching the
  artifact's totals to floating-point precision.
- **Provider profile is realistic.** served model `typesafe/jev-1.13-20260917`,
  provider `TypeSafe`, per-call input 3 462–3 489, output 315–318, latency
  146–307 ms, per-call cost ≈ $0.000 145–146 — consistent with the 13 other
  genuine live artifacts in the directory.
- **Results are deliberately non-idealized.** 50/60 exact, 12 disagreements,
  the model flagging its own ambiguity (`ambiguousTurn` 0.21–0.49).

Because the measurement is genuine and complete, **the honest remedy is not to
re-run it** — re-running would re-expose 60 sealed fixtures and would itself be
the integrity violation §5 guards against.

---

## 4. The one-pass attempt — refused before any network I/O

§4 instructs to run the exact R1-recorded command. Both forms were executed;
**both were refused at the retirement denial gate before any fetch was
constructed** (`assertBankExecutable` fires ahead of adapter construction):

```
$ pnpm eval:jev -- --live --bank holdout-v4 --write-artifact
HARD STOP: bank 'holdout-v4' is COMPLETED and cannot be executed: completed
first sealed execution (one immutable artifact persisted) (exposed 60 of 60
planned rows; 0 never requested; eligibleForExecution=false,
eligibleForScoring=true)
[ELIFECYCLE] Command failed with exit code 4.
```

```
$ pnpm eval:jev -- --bank holdout-v4
HARD STOP: bank 'holdout-v4' is COMPLETED and cannot be executed: …
[ELIFECYCLE] Command failed with exit code 4.
```

`fetch` attempts: **0** in both cases. The guard is mode-agnostic — "a retired
bank may not be executed at all" — so the live path is necessarily covered.

**§3 execution budget was therefore never printed as a pre-network statement,
because the planned-exposure precondition (exposure = 0) was already false.**
There was no budget to state: the run was not eligible.

---

## 5. Frozen fingerprints (recomputed from live source)

| artifact | value |
| -------- | ----- |
| question contract id | `flowpilot.jev-questions@v3` |
| contract fingerprint | `sha256:588222a74f4a356b` |
| probability policy id | `flowpilot.jev-policy@v2` |
| policy fingerprint | `sha256:a01c368d17e5629e` |
| requested model | `typesafe/jev-jev-1.13` → `typesafe/jev-1.13` (pinned) |
| freeze manifest fingerprint | `sha256:e8031b1f40777359` |

| slice | n | fingerprint |
| ----- | - | ----------- |
| `original` | 40 | `sha256:69341a65821179a9` |
| `calibration` | 26 | `sha256:8a76f9e4deeb94f8` |
| `holdout` | 20 | `sha256:d3f4a90715c80066` |
| `calibration-v3` | 27 | `sha256:29a8d48d1e244ee0` |
| `holdout-v3` | 47 | `sha256:1d659cc4d188bf56` (RETIRED, SEAL_BROKEN) |
| `holdout-v4` | **60** | `sha256:7e96dd7d89409647` (RETIRED, COMPLETED) |

**No semantic surface was touched by this prompt** (§1): contract, policy,
labels, examples, thresholds, question definitions, classification semantics
and server-precedence reproduction are all byte-identical to the state R1
verified. Six slice fingerprints unchanged; `git diff --check` clean.

---

## 6. Planned / executed provider-call count

| | |
| --- | --- |
| planned by this prompt | **0** (the run was refused; no budget was authorized) |
| executed by this prompt | **0** |
| executed by the interrupted R session (18:46Z, pre-R2) | 60 — the one permitted pass, already spent |
| total live JEV calls attributable to PROMPT-AI-JEV-02B-R2 | **0** |

§13's constraint — "live JEV calls from this prompt must equal exactly the
planned count" — holds trivially at 0 = 0. No fixture was exposed by this
session.

---

## 7. Complete-artifact integrity (of the pre-existing artifact)

| required check | result |
| -------------- | ------ |
| planned === executed | 60 === 60 ✓ |
| failed === 0 | 0 ✓ |
| unique result rows === planned | 60 unique === 60 ✓ |
| all expected fixture ids present | set-equal both directions ✓ |
| no duplicate fixture ids | 0 duplicates ✓ |
| `COMPLETE` | true ✓ |
| `SCORABLE` | true ✓ |
| `interrupted` / `resumeAllowed` | false / false ✓ |
| bank / contract / policy fingerprints | all three match live recompute ✓ |
| requested model | `typesafe/jev-1.13` ✓ |
| served model | `typesafe/jev-1.13-20260917` ✓ |
| timestamps coherent | 18:46:13.847Z → 18:46:24.870Z ✓ |
| no secret serialization | 13 probes, **0 hits**; no `OPENROUTER_API_KEY`, `Authorization`, `Bearer` or credential value present ✓ |
| unexpected PII | none — all fixtures are repository-authored synthetic Arabic/English clinic turns ✓ |

The credential was never printed. The artifact's `credentialPresent: true`
field is a **boolean** recording only that an env var existed at run time
(`eval-jev-benchmark.ts:1311`); no value is ever serialized.

---

## 8. Holdout-v4 metrics — recomputed from artifact ROWS

Not trusted from R1's prose; every figure below was re-derived from the 60 row
objects.

| metric | value |
| ------ | ----- |
| fixtures | 60 |
| planned / executed | 60 / 60 |
| failed | 0 |
| fixture exact agreement | **50/60** |
| scored question count | 220 |
| question agreement | **208/220** |
| question disagreements | 12 |
| **final routing accuracy** | **56/60** |
| latency min / p50 / p95 / max / mean | 146 / 175 / 220 / 307 / 180.53 ms |
| input tokens | 208 719 |
| output tokens | 18 985 |
| total cost | $0.008 766 198 |
| average cost per fixture | $0.000 146 103 |
| goal distribution | human_handoff 22 · booking 18 · availability 9 · service_info 4 · greeting 3 · ambiguous 2 · cancellation 1 · reschedule 1 |

Fact-level FP/FN (recomputed from `factErrors`):

| fact | false positives | false negatives |
| ---- | --------------- | --------------- |
| providerRequested | 0 | 2 |
| providerPreferenceExpressed | 3 | 1 |
| availabilityAsked | 2 | 3 |
| serviceOrPriceAsked | 1 | 0 |
| supportRequested | 0 | 0 |
| bookingRequested | 0 | 0 |
| availabilityAsked (as a ratio) | — | — |

### 8.1 Every important disagreement

| fixture id | message | expected fact / JEV prob | derived fact | goal + conf | final routing | routing changed? | error family |
| ---------- | ------- | ------------------------ | ------------ | ----------- | ------------- | ---------------- | ------------ |
| `v4-hold-contact-meet-peds-tomorrow` | عايز أقابل دكتورة أطفال بكرة | providerRequested exp **true** / **0.40**; booking 0.45 | providerRequested **false** | booking (0.91) | NO handoff | **YES — missed contact** | A. SEMANTIC_MODEL_ERROR |
| `v4-hold-ambig-need-doctor` | محتاج دكتور | providerRequested exp false / 0.53 | providerRequested **true** | human_handoff (0.76) | handoff | **YES — false handoff** | C. LABEL/CONTRACT_BOUNDARY |
| `v4-hold-ambig-can-doctor` | ممكن دكتور؟ | providerRequested exp false / 0.61 | providerRequested **true** | human_handoff (0.81) | handoff | **YES — false handoff** | C. LABEL/CONTRACT_BOUNDARY |
| `v4-hold-ambig-want-the-doctor` | عايز الدكتور | providerRequested exp false / 0.56 | providerRequested **true** | human_handoff (0.90) | handoff | **YES — false handoff** | C. LABEL/CONTRACT_BOUNDARY |
| `v4-hold-mask-book-then-talk` | عايز أحجز كشف وبعدها أكلم الدكتور | providerRequested exp **true** / 0.40 (booking 0.93) | providerRequested false | booking | NO handoff ✓ | **NO — mask held** | E. ROUTING_NEUTRAL_FACT_DISAGREEMENT |
| `v4-hold-id-derm-name` | اسم دكتور الجلدية إيه؟ | availabilityAsked exp **true** / model false | availabilityAsked false | — | no handoff ✓ | NO | E |
| `v4-hold-id-who-peds` | مين الدكتورة اللي بتكشف أطفال؟ | availabilityAsked exp true → false; preference exp false → true | — | no handoff ✓ | NO | C / E |
| `v4-hold-id-english-cardio` | Who is the cardiologist? | availabilityAsked exp **true** → false | — | no handoff ✓ | NO | E |
| `v4-hold-pref-female-not-male` | لو فيه اختيار أفضل دكتورة مش دكتور | availabilityAsked exp **false** → **true** | — | no handoff ✓ | NO | B. POLICY/THRESHOLD_ERROR |
| `v4-hold-pref-sara-if-slot` | أفضل دكتورة سارة لو عندها ميعاد | availabilityAsked exp **false** → **true** | — | no handoff ✓ | NO | B |
| `v4-hold-neg-manager-hours` | المدير قال العيادة بتفتح الساعة تسعة | serviceOrPriceAsked exp **false** → **true** | — | no handoff ✓ | NO | E |
| `v4-hold-msa-booking-titled` | أرغب في حجز موعد مع طبيب الأسنان | providerPreferenceExpressed exp **true** → **false** | — | no handoff ✓ | NO | C |

The 8 non-routing disagreements plus the 4 routing mismatches account for all
12. No disagreement is unattributed; none was relabeled to make a family look
better.

---

## 9. CONTACT-vs-BOOK decision matrix (recomputed)

Counts by contact/booking conjunction, from `contactBookMatrix`:

| cell | n | fact accuracy | routing accuracy | missed human contacts | false human handoffs |
| ---- | - | ------------- | ---------------- | --------------------- | ------------------- |
| contact ∧ booking | **1** | masked correctly | **NO handoff ✓** | 0 | 0 |
| contact ∧ ¬booking | **12** | 11/12 | 11/12 handoff ✓ | **1** | 0 |
| ¬contact ∧ booking | **12** | 12/12 | 12/12 no-handoff ✓ | 0 | 0 |
| ¬contact ∧ ¬booking | **30** | 28/30 | 30/30 no-handoff ✓ | 0 | 0 |
| **TOTAL** | **60** | | **56/60** | **1** | **0** |

Focused class matrix:

| class | fixtures | fact accuracy | routing accuracy | missed contacts | false handoffs |
| ----- | -------- | ------------- | ---------------- | -------------- | -------------- |
| direct provider contact | 15 | 13/15 | **15/15 handoff ✓** | 0 | 0 |
| booking with provider title | 2 | 2/2 | 2/2 ✓ | 0 | 0 |
| book-to-see language | 7 | 7/7 | 7/7 ✓ | 0 | 0 |
| provider availability | 7 | 7/7 | 7/7 ✓ | 0 | 0 |
| provider identity | 4 | 2/4 (non-routing) | 4/4 ✓ | 0 | 0 |
| provider preference | 4 | 3/4 (non-routing) | 4/4 ✓ | 0 | 0 |
| support / staff contact | 5 | 5/5 | 5/5 handoff ✓ | 0 | 0 |
| ambiguous contact-vs-book | 4 | 1/4 | **1/4** | 0 | **3** |

### The two product failures, reported prominently

**A. MISSED_EXPLICIT_CONTACT = 1.**

```
v4-hold-contact-meet-peds-tomorrow   «عايز أقابل دكتورة أطفال بكرة»
  provider=0.40  booking=0.45  availability=0.07  ambiguousTurn=0.49
  expected human=true  model human=false
  conversationGoal = booking (0.91)   precedenceDerivation = "none"
```

The user clearly asks to *meet* a pediatrician; the model weighted the
tomorrow attachment as an arrangement cue and let booking (0.45) edge out
provider contact (0.40). A genuine contact-vs-arrangement boundary case.

**B. FALSE_HUMAN_HANDOFF = 0** in the contact/book matrix. The three
over-handoffs (`ambig-need-doctor`, `ambig-can-doctor`, `ambig-want-the-doctor`)
are **not** counted as false handoffs in the matrix because their authored
labels carry `providerRequested: false` with no contact verb — the user did not
explicitly request a human. They are a distinct, third phenomenon: over-handoff
on *bare* ambiguity (§11). Reporting them as false handoffs would inflate the
false-handoff metric; reporting them as absent would hide the real risk. They
are reported here as **3 over-handoffs on bare ambiguity**, separately and
prominently.

---

## 10. Clarification-candidate analysis (ANALYSIS ONLY — no JEV or Production change)

Using only existing evidence (raw probabilities, `conversationGoal`/confidence,
`ambiguousTurn`, the four request facts), the 60 turns classify:

| class | n | basis |
| ----- | - | ----- |
| CLEAR_HUMAN | 18 | explicit contact verb or support request; provider 0.69–0.97 or support 0.93–0.96 |
| CLEAR_BOOKING | 12 | booking 0.91–0.97 with no competing contact |
| CLEAR_DOMAIN_INFO | 11 | availability 0.95–0.96 or identity/service/greeting/negative controls |
| **CLARIFICATION_CANDIDATE** | **4** | the contact-vs-arrangement case + the three bare-ambiguity turns |
| OTHER | 15 | preference-with-booking, mixed-intent, negative controls already classified above |

The four clarification candidates:

| fixture | probabilities | why one question would beat either branch |
| ------- | ------------- | ----------------------------------------- |
| `contact-meet-peds-tomorrow` | prov 0.40 / book 0.45 / ambig 0.49 | the two readings are within 0.05; goal confidence is high (0.91) but on the *wrong* reading. «تقصد تقابل الدكتورة بكرة، ولا تحجز ميعاد؟» separates meet-vs-book directly. |
| `ambig-need-doctor` | prov 0.53 / book 0.11 / ambig 0.21 | no contact verb, no arrangement cue; handoff fires on 0.53 alone. A clarify-once turn resolves it without an escalation. |
| `ambig-can-doctor` | prov 0.61 / book 0.15 / ambig 0.36 | same shape; the model's own ambiguity is highest here. |
| `ambig-want-the-doctor` | prov 0.56 / book 0.09 / ambig 0.28 | same shape. |

**The product rule holds and is demonstrated, not assumed: LOW CONFIDENCE ALONE
NEVER MEANT HUMAN here.** In all three bare-ambiguity cases the model's
*confidence* was high (goal 0.76–0.90) while its *ambiguity* signal was
moderate — the failure is not low confidence, it is that a moderate provider
probability with no competing booking reading was allowed to escalate. The
correct fix is a clarification gate, not a threshold move. Nothing was
implemented; `shouldClarify` does not exist in the contract or in `src/`.

---

## 11. Error taxonomy (each disagreement, exactly one primary class)

| class | count | members |
| ----- | ----- | ------- |
| **A. SEMANTIC_MODEL_ERROR** | **1** | `contact-meet-peds-tomorrow` — the model's reading of «أقابل» + بكرة as arrangement is semantically wrong for a contact request |
| **B. POLICY/THRESHOLD_ERROR** | **2** | `pref-female-not-male`, `pref-sara-if-slot` — availabilityAsked true where the label and the contract say false |
| **C. LABEL/CONTRACT_BOUNDARY** | **4** | the 3 bare-ambiguity turns + `msa-booking-titled` (preference) — authored label and contract encode different readings |
| **D. EXECUTION/INFRASTRUCTURE_ERROR** | **0** | the measurement itself is reliable |
| **E. ROUTING_NEUTRAL_FACT_DISAGREEMENT** | **5** | `mask-book-then-talk` (providerRequested), the 3 identity/availability readings, `neg-manager-hours` |

12 = 1 + 2 + 4 + 0 + 5. Nothing was silently relabeled.

---

## 12. Comparison against previous evidence

| family | prior evidence | holdout-v4 (unseen wording) | regression? |
| ------ | -------------- | -------------------------- | ----------- |
| خدماء العملاء lexical false-negative class | solved in calibration-v3 | 5/5 support requests → handoff, support 0.93–0.96 | **no** |
| broad support-role false positives | solved | 2 broad-support cases, 0 false handoffs | **no** |
| provider availability | solved | 7/7, availability 0.95–0.96, no handoff | **no** |
| provider title vs direct request | solved | 3 title cases, 0 missed; booking 0.91–0.97 masks title | **no** |
| support + booking precedence | solved | `support-reception-book`: support 0.93 vs booking 0.94 → **handoff** (support wins) | **no** |
| greetings | solved | pure greeting, no handoff | **no** |
| sensitive turns | solved | 3 sensitive cases, 0 disagreements | **no** |
| mixed language | solved | 12 mixed cases, 1 disagreement (non-routing) | **no** |
| provider preference + booking | solved | 8 cases, booking masks preference, all no-handoff | **no** |
| **contact-vs-book overall** | 20/20 on `holdout` | **56/60**, mask intact on the 1 contact∧booking case | **zero material regression** |

Contact-vs-book specifically: the booking mask held on every
contact-inside-booking shape, including the explicit "talk first, then book"
case (provider 0.82 suppressed by booking 0.59 → no handoff). The two residual
families are the §8.1 missed contact and the three bare-ambiguity over-handoffs
— neither is a regression of a previously solved family; both are new boundary
evidence.

---

## 13. 0/1-call + server authority proof (all offline)

| suite | command | result |
| ----- | ------- | ------ |
| JEV evaluation + architecture + runner | `pnpm check:jev-eval` | **PASSED — 136/136** |
| JEV strategy (0/1-call, authority) | `pnpm check:jev` | **PASSED — 28/28** |
| Turn Planner | `pnpm check:turn-planner` | **PASSED — 41/41** |
| AI architecture | `pnpm check:ai-architecture` | **PASSED — 25/25** |
| Turn evidence | `pnpm check:turn-evidence` | **PASSED — 45/45** |

Proven by these suites, unchanged from R1:

- **exactly one** JEV Decisions request per evaluated semantic turn/bundle —
  the runner plans one request per fixture (`plannedRequestCount`) and the
  artifact's `executedRequests === plannedRequests === 60`;
- **no per-question fan-out** — all 12 questions are answered by one bundle
  per fixture (220 questions / 60 fixtures ≈ 3.67 questions per fixture is the
  *label* count; the call count is 1:1);
- the deterministic safe/bypass path can still use **zero** model calls
  (check:jev C-series; the offline artifact `jev-benchmark-offline-*` is a
  real zero-call run);
- **no JEV → LLM → judge chain** and **no second semantic classifier**
  (check:ai-architecture 25/25);
- **JEV does not own the final action** — `applyServerPrecedence` is the only
  producer of the handoff verdict; the Turn Planner remains the action
  authority (check:turn-planner 41/41).

**The server formula remains the production authority and was NOT moved into
JEV.** `src/features/conversations/server/conversation-ai.ts` is
**byte-identical to HEAD** (`git diff --quiet` → identical);
`detectExplicitHumanRequest` is unchanged.

---

## 14. Latency / tokens / cost

| metric | value |
| ------ | ----- |
| latency min / p50 / p95 / max / mean | 146 / 175 / 220 / 307 / 180.53 ms |
| input tokens (total / per call) | 208 719 / ≈3 479 |
| output tokens (total / per call) | 18 985 / ≈316 |
| total cost | $0.008 766 198 |
| cost per fixture | $0.000 146 103 |

Recomputed from rows and matching the artifact's totals exactly. A 0/1-call
budget at this latency and cost is production-viable: the bypass path costs
nothing, and the semantic path costs ~181 ms and ~$0.000 15 per turn.

---

## 15. Full regression + security results (§13)

| gate | result |
| ---- | ------ |
| `pnpm verify` (lint, typecheck, format, build) | **PASSED** |
| `pnpm security` | **clean — no secrets, credentials, or env files at risk** |
| `git diff --check` | **clean** (exit 0) |
| `pnpm pre-ship` | **`PRE_SHIP_GREEN` — PATCH** (see §17) |

### Production-isolation proof

| required proof | verdict | evidence |
| -------------- | ------- | -------- |
| `src/` runtime modifications | **0** | `git diff --name-only \| grep -c '^src/'` → 0; untracked `src/` → 0 |
| production JEV routing | **0** | no `src/` change is possible; no `src/` file imports `evaluation/jev` |
| schema / migration | **0** | nothing matching `prisma/`, `schema.prisma`, `migrations/` in diff or untracked |
| DB writes | **0** | the evaluation surface instantiates no `PrismaClient`; the offline invocations never constructed an adapter |
| booking mutations | **0** | no booking code path reachable from the evaluation surface |
| customer sends | **0** | no messaging/transport call; check:jev C10 confirms JEV metadata never reaches a customer reply |
| deployments | **0** | `vercel.json`, `next.config.ts`, `.github/` absent from the diff |
| secrets committed | **0** | `pnpm security` clean; artifact secret scan 13 probes / 0 hits |
| live JEV calls by this prompt | **0** | both runner invocations refused at exit 4 before any fetch |

---

## 16. FINAL VERDICT

# **C) BLOCKED_EXECUTION_INTEGRITY**

Not A, and not B:

- **Not A.** A requires a *valid sealed holdout-v4 artifact produced by this
  one-pass* with "exactly one exposure per fixture" and "no execution
  ambiguity." The artifact exists and is valid, but the exposure belongs to the
  interrupted R session, not to this prompt's one-pass. Executing holdout-v4
  here would have produced a **second** exposure of 60 sealed fixtures — the
  exact condition §5 treats as a seal break. Readiness for AI-JEV-03 design
  cannot be granted by a run that was refused.
- **Not B.** B (`NEEDS_MORE_JEV_CALIBRATION`) would imply the semantic
  candidate lacks calibration evidence. It does not: four Stage-A artifacts plus
  a complete, internally-consistent 60-fixture sealed measurement exist. The
  blocker is *execution integrity* — the seal is spent — not a calibration gap.
  Calling for more calibration would mis-diagnose the failure mode.

**The smallest execution-integrity recovery slice (per §16 for verdict C):**

Author a **new disjoint slice — `holdout-v5`** (≥ 40 fixtures; id- and
message-disjoint from all 220 existing fixtures across the six frozen slices;
covering the same §8 relationship grid plus the two residual families from
§8.1/§10), then measure it **exactly once** under the unchanged
`flowpilot.jev-questions@v3` / `flowpilot.jev-policy@v2` candidate.

That is the *only* recovery path, because:

1. holdout-v4 is permanently retired (`COMPLETED`, `eligibleForExecution: false`)
   and the runner enforces this before any fetch;
2. holdout-v3 is permanently retired (`SEAL_BROKEN`, 42/47 exposed, no artifact);
3. re-running either would re-expose sealed fixtures — the integrity violation
   this prompt exists to prevent;
4. the frozen candidate must NOT be edited to "fix" §8.1 — that would
   invalidate the four Stage-A artifacts and the holdout-v4 measurement.

No post-holdout tuning was performed. No semantic surface was touched.

---

## 17. `pnpm pre-ship` — exact output (REPORT ONLY; `pnpm ship` NOT RUN)

```
Release candidate (21 path(s), fingerprint eeeef4c5a54e):
  modified evaluation/jev/jev-fixture-bank.ts
  new      evaluation/jev/jev-freeze-manifest.ts
  modified evaluation/jev/jev-question-contract.ts
  new      evaluation/reports/jev/AI-JEV-02B-A-STAGE-A-HANDOFF.md
  new      evaluation/reports/jev/AI-JEV-02B-FINAL-REPORT.md
  new      evaluation/reports/jev/AI-JEV-02B-R1-PRE-HOLDOUT-HANDOFF.md
  new      evaluation/reports/jev/jev-benchmark-calibration-live-…12-24-37….json
  new      evaluation/reports/jev/jev-benchmark-calibration-live-…12-36-37….json
  new      evaluation/reports/jev/jev-benchmark-calibration-v3-live-…12-13-48….json
  … (5 further calibration-v3 / holdout / original live artifacts)
  new      evaluation/reports/jev/jev-benchmark-holdout-v4-live-live-…393e6c.json
  modified scripts/check-jev-eval.ts
  modified scripts/eval-jev-benchmark.ts
Risk surfaces: none

Gates:
  ✓ git state      PASS — on main, 21 candidate path(s)
  ✓ git diff --check PASS — no conflict markers / whitespace errors
  ✓ security       PASS
  ✓ ai-prompts     PASS
  ✓ verify         PASS
  ✓ non-mutation   PASS — candidate fingerprint stable (21 path(s))

Decision:      PRE_SHIP_GREEN
Recommended Bump: PATCH
Next human action: pnpm ship patch
```

**`pnpm ship` was NOT RUN.** No commit, push, tag, release or deploy was
performed. HEAD remains `5c8eaf9` == `origin/main`; latest tag remains `v0.44.6`.

---

## 18. Side-effect accounting for THIS prompt

| category | count |
| -------- | ----- |
| live provider calls made by this prompt | **0** |
| runner invocations (both refused at exit 4, 0 fetches) | 2 |
| `src/` files changed | **0** |
| contract / policy / label / example / threshold changes | **0** (all six slice fingerprints + contract + policy unchanged) |
| holdout-v4 fixtures authored or exposed | **0** |
| partial / complete artifacts written | **0** |
| DB writes / booking mutations / customer sends | **0** / **0** / **0** |
| commits / pushes / tags / releases / deploys / migrations | **0** |
| `pnpm ship` of any bump | **NOT RUN** |
| files created in the repository by this prompt | **1** — this report |

---

## 19. AI-JEV-03 — NOT started, NOT implemented

Verdict is C, so §17's conditional (recommend the next slice "if and only if
verdict is A") does not fire. No production code was written. `shouldClarify`
does not exist in the contract, the policy, or `src/`.

For the record only — the §10/§11 evidence base for a future design is intact
and un-tuned: the clarification-candidate family is measurable (4 turns), the
missed-contact shape is characterised (1 case, contact-vs-arrangement), the
booking mask is proven on unseen wording, and the server-precedence /
0/1-call invariants are green. That evidence should be carried into
`holdout-v5`'s authoring so the residual families are re-measured on fresh
wording — after the seal question is resolved, not before.

---

## 20. Exact git status / diff

```
On branch main
Your branch is up to date with 'origin/main'.
HEAD: 5c8eaf9578222eba6f7e5cce6108d74c05a8298a  ==  origin/main

Changes not staged for commit (4):
  modified:   evaluation/jev/jev-fixture-bank.ts      (+2055)
  modified:   evaluation/jev/jev-question-contract.ts (+120)
  modified:   scripts/check-jev-eval.ts               (+839)
  modified:   scripts/eval-jev-benchmark.ts           (+1429)

Untracked files (17): the freeze manifest, 13 live report JSONs,
3 handoff/report .md files (incl. this one)

Staged: 0.  src/ in diff: 0.  git diff --check: clean.
```

Everything remains uncommitted in the working tree. **Do not reset the tree** —
a rebase, `git checkout`, `git restore` or `git clean` would destroy Stage A,
the holdout-v4 measurement and both handoffs.

---

## 21. HARD STOP — honored

- **Live holdout-v4 request: NOT MADE.** The retirement gate refused it at
  exit 4 with zero fetches, twice (offline and `--live`).
- **Live holdout-v3 request: NOT MADE.** Refused the same way.
- **holdout-v4 exposure by this prompt: 0.** The seal was already spent by the
  interrupted R session; it was not re-spent here.
- **Production: untouched** (0 `src/` changes; precedence byte-identical to HEAD).
- **AI-JEV-03: NOT started, NOT implemented.**
- **Commit / push / tag / release / deploy / migrate: NONE.**
- **`pnpm ship`: NOT RUN.** `pnpm pre-ship` was run read-only and reported
  `PRE_SHIP_GREEN` / PATCH.

**Verdict: C) BLOCKED_EXECUTION_INTEGRITY.**
Smallest recovery slice: author `holdout-v5` (≥ 40 fixtures, disjoint from all
220) and measure it exactly once against the unchanged frozen candidate.
