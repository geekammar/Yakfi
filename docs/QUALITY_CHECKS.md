# FlowPilot — Quality Checks

> The binding verification commands, what each covers, and when to run it.
> Encoded from `AGENT_RULES.md`; enforced by scripts in `scripts/`.

## Command Map

| Command               | What it is                                                                                                                                       | When to run                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `pnpm check:services` | Service Catalog + authoring boundary (offline, in-memory): list/create/edit/remove, tenant isolation, duplicate guard, duration-is-operational   | After touching `/services` or the service domain          |
| `pnpm verify`         | Full quality gate: lint → typecheck → format → build (+ summary)                                                                                 | Before finishing ANY work (binding)                       |
| `pnpm run doctor`     | Project health: OS, node, pnpm, git, gh, env, Prisma, DB connection, deps, build readiness → READY / NOT READY                                   | After setup, after env changes, when anything feels off   |
| `pnpm security`       | Secret scan: env-file hygiene, secret quality, secret-shaped content in committable files                                                        | Before pushing; runs automatically pre-commit             |
| `pnpm vercel:check`   | Deployment env validation (4 required vars, per-var fixes)                                                                                       | Before configuring Vercel / part of every deploy          |
| `pnpm deploy:check`   | Pre-deploy gate: env + database + Prisma + auth + demo data + build → READY / NOT READY                                                          | Before every deploy; `-- --fast` skips the build step     |
| `pnpm deploy`         | Full pre-deploy gate → Vercel production deploy → deployment URL                                                                                 | Sharing a demo-able URL with a prospect                   |
| `pnpm ship`           | Lightweight operator release: safety validation → version bump → commit → annotated tag → push → GitHub Release (does NOT re-run the build gate) | Human operator, after a prompt whose `pnpm verify` passed |
| `pnpm lint`           | `eslint .`                                                                                                                                       | While coding (or `lint:fix`)                              |
| `pnpm typecheck`      | `tsc --noEmit`                                                                                                                                   | While coding                                              |
| `pnpm format:check`   | `prettier --check .`                                                                                                                             | Before verify (or run `pnpm format`)                      |

> `pnpm run doctor` (not `pnpm doctor`) — the latter is pnpm's built-in.

## verify — the gate

`scripts/verify.mjs` runs, in order, stopping at the first failure with a
summary table (step, pass/fail, duration, exit code):

1. **lint** — `eslint .`
2. **typecheck** — `tsc --noEmit` (strict TS incl. `noUncheckedIndexedAccess`)
3. **format** — `prettier --check .`
4. **build** — `next build` (`--webpack` automatically on Termux, where
   Turbopack has no Android bindings)

Exit code is non-zero if any step fails — CI-friendly.

## doctor — health verification

`scripts/doctor.mjs` is read-only and prints `READY ✅` or `NOT READY ❌`
with an actionable `→ fix:` for every failing check:

| Check                | Blocks? | Notes                                                                                                                                 |
| -------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| os                   | yes     | Windows / macOS / Linux / Termux(Android) supported; Termux notes webpack mode                                                        |
| node                 | yes     | ≥ 20 required                                                                                                                         |
| pnpm                 | yes     | any working install (project pins 11.24.0)                                                                                            |
| git                  | yes     | required                                                                                                                              |
| gh                   | no      | optional — GitHub workflows only                                                                                                      |
| env file             | yes     | `.env.local` preferred, `.env` honored                                                                                                |
| `DATABASE_URL`       | yes     | placeholder detection (`user:password@`, `replace-with`, …)                                                                           |
| `BETTER_AUTH_SECRET` | yes     | ≥ 32 chars, not placeholder                                                                                                           |
| app URLs             | no      | `BETTER_AUTH_URL`, `NEXT_PUBLIC_APP_URL`                                                                                              |
| dependencies         | yes     | `node_modules` + key packages present                                                                                                 |
| prisma               | yes     | `schema.prisma` + generated client (`src/generated/prisma`)                                                                           |
| database             | yes     | real `SELECT 1` over the configured URL (8s timeout); errors classified (DNS / timeout / auth / db-missing / TLS) with targeted fixes |
| build readiness      | yes     | required CLI bins + generated client; secrets never printed                                                                           |

## security — secret scanning

`scripts/security-check.mjs` (`--staged` mode is used by the pre-commit hook):

1. **Env-file hygiene** — `.env` / `.env.local` must be gitignored and
   untracked; both existing at once warns.
2. **Secret quality** — placeholder/short `BETTER_AUTH_SECRET` is a finding.
3. **Content scan** over committable files (tracked + untracked, or staged in
   hook mode) for well-known shapes: PEM private keys, AWS `AKIA…`, GitHub
   `ghp_/github_pat_…`, Stripe `sk_live_…`, `sk-…` API keys, Slack `xox…`,
   Google `AIza…`, credential URLs (`postgres://user:pass@…`), and keyword
   assignments (`password|secret|token|api_key… = "…"`).
   Placeholders (`replace-with`, `your-`, `${VAR}`, `<...>`) and
   `.env.example` / `pnpm-lock.yaml` are exempt.
4. **Forbidden filenames** — `.env*` (except `.env.example`), `*.pem/.p12/.pfx`,
   `id_rsa*`-style keys, service-account/credentials JSON.

Findings print `file:line`, the kind, and the key name — **never the value**.
Exit 1 on any error.

## Pre-commit safety

`.githooks/pre-commit` (installed by `pnpm run setup` / `hooks:install` via
`git config core.hooksPath .githooks`):

1. Filename gate in pure sh — blocks env/key/credential filenames even when
   node is unavailable.
2. Content scan — `node scripts/security-check.mjs --staged`.

Intentional override: `git commit --no-verify` (discouraged; rotate anything
that slips through).

## CI Notes

No CI pipeline exists yet (deliberate — see `DECISIONS.md` #18). When one is
approved, the gate is simply:

```sh
pnpm install --frozen-lockfile
pnpm db:generate
pnpm verify
```
