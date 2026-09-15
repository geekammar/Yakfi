# FlowPilot — Current State

> 30-second snapshot for a cold start (Tier 0, with `AGENT_RULES.md`).
> NOT a source of truth — canonical documents always override it.
> Reading policy: the context tiers in `AGENT_RULES.md`. Last updated:
> PROMPT-DOC-DECISION-META — Meta WhatsApp Cloud API provider boundary
> (DECISIONS #42; doc record for the CORE-03A transport foundation,
> zero schema/code changes; worktree uncommitted).

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
- **NOT live:** WhatsApp provider **selected** — Meta WhatsApp Cloud API
  (Graph API, business-owned number — DECISIONS #42); transport stays
  provider-neutral with the offline adapter behind `MessageTransport`
  until CORE-03B lands the Meta adapter; real LLM inference remains a
  provider-neutral deterministic implementation (DECISIONS #29); the
  ARCH-02 foundations are ready for both.
- **PUBLIC SIGNUP CLOSED (PROMPT-OPS-05, DECISIONS #41):** the proxy
  refuses public `POST /api/auth/sign-up/email` (403 `SIGNUP_CLOSED`);
  the invitation-first lifecycle (business `/invite/[token]` + platform
  `/owner-invite/[token]`) is unaffected.
- **MINIMAL PLATFORM CONTROL PLANE (PROMPT-OPS-05; deployed to Production
  - verified live in PROMPT-OPS-05.1):** Platform Operator
    guard surface enforced (operators redirected from every Business
    route to `/platform`; `requirePlatformOperator` guards the platform
    UI: overview / دعوات الملاك / سياسة الذكاء — Arabic RTL), platform
    owner invitations (`platform_invitations` — pre-Business, one-time
    hash-only tokens, activation → ADMIN credential → canonical
    onboarding), Platform AI Policy (`platform_ai_policies` singleton —
    OpenRouter primary / AgentRouter secondary, runtime-changeable,
    secret REFERENCES only; API keys are env-backed
    `OPENROUTER_API_KEY`/`AGENTROUTER_API_KEY`). One-time operator tool:
    `pnpm bootstrap:operator` (the FIRST Platform Operator identity —
    operator must run it). Checks: `pnpm check:signup` (13/13),
    `pnpm check:policy` (13/13).
- **PROVIDER ELIGIBILITY RESOLVER (PROMPT-CORE-01):** deterministic
  `resolveEligibleProviders` — relation-driven ProviderService /
  ProviderBranch eligibility within the server-resolved Business scope
  (optional Branch scope, existing Branch semantics), compact AI-ready
  DTO (`providerId` + `displayName`), cross-tenant leakage impossible,
  ZERO schema changes; `pnpm check:eligibility` 29/29. Not exposed in
  any UI/conversation turn yet (CORE-02 consumes it next).
- **ANY-PROVIDER BOOKING OPTIONS RESOLVER (PROMPT-CORE-02):**
  deterministic `resolveBookingOptions` — the first consumer of CORE-01
  (requested Service → eligible Providers) that adds per-Provider
  availability over the EXISTING Availability layer (provider-scoped
  conflicts mirroring the booking write path's `assignedUserId`
  scoping; ONE batched conflict read — no N+1, no second availability
  engine), deterministic nearest-useful ranking (earliest first, stable
  CORE-01 order as tie-breaker; no ML/LLM), and a SMALL result:
  service/branch/date/timezone context + `preference` (ANY|PROVIDER) +
  normally 2–3 options (`providerId`, `displayName`, `startAt`,
  `endAt`). Explicit empty reasons (no eligible providers / business
  closed / service too long / fully booked); a requested Provider is
  verified against CORE-01 (`PROVIDER_NOT_ELIGIBLE` — no cross-Business
  leak). READ-ONLY: no appointment write, no reservation, no LLM, no
  WhatsApp. ZERO schema changes; `pnpm check:booking-options` 32/32.
  Not exposed in any UI/conversation turn yet — the Conversation layer
  consumes it next.
- **WHATSAPP TRANSPORT FOUNDATION (PROMPT-CORE-03A; provider boundary
  DECISIONS #42):** provider-neutral boundary
  `src/server/transport/whatsapp-transport.ts` — Meta WhatsApp Cloud API
  (Graph API) is the selected provider (business-owned number) — the
  boundary itself stays provider-neutral: normalized inbound envelope
  (`externalMessageId`/`senderExternalId`/`recipientExternalId`/
  `timestamp`/`kind`/`text`/`media` reference; `strict()` + TEXT↔MEDIA
  exclusivity; hostile keys rejected),
  `normalizeInboundTransportMessage` → `resolveInboundConnection` →
  `toEngineInboundMessage` (TEXT-only into Core; MEDIA →
  `UNSUPPORTED_MESSAGE_TYPE`), outbound `OutboundMessage` →
  `MessageTransport` (offline adapter retained behind the seam;
  `resolveConnectionForSend` tenant-scoped + `CONNECTED`/`isActive`
  gated; `credentialsRef` never returned), typed
  `WhatsAppTransportErrorCode` taxonomy + `TransportError` (`retryable`
  = only `TRANSIENT_TRANSPORT_FAILURE`). Tenant/branch resolution is
  server-derived via `BusinessRepository.findByWhatsappNumber` +
  `WhatsAppConnectionRepository` + `BranchRepository` (branch validated
  within Business; business-shared `branchId=null` falls back to Default
  Branch); no Meta SDK/HTTP/signature/media-download; no provider
  payload copied; `pnpm check:whatsapp-transport` 26/26 (in-memory
  fakes; offline checks — no DB/network). ZERO schema changes;
  re-exported for the conversations feature via
  `src/features/conversations/server/conversation-transport.ts`.
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
- **Production auth audit (PROMPT-OPS-02; closed PROMPT-OPS-04; public
  signup closed PROMPT-OPS-05):** the public sign-up endpoint is now
  BLOCKED at the proxy (anonymous account creation refused; internal
  `auth.api.signUpEmail` and both invitation activation flows remain
  functional). Auth audit PASSED: invitation-first lifecycle,
  ADMIN/STAFF + Platform-Operator guards, server-derived tenant/role
  resolution, role isolation — verified against the source
  (PROMPT-OPS-04).
- **FIRST PRODUCTION ADMIN (PROMPT-OPS-04):** bootstrapped via the one-time
  operator tool `pnpm bootstrap:admin` (reuses the exact seed.ts
  credential primitives — `hashPassword` + `createLocalAccountIssuer`;
  host assertion + data-empty precondition + no-echo password + typed YES
  confirmation; NO backdoor): 1 ADMIN user (role ADMIN, account_type
  BUSINESS, isActive, businessId null — the Business is created in-app
  via the canonical onboarding wizard), 1 credential account
  (`issuer=local:credential`); 17/17 DB row checks + full live sign-in
  verification passed (sign-in, session, onboarding handoff, ADMIN-only
  access, STAFF refusal, sign-out). Production onboarding COMPLETED —
  verified at the DB level in PROMPT-OPS-05.1 (1 Business; the ADMIN user
  is attached to it).
- **PRODUCTION LIVE (PROMPT-OPS-01; identity closed PROMPT-OPS-04; OPS-05
  build + live verification PROMPT-OPS-05.1):**
  `https://flowpilot-prod.vercel.app` — Neon production DB (`neondb` @
  `ep-tiny-grass-a5e63jev-pooler`; chain 10/10; schema diff empty),
  **redeployed with the PROMPT-OPS-05 worktree** (build includes
  `/platform`, `/platform/ai-policy`, `/platform/invitations`,
  `/owner-invite/[token]`; live verification PASSED: health
  `deploymentReady:true/database:connected`, sign-in 200 Arabic RTL,
  anonymous `/` + business routes → 307 `/sign-in`, public signup 403
  `SIGNUP_CLOSED`, platform routes guard-engaged, AI-policy values
  verified openrouter/agentrouter/fallback=true, no key material in
  public responses; authenticated RBAC smoke skipped per operator
  decision — guard surface verified at code + DB level) after the live
  build was found STALE
  (generated Prisma client predated `accounts.issuer` — every credential
  flow failed `Unknown argument 'issuer'`; the redeploy regenerated the
  client; verified fixed via the live sign-in flow); dedicated Vercel
  project `flowpilot-prod` (framework nextjs, SSO protection off), four
  Production env vars set, `.vercel` links `flowpilot-prod`. Repository
  visibility: **PRIVATE** (verified via `gh`).
- **Version:** v0.15.6 · `pnpm verify` green · single `main` branch, tags
  through `v0.15.6` (worktree uncommitted — operator owns `pnpm ship`).

**Current next step:** CORE-03B — Meta WhatsApp adapter (Graph API)
→ OpenRouter + AgentRouter production integration (consume
`getEffectiveAiPolicy()`; no engine changes) → End-to-End WhatsApp →
AI → Booking → Production pilot validation. CORE-01 (eligible
Providers) + CORE-02 (ranked booking options) + CORE-03A (provider-
neutral transport foundation) are all IMPLEMENTED and ready for the
Conversation/WhatsApp layer to consume; none is exposed in any
UI/conversation turn yet (the conversation engine integration decides
that surface).
Remaining operator actions (not implementation blockers): add
`OPENROUTER_API_KEY`/`AGENTROUTER_API_KEY` to the Vercel project env
vars before the provider-integration phase, and `pnpm db:deploy` against
the Demo Neon DB before its next code deploy.
