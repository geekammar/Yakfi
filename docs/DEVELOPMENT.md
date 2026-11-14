# FlowPilot — Development Guide (Setup & Daily Workflow)

> How to get FlowPilot running on any platform and the day-to-day
> development workflow. Formed in the PROMPT-ARCH-01 reconciliation by
> merging `ENVIRONMENT_SETUP.md` + `LOCAL_DEVELOPMENT.md`. Companion
> scripts live in `scripts/`. Env var reference:
> `ENVIRONMENT_VARIABLES.md` · errors: `TROUBLESHOOTING.md`.
>
> **Current approved VPS execution boundary (14 November 2026):** the VPS is
> for source/text inspection, editing and Git only. Do not run any package or
> application command in this guide there. Run bootstrap, install, generate,
> dev-server and database commands only on an authorized non-VPS development
> workstation. Required checks run in existing CI or an authorized isolated
> cloud runner. Historical local-check guidance below is retained for non-VPS
> use and does not authorize VPS execution.

## TL;DR — First Run

| Platform         | Bootstrap                                                        | Run dev                                                    |
| ---------------- | ---------------------------------------------------------------- | ---------------------------------------------------------- |
| macOS / Linux    | `bash scripts/bootstrap.sh`                                      | `bash scripts/dev.sh`                                      |
| Windows          | `powershell -ExecutionPolicy Bypass -File scripts\bootstrap.ps1` | `powershell -ExecutionPolicy Bypass -File scripts\dev.ps1` |
| Termux (Android) | `bash scripts/bootstrap-termux.sh`                               | `bash scripts/dev-termux.sh`                               |

Each bootstrap script:

1. Detects the OS and verifies **node** (≥ 20), **pnpm**, **git**, **gh**.
2. Installs **only** what is missing — an existing working tool is never
   reinstalled or upgraded.
3. Runs the project setup (`pnpm run setup`): creates `.env.local` if no env
   file exists, installs dependencies, generates the Prisma client,
   installs the pre-commit hook.
4. Runs diagnostics (`pnpm run doctor`) — warnings are expected until
   `DATABASE_URL` is set.

> **pnpm name collision:** `pnpm setup` and `pnpm doctor` (without `run`)
> execute pnpm's own built-in commands. Always use **`pnpm run setup`** and
> **`pnpm run doctor`** for the project scripts.

## Platform Notes

### Windows

- Requirements: PowerShell 5.1+ and [winget](https://learn.microsoft.com/windows/package-manager/winget/)
  (included in current Windows 10/11).
- If the script blocks, run it in a **new terminal** after installs — PATH
  changes only apply to new sessions.
- Manual fallbacks: [Node.js LTS](https://nodejs.org), [Git](https://git-scm.com),
  [GitHub CLI](https://cli.github.com), then `npm install -g pnpm@11.24.0`.

### macOS / Linux

- Uses Homebrew where available; otherwise `apt-get` / `dnf` / `pacman` /
  `zypper` (with `sudo` only when not already root).
- pnpm is installed via CorePack when the Node version ships it, otherwise via
  `npm install -g pnpm@11.24.0` (matching `packageManager` in `package.json`).

### Termux (Android)

- Install [Termux from F-Droid](https://f-droid.org/en/packages/com.termux/)
  (the Play Store build is outdated), then clone the repo into `~/projects`.
- **Known Termux quirk:** pnpm's global shim has a `#!/usr/bin/env node`
  shebang, and Termux has no `/usr/bin/env` — so `pnpm` fails with
  `bad interpreter`. `bootstrap-termux.sh` verifies `pnpm --version` first and
  only repairs it when broken, by installing a small `node` wrapper at
  `$PREFIX/bin/pnpm`. Nothing is reinstalled if pnpm already works.
- **Turbopack has no Android bindings** — use `scripts/dev-termux.sh`. Run the
  full `pnpm verify` in CI; if it must run on Termux, it automatically adds
  `--webpack`.
- **The Prisma schema engine cannot run on-device**, so `prisma migrate dev` /
  `db push` may fail on Termux. Sync the database from desktop/CI
  (`pnpm db:deploy`) when needed; the dev server still runs.

## Environment Files & Variables

- **Preferred file: `.env.local`** (Next.js convention); `.env` is honored
  for backwards compatibility.
- **Precedence everywhere:** real environment variables > `.env.local` >
  `.env` (dev server, Prisma CLI via `prisma.config.ts`, and `pnpm db:seed`).
- Required variables: `DATABASE_URL` (Neon), `BETTER_AUTH_SECRET`,
  `BETTER_AUTH_URL`, `NEXT_PUBLIC_APP_URL` — all validated at runtime by Zod
  in `src/lib/env.ts` (fail fast). Optional: `INBOUND_WEBHOOK_TOKEN`
  (inbound webhook gate), `DEMO_MODE` (auto-seed). Full reference:
  `ENVIRONMENT_VARIABLES.md`.
- Never commit env files — `.gitignore` covers `.env*` except
  `.env.example`; the pre-commit hook and `pnpm security` enforce it.
- `pnpm run setup` runs `scripts/setup-env.mjs`, which never overwrites an
  existing env file, copies `.env.example` → `.env.local` (mode 600), and
  injects a cryptographically random `BETTER_AUTH_SECRET` (never printed).
- After editing env vars, restart the dev server (values are read at startup).

## Daily Workflow

Run the commands below only on an authorized **non-VPS** development workstation
or in existing CI / an authorized isolated cloud runner. Never on the VPS.

```bash
pnpm run doctor      # health check: tools, env, DB connection, build readiness
bash scripts/dev.sh  # or dev.ps1 / dev-termux.sh — install→generate→db push→dev
pnpm verify:local    # lightweight gate (security + prompt + types + lint + format); non-VPS/CI only
pnpm verify:fast     # ultra-fast iteration gate (security + prompt + types, sub-15s); non-VPS/CI only
pnpm security        # secret scan (also runs automatically on every commit)
```

`scripts/dev.sh` / `dev.ps1` / `dev-termux.sh` are idempotent launchers:

1. `pnpm install` — only when `node_modules` is missing
2. `pnpm db:generate` — only when the Prisma client is missing
3. Create `.env.local` — only when no env file exists
4. `pnpm db:push` — best effort; skipped on placeholder `DATABASE_URL`,
   failures never block the dev server
5. Start the dev server (`--webpack` on Termux)

## Database Work

Run these only on an authorized **non-VPS** environment or in CI. Never execute
database commands on the VPS. Production migrations remain operator-authorized
and are never automatic.

```bash
pnpm db:migrate      # create + apply a dev migration (non-VPS dev environment)
pnpm db:deploy       # apply committed migrations (CI/shared Neon; operator-authorized for Production)
pnpm db:push         # quick prototype sync (never on shared environments)
pnpm db:seed         # Arabic demo data (idempotent, demo-business-scoped wipe)
pnpm db:studio       # browse data
```

Rules (from `ARCHITECTURE.md`): schema changes go through migrations;
`db push` is for throwaway local schemas only. On Termux, migration engine
binaries can't run — push/deploy from desktop or CI instead.

## Commit Safety

`pnpm run setup` installs the repo-managed git hook (`.githooks/pre-commit`
via `core.hooksPath`). Every commit is checked for:

- env/key/credential **filenames** (`.env*`, `*.pem`, `id_rsa*`, …)
- secret-looking **content** (tokens, private keys, credential URLs)

Bypass (last resort, not recommended): `git commit --no-verify`.
Reinstall after a fresh clone: `pnpm run hooks:install`.

## Quality Gates & Verification Model (DEVOPS-01E)

Authoritative policy: `AGENT_RULES.md` §4. FlowPilot follows a **CI-first
verification strategy**:

- **VPS boundary:** source/text inspection, editing and Git only. Do **not** run package commands, checks, tests, builds or database work on the VPS.
- **CI Ownership:** GitHub Actions (`pr-validation.yml`) executes the full quality gate (`pnpm verify` including production Next.js build) and automated browser UX QA in isolated CI runners.
- **Vercel Ownership:** Vercel builds and deploys Preview environments upon PR updates, and Production releases upon merge to `main`.

## VPS Process Safety

The current approved rule prohibits starting package work on the VPS. If a
stray package process is already running, do **not** start a replacement; stop
it and report it. Never start `next build`, `typecheck`, `eslint`, tests or a
dev server on the VPS.

What each check covers: `QUALITY_CHECKS.md`. Stuck? `TROUBLESHOOTING.md`.
