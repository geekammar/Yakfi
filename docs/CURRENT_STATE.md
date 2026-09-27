# FlowPilot — Current State

> **Tier 0 cold-start snapshot** — read with `docs/AGENT_RULES.md`. This is a
> 30-second orientation, NOT a source of truth: canonical documents and the
> repository itself always override it. Implementation detail lives in
> `docs/BUILD_STATE.md`; decisions in `docs/DECISIONS.md` (routed by
> `docs/DECISIONS_INDEX.md`); the reading policy is in `docs/AGENT_RULES.md`.

**Version: v0.31.0** — released and committed (`b70caac`, tag `v0.31.0`;
HEAD == `origin/main`; tags through `v0.31.0`). v0.31.0 carries the whole
Telegram second channel committed (DECISIONS #63 → #67), and the **first
REAL live Telegram verification pass** (DECISIONS #68) ran against that
deployment: it LIVE-VERIFIED the real Manager Bot (`getMe` 200 →
`@FlowPilotManagerBot`, id `8603565570`, **`can_manage_bots: true`**) and
LIVE-PROVED one genuine blocking defect no offline harness could see — the
route proxy session-gated both Telegram webhook endpoints, so every real
delivery answered **307 → `/sign-in`** and never reached a handler. FIXED
in place + guarded (NEW `check:telegram` section P + `check:signup`) +
proven locally (401 instead of 307, no auth regression), **but NOT yet
deployed**, so the Telegram checkpoint stays at **LIVE E2E PENDING** with
four exact operator actions: deploy → `pnpm db:deploy` (both Telegram
migrations are UNAPPLIED — live-confirmed by `prisma migrate status` + a
`P2021 The table public.telegram_connections does not exist` error) → set
the public `TELEGRAM_MANAGER_BOT_USERNAME` in production (presently
**ABSENT**; the token + `CREDENTIAL_MASTER_KEY` ARE present) → perform the
human steps inside Telegram. The #58 WhatsApp E2E
disclosure-silence fix shipped in v0.29.2; the CodeCraft Discovery provider
adapter (DECISIONS #59) shipped in v0.29.3; the #60 AI-failure
acknowledgment fix shipped in v0.29.4; the #61 shared conversation-layer UX
and the #62 AI personality / operator-notification / conversation-UX slices
shipped in v0.30.0. The post-v0.30.0 **Telegram second channel** is
COMPLETE and committed: the discovery pass (DECISIONS #63) mapped the exact
seams, the identity/data foundation is BUILT (DECISIONS #64), the thin
Telegram adapter + `POST /api/telegram/webhook` + the Conversation-Engine
bridge are BUILT (DECISIONS #65), the managed-bot provisioning state
machine is BUILT (DECISIONS #66 — three security defects the focused
harness surfaced were fixed in place), and the customer-facing
`/settings/telegram` surface is BUILT + behaviorally WIRED +
offline-verified (DECISIONS #67) — Telegram is only a transport
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
- **Production deployment state IS now live-verified at v0.31.0** (DECISIONS
  #68, 2026-09-27): `GET /api/health` → `version:"0.31.0"`,
  `deploymentReady:true`, `database:"connected"`, `missingEnvVars:[]` at
  `https://flowpilot-prod.vercel.app`. This supersedes the v0.19.0-era
  checkpoint that had stood since 2026-09-19. **Production env PRESENCE
  verified without reading any value:** `TELEGRAM_MANAGER_BOT_TOKEN` ✓,
  `CREDENTIAL_MASTER_KEY` ✓, `NEXT_PUBLIC_APP_URL` ✓, `CODECRAFT_API_KEY` ✓
  — but **`TELEGRAM_MANAGER_BOT_USERNAME` ABSENT**, which blocks the
  Telegram deep link. **Production is NOT yet re-deployed with the #68
  public-path fix**, so both Telegram webhook endpoints still answer 307 to
  real Telegram deliveries. (The live-forensics DB IS the production Neon
  DB, so the failing CodeCraft `AI_TURN` row and the stuck thread are REAL
  production evidence — the deployed build must be at least v0.29.3, since
  the row records `provider:"codecraft"`, which only that release emits.)
- The Meta Embedded Signup code path is implemented and offline-harnessed
  (`check:meta-embedded-signup`) but has never been exercised against a real
  operator-owned Meta App Dashboard configuration. It is on a documented
  **DEFERRED / HOLD** — see `docs/INTEGRATION_CHECKPOINTS.md` (do NOT
  silently reopen it during unrelated work). The Telegram work did NOT
  touch it.
- **The Telegram customer onboarding path is BUILT + offline-verified but
  NOT live-verified** (DECISIONS #67/#68): `pnpm check:telegram` **99/99**
  (NEW section P — the live-found route-proxy reachability guard) +
  `pnpm check:telegram-onboarding` 22/22 prove the whole journey
  (EMPTY → launch → token-only deep link → the poll observing PROVISIONING
  → `/start` binding + the keyboard → the `managed_bot` completion → the
  poll observing CONNECTED → single-use replay refusal → the typed-failure
  retry loop) through the REAL service + REAL manager-webhook handler with
  in-memory fakes. **The real Manager Bot IS now LIVE-VERIFIED** (a REAL
  `getMe`: `@FlowPilotManagerBot`, id `8603565570`, `can_manage_bots: true`
  — do NOT recreate or replace it), but **no real managed bot has ever been
  created, no `setWebhook`/`getMe` has run for a managed bot, no connection
  has reached CONNECTED, and no customer message has been received or
  answered.** Four operator actions stand open (deploy the #68 fix →
  `pnpm db:deploy` — both Telegram migrations are UNAPPLIED, live-confirmed
  by `prisma migrate status` + a `P2021 … telegram_connections does not
exist` error → set `TELEGRAM_MANAGER_BOT_USERNAME` in production →
  perform the human steps inside Telegram). The exact procedure + the
  "what must NOT happen" list are in `docs/TELEGRAM.md → The ONE live E2E`
  - §6.1; the checkpoint sits at **LIVE E2E PENDING** in
    `docs/INTEGRATION_CHECKPOINTS.md`. Do NOT report a simulated success.

## 5. What is the current product/architecture direction?

WhatsApp Appointment Conversion System — "Book more, chase less."
Arabic-first, RTL-first, mobile-first, **vertical-agnostic during discovery**.
Local Vertical Discovery (Kafr El Sheikh, Egypt): one identical generic engine
across appointment-driven verticals; evidence picks the winner. WhatsApp-first
(Meta Cloud API); Telegram is the second channel — its identity/data
foundation, transport sibling, manager-bot provisioning state machine, and
customer onboarding surface are all BUILT + offline-verified + COMMITTED in
v0.31.0 (DECISIONS #64 → #67), and the first real live pass (DECISIONS
#68) live-verified the Manager Bot and fixed the one live-proved delivery
defect; the remaining step is the real live E2E once the four operator
actions run. Architecture:
feature-based modular monolith on Next.js 16 + Prisma 7/Neon + Vercel only.
Invariants that must never regress: **availability authority returns only
genuinely selectable slots; server-authoritative booking; visible-but-disabled
unavailable candidate slots; no Busy/reason inference; no per-slot availability
requests; no second availability engine.**

## 6. What is the next logical phase?

1. **Operator — unblock the ONE Telegram live E2E (DECISIONS #68):** four
   actions, none of them code — (a) deploy the current head so the
   public-path fix is live (production still 307s both Telegram webhooks);
   (b) `pnpm db:deploy` (both Telegram migrations UNAPPLIED — live-confirmed);
   (c) set `TELEGRAM_MANAGER_BOT_USERNAME` in production (presently ABSENT —
   the live `getMe` already reported `FlowPilotManagerBot`); (d) run
   `docs/TELEGRAM.md → The ONE live E2E` (the human steps inside Telegram).
   Then record the outcome in `BUILD_STATE.md` + a `DECISIONS.md` entry if a
   defect surfaces.
2. **Fresh live WhatsApp E2E (operator, required):** send ONE real inbound
   message on an AI_ACTIVE thread with the policy still on
   `codecraft` / `deepseek-v4-flash-0731` and confirm the customer now
   receives the deterministic safe handoff acknowledgment (the probe proves
   the provider path is healthy, so a failure should now be rare — but any
   failure that does occur must no longer be silent).
3. **Production config (operator):** production IS live-verified at v0.31.0
   (DECISIONS #68); `CODECRAFT_API_KEY` is present (presence check only).
   Run `pnpm db:deploy` so the chain — including both Telegram migrations —
   is applied.
4. **Onboard the first REAL pilot Business end-to-end** (operator provisions

Business + invitation → ADMIN connects the WhatsApp number via Meta Embedded
Signup at `/settings/whatsapp` → CONNECTED → live messaging), then gather
baseline/ROI evidence per `PRODUCT_STRATEGY.md`. 5. **Only after pilot evidence:** Spec B instrumentation/economics.
