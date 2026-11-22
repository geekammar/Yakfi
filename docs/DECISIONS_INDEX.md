# FlowPilot — Decisions Index

> **Tier 0 router for `docs/DECISIONS.md`.** Read this instead of the full
> append-only ledger. Each row gives the decision ID, its short meaning, when
> to load the full entry, and a direct reference. Reference `#NN` means entry
> `#NN` in the linked ledger; search that ID there. Load an entry only when
> your task touches that decision, a conflict needs exact wording, or a
> reversal is being considered. Never read the whole ledger by default.

**Authority order:** latest `DECISIONS.md` entry → `BUILD_STATE.md` → canonical
topic docs → derived summaries. Repository code is implementation truth. If a
conflict is unclear, escalate instead of guessing (`docs/AGENT_RULES.md` §6).

## Current decisions

<!-- prettier-ignore -->
| ID | Short meaning | Load when… | Ref |
| --- | --- | --- | --- |
| 01 | Appointments use the Agenda View, never calendar grids | appointment display | [#01](DECISIONS.md) |
| 02 | Only ADMIN and STAFF business roles; no granular permissions | roles/permissions | [#02](DECISIONS.md) |
| 03 | Human-in-the-loop is mandatory (`NEED_HUMAN`) | AI/staff handoff | [#03](DECISIONS.md) |
| 04 | Next.js 16.x; async request APIs, `proxy.ts`, error boundaries | routing/middleware | [#04](DECISIONS.md) |
| 05 | Prisma 7 driver adapter; generated client in `src/generated/prisma` | DB tooling | [#05](DECISIONS.md) |
| 06 | Feature-based modular monolith; repository layer only Prisma consumer | structure/DB access | [#06](DECISIONS.md) |
| 07 | Arabic-first, RTL-by-default (`dir="rtl" lang="ar"`, logical CSS) | UI/layout | [#07](DECISIONS.md) |
| 08 | One `AppShell`: desktop right sidebar, mobile bottom nav | navigation | [#08](DECISIONS.md) |
| 09 | Premium-calm design; no neon/gradients/AI gimmicks | visual design | [#09](DECISIONS.md) |
| 10 | Single Postgres; tenancy via `businessId` | tenancy | [#10](DECISIONS.md) |
| 11 | Soft deletes (`deletedAt`); Message immutable | deletion model | [#11](DECISIONS.md) |
| 12 | Features depend on repositories + Zod DTOs only | feature boundary | [#12](DECISIONS.md) |
| 13 | Onboarding progress on Business; FAQs as JSON | onboarding/knowledge storage | [#13](DECISIONS.md) |
| 14 | Seed provisions demo-only credential accounts | seed | [#14](DECISIONS.md) |
| 15 | PWA icons are generated PNGs (`pnpm icons`) | manifest/icons | [#15](DECISIONS.md) |
| 16 | Cross-platform run system (`pnpm run setup/doctor/verify`) | dev tooling | [#16](DECISIONS.md) |
| 17 | Repo-managed git hooks; `security-check.mjs` pre-commit | commit safety | [#17](DECISIONS.md) |
| 18 | Release model: `pnpm release`, `vX.Y.Z` tags | cutting a release | [#18](DECISIONS.md) |
| 19 | Vercel readiness (`/api/health`, `vercel.json`) | deploy config | [#19](DECISIONS.md) |
| 20 | Demo dataset v2 (Egyptian, dental-data-only, vertical-agnostic copy) | demo data | [#20](DECISIONS.md) |
| 21 | Pilot distribution (`pnpm deploy` + pre-deploy gate) | deploy tooling | [#21](DECISIONS.md) |
| 22 | ONE Better Auth; PLATFORM vs BUSINESS scopes; invitation-first | auth/identity | [#22](DECISIONS.md) |
| 23 | Invitations: hash-only tokens, 7-day expiry, check-then-create | invitations | [#23](DECISIONS.md) |
| 24 | ADMIN activation consistency; one-time `activatedAt` | activation | [#24](DECISIONS.md) |
| 25 | Activation → `/sign-in?redirect=/onboarding`; public invite route | activation routes | [#25](DECISIONS.md) |
| 26 | Two release paths: `pnpm release` + `pnpm ship` | shipping | [#26](DECISIONS.md) |
| 27 | Team management; role-generic invited-account activation | team/staff activation | [#27](DECISIONS.md) |
| 28 | Staff workspace; ownership changes are explicit-action-only | assignment/takeover | [#28](DECISIONS.md) |
| 29 | Conversation engine: provider-neutral inbound/AI/transport seams | engine boundary | [#29](DECISIONS.md) |
| 30 | Business/Branch with SELECTIVE scoping; never `branchId` everywhere | branch scoping | [#30](DECISIONS.md) |
| 31 | WhatsAppConnection first-class; thin channel-agnostic boundary | channel model | [#31](DECISIONS.md) |
| 32 | Provider is a bookable capability/profile, not an authorization role | provider model | [#32](DECISIONS.md) |
| 33 | AI interprets; Domain decides/executes; Conversation orchestrates; minimal context | AI/domain boundary | [#33](DECISIONS.md) |
| 34 | Production reliability prerequisites (concurrency, idempotency); built in #38 | booking writes/webhooks | [#34](DECISIONS.md) |
| 35 | Provider availability inherits business hours | availability rules | [#35](DECISIONS.md) |
| 36 | Usage ≠ Cost ≠ Price ≠ Entitlement ≠ Billing; billing deferred | economics/metering | [#36](DECISIONS.md) |
| 38 | P0 architecture-hardening foundations (#30–#36 choices) | branch/concurrency/idempotency | [#38](DECISIONS.md) |
| 39 | Context-tier reading model replaces `CONTEXT_RECOVERY.md` | docs navigation | [#39](DECISIONS.md) |
| 40 | Migration-chain repair: `0_init` baseline + lock file | migrations | [#40](DECISIONS.md) |
| 41 | Minimal platform control plane; public signup CLOSED | signup/platform | [#41](DECISIONS.md) |
| 42 | Meta WhatsApp Cloud API is the WhatsApp provider | WhatsApp integration | [#42](DECISIONS.md) |
| 43 | Prompt/evaluation separation; `docs/ai/` canonical | prompts | [#43](DECISIONS.md) |
| 44 | AI provider policy: OpenRouter primary / AgentRouter secondary / fallback | provider selection | [#44](DECISIONS.md) |
| 45 | AI → Conversation → Domain booking boundary; CORE-01/02 are truth | booking via conversation | [#45](DECISIONS.md) |
| 46 | Inbound identity: `phone_number_id` → `findByExternalId`; Meta outbound | inbound/outbound resolution | [#46](DECISIONS.md) |
| 47 | WhatsApp onboarding `/settings/whatsapp`; `externalId` authoritative | connection setup | [#47](DECISIONS.md) |
| 48 | Prompt bodies live only in `/prompts/**/*.prompt` | any prompt body | [#48](DECISIONS.md) |
| 49 | Runtime credentials: Neon + AES-256-GCM, `fp:<id>` grammar | credential storage | [#49](DECISIONS.md) |
| 50 | Knowledge visibility: `PUBLIC`/`CONDITIONAL`/`INTERNAL`/`FORBIDDEN` | what reaches the AI | [#50](DECISIONS.md) |
| 51 | Context builder: B-01 pipeline composing `AiRequest` + ledger | AI context | [#51](DECISIONS.md) |
| 52 | Disclosure boundary: "AI may know" ≠ "AI may mention"; structural gate | AI replies | [#52](DECISIONS.md) |
| 53 | Service catalog is domain data, not a second knowledge base; duration INTERNAL | services | [#53](DECISIONS.md) |
| 54 | Appointment creation: smart context, relative scheduling, availability-first | booking UX | [#54](DECISIONS.md) |
| 55 | Appointments/availability coherence: day-view reset + capacity chips | day view | [#55](DECISIONS.md) |
| 56 | Slot presentation: visible-but-disabled «غير متاح» candidates; no inference | slot step | [#56](DECISIONS.md) |
| 57 | Documentation normalization + tiered context governance | docs structure | [#57](DECISIONS.md) |
| 58 | B-03-refused reply delivers safe handoff acknowledgment, never silence; refines #52 | disclosure refusal/reply path | [#58](DECISIONS.md) |
| 59 | CodeCraft isolated OpenAI-compatible Discovery provider (extends #44) | provider boundary | [#59](DECISIONS.md) |
| 60 | AI provider failure delivers safe handoff acknowledgment; extends #58 | AI-failure/reply path | [#60](DECISIONS.md) |
| 61 | GREETING is the one knowledge-free intent (0 LLM calls); Resume AI exists | intent/disclosure/handoff resume | [#61](DECISIONS.md) |
| 62 | Assistant voice is one structured style module in request context | assistant voice/notifications/UX | [#62](DECISIONS.md) |
| 63 | Telegram is the second channel via existing transport seams | channel model/Telegram implementation | [#63](DECISIONS.md) |
| 64 | Telegram foundation: external-handle identity + connection/provisioning tables | inbound identity/Telegram data model | [#64](DECISIONS.md) |
| 65 | Telegram transport + webhook + Conversation-Engine bridge | Telegram transport/webhook security | [#65](DECISIONS.md) |
| 66 | Telegram manager-bot provisioning state machine; security defects fixed | provisioning/manager webhook | [#66](DECISIONS.md) |
| 67 | Telegram onboarding `/settings/telegram`; live E2E checkpoint PENDING | onboarding UI/live E2E boundary | [#67](DECISIONS.md) |
| 68 | First Telegram live E2E; Manager Bot verified; proxy 307 fixed; actions left | proxy public paths/Telegram live claims | [#68](DECISIONS.md) |
| 69 | Telegram keyboard `request_id` defect live-proved and fixed | keyboard payload/live claims | [#69](DECISIONS.md) |
| 70 | `getManagedBotToken` wire shape fixed (`user_id`, bare-string token) | managed-bot completion | [#70](DECISIONS.md) |
| 71 | Official newbot deep-link fallback while keeping the keyboard | managed-bot creation UX | [#71](DECISIONS.md) |
| 72 | Android app chooser for standard Telegram vs Telegram X | Telegram launch/app selection | [#72](DECISIONS.md) |
| 73 | Customer `/start` is deterministic, never an AI turn | customer `/start`/webhook parser | [#73](DECISIONS.md) |
| 74 | Standard Telegram only; Telegram X removed (reverses #72) | Android launcher/app selection | [#74](DECISIONS.md) |
| 75 | Context Architecture V1: `CONTEXT_MAP.md` + read-only `pnpm context`; not a graph | context entries/tooling | [#75](DECISIONS.md) |
| 76 | Evaluation data foundation: schema + scenario matrix; labels only | dataset schema/coverage matrix | [#76](DECISIONS.md) |
| 77 | Egyptian-v1 dataset generation; 1933 cases / 278 scenarios; deterministic | generating/extending the dataset | [#77](DECISIONS.md) |
| 78 | Target AI architecture — DESIGN ONLY, NOT IMPLEMENTED | future AI architecture/migration queue | [#78](DECISIONS.md) |
| 79 | Slice 0 implemented: goals/clarification/cause/facts + observability seam | AI contract/turn observability | [#79](DECISIONS.md) |
| 80 | Slice 6: service pricing + task-gated price exposure + missing-price handoff | service price/disclosure | [#80](DECISIONS.md) |
| 81 | Slice 7: typed handoff causes + operator mapping; safety precedence corrected | handoff causes/operator attention | [#81](DECISIONS.md) |
| 82 | Slice 8: optional JEV strategy behind the existing gateway | JEV/gateway budget | [#82](DECISIONS.md) |
| 83 | Slice 9: knowledge-gap recorder, record-only, off the critical path | knowledge-gap lifecycle | [#83](DECISIONS.md) |
| 84 | Slice-9 lifecycle evaluation; verdict correct/useful/bounded; harness fixes | knowledge-gap evaluation | [#84](DECISIONS.md) |
| 85 | Pilot evidence readiness assessment; live pilot running; no code change | pilot evidence/readiness | [#85](DECISIONS.md) |
| 86 | Live false-handoff forensics + minimal disclosure repair (service-name channel) | live false handoff/disclosure | [#86](DECISIONS.md) |
| 87 | Low-friction business knowledge/readiness UX; address/about authoring | business knowledge/AI readiness | [#87](DECISIONS.md) |
| 88 | Live routing forensics + observability foundation (`turn.evidence@v1`) | observability/turn evidence | [#88](DECISIONS.md) |
| 89 | Superadmin provider-policy verification; CodeCraft key failure; display repair | provider policy/credential display | [#89](DECISIONS.md) |
| 90 | Live pilot/product loop with Atria; READY_FOR_PILOT_EVIDENCE; no code change | pilot loop with Atria | [#90](DECISIONS.md) |
| 91 | Assistant readiness + settings + low-friction setup; bounded name/style | assistant settings/readiness | [#91](DECISIONS.md) |
| 92 | OpenRouter provider pin: Superadmin-only, OpenRouter-only; default unchanged | OpenRouter cost routing | [#92](DECISIONS.md) |
| 93 | DEVOPS-01E VPS development (historical; superseded by AGENT_RULES §4) | history only; not a VPS permission | [#93](archive/IMPLEMENTATION_HISTORY.md) |
| 94 | Reliable appointment reminders, configurable hours, safe customization | reminders/scheduler | [#94](DECISIONS.md) |
| 95 | Semantic safety ownership + false-handoff repair; `safetyAssessment` | turn control/sensitive handoff | [#95](DECISIONS.md) |
| 96 | Physical-attempt accounting and control audit (CORE-04A) | attempt accounting/telemetry | [#96](DECISIONS.md) |
| 97 | Counter semantics + usage evidence repair; logical vs physical calls | usage/counters/cost | [#97](DECISIONS.md) |
| 98 | Preserve execution evidence on post-AI returns/CAS conflicts | selectionReply/TurnEvidence | [#98](DECISIONS.md) |
| 99 | Global external-model stop + per-turn limits/deadlines (CORE-04B) | AI stop/limits | [#99](DECISIONS.md) |
| 100 | Final-attempt completion deadline repair | deadline/final attempt | [#100](DECISIONS.md) |
| 101 | Channel-neutral choices + presentation boundary + semantic intent ownership | channel choices/Telegram rendering | [#101](DECISIONS.md) |
| 102 | Temporal correction authority + structured calendar clarification | dates/offers/leap years | [#102](DECISIONS.md) |
| 103 | Stale-session sign-in redirect loop repair (ISS-017) | auth screens/proxy/session | [#103](DECISIONS.md) |
| 104 | Truthful unknown-information replies + disclosure/handoff boundary | unknown info/disclosure/handoff | [#104](DECISIONS.md) |
| 105 | Safe Telegram staff reply delivery, route authority, reconciliation and attempt identity | staff reply delivery/routes/idempotency | [#105](DECISIONS.md) |
| 106 | Knowledge-family contract, domain-availability handling, bounded refusal evidence | AI disclosure/contract/availability/evidence | [#106](DECISIONS.md) |
| 107 | Single Production runtime consolidation preparation (not executed) | runtime topology/DB-key pairing/CI isolation | [#107](DECISIONS.md) |
| 108 | Conversation live refresh without draft loss: authenticated read-only refresh action + 5s visible-tab polling, safe merge, no attention/booking/delivery writes | touching conversation detail freshness/polling/draft preservation | [#108](DECISIONS.md) |
| 109 | Authoritative service-price source alignment: expose authorized service ids, require exact id for `service.price`, preserve stored price shape; clear stale attention after Return to assistant | pricing answers/service.price prompt or gate/attention display | [#109](DECISIONS.md) |
| 110 | Render single-service Node migration prep & recoverable secrets: `render.yaml`, `next.config.ts` PWA headers, `RENDER_GIT_COMMIT`, zero-DB `/api/health/live` vs HTTP 503 `/api/health`, exact-SHA release gate, values-free inventory + owner-encrypted X25519/GCM recovery & cutover runbook | Render hosting/health/release gate/secret recovery/cutover | [#110](DECISIONS.md) |
| 111 | Direct Render secret transfer: owner-approved manual-only `direct-transfer` mode for `DATABASE_URL` + `CREDENTIAL_MASTER_KEY` from GitHub Actions secrets to confirmed `yakfi-web`/`ohio`; forced dry-run before per-key apply; optional encrypted recovery retained | Render secret transfer/direct transfer | [#111](DECISIONS.md) |
| 112 | Booking temporal freshness (never resume expired dates/offers into a new request), bounded outbound delivery diagnostics + truthful failed-delivery display, and staff reply identity = persisted `Message.id` (provider id separate) | inherited booking dates/PAST_DATE, delivery failure visibility/diagnostics, staff reply duplicate/identity reconciliation | [#112](DECISIONS.md) |
| 113 | Conversation Lab alignment: separate runtime relevance from override connection, hide legacy/unused paths from the default operational view, canonical-validator editor feedback, dirty/discard handling, preserve drafts on failed publish/readback; no runtime semantic change | Conversation Lab labels/filtering/editor behavior, runtime-vs-override classification, Lab dirty/discard semantics | [#113](DECISIONS.md) |
| 114 | AI policy-resolution failure fails closed: bounded `policy-unavailable` assistant enters existing `AI_FAILURE` / `NEED_HUMAN` path with zero provider/JEV calls, no lexical fallback, truthful zero-call evidence | policy read/persistence/invalid failure, AI failure evidence, safe handoff | [#114](DECISIONS.md) |
| 115 | Request-scoped policy-failure evidence: stateless policy wrapper + optional `respondWithExecution` result; no shared last provider/telemetry; explicit no-call marker; unknown evidence never forced to zero | concurrent AI turns, policy failure attribution/counters/usage | [#115](DECISIONS.md) |

| 116 | Durable turn usage/cost evidence: bounded content-free projection, stable message identity, replay/conflict semantics, explicit pools, read-only reconciliation | turn cost evidence/persistence/reconciliation | [#116](DECISIONS.md) |
| 117 | PR88 repair: request-scoped execution reuse, required pool scope, exact full-window reconciliation, execution-proof/dispatch honesty | durable evidence concurrency/pools/reconciliation/unknown execution | [#117](DECISIONS.md) |
| 118 | PR88 reconciliation completeness: unresolved usage/identity/conflicts/contradictory no-call block complete totals; known subtotals remain; repeatable-read snapshot; known other-pool links excluded | durable evidence reconciliation/completeness/conflicts/snapshot | [#118](DECISIONS.md) |
| 119 | Authoritative service-catalog pricing: typed `service.price` catalog scope, truthful missing-price rendering, exact single-service ids preserved, refusal diagnostics report the evaluated family/source outcome | service-catalog price questions/service.price gate/refusal evidence | [#119](DECISIONS.md) |
| 120 | PR96 focused repair: successful `service.price` evidence carries the canonical evaluated scope; `POLICY_REFUSED` copy is neutral about delivery and leaves actual status to the existing indicator | successful scope evidence/POLICY_REFUSED copy | [#120](DECISIONS.md) |

## Historical decisions (never load unless doing forensics)

<!-- prettier-ignore -->
| ID | Decision | Why historical |
| --- | --- | --- |
| 37 | PROMPT-ARCH-01 documentation canonicalization | Superseded by #39 (tier model) and refined by #57. Its `DECISIONS_INDEX.md` deletion note is itself superseded by #57 — the operator re-introduced a decisions ROUTING index (not a general docs index) to cut cold-start context. |

## Notes

- `#93` is preserved in the Tier 3 archive because its detailed implementation
  narrative existed only in the former index row, not in `DECISIONS.md`. Its
  VPS-local check behavior is historical and does not authorize VPS execution;
  see `AGENT_RULES.md` §4.
- Decisions #105–#107 were merged to `main` through PR #83
  (`f15deded`, `v0.79.10`); #107's runtime consolidation itself remains prepared,
  not executed. R6 historical attribution remains unproven. Decision #108 was
  merged through PR #84 (`b485bda`, `v0.79.11`) but its later live acceptance is
  not claimed here. Decision #109 merged through PR #85 (`e5ff129`, `v0.79.12`).
  PR #86 merged booking concurrency/tenant-isolation evidence as `472e9aa` /
  `v0.79.13`; the current evidence-completion branch is test/documentation work
  and does not change a product decision. Decision #111 adds the owner-approved
  direct Render secret transfer path (draft PR, not applied); it does not
  require keygen, an encrypted bundle, or `owner_restoration_proof`.
- Decision #112 is a draft repair (v0.79.19) for inherited booking temporal
  freshness, bounded outbound delivery diagnostics/visibility, and staff reply
  transcript identity. It is not merged, deployed or live-retested.
- Decisions #116/#117 are the refreshed draft PR #88 candidate
  (`v0.79.22`) on top of PR #95's merged `0.79.21` / `9187655`. The durable
  evidence path reuses the merged request-scoped `respondWithExecution`
  boundary; it does not introduce a second execution wrapper or shared
  last-provider/telemetry state. Decision #118 repairs reconciliation
  completeness/conflict/snapshot semantics. The additive migrations remain
  unapplied and no merge, deploy or production migration is claimed.
