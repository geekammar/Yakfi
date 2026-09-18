# FlowPilot — AI Provider Architecture

> How a conversation reaches an LLM, and how providers stay interchangeable.
> Canonical boundary: `docs/ARCHITECTURE.md` (DECISIONS #33) and
> `docs/ai/ARCHITECTURE.md`. This file records ONLY the provider layer.

## 1. Provider abstraction

The Conversation Engine never speaks to a vendor. It consumes one
provider-neutral contract:

```
Conversation Engine
      ↓  AiRequest  (src/features/conversations/server/ai-contract.ts)
AI Provider Interface / Factory
      ↓
Selected Provider Adapter  (AiProviderAdapter)
      ├── AgentRouter adapter
      ├── Atria adapter
      └── OpenRouter adapter
      ↓  AiProviderResult → AiResponse (provider-neutral)
```

- **Interface** — `AiProviderAdapter` (`src/server/integrations/ai/types.ts`):
  `providerId`, `model`, `secretRef`, and `call(AiRequest) → AiProviderResult`.
- **Result taxonomy** — `AiProviderResult` is either `{ ok: true, response, provider,
model, latencyMs, inputTokens?, outputTokens? }` or `{ ok: false, error }` where
  `error.code ∈ { RETRYABLE, PERMANENT, TIMEOUT, INVALID_RESPONSE, CONFIG_ERROR,
CONTROLLED_FAILURE }`. `isRetryableAiError(code)` decides fallback. This is the
  single failure vocabulary every provider maps onto.
- **Shared HTTP** — `callOpenAiCompatible` (`http.ts`) implements request
  construction, `Bearer` auth by secret _name_, response parsing, JSON-fence
  stripping, `parseAiResponse` validation, HTTP-status → error mapping, and
  timeout. OpenAI-compatible adapters are thin wrappers over it.
- **Factory** — `adapterForProvider` (`factory.ts`) turns the effective policy into
  adapters: primary always, secondary only when fallback is enabled and configured.
- **Orchestration** — `orchestrator.ts`: primary → (on retryable/timeout) secondary →
  else controlled failure (engine maps `null` → `NEED_HUMAN`).
- **Conversation Control** — `conversation-control/`: the provider-agnostic
  policy layer (bounded retry + human handoff + notifications) that wraps the
  primary adapter. See §8.

## 2. AgentRouter adapter

- File: `src/server/integrations/ai/agentrouter.ts`
- Endpoint: `https://agentrouter.org/v1/chat/completions` (OpenAI-compatible)
- Secret reference: `AGENTROUTER_API_KEY` (env name only)
- Timeout: 12000 ms
- See `AGENTROUTER_KNOWN_ISSUE.md` — a production `AI_TURN` currently fails; the
  adapter is intentionally unchanged here.

## 3. Atria adapter

- File: `src/server/integrations/ai/atria.ts`
- Endpoint: `https://api.atria-asi.ai/v1/chat/completions` (OpenAI-compatible)
- Secret reference: `ATRIA_API_KEY` (env name only — never in DB/UI/logs)
- Timeout: 16000 ms (covers the observed ≈15s provider latency tail; same
  taxonomy as the other adapters)
- Model is policy-supplied (e.g. `Atria-Dawn-Preview`); the adapter passes it
  through unchanged.
- **ONE adapter invocation = ONE provider attempt.** The adapter owns NO
  conversation policy: retry, human handoff and notifications are decided by
  the provider-agnostic Conversation Control Layer (§8). A `TIMEOUT` is
  classified and returned immediately.
- Atria-only JSON-output hardening (`ATRIA_JSON_INSTRUCTIONS`) and the bounded
  Atria normalization policy remain here — they are provider _execution_
  concerns, not conversation policy.

Isolation guarantee: the Atria adapter owns only its endpoint, secret name,
timeout, JSON instructions and normalization policy. It shares
`callOpenAiCompatible` for request/response/error semantics, so selecting
Atria changes nothing about AgentRouter, OpenRouter, the prompt, the engine,
booking, or WhatsApp transport.

One-logical-turn guarantee: retry is external to the adapter (§8), so the
orchestrator and the engine still receive exactly ONE `AiProviderResult` per
logical customer turn. Persistence and delivery therefore run once — no
duplicate `OUTBOUND_MESSAGE` rows, no duplicate Meta sends, no duplicate
conversation state transitions. Any retried response still passes the
unchanged `aiResponseSchema` through the unchanged normalization engine.

## 4. Super Admin provider selection

- Model: `PlatformAiPolicy` singleton (`platform_ai_policies`) — already carries
  `primaryProvider`/`primaryModel`, `secondaryProvider`/`secondaryModel`,
  `fallbackEnabled`, `primarySecretRef`/`secondarySecretRef`. **No schema change
  was needed to add Atria.**
- Allowlist: `aiProviderValues` (`src/lib/validation/platform.ts`) is the single
  validation gate — `["openrouter", "agentrouter", "atria"]`. The Zod enum
  rejects any unlisted provider on write, and `toEffectivePolicy` re-validates the
  stored row before any caller trusts it (invalid row → fail-safe `null`).
- UI: `ai-policy-form.tsx` renders primary/secondary `<Select>` dropdowns from
  `AI_PROVIDER_OPTIONS`, a model input, and the fallback checkbox. Selecting
  **Atria** is now available as both primary and secondary.
- Policy changes are DB-backed and apply at runtime (no redeploy). Changing an API
  _key_ is an environment change and requires redeploy.

## 5. Secret-reference handling

- A credential is referenced by **name** only. `secretRefFor(provider)` maps
  `atria → ATRIA_API_KEY`, `agentrouter → AGENTROUTER_API_KEY`,
  `openrouter → OPENROUTER_API_KEY`.
- The DB persists these **names**; `secretRefSchema` enforces `UPPER_SNAKE_CASE`
  so a raw key value can never be stored as config.
- The adapter resolves the value at call time via `getEnvVar(secretRef)`; the value
  is never logged, never placed in telemetry (verified by `pnpm check:ai-provider`),
  and never exposed to the client. The UI shows the reference **name** only.
- Local: `.env.local`; production: Vercel Environment Variables.

## 6. Provider-neutral conversation-engine contract

The engine depends only on `ConversationAi.respond(AiRequest) → AiResponse` and
the orchestrator's telemetry (`provider`/`model`/tokens/latency/fallback). It is
unaware of endpoints, headers, or vendor names. Provider output is re-validated by
`parseAiResponse` (Zod) before anything is persisted; unknown keys such as
`reasoning` are stripped at the boundary.

## 7. Adding or removing a provider later

Adding (Atria is the worked example):

1. `src/lib/validation/platform.ts` — append the id to `aiProviderValues`.
2. `src/server/integrations/ai/types.ts` — add the id to the `AiProviderId` union.
3. `src/server/integrations/ai/<provider>.ts` — new adapter: endpoint constant,
   `SECRET_REF`, timeout, and a factory over `callOpenAiCompatible`.
4. `src/server/integrations/ai/factory.ts` — one branch in `adapterForProvider` +
   the `endpointOverrides` key.
5. `src/features/platform/server/provider-labels.ts` — display label +
   `secretRefFor` branch.
6. `.env.example` + `docs/ENVIRONMENT_VARIABLES.md` — document the secret name.
7. `scripts/check-ai-provider.ts` — adapter/factory/isolation coverage.

No engine, booking, WhatsApp, or Meta change is ever required. Removing a provider
is the reverse: drop the allowlist entry and the factory branch (the adapter file
can stay dormant). Neither operation touches the prompt boundary.

## 8. Conversation Control Layer (provider-agnostic policy)

`src/server/integrations/ai/conversation-control/` owns the conversation-level
policy that used to live inside the Atria adapter
(`PROMPT-OPS-CONVERSATION-CONTROL-RETRY-HANDOFF-15`). It sits ABOVE one
`AiProviderAdapter` and BELOW the orchestrator / engine:

```
Conversation Engine → ConversationAi → orchestrator
                                            ↓ primary
                                   Conversation Control (retry/handoff/notify)
                                            ↓ ONE attempt
                                   AiProviderAdapter (atria | openrouter | agentrouter)
                                            ↓ AiProviderResult (structured, normalized)
```

Boundary contract — the layer depends only on the `AiProviderAdapter`
interface. It never imports `atria.ts` / `openrouter.ts` / `agentrouter.ts`,
never inspects raw provider JSON, and contains **no provider-specific
branching** (verified by `pnpm check:conversation-control`, check P2a).

| File                      | Responsibility                                                                    |
| ------------------------- | --------------------------------------------------------------------------------- |
| `types.ts`                | Handoff-reason taxonomy, retry decision, notification events/config, turn outcome |
| `retry-policy.ts`         | Bounded retry: `NO_RETRY` / `RETRY` / `EXHAUSTED` + hard ceiling                  |
| `handoff-policy.ts`       | Failure → handoff reason mapping + the ONE customer-facing message seam           |
| `notification-policy.ts`  | Sanitized payloads + typed `NotificationSink` + dedupe                            |
| `settings.ts`             | Account-level config seam + safe defaults + future admin integration point        |
| `conversation-control.ts` | `executeTurn` — one logical turn over one adapter                                 |
| `index.ts`                | Public surface                                                                    |

- **Retry** — `MAX_ATTEMPTS_HARD_CEILING = 2` (one attempt + one retry). Only
  `TIMEOUT` is retryable (the single evidence-based class). `AUTH_FAILURE` /
  `PROVIDER_HTTP_ERROR` / `INVALID_RESPONSE` / configuration and credential
  errors never retry. A config value or `CONVERSATION_CONTROL_MAX_ATTEMPTS` env
  can only LOWER the bound, never raise it. An optional caller-supplied deadline
  skips a retry the route budget cannot host; absent a deadline, the previous
  default route budget is preserved (no new global timeout system).
- **Handoff** — reasons: `CUSTOMER_REQUESTED_HUMAN`, `AI_REQUESTED_HANDOFF`,
  `RETRY_EXHAUSTED`, `PROVIDER_UNAVAILABLE`, `QUOTA_EXHAUSTED`,
  `AUTH_OR_CONFIGURATION_FAILURE`, `UNSUPPORTED_REQUEST`,
  `SENSITIVE_OR_RESTRICTED_REQUEST`. AI-requested handoff is read straight off
  the EXISTING contract (`handoff` / `booking_handoff` actions) — no schema
  change, no new AI actions. The engine remains the executor of the actual
  state transition; this layer is authoritative for the DECISION.
- **Customer message seam** — `HANDOFF_MESSAGES` is the single place a
  handoff is phrased. A turn already in `NEED_HUMAN` does not re-execute the
  provider and does not re-send a handoff message.
- **Notifications** — `HUMAN_HANDOFF_REQUESTED`, `AI_UNAVAILABLE`,
  `AI_RETRY_EXHAUSTED`, `AI_QUOTA_EXHAUSTED`, `AI_CONFIGURATION_FAILURE`.
  Payloads carry only references/classifications/counters/timestamps — never
  keys, headers, `DATABASE_URL`, raw model responses, or customer content.
  Deduplicated per (event, conversation, turn).
- **Account settings** — `ConversationControlConfig` + `NotificationConfig`
  with safe defaults. Persistence/UI is a future integration point (one
  optional column + a nested Zod object); the seam requires no change then.

Because the layer implements `AiProviderAdapter` (`call` → the single final
result), the orchestrator and engine are unchanged in behaviour — only the
optional `retryTrace` / `conversationControl` observability fields are added.
Swapping Atria for OpenRouter or AgentRouter requires NO retry/handoff/
notification change: the same policy wraps all three.
