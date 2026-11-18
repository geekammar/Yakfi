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

The first optional variable was `INBOUND_WEBHOOK_TOKEN` (PROMPT-19); the
full optional set (WhatsApp/Meta, AI provider keys, demo mode, credential
master key) is tabled below under "Optional Variables":

| Variable                       | Scope  | Example                | Used by                                                                   |
| ------------------------------ | ------ | ---------------------- | ------------------------------------------------------------------------- |
| `INBOUND_WEBHOOK_TOKEN`        | server | 32+ char random string | `POST /api/conversations/inbound` gate — unset ⇒ inbound webhook disabled |
| `FLOWPILOT_TEST_INGRESS_TOKEN` | server | 32+ char random string | `POST /api/conversations/inbound` operator test ingress gate              |

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

| Variable                                  | Default | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEMO_MODE`                               | unset   | `"true"` → the dev launcher scripts (`scripts/dev.sh` / `dev.ps1` / `dev-termux.sh`) **and** the deploy gate (`scripts/pre-deploy.mjs`, run by every `pnpm deploy:*` command) re-seed the Arabic demo business first — deployed demos never show empty dashboards. Idempotent, demo-business-scoped wipe; requires a real `DATABASE_URL`. Never used by production builds.                                                                                                                                     |
| `OPENROUTER_API_KEY`                      | unset   | AI provider secret (PROMPT-OPS-05) — the OpenRouter API key, environment-backed. NEVER in the DB/UI/logs: the platform AI policy stores only this NAME as the secret reference. Local: `.env.local`; production: Vercel Environment Variables (a key change requires redeploy). Optional at boot; while unset the policy-backed adapter fails safe to a deterministic turn — set it for live LLM turns (DECISIONS #44).                                                                                        |
| `AGENTROUTER_API_KEY`                     | unset   | AI provider secret (PROMPT-OPS-05) — the AgentRouter API key. Same rules as `OPENROUTER_API_KEY`.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `ATRIA_API_KEY`                           | unset   | AI provider secret (PROMPT-OPS-05) — the Atria API key. Same rules as `OPENROUTER_API_KEY`. Resolved only when the platform AI policy selects `atria` as primary/secondary.                                                                                                                                                                                                                                                                                                                                    |
| `CODECRAFT_API_KEY`                       | unset   | AI provider secret — the CodeCraft API key (`https://codecraftapi.com/v1`, OpenAI-compatible). Same rules as `OPENROUTER_API_KEY`: environment-backed, server-side only, never in the DB/UI/logs/telemetry; the platform AI policy stores only this NAME as the secret reference. Resolved only when the platform AI policy selects `codecraft` as primary/secondary (a Discovery provider — DECISIONS #59). Model availability is discovered via `GET /v1/models`; the policy keeps storing provider + model. |
| `WHATSAPP_META_VERIFY_TOKEN`              | unset   | Meta webhook verify token (`hub.verify_token` for `GET /api/whatsapp/meta`). Server-side only; compared constant-time. Optional until a Business connects a real number — `GET` verification returns 403 while unset.                                                                                                                                                                                                                                                                                          |
| `WHATSAPP_META_APP_SECRET`                | unset   | Meta App Secret — server-side only, used for BOTH `X-Hub-Signature-256` HMAC validation on `POST /api/whatsapp/meta` AND the Meta Embedded Signup server-side code exchange (OAuth `client_secret`, DECISIONS #49). NEVER in the DB/UI/logs; only its env-var NAME is ever reported. While unset, signature check is skipped in local/dev (tenancy + idempotency still protect Core); MUST be set in production.                                                                                               |
| `WHATSAPP_META_APP_ID`                    | unset   | Meta App ID — the non-secret identifier of the Meta App (Embedded Signup `app_id` / JS SDK `appId`). Server-side only. PREREQUISITE for the real Meta Embedded Signup adapter; optional at boot and no code path requires it to start. No default is supplied and no value is ever invented — the operator sets it from the Meta App Dashboard. Readiness is checkable via `describeMetaOnboardingReadiness()`.                                                                                                |
| `WHATSAPP_META_EMBEDDED_SIGNUP_CONFIG_ID` | unset   | Meta Embedded Signup **`config_id`** — non-secret server-side CONFIGURATION METADATA identifying the Embedded Signup configuration created in the Meta App Dashboard (the configuration the OAuth dialog / JS SDK launches against). PREREQUISITE for the real adapter alongside `WHATSAPP_META_APP_ID`; optional at boot. While unset, the adapter seam falls back to the deterministic stand-in and never invents a value. Never `NEXT_PUBLIC_`.                                                             |
| `WHATSAPP_META_ACCESS_TOKEN`              | unset   | System/fallback WhatsApp access token (`Bearer` for `graph.facebook.com`). Server-side only; resolved via `WhatsAppConnection.credentialsRef` (env-var NAME) per-connection when set, else this fallback. Optional until send.                                                                                                                                                                                                                                                                                 |
| `WHATSAPP_META_PHONE_NUMBER_ID`           | unset   | Fallback Meta `phone_number_id` for outbound send URL (`/{version}/{phone_number_id}/messages`). Server-side. Optional — per-connection `WhatsAppConnection.externalId` is preferred when present.                                                                                                                                                                                                                                                                                                             |
| `WHATSAPP_META_API_VERSION`               | `v21.0` | Graph API version (e.g. `v21.0`) — `https://graph.facebook.com/{version}/{phone_number_id}/messages`. Optional; `v21.0` when unset.                                                                                                                                                                                                                                                                                                                                                                            |
| `CREDENTIAL_MASTER_KEY`                   | unset   | **RUNTIME credential store** master encryption key (DECISIONS #49) — 32 random bytes as hex (64 chars) or base64 (44 chars). Optional: while unset the store stays UNAVAILABLE (every `fp:<id>` store/resolve fails closed) and the existing ENV grammar is unaffected. Server-side only; NEVER in the DB/UI/logs and never `NEXT_PUBLIC_`. Rotation is a later operational concern (`runtime_credentials.key_version` is the hook).                                                                           |

### Optional Turn-Evidence Observability (DECISIONS #88 / `PROMPT-AI-OPS-22`)

These govern the fail-open turn-evidence sink ONLY. All are optional; unset
means the default behaviour below. They never affect routing, disclosure,
booking, or any customer-visible outcome.

| Variable                      | Default      | Meaning                                                                                                                                                                                                                                         |
| ----------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TURN_EVIDENCE_DISABLED`      | unset (emit) | `1`/`true` silences the sink entirely (no structured log line, no OTLP). A kill switch for a noisy/incident scenario.                                                                                                                           |
| `OTEL_TURN_EVIDENCE_ENABLED`  | unset (off)  | `1`/`true` ALSO exports each turn-evidence record via OTLP/HTTP-JSON. Requires `OTEL_EXPORTER_OTLP_ENDPOINT`; without it the sink stays logs-only.                                                                                              |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset        | OTLP/HTTP base URL (the sink POSTs to `{endpoint}/v1/traces`). Standard OTLP variable name; vendor-neutral. Example: a Better Stack / Honeycomb / Grafana OTLP endpoint, configured through env only — no vendor is hard-coded in domain logic. |

By default the sink writes ONE structured JSON line per inbound turn to the
existing runtime logs (`msg:"flowpilot.turn.evidence"`). The record is
content-free (machine keys, counters, booleans, and correlation ids only —
never customer text, phone numbers, keys, prompts, or chain-of-thought) and is
emitted off the customer critical path. See `docs/ai/ARCHITECTURE.md → Turn
evidence / observability seam`.

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

| Kind      | Shape                         | Backend                                                 | When it is used                                                                                                                                                                                                                           |
| --------- | ----------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ENV`     | env-var NAME (`[A-Z_]{3,64}`) | `process.env` (existing behavior — UNCHANGED)           | The current pilot path: the operator stores the token in the deployment environment under that NAME (a change requires a redeploy). This remains the default for legacy rows (`credential_kind` NULL).                                    |
| `RUNTIME` | opaque `fp:<id>` handle       | `runtime_credentials` table + AES-256-GCM (server-side) | A credential obtained at onboarding time (the Meta Embedded Signup code exchange, DECISIONS #49). The raw secret is stored encrypted server-side; only the opaque handle is persisted on the connection — NO operator paste, NO redeploy. |

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
- **Meta Embedded Signup (in-app onboarding) is IMPLEMENTED and
  operator-gated**: the redirect-based flow (OAuth dialog launch +
  server-side code exchange + opaque runtime credential persistence) is
  landed behind the provider-neutral `ConnectionAuthorizer` port
  (`meta-embedded-signup-authorizer.ts`, DECISIONS #49). It activates ONLY
  when the operator-owned Meta dashboard configuration below resolves;
  otherwise the deterministic stand-in stays wired and nothing is faked.

### Meta Embedded Signup — operator prerequisites (adapter is landed; activates only when these resolve)

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

## Fixed test-bot maintenance credentials (14 November 2026)

- Preview switch: `TEST_DATABASE_URL` and the existing `CREDENTIAL_MASTER_KEY`; the application resolver remains authoritative.
- Main restoration/preflight: `PRODUCTION_DATABASE_URL` and the existing Actions secret `YAKFI_TEST_CUSTOMER_BOT_TOKEN`, injected only into the maintenance step as `RESTORE_BOT_TOKEN`. A resolve-only operator dependency supplies this token to the existing switch service; live pinned bot identity is mandatory before mutation. It cannot store/delete a credential or change a credential reference.
- `YAKFI_PRODUCTION_CREDENTIAL_MASTER_KEY` was a failed recovery candidate and is no longer consumed by the routing job. The Production application's `CREDENTIAL_MASTER_KEY` in Vercel is unchanged. Do not assume the candidate is its backup.
- Keep an encrypted password-manager backup for original secrets, with separate environment entries and a non-secret inventory of name/scope/source/date. Do not put secret values in Drive, Git, notes shared with agents, logs or chat. Plan the one-record Production key rebaseline before Pilot, not a blanket reset of working integrations.

## Fixed Preview-to-Preview transfer (PR #83, prepared only)

The guarded Preview transfer reuses the existing **test-only** secrets:
`TEST_DATABASE_URL` and `CREDENTIAL_MASTER_KEY`. It introduces no new secret,
no Production database access and no owner-token fallback. The destination
readiness check requires the integrated Preview to report the reviewed
version/SHA, `isProductionDb=false`, `migrationApplied=true` and the same
authorized test DB host. Apply/return remain explicit reviewer-approved
operations; do not copy or rotate credentials to make a check pass.

Moving the old-PR79 Preview `CREDENTIAL_MASTER_KEY` scope to the integration
branch would only repair the Y83 Preview diagnosis. It is **not** the single
runtime consolidation and must not be reported as one.

## Single Production runtime consolidation — prepared, not executed (15 November 2026)

The approved operating decision is one primary Vercel runtime for
development-stage live acceptance: Production deployed from `main`, one fixed
bot, one explicitly selected active database. Git branches and PRs remain the
development process; Preview is optional, never a mandatory per-task
acceptance gate. This section records the prepared configuration only. No
Production environment write, migration, webhook move, merge, branch deletion,
credential rotation, paid model call or Telegram send was performed.

### Configuration and scope inventory (values never read or printed)

<!-- prettier-ignore -->
| Variable | Current Production | Current integrated Preview | Proposed single Production runtime |
| --- | --- | --- | --- |
| `DATABASE_URL` | Production scope; sensitive; present. Documented target `ep-tiny-grass-a5e63jev.../neondb`; health reports `connected`. | Preview scope; sensitive; present. Verified target `ep-little-mouse-a5nh644n.../neondb`. | Reuse the verified test target through the existing `TEST_DATABASE_URL`; owner-assisted Production update. Preserve the old Production DB as inactive recovery data. |
| `CREDENTIAL_MASTER_KEY` | Production scope; sensitive; present. Old Production key; not proven to decrypt the test DB. | Branch-scoped only to `fix/safe-telegram-staff-reply-delivery`; absent for the integration branch. Y83 proves runtime decryption fails there. | Reuse the existing test-compatible key (the key used by the old Preview and the GitHub Actions `CREDENTIAL_MASTER_KEY`). No generation or rotation. |
| `OPENROUTER_API_KEY` | Production scope; sensitive; present. | Preview scope (all branches); sensitive; present. | Keep the Production value. Do not copy the Preview value. |
| `BETTER_AUTH_URL` | Production scope; present; canonical origin `https://flowpilot-prod.vercel.app`. | Branch-scoped only to the old PR79 branch; the integration Preview derives its own Vercel host. | Keep the canonical Production origin. Do not copy Preview branch URLs. |
| `NEXT_PUBLIC_APP_URL` | Production scope; encrypted; present; canonical origin above. | Branch-scoped only to the old PR79 branch. | Keep the canonical Production origin. |
| `BETTER_AUTH_SECRET` | Production scope; sensitive; present. | Preview scope; sensitive; present. | Keep the Production value. Existing sessions from the old DB do not survive the DB change; accounts in the selected DB re-authenticate. |
| Telegram / WhatsApp channel settings | Manager-bot and WhatsApp settings are Production-scoped. The fixed customer bot is a runtime credential in the selected DB. | No Production manager/WhatsApp settings; fixed bot credential is in the test DB; the integration key is missing (Y83). | Keep Production channel settings. Move the fixed bot once to the canonical Production webhook; the switch persists its secret hash in the selected test DB. |

Supporting Actions secrets (names only): `TEST_DATABASE_URL` and
`CREDENTIAL_MASTER_KEY` are the test-compatible pairing; `PRODUCTION_DATABASE_URL`
currently names the old Production target and must be repointed during the
transition; `YAKFI_TEST_CUSTOMER_BOT_TOKEN` is the owner-only maintenance token;
`VERCEL_TOKEN` exists for an explicitly reviewed one-shot transfer if the owner
cannot re-enter the key from the vault.

### Metadata is not runtime usability

- A Production `DATABASE_URL` and `CREDENTIAL_MASTER_KEY` both exist and the
  database reports `connected`; that does not prove the Production key
  decrypts the test DB. The Y83 failure and the `CREDENTIALS_UNAVAILABLE`
  reverse preflight are the counter-evidence.
- The old Preview operates on the test DB with the branch-scoped key; R5
  accepted delivery and the forward read-only dry run evidence that pairing.
  The integration Preview has the same DB but no key, which is exactly why Y83
  failed. A Production deployment has not been probed with this pairing.
- Do not assume either key decrypts the other database's credentials. Do not
  generate a replacement key or re-encrypt unrelated records.

### Selected active database and reason

The selected dataset is the existing Neon test database
`ep-little-mouse-a5nh644n[-pooler].us-east-2.aws.neon.tech` / `neondb` because:

- it already carries the additive PR #79 migration
  `20261108200000_safe_telegram_staff_reply_delivery` (integration Preview health
  reports `migrationApplied=true`); record this evidence and do not reapply it;
- it contains the fixed bot runtime credential that the known test-compatible
  key decrypts, avoiding key generation or re-encryption;
- both fixed Previews already report the same test DB, 4 users and 4 accounts;
- the old Production database remains intact as an inactive recovery source
  and is never reset, overwritten or deleted.

Changing the Production database also changes which data is live. Owner
confirms all current users/data are experimental; old Production data will not
be visible after the switch. Production URLs, auth settings and channel
settings remain canonical.

### CI isolation and runtime migrations

- Automatic PR migration validation in `test-db-migrate.yml` now uses a
  job-local `postgres:16` service. It never receives `TEST_DATABASE_URL`,
  `PRODUCTION_DATABASE_URL` or `CREDENTIAL_MASTER_KEY`.
- The manual fixed-target operations in that workflow remain exact-branch and
  exact-SHA guarded and are now explicit runtime maintenance, not PR CI. Do not
  dispatch them casually.
- `production-db-migrate.yml` is the only runtime migration workflow. It now
  requires `expected_db_host` and `expected_commit_sha`, refuses a mismatched
  host/SHA, and rejects the known legacy Production Neon hosts in apply mode.
  The operator must repoint the effective environment-scoped
  `PRODUCTION_DATABASE_URL` to the selected active database during the
  transition.
- `pr-validation.yml` already uses a disposable local PostgreSQL service.
- Migration status on the selected target is read-only until an approved
  migration is pending. The PR #79 marker is already present; do not reapply it.

### Owner-assisted secure reuse

Vercel does not expose sensitive environment values for reading back. The
owner must first confirm the existing test-compatible `DATABASE_URL` and
`CREDENTIAL_MASTER_KEY` are available from the encrypted vault. If they are,
re-enter only those two values into the Production scope without printing or
committing them.

If the owner cannot re-enter them, use the reviewed one-shot
`test-db-migrate.yml` operation `configure-production-runtime-env` with
`environment_operation=preflight` then `environment_operation=apply`. It
reuses the repository secrets `TEST_DATABASE_URL` and `CREDENTIAL_MASTER_KEY`
with `VERCEL_TOKEN`, requires the exact reviewed SHA, and updates only the
existing Production `DATABASE_URL` and `CREDENTIAL_MASTER_KEY` records. It
does not create secrets, copy Preview variables, or touch auth/AI/channel
settings. A `PARTIAL_ENV_UPDATE` result is a stop condition: inspect which key
changed, do not merge or deploy, and recover only under separate approval.

The current Production `DATABASE_URL` and `CREDENTIAL_MASTER_KEY` are sensitive
and cannot be read back through Vercel. A deployment ID or health response is
not a substitute for a recoverable configuration backup. If the old values are
not in the owner vault, a full configuration rollback is not available and must
be recorded as a blocker; do not replace the secrets as though rollback were
guaranteed.

### Effective secret scopes

- `production-db-migrate.yml` and `production-telegram-repair.yml` use the
  `Production` GitHub environment, so the environment-scoped
  `PRODUCTION_DATABASE_URL` overrides the repository-scoped secret of the same
  name. Repoint and verify the effective scope before relying on either.
- `test-db-migrate.yml` manual operations (including
  `configure-production-runtime-env`) do not set a GitHub environment; they
  use the repository-scoped `TEST_DATABASE_URL` and `CREDENTIAL_MASTER_KEY`.
- `production-telegram-repair.yml` does not enforce `expected_db_host`; it is
  not the cutover gate. Use the guarded cutover operations instead.
- Matching secret names do not prove equal values. Verify the target scope and
  non-secret host identity, never the value.

### Prepared execution mechanisms

- `test-db-migrate.yml` / `verify-selected-runtime`: read-only selected DB
  migration status plus fixed-bot credential/getMe verification using
  `TEST_DATABASE_URL` and `CREDENTIAL_MASTER_KEY`.
- `test-db-migrate.yml` / `configure-production-runtime-env` with
  `environment_operation=preflight` or `apply`: updates only the two fixed
  Production environment records, exact-SHA guarded.
- `test-db-migrate.yml` / `cutover-main-runtime-dry-run` then
  `cutover-main-runtime-apply`: fixed-bot switch to canonical Production using
  the selected test DB/key. Before switchFn, the deployed app must answer
  `/api/operator/cutover-readiness` with a short-lived HMAC proof of its
  commit/version, selected DB binding, fixed Business/connection and resolved
  bot credential; the existing `YAKFI_TEST_CUSTOMER_BOT_TOKEN` signs the
  request and is never sent. Dry-run/apply are separate with no automatic
  retry.
- Read-only postcheck: repeat `verify-selected-runtime`, repeat the cutover
  dry-run with `expected_current=main`, and inspect `/api/health`.

Exact order and rollback are in `TROUBLESHOOTING.md`.

## Render Migration Recoverable Secrets & Values-Free Inventory (17 November 2026)

### Two-Output Recoverable Configuration Model

Configuration recoverability separates metadata from secret values:

1. **Git-tracked values-free inventory (`config/render-env-inventory.json`):**
   records every required, optional, platform-injected, and forbidden variable
   with 11 mandatory fields (`name`, `purpose`, `environment`, `requiredStatus`,
   `recoverySource`, `recoveryState`, `replacementImpact`, `owner`,
   `vaultItemRef`, `verificationDate`, `nextAction`) and **zero** secret values.
   Validated in CI by `pnpm check:render-migration`.
2. **Owner-controlled encrypted vault (`yakfi/render-prod/*`):** holds actual
   secret values in Ammar's password manager plus offline encrypted X25519/GCM
   recovery bundles (`yakfi.encrypted-secret-bundle@v1`). **Render, Vercel, and
   GitHub Actions are runtime distribution targets, never the sole backup.** Any
   newly created secret must be written to the owner vault before installation
   on Render. Never place secret values in Git, PRs, Drive reports, logs,
   screenshots, or plaintext CI artifacts.

### Vercel 25-Variable Observation & GitHub Secrets Reality

- Reviewer observed **25 Production variables** in Vercel project
  `flowpilot-prod` (`prj_CjKh6Qt6IAKEc9EB4StaJJxnP0Fp`): **24 Sensitive/Secret**
  and **1 Config** (`NEXT_PUBLIC_APP_URL`). Vercel cannot read back Sensitive
  Production values via CLI (`vercel env pull`) or REST API (`?decrypt=false`),
  so an `env pull` is never a complete backup.
- GitHub Actions repository secrets (`gh secret list` metadata re-verified on
  the new Boxd VPS 2026-11-17/18, values never exposed by API):
  `CREDENTIAL_MASTER_KEY` (~24d ago), `PRODUCTION_DATABASE_URL` (~1mo ago;
  overridden in `Production` environment by an environment secret updated ~17d
  ago), `TEST_DATABASE_URL` (~1mo ago), `VERCEL_TOKEN` (~5d ago),
  `YAKFI_TEST_CUSTOMER_BOT_TOKEN` (~4d ago), and
  `YAKFI_PRODUCTION_CREDENTIAL_MASTER_KEY` (~4d ago — failed recovery candidate
  on 2026-11-13, not a valid backup). `RENDER_API_KEY` is **not** currently set
  in GitHub secrets (required only if dispatching `render-migration-ops.yml`
  service checks/transfer instead of manual vault paste). Secret name presence
  does **not** prove decryption compatibility until verified by
  `verify-selected-runtime` (`HEALTHY_LOCAL_KEY`).
- **Deleted old VPS boundary:** local `.env*`, `rclone`, and Agent Handoff did
  not survive on the new Boxd VPS. `render-migration-ops.yml` has never been
  dispatched (zero encrypted bundles exported); any private key that existed
  solely on the deleted VPS without an external vault copy is permanently lost,
  and no encrypted backup may ever be claimed recoverable without its private
  key in Ammar's workstation vault.
- **Unknown JEV / Shadow settings:** `FLOWPILOT_JEV_SEMANTIC_ENABLED`,
  `FLOWPILOT_JEV_APPROVED_MONTHLY_BUDGET`, `FLOWPILOT_JEV_SHADOW_ENABLED`,
  `SHADOW_SALT`, `SHADOW_SAMPLE_RATE`, `SHADOW_MAX_CALLS_PER_DAY`, and
  `JEV_SHADOW_TIMEOUT_MS` remain recorded as `UNKNOWN_UNVERIFIED` until key-name
  metadata is inspected via `render-migration-ops.yml` (`inspect-sources`) and
  confirmed by Ammar. Never guess values that alter engine authority or AI spend.
- **Appointment reminders:** `APPOINTMENT_REMINDERS_ENABLED` remains
  `CONFIRMED_DISABLED` (unset) unless separately approved.

### Manual Secret Recovery, Owner Encryption & Restoration Check

Prepared in `.github/workflows/render-migration-ops.yml` +
`scripts/render-vault-tool.ts` (`workflow_dispatch` only; **never** runs in PR
CI; **not** executed in this preparation task):

1. **Exclusive owner keypair generation (Ammar's private workstation only):**
   ```bash
   pnpm exec tsx scripts/render-vault-tool.ts keygen --out ~/yakfi-owner-recovery-key.json
   ```
   Uses exclusive `O_CREAT | O_EXCL` (`0600`) creation and refuses existing
   files or symlinks so an existing private key can never be overwritten. Save
   `~/yakfi-owner-recovery-key.json` inside Ammar's encrypted password manager
   vault; copy only the public `yakfi-rcpt-v1:...` recipient (any private key
   material passed to CI is rejected with `PRIVATE_KEY_INPUT_FORBIDDEN`).
2. **Read-only decryption preflight (`mode=verify-selected-runtime`) & metadata inspection (`mode=inspect-sources`):**
   `verify-selected-runtime` proves read-only AES-256-GCM decryption of the
   intended existing `fp:<id>` credential in the active Neon dataset
   (`status: HEALTHY_LOCAL_KEY`) with zero Telegram/AI calls and zero secret
   values in output, then runs read-only `prisma migrate status` (preserving its
   real exit code, redacting URL credentials, cleaning up via `EXIT` trap,
   distinguishing decryption status from migration status, and failing
   `NOT_READY` without applying migrations if migrations are pending, failed, or
   divergent). `inspect-sources` classifies Neon hosts, checks 32-byte key
   decoding, optionally verifies Render service ownership
   (`tea-db9st3gm7kps73ek9op0` / strict `ohio`, rejecting missing, malformed, or
   wrong region), and lists Vercel Production variable names/types
   (`?decrypt=false` with `value` stripped).
3. **Pre-service encrypted export (`mode=export-encrypted-bundle`) & Restoration Proof:**
   works before any Render service exists (`render_service_id` blank ->
   `PRE_SERVICE_CREATION`), runs `verify-selected-runtime` first, encrypts only
   the explicit allowlist (`DATABASE_URL`, `CREDENTIAL_MASTER_KEY`) in memory to
   `owner_recipient` using ephemeral X25519 ECDH + HKDF-SHA256 + AES-256-GCM,
   and uploads ciphertext-only `yakfi-owner-encrypted-bundle` (`if: always()`,
   1-day retention). Ammar verifies restoration locally without printing
   plaintext and obtains the values-free one-way `restorationProof`
   (`yakfi-verified-v1:...`):
   ```bash
   pnpm exec tsx scripts/render-vault-tool.ts verify-bundle \
     --bundle yakfi-secrets.enc.json \
     --key-file ~/yakfi-owner-recovery-key.json
   ```
4. **Backup-before-transfer (`mode=transfer-to-render`):** requires exact
   40-char SHA, confirmed real `srv-...` in `tea-db9st3gm7kps73ek9op0` + `ohio`
   `web_service` (`PRE_SERVICE_CREATION` rejected), and verified
   `owner_restoration_proof` (`yakfi-verified-v1:...`) when `dry_run=false`. Job
   1 (`prepare-and-deliver-backup`) verifies pairing + proof and delivers
   `yakfi-owner-encrypted-bundle` to GitHub Artifacts **before** Job 2
   (`apply-render-transfer`) issues single-key
   `PUT /v1/services/{serviceId}/env-vars/{key}` calls, and `always()` artifact
   upload + pre-PUT disk persistence preserve ciphertext across partial HTTP
   failures and network exceptions.

### Selective Re-Linking Contingency (If Recovery Fails)

Never generate a replacement `CREDENTIAL_MASTER_KEY` blindly or rotate all
secrets at once. If `CREDENTIAL_MASTER_KEY` cannot decrypt the selected DB's
`fp:<id>` credential:

- **Unaffected / safely regenerable:** `BETTER_AUTH_URL` &
  `NEXT_PUBLIC_APP_URL` (new Render HTTPS origin), `BETTER_AUTH_SECRET`
  (fresh vault-backed secret; users sign in again on the new domain),
  `OPENROUTER_API_KEY` (dedicated bounded key from OpenRouter console, backed up
  to vault first).
- **Affected `fp:<id>` integration on active Neon test DB
  (`ep-little-mouse-a5nh644n.../neondb`):** fixed Business
  `f5314115-ae8c-46ea-9d7e-080ef5e7366d`, Telegram Connection
  `1d2cdf87-2bee-4f26-aad5-5ab9efd1c716` (`@Drafnanafnanbot`, ID `8926541123`).
  Re-link **only** that single connection via reviewed
  `scripts/repair-test-bot-credential.py --apply` using
  `YAKFI_TEST_CUSTOMER_BOT_TOKEN` and a vault-backed master key, which writes a
  new `fp:<id>` row in one guarded transaction while **preserving prior
  `runtime_credentials` rows, conversations, delivery routes, dedupe records,
  and all QA249/QA250/QA251/R5/R6/Y83 evidence**.
- **Inactive legacy Production DB (`ep-tiny-grass-a5e63jev.../neondb`):** 1
  `runtime_credentials` row, 3 Telegram connections, 2 WhatsApp connections —
  leave completely untouched as historical recovery data.
