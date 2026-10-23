# FlowPilot — Current State

> **Tier 0 cold-start snapshot** — read with `docs/AGENT_RULES.md` and
> `docs/DECISIONS_INDEX.md`. This is a concise orientation document, NOT a
> source of truth: canonical topic documents and the repository code override
> it. Implementation details live in `docs/BUILD_STATE.md`; decisions in
> `docs/DECISIONS.md`.

## 1. Verified Baseline & Production Status

- **Repository State (Verified):**
  - Branch: `feat/conv-core-03d3-provider-journey` (candidate PR for CORE-03D3, branched from `main` at PR #26 merged baseline, commit `f7b0cd09f1b4c205525cba9019d464189c529f11`).
  - Package Version: `v0.68.0` (SemVer minor increment over v0.67.0 baseline).
  - Baseline Commit: `f7b0cd09f1b4c205525cba9019d464189c529f11` (PR #26 merged baseline).
  - Working Tree: Provider journey acceptance and semantic dependency closure on the existing Conversation Engine (CORE-03D3). Validated and accepted the complete provider journey suite (A–F) spanning missing-service clarification with provider/date preservation, unique provider match with zero-model mechanical confirmation, unknown/ambiguous provider clarification, explicit ANY and controlled semantic REMOVE without resurrecting old preferences, default service retention and service change invalidation, and offer lifecycle protections. Repaired offer persistence failure in `runInboundTurn` (`conversation-engine.ts`) to return safe retry notices and suppress unpersisted actionable buttons on CAS save conflicts (`!ok`), verified by table-driven regression across `SERVICE`, `DATE`, and `SLOT` offers proving normal-save markup, conflict retry notices, markup suppression, 0 appointments, and uncorrupted facts. Produced bounded lexical dependency review in `docs/ai/ARCHITECTURE.md` accounting for reachable uses of legacy detectors, control signals, context gating, and bypasses, detailing exact timing (`explicitHuman` post-response in `resolveFinishedTurn`) and protocol boundaries (exact Telegram `/start` command protocol is mechanical 0-model, while natural greetings reach the generative model). Verified by dedicated acceptance suite `check:conv-core-03d3` (64/64 PASS) wired into CI (`.github/workflows/pr-validation.yml`).
- **Production Status (Read-Only Health Verified):**
  - Production health check `GET https://flowpilot-prod.vercel.app/api/health` returned:
    - `status: "ok"`
    - `version: "0.63.0"`
    - `commitSha: "3f87cf8a9e4ab4dfcc78529778b523fdcca64c41"`
    - `database: "connected"`
    - `deploymentReady: true`
  - Production database migrations and deployments are operator-authorized via GitHub Actions. No production config or database changes made.

## 2. Architecture & Invariants

- **Stack:** Feature-based modular monolith on Next.js 16 (App Router) + Prisma 7 with driver adapter (`@prisma/adapter-pg`) + Neon PostgreSQL + Vercel.
- **Tenancy & Isolation:** Tenancy enforced via `businessId` in repositories. UI visibility is not authorization.
- **Booking Invariants:** The `availability-service` is the sole booking authority and returns only genuinely selectable slots. Booking is strictly server-authoritative. Never build a second availability engine.
- **AI Trust Boundary:** AI interprets customer intent; domain rules decide availability and eligibility; conversation orchestrates. AI output is never authoritative for booking execution (DECISIONS #33).
- **Presentation:** Arabic-first, RTL-by-default (`dir="rtl" lang="ar"`), responsive shell (desktop right sidebar / mobile bottom nav), vertical-agnostic discovery copy.
- **Conversation Playground Alignment & Integrity Repair (CORE-03C1):**
  - CLI `pnpm convo:playground --mode current_engine` executes the real merged engine pipeline: `receiveInboundMessage` → structured capability routing → `createPolicyBackedAi` / provider adapter → turn planner / reconciliation → Booking Core → `InMemoryConversationStateStore` with CAS revision semantics.
  - Run-level `CurrentEngineExecutionSession` enforces whole-run physical HTTP attempt ceiling across multiple scenarios with hard request blocking on ceiling exhaustion.
  - Physical HTTP attempt counting at injected `fetchImpl` boundary (separates offline fixtures, live provider calls, estimates, and unknown tokens; never reports 0 for unknown usage).
  - Outbound `max_tokens` setting enforced in actual adapter payload to prevent runaway completions.
  - Model outputs (`modelExtraction`, `modelFactUpdates`) recorded separately from durable reconciled state (`reconciledKnownFacts`).
  - Offer replacement detected by offer identity (`offerBefore.id !== offerAfter.id` -> `OFFER_REPLACED`).
  - Full trace sanitization & deep redaction (`redactTrace`) creating a single public projection for both terminal display and disk export; preserves numeric token counts, usage structures, and completeness metadata while redacting credentials, authorization headers, arbitrary offer IDs, claim nonces, and callback payloads (`fp:<id>:<action>`) using stable local references for cross-turn identity comparison.
  - Forwarded `getLastTelemetry()` on `instrumentedAi` wrapper, ensuring the conversation engine receives real gateway/adapter telemetry, and strictly sourcing observed provider/model from execution telemetry rather than configured defaults.
  - Usage completeness tracked honestly per attempt within turns (`COMPLETE`, `PARTIAL`, `UNKNOWN`, `NOT_APPLICABLE`), keeping missing components, compatibility fields (`tokenUsageEstimate`), and totalTokens `null` when partial/unknown attempts exist, while preserving genuine zero-call counts for non-generative turns and retaining `knownTokensSubtotal`.
  - Evaluation verdict integrity: removed truthiness gate on `result.intent` so missing expected intents fail immediately, verified passing scenarios exit 0, and failing evaluations reach the failed-evaluation exit path with code 1.
  - Historical modes (`baseline`, `goal_driven`, `typesafe_jev`, `agent_c`) remain available and are strictly labeled by their respective architectures (`HYBRID_B`, `GOAL_DRIVEN_HYBRID`, `TYPESAFE_JEV_GOAL_DRIVEN`), preventing misattribution.
  - 13 Egyptian Arabic scenarios (`CE-01` to `CE-13`, 21 turns total) covering relative dates, Cairo/UTC date boundary, date/provider corrections, provider/time/date REMOVE semantics, FAQ interruptions, explicit factUpdates precedence, mechanical selection zero-call execution, invalid proposal clarification, and tracked known defect `CE-13` (false sensitive handoff on dialectal phrase 'مش مشكلة' due to sensitive keyword detector).
  - Verified by 76/76 offline automated acceptance checks (`pnpm check:conv-core-03c1`).
- **Quick Real JEV + LLM Smoke Evaluation (CORE-03C2):**
  - Authorized live envelope enforced: max 24 physical provider attempts ceiling, max 600 output tokens per generative request, 15-second per-attempt timeout, $0.10 planning budget.
  - Fail-closed operator opt-in (`--allow-paid` / `allowLivePaidCalls: true`); offline fixtures remain the default. Missing API keys fail before network.
  - Dual-mode usage normalization supporting both OpenAI (`prompt_tokens`/`completion_tokens`) and JEV (`input_tokens`/`output_tokens`).
  - Track A (Real JEV Decisions API: `typesafe/jev-1.13` via OpenRouter): 1 attempt, 230ms latency, $0.0000126 USD; bookingRequested evaluated with probability 0.97 against predeclared threshold >= 0.70 (separates transport and semantic checks; fails closed on low confidence, invalid type, missing answer, or provider error). Confirmed JEV contract is atomic question routing; structured entity extraction and SET/REMOVE fact updates are UNSUPPORTED by contract design. Findings describe our tested integration contract, not universal model incapability; single positive sample is a contract connectivity smoke test, not a statistical benchmark.
  - Track B (Real LLM: `deepseek/deepseek-chat` via OpenRouter): 11 attempts, max 204 output tokens, latencies <6.0s, $0.008104 USD (rate-based calculation). Direct booking (Case A), relative dates under Cairo timezone (Case B), date correction (Case C), FAQ interruption with state preservation (Case F), known sensitive defect reproduction (Case G; reproduces known application defect, not customer behavior success), and mechanical confirmation with 0 model calls (Case H) all passed.
  - Cases D and E stopped on Turn 1 (D on provider catalog resolution when service is omitted; E on scenario test assertion expecting canonical "morning" while schema accepted "الصبح"), so their live REMOVE continuations were not tested live.
  - Combined live campaign: 12 total physical attempts, $0.008117 USD expenditure (well within 24 attempt ceiling and $0.10 planning budget; note monetary estimates are not guaranteed provider-side dollar limits). Complete in-memory state and booking isolation. Reviewable evidence bundle preserved in `docs/conversation/CORE-03C2-SMOKE-EVALUATION-EVIDENCE.md`.
  - Strict repair boundary maintained: recorded provider catalog resolution, canonical time values, and legacy sensitive filtering as follow-up issues for evidence-based implementation (no phrase dictionaries or heuristic regexes).
  - Verified by 45/45 offline automated acceptance checks (`pnpm check:conv-core-03c2`) and 76/76 regression checks (`pnpm check:conv-core-03c1`).

## 3. Completed Capabilities (Verified in Repository)

1. **Spec A Core & Operations:** Dashboard, appointments agenda, Smart Create 1–6, customer directory, services catalog, knowledge authoring, and settings.
2. **Messaging Channels:**
   - **WhatsApp:** Meta Cloud API adapter, inbound webhook, identity resolution, provider-neutral transport contract.
   - **Telegram:** Provider-neutral transport sibling, Manager Bot provisioning (`@FlowPilotManagerBot`), customer `/start` welcome handler, Android standard-Telegram launcher.
3. **AI Orchestration & Observability:** Provider-agnostic adapter (Atria, CodeCraft, OpenRouter), minimal context builder (knowledge visibility), disclosure gate, turn evidence telemetry sink.
4. **JEV Operational Work (Completed):** JEV semantic strategy, shadow strategy, decisions provider, and offline evaluation harnesses (`scripts/check-jev-semantic.ts`, `scripts/check-jev-shadow.ts`) are fully built and tested. Lifecycle is closed; no open implementation tasks remain.
5. **Platform Conversation Lab:** Copy override registry, override services, and founder review UI at `/platform/conversation-lab`.
6. **Test Ingress Harness:** Synthetic inbound test business harness (`scripts/check-test-ingress.ts`, `src/features/conversations/server/test-business.ts`) for offline regression validation.

## 4. Current Boundaries & Inactive Holds

- **Meta WhatsApp Embedded Signup:** Implemented in code but kept on **DEFERRED / HOLD** awaiting external Meta App Dashboard configuration (`docs/INTEGRATION_CHECKPOINTS.md`).
- **Deferred Areas:** Billing, subscriptions, payments (DECISIONS #36); Spec B instrumentation/economics; multi-tenant branch routing beyond selective scoping.

## 5. Upcoming Direction: UX001 Workstreams & Welcome/Button UX Constraints

FlowPilot is currently in Product Discovery. The approved upcoming direction is **UX001**.
The immediate next product change following baseline conversation engine evaluation is the **Welcome and Button UX**.
The intended constraints are established here as architectural boundaries:

1. **Proactive /start welcome with contextual inline choices:** Welcomes incoming customers with contextual actions/buttons where channel supports it.
2. **Free text remains supported:** Customer may choose to type naturally at any point; buttons are assistive, never coercive.
3. **One state, planner, and Booking Core:** The existing single `ConversationEngine`, `resolveFinishedTurn`, and Booking Core remain authoritative.
4. **No parallel wizard:** Do not construct a second wizard or alternative conversation state machine for button clicks.
5. **No greeting keyword dictionary:** Greetings are recognized organically; do not build fragile regex/keyword greeting dictionaries.
6. **No reset of active tasks on greeting or /start:** A customer saying hello or re-triggering `/start` mid-conversation must not wipe active booking tasks or known facts.
7. **Valid default service skips redundant service questions:** When a business has a single service or an unambiguous default, skip asking "which service?" and proceed directly to scheduling.
8. **Staff ownership remains authoritative:** Handed-off or staff-assigned conversations stay assigned to staff; incoming buttons/messages do not silently unassign or override human staff.

Implementation tasks follow this planned sequence:

1. **BOOK-UX-00 — Booking Core Validation:** Validating booking creation flow, provider eligibility, availability coherence, and slot presentation.
2. **Receptionist Booking UX:** Receptionist booking workflow and availability-guided actions.
3. **Customer Chatbot Booking UX:** Conversational booking selection, mapper, provider-aware options, and confirmation.
4. **Founder Conversation Lab:** Platform copy overrides, prompt copy experimentation, and founder tuning.

_(Do not implement UX001 workstreams during documentation phases.)_

## 6. How to Continue

1. Read `docs/AGENT_RULES.md` for tier-based loading and task-scoped reading rules.
2. Locate the closest context via `docs/CONTEXT_MAP.md` or `pnpm context <name>`.
3. Open only the mapped doorway files and follow direct imports outward as needed.
