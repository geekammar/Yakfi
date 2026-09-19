# FlowPilot — Current State

> 30-second snapshot for a cold start (Tier 0, with `AGENT_RULES.md`).
> NOT a source of truth — canonical documents always override it.
> Reading policy: the context tiers in `AGENT_RULES.md`. Last updated:
> PROMPT-OPS-PILOT-BUSINESS-WHATSAPP-ONBOARDING-27 — the repeatable Business WhatsApp onboarding path landed (DECISIONS #47): a Business Admin can now connect/configure/verify/activate a WhatsApp number through `/settings/whatsapp` (new `src/features/whatsapp-connection` + settings sub-route; ADMIN-only, server-derived Business scope; `externalId`/`phone_number_id` authoritative; `credentialsRef` env-var-NAME only; read-only `ConnectionVerifier` verification — never sends a customer message; duplicate externalId protection; masked id display). TEST→REAL connection replacement is now data-only (no code change, no booking/conversation-engine change). Meta Embedded Signup deliberately NOT implemented — operator prerequisites documented, nothing faked. `pnpm check:whatsapp-onboarding` 22/22 NEW; existing WhatsApp/booking checks unchanged; `pnpm verify`/`security` green; ZERO schema/migration changes; removed leftover untracked task-26 forensic scripts that broke the typecheck gate; subsequently SHIPPED by the operator as release **v0.19.0** (`123dfaa`, tag `v0.19.0`; production verified live at v0.19.0). Prior: PROMPT-OPS-WHATSAPP-INBOUND-DEBUG-01 inbound identity fix; PROMPT-AI-03B close-the-loop COMPLETE; PROMPT-AI-03/02/01 + CORE-01/02/03A/03B remain IMPLEMENTED.

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
- **WhatsApp via Meta adapter — CODE LIVE, PRODUCTION RECONCILED to v0.15.9 + LIVE E2E VERIFIED (PROMPT-CORE-03B + PROMPT-OPS-06 continuation 2; DECISIONS #42):**
  `GET|POST /api/whatsapp/meta` inside
  `src/server/integrations/whatsapp/` on the CORE-03A provider-neutral
  foundation (`X-Hub-Signature-256` + `hub.verify_token` verify; Graph
  `POST /{v}/{PHONE_NUMBER_ID}/messages` bearer outbound; tenant-scoped
  resolution + durable idempotency preserved). Local `.env.local` complete (5 `WHATSAPP_META_*` PRESENT, `WHATSAPP_META_API_VERSION=v26.0` pinned — adapter version-agnostic). Production `vercel env ls` **9 vars** — 5 `WHATSAPP_META_*` Production Secret PRESENT + 4 core; deployment `v0.15.9` (`dpl_BAVArqTcusNyPRj3PrTibSAhjuyL`/`5xf4wjc5u` 2026-09-15T19:1xZ, `GET /api/health` 0.15.9 `deploymentReady:true/database:connected`, `GET /api/whatsapp/meta` invalid→403 valid `CHALLENGE_E2E_999`→200 `text/plain`); Production DB `whatsapp_connections` 1 (`e5e2e2f7...` `+201064549970`/`1286861067846638` `CONNECTED`/`WHATSAPP_META_ACCESS_TOKEN` ref). **Live E2E 19:0xZ:** signed `POST /api/whatsapp/meta` `wamid.test-*` → `200 {"received":1}` → `Customer b6dc7e7b +201555000001` + `Conversation 7dc71f25 NEED_HUMAN` + 2 `messages` + 1 `dedupe`; replay same `wamid` → `duplicate:true` no second message; tenant isolation (`INVALID_CONNECTION` on foreign business/unknown phone); outbound Graph `400 code 133010` → `PERMANENT` non-retryable (expected for test number) — 0 billable sends. **CORRECTED 2026-09-16 (PROMPT-OPS-WHATSAPP-INBOUND-DEBUG-01):** that E2E was a hand-crafted signed payload whose `display_phone_number` was set to the DB value — a real Meta webhook was NEVER delivered to Production and the outbound Graph result came from a direct adapter call, not the route. Deployed `v0.15.9` ran the deterministic AI (`usage_records` `AI_TURN provider=deterministic`) and the OFFLINE outbound transport (`OUTBOUND_MESSAGE provider=offline`) — the policy-backed `ConversationAi` and the Meta outbound transport exist only in the local v0.16.x worktree and are NOT deployed **at that v0.15.9 checkpoint** (superseded: production now runs **v0.19.0**, which includes both). See the debug fix + operator steps in DECISIONS #46. `pnpm check:meta-whatsapp` 15/15 - `pnpm check:whatsapp-transport` 26/26; `pnpm verify` green; ZERO schema changes.
- **BUSINESS WHATSAPP CONNECTION ONBOARDING (PROMPT-OPS-PILOT-BUSINESS-WHATSAPP-ONBOARDING-27; DECISIONS #47):**
  the repeatable pilot setup surface — a Business Admin
  connects/configures a WhatsApp number, verifies it read-only, and
  activates it through `/settings/whatsapp` (new feature
  `src/features/whatsapp-connection` + settings sub-route linked from
  `/settings`, exactly the `/settings/knowledge` URL-link pattern).
  ADMIN-only, Business derived server-side from the authenticated actor
  (never client input; hostile `businessId`/`branchId`/`role`/`status`/
  `isActive` keys stripped by Zod). `externalId` (Meta
  `phone_number_id`) is the AUTHORITATIVE identity; `credentialsRef` is
  an environment-variable NAME only (raw-token shape REJECTED by Zod);
  the read-only `ConnectionVerifier` port (transport boundary) + Meta
  adapter `meta-verify.ts` prove usability via one
  `GET /{apiVersion}/{phone_number_id}` — NO customer message is ever
  sent. Duplicate `externalId` protection is service-layer
  (check-then-create, DECISIONS #23 — no schema constraint). The
  EXISTING status model is reused (PENDING/CONNECTED/DISCONNECTED +
  isActive — no parallel state system); UI shows only non-secret
  identifiers with a MASKED `phone_number_id`. TEST→REAL replacement is
  data-only: Business Admin saves the real id + per-connection
  `credentialsRef` → operator stores the token in the deployment env →
  verify → CONNECTED → resolvable by the UNCHANGED engine. Meta
  Embedded Signup is deliberately NOT implemented (external Meta
  dashboard/app configuration — operator prerequisites documented in
  the UI + `ENVIRONMENT_VARIABLES.md`; nothing faked). `pnpm
check:whatsapp-onboarding` 22/22; ZERO schema/migration changes; NOT
  deployed.
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
- **AI PROVIDER ADAPTER (PROMPT-AI-02):** `defaultConversationEngineDeps.ai` now policy-backed via `createPolicyBackedAi({ getEnvVar: process.env, fetchImpl: globalThis.fetch })` + `getEffectiveAiPolicy()` (`toEffectivePolicy` boundary) — effective runtime policy AgentRouter primary / OpenRouter secondary / fallback enabled; no provider/model hard-coded in the engine; `INITIAL_AI_POLICY` retained as seed/default only; `bypassDeterministicAi` before `ai.respond` + `parseAiResponse` + `AiRequest`/`AiResponse` + Domain/Branch/Booking preserved; retryable/timeout fallback only, `CONFIG_ERROR`/`INVALID_RESPONSE` never retried, malformed → controlled `NEED_HUMAN`; secrets server-only via `secretRef` + `getEnvVar` (`OPENROUTER_API_KEY`/`AGENTROUTER_API_KEY`); `AiTelemetry` rich `AI_TURN` via `getLastTelemetry`; `src/server/integrations/ai/` 8 files + `pnpm check:ai-provider` 29/29; `pnpm lint`/`typecheck`/`format:check`/`verify`/`security` green; ZERO schema/migration/prompt changes.
- **CONVERSATION → BOOKING SEAM (PROMPT-AI-03; DECISIONS #45 prerequisite):** deterministic `Customer message → Conversation Engine → AiResponse → mapper → CORE-01 → CORE-02 → options/clarification/NEED_HUMAN` with zero appointment mutation — `src/features/conversations/server/booking-mapper.ts` pure mapper + `src/features/conversations/server/conversation-engine.ts` BOOKING/AVAILABILITY branch (`bypassDeterministicAi` first, `parseAiResponse` then mapper → `needs_clarification` → `AI_REPLY` `AI_ACTIVE` else `ready` → CORE-01 `resolveEligibleProviders` → provider match → CORE-02 `resolveBookingOptions` reusing the existing availability layer verbatim; Arabic messages, typed `AI_HANDOFF`/`NEED_HUMAN`, no Prisma from Conversation layer); `ConversationEngineDeps` stays backward-compatible (existing harnesses pass); offline harness `scripts/check-conversation-booking.ts` (`pnpm check:conversation-booking` 16/16; fixed date `2026-09-14` Monday); `pnpm verify` green; ZERO appointment write, ZERO schema changes, no prompt edits. **PROMPT-AI-03B** completes the close-the-loop: `booking-selection.ts` deterministic offer-aware parser (option index / `HH:mm` / provider-name / Arabic-normalized; never fabricates ids) + engine `completeBookingSelection` (server-derived Business/Branch/Service → fresh CORE-01 → fresh CORE-02 → offered option still bookable verified → canonical `createWithConflictCheck` (SERIALIZABLE; `null` = `SLOT_CONFLICT` → retry-safe refreshed options) → `BOOKED` via `addMessage` → confirmation through `MessageTransport` only after creation; stale/ambiguous/invalid → Arabic clarification/`NEED_HUMAN` with zero write; deterministic path spends zero LLM calls; `pnpm check:booking-confirm` 18/18; ZERO schema/prompt/provider changes.
- **AI PROMPT & EVALUATION SEPARATION (PROMPT-AI-01; DECISIONS #43):** provider-neutral, versioned, deterministic prompt artifacts **separate from implementation** — no live LLM call, no real provider SDK, no DB migration. `docs/ai/README.md` (rules) + `docs/ai/ARCHITECTURE.md` (invariant `AI interprets → Domain decides → Conversation orchestrates`; `AiRequest`/`AiResponse` structured contract; minimal context — message + conversationStatus + recentMessages ≤20 + businessName + services ≤100 + faqs ≤50 + optional providerPreference/availability ≤14×50; `bypassDeterministicAi` before `ai.respond` + `parseAiResponse` stripping + `PlatformAiPolicy` singleton boundary + telemetry boundary) + `docs/ai/PROMPTS.md` (5 definitions `booking-intent@v1`/`faq-match@v1`/`availability-handoff@v1`/`reschedule-cancellation@v1`/`human-request@v1` — each 7-section: Purpose/Input context/System instructions/Output contract/Constraints/Handoff policy/Version history; strict provider-neutrality — no Authorization/x-api-key/model/tool-call/secret syntax) + `docs/ai/EVALUATIONS.md` (15 fixtures 01–15: BOOKING 01–02 incl. verbatim service extraction, FAQ 03–04 verbatim `Business.faqs` answer, AVAILABILITY 05–06, CANCELLATION/RESCHEDULE 07–09, HUMAN_REQUEST/AMBIGUOUS 10–13 incl. `bypassDeterministicAi` short, ordering 14–15 booking>FAQ>availability — all bound to `classifyCustomerMessage`/`bypassDeterministicAi`/`deterministicConversationAi` + `parseAiResponse`). Offline harness `scripts/check-ai-prompts.ts` (`pnpm check:ai-prompts` 106/106: files present, structured prompts, deny-list on `docs/ai/`, fixture coverage, deterministic replay 01–15, negative invariants, invocation boundary — minimal `AiRequest`, no `prisma.` in engine AI path, no booking invention, no chain-of-thought persistence, no secrets); `package.json` adds `check:ai-prompts`; `pnpm verify` green + `pnpm security` pass; ZERO schema/engine/domain changes; `docs/ai/` is canonical — not duplicated elsewhere.
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
  build + live verification PROMPT-OPS-05.1; reconciled PROMPT-OPS-06 + live E2E continuation 2):**
  `https://flowpilot-prod.vercel.app` — Neon production DB (`neondb` @
  `ep-tiny-grass-a5e63jev-pooler`; chain 10/10; schema diff empty) — **RECONCILED to v0.15.9 at that checkpoint (current production: v0.19.0 — verified live `GET /api/health` `deploymentReady:true/database:connected` 2026-09-19)** (`GET /api/health` 0.15.9 `deploymentReady:true/database:connected` 2026-09-15T19:19Z, deployment `dpl_BAVArqTcusNyPRj3PrTibSAhjuyL`/`5xf4wjc5u`); prior stale `v0.15.3` (`dpl_Am9WNXoDG2XfY41GXsD3PKwX91vb` 2026-09-14) resolved,
  **PROMPT-OPS-05 worktree verified live** (build includes
  `/platform`, `/platform/ai-policy`, `/platform/invitations`,
  `/owner-invite/[token]` + `/api/whatsapp/meta`; live verification PASSED: health
  `deploymentReady:true/database:connected`, `/api/whatsapp/meta` invalid→403 valid→200 challenge `text/plain`, sign-in 200 Arabic RTL,
  anonymous `/` + business routes → 307 `/sign-in`, public signup 403
  `SIGNUP_CLOSED`, platform routes guard-engaged, AI-policy values
  verified openrouter/agentrouter/fallback=true, no key material in
  public responses; authenticated RBAC smoke skipped per operator
  decision — guard surface verified at code + DB level) + **continuation 2 live E2E** (see WhatsApp bullet); dedicated Vercel
  project `flowpilot-prod` (framework nextjs, SSO protection off), **9 Production env vars** (5 `WHATSAPP_META_*` Secret + 4 core), `.vercel` links `flowpilot-prod`. Repository
  visibility: **PRIVATE** (verified via `gh`).
- **Version:** **v0.19.0** — released and committed (`123dfaa`, tag `v0.19.0`; HEAD == `origin/main`, working tree clean). Production `GET /api/health` verified live at **v0.19.0** (`deploymentReady:true`, `database:connected`, `missingEnvVars:[]`, 2026-09-19). The v0.16.0/v0.15.9 mentions in this snapshot are the pre-release checkpoint and are superseded by the v0.19.0 release. Checks at release: `pnpm check:whatsapp-onboarding` 22/22 + `pnpm check:whatsapp-transport` 27/27 + `pnpm check:meta-whatsapp` 17/17 + `pnpm check:whatsapp-inbound` 13/13 + `pnpm check:conversation-booking` 16/16 + `pnpm check:ai-provider` 29/29 + `pnpm check:ai-prompts` 106/106 + `pnpm verify` green + `pnpm security` pass · single `main` branch, tags through `v0.19.0` (released and committed by the operator). **PROMPT-AI-03 WIRED 2026-09-16 — mapper → CORE-01 → CORE-02, zero mutation** · **Production RECONCILED + LIVE E2E VERIFIED** — deploy `dpl_BAVArqTcusNyPRj3PrTibSAhjuyL`/`5xf4wjc5u` 0.15.9; 5 `WHATSAPP_META_*` set, webhook 200, `WhatsAppConnection e5e2e2f7`, inbound+idempotency+isolation+error taxonomy live-verified (PROMPT-OPS-06 §3/5/6/7–11).

**Current next step (PROMPT-OPS-PILOT-BUSINESS-WHATSAPP-ONBOARDING-27 COMPLETE — Business WhatsApp onboarding surface + read-only verification + TEST→REAL data-only replacement; 22/22 NEW + 27/27 + 17/17 + 13/13 + 16/16 + 29/29 + 106/106 + 29/29 + 32/32 + 18/18 + lint/typecheck/format/verify/security green; ZERO schema/migration/prompt/provider/booking changes; shipped as release **v0.19.0**):** the pilot readiness bottleneck is now closed — a Business Admin self-serves WhatsApp connection setup at `/settings/whatsapp`, the operator stores the per-connection token in the deployment environment, and the connection becomes live after read-only verification. PROMPT-AI-03/03B deterministic booking seam remains wired AND CLOSED; PROMPT-AI-02 policy-backed `ConversationAi` wired; CORE-01/02/03A/03B and the inbound/outbound transport boundaries remain IMPLEMENTED; WhatsApp live (DECISIONS #42/#46). Next: onboard the first REAL pilot Business end-to-end (operator provisions Business + invitation → ADMIN onboards WhatsApp number → operator sets `credentialsRef` env → ADMIN verifies → live messaging), then gather baseline/ROI evidence per `PRODUCT_STRATEGY.md`. Parallel operator actions (not blockers): add `OPENROUTER_API_KEY`/`AGENTROUTER_API_KEY` to Vercel env (#7) + `pnpm db:deploy` Demo DB (#8) + optional Meta Embedded Signup dashboard configuration if self-serve token issuance is later wanted (documented operator prerequisite, NOT required for pilots). Shipped by the operator as release **v0.19.0** (`123dfaa`); the working tree is clean and ready for the next implementation slice.
