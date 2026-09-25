# FlowPilot — Architecture

> Current technical architecture and dependency boundaries. Read together
> with `SPEC_A.md` and `BUILD_STATE.md`; recent-change bridge:
> `ARCHITECTURE_RECONCILIATION.md`. Last updated: DOC-NORMALIZE-V029 —
> Spec A is complete through release **v0.29.0**: the Meta WhatsApp adapter
> (CORE-03B, `src/server/integrations/whatsapp/`) is the live provider, the
> conversation → booking seam consumes CORE-01/CORE-02, Meta Embedded Signup
> + the runtime credential store are implemented (#49), and the owner-facing
> UX surfaces (services, knowledge, appointment creation, reschedule,
> day-view coherence, slot presentation #56) are released. The P0 hardening
> foundations of DECISIONS #30–#36 remain IMPLEMENTED (record: DECISIONS
> #38; schema: `DATABASE.md`), and the migration chain stays a complete
> empty-database bootstrap path (DECISIONS #40).

## Stack

| Layer      | Choice                                  | Notes                                                                                                                                                                                                                                             |
| ---------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework  | **Next.js 16 (App Router)**             | Latest stable at project start; supersedes the "Next.js 15" plan. Uses Next 16 conventions: async `params`/`searchParams`, `proxy.ts` (not middleware), error boundaries with `{ error, retry }`. Docs bundled in `node_modules/next/dist/docs/`. |
| Language   | TypeScript (strict)                     | `noUncheckedIndexedAccess`, no implicit any                                                                                                                                                                                                       |
| Database   | PostgreSQL (Neon)                       | Single shared database for all pilot tenants                                                                                                                                                                                                      |
| ORM        | Prisma 7                                | Driver-adapter client (`@prisma/adapter-pg`), generated to `src/generated/prisma`                                                                                                                                                                 |
| Auth       | Better Auth                             | Email+password; owns the shared `users` table identity fields                                                                                                                                                                                     |
| Styling    | Tailwind CSS v4                         | CSS-first tokens in `globals.css`                                                                                                                                                                                                                 |
| UI         | shadcn/ui (`radix-vega`) + Lucide icons | Primitives in `src/components/ui`                                                                                                                                                                                                                 |
| State      | TanStack Query                          | Server state only; no global client store                                                                                                                                                                                                         |
| Forms      | React Hook Form + Zod                   | Zod schemas are the validation source                                                                                                                                                                                                             |
| Charts     | Recharts                                | Installed, unused until dashboards                                                                                                                                                                                                                |
| Deployment | Vercel                                  | Turbopack builds on CI/desktop                                                                                                                                                                                                                    |
| PWA        | Manifest + service worker               | See "PWA Philosophy"                                                                                                                                                                                                                              |

## Architecture Pattern

**Feature-Based Modular Monolith.**

One deployable Next.js app. Domain logic lives in isolated feature modules.
No microservices, no message brokers, no external state stores.

### Folder Structure

```
src/
├── app/                    # Routing layer only (thin) — route groups:
│   ├── (auth)/             #   sign-in / sign-up / invite activation
│   ├── (app)/              #   authenticated app shell (sidebar/bottom nav)
│   ├── (onboarding)/       #   onboarding wizard (ADMIN-only)
│   ├── (admin)/            #   admin area (team management)
│   ├── (staff)/            #   staff workspace (STAFF-only)
│   └── api/                #   route handlers (auth, health,
│                           #   conversations/inbound webhook)
├── features/               # Domain modules — isolated from each other:
│   ├── auth/ onboarding/ dashboard/ services/ settings/
│   ├── appointments/ conversations/ customers/ staff/
│   ├── invitations/ knowledge/
├── components/
│   ├── ui/                 # shadcn/ui primitives (generated)
│   └── shared/             # cross-feature components (AppShell, DataTable,
│                           #   StatusBadge, PageHeader, EmptyState, StatCard,
│                           #   SearchInput, PWA components)
├── hooks/                  # cross-feature client hooks
├── lib/
│   ├── auth.ts / auth-client.ts   # Better Auth instances
│   ├── env.ts              # Zod-validated environment (fail fast)
│   ├── status.ts           # canonical status system
│   ├── app-config.ts       # app name, RTL direction, nav definitions
│   └── validation/         # Zod schemas + DTOs per entity
├── server/
│   ├── db/                 # Prisma client singleton (pg adapter)
│   └── repositories/       # the ONLY layer touching Prisma directly
├── types/                  # domain type aliases over generated client
└── generated/prisma/       # generated client (gitignored)
docs/                       # project memory system + DATABASE.md
prisma/                     # schema.prisma + seed.ts
```

## Dependency Rules (enforced by convention)

1. Routes (`app/**`) render feature components — no business logic there.
2. Features import from: `@/components/ui`, `@/components/shared`, `@/lib/*`,
   `@/server/repositories`, `@/types`, and themselves.
3. Features NEVER import from other features. Composition happens in routes.
4. Only `src/server/repositories/*` may import the `db` singleton.
5. No circular dependencies. Shared logic is promoted to `@/lib` or
   `@/server` deliberately and stays small.
6. No giant barrels or mega-utils.

## Channel Boundary (WhatsApp-first)

- WhatsApp is the **current product channel**; additional channels are
  future possibilities only.
- The boundary is **thin and channel-agnostic**: the Conversation Engine
  works against provider-neutral seams — `MessageTransport` /
  `ConversationAi` (DECISIONS #29) plus the transport foundation
  `src/server/transport/whatsapp-transport.ts` (PROMPT-CORE-03A:
  normalized inbound envelope + `normalizeInboundTransportMessage` →
  `resolveInboundConnection` → `toEngineInboundMessage`, outbound
  `OutboundMessage` → `MessageTransport`, `WhatsAppTransportErrorCode` /
  `TransportError`) — and never embeds vendor specifics (no Meta
  SDK/HTTP/signature/media-download in the boundary).
- Do NOT build omnichannel infrastructure: no channel registry, no generic
  event bus, no channel capability matrix, no multi-channel UI.

## Business / Branch Model (DECISIONS #30 — IMPLEMENTED, PROMPT-ARCH-02)

- **Business** = the commercial tenant/company (billing identity, owner of
  data). **Branch** = an operational unit inside the Business.
- Every Business gets a **Default Branch** automatically — structurally:
  `Business.defaultBranchId` is a one-to-one pointer, created in the SAME
  transaction as the Business and backfilled for existing Businesses
  (migration `20260910120000_...`). No `isDefault` flag, no second source
  of truth.
- The current product UX remains effectively single-Branch (the Default
  Branch). Branch-aware ONLY where operationally meaningful — never
  `branchId` on every table:

| Scoping        | Entities                                                                        |
| -------------- | ------------------------------------------------------------------------------- |
| Branch-aware   | Conversation, Appointment, operational Availability context, WhatsAppConnection |
| Business-level | Customer, User, Service, Knowledge                                              |
| Relation-based | Provider ↔ Branch, Provider ↔ Service                                           |

- `Conversation.branchId` and `Appointment.branchId` are required and
  always resolved SERVER-side (the Default Branch today) — never client
  input. No Branch CRUD UI exists.
- A Customer can interact with multiple Branches (Customer stays
  Business-level; never Branch-owned by default).
- `User.branchId` is NEVER the multi-branch model.

## Provider Model (DECISIONS #32 — IMPLEMENTED as data foundation, PROMPT-ARCH-02)

- **Provider is NOT an authorization role** (roles stay ADMIN/STAFF only).
  A Provider is a bookable capability/profile: a minimal `ProviderProfile`
  attached to a User. No profession-specific role system, no generic
  skills/capability engine.
- **ProviderService** = lightweight Provider↔Service eligibility relation
  (unique pair, same-Business validated in the repository). **ProviderBranch**
  = lightweight Provider↔Branch relation (unique pair; a Provider may work
  in multiple Branches).
- **One Appointment carries at most one Provider** for now — represented by
  the existing `assignedUserId` seam (unchanged in ARCH-02; a future
  providerId rewiring is a separate decision). Multiple Providers can exist
  in the same Business. Multi-provider appointments are explicitly deferred.
- "أي دكتور / any provider" behavior: resolve eligible providers → resolve
  availability → rank **deterministically** by useful/earliest slot →
  return a small set (normally 2–3) → let the customer choose. This is NOT
  an AI/ML recommendation engine; booking and availability stay
  deterministic. (IMPLEMENTED — PROMPT-CORE-01: the deterministic
  Provider / Service Eligibility Resolver `resolveEligibleProviders`,
  relation-driven over the existing ProviderService/ProviderBranch
  relations. IMPLEMENTED — PROMPT-CORE-02: the deterministic Any-Provider
  Booking Options Resolver `resolveBookingOptions` CONSUMES CORE-01 and
  computes per-Provider availability over the EXISTING Availability layer
  — per-Provider conflicts via `AppointmentRepository.
listBlockingByAssignees`, the read counterpart of the booking write
  path's existing `assignedUserId` scoping, with `ProviderRepository.
listAssignmentSeams` as the ONE batched ProviderProfile.id → userId
  projection; ranking by earliest slot then the stable CORE-01 order, a
  small 2–3 option result, explicit empty reasons, READ-ONLY. Both resolvers
  are CONSUMED: CORE-01/CORE-02 serve the deterministic conversation →
  booking seam (`conversation-engine.ts` → `booking-mapper.ts`) and the
  availability layer, with zero appointment mutation from the AI path.)

## Scheduling (DECISIONS #35 — scope unchanged)

- Initial Provider availability **inherits Business working hours**.
- Provider-specific shifts, leave, and complex workforce scheduling are
  deferred. Do not build scheduling infrastructure the current pilot does
  not require.

## WhatsApp Connection (DECISIONS #31 — data foundation PROMPT-ARCH-02; transport contracts PROMPT-CORE-03A)

- `WhatsAppConnection` is a **first-class entity**: the Business owns the
  WhatsApp identity — `businessId` required, `branchId` optional.
- Default pilot model: one Default Branch + one Branch-scoped
  WhatsAppConnection. A future **Business-shared** WhatsApp connection must
  remain architecturally possible.
- Provider-neutral by construction: `provider`/`externalId` are opaque
  machine keys; `status` is a Zod-validated machine key; `credentialsRef`
  stores a REFERENCE to a secret (env var / secret-store pointer / blob
  locator) — NEVER raw credentials. The vendor is Meta (WhatsApp Cloud API,
  DECISIONS #42 — adapter in `src/server/integrations/whatsapp/`) and the
  connection-management UI exists: `/settings/whatsapp` plus the Meta
  Embedded Signup callback (`/whatsapp-onboarding/callback`, #49).
- Do NOT hard-code "one Business = one WhatsApp number" as a permanent
  domain assumption, and do NOT tie Conversation Core to a specific
  WhatsApp provider. Inbound identity resolution PREFERS the provider's
  stable id: Meta `phone_number_id` → `WhatsAppConnection.externalId` →
  `findByExternalId` (DECISIONS #46); `Business.whatsappNumber` is the
  retained FALLBACK mapping, not the primary key.
- PROMPT-CORE-03A: the transport foundation's canonical seams live in
  `src/server/transport/whatsapp-transport.ts` (`NormalizedInbound
TransportMessage` / `OutboundMessage` / `MessageTransport` /
  `TransportError` + taxonomy; `resolveInboundConnection` /
  `resolveConnectionForSend` are the ONLY tenant/branch resolution
  boundary — server-derived via the existing repositories, `strict()`ed
  at the envelope, `credentialsRef` never returned). The conversations
  feature re-exports them via
  `src/features/conversations/server/conversation-transport.ts`
  (feature-local `offlineMessageTransport` stays offline honest).
  Zero schema changes; no vendor code — the Meta adapter is CORE-03B.

## Responsibility Separation (DECISIONS #33 — binding; contract IMPLEMENTED, PROMPT-ARCH-02)

| Layer               | Owns                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------- |
| Conversation Engine | orchestration, persistence, customer/conversation resolution, state, human handoff        |
| AI                  | understanding, intent/entity/preference extraction, ambiguity handling, response phrasing |
| Domain              | authoritative validation and deterministic execution                                      |

**Rule: AI interprets. Domain decides and executes. Conversation
orchestrates.**

- AI must NEVER be the source of truth for availability, provider
  eligibility, conflicts, or booking.
- **AI minimal context (enforced by `ai-contract.ts`):** the request is a
  bounded, typed object — current message + compact conversation state +
  only task-relevant facts (services, knowledge entries, provider
  preference, availability results when relevant). The complete
  DB/business context is never sent on every AI call; the response is a
  structured, bounded object (intent family, action, content, facts-only
  extraction) — unknown keys (any provider "reasoning") are STRIPPED by
  Zod, so chain-of-thought never crosses the boundary and is never
  persisted.
- Deterministic turns avoid AI calls when safely possible
  (`bypassDeterministicAi` — the engine consults it before the assistant).
- Never store chain-of-thought — the structured Conversation State stores
  useful facts only.
- **What may enter AI context at all is governed by the knowledge
  visibility policy (PROMPT-B01, DECISIONS #50)** — four levels
  (`PUBLIC` / `CONDITIONAL` / `INTERNAL` / `FORBIDDEN`) that separate "AI
  may know this" from "AI may mention this to the customer". **The Context
  Builder (PROMPT-B02, DECISIONS #51) applies it at the AI boundary** —
  orchestration → builder → `AiRequest` — classifying every candidate,
  proving tenant scope, omitting operational facts the task does not
  require, and dropping provenance. **The Disclosure Gate (PROMPT-B03,
  DECISIONS #52) enforces it at the customer boundary** — a validated
  `AiResponse` may be sent to the customer only when its task is backed by an
  included + disclosable + carried fact; otherwise the turn takes the
  existing `NEED_HUMAN` / `AI_HANDOFF` path. Canonical detail:
  `docs/ai/ARCHITECTURE.md → Knowledge visibility policy`,
  `→ AI context builder` and `→ Customer disclosure boundary`;
  implementations `src/lib/ai-knowledge-visibility/`,
  `src/features/conversations/server/ai-context-builder/` and
  `src/features/conversations/server/ai-disclosure/`.

## Production Reliability Prerequisites (DECISIONS #34 — IMPLEMENTED, PROMPT-ARCH-02)

1. Booking concurrency is protected at the DB/transaction boundary:
   conflict-checked create/reschedule run in SERIALIZABLE transactions
   with a bounded retry loop; concurrent conflicting creates cannot both
   commit, and the loser surfaces the typed `SLOT_CONFLICT` (mechanism
   rationale: DECISIONS #38 — the asymmetric conflict rule is not
   expressible as symmetric DB exclusion constraints).
2. Inbound webhook processing is idempotent: a durable
   `inbound_message_dedupe` ledger (unique per business + external key) is
   claimed BEFORE irreversible processing, and the claim's message ids are
   recorded in the SAME transaction as the customer-message insert —
   redeliveries return idempotent successes with the original ids and
   zero new side effects.
3. Duplicate provider events cannot create duplicate business actions
   (same ledger; the external key is the transport message id when
   provided, else a deterministic hash of the canonical payload).

## Authentication & Authorization Model

> Locked in Prompt 09; binding decisions: `DECISIONS.md` #22–#25, #27, #41.
> Implementation is complete for BOTH scopes: BUSINESS (invitation model,
> creation, acceptance, ADMIN/STAFF activation, activation UI
> (`/invite/[token]`), role-aware sign-in handoff, onboarding handoff, and
> STAFF invitation via team management) and PLATFORM (operator marker,
> guards, the `(platform)` control plane, and platform owner invitations
> `/owner-invite/[token]` — DECISIONS #41). The Founder Side UI remains
> Spec B.

**One authentication system.** Better Auth is the single authentication
layer for ALL human users — Platform Operators, Business ADMINs, and
Business STAFF. Authentication answers "Who are you?"; authorization answers
"What are you allowed to access?". There is no separate authentication
system for platform users, business users, or staff, and no second auth
provider.

**Two authorization scopes.**

1. **PLATFORM** — platform-level access (Platform Operator / Founder).
2. **BUSINESS** — access scoped to one Business tenant.

Platform-level access is NOT a Business role. The Platform Operator
(Founder / Super User) is a platform-level identity, NOT a Business User,
and MUST NOT be represented by `UserRole.ADMIN` or `UserRole.STAFF`. The
platform-level authorization marker is IMPLEMENTED (PROMPT-ARCH-02):
`users.accountType` (`PLATFORM` / `BUSINESS`, machine key, default
BUSINESS) — server-managed (Better Auth `input: false`), unreachable from
any client input, and never inferred from `businessId = null`. Server
primitives: `isPlatformOperator(user)` and `requirePlatformOperator()`
(`src/server/auth/guards.ts`); Business-role guards (`requireRole`,
`requireApiUser({role})`) refuse platform operators. The first operator
identity is created by the one-time `pnpm bootstrap:operator` tool; further
platform identities are provisioned by the platform owner invitation flow
(`platform_invitations` → `/owner-invite/[token]` → pre-Business ADMIN,
DECISIONS #41). The Founder Side UI remains Spec B.

**Business roles remain `ADMIN` and `STAFF` only** (DECISIONS #02):

- `ADMIN` — controls Business settings, services, knowledge, team,
  conversations, appointments, customers. Invites STAFF.
- `STAFF` — works operationally inside the Business: handles
  assigned/allowed conversations, works appointments; does not manage
  Business settings or team.

**Invitation-first account creation (current pilot stage).** The primary
account-creation flow is:

```
Platform Operator
  → provision Business
  → invite initial ADMIN
  → ADMIN accepts invitation
  → ADMIN sets password / activates account
  → ADMIN completes Business onboarding
  → Business becomes operational
  → ADMIN invites STAFF
  → STAFF accepts + activates
```

There is NO approval workflow — the Platform Operator already decided by
provisioning the Business/Pilot. **Invitation is a FlowPilot domain
concept** (own model and lifecycle, documented in `DATABASE.md`) — it is NOT
a replacement for Better Auth and NOT part of its configuration. Public
self-sign-up is NOT the primary flow for the current pilot stage, but the
architecture must not prevent enabling it later as a separate
acquisition/provisioning mode after PMF.

**Tenancy & authorization rules (non-negotiable):**

1. Business data remains tenant-scoped by `businessId` (the tenant
   boundary); Branch scoping is selective (see Business / Branch Model).
2. Business ADMIN/STAFF may access only their Business.
3. UI visibility is NOT an authorization mechanism.
4. Server-side authorization is mandatory.
5. Repositories remain the only Prisma consumers.
6. Platform access must never be inferred simply from `businessId = null`.
7. Platform access must use an explicit platform-level authorization marker.
8. Do NOT introduce a general-purpose RBAC engine.
9. Do NOT introduce granular permissions in Spec A.
10. Do NOT introduce organizations/membership frameworks unless later
    evidence requires them.

## Database Philosophy

- **Single shared Postgres**, tenant isolation via `businessId` — the
  Business is the tenant; Branch/Provider scoping is selective and
  relation-based (DECISIONS #30–#32). No RLS/multi-schema yet.
- UUID primary keys everywhere; `createdAt`/`updatedAt` on every table.
- Soft deletes (`deletedAt`) where history matters; repositories always filter
  `deletedAt: null`. Details: `docs/DATABASE.md`.
- Schema changes only via Prisma migrations (`pnpm db:migrate`, never
  `db push` against shared environments without notice). The committed
  migration chain is the bootstrap truth (DECISIONS #40): a genuinely
  EMPTY database reaches EXACTLY `prisma/schema.prisma` via
  `pnpm db:deploy` — verified invariant, chain shape in
  `docs/DATABASE.md → Migration Chain`.

## Usage & Economics Foundation

Usage + cost metering (messages, conversations, AI runs, token usage, AI
cost, WhatsApp/provider cost, cost-to-serve, bookings, handoffs) belongs to
the current foundation; billing/subscriptions/payments stay deferred. Hard
separation: Usage ≠ Cost ≠ Price ≠ Entitlement ≠ Billing. Canonical
reference: `ECONOMICS.md` (DECISIONS #36). IMPLEMENTED as raw usage facts
(PROMPT-ARCH-02): append-only `usage_records` rows recorded best-effort by
the conversation engine (INBOUND_MESSAGE / OUTBOUND_MESSAGE / AI_TURN)
carrying ids, counters, provider/model machine keys, and status — never
message content, secrets, or chain-of-thought, and never pricing logic
(cost is only an optional point-in-time snapshot).

## State Management Philosophy

- Server data belongs to **TanStack Query** (cache, retries, invalidation).
- Local form state belongs to React Hook Form.
- **No Redux/Zustand/global stores.** If two distant components share state,
  lift it to the route or a query key — not to a global store.
- Optimistic updates allowed later for conversation replies only.

## PWA Philosophy

- Installable, Arabic-first (`dir: rtl` manifest), standalone display.
- Service worker caches immutable static assets (cache-first) and falls back
  to an offline page for navigations; API traffic is never cached.
- Offline-first booking flows are a future consideration, not current scope.

## Design System

Documented separately in `DESIGN_SYSTEM.md` (UX + design rules); implemented
via tokens in `src/app/globals.css` (colors, radii, shadows, z-index scale,
animation scale, status colors).

## Future Scalability Notes

When pilot volume justifies it (not before):

1. Per-vertical copy/template packs loaded from the vertical registry (Spec B)
2. Read replicas or Neon branching for analytics queries (Spec C)
3. WhatsApp provider abstraction behind one interface if provider changes
4. Job queue for reminders — start with Vercel Cron, not Kafka

These are notes, not commitments. Do not pre-build them.

## Forbidden Architectural Changes

Without explicit human approval recorded in `DECISIONS.md`:

- ❌ Microservices / service splitting
- ❌ Event bus / Kafka / RabbitMQ / Redis / external queues / message brokers
- ❌ Additional databases, ORMs, or query engines
- ❌ GraphQL / tRPC / additional API layers (server actions + route handlers suffice)
- ❌ Global client state libraries (Redux, Zustand, MobX)
- ❌ CSS frameworks beyond Tailwind / component libs beyond shadcn/ui
- ❌ Replacing Better Auth or Prisma
- ❌ Any infrastructure (containers, k8s, self-hosting) beyond Vercel + Neon
- ❌ Omnichannel infrastructure (channel registry, capability matrix, multi-channel UI)
- ❌ RAG / vector databases / generic workflow engines / ActionRegistry /
  OutcomeRegistry or any speculative infrastructure
- ❌ Premature optimization: caching layers, CDNs beyond Vercel defaults,
  rate limiting services — until real load demands it

Rationale: speed of iteration beats theoretical scalability during discovery.
