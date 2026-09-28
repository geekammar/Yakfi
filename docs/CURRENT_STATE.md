# FlowPilot — Current State

> **Tier 0 cold-start snapshot** — read with `docs/AGENT_RULES.md`. This is a
> 30-second orientation, NOT a source of truth: canonical documents and the
> repository itself always override it. Implementation detail lives in
> `docs/BUILD_STATE.md`; decisions in `docs/DECISIONS.md` (routed by
> `docs/DECISIONS_INDEX.md`); the reading policy is in `docs/AGENT_RULES.md`.

**Version: v0.31.8** — released and committed (`49d264b`, tag `v0.31.8`;
HEAD == `origin/main`; working tree clean; tags through `v0.31.8`).
**Documentation/context sync (DOC-SYNC-V0318):** releases v0.31.3–v0.31.8
committed DECISIONS #70–#75; the current baseline for future agent work is
**Context Architecture V1 (DECISIONS #75)** — `docs/CONTEXT_MAP.md` +
`pnpm context`/`context:check`/`check:context`, present and validated
read-only this pass (7 contexts / 84 paths OK; 11/11 self-tests). Every
DECISIONS #61–#75 slice described below as "UNCOMMITTED in the worktree" or
"NOT deployed pending commit" is now committed and released through v0.31.8;
that phrasing reflects each slice's authoring moment. Production
deployment/live-verification state is operator-owned and was NOT re-verified
this pass (the last recorded live checkpoint is unchanged). v0.31.1/v0.31.2
carry the
whole Telegram second channel committed (DECISIONS #63 → #67) + the #68
route-proxy routing fix. **The second REAL live Telegram verification pass
(DECISIONS #69) ran against that deployment:** it LIVE-VERIFIED that all
four #68 operator blockers are now RESOLVED (the routing fix IS live — both
webhooks 401 fail-closed with no 307; both Telegram migrations are APPLIED
to production; `TELEGRAM_MANAGER_BOT_USERNAME` IS present; health reports
v0.31.2 + `database:"connected"`) and that the whole server-side launch →
`ensureManagerWebhook` → real `/start` → `bindCreator` chain runs for REAL —
then **LIVE-PROVED a SECOND blocking defect no offline harness can see**:
the creation keyboard was sent with `request_managed_bot: {}` and the real
Bot API rejects it (`400 can't parse KeyboardButton: Can't find field
"request_id"`), so the ONE customer action never reached the Admin and no
`managed_bot` event could ever be produced. FIXED in place (`request_id:
MANAGED_BOT_REQUEST_ID`) + guarded on three regression surfaces
(`check:telegram` 100/100 incl. NEW L4b, `check:telegram-onboarding` 22/22,
`check:signup` 18/18), **but NOT deployed**, so the Telegram checkpoint
stays at **LIVE E2E PENDING** with ONE remaining operator action: **deploy
the current head → re-run the ONE live E2E from a fresh launch.**
**Additionally (DECISIONS #70, code-proven, NOT deployed):** two
`getManagedBotToken` completion-path wire-shape defects were fixed against
the authoritative Bot API — G-1 now sends `user_id` (not `managed_bot_id`;
the managed bot's own `User.id`), G-2 now parses the token as a BARE STRING
(not `{ token }`) with a non-empty-string guard — both DOWNSTREAM of the
`managed_bot` event (so unrelated to the #69 keyboard symptom), guarded by
NEW `check:telegram` section Q (`check:telegram` **107/107**); credential
model unchanged (`fp:<id>` only, no token logging/return). The #58
WhatsApp E2E disclosure-silence fix shipped in v0.29.2; the CodeCraft
Discovery provider adapter (DECISIONS #59) shipped in v0.29.3; the #60
AI-failure acknowledgment fix shipped in v0.29.4; the #61 shared
conversation-layer UX and the #62 AI personality /
operator-notification / conversation-UX slices shipped in v0.30.0. The
post-v0.30.0 **Telegram second channel** is COMPLETE and committed: the
discovery pass (DECISIONS #63) mapped the exact seams, the identity/data
foundation is BUILT (DECISIONS #64), the thin Telegram adapter + `POST
/api/telegram/webhook` + the Conversation-Engine bridge are BUILT
(DECISIONS #65), the managed-bot provisioning state machine is BUILT
(DECISIONS #66 — three security defects the focused harness surfaced were
fixed in place), the customer-facing `/settings/telegram` surface is BUILT

- behaviorally WIRED + offline-verified (DECISIONS #67), and the two
  live-found delivery defects are fixed + guarded (DECISIONS #68 routing,
  #69 keyboard) — Telegram is only a transport implementation over the
  unchanged engine.
  #62's smallest-surface findings: the
  assistant's voice is now ONE structured provider-neutral/channel-agnostic
  module carried as request context (no prompt editor, no persistence, no
  migration — per-business style is deferred to pilot evidence); the
  operator-attention path was audited correct on all 8 required properties and
  closed for its one genuine gap (opening a flagged conversation now shows WHY
  — an icon + Arabic reason chip with an accessible name, captured before the
  acknowledge-on-open resolve); and the previously-observed long-scroll
  identity issue was verified to be ALREADY SOLVED by the internal-scroll
  layout, so no sticky UI was added (the two real gaps — 44px mobile touch
  targets and the sending-indicator announcement — were fixed). The
  personality and the notification behavior are both reusable by a future
  Telegram channel by construction.

**Last shipped slice (v0.29.1):** the Spec A **cross-surface UX coherence +
slot-presentation audit** (DECISIONS #56) — presentation layer only: the slot
step renders the known candidate time grid with non-returned candidates
visibly muted + disabled + labelled «غير متاح» via the ONE shared pure module
`src/lib/scheduling/slot-grid.ts`; plus the customer-create prefill fix, the
operator-attention accessibility label, and the shared appointment date/time
formatter consolidation. **ZERO schema/migration/prompt/provider/AI-boundary
change.** This release also normalized the docs (DECISIONS #57).

## 1. What is currently implemented?

**Spec A is COMPLETE and pilot-ready at the presentation layer.** All screens
(onboarding, dashboard, conversations, appointments, Smart Create 1–6,
customers, services, settings, knowledge, team, staff workspace, platform
control plane) plus the full conversation engine are built and released.

**Developer context access (DECISIONS #75, not a product surface):** a
`docs/CONTEXT_MAP.md` starting-point index + `pnpm context <name>` /
`pnpm context:check` let a fresh session begin from a small mapped set of
files per feature instead of re-scanning the repo. It is an index, NOT a
dependency graph, and has no token accounting/telemetry.

**Verified recent milestones (all shipped through v0.20.0–v0.29.1):**

| Slice                                                                                       | Release | Decision |
| ------------------------------------------------------------------------------------------- | ------- | -------- |
| Meta Embedded Signup + runtime credential store                                             | v0.20.0 | #49      |
| Business WhatsApp onboarding UX reconciliation                                              | v0.21.0 | #47      |
| AI Knowledge Visibility Policy + Context Builder + Customer Disclosure Boundary             | v0.22.0 | #50–#52  |
| Human Handoff + Operator Attention                                                          | v0.23.0 | —        |
| Knowledge/FAQ authoring UX (suggestions)                                                    | v0.24.0 | —        |
| Service Catalog + Service Authoring UX                                                      | v0.25.0 | #53      |
| Appointment Creation UX (smart context, relative scheduling, availability-first, follow-up) | v0.26.0 | #54      |
| Booking UX + customer-create prefill                                                        | v0.27.0 | —        |
| Reschedule UX (availability-guided reschedule)                                              | v0.28.0 | —        |
| Appointments/Availability coherence — day-view correctness + day-capacity chips             | v0.29.0 | #55      |
| Slot presentation (visible-but-disabled unavailable candidates)                             | v0.29.1 | #56      |

**Also long-implemented and stable:** architecture-hardening P0 foundations
(DECISIONS #38 — Branch model, WhatsAppConnection, Provider relations,
DB-serializable booking concurrency, durable inbound idempotency, AI contract,
usage telemetry); migration chain repaired and complete (`0_init` root +
`migration_lock.toml`; 13 migrations, chain ends at
`20260923120000_operator_attention`); Meta WhatsApp Cloud API adapter live
(DECISIONS #42/#46); platform control plane (signup closed, Platform Operator
guards, platform owner invitations, Platform AI policy); conversation → booking
seam (CORE-01/CORE-02, deterministic, zero mutation); provider-agnostic AI
provider adapter (OpenRouter/AgentRouter policy-backed); Prompt Workspace
(`/prompts/**/*.prompt` → generated artifact → registry).

## 2. What was completed through the recent B-series work?

The B-series closed the AI-trust boundary and the owner-facing UX surface:
knowledge visibility → context building → customer disclosure (what the AI may
KNOW is now separate from what it may MENTION), then the authoring/booking UX
surfaces (knowledge/FAQ, services, appointment creation, reschedule), then
appointments/availability coherence, and finally slot presentation. Every slice
was composition over the ONE existing booking/availability authority — no
second engine, no schema change.

## 3. What is intentionally deferred?

- Spec B instrumentation/economics — only after pilot evidence justifies it.
- Founder Side / vertical discovery engine (Spec C).
- Billing, subscriptions, payments (DECISIONS #36).
- Working-hours editing and account activate/deactivate in the settings UI.
- Explicit unavailable-REASON states (a future domain/API decision; #56
  deliberately infers no reason — never «مشغول»/Busy).
- `cancellationPolicy` / `whatsappNumber` AI request channels + human-notification
  UX (B-03 deferrals; behavior unchanged).

## 4. What remains unverified at real-browser/production level?

- **The WhatsApp E2E reply path is FIXED, live-verified outbound, and SHIPPED
  (DECISIONS #58, v0.29.2):** a real inbound message on an AI_ACTIVE thread
  that the B-03 disclosure gate refuses no longer leaves the customer in
  silence — the turn delivers the deterministic safe handoff acknowledgment
  (real Graph send `delivered:true` proven) and still escalates to NEED_HUMAN +
  operator attention. One external dependency observed during the fix window:
  the live `atria` endpoint answered one real conversational turn (proven: it
  returned the exact self-authored `AMBIGUOUS` reply the fix targets) but was
  intermittently TIMING OUT (~16s×2) on subsequent probes — a transient
  provider condition, not an application defect.
- **The CodeCraft live compatibility probe was run (DECISIONS #59, v0.29.3 +
  post-v0.29.3 forensics):** with `CODECRAFT_API_KEY` present, `pnpm
probe:codecraft` with `CODECRAFT_MODEL=deepseek-v4-flash-0731` and
  `PROBE_RUNS=3` returned 5/5 stages — `GET /v1/models` 200 with the exact
  model present (ctx=1048576, `json_mode`), 3/3 chat-completion SUCCESS,
  `parseMode=DIRECT_PARSE`, `parseAiResponse` conforming, latency p95 7.9s
  max 7.9s (well inside the 16000ms adapter bound). CodeCraft is therefore
  proven REACHABLE, the selected model AVAILABLE, and the FlowPilot contract
  satisfiable. The probe records only safe metadata (never the key).
- **The AI-failure WhatsApp silence is FIXED, but live-verified only against
  the offline + live-probe path (DECISIONS #60, SHIPPED v0.29.4):** live DB
  forensics proved a real CodeCraft `AI_TURN` FAILURE (fast, non-timeout)
  produced no assistant message and no `OUTBOUND_MESSAGE`, while the live
  probe proved the provider itself healthy — so the root cause was the
  engine's AI-failure branch, now fixed to deliver the #58 safe
  acknowledgment. A **fresh live WhatsApp E2E** is required to confirm the
  customer-visible reply on the real thread (see §6).
- Real-browser verification of the presentation-layer UX slices (#54–#56) was
  NOT performed — they are structurally asserted in offline harnesses only.
- **Production deployment state IS live-verified at v0.31.2** (DECISIONS
  #69, 2026-09-27): `GET /api/health` → `version:"0.31.2"`,
  `deploymentReady:true`, `database:"connected"`, `missingEnvVars:[]` at
  `https://flowpilot-prod.vercel.app`. **Production env PRESENCE
  verified without reading any value:** `TELEGRAM_MANAGER_BOT_TOKEN` ✓,
  `CREDENTIAL_MASTER_KEY` ✓, `NEXT_PUBLIC_APP_URL` ✓,
  **`TELEGRAM_MANAGER_BOT_USERNAME` ✓ (now present — the last #68
  blocker)**. **The #68 routing fix IS live:** both Telegram webhook
  endpoints return 401 fail-closed with NO 307 and no `/sign-in` redirect.
  **Both Telegram migrations ARE applied** (`prisma migrate status` →
  "Database schema is up to date!", all 15; production-DB read confirms
  both tables + `outcome_code`). **BUT production is NOT yet re-deployed
  with the DECISIONS #69 `request_id` fix**, so the deployed build still
  rejects the creation keyboard and the live E2E still cannot complete.
  (The live-forensics DB IS the production Neon DB, so the failing
  CodeCraft `AI_TURN` row and the stuck thread are REAL production
  evidence — the deployed build must be at least v0.29.3, since the row
  records `provider:"codecraft"`, which only that release emits.)
- The Meta Embedded Signup code path is implemented and offline-harnessed
  (`check:meta-embedded-signup`) but has never been exercised against a real
  operator-owned Meta App Dashboard configuration. It is on a documented
  **DEFERRED / HOLD** — see `docs/INTEGRATION_CHECKPOINTS.md` (do NOT
  silently reopen it during unrelated work). The Telegram work did NOT
  touch it.
- **The Telegram customer onboarding path is BUILT + offline-verified but
  NOT live-verified** (DECISIONS #67/#68/#69): `pnpm check:telegram`
  **100/100** (section P — the live-found route-proxy reachability guard;
  NEW **L4b** — the live-found `request_id` wire-shape guard) +
  `pnpm check:telegram-onboarding` 22/22 prove the whole journey
  (EMPTY → launch → token-only deep link → the poll observing PROVISIONING
  → `/start` binding + the keyboard → the `managed_bot` completion → the
  poll observing CONNECTED → single-use replay refusal → the typed-failure
  retry loop) through the REAL service + REAL manager-webhook handler with
  in-memory fakes. **The real Manager Bot IS LIVE-VERIFIED** (a REAL
  `getMe`: `@FlowPilotManagerBot`, id `8603565570`, `can_manage_bots: true`
  — do NOT recreate or replace it), and the second live pass (DECISIONS
  #69) verified the real launch → `ensureManagerWebhook` (installed at the
  production URL) → the real `/start` DELIVERED → `bindCreator` bound the
  real Telegram user id (all observed in production). **But NO real
  managed bot has ever been created, no `setWebhook`/`getMe` has run for a
  managed bot, no connection has reached CONNECTED, and no customer
  message has been received or answered** — the deployed build still sends
  the invalid empty `request_managed_bot` object (live-proved:
  `400 … Can't find field "request_id"`), so the creation keyboard never
  reaches the Admin. ONE operator action stands open: **deploy the current
  head → re-run `docs/TELEGRAM.md → The ONE live E2E` from a fresh
  launch**; the checkpoint sits at **LIVE E2E PENDING** in
  `docs/INTEGRATION_CHECKPOINTS.md`. Do NOT report a simulated success.
- **Telegram managed-bot creation — official deep-link fallback added
  (DECISIONS #71, code-proven, NOT deployed):** production is now
  **v0.31.4** (the #69 `request_id` + #70 G-1/G-2 fixes ARE live), so the
  creation keyboard APPEARS — but a new live symptom (Android) is that
  tapping «Create the bot» opens nothing. Root cause (official docs): the
  `request_managed_bot` native creation-UI launch is a Telegram CLIENT
  capability, not a Bot API payload, so a client lacking the very-new
  handler renders the button but emits no `managed_bot` event — CLIENT-SIDE,
  not a FlowPilot/Telegram defect. Fix: the `/start` reply now ALSO carries
  the OFFICIAL documented deep link
  `https://t.me/newbot/{manager}/{new_username}?name={new_name}`, KEEPING
  the keyboard; creator/tenant binding is preserved with no new rule (the
  link is only shown after `/start <token>` bound the creator to the ledger,
  so the `managed_bot` event still resolves the Business ONLY from that
  row) and there is no second lifecycle. Guarded by NEW `check:telegram`
  L4c/L4d; `check:telegram` **109/109**. Whether the Android link path
  reaches CONNECTED live remains **LIVE E2E PENDING** (operator).
- **Telegram Android app chooser (DECISIONS #72, code-proven, NOT
  deployed, NOT live-verified):** live onboarding proved the OS
  default-handler on an affected Android device routes the HTTPS `t.me`
  provisioning link to **Telegram X** (`org.thunderdog.challegram`), where
  the flow FAILS, while **standard Telegram** (`org.telegram.messenger`)
  completes the identical flow. CLIENT launch/compatibility fix only — the
  server contract is unchanged. On Android, a successful launch now opens an
  in-app chooser («اختر تطبيق تيليجرام») with standard Telegram as the
  primary/default option, Telegram X as an explicit optional choice (never
  auto-selected), and the plain HTTPS link as the fallback; non-Android
  keeps the normal HTTPS launch. NEW pure module
  `telegram-app-launcher.ts` builds the Android `intent://` URLs without
  touching the opaque start token; guarded by NEW
  `check:telegram-onboarding` checks 23–32 (**32/32**). NOT deployed and
  NOT live-verified.
- **Telegram customer `/start` + standard-Telegram-only launcher
  (DECISIONS #73/#74, code-proven + guarded, NOT deployed):** a CUSTOMER
  managed bot's `/start` (with or without a payload) is now a DETERMINISTIC
  welcome routed BEFORE the Conversation Engine — never an AI turn, never a
  human handoff — replying with a FIXED Arabic welcome through the EXISTING
  Telegram transport (`sendStartWelcome` closure; no new engine, no new
  messaging abstraction). The FlowPilot Manager Bot provisioning
  `/start <token>` is a SEPARATE route/handler and is UNTOUCHED. Separately,
  the Android onboarding launcher now targets ONLY standard Telegram
  (`org.telegram.messenger`); **Telegram X is intentionally NOT offered**
  (it fails the managed-bot creation flow on the affected setup), reversing
  the Telegram-X option of #72 — the original HTTPS `authorizationUrl`
  remains the fallback and no server/schema/provisioning change was made.
  Guarded: `check:telegram` **116/116** (NEW B9–B11, H13–H16),
  `check:telegram-onboarding` 32/32 (check 26 asserts Telegram X not
  exposed), `check:signup` 18/18, WhatsApp green; `pnpm verify` +
  `pnpm security` + `git diff --check` green. NOT deployed.

## 5. What is the current product/architecture direction?

WhatsApp Appointment Conversion System — "Book more, chase less."
Arabic-first, RTL-first, mobile-first, **vertical-agnostic during discovery**.
Local Vertical Discovery (Kafr El Sheikh, Egypt): one identical generic engine
across appointment-driven verticals; evidence picks the winner. WhatsApp-first
(Meta Cloud API); Telegram is the second channel — its identity/data
foundation, transport sibling, manager-bot provisioning state machine, and
customer onboarding surface are all BUILT + offline-verified + COMMITTED in
v0.31.0 (DECISIONS #64 → #67), and the first real live pass (DECISIONS
#68) live-verified the Manager Bot and fixed the one live-proved delivery
defect; the remaining step is the real live E2E once the four operator
actions run. Architecture:
feature-based modular monolith on Next.js 16 + Prisma 7/Neon + Vercel only.
Invariants that must never regress: **availability authority returns only
genuinely selectable slots; server-authoritative booking; visible-but-disabled
unavailable candidate slots; no Busy/reason inference; no per-slot availability
requests; no second availability engine.**

## 6. What is the next logical phase?

1. **Operator — finish the ONE Telegram live E2E (DECISIONS #69):** two
   actions, neither code — (a) **deploy the current head** (the deployed
   v0.31.2 still sends the invalid empty `request_managed_bot` object, so
   the real Bot API rejects the creation keyboard with `400 … Can't find
field "request_id"` and the ONE customer action can never appear);
   (b) **re-run `docs/TELEGRAM.md → The ONE live E2E`** from a FRESH launch
   (the `/start` tap, the native bot-creation confirmation, and the first
   customer message are Telegram-hosted human actions). Everything else
   #68 required is already live-verified RESOLVED (routing fix live,
   migrations applied, `TELEGRAM_MANAGER_BOT_USERNAME` present). Then
   record the outcome in `BUILD_STATE.md` + a `DECISIONS.md` entry if a
   further defect surfaces.
2. **Fresh live WhatsApp E2E (operator, required):** send ONE real inbound
   message on an AI_ACTIVE thread with the policy still on
   `codecraft` / `deepseek-v4-flash-0731` and confirm the customer now
   receives the deterministic safe handoff acknowledgment (the probe proves
   the provider path is healthy, so a failure should now be rare — but any
   failure that does occur must no longer be silent).
3. **Production config (operator):** production IS live-verified at v0.31.0
   (DECISIONS #68); `CODECRAFT_API_KEY` is present (presence check only).
   Run `pnpm db:deploy` so the chain — including both Telegram migrations —
   is applied.
4. **Onboard the first REAL pilot Business end-to-end** (operator provisions

Business + invitation → ADMIN connects the WhatsApp number via Meta Embedded
Signup at `/settings/whatsapp` → CONNECTED → live messaging), then gather
baseline/ROI evidence per `PRODUCT_STRATEGY.md`. 5. **Only after pilot evidence:** Spec B instrumentation/economics.
