# AI-JEV-02B-A — STAGE A HANDOFF (evaluation/reporting only)

> ┌────────────────────────────────────────────────────────────────────────┐
> │ EVALUATION / REPORTING ONLY. Contains NO secret values.                │
> │ No `OPENROUTER_API_KEY`, no credential, no env value appears below.     │
> │ This file is a handoff record, not a production module: nothing in      │
> │ `src/` imports it or anything it describes.                            │
> └────────────────────────────────────────────────────────────────────────┘

**Task**   PROMPT-AI-JEV-02B-A — Contact-vs-Book calibration + sealed holdout
          expansion, Stage A closeout + pre-holdout freeze.
**State**  Stage A COMPLETE. Stage B (the sealed holdout) has NEVER been run.
**Verdict** `READY_FOR_AI_JEV_02B_STAGE_B` (see §16).
**Authored** 2026-10-12T15:02Z (recovery + closeout session), continuing an
          interrupted session whose last artifact was written 12:36:37Z.


────────────────────────────────────────────────────────────────────────────
## 1. Repository state (recovered, unmodified by this handoff)
────────────────────────────────────────────────────────────────────────────

| item                     | value                                              |
| ------------------------ | -------------------------------------------------- |
| branch                   | `main`                                             |
| HEAD                     | `5c8eaf9578222eba6f7e5cce6108d74c05a8298a`         |
| origin/main              | `5c8eaf9578222eba6f7e5cce6108d74c05a8298a` (equal) |
| package.json version     | `0.44.6`                                           |
| latest release tag       | `v0.44.6`                                          |
| relationship to shipped ancestor | EXACT MATCH (as expected by the prompt)    |
| stash / merge / rebase / cherry-pick / revert / bisect | none                |
| working tree             | NOT clean, BY DESIGN — uncommitted AI-JEV-02B work |

**Tracked modifications (4 files, +1875 / −77):**

```
evaluation/jev/jev-fixture-bank.ts      | 1149 +++++++++-
evaluation/jev/jev-question-contract.ts |  120 +-
scripts/check-jev-eval.ts               |  339 +++-
scripts/eval-jev-benchmark.ts           |  344 +++-
```

**Untracked additions (1 file):**

```
evaluation/jev/jev-freeze-manifest.ts   (the freeze record; NEW this task)
```

**Untracked live artifacts (13 report JSONs).** The four that matter are the
final frozen-contract regression runs (§9); the rest are intermediate
calibration iterations and are retained as audit trail.

**`src/` runtime files modified: ZERO.** Confirmed by `git diff --name-only |
grep -c '^src/'` → `0`. No production routing, prompt, adapter or policy file
was touched. `evaluation/jev/jev-probability-policy.ts` and
`evaluation/jev/jev-decisions-adapter.ts` are byte-identical to HEAD
(`git diff --stat` empty for both).


────────────────────────────────────────────────────────────────────────────
## 2. Inventory of the interrupted session — recovered, not restarted
────────────────────────────────────────────────────────────────────────────

| Stage-A item                                | Status      |
| ------------------------------------------- | ----------- |
| contact-vs-book semantic repair (@v3)       | COMPLETE    |
| `providerRequested` definition refinement   | COMPLETE    |
| `bookingRequested` definition refinement    | COMPLETE    |
| `availabilityAsked` contact exclusion        | COMPLETE    |
| `providerPreferenceExpressed` refinement     | COMPLETE    |
| `supportRequested` role separation           | COMPLETE    |
| `greetingOnly` / `ambiguousTurn` boundary    | COMPLETE    |
| calibration-v3 bank construction (27)        | COMPLETE    |
| NEW sealed holdout-v3 construction (47)      | COMPLETE    |
| global bank integrity checks                 | COMPLETE    |
| calibration / holdout disjointness           | COMPLETE    |
| fingerprints (contract, policy, all slices)  | COMPLETE    |
| live Stage-A calibration                     | COMPLETE    |
| semantic repair iteration                    | COMPLETE    |
| known-regression verification                | COMPLETE    |
| original-bank verification                   | COMPLETE    |
| AI-JEV-02 holdout verification               | COMPLETE    |
| freeze manifest + run-time binding gate      | COMPLETE    |
| offline architecture/security checks         | COMPLETE    |
| **durable handoff artifact (this file)**     | **COMPLETED BY PROMPT A** |

The prior session was interrupted immediately before Stage B, while finishing
the final original/holdout/calibration regression verification. Those four
runs completed at 12:36:09–12:36:37Z and are reused here because their
fingerprints match the final frozen candidate exactly (§9). **No duplicate
live call was paid for presentation.**

**Live calls made by the whole AI-JEV-02B effort, by slice:** the pinned model
`typesafe/jev-1.13` was requested against `original` (40), `calibration` (26),
`holdout` (20) and `calibration-v3` (27) only. The `holdout-v3` slice has been
fingerprinted but **never requested** (§10).


────────────────────────────────────────────────────────────────────────────
## 3. The semantic model (preserved, unchanged in shape)
────────────────────────────────────────────────────────────────────────────

The bundle remains eleven independent facts plus one bounded choice. **No new
intent was introduced to make the benchmark greener.**

```
supportRequested · providerRequested · bookingRequested · availabilityAsked
cancellationRequested · rescheduleRequested · providerPreferenceExpressed
sensitiveTurn · serviceOrPriceAsked · greetingOnly · ambiguousTurn
+ conversationGoal (the one bounded Choice)
```

There is **no `explicitHuman` JEV question** and **no `shouldHandoff` /
`nextAction` question**. The precedence is never asked of the model.

**Server precedence remains authoritative** (shipped in v0.44.4,
`detectExplicitHumanRequest`):

```
explicitHuman = supportRequested OR (providerRequested AND NOT bookingTask)
```

where `bookingTask = bookingRequested OR availabilityAsked
OR cancellationRequested OR rescheduleRequested`.

**Turn Planner remains the action authority.** Nothing in this task changes
production behavior; the formula is reproduced in `evaluation/` as a
deliberate copy (`applyServerPrecedence`) so the benchmark can derive the
verdict both ways and prove the policy is unchanged. It is never imported by
`src/`.


────────────────────────────────────────────────────────────────────────────
## 4. Final Stage-A semantic contract summary
────────────────────────────────────────────────────────────────────────────

The repair is entirely in **contract wording**, never in thresholds, never in
lexical lists. Each item below was repaired on a **family** of cases.

**contact-vs-book (the inherited defect).** `bookingRequested` @v2 enumerated
four exclusions and not one contrasted the booking reading with the **contact**
reading. "Seeing a provider" carries both: it is contact when it is the
requested *mode of resolution* ("I want to see a doctor"), and booking when it
is the *purpose of an arrangement* ("I want to book so I can see a doctor").
@v3 makes that contrast explicit in **both** `providerRequested` and
`bookingRequested`, as a minimal pair over the **relationship**, never over a
word. `providerRequested` additionally gains timing invariance: attaching a
when ("now", "tomorrow") does not convert a contact request.

**availabilityAsked contact exclusion (the second Stage-A finding).** The
first live @v3 calibration repaired `bookingRequested` cleanly, but the same
defect migrated: «محتاج أشوف دكتور دلوقتي» returned `availabilityAsked` 0.53,
and because the server precedence folds availability into `bookingTask`, the
mask engaged anyway. @v3 states the same exclusion here: a turn that **asks
for** an interaction is not a turn that **asks whether** something is free.

**providerPreferenceExpressed (the §10 adjudication).** The
availability/presence exclusion now names **both** the named and the unnamed
provider case, and preference requires a constraint on the **service**, not a
time attachment.

**greetingOnly / ambiguousTurn boundary.** A hesitation or filler is not a
social opening; a greeting must carry **greeting content**.

**Evidence the repair is semantic, not a hack:** `bookingRequested` on
«عايز أشوف دكتور» moved 0.58 → **0.07** while the *same question* scores
**0.89–0.92** on the book-to-see minimal pairs that share the verb «أشوف». A
keyword or threshold move cannot produce that separation; only a relational
contrast can. Verified live in §9.

**Forbidden repairs, all abstained from:** no dialect dictionary, no magic
keyword list, no stem/regex list (checked mechanically by
`check:jev-eval` J19l: "the contract adds no lexical dictionary, stem list or
regex"), no one-sentence threshold hack, no production routing change, no
`src/` edit. The probability policy is byte-identical to AI-JEV-02.


────────────────────────────────────────────────────────────────────────────
## 5. providerPreferenceExpressed — the §10 adjudication
────────────────────────────────────────────────────────────────────────────

**Question:** *What does `providerPreferenceExpressed` mean for future
evaluation and routing design?*

**Answer.** It means **a constraint on WHICH provider performs a requested
service or booking** — a narrowing of the set of acceptable providers. It does
**not** mean "a provider was mentioned", "a provider was named", "a provider's
availability was asked about", or "a time was attached to a contact request".

**The disagreement, audited.** The historical AI-JEV-02 labels mark a GENERIC
provider inside an AVAILABILITY question («هل فيه دكتور متاح؟») as
preference = `true`. The model answered `false` (0.07–0.10) on **all 7** such
cases across `original`, `calibration` and `holdout` — one direction, 7
fixtures, zero counter-examples. Audited against the product definition, **the
model is right and the historical label is a label defect**: asking what is
free constrains nothing about who performs the service.

**Historical evidence remains immutable (§10).** The three AI-JEV-02 slices are
byte-identical to the committed artifacts — proven mechanically, not asserted:

```
original     40   sha256:69341a65821179a9
calibration  26   sha256:8a76f9e4deeb94f8
holdout      20   sha256:d3f4a90715c80066
```

These match the fingerprints the committed artifacts record. The historical
disagreement stays **visible** in the recomputed evidence (§9 lists all 7) and
is recorded in the adjudication register
(`PROVIDER_PREFERENCE_ADJUDICATION`, `evaluation/jev/jev-freeze-manifest.ts`).
No historical artifact was rewritten.

**Forward contract-consistent expectations** live only in the NEW slices: every
availability case, named or generic, expects preference = `false`
(verified by `check:jev-eval` J19d).

**Routing impact: NULL — and this is the key design point.** The precedence
formula consumes `supportRequested` / `providerRequested` / `bookingTask` only.
`providerPreferenceExpressed` participates in **no** routing decision. The 7
historical disagreements are therefore **non-routing label noise**, not
evidence of a routing defect, which is precisely why they may be retired
without touching the server formula. For future routing design: preference is
a *booking-shaping* signal (which slot to offer), never a *handoff* signal.


────────────────────────────────────────────────────────────────────────────
## 6. Frozen Stage-A candidate — fingerprints
────────────────────────────────────────────────────────────────────────────

All values below were **recomputed from live source in this session** and
compared against `JEV_FREEZE_MANIFEST` via `verifyFreezeManifest()`:
**`MANIFEST MISMATCHES: NONE`**.

| artifact                | value                                              |
| ----------------------- | -------------------------------------------------- |
| question contract id    | `flowpilot.jev-questions@v3`                       |
| **contract fingerprint**| **`sha256:588222a74f4a356b`**                      |
| probability policy id   | `flowpilot.jev-policy@v2` (UNCHANGED from AI-JEV-02)|
| **policy fingerprint**  | **`sha256:a01c368d17e5629e`**                      |
| requested model         | `typesafe/jev-1.13` (PINNED)                       |
| forbidden alias model   | `~typesafe/jev-latest` (never the measured model)  |
| freeze manifest fp      | `sha256:486502b20f5adae8`                          |

**Frozen slices:**

| slice             | n  | fingerprint            | role                     |
| ----------------- | -- | ---------------------- | ------------------------ |
| `original`        | 40 | `sha256:69341a65821179a9` | frozen AI-JEV-01 bank |
| `calibration`     | 26 | `sha256:8a76f9e4deeb94f8` | frozen AI-JEV-02 Stage A |
| `holdout`         | 20 | `sha256:d3f4a90715c80066` | frozen AI-JEV-02 Stage B (already run once) |
| `calibration-v3`  | 27 | `sha256:29a8d48d1e244ee0` | **NEW** — Stage A evidence |
| `holdout-v3`      | 47 | `sha256:1d659cc4d188bf56` | **NEW** — Stage B, one pass, NEVER RUN |

Total bank `JEV_FIXTURES_V3` = **160** fixtures; the five slices partition it
exactly (sum = 160, pairwise id-disjoint, all ids and messages globally
unique — `bankIntegrity()` ok). Every coverage class has at least one case.

**Label-before-output proof.** The fingerprints are computed over
`(id, message, expected)` **before** any live request against these messages;
the runner records both the pre-run fingerprint and the slice it measured, so a
post-run label edit changes the fingerprint and is detectable. The working tree
carries the new slices as uncommitted edits whose authorship mtime
(`jev-fixture-bank.ts` 12:05:17Z) **precedes** every live artifact.

**Run-time binding gate.** `scripts/eval-jev-benchmark.ts` resolves the live
state (contract, policy, model, all slice fingerprints) and compares it with
the manifest, printing every mismatch and **refusing to run (exit 3)** when the
state is not the frozen candidate. A post-hoc contract or label edit is
therefore visible at run time, not just in review. Every live artifact below
carries a `freeze` block with `"mismatches": []`.


────────────────────────────────────────────────────────────────────────────
## 7. NEW sealed holdout — frozen, never executed
────────────────────────────────────────────────────────────────────────────

**Selector / bank name for Stage B: `holdout-v3`**

```
pnpm eval:jev -- --live --bank holdout-v3
```

**Size: 47 fixtures** (floor was 40). **Expected request count: exactly 47** —
one Decisions API request per fixture, each containing the whole question
bundle (verified by `check:jev-eval` J11c and J19j; `plannedRequestCount` is
the fixture count by construction, so there is no per-question fan-out and no
call multiplication).

**Authoring.** Labels were authored from the @v3 product semantics, in source,
**without any model output** — before any live request against these messages.
No duplicate ids, no duplicate messages (globally, across all 160 fixtures).
No paraphrase padding: each case is a distinct semantic position.

**Required coverage — present:**

| required family                          | evidencing fixtures (id → message)                     |
| ---------------------------------------- | ------------------------------------------------------ |
| direct contact vs book-to-see            | `contact-see-now` «لازم أشوف دكتور النهارده» vs `book-to-see` «عايز أعمل ميعاد عشان أشوف دكتور»; `contact-talk-plain` vs `book-to-talk`; `contact-meet`… |
| provider contact + booking               | `contact-plus-booking` «عايز الدكتور يكلمني وأنا أعمل الحجز معاه»; `multi-intent-booking-plus-contact` |
| availability vs contact                  | `availability-generic` «في دكتور فاضي بكرة؟» vs `contact-see-now` |
| availability vs preference               | `availability-vs-preference-identity` «مين الأخصائي الموجود؟»; `explicit-preference-no-booking` |
| identity vs contact                      | `identity-business` «إنتو بتوع دكتور أحمد؟» vs `contact-connect-named` |
| named-provider booking preference        | `preference-plus-booking-named` «عايز أعمل الحجز مع دكتورة سارة» |
| generic-provider booking                 | `preference-plus-booking-specialist` «عايز أظبط ميعاد مع أخصائي»; `booking-plain` |
| clinical provider vs support             | `contact-msa-formal` vs `support-explicit-request` «محتاج أتكلم مع مسؤول»; `support-compliment-no-request` |
| provider titles / genders                | دكتور · دكتورة (`contact-female` «عايزة أكلم دكتورة بنات`) · أخصائي · dentist |
| Arabic / Egyptian / MSA / English / mixed| egyptian 36 · msa 3 (`msa-booking`, `cancel-msa`, `contact-msa-formal`) · english 2 (`english-booking`, `contact-english-direct`) · mixed 3 (`mixed-booking-female`, `mixed-availability`, `contact-mixed-verb`) |
| collateral control cases                 | `pure-greeting` «تصبح على خير» · `fragment-ambiguous` «ااه بس» · `ambiguous-out-of-domain` «إيه أخبار الماتش؟» · `urgent-booking-not-sensitive` |

Class coverage inside the slice: `provider-direct-contact` 11,
`provider-preference-plus-booking` 7, `egyptian-arabic-variant` 36,
`provider-availability` 5, `provider-identity` 4, plus broad representation
across sensitive, ambiguous, reschedule/cancel, service/price and
support-false-positive classes.

**Fingerprint recorded WITHOUT executing:** `sha256:1d659cc4d188bf56`.

**Mechanical proof calibration cannot access this holdout** (recomputed this
session — id and message leakage, per selector):

| selector                        | n   | holdout-v3 ids leaked |
| ------------------------------ | --- | --------------------- |
| `bankSubset("original")`       | 40  | **0**                 |
| `bankSubset("calibration")`    | 26  | **0**                 |
| `bankSubset("holdout")`        | 20  | **0**                 |
| `bankSubset("calibration-v3")` | 27  | **0**                 |
| `JEV_FIXTURES`                 | 40  | **0**                 |
| `JEV_CALIBRATION_FIXTURES`     | 26  | **0**                 |
| `JEV_HOLDOUT_FIXTURES`         | 20  | **0**                 |
| `JEV_CALIBRATION_V3_FIXTURES`  | 27  | **0**                 |
| `JEV_FIXTURES_V2` (legacy)     | 86  | **0**                 |
| `bankSubset("holdout-v3")`     | 47  | 47 (its own selector) |
| `JEV_FIXTURES_V3` (all)        | 160 | 47 (the explicit full bank) |

**Reading:** the ONLY ways to reach the sealed slice are its own selector
`bankSubset("holdout-v3")` / `JEV_HOLDOUT_V3_FIXTURES` and the explicit
full-bank selectors (`bankSubset("all")` / `JEV_FIXTURES_V3`). **No calibration
selector, and no original/holdout/legacy selector, reaches a single holdout-v3
fixture.** Additionally `check:jev-eval` J17b/J17b2 enforce the same property
in the offline suite, so a calibration loop iterating the default bank never
touches either frozen holdout.

**Prompt A froze this slice. Prompt B may not alter it.**


────────────────────────────────────────────────────────────────────────────
## 8. Pre-Stage-B regression gates — final frozen-contract evidence
────────────────────────────────────────────────────────────────────────────

All four runs below are **live**, pinned to `typesafe/jev-1.13`, and bound to
the FINAL frozen contract `sha256:588222a74f4a356b` (policy
`sha256:a01c368d17e5629e`, freeze manifest `sha256:486502b20f5adae8`,
`"mismatches": []`). They are the interrupted session's own artifacts, reused
because their fingerprints match the final candidate — no duplicate paid run.

| slice (bank) | artifact | routing | exact | q-agree | missed contact | false handoff | errors |
| ------------ | -------- | ------- | ----- | ------- | -------------- | ------------ | ------ |
| `original` (40)    | `jev-benchmark-original-live-2026-10-12T12-36-28-591Z.json`     | **40/40** | 37/40 | 122/125 | **0** | **0** | 0 |
| `calibration-v3` (27) | `jev-benchmark-calibration-v3-live-2026-10-12T12-36-09-147Z.json` | **27/27** | 26/27 | 107/108 | **0** | **0** | 0 |
| `holdout` (20, AI-JEV-02) | `jev-benchmark-holdout-live-2026-10-12T12-36-32-593Z.json` | **20/20** | 19/20 | 61/62 | **0** | **0** | 0 |
| `calibration` (26, AI-JEV-02) | `jev-benchmark-calibration-live-2026-10-12T12-36-37-907Z.json` | **26/26** | 20/26 | 85/92 | **0** | **0** | 0 |

**Routing correctness is 113/113 across all four slices, with zero missed
contacts and zero false handoffs.** Every request ledger shows
`planned == executed`, `failed: 0`, `retries: 0` — one request per fixture, no
fan-out, no retries.

### Gate-by-gate verdict

| §9 gate | verdict | evidence |
| ------- | ------- | -------- |
| original bank final routing has no regression | **PASS** | 40/40 routing, 0 missed, 0 false handoff |
| previous AI-JEV-02 holdout final routing no regression | **PASS** | 20/20 routing, 0 missed, 0 false handoff |
| Stage-A calibration behaves as expected | **PASS** | calibration-v3 27/27 routing; the only residual disagreements are the adjudicated label defects |
| «هل فيه دكتور متاح؟» remains repaired | **PASS** | routes to **NO handoff** (`expH=False modH=False`, `routingMismatch=False`); the residual `providerPreferenceExpressed` disagreement is the adjudicated label defect, non-routing |
| prior direct-contact/book masking failure family repaired **before** the new holdout opens | **PASS** | `bookingRequested` 0.58 → **0.07** on «عايز أشوف دكتور»; `providerRequested` 0.73 → `explicitHuman` **true** |
| known lexical-gap fixes remain fixed | **PASS** | Egyptian filler «يعني» around a clear booking (`egyptian-booking-filler`) still scores booking 0.81+ and routes correctly; filler/fragment cases («اه», «أها», «امم», «ااه بس») all route to no handoff |
| broad support-role false positives remain fixed | **PASS** | all staff-role mentions with no request score support 0.02–0.06; `broad-support-role-musaaada-no-request`, `support-topic-news-only`, `support-compliment-no-request`, `broad-support-role-modir-no-request` all route to no handoff |
| support + booking precedence remains correct | **PASS** | all 5 support+booking cases route to handoff (`sup 0.63–0.94` wins over `book 0.66–0.93`): `human-plus-booking-mwathaf`, `human-plus-booking-wsali`, `human-plus-booking-customer-service`, `greeting-human-booking`, `v2-cal-support-plus-booking` |
| provider preference + booking creates no false human handoff | **PASS** | all 17 preference+booking cases route to **no** handoff (booking masks the provider path); e.g. `booking-named-preference` book 0.96, `v2-hold-booking-named-provider` book 0.97 |
| pure greetings remain correct | **PASS** | `greeting-pure-salam`, `greeting-pure-sabah`, `greeting-pure-ahlan`, `v3-cal-pure-greeting-full` all route to no handoff |
| mixed-language cases remain correct | **PASS** | `mixed-provider-contact` «عايز أتكلم مع doctor please» prov 0.96 → handoff; `mixed-availability`, `mixed-booking-female` (book 0.89) → no handoff; `contact-mixed-verb` «محتاج أقابل doctor لو سمحت» → handoff |
| sensitive cases remain correct | **PASS** | symptom/pain cases without a request route to no handoff; `sensitive-complaint-request` and `broad-support-role-modir-complaint-complaint` correctly route to handoff (support 0.95/0.96) |

### The contact-vs-book minimal pairs, live on the frozen contract

| message | provider | booking | avail | explicitHuman | ok |
| ------- | -------- | ------- | ----- | ------------- | -- |
| «عايز أشوف دكتور» (contact) | 0.73 | **0.07** | 0.06 | **true** | ✓ |
| «محتاج أشوف دكتور دلوقتي» (contact) | 0.79 | **0.11** | — | **true** | ✓ |
| «محتاج أشوف doctor بكرة» (contact, mixed) | 0.67 | **0.18** | 0.08 | **true** | ✓ |
| «عايز أظبط ميعاد عشان أشوف الدكتور» (book-to-see) | 0.09 | **0.92** | 0.09 | false | ✓ |
| «أريد حجز موعد لرؤية الطبيب» (book-to-see, MSA) | 0.09 | **0.89** | 0.06 | false | ✓ |
| «عايز أعمل appointment عشان أشوف الدكتور» (book-to-see, mixed) | 0.07 | **0.92** | 0.07 | false | ✓ |
| «عايز الدكتور يكلمني عشان أحجز» (contact **+** booking) | 0.60 | **0.76** | 0.06 | false | ✓ |

The same verb «أشوف» resolves to contact (booking 0.07–0.18) when no
arrangement is requested, and to booking (0.89–0.92) when an arrangement cue is
present. The mask is **not** weakened: the genuine contact-inside-booking case
still routes to **no** handoff.

### Residual disagreements — all adjudicated, all non-routing

The 12 residual disagreements across the four slices are exactly:
**7 × `providerPreferenceExpressed`** — the adjudicated label defects of §5
(`provider-availability`, `v2-cal-provider-availability-title`,
`v2-cal-provider-availability-msa`, `v2-cal-greeting-plus-provider-availability`,
`v2-cal-availability-plus-service`, `v2-cal-mixed-availability`,
`v2-hold-provider-availability-female`); **1 × `ambiguousTurn`** («اه»); and
**4 × cancel/reschedule paraphrase and `providerRequested` on mixed-language
contact**, each with `routingMismatch=False`. **No residual disagreement
changes any routing verdict.** Nothing is silently hidden: every one is
retained verbatim in its report's `disagreementRows`.


────────────────────────────────────────────────────────────────────────────
## 9. Existing live artifacts and their bindings
────────────────────────────────────────────────────────────────────────────

Final frozen-contract artifacts (contract `sha256:588222a74f4a356b`) — the
authoritative Stage-A evidence:

```
evaluation/reports/jev/jev-benchmark-original-live-2026-10-12T12-36-28-591Z.json
evaluation/reports/jev/jev-benchmark-calibration-v3-live-2026-10-12T12-36-09-147Z.json
evaluation/reports/jev/jev-benchmark-holdout-live-2026-10-12T12-36-32-593Z.json
evaluation/reports/jev/jev-benchmark-calibration-live-2026-10-12T12-36-37-907Z.json
```

Intermediate live artifacts (earlier @v3 contract drafts — retained as the
audit trail of the repair iteration, NOT evidence of the final candidate):

```
evaluation/reports/jev/jev-benchmark-calibration-v3-live-2026-10-12T12-13-48-801Z.json   contract bc797071907894bf
evaluation/reports/jev/jev-benchmark-calibration-v3-live-2026-10-12T12-17-19-816Z.json   contract 4b9473cb82dbd24e
evaluation/reports/jev/jev-benchmark-calibration-v3-live-2026-10-12T12-28-56-399Z.json   contract f8161257a06cee01
evaluation/reports/jev/jev-benchmark-calibration-v3-live-2026-10-12T12-33-49-167Z.json   contract bda8e9d2b41ddebf
evaluation/reports/jev/jev-benchmark-calibration-v3-live-2026-10-12T12-36-09-147Z.json   contract 588222a74f4a356b  ← FINAL
evaluation/reports/jev/jev-benchmark-original-live-2026-10-12T12-19-45-177Z.json         contract 4b9473cb82dbd24e
evaluation/reports/jev/jev-benchmark-original-live-2026-10-12T12-22-22-480Z.json         contract 4b9473cb82dbd24e
evaluation/reports/jev/jev-benchmark-original-live-2026-10-12T12-36-28-591Z.json         contract 588222a74f4a356b  ← FINAL
evaluation/reports/jev/jev-benchmark-holdout-live-2026-10-12T12-18-59-351Z.json          contract 4b9473cb82dbd24e
evaluation/reports/jev/jev-benchmark-holdout-live-2026-10-12T12-36-32-593Z.json          contract 588222a74f4a356b  ← FINAL
evaluation/reports/jev/jev-benchmark-calibration-live-2026-10-12T12-24-37-654Z.json      contract 4b9473cb82dbd24e
evaluation/reports/jev/jev-benchmark-calibration-live-2026-10-12T12-36-37-907Z.json      contract 588222a74f4a356b  ← FINAL
```

Pre-@v3 (AI-JEV-02 / AI-JEV-01) artifacts, already committed:

```
evaluation/reports/jev/jev-benchmark-original-live-2026-10-12T04-47-34-845Z.json   @v2 contract 944db02b0993f920
evaluation/reports/jev/jev-benchmark-calibration-live-2026-10-12T04-44-32-707Z.json @v2 contract 944db02b0993f920
evaluation/reports/jev/jev-benchmark-holdout-live-2026-10-12T04-45-56-601Z.json     @v2 contract 944db02b0993f920
evaluation/reports/jev/jev-benchmark-calibration-live-2026-10-12T04-35-02-518Z.json @v2 contract 3c5f68617649fdc5
evaluation/reports/jev/jev-benchmark-live-2026-10-11T23-01-21-307Z.json             @v1
evaluation/reports/jev/jev-benchmark-offline-2026-10-11T22-08-35-611Z.json          @v1 offline
```

Every report's `sliceFingerprints` block records all five slice fingerprints as
a **manifest**; that recording is not a measurement. The **measured** bank is
the `bank` field, and it is one of `original`, `calibration`, `holdout`,
`calibration-v3` — never `holdout-v3` (§10).


────────────────────────────────────────────────────────────────────────────
## 10. PROOF the NEW Stage-B holdout has never been executed
────────────────────────────────────────────────────────────────────────────

This is the anti-double-holdout check, performed **before any live request**
and re-verified in this session.

1. **No report measures it.** Every report's `bank` field was inspected. The
   observed values are `original`, `calibration`, `holdout`, `calibration-v3`
   (and `null` on the two pre-fingerprint @v1 runs). **No report has
   `bank: "holdout-v3"`.**
2. **No report contains its fixtures.** All 47 `holdout-v3` fixture ids and all
   47 messages were searched against every `rows[]` array of every JSON in
   `evaluation/reports/jev/`. Result: **`NO STAGE B EVIDENCE IN ANY ARTIFACT`**.
3. **Repo-wide search.** All 47 ids were searched across every `.json`, `.md`,
   `.log`, `.txt` and `.csv` in the repository. They appear **only** in the
   source definitions (`jev-fixture-bank.ts`, `jev-freeze-manifest.ts`) and in
   the offline-check / runner scripts. `holdout-v3` as a string appears only in
   those source files and inside reports' `sliceFingerprints` manifest block.
4. **Selectors were never invoked for it.** The runner's `--bank` argument
   defaults to `original`; the prior session's runs are all original /
   calibration / holdout / calibration-v3.
5. **Chronology.** Labels authored 12:05:17Z → final contract 12:35:35Z →
   freeze manifest 12:36:03Z → the four final regression runs 12:36:09–
   12:36:37Z. The session ended there, before Stage B.

**Conclusion: the sealed holdout has been opened zero times. Stage B is
uncontaminated and may be run exactly once by PROMPT-AI-JEV-02B-B.**


────────────────────────────────────────────────────────────────────────────
## 11. Architecture / security invariants (offline verification)
────────────────────────────────────────────────────────────────────────────

| invariant | verdict | evidence |
| --------- | ------- | -------- |
| Production does not import evaluation/JEV | **HOLDS** | `check:jev-eval` J12 — no `src/` file imports the Jev evaluation surface; J18e — no `src/` file consumes the question contract or probability policy; `git diff` shows **0** `src/` files modified |
| Evaluation adapter unreachable from `src/` runtime | **HOLDS** | J12b (provider factory does not reference the adapter), J12c (orchestrator does not), J18d (shipped decision strategy imports no Jev evaluation adapter) |
| One bundle ⇒ at most one JEV request | **HOLDS** | J18 (a Jev semantic turn makes exactly ONE request for the whole bundle), J18b (the whole question set returns in that single request) |
| No per-question fan-out | **HOLDS** | J11 / J19j — planned request count is exactly the fixture count for every slice; every live ledger shows `planned == executed`, `failed: 0` |
| Missing credential ⇒ zero network calls | **HOLDS** | J1 (adapter fails CLOSED with no network I/O), J18c; the runner hard-stops (exit 2) on `--live` without the credential |
| No second semantic model / judge | **HOLDS** | single pinned model `typesafe/jev-1.13`; no judge scoring step exists anywhere |
| No mandatory JEV→LLM chain | **HOLDS** | J18d3 — the shipped decision strategy forbids a mandatory Jev stage by design |
| Server precedence remains authoritative | **HOLDS** | `applyServerPrecedence` is a deliberate copy in `evaluation/`; `expectedExplicitHuman` is DERIVED by the formula, never hand-written (J8); every routing verdict in this handoff derives from it |
| Turn Planner remains authoritative | **HOLDS** | no production file touched; no action/question added |
| Holdout selector cannot leak into calibration | **HOLDS** | §7 leakage table — every original/calibration/holdout/legacy selector leaks **0** holdout-v3 fixtures; enforced offline by J17b / J17b2 |
| Historical artifacts remain immutable | **HOLDS** | the three AI-JEV-02 slice fingerprints are byte-identical to the committed artifacts (§5); J17f asserts it in the offline suite |
| Secrets cannot enter artifacts | **HOLDS** | J13 (adapter reads the secret by NAME through `getEnvVar`), J13b (no hardcoded credential literal), J13c (a result never serializes a secret value); `pnpm security` clean |
| `scoredQuestions` accounting remains correct | **HOLDS** | J16 (committed artifact recomputes its scored questions from rows), J16b–J16f (the guard rejects mis-accounted reports; the offline benchmark's accounting matches its own rows) |
| contact-vs-book regression mechanically detectable | **HOLDS** | every report carries a `contactBookMatrix` plus per-fixture `rawProbabilities`, so the masking defect is visible without a re-run; J19a–J19c assert the holdout contains both shapes and that the mask stays intact |

**Commands run in this session (all offline or static):**

```
pnpm check:jev-eval   →  RESULT: PASSED — 110/110 checks ok
pnpm verify           →  RESULT: PASSED — lint, typecheck, format, build
pnpm security         →  ✅ No secrets, credentials, or env files at risk
git diff --check      →  clean (no whitespace errors)
```

`pnpm pre-ship` was **not** run, per the prompt's instruction, because
additional Stage-B artifacts are expected to become part of the final
AI-JEV-02B candidate. No commit, push, tag, release, deploy, migration or
`pnpm ship` was performed.


────────────────────────────────────────────────────────────────────────────
## 12. Exact changed paths
────────────────────────────────────────────────────────────────────────────

**Modified (tracked):**

```
evaluation/jev/jev-fixture-bank.ts       +1149 −38   new slices, selectors, integrity, docs
evaluation/jev/jev-question-contract.ts   +120 −17   the @v3 semantic repairs (§4)
scripts/check-jev-eval.ts                 +339 −12   new offline gates J15–J19
scripts/eval-jev-benchmark.ts             +344 −77   freeze binding, request ledger, contactBookMatrix
```

**Added (untracked):**

```
evaluation/jev/jev-freeze-manifest.ts     NEW        the frozen candidate + §10 adjudication register
evaluation/reports/jev/*.json             13 files   live artifacts (§9)
evaluation/reports/jev/AI-JEV-02B-A-STAGE-A-HANDOFF.md   this file
```

**Unchanged, deliberately:** `evaluation/jev/jev-probability-policy.ts`,
`evaluation/jev/jev-decisions-adapter.ts`, and the entire `src/` tree.


────────────────────────────────────────────────────────────────────────────
## 13. Baseline and calibration size
────────────────────────────────────────────────────────────────────────────

- **Current baseline:** release `v0.44.6` at `5c8eaf9`, the shipped ancestor.
- **Inherited Stage-A baseline (AI-JEV-02, @v2 contract):** the frozen holdout
  routed «عايز أشوف دكتور» to **no handoff** (`providerRequested` 0.79 with
  `bookingRequested` 0.58 → mask engaged). That is the defect this task closes.
- **Calibration size:** `calibration` 26 (frozen AI-JEV-02) +
  `calibration-v3` **27** (new Stage-A evidence) = **53** calibration fixtures.
- **Stage-B size:** `holdout-v3` **47** (floor 40).

**Why the policy fingerprint is unchanged.** The inherited defect was not a
calibration problem: the model already *knew* it was contact (0.79). §4's
differential isolates the cause as **contract wording**. Moving the 0.5
orientation was considered and rejected: it would damage the high-confidence
correct answers (which sit at 0.02–0.08 / 0.94–0.97, far from any sane cut
point); a per-question threshold on `bookingRequested` could not separate the
0.58 (wrong) from the 0.91 the same question scores on genuine booking; and a
family-competition rule over {contact, booking} would itself *be* the
precedence, relocating the server-owned formula into the policy. The full
rejection reasoning is recorded in `jev-freeze-manifest.ts`.


────────────────────────────────────────────────────────────────────────────
## 14. Remaining risks (exact, not generic)
────────────────────────────────────────────────────────────────────────────

1. **Model non-determinism on the sealed slice.** The @v3 contract has never
   met `holdout-v3`. The minimal-pair separation is strong on the evidence
   slices (booking 0.07–0.18 vs 0.89–0.92), but Stage B is the first and only
   measurement. A single fixture landing near 0.5 on `bookingRequested` would
   be a genuine finding, not a defect to tune away — and Prompt B must not
   tune the contract to fix it.
2. **The 12 residual label-vs-contract disagreements** (§8) are adjudicated and
   non-routing, but they mean `exact` < `routingTotal` on the historical
   slices. This is expected and must not be "repaired" by editing frozen
   labels.
3. **`contactBookMatrix.trueContactTrueBook` is 1 on `calibration`.** That is
   the genuine contact-inside-booking case, correctly masked to no handoff. It
   is not a defect, but it is the shape most sensitive to any future weakening
   of the booking mask.
4. **Everything is uncommitted.** The frozen candidate exists only in the
   working tree. Its integrity rests on the fingerprints and mtimes recorded
   here; a rebase, `git checkout`, `git restore` or `git clean` would destroy
   Stage A. Do not reset the tree.
5. **No production change is claimed.** This task is evaluation-only; the
   routing improvement is *measured*, not shipped. `src/` is untouched and no
   handoff verdict in this file is a production behavior change.


────────────────────────────────────────────────────────────────────────────
## 15. Stage-B instructions for PROMPT-AI-JEV-02B-B
────────────────────────────────────────────────────────────────────────────

**Exact command:**

```
pnpm eval:jev -- --live --bank holdout-v3
```

- **Bank selector / name:** `holdout-v3`
- **Requested pinned model:** `typesafe/jev-1.13`
- **Expected request count:** exactly **47** (one Decisions API request per
  fixture, each containing the whole question bundle)
- **Expected slice fingerprint:** `sha256:1d659cc4d188bf56` (47 fixtures)
- **Expected freeze manifest fingerprint:** `sha256:486502b20f5adae8`
- **Expected contract fingerprint:** `sha256:588222a74f4a356b`
- **Expected policy fingerprint:** `sha256:a01c368d17e5629e`

The runner verifies all of these before any call and hard-stops (exit 3) on a
mismatch. **Run it exactly once.**

**Do not change contract, policy, labels, examples or selectors before
executing it.** Any such change alters a fingerprint, trips the binding gate,
and invalidates the freeze.


────────────────────────────────────────────────────────────────────────────
## 16. Prompt-A final verdict
────────────────────────────────────────────────────────────────────────────

- Stage A is **complete** — all items in §2 are COMPLETE or completed by this
  prompt.
- The known contact-vs-book defect is **repaired on permitted evidence**
  (semantic contract repair on a family of cases; `bookingRequested`
  0.58 → 0.07 on the failing fixture, with the contrastive book-to-see pairs
  holding at 0.89–0.92).
- `providerPreferenceExpressed` semantics are **adjudicated** (§5), with the
  historical artifacts preserved and the routing impact stated as null.
- Old evidence has **no critical regression** — routing 113/113, zero missed
  contacts, zero false handoffs across all four frozen-contract slices.
- The NEW holdout is **frozen** (47 ≥ 40), **disjoint** (0 leakage from every
  calibration/original/holdout/legacy selector) and **never executed** (§10).
- All required fingerprints **exist** and were recomputed against live source
  with `MANIFEST MISMATCHES: NONE`.
- Architecture/security invariants **hold** (110/110 offline checks, `pnpm
  verify` green, `pnpm security` clean, zero `src/` changes).

### **`READY_FOR_AI_JEV_02B_STAGE_B`**

**The next action is PROMPT-AI-JEV-02B-B.
Do not change contract/policy/labels/examples before executing it.**
