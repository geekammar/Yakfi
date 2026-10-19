# CONV-CORE-01 — One decision owner and state/copy decoupling

Status: IN PROGRESS — architecture and acceptance baseline only; **not implementation complete**.
Baseline: merged CONV-JEV-01 PR #14 (v0.56.0).

## Code-backed findings

1. `src/features/conversations/server/turn-planner.ts` already owns the canonical `resolveTurnPlan`, explicit precedence ordering, single executed goal and preserved pending goals. Do **not** create a competing planner.
2. `src/features/conversations/server/conversation-state.ts` already models `activeTask`, `knownFacts`, `pendingOffer`, `topics` and booking journey stages. Domain truth must not be replaced by state.
3. `src/features/conversations/server/booking-selection.ts` currently reconstructs an offer by regex-scanning assistant-visible Arabic message text (`OFFER_HEADER` and `OFFER_LINE`), including a textual confirmation check. This is a coupling hazard: copy edits and localizations can break option selection. `ConversationPendingOffer` provides a typed landing spot, but rehydration and transactional consistency must be audited before it replaces legacy parsing.
4. `src/features/conversations/server/conversation-engine.ts` remains the canonical inbound route, with tenant resolution, webhook idempotency, decision resolution, Booking Core routing and response persistence. Keep this single path for WhatsApp and Telegram.
5. `src/server/integrations/ai/factory.ts` prefers real TypeSafe JEV when operationally eligible, subject to kill-switch and production budget guard. A semantic model is never an appointment authority.

## Required implementation slices — commit and verify separately

### Slice A — Typed offer context, not rendered copy
- Trace end-to-end offer construction, message persistence and restoration after a new request/process.
- Persist a versioned, tenant-scoped offer snapshot using existing durable structures *if they can represent it safely*; otherwise write an explicit migration proposal and STOP before schema changes.
- Keep short-term backward compatibility for already-sent offers. Never accept provider/service/slot ids from inbound user text.
- Treat numeric `1` as a selection only if a current live offer with matching indices exists. After an appointment is booked, expire that offer.
- Revalidate each selection against fresh CORE-01 and CORE-02 before writing via `createWithConflictCheck`.

### Slice B — One semantic-to-action contract
- Document and enforce `incoming turn -> JEV/fast-path/fallback decision -> resolveTurnPlan -> domain -> response`.
- Do not add keyword-based semantic detection, a second booking engine, or a second action planner.
- Respect explicit customer service choice over business default; preserve date/time/provider across a service clarification; preserve human and emergency precedence.
- Prefer semantic outcomes from real TypeSafe JEV, not lexical tricks; allow mechanical direct selections without model cost.

### Slice C — Conversation lifecycle vs booking lifecycle
- Verify that `BOOKED` is a booking outcome, not a permanent human takeover.
- Following successful booking, the customer may ask business hours, address, services, or begin another booking, unless staff explicitly owns the conversation or safety policy requires handoff.
- Do not allow `1` from an expired offer to create a second booking.

### Slice D — Verifiable evidence
- Run current `pnpm verify:local`, `pnpm check:convo-play`, `pnpm check:jev`, `pnpm check:booking-confirm` where supported.
- Add focused regressions: editable copy changed while option id remains correct; two sequential bookings; staff-assigned thread; post-booking FAQ; context preservation; tenant crossing; out-of-range selection; repeated webhook; JEV timeout fallback; provider conflict.
- Use CI/Playwright for full build and browser QA; do not claim green until GitHub checks report it.
- No production activation, migration or merge without explicit human approval.

## Practical acceptance

- Exactly one turn planner and one booking mutation authority.
- No customer-facing copy used as a durable machine-state protocol for newly offered options.
- No new unjustified infrastructure, polling, Redis or paid inference.
- Playground stays isolated/removable.
- The PR must stay DRAFT until actual implementation and verification are complete.
