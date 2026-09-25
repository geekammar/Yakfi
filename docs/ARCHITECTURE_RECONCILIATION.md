# FlowPilot — Architecture Reconciliation

> Bridge document: summarizes the MAJOR architecture changes accepted
> AFTER the PROMPT-19 conversation-engine slice, and explicitly supersedes
> stale assumptions that older prompts and documents carried. Full binding
> text: `DECISIONS.md` #30–#36 (implemented by #38). Current architecture:
> `ARCHITECTURE.md`. NOTE: the frontier has since moved to release
> **v0.29.0** (B-series UX slices, Meta Embedded Signup, operator
> attention) — this bridge covers only the #30–#36 era; for everything
> after it, read `BUILD_STATE.md` + `DECISIONS_INDEX.md`. Last updated:
> DOC-NORMALIZE-V029.

## What changed (accepted decisions — P0 foundations IMPLEMENTED in PROMPT-ARCH-02)

| #   | Change                                                                    |
| --- | ------------------------------------------------------------------------- |
| #30 | Business/Branch model + selective branch scoping                          |
| #31 | WhatsAppConnection as a first-class entity + thin channel boundary        |
| #32 | Provider model (ProviderProfile, ProviderService, ProviderBranch)         |
| #33 | AI/Domain/Conversation responsibility separation + minimal AI context     |
| #34 | Production reliability prerequisites (concurrency, idempotency)           |
| #35 | Scheduling scope (inherit business hours; defer workforce scheduling)     |
| #36 | Usage & Economics foundation + Usage/Cost/Price/Entitlement/Billing split |

None of these reverse the stack or the monolith — they extend the model to
be Branch- and Provider-aware where operationally meaningful, and they set
the safety bar for real production booking.

## Superseded assumptions (do NOT carry these forward)

| Old assumption (older prompts/docs)                            | Current truth                                                                                                                      |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `businessId` on every domain row is the whole tenancy story    | `businessId` stays the tenant boundary; Branch is operational scoping, applied selectively (#30) — never `branchId` on every table |
| Business = one physical location / one WhatsApp number forever | Business = commercial tenant; Branch = operational unit; WhatsAppConnection is first-class with optional `branchId` (#30, #31)     |
| `User.branchId` as the multi-branch model                      | Never — Provider↔Branch is a relation (ProviderBranch), not a user column (#32)                                                    |
| "No Provider concept" / staff assignment ≈ provider            | Provider is a bookable capability/profile (ProviderProfile on a User), NOT an authorization role (#32)                             |
| Appointment provider ≈ any staff user                          | One Appointment has at most one Provider, resolved via eligibility relations (#32)                                                 |
| "No usage/cost tracking; billing excluded forever"             | Usage + cost metering are current foundation; billing remains deferred but not forever-excluded; pricing unit not locked (#36)     |
| Race conditions accepted "at pilot scale" forever              | DB-boundary booking concurrency + idempotent webhook processing are PREREQUISITES for real production booking (#34)                |
| AI may reason over full business context                       | AI receives minimal resolved context; deterministic turns avoid LLM calls; no chain-of-thought storage (#33)                       |

## What did NOT change

- Stack & pattern: Next.js 16 App Router, TypeScript strict, PostgreSQL/
  Neon, Prisma 7 (pg adapter), Better Auth, Tailwind v4 + shadcn/ui,
  Vercel; feature-based modular monolith; repositories as the only Prisma
  consumers.
- Authorization roles stay ADMIN / STAFF only; Platform Operator stays a
  separate platform-level identity (DECISIONS #22).
- Human-in-the-loop stays mandatory (DECISIONS #03).
- WhatsApp-first with a thin channel-agnostic boundary — NO omnichannel
  infrastructure, no channel registry, no event bus (#31).
- Arabic-first, RTL-first, vertical-agnostic until a winner is chosen.
- No microservices, Redis, Kafka, message brokers, RAG/vector databases,
  generic workflow engines, or ActionRegistry/OutcomeRegistry.

## Where the implementation stands

The repository implements Spec A through PROMPT-19 plus the P0
architecture-hardening foundations of #30–#36 (PROMPT-ARCH-02, record
DECISIONS #38): Branch model with Default-Branch backfill, required
server-resolved `branchId` on Conversation/Appointment, WhatsAppConnection,
ProviderProfile/ProviderService/ProviderBranch, `users.accountType`
platform marker, SERIALIZABLE conflict-checked booking writes, durable
inbound-webhook idempotency (`inbound_message_dedupe`), the structured AI
contract (`ai-contract.ts`) with deterministic bypass, and append-only
usage telemetry (`usage_records`) — migration
`20260910120000_architecture_hardening_foundation` (apply from
desktop/CI: `pnpm db:deploy`). Consumer/UI status has since diverged:
WhatsAppConnection has BOTH a management UI (`/settings/whatsapp` + Meta
Embedded Signup, DECISIONS #47/#49) and a live provider; the ProviderProfile
relations gained their first consumers (CORE-01 eligibility, the booking
seam) but still have no management UI, and usage telemetry is recorded but
not surfaced. Both real provider integrations have been RESOLVED
and implemented — WhatsApp transport = Meta Cloud API (DECISIONS #42,
live in production) and the AI runtime = policy-backed adapters
(DECISIONS #44; `atria` added later) — and the Business WhatsApp connection
onboarding surface `/settings/whatsapp` landed (DECISIONS #47). See
`BUILD_STATE.md` for the authoritative ledger and next step.
