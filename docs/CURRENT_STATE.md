# FlowPilot — Current State

> **Tier 0 orientation snapshot — as of 19 November 2026.** Read with
> `docs/AGENT_RULES.md` and `docs/DECISIONS_INDEX.md`. Section 0D records the
> merged PR #95 request-scoped policy-failure boundary and the read-only Render
> observation. Section 0E records the refreshed Draft PR #88 durable-evidence
> candidate. Sections 0/00/0A/0B and 1–9 retain prior release, R5, R6, Y83 and
> QA249/QA250 evidence unchanged. The Render app is technically ready;
> Telegram cutover and live product acceptance have not been performed.

## 0D. PR #95 merged: request-scoped policy fail-closed — 19 November 2026

- **PR #95 is merged:** merge commit
  `9187655ae9909326d8243eccffc11c2f160bcabb`, package `0.79.21`, merged at
  `2026-11-19T23:30:54Z`; `origin/main` is that merge. The old PR #95 branch
  head was `26a5e6c`.
- **Merged behavior:** policy read/persistence/invalid failure returns a
  bounded `policy-unavailable` assistant that enters the existing
  `AI_FAILURE` / `NEED_HUMAN` path with zero provider/JEV calls, no booking
  mutation and no lexical fallback. The production policy wrapper is
  stateless; `ConversationAi.respondWithExecution` returns response, provider,
  telemetry and an explicit `policyUnavailable` marker from the same
  invocation. Valid-policy, real provider-failure, `/start` and valid callback
  behavior are preserved.
- **Read-only Render verification:** at `2026-11-19T23:31Z` the service still
  reported the prior `0.79.20` / `fdf8e56` deployment (HTTP `200`,
  `deploymentReady=true`, `database=connected`, `missingEnvVars=[]`), so the
  `0.79.21` deployment was pending and was not triggered manually. At
  `2026-11-19T23:37Z` the automatic deployment had completed: both
  `/api/health/live` and `/api/health` returned HTTP `200` with version
  `0.79.21`, exact commit `9187655ae9909326d8243eccffc11c2f160bcabb`,
  environment `production`, `deploymentReady=true`, `database=connected`,
  `missingEnvVars=[]`. This is deployment/readiness evidence, not live product
  acceptance.
- **Not claimed:** no deploy, production DB access, migration,
  Telegram/customer send or paid AI call.

## 0E. Refreshed PR #88 durable evidence candidate — 20 November 2026

- **Branch/PR preserved:** existing branch
  `feat/durable-turn-usage-cost-evidence` and Draft PR #88 remain the delivery
  vehicle. Reviewed refresh HEAD was
  `fc7b8bc946c24ccc570f14f5bb21b3ca7a785a50` on `main` (`9187655`,
  `0.79.21`); package version is `0.79.22`. The branch has no reset,
  force-push or history rewrite.
- **One execution boundary:** PR88's earlier `respondTurn` wrapper and
  module-level last-telemetry plumbing were removed. Routing, physical/logical
  counters, usage rows, provider attribution and durable evidence now consume
  the merged PR #95 `respondWithExecution` result. There is no second
  execution-accounting path and no shared "last provider/telemetry" state.
- **Policy no-call vs unknown execution:** the explicit request-scoped
  `policyUnavailable` marker is projected into turn evidence and maps to
  `executionEvidence=PROVEN_NO_CALL` with zero attempts. Missing telemetry
  without that marker remains `UNAVAILABLE`; it is never presented as a
  proven no-call. Deterministic/JEV/deferred proofs and valid-policy provider
  failures keep their existing meaning.
- **Bounded economics preserved:** additive `turn_evidence_records` /
  `turn_evidence_attempts`; explicit `trafficPool` (`SERVING` production
  routes, `TEST` isolated test ingress); separate confirmed HTTP, unknown
  dispatch and prevented counts; provider-reported cost and attempt identity
  copied from the existing projection; null/unknown stays distinct from a real
  zero or complete total. No historical backfill, second cost engine, billing
  or entitlement change.
- **Reconciliation completeness repair:** the read-only reconciliation now
  runs in one repeatable-read snapshot and blocks a complete window total
  while selected-scope usage lacks evidence, historical usage lacks
  `messageId`, evidence has unresolved execution, conflict counters exist, or
  `PROVEN_NO_CALL` contradicts an `AI_TURN` row. Known subtotals remain
  available; `PARTIAL` and `UNAVAILABLE` are distinct; a genuinely empty
  selected scope remains complete with zero; known other-pool links never
  inflate or block the selected pool. Conflicts are exposed and never resolved
  automatically. Exact migration-before-deploy ordering is in
  `docs/RELEASE_PROCESS.md`.
- **Migrations:** `20261116120000_durable_turn_evidence` and
  `20261116210000_durable_turn_evidence_execution_scope` are additive and
  remain unapplied. Validation runs only against the disposable PostgreSQL CI
  service; no production/runtime database command is authorized.
- **Limits:** no merge, deploy, production migration, paid AI call or
  Telegram/customer send. Crash-before-turn-completion, invoice reconciliation
  and a global enforceable spend cap remain open. Required CI on the final PR
  HEAD is the verification authority.

## 0C. Booking/delivery/transcript repair candidate — 19 November 2026

- **Baseline:** verified `main` `9e887dfccbaa2f990861abc75518f78d1c9fb223`
  (`0.79.18`, PR #92 merged). PR #88 and Rabet are untouched.
- **Draft candidate `0.79.19` (one PR):** expired inherited booking dates are
  no longer resumed into a new unstated-date request (business-local Cairo
  boundary); explicit current-turn past dates are still rejected; outbound
  transport diagnostics now separate network uncertainty, HTTP rejection/rate
  limit and malformed payload, and a failed assistant delivery is shown
  truthfully from the existing OUTBOUND_MESSAGE usage evidence; accepted staff
  replies return the persisted `Message.id` (provider id kept separate), so a
  status recheck or poll can no longer create a second identical bubble.
- **Not claimed:** the exact 19 November historical delivery/provider cause is
  unavailable in retained evidence; no live retest, deploy, migration, Telegram
  send or paid AI call was performed. Required CI evidence is on the PR HEAD.

## 0. Live Render readiness & configuration alignment — 18 November 2026

- **Current `main` baseline:** `0.79.17`, merge commit
  `e1851deec1406d690807440639761152d3d029e1` (PR91 merged and auto-deployed
  18 November 2026). PR #88 (`74f6594a...`) remains open, Draft, and untouched.
- **Technically ready Render app:** existing service `Yakfi`
  (`srv-dbv0igutlv9c73fe4990`) in `My Workspace`
  (`tea-db9st3gm7kps73ek9op0`), region `ohio`, Starter `0.5c-512mb`, URL
  `https://yakfi.onrender.com`. Live deployment
  `dep-dbv2akqvcj2c73c0a440` (trigger `new_commit`) runs `e1851de` / `0.79.17`;
  `/api/health/live` and `/api/health` return HTTP `200` with
  `deploymentReady=true`, `database=connected`, and `missingEnvVars=[]`.
- **Completed configuration:** direct transfer of `DATABASE_URL` +
  `CREDENTIAL_MASTER_KEY` from GitHub Actions secrets via a read-only dry-run
  then apply; `BETTER_AUTH_SECRET` and `OPENROUTER_API_KEY` confirmed present by
  name only. Render auto-deploy is On Commit (`autoDeployTrigger=commit`) for
  branch `main`; PR91 aligned `render.yaml` (`Yakfi`, `commit`) on `main`.
  The service is managed through the Render Dashboard/API; this Blueprint has
  **not** been imported or applied, and matching names do not prove Blueprint
  ownership or adoption.
- **Read-only cutover evidence before the new tool:** selected DB/bot credential
  and fixed business/connection/bot identity verified as `HEALTHY_LOCAL_KEY`
  with 30 migrations `UP_TO_DATE`; Render readiness is HTTP `200`. Legacy
  `production-telegram-repair` and `cutover-main-runtime-*` paths are not
  suitable for the Render/selected-DB target, so `getWebhookInfo` and the signed
  Render credential-readiness proof were not previously obtained.
- **Cutover tooling candidate (`feat/yakfi-render-telegram-cutover`,
  `0.79.18`):** adds manual-only
  `.github/workflows/render-telegram-cutover.yml` +
  `scripts/render-telegram-cutover.ts` for a read-only `preflight` (default) and
  an explicit `apply`. The tool pins the Render destination, requires exact
  checkout/deployed SHA/version and fixed workspace/service/Business/Connection/
  Bot identity, uses the selected `TEST_DATABASE_URL` +
  `CREDENTIAL_MASTER_KEY` path plus existing `RENDER_API_KEY` for fixed
  service/workspace/region verification, calls `getWebhookInfo`, verifies signed
  Render runtime readiness, requires `pending_update_count === 0` for apply,
  never uses `drop_pending_updates`, and reports partial failures without blind
  retry. Already-at-destination reports Telegram-observed vs desired
  `allowed_updates` separately; a URL match with any extra/missing set is
  blocked, not treated as exact readiness. An explicit `operation=reconcile`
  is the guarded in-place secret reset/corrective path; it is never automatic.
  When exact `allowedUpdates` is supplied, post-apply verification checks the
  observed set exactly and returns a truthful partial failure on mismatch.
  Raw `allowed_updates` is validated before normalization; missing,
  non-array, null, mixed-type or empty-string observations block preflight as
  `OBSERVED_ALLOWED_UPDATES_MALFORMED` and cannot be exact, and the switch
  refuses them as `MALFORMED_ALLOWED_UPDATES` when exact updates are required.
  Legacy callers that omit `allowedUpdates` keep the prior merge/include
  behavior. Partial apply/reconcile results report post-operation observed
  settings only when Telegram was actually inspected; otherwise they remain
  `UNKNOWN`, while desired settings stay separate.
  CI run `44520995005` passed the code HEAD `8c4afbf` with **35/35** cutover
  checks and 27/27 Render migration checks. Manual `workflow_dispatch` from the candidate
  branch is unavailable until the workflow exists on `main` (GitHub returns
  404); no live read-only preflight was executed from the candidate and no
  local secret workaround was used. No live webhook change was made.
- **Not done / not verified:** live `getWebhookInfo`/pending backlog via the new
  workflow (candidate is not on `main` until merge), Telegram webhook cutover,
  Telegram messages, live product acceptance, and workload capacity testing.
  The reviewer previously observed approximately **272–281 MiB of a 512 MiB
  limit over about 46 minutes**; this is a historical idle baseline, not proof
  of workload capacity. The Render Blueprint ownership/adoption remains
  unestablished. PR88 remains separate. Historical R5/R6/Y83 and QA249/QA250
  evidence is unchanged.

## 00. Prior acceptance evidence completion — 16 November 2026

- **Current `main` / Production baseline:** `0.79.13`, merge commit
  `472e9aa9571c15b3f091741012b06cbe0d66e576` (PR #86). Refs were verified
  before branching; no difference was found.
- **PR #86 is merged.** Its final CI run `43863159151` passed both required
  jobs (`PR Quality Gates & Regression Suite`, `Automated Browser UX QA`) on
  HEAD `c45492b`; the merge produced `472e9aa` / tag `v0.79.13`.
- **Current candidate:** branch `test/acceptance-evidence-ci`, package
  `0.79.14`, draft PR from the exact main merge commit. Scope is evidence
  completion only: real-action appointment tenant isolation, NO_SHOW policy
  coverage, and required-CI wiring for the existing Copy Lab/turn-evidence
  checks. No booking policy, schema, migration or runtime change is included.
- **Real-DB versus controlled boundary:** the new appointment-action test uses
  REAL exported actions, repositories and PostgreSQL writes for two
  businesses. Only the Next.js `requireUser()` module seam is controlled; the
  session→persisted-user→tenant resolution still uses the REAL database user
  lookup. This is not claimed as full browser/cookie Better Auth coverage.
- **CI wiring and concurrency:** `check:copy-lab-db` and
  `test:appointment-actions-db` run only after disposable PostgreSQL
  preparation; `test:copy-lab` and `check:turn-evidence` run in the offline
  validate job. `pr-validation.yml` cancels superseded runs per PR/ref;
  `production-release.yml` and `test-db-migrate.yml` are serialized with
  cancellation disabled. Limits: different PRs/branches may run concurrently,
  there is no cross-workflow lock, and cancellation is not a transactional
  rollback. Automatic PR tests use only the job-local database, never
  Production/Neon runtime credentials.
- **Still open:** real-device/operator mobile acceptance, and persisted
  usage/cost reconciliation. `check:turn-evidence` is offline/in-memory; it
  does not prove reconciliation against stored `usage_records`, complete cost
  accounting, or a global spend cap. Playwright mobile viewports are automated
  evidence, not operator mobile acceptance.

## 0A. Historical pricing/attention repair candidate — 15 November 2026

- **Production evidence:** runtime `0.79.11` / commit
  `b485bda15fbd1a2244a55d96f7b0b91374b71142`, conversation
  `b56c9e2c-cb33-4872-bfdd-82c9a11dea58`. YPRICE A–D: fixed-price
  consultation → `KNOWLEDGE_GAP_UNRESOLVED`; range root canal and
  case-dependent cosmetic session → `POLICY_REFUSED` /
  `UNAVAILABLE_IN_REQUEST`; unpriced surgery consultation → safe knowledge-gap
  handoff. All four provider executions and outbound deliveries succeeded; this
  is not a Telegram credential failure. Traces: A
  `340552b30d50498e821de2212fe75ac1`, B `6b8723746ca140049a9c1d1bacae8958`,
  C `1f3c3b430cd84ca0916c41bc49f513b2`, D `0df9a4543d4b4dbe9dcf6a1118260d66`.
- **Proven root cause:** the context builder already carried authorized service
  ids and resolved/disclosable `service.price` families, but
  `buildPromptMessages` rendered only names/prices and the shared directive
  explained FAQ source references without the exact service id required by the
  price channel. The model therefore could not supply a valid source id.
- **Candidate `v0.79.12` on `fix/yakfi-authoritative-pricing-attention` (draft
  PR):** prompt services now expose opaque authorized ids; the canonical
  directive and `.prompt` source require `service.price` with the exact selected
  service id; the gate accepts only an exact id from the current request and
  renders the stored fixed/range/case-dependent value. The read-only refresh
  reads current open attention without acknowledging it, and a successful
  Return to assistant clears the obsolete reason locally.
- **Unchanged:** duration stays `INTERNAL` (DECISIONS #53/#51/#52); no pricing
  schema, service records, booking/delivery rules, ownership rules or live
  environment were changed. Historical R5/R6/Y83 and 0.79.10 acceptance remain
  preserved. Live YPRICE re-acceptance is still required.

## 0B. Prior live-refresh candidate and accepted baseline — 15 November 2026

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
- **Identity-safe review repair:** message identity is the authoritative `id`
  only. No sender/content/timestamp inference is used to match an optimistic
  row to a server row; snapshots are deferred while a local send/mutation is
  unresolved and optimistic rows reconcile only through the returned
  `messageId`. Summary saves capture the submitted value and edit revision; a
  newer in-flight edit survives success, and failures release the refresh gate
  without discarding editor text.
- Opening/attention acknowledgment remains unchanged. Polling performs no
  attention, ownership, message, appointment or delivery writes.
- No migration, AI prompt/intent, booking/availability rule, Telegram
  transport, credential, price presentation or existing-appointment change.
- **Automated verification:** GitHub Actions run `43751606013` on the
  implementation HEAD passed both gates — PR Quality Gates & Regression Suite
  and Automated Browser UX QA (200 Playwright tests: 185 passed, 15 skipped,
  0 failed). The documentation-only evidence update is revalidated by the final
  PR CI run. The later Muse Production acceptance is not performed or claimed
  here.

## 1. Main code baseline

- Historical baseline at this snapshot: `49d58c52f11e6600d783206cd423c6a7861eb907`
  — merge of PR #81, package version `v0.79.8` (14 November 2026). Superseded
  by the accepted `f15deded` / `v0.79.10` baseline in §0B; retained as
  history.
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
