# FlowPilot — Current State

> **Tier 0 cold-start snapshot** — read with `docs/AGENT_RULES.md`. This is a
> 30-second orientation, NOT a source of truth: canonical documents and the
> repository itself always override it. Implementation detail lives in
> `docs/BUILD_STATE.md`; decisions in `docs/DECISIONS.md` (routed by
> `docs/DECISIONS_INDEX.md`); the reading policy is in `docs/AGENT_RULES.md`.

**Version: v0.30.0** — released and committed (`8571a4a`, tag `v0.30.0`;
HEAD == `origin/main`; tags through `v0.30.0`; the worktree carries
uncommitted post-v0.30.0 Telegram second-channel work — the identity/data
foundation (DECISIONS #64) plus the thin adapter, `POST /api/telegram/webhook`,
and the Conversation-Engine bridge (DECISIONS #65), plus the Manager Bot
provisioning completion — `/start` creator binding + the `managed_bot` event
→ `fp:<id>` → `setWebhook` → `getMe` → CONNECTED at
`POST /api/telegram/manager/webhook` (DECISIONS #66), plus the
customer-facing onboarding surface `/settings/telegram` behaviorally wired
to that state machine with the focused journey harness + the canonical
operator live-E2E procedure (DECISIONS #67 — see `docs/TELEGRAM.md` and
the TELEGRAM checkpoint in `INTEGRATION_CHECKPOINTS.md`: BUILT +
offline-verified, **live E2E against a real BotFather manager bot is the
ONE remaining operator action**). The #58 WhatsApp E2E
disclosure-silence fix shipped in v0.29.2; the CodeCraft Discovery provider
adapter (DECISIONS #59) shipped in v0.29.3; the #60 AI-failure
acknowledgment fix shipped in v0.29.4; the #61 shared conversation-layer UX
and the #62 AI personality / operator-notification / conversation-UX slices
shipped in v0.30.0. The post-v0.30.0 **Telegram second channel** is now
UNDER WAY: the discovery pass (DECISIONS #63) mapped the exact seams, the
identity/data foundation is BUILT (DECISIONS #64), the thin Telegram
adapter + `POST /api/telegram/webhook` + the Conversation-Engine bridge are
BUILT and VERIFIED offline (DECISIONS #65), the managed-bot provisioning
state machine is BUILT and VERIFIED offline (DECISIONS #66 — three security
defects the focused harness surfaced were fixed in place), and the
customer-facing `/settings/telegram` surface is now BUILT + behaviorally
WIRED + offline-verified (DECISIONS #67) — Telegram is only a transport
implementation over the unchanged engine.
#62's smallest-surface findings: the
assistant's voice is now ONE structured provider-neutral/channel-agnostic
module carried as request context (no prompt editor, no persistence, no
migration — per-business style is deferred to pilot evidence); the
operator-attention path was audited correct on all 8 required properties and
closed for its one genuine gap (opening a flagged conversation now shows WHY
— an icon + Arabic reason chip with an accessible name, captured before the
acknowledge-on-open resolve); and the previously-observed long-scroll
identity issue was verified to be ALREADY SOLVED by the internal-scroll
layout, so no sticky UI was added (the two real gaps — 44px mobile touch
targets and the sending-indicator announcement — were fixed). The
personality and the notification behavior are both reusable by a future
Telegram channel by construction.

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

- **The WhatsApp E2E reply path is FIXED, live-verified outbound, and SHIPPED
  (DECISIONS #58, v0.29.2):** a real inbound message on an AI_ACTIVE thread
  that the B-03 disclosure gate refuses no longer leaves the customer in
  silence — the turn delivers the deterministic safe handoff acknowledgment
  (real Graph send `delivered:true` proven) and still escalates to NEED_HUMAN +
  operator attention. One external dependency observed during the fix window:
  the live `atria` endpoint answered one real conversational turn (proven: it
  returned the exact self-authored `AMBIGUOUS` reply the fix targets) but was
  intermittently TIMING OUT (~16s×2) on subsequent probes — a transient
  provider condition, not an application defect.
- **The CodeCraft live compatibility probe was run (DECISIONS #59, v0.29.3 +
  post-v0.29.3 forensics):** with `CODECRAFT_API_KEY` present, `pnpm
probe:codecraft` with `CODECRAFT_MODEL=deepseek-v4-flash-0731` and
  `PROBE_RUNS=3` returned 5/5 stages — `GET /v1/models` 200 with the exact
  model present (ctx=1048576, `json_mode`), 3/3 chat-completion SUCCESS,
  `parseMode=DIRECT_PARSE`, `parseAiResponse` conforming, latency p95 7.9s
  max 7.9s (well inside the 16000ms adapter bound). CodeCraft is therefore
  proven REACHABLE, the selected model AVAILABLE, and the FlowPilot contract
  satisfiable. The probe records only safe metadata (never the key).
- **The AI-failure WhatsApp silence is FIXED, but live-verified only against
  the offline + live-probe path (DECISIONS #60, SHIPPED v0.29.4):** live DB
  forensics proved a real CodeCraft `AI_TURN` FAILURE (fast, non-timeout)
  produced no assistant message and no `OUTBOUND_MESSAGE`, while the live
  probe proved the provider itself healthy — so the root cause was the
  engine's AI-failure branch, now fixed to deliver the #58 safe
  acknowledgment. A **fresh live WhatsApp E2E** is required to confirm the
  customer-visible reply on the real thread (see §6).
- Real-browser verification of the presentation-layer UX slices (#54–#56) was
  NOT performed — they are structurally asserted in offline harnesses only.
- **Production deployment state is not live-verified in this pass.** The last
  live-verified production checkpoint in the ledger was v0.19.0
  (2026-09-19, `deploymentReady:true`, `database:connected`). Releases
  v0.20.0–v0.29.4 are committed but their deployment is an operator action;
  treat production version as unknown until the operator deploys + probes.
  **Note:** the live-forensics DB IS the production Neon DB, so the failing
  CodeCraft `AI_TURN` row and the stuck thread are REAL production evidence —
  the deployed build must be at least v0.29.3 (the row records
  `provider:"codecraft"`, which only that release's code can emit).
- The Meta Embedded Signup code path is implemented and offline-harnessed
  (`check:meta-embedded-signup`) but has never been exercised against a real
  operator-owned Meta App Dashboard configuration. It is on a documented
  **DEFERRED / HOLD** — see `docs/INTEGRATION_CHECKPOINTS.md` (do NOT
  silently reopen it during unrelated work). The Telegram work did NOT
  touch it.
- **The Telegram customer onboarding path is BUILT + offline-verified but
  NOT live-verified** (DECISIONS #67): `pnpm check:telegram` 96/96 +
  `pnpm check:telegram-onboarding` 22/22 prove the whole journey
  (EMPTY → launch → token-only deep link → the poll observing PROVISIONING
  → `/start` binding + the keyboard → the `managed_bot` completion → the
  poll observing CONNECTED → single-use replay refusal → the typed-failure
  retry loop) through the REAL service + REAL manager-webhook handler with
  in-memory fakes. **No real BotFather manager bot has ever been
  exercised** — the manager webhook secret is derived from
  `TELEGRAM_MANAGER_BOT_TOKEN`, so without a real token not even a local
  delivery authenticates. The ONE real live E2E is an operator action with
  the exact procedure + the "what must NOT happen" list in
  `docs/TELEGRAM.md`; the checkpoint sits at **LIVE E2E PENDING** in
  `docs/INTEGRATION_CHECKPOINTS.md`. Do NOT report a simulated success.

## 5. What is the current product/architecture direction?

WhatsApp Appointment Conversion System — "Book more, chase less."
Arabic-first, RTL-first, mobile-first, **vertical-agnostic during discovery**.
Local Vertical Discovery (Kafr El Sheikh, Egypt): one identical generic engine
across appointment-driven verticals; evidence picks the winner. WhatsApp-first
(Meta Cloud API); Telegram is the second channel — its identity/data
foundation, transport sibling, manager-bot provisioning state machine, and
customer onboarding surface are all BUILT + offline-verified (DECISIONS
#64 → #67); the ONE remaining step is the real live E2E. Architecture:
feature-based modular monolith on Next.js 16 + Prisma 7/Neon + Vercel only.
Invariants that must never regress: **availability authority returns only
genuinely selectable slots; server-authoritative booking; visible-but-disabled
unavailable candidate slots; no Busy/reason inference; no per-slot availability
requests; no second availability engine.**

## 6. What is the next logical phase?

1. **Operator:** review + release the uncommitted **#61** (shared
   conversation-layer UX) and **#62** (AI personality / operator-notification /
   conversation-UX) slices, then deploy (`pnpm deploy`) and probe
   `/api/health`. The #60 AI-failure acknowledgment fix already shipped in
   v0.29.4; the #61 diff is the deterministic greeting branch, one closed
   disclosure list, one enum value, and the re-generated prompt artifact; the
   #62 diff is the style module + one optional request field + the
   attention-reason surfacing + two small conversation-UX fixes (no migration
   in either).
2. **Fresh live WhatsApp E2E (operator, required):** send ONE real inbound
   message on an AI_ACTIVE thread with the policy still on
   `codecraft` / `deepseek-v4-flash-0731` and confirm the customer now
   receives the deterministic safe handoff acknowledgment (the probe proves
   the provider path is healthy, so a failure should now be rare — but any
   failure that does occur must no longer be silent).
3. **Production config (operator):** production state is unknown; verify
   `CODECRAFT_API_KEY` is set in the Vercel env (presence check only) and
   that the deployed version matches the released head, then probe
   `/api/health` to move production off the v0.19.0-era checkpoint; run
   `pnpm db:deploy` so migrations through `20260923120000_operator_attention`
   are applied.
4. **Onboard the first REAL pilot Business end-to-end** (operator provisions
   Business + invitation → ADMIN connects the WhatsApp number via Meta Embedded
   Signup at `/settings/whatsapp` → CONNECTED → live messaging), then gather
   baseline/ROI evidence per `PRODUCT_STRATEGY.md`.
5. **Only after pilot evidence:** Spec B instrumentation/economics.
