# FlowPilot — Build State

> **THE authoritative implementation ledger** — the single answer to "what is
> the state of FlowPilot?". Read the `Current State` summary + `Next Step`
> only; everything else is reference. Keep updates MINIMAL: status, completed
> work, known issues, next step — never a diary. Per-prompt historical detail
> lives in Git history (`git log --oneline`, `git show <tag>`,
> `git show <tag>:docs/BUILD_STATE.md`) and `docs/DECISIONS.md`; condensed
> per-slice history is in `docs/archive/IMPLEMENTATION_HISTORY.md` (Tier 3).
> Reading policy: the context tiers in `docs/AGENT_RULES.md`.

**Product version: v0.31.2** — released and committed (`04260a1`, tag `v0.31.2`;
HEAD == `origin/main`; tags through `v0.31.2`). v0.31.1/v0.31.2 carry the
whole Telegram second channel (DECISIONS #63 → #67) committed + the #68
route-proxy routing fix, and v0.31.2 is what production now serves. **The
second REAL live Telegram verification pass (DECISIONS #69, this slice) ran
against that deployment:** it LIVE-VERIFIED that all four #68 operator
blockers are now RESOLVED (the routing fix IS live, both Telegram migrations
are APPLIED, `TELEGRAM_MANAGER_BOT_USERNAME` IS present, health reports
v0.31.2 + `database:"connected"`) and that the whole server-side launch →
`ensureManagerWebhook` → real `/start` → `bindCreator` chain runs for REAL —
then **LIVE-PROVED a SECOND blocking defect no offline harness can see**:
the creation keyboard was sent with `request_managed_bot: {}`, and the real
Bot API rejects that wire shape (`400 can't parse KeyboardButton: Can't find
field "request_id"`), so the ONE customer action never reached the Admin and
no `managed_bot` event could ever be produced. FIXED in place (`request_id:
MANAGED_BOT_REQUEST_ID`) + guarded on three regression surfaces, **but NOT
deployed** — so the Telegram checkpoint stays at **LIVE E2E PENDING** with
ONE remaining operator action: deploy the current head, then re-run the ONE
live E2E from a fresh launch. See `Current State`.
Releases v0.20.0–v0.30.0 ship the
AI-trust boundary (B-01–B-03), the owner-facing UX surfaces (knowledge/FAQ,
services, appointment creation, reschedule), appointments/availability
coherence, Meta Embedded Signup, the #58 disclosure-silence fix, the CodeCraft
Discovery provider, the #60 AI-failure acknowledgment fix (v0.29.4), and the
#61 shared conversation-layer UX + #62 AI personality / operator-notification /
conversation-UX slices (both released in v0.30.0 — the two slices this ledger
previously described as uncommitted). A post-v0.30.0 **Telegram channel
discovery pass** (DECISIONS #63) mapped the exact second-channel seams and
confirmed the Telegram Managed Bot provisioning path; **the identity/data
foundation it identified is now BUILT (DECISIONS #64): the provider-neutral
external-handle identity seam + the `TelegramConnection` and single-use
`TelegramProvisioningLedger` tables + repository-only access + one additive
migration (WhatsApp behavior unchanged), and the Telegram transport sibling —
adapter, webhook, and Conversation-Engine bridge — is now BUILT too
(DECISIONS #65 — this slice; see `Current State` and `Next Step` for the
boundary of what this slice does NOT claim).**

## Current State (summary)

**SPEC A — PILOT-READY AT THE PRESENTATION LAYER.** All screens + the
conversation engine are implemented and released.

- **Telegram ANDROID APP CHOOSER (DECISIONS #72) — client
  launch/compatibility fix, code-proven + guarded, NOT deployed, NOT
  live-verified:** live onboarding proved the OS default-handler on an
  affected Android device routes the HTTPS `t.me` provisioning link to
  **Telegram X** (`org.thunderdog.challegram`), where the flow FAILS,
  while **standard Telegram** (`org.telegram.messenger`) completes the
  identical flow. CLIENT-only fix — `beginTelegramProvisioningAction()`
  and the whole server contract (`authorizationUrl`/`expiresAt`/`launched`,
  the opaque single-use token, creator binding, tenant isolation) are
  UNCHANGED. On Android, after a successful launch the `/settings/telegram`
  screen shows an in-app chooser («اختر تطبيق تيليجرام») with three real
  user-gesture actions: «فتح في Telegram» (PRIMARY → `org.telegram.messenger`),
  «فتح في Telegram X» (explicit optional → `org.thunderdog.challegram`,
  never auto-selected), «فتح الرابط العادي» (the original `authorizationUrl`,
  byte-for-byte). NEW pure module
  `src/features/telegram-connection/telegram-app-launcher.ts` builds
  `intent://…#Intent;scheme=https;package=<pkg>;S.browser_fallback_url=<encoded original>;end`
  WITHOUT ever inspecting/rewriting/logging/persisting the opaque start
  token. The external app is opened ONLY from an `<a href="intent://…">`
  tap (never a timer/effect/async callback); non-Android keeps
  `window.location.href = authorizationUrl`; retry/reopen reuse the same
  launcher + the same resumed attempt (no new token, no second lifecycle).
  **GUARDED:** `check:telegram-onboarding` **32/32** (NEW 23–32),
  `check:telegram` 109/109, `check:signup` 18/18, WhatsApp green
  (`whatsapp-onboarding` 56/56, `whatsapp-transport` 27/27);
  `pnpm verify` + `pnpm security` + `git diff --check` green. Files:
  `telegram-app-launcher.ts` (new), `telegram-connection-screen.tsx`,
  `scripts/check-telegram-onboarding.ts`. **NOT deployed, NOT
  live-verified** — that a real Android tap on «فتح في Telegram» opens
  standard Telegram and completes the flow requires a real human device
  test (operator).

- **Telegram OFFICIAL CREATION DEEP-LINK FALLBACK (DECISIONS #71) —
  client-compatibility fix, code-proven + guarded, NOT deployed:**
  production is now **v0.31.4** (`GET /api/health` →
  `version:"0.31.4"`, `deploymentReady:true`, `database:"connected"`,
  `missingEnvVars:[]`), so the #69 `request_id` fix + #70 G-1/G-2 ARE
  live and the creation keyboard now APPEARS. A NEW live symptom
  (reported on Android): tapping «Create the bot» opens nothing.
  Root-caused against the official Telegram docs — the
  `request_managed_bot` button is sent correctly (`request_id` present)
  and Telegram accepts it, but **launching the native creation UI is a
  Telegram CLIENT capability, not a Bot API payload**; a client without
  the very-new `request_managed_bot` handler renders the button but
  produces no `managed_bot` event. CLIENT-SIDE — not a FlowPilot server
  defect, not a Telegram rejection, not a claim that Android is buggy.
  **FIX (smallest, additive, keyboard KEPT):** the Manager Bot's
  `/start` reply now leads with the OFFICIAL documented deep link
  `https://t.me/newbot/{manager}/{new_username}?name={new_name}` (Bot
  Features → Managed Bots) via NEW `buildManagedBotCreationLink()`
  (strips `@`, percent-encodes the display name), and STILL attaches the
  `request_managed_bot` keyboard — graceful degradation, both routes
  ending in the SAME `managed_bot` event, NO second lifecycle. **Creator/
  tenant binding preserved with NO new rule:** the link is only ever
  shown after a valid `/start <token>` bound the Admin's `user.id` to the
  single-use ledger, so the event still resolves the Business ONLY from
  that row. **GUARDED:** NEW `check:telegram` L4c (link + keyboard both
  present, no token/business id/start token leaked) + L4d (escaping);
  `check:telegram` **109/109**, `check:telegram-onboarding` 22/22,
  `check:signup` 18/18; `pnpm verify` + `pnpm security` + `git diff
--check` green. Files: `telegram-provisioning.ts`,
  `telegram-manager-webhook-handler.ts`, `scripts/check-telegram.ts`.
  **WhatsApp / AI / Meta Embedded Signup HOLD untouched. NOT deployed** —
  the operator ships via the existing GitHub → Vercel workflow. **Still
  LIVE E2E PENDING:** that tapping the official link on the real Android
  client opens the native creation window → `managed_bot` → CONNECTED →
  a real customer round-trip is UNVERIFIED (operator: deploy the head,
  then re-run `docs/TELEGRAM.md → The ONE live E2E` from a fresh launch
  using the official-link path).

- **Telegram `getManagedBotToken` WIRE-SHAPE FIX (DECISIONS #70) — two
  code-proven completion-path defects fixed + guarded, NOT deployed:** on
  the managed-bot completion path (downstream of the `managed_bot` event,
  so UNRELATED to the #69 keyboard symptom and the still-unresolved
  managed-bot creation boundary), **G-1** — `telegramGetManagedBotToken`
  sent `managed_bot_id`; the authoritative Bot API requires `user_id` (the
  managed bot's own Telegram `User.id`, carried on the event as `bot.id` →
  `botExternalId`) — now sends `user_id`; **G-2** — the code assumed the
  response is `{ token: string }`; the API returns the token as a BARE
  STRING — `telegramGetManagedBotToken` now returns
  `TelegramApiResult<string>`, validates a non-empty string (any other
  shape → `MALFORMED_PROVIDER_PAYLOAD` → typed `PROVISIONING_FAILED`, no
  half-provisioned connection), and the caller hands the bare string to
  `setWebhook`. Credential model UNCHANGED (token server-side only, stored
  ONLY as `fp:<id>`, never logged/returned/in an error message); the
  completion sequence, typed outcomes, tenant isolation, and
  duplicate/replay protection all preserved. **GUARDED:** NEW
  `check:telegram` section Q (Q1–Q7 — `user_id` sent, `managed_bot_id`
  absent, bare-string parsed → CONNECTED, `setWebhook` gets the real token,
  object/empty response fails safely, token never crosses an outward
  boundary); `check:telegram` **107/107**, `check:telegram-onboarding`
  22/22, `check:signup` 18/18; `pnpm verify` + `pnpm security` +
  `git diff --check` green. Files: `telegram-client.ts`,
  `telegram-provisioning.ts`, `scripts/check-telegram.ts` (+
  `scripts/check-telegram-onboarding.ts` fixture). **WhatsApp / AI / Meta
  Embedded Signup HOLD untouched. NOT deployed** — the operator ships via
  the existing GitHub → Vercel workflow.

- **Telegram SECOND LIVE E2E PASS (DECISIONS #69) — all four #68 blockers
  RESOLVED live; a SECOND blocking defect LIVE-PROVED + FIXED + GUARDED, NOT
  YET DEPLOYED:** the real attempt against the deployed v0.31.2 + the real
  Telegram Bot API. **LIVE-VERIFIED:** (a) production IS v0.31.2 (`GET
/api/health` → `version:"0.31.2"`, `deploymentReady:true`,
  `database:"connected"`, `missingEnvVars:[]`); (b) the #68 routing fix IS
  LIVE — both `POST /api/telegram/webhook` and `POST
/api/telegram/manager/webhook` return **401 UNAUTHENTICATED** (missing
  secret → «سر الويبهوك مفقود»; invalid secret → «سر الويبهوك غير صالح»)
  with **NO 307 and no /sign-in redirect**, while `/settings/telegram`
  stays 307-protected (no auth regression); (c) `prisma migrate status` →
  **"Database schema is up to date!"** — all 15 migrations applied, and a
  direct production-DB read confirms both `telegram_connections` +
  `telegram_provisioning_ledgers` exist with the `outcome_code` column (0
  rows each — the EMPTY precondition held); (d) production env PRESENCE
  verified without reading any value: `TELEGRAM_MANAGER_BOT_TOKEN` ✓,
  **`TELEGRAM_MANAGER_BOT_USERNAME` ✓ (newly added — the last #68
  blocker)**, `CREDENTIAL_MASTER_KEY` ✓, `NEXT_PUBLIC_APP_URL` ✓. **(e) The
  whole server-side launch + binding chain ran for REAL:** «اربط تيليجرام»
  persisted the single-use ledger row (Business server-derived; deep link
  token-only) → `ensureManagerWebhook` installed the Manager Bot's webhook
  at the production URL (`getWebhookInfo` →
  `url:"https://flowpilot-prod.vercel.app/api/telegram/manager/webhook"`,
  `allowed_updates:["message","managed_bot"]`, `pending_update_count:0`,
  `last_error:null`) → the deep link opened @FlowPilotManagerBot → the real
  `/start <token>` was DELIVERED (visible as `POST
/api/telegram/manager/webhook` in production logs) → `bindCreator` bound
  the real Telegram `user.id` to the ledger row (verified in the production
  DB) → the settings surface's bounded poll observed the honest
  PROVISIONING state. **(f) The honest failure path is correct live:** the
  first attempt's 15-minute window elapsed with no `managed_bot` event and
  the UI surfaced **ACTION_REQUIRED** + a retryable «أعد المحاولة»; the
  retry then minted a FRESH single-use token + re-bound on the real
  `/start` — the typed-failure loop #66/#67 designed, verified live. **(g)
  THE LIVE-PROVED DEFECT — the manager bot's reply NEVER reached the
  Admin.** The ledger binding had succeeded, but Telegram never delivered
  the welcome message or the creation keyboard, so the Admin stared at a
  bot that said nothing and the `managed_bot` event could never be
  produced. **Root cause, reproduced exactly against the real Bot API:**
  the `KeyboardButtonRequestManagedBot` was sent with
  `request_managed_bot: {}` → `POST …/sendMessage` → **`400 Bad Request:
can't parse KeyboardButton: Can't find field "request_id"`**. The Bot
  API REQUIRES `request_id` on that object; the empty object is invalid,
  so every `/start` reply failed as a PERMANENT transport failure and the
  keyboard silently never appeared. No offline harness can see this: they
  assert the button's EXISTENCE and the closed payload surface (no token,
  no identifier), but the harness's FAKE Telegram API accepts whatever
  object is sent, so a schema-required field the real provider mandates
  was invisible offline. **FIX — the smallest isolated change, no
  re-architecture:** `buildManagedBotKeyboard()` now sends
  `request_managed_bot: { request_id: MANAGED_BOT_REQUEST_ID }` (a NEW
  exported constant = `1`). A FIXED value is correct and safest (the
  keyboard is the ONLY button in the ONLY message per attempt, so
  uniqueness-within-the-message is trivially satisfied, and a constant
  keeps a legitimate replay of the same attempt coherent across a restart
  or redeploy); it carries NO security meaning — the auth is the ledger's
  single-use `startToken` + creator binding. The deliberate non-prefill
  decision is UNCHANGED: `suggested_name`/`suggested_username` are still
  NOT sent. **GUARDED:** `check:telegram` **100/100** (L4 now asserts the
  numeric `request_id`; NEW **L4b** asserts the wire shape directly —
  `typeof request_id === "number" && finite && integer`, reproducing the
  live failure so the class is caught offline),
  `check:telegram-onboarding` **22/22** (check 7), `check:signup` **18/18**;
  `pnpm verify` + `pnpm security` + `git diff --check` green. **WhatsApp /
  AI / Meta Embedded Signup HOLD all untouched.** **Boundary of this
  slice's claim — the live E2E could NOT complete, and the reason is
  recorded exactly:** the `request_id` fix is committed but NOT deployed
  (the deployed v0.31.2 still sends the invalid empty object, so the
  creation keyboard still cannot appear); NO real managed bot was created,
  NO `getManagedBotToken`/`setWebhook`/`getMe` for a managed bot ran, NO
  connection reached CONNECTED, and NO customer message was received or
  answered. The ONE real live E2E remains an operator action: **deploy the
  current head → re-run `docs/TELEGRAM.md → The ONE live E2E` from a fresh
  launch.**

- **Telegram FIRST LIVE E2E PASS (DECISIONS #68) — LIVE-VERIFIED boundary,
  one blocking defect FOUND + FIXED + GUARDED, NOW DEPLOYED in v0.31.1/.2:** the first
  real attempt against the deployed v0.31.0 + the real Telegram Bot API.
  **LIVE-VERIFIED:** (a) production IS v0.31.0 (`GET /api/health` →
  `version:"0.31.0"`, `deploymentReady:true`, `database:"connected"`,
  `missingEnvVars:[]` at `https://flowpilot-prod.vercel.app` — this moves the
  ops checkpoint off the v0.19.0-era probe); (b) the real Manager Bot
  identity through the REAL Bot API — `getMe` 200, `id 8603565570`,
  `@FlowPilotManagerBot`, `is_bot:true`, and **`can_manage_bots: true` — the
  required managed-bot capability is present**, so `getManagedBotToken` is
  authorizable and the Manager Bot does NOT need to be recreated or replaced;
  (c) `getWebhookInfo` → no webhook installed yet (expected: the Manager
  webhook is self-wired by `ensureManagerWebhook` at the first launch). **A
  REAL BLOCKING DEFECT THE OFFLINE HARNESS CANNOT SEE — LIVE-PROVED, FIXED
  IN PLACE:** `src/proxy.ts` session-gated both Telegram webhook routes, so
  ANY delivery (the `/start` binding, the `managed_bot` completion, every
  customer message) answered **HTTP 307 → `/sign-in?redirect=…`** and never
  reached the handler. `setWebhook` would have "succeeded" while every real
  delivery silently failed — the exact false positive the offline harnesses
  produce (they call the handler directly, bypassing the proxy). Fix:
  `/api/telegram` added to the public-path prefixes in
  `src/lib/public-paths.ts` — **safe by construction, not a security
  widening**: the request credential is Telegram's own
  `X-Telegram-Bot-Api-Secret-Token`, verified constant-time with **401 BEFORE
  any parsing** in both handlers (asserted by `check:telegram` C/H/L).
  **Proven locally:** `POST /api/telegram/manager/webhook` → **401
  UNAUTHENTICATED** (was 307), and `/settings/telegram` still 307 → no auth
  regression. **GUARDED:** NEW `check:telegram` section P (99/99, verified to
  FAIL without the fix) + NEW `check:signup` assertions (18/18). **Owner-change
  / token rotation verdict:** NOT BUILT and explicitly DEFERRED
  (`docs/TELEGRAM.md §8`) — NOT a silent defect: `ensureManagerWebhook`
  subscribes only `["message","managed_bot"]`, an unknown update shape is
  acknowledged 200 + ignored with no state change, and an already-CONNECTED
  re-delivery terminates with the typed `BOT_ALREADY_PROVISIONED`. The schema
  ALREADY carries `managerBotId` + `creatorTelegramUserId` provenance, so the
  slice is structurally ready but needs its own lifecycle (not invented here).
  **WhatsApp regression: ALL GREEN** at the documented counts
  (`whatsapp-inbound` 13/13, `whatsapp-transport` 27/27, `meta-whatsapp`
  17/17, `whatsapp-onboarding` 56/56, `credentials-runtime` 36/36,
  `meta-embedded-signup` 27/27); the Meta Embedded Signup HOLD is untouched.
  `pnpm verify` + `pnpm security` + `git diff --check` green. **Boundary of
  this slice's claim — the live E2E could NOT complete, and the reason is
  recorded exactly:** (1) the fix is committed but NOT deployed (the live
  307 is still reproducible on production right now); (2) `pnpm db:deploy`
  has NOT run — `prisma migrate status` reports the two Telegram migrations
  UNAPPLIED and a live `POST /api/telegram/webhook` locally raised
  `P2021 The table public.telegram_connections does not exist`; (3)
  `TELEGRAM_MANAGER_BOT_USERNAME` is ABSENT from the production Vercel env
  (presence-only check; the token + `CREDENTIAL_MASTER_KEY` ARE present), so
  `beginTelegramProvisioning` honestly refuses with «بوت الإدارة غير مُهيأ
  بعد» before minting a deep link; (4) the `/start` tap, the native
  bot-creation confirmation, and the first customer message are
  Telegram-hosted HUMAN actions no agent can perform. NO real managed bot was
  created, NO `setWebhook`/`getMe` for a managed bot ran, NO customer message
  was received or answered. The ONE real live E2E remains an operator action
  with the exact precondition list below.

- **Telegram CUSTOMER ONBOARDING SURFACE + LIVE E2E PREPARATION (DECISIONS
  #67) — UNCOMMITTED in the worktree (post-v0.30.0, on top of the #66
  provisioning state machine):** the minimum customer-facing surface
  realizing the approved low-friction experience is now BUILT and
  **behaviorally wired + offline-verified**. The customer NEVER enters a
  bot token, NEVER copies/pastes one, NEVER visits BotFather, NEVER
  understands webhook setup, and NEVER chooses a Business id, a connection
  id, or any infrastructure — the ONE customer action stays the single
  Telegram-side confirmation. **(A) The five UI states, ONE server-derived
  state machine (no second machine — the existing
  `TelegramConnectionUiState` represents them):** `EMPTY` (a clear
  explanation + ONE primary action «اربط تيليجرام») → `PENDING` +
  `PROVISIONING` (the session EXISTS server-side, so the redirect/open
  action stays available as «افتح رابط تيليجرام» — an idempotent RESUME of
  the same single-use attempt: the same token, the same deep link, no
  orphaned attempt; plus the honest progress state with a bounded live poll
  that reads ONLY the server-derived status and STOPS the moment the state
  leaves `PROVISIONING` — never a fake success, never a client-side
  assumption of completion) → `CONNECTED` (the bot's display name +
  @username + status + «فصل تيليجرام») → `ACTION_REQUIRED`/`FAILED` (a
  concise safe Arabic reason mapped from the typed outcome code + «أعد
  المحاولة» — never a credential, never provider text). `DISCONNECTED` is
  RETAINED (the verified disconnect/reconnect lifecycle's honest home;
  removing it would rework #66). The precedence is unchanged. **(B) The
  display name — the one small completion:** the connection's `displayName`
  is now populated from the `getMe` `first_name` the identity check ALREADY
  fetches (provider-reported, NON-SECRET, no extra API call) — the
  `managed_bot` event carries no display name, so this is the only honest
  source. **(C) Security — the approved model intact, verified again:**
  the deep link carries ONLY the opaque single-use token; the Business is
  ALWAYS server-derived (the screen's payload carries NO identity); the bot
  token is stored ONLY as an `fp:<id>` RUNTIME reference and appears in no
  response, log, DB projection, UI, or domain payload; ADMIN-only with role
  - tenant scoping re-checked server-side on every read and write. **(D)
    LIVE E2E PREPARATION — the smallest focused surface, NO fabricated
    result:** NEW `pnpm check:telegram-onboarding` **22/22** walks the exact
    customer journey through the REAL settings service + the REAL
    manager-webhook handler with in-memory fakes — EMPTY → the launch + the
    token-only deep link → the poll observing PROVISIONING → the idempotent
    re-open → `/start` binding + the keyboard (safe copy only) → the
    `managed_bot` completion → the poll observing CONNECTED (display name +
    @username, no secret) → single-use replay refusal → the typed-FAILURE
    loop (ACTION_REQUIRED + a retryable label + a FRESH attempt with a NEW
    token — the failed row is never resumed, no half-provisioned connection)
    → the authorization boundaries. NEW canonical `docs/TELEGRAM.md`
    (the managed model, the five UI states, the seams, the security model,
    the operator one-time setup, the ONE real live E2E procedure with an
    explicit "what must NOT happen" list) + a NEW `INTEGRATION_CHECKPOINTS.md`
    entry holding the Telegram checkpoint at **LIVE E2E PENDING** with the
    exact completion condition. **(E) UNTOUCHED — verified:** AI unchanged;
    WhatsApp impact NONE (the Meta Embedded Signup HOLD was NOT touched and
    is recorded as untouched); the #63 (F)(1) non-text decision STAYS OPEN.
    Guard: `pnpm check:telegram` re-run **96/96** (the `displayName` addition
    is backward-compatible), NEW `check:telegram-onboarding` **22/22**;
    `pnpm verify` + `pnpm security` green. **Boundary of this slice's claim:**
    NO real BotFather manager bot has ever been exercised — the whole
    customer path is offline-proven only; the ONE real live E2E is an
    operator action (`docs/TELEGRAM.md → The ONE live E2E`), and
    owner-change/`ManagedBotUpdated` handling + token rotation + the open
    #63 (F)(1) non-text decision remain the next slice.

- **Telegram MANAGER-BOT provisioning (DECISIONS #66) — UNCOMMITTED in the
  worktree (post-v0.30.0, on top of the #65 transport):** the whole
  managed-bot provisioning state machine is now LIVE server-side at
  **`POST /api/telegram/manager/webhook`**. The Admin's
  `/start <opaque-single-use-token>` BINDS the Telegram `user.id` to the
  in-flight ledger row (the Business comes ONLY from that row) and replies
  with the `KeyboardButtonRequestManagedBot` keyboard (the ONE unavoidable
  customer action); the `managed_bot` event completes provisioning
  server-side — `getManagedBotToken` via the manager bot → the token stored
  ONLY as an opaque `fp:<id>` RUNTIME reference → `setWebhook` with a fresh
  per-connection secret → `getMe` identity check → the ledger consumed
  exactly once → the connection written CONNECTED → `markOnboardingReady`.
  **Every failure TERMINATES the attempt with a typed outcome on the
  ledger**, so the polling surface shows `ACTION_REQUIRED` + a safe Arabic
  reason + a re-launch CTA — never a permanent spinner and never a
  half-provisioned connection (the provider calls run BEFORE the
  single-use consume). **THREE REAL DEFECTS the focused harness found and
  fixed in place (no re-architecture):** (1) the manager webhook secret
  verification DOUBLE-DERIVED (it HMAC'd the incoming header before
  comparing it to the HMAC of the manager token — no delivery could
  authenticate; now both sides are hashed with the plain SHA-256 the
  per-connection route uses, constant-time over fixed-length digests);
  (2) `bindCreator` could RE-BIND an already-bound token to a DIFFERENT
  chat — a shared deep link let a second account steal the attempt and
  attach a bot to a Business it was never launched for (now the
  conditional update matches unbound-or-already-bound-to-THIS-creator, so
  the one legitimate replay stays idempotent and a second account matches
  no row); (3) a FAILED completion never terminated the attempt — the row
  stayed in flight forever, a permanent spinner (the boundary now records
  the typed outcome; best-effort, race-safe on the unique `startToken`).
  The manager endpoint's own webhook is self-wired by `ensureManagerWebhook`
  at launch (secret DERIVED from the manager token with a fixed-label HMAC
  — no extra operator config, no persisted secret, rotates with the token).
  **AI impact: UNCHANGED and WhatsApp impact: NONE** — verified by grep:
  no Telegram conditional exists in any AI prompt, provider selection, the
  Conversation Engine, the disclosure gate, personality, booking,
  availability, handoff, or operator attention; every Telegram concern
  stays inside `src/server/integrations/telegram/` + the two Telegram
  repositories. Guard: `pnpm check:telegram` extended **47 → 96/96** (NEW
  sections L/M/N/O — the full manager-webhook lifecycle, typed failures,
  disconnect/reconnect, and every rejection boundary + provider failure +
  the CONNECTED transition guard); WhatsApp + credential + engine
  regression guards re-run green; `pnpm verify` + `pnpm security` green.
  **Boundary of this slice's claim:** the customer-facing `/settings/telegram`
  surface (which EXISTS in the worktree from the interrupted session and
  compiles + builds) was NOT behaviorally verified — wiring its polling to
  the state machine + live E2E against a real BotFather manager bot +
  owner-change/`ManagedBotUpdated` handling + token rotation + the open
  #63 (F)(1) non-text decision remain the next slice.

- **Telegram adapter + webhook + Conversation-Engine bridge (DECISIONS #65) — UNCOMMITTED in the
  worktree (post-v0.30.0, on top of the #64 foundation):** the thin Telegram
  adapter under `src/server/integrations/telegram/` owns Telegram protocol
  details ONLY — a single HTTP boundary (`telegram-client.ts`: the Bot API
  URL, the bot token in the path, `error_code`/`description` bodies, HTTP
  statuses mapped onto the EXISTING provider-neutral transport taxonomy),
  an Update parser (`telegram-webhook.ts`: a Telegram `Update` → the
  provider-neutral `NormalizedInboundTransportMessage` the WhatsApp path
  already uses), an outbound client (`telegram-transport.ts`:
  `sendMessage` → the existing `MessageTransport` boundary), and a
  `getMe`-backed `ConnectionVerifier` (`telegram-verify.ts`).
  **`POST /api/telegram/webhook`** validates `X-Telegram-Bot-Api-Secret-Token`
  with a CONSTANT-TIME comparison over fixed-length SHA-256 digests (401 on
  invalid/missing, BEFORE any parsing), validates the Telegram Update
  payload, extracts `update_id`, accepts private text messages only,
  resolves the connection server-side from the digest (the Business comes
  ONLY from the resolved connection row — never from the payload), invokes
  the EXISTING durable inbound dedupe (the namespaced `update_id` is the
  external key), normalizes the message, and hands it to
  `receiveInboundMessage` through the SAME `toEngineInboundMessage` seam as
  WhatsApp. **Returns HTTP 200 PROMPTLY** via Next 16 `after()` (backed by
  `waitUntil` on Vercel) — the approved DECISIONS #63 (E) behavior (Telegram
  retries on non-2xx then gives up), and the durable dedupe ledger keeps a
  redelivery idempotent if the deferred work is lost. The whole POST logic
  lives in `telegram-webhook-handler.ts` (adapter layer, injected deps) so
  the security path is offline-assertable; the route file is the thin
  composition point that wires the production singletons + the
  Telegram-backed `MessageTransport` (the engine default stays offline, so
  no non-Telegram entry point gains a live Telegram sender). No long
  polling, no polling fallback, no client-supplied Business selection, no
  tenant ids from the Telegram payload, and NO second messaging
  abstraction. **AI impact: UNCHANGED** — the engine, the AI contract, the
  context builder, the disclosure gate, handoff, operator attention, and
  usage telemetry are reused byte-for-byte (proven by the REAL engine
  turning a Telegram-handle inbound into a reply in `check:telegram` G).
  **WhatsApp impact: NONE** — re-run guards `whatsapp-inbound` 13/13,
  `whatsapp-transport` 27/27, `meta-whatsapp` 17/17; the Meta Embedded
  Signup HOLD in `INTEGRATION_CHECKPOINTS.md` was NOT touched. Guard:
  `pnpm check:telegram` extended **35 → 47/47** (new section H: route-level
  security + routing through the real handler — valid/invalid/missing
  secret, per-bot routing + cross-secret isolation, hostile-payload tenant
  injection refused, non-private/non-text ignored, malformed Update 400,
  `update_id` dedupe key stability, `managed_bot` acknowledged-not-dropped,
  and the 200-prompt + deferred-turn contract); `pnpm verify` +
  `pnpm security` green. **Boundary of this slice's claim:** the
  `managed_bot` completion is still deliberately DEFERRED at the route (it
  is acknowledged explicitly, never silently dropped), and the
  customer-facing provisioning surface (`/settings/telegram`, deep-link
  minting, the manager-bot `/start` creator binding), owner-change/token
  rotation handling, and the open non-text drop-vs-persist-and-defer
  decision (#63 (F)(1)) remain OUT of scope — see `Next Step`.

- **Telegram identity/data foundation (DECISIONS #64) — UNCOMMITTED in the
  worktree (post-v0.30.0):** the provider-neutral EXTERNAL HANDLE identity **Post-v0.29.1 audit
  (evidence-backed, no code change):** the real LLM runtime answered a live
  `BOOKING` turn (`atria / Atria-Dawn-Preview`, policy-resolved from the live
  DB — `OPENROUTER_API_KEY`/`AGENTROUTER_API_KEY`/`ATRIA_API_KEY` are all
  present in the local dev env); the Meta Embedded Signup configuration seam
  resolves `ready: true` locally (all four names present); the RUNTIME
  credential store round-trips exactly against the local dev DB with
  `CREDENTIAL_MASTER_KEY` set; a real Meta round-trip has still never been
  executed (see `docs/INTEGRATION_CHECKPOINTS.md`).

- **Telegram identity/data foundation (DECISIONS #64) — UNCOMMITTED in the
  worktree (post-v0.30.0):** the provider-neutral EXTERNAL HANDLE identity
  seam replaces the phone-shaped inbound contract (`externalHandleSchema`;
  E.164 is a strict subset, so every existing WhatsApp payload is
  unchanged — proven by the re-run WhatsApp guards), plus two NEW
  additive tables and the ONLY Prisma consumers for them:
  `telegram_connections` (a transport SIBLING of `whatsapp_connections` —
  businessId required / branchId optional / `botExternalId` authoritative /
  `credentialsRef` = an opaque `fp:<id>` RUNTIME reference, never the raw
  bot token / `webhookSecretHash` = a non-secret SHA-256 digest used as the
  inbound routing index / the same two-surface operational + onboarding
  lifecycle / `managerBotId` + `creatorTelegramUserId` provenance) and
  `telegram_provisioning_ledgers` (the single-use ledger whose
  `startToken` is the ONLY thing the deep link carries). Migration
  `20260926120000_telegram_connection` is ADDITIVE — `migrate diff` is
  exactly the two tables + indexes/FKs, ZERO ALTERs on existing tables;
  chain 13 → 14 (apply is an operator action). All single-use / replay /
  tenant-isolation / creator-binding / duplicate-bot guarantees are
  STRUCTURAL (in the SQL WHERE clauses of the conditional updates).
  WhatsApp compatibility: `check:whatsapp-inbound` 13/13,
  `check:whatsapp-transport` 27/27, `check:meta-whatsapp` 17/17,
  `check:meta-embedded-signup` 27/27, `check:credentials-runtime` 36/36,
  `check:conversation-control` 50/50, `check:ai-disclosure` 36/36,
  `check:greeting` 57/57, `check:conversation-handoff` 21/21 all re-run
  green. Guard: NEW `pnpm check:telegram` **35/35** (offline, in-memory);
  `pnpm verify` + `pnpm security` green. **Boundary of this slice's
  claim:** the webhook + HTTP-adapter + provisioning-wiring + customer
  provisioning UI are NOT part of it — see `Next Step`.

- **AI personality / operator notification / conversation UX (DECISIONS #62) — UNCOMMITTED in the worktree (on top of #61):**
  the smallest evidence-backed surface for the three concerns, with ZERO
  schema/migration/booking/availability/transport change.
  **(A) Personality** — NEW `src/features/conversations/server/assistant-style.ts`:
  the assistant's voice is ONE structured module of validated closed-enum values
  over the six candidate dimensions (language / arabicStyle / tone / detail /
  emoji / role) with a SINGLE resident default (Arabic, Egyptian-flavored MSA,
  friendly-professional, concise, no emoji, booking-assistant) — because
  DECISIONS #43/#48 forbid a prompt editor UI and lock prompt bodies to Git,
  and no pilot evidence yet picks a per-business voice. It reaches the assistant
  as REQUEST CONTEXT, never as a prompt body: `renderAssistantStyleDirective()`
  is embedded by the B-02 builder into the NEW optional `AiRequest.assistantStyle`
  field (parallel to `businessName`, "phrasing only") and rendered by
  `buildPromptMessages` into the shared user-context block. Provider- and
  channel-neutral by construction (the module imports no adapter and names no
  provider or channel), so a provider swap or a future Telegram channel needs
  NO style rewrite. **It can never override disclosure/safety/authority:** the
  disclosure gate never reads it (no import, no field in its input type — so the
  closed `KNOWLEDGE_FREE_REPLY_INTENTS` list cannot be widened by a style, proven
  behaviorally too), and the directive expressly forbids claiming to be human.
  The deterministic voice (`REPLIES`) is asserted to CONFORM to the style
  (Arabic-only, no emoji, concise, greeting self-identifies) rather than moved —
  determinism (#61) is untouched. **Persistence deliberately NOT added** (one
  nullable column + nested Zod object — a domain decision deferred to pilot
  evidence; NO migration, NO UI).
  **(B) Operator attention — audited correct; one genuine gap closed.** All 8
  required properties verified (single engine choke point; idempotent via the
  unique-conversationId `upsert`; duplicate inbound stopped by the durable
  dedupe ledger BEFORE any attention write; all 5 notification payloads safe;
  one-link operator reach; mobile usable; attention never color-only). The ONE
  gap: opening a flagged conversation did not show WHY (only the generic status
  badge; the alert was acknowledged server-side before render). FIXED:
  `getConversationDetail` reads the open attention `reason` BEFORE resolving it
  and returns it as `attentionReason`; the detail header renders a new
  `AttentionReasonChip` (icon + the existing operational Arabic
  `ATTENTION_REASON_LABELS` + a full accessible name) next to the status badge —
  present only on the first load of an unacknowledged handoff. NO second
  notification architecture: the typed `NotificationSink` stays a documented
  in-memory port; the live mechanism is still the ONE `operator_attentions` row.
  **(C) Conversation UX — audited.** The previously-observed identity issue is
  ALREADY SOLVED structurally: the detail screen is a fixed-height panel whose
  message log is the only scroll container, so the header (customer `<h1>` +
  `dir="ltr"` phone + status badge + reason chip + actions) stays pinned while a
  long thread scrolls — NO sticky UI was added (the prompt warned it could
  conflict with the mobile shell + safe-area). Two small gaps closed: the
  operator's primary actions were 32px → now `min-h-11` (44px) on mobile only
  (desktop compact height preserved via `md:` resets; no shared-primitive
  change), and the "جارٍ الإرسال…" indicator was not announced → now
  `role="status"`. Verified clean and unchanged: RTL (logical properties only),
  360px layout (`dvh`-sized panel fits the mobile shell), loading/empty/error
  states, keyboard access. **(D) Naturalness** — no code change; already
  delivered by #61 + the new directive; the assistant never fakes being human.
  **(E) Intent taxonomy** — unchanged: exactly the 8 documented intents;
  SMALL_TALK/THANKS/GOODBYE/CHITCHAT/CONFIRMATION stay documented future
  observations. **Channel impact:** the personality and the notification
  behavior are BOTH shared/reusable by a future Telegram (or any) channel.
  Guards: NEW `check:assistant-style` 27/27, NEW `check:conversation-ux` 18/18,
  `check:operator-attention` extended 15 → 20/20.

- **Shared conversation-layer UX — GREETING + verified handoff/resume (DECISIONS #61) — UNCOMMITTED in the worktree:**
  the ONE new intent `GREETING` is answered deterministically in the shared
  `classifyCustomerMessage` / `bypassDeterministicAi` seam, so a pure Arabic
  social opening («السلام عليكم» / «أهلاً» / «صباح الخير» / «ازيك») spends
  ZERO LLM calls and stays `AI_ACTIVE` (the engine consults the bypass BEFORE
  the assistant). It crosses the B-03 disclosure boundary by DECLARED INTENT
  only — `KNOWLEDGE_FREE_REPLY_INTENTS` is a closed single-member list, so a
  greeting needs no backing fact, and the gate still never inspects text.
  Purity is structural: any booking/availability/cancellation/reschedule/human/
  sensitive word, or a question mark, disqualifies the greeting reading, so a
  real intent is never swallowed («السلام عليكم، عايز أحجز موعد» → BOOKING).
  The handoff/resume half deliberately changed NOTHING functional: the explicit
  Resume AI control ALREADY EXISTED as `transitionConversation`'s `RETURN_TO_AI`
  transition (→ `AI_ACTIVE` + `assignedUserId: null` + attention resolved) wired
  to the operator UI button «إعادة للمساعد»; it was VERIFIED end-to-end and
  guarded against drift, not recreated. The human-ownership invariant STANDS: a
  message on a NEED_HUMAN thread is `DEFERRED_TO_STAFF` with zero provider calls
  until the operator explicitly resumes the AI. Preserved byte-for-byte:
  `aiResponseSchema` / `parseAiResponse`, the disclosure gate's fail-closed
  rules (the closed list cannot be widened by a provider), booking/availability
  authority, tenant isolation, idempotency, provider neutrality, and the
  AI/domain separation. Only the intent enum gained one value; the prompt
  artifact was re-generated (sha256 updated) so a live provider can also emit
  `GREETING`. NO migration. Guard: NEW `check:greeting` 57/57, NEW
  `check:conversation-handoff` 21/21, extended `check:ai-disclosure` 36/36.

- **AI-failure WhatsApp acknowledgment (DECISIONS #60) — SHIPPED in v0.29.4:**
  live forensics against the production Neon DB proved the real failure
  boundary after the CodeCraft policy switch. On thread `5b06bb77…` (Business
  «مركز أفنان», `Business.faqs` EMPTY), a real inbound produced an `AI_TURN`
  usage row `provider:"codecraft" model:"deepseek-v4-flash-0731"
status:"FAILURE"` (tokens null) ~2.5s after inbound — a FAST failure, not a
  16s timeout — followed by NO assistant message and NO `OUTBOUND_MESSAGE`;
  the thread stuck NEED_HUMAN so later messages were `DEFERRED_TO_STAFF`. The
  live probe simultaneously proved the provider HEALTHY: `pnpm
probe:codecraft` (3 runs) → `GET /v1/models` 200 with the exact model
  present (ctx=1048576, `json_mode`), 3/3 chat SUCCESS, `DIRECT_PARSE`,
  `parseAiResponse` conforming, max latency 7.9s < the 16000ms bound. **Root
  cause was therefore NOT CodeCraft** but the engine's AI-failure branch
  (`turn == null` / `parseAiResponse` rejects), which #58 had explicitly left
  as a silent `updateWorkflow(NEED_HUMAN)` + `delivery:null` handoff — the
  same silence #58 removed from the disclosure-refusal branch. **Fix:** on a
  failed/invalid AI turn the engine now emits the SAME deterministic safe
  handoff acknowledgment #58 uses (`classifyCustomerMessage`), persists +
  delivers it, and still escalates to NEED_HUMAN + operator attention.
  Preserved byte-for-byte: `parseAiResponse`/`aiResponseSchema`, the
  disclosure gate, Conversation Control retry/handoff semantics, the
  provider-neutral architecture (no provider branching), tenant isolation,
  idempotency, and the AI/domain separation — no AI-authored content is ever
  trusted on failure. No migration, no prompt change. Harness assertions that
  codified the old silent contract were updated to assert the fix
  (`check:ai-disclosure` 13a, `check:whatsapp-inbound` 10).

- **CodeCraft Discovery provider adapter (DECISIONS #59) — SHIPPED in v0.29.3:**
  CodeCraft API (`https://codecraftapi.com/v1`, OpenAI-compatible, Bearer)
  added as a completely isolated provider through the EXISTING boundary only —
  one thin adapter over the ONE shared `callOpenAiCompatible`, plus the 8-file
  registration (allowlist, union, factory branch, label/secretRef, EMPTY
  normalization policy, tests, probe, env docs). It replaces Atria for current
  AI experiments WITHOUT rewriting the AI architecture; Atria is NOT deleted
  and is NOT required for CodeCraft to function. ZERO schema/migration/prompt/
  booking/WhatsApp/engine change. The adapter owns only endpoint + secret
  reference + provider id + timeout. **Provider selection stays policy-backed:**
  the operator sets `codecraft` + a model in `platform_ai_policies` via
  `updateAiPolicy` (runtime; switching back is a policy change only). **Model
  discovery:** no model catalog is hard-coded; `GET /v1/models` is the source of
  truth (endpoint verified reachable — 401 unauthenticated), and the sanitized
  `pnpm probe:codecraft` records only safe metadata, never the key, with no DB
  write and no model-registry feature. Removal map verified: 8 files, nothing
  else touched (`docs/ai/PROVIDERS.md` §8). **NOT a permanent strategic
  provider choice** — provider quality/reliability remains an empirical
  Discovery question. **Operator actions before Discovery testing:**
  (1) put `CODECRAFT_API_KEY` in `.env.local` (server-side only, never DB/UI);
  (2) run `pnpm probe:codecraft` to discover the account's models and confirm
  JSON-mode + Arabic + `AiResponse` compatibility (live stages were NOT run in
  this session — no key was present in the environment);
  (3) set the policy's `primaryModel` to a model the probe proves available.
  forensically proven and fixed the exact runtime blocker that stopped a real
  inbound WhatsApp message from receiving any reply. A live customer message
  ("اهلا") on an AI_ACTIVE thread made the live `atria` model return a
  schema-valid self-authored `AMBIGUOUS` reply; the B-03 disclosure gate
  correctly refused it (this Business's `Business.faqs` store is empty), but
  #52's refusal path was a SILENT handoff — no reply persisted, no outbound
  Graph request, and the thread stuck in NEED_HUMAN so every later message
  was `DEFERRED_TO_STAFF` too. Booking turns kept working because their
  replies are domain-authored and never cross the gate (why earlier live
  BOOKING verification missed it). **Fix:** on refusal the engine now
  delivers the SAME deterministic safe handoff acknowledgment the
  deterministic assistant produces (`classifyCustomerMessage`), still
  escalating to NEED_HUMAN + operator attention; the gate itself, the
  dropped refused content, tenant isolation, idempotency, and the AI/domain
  separation are all unchanged. Real Graph send verified `delivered:true`.
  No migration. **Operator action before the next release:** none beyond the
  normal review + `pnpm release`/`pnpm ship` + deploy.

- **Slot presentation (DECISIONS #56) — SHIPPED in v0.29.1:** the slot
  step renders the known candidate time grid; a candidate the authority did NOT
  return is visibly muted + disabled + non-clickable + labelled «غير متاح»; no
  reason is ever inferred (never «مشغول»/Busy). One shared pure module
  (`src/lib/scheduling/slot-grid.ts`) that the authority DELEGATES to and the
  client imports — no second availability engine, exactly ONE availability
  request per step. Includes: customer-create prefill via the existing
  `deriveCustomerFormDefaults`; operator-attention a11y label
  («تحتاج انتباهك» — state never color-only); appointment date/time
  formatter consolidation onto the shared `date-format`/`slot-helpers`.
  ZERO schema/migration/prompt/provider/AI-boundary change.
- **Availability authority — UNCHANGED and binding:** `getAvailability` returns
  ONLY genuinely selectable slots; server-authoritative booking; no per-slot
  availability requests; no Busy/reason inference (DECISIONS #55/#56).
- **Verification state (as recorded by each slice, offline harnesses):**
  `check:telegram` 96/96 (DECISIONS #66 — the manager-bot provisioning
  completion; extended from 47/47 by the new sections L/M/N/O; re-run
  green by #67 after the `displayName` addition),
  `check:telegram-onboarding` 22/22 (DECISIONS #67 — the customer
  onboarding journey through the REAL service + REAL manager handler:
  EMPTY → launch → token-only deep link → PROVISIONING observed by the
  poll → `/start` binding + keyboard → `managed_bot` completion → CONNECTED
  observed by the poll → single-use replay refusal → the typed-failure
  retry loop → the authorization boundaries),
  `check:appointments-day-view` 56/56, `check:booking-ux` 18/18,
  `check:reschedule` 66/66, `check:appointment-creation` 53/53,
  `check:booking-options` 32/32, `check:booking-confirm` 18/18,
  `check:conversation-booking` 16/16, `check:eligibility` 29/29,
  `check:services` 50/50, `check:knowledge-faq` 32/32,
  `check:knowledge-visibility` 36/36, `check:ai-context-builder` 39/39,
  `check:ai-disclosure` 36/36, `check:ai-prompts` 102/102,
  `check:conversation-control` 50/50, `check:conversation-handoff` 21/21,
  `check:conversation-ux` 18/18, `check:assistant-style` 27/27,
  `check:greeting` 57/57, `check:operator-attention` 20/20 (extended by #62
  with the duplicate-inbound / safe-payload / navigation / never-color-only /
  structural-choke-point guards),
  `check:policy` 13/13, `check:signup` 13/13, `check:whatsapp-transport` 27/27,
  `check:whatsapp-onboarding` 56/56, `check:meta-whatsapp` 17/17,
  `check:meta-embedded-signup` 27/27, `check:whatsapp-inbound` 13/13,
  `check:credentials-runtime` 36/36, `check:atria-retry` 17/17. The CodeCraft
  slice (DECISIONS #59, shipped v0.29.3) additionally records
  `check:ai-provider` 74/74 (11 CodeCraft checks incl. provider isolation) and
  `check:response-normalizer` 78/78. The #60 slice (shipped v0.29.4) re-records
  `check:ai-disclosure` (13a updated) and `check:whatsapp-inbound` 13/13
  (test 10 updated) to assert the new acknowledgment-on-failure contract. The
  #61 slice (uncommitted) extends `check:ai-disclosure` to 36/36 (GREETING
  discloses by declared intent; the closed list cannot be widened by a
  provider), re-probes two `check:whatsapp-inbound` tests that used a
  greeting as their engine probe (a greeting is now answered before the
  assistant runs, so the probe must be a non-greeting to still exercise the
  AI-success / AI-failure paths — 13/13), and adds the two NEW focused
  checks above.
  `pnpm verify` + `pnpm security` green at each release. Real-browser
  verification NOT performed (structurally asserted in the harnesses).

## Completed Major Work

Condensed ledger; full per-slice record in
`docs/archive/IMPLEMENTATION_HISTORY.md` (Tier 3).

| Area                                                                          | Highlights                                                                                                                                                             | Release / Decision  |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Foundation                                                                    | Next.js 16 + TS strict + Tailwind v4 + shadcn/ui, Better Auth, Prisma 7 / Neon, feature-based modular monolith, env fail-fast, PWA                                     | v0.1–v0.13          |
| Design system / RTL / PWA                                                     | Arabic-first RTL tokens, AppShell, status system, PNG PWA icons                                                                                                        | v0.2                |
| Database layer                                                                | Full Spec A domain model + Invitation, repositories (only Prisma consumers), Zod DTOs, Arabic demo seed                                                                | v0.5–v0.8           |
| Onboarding wizard                                                             | 4-step operational foundation, smart resume, step guards, `Business.vertical` discovery metadata                                                                       | v0.9                |
| Dashboard / Conversations / Appointments / Customers / Team / Staff workspace | All Spec A screens incl. NEED_HUMAN handoff queue, takeover, role-aware nav                                                                                            | through v0.19.x     |
| Smart availability + Smart Create 1–6                                         | Deterministic `getAvailability`; 6-step booking flow; candidate time grid per #56                                                                                      | v0.13–v0.29 / #56   |
| Architecture hardening (P0)                                                   | Branch model, WhatsAppConnection, Provider relations, `users.accountType`, SERIALIZABLE booking concurrency, durable inbound idempotency, AI contract, usage telemetry | v0.18 / #38         |
| Migration-chain repair                                                        | `0_init` root baseline + `migration_lock.toml`; empty DB bootstraps via `pnpm db:deploy`                                                                               | ARCH-03 / #40       |
| Platform control plane                                                        | Public signup closed (403 `SIGNUP_CLOSED`), Platform Operator guards, platform owner invitations, Platform AI policy singleton                                         | OPS-05 / #41        |
| Meta WhatsApp adapter                                                         | `GET`\|`POST /api/whatsapp/meta`, HMAC verify, Graph outbound, `phone_number_id` authoritative inbound key, tenant-scoped resolution                                   | CORE-03B / #42, #46 |
| Real LLM provider adapter                                                     | Policy-backed `ConversationAi` (OpenRouter primary / AgentRouter secondary / fallback); secrets via `secretRef` only                                                   | AI-02 / #44         |
| Prompt Workspace                                                              | `/prompts/**/*.prompt` → `generate:ai-prompts` → committed generated artifact → `prompt-registry.ts`; no inline bodies, no silent fallback                             | v0.19.1 / #48       |
| Meta Embedded Signup + runtime credentials                                    | OAuth redirect + code exchange, single-use `stateRef` ledger, AES-256-GCM `runtime_credentials` (env grammar unchanged); `CREDENTIAL_MASTER_KEY` optional              | v0.20.0 / #49       |
| AI knowledge visibility + context builder + disclosure gate                   | Four-level policy (PUBLIC/CONDITIONAL/INTERNAL/FORBIDDEN); "AI may know" ≠ "AI may mention"; structural reply gate                                                     | v0.22.0 / #50–#52   |
| Human Handoff + Operator Attention                                            | Attention signal derived server-side; visually-hidden label; staff/inbox surfacing                                                                                     | v0.23.0             |
| Knowledge/FAQ authoring UX                                                    | Suggested-FAQ authoring over the ONE `Business.faqs` store; confirmed removal                                                                                          | v0.24.0             |
| Service Catalog + Authoring                                                   | Catalog is domain data (not a 2nd KB); soft-delete + duplicate-name guard; `durationMinutes` is INTERNAL                                                               | v0.25.0 / #53       |
| Appointment Creation UX                                                       | `?customerId=`/`?serviceId=` smart context, relative dates, «أقرب وقت متاح», relative follow-up                                                                        | v0.26.0 / #54       |
| Booking UX + customer prefill                                                 | Date-step coherence; customer-create prefill from the typed query                                                                                                      | v0.27.0             |
| Reschedule UX                                                                 | Availability-guided reschedule with self-exclusion (`excludeAppointmentId`)                                                                                            | v0.28.0             |
| Appointments/Availability coherence                                           | Day-view state reset per selected day; day-capacity chips (مغلق/ممتلئ/غير متاح); date-format consolidation                                                             | v0.29.0 / #55       |
| Slot presentation                                                             | Known candidate grid; non-returned candidates visible-but-disabled «غير متاح»; no reason inference                                                                     | v0.29.1 / #56       |

## Key Known Limitations (current)

- Availability is a READ layer: no slot reservation; the write-time SERIALIZABLE
  conflict check is the authority. Residual: a rare false-positive
  serialization abort under contention surfaces as `SLOT_CONFLICT` — a manual
  retry succeeds.
- Unassigned appointments block the whole business day
  (staff-assignment-aware availability is a later decision).
- The AI assistant's deterministic path avoids LLM calls when safely possible;
  Arabic greetings are now covered by it (DECISIONS #61); phrasings outside the
  keyword/FAQ vocabulary still land on NEED_HUMAN.
- The Branch/ProviderProfile/usage foundations have partial management UI only
  (`/settings/whatsapp` covers WhatsAppConnection); usage telemetry is recorded
  but not surfaced; `estimatedCostMicros` is never computed by the codebase.
- No per-entry id / active state / timestamps for `Business.faqs` JSON rows
  (DECISIONS #13 shape); guards are workflow-level.
- Customer creation collects no email; edit/deletion not exposed in the UI.
  Directory reads cap at 20 customers/page (pilot scale).
- Appointments accept past dates at the domain level (`min=today` is a UX guard
  only). Knowledge/FAQ cap is 50 entries.
- The `20260913150000_account_issuer` migration was hand-authored (no shadow
  DB on the build device); verified by deploy + schema diff + live sign-in.
- Termux device: builds use `--webpack`; the Prisma schema engine cannot run
  on-device (migrate from desktop/CI).

## Architecture Hardening (P0 — IMPLEMENTED)

Accepted as DECISIONS #30–#36 (PROMPT-ARCH-01) and implemented in
PROMPT-ARCH-02 (DECISIONS #38): Branch model (`Business.defaultBranchId`
pointer; required `branchId` server-resolved to the Default Branch),
WhatsAppConnection (businessId required / branchId optional),
ProviderProfile/ProviderService/ProviderBranch relations, platform-operator
marker, SERIALIZABLE booking concurrency with bounded retry, durable
`inbound_message_dedupe` idempotency, structured `ai-contract.ts`, append-only
`usage_records`. Details: `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`.

## Migration State

Chain is **complete and clean**, rooted at `0_init` + `migration_lock.toml`
(provider postgresql). **15 migrations**, ending at
`20260927120000_telegram_provisioning_outcome` (the two Telegram
migrations: `20260926120000_telegram_connection` — DECISIONS #64, ADDITIVE:
two new dedicated tables only, verified by `prisma migrate diff` = exactly
those tables + indexes/FKs, zero ALTERs on existing tables; and
`20260927120000_telegram_provisioning_outcome` — DECISIONS #66, ADDITIVE:
one new NULLABLE `outcome_code` column on the ledger table introduced by
the previous migration, which has NOT been applied to any database yet, so
no existing column/constraint/index/table is renamed, reinterpreted, or
dropped). **APPLIED to the production Neon DB as of 2026-09-27
(live-verified by DECISIONS #69):** `prisma migrate status` → "Database
schema is up to date!" (all 15), and a direct production-DB read confirms
both `telegram_connections` + `telegram_provisioning_ledgers` exist with
the `outcome_code` column. A genuinely EMPTY database bootstraps
fully via `pnpm db:deploy` (verified 8/8 at repair time; deploy count grows
with each additive migration — re-run to reconcile). The old Demo/Neon DB
needed a one-time HUMAN-ONLY baseline reconciliation
(`prisma migrate resolve --applied 0_init` → `pnpm db:deploy`). Schema diff
against `schema.prisma` is empty. Full list: `docs/DATABASE.md`.

## Ops State

- **Production:** `https://flowpilot-prod.vercel.app` — Neon production DB
  (`ep-tiny-grass-a5e63jev-pooler` pooler), dedicated Vercel project
  `flowpilot-prod`, repository PRIVATE. **Last live-verified checkpoint:
  v0.31.2** (2026-09-27, DECISIONS #69 — `GET /api/health` →
  `version:"0.31.2"`, `deploymentReady:true`, `database:"connected"`,
  `missingEnvVars:[]`; production env PRESENCE verified without reading any
  value: `TELEGRAM_MANAGER_BOT_TOKEN` ✓, `TELEGRAM_MANAGER_BOT_USERNAME` ✓
  (now present), `CREDENTIAL_MASTER_KEY` ✓, `NEXT_PUBLIC_APP_URL` ✓.
  **The #68 routing fix IS live** — both Telegram webhooks return 401
  fail-closed with no 307. **The whole launch + binding chain ran for
  real** and the manager webhook is installed on the Manager Bot at the
  production URL. **Production carries v0.31.2 but is NOT yet re-deployed
  with the DECISIONS #69 `request_id` fix** — the deployed build still
  sends the invalid empty `request_managed_bot` object, so the creation
  keyboard is still rejected and the live E2E still cannot complete until
  the operator deploys the current head.
  Live inbound E2E was proven at the earlier v0.15.9 checkpoint (signed
  webhook → 200, dedupe replay, tenant isolation).
- **Demo:** `https://flowpilot-demo-gamma.vercel.app` — isolated Demo Neon DB,
  dedicated project, `DEMO_MODE=true`, seeded deterministic/idempotent (1
  business, 1 Default Branch, 2 team users, 6 services, 36 customers, 22
  conversations, 73 messages, 37 appointments). Demo credentials exist ONLY in
  the Demo DB. The suggested `flowpilot-demo.vercel.app` domain is owned by an
  unrelated third party — the live domain is the `-gamma` one.
- **Release model:** `pnpm release` (full gated path) or the lightweight
  `pnpm ship patch|minor` (DECISIONS #26) — never both. Both are
  **operator-only** actions; agents never commit/tag/push/ship.
- **Bootstrap tools (one-time, operator):** `pnpm bootstrap:admin`,
  `pnpm bootstrap:operator`.

## Unresolved User Actions (not code)

1. **Operator — the ONE remaining Telegram live-E2E unblock (DECISIONS
   #69).** Three of the four #68 blockers are already live-verified
   RESOLVED (deployed routing fix, applied migrations, present
   `TELEGRAM_MANAGER_BOT_USERNAME`). Exactly two operator-owned items
   remain, neither a code task:
   (a) **deploy the current head** (`pnpm deploy`) — the deployed v0.31.2
   still sends the invalid empty `request_managed_bot` object, so the
   creation keyboard is rejected by the real Bot API and the ONE customer
   action can never appear; deploy to make the #69 `request_id` fix live;
   (b) **re-run the ONE live E2E** (`docs/TELEGRAM.md → The ONE live E2E`)
   from a FRESH launch — the `/start` tap, the native bot-creation
   confirmation, and the first customer message are Telegram-hosted
   human actions. Then record the outcome here + a `DECISIONS.md` entry if
   a further defect surfaces.
2. **Operator:** review + release the uncommitted **#61** shared conversation-layer UX
   slice (GREETING intent + verified handoff/resume — the only functional
   changes are the deterministic greeting branch in `conversation-ai.ts`, the
   closed `KNOWLEDGE_FREE_REPLY_INTENTS` list in the disclosure gate, one enum
   value, and the re-generated prompt artifact), then release it as the next
   patch (`pnpm release`/`pnpm ship`) and deploy (see below). The #60
   AI-failure acknowledgment fix already shipped as v0.29.4.
3. **Operator (only if RUNTIME credentials are used):** generate and set
   `CREDENTIAL_MASTER_KEY` in the deployment env. Until set, the RUNTIME
   credential path stays honestly UNAVAILABLE and the ENV pilot path is
   unaffected. (Live evidence, post-v0.29.1: against the local dev DB the
   RUNTIME store round-trips exactly with `CREDENTIAL_MASTER_KEY` set —
   store/resolve/delete all succeed. A real Meta round-trip still has
   never run — see `docs/INTEGRATION_CHECKPOINTS.md`.)
4. **Operator (optional):** add `OPENROUTER_API_KEY` / `AGENTROUTER_API_KEY` /
   `ATRIA_API_KEY` to Vercel env; `pnpm db:deploy` against the Demo DB.
5. **Operator (optional):** exercise one real outbound to an operator-owned
   WhatsApp number inside the 24h window to observe a `200` delivery.

## Next Step

1. **Operator — finish the ONE Telegram live E2E (DECISIONS #69/#70).** The
   code is now correct after the second live-found fix (#69) AND the two
   code-proven `getManagedBotToken` wire-shape fixes (#70 — G-1 `user_id`,
   G-2 bare-string token); exactly two operator actions stand between BUILT
   and LIVE-VERIFIED, listed in
   `Unresolved User Actions` (1): **deploy the current head** so the
   `request_id` fix AND the `getManagedBotToken` wire fixes are live (the
   routing fix, the migrations, and
   `TELEGRAM_MANAGER_BOT_USERNAME` are already done — live-verified), then
   **re-run `docs/TELEGRAM.md → The ONE live E2E` from a fresh launch**.
   Then record the outcome here + a new `DECISIONS.md` entry if a further
   defect surfaces. **Do not report a simulated success** — the offline
   harnesses prove code paths only, and two consecutive real attempts have
   now each surfaced a distinct blocking defect that every offline guard
   was green for. **Also (DECISIONS #72), on the affected Android device:
   launch from `/settings/telegram`, tap «فتح في Telegram» in the new app
   chooser, and confirm it opens STANDARD Telegram (`org.telegram.messenger`)
   and completes the flow — the client fix is code-proven + guarded
   (`check:telegram-onboarding` 32/32) but NOT live-verified.**
2. **Telegram second channel — the foundation, transport sibling, manager-bot
   provisioning state machine, AND the customer onboarding surface are all
   BUILT and VERIFIED offline** (DECISIONS #63 discovery → #64 foundation →
   #65 adapter/webhook → #66 manager-bot provisioning → #67 customer
   onboarding surface → #68 first live E2E pass): the ONE core change is DONE —
   the inbound identity seam is widened from `phoneSchema` to a
   provider-neutral `externalHandleSchema` (E.164 is a strict subset, so
   WhatsApp is unchanged — proven by the re-run WhatsApp guards). Two NEW
   additive tables with repository-only access (migrations
   `20260926120000_telegram_connection` + `20260927120000_telegram_provisioning_outcome`
   — zero ALTERs on existing tables), and `TELEGRAM_MANAGER_BOT_TOKEN` is an
   env secret. The thin adapter under `src/server/integrations/telegram/`
   (HTTP client, Update parser, outbound `MessageTransport`, `getMe`
   `ConnectionVerifier`, webhook handler) + `POST /api/telegram/webhook` are
   BUILT; the manager-bot provisioning path
   (`POST /api/telegram/manager/webhook`: `/start` creator binding +
   keyboard, `managed_bot` → `fp:<id>` → `setWebhook` → `getMe` →
   CONNECTED, with typed failure outcomes) is BUILT and covered by
   `pnpm check:telegram` **99/99** (NEW section P — the live-found proxy
   reachability guard); the `/settings/telegram` customer
   surface is BUILT + behaviorally wired + covered by
   `pnpm check:telegram-onboarding` **22/22** (the customer journey through
   the REAL service + REAL manager handler; DECISIONS #67); `pnpm check:signup`
   **18/18** now guards the public-path policy for provider webhooks.
   `pnpm verify` + `pnpm security` green. **LIVE status (DECISIONS #68):**
   the real Manager Bot is LIVE-VERIFIED (`@FlowPilotManagerBot`,
   `can_manage_bots: true`); the webhook-route 307 defect is LIVE-PROVED +
   FIXED + GUARDED + proven locally (401, no auth regression) but
   **NOT deployed**; the migrations are **NOT applied**;
   `TELEGRAM_MANAGER_BOT_USERNAME` is **ABSENT** in production; the human
   Telegram confirmation steps are **NOT performed**. So: provisioning,
   setWebhook-for-a-managed-bot, getMe-for-a-managed-bot, CONNECTED, and the
   customer round-trip are all **NOT LIVE-VERIFIED**. **Remaining for
   Telegram:** the four operator actions above, then
   owner-change/`ManagedBotUpdated` handling + token rotation (DEFERRED,
   structurally ready — `managerBotId`/`creatorTelegramUserId` provenance
   already persisted; needs its own slice, not invented here), and the open
   decision #63 (F)(1) — non-text inbound routing
   (drop vs persist-and-defer) is still open; the MVP private-chats-only
   scope is implemented at both parsers (non-private/non-text are
   acknowledged 200 and not processed).
3. **Fresh live WhatsApp E2E** (operator, REQUIRED): send one real inbound
   message on an AI_ACTIVE thread with the policy still on `codecraft` /
   `deepseek-v4-flash-0731` and confirm the customer receives a reply even if
   the provider fails. The live probe proved the CodeCraft path healthy
   (3/3, `DIRECT_PARSE`, max 7.9s), so the prior `AI_TURN` FAILURE is
   non-deterministic — but any failure must no longer produce silence.
4. **Onboard the first REAL pilot Business end-to-end** — operator provisions
   the Business + invitation → ADMIN connects the WhatsApp number via Meta
   Embedded Signup at `/settings/whatsapp` → CONNECTED → live messaging →
   gather baseline/ROI evidence per `PRODUCT_STRATEGY.md`.
5. **Only after pilot evidence justifies it:** Spec B instrumentation /
   economics (usage → cost → price → entitlement; `ECONOMICS.md`). Not before
   pilot evidence exists.

After each prompt: update this file (minimally) and append to `DECISIONS.md`
when a decision was made.
