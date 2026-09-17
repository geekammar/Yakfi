# FlowPilot — AI Architecture & Prompt Boundary

> Prompt/interface separation boundary for `ConversationAi`. Canonical
> implementation boundary: `docs/ARCHITECTURE.md → Responsibility Separation
(DECISIONS #33)` and `src/features/conversations/server/ai-contract.ts`
>
> - `src/features/conversations/server/conversation-ai.ts` (+ engine:
>   `conversation-engine.ts`). This file records ONLY the prompt/policy
>   separation — do not duplicate `docs/ARCHITECTURE.md`.
>
> Decision record: DECISIONS #33/#38 (AI interprets → Domain decides →
> Conversation orchestrates), DECISIONS #29 (WhatsApp `Meta` resolved,
> AI transport intentionally NOT integrated). Production code today is
> **deterministic** (`deterministicConversationAi`) — real LLM is a future
> operator decision behind the SAME interface.

## Invariant (binding)

```
AI interprets → Domain decides & executes → Conversation Engine orchestrates
```

- **AI MAY:** classify intent, extract bounded facts, detect ambiguity, surface
  provider preference phrasing, produce customer-facing content already phrased.
- **AI MUST NEVER:** mutate appointments, query Prisma, decide availability or
  provider eligibility, invent slots, emit chain-of-thought across the boundary,
  or bypass tenant (`businessId`/`branchId`) scoping.
- **Conversation Engine owns:** orchestration, persistence, customer/conversation
  resolution, conversation state, human handoff, retrieval of task-relevant
  facts; it loads context deterministically and re-validates every AI output
  before persisting.
- **Domain owns:** authoritative validation and deterministic execution
  (eligibility `resolveEligibleProviders`, availability `getAvailability` /
  `resolveBookingOptions`, conflicts, booking writes — `SERIALIZABLE`).

## Boundary diagram

```
  Inbound (WhatsApp transport)
         │
         ▼
  Conversation Engine  ───────────────────────────────────────────────┐
    1. resolve Business by receiving number (never client input)      │
    2. claim external key (durable idempotency) before any write      │
    3. upsert Customer · find/create Conversation (Branch-aware)      │
    4. persist CUSTOMER message (claim-coupled)                       │
    5. defer when not AI-eligible (NEED_HUMAN / BOOKED / staff-owned) │
    6. load MINIMAL business context only (see Context Budget)        │
    7. deterministic bypass? ──yes──▶ structured handoff (no AI_TURN)│
    8. else: AiRequest ──▶ ConversationAi.respond ──▶ AiResponse      │
    9. re-validate AiResponse (Zod) before persisting                 │
   10. persist assistant reply · optional booking_handoff summary      │
   11. deliver via MessageTransport (best-effort)                      │
  ───────────────────────────────────────────────────────────────────-┘
         │
         ▼
  ConversationAi  (interface — provider-neutral)
    deterministicConversationAi  ◀── safe fallback (no LLM)
    openrouter adapter           ◀── selectable via platform AI policy
    agentrouter adapter          ◀── selectable (see AGENTROUTER_KNOWN_ISSUE.md)
    atria adapter                ◀── selectable (see PROVIDERS.md)
          │  contract: src/features/conversations/server/ai-contract.ts
         │  AiRequest → AiResponse  (unknown keys stripped; invariants refined)
         ▼
  Usage telemetry (append-only, ids+counters+machine keys; never content/secrets/chain-of-thought)
```

## Structured contract (single source of truth)

- **Request — `AiRequest` (`ai-contract.ts: aiRequestSchema`):**
  `message` (1–4096) + `conversationStatus` + `recentMessages` (≤20) +
  `businessName` + `services[]` (≤100) + `faqs[]` (≤50) +
  optional `providerPreference` + optional `availability[]` (≤14 × ≤50 slots).
  Never the whole DB, never complete history.
- **Response — `AiResponse` (`aiResponseSchema`):** `intent` (fixed family) +
  `action` (`reply` | `handoff` | `booking_handoff`) + `content` (1–4096, already
  phrased) + `extraction` (service/provider/date/timePreference — facts only) +
  `handoffReason` (required for `handoff`) + `summary` (required for
  `booking_handoff`). Unknown keys (provider `reasoning` / chain-of-thought)
  are **stripped** by Zod in `parseAiResponse` and never persisted downstream.
- **Enums — code truth:** `aiIntentValues = FAQ | BOOKING | AVAILABILITY |
RESCHEDULE | CANCELLATION | HUMAN_REQUEST | AMBIGUOUS`; `handoffReasonValues
= HUMAN_REQUEST | SENSITIVE | NO_KNOWLEDGE | AMBIGUOUS` (`ai-contract.ts`).
- **Bypass — `bypassDeterministicAi(AiRequest)`:** returns a complete `AiResponse`
  when the turn is decidable without any provider (today: too-short → `AMBIGUOUS`).
  The engine consults it **before** `ConversationAi.respond`, so those turns emit
  no `AI_TURN` telemetry. The bypass is part of the prompt boundary — future
  adapters inherit it.

## Context budget (minimal prompt context)

The engine's `AiRequest` is the **prompt context** — nothing larger is sent:

- Task-relevant facts only: `services` / `faqs` / provider preference /
  already-resolved `availability` — not every customer, not every appointment.
- Bounded history: `recentMessages` ≤ 20; relevance ordering is engine-side
  (`conversation-engine.ts` takes the most recent ≤20 in chronological order).
- Compact state: `conversationStatus` only — full DB/business context never sent.
- Tenancy is engine-side (`Business` resolved from receiving WhatsApp number;
  conversation scoped to `businessId` + `branchId`) — the LLM never resolves tenancy.

## Invocation contract (prompt → adapter → engine)

1. **Prompt definition lives in `docs/ai/PROMPTS.md`** — provider-neutral,
   versioned `id@version` (e.g. `booking-intent@v1`), reviewed as configuration
   in source control; never edited at runtime.
2. **Adapter maps prompt → provider shape at call time** (future `src/server/ai/`
   or `src/server/integrations/ai/` — not in this phase): the adapter renders
   `AiRequest` + the prompt's `system instructions`/`output contract` into the
   provider's chat shape, calls the provider, parses JSON, validates against
   `aiResponseSchema`, re-parses via `parseAiResponse`, and returns `AiResponse`.
3. **Engine receives `AiResponse`** — re-validates it (`parseAiResponse`) and
   maps `action` → `conversation.status` (`reply → AI_ACTIVE`, others →
   `NEED_HUMAN`). Booking intents produce `booking_handoff` + `summary` for staff;
   they never create appointments.
4. **Runtime policy (`PlatformAiPolicy`)** is the SEPARATE layer that answers
   **which** `ConversationAi` answers (primary/secondary + fallback). It lives
   in `src/server/repositories/ai-policy.repository.ts` (+ `src/features/platform/`).
   Changing the provider/model (`primaryModel`, `fallbackEnabled`) does not change
   prompt identity; bumping a prompt version does not change the policy.

## Prompt vs. policy separation (binding)

| Concern                                                            | Where it lives                                                                       | Who may change it                      | How it changes                                                              |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | -------------------------------------- | --------------------------------------------------------------------------- |
| Prompt definitions (`booking-intent@v1`, …)                        | `docs/ai/PROMPTS.md` (versioned artifacts)                                           | Code reviewer only (PR)                | Version bump `…@v1 → …@v2` + fixture update + `pnpm check:ai-prompts` green |
| Runtime provider selection (primary/secondary/fallback/secretRefs) | `platform_ai_policies` singleton (`src/server/repositories/ai-policy.repository.ts`) | Platform Operator (Superadmin DB path) | `updateAiPolicy` (validated; secretRefs only, no key material)              |
| Telemetry/policy observability                                     | `usage_records` (kind `AI_TURN` — provider/model/tokens/latency/handoff)             | Append-only; no write blocks the turn  | Engine best-effort `recordUsage` — see Economics boundary                   |

Prompts are **not** DB rows, not Superadmin-editable, not A/B-testable in this
phase. A/B testing and a prompt marketplace are explicitly **deferred** — do
not scaffold them here.

## Provider-neutrality invariants (enforced by `pnpm check:ai-prompts`)

- Prompt files contain **no** provider syntax (`openrouter`, `agentrouter`,
  `openai`, `anthropic`, `x-api-key`, `Authorization`, model hacks like
  `gpt-4o`/`claude`/`gemini`).
- Prompts reference only the **contract** (`message`, `recentMessages`,
  `services`, `faqs`, `providerPreference`, `availability`) and the **response
  shape** (`intent`, `action`, `content`, `extraction`, `handoffReason`,
  `summary`). No tool-call JSON, no function-calling DSL, no provider SDK name.
- One prompt maps to one `AiIntent` family + one `AiAction` — no invented intents.

## Telemetry & cost boundary (no live LLM call now, but not blocked)

- No live LLM call is made in this phase — `deterministicConversationAi` is the
  only wired adapter (`defaultConversationEngineDeps.ai`). Cost-impacting work
  stays deferred until a real provider decision lands (DECISIONS #29).
- Artifacts must not block the future telemetry shape already implemented in
  `conversation-engine.ts` + `usageRepository` (+ `docs/ECONOMICS.md` —
  `Usage ≠ Cost ≠ Price ≠ Entitlement ≠ Billing`):
  per-`AI_TURN`: `businessId`, `conversationId`, `provider` (machine key),
  `model` (when available), `timestamp`, `intent`, input/output/cached tokens,
  latency, success/failure, handoff outcome, booking outcome.
- Prompts MUST NOT ask the model to emit tokens counts, cost, or chain-of-
  thought — those are engine-side facts. `AiResponse` stays facts-only; all
  cost/latency accounting is in the engine's `recordUsage(AI_TURN)`.

## Files this boundary reuses (never duplicated)

- `src/features/conversations/server/ai-contract.ts` — the typed contract
- `src/features/conversations/server/conversation-ai.ts` — `ConversationAi` + `deterministicConversationAi` + `classifyCustomerMessage`
- `src/features/conversations/server/conversation-engine.ts` — orchestration + minimal context + `bypassDeterministicAi` call order + `recordUsage`
- `src/server/repositories/ai-policy.repository.ts` + `src/features/platform/server/ai-policy-service.ts` — runtime selection layer (`PlatformAiPolicy`, `toEffectivePolicy`)
- `src/lib/validation/platform.ts` — `aiProviderValues` allowlist + `secretRefSchema`

## Upgrade path (without changing the engine)

Deterministic today (`deterministicConversationAi`)
│
▼ same AiRequest → AiResponse contract
`ConversationAi` adapters (provider-neutral)
├─ openrouter adapter (primary when operator sets `primaryProvider: openrouter`)
├─ agentrouter adapter (selectable — known issue, see AGENTROUTER_KNOWN_ISSUE.md)
└─ atria adapter (selectable — see docs/ai/PROVIDERS.md)
│
▼ same engine contract — no engine change
No other layer needs to change: Domain/availability/booking/tenancy stay deterministic.

## Deferred (do NOT build in this phase)

- Real LLM invocation, provider HTTP/signature/media handling, vector DB / RAG.
- Prompt A/B testing, prompt marketplace, DB-backed prompt management UI.
- Any Superadmin-write path for prompt artifacts (the policy write path already
  exists and stays platform-only).
- Per-message token attribution beyond the existing `AI_TURN` usage row — do not
  invent new telemetry tables here.
