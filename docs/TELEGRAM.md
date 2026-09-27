# FlowPilot — Telegram (Second Channel)

> **The canonical Telegram document.** Telegram is a TRANSPORT SIBLING of
> WhatsApp, not a second product (DECISIONS #63): the ONE conversation
> engine, the ONE provider-neutral transport seam, the ONE customer
> identity key, and the ONE disclosure gate are all reused unchanged.
> This document covers the customer-facing managed-bot onboarding model,
> the operator one-time setup, the ONE live E2E procedure, and the
> boundaries that must not be silently reopened. Reading policy: Tier 1
> for Telegram work (`AGENT_RULES.md`).
>
> Related: `ARCHITECTURE.md → Channel Boundary`, `DATABASE.md` (the two
> Telegram tables), `INTEGRATION_CHECKPOINTS.md` (the live-E2E hold),
> `BUILD_STATE.md` (implementation ledger). Decisions: #29 (provider-neutral
> seams), #31 (connection first-class), #63 (Telegram as second channel),
> #64 (identity/data foundation), #65 (adapter + webhook + bridge), #66
> (manager-bot provisioning state machine), #67 (customer onboarding
> surface + live E2E preparation).

---

## 1. The approved model — Managed Bots (no token paste)

The customer NEVER:

- ❌ enters a bot token
- ❌ copies/pastes a token
- ❌ visits BotFather
- ❌ configures a webhook
- ❌ chooses a Business id, a connection id, or any infrastructure

The ONE thing the customer does is confirm the bot's creation **inside
Telegram's own UI** — Telegram requires the bot's owner to approve
creation, and that approval cannot be performed by FlowPilot.

```
FlowPilot /settings/telegram
   → «اربط تيليجرام»
   → FlowPilot mints a single-use startToken + persists the provisioning
     ledger row (businessId = the ONLY authority)
   → the Admin is redirected to https://t.me/<manager>?start=<token>
       (the deep link carries ONLY the opaque token — no business id,
        no connection id, no secret)
   → the Admin STARTs the Manager Bot → FlowPilot binds the Telegram
     user.id to the ledger row and replies with the
     KeyboardButtonRequestManagedBot keyboard
   → the Admin taps the button + confirms in Telegram's native creation UI
   → Telegram delivers the managed_bot event to the MANAGER bot
   → FlowPilot completes provisioning server-side:
       getManagedBotToken (via the manager bot; request field `user_id`
         = the managed bot's own Telegram User.id; the API returns the
         token as a BARE STRING — DECISIONS #70)
       → token stored ONLY as an opaque fp:<id> RUNTIME reference
       → setWebhook with a fresh per-connection secret
       → getMe identity check (the reported bot id MUST match the event's)
       → the ledger is consumed exactly once
       → the connection is written CONNECTED
       → markOnboardingReady
   → the settings UI's poll observes the transition → CONNECTED
```

## 2. The customer-facing UI states (`/settings/telegram`)

Admin-only (`requireRole("ADMIN")`; STAFF is redirected). The Business is
always server-derived from the authenticated session. The screen renders
ONE server-derived state machine — the browser never interprets provider
state, never assumes completion, and stops polling once a terminal state
is reached.

| Approved state                | Implemented as                   | What the customer sees + the action                                                                             |
| ----------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **EMPTY**                     | `EMPTY`                          | A clear explanation + ONE primary action: «اربط تيليجرام».                                                      |
| **PENDING**                   | `PROVISIONING` + the open action | The session exists server-side; the redirect/open action stays available («افتح رابط تيليجرام»).                |
| **PROVISIONING**              | `PROVISIONING` (polling)         | Honest progress: "في انتظار تأكيدك داخل تيليجرام" + a live poll every 4s. No fake success.                      |
| **CONNECTED**                 | `CONNECTED`                      | The bot's display name + @username + status + «فصل تيليجرام».                                                   |
| **ACTION_REQUIRED / FAILED**  | `ACTION_REQUIRED`                | A concise safe Arabic reason (typed outcome → label) + «أعد المحاولة». Never a credential, never provider text. |
| _(retained)_ **DISCONNECTED** | `DISCONNECTED`                   | A previously connected bot the Admin disconnected + «أعد ربط تيليجرام» (reconnect re-provisions the same row).  |

`DISCONNECTED` is retained deliberately (DECISIONS #66): it is the honest
home for a disconnected bot and the reconnect entry point; removing it
would break the verified disconnect/reconnect lifecycle.

**Resolution order (the honest precedence):** a CONNECTED+active
connection wins → an in-flight attempt (PROVISIONING, even over a stale
DISCONNECTED row) → a DISCONNECTED connection → a terminated/abandoned
attempt (ACTION_REQUIRED) → nothing (EMPTY). No state can render a
permanent spinner: every failure terminates the attempt with a typed
outcome on the ledger.

**Polling contract:** the poll calls the server-derived status action
only, stops the moment the state leaves `PROVISIONING`, and is bounded by
a safety max (well beyond the attempt's 15-minute expiry, after which the
state legitimately becomes `ACTION_REQUIRED`).

## 3. Architecture seams (where Telegram code may live)

All Telegram protocol logic is quarantined; the engine holds zero channel
logic (verified by grep + guards in every slice).

```
src/server/integrations/telegram/
  telegram-client.ts              ONE HTTP boundary (Bot API URL + token in path)
  telegram-webhook.ts             Update parser → NormalizedInboundTransportMessage
  telegram-transport.ts           sendMessage → MessageTransport
  telegram-verify.ts              getMe → ConnectionVerifier
  telegram-webhook-handler.ts     POST /api/telegram/webhook (per-connection)
  telegram-provisioning.ts        the managed_bot event boundary + disconnect
  telegram-manager-webhook-handler.ts  POST /api/telegram/manager/webhook
src/server/repositories/
  telegram-connection.repository.ts          (the ONLY Prisma consumer for connections)
  telegram-provisioning-ledger.repository.ts (the ONLY Prisma consumer for the ledger)
src/features/telegram-connection/
  server/telegram-connection-service.ts      the settings service (status/launch/disconnect)
  components/telegram-connection-screen.tsx  the ONE UI state machine screen
  actions/telegram-connection-actions.ts     server actions (ADMIN-only, server-derived tenant)
  types.ts                                   the secret-free view + result types
src/app/(app)/settings/telegram/page.tsx     the route (thin composition)
src/app/api/telegram/{,manager/}webhook/route.ts  the two webhook routes
```

Two additive tables (migration
`20260926120000_telegram_connection` + the outcome-column migration
`20260927120000_telegram_provisioning_outcome`): `telegram_connections`
(transport sibling of `whatsapp_connections`; `botExternalId`
authoritative; `credentialsRef` = an opaque `fp:<id>` reference, never the
raw token; `webhookSecretHash` = a non-secret SHA-256 routing index) and
`telegram_provisioning_ledgers` (the single-use ledger whose `startToken`
is the only deep-link payload).

## 4. Security model

- **Single-use, opaque start tokens.** The deep link carries ONLY the
  token; the Business comes ONLY from the ledger row.
- **Creator binding.** The `managed_bot` creator `user.id` must equal the
  ledger's bound creator. A forged callback that never went through the
  deep link matches nothing and provisions nothing. A token already bound
  to one account is never re-bound to another.
- **One bot / one Business.** A managed bot already owned by another
  Business is refused; a same-Business DISCONNECTED row is the reconnect
  path (re-provisioned in place with a FRESH secret + a NEW `fp:<id>`).
- **The bot token never crosses.** It is stored ONLY as an `fp:<id>`
  RUNTIME reference; the plaintext lives in the adapter + the encrypted
  runtime credential store. It never appears in a response, a log, a DB
  projection, the UI, or a domain payload.
- **Server-authoritative tenancy.** No client input ever selects a
  Business, a branch, or a connection. UI visibility is not authorization.
- **Webhook authenticity.** `X-Telegram-Bot-Api-Secret-Token` is verified
  with a constant-time comparison over fixed-length SHA-256 digests, 401
  BEFORE any parsing. The per-connection plaintext is handed to Telegram
  once and never persisted. The MANAGER bot's secret is DERIVED from the
  manager token with a fixed-label HMAC (no extra config, rotates with the
  token).
- **No half-provisioned connections.** The provider calls run BEFORE the
  single-use consume, so a failure leaves no connection row and a
  retryable attempt.

## 5. Operator one-time setup

1. Create the **FlowPilot Manager Bot** via [@BotFather](https://t.me/BotFather).
2. In BotFather, open the bot → **Bot Management Mode** → enable it. This
   is what authorizes `getManagedBotToken` / `replaceManagedBotToken`.
3. Set the server-side env:
   - `TELEGRAM_MANAGER_BOT_TOKEN` — the manager bot's token (SECRET;
     never `NEXT_PUBLIC_`, never the DB, never a log).
   - `TELEGRAM_MANAGER_BOT_USERNAME` — the manager bot's PUBLIC @username
     (non-secret; used to build the customer deep link).
4. `CREDENTIAL_MASTER_KEY` must be generated + set in the deployment env —
   the managed bot token is stored as an encrypted `fp:<id>` RUNTIME
   reference, so without it provisioning terminates honestly at
   `CREDENTIAL_STORE_UNAVAILABLE`.
5. Apply the migrations: `pnpm db:deploy` (the chain includes both
   Telegram migrations — additive, zero ALTERs on existing tables).

No webhook configuration is ever manual: the first «اربط تيليجرام» calls
`ensureManagerWebhook`, which points the manager bot at
`<NEXT_PUBLIC_APP_URL>/api/telegram/manager/webhook` with the derived
secret.

## 6. The ONE live E2E (operator, after release)

This is the single real verification that remains. **Do not fabricate a
result** — the offline harnesses prove the code paths; only a real
BotFather manager bot proves the integration.

**Preconditions:** the one-time setup above is complete; the deployment is
reachable at a public origin (Telegram must deliver webhooks);
`NEXT_PUBLIC_APP_URL` matches that origin.

**Steps:**

1. Sign in as a Business **ADMIN** and open **Settings → Telegram**
   (`/settings/telegram`). Confirm the **EMPTY** state + the single
   «اربط تيليجرام» action.
2. Tap **«اربط تيليجرام»**. Confirm the browser opens
   `https://t.me/<manager>?start=<token>` — the Manager Bot chat.
3. Tap **START**, then EITHER tap the official creation link the manager
   bot replies with (**«إنشاء بوت المنشأة على تيليجرام»**, the reliable
   path on every client) OR tap the **«إنشاء بوت المنشأة على تيليجرام»**
   reply-keyboard button if your client launches it, and confirm inside
   Telegram's native creation UI.
4. Watch the settings surface: it must leave the honest progress state and
   reach **CONNECTED** (display name + @username) on its own — the poll
   observing the server-side transition. If the tab was closed, reopening
   `/settings/telegram` shows the same terminal state.
5. Send ONE real message to the newly created bot from a private Telegram
   account and confirm the FlowPilot assistant replies (the transport +
   engine path, DECISIONS #65).
6. In `/settings/telegram`, tap **«فصل تيليجرام»** and confirm the state
   becomes **DISCONNECTED**, then «أعد ربط تيليجرام» returns it to
   **CONNECTED**.

**What must NOT happen at any step:** the customer is asked for a token,
a BotFather visit, a webhook setting, or any technical identifier; a
permanent spinner; a credential in the UI; a bot attaching to the wrong
Business.

**Record the result** in `BUILD_STATE.md` + a new `DECISIONS.md` entry if
the live run surfaces a defect or a decision (e.g. the open non-text
decision #63 (F)(1)).

### 6.1 The first real attempt — what it proved (DECISIONS #68)

The first real pass ran against the deployed **v0.31.0** + the real Telegram
Bot API. It did NOT complete the journey, and the reason is recorded exactly
here so the next pass starts from a known boundary.

**LIVE-VERIFIED:**

- **Production lineage** — `GET /api/health` → `version:"0.31.0"`,
  `deploymentReady:true`, `database:"connected"`, `missingEnvVars:[]`.
- **The real Manager Bot** — a REAL `getMe` (no token ever printed, logged,
  or returned): **200**, id **8603565570**, `is_bot:true`, first name
  «FlowPilot Manager», username **`@FlowPilotManagerBot`**, and
  **`can_manage_bots: true`** — the required managed-bot capability IS
  present, so `getManagedBotToken` is authorizable. **Do NOT recreate or
  replace this bot.**
- **No webhook is installed on the Manager Bot** (`getWebhookInfo` → empty
  url, `pending_update_count: 0`) — expected, because
  `ensureManagerWebhook` self-wires it at the FIRST provisioning launch, and
  no launch has ever run.

**LIVE-PROVED BLOCKING DEFECT (found + fixed + guarded, NOT yet deployed):**
both Telegram webhook routes were session-gated by the route proxy
(`src/proxy.ts`), so every real Telegram delivery — the `/start` binding,
the `managed_bot` completion, every customer message — answered
**HTTP 307 → `/sign-in?redirect=…`** and never reached the handler.
Reproduced live against production; `setWebhook` would have returned success
while every delivery silently failed. No offline harness can see this: the
harnesses invoke the handler directly, bypassing the proxy. Fixed by adding
`/api/telegram` to the public-path prefixes (`src/lib/public-paths.ts`) —
**not a security widening**: the request credential is Telegram's own
`X-Telegram-Bot-Api-Secret-Token`, verified constant-time with **401 before
any parsing**. Proven locally: the manager webhook now returns **401**, and
`/settings/telegram` still redirects anonymous users. Guarded by
`check:telegram` section P (fails without the fix) + `check:signup`.

**The exact remaining boundary — 4 operator actions, none of them code:**

| #   | Action                                                                                                 | Live evidence it is still open                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Deploy the current head (`pnpm deploy`)                                                                | production still answers **307** on `POST /api/telegram/manager/webhook` (reproducible now)                                                                              |
| 2   | `pnpm db:deploy`                                                                                       | `prisma migrate status`: both Telegram migrations **UNAPPLIED**; a live `POST /api/telegram/webhook` raised `P2021 The table public.telegram_connections does not exist` |
| 3   | Add `TELEGRAM_MANAGER_BOT_USERNAME` to the production env (presence-only check — currently **ABSENT**) | `beginTelegramProvisioning` refuses with «بوت الإدارة غير مُهيأ بعد — سيقوم المشغّل بإعداده» before minting a deep link                                                  |
| 4   | Perform the 6 steps above in Telegram                                                                  | the `/start` tap + the native creation confirmation + the first customer message are Telegram-hosted **human** actions                                                   |

**Explicitly NOT claimed by that pass:** no real managed bot was created,
no `setWebhook`/`getMe` ran for a managed bot, no connection reached
CONNECTED, and no customer message was received or answered. Those remain
**LIVE E2E PENDING**.

### 6.2 The second real attempt — what it proved (DECISIONS #69)

The second real pass ran against the deployed **v0.31.2** (which already
carries the #68 routing fix + both applied migrations + the now-present
`TELEGRAM_MANAGER_BOT_USERNAME`). It got ONE stage further and then hit a
second, completely different blocking defect.

**LIVE-VERIFIED (real production, real Bot API):**

- **All four #68 operator blockers are RESOLVED** — `GET /api/health` →
  `version:"0.31.2"`, `deploymentReady:true`, `database:"connected"`,
  `missingEnvVars:[]`; `prisma migrate status` → "Database schema is up to
  date!" (all 15 migrations applied, live-confirmed by a direct
  production-DB read of both Telegram tables + the `outcome_code` column);
  production env PRESENCE (no value read): `TELEGRAM_MANAGER_BOT_TOKEN` ✓,
  `TELEGRAM_MANAGER_BOT_USERNAME` ✓, `CREDENTIAL_MASTER_KEY` ✓,
  `NEXT_PUBLIC_APP_URL` ✓.
- **The #68 fix IS live** — both webhook endpoints return **401
  UNAUTHENTICATED** (missing secret → «سر الويبهوك مفقود»; invalid secret →
  «سر الويبهوك غير صالح»), with **no 307 and no `/sign-in` redirect**, while
  `/settings/telegram` stays 307-protected.
- **The whole server-side launch + binding chain ran for REAL:** «اربط
  تيليجرام» persisted the single-use ledger row (Business server-derived,
  deep link token-only) → `ensureManagerWebhook` installed the Manager Bot's
  webhook at the production URL (`getWebhookInfo` →
  `url:"https://flowpilot-prod.vercel.app/api/telegram/manager/webhook"`,
  `allowed_updates:["message","managed_bot"]`, `pending_update_count:0`,
  `last_error:null`) → the deep link opened @FlowPilotManagerBot → the real
  `/start <token>` WAS DELIVERED (visible as `POST
/api/telegram/manager/webhook` in production logs) → `bindCreator` bound
  the real Telegram `user.id` to the ledger row (verified in the production
  DB) → the settings surface's bounded poll observed the honest PROVISIONING
  state.
- **The honest failure path is correct live** — the first attempt's
  15-minute window elapsed with no `managed_bot` event and the UI correctly
  surfaced **ACTION_REQUIRED** + a retryable «أعد المحاولة»; the retry then
  minted a FRESH single-use token + re-bound on the real `/start` (the
  typed-failure loop #66/#67 designed, observed live).

**LIVE-PROVED SECOND BLOCKING DEFECT (found + fixed + guarded, NOT yet
deployed):** the manager bot's reply **never reached the Admin**. The
ledger binding had succeeded, but Telegram never delivered the welcome
message or the creation keyboard, so the Admin stared at a bot that said
nothing and the `managed_bot` event could never be produced.

**Root cause, reproduced exactly against the real Bot API:** the
`KeyboardButtonRequestManagedBot` was sent with `request_managed_bot: {}`,
and Telegram rejects that wire shape — `POST …/sendMessage` → **`400 Bad
Request: can't parse KeyboardButton: Can't find field "request_id"`**. The
Bot API's `KeyboardButtonRequestManagedBot` type REQUIRES `request_id` (a
signed 32-bit identifier unique within the message); the empty object is
invalid, so every `/start` reply failed as a PERMANENT transport failure and
the keyboard silently never appeared.

**Why no offline harness could see it:** the harnesses assert the button's
EXISTENCE and the closed payload surface (no token, no technical identifier)
— exactly the right security properties — but their FAKE Telegram API
accepts whatever object is sent. A schema-required field the real provider
mandates is structurally invisible offline. This is the second consecutive
live attempt to surface a distinct defect every offline guard was green for
(after #68's route-proxy 307), which is precisely why the live run must
never be skipped or simulated.

**Fix (smallest isolated change, no re-architecture):**
`buildManagedBotKeyboard()` now sends `request_managed_bot: { request_id:
MANAGED_BOT_REQUEST_ID }` (a NEW exported constant = `1`). A FIXED value is
correct and safest: the keyboard is the ONLY button in the ONLY message this
endpoint sends per attempt, so uniqueness-within-the-message is trivially
satisfied, and a constant (rather than a random per-send value) keeps a
legitimate replay of the SAME attempt coherent across an app restart or a
redeploy. It carries NO security meaning — it is a provider correlation
key, not a FlowPilot secret (the auth is the ledger's single-use
`startToken` + the creator binding). The deliberate non-prefill decision is
UNCHANGED: `suggested_name`/`suggested_username` are still NOT sent
(unverifiable API fields); the Arabic suggestion still rides in the reply
text.

**Guarded on three regression surfaces:** `check:telegram` **100/100** (L4
now asserts the numeric `request_id`; NEW **L4b** asserts the wire shape
directly — `typeof request_id === "number" && finite && integer`, so the
class of defect is now caught offline); `check:telegram-onboarding` 22/22
(check 7); `check:signup` 18/18. `pnpm verify` + `pnpm security` +
`git diff --check` green. WhatsApp / AI / the Meta Embedded Signup HOLD all
untouched.

**The exact remaining boundary — ONE operator action:**

| #   | Action                                            | Live evidence it is still open                                                                                                                               |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Deploy the current head (`pnpm deploy`)           | the deployed v0.31.2 still sends `request_managed_bot: {}` → the real Bot API still rejects the creation keyboard with `400 … Can't find field "request_id"` |
| 2   | Re-run the ONE live E2E above from a FRESH launch | the `/start` tap + the native creation confirmation + the first customer message are Telegram-hosted **human** actions                                       |

Everything else #68 required is already live-verified RESOLVED (the routing
fix, the migrations, `TELEGRAM_MANAGER_BOT_USERNAME`).

### 6.3 The `getManagedBotToken` wire shape (DECISIONS #70)

Two code-proven wire-shape defects on the managed-bot completion path (the
step that runs AFTER a real `managed_bot` event) were corrected against the
authoritative Telegram Bot API. They are DOWNSTREAM of the `managed_bot`
event, so they are unrelated to the #69 creation-keyboard symptom and did
NOT touch the managed-bot creation UX (that boundary is still externally
unresolved — §6.2).

- **G-1 (request param):** `getManagedBotToken` now sends `user_id` (the
  managed bot's own Telegram `User.id`, carried on the event as `bot.id` →
  `botExternalId`), NOT the previous `managed_bot_id`.
- **G-2 (response shape):** the API returns the managed bot token as a
  **bare string**, not a `{ token }` object. `telegramGetManagedBotToken`
  now validates that the result is a non-empty string (any other shape →
  `MALFORMED_PROVIDER_PAYLOAD` → the typed `PROVISIONING_FAILED` outcome, no
  half-provisioned connection) and hands the bare string to `setWebhook`.

The credential model is unchanged: the token is server-side only, stored
ONLY as an `fp:<id>` RUNTIME reference, and never logged, returned, or
placed in an error message. Guarded by NEW `check:telegram` section Q
(Q1–Q7): `user_id` is sent, `managed_bot_id` is not, a bare-string response
advances to CONNECTED, `setWebhook` receives the actual token, an
object/empty response fails safely, and the token never crosses an outward
boundary. `check:telegram` **107/107**. NOT deployed.

**Explicitly NOT claimed by that pass:** no real managed bot was created,
no `setWebhook`/`getMe` ran for a managed bot, no connection reached
CONNECTED, and no customer message was received or answered. Those remain
**LIVE E2E PENDING**.

### 6.4 The official creation deep-link fallback (DECISIONS #71)

After v0.31.4 deployed (the #69 `request_id` fix + #70 G-1/G-2 are live —
`GET /api/health` → `version:"0.31.4"`), a THIRD live symptom appeared,
downstream of #69: the creation keyboard now appears (Telegram accepts the
button), but on the reported **Android** client tapping «Create the bot»
opens nothing.

**Root cause (official docs, verified):** the Bot API's
`KeyboardButtonRequestManagedBot` / `request_managed_bot` are real and
FlowPilot sends them correctly (`request_id` present). But the docs state
that pressing the button "will ask the user to create and share a bot" —
i.e. **launching the native creation UI is a Telegram CLIENT
responsibility, not a Bot API payload**. A client without the very-new
`request_managed_bot` handler renders the button but never opens the
creation window, so no `managed_bot` event is ever produced. This is a
CLIENT-SIDE limitation; a server-side FlowPilot change cannot add a
handler to the customer's Telegram app. It is NOT a FlowPilot server
defect, NOT a Telegram rejection, and NOT evidence that "Android is
buggy".

**The fallback — an official, documented alternative.** Telegram Bot
Features → Managed Bots → "Sharing Your Management Bot" documents the deep
link:

```
https://t.me/newbot/{manager_bot_username}/{new_username}?name={new_name}
```

Opening it shows the NATIVE bot-creation window with the @username +
display name pre-filled (editable), and on confirmation "Your @ManagerBot
receives a `managed_bot` update" — the SAME event the keyboard button
produces. It is resolved by the client's universally-supported deep-link
handler (the same mechanism as the existing `?start=` link), so it does
NOT depend on the newest reply-keyboard rendering path.

**What changed (smallest, additive, keyboard KEPT):** the Manager Bot's
`/start` reply now LEADS with this official link (built by
`buildManagedBotCreationLink()` — strips a leading `@`, percent-encodes the
display name) when `TELEGRAM_MANAGER_BOT_USERNAME` is set, and STILL
attaches the `request_managed_bot` reply keyboard unchanged. Graceful
degradation: clients that launch the native UI from the keyboard keep
working; every other client uses the link. Both routes end in the same
`managed_bot` event, so there is NO second provisioning lifecycle.

**Security / creator-tenant binding — preserved with NO new rule.** The
`newbot` link carries no FlowPilot state parameter, but it is only ever
shown as the reply to a valid `/start <token>`, which already bound the
Admin's Telegram `user.id` to the single-use ledger row. The resulting
`managed_bot` event's creator `user.id` resolves the attempt through
`findActiveByCreator`, and the Business still comes ONLY from the ledger
row — the same binding as the keyboard path. Tenant isolation, single-use
provisioning, replay resistance, no token visibility, no BotFather visit,
and no manual token entry are all intact.

**Guarded:** `check:telegram` **109/109** (NEW L4c — the `/start` reply
carries the official `t.me/newbot/…?name=…` link AND the keyboard AND
leaks no token/business id/start token; NEW L4d — link escaping),
`check:telegram-onboarding` 22/22, `check:signup` 18/18.

**Still LIVE-ONLY (not fabricated):** OFFLINE VERIFIED — the link is
constructed, escaped, and sent correctly with the keyboard preserved and
the binding/tenant invariants intact. NOT LIVE VERIFIED — that tapping the
official link on the real Android client opens the native creation window,
yields a `managed_bot` event, reaches CONNECTED, and answers a real
customer message. Operator action: deploy the current head, then re-run
§6 "The ONE live E2E" from a FRESH launch using the official-link path on
the Android client.

## 7. Offline verification (the code paths, no network)

- `pnpm check:telegram` — **109/109**: the identity seam, Update parsing,
  webhook secrets, the outbound transport, the provisioning ledger
  invariants, engine reuse, the per-connection webhook route, the launch,
  single-use consumption, the UI state machine, the whole manager-webhook
  lifecycle, typed failures, disconnect/reconnect, and every rejection
  boundary + provider failure + the CONNECTED transition guard. **Section P
  (DECISIONS #68) guards the first live-found defect: both webhook routes
  must stay reachable through the route proxy's public-path policy — it
  fails loudly if a session gate is ever re-applied. Section L4b
  (DECISIONS #69) guards the second live-found defect: the
  `request_managed_bot` button MUST carry a numeric `request_id` (the real
  Bot API rejects the empty object with `400 Can't parse KeyboardButton`).
  Section Q (DECISIONS #70) guards the two code-proven `getManagedBotToken`
  wire-shape defects: the request sends `user_id` (never `managed_bot_id`)
  and the token response is parsed as a bare string (a `{ token }` object
  or an empty/non-string value fails safely). Sections L4c/L4d
  (DECISIONS #71) guard the official creation deep-link fallback: the
  `/start` reply carries the `t.me/newbot/…?name=…` link AND still the
  keyboard AND leaks no token/business id/start token, and the link
  escaping strips `@` + percent-encodes the display name.**
- `pnpm check:telegram-onboarding` — **22/22** (DECISIONS #67): the
  customer journey through the REAL service + REAL manager handler —
  EMPTY → launch → the deep link (token-only) → the poll observing
  PROVISIONING → `/start` binding + the keyboard → the `managed_bot`
  completion → the poll observing CONNECTED (display name + @username, no
  secret) → single-use replay refusal → the typed-failure loop
  (ACTION_REQUIRED + a retryable label + a fresh attempt) → the
  authorization boundaries.
- `pnpm check:signup` — **18/18**: the public-path policy, now including
  the provider-webhook reachability assertions (DECISIONS #68).

WhatsApp regression guards stay green (`whatsapp-inbound` 13/13,
`whatsapp-transport` 27/27, `meta-whatsapp` 17/17,
`whatsapp-onboarding` 56/56, `credentials-runtime` 36/36,
`meta-embedded-signup` 27/27 — all re-run after the #68 fix).

**Why the offline harnesses could not catch the #68 defect:** they invoke
the handler functions directly with injected deps (that is precisely what
makes the security path assertable offline), so the route proxy — which
runs BEFORE the route handler — is never traversed. The 307 was invisible
to every offline check and only a real HTTP delivery could surface it. The
NEW section P asserts the routing policy directly, so the class of defect
is now caught offline.

## 8. Boundaries + holds (do NOT silently reopen)

- **Meta WhatsApp Embedded Signup remains DEFERRED / HOLD**
  (`INTEGRATION_CHECKPOINTS.md`). Telegram has NO dependency on it; adding
  Telegram must not reopen the Meta authorization surface.
- **Live E2E against a real BotFather manager bot has not been run.** The
  whole customer-facing path is offline-proven only. Two consecutive real
  passes each proved one blocking defect and got one stage further: #68
  live-verified the Manager Bot + live-proved the route-proxy 307; #69
  live-verified that fix deployed + the whole launch/bind chain running
  for real + live-proved the rejected creation keyboard (`request_id`).
  **ONE operator action stands open (§6.2): deploy the current head →
  re-run the ONE live E2E from a fresh launch.** See the checkpoint entry
  in `docs/INTEGRATION_CHECKPOINTS.md`.
- **Open decision #63 (F)(1):** non-text inbound (media) routing — drop
  vs persist-and-defer. The MVP scope (private chats, text) acknowledges
  non-text 200 and does not process it. Do not guess this; it is a flagged
  candidate decision.
- **Deferred:** owner-change / `ManagedBotUpdated` handling, token
  rotation, groups/channels, and any multi-connection UI. One bot per
  Business is the approved pilot model. **Inspected in DECISIONS #68 and
  confirmed deliberately deferred, NOT a silent defect:** no
  `managed_bot_updated` subscription (`ensureManagerWebhook` requests only
  `["message","managed_bot"]`), no `replaceManagedBotToken` call, and no
  owner-change handler exists; an unknown update shape is acknowledged 200
  and ignored with no state change, and an already-CONNECTED re-delivery
  terminates with the typed `BOT_ALREADY_PROVISIONED`. The schema already
  persists `managerBotId` + `creatorTelegramUserId` provenance, so the
  lifecycle is structurally ready — it needs its own slice (the smallest
  shape would be: subscribe to the owner-change update, verify the creator
  still matches, and rotate the `fp:<id>` reference via
  `replaceManagedBotToken`). Do not invent a second lifecycle here.
