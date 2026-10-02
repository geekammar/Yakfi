# FUTURE_SYSTEM — PROMPT-AI-ARCH-15 real-LLM report (Slice 6 broader knowledge)

> Verification-only. No production behavior changed by this run. No production
> data read or written (isolated in-memory repositories). Canonical dataset
> `egyptian-v1` byte-hash `8be16297ae4717bab5da4f3c94de1887` asserted unchanged.
> Provider `atria` / `Atria-Dawn-Preview` via an EVAL-ONLY override; the DB
> `PlatformAiPolicy` was NOT read or changed.

## READINESS: READY_FOR_NEXT_STAGE

## What was proven

The two remaining Slice-6 knowledge channels are reachable under a real LLM and
strictly task-gated, reusing the existing Context Builder + disclosure gate:

- **A — Business about** (`businessAbout`): a business-profile question quotes
  the authoritative `about`; a missing `about` is an honest `NO_KNOWLEDGE`
  handoff; an unrelated booking turn carries NO `about` (no leak).
- **B — Service description** (`services[].description`): a service-detail
  question quotes the authoritative description (exactly the referenced service,
  bounded); a missing description is an honest handoff; an unrelated booking
  turn carries NO description.
- **C — Catalog**: a discovery question is answered from the service catalog.
- **D — Price present**: answered with the stored price, no fabrication.
- **E — Missing price explicit**: `NEED_HUMAN` + `NO_KNOWLEDGE`, no digits.
- **F — Booking-only missing price**: stays `AI_ACTIVE` (price never gates).
- **G — Multi-intent knowledge + booking**: answer-and-continue fires
  (`answerAndContinue=true`, `goals=2`) — the about answer is emitted and the
  booking goal is preserved.
- **H — Safety/handoff**: explicit human request → `NEED_HUMAN` /
  `HUMAN_REQUEST`; sensitive/urgent case → `NEED_HUMAN` / `SENSITIVE`.
  Knowledge exposure never outranks a required handoff.

## Deterministic context audit (per fixture, from the REAL context builder)

| fixture                        | status     | family      | about | desc | price | role ok |
| ------------------------------ | ---------- | ----------- | ----- | ---- | ----- | ------- |
| arch15-about-relevant          | AI_ACTIVE  | ABOUT       | true  | 0    | 0     | ✅      |
| arch15-about-missing           | NEED_HUMAN | CATALOG     | false | 0    | 0     | ✅      |
| arch15-about-irrelevant        | AI_ACTIVE  | CATALOG     | false | 0    | 0     | ✅      |
| arch15-description-relevant    | AI_ACTIVE  | DESCRIPTION | false | 1    | 0     | ✅      |
| arch15-description-missing     | NEED_HUMAN | CATALOG     | false | 0    | 0     | ✅      |
| arch15-description-irrelevant  | AI_ACTIVE  | CATALOG     | false | 0    | 0     | ✅      |
| arch15-catalog-discovery       | AI_ACTIVE  | CATALOG     | false | 0    | 0     | ✅      |
| arch15-price-present           | AI_ACTIVE  | PRICE       | false | 0    | 1     | ✅      |
| arch15-missing-price-explicit  | NEED_HUMAN | CATALOG     | false | 0    | 0     | ✅      |
| arch15-booking-only-missing    | AI_ACTIVE  | CATALOG     | false | 0    | 0     | ✅      |
| arch15-multi-intent-about-booking | AI_ACTIVE | ABOUT     | true  | 0    | 0     | ✅      |
| arch15-safety-human            | NEED_HUMAN | CATALOG     | false | 0    | 0     | ✅      |
| arch15-safety-sensitive        | NEED_HUMAN | CATALOG     | false | 0    | 0     | ✅      |

`CATALOG` = service NAMES only (the existing PUBLIC channel); the task-gated
`ABOUT` / `DESCRIPTION` / `PRICE` channels appear only on their own relevance
gate — never on an unrelated booking turn.

## Counts and invariants

- Calibration gate (ordinary · price-present · missing-escalates · booking-only):
  **4/4**.
- Focused gating: **13/13** · measured turns **17** · real model calls **17**
  (**1 call/turn**) · multi-call turns **0** · bypass turns **0** (all evaluated
  turns are generative; deterministic zero-call bypass is guarded by the offline
  suites) · provider failures **0** · malformed **0** · `safetyPreserved=true` ·
  `bookingContinued=true` · `irrelevantNoLeak=true`.

## Provider / runtime (separate from behavior)

- Env: `atria` / `Atria-Dawn-Preview`, eval-only override, timeout 150000 ms.
- Latency p50 **26.2 s** / p95 **78.1 s** / max **78.1 s** — provider property,
  unchanged policy.
- Transient Atria fast-fail events occurred on earlier attempts and were
  correctly **calibration-gate-blocked** as `BLOCKED_PROVIDER` (no fake green);
  the recorded canonical run had 0 provider failures.

## Dataset / integrity

- `egyptian-v1` hash `8be16297ae4717bab5da4f3c94de1887` — unchanged.
- About text / service descriptions were supplied ONLY through the evaluation-only
  `FutureTurnBusinessContext` overlay. No dataset, gold label, scorer, production
  schema, migration, provider policy, or prompt id changed.
