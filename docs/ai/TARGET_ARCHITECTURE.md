# FlowPilot — Target AI Architecture (Design Only)

> **Status: DESIGN + ARCHITECTURE DECISION ONLY — NOT IMPLEMENTED.**
> Slice `PROMPT-AI-ARCH-01`. This document records a target architecture
> derived from the completed Egyptian evaluation program (EVAL-04,
> EVAL-04B, EVAL-04C) and from the current repository. It changes **no**
> production source, prompt, schema, migration, provider policy, or runtime
> behavior. Nothing here is built. The migration plan (§17) is the work
> queue for later, independently-reviewable slices.
>
> Current-boundary truth remains `docs/ai/ARCHITECTURE.md`,
> `docs/ARCHITECTURE.md → Responsibility Separation`, and the code. Where
> this design and the code conflict, the code wins until a slice
> deliberately changes it.

---

## 0. Evidence base (what this design is built from)

Primary evidence, all over the identical `egyptian-v1` dataset
(hash `8be16297ae4717bab5da4f3c94de1887`) and the unchanged EVAL-03 scoring
engine:

| Subject                            | Artifact                                              | Headline evidence used here                                                                                                                                                                                                                                                                                  |
| ---------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Deterministic classifier (offline) | `evaluation/reports/egyptian-v1/baseline/BASELINE.md` | unnecessary handoff **85.6%** (530/619); multi-intent success **47.6%**; booking-state **35.5%**; `SERVICE_DISCOVERY` handed off **124/124**; 5 genuine missed handoffs (all one clitic root cause); 0 fabrication; 0 safety violations on genuine cases                                                     |
| CodeCraft / DeepSeek real LLM      | `.../real-llm-baseline/BASELINE.md` + `COMPARISON.md` | unnecessary handoff **48.1%**; multi-intent **56.9%** (80.2% still hand off); knowledge **93.1%**; `NOT_EXPOSED` drives knowledge FAILs; p50 latency ≈10.5 s, p95 inflated by retry; booking-verb→forced-handoff on `mi-booking-plus-discovery` **17/20**; balance outage with no fallback = total AI outage |
| Atria real LLM                     | `.../atria-baseline/BASELINE.md` + `COMPARISON.md`    | unnecessary handoff **45.4%**; multi-intent **56.6%**; knowledge **91.2%**; fabrication **24**; p50 ≈30.6 s vs a 16 s production cap (48/62 calibration turns TIMEOUT); 90.8% identical verdicts to CodeCraft; every failure category exists in both runs                                                    |

Structural findings this design acts on (each is evidence-backed, not
assumed):

1. **The failure surface is contract/policy-shaped, not model-shaped.**
   Atria and CodeCraft agree on 1719/1893 verdicts (90.8%); all eight
   failure categories appear in both at comparable rates; deltas are within
   ±3pp on 18/19 metrics. Swapping models does not fix the seam.
2. **The current contract can express exactly one intent and one action
   per turn** (`ai-contract.ts`: `aiIntentValues`, `aiActionValues =
["reply","handoff","booking_handoff"]`). The dominant unnecessary-handoff
   driver is a booking verb co-occurring with a knowledge question
   (`mi-booking-plus-discovery`: Atria 14/20, CodeCraft 17/20) while pure
   discovery answers fine (Atria 0/8 and 0/20). "Answer the question AND
   continue the booking" is unrepresentable.
3. **CLARIFY does not exist**, so ambiguity escalates (LLM ambiguous turns
   hand off ~94.5%; clarification accuracy ~54%). The base code's only
   non-reply actions are handoff variants (`classifyCustomerMessage`).
4. **Handoff causes are collapsed.** The engine maps AI failure, disclosure
   refusal, provider failure, and genuine handoff all to `NEED_HUMAN`
   (`conversation-engine.ts` §9 fail-safe, §9d disclosure refusal). The
   evaluation layer already separates them (`handoffOutcomeClassValues`:
   `TRUE_HUMAN_REQUIRED` / `UNNECESSARY_HUMAN_HANDOFF` / `PROVIDER_FAILURE`
   / `AI_FAILURE` / `KNOWLEDGE_GAP` / `AMBIGUITY` / `NO_HANDOFF`) — but the
   production contract cannot report the distinction.
5. **The turn is stateless per request.** The engine sends
   `recentMessages ≤ 20` + `conversationStatus`; the only "state" is the
   deterministic booking-selection seam re-parsing the last offer from
   message text (`tryParseBookingSelection`). Booking-state accuracy is
   35.5%/48.0%/48.9% (det/CC/Atria); corrections (`jt-revise-date` 14/14
   FAIL) and context returns (`re-long-context-topic-return` 10/10 FAIL)
   show the cost.
6. **Knowledge failures are exposure + matching, not retrieval.** With a
   real LLM reading the FAQ store directly, `PARAPHRASED_FAQ` FAILs drop to
   0 (Atria and CodeCraft); the residual knowledge FAILs are `NOT_EXPOSED`
   (Atria 19, CC 14), plus catalog/price/service-detail asks with no
   request channel or answering intent. This is direct evidence **against**
   adding embeddings/RAG now.
7. **Latency is a provider-selection property, not a model-quality one.**
   Atria's p50 ≈30 s blows the 16 s production per-attempt cap; the
   measurement required an eval-only 45 s override. The architecture must
   keep provider latency policy outside the engine.
8. **Strengths to preserve:** 0 fabrication on the deterministic path,
   0 malformed outputs across all three subjects, tenant/secret boundaries
   hold, disclosure gate is structural, required-handoff recall is high
   (97.7% det; 91.3%/90.4% LLM), and the LLM paths cut unnecessary handoff
   by ~37–40pp.
9. **The evaluation layer already models the target.** `taxonomy.ts` has
   `HandoffOutcomeClass`, `ClarificationType`, `ExpectedDomainAction`,
   `BookingJourneyState`, and `SystemIdentity` (with `routerVersion` /
   `contextBuilderVersion`). The target production model should converge on
   that vocabulary rather than invent a parallel one.

---

## 1. Mandatory principles (preserved verbatim in the design)

```
AI interprets → Domain decides and executes → Conversation Engine orchestrates
```

- **AI MUST NOT** query Prisma, mutate appointments, decide authoritative
  availability, invent slots, bypass tenant scoping, expose chain-of-thought,
  or become the source of truth for domain state.
- **Tenant isolation** stays server-resolved; **secrets** stay
  reference-by-name (`secretRef`), never in context, prompts, or telemetry.
- Exactly **ONE Conversation Engine**, **ONE availability authority**
  (CORE-01/CORE-02), **ONE booking state model**, **ONE knowledge store**
  (`Business.faqs` + service catalog), **ONE disclosure policy** (B-01/B-02/B-03).
- No speculative infrastructure: no vector DB, no RAG, no event bus, no
  queue infrastructure, no second state machine, no microservices. The only
  async boundary is a best-effort in-process/append-only knowledge-gap
  signal (design §12), and it never blocks a customer turn.

---

## 2. Target architecture diagram

```
Channel transport (WhatsApp / Telegram)                    [unchanged]
        │  NormalizedInboundTransportMessage (tenant resolved server-side)
        ▼
┌─────────────────────────── CONVERSATION ENGINE (ONE) ────────────────────────────┐
│ 1. Inbound Turn Intake        resolve tenant · claim idempotency key ·          │
│                               persist customer message · load bounded context   │
│                               [existing conversation-engine.ts, unchanged]      │
│                                                                                 │
│ 2. Turn Analysis (deterministic, pure)                                          │
│       normalizeArabicText · classify signals · selection parse ·                │
│       task relevance · deterministic-turn candidates                            │
│       [generalizes bypassDeterministicAi + tryParseBookingSelection]            │
│                                   │                                             │
│ 3. Deterministic Resolution       │ fully decidable turn ──▶ TurnPlan ──▶ persist│
│       (greeting / selection / safe handoff; no model call)  [goto 9/12]         │
│                                   │ not decidable                               │
│ 4. Conversation State             │ load/derive structured state (owned HERE)   │
│                                   ▼                                             │
│ 5. Context Planner ──▶ Knowledge Exposure                                       │
│       task → required sources → minimal AiRequest + disclosure ledger           │
│       [extends ai-context-builder/ + the B-01 policy; NO retrieval infra]       │
│                                   │                                             │
│ 6. AI Runtime Gateway             │ ONE generative call budget; bounded retry;   │
│       provider-neutral; latency budget; telemetry                               │
│         ├── deterministic strategy (no call)                                    │
│         ├── JEV strategy (classify/route; may terminate at §3/§9)               │
│         └── LLM adapter (CodeCraft | Atria | OpenRouter | AgentRouter | future) │
│                                   │                                             │
│ 7. Structured AI Decision         AiRequest → AiDecision (goals[], clarify,     │
│       handoffCause, facts); unknown keys stripped; contract only                │
│                                   │                                             │
│ 8. Decision/Action Resolver (deterministic; engine-owned)                       │
│       AiDecision + domain results + state + policy → TurnPlan                   │
│       (safety precedence, multi-intent sequencing, continuation)                │
│                                   │                                             │
│ 9. Domain Execution               CORE-01 eligibility → CORE-02 availability →  │
│       canonical createWithConflictCheck · ZERO AI authority [existing]          │
│                                   │                                             │
│ 10. Clarification Handler         safe question · set pending task · AI_ACTIVE  │
│                                   │                                             │
│ 11. Disclosure / Safety Gate      knowledge-free / backed / refused [existing]  │
│                                   ▼                                             │
│ 12. Response Composition          assemble domain-authored + AI-authored text   │
│       into ONE customer message (ONE send) [thin pure boundary]                 │
│                                   ▼                                             │
│ 13. Human Handoff                 explicit cause → NEED_HUMAN + attention;      │
│       explicit Resume AI returns to AI_ACTIVE (never silent) [existing]         │
└─────────────────────────────────────────────────────────────────────────────────┘
        │
        ▼
Async (out of critical path): Knowledge-Gap / Self-Improvement signal
        (record-only; human approval gates any promotion)   [design §12]

Evaluation boundary (separate process; never imported by production):
  EvaluationTarget ──▶ runTurn ──▶ ActualOutcome (extended, additive) ──▶ scorers
```

The listed 15 responsibilities map to these boundaries, but **not
one-to-one**: several collapse onto existing components
(§3). No component exists merely because the brief names it.

---

## 3. Component responsibility map

For each boundary: responsibility, inputs, outputs, owner of truth,
dependencies, what it must NOT know, replacement boundary. New vs existing
is explicit.

### 3.1 Inbound Turn Intake — EXISTING (`conversation-engine.ts`)

- **Responsibility:** channel-agnostic inbound → tenant resolution (never
  client input) → durable idempotency claim → customer/conversation
  upsert → immutable customer-message persistence → bounded context load.
- **Inputs:** `InboundMessageInput` + server-resolved identity.
- **Outputs:** persisted turn, `Conversation`, `Customer`, loaded sources.
- **Owner of truth:** tenant identity, message history, conversation
  lifecycle (`AI_ACTIVE` / `NEED_HUMAN` / `BOOKED` / `INCOMPLETE`).
- **Dependencies:** repositories only (no Prisma outside repositories).
- **Must NOT know:** AI providers, prompt bodies, knowledge policy levels.
- **Replacement boundary:** none — this is the ONE engine. Never duplicated.

### 3.2 Turn Analysis — GENERALIZED from existing deterministic code

- **Responsibility:** pure preprocessing — normalization, deterministic
  signal classification, deterministic booking-selection detection,
  task-relevance derivation. Produces `TurnSignals` only; makes no response
  decision.
- **Inputs:** message text + bounded history + loaded sources.
- **Outputs:** `TurnSignals` (normalized text, candidate deterministic
  classification, selection attempt, `TaskRelevance`).
- **Owner of truth:** none (pure analysis).
- **Dependencies:** `conversation-ai.ts` normalizer/classifier,
  `booking-selection.ts`, `deriveTaskRelevance`.
- **Must NOT know:** providers, network, DB, disclosure policy internals.
- **Replacement boundary:** pure module; replaceable and unit-testable in
  isolation.

### 3.3 Deterministic Resolution / Router — GENERALIZED

- **Responsibility:** if a turn is fully decidable without a model
  (greeting, empty/too-short, deterministic booking selection,
  explicit-human, sensitive), emit a `TurnPlan` and skip the gateway.
- **Evidence:** `bypassDeterministicAi` already proves 190 bypass turns in
  the real-LLM run with no LLM call; the deterministic path is also the
  best at required-handoff recognition (2.3% missed vs 8.7%/9.6%).
- **Inputs:** `TurnSignals` + conversation state.
- **Outputs:** `TurnPlan` or "not decidable".
- **Owner of truth:** deterministic policy (code).
- **Must NOT know:** providers; business data beyond what the plan needs.
- **Replacement boundary:** deterministic strategy interface; JEV can also
  terminate here.

### 3.4 Conversation State — NEW, engine-owned

- **Responsibility:** hold conversation understanding across turns:
  current goal, active task, known facts, revisions, missing facts, booking
  stage, selected service/date/time preference/provider, topic
  interruptions and returns, pending clarification, last offer.
- **Owner of truth:** conversation understanding ONLY. Authoritative domain
  state stays in the Domain (appointments, availability, eligibility).
- **Inputs:** validated fact updates from the AI decision + deterministic
  selection + domain results.
- **Outputs:** state read model for planning and context.
- **Dependencies:** persistence via `ConversationRepository` (additive
  storage in a later slice).
- **Must NOT know:** provider identity, prompt text, availability truth.
- **Replacement boundary:** value + pure merge functions; the storage
  adapter is replaceable. **Not** a second booking engine — it mirrors the
  booking journey stage only as a conversation fact.

### 3.5 Context Planner — EXTENDS `ai-context-builder/` (B-02)

- **Responsibility:** given the planned task(s) and state, choose the
  minimal set of sources and compose the `AiRequest` through the unchanged
  B-01 policy, producing the disclosure ledger.
- **Inputs:** server-resolved scope, loaded sources, `TurnSignals`, state,
  domain results when already resolved.
- **Outputs:** `AiRequest` + fact ledger (`included` / `disclosable`).
- **Owner of truth:** context composition (not knowledge, not domain).
- **Dependencies:** `src/lib/ai-knowledge-visibility/` (B-01),
  `ai-contract.ts`.
- **Must NOT know:** providers, LLMs, Prisma, `process.env`, credentials.
- **Replacement boundary:** pure function; unchanged public contract is
  `buildAiContext(...)` → `BuiltAiContext`. Task-aware planning is an
  additive input, defaulting to today's text-derived relevance.

### 3.6 Knowledge Exposure — EXTENDS existing stores, no new store

- **Responsibility:** surface the minimal, task-required structured
  knowledge: FAQ entries, service catalog names/descriptions, business
  info (`about`, policies), and domain-computed availability — each
  classified by B-01 before it can enter context, and tagged with a
  `knowledgeSourceClass` for observability.
- **Owner of truth:** none. `Business.faqs` (DECISIONS #13) and the service
  catalog (DECISIONS #53) stay the ONE stores; domain availability stays
  CORE-02.
- **Must NOT know / must NOT add:** vector DB, embeddings, semantic index,
  a second knowledge store, per-entry metadata beyond the existing shapes.
- **Evidence against retrieval infra:** paraphrase FAILs drop to 0 with a
  real LLM reading the store (Atria/CodeCraft `PARAPHRASED_FAQ` 0 FAIL);
  residual failures are exposure-bound (`NOT_EXPOSED`).
- **Replacement boundary:** the source-selection function is replaceable;
  the store is not.

### 3.7 AI Runtime Gateway — WRAPS existing factory/orchestrator/control

- **Responsibility:** the single provider-neutral seam for one logical
  turn. Enforces the **zero-or-one generative call** invariant, bounded
  retry/fallback (existing `conversation-control`, `maxAttempts ≤ 2`,
  `TIMEOUT` only), latency budget/deadline, telemetry capture, and the
  deterministic-bypass short-circuit.
- **Inputs:** `AiRequest` + policy + budget.
- **Outputs:** validated structured AI decision (or a typed controlled
  failure) + telemetry.
- **Owner of truth:** none (policy enforcement).
- **Dependencies:** `ai-contract.ts`, `AiProviderAdapter`,
  `conversation-control/`, `orchestrator.ts`, `factory.ts`.
- **Must NOT know:** domain logic, booking, persistence, knowledge policy.
- **Replacement boundary:** this IS the existing seam; the design adds
  budget/decision-strategy plugs, not a parallel abstraction.

### 3.8 Decision Strategies (deterministic / JEV / LLM) — EXTENDS adapters

- **Responsibility:** produce the structured decision, or terminate at
  deterministic/domain.
- **Owner of truth:** none; strategies never decide domain state.
- **Dependencies:** `AiProviderAdapter` (existing) + strategy metadata.
- **Must NOT know:** each other; the engine; the domain.
- **Replacement boundary:** adding/removing a provider remains the existing
  8-file recipe (`docs/ai/PROVIDERS.md §8`). A JEV strategy is one more
  strategy behind the same interface — never an unavoidable stage.

### 3.9 Structured AI Decision — EXTENDS `ai-contract.ts` (additive)

- **Responsibility:** the typed `AiRequest → AiDecision` boundary.
  `AiDecision` = existing fields + optional `goals[]`, `clarification`,
  `handoffCause`, `factUpdates`; unknown keys stripped by Zod exactly as
  today (no chain-of-thought).
- **Owner of truth:** the contract (code). Production enums change only in
  a deliberate later slice; the evaluation vocabulary must not be copied
  into production without a decision.
- **Must NOT know:** provider syntax, DB, tenant ids as content.
- **Replacement boundary:** versioned contract; adapters render it; the
  engine re-validates it (`parseAiResponse`/successor).

### 3.10 Decision/Action Resolver — NEW, engine-owned, deterministic

- **Responsibility:** the ONE place that converts a structured AI decision
  - domain results + state + policy into an executable `TurnPlan`
    (ordered steps), applying safety precedence and multi-intent sequencing.
- **Evidence:** needed because the model already lists catalog content in
  `content` while the action stays `booking_handoff` (`mi-booking-plus-discovery`);
  the model must not be the action authority.
- **Inputs:** validated decision, `ConversationState`, domain results,
  policy (knowledge-free intents, handoff precedence).
- **Outputs:** `TurnPlan` (steps: `ANSWER | CLARIFY | DOMAIN_ACTION |
HANDOFF` + continuation).
- **Owner of truth:** action selection and precedence (orchestration).
- **Dependencies:** contract types, state merge, domain result types.
- **Must NOT know:** provider identity, prompt text, raw provider output.
- **Replacement boundary:** pure function; deterministic and testable
  offline; JEV/LLM changes never touch it.

### 3.11 Clarification Handler — NEW, engine-owned

- **Responsibility:** emit a safe clarifying question, record the pending
  task/missing facts in state, stay `AI_ACTIVE`.
- **Owner of truth:** which facts are missing (conversation understanding).
- **Must NOT know:** domain truth; it asks, it does not resolve.
- **Replacement boundary:** pure composer + state write; bounded by the
  resolver's decision.

### 3.12 Domain Execution — EXISTING CORE-01/CORE-02 + booking write

- **Responsibility:** authoritative eligibility, availability, booking
  option resolution, canonical conflict-checked write — unchanged.
- **Owner of truth:** ALL domain state.
- **Must NOT know:** AI decisions, prompts, providers.
- **Replacement boundary:** none.

### 3.13 Disclosure / Safety Gate — EXISTING (B-03), EXTENDED

- **Responsibility:** structural enforcement of "AI may know" vs "AI may
  mention", now also for clarification and for each goal in a multi-goal
  plan. Knowledge-free intents remain a closed list; CLARIFY joins only by
  an explicit policy decision (a clarification question that names no
  unapproved fact), never by text inspection.
- **Owner of truth:** disclosure policy (B-01 levels via the ledger).
- **Must NOT know:** reply text semantics; it stays structural.

### 3.14 Response Composition — THIN BOUNDARY

- **Responsibility:** assemble the customer-visible message from
  domain-authored parts (slots, confirmations) and AI-authored parts
  (answers, clarifications) into ONE send, with ONE persisted AI message.
- **Evidence:** today every branch persists + sends separately; a
  multi-goal plan must not create partial sends or duplicate outbound rows.
- **Must NOT know:** policy, providers, domain truth.
- **Replacement boundary:** pure; one `persistAssistantReply` +
  `deliverAssistantReply` call.

### 3.15 Human Handoff — EXISTING, CAUSE-EXPLICIT

- **Responsibility:** map `handoffCause` → `NEED_HUMAN` + operator
  attention; preserve lifecycle `AI_ACTIVE → NEED_HUMAN → operator →
explicit Resume AI → AI_ACTIVE`.
- **Must NOT know:** provider internals (mapped to a typed cause first).
- **Replacement boundary:** the mapping is policy; the lifecycle is
  canonical and not replaced.

### 3.16 Async Knowledge-Gap / Self-Improvement — NEW, record-only

- **Responsibility:** when a turn ends in `KNOWLEDGE_GAP_UNRESOLVED`, record
  a structured gap signal (conversation, question class, source class) for
  later human review. No auto-promotion; the evaluation schema already
  models the lifecycle (`self-improvement-schema.ts`) and the rule
  "knowledge is never promoted without human approval".
- **Must NOT know / must NOT do:** block the turn, call a model, write
  knowledge, run in the request path.
- **Replacement boundary:** append-only record; a future queue is a policy
  choice, not required now.

### 3.17 Evaluation Boundary — EXISTING `EvaluationTarget`

- **Responsibility:** score the current system, the target architecture,
  JEV strategies, and provider variants over `egyptian-v1` without touching
  the scoring engine.
- **Replacement boundary:** new target class per variant (existing recipe),
  additive `ActualOutcome` passthrough fields, additive scorers only.

---

## 4. Decision flow (one turn)

```
CUSTOMER MESSAGE
  │
  ├─[1] Intake: tenant, idempotency, persist, load
  │
  ├─[2] Turn Analysis (pure)
  │        └─ signals: normalized text, candidate deterministic classes,
  │           booking-selection attempt, task relevance
  │
  ├─[3] Deterministic Resolution
  │        ├─ greeting / empty / selection / explicit-human / sensitive
  │        │     └──▶ TurnPlan ──▶ [11] gate ──▶ [12] compose ──▶ [13] state
  │        └─ not decidable
  │
  ├─[4] Conversation State: load (or derive from history in the interim)
  │
  ├─[5] Context Planner + Knowledge Exposure
  │        └─ task → sources → minimal AiRequest + ledger
  │
  ├─[6] AI Runtime Gateway (ONE generative call budget)
  │        └─ strategy: deterministic | JEV | provider adapter
  │
  ├─[7] Structured AI Decision (validated; goals[], clarify, handoffCause, facts)
  │
  ├─[8] Decision/Action Resolver (deterministic)
  │        ├─ safety precedence first (sensitive/human/injection-adjacent)
  │        ├─ resolve domain goals through [9] Domain Execution
  │        ├─ sequence ANSWER before pending DOMAIN_ACTION (multi-intent)
  │        ├─ CLARIFY when a required fact is missing and safe
  │        └─ HANDOFF only with an explicit cause
  │
  ├─[9] Domain Execution (authoritative; may itself force a domain handoff)
  │
  ├─[10] Clarification Handler (if the plan says clarify)
  │
  ├─[11] Disclosure / Safety Gate (per answer/clarify goal)
  │
  ├─[12] Response Composition → ONE assistant message persisted + sent
  │
  ├─[13] Human Handoff when the plan says so (state → NEED_HUMAN + attention)
  │
  └─[14] Async: knowledge-gap signal (best-effort, non-blocking)
```

Precedence rules (binding in the target):

1. Safety/sensitive and explicit human request always win; they are never
   swallowed by an answer or a clarification.
2. Domain truth always wins over an AI claim (availability, eligibility,
   conflicts).
3. An answerable knowledge goal is answered before a handoff is considered.
4. A missing, safely-askable fact produces CLARIFY before HANDOFF.
5. HANDOFF requires an explicit cause; "I could not answer" maps to
   `KNOWLEDGE_GAP_UNRESOLVED` only after 1–4 were tried.

---

## 5. Decision/action model (Critical Design Question #1 groundwork)

### 5.1 Decision classes (conceptual, target)

| Class           | Meaning                                                                              | Migration mapping from today                                                                                       |
| --------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `ANSWER`        | Reply from knowledge/domain facts                                                    | `reply` (FAQ/GREETING)                                                                                             |
| `CLARIFY`       | Ask a bounded question to unblock a task                                             | **new**                                                                                                            |
| `DOMAIN_ACTION` | Execute/serve a domain goal (eligibility, availability, booking, reschedule, cancel) | `booking_handoff` for booking intents; domain-authored replies for availability; **new** for self-serve completion |
| `HANDOFF`       | Route to a human with an explicit cause                                              | `handoff` / `booking_handoff`                                                                                      |

### 5.2 Structured decision shape (additive)

```
AiDecision = {
  intent, action, content, extraction, handoffReason, summary,   // unchanged today
  goals?: Goal[],                                                // NEW (optional)
  clarification?: { type: ClarificationType, missingFacts: FactKey[] }, // NEW
  handoffCause?: HandoffCause,                                   // NEW (richer reason)
  factUpdates?: FactUpdate[]                                     // NEW (validated state writes)
}
Goal = {
  kind: "ANSWER" | "CLARIFY" | "DOMAIN_ACTION" | "HANDOFF",
  intent: <existing family or future evaluation-only label mapped by the resolver>,
  requiredKnowledge?: KnowledgeRequirement,
  domainAction?: ExpectedDomainAction,   // vocabulary alignment with evaluation
  priority: number
}
```

Compatibility bridge: **a decision with no `goals` is treated as exactly one
goal synthesized from `intent` + `action`.** Every existing adapter,
harness, and evaluation target therefore keeps working byte-for-byte; the
new path is opt-in per prompt/strategy.

Ownership: the model **proposes** goals and facts; the Decision/Action
Resolver **owns** which goals execute, in what order, and which action the
engine performs. The model never decides domain truth, never executes, and
never overrides precedence.

## 6. Multi-intent model (Critical Design Question #1)

Canonical case: «عايز أحجز ايه الخدمات اللي موجودة عندكم؟» (`mi-booking-plus-discovery`, 20 cases:
Atria unnecessarily hands off 14, CodeCraft 17, deterministic 20).

**Where multi-intent lives:** in the structured `AiDecision.goals[]`
(understanding) and in the engine-owned `TurnPlan` + `ConversationState`
(execution/continuation). It does **not** live in prompt instructions
alone.

**Model:**

- Primary goal + secondary goals are ordered in `goals[]` with a stable
  `priority`, so the outcome is deterministic.
- The resolver builds a `TurnPlan`: e.g. `[ANSWER(service-discovery),
DOMAIN_ACTION(BOOKING, continue)]`.
- The ANSWER is satisfied from the exposed catalog (public). The booking
  goal remains **pending** in `ConversationState.activeTask` with
  `bookingStage` unchanged, so the booking continues rather than restarts.
- If the answer itself is missing but clarifying is safe, the plan is
  `[CLARIFY(...), DOMAIN_ACTION(pending)]` and the thread stays `AI_ACTIVE`.
- HANDOFF is emitted only when one of the goals genuinely requires it (and
  carries its own cause); a secondary handoff goal never overrides an
  answerable primary.

**Action-selection owner:** the Decision/Action Resolver (engine,
deterministic). **Continuation owner:** `ConversationState`. **Fact
validation owner:** the engine (the model proposes, the engine validates
against server-derived identifiers — never invents ids or slots).

**Not solved by prompt instructions:** adding "also answer secondary
questions" to a prompt would leave the contract single-valued and the
action selection model-owned; the evaluation already shows the model
sometimes lists the catalog while still returning `booking_handoff`.
Multi-intent is a contract + resolver + state property.

## 7. Clarification model (Critical Design Question #2)

**CLARIFY is a first-class decision class**, not an `AMBIGUOUS` handoff.
Align the production `ClarificationType` with the evaluation vocabulary:
`CLARIFY_SERVICE | CLARIFY_DATE | CLARIFY_TIME | CLARIFY_PROVIDER |
CLARIFY_INTENT | CLARIFY_DISAMBIGUATE_MULTI_INTENT |
CONFIRM_UNDERSTOOD_REQUEST` (+ `NONE`).

- **When appropriate:** the task is understood, a required fact is missing
  or two interpretations are plausible, and the question is safe
  (not sensitive, not adversarial, no forbidden fact implied).
- **Who decides it is safe:** the Decision/Action Resolver applies
  precedence; the Disclosure/Safety Gate verifies the resulting
  clarification is knowledge-free (a question that names no unapproved
  fact) or backed by a disclosable fact. The model may propose; the engine
  decides.
- **Missing information representation:** `ConversationState.missingFacts[]`
  keyed by a closed `FactKey` (`service | date | timePreference | provider |
intentDisambiguation | bookingConfirmation`), plus the pending
  `activeTask`/`bookingStage`.
- **Resumption:** the next turn's analysis + state binding resolves the
  answer to the pending fact; if it fits, the task continues; if it is a
  new topic, the topic stack suspends the task (`INTERRUPTED`) and can
  return to it (`RECOVERING`) — the evaluation already labels both.
- **Avoids unnecessary handoff:** ambiguous-but-clarifiable turns
  (`am-bare-booking-clarifiable` 12/12 FAIL today) ask one bounded question
  and stay `AI_ACTIVE`. Genuinely ambiguous-needs-human remains a handoff
  with cause `AMBIGUITY_UNRESOLVED`.
- **Bounds (anti-over-clarification):** at most one clarification per
  unresolved fact chain; no repeated identical clarifications; a
  clarification never blocks an explicit human request or a sensitive
  handoff; clarification is never used to defer a domain action that can be
  executed with known facts.
- **Not implemented in this slice:** the existing 8-intent contract and the
  disclosure gate are untouched.

## 8. Handoff model (Critical Design Question #3)

The target separates four orthogonal things:

```
DECISION CLASS (what)  = ANSWER | CLARIFY | DOMAIN_ACTION | HANDOFF
HANDOFF CAUSE   (why)  = explicit, typed, observable
CONVERSATION STATE     = AI_ACTIVE | NEED_HUMAN | BOOKED | INCOMPLETE (unchanged)
OPERATOR REASON        = the existing attention category (derived, coarse)
```

**Explicit handoff causes (target taxonomy; production enum lands in a
later slice):**

| Cause                      | Trigger                                                                 | Today's equivalent                                 |
| -------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------- |
| `CUSTOMER_REQUESTED_HUMAN` | explicit human request                                                  | `HUMAN_REQUEST`                                    |
| `SENSITIVE_OR_RESTRICTED`  | medical/emotional/security-sensitive                                    | `SENSITIVE`                                        |
| `DOMAIN_REQUIRES_HUMAN`    | policy routes a domain task to staff (e.g. reschedule/blacked-out)      | `booking_handoff`                                  |
| `KNOWLEDGE_GAP_UNRESOLVED` | answerable-by-human knowledge missing after exposure + clarify attempts | `NO_KNOWLEDGE`                                     |
| `AMBIGUITY_UNRESOLVED`     | genuinely ambiguous after a safe clarify attempt                        | `AMBIGUOUS`                                        |
| `POLICY_REFUSED`           | disclosure gate refused an unbacked reply                               | currently indistinguishable (maps to `NEED_HUMAN`) |
| `PROVIDER_FAILURE`         | provider error/timeout after bounded attempts                           | currently indistinguishable                        |
| `AI_FAILURE`               | invalid/absent structured output                                        | currently indistinguishable                        |
| `TENANT_CONFIGURATION`     | business/branch misconfiguration blocks the task                        | partially engine branches                          |
| `RETRY_EXHAUSTED`          | bounded retry/fallback spent                                            | `conversation-control` reason                      |

- **HUMAN_REQUIRED ≠ UNKNOWN ≠ AMBIGUOUS ≠ KNOWLEDGE_GAP ≠ PROVIDER_FAILURE
  ≠ AI_FAILURE.** "I cannot answer" is not a synonym for "send to employee":
  the flow tries ANSWER → CLARIFY → only then `KNOWLEDGE_GAP_UNRESOLVED`,
  and provider/AI failure produce their own causes (and their own distinct
  evaluation channels, already modeled).
- **Lifecycle preserved:** `AI_ACTIVE → NEED_HUMAN → operator → explicit
Resume AI → AI_ACTIVE`. The design does not add silent resume; the
  existing `RETURN_TO_AI` control remains the only resume path.
- **Safety is never weakened to reduce handoffs.** Sensitive and explicit
  human cases keep immediate, high-precedence handoff; the 6 genuine
  sensitive-multi-intent misses in the LLM baselines are treated as a
  safety defect to fix, not a handoff-rate problem.

## 9. Conversation-state model (Critical Design Question #4)

**One coherent model, engine-owned.** It is conversation understanding,
not domain authority.

```
ConversationState (target)
  currentGoal:        GoalKind | null
  activeTask:         { kind, stage: BookingStage, pendingGoalIds[] } | null
  knownFacts:         { service?, date?, timePreference?, provider?,
                        customerName? }             // customer-stated facts only
  revisions:          FactRevision[]                // append-only: key, from, to, turnId
  missingFacts:       FactKey[]                     // drives CLARIFY
  bookingStage:       BookingJourneyState           // aligned with evaluation vocabulary
  selectedService:    ServiceRef | null             // by NAME, resolved by the domain
  selectedDate:       ISODate | null
  selectedTimePref:   string | null
  providerPreference: string | null
  topics:             TopicFrame[]                  // interruption stack
    └ frame: { goal, suspendState, returnPoint }    // topic return
  pendingOffer:       { serviceName, date, options[], selectionContext } | null
  lastClarification:  { type, askedAtTurnId } | null
```

**Authority split (binding):**

- The **Conversation Engine owns** this state; it persists and merges it.
- The **Domain owns** all authoritative facts (appointments, availability,
  eligibility, conflicts). State never contains a slot that the domain did
  not compute; `pendingOffer.options` is a cached presentation of a
  CORE-02 result, re-verified at execution (as today's selection seam does).
- The **LLM** may propose `factUpdates` and `desiredGoal`; the engine
  validates and merges. The LLM is never the state authority.
- **No second booking state machine:** `bookingStage` mirrors the existing
  booking flow's stage for conversation purposes only; execution still runs
  through CORE-01/CORE-02 + `createWithConflictCheck`.

**Migration-safe storage:** today's state is implicit (history +
`aiSummary` + the selection seam re-parsing the last offer). The target
introduces an additive persisted `ConversationState` (a validated JSON
column on `Conversation`) but **initially derives it from history** and
keeps the derivation as the fallback, so the new machinery can ship behind
a flag and fall back to today's behavior. Storage shape is a later-slice
decision; no schema change now.

**Corrections/revisions:** a correction (`jt-revise-date` 14/14 FAIL) is a
`FactRevision` (`key`, `from`, `to`, `turnId`, `isRevision: true`) plus
`knownFacts` update; the resolver and context planner always read the
latest value. This mirrors the evaluation's revision model.

**Topic interruptions/returns:** `topics` is a bounded stack. A new topic
suspends the active task frame (`INTERRUPTED`); a later return restores it
(`RECOVERING`). This is the structural fix for
`re-long-context-topic-return` (10/10 FAIL).

## 10. Knowledge/context model (Critical Design Question #5)

**Task → required knowledge → minimal context**, replacing "every turn →
large dump" (even today's bounded dump of all ≤50 FAQ entries + ≤100 service
names).

- **Structured path first.** The Context Planner takes the turn's task(s)
  and selects: FAQ subset relevant to the task, service catalog fields the
  task needs (`name`, and `description` when the task is discovery/info),
  business info (`about`, policies) when asked, and domain-computed
  availability when a booking/availability task is active. Every candidate
  still passes B-01 → B-02; provenance still dropped.
- **Exposure fix (evidence: `NOT_EXPOSED`, catalog/discovery/hours):**
  give the existing public facts an `AiRequest` channel and an
  answering intent. This is exposure + intent, not retrieval. Public
  catalog/`about`/policy text may enter context when the task requires; the
  disclosure gate still decides mention.
- **No RAG/embeddings now (decision + evidence).** Real-LLM
  `PARAPHRASED_FAQ` FAILs are 0 for both providers because the model reads
  the structured store; the residual is exposure. Adding embeddings would
  add infrastructure, latency, and a new failure surface without evidence.
  If future evaluation shows the LLM still misses structured knowledge even
  when exposed, revisit — as a measured decision, not by default.
- **Knowledge-source class (observable):** each fact records a
  `knowledgeSourceClass` (`FAQ | CATALOG | BUSINESS_INFO | POLICY |
DOMAIN_AVAILABILITY | CONVERSATION_STATE`) so evaluation and diagnostics
  can attribute knowledge outcomes without content inspection.
- **Where retrieval belongs:** inside Context Planning, as structured
  source selection — pure, no I/O beyond already-loaded sources. The engine
  remains the only DB reader.

## 11. JEV integration (Critical Design Question #6)

JEV is a **decision strategy behind the existing provider seam**, not a
mandatory pipeline stage.

```
                        ┌───────────────────────────────┐
inbound → analysis →    │  AI Runtime Gateway           │
                        │  (ONE generative call budget) │
                        └───────────┬───────────────────┘
             ┌──────────────────────┼──────────────────────┐
             ▼                      ▼                      ▼
      deterministic           JEV strategy            LLM adapter
      (no call)          classify/route; may      (generate decision)
                         TERMINATE (no LLM)
```

Allowed paths:

- `deterministic → done` (existing bypass/selection).
- `deterministic → JEV → deterministic/domain` — JEV classifies/routes and
  the turn terminates without any LLM (e.g. confidence-high routing to a
  deterministic handler, or a typed "not answerable" → clarify/domain).
- `deterministic → JEV → LLM` — **only** when JEV cannot terminate and the
  LLM is the **single** generative call for the turn, and the task/confidence
  justifies it. This is not a hidden extra inference: the gateway's budget
  accounts for it.
- `deterministic → LLM` — JEV not consulted when it adds no value.

Forbidden by design:

- `JEV → LLM` as a mandatory path for every request.
- A hidden chain such as classifier-LLM → response-LLM → judge-LLM.
- Self-improvement/judging inside the customer critical path.

Termination cases for JEV without an LLM: pure routing decisions (explicit
human request, sensitive detection, selection confirmation, greeting/
control commands), high-confidence intent/booking-stage routing to an
existing deterministic handler, and typed abstention (→ CLARIFY or
deterministic handoff with cause).

If JEV is itself a model: it consumes the one generative call. If JEV is
deterministic, it costs zero calls. The gateway — not the strategy — owns
the budget. **Not implemented in this slice.**

## 12. Provider abstraction (Critical Design Question #8)

The existing seam is the design; nothing parallel is introduced.

```
Conversation Engine
      │  AiRequest → AiDecision (contract: ai-contract.ts)
AI Runtime Gateway (factory + orchestrator + conversation-control)
      │
AiProviderAdapter  ── CodeCraft · Atria · OpenRouter · AgentRouter · (JEV strategy)
      │  AiProviderResult → normalized AiResponse → parse
Provider policy (PlatformAiPolicy: primary/secondary/fallback/secretRefs)
```

- Swapping CodeCraft → Atria → another provider → a future routing strategy
  changes only the existing provider recipe (allowlist, adapter,
  factory branch, normalization policy, labels, env docs;
  `docs/ai/PROVIDERS.md §8`), never the engine, domain, booking authority,
  or state authority.
- The decision contract carries **no** provider id, endpoint, model, or
  prompt syntax. Telemetry is the only place provider/model appear, as
  machine keys.
- Secrets remain `secretRef` env-names resolved at call time; never in
  context, state, prompts, or telemetry.
- Latency policy lives at the gateway/policy layer (per-provider attempt
  timeout + turn budget), so a slow provider is a configuration/selection
  property — exactly how the Atria finding is handled.

## 13. Performance model (Critical Design Question #7)

**Binding invariants:**

1. **A normal turn performs ZERO or ONE generative model round-trip.**
2. A second invocation is allowed only through explicit bounded
   retry/fallback (`conversation-control`: `maxAttempts ≤ 2`, `TIMEOUT`
   only) or a declared provider fallback, and only while the turn latency
   budget allows.
3. No hidden multi-model sequence (classifier LLM → response LLM → judge
   LLM) may exist on the customer path.
4. Self-improvement/self-judging runs asynchronously, outside the turn, and
   can never delay a reply.
5. Context work is deterministic and free of model calls; it loads only
   task-required sources.

**Per-stage latency behavior:**

| Stage                                                  | Calls                                      | Notes                                             |
| ------------------------------------------------------ | ------------------------------------------ | ------------------------------------------------- |
| Analysis / State / Context / Resolver / Gate / Compose | 0                                          | pure, in-process                                  |
| Deterministic resolution                               | 0                                          | existing bypass precedent (190 turns in EVAL-04B) |
| Gateway + strategy                                     | 0 or 1 model call                          | JEV counts as the one call if generative          |
| Bounded retry/fallback                                 | +1 only on retryable failure within budget | existing ceiling                                  |
| Domain execution                                       | 0                                          | deterministic DB reads/writes                     |
| Async knowledge gap                                    | 0 on path                                  | deferred write, best-effort                       |

**Atria latency, addressed separately from quality:** provider selection
should consider a measured latency budget (p50/p95 under expected
concurrency) and a per-provider attempt timeout; a provider that routinely
exceeds the budget is a poor default even with equal quality. The
architecture exposes latency per attempt (telemetry exists) so selection is
evidence-based; it does not "fix" latency with extra retries.

**No premature optimization:** the budget is enforced where calls are made
(gateway) and observed (telemetry); no caching layer, no speculative
pre-computation.

## 14. Evaluation integration model

The `egyptian-v1` dataset and the unchanged EVAL-03 scoring engine must be
able to evaluate: current system, future architecture, JEV strategies, and
alternative providers — with additive scorer/target changes only.

Already sufficient:

- `EvaluationTarget` is provider-neutral; a new target is one class
  (`targets/<name>.ts`) with `runTurn` never throwing.
- `ActualOutcome` is `.passthrough()` with optional members, so new
  observables can be added without a schema break.
- `SystemIdentity` already carries `routerVersion` and
  `contextBuilderVersion`; use `kind: "FUTURE_SYSTEM"` for non-production
  variants.
- `compareRuns()` compares only shared case ids, so dataset growth is never
  a regression.

New observables the target architecture must expose (design only; not
implemented):

| Observable                                                 | Purpose                                              |
| ---------------------------------------------------------- | ---------------------------------------------------- |
| `turnPlan` (ordered decision classes)                      | score multi-intent sequencing                        |
| `goals[]` (kind + intent)                                  | score primary/secondary retention                    |
| `clarification` (`type`, `missingFacts`)                   | score `CLARIFICATION_NOT_ASKED` / over-clarification |
| `handoffCause` / `handoffOutcomeClass`                     | separate true vs unnecessary vs failure channels     |
| `knowledgeSourceClass`                                     | attribute knowledge outcomes to exposure             |
| `provider`, `fallbackUsed`, `retryCount`, `modelLatencyMs` | provider/JEV comparison                              |
| `stateTransition` (`from`, `to`, `factKey`, `isRevision`)  | score the state model                                |
| `routingDecision` (deterministic / JEV / LLM / bypass)     | measure where calls happen                           |

Rules: extend `failureCategoryValues` additively if needed; never rewrite
the scoring engine; never change the dataset or its gold labels to fit the
new architecture; new scorers go through the existing `Scorer` contract in
severity order.

## 15. Observability (minimum, not a platform)

Only what is needed to diagnose: `routingDecision`, `actionDecision`
(`TurnPlan`), `clarification`, `handoffCause`, `provider`/`model`,
retry/fallback, latency, `knowledgeSourceClass`, and evaluation outcome.
The existing `AI_TURN` usage row already carries provider/model/tokens/
latency/status; the new fields are structured machine keys, never content,
never chain-of-thought, never secrets. No token-accounting product, no new
cost telemetry.

## 16. Safety model (preserved and extended)

| Threat                                       | Control                                                                                                                                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sensitive request                            | Highest precedence → `SENSITIVE_OR_RESTRICTED` handoff; not answerable, not clarifiable, not swallowable by a multi-intent goal                                                                                                                   |
| Sensitive + ordinary question in one message | Precedence: the sensitive goal hands off; the ordinary goal may be answered only if policy allows without acknowledging/processing sensitive content — the 6 genuine misses are the open defect to fix with tests, never by lowering the boundary |
| Prompt injection / hidden instructions       | Structured contract; unknown keys stripped; knowledge-as-data (no instruction channel); disclosure gate structural; no reply text can widen the knowledge-free intent list                                                                        |
| Knowledge fabrication                        | Answer only from exposed, policy-approved facts; `KNOWLEDGE_FABRICATION` scored; LLM fabrication 19–24 cases is a reason to tighten exposure/gating, not to add free-form generation                                                              |
| Tenant isolation                             | Tenant resolved server-side only; provenance proof in B-02; empty/unproven scope excludes everything                                                                                                                                              |
| Disclosure boundary                          | B-01 level → B-02 ledger → B-03 gate; clarification added only via an explicit policy decision                                                                                                                                                    |
| Provider failure                             | Typed cause `PROVIDER_FAILURE`/`RETRY_EXHAUSTED`; customer gets the deterministic safe acknowledgment (existing #58/#60 behavior), never silence; no fallback = documented outage risk                                                            |

Escalation behavior is never weakened to reduce the handoff rate.

## 17. Incremental migration plan

Each slice is independently testable and preferably revertible. No
big-bang; old behavior remains available behind the compatibility bridge
(§18). Order is evidence-priority.

### Slice 0 — Contract + observation groundwork (additive)

> **STATUS: IMPLEMENTED (PROMPT-AI-ARCH-02).** The additive fields
> (`goals?`, `clarification?`, `handoffCause?`, `factUpdates?`), the
> single-goal synthesis bridge (`synthesizeDecisionGoals` /
> `synthesizeTurnPlan`), and the additive turn observability seam
> (`ai-observability.ts` → `InboundSuccess.observability?`) landed in
> `ai-contract.ts` with **zero producer/consumer requirement and zero
> behavior change**. The evaluation boundary exposes the same observables
> additively via `ActualOutcome`. Guarded by `pnpm check:ai-architecture`
> (25/25, offline) plus every existing check suite green. Slices 1–10 remain
> DESIGN ONLY.

- **Goal:** land the additive decision shape (`goals?`, `clarification?`,
  `handoffCause?`, `factUpdates?`) with the single-goal synthesis bridge, and
  the evaluation observables — with no behavior change.
- **Boundary:** `ai-contract.ts`, `ai-context-builder/` types, evaluation
  `ActualOutcome` consumers.
- **Contract:** `AiDecision` = today's `AiResponse` + optional fields.
- **Preserved:** every existing adapter/harness/engine path unchanged;
  decisions without goals synthesize one.
- **Tests:** existing `check:ai-prompts`, `check:ai-disclosure`,
  `check:ai-context-builder`, `check:conversation-*`, `check:eval*` stay
  green; new contract round-trip fixtures.
- **Depends on:** none. **Rollback:** revert the contract fields.

### Slice 1 — F1 safety fix (clitic + branch order)

> **STATUS: IMPLEMENTED (PROMPT-AI-ARCH-03).** The deterministic classifier
> in `conversation-ai.ts` now (a) strips the Egyptian single-letter clitic
> «بـ» in `stripAffixes` so «بموظف» normalizes to «موظف» (guarded by length
> so function words like «بس» are untouched; `STOPWORDS` runs through the
> same affix pipeline so filtering is unchanged), (b) recognizes the
> «وصلني بحد» transfer phrase in `HUMAN_PHRASES`, and (c) evaluates the
> explicit HUMAN_REQUEST branch **before** `isPureGreeting` in
> `classifyCustomerMessage`. The five genuine missed handoffs
> (`adv-greeting-plus-human::u1{,_missing_hamza,_drop_punctuation}`,
> `mt-human-plus-question::u1{,_missing_hamza}`) now resolve to
> HUMAN_REQUEST. Pure greetings still bypass with **zero** provider calls;
> no contract/prompt/provider/schema change; no JEV/CLARIFY/state code.
> Guarded by `pnpm check:greeting` **66/66** (9 new F1 cases) and
> `pnpm check:conversation-handoff` **21/21**, with the AI/eval/conversation
> suites and `pnpm verify` green. Slices 2–10 remain DESIGN ONLY.

- **Goal:** remove the 5 genuine missed handoffs (all one root cause:
  `stripAffixes` can't see `بموظف`, and `isPureGreeting` runs before the
  human branch).
- **Boundary:** `conversation-ai.ts` tokenizer + branch order.
- **Preserved:** greeting semantics, no over-triggering handoff.
- **Tests:** `adv-greeting-plus-human::*`, `mt-human-plus-question::*` pass;
  `check:greeting`/`check:conversation-handoff` green.
- **Depends on:** none. **Rollback:** revert two functions.

### Slice 2 — Conversation State foundation

> **STATUS: IMPLEMENTED (PROMPT-AI-ARCH-04).** The engine-owned
> `ConversationState` foundation landed in
> `src/features/conversations/server/conversation-state.ts`: the ONE
> structured conversation-understanding value (current goal, active task,
> known facts, append-only revisions, missing facts, booking stage,
> selected service/date/time-preference/provider, topic interruption/return
> stack, pending offer, multi-intent goals), with the pure deterministic
> functions `emptyConversationState`, `deriveConversationStateFromHistory`
> (reuses the existing offer seam `extractLastBookingOffer`),
> `factUpdatesFromExtraction`, and `mergeConversationState`
> (`state + factUpdates → nextState`). Merge semantics distinguish
> new/unchanged/corrected/conflicting/explicit-revision facts (the revision
> log keeps `isRevision` so a deliberate correction stays distinct from an
> accidental contradiction; the latest value is always authoritative inside
> the state). `bookingStage` names are a bounded SUBSET aligned by value
> with the evaluation `BookingJourneyState` vocabulary — production never
> imports evaluation. The engine (`conversation-engine.ts`) derives the
> state from the already-persisted history (the EXISTING persistence seam —
> messages) and merges the current turn's `extraction` + Slice-0
> `factUpdates` through the ONE merge function, then projects a content-free
> `stateTransition` into the Slice-0 observability record. It is
> observe-only: **zero** additional model inference, no prompt/provider
> change, no new schema/migration, and NO behavior change. The state is NOT
> yet authoritative over domain state (availability/eligibility/booking
> writes remain CORE-01/CORE-02 + `createWithConflictCheck`); later slices
> consume it. Guarded by `pnpm check:conversation-state` **19/19**, with
> `check:ai-architecture` (now asserting exactly ONE engine-owned
> `ConversationState`), `check:greeting`, `check:conversation-handoff`,
> `check:conversation-booking`, and `pnpm verify` green. Slices 3–10 remain
> DESIGN ONLY.
>
> **Storage review (per §20):** the foundation derives state from the
> existing persisted conversation history and keeps that derivation as the
> fallback; it introduces **no** `ConversationState` column in this slice.
> A physical persisted column/table is deferred until a consumer (the
> Slice-3 resolver) needs cross-turn persistence of AI-proposed facts that
> are not reconstructable from history — the smallest additive change at
> that point, with its own migration review.

- **Goal:** one structured state, derived from history, persisted
  additively; not yet authoritative.
- **Boundary:** new engine-owned state module + `ConversationRepository`
  adapter (later column).
- **Contract:** `ConversationState` + pure `merge(state, factUpdates)`.
- **Preserved:** derivation from history reproduces today's understanding;
  no behavior change until consumers opt in.
- **Tests:** revision, partial date, "تمام", "نفس المعاد", topic return
  fixtures at the state level (not yet scored end-to-end).
- **Depends on:** Slice 0. **Rollback:** stop persisting; fall back to
  derivation.

### Slice 3 — Decision/Action Resolver + TurnPlan

> **STATUS: IMPLEMENTED (PROMPT-AI-ARCH-05).** The ONE deterministic
> Decision/Action Resolver landed in
> `src/features/conversations/server/turn-planner.ts`: the pure, total
> `resolveTurnPlan(decision + state + routing + domain) → ResolvedTurn`
> that combines the normalized AI decision, the engine-owned
> `ConversationState` (Slice 2), the existing deterministic/control routing,
> an already-computed authoritative domain outcome, and the existing
> safety/handoff constraints into ONE ordered **single-goal** `TurnPlan`. It
> reuses the canonical `AiTurnPlan` (Slice 0) — there is NO second plan
> representation — and derives the primary goal through the ONE synthesis
> bridge (`synthesizeDecisionGoals`), so the decision class is byte-for-byte
> the existing single-goal mapping (`reply`→ANSWER, `handoff`→HANDOFF,
> `booking_handoff`/booking-family→DOMAIN_ACTION) for every current path. The
> resolver makes the deterministic **precedence explicit and testable**
> (`turnPrecedenceRules`, highest first): `CONTROL_COMMAND` →
> `EXPLICIT_HUMAN_REQUEST` → `SAFETY_RESTRICTED` → `DOMAIN_CONSTRAINT`
> (authoritative domain truth wins over an AI claim) → `DOMAIN_DECISION`
> (existing cancellation/reschedule/booking/availability) → `NORMAL_DECISION`.
> It carries only the EXISTING `HandoffReason` — the explicit handoff-cause
> taxonomy is deliberately deferred to Slice 7. The resolver NEVER queries
> Prisma, invents availability/slots, writes/mutates appointments, or bypasses
> tenant scope; it only INSPECTS a domain outcome and the DOMAIN
> (CORE-01/CORE-02 + `createWithConflictCheck`) stays authoritative.
>
> Integration is an **additive SHADOW boundary** (per §17/§18 "bypass the
> planner" rollback): the engine (`conversation-engine.ts`) runs the resolver
> over the finished turn and projects its single-goal plan into the additive
> Slice-0 observability (`TurnObservability.turnPlan`, now resolver-owned when
> present, falling back to the Slice-0 synthesis otherwise). The current
> execution path (deterministic bypass, booking selection, CORE-01/CORE-02
> domain seam, disclosure gate, reply/handoff branches) remains AUTHORITATIVE
> and byte-for-byte unchanged, so there is **zero** customer-visible behavior
> change, **zero** additional model inference (zero-or-one generative call
> preserved), no multi-intent execution, no second send, no CLARIFY activation
> (the class may appear in the output contract but starts no clarification),
> no prompt/provider change, and no schema/migration. Guarded by
> `pnpm check:turn-planner` **22/22** (precedence, single-goal, domain
> authority, deterministic/pure, zero-call, no second state machine), with
> `check:ai-architecture` **25/25**, `check:conversation-state` **19/19**,
> `check:greeting` **66/66**, `check:conversation-handoff` **21/21**,
> `check:conversation-booking` **16/16**, `check:conversation-ux` **18/18**,
> `check:ai-disclosure`, `check:ai-context-builder`, `check:eval`,
> `check:eval-runner`, and `pnpm verify` green. Slices 4–10 remain DESIGN ONLY.

- **Goal:** deterministic mapping decision + state + domain → ordered plan,
  single-goal only (no multi-intent yet); safety precedence formalized.
- **Boundary:** new pure `turn-planner` in the engine.
- **Preserved:** single-intent behavior and every existing branch outcome.
- **Tests:** all existing handoff/disclosure/booking harnesses; golden
  plans for representative cases.
- **Depends on:** Slices 0–2. **Rollback:** bypass the planner.

### Slice 4 — CLARIFY (first-class)

> **STATUS: IMPLEMENTED (PROMPT-AI-ARCH-06).** First-class CLARIFY now lives
> in the ONE existing decision architecture — no second resolver, no second
> state machine, no second clarification engine, no second plan schema, no
> second inference. The resolver-owned clarification handler
> (`src/features/conversations/server/clarification.ts`) is a pure, total
> module: `planClarification(decision, state)` decides whether a turn is
> safely clarifiable and composes exactly ONE bounded, knowledge-free question
> (fixed engine-authored templates, the existing `REPLIES` convention — no
> prompt-artifact change, no LLM call); `clarificationForBookingReason`
> labels the EXISTING booking-mapper missing/ambiguous-fact clarification as a
> first-class CLARIFY (the DOMAIN keeps message authorship); and
> `derivePendingClarification` reconstructs a pending clarification from the
> already-persisted history (the migration-safe §9 seam — no new storage, no
> migration). The ONE Slice-3 resolver (`turn-planner.ts`) gained a sixth
> precedence rule `CLARIFY_DECISION`, ranked BELOW
> `CONTROL_COMMAND`/`EXPLICIT_HUMAN_REQUEST`/`SAFETY_RESTRICTED`/
> `DOMAIN_CONSTRAINT`/`DOMAIN_DECISION` and ABOVE `NORMAL_DECISION`: a
> clarifiable turn resolves to `CLARIFY` INSTEAD of a handoff, but can never
> override an explicit human request, a sensitive/restricted turn, a control
> command, or an authoritative domain constraint, and a genuine knowledge gap
> (`NO_KNOWLEDGE`) stays a handoff. The ONE Slice-2 `ConversationState`
> (`conversation-state.ts`) merge now RECORDS a clarification (pending
> `missingFacts` + `lastClarification`, active task + known facts + topic
> stack preserved) and RESOLVES it when the customer supplies the missing fact
> on a later turn (resume), persisting the pending clarification through topic
> interruption/return.
>
> Engine integration is now AUTHORITATIVE for the ONE new branch: a
> clarifiable turn emits ONE clarification reply and stays `AI_ACTIVE` (no
> `NEED_HUMAN`, no operator attention) — within the EXISTING turn execution
> path, with ZERO additional model inference (the normal turn remains
> zero-or-one generative round-trip; a too-short message clarifies on the
> deterministic bypass with ZERO calls). The clarification question is
> knowledge-free by explicit policy (B-03 §16): it names no business fact and
> crosses the customer boundary on its declared CLARIFY class, exactly like
> the GREETING knowledge-free protocol — the disclosure gate is not weakened.
> Every other decision class leaves the existing path (booking seam, CORE-01/
> CORE-02 domain, disclosure gate, reply/handoff, provider-failure/AI-failure
> safe acknowledgment) byte-for-byte unchanged: no multi-intent execution, no
> second send, no handoff-taxonomy redesign, no knowledge redesign, no JEV, no
> domain-authority change, no prompt/provider/schema/migration change. Guarded
> by `pnpm check:clarify` **18/18** (clarify emitted only when justified;
> never for human/sensitive/knowledge-gap/answerable; preserves + resumes
> state; interruption/return; zero extra model call; existing greeting/
> booking/handoff unchanged), with `check:turn-planner` **22/22** (precedence
> now 7 rules), `check:conversation-state` **19/19**, `check:ai-architecture`
> **25/25**, `check:greeting` **66/66**, `check:conversation-handoff`
> **21/21**, `check:conversation-booking` **16/16**, `check:ai-disclosure`
> **36/36**, `check:operator-attention` **20/20**, `check:conversation-ux`
> **18/18**, `check:eval`/`check:eval-schema`/`check:eval-runner`/
> `check:ai-prompts`, and `pnpm verify` + `pnpm security` green. Slices 5–10
> remain DESIGN ONLY.
>
> **REMEDIATION (PROMPT-AI-ARCH-07, from PROMPT-AI-EVAL-07 real-LLM evidence).**
> The focused real-LLM CLARIFY verification found four concrete failures at the
> Slice-4 decision boundary (the model AUTHORS the decision, so a safety reason
> or a supplied fact can be absent from its self-report). All four were closed
> DETERMINISTICALLY at the real seam — no new LLM call, no new classifier, no
> prompt/provider/schema change, no second resolver/state/plan model:
>
> 1. **Safety precedence is now authoritative, not model-trusted.** The engine
>    computes a deterministic turn-control signal
>    (`detectTurnControlSignals` in `conversation-ai.ts`, reused BY VALUE from
>    the SAME sensitive/human keyword tables the deterministic classifier
>    already applies) and passes it to the resolver. `SAFETY_RESTRICTED` fires
>    on the deterministic `sensitive` signal (and `EXPLICIT_HUMAN_REQUEST` on
>    the deterministic `explicitHuman` signal) EVEN WHEN the model proposed a
>    CLARIFY and did not self-report the reason. A new engine branch (9a-pre)
>    takes the safe deterministic `NEED_HUMAN` handoff BEFORE the CLARIFY branch
>    AND the booking seam, so a sensitive turn can never be swallowed as
>    `CLARIFY_SERVICE + AI_ACTIVE` (EVAL-07 `ho-sensitive-medical`). The human
>    signal is gated to NOT fire inside a booking/task request (where "أي دكتور"
>    is a provider preference, not a handoff).
> 2. **Supplied-fact resume.** `derivePendingClarification` now finds the
>    clarification the CURRENT customer turn is answering (it skips the trailing
>    customer message the engine persists before deriving state — the prior
>    logic returned null for every real turn, the root cause of
>    `RESUME_FAILED`). When exactly one fact is pending and the model omitted it,
>    the engine binds the turn as that fact through the ONE
>    `mergeConversationState` path; `planClarification` suppresses re-asking a
>    fact-specific clarification whose fact is already known; and the booking
>    seam supplements the mapper's extraction with the resumed fact
>    (`resumeBookingExtraction`, free-form facts verbatim, date only when ISO).
> 3. **Interruption / pending-task recovery.** A new precedence rule
>    `PENDING_TASK_PRESERVED` (ranked below `DOMAIN_DECISION`, above
>    `CLARIFY_DECISION`) preserves a pending task across a benign interruption:
>    when the model escalates a pause with no independent handoff condition (no
>    deterministic human/sensitive signal, no domain block, no `NO_KNOWLEDGE`),
>    the engine re-asks the pending clarification and stays `AI_ACTIVE` instead
>    of escalating (EVAL-07 `jt-interrupted`). A genuine knowledge gap and an
>    explicit human request still win.
> 4. **Unnecessary CLARIFY.** A bare non-committal fragment ("مش عارف") with no
>    pending clarification and no active task has nothing to clarify; the
>    deterministic `nonCommittal` signal suppresses an unnecessary
>    `CLARIFY_INTENT` (EVAL-07 `st-ambiguous-idk`). A non-committal REPLY to a
>    pending clarification stays clarifiable (the state, not the flag, decides).
>
> **CLARIFY measurement integrity (evaluation-only).**
> `evaluation/runner/clarify-measure.ts` now applies safety precedence FIRST: a
> turn with `safetyExpectation ≠ SAFE` that did not reach a human is a
> `SAFETY_REGRESSION` (never tolerated as an acceptable CLARIFY because its
> handoff expectation belongs to another category), and a `REQUIRED` handoff
> that was clarified away is a `HUMAN_HANDOFF_REGRESSION`. The EVAL-03 scoring
> engine, the dataset, and the gold labels are unchanged.
>
> Precedence is now **8 rules**
> (`CONTROL_COMMAND` > `EXPLICIT_HUMAN_REQUEST` > `SAFETY_RESTRICTED` >
> `DOMAIN_CONSTRAINT` > `DOMAIN_DECISION` > `PENDING_TASK_PRESERVED` >
> `CLARIFY_DECISION` > `NORMAL_DECISION`). Remediation guarded by
> `check:clarify` **20/20**, `check:turn-planner` **31/31**,
> `check:conversation-state` **20/20**, `check:future-system` **22/22**
> (incl. F19 measurement integrity, F20 safety, F21 resume, F22 interruption),
> `check:eval`/`check:eval-runner`/`check:eval-schema` green, and `pnpm verify`
>
> - `pnpm security` green. The next prompt reruns the focused real-LLM CLARIFY
>   verification.
>
> **Remaining uncertainty.** The deterministic resume binds a stated date as a
> conversation fact (resolving the CLARIFY state so it is not re-asked), but the
> booking domain still requires an ISO date; relative Arabic dates ("الخميس")
> are resolved by the model's extraction, so a full booking-journey date resume
> depends on the real LLM emitting an ISO date — to be confirmed by the
> real-LLM rerun. The FUTURE_SYSTEM eval reconstructs state from history via the
> engine's OWN clarification templates; a dataset whose scripted AI lines are
> not engine templates reconstructs no pending task, so the interruption-
> recovery fix is proven deterministically (resolver + engine) rather than
> through that specific eval reconstruction.

> **BEHAVIORAL REMEDIATION (PROMPT-AI-ARCH-08, from PROMPT-AI-EVAL-10 real-LLM
> evidence).** The real-LLM EVAL-10 rerun confirmed the two remaining Slice-4
> behavioral gaps — `SUPPLIED_FACT_RESUME` (2/2) and `INTERRUPTION_RECOVERY`
> (1/1) — were genuine input-path failures, not evaluation-path problems. Both
> are now closed DETERMINISTICALLY at the real production seams, with NO new LLM
> call (zero-or-one invariant held), no new classifier, no prompt/provider/
> schema change, no second resolver/state/plan/fact model:
>
> 1. **Supplied-fact resume for colloquial Egyptian relative dates.** The AI
>    contract's `extraction.date` only crosses the boundary as a bounded ISO
>    `YYYY-MM-DD`, so a model can never carry «الخميس» as a date — the engine
>    (Conversation orchestration) must normalize it. A new PURE module
>    `relative-date.ts` (`resolveEgyptianRelativeDate`) recognizes exactly the
>    concrete colloquial forms the failing cases exercise — weekday names
>    («السبت…الجمعة»), «النهاردة/اليوم», «بكرة/غدا», «بعد بكرة/بعد غد» — relative
>    to the business-timezone "today", returning the ISO the booking DOMAIN
>    already requires (it is NOT a general date-language framework; unrecognized
>    input returns `null` and existing behavior is unchanged). The engine's
>    supplied-fact resume binding (`resolveFinishedTurn`) runs it when the single
>    pending fact is the booking DATE, binding the ISO through the ONE
>    `mergeConversationState` path; `resumeBookingExtraction` then supplements the
>    mapper's extraction (date only when ISO), so the booking ADVANCES to
>    availability instead of re-asking `CLARIFY_DATE` (EVAL-10
>    `am-context-resolves-service`, `mt-topic-return`). The DOMAIN still
>    re-validates and executes; no second fact model is introduced.
> 2. **Interruption recovery for a disclosure-refused benign aside.** A benign
>    social interruption during a resumable booking offer («ثواني بس، أنا في
>    مكالمة») is a `reply` the model cannot ground, so the B-03 gate refuses it —
>    and the refusal path escalated to `NEED_HUMAN`, losing the task. A new
>    engine branch (9d-pre) preserves the pending task INSTEAD: when the engine-
>    owned `ConversationState` marked the active task `INTERRUPTED` this turn and
>    the message is a benign NON-question aside, the unbacked reply is still
>    dropped (disclosure safety is NOT weakened) and the engine sends the fixed,
>    knowledge-free interruption acknowledgment (`clarificationForInterruption`,
>    `CONFIRM_UNDERSTOOD_REQUEST`) and stays `AI_ACTIVE`. The presented offer
>    survives in history, so the next turn resumes deterministically (EVAL-10
>    `jt-interrupted`). Scope is deliberately narrow and safety is preserved: a
>    sensitive / explicit-human turn was already handed off at 9a-pre; a
>    knowledge QUESTION (ending «؟»/"?") that cannot be backed stays a
>    `NEED_HUMAN` knowledge gap and is never preserved; a refusal with no active
>    interrupted task escalates exactly as before.
>
> No precedence change was required (the 8-rule order is unchanged): resume is a
> `DOMAIN_DECISION` once the date binds, and interruption recovery is an engine
> execution-path preservation at the disclosure seam, not a new resolver rule.
> Remediation guarded by `check:clarify` **27/27** (NEW 19–25: colloquial resume,
> return phrase, social-interruption preservation, deterministic return,
> knowledge-question regression, explicit-human regression, the normalizer unit),
> `check:turn-planner` **31/31**, `check:conversation-state` **20/20**,
> `check:conversation-booking` **16/16**, `check:conversation-handoff` 21/21,
> `check:ai-disclosure` **36/36**, `check:future-system` **33/33**,
> `check:eval`/`check:eval-runner`/`check:eval-schema` green; `pnpm verify` +
> `pnpm security` green. The next prompt reruns the focused real-LLM EVAL-10
> verification expecting `RESUME_FAILED=0` + `INTERRUPTION_RECOVERY_FAILED=0` +
> safety 0.
>
> **Remaining uncertainty.** The colloquial resume is proven deterministically
> end-to-end through the real engine (bind → advance to availability); the
> real-LLM EVAL-10 rerun is still required to confirm Atria returns a BOOKING
> intent for «الخميس» so the booking seam is reached (the observed EVAL-10 run
> already showed it did, re-emitting `CLARIFY_DATE` only because the ISO never
> bound — now fixed). The interruption-recovery fix depends on the real LLM
> producing a reply the disclosure gate refuses during the interrupted task (the
> observed EVAL-10 run did exactly this); a different model reply that the gate
> DISCLOSES (an answerable FAQ) is answered and the task stays resumable in
> history — also acceptable.

- **Goal:** emit a safe clarification instead of escalating clarifiable
  ambiguity; record `missingFacts`/pending task; resume on the next turn.
- **Boundary:** resolver + resolver-owned clarification handler + B-03
  knowledge-free policy decision (a clarification intent added only by an
  explicit policy entry).
- **Preserved:** sensitive/human precedence; refusal path; no fabricated
  facts.
- **Tests:** `am-bare-booking-clarifiable`, `st-ambiguous-oneword`,
  `mt-any-time`, `st-ambiguous-idk`, plus "clarification never overrides
  sensitive" cases.
- **Depends on:** Slice 3. **Rollback:** disable the CLARIFY branch.

### Slice 5 — Multi-intent (goals + answer-and-continue)

> **STATUS: IMPLEMENTED (PROMPT-AI-ARCH-09).** The smallest production-side
> multi-intent foundation now lives in the ONE existing decision architecture —
> no second engine, resolver, state model, planner schema, classifier, or
> inference. It reuses the canonical `AiResponse.goals[]` (Slice 0, unchanged
> contract) and adds ANSWER-AND-CONTINUE as the first executable multi-intent
> behavior.
>
> **(A) Resolver (`turn-planner.ts`).** The ONE resolver now selects the PRIMARY
> executable goal by a DETERMINISTIC goal-kind precedence
> (`HANDOFF > CLARIFY > ANSWER > DOMAIN_ACTION`, order-independent of the
> decision's goal array). When an answerable KNOWLEDGE goal (`ANSWER`, a genuine
> `reply`) coexists with a DOMAIN/booking goal, the turn resolves to `ANSWER`
> and carries the domain goal(s) in a NEW `ResolvedTurn.pendingGoals` with
> `answerAndContinue = true`. The 8-rule precedence is UNCHANGED and still
> applied FIRST, so safety / explicit-human / authoritative-domain-constraint
> ALWAYS outrank answer-and-continue; a handoff decision (`action !== "reply"`,
> e.g. a `NO_KNOWLEDGE` gap) stays a handoff. Exactly ONE goal executes per
> turn; the plan stays a single-step canonical `AiTurnPlan`; `goals[]` is never
> collapsed or mutated.
>
> **(B) ConversationState (`conversation-state.ts`).** The ONE engine-owned
> state gained `pendingGoals` and the merge accepts `deferredGoals`: a deferred
> domain goal SURVIVES the answer, a topic interruption, and next-turn
> continuation, and is RESUMED (consumed) when the customer pursues the task or
> COMPLETED when a booking is written. No new persistence model — the pending
> goal is reconstructed from the already-persisted history via a knowledge-free
> marker (`derivePendingContinuation` in `clarification.ts`, the same
> migration-safe §9 seam `derivePendingClarification` uses).
>
> **(C) Engine (`conversation-engine.ts`).** The answer flows through the
> EXISTING reply/disclosure path; on an answer-and-continue turn the engine
> composes ONE coherent send by appending the fixed, knowledge-free
> `CONTINUE_DOMAIN_INVITE` (B-03 §16 — names no business fact). Result: ONE
> customer-visible send, ZERO additional model inference (zero-or-one invariant
> intact — a greeting bypass still makes 0 calls, a generative turn 1), the
> booking goal preserved as pending, and the invite doubling as the history
> marker the next turn reads to resume.
>
> **(D) Observability + eval seam.** `TurnObservability` + `ActualOutcome` gained
> additive optional `pendingGoals` + `answerAndContinue` (machine labels only,
> content-free). No scorer/dataset/gold change.
>
> **Note on today's producers.** The deterministic classifier emits NO
> `goals[]`, so answer-and-continue is UNREACHABLE in production until a producer
> extracts multiple goals — zero customer-visible change this slice, exactly like
> the Slice 3/4 shadow boundaries. No prompt change was required (the existing
> `goals[]` contract already carries multiple goals); if a producer later needs
> prompt work to extract them, that is its own slice.
>
> **Guarded by** NEW `pnpm check:multi-intent` **20/20** (single-goal parity,
> two answerable goals represented, knowledge+booking answer-and-continue,
> booking pending + survives interruption + survives/resumes next turn,
> knowledge+human/sensitive/knowledge-gap precedence, one send, one model call,
> one state, one plan, deterministic ordering, deterministic-bypass zero call,
> history derivation, no second resolver/state/planner/classifier/inference, no
> provider id in contract, no resolver domain mutation), with
> `check:turn-planner` **31/31**, `check:conversation-state` **20/20**,
> `check:clarify` **27/27**, `check:ai-architecture` **25/25**,
> `check:ai-disclosure` **36/36**, `check:conversation-handoff`/`-booking`/
> `-ux`/`-control`, `check:greeting`, `check:booking-options` **32/32**,
> `check:booking-confirm` **18/18**, `check:eval`/`-runner`/`-schema`
> 25/18/22, `check:future-system` **33/33**, `check:ai-prompts` **108/108**;
> `pnpm verify` (lint/typecheck/format/build) + `pnpm security` green. Slices
> 6–10 remain DESIGN ONLY.

- **Goal:** represent multiple goals; answer the knowledge goal and keep the
  domain goal pending; hand off only when a goal truly requires it.
- **Boundary:** contract `goals[]` → resolver sequencing → state
  continuation.
- **Preserved:** single-intent parity; primary action unchanged when one
  goal exists.
- **Tests:** `mi-booking-plus-discovery`, `mi-booking-plus-hours/location`,
  `mi-two-questions`, `ho-unnecessary-*`; verify no partial sends (one
  persisted message).
- **Depends on:** Slice 4 (clarify is part of the plan model). **Rollback:**
  ignore secondary goals (bridge to single goal).

### Slice 6 — Knowledge exposure (catalog / business info / service info)

- **Goal:** expose the public facts the evidence says are present but
  unreachable (`about`, service `description`, catalog info) through
  task-aware context channels; close `NOT_EXPOSED` and discovery/service
  info/unnecessary handoffs.
- **Boundary:** Context Planner source selection + `AiRequest` channels
  (additive) + disclosure family mapping.
- **Preserved:** B-01 classification, provenance drop, tenant proof,
  duration/operational facts remain non-disclosable.
- **Tests:** `kn-service-catalog`, `st-service-discovery`,
  `kn-business-info-paraphrase`, `st-service-price`; `check:ai-context-builder`,
  `check:ai-disclosure`, `check:knowledge-visibility` stay green.
- **Depends on:** Slices 3/5. **Rollback:** stop carrying the new channels.

### Slice 7 — Handoff cause taxonomy + operator mapping

- **Goal:** typed causes end-to-end; distinguish policy refusal, provider
  failure, AI failure, knowledge gap, ambiguity.
- **Boundary:** contract `handoffCause`, gateway mapping, engine state +
  attention mapping, telemetry, `ActualOutcome.handoffOutcomeClass`.
- **Preserved:** lifecycle and explicit resume; attention remains coarse
  and jargon-free.
- **Tests:** provider-failure, AI-failure, disclosure-refusal, knowledge-gap,
  ambiguity each map to the right cause/channel.
- **Depends on:** Slice 3. **Rollback:** default cause to today's reason.

### Slice 8 — JEV strategy behind the gateway

- **Goal:** add an optional decision strategy that can terminate without an
  LLM or be the single generative call; no mandatory stage.
- **Boundary:** gateway strategy plug + policy selection.
- **Preserved:** zero-or-one call invariant; provider neutrality.
- **Tests:** termination paths, budget enforcement, provider-swap
  invariance, evaluation comparison current vs JEV target.
- **Depends on:** Slices 0, 3, 6. **Rollback:** disable the strategy.

### Slice 9 — Async knowledge-gap / self-improvement

- **Goal:** record structured gaps off the critical path; human approval
  gates promotion.
- **Boundary:** record-only module + repository; no request-path work.
- **Preserved:** turn latency and outcomes untouched.
- **Tests:** gap recorded on `KNOWLEDGE_GAP_UNRESOLVED`; no blocking; no
  auto-promotion.
- **Depends on:** Slice 7. **Rollback:** stop recording.

### Slice 10 — Evaluation targets for the target architecture

> **STATUS: BRIDGE STARTED (PROMPT-AI-EVAL-06).** The first `FUTURE_SYSTEM`
> evaluation target landed, evaluation-only and additive: `future-system-flowpilot`
> (`evaluation/runner/targets/future-system-flowpilot.ts` +
> `evaluation/runner/future-system-adapter.ts`). Unlike `real-llm-flowpilot`
> (which stops at the disclosure gate and cannot measure Slice 4), it drives the
> REAL configured provider/model THROUGH the real Conversation Engine
> (`receiveInboundMessage`) so a turn actually traverses `ConversationState` →
> `resolveTurnPlan()` → first-class CLARIFY → clarification handler →
> `TurnObservability`. It reuses the EXISTING production seams verbatim (NO second
> engine/resolver/state/clarification/contract/prompt pipeline); the ONLY
> evaluation boundary is isolated in-memory repositories so NO production data is
> read or written. The smallest additive CLARIFY-emission measurement
> (`evaluation/runner/clarify-measure.ts`) scores the ACTUAL observed
> resolver-owned decision (CLARIFY / ANSWER / DOMAIN_ACTION / HUMAN_HANDOFF /
> KNOWLEDGE_GAP / AI_FAILURE / PROVIDER_FAILURE) without touching the EVAL-03
> scoring engine, the DEFAULT_SCORERS, the dataset, or the gold labels. Guarded
> by `pnpm check:future-system` **18/18** (offline, stub-ai wiring:
> engine reached, TurnPlan observable, CLARIFY + resume + interruption, handoff +
> safety preserved, knowledge-gap separated, zero-or-one call, no production
> mutation, provider-neutral). A real-LLM calibration
> (`pnpm eval:run-future -- --calibration`) proved real inference reaching an
> observed CLARIFY (am-bare-booking-clarifiable → `CLARIFY_SERVICE`, AI_ACTIVE)
> and an ANSWER (st-service-discovery), zero-or-one call held. The focused
> real-LLM CLARIFY verification is a later evaluation prompt; no production
> source, prompt, provider policy, schema, or dataset changed.
>
> **STATUS UPDATE (PROMPT-AI-EVAL-09 — evaluation-path capability slice; still
> evaluation-only, no production change).** EVAL-08 found this bridge could
> exercise SUPPLIED_FACT_RESUME and INTERRUPTION_RECOVERY only deterministically:
> it reconstructed a pending clarification/task ONLY from the engine's OWN
> authored templates, which a real-LLM setup turn is not guaranteed to produce,
> so the resume/interruption paths never fired under a real LLM. Closed by an
> ENGINE-AUTHORED pending-state SEED (`evaluation/runner/pending-state-seed.ts` +
> `FutureSystemRunner.seedPendingState`): it replays DETERMINISTIC setup turns
> through the REAL Conversation Engine (ZERO real inference) so the engine
> authors its own clarification/booking-offer into the per-case history; the
> real-LLM turn then resumes through the SAME production reconstruction seams
> (`derivePendingClarification` + `deriveConversationStateFromHistory` + the ONE
> `mergeConversationState` resume path) — NO second state representation,
> resolver, or TurnPlan. `clarify-measure` additionally reports **RESUME_FAILED**
> (a clarification that re-asks an already-supplied fact), **PENDING_TASK_LOST**,
> and **INTERRUPTION_RECOVERY_FAILED**; a safety-required handoff is still never
> counted as an acceptable CLARIFY. Guarded by `pnpm check:future-system`
> **33/33** (F23–F33 new) and a BOUNDED real-Atria calibration
> (`pnpm eval:run-future-fixtures`): seed CLARIFY_DATE → the real LLM supplied
> the date → `DOMAIN_ACTION` resume (date NOT re-asked); seed a resumable offer →
> real-LLM interruption preserved the task (AI_ACTIVE) → return resumed
> (`DOMAIN_ACTION`); 3 real calls, 0 provider failures, zero-or-one held
> (`evaluation/reports/egyptian-v1/future-system-resume-interruption/`). This
> makes the evaluation path capable of an honest focused real-LLM re-verify —
> it does NOT start Slice 5.

- **Goal:** a `FUTURE_SYSTEM` target per stage so each slice is measured on
  `egyptian-v1` before it is enabled.
- **Boundary:** `evaluation/runner/targets/*` + new scorers (additive).
- **Preserved:** scoring engine and dataset untouched.

## 18. Backward compatibility during migration

- **Compatibility bridge (Slices 0/3):** no-goals decisions synthesize one
  goal; the planner can be disabled per turn; the engine keeps today's
  branch order when the planner is off.
- **State fallback (Slice 2):** derived state reproduces history-based
  understanding; persisted state is additive and ignored until consumed.
- **CLARIFY off by default (Slice 4):** the action is unreachable until the
  prompt/policy slice enables it; current behavior is the fallback.
- **Knowledge channels additive (Slice 6):** new request fields default
  absent; disclosure families unchanged until enabled.
- **Provider policy unchanged:** the active provider is never switched by
  this design; old behavior remains available by not enabling a new slice.
- **No big-bang cutover, no data migration required for the first slices.**

## 19. Risk register

| Risk                                               | Likelihood | Impact   | Mitigation                                                                                                             |
| -------------------------------------------------- | ---------- | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| Contract change destabilizes engine parity         | Medium     | High     | Additive optional fields + synthesis bridge; parity harness on every existing check before enabling                    |
| State becomes a second source of truth             | Medium     | High     | Explicit authority split; domain re-verified at execution; `pendingOffer` re-checked against CORE-02                   |
| Over-clarification annoys customers                | Medium     | Medium   | Bounds in §7; evaluation `CLARIFICATION_NOT_ASKED` + a new over-clarification check                                    |
| Multi-intent plan creates partial sends/duplicates | Medium     | Medium   | Single Response Composition boundary; one persist + one send; tests assert one outbound row                            |
| Handoff-cause refactor changes lifecycle           | Low        | High     | Lifecycle untouched; only cause metadata added; resume stays explicit                                                  |
| JEV becomes a hidden extra inference               | Medium     | High     | Gateway budget invariant + explicit forbidden-path tests                                                               |
| Slow provider degrades availability                | High       | High     | Latency budget in gateway; provider selection evidence; bounded retry only                                             |
| Safety weakening to lower handoff rate             | Low        | Critical | Precedence rules + sensitive tests + no policy relaxation; genuine misses tracked as defects                           |
| Evaluation scorer artifacts distort results        | Known      | Medium   | Safety scorer already flagged; fix scorer semantics as a separate evaluation-only change, never by changing production |
| Knowledge exposure surfaces operational facts      | Medium     | High     | B-01/B-02/B-03 unchanged; only public channels added; disclosure harness gates each channel                            |
| Scope creep into RAG/infra                         | Medium     | Medium   | Explicit deferral (§20) and no-vector rule                                                                             |
| Migration slices accidentally couple               | Medium     | Medium   | Each slice has its own contract + rollback; dependencies listed                                                        |

## 20. Deferred decisions

- Vector DB / embeddings / semantic retrieval (evidence does not require;
  revisit only on measured evidence).
- Exact persisted shape of `ConversationState` (JSON column vs dedicated
  table) — decide in Slice 2 with the storage review.
- Final production enum names/values for decision classes and handoff
  causes (align with evaluation vocabulary; decide in Slices 3/7).
- JEV's concrete nature (deterministic vs small model), ownership, and
  policy selection — decide in Slice 8 with cost/latency evidence.
- Provider routing strategy beyond primary/secondary/fallback.
- Per-business assistant style persistence (student to pilot evidence).
- Knowledge self-improvement promotion workflow and any queueing.
- Whether `MULTI_INTENT`/future semantic labels ever become production
  intents (they stay evaluation-only until a deliberate decision).
- Availability self-serve completion scope (currently `booking_handoff` is
  acceptable-by-design for many booking-journey cases).

## 21. Explicit list of things NOT to change yet

- **No production source change.** No `src/**` edits in this slice.
- **No prompt body change** (`/prompts/**` untouched; no prompt redesign).
- **No production intent/action enum change** (`aiIntentValues`,
  `aiActionValues`, `handoffReasonValues` untouched).
- **No schema or migration** (no `ConversationState` column yet).
- **No JEV implementation.**
- **No CLARIFY implementation.**
- **No Conversation State code.**
- **No Knowledge Retrieval code.**
- **No provider configuration change and no production provider switch.**
- **No change to the evaluation dataset, ground truth, or scoring engine.**
- **No second Conversation Engine, no second state machine, no RAG/vector
  DB, no queue/event-bus infrastructure.**
- **No commit, push, tag, release, or deploy.**

## 22. Test strategy (what future slices must satisfy)

At minimum (all offline, deterministic, no DB/network/LLM/secrets unless the
test explicitly targets a provider):

| Test                        | Guards                                                                |
| --------------------------- | --------------------------------------------------------------------- |
| Deterministic greeting      | zero-call bypass stays first-class                                    |
| Explicit human request      | immediate handoff, never swallowed (incl. clitic forms)               |
| Service discovery           | catalog exposure + answering intent                                   |
| Service discovery + booking | **the canonical multi-intent seam**                                   |
| Multi-intent                | primary + secondary retained; no forced handoff                       |
| Clarification               | safe clarify instead of handoff; resumes next turn; bounded           |
| Booking corrections         | revision replaces the prior fact (`jt-revise-date`)                   |
| Topic switching             | suspend/return (`re-long-context-topic-return`)                       |
| Knowledge exposure          | `NOT_EXPOSED`/catalog/info answered, not escalated                    |
| Arabizi / noisy Arabic      | register robustness at routing, not model-only                        |
| Sensitive + ordinary        | sensitive precedence; no weakening                                    |
| Prompt injection            | structured boundary holds; benign question still answerable per truth |
| Provider failure            | typed cause; deterministic safe acknowledgment, never silence         |
| Latency budget              | one call normal path; retry bounded; provider timeout respected       |
| Single-inference happy path | zero-or-one generative call is observable and asserted                |

Plus: every existing check suite stays green
(`check:ai-prompts`, `check:ai-context-builder`, `check:ai-disclosure`,
`check:knowledge-visibility`, `check:conversation-*`, `check:eval*`,
`check:eval-runner`), and each slice runs `pnpm verify` (+ `pnpm security`
where sensitive).

## 23. Decision-quality records (major choices)

Legend — **Evidence**, **Problem**, **Boundary**, **Alternatives deferred**,
**Perf effect**, **Quality effect**, **Migration complexity**,
**Confidence**.

### D1 — Keep one intent/action per turn? No: add optional goals + a deterministic planner

- **Evidence:** `mi-booking-plus-discovery` Atria 14/20, CodeCraft 17/20
  unnecessary handoff while pure discovery answers (0/8, 0/20); model lists
  the catalog but action stays `booking_handoff`.
- **Problem:** the contract cannot express "answer AND continue"; secondary
  goals are structurally unreachable.
- **Boundary:** `AiDecision.goals[]` (understanding) + engine
  `Decision/Action Resolver` (execution) + state (continuation).
- **Alternatives deferred:** prompt-only "answer secondary questions"
  (leaves the contract single-valued and action model-owned); automatic
  intent merging (loses precedence).
- **Perf:** 0 extra calls; plan is pure.
- **Quality:** directly targets the largest unnecessary-handoff cluster.
- **Migration:** additive contract + bridge; medium.
- **Confidence:** high.

### D2 — CLARIFY as a first-class decision class

- **Evidence:** ambiguity handling escalates ~94.5% of ambiguous turns
  (LLM); clarification accuracy ~54%; no clarify action exists.
- **Problem:** clarifiable turns become handoffs; `AMBIGUOUS` conflates
  "needs a question" with "needs a human".
- **Boundary:** resolver-owned decision class + bounded clarification
  handler; safe-by-policy (knowledge-free or backed).
- **Alternatives deferred:** prompt-only instruction to ask questions
  (still no action to represent it; model cannot own escalation policy).
- **Perf:** 0 extra calls.
- **Quality:** converts a large handoff band into one-turn resolution.
- **Migration:** medium (needs state + policy entry).
- **Confidence:** medium-high.

### D3 — Separate handoff causes from decision classes

- **Evidence:** engine maps AI failure, disclosure refusal, provider
  failure, and genuine handoff all to `NEED_HUMAN`; evaluation already
  models the distinction.
- **Problem:** operators and metrics cannot tell "customer asked for a
  human" from "the model broke".
- **Boundary:** `handoffCause` in the contract + gateway mapping + engine
  state/attention + telemetry.
- **Alternatives deferred:** replacing `handoffReason` wholesale (risky);
  adding causes is additive first.
- **Perf:** none.
- **Quality:** correct attribution; safer provider-failure behavior.
- **Migration:** low-medium.
- **Confidence:** high.

### D4 — One engine-owned Conversation State, domain authoritative

- **Evidence:** booking-state 35.5/48/48.9%; corrections and topic returns
  fail; today's only state is text re-parsing.
- **Problem:** no durable conversation understanding; every turn is amnesic.
- **Boundary:** engine-owned `ConversationState`; domain keeps authority;
  LLM proposes, engine validates.
- **Alternatives deferred:** LLM as state authority (forbidden); a second
  booking state machine (forbidden); full event-sourcing.
- **Perf:** none on the model path.
- **Quality:** unlocks corrections, partial answers, continuations, topic
  return.
- **Migration:** medium-high (storage review), but first slices derive from
  history with no behavior change.
- **Confidence:** high.

### D5 — Structured exposure, no RAG

- **Evidence:** real-LLM `PARAPHRASED_FAQ` FAILs are 0; residual knowledge
  FAILs are `NOT_EXPOSED`/catalog/channel gaps.
- **Problem:** public facts exist but lack request channels/intents.
- **Boundary:** Context Planner source selection + additive request
  channels; B-01/B-02/B-03 unchanged.
- **Alternatives deferred:** embeddings/RAG (adds infrastructure and a new
  failure surface without evidence).
- **Perf:** deterministic selection; smaller prompts.
- **Quality:** closes exposure-driven handoff/knowledge failures.
- **Migration:** low-medium.
- **Confidence:** high.

### D6 — JEV as an optional gateway strategy

- **Evidence:** no JEV exists; the deterministic bypass already proves
  zero-call termination works; two LLMs show contract-shaped failures.
- **Problem:** cheap routing/termination should be possible without making
  every turn pay for an extra inference.
- **Boundary:** strategy behind `AiProviderAdapter`/gateway with the
  zero-or-one call budget.
- **Alternatives deferred:** mandatory JEV→LLM; a separate classifier
  service.
- **Perf:** can reduce calls; must never add one on the normal path.
- **Quality:** task-dependent, must be measured by a future target.
- **Migration:** medium; last.
- **Confidence:** medium (design), low (value until measured).

### D7 — Latency budget in the gateway, provider-neutral

- **Evidence:** Atria p50 ≈30 s vs 16 s cap (48/62 calibration timeouts);
  CodeCraft p50 ≈10.5 s with retry inflating p95.
- **Problem:** slow providers turn timeout policy into a handoff-heavy
  "quality" result.
- **Boundary:** gateway budget/deadline + policy attempt timeout; no engine
  change.
- **Alternatives deferred:** provider-specific logic in the engine; more
  retries.
- **Perf:** protects the user-visible turn time.
- **Quality:** prevents measuring fail-safes as model behavior.
- **Migration:** low.
- **Confidence:** high.

### D8 — Preserve the existing provider abstraction

- **Evidence:** the 4-adapter seam + policy + conversation-control already
  isolate providers; EVAL-04C reused the Atria adapter with an override and
  changed no `src/` file.
- **Problem:** a target architecture must not couple the engine to a model.
- **Boundary:** keep `AiProviderAdapter` + factory + policy + control; add
  strategy plugs only.
- **Alternatives deferred:** a new "AI service" or router abstraction.
- **Perf:** n/a.
- **Quality:** preserves testability and swap-ability.
- **Migration:** none (reuse).
- **Confidence:** high.

---

## 24. Explicit confirmations for this slice

- **No production source changed.** No file under `src/` was created or
  modified.
- **No prompt changed.** `/prompts/**` and the generated artifact are
  untouched.
- **No schema/migration.** `prisma/` untouched.
- **No provider configuration change, no production provider switch.**
- **No JEV, no CLARIFY, no state-code, no retrieval-code implemented.**
- **No dataset, ground truth, or scoring change.**
- **No commit, push, tag, release, or deploy.**
- This document is design + decision record only; the repository remains
  the implementation truth.

## 25. Pointer index (where each design question is answered)

| Deliverable / question                                    | Section |
| --------------------------------------------------------- | ------- |
| Target architecture diagram                               | §2      |
| Component responsibility map (incl. not-know/replacement) | §3      |
| Decision flow                                             | §4      |
| Decision/action model                                     | §5      |
| Multi-intent (Q1)                                         | §6      |
| Clarification (Q2)                                        | §7      |
| Handoff (Q3)                                              | §8      |
| Conversation state (Q4)                                   | §9      |
| Knowledge/context (Q5)                                    | §10     |
| JEV (Q6)                                                  | §11     |
| Provider abstraction (Q8)                                 | §12     |
| Performance (Q7)                                          | §13     |
| Evaluation integration                                    | §14     |
| Observability                                             | §15     |
| Safety                                                    | §16     |
| Migration slices                                          | §17     |
| Backward compatibility                                    | §18     |
| Risk register                                             | §19     |
| Deferred decisions                                        | §20     |
| Things not to change                                      | §21     |
| Test strategy                                             | §22     |
| Decision-quality records                                  | §23     |

## 26. Locked decisions, open decisions, migration risks, deliberate non-goals

- **Locked:** the invariant `AI interprets → Domain decides → Conversation
orchestrates`; one engine; one availability/booking authority; one state
  model; one knowledge store; no RAG by default; zero-or-one generative
  call; tenant/secret boundaries; explicit-resume-only handoff lifecycle.
- **Open:** persisted state shape; final production enums; JEV nature; JEV
  policy entry; provider routing; knowledge promotion workflow.
- **Migration risks:** contract parity, state authority drift,
  over-clarification, multi-goal double-send, JEV hidden inference, slow
  provider as default.
- **Deliberate non-goals:** a token-accounting platform; a cost telemetry
  product; a generic workflow engine; omnichannel infrastructure; prompt
  editing in production; changing the evaluation dataset or scoring to make
  the new design look good.
