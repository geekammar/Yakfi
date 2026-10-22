# FlowPilot — CORE-03C2 Live Smoke Evaluation Evidence Bundle

> **Authoritative Evidence Record** for CORE-03C2 (Real JEV + LLM Live Smoke Evaluation).  
> Conducted under explicit authorized envelope limits with in-memory state and booking isolation.

---

## 1. Run Metadata & Configuration

- **Date / Timestamp:** `2026-10-22T10:57:19.467Z` – `2026-10-22T10:58:12.756Z` (Duration: 53.289s)
- **Evaluated Code Revision:** Commit `58a811f8b6540c4974251cb181827464a974b216` on branch `feat/conv-core-03c2-smoke-eval`
- **Execution Command:**
  ```bash
  pnpm convo:playground --mode current_engine --live --allow-paid \
    --max-requests 24 --max-tokens 600 --timeout 15000 --budget 0.10 \
    --budget-basis "24 calls * 5k in @ $0.2574/M + 600 out @ $1.0287/M = $0.0457 USD <= $0.10" \
    --scenarios smoke
  ```
- **Target Architecture:** `CURRENT_ENGINE` (`receiveInboundMessage` → structured capability routing `requiredSemanticCapability: "structured_turn"` → `createPolicyBackedAi` → `resolveFinishedTurn` planner → Booking Core → isolated in-memory doubles)
- **Reference Instant & Timezone:** `2026-10-20T10:00:00.000+03:00` / `2026-10-20T07:00:00.000Z` (`Africa/Cairo`, `todayRef: "2026-10-20"`)
- **Isolation Guarantees:** 100% in-memory state store (`InMemoryConversationStateStore` with CAS revisions), in-memory appointments, 0 outbound WhatsApp/Telegram network calls, 0 production DB mutations.

---

## 2. Resource Accounting: Limits vs Observed Usage

| Dimension                    | Authorized Envelope Limit                     | Measured Live Campaign Usage      | Status / Enforcement                                    |
| :--------------------------- | :-------------------------------------------- | :-------------------------------- | :------------------------------------------------------ |
| **Physical HTTP Attempts**   | Max 24 physical provider calls total          | **12 attempts** (1 JEV + 11 LLM)  | ✅ Enforced via `CurrentEngineExecutionSession`         |
| **Output Token Limit**       | Max 600 tokens per generative completion      | Max **204 tokens** observed       | ✅ Enforced on adapter wire payload (`max_tokens: 600`) |
| **Per-Attempt Timeout**      | 15,000 ms                                     | Max **5,887 ms** latency observed | ✅ Enforced via `AbortSignal` reaching `fetchImpl`      |
| **Monetary Planning Budget** | Max $0.10 USD                                 | **$0.008117 USD** total           | ✅ Planning bound strictly respected                    |
| **Evaluation Campaign**      | Exactly 1 run across corpus (no tuning loops) | **1 run** across 8 scenarios      | ✅ Single execution completed                           |

### Cost Source & Limitations

- **Track A (JEV Decisions API):** Cost is **provider-reported** directly in API response usage payload (`cost: 0.0000126` -> **$0.0000126 USD**).
- **Track B (LLM Chat Completions):** Cost is **calculated from published rates** using official OpenRouter DeepSeek V3 pricing audited on 2026-10-22 ($0.2574/M prompt, $1.0287/M completion):
  - Total prompt tokens: 24,321 tokens × $0.2574 / 1,000,000 = $0.0062602 USD
  - Total completion tokens: 1,792 tokens × $1.0287 / 1,000,000 = $0.0018434 USD
  - Track B total: **$0.0081036 USD**
- **Combined Campaign Total:** $0.0000126 + $0.0081036 = **$0.0081162 USD** (~$0.008117 USD).
- **Enforcement Limitation:** Monetary estimates are planning bounds, **not guaranteed provider-side dollar limits**; OpenRouter does not support real-time dollar caps via API.

---

## 3. Track A — Real JEV Decisions API Evaluation

- **Provider Endpoint:** `POST https://openrouter.ai/api/alpha/decisions`
- **Observed Model:** `typesafe/jev-1.13-20260917` by `TypeSafe`
- **Customer Prompt:** `"عايز أحجز كشف أسنان بكرة"`
- **Predeclared Positive Threshold:** `>= 0.70` (0.70 represents clear positive booking intent confidence on a [0, 1] probability scale for a positive booking intent prompt).
- **Response Evidence:**
  - Status: `200 OK`, latency: `230ms` (provider reported: `215ms`)
  - Evaluated question: `bookingRequested: { type: "noul", noul: 0.97 }`
  - Transport success: `true`
  - Semantic success: `true` (observed probability `0.97 >= 0.70`)
  - Track A verdict: **PASS**
- **Contract Boundary & Tested Integration Findings:**
  - The JEV Decisions API contract evaluates independent, atomic questions (`noul` probabilities, `choice` categories).
  - Structured entity extraction, composite parameter binding, and structured fact updates (SET/REMOVE) are **UNSUPPORTED** by Decisions API contract design.
  - _Integration Note:_ These findings describe our tested integration contract (`POST /api/alpha/decisions`), not universal model incapability. Furthermore, one single positive sample is a contract connectivity smoke test, not a statistical intent-accuracy benchmark.

---

## 4. Track B — Real LLM through Current Engine (`deepseek/deepseek-chat` via OpenRouter)

### Summary Table

| Case       | Scenario ID | Description                                         |    Turns    | Total Tokens (In / Out) |   Attempts    |         Verdict         | Failure Layer Attribution & Nuance        |
| :--------- | :---------- | :-------------------------------------------------- | :---------: | :---------------------: | :-----------: | :---------------------: | :---------------------------------------- |
| **Case A** | `SMOKE-A`   | Direct booking with explicit service & date         |      1      |   2,146 / 199 (2,345)   |       1       |        **PASS**         | Orchestration & Core                      |
| **Case B** | `SMOKE-B`   | Relative date "عايز أحجز بكرة" under Cairo timezone |      1      |   2,134 / 178 (2,312)   |       1       |        **PASS**         | Semantic Model & Domain                   |
| **Case C** | `SMOKE-C`   | Date correction ("لا خليها الخميس")                 |      2      |   4,539 / 380 (4,919)   |       2       |        **PASS**         | State & Reconciliation                    |
| **Case D** | `SMOKE-D`   | Provider preference removal ("خلاص أي دكتور متاح")  | 1 (stopped) |   2,143 / 156 (2,299)   |       1       |    **FAIL (Turn 1)**    | Entity Resolution / Domain Validation     |
| **Case E** | `SMOKE-E`   | Time preference removal ("أي وقت مناسب")            | 1 (stopped) |   2,141 / 143 (2,284)   |       1       |    **FAIL (Turn 1)**    | Scenario Assertion (Canonical Time Value) |
| **Case F** | `SMOKE-F`   | FAQ interruption during booking                     |      2      |   4,537 / 301 (4,838)   |       2       |        **PASS**         | State Preservation                        |
| **Case G** | `SMOKE-G`   | Known application defect ("مش مشكلة")               |      2      |   4,545 / 306 (4,851)   |       2       | **PASS (Reproduction)** | Legacy Safety Detector                    |
| **Case H** | `SMOKE-H`   | Mechanical confirmation ("1")                       |      2      |   2,136 / 129 (2,265)   | 1 (Turn 2: 0) |        **PASS**         | Booking Core Protocol                     |

---

## 5. Detailed Case-by-Case Trace Evidence & Honest Nuances

### Case A: Direct Booking (`SMOKE-A`)

- **Turn 1 Input:** `"عايز كشف أسنان يوم الأربعاء 2026-10-21"`
- **Observed Model Output:** Intent `BOOKING`, extracted `service: "كشف أسنان"`, `date: "2026-10-21"`.
- **Domain Action:** Availability queried for `2026-10-21`; active 3-slot offer generated; AI reply dispatched.
- **Verdict:** **PASS**. 1 attempt, 5,887ms duration, 2,345 tokens.

### Case B: Relative Date (`SMOKE-B`)

- **Turn 1 Input:** `"عايز أحجز بكرة"`
- **Observed Model Output:** Derived `date: "2026-10-21"` from reference instant (`2026-10-20` Cairo time).
- **Domain Action:** Availability queried for `2026-10-21`; active slot offer generated.
- **Verdict:** **PASS**. 1 attempt, 5,039ms duration, 2,312 tokens.

### Case C: Date Correction (`SMOKE-C`)

- **Turn 1 Input:** `"عايز كشف أسنان يوم الأربعاء"` → Date `2026-10-21` stored, slot offer presented.
- **Turn 2 Input:** `"لا خليها الخميس"`
- **Observed Model Output:** Date fact updated to `2026-10-22`.
- **Domain Action:** Availability re-queried for Thursday `2026-10-22`; previous slot offer replaced (`OFFER_REPLACED`).
- **Verdict:** **PASS**. 2 attempts (5,161ms, 6,029ms), 4,919 tokens.

### Case D: Provider Preference Removal (`SMOKE-D`)

- **Turn 1 Input:** `"عايز كشف مع دكتورة سارة يوم الأربعاء"`
- **Observed Model Output:** Intent `BOOKING`, `provider: "دكتورة سارة"`, `date: "2026-10-21"`.
- **Domain Action:** Customer omitted the service. Model extracted `"دكتورة سارة"`, while catalog name was `"د. سارة عادل"`. Provider matching in `catalog_strict` mode without service context returned provider unavailable for service. Domain issued reply: `"المزود المطلوب غير متاح لهذه الخدمة — يرجى اختيار مزود آخر أو اختيار أي مزود متاح."`
- **Failure Nuance:** Turn 1 scenario assertion expected provider `Sara` to resolve to the catalog entity and succeed. Because Turn 1 failed the scenario assertion, the scenario runner aborted immediately (`totalTurns: 1`).
- **Critical Conclusion:** **Turn 2 live REMOVE continuation ("خلاص أي دكتور متاح") was NOT tested live.**

### Case E: Time Preference Removal (`SMOKE-E`)

- **Turn 1 Input:** `"عايز كشف أسنان الصبح يوم الأربعاء"`
- **Observed Model Output:** Intent `BOOKING`, `date: "2026-10-21"`, extracted `timePreference: "الصبح"`.
- **Domain & State Action:** Reconciled into durable state as `"selectedTimePref": "الصبح"`. 3 morning slots (09:00, 09:30) were filtered and presented.
- **Evidence Nuance on Schema Rejection:** **The schema did NOT reject the output.** The engine and Zod schema accepted `"الصبح"` as a valid string and stored it in `knownFacts`. The failure occurred because the scenario test harness assertion strictly expected canonical English `"morning"` (`stateAfter?.selectedTimePref === "morning"`).
- **Critical Conclusion:** Because Turn 1 failed the harness assertion, execution stopped at Turn 1 (`totalTurns: 1`). **Turn 2 live REMOVE continuation ("أي وقت مناسب") was NOT tested live.**

### Case F: FAQ Interruption (`SMOKE-F`)

- **Turn 1 Input:** `"عايز كشف أسنان بكرة"` → Booking state established for `2026-10-21`.
- **Turn 2 Input:** `"هو عنوان العيادة فين بالظبط؟"`
- **Observed Model Output:** Intent `FAQ`, clinic address answered.
- **Domain Action:** Action `reply`. Authoritative booking facts (`service: "كشف أسنان"`, `date: "2026-10-21"`) strictly preserved in durable conversation state.
- **Verdict:** **PASS**. 2 attempts (5,003ms, 3,120ms), 4,838 tokens.

### Case G: Known Application Defect (`SMOKE-G`)

- **Turn 1 Input:** `"عايز كشف أسنان الصبح يوم الأربعاء"` → Initial slot offer presented.
- **Turn 2 Input:** `"أي وقت يناسبكم مش مشكلة"`
- **Observed Turn Action:** The model executed (1 attempt, 2,404 in / 168 out). However, in turn planning, the legacy `planTurn` sensitive filter inspected the raw text and matched `"مشكلة"` within `SENSITIVE_WORDS`.
- **Domain Result:** Intercepted turn and forced `action: "AI_HANDOFF"`, `conversationStatus: "NEED_HUMAN"`, `handoffCause: "SENSITIVE_OR_RESTRICTED"`.
- **Critical Conclusion:** **Case G reproduces a known application defect; this is NOT customer-behavior success.** The test scenario assertion explicitly asserted that the bug would trigger.

### Case H: Mechanical Confirmation (`SMOKE-H`)

- **Turn 1 Input:** `"عايز كشف أسنان بكرة"` → Slot offer presented with 3 numbered options.
- **Turn 2 Input:** `"1"`
- **Observed Turn Action:** Handled deterministically by Booking Core before AI routing.
- **Domain Action:** Slot 1 booked; appointment created in isolated repository double (`id: "appt-1"`).
- **Physical HTTP Attempts on Turn 2:** **Strictly 0 calls.**
- **Verdict:** **PASS**. 1 total attempt across the scenario, appointment booked.

---

## 6. Follow-Up Issues for Next Slices (Evidence-Based, No Unsupported Heuristics)

In accordance with strict repair boundaries, no dialect dictionaries, title aliases, or phrase exception regexes were added. The following issues are logged for evidence-based implementation in their proper respective slices:

1. **Provider Entity Resolution Defect:**
   - _Observation:_ Doctor honorifics/variants (`"دكتورة سارة"` vs `"د. سارة عادل"`) fail resolution when service context is not yet established.
   - _Follow-up:_ Implement provider catalog alias normalization scoped to business service metadata in the booking resolution layer.
2. **Canonical Time Preference Vocabulary:**
   - _Observation:_ Generative models return Arabic dialect time literals (`"الصبح"`) which are accepted by state schemas but fail canonical domain assertions.
   - _Follow-up:_ Introduce a canonical value mapping for Arabic time-of-day phrases (`"الصبح"` → `"morning"`, `"بعد الظهر"` → `"afternoon"`, `"بالليل"` → `"evening"`) in the AI response normalizer pipeline.
3. **Colloquial False-Sensitive Keyword Filtering:**
   - _Observation:_ Matching `"مشكلة"` in `SENSITIVE_WORDS` intercepts harmless Egyptian courtesies ("مش مشكلة" = "no problem / any time is fine"), triggering premature human handoffs.
   - _Follow-up:_ Refine sensitive keyword matching to require negative/risk context or exclude common negation compounds in `planTurn`.

---

## 7. Sanitization & Safety Verification

All raw data in this bundle and in `.flowpilot/playground/traces/` was processed by `redactTrace`:

- Secrets: Injected authorization headers redacted to `"[REDACTED_SECRET_1]"`.
- Tokens & Nonces: Offer tokens and nonces redacted to deterministic tokens (`"[REDACTED_OFFER_1]"`).
- Phone Numbers & Identity: Synthetic evaluation data (`"+201001234567"`, `"عيادة د. أحمد"`).
- Zero customer PII or production data involved.
