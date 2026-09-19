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
> Conversation orchestrates), DECISIONS #42 (WhatsApp provider = Meta Cloud
> API), DECISIONS #44 (runtime AI provider policy: openrouter primary /
> agentrouter secondary, fallback enabled; `atria` added as a selectable
> provider). The engine default is the **policy-backed** `ConversationAi`
> (`createPolicyBackedAi` in `conversation-engine.ts`), which builds the
> real adapters from the live policy and falls back to
> `deterministicConversationAi` only when the policy cannot be read.

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

## Prompt Workspace (source of truth for prompt BODIES)

Prompt **content** and prompt **runtime/wiring** are separated. Only genuine
LLM instruction text is a prompt; everything else stays code.

```
  prompts/*.prompt                          ← source of truth (BODIES only)
        │  `# prompt id:` header declares the stable id
        ▼
  scripts/generate-ai-prompts.ts           ← deterministic build-time compiler
        ▼
  src/generated/ai-prompts.generated.ts    ← committed runtime artifact
        ▼
  src/server/integrations/ai/prompt-registry.ts   ← registry + loader
        ▼
  buildPromptMessages() / provider adapters         ← wiring, no bodies
```

| Layer                               | Owner                          | May contain prompt bodies?                                              |
| ----------------------------------- | ------------------------------ | ----------------------------------------------------------------------- |
| `/prompts/**/*.prompt`              | Prompt author (PR review)      | **YES — the only place.** Git is the version history.                   |
| `prompt-registry.ts`                | AI runtime layer               | No. Stable id → source path + variable contract + consumer only.        |
| `src/generated/…generated.ts`       | Generator (derived, committed) | No — derived byte-for-byte from `/prompts`. Regenerated on every build. |
| `prompt.ts` / `atria.ts` / adapters | AI runtime layer               | No. Wiring only: loads via `getPromptBody`, renders chat shape.         |
| `docs/ai/PROMPTS.md`                | Documentation                  | No. Catalog only: id / purpose / file path / runtime consumer.          |

Rules (binding, enforced by `pnpm check:ai-prompts`):

- **One authoritative location.** `/prompts/**/*.prompt` is the only source
  of truth for an LLM instruction body. There is no second hidden source —
  not a Markdown file, not a DB row, not a constant in TypeScript.
- **No runtime filesystem access.** The runtime reads the generated
  artifact, so this works on Vercel/serverless. A stale or missing artifact
  is a build/check failure, never a silent fallback.
- **Provider-specific instruction text is a prompt too.** The Atria
  JSON-output instruction is genuinely sent to the LLM, so its BODY lives in
  `prompts/providers/`; its execution/wiring/validation (endpoint,
  `secretRef`, timeout, bounded normalization) stays in the adapter.
- **Not prompts — stay code:** domain/business rules, booking algorithms,
  CORE-01/CORE-02, tenant isolation, authorization, deterministic response
  logic, SQL, validation, error enums, API payload construction.
- **Deterministic classifier behavior** (`booking-intent@v1` and the other
  four catalog entries) is code-owned (`conversation-ai.ts`) and is NOT
  registered as a prompt — it is never sent to an LLM. Its fixtures stay in
  `EVALUATIONS.md`.

### Easy edit workflow

1. Open the `.prompt` file.
2. Edit prompt text only.
3. `pnpm generate:ai-prompts` (regenerate the committed artifact).
4. `pnpm check:ai-prompts` (registry ↔ files ↔ artifact + fixtures).
5. Run the relevant AI/provider checks (`check:ai-provider`,
   `check:atria-retry`, …).
6. `pnpm verify`.
7. Review `git diff`.
8. Only then decide whether the change is release-worthy.

### Build integration

`pnpm dev` and `pnpm build` run `pnpm generate:ai-prompts` first, so a
normal build cannot use a stale artifact. `pnpm check:ai-prompts` begins
with a `--check` pass that fails when the committed artifact disagrees with
the source prompt files. Vercel's `buildCommand` (`pnpm db:generate && pnpm
build`) inherits this automatically.

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

1. **Prompt body lives in `/prompts/**/*.prompt`** — provider-neutral,
   stable-id instruction text, compiled at build time into
   `src/generated/ai-prompts.generated.ts` and loaded by
   `prompt-registry.ts` (`getPromptBody`); reviewed as configuration in
   source control, never edited at runtime, never inlined in TypeScript.
   `docs/ai/PROMPTS.md` is the catalog only.
2. **Adapter maps prompt → provider shape at call time** (`src/server/integrations/ai/`):
   the adapter renders `AiRequest` + the prompt's `system instructions`/output
   contract into the provider's chat shape, calls the provider, parses JSON,
   validates against `aiResponseSchema`, re-parses via `parseAiResponse`, and
   returns `AiResponse`.
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

| Concern                                                                   | Where it lives                                                                                                 | Who may change it                      | How it changes                                                                  |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------- |
| Prompt bodies (`system.booking-assistant`, `providers.atria.json-output`) | `/prompts/**/*.prompt` → generated artifact (`src/generated/ai-prompts.generated.ts`)                          | Code reviewer only (PR)                | Edit the `.prompt` + `pnpm generate:ai-prompts` + `pnpm check:ai-prompts` green |
| Deterministic classifier behavior (`booking-intent@v1`, …)                | `src/features/conversations/server/conversation-ai.ts` (code is the truth; catalogued in `docs/ai/PROMPTS.md`) | Code reviewer only (PR)                | Code change + `EVALUATIONS.md` fixtures stay green                              |
| Runtime provider selection (primary/secondary/fallback/secretRefs)        | `platform_ai_policies` singleton (`src/server/repositories/ai-policy.repository.ts`)                           | Platform Operator (Superadmin DB path) | `updateAiPolicy` (validated; secretRefs only, no key material)                  |
| Telemetry/policy observability                                            | `usage_records` (kind `AI_TURN` — provider/model/tokens/latency/handoff)                                       | Append-only; no write blocks the turn  | Engine best-effort `recordUsage` — see Economics boundary                       |

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

## Telemetry & cost boundary

- The engine default is the policy-backed `ConversationAi`
  (`defaultConversationEngineDeps.ai` = `policyBackedAi` →
  `createPolicyBackedAi`): real adapters when the policy is readable,
  `deterministicConversationAi` as the safe fallback. `bypassDeterministicAi`
  still short-circuits decidable turns before any provider call.
- Cost-impacting telemetry is already implemented for the LLM path
  (`conversation-engine.ts` `recordUsage(AI_TURN)` + `usageRepository`);
  determinism is preserved by the Domain, not by withholding the boundary.
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

- `prompts/system/booking-assistant.prompt` + `prompts/providers/atria-json-output.prompt` — the prompt bodies (source of truth)
- `src/generated/ai-prompts.generated.ts` — committed generated artifact (derived; regenerate with `pnpm generate:ai-prompts`)
- `src/server/integrations/ai/prompt-registry.ts` — registry + loader (`PROMPT_REGISTRY`, `getPromptBody`)
- `scripts/generate-ai-prompts.ts` — deterministic build-time generator
- `src/server/integrations/ai/prompt.ts` — the builder (`buildPromptMessages` / `buildRequestBody`)
- `src/features/conversations/server/ai-contract.ts` — the typed contract
- `src/features/conversations/server/conversation-ai.ts` — `ConversationAi` + `deterministicConversationAi` + `classifyCustomerMessage`
- `src/features/conversations/server/conversation-engine.ts` — orchestration + minimal context + `bypassDeterministicAi` call order + `recordUsage`
- `src/server/repositories/ai-policy.repository.ts` + `src/features/platform/server/ai-policy-service.ts` — runtime selection layer (`PlatformAiPolicy`, `toEffectivePolicy`)
- `src/lib/validation/platform.ts` — `aiProviderValues` allowlist + `secretRefSchema`

## Upgrade path (without changing the engine)

Policy-backed today (`createPolicyBackedAi` → real adapters; deterministic is the fallback)
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

- Media download/transcoding/storage, vector DB / RAG.
- Prompt A/B testing, prompt marketplace, DB-backed prompt management UI.
- Any Superadmin-write path for prompt artifacts (the policy write path already
  exists and stays platform-only).
- Per-message token attribution beyond the existing `AI_TURN` usage row — do not
  invent new telemetry tables here.
