# FlowPilot — Decisions Index

> **The lightweight ROUTING document for `docs/DECISIONS.md`.** Read THIS
> (Tier 0, with `AGENT_RULES.md` + `CURRENT_STATE.md`) instead of the full
> decision log. It tells you which decision exists, whether it is current, and
> **when you must load the full entry**. The full, append-only record is
> `docs/DECISIONS.md` — load individual entries ONLY when the task touches
> that decision or an architectural conflict requires it (Tier 2).

**Reading rule:** the one-line summary below is enough for 95% of tasks. Drop
into `DECISIONS.md` (entry `#NN`) only when (a) you are about to change
something the decision governs, (b) documents conflict and authority order
needs the exact wording, or (c) a reversal is being considered. Never read the
whole log by default.

## Current decisions (load the entry only when relevant)

| #   | Decision (one line)                                                                                                                        | Load the full entry when…                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| 01  | Appointments use the Agenda View (list by day), never calendar grids                                                                       | touching appointment display                           |
| 02  | Only ADMIN and STAFF business roles; no granular permissions                                                                               | adding roles or permissions                            |
| 03  | Human-in-the-loop is mandatory (`NEED_HUMAN` handoff)                                                                                      | changing AI/staff handoff behavior                     |
| 04  | Next.js 16.x (async request APIs, `proxy.ts`, `{ error, retry }`)                                                                          | touching routing/middleware                            |
| 05  | Prisma 7 with driver-adapter client, generated to `src/generated/prisma`                                                                   | touching DB tooling                                    |
| 06  | Feature-based modular monolith; repository layer is the only Prisma consumer                                                               | changing structure or DB access                        |
| 07  | Arabic-first, RTL-by-default (`dir="rtl" lang="ar"`, logical CSS)                                                                          | touching UI/layout                                     |
| 08  | Responsive shell: desktop right sidebar / mobile bottom nav in one `AppShell`                                                              | touching navigation                                    |
| 09  | Premium-calm visual direction; no neon/gradients/AI gimmicks                                                                               | touching visual design                                 |
| 10  | Single shared Postgres; tenancy via `businessId` columns                                                                                   | touching tenancy                                       |
| 11  | Soft deletes (`deletedAt`); Message immutable                                                                                              | modeling deletion                                      |
| 12  | Features depend on repositories + Zod DTOs only                                                                                            | adding a feature boundary                              |
| 13  | Onboarding progress persisted on the Business record (FAQs as JSON)                                                                        | touching onboarding/knowledge storage                  |
| 14  | Seed provisions demo-only credential accounts                                                                                              | touching the seed                                      |
| 15  | PWA icons are generated PNGs (`pnpm icons`)                                                                                                | touching manifest/icons                                |
| 16  | Cross-platform run system (`pnpm run setup/doctor/verify`)                                                                                 | changing dev tooling                                   |
| 17  | Repo-managed git hooks; `security-check.mjs` pre-commit                                                                                    | changing commit safety                                 |
| 18  | Release model: `pnpm release` gated path, `vX.Y.Z` tags                                                                                    | cutting a release                                      |
| 19  | Vercel deployment readiness (`/api/health`, `vercel.json`)                                                                                 | changing deploy config                                 |
| 20  | Demo dataset v2 (Egyptian, dental-data-only, vertical-agnostic UI copy)                                                                    | touching demo data                                     |
| 21  | Pilot distribution system (`pnpm deploy` + pre-deploy gate)                                                                                | changing deploy tooling                                |
| 22  | ONE Better Auth; PLATFORM vs BUSINESS scopes; invitation-first lifecycle                                                                   | touching auth/identity                                 |
| 23  | Invitation security (hash-only tokens, 7-day expiry, check-then-create)                                                                    | touching invitations                                   |
| 24  | ADMIN activation consistency model (one-time `activatedAt`)                                                                                | touching activation                                    |
| 25  | Activation → `/sign-in?redirect=/onboarding` handoff; public invite route                                                                  | touching activation routes                             |
| 26  | Two release paths: `pnpm release` (full gate) + `pnpm ship` (lightweight)                                                                  | shipping                                               |
| 27  | Team management; role-generic invited-account activation                                                                                   | touching team/staff activation                         |
| 28  | Staff workspace; ownership changes are explicit-action-only                                                                                | touching assignment/takeover                           |
| 29  | Conversation engine: provider-neutral inbound/AI/transport seams                                                                           | changing the engine boundary                           |
| 30  | Business/Branch model with SELECTIVE branch scoping (never `branchId` everywhere)                                                          | adding branch scoping                                  |
| 31  | WhatsAppConnection is first-class; thin channel-agnostic boundary                                                                          | touching channel model                                 |
| 32  | Provider = bookable capability/profile, NOT an authorization role                                                                          | touching provider model                                |
| 33  | **AI interprets; Domain decides and executes; Conversation orchestrates**; minimal AI context                                              | touching the AI/domain boundary                        |
| 34  | Production reliability prerequisites (concurrency, idempotency) — implemented in #38                                                       | touching booking writes/webhooks                       |
| 35  | Scheduling scope: provider availability inherits business hours                                                                            | touching availability rules                            |
| 36  | Usage ≠ Cost ≠ Price ≠ Entitlement ≠ Billing; billing deferred                                                                             | touching economics/metering                            |
| 38  | P0 architecture-hardening foundations implemented (#30–#36 mechanism choices)                                                              | touching branch/concurrency/idempotency                |
| 39  | Context-tier reading model replaces `CONTEXT_RECOVERY.md` (refined by #57)                                                                 | touching docs navigation                               |
| 40  | Migration-chain repair: `0_init` root baseline + lock file                                                                                 | touching migrations                                    |
| 41  | Minimal platform control plane; public signup CLOSED (403 `SIGNUP_CLOSED`)                                                                 | touching signup/platform                               |
| 42  | Meta WhatsApp Cloud API is the WhatsApp provider (Graph API, business-owned number)                                                        | touching WhatsApp integration                          |
| 43  | AI prompt & evaluation separation; `docs/ai/` canonical, versioned, neutral                                                                | touching prompts                                       |
| 44  | AI runtime provider policy: OpenRouter primary / AgentRouter secondary / fallback                                                          | touching provider selection                            |
| 45  | AI → Conversation → Domain booking boundary (CORE-01/CORE-02 are the only truth)                                                           | touching booking via conversation                      |
| 46  | Inbound identity = `phone_number_id` → `findByExternalId`; outbound Meta wiring                                                            | touching inbound/outbound resolution                   |
| 47  | Business WhatsApp connection onboarding (`/settings/whatsapp`); `externalId` authoritative                                                 | touching connection setup                              |
| 48  | Prompt Workspace: prompt bodies live only in `/prompts/**/*.prompt`                                                                        | touching any prompt body                               |
| 49  | RUNTIME credential backend: Neon + application-side AES-256-GCM, `fp:<id>` grammar                                                         | touching credential storage                            |
| 50  | AI knowledge visibility: `PUBLIC`/`CONDITIONAL`/`INTERNAL`/`FORBIDDEN`                                                                     | touching what reaches the AI                           |
| 51  | AI context builder: the B-01 pipeline composing the minimal `AiRequest` + ledger                                                           | touching AI context                                    |
| 52  | Customer disclosure boundary: "AI may know" ≠ "AI may mention"; structural gate                                                            | touching AI replies                                    |
| 53  | Service catalog is DOMAIN data, not a second Knowledge Base; duration is INTERNAL                                                          | touching services                                      |
| 54  | Appointment creation UX: smart context, relative scheduling, availability-first                                                            | touching booking UX                                    |
| 55  | Appointments/availability coherence: day-view reset + day-capacity chips                                                                   | touching the day view                                  |
| 56  | Slot presentation: visible-but-disabled «غير متاح» candidates; NO reason inference                                                         | touching the slot step                                 |
| 57  | Documentation normalization + tiered context governance (this pass)                                                                        | touching docs structure                                |
| 58  | A B-03-refused reply now delivers the deterministic safe handoff acknowledgment (never silence); refines #52                               | touching the disclosure refusal / customer reply path  |
| 59  | CodeCraft added as an isolated OpenAI-compatible Discovery provider (extends #44); removable in 8 files                                    | touching the AI provider boundary / provider selection |
| 60  | An AI provider FAILURE now delivers the same deterministic safe handoff acknowledgment (never silence); extends #58 to the AI-failure path | touching the AI-failure / customer reply path          |

## Historical decisions (never load unless doing forensics)

| #   | Decision                                      | Why historical                                                                                                                                                                                                                                 |
| --- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 37  | PROMPT-ARCH-01 documentation canonicalization | Superseded by #39 (tier model) and refined by #57 (this index). Its `DECISIONS_INDEX.md` deletion note is itself superseded by #57 — the operator re-introduced a decisions ROUTING index (not a general docs index) to cut cold-start tokens. |

## Authority order (when documents conflict)

Latest `DECISIONS.md` entry → `BUILD_STATE.md` → canonical topic docs → derived
summaries. The repository itself is implementation truth — never trust a stale
doc over the code. If a conflict is unclear, escalate instead of guessing
(`docs/AGENT_RULES.md → Escalation Path`).
