# FlowPilot — Current State

> 30-second snapshot for a cold start (Tier 0, with `AGENT_RULES.md`).
> NOT a source of truth — canonical documents always override it.
> Reading policy: the context tiers in `AGENT_RULES.md`. Last updated:
> PROMPT-OPS-02.

- **Product:** WhatsApp Appointment Conversion System — "Book more, chase
  less." Arabic-first, RTL-first, mobile-first, vertical-agnostic during
  discovery. Identity: `PROJECT_VISION.md`.
- **Strategy:** Local Vertical Discovery (Kafr El Sheikh, Egypt) — one
  identical generic engine across appointment-driven verticals; evidence
  picks the winner. `PRODUCT_STRATEGY.md`.
- **Spec A implementation: COMPLETE** (through PROMPT-19) — all screens
  (onboarding, dashboard, conversations, appointments, Smart Create 1–6,
  customers, services, settings, knowledge, team, staff workspace) plus the
  conversation engine slice (provider-neutral inbound webhook → engine →
  deterministic AI turn → reply or NEED_HUMAN). Ledger: `BUILD_STATE.md`.
- **Architecture hardening P0 foundations: IMPLEMENTED (PROMPT-ARCH-02,
  DECISIONS #38):** Branch model (Default Branch backfill; branch-aware
  Conversation/Appointment), WhatsAppConnection entity, Provider relations,
  platform-operator marker (`users.accountType`), DB-serializable booking
  concurrency, durable inbound-webhook idempotency, structured AI contract
  with deterministic bypass, and append-only usage telemetry. **Migration
  chain repaired & complete (PROMPT-ARCH-03, DECISIONS #40):** root
  baseline `0_init` + `migration_lock.toml` — an EMPTY database
  bootstraps fully via `pnpm db:deploy` (verified end-to-end: deploy 8/8,
  schema diff empty, seed ×3 idempotent). The old Demo/Neon DB still needs
  a one-time HUMAN-ONLY baseline reconciliation
  (`prisma migrate resolve --applied 0_init` → `pnpm db:deploy`).
- **NOT live (operator decisions pending):** real WhatsApp transport and
  real LLM inference — both are provider-neutral interfaces with
  deterministic offline implementations (DECISIONS #29); the ARCH-02
  foundations are ready for them.
- **DEMO LIVE (PROMPT-OPS-02):** `https://flowpilot-demo-gamma.vercel.app`
  — dedicated Vercel project `flowpilot-demo` (framework nextjs, SSO
  protection off) + the isolated Demo Neon DB (`neondb` @
  `ep-weathered-feather-aef123ef-pooler`; was fully EMPTY; chain 9/9;
  seeded ×2 deterministic/idempotent — 1 business, 1 Default Branch, 2
  team users, 6 services, 36 customers, 22 conversations, 73 messages,
  37 appointments; dedicated Better Auth secret; demo URLs;
  `DEMO_MODE=true`). Demo Admin + Staff verified end-to-end with role
  isolation. Demo credentials exist ONLY in the Demo DB. The suggested
  `flowpilot-demo.vercel.app` is owned by an unrelated third party —
  the live domain is the `-gamma` one.
- **Production auth audit (PROMPT-OPS-02):** the public
  `/api/auth/sign-up/email` endpoint is OPEN (remediation = operator
  decision; Better Auth's `disableSignUp` would break the internal
  invitation-activation path). Better Auth v1.7 `accounts.issuer` drift
  fixed (column + migration + seed writes `local:credential`); every
  credential flow works again (verified live on Demo). First production
  ADMIN remains a direct-DB operator action (row requirements in
  `BUILD_STATE.md → Unresolved User Actions #4`).
- **PRODUCTION LIVE (PROMPT-OPS-01):** `https://flowpilot-prod.vercel.app`
  — NEW EMPTY Neon production DB (`neondb` @ `ep-tiny-grass-a5e63jev-pooler`)
  bootstrapped via the chain (`pnpm db:deploy`; 9/9 since PROMPT-OPS-02;
  schema diff empty), data-empty (DEMO_MODE off, no seed; 0 users / 0
  accounts); dedicated Vercel project `flowpilot-prod` (framework nextjs,
  SSO protection off), four Production env vars set. Old Vercel projects
  untouched.
- **Version:** v0.15.2 (pre-ship) · `pnpm verify` green · single `main`
  branch, tags through `v0.15.2`.

**Current next step:** `BUILD_STATE.md → Next Step` (operator commits/ships
the worktree + creates the FIRST production ADMIN identity on the
data-empty Production DB — direct-DB row requirements in `BUILD_STATE.md
→ Unresolved User Actions #4`; approve the public sign-up remediation
(#5); then resolve the two provider decisions before any provider
integration).
