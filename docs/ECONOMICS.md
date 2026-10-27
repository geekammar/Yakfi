# FlowPilot — Economics & Pricing Reference

> Canonical reference for usage, cost attribution, pricing separation, and
> the pricing hypothesis. Current-vs-deferred status is explicit.
> Decision record: DECISIONS #36. Last updated: DOC-NORMALIZE-V029 (content
> current: metering foundation implemented; billing/pricing remain deferred
> pending pilot evidence).

## Hard separation (binding)

**Usage ≠ Cost ≠ Price ≠ Entitlement ≠ Billing.** These five concepts are
never conflated in code, naming, or discussion:

| Concept         | Question it answers                         | Status                        |
| --------------- | ------------------------------------------- | ----------------------------- |
| **Usage**       | What did the customer actually consume?     | Current foundation (metering) |
| **Cost**        | What did serving that consumption cost us?  | Current foundation (metering) |
| **Price**       | What does the customer pay, per which unit? | Hypothesis only (not locked)  |
| **Entitlement** | What is the customer allowed to consume?    | Future (versioned, deferred)  |
| **Billing**     | How is money actually collected?            | Deferred (manual invoicing)   |

## Current foundation: usage + cost metering

Internal economics MUST be measurable from the start. Meter (per business,
per period):

- **Volume:** messages, conversations, AI runs, bookings, handoffs
- **AI:** token usage, AI cost
- **Provider:** WhatsApp/provider cost
- **Derived:** cost-to-serve, cost per conversation, cost per successful
  booking
- **Commercial evidence:** willingness to pay (WTP), renewal, gross margin

This metering is foundation work — it may be added WITHOUT building
Founder Dashboard, Discovery Engine, or any billing system (Platform
Operator separation: DECISIONS #22, #36).

## Pricing hypothesis (NOT a commitment)

- **Early pilots** may use **message-based pricing** as the working
  hypothesis — it is a hypothesis, not a permanent commitment.
- **The final billing unit is intentionally NOT locked.**
- **Conversation** is the leading customer-facing usage candidate (it maps
  to the customer's mental model: "a conversation got handled").
- **Never** bill customers directly by AI tokens — token cost is OUR cost
  signal, not a customer-facing price unit.

## Future pricing candidate (when evidence justifies it)

**Base Subscription + Included Conversations + Capacity Limits +
Predictable Overage/Add-ons.**

- Capacity candidates: **Providers, Branches, WhatsApp Connections.**
- Pricing must be **versionable**: `Plan → PlanVersion → Entitlements` —
  existing customers stay on their plan version; limits change via new
  versions, never by editing live plans.
- **Never hard-code plan limits inside operational business logic** —
  entitlements are checked through a dedicated layer, not sprinkled
  through features.

## Deferred (do not build yet)

Billing, subscriptions, invoices, payments, plan management UI,
entitlement enforcement, dunning, proration. Pilots are invoiced manually
(Spec A exclusion, unchanged) — "deferred", not "never": revisit with
Spec B evidence.

## Relationship to discovery strategy

WTP, renewal, and gross margin are discovery decision criteria
(`PRODUCT_STRATEGY.md`). The metering above is what makes them measurable
from real pilot data instead of memory.

## Versioned Measurement & Cost Contracts (v0.73.0)

### 1. Commercial Session Measurement Contract (`flowpilot.commercial.session.contract@v1`)

Pure, deterministic internal volume measurement:

- **Interval:** Half-open UTC window $[T_{\text{start}},\, T_{\text{start}} + 24\text{ hours})$.
- **Scope Key:** `businessId:channel:connectionId:customerId` (anchored to tenant, customer, transport channel, and exact connection).
- **Qualifying Events:** Substantive customer messages (`MESSAGE`) and validated interactive selections (`CHOICE_CALLBACK`). Zero NLP, zero free-text regexes.
- **Start-Only Activity:** Telegram `/start` command protocol (`START_COMMAND`) deterministically yields welcome and does NOT open a commercial session.
- **Deduplication & Test Isolation:** Intercepted duplicate payloads are excluded (`isDuplicate`); test ingress traffic is isolated in the `TEST` pool.
- **Permutation Invariance:** Batches are sorted by `canonicalTimestamp` + `eventId` tie-breaker before rollup.
- **Period Carry-In:** Explicit prior session state (`priorSessions`) prevents artificial session splits across measurement periods.

### 2. Cost Engine (`flowpilot.cost.engine@v1`)

Pure per-attempt physical execution accounting:

- **Precedence:** Valid provider-reported cost first (`PROVIDER_REPORTED`, including $0.00); otherwise matching dated rate snapshot (`RATE_SNAPSHOT`); otherwise `UNKNOWN`.
- **Zero-Dispatch Prevention:** Locally prevented attempts (e.g. `FLOWPILOT_AI_GLOBAL_STOP`, ceiling clamps) have 0 external cost and are excluded from the dispatched coverage denominator.
- **Status Code Honesty:** HTTP 0, 401, 403, 429, or timeouts NEVER infer zero cost automatically unless proven un-dispatched.
- **Completeness & Subtotals:** Dispatched attempts with mixed known/unknown costs report `PARTIAL` completeness with `totalCostUsd = null` while preserving `knownSubtotalUsd`. Fully covered turns report `COMPLETE`.
- **Token Caching:** Evaluates cached vs uncached prompt rates without double counting.
- **Pool Isolation:** Strict separation across `SERVING`, `SHADOW`, and `TEST` pools. Missing shadow data remains unknown, never fabricated.
- **Coverage Denominator:** Coverage ratio reflects known dispatched attempts divided by total dispatched wire attempts. Zero denominator yields null (`N/A`).

### 3. Persistence Caveats & Architectural Gaps (Under Review)

The proposed persistence schema is a discovery design proposal and is **NOT approved or implemented**:

- **Finished-Only Crash Gaps:** In-flight network attempts that crash the process before turn completion are missing from finished-turn logs.
- **ID-Based Reconciliation & Grace Period:** Provider billing reconciliation requires an ID-based matching window with an explicit post-month grace period (e.g. 72 hours) before period lock.
- **Serving / Shadow Lineage Limitations:** Shadow JEV calls share the inbound execution context but must maintain disjoint trace lineage to prevent downstream billing inflation.
