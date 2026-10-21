# FlowPilot — AI Architecture & Prompt Boundary

> **Target architecture (design only, NOT implemented):**
> `docs/ai/TARGET_ARCHITECTURE.md` records the evidence-based next-generation
> design from the EVAL-04/04B/04C baselines (multi-intent goals, first-class
> CLARIFY, explicit handoff causes, structured Conversation State, task-aware
> knowledge exposure, optional JEV strategy, zero-or-one-inference invariant,
> migration slices). This file remains the **current** boundary truth.
>
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
> provider), DECISIONS #59 (`codecraft` added as a Discovery provider,
> isolated and independently removable — see `docs/ai/PROVIDERS.md`). The
> engine default is the **policy-backed** `ConversationAi`
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
    codecraft adapter            ◀── selectable — Discovery (see PROVIDERS.md)
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
- **Relocation is not a semantic change.** The compile rule (drop blank and
  `#`-comment lines, trim, join with a single space) was chosen so a
  multi-line `.prompt` file compiles to the exact string the legacy
  `[...lines].join(" ")` TypeScript constants produced. When the workspace
  was introduced this was _proven_, not assumed: both bodies were extracted
  from the pre-refactor release and compared character-for-character against
  the compiled `.prompt` output (identical — 1065 and 396 chars). The
  architectural guarantee it establishes is that a prompt edit is the ONLY
  way to change LLM behavior — moving, reformatting, or regenerating prompt
  text never does. A semantic change (priority, constraint, extraction
  shape, handoff reason) requires a **new prompt id**, not an in-place
  rewrite of a shipped one.
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
  optional `providerPreference` + optional `availability[]` (≤14 × ≤50 slots) +
  optional `assistantStyle` (a bounded Arabic phrasing directive — DECISIONS #62) +
  optional `businessAbout` and per-service optional `price`/`description`
  (task-gated Slice-6 channels — PROMPT-AI-ARCH-13/-15; absent on unrelated
  turns) + optional `businessAddress` (a task-gated contact/identity/location
  channel — PROMPT-AI-OPS-21; absent on unrelated turns, never invented) +
  optional `temporalContext` (CORE-03B1 server-derived turn reference: `referenceInstant`,
  `timeZone`, and `localDate` — never accepted from customer prose).
  Never the whole DB, never complete history.
- **Response — `AiResponse` (`aiResponseSchema`):** `intent` (fixed family) +
  `action` (`reply` | `handoff` | `booking_handoff`) + `content` (1–4096, already
  phrased) + `extraction` (service/provider/date/timePreference — facts only) +
  `handoffReason` (required for `handoff`) + `summary` (required for
  `booking_handoff`). Unknown keys (provider `reasoning` / chain-of-thought)
  are **stripped** by Zod in `parseAiResponse` and never persisted downstream.
- **Enums — code truth:** `aiIntentValues = GREETING | FAQ | BOOKING |
AVAILABILITY | RESCHEDULE | CANCELLATION | HUMAN_REQUEST | AMBIGUOUS`;
  `handoffReasonValues = HUMAN_REQUEST | SENSITIVE | NO_KNOWLEDGE | AMBIGUOUS`
  (`ai-contract.ts`).
- **GREETING (DECISIONS #61) — the one knowledge-free intent:** a pure Arabic
  social opening («السلام عليكم»، «أهلاً»، «صباح الخير»، «ازيك») is classified
  **deterministically** in `classifyCustomerMessage` / `bypassDeterministicAi`
  and answered with a FIXED acknowledgment that stays `AI_ACTIVE`. It crosses
  the disclosure boundary by its declared intent (`KNOWLEDGE_FREE_REPLY_INTENTS`
  — a closed, exhaustive list) and never by a fact the assistant was given.
  It is `action: reply` + `intent: GREETING`, so the turn needs **no LLM call**
  and **no `AI_TURN` usage fact**.
- **Bypass — `bypassDeterministicAi(AiRequest)`:** returns a complete `AiResponse`
  when the turn is decidable without any provider (today: a pure Arabic greeting →
  `GREETING`, and too-short → `AMBIGUOUS`).
  The engine consults it **before** `ConversationAi.respond`, so those turns emit
  no `AI_TURN` telemetry. The bypass is part of the prompt boundary — future
  adapters inherit it.
- **JEV decision strategy (PROMPT-AI-ARCH-17 — Slice 8) — OPTIONAL, behind the
  gateway:** `src/server/integrations/ai/jev-strategy.ts` defines a bounded
  decision (`mode: DETERMINISTIC | GENERATIVE` + a closed `reason`) and the ONE
  conservative strategy; the gateway (`orchestrator.ts`, which owns the
  ONE-generative-call budget) consults it optionally — a `DETERMINISTIC` decision
  terminates with zero provider attempts, a `GENERATIVE` decision falls through to
  the gateway's single existing call. The strategy never calls a model and never
  executes domain truth; its deterministic set is EXACTLY the already-proven
  `bypassDeterministicAi` evidence (no new deterministic behaviour). The decision
  is provider-neutral and rides only on sanitized telemetry/turn observability
  (`AiTelemetry.jevDecision` / `TurnObservability.jev`) — never customer-visible.
- **Assistant voice (DECISIONS #62) — `assistantStyle`, phrasing only:** the
  assistant's tone/register/language/emoji/role live in ONE structured module
  (`src/features/conversations/server/assistant-style.ts`) as validated closed-enum
  values with a single resident default, NOT in the prompt body and NOT in a
  per-provider prompt copy (DECISIONS #43/#48 keep prompt bodies Git-only and
  forbid a prompt editor UI). The context builder embeds the rendered directive
  into `AiRequest.assistantStyle`, and `buildPromptMessages` renders it into the
  shared user-context block — exactly like `businessName` ("for phrasing only").
  It is provider-neutral and channel-agnostic by construction (the module imports
  no adapter, names no provider, names no channel), so swapping providers — or
  adding a future Telegram inbound — needs **no style rewrite**. It can never
  override disclosure or safety: the disclosure gate never reads it (its input
  type has no style field), the closed `KNOWLEDGE_FREE_REPLY_INTENTS` list cannot
  be widened by it, and the directive expressly forbids claiming to be human.
  Per-business persistence (one nullable column + a nested Zod object) is a
  deferred domain decision pending pilot evidence — **no migration, no UI today**.

### Semantic & Temporal Capability Boundaries (CORE-03B1)

A precise, code-backed distinction between the current pipeline capabilities:

1. **Mechanical Numeric & Protocol Handling (Zero-Model)**:
   - Evaluated by `interpretOfferReply` and executed by `completeBookingSelection` (`src/features/conversations/server/booking-selection.ts`).
   - Resolves structured callback tokens (e.g. `opt_2`) and exact numeric choices in Arabic or English digits (`"١"`, `"1"`) deterministically against active state offers. Spends exactly zero model network attempts.

2. **JEV Bounded Semantic Output & Limitations**:
   - Implemented in `src/server/integrations/ai/jev-semantic-strategy.ts` (`buildSemanticRequest`, `evaluateSemanticReading`, `semanticResponse`).
   - JEV evaluates a closed set of 11 atomic Noul routing questions plus 1 choice goal (`conversationGoal`).
   - JEV's wire request schema (`JevState` in `src/server/integrations/ai/jev-decisions-provider.ts`) does not consume temporal context.
   - Crucially, `semanticResponse` derives fact extraction solely by delegating to the lexical baseline (`classifyCustomerMessage` and `extractServiceFacts` in `src/features/conversations/server/conversation-ai.ts`). JEV itself does **not** extract dates, interpret relative dates, or produce rich `factUpdates` (`operation: "set" | "remove"`). Receiving temporal context or state does not give JEV arbitrary extraction capability.

3. **Generative Structured-Output Contract**:
   - Implemented across `createOpenRouterAdapter` (`src/server/integrations/ai/openrouter.ts`), `buildPromptMessages` (`src/server/integrations/ai/prompt.ts`), and the system prompt (`prompts/system/booking-assistant.prompt`).
   - Carries structured conversation context (`conversationContext`) and server-derived temporal context (`temporalContext`: `referenceInstant`, `timeZone`, `localDate`). Instructed to emit schema-compliant `AiResponse` JSON containing bounded `extraction` and explicit `factUpdates` (`key: enum[service,date,timePreference,provider]`, `operation: enum[set,remove]`).
   - Domain validation and reconciliation (`reconcileTurnSemanticFacts` in `src/features/conversations/server/semantic-facts.ts`) enforce canonical precedence and validation over these updates.

4. **Server-Derived Temporal Reference**:
   - Assembled by `buildAiContext` (`src/features/conversations/server/ai-context-builder/context-builder.ts`) using `buildAiTemporalContext` (`src/features/conversations/server/temporal-context.ts`).
   - Derived strictly from the canonical turn clock (`inbound.receivedAt` / `now`) and business timezone (`todayIsoInTimeZone` in `src/features/conversations/server/temporal-context.ts`).
   - Customer messages claiming alternative dates or timezones cannot overwrite this server-derived anchor.

5. **Live Model Adherence & Verification Boundary**:
   - Automated offline regression suites mock all provider network boundaries and verify serialization, schema compliance, and downstream state reconciliation.
   - They do **not** measure live model adherence, multilingual prompt quality, or dialect understanding in production. Live model quality remains unverified in this offline slice.
   - The architecture is not yet dictionary-free: legacy lexical helpers (`classifyCustomerMessage`, regexes, Arabic date vocabulary in `relative-date.ts`) remain active as technical debt for subsequent slices.

### Additive decision shape + turn observability (PROMPT-AI-ARCH-02 — Slice 0)

The implemented ground floor for the target AI architecture
(`docs/ai/TARGET_ARCHITECTURE.md §17 Slice 0`). It is **additive only**: no
current producer sets the new fields, no current consumer is required to read
them, and no customer-visible behavior changes.

- **Additive response fields — `aiResponseSchema`** (all optional): `goals[]`
  (`{ kind: ANSWER | CLARIFY | DOMAIN_ACTION | HANDOFF, intent?,
requiredKnowledge?, domainAction?, priority?, continueAfter? }`),
  `clarification?` (`{ type, missingFacts? }`), `handoffCause?`, and
  `factUpdates[]` (`{ key, value, isRevision? }`). The descriptive labels are
  bounded strings — the final production enums land in later slices
  (TARGET_ARCHITECTURE §7/§8/§20), so no evaluation-only vocabulary is copied
  into production. `aiIntentValues` / `aiActionValues` / `handoffReasonValues`
  are untouched.
- **Single-goal synthesis bridge — `synthesizeDecisionGoals` /
  `synthesizeTurnPlan`**: a decision with no `goals` is treated as exactly one
  goal derived from the existing `intent` + `action` (`reply` → `ANSWER`,
  booking-family reply → `DOMAIN_ACTION`, `booking_handoff` → `DOMAIN_ACTION`,
  `handoff` → `HANDOFF`). There remains ONE canonical decision representation;
  a `TurnPlan` is an ordered list of the SAME goals, never a second model.
- **Turn observability — `ai-observability.ts` + `InboundSuccess.observability?`**:
  a pure, optional projection of a finished turn (`routingDecision`, `goals[]`,
  `turnPlan`, `clarification`, `handoffCause`, `factUpdates`,
  `knowledgeSourceClass` from the B-02 ledger, provider/model,
  fallback/retry/latency). It adds **no model call, no persistence, no
  behavior**, and carries machine keys / bounded contract labels only — never
  content, prompts, secrets, or chain-of-thought.
- **Guards:** `pnpm check:ai-architecture` (offline) — old-contract
  compatibility, new-field round-trip/bounds, the synthesis bridge,
  representative engine-flow parity (greeting, FAQ, human handoff, booking,
  availability), observability content-freeness, the zero-or-one generative
  call invariant, and one-schema / one-provider guards. The evaluation boundary
  surfaces the same observables additively through `ActualOutcome`'s optional /
  `.passthrough()` members.

### Turn evidence / observability seam (PROMPT-AI-OPS-22)

The Slice-0 `TurnObservability` record above is computed on every turn but —
before OPS-22 — was returned on `InboundSuccess.observability` and discarded by
the webhook callers. OPS-22 makes the record **emitted, bounded, and
forensically usable** without changing any decision:

```
inbound.receive → business.resolve → conversation.load → turn.plan →
context.build → ai.call → ai.parse → domain.resolve → disclosure.evaluate →
handoff/response.finalize → outbound.send     (one trace id per turn)
        ↓  (AFTER persist + send, off the critical path)
buildTurnEvidence  (pure, content-free projection)
        ↓
emitTurnEvidence   (fail-open sink)
        ↓
structured JSON line → EXISTING Vercel/runtime logs → optional OTLP sink
```

- **Record — `flowpilot.turn.evidence@v1`** (`src/features/conversations/
server/turn-evidence.ts`): bounded machine-safe fields only —
  `environment`, `appVersion`, `traceId`, `conversationId`, `businessId`,
  `customerMessageId`, `intent`, `assistantAction`, `conversationStatus`,
  `handoffCause`, `routingDecision`, `taskRelevance[]`, `contextChannels`
  (`servicesCount`, `addressPresent`, `aboutPresent`, `faqPresent`,
  `pricePresent`, `availabilityPresent`), `knowledgeSourceClass[]`, `provider`,
  `model`, `providerAttempts`, `providerStatus`, `providerLatencyMs`,
  `parseSuccess`, `disclosureChannel`, `disclosureAllowed`,
  `disclosureRefusalReason`, `knowledgeGapCategory`, `finalOutcome`,
  `outboundSendAttempted`, `outboundSendDelivered`, `emittedAt`.
  **Never** customer message text, phone numbers, keys/tokens/secretRefs,
  prompts, chain-of-thought, raw provider payloads, or PII. A structural
  content-freeness guard is exported and asserted by the deterministic check.
- **Sink — `src/lib/observability/turn-telemetry.ts`:** ONE structured JSON
  line (`msg:"flowpilot.turn.evidence"`) to the existing runtime logs, plus an
  OPTIONAL OTLP/HTTP-JSON exporter implemented with platform `fetch` (no
  `@opentelemetry/*` dependency on the customer path), gated entirely by env
  (`TURN_EVIDENCE_DISABLED` · `OTEL_TURN_EVIDENCE_ENABLED` ·
  `OTEL_EXPORTER_OTLP_ENDPOINT`). No new database or table.
- **Fail-open (binding):** emission happens at the EXISTING single
  `receiveInboundMessage` choke point, strictly AFTER the reply was persisted +
  sent, inside a total `try/catch`. A missing, disabled, or throwing sink
  leaves the turn byte-identical — telemetry can never block, retry, or alter a
  customer turn, and no telemetry dependency sits on the critical path. The
  engine dep `turnTelemetry` is OPTIONAL (same convention as
  `attentionRepository` / `knowledgeGapRepository`); offline harnesses omit it.
- **Disclosure observation:** `disclosure.channel` is the ledger family that
  actually backed a disclosed reply (`business.faqs`, `business.address`,
  `service.name`, …), `routing-action` when the turn's output is a routing
  action (handoff / booking_handoff, which discloses no knowledge), or the
  primary family a refused self-authored reply needed; `disclosureAllowed` is
  the gate verdict and `disclosureRefusalReason` the typed refusal when the
  gate refused. The gate itself is UNCHANGED — OPS-22 only records its verdict.
- **Invariants preserved:** one generative call max, no second
  inference/resolver/state/planner/classifier, no prompt/schema/migration
  change, no change to routing/context/disclosure/booking/handoff precedence.

Guard: `pnpm check:turn-evidence` (offline, in-memory, no DB/network/LLM/
secrets — including a non-destructive replay of the two observed live questions
against the real pilot data shape with a healthy provider, both → DISCLOSED).

## Context budget (minimal prompt context)

The engine's `AiRequest` is the **prompt context** — nothing larger is sent.
Since PROMPT-B02 the Context Builder (`src/features/conversations/server/ai-context-builder/`)
assembles it from the sources the engine already loaded (see the AI context
builder section below):

- Task-relevant facts only: `services` / `faqs` / provider preference /
  already-resolved `availability` — not every customer, not every appointment.
- Bounded history: `recentMessages` ≤ 20; relevance ordering is engine-side
  (`conversation-engine.ts` takes the most recent ≤20 in chronological order).
- Compact state: `conversationStatus` only — full DB/business context never sent.
- Tenancy is engine-side (`Business` resolved from receiving WhatsApp number;
  conversation scoped to `businessId` + `branchId`) — the LLM never resolves
  tenancy, and the builder only RECORDS the engine's resolution as provenance.

## Knowledge visibility policy (PROMPT-B01 — binding)

The context budget says how MUCH may reach the AI. The **knowledge
visibility policy** says WHAT is eligible to reach it at all, and —
separately — what the AI may then mention to a customer. It lives in
`src/lib/ai-knowledge-visibility/` and is consumed by the Context Builder
(B-02, implemented). B-01 is the policy only: no context aggregation, no
prompt assembly, no LLM call.

### The policy boundary (two distinct questions)

1. **"AI may know this"** — eligibility to enter the `AiRequest` context.
2. **"AI may mention this to the customer"** — permission to appear in a
   customer-facing reply.

These are NOT automatically identical. `INTERNAL` information may enter
AI context (the assistant may reason about it) yet must never be put in a
customer reply; `CONDITIONAL` information is only eligible/mentionable
when the current task makes it relevant. This is what allows internal and
conditional information to exist in the system without automatically
becoming customer-visible.

### The four levels

| Level         | AI may know?             | AI may mention?          | Examples                                                                                                                                                |
| ------------- | ------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC`      | yes, always              | yes, always              | business `name`/`about`, the `Business.faqs` store, service `name`/`description`, the customer's own message                                            |
| `CONDITIONAL` | yes — task-relevant only | yes — task-relevant only | `cancellationPolicy` (cancellation/reschedule asks), domain-computed `availability` (booking/availability asks), `providerPreference`, `whatsappNumber` |
| `INTERNAL`    | yes (inform reasoning)   | never                    | `workingHours`, `slotDurationMinutes`, `confirmationMode`, `conversationStatus`, discovery metadata (`vertical`/`city`), lifecycle timestamps           |
| `FORBIDDEN`   | never                    | never                    | see FORBIDDEN categories below                                                                                                                          |

- **`PUBLIC`** — facts that are safe for the AI to use and communicate to
  customers normally.
- **`CONDITIONAL`** — facts that are safe for the AI to use only when the
  conversational request or task makes them relevant; they must not
  automatically appear in normal responses. The relevance flag is
  supplied by the Context Builder from the turn's intent — **never by the
  AI itself**.
- **`INTERNAL`** — operational information that may be useful to
  FlowPilot's internal reasoning or future staff/operator tooling but
  must NOT be disclosed to customers by the AI. Service duration is the
  canonical case: the AI may know it (it is already in
  `AiRequest.services`), but its customer-facing behavior is decided by
  the later **B-03** policy, so it is `INTERNAL` here. Customers see
  outcome-oriented facts (domain-computed slots), not operational
  metadata.
- **`FORBIDDEN`** — must never enter AI context.

### FORBIDDEN categories (the minimum set — enumerated, never a scan)

`ACCESS_TOKEN` · `APP_SECRET` · `CREDENTIAL` · `ENCRYPTION_KEY` ·
`RAW_CREDENTIAL_MATERIAL` · `AUTHENTICATION_SECRET` · `SESSION_SECRET` ·
`INTERNAL_SECURITY_MATERIAL` · `PRIVATE_INFRASTRUCTURE_DATA` ·
`RAW_DATABASE_RECORD` · `HIDDEN_SYSTEM_PROMPT` ·
`INTERNAL_IMPLEMENTATION_INSTRUCTION` · `CROSS_TENANT_DATA` ·
`OUT_OF_SCOPE_PRIVATE_DATA`.

These map to concrete FlowPilot locations in `FORBIDDEN_FIELDS`
(`knowledge-visibility.ts`) — `WhatsAppConnection.credentialsRef`,
`RuntimeCredential.encryptedValue`, the `PlatformAiPolicy` `secretRef`s,
the credential-crypto key material, `process.env` secret values, the
account password hash, `Invitation.tokenHash`, session/token material,
the webhook verify token, raw non-task Prisma rows, another Business's
data, private data outside the current tenant/customer scope, any
injected hidden system prompt, and internal implementation instructions
surfaced as facts.

**Scope note (binding):** this policy governs KNOWLEDGE FACTS — the
candidates a Context Builder may put into `AiRequest`. It does NOT govern
the engine-wired system-instruction channel
(`prompts/system/booking-assistant.prompt`), which is the instruction
layer governed by the Prompt Workspace rules above and is never a
knowledge fact. `HIDDEN_SYSTEM_PROMPT` forbids a _second_, injected
prompt masquerading as knowledge — it does not touch the one canonical
system instruction.

**Not a redactor (binding):** the policy is STRUCTURAL — classification by
source + field + provenance + visibility. It is NOT broad redaction by
string matching and NOT an ad-hoc word blacklist. Forbidding is done by
classification and enrollment refusal, never by scanning a value's text.

### Provenance and tenant safety

Every candidate fact carries lightweight provenance
(`knowledge-provenance.ts`): `source` (where it came from), `businessId`
(the owning Business), and `visibility`. The Context Builder proves
tenant ownership, then DROPS provenance before composing the request —
provenance is builder-side metadata and is never rendered into prompt
content.

- **Tenant scope is always server-derived** (the engine resolves the
  Business from the receiving WhatsApp number; the knowledge service
  derives it from the authenticated actor). Client-provided `businessId`
  is never trusted, and **there is exactly ONE tenant-resolution
  mechanism** — the existing one. This policy only RECORDS its outcome.
- **AI context must never contain another Business's data.** A fact whose
  tenant ownership cannot be proven is excluded.
- When information conflicts, **the AI must never resolve
  business-authoritative conflicts itself** — the domain stays
  authoritative; the engine's existing handoff/`NEED_HUMAN` path is the
  resolution route. The most restrictive classification wins when a fact
  is reachable by several paths.

### Safe defaults (binding, enforced structurally by `enrollFact`)

- Visibility unknown → **DO NOT EXPOSE TO CUSTOMER** (default level
  `INTERNAL`; unknown fields classify to `INTERNAL`, never `PUBLIC`).
- Provenance missing → **EXCLUDE FROM AI CONTEXT** (`UNKNOWN_SOURCE`).
- Tenant ownership unproven → **EXCLUDE** (`UNPROVEN_TENANT`).
- A `FORBIDDEN` candidate → **refused outright**
  (`FORBIDDEN_BY_POLICY`) — forbidden material can never even be
  constructed as a context candidate.

### How B-02 consumes this (the contract the Context Builder satisfies)

```
classifyBusinessField / classifyServiceField / classifyConversationField
        ↓  (level per source+field; unknown ⇒ INTERNAL)
enrollFact({ source, businessId, visibility, value })
        ↓  (FORBIDDEN / unproven / unknown ⇒ typed exclusion, never a fact)
isWithinTenantScope(fact, { businessId })
        ↓  (cross-tenant ⇒ excluded)
isEligibleForAiContext(fact, { taskRelevant })   → "AI may know this?"
isDisclosable(fact, { taskRelevant })            → "AI may mention this?"
```

The one convenience entry point is `decideFact(...)`, which returns the
enrolled fact plus its `eligible` / `disclosable` verdicts and the typed
exclusion reason when enrollment is refused. `decideFact` performs NO
aggregation and NO prompt assembly — those belong to B-02
(`src/features/conversations/server/ai-context-builder/`, implemented).

### Files this policy reuses (never duplicated)

- `Business.faqs` — the ONE canonical knowledge store (DECISIONS #13).
  The policy CLASSIFIES the store (`PUBLIC`); it does not copy it, add a
  second store, or add per-entry metadata (the entry shape stays
  question/answer only).
- The existing tenant-resolution mechanism (`BusinessRepository`,
  resolved from the receiving WhatsApp number) — no second resolution
  path is created.
- The existing credential-reference boundary (`credentials-resolver.ts`):
  `credentialsRef` is a REFERENCE, never a value — the FORBIDDEN list
  records that boundary as policy.

Guard: `pnpm check:knowledge-visibility` (36/36, offline, in-memory, no
DB/network/secrets).

## AI context builder (PROMPT-B02 — binding)

The context budget says how MUCH reaches the AI; the visibility policy says
WHAT is eligible. The **context builder** makes that policy operational at
the actual AI boundary — it is the explicit seam between conversation
orchestration and the `AiRequest`:

```
conversation orchestration (conversation-engine.ts)
     ↓  server-derived tenant scope + structured source facts
CONTEXT BUILDER  (ai-context-builder/)
     ↓  policy-filtered, provenance dropped
AiRequest  (ai-contract.ts)
     ↓
AI Provider
```

It receives the sources the engine already loaded through the existing
repositories — the `Business` record, the service catalog, conversation
state, the customer message, and (when resolved) domain-computed
availability / a captured provider preference. It loads nothing itself:
there is still exactly ONE DB path and ONE tenant-resolution mechanism.

For every candidate it runs the B-01 pipeline (`classify*` → `enrollFact`
→ `isWithinTenantScope` → budget + task gate → `isEligibleForAiContext` /
`isDisclosable`), composes the minimal request, and DROPS provenance —
`businessId`, `source` and `visibility` are builder-side metadata and never
become prompt content.

### "AI may know this" ≠ "AI may mention this" (the output contract)

The builder's output carries BOTH questions, kept distinct:

- `request` — the provider-neutral `AiRequest`: only facts that passed the
  policy (what the AI **may know** this turn).
- `facts` — the **disclosure ledger**: every considered candidate with its
  `included` / `disclosable` verdicts and the typed reason when it did not
  enter. It is builder-side metadata (never prompt content, never sent to a
  provider); the B-03 disclosure gate (implemented,
  `src/features/conversations/server/ai-disclosure/`) enforces "AI may mention
  this" from it on the generic reply path.

An `INTERNAL` fact may enter context to inform reasoning yet must never be
put in a customer reply; a `CONDITIONAL` fact is only eligible/mentionable
when the current task makes it relevant. Relevance is derived by the builder
from the turn's text (`deriveTaskRelevance`) — never by the AI.

### Operational/internal facts are not forwarded merely because they exist

`workingHours`, `slotDurationMinutes`, `confirmationMode`, `timezone`, and
discovery metadata (`vertical`/`city`) are classified `INTERNAL` and
**omitted from the request** unless the current task genuinely requires
them. In particular:

- Service `durationMinutes` is not included merely because a service has a
  duration — it is `INTERNAL`, and its customer-facing behavior is decided
  by the later B-03 policy. Since PROMPT-B02 it is an OPTIONAL field of
  `serviceFactSchema` (backwards compatible): producers may still supply it,
  and the prompt renderer shows it only when present.
- Raw `workingHours` are never dumped into context — availability comes from
  the authoritative CORE-02 resolver and may enter only as the derived
  `DOMAIN_AVAILABILITY` result (`date` + `slots`), never as a schedule.
- The one documented `INTERNAL` dependency is `conversationStatus`: the
  assistant's phrasing task genuinely uses it, so it enters context — but it
  stays non-disclosable (`INTERNAL`).

### Fail-closed behavior (binding)

A fact with missing provenance (`UNKNOWN_SOURCE`), an unproven tenant
(`UNPROVEN_TENANT`), unknown visibility (`UNKNOWN_VISIBILITY`), or a
`FORBIDDEN` classification (`FORBIDDEN_BY_POLICY`) is excluded with a typed
reason — never guessed, never silently reinterpreted as public, and never
replaced by raw source content. An empty/blank tenant scope is unproven:
nothing enters context. The builder is pure and total — no I/O, no LLM, no
`process.env`, no Prisma, no credential; safety is structural (source +
field + provenance + visibility), never string redaction.

Guard: `pnpm check:ai-context-builder` (54/54, offline, in-memory, no
DB/network/LLM/secrets).

## Customer disclosure boundary (PROMPT-B03 — binding)

The visibility policy (B-01) states the rule and the context builder (B-02)
records the verdicts; the **disclosure gate** makes the boundary real at the
last moment before a reply becomes customer-visible:

```
AiResponse (validated by parseAiResponse)
     ↓
DISCLOSURE GATE   (ai-disclosure/)
     ↓
disclosed        → the existing reply path (persist + WhatsApp send)
requires-human   → the existing NEED_HUMAN / AI_HANDOFF fallback
```

It sits on the _generic reply path_ of `conversation-engine.ts`, immediately
before the assistant's text is persisted and sent. That is the only place
assistant-authored free text can reach a customer: booking/availability
intents are answered by the **domain** (`mapAiResponseToBookingInput` →
CORE-01/CORE-02) with domain-authored messages, which never cross this gate.

The gate consumes the disclosure ledger; it never re-classifies a field,
never re-resolves tenant scope, and never re-derives task relevance. There is
still exactly one policy (B-01), one builder (B-02) and one tenant-resolution
mechanism (the engine's server-derived scope).

### Structural, not textual (binding)

The decision is made from the structured `AiResponse` (its `action` and
`intent`) plus the ledger's typed per-fact verdicts. It never inspects,
scores, or rewrites reply text — there is no word blacklist, no regex
redaction and no leak detector. The gate is not an LLM and not a judge: it
cannot invent, infer, or rephrase anything. It can only refuse to emit and
defer to a human. A refused reply is dropped wholesale — never persisted,
never sent.

- A **routing action** (`handoff` / `booking_handoff`) IS the fallback
  channel. It discloses no knowledge, so the gate passes it through and the
  existing handoff semantics own the outcome. The AI-first default and the
  human fallback both stay exactly as designed.
- A **self-authored reply** (`action: "reply"`) is emitted only when its
  declared task is backed by a ledger fact that is `included` AND
  `disclosable` AND actually carried in the request:

  | Intent                        | Support family (ledger key)                                                                                                                                                                                                                  | Request channel                                              |
  | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
  | `GREETING`                    | **none — knowledge-free social protocol**                                                                                                                                                                                                    | n/a (passed by declared intent)                              |
  | `FAQ`                         | `business.faqs` (PUBLIC as a whole) **or** a task-gated channel actually carried this turn (`service.price` · `business.about` · `business.address` · `service.description` — Slice 6 / PROMPT-AI-OPS-21; `service.name` — PROMPT-AI-OPS-20) | `request.faqs` non-empty **or** the matching carried channel |
  | `BOOKING` / `AVAILABILITY`    | `domain.availability` (CONDITIONAL)                                                                                                                                                                                                          | `request.availability` non-empty                             |
  | `CANCELLATION` / `RESCHEDULE` | `business.cancellationPolicy` (CONDITIONAL)                                                                                                                                                                                                  | **none today** ⇒ always routed to staff                      |
  | `HUMAN_REQUEST` / `AMBIGUOUS` | none — routing intents                                                                                                                                                                                                                       | n/a                                                          |

  Consequences: an `INTERNAL` fact is never disclosable (B-01), so it can
  never back a reply; a `CONDITIONAL` fact is disclosable only when B-02
  found the task relevant; a `FORBIDDEN` fact is never even enrolled; and a
  reply backed by nothing would have to be invented — it is routed to a human
  instead.

  **Service-catalog name channel (PROMPT-AI-OPS-20).** A service `name` is
  `PUBLIC` and B-02 **always** carries the catalog in `AiRequest.services`
  (the model needs it for booking/discovery), so a services-list question
  ("ايه الخدمات اللي عندكم؟") is genuinely answerable from carried facts.
  The gate's FAQ candidates therefore also include the aggregate
  `service.name` family with the `serviceNames` channel (`request.services`
  non-empty). The family is armed **only on a catalog-listing turn** — B-02
  derives a `serviceCatalog` relevance family (the same budget-gate pattern
  `service.description` uses with `serviceInfo`) — so on a location / hours /
  about / price turn the names stay in the base catalog but cannot back a
  self-authored reply. The disclosure backstop is therefore unchanged for
  non-catalog questions: an invented location or hours answer is still
  refused even though the catalog is carried. The channel licenses mentioning
  the CATALOG ONLY — never a price, location, hour or detail, each of which
  still requires its own carried channel.

### Typed refusal decisions

`disclosed` or `requires-human`, with a typed reason for diagnostics
(operators/logs only — never customer-visible; the customer sees the existing
human-handoff experience and no policy name, provenance, or classification is
ever surfaced):

- `FORBIDDEN_FACT_IN_CONTEXT` — a FORBIDDEN fact marked included. Impossible
  by construction (B-01 refuses at enrollment); observed only if a deeper
  invariant broke, so the gate fails closed.
- `NOT_DISCLOSABLE` — included but unmentionable (`INTERNAL`, or a
  `CONDITIONAL` fact outside its task).
- `EXCLUDED_FROM_CONTEXT` — the family was refused at enrollment or omitted
  by the builder (including missing provenance / unproven tenant / empty
  scope); there is no knowledge behind the reply.
- `UNAVAILABLE_IN_REQUEST` — disclosable in principle but the request carries
  no data for it (an empty knowledge store, or a family with no request
  channel today).

Guard: `pnpm check:ai-disclosure` (41/41, offline, in-memory, no
DB/network/LLM/secrets — including end-to-end engine runs that prove an AI
failure and a refused reply take the same `NEED_HUMAN` / `AI_HANDOFF` path,
and that a refused reply is neither persisted nor sent).

### Operational facts and the deferred CONDITIONAL channels (product state)

`workingHours`, `slotDurationMinutes`, `confirmationMode`, `timezone`,
`vertical`, `city` and service `durationMinutes` are `INTERNAL`: they may
inform reasoning where the architecture explicitly allows, but they can never
back a customer reply. In particular **service duration is not disclosed
merely because the service record contains it** — the customer sees
domain-computed outcomes (available slots), never operational metadata.

`cancellationPolicy` and `whatsappNumber` are classified `CONDITIONAL` and
ledgered by B-02, but they carry **no `AiRequest` channel today**. Evidence
does not yet justify wiring them: the current assistant routes
cancellation/reschedule asks to staff (`booking_handoff`) with fixed, safe
messages and never uses the policy text, and there is no contact/identity
intent in the fixed family. Until a later product slice wires a channel AND
its task-relevance rule, the boundary keeps these tasks on the human path by
construction (`UNAVAILABLE_IN_REQUEST`). No catalog redesign, no new UX.

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
- `src/features/conversations/server/ai-context-builder/` — the B-02 context builder (assembles the policy-filtered `AiRequest`; disclosure ledger)
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
├─ atria adapter (selectable — see docs/ai/PROVIDERS.md)
├─ codecraft adapter (selectable — Discovery; see docs/ai/PROVIDERS.md)
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
