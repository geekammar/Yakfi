# FlowPilot

A WhatsApp Appointment Conversion System. Book more, chase less.

**Current stage:** Local Vertical Discovery Strategy — the same generic booking
engine is being tested across multiple appointment-based businesses (dental,
beauty, coaching, gyms, education, services) before selecting a winning
vertical. **The UI and domain model stay completely vertical-agnostic.**

> 📚 **Project memory / source of truth:** start with
> [`docs/CURRENT_STATE.md`](docs/CURRENT_STATE.md) and
> [`docs/AGENT_RULES.md`](docs/AGENT_RULES.md) (the full context-tier
> reading policy lives there) before making any change.

---

## Tech Stack

| Layer     | Choice                         |
| --------- | ------------------------------ |
| Framework | Next.js (App Router) + React   |
| Language  | TypeScript (strict)            |
| Styling   | Tailwind CSS v4                |
| UI        | shadcn/ui + Lucide icons       |
| State     | TanStack Query                 |
| Forms     | React Hook Form + Zod          |
| Auth      | Better Auth                    |
| Database  | PostgreSQL (Neon)              |
| ORM       | Prisma (driver-adapter client) |
| Charts    | Recharts                       |
| Deploy    | Vercel                         |
| Pkg mgr   | pnpm                           |

Deployment guide: `docs/VERCEL_DEPLOYMENT.md` (Section 0 = quick path
under 5 minutes) · Environment variables:
`docs/ENVIRONMENT_VARIABLES.md` · Demo package for prospects:
`docs/CLIENT_DEMO.md` · Liveness/readiness probe: `/api/health`.

## Getting Started

One-time bootstrap per platform (verifies node/pnpm/git/gh, installs only what
is missing, then sets up the project):

```bash
bash scripts/bootstrap.sh                  # macOS / Linux
powershell -ExecutionPolicy Bypass -File scripts\bootstrap.ps1   # Windows
bash scripts/bootstrap-termux.sh           # Termux (Android)
```

Then set `DATABASE_URL` in `.env.local` (created automatically with a random
auth secret) and start development:

```bash
bash scripts/dev.sh                        # or dev.ps1 / dev-termux.sh
```

Prefer the manual path? Equivalent commands:

```bash
pnpm run setup       # env file (safe, never overwrites) + install + prisma generate
pnpm run doctor      # environment diagnostics
pnpm dev             # http://localhost:3000 (use --webpack on Termux)
```

Full platform guide: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

### Environment variables

See `.env.example`:

| Variable              | Purpose                                 |
| --------------------- | --------------------------------------- |
| `DATABASE_URL`        | Neon PostgreSQL connection string       |
| `BETTER_AUTH_SECRET`  | Auth signing secret (min 32 chars)      |
| `BETTER_AUTH_URL`     | Base URL used by Better Auth            |
| `NEXT_PUBLIC_APP_URL` | Public app URL (also used for metadata) |

All server env vars are validated at runtime with Zod in `src/lib/env.ts` —
the app fails fast with a readable message if anything is missing. Env files
(`.env*`) are gitignored; `.env.local` takes precedence over `.env` in the dev
server, Prisma CLI, and seed script alike.

## Scripts

| Command                  | Description                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `pnpm run setup`         | Create `.env.local` (safe) + install deps + generate Prisma client + install git hooks   |
| `pnpm run doctor`        | Project health check → READY / NOT READY with fixes                                      |
| `pnpm verify`            | Full quality gate: lint + typecheck + format + build (Termux-aware)                      |
| `pnpm security`          | Secret scan (env files, keys, tokens, credentials)                                       |
| `pnpm release`           | Gated release: doctor+verify+security → commit → tag → GitHub repo/release               |
| `pnpm vercel:check`      | Deployment environment validation (4 required variables, clear fixes)                    |
| `pnpm deploy:check`      | Pre-deploy gate: env + database + Prisma + auth + demo data + build → READY / NOT READY  |
| `pnpm deploy`            | Full gate → Vercel **production** deploy → prints the shareable deployment URL           |
| `pnpm deploy:production` | Same as `pnpm deploy` (explicit alias)                                                   |
| `pnpm deploy:preview`    | Full gate → Vercel preview deploy → URL (internal checks; auth may not work on previews) |
| `pnpm deploy:vercel`     | Legacy alias for `pnpm deploy:production`                                                |
| `pnpm run hooks:install` | Install the pre-commit safety hook                                                       |
| `pnpm dev`               | Dev server (Turbopack; `--webpack` on Termux)                                            |
| `pnpm build`             | Production build                                                                         |
| `pnpm lint`              | ESLint                                                                                   |
| `pnpm lint:fix`          | ESLint with autofix                                                                      |
| `pnpm format`            | Prettier write                                                                           |
| `pnpm format:check`      | Prettier check (CI-friendly)                                                             |
| `pnpm typecheck`         | `tsc --noEmit`                                                                           |
| `pnpm db:generate`       | Generate Prisma client                                                                   |
| `pnpm db:migrate`        | Create/apply a dev migration                                                             |
| `pnpm db:deploy`         | Apply migrations (prod/CI)                                                               |
| `pnpm db:push`           | Push schema without migration                                                            |
| `pnpm db:studio`         | Prisma Studio                                                                            |
| `pnpm db:seed`           | Seed the Arabic demo dataset (Egyptian dental clinic — see docs/DEMO_GUIDE.md)           |
| `pnpm icons`             | Regenerate PWA PNG icons                                                                 |

> `setup` and `doctor` require `pnpm run …` — without `run` they collide with
> pnpm's built-in commands of the same name.

## Architecture

Feature-based modular monolith:

```
src/
├── app/                    # Routing layer only (thin)
│   ├── (auth)/             #   sign-in / sign-up / invite activation — public
│   ├── (app)/              #   authenticated app shell
│   ├── (onboarding)/       #   onboarding wizard (ADMIN-only)
│   ├── (admin)/            #   admin area (requireRole ADMIN)
│   ├── (staff)/            #   staff workspace (requireRole STAFF)
│   ├── api/auth/[...all]/  #   Better Auth route handler
│   ├── api/health/         #   dependency-free liveness probe
│   ├── api/conversations/inbound/  # provider-neutral inbound webhook
│   ├── error.tsx           #   route error boundary
│   ├── global-error.tsx    #   root error boundary
│   ├── not-found.tsx
│   └── manifest.ts         #   PWA web app manifest
├── features/               # Domain modules — isolated from each other
│   ├── auth/               #   sessions, sign-in/out flows
│   ├── onboarding/         #   first-run setup (vertical-agnostic)
│   ├── dashboard/          #   admin overview
│   ├── services/           #   bookable service catalog
│   ├── appointments/       #   booking lifecycle + Smart Create
│   ├── conversations/      #   threads + conversation engine
│   ├── customers/          #   customer directory & history
│   ├── staff/              #   team management + staff workspace
│   ├── invitations/        #   invitation lifecycle
│   ├── knowledge/          #   business FAQ entries
│   └── settings/           #   business settings
├── components/
│   ├── ui/                 # shadcn/ui primitives
│   └── shared/             # cross-feature components (providers, etc.)
├── hooks/                  # cross-feature client hooks
├── lib/                    # framework-agnostic utilities (env, auth, utils)
├── server/                 # server-only layer (db client singleton + repositories)
└── types/                  # small shared type contracts
```

## Development Guidelines

1. **Routes are thin.** `src/app` files render feature components; no business
   logic in route files.
2. **Features are isolated.** A feature may import from `@/components/ui`,
   `@/lib/*`, `@/server/*`, `@/types`, and itself — never from another
   feature. Cross-feature composition happens at the route layer.
3. **No circular dependencies.** If two features share logic, promote it to
   `@/lib` or `@/server` deliberately.
4. **No giant shared files.** Prefer many small, single-purpose modules over
   shared barrels and mega-utils.
5. **Strong typing everywhere.** Strict TS is on (`noUncheckedIndexedAccess`,
   `noUnusedLocals`, …). Validate inputs with Zod at the boundary; infer
   types from schemas instead of hand-writing duplicates.
6. **Server layer is reusable.** DB access goes through the `db` singleton
   (`src/server/db`). Never construct ad-hoc clients.
7. **UI is reusable and generic.** Build on shadcn/ui primitives; keep all
   copy free of vertical-specific terminology (this is a hard product rule
   during vertical discovery).
8. **Quality gates before pushing:**
   ```bash
   pnpm lint && pnpm typecheck && pnpm format:check && pnpm build
   ```
9. **Imports are auto-sorted** by Prettier (`@ianvs/prettier-plugin-sort-imports`)
   with Tailwind class sorting enabled.

## Notes

- Demo: realistic Arabic dataset with demo logins — `docs/DEMO_GUIDE.md`
  (setup, scenarios) and `docs/DEMO_SCRIPT.md` (5-minute sales walkthrough).
  Client-facing demo package (URL + credentials + what to show):
  `docs/CLIENT_DEMO.md`. Set `DEMO_MODE=true` in `.env.local` to auto-seed on
  dev launch **and** before every deploy (`pnpm deploy` runs it as part of its
  gate, so deployed demos are never empty).
- Database layer (schema, validation, repositories, seed): see
  [docs/DATABASE.md](docs/DATABASE.md).
- This project uses the current Next.js release (16.x), which differs from
  Next.js 13–15 habits: request APIs (`cookies()`, `params`, `searchParams`)
  are async, `middleware.ts` is replaced by `proxy.ts`, and error boundaries
  receive `{ error, retry }`. See `node_modules/next/dist/docs/`.
- Prisma client is generated to `src/generated/prisma` (gitignored) and uses
  the `pg` driver adapter for Neon compatibility.
