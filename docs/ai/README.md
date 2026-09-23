# FlowPilot — AI Prompt & Evaluation Separation

> Source-controlled, provider-neutral prompt artifacts and deterministic
> evaluation harness. Implementation boundary: `ARCHITECTURE.md` in this
> folder. Prompt catalog: `PROMPTS.md`. Evaluation fixtures: `EVALUATIONS.md`.
>
> Status: **the prompt BODY source of truth is `/prompts/**/*.prompt`.**
> Bodies are compiled at build time
> (`pnpm generate:ai-prompts`) into the committed runtime artifact
> `src/generated/ai-prompts.generated.ts` and loaded by
> `src/server/integrations/ai/prompt-registry.ts` — the runtime never touches
> the filesystem. The provider adapters (`openrouter`, `agentrouter`,
> `atria` — `src/server/integrations/ai/`) implement the SAME
> `src/features/conversations/server/ai-contract.ts` without touching the
> engine or domain, and are wired as the engine default through the runtime
> `PlatformAiPolicy` (DECISIONS #44; `createPolicyBackedAi` in
> `conversation-engine.ts`), with `deterministicConversationAi` as the safe
> fallback when the policy is unreadable. `PROMPTS.md` is now a catalog only
> (id / purpose / file path / runtime consumer) — it carries no prompt
> bodies; `pnpm check:ai-prompts` remains the deterministic, offline,
> in-memory guard (no DB, no network, no secrets).

## What lives where

| Artifact                                                | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompts/**/*.prompt`                                   | **Provider-neutral prompt BODIES — the versioned source of truth** (`system.booking-assistant`, `providers.atria.json-output`). No OpenRouter/AgentRouter syntax, no API keys, no provider hacks. Each declares `# prompt id: <id>`.                                                                                                                                                                                                                                                                                                          |
| `docs/ai/ARCHITECTURE.md`                               | AI boundary (who owns what) — Engine orchestrates, AI interprets, Domain decides. Context budget, **knowledge visibility policy (B-01)**, structured contract, invariants, Prompt Workspace source-of-truth rules, upgrade path.                                                                                                                                                                                                                                                                                                              |
| `docs/ai/PROMPTS.md`                                    | **Catalog only** — prompt ID, purpose, file path, runtime consumer. Plus the five code-owned deterministic classifier specs. No bodies.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `docs/ai/EVALUATIONS.md`                                | Minimal deterministic fixtures that prove behavior does not drift from the implementation (`deterministicConversationAi` + `ai-contract.ts`). Passing fixtures are required before any prompt change is released.                                                                                                                                                                                                                                                                                                                             |
| `src/lib/ai-knowledge-visibility/`                      | **The B-01 knowledge-visibility policy** — the four levels (`PUBLIC`/`CONDITIONAL`/`INTERNAL`/`FORBIDDEN`), source+tenant provenance, field classification, the FORBIDDEN categories, and the structural safe defaults. Says WHAT may enter AI context and, separately, what the AI may mention. Consumed by the Context Builder (B-02); no aggregation, no prompt assembly.                                                                                                                                                                  |
| `src/features/conversations/server/ai-context-builder/` | **The B-02 context builder** — the explicit AI boundary: classifies the engine's already-loaded source facts through the B-01 policy, proves tenant scope, gates CONDITIONAL facts on task relevance, omits INTERNAL operational facts that the task does not require, drops provenance, and composes the minimal `AiRequest`. Also emits the disclosure ledger ("AI may know" vs "AI may mention") for the B-03 gate.                                                                                                                        |
| `src/features/conversations/server/ai-disclosure/`      | **The B-03 customer disclosure boundary** — the enforcement gate between a validated `AiResponse` and a customer-visible reply. Reads the B-02 disclosure ledger and refuses to emit a self-authored reply whose task is not backed by an `included` + `disclosable` + carried fact, routing it to the existing `NEED_HUMAN` / `AI_HANDOFF` fallback. Structural only (action + intent + ledger verdicts): no text inspection, no redaction, no LLM.                                                                                          |
| `scripts/check-ai-prompts.ts`                           | Offline harness that enforces the workspace: registry↔files↔generated-artifact freshness, unique ids, variable contract, runtime consumes the generated artifact, no body re-inlined in TypeScript, no secrets, plus fixtures. No DB write, no API key needed.                                                                                                                                                                                                                                                                                |
| `scripts/check-ai-knowledge-visibility.ts`              | Offline harness that enforces the B-01 policy: four levels, eligibility-vs-disclosure separation, CONDITIONAL task-relevance gating, structural safe defaults, tenant exclusion, field classification, FORBIDDEN category coverage, and the "not a string redactor" invariant. No DB, no network, no secrets.                                                                                                                                                                                                                                 |
| `scripts/check-ai-context-builder.ts`                   | Offline harness that enforces the B-02 boundary: PUBLIC inclusion, CONDITIONAL relevance gating, INTERNAL omission (duration/working hours never leak), FORBIDDEN refusal, fail-closed provenance/tenant behavior, cross-tenant exclusion, no credential materialization, deterministic + deduplicated + non-mutating output, and the knowledge-as-data (no prompt-injection channel) invariant. No DB, no network, no LLM, no secrets.                                                                                                       |
| `scripts/check-ai-disclosure.ts`                        | Offline harness that enforces the B-03 boundary: PUBLIC disclosure, tenant scoping, CONDITIONAL task gating, INTERNAL/FORBIDDEN never customer-visible, credentialsRef stays a reference, provenance and policy names never surface, missing-provenance/conflict fail closed, AI failure and refused reply both take the existing `NEED_HUMAN`/`AI_HANDOFF` path (refused content never persisted nor sent), safe answers unchanged, no provider jargon, determinism, durationMinutes never disclosed. No DB, no network, no LLM, no secrets. |
| `scripts/generate-ai-prompts.ts`                        | Deterministic build-time compiler: `prompts/*.prompt` → `src/generated/ai-prompts.generated.ts`. `--check` mode fails on a stale artifact.                                                                                                                                                                                                                                                                                                                                                                                                    |

## How to use

```sh
pnpm generate:ai-prompts   # compile prompt bodies into the runtime artifact
pnpm check:ai-prompts      # drift guard + deterministic fixtures (no DB, no network)
pnpm verify                # full gate (lint + typecheck + format + build)
pnpm security              # secret scan (no key-shaped content in artifacts)
```

## Rules (binding)

- Prompts are **source-controlled text files** under `/prompts/` — not DB
  rows, not Markdown bodies, not Superadmin-editable at runtime, not
  generated by the LLM, not inlined in TypeScript.
- Runtime **Platform AI Policy** (`platform_ai_policies` — primary/secondary
  provider+model, fallback, secretRefs) is the SEPARATE concern that selects
  WHICH provider answers — it may be Superadmin-configured; prompt bodies
  may not.
- Prompts reference only `ai-contract.ts` (`AiRequest` → `AiResponse`) and
  the engine context shape — no Prisma, no booking writes, no invented slots,
  no chain-of-thought across the boundary.
- A semantic change requires a **new prompt id** + updated fixtures in
  `EVALUATIONS.md` + a green `pnpm check:ai-prompts` + a `DECISIONS.md`
  appendix.
- **Knowledge visibility (B-01)** is a separate concern from prompt
  identity and from the runtime provider policy: it decides what
  information is eligible to enter AI context and what the AI may mention
  to a customer (`src/lib/ai-knowledge-visibility/`; see
  `ARCHITECTURE.md → Knowledge visibility policy`). It is structural
  policy by source/field/provenance — never string-matching redaction,
  never a word blacklist.
- **Context assembly (B-02)** applies that policy at the boundary
  (`src/features/conversations/server/ai-context-builder/`; see
  `ARCHITECTURE.md → AI context builder`). Rule: **operational/internal
  facts are not forwarded to the LLM unless task-relevant and explicitly
  permitted** — service duration and working hours never enter context
  merely because they exist; availability enters only as the CORE-02
  result. The builder keeps "AI may know" and "AI may mention" distinct in
  its output.
- A/B testing, prompt marketplace, and DB-backed prompt management are
  explicitly **deferred** — do not build them here.

## Reading order

1. `ARCHITECTURE.md` — the boundary first (so prompts don't reinvent it).
2. `PROMPTS.md` — the catalog row for the prompt you are changing.
3. The `.prompt` file itself — that is where the text lives.
4. `EVALUATIONS.md` — the fixtures that guard them.
