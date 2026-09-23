# FlowPilot — Current State

> 30-second snapshot for a cold start (Tier 0, with `AGENT_RULES.md`).
> NOT a source of truth — canonical documents always override it.
> Reading policy: the context tiers in `AGENT_RULES.md`. Last updated:
> PROMPT-B06 — the **Service Catalog + Service Authoring surface is
> complete (DECISIONS #53, uncommitted)**: the catalog is canonical
> business/domain data — NOT a second Knowledge Base. `name`/
> `description` are customer-facing under the B-01 policy and reach the
> AI only as NAMES through the B-02 context builder; `durationMinutes`
> is an operational scheduling fact (booking options, `endTime`,
> CORE-02 slot math) that stays `INTERNAL` — it is NOT a customer
> disclosure merely because it exists, and B-03 can never let it back
> a reply. Removal is now wired: the repository's already-present
> `softDelete` had ZERO callers, so a confirmed-removal dialog
> (`ServiceRemoveDialog`, the established `KnowledgeRemoveDialog`
> pattern) was added; soft delete is forced by `Appointment.service`
> `onDelete: Restrict` (past-appointment history stays intact while
> the service stops being catalog/bookable). A duplicate-name guard
> (check-then-create, DECISIONS #23 convention) rejects same-named
> live services and renames onto existing names, because the
> deterministic `matchServiceByName` would otherwise go ambiguous.
> Three UI copy corrections state the boundary honestly. NO schema
> migration — the existing model already had every needed field.
> `pnpm check:services` 50/50 (NEW — list/empty/create/reject/edit/
> remove/tenant read+write isolation/unauthorized/duration preserved/
> duration-not-disclosed/inactive/no-duplicates/booking intact);
> `check:knowledge-visibility` 36/36, `check:ai-context-builder`
> 39/39, `check:ai-disclosure` 32/32, `check:conversation-booking`
> 16/16, `check:booking-options` 32/32, `check:booking-confirm`
> 18/18, `check:eligibility` 29/29; WhatsApp checks unchanged;
> `pnpm verify` green + `pnpm security` pass. Prior:
> PROMPT-B02 — the **AI context builder is implemented (DECISIONS #51,
> uncommitted)**: the explicit boundary that makes the B-01 visibility
> policy operational at the AI boundary —
> `src/features/conversations/server/ai-context-builder/` classifies the
> engine's already-loaded source facts through the B-01 pipeline, proves
> tenant scope, gates CONDITIONAL facts on builder-derived task relevance,
> omits INTERNAL operational facts the task does not require (service
> `durationMinutes` and raw `workingHours` never enter context merely
> because they exist; availability enters only as the CORE-02 result),
> drops provenance, and composes the minimal `AiRequest`. The engine's
> inline context construction is now `buildAiContext`; output keeps
> "AI may know" (`request`) and "AI may mention" (disclosure ledger)
> distinct. `serviceFactSchema.durationMinutes` became OPTIONAL
> (backwards compatible) — the only contract change.
> `pnpm check:ai-context-builder` 39/39 (offline, in-memory, no
> DB/network/LLM/secrets); `check:knowledge-visibility` 36/36,
> `check:ai-prompts` 101/101, `check:ai-provider` 63/63,
> `check:conversation-booking` 16/16 all green. ZERO
> prompt/provider/handoff/booking/tenant/UI change; no new knowledge
> source. Prior:
> PROMPT-B01 — the **AI knowledge-visibility policy is established
> (DECISIONS #50, uncommitted, policy-only)**: the four levels
> `PUBLIC`/`CONDITIONAL`/`INTERNAL`/`FORBIDDEN` that control what is
> eligible to enter AI context and — separately — what the AI may mention
> to a customer, with source+tenant provenance, structural safe defaults,
> and the enumerated FORBIDDEN categories. Lives in
> `src/lib/ai-knowledge-visibility/`; `pnpm check:knowledge-visibility`
> 36/36 (offline, in-memory). It says WHAT may reach the AI; the Context
> Builder that applies it is now implemented (B-02, above). ZERO
> schema/migration/prompt/provider/handoff changes. Prior:
> WHATSAPP-ONBOARDING-RUNTIME-CREDENTIAL-STORE-01 — the RUNTIME backend for
> the `fp:<id>` credential-reference grammar is implemented (DECISIONS #49,
> uncommitted): credentials obtained at onboarding time are stored
> server-side in existing Neon Postgres under APPLICATION-SIDE AES-256-GCM
> (new additive migration `20260920140745_runtime_credentials`, ZERO new
> dependencies/vendors), only the opaque `credentialsRef` is persisted, and
> the ENV grammar + the operational gate are unchanged. New optional
> server-only `CREDENTIAL_MASTER_KEY` (unset ⇒ store UNAVAILABLE, fail
> closed). `pnpm check:credentials-runtime` 36/36; onboarding 53/53;
> transport 27/27; Meta 17/17; inbound 13/13. Meta Embedded Signup itself
> remains the next major slice (gated on operator-owned Meta App Dashboard
> configuration). Prior: PROMPT-OPS-AI-PROMPT-WORKSPACE-FINALIZE-29 — the
> Prompt Workspace architecture is finalized and ledger-reconciled
> (DECISIONS #48, shipped as
> release **v0.19.1**, `04856ae`): LLM prompt bodies live only in
> `/prompts/**/*.prompt`, are compiled by `pnpm generate:ai-prompts` into the
> committed `src/generated/ai-prompts.generated.ts`, and reach the runtime
> only through `prompt-registry.ts` (`getPromptBody`) — no inline bodies in
> TypeScript, no runtime filesystem read, no silent fallback, and the two
> relocated bodies are byte-identical to the removed constants so no prompt
> semantics changed. Production remains deployed at v0.19.0 (deploying
> v0.19.1 is an operator action). Next major slice: Meta Embedded Signup
> (gated on operator-owned Meta App Dashboard configuration). Prior:
> PROMPT-OPS-PILOT-BUSINESS-WHATSAPP-ONBOARDING-27 (v0.19.0, DECISIONS #47 —
> repeatable Business WhatsApp onboarding at `/settings/whatsapp`;
> `externalId`/`phone_number_id` authoritative; `credentialsRef` env-var-NAME
> only; read-only `ConnectionVerifier` verification; TEST→REAL replacement
> data-only; Meta Embedded Signup deliberately not implemented then);
> PROMPT-OPS-WHATSAPP-INBOUND-DEBUG-01; PROMPT-AI-03B; PROMPT-AI-03/02/01 +
> CORE-01/02/03A/03B remain IMPLEMENTED.

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
check:whatsapp-onboarding` 53/53; ONE additive migration
  (`20260919120000_whatsapp_onboarding_lifecycle`); NOT deployed.
  WHATSAPP-ONBOARDING-01 (uncommitted): the SEPARATE onboarding
  lifecycle + the provider-neutral `ConnectionAuthorizer` port
  (launch/exchange, no Meta SDK in the port), the server-persisted
  authorization ledger (callback Business resolved ONLY from the opaque
  `stateRef` — single-use, replay/cross-tenant safe), the
  `CredentialsResolver` reference boundary (ENV unchanged; RUNTIME
  grammar only, backend deferred), the read-only Super Admin projection
  (`/platform/businesses` + drill-down, masked ids, no credential
  value), and a non-blocking WhatsApp card on onboarding review. The
  wired adapter is a DETERMINISTIC stand-in — real Meta HTTP stays
  deferred behind the DECISIONS #47 operator gate and implements the
  same port. The operational gate `status === "CONNECTED" && isActive`
  is UNCHANGED and the lifecycle is never consumed by it.
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
- **AI KNOWLEDGE-VISIBILITY POLICY (PROMPT-B01; DECISIONS #50; uncommitted,
  policy-only):** the enforceable policy for what information is ELIGIBLE
  to enter AI context, established before the Context Builder (B-02).
  `src/lib/ai-knowledge-visibility/` defines the four levels — `PUBLIC`
  (AI knows + communicates: business name/about, the `Business.faqs`
  store, service name/description, the customer's own message),
  `CONDITIONAL` (only when the task makes it relevant: cancellation
  policy, domain-computed availability, provider preference — relevance
  comes from the Context Builder, NEVER from the AI), `INTERNAL` (AI may
  know, never mention: working hours, slot duration, confirmation mode,
  conversation status, discovery metadata), `FORBIDDEN` (never enters
  context). It separates "AI may know this" (`isEligibleForAiContext`)
  from "AI may mention this" (`isDisclosable`) — INTERNAL is eligible but
  never customer-visible; CONDITIONAL is gated on task relevance. Safe
  defaults are STRUCTURAL via `enrollFact`: unknown visibility ⇒ do not
  expose to the customer; missing provenance ⇒ exclude; unproven tenant ⇒
  exclude; FORBIDDEN candidates are refused outright. FORBIDDEN covers
  the minimum set as an ENUMERATED policy (tokens, secrets, keys, raw
  credential material, raw DB records, hidden prompts, cross-tenant data)
  — NOT string redaction, NOT a word blacklist. Provenance (`source` +
  server-derived `businessId` + `visibility`) is builder-side metadata,
  never prompt content; there is still exactly ONE tenant-resolution
  mechanism. Reuses the ONE canonical `Business.faqs` store (classified
  `PUBLIC` as a whole — no per-entry metadata) and the credential-
  reference boundary; duplicates nothing. `pnpm
check:knowledge-visibility` 36/36 (offline, in-memory). Canonical:
  `docs/ai/ARCHITECTURE.md → Knowledge visibility policy`.
- **AI CONTEXT BUILDER (PROMPT-B02; DECISIONS #51; uncommitted):** the
  explicit AI boundary that makes B-01 operational —
  `src/features/conversations/server/ai-context-builder/` receives the
  source facts the engine ALREADY loaded (Business record, service
  catalog, conversation state, the customer message, and when resolved
  domain-computed availability / a captured provider preference) plus the
  server-derived tenant scope, and runs each candidate through the B-01
  pipeline (`classify*` → `enrollFact` → `isWithinTenantScope` → budget +
  task gate → `isEligibleForAiContext` / `isDisclosable`). It composes the
  minimal `AiRequest` and DROPS provenance; it emits the DISCLOSURE LEDGER
  (every candidate's `included`/`disclosable` verdicts + typed reason) so
  "AI may know" and "AI may mention" stay distinct for the later B-03.
  Operational/internal facts are NOT forwarded merely because they exist:
  `workingHours` / `slotDurationMinutes` / `confirmationMode` / `timezone`
  / discovery metadata are omitted unless the task requires them, and
  service `durationMinutes` never enters merely because a service has one
  (it became an OPTIONAL `serviceFactSchema` field — the only contract
  change, backwards compatible; `buildPromptMessages` renders it only when
  present). Availability enters ONLY as the CORE-02-derived result, never
  as raw schedules. The ONE documented INTERNAL dependency is
  `conversationStatus` (phrasing; stays non-disclosable). Task relevance
  is derived by the builder (`deriveTaskRelevance`) — never the AI. Fail
  closed: missing provenance / unproven tenant (incl. blank scope) /
  unknown visibility / FORBIDDEN candidates are excluded with a typed
  reason, never guessed. `conversation-engine.ts`'s inline construction is
  replaced by `buildAiContext`; the emitted request is identical to before
  MINUS the omitted duration. `pnpm check:ai-context-builder` 39/39
  (offline, in-memory, no DB/network/LLM/secrets). No new knowledge source,
  no prompt/provider/handoff/booking/tenant/UI change. The currently-absent
  CONDITIONAL facts (`cancellationPolicy`, `whatsappNumber`) are classified
  - ledgered but NOT yet wired into the request — that wiring, and the
    customer-facing behavior of operational facts, is B-03. Canonical:
    `docs/ai/ARCHITECTURE.md → AI context builder`.
- **AI CUSTOMER DISCLOSURE BOUNDARY LIVE (PROMPT-B03; DECISIONS #52):**
  `src/features/conversations/server/ai-disclosure/` is the enforcement gate
  a validated `AiResponse` crosses on the generic reply path of
  `conversation-engine.ts`, immediately before its text is persisted and
  sent — the only place assistant-authored free text can reach a customer
  (booking/availability content is domain-authored via CORE-01/CORE-02 and
  never crosses the gate). "AI may know this" is no longer equivalent to
  "AI may mention this": a routing action (`handoff`/`booking_handoff`) is
  the fallback channel and passes through unchanged; a self-authored reply
  is emitted only when its declared task is backed by a ledger fact that is
  `included` AND `disclosable` AND carried in the request (`FAQ` →
  `business.faqs`; `BOOKING`/`AVAILABILITY` → `domain.availability`;
  `CANCELLATION`/`RESCHEDULE` → `business.cancellationPolicy`, which has NO
  request channel today so those tasks stay on the staff path). The decision
  is STRUCTURAL (action + intent + ledger verdicts) — no text inspection, no
  redaction, no LLM judge; a refused reply is dropped wholesale (never
  persisted, never sent) and the turn takes the SAME `NEED_HUMAN` /
  `AI_HANDOFF` path an invalid/failed AI result already takes. INTERNAL
  operational facts can never back a reply — service `durationMinutes` is
  NOT disclosed merely because the service record contains it; customers see
  domain-computed outcomes, never operational metadata. Typed decisions
  `disclosed` / `requires-human` with operator-only reasons (never
  customer-visible; no policy name, provenance, classification, provider or
  Meta terminology ever surfaces). `pnpm check:ai-disclosure` 32/32
  (offline, in-memory, no DB/network/LLM/secrets). No schema/migration, no
  prompt body, no provider, no booking/availability authority, no transport,
  no tenant resolution, no UI change. DELIBERATE deferrals (evidence
  insufficient, behavior unchanged): the `cancellationPolicy` /
  `whatsappNumber` request channels and the human-notification UX are later
  slices. Canonical: `docs/ai/ARCHITECTURE.md → Customer disclosure
boundary`.
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
- **PROMPT WORKSPACE ARCHITECTURE — FINALIZED + RECONCILED
  (PROMPT-OPS-AI-PROMPT-WORKSPACE-ARCHITECTURE-01 + finalize; DECISIONS #48;
  shipped as release v0.19.1):** LLM prompt bodies are source-controlled
  artifacts, not inline TypeScript. Chain:
  `prompts/**/*.prompt` → `pnpm generate:ai-prompts` (deterministic
  build-time compiler) → committed
  `src/generated/ai-prompts.generated.ts` → `prompt-registry.ts`
  (`getPromptBody`) → `buildPromptMessages()` (every adapter) +
  `createAtriaAdapter()` (Atria-only augmentation). Two real bodies only:
  `system.booking-assistant`, `providers.atria.json-output`. Registry holds
  no bodies and throws on unknown/ungenerated ids (no silent fallback);
  `--check` + `pnpm check:ai-prompts` prove registry ↔ files ↔ committed
  artifact agree; `pnpm dev`/`pnpm build` regenerate first. **Semantic
  preservation PROVEN:** both bodies are byte-identical to the removed
  inline `[...lines].join(" ")` constants (1065 + 396 chars,
  character-for-character), so NO AI/booking/availability/conversation/
  provider/transport/Meta behavior changed. Deterministic classifier rules
  (`booking-intent@v1` … `human-request@v1`) REMAIN CODE-OWNED in
  `conversation-ai.ts` — not `.prompt` files, not in `PROMPT_REGISTRY`;
  `docs/ai/PROMPTS.md` is a body-free catalog. Gates: `generate:ai-prompts
--check` fresh, `check:ai-prompts` 101/101, `check:ai-provider` 63/63,
  `check:atria-retry` 17/17, `check:conversation-booking` 16/16,
  `verify` + `security` green. ZERO schema/migration changes. Canonical
  boundary doc: `docs/ai/ARCHITECTURE.md → Prompt Workspace`.
- **Version:** **v0.19.1** — released and committed (`04856ae`, tag
  `v0.19.1`; HEAD == `origin/main`). Production `GET /api/health` was
  verified live at **v0.19.0** (2026-09-19) in the pre-refactor ledger
  entry; the v0.19.1 Prompt Workspace release is committed but **NOT yet
  deployed** — deploying it is an operator action (prompt-text relocation +
  generator/registry/doc wiring only; no migration, no behavior change).
  The v0.16.0/v0.15.9 mentions in this snapshot are the pre-release
  checkpoint and are superseded by the v0.19.0/v0.19.1 releases. Single
  `main` branch, tags through `v0.19.1`. **PROMPT-AI-03 WIRED 2026-09-16 —
  mapper → CORE-01 → CORE-02, zero mutation** · **Production RECONCILED +
  LIVE E2E VERIFIED** (at the v0.15.9 checkpoint) — 5 `WHATSAPP_META_*` set,
  webhook 200, `WhatsAppConnection e5e2e2f7`,
  inbound+idempotency+isolation+error taxonomy live-verified
  (PROMPT-OPS-06 §3/5/6/7–11).

**Current next step (Prompt Workspace architecture FINALIZED + RECONCILED — DECISIONS #48; shipped as release v0.19.1; the only uncommitted work is this documentation/ledger reconciliation, which the operator reviews then `pnpm ship patch`):** the prompt layer is now source-controlled, generated, and drift-guarded — `/prompts/**/*.prompt` is the only prompt-body source of truth, `prompt-registry.ts` is the only runtime lookup boundary, and prompt semantics are provably unchanged (byte-identical bodies). PROMPT-AI-03/03B deterministic booking seam remains wired AND CLOSED; PROMPT-AI-02 policy-backed `ConversationAi` wired; PROMPT-AI-01 binding (DECISIONS #43) and CORE-01/02/03A/03B remain IMPLEMENTED; WhatsApp live (DECISIONS #42/#46). **Next major implementation slice: Meta Embedded Signup** (deferred by DECISIONS #47 — the code-side seam is now LANDED (WHATSAPP-ONBOARDING-01, uncommitted): redirect handling + server-side code exchange + the single-use `stateRef` ledger + persisting `phone_number_id`/`credentialsRef` through the EXISTING `/settings/whatsapp` surface and `ConnectionVerifier` port, all behind the provider-neutral `ConnectionAuthorizer` port and driven by a DETERMINISTIC stand-in adapter; it is GATED on operator-owned external Meta App Dashboard configuration — app approval for WhatsApp Business login + registered redirect URI + client id/secret in deployment env — which is exactly why #47 did not fake it; it is a paired operator+code task, and the real adapter now only has to implement the existing port). Then: onboarding the first REAL pilot Business end-to-end + Spec A/UX/pilot-readiness work, then Spec B instrumentation/economics only after pilot evidence justifies it. Parallel operator actions (not blockers): add `OPENROUTER_API_KEY`/`AGENTROUTER_API_KEY`/`ATRIA_API_KEY` to Vercel env (#7) + `pnpm db:deploy` Demo DB (#8) + deploy the released head (production remains at v0.19.0).
