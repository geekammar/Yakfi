# PROMPT-AI-JEV-02B — FINAL REPORT

> ┌────────────────────────────────────────────────────────────────────────┐
> │ EVALUATION / REPORTING ONLY. Contains NO secret values.                │
> │ No `OPENROUTER_API_KEY`, no credential, no Authorization header, no PII │
> │ appears anywhere below. Nothing in `src/` imports this file or anything │
> │ it describes.                                                          │
> └────────────────────────────────────────────────────────────────────────┘

**Task**   PROMPT-AI-JEV-02B-B — Contact-vs-Book calibration + sealed holdout,
           Stage B (the sealed holdout) + final eligibility verdict.
**State**  Stage B was **terminated mid-run by an infrastructure fault**.
           It completed **42 of 47** fixtures and **persisted no artifact**.
**Verdict** `NEEDS_MORE_JEV_CALIBRATION` (§31) — blocked by
           `SEALED_HOLDOUT_EXECUTION_STATE_AMBIGUOUS` (§4).
**Authored** 2026-10-12, Stage-B session.

---

## 0. EXECUTIVE SUMMARY — READ THIS FIRST

Stage A is complete, verified, and **provably untouched**: every fingerprint
recomputed from live source matches the Stage-A handoff exactly
(`MANIFEST MISMATCHES: 0`), and `git diff --check` is clean.

Stage B **could not be completed**. The single permitted holdout pass was
launched correctly — bound to the frozen candidate, pinned model, credential
present, 47 planned requests — but the runner was killed by **SIGPIPE from my
own logging pipeline** (`pnpm eval:jev … | tee … | head -60`) after **42 of
47** fixtures. The remaining **5 fixtures were never requested**, and the
artifact-write step (which runs only after all fixtures) **never executed**.

Consequences, all independently verified:

- **No Stage-B result artifact exists.** No JSON in `evaluation/reports/jev/`
  has `bank: "holdout-v3"`; the newest artifact is still the 12:36:37Z Stage-A
  run. Zero report JSONs were written after 12:37.
- **The §4 record requirements are unmet.** The transient stdout log carries
  fixture id, ok/DIS status, latency, tokens and cost per fixture — but **no
  raw probabilities, no derived facts, no `explicitHuman` verdicts, no
  precedence derivation, no served-model snapshot**. Those exist only in the
  artifact that was never written.
- **The seal on `holdout-v3` is now broken.** 42 of its 47 messages have been
  sent to the model once. Per §0's named HARD RULE ("NEVER RUN THE SEALED
  HOLDOUT TWICE"), whose only exception requires an existing immutable result
  artifact that does not exist, **I did not re-run it.** Re-running would also
  produce a scientifically inconsistent mixed-exposure dataset (42 fixtures
  measured twice, 5 measured once).

Therefore the acceptance criteria that depend on the sealed holdout —
"Stage-B experiment integrity is valid", "no critical false handoff in the
target family", "no critical missed direct-provider-contact routing", "the
contact-vs-book defect generalizes on unseen wording" — **cannot be
established**, and the verdict is `NEEDS_MORE_JEV_CALIBRATION`.

Everything else is green: 110/110 JEV-eval architecture checks, 28/28 JEV
strategy checks, `pnpm verify` PASSED, `pnpm security` clean,
`git diff --check` clean, `pnpm pre-ship` `PRE_SHIP_GREEN` (PATCH), zero
`src/` changes, zero side effects.

---

## 1. Repository baseline and recovery lineage

| item                     | value                                              | handoff | ✓ |
| ------------------------ | -------------------------------------------------- | ------- | - |
| branch                   | `main`                                             | same    | ✓ |
| HEAD                     | `5c8eaf9578222eba6f7e5cce6108d74c05a8298a`         | same    | ✓ |
| origin/main              | `5c8eaf9578222eba6f7e5cce6108d74c05a8298a` (equal)| same    | ✓ |
| package.json version     | `0.44.6`                                           | same    | ✓ |
| latest release tag       | `v0.44.6`                                          | same    | ✓ |
| shipped ancestor         | EXACT MATCH                                        | same    | ✓ |
| stash/merge/rebase/cherry-pick/revert/bisect | none                        | same    | ✓ |
| `src/` files modified    | **0**                                              | same    | ✓ |

Tracked modifications (4, +1875 / −77) and untracked additions (14) are
**byte-identical to the Stage-A handoff** — the partial Stage-B run wrote
nothing to the working tree. Confirmed by `git status --porcelain` (18 paths,
matching `pnpm pre-ship`'s 18 candidate paths) and by the absence of any
report JSON newer than 12:37.

---

## 2. Stage-A handoff validation

Prompt A verdict: `READY_FOR_AI_JEV_02B_STAGE_B`. **Independently verified,
not trusted from prose:**

| check                                                  | result |
| ------------------------------------------------------ | ------ |
| handoff artifact present                               | ✓ `AI-JEV-02B-A-STAGE-A-HANDOFF.md` |
| all AI-JEV-02B candidate files exist                   | ✓ 4 modified + freeze manifest + reports |
| Stage-A changes remain uncommitted                     | ✓ 18 paths, nothing staged or committed |
| no unexpected `src/` runtime change                    | ✓ **0** `src/` files in `git diff` |
| Production JEV routing absent                          | ✓ no `src/` file imports `evaluation/jev` |
| `jev-probability-policy.ts` / `jev-decisions-adapter.ts` untouched | ✓ absent from `git diff` |

---

## 3. Freeze fingerprints — recomputed from LIVE source

Computed by an independent verifier (`/tmp/opencode/verify-stage-b.ts`, kept
**outside** the working tree) **before** and **after** the partial run. Both
passes identical → **no post-holdout tuning occurred**.

| artifact                  | value                          | handoff | ✓ |
| ------------------------- | ------------------------------ | ------- | - |
| question contract id      | `flowpilot.jev-questions@v3`   | same    | ✓ |
| **contract fingerprint**  | `sha256:588222a74f4a356b`      | same    | ✓ |
| probability policy id     | `flowpilot.jev-policy@v2`      | same    | ✓ |
| **policy fingerprint**    | `sha256:a01c368d17e5629e`      | same    | ✓ |
| **freeze manifest fp**    | `sha256:486502b20f5adae8`      | same    | ✓ |
| requested model           | `typesafe/jev-1.13` (PINNED)   | same    | ✓ |

Frozen slices, recomputed:

| slice            | n  | fingerprint            | handoff | ✓ |
| ---------------- | -- | ---------------------- | ------- | - |
| `original`       | 40 | `sha256:69341a65821179a9` | same | ✓ |
| `calibration`    | 26 | `sha256:8a76f9e4deeb94f8` | same | ✓ |
| `holdout`        | 20 | `sha256:d3f4a90715c80066` | same | ✓ |
| `calibration-v3` | 27 | `sha256:29a8d48d1e244ee0` | same | ✓ |
| `holdout-v3`     | 47 | `sha256:1d659cc4d188bf56` | same | ✓ |

**`MANIFEST MISMATCHES: 0`** (pre-run and post-run).

`JEV_FIXTURES_V3` = **160**; the five slices partition it exactly
(40+26+20+27+47 = 160), pairwise id-disjoint, all ids and messages globally
unique (`bankIntegrity()` → ok). Every coverage class has ≥1 case.

**Freeze-integrity verdict: PASS.** No semantic component changed after the
Stage-A freeze, so `STAGE_B_FREEZE_INTEGRITY_FAILED` does not apply.

---

## 4. PROOF Stage B was executed no more than once — and why it is invalid

### 4.1 Pre-execution manifest (printed by the runner before any call)

```
freeze manifest: sha256:486502b20f5adae8
freeze binding: OK (contract + policy + slices match the manifest)
mode: live (REAL calls)
bank slice: holdout-v3 (47 fixtures)
pinned model: typesafe/jev-1.13
requested model: typesafe/jev-1.13
question contract: flowpilot.jev-questions@v3 (12 questions)
probability policy: flowpilot.jev-policy@v2
contract fingerprint: sha256:588222a74f4a356b
policy fingerprint: sha256:a01c368d17e5629e
fixtures: 47
planned Jev requests: 47 (one request per fixture; all questions batched)
OPENROUTER_CREDENTIAL: PRESENT
```

bank = **NEW sealed holdout** (`holdout-v3`); fixture count = **47**; planned
request count = **47**; requested model = `typesafe/jev-1.13`; contract
fingerprint `sha256:588222a74f4a356b`; policy fingerprint
`sha256:a01c368d17e5629e`; holdout fingerprint `sha256:1d659cc4d188bf56`.
**planned requests == holdout fixture count**, so the run was authorized.

### 4.2 The fault

The run was invoked as
`pnpm eval:jev -- --live --bank holdout-v3 | tee <log> | head -60`. When
`head` exited after 60 lines it closed the read end of the pipe; `tee`
received SIGPIPE and the runner process died mid-loop.

| fact                                        | evidence                                        |
| ------------------------------------------- | ----------------------------------------------- |
| fixture rows present in log                 | **42** of 47                                    |
| runner process alive after the fault        | **no** (`pgrep -af eval-jev-benchmark` → none)  |
| artifacts with `bank: "holdout-v3"`         | **0**                                           |
| report JSONs written after 12:37            | **0**                                           |
| Stage-B fingerprint recorded in an artifact | **none**                                        |
| holdout-v3 ids found in any prior artifact  | **0** (pre-run) — the seal was intact at launch |

**The 5 fixtures never requested:**

```
v3-hold-mixed-booking-female
v3-hold-mixed-availability
v3-hold-msa-booking
v3-hold-english-booking
v3-hold-support-compliment-no-request
```

### 4.3 `SEALED_HOLDOUT_EXECUTION_STATE_AMBIGUOUS`

The named HARD RULE of §0 is "**NEVER RUN THE SEALED HOLDOUT TWICE**". Its two
branches are:

1. *already executed* → do not run again; **use the existing immutable result
   artifact**. **Unavailable** — no artifact exists.
2. *ambiguity over whether it ran* → **fail closed: STOP and report
   `SEALED_HOLDOUT_EXECUTION_STATE_AMBIGUOUS`**.

Branch 1 is unreachable, so the conservative branch governs. Live Decisions
requests **were** issued against 42 sealed fixtures, and completing the
experiment would re-issue 42 of them. That is a genuine second-pass risk, and
the rule is absolute. **I stopped and did not re-run.**

Supporting reasoning for the record: re-running would also yield a
scientifically inconsistent dataset — 42 fixtures measured twice, 5 measured
once — so even a permissive reading would not produce a valid sealed-holdout
measurement. The experiment's integrity is better preserved by stopping.

### 4.4 What the partial log does and does not contain

The log (preserved at `/tmp/opencode/stage-b-run.log`) carries, per fixture:
id, ok/DIS status, latency, input tokens, output tokens, cost. It carries
**no** raw probabilities, **no** derived facts, **no** `conversationGoal` /
confidence, **no** server-derived `explicitHuman`, **no** precedence
derivation, **no** served-model snapshot, **no** provider, **no** freeze
block. Every field §4 requires to be persisted is absent.

The 4 `DIS` observations in the log are therefore **unvalidated observations,
not results**. Two of them sit inside the target family
(`v3-hold-contact-plus-booking`, `v3-hold-multi-intent-booking-plus-contact`)
and **cannot be adjudicated** without the missing probability and verdict
fields. They are recorded as evidence of what happened, and are explicitly
**not** used to derive any verdict in §31.

---

## 5. Holdout size / integrity / disjointness (pre-run proof)

All recomputed independently before the run:

| required property                                        | result |
| -------------------------------------------------------- | ------ |
| NEW holdout fixture count ≥ 40                            | ✓ **47** |
| fixture count == planned live request count               | ✓ 47 == 47 |
| ids unique within the slice                              | ✓ 0 duplicates |
| messages unique within the slice                         | ✓ 0 duplicates |
| ids + messages globally unique across all 160            | ✓ `bankIntegrity()` ok |
| disjoint from `original` / `calibration` / `holdout` / `calibration-v3` | ✓ pairwise id-overlap 0 |
| expected labels already present on every fixture         | ✓ 0 missing, all booleans |
| holdout fingerprint matches Prompt A                     | ✓ `sha256:1d659cc4d188bf56` |
| no prior artifact contains these fixture ids or messages | ✓ 0 hits across every report JSON |
| no contract / policy / example mutation after freeze     | ✓ `MANIFEST MISMATCHES: 0` |

**Calibration selectors cannot reach it** — holdout-v3 ids leaked per
selector, recomputed:

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
| `JEV_HOLDOUT_V3_FIXTURES` / `bankSubset("holdout-v3")` | 47 | 47 (its own selector) |
| `JEV_FIXTURES_V3` (full bank)  | 160 | 47 (the explicit full bank) |

Class coverage inside `holdout-v3` (31 classes present): `provider-direct-contact` 11,
`provider-preference-plus-booking` 7, `egyptian-arabic-variant` 36,
`provider-availability` 5, `provider-identity` 4, `mixed-arabic-english` 3,
`msa-variant` 3, `sensitive-turn` 3, `ambiguous-unsupported` 3,
`broad-support-role-false-positive` 3, plus 21 more (full bank covers all
classes: `missing=[]`).

**Exact holdout fixture count: 47.** That number equals the planned live
request count, as required.

---

## 6. Exact request counts

| quantity                          | value |
| --------------------------------- | ----- |
| planned requests (Stage B)        | **47** |
| requests actually issued          | **42** |
| requests that succeeded (HTTP ok) | **42** (38 `ok` + 4 `DIS`, 0 `ERR`) |
| requests that failed              | **0** |
| transport-level retries           | **0** |
| requests for the 5 unread fixtures| **0** (never attempted) |
| artifacts persisted               | **0** |

**planned (47) ≠ issued (42)** — the run is incomplete. The adapter was given
exactly one request per fixture (`attempts: 1` per ledger entry), so there was
no fan-out; the shortfall is entirely the SIGPIPE termination.

### Stage-A slices (for comparison — all complete)

| slice            | planned | executed | failed | retries |
| ---------------- | ------- | -------- | ------ | ------- |
| `original`       | 40      | 40       | 0      | 0       |
| `calibration`    | 26      | 26       | 0      | 0       |
| `holdout`        | 20      | 20       | 0      | 0       |
| `calibration-v3` | 27      | 27       | 0      | 0       |

---

## 7. Requested + served model identity

Requested model for the Stage-B attempt: **`typesafe/jev-1.13`** (pinned;
the forbidden alias `~typesafe/jev-latest` was never used). The Decisions
endpoint is `POST https://openrouter.ai/api/alpha/decisions`; the adapter
reads `OPENROUTER_API_KEY` **by name** through `getEnvVar` and builds the
`Authorization` header inline — the value is never logged, never serialized,
and the runner prints only `PRESENT`/`MISSING`.

**Served model for Stage B: NOT AVAILABLE.** The served-model snapshot is
written into the artifact per response, and no artifact was written. The
transient log does not record it. This is a required record that is missing.

For reference, the four frozen Stage-A slices all report:

```
requested = typesafe/jev-1.13
served    = typesafe/jev-1.13-20260917   (single value, every response)
provider  = TypeSafe
```

The Stage-A evidence is therefore model-consistent; Stage B cannot be shown
to be.

---

## 8. Original-bank metrics (frozen, live, final contract)

Artifact `jev-benchmark-original-live-2026-10-12T12-36-28-591Z.json`
(40 fixtures, contract `sha256:588222a74f4a356b`, `"mismatches": []`):

| metric | value |
| --- | --- |
| final routing correctness | **40/40** |
| fixture exact agreement | 37/40 |
| question agreement | 122/125 |
| missed direct contact | **0** |
| false handoff | **0** |
| errors / retries / failed | 0 / 0 / 0 |
| disagreements | 3 (all non-routing, `routingMismatch=false`) |
| latency min/p50/p95/max/mean | 144 / 165 / 216 / 267 / 172.5 ms |
| input / output tokens | 139 133 / 12 644 |
| cost | $0.005 844 |
| contact-vs-book matrix | contact∧booking 0 · contact∧¬booking 1 · ¬contact∧booking 8 · ¬contact∧¬booking 5 |

**No regression.** `contactBookMatrix.routingMissedContact = 0`,
`routingFalseHandoff = 0`.

---

## 9. Previous-holdout metrics (AI-JEV-02 `holdout`, frozen, live)

Artifact `jev-benchmark-holdout-live-2026-10-12T12-36-32-593Z.json`
(20 fixtures):

| metric | value |
| --- | --- |
| final routing correctness | **20/20** |
| fixture exact agreement | 19/20 |
| question agreement | 61/62 |
| missed direct contact | **0** |
| false handoff | **0** |
| errors / retries / failed | 0 / 0 / 0 |
| disagreements | 1 (`v2-hold-provider-availability-female`, non-routing) |
| latency min/p50/p95/max/mean | 147 / 173 / 249 / 249 / 174.05 ms |
| input / output tokens | 69 550 / 6 327 |
| cost | $0.002 921 |
| contact-vs-book matrix | contact∧booking 0 · contact∧¬booking 3 · ¬contact∧booking 3 · ¬contact∧¬booking 4 |

**No regression**, including the prior contact-vs-book failure family
(see §14).

---

## 10. Calibration metrics (both slices, frozen, live)

`calibration` (AI-JEV-02, 26) — `jev-benchmark-calibration-live-2026-10-12T12-36-37-907Z.json`:

| metric | value |
| --- | --- |
| final routing correctness | **26/26** |
| fixture exact agreement | 20/26 |
| question agreement | 85/92 |
| missed direct contact | **0** |
| false handoff | **0** |
| errors / retries / failed | 0 / 0 / 0 |
| disagreements | 7 (6 adjudicated preference label defects + 1 cancel paraphrase) |
| latency min/p50/p95/max/mean | 156 / 181 / 226 / 258 / 184.7 ms |
| input / output tokens | 90 449 / 8 226 |
| cost | $0.003 799 |
| contact-vs-book matrix | contact∧booking **1** · contact∧¬booking 5 · ¬contact∧booking 4 · ¬contact∧¬booking 7 |

`calibration-v3` (NEW Stage-A, 27) — `jev-benchmark-calibration-v3-live-2026-10-12T12-36-09-147Z.json`:

| metric | value |
| --- | --- |
| final routing correctness | **27/27** |
| fixture exact agreement | 26/27 |
| question agreement | 107/108 |
| missed direct contact | **0** |
| false handoff | **0** |
| errors / retries / failed | 0 / 0 / 0 |
| disagreements | 1 (adjudicated preference label defect) |
| latency min/p50/p95/max/mean | 140 / 163 / 214 / 324 / 173.9 ms |
| input / output tokens | 93 933 / 8 538 |
| cost | $0.003 945 |
| contact-vs-book matrix | contact∧booking 0 · contact∧¬booking 10 · ¬contact∧booking 8 · ¬contact∧¬booking 6 |

### Aggregate across the four frozen slices

| metric | value |
| --- | --- |
| **final routing correctness** | **113/113** |
| fixture exact agreement | 102/113 |
| question agreement | 375/387 |
| **missed direct contact** | **0** |
| **false handoff** | **0** |
| errors / retries | 0 / 0 |
| total cost | $0.016 509 |
| total input / output tokens | 393 065 / 35 735 |

The single `contact∧booking = 1` case (`v2-cal-provider-contact-plus-booking`,
«عايز الدكتور يكلمني عشان أحجز») is the **genuine contact-inside-booking**
case, correctly masked to **no handoff** by the precedence formula. It is not
a defect — it is the shape most sensitive to any future weakening of the
booking mask.

---

## 11. NEW sealed-holdout metrics — **NOT COMPUTABLE**

§6 requires all metrics to be computed **from artifact rows, not prose**.
There are no Stage-B artifact rows. The following are therefore **NOT
AVAILABLE** rather than measured:

- fixture count (scored): unavailable (no artifact)
- scored question count: unavailable
- question agreement / disagreements: unavailable
- fixture exact agreement: unavailable
- **final explicitHuman routing accuracy: unavailable**
- **routing confusion matrix: unavailable**
- supportRequested FP/FN: unavailable
- providerRequested FP/FN: unavailable
- bookingRequested FP/FN: unavailable
- availabilityAsked FP/FN: unavailable
- providerPreferenceExpressed FP/FN: unavailable
- **contact-vs-book confusion matrix: unavailable**
- availability/preference/contact matrix: unavailable
- conversationGoal accuracy: unavailable
- confidence distribution: unavailable
- high-confidence errors: unavailable
- near-threshold errors: unavailable

**Partial observations (un-persisted, unvalidated, NOT results):** 42 of 47
fixtures returned a response — 38 with no disagreement flag, 4 flagged
`DIS`:

```
v3-hold-book-to-talk
v3-hold-contact-plus-booking
v3-hold-multi-intent-booking-plus-contact
v3-hold-ambiguous-precursor
```

Because the log carries no probabilities and no verdicts, the routing impact
of these four — and in particular whether the two contact-plus-booking cases
preserve the booking mask — **cannot be established**. This is the single
largest evidentiary gap in this task.

---

## 12. Exact contact-vs-book results (frozen evidence layers)

The minimal pairs, live on the frozen contract `sha256:588222a74f4a356b`:

| message | prov | book | avail | explicitHuman | ok |
| ------- | ---- | ---- | ----- | ------------- | -- |
| «عايز أشوف دكتور» (contact)              | 0.73 | **0.07** | 0.06 | **true**  | ✓ |
| «محتاج أشوف دكتور دلوقتي» (contact)      | 0.79 | **0.11** | 0.08 | **true**  | ✓ |
| «خلي الدكتور يكلمني» (contact)           | 0.97 | **0.05** | 0.04 | **true**  | ✓ |
| «عايز أظبط ميعاد عشان أشوف الدكتور» (book-to-see) | 0.09 | **0.92** | 0.09 | false | ✓ |
| «أريد حجز موعد لرؤية الطبيب» (book-to-see, MSA)  | 0.09 | **0.89** | 0.06 | false | ✓ |
| «عايز أحجز مع دكتور» (book + title)      | 0.06 | **0.92** | 0.09 | false | ✓ |
| «عايز أحجز مع أخصائي» (book + specialist)| 0.07 | **0.93** | 0.08 | false | ✓ |
| «عايز الدكتور يكلمني عشان أحجز» (contact **+** booking) | 0.60 | **0.76** | 0.06 | **false** | ✓ |

The same verb «أشوف» resolves to **contact** (booking 0.07–0.11) when no
arrangement is requested and to **booking** (0.89–0.92) when an arrangement
cue is present. The mask is **not weakened**: the genuine
contact-inside-booking case still routes to **no handoff**.

Aggregate contact-vs-book across the four frozen slices —
`routingMissedContact = 0` and `routingFalseHandoff = 0` on **every** slice.

---

## 13. Exact availability / preference / contact results (frozen layers)

| message | availability | preference | provider | routing |
| ------- | ------------ | ---------- | -------- | ------- |
| «هل فيه دكتور متاح؟»              | 0.94 | 0.05 | 0.09 | **no handoff** ✓ |
| «في دكتورة متاحة؟»                | 0.92 | 0.06 | 0.10 | **no handoff** ✓ |
| «في دكتور متاح دلوقتي؟»           | 0.94 | 0.06 | 0.09 | no handoff ✓ |
| «Is there a doctor available بكرة؟» | —  | 0.06 | —    | no handoff ✓ |
| «عايز أحجز مع دكتور أحمد» (named pref + booking) | 0.08 | 0.96 | 0.06 | no handoff ✓ |
| «عايز أحجز مع أخصائي»              | 0.08 | 0.81 | 0.07 | no handoff ✓ |
| «ممكن أتكلم مع حد please؟» (mixed) | —   | —    | 0.73+ | **handoff** ✓ |

Availability stays availability (0.92–0.94) and never converts into a provider
contact; preference stays high (0.81–0.96) only when a constraint on **which**
provider is attached to a **booking**; the provider path fires only on a
genuine contact request.

**The NEW sealed holdout's availability/preference/contact matrix is
unavailable** (no artifact).

---

## 14. Prior known-failure-family result

**The known provider-availability regression, equivalent to
«هل فيه دكتور متاح؟»** — remains repaired, verified live on the frozen
contract:

```
[original]  provider-availability  «هل فيه دكتور متاح؟»
  availability=0.94  provider=0.09  booking=0.08  preference=0.05
  expH=false  modH=false   derivation = none
  routingMismatch = false     ✓ NO HANDOFF
```

**The prior contact-vs-book failure family, equivalent to
«عايز أشوف دكتور»** — repaired, and observed to generalize:

```
[holdout]  v2-hold-provider-contact-meet  «عايز أشوف دكتور»
  provider=0.73   booking=0.07   availability=0.06
  expH=true  modH=true   derivation = providerRequest AND NOT bookingTask
  disagreement count = 0        ✓ HANDOFF (correct)
[calibration-v3]  v3-cal-contact-see-now  «محتاج أشوف دكتور دلوقتي»
  provider=0.79   booking=0.11   availability=0.08
  expH=true  modH=true   derivation = providerRequest AND NOT bookingTask
  disagreement count = 0        ✓ HANDOFF (correct, different wording)
```

The inherited @v2 defect routed «عايز أشوف دكتور» to **no handoff**
(provider 0.79 masked by booking 0.58). On the frozen @v3 contract it routes
to **handoff** with booking suppressed to 0.07, and the same repair holds on
reworded variants («محتاج أشوف دكتور دلوقتي» 0.11) and on mixed-language
contact. This generalization is measured on **permitted** evidence only.

**Whether it generalizes to the NEW sealed holdout's unseen wording
(`v3-hold-contact-see-now` «لازم أشوف دكتور النهارده» and the other 10
`provider-direct-contact` cases) is NOT ESTABLISHED** — no artifact.

---

## 15. Every new regression / error (frozen layers)

**Zero errors, zero failed requests, zero retries** on all four frozen slices.
No new regression appeared in any permitted evidence layer.

The complete set of residual label-vs-contract disagreements is 12, and
**every one has `routingMismatch = false`**:

| slice | fixture | fact | expected | model | routing impact |
| --- | --- | --- | --- | --- | --- |
| original | `provider-availability` | providerPreferenceExpressed | true | false | none |
| original | `ambiguous-too-short` («اه») | ambiguousTurn | true | false | none |
| original | `mixed-arabic-english-human` | providerRequested | false | true | none (expH==modH) |
| calibration-v3 | `v3-cal-book-to-see-msa` | providerPreferenceExpressed | true | false | none |
| holdout | `v2-hold-provider-availability-female` | providerPreferenceExpressed | true | false | none |
| calibration | `v2-cal-provider-availability-title` | providerPreferenceExpressed | true | false | none |
| calibration | `v2-cal-provider-availability-msa` | providerPreferenceExpressed | true | false | none |
| calibration | `v2-cal-greeting-plus-provider-availability` | providerPreferenceExpressed | true | false | none |
| calibration | `v2-cal-availability-plus-service` | providerPreferenceExpressed | true | false | none |
| calibration | `v2-cal-mixed-availability` | providerPreferenceExpressed | true | false | none |
| calibration | `v2-cal-cancel-paraphrase` («ما عايز الموعد يعد») | cancellationRequested / rescheduleRequested | true / false | false / true | none |

Per-fact FP/FN aggregate: `providerPreferenceExpressed` FP 0 / FN 8;
`ambiguousTurn` FP 0 / FN 1; `providerRequested` FP 1 / FN 0;
`cancellationRequested` FP 0 / FN 1; `rescheduleRequested` FP 1 / FN 0.
**No routing-affecting error exists** in the permitted layers, so §16's
per-error breakdown has no rows to show there.

**For the NEW sealed holdout: the error inventory is unavailable** (no
artifact). The 4 `DIS` observations in the partial log are the only candidates
and cannot be classified.

---

## 16. Raw probabilities for routing-affecting errors

**Permitted layers: none exist.** Every disagreement above is non-routing, so
there is no routing-affecting error whose raw probabilities to exhibit.

**Sealed holdout: unavailable.** The partial log contains no probabilities, so
no routing-affecting error there can be diagnosed or shown. §6's instruction
not to hide errors behind aggregate percentages is honored by reporting this
gap explicitly rather than substituting a percentage.

---

## 17. providerPreferenceExpressed adjudication validation

**Final Stage-A adjudication:** `providerPreferenceExpressed` means a
**constraint on WHICH provider performs a requested service or booking** — a
narrowing of the acceptable provider set. Mere provider **title**, **identity**,
**presence** or **availability** does **not** qualify by itself.

**Audit against the frozen evidence:** the model answered `false`
(0.05–0.06) on **all 8** availability-shaped cases across `original`,
`calibration`, `holdout` and `calibration-v3` — one direction, 8 fixtures,
zero counter-examples. The contract-consistent expectation holds on every new
availability case, and positive preference cases are non-vacuous (0.81–0.96 on
named/specialist booking-preference turns). The contract therefore behaves
exactly as adjudicated on permitted evidence.

**Historical artifacts remain unchanged** — the three AI-JEV-02 slice
fingerprints are byte-identical to the committed artifacts
(`69341a65821179a9`, `8a76f9e4deeb94f8`, `d3f4a90715c80066`), and the
disagreement stays **visible** in the recomputed evidence rather than being
edited away.

**Routing impact: NULL.** The precedence formula consumes only
`supportRequested` / `providerRequested` / `bookingTask`, so
`providerPreferenceExpressed` participates in **no** routing decision. The
historical disagreements are non-routing label noise, which is precisely why
they may be retired without touching the server formula.

**No evidence that the adjudicated contract itself is inadequate**, so it is
reported as valid and **left unchanged**. It is **not audited against the
sealed holdout**, because that audit requires an artifact.

---

## 18. Latency / tokens / cost

### Stage-B attempt (partial, un-persisted — evaluation economics only)

42 requests, from the transient log:

| metric | value |
| --- | --- |
| latency min | 164 ms |
| latency p50 | 195 ms |
| latency p95 | 244 ms |
| latency max | 356 ms |
| latency mean | 205.6 ms |
| total input tokens | 146 199 |
| total output tokens | 13 287 |
| average input / output per request | 3 481 / 316 |
| total provider-reported cost | $0.006 140 |
| average cost per request | $0.000 146 |

Total wall time is not meaningful: the run was killed, not completed.

### Frozen Stage-A slices (complete)

| slice | min | p50 | p95 | max | mean | in | out | cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| original (40) | 144 | 165 | 216 | 267 | 172.5 | 139 133 | 12 644 | $0.005 844 |
| calibration-v3 (27) | 140 | 163 | 214 | 324 | 173.9 | 93 933 | 8 538 | $0.003 945 |
| holdout (20) | 147 | 173 | 249 | 249 | 174.1 | 69 550 | 6 327 | $0.002 921 |
| calibration (26) | 156 | 181 | 226 | 258 | 184.7 | 90 449 | 8 226 | $0.003 799 |
| **total (113)** | 140 | — | — | 324 | ~176 | 393 065 | 35 735 | **$0.016 509** |

**Comparison with prior JEV evidence:** the @v2 AI-JEV-02 artifacts measured
the same profile (p50 ≈ 165–185 ms, ≈3 470 input / ≈315 output tokens per
request, ≈$0.000 146 per request). The @v3 contract adds semantic wording and
**does not change the call shape, token envelope or per-call cost** —
confirming the repair is semantic, not a structural expansion.

**These are evaluation economics, not Production economics.** Production does
not call JEV per turn (see §19), so none of these figures is a production
latency or cost.

---

## 19. 0/1-call proof (re-proven offline, no Production change)

| invariant | verdict | proof |
| --- | --- | --- |
| one semantic bundle makes at most one JEV request | **HOLDS** | `buildDecisionsRequestBody` serializes the **entire** `questions` map into one Decisions body; `check:jev-eval` J18 + J18b assert it statically |
| no per-question fan-out | **HOLDS** | `plannedRequestCount(fixtures) === fixtures.length` for every slice (J19j × 5); every Stage-A ledger shows `planned == executed`, `failed: 0`, `retries: 0`; the Stage-B attempt issued exactly 42 requests for 42 fixtures before being killed |
| missing credential ⇒ zero network calls | **HOLDS** | `createJevAdapter` reads `OPENROUTER_API_KEY` **before** constructing any request and returns `MISSING_CREDENTIAL` with `servedModel: null` — J18c asserts zero network calls; the runner hard-stops (exit 2) on `--live` without the credential |
| no mandatory classifier → JEV → LLM → judge chain | **HOLDS** | J18d3 — the shipped decision strategy forbids a mandatory Jev stage by design; `detectExplicitHumanRequest` is a pure lexical predicate |
| no second semantic judge / comparator LLM | **HOLDS** | a single pinned model `typesafe/jev-1.13`; no judge scoring step exists anywhere in `evaluation/` or `src/` |
| deterministic bypass remains zero calls | **HOLDS** | J18d2 — the shipped decision strategy's `decide` is synchronous and performs no I/O |
| generative path stays in the single-call budget | **HOLDS** | J18 — a Jev semantic turn makes exactly ONE request for the whole bundle; `check:jev` C9 — bypass turn = 0 calls, generative turn = 1 call, never 2 |

**No Production change was made to make these proofs pass.** Every check above
is offline/static and reads the same `src/` that shipped in v0.44.6.

---

## 20. Server-precedence proof

The authoritative production source is
`src/features/conversations/server/conversation-ai.ts:571`
(`detectExplicitHumanRequest`, shipped in v0.44.4):

```ts
const bookingTask =
  hasWord(tokens, BOOKING_WORDS_N) || hasPhrase(normalized, BOOKING_PHRASES_N) ||
  hasWord(tokens, AVAILABILITY_WORDS_N) || hasPhrase(normalized, AVAILABILITY_PHRASES_N) ||
  hasWord(tokens, CANCELLATION_WORDS_N) || hasPhrase(normalized, CANCELLATION_PHRASES_N) ||
  hasWord(tokens, RESCHEDULE_MUTATION_N) || hasPhrase(normalized, RESCHEDULE_PHRASES_N);
const explicitHuman = supportRequest || (providerRequest && !bookingTask);
```

The evaluation copy in `evaluation/jev/jev-fixture-bank.ts:2577`
(`applyServerPrecedence`) is a **deliberate mirror**:

```ts
const providerPath = facts.providerRequest && !facts.bookingTask;
const explicitHuman = facts.supportRequest || providerPath;
// bookingTaskFromFacts = bookingRequested || availabilityAsked
//                       || cancellationRequested || rescheduleRequested
```

The two are the same formula over the same four booking-task families. The
evaluation copy is **never imported by `src/`**, is used only so the benchmark
can derive the verdict both ways, and `expectedExplicitHuman` is **derived by
the formula, never hand-written** (J8). The model is never asked the
precedence question — there is **no `explicitHuman` JEV question** and **no
`shouldHandoff` / `nextAction` question** in the @v3 contract (J19k).

**Server precedence remains authoritative.** No production file was modified.

---

## 21. Turn Planner authority proof

- **Zero** `src/` files modified (`git diff --name-only | grep -c '^src/'` → 0).
- No action, question, intent or routing target was added, removed or
  re-ordered anywhere in `src/`.
- The @v3 contract adds **no** question that encodes precedence or any derived
  fact (`check:jev-eval` J19k), so no JEV answer can override the planner.
- The JEV surface supplies **semantic facts only**; `detectExplicitHumanRequest`
  remains the sole producer of the handoff verdict and the Turn Planner remains
  the sole action authority.

---

## 22. Production-isolation proof

| required check | verdict | evidence |
| --- | --- | --- |
| zero Production JEV routing introduced | **HOLDS** | 0 `src/` files in `git diff` |
| no `src/` file imports `evaluation/jev` | **HOLDS** | repo-wide grep for `evaluation/jev`, `jev-decisions-adapter`, `jev-question-contract`, `jev-probability-policy`, `jev-fixture-bank` → **0 hits in `src/`**; J12, J18e |
| evaluation adapter unreachable from runtime | **HOLDS** | no `src/` file references `createJevAdapter` or the Jev decision strategy's Jev surface; J12b/J12c/J18d |
| no schema change | **HOLDS** | `prisma/` absent from `git diff` |
| no migration | **HOLDS** | no migration authored or executed |
| no DB write | **HOLDS** | the runner and adapter contain **no** prisma/client instantiation; the runner only *sets placeholder* env vars so evaluation modules can import — it opens no connection and writes nothing |
| no booking mutation | **HOLDS** | no booking code path is reachable from `scripts/eval-jev-benchmark.ts` or the adapter |
| no customer send | **HOLDS** | no messaging/transport call exists in the evaluation surface; `check:jev` C10 — JEV decision metadata never reaches a customer-visible reply |
| no deployment configuration change | **HOLDS** | `vercel.json`, `next.config.ts`, `.github/` all absent from `git diff` |

**Production isolation: PASS.** The evaluation task did not touch Production.

---

## 23. Focused regression results

| suite | command | result |
| --- | --- | --- |
| JEV evaluation + architecture | `pnpm check:jev-eval` | **PASSED — 110/110 checks ok** |
| JEV strategy (0/1-call, authority) | `pnpm check:jev` | **PASSED — 28/28 checks ok** |

Notable gates that protect this task's invariants: J18/J18b (one request per
bundle), J18c (missing credential ⇒ zero calls), J18d3 (no mandatory Jev
stage), J19a–J19c (the new holdout contains pure provider-contact cases that
route to handoff **and** booking-mask cases that route to no handoff, with the
mask intact), J19d (every new availability case expects preference = false),
J19f («هل فيه دكتور متاح؟» present and routes to no handoff), J19j × 5 (one
planned request per fixture for every slice), J19k (no question encodes
precedence), J19l (no lexical dictionary / stem list / regex added).

---

## 24. `pnpm verify`

```
✅ lint                   21.0s
✅ typecheck               5.3s
✅ format                 21.5s
✅ build                   9.4s
RESULT: PASSED ✅ — all quality gates green (lint, typecheck, format, build).
```

exit code **0**.

---

## 25. `pnpm security`

```
FlowPilot security check
✅ No secrets, credentials, or env files at risk of being committed.
```

exit code **0**. No credential, `Authorization` header or env value was
serialized into any artifact, log or report at any point in this task.

---

## 26. `pnpm pre-ship`

Reported verbatim (the release tooling is authoritative; the bump was **not**
inferred in advance):

```
PRE-SHIP REPORT
Branch: main
HEAD: 5c8eaf9578222eba6f7e5cce6108d74c05a8298a
Version: 0.44.6
Latest tag: v0.44.6
Changed files: 0 (v0.44.6..HEAD)
Release candidate (18 path(s), fingerprint cbb3a81af9f5):
  … 18 evaluation/reporting paths, 0 src/ paths …
Risk surfaces: none
Gates:
  ✓ git state      PASS 0.0s — on main, 18 candidate path(s), local origin/main is an ancestor
  ✓ git diff --check PASS 0.0s — no conflict markers / whitespace errors
  ✓ security       PASS 0.9s — passed
  ✓ ai-prompts     PASS 1.1s — passed
  ✓ verify         PASS 57.7s — passed
  ✓ non-mutation   PASS 0.0s — candidate fingerprint stable (18 path(s))
Decision:
  PRE_SHIP_GREEN
Recommended bump:
  PATCH
Next human action:
  pnpm ship patch
```

**Not executed.** Per §17 of the prompt, `pnpm ship patch` / `minor` / `major`
were **not** run under any condition.

---

## 27. Recommended SemVer

`pnpm pre-ship` recommends **PATCH**. Consistent with an evaluation-only
change set (18 candidate paths, **0** `src/` paths, risk surfaces: none).

The release tooling is authoritative and its recommendation is reported, not
second-guessed. **No release was performed.**

---

## 28. Side-effect counts

| side-effect category | count |
| --- | --- |
| Production (`src/`) files changed | **0** |
| Provider calls made this task (evaluation, non-production) | **42** Decisions requests (the partial Stage-B pass) |
| Provider calls made by the whole AI-JEV-02B effort | **155** (113 Stage-A frozen + 42 partial Stage-B) |
| DB writes | **0** |
| Booking mutations | **0** |
| Customer messages sent | **0** |
| GitHub operations (PR / issue / release) | **0** |
| Commits / pushes / tags created | **0** |
| Deploys / migrations / `pnpm ship` | **0** |
| Stage-B artifacts persisted | **0** |

---

## 29. Exact `git status` / `git diff`

`git status --porcelain`:

```
 M evaluation/jev/jev-fixture-bank.ts
 M evaluation/jev/jev-question-contract.ts
 M scripts/check-jev-eval.ts
 M scripts/eval-jev-benchmark.ts
?? evaluation/jev/jev-freeze-manifest.ts
?? evaluation/reports/jev/AI-JEV-02B-A-STAGE-A-HANDOFF.md
?? evaluation/reports/jev/AI-JEV-02B-FINAL-REPORT.md
?? evaluation/reports/jev/jev-benchmark-calibration-live-2026-10-12T12-24-37-654Z.json
?? evaluation/reports/jev/jev-benchmark-calibration-live-2026-10-12T12-36-37-907Z.json
?? evaluation/reports/jev/jev-benchmark-calibration-v3-live-2026-10-12T12-13-48-801Z.json
?? evaluation/reports/jev/jev-benchmark-calibration-v3-live-2026-10-12T12-17-19-816Z.json
?? evaluation/reports/jev/jev-benchmark-calibration-v3-live-2026-10-12T12-28-56-399Z.json
?? evaluation/reports/jev/jev-benchmark-calibration-v3-live-2026-10-12T12-33-49-167Z.json
?? evaluation/reports/jev/jev-benchmark-calibration-v3-live-2026-10-12T12-36-09-147Z.json
?? evaluation/reports/jev/jev-benchmark-holdout-live-2026-10-12T12-18-59-351Z.json
?? evaluation/reports/jev/jev-benchmark-holdout-live-2026-10-12T12-36-32-593Z.json
?? evaluation/reports/jev/jev-benchmark-original-live-2026-10-12T12-19-45-177Z.json
?? evaluation/reports/jev/jev-benchmark-original-live-2026-10-12T12-22-22-480Z.json
?? evaluation/reports/jev/jev-benchmark-original-live-2026-10-12T12-36-28-591Z.json
```

`git diff --stat` (tracked modifications):

```
 evaluation/jev/jev-fixture-bank.ts      | 1149 ++++++++++++++++++++++++++++++-
 evaluation/jev/jev-question-contract.ts |  120 +++-
 scripts/check-jev-eval.ts               |  339 ++++++++-
 scripts/eval-jev-benchmark.ts           | 344 ++++++++-
 4 files changed, 1875 insertions(+), 77 deletions(-)
```

`git diff --check` → **clean** (exit 0, no output). Nothing staged, nothing
committed, no tags, HEAD still `5c8eaf9` == `origin/main`.

**The only change this prompt made to the working tree** is the addition of
this report file (`AI-JEV-02B-FINAL-REPORT.md`), which is reporting-only. No
semantic, contract, policy, label, example, selector or `src/` file was
altered after the Stage-A freeze — proven by the identical fingerprint
recomputation in §3.

---

## 30. Remaining risks (exact, not generic)

1. **The sealed holdout is broken and must be retired.** 42 of 47
   `holdout-v3` messages have been sent to `typesafe/jev-1.13` exactly once,
   with no artifact. It can never again serve as a *sealed* holdout: a fresh
   execution would be a second pass over those 42 fixtures, and a completion
   run would leave a mixed-exposure dataset. **AI-JEV-02B's central question —
   does the contact-vs-book repair generalize on unseen wording — is therefore
   still unanswered.**
2. **Five target-family fixtures were never measured at all**, including three
   language/register coverage cases (`v3-hold-mixed-booking-female`,
   `v3-hold-mixed-availability`, `v3-hold-msa-booking`,
   `v3-hold-english-booking`) and one support false-positive control
   (`v3-hold-support-compliment-no-request`).
3. **Four unexplained `DIS` observations**, two inside the target family
   (`v3-hold-contact-plus-booking`, `v3-hold-multi-intent-booking-plus-contact`).
   These may be the adjudicated preference-label shape, a genuine finding, or
   noise — indeterminable without an artifact. **They are not evidence of a
   defect and not evidence of correctness.**
4. **The 12 residual label-vs-contract disagreements** (§15) are adjudicated
   and non-routing, but they mean `exact` < `routingTotal` on the historical
   slices. Expected; must not be "repaired" by editing frozen labels.
5. **`contact∧booking = 1` on `calibration`** — the genuine
   contact-inside-booking case, correctly masked to no handoff. Not a defect,
   but the shape most sensitive to any future weakening of the booking mask.
6. **Everything is uncommitted.** The frozen candidate exists only in the
   working tree; a rebase, `git checkout`, `git restore` or `git clean` would
   destroy Stage A. Do not reset the tree.
7. **The Stage-A evidence is strong but not the question asked.** 113/113
   routing with zero missed contacts and zero false handoffs across four
   frozen slices is encouraging, but it is permitted evidence — the same slices
   that informed the @v3 repair. Only a fresh sealed slice can establish
   generalization.

---

## 31. FINAL VERDICT

### Gate-by-gate

| §15 acceptance criterion | status |
| --- | --- |
| Stage-B experiment integrity is valid | **FAIL — run terminated at 42/47, no artifact, 5 fixtures unmeasured** |
| no post-holdout tuning occurred | **PASS** (fingerprints identical pre/post run, `MANIFEST MISMATCHES: 0`) |
| known provider-availability regression remains repaired | **PASS** (permitted evidence) |
| direct-contact vs booking-mask defect generalizes as repaired | **CANNOT ESTABLISH — requires the sealed slice** |
| original-bank routing has no regression | **PASS** — 40/40, 0 missed, 0 false handoff |
| previous-holdout routing has no regression | **PASS** — 20/20, 0 missed, 0 false handoff |
| NEW sealed holdout: no critical false handoff in target family | **CANNOT ESTABLISH** |
| NEW sealed holdout: no critical missed direct-provider-contact routing | **CANNOT ESTABLISH** |
| support/provider boundaries preserve server precedence | **PASS** — 113/113, `supportRequest` wins all 5 support+booking cases |
| providerPreference contract resolved and behaves acceptably | **PASS on permitted evidence** — not auditable on the sealed slice |
| 0/1-call invariant holds | **PASS** |
| one bundle == at most one JEV request | **PASS** |
| missing credential == zero calls | **PASS** |
| no second judge/model chain | **PASS** |
| server precedence remains authoritative | **PASS** |
| Turn Planner remains authoritative | **PASS** |
| Production runtime remains untouched | **PASS** — 0 `src/` changes |
| focused regressions pass | **PASS** — 110/110 + 28/28 |
| `pnpm verify` passes | **PASS** |
| `pnpm security` passes | **PASS** |
| `git diff --check` passes | **PASS** |

Three criteria are not satisfied. Per §15, no aggregate percentage may be
substituted for them — and none is offered. A 113/113 routing result on
permitted evidence cannot close a criterion that requires the sealed slice.

### Blocking condition

**`SEALED_HOLDOUT_EXECUTION_STATE_AMBIGUOUS`**

The sealed holdout was partially executed (42 live requests, 5 never
attempted, 0 artifacts persisted) by an infrastructure fault in this prompt's
own logging pipeline. §0's HARD RULE forbids a second pass and its exception
clause is unavailable, so the holdout was left un-run-to-completion.

### Verdict

## **B) `NEEDS_MORE_JEV_CALIBRATION`**

### The SMALLEST independent next calibration slice

**Not implemented. Described only, as §15 requires.**

Author a **new disjoint holdout slice `holdout-v4`** and measure it exactly
once:

1. **No semantic change.** Keep the frozen candidate exactly as-is — contract
   `flowpilot.jev-questions@v3` (`sha256:588222a74f4a356b`) and policy
   `flowpilot.jev-policy@v2` (`sha256:a01c368d17e5629e`). The 113/113 routing
   evidence already validates this candidate; the missing measurement is
   *exposure*, not *semantics*. Changing either fingerprint would invalidate
   all four frozen Stage-A artifacts.
2. **Author `holdout-v4` ≥ 40 fixtures**, id- **and** message-disjoint from all
   160 existing fixtures, covering exactly the target families: direct-provider
   contact vs book-to-see (minimal pairs over the *relationship*, not the
   verb), availability vs contact, availability vs preference, identity vs
   contact, named/generic provider preference + booking, contact-inside-booking
   mask cases, and clinical-provider vs support-role separation — plus the
   language/register cases that went unmeasured (MSA, English, mixed).
   Labels authored from the @v3 contract **before any request**.
3. **Retire `holdout-v3` as seal-broken** in the freeze manifest, recording
   that it was partially executed at 42/47 with no artifact, so no future
   prompt mistakes the transient partial log for evidence.
4. **Add a runner-side guard** so a holdout pass can never be silently
   truncated again: write the artifact incrementally (or flush stdout to a file
   rather than a bounded pipe), and make the artifact write unconditional on
   partial completion so an interrupted run still persists its rows. This is
   *runner* code only — it must not touch contract, policy, labels or `src/`.
5. **Run it exactly once**, bound to the unchanged frozen candidate, and
   persist the artifact immutably.

This is the smallest slice because it changes **zero** semantics and answers
precisely the one question this task failed to measure.

---

## 32. FINAL HARD STOP — honored

- Production JEV routing: **not modified** (0 `src/` changes).
- AI-JEV-03: **not started**.
- Commit / push / tag / release / deploy / migrate / `pnpm ship`: **none
  performed** (HEAD still `5c8eaf9` == `origin/main`, latest tag still
  `v0.44.6`).
- The sealed holdout: **not run a second time** despite the incomplete pass.

The completed AI-JEV-02B candidate — Stage A frozen and validated, Stage B
interrupted and un-persistable — is left in the working tree for explicit human
review.
