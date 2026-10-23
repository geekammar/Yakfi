# FlowPilot — Post-Merge Telegram Acceptance Readiness & Operator Runbook

> **Authoritative Acceptance Readiness Record & Operator Runbook**  
> Covers baseline lineage verification, offline acceptance matrix results, and the executable live acceptance plan for Telegram bot integration.

---

## 1. Baseline and Deployment Verification

| Check / Dimension               | Expected Fact / Standard                                 | Observed Reality                                                                              | Verification Source / Command                                            | Status           |
| :------------------------------ | :------------------------------------------------------- | :-------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------- | :--------------- |
| **Merged Baseline PR**          | PR #29 (`feat/core-04b-global-ai-stop-execution-limits`) | PR #29 merged to `main` at `d291f1ac7cd22c7b8ac80cc05a6a39be97df53c4`                         | `git show origin/main -s`                                                | ✅ MATCH         |
| **Package Version**             | `0.70.0` (PR #29 baseline)                               | `0.70.0` (PR #29 baseline); incremented to `0.70.1` on feature branch for PR gate             | `git show origin/main:package.json`, `pnpm check:version`                | ✅ VERIFIED      |
| **Current origin/main SHA**     | `d291f1ac7cd22c7b8ac80cc05a6a39be97df53c4`               | `d291f1ac7cd22c7b8ac80cc05a6a39be97df53c4` (tag `v0.70.0`)                                    | `git rev-parse origin/main`                                              | ✅ UP-TO-DATE    |
| **Production Health URL**       | `https://flowpilot-prod.vercel.app/api/health`           | HTTP 200 OK                                                                                   | `curl -sS https://flowpilot-prod.vercel.app/api/health`                  | ✅ HEALTHY       |
| **Deployed Production SHA**     | `d291f1ac7cd22c7b8ac80cc05a6a39be97df53c4`               | `d291f1ac7cd22c7b8ac80cc05a6a39be97df53c4`                                                    | `/api/health` `commitSha`                                                | ✅ DEPLOYED_HEAD |
| **Deployed Production Version** | `0.70.0`                                                 | `0.70.0`                                                                                      | `/api/health` `version`                                                  | ✅ MATCH         |
| **Production DB State**         | `connected`, `deploymentReady: true`                     | `database: "connected"`, `deploymentReady: true`, `missingEnvVars: []`                        | `/api/health` response body                                              | ✅ CONNECTED     |
| **Production Health Timestamp** | Read-only observation                                    | `2026-10-23T18:37:11.639Z`                                                                    | Live response payload                                                    | ✅ RECORDED      |
| **Production CI Status**        | Post-deploy workflow passed                              | Success (Run `40000933519`)                                                                   | `gh run list --workflow "Production Release & Post-Deploy Verification"` | ✅ PASSED        |
| **Environment Isolation**       | Isolated staging/test environment                        | **PRODUCTION SHARED NEON POSTGRES** (`flowpilot-prod.vercel.app` is production; not isolated) | `docs/BUILD_STATE.md`, `/api/health` `environment: "production"`         | ⚠️ PROD_SHARED   |

> [!IMPORTANT]
> **Lineage Verdict: DEPLOYMENT_VERIFIED_CURRENT.**  
> The deployed production application at `flowpilot-prod.vercel.app` matches `origin/main` commit `d291f1a` (v0.70.0).  
> **However, `flowpilot-prod` is the LIVE production environment sharing the production Neon database and production credentials.** Live acceptance testing against production resources is strictly unauthorized and blocked until an isolated test environment is provisioned or operator authorization is granted under the live runbook below.

---

## 2. Acceptance Evidence Levels

All test cases and execution stages are classified strictly by the following four levels. Higher levels must **never** be inferred from lower levels:

- **Level A: Offline Controlled-Provider Execution.**  
  Injected mock/controlled AI adapters, in-memory state repository (`InMemoryConversationStateStore` with CAS revision tracking), in-memory appointments, deterministic availability, zero network wire calls, zero external provider spend.
- **Level B: Real-Provider Execution with Isolated In-Memory Repositories.**  
  Real LLM/JEV API HTTP calls via provider adapters under an authorized spend envelope, but strictly bounded to in-memory repositories and mock channel transports (zero database mutations, zero outbound messages).
- **Level C: Isolated Persistent-Database Integration.**  
  Dedicated, isolated staging/test PostgreSQL database running real Prisma repositories and migrations, separate from production data.
- **Level D: Actual Telegram Webhook-to-Reply Execution.**  
  End-to-end execution from incoming Telegram update through route proxy, webhook HMAC digest verification, Conversation Engine, Booking Core, database persistence, and outbound `sendMessage` to the Telegram Bot API.

---

## 3. Acceptance Matrix: 16 Journeys Verified Offline (Level A)

Fixed Synthetic Business:

- **Business Name:** `عيادة النور لطب الأسنان`
- **Timezone:** `Africa/Cairo` (UTC+3 / UTC+2 DST-aware)
- **Reference Instant:** `2026-10-22T10:00:00.000Z` (Thursday morning 12:00 PM Cairo)
- **Catalog Services:**
  1. `33333333-3333-4333-8333-333333333331`: "كشف أسنان" (30 min, 150 EGP)
  2. `33333333-3333-4333-8333-333333333332`: "تنظيف جير" (45 min, 300 EGP)
- **Providers:**
  1. `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1`: "د. أحمد سامي"
  2. `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2`: "د. علي محمود"
- **Working Hours:** Sat–Thu 09:00–18:00 (Cairo), Friday closed.

|   #    | Journey Description                                           | Initial State                                                | Exact Synthetic Input                                                            | Expected Semantic Facts & Durable State                                                                                   | Customer Visible Result                                                         | Appointments (Before → After) | Model Calls (Log/Phys) |   Level & Result    |
| :----: | :------------------------------------------------------------ | :----------------------------------------------------------- | :------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------ | :---------------------------: | :--------------------: | :-----------------: |
| **1**  | **Telegram `/start`**                                         | Empty conversation, unassigned, `AI_ACTIVE`                  | `/start`                                                                         | 0 model calls; `offer.kind: "WELCOME"`; business name & free text guidance                                                | Welcome message + inline choices («حجز موعد», «استفسار عن خدمة»)                |             0 → 0             |         0 / 0          | **Level A** ✅ PASS |
| **2**  | **Natural-Language Booking Request**                          | Empty conversation                                           | «عايز أحجز كشف أسنان»                                                            | `knownFacts.service: "كشف أسنان"`; `serviceId: SERV_DENTAL`; `activeTask.stage: "SERVICE_SUPPLIED"`; `offer.kind: "DATE"` | Scheduling offer presented with dates                                           |             0 → 0             |         1 / 1          | **Level A** ✅ PASS |
| **3**  | **Provider Requested Before Service**                         | Empty conversation                                           | «عايز أحجز مع دكتور أحمد»                                                        | `knownFacts.provider: "د. أحمد"`; `providerPreference: "د. أحمد"`; `offer.kind: "SERVICE"`                                | Clarifies missing service while preserving doctor preference                    |             0 → 0             |         1 / 1          | **Level A** ✅ PASS |
| **4**  | **Unknown or Ambiguous Provider**                             | Empty conversation                                           | «عايز كشف أسنان مع دكتور حسام»                                                   | Provider not in catalog; zero silent provider assignment; clarification requested                                         | Clarification prompt listing valid doctors (د. أحمد, د. علي)                    |             0 → 0             |         1 / 1          | **Level A** ✅ PASS |
| **5**  | **Relative Date & Morning/Afternoon Preference**              | Empty conversation                                           | «عايز ميعاد كشف السبت الصبح»                                                     | `knownFacts.date: "2026-10-24"`; `timePreference: "morning"`; `offer.kind: "SLOT"`; slots strictly `< 12:00`              | Morning-only slots presented                                                    |             0 → 0             |         1 / 1          | **Level A** ✅ PASS |
| **6**  | **Date Correction After Offer**                               | Active slot offer on `2026-10-24`                            | «لا خليه يوم الأحد في نفس الوقت»                                                 | Old offer invalidated (`id !== id`); `knownFacts.date: "2026-10-25"`; compatible facts preserved                          | New slot offer for Sunday 2026-10-25                                            |             0 → 0             |         2 / 2          | **Level A** ✅ PASS |
| **7**  | **Provider/Time-Preference Removal**                          | Active slot offer with `timePreference: "morning"`           | «أي وقت يناسبكم مش مشكلة صباحاً أو مساءً»                                        | FactUpdate `REMOVE` executed; `timePreference: null`; compatible date/service preserved                                   | Unrestricted slots across the whole day presented                               |             0 → 0             |         2 / 2          | **Level A** ✅ PASS |
| **8**  | **FAQ Interruption During Booking**                           | Active booking task with service and date                    | «أين يقع مكان العيادة بالضبط؟»                                                   | AI answers FAQ; `activeTask.kind: "BOOKING"` and all known facts preserved in durable state                               | Clinic address delivered; booking continues unbroken                            |             0 → 0             |         2 / 2          | **Level A** ✅ PASS |
| **9**  | **Valid Mechanical Selection**                                | Active slot offer with valid options                         | `fp:<token>:1` (button callback)                                                 | Exactly 0 new model calls; offer status transitions to `CONSUMED`; booking committed                                      | Confirmed booking notification with date/time details                           |             0 → 1             |         0 / 0          | **Level A** ✅ PASS |
| **10** | **Invalid Callback (Expired/Replaced/Malformed/Cross-Scope)** | Active conversation                                          | `fp:malformed`, `fp:99999999:1`, `fp:<token>:unknown`, expired `fp:<token>:book` | Rejection of foreign/stale tokens; facts unchanged; zero appointments                                                     | Safe guidance/fallback message; zero state corruption                           |             0 → 0             |         0 / 0          | **Level A** ✅ PASS |
| **11** | **Duplicate Inbound & Repeated Confirmation**                 | Active slot offer                                            | `fp:<token>:1` delivered twice with same `externalId`                            | First delivery claims dedupe key & confirms; second returns `{ duplicate: true }`                                         | Single confirmation delivered; second attempt safely ignored                    |       0 → 1 (remains 1)       |         0 / 0          | **Level A** ✅ PASS |
| **12** | **Offer Persistence / CAS Conflict**                          | Active booking; state store returns `{ status: "conflict" }` | `/start` (or any turn saving offer)                                              | CAS collision detected; safe retry message; actionable inline keyboard suppressed                                         | Safe conflict message: «حدث تعارض مؤقت أثناء معالجة طلبك، يرجى إعادة المحاولة.» |             0 → 0             |         0 / 0          | **Level A** ✅ PASS |
| **13** | **Staff-Owned Conversation Boundary**                         | Assigned to `staff-operator-1`, `NEED_HUMAN`                 | «عايز أحجز كشف بسرعة»                                                            | Engine halts with `DEFERRED_TO_STAFF`; zero automated model calls; delivery suppressed                                    | No automated message sent; customer routed to staff inbox                       |             0 → 0             |         0 / 0          | **Level A** ✅ PASS |
| **14** | **Explicit Human Request & Sensitive Handoff**                | Active conversation, `AI_ACTIVE`                             | «ممكن أكلم حد من خدمة العملاء؟»                                                  | Intent `HUMAN_REQUEST`; typed cause `CUSTOMER_REQUESTED_HUMAN`; status `NEED_HUMAN`                                       | Handoff acknowledgment delivered; staff attention opened                        |             0 → 0             |         1 / 1          | **Level A** ✅ PASS |
| **15** | **Harmless Dialectal Wording Near Lexical Triggers**          | Active conversation, `AI_ACTIVE`                             | «عايز كشف أسنان وأي وقت يناسبكم مش مشكلة»                                        | Semantic safety evaluates utterance as `safe`; NO false `SENSITIVE_OR_RESTRICTED` handoff                                 | Conversation remains `AI_ACTIVE`; booking proceeds                              |             0 → 0             |         1 / 1          | **Level A** ✅ PASS |
| **16** | **Global Stop, Attempt Ceiling & Deadline Exhaustion**        | Injected controls (CORE-04B)                                 | Dispatches under `GLOBAL_STOP=1`, `MAX_ATTEMPTS=1` abort, deadline 0ms           | Truthful stop reasons (`GLOBAL_STOP`, `ATTEMPT_LIMIT_EXHAUSTED`, `DEADLINE_EXHAUSTED`); bounded wire calls                | Fail-safe replies; 0 wire calls under global stop; 0 appointments               |             0 → 0             |    Bounded (0/1/0)     | **Level A** ✅ PASS |

**Result Summary:** 16/16 PASSED (0 FAILED) in `scripts/check-telegram-acceptance-matrix.ts` (`pnpm check:telegram-acceptance`).

---

## 4. Preserved Architecture and Safety Invariants

- **Single Conversation Architecture:** All 16 journeys run through the merged `receiveInboundMessage` entrypoint, `resolveFinishedTurn` planner, Booking Core, and CAS-guarded `ConversationStateStore`.
- **Zero-Call Mechanical Execution:** Telegram `/start` welcome command and button callback selections (`fp:<token>:<action>`) execute with **strictly zero** LLM or JEV calls.
- **Server Authorization Boundary:** AI only extracts customer language intent; server code validates provider availability, slot conflicts, service durations, and tenancy authorization.
- **Durable CAS Guarantees:** Offers are assigned durable random tokens and validated against conversation state revision before buttons are actionable; CAS conflicts suppress unpersisted keyboard markup.
- **Idempotent Inbound Deduplication:** Webhook redeliveries and button double-taps are trapped by the durable `inboundDedupeRepository` claim before business execution.
- **Execution Limits (CORE-04B):** Global stop switch halts external HTTP dispatches with `GLOBAL_STOP`; retry/fallback chains are strictly bounded by serving attempt allowances (clamped to 3) and a shared non-resetting deadline.

---

## 5. Live Acceptance Operator Runbook

> [!CAUTION]
> **DO NOT EXECUTE WITHOUT OPERATOR AUTHORIZATION.**  
> Real-provider calls consume paid API quota; database writes mutate persistent storage. Live acceptance must run only under the parameters and controls specified below.

### 5.1 Prerequisites and Isolation Verification

Before executing any live acceptance turn:

1. **Isolated Test Tenant:** Verify a dedicated test `businessId` exists (e.g. `مركز الاختبارات التجريبي`). Never run test scripts against a live clinic (`مركز أفنان`).
2. **Dedicated Test Bot:** The test bot must be a dedicated Telegram Bot created via `@BotFather` (e.g. `@FlowPilotTestBot`), completely distinct from `@FlowPilotManagerBot` or the live pilot bot.
3. **Database Target:** Verify `DATABASE_URL` targets an isolated test database (e.g. Neon branch `test` or local Postgres). If `DATABASE_URL` points to production, the run is **BLOCKED**.
4. **Environment Variables Required:**
   ```bash
   FLOWPILOT_AI_GLOBAL_STOP=0
   FLOWPILOT_AI_MAX_SERVING_ATTEMPTS=2
   TELEGRAM_BOT_TOKEN="<dedicated-test-bot-token>"
   TELEGRAM_WEBHOOK_SECRET="<secret-for-test-bot>"
   OPENROUTER_API_KEY="<authorized-openrouter-key>"
   ```

### 5.2 Proposed Live Campaign Envelope

| Parameter                     | Limit                                                                 | Enforcement Mechanism                                     |
| :---------------------------- | :-------------------------------------------------------------------- | :-------------------------------------------------------- |
| **Max Physical Requests**     | **20 physical calls** total across campaign                           | Enforced by run-level execution session ceiling           |
| **Max Output Tokens**         | **400 tokens** per generative turn                                    | Enforced on adapter wire payload (`max_tokens: 400`)      |
| **Per-Turn Serving Deadline** | **12,000 ms** (12 seconds)                                            | Enforced by shared `ServingExecutionSession` deadline     |
| **Max Turns**                 | **10 conversational turns**                                           | Hard execution limit in test script                       |
| **Planning Budget**           | **$0.05 USD**                                                         | Planning basis: DeepSeek V3 @ $0.2574/M in, $1.0287/M out |
| **Stop Conditions**           | Global stop flag, 3 consecutive provider errors, or budget exceedance | Immediate process exit code 1; no retries                 |

> [!NOTE]
> Pricing estimates are rate-based planning bounds, not guaranteed provider-side dollar limits. OpenRouter does not support real-time monetary spending caps via API.

### 5.3 Manual Mobile Telegram Acceptance Script (For Operator)

The operator executes these 6 exact steps from a mobile Telegram client talking to the dedicated test bot:

1. **Send `/start`**
   - _Expected:_ Fixed welcome greeting with business name, instructions that free text is accepted, and inline buttons («حجز موعد», «استفسار عن خدمة»).
   - _Evidence to collect:_ Bot response time (< 1.5s), button layout rendering.
2. **Tap «حجز موعد»**
   - _Expected:_ Bot replies with service catalog buttons or date selection options without any generative AI request (0 model calls).
   - _Evidence to collect:_ Instantaneous response (< 800ms).
3. **Type Natural Text: «عايز كشف أسنان بكرة الصبح»**
   - _Expected:_ Bot acknowledges dental appointment request, filters slots for tomorrow morning (< 12:00 Cairo time), and presents interactive time slot buttons.
   - _Evidence to collect:_ Time slot candidates match Cairo working hours.
4. **Type Correction: «لا خليه بعد الظهر أفضل»**
   - _Expected:_ Bot replaces the previous offer, preserves the dental service and date, and presents afternoon time slots (>= 12:00 Cairo time).
   - _Evidence to collect:_ Old buttons become invalid if tapped; new afternoon buttons appear.
5. **Tap a Specific Time Slot Button**
   - _Expected:_ Single confirmed appointment message with date, time, and service; offer status marked `CONSUMED`.
   - _Evidence to collect:_ Exactly 1 appointment row created in the test database.
6. **Tap the Same Time Slot Button Again (Double-Tap Test)**
   - _Expected:_ Safe rejection or idempotent notice; zero duplicate appointment created.
   - _Evidence to collect:_ Database appointment count remains exactly 1.

---

## 6. Blocker and Risk Register

|       Severity       | Item                                      | Impact                                                                                                                                          | Mitigation / Status                                                                                                         |
| :------------------: | :---------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------- |
|   **P1 (Blocker)**   | **Production Environment Shared Target**  | `flowpilot-prod.vercel.app` is production; running live tests directly against it would risk customer data mutation and live channel crosstalk. | **BLOCKED for direct live execution on production.** Operator must run live stage against dedicated test tenant & test bot. |
|   **P2 (Caution)**   | **Lack of Provider-Side Hard Dollar Cap** | OpenRouter lacks hard real-time balance caps via API; runaway loops could consume funds if unmonitored.                                         | Enforced by CORE-04B attempt ceilings (max 20 physical requests per run) and 12s per-turn deadline.                         |
| **P3 (Operational)** | **Vercel Log Inspection Visibility**      | Structured turn evidence JSON is logged to stdout/runtime logs, but cannot be read locally without Vercel CLI credentials or OTLP sink.         | Verified locally and in CI via `check:turn-evidence` and in-memory trace capture.                                           |

---

## 7. Recommendation and Verdict

### Recommendation: `READY_FOR_AUTHORIZED_LIVE_ACCEPTANCE`

**Reasons:**

1. **Baseline & Deployment Verified:** The deployed production system (`flowpilot-prod.vercel.app`) is verified healthy, database connected, and running the exact merged PR #29 HEAD (`d291f1a`, v0.70.0).
2. **16/16 Acceptance Journeys Verified Offline:** The complete acceptance matrix (Journeys 1–16) has been implemented and 100% verified offline under Level A (controlled-provider, in-memory isolation) via `pnpm check:telegram-acceptance`.
3. **Execution Limits Intact:** Global AI stop (`FLOWPILOT_AI_GLOBAL_STOP`), serving attempt ceilings (clamped to 3), non-resetting deadlines, and zero-model mechanical execution are fully operational and verified by `pnpm check:core-04b` (159/159 PASS).
4. **Live Runbook Prepared:** A minimal, safe operator runbook with an explicit spend envelope (20 calls, 400 max tokens, 12s deadline, $0.05 budget) and manual mobile test script is ready for operator authorization.
5. **No Production Mutation:** In accordance with task constraints, zero paid calls were dispatched, zero database migrations or mutations were executed, and zero live messages were sent.
