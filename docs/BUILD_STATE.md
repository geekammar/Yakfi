# FlowPilot — Build State

> **THE authoritative implementation ledger** — the single answer to "what is
> the state of FlowPilot?". Read the `Current State` summary + `Next Step`
> only; everything else is reference. Keep updates MINIMAL: status, completed
> work, known issues, next step — never a diary. Per-prompt historical detail
> lives in Git history (`git log --oneline`, `git show <tag>`,
> `git show <tag>:docs/BUILD_STATE.md`) and `docs/DECISIONS.md`; condensed
> per-slice history is in `docs/archive/IMPLEMENTATION_HISTORY.md` (Tier 3).
> Reading policy: the context tiers in `docs/AGENT_RULES.md`.

**Product version: v0.75.1 (feature branch; candidate PR)** — `Bounded OpenRouter Attempt Timeout Adjustment (12s -> 18s)`. Baseline: v0.75.0 (PR #45 merged baseline, commit `b1e665d8b1b320d3c4694be7d2d9f95807490cf1`).

1. **OpenRouter Per-Attempt Timeout Adjustment**: Raised `OPENROUTER_TIMEOUT_MS` from 12,000 ms to 18,000 ms in `src/server/integrations/ai/openrouter.ts` to accommodate slower, structured generative completions without exceeding the client-side attempt abort timer.
2. **Whole-Turn / Attempt Timeout Separation**: Maintained strict separation between per-attempt timeout and whole-turn serving budget. Default factory composition leaves `servingTimeoutMs` unset, preserving the ~280s serving session deadline. Shorter explicit timeout overrides and shared serving deadlines remain fully authoritative and win over the 18s attempt default.
3. **Acceptance Verification**: Verified across 176/176 automated checks in `scripts/check-core-04b.ts` (including new Group S covering 13s response acceptance, 18s completion boundary, delayed body reads, explicit shorter overrides, shared serving deadline precedence, two-timeout retry exhaustion to NEED_HUMAN, and shadow isolation) and 166/166 in `scripts/check-exact-time-requests.ts`.

**Product version: v0.72.2 (feature branch; candidate PR)** — `Focused UX Clarity Fixes F01–F04`. Baseline: v0.72.1 (PR #38 merged baseline, commit `94116e98003c8488e572c596d238676879c52ec4`). Resolves four focused UX clarity items:

1. **F01 — Assistant Response Detail**: Traces persisted, form, and runtime default values in `assistant-settings-screen.tsx`. Clearly distinguishes inherited default (`الافتراضي الموروث: مختصر`) from explicit override (`تخصيص صريح`) via dedicated status badge and contextual guidance, while strictly preserving unset semantics (`null` in storage, `undefined` in form), initial clean dirty tracking (`isDirty = false`), and partial save behavior without silent persistence. Distinguishes unsaved form selection from persisted state. Verified across two complementary test layers: storage/resolver contracts in `scripts/check-assistant-settings.ts` (51/51 PASS) and full mounted component lifecycle in `src/features/assistant/components/assistant-settings-screen.test.tsx` (5/5 PASS in jsdom covering initial clean state, disabled Save button, name-only editing preserving unset detail in payload, explicit override rendering, and option selection payload submission), both wired into PR CI (`.github/workflows/pr-validation.yml`).
2. **F02 — Appointment No-Show Label**: Replaced incorrect label in `appointment-detail.tsx` with «تسجيل عدم الحضور», preserving `NO_SHOW` action, permissions, and eligibility.
3. **F03 — Neutral Channel Copy**: Replaced fixed WhatsApp copy across channel-neutral surfaces (`conversations/page.tsx`, `inbox-list.tsx`, `conversation-detail.tsx`, `customers-directory.tsx`, `customer-detail-screen.tsx`) with neutral Arabic phrasing, avoiding assumption or inference of channel from phone numbers or text.
4. **F04 — Date-Neutral Reminder Preview**: Replaced stale calendar date in `settings-screen.tsx` reminder preview with date-neutral, explicitly illustrative example («الأحد (مثال)»), preserving template selection without activating reminders or adding time-dependent infrastructure.

**Product version: v0.70.0 (feature branch; candidate PR)** — `CORE-04B: Global AI Stop and Shared Per-Turn Execution Limits — Focused Deadline Enforcement and Attempt-Ceiling Repair`. Baseline: v0.69.0 (PR #28 merged baseline, commit `acf540e39708408374d5f3df3838599fb3f0e67d`). Prevents unauthorized or excessive external provider execution through bounded, request-scoped operational controls without creating a second AI gateway:

1. **Global External-Model Stop**: Server-owned operational stop via environment flag `FLOWPILOT_AI_GLOBAL_STOP`. Truthy values (`"1"`, `"true"`, `"yes"`, `"on"`, case-insensitive) halt all external serving LLM, serving JEV, and shadow model HTTP requests across the factory path immediately. Falsy/absent (`"0"`, `"false"`, `"no"`, `"off"`, `""`) preserves normal authorized execution. Malformed or invalid non-empty values (e.g. `"stop"`, `"disabled"`, `"2"`) fail closed with machine-readable stop reason `"INVALID_CONTROL_CONFIG"`. Mechanical selections (Telegram `/start`, offer selection buttons) continue unharmed with 0 model calls; model-required turns fail gracefully through controlled safe handoff (`AI_FAILURE`), preserving durable facts and creating zero unintended appointments. Documented honestly: operational environment configuration requires process restart or redeployment on Vercel; it is not an instant live dashboard toggle, and halts future request dispatching without proactively aborting already in-flight network requests.
2. **Shared Per-Execution Serving-Attempt Allowance & Ceiling Repair**: Request-scoped execution session `ServingExecutionSession` (`src/server/integrations/ai/execution-limits.ts`) coordinates physical HTTP allowances across initial dispatch, Conversation Control retries, and secondary fallback. Defaults to 3 (2 primary + 1 secondary). Operators can lower the allowance via `FLOWPILOT_AI_MAX_SERVING_ATTEMPTS` (1 or 2); the ceiling is clamped at 3; non-positive/malformed values fail closed with `INVALID_CONTROL_CONFIG`. Programmatic overrides (`maxAttemptsOverride`) are validated and can only tighten operator limits (`Math.min(operatorLimit, override)`), never weaken them. The hard ceiling of 3 is enforced unconditionally across factory, orchestrator, and session entry points. Physical attempts are reserved (`session.recordDispatch(1)`) immediately before wire fetch dispatch; preflight rejections consume 0 attempts. Request-local scoping guarantees isolation across turns and tenants without global mutable state.
3. **Shared Non-Resetting Serving Deadline & Response-Body Protection**: Initial timeout establishes a non-resetting execution deadline timestamp (`deadlineTimestamp = startedAtMs + timeoutMs`). Timeouts are recomputed close to dispatch via `session.getRemainingTimeoutMs()`, preventing fresh time budgets on fallback. Effective timeout and abort listeners stay active throughout header resolution AND response-body consumption (`await response.text()`) in both `http.ts` and `jev-decisions-provider.ts`, with deterministic cleanup in `finally` blocks (implemented via standard `AbortController` and listener pairs). Aborted body reads are classified truthfully as `TIMEOUT` (not `INVALID_RESPONSE`). Response completion validity is strictly decoupled from request dispatch permission via explicit predicate `evaluateResponseCompletion`: post-body response completion verifies both shared session deadline (`session.isDeadlineExpired(completedAtMs)`) and request-level elapsed time against `effectiveTimeoutMs`; late completions on final allowed attempts (limit 1 or limit 3) unconditionally mark deadline exhaustion and return TIMEOUT errors instead of being accepted as successful due to attempt limit exhaustion, while in-time completions succeed normally. Dispatched requests that timeout remain counted as 1 physical attempt.
4. **JEV Boundary & Shadow Exposure Limits**: `JevStrategy.decide` forwards `options` with `session` and remaining deadline down to `JevDecisionsProvider.evaluate`, reserving attempt immediately before wire fetch and preventing double-recording. Spent serving JEV execution consumes 1 serving attempt and strictly blocks subsequent serving generative calls; non-authoritative shadow requests are isolated from serving allowance but halted by global stop. Maximum total physical exposure per inbound turn is strictly bounded at 4 requests (3 serving + 1 shadow). Process-local shadow daily counters are not distributed global limits.
5. **Truthful Evidence & Error Classification**: Bounded machine-readable stop reasons (`GLOBAL_STOP`, `ATTEMPT_LIMIT_EXHAUSTED`, `DEADLINE_EXHAUSTED`, `INVALID_CONTROL_CONFIG`) attached to `AiTelemetry.stopReason`, `AiRetryTrace.stopReason`, `TurnObservability.stopReason`, and `TurnEvidence.stopReason` (`flowpilot.turn.evidence@v1`). Succeeded executions always report `stopReason: null`.
6. **Acceptance Verification & CI Integration**: Verified by 159/159 offline automated checks in `scripts/check-core-04b.ts` (`pnpm check:core-04b`) covering groups A–R (including factory-level wiring, JEV deadline aborts, headers-first slow-body streaming cancellations, limit precedence table enforcement, sequential/concurrent turn isolation, and Group R final-attempt completion deadline repair & `evaluateResponseCompletion` predicate), wired into PR CI (`.github/workflows/pr-validation.yml`), with clean regression across all domain suites (`check:core-04a` 144/144, `check:jev-semantic` 118/118, `check:jev-shadow` 155/155, `check:version` v0.70.0) and lightweight local checks (`pnpm verify:local`).

**Product version: v0.69.0 (merged to main; PR #28)** — `CORE-04A: Production AI Physical-Attempt Accounting, Counter Semantics, Control Audit, and Post-AI Evidence Preservation`. Baseline: v0.68.0 (PR #27 merged baseline, commit `a0494c475c13d4b2f948d2b81891234b55737b42`). Makes production AI execution accounting truthful, preserves execution evidence on post-AI early returns, and audits existing execution controls:

1. **Truthful Physical HTTP Attempt Accounting**: Count physical HTTP requests actually dispatched over the wire at the injected fetch boundary (`http.ts`). Preflight configuration rejections that fail before network I/O report `httpAttempts: 0`. Dispatched network requests (including timeouts, aborts, network errors, and successful responses) report `httpAttempts: 1`.
2. **Unified Retry-Plus-Fallback Trace Aggregation**: Pure aggregation helper `aggregateExecutionTrace` (`orchestrator.ts`) unifies attempt traces across primary execution and secondary fallback. Combines sequential attempt records (1, 2, 3...) preserving provider, model, latency, and token metrics per attempt without double-counting or truncating fallback attempts (e.g. 2 primary + 1 secondary = 3 total physical attempts).
3. **Counter Semantics & Seam Honesty**: Defined distinct roles for execution counters: `modelCallCount` reflects logical serving activity (0 or 1), while `providerAttempts` reflects physical wire requests. Repaired JEV double-counting defect (`modelCallCount = providerAttempts + (jevCallSpent ? 1 : 0)`) by deriving logical activity independently from execution evidence without `@ts-expect-error`. When telemetry lacks physical HTTP evidence, physical attempts strictly remain `null` (never inferred from `attempts.length`). Mixed known/unknown attempts strictly aggregate to `null`.
4. **Serving vs. Shadow Isolation & Mechanical Honesty**: Serving JEV inference counts once as physical serving activity (1 attempt) and logical serving activity (1 call) when spent; non-authoritative shadow requests are tracked separately and cannot inflate serving counts or alter customer outcomes. Spent serving JEV attempt strictly blocks secondary generative execution. Mechanical protocol/button/numeric handling (e.g. choice "1" against active offer) truthfully reports `providerAttempts: 0`, `modelCallCount: 0`, and `providerStatus: "NOT_CALLED"` with zero shadow execution.
5. **Usage & Cost Honesty**: Token counts, provider attribution, and reported costs (`costUsd` via `parseReportedCost` with finite non-negative validation) are preserved per attempt in bounded `TurnExecutionAttempt[]` across retries and fallback on `TurnEvidence` and `TurnObservability`. Tracked cost completeness honestly (`costCompleteness`: `COMPLETE`, `PARTIAL`, `UNAVAILABLE`) and exported non-null OTLP JSON attributes without changing DB schema.
6. **Post-AI Evidence Preservation on Early Returns**: Repaired evidence dropping on offer-persistence CAS conflicts and clarification paths. `selectionReply` accepts optional `observability?: TurnObservability`, preserving actual current-turn physical HTTP attempts, logical model calls, provider attribution, `providerStatus`, `executionAttempts`, and cost completeness on post-AI offer CAS conflicts (`SERVICE`, `DATE`, `SLOT`) and clarification paths, while defaulting to `DETERMINISTIC_BYPASS` (`providerAttempts: 0`, `modelCallCount: 0`, `providerStatus: "NOT_CALLED"`) when omitted on pre-AI mechanical paths. `presentDateChoices` and `presentSlotChoices` accept and forward current-turn observability. Guaranteed multi-turn stale telemetry isolation so subsequent mechanical turns never inherit prior turn execution evidence. Preserved safe retry notice «حدث تعارض مؤقت أثناء معالجة طلبك، يرجى إعادة المحاولة.», keyboard suppression, zero appointments, and staff ownership.
7. **JEV Budget Approval Validation**: Shared validator `parseApprovedMonthlyBudget` (`factory.ts`) enforces a finite positive numeric USD value (> 0) for `FLOWPILOT_JEV_APPROVED_MONTHLY_BUDGET`. Blank, whitespace-only, zero, negative, non-numeric, NaN, and infinite values are rejected; emergency disablement remains authoritative. _Documented explicitly: Validating an operator-approved budget amount is an activation gate. It is not by itself enforcement of a global monthly spend cap._ The absence of an enforceable global monthly spend cap across distributed processes is preserved as an open CORE-04 gap.
8. **Acceptance Verification & CI Integration**: Verified by 144/144 offline automated checks in `scripts/check-core-04a.ts` (`pnpm check:core-04a`) covering groups A–Q (including Groups O, P, Q for post-AI offer CAS conflicts, stale telemetry isolation, and engine-level JEV/null physical integrations), wired into PR CI (`.github/workflows/pr-validation.yml`), with clean regression across all domain suites (`check:jev-semantic` 118/118, `check:jev-shadow` 155/155, `check:conv-core-03d3` 64/64, `check:version`) and lightweight local checks (`pnpm verify:local`).

**Product version: v0.68.0 (merged to main; PR #27)** — `CORE-03D3: Provider Journey Acceptance and Semantic Dependency Closure`. Baseline: v0.67.0 (PR #26 merged baseline, commit `f7b0cd09f1b4c205525cba9019d464189c529f11`). Resolves the remaining known provider-preference journeys using the current engine and produces a bounded account of reachable lexical dependencies:

1. **Provider-Preference Journeys Accepted (A–F)**:
   - **Journey A (Provider named, service omitted)**: Customer specifies provider and date without service under multiple services and no default; engine prompts for missing service via `ServiceOffer`; durable state preserves provider and date; customer selects service via mechanical choice; engine resolves provider eligibility for selected service and transitions directly to slot selection.
   - **Journey B (Unique provider match & zero-model confirmation)**: Provider matched against authoritative catalog ID; availability queried with exact provider scope; mechanical slot choice confirms booking with exact service, date, time, and provider with 0 additional model calls.
   - **Journey C (Unknown / ambiguous provider)**: Unknown or ambiguous provider prompts clarification via `ProviderOffer` with eligible catalog options + explicit ANY; preserves durable state without silent coercion to ANY, displays no internal UUIDs/tokens, and blocks appointment creation.
   - **Journey D (Explicit ANY & semantic REMOVE)**: Selecting ANY button or emitting semantic REMOVE clears provider from durable facts and mirrors (`knownFacts.provider == null`, `providerPreference === null`), queries unconstrained availability across all eligible providers, preserves service/date/time, and guarantees old preference is not resurrected on continuation turns.
   - **Journey E (Default service & service changes)**: Enabled default service retains automatic bypass when service omitted; explicit unknown service never silently becomes default; changing service drops service-dependent provider facts and revalidates eligibility.
   - **Journey F (Lifecycle protection & table-driven CAS conflict regression)**: Stale/foreign/consumed offers cannot mutate state; duplicate confirmation is idempotent (0 duplicate appointments); staff-owned conversations remain deferred to staff (0 calls, 0 writes). Repaired offer persistence failure in `runInboundTurn` (`conversation-engine.ts`) to return safe retry notices and suppress unpersisted actionable buttons on CAS save conflicts (`!ok`), verified via table-driven regression across `SERVICE`, `DATE`, and `SLOT` offers proving normal-save markup, conflict retry notices, markup suppression, 0 appointments, and uncorrupted facts.
2. **Bounded Lexical Dependency Review**: Produced bounded inventory in `docs/ai/ARCHITECTURE.md` accounting for reachable uses of `classifyCustomerMessage`, `detectTurnControlSignals`, `resolveTurnControlSignals`, `explicitHuman`, `nonCommittal`, `deriveTaskRelevance`, legacy date/time/provider interpreters, semantic capability routing, and deterministic bypasses, detailing control type, semantic replacements, remaining product risks, and migration dispositions. Clarified timing: `explicitHuman` executes post-response in `resolveFinishedTurn` (not before the prompt). Clarified greetings: exact Telegram `/start` command protocol is mechanical (zero-model), whereas natural greetings proceed to generative model; zero-model natural greetings do not exist on the structured path. Tracked remaining semantic debts separately without attributing them to CORE-04 (which remains physical attempt/cost controls and measurement).
3. **Acceptance Verification & CI Integration**: Verified by 64/64 offline automated checks in `scripts/check-conv-core-03d3.ts` (`pnpm check:conv-core-03d3`), wired into CI (`.github/workflows/pr-validation.yml`), with clean regression across all domain suites.

**Product version: v0.67.0 (merged to main; PR #26)** — `CORE-03D2: Semantic Safety Ownership and False-Handoff Repair`. Baseline: v0.66.0 (PR #25 merged baseline, commit `bcb63e8bb9af51012c4ea556745fce54b6f11d6f`). Fixes false sensitive escalations on harmless customer phrases (e.g. «أي وقت يناسبكم مش مشكلة») through the existing semantic boundary:

1. **Canonical Three-State Safety Assessment**: Defined `aiSafetyAssessmentValues = ["safe", "sensitive", "uncertain"]` on `aiResponseSchema` (`ai-contract.ts`). Structured generative turns carry a bounded assessment of contextual meaning, distinguishing negation/preferences from medical emergencies. On structured generative turns, valid assessment is strictly required; missing assessment fails closed at the capability-aware engine boundary (`isMissingRequiredSafetyAssessment`) via `AI_FAILURE` with 0 appointments and fact preservation, without keyword dependence.
2. **Pure Source-Selection Helper & Isolated Goal Contradiction Protection**: Centralized signal derivation in `resolveTurnControlSignals` (`conversation-ai.ts`): JEV-owned turns retain validated JEV semantic signals; structured generative turns use validated semantic `safetyAssessment` to replace broad lexical sensitive triggers (e.g. on «مشكلة») unless contradictory (top-level `handoffReason === "SENSITIVE"` or isolated HANDOFF goals with supported `intent === "SENSITIVE"` / `requiredKnowledge === "SENSITIVE"`), where safety cannot be downgraded; legacy/mechanical turns fall back to the deterministic lexical detector (`detectTurnControlSignals`).
3. **Safety Precedence & Existing Authority Preserved**: Explicit customer human requests (`CUSTOMER_REQUESTED_HUMAN`) stay authoritative over model claims. Staff-owned threads remain deferred to staff. Closed-day and domain constraints remain binding. Disclosure refusal (B-03 policy) triggers `POLICY_REFUSED` regardless of model claims. Uncertainty and missing assessments safely escalate without completing bookings.
4. **Prompt Workspace & Runtime Artifact**: Updated `booking-assistant.prompt` with contextual Egyptian Arabic safety instructions and explicit requirement on structured turns; regenerated `ai-prompts.generated.ts` via generator (verified byte-identical, 146/146 checks).
5. **Acceptance Verification & CI Integration**: Verified by 90/90 offline automated checks in `scripts/check-conv-core-03d2.ts` (`pnpm check:conv-core-03d2`), outbound HTTP system message and structured context wire verification, repaired offline CE-13 and Case G expectations, wired into CI (`.github/workflows/pr-validation.yml`), with clean regression across all domain suites.

**Product version: v0.66.0 (merged to main; PR #25)** — `CORE-03D1: Canonical Time Preferences and Reliable Removal on the Existing Engine`. Baseline: v0.65.0 (PR #24 merged baseline, commit `6cd0252640ad0b3f8089185dafef3c679e7a507b`). Makes customer time preferences consistent across the AI contract, semantic reconciliation, durable conversation state/mirrors, availability-option filtering, booking confirmation lifecycle, period-empty truthfulness, and offer invalidation/continuation:

1. **Single Canonical Vocabulary**: Defined `canonicalTimePreferenceValues` (`"morning" | "afternoon" | "evening"`) in `src/lib/validation/appointment.ts` and re-exported uniformly across contract, facts, and conversation engine boundaries.
2. **Strict Contract Validation Boundary**: `aiExtractionSchema.timePreference` and `aiSetFactUpdateSchema` strictly require canonical day-period values. Colloquial dialect terms (e.g. "الصبح") and unsupported exact-time strings (e.g. "10:30") fail schema validation rather than being accepted as valid machine preferences or silently falling through to unrestricted time.
3. **Availability Filtering & Pre-Ranking Alignment**: Booking Core `resolveBookingOptions` accepts optional `timePreference` and filters candidate slot pairs prior to global ranking with an optional `limit` parameter, enabling morning, afternoon, and evening slots to be discovered truthfully. `conversation-engine.ts` filters presentation options strictly to matching periods.
4. **Complete Booking Lifecycle Repair**: Preserved authoritative `timePreference` and `providerId` restrictions through display, confirmation (`completeBookingSelection`), and slot-conflict retry paths. Widened confirmation query limit (`limit: 50`) prevents valid evening slots from being rejected as stale due to top-3 shortlist truncation. Slot-conflict re-offers retain active restrictions.
5. **Truthful Period-Empty vs. Full Day**: Distinguishes period-empty (`NO_PERIOD_SLOTS`) from fully booked (`FULLY_BOOKED` / `CLOSED_DAY`). When slots exist on an open day but none match the requested period, truthful Arabic copy is returned ("لا تتوفر مواعيد في الفترة المسائية..."), durable facts are preserved, `AI_ACTIVE` is maintained with zero human handoff (`handoffCause: null`), bounded date/period choices are offered, and continuation works via explicit change or REMOVE.
6. **Persisted Noncanonical State Safety**: Guarded state consumption boundaries (inbound turns without time updates, `/start` command, and slot selections) to detect nonempty noncanonical values (e.g. legacy `"الصبح"`), prompt for clarification, invalidate incompatible slot offers, preserve unrelated facts, and support recovery via canonical SET or explicit REMOVE.
7. **Offer Lifecycle & Continuation**: Incompatible active and suspended slot offers are superseded or invalidated on preference replacement or explicit `operation: "remove"`. Removed preferences are cleanly expunged from durable knownFacts and compatibility mirrors without resurrecting on subsequent turns.
8. **Acceptance Verification & CI Integration**: Verified by 53/53 offline automated tests in `scripts/check-conv-core-03d1.ts` covering Behaviors A through J (including zero-model selection, duplicate prevention idempotency, Telegram callback selection, slot-conflict re-offer retention, seeded noncanonical persisted state, and clean regression), wired into CI regression checks (`.github/workflows/pr-validation.yml`), plus clean regression across all domain suites (`check:conv-core-03a`, `check:conv-core-03b2b1`, `check:conv-core-03c1`, `check:conv-core-03c2`, `check:booking-options`, `check:booking-modes`, `check:telegram-ux001`, `check:ai-prompts`, `pnpm verify:local`).

**Product version: v0.65.0 (merged to main; PR #24)** — `UX001: Telegram Welcome and Contextual Choices on the Existing Conversation Engine (Repaired)`. Baseline: v0.64.0 (PR #23 merged baseline, commit `73dd3d4bb24e6b923435de370fb5aac7ae33033d`). Implements the customer-facing Telegram welcome and contextual choices layer without creating a secondary wizard or separate conversation state machine. Extends the existing `booking-offer.ts`, `booking-selection.ts`, `conversation-engine.ts`, and Telegram integration boundaries (`telegram-webhook-handler.ts`, `telegram-webhook.ts`, `telegram-client.ts`, `telegram-transport.ts`):

1. **Protocol vs. Free-Text Boundary Restored**: Natural-language action shortcuts (`includes("حجز")`, `includes("استفسار")`, etc.) completely removed from `booking-selection.ts`. Deterministic handling strictly reserved for validated offer callbacks, explicit full-turn numeric selections (1..N), and genuine protocol commands. All ordinary prose, negation, corrections, and mixed requests reach the semantic path intact. `/start` command matches boundary `/^\/start(?:@[A-Za-z0-9_]+)?(?:\s|$)/i` (preventing `/starter` false-positives). Allowed callback actions strictly validated per offer kind; invalid/foreign tokens return typed stale status (`UNKNOWN_TOKEN`) without leaking callback payload to LLM as customer prose.
2. **Separated Presentation from Booking-Task Mutation**: Displaying `WELCOME` or `INQUIRY` offers never creates or mutates an `activeTask` (remains `state.activeTask ?? null`). Active booking offers (`SLOT` / `DATE`) in progress when an inquiry or welcome is opened are preserved in `suspendedOffer`, allowing clean resumption via main menu ("حجز موعد") or explicit "حجز هذه الخدمة" without fact loss or task destruction.
3. **Button Transitions and Facts Coherence**: Provider display names/candidates kept strictly distinct from resolved UUID provider IDs (`mapped.providerText` is never coerced into `providerId`). Selecting ANY provider ("أي مقدم خدمة متاح") removes provider preference from durable facts/mirrors and queries the unconstrained eligible provider set at the repository seam. Explicit provider selection persists canonical preference and queries constrained provider slots. Preserves `DEFAULT` vs `CUSTOMER` service provenance.
4. **Offer Lifecycle & CAS Commit Safety**: All state offer presentations audit `turnSession.commit()`; on CAS conflict (`!ok`), actionable keyboards are suppressed and concise retry notices returned to prevent stale callbacks. Text fallbacks are fully self-contained with numbered options (channel-neutral, no references to nonexistent buttons on non-interactive channels).
5. **Rigorous Behavioral Acceptance Suite**: All 14/14 automated scenarios passing (`pnpm check:telegram-ux001`), including controlled structured model response for free-text correction with exact durable facts and dependent offer invalidation, inquiry during active booking with full resumption, provider/ANY persistence and repository argument checks, authenticated webhook round trip with callback query acknowledgment, invalid token safety, and zero-model verification with positive controls. Wired into CI (`.github/workflows/pr-validation.yml`).

**Product version: v0.64.0 (merged to main)** — `CORE-03C2: Quick Real JEV + LLM Smoke Evaluation, Then Handoff to Guided Buttons UX`. Baseline: v0.63.0 (PR #22 merged baseline, commit `3f87cf8a9e4ab4dfcc78529778b523fdcca64c41`). Executes a small, timeboxed live smoke evaluation across real JEV Decisions API (Track A) and real LLM through `current_engine` (Track B), operating under strict envelope constraints: 12 total physical provider attempts (1 JEV + 11 LLM, within 24 ceiling), $0.008117 USD measured expenditure (within $0.10 budget), max 204 tokens per completion (within 600 limit), 15s timeout reached transport, with 100% in-memory isolation for state, appointments, and outbound messaging. Track A confirmed JEV 1.13 decisions contract routing against explicit predeclared positive threshold >= 0.70 (observed probability 0.97 for bookingRequested; separates transport from semantic checks; non-zero exit on failure) while proving structured fact extraction/SET/REMOVE updates are unsupported by contract design. Track A findings describe the tested integration contract (`POST /api/alpha/decisions`), not universal model incapability; one positive sample is a connectivity smoke test, not an intent benchmark. Track B proved real LLM (`deepseek/deepseek-chat` via OpenRouter) handles direct booking (Case A), relative dates under Cairo timezone reference (Case B), date correction with availability re-query (Case C), FAQ interruption with state preservation (Case F), known defect reproduction on sensitive detector false handoff for "مش مشكلة" (Case G; reproduces known defect, not customer behavior success), and mechanical confirmation with 0 model calls (Case H). Cases D and E stopped on Turn 1 (D on provider catalog resolution when service is omitted; E on scenario assertion expecting canonical "morning" while schema accepted "الصبح"), so their live REMOVE continuations were not tested live. Strict repair boundary maintained: recorded provider-catalog entity resolution, canonical time preference normalization, and colloquial false-sensitive detection as follow-up issues for evidence-based implementation rather than patching with prompt tuning or phrase heuristics. Full reviewable evidence bundle preserved in `docs/conversation/CORE-03C2-SMOKE-EVALUATION-EVIDENCE.md`. Verified by 45/45 automated offline safety checks (`pnpm check:conv-core-03c2`), 76/76 regression checks (`pnpm check:conv-core-03c1`), SemVer check (`pnpm check:version`), and clean `pnpm verify:local`.

**Product version: v0.63.0 (merged to main)** — `CORE-03C1: Align the Existing Playground with the Current Conversation Engine`. Baseline: v0.62.0 (PR #21 merged baseline, commit `8ff6182d5c74eb8ad98160ba6eee0388fe869240`). Extends the existing conversation Playground CLI (`scripts/convo-playground.ts`) with `--mode current_engine` to evaluate the actual merged conversation engine (`receiveInboundMessage` → structured capability routing with `requiredSemanticCapability: "structured_turn"` → `createPolicyBackedAi` gateway → `resolveFinishedTurn` planner → Booking Core → isolated repository doubles & `InMemoryConversationStateStore` with CAS revision semantics). Physical HTTP attempts are counted at the injected `fetchImpl` boundary and token usage is measured honestly (`UNKNOWN`/`null` instead of fixed increments; partial usage preserves subtotals). Integrates `CurrentEngineExecutionSession` enforcing a single whole-run physical attempt ceiling across scenarios with hard refusal, outbound `max_tokens` parameter enforcement in the adapter, model outputs captured separately from durable saved state, offer replacement detected by ID, and deep trace redaction (`redactTrace`) creating a single public projection for terminal output and disk persistence that preserves numeric token metrics and completeness while redacting credentials, arbitrary offer IDs, and callback payloads (`fp:<id>:<action>`). Forwards `getLastTelemetry()` on `instrumentedAi` wrapper, strictly sourcing observed provider/model from execution telemetry rather than configured defaults. Retains historical benchmark modes under distinct architectural labels (`HYBRID_B`, `GOAL_DRIVEN_HYBRID`, `TYPESAFE_JEV_GOAL_DRIVEN`) to prevent misattribution. Added 13 Egyptian Arabic scenarios (`CE-01`–`CE-13`, 21 turns total) focusing on relative dates with Cairo reference, Cairo/UTC midnight difference, date/provider corrections, provider/time/date REMOVE semantics, FAQ interruptions, explicit factUpdates precedence, mechanical selection zero-call execution, invalid proposal clarification, and tracked known defect `CE-13` (false sensitive handoff on dialectal phrase 'مش مشكلة'). Safe live execution is preflight-gated with required operator limits (scenario subset, max physical attempts, token limit, timeout, approved budget USD, and cost basis); paid live execution is blocked in this evaluation-readiness slice ($0.0210 USD conservative ceiling for 25 calls @ 5k in / 500 out on DeepSeek V3). Verified by 63/63 offline automated checks (`pnpm check:conv-core-03c1`), 13/13 scenario passes, and clean `pnpm verify:local`.

**Product version: v0.62.0 (merged to main)** — `CORE-03B2B1: Semantic-Authoritative Date, Time and Provider Facts`. Production baseline: v0.61.0 (commit `d4673e26d6993400f2501a28ab7068be1c58c7db`). Establishes validated AI proposals (`factUpdates` / `extraction`) and authoritative durable conversation state (`knownFacts`) as the sole sources of `date`, `timePreference`, and `provider` facts on structured semantic turns. Eliminates post-AI customer prose reinterpretation (relative dates, time-of-day phrases, provider title/name regex, and pending clarification single-fact binding) while preserving deterministic protocol selections (Arabic/Western digits, callbacks), calendar validity, operating hours, and domain conflict validation. PR #21 focused boundary repair completed: separated provider matching modes (`catalog_strict` vs `legacy`) so nonempty provider candidates never become `ANY_PROVIDER` via phrase dictionaries; strict-provider validation defect repaired so punctuation-only ("؟؟؟", "---"), diacritic-only ("َُِِّ"), and supplied empty/whitespace candidates strictly return missing/not_found and clarify instead of normalizing to `ANY_PROVIDER`; strengthened per-turn availability query assertions at the real repository seam; added booking-path competing-prose no-update coverage; and proved continuation & schema-vs-domain date validation. Verified by 101/101 offline automated test scenarios (`pnpm check:conv-core-03b2b1`), full domain regression suites, and clean `pnpm verify:local`.

v0.31.3–v0.31.8 committed DECISIONS #70–#75 (Telegram completion-path wire
fixes, the official-creation deep-link + Android launcher fixes, the customer
`/start` command, and Context Architecture V1). v0.31.1/v0.31.2 carry the
whole Telegram second channel (DECISIONS #63 → #67) committed + the #68
route-proxy routing fix. **The
second REAL live Telegram verification pass (DECISIONS #69, this slice) ran
against that deployment:** it LIVE-VERIFIED that all four #68 operator
blockers are now RESOLVED (the routing fix IS live, both Telegram migrations
are APPLIED, `TELEGRAM_MANAGER_BOT_USERNAME` IS present, health reports
v0.31.2 + `database:"connected"`) and that the whole server-side launch →
`ensureManagerWebhook` → real `/start` → `bindCreator` chain runs for REAL —
then **LIVE-PROVED a SECOND blocking defect no offline harness can see**:
the creation keyboard was sent with `request_managed_bot: {}`, and the real
Bot API rejects that wire shape (`400 can't parse KeyboardButton: Can't find
field "request_id"`), so the ONE customer action never reached the Admin and
no `managed_bot` event could ever be produced. FIXED in place (`request_id:
MANAGED_BOT_REQUEST_ID`) + guarded on three regression surfaces, **but NOT
deployed** — so the Telegram checkpoint stays at **LIVE E2E PENDING** with
ONE remaining operator action: deploy the current head, then re-run the ONE
live E2E from a fresh launch. See `Current State`.
Releases v0.20.0–v0.30.0 ship the
AI-trust boundary (B-01–B-03), the owner-facing UX surfaces (knowledge/FAQ,
services, appointment creation, reschedule), appointments/availability
coherence, Meta Embedded Signup, the #58 disclosure-silence fix, the CodeCraft
Discovery provider, the #60 AI-failure acknowledgment fix (v0.29.4), and the
#61 shared conversation-layer UX + #62 AI personality / operator-notification /
conversation-UX slices (both released in v0.30.0 — the two slices this ledger
previously described as uncommitted). A post-v0.30.0 **Telegram channel
discovery pass** (DECISIONS #63) mapped the exact second-channel seams and
confirmed the Telegram Managed Bot provisioning path; **the identity/data
foundation it identified is now BUILT (DECISIONS #64): the provider-neutral
external-handle identity seam + the `TelegramConnection` and single-use
`TelegramProvisioningLedger` tables + repository-only access + one additive
migration (WhatsApp behavior unchanged), and the Telegram transport sibling —
adapter, webhook, and Conversation-Engine bridge — is now BUILT too
(DECISIONS #65 — this slice; see `Current State` and `Next Step` for the
boundary of what this slice does NOT claim).**

## Current State (summary)

**IN-FLIGHT (PR ready on branch `feat/conv-core-03c2-smoke-eval`) — QUICK REAL JEV + LLM SMOKE EVALUATION, THEN HANDOFF TO GUIDED BUTTONS UX (CORE-03C2)**:
A small, timeboxed live evaluation slice connecting the existing `current_engine` conversation playground and existing JEV integration to real provider transports under strict envelope limits, verifying real provider contracts and establishing the handoff to the Welcome and Contextual Buttons UX:

1. **Authorized Live Envelope & Resource Enforcement**:
   - Enforced ceilings: max 24 total physical provider attempts (JEV + LLM combined), max 600 output tokens per generative request, 15-second per-attempt timeout, $0.10 planning budget, single evaluation campaign.
   - Dual-mode usage normalization supporting both OpenAI (`prompt_tokens`/`completion_tokens`) and JEV (`input_tokens`/`output_tokens`).
   - Verified OpenRouter DeepSeek V3 cost basis: $0.2574/M input, $1.0287/M completion.
   - Fail-closed explicit operator opt-in (`--allow-paid` / `allowLivePaidCalls: true`); offline fixtures remain the default. Missing API keys fail before network.
   - Complete isolation: in-memory state store, in-memory appointments, zero outbound WhatsApp/Telegram messages, zero production DB mutations.

2. **Track A — Real JEV Decisions API Evaluation (`typesafe/jev-1.13` via OpenRouter)**:
   - Endpoint: `POST https://openrouter.ai/api/alpha/decisions` with observed model `typesafe/jev-1.13-20260917` by `TypeSafe`.
   - Measured usage: 1 physical attempt, 230ms latency, 340 input tokens, 24 output tokens, provider-reported cost $0.0000126 USD.
   - Evaluated question: `bookingRequested` (noul) -> probability 0.97 against predeclared explicit positive threshold >= 0.70 (0.70 represents clear positive booking intent confidence).
   - Separated transport success from semantic success; failed Track A produces non-zero CLI exit in both `--track jev` and combined run.
   - Contract boundary confirmed: contract evaluates atomic questions (`noul`/`choice`). Rejects partial answer sets (`EMPTY_RESPONSE`). Structured entity extraction and factUpdates (SET/REMOVE) are UNSUPPORTED by JEV contract design.
   - Integration finding context: findings describe our tested integration contract (`POST /api/alpha/decisions`), not universal model incapability; a single positive sample is a contract connectivity smoke test, not a statistical intent-accuracy benchmark.

3. **Track B — Real LLM through Current Engine (`deepseek/deepseek-chat` via OpenRouter)**:
   - Evaluated Egyptian Smoke Corpus (Cairo reference: 2026-10-20T10:00:00.000+03:00):
     - Case A (Direct booking): PASS (intent BOOKING, date 2026-10-21, availability queried, slot offer generated).
     - Case B (Relative date): PASS ("عايز أحجز بكرة" -> derived date 2026-10-21 from Cairo reference).
     - Case C (Date correction): PASS ("لا خليها الخميس" -> updated date 2026-10-22, availability re-queried).
     - Case D (Provider preference removal): FAIL on Turn 1 at entity resolution / domain validation (customer omitted service; model proposed "دكتورة سارة", catalog name "د. سارة عادل", domain reported provider unavailable for service; execution stopped on Turn 1, so **Turn 2 live REMOVE continuation was not tested**).
     - Case E (Time preference removal): FAIL on Turn 1 at scenario test assertion (model extracted Arabic dialect literal "الصبح"; engine and schema accepted it into state; scenario test harness assertion failed expecting canonical English "morning"; execution stopped on Turn 1, so **Turn 2 live REMOVE continuation was not tested**).
     - Case F (FAQ interruption): PASS (address question answered, booking facts strictly preserved).
     - Case G (Known defect): PASS on defect reproduction ("مش مشكلة" matched `SENSITIVE_WORDS`, triggering false handoff before planTurn completes; **reproduces known application defect, not customer behavior success**).
     - Case H (Mechanical confirmation): PASS (selection "1" executed with 0 model calls, appointment confirmed in isolated repository).
   - Measured live campaign usage: 11 LLM physical attempts, max 204 output tokens, latencies <6.0s, $0.008104 USD (rate-based calculation). Combined campaign total: 12 attempts, $0.008117 USD (within $0.10 planning budget; note monetary estimates are not guaranteed provider-side dollar limits). Sanitized reviewable evidence bundle preserved in `docs/conversation/CORE-03C2-SMOKE-EVALUATION-EVIDENCE.md`.

4. **Strict Repair Boundary & Follow-Up Issues**:
   - Zero prompt tuning, keyword dictionaries, or regex patches applied to force failing cases to pass.
   - Recorded follow-up issues for evidence-based implementation in proper slices:
     - Entity Resolution: doctor name variants (`"دكتورة سارة"` vs catalog `"د. سارة عادل"`) require service-scoped alias normalization when service is unstated.
     - Canonical Time Values: Arabic dialect time-of-day phrases (`"الصبح"`) require canonical vocabulary normalization (`"morning"`) in the AI response normalizer pipeline.
     - Colloquial False-Sensitive Filtering: `"مش مشكلة"` in `SENSITIVE_WORDS` causes premature false handoff on polite Egyptian colloquialisms.

5. **Automated Verification**:
   - Automated offline safety suite `scripts/check-conv-core-03c2.ts` (45/45 PASS): offline transport isolation, preflight limit enforcement, attempt exhaustion refusal, max_tokens 600 payload assertion, timeout propagation, Track A threshold / failure separation (positive, low probability, invalid type, missing answer, provider failure, shared session ceiling), and offline corpus replay.
   - Regression baseline `scripts/check-conv-core-03c1.ts` (76/76 PASS).
   - Version check `pnpm check:version` (PASS) and `pnpm verify:local` (PASS).

**PREVIOUS (PR #22 merged into `main` at `3f87cf8a9e4ab4dfcc78529778b523fdcca64c41`) — ALIGN THE EXISTING PLAYGROUND WITH CURRENT CONVERSATION ENGINE (CORE-03C1)**:

1. **Structured Semantic Path Precision (`conversation-engine.ts`)**:
   - Explicit boundary `isStructuredSemanticTurn` derives from `effectiveCapability === "structured_turn" && !deterministicBypass && turnRouting === "LLM" && turnTelemetry?.finalProvider !== "deterministic" && deps.ai.providerName !== "deterministic" && validated !== null`.
   - Never infers authority from message prose, policy fallback, or invalid provider responses.
2. **Elimination of Post-AI Fact Reinterpretation**:
   - `resolveFinishedTurn`: Egyptian relative date parser (`resolveEgyptianRelativeDateDetailed`), time-of-day preference extractor (`extractTimeOfDayPreferenceDetailed`), provider preference extractor (`extractProviderPreferenceDetailed`), and historical message scans are guarded from executing on structured semantic turns.
   - Pending single-fact clarification binding is restricted so arbitrary customer prose sentences are never bound as `date`, `timePreference`, or `provider` facts when AI proposals omit them.
   - `runInboundTurn`: Inbound relative date helper, time helper, provider helper, historical past appointment scans, and "same doctor" (`sameDoctorRequested`) prose regex are strictly deactivated on structured semantic turns.
   - Final slot filtering reads validated `extraction.timePreference` directly from state/turn reconciliation without falling back to `extractTimeOfDayPreference(inbound.text)`.
3. **Domain Validation & Protocol Invariants**:
   - SET: proposed value validated and merged via existing `reconcileTurnSemanticFacts`; domain verifies format, operating hours, and provider eligibility.
   - REMOVE: clears fact in durable state and mirrors, invalidates dependent slot offer, and widens provider/time availability without reviving from transcript history.
   - NO UPDATE: authoritative durable value preserved; missing facts prompt explicit clarification rather than lexical guessing.
   - Conflicting extractions cannot defeat explicit factUpdates (last-valid-operation precedence).
   - Zero-model mechanical selections (Arabic/Western digits, callback tokens) and staff-assigned thread safety remain untouched.
4. **Provider Boundary Repair & Query Strengthening (PR #21 Repair)**:
   - Separated provider matching modes in `matchProviderByName`: added `{ mode?: "legacy" | "catalog_strict" }`. Structured semantic turns (`isStructuredSemanticTurn`) execute in `catalog_strict` mode, bypassing `isAnyProviderPhrase`. Nonempty candidate phrases such as "أي دكتور" or "مش فارق" must resolve against the eligible provider catalog or return `status: "missing", reason: "not_found"` prompting clarification; `null` provider permits all eligible providers (`status: "any"`).
   - Repaired strict-provider normalization defect: in `catalog_strict` mode, supplied empty/whitespace-only input (`""`, `"   "`), punctuation-only candidates (`"؟؟؟"`, `"---"`), and diacritic-only strings (`"َُِِّ"`) normalize to empty needle and strictly return `status: "missing", reason: "not_found"`, requiring provider clarification rather than erroneously falling back to `ANY_PROVIDER`. Legacy callers retain full legacy phrase and normalization fallback.
   - Per-turn availability query assertions strengthened across all scenarios using capture slicing (`capturedAvailabilityQueries.slice(beforeCount)`), asserting exact query counts, `businessId`, `date`, and `assigneeIds` at the repository seam without inspecting unrelated prior queries.
   - Added booking-path no-update scenario (A4) exercising the booking seam: proves durable facts (service, date, timePreference, provider) remain unchanged under competing prose, dispatched query uses prior date and provider, and downstream slot filtering respects prior morning preference.
   - Extended continuation & validation evidence: persistent absence of removed facts across turns, pending date/time clarification safety against arbitrary sentence binding, and clean separation of schema calendar date rejection (`AI_FAILURE`, 0 queries) from domain closed-date rejection (`DOMAIN_REQUIRES_HUMAN`, safe handoff, 0 appointments).
5. **Acceptance Verification (`scripts/check-conv-core-03b2b1.ts`)**:
   - Competing prose turns (A1–A4g): prose date/time/provider does not overwrite state or invalidate offers on FAQ turns, and booking turns strictly adhere to durable state.
   - Explicit changes (B1–B6f): colliding first names resolve full entity to eligibility query; date updates agree across state/query/offer; REMOVE clears provider/time/date with appropriate offer invalidation and unconstrained queries; conflicting extraction defeated by explicit factUpdates.
   - Persistence & continuation (C1–C5i): removed facts do not revive; valid new SET accepted; raw prose ('بكرا') not converted to date after AI omission; arbitrary sentences not bound as provider/date fact under pending clarification; schema vs domain calendar validation.
   - Provider boundary (P1a–P3e): pure unit verification of legacy vs catalog_strict provider matching including punctuation, diacritics, empty/whitespace strings, and legacy compatibility; controlled model proposal with "أي دكتور" and punctuation-only "؟؟؟" downstream tests proving engine requests provider clarification, dispatches 0 availability queries for all providers, creates 0 appointments, and issues no valid slot offer.
   - Existing product boundaries (D1–D6c): zero-model digit selections; mixed prose reaches AI; consumed offers protected; default service applies; unknown explicit service clarified; staff-assigned threads defer with zero model calls.
   - Verified by `pnpm check:conv-core-03b2b1` (101/101 PASS), all predecessor suites (`conv-core-01`, `02`, `03a`, `03b1`, `03b2a`, `conversation-c2`), `check:version`, and clean `pnpm verify:local`.

**PREVIOUS (PR #20 merged into `main` at `d4673e26d6993400f2501a28ab7068be1c58c7db`) — CAPABILITY-SAFE ROUTING FOR FREE-FORM CONVERSATION TURNS (CORE-03B2A)**:
One bounded slice ensuring free-form customer turns reaching the semantic boundary request full structured conversation capability and use an existing generative provider path capable of returning AiResponse (extraction, goals, factUpdates) without premature interception by bounded JEV decision strategies or free-text lexical bypasses:

1. **Server-Derived Semantic Capability Contract (`ai-contract.ts`, `ai-context-builder/context-builder.ts`)**: Added provider-neutral `requiredSemanticCapability: "structured_turn"` to `AiRequest`. Stamped server-side by the engine after mechanical selection yields; cannot be forged or requested by customer message text. Zod schema strictly validates and preserves the contract across boundaries without leaking internal metadata onto the generative model wire.
2. **Capability-Safe Engine & Gateway Routing (`conversation-engine.ts`, `orchestrator.ts`, `jev-semantic-strategy.ts`)**:
   - Engine skips `bypassDeterministicAi` when `requiredSemanticCapability: "structured_turn"`, preventing premature lexical bypass of free-text turns.
   - Orchestrator routes requests requiring `"structured_turn"` directly to capable generative primary adapters before evaluating bounded JEV decision strategies or shadow runs.
   - JEV strategy marks `"CAPABILITY_STRUCTURED_TURN"` as ineligible, returning immediately without executing external classification or legacy delegation chains.
   - Preserves 100% backward compatibility for legacy callers without the capability contract.
3. **Zero-Model & Downstream Contract Guarantees**:
   - Deterministic numeric selections ("١", "1") and offer callbacks (`fp:<token>:<action>`) remain zero-model operations handled by booking core before AI invocation.
   - State reconciliation preserves authoritative explicit `factUpdates` (`operation: "set" | "remove"`), unaffected by stale/conflicting extractions.
   - Safe handoff to `NEED_HUMAN` on invalid provider output without guessing appointments.
4. **Acceptance Verification (`scripts/check-conv-core-03b2a.ts`)**:
   - Actual routing with JEV configured: 0 JEV HTTP attempts spent on free-form turns requiring structured_turn, exactly 1 generative HTTP request captured, customer text arrives intact with temporal/conversation context (A1–A5h).
   - Mechanical paths & zero-model guarantees: Arabic/Western digit selections and offer callbacks execute with 0 model calls; positive controls verify HTTP attempt counters and valid evaluation for both provider paths (B6a–B10b).
   - End-to-end state behavior: provider REMOVE clears preference, date correction reaches state, dispatches availability query for corrected date, updates active typed slot offer and rejects replaced old-date offer, explicit factUpdates override conflicting extraction, invalid output creates no appointments (C11a–C14b).
   - Policy & wire invariants: real policy-backed AI factory exercises prohibited/invalid fallback and allowed generative route, staff assignment defers, legacy callers preserved with real bounded JEV inference on eligible turns and 0-call bypass for greetings, single model call spent without duplicate chains, metadata wire privacy preserved (D15a–E21).
     Verified by `pnpm check:conv-core-03b2a` (47/47 PASS), all predecessor suites (`conv-core-01`, `02`, `03a`, `03b1`), and clean `pnpm verify:local`.

**IN-FLIGHT (uncommitted, awaiting operator review) — `PROMPT-OPS-REL-01` +
`PROMPT-OPS-REL-01-R`:
CANONICAL PRE-SHIP GATE + RELEASE CONTRACT — one repository-owned, deterministic
pre-release checkpoint replacing the procedural "remember to run pnpm verify"
dependency; the SemVer choice and the shipping action stay explicitly human.
ZERO product/domain/schema/provider change; no commit/push/tag/deploy.**
Adds `pnpm pre-ship` (scripts/pre-ship.mjs + scripts/pre-ship-lib.mjs): a
strictly non-mutating, OFFLINE gate that COMPOSES existing canonical commands —
git baseline + exact release candidate → `git diff --check` → `pnpm security` →
`pnpm check:ai-prompts` → `pnpm verify` → a non-mutation witness — and
classifies risk surfaces over the candidate plus any unpushed commits (DB
schema, auth/security, release tooling, deploy/CI config, env contract = HIGH →
`MANUAL_RELEASE_REVIEW_REQUIRED`; AI/provider/conversation/booking/transport/
copy-lab = elevated → routed `check:*` evidence). Decision vocabulary:
`PRE_SHIP_GREEN` / `PRE_SHIP_BLOCKED` / `MANUAL_RELEASE_REVIEW_REQUIRED`
(human stays the SemVer authority; nothing is bumped, committed, or shipped).
`PROMPT-OPS-REL-01-R` removed one proven contradiction in that contract: the
gate demanded a CLEAN working tree while `ship` owns the release commit of the
implementation working tree (`git add -A` + one release commit) — so the
recommended `pnpm ship patch --ack-manual-review` could never run (reproduced:
real `pnpm pre-ship` → `PRE_SHIP_BLOCKED` at git-state on the 8 intended
paths). The invariant is now **EXACT, INSPECTED, STABLE RELEASE CANDIDATE**: the
candidate is the precise set `git add -A` would commit (`git diff HEAD` +
`git ls-files -o --exclude-standard`; porcelain is NOT the source of truth
because it collapses untracked directories), fingerprinted with sha256 per path
so a gate that mutates it fails closed and ignored build artifacts (`.next/`,
`*.tsbuildinfo`) cannot create false drift. `scripts/ship.mjs` requires the
canonical gate before its first mutation, re-checks the fingerprint, and after
`git add -A` re-proves the stage is exactly the reviewed candidate + the
version-bump delta. Repository-owned regression proof `pnpm check:pre-ship`
(scripts/check-pre-ship.mjs): 27/27 green (R1–R12) — dirty tracked candidate
accepted, untracked files cannot escape inspection, failing gate blocks ship
before any mutation, mutating gate fails closed, HIGH → manual review + ack
gate, ambiguous baselines fail closed, the REAL OPS-REL-01 candidate reaches
`MANUAL_RELEASE_REVIEW_REQUIRED` (not blocked for being dirty), mutation-seam
exactness, a secret in an untracked candidate file blocked without printing its
value (the genuine scanner is copied into the fixture), empty candidate fails
closed, and the real tree is untouched. Real full-gate run on the live working
tree: all six gates PASS (verify 54.7s; candidate fingerprint stable across
`next build`) → decision `MANUAL_RELEASE_REVIEW_REQUIRED` (this slice IS
release tooling) with a bounded PATCH recommendation. docs/RELEASE_PROCESS.md +
docs/QUALITY_CHECKS.md updated to the ONE corrected contract.
**Files changed:** `scripts/pre-ship-lib.mjs`, `scripts/pre-ship.mjs`,
`scripts/check-pre-ship.mjs`, `scripts/ship.mjs`, `package.json`,
`docs/RELEASE_PROCESS.md`, `docs/QUALITY_CHECKS.md`, this ledger.
**Readiness: READY_FOR_RELEASE_TOOLING_REVIEW.** High-risk on ship:
release-tooling (expects `pnpm ship patch --ack-manual-review` after human
review).

**PREVIOUS (its files shipped incrementally across v0.43.1–v0.44.2; per-prompt
detail in Git history) — `PROMPT-AI-UX-03B`:
GREETING ETIQUETTE + AUTHORITATIVE BUSINESS IDENTITY — two proven
customer-facing corrections over the EXISTING seams; ZERO
schema/migration/provider/architecture change; no commit/push/tag/deploy.**
**(A) Greeting etiquette:** the deterministic, zero-LLM greeting path now
answers each recognized greeting family with its culturally-expected
acknowledgement — «السلام عليكم» → «وعليكم السلام ورحمة الله وبركاته»,
صباح → «صباح النور», مساء → «مساء النور», otherwise «أهلاً بك» — followed by
the ONE existing short invite. ONE shared builder (`greetingResponse` in
`conversation-ai.ts`) is called by BOTH `classifyCustomerMessage` and
`bypassDeterministicAi`, so the two paths can never diverge on wording; the
intent GREETING / action reply / zero provider calls / AI_ACTIVE semantics
are unchanged and the greeting + real-turn precedence is untouched. **(B)
Business identity:** ONE authoritative instruction added to
`prompts/system/booking-assistant.prompt` (regenerated artifact): businessName
is the stored authoritative name; an identity ask may be confirmed with intent
FAQ / action reply when it is present; a customer wording that differs from
businessName is explained naturally (the registered/stored name is
businessName), never treated as unanswerable by itself; no official/legal/
licensed identity or unstored attribute may be invented; an absent
businessName falls back to handoff NO_KNOWLEDGE. The already-shipped UX-02
gate/builder identity channel backs the reply — no `disclosure-gate.ts` or
`context-builder.ts` change was needed. **Verified:** `check:greeting`
66→**72/72** (NEW UX03B-1..6: salam/morning/evening/default acknowledgements,
classifier↔bypass byte-identity, determinism, greeting+question not swallowed,
knowledge-free / no human claim, identity+booking precedence) +
`check:ai-prompts` 130→**134/134** (NEW PRODUCER-UX03B clauses) +
`check:ai-disclosure` 54/54, `check:ai-context-builder` 61/61,
`check:assistant-style` 27/27, `check:assistant-settings` 50/50,
`check:conversation-control` 50/50, `check:turn-planner` 31/31, `check:jev`
28/28, `check:conversation-handoff` 21/21, `check:conversation-ux`,
`check:whatsapp-inbound` 13/13, `check:knowledge-gap` 24/24,
`check:turn-evidence` 27/27, `check:clarify` 27/27, `check:multi-intent`
22/22, `check:ai-architecture` 25/25 + `pnpm verify`
(lint/typecheck/format/build) + `pnpm security` (1 pre-existing
both-env-files warning) green. **NOT browser/live-verified; no real-LLM run
was performed for the prompt line** (the identity wording is pinned
structurally; a live/real-LLM pass should confirm it). **Files changed:**
`src/features/conversations/server/conversation-ai.ts`,
`prompts/system/booking-assistant.prompt` (+ regenerated
`src/generated/ai-prompts.generated.ts`), `scripts/check-greeting.ts`,
`scripts/check-ai-prompts.ts`, `scripts/check-ai-disclosure.ts`, docs.
**Readiness: READY_FOR_OPERATOR_REVIEW.**

**PRODUCTION ATRIA-FAILURE FORENSICS (`PROMPT-AI-OPS-27`, read-only; ZERO
code/prompt/schema/migration/provider-policy change; no production DB write;
no commit/push/tag/deploy): ROOT CAUSE PROVEN — PROVIDER LATENCY vs the
16 s adapter bound, NOT an application defect.** Production live-verified at
**v0.41.1** (`/api/health` → `status:"ok"`, `deploymentReady:true`,
`database:"connected"`, `missingEnvVars:[]`, 2026-10-04T19:50Z) == HEAD
`d7062fd` == tag `v0.41.1` (tree clean). The OPS-25 explicit-human fix
(`HUMAN_TITLE_WORDS`) IS in the deployed tag — confirmed by `git grep` on
`v0.41.1`; the reported handoff is downstream of the provider failure, as
the prior pass concluded. **The exact affected turn (conv `f217cf5e`,
`مركز أفنان`, 2026-10-04T17:21:56Z):** customer «السلام عليكم هو انتو عيادة
الدكتورة افنان للأسنان؟» → `AI_TURN` **FAILURE `atria`/`Atria-Dawn-Preview`
`in=null out=null` (zero tokens) at 17:22:29.771Z, wall clock 34 s** →
deterministic safe-handoff acknowledgment at 17:22:29.890Z. Five such Atria
failures that day (wall clocks 17/20/33/33/34 s, all zero tokens); the three
prior Atria **SUCCESSes** on the same conversation (2026-10-03) took 16/27/28 s
with real tokens — i.e. the provider completes in ~9–16 s and only SOMETIMES
beats the `ATRIA_TIMEOUT_MS=16000` bound. The 33–34 s failures = **2 × 16 s
TIMEOUT** (Conversation Control retries TIMEOUT once, hard ceiling 2) →
EXHAUSTED → fail-safe handoff. **Boundary isolation:** the live `probe:atria`
6-run through the EXISTING adapter is **6/6 SUCCESS, HTTP 200,
`DIRECT_PARSE`, avg 8.7 s / max 10.3 s** — endpoint reachable, auth valid,
model available, request construction + parsing healthy; so the failure is
NOT credential / auth / model / request-shape / parse / Conversation Control /
engine — it is the provider response not arriving within 16 s on the full
engine-shaped request. Contrast: the CodeCraft failures the same week were
**1–4 s** (fast `CONFIG_ERROR`, non-retryable, dead key) — a different class,
proving the Atria failures are latency, not auth. **Focused checks:**
`check:atria-retry` 17/17 (R4a TIMEOUT→SUCCESS two calls; R4c exhaustion →
ONE handoff, no third attempt), `check:conversation-ops-25` 18/18.
**Readiness: `PROVIDER_ACTION_REQUIRED`** — the 16 s bound and the
fallback+secondary capability are BOTH operator-owned (DECISIONS #90 §I
already considered and declined raising the bound as an engineering change);
no code change is justified. Operator actions: raise `ATRIA_TIMEOUT_MS` AND/OR
enable fallback + a secondary, then redeploy and retest ONE live turn.
**Env-note correction (DECISIONS #90 §B is STALE):** the `.env.local`
`DATABASE_URL` is now the LIVE production Neon DB (holds the real pilot
`مركز أفنان` / `صالون سارة` + the `platform_ai_policies` singleton + 45
`AI_TURN` rows); the `.env` one is an OLD pre-v0.31 snapshot (19 tables, no
`platform_ai_policies`) — future production forensics MUST load `.env.local`
(not `.env` first as #90 said). The singleton policy row IS present:
`primary=atria`/`Atria-Dawn-Preview`, `fallback_enabled:false`,
`secondary:null` (updatedAt 2026-10-04T17:01:20Z).

**LIVE PILOT / PRODUCT LOOP VERIFICATION WITH ATRIA (`PROMPT-AI-OPS-24`,
verification-only; ZERO production code/prompt/schema/migration/provider-policy
change; no commit/push/tag/deploy; read-only production forensics):
VERIFIED — the existing product DOES work as a real pilot with Atria as the
sole live AI path, the false-handoff defect class is PROVEN RESOLVED, and NO
code change is justified.** **Source of truth:** HEAD `b8b8d40` = tag
`v0.40.2`; production live-verified `GET /api/health` → `version:"0.40.2"`,
`status:"ok"`, `deploymentReady:true`, `database:"connected"`,
`missingEnvVars:[]` (2026-10-03T22:32Z + 23:14Z). The `.env` `DATABASE_URL` is
the PRODUCTION Neon DB (19/19 migrations, `business_address` applied); the
`.env.local` one is a 9-migration DEV DB — production forensics must load
`.env` FIRST. **Effective policy (production DB, read-only):**
`atria`/`Atria-Dawn-Preview`, `fallback_enabled:false`, `secondary:null`
(updatedAt 2026-10-03T21:21:24Z). Atria IS reachable: `pnpm probe:atria`
8-run → **7/8 SUCCESS** (`DIRECT_PARSE`, avg 11.5 s, p95 16.0 s, 1 TIMEOUT at
the 16000 ms adapter bound — a provider-latency tail, not a defect).
**LIVE-VERIFIED customer loop (conv `f217cf5e`, read-only):** with the policy
on Atria, «أين موقعكم؟» → 20:54:18.096 **DISCLOSED "موقعنا في شارع الاستاد -
دسوق - كفر الشيخ."** + 21:22:03.989 same reply, and «ما الخدمات المتاحة؟» →
20:54:53.801 **DISCLOSED "الخدمات المتاحة لدينا هي: استشارة أسنان، جلسة
تجميلية، حشو عصب، وكشف جراحة."** — both ordinary questions answered, neither
handed off; the 21:22 reply was delivered (`OUTBOUND_MESSAGE` SUCCESS
`telegram` at 21:22:04.465). Every CodeCraft turn the same day was a zero-token
FAILURE, confirming the provider switch — not a code change — was the fix.
**REAL-LLM 17-class verification (NEW `scripts/eval-run-future-op24.ts`, real
Atria `Atria-Dawn-Preview`, real pilot data shape, 16 model calls): 17/17
PASS, 0 provider failures** — greeting (0-call deterministic) → DISCLOSED;
about/location/service-list/specific-service/description/known-price/range-
price/known-FAQ → **DISCLOSED replies** (no handoff); missing-address /
missing-hours / missing-price / missing-FAQ → **honest `NO_KNOWLEDGE` handoff
with NO fabricated fact**; booking intent → `booking_handoff` (domain
authority); explicit-human → `HUMAN_REQUEST`; sensitive → `SENSITIVE`;
ambiguous → `NO_KNOWLEDGE`. **FALSE-HANDOFF CHECK: PASS — no ordinary
information question became a human handoff.** Working hours stay an honest
knowledge gap by design (`workingHours` is INTERNAL — availability is
domain-computed CORE-02; the escape valve is an FAQ). **Observability:** the
`flowpilot.turn.evidence@v1` record answers all 10 required questions
(`check:turn-evidence` 27/27); Q9/Q10 are structural (one
`transport.send` on the inbound path at conversation-engine.ts:2610;
`providerAttempts ≤ 1`). The record emits to Vercel runtime logs by default
(kill switch unset) — the emitted line was NOT directly read this pass (no
Vercel log access from this environment), so emission is BUILT + LIVE-DEPLOYED
but NOT directly observed. **Pilot evidence (production read-only):** 9
customers (6 with a conversation), 10 appointments (9 CONFIRMED / 1 PENDING, 0
NO_SHOW), 6 conversations (all AI_ACTIVE), 109 messages (74 customer / 34 AI /
1 staff), 3 operator attentions (all resolved; causes null/null/AI_FAILURE),
40 AI turns (12 SUCCESS / 28 FAILURE across providers; Atria 11 SUCCESS),
0 knowledge gaps, 4 services (3 now priced — the pilot entered prices since
OPS-22), WhatsApp CONNECTED + active, one Telegram connection CONNECTED.
**NO CURRENT DATA SOURCE:** repeat usage (0 customers with >1 conversation),
no-show rate, willingness to pay, objections, churn reasons, ROI, onboarding
effort. **Readiness: READY_FOR_PILOT_EVIDENCE.**

**SUPERADMIN AI-PROVIDER POLICY / RUNTIME VERIFICATION (`PROMPT-AI-OPS-23`,
FORENSICS-FIRST + ONE MINIMAL DISPLAY REPAIR; ZERO engine/provider-gateway/
policy/orchestrator/parser/schema/migration change; no commit/push/tag/deploy):
FORENSICS COMPLETE — "why does Atria work from Superadmin while CodeCraft does
not" is answered from production evidence as a CONFIGURATION condition, not a
code defect.** **Source of truth:** HEAD `412976d` = tag `v0.40.1`, working
tree clean; production live-verified `GET /api/health` → `version:"0.40.1"`,
`deploymentReady:true`, `database:"connected"`, `missingEnvVars:[]` — so the
v0.40.1 turn-evidence observability IS live. **Controlled production A/B
(read-only, `usage_records` + the singleton policy row, 2026-10-03):** policy
is now `atria`/`Atria-Dawn-Preview`, `fallback_enabled:false`,
`secondary:null` (switched 20:57:07Z). Same pilot conversation `f217cf5e`:
`atria`/`Atria-Dawn-Preview` → **SUCCESS with real tokens** (20:54:17
1837/142; 20:54:53 1817/176); `codecraft`/`deepseek-v4-flash-0731` →
**FAILURE with `in=null out=null` (zero tokens) 14/14 over 7 days** (latest
20:56:46, minutes before the Atria successes). One `atria`/`deepseek-v4-flash-
0731` FAILURE (20:50:35) is the operator testing a model on the wrong provider
— corrected to `Atria-Dawn-Preview`, which then succeeded. **Conclusion: the
shared Superadmin → policy → factory → adapter → HTTP → parser path is PROVEN
working in production (Atria), and the CodeCraft divergence is isolated to the
provider-credential boundary** — the local `pnpm probe:codecraft` is **5/5
SUCCESS** on the same model (33 models incl. `deepseek-v4-flash-0731`, chat +
JSON-mode + `parseAiResponse` DIRECT_PARSE, 1654/640 tokens), so the endpoint,
adapter, model and parser are healthy; the production `CODECRAFT_API_KEY`
(missing or rejected → fast `CONFIG_ERROR`, zero tokens, no retry) is the
failure point, and `/api/health` cannot see it (it checks only 4 core vars).
**First failing boundary: the production provider attempt itself (before
HTTP completion) — classification A (credential/configuration).** **ONE
proven source defect, minimally repaired (display-only):** the Superadmin form
displayed the DB column `primary_secret_ref`, but that column is NEVER
rewritten on a provider switch (the write path persists only provider/model/
fallback) — the live row reads `primary_provider=atria` while
`primary_secret_ref=OPENROUTER_API_KEY` (stale since the initial seed). The
form now derives the shown reference from the SELECTED provider via the
existing `secretRefFor` — byte-for-byte what the adapter resolves at runtime
(the column stays cosmetic, as DECISIONS #86 established; the runtime always
used the adapter constant). **Verified:** `check:ai-provider` 74→**75/75**
(NEW 15l pins `secretRefFor(p) === adapter.secretRef` for EVERY selectable
provider, so the UI can never show a reference the runtime does not resolve),
`check:policy` 13/13, `check:turn-evidence` 27/27, + `pnpm verify` (lint/
typecheck/format/build) + `pnpm security` (1 pre-existing both-env-files
warning) green. Files changed: `src/features/platform/components/ai-policy-
form.tsx` (2 display bindings), `scripts/check-ai-provider.ts` (NEW 15l).
**Readiness: CONFIGURATION_ACTION_REQUIRED** — the operator's action is to
set/rotate the production `CODECRAFT_API_KEY` (Vercel env), redeploy, retest
from Superadmin, and verify one real `AI_ACTIVE` turn; NO source change is
required for the observed failure. **Proven but NOT built (proposed, awaits
operator approval): a bounded operator-only "Test provider" diagnostic action**
(see DECISIONS #89) — the Superadmin UI still cannot tell the operator whether
a credential exists or can execute, which is what made this failure silent for
8 days.

**LIVE PILOT ROUTING FORENSICS + OBSERVABILITY FOUNDATION (`PROMPT-AI-OPS-22`,
OBSERVABILITY-FIRST + READ-ONLY FORENSICS; ZERO routing/context/disclosure/
booking/provider-policy/prompt/schema/migration change; no commit/push/tag/
deploy): FORENSICS COMPLETE — both live symptoms classified PROVIDER/
CONFIGURATION; the real (proven) defect was the discarded observability
record, now closed by a fail-open, vendor-neutral, content-free turn-evidence
seam.** **Source of truth:** HEAD `e8e763e` = tag `v0.40.0`, working tree
clean; production live-verified `GET /api/health` → `version:"0.40.0"`,
`status:"ok"`, `database:"connected"`, `missingEnvVars:[]`; migration
`20261003150000_business_address` IS APPLIED (17:33:53Z, before the 17:36:17Z
release commit); policy `codecraft`/`deepseek-v4-flash-0731`,
`fallback_enabled:false`. **Read-only production forensics (`مركز أفنان`,
conv `f217cf5e`, 2026-10-03, post-v0.40.0):** the address IS present
(`شارع الاستاد - دسوق - كفر الشيخ`), `about` IS present, 4 active named
services exist (all unpriced, `faqs` empty); BOTH target questions —
«أين موقعكم؟» (17:43:42) and «ما الخدمات المتاحة؟» (17:45:57, a re-send after
the 17:43:53 send was DEFERRED_TO_STAFF on the already-NEED_HUMAN thread) —
hit a `codecraft` **`AI_TURN` FAILURE with `in=null out=null` (zero tokens)**,
so **the provider attempt itself is the first incorrect decision**; the engine
then fails safe to NEED_HUMAN with cause `AI_FAILURE` (`knowledge_gaps`=0).
Every non-greeting turn in the conversation (10/10) is a zero-token codecraft
FAILURE; the local `pnpm probe:codecraft` is **5/5 SUCCESS** on the configured
model, so the production `CODECRAFT_API_KEY` is the failure point
(`/api/health` checks only 4 core vars). **No application defect → no
production behavior change** (the provider failed BEFORE disclosure). **The
proven observability gap:** the engine already computes a content-free
`TurnObservability` per turn but all three webhook callers discard it — the
disclosure verdict, context channels, and routing decision were never emitted
or persisted, so a turn could not be explained from evidence. **Smallest seam
(vendor-neutral, fail-open, no new dependency/table):** additive
`TurnObservability` fields (`traceId`, `taskRelevance[]`, `contextChannels`,
`disclosure`, `providerAttempts`, `providerStatus`, `parseSuccess`); a new PURE
`src/features/conversations/server/turn-evidence.ts` projecting a finished turn
into ONE content-free `flowpilot.turn.evidence@v1` record; a new fail-open sink
`src/lib/observability/turn-telemetry.ts` (ONE structured JSON line to the
EXISTING runtime logs + optional env-gated OTLP/HTTP exporter implemented with
plain `fetch`; `TURN_EVIDENCE_DISABLED` / `OTEL_TURN_EVIDENCE_ENABLED` /
`OTEL_EXPORTER_OTLP_ENDPOINT`); the optional `turnTelemetry` engine dep emits
at the EXISTING `receiveInboundMessage` choke point AFTER persist+send,
best-effort/total (a missing/throwing/disabled sink leaves the turn
byte-identical). ONE trace id per turn, one generative call max, no second
inference/resolver/classifier, no prompt/schema/migration change, no
critical-path telemetry DB dependency. **Deterministic:** NEW
`check:turn-evidence` **27/27** (catalog present→DISCLOSED / absent→safe;
address present→DISCLOSED / absent→NO_KNOWLEDGE; unsupported self-authored
reply→POLICY_REFUSED; provider failure→AI_FAILURE never a gap + gate never
consulted; throwing sink→identical outcome; zero-call greeting→NOT_CALLED/0/
parse-null; content-freeness; kill switch; determinism; BOTH live questions
replayed against the real pilot data shape with a healthy provider→DISCLOSED)

- all adjacent suites green + `pnpm verify` + `pnpm security` (1 pre-existing
  warning). **Files changed:** `ai-observability.ts`, `conversation-engine.ts`,
  `turn-evidence.ts` (new), `src/lib/observability/turn-telemetry.ts` (new),
  `scripts/check-turn-evidence.ts` (new), `package.json`, docs. **No
  commit/push/tag/deploy; no migration.** **Readiness: FORENSICS_COMPLETE +
  OBSERVABILITY_BUILT** — operator restores/rotates the production
  `CODECRAFT_API_KEY` (or enables fallback + a secondary) and sends ONE live
  turn, which the new evidence line will then explain end-to-end.

**LOW-FRICTION BUSINESS KNOWLEDGE / PILOT READINESS UX (`PROMPT-AI-OPS-21`,
IMPLEMENTATION + DETERMINISTIC + REAL-LLM VERIFICATION; ONE additive nullable
column + migration NOT applied; ZERO engine/resolver/handoff/provider change;
no commit/push/deploy): BUILT + DETERMINISTIC + REAL-LLM VERIFIED —
READY_FOR_PILOT_UX_REVIEW.** The DATA/UX gap OPS-20 recorded now has its
smallest authoring surface — the AI already consumed business about/FAQ/
service/price data, so the goal was to let the owner provide the small
authoritative set quickly from a phone, NOT a new architecture. **Provider
gate PASS:** production `GET /api/health` → `v0.39.2` + `database:"connected"`

- `missingEnvVars:[]` (operator redeployed since the v0.39.0 note) and the
  EXISTING supported probe `pnpm probe:codecraft` → **5/5 stages SUCCESS** (real
  Arabic chat completion, `json_object`, token capture, `parseAiResponse`), so
  the OPS-20 production key failure is classified PROVIDER/CONFIGURATION
  resolved-by-redeploy (confirmed again by the real-LLM run: 0 failures).
  **Audit (actual code):** `Business.about` was authorable ONLY in the onboarding
  wizard (not `/settings`); **no address/location field existed anywhere** (only
  `city`, INTERNAL discovery metadata); working hours are INTERNAL by design
  (availability is CORE-02; re-editable via `/onboarding/hours`); services and
  FAQ already have complete editors (untouched). **Chosen UX (hybrid, smallest):**
  a deterministic **AI-readiness card on the dashboard** (admin home — least
  navigation) whose rows link to the EXISTING editors (`/settings`,
  `/onboarding/hours`, `/services`, `/settings/knowledge`), plus **`about` +
  `address` added to the EXISTING Settings «بيانات المنشأة» flow** (one textarea
- one input, OPTIONAL — no second settings/knowledge architecture, no
  duplicate forms). **Storage:** ONE additive nullable `Business.address`
  (`String?`) with migration `20261003150000_business_address` (ALTER ... ADD
  COLUMN only; no backfill/destructive op; **NOT applied**). **AI visibility
  (reuses the EXISTING B-01/B-02/B-03 seams, no new store):** `address` is
  CONDITIONAL (`knowledge-visibility.ts`), carried as `AiRequest.businessAddress`
  ONLY on a contact/identity/location turn (reusing the EXISTING
  `contactOrIdentity` relevance — «العنوان»/«مكان»/«أين»/«وين» already matched),
  backed by a new `business.address` disclosure family + `businessAddress` FAQ
  channel; a missing address is never invented (model hands off `NO_KNOWLEDGE`);
  `about` keeps its existing PUBLIC business-info gate and is now
  post-onboarding authorable; ONE prompt line permits quoting a present address
  and forbids inventing one (regenerated artifact). **Preserved:** partial save
  (about/address optional; blank stores the existing `""` convention),
  name/duration required, description/price optional, price never duplicated in
  FAQ, no products/vertical UI, tenant scoping unchanged, readiness never blocks
  usage. **Deterministic:** NEW `check:ai-readiness` **29/29** (authoring
  persistence + partial save + overlong rejection + ADMIN-only + hostile
  businessId stripped; readiness determinism incl. hours/services-partial/
  prices/FAQ count; address/about carried only on their gated turns; missing
  field ⇒ no fabrication via the disclosure gate; tenant isolation; preserved
  service rules) + all adjacent suites green (`ai-context-builder` 56,
  `ai-disclosure` 46, `knowledge-visibility` 36, `knowledge-gap` 24,
  `knowledge-faq` 32, `service-price` 33, `services` 50, `handoff-cause` 31,
  `conversation-handoff` 21, `ai-prompts` 129, `ai-architecture` 25, `greeting`
  66, `multi-intent` 22, `conversation-booking` 16) + `pnpm verify` +
  `pnpm security` (1 pre-existing warning). **Real-LLM (NEW eval-only
  `scripts/eval-run-future-op21.ts`; real codecraft `deepseek-v4-flash-0731`,
  the live policy; key by NAME only): 10/10 classes PASS, 0 provider failures** —
  about-present → reply DISCLOSED (quotes the stored about); about-missing →
  handoff NO_KNOWLEDGE; **location-present → reply DISCLOSED (quotes the stored
  address); location-missing → handoff NO_KNOWLEDGE (no fabricated location)**;
  service-list/service-description/known-price/FAQ → DISCLOSED; missing-price →
  NO_KNOWLEDGE; unrelated booking → BOOKING_HANDOFF. **Readiness:
  READY_FOR_PILOT_UX_REVIEW** (migration unapplied + not deployed).
  **Files changed:** `prisma/schema.prisma` + migration
  `20261003150000_business_address/`, `src/lib/ai-knowledge-visibility/
knowledge-visibility.ts`, `src/features/conversations/server/ai-contract.ts`,
  `ai-context-builder/context-builder.ts`, `ai-disclosure/disclosure-gate.ts`,
  `src/server/integrations/ai/prompt.ts`,
  `prompts/system/booking-assistant.prompt` (+ regenerated artifact),
  `src/lib/ai-readiness.ts` (new), `src/lib/validation/business.ts`,
  `src/features/settings/{schemas/settings-schema.ts,types.ts,
server/settings-service.ts,components/settings-screen.tsx}`,
  `src/features/dashboard/components/{ai-readiness-card.tsx (new),dashboard.tsx}`,
  `src/features/dashboard/server/dashboard-query.ts`, `src/app/(app)/page.tsx`,
  `scripts/check-ai-readiness.ts` (new), `scripts/eval-run-future-op21.ts` (new),
  `scripts/check-whatsapp-onboarding.ts` (test-fake `address`),
  `package.json`, docs. **No commit/push/tag/deploy; migration NOT applied.**

**PILOT EVIDENCE READINESS (`PROMPT-AI-OPS-19`, ASSESSMENT ONLY — ZERO
production code/prompt/schema/migration change; no commit/push/tag/deploy):
PRODUCT IS OPERATIONALLY READY TO RUN REAL PILOTS; A REAL PILOT IS ALREADY
RUNNING; NO CODE CHANGE IS JUSTIFIED — READINESS REPORT ONLY.**
Classification A/B/C/D applied to every pilot-readiness question
(A=sufficient now, B=missing but operationally necessary, C=useful later,
D=premature/out of scope). **(A) ALREADY RUNNING — LIVE-VERIFIED PRODUCTION
EVIDENCE (read-only queries against the production Neon DB + `GET
/api/health`):** production IS **v0.39.0**, `status:"ok"`,
`deploymentReady:true`, `database:"connected"`, `missingEnvVars:[]`;
`prisma migrate status` → "Database schema is up to date!" (**all 18**
migrations — the three Slice-6/7/9 additive migrations ARE applied,
correcting the stale ledger note that said they were pending) and
`prisma migrate diff --from-config-datasource --to-schema` → **"No
difference detected"** (zero drift). Real pilot rows exist: **2
businesses in Kafr El Sheikh** (`مركز أفنان` dental — onboarded, working
hours, `confirmation_mode:"automatic"`, WhatsApp **CONNECTED** + active via
the ENV-credential grammar (`credentials_ref=WHATSAPP_META_ACCESS_TOKEN` +
real `external_id`); `صالون سارة التجميلي` beauty — NOT onboarded, WhatsApp
stuck `AUTHORIZING`/`PENDING`), 9 customers, 4 services (all unpriced),
**1 provider profile + 1 provider service + 1 provider branch** (created
2026-09-19 — manually, see blockers), **10 appointments (9 CONFIRMED / 1
PENDING, all assigned)**, 6 conversations (4 AI_ACTIVE / 2 NEED_HUMAN), 71
messages (54 customer / 16 AI / 1 staff), 3 operator attentions (all
resolved, `cause` null = pre-Slice-7 rows), 95 usage records (56
INBOUND_MESSAGE / 16 OUTBOUND_MESSAGE / 9 AI_TURN SUCCESS / **14 AI_TURN
FAILURE**), and a Telegram managed bot that DID reach **CONNECTED** +
`onboarding_state:READY` (`Drafnanafnanbot`). **(B) EVIDENCE ALREADY
DIRECTLY DERIVABLE from existing data (no new analytics stack):**
conversations + per-sender message counts; **response time** (proven
derivable — observed customer→AI gaps of 1–32s from `messages.created_at`);
booking outcomes via `appointments.status` (incl. `NO_SHOW` when recorded);
operator handoffs via `conversations.status=NEED_HUMAN`; **handoff causes**
via the Slice-7 typed `operator_attentions.cause`; **knowledge gaps** via
the Slice-9 `knowledge_gaps` table (0 rows today — no live turn has crossed
the recorder yet: the last live AI turn was **2026-09-28**); service/price
configuration via `services.price_*`; repeat usage via
`customers.lastConversationAt`/`lastAppointmentAt` (6/9 with a
conversation, 4/9 with an appointment); automation economics via
`usage_records` (kind/provider/model/status; `estimatedCostMicros` is never
computed — cost is not yet derivable). **(C) THE TWO ONBOARDING-
REPEATABILITY BLOCKERS (B-class, NOT hard blockers for running the first
pilots — the operator has a proven manual path, but they break the Spec A
exit criterion "a real business can be onboarded in < 1 day using the app
alone"):** (1) **no provider authoring surface** —
`providerRepository.createProfile`/`linkRelation` have **ZERO callers** in
`src/app`/`src/features`/`src/server`/`scripts`/`prisma/seed.ts`, so with
no `ProviderProfile`/`ProviderService` rows `resolveEligibleProviders`
returns `NO_ELIGIBLE_PROVIDERS` for EVERY booking turn → deterministic
Arabic "لا يوجد مزود متاح" + NEED_HUMAN (the AI can never offer a slot or
book); the live dental pilot books only because a founder inserted those
rows by hand; (2) **no UI/server-action for the ENV-credential WhatsApp
connection** — `saveConnection` (accepts an ENV `credentialsRef` + real
`externalId`, the documented `.env.example` grammar the live pilot actually
uses) is called ONLY from offline harness scripts; the only UI path is Meta
Embedded Signup (DEFERRED/HOLD per `docs/INTEGRATION_CHECKPOINTS.md`) or the
deterministic stand-in (fabricates an unresolvable env name → can NEVER
reach CONNECTED), so a new pilot's number needs a manual DB row. Both are
the minimum candidate next slices; NEITHER was built here. **(D)
CLASSIFIED:** A — business profile/services/working-hours(knowledge/FAQ/
conversation engine/operator lifecycle/handoff-cause/knowledge-gap/
response-time/usage metering); B — provider authoring surface, ENV-credential
WhatsApp connect surface, live AI-provider re-verification (last 4 AI turns
FAILED, no traffic since 2026-09-28), second pilot onboarding (beauty salon
stuck in onboarding); C — knowledge-gap review UI (`list`/`markReviewed`/
`markRejected` have no app caller), out-of-band staff notifications (sink is
a stub), working-hours editing in settings (wizard-only, re-editable via the
raw `/onboarding/hours` URL), attention-reason persistence past first load
(`getConversationDetail` resolves the attention on open so the chip renders
only on first load; the typed `cause` persists in the DB so evidence is
intact), inbox attention-first sorting; D — pilot registry/Spec B evidence
layer (`ROADMAP.md` files it under planned Spec B; `CLIENT_DEMO.md`: "pilot
registry comes in Spec B — for now: who, which vertical, objections, price
reaction"), Founder Console, vertical scoring, WTP engine, knowledge-gap
promotion, RAG/embeddings, billing/payments, JEV activation. **(E)
OPERATIONAL NOTES:** the platform AI policy row is `codecraft` /
`deepseek-v4-flash-0731` with `fallback_enabled:false`; its stored
`primary_secret_ref` is the stale `OPENROUTER_API_KEY` — HARMLESS because
`toEffectivePolicy` ignores the stored ref and each adapter resolves its own
key via `secretRefFor(provider)` (codecraft → `CODECRAFT_API_KEY`), but it is
cosmetically inconsistent; `/api/health`'s `missingEnvVars` checks only the
4 core vars, so `missingEnvVars:[]` does NOT prove an AI key is present.
**(F) VERIFICATION (focused, no ceremony):** `pnpm check:knowledge-gap`
24/24, `check:handoff-cause` 31/31, `check:operator-attention` 20/20,
`check:service-price` 33/33, `check:conversation-handoff` 21/21,
`check:conversation-ux` 18/18, `pnpm verify` (lint 23.3s / typecheck 7.0s /
format 22.5s / build 13.7s) PASS, `pnpm security` PASS (1 pre-existing
both-env-files warning). **Readiness: RUN_PILOT_NOW — no engineering change
is the critical path; the critical path is operator-owned (verify the live
AI provider, finish onboarding pilot #2, start collecting the named
evidence).** See DECISIONS #85.

**AI TARGET ARCHITECTURE — SLICE-9 KNOWLEDGE-GAP LIFECYCLE EVALUATION
(`PROMPT-AI-EVAL-16`, FORENSIC VERIFICATION): VERIFIED CORRECT + TENANT-SAFE +
OFF-CRITICAL-PATH — READY_FOR_NEXT_STAGE (zero production change; human-review
gate; NO release/commit/migrate).** The shipped Slice-9 record-only lifecycle
(DECISIONS #83, released in v0.39.0 / `c55d3de`) answers the evaluation
question YES. **Deterministic floor:** `check:knowledge-gap` **24/24** through
the REAL Conversation Engine — one bounded `UNRESOLVED` record per genuine
`KNOWLEDGE_GAP_UNRESOLVED` turn (correct `businessId`/`conversationId`/
`customerMessageId`, `reviewedById` null, `subjectText` ≤200 chars from the
customer's own question); ordinary answer / provider failure / safety /
explicit-human / booking-only create none; the price gap is evidence and never
fabricates a price; a same-turn replay is a structural no-op; cross-tenant
list/review excluded; a throwing recorder leaves the turn byte-identical at
1 call / 1 send; the recorder is pure (no DB/provider/env/network, reuses the
EXISTING `deriveTaskRelevance` seam). **Real-LLM (NEW eval-only
`scripts/eval-run-future-arch18.ts`, `arch18@1`; Atria `Atria-Dawn-Preview`
through the established eval-only override; DB policy NOT read/changed;
dataset hash `8be16297…` asserted unchanged):** calibration 3/3 · gating
**10/10** · 12 turns · 11 real calls · 0.92 calls/turn · max 1/turn · 1
zero-call deterministic turn · 0 multi-call · 0 provider failures · 0
malformed; **4/4 gap turns → 4 records (0 false pos / 0 false neg / 0 dup)**;
5 controls → none (incl. the SAME price question on a PRICED business);
recorder outage → byte-identical turn, no `PROVIDER_FAILURE` relabel, still
1 call; `InboundSuccess.knowledgeGap` cross-checked against the stored row on
both `id` and `category`; latency p50 11.7s / p95 108s (provider property).
**Category derivation proven deterministic + provider-neutral** by executing
`deriveKnowledgeGapCategory` directly on every gap message. **Two
EVALUATION-HARNESS defects found + closed IN PLACE (no production change):**
(1) the FUTURE_SYSTEM bridge omitted the optional `knowledgeGapRepository`
dep, so real-LLM runs could never reach the recorder path; (2) the bridge
emitted non-UUID conversation/message ids which the shipped recorder's
`uuidSchema` record DTO rejects — both were silently swallowed by the
recorder's own best-effort contract. Remediation (evaluation-only): ONE
additive optional recorder injection point on `createFutureSystemRunner`
(absent = exact prior behaviour) + real `randomUUID()` ids. **Review
lifecycle `UNRESOLVED → REVIEWED/REJECTED` is implemented + verified but NOT
exposed through any UI/API** (`list`/`countUnresolved`/`markReviewed`/
`markRejected` have no caller outside the repository + checks) — reported
accurately; NO operator UI was built. **Deterministic:** `check:future-system`
33→**36/36** (NEW F34–F36: the recorder seam asserted both present and
absent); all 13 named adjacent suites green (handoff-cause 31, operator-
attention 20, conversation-handoff 21, conversation-booking 16,
ai-architecture 25, ai-context-builder 54, ai-disclosure 41, service-price 33,
multi-intent 22, clarify 27, turn-planner 31, conversation-state 20,
knowledge-gap 24); `pnpm verify` (lint/typecheck/format/build) + `pnpm
security` green (1 pre-existing both-env-files warning). **Files changed
(evaluation-only):** `evaluation/runner/future-system-adapter.ts`,
`scripts/check-future-system.ts`, `scripts/eval-run-future-arch18.ts` (new),
`package.json`, docs. **Zero `src/`/`prisma/`/`prompts/` change; migration
`20261002140000_knowledge_gap` untouched; dataset/gold/scorer/historical
reports unchanged; no secret/provider payload in any artifact.**
**Readiness: READY_FOR_NEXT_STAGE.**

**AI TARGET ARCHITECTURE — SLICE 9 ASYNC KNOWLEDGE-GAP / SELF-IMPROVEMENT —
RECORD-ONLY, OFF THE CRITICAL PATH (`PROMPT-AI-ARCH-18`, IMPLEMENTATION +
VERIFICATION): BUILT + DETERMINISTIC VERIFIED — READY_FOR_NEXT_STAGE
(human-review gate; NO release/commit/migrate).** The target architecture's
async knowledge-gap boundary (`docs/ai/TARGET_ARCHITECTURE.md §3.16 / §17
Slice 9`) is now a bounded, tenant-scoped, append-oriented record-only
lifecycle that can NEVER enter the authoritative response decision. **The
authoritative signal** is the EXISTING Slice-7
`InboundSuccess.handoffCause === "KNOWLEDGE_GAP_UNRESOLVED"` (the engine's
final handoff branch: `action:"handoff"` + `handoffReason:"NO_KNOWLEDGE"`),
derived AFTER the resolver/safety decision — provider/AI failure, retry
exhaustion, safety, explicit human, ambiguity, policy refusal, domain block
and tenant-configuration all stay distinct and NEVER create a record. **ONE
pure recorder module** (`src/features/conversations/server/knowledge-gap.ts`)
derives a bounded observation only for that cause, with a stable category
(`SERVICE_PRICE · BUSINESS_INFO · SERVICE_INFO · AVAILABILITY · FAQ ·
GENERAL`) computed DETERMINISTICALLY by REUSING the EXISTING B-02
`deriveTaskRelevance` seam + the turn's authoritative intent (NO new
classifier, NO model call). **ONE repository**
(`src/server/repositories/knowledge-gap.repository.ts`) owns the ONLY Prisma
boundary: append-idempotent `record` (per-turn unique `(conversationId,
customerMessageId)`), tenant-scoped `list`/`countUnresolved`, and a
status-guarded `markReviewed`/`markRejected` (UNRESOLVED →
REVIEWED/REJECTED). **NO promotion path exists** — no FAQ/business/service/
price/prompt write, no RAG/embeddings/vector store, no queue/event
bus/Redis, no second engine/resolver/state/planner/classifier/inference.
**Off-path wiring:** the engine records at the SAME post-turn choke point as
operator attention (`receiveInboundMessage`, AFTER the reply was persisted +
delivered), best-effort/total — a failed write yields no record and can
never block, retry, or alter the turn. Additive
`InboundSuccess.knowledgeGap?` carries `{ id, category }` (machine keys only;
absent when nothing was recorded). **Storage (additive, NOT applied):** ONE
new `knowledge_gaps` table (migration `20261002140000_knowledge_gap`,
CREATE TABLE + indexes + FKs only, zero ALTERs on existing tables; nullable
review columns; `@@unique([conversationId, customerMessageId])`).
**Deterministic:** NEW `check:knowledge-gap` **24/24** (genuine gap
recorded; ordinary answer / provider failure / safety / human request create
NO record; booking unaffected; price gap recorded without fabricating a
price; duplicate deterministic; tenant isolation; recording failure leaves
the turn byte-identical; zero-or-one call; one send; pure-recorder +
no-second-layer structural guards); all adjacent gates green
(ai-architecture, ai-prompts, ai-context-builder, ai-disclosure, ai-provider,
future-system, multi-intent, clarify, turn-planner, conversation-state,
conversation-handoff, conversation-booking, booking-options, booking-confirm,
handoff-cause, operator-attention, service-price, response-normalizer,
greeting, knowledge-visibility, conversation-control, conversation-ux, jev,
assistant-style, eval/-schema/-runner, knowledge-faq, services, policy,
context, whatsapp-_, telegram_, signup, credentials-runtime); `pnpm verify`
(lint/typecheck/format/build) + `pnpm security` green (1 pre-existing
both-env-files warning). **Incidental pre-existing repair:**
`check:conversation-ux` U4b was stale since Slice 7 (its chip regex predated
the added `cause` prop) — the assertion was corrected test-only; no
production/UI change. **Real-LLM:** NOT required (purely post-decision
recording; no prompt/model/provider behavior change) — deterministic
verification only. **Files changed:** `knowledge-gap.ts` (new recorder),
`src/lib/validation/knowledge-gap.ts` (new) + index,
`knowledge-gap.repository.ts` (new) + repositories index, `prisma/schema.prisma`

- migration `20261002140000_knowledge_gap/`, `conversation-engine.ts`,
  `scripts/check-knowledge-gap.ts` (new), `scripts/check-conversation-ux.ts`
  (stale assertion repair), `package.json`, docs. **No JEV token/provider
  switch; migration NOT applied; no commit/push/tag/deploy.**
  **Readiness: READY_FOR_NEXT_STAGE.**

**AI TARGET ARCHITECTURE — SLICE 8 OPTIONAL JEV DECISION STRATEGY BEHIND THE
EXISTING PROVIDER GATEWAY (`PROMPT-AI-ARCH-17`, IMPLEMENTATION + VERIFICATION):
BUILT + DETERMINISTIC + REAL-LLM VERIFIED — READY_FOR_NEXT_STAGE (human-review
gate; NO release/commit).** The target architecture's JEV integration point
(§11 / §17 Slice 8) is now an OPTIONAL, provider-neutral decision seam behind
the EXISTING provider gateway — not a mandatory stage. **ONE pure module**
(`src/server/integrations/ai/jev-strategy.ts`) owns the bounded decision
contract (`mode: DETERMINISTIC | GENERATIVE`; `reason:
DETERMINISTIC_ACKNOWLEDGEMENT · DETERMINISTIC_UNDECIDABLE ·
GENERATIVE_REQUIRED`; a complete contract `AiResponse` present IFF
DETERMINISTIC) and the ONE conservative strategy (`jev-conservative@v1`)
whose `decide()` is pure/synchronous — no I/O, no model call. **The EXISTING
gateway** (`orchestrator.ts`, the ONE-generative-call-budget owner) gains an
OPTIONAL `decisionStrategy`: DETERMINISTIC terminates with ZERO provider
attempts (`finalProvider: "jev-deterministic"` + `AiTelemetry.jevDecision`);
GENERATIVE falls through to the gateway's SINGLE existing call; with no
strategy the gateway keeps its exact prior built-in bypass (rollback = remove
one argument). `factory.ts` wires the conservative strategy into the
policy-backed `ConversationAi`. **Conservative by construction (no new
deterministic behaviour):** the strategy's deterministic set is EXACTLY the
repository's already-proven zero-LLM evidence (`bypassDeterministicAi`: pure
Arabic greeting → knowledge-free `GREETING` reply; too-short → safe
`AMBIGUOUS`/CLARIFY resolution); every UNKNOWN/UNSAFE/AMBIGUOUS turn continues
to the single generative call. **Observability:** additive
`AiTelemetry.jevDecision` + `TurnObservability.jev` carry closed machine keys
only (never content/provider/chain-of-thought, never customer-visible); the
engine recognises `jev-deterministic` as a zero-call outcome (no `AI_TURN`
usage fact) and labels routing `JEV` (the value already reserved in
`aiRoutingDecisionValues`); the FUTURE_SYSTEM eval target maps `routing ===
"JEV"` → source `jev-deterministic` + `jevMode`/`jevReason`. **Safety /
Slice-7 preserved:** explicit-human / sensitive / domain / knowledge-gap /
provider-failure / retry-exhaustion precedence stays authoritative; the Slice-7
typed cause survives unchanged; one-send invariant held. **Deterministic:** NEW
`check:jev` (`scripts/check-jev-strategy.ts`) **28/28** across three layers —
pure contract, the REAL orchestrator (DETERMINISTIC ⇒ 0 adapter calls;
GENERATIVE ⇒ exactly 1; provider failure not masked; provider-neutral
atria↔codecraft), and the REAL Conversation Engine (zero-call greeting,
one-call generative, handoff precedence, typed cause, one-send, no second
inference); all adjacent gates green (ai-architecture 25, ai-provider 74,
future-system 33, turn-planner 31, clarify 27, multi-intent 22, handoff-cause
31, conversation-state 20, conversation-handoff 21, conversation-booking 16,
ai-disclosure 41, ai-context-builder 54, ai-prompts 128, response-normalizer
78, eval/-schema/-runner 25/22/18, greeting 66, conversation-control 50,
knowledge-visibility 36, service-price 33, operator-attention 20, context
7/87/11); `pnpm verify` (lint/typecheck/format/build) + `pnpm security` green
(1 pre-existing both-env-files warning; 2 pre-existing lint warnings:
`check-conversation-ux.ts` unused eslint-disable, `service-form-dialog.tsx`
React-Compiler incompatible-library). **Real-LLM (NEW eval-only runner
`scripts/eval-run-future-arch17.ts`, `arch17@1`; Atria `Atria-Dawn-Preview`
override; DB policy NOT read/changed; dataset hash `8be16297…` unchanged; the
conservative JEV strategy wired into the gateway exactly as production):**
calibration 3/3 · gating **12/12** · 14 measured turns · 12 real calls · 0.86
calls/turn · max 1/turn · 0 multi-call · 2 zero-call deterministic turns · 0
provider failures · 0 retries · 0 malformed; JEV GENERATIVE on every inference
turn; a real-adapter-wired gateway probe proved a deterministic greeting
terminates with **0 provider invocations** (`jev-deterministic` /
`DETERMINISTIC`); safety preserved; cause contract holds; one-send invariant
holds; latency p50 22.2s / p95 88.4s (provider property). **Artifacts:**
`evaluation/reports/egyptian-v1/real-llm-arch17/` (prior dirs preserved).
**Files changed:** `jev-strategy.ts` (new), `orchestrator.ts`, `types.ts`,
`conversation-ai.ts` (integrations), `factory.ts`, `conversation-engine.ts`,
`ai-observability.ts`, `evaluation/runner/future-system-adapter.ts` +
`targets/future-system-flowpilot.ts` (eval-only), `scripts/check-jev-strategy.ts`

- `scripts/eval-run-future-arch17.ts` (new), `package.json`,
  `docs/BUILD_STATE.md`, `docs/DECISIONS.md` (#82),
  `docs/DECISIONS_INDEX.md`, `docs/ai/TARGET_ARCHITECTURE.md`,
  `docs/ai/ARCHITECTURE.md`. **No commit/push/tag/deploy/migrate.**
  **Readiness: READY_FOR_NEXT_STAGE.**

**AI TARGET ARCHITECTURE — SLICE 7 TYPED HANDOFF-CAUSE TAXONOMY + OPERATOR
MAPPING (`PROMPT-AI-ARCH-16`, IMPLEMENTATION + VERIFICATION): BUILT +
DETERMINISTIC + REAL-LLM VERIFIED — READY_FOR_NEXT_STAGE (human-review gate;
NO release/commit).** The NEED_HUMAN behavior is now typed, explicit and
operator-usable end-to-end. **ONE pure module**
(`src/features/conversations/server/handoff-cause.ts`) owns the canonical
10-value `HandoffCause` (`CUSTOMER_REQUESTED_HUMAN · SENSITIVE_OR_RESTRICTED ·
DOMAIN_REQUIRES_HUMAN · KNOWLEDGE_GAP_UNRESOLVED · AMBIGUITY_UNRESOLVED ·
POLICY_REFUSED · PROVIDER_FAILURE · AI_FAILURE · TENANT_CONFIGURATION ·
RETRY_EXHAUSTED`), a fail-safe `parseHandoffCause` (unknown/legacy → `null`,
never a misleading cause), total mappers from the EXISTING AI-contract and
Conversation-Control reasons, and the ONE centralized Arabic operator mapping
(label + bounded description). The engine derives the cause at every
already-decided `NEED_HUMAN` branch AFTER the authoritative resolver/safety
decision and carries it on the additive optional
`InboundSuccess.handoffCause`; the model's free-form `handoffCause` string is
never trusted as canonical. Provider/retry/AI failure stay distinct via the
EXISTING provider-neutral Conversation-Control outcome
(`AiTelemetry.conversationControl.handoffReason`) — **no second model call, no
prompt change**. **Smallest persistence seam:** ONE additive nullable `cause`
column on the EXISTING `operator_attentions` table (migration
`20261002130000_operator_attention_cause`; no backfill/destructive op), read
back fail-safe, latest handoff wins (no stale leak); the EXISTING staff
workspace queue + conversation-detail chip render the typed cause, falling
back to the coarse `attentionReason`; takeover / Resume AI / tenant scoping
unchanged. A staff-routed thread (`DEFERRED_TO_STAFF`) intentionally carries
no cause. **Safety-precedence correction (real-LLM finding):** a model-only
human claim (`intent: HUMAN_REQUEST` while reporting `handoffReason:
SENSITIVE` on a deterministically sensitive message) no longer outranks
`SAFETY_RESTRICTED`; the deterministic explicit-human request still wins and
the HANDOFF OUTCOME is unchanged — only the cause/precedenceRule is corrected.
**Untouched/preserved:** lifecycle (`AI_ACTIVE → NEED_HUMAN → takeover →
explicit Resume AI`), safety/handoff precedence, `goals[]`/answer-and-continue/
pendingGoals, tenant proof, Slice-6 price semantics, one-call/one-send
invariant, no second resolver/state/planner/engine/classifier.
**Deterministic:** NEW `check:handoff-cause` **31/31** (taxonomy +
presentation coverage, fail-safe parse, both reason mappers, eligibility
split, purity/no-second-module guards; real-engine E2E for all 10 causes incl.
provider failure vs retry exhaustion vs AI failure vs policy refusal vs tenant
configuration, safety precedence, multi-intent, persistence, stale-cause
overwrite, Resume-AI non-fabrication, tenant isolation, no customer-visible
cause, zero extra model calls); all adjacent gates green (ai-prompts 127,
ai-architecture 25, ai-disclosure 41, service-price 33, ai-context-builder 54,
knowledge-visibility 36, response-normalizer 78, services 50, multi-intent 22,
turn-planner 31, conversation-state 20, clarify 27, future-system 33,
conversation-handoff 21, operator-attention 20, conversation-booking 16,
eval/-schema/-runner 25/22/18); `pnpm verify` (lint/typecheck/format/build) +
`pnpm security` green (1 pre-existing both-env-files warning). **Real-LLM (NEW
eval-only runner `scripts/eval-run-future-arch16.ts`, `arch16@1`; Atria
`Atria-Dawn-Preview` override; DB policy NOT read/changed; dataset hash
`8be16297…` unchanged):** calibration 3/3 · gating **10/10** · 13 measured
turns · 13 real calls · 1 call/turn · 0 multi-call · 0 bypass · 0 provider
failures · 0 malformed; explicit-human/sensitive/knowledge-gap/domain-
constraint/multi-intent-handoff all derive the correct cause; answerable +
booking-only + multi-intent-no-handoff stay AI_ACTIVE with no cause; Slice-6
price preserved (missing → KNOWLEDGE_GAP_UNRESOLVED, present → AI_ACTIVE).
Latency p50 20.5s / p95 42.2s (provider property). **Files changed:**
`handoff-cause.ts` (new), `conversation-engine.ts`, `turn-planner.ts`,
`ai-contract.ts` (comment), `ai-observability` consumers,
`operator-attention.ts` (validation), `operator-attention.repository.ts`,
`prisma/schema.prisma` + `prisma/migrations/20261002130000_operator_attention_cause/`,
`staff/{types,server/workspace-service,components/staff-workspace}`,
`conversations/{types,server/conversation-queries,components/conversation-detail}`,
`evaluation/runner/targets/future-system-flowpilot.ts` (eval-only),
`scripts/check-handoff-cause.ts` + `scripts/check-operator-attention.ts` +
`scripts/eval-run-future-arch16.ts` (new/updated), `package.json`,
`docs/BUILD_STATE.md`, `docs/DECISIONS.md` (#81), `docs/DECISIONS_INDEX.md`,
`docs/ai/TARGET_ARCHITECTURE.md`. **No commit/push/tag/deploy/migrate.**
**Readiness: READY_FOR_NEXT_STAGE.**

**LIVE PILOT FALSE-HANDOFF FORENSICS + SERVICE-CATALOG DISCLOSURE REPAIR
(`PROMPT-AI-OPS-20`, FORENSICS + MINIMAL ADDITIVE FIX AT THE B-02/B-03 SEAM;
NO engine/handoff/provider/schema/migration change; no production DB write):
FORENSICS COMPLETE — live root cause PROVEN provider-side; smallest justified
application repair BUILT + deterministically VERIFIED — READY_FOR_PILOT_RETEST
(blocked on the operator restoring the production AI key; human-review gate; NO
release/commit).** A live pilot conversation (`مركز أفنان` `f217cf5e`,
2026-10-03) showed the greeting succeeding while every ordinary question
returned the generic handoff. **Live root cause:** all 7 non-greeting `AI_TURN`
rows are `codecraft`/`deepseek-v4-flash-0731` **FAILURE with zero tokens**
(the greeting emits no `AI_TURN` — it is the zero-call `bypassDeterministicAi`),
and the policy has `fallbackEnabled:false` + `secondary:null`, so a provider
failure fails safe to NEED_HUMAN with the correct provider/AI cause
(`knowledge_gaps` = 0 rows — never a fake gap). The codecraft SERVICE is healthy
(`/v1/models` 200 + 33 models incl. the configured model; real adapter
chat/JSON/contract SUCCESS ~5 s); the failure is production-side provider
configuration. **Independent APP DEFECT (fixed, additive):** with a healthy
provider, a services-list reply was authored by the model from the
always-carried PUBLIC `request.services` names but REFUSED by the B-03 gate
(`UNAVAILABLE_IN_REQUEST` → `POLICY_REFUSED`) because no FAQ candidate family
recognized the carried NAMES. **Exact fix:** (1) `deriveTaskRelevance` gains a
tight `serviceCatalog` family (خدمة/الخدمة/خدمات/الخدمات/service(s)) that arms
an aggregate PUBLIC `service.name` ledger family ONLY on a catalog-listing turn
(the same budget-gate pattern `service.description`/`serviceInfo` uses);
(2) the gate gains the ADDITIVE `serviceNames` FAQ candidate channel
(`request.services` non-empty). The names stay in the base catalog on every
turn (unchanged), but the disclosure backstop is preserved: on a
location/hours/about/price turn the family is unarmed, so an invented answer is
still refused. `deriveKnowledgeGapCategory` is unchanged (a catalog turn now
stays AI_ACTIVE → no gap record). **Deterministic:**
`check:ai-disclosure` **46/46** (NEW 1g/1g-bis/1h/1i/1j: catalog reply
disclosed, definite-article morphology, off-task unarmed, location/hours reply
still refused despite carried names, empty catalog refused),
`check:ai-context-builder` **56/56** (NEW OPSD20-R1/R2), `check:knowledge-gap`
24/24 (+ literal update), all adjacent gates green (`ai-knowledge-visibility`
36, `ai-architecture` 25, `ai-provider` 74, `service-price` 33,
`handoff-cause` 31, `conversation-handoff` 21, `conversation-control` 50,
`conversation-ux` 18, `turn-planner` 31, `multi-intent` 22, `clarify` 27,
`greeting` 66, `response-normalizer` 78, `atria-retry` 17,
`conversation-state` 20, `conversation-booking` 16, `booking-options` 32,
`assistant-style` 27); `pnpm verify` + `pnpm security` green (1 pre-existing
warning). **Real-LLM (12 classes, real codecraft + real pilot context):** 9
calls · one-call/turn HELD · 0 provider failures · 0 malformed; greeting 0-call
AI_ACTIVE; about/location/hours/missing-price/genuine-gap →
`KNOWLEDGE_GAP_UNRESOLVED` (no fabrication); **service-list + known-price
(synthetic in-memory price) + multi-intent → DISCLOSED AI_ACTIVE**; booking →
`BOOKING_SEAM`; explicit-human/sensitive → 0-call `SAFETY_PRECEDENCE`.
**DATA/UX gap (recorded, NOT built):** no address/location `Business` field
exists; `about=""`, `faqs=null`, hours INTERNAL by design, all services
unpriced. **Files changed:** `ai-context-builder/context-builder.ts`,
`ai-disclosure/disclosure-gate.ts`, `scripts/check-ai-disclosure.ts`,
`scripts/check-ai-context-builder.ts`, `scripts/check-knowledge-gap.ts`,
`docs/BUILD_STATE.md`, `docs/DECISIONS.md` (#86),
`docs/DECISIONS_INDEX.md`, `docs/CURRENT_STATE.md`,
`docs/ai/ARCHITECTURE.md`. **No commit/push/tag/deploy/migrate.**
**Readiness: BLOCKED_PROVIDER** (operator restores the production
`CODECRAFT_API_KEY` or enables fallback + a secondary, then deploys; the
service-list fix is deploy-gated on the same release).

**AI TARGET ARCHITECTURE — SLICE 6 BROADER KNOWLEDGE EXPOSURE: BUSINESS ABOUT

- SERVICE DESCRIPTION + BOUNDED CATALOG (`PROMPT-AI-ARCH-15`, IMPLEMENTATION +
  VERIFICATION): BUILT + REAL-LLM VERIFIED — READY_FOR_NEXT_STAGE (human-review
  gate; NO release/commit).** The remaining Slice-6 knowledge families the
  EVAL-15 knowledge map recorded as `NOT YET WIRED` are now reachable through the
  EXISTING B-01/B-02/B-03 seams. **Smallest justified shape (no new storage —
  the data already existed):** (1) `AiRequest` gains OPTIONAL `businessAbout`
  (≤2000) and OPTIONAL `services[].description` (≤600) — provider-neutral,
  additive, absent on unrelated turns; (2) the B-02 context builder adds two
  deterministic relevance families to `deriveTaskRelevance` — `businessInfo`
  («عن العيادة/قصة/نبذة/فرع/تخصص/شغالين/about») gates the PUBLIC
  `business.about`; `serviceInfo` («بتشمل/بيشمل/بيعمل/خطوات/تفاصيل/include/
  details») gates the PUBLIC per-service `description`, selected by a bounded
  deterministic reference check (exact-name phrase OR the service's FIRST
  significant token) with a `AI_SERVICE_DESCRIPTION_LIMIT=5` fallback — never the
  full catalog; the existing service NAMES remain the bounded catalog channel
  unchanged; (3) the B-03 disclosure gate gains ADDITIVE FAQ support families
  `business.about` (channel `businessAbout`) and `service.description` (channel
  `serviceDescriptions`), each backed ONLY when `channelCarried` proves the data
  is actually in the request — an absent about/description is an honest
  `NO_KNOWLEDGE` handoff, never invented (the `service.price` path is
  untouched); (4) ONE provider-neutral prompt line permits quoting a PRESENT
  `businessAbout`/service description and forbids inventing one (regenerated
  artifact — same prompt id, following the ARCH-13 precedent). **Untouched and
  preserved:** price semantics (FIXED/RANGE/STARTING_FROM/CONDITIONAL, missing →
  NEED_HUMAN only when the goal needs price), duration/isActive/ids remain
  INTERNAL/FORBIDDEN (never exposed), safety/handoff precedence, tenant proof,
  goals[]/answer-and-continue/pendingGoals, one generative call/turn, no second
  engine/resolver/state/planner/knowledge/RAG. **Deterministic:**
  `check:ai-context-builder` **54/54** (NEW: about/description task-gating,
  bounded catalog, missing-value absence, channel separation from price),
  `check:ai-disclosure` **41/41** (NEW: about/description support families,
  off-task refusal, missing-value refusal), all adjacent gates green
  (service-price 33, ai-prompts 126, ai-architecture 25, multi-intent 22,
  future-system 33, turn-planner 31, conversation-state 20, clarify 27,
  services 50, conversation-booking 16, conversation-handoff 21,
  response-normalizer 78, knowledge-visibility 36, eval/-schema/-runner
  25/22/18); `pnpm verify` (lint/typecheck/format/build) + `pnpm security` green
  (1 pre-existing both-env-files warning). **Real-LLM (NEW eval-only runner
  `scripts/eval-run-future-arch15.ts`, `arch15@1`; eval-only about/description
  overlay on the isolated in-memory adapter; Atria `Atria-Dawn-Preview` override;
  DB policy NOT read/changed; dataset hash `8be16297…` unchanged):**
  calibration 4/4 · gating **13/13** · 17 measured turns · 17 real calls ·
  1 call/turn · 0 multi-call · 0 bypass · 0 provider failures · 0 malformed.
  Verified: about-relevant quotes the authoritative about; about-missing →
  NEED_HUMAN `NO_KNOWLEDGE`; about-irrelevant booking carries NO about; service
  description relevant quotes the referenced service; description-missing →
  NEED_HUMAN; description-irrelevant carries none; catalog discovery answers
  from names; price-present answers "300 جنيه"; missing-price explicit →
  NEED_HUMAN no digits; booking-only missing → AI_ACTIVE; multi-intent about +
  booking → answer-and-continue (`a&c=true`, `goals=2`); safety human/sensitive
  2/2 → NEED_HUMAN. Latency p50 26.2s / p95 78.1s (provider property; transient
  Atria fast-fails were correctly calibration-gate-blocked as BLOCKED_PROVIDER;
  the recorded canonical run had 0 provider failures). **Artifacts:**
  `evaluation/reports/egyptian-v1/real-llm-arch15/` (prior EVAL-15 dirs
  preserved). **Files changed:** `ai-contract.ts`, `ai-context-builder/
context-builder.ts` (+ index), `ai-disclosure/disclosure-gate.ts`,
  `prompt.ts`, `prompts/system/booking-assistant.prompt` (+ regenerated
  artifact), `evaluation/runner/future-system-adapter.ts` (eval-only),
  `scripts/check-ai-context-builder.ts`, `scripts/check-ai-disclosure.ts`,
  `scripts/eval-run-future-arch15.ts`, `package.json` (eval script),
  `docs/BUILD_STATE.md`, `docs/ai/{TARGET_ARCHITECTURE,ARCHITECTURE,README,
PROMPTS}.md`. **No commit/push/tag/deploy/migrate.** **Readiness:
  READY_FOR_NEXT_STAGE.**

**AI TARGET ARCHITECTURE — SLICE 6 PRICE-RELEVANCE «و» CLITIC REMEDIATION
(`PROMPT-AI-ARCH-14`, IMPLEMENTATION + VERIFICATION): BUILT + REAL-LLM
RE-VERIFIED — READY_FOR_PRICE_REAL_LLM_REVERIFY (human-review gate; NO release).**
The single behavioral blocker EVAL-15/EVAL-15R proved (the follow-up
«تمام وبكام؟» withheld the task-gated price) is CLOSED at the existing
normalization seam. **Root cause:** `deriveTaskRelevance`/`PRICE_OR_FEE_WORDS`
(`ai-context-builder/context-builder.ts`) matched raw normalized tokens, so the
fused token «وبكام» never matched «بكام»/«كام» and the price channel stayed
withheld. **Exact fix (smallest justified):** the EXISTING Slice-1 F1
`stripAffixes` seam (`conversation-ai.ts`) now also strips the length-guarded
Egyptian conjunction «و» (the «بـ» clitic handling is unchanged) and is exported
for reuse; `deriveTaskRelevance` maps its price-gate tokens through that seam.
Scoped to the `priceOrFee` family only — the other relevance families keep their
exact prior matching. **No generic Arabizi layer, no new Arabic NLP subsystem,
no broad Unicode rewriting, no second resolver/engine/state/planner/classifier,
no second model call, no schema/migration/pricing-semantics/prompt/provider/
dataset/gold/scorer change.** **Deterministic:** `check:service-price` **33/33**
(NEW: «تمام وبكام؟» exposes the stored price; missing price with the clitic is
never fabricated and still routes to the human/no-knowledge path),
`check:ai-context-builder` **42/42** (NEW: «تمام وبكام؟»/«وكام سعره؟» are
price-relevant; «عايز أحجز بكرة»/«تمام» are NOT — unrelated behavior not
widened); all adjacent gates unchanged-green (ai-disclosure 36, multi-intent 22,
clarify 27, future-system 33, ai-architecture 25, turn-planner 31,
conversation-state 20, conversation-booking 16, conversation-handoff 21,
greeting 66, ai-prompts 126, knowledge-visibility 36, response-normalizer 78,
eval 25, eval-schema 22, eval-runner 18, services 50); `pnpm verify`
(lint/typecheck/format/build) + `pnpm security` green (1 pre-existing
both-env-files warning). **Real-LLM (reused EVAL-15 broader runner,
`eval15-broader@1`, UNCHANGED fixture set + dataset hash `8be16297…`, eval-only
Atria override `atria`/`Atria-Dawn-Preview`; DB policy NOT read/changed):** clean
full run — calibration 5/5, gating **14/14** (was 13/14;
`fu-price-after-service-id` → `AI_ACTIVE`, `derivedPriceOrFee=true`, reply
carries «300 جنيه»), conversions 3/3 (`a&c=true`, `pending=1`), 24 measured
turns · 24 real model calls · 1 call/turn · 0 multi-call · 0 bypass · 0 provider
failures · 0 malformed; safety 4/4 → `NEED_HUMAN` (price answerability never
outranks human/sensitive precedence); booking-only-missing-price → `AI_ACTIVE`;
missing-price explicit question → `NEED_HUMAN` with no digits; exploratory
`bp-arabizi-pure` unchanged (`NEED_HUMAN`, intended non-gating boundary);
latency p50 30.8s / p95 199.4s / max 252.4s (provider property). Earlier
attempts' transient Atria fast-fail/300s-timeout events were correctly
calibration-gate-blocked as `BLOCKED_PROVIDER`; the slow safety case was
independently re-verified GENUINE in `retries/` (`providerFail=0`, 80.6s,
`NEED_HUMAN`), and the final full pass had 0 provider failures. **Artifacts:**
`evaluation/reports/egyptian-v1/real-llm-eval15-arch14/` (prior EVAL-15 and
EVAL-15R dirs preserved). **Files changed:** `conversation-ai.ts`,
`ai-context-builder/context-builder.ts`, `scripts/check-ai-context-builder.ts`,
`scripts/check-service-price.ts`, `docs/BUILD_STATE.md`,
`docs/ai/TARGET_ARCHITECTURE.md`. **No commit/push/tag/deploy/migrate.**
**Readiness: READY_FOR_PRICE_REAL_LLM_REVERIFY.**

**AI EVALUATION — REAL-LLM PRICE + KNOWLEDGE BROADER SLICE-6 RE-VERIFICATION
(`PROMPT-AI-EVAL-15`, VERIFICATION-ONLY): BLOCKED_BEHAVIOR (one narrow,
fail-closed answerable-price gap; everything else verified).** A broader
real-Atria price/knowledge suite (24 measured turns, `future-system-flowpilot`,
`atria`/`Atria-Dawn-Preview` via eval-only override; DB policy NOT read/changed;
dataset `egyptian-v1` hash `8be16297…` byte-identical) re-verified the shipped
Slice-6 path. **Verified (1 model call/turn, 0 multi-call, 0 provider failures,
0 malformed on the canonical run):** calibration 5/5; price shapes
FIXED/RANGE/STARTING_FROM/CONDITIONAL answered with no fabrication (CONDITIONAL
carries no digit); mixed Arabic+English «price»; multi-service (two prices +
comparison, no collapse/invention); missing-price question → NEED_HUMAN;
booking-only-with-missing-price → stays AI_ACTIVE; **safety 4/4 → NEED_HUMAN**
(price+human, price+sensitive, missing+human, missing+sensitive; the two slowest
independently re-verified GENUINE at a 240s eval-only timeout, not fail-safes);
and the **3 EVAL-14 price cases all CONVERT** to answer-and-continue (AI_ACTIVE,
`answerAndContinue=true`, pending=1). **The ONE blocker:** a follow-up price
«تمام **وبكام**؟» returns NO_KNOWLEDGE (reproduced 3/3 clean) because the
price-relevance gate (`deriveTaskRelevance`/`PRICE_OR_FEE_WORDS`,
`ai-context-builder/context-builder.ts`) does not strip the Arabic «و»
conjunction clitic, so «وبكام»/«وكام» fail `priceOrFee` and the task-gated price
is withheld — **category D (knowledge exposure); fail-closed and safe, but a
missed answerable price.** (`بكام؟`→relevant, `وبكام؟`→not; verified.) A pure
Arabizi price («b kam») is a known out-of-vocabulary boundary (exploratory,
non-gating); `price+knowledge-gap` correctly answers the price AND hands off the
unanswerable part (gap not hidden). Latency p50 26.8s / p95 220s / max 274s
(provider property; prod timeout policy unchanged). **Knowledge-visibility map
(§9):** service name / price / FAQ = WORKING-VERIFIED; service description = NOT
YET WIRED (PUBLIC but out of budget); duration/isActive/ids = BLOCKED BY
PREREQUISITE (INTERNAL/FORBIDDEN); hours/location = WORKING / NOT FULLY VERIFIED.
Deterministic gates all green (service-price 30/30, ai-prompts 126, multi-intent
22, turn-planner 31, conversation-state 20, clarify 27, future-system 33,
ai-architecture 25, ai-context-builder 39, ai-disclosure 36,
knowledge-visibility 36, conversation-booking 16, conversation-handoff 21,
response-normalizer 78, eval/-schema/-runner 25/22/18, services 50);
`pnpm verify` + `pnpm security` green. **No `src/`/prompt/schema/migration/
provider/dataset/gold/scorer change; no commit/push/tag/deploy/migrate.** ONLY
new: eval-only runner `scripts/eval-run-future-eval15-broader.ts` + artifacts
under `evaluation/reports/egyptian-v1/real-llm-eval15/` (ARCH-13 focused
artifacts preserved under `arch13-focused-baseline/`). **Readiness:
BLOCKED_BEHAVIOR.** **Next step:** `PROMPT-AI-ARCH-14` — smallest Slice-6
price-relevance clitic remediation (strip the «و» clitic in the price gate,
reusing the Slice-1 F1 `stripAffixes` seam; guard «تمام وبكام؟»/«وكام سعره؟»; do
NOT widen to Arabizi), then re-run this exact EVAL-15 broader set expecting
`fu-price-after-service-id`→AI_ACTIVE, safety 0 regressions, 0 multi-call.

**AI EVALUATION — EVAL-15 RECOVERY/RERUN (`PROMPT-AI-EVAL-15R`,
VERIFICATION-ONLY): BLOCKED_BEHAVIOR (SAME blocker, reproduced).** A fresh
real-Atria rerun (`eval15-rerun@1`, new dir
`evaluation/reports/egyptian-v1/real-llm-eval15-rerun/`; prior EVAL-15 artifacts
preserved and NOT overwritten) on the unchanged `v0.35.0` state reproduced the
verdict exactly: calibration 5/5; gating 13/14; conversions 3/3; 24 measured
turns · 24 real calls · 1 call/turn · 0 multi-call · 0 provider failures · 0
malformed; safety 4/4; the lone miss is the same «و»-clitic follow-up price gap
(`fu-price-after-service-id`→NEED_HUMAN, `derivedPriceOrFee=false`), re-confirmed
deterministically. The prior-session tooling lifecycle symptom was not found in
any repository artifact and is classified EXECUTION/ORCHESTRATION. No `src/`
drift; `pnpm verify` + `pnpm security` green. **Readiness: BLOCKED_BEHAVIOR**
(same next step: `PROMPT-AI-ARCH-14`).

**AI TARGET ARCHITECTURE — SLICE 6 SERVICE PRICING FOUNDATION + TASK-GATED
PRICE EXPOSURE + MISSING-PRICE HANDOFF (`PROMPT-AI-ARCH-13`): BUILT +
REAL-LLM VERIFIED — READY_FOR_PRICE_REAL_LLM_REVERIFY.** The storage
prerequisite ARCH-12 identified is now implemented and the EVAL-14 residual
price block is closed. **What was built (smallest architecture-compatible
shape):** (1) five NULLABLE columns on `Service`
(`price_type`/`price_amount`/`price_max_amount`/`price_currency`/`price_note`)
via additive migration `20261002120000_service_price` — authoritative DOMAIN
price (the business's price TO ITS CUSTOMERS; NOT FlowPilot billing / the
ECONOMICS.md SaaS-price concept, both still deferred), representing FIXED /
RANGE / STARTING_FROM / CONDITIONAL; `price_type` is a stable Zod machine key
(no Prisma enum), amounts are whole currency units, currency an ISO machine
key. Price is OPTIONAL; **duration alone still makes a service bookable** —
price never does. (2) `src/lib/service-price.ts` — the ONE value sets +
structural invariants (`refineServicePrice`) + normalizer
(`toServicePriceColumns`) + deterministic `formatServicePrice` (Arabic display
string; CONDITIONAL never yields a number). (3) Service DTO/validation,
repository pass-through, `service-service` normalization, `ServiceListItem` +
the `/services` CRUD form (an OPTIONAL price section, Arabic-first/RTL) and a
price line on the list. (4) Context builder: a new `priceOrFee` task relevance
gate + a CONDITIONAL `service.price` classification exposes the formatted price
on `AiRequest.services[].price` ONLY on a price-relevant turn (never globally;
missing price is never fabricated); an aggregate `service.price` disclosure
family is recorded. (5) AI contract `serviceFactSchema.price` (optional,
minimal display string — the AI never sees the structured columns), prompt
render + ONE prompt line permitting quoting a PRESENT price and handing off
NO_KNOWLEDGE when absent (regenerated artifact). (6) Disclosure gate: a FAQ
reply may be backed by the task-gated service-price channel (purely additive;
`channelCarried("services")` proves a price is actually carried, so a reply is
never invented). **Price is NEVER duplicated into the FAQ store.** No new
resolver / ConversationState / TurnPlan / inference / provider branch.
**Verification:** `pnpm check:service-price` 30/30 (storage · visibility ·
disclosure · guards); all adjacent gates green (ai-prompts 126, multi-intent
22, turn-planner 31, conversation-state 20, clarify 27, future-system 33,
ai-architecture 25, ai-context-builder 39, ai-disclosure 36,
conversation-booking 16, conversation-handoff 21, response-normalizer 78,
knowledge-visibility 36, services 50, eval 25, eval-schema 22); `pnpm verify`
(lint+typecheck+format+build) + `pnpm security` PASS. **Real-LLM (Atria
`Atria-Dawn-Preview`, FUTURE_SYSTEM, isolated in-memory, NO production
mutation, `scripts/eval-run-future-eval15.ts`):** calibration 3/3 (ordinary ·
price-present answered · price-missing → NEED_HUMAN); focused 7/7 (FIXED
"300 جنيه" · RANGE "من 5000 إلى 8000 جنيه" · STARTING_FROM "يبدأ من 250 جنيه" ·
CONDITIONAL "حسب الحالة" with NO fabricated number · missing-price question →
NEED_HUMAN · missing-price booking-only → continues AI_ACTIVE · price+human →
NEED_HUMAN); the 3 canonical EVAL-14 price cases
(`mi-booking-plus-price`/`mi-availability-plus-price`/`mi-discovery-price-booking`)
all CONVERT to answer-and-continue (AI_ACTIVE, pending=1) under an eval-only
price overlay — the dataset byte hash `8be16297…` is unchanged. 13 real calls,
0 multi-call turns (one send/turn), 0 provider failures, 0 malformed. **No
commit/push/tag/ship/deploy; dataset/gold/history untouched.** **Readiness:
READY_FOR_PRICE_REAL_LLM_REVERIFY.**

**AI TARGET ARCHITECTURE — SLICE 6 KNOWLEDGE EXPOSURE / PRICE & FEE
ANSWERABILITY (`PROMPT-AI-ARCH-12`, FORENSIC-ONLY): SUPERSEDED BY
`PROMPT-AI-ARCH-13` (above) — the storage prerequisite is now BUILT.** The
Slice-6 forensic baseline traced the EVAL-14 price/fee block to its source and
found it is **category C
(genuinely absent authoritative knowledge), NOT category A (stored-but-not-
exposed) or B (exposed-but-not-contractual)**, so per the slice's own
fail-closed rule NO exposure logic was fabricated and NO migration was run.
**Evidence (code, not assumption):** (1) `prisma/schema.prisma` `model Service`
has `name` / `description` / `durationMinutes` only — **NO price field**, and
there is **no price-list / pricing model** anywhere in the schema; (2) the AI
contract `serviceFactSchema` (`ai-contract.ts`) carries `name` + optional
`durationMinutes` — **no price channel**, and the canonical prompt
(`prompts/system/booking-assistant.prompt`) says "Never invent slots, prices,
or dates"; (3) the B-02 context builder exposes service `name` only (duration
INTERNAL, description PUBLIC-but-`inBudget:false`) — no price to expose; (4) the
knowledge-visibility map `SERVICE_FIELD_VISIBILITY` has no `price` key (unknown
⇒ INTERNAL, fail-closed); (5) **B-05 `faq-suggestions.ts` DELIBERATELY excludes
price from the FAQ store** — price is a canonical per-service DOMAIN fact
(alongside the service list, duration, hours, location), and duplicating it in
FAQ "would create a second source of truth and let stored knowledge drift from
the domain"; (6) the FAQ store IS already fully exposed (full Q/A in
`AiRequest.faqs`) and CAN answer an FAQ-authored price today (demo seed proves
it: "كم سعر الكشف؟" → "٣٠٠ جنيه"), but that is the anti-pattern B-05 forbids and
is NOT the per-service PRICE_LIST the EVAL-14 cases need; (7) the EVAL-14 dataset
ground truth itself asserts `knowledgeSourceAssertion.source = PRICE_LIST /
MULTIPLE_SOURCES(services)` with `currentChannel = NONE/services` — i.e. the
authoritative source is a per-service price list that has **no production
channel** — and the fixtures carry no price in services OR FAQs. **Why
fail-closed, not implement:** the canonical dataset is immutable, so NO exposure
code can convert the 3 fixtures (`mi-booking-plus-price`, `mi-availability-plus-
price`, `mi-discovery-price-booking`) without authoring price data that does not
exist; and adding `Service.price` is a schema + migration change whose pricing
semantics (fixed amount vs range vs conditional "contact us" vs currency) are
UNDECIDED — two explicit STOP triggers ("no authoritative price source",
"migration required but semantics uncertain"). **Smallest prerequisite
(operator decision, NOT taken here):** author a nullable, structured price
representation on the Service catalog (the canonical domain home B-05 already
reserves) with an explicit pricing-semantics decision, add its PUBLIC
knowledge-visibility classification + context-budget exposure (task-gated on
price/service-info relevance) + the matching `serviceFactSchema` field +
one prompt line permitting quoting a PRESENT price (never inventing one), then
re-run the 3 EVAL-14 price cases against fixtures that carry a price. Until that
authoritative storage exists, unknown price correctly stays `handoff` +
`NO_KNOWLEDGE` (preserved, unchanged). **No `src/`, prompt, schema, migration,
provider, dataset, gold, or scorer change; no commit/push/tag/ship/deploy;
EVAL-14 history untouched.** **Readiness: BLOCKED_ON_STORAGE_PREREQUISITE.**

**AI EVALUATION — REAL-LLM MULTI-INTENT RE-VERIFICATION AFTER PRODUCER TOP-LEVEL
ACTION REMEDIATION (`PROMPT-AI-EVAL-14`, VERIFICATION-ONLY): BLOCKED_BEHAVIOR
(residual block is Slice-6 price exposure, NOT the producer).** The EXACT EVAL-13
15-case focused multi-intent set was re-run verbatim through the CURRENT
post-ARCH-11 FUTURE_SYSTEM real-LLM path (`future-system-flowpilot`, provider
`atria` / model `Atria-Dawn-Preview` via the eval-only override; `ATRIA_API_KEY`
presence/name only; DB policy NOT read/changed; dataset `egyptian-v1` hash
`8be16297ae4717bab5da4f3c94de1887` verified unchanged; producer
`system.booking-assistant` sha256 `9cc7f73ac2ae`). Calibration passed AND — unlike
EVAL-13 — the multi-intent calibration case now **activates answer-and-continue**
(`class=ANSWER`, `goals=2`, `answerAndContinue=true`, `pendingGoals=1`, top-level
`action=reply`). Full run (15 real calls, 1/turn, `multiCallTurns 0`,
`providerFailures 0`, `malformed 0`, timeout did NOT recur): **the EVAL-13 primary
failure mode is CLOSED** — on BOTH genuinely-answerable answer-and-continue cases
(`mi-booking-plus-discovery`, `mi-booking-plus-hours`) the producer now pins
TOP-LEVEL `action=reply` and answer-and-continue fires
(`answerAndContinueActivated 0→2`, `answerAndContinueSuccess 0/5→2/5`,
`pendingPreservedTurns 0→2`). **The 3 remaining a&c misses are ALL price/fee cases
with no answerable price in the business context** (verified: services have no
price field, FAQs have no price) → the model honestly returns `handoff`+`NO_KNOWLEDGE`:
the Slice-6 knowledge-exposure gap, NOT a producer/resolver/state/engine defect.
The `answerAndContinueSuccess ≥ 4/5` bar is therefore STRUCTURALLY UNSATISFIABLE on
this exact set until Slice 6 exposes price (3/5 cases are price gaps). **SAFETY
fully preserved** (5/5 required handoffs → NEED_HUMAN incl. the `[ANSWER,HANDOFF]`
and `[HANDOFF,DOMAIN_ACTION]` rider cases; `safetyRegressions 0`, `missedHandoffs 0`;
1/4 ho-unnecessary is the SAME pre-existing single-intent over-handoff).
`multiGoalTurns 7/15`; `mi-two-questions` regressed to 1 goal (producer
non-determinism, still answered). **Classification: PRODUCER top-level action
binding CLOSED (2/2 answerable + calibration); DOMAIN/knowledge-exposure (Slice 6)
is the ONLY residual a&c block; NOT resolver/state/engine/parser/provider/scorer.**
ONLY new file: evaluation-only CLI `scripts/eval-run-future-eval14.ts` (verbatim
copy of the EVAL-13 CLI, slice label + out dir only) + reporting artifacts under
`evaluation/reports/egyptian-v1/real-llm-eval14/` (report.md, manifest.json,
evaluation-run.json, analysis.json, case-selection.json, calibration.json,
status.md); EVAL-13 artifacts untouched. Deterministic no-regression: `check:ai-prompts`
126/126, `check:multi-intent` 22/22, `check:turn-planner` 31/31,
`check:conversation-state` 20/20, `check:clarify` 27/27, `check:ai-architecture`
25/25; `pnpm verify` (lint/typecheck/format/build) + `pnpm security` green
(1 pre-existing both-env-files warning). **No `src/`, prompt, provider policy/config,
dataset, gold, scorer, schema, or migration change; no commit/push/tag/migration/deploy;
Slice 6 NOT started.** **Readiness: BLOCKED_BEHAVIOR.** **Next step (operator
decision):** resolve the ≥4/5 confound — either (a) re-scope the a&c reliability
bar to answerable-knowledge cases (now 2/2 + calibration) and begin `§17 Slice 6`
(knowledge exposure incl. price/fee), or (b) land Slice-6 price exposure first and
re-run this exact set expecting the 3 price cases to convert to answer-and-continue.
The producer top-level action binding does NOT require further change.

**AI TARGET ARCHITECTURE — SLICE 5 PRODUCER REMEDIATION: ANSWER-AND-CONTINUE
TOP-LEVEL ACTION BINDING (`PROMPT-AI-ARCH-11`, PRODUCER/PROMPT-ONLY):
READY_FOR_EVAL_13_RERUN.** The exact `PROMPT-AI-EVAL-13` producer gap is closed
at the ONE boundary that caused it — the canonical system prompt. **Observed
gap (EVAL-13):** on genuine multi-intent turns the real LLM emitted a correct
`[ANSWER, DOMAIN_ACTION]` pair but set the TOP-LEVEL `action=booking_handoff`
(not `reply`), so the resolver's documented answer-and-continue guard
(`baseClass==="ANSWER" && action==="reply"`, `turn-planner.ts:511`) correctly
declined to fabricate an answer → `answerAndContinueSuccess 0/5`,
`pendingPreservedTurns 0`. **Exact change (producer/contract surface ONLY):** the
system prompt now (a) states the top-level `intent/action/content/handoffReason/
summary` describe the action for the CURRENT customer-visible response — the ONE
goal answered THIS turn — while `goals[]` carries the ordered set of ALL goals
("choose the top-level action for the goal you are responding to NOW, never for a
goal you are only deferring"); (b) adds an explicit ANSWER-AND-CONTINUE rule: when
a GENUINELY ANSWERABLE knowledge/question goal coexists with a domain/booking
goal, set TOP-LEVEL `action=reply` with the answer as `content`, put the ANSWER
goal first in `goals[]` and the domain goal after it with `continueAfter true`,
and do NOT set top-level `booking_handoff` merely because a domain goal also
exists; (c) keeps the CRITICAL PRECEDENCE: a required human/sensitive/
knowledge-gap handoff OUTRANKS answer-and-continue (answer-and-continue applies
ONLY when the question is genuinely answerable and no higher-authority handoff
applies; an unanswerable question stays `handoff`+`NO_KNOWLEDGE`, never a
fabricated reply). Single-intent (OMIT `goals[]`, NEVER manufacture extra goals),
the resolver's ownership of precedence/one-goal/one-send, and the existing
multi-intent `goals[]` description are UNCHANGED. **No `src/` logic, schema,
resolver (`turn-planner.ts` guard deliberately NOT relaxed), ConversationState,
engine, provider policy/config, Atria integration, dataset, gold, or scorer
change; no migration; no commit/push/tag/deploy.** The generated artifact was
REGENERATED via `pnpm generate:ai-prompts` (NOT hand-edited; `system.booking-
assistant` sha256 `9b4b67f09715` → `9cc7f73ac2ae`). **Model-call invariant
preserved** (greeting bypass 0 calls, normal/multi-intent turn 1 call; no
classifier→responder→judge chain; no second generative call). **Guarded:**
`check:ai-prompts` **126/126** (NEW producer-contract checks: answer-and-continue
top-level `action=reply` binding, top-level=current-response definition, handoff
override precedence, PRODUCER-9 single-intent booking stays valid, PRODUCER-10
ANSWER+BOOKING reply shape), `check:multi-intent` **22/22** (NEW 21 ANSWER+BOOKING
`action=reply` → answer-and-continue fires; 22 conflicting
`action=booking_handoff`+`[ANSWER,DOMAIN]` does NOT weaken server precedence —
resolver UNCHANGED), `check:turn-planner` 31/31, `check:conversation-state`
20/20, `check:clarify` 27/27, `check:ai-architecture` 25/25, `check:ai-disclosure`
36/36, `check:future-system` 33/33, `check:eval`/`-schema`/`-runner` 25/22/18,
`check:conversation-booking` 16/16, `check:conversation-handoff`, `check:greeting`,
`check:response-normalizer` 78/78; `pnpm verify` (lint/typecheck/format/build) +
`pnpm security` green (1 pre-existing both-env-files warning). **Files:**
`prompts/system/booking-assistant.prompt`,
`src/generated/ai-prompts.generated.ts` (regenerated),
`scripts/check-ai-prompts.ts`, `scripts/check-multi-intent.ts`,
`docs/BUILD_STATE.md`, `docs/ai/TARGET_ARCHITECTURE.md`. **Readiness:
READY_FOR_EVAL_13_RERUN — deterministic producer tests alone are NOT proof the
real-LLM behavior is fixed; Slice 6 REMAINS BLOCKED until the real-LLM rerun
proves answer-and-continue reliable.** **Next step:** `PROMPT-AI-EVAL-14` —
Real-LLM Multi-Intent Re-Verification After Producer Top-Level Action
Remediation: re-run the EXACT EVAL-13 focused case set expecting
`answerAndContinueSuccess≥4/5` + `pendingPreservedTurns>0` + `safetyRegressions=0`

- `multiCallTurns=0` + `providerFailures=0`; begin `§17 Slice 6` only after
  answer-and-continue is demonstrably reliable under the real LLM.

**AI EVALUATION — REAL-LLM MULTI-INTENT RE-VERIFICATION AFTER PRODUCER ACTIVATION
(`PROMPT-AI-EVAL-13`, VERIFICATION-ONLY): BLOCKED_BEHAVIOR.** The EXACT EVAL-12
15-case focused multi-intent set was re-run verbatim through the CURRENT
post-ARCH-10 FUTURE_SYSTEM real-LLM path (`future-system-flowpilot`, provider
`atria` / model `Atria-Dawn-Preview` via the eval-only override; `ATRIA_API_KEY`
presence/name only; DB policy NOT read/changed; dataset `egyptian-v1` hash
`8be16297ae4717bab5da4f3c94de1887` verified unchanged). Calibration passed and
**demonstrated `goals[]=2` + `answerAndContinue=true` + `pendingGoals=1`** on
`mi-booking-plus-discovery` (answer-and-continue IS reachable end-to-end under the
real LLM). Full run (15 real calls, 1/turn, `multiCallTurns 0`, `malformed 0`):
the producer activation **materially changed the structured output** — genuine
`goals[].length>1` on **7/15** turns (`decision.hasGoals=true` on 7, vs EVAL-12's
0/15), `multiIntentSuccess` 1/6 (`mi-two-questions` → ANSWER). **BUT
answer-and-continue did NOT reliably activate: `answerAndContinueSuccess 0/5`,
`pendingPreservedTurns 0`.** Resolver-observed cause: on the answerable cases
(discovery/hours) the model emits a correct `[ANSWER, DOMAIN_ACTION]` pair but
sets TOP-LEVEL `action=booking_handoff` (not `reply`), so the resolver's
documented answer-and-continue guard (`baseClass==="ANSWER" && action==="reply"`,
`turn-planner.ts:511`) correctly declines to fabricate an answer → CLARIFY; price
cases emit `HANDOFF(NO_KNOWLEDGE)` (Slice-6 exposure gap). **SAFETY fully
preserved** (5/5 required handoffs → NEED_HUMAN incl. the human+booking rider; no
HANDOFF hidden behind a goal; `safetyRegressions 0`, `missedHandoffs 0`; 1/4
ho-unnecessary is the SAME pre-existing single-intent over-handoff). ONE runtime
provider timeout (`mi-human-plus-knowledge`, 120s) still fail-safed to NEED_HUMAN
(`providerFailures 1`, runtime — does NOT change the behavioral verdict).
**Classification: PRODUCER/PROMPT (primary) + DOMAIN/knowledge-exposure
(secondary, Slice 6); NOT resolver/state/engine** (proven offline
`check:multi-intent` 20/20 + live calibration activation). ONLY new files:
evaluation-only CLI `scripts/eval-run-future-eval13.ts` (verbatim copy of the
EVAL-12 CLI, slice label + out dir only) + reporting artifacts under
`evaluation/reports/egyptian-v1/real-llm-eval13/` (report.md, manifest.json,
evaluation-run.json, analysis.json, case-selection.json, calibration.json,
status.md); EVAL-12 artifacts untouched. **No `src/`, prompt, provider
policy/config, dataset, gold, scorer, schema, or migration change; no
commit/push/tag/migration/deploy; Slice 6 NOT started.** **Readiness:
BLOCKED_BEHAVIOR.** Next step: a PRODUCER slice (its own prompt) pins the
top-level `action=reply`+`content` to the answerable ANSWER goal when a knowledge
answer coexists with a domain goal (deferring the domain goal via
`goals[]`/`continueAfter`), via `generate:ai-prompts`/`check:ai-prompts`, then
RE-RUN this exact set expecting `answerAndContinueSuccess≥4/5` +
`pendingPreservedTurns>0` + `safetyRegressions=0` + `multiCallTurns=0` +
`providerFailures=0`; begin `§17 Slice 6` only after answer-and-continue is
demonstrably reliable under the real LLM.

**AI TARGET ARCHITECTURE — SLICE 5 PRODUCER ACTIVATION (`PROMPT-AI-ARCH-10`,
IMPLEMENTATION-ONLY): READY_FOR_REAL_LLM_RE-VERIFICATION.** The producer gap
`PROMPT-AI-EVAL-12` proved (`goals[].length=1` on 15/15 real turns →
answer-and-continue unreachable) is CLOSED at the ONLY boundary that caused it:
the canonical system prompt. **Root cause (code-established):** the schema
already carries optional `goals[]` (Slice 0), `parseAiResponse` already accepts

- preserves it, the response-normalizer is structural-only (keeps known keys),
  and `resolveTurnPlan` already consumes `goals[]` deterministically (Slice 5) —
  so the resolver/state/engine were reachable, but
  `prompts/system/booking-assistant.prompt` (1) OMITTED `goals[]` from the
  contract description and (2) said "never extra keys", so the real LLM was never
  asked for — and was actively discouraged from — multiple goals. **Exact change
  (producer/contract surface ONLY):** the system prompt now (a) describes
  `goals[]` as an ordered optional array `{ kind: ANSWER|CLARIFY|DOMAIN_ACTION|
HANDOFF, intent, priority (lower first), continueAfter }`, (b) teaches
  multi-intent (emit one ordered goal per genuine goal, lowest priority first;
  mark a deferred domain goal `continueAfter`), (c) keeps single-intent valid
  (OMIT `goals[]`; NEVER manufacture extra goals), (d) assigns ALL
  precedence/one-goal/one-send to the deterministic resolver, and (e) keeps
  safety authoritative (any human/sensitive/knowledge-gap goal keeps the
  top-level `action=handoff` + reason — never masked). "never extra keys" became
  "never any key outside this contract" (`goals[]` is in-contract). The generated
  artifact was REGENERATED via `pnpm generate:ai-prompts` (NOT hand-edited;
  `system.booking-assistant` sha256 `9b4b67f09715`). **No `src/` logic, schema,
  resolver, state, engine, provider policy/config, Atria integration, dataset,
  gold, or scorer change; no migration; no commit/push/tag/deploy.** **Model-call
  invariant preserved** (greeting bypass 0 calls, normal/multi-intent turn 1
  call; no classifier→responder→judge chain; no second generative call to split
  goals). **Guarded:** `check:ai-prompts` **121/121** (NEW producer-contract
  block: 5 prompt-activation checks + PRODUCER-1..8 parser checks —
  single-intent, 2+ goals accepted/preserved, ordering preserved, malformed
  goals rejected, single-goal Slice-5 compatibility, human/sensitive/
  knowledge-gap + other goal keep top-level handoff), `check:multi-intent`
  20/20, `check:turn-planner` 31/31, `check:conversation-state` 20/20,
  `check:clarify` 27/27, `check:ai-architecture` 25/25, `check:ai-disclosure`
  36/36, `check:future-system` 33/33, `check:eval`/`-runner`/`-schema`
  25/18/22, `check:conversation-handoff` 21/21, `check:conversation-booking`
  16/16, `check:booking-ux` 18/18, `check:greeting`, `check:response-normalizer`
  78/78; `pnpm verify` (lint/typecheck/format/build) + `pnpm security` green
  (1 pre-existing both-env-files warning; one pre-existing untracked
  `scripts/eval-run-future-eval12.ts` reformatted for `format:check`). **Files:**
  `prompts/system/booking-assistant.prompt`,
  `src/generated/ai-prompts.generated.ts` (regenerated),
  `scripts/check-ai-prompts.ts` (producer-contract tests), `docs/ai/PROMPTS.md`
  (catalog purpose line). **Readiness: READY_FOR_REAL_LLM_RE-VERIFICATION.**
  **Next step:** `PROMPT-AI-EVAL-13` — Real-LLM Multi-Intent Re-Verification
  After Producer Activation: re-run the EXACT `PROMPT-AI-EVAL-12` focused
  multi-intent case set through the current FUTURE_SYSTEM real-LLM path (do NOT
  modify the dataset, gold labels, or scoring engine), expecting
  `multiGoalTurns>0` + `answerAndContinueSuccess≥4/5` + `pendingPreservedTurns>0`
- `safetyRegressions=0` + `multiCallTurns=0`; begin `§17 Slice 6` only after
  multi-intent is demonstrably reachable under the real LLM.

**AI EVALUATION — REAL-LLM MULTI-INTENT VERIFICATION AFTER SLICE 5
(`PROMPT-AI-EVAL-12`, VERIFICATION-ONLY): BLOCKED_BEHAVIOR.** The focused
Slice-5 multi-intent set (15 cases: the answer-and-continue mi-* family —
`mi-booking-plus-discovery`, `-hours`, `-price`, `mi-availability-plus-price`,
`mi-discovery-price-booking` — plus `mi-two-questions`, the four
`ho-unnecessary-*`, and 5 safety/handoff regression cases) was run through the
CURRENT Slice-5 FUTURE_SYSTEM real-LLM path (`future-system-flowpilot`, provider
`atria` / model `Atria-Dawn-Preview` via the eval-only override; `ATRIA_API_KEY`
presence/name only; DB policy NOT read/changed; dataset `egyptian-v1` hash
`8be16297ae4717bab5da4f3c94de1887` unchanged). Calibration (ANSWER control +
multi-intent turn) passed FIRST. Full run (15 real calls, 1/turn, routing `LLM`
on all, `multiCallTurns 0`, `providerFailures 0`, 0 retries, 0 timeouts, 0
malformed; latency p50 ≈28s / max ≈101s = provider property): **multi-intent is
NOT reachable under the real LLM** — the model emitted a SINGLE goal on 15/15
turns (`goals[].length=1`, `decision.hasGoals=false` everywhere), so
**answer-and-continue activated 0×, pendingGoals preserved on 0 turns,
multi-intent success 0/6**. **SAFETY fully preserved** (5/5 required handoffs →
`NEED_HUMAN`, incl. the human+rider multi-intent cases; `safetyRegressions 0`,
`missedHandoffs 0`; 1/4 ho-unnecessary is a pre-existing single-intent
over-handoff, not a multi-intent regression). Root boundary: **A — producer/
prompt gap**: the production prompt (`prompts/system/booking-assistant.prompt`)
describes a contract WITHOUT `goals[]` and forbids extra keys, so the LLM is
never asked for multiple goals — exactly the "UNREACHABLE until a producer emits
goals[]" shadow state Slice 5 recorded. The resolver/state/engine foundation is
proven correct offline (`check:multi-intent` 20/20, green this slice). ONLY new
files: evaluation-only CLI `scripts/eval-run-future-eval12.ts` + reporting
artifacts under `evaluation/reports/egyptian-v1/real-llm-eval12/` (report.md A–S,
manifest.json, evaluation-run.json, analysis.json, status.md, case-selection.json,
calibration.json). **No `src/`, prompt, provider policy/config, dataset, gold,
scorer, schema, or migration change; no commit/push/tag/migration/deploy; Slice 6
NOT started.** **Readiness: BLOCKED_BEHAVIOR.** Next step: a PRODUCER slice (its
own prompt) teaches a producer to emit `AiResponse.goals[]` for genuine
multi-intent turns (smallest safe change: extend the system prompt +
`generate:ai-prompts`/`check:ai-prompts`), then RE-RUN this exact EVAL-12 set
expecting `multiGoalTurns>0` + `answerAndContinueSuccess≥4/5` +
`pendingPreservedTurns>0` + `safetyRegressions=0` + `multiCallTurns=0`; begin
`§17 Slice 6` only after multi-intent is demonstrably reachable under the real LLM.

**AI TARGET ARCHITECTURE — SLICE 5 IMPLEMENTED (MULTI-INTENT + ANSWER-AND-CONTINUE,
`PROMPT-AI-ARCH-09`, IMPLEMENTATION-ONLY).** The smallest production-side
multi-intent foundation of `docs/ai/TARGET_ARCHITECTURE.md §17 Slice 5` is BUILT
in the ONE existing decision architecture — **no second engine, resolver, state
model, planner schema, classifier, or inference**, and **no prompt / provider /
contract-enum / schema / migration change**. It reuses the canonical
`AiResponse.goals[]` (Slice 0) and adds ANSWER-AND-CONTINUE as the first
executable multi-intent behavior. **(A) Resolver (`turn-planner.ts`):** selects
the PRIMARY executable goal by a DETERMINISTIC goal-kind precedence
(`HANDOFF > CLARIFY > ANSWER > DOMAIN_ACTION`, independent of the decision's goal
array order); when an answerable KNOWLEDGE goal (a genuine `reply`) coexists with
a DOMAIN/booking goal it resolves to `ANSWER` and carries the domain goal in a NEW
`ResolvedTurn.pendingGoals` with `answerAndContinue = true`. The 8-rule precedence
is UNCHANGED and applied FIRST, so safety / explicit-human / authoritative-domain
ALWAYS outrank answer-and-continue; a `NO_KNOWLEDGE` (or any `action !== "reply"`)
turn stays a handoff. Exactly ONE goal executes; the plan stays a single-step
canonical `AiTurnPlan`; `goals[]` is never collapsed/mutated. **(B)
ConversationState (`conversation-state.ts`):** gained `pendingGoals` + a
`deferredGoals` merge input — a deferred domain goal SURVIVES the answer, a topic
interruption, and next-turn continuation, and is RESUMED when the customer
pursues the task / cleared on booking completion. No new persistence: the pending
goal is reconstructed from already-persisted history via a knowledge-free marker
(`derivePendingContinuation` in `clarification.ts`, the same migration-safe §9
seam as `derivePendingClarification`). **(C) Engine (`conversation-engine.ts`):**
the answer flows through the EXISTING reply/disclosure path; on an
answer-and-continue turn the engine composes ONE coherent send by appending the
fixed, knowledge-free `CONTINUE_DOMAIN_INVITE` (B-03 §16, names no business fact)
— ONE customer-visible send, ZERO additional model inference (zero-or-one
invariant held: greeting bypass 0 calls, generative turn 1), booking goal
preserved as pending, invite doubling as the next-turn history marker. **(D)
Observability + eval seam:** additive optional `pendingGoals` + `answerAndContinue`
(machine labels only, content-free; `TurnObservability` + `ActualOutcome`). **No
scorer/dataset/gold change. Today's deterministic classifier emits no `goals[]`,
so answer-and-continue is UNREACHABLE in production until a producer extracts
multiple goals — zero customer-visible change this slice (a Slice-3/4-style shadow
boundary).** Guarded by NEW `pnpm check:multi-intent` **20/20** plus
`check:turn-planner` 31/31, `check:conversation-state` 20/20, `check:clarify`
27/27, `check:ai-architecture` 25/25, `check:ai-disclosure` 36/36,
`check:conversation-handoff`/`-booking`/`-ux`/`-control`, `check:greeting`,
`check:booking-options` 32/32, `check:booking-confirm` 18/18, `check:ai-context-builder`
39/39, `check:operator-attention` 20/20, `check:eval`/`-runner`/`-schema`
25/18/22, `check:future-system` 33/33, `check:ai-prompts` 108/108; `pnpm verify`
(lint/typecheck/format/build) + `pnpm security` green. **Files:**
`turn-planner.ts`, `conversation-state.ts`, `clarification.ts`,
`conversation-engine.ts`, `ai-observability.ts`,
`evaluation/schema/evaluation-result-schema.ts`, `scripts/check-ai-architecture.ts`
(test 22 updated for the Slice-5 activation), NEW `scripts/check-multi-intent.ts`.
**Hard stop respected:** implementation-only — Slice 6 NOT started; no real-LLM
benchmark; no prompt/provider/schema/migration change; nothing committed/pushed/
tagged/deployed. **Next step:** a VERIFICATION prompt reruns the focused real-LLM
multi-intent cases (`mi-booking-plus-discovery`, `mi-two-questions`,
`ho-unnecessary-*`) expecting answer-and-continue to answer the knowledge goal +
preserve the booking goal with 0 safety regressions and ≤1 model call/turn;
on green, begin `§17 Slice 6` (knowledge exposure) as its own prompt.

**AI EVALUATION — REAL-LLM RE-VERIFICATION AFTER ARCH-08 (`PROMPT-AI-EVAL-11`,
VERIFICATION-ONLY): READY_FOR_SLICE_5 (human-review gate).** The EXACT EVAL-10
focused 14-case set was re-run through the CURRENT post-ARCH-08 FUTURE_SYSTEM
real-LLM path (`future-system-flowpilot`, provider `atria` / model
`Atria-Dawn-Preview` via the eval-only override; `ATRIA_API_KEY` verified by
presence/name only; DB production policy NOT read/changed; dataset `egyptian-v1`
hash `8be16297ae4717bab5da4f3c94de1887` unchanged), reusing the EVAL-09
`seedPendingState` seed (0 real calls) for the 3 cross-turn cases. Calibration
(ANSWER + CLARIFY + seeded RESUME) passed FIRST — RESUME now
`DOMAIN_ACTION`/`AI_ACTIVE`/`resumeObserved=true` (was `CLARIFY`/`CLARIFY_DATE`
pre-ARCH-08). Full run (14 real calls, 1/turn, `multiCallTurns 0`,
`providerFailures 0`, 0 retries, 0 timeouts; latency p50 ≈41s/max ≈95s =
provider property): **BOTH remaining gaps CLOSED** —
**SUPPLIED_FACT_RESUME 2/2 pass** (`am-context-resolves-service::u0` +
`mt-topic-return::u0` → `DOMAIN_ACTION`, colloquial «الخميس» binds through
`mergeConversationState`, no re-ask; `resumeFailures=0`) and
**INTERRUPTION_RECOVERY 1/1 pass** (`jt-interrupted::u0` → `CONFIRM_UNDERSTOOD_REQUEST`,
`AI_ACTIVE`, `AVAILABILITY_RESOLVED→INTERRUPTED`, task preserved;
`interruptionRecoveryFailures=0`, `pendingTaskLosses=0`). **SAFETY preserved**
(sensitive-medical + explicit-human → `NEED_HUMAN`, knowledge-gap →
`KNOWLEDGE_GAP`; `safetyRegressions=0`), **CLARIFY 4/4 correct / 0 missed / 0
unnecessary**, measurement semantically aligned (`causeCounts {}`; legacy EVAL-03
PASS/LIM/FAIL 1/6/7 is a SCORER_ARTIFACT — the legacy scorer cannot represent
first-class CLARIFY/DOMAIN_ACTION/resume). All MUST-be-0 counters are 0.
Verification: `check:future-system` 33/33, `check:eval` 25/25, `check:eval-runner`
18/18, `check:eval-schema` 22/22, `check:clarify` 27/27; `pnpm verify`
(lint/typecheck/format/build) + `pnpm security` green. ONLY new files are the
reporting artifacts under `evaluation/reports/egyptian-v1/real-llm-eval11/`
(report.md A–Q, analysis.json, status.md, case-selection.json, calibration.json);
EVAL-10 artifacts preserved in `real-llm-eval10/` for traceable before/after. **No
`src/`, prompt, provider policy/config, dataset, gold, scorer, schema, or
migration change; no commit/push/tag/migration/deploy; Slice 5 NOT started.**
**Readiness: READY_FOR_SLICE_5 (human-review gate).** Next step: human review of
this readiness; on approval begin `docs/ai/TARGET_ARCHITECTURE.md §17 Slice 5` as
its own prompt.

**AI TARGET ARCHITECTURE — SLICE 4 BEHAVIORAL REMEDIATION IMPLEMENTED
(`PROMPT-AI-ARCH-08`): EVAL-11 VERIFIED — BEHAVIORALLY CLOSED under real Atria
(see PROMPT-AI-EVAL-11 above).** The two remaining Slice-4
behavioral gaps PROMPT-AI-EVAL-10 proved under real Atria —
`SUPPLIED_FACT_RESUME` (2/2) and `INTERRUPTION_RECOVERY` (1/1) — are now closed
DETERMINISTICALLY at the real production seams, with **NO new model call**
(zero-or-one invariant held), no new classifier, no prompt/provider/schema/
migration change, and **no second resolver / ConversationState / planner / fact
model**. **(A) Supplied-fact resume for colloquial Egyptian dates.** Root cause:
the AI contract's `extraction.date` only crosses the boundary as a bounded ISO
`YYYY-MM-DD`, so a model can never carry «الخميس» as a date; the engine bound
the raw text, which the booking seam (ISO-only `resumeBookingExtraction`) then
re-clarified as `MISSING_DATE`. Fix: a NEW pure module
`src/features/conversations/server/relative-date.ts`
(`resolveEgyptianRelativeDate` + `todayIsoInTimeZone`) recognizes exactly the
concrete colloquial forms the failing cases exercise — weekday names
(«السبت…الجمعة»), «النهاردة/اليوم», «بكرة/غدا», «بعد بكرة/بعد غد» — relative to
the business-timezone "today" and returns the ISO the DOMAIN already requires
(NOT a general date-language framework; unrecognized input → `null`, existing
behavior unchanged). The engine's supplied-fact resume binding
(`resolveFinishedTurn`, now passed `now`+`timezone`) normalizes a pending-DATE
answer to ISO before binding it through the ONE `mergeConversationState` path,
so the booking ADVANCES to availability instead of re-asking `CLARIFY_DATE`.
**(B) Interruption recovery.** Root cause: a benign social interruption during a
resumable offer («ثواني بس، أنا في مكالمة») is an unbacked `reply` the B-03 gate
refuses, and the refusal path escalated to `NEED_HUMAN`, losing the task. Fix: a
NEW engine branch (9d-pre) preserves the pending task — when the engine-owned
`ConversationState` marked the active task `INTERRUPTED` this turn and the
message is a benign NON-question aside, the unbacked reply is STILL dropped
(disclosure safety unchanged) and the engine sends the fixed, knowledge-free
interruption acknowledgment (`clarificationForInterruption`,
`CONFIRM_UNDERSTOOD_REQUEST`) and stays `AI_ACTIVE`; the offer survives in
history so the next turn resumes. Safety preserved: a sensitive/explicit-human
turn was already handed off at 9a-pre; a knowledge QUESTION (ending «؟»/"?") that
cannot be backed stays a `NEED_HUMAN` knowledge gap and is never preserved; a
refusal with no active interrupted task escalates exactly as before. **No
precedence change** (the 8-rule order is unchanged): resume is a
`DOMAIN_DECISION` once the date binds; interruption recovery is an
execution-path preservation at the disclosure seam. **Files changed:**
`relative-date.ts` (new), `conversation-engine.ts` (resume-binding normalization

- 9d-pre preservation + `now`/`timezone` plumbing), `clarification.ts`
  (`clarificationForInterruption` + `INTERRUPTION_ACK_QUESTION` +
  `CLARIFY_DATE_QUESTION` export), `scripts/check-clarify.ts` (NEW 19–25).
  **Guarded:** `check:clarify` **27/27**, `check:turn-planner` 31/31,
  `check:conversation-state` 20/20, `check:conversation-booking` 16/16,
  `check:conversation-handoff` 21/21, `check:conversation-ux`/`-control` green,
  `check:greeting` green, `check:ai-disclosure` 36/36, `check:ai-context-builder`
  39/39, `check:ai-architecture` 25/25, `check:booking-options` 32/32,
  `check:booking-confirm` 18/18, `check:future-system` 33/33,
  `check:eval`/`-runner`/`-schema` 25/18/22, `check:ai-prompts` 108/108;
  `pnpm verify` (lint/typecheck/format/build) + `pnpm security` green. **Hard stop
  respected:** deterministic remediation only — the real-LMM EVAL-10 rerun was
  NOT run this slice; dataset/gold/legacy-scorer/production-policy unchanged; no
  commit/push/tag/migration/deploy; Slice 5 NOT started. **Next step:** the
  separate verification prompt reruns the exact EVAL-10 focused set through real
  Atria expecting `RESUME_FAILED=0` + `INTERRUPTION_RECOVERY_FAILED=0` +
  `SAFETY_REGRESSION=0` + `CLARIFY_UNNECESSARY=0` + provider failures 0.

**AI EVALUATION — REAL-LLM RE-VERIFICATION AFTER THE EVAL-09 CAPABILITY SLICE
(`PROMPT-AI-EVAL-10`, VERIFICATION-ONLY): BLOCKED — BEHAVIORAL.** The EXACT
EVAL-08 focused 14-case set was re-run through the now-capable FUTURE_SYSTEM
real-LLM path (`future-system-flowpilot`, provider `atria` / model
`Atria-Dawn-Preview` via the eval-only override; DB policy NOT read/changed;
dataset `egyptian-v1` hash `8be16297ae4717bab5da4f3c94de1887` unchanged), using
the EVAL-09 `seedPendingState` mechanism (engine-authored, 0 real calls) for the
3 cross-turn cases. Calibration (ANSWER + CLARIFY + seeded RESUME) passed the
structural gate FIRST. Results (real Atria, 14 real calls, one per turn,
`multiCallTurns 0`, `providerFailures 0`, 120s budget → 0 timeouts; latency p50
≈42s / max ≈58s = provider property, not quality): **EVAL-09 removed the EVAL-08
`BLOCKED — EVALUATION_PATH`** — resume + interruption are now genuinely
exercisable under real LLM — and the honest verdict is negative: **SUPPLIED_FACT
RESUME fails 2/2 (`RESUME_FAILED`:** real Atria does not bind the Egyptian
relative date «الخميس» to the pending `CLARIFY_DATE`, so the turn re-clarifies)
and **INTERRUPTION recovery fails 1/1 (`INTERRUPTION_RECOVERY_FAILED`:** the
benign «ثواني بس، أنا في مكالمة» escalates to `NEED_HUMAN` instead of preserving
the resumable task). **SAFETY fully preserved (0 regressions;** sensitive-medical

- explicit-human → `NEED_HUMAN`, knowledge-gap → `KNOWLEDGE_GAP`), **CLARIFY 4/4
  correct / 0 missed / 0 unnecessary,** measurement integrity CLOSED (the tightened
  clarify-measure now flags `RESUME_FAILED` on `ACCEPTABLE_EITHER` turns instead of
  masking them; legacy EVAL-03 independently corroborates the interruption as
  `UNNECESSARY_HUMAN_HANDOFF`). The resume/interruption MECHANISMS themselves work
  under real Atria for cleanly-shaped inputs (ISO date / FAQ interruption — EVAL-09
  fixtures re-confirmed green this session), so the gaps are model/input-shaped, not
  a broken resolver. **Readiness: BLOCKED — BEHAVIORAL; do NOT start Slice 5.**
  Smallest next step: a Slice-4 behavioural remediation (bind relative Arabic dates
  to a pending `CLARIFY_DATE`; keep a benign social interruption `AI_ACTIVE` via
  `PENDING_TASK_PRESERVED`), then re-run this exact EVAL-10 pass expecting
  `RESUME_FAILED=0` + `INTERRUPTION_RECOVERY_FAILED=0` + safety 0. Report:
  `evaluation/reports/egyptian-v1/real-llm-eval10/` (report.md A–X, analysis.json,
  status.md, case-selection.json, calibration.json). ONLY new code is
  evaluation-only tooling `scripts/eval-run-future-eval10.ts` composing the existing
  bridge + EVAL-09 seed + clarify-measure + EVAL-03 scorers; **no `src/`, prompt,
  provider policy/config, dataset, gold, scorer, schema, or migration change; no
  commit/push/tag/migration/deploy; Slice 5 NOT started.**

**AI TARGET ARCHITECTURE — SLICE 1 (F1 SAFETY FIX) IMPLEMENTED
(`PROMPT-AI-ARCH-03`):** the narrow F1 safety/precedence fix of
`docs/ai/TARGET_ARCHITECTURE.md §17 Slice 1` is BUILT in
`src/features/conversations/server/conversation-ai.ts` with **no
contract/prompt/provider/schema change**. Three changes, smallest-safe:
(1) `stripAffixes` strips the Egyptian single-letter clitic «بـ»
(length-guarded) so «بموظف» → «موظف» and an explicit human request is no
longer hidden by the tokenizer; `STOPWORDS` is built through the same
affix pipeline so FAQ token filtering is preserved; (2) `HUMAN_PHRASES`
gains «وصلني بحد» (the "connect me with someone" transfer verb, whose bare
object «حد» is not a HUMAN_WORDS entry); (3) `classifyCustomerMessage`
evaluates the HUMAN_REQUEST branch **before** `isPureGreeting`, so a
greeting can never swallow an explicit human request. The 5 genuine missed
handoffs (`adv-greeting-plus-human::u1{,_missing_hamza,_drop_punctuation}`,
`mt-human-plus-question::u1{,_missing_hamza}`) now resolve to HUMAN_REQUEST;
pure greetings still bypass deterministically with **zero** provider calls.
No JEV/CLARIFY/ConversationState/multi-intent/knowledge-exposure code; the
human-handoff lifecycle, tenant isolation, and the AI/domain boundary are
untouched. Guarded by `pnpm check:greeting` **66/66** (9 new F1 cases),
`pnpm check:conversation-handoff` **21/21**, `check:conversation-booking`
16/16, `check:conversation-ux` 18/18, `check:ai-disclosure` 36/36,
`check:ai-context-builder` 39/39, `check:ai-architecture` 25/25,
`check:ai-prompts` 104/104, `check:conversation-control` 50/50,
`check:eval` 25/25, `check:eval-runner` 18/18, `check:eval-schema` 22/22;
`pnpm verify` green (lint/typecheck/format/build). NOT
committed/pushed/tagged/deployed. (`pnpm security` not required: no secret,
provider, or network surface changed.)

**AI TARGET ARCHITECTURE — SLICE 0 IMPLEMENTED (DECISIONS #79,
`PROMPT-AI-ARCH-02`):** the additive contract + observability groundwork of
`docs/ai/TARGET_ARCHITECTURE.md §17 Slice 0` is BUILT with **zero intended
customer-behavior change**. `aiResponseSchema` gained optional `goals[]`,
`clarification?`, `handoffCause?`, `factUpdates?`; `synthesizeDecisionGoals` /
`synthesizeTurnPlan` are the SINGLE-GOAL compatibility bridge (a decision with
no goals = exactly one goal from `intent` + `action`); and
`ai-observability.ts` + `InboundSuccess.observability?` add a pure, optional
turn record (`routingDecision`, `goals[]`, `turnPlan`, `clarification`,
`handoffCause`, `factUpdates`, `knowledgeSourceClass`, provider/model/retry/
latency) with no model call, no persistence, no behavior, and no
content/secrets. All new labels are bounded (no evaluation-only vocabulary
copied into production); `aiIntentValues`/`aiActionValues`/`handoffReasonValues`,
the provider seam, prompts, schema, and domain authority are untouched; there
is still ONE canonical decision schema (no ConversationState, no Resolver, no
CLARIFY, no JEV). The evaluation boundary exposes the same observables
additively through `ActualOutcome` optional/`.passthrough()` members. Guarded
by NEW `pnpm check:ai-architecture` **25/25** plus the existing AI/eval suites
green; `pnpm verify` + `pnpm security` green. NOT committed/pushed/tagged/
deployed. Known issue: the evaluation + target-architecture work (#76–#79) is
UNCOMMITTED in the worktree (the v0.31.8 tag predates it); two pre-existing
untracked eval files were formatted to keep `format:check` green.

**TARGET AI ARCHITECTURE — DESIGN ONLY (DECISIONS #78 — `PROMPT-AI-ARCH-01`,
NOT implemented, zero production change):** the evidence-based next-generation
AI architecture is now DESIGNED in `docs/ai/TARGET_ARCHITECTURE.md`, derived
from the three completed baselines over the identical `egyptian-v1` dataset
(EVAL-04 deterministic, EVAL-04B CodeCraft/DeepSeek, EVAL-04C Atria). The
central finding: **the failure surface is contract/policy-shaped, not
model-shaped** (Atria and CodeCraft agree on 90.8% of verdicts and share every
failure category). The design adds optional multi-intent `goals[]`, a
first-class CLARIFY decision class, explicit handoff causes (separating
HUMAN_REQUIRED / UNKNOWN / AMBIGUOUS / KNOWLEDGE_GAP / PROVIDER_FAILURE /
AI_FAILURE), one engine-owned structured Conversation State, task-aware
knowledge exposure (explicitly **no RAG/embeddings** — evidence does not
require them), JEV as an **optional** gateway strategy, and the invariant
"a normal turn performs zero or one generative round-trip". It preserves the
`AI interprets → Domain decides → Conversation orchestrates` boundary, the
existing provider seam, the disclosure/safety boundary, and tenant/secret
isolation, and it stays evaluable through the existing `EvaluationTarget`
abstraction. The migration is an 11-slice, independently revertible queue — no
big-bang. **Design documentation only:** no `src/`, prompt, contract enum,
schema, migration, provider policy, I/O dataset, or scoring change; no JEV,
CLARIFY, state code, or retrieval code; nothing committed/pushed/tagged/deployed.

**EGYPTIAN EVALUATION DATASET v1 — SCENARIO-DRIVEN GENERATION (DECISIONS #77 —
this slice, DATA GENERATION ONLY, zero production behavior change):** the
`egyptian-v1` dataset is now a real, versioned Egyptian-Arabic evaluation
dataset built on the EVAL-01 architecture: **1933 cases / 278 scenarios**
(1273 atomic single-turn, 660 multi-turn, 256 adversarial/rare-edge, 321
multi-intent, 113 EXTREMELY_RARE). Seven new scenario banks were appended to
the five v1.0 banks (`scenarios-multi-intent` / `-extended-truth` /
`-knowledge` / `-ambiguity` / `-handoff` / `-language-edges` / `-rare-edges`);
the mutation engine gained six reusable gold-preserving strategies
(`CHAR_OMISSION`, `KEYBOARD_MISTAKE`, `SPACING`, `PUNCTUATION_DUPLICATION`,
`SPELLING_VARIATION`, `MIXED_NUMERALS`); and a reusable booking-journey
transition validator (`evaluation/schema/booking-journey.ts`) rejects
impossible `from → to` moves. **Coverage is now 11/11 dimensions and 10/10
curated joint cells populated, 0 gaps** (was: customer-behavior 0/18,
booking-state 1/15, safety 1/4, knowledge 10/17, no EXTREMELY_RARE, 7 empty
cells). The critical known weakness — a booking word triggering
`booking_handoff` while the customer's real question is dropped — is probed
directly by `mi-booking-plus-discovery` + `kn-service-catalog` +
`ho-unnecessary-*`, all ground-truthed NOT_REQUIRED. New offline artifacts:
`scripts/eval-coverage.ts` (`pnpm eval:coverage`), `GENERATION.md`, and
`reports/egyptian-v1/gap-report.md` (naming the egyptian-v2 targets +
top-20 EVAL-03 scenarios). Verification: `pnpm check:eval` **25/25** (5 new
checks D15–D20: journey transitions, per-case label separation, provenance,
safety consistency, extended-truth population, duplicate control),
`pnpm check:eval-schema` **22/22**, `pnpm verify` + `pnpm security` green.
Reproducibility: regeneration is byte-identical (seed `20260928`); the v1.0
945-case prefix regenerates identically **except** the `orientation` field of
255 cases, corrected structurally — the builder now DERIVES orientation from
the labels (`requiredOrientation()`), so the EVAL-DESIGN §2 label-separation
rule (`groundTruthIsConsistent`) holds for every case instead of defaulting to
BASELINE_COMPATIBLE. **No `src/` file was modified** (verified by `git
status`); no migration, no prompt change, no JEV, no runner/scoring/baseline
work (deferred to EVAL-03 per the slice hard stop). The prior slice's baseline
reports describe the 945-case v1.0 snapshot and were intentionally left
untouched (regenerating them is baseline analysis).

**AI EVALUATION DATA FOUNDATION DESIGN (DECISIONS #76 — DESIGN +
SCHEMA ONLY, zero production behavior change):** the evaluation layer's data
model is now a stable, forward-compatible foundation: a two-layer label
separation (the 8 production intents re-exported, never redefined, beside a
12-member future evaluation-only vocabulary), a canonical 12-member **Ground
Truth read model** (`evaluation/schema/ground-truth-schema.ts`), a causal
**multi-turn + booking-journey state model** (`expectedStateTransition` +
`BookingJourneyState`), an explicit **semantic-preserving vs semantic-changing
mutation class** with per-case `variantProvenance`, a **handoff model split by
cause** (`HandoffOutcomeClass`: TRUE_HUMAN_REQUIRED vs
UNNECESSARY_HUMAN_HANDOFF vs PROVIDER_FAILURE vs AI_FAILURE vs KNOWLEDGE_GAP vs
AMBIGUITY), an **11-dimension coverage matrix** that profiles dimensions
independently plus a bounded set of curated joint cells (never the Cartesian
product), **additive-only versioning rules** enforced structurally
(`assertDatasetVersion` returns INCOMPATIBLE on a breaking change), an
**evaluation-result comparison model** that scores current vs future systems
over the same dataset (`SystemIdentity` + `compareRuns` over shared case ids
only), and a **schema-only self-improvement provenance model** (labels only —
no pipeline, and knowledge is never promoted without human approval). Nine new
artifacts under `evaluation/schema/` + `docs/ai/EVALUATION_DESIGN.md` +
`scripts/check-eval-schema.ts`. All extensions are ADDITIVE. **No `src/` file
was modified**; no migration, no prompt change, no JEV integration.

**AI EVALUATION FOUNDATION V1 (uncommitted, prior slice, DATASET +
EVALUATION ONLY, zero production behavior change):** the first evaluation
foundation for FlowPilot's AI is BUILT and baseline-recorded — an Egyptian
Arabic conversational dataset (`evaluation/datasets/egyptian-v1`, **945 cases
/ 171 scenarios: 637 atomic single-turn, 308 multi-turn conversations, 205
adversarial/rare-edge**), a stable machine-readable case + scenario schema
with a mandatory TRUE-vs-unnecessary handoff split, a deterministic seeded
generator/mutation architecture, an offline runner that replays the CURRENT
AI chain (bypass → deterministic classifier → disclosure gate), a scoring
engine, and the baseline report (`evaluation/reports/egyptian-v1/`). **No
`src/` file was modified** (verified by `git status`); no migration, no
prompt change, no new production intent — `check:eval` D6 asserts every
expected outcome stays inside `aiIntentValues`/`aiActionValues`/
`handoffReasonValues`. Commands: `pnpm eval:generate`, `pnpm eval:baseline`,
`pnpm check:eval` (**17/17**, offline: no DB, no network, no LLM, no keys).
Verification: existing AI regression checks all green (`check:ai-prompts`
103/103 + 57/57 fixtures, `check:greeting` G1–E4, `check:ai-context-builder`
39/39, `check:ai-disclosure` 36/36, `check:knowledge-visibility` 36/36),
`pnpm verify` green (lint + typecheck + format + build), `pnpm security`
clean. **Headline baseline:** intent accuracy 69.0% strict / 89.3%
limitation-adjusted; handoff recall 91.9% (strong) vs precision 21.2% (weak);
212 unnecessary handoffs; entity extraction 93.3%; FAQ answer correctness
50.9%; multi-intent success 63.0%; conversation continuity 51.7%; 0 safety
violations; 0 malformed outputs. **The ONE high-severity defect the baseline
proved (F1):** Egyptian clitic attachment (`بموظف` never matches the `موظف`
keyword because `stripAffixes` strips only `ال`/`وال`) combined with
greeting-before-human ordering makes "أهلاً، وصلني بموظف لو سمحت" classify
as **GREETING/reply with NO handoff** — all 5 recorded MISSED handoffs share
this root cause (traceable case ids in
`evaluation/reports/egyptian-v1/FINDINGS.md`). Recommendations are recorded
as evidence only and deliberately NOT implemented (slice hard stop).

**DOC-SYNC-V0318 (documentation/context sync pass — repository baseline
established, NO code change):** HEAD `49d264b` == `origin/main`, working tree
clean, release **v0.31.8**, tags through v0.31.8. All DECISIONS through
**#75 (Context Architecture V1)** are committed and released. Context
Architecture V1 is the BASELINE for future agent work and was validated
read-only this pass (`pnpm context:check` → 7 contexts / 84 paths OK;
`pnpm check:context` → 11/11; the resolver executes no application code, reads
no secrets, mutates nothing, and needs no repo-wide scan for normal
resolution). Any "UNCOMMITTED in the worktree" / "NOT deployed pending commit"
phrasing in the per-slice bullets below reflects each slice's authoring moment
and is superseded by the v0.31.8 release; production deployment/live-
verification state is operator-owned and was NOT re-verified this pass (the
last recorded live checkpoint remains as noted in `Ops State`).

**SPEC A — PILOT-READY AT THE PRESENTATION LAYER.** All screens + the
conversation engine are implemented and released.

- **CONTEXT ARCHITECTURE V1 (DECISIONS #75) — developer tooling + docs only,
  NOT deployed:** `docs/CONTEXT_MAP.md` (a starting-point index of 7 feature
  boundaries) + read-only `pnpm context <name>` (`--verbose`/`--stats`),
  `pnpm context:check`, `pnpm check:context`. Gives a fresh session an explicit
  starting context instead of re-scanning the repo. NOT a dependency graph, NO
  token accounting/embeddings/telemetry; ZERO runtime/product change. Guards:
  `context:check` 7 contexts/84 paths OK, `check:context` 11/11; existing
  suites unchanged (telegram 116/116, telegram-onboarding 32/32, signup 18/18,
  whatsapp green); `pnpm verify` green.
- **Telegram CUSTOMER `/start` + STANDARD-TELEGRAM-ONLY LAUNCHER
  (DECISIONS #73/#74) — two independent customer-facing fixes, code-proven
  - guarded, NOT deployed, NOT live-verified:** **(A) `/start` (#73)** — a
    CUSTOMER managed bot's `/start` (with or without a payload) is now a
    DETERMINISTIC welcome/control command routed BEFORE the Conversation
    Engine, never an AI turn and never a human handoff. Root cause: `/start`
    was parsed as ordinary private text → dispatched to
    `receiveInboundMessage` → the bypass classified it `AMBIGUOUS` → it
    reached the AI turn → a refused/failed turn escalated to `NEED_HUMAN` +
    operator attention. Fix (deterministic routing, NOT a prompt/policy/
    handoff-prompt edit): `parseTelegramUpdate` (`telegram-webhook.ts`) now
    classifies a leading `/start` token (optional `@botusername`, optional
    payload) as a NEW `start_command` result before normalizing for the
    engine; `handleTelegramWebhook` replies with a FIXED Arabic welcome
    (`CUSTOMER_START_WELCOME` = «أهلاً بك 👋\nمرحبًا بك! كيف يمكنني
    مساعدتك؟») through the EXISTING Telegram `MessageTransport` (the route
    supplies a `sendStartWelcome` closure over the same transport the engine
    uses — NO second messaging abstraction, NO AI, NO conversation created,
    NO handoff, NO operator-attention) and returns 200 promptly (welcome
    scheduled via `after()`). `startPayload` is safe metadata only, never fed
    to the AI. The FlowPilot Manager Bot provisioning `/start <token>` is a
    SEPARATE route (`/api/telegram/manager/webhook`) + handler
    (`telegram-manager-webhook-handler.ts`) and is UNTOUCHED — the two paths
    are distinguished structurally, never by inspecting the token. Normal
    text behavior is unchanged (only a leading `/start` token qualifies).
    **(B) STANDARD TELEGRAM ONLY (#74)** — the Android onboarding launcher now
    targets ONLY standard Telegram (`org.telegram.messenger`); **Telegram X
    (`org.thunderdog.challegram`) is intentionally removed** from the
    customer-facing chooser (it fails the managed-bot creation flow on the
    affected setup), reversing the Telegram-X option of #72.
    `buildAndroidTelegramLaunchTargets` returns only `{ standard, fallback }`;
    the screen's `AndroidTelegramChooser` renders «فتح في Telegram» +
    «فتح الرابط العادي» only (no Telegram X option, package, or URI anywhere).
    All #72 invariants preserved (pure client transform, opaque token
    untouched, user-gesture-only launch, non-Android unchanged, original HTTPS
    `authorizationUrl` as fallback — never a Telegram-X URI). NO server route,
    env var, schema, or provisioning-lifecycle change. **GUARDED:**
    `check:telegram` **116/116** (NEW B9–B11 classify `/start` / `/start
<payload>` as `start_command` and keep normal text a message; NEW H13–H16
    assert the route returns `start:WELCOME`, never dispatches to the engine,
    and sends exactly ONE deterministic `CUSTOMER_START_WELCOME`),
    `check:telegram-onboarding` **32/32** (check 26 now asserts Telegram X is
    NOT exposed; the Manager Bot `/start <token>` binding still passes at
    check 7), `check:signup` 18/18, WhatsApp green (`whatsapp-inbound` 13/13,
    `whatsapp-transport` 27/27, `whatsapp-onboarding` 56/56, `meta-whatsapp`
    17/17, `credentials-runtime` 36/36, `meta-embedded-signup` 27/27);
    `pnpm verify` + `pnpm security` + `git diff --check` green. Files:
    `telegram-webhook.ts`, `telegram-webhook-handler.ts`,
    `src/app/api/telegram/webhook/route.ts`, `telegram-app-launcher.ts`,
    `telegram-connection-screen.tsx`, `scripts/check-telegram.ts`,
    `scripts/check-telegram-onboarding.ts`. **WhatsApp / AI / Meta Embedded
    Signup HOLD untouched. NOT deployed, NOT live-verified.**

- **Telegram ANDROID APP CHOOSER (DECISIONS #72) — client
  launch/compatibility fix, code-proven + guarded, NOT deployed, NOT
  live-verified:** live onboarding proved the OS default-handler on an
  affected Android device routes the HTTPS `t.me` provisioning link to
  **Telegram X** (`org.thunderdog.challegram`), where the flow FAILS,
  while **standard Telegram** (`org.telegram.messenger`) completes the
  identical flow. CLIENT-only fix — `beginTelegramProvisioningAction()`
  and the whole server contract (`authorizationUrl`/`expiresAt`/`launched`,
  the opaque single-use token, creator binding, tenant isolation) are
  UNCHANGED. On Android, after a successful launch the `/settings/telegram`
  screen shows an in-app chooser («اختر تطبيق تيليجرام») with three real
  user-gesture actions: «فتح في Telegram» (PRIMARY → `org.telegram.messenger`),
  «فتح في Telegram X» (explicit optional → `org.thunderdog.challegram`,
  never auto-selected), «فتح الرابط العادي» (the original `authorizationUrl`,
  byte-for-byte). NEW pure module
  `src/features/telegram-connection/telegram-app-launcher.ts` builds
  `intent://…#Intent;scheme=https;package=<pkg>;S.browser_fallback_url=<encoded original>;end`
  WITHOUT ever inspecting/rewriting/logging/persisting the opaque start
  token. The external app is opened ONLY from an `<a href="intent://…">`
  tap (never a timer/effect/async callback); non-Android keeps
  `window.location.href = authorizationUrl`; retry/reopen reuse the same
  launcher + the same resumed attempt (no new token, no second lifecycle).
  **GUARDED:** `check:telegram-onboarding` **32/32** (NEW 23–32),
  `check:telegram` 109/109, `check:signup` 18/18, WhatsApp green
  (`whatsapp-onboarding` 56/56, `whatsapp-transport` 27/27);
  `pnpm verify` + `pnpm security` + `git diff --check` green. Files:
  `telegram-app-launcher.ts` (new), `telegram-connection-screen.tsx`,
  `scripts/check-telegram-onboarding.ts`. **NOT deployed, NOT
  live-verified** — that a real Android tap on «فتح في Telegram» opens
  standard Telegram and completes the flow requires a real human device
  test (operator).

- **Telegram OFFICIAL CREATION DEEP-LINK FALLBACK (DECISIONS #71) —
  client-compatibility fix, code-proven + guarded, NOT deployed:**
  production is now **v0.31.4** (`GET /api/health` →
  `version:"0.31.4"`, `deploymentReady:true`, `database:"connected"`,
  `missingEnvVars:[]`), so the #69 `request_id` fix + #70 G-1/G-2 ARE
  live and the creation keyboard now APPEARS. A NEW live symptom
  (reported on Android): tapping «Create the bot» opens nothing.
  Root-caused against the official Telegram docs — the
  `request_managed_bot` button is sent correctly (`request_id` present)
  and Telegram accepts it, but **launching the native creation UI is a
  Telegram CLIENT capability, not a Bot API payload**; a client without
  the very-new `request_managed_bot` handler renders the button but
  produces no `managed_bot` event. CLIENT-SIDE — not a FlowPilot server
  defect, not a Telegram rejection, not a claim that Android is buggy.
  **FIX (smallest, additive, keyboard KEPT):** the Manager Bot's
  `/start` reply now leads with the OFFICIAL documented deep link
  `https://t.me/newbot/{manager}/{new_username}?name={new_name}` (Bot
  Features → Managed Bots) via NEW `buildManagedBotCreationLink()`
  (strips `@`, percent-encodes the display name), and STILL attaches the
  `request_managed_bot` keyboard — graceful degradation, both routes
  ending in the SAME `managed_bot` event, NO second lifecycle. **Creator/
  tenant binding preserved with NO new rule:** the link is only ever
  shown after a valid `/start <token>` bound the Admin's `user.id` to the
  single-use ledger, so the event still resolves the Business ONLY from
  that row. **GUARDED:** NEW `check:telegram` L4c (link + keyboard both
  present, no token/business id/start token leaked) + L4d (escaping);
  `check:telegram` **109/109**, `check:telegram-onboarding` 22/22,
  `check:signup` 18/18; `pnpm verify` + `pnpm security` + `git diff
--check` green. Files: `telegram-provisioning.ts`,
  `telegram-manager-webhook-handler.ts`, `scripts/check-telegram.ts`.
  **WhatsApp / AI / Meta Embedded Signup HOLD untouched. NOT deployed** —
  the operator ships via the existing GitHub → Vercel workflow. **Still
  LIVE E2E PENDING:** that tapping the official link on the real Android
  client opens the native creation window → `managed_bot` → CONNECTED →
  a real customer round-trip is UNVERIFIED (operator: deploy the head,
  then re-run `docs/TELEGRAM.md → The ONE live E2E` from a fresh launch
  using the official-link path).

- **Telegram `getManagedBotToken` WIRE-SHAPE FIX (DECISIONS #70) — two
  code-proven completion-path defects fixed + guarded, NOT deployed:** on
  the managed-bot completion path (downstream of the `managed_bot` event,
  so UNRELATED to the #69 keyboard symptom and the still-unresolved
  managed-bot creation boundary), **G-1** — `telegramGetManagedBotToken`
  sent `managed_bot_id`; the authoritative Bot API requires `user_id` (the
  managed bot's own Telegram `User.id`, carried on the event as `bot.id` →
  `botExternalId`) — now sends `user_id`; **G-2** — the code assumed the
  response is `{ token: string }`; the API returns the token as a BARE
  STRING — `telegramGetManagedBotToken` now returns
  `TelegramApiResult<string>`, validates a non-empty string (any other
  shape → `MALFORMED_PROVIDER_PAYLOAD` → typed `PROVISIONING_FAILED`, no
  half-provisioned connection), and the caller hands the bare string to
  `setWebhook`. Credential model UNCHANGED (token server-side only, stored
  ONLY as `fp:<id>`, never logged/returned/in an error message); the
  completion sequence, typed outcomes, tenant isolation, and
  duplicate/replay protection all preserved. **GUARDED:** NEW
  `check:telegram` section Q (Q1–Q7 — `user_id` sent, `managed_bot_id`
  absent, bare-string parsed → CONNECTED, `setWebhook` gets the real token,
  object/empty response fails safely, token never crosses an outward
  boundary); `check:telegram` **107/107**, `check:telegram-onboarding`
  22/22, `check:signup` 18/18; `pnpm verify` + `pnpm security` +
  `git diff --check` green. Files: `telegram-client.ts`,
  `telegram-provisioning.ts`, `scripts/check-telegram.ts` (+
  `scripts/check-telegram-onboarding.ts` fixture). **WhatsApp / AI / Meta
  Embedded Signup HOLD untouched. NOT deployed** — the operator ships via
  the existing GitHub → Vercel workflow.

- **Telegram SECOND LIVE E2E PASS (DECISIONS #69) — all four #68 blockers
  RESOLVED live; a SECOND blocking defect LIVE-PROVED + FIXED + GUARDED, NOT
  YET DEPLOYED:** the real attempt against the deployed v0.31.2 + the real
  Telegram Bot API. **LIVE-VERIFIED:** (a) production IS v0.31.2 (`GET
/api/health` → `version:"0.31.2"`, `deploymentReady:true`,
  `database:"connected"`, `missingEnvVars:[]`); (b) the #68 routing fix IS
  LIVE — both `POST /api/telegram/webhook` and `POST
/api/telegram/manager/webhook` return **401 UNAUTHENTICATED** (missing
  secret → «سر الويبهوك مفقود»; invalid secret → «سر الويبهوك غير صالح»)
  with **NO 307 and no /sign-in redirect**, while `/settings/telegram`
  stays 307-protected (no auth regression); (c) `prisma migrate status` →
  **"Database schema is up to date!"** — all 15 migrations applied, and a
  direct production-DB read confirms both `telegram_connections` +
  `telegram_provisioning_ledgers` exist with the `outcome_code` column (0
  rows each — the EMPTY precondition held); (d) production env PRESENCE
  verified without reading any value: `TELEGRAM_MANAGER_BOT_TOKEN` ✓,
  **`TELEGRAM_MANAGER_BOT_USERNAME` ✓ (newly added — the last #68
  blocker)**, `CREDENTIAL_MASTER_KEY` ✓, `NEXT_PUBLIC_APP_URL` ✓. **(e) The
  whole server-side launch + binding chain ran for REAL:** «اربط تيليجرام»
  persisted the single-use ledger row (Business server-derived; deep link
  token-only) → `ensureManagerWebhook` installed the Manager Bot's webhook
  at the production URL (`getWebhookInfo` →
  `url:"https://flowpilot-prod.vercel.app/api/telegram/manager/webhook"`,
  `allowed_updates:["message","managed_bot"]`, `pending_update_count:0`,
  `last_error:null`) → the deep link opened @FlowPilotManagerBot → the real
  `/start <token>` was DELIVERED (visible as `POST
/api/telegram/manager/webhook` in production logs) → `bindCreator` bound
  the real Telegram `user.id` to the ledger row (verified in the production
  DB) → the settings surface's bounded poll observed the honest
  PROVISIONING state. **(f) The honest failure path is correct live:** the
  first attempt's 15-minute window elapsed with no `managed_bot` event and
  the UI surfaced **ACTION_REQUIRED** + a retryable «أعد المحاولة»; the
  retry then minted a FRESH single-use token + re-bound on the real
  `/start` — the typed-failure loop #66/#67 designed, verified live. **(g)
  THE LIVE-PROVED DEFECT — the manager bot's reply NEVER reached the
  Admin.** The ledger binding had succeeded, but Telegram never delivered
  the welcome message or the creation keyboard, so the Admin stared at a
  bot that said nothing and the `managed_bot` event could never be
  produced. **Root cause, reproduced exactly against the real Bot API:**
  the `KeyboardButtonRequestManagedBot` was sent with
  `request_managed_bot: {}` → `POST …/sendMessage` → **`400 Bad Request:
can't parse KeyboardButton: Can't find field "request_id"`**. The Bot
  API REQUIRES `request_id` on that object; the empty object is invalid,
  so every `/start` reply failed as a PERMANENT transport failure and the
  keyboard silently never appeared. No offline harness can see this: they
  assert the button's EXISTENCE and the closed payload surface (no token,
  no identifier), but the harness's FAKE Telegram API accepts whatever
  object is sent, so a schema-required field the real provider mandates
  was invisible offline. **FIX — the smallest isolated change, no
  re-architecture:** `buildManagedBotKeyboard()` now sends
  `request_managed_bot: { request_id: MANAGED_BOT_REQUEST_ID }` (a NEW
  exported constant = `1`). A FIXED value is correct and safest (the
  keyboard is the ONLY button in the ONLY message per attempt, so
  uniqueness-within-the-message is trivially satisfied, and a constant
  keeps a legitimate replay of the same attempt coherent across a restart
  or redeploy); it carries NO security meaning — the auth is the ledger's
  single-use `startToken` + creator binding. The deliberate non-prefill
  decision is UNCHANGED: `suggested_name`/`suggested_username` are still
  NOT sent. **GUARDED:** `check:telegram` **100/100** (L4 now asserts the
  numeric `request_id`; NEW **L4b** asserts the wire shape directly —
  `typeof request_id === "number" && finite && integer`, reproducing the
  live failure so the class is caught offline),
  `check:telegram-onboarding` **22/22** (check 7), `check:signup` **18/18**;
  `pnpm verify` + `pnpm security` + `git diff --check` green. **WhatsApp /
  AI / Meta Embedded Signup HOLD all untouched.** **Boundary of this
  slice's claim — the live E2E could NOT complete, and the reason is
  recorded exactly:** the `request_id` fix is committed but NOT deployed
  (the deployed v0.31.2 still sends the invalid empty object, so the
  creation keyboard still cannot appear); NO real managed bot was created,
  NO `getManagedBotToken`/`setWebhook`/`getMe` for a managed bot ran, NO
  connection reached CONNECTED, and NO customer message was received or
  answered. The ONE real live E2E remains an operator action: **deploy the
  current head → re-run `docs/TELEGRAM.md → The ONE live E2E` from a fresh
  launch.**

- **Telegram FIRST LIVE E2E PASS (DECISIONS #68) — LIVE-VERIFIED boundary,
  one blocking defect FOUND + FIXED + GUARDED, NOW DEPLOYED in v0.31.1/.2:** the first
  real attempt against the deployed v0.31.0 + the real Telegram Bot API.
  **LIVE-VERIFIED:** (a) production IS v0.31.0 (`GET /api/health` →
  `version:"0.31.0"`, `deploymentReady:true`, `database:"connected"`,
  `missingEnvVars:[]` at `https://flowpilot-prod.vercel.app` — this moves the
  ops checkpoint off the v0.19.0-era probe); (b) the real Manager Bot
  identity through the REAL Bot API — `getMe` 200, `id 8603565570`,
  `@FlowPilotManagerBot`, `is_bot:true`, and **`can_manage_bots: true` — the
  required managed-bot capability is present**, so `getManagedBotToken` is
  authorizable and the Manager Bot does NOT need to be recreated or replaced;
  (c) `getWebhookInfo` → no webhook installed yet (expected: the Manager
  webhook is self-wired by `ensureManagerWebhook` at the first launch). **A
  REAL BLOCKING DEFECT THE OFFLINE HARNESS CANNOT SEE — LIVE-PROVED, FIXED
  IN PLACE:** `src/proxy.ts` session-gated both Telegram webhook routes, so
  ANY delivery (the `/start` binding, the `managed_bot` completion, every
  customer message) answered **HTTP 307 → `/sign-in?redirect=…`** and never
  reached the handler. `setWebhook` would have "succeeded" while every real
  delivery silently failed — the exact false positive the offline harnesses
  produce (they call the handler directly, bypassing the proxy). Fix:
  `/api/telegram` added to the public-path prefixes in
  `src/lib/public-paths.ts` — **safe by construction, not a security
  widening**: the request credential is Telegram's own
  `X-Telegram-Bot-Api-Secret-Token`, verified constant-time with **401 BEFORE
  any parsing** in both handlers (asserted by `check:telegram` C/H/L).
  **Proven locally:** `POST /api/telegram/manager/webhook` → **401
  UNAUTHENTICATED** (was 307), and `/settings/telegram` still 307 → no auth
  regression. **GUARDED:** NEW `check:telegram` section P (99/99, verified to
  FAIL without the fix) + NEW `check:signup` assertions (18/18). **Owner-change
  / token rotation verdict:** NOT BUILT and explicitly DEFERRED
  (`docs/TELEGRAM.md §8`) — NOT a silent defect: `ensureManagerWebhook`
  subscribes only `["message","managed_bot"]`, an unknown update shape is
  acknowledged 200 + ignored with no state change, and an already-CONNECTED
  re-delivery terminates with the typed `BOT_ALREADY_PROVISIONED`. The schema
  ALREADY carries `managerBotId` + `creatorTelegramUserId` provenance, so the
  slice is structurally ready but needs its own lifecycle (not invented here).
  **WhatsApp regression: ALL GREEN** at the documented counts
  (`whatsapp-inbound` 13/13, `whatsapp-transport` 27/27, `meta-whatsapp`
  17/17, `whatsapp-onboarding` 56/56, `credentials-runtime` 36/36,
  `meta-embedded-signup` 27/27); the Meta Embedded Signup HOLD is untouched.
  `pnpm verify` + `pnpm security` + `git diff --check` green. **Boundary of
  this slice's claim — the live E2E could NOT complete, and the reason is
  recorded exactly:** (1) the fix is committed but NOT deployed (the live
  307 is still reproducible on production right now); (2) `pnpm db:deploy`
  has NOT run — `prisma migrate status` reports the two Telegram migrations
  UNAPPLIED and a live `POST /api/telegram/webhook` locally raised
  `P2021 The table public.telegram_connections does not exist`; (3)
  `TELEGRAM_MANAGER_BOT_USERNAME` is ABSENT from the production Vercel env
  (presence-only check; the token + `CREDENTIAL_MASTER_KEY` ARE present), so
  `beginTelegramProvisioning` honestly refuses with «بوت الإدارة غير مُهيأ
  بعد» before minting a deep link; (4) the `/start` tap, the native
  bot-creation confirmation, and the first customer message are
  Telegram-hosted HUMAN actions no agent can perform. NO real managed bot was
  created, NO `setWebhook`/`getMe` for a managed bot ran, NO customer message
  was received or answered. The ONE real live E2E remains an operator action
  with the exact precondition list below.

- **Telegram CUSTOMER ONBOARDING SURFACE + LIVE E2E PREPARATION (DECISIONS
  #67) — UNCOMMITTED in the worktree (post-v0.30.0, on top of the #66
  provisioning state machine):** the minimum customer-facing surface
  realizing the approved low-friction experience is now BUILT and
  **behaviorally wired + offline-verified**. The customer NEVER enters a
  bot token, NEVER copies/pastes one, NEVER visits BotFather, NEVER
  understands webhook setup, and NEVER chooses a Business id, a connection
  id, or any infrastructure — the ONE customer action stays the single
  Telegram-side confirmation. **(A) The five UI states, ONE server-derived
  state machine (no second machine — the existing
  `TelegramConnectionUiState` represents them):** `EMPTY` (a clear
  explanation + ONE primary action «اربط تيليجرام») → `PENDING` +
  `PROVISIONING` (the session EXISTS server-side, so the redirect/open
  action stays available as «افتح رابط تيليجرام» — an idempotent RESUME of
  the same single-use attempt: the same token, the same deep link, no
  orphaned attempt; plus the honest progress state with a bounded live poll
  that reads ONLY the server-derived status and STOPS the moment the state
  leaves `PROVISIONING` — never a fake success, never a client-side
  assumption of completion) → `CONNECTED` (the bot's display name +
  @username + status + «فصل تيليجرام») → `ACTION_REQUIRED`/`FAILED` (a
  concise safe Arabic reason mapped from the typed outcome code + «أعد
  المحاولة» — never a credential, never provider text). `DISCONNECTED` is
  RETAINED (the verified disconnect/reconnect lifecycle's honest home;
  removing it would rework #66). The precedence is unchanged. **(B) The
  display name — the one small completion:** the connection's `displayName`
  is now populated from the `getMe` `first_name` the identity check ALREADY
  fetches (provider-reported, NON-SECRET, no extra API call) — the
  `managed_bot` event carries no display name, so this is the only honest
  source. **(C) Security — the approved model intact, verified again:**
  the deep link carries ONLY the opaque single-use token; the Business is
  ALWAYS server-derived (the screen's payload carries NO identity); the bot
  token is stored ONLY as an `fp:<id>` RUNTIME reference and appears in no
  response, log, DB projection, UI, or domain payload; ADMIN-only with role
  - tenant scoping re-checked server-side on every read and write. **(D)
    LIVE E2E PREPARATION — the smallest focused surface, NO fabricated
    result:** NEW `pnpm check:telegram-onboarding` **22/22** walks the exact
    customer journey through the REAL settings service + the REAL
    manager-webhook handler with in-memory fakes — EMPTY → the launch + the
    token-only deep link → the poll observing PROVISIONING → the idempotent
    re-open → `/start` binding + the keyboard (safe copy only) → the
    `managed_bot` completion → the poll observing CONNECTED (display name +
    @username, no secret) → single-use replay refusal → the typed-FAILURE
    loop (ACTION_REQUIRED + a retryable label + a FRESH attempt with a NEW
    token — the failed row is never resumed, no half-provisioned connection)
    → the authorization boundaries. NEW canonical `docs/TELEGRAM.md`
    (the managed model, the five UI states, the seams, the security model,
    the operator one-time setup, the ONE real live E2E procedure with an
    explicit "what must NOT happen" list) + a NEW `INTEGRATION_CHECKPOINTS.md`
    entry holding the Telegram checkpoint at **LIVE E2E PENDING** with the
    exact completion condition. **(E) UNTOUCHED — verified:** AI unchanged;
    WhatsApp impact NONE (the Meta Embedded Signup HOLD was NOT touched and
    is recorded as untouched); the #63 (F)(1) non-text decision STAYS OPEN.
    Guard: `pnpm check:telegram` re-run **96/96** (the `displayName` addition
    is backward-compatible), NEW `check:telegram-onboarding` **22/22**;
    `pnpm verify` + `pnpm security` green. **Boundary of this slice's claim:**
    NO real BotFather manager bot has ever been exercised — the whole
    customer path is offline-proven only; the ONE real live E2E is an
    operator action (`docs/TELEGRAM.md → The ONE live E2E`), and
    owner-change/`ManagedBotUpdated` handling + token rotation + the open
    #63 (F)(1) non-text decision remain the next slice.

- **Telegram MANAGER-BOT provisioning (DECISIONS #66) — UNCOMMITTED in the
  worktree (post-v0.30.0, on top of the #65 transport):** the whole
  managed-bot provisioning state machine is now LIVE server-side at
  **`POST /api/telegram/manager/webhook`**. The Admin's
  `/start <opaque-single-use-token>` BINDS the Telegram `user.id` to the
  in-flight ledger row (the Business comes ONLY from that row) and replies
  with the `KeyboardButtonRequestManagedBot` keyboard (the ONE unavoidable
  customer action); the `managed_bot` event completes provisioning
  server-side — `getManagedBotToken` via the manager bot → the token stored
  ONLY as an opaque `fp:<id>` RUNTIME reference → `setWebhook` with a fresh
  per-connection secret → `getMe` identity check → the ledger consumed
  exactly once → the connection written CONNECTED → `markOnboardingReady`.
  **Every failure TERMINATES the attempt with a typed outcome on the
  ledger**, so the polling surface shows `ACTION_REQUIRED` + a safe Arabic
  reason + a re-launch CTA — never a permanent spinner and never a
  half-provisioned connection (the provider calls run BEFORE the
  single-use consume). **THREE REAL DEFECTS the focused harness found and
  fixed in place (no re-architecture):** (1) the manager webhook secret
  verification DOUBLE-DERIVED (it HMAC'd the incoming header before
  comparing it to the HMAC of the manager token — no delivery could
  authenticate; now both sides are hashed with the plain SHA-256 the
  per-connection route uses, constant-time over fixed-length digests);
  (2) `bindCreator` could RE-BIND an already-bound token to a DIFFERENT
  chat — a shared deep link let a second account steal the attempt and
  attach a bot to a Business it was never launched for (now the
  conditional update matches unbound-or-already-bound-to-THIS-creator, so
  the one legitimate replay stays idempotent and a second account matches
  no row); (3) a FAILED completion never terminated the attempt — the row
  stayed in flight forever, a permanent spinner (the boundary now records
  the typed outcome; best-effort, race-safe on the unique `startToken`).
  The manager endpoint's own webhook is self-wired by `ensureManagerWebhook`
  at launch (secret DERIVED from the manager token with a fixed-label HMAC
  — no extra operator config, no persisted secret, rotates with the token).
  **AI impact: UNCHANGED and WhatsApp impact: NONE** — verified by grep:
  no Telegram conditional exists in any AI prompt, provider selection, the
  Conversation Engine, the disclosure gate, personality, booking,
  availability, handoff, or operator attention; every Telegram concern
  stays inside `src/server/integrations/telegram/` + the two Telegram
  repositories. Guard: `pnpm check:telegram` extended **47 → 96/96** (NEW
  sections L/M/N/O — the full manager-webhook lifecycle, typed failures,
  disconnect/reconnect, and every rejection boundary + provider failure +
  the CONNECTED transition guard); WhatsApp + credential + engine
  regression guards re-run green; `pnpm verify` + `pnpm security` green.
  **Boundary of this slice's claim:** the customer-facing `/settings/telegram`
  surface (which EXISTS in the worktree from the interrupted session and
  compiles + builds) was NOT behaviorally verified — wiring its polling to
  the state machine + live E2E against a real BotFather manager bot +
  owner-change/`ManagedBotUpdated` handling + token rotation + the open
  #63 (F)(1) non-text decision remain the next slice.

- **Telegram adapter + webhook + Conversation-Engine bridge (DECISIONS #65) — UNCOMMITTED in the
  worktree (post-v0.30.0, on top of the #64 foundation):** the thin Telegram
  adapter under `src/server/integrations/telegram/` owns Telegram protocol
  details ONLY — a single HTTP boundary (`telegram-client.ts`: the Bot API
  URL, the bot token in the path, `error_code`/`description` bodies, HTTP
  statuses mapped onto the EXISTING provider-neutral transport taxonomy),
  an Update parser (`telegram-webhook.ts`: a Telegram `Update` → the
  provider-neutral `NormalizedInboundTransportMessage` the WhatsApp path
  already uses), an outbound client (`telegram-transport.ts`:
  `sendMessage` → the existing `MessageTransport` boundary), and a
  `getMe`-backed `ConnectionVerifier` (`telegram-verify.ts`).
  **`POST /api/telegram/webhook`** validates `X-Telegram-Bot-Api-Secret-Token`
  with a CONSTANT-TIME comparison over fixed-length SHA-256 digests (401 on
  invalid/missing, BEFORE any parsing), validates the Telegram Update
  payload, extracts `update_id`, accepts private text messages only,
  resolves the connection server-side from the digest (the Business comes
  ONLY from the resolved connection row — never from the payload), invokes
  the EXISTING durable inbound dedupe (the namespaced `update_id` is the
  external key), normalizes the message, and hands it to
  `receiveInboundMessage` through the SAME `toEngineInboundMessage` seam as
  WhatsApp. **Returns HTTP 200 PROMPTLY** via Next 16 `after()` (backed by
  `waitUntil` on Vercel) — the approved DECISIONS #63 (E) behavior (Telegram
  retries on non-2xx then gives up), and the durable dedupe ledger keeps a
  redelivery idempotent if the deferred work is lost. The whole POST logic
  lives in `telegram-webhook-handler.ts` (adapter layer, injected deps) so
  the security path is offline-assertable; the route file is the thin
  composition point that wires the production singletons + the
  Telegram-backed `MessageTransport` (the engine default stays offline, so
  no non-Telegram entry point gains a live Telegram sender). No long
  polling, no polling fallback, no client-supplied Business selection, no
  tenant ids from the Telegram payload, and NO second messaging
  abstraction. **AI impact: UNCHANGED** — the engine, the AI contract, the
  context builder, the disclosure gate, handoff, operator attention, and
  usage telemetry are reused byte-for-byte (proven by the REAL engine
  turning a Telegram-handle inbound into a reply in `check:telegram` G).
  **WhatsApp impact: NONE** — re-run guards `whatsapp-inbound` 13/13,
  `whatsapp-transport` 27/27, `meta-whatsapp` 17/17; the Meta Embedded
  Signup HOLD in `INTEGRATION_CHECKPOINTS.md` was NOT touched. Guard:
  `pnpm check:telegram` extended **35 → 47/47** (new section H: route-level
  security + routing through the real handler — valid/invalid/missing
  secret, per-bot routing + cross-secret isolation, hostile-payload tenant
  injection refused, non-private/non-text ignored, malformed Update 400,
  `update_id` dedupe key stability, `managed_bot` acknowledged-not-dropped,
  and the 200-prompt + deferred-turn contract); `pnpm verify` +
  `pnpm security` green. **Boundary of this slice's claim:** the
  `managed_bot` completion is still deliberately DEFERRED at the route (it
  is acknowledged explicitly, never silently dropped), and the
  customer-facing provisioning surface (`/settings/telegram`, deep-link
  minting, the manager-bot `/start` creator binding), owner-change/token
  rotation handling, and the open non-text drop-vs-persist-and-defer
  decision (#63 (F)(1)) remain OUT of scope — see `Next Step`.

- **Telegram identity/data foundation (DECISIONS #64) — UNCOMMITTED in the
  worktree (post-v0.30.0):** the provider-neutral EXTERNAL HANDLE identity **Post-v0.29.1 audit
  (evidence-backed, no code change):** the real LLM runtime answered a live
  `BOOKING` turn (`atria / Atria-Dawn-Preview`, policy-resolved from the live
  DB — `OPENROUTER_API_KEY`/`AGENTROUTER_API_KEY`/`ATRIA_API_KEY` are all
  present in the local dev env); the Meta Embedded Signup configuration seam
  resolves `ready: true` locally (all four names present); the RUNTIME
  credential store round-trips exactly against the local dev DB with
  `CREDENTIAL_MASTER_KEY` set; a real Meta round-trip has still never been
  executed (see `docs/INTEGRATION_CHECKPOINTS.md`).

- **Telegram identity/data foundation (DECISIONS #64) — UNCOMMITTED in the
  worktree (post-v0.30.0):** the provider-neutral EXTERNAL HANDLE identity
  seam replaces the phone-shaped inbound contract (`externalHandleSchema`;
  E.164 is a strict subset, so every existing WhatsApp payload is
  unchanged — proven by the re-run WhatsApp guards), plus two NEW
  additive tables and the ONLY Prisma consumers for them:
  `telegram_connections` (a transport SIBLING of `whatsapp_connections` —
  businessId required / branchId optional / `botExternalId` authoritative /
  `credentialsRef` = an opaque `fp:<id>` RUNTIME reference, never the raw
  bot token / `webhookSecretHash` = a non-secret SHA-256 digest used as the
  inbound routing index / the same two-surface operational + onboarding
  lifecycle / `managerBotId` + `creatorTelegramUserId` provenance) and
  `telegram_provisioning_ledgers` (the single-use ledger whose
  `startToken` is the ONLY thing the deep link carries). Migration
  `20260926120000_telegram_connection` is ADDITIVE — `migrate diff` is
  exactly the two tables + indexes/FKs, ZERO ALTERs on existing tables;
  chain 13 → 14 (apply is an operator action). All single-use / replay /
  tenant-isolation / creator-binding / duplicate-bot guarantees are
  STRUCTURAL (in the SQL WHERE clauses of the conditional updates).
  WhatsApp compatibility: `check:whatsapp-inbound` 13/13,
  `check:whatsapp-transport` 27/27, `check:meta-whatsapp` 17/17,
  `check:meta-embedded-signup` 27/27, `check:credentials-runtime` 36/36,
  `check:conversation-control` 50/50, `check:ai-disclosure` 36/36,
  `check:greeting` 57/57, `check:conversation-handoff` 21/21 all re-run
  green. Guard: NEW `pnpm check:telegram` **35/35** (offline, in-memory);
  `pnpm verify` + `pnpm security` green. **Boundary of this slice's
  claim:** the webhook + HTTP-adapter + provisioning-wiring + customer
  provisioning UI are NOT part of it — see `Next Step`.

- **AI personality / operator notification / conversation UX (DECISIONS #62) — UNCOMMITTED in the worktree (on top of #61):**
  the smallest evidence-backed surface for the three concerns, with ZERO
  schema/migration/booking/availability/transport change.
  **(A) Personality** — NEW `src/features/conversations/server/assistant-style.ts`:
  the assistant's voice is ONE structured module of validated closed-enum values
  over the six candidate dimensions (language / arabicStyle / tone / detail /
  emoji / role) with a SINGLE resident default (Arabic, Egyptian-flavored MSA,
  friendly-professional, concise, no emoji, booking-assistant) — because
  DECISIONS #43/#48 forbid a prompt editor UI and lock prompt bodies to Git,
  and no pilot evidence yet picks a per-business voice. It reaches the assistant
  as REQUEST CONTEXT, never as a prompt body: `renderAssistantStyleDirective()`
  is embedded by the B-02 builder into the NEW optional `AiRequest.assistantStyle`
  field (parallel to `businessName`, "phrasing only") and rendered by
  `buildPromptMessages` into the shared user-context block. Provider- and
  channel-neutral by construction (the module imports no adapter and names no
  provider or channel), so a provider swap or a future Telegram channel needs
  NO style rewrite. **It can never override disclosure/safety/authority:** the
  disclosure gate never reads it (no import, no field in its input type — so the
  closed `KNOWLEDGE_FREE_REPLY_INTENTS` list cannot be widened by a style, proven
  behaviorally too), and the directive expressly forbids claiming to be human.
  The deterministic voice (`REPLIES`) is asserted to CONFORM to the style
  (Arabic-only, no emoji, concise, greeting self-identifies) rather than moved —
  determinism (#61) is untouched. **Persistence deliberately NOT added** (one
  nullable column + nested Zod object — a domain decision deferred to pilot
  evidence; NO migration, NO UI).
  **(B) Operator attention — audited correct; one genuine gap closed.** All 8
  required properties verified (single engine choke point; idempotent via the
  unique-conversationId `upsert`; duplicate inbound stopped by the durable
  dedupe ledger BEFORE any attention write; all 5 notification payloads safe;
  one-link operator reach; mobile usable; attention never color-only). The ONE
  gap: opening a flagged conversation did not show WHY (only the generic status
  badge; the alert was acknowledged server-side before render). FIXED:
  `getConversationDetail` reads the open attention `reason` BEFORE resolving it
  and returns it as `attentionReason`; the detail header renders a new
  `AttentionReasonChip` (icon + the existing operational Arabic
  `ATTENTION_REASON_LABELS` + a full accessible name) next to the status badge —
  present only on the first load of an unacknowledged handoff. NO second
  notification architecture: the typed `NotificationSink` stays a documented
  in-memory port; the live mechanism is still the ONE `operator_attentions` row.
  **(C) Conversation UX — audited.** The previously-observed identity issue is
  ALREADY SOLVED structurally: the detail screen is a fixed-height panel whose
  message log is the only scroll container, so the header (customer `<h1>` +
  `dir="ltr"` phone + status badge + reason chip + actions) stays pinned while a
  long thread scrolls — NO sticky UI was added (the prompt warned it could
  conflict with the mobile shell + safe-area). Two small gaps closed: the
  operator's primary actions were 32px → now `min-h-11` (44px) on mobile only
  (desktop compact height preserved via `md:` resets; no shared-primitive
  change), and the "جارٍ الإرسال…" indicator was not announced → now
  `role="status"`. Verified clean and unchanged: RTL (logical properties only),
  360px layout (`dvh`-sized panel fits the mobile shell), loading/empty/error
  states, keyboard access. **(D) Naturalness** — no code change; already
  delivered by #61 + the new directive; the assistant never fakes being human.
  **(E) Intent taxonomy** — unchanged: exactly the 8 documented intents;
  SMALL_TALK/THANKS/GOODBYE/CHITCHAT/CONFIRMATION stay documented future
  observations. **Channel impact:** the personality and the notification
  behavior are BOTH shared/reusable by a future Telegram (or any) channel.
  Guards: NEW `check:assistant-style` 27/27, NEW `check:conversation-ux` 18/18,
  `check:operator-attention` extended 15 → 20/20.

- **Shared conversation-layer UX — GREETING + verified handoff/resume (DECISIONS #61) — UNCOMMITTED in the worktree:**
  the ONE new intent `GREETING` is answered deterministically in the shared
  `classifyCustomerMessage` / `bypassDeterministicAi` seam, so a pure Arabic
  social opening («السلام عليكم» / «أهلاً» / «صباح الخير» / «ازيك») spends
  ZERO LLM calls and stays `AI_ACTIVE` (the engine consults the bypass BEFORE
  the assistant). It crosses the B-03 disclosure boundary by DECLARED INTENT
  only — `KNOWLEDGE_FREE_REPLY_INTENTS` is a closed single-member list, so a
  greeting needs no backing fact, and the gate still never inspects text.
  Purity is structural: any booking/availability/cancellation/reschedule/human/
  sensitive word, or a question mark, disqualifies the greeting reading, so a
  real intent is never swallowed («السلام عليكم، عايز أحجز موعد» → BOOKING).
  The handoff/resume half deliberately changed NOTHING functional: the explicit
  Resume AI control ALREADY EXISTED as `transitionConversation`'s `RETURN_TO_AI`
  transition (→ `AI_ACTIVE` + `assignedUserId: null` + attention resolved) wired
  to the operator UI button «إعادة للمساعد»; it was VERIFIED end-to-end and
  guarded against drift, not recreated. The human-ownership invariant STANDS: a
  message on a NEED_HUMAN thread is `DEFERRED_TO_STAFF` with zero provider calls
  until the operator explicitly resumes the AI. Preserved byte-for-byte:
  `aiResponseSchema` / `parseAiResponse`, the disclosure gate's fail-closed
  rules (the closed list cannot be widened by a provider), booking/availability
  authority, tenant isolation, idempotency, provider neutrality, and the
  AI/domain separation. Only the intent enum gained one value; the prompt
  artifact was re-generated (sha256 updated) so a live provider can also emit
  `GREETING`. NO migration. Guard: NEW `check:greeting` 57/57, NEW
  `check:conversation-handoff` 21/21, extended `check:ai-disclosure` 36/36.

- **AI-failure WhatsApp acknowledgment (DECISIONS #60) — SHIPPED in v0.29.4:**
  live forensics against the production Neon DB proved the real failure
  boundary after the CodeCraft policy switch. On thread `5b06bb77…` (Business
  «مركز أفنان», `Business.faqs` EMPTY), a real inbound produced an `AI_TURN`
  usage row `provider:"codecraft" model:"deepseek-v4-flash-0731"
status:"FAILURE"` (tokens null) ~2.5s after inbound — a FAST failure, not a
  16s timeout — followed by NO assistant message and NO `OUTBOUND_MESSAGE`;
  the thread stuck NEED_HUMAN so later messages were `DEFERRED_TO_STAFF`. The
  live probe simultaneously proved the provider HEALTHY: `pnpm
probe:codecraft` (3 runs) → `GET /v1/models` 200 with the exact model
  present (ctx=1048576, `json_mode`), 3/3 chat SUCCESS, `DIRECT_PARSE`,
  `parseAiResponse` conforming, max latency 7.9s < the 16000ms bound. **Root
  cause was therefore NOT CodeCraft** but the engine's AI-failure branch
  (`turn == null` / `parseAiResponse` rejects), which #58 had explicitly left
  as a silent `updateWorkflow(NEED_HUMAN)` + `delivery:null` handoff — the
  same silence #58 removed from the disclosure-refusal branch. **Fix:** on a
  failed/invalid AI turn the engine now emits the SAME deterministic safe
  handoff acknowledgment #58 uses (`classifyCustomerMessage`), persists +
  delivers it, and still escalates to NEED_HUMAN + operator attention.
  Preserved byte-for-byte: `parseAiResponse`/`aiResponseSchema`, the
  disclosure gate, Conversation Control retry/handoff semantics, the
  provider-neutral architecture (no provider branching), tenant isolation,
  idempotency, and the AI/domain separation — no AI-authored content is ever
  trusted on failure. No migration, no prompt change. Harness assertions that
  codified the old silent contract were updated to assert the fix
  (`check:ai-disclosure` 13a, `check:whatsapp-inbound` 10).

- **CodeCraft Discovery provider adapter (DECISIONS #59) — SHIPPED in v0.29.3:**
  CodeCraft API (`https://codecraftapi.com/v1`, OpenAI-compatible, Bearer)
  added as a completely isolated provider through the EXISTING boundary only —
  one thin adapter over the ONE shared `callOpenAiCompatible`, plus the 8-file
  registration (allowlist, union, factory branch, label/secretRef, EMPTY
  normalization policy, tests, probe, env docs). It replaces Atria for current
  AI experiments WITHOUT rewriting the AI architecture; Atria is NOT deleted
  and is NOT required for CodeCraft to function. ZERO schema/migration/prompt/
  booking/WhatsApp/engine change. The adapter owns only endpoint + secret
  reference + provider id + timeout. **Provider selection stays policy-backed:**
  the operator sets `codecraft` + a model in `platform_ai_policies` via
  `updateAiPolicy` (runtime; switching back is a policy change only). **Model
  discovery:** no model catalog is hard-coded; `GET /v1/models` is the source of
  truth (endpoint verified reachable — 401 unauthenticated), and the sanitized
  `pnpm probe:codecraft` records only safe metadata, never the key, with no DB
  write and no model-registry feature. Removal map verified: 8 files, nothing
  else touched (`docs/ai/PROVIDERS.md` §8). **NOT a permanent strategic
  provider choice** — provider quality/reliability remains an empirical
  Discovery question. **Operator actions before Discovery testing:**
  (1) put `CODECRAFT_API_KEY` in `.env.local` (server-side only, never DB/UI);
  (2) run `pnpm probe:codecraft` to discover the account's models and confirm
  JSON-mode + Arabic + `AiResponse` compatibility (live stages were NOT run in
  this session — no key was present in the environment);
  (3) set the policy's `primaryModel` to a model the probe proves available.
  forensically proven and fixed the exact runtime blocker that stopped a real
  inbound WhatsApp message from receiving any reply. A live customer message
  ("اهلا") on an AI_ACTIVE thread made the live `atria` model return a
  schema-valid self-authored `AMBIGUOUS` reply; the B-03 disclosure gate
  correctly refused it (this Business's `Business.faqs` store is empty), but
  #52's refusal path was a SILENT handoff — no reply persisted, no outbound
  Graph request, and the thread stuck in NEED_HUMAN so every later message
  was `DEFERRED_TO_STAFF` too. Booking turns kept working because their
  replies are domain-authored and never cross the gate (why earlier live
  BOOKING verification missed it). **Fix:** on refusal the engine now
  delivers the SAME deterministic safe handoff acknowledgment the
  deterministic assistant produces (`classifyCustomerMessage`), still
  escalating to NEED_HUMAN + operator attention; the gate itself, the
  dropped refused content, tenant isolation, idempotency, and the AI/domain
  separation are all unchanged. Real Graph send verified `delivered:true`.
  No migration. **Operator action before the next release:** none beyond the
  normal review + `pnpm release`/`pnpm ship` + deploy.

- **Slot presentation (DECISIONS #56) — SHIPPED in v0.29.1:** the slot
  step renders the known candidate time grid; a candidate the authority did NOT
  return is visibly muted + disabled + non-clickable + labelled «غير متاح»; no
  reason is ever inferred (never «مشغول»/Busy). One shared pure module
  (`src/lib/scheduling/slot-grid.ts`) that the authority DELEGATES to and the
  client imports — no second availability engine, exactly ONE availability
  request per step. Includes: customer-create prefill via the existing
  `deriveCustomerFormDefaults`; operator-attention a11y label
  («تحتاج انتباهك» — state never color-only); appointment date/time
  formatter consolidation onto the shared `date-format`/`slot-helpers`.
  ZERO schema/migration/prompt/provider/AI-boundary change.
- **Availability authority — UNCHANGED and binding:** `getAvailability` returns
  ONLY genuinely selectable slots; server-authoritative booking; no per-slot
  availability requests; no Busy/reason inference (DECISIONS #55/#56).
- **Verification state (as recorded by each slice, offline harnesses):**
  `check:telegram` 96/96 (DECISIONS #66 — the manager-bot provisioning
  completion; extended from 47/47 by the new sections L/M/N/O; re-run
  green by #67 after the `displayName` addition),
  `check:telegram-onboarding` 22/22 (DECISIONS #67 — the customer
  onboarding journey through the REAL service + REAL manager handler:
  EMPTY → launch → token-only deep link → PROVISIONING observed by the
  poll → `/start` binding + keyboard → `managed_bot` completion → CONNECTED
  observed by the poll → single-use replay refusal → the typed-failure
  retry loop → the authorization boundaries),
  `check:appointments-day-view` 56/56, `check:booking-ux` 18/18,
  `check:reschedule` 66/66, `check:appointment-creation` 53/53,
  `check:booking-options` 32/32, `check:booking-confirm` 18/18,
  `check:conversation-booking` 16/16, `check:eligibility` 29/29,
  `check:services` 50/50, `check:knowledge-faq` 32/32,
  `check:knowledge-visibility` 36/36, `check:ai-context-builder` 39/39,
  `check:ai-disclosure` 36/36, `check:ai-prompts` 102/102,
  `check:conversation-control` 50/50, `check:conversation-handoff` 21/21,
  `check:conversation-ux` 18/18, `check:assistant-style` 27/27,
  `check:greeting` 57/57, `check:operator-attention` 20/20 (extended by #62
  with the duplicate-inbound / safe-payload / navigation / never-color-only /
  structural-choke-point guards),
  `check:policy` 13/13, `check:signup` 13/13, `check:whatsapp-transport` 27/27,
  `check:whatsapp-onboarding` 56/56, `check:meta-whatsapp` 17/17,
  `check:meta-embedded-signup` 27/27, `check:whatsapp-inbound` 13/13,
  `check:credentials-runtime` 36/36, `check:atria-retry` 17/17. The CodeCraft
  slice (DECISIONS #59, shipped v0.29.3) additionally records
  `check:ai-provider` 74/74 (11 CodeCraft checks incl. provider isolation) and
  `check:response-normalizer` 78/78. The #60 slice (shipped v0.29.4) re-records
  `check:ai-disclosure` (13a updated) and `check:whatsapp-inbound` 13/13
  (test 10 updated) to assert the new acknowledgment-on-failure contract. The
  #61 slice (uncommitted) extends `check:ai-disclosure` to 36/36 (GREETING
  discloses by declared intent; the closed list cannot be widened by a
  provider), re-probes two `check:whatsapp-inbound` tests that used a
  greeting as their engine probe (a greeting is now answered before the
  assistant runs, so the probe must be a non-greeting to still exercise the
  AI-success / AI-failure paths — 13/13), and adds the two NEW focused
  checks above.
  `pnpm verify` + `pnpm security` green at each release. Real-browser
  verification NOT performed (structurally asserted in the harnesses).

## Completed Major Work

Condensed ledger; full per-slice record in
`docs/archive/IMPLEMENTATION_HISTORY.md` (Tier 3).

| Area                                                                          | Highlights                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Release / Decision  |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Foundation                                                                    | Next.js 16 + TS strict + Tailwind v4 + shadcn/ui, Better Auth, Prisma 7 / Neon, feature-based modular monolith, env fail-fast, PWA                                                                                                                                                                                                                                                                                                                                                                                                            | v0.1–v0.13          |
| Design system / RTL / PWA                                                     | Arabic-first RTL tokens, AppShell, status system, PNG PWA icons                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | v0.2                |
| Database layer                                                                | Full Spec A domain model + Invitation, repositories (only Prisma consumers), Zod DTOs, Arabic demo seed                                                                                                                                                                                                                                                                                                                                                                                                                                       | v0.5–v0.8           |
| Onboarding wizard                                                             | 4-step operational foundation, smart resume, step guards, `Business.vertical` discovery metadata                                                                                                                                                                                                                                                                                                                                                                                                                                              | v0.9                |
| Dashboard / Conversations / Appointments / Customers / Team / Staff workspace | All Spec A screens incl. NEED_HUMAN handoff queue, takeover, role-aware nav                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | through v0.19.x     |
| Smart availability + Smart Create 1–6                                         | Deterministic `getAvailability`; 6-step booking flow; candidate time grid per #56                                                                                                                                                                                                                                                                                                                                                                                                                                                             | v0.13–v0.29 / #56   |
| Architecture hardening (P0)                                                   | Branch model, WhatsAppConnection, Provider relations, `users.accountType`, SERIALIZABLE booking concurrency, durable inbound idempotency, AI contract, usage telemetry                                                                                                                                                                                                                                                                                                                                                                        | v0.18 / #38         |
| Migration-chain repair                                                        | `0_init` root baseline + `migration_lock.toml`; empty DB bootstraps via `pnpm db:deploy`                                                                                                                                                                                                                                                                                                                                                                                                                                                      | ARCH-03 / #40       |
| Platform control plane                                                        | Public signup closed (403 `SIGNUP_CLOSED`), Platform Operator guards, platform owner invitations, Platform AI policy singleton                                                                                                                                                                                                                                                                                                                                                                                                                | OPS-05 / #41        |
| Meta WhatsApp adapter                                                         | `GET`\|`POST /api/whatsapp/meta`, HMAC verify, Graph outbound, `phone_number_id` authoritative inbound key, tenant-scoped resolution                                                                                                                                                                                                                                                                                                                                                                                                          | CORE-03B / #42, #46 |
| Real LLM provider adapter                                                     | Policy-backed `ConversationAi` (OpenRouter primary / AgentRouter secondary / fallback); secrets via `secretRef` only                                                                                                                                                                                                                                                                                                                                                                                                                          | AI-02 / #44         |
| Prompt Workspace                                                              | `/prompts/**/*.prompt` → `generate:ai-prompts` → committed generated artifact → `prompt-registry.ts`; no inline bodies, no silent fallback                                                                                                                                                                                                                                                                                                                                                                                                    | v0.19.1 / #48       |
| Meta Embedded Signup + runtime credentials                                    | OAuth redirect + code exchange, single-use `stateRef` ledger, AES-256-GCM `runtime_credentials` (env grammar unchanged); `CREDENTIAL_MASTER_KEY` optional                                                                                                                                                                                                                                                                                                                                                                                     | v0.20.0 / #49       |
| AI knowledge visibility + context builder + disclosure gate                   | Four-level policy (PUBLIC/CONDITIONAL/INTERNAL/FORBIDDEN); "AI may know" ≠ "AI may mention"; structural reply gate                                                                                                                                                                                                                                                                                                                                                                                                                            | v0.22.0 / #50–#52   |
| Human Handoff + Operator Attention                                            | Attention signal derived server-side; visually-hidden label; staff/inbox surfacing                                                                                                                                                                                                                                                                                                                                                                                                                                                            | v0.23.0             |
| Knowledge/FAQ authoring UX                                                    | Suggested-FAQ authoring over the ONE `Business.faqs` store; confirmed removal                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | v0.24.0             |
| Service Catalog + Authoring                                                   | Catalog is domain data (not a 2nd KB); soft-delete + duplicate-name guard; `durationMinutes` is INTERNAL                                                                                                                                                                                                                                                                                                                                                                                                                                      | v0.25.0 / #53       |
| Appointment Creation UX                                                       | `?customerId=`/`?serviceId=` smart context, relative dates, «أقرب وقت متاح», relative follow-up                                                                                                                                                                                                                                                                                                                                                                                                                                               | v0.26.0 / #54       |
| Booking UX + customer prefill                                                 | Date-step coherence; customer-create prefill from the typed query                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | v0.27.0             |
| Reschedule UX                                                                 | Availability-guided reschedule with self-exclusion (`excludeAppointmentId`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | v0.28.0             |
| Appointments/Availability coherence                                           | Day-view state reset per selected day; day-capacity chips (مغلق/ممتلئ/غير متاح); date-format consolidation                                                                                                                                                                                                                                                                                                                                                                                                                                    | v0.29.0 / #55       |
| Slot presentation                                                             | Known candidate grid; non-returned candidates visible-but-disabled «غير متاح»; no reason inference                                                                                                                                                                                                                                                                                                                                                                                                                                            | v0.29.1 / #56       |
| Assistant readiness + settings + low-friction setup                           | `check:ai-readiness` (OPS-21) + the approved «اجعل مساعدك جاهزًا» UX (UX-01): bounded assistant settings at `/settings/assistant` (name/language/tone/detail/emoji; read-only handoff rules), per-business persisted style over the resident default, 4-state readiness (`isAssistantReady`; description optional, prices/FAQs non-gating), and the knowledge-gap review loop routing to authoritative editors. Preview deferred (no safe seam). Migration `20261004120000_business_assistant_style` **NOT applied**; NOT committed/deployed. | UX-01 / #91         |

## Key Known Limitations (current)

- Availability is a READ layer: no slot reservation; the write-time SERIALIZABLE
  conflict check is the authority. Residual: a rare false-positive
  serialization abort under contention surfaces as `SLOT_CONFLICT` — a manual
  retry succeeds.
- Unassigned appointments block the whole business day
  (staff-assignment-aware availability is a later decision).
- The AI assistant's deterministic path avoids LLM calls when safely possible;
  Arabic greetings are now covered by it (DECISIONS #61); phrasings outside the
  keyword/FAQ vocabulary still land on NEED_HUMAN.
- The Branch/ProviderProfile/usage foundations have partial management UI only
  (`/settings/whatsapp` covers WhatsAppConnection); usage telemetry is recorded
  but not surfaced; `estimatedCostMicros` is never computed by the codebase.
- No per-entry id / active state / timestamps for `Business.faqs` JSON rows
  (DECISIONS #13 shape); guards are workflow-level.
- Customer creation collects no email; edit/deletion not exposed in the UI.
  Directory reads cap at 20 customers/page (pilot scale).
- Appointments accept past dates at the domain level (`min=today` is a UX guard
  only). Knowledge/FAQ cap is 50 entries.
- The `20260913150000_account_issuer` migration was hand-authored (no shadow
  DB on the build device); verified by deploy + schema diff + live sign-in.
- Termux device: builds use `--webpack`; the Prisma schema engine cannot run
  on-device (migrate from desktop/CI).

## Architecture Hardening (P0 — IMPLEMENTED)

Accepted as DECISIONS #30–#36 (PROMPT-ARCH-01) and implemented in
PROMPT-ARCH-02 (DECISIONS #38): Branch model (`Business.defaultBranchId`
pointer; required `branchId` server-resolved to the Default Branch),
WhatsAppConnection (businessId required / branchId optional),
ProviderProfile/ProviderService/ProviderBranch relations, platform-operator
marker, SERIALIZABLE booking concurrency with bounded retry, durable
`inbound_message_dedupe` idempotency, structured `ai-contract.ts`, append-only
`usage_records`. Details: `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`.

## Migration State

Chain is **complete and clean**, rooted at `0_init` + `migration_lock.toml`
(provider postgresql). **18 migrations**, ending at
`20261002140000_knowledge_gap` (Slice 9). The last three —
`20261002120000_service_price` (Slice 6), `20261002130000_operator_attention_cause`
(Slice 7), `20261002140000_knowledge_gap` (Slice 9) — are all CREATE-only /
additive, zero ALTERs on existing tables, and **ARE APPLIED to the production
Neon DB (LIVE-VERIFIED 2026-10-03 by `PROMPT-AI-OPS-19`: `prisma migrate
status` → "Database schema is up to date!" all 18; `prisma migrate diff
--from-config-datasource --to-schema` → "No difference detected", zero
drift)**, correcting earlier ledger notes that listed them as pending.
**APPLIED to the production Neon DB as of 2026-09-27
(live-verified by DECISIONS #69):** `prisma migrate status` → "Database
schema is up to date!" (all 15 then), and a direct production-DB read confirms
both `telegram_connections` + `telegram_provisioning_ledgers` exist with the
`outcome_code` column. A genuinely EMPTY database bootstraps
fully via `pnpm db:deploy` (verified 8/8 at repair time; deploy count grows
with each additive migration — re-run to reconcile). The old Demo/Neon DB
needed a one-time HUMAN-ONLY baseline reconciliation
(`prisma migrate resolve --applied 0_init` → `pnpm db:deploy`). Schema diff
against `schema.prisma` is empty. Full list: `docs/DATABASE.md`.

**UNAPPLIED (created, pending operator release):**
`20261004120000_business_assistant_style` (DECISIONS #91) and
`20261004130000_ai_policy_openrouter_provider_only` (DECISIONS #92 — ONE
additive nullable `platform_ai_policies.open_router_provider_only`, no
backfill, no destructive op, no NOT NULL constraint). Both are additive and
safe to apply together with `pnpm db:deploy`; the production chain is
otherwise unchanged.

## Ops State

- **Production:** `https://flowpilot-prod.vercel.app` — Neon production DB
  (`ep-tiny-grass-a5e63jev-pooler` pooler), dedicated Vercel project
  `flowpilot-prod`, repository PRIVATE. **Last live-verified checkpoint:
  v0.39.0** (2026-10-03, DECISIONS #85 / `PROMPT-AI-OPS-19` — `GET
/api/health` → `status:"ok"`, `version:"0.39.0"`,
  `deploymentReady:true`, `database:"connected"`, `missingEnvVars:[]`;
  `prisma migrate status` → all 18 applied; `prisma migrate diff` → zero
  drift; production DB read-only inventory confirms a real pilot is
  running — see DECISIONS #85 and `Current State`). Production is
  therefore AT the released head and the Slice-6/7/9 behavior IS live.
  (Earlier checkpoint v0.31.2, 2026-09-27, DECISIONS #69: production env
  PRESENCE verified without reading any value:
  `TELEGRAM_MANAGER_BOT_TOKEN` ✓, `TELEGRAM_MANAGER_BOT_USERNAME` ✓
  (now present), `CREDENTIAL_MASTER_KEY` ✓, `NEXT_PUBLIC_APP_URL` ✓;
  the #68 routing fix IS live — both Telegram webhooks return 401
  fail-closed with no 307; the whole launch + binding chain ran for
  real and the manager webhook is installed on the Manager Bot at the
  production URL. The #69/#71/#72/#73/#74 Telegram delivery fixes are
  now live through v0.39.0, and a managed bot DID reach CONNECTED +
  `onboarding_state:READY` in production — `Drafnanafnanbot` — so the
  earlier "no connection has ever reached CONNECTED" statement is
  superseded by live evidence.)
  Live inbound E2E was proven at the earlier v0.15.9 checkpoint (signed
  webhook → 200, dedupe replay, tenant isolation).
- **Demo:** `https://flowpilot-demo-gamma.vercel.app` — isolated Demo Neon DB,
  dedicated project, `DEMO_MODE=true`, seeded deterministic/idempotent (1
  business, 1 Default Branch, 2 team users, 6 services, 36 customers, 22
  conversations, 73 messages, 37 appointments). Demo credentials exist ONLY in
  the Demo DB. The suggested `flowpilot-demo.vercel.app` domain is owned by an
  unrelated third party — the live domain is the `-gamma` one.
- **Release model:** `pnpm release` (full gated path) or the lightweight
  `pnpm ship patch|minor` (DECISIONS #26) — never both. Both are
  **operator-only** actions; agents never commit/tag/push/ship.
- **Bootstrap tools (one-time, operator):** `pnpm bootstrap:admin`,
  `pnpm bootstrap:operator`.

## Unresolved User Actions (not code)

1. **Operator — the ONE remaining Telegram live-E2E unblock (DECISIONS
   #69).** SUPERSEDED-ISH by the 2026-10-03 live read (DECISIONS #85):
   production is at v0.39.0 (all #69/#71/#72/#73/#74 fixes ARE live) and a
   managed bot DID reach CONNECTED + `onboarding_state:READY`
   (`Drafnanafnanbot`), so the earlier "the creation keyboard can never
   appear" statement no longer holds. The residual operator item is a
   confirmation, not an unblock: re-run `docs/TELEGRAM.md → The ONE live
E2E` from a FRESH launch and record whether the whole
   launch → `/start` → managed-bot creation → CONNECTED → first customer
   message chain completes on the CURRENT deployed build, and file a
   `DECISIONS.md` entry if a further defect surfaces.
2. **Operator — PILOT EVIDENCE COLLECTION is now the critical path
   (DECISIONS #85 / `PROMPT-AI-OPS-19`).** No engineering change is required
   to run the pilots. The operator-owned items, in order:
   (a) **re-verify the live AI provider** — the platform policy is
   `codecraft` / `deepseek-v4-flash-0731` with fallback DISABLED, and the
   last 4 live `AI_TURN` rows (2026-09-26..28) were all FAILURE with no AI
   traffic since; send ONE real inbound message on an AI_ACTIVE thread (or
   run `pnpm probe:codecraft`) and confirm a SUCCESS + a customer-visible
   reply (the #60 AI-failure acknowledgment is live, so a failure is no
   longer silent — but a failing provider would still mean no AI pilot);
   (b) **finish onboarding pilot #2** (`صالون سارة التجميلي`, beauty) — its
   WhatsApp connection is stuck `AUTHORIZING`/`PENDING` and it has NO
   provider rows, so it needs either the manual provisioning path the
   dental pilot used (ENV credential row + `provider_profiles`/
   `provider_services` inserts) or the two candidate slices in §G;
   (c) **start logging the strategy's named evidence by hand**
   (`CLIENT_DEMO.md`: "for now: who, which vertical, objections, price
   reaction") — baseline metrics at onboarding (bookings, response time,
   no-show rate), then weekly; the pilot registry is Spec B, NOT now.
3. **Operator:** review + release the uncommitted **#61** shared conversation-layer UX
   slice (GREETING intent + verified handoff/resume — the only functional
   changes are the deterministic greeting branch in `conversation-ai.ts`, the
   closed `KNOWLEDGE_FREE_REPLY_INTENTS` list in the disclosure gate, one enum
   value, and the re-generated prompt artifact), then release it as the next
   patch (`pnpm release`/`pnpm ship`) and deploy (see below). The #60
   AI-failure acknowledgment fix already shipped as v0.29.4.
4. **Operator (only if RUNTIME credentials are used):** generate and set
   `CREDENTIAL_MASTER_KEY` in the deployment env. Until set, the RUNTIME
   credential path stays honestly UNAVAILABLE and the ENV pilot path is
   unaffected. (Live evidence, post-v0.29.1: against the local dev DB the
   RUNTIME store round-trips exactly with `CREDENTIAL_MASTER_KEY` set —
   store/resolve/delete all succeed. A real Meta round-trip still has
   never run — see `docs/INTEGRATION_CHECKPOINTS.md`.)
5. **Operator (optional):** add `OPENROUTER_API_KEY` / `AGENTROUTER_API_KEY` /
   `ATRIA_API_KEY` to Vercel env; `pnpm db:deploy` against the Demo DB.
6. **Operator (optional):** exercise one real outbound to an operator-owned
   WhatsApp number inside the 24h window to observe a `200` delivery.

## Next Step

**AWAITING CI & OPERATOR REVIEW — PR (feat/conv-core-03d2-semantic-safety) CORE-03D2**:
Branch `feat/conv-core-03d2-semantic-safety` ready with Semantic Safety Ownership and False-Handoff Repair (v0.67.0).

1. Push branch `feat/conv-core-03d2-semantic-safety` to `origin`.
2. Open PR against `main` for review.
3. Monitor GitHub Actions CI on PR HEAD (`pr-validation.yml`).
4. Human architectural review by reviewer / Ammar (no auto-merge, no local DB migrations, version 0.67.0).
5. **Next Product Implementation Slice: Welcome and Contextual Buttons UX (UX001)**:
   - Proactive /start welcome using real business identity.
   - Initial booking and service-inquiry entry choices.
   - Contextual inline choices for genuinely missing information.
   - Valid enabled default service skips redundant service selection.
   - Free text remains supported throughout; buttons carry validated IDs (never display labels).
   - Single state, planner, and Booking Core.
   - Stale/replaced/consumed choices cannot execute.
   - Greeting or /start does not reset active booking state.
   - Staff ownership remains authoritative.
   - Zero-model deterministic /start protocol, with natural greetings using semantic path without keyword dictionaries.

**JUST COMPLETED (uncommitted; awaiting operator review): `PROMPT-AI-OPS-28` /
DECISIONS #92 — OpenRouter provider pin (Superadmin-only, OpenRouter-only).**
The smallest possible cost-routing control: the operator can OPTIONALLY pin
OpenRouter inference to ONE provider endpoint (e.g. `decart/fp4`). ONE
additive nullable column `platform_ai_policies.open_router_provider_only`
(migration `20261004130000_ai_policy_openrouter_provider_only`, created but
**NOT applied**); the OpenRouter pin is built at the ONE place OpenRouter
routing semantics may live — the OpenRouter adapter request boundary
(`provider: { only: [pin], allow_fallbacks: false }`); empty pin ⇒ NO
`provider` key in the body at all (byte-for-byte the prior behavior); the
model id is never rewritten; Atria/AgentRouter/CodeCraft are constructed
without the pin so a present pin never reaches their requests. Verified:
`check:ai-provider` 75→87/87 (NEW 16a–16j), `check:policy` 13→23/23 (NEW
28a–28j), NEW `pnpm probe:openrouter` bounded live path (routing-only output,
no customer channel), `pnpm verify` + `pnpm security` PASS. **Operator
actions to ship:** review the diff, apply the migration (`pnpm db:deploy`),
then release (recommended MINOR — a new persisted user-facing Superadmin
capability). Optionally `OPENROUTER_MODEL=… OPENROUTER_PROVIDER_PIN=decart/fp4
pnpm probe:openrouter` for the live routing proof.

**AWAITING OPERATOR ACTION — `PROMPT-AI-OPS-27` Atria provider-latency
forensics COMPLETE; NO code change justified (read-only pass).** Production is
v0.41.1 and healthy; the failing boundary is the Atria provider response not
arriving within the adapter's `ATRIA_TIMEOUT_MS = 16000` bound on the full
engine-shaped request (zero-token TIMEOUT, retried once, then fail-safe
handoff). The provider itself is reachable and authenticated (`probe:atria`
6/6 SUCCESS, avg 8.7 s). **The operator's actions are all configuration,
zero engineering:** (1) **raise the Atria timeout** (Vercel env /
`ATRIA_TIMEOUT_MS`) toward ~30–40 s to clear the latency tail, and/or (2)
**enable fallback + configure a secondary provider** so a timed-out Atria
attempt falls through instead of handing off (an EXISTING, untouched
capability); (3) **redeploy** (env changes need a redeploy for the adapter
constant) and (4) **send ONE live turn** on the AI_ACTIVE pilot thread to
confirm. If failures persist AFTER both, re-open with the turn-evidence
record. Do NOT raise the bound as a code change — DECISIONS #90 §I already
classified it as an operator-owned latency trade-off.

**IN-FLIGHT (uncommitted, awaiting operator review): `PROMPT-AI-UX-01` /
DECISIONS #91 — the Business-facing assistant UX** («اجعل مساعدك جاهزًا»):
`/settings/assistant` bounded settings + per-business persisted style, the
refined 4-state readiness with a deterministic `isAssistantReady`, and the
knowledge-gap review loop. ONE additive nullable migration
(`20261004120000_business_assistant_style`) is created but **NOT applied**;
preview was deferred (no safe business-facing seam). Verified offline
(`check:assistant-settings` 38/38, `check:ai-readiness` 29/29, 30 adjacent
suites, `pnpm verify`, `pnpm security`) + a bounded real-LLM A/B. **The
operator must review the diff and decide the release** (recommended PATCH);
then apply the migration with `pnpm db:deploy` before the new style UI can
persist. No live/browser verification was performed.

**LIVE PILOT VERIFIED WITH ATRIA — engineering is NOT the critical path
(`PROMPT-AI-OPS-24`, DECISIONS #90); the next phase is evidence collection.**
The existing product is PROVEN to work end-to-end as a real pilot with Atria
as the sole live AI path (17/17 real-LLM classes + the two live DISCLOSED
turns), the false-handoff defect class is RESOLVED by the provider switch, and
NO code change is justified by the change gate (every candidate is either a
proven B-class repeatability gap that is NOT necessary for the CURRENT pilot's
execution, or a provider-latency tuning trade-off the operator owns). **The
operator's next actions are non-code:** (1) **keep the policy on
`atria`/`Atria-Dawn-Preview`** (already live and answering correctly); (2)
**collect the strategy's named evidence by hand from the running pilot** —
baseline bookings (10 today, 9 CONFIRMED), response time (Atria avg ~11 s,
measurable), handoff causes (3 attentions, all resolved), service/price
question volume, unresolved knowledge gaps (0 rows today), then weekly; (3)
**optionally enable fallback + a secondary** to cut the ~12 % provider-latency
timeout tail that currently converts an ordinary question into a handoff (an
EXISTING capability — no engineering needed); (4) **finish onboarding pilot
#2** (`صالون سارة التجميلي`, beauty — still `AUTHORIZING`/no provider, blocked
by the two B-class surfaces below). **The smallest justified ENGINEERING
changes — only if the operator approves, and ONLY because they break the Spec A
exit criterion "a real business can be onboarded in < 1 day using the app
alone" — remain exactly two B-class onboarding-repeatability surfaces**
(neither was built; both reuse existing seams and need no schema change):
(1) a **provider authoring surface** (`providerRepository.createProfile`/
`linkRelation` have ZERO app callers today, so every booking turn on an
un-provisioned business deterministically returns `NO_ELIGIBLE_PROVIDERS` →
NEED_HUMAN and the AI can never book); (2) a **UI/server-action for the
ENV-credential WhatsApp connection** (`saveConnection` already implements the
documented `.env.example` grammar the live pilot uses but is called only from
offline harness scripts). Both are DOCUMENTED candidate slices, NOT started —
the change gate defers them (they are desirable for scaling to pilot #2 but
not necessary for the current pilot's execution), and each needs its own
approved prompt + DECISIONS entry. Everything in class C (knowledge-gap review
UI, out-of-band staff notifications, working-hours editing in settings,
attention-reason persistence past first load, inbox attention-first sorting)
and class D (pilot registry / Spec B evidence layer, Founder Console, vertical
scoring, WTP engine, knowledge-gap promotion, RAG, billing, JEV activation)
stays explicitly DEFERRED until pilot evidence justifies it.

**AI — the target-architecture migration queue (`docs/ai/TARGET_ARCHITECTURE.md
§17`) is now COMPLETE through Slice 9, and Slice 10 (the evaluation-target
slice) is built and has just been extended by `PROMPT-AI-EVAL-16`
(`check:future-system` 36/36 + the NEW `eval:run-future-arch18` real-LLM
runner).** Every production slice (0–9) is BUILT + green, and Slice 9 is now
verified BOTH deterministically and under a real LLM. There is therefore NO
further production slice queued — and, per `PROMPT-AI-OPS-19` above, the
release + apply steps it used to recommend are ALREADY DONE. The next
engineering work is evidence-gated onboarding repeatability, not more
architecture: (a) gather the first real pilot gap evidence (the
`knowledge_gaps` rows are the discovery signal the strategy depends on —
0 rows today because no live turn has crossed the recorder since v0.39.0
went live) before deciding whether the review lifecycle needs an operator
surface and whether promotion is worth building; (b) then, only with
evidence, the two B-class onboarding surfaces above. The evaluation
deliberately did NOT build a UI or a promotion path — that remains a
future, explicitly human-approved workflow once pilot evidence exists.

**AI — Slice 9 (`PROMPT-AI-ARCH-18`, Async knowledge-gap / self-improvement —
record-only, off the critical path) is BUILT + DETERMINISTIC + REAL-LLM
VERIFIED (READY_FOR_NEXT_STAGE — see `Current State`).** The next logical
prompt in the approved target-
architecture migration queue (`docs/ai/TARGET_ARCHITECTURE.md §17`) is **Slice
8 — the optional JEV decision strategy behind the EXISTING provider gateway**
(`PROMPT-AI-ARCH-17`): add a strategy plug that may terminate without an LLM or
act as the single generative call, preserving the zero-or-one generative
round-trip invariant, provider neutrality, and the `AI interprets → Domain/
Resolver decides → Engine orchestrates` authority chain — NOT RAG/vector
search, NOT a mandatory extra inference stage, NOT a classifier→responder→judge
chain (all remain deferred evidence work). The Slice-7 migration
(`20261002130000_operator_attention_cause`) and the resolver safety-precedence
correction have NOT been applied/released by this slice; the operator owns the
release. Keep `pnpm check:handoff-cause`, `check:operator-attention`, and the
adjacent gates as the regression floor.

**AI — Slice 6 (`PROMPT-AI-ARCH-13`, Service pricing foundation + task-gated
price exposure + missing-price handoff) is BUILT + real-LLM VERIFIED
(READY_FOR_PRICE_REAL_LLM_REVERIFY — see `Current State`).** The migration
(`20261002120000_service_price`) has NOT been applied to any database by that
slice; the operator owns the release. Keep `pnpm check:service-price` + the
adjacent gates as the regression floor.

0. **AI — the evaluation data foundation is DESIGNED (DECISIONS #76); two
   evidence-ranked paths are now open and neither is implemented (hard stop).**
   (a) The schema-level gaps the coverage matrix surfaced are the authoring
   targets for `egyptian-v2`: **43 unpopulated vocabulary members** (the whole
   `customer-behavior` dimension at 0/18, `booking-state` at 1/15, `safety` at
   1/4, `knowledge` at 10/17) and **7 empty curated cells** (the clitic
   human-request cell, the price knowledge-gap cell, the
   clarification-instead-of-escalation cell, the change-date-mid-journey cell,
   the sensitive-medical cell, the prompt-injection-refusal cell, and the
   long-context topic-return cell). `recommendAuthoringTargets()` in
   `evaluation/schema/coverage-matrix.ts` returns the ordered plan; a generator
   must follow the ten binding rules in `docs/ai/EVALUATION_DESIGN.md §14`.
   (b) The recorded baseline findings remain evidence only. The single
   highest-severity defect is **F1** — Egyptian clitic attachment (`بموظف`
   never matches the `موظف` keyword) + greeting-before-human ordering lets
   "أهلاً، وصلني بموظف لو سمحت" classify as GREETING/reply with NO handoff
   (all 5 baseline MISSED handoffs; traceable case ids in
   `evaluation/reports/egyptian-v1/FINDINGS.md`). Any future AI work (JEV,
   CLARIFY, conversation state, knowledge retrieval) must keep `pnpm
check:eval` + `pnpm check:eval-schema` green as its regression floor and
   re-run `pnpm eval:baseline` to prove movement.
   (c) **The target architecture is DESIGNED (DECISIONS #78,
   `docs/ai/TARGET_ARCHITECTURE.md`) and its Slice 0 is now IMPLEMENTED
   (DECISIONS #79, `PROMPT-AI-ARCH-02`).** The migration queue in §17 is the
   approved work order; Slice 0 (additive contract fields + single-goal
   bridge + turn observability) is BUILT and green. **The next implementation
   slice is Slice 1 — the F1 clitic/branch-order safety fix** (remove the 5
   genuine missed handoffs: `stripAffixes` cannot see `بموظف`, and
   `isPureGreeting` runs before the human branch), followed by the later
   slices. Each slice is independently testable and revertible; none may start
   without the Design §22 tests and the existing check suites staying green.
   (d) **Evaluation-path capability slice IMPLEMENTED (`PROMPT-AI-EVAL-09`,
   evaluation-only — no production change).** EVAL-08 could prove
   SUPPLIED_FACT_RESUME and INTERRUPTION_RECOVERY only deterministically: the
   FUTURE_SYSTEM bridge reconstructed a pending clarification/task ONLY from the
   engine's own authored templates, which a real-LLM setup turn is not
   guaranteed to produce, so those paths never fired under a real LLM. Closed by
   adding an ENGINE-AUTHORED pending-state SEED
   (`evaluation/runner/pending-state-seed.ts` + `runner.seedPendingState`): it
   replays deterministic setup turns through the REAL Conversation Engine (ZERO
   real inference) so the engine authors its own clarification/offer into the
   per-case history, then the real-LLM turn resumes through the SAME production
   seams (`derivePendingClarification` + `deriveConversationStateFromHistory` +
   the ONE `mergeConversationState`) — no second state/resolver/plan.
   `clarify-measure` now reports RESUME_FAILED (re-asking a supplied fact),
   PENDING_TASK_LOST, and INTERRUPTION_RECOVERY_FAILED; safety-required handoff
   is still never a CLARIFY success. Proven: `pnpm check:future-system` 33/33
   (F23–F33 new) + a bounded real-Atria calibration
   (`pnpm eval:run-future-fixtures`, 3 real calls, 0 provider failures,
   zero-or-one held) where resume + interruption + return fired under the real
   LLM (`evaluation/reports/egyptian-v1/future-system-resume-interruption/`).
   Status: **READY_FOR_REAL_LLM_REVERIFY** (NOT Slice 5).
1. **Operator — finish the ONE Telegram live E2E (DECISIONS #69/#70).** The
   code is now correct after the second live-found fix (#69) AND the two
   code-proven `getManagedBotToken` wire-shape fixes (#70 — G-1 `user_id`,
   G-2 bare-string token); exactly two operator actions stand between BUILT
   and LIVE-VERIFIED, listed in
   `Unresolved User Actions` (1): **deploy the current head** so the
   `request_id` fix AND the `getManagedBotToken` wire fixes are live (the
   routing fix, the migrations, and
   `TELEGRAM_MANAGER_BOT_USERNAME` are already done — live-verified), then
   **re-run `docs/TELEGRAM.md → The ONE live E2E` from a fresh launch**.
   Then record the outcome here + a new `DECISIONS.md` entry if a further
   defect surfaces. **Do not report a simulated success** — the offline
   harnesses prove code paths only, and two consecutive real attempts have
   now each surfaced a distinct blocking defect that every offline guard
   was green for. **Also (DECISIONS #72), on the affected Android device:
   launch from `/settings/telegram`, tap «فتح في Telegram» in the new app
   chooser, and confirm it opens STANDARD Telegram (`org.telegram.messenger`)
   and completes the flow — the client fix is code-proven + guarded
   (`check:telegram-onboarding` 32/32) but NOT live-verified.**
2. **Telegram second channel — the foundation, transport sibling, manager-bot
   provisioning state machine, AND the customer onboarding surface are all
   BUILT and VERIFIED offline** (DECISIONS #63 discovery → #64 foundation →
   #65 adapter/webhook → #66 manager-bot provisioning → #67 customer
   onboarding surface → #68 first live E2E pass): the ONE core change is DONE —
   the inbound identity seam is widened from `phoneSchema` to a
   provider-neutral `externalHandleSchema` (E.164 is a strict subset, so
   WhatsApp is unchanged — proven by the re-run WhatsApp guards). Two NEW
   additive tables with repository-only access (migrations
   `20260926120000_telegram_connection` + `20260927120000_telegram_provisioning_outcome`
   — zero ALTERs on existing tables), and `TELEGRAM_MANAGER_BOT_TOKEN` is an
   env secret. The thin adapter under `src/server/integrations/telegram/`
   (HTTP client, Update parser, outbound `MessageTransport`, `getMe`
   `ConnectionVerifier`, webhook handler) + `POST /api/telegram/webhook` are
   BUILT; the manager-bot provisioning path
   (`POST /api/telegram/manager/webhook`: `/start` creator binding +
   keyboard, `managed_bot` → `fp:<id>` → `setWebhook` → `getMe` →
   CONNECTED, with typed failure outcomes) is BUILT and covered by
   `pnpm check:telegram` **99/99** (NEW section P — the live-found proxy
   reachability guard); the `/settings/telegram` customer
   surface is BUILT + behaviorally wired + covered by
   `pnpm check:telegram-onboarding` **22/22** (the customer journey through
   the REAL service + REAL manager handler; DECISIONS #67); `pnpm check:signup`
   **18/18** now guards the public-path policy for provider webhooks.
   `pnpm verify` + `pnpm security` green. **LIVE status (DECISIONS #68):**
   the real Manager Bot is LIVE-VERIFIED (`@FlowPilotManagerBot`,
   `can_manage_bots: true`); the webhook-route 307 defect is LIVE-PROVED +
   FIXED + GUARDED + proven locally (401, no auth regression) but
   **NOT deployed**; the migrations are **NOT applied**;
   `TELEGRAM_MANAGER_BOT_USERNAME` is **ABSENT** in production; the human
   Telegram confirmation steps are **NOT performed**. So: provisioning,
   setWebhook-for-a-managed-bot, getMe-for-a-managed-bot, CONNECTED, and the
   customer round-trip are all **NOT LIVE-VERIFIED**. **Remaining for
   Telegram:** the four operator actions above, then
   owner-change/`ManagedBotUpdated` handling + token rotation (DEFERRED,
   structurally ready — `managerBotId`/`creatorTelegramUserId` provenance
   already persisted; needs its own slice, not invented here), and the open
   decision #63 (F)(1) — non-text inbound routing
   (drop vs persist-and-defer) is still open; the MVP private-chats-only
   scope is implemented at both parsers (non-private/non-text are
   acknowledged 200 and not processed).
3. **Fresh live WhatsApp E2E** (operator, REQUIRED): send one real inbound
   message on an AI_ACTIVE thread with the policy still on `codecraft` /
   `deepseek-v4-flash-0731` and confirm the customer receives a reply even if
   the provider fails. The live probe proved the CodeCraft path healthy
   (3/3, `DIRECT_PARSE`, max 7.9s), so the prior `AI_TURN` FAILURE is
   non-deterministic — but any failure must no longer produce silence.
4. **Onboard the first REAL pilot Business end-to-end** — operator provisions
   the Business + invitation → ADMIN connects the WhatsApp number via Meta
   Embedded Signup at `/settings/whatsapp` → CONNECTED → live messaging →
   gather baseline/ROI evidence per `PRODUCT_STRATEGY.md`.
5. **Only after pilot evidence justifies it:** Spec B instrumentation /
   economics (usage → cost → price → entitlement; `ECONOMICS.md`). Not before
   pilot evidence exists.

After each prompt: update this file (minimally) and append to `DECISIONS.md`
when a decision was made.
