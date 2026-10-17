# FlowPilot — Agent Rules (Mandatory)

> Binding rules for every AI agent (and human contributor) working on
> FlowPilot. They exist so any agent can continue safely after total
> context loss. Every prompt runs in a FRESH OpenCode/AGY session with NO
> prior conversation memory — recover context through the tier model
> below and read as FEW lines as possible. Token efficiency is a hard
> requirement, not a preference.

## Context Tiers (the reading policy)

**COLD-START RULE:** A fresh Agent session must NOT read the entire repository
or all documentation merely to initialize. It must recover only enough trusted
context to classify the requested work and enforce safety constraints.

**TIER 0 — COLD START (always, every session):**
Read strictly:

1. `docs/AGENT_RULES.md` (this file — safety invariants & loading contract)
2. `docs/CURRENT_STATE.md` (compact baseline & current orientation)
3. `docs/DECISIONS_INDEX.md` (one-line decision router — read INSTEAD of `DECISIONS.md`)

_Tier 0 Purpose:_ Identify repository identity, current baseline, hard safety
rules, available decisions, and context-routing instructions. Nothing else by
default. Avoid automatically loading full historical narratives or large decision
tables. Target total mandatory Tier 0 reading volume below 70 KB where safely
achievable.

**TIER 1 — TASK-SPECIFIC CONTEXT (only when implementation work begins):**
Identify ONE primary task context via `docs/CONTEXT_MAP.md` or
`pnpm context <name>`. Read only the `Current State` summary + `Next Step`
from `docs/BUILD_STATE.md` (never read the entire ledger), plus at most ONE
canonical topic document matching the task:

| Task                       | Document                                                                                                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture / code        | `docs/ARCHITECTURE.md`                                                                                                                                                                                                                                                        |
| Database / schema / repos  | `docs/DATABASE.md`                                                                                                                                                                                                                                                            |
| Product scope              | `docs/SPEC_A.md`                                                                                                                                                                                                                                                              |
| UX                         | `docs/DESIGN_SYSTEM.md`                                                                                                                                                                                                                                                       |
| Economics / cost           | `docs/ECONOMICS.md`                                                                                                                                                                                                                                                           |
| Roadmap / plan sequence    | `docs/ROADMAP.md`                                                                                                                                                                                                                                                             |
| AI / context               | `docs/ai/README.md` (rules) → `docs/ai/ARCHITECTURE.md` (boundary); only the `…@v1` definition being changed in `docs/ai/PROMPTS.md`; `docs/ai/PROVIDERS.md` / `EVALUATIONS.md` only when directly relevant; general boundary also in `docs/ARCHITECTURE.md` + `ECONOMICS.md` |
| Release / deploy / ops     | ONLY the required ops document (`RELEASE_PROCESS.md`, `VERCEL_DEPLOYMENT.md`, `GITHUB_WORKFLOW.md`, `DEVELOPMENT.md`, `QUALITY_CHECKS.md`, `ENVIRONMENT_VARIABLES.md`, `TROUBLESHOOTING.md`)                                                                                  |
| External integration holds | `docs/INTEGRATION_CHECKPOINTS.md` (one entry per external provider whose completion boundary is owned by an outside party — e.g. Meta WhatsApp Embedded Signup DEFERRED/HOLD)                                                                                                 |

Use metadata, headings, and targeted line ranges before opening large documents.

**TIER 2 — DECISION DEEP DIVE (on demand only):**
Load individual entries from `docs/DECISIONS.md` ONLY when:

- The files being changed are directly governed by that decision.
- An architectural constraint is in conflict or ambiguous.
- A requirement contradicts existing documentation.

Never load the entire append-only `DECISIONS.md` log by default.

**TIER 3 — HISTORICAL ARCHIVE (never read automatically):**
Git history, tags, release notes, and `docs/archive/IMPLEMENTATION_HISTORY.md`
are accessed ONLY when:

- Investigating regressions or forensics.
- Resolving historical architectural decisions.
- Recovering relevant past implementation details.

There is NO `DOCS_INDEX.md`, NO `CORE_CONTEXT.md`, NO `CONTEXT_RECOVERY.md`.
Do not recreate them.

## Task-Scoped Source Reading Rules

This is a mandatory workflow rule for every implementation task, not a new
context framework:

### Required Task Workflow

1. **Identify the exact task** and expected behavior.
2. **Select the closest existing context entrypoint** using `pnpm context <name>` or `docs/CONTEXT_MAP.md`.
3. **Inspect repository paths** and narrow search results with targeted tools (`rg -n`, `rg --files`, `git diff`).
4. **Read the primary files** likely to be modified.
5. **Read direct dependencies ONLY** when needed to understand contracts (follow real imports one hop at a time).
6. **Read related tests** and relevant architectural decisions.
7. **Expand scope ONLY** when concrete evidence requires additional files.
8. **Implement the smallest safe change**.
9. **Run focused tests** for changed modules (`pnpm check:<module>`) and lightweight local verification (`pnpm verify:local` or `pnpm verify:fast`). Do NOT automatically run full `pnpm verify` or `next build` after every edit on the VPS.
10. **Report changed files** and scope justification in the final report.

### Prohibited Default Behaviors

- ❌ Reading every source file in the repository.
- ❌ Recursively loading entire directories into context.
- ❌ Reading all documentation on every fresh session.
- ❌ Re-reading large files unnecessarily.
- ❌ Loading unrelated features or context boundaries.
- ❌ Dumping full Git history or large git logs.
- ❌ Running broad repository searches when a precise path is known.
- ❌ Copying large source files into task reports.
- ❌ Automatically expanding every import transitively.
- ❌ Running `next build` or full production `pnpm verify` locally after every edit.
- ❌ Running multiple resource-intensive build/typecheck/lint processes concurrently on the VPS.
- ❌ Repeating an unchanged test suite unnecessarily.
- ❌ Starting local headless browser/Playwright suites or redundant dev servers unless strictly required.

### Allowed Scope Expansion (Exceptions)

This is not a rigid maximum-file-count limit. Agents may read additional files
when justified by:

- Security and authentication boundaries.
- Multi-tenant data isolation (`businessId`).
- Booking correctness and scheduling concurrency invariants.
- Database schema and repository contracts.
- Cross-feature shared APIs and shared TypeScript types.
- Regression investigation.
- Explicitly requested comprehensive audits.

_Requirement:_ When a task expands beyond its initial context entrypoint, provide
a clear scope justification in the task report.

### Preferred Retrieval Techniques

- Use targeted commands: `rg -n`, `rg --files`, `sed -n`, `git diff`, `git log -- <path>`, `wc -c`, `pnpm context <name>`.
- Use bounded outputs (e.g. `head -n`, line ranges) rather than full dumps.
- Do not introduce artificial context budgets that prevent necessary engineering investigation.

## Context Map — Code-Level Entrypoints (DECISIONS #75)

`docs/CONTEXT_MAP.md` provides code-level starting points (`pnpm context <name>`)
for each feature boundary. It tells you which handful of source files, docs, and
focused tests to START from so you do not re-scan `src/`.

The map is a STARTING-POINT INDEX, not a dependency graph and not a second
architecture document. When you add or move a mapped file, update the entry and
run `pnpm context:check`.

## Before Making Any Changes

1. Read the Tier 0 triple (`AGENT_RULES.md` + `CURRENT_STATE.md` + `DECISIONS_INDEX.md`).
2. Follow the loading protocol: Tier 1 by task; Tier 2 only on conflict/decision; Tier 3 only on explicit historical need.
3. Read `docs/BUILD_STATE.md → Current State + Next Step` and do exactly that.
4. Authority order on conflict: latest `DECISIONS.md` entry → `BUILD_STATE.md` → canonical topic docs → derived summaries. The repository code is the implementation truth.

## NEVER

- ❌ Add features outside `SPEC_A.md` / the current accepted scope.
- ❌ Redesign the architecture or stack recorded in `ARCHITECTURE.md` / `DECISIONS.md`.
- ❌ Introduce complexity: no microservices, event buses, queues, Redis, message brokers, global stores, new ORMs, extra API layers, RAG/vector DBs, generic workflow engines.
- ❌ Add infrastructure not approved in `ARCHITECTURE.md` (Vercel + Neon only).
- ❌ Treat AI output as authoritative for availability, provider eligibility, conflicts, or booking (AI interprets; Domain decides and executes; Conversation orchestrates — DECISIONS #33).
- ❌ Add `branchId` to tables outside the selective scoping list, use `User.branchId`, or hard-code "one Business = one WhatsApp number" (DECISIONS #30–#32).
- ❌ Build billing, subscriptions, invoices, payments, or hard-code plan limits in business logic (DECISIONS #36; `ECONOMICS.md`).
- ❌ Modify or delete historical entries in `DECISIONS.md` (append-only; reversals are new entries referencing the old one).
- ❌ Redo or reimplement completed work recorded in `BUILD_STATE.md`.
- ❌ Break RTL/Arabic-first behavior or accessibility guarantees.
- ❌ Commit secrets or real credentials; `.env` stays local (pre-commit hook active).
- ❌ Skip verification: `pnpm verify:local` (or targeted checks + `pnpm verify:fast`) must pass locally before committing or opening a PR. Full `pnpm verify` runs in GitHub Actions CI.
- ❌ Run multiple resource-heavy processes concurrently on the VPS (e.g., simultaneous builds/typechecks/test suites).
- ❌ Recreate duplicate documentation or competing summaries.
- ❌ Commit, tag, push, or run GitHub publishing operations (`pnpm ship`, `pnpm release`) — the human operator owns all shipping/versioning/release actions unless explicitly instructed.
- ❌ Claim a feature or PR is complete before relevant required GitHub Actions CI checks pass.
- ❌ Execute production database migrations automatically from local development.

## ALWAYS

- ✅ Update `BUILD_STATE.md` after every prompt — MINIMALLY: status, completed work (one entry), known issues, next step.
- ✅ Append to `DECISIONS.md` when a decision is made (never overwrite).
- ✅ Create a new document ONLY when a real long-term need exists and no canonical file covers the topic.
- ✅ Preserve strategy: when in conflict, vision > strategy > scope > implementation detail.
- ✅ Keep feature isolation, repository-only DB access, Zod-validated DTOs, server-side tenant scoping.
- ✅ Write Arabic-first, vertical-agnostic UI copy (rules: `DESIGN_SYSTEM.md`; terms: `PRODUCT_GLOSSARY.md`).
- ✅ Report final status honestly — distinguish BUILT code from DOCUMENTED or NOT built.
- ✅ Ask/escalate instead of guessing when scope is ambiguous.

## Prompt Lifecycle Process

1. **Recover** via context tiers: Tier 0 cold start, then task-selective Tier 1.
2. **Inspect the current implementation** before changing anything.
3. **Plan** against `BUILD_STATE.md → Next Step`; produce a concise plan before editing.
4. **Implement** ONLY the current prompt's scope, following `ARCHITECTURE.md` dependency rules.
5. **Verify** with the lightweight gate: targeted domain checks (`pnpm check:<module>`) + `pnpm verify:local` (or `pnpm verify:fast`). Full build is delegated to GitHub Actions CI upon PR push.
6. **Update docs** — `BUILD_STATE.md` always (minimal); `DECISIONS.md` when a decision was made.
7. **Report honestly** and leave the repository ready for the next fresh session.

## CI-First PR Workflow & VPS Safety (DEVOPS-01E)

FlowPilot operates on a resource-constrained Linux VPS. Full Next.js production builds and browser testing are owned by GitHub Actions CI and Vercel, not the local VPS.

### During Active Development

- Run targeted checks for touched modules (e.g. `pnpm check:booking-ux`, `pnpm check:eligibility`).
- Run lightweight local verification (`pnpm verify:local` or `pnpm verify:fast`).
- **Do NOT** automatically run `next build` or full production `pnpm verify` after every edit.
- **Do NOT** repeat unchanged test suites unnecessarily.
- **Do NOT** run multiple resource-intensive verification processes concurrently.

### Before Creating or Updating a PR

- Ensure targeted checks pass locally.
- Validate version increment with `pnpm check:version`.
- Push changes to the feature branch.
- Allow GitHub Actions CI (`pr-validation.yml`) to execute the full quality gate (`pnpm verify` including production build) and Playwright browser UX QA in isolated CI runners.
- **Do NOT** claim a feature is accepted until required CI checks pass.

### For UI/UX Changes

- Use GitHub Actions automated Playwright UX QA and Vercel Preview deployments.
- Review generated screenshots and authenticated workflow artifacts.
- Avoid running local production servers or local browser suites unless strictly necessary.
- Preserve mobile-first Arabic RTL requirements.

### For Database Changes

- Preserve safe migration process: dev migrations locally (`pnpm db:migrate`), never execute production migrations automatically from VPS.
- Note schema changes in the PR; operator applies production migrations via `.github/workflows/production-db-migrate.yml`.

### VPS Resource Inspection Guidelines

When checking VPS load or diagnosing apparent freezes:

- Memory: `free -h` (check `available` memory; note swap is 0B).
- Top memory processes: `ps aux --sort=-%mem | head -n 10`
- Active Node/build processes: `pgrep -af "next|eslint|tsc|playwright|node"`
- Distinguish slow progress from freezes: check if CPU time is advancing (`ps -o pid,stat,time,%cpu,comm -p <PID>` over a 3-5s window). If time ticks up, process is computing, not hung.

## Escalation Path

If a task seems to require something marked ❌ above or outside the accepted scope,
STOP. Record the request as a candidate decision in your response to the human
operator and wait for approval.
