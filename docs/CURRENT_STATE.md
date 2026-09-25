# FlowPilot — Current State

> **Tier 0 cold-start snapshot** — read with `docs/AGENT_RULES.md`. This is a
> 30-second orientation, NOT a source of truth: canonical documents and the
> repository itself always override it. Implementation detail lives in
> `docs/BUILD_STATE.md`; decisions in `docs/DECISIONS.md` (routed by
> `docs/DECISIONS_INDEX.md`); the reading policy is in `docs/AGENT_RULES.md`.

**Version: v0.29.1** — released and committed (`bd91e2f`, tag `v0.29.1`;
HEAD == `origin/main`; tags through `v0.29.1`). The #56 slot-presentation
slice shipped in this patch release. The worktree carries ONE uncommitted
post-v0.29.1 fix: **the WhatsApp E2E disclosure-silence fix (DECISIONS #58)**
— proven root cause of a real inbound message receiving no reply; see below.

**Last shipped slice (v0.29.1):** the Spec A **cross-surface UX coherence +
slot-presentation audit** (DECISIONS #56) — presentation layer only: the slot
step renders the known candidate time grid with non-returned candidates
visibly muted + disabled + labelled «غير متاح» via the ONE shared pure module
`src/lib/scheduling/slot-grid.ts`; plus the customer-create prefill fix, the
operator-attention accessibility label, and the shared appointment date/time
formatter consolidation. **ZERO schema/migration/prompt/provider/AI-boundary
change.** This release also normalized the docs (DECISIONS #57).

## 1. What is currently implemented?

**Spec A is COMPLETE and pilot-ready at the presentation layer.** All screens
(onboarding, dashboard, conversations, appointments, Smart Create 1–6,
customers, services, settings, knowledge, team, staff workspace, platform
control plane) plus the full conversation engine are built and released.

**Verified recent milestones (all shipped through v0.20.0–v0.29.1):**

| Slice                                                                                       | Release | Decision |
| ------------------------------------------------------------------------------------------- | ------- | -------- |
| Meta Embedded Signup + runtime credential store                                             | v0.20.0 | #49      |
| Business WhatsApp onboarding UX reconciliation                                              | v0.21.0 | #47      |
| AI Knowledge Visibility Policy + Context Builder + Customer Disclosure Boundary             | v0.22.0 | #50–#52  |
| Human Handoff + Operator Attention                                                          | v0.23.0 | —        |
| Knowledge/FAQ authoring UX (suggestions)                                                    | v0.24.0 | —        |
| Service Catalog + Service Authoring UX                                                      | v0.25.0 | #53      |
| Appointment Creation UX (smart context, relative scheduling, availability-first, follow-up) | v0.26.0 | #54      |
| Booking UX + customer-create prefill                                                        | v0.27.0 | —        |
| Reschedule UX (availability-guided reschedule)                                              | v0.28.0 | —        |
| Appointments/Availability coherence — day-view correctness + day-capacity chips             | v0.29.0 | #55      |
| Slot presentation (visible-but-disabled unavailable candidates)                             | v0.29.1 | #56      |

**Also long-implemented and stable:** architecture-hardening P0 foundations
(DECISIONS #38 — Branch model, WhatsAppConnection, Provider relations,
DB-serializable booking concurrency, durable inbound idempotency, AI contract,
usage telemetry); migration chain repaired and complete (`0_init` root +
`migration_lock.toml`; 13 migrations, chain ends at
`20260923120000_operator_attention`); Meta WhatsApp Cloud API adapter live
(DECISIONS #42/#46); platform control plane (signup closed, Platform Operator
guards, platform owner invitations, Platform AI policy); conversation → booking
seam (CORE-01/CORE-02, deterministic, zero mutation); provider-agnostic AI
provider adapter (OpenRouter/AgentRouter policy-backed); Prompt Workspace
(`/prompts/**/*.prompt` → generated artifact → registry).

## 2. What was completed through the recent B-series work?

The B-series closed the AI-trust boundary and the owner-facing UX surface:
knowledge visibility → context building → customer disclosure (what the AI may
KNOW is now separate from what it may MENTION), then the authoring/booking UX
surfaces (knowledge/FAQ, services, appointment creation, reschedule), then
appointments/availability coherence, and finally slot presentation. Every slice
was composition over the ONE existing booking/availability authority — no
second engine, no schema change.

## 3. What is intentionally deferred?

- Spec B instrumentation/economics — only after pilot evidence justifies it.
- Founder Side / vertical discovery engine (Spec C).
- Billing, subscriptions, payments (DECISIONS #36).
- Working-hours editing and account activate/deactivate in the settings UI.
- Explicit unavailable-REASON states (a future domain/API decision; #56
  deliberately infers no reason — never «مشغول»/Busy).
- `cancellationPolicy` / `whatsappNumber` AI request channels + human-notification
  UX (B-03 deferrals; behavior unchanged).

## 4. What remains unverified at real-browser/production level?

- **The WhatsApp E2E reply path is now FIXED and live-verified outbound
  (DECISIONS #58, post-v0.29.1, uncommitted):** a real inbound message on an
  AI_ACTIVE thread that the B-03 disclosure gate refuses no longer leaves the
  customer in silence — the turn delivers the deterministic safe handoff
  acknowledgment (real Graph send `delivered:true` proven) and still
  escalates to NEED_HUMAN + operator attention. One external dependency
  observed during the fix window: the live `atria` endpoint answered one
  real conversational turn (proven: it returned the exact self-authored
  `AMBIGUOUS` reply the fix targets) but was intermittently TIMING OUT
  (~16s×2) on subsequent probes — a transient provider condition, not an
  application defect.
- Real-browser verification of the presentation-layer UX slices (#54–#56) was
  NOT performed — they are structurally asserted in offline harnesses only.
- **Production deployment state is not live-verified in this pass.** The last
  live-verified production checkpoint in the ledger was v0.19.0
  (2026-09-19, `deploymentReady:true`, `database:connected`). Releases
  v0.20.0–v0.29.1 are committed but their deployment is an operator action;
  treat production version as unknown until the operator deploys + probes.
- The Meta Embedded Signup code path is implemented and offline-harnessed
  (`check:meta-embedded-signup`) but has never been exercised against a real
  operator-owned Meta App Dashboard configuration. It is on a documented
  **DEFERRED / HOLD** — see `docs/INTEGRATION_CHECKPOINTS.md` (do NOT
  silently reopen it during unrelated work).

## 5. What is the current product/architecture direction?

WhatsApp Appointment Conversion System — "Book more, chase less."
Arabic-first, RTL-first, mobile-first, **vertical-agnostic during discovery**.
Local Vertical Discovery (Kafr El Sheikh, Egypt): one identical generic engine
across appointment-driven verticals; evidence picks the winner. WhatsApp-first
(Meta Cloud API); Telegram remains a future secondary channel. Architecture:
feature-based modular monolith on Next.js 16 + Prisma 7/Neon + Vercel only.
Invariants that must never regress: **availability authority returns only
genuinely selectable slots; server-authoritative booking; visible-but-disabled
unavailable candidate slots; no Busy/reason inference; no per-slot availability
requests; no second availability engine.**

## 6. What is the next logical phase?

1. **Operator:** deploy the v0.29.1 head (`pnpm deploy`) and probe
   `/api/health` to move production off the v0.19.0-era checkpoint; run
   `pnpm db:deploy` so migrations through
   `20260923120000_operator_attention` are applied.
2. **Onboard the first REAL pilot Business end-to-end** (operator provisions
   Business + invitation → ADMIN connects the WhatsApp number via Meta Embedded
   Signup at `/settings/whatsapp` → CONNECTED → live messaging), then gather
   baseline/ROI evidence per `PRODUCT_STRATEGY.md`.
3. **Only after pilot evidence:** Spec B instrumentation/economics.
