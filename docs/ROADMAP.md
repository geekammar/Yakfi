# FlowPilot — Roadmap

> The plan sequence ONLY: Spec A → Spec B → Spec C. Scope detail lives in
> `SPEC_A.md`; implementation status lives in `BUILD_STATE.md` (never
> here). Each spec is frozen before the next begins.
> Last updated: PROMPT-ARCH-01.

## Spec A — Discovery Foundation + Booking Core (CURRENT)

**Goal:** a pilot-ready generic engine that proves daily usefulness for one
business at a time.

**Status:** implementation COMPLETE through PROMPT-19 (all screens + the
conversation engine slice). The operational exit criteria additionally
require the two pending operator decisions (real WhatsApp transport
provider, real AI/LLM provider — DECISIONS #29) and the accepted
architecture-hardening phase (DECISIONS #30–#36) before real production
booking.

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
