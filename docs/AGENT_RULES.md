# FlowPilot — Agent Rules (Mandatory)

> Binding rules for every AI agent (and human contributor) working on
> FlowPilot. They exist so any agent can continue safely after total
> context loss. Every prompt runs in a FRESH OpenCode session with NO
> prior conversation memory — recover context through the tier model
> below and read as FEW lines as possible. Token efficiency is a hard
> requirement, not a preference. Last updated: DOC-NORMALIZE-V029
> (DECISIONS #57).

## Context Tiers (the reading policy)

**TIER 0 — COLD START (always, every session):** read `docs/AGENT_RULES.md`
(this file) + `docs/CURRENT_STATE.md` + `docs/DECISIONS_INDEX.md` (the
one-line decision routing index — read it INSTEAD of the full `DECISIONS.md`).
Purpose: identify what FlowPilot is, the current strategic/architectural state,
the hard rules, which decisions exist, and where to continue. Nothing else by
default.

**TIER 1 — IMPLEMENTATION ROUTING (only when implementation work
begins):** read `docs/BUILD_STATE.md` (the authoritative implementation
ledger — `Current State` summary + `Next Step`, not the full history)
plus ONE canonical topic document matching the task:

| Task                      | Document                                                                                                                                                                                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture / code       | `docs/ARCHITECTURE.md`                                                                                                                                                                                                                                                        |
| Database / schema / repos | `docs/DATABASE.md`                                                                                                                                                                                                                                                            |
| Product scope             | `docs/SPEC_A.md`                                                                                                                                                                                                                                                              |
| UX                        | `docs/DESIGN_SYSTEM.md`                                                                                                                                                                                                                                                       |
| Economics / cost          | `docs/ECONOMICS.md`                                                                                                                                                                                                                                                           |
| Roadmap / plan sequence   | `docs/ROADMAP.md`                                                                                                                                                                                                                                                             |
| AI / context              | `docs/ai/README.md` (rules) → `docs/ai/ARCHITECTURE.md` (boundary); only the `…@v1` definition being changed in `docs/ai/PROMPTS.md`; `docs/ai/PROVIDERS.md` / `EVALUATIONS.md` only when directly relevant; general boundary also in `docs/ARCHITECTURE.md` + `ECONOMICS.md` |
| Release / deploy / ops    | ONLY the required ops document (`RELEASE_PROCESS.md`, `VERCEL_DEPLOYMENT.md`, `GITHUB_WORKFLOW.md`, `DEVELOPMENT.md`, `QUALITY_CHECKS.md`, `ENVIRONMENT_VARIABLES.md`, `TROUBLESHOOTING.md`)                                                                                  |

**TIER 2 — DECISION DEEP DIVE (only when a current decision is
involved, an architectural conflict is found, or the topic cannot be
resolved from Tier 0 + Tier 1):** the specific `docs/DECISIONS.md` entry
identified by `docs/DECISIONS_INDEX.md` (append-only authority) plus the
relevant canonical topic document. Never read the whole log.

**TIER 3 — HISTORICAL (never read automatically):** Git history, tags,
release notes, and `docs/archive/IMPLEMENTATION_HISTORY.md` (the superseded
per-slice implementation + verification narrative) — only when historical
implementation detail, forensics, or migration reasoning is explicitly
required.

There is NO `DOCS_INDEX.md`, NO `CORE_CONTEXT.md`, NO
`CONTEXT_RECOVERY.md` — do not recreate them; this tier model IS the
navigation layer. `DECISIONS_INDEX.md` is the ONE exception: a narrow
decision-routing index re-introduced by DECISIONS #57 to keep the cold start
cheap. Never read all memory documents in a session.

## How Agents Read the Docs (the loading protocol)

The objective is **minimal sufficient context, not maximal context.** Follow
these steps in order and stop as soon as the task is actionable:

- **STEP 1 — orient:** read the Tier 0 triple — `AGENT_RULES.md` +
  `CURRENT_STATE.md` + `DECISIONS_INDEX.md`. Nothing else.
- **STEP 2 — route to the ledger:** read `docs/BUILD_STATE.md` (the
  `Current State` summary + `Next Step` only, not the reference tables).
- **STEP 3 — load ONLY task-specific canonical docs:** pick at most ONE
  canonical topic document matching the task (the Tier 1 table below).
- **STEP 4 — go deep only on real need:** load a full `DECISIONS.md` entry,
  deep architecture docs, or Tier 3 history ONLY if the task actually requires
  it (a decision is being changed, documents conflict, or historical
  comparison is needed).

**NEVER (context discipline):**

- ❌ Load all documentation by default, or "to be safe".
- ❌ Read duplicate continuity snapshots or the Tier 3 archive at cold start.
- ❌ Read historical prompts / old release narratives as current state.
- ❌ Re-read the entire `DECISIONS.md` when `DECISIONS_INDEX.md` answers the
  question.
- ❌ Treat a `Last updated: PROMPT-*` marker or an old release narrative as
  truth — the repository is the truth; a stale doc never overrides the code.

## Before Making Any Changes

1. Read the Tier 0 triple above (`AGENT_RULES.md` + `CURRENT_STATE.md` +
   `DECISIONS_INDEX.md`). That is the complete cold-start set.
2. Follow the loading protocol ("How Agents Read the Docs"): Tier 1 by task;
   Tier 2 only on conflict/decision; Tier 3 only on explicit historical need.
3. Read `docs/BUILD_STATE.md → Current State + Next Step` and do exactly that.
   Never rebuild completed work recorded there.
4. If documents conflict, authority order is: latest `DECISIONS.md`
   entry → `BUILD_STATE.md` → canonical topic docs → derived
   summaries. If a conflict is unclear, escalate instead of guessing.
   The repository itself is the implementation truth — never trust a
   stale doc over the code.

## NEVER

- ❌ Add features outside `SPEC_A.md` / the current accepted scope (log
  requests as Spec B evidence instead of building them)
- ❌ Redesign the architecture or stack recorded in `ARCHITECTURE.md` /
  `DECISIONS.md`
- ❌ Introduce complexity: no microservices, event buses, queues, Redis,
  message brokers, global stores, new ORMs, extra API layers, RAG/vector
  DBs, generic workflow engines, omnichannel infrastructure
- ❌ Add infrastructure not approved in `ARCHITECTURE.md` (Vercel + Neon
  only)
- ❌ Treat AI output as authoritative for availability, provider
  eligibility, conflicts, or booking (AI interprets; Domain decides and
  executes; Conversation orchestrates — DECISIONS #33)
- ❌ Add `branchId` to tables outside the selective scoping list, use
  `User.branchId`, or hard-code "one Business = one WhatsApp number"
  (DECISIONS #30–#32)
- ❌ Build billing, subscriptions, invoices, payments, or hard-code plan
  limits in business logic (DECISIONS #36; `ECONOMICS.md`)
- ❌ Modify or delete historical entries in `DECISIONS.md` (append-only;
  reversals are new entries referencing the old one)
- ❌ Redo or reimplement completed work recorded in `BUILD_STATE.md`
  ("if it works, leave it")
- ❌ Break RTL/Arabic-first behavior or accessibility guarantees
- ❌ Commit secrets or real credentials; `.env` stays local (pre-commit
  hook active)
- ❌ Skip verification: `pnpm verify` (+ `pnpm security` when touching
  anything sensitive) must pass before finishing a prompt
- ❌ Recreate duplicate documentation: no second current-state doc
  (`BUILD_STATE.md` is the only implementation ledger, `CURRENT_STATE.md`
  the only snapshot), no per-prompt reports, no competing summaries of
  canonical files, no second decision log (`DECISIONS_INDEX.md` routes the
  ONE `DECISIONS.md`; historical narrative goes to `docs/archive/`, not a
  new current-state doc)
- ❌ Commit, tag, push, or run GitHub publishing operations (`pnpm ship`,
  `pnpm release`) — the human operator owns all shipping/versioning/
  release actions unless the prompt explicitly instructs otherwise

## ALWAYS

- ✅ Update `BUILD_STATE.md` after every prompt — MINIMALLY: status,
  completed work (one entry), known issues, next step. It is a ledger, not
  a diary; per-prompt detail belongs to Git history
- ✅ Append to `DECISIONS.md` when a decision is made (never overwrite)
- ✅ Create a new document ONLY when a real long-term need exists and no
  canonical file covers the topic
- ✅ Preserve strategy: when in conflict, vision > strategy > scope >
  implementation detail
- ✅ Keep feature isolation, repository-only DB access, Zod-validated DTOs,
  server-side tenant scoping (UI visibility is not authorization)
- ✅ Write Arabic-first, vertical-agnostic UI copy (rules:
  `DESIGN_SYSTEM.md`; terms: `PRODUCT_GLOSSARY.md`)
- ✅ Report final status honestly — distinguish BUILT code from DOCUMENTED
  or NOT built
- ✅ Ask/escalate instead of guessing when scope is ambiguous

## Prompt Lifecycle Process

1. **Recover** via the context tiers — every prompt is a fresh OpenCode
   session: Tier 0 first, then task-selective Tier 1 only.
2. **Inspect the current implementation** before changing anything.
3. **Plan** against `BUILD_STATE.md → Next Step`; produce a concise plan
   and TODO list before editing.
4. **Implement** ONLY the current prompt's scope, following
   `ARCHITECTURE.md` dependency rules.
5. **Verify** with the quality gate: `pnpm verify` (lint + typecheck +
   format + build). Commands reference: `QUALITY_CHECKS.md`.
6. **Update docs** — `BUILD_STATE.md` always (minimal); `DECISIONS.md`
   when a decision was made (append only).
7. **Report honestly** and leave the repository where the next fresh
   session can continue from the Tier 0 cold start.

## Escalation Path

If a task seems to require something marked ❌ above or outside the
accepted scope, STOP. Record the request as a candidate decision in your
response to the human operator and wait for approval. Approved changes get
a `DECISIONS.md` entry before implementation begins.
