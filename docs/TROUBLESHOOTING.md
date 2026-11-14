# FlowPilot — Troubleshooting

> Symptom → fix, ordered by how often they bite. Setup and daily workflow:
> `DEVELOPMENT.md`. Verification policy authority: `AGENT_RULES.md` §4.
> Package commands here are supported tools for an authorized **non-VPS**
> environment or CI. On the VPS, use source/text inspection, editing and Git
> only; do not execute package or database commands.

## Setup & Tooling

<!-- prettier-ignore -->
| Symptom                                                                  | Fix                                                                                                                                                                         |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm: /usr/bin/env: bad interpreter` (Termux)                           | Stock pnpm shim is broken on Termux. Run `bash scripts/bootstrap-termux.sh` — it installs a node wrapper at `$PREFIX/bin/pnpm` (only when `pnpm --version` actually fails). |
| `pnpm setup` / `pnpm doctor` prints pnpm's own diagnostics               | Those are pnpm **built-in** commands. Use `pnpm run setup` / `pnpm run doctor` for the project scripts.                                                                     |
| `next dev` crashes mentioning Turbopack/native bindings (Termux/Android) | Turbopack has no Android bindings. On an authorized non-VPS Termux workstation, use `bash scripts/dev-termux.sh` or `pnpm exec next dev --webpack`. The full gate runs in CI; never on the VPS. |
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

<!-- prettier-ignore -->
| Symptom                                                       | Fix                                                                                                                                 |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `prisma migrate`/`db push` fails on Termux                    | The schema engine can't run on Android. Apply schema from desktop/CI: `pnpm db:deploy`. Dev server itself runs fine.                |
| `tsc`/editor can't find Prisma types (`src/generated/prisma`) | Client is generated & gitignored. Run `pnpm db:generate` in CI or an authorized non-VPS environment; never on the VPS.              |
| `prisma` CLI reads wrong `DATABASE_URL`                       | `prisma.config.ts` loads `.env.local` before `.env` (real env vars still win). Check for stray shell exports: `echo $DATABASE_URL`. |
| Seed fails to connect                                         | Same as "database unreachable" above — `pnpm db:seed` uses the same env chain. Run it in an authorized non-VPS environment; never on the VPS. |
| Dev script skips `db push` with a warning                     | `DATABASE_URL` is missing/placeholder — that's intentional; set it and re-run.                                                      |

## Build & Runtime

<!-- prettier-ignore -->
| Symptom                                    | Fix                                                                                                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Port 3000 already in use                   | `next dev` picks 3001 automatically; or kill the stale process (`lsof -ti:3000                                                                                           | xargs kill` on Unix). |
| Build fails in CI/Vercel | Run the full `pnpm verify` in existing GitHub Actions CI or an authorized isolated cloud runner; never on the VPS. Check that `src/generated/prisma` is generated in CI (`pnpm db:generate` runs via install? No — call it explicitly before build). |
| `pnpm verify` format step fails            | Fix formatting in CI or an authorized isolated cloud runner, then commit the result. Never run a formatter on the VPS. |
| Stale service worker / old UI after deploy | Service worker caches static assets; bump the cache version in `public/sw.js` (or unregister the SW in DevTools → Application).                                          |

## Git & Security

| Symptom                                             | Fix                                                                                                                                                                                                          |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Commit blocked: `refusing to commit forbidden file` | You staged an env/key/credential file. `git rm --cached <file>` then commit. Real bypass: `git commit --no-verify` (not recommended).                                                                        |
| Commit blocked: `security check found secrets`      | A staged line looks like a token/key/credential URL (value is redacted in the message). Move it to `.env.local`, reference via `process.env`. False positive? `git commit --no-verify` and please report it. |
| `pnpm security` says `.env.local is NOT gitignored` | A local gitignore override removed the rule — restore `.env*` + `!.env.example` in `.gitignore`.                                                                                                             |
| Secret was committed anyway                         | Rotate it immediately (Neon password, auth secret, tokens), then remove from tracking: `git rm --cached .env.local`. History scrubbing is only needed for real credentials — ask the operator.               |
| Hooks not running after clone                       | `pnpm run hooks:install` (also runs automatically in `pnpm run setup`). Check: `git config core.hooksPath` → `.githooks`.                                                                                    |

## VPS Process Safety (current boundary)

The diagnostics below are read-only. They do not authorize package execution on
the VPS. Historical DEVOPS-01E local-check guidance is superseded by
`AGENT_RULES.md` §4.

<!-- prettier-ignore -->
| Symptom                                             | Cause                                                                            | Diagnostic Command                                | Fix                                                                                                                                              |
| --------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Terminal or AGY session lags / becomes unresponsive | VPS memory saturation; zero swap space means Linux freezes under memory pressure | `free -h`                                         | The approved rule prohibits all package execution on the VPS. Do not start builds/tests/checks; stop any stray package process and report. Use existing CI or an authorized isolated cloud runner. |
| Stray ESLint process on the VPS consumes RAM        | Package work should not run on the VPS                                            | `ps aux --sort=-%mem \| head -n 10`               | Stop the stray process and report; do not run ESLint on the VPS. Keep `playwright-report/**` and `test-results/**` in `globalIgnores` for authorized runners. |
| Cannot tell if build is frozen or just slow         | Long Next.js compilation or TypeScript check                                     | `ps -o pid,stat,time,%cpu,comm -p <PID>`          | Check if `time` advances over 3-5 seconds. If advancing, process is active. If stalled and `available` memory < 100MB, process may be thrashing. |
| Duplicate / runaway Node processes                  | Stray package process that should not run on the VPS                             | `pgrep -af "next\|eslint\|tsc\|playwright\|node"` | Stop the stale process and report it; do not start builds, tests or a dev server on the VPS. Never kill an active database or AGY session.       |

## Still stuck?

1. `pnpm run doctor` — read every `→ fix:` line; it covers the common cases.
2. `docs/BUILD_STATE.md` → Key Known Limitations (incl. device limitations).
3. `docs/AGENT_RULES.md` — binding rules and lifecycle process.
