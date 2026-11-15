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

> Verification policy authority: `AGENT_RULES.md` §4. The full gate runs in
> CI, never on the VPS.

- **PR Validation & UX QA (`pr-validation.yml`):** Runs on every PR targeting `main`.
  Executes security scan, AI prompt contract, full `pnpm verify` (lint, typecheck, format,
  Next.js production build), release guard verification, SemVer version increment check,
  database schema change detection, domain regression checks, and automated Playwright browser UX QA.
- **Production Release & Cutover (`production-release.yml`):** Runs on push to `main` (merge).
  Verifies Vercel production deployment health (`GET /api/health`), validates production commit SHA,
  and publishes an immutable GitHub Release with the corresponding version tag.
- **Manual Production DB Migration (`production-db-migrate.yml`):** Dedicated operator-dispatched
  workflow (`workflow_dispatch`) targeting specified branch/commit for Neon production database migrations.
  It now requires `expected_db_host` and `expected_commit_sha`, refuses a mismatched target, and rejects
  the legacy Production hosts in apply mode.
- **Production runtime environment cutover (`test-db-migrate.yml` / `configure-production-runtime-env`):**
  One-shot exact-SHA operation that updates only Production `DATABASE_URL` and `CREDENTIAL_MASTER_KEY`
  from existing Actions secrets. It never touches auth, AI or channel settings.
- **Single runtime and CI isolation:** branches/PRs remain the development process; Production is the
  normal live-test destination and Preview is optional. Automatic PR migration validation uses a
  disposable PostgreSQL service and must never mutate the selected runtime database. Runtime migrations
  remain explicit, target-verified operator actions.

## Branch & PR Model (Mobile-First Developer Experience)

FlowPilot uses a GitHub PR-based workflow. The VPS is for source/text
inspection, editing and Git only; all verification runs in CI:

1. **Development on VPS:** Agent or operator writes code on a feature branch (`feat/*`, `fix/*`, `chore/*`).
2. **Required Checks:** Do **not** run package commands on the VPS. Verification is CI-owned; push the branch and open the PR in step 4. If an authorized isolated cloud runner is provided, run the lightweight gate there, never on the VPS.
3. **Version Gate:** The current mandatory `pnpm check:version` requires a strictly greater version and has no docs-only exemption. A documentation PR must follow the actual gate (carry the required version metadata increment) or obtain an explicit reviewed scope decision; do not document an unconditional rule that forbids the increment while requiring this gate to pass. PR81 carries `0.79.7 → 0.79.8` under this rule. Do not bypass, disable or falsely mark the gate.
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
  `pnpm deploy:production` in an authorized non-VPS environment.
- **Production Migrations:** Separately authorized and executed by the operator
  via the manual GitHub Action (`workflow_dispatch`) or `pnpm db:deploy` in an
  authorized non-VPS environment; never on the VPS.

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
