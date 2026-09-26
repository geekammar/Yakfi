# FlowPilot — Build State

> **THE authoritative implementation ledger** — the single answer to "what is
> the state of FlowPilot?". Read the `Current State` summary + `Next Step`
> only; everything else is reference. Keep updates MINIMAL: status, completed
> work, known issues, next step — never a diary. Per-prompt historical detail
> lives in Git history (`git log --oneline`, `git show <tag>`,
> `git show <tag>:docs/BUILD_STATE.md`) and `docs/DECISIONS.md`; condensed
> per-slice history is in `docs/archive/IMPLEMENTATION_HISTORY.md` (Tier 3).
> Reading policy: the context tiers in `docs/AGENT_RULES.md`.

**Product version: v0.29.4** — released and committed (`7559ead`, tag `v0.29.4`;
HEAD == `origin/main`). Releases v0.20.0–v0.29.4 ship the AI-trust boundary
(B-01–B-03), the owner-facing UX surfaces (knowledge/FAQ, services,
appointment creation, reschedule), appointments/availability coherence, Meta
Embedded Signup, the #58 disclosure-silence fix, the CodeCraft Discovery
provider, and the #60 AI-failure acknowledgment fix (v0.29.4). The worktree
now carries TWO uncommitted post-v0.29.4 slices: **the shared
conversation-layer UX (DECISIONS #61 — GREETING + verified handoff/resume)**
and **the AI personality / operator-notification / conversation-UX slice
(DECISIONS #62 — see below)**.

## Current State (summary)

**SPEC A — PILOT-READY AT THE PRESENTATION LAYER.** All screens + the
conversation engine are implemented and released. **Post-v0.29.1 audit
(evidence-backed, no code change):** the real LLM runtime answered a live
`BOOKING` turn (`atria / Atria-Dawn-Preview`, policy-resolved from the live
DB — `OPENROUTER_API_KEY`/`AGENTROUTER_API_KEY`/`ATRIA_API_KEY` are all
present in the local dev env); the Meta Embedded Signup configuration seam
resolves `ready: true` locally (all four names present); the RUNTIME
credential store round-trips exactly against the local dev DB with
`CREDENTIAL_MASTER_KEY` set; a real Meta round-trip has still never been
executed (see `docs/INTEGRATION_CHECKPOINTS.md`).

- **AI personality / operator notification / conversation UX (DECISIONS #62) — UNCOMMITTED in the worktree (on top of #61):**
  the smallest evidence-backed surface for the three concerns, with ZERO
  schema/migration/booking/availability/transport change.
  **(A) Personality** — NEW `src/features/conversations/server/assistant-style.ts`:
  the assistant's voice is ONE structured module of validated closed-enum values
  over the six candidate dimensions (language / arabicStyle / tone / detail /
  emoji / role) with a SINGLE resident default (Arabic, Egyptian-flavored MSA,
  friendly-professional, concise, no emoji, booking-assistant) — because
  DECISIONS #43/#48 forbid a prompt editor UI and lock prompt bodies to Git,
  and no pilot evidence yet picks a per-business voice. It reaches the assistant
  as REQUEST CONTEXT, never as a prompt body: `renderAssistantStyleDirective()`
  is embedded by the B-02 builder into the NEW optional `AiRequest.assistantStyle`
  field (parallel to `businessName`, "phrasing only") and rendered by
  `buildPromptMessages` into the shared user-context block. Provider- and
  channel-neutral by construction (the module imports no adapter and names no
  provider or channel), so a provider swap or a future Telegram channel needs
  NO style rewrite. **It can never override disclosure/safety/authority:** the
  disclosure gate never reads it (no import, no field in its input type — so the
  closed `KNOWLEDGE_FREE_REPLY_INTENTS` list cannot be widened by a style, proven
  behaviorally too), and the directive expressly forbids claiming to be human.
  The deterministic voice (`REPLIES`) is asserted to CONFORM to the style
  (Arabic-only, no emoji, concise, greeting self-identifies) rather than moved —
  determinism (#61) is untouched. **Persistence deliberately NOT added** (one
  nullable column + nested Zod object — a domain decision deferred to pilot
  evidence; NO migration, NO UI).
  **(B) Operator attention — audited correct; one genuine gap closed.** All 8
  required properties verified (single engine choke point; idempotent via the
  unique-conversationId `upsert`; duplicate inbound stopped by the durable
  dedupe ledger BEFORE any attention write; all 5 notification payloads safe;
  one-link operator reach; mobile usable; attention never color-only). The ONE
  gap: opening a flagged conversation did not show WHY (only the generic status
  badge; the alert was acknowledged server-side before render). FIXED:
  `getConversationDetail` reads the open attention `reason` BEFORE resolving it
  and returns it as `attentionReason`; the detail header renders a new
  `AttentionReasonChip` (icon + the existing operational Arabic
  `ATTENTION_REASON_LABELS` + a full accessible name) next to the status badge —
  present only on the first load of an unacknowledged handoff. NO second
  notification architecture: the typed `NotificationSink` stays a documented
  in-memory port; the live mechanism is still the ONE `operator_attentions` row.
  **(C) Conversation UX — audited.** The previously-observed identity issue is
  ALREADY SOLVED structurally: the detail screen is a fixed-height panel whose
  message log is the only scroll container, so the header (customer `<h1>` +
  `dir="ltr"` phone + status badge + reason chip + actions) stays pinned while a
  long thread scrolls — NO sticky UI was added (the prompt warned it could
  conflict with the mobile shell + safe-area). Two small gaps closed: the
  operator's primary actions were 32px → now `min-h-11` (44px) on mobile only
  (desktop compact height preserved via `md:` resets; no shared-primitive
  change), and the "جارٍ الإرسال…" indicator was not announced → now
  `role="status"`. Verified clean and unchanged: RTL (logical properties only),
  360px layout (`dvh`-sized panel fits the mobile shell), loading/empty/error
  states, keyboard access. **(D) Naturalness** — no code change; already
  delivered by #61 + the new directive; the assistant never fakes being human.
  **(E) Intent taxonomy** — unchanged: exactly the 8 documented intents;
  SMALL_TALK/THANKS/GOODBYE/CHITCHAT/CONFIRMATION stay documented future
  observations. **Channel impact:** the personality and the notification
  behavior are BOTH shared/reusable by a future Telegram (or any) channel.
  Guards: NEW `check:assistant-style` 27/27, NEW `check:conversation-ux` 18/18,
  `check:operator-attention` extended 15 → 20/20.

- **Shared conversation-layer UX — GREETING + verified handoff/resume (DECISIONS #61) — UNCOMMITTED in the worktree:**
  the ONE new intent `GREETING` is answered deterministically in the shared
  `classifyCustomerMessage` / `bypassDeterministicAi` seam, so a pure Arabic
  social opening («السلام عليكم» / «أهلاً» / «صباح الخير» / «ازيك») spends
  ZERO LLM calls and stays `AI_ACTIVE` (the engine consults the bypass BEFORE
  the assistant). It crosses the B-03 disclosure boundary by DECLARED INTENT
  only — `KNOWLEDGE_FREE_REPLY_INTENTS` is a closed single-member list, so a
  greeting needs no backing fact, and the gate still never inspects text.
  Purity is structural: any booking/availability/cancellation/reschedule/human/
  sensitive word, or a question mark, disqualifies the greeting reading, so a
  real intent is never swallowed («السلام عليكم، عايز أحجز موعد» → BOOKING).
  The handoff/resume half deliberately changed NOTHING functional: the explicit
  Resume AI control ALREADY EXISTED as `transitionConversation`'s `RETURN_TO_AI`
  transition (→ `AI_ACTIVE` + `assignedUserId: null` + attention resolved) wired
  to the operator UI button «إعادة للمساعد»; it was VERIFIED end-to-end and
  guarded against drift, not recreated. The human-ownership invariant STANDS: a
  message on a NEED_HUMAN thread is `DEFERRED_TO_STAFF` with zero provider calls
  until the operator explicitly resumes the AI. Preserved byte-for-byte:
  `aiResponseSchema` / `parseAiResponse`, the disclosure gate's fail-closed
  rules (the closed list cannot be widened by a provider), booking/availability
  authority, tenant isolation, idempotency, provider neutrality, and the
  AI/domain separation. Only the intent enum gained one value; the prompt
  artifact was re-generated (sha256 updated) so a live provider can also emit
  `GREETING`. NO migration. Guard: NEW `check:greeting` 57/57, NEW
  `check:conversation-handoff` 21/21, extended `check:ai-disclosure` 36/36.

- **AI-failure WhatsApp acknowledgment (DECISIONS #60) — SHIPPED in v0.29.4:**
  live forensics against the production Neon DB proved the real failure
  boundary after the CodeCraft policy switch. On thread `5b06bb77…` (Business
  «مركز أفنان», `Business.faqs` EMPTY), a real inbound produced an `AI_TURN`
  usage row `provider:"codecraft" model:"deepseek-v4-flash-0731"
status:"FAILURE"` (tokens null) ~2.5s after inbound — a FAST failure, not a
  16s timeout — followed by NO assistant message and NO `OUTBOUND_MESSAGE`;
  the thread stuck NEED_HUMAN so later messages were `DEFERRED_TO_STAFF`. The
  live probe simultaneously proved the provider HEALTHY: `pnpm
probe:codecraft` (3 runs) → `GET /v1/models` 200 with the exact model
  present (ctx=1048576, `json_mode`), 3/3 chat SUCCESS, `DIRECT_PARSE`,
  `parseAiResponse` conforming, max latency 7.9s < the 16000ms bound. **Root
  cause was therefore NOT CodeCraft** but the engine's AI-failure branch
  (`turn == null` / `parseAiResponse` rejects), which #58 had explicitly left
  as a silent `updateWorkflow(NEED_HUMAN)` + `delivery:null` handoff — the
  same silence #58 removed from the disclosure-refusal branch. **Fix:** on a
  failed/invalid AI turn the engine now emits the SAME deterministic safe
  handoff acknowledgment #58 uses (`classifyCustomerMessage`), persists +
  delivers it, and still escalates to NEED_HUMAN + operator attention.
  Preserved byte-for-byte: `parseAiResponse`/`aiResponseSchema`, the
  disclosure gate, Conversation Control retry/handoff semantics, the
  provider-neutral architecture (no provider branching), tenant isolation,
  idempotency, and the AI/domain separation — no AI-authored content is ever
  trusted on failure. No migration, no prompt change. Harness assertions that
  codified the old silent contract were updated to assert the fix
  (`check:ai-disclosure` 13a, `check:whatsapp-inbound` 10).

- **CodeCraft Discovery provider adapter (DECISIONS #59) — SHIPPED in v0.29.3:**
  CodeCraft API (`https://codecraftapi.com/v1`, OpenAI-compatible, Bearer)
  added as a completely isolated provider through the EXISTING boundary only —
  one thin adapter over the ONE shared `callOpenAiCompatible`, plus the 8-file
  registration (allowlist, union, factory branch, label/secretRef, EMPTY
  normalization policy, tests, probe, env docs). It replaces Atria for current
  AI experiments WITHOUT rewriting the AI architecture; Atria is NOT deleted
  and is NOT required for CodeCraft to function. ZERO schema/migration/prompt/
  booking/WhatsApp/engine change. The adapter owns only endpoint + secret
  reference + provider id + timeout. **Provider selection stays policy-backed:**
  the operator sets `codecraft` + a model in `platform_ai_policies` via
  `updateAiPolicy` (runtime; switching back is a policy change only). **Model
  discovery:** no model catalog is hard-coded; `GET /v1/models` is the source of
  truth (endpoint verified reachable — 401 unauthenticated), and the sanitized
  `pnpm probe:codecraft` records only safe metadata, never the key, with no DB
  write and no model-registry feature. Removal map verified: 8 files, nothing
  else touched (`docs/ai/PROVIDERS.md` §8). **NOT a permanent strategic
  provider choice** — provider quality/reliability remains an empirical
  Discovery question. **Operator actions before Discovery testing:**
  (1) put `CODECRAFT_API_KEY` in `.env.local` (server-side only, never DB/UI);
  (2) run `pnpm probe:codecraft` to discover the account's models and confirm
  JSON-mode + Arabic + `AiResponse` compatibility (live stages were NOT run in
  this session — no key was present in the environment);
  (3) set the policy's `primaryModel` to a model the probe proves available.
  forensically proven and fixed the exact runtime blocker that stopped a real
  inbound WhatsApp message from receiving any reply. A live customer message
  ("اهلا") on an AI_ACTIVE thread made the live `atria` model return a
  schema-valid self-authored `AMBIGUOUS` reply; the B-03 disclosure gate
  correctly refused it (this Business's `Business.faqs` store is empty), but
  #52's refusal path was a SILENT handoff — no reply persisted, no outbound
  Graph request, and the thread stuck in NEED_HUMAN so every later message
  was `DEFERRED_TO_STAFF` too. Booking turns kept working because their
  replies are domain-authored and never cross the gate (why earlier live
  BOOKING verification missed it). **Fix:** on refusal the engine now
  delivers the SAME deterministic safe handoff acknowledgment the
  deterministic assistant produces (`classifyCustomerMessage`), still
  escalating to NEED_HUMAN + operator attention; the gate itself, the
  dropped refused content, tenant isolation, idempotency, and the AI/domain
  separation are all unchanged. Real Graph send verified `delivered:true`.
  No migration. **Operator action before the next release:** none beyond the
  normal review + `pnpm release`/`pnpm ship` + deploy.

- **Slot presentation (DECISIONS #56) — SHIPPED in v0.29.1:** the slot
  step renders the known candidate time grid; a candidate the authority did NOT
  return is visibly muted + disabled + non-clickable + labelled «غير متاح»; no
  reason is ever inferred (never «مشغول»/Busy). One shared pure module
  (`src/lib/scheduling/slot-grid.ts`) that the authority DELEGATES to and the
  client imports — no second availability engine, exactly ONE availability
  request per step. Includes: customer-create prefill via the existing
  `deriveCustomerFormDefaults`; operator-attention a11y label
  («تحتاج انتباهك» — state never color-only); appointment date/time
  formatter consolidation onto the shared `date-format`/`slot-helpers`.
  ZERO schema/migration/prompt/provider/AI-boundary change.
- **Availability authority — UNCHANGED and binding:** `getAvailability` returns
  ONLY genuinely selectable slots; server-authoritative booking; no per-slot
  availability requests; no Busy/reason inference (DECISIONS #55/#56).
- **Verification state (as recorded by each slice, offline harnesses):**
  `check:appointments-day-view` 56/56, `check:booking-ux` 18/18,
  `check:reschedule` 66/66, `check:appointment-creation` 53/53,
  `check:booking-options` 32/32, `check:booking-confirm` 18/18,
  `check:conversation-booking` 16/16, `check:eligibility` 29/29,
  `check:services` 50/50, `check:knowledge-faq` 32/32,
  `check:knowledge-visibility` 36/36, `check:ai-context-builder` 39/39,
  `check:ai-disclosure` 36/36, `check:ai-prompts` 102/102,
  `check:conversation-control` 50/50, `check:conversation-handoff` 21/21,
  `check:conversation-ux` 18/18, `check:assistant-style` 27/27,
  `check:greeting` 57/57, `check:operator-attention` 20/20 (extended by #62
  with the duplicate-inbound / safe-payload / navigation / never-color-only /
  structural-choke-point guards),
  `check:policy` 13/13, `check:signup` 13/13, `check:whatsapp-transport` 27/27,
  `check:whatsapp-onboarding` 56/56, `check:meta-whatsapp` 17/17,
  `check:meta-embedded-signup` 27/27, `check:whatsapp-inbound` 13/13,
  `check:credentials-runtime` 36/36, `check:atria-retry` 17/17. The CodeCraft
  slice (DECISIONS #59, shipped v0.29.3) additionally records
  `check:ai-provider` 74/74 (11 CodeCraft checks incl. provider isolation) and
  `check:response-normalizer` 78/78. The #60 slice (shipped v0.29.4) re-records
  `check:ai-disclosure` (13a updated) and `check:whatsapp-inbound` 13/13
  (test 10 updated) to assert the new acknowledgment-on-failure contract. The
  #61 slice (uncommitted) extends `check:ai-disclosure` to 36/36 (GREETING
  discloses by declared intent; the closed list cannot be widened by a
  provider), re-probes two `check:whatsapp-inbound` tests that used a
  greeting as their engine probe (a greeting is now answered before the
  assistant runs, so the probe must be a non-greeting to still exercise the
  AI-success / AI-failure paths — 13/13), and adds the two NEW focused
  checks above.
  `pnpm verify` + `pnpm security` green at each release. Real-browser
  verification NOT performed (structurally asserted in the harnesses).

## Completed Major Work

Condensed ledger; full per-slice record in
`docs/archive/IMPLEMENTATION_HISTORY.md` (Tier 3).

| Area                                                                          | Highlights                                                                                                                                                             | Release / Decision  |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Foundation                                                                    | Next.js 16 + TS strict + Tailwind v4 + shadcn/ui, Better Auth, Prisma 7 / Neon, feature-based modular monolith, env fail-fast, PWA                                     | v0.1–v0.13          |
| Design system / RTL / PWA                                                     | Arabic-first RTL tokens, AppShell, status system, PNG PWA icons                                                                                                        | v0.2                |
| Database layer                                                                | Full Spec A domain model + Invitation, repositories (only Prisma consumers), Zod DTOs, Arabic demo seed                                                                | v0.5–v0.8           |
| Onboarding wizard                                                             | 4-step operational foundation, smart resume, step guards, `Business.vertical` discovery metadata                                                                       | v0.9                |
| Dashboard / Conversations / Appointments / Customers / Team / Staff workspace | All Spec A screens incl. NEED_HUMAN handoff queue, takeover, role-aware nav                                                                                            | through v0.19.x     |
| Smart availability + Smart Create 1–6                                         | Deterministic `getAvailability`; 6-step booking flow; candidate time grid per #56                                                                                      | v0.13–v0.29 / #56   |
| Architecture hardening (P0)                                                   | Branch model, WhatsAppConnection, Provider relations, `users.accountType`, SERIALIZABLE booking concurrency, durable inbound idempotency, AI contract, usage telemetry | v0.18 / #38         |
| Migration-chain repair                                                        | `0_init` root baseline + `migration_lock.toml`; empty DB bootstraps via `pnpm db:deploy`                                                                               | ARCH-03 / #40       |
| Platform control plane                                                        | Public signup closed (403 `SIGNUP_CLOSED`), Platform Operator guards, platform owner invitations, Platform AI policy singleton                                         | OPS-05 / #41        |
| Meta WhatsApp adapter                                                         | `GET`\|`POST /api/whatsapp/meta`, HMAC verify, Graph outbound, `phone_number_id` authoritative inbound key, tenant-scoped resolution                                   | CORE-03B / #42, #46 |
| Real LLM provider adapter                                                     | Policy-backed `ConversationAi` (OpenRouter primary / AgentRouter secondary / fallback); secrets via `secretRef` only                                                   | AI-02 / #44         |
| Prompt Workspace                                                              | `/prompts/**/*.prompt` → `generate:ai-prompts` → committed generated artifact → `prompt-registry.ts`; no inline bodies, no silent fallback                             | v0.19.1 / #48       |
| Meta Embedded Signup + runtime credentials                                    | OAuth redirect + code exchange, single-use `stateRef` ledger, AES-256-GCM `runtime_credentials` (env grammar unchanged); `CREDENTIAL_MASTER_KEY` optional              | v0.20.0 / #49       |
| AI knowledge visibility + context builder + disclosure gate                   | Four-level policy (PUBLIC/CONDITIONAL/INTERNAL/FORBIDDEN); "AI may know" ≠ "AI may mention"; structural reply gate                                                     | v0.22.0 / #50–#52   |
| Human Handoff + Operator Attention                                            | Attention signal derived server-side; visually-hidden label; staff/inbox surfacing                                                                                     | v0.23.0             |
| Knowledge/FAQ authoring UX                                                    | Suggested-FAQ authoring over the ONE `Business.faqs` store; confirmed removal                                                                                          | v0.24.0             |
| Service Catalog + Authoring                                                   | Catalog is domain data (not a 2nd KB); soft-delete + duplicate-name guard; `durationMinutes` is INTERNAL                                                               | v0.25.0 / #53       |
| Appointment Creation UX                                                       | `?customerId=`/`?serviceId=` smart context, relative dates, «أقرب وقت متاح», relative follow-up                                                                        | v0.26.0 / #54       |
| Booking UX + customer prefill                                                 | Date-step coherence; customer-create prefill from the typed query                                                                                                      | v0.27.0             |
| Reschedule UX                                                                 | Availability-guided reschedule with self-exclusion (`excludeAppointmentId`)                                                                                            | v0.28.0             |
| Appointments/Availability coherence                                           | Day-view state reset per selected day; day-capacity chips (مغلق/ممتلئ/غير متاح); date-format consolidation                                                             | v0.29.0 / #55       |
| Slot presentation                                                             | Known candidate grid; non-returned candidates visible-but-disabled «غير متاح»; no reason inference                                                                     | v0.29.1 / #56       |

## Key Known Limitations (current)

- Availability is a READ layer: no slot reservation; the write-time SERIALIZABLE
  conflict check is the authority. Residual: a rare false-positive
  serialization abort under contention surfaces as `SLOT_CONFLICT` — a manual
  retry succeeds.
- Unassigned appointments block the whole business day
  (staff-assignment-aware availability is a later decision).
- The AI assistant's deterministic path avoids LLM calls when safely possible;
  Arabic greetings are now covered by it (DECISIONS #61); phrasings outside the
  keyword/FAQ vocabulary still land on NEED_HUMAN.
- The Branch/ProviderProfile/usage foundations have partial management UI only
  (`/settings/whatsapp` covers WhatsAppConnection); usage telemetry is recorded
  but not surfaced; `estimatedCostMicros` is never computed by the codebase.
- No per-entry id / active state / timestamps for `Business.faqs` JSON rows
  (DECISIONS #13 shape); guards are workflow-level.
- Customer creation collects no email; edit/deletion not exposed in the UI.
  Directory reads cap at 20 customers/page (pilot scale).
- Appointments accept past dates at the domain level (`min=today` is a UX guard
  only). Knowledge/FAQ cap is 50 entries.
- The `20260913150000_account_issuer` migration was hand-authored (no shadow
  DB on the build device); verified by deploy + schema diff + live sign-in.
- Termux device: builds use `--webpack`; the Prisma schema engine cannot run
  on-device (migrate from desktop/CI).

## Architecture Hardening (P0 — IMPLEMENTED)

Accepted as DECISIONS #30–#36 (PROMPT-ARCH-01) and implemented in
PROMPT-ARCH-02 (DECISIONS #38): Branch model (`Business.defaultBranchId`
pointer; required `branchId` server-resolved to the Default Branch),
WhatsAppConnection (businessId required / branchId optional),
ProviderProfile/ProviderService/ProviderBranch relations, platform-operator
marker, SERIALIZABLE booking concurrency with bounded retry, durable
`inbound_message_dedupe` idempotency, structured `ai-contract.ts`, append-only
`usage_records`. Details: `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`.

## Migration State

Chain is **complete and clean**, rooted at `0_init` + `migration_lock.toml`
(provider postgresql). **13 migrations**, ending at
`20260923120000_operator_attention`. A genuinely EMPTY database bootstraps
fully via `pnpm db:deploy` (verified 8/8 at repair time; deploy count grows
with each additive migration — re-run to reconcile). The old Demo/Neon DB
needed a one-time HUMAN-ONLY baseline reconciliation
(`prisma migrate resolve --applied 0_init` → `pnpm db:deploy`). Schema diff
against `schema.prisma` is empty. Full list: `docs/DATABASE.md`.

## Ops State

- **Production:** `https://flowpilot-prod.vercel.app` — Neon production DB
  (`ep-tiny-grass-a5e63jev-pooler` pooler), dedicated Vercel project
  `flowpilot-prod`, 9 Production env vars (5 `WHATSAPP_META_*` Secret + 4
  core), repository PRIVATE. **Last live-verified checkpoint: v0.19.0**
  (2026-09-19, `GET /api/health` `deploymentReady:true`,
  `database:connected`, `missingEnvVars:[]`). Live inbound E2E was proven at
  the earlier v0.15.9 checkpoint (signed webhook → 200, dedupe replay,
  tenant isolation). **Deploys of v0.20.0–v0.29.1 are operator actions not
  performed yet — production version must be treated as unknown until probed.**
- **Demo:** `https://flowpilot-demo-gamma.vercel.app` — isolated Demo Neon DB,
  dedicated project, `DEMO_MODE=true`, seeded deterministic/idempotent (1
  business, 1 Default Branch, 2 team users, 6 services, 36 customers, 22
  conversations, 73 messages, 37 appointments). Demo credentials exist ONLY in
  the Demo DB. The suggested `flowpilot-demo.vercel.app` domain is owned by an
  unrelated third party — the live domain is the `-gamma` one.
- **Release model:** `pnpm release` (full gated path) or the lightweight
  `pnpm ship patch|minor` (DECISIONS #26) — never both. Both are
  **operator-only** actions; agents never commit/tag/push/ship.
- **Bootstrap tools (one-time, operator):** `pnpm bootstrap:admin`,
  `pnpm bootstrap:operator`.

## Unresolved User Actions (not code)

1. **Operator:** review the uncommitted **#61** shared conversation-layer UX
   slice (GREETING intent + verified handoff/resume — the only functional
   changes are the deterministic greeting branch in `conversation-ai.ts`, the
   closed `KNOWLEDGE_FREE_REPLY_INTENTS` list in the disclosure gate, one enum
   value, and the re-generated prompt artifact), then release it as the next
   patch (`pnpm release`/`pnpm ship`) and deploy (see below). The #60
   AI-failure acknowledgment fix already shipped as v0.29.4.
2. **Operator:** deploy the released head to production (`pnpm deploy`) and
   probe `/api/health` to confirm the production version; run `pnpm db:deploy`
   so migrations through `20260923120000_operator_attention` are applied.
3. **Operator (only if RUNTIME credentials are used):** generate and set
   `CREDENTIAL_MASTER_KEY` in the deployment env. Until set, the RUNTIME
   credential path stays honestly UNAVAILABLE and the ENV pilot path is
   unaffected. (Live evidence, post-v0.29.1: against the local dev DB the
   RUNTIME store round-trips exactly with `CREDENTIAL_MASTER_KEY` set —
   store/resolve/delete all succeed. A real Meta round-trip still has
   never run — see `docs/INTEGRATION_CHECKPOINTS.md`.)
4. **Operator (optional):** add `OPENROUTER_API_KEY` / `AGENTROUTER_API_KEY` /
   `ATRIA_API_KEY` to Vercel env; `pnpm db:deploy` against the Demo DB.
5. **Operator (optional):** exercise one real outbound to an operator-owned
   WhatsApp number inside the 24h window to observe a `200` delivery.

## Next Step

1. **Release + deploy the current head** (operator): the worktree carries the
   shared conversation-layer UX slice (DECISIONS #61; verified: focused checks
   green — `check:greeting` 57/57, `check:conversation-handoff` 21/21,
   `check:ai-disclosure` 36/36) AND the personality / operator-notification /
   conversation-UX slice (DECISIONS #62; verified: `check:assistant-style`
   27/27, `check:conversation-ux` 18/18, `check:operator-attention` 20/20 —
   `pnpm verify` passes, no migration in either). Review the #61 + #62 diffs,
   then run `pnpm release`/`pnpm ship` to land the next version and
   `pnpm deploy` + `pnpm db:deploy` against production, then probe
   `/api/health`. The #60 AI-failure acknowledgment fix already shipped in
   v0.29.4.
2. **Fresh live WhatsApp E2E** (operator, REQUIRED): send one real inbound
   message on an AI_ACTIVE thread with the policy still on `codecraft` /
   `deepseek-v4-flash-0731` and confirm the customer receives a reply even if
   the provider fails. The live probe proved the CodeCraft path healthy
   (3/3, `DIRECT_PARSE`, max 7.9s), so the prior `AI_TURN` FAILURE is
   non-deterministic — but any failure must no longer produce silence.
3. **Onboard the first REAL pilot Business end-to-end** — operator provisions
   the Business + invitation → ADMIN connects the WhatsApp number via Meta
   Embedded Signup at `/settings/whatsapp` → CONNECTED → live messaging →
   gather baseline/ROI evidence per `PRODUCT_STRATEGY.md`.
4. **Only after pilot evidence justifies it:** Spec B instrumentation /
   economics (usage → cost → price → entitlement; `ECONOMICS.md`). Not before
   pilot evidence exists.

After each prompt: update this file (minimally) and append to `DECISIONS.md`
when a decision was made.
