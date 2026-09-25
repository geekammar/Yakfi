# FlowPilot — Implementation History (TIER 3 — HISTORICAL ARCHIVE)

> ⛔ **SUPERSEDED — HISTORICAL / FORENSIC REFERENCE ONLY.**
> This file is **TIER 3** in the context model (`docs/AGENT_RULES.md`): it is
> NEVER read by default, never loaded at cold start, and must NEVER be treated
> as current implementation truth. It preserves the condensed per-slice
> implementation + verification record of completed work so historical
> reasoning, migration names, and verification evidence are not lost. The
> **current** state lives in `docs/CURRENT_STATE.md` + `docs/BUILD_STATE.md`;
> durable decisions in `docs/DECISIONS.md`.
> The **complete verbatim** per-prompt narrative is in Git history —
> `git show <tag>:docs/BUILD_STATE.md` (e.g. `git show v0.29.0:docs/BUILD_STATE.md`)
> — and in the release commits `git log --oneline`.

## Why this archive exists

Successive prompts accumulated running implementation narration inside
`BUILD_STATE.md` / `CURRENT_STATE.md` (per-slice prose, check-count lists,
production probe logs). That material is valuable forensics but poisoned the
cold-start cost: a 30-second snapshot grew to 500+ lines. The normalization
pass (DECISIONS #57) moved it here. Nothing was deleted — the full text is
recoverable from Git history at the tags below.

## Release → slice map (authoritative, from `git tag` + release commits)

| Release | Commit | Slice | Decision |
| --- | --- | --- | --- |
| v0.19.0 | `123dfaa`→`56205a0` area | Business WhatsApp onboarding surface (`/settings/whatsapp`) | #47 |
| v0.19.1 | `04856ae` | Prompt Workspace finalize (prompt bodies → `/prompts/**/*.prompt`) | #48 |
| v0.20.0 | `1761098` | Meta Embedded Signup + runtime credential store (`runtime_credentials`, AES-256-GCM) | #49 |
| v0.21.0 | `9e93b5a` | WhatsApp onboarding UX reconciliation (connection screen) | #47 |
| v0.22.0 | `8b8a983` | AI knowledge-visibility + context builder + disclosure gate | #50–#52 |
| v0.23.0 | `002b2b8` | Human handoff + operator attention (migration `20260923120000_operator_attention`) | — |
| v0.24.0 | `0e10b49` | Knowledge/FAQ authoring UX (suggested FAQs) | — |
| v0.25.0 | `105d6f5` | Service Catalog + Service Authoring (removal + duplicate-name guard) | #53 |
| v0.26.0 | `069279f` | Appointment Creation + Scheduling UX (smart context, relative dates, follow-up) | #54 |
| v0.27.0 | `61b30b4` | Booking UX + customer-create prefill | — |
| v0.28.0 | `4e65c6a` | Reschedule UX (availability-guided reschedule + self-exclusion) | — |
| v0.29.0 | `b34e61a` | Appointments + Availability UX Coherence (day-view reset, day-capacity chips) | #55 |
| (uncommitted) | worktree | Spec A slot presentation (visible-but-disabled candidates) | #56 |

## Condensed per-slice record (historical evidence)

### PROMPT-B01 — AI Knowledge Visibility Policy (v0.22.0 / DECISIONS #50)
Policy-only. Four levels `PUBLIC` / `CONDITIONAL` / `INTERNAL` / `FORBIDDEN`
controlling what is ELIGIBLE to enter AI context and — separately — what the
AI may mention. Source+tenant provenance, structural safe defaults
(`enrollFact`), enumerated FORBIDDEN categories (not string redaction).
`src/lib/ai-knowledge-visibility/`. `check:knowledge-visibility` 36/36
(offline, in-memory). Zero schema/migration/prompt/provider change.

### PROMPT-B02 — AI Context Builder (v0.22.0 / DECISIONS #51)
`src/features/conversations/server/ai-context-builder/` runs the B-01 pipeline
over the engine's already-loaded facts (`classify*` → `enrollFact` →
`isWithinTenantScope` → budget + task gate → `isEligibleForAiContext` /
`isDisclosable`), composes the minimal `AiRequest`, drops provenance, and emits
the DISCLOSURE LEDGER. `serviceFactSchema.durationMinutes` became OPTIONAL
(the only contract change, backwards compatible). `check:ai-context-builder`
39/39. Replaces the engine's inline `buildAiContext`.

### PROMPT-B03 — Customer Disclosure Boundary (v0.22.0 / DECISIONS #52)
`src/features/conversations/server/ai-disclosure/` — the gate a validated
`AiResponse` crosses on the generic reply path, immediately before persistence
+ send. Structural (action + intent + ledger verdicts), never textual: no
blacklist, no redaction, no LLM judge. A refused reply is dropped wholesale and
the turn takes the same `NEED_HUMAN` / `AI_HANDOFF` path an invalid AI result
takes. `check:ai-disclosure` 32/32. Deliberate deferrals (still current):
`cancellationPolicy` / `whatsappNumber` request channels + human-notification
UX.

### PROMPT-B06 — Service Catalog + Authoring (v0.25.0 / DECISIONS #53)
The catalog is canonical BUSINESS/DOMAIN data, NOT a second Knowledge Base.
`durationMinutes` is an operational scheduling fact (`INTERNAL`) — not a
customer disclosure merely because it exists. Wired the previously-uncalled
`softDelete` (forced by `Appointment.service` `onDelete: Restrict`) via
`ServiceRemoveDialog`; duplicate-name guard (check-then-create, DECISIONS #23
convention) protects the deterministic `matchServiceByName`. No schema
migration. `check:services` 50/50.

### PROMPT-B07 — Appointment Creation + Scheduling UX (v0.26.0 / DECISIONS #54)
Reused the 6-step Smart Create flow + PROMPT-10 availability layer + canonical
`createAppointmentRecord` write path as the spine. Four gaps closed by
composition: (1) Smart Context `?customerId=`/`?serviceId=` via
`resolveBookingContext` + `deriveInitialBookingScreen`; (2) Relative
Scheduling via pure `resolveRelativeDate` (اليوم/غداً/هذا الأسبوع/…); (3)
«أقرب وقت متاح» one-tap earliest-slot booking; (4) relative follow-up
re-verified through the same `getAvailabilityAction` + `createAppointment`.
`check:appointment-creation` 53/53. Zero schema/migration.

### PROMPT-B09 — Appointments + Availability UX Coherence (v0.29.0 / DECISIONS #55)
(1) ROOT CAUSE — the day view showed the wrong day: `AppointmentAgenda`
mirrored the server list into `useState` and client-side day navigation
re-rendered with fresh searchParams WITHOUT resetting state, so the header
showed the NEW day while the list/count/filter/empty state described the
PREVIOUS day. Fixed at the correct layer — the route keys the agenda by its
`date` so the whole subtree resets per day. The query layer was never at fault.
(2) Day-capacity visibility: the date step consults the ONE authority per
rendered day (`useQueries` over `getAvailabilityAction`) and the NEW pure
`day-capacity.ts` derives «مغلق»/«ممتلئ»/«غير متاح» chips; unavailable days
muted + labelled + inert (`aria-disabled`). (3) Date-format consolidation onto
shared `date-format`/`slot-helpers`; header shows the count for every day.
(4) Reschedule self-exclusion carried into day capacity. `date-format.ts` stays
availability-FREE. `check:appointments-day-view` 43/43 at release (later
extended to 56/56 by #56).

### SPEC-A-FINAL-SLOT-PRESENTATION — Slot Presentation (uncommitted / DECISIONS #56)
Closes the one gap #55 left open: the slot step renders the KNOWN candidate
time grid and derives only a presentational state — a candidate present in the
authority result is selectable; a non-returned candidate is visibly muted +
disabled + non-clickable + labelled «غير متاح». **No reason is ever inferred
from absence — never «مشغول»/Busy.** The authority contract is UNCHANGED (it
still returns only genuinely selectable slots). One pure shared module
`src/lib/scheduling/slot-grid.ts`; the authority DELEGATES to it; exactly ONE
availability request per step; grid inputs travel from the already-loaded
Business row (zero new queries). Also: customer-create prefill via
`deriveCustomerFormDefaults`; operator-attention visually-hidden
«تحتاج انتباهك» label; appointment-detail formatter consolidation.
`check:appointments-day-view` 56/56 (13 NEW slot-presentation assertions).
Zero schema/migration/prompt/provider/AI-boundary change. Production NOT
touched; real-browser verification NOT performed.

### WHATSAPP-ONBOARDING-01 + credential store (v0.20.0 / DECISIONS #49)
The onboarding LIFECYCLE (provider-neutral `ConnectionAuthorizer` port,
server-persisted authorization ledger keyed by single-use opaque `stateRef`,
callback Business resolved ONLY from the state, replay/cross-tenant safe) +
the RUNTIME credential backend for the `fp:<id>` grammar: existing Neon
Postgres + APPLICATION-SIDE AES-256-GCM (`runtime_credentials` migration
`20260920140745_runtime_credentials`), opaque `credentialsRef` only, optional
server-only `CREDENTIAL_MASTER_KEY` (unset ⇒ store UNAVAILABLE, fail closed).
The wired adapter is a DETERMINISTIC stand-in; the real Meta HTTP path is
gated on operator-owned Meta App Dashboard configuration. `check:credentials-runtime`
36/36; `check:meta-embedded-signup` 27/27.

### PROMPT-OPS-AI-PROMPT-WORKSPACE (v0.19.1 / DECISIONS #48)
LLM prompt bodies became source-controlled artifacts: `/prompts/**/*.prompt`
→ `pnpm generate:ai-prompts` (deterministic build-time compiler) → committed
`src/generated/ai-prompts.generated.ts` → `prompt-registry.ts` (`getPromptBody`)
→ runtime. No inline bodies, no runtime filesystem read, no silent fallback.
Semantic preservation PROVEN: the two relocated bodies byte-identical to the
removed inline constants (1065 + 396 chars). Deterministic classifier rules
stayed code-owned. `check:ai-prompts` 101/101.

### PROMPT-OPS-06 — Meta production enablement + live E2E (historical checkpoint)
Production was reconciled and live E2E verified at the **v0.15.9 checkpoint**
(2026-09-15): `GET /api/health` 0.15.9 `deploymentReady:true` /
`database:connected`; `vercel env ls` 9 vars (5 `WHATSAPP_META_*` Secret + 4
core); webhook `GET` invalid→403 / valid→200 challenge; signed `POST`
`wamid.test-*` → `200 {"received":1}` → Customer + Conversation `NEED_HUMAN` +
2 messages + 1 dedupe; replay → `duplicate:true`; tenant isolation
(`INVALID_CONNECTION`); outbound Graph `400 code 133010` → `PERMANENT`
(non-retryable, expected for a test number — 0 billable sends). **CORRECTED
2026-09-16:** that E2E used a hand-crafted signed payload; a real Meta webhook
was never delivered at that checkpoint. These numbers are HISTORICAL —
production has since moved past v0.19.0 and its current version is unprobed.

## How to use this file

- Only retrieve it when historical context, forensics, migration reasoning, or
  comparison is explicitly needed (Tier 3).
- Prefer Git history for verbatim detail: `git show <tag>:docs/BUILD_STATE.md`.
- Never copy content from here into a current-state document.
