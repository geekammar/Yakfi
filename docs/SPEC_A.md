# FlowPilot — Spec A (Current Scope)

> The complete, frozen scope of the current build. Anything not listed under
> "Included" is out of scope. The spec sequence (A → B → C) and exit
> criteria live in `ROADMAP.md`. Implementation status lives in
> `BUILD_STATE.md` (never here). Last updated: DOC-NORMALIZE-V029 — scope is
> frozen and fully implemented through release v0.29.1.

## Scope Definition

**Spec A = Discovery Foundation + Booking Core**

One generic engine that a business can be onboarded onto and that converts
WhatsApp conversations into appointments — sufficient to run paid pilots and
collect evidence.

## Included

### 1. Login

- Email + password sign-in (Better Auth) — the single authentication system
- Session persistence; protected route groups `(app)`, `(admin)`, `(staff)`
- Arabic-first auth screens on centered-card layout
- Account creation for the current pilot stage is **invitation-first** (see
  `ARCHITECTURE.md → Authentication & Authorization Model` and
  `DECISIONS.md` #22): the Platform Operator provisions the Business and
  invites the initial `ADMIN`; the invitee accepts and activates the account
  (sets a password) at `/invite/[token]` (implemented in PROMPT-06), then
  completes onboarding. Public self-sign-up is NOT the primary pilot flow —
  it remains a possible future self-serve acquisition mode, and the
  authentication architecture must not prevent it

### 2. Onboarding

- Runs after invitation-based ADMIN account activation (not after public
  sign-up): the 4-step operational-foundation wizard — بيانات المنشأة
  (name, vertical, city, WhatsApp number, timezone, optional about), ساعات
  العمل (working hours), إعدادات الحجز الأساسية (default slot duration +
  cancellation policy), مراجعة وتشغيل (review + completion) (PROMPT-07)
- `vertical` is discovery METADATA for Local Vertical Discovery (stable
  machine key on the Business record) — never permission for vertical-
  specific UI
- Links the activated user as `ADMIN` of the business
- Resumable: `/onboarding` routes to the first incomplete step (completed
  accounts go straight to the dashboard); progress is server-authoritative
  on the Business record; completion re-validates all step data
  server-side and never requires services/knowledge as wizard inputs
  (both screens exist separately: `/services`, `/settings/knowledge`)
- The onboarding wizard is implemented and connected with the
  invitation-based lifecycle (PROMPT-06: activation hands off through
  sign-in to the wizard; the wizard area is ADMIN-only)

### 3. Business Setup

- View/edit business profile and working hours
- Activate/deactivate business account
- **Implemented (PROMPT-09):** `/settings` — business identity (name,
  vertical, city, WhatsApp number, timezone) and booking behavior
  (confirmation mode manual/automatic + cancellation policy),
  ADMIN-only, tenant-scoped. Working-hours editing and account
  activate/deactivate remain follow-up slices. The confirmation mode
  drives the server-derived initial status of new appointments.
- **Implemented (PROMPT-18):** `/settings/knowledge` — business
  knowledge entries (§6) over the plain-text `Business.faqs` JSON
  storage, ADMIN-only, tenant-scoped.

### 4. Services

- CRUD for bookable services (name, description, duration in minutes)
- Active/inactive toggle; inactive services hidden from booking flows

### 5. Availability

- Working hours per weekday (open/close/closed) from business setup
- Slot derivation for proposed appointment times
- Conflict awareness via `AppointmentRepository.hasConflict`

### 6. Business Knowledge

- Structured FAQ/knowledge entries the AI assistant may use when replying
  (e.g., prices, policies, preparation instructions)
- Plain stored text entries; no vector DB, no RAG infrastructure

### 7. Dashboard

- Calm overview: today's appointments, pending confirmations, conversations
  needing human attention, key stat cards
- Agenda-style upcoming list (see DECISIONS.md)

### 8. Conversations

- Thread list with status (`AI_ACTIVE`, `NEED_HUMAN`, `BOOKED`, `INCOMPLETE`)
- Thread view with ordered messages (`CUSTOMER`/`AI`/`STAFF`)
- Staff can reply (message sender `STAFF`), assign threads, set status,
  view/edit AI summary
- Message transport (WhatsApp provider integration) kept behind an interface;
  UI reads/writes via repositories
- **Implemented (PROMPT-19, DECISIONS #29):** the conversation engine slice
  — provider-neutral inbound webhook → engine → AI turn →
  reply or NEED_HUMAN, with `ConversationAi` + `MessageTransport` as the
  only vendor seams. Both provider decisions have since been resolved and
  implemented: WhatsApp = **Meta Cloud API** (DECISIONS #42, live) and the
  AI runtime = **platform policy-backed adapters** openrouter/agentrouter/atria
  with deterministic fallback (DECISIONS #44). The Business-side WhatsApp
  connection onboarding surface is `/settings/whatsapp` (DECISIONS #47).

### 9. Appointments

- Create/confirm/reschedule/cancel appointments linked to customer + service
- Status lifecycle: `PENDING → CONFIRMED → COMPLETED`, plus `CANCELLED`,
  `NO_SHOW`
- Agenda views by day/range with filters; conflict-checked scheduling

### 10. Team

- List business users (`ADMIN`/`STAFF`)
- Invite/add staff identity, set role, activate/deactivate
- No granular permissions beyond role

### 11. Customers

- Directory with search (name/phone), notes, last conversation/appointment
  timestamps
- Auto-created from inbound WhatsApp contacts (`upsertByPhone`)
- Customer history: their conversations and appointments

## Excluded (do NOT build)

| Excluded                | Reason                                                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Billing / subscriptions | Deferred (not never — DECISIONS #36); pilots are invoiced manually. Usage/cost metering IS in scope (`ECONOMICS.md`) |
| Payments                | No money movement inside the product                                                                                 |
| CRM features            | Pipelines/leads are out of product identity                                                                          |
| Marketing tools         | No campaigns/broadcasts                                                                                              |
| Founder Console         | Founder-side tooling arrives in Spec B                                                                               |
| Discovery Engine        | Vertical scoring arrives in Spec C                                                                                   |
| Marketplace             | Never part of FlowPilot identity                                                                                     |
| Public API platform     | No external developers during discovery                                                                              |
| Multi-language UI       | Arabic-only until verticalization                                                                                    |
| Native mobile apps      | PWA covers mobile                                                                                                    |
| Automated reminders     | Listed only as future scalability note; not Spec A                                                                   |

## Screens (Included)

| Route group | Screen                | Purpose                                                                                                                    |
| ----------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `(auth)`    | `/sign-in`            | Login                                                                                                                      |
| `(auth)`    | `/invite/[token]`     | Invitation activation (PROMPT-06): accept + set password + activate, then hand off to onboarding via safe sign-in redirect |
| `(app)`     | `/onboarding`         | Business onboarding wizard (after ADMIN activation; ADMIN-only guard)                                                      |
| `(app)`     | `/`                   | Dashboard                                                                                                                  |
| `(app)`     | `/appointments`       | Appointment list/agenda + detail actions                                                                                   |
| `(app)`     | `/conversations`      | Thread list                                                                                                                |
| `(app)`     | `/conversations/[id]` | Thread view + staff reply                                                                                                  |
| `(app)`     | `/customers`          | Customer directory                                                                                                         |
| `(app)`     | `/customers/[id]`     | Customer profile/history                                                                                                   |
| `(app)`     | `/services`           | Service catalog management                                                                                                 |
| `(app)`     | `/settings`           | Business settings (PROMPT-09): identity + booking behavior                                                                 |
| `(app)`     | `/settings/knowledge` | Business knowledge entries                                                                                                 |
| `(app)`     | `/settings/whatsapp`  | WhatsApp connection onboarding (DECISIONS #47): connect / verify / activate                                                |
| `(admin)`   | `/admin`              | Admin area shell (team mgmt entry)                                                                                         |
| `(admin)`   | `/admin/team`         | Team management                                                                                                            |
| `(staff)`   | `/staff`              | Staff area shell (own agenda/tasks)                                                                                        |

Route groups/layouts exist and every Spec A screen listed above is
implemented (see `BUILD_STATE.md → Completed Major Work`). The public
`/sign-up` route exists as a placeholder only and is no longer a Spec A
deliverable — invitation-based activation replaces it as the pilot
account-creation flow. Do NOT add Founder Console or any Spec B
functionality here.

## Spec Sequence & Exit Criteria

Moved to `ROADMAP.md` (PROMPT-ARCH-01): Spec A → Spec B (Evidence Layer +
Founder Side) → Spec C (Vertical Discovery Engine), with goals, contents,
and exit criteria. Implementation status: `BUILD_STATE.md`.
