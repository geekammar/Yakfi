# FlowPilot — Build State

> ⚠️ THE authoritative current-state ledger — the single answer to "what is
> the state of FlowPilot?". Every agent MUST read it before starting work and
> MUST update it after finishing a prompt. Keep updates MINIMAL: status,
> completed work, known issues, next step — not a historical diary.
> Historical implementation detail lives in Git history (`git log --oneline`,
> `git show <commit>`, release tags) and `DECISIONS.md`.
> Last updated: PROMPT-OPS-AI-PROMPT-WORKSPACE-FINALIZE-29 — the Prompt
> Workspace architecture is finalized and reconciled (DECISIONS #48): LLM
> prompt bodies live only in `/prompts/**/*.prompt`
> (`system.booking-assistant`, `providers.atria.json-output`), a deterministic
> build-time generator (`pnpm generate:ai-prompts`) compiles them into the
> committed runtime artifact
> `src/generated/ai-prompts.generated.ts`, and the runtime loads bodies ONLY
> through `prompt-registry.ts` (`getPromptBody`) — no inline prompt bodies in
> TypeScript, no runtime filesystem access, no silent fallback. The two
> relocated bodies are byte-identical to the removed inline constants
> (1065 + 396 chars), so NO prompt semantics changed; deterministic
> classifier rules stayed code-owned. Shipped by the operator as
> **release v0.19.1** (`04856ae`, tag `v0.19.1`). Gates at release:
> `generate:ai-prompts --check` fresh, `check:ai-prompts` 101/101,
> `check:ai-provider` 63/63, `check:atria-retry` 17/17,
> `check:conversation-booking` 16/16, `verify` + `security` green.
> Prior: PROMPT-OPS-PILOT-BUSINESS-WHATSAPP-ONBOARDING-27 (v0.19.0,
> DECISIONS #47); PROMPT-OPS-WHATSAPP-INBOUND-DEBUG-01; PROMPT-AI-03B;
> PROMPT-AI-03/02/01 + CORE-01/02/03A/03B remain IMPLEMENTED.
> Product version: **v0.19.1** — released and committed (`04856ae`, tag
> `v0.19.1`; HEAD == `origin/main`). The Prompt Workspace slice (release
> v0.19.1) is documentation-reconciled but NOT yet deployed: production was
> last verified live at **v0.19.0** (`deploymentReady:true`,
> `database:connected`, `missingEnvVars:[]`, 2026-09-19) per the pre-refactor
> ledger entry below, so deploying v0.19.1 remains an operator action. The
> v0.16.0/v0.15.9 statements below in this ledger are the pre-release
> historical checkpoint and are superseded by the v0.19.0/v0.19.1 releases
> (see Ops State).

## Current State (summary)

**Runtime Credential Backend — IMPLEMENTED
(WHATSAPP-ONBOARDING-RUNTIME-CREDENTIAL-STORE-01; DECISIONS #49;
additive, one new migration, ZERO behavior change to the ENV path or the
operational gate):** the missing RUNTIME storage layer for the `fp:<id>`
credential-reference grammar (the boundary was landed in #47; the backend
was honestly deferred). A credential obtained at runtime can now be stored
safely server-side, with only the opaque `credentialsRef` persisted on the
connection — NO operator paste into Vercel Environment Variables and NO
redeploy per customer. **Storage decision:** existing Neon Postgres (the
smallest already-provisioned production-capable backend; there is NO
Redis/KV/Vault/KMS dependency in the repo and none was added) with
APPLICATION-SIDE authenticated encryption. **New table
`runtime_credentials`** (migration `20260920140745_runtime_credentials`,
additive) keyed by the opaque `credentialsRef` — never a phone number,
business name, email, or provider-owned id — plus `business_id` (tenant
isolation + cascade); the record holds ONLY ciphertext + safe metadata
(`cipher_blob` / `algorithm` / `key_version`). **Crypto**
(`src/server/credentials/credential-crypto.ts`): AES-256-GCM from Node's
built-in `node:crypto` (ZERO new dependencies), unique 96-bit IV per
credential, 128-bit auth tag inside the blob, versioned package (`v1:` +
base64(iv‖ciphertext‖tag)); tampering/truncation/unknown-version/wrong-key
all fail CLOSED — never a wrong plaintext. **Master key:** NEW optional
server-only `CREDENTIAL_MASTER_KEY` (32 random bytes, hex or base64) —
never in the DB/logs/API/projections, never `NEXT_PUBLIC_`; while unset the
store is UNAVAILABLE and every `fp:<id>` store/resolve fails closed (the
app boots and runs without it). Master-key rotation is a LATER operational
concern (`key_version` is the hook); no KMS or key wrapping is built.
**Layering:** `RuntimeCredentialRepository` is ciphertext-only by
construction (decryption one layer up in the store), preserving the
repository-only-DB-access rule. **Boundary:** `CredentialsResolver` gained
additive `store`/`delete` (ENV answers an honest `UNSUPPORTED_KIND`);
`DefaultCredentialsResolver` routes ENV→`process.env` (UNCHANGED) and
RUNTIME→`RuntimeCredentialStore`; `mintRuntimeCredentialReference()` mints
the grammar-validated opaque handle. The secret crosses the boundary
EXACTLY once, at the server-side `resolve` an adapter consumes — never in
logs, thrown/serialized errors, Prisma model fields, domain payloads, DB
projections, Super Admin surfaces, or customer UI. **Adapter compatibility
(strictly necessary only):** `resolveMetaClientConfig`/`resolveMetaVerifyConfig`
resolve `credentialsRef` through `CredentialsResolver` (both became async;
production factories pass `defaultCredentialsResolver`) so a RUNTIME
reference can actually resolve at send/verify time. **Proven:** NEW
`pnpm check:credentials-runtime` 36/36; existing checks UNCHANGED —
`check:whatsapp-onboarding` 53/53 (one expectation updated from the old
deferred `UNSUPPORTED_KIND` to the implemented honest `UNRESOLVED_REFERENCE`),
`check:whatsapp-transport` 27/27, `check:meta-whatsapp` 17/17,
`check:whatsapp-inbound` 13/13; `pnpm typecheck`/`pnpm lint`/`pnpm security`
green. **NOT built (deferred):** Meta OAuth/code exchange, Embedded Signup,
token rotation/refresh, any credential UI, Super Admin credential
management, listing/rotation/admin endpoints, KMS. The operational gate
`status === "CONNECTED" && isActive` is untouched.

**Prompt Workspace Architecture — FINALIZED and RECONCILED
(PROMPT-OPS-AI-PROMPT-WORKSPACE-ARCHITECTURE-01 + finalize; DECISIONS #48;
shipped as release v0.19.1):** LLM prompt bodies are source-controlled
artifacts, no longer inline TypeScript. The chain is
`prompts/**/*.prompt` → `pnpm generate:ai-prompts` (deterministic build-time
compiler: drops blank/`#`-comment lines, trims, joins with a single space,
sorts by id, `JSON.stringify` + per-body `sha256`) → the COMMITTED artifact
`src/generated/ai-prompts.generated.ts` → `prompt-registry.ts`
(`PROMPT_REGISTRY` + `getPromptBody(id)`) → `buildPromptMessages()`
(every adapter) and `createAtriaAdapter()` (Atria-only augmentation). Two
real prompt bodies only: `system.booking-assistant`
(`prompts/system/booking-assistant.prompt`) and
`providers.atria.json-output`
(`prompts/providers/atria-json-output.prompt`). The registry holds NO bodies,
THROWS on unknown/unregistered ids (no silent fallback), and the `--check`
drift guard + `check:ai-prompts` prove registry ↔ files ↔ committed artifact
agree. `pnpm dev`/`pnpm build` regenerate first, so a stale artifact cannot
reach a build. **Semantic preservation — PROVEN, not assumed:** the compile
rule is byte-identical to the removed `[...lines].join(" ")` constants
(extracted from `123dfaa` and compared character-for-character: 1065 and
396 chars, both IDENTICAL), so AI system behavior, the Atria output
contract, booking, availability, conversation-control, provider policy,
WhatsApp transport, and Meta integration are all unchanged. Deterministic
classifier rules (`booking-intent@v1` etc.) REMAIN CODE-OWNED in
`conversation-ai.ts` — not `.prompt` files, not in `PROMPT_REGISTRY`, never
sent to an LLM; `docs/ai/PROMPTS.md` is a body-free CATALOG;
`docs/ai/ARCHITECTURE.md` records the layer ownership table. `prompts/` is
in `.prettierignore` (prompt text never reformatted by tooling); the
generated artifact is the single committed exception to the `src/generated`
ignore. Export surface of `prompt.ts`/`atria.ts` unchanged. ZERO
schema/migration, booking, availability, conversation-control,
provider-policy, WhatsApp-transport, Meta changes.

**Business WhatsApp Connection Onboarding is IMPLEMENTED
(PROMPT-OPS-PILOT-BUSINESS-WHATSAPP-ONBOARDING-27; DECISIONS #47):** the
repeatable pilot setup surface — a Business Admin connects/configures a
WhatsApp number, verifies it read-only, and activates it, all through
`/settings/whatsapp` (new feature `src/features/whatsapp-connection` +
settings sub-route linked from `/settings`). ADMIN-only with the Business
derived server-side from the authenticated actor (never client input);
`externalId` (Meta `phone_number_id`) is the authoritative identity;
`credentialsRef` is an environment-variable NAME only (raw-token shape
rejected by Zod); the read-only `ConnectionVerifier` port (transport
boundary) + Meta adapter `meta-verify.ts` prove the connection is usable
via a single `GET /{apiVersion}/{phone_number_id}` — NO customer message
is ever sent; duplicate `externalId` protection is service-layer
(DECISIONS #23 check-then-create); the EXISTING status model is reused
(PENDING/CONNECTED/DISCONNECTED + isActive — no parallel state system);
the UI shows only non-secret identifiers with a MASKED `phone_number_id`.
TEST→REAL replacement is data-only (Business Admin saves the real id +
per-connection `credentialsRef`; operator stores the token in the
deployment env; verify → CONNECTED → resolvable by the unchanged engine).
Meta Embedded Signup is deliberately NOT implemented (needs external
Meta dashboard/app config — operator prerequisites documented, nothing
faked). Proven by `pnpm check:whatsapp-onboarding` 53/53; the WhatsApp
onboarding lifecycle slice (WHATSAPP-ONBOARDING-01) is implemented
against a DETERMINISTIC stand-in adapter — see below — while the real
Meta adapter stays deferred behind the same `ConnectionAuthorizer`
port. Schema/migration: ONE additive migration
(`20260919120000_whatsapp_onboarding_lifecycle`) — the separate
onboarding lifecycle surface + the authorization ledger.

**WhatsApp Onboarding Lifecycle (WHATSAPP-ONBOARDING-01)** — the
SEPARATE onboarding lifecycle of a Business-owned connection, beside
the unchanged operational gate. `onboardingState`
(NOT_STARTED/AUTHORIZING/PROVISIONING/ACTION_REQUIRED/READY/FAILED) +
`onboardingActor` + normalized last-failure diagnostics + Meta
provenance (reference-only) + `credentialKind` (ENV/RUNTIME) live on
`whatsapp_connections`; the runtime send/inbound gate stays exactly
`status === "CONNECTED" && isActive` and never reads the lifecycle.
`READY` has ONE write path (`markOnboardingReady` — a conditional
update guarded by the operational gate), so an onboarding-READY row is
always operationally usable. The provider callback is server-resolved,
single-use, and tenant-safe: the target Business comes ONLY from the
persisted authorization ledger (`stateRef`), never from the query, the
client, or the session; replay/expiry/cross-tenant all fail to match
and write nothing. Super Admin gets a READ-ONLY projection
(`toOverview()` — `/platform/businesses` + drill-down; no credential
value, masked provider ids). A non-blocking WhatsApp card on
onboarding review + `/settings/whatsapp` remains the canonical surface;
no raw token, Graph payload, or provider text is persisted anywhere.
Verified 53/53 offline (no DB, no network, no Meta call).

**Spec A — Discovery Foundation + Booking Core** (frozen scope: `SPEC_A.md`)
is **implemented and verified through PROMPT-19**. All Spec A screens exist:
dashboard, conversations inbox + detail, appointments agenda/detail, the
full Smart Create flow (steps 1–6: customer → service → date → slot →
review → التأكيد creating through the canonical `createAppointment` write
path), customers directory + detail, services, settings (+ knowledge), team
management, the STAFF workspace (`/staff` human-handoff queue), the
4-step onboarding wizard, and the invitation-first auth lifecycle (data
model → creation → acceptance → ADMIN/STAFF activation → activation UI →
role-aware sign-in handoff → onboarding handoff). PROMPT-19 added the
conversation engine slice: ONE provider-neutral inbound path
(`POST /api/conversations/inbound`, token-gated) → engine (business
resolved by receiving WhatsApp number, customer `upsertByPhone`,
latest-thread reuse) → typed AI turn → verbatim-FAQ reply OR NEED_HUMAN
→ reply persisted + delivered via `MessageTransport`. The ops toolchain is
complete (bootstrap/dev scripts, doctor/verify/security, gated releases,
ship path, Vercel deployment, demo dataset, pilot distribution).

**WhatsApp provider IMPLEMENTED as the Meta adapter (DECISIONS #42; #29
closed for WhatsApp):** Meta WhatsApp Cloud API (Graph API,
business-owned number) is the approved provider — the inbound adapter is
`GET|POST /api/whatsapp/meta` inside `src/server/integrations/whatsapp/`
behind the CORE-03A provider-neutral foundation; outbound
`createMetaWhatsAppTransport` posts to `graph.facebook.com/{v}/{
PHONE_NUMBER_ID}/messages` over the same foundation. **The AI transport is
intentionally NOT
integrated (DECISIONS #29):** the AI is still the deterministic Arabic
keyword/FAQ classifier behind `ConversationAi` (NO LLM) — the remaining
operator decision. The `/sign-up` placeholder page remains in code but is
superseded (invitation-first, DECISIONS #22). **PUBLIC SIGNUP IS CLOSED
(PROMPT-OPS-05):** the proxy refuses public `POST /api/auth/sign-up/email`
(403 `SIGNUP_CLOSED`); internal `auth.api.signUpEmail` (invitation
activation) is unaffected.

**Minimal Platform Control Plane is LIVE (PROMPT-OPS-05, DECISIONS #41;
deployed to Production + verified live in PROMPT-OPS-05.1):**
public signup closed (invitation-first preserved), Platform Operator
guard surface enforced (`requireUser`/`requireRole` redirect operators to
`/platform`; `requirePlatformOperator` guards the `(platform)` group),
the `(platform)` UI (overview / دعوات الملاك / سياسة الذكاء — Arabic
RTL), platform owner invitations (`platform_invitations` — pre-Business,
one-time hash-only tokens, activation → ADMIN credential → canonical
onboarding), and the Platform AI Policy (`platform_ai_policies` singleton
— OpenRouter primary / AgentRouter secondary, runtime-changeable,
secret REFERENCES only). One-time operator tool: `pnpm bootstrap:operator`
(creates the FIRST Platform Operator identity).

**Provider / Service Eligibility Resolver is IMPLEMENTED (PROMPT-CORE-01):**
deterministic `resolveEligibleProviders` (appointments feature server) —
relation-driven eligibility over the EXISTING ProviderService /
ProviderBranch relations (ZERO schema changes): server-resolved Business
scope (never client input; the input schema strips hostile identity
keys), optional Branch scope (existing Branch semantics), active Provider

- active same-Business Service required, cross-business leakage
  impossible (typed `SERVICE_NOT_FOUND` / `BRANCH_NOT_FOUND` — no
  cross-tenant existence leaks), compact AI-ready DTO (`providerId` +
  `displayName`, scope echoed; no secrets/auth fields). Proven by
  `pnpm check:eligibility` (29/29, in-memory harness). Not exposed in
  any UI/conversation turn yet — CORE-02 consumes it next.

**Any-Provider Booking Options Resolver is IMPLEMENTED (PROMPT-CORE-02):**
deterministic `resolveBookingOptions` (appointments feature server) —
CONSUMES CORE-01 (`resolveEligibleProviders` is the eligibility source of
truth; its typed errors pass through unchanged; eligibility is never
re-resolved) and computes availability for the eligible Providers over the
EXISTING deterministic Availability layer (the same business-hours logic,
slot model, and conflict rule — `resolveWorkingDay`/`weekdayOf`/
`generateCandidateSlots`/`filterConflictingSlots` are reused, never
duplicated): per-Provider conflicts are provider-scoped EXACTLY like the
booking write path (`listBlockingByAssignees` — the read counterpart of
the existing `assignedUserId` scoping in `hasConflict`/
`createWithConflictCheck`), ONE batched Business-scoped conflict read (no
N+1); deterministic nearest-useful ranking (`rankBookingOptions` — each
Provider's earliest slot ranks first by time then the stable CORE-01
order; backfill in global time order when fewer than `MAX_BOOKING_OPTIONS`
= 3 distinct options exist); result carries only serviceId/branchId/date/
timezone/preference (ANY|PROVIDER) + 2–3 compact options (`providerId`,
`displayName`, `startAt`, `endAt`) — never the full availability list,
never credentials/auth fields; explicit empty reasons
(NO_ELIGIBLE_PROVIDERS / BUSINESS_CLOSED / SERVICE_TOO_LONG /
FULLY_BOOKED); a requested Provider is verified against CORE-01
eligibility (`PROVIDER_NOT_ELIGIBLE` — cross-Business provider ids cannot
leak); READ-ONLY (no appointment write, no reservation, no LLM, no
WhatsApp — booking stays a later command); ZERO schema changes; proven by
`pnpm check:booking-options` (32/32, in-memory harness). Not exposed in
any UI/conversation turn yet — the Conversation/WhatsApp layer consumes
it next.

**WhatsApp Transport Foundation is IMPLEMENTED (PROMPT-CORE-03A; provider
boundary DECISIONS #42):** provider-neutral boundary
`src/server/transport/whatsapp-transport.ts` (the canonical replaceable seam
— **Meta WhatsApp Cloud API / Graph API, business-owned number** is the
selected provider): normalized inbound envelope +
`normalizeInboundTransportMessage` (`strict()` + TEXT<->MEDIA exclusivity;
hostile identity/secret keys rejected; `MALFORMED_PROVIDER_PAYLOAD` on shape
drift), outbound `OutboundMessage` -> `MessageTransport` (offline adapter
retained behind the seam; `resolveConnectionForSend` tenant-scoped +
`CONNECTED`/`isActive` gated; `credentialsRef` never returned), typed
`WhatsAppTransportErrorCode` taxonomy + `TransportError` (`retryable` = only
`TRANSIENT_TRANSPORT_FAILURE`; policy stays adapter-side; no HTTP status
leakage). Tenant/Branch resolution is server-derived
(`BusinessRepository.findByWhatsappNumber` +
`WhatsAppConnectionRepository` `findByPhone`/`findByIdWithinBusiness` +
`BranchRepository`; branch validated within Business; business-shared
`branchId=null` -> Default Branch). Conversations keeps the feature-local seam
via `src/features/conversations/server/conversation-transport.ts` (re-exports
canonical contracts + `offlineMessageTransport`). Proven by
`pnpm check:whatsapp-transport` (26/26, in-memory). **Meta adapter
IMPLEMENTED (PROMPT-CORE-03B)** inside `src/server/integrations/whatsapp/`
(`meta-webhook.ts` verify/signature/parse+normalize; `meta-client.ts`
Bearer outbound + `mapMetaError` + retry taxonomy; route
`GET|POST /api/whatsapp/meta` with `X-Hub-Signature-256`, idempotency via
the durable ledger + status callbacks counted not delivered, `revalidatePath`
on delivery). Proven by `pnpm check:meta-whatsapp` 15/15 + the updated
26/26 harness (Core stays free of Meta behind the adapter boundary; env
`WHATSAPP_META_*` in `src/lib/env.ts` empty->undefined via
`emptyToUndefined`). ZERO schema changes.

**Two strictly separated environments are LIVE (PROMPT-OPS-02; production
identity closed in PROMPT-OPS-04; OPS-05 build + live verification in
PROMPT-OPS-05.1):**
PRODUCTION `https://flowpilot-prod.vercel.app` — Neon production DB
(`ep-tiny-grass-a5e63jev-pooler`; chain 10/10, schema diff clean), first
ADMIN identity bootstrapped (PROMPT-OPS-04) and Production onboarding
COMPLETED (1 Business + ADMIN attached — verified at the DB level in
PROMPT-OPS-05.1; 0 demo data), Platform Operator identity verified
(STAFF, `account_type=PLATFORM`, isActive), redeployed with the
PROMPT-OPS-05 worktree (build includes `/platform`, `/platform/ai-policy`,
`/platform/invitations`, `/owner-invite/[token]`). Live verification
PASSED (PROMPT-OPS-05.1): health `deploymentReady:true/database:connected`,
sign-in 200 (Arabic RTL), anonymous `/` + business routes → 307
`/sign-in?redirect=…`, public signup 403 `SIGNUP_CLOSED`, all three
platform routes guard-engaged (anonymous → 307 `/sign-in`), owner-invite
page resolves with a safe invalid-token state, AI-policy values verified
at the DB level (openrouter / agentrouter / fallback=true), no key
material in public responses. Authenticated RBAC smoke (operator reaches
`/platform`, ADMIN/STAFF refused) was SKIPPED per operator decision —
guard surface verified at code + DB level. DEMO
`https://flowpilot-demo-gamma.vercel.app` —
separate Vercel project (`flowpilot-demo`, framework nextjs, SSO
protection disabled) + the isolated Demo Neon DB (`neondb` @
`ep-weathered-feather-aef123ef-pooler`, fully EMPTY before this prompt —
bootstrapped via the chain, seeded ×2 deterministic/idempotent: 1
business, 1 Default Branch, 2 team users, 6 services, 36 customers, 22
conversations, 73 messages, 37 appointments; dedicated Better Auth
secret; demo URLs; `DEMO_MODE=true` project env var). Demo Admin + Staff
sign in end-to-end (dashboard, conversations, appointments, admin-only
areas; staff workspace NEED_HUMAN queue; role isolation verified:
STAFF redirected from `/admin/team`, ADMIN redirected from `/staff`,
services data never rendered for STAFF). Demo credentials exist ONLY in
the Demo DB (Production DB: 1 ADMIN identity from the PROMPT-OPS-04
bootstrap, 0 businesses). NOTE: the demo
project's production domain is `flowpilot-demo-gamma.vercel.app` — the
suggested `flowpilot-demo.vercel.app` is owned by an unrelated third
party.

**Next implementation phase — architecture hardening: the P0 foundations
are IMPLEMENTED (PROMPT-ARCH-02, DECISIONS #38).** Branch model (with
Default-Branch backfill), WhatsAppConnection, Provider relations,
platform-operator marker, durable inbound-webhook idempotency,
DB-serializable booking concurrency, the structured AI contract with
deterministic bypass, and append-only usage telemetry all exist in the
schema and code. The migration chain is repaired and complete
(PROMPT-ARCH-03, DECISIONS #40; extended in PROMPT-OPS-02 with
`20260913150000_account_issuer` — 9/9; 10/10 since PROMPT-OPS-05): an
empty database bootstraps
fully via `pnpm db:deploy`; the old Demo/Neon database was found
completely EMPTY in PROMPT-OPS-02 and became the isolated Demo DB (see
the PROMPT-OPS-02 row). The two real
provider integrations (WhatsApp transport, LLM) remain pending operator
decisions (DECISIONS #29).

**Quality:** `WHATSAPP-ONBOARDING-01` verified — `pnpm check:whatsapp-onboarding` 53/53 (onboarding lifecycle, authorization ledger, credentials boundary, operator projection; NEW) + `check:whatsapp-transport` 27/27 + `check:meta-whatsapp` 17/17 + `check:whatsapp-inbound` 13/13 + `check:conversation-control` 50/50 + `check:booking-confirm` 18/18 + `check:policy` 13/13 + `pnpm lint`/`typecheck`/`format:check`/`verify` green; ONE additive migration (`20260919120000_whatsapp_onboarding_lifecycle`, not yet applied to the dev database). Prior `PROMPT-OPS-PILOT-BUSINESS-WHATSAPP-ONBOARDING-27` verified — `pnpm check:whatsapp-onboarding` 22/22; ZERO schema/migration changes. Prior `PROMPT-AI-03B` verified 2026-09-16 — `pnpm check:conversation-booking` 16/16 + `pnpm check:ai-provider` 29/29 + `pnpm check:ai-prompts` 106/106 + `pnpm check:eligibility` 29/29 + `pnpm check:booking-options` 32/32 + `pnpm lint` pass + `pnpm typecheck` pass + `pnpm format:check` pass + `pnpm verify` green (lint/typecheck/format/build) + `pnpm security` pass (with warnings — dual .env files); `pnpm db:generate` OK; historic `pnpm run doctor` NOT READY on device only (placeholder `DATABASE_URL`). `PROMPT-AI-03B` re-verified 2026-09-16 — `pnpm check:booking-confirm` 18/18 + `pnpm check:conversation-booking` 16/16 + `pnpm check:ai-prompts` 106/106 + `pnpm check:eligibility` 29/29 + `pnpm check:booking-options` 32/32 + `pnpm lint`/`typecheck`/`format:check`/`verify`/`security` green; ZERO schema changes.

## Completed Major Work

| Area                                   | Highlights                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Release          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Foundation                             | Next.js 16 + TS strict + Tailwind v4 + shadcn/ui, Better Auth, Prisma 7 / Neon, feature-based modular monolith, env fail-fast, PWA                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | v0.1.0           |
| Design system / RTL / PWA              | Arabic-first RTL tokens, AppShell (desktop right sidebar / mobile bottom nav), status system, PNG PWA icons                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | v0.1.0           |
| Database layer                         | Full Spec A domain model + Invitation, repositories (only Prisma consumers), Zod DTOs, Arabic demo seed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | v0.1.0           |
| Onboarding wizard                      | 4-step operational-foundation wizard, smart resume, step guards, server-side completion guard, `Business.vertical` discovery metadata                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | v0.1.0 → v0.6.0  |
| Dashboard                              | Today-focused Admin dashboard (conversations needing attention, pending/confirmed appointments, today's agenda, quick actions)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | v0.1.0           |
| Conversations                          | Inbox (search, status/assignee filters) + tenant-scoped detail thread, staff replies (transactional, optimistic), assignment/status actions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | v0.1.0           |
| Appointments                           | Agenda view by day + filters, detail with lifecycle actions, conflict-checked create/reschedule, status transition rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | v0.1.0           |
| Polish pass                            | Loading/error/empty states everywhere, a11y fixes, Arabic pluralization, honest placeholders                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | v0.1.0           |
| Auth architecture alignment            | Invitation-first model locked (docs only): ONE Better Auth system, PLATFORM vs BUSINESS scopes, ADMIN/STAFF only, Platform Operator ≠ Business role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | DECISIONS #22    |
| Invitation foundation                  | Secure token creation (hash-only persistence, 7-day expiry, duplicate-open guard), one-time atomic acceptance, ADMIN activation (Better Auth identity + membership, one-time `activatedAt`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | v0.2.0–v0.4.0    |
| Activation UI                          | Public `/invite/[token]` route: read-only pre-screen, activation form, typed Arabic states, safe sign-in → onboarding handoff; `/onboarding` ADMIN-only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | v0.5.0           |
| Onboarding UX completion               | Restructured to 4 steps, `vertical` metadata, smart resume redirector, review summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | v0.6.0           |
| Services management                    | `/services`: list/create/edit/activate/deactivate, ADMIN-only, tenant-scoped, role-scoped nav                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | v0.7.0           |
| Business settings                      | `/settings`: identity + booking behavior, `Business.confirmationMode` drives server-derived initial appointment status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | v0.8.0           |
| Smart availability                     | Deterministic `getAvailability` (working hours + timezone + slot step + duration fit + conflict rule); `getAvailabilityAction` hook                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | v0.9.0           |
| Smart Create steps 1–3                 | Customer search → service selection → date selection (6-step indicator, selections never reset)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | v0.10.0          |
| Smart Create step 4                    | Real available-slot selection consuming the availability layer; explicit no-slots reasons; stale-selection protection                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | v0.11.0          |
| Smart Create step 5                    | Review with per-section تعديل affordances, missing-input protection, on-demand slot revalidation; verified review = hand-off to Step 6                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | v0.12.0          |
| Smart Create step 6                    | التأكيد: final read-only summary + confirmation-mode behavior → creates through the canonical `createAppointment` path; typed failures incl. `SLOT_CONFLICT` recovery to Step 4; server-confirmed success state + detail-page navigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | v0.13.0          |
| Customers directory                    | `/customers`: server-backed debounced search (name/phone), rows with last conversation/appointment, honest states; `/customers/[id]`: identity + notes + appointment/conversation history, all rows navigable; ONE canonical creation path (`createCustomerAction` → customers service, typed `DUPLICATE_PHONE`); Smart Create Step 1 composes the same create dialog (route-layer composition)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | PROMPT-15        |
| Team management                        | `/admin/team`: member directory (identity, ADMIN/STAFF role, active state, self marker), open STAFF invitations (pending/accepted states), ONE canonical add-staff path (`createStaffInvitation` → existing `createInvitation` service; email-only input, ADMIN-only, tenant-scoped, fixed STAFF role), one-time manual invite-link delivery in `StaffInviteDialog`, STAFF activate/deactivate via `User.isActive` (ADMIN targets blocked — no lockout); invited-account activation generalized to invitation-role-driven (`activateInvitedMember`/`activateInvitedAccount`, DECISIONS #27) — `/invite/[token]` activates BOTH roles with role-aware sign-in handoff (STAFF never sent to onboarding)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | PROMPT-16        |
| Staff workspace                        | `/staff` (STAFF-only, `(staff)` group): the human-handoff workspace — NEED_HUMAN queue (unassigned → mine → others) with takeover via the EXISTING `transitionConversation` action route-injected (one assignment system), assigned-to-me section, customer/last-message/status/activity/latest-appointment context rows; navigation made role-aware (staff see مهامي، not the admin dashboard); reply no longer silently reassigns owned conversations; conversation detail gains takeover for unassigned NEED_HUMAN (PROMPT-17, DECISIONS #28)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | PROMPT-17        |
| Business knowledge                     | `/settings/knowledge`: ADMIN-only management of the plain-text FAQ/knowledge entries the future AI assistant will use (create/list/edit/confirmed remove, empty/loading/error/success states, question-as-natural-key semantics) over the canonical `Business.faqs` JSON field — ZERO schema changes, no RAG/vector/embeddings (PROMPT-18)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | PROMPT-18        |
| Conversation engine                    | PROMPT-19 (DECISIONS #29): ONE canonical inbound path `POST /api/conversations/inbound` (token-gated by optional `INBOUND_WEBHOOK_TOKEN`, disabled/503 while unset) → `receiveInboundMessage` engine: business resolved ONLY by receiving WhatsApp number, customer `upsertByPhone`, latest-conversation reuse, CUSTOMER message persisted via the single `addMessage` write path (transport-owned `receivedAt` preserved), typed AI turn (`ConversationAi` interface — deterministic Arabic keyword/FAQ classifier, NO LLM) → verbatim-FAQ reply OR NEED_HUMAN handoff (all booking intents, ambiguity, sensitive language, human requests; booking handoffs note the intent in `aiSummary`), AI reply persisted + delivered via `MessageTransport` (offline logging adapter, NO live WhatsApp); engine never creates appointments; ZERO schema changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | PROMPT-19        |
| Architecture hardening (P0)            | PROMPT-ARCH-02 (DECISIONS #38, implementing #30–#36): migration `20260910120000_architecture_hardening_foundation` — **Branch** model (`Business.defaultBranchId` one-to-one pointer; Default Branch created atomically with every Business + backfilled; required `branchId` on Conversation/Appointment, server-resolved to the Default Branch, single-Branch UX unchanged); **WhatsAppConnection** (businessId required / branchId optional, provider-neutral identity, machine-key status, `credentialsRef` secret REFERENCE — no vendor, no UI); **ProviderProfile/ProviderService/ProviderBranch** (`@@unique` eligibility relations, same-Business validated in the repository; Appointment keeps `assignedUserId` as the one-Provider seam); **`users.accountType`** PLATFORM/BUSINESS marker (Better Auth `input:false`; `isPlatformOperator`/`requirePlatformOperator` primitives; Business-role guards refuse operators); **booking concurrency**: `createWithConflictCheck`/`rescheduleWithConflictCheck` now SERIALIZABLE + bounded retry (P2034→typed `SLOT_CONFLICT`; asymmetric conflict rule preserved exactly); **inbound idempotency**: durable `inbound_message_dedupe` ledger (unique business+external key; claim before processing; message ids recorded in the SAME transaction as the message insert; redelivery → idempotent duplicate result with original ids; fallback key = SHA-256 of canonical payload); **AI contract**: `ai-contract.ts` (minimal bounded request; structured bounded response, 7-intent family, extraction of service/provider/date/timePreference facts; chain-of-thought stripped by construction; `bypassDeterministicAi` avoids AI calls); **usage telemetry**: append-only `usage_records` (INBOUND_MESSAGE/OUTBOUND_MESSAGE/AI_TURN; ids+counters+provider/model keys only — no content, no secrets, no pricing)                                                                                                                                                                                                                                                                                                                                                                                                                                           | PROMPT-ARCH-02   |
| Context-tier reconciliation            | PROMPT-ARCH-02.1 (DECISIONS #39, documentation-only — ZERO code changes): the context-tier reading model (Tier 0 cold start = `CURRENT_STATE.md` + `AGENT_RULES.md`; Tier 1 task routing; Tier 2 decision deep-dive; Tier 3 historical) is now encoded directly in `AGENT_RULES.md`; the untracked `CONTEXT_RECOVERY.md` was deleted and all references re-routed (`AGENT_RULES.md`, `CURRENT_STATE.md`, `README.md`); the 20 ARCH-02 invariants were re-audited against the schema/source — NO contradictions found; `CORE_CONTEXT.md`/`DOCS_INDEX.md`/`DECISIONS_INDEX.md` remain deleted (per #37). Known mismatches remaining: none detected                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | PROMPT-ARCH-02.1 |
| Migration-chain repair                 | PROMPT-ARCH-03 (DECISIONS #40): the migration history gained a proper root baseline `0_init` (pre-onboarding schema reconstructed from the initial commit and generated via `prisma migrate diff --from-empty`) plus `migration_lock.toml` — a genuinely EMPTY database now bootstraps fully with `pnpm db:deploy` (previously P3018 "relation businesses does not exist" on the first migration). The never-applied ARCH-02 migration was aligned in place with `schema.prisma` (isActive naming, `updated_at` defaults, redundant index removed); a new `20260913120000_invitation_updated_at_default` follow-up repaired the committed-era drift; `prisma.config.ts` gained an optional `SHADOW_DATABASE_URL`; `prisma/seed.ts` clears the Default-Branch pointer before wiping (re-run FK failure fixed). Verified on-device (Termux postgres + Debian-proot Prisma toolchain): empty DB → deploy (8/8) → `migrate diff` empty → seed ×3 deterministic/idempotent (1 business, 1 branch, 2 users, 6 services, 36 customers, 22 conversations, 73 messages, 37 appointments, all branch-scoped to the Default Branch)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | PROMPT-ARCH-03   |
| Ops (DX, non-product)                  | Cross-platform bootstrap/dev scripts, `pnpm run setup/doctor`, `pnpm verify`, `pnpm security` + pre-commit hook, gated `pnpm release`, Vercel deploy toolchain (`pnpm deploy*`), Egyptian demo dataset + `DEMO_MODE`, distribution docs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Ops 01–06        |
| Ops (ship tooling)                     | Lightweight operator ship path `pnpm ship patch/minor` (`scripts/ship.mjs`, dependency-free Node; DECISIONS #26): safety validation → version bump → one conventional commit → annotated tag → push main + tag → published GitHub Release; never re-runs the full gate (the prompt's `pnpm verify` is the gate), never deploys or touches the DB; full `pnpm release` preserved unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Ops 07           |
| Production launch                      | PROMPT-OPS-01 (deployment-only — ZERO code changes): NEW EMPTY Neon production DB (`neondb` @ `ep-tiny-grass-a5e63jev-pooler`) bootstrapped via the chain (`pnpm db:deploy`, 8/8; `migrate status` clean; `migrate diff --from-config-datasource` vs `schema.prisma` → "No difference detected"); data-empty (DEMO_MODE off, no seed, old Demo DB untouched). Vercel production LIVE: new dedicated project `flowpilot-prod` (scope `ammarj1`, framework nextjs, SSO deployment protection disabled), Production env vars = the four required (DATABASE_URL → new Neon, real BETTER_AUTH_SECRET, BETTER_AUTH_URL/NEXT_PUBLIC_APP_URL → `https://flowpilot-prod.vercel.app`; NO DEMO_MODE, INBOUND_WEBHOOK_TOKEN unset → inbound webhook disabled). Deployed via `pnpm deploy` from the local worktree (worktree left uncommitted). Health: `deploymentReady:true`, `database:connected`; smoke: sign-in 200 (dir=rtl, lang=ar), `/api/auth/ok` 200, protected routes redirect unauthenticated sessions. No authenticated smoke test (no production users — data-empty). Old Vercel projects (`flowpilot_v3`, `flowpilot-ammarj`, `test-deploy-flowpilot`) untouched                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | PROMPT-OPS-01    |
| Production identity + Demo environment | PROMPT-OPS-02: **auth audit** — the public `/api/auth/sign-up/email` endpoint is OPEN (emailAndPassword enabled; Better Auth's `disableSignUp` option also blocks the internal `auth.api.signUpEmail` the invitation activation uses, so it cannot simply be set — remediation is an operator decision, see Known Limitations); Better Auth v1.7 core drift fixed: the `Account` model lacked `issuer` (sign-up writes `local:credential`, sign-in matches the credential account by it — the installed version's lookup SELECTs `issuer` and FAILED against the old schema, breaking every credential flow) → `issuer String?` + hand-authored migration `20260913150000_account_issuer` (shadow DB unavailable on-device — no local postgres, `SHADOW_DATABASE_URL` unset; SQL = single ADD COLUMN, verified by deploy + diff + live sign-in); seed sets `issuer: createLocalAccountIssuer("credential")` + repairs pre-issuer accounts; **Demo environment LIVE**: the old Demo/Neon DB found completely EMPTY → bootstrapped via the chain (9/9, schema diff clean) + seeded ×2 deterministic/idempotent; new dedicated Vercel project `flowpilot-demo` created (scope `ammarj1`, framework nextjs set via API — the CLI-created project defaulted to `framework: null` which 404s every route; SSO deployment protection disabled via API to match prod), env vars = DATABASE_URL → Demo Neon DB, dedicated BETTER_AUTH_SECRET, BETTER_AUTH_URL/NEXT_PUBLIC_APP_URL → `https://flowpilot-demo-gamma.vercel.app` (the suggested `flowpilot-demo.vercel.app` is owned by an unrelated third party; the CLI's initial alias also failed silently and was re-aliased via `vercel alias set`), DEMO_MODE=true; deployed via `pnpm deploy` from the worktree; health `{status:ok, environment:production, deploymentReady:true, database:connected}`; authenticated smoke green end-to-end (Admin: dashboard `/`, conversations, appointments, admin/team, customers, services, settings, knowledge; Staff: `/staff` NEED_HUMAN queue; role isolation verified). Production: `accounts.issuer` migration applied (0 users / 0 accounts unchanged — data-empty, no demo seed ever run against it). `pnpm deploy` currently re-links `.vercel` per project — relink `flowpilot-prod` before the next production deploy | PROMPT-OPS-02    |

| Production identity & security closure | PROMPT-OPS-04 (ops/security only — ZERO product-logic changes): **repository visibility PASS** (GitHub repo verified PRIVATE via `gh repo view`). **Production auth audit PASS** (code-level): invitation-first lifecycle (create → accept → activate, hash-only tokens), ADMIN/STAFF + Platform-Operator guards (`requireRole`/`requireApiUser` refuse operators; `accountType` input:false), server-derived business/tenant/role resolution in every action's `currentActor`, service-level `role !== "ADMIN"` enforcement, safe sign-in redirects, Zod-stripped hostile identity fields. **Production redeployed to v0.15.3** after the live build was found STALE (generated Prisma client predated `accounts.issuer` → every credential flow failed `Unknown argument 'issuer'`, sign-up 500 — diagnosed via Vercel runtime logs; redeploy regenerates the client from the current schema; verified fixed). **First Production ADMIN bootstrapped** via the NEW one-time operator tool `pnpm bootstrap:admin` (`scripts/bootstrap-production-admin.ts`): reuses the exact seed.ts primitives (better-auth/crypto `hashPassword` + better-auth/db `createLocalAccountIssuer`, credential-account shape), interactive no-echo password + typed YES confirmation, host assertion (`ep-tiny-grass…`), data-empty precondition, single-transaction write (1 ADMIN user `role=ADMIN`/`account_type=BUSINESS`/`is_active`/`businessId=null` + 1 credential account `providerId=credential`/`issuer=local:credential`), 17/17 DB row verification + automatic live sign-in verification (all ✔: sign-in 200, session, /onboarding handoff, ADMIN-only access, STAFF refusal → access-denied, sign-out, session invalidated) — NO backdoor: the Business is created in-app via the canonical onboarding wizard (`createForUser` attaches ADMIN membership + Default Branch). No DECISIONS entry (reuses decided primitives; ops tool only) | PROMPT-OPS-04 |

| Platform Control Plane | PROMPT-OPS-05 (DECISIONS #41): **public signup CLOSED at the proxy** (403 `SIGNUP_CLOSED` for public `POST /api/auth/sign-up/email`; internal `auth.api.signUpEmail` unaffected — invitation-first preserved; proven by `pnpm check:signup` 13/13); **Platform Operator separation enforced** (`requireUser`/`requireRole` redirect operators to `/platform`; `requirePlatformOperator` guards the new `(platform)` group; one-time `pnpm bootstrap:operator` tool creates the FIRST PLATFORM identity); **platform owner invitations** (`platform_invitations` — pre-Business, hash-only one-time tokens, 7-day expiry, duplicate-open guard per email, activation → ADMIN credential with businessId null → canonical onboarding; public `/owner-invite/[token]` activation route reusing the existing notice/activation UI patterns); **Platform AI policy** (`platform_ai_policies` singleton — OpenRouter primary / AgentRouter secondary, runtime-changeable via the `(platform)/ai-policy` form, secret REFERENCE names only; deterministic `getEffectiveAiPolicy()` seam for the future LLM adapter; proven by `pnpm check:policy` 13/13); migration `20260913170000_platform_control_plane` applied to Production (chain 10/10, schema diff EMPTY, policy singleton verified; Demo DB untouched at 9/9); API keys are env-backed secrets (`OPENROUTER_API_KEY`/`AGENTROUTER_API_KEY` in `env.ts`/`.env.example`) — never in DB/UI/source/logs | PROMPT-OPS-05 |

| Platform Control Plane deployment + live verification | PROMPT-OPS-05.1 (ops/verification only — ZERO code changes): current worktree deployed to Production via `pnpm deploy` (prerequisites verified first: project `flowpilot-prod`, four Production env vars, Production `DATABASE_URL` → `ep-tiny-grass-a5e63jev-pooler`, DEMO_MODE absent everywhere). Live verification PASSED: `/api/health` 200 (`deploymentReady:true`, `database:connected`), `/sign-in` 200 Arabic RTL, anonymous `/` + `/services` + `/staff` → 307 `/sign-in?redirect=…`, public signup 403 `SIGNUP_CLOSED` (Arabic message), all three platform routes + owner-invite resolve (platform routes guard-engaged: anonymous → 307 `/sign-in`; owner-invite invalid token → 200 safe Arabic error state), AI-policy values verified at the DB level (primary=openrouter / secondary=agentrouter / fallback=true), no key material in public responses (grep clean), policy runtime-changeable (DB singleton mutated via server actions — no redeploy needed). Production Platform Operator verified at the DB level (ammarjaberx@gmail.com, role=STAFF, account_type=PLATFORM, isActive); authenticated RBAC smoke skipped per operator decision. Production healthy: migrations 10/10 (last = `20260913170000_platform_control_plane`), Demo DB untouched. No GitHub operations | PROMPT-OPS-05.1 |

| Provider / Service Eligibility Resolver | PROMPT-CORE-01: deterministic `resolveEligibleProviders` (`src/features/appointments/server/provider-eligibility-service.ts`) — relation-driven eligibility over the EXISTING `ProviderService`/`ProviderBranch` relations via ONE repository query (`ProviderRepository.listEligibleForService` + pure `eligibleProvidersWhere` builder): server-resolved Business scope (session + persisted user; input schema strips hostile identity keys), optional Branch scope (existing `findByIdWithinBusiness` semantics — no new branch framework), active Provider + active same-Business Service required, cross-business leakage impossible (typed `*_NOT_FOUND` codes — no cross-tenant existence leaks); compact DTO (`providerId` + `displayName` falling back to the member name; `branchId` scope echoed; no credentials/auth fields); ZERO schema changes, no new indexes, no LLM/WhatsApp/appointment changes; `resolveEligibleProvidersAction` thin hook; proven by `pnpm check:eligibility` (29/29 in-memory harness) | PROMPT-CORE-01 |

| Any-Provider Booking Options Resolver | PROMPT-CORE-02: deterministic `resolveBookingOptions` (`src/features/appointments/server/booking-options-service.ts`) — CONSUMES CORE-01 (`resolveEligibleProviders` + its typed error pass-through; eligibility never re-resolved) then computes availability for the eligible Providers over the EXISTING Availability layer (reused `resolveWorkingDay`/`weekdayOf`/`generateCandidateSlots`/`filterConflictingSlots` — the same business-hours logic and slot model, never duplicated): per-Provider conflicts via `listBlockingByAssignees` (the read counterpart of the existing write-path `assignedUserId` scoping — a Provider's calendar is blocked only by its own PENDING/CONFIRMED appointments; ONE batched Business-scoped read, no N+1) + `listAssignmentSeams` (ONE batched ProviderProfile.id → userId projection); deterministic nearest-useful ranking (`rankBookingOptions`: each Provider's earliest slot first by time then the stable CORE-01 order; backfill in global time order when fewer than `MAX_BOOKING_OPTIONS` = 3 distinct options exist; no ML/LLM); small result (serviceId/branchId/date/timezone/preference ANY\|PROVIDER + 2–3 options `providerId`/`displayName`/`startAt`/`endAt`); explicit empty reasons (NO_ELIGIBLE_PROVIDERS / BUSINESS_CLOSED / SERVICE_TOO_LONG / FULLY_BOOKED); requested Provider verified against CORE-01 (`PROVIDER_NOT_ELIGIBLE` — no cross-Business leak); READ-ONLY (no appointment write/reservation/LLM/WhatsApp); ZERO schema changes; `resolveBookingOptionsAction` thin hook; proven by `pnpm check:booking-options` (32/32 in-memory harness) | PROMPT-CORE-02 |

| WhatsApp Transport Foundation | PROMPT-CORE-03A: provider-neutral boundary `src/server/transport/whatsapp-transport.ts` — normalized inbound envelope + `normalizeInboundTransportMessage` (`strict()` + TEXT<->MEDIA exclusivity; hostile keys rejected; `MALFORMED_PROVIDER_PAYLOAD`), outbound `OutboundMessage` -> `MessageTransport` (offline retained; `resolveConnectionForSend` tenant-scoped + gated; `credentialsRef` never returned), typed error taxonomy + `TransportError` (`retryable` = `TRANSIENT_TRANSPORT_FAILURE` only; no HTTP leakage); server-derived tenant/branch resolution via existing `BusinessRepository.findByWhatsappNumber` + `WhatsAppConnectionRepository` + `BranchRepository` (branch validated within Business; business-shared `branchId=null` -> Default Branch); `pnpm check:whatsapp-transport` 26/26 (in-memory); ZERO schema changes; re-exported via `src/features/conversations/server/conversation-transport.ts`; `package.json` adds `check:whatsapp-transport` | PROMPT-CORE-03A |
| Meta WhatsApp Adapter (Graph API) | PROMPT-CORE-03B (DECISIONS #42): adapter inside `src/server/integrations/whatsapp/` on the CORE-03A foundation — `meta-webhook.ts` (verify `hub.mode/hub.verify_token/hub.challenge` + HMAC-SHA256 `X-Hub-Signature-256` + parse+normalize `whatsapp_business_account` -> `normalizeInboundTransportMessage`) + `meta-client.ts` (`createMetaWhatsAppTransport` Bearer POST `https://graph.facebook.com/{v}/{PHONE_NUMBER_ID}/messages` + `buildMetaSendUrl`/`buildMetaTextPayload` + `mapMetaError` 401/403/190/102 -> UNAUTHORIZED_CREDENTIALS, 429/5xx/368 -> TRANSIENT_TRANSPORT_FAILURE else PERMANENT) + route `GET|POST /api/whatsapp/meta` (public-path exempt; GET returns `hub.challenge` text/plain; POST raw-body signature -> parse -> empty->200 statuses / non-empty -> server-derived `resolveInboundConnection` -> TEXT via `receiveInboundMessage` + `revalidatePath` -> `{success,received,statuses,results}`; `ENVIRONMENT_VARIABLES.md` documents 5 optional `WHATSAPP_META_*` env vars in `src/lib/env.ts` via `emptyToUndefined` so empty `.env.local` lines do not fail the build). `pnpm check:meta-whatsapp` 15/15 + `pnpm check:whatsapp-transport` 26/26 (updated Core scan exempts the adapter boundary); `pnpm verify` green + `pnpm security` pass (with warnings); ZERO schema changes | PROMPT-CORE-03B |

| Real LLM Provider Adapter | PROMPT-AI-02: `defaultConversationEngineDeps.ai` now policy-backed via `createPolicyBackedAi({ getEnvVar: process.env, fetchImpl: globalThis.fetch })` + `getEffectiveAiPolicy()` (`toEffectivePolicy` boundary) — effective runtime policy is AgentRouter primary / OpenRouter secondary / fallback enabled; no provider/model hard-coded in the engine; `INITIAL_AI_POLICY` retained as seed/default only; `bypassDeterministicAi` before `ai.respond` + `parseAiResponse` + `AiRequest`/`AiResponse` + Domain/Branch/Booking boundaries all preserved; retryable/timeout fallback only (orchestrator), CONFIG_ERROR/INVALID_RESPONSE never retried, malformed output → controlled `NEED_HUMAN`; secrets server-only via `secretRef` + `getEnvVar` (`OPENROUTER_API_KEY`/`AGENTROUTER_API_KEY`, never `NEXT_PUBLIC`/client/logs/docs/DB/telemetry; missing creds → safe deterministic `NEED_HUMAN`); `AiTelemetry` rich `AI_TURN` (provider/model/tokens/latency/fallback) via `createLlmConversationAi` + `getLastTelemetry` surfaced in the engine’s `recordUsage`; WhatsApp inbound flow unchanged (`POST /api/whatsapp/meta` + `POST /api/conversations/inbound` both → `receiveInboundMessage(defaultConversationEngineDeps)`); `src/server/integrations/ai/` (`factory`/`orchestrator`/`conversation-ai`/`http`/`prompt`/`openrouter`/`agentrouter`/`types`) + offline harness `scripts/check-ai-provider.ts` (`pnpm check:ai-provider` 29/29) + `pnpm check:ai-prompts` 106/106; verified `pnpm lint` + `pnpm typecheck` + `pnpm format:check` + `pnpm verify` green (lint/typecheck/format/build) + `pnpm security` pass (warnings: dual .env) + `pnpm db:generate`; ZERO schema/migration/prompt changes; no Superadmin prompt editing; worktree uncommitted | PROMPT-AI-02 |

| AI Prompt & Evaluation Separation | PROMPT-AI-01 (DECISIONS #43): provider-neutral, versioned, deterministic prompt artifacts separate from implementation — `docs/ai/README.md` + `docs/ai/ARCHITECTURE.md` (invariant `AI interprets → Domain decides → Conversation orchestrates`; structured `AiRequest`/`AiResponse` contract; minimal context; `PlatformAiPolicy` singleton boundary; `bypassDeterministicAi` before `ai.respond` + `parseAiResponse` stripping + provider-neutrality invariants) + `docs/ai/PROMPTS.md` (5 definitions `booking-intent@v1` / `faq-match@v1` / `availability-handoff@v1` / `reschedule-cancellation@v1` / `human-request@v1` — 7-section structure each: Purpose/Input/System instructions/Output contract/Constraints/Handoff policy/Version history; no Authorization/x-api-key/model/tool-call/secret syntax) + `docs/ai/EVALUATIONS.md` (15 deterministic fixtures 01–15: BOOKING 01–02, FAQ 03–04 verbatim, AVAILABILITY 05–06, CANCELLATION/RESCHEDULE 07–09, HUMAN_REQUEST/AMBIGUOUS 10–13, ordering 14–15 — all bound to `classifyCustomerMessage`/`bypassDeterministicAi`/`deterministicConversationAi` + `parseAiResponse` unknown-key stripping). Offline harness `scripts/check-ai-prompts.ts` (`pnpm check:ai-prompts` 106/106 passing: files present, structured definitions, strict deny-list on `docs/ai/` — no provider syntax, fixture intents/actions/reasons/summaries/extraction/content, deterministic replay 01–15, negative invariants, invocation boundary — `bypassDeterministicAi` before `ai.respond`, `parseAiResponse` present, minimal `AiRequest` without Prisma/booking invention, no secrets); `package.json` adds `check:ai-prompts`; `pnpm verify` green + `pnpm security` pass; ZERO schema/engine/domain changes; `docs/ai/` is canonical — not duplicated elsewhere | PROMPT-AI-01 |

| Conversation → Booking Seam | PROMPT-AI-03 (DECISIONS #45 prerequisite satisfied; booking boundary DECISIONS #45): deterministic `Customer message → Conversation Engine → AiResponse → mapper → CORE-01 → CORE-02 → options/clarification/NEED_HUMAN` with zero appointment mutation — `src/features/conversations/server/booking-mapper.ts` pure mapper (`isAnyProviderPhrase`/`matchServiceByName`/`matchProviderByName`/`mapAiResponseToBookingInput`: `normalizeArabicText` vs `serviceRepository.listByBusiness`, server-derived `businessId`/`branchId`, `ANY_PROVIDER` → `providerId: undefined`/`preference: ANY`, hostile tenant keys stripped by `parseAiResponse`) + `src/features/conversations/server/conversation-engine.ts` BOOKING/AVAILABILITY branch (`bypassDeterministicAi` first, `parseAiResponse` then mapper → `needs_clarification` → `AI_REPLY` stays `AI_ACTIVE` else `ready` → CORE-01 `resolveEligibleProviders` → provider match → CORE-02 `resolveBookingOptions` reusing `resolveWorkingDay`/`weekdayOf`/`generateCandidateSlots`/`filterConflictingSlots`/`listBlockingByAssignees` verbatim including `SERVICE_NOT_FOUND`/`SERVICE_INACTIVE`/`PROVIDER_NOT_ELIGIBLE`/`BRANCH_NOT_FOUND`/`NO_BUSINESS`/`INVALID_INPUT` + empty reasons `NO_ELIGIBLE_PROVIDERS`/`BUSINESS_CLOSED`/`SERVICE_TOO_LONG`/`FULLY_BOOKED`; Arabic customer messages, typed `NEED_HUMAN`/`AI_REPLY`/`AI_HANDOFF`, no Prisma from Conversation layer, no new tables/migrations/queues/Redis/channel adapters); `ConversationEngineDeps` stays backward-compatible (`Partial<Pick<…>>` + optional `providerRepository`/`appointmentRepository` falling back to real singletons for existing harnesses `check-ai-provider`/`check-meta-whatsapp`/`check-whatsapp-transport`); offline harness `scripts/check-conversation-booking.ts` (`pnpm check:conversation-booking` 16/16: valid booking, ANY_PROVIDER, availability, missing/ambiguous service, ambiguous provider, CORE-01 rejection, CORE-02 empty, hostile injection strip, bypass, NEED_HUMAN typed, no mutation/no secrets; fixed date `2026-09-14` Monday; no DB/network/LLM/Meta); `package.json` adds `check:conversation-booking`; `pnpm verify` green + `pnpm security` pass; ZERO appointment write/mutation, ZERO schema changes, no prompt edits **PROMPT-AI-03B** completes the deterministic close-the-loop: `booking-selection.ts` offer-aware parser (option index / `HH:mm` / provider-name / Arabic-normalized; never fabricates ids) + engine `completeBookingSelection` (fresh CORE-01 → fresh CORE-02 → offered option still bookable verified (stale/ambiguous/invalid → Arabic clarification / refreshed options / `NEED_HUMAN`, zero write) → canonical `createWithConflictCheck` (SERIALIZABLE; `null` = `SLOT_CONFLICT` → retry-safe refreshed options) → `BOOKED` via `addMessage` → confirmation through `MessageTransport` only after creation; deterministic path spends zero LLM calls; `pnpm check:booking-confirm` 18/18; ZERO schema/prompt/provider changes) | PROMPT-AI-03B |

## Key Known Limitations (current; CORE-03B — Meta adapter live, CORE-03A note retired)

- Smart Create has no notes entry: Step 6 submits without notes (PROMPT-14
  scope decision — a notes field was not among the required inputs).
- Availability is a READ layer: no slot reservation; the write-time
  conflict check is the authority (PROMPT-13/14 semantics). Since
  PROMPT-ARCH-02 that check runs in a SERIALIZABLE transaction with a
  bounded retry loop, so two concurrent conflicting creates cannot both
  commit (DECISIONS #34/#38). Honest residual limitation: a rare
  false-positive serialization abort under contention surfaces as
  `SLOT_CONFLICT` even when the slot is free — a manual retry succeeds.
- Step 5 revalidation is a hand-off, not a reservation — by design; the
  write's conflict check is the authority (PROMPT-13/14 semantics).
- Unassigned appointments block the whole business day (consistency with
  the write path; staff-assignment-aware availability is a later decision).
- CORE-03B makes WhatsApp live through the Meta adapter while CORE-03A's
  generic provider-neutral webhook `POST /api/conversations/inbound` stays
  (token-gated, disabled 503 until `INBOUND_WEBHOOK_TOKEN` is set) as a
  secondary seam — the Meta inbound is `GET|POST /api/whatsapp/meta`
  (Meta's `hub.mode/hub.verify_token/hub.challenge` verify +
  `X-Hub-Signature-256` HMAC-SHA256; skips signature when
  `WHATSAPP_META_APP_SECRET` is unset so local/dev stays usable). Live
  WhatsApp outbound is `createMetaWhatsAppTransport` (Bearer) resolved via
  `WhatsAppConnection.credentialsRef` (env-var NAME) falling back to
  `WHATSAPP_META_ACCESS_TOKEN`/`WHATSAPP_META_PHONE_NUMBER_ID`; the
  `WhatsAppConnection` DB foundation (ARCH-02) still has no management UI
  and `Business.whatsappNumber` remains the inbound mapping fallback.
- The AI assistant is a deterministic rule-based Arabic classifier behind
  the `ConversationAi` interface — NOT live LLM inference: keyword/phrase
  matching + verbatim `Business.faqs` answer matching. Phrasings outside
  the keyword tables / FAQ vocabulary land safely on NEED_HUMAN (never a
  fabricated answer, but more handoffs than an LLM would produce). A real
  AI provider is an undecided operator decision; the structured
  `ai-contract.ts` boundary (ARCH-02) is what a future LLM adapter
  implements — the engine does not change.
- Inbound webhook processing is idempotent since ARCH-02 (durable
  business+external-key dedupe, claim-coupled message persistence —
  DECISIONS #34/#38). Edge case by design: if a turn crashes AFTER the
  customer message persisted but before the assistant reply, a
  redelivery is deduped and the reply is not regenerated (the message
  is not lost — staff sees the thread; the next customer message
  re-engages the assistant).
- The engine never books (no appointment mutation): BOOKING/AVAILABILITY intents resolve deterministically via the mapper → CORE-01 `resolveEligibleProviders` → CORE-02 `resolveBookingOptions` (server-derived `businessId`/`branchId`, `ANY_PROVIDER` never fabricates `providerId`, reusing the existing availability layer; empty/rejection → Arabic `AI_HANDOFF` `NEED_HUMAN`); all other booking-adjacent intents and malformed/unsafe/unavailable cases still hand off to staff (`NEED_HUMAN`); the assistant posts the Domain-computed options/clarification/handoff message, and threads in any non-`AI_ACTIVE` state (or assigned) never receive AI interjections.
- The Branch/WhatsAppConnection/usage foundations (ARCH-02) have NO
  management UI and NO consumer flows yet; the Provider eligibility
  relations gained their FIRST consumer in PROMPT-CORE-01 (the
  deterministic eligibility resolver — read-only, no UI). Provider
  management UI remains the provider-integration phase. Usage telemetry
  is recorded but not surfaced anywhere (no dashboards);
  `estimatedCostMicros` is never computed by the codebase.
- Platform Operator marker exists (`users.accountType`, ARCH-02) and the
  control surface is LIVE since PROMPT-OPS-05: the `(platform)` route
  group (overview / دعوات الملاك / سياسة الذكاء) guarded by
  `requirePlatformOperator`. The FIRST operator identity was created via
  the one-time `pnpm bootstrap:operator` and is verified on Production
  (PROMPT-OPS-05.1, DB level); no further operator is provisioned by any
  in-app flow yet (platform owner invitations create pre-Business ADMINs).
- **Public sign-up API is CLOSED (PROMPT-OPS-05, DECISIONS #41):** the
  route proxy refuses public `POST /api/auth/sign-up/email` (+
  `/api/auth/sign-up`) with 403 `SIGNUP_CLOSED`; anonymous visitors
  cannot create arbitrary accounts. Internal `auth.api.signUpEmail`
  calls (invitation activation) do not traverse the proxy and remain
  functional (Better Auth's `disableSignUp` stays unused — it would
  break the internal path). Proven by `pnpm check:signup` (13/13).
- Credential accounts REQUIRE the Better Auth v1.7 `issuer` field
  (`local:credential`): since PROMPT-OPS-02 the column exists
  (`20260913150000_account_issuer`) and the seed writes it; any
  hand-created account row must set `issuer = 'local:credential'` +
  `provider_id = 'credential'` + `account_id = user.id` or Better Auth
  sign-in reports "User not found".
- The hand-authored `20260913150000_account_issuer` migration was
  written without `prisma migrate dev` (no shadow database available on
  this device: no local postgres, `SHADOW_DATABASE_URL` unset) — it is
  a single additive `ADD COLUMN` and is verified by deploy + schema
  diff + live sign-in on both environments.
- The staff workspace queue reuses the inbox read (caps at 100
  conversations, no pagination) and shows the LATEST appointment per
  customer as context (not specifically the next upcoming one) — both
  accepted at pilot scale.
- Takeover/assignment ownership changes are explicit-action-only (DECISIONS
  #28); the workspace offers takeover ONLY for unassigned threads — taking
  over someone else's thread requires the conversation detail's explicit
  assignment path.
- Invitation token delivery is manual: the raw invite link is surfaced to
  the inviting ADMIN exactly once in the Team invite dialog (copy +
  "never shown again"); email/WhatsApp delivery is out of scope.
- Team management has no invitation-revocation UI (revocation stays a
  service-layer capability); a pending invitation simply expires after
  7 days, after which the same email can be re-invited.
- Only STAFF members can be deactivated/reactivated in the Team UI
  (ADMIN members are protected by design — no accidental business
  lockout; ADMIN membership management is not exposed).
- Knowledge entries are JSON rows of `Business.faqs`: no per-entry id,
  active state, or timestamps (the DECISIONS #13 shape is
  question/answer only) — removal is the supported state change, and
  the trimmed question is the workflow-enforced natural key (one entry
  per distinct question, 50-entry cap). JSON has no DB constraints, so
  the duplicate/cap guards are workflow-level (same accepted-race
  caveat as appointments/invitations at pilot scale).
- Customer creation does not collect email (Spec A minimum: name, phone,
  optional notes); customer edit/deletion is not exposed in the UI.
- A soft-deleted customer's phone still occupies the unique-per-business
  constraint: recreating that phone surfaces the duplicate-phone error
  instead of restoring the row (accepted at pilot scale; restore is a
  repository method away if evidence demands it).
- Directory reads cap at 20 customers/page (same cap as the booking search);
  no pagination UI (pilot scale).
- Appointments accept past dates at the domain level (the date step's
  `min=today` is a UX guard only).
- Health DB probe adds up to 3s on cold/suspended Neon (liveness unaffected).
- Termux device: builds use `--webpack` (no Turbopack bindings); the Prisma
  schema engine cannot run on-device (migrate from desktop/CI); SVG→PNG icon
  regeneration via `pnpm icons`.

## Architecture Hardening (P0 foundations IMPLEMENTED — PROMPT-ARCH-02)

Accepted in PROMPT-ARCH-01 as DECISIONS #30–#36 and IMPLEMENTED in
PROMPT-ARCH-02 as DECISIONS #38 (bridge: `ARCHITECTURE_RECONCILIATION.md`;
schema details: `DATABASE.md`):

- **#30 Business/Branch model** — IMPLEMENTED: Branch table +
  `Business.defaultBranchId` pointer (atomic creation, one-time backfill);
  required `branchId` on Conversation/Appointment (server-resolved Default
  Branch); Customer/User/Service/Knowledge stay Business-level.
- **#31 WhatsAppConnection** — IMPLEMENTED (DB/domain foundation only):
  businessId required, branchId optional, provider-neutral identity,
  machine-key status, secret-reference storage; no vendor, no UI.
- **#32 Provider model** — IMPLEMENTED (relations only): ProviderProfile
  on User + ProviderService/ProviderBranch eligibility relations with
  same-Business validation and `@@unique` pairs; one Provider per
  Appointment via the existing `assignedUserId` seam (no rewiring);
  no provider UI, no booking-flow changes.
- **#33 Responsibility separation** — IMPLEMENTED at the boundary:
  `ai-contract.ts` (minimal bounded request / structured bounded
  response; facts-only extraction; chain-of-thought stripped by
  construction) + `bypassDeterministicAi` (deterministic turns skip the
  AI entirely) + PROMPT-AI-03 booking seam (`booking-mapper.ts` →
  CORE-01/CORE-02; `AI interprets → Domain decides → Conversation
orchestrates`). AI still never queries Prisma, never decides
  availability/eligibility/conflicts, never books/creates appointments.
- **#34 Reliability prerequisites** — IMPLEMENTED: SERIALIZABLE
  conflict-checked booking writes with bounded retry + typed
  SLOT_CONFLICT; durable inbound-webhook idempotency ledger
  (claim-before-processing, claim-coupled message persistence,
  idempotent duplicate results).
- **#35 Scheduling scope** — unchanged (availability still inherits
  Business working hours; provider-specific scheduling deferred).
- **#36 Usage & Economics foundation** — IMPLEMENTED (facts only):
  append-only `usage_records` (message/AI-turn counts, provider/model
  keys, token columns for future providers, optional cost snapshot);
  Usage ≠ Cost ≠ Price ≠ Entitlement ≠ Billing preserved — no pricing
  logic, no billing.

The two real provider integrations are now WIRED: WhatsApp via the Meta adapter (CORE-03B; DECISIONS #42) and LLM behind `ConversationAi` via the policy-backed adapter (PROMPT-AI-02); PROMPT-AI-03 booking seam is also WIRED (mapper → CORE-01/CORE-02, zero mutation). Remaining operator decisions: key provisioning / production pilot validation.

## Migration State

The chain in `prisma/migrations/` (with `migration_lock.toml`, provider
`postgresql`) is COMPLETE and bootstraps a genuinely EMPTY database via
`pnpm db:deploy` (verified on-device in PROMPT-ARCH-03; DECISIONS #40):

`0_init` (root baseline — pre-onboarding Spec A schema) →
`20260826120000_onboarding_fields` → `20260902120000_invitation_model` →
`20260903120000_invitation_activation` →
`20260903130000_business_vertical` →
`20260903140000_business_confirmation_mode` →
`20260910120000_architecture_hardening_foundation` →
`20260913120000_invitation_updated_at_default` →
`20260913150000_account_issuer` →
`20260913170000_platform_control_plane` (PROMPT-OPS-05:
platform_invitations + platform_ai_policies + the initial
operator-approved policy row — OpenRouter primary / AgentRouter
secondary; applied to Production, chain 10/10, `migrate diff` vs
`schema.prisma` EMPTY; the Demo DB is at 9/9 and needs
`pnpm db:deploy` before its next code deploy) →
`20260919120000_whatsapp_onboarding_lifecycle` (WHATSAPP-ONBOARDING-01;
applied to the Dev DB) →
`20260920140745_runtime_credentials` (DECISIONS #49; the RUNTIME secret
backend — a NEW dedicated `runtime_credentials` table; ADDITIVE: no
existing column/constraint/index altered; applied to the Dev DB).
Chain end-state == `prisma/schema.prisma` (empty `migrate diff`).

**Old Demo/Neon database (NOT touched by PROMPT-ARCH-03):** the one-time
reconciliation is HUMAN-ONLY — baseline the chain against it
(`prisma migrate resolve --applied 0_init` if its tables predate the
chain; see `DATABASE.md → Migration Chain`), then `pnpm db:deploy`. Do
NOT drop/reset it.

## Ops State

- Release model (DECISIONS #18): private GitHub repo, single `main` branch,
  annotated `vX.Y.Z` tags, gated `pnpm release`; pre-commit secret hook
  active (`core.hooksPath=.githooks`). Routine post-prompt shipping uses the
  lightweight operator path `pnpm ship patch/minor` (DECISIONS #26;
  `RELEASE_PROCESS.md → Lightweight Operator Ship`).
- Deploy: `pnpm deploy` / `deploy:preview` / `deploy:check` (gated; URL
  captured); `/api/health` reports version + DB reachability +
  `deploymentReady`. Guides: `VERCEL_DEPLOYMENT.md` (§0 = quick path),
  `ENVIRONMENT_VARIABLES.md`. **Production is LIVE and identity-closed — currently deployed at v0.19.0** (verified read-only `GET /api/health` → `version:"0.19.0"`, `deploymentReady:true`, `database:connected`, `missingEnvVars:[]`, 2026-09-19; the earlier v0.15.9 reconciliation was deployment `dpl_BAVArqTcusNyPRj3PrTibSAhjuyL` 2026-09-15T13:59Z, prior stale `dpl_Am9WNXoDG2XfY41GXsD3PKwX91vb` v0.15.3 resolved — no auto-deploy needed; `/api/whatsapp/meta` is present as `GET` verify + `POST` webhook)
  (PROMPT-OPS-01; PROMPT-OPS-04; OPS-05 build + live verification in
  PROMPT-OPS-05.1; reconciled PROMPT-OPS-06): `https://flowpilot-prod.vercel.app` —
  dedicated Vercel project `flowpilot-prod` (scope `ammarj1`), Neon DB
  chain 10/10, first ADMIN bootstrapped, build live (v0.15.9 at the OPS-06 checkpoint; production has since been redeployed and verified at v0.19.0) (PROMPT-OPS-04 fixed the stale issuer-client; PROMPT-OPS-05.1 deployed OPS-05 Platform Control Plane — verified live; PROMPT-OPS-06 continuation verified reconciled at `dpl_BAVArqTcusNyPRj3PrTibSAhjuyL` with `pnpm verify` green + `pnpm security` pass + 26/26 + 15/15).
  `.vercel` links
  `flowpilot-prod` (PROMPT-OPS-02's stale note resolved). Redeploy loop =
  `pnpm deploy` from the worktree (no Git connection on this project yet).
  One-time bootstrap tool: `pnpm bootstrap:admin` (refuses non-empty DBs
  and non-production hosts — safe to keep in the repo; unused now). ~~**Vercel Production env still lacks all 5 `WHATSAPP_META_*`**~~ — SUPERSEDED by item 9 below (9 vars set incl. all 5 `WHATSAPP_META_*`; live E2E completed).
- Demo environment (PROMPT-OPS-02): LIVE at
  `https://flowpilot-demo-gamma.vercel.app` — dedicated Vercel project
  `flowpilot-demo` (scope `ammarj1`, framework nextjs, SSO protection
  disabled) + the isolated Demo Neon DB (`neondb` @
  `ep-weathered-feather-aef123ef-pooler`; was fully EMPTY; chain 9/9;
  seeded ×2 deterministic/idempotent). Demo env vars on the project:
  DATABASE_URL → Demo Neon DB, dedicated BETTER_AUTH_SECRET,
  BETTER_AUTH_URL/NEXT_PUBLIC_APP_URL → the demo URL, DEMO_MODE=true
  (inert at build time — the Vercel build does not seed; reseeding is
  `DATABASE_URL=<demo-url> pnpm tsx prisma/seed.ts`, idempotent).
  Redeploy loop: `vercel link --project flowpilot-demo` → `pnpm deploy`.
  Egyptian dataset (عيادة الابتسامة — 36 customers, 22 conversations,
  37 appointments) in `prisma/demo-data.ts`; `DEMO_MODE=true` re-seeds in
  dev launchers and every deploy. Docs: `DEMO_GUIDE.md`, `DEMO_SCRIPT.md`,
  `CLIENT_DEMO.md`. Demo logins (demo DBs only): `admin@flowpilot.app` /
  `Admin@1234`, `staff@flowpilot.app` / `Staff@1234`.
- Releases are tagged through **`v0.19.1`** (annotated tags; `v0.19.1` ==
  HEAD `04856ae` == `origin/main` — the Prompt Workspace slice of DECISIONS
  #48). Historical releases v0.1.0–v0.15.3 are published on GitHub (each has
  a GitHub Release). Local and origin `main` are in sync. The only
  uncommitted work is this documentation/ledger reconciliation (DECISIONS
  #48 append + BUILD_STATE/CURRENT_STATE sync + two precision notes in
  `docs/ai/`) — doc-only, no code, no prompt text. **Deploy note:**
  production was last verified live at **v0.19.0**
  in the pre-refactor ledger entry; the v0.19.1 Prompt Workspace release is
  NOT yet deployed — deploying it is an operator action (`pnpm deploy` from
  the worktree). The v0.19.1 change set is prompt-text relocation +
  generator/registry/doc wiring only, so it carries no DB migration and no
  booking/transport behavior change.

## Unresolved User Actions (not code) — updated PROMPT-OPS-06 continuation

9. ~~​**META PRODUCTION ENABLEMENT**​~~ DONE 2026-09-15T19:1xZ — Vercel Production env for `flowpilot-prod` now has **9 vars** (`vercel env ls` 5 `WHATSAPP_META_*` PRESENT: `WHATSAPP_META_VERIFY_TOKEN` len 30 / `WHATSAPP_META_APP_SECRET` len 32 / `WHATSAPP_META_ACCESS_TOKEN` len 204 / `WHATSAPP_META_PHONE_NUMBER_ID` len 16 / `WHATSAPP_META_API_VERSION=v26.0` + 4 core vars). Live `GET /api/whatsapp/meta?hub.mode=subscribe&hub.verify_token=<valid>&hub.challenge=CHALLENGE_E2E_999` now returns **200 + challenge `text/plain`** (was 403 before env set); invalid token still **403** (expected). Production DB (Neon `ep-tiny-grass-a5e63jev-pooler`) already has **1 `WhatsAppConnection`** `e5e2e2f7...` — `businessId=f5314115...` (مركز أفنان `+201064549970`) / `branchId=9e23600e...` (الفرع الرئيسي Default Branch) / `phoneNumber=+201064549970` / `externalId=1286861067846638` (`phone_number_id`) / `status=CONNECTED` / `isActive=true` / `credentialsRef=WHATSAPP_META_ACCESS_TOKEN` (env-var NAME only). No `NEXT_PUBLIC_WHATSAPP_*`, no raw token, no Demo secret reuse. Meta App Dashboard webhook still operator-owned: `https://flowpilot-prod.vercel.app/api/whatsapp/meta`, same Verify Token, `messages` on `whatsapp_business_account`.

10. ~~​**LIVE E2E**​~~ DONE (continuation 2, via production webhook + signed `X-Hub-Signature-256`): inbound `wamid.test-*` → `POST /api/whatsapp/meta` `{"success":true,"received":1,"results":[{"ok":true,"duplicate":false}]}` → server-derived `resolveInboundConnection` Business `f5314115...` / Branch `9e23600e...` → `Conversation` `7dc71f25...` `status=NEED_HUMAN` → `Customer` `b6dc7e7b...` `+201555000001` → 1 CUSTOMER `مرحبا - رسالة اختبار E2E` + 1 AI reply + 1 `inbound_message_dedupe` `57e539ac...` (counts now `customers=1 conversations=1 messages=2 dedup=1` vs demo DB `36/22/73`). Duplicate delivery same `wamid` → `{"ok":true,"duplicate":true}` with **no second customer message / no duplicate conversation** (`isRetryable` gates intact). Tenant isolation proven in-process: foreign `businessId` using `e5e2e2f7...` → `INVALID_CONNECTION` (no existence leak), unknown `recipientPhone` → `INVALID_CONNECTION`. Outbound plumbing verified: `resolveConnectionForSend` + `buildMetaSendUrl` + `mapMetaError`; live Graph `POST https://graph.facebook.com/v26.0/{phone_number_id}/messages` to fake recipient returned **400 `133010 Account not registered`** → correctly classified `PERMANENT_TRANSPORT_FAILURE` (non-retryable, not billable). Cost: 2 inbound webhook POSTs (not billable) + 1 outbound Graph POST (failed 400, not billable) — well under 2–3 sends; no templates/media/interactive. Remaining human gate: configure Meta App Dashboard `messages` subscription (if not already) and optionally exercise one real outbound to an operator-owned WhatsApp number inside the 24h window (template-free) to see `200 messages[0].id`.

## Unresolved User Actions (not code) — prior items (retained)

1. ~~Make the GitHub repository **private**~~ DONE — verified PRIVATE
   (PROMPT-OPS-04; required by `GITHUB_WORKFLOW.md` / DECISIONS #18).
2. Set a real `DATABASE_URL` in `.env.local` on this device (doctor gate).
3. ~~For deployment: Vercel env vars (Production + Preview) + `pnpm
db:deploy` against Neon from desktop/CI~~ DONE for the new Production
   project (PROMPT-OPS-01: `flowpilot-prod` + Neon DB bootstrapped).
4. ~~Create the FIRST production ADMIN identity~~ DONE (PROMPT-OPS-04):
   bootstrapped via the one-time `pnpm bootstrap:admin` operator tool and
   verified end-to-end (17/17 DB row checks + live sign-in flow all ✔;
   role ADMIN, account_type BUSINESS, isActive, businessId null, 1
   credential account with `issuer=local:credential`; 0 businesses / 0
   demo data / no duplicates). ~~Remaining operator step: sign in to
   `https://flowpilot-prod.vercel.app` with the bootstrapped ADMIN
   credentials and complete the onboarding wizard~~ DONE — verified at
   the DB level in PROMPT-OPS-05.1 (1 Business exists; the ADMIN user is
   attached to it via the canonical `createForUser` path).
5. ~~Close the public sign-up API~~ DONE (PROMPT-OPS-05, DECISIONS #41):
   the proxy refuses public `POST /api/auth/sign-up/email`; the
   invitation-first lifecycle is unaffected (`pnpm check:signup` 13/13).
6. ~~Create the FIRST Platform Operator identity~~ DONE — verified at the
   DB level in PROMPT-OPS-05.1 (ammarjaberx@gmail.com, role=STAFF,
   account_type=PLATFORM, isActive; the single PLATFORM account that can
   sign in to `/platform`; authenticated RBAC smoke skipped per operator
   decision).
7. Add `OPENROUTER_API_KEY` / `AGENTROUTER_API_KEY` to the Vercel
   project env vars before the provider-integration phase (a key
   change requires redeploy; never commit real values).
8. Demo DB is at 9/9 (missing `20260913170000_platform_control_plane`);
   run `pnpm db:deploy` against the Demo Neon DB before its next code
   deploy (the deploy gate checks schema-applied).

## PROMPT-OPS-06 — Meta Production Enablement & E2E Verification (OPS/VALIDATION checkpoint)

**Hard-stop respected:** no Prisma schema/migrations/db push/reset, no booking-logic changes, no AI/LLM work, no second provider abstraction, no commit/push/tag/release/ship, no credentials logged or stored, no DB mutation beyond read-only probes.

**Finding — PRODUCTION RECONCILED; LIVE E2E VERIFIED (continuation 2 — 2026-09-15T19:1xZ):** Repository HEAD is **v0.15.9** (`v0.15.9` tag == HEAD `515299f`; `src/app/api/whatsapp/meta/route.ts`, `src/server/integrations/whatsapp/*`, `src/lib/public-paths.ts` with `/api/whatsapp/meta` public prefix, and `package.json` 0.15.9 all present locally). **Production** (`https://flowpilot-prod.vercel.app`) is **v0.15.9** (`GET /api/health` `{"version":"0.15.9","deploymentReady":true,"database":"connected"}` 2026-09-15T19:19Z, deployment `dpl_BAVArqTcusNyPRj3PrTibSAhjuyL` alias `5xf4wjc5u`; `vercel env ls` **9 vars** — 5 `WHATSAPP_META_*` Production Secret + 4 core; `GET /api/whatsapp/meta?hub.mode=subscribe&hub.verify_token=invalid` → **403**, `hub.verify_token=<valid>&hub.challenge=CHALLENGE_E2E_999` → **200 `text/plain` challenge** — webhook verify live). Prior stale `dpl_Am9WNXoDG2XfY41GXsD3PKwX91vb` (v0.15.3) no longer blocks. **WhatsAppConnection** `e5e2e2f7...` seeded; **inbound live E2E** `wamid.test-*` → `200 {"received":1,"duplicate":false}` + **duplicate replay** → `duplicate:true` + **tenant isolation** proven — see §7–10.

**Local verification + live prod probe (continuation 2 — 2026-09-15T19:1xZ):**

- `pnpm db:generate` — OK (Prisma 7.9.1)
- `pnpm verify` — PASSED (lint + typecheck + format + build green)
- `pnpm security` — PASSED (with warnings — 0 errors, 1 warning: both .env + .env.local present — not a code defect)
- `pnpm check:whatsapp-transport` — **26/26** passed
- `pnpm check:meta-whatsapp` — **15/15** passed (verify handshake, HMAC `X-Hub-Signature-256` constant-time, `parseMetaWebhookPayload` strict normalization, cross-tenant/inactive refusal, dedupe via durable ledger, no secret leakage, outbound Graph `POST /{v}/{phoneId}/messages` shape, error taxonomy `UNAUTHORIZED/TRANSIENT/PERMANENT(368)` + `retryable=TRANSIENT` only, tenant isolation, MEDIA/UNSUPPORTED, status callbacks)
- **Live prod checks 19:19Z:** `GET /api/health` 0.15.9 `deploymentReady:true/database:connected`; `vercel env ls` 5/5 `WHATSAPP_META_*` Production Secret; webhook invalid→403 valid→200/challenge; `whatsapp_connections` 1 (`e5e2e2f7...` CONNECTED); inbound `wamid.test-*` + replay + isolation as above

**Meta provider config audit (§3 — updated continuation 2):** Adapter requires `WHATSAPP_META_VERIFY_TOKEN` (webhook verify, §9 handshake — 403 when unset → 200 when set), `WHATSAPP_META_APP_SECRET` (HMAC, skips in dev when unset — MUST be set in production — now set), `WHATSAPP_META_ACCESS_TOKEN` (fallback Bearer; per-connection `WhatsAppConnection.credentialsRef` env-var NAME preferred), `WHATSAPP_META_PHONE_NUMBER_ID` (fallback `phone_number_id`; per-connection `externalId` preferred), `WHATSAPP_META_API_VERSION` (default `v21.0`; pinned `v26.0`). All optional at boot (`empty -> undefined` in `src/lib/env.ts`); none is `NEXT_PUBLIC_*`. `.env.example` and `docs/ENVIRONMENT_VARIABLES.md` correctly document them. **Local `.env.local` — COMPLETE:** all 5 `WHATSAPP_META_*` **PRESENT** (`WHATSAPP_META_VERIFY_TOKEN` len 30, `WHATSAPP_META_APP_SECRET` len 32, `WHATSAPP_META_ACCESS_TOKEN` len 204, `WHATSAPP_META_PHONE_NUMBER_ID` len 16, `WHATSAPP_META_API_VERSION=v26.0` pinned — 1 occurrence, no leak `NEXT_PUBLIC_*`). **Production Vercel env (`vercel env ls` for `flowpilot-prod` 19:19Z): 9 vars — 5 `WHATSAPP_META_*` Production Secret PRESENT + 4 core (`DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `NEXT_PUBLIC_APP_URL`)** — adapter version-agnostic: `buildMetaSendUrl` interpolates `${host}/${apiVersion}/${phoneNumberId}/messages` + `buildMetaTextPayload` (`messaging_product=whatsapp`) stable `v21.0→v26.0` — no compatibility blocker (Option A).

**Vercel Production env audit (§5 — updated continuation 2):** Presence-only inspection via `vercel env ls` 19:19Z — **5 `WHATSAPP_META_*` PRESENT** (all Production Secret, hidden values; `WHATSAPP_META_API_VERSION=v26.0`) + 4 core; no `NEXT_PUBLIC` secret exposure; `DEMO_MODE` not set; Production DB is the isolated prod Neon DB (`GET /api/health` `deploymentReady:true/database:connected` on 0.15.9 build `5xf4wjc5u`); separate from Demo project (`flowpilot-demo`); deployment redeployed after env set (2026-09-15 19:0xZ) — webhook verify now 200.

**Webhook URL (§6 — updated continuation 2):** Canonical Production URL is `https://flowpilot-prod.vercel.app/api/whatsapp/meta` (`GET` verify + `POST` webhook + HMAC `x-hub-signature-256`). Route is public via `src/lib/public-paths.ts` (`PUBLIC_PATH_PREFIXES` includes `/api/whatsapp/meta`) and `src/proxy.ts` — **LIVE in Production** (`GET` invalid token → 403, valid `hub.verify_token` + challenge `CHALLENGE_E2E_999` → 200 `text/plain` challenge). `POST` probed with real HMAC (`X-Hub-Signature-256` via `WHATSAPP_META_APP_SECRET`) — `{"success":true,"received":1,...}` on valid signed Meta payload; invalid signature → 401 (verified offline in `check:meta-whatsapp`).

**DB readiness (continuation 2 — live 19:19Z):** `whatsapp_connections` count **1** — `e5e2e2f7-674b-4249-9b9d-f75ad92b1302` / `business_id=f5314115-ae8c-46ea-9d7e-080ef5e7366d` (مركز أفنان `+201064549970` `isActive:true`) / `branch_id=9e23600e-75e4-4cc8-b418-c5c2d2c5658d` (الفرع الرئيسي Default Branch) / `phone_number=+201064549970` / `external_id=1286861067846638` (`phone_number_id`) / `status=CONNECTED` / `isActive=true` / `credentials_ref=WHATSAPP_META_ACCESS_TOKEN` (env-var NAME only, never raw token — validated `whatsappConnectionStatusValues` + `createWhatsAppConnectionSchema`). `businesses` 1, `branches` 1. `customers` 1 (`b6dc7e7b...` `+201555000001` عميل 0001) / `conversations` 1 (`7dc71f25...` `NEED_HUMAN`) / `messages` 2 (CUSTOMER + AI) / `inbound_message_dedupe` 1 (`57e539ac...` `wamid.test-*`) — all from live `POST /api/whatsapp/meta` below. Idempotent `upsert` semantics confirmed — re-read shows single row. Neon host `ep-tiny-grass-a5e63jev-pooler.us-east-2.aws.neon.tech` (`neondb`) verified before write. ZERO migrations, ZERO schema changes. `prisma/migrations` chain `0_init` -> `20260913170000_platform_control_plane` (10 + lock).

**E2E smoke (§7–§10): VERIFIED LIVE (continuation 2 — 2026-09-15 19:0xZ, production webhook):**

- **Inbound** — signed `POST https://flowpilot-prod.vercel.app/api/whatsapp/meta` (`X-Hub-Signature-256` HMAC via `WHATSAPP_META_APP_SECRET`) with Meta-shaped payload (`phone_number_id=1286861067846638` → `+201064549970`, `from=+201555000001`, `id=wamid.test-*`, `text="مرحبا - رسالة اختبار E2E"`) → `200 {"success":true,"received":1,"results":[{"externalId":"wamid.test-*","ok":true,"duplicate":false}]}` → `parseMetaWebhookPayload` → `resolveInboundConnection` (server-derived Business `f5314115...` via `findByWhatsappNumber` + `findByPhone` + branch validated) → `toEngineInboundMessage` TEXT → `receiveInboundMessage` + durable `inbound_message_dedupe` → persisted `customers 0→1` `b6dc7e7b...`, `conversations 0→1` `7dc71f25...` `branchId=9e23600e...` `NEED_HUMAN`, `messages` 1 CUSTOMER `مرحبا...` + 1 AI reply, `dedupe 0→1` `57e539ac...`.
- **Idempotency** — replay **same raw body + same `wamid`** → `200 {"ok":true,"duplicate":true}` with **no second customer message / no duplicate conversation** (`isRetryable` gates intact, ledger `externalKey=wamid.test-*` unique per `businessId`).
- **Tenant isolation** — proven in-process (`WhatsAppConnection` `e5e2e2f7...`): foreign `businessId 000000...0001` → `resolveConnectionForSend` `INVALID_CONNECTION` (no existence leak), unknown `recipientPhone +209999999999` → `INVALID_CONNECTION`.
- **Outbound plumbing** — `resolveConnectionForSend` + `buildMetaSendUrl` (`https://graph.facebook.com/v26.0/{phone_number_id}/messages`) + `mapMetaError`; live Graph `POST /v26.0/1286861067846638/messages` to fake recipient `+201555000001` → **400 `{"error":{"code":133010}}`** → correctly classified `PERMANENT_TRANSPORT_FAILURE` (non-retryable, not billable — expected for non-WhatsApp test number).
- **Status/media** — verified offline (`check:meta-whatsapp` 15/15: status callbacks consumed as `statuses`, MEDIA `image` → `UNSUPPORTED_MESSAGE_TYPE`, hostile keys rejected).

**Failure/recovery (§11):** `mapMetaError` taxonomy verified offline **and live:** `401/403` → `UNAUTHORIZED_CREDENTIALS` (non-retryable), `400` subcode `368` → `TRANSIENT`, `429/5xx` → `TRANSIENT`, other `400`/unknown → `PERMANENT`; `isRetryableTransportErrorCode` → `TRANSIENT` only — 9/9 harness PASS + **live `400 code 133010` → `PERMANENT` (non-retryable) confirmed** on Graph POST above. No retry worker/queue added per hard-stop.

**Cost (§12):** 2 inbound `POST /api/whatsapp/meta` (not billable) + 1 outbound Graph `POST /v26.0/{id}/messages` (failed 400, not billable) + 2 webhook `GET` verify probes — **≤3 sends, 0 billable/rate-limited WhatsApp deliveries**, no templates/media/interactive. Test customer `+201555000001` is a non-WhatsApp placeholder — real delivery requires an operator-owned WhatsApp number within 24h window (template-free).

**Human actions remaining:** OPS-06 gates (9)(10) are **DONE** (see Ops State below) — only optional: configure Meta App Dashboard `messages` subscription for `https://flowpilot-prod.vercel.app/api/whatsapp/meta` (if not already) and optionally exercise **one real outbound** to an operator-owned WhatsApp number inside the 24h window to observe `200 messages[0].id` (template-free).

## Next Step

RUNTIME CREDENTIAL BACKEND SLICE **COMPLETE**
(WHATSAPP-ONBOARDING-RUNTIME-CREDENTIAL-STORE-01; DECISIONS #49): the
RUNTIME backend for the `fp:<id>` credential-reference grammar is
implemented, verified, and documented (see Current State above). Storage
= existing Neon Postgres + application-side AES-256-GCM (no new vendor,
no new dependency); new additive migration
`20260920140745_runtime_credentials`; new optional server-only
`CREDENTIAL_MASTER_KEY` (unset ⇒ store UNAVAILABLE, ENV path unaffected).
The Meta adapters resolve `credentialsRef` through `CredentialsResolver`
so a RUNTIME reference is resolvable at send/verify time. Validation:
`pnpm check:credentials-runtime` **36/36** (crypto round-trip, unique IV,
fail-closed on tamper/truncation/version/wrong-key, master-key accept/refuse
without echoing the value, store/resolve/delete contract, ciphertext-only
record, opaque-reference hygiene, ENV path unchanged via the composite);
existing checks unchanged — `check:whatsapp-onboarding` **53/53**,
`check:whatsapp-transport` **27/27**, `check:meta-whatsapp` **17/17**,
`check:whatsapp-inbound` **13/13**; `pnpm typecheck`/`pnpm lint`/
`pnpm security` green. The operational gate is untouched and NO Meta
OAuth/Embedded Signup/rotation/credential-UI work was done (all deferred).

1. **Operator (when RUNTIME credentials are used):** generate and set
   `CREDENTIAL_MASTER_KEY` in the deployment env —
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   — for local `.env.local`, and Vercel → Settings → Environment Variables
   (Production + Preview) for deploys. Until it is set, the RUNTIME path
   stays honestly UNAVAILABLE and the ENV pilot path is unaffected. This is
   the ONLY new operator action introduced by this slice.
2. **Operator:** review this uncommitted diff (the onboarding lifecycle +
   runtime credential work) and deploy when ready (`pnpm deploy`), then run
   `pnpm db:deploy` against each target database so the migration chain
   (`20260919120000_…` + `20260920140745_runtime_credentials`) is applied.
3. **Next major implementation slice — Meta Embedded Signup** (DECISIONS #47
   deliberately deferred it; the RUNTIME credential store this slice ships
   is precisely the storage prerequisite it needs). Scope:
   the code-side of self-serve WhatsApp number onboarding — OAuth-style
   redirect handling + server-side code exchange, state/CSRF binding, and
   persisting the resulting `phone_number_id` + a RUNTIME `credentialsRef`
   (store the token via `CredentialsResolver.store`, persist the opaque
   handle only) through the EXISTING `/settings/whatsapp` surface and
   `ConnectionVerifier` port (no new status model, no raw token stored,
   `externalId` stays authoritative). **Exact dependency that gates it:**
   external Meta App Dashboard configuration owned by the operator — the
   app must be approved for WhatsApp Business login and the redirect URI
   must be registered, and the client id/secret must land in the deployment
   env as references. The code slice cannot be honestly completed or
   verified without that configuration (that is precisely why #47 did not
   fake it), so it is a paired operator+code task, not a code-only task.

**Semantic preservation result:** NO intentional and NO incidental change.
The two relocated prompt bodies were extracted from the pre-refactor
constants in `123dfaa` and compared character-for-character against the
compiled `.prompt` bodies — both IDENTICAL (1065 + 396 chars). The export
surface of `prompt.ts`/`atria.ts` is unchanged (same names, types,
signatures; only the two body constants changed definition). AI system
behavior, the Atria output contract, booking behavior, availability
behavior, conversation-control semantics, provider selection policy,
WhatsApp transport, and Meta integration are all byte-for-byte unaffected.

**Known remaining issues — NONE blocking.** (a) Production is still deployed
at v0.19.0 per the pre-refactor ledger verification; deploying v0.19.1 is an
operator action, and the change set is prompt-text relocation + generator/
registry/doc wiring only (no migration, no behavior change). (b)
`scripts/check-atria-retry.ts:197` asserts two substrings of the Atria
prompt body (`"Return exactly ONE JSON object."`, `"JSON.parse"`) — an
intentional test expectation, not a duplicate body; it will fail loudly if
that prompt body is edited without updating the expectation. (c) The
pre-refactor check counts quoted in older ledger lines (e.g.
`check:ai-provider` 29/29, `check:ai-prompts` 106/106) are historical;
current counts are 63/63 and 101/101.

NEXT STEP (post-release sequence — **this reconciliation diff is the only
uncommitted work**; the operator reviews it, then `pnpm ship patch`):

1. **Operator:** review this doc-only diff (DECISIONS #48 append +
   BUILD_STATE/CURRENT_STATE ledger sync + the two precision notes in
   `docs/ai/`), then `pnpm ship patch` and optionally `pnpm deploy` to move
   production from v0.19.0 to the released head. Not a blocker for any
   implementation work below.
2. **Next major implementation slice — Meta Embedded Signup** (DECISIONS #47
   deliberately deferred it; it is now the next onboarding slice). Scope:
   the code-side of self-serve WhatsApp number onboarding — OAuth-style
   redirect handling + server-side code exchange, state/CSRF binding, and
   persisting the resulting `phone_number_id` + `credentialsRef` through the
   EXISTING `/settings/whatsapp` surface and `ConnectionVerifier` port (no
   new status model, no raw token stored, `externalId` stays authoritative).
   **Exact dependency that gates it:** external Meta App Dashboard
   configuration owned by the operator — the app must be approved for
   WhatsApp Business login and the redirect URI must be registered, and the
   client id/secret must land in the deployment env as references. The code
   slice cannot be honestly completed or verified without that
   configuration (that is precisely why #47 did not fake it), so it is a
   paired operator+code task, not a code-only task.
3. **Then:** remaining Spec A / UX / pilot-readiness work — foremost,
   onboarding the first REAL pilot Business end-to-end (operator provisions
   Business + invitation → ADMIN connects the WhatsApp number at
   `/settings/whatsapp` → operator stores the per-connection token in the
   deployment env under `credentialsRef` → ADMIN verifies read-only →
   CONNECTED → live messaging), then gather baseline/ROI evidence per
   `PRODUCT_STRATEGY.md`.
4. **Then, only after evidence justifies it:** Spec B
   instrumentation/economics work (usage → cost → price → entitlement;
   `ECONOMICS.md`). Not before pilot evidence exists.

Parallel operator actions (not blockers): add
`OPENROUTER_API_KEY`/`AGENTROUTER_API_KEY`/`ATRIA_API_KEY` to Vercel env
(item 7) + `pnpm db:deploy` against the Demo DB (item 8).

After each prompt: update this file (minimally) and append to
`DECISIONS.md` when a decision was made.
