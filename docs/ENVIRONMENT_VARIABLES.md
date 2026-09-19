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

| Variable                        | Default | Purpose                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEMO_MODE`                     | unset   | `"true"` → the dev launcher scripts (`scripts/dev.sh` / `dev.ps1` / `dev-termux.sh`) **and** the deploy gate (`scripts/pre-deploy.mjs`, run by every `pnpm deploy:*` command) re-seed the Arabic demo business first — deployed demos never show empty dashboards. Idempotent, demo-business-scoped wipe; requires a real `DATABASE_URL`. Never used by production builds. |
| `OPENROUTER_API_KEY`            | unset   | AI provider secret (PROMPT-OPS-05) — the OpenRouter API key, environment-backed. NEVER in the DB/UI/logs: the platform AI policy stores only this NAME as the secret reference. Local: `.env.local`; production: Vercel Environment Variables (a key change requires redeploy). Optional until the provider-integration phase.                                             |
| `AGENTROUTER_API_KEY`           | unset   | AI provider secret (PROMPT-OPS-05) — the AgentRouter API key. Same rules as `OPENROUTER_API_KEY`.                                                                                                                                                                                                                                                                          |
| `ATRIA_API_KEY`                 | unset   | AI provider secret (PROMPT-OPS-05) — the Atria API key. Same rules as `OPENROUTER_API_KEY`. Resolved only when the platform AI policy selects `atria` as primary/secondary.                                                                                                                                                                                                |
| `WHATSAPP_META_VERIFY_TOKEN`    | unset   | Meta webhook verify token (`hub.verify_token` for `GET /api/whatsapp/meta`). Server-side only; compared constant-time. Optional until a Business connects a real number — `GET` verification returns 403 while unset.                                                                                                                                                      |
| `WHATSAPP_META_APP_SECRET`      | unset   | Meta App Secret for `X-Hub-Signature-256` HMAC validation on `POST /api/whatsapp/meta`. Server-side only. Optional — when unset, signature check is skipped in local/dev (tenancy + idempotency still protect Core); MUST be set in production.                                                                                                                            |
| `WHATSAPP_META_ACCESS_TOKEN`    | unset   | System/fallback WhatsApp access token (`Bearer` for `graph.facebook.com`). Server-side only; resolved via `WhatsAppConnection.credentialsRef` (env-var NAME) per-connection when set, else this fallback. Optional until send.                                                                                                                                             |
| `WHATSAPP_META_PHONE_NUMBER_ID` | unset   | Fallback Meta `phone_number_id` for outbound send URL (`/{version}/{phone_number_id}/messages`). Server-side. Optional — per-connection `WhatsAppConnection.externalId` is preferred when present.                                                                                                                                                                         |
| `WHATSAPP_META_API_VERSION`     | `v21.0` | Graph API version (e.g. `v21.0`) — `https://graph.facebook.com/{version}/{phone_number_id}/messages`. Optional; `v21.0` when unset.                                                                                                                                                                                                                                        |

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
