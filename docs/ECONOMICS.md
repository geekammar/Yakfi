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
