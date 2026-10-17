# FlowPilot — GitHub Workflow

> How the FlowPilot repository is structured and used on GitHub during the
> discovery stage. Keep it boring: one private repo, one branch, tags as
> releases.

## Repository

| Setting     | Value                                                           |
| ----------- | --------------------------------------------------------------- |
| Name        | `flowpilot` (under the operator's GitHub account)               |
| Visibility  | **Private** (pilot businesses + strategy are confidential)      |
| Remote      | `origin`                                                        |
| Branch      | `main` (single-branch model while solo + agent-driven)          |
| Description | WhatsApp Appointment Conversion System — book more, chase less. |

## GitHub Actions & CI Status (DEVOPS-01D/E)

- **PR Validation & UX QA (`pr-validation.yml`):** Runs on every PR targeting `main`.
  Executes security scan, AI prompt contract, full `pnpm verify` (lint, typecheck, format,
  Next.js production build), release guard verification, SemVer version increment check,
  database schema change detection, domain regression checks, and automated Playwright browser UX QA.
- **Production Release & Cutover (`production-release.yml`):** Runs on push to `main` (merge).
  Verifies Vercel production deployment health (`GET /api/health`), validates production commit SHA,
  and publishes an immutable GitHub Release with the corresponding version tag.
- **Manual Production DB Migration (`production-db-migrate.yml`):** Dedicated operator-dispatched
  workflow (`workflow_dispatch`) targeting specified branch/commit for Neon production database migrations.

## Branch & PR Model (Mobile-First Developer Experience)

FlowPilot uses a GitHub PR-based workflow optimized for lightweight VPS development:

1. **Development on VPS:** Agent or operator writes code on a feature branch (`feat/*`, `fix/*`, `chore/*`).
2. **Lightweight Local Check:** Run `pnpm verify:local` (or `pnpm verify:fast`). Do **not** run full production builds locally.
3. **Version Bump:** Increment SemVer via `pnpm version:bump patch` (or `minor`) before pushing.
4. **Push & PR:** Push to origin and open a PR via `gh pr create`.
5. **CI & Vercel Preview:** GitHub Actions runs complete quality gates and Playwright suites; Vercel deploys preview.
6. **Operator Review & Merge:** Operator reviews PR summary and preview on mobile phone, then merges to `main`.
7. **Automated Production Release:** `production-release.yml` monitors cutover and tags release automatically.

## Shipping vs. Deployment vs. Migrations

- **`pnpm ship`:** Commits the inspected working tree candidate, tags the release,
  pushes `main` and the tag to GitHub, and publishes a GitHub Release. It does
  **NOT** deploy to Vercel and does **NOT** run database migrations.
- **Vercel Production Deployment:** Operator-owned action. Do not assume Vercel
  Git auto-deployment is active; verify and promote via Vercel dashboard or
  `pnpm deploy:production`.
- **Production Migrations:** Separately authorized and executed by the operator,
  either via the manual GitHub Action (`workflow_dispatch`) or `pnpm db:deploy`.

## When collaboration starts (future)

When a second human/agent with a GitHub account joins, revisit (requires a
`DECISIONS.md` entry):

1. Branch protection on `main` (require PR, at least one review)
2. Feature branches (`feat/<prompt>` → PR → `main`)
3. CI running `pnpm install --frozen-lockfile && pnpm db:generate && pnpm verify`
   (the encoded gate from `QUALITY_CHECKS.md`)
4. `CODEOWNERS`, issue templates — only if the team grows

## Secrets on GitHub (rules)

- Real credentials live ONLY in: local `.env.local`, Vercel project env vars,
  and the Neon console — never in the repo, issues, PRs, or releases.
- Vercel + Neon access is managed in their consoles; grant per-person, never
  share accounts.
- If a secret ever lands in git: rotate first, clean history second
  (`TROUBLESHOOTING.md` → Git & Security).

## Release Artifacts on GitHub

Each release (`gh release`) contains: the tag, title `FlowPilot <tag>`, and
notes summarizing included product surface + known placeholders. No binaries
are attached — the repo is the artifact. See `RELEASE_PROCESS.md`.
