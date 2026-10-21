# FlowPilot — Current State

> **Tier 0 cold-start snapshot** — read with `docs/AGENT_RULES.md` and
> `docs/DECISIONS_INDEX.md`. This is a concise orientation document, NOT a
> source of truth: canonical topic documents and the repository code override
> it. Implementation details live in `docs/BUILD_STATE.md`; decisions in
> `docs/DECISIONS.md`.

## 1. Verified Baseline & Production Status

- **Repository State (Verified):**
  - Branch: `feat/conv-core-03c1-current-engine-playground` (branched from `main` at commit `8ff6182d5c74eb8ad98160ba6eee0388fe869240`).
  - Package Version: `v0.63.0` (SemVer minor increment over v0.62.0 baseline).
  - Baseline Commit: `8ff6182d5c74eb8ad98160ba6eee0388fe869240` (PR #21 merged baseline).
  - Working Tree: Current-engine conversation playground alignment, 12 Egyptian Arabic test scenarios, acceptance test suite `check:conv-core-03c1`.
- **Production Status (Read-Only Health Verified):**
  - Production health check `GET https://flowpilot-prod.vercel.app/api/health` returned:
    - `status: "ok"`
    - `version: "0.62.0"`
    - `commitSha: "8ff6182d5c74eb8ad98160ba6eee0388fe869240"`
    - `database: "connected"`
    - `deploymentReady: true`
  - Production database migrations and deployments are operator-authorized via GitHub Actions. No production config or database changes made.

## 2. Architecture & Invariants

- **Stack:** Feature-based modular monolith on Next.js 16 (App Router) + Prisma 7 with driver adapter (`@prisma/adapter-pg`) + Neon PostgreSQL + Vercel.
- **Tenancy & Isolation:** Tenancy enforced via `businessId` in repositories. UI visibility is not authorization.
- **Booking Invariants:** The `availability-service` is the sole booking authority and returns only genuinely selectable slots. Booking is strictly server-authoritative. Never build a second availability engine.
- **AI Trust Boundary:** AI interprets customer intent; domain rules decide availability and eligibility; conversation orchestrates. AI output is never authoritative for booking execution (DECISIONS #33).
- **Presentation:** Arabic-first, RTL-by-default (`dir="rtl" lang="ar"`), responsive shell (desktop right sidebar / mobile bottom nav), vertical-agnostic discovery copy.
- **Conversation Playground Alignment (CORE-03C1):**
  - CLI `pnpm convo:playground --mode current_engine` executes the real merged engine pipeline: `receiveInboundMessage` → structured capability routing → `createPolicyBackedAi` / provider adapter → turn planner / reconciliation → Booking Core → `InMemoryConversationStateStore` with CAS revision semantics.
  - Physical HTTP attempt counting at injected `fetchImpl` boundary (separates offline fixtures, live provider calls, estimates, and unknown tokens; never reports 0 for unknown usage).
  - Historical modes (`baseline`, `goal_driven`, `typesafe_jev`, `agent_c`) remain available and are strictly labeled by their respective architectures (`HYBRID_B`, `GOAL_DRIVEN_HYBRID`, `TYPESAFE_JEV_GOAL_DRIVEN`), preventing misattribution.
  - 12 Egyptian Arabic scenarios (`CE-01` to `CE-12`) covering relative dates, Cairo/UTC date boundary, date/provider corrections, provider/time/date REMOVE semantics, FAQ interruptions, explicit factUpdates precedence, mechanical selection zero-call execution, and invalid proposal clarification.
  - Verified by 32/32 offline automated acceptance checks (`pnpm check:conv-core-03c1`).
  - Evaluation-readiness slice only: paid live provider execution is NOT RUN and blocked by operator limits preflight.

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

## 5. Upcoming Direction: UX001 Workstreams & Welcome/Button UX Constraints

FlowPilot is currently in Product Discovery. The approved upcoming direction is **UX001**.
The immediate next product change following baseline conversation engine evaluation is the **Welcome and Button UX**.
The intended constraints are established here as architectural boundaries:

1. **Proactive /start welcome with contextual inline choices:** Welcomes incoming customers with contextual actions/buttons where channel supports it.
2. **Free text remains supported:** Customer may choose to type naturally at any point; buttons are assistive, never coercive.
3. **One state, planner, and Booking Core:** The existing single `ConversationEngine`, `resolveFinishedTurn`, and Booking Core remain authoritative.
4. **No parallel wizard:** Do not construct a second wizard or alternative conversation state machine for button clicks.
5. **No greeting keyword dictionary:** Greetings are recognized organically; do not build fragile regex/keyword greeting dictionaries.
6. **No reset of active tasks on greeting or /start:** A customer saying hello or re-triggering `/start` mid-conversation must not wipe active booking tasks or known facts.
7. **Valid default service skips redundant service questions:** When a business has a single service or an unambiguous default, skip asking "which service?" and proceed directly to scheduling.
8. **Staff ownership remains authoritative:** Handed-off or staff-assigned conversations stay assigned to staff; incoming buttons/messages do not silently unassign or override human staff.

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
