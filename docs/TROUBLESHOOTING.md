# FlowPilot — Troubleshooting

> Symptom → fix, ordered by how often they bite. Setup and daily workflow:
> `DEVELOPMENT.md`.

## Setup & Tooling

| Symptom                                                                  | Fix                                                                                                                                                                         |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm: /usr/bin/env: bad interpreter` (Termux)                           | Stock pnpm shim is broken on Termux. Run `bash scripts/bootstrap-termux.sh` — it installs a node wrapper at `$PREFIX/bin/pnpm` (only when `pnpm --version` actually fails). |
| `pnpm setup` / `pnpm doctor` prints pnpm's own diagnostics               | Those are pnpm **built-in** commands. Use `pnpm run setup` / `pnpm run doctor` for the project scripts.                                                                     |
| `next dev` crashes mentioning Turbopack/native bindings (Termux/Android) | Turbopack has no Android bindings. Use `bash scripts/dev-termux.sh` or `pnpm exec next dev --webpack`. `pnpm verify` does this automatically.                               |
| node "too old" per doctor                                                | Install Node.js ≥ 20 (LTS). Re-run a bootstrap script afterwards.                                                                                                           |
| Scripts can't find newly installed tools (Windows)                       | PATH changes need a NEW terminal — reopen and re-run.                                                                                                                       |
| `pnpm install` warns about build scripts                                 | Expected: `pnpm-workspace.yaml` allowlists the safe postinstall builders (prisma, esbuild, better-auth…).                                                                   |

## Environment

| Symptom                                                          | Fix                                                                                                                                             |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Doctor: `DATABASE_URL missing or placeholder`                    | Edit `.env.local`, set your Neon string (`postgresql://…?sslmode=require`). Placeholder detection includes `user:password@` and `replace-with`. |
| Doctor: `database unreachable (…) Host not found`                | Check the Neon hostname and internet. Neon projects also suspend when idle — wake it in the Neon console.                                       |
| Doctor: `password authentication failed`                         | Reset the DB password in the Neon console, update `.env.local`.                                                                                 |
| Doctor: `BETTER_AUTH_SECRET too short / placeholder`             | `node -e "console.log(require('node:crypto').randomBytes(48).toString('base64'))"` → paste into `.env.local`.                                   |
| App fails at startup with `Invalid server environment variables` | `src/lib/env.ts` (Zod) validates at boot — the message lists exactly which var is wrong. Fix `.env.local`, restart.                             |
| Edited `.env.local` but nothing changed                          | Env is read at server start — restart the dev server.                                                                                           |
| Both `.env` and `.env.local` behave differently than expected    | `.env.local` wins. Keep one file (prefer `.env.local`); `pnpm security` warns about both existing.                                              |

## Database & Prisma

| Symptom                                                       | Fix                                                                                                                                 |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `prisma migrate`/`db push` fails on Termux                    | The schema engine can't run on Android. Apply schema from desktop/CI: `pnpm db:deploy`. Dev server itself runs fine.                |
| `tsc`/editor can't find Prisma types (`src/generated/prisma`) | Client is generated & gitignored. Run `pnpm db:generate`.                                                                           |
| `prisma` CLI reads wrong `DATABASE_URL`                       | `prisma.config.ts` loads `.env.local` before `.env` (real env vars still win). Check for stray shell exports: `echo $DATABASE_URL`. |
| Seed fails to connect                                         | Same as "database unreachable" above — `pnpm db:seed` uses the same env chain.                                                      |
| Dev script skips `db push` with a warning                     | `DATABASE_URL` is missing/placeholder — that's intentional; set it and re-run.                                                      |

## Build & Runtime

| Symptom                                    | Fix                                                                                                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Port 3000 already in use                   | `next dev` picks 3001 automatically; or kill the stale process (`lsof -ti:3000                                                                                           | xargs kill` on Unix). |
| Build works locally but fails in CI/Vercel | Run `pnpm verify` locally (same gate); check that `src/generated/prisma` is generated in CI (`pnpm db:generate` runs via install? No — call it explicitly before build). |
| `pnpm verify` format step fails            | Run `pnpm format`, commit the result.                                                                                                                                    |
| Stale service worker / old UI after deploy | Service worker caches static assets; bump the cache version in `public/sw.js` (or unregister the SW in DevTools → Application).                                          |

## Git & Security

| Symptom                                             | Fix                                                                                                                                                                                                          |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Commit blocked: `refusing to commit forbidden file` | You staged an env/key/credential file. `git rm --cached <file>` then commit. Real bypass: `git commit --no-verify` (not recommended).                                                                        |
| Commit blocked: `security check found secrets`      | A staged line looks like a token/key/credential URL (value is redacted in the message). Move it to `.env.local`, reference via `process.env`. False positive? `git commit --no-verify` and please report it. |
| `pnpm security` says `.env.local is NOT gitignored` | A local gitignore override removed the rule — restore `.env*` + `!.env.example` in `.gitignore`.                                                                                                             |
| Secret was committed anyway                         | Rotate it immediately (Neon password, auth secret, tokens), then remove from tracking: `git rm --cached .env.local`. History scrubbing is only needed for real credentials — ask the operator.               |
| Hooks not running after clone                       | `pnpm run hooks:install` (also runs automatically in `pnpm run setup`). Check: `git config core.hooksPath` → `.githooks`.                                                                                    |

## VPS Performance & Memory Diagnostics (DEVOPS-01E)

| Symptom                                             | Cause                                                                            | Diagnostic Command                                | Fix                                                                                                                                              |
| --------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Terminal or AGY session lags / becomes unresponsive | VPS memory saturation; zero swap space means Linux freezes under memory pressure | `free -h`                                         | Avoid running full `next build` or full `pnpm verify` locally; use `pnpm verify:local` or `pnpm verify:fast`.                                    |
| ESLint consumes excessive RAM (>1GB) or pegs CPU    | Parsing large generated assets (e.g. `playwright-report` trace bundles)          | `ps aux --sort=-%mem \| head -n 10`               | Ensure `playwright-report/**` and `test-results/**` are in `globalIgnores` in `eslint.config.mjs` and in `.prettierignore`.                      |
| Cannot tell if build is frozen or just slow         | Long Next.js compilation or TypeScript check                                     | `ps -o pid,stat,time,%cpu,comm -p <PID>`          | Check if `time` advances over 3-5 seconds. If advancing, process is active. If stalled and `available` memory < 100MB, process may be thrashing. |
| Duplicate / runaway Node processes                  | Background or abandoned build/dev processes                                      | `pgrep -af "next\|eslint\|tsc\|playwright\|node"` | Gracefully terminate specific stale process: `kill <PID>` (or `kill -9 <PID>` as last resort). Never kill active database or AGY session.        |

## Still stuck?

1. `pnpm run doctor` — read every `→ fix:` line; it covers the common cases.
2. `docs/BUILD_STATE.md` → Key Known Limitations (incl. device limitations).
3. `docs/AGENT_RULES.md` — binding rules and lifecycle process.

## Fixed test-bot credential recovery — PR #79

Use the reviewed replacement files together. The old untracked Python script queried `is_active` although Prisma maps the real column as `"isActive"`; it also could report HEALTHY without matching bot identity. Do not run that old copy.

From the repository root, run `python3 scripts/repair-test-bot-credential.py` for read-only diagnosis. It asks for the authorized test DATABASE_URL and the **exact current Preview** master key using masked terminal input. Both hex and base64 keys use the application's existing decoder. It never reads a potentially stale .env key, rewrites .env, changes webhooks, rotates the master key, or touches the Manager Bot.

If diagnosis reports repair needed and the existing customer bot token is available, run `python3 scripts/repair-test-bot-credential.py --apply`. Only the fixed customer bot/tenant/connection can be repaired. The token must pass live getMe identity validation. The tool writes a fresh encrypted record and guarded connection reference in one transaction, reads the saved ciphertext back, verifies it before commit, and preserves the previous row for recovery. A concurrent connection edit aborts the transaction.

If the exact Preview key is not available, stop at that prerequisite; do not invent or rotate it. The launcher also supports `--from-environment` for an authorized secret-bearing runner using `DATABASE_URL`, `CREDENTIAL_MASTER_KEY`, and (apply only) `TEST_BOT_TOKEN`. Supply it through that environment or masked terminal, never chat, logs, CLI arguments, or committed files. `HEALTHY_LOCAL_KEY` / `REPAIRED_LOCAL_KEY` does not establish Preview compatibility: the actual application credential resolver must pass there before switching Telegram.

If the owner does not know the master key, use the reviewed `test-db-migrate.yml` manual operation `diagnose-credential` on `fix/safe-telegram-staff-reply-delivery` with `expected_commit_sha` set to that branch's full reviewed HEAD. It injects the existing GitHub `CREDENTIAL_MASTER_KEY` and `TEST_DATABASE_URL` only into the recovery step, and skips migration validation. This uses the source of the previously successful Preview key transfer; it does not transfer or print the key again.

For repair, the owner may set the existing customer bot token with `gh secret set YAKFI_TEST_CUSTOMER_BOT_TOKEN --repo geekammar/Yakfi` (interactive hidden input; never put the token on the command line), then run the same workflow with operation `repair-credential` and the exact reviewed SHA. This step still requires bot getMe identity validation and the fixed test database target. Remove the temporary bot-token secret after successful Preview verification. A workflow run is not live customer acceptance.

On timeout or connection loss, outcome may be unknown. Re-run read-only diagnosis and inspect the target reference before any apply retry. A failed GCM check means key/data authentication failed; it does not prove which key encrypted the original record.

For return routing, use the destination environment's own database/key and reconcile its webhook secret. Do not reuse Preview credentials blindly for a Production destination. Do not alter historical QA row 249 or mark ISS-018 accepted before the customer's real staff reply arrives.

## Provider 404 with an apparently healthy deployment

On 13 November, direct policy inspection showed OpenRouter model `deepseek/deepseek-v4.1-flash` pinned to `decart/fp4`. The public model endpoint catalog listed 38 endpoints and no Decart endpoint. The adapter intentionally emits `provider.only` plus `allow_fallbacks: false`, so a stale pin can eliminate all eligible routes. The reviewer cleared only this pin in pilot and test policies; no model, key, budget, or fallback setting was changed. Policy is read from DB at runtime; a code rollback does not undo it.

Retest a fresh or explicitly resumed AI-owned conversation. Existing NEED_HUMAN conversations correctly remain with staff; sending another greeting must not steal ownership. Require an actual successful model turn before declaring recovery. Provider failures with typed telemetry now select technical-failure copy; malformed semantic output remains a separate case. No keyword or greeting dictionary is introduced.

The health endpoint is now read-only. It no longer aligns database schema or creates a default test account. `previewDiagnostics.migrationApplied` reads the completed PR #79 migration record; false is no longer an ambiguous "this request did not perform DDL" signal. Missing test accounts must be provisioned by an explicit reviewed operator action. Existing accounts previously provisioned with a public default password require password/access review before Pilot exposure; removing the provisioning code does not rotate those credentials.

## Guarded customer-bot webhook switching & restoration runbook — PR #79

Use the reviewed switch path to retarget customer bot `@Drafnanafnanbot` (numeric ID `8926541123`) from production (`https://flowpilot-prod.vercel.app/api/telegram/webhook`) to the stable Preview origin (`https://flowpilot-prod-git-fix-safe-telegram-staff-reply-36d980-ammarj1.vercel.app/api/telegram/webhook`).

### Target & Preflight Verification

- Fixed Business ID: `f5314115-ae8c-46ea-9d7e-080ef5e7366d`
- Fixed Connection ID: `1d2cdf87-2bee-4f26-aad5-5ab9efd1c716`
- Authorized Test DB: `ep-little-mouse-a5nh644n.us-east-2.aws.neon.tech` / `ep-little-mouse-a5nh644n-pooler.us-east-2.aws.neon.tech`, database `neondb`
- Branch-scoped Preview configuration: `NEXT_PUBLIC_APP_URL` and `BETTER_AUTH_URL` pinned to `https://flowpilot-prod-git-fix-safe-telegram-staff-reply-36d980-ammarj1.vercel.app` on branch `fix/safe-telegram-staff-reply-delivery`.

### Guarded Workflow Execution (GitHub Actions)

Trigger `.github/workflows/test-db-migrate.yml` manually via `workflow_dispatch` on branch `fix/safe-telegram-staff-reply-delivery` with `expected_commit_sha` set to the exact candidate commit SHA:

1. **Dry-Run Inspection (Default / Read-Only)**:
   - Operation: `switch-webhook-dry-run`
   - Validates bot identity via `getMe`, verifies remote registration matches `https://flowpilot-prod.vercel.app/api/telegram/webhook`, checks allowed updates (`message`, `callback_query`), reads pending update count, and reports planned change with 0 mutations.

2. **Guarded Apply (Mutation)**:
   - Operation: `switch-webhook-apply`
   - Executes Telegram `setWebhook` with the stable Preview URL, rotates webhook secret, persists and verifies SHA-256 secret hash in the test Neon database, and outputs verified metadata.

### Restoration Runbook (Reverting to Production)

Restoration must synchronize the destination environment's database (`PRODUCTION_DATABASE_URL`) with its matching key (`CREDENTIAL_MASTER_KEY`). Reversing URL arguments against the Preview database alone leaves the production database out of sync, causing HTTP 401 authentication failures on inbound traffic.

To restore production webhook routing:

1. Run `.github/workflows/production-telegram-repair.yml` on `refs/heads/main` using `workflow_dispatch`:
   - `mode`: `apply-reconcile`
   - `business_id`: `f5314115-ae8c-46ea-9d7e-080ef5e7366d`
   - `connection_id`: `1d2cdf87-2bee-4f26-aad5-5ab9efd1c716`
   - `expected_url`: `https://flowpilot-prod.vercel.app/api/telegram/webhook`
2. Verify production health and Telegram webhook registration via `getWebhookInfo`.
