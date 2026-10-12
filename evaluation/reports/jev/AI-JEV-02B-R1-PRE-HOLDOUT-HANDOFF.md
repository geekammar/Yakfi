# PROMPT-AI-JEV-02B-R1 — DURABLE RUNNER CLOSEOUT + HOLDOUT-V4 RECOVERY HANDOFF

> ┌────────────────────────────────────────────────────────────────────────┐
> │ EVALUATION / REPORTING ONLY. Contains NO secret values.                │
> │ No `OPENROUTER_API_KEY`, no credential, no Authorization header, no PII │
> │ appears anywhere below. Nothing in `src/` imports this file or anything │
> │ it describes. NO live provider request was made by this prompt.        │
> └────────────────────────────────────────────────────────────────────────┘

**Task**   PROMPT-AI-JEV-02B-R1 — recover the interrupted AI-JEV-02B-R session,
           finish the durable-runner / holdout-v4 closeout, prove every offline
           gate, and STOP before any live request.
**State**  Recovered, verified, and closed out. **No live call was made.**
**Verdict** `HOLDOUT_V4_ALREADY_COMPLETED` (§3) → the sealed recovery holdout
           was measured once, completely, by the interrupted session. It is
           now recorded as `COMPLETED` and can never run again. The
           AI-JEV-02B central question is **answered** (§8).
**Authored** 2026-10-12, AI-JEV-02B-R1 recovery session.

---

## 0. EXECUTIVE SUMMARY — READ THIS FIRST

The interrupted AI-JEV-02B-R session got **much further than the prior reports
suggest**. It did not stop at authoring holdout-v4: it authored it (60
fixtures), froze it, built the durable runner, and **executed the single
permitted live pass to completion** — 60/60 fixtures, zero errors, one
immutable artifact. It then ran out of context before recording the completion
in the retirement register, which is the one safety gap this prompt closed.

Independently verified, not trusted from prose:

- **§3 exposure audit verdict: `HOLDOUT_V4_ALREADY_COMPLETED`.** A complete
  live artifact exists, bound to the frozen candidate, `COMPLETE=true`,
  `SCORABLE=true`, `interrupted=false`, 60/60 rows, 0 errors. Recomputing
  every fingerprint from live source reproduces the artifact's bindings
  exactly (`MANIFEST MISMATCHES: 0`).
- **The single safety gap is closed.** holdout-v4 was still marked *eligible*
  for execution, so `pnpm eval:jev -- --live --bank holdout-v4` would have
  re-exposed 60 sealed fixtures. It is now recorded as `COMPLETED` with
  `eligibleForExecution: false`; both retired banks fail CLOSED (exit 4) before
  any fetch (§5).
- **The measurement is real and non-idealized:** routing **56/60**, **1** missed
  direct contact, **0** false handoffs, and **3** over-handoffs on bare
  ambiguity that are the exact design evidence for AI-JEV-03's "clarify once"
  semantics (§8, §10).
- **Every offline gate passes:** `check:jev-eval` **136/136**, `check:jev`
  28/28, `check:turn-planner` 41/41, `check:ai-architecture` 25/25,
  `check:turn-evidence` 45/45, `pnpm verify` PASSED, `pnpm security` clean,
  `git diff --check` clean, `pnpm pre-ship` `PRE_SHIP_GREEN` (PATCH).
- **Production is untouched:** **0** `src/` files changed, **0** schema /
  migration / DB / booking / customer-send / deploy changes. The shipped
  precedence source is byte-identical to HEAD.

**This prompt made zero live provider requests.** The only runner invocations
were offline (zero network by construction) and were refused at the denial
gate before any fetch was constructed.

---

## 1. Recovered baseline (recomputed, not assumed)

| item                     | value                                              |
| ------------------------ | -------------------------------------------------- |
| branch                   | `main`                                             |
| HEAD                     | `5c8eaf9578222eba6f7e5cce6108d74c05a8298a`         |
| origin/main              | `5c8eaf9578222eba6f7e5cce6108d74c05a8298a` (equal) |
| package.json version     | `0.44.6`                                           |
| latest release tag       | `v0.44.6`                                          |
| relationship to shipped ancestor | EXACT MATCH (verified, not trusted)        |
| stash / merge / rebase / cherry-pick / revert / bisect | none                |
| staged files             | 0                                                  |
| `src/` files modified    | **0**                                              |

**Working tree (20 paths, uncommitted by design):**

```
evaluation/jev/jev-fixture-bank.ts       modified  +2055  (all slices incl. holdout-v4)
evaluation/jev/jev-question-contract.ts   modified   +120  (the @v3 semantic repair; UNTOUCHED since 12:35)
scripts/check-jev-eval.ts                 modified   +839  (J15–J20, R1–R9)
scripts/eval-jev-benchmark.ts             modified  +1429  (durable runner, freeze binding, finalization)
evaluation/jev/jev-freeze-manifest.ts     new        (freeze record + retirement register)
evaluation/reports/jev/*.json             13 files   (live artifacts; §7)
evaluation/reports/jev/AI-JEV-02B-A-STAGE-A-HANDOFF.md   (Stage-A handoff)
evaluation/reports/jev/AI-JEV-02B-FINAL-REPORT.md        (Stage-B interruption report)
+ this file (added by this prompt)
```

**Classification of every changed/untracked path:**

| path | class |
| --- | --- |
| `jev-question-contract.ts` (mtime 12:35) | **A** — inherited AI-JEV-02B Stage-A work; untouched by R |
| `jev-fixture-bank.ts` (mtime 18:56) | **B** — R session: holdout-v3 + holdout-v4 authoring |
| `eval-jev-benchmark.ts` (mtime 19:05) | **B** — R session: durable runner |
| `check-jev-eval.ts` (mtime 19:06) | **B** — R session: J20 + R1–R9; **C** this prompt: J20l + bank move |
| `jev-freeze-manifest.ts` (mtime 18:05) | **B** — R session: freeze + holdout-v3 retirement; **C** this prompt: holdout-v4 `COMPLETED` |
| 12× 12:xx report JSONs | **C** — Stage-A live evidence (inherited) |
| `jev-benchmark-holdout-v4-live-live-…-393e6c.json` (18:46) | **C** — R session's completed live holdout measurement |
| 2× prior handoff `.md` | **C** — inherited reports |

**No class-D (unrelated/suspicious) path exists.** Every change is inside the
documented AI-JEV evaluation surface. Nothing was reset, stashed, cleaned or
restored; no paid run was repeated to reconstruct state.

---

## 2. How far the interrupted AI-JEV-02B-R session actually got

Determined independently against the working tree, not from the prior reports
(which both predate the holdout-v4 run):

| PROMPT-AI-JEV-02B-R requirement | status when this prompt opened |
| -------------------------------- | ------------------------------ |
| holdout-v3 retirement state      | **COMPLETE** — `SEAL_BROKEN`, `eligibleForExecution=false`, `eligibleForScoring=false`, 42/47/5 |
| freeze / manifest changes        | **COMPLETE** — 6 slices frozen, `verifyFreezeManifest` wiring |
| durable incremental result persistence | **COMPLETE** — `.partial.json` rewritten after every row |
| incomplete artifact semantics (`COMPLETE=false`/`SCORABLE=false`) | **COMPLETE** |
| SCORABLE / COMPLETE guards       | **COMPLETE** — `finalizeSealedArtifact` + `isArtifactScorable` |
| fingerprint binding              | **COMPLETE** — exit 3 on any bank/contract/policy drift, before any fetch |
| duplicate-row protection         | **COMPLETE** — gate rejects duplicates even at length parity |
| interrupted-run handling         | **COMPLETE** — `abortAfter` hook, `INTERRUPTED` status, `resumeAllowed=false` |
| no-secret serialization          | **COMPLETE** — probe scan, 0 hits, R3b proves the scan *detects* |
| sealed-bank rerun refusal        | **PARTIAL** — held for `SEAL_BROKEN`; **missing for the `COMPLETED` case** → closed by this prompt (§5) |
| runner regression tests R1–R8    | **COMPLETE** — all present and passing |
| holdout-v4 fixture bank          | **COMPLETE** — 60 fixtures, all §8 relationships |
| holdout-v4 disjointness proof    | **COMPLETE** — 0 id/message/punctuation overlap |
| holdout-v4 freeze metadata       | **COMPLETE** — count, fingerprint, model, timestamps |
| **holdout-v4 live execution**    | **COMPLETE (undocumented)** — 60/60, `COMPLETE=true`, one artifact |
| production isolation checks      | **COMPLETE** |
| regression gates                 | **COMPLETE** |

**The interrupted session's terminal state:** it ran the live holdout at
18:46:13Z, wrote the final artifact at 18:46:24Z (11.0s wall), then continued
editing (`jev-fixture-bank.ts` 18:56, `eval-jev-benchmark.ts` 19:05,
`check-jev-eval.ts` 19:06) and exhausted its context before flipping
holdout-v4 to `COMPLETED`. The bank edits were content-preserving relative to
the frozen fingerprint — proven by the recompute in §4.

---

## 3. CRITICAL EXPOSURE AUDIT — DID HOLDOUT-V4 EVER RUN?

Performed **before** any work that could reach a provider, across freeze
manifests, artifacts, run-state fields and report metadata:

| evidence sought | finding |
| --------------- | ------- |
| `bank: "holdout-v4"` in any artifact | **1** — `jev-benchmark-holdout-v4-live-live-2026-10-12T18-46-13-847Z-393e6c.json` |
| `mode` of that artifact | **`"live"`** (real calls) |
| `plannedRequests` / `executedRequests` | **60 / 60** |
| `plannedFixtureCount` / `completedFixtureCount` | **60 / 60** |
| `notRequestedFixtureIds` / `failedFixtureIds` | **[] / []** |
| holdout-v4 fixture ids in result rows | **60**, all unique, identical as a set to the live bank |
| `requestedModel` / `servedModel` | `typesafe/jev-1.13` / `typesafe/jev-1.13-20260917` |
| execution window | 18:46:13.847Z → 18:46:24.870Z (**11.0 s**, consistent with 60 sequential ~180 ms calls) |
| `artifactStatus` / `COMPLETE` / `SCORABLE` / `interrupted` | `COMPLETE` / **true** / **true** / false |
| `finalization` | `{ok: true, reason: null}` |
| `secretScan` | `{scanned: true, probes: 13, hits: []}` |
| `freeze.mismatches` | `[]` |

**Authenticity reasoning (the artifact is a genuine measurement, not a
fabrication):**

1. Every fingerprint it records is reproduced by recomputing from **current
   live source** — bank `sha256:7e96dd7d89409647`, contract
   `sha256:588222a74f4a356b`, policy `sha256:a01c368d17e5629e`, freeze manifest
   `sha256:e8031b1f40777359` (§4).
2. The per-call envelope matches the real provider profile seen across all 13
   prior genuine artifacts: latency 146–307 ms (prior range 140–324),
   ≈3 464–3 488 input / ≈315–318 output tokens per call, cost ≈$0.000 146 per
   call (60 × 0.000 146 = the artifact's $0.008 766 to 10 significant figures).
3. **The results are deliberately non-idealized:** exact agreement 50/60,
   routing 56/60, 12 disagreements, 1 missed contact, 3 over-handoffs. A
   fabricated artifact would trend toward perfection.
4. Realistic, varied per-fixture probabilities (0.04/0.94/0.06 …) with the
   model flagging its own ambiguity (`ambiguousTurn` 0.21–0.49).

### VERDICT: **C) `HOLDOUT_V4_ALREADY_COMPLETED`**

Per §3 of the prompt this is **not** the `HOLDOUT_V4_NEVER_EXECUTED` branch, so
Stage-B execution is **not eligible** and **no live holdout-v4 call was made**.
The smallest safe recovery path was applied instead (§5): record the completion
and refuse re-execution.

---

## 4. Freeze integrity — every fingerprint recomputed from live source

Computed by an independent verifier kept **outside** the working tree
(`/tmp/opencode/verify-r1.ts`), importing the repository modules directly:

| artifact | live recompute | frozen manifest | ✓ |
| --- | --- | --- | --- |
| question contract id | `flowpilot.jev-questions@v3` | same | ✓ |
| **contract fingerprint** | `sha256:588222a74f4a356b` | `sha256:588222a74f4a356b` | ✓ |
| probability policy id | `flowpilot.jev-policy@v2` | same | ✓ |
| **policy fingerprint** | `sha256:a01c368d17e5629e` | `sha256:a01c368d17e5629e` | ✓ |
| **requested model** | `typesafe/jev-1.13` (pinned) | same | ✓ |
| **freeze manifest fp** | `sha256:e8031b1f40777359` | matches the artifact's record | ✓ |

Frozen slices, recomputed:

| slice | n | live fingerprint | frozen | ✓ |
| --- | --- | --- | --- | --- |
| `original` | 40 | `sha256:69341a65821179a9` | same | ✓ |
| `calibration` | 26 | `sha256:8a76f9e4deeb94f8` | same | ✓ |
| `holdout` | 20 | `sha256:d3f4a90715c80066` | same | ✓ |
| `calibration-v3` | 27 | `sha256:29a8d48d1e244ee0` | same | ✓ |
| `holdout-v3` | 47 | `sha256:1d659cc4d188bf56` | same | ✓ |
| `holdout-v4` | **60** | `sha256:7e96dd7d89409647` | same | ✓ |

**`MANIFEST MISMATCHES: 0`.** `bankIntegrity()` over both `JEV_FIXTURES_V3`
(160) and `JEV_FIXTURES_V4` (220) returns `ok`. The five Stage-A slices plus
holdout-v4 partition `JEV_FIXTURES_V4` exactly (40+26+20+27+47+60 = 220).

**The mtime anomaly is benign.** `jev-fixture-bank.ts` (mtime 18:56:58) was
touched ~11 min *after* the artifact (18:46:13), but the live-recomputed
holdout-v4 fingerprint is still the frozen value, so the touch was
content-preserving and the freeze binding is intact.

**Note on this prompt's manifest edit:** adding holdout-v4 to
`HOLDOUT_RETIREMENTS` does **not** change any slice, contract or policy
fingerprint, and `freezeManifestFingerprint()` hashes only `JEV_FREEZE_MANIFEST`
plus the adjudication register — never the retirement register. The artifact's
recorded `sha256:e8031b1f40777359` therefore remains valid, re-verified after
the edit.

---

## 5. Sealed-bank retirement — both banks fail CLOSED

### 5.1 The retirement register (after this prompt)

```
holdout-v3  status=SEAL_BROKEN   eligibleForExecution=false  eligibleForScoring=false
            reason="interrupted first sealed execution"
            exposedRows=42  plannedRows=47  missingRows=5

holdout-v4  status=COMPLETED     eligibleForExecution=false  eligibleForScoring=true
            reason="completed first sealed execution (one immutable artifact persisted)"
            exposedRows=60  plannedRows=60  missingRows=0
```

`eligibleForScoring` differs deliberately: a broken seal left **no** valid
artifact (so there is nothing offline to score), whereas holdout-v4 produced a
complete immutable artifact that remains eligible for offline analysis. Only
**re-execution** is forbidden for both.

### 5.2 End-to-end proof (offline ⇒ zero network by construction; the guard
fires before any fetch is constructed)

```
$ pnpm eval:jev -- --bank holdout-v3
HARD STOP: bank 'holdout-v3' is SEAL_BROKEN and cannot be executed:
interrupted first sealed execution (exposed 42 of 47 planned rows;
5 never requested; eligibleForExecution=false, eligibleForScoring=false)
[ELIFECYCLE] Command failed with exit code 4.

$ pnpm eval:jev -- --bank holdout-v4
HARD STOP: bank 'holdout-v4' is COMPLETED and cannot be executed:
completed first sealed execution (one immutable artifact persisted)
(exposed 60 of 60 planned rows; 0 never requested;
eligibleForExecution=false, eligibleForScoring=true)
[ELIFECYCLE] Command failed with exit code 4.
```

`fetch` attempt count = **0** in both cases (asserted mechanically by R4 and by
the denial gate returning before the adapter is even constructed). The guard is
mode-agnostic by design — "a retired bank may not be executed at all" — so the
live path is necessarily covered.

---

## 6. Durable-runner proof (PROMPT-AI-JEV-02B-R §5, all requirements)

| required guarantee | verdict | evidence |
| --- | --- | --- |
| **A.** results durably recoverable *during* a run | **HOLDS** | `.partial.json` is rewritten after **every** successfully completed fixture (`eval-jev-benchmark.ts:1031`), not only at the end |
| **B.** interrupted run preserves non-secret evidence | **HOLDS** | partial carries `runId`, `bankId`, `bankFingerprint`, `contractFingerprint`, `policyFingerprint`, `requestedModel`, `servedModels`, `plannedFixtureCount`, `completedFixtureIds`, `rows`, `failedFixtureIds`, `notRequestedFixtureIds`, `startedAt`/`finishedAt`, `artifactStatus`, `secretScan` |
| **C.** partial is unmistakably incomplete | **HOLDS** | `artifactStatus: "INTERRUPTED"`, `COMPLETE=false`, `SCORABLE=false`, `resumeAllowed=false`; `isArtifactScorable()` rejects it |
| **D.** complete only when planned===executed, errors===0, every expected id exactly once | **HOLDS** | `finalizeSealedArtifact` checks count, set-equality, uniqueness and `ok` on every row |
| **E.** no secret serialized | **HOLDS** | probe scan over the live credential value + markers; artifact records only probe *counts*; 0 hits; R3b proves the scan *detects* an injected credential |
| **F.** partial is evidence only — no resume, no rerun | **HOLDS** | `resumeAllowed=false` is written on every partial; a broken/completed seal is refused before any fetch (§5) |
| **G.** shell consumers cannot kill the runner | **HOLDS** | the runner writes its own artifact and log file directly (`createWriteStream`); it is not driven by a bounded pipe. The SIGPIPE-kill that broke holdout-v3 (`\| head`) is structurally impossible now — `runBenchmark` never depends on stdout's reader |

---

## 7. Runner regression tests R1–R9 (§6) — all passing, zero live calls

All nine drive `runBenchmark` with **injected** offline fetches; no paid call is
made. They run against a real **frozen, non-retired** slice (`calibration-v3`)
— holdout-v4 is now refused by the §5 guard in every mode, so the machinery
tests moved to a bank that stays eligible. Test artifacts are written **outside**
the repository (`../.tmp-jev-runner-tests`) and removed afterwards.

| id | property | result |
| --- | --- | --- |
| **R1** | interrupt after fixture 3 of 5 → exactly 3 completed rows durably inspectable, 2 not-requested, exit 5 | **PASS** |
| **R2** | interrupted artifact is `COMPLETE=false` / `SCORABLE=false`, `INTERRUPTED`, `resumeAllowed=false`, refused by `isArtifactScorable` | **PASS** |
| **R3** | injected `OPENROUTER_API_KEY` + `Authorization: Bearer` never appear in persisted output | **PASS** |
| **R3b** | the secret scan *detects* a seeded credential (cannot pass silently) | **PASS** |
| **R4** | retired bank refused before any network invocation, `fetchCallCount === 0`, exit 4 | **PASS** |
| **R5** | clean 5/5 → one `COMPLETE`/`SCORABLE` artifact, 5 unique ids, planned===executed===5, failed 0 | **PASS** |
| **R5b** | a completed run leaves no `.partial.json` behind | **PASS** |
| **R6** | mutating the bank, contract **or** policy fingerprint hard-stops (exit 3) with `fetchCallCount === 0` | **PASS** |
| **R7** | a duplicate fixture row never finalizes (reported even at length parity) | **PASS** |
| **R8** | 4/5, 6/5, missing-id and failed-row skews never finalize | **PASS** |
| **R8b** | a clean 4/4 still finalizes (the gate is selective, not blanket) | **PASS** |
| **R9** | injected fetches never expand the bank they were given | **PASS** |

---

## 8. HOLDOUT-V4 — the measurement (the answer to AI-JEV-02B)

Artifact `jev-benchmark-holdout-v4-live-live-2026-10-12T18-46-13-847Z-393e6c.json`,
bank `holdout-v4` (60 fixtures), pinned `typesafe/jev-1.13`, served
`typesafe/jev-1.13-20260917`, provider TypeSafe, bound to the frozen candidate
(`freeze.mismatches: []`).

### 8.1 Headline metrics

| metric | value |
| --- | --- |
| fixtures scored | **60/60** |
| scored questions | 220 |
| **final routing correctness** | **56/60** |
| fixture exact agreement | 50/60 |
| question agreement | 208/220 |
| **missed direct contact** | **1** |
| **false handoff (contact/book matrix)** | **0** |
| errors / retries / failed | 0 / 0 / 0 |
| disagreements | 12 (8 non-routing + 4 routing) |
| latency min/p50/p95/max/mean | 146 / 177 / 221 / 307 / 180.5 ms |
| input / output tokens | 208 719 / 18 985 |
| cost | $0.008 766 |
| goal distribution | human_handoff 22 · booking 18 · availability 9 · service_info 4 · greeting 3 · ambiguous 2 · cancellation 1 · reschedule 1 |

### 8.2 The 4 routing mismatches — exactly the two informative families

**One MISSED direct contact** (`routingMissedContact = 1`):

```
v4-hold-contact-meet-peds-tomorrow   «عايز أقابل دكتورة أطفال بكرة»
  provider=0.40  booking=0.45  availability=0.07  ambiguousTurn=0.49
  expH=true   modH=false   goal=booking (0.91)   derivation=none
```

This is the **timing-invariance** rule meeting the contact-vs-book boundary:
«أقابل» + بكرة was labeled provider-contact (attaching a *when* must not
convert a contact request), but the model read the tomorrow attachment as an
arrangement cue and scored booking 0.45 over provider 0.40. A genuine,
unresolved finding — not a defect to tune away.

**Three over-handoffs on BARE ambiguity** (the `CLARIFY ONCE` family):

```
v4-hold-ambig-need-doctor     «محتاج دكتور»       prov=0.53 book=0.11 ambig=0.21  expH=false modH=true
v4-hold-ambig-can-doctor      «ممكن دكتور؟»       prov=0.61 book=0.15 ambig=0.36  expH=false modH=true
v4-hold-ambig-want-the-doctor «عايز الدكتور»      prov=0.56 book=0.09 ambig=0.28  expH=false modH=true
```

These are the fresh equivalents of «عايز أشوف دكتور» / «محتاج دكتور» / «ممكن
دكتور؟» with **no contact verb and no arrangement cue**. The authored labels
expect no handoff; the model routed to handoff while its own `ambiguousTurn`
probabilities sit at 0.21–0.36. Neither side is wrong — the turn is genuinely
ambiguous. This is the strongest possible evidence for the §10 design: this
family needs **one clarifying question**, not a probability move.

### 8.3 The booking mask held — the most sensitive shape

```
v4-hold-mask-book-then-talk   «عايز أحجز كشف وبعدها أكلم الدكتور»   prov=0.40 book=0.93 → NO handoff ✓
v4-hold-mask-talk-then-book   «عايز أكلم الدكتور الأول وبعدين نحجز»  prov=0.82 book=0.59 → NO handoff ✓
v4-hold-support-reception-book «عايز حد من الاستقبال يحجزلي»          supp=0.93 book=0.94 → HANDOFF ✓ (support wins)
```

Contact-inside-booking is still masked to **no handoff**, including the case
where the user explicitly wants to talk *first* (provider 0.82 suppressed by
booking 0.59). Support precedence still wins over booking. **The repair did not
weaken the mask on unseen wording.**

### 8.4 The families that generalised cleanly

| family | result |
| --- | --- |
| pure provider contact (15 cases) | provider 0.69–0.97, booking 0.05–0.24, **all handoff** — incl. MSA «أرغب في التحدث مع الطبيب مباشرة» (0.97) and English "Can you connect me to Dr Ahmed?" (0.97) |
| availability (7 cases) | availability 0.95–0.96, provider 0.06–0.08, **all no handoff** — «هل فيه دكتور شغال الجمعة؟», «مين متاح من الدكاترة بعد الساعة ستة؟» |
| identity/info (4 cases) | all no handoff; 4 non-routing disagreements (the model answers `availabilityAsked` where the label expects the identity reading) |
| booking + preference (8 cases) | booking 0.91–0.97 masks preference, **all no handoff** |
| support requests (5 cases) | support 0.93–0.96, **all handoff** |
| negative controls | reported speech, thanking a doctor, price asks, "manager said the clinic opens at nine", pure greeting — **all no handoff** |
| contact-vs-book matrix | contact∧booking **1** (masked) · contact∧¬booking 12 · ¬contact∧booking 12 · ¬contact∧¬booking 30 |

### 8.5 The answer to AI-JEV-02B's central question

> *Does the contact-vs-book repair generalise on wording the contract never saw?*

**Yes, with two precisely-characterised exceptions.** 56/60 routing on unseen
wording, the booking mask intact on every contact-inside-booking shape, zero
false handoffs, availability and preference cleanly separated from contact.
The two exceptions are not tuning targets: one is a real
contact-vs-arrangement ambiguity the precedence formula cannot resolve alone
(§8.2 missed contact), and three are genuinely ambiguous turns that a
probability move cannot adjudicate (§8.2 over-handoffs). **Both point to
clarification semantics, which is AI-JEV-03's design authority, not a contract
edit.**

---

## 9. Holdout-v4 authoring — §7 / §8 coverage (verified, not recreated)

60 fixtures (floor was 40), all §8 relationships present, verified mechanically
by `check:jev-eval` J20 / J20b–J20f:

| required relationship | evidencing fixtures |
| --- | --- |
| direct contact (talk / connect / transfer) | `contact-talk-gyn-female` · `contact-named-ahmed-self` · `contact-tell-doctor-self` · `contact-be-connected` · `contact-english-connect` · `contact-english-speak-direct` · `contact-see-mixed-now` · `mixed-connect-her` |
| book-to-see (named / type / explicit contrast / any-provider) | `book-gyn-tomorrow` · `book-derm` · **`book-not-talk` («مش أكلمه دلوقتي»)** · `book-english-thursday` · `book-peds-nextweek` · `book-any-available` · `pref-ahmed-exact` |
| availability (today / tomorrow / which / works-on-day) | `avail-dentist-today` · `avail-peds-tomorrow` · `avail-english-ahmed` · `avail-after-six` · `avail-friday` · `mixed-avail-ahmed` |
| identity / info | `id-derm-name` · `id-who-peds` · `id-english-cardio` · `id-branch-doctor` |
| preference (female-vs-male / named / none) | `pref-female-not-male` · `pref-sara-if-slot` · `pref-ahmed-exact` · `pref-any-doctor` |
| support / staff / receptionist | `support-customer-service` · `support-employee-help` · `support-reception-book` · `support-english` |
| genuine contact-vs-book ambiguity | `ambig-need-doctor` · `ambig-can-doctor` · `ambig-want-the-doctor` · `ambig-meet-doctor` · `ambig-english-see` |
| mask / precedence interactions | `mask-book-then-talk` · `mask-talk-then-book` · `support-reception-book` |
| mixed language (appointment / connect / title+availability / English+Arabic) | `mixed-book-ahmed` · `mixed-connect-her` · `mixed-avail-ahmed` · `mixed-maaid` · `contact-see-mixed-now` |
| negative controls | `neg-return-week` (reported speech) · `neg-thanks-doctor` · `neg-price-of-exam` · `neg-help-times` · `neg-manager-hours` (manager as topic) · `neg-pure-greeting` |
| language coverage | Egyptian 40 · MSA 8 · English/mixed 12 |

**Disjointness, recomputed from live source:**

| check | result |
| --- | --- |
| id overlap vs `original` / `calibration` / `holdout` / `calibration-v3` / `holdout-v3` | **0 / 0 / 0 / 0 / 0** |
| message overlap vs all five prior slices | **0** |
| punctuation-only variant clashes | **0** |
| internal duplicate ids / messages | **0 / 0** |
| `bankIntegrity(JEV_FIXTURES_V4)` (220) | **ok** |

**Selectors cannot reach it accidentally:**

| selector | n | holdout-v4 ids leaked |
| --- | --- | --- |
| `bankSubset("original")` | 40 | **0** |
| `bankSubset("calibration")` | 26 | **0** |
| `bankSubset("holdout")` | 20 | **0** |
| `bankSubset("calibration-v3")` | 27 | **0** |
| `bankSubset("holdout-v3")` | 47 | **0** |
| `JEV_FIXTURES` / `JEV_CALIBRATION_FIXTURES` / `JEV_HOLDOUT_FIXTURES` / `JEV_CALIBRATION_V3_FIXTURES` | 40/26/20/27 | **0** |
| `JEV_FIXTURES_V3` (legacy full bank) | 160 | **0** |
| `bankSubset("holdout-v4")` (its own) | 60 | 60 |

`bankSubset` filters by each fixture's own `bank` tag, so a non-v4 selector is
*structurally* incapable of returning a v4 fixture. Enforced offline by J17b /
J17b2 / J20b. **No magic-word / lexical production rule was added** (J19l).

---

## 10. Product principle to preserve for AI-JEV-03 (recorded, NOT implemented)

**DO NOT implement in Production now. This is future design evidence only.**

`LOW CONFIDENCE ≠ HUMAN HANDOFF`. The holdout-v4 measurement shows exactly why:
the three bare-ambiguity turns (§8.2) routed to handoff on provider 0.53–0.61
while the model's own ambiguity signal sat at 0.21–0.36. The correct response to
that shape is a single clarification, not an escalation.

Future desired decision semantics:

```
clear explicit human/provider contact      -> HUMAN
clear booking                               -> BOOKING
clear availability / identity / info        -> DOMAIN FLOW
genuine contact-vs-book ambiguity           -> CLARIFY ONCE
cannot understand alone                     -> NOT automatic HUMAN
```

JEV supplies **semantic facts and probabilities**. The **server owns**
precedence, clarification, routing and action — `detectExplicitHumanRequest`
remains the sole producer of the handoff verdict and the Turn Planner remains
the sole action authority.

Example future clarification:

```
تقصد تحجز ميعاد مع دكتور، ولا عايز تتكلم مع حد بشكل مباشر؟
```

`shouldClarify` was **not** added to the production contract, `src/` was not
modified, and no production behavior changed in this task.

---

## 11. Pre-holdout offline regression — all green

| suite | command | result |
| --- | --- | --- |
| JEV evaluation + architecture + runner | `pnpm check:jev-eval` | **PASSED — 136/136** |
| JEV strategy (0/1-call, authority) | `pnpm check:jev` | **PASSED — 28/28** |
| Turn Planner | `pnpm check:turn-planner` | **PASSED — 41/41** |
| AI architecture | `pnpm check:ai-architecture` | **PASSED — 25/25** |
| Turn evidence | `pnpm check:turn-evidence` | **PASSED — 45/45** |
| quality gates | `pnpm verify` | **PASSED** — lint, typecheck, format, build |
| secrets | `pnpm security` | **clean** — no secrets/credentials/env at risk |
| whitespace / conflict markers | `git diff --check` | **clean** (exit 0) |
| release readiness | `pnpm pre-ship` | **`PRE_SHIP_GREEN`** — PATCH, 20 paths, risk surfaces: none |

`check:jev-eval` grew 110 → **136** across the R session (J20 family + R1–R9)
and this prompt added **J20l** (a `COMPLETED` sealed holdout is refused
re-execution but stays scorable).

---

## 12. Production isolation — recomputed against the current tree

The screenshot from the interrupted session was **not** trusted; every check
below was recomputed from the actual diff and source.

| required proof | verdict | evidence |
| --- | --- | --- |
| `src/` modified | **0** | `git diff --name-only \| grep -c '^src/'` → 0; untracked `src/` → 0 |
| Production JEV routing changes | **0** | no `src/` change is possible; no `src/` file imports `evaluation/jev` (grep → 0 hits) |
| Prisma / schema / migration changes | **0** | nothing matching `prisma/`, `schema.prisma`, `migrations/` in diff or untracked |
| server precedence source changed | **0** | `src/features/conversations/server/conversation-ai.ts` — `git diff --quiet` → identical to HEAD; `detectExplicitHumanRequest` at :553/:562/:571 unchanged |
| Turn Planner production behavior changed | **0** | zero `src/` edits; no action/question/intent/routing target added, removed or re-ordered |
| DB writes | **0** | the evaluation surface instantiates no `PrismaClient`; the runner only *sets placeholder* env vars so evaluation modules import — it opens no connection |
| booking mutations | **0** | no booking code path reachable from `eval-jev-benchmark.ts`, `check-jev-eval.ts` or the adapter |
| customer sends | **0** | no messaging/transport call in the evaluation surface; `check:jev` C10 — JEV metadata never reaches a customer-visible reply |
| deployments | **0** | `vercel.json`, `next.config.ts`, `.github/` all absent from the diff |

**Production isolation: PASS. The evaluation task did not touch Production.**

---

## 13. Side-effect accounting for THIS prompt

| category | count |
| --- | --- |
| live provider calls made by this prompt | **0** |
| offline runner invocations (refused at the denial gate) | 2 (holdout-v3, holdout-v4 — both exit 4, 0 fetches) |
| `src/` files changed | **0** |
| contract / policy / label / example changes | **0** (all six fingerprints unchanged) |
| new holdout-v4 fixtures authored | **0** (the 60 already existed; only verified) |
| runner / check-suite edits | 3 (`jev-freeze-manifest.ts` retirement entry + docs; `check-jev-eval.ts` J20l + R-test bank move) |
| DB writes / booking mutations / customer sends | **0** / **0** / **0** |
| commits / pushes / tags / releases / deploys / migrations | **0** |
| `pnpm ship patch` / `minor` / `major` | **NOT RUN** |

---

## 14. Remaining risks (exact, not generic)

1. **The missed direct contact is unresolved by design.** «عايز أقابل دكتورة
   أطفال بكرة» (provider 0.40 / booking 0.45) sits on the contact-vs-arrangement
   boundary. It must NOT be tuned away by editing the frozen contract — that
   would invalidate the four Stage-A artifacts and the holdout-v4 measurement.
   It is input to AI-JEV-03's clarification design.
2. **The three ambiguity over-handoffs are label-vs-model, not defect-vs-correct.**
   The authored labels expect no handoff; the model hands off. The resolution is
   clarification semantics (§10), not a label edit and not a threshold move.
3. **The 8 non-routing disagreements** (identity→availability reading,
   `providerPreferenceExpressed`, one service/price reading) do not change any
   routing verdict. Expected; they must not be "repaired" by editing frozen
   labels.
4. **`contact∧booking = 1`** — the genuine contact-inside-booking case, correctly
   masked. Not a defect, but the shape most sensitive to any future weakening of
   the booking mask.
5. **Everything is uncommitted.** The frozen candidate and both handoffs exist
   only in the working tree. A rebase, `git checkout`, `git restore` or
   `git clean` would destroy Stage A and the holdout-v4 measurement. **Do not
   reset the tree.**
6. **holdout-v3 is permanently retired** (42/47 exposed, no artifact). Its 5
   unmeasured fixtures can never be measured as part of a sealed slice. This is
   permanent, accepted evidence loss — holdout-v4 is the replacement
   measurement, not a completion of holdout-v3.
7. **holdout-v4 can never be re-measured.** It is `COMPLETED` with
   `eligibleForExecution: false`. Any future sealed measurement requires a new
   disjoint slice (e.g. `holdout-v5`).

---

## 15. FINAL HARD STOP — honored

- **Live holdout-v4 request: NOT MADE.** §3 returned
  `HOLDOUT_V4_ALREADY_COMPLETED`, so the run was refused rather than attempted,
  and the completion was recorded to make the refusal permanent.
- **Live holdout-v3 request: NOT MADE.** Refused at the denial gate (exit 4).
- **Production JEV routing: not modified** (0 `src/` changes; the shipped
  precedence is byte-identical to HEAD).
- **`shouldClarify` / AI-JEV-03: NOT started, NOT implemented** (§10 records the
  design evidence only).
- **Commit / push / tag / release / deploy / migrate: NONE.** HEAD is still
  `5c8eaf9` == `origin/main`; latest tag is still `v0.44.6`.
- **`pnpm ship` of any bump: NOT RUN.** `pnpm pre-ship` was run only as a
  read-only validation and reported `PRE_SHIP_GREEN` / PATCH.

---

## 16. Handoff to the next prompt

**The AI-JEV-02B effort is complete.** The sealed measurement that the
AI-JEV-02B-FINAL-REPORT declared "NOT COMPUTABLE" (§11 of that report) is now
**computed and persisted**: 56/60 routing, 1 missed contact, 0 false handoffs,
mask intact, with the two residual families precisely characterised as
clarification problems rather than contract defects.

**Recommended next actions, in order:**

1. **Human review of the uncommitted candidate** (20 paths). Nothing is
   committed; the working tree is the only copy.
2. **Decide on release.** `pnpm pre-ship` reports `PRE_SHIP_GREEN` / PATCH with
   risk surfaces: none. If approved, `pnpm ship patch` is the next human action
   — it was deliberately NOT run here.
3. **Start AI-JEV-03 from §10**, whose design evidence is now measured rather
   than hypothesised. Do not edit the frozen contract, policy, labels or
   examples to "fix" §8.2 — that would invalidate the measurement and the four
   Stage-A artifacts.
4. **Any future sealed measurement needs a new disjoint slice** (e.g.
   `holdout-v5`, ≥ 40 fixtures, id- and message-disjoint from all 220). Both
   existing holdouts are permanently retired in `HOLDOUT_RETIREMENTS`.

**The completed AI-JEV-02B candidate — Stage A frozen and validated, Stage B
measured to completion, holdout-v3 retired, holdout-v4 measured once and sealed
— is left in the working tree for explicit human review.**
