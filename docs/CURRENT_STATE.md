# FlowPilot — Current State

> **Tier 0 orientation snapshot — as of 14 November 2026.** Read with
> `docs/AGENT_RULES.md` and `docs/DECISIONS_INDEX.md`. This file separates what
> is on `main`, what was verified in Production, what exists only on the open
> PR #79 candidate, and what PR #81 proposes. It is not a substitute for code,
> the canonical topic docs or `docs/BUILD_STATE.md`. No live deployment or
> provider probe was run for this documentation update.

## 1. Main code baseline

- `main`: `8d12aa2a72169bb2563e624e89045858d090e8f3` — merge of PR #74,
  package version `v0.79.7` (14 November 2026 handoff baseline).
- Main includes the truthful unknown-information reply and handoff-consistency
  repair (ISS-012 / TG-22), the Telegram customer/manager-bot foundation, the
  single Conversation Engine and Booking Core, and the disclosure gate.
- `main` does **not** contain the PR #79 staff-reply delivery implementation or
  its additive migration. Never describe candidate-only behavior as present on
  `main`.

**Product invariants** (authoritative: `docs/AGENT_RULES.md` §3): one
conversation engine and booking authority; AI interprets, Domain decides,
Conversation orchestrates; tenant isolation and server-side authorization;
Arabic-first RTL; no free-text keyword/regex intent matching.

## 2. Last verified Production deployment

- Last verified Production release in the dated handoff: **v0.79.7 /
  `8d12aa2a72169bb2563e624e89045858d090e8f3`**.
- This is a dated handoff fact, not a fresh probe. Do not infer current
  Production deployment from the `main` ref alone.
- Production migrations remain operator-authorized and are never triggered
  automatically from local development or this documentation task.

## 3. PR #79 candidate — OPEN and UNMERGED

- PR: [#79](https://github.com/geekammar/Yakfi/pull/79), base `main`, head
  branch `fix/safe-telegram-staff-reply-delivery`, HEAD
  `1a11f35bf53b11f1ebb5da364b4205524353cf1c`, candidate version `v0.79.8`.
- Implemented-but-unmerged behavior: safe Telegram staff reply delivery and
  server-authoritative route resolution (ISS-018 / UI-29) — verified ingress
  linkage, durable submission claiming, read-only status reconciliation, typed
  outcomes and staff-assignment preservation. Details: `docs/DECISIONS.md`
  entry #105 in the PR branch (not present on `main`).
- The additive migration
  `20261108200000_safe_telegram_staff_reply_delivery` is **not applied to
  Production**. The candidate must not be merged before the operator applies
  and verifies the migration on the target database.
- PR #79 also carries documentation changes; see the overlap note in §7.

## 4. Preview deployment and acceptance evidence

- Preview origin:
  `https://flowpilot-prod-git-fix-safe-telegram-staff-reply-36d980-ammarj1.vercel.app`
- Last verified Preview deployment: `dpl_5QmJjbBCSvH1xhwfKSWtpQH29xso`,
  READY, same reviewed candidate SHA, test database connected,
  `isProductionDb=false`, migrations applied.
- **R5 staff-reply acceptance (remains valid):** QA251 / R5-UI-29-A1 **PASS**,
  tied to the tested candidate SHA. The reviewer independently confirmed one
  **ACCEPTED** Telegram submission, `providerMessageId` 605.
- **Historical QA outcomes preserved:** QA249 and QA250 remain historical
  **FAIL** executions. The live uncertain-send recheck remains **NOT TESTED**.
- `OPENROUTER_API_KEY` was added as a sensitive secret for all Preview
  branches; the same candidate SHA was redeployed afterward. Secret values were
  not inspected or printed, and this task does not add, rotate or change the
  key.
- Preview acceptance does **not** establish Production acceptance or launch
  readiness.

## 5. R6 finding — dated 14 November 2026, Cairo

- **R6 customer journey FAIL:** a services/booking question received only a
  handoff.
- The reviewer independently checked Vercel runtime evidence for the same
  conversation and execution time.
- `openrouter` / `deepseek/deepseek-v4.1-flash` succeeded in one attempt;
  `parseSuccess=true`; `servicesCount=4`.
- The application recorded `POLICY_REFUSED`:
  `disclosureChannel=business.faqs`, `disclosureAllowed=false`,
  `disclosureRefusalReason=EXCLUDED_FROM_CONTEXT`.
- Final outcome: `AI_HANDOFF` / `NEED_HUMAN`: the provider call succeeded, but
  the customer journey failed at the disclosure-policy decision.
- Trace ID: `51854b4fb26d4c1488926059ab08b481`.
- **Exact root cause remains pending targeted code/contract review.** Provider
  success does not establish AI availability, booking success or R6
  acceptance.

**Boundaries for R6:** R6 was executed and its report received; no new customer
probe or rerun is authorized. No application fix, configuration change or
PR #79 modification is authorized by this finding. R6 remains an open product
finding pending targeted code/contract review. R5 Preview staff-reply
acceptance remains valid.

## 6. Blockers, unknowns and historical evidence

**Open blockers/unknowns:**

1. PR #79 is unmerged; its migration is not on Production.
2. The R6 exact root cause is not yet proven.
3. The live uncertain-send recheck is NOT TESTED.
4. Production was not independently re-probed for this documentation update;
   the last verified deployment is the dated handoff above.

**Dated evidence history (retained, not current status):**

- Earlier on 14 November 2026 the R6 report was still pending and provider
  success was recorded as **UNVERIFIED**. That state is superseded by the
  Cairo finding in §5 but remains documented here so the earlier handoff is
  not rewritten.
- R5 Preview acceptance and the historical QA249/QA250 failures remain part of
  the evidence record; do not erase them.

## 7. Documentation overlap and next action

- This branch targets `main` only; it does not modify, rebase or merge PR #79.
- PR #79 overlaps these documentation files: `BUILD_STATE.md`,
  `CONTEXT_MAP.md`, `CURRENT_STATE.md`, `DECISIONS.md`,
  `DECISIONS_INDEX.md`, `ENVIRONMENT_VARIABLES.md`, `TROUBLESHOOTING.md`.
  Reconciliation of the candidate's #105 entry and its dated checkpoints is a
  reviewer decision after an explicit merge approval; a clean Git merge alone
  is not proof of correct combined documentation.
- **PR81 proposal (draft, not merged, not deployed):** documentation
  maintenance plus the version metadata increment `0.79.7 → 0.79.8` required by
  the current mandatory `pnpm check:version`. This is a separate proposal from
  PR79's `0.79.8` candidate; the shared version number does not merge the two.
- **Version-gate decision (PR81):** no docs-only CI exemption was implemented.
  A documentation PR must follow the actual gate (carry the required version
  metadata increment) or obtain an explicit reviewed scope decision. Do not
  document an unconditional rule that forbids the increment while requiring
  this gate to pass, and do not bypass or falsely mark the gate. CI remains
  authoritative for the actual result; do not infer gate status from this
  document.
- **Merge-order implication:** if PR81 merges first at `0.79.8`, PR79 will need
  a later reviewed version increment, documentation reconciliation and checks
  before its eventual merge. That work is not performed in this task.
- **Current task:** documentation maintenance plus required version metadata
  increment; draft PR pending CI and reviewer inspection.
- **Product next action:** reviewer/Ammar decide PR #79 reconciliation and the
  targeted R6 root-cause review. Do not merge, deploy, migrate, rerun R6 or
  modify the candidate as part of this documentation task.
