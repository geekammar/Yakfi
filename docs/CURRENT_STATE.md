# FlowPilot — Current State

> **Tier 0 orientation snapshot — as of 15 November 2026.** Read with
> `docs/AGENT_RULES.md` and `docs/DECISIONS_INDEX.md`. This file separates:
> (1) what is on `main` and the last verified Production release;
> (2) preserved R5 evidence from the original PR #79 candidate;
> (3) the original R6 failure; and (4) the NEW draft integration candidate,
> which is not accepted live. It is not a substitute for code, the canonical
> topic docs or `docs/BUILD_STATE.md`. No live deployment, provider probe,
> migration, webhook move or paid call was performed for this snapshot.

## 1. Main code baseline

- `main`: `49d58c52f11e6600d783206cd423c6a7861eb907` — merge of PR #81,
  package version `v0.79.8` (14 November 2026).
- Main includes the truthful unknown-information reply and handoff-consistency
  repair (ISS-012 / TG-22), PR #81's compact Tier 0 rules and test-reliability
  repairs, the Telegram customer/manager-bot foundation, the single
  Conversation Engine and Booking Core, and the disclosure gate.
- `main` does **not** contain the PR #79 staff-reply delivery implementation,
  its additive migration, or the PR #82 knowledge-family/disclosure repair.
  Never describe candidate-only behavior as present on `main`.

**Product invariants** (authoritative: `docs/AGENT_RULES.md`): one conversation
engine and booking authority; AI interprets, Domain decides, Conversation
orchestrates; tenant isolation and server-side authorization; Arabic-first RTL;
no free-text keyword/regex/substring intent matching.

## 2. Last verified Production deployment

- Last verified Production release in the dated handoff: **v0.79.7 /
  `8d12aa2a72169bb2563e624e89045858d090e8f3`**.
- This is a dated handoff fact, not a fresh probe. Do not infer current
  Production deployment from the `main` ref alone.
- Production migrations remain operator-authorized and are never triggered
  automatically from local development, Preview or this draft candidate.

## 3. Draft integration candidate — NOT MERGED, NOT ACCEPTED LIVE

- Branch: `integration/staff-delivery-knowledge-contract`, based on `main`
  `49d58c5`, package version `v0.79.10` (draft PR, not merged or deployed).
- Integrated reviewed commits: PR #79
  `1a11f35bf53b11f1ebb5da364b4205524353cf1c`
  (`fix/safe-telegram-staff-reply-delivery`) and PR #82
  `207596839e9af51944c876397c7cf7d14775bd9d`
  (`fix/knowledge-family-disclosure-contract`). The original branches were
  neither edited, rebased nor force-pushed.
- Retained PR #79 behavior (decision #105, original meaning): authenticated
  Telegram ingress and compatible-thread selection, immutable
  `ConversationDeliveryRoute` delivery routes, durable
  `StaffReplySubmission` claiming with payload binding, read-only status
  reconciliation, bounded uncertain-send outcomes, and staff
  ownership/draft/attempt-identity protections.
- Retained PR #82 behavior (decision #106, original meaning): one canonical
  knowledge-family vocabulary, explicit availability handling, fail-closed
  conflict/unknown-family classification, bounded refusal diagnostics, and
  legacy `disclosureChannel` telemetry semantics.
- Both repairs are present in the same Conversation Engine path; the overlaps
  were resolved semantically, not merely by a clean Git merge.
- The additive migration
  `20261108200000_safe_telegram_staff_reply_delivery` is **not applied** to
  shared Preview or Production. Applying it remains an operator decision.
- The integration candidate does **not** transfer R5 or R6 acceptance. It has
  its own CI/Preview evidence and requires its own live acceptance.

## 4. Preserved R5 staff-reply acceptance evidence

- Original PR branch: `fix/safe-telegram-staff-reply-delivery`, reviewed HEAD
  `1a11f35bf53b11f1ebb5da364b4205524353cf1c`.
- Original Preview origin:
  `https://flowpilot-prod-git-fix-safe-telegram-staff-reply-36d980-ammarj1.vercel.app`
- Original verified Preview deployment: `dpl_5QmJjbBCSvH1xhwfKSWtpQH29xso`,
  READY, original candidate SHA, test database connected,
  `isProductionDb=false`, migrations applied.
- **R5 staff-reply acceptance (remains valid for the original candidate):**
  QA251 / R5-UI-29-A1 **PASS**, tied to the tested original candidate SHA. The
  reviewer independently confirmed one **ACCEPTED** Telegram submission,
  `providerMessageId` 605.
- **Historical QA outcomes preserved:** QA249 and QA250 remain historical
  **FAIL** executions. The live uncertain-send recheck remains **NOT TESTED**.
- R5 acceptance does **not** establish Production acceptance, launch readiness
  or acceptance of the new integration candidate.

## 5. Original R6 failure — preserved, not rewritten

- **R6 customer journey FAIL (14 November 2026, Cairo):** a services/booking
  question received only a handoff.
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
- **Targeted diagnosis (read-only):** `disclosureChannel=business.faqs` on a
  refusal was the engine's intent-derived primary family, not the model's
  selected family; the legacy field cannot identify the proposal. The provider
  and parser succeeded, and the built request carried services and a price, so
  the failure was at the model→gate knowledge-family contract boundary. The
  original structured model response and resolved proposal/ledger record are
  unavailable; **exact historical attribution remains UNPROVEN.**
- **Repair proposal, not acceptance:** the PR #82 repair now integrated into
  the draft candidate addresses the proven application-side gaps. It does not
  reconstruct R6's model output and does not establish R6 acceptance.

**Boundaries for R6:** R6 was executed and its report received; no new customer
probe or rerun is authorized. Do not rerun R5 or R6 as part of this candidate
preparation.

## 6. Blockers, unknowns and dated evidence

**Open blockers/unknowns:**

1. The integration candidate is a draft; PR #79 and PR #82 remain open and
   unmerged, and neither original branch may be treated as superseded.
2. The additive PR #79 migration is not applied to shared Preview or
   Production.
3. The R6 exact historical proposal remains unproven; the integrated repair is
   not live-accepted.
4. The live uncertain-send recheck is NOT TESTED.
5. PR #79's operational maintenance jobs are guarded to
   `refs/heads/fix/safe-telegram-staff-reply-delivery` plus an exact expected
   SHA. They will not run from this integration branch; do not widen guards,
   change branch filters or move the bot to work around that. Any operational
   acceptance run needs a reviewer-approved follow-up.
6. Production was not independently re-probed for this snapshot; the last
   verified deployment is the dated handoff above.

**Dated evidence history (retained, not current status):**

- Earlier on 14 November 2026 the R6 report was still pending and provider
  success was recorded as **UNVERIFIED**. That state is superseded by the
  Cairo finding in §5 but remains documented so the earlier handoff is not
  rewritten.
- R5 Preview acceptance and the historical QA249/QA250 failures remain part of
  the evidence record; do not erase them.

## 7. Next action

- Ammar and the reviewer decide whether to accept, roll out or merge the
  integration candidate. This snapshot does not merge, tag, release, migrate,
  deploy, move the webhook, send Telegram messages or call a paid model.
- The proposed acceptance sequence is bounded: first an AI/services question
  with trace verification, then the affected staff-delivery smoke, then the
  critical booking path only if the earlier steps pass.
- Keep decision IDs #105 and #106 and their original meanings; the compact
  decision index remains the Tier 0 router.
