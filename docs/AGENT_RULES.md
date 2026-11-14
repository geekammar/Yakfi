# FlowPilot — Agent Rules (Mandatory)

> Binding rules for every AI agent and human contributor. Every prompt runs in a
> FRESH session with no prior memory: recover through the tier model below.
> This file is the authoritative rules source; other guides reference it with
> short links. Last updated: 14 November 2026 (documentation maintenance).
>
> **Soft target:** the three Tier 0 files (`AGENT_RULES.md` +
> `CURRENT_STATE.md` + `DECISIONS_INDEX.md`) stay at or below about 30 KB
> combined. Safety, correctness and recoverability take precedence over size.

## 1. Context tiers (the reading policy)

**COLD-START RULE:** never read the repository or all documentation merely to
initialize. Recover only enough trusted context to classify the work and
enforce safety constraints.

**Tier 0 — every session (read only these three):**

1. `docs/AGENT_RULES.md` — this file: invariants, verification policy, routing.
2. `docs/CURRENT_STATE.md` — dated baseline, candidate/Production separation,
   blockers, next action.
3. `docs/DECISIONS_INDEX.md` — decision router; read this instead of the full
   `docs/DECISIONS.md` ledger.

**Tier 1 — task-specific (when work begins):**

- Select ONE relevant entry in `docs/CONTEXT_MAP.md` and read only the mapped
  docs/code/tests needed for the symptom. The map is a menu of starting
  points, not a command to read every listed file.
- Read the task's canonical contract (one topic document or section), as
  needed.
- Read only `Current State` and `Next Step` from `docs/BUILD_STATE.md`; never
  read the entire ledger.
- **Canonical contract by task (choose one):** architecture/code →
  `ARCHITECTURE.md`; DB/schema/repos → `DATABASE.md`; product scope →
  `SPEC_A.md`; UX → `DESIGN_SYSTEM.md`; economics → `ECONOMICS.md`; AI →
  `docs/ai/README.md` + `docs/ai/ARCHITECTURE.md`; release/ops → the required
  `RELEASE_PROCESS.md`, `VERCEL_DEPLOYMENT.md`, `GITHUB_WORKFLOW.md`,
  `DEVELOPMENT.md`, `QUALITY_CHECKS.md`, `ENVIRONMENT_VARIABLES.md` or
  `TROUBLESHOOTING.md`; external holds → `INTEGRATION_CHECKPOINTS.md`.

**Tier 2 — decision deep dive (on demand):** load an individual entry from
`docs/DECISIONS.md` by ID or heading only when the changed files are governed
by it, an architectural constraint is ambiguous/conflicting, or a requirement
contradicts documentation. Add dependency contracts and source context only
when concrete evidence requires them.

**Tier 3 — historical archive (never automatic):** Git history, tags, release
notes and `docs/archive/IMPLEMENTATION_HISTORY.md` are for regressions,
forensics, or recovering past implementation details.

There is **no** `DOCS_INDEX.md`, `CORE_CONTEXT.md` or `CONTEXT_RECOVERY.md`.
Do not recreate them. Do not create a second documentation framework,
retrieval service, graph or index generator.

## 2. Task-scoped source reading

1. Identify the exact symptom, contract and expected behavior.
2. Select ONE relevant `docs/CONTEXT_MAP.md` entry.
3. Locate the relevant symbol with scoped searches (`rg -n`, `rg --files`,
   `git diff`).
4. Read the affected function/component plus the relevant callers, types,
   repository contracts and tests needed to make a safe change.
5. Follow real dependencies one hop at a time when needed.
6. Before expanding, state briefly which contract is missing and why the extra
   file or section is necessary.
7. Reuse unchanged context instead of rereading it.

No arbitrary file-count cap applies; do not skip security analysis. Auth,
tenant, isolation, idempotency, concurrency, booking or shared-schema changes
require the affected callers and invariants.

**Prohibited:** whole-repository source dumps; recursive `cat`; automatic
all-history reading; automatic traversal of every transitive import; rereading
unchanged files without a reason; dumping large source or history into reports.

**Example — staff-delivery bug:** start with the delivery contract and the
exact failing route/submission path, then the relevant callers and tests. Do
not begin by loading every conversation, provider and booking source file.

## 3. Hard project invariants

- **No free-text intent matching:** no keywords, dictionaries, regex or
  substring matching to interpret free-text user intent. Formal protocol, ID
  and schema validation remains allowed.
- **One conversation engine and booking authority.** AI interprets; Domain
  decides and executes; Conversation orchestrates. Never add a second
  availability engine, planner or conversation state machine.
- **Tenant isolation and server-side authorization.** UI visibility is not
  authorization. Never trust client-provided tenant identity. Keep feature
  isolation, repository-only DB access and Zod-validated DTOs.
- **Selective branch scoping.** Never add `branchId` everywhere, never use
  `User.branchId`, and never hard-code "one Business = one WhatsApp number".
- **No secret values** in documents, logs, PRs or reports. Real credentials
  stay in local `.env*`, Vercel environment variables or the provider console.
- **No automatic merge, deploy or Production migration.** Production
  migrations are operator-authorized through the existing workflow.
- **Executor and tester reports require reviewer verification.** Ammar and the
  reviewer decide acceptance and merge; an agent report is evidence, not
  acceptance.
- **Preserve R5 evidence and historical QA outcomes.** Keep historical FAIL
  executions (for example QA249/QA250) and accepted results visible; do not
  rewrite or erase history to make a status look cleaner.
- **Preserve existing user work and unrelated documentation.**
- **`docs/DECISIONS.md` is append-only.** Never rewrite or delete historical
  entries; reversals are new entries referencing the old one.
- **No duplicate documentation or competing summaries.** Extend the existing
  canonical files instead. Create a new document only when a real long-term
  need exists and no canonical file covers the topic. On strategy conflict:
  vision > strategy > scope > implementation detail.
- **Stay inside accepted Spec A scope and the recorded stack** (Next.js 16 +
  Prisma 7 + Neon PostgreSQL + Vercel). No microservices, queues, Redis,
  message brokers, extra ORMs, RAG/vector stores or generic workflow engines.
  Billing, subscriptions, invoices and payments remain deferred.
- **Arabic-first, RTL-by-default** (`dir="rtl" lang="ar"`), accessible UI copy.
- **The repository code is implementation truth.** Docs do not override code;
  state honestly whether work is BUILT, DOCUMENTED or NOT built.

## 4. Verification, CI and VPS execution boundary

**Current approved rule (supersedes conflicting historical guidance):** on the
VPS, perform **source/text inspection, editing and Git only**. Do **not**
execute package installation, code generation, app runtime/dev server,
formatter, lint, typecheck, tests, builds, or database commands on the VPS; do
not invoke any package script (`pnpm *`, `next`, `tsx`) there. Reading source
and tests is allowed; executing package scripts is not.

- **Required checks:** run in existing GitHub Actions CI (`pr-validation.yml`)
  or an authorized isolated cloud runner. The full gate is `pnpm verify`
  (lint, typecheck, format, production build) plus Playwright UX QA. Vercel
  owns Preview/Production builds.
- **CI-first:** push the branch/PR and let the existing gate run. Do not claim
  completion before required CI checks pass. Report `PASS` / `FAIL` /
  `BLOCKED` / `NOT RUN`; never claim an unexecuted check passed.
- **Documentation-only changes:** same VPS boundary; run docs/format checks in
  existing CI or an authorized cloud runner.
- **Database:** do not execute database commands on the VPS. Development
  database work belongs in an authorized non-VPS environment or CI. Production
  migrations are operator-authorized via
  `.github/workflows/production-db-migrate.yml` and are never automatic.
- **Version gate:** the current mandatory `pnpm check:version`
  (`scripts/check-pr-version.mjs`) requires a strictly greater version and has
  **no docs-only exemption**. A documentation PR must follow the actual gate
  (carry the required version metadata increment) or obtain an explicit
  reviewed scope decision; do not document an unconditional rule that forbids
  the increment while requiring this gate to pass. PR81 is documentation
  maintenance plus the required `0.79.7 → 0.79.8` metadata increment. Do not
  bypass, disable or falsely mark the gate.
- **Historical guidance:** older DEVOPS-01E VPS-local check text is archived as
  dated evidence only; it is **not** an operative permission and does not
  override this section.

## 5. Change lifecycle

1. **Recover:** Tier 0, then one task context and the canonical contract.
2. **Inspect:** read the current implementation before changing anything.
3. **Plan:** align with `BUILD_STATE.md → Current State + Next Step` or the
   approved task contract; produce a concise plan.
4. **Implement:** the smallest safe change, only within the current scope.
5. **Verify:** run required checks in existing CI or an authorized isolated
   cloud runner. Do not execute package commands on the VPS. Do not claim
   completion before required CI checks pass.
6. **Document:** update `BUILD_STATE.md` minimally (status, completed work,
   known issues, next step); append to `DECISIONS.md` when a decision is made.
7. **Report honestly** and leave the repository ready for the next fresh
   session.

**Never:** add unapproved features or infrastructure; redesign the recorded
architecture; redo completed work; commit secrets; commit/tag/push/release
unless explicitly instructed; skip required CI verification; execute
Production migrations automatically; recreate removed documentation files.

## 6. Authority order and escalation

On product/documentation conflict: latest `DECISIONS.md` entry →
`BUILD_STATE.md` → canonical topic docs → derived summaries. The repository
code remains implementation truth. For **current operational permissions**, this
file's approved VPS boundary overrides older guides and historical text; old
docs are evidence, not active permissions. Do not let the old authority chain
silently reactivate obsolete VPS execution.

If a task requires something marked prohibited, a scope change, a
contradictory product interpretation or an unverified live action: **STOP**.
Record the blocker or candidate decision in the response and wait for the
reviewer/operator. Do not guess.
