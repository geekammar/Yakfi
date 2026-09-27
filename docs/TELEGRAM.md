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
       getManagedBotToken (via the manager bot)
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
3. Tap **START**, then tap the **«إنشاء بوت المنشأة على تيليجرام»** button
   the manager bot replies with, and confirm inside Telegram's native
   creation UI.
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

## 7. Offline verification (the code paths, no network)

- `pnpm check:telegram` — **96/96**: the identity seam, Update parsing,
  webhook secrets, the outbound transport, the provisioning ledger
  invariants, engine reuse, the per-connection webhook route, the launch,
  single-use consumption, the UI state machine, the whole manager-webhook
  lifecycle, typed failures, disconnect/reconnect, and every rejection
  boundary + provider failure + the CONNECTED transition guard.
- `pnpm check:telegram-onboarding` — **22/22** (DECISIONS #67): the
  customer journey through the REAL service + REAL manager handler —
  EMPTY → launch → the deep link (token-only) → the poll observing
  PROVISIONING → `/start` binding + the keyboard → the `managed_bot`
  completion → the poll observing CONNECTED (display name + @username, no
  secret) → single-use replay refusal → the typed-failure loop
  (ACTION_REQUIRED + a retryable label + a fresh attempt) → the
  authorization boundaries.

WhatsApp regression guards stay green (`whatsapp-inbound` 13/13,
`whatsapp-transport` 27/27, `meta-whatsapp` 17/17,
`whatsapp-onboarding` 56/56, `credentials-runtime` 36/36).

## 8. Boundaries + holds (do NOT silently reopen)

- **Meta WhatsApp Embedded Signup remains DEFERRED / HOLD**
  (`INTEGRATION_CHECKPOINTS.md`). Telegram has NO dependency on it; adding
  Telegram must not reopen the Meta authorization surface.
- **Live E2E against a real BotFather manager bot has not been run.** The
  whole customer-facing path is offline-proven only. See the checkpoint
  entry in `INTEGRATION_CHECKPOINTS.md`.
- **Open decision #63 (F)(1):** non-text inbound (media) routing — drop
  vs persist-and-defer. The MVP scope (private chats, text) acknowledges
  non-text 200 and does not process it. Do not guess this; it is a flagged
  candidate decision.
- **Deferred:** owner-change / `ManagedBotUpdated` handling, token
  rotation, groups/channels, and any multi-connection UI. One bot per
  Business is the approved pilot model.
