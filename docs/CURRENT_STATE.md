# FlowPilot — Current State

> **Tier 0 orientation snapshot — as of 15 November 2026.** Read with
> `docs/AGENT_RULES.md` and `docs/DECISIONS_INDEX.md`. Section 0 is the current
> accepted baseline and the live-refresh repair candidate. Preserved evidence
> follows: historical `main` context, the integration/R5 record, the original
> R6 failure, and the Y83 delivery failure. This file is not a substitute for
> code, the canonical topic docs or `docs/BUILD_STATE.md`. No live deployment,
> provider probe, migration, webhook move or paid call was performed for this
> snapshot.

## 0. Current release and live-refresh defect — 15 November 2026

- **Current `main` / Production acceptance baseline:** `f15deded0b2295b9c5fc016aa77486d71e40dab3`
  (merge of PR #83), package version `v0.79.10`.
- **Production 0.79.10 / `f15deded` acceptance passed:** AI customer-visible
  delivery, one staff reply, and one complete conversational booking were
  verified. Sections 3–6 retain the historical candidate/R5/R6/Y83 evidence and
  are not rewritten by this acceptance.
- **Separate live-refresh defect (this candidate):** an already-open
  conversation did not automatically show incoming customer/AI messages,
  updated status or ownership, or a new appointment; they appeared only after a
  manual reload.
- **Root cause:** `ConversationDetail` initialized local state once from
  `initialData` and had no external-update fetching path. The existing
  `getConversationDetail` is deliberately write-on-open (it acknowledges
  operator attention), so it is not a pure read.
- **Fix candidate `v0.79.11` on `fix/conversation-live-refresh` (draft PR):**
  authenticated read-only `refreshConversationDetail` server action backed by
  `getConversationRefresh`; 5-second visible-tab polling with no overlapping
  requests, hidden-page pause, focus/online refresh, unmount cleanup, bounded
  failure backoff and last-good-data retention; merge preserves the unsent draft
  and draft identity, pending/unknown submissions, unsaved summary edits,
  mobile tab and reading position; stale or post-navigation responses are
  ignored.
- Opening/attention acknowledgment remains unchanged. Polling performs no
  attention, ownership, message, appointment or delivery writes.
- No migration, AI prompt/intent, booking/availability rule, Telegram
  transport, credential, price presentation or existing-appointment change.
- **Automated verification only** (CI evidence belongs to the draft PR). The
  later Muse Production acceptance is not performed or claimed here.

## 1. Main code baseline

- Historical baseline at this snapshot: `49d58c52f11e6600d783206cd423c6a7861eb907`
  — merge of PR #81, package version `v0.79.8` (14 November 2026). Superseded
  by the accepted `f15deded` / `v0.79.10` baseline in §0; retained as history.
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
- Read-only `/api/health` probe on 15 November 2026 reports **v0.79.8 /
  `49d58c52f11e6600d783206cd423c6a7861eb907`**, `deploymentReady=true` and
  `database=connected`; Vercel deployment metadata identifies
  `dpl_7JM2re7GuiGHrPwNQXZUBQpg4m3H`. This is deployment readiness evidence,
  not a new acceptance result.
- Production migrations remain operator-authorized and are never triggered
  automatically from local development, Preview or this draft candidate.

## 3. Draft integration candidate — NOT MERGED, NOT ACCEPTED LIVE

- Branch: `integration/staff-delivery-knowledge-contract`, based on `main`
  `49d58c5`, package version `v0.79.10` (draft PR #83, not merged or
  live-accepted). The exact final HEAD and Preview deployment are recorded on
  PR #83; do not reuse an older candidate SHA for readiness claims.
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
- **Guarded Preview-to-Preview maintenance (prepared, not applied):** the
  reviewed maintenance workflow now has fixed
  `transfer-integration-preview-*` and `return-old-preview-*` operations. They
  are restricted to this integration branch, a full expected SHA, the fixed
  test database and fixed old/integrated Preview URLs. Readiness verifies the
  destination version/SHA, preview database safety, migration marker and that
  both sides use the same canonical test DB for webhook-secret verification.
  Dry-run is read-only; apply was not executed. The return path uses the SAME
  test DB; no live rollback has been tested.
- **CI/reporting facts:** the reviewed integration HEAD passed required CI.
  `check:ai-disclosure` is **54/54**; `check:exact-time-requests` is
  **166/166** and is not scarce-availability coverage;
  `check:scarce-availability` is **59/59**. The `TEST_DATABASE_URL` migration
  workflow validates the shared Neon test DB (last run: no pending
  migrations); disposable PostgreSQL regression suites are a separate path.
  Production migration remains pending and operator-authorized.

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

## 6. Y83 automated-reply delivery failure — 15 November 2026

- Conversation `b56c9e2c-cb33-4872-bfdd-82c9a11dea58`, customer message
  `4aeb2cd2-dab0-4de0-94b3-062431d8901e`, trace
  `aecf13988e9b4ce2af5b3821684ba182`, Telegram update `588849908`.
- Authenticated ingress and the OpenRouter reply succeeded; the persisted
  response was an `AI_REPLY` / `AI_ACTIVE` four-service answer with
  `disclosureAllowed=true`.
- Delivery failed: `outboundSendAttempted=true`,
  `outboundSendDelivered=false`, webhook outcome `DELIVERY_FAILURE` with
  `UNKNOWN_ERROR`.
- **Proven runtime cause:** the integrated Preview deployment did not receive
  the branch-scoped `CREDENTIAL_MASTER_KEY` (Vercel shows it scoped only to the
  old `fix/safe-telegram-staff-reply-delivery` Preview branch). Runtime
  credential resolution therefore cannot decrypt the fixed bot token, so the
  outbound transport fails before any Telegram send. The exact old transport
  code was lost by the diagnostic projection; the code path classifies this as
  `UNAUTHORIZED_CREDENTIALS`.
- **Diagnostic repair in this candidate:** typed `errorCode` is retained from
  transport to engine delivery, webhook outcome and turn evidence;
  `providerMessageId` is preserved on success; thrown exceptions become
  bounded `UNKNOWN_ERROR` without raw message logging. This does not itself
  fix delivery and has not been live-retested.
- **Required runtime action (not executed):** reviewer/operator must add the
  existing `CREDENTIAL_MASTER_KEY` as a Preview secret scoped to
  `integration/staff-delivery-knowledge-contract` (or the intended Preview
  scope) without rotating its value, then redeploy the reviewed SHA and retest.
- Y83 remains a historical **FAIL**; it is not accepted or closed. R5 PASS and
  R6 FAIL remain unchanged.

## 7. Blockers, unknowns and dated evidence

**Open blockers/unknowns:**

1. The integration candidate is a draft; PR #79 and PR #82 remain open and
   unmerged, and neither original branch may be treated as superseded.
2. The PR #79 additive migration marker is **present on the test database**
   used by both fixed Previews (`migrationApplied=true`, 15 November health).
   It is not verified or applied on the old Production database. Do not
   reapply it to the test database; the old Production database remains
   inactive recovery data.
3. The R6 exact historical proposal remains unproven; the integrated repair is
   not live-accepted.
4. The live uncertain-send recheck is NOT TESTED.
5. Y83 delivery failed because the integrated Preview runtime lacks the test
   key. The approved consolidation path reuses the test-compatible key in
   Production scope; merely moving the old Preview scope is not the final fix.
   The environment fix and live retest remain pending.
6. PR #79's original credential/webhook/restoration jobs remain guarded to
   `refs/heads/fix/safe-telegram-staff-reply-delivery` plus an exact expected
   SHA. The new fixed-Preview transfer job is guarded only to this integration
   branch plus an exact SHA. Do not widen either guard, change branch filters
   or move the bot to work around them.
7. The new Preview-to-Preview apply/return operations are prepared and tested
   offline only; no live webhook move or live rollback has been executed.
8. Production was not independently re-probed for this snapshot; the last
   verified deployment is the dated handoff above.

**Dated evidence history (retained, not current status):**

- Earlier on 14 November 2026 the R6 report was still pending and provider
  success was recorded as **UNVERIFIED**. That state is superseded by the
  Cairo finding in §5 but remains documented so the earlier handoff is not
  rewritten.
- R5 Preview acceptance and the historical QA249/QA250 failures remain part of
  the evidence record; do not erase them.

## 8. Next action

- Ammar and the reviewer decide whether to approve the single-runtime
  consolidation preparation in §9. This snapshot does not merge, tag, release,
  migrate, deploy, move the webhook, send Telegram messages or call a paid
  model.
- The previously proposed Preview-transfer dry run is optional and is not a
  mandatory acceptance gate. If used, it remains read-only until separately
  approved; the current bot remains where it is until the consolidation
  transition.
- The proposed consolidated acceptance sequence is bounded: first an
  AI/services question with trace verification, then the affected
  staff-delivery smoke, then the critical booking path only if the earlier
  steps pass.
- Keep decision IDs #105, #106 and #107 and their original meanings; the
  compact decision index remains the Tier 0 router.

## 9. Single Production runtime consolidation — prepared, not executed

- Approved operating decision: one primary Vercel runtime for development-stage
  live acceptance, deployed from `main`, with one fixed bot and one explicitly
  selected active database. Git branches and PRs remain the development
  process; Preview is optional, not a mandatory per-task gate.
- Selected dataset: the existing Neon test database
  `ep-little-mouse-a5nh644n[-pooler].us-east-2.aws.neon.tech` / `neondb`. It
  already carries the PR #79 additive migration marker, the fixed bot runtime
  credential, and a known compatible key. The old Production database is
  preserved intact as an inactive recovery source; it is not reset, overwritten
  or deleted.
- Proposed application pairing: Production `DATABASE_URL` and
  `CREDENTIAL_MASTER_KEY` are switched to the existing test DB and
  test-compatible key. The canonical Production URLs, auth secret and channel
  settings stay unchanged. No key is generated, rotated or re-encrypted.
- CI isolation: automatic PR migration validation now uses a disposable
  PostgreSQL service, never the shared runtime database. Manual maintenance
  remains exact-branch/SHA guarded. `production-db-migrate.yml` now requires
  `expected_db_host` and `expected_commit_sha` and rejects the legacy Production
  hosts in apply mode.
- Prepared runners: `test-db-migrate.yml` adds read-only
  `verify-selected-runtime`, one-shot `configure-production-runtime-env`, and
  guarded `cutover-main-runtime-dry-run` / `cutover-main-runtime-apply`.
  The cutover verifies a signed proof from the deployed application
  (`/api/operator/cutover-readiness`) of commit/version, selected DB binding,
  fixed Business/connection and resolved bot credential before any switch.
  `production-telegram-repair.yml` does not enforce `expected_db_host` and is
  not the cutover gate.
- Recovery limit: the current Production `DATABASE_URL` and
  `CREDENTIAL_MASTER_KEY` are sensitive and cannot be read back through Vercel.
  A deployment ID is not a secret backup. If the old values are not in the
  owner vault, a full configuration rollback is not available and must be
  recorded as a blocker.
- Not executed: no Production environment write, migration, webhook move,
  merge, branch deletion, credential rotation, paid model request or Telegram
  send. The old Preview key scope is not the consolidation solution.
- Exact ordered transition and prepared rollback are in
  `docs/TROUBLESHOOTING.md`. Rollback has not been live-tested. R5 PASS, R6
  FAIL and Y83 FAIL remain historical evidence and are not rewritten.
