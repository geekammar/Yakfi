# FlowPilot — Context Map

> **Context Architecture V1 — a STARTING-POINT index, not a dependency graph.**
> This file tells an engineering agent WHERE TO START READING for a task so a
> fresh OpenCode session does not re-scan the whole repository. It is a small,
> hand-maintained index of the major feature boundaries. It deliberately holds
> NO copied code, NO token counts, NO long explanations, and NO complete
> dependency graph. Reading policy lives in `docs/AGENT_RULES.md`; this map is
> the per-feature entry layer beneath the Tier model. (DECISIONS #75.)

## Rules

- **Tier 0 first, always.** Read `docs/AGENT_RULES.md` + `docs/CURRENT_STATE.md`
  - `docs/DECISIONS_INDEX.md` before anything else. Those three are global and
    are NOT repeated in each context below.
- **Then resolve ONE context** matching the task (`pnpm context <name>`).
- Read the context's mapped docs, then its mapped code, then its focused tests.
- **Expand only when a real dependency is discovered** — follow an actual
  `import`/reference from a mapped file outward; never pre-load "to be safe".
- The mapped files are the DOORWAY, not the whole room. Most tasks touch only a
  subset of them.
- If a task spans two contexts, resolve both and read the intersection first.
- Keep this map small: add a context only when it has an obvious, existing
  boundary. Do not fabricate precise entries for unclear boundaries — record
  them under "Boundaries needing later refinement" instead.

## Dependency discovery (how to expand safely)

This map is intentionally NOT a maintained dependency graph. When the mapped
files are not enough:

1. Open a mapped source file.
2. Read its top-of-file `import` statements and follow ONLY the ones the current
   task actually touches.
3. Repeat outward one hop at a time, stopping as soon as the task is actionable.

Do not build or persist a graph. Do not dump the source tree. The map defines
the start; the code defines the truth (authority order in
`docs/DECISIONS_INDEX.md`).

## Tooling

- `pnpm context <name>` — print the docs / code / tests for a context.
- `pnpm context <name> --verbose` — also list the direct first-hop imports
  discovered from the mapped source files (best-effort, read-only).
- `pnpm context <name> --stats` — also print file count + approximate text size
  (a diagnostic only; NOT a token budget).
- `pnpm context:check` — validate every mapped path exists and names are unique.

## Contexts

### telegram.customer

The customer-facing Telegram channel: the per-connection webhook, the thin
transport/adapter over the unchanged Conversation Engine, the deterministic
`/start` welcome, and the `/settings/telegram` onboarding surface.
Docs:

- docs/TELEGRAM.md
  Code:
- src/server/integrations/telegram/telegram-webhook.ts
- src/server/integrations/telegram/telegram-webhook-handler.ts
- src/server/integrations/telegram/telegram-transport.ts
- src/server/integrations/telegram/telegram-client.ts
- src/app/api/telegram/webhook/route.ts
- src/features/telegram-connection/components/telegram-connection-screen.tsx
- src/features/telegram-connection/server/telegram-connection-service.ts
- src/features/telegram-connection/telegram-app-launcher.ts
- src/server/repositories/telegram-connection.repository.ts
- src/lib/public-paths.ts
  Tests:
- scripts/check-telegram.ts
- scripts/check-telegram-onboarding.ts

### telegram.managed-bot

The Telegram Manager Bot provisioning state machine: `/start` creator binding,
the `managed_bot` completion (token → `fp:<id>` → `setWebhook` → `getMe` →
CONNECTED), typed failures, and the single-use provisioning ledger.
Docs:

- docs/TELEGRAM.md
  Code:
- src/server/integrations/telegram/telegram-manager-webhook-handler.ts
- src/server/integrations/telegram/telegram-provisioning.ts
- src/server/integrations/telegram/telegram-verify.ts
- src/server/integrations/telegram/telegram-client.ts
- src/app/api/telegram/manager/webhook/route.ts
- src/server/repositories/telegram-provisioning-ledger.repository.ts
- src/server/repositories/telegram-connection.repository.ts
- src/lib/public-paths.ts
  Tests:
- scripts/check-telegram.ts
- scripts/check-telegram-onboarding.ts

### whatsapp.connection

The WhatsApp channel: the Meta Cloud API adapter, the inbound webhook, the
provider-neutral transport contract, connection identity resolution, and the
Meta Embedded Signup onboarding surface.
Docs:

- docs/INTEGRATION_CHECKPOINTS.md
- docs/ARCHITECTURE.md
  Code:
- src/server/integrations/whatsapp/meta-client.ts
- src/server/integrations/whatsapp/meta-webhook.ts
- src/server/integrations/whatsapp/meta-embedded-signup-authorizer.ts
- src/server/transport/whatsapp-transport.ts
- src/app/api/whatsapp/meta/route.ts
- src/features/whatsapp-connection/components/whatsapp-connection-screen.tsx
- src/features/whatsapp-connection/server/whatsapp-connection-service.ts
- src/features/whatsapp-onboarding/server/whatsapp-onboarding-service.ts
- src/server/repositories/whatsapp-connection.repository.ts
- src/lib/whatsapp-identity.ts
  Tests:
- scripts/check-whatsapp-transport.ts
- scripts/check-whatsapp-inbound.ts
- scripts/check-whatsapp-onboarding.ts
- scripts/check-meta-embedded-signup.ts

### ai.conversation-engine

The Conversation Engine and the AI boundary: inbound orchestration, the
provider-agnostic AI adapter/factory, the minimal AI context builder (knowledge
visibility), and the customer disclosure gate. AI interprets; Domain decides;
Conversation orchestrates (DECISIONS #33).
Docs:

- docs/ai/README.md
- docs/ai/ARCHITECTURE.md
- docs/ai/TARGET_ARCHITECTURE.md
  Code:
- src/features/conversations/server/conversation-engine.ts
- src/features/conversations/server/conversation-ai.ts
- src/features/conversations/server/ai-observability.ts
- src/features/conversations/server/ai-context-builder/context-builder.ts
- src/features/conversations/server/ai-disclosure/disclosure-gate.ts
- src/server/integrations/ai/factory.ts
- src/server/integrations/ai/prompt-registry.ts
- src/server/integrations/ai/response-normalizer/pipeline.ts
- src/lib/ai-knowledge-visibility/knowledge-visibility.ts
  Tests:
- scripts/check-ai-provider.ts
- scripts/check-ai-context-builder.ts
- scripts/check-ai-disclosure.ts
- scripts/check-ai-architecture.ts
- scripts/check-conversation-booking.ts

### booking.appointments

The booking domain: the ONE availability/scheduling authority, appointment
creation, the multi-step booking flow, and the Smart Create UI. Availability
authority returns only genuinely selectable slots; booking is
server-authoritative; there is no second availability engine.
Docs:

- docs/ARCHITECTURE.md
- docs/DATABASE.md
  Code:
- src/lib/scheduling/slot-grid.ts
- src/features/appointments/server/availability-service.ts
- src/features/appointments/server/appointment-create-service.ts
- src/features/appointments/server/booking-flow-service.ts
- src/features/appointments/components/smart-create/smart-create-appointment.tsx
- src/server/repositories/appointment.repository.ts
  Tests:
- scripts/check-appointment-creation.ts
- scripts/check-booking-ux.ts
- scripts/check-reschedule.ts

### auth

Authentication and authorization: the single Better Auth setup, tenant-scoping
guards (UI visibility is not authorization), the route proxy, and the public
(unauthenticated) path policy.
Docs:

- docs/ARCHITECTURE.md
  Code:
- src/lib/auth.ts
- src/server/auth/guards.ts
- src/proxy.ts
- src/lib/public-paths.ts
- src/features/auth/components/login-form.tsx
  Tests:
- scripts/check-signup-policy.ts

### customers.conversations

The operator-facing inbox and customer directory: the conversations inbox +
detail UI, the customers directory, and their read/query + repository layers.
Docs:

- docs/ARCHITECTURE.md
- docs/DATABASE.md
  Code:
- src/features/conversations/components/inbox-list.tsx
- src/features/conversations/components/conversation-detail.tsx
- src/features/conversations/server/conversation-queries.ts
- src/features/customers/components/customers-directory.tsx
- src/features/customers/server/customer-service.ts
- src/server/repositories/conversation.repository.ts
- src/server/repositories/customer.repository.ts
  Tests:
- scripts/check-conversation-ux.ts
- scripts/check-conversation-handoff.ts
- scripts/check-operator-attention.ts

## Boundaries needing later refinement

These areas exist but do not yet have a clean, single-doorway boundary worth a
precise map entry. Add one only when a task proves the boundary:

- **platform / control plane** (`src/features/platform`, signup policy, operator
  guards) — overlaps `auth`; map separately only if it grows its own tasks.
- **knowledge / services authoring** (`src/features/knowledge`,
  `src/features/services`) — currently reachable via `ai.conversation-engine`
  (knowledge) and `booking.appointments` (services) starting points.
- **onboarding / settings / staff / dashboard** UI features — thin surfaces over
  the contexts above; no independent doorway yet.

## Maintaining this map

- Add a context ONLY for a boundary that already exists and is obviously useful.
- Keep each context to a small set of START files (the doorway), not every file.
- When a mapped file moves or is deleted, update the entry and run
  `pnpm context:check`.
- Never copy code, decisions, or architecture prose into this file — link to the
  canonical doc instead.
- This map is append-friendly but not append-only; it may be edited freely
  because it is an index, not a historical record.
