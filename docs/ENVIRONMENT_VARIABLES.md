# FlowPilot — Environment Variables Reference

> Every variable FlowPilot needs, where it lives, and how it is validated.
> Env files are gitignored; real credentials live only in `.env.local` (dev),
> the Vercel project settings (deploys), and the Neon console.

## The Four Required Variables

| Variable              | Scope           | Example                                                    | Used by                                                  |
| --------------------- | --------------- | ---------------------------------------------------------- | -------------------------------------------------------- |
| `DATABASE_URL`        | server          | `postgresql://user:pass@ep-x.neon.tech/db?sslmode=require` | Prisma (`@prisma/adapter-pg`), migrations, seed          |
| `BETTER_AUTH_SECRET`  | server          | 64-char random base64 string                               | Better Auth session/cookie signing                       |
| `BETTER_AUTH_URL`     | server          | `https://flowpilot-demo.vercel.app`                        | Better Auth `baseURL` (redirects, callback URLs)         |
| `NEXT_PUBLIC_APP_URL` | server + client | `https://flowpilot-demo.vercel.app`                        | Root layout `metadataBase`, Better Auth `trustedOrigins` |

There is one optional variable (PROMPT-19):

| Variable                | Scope  | Example                | Used by                                                                   |
| ----------------------- | ------ | ---------------------- | ------------------------------------------------------------------------- |
| `INBOUND_WEBHOOK_TOKEN` | server | 32+ char random string | `POST /api/conversations/inbound` gate — unset ⇒ inbound webhook disabled |

While `INBOUND_WEBHOOK_TOKEN` is unset, the provider-neutral inbound
webhook answers 503 and no external message can enter the system
(DECISIONS #29). The four variables above remain required everywhere.

## Validation

Two layers catch problems early:

1. **At deploy time** — `pnpm vercel:check` (`scripts/vercel-check.mjs`):
   presence, placeholder detection, URL schemes, secret length, origin
   consistency. Run by every `pnpm deploy:*` command as its first gate.
2. **At app boot / build** — `src/lib/env.ts` (Zod, fail-fast). On Vercel the
   build itself fails with a readable Arabic error listing the offending
   variable — so configure variables **before** the first deploy.

Placeholder detection includes `replace-with`, `your-`, `user:password@`,
and similar markers, in both layers.

## Where Values Live

| Environment             | File / Place                               | Precedence                            |
| ----------------------- | ------------------------------------------ | ------------------------------------- |
| Local development       | `.env.local` (preferred) or `.env`         | real env vars > `.env.local` > `.env` |
| Vercel builds + runtime | Project → Settings → Environment Variables | set for **Production and Preview**    |
| Prisma CLI / seed       | same files via `prisma.config.ts`          | same precedence as dev server         |

## Generation Recipes

```bash
# BETTER_AUTH_SECRET (use ONE value everywhere):
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64'))"

# DATABASE_URL: Neon console → your project → Connect → connection string
# (keep ?sslmode=require; use the pooled connection string for serverless if
#  Neon offers one for your plan)
```

## Local Development Setup

```bash
pnpm run setup      # creates .env.local from .env.example with a real random secret
# then edit .env.local and set DATABASE_URL (+ URLs for remote testing)
pnpm vercel:check   # validate exactly what the deploy gate validates
```

Local URLs are fine for development: `BETTER_AUTH_URL=http://localhost:3000`
and `NEXT_PUBLIC_APP_URL=http://localhost:3000`.

## Vercel Production Values

| Variable              | Value                                           |
| --------------------- | ----------------------------------------------- |
| `DATABASE_URL`        | your Neon string with `?sslmode=require`        |
| `BETTER_AUTH_SECRET`  | the same secret you use locally (≥ 32 chars)    |
| `BETTER_AUTH_URL`     | `https://<project-name>.vercel.app` (or domain) |
| `NEXT_PUBLIC_APP_URL` | same as `BETTER_AUTH_URL`                       |

Notes:

- `NEXT_PUBLIC_APP_URL` is inlined at **build time** — changing it requires a
  redeploy, not just a restart.
- Keep Production and Preview values identical except when deliberately
  testing a different database on previews.
- Never commit any env file (`.gitignore` + pre-commit hook + `pnpm security`
  all enforce this). If a secret leaks: rotate first (`docs/TROUBLESHOOTING.md`).

## Optional Variables

| Variable                                  | Default | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEMO_MODE`                               | unset   | `"true"` → the dev launcher scripts (`scripts/dev.sh` / `dev.ps1` / `dev-termux.sh`) **and** the deploy gate (`scripts/pre-deploy.mjs`, run by every `pnpm deploy:*` command) re-seed the Arabic demo business first — deployed demos never show empty dashboards. Idempotent, demo-business-scoped wipe; requires a real `DATABASE_URL`. Never used by production builds.                                                                         |
| `OPENROUTER_API_KEY`                      | unset   | AI provider secret (PROMPT-OPS-05) — the OpenRouter API key, environment-backed. NEVER in the DB/UI/logs: the platform AI policy stores only this NAME as the secret reference. Local: `.env.local`; production: Vercel Environment Variables (a key change requires redeploy). Optional until the provider-integration phase.                                                                                                                     |
| `AGENTROUTER_API_KEY`                     | unset   | AI provider secret (PROMPT-OPS-05) — the AgentRouter API key. Same rules as `OPENROUTER_API_KEY`.                                                                                                                                                                                                                                                                                                                                                  |
| `ATRIA_API_KEY`                           | unset   | AI provider secret (PROMPT-OPS-05) — the Atria API key. Same rules as `OPENROUTER_API_KEY`. Resolved only when the platform AI policy selects `atria` as primary/secondary.                                                                                                                                                                                                                                                                        |
| `WHATSAPP_META_VERIFY_TOKEN`              | unset   | Meta webhook verify token (`hub.verify_token` for `GET /api/whatsapp/meta`). Server-side only; compared constant-time. Optional until a Business connects a real number — `GET` verification returns 403 while unset.                                                                                                                                                                                                                              |
| `WHATSAPP_META_APP_SECRET`                | unset   | Meta App Secret — server-side only, used for BOTH `X-Hub-Signature-256` HMAC validation on `POST /api/whatsapp/meta` AND the future Embedded Signup server-side code exchange (OAuth `client_secret`). NEVER in the DB/UI/logs; only its env-var NAME is ever reported. Optional until Embedded Signup — while unset, signature check is skipped in local/dev (tenancy + idempotency still protect Core); MUST be set in production.               |
| `WHATSAPP_META_APP_ID`                    | unset   | Meta App ID — the non-secret identifier of the Meta App (Embedded Signup `app_id` / JS SDK `appId`). Server-side only. PREREQUISITE for the real Meta Embedded Signup adapter; optional at boot and no code path requires it to start. No default is supplied and no value is ever invented — the operator sets it from the Meta App Dashboard. Readiness is checkable via `describeMetaOnboardingReadiness()`.                                    |
| `WHATSAPP_META_EMBEDDED_SIGNUP_CONFIG_ID` | unset   | Meta Embedded Signup **`config_id`** — non-secret server-side CONFIGURATION METADATA identifying the Embedded Signup configuration created in the Meta App Dashboard (the configuration the OAuth dialog / JS SDK launches against). PREREQUISITE for the real adapter alongside `WHATSAPP_META_APP_ID`; optional at boot. While unset, the adapter seam falls back to the deterministic stand-in and never invents a value. Never `NEXT_PUBLIC_`. |
| `WHATSAPP_META_ACCESS_TOKEN`              | unset   | System/fallback WhatsApp access token (`Bearer` for `graph.facebook.com`). Server-side only; resolved via `WhatsAppConnection.credentialsRef` (env-var NAME) per-connection when set, else this fallback. Optional until send.                                                                                                                                                                                                                     |
| `WHATSAPP_META_PHONE_NUMBER_ID`           | unset   | Fallback Meta `phone_number_id` for outbound send URL (`/{version}/{phone_number_id}/messages`). Server-side. Optional — per-connection `WhatsAppConnection.externalId` is preferred when present.                                                                                                                                                                                                                                                 |
| `WHATSAPP_META_API_VERSION`               | `v21.0` | Graph API version (e.g. `v21.0`) — `https://graph.facebook.com/{version}/{phone_number_id}/messages`. Optional; `v21.0` when unset.                                                                                                                                                                                                                                                                                                                |
| `CREDENTIAL_MASTER_KEY`                   | unset   | **RUNTIME credential store** master encryption key (DECISIONS #49) — 32 random bytes as hex (64 chars) or base64 (44 chars). Optional: while unset the store stays UNAVAILABLE (every `fp:<id>` store/resolve fails closed) and the existing ENV grammar is unaffected. Server-side only; NEVER in the DB/UI/logs and never `NEXT_PUBLIC_`. Rotation is a later operational concern (`runtime_credentials.key_version` is the hook).               |

## Per-Business WhatsApp Connections (pilot onboarding)

A Business Admin connects a WhatsApp number at `/settings/whatsapp`
(DECISIONS #47). The connection row stores a `credentialsRef` — the
NAME of the environment variable holding that Business's permanent Meta
access token (the raw token is NEVER stored in the database; the Zod
input rejects anything that is not an env-var-name shape). Naming
convention for per-connection secrets:

| Variable (example name)              | Purpose                                                                                                                                                                                                                          |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WHATSAPP_META_TOKEN_<BUSINESS_KEY>` | A Business's own permanent Meta access token (`Bearer` for Graph API reads + sends). The Business Admin enters this NAME in `/settings/whatsapp`; the operator stores the VALUE in the deployment environment. Server-side only. |

`WHATSAPP_META_ACCESS_TOKEN` remains the system-level fallback for the
single TEST connection; a per-connection `credentialsRef` always wins.
Replacing the TEST connection with a real Business connection is DATA
ONLY — no code change, no booking/conversation-engine change:

1. Business Admin saves the connection at `/settings/whatsapp` (display
   number + real `phone_number_id` + `credentialsRef` name).
2. Operator stores the Business's permanent access token in the
   deployment environment under that exact name (Vercel → redeploy).
3. Business Admin presses «تحقق من الاتصال» — a read-only
   `GET /{apiVersion}/{phone_number_id}` (NO message is sent). On
   success the connection becomes `CONNECTED` and is immediately
   resolvable inbound/outbound by `phone_number_id`.

### Credential reference grammars — ENV and RUNTIME (DECISIONS #49)

`credentialsRef` is ALWAYS a non-secret REFERENCE. Two grammars are
supported, and the `CredentialsResolver` boundary routes each to its
backend; the caller hands over a reference and gets a value back without
knowing which backend serves it:

| Kind      | Shape                         | Backend                                                 | When it is used                                                                                                                                                                                                   |
| --------- | ----------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ENV`     | env-var NAME (`[A-Z_]{3,64}`) | `process.env` (existing behavior — UNCHANGED)           | The current pilot path: the operator stores the token in the deployment environment under that NAME (a change requires a redeploy). This remains the default for legacy rows (`credential_kind` NULL).            |
| `RUNTIME` | opaque `fp:<id>` handle       | `runtime_credentials` table + AES-256-GCM (server-side) | A credential obtained at onboarding time (the future Meta code exchange). The raw secret is stored encrypted server-side; only the opaque handle is persisted on the connection — NO operator paste, NO redeploy. |

RUNTIME storage path (the store is the only code that ever holds the
plaintext next to the master key):

```
adapter / feature  ──store(businessId, secret)──▶  CredentialsResolver
                        │                                │
                        │                                ▼
                        │                        RuntimeCredentialStore
                        │                                │
                        ▼                                ▼
              opaque `fp:<id>` (persisted)        AES-256-GCM → Postgres
```

- The stored record contains ONLY ciphertext (`v1:` + base64(iv ‖
  ciphertext ‖ authTag)) plus safe metadata (`algorithm`,
  `key_version`). A unique 96-bit IV is generated per credential; the
  128-bit auth tag makes any tampering, truncation, or a wrong master
  key fail CLOSED at decryption — never a wrong plaintext.
- The master key (`CREDENTIAL_MASTER_KEY`) lives ONLY in the server
  environment: never in the DB, never in logs, never in an API response,
  never in a projection, and never under `NEXT_PUBLIC_`. While it is
  unset, the store is UNAVAILABLE and both `store` and `resolve` fail
  closed (the ENV grammar is completely unaffected — the app boots and
  runs without it).
- The store key is the opaque `credentialsRef` itself — never a phone
  number, business name, email, Meta Business ID, WABA ID, or
  `phone_number_id`. Tenant isolation comes from the unguessable
  reference plus the Business-owned row (`business_id`, cascade delete).
- Master-key rotation is a later OPERATIONAL concern: `key_version` is
  the hook, and this deliberately does not build key wrapping or a KMS.

### Operator-only Meta prerequisites (cannot be done from code)

- A Meta App with the WhatsApp product enabled and a WhatsApp Business
  Account; the phone number registered and verified.
- A **permanent** access token with the `whatsapp_business_messaging`
  permission (a temporary token expiry silently breaks the connection —
  verification demotes it to `PENDING` rather than claiming connected).
- Webhook subscription (`/api/whatsapp/meta`) with the App Secret and
  the verify token set in the deployment environment.
- **Meta Embedded Signup (in-app onboarding) is NOT implemented**: it
  requires external Meta dashboard/application configuration (app review
  state, redirect URIs, a server-side code-exchange step) that cannot be
  safely completed from code alone. Only the application-side contract
  (the `ConnectionVerifier` port + the `/settings/whatsapp` surface) is
  implemented; nothing is faked and no unsupported API is invented.

### Meta Embedded Signup — operator prerequisites (future adapter)

The application-side contract for the real Meta Embedded Signup adapter
is landed (the provider-neutral `ConnectionAuthorizer` port, the
authorization ledger, and the server-only configuration seam at
`src/server/integrations/whatsapp/meta-onboarding-config.ts`). The real
adapter is implemented behind that port at
`src/server/integrations/whatsapp/meta-embedded-signup-authorizer.ts`
(redirect-based Embedded Signup: OAuth dialog launch + server-side code
exchange + opaque runtime credential persistence). It activates ONLY
when the operator-owned configuration below resolves; otherwise the
deterministic stand-in stays wired and nothing changes. These items are
prerequisites — no value is invented anywhere in the repository.

**OPERATOR ACTION — META DASHBOARD** (all items are external to this
codebase; verify each in the Meta App Dashboard):

1. Obtain the **Meta App ID** and set it as `WHATSAPP_META_APP_ID`
   (non-secret identifier; also the JS SDK `appId`).
2. Enable and configure **WhatsApp Business Login / Embedded Signup** on
   the Meta App.
3. Verify the required **App Review / Advanced Access** state externally
   (the permissions the Embedded Signup flow needs must be approved by
   Meta before production use).
4. Create the Embedded Signup configuration in the Meta App Dashboard
   and set its **`config_id`** as
   `WHATSAPP_META_EMBEDDED_SIGNUP_CONFIG_ID` (non-secret configuration
   metadata; the configuration the OAuth dialog launches against).
5. Register the **production callback URI** in the Meta App.
6. Register the **localhost callback URI** if local testing is needed
   (same route, localhost origin).
7. Configure the required **login scopes** for the WhatsApp Business
   login integration.
8. Configure the **JS SDK allowed origin/domain** so the browser-side
   launch is permitted for the app domain (the redirect-based launch
   used here needs the registered redirect URI; the JS SDK is not loaded
   by this application).
9. Confirm the **existing webhook subscription remains configured**
   (`/api/whatsapp/meta`) with the App Secret and verify token in the
   deployment environment — Embedded Signup does not replace it.
10. Set `CREDENTIAL_MASTER_KEY` (32 random bytes, hex/base64) so the
    access token returned by the code exchange can be persisted through
    the encrypted runtime credential store. While it is unset, the store
    fails closed and the exchange reports an honest incomplete
    provisioning instead of faking a connection.

**Callback URI** (unchanged by this task): the single approved route is

```
/whatsapp-onboarding/callback
```

The canonical production URI is DERIVED at runtime from
`NEXT_PUBLIC_APP_URL` (`resolveOnboardingCallbackUrl`) — no production
domain is hardcoded in application logic, and no second callback route
exists. Register the derived `<NEXT_PUBLIC_APP_URL>/whatsapp-onboarding/callback`
value in the Meta Dashboard; the application keeps deriving it from the
existing server-side configuration.

**Secret handling**: the server-side code exchange reuses the
existing `WHATSAPP_META_APP_SECRET` as the OAuth `client_secret` — it is
the same Meta App Secret already used for webhook HMAC validation, so
NO second secret variable exists or is introduced. The App ID and the
`config_id` are non-secret; the App Secret must never be committed to the repository,
stored in a DB row, returned by an API, projected in the platform UI, or
logged (only its env-var NAME may appear in diagnostics). The access
token returned by the exchange is written ONLY to the encrypted runtime
credential store under an opaque `fp:<id>` reference (never a normal DB
column, never logged, never returned to the browser).

## Optional Platform Variables (provided by Vercel, informational)

| Variable     | Provided by Vercel        | FlowPilot usage                                              |
| ------------ | ------------------------- | ------------------------------------------------------------ |
| `VERCEL_URL` | deployment host per build | not required by the app; useful for quick checks             |
| `VERCEL_ENV` | `production` / `preview`  | informational; `/api/health` reports `NODE_ENV` (same value) |

`/api/health` additionally reports `timestamp`, `database` reachability
(connected / unreachable / not-configured — 3s probe through the app's Prisma
client), `missingEnvVars`, and a boolean `deploymentReady` — the single URL to
check before sharing a deployment (`docs/CLIENT_DEMO.md` Section 1).

Full step-by-step: `VERCEL_DEPLOYMENT.md` · What each check covers:
`QUALITY_CHECKS.md`.
