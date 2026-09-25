# FlowPilot — Roadmap

> The plan sequence ONLY: Spec A → Spec B → Spec C. Scope detail lives in
> `SPEC_A.md`; implementation status lives in `BUILD_STATE.md` (never
> here). Each spec is frozen before the next begins.
> Last updated: DOC-NORMALIZE-V029 (DECISIONS #57).

## Spec A — Discovery Foundation + Booking Core (CURRENT)

**Goal:** a pilot-ready generic engine that proves daily usefulness for one
business at a time.

**Status:** implementation COMPLETE — all Spec A screens, the conversation
engine, the P0 architecture-hardening foundations (DECISIONS #30–#36,
implemented as #38), and the owner-facing UX surfaces released through
**v0.29.0** (services, knowledge/FAQ authoring, appointment creation,
reschedule, appointments/availability coherence, slot presentation). The two
former operator decisions that gated production booking are RESOLVED and
implemented: the WhatsApp transport provider is Meta Cloud API (DECISIONS
#42/#46) and the AI/LLM provider is the policy-backed adapter (DECISIONS #44).
The remaining operational exit gate is REAL PILOT OPERATION (see below), not
code.

**Exit criteria:**

- A real business can be onboarded in < 1 day using the app alone.
- A conversation can flow: customer message → AI/staff reply → booked,
  confirmed appointment.
- Owner can see today's agenda and act on `NEED_HUMAN` threads.

## Spec B — Evidence Layer + Founder Side (planned)

**Goal:** turn pilot operations into structured, comparable evidence.

Contents (planned): pilot tracking (registry: business, vertical, start
date, plan price, status trial/paid/churned; weekly check-in log); ROI
tracking (baseline vs. current: recovered bookings, response time, no-show
rate; monthly ROI statement per pilot); vertical registry (first-class
vertical records attached to pilots; vertical-scoped copy/template packs —
still no vertical UI forks); evidence logging (structured event log:
onboarding steps, objections, feature requests, churn reasons; exportable
timeline per vertical); Founder Side (cross-pilot read-only founder
dashboard over the same database; founder-only route group; no new
infrastructure).

Still excluded: billing automation, payments, public API.

**Exit criterion:** the founder can answer "which vertical is winning and
why?" from the product, not from memory.

## Spec C — Vertical Discovery Engine (planned)

**Goal:** make the vertical decision data-driven and repeatable.

Contents (planned): vertical scoring (composite score per vertical from the
`PRODUCT_STRATEGY.md` decision criteria), willingness-to-pay tracking,
feature clustering (grouped requests/objections by vertical), and a decision
center (guided comparison + double-down / iterate / drop recommendation
with evidence links).

**Exit criterion:** a documented, evidence-backed choice of the winning
vertical, ready for the verticalization plan in `PRODUCT_STRATEGY.md`.

## Beyond Spec C (unplanned — do not start)

Geographic expansion playbook, vertical-specific deepening (e.g., dental
recall cycles), automated reminders/notifications, public API (only if a
paying partner demands it). Nothing here may be built without a scope
decision recorded in `DECISIONS.md`.
