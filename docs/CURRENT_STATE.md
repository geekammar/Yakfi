# FlowPilot — Current State

> **Tier 0 cold-start snapshot** — read with `docs/AGENT_RULES.md` and
> `docs/DECISIONS_INDEX.md`. This is a concise orientation document, NOT a
> source of truth: canonical topic documents and the repository code override
> it. Implementation details live in `docs/BUILD_STATE.md`; decisions in
> `docs/DECISIONS.md`.

## 1. Verified Baseline & Production Status

- **Repository State (Verified):**
  - Branch: `main` (up to date with `origin/main`).
  - Package Version: `v0.46.1`.
  - HEAD Commit: `74bfd578322784b906fe99a0640afb9c09140ac5`.
  - Working Tree: Clean baseline; all previous in-flight prompts are committed and released.
- **Production Status (Reported / Operator-Managed):**
  - Last offline-documented live verification was at `v0.40.2` (`GET /api/health` → `status:"ok"`, `database:"connected"`).
  - Code releases through `v0.46.1` are committed on `main`. Production deployment on Vercel and database migrations on Neon are operator-owned actions.
  - Production database migrations can be dispatched via GitHub Action (`.github/workflows/production-db-migrate.yml`).

## 2. Architecture & Invariants

- **Stack:** Feature-based modular monolith on Next.js 16 (App Router) + Prisma 7 with driver adapter (`@prisma/adapter-pg`) + Neon PostgreSQL + Vercel.
- **Tenancy & Isolation:** Tenancy enforced via `businessId` in repositories. UI visibility is not authorization.
- **Booking Invariants:** The `availability-service` is the sole booking authority and returns only genuinely selectable slots. Booking is strictly server-authoritative. Never build a second availability engine.
- **AI Trust Boundary:** AI interprets customer intent; domain rules decide availability and eligibility; conversation orchestrates. AI output is never authoritative for booking execution (DECISIONS #33).
- **Presentation:** Arabic-first, RTL-by-default (`dir="rtl" lang="ar"`), responsive shell (desktop right sidebar / mobile bottom nav), vertical-agnostic discovery copy.

## 3. Completed Capabilities (Verified in Repository)

1. **Spec A Core & Operations:** Dashboard, appointments agenda, Smart Create 1–6, customer directory, services catalog, knowledge authoring, and settings.
2. **Messaging Channels:**
   - **WhatsApp:** Meta Cloud API adapter, inbound webhook, identity resolution, provider-neutral transport contract.
   - **Telegram:** Provider-neutral transport sibling, Manager Bot provisioning (`@FlowPilotManagerBot`), customer `/start` welcome handler, Android standard-Telegram launcher.
3. **AI Orchestration & Observability:** Provider-agnostic adapter (Atria, CodeCraft, OpenRouter), minimal context builder (knowledge visibility), disclosure gate, turn evidence telemetry sink.
4. **JEV Operational Work (Completed):** JEV semantic strategy, shadow strategy, decisions provider, and offline evaluation harnesses (`scripts/check-jev-semantic.ts`, `scripts/check-jev-shadow.ts`) are fully built and tested. Lifecycle is closed; no open implementation tasks remain.
5. **Platform Conversation Lab:** Copy override registry, override services, and founder review UI at `/platform/conversation-lab`.
6. **Test Ingress Harness:** Synthetic inbound test business harness (`scripts/check-test-ingress.ts`, `src/features/conversations/server/test-business.ts`) for offline regression validation.

## 4. Current Boundaries & Inactive Holds

- **Meta WhatsApp Embedded Signup:** Implemented in code but kept on **DEFERRED / HOLD** awaiting external Meta App Dashboard configuration (`docs/INTEGRATION_CHECKPOINTS.md`).
- **Deferred Areas:** Billing, subscriptions, payments (DECISIONS #36); Spec B instrumentation/economics; multi-tenant branch routing beyond selective scoping.

## 5. Upcoming Direction: UX001 Workstreams

FlowPilot is currently in Product Discovery. The approved upcoming direction is **UX001**.
Implementation tasks follow this planned sequence:

1. **BOOK-UX-00 — Booking Core Validation:** Validating booking creation flow, provider eligibility, availability coherence, and slot presentation.
2. **Receptionist Booking UX:** Receptionist booking workflow and availability-guided actions.
3. **Customer Chatbot Booking UX:** Conversational booking selection, mapper, provider-aware options, and confirmation.
4. **Founder Conversation Lab:** Platform copy overrides, prompt copy experimentation, and founder tuning.

_(Do not implement UX001 workstreams during documentation phases.)_

## 6. How to Continue

1. Read `docs/AGENT_RULES.md` for tier-based loading and task-scoped reading rules.
2. Locate the closest context via `docs/CONTEXT_MAP.md` or `pnpm context <name>`.
3. Open only the mapped doorway files and follow direct imports outward as needed.
