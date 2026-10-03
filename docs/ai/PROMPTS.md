# FlowPilot — Prompt Catalog

> **This file is a CATALOG, not a source of truth.** It lists prompt IDs,
> purpose, file path, and runtime consumer only. It carries **no prompt
> bodies** — the source of truth for every LLM instruction body is the
> matching `.prompt` file under `/prompts/`, and the code that owns a
> deterministic behavior is its own source of truth.
>
> Architecture: `docs/ai/ARCHITECTURE.md` (Prompt Workspace section).
> Generator: `pnpm generate:ai-prompts`. Drift guard:
> `pnpm check:ai-prompts`.

## Source-of-truth chain

```
  prompts/*.prompt            ← source of truth for LLM instruction BODIES
        │  (Git = version history; `# prompt id:` declares the stable id)
        ▼
  pnpm generate:ai-prompts    ← deterministic build-time compiler
        ▼
  src/generated/ai-prompts.generated.ts   ← committed runtime artifact
        ▼
  prompt-registry.ts → getPromptBody(id) ← loader (no filesystem at runtime)
        ▼
  buildPromptMessages() / provider adapter
```

The runtime never reads `/prompts/` at request time (Vercel/serverless). A
stale or missing generated artifact fails the build and the check, never a
silent runtime fallback.

The compiler's rule is deliberately lossless for instruction text: blank and
`#`-comment lines are dropped, each surviving line is trimmed, and the
result is joined with a single space. That is exactly what the retired
inline `[...lines].join(" ")` constants produced, so a `.prompt` file and the
code it replaced are byte-identical by construction — regenerating,
reordering, or relocating prompt text cannot change LLM behavior; only
editing the instruction text can.

## Runtime LLM prompt bodies (source of truth: `/prompts/`)

These are the only instruction bodies actually sent to an LLM.

| Prompt ID                     | Purpose                                                                                                                                                                                                                                                                                                                                  | File path                                    | Runtime consumer                                                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `system.booking-assistant`    | Provider-neutral SYSTEM instructions: classify the current Arabic customer message, emit strict `AiResponse` JSON only, bound facts, no chain-of-thought, and express ordered `goals[]` on genuine multi-intent turns (PROMPT-AI-ARCH-10 — single-intent omits `goals[]`; the deterministic resolver owns precedence/one-goal/one-send). | `prompts/system/booking-assistant.prompt`    | `buildPromptMessages()` in `src/server/integrations/ai/prompt.ts` — used by every adapter (openrouter / agentrouter / atria).       |
| `providers.atria.json-output` | Atria-only JSON-output hardening: exactly ONE directly-parseable JSON object, no markdown/prose/fences.                                                                                                                                                                                                                                  | `prompts/providers/atria-json-output.prompt` | `createAtriaAdapter()` in `src/server/integrations/ai/atria.ts` (atria only; augments, never replaces, `system.booking-assistant`). |

Provider-specific **instruction text** lives under `/prompts/providers/`
because it is genuinely sent to the LLM. The provider's
**execution/wiring/validation** (endpoint, secretRef, timeout, response
normalization) stays inside the adapter and is never a prompt.

## Deterministic classifier behavior (NOT LLM prompts)

These five specs document the deterministic classifier. They are **not**
prompt bodies, are **not** registered in `PROMPT_REGISTRY`, and are **not**
sent to any LLM. Code is their source of truth; the fixtures in
`docs/ai/EVALUATIONS.md` replay them.

| Spec ID                      | Purpose                                                | Owner (source of truth)                                                                            | Runtime consumer                                          |
| ---------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `booking-intent@v1`          | Classify a booking request → staff complete it         | `src/features/conversations/server/conversation-ai.ts` (`classifyCustomerMessage`, booking branch) | `classifyCustomerMessage` / `deterministicConversationAi` |
| `faq-match@v1`               | Answer verbatim from stored business knowledge         | `conversation-ai.ts` (`matchFaq` / `faqMatchScore` threshold)                                      | `classifyCustomerMessage`                                 |
| `availability-handoff@v1`    | Recognize "when are you free?" → staff send real slots | `conversation-ai.ts` (availability branch, post-FAQ)                                               | `classifyCustomerMessage`                                 |
| `reschedule-cancellation@v1` | Recognize mutation of an existing appointment          | `conversation-ai.ts` (cancellation-before-reschedule ordering)                                     | `classifyCustomerMessage`                                 |
| `human-request@v1`           | Explicit human request / sensitive / unknown → handoff | `conversation-ai.ts` (priority ordering) + `bypassDeterministicAi`                                 | `classifyCustomerMessage` / `bypassDeterministicAi`       |

Ordering, encoded in code: booking → FAQ → availability; cancellation before
reschedule; explicit-human → sensitive → unknown-question → other-ambiguous.

## Rules for adding a new prompt

1. Create `prompts/<category>/<name>.prompt`. The first comment line MUST be
   `# prompt id: <stable-id>` — the generator requires it.
2. Category directories are conventional only (`system/`, `faq/`, `booking/`,
   `handoff/`, `providers/`); the registry, not the folder, defines identity.
3. Register it in `PROMPT_REGISTRY`
   (`src/server/integrations/ai/prompt-registry.ts`) with `id`, `sourcePath`,
   `variables` (the `{{name}}` placeholders the builder resolves — `[]` when
   static), and `consumer`.
4. Run `pnpm generate:ai-prompts` (regenerates the committed artifact) and
   `pnpm check:ai-prompts` (proves registry ↔ files ↔ artifact agree).
5. Add a row to the runtime table above (catalog only — no body).
6. If the prompt changes live LLM behavior, add a fixture to
   `docs/ai/EVALUATIONS.md` and, when semantics change, a `DECISIONS.md`
   appendix.

## Rules for modifying an existing prompt

1. Edit **only** the `.prompt` file. Never inline a body into TypeScript —
   `pnpm check:ai-prompts` fails on a known body reappearing in runtime code.
2. Run `pnpm generate:ai-prompts` — the committed artifact must match source.
3. Run `pnpm check:ai-prompts`, the relevant AI/provider checks, and
   `pnpm verify`.
4. Review `git diff` before deciding the change is release-worthy.
5. A semantic change (priority, constraint, extraction shape, handoff
   reason) requires a new prompt **id**, not an in-place rewrite of a shipped
   one; append fixtures, never silently weaken an existing expectation.

## Provider-neutrality (binding, enforced by `pnpm check:ai-prompts`)

Prompt bodies contain **no** provider syntax — no `Authorization` /
`x-api-key` headers, no API keys or secret shapes (`sk-…`, private keys), no
model-hack strings (`gpt-4o` / `claude` / `gemini`), no `openrouter/…` or
`agentrouter/…` model refs, no tool-call DSL, no provider SDK names. Any
violation fails the check. Prompts reference only the contract (`AiRequest`:
`message`, `recentMessages`, `services` incl. optional task-gated
`price`/`description`, `faqs`, `providerPreference`, `availability`, optional
`businessAbout`, optional `businessAddress` (PROMPT-AI-OPS-21)) and the response shape (`AiResponse`: `intent`, `action`,
`content`, `extraction`, `handoffReason`, `summary`), validated by
`parseAiResponse` — unknown keys / `reasoning` are **stripped**, never
persisted.

## What an adapter does with a prompt

1. Loads the body via `getPromptBody(id)` — never a DB row, never a literal.
2. Renders `AiRequest` + the body into the provider's chat shape at call time
   through `buildPromptMessages()`.
3. Instructs the model to emit JSON only, matching `aiResponseSchema`.
4. Validates via `parseAiResponse` before returning — never trusted raw.

The engine's `bypassDeterministicAi` rule is honored inside every adapter:
decidable turns never reach a provider.
