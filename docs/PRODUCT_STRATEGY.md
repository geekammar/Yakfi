# FlowPilot — Product Strategy

> Current strategy only. Superseded strategies move to the bottom of this
> file with a date. Pricing/economics hypothesis: `ECONOMICS.md`.
> Last updated: PROMPT-ARCH-01.

## Core Philosophy: Human-in-the-Loop

The AI assistant handles repetitive conversation work (answering FAQs,
proposing slots, collecting intent) but **must** hand off to a human when:

- Intent is ambiguous or high-stakes (pain/emergency language, complaints)
- The customer asks for a human
- Confidence in the next booking step is low

Conversations surface a `NEED_HUMAN` status; staff resolve inside the app.
This is mandatory — see `DECISIONS.md`.

## Market Strategy: Local Vertical Discovery Strategy

Instead of guessing a vertical, we sell one identical product to several local
appointment-based businesses and observe where value materializes.

### Candidate verticals (observation pool)

- Dental clinics
- Beauty centers / salons
- Coaches (fitness, life, tutoring)
- Gyms
- Education centers
- Home/service providers

## Current Geography: Kafr El Sheikh

- Small enough for founder-led, walk-in sales and support.
- Dense word-of-mouth network; trust transfers between owners.
- WhatsApp is the default business communication channel.

## Current Hypothesis

> Appointment-based businesses lose measurable revenue to missed bookings:
> unanswered messages during busy hours, slow replies that push customers to
> competitors, and no-shows caused by weak confirmation practices. An AI
> assistant on WhatsApp that converts chats into confirmed appointments will
> recover enough bookings to be obviously worth paying for.

## Current Objective

Find ONE vertical where all three are simultaneously true:

1. **ROI is obvious** — recovered appointments per month clearly exceed price.
2. **Customers renew** — month 2+ payment without chasing.
3. **Onboarding is repeatable** — same setup steps work across customers of
   that vertical with minimal customization.

## Beachhead Strategy

1. Recruit 3–5 pilot businesses locally (one or two verticals first).
2. Deploy the identical Spec A engine; customize nothing vertical-specific.
3. Run each pilot for 30 days with weekly check-ins.
4. Log evidence (bookings recovered, response time, no-show rate) — Spec B.
5. Compare verticals against Decision Criteria below; double down or pivot.

## Decision Criteria (for choosing the winning vertical)

| Criterion                | Bar                                                   |
| ------------------------ | ----------------------------------------------------- |
| Paid pilots              | ≥ 2 businesses paying without discount pressure       |
| Renewal                  | ≥ 60% renew into month 2                              |
| ROI evidence             | Recovered bookings ≥ 5× monthly price                 |
| Onboarding repeatability | New business live in < 1 day using the same checklist |
| Founder effort           | Support load sustainable solo                         |

## Current Risks

| Risk                                                   | Mitigation                                                             |
| ------------------------------------------------------ | ---------------------------------------------------------------------- |
| Verticals differ silently (hidden customization creep) | Keep scope frozen (Spec A); log every request instead of building it   |
| WhatsApp API/business policy friction                  | Start with manual/semi-automated flows; keep provider abstraction thin |
| Owners don't sustain message volume                    | Onboard with baseline metrics; show weekly recovery numbers            |
| Trust barrier for AI replying                          | Human-in-the-loop defaults; owner approves templates                   |
| Seasonality distorts 30-day reads                      | Track ≥ 2 months before final verdict                                  |

## Current Assumptions

- Target owners already use WhatsApp Business daily.
- A missed appointment costs the business more than our monthly price.
- Staff can be trained on a mobile-first Arabic UI in under an hour.
- Booking data volume per business is small (tens/day), so a single Postgres
  database serves all pilot businesses.

## Future Verticalization Plan (after a winner emerges)

1. Freeze the generic engine; fork vertical-specific templates/copy packs.
2. Deepen the winning workflow (e.g., dental recall cycles) behind feature
   flags scoped by vertical registry (Spec B).
3. Build onboarding checklists per vertical from real pilot learnings.
4. Expand geography only after vertical playbook is documented.

## Strategy History

| Date      | Change                       |
| --------- | ---------------------------- |
| Prompt 03 | Initial strategy documented. |
