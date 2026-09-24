# Feature: appointments

Booking lifecycle: creation, confirmation, rescheduling, cancellation, reminders,
deterministic availability (PROMPT-10), the Smart Create Appointment flow
(PROMPT-11 Steps 1–3 + PROMPT-12 Step 4 — available-slot selection +
PROMPT-13 Step 5 — review + PROMPT-14 Step 6 — confirmation / appointment
creation), and the B-07 appointment-creation UX layer (smart context,
relative scheduling, availability-first selection, follow-up).

## Isolation rules

- Everything feature-specific lives in this folder: components, hooks,
  schemas, server actions/queries, and API clients.
- This feature may import from `@/components/ui`, `@/lib/*`, `@/server/db`,
  `@/types`, and its own files — never from another feature folder.
- Cross-feature composition happens at the route layer (`src/app`), not here.
- No circular dependencies. If two features need shared logic, promote it to
  `@/lib` or `@/server` deliberately and stays small.
- Keep files small and single-purpose; no giant shared barrels.

## Structure

- `actions/appointment-actions.ts` — create/status/reschedule writes
  (tenant-scoped, conflict-checked, status transitions enforced).
  `createAppointment` is a thin session wrapper: the actor is derived
  from the authenticated session + DB user, and all rules live in the
  create service (PROMPT-14). The B-07 follow-up writes through this
  same action — there is no second write path.
- `actions/booking-flow-actions.ts` — `searchBookingCustomersAction`: thin
  `"use server"` wrapper for the booking-flow customer search (Step 1).
- `actions/availability-actions.ts` — `getAvailabilityAction`: thin
  `"use server"` read hook for the availability service (consumed by
  Step 4 of the Smart Create flow AND by the B-07 follow-up
  re-verification).
- `schemas/appointment-schema.ts` — form-level Zod inputs for the agenda
  actions.
- `schemas/availability-schema.ts` — availability request input
  (`{date, serviceId}` ONLY; the Business is never client-controlled —
  Zod strips every other key). Step 4 consumes this schema verbatim.
- `schemas/booking-flow-schema.ts` — booking-flow inputs: customer search
  (`{query}` ONLY — hostile keys stripped) and the B-07 smart-context
  input (`{customerId?, serviceId?}` ONLY — `bookingContextSchema`
  strips every other key, so a hostile `businessId`/`role` can never
  reach the prefill resolution).
- `server/appointment-create-service.ts` — THE single
  appointment-creation engine (PROMPT-14): the exact rules the
  `createAppointment` action has enforced since v0.1.0 (Zod boundary
  validation, tenant isolation, active-service check, server-derived
  `endTime` + initial status from `Business.confirmationMode`,
  transactional conflict check), extracted into the feature's
  injectable-deps service pattern so it stays verifiable without a
  live database. Failures are typed codes
  (`CreateAppointmentErrorCode`) with Arabic messages. The B-07
  follow-up writes through it unchanged — there is no second writer.
- `server/appointment-queries.ts` — agenda/detail reads.
- `server/availability-service.ts` — deterministic availability
  calculation (see Semantics below).
- `server/booking-flow-service.ts` — Steps 1–2 reads: tenant-scoped
  customer search (name/phone via the existing repository primitive) and
  the active-services list; PLUS the B-07 `resolveBookingContext`
  (server-side smart-context resolution — a foreign/inactive id
  prefills nothing) and the pure `deriveInitialBookingScreen` (which
  step a prefill opens on).
- `hooks/use-debounced-value.ts` — debounce for the search box
  (promoted to `src/hooks/use-debounced-value.ts` in PROMPT-15 — the
  customers feature needed the same hook).
- `components/smart-create/date-format.ts` — pure calendar helpers:
  `moveDate`/`formatArabic*` AND the B-07 relative-scheduling math
  (`resolveRelativeDate`, `addMonths`, `startOfBusinessWeek`,
  `RELATIVE_DATE_OPTIONS`, `FOLLOW_UP_OPTIONS`). Deterministic,
  timezone-independent; no availability coupling here.
- `components/smart-create/slot-helpers.ts` — pure presentation helpers
  (Arabic time formatting, period grouping, stale-selection membership,
  timezone label) plus the B-07 `earliestSlot` (the availability-first
  quick pick — the contract returns slots ascending, so the first entry
  is the earliest valid time).
- `components/smart-create/*` — the Smart Create flow (see below).
- `types.ts` — agenda/detail/option types, the availability result
  contract, the 6-step flow constants, `SelectedSlot`, the review-check
  state, the typed create-appointment result, the Step 6 submission
  state, the B-07 `BookingContextPrefill` + `FollowUpState`, and
  booking-flow option types.

## Smart Create flow (Steps 1–6)

`/appointments/new` is the Smart Create Appointment flow: العميل → الخدمة
→ التاريخ → الوقت → المراجعة → التأكيد, shown in a 6-step progress
indicator where all six steps are active.

- **Step 1 — العميل** (`customer-step.tsx`): search by name or phone
  (debounced, `searchBookingCustomersAction` → `searchBookingCustomers`,
  tenant-scoped by construction), a clear no-match empty state, an obvious
  selected-customer state, and an easy تغيير before continuing.
- **Step 2 — الخدمة** (`service-step.tsx`): radio-cards of the Business's
  ACTIVE services only (inactive services are never bookable), with name +
  duration in minutes.
- **Step 3 — التاريخ** (`date-step.tsx`): a quick-pick strip of the next 14
  days (starting from business-timezone today, server-derived) plus a
  native date input (min = business today). Validation reuses the shared
  `appointmentDateSchema`. NO availability calculation happens here.
- **Step 4 — الوقت** (`slot-step.tsx`, PROMPT-12): REAL available-slot
  selection consuming the PROMPT-10 availability layer through
  `getAvailabilityAction` — every displayed time comes from the server
  result; nothing is invented on the client. The query runs only while
  the step is mounted with a valid date + service (query key
  `["booking-availability", serviceId, date]`). Four distinct states:
  loading (skeleton + sr-only status), slots (grouped
  الصباح/بعد الظهر/المساء chips, `aria-pressed` selection, `aria-live`
  count, business-timezone label), zero slots with the explicit reason
  rendered as clear Arabic copy + actionable next steps (تغيير التاريخ,
  and تغيير الخدمة for `SERVICE_TOO_LONG`), and failure (`role="alert"`
  - retry, with العودة إلى الخدمات for service-related typed errors).
    `slot-helpers.ts` holds the pure presentation helpers (Arabic time
    formatting, period grouping, stale-selection membership check,
    timezone label) — display-only; the availability semantics live in the
    service. A fresh successful result that no longer contains the
    preserved slot also clears it in the wizard state
    (`onSlotUnavailable`), so a stale slot can never reach the review.
- **Step 5 — المراجعة** (`review-step.tsx`, PROMPT-13): one-glance
  review of the already-selected customer (name + phone), service (name +
  duration from `Service.durationMinutes`), date (long Arabic form), and
  slot (start AND end time from `SelectedSlot`). Each section carries a
  تعديل affordance back to its own step; back-navigation never resets
  selections. Missing required inputs are reported as actionable Arabic
  errors with a way back to the providing step (`getMissingReviewFields`
  — the pure derivation shared with the container's gating); no fallback
  values are invented. The wizard footer's primary action
  (متابعة إلى التأكيد) REVALIDATES the slot through the SAME
  `getAvailabilityAction` (one request per click, no mount-time query,
  no second engine, no reservation) — a stale slot clears through the
  wizard-state mechanism and keeps the user on the review with an
  obvious اختيار وقت آخر action; a verified slot is a HAND-OFF (not a
  reservation) and moves the flow to Step 6.
- **Step 6 — التأكيد** (`confirm-step.tsx`, PROMPT-14): the final
  confirmation screen. BEFORE CREATE it shows a read-only summary
  (customer name + phone, service + duration, long Arabic date, slot
  start/end, business timezone) plus the resulting appointment behavior
  derived from the Business's `confirmationMode` (server-passed prop —
  never client input). The PRIMARY action (تأكيد الحجز, in the wizard
  footer) calls the EXISTING `createAppointment` action — the canonical
  write path; the step itself imports no write path and no availability
  engine. While creating: duplicate submission is blocked (in-flight
  ref + disabled buttons), loading is announced (role=status /
  aria-live), and the summary stays visible. SUCCESS is rendered ONLY
  from the server-confirmed result: the created appointment's status
  through the canonical status badge, one obvious primary action
  (عرض الموعد → the existing `/appointments/[id]` detail page), and the
  wizard is cleared only after success is known (إنشاء موعد آخر).
  ERRORS are typed panels (role=alert): a `SLOT_CONFLICT` explains in
  Arabic that the time is no longer available and offers اختيار وقت
  آخر — which clears the stale slot through the wizard mechanism,
  returns to Step 4, and drops the cached availability query so the
  slot step refetches through the SAME `getAvailabilityAction`; every
  other failure is retryable without leaving the flow. No false
  success is ever displayed.
- **Wizard state** lives in `smart-create-appointment.tsx` only
  (`customerId`/`serviceId`/`date`/`selectedSlot` + current screen +
  the review-check state + the Step 6 submission state): moving back
  and forth never resets selections; each step's continue action stays
  disabled until its selection is valid; completed steps in the
  progress indicator are clickable for safe back-navigation
  (onboarding-wizard convention). Changing the service or the date
  CLEARS the slot selection (a slot is only valid for the inputs it
  was computed for); changing the customer does not (availability
  does not depend on the customer). Step 4 is SELECTION ONLY and
  Step 5 is REVIEW ONLY — no appointment is created from either; the
  `createAppointment` action (backed by the create service) remains
  the sole write path, consumed only by Step 6's primary action.

The interim manual time-entry details screen from PROMPT-11 was REMOVED
(superseded by Step 4) — the manual start-time entry is no longer part
of the Smart Create path. The flow completes end-to-end at Step 6: a verified
review hands off to the confirmation screen, which creates the appointment
through the canonical `createAppointment` write path and reports the
server-confirmed outcome (status badge + the appointment's detail page).

## B-07 — Appointment Creation + Scheduling UX

A UX layer over the SAME flow, availability layer, and write path (no
second booking subsystem; no schema/migration). Four capabilities:

**(A) Smart Context** — `/appointments/new` accepts `?customerId=` /
`?serviceId=` entry context. `resolveBookingContext` (booking-flow
service) resolves each id against the actor's OWN Business: a foreign,
unknown, or inactive id prefills NOTHING (the wizard asks for it
normally — cross-tenant ids are indistinguishable from missing ones);
`bookingContextSchema` strips every other key. `deriveInitialBookingScreen`
picks the opening screen: customer → الخدمة; customer + service →
التاريخ; a service alone never skips العميل (the customer is still
required). Entry points wired: the customer detail page (was a bare
`/appointments/new` link that forced a re-search — the duplicate
selection flow the product decision forbids), the conversation header
(the conversation's customer is known context), and each ACTIVE service
row (inactive services are not bookable, so the action is active-only).

**(B) Relative Scheduling** — Step 3 offers quick choices whose dates
the container computes from the server-derived business `today` through
the pure `resolveRelativeDate`: اليوم / غداً / هذا الأسبوع /
الأسبوع القادم / بعد أسبوع / بعد أسبوعين / بعد شهر, plus the existing
14-day strip and a native date input for anything else. Deterministic
semantics (documented in `date-format.ts`): this-week = the earliest day
of the current Sat–Fri business week strictly AFTER tomorrow (falling to
the next week's Saturday when the week has no such day left); next-week =
the next business week's Saturday; after-1-month = one calendar month
with month-end clamping (Jan 31 → Feb 28). The resolved date is always
rendered before booking, and NO availability is consulted in this step.

**(C) Availability-first** — Step 4 gained an «أقرب وقت متاح» one-tap
action that selects the FIRST server-provided slot (`earliestSlot`).
The availability contract returns slots ascending, so the first entry IS
the earliest valid time — nothing is invented, and the action is absent
when the day is full.

**(D) Follow-up** — after a SERVER-CONFIRMED creation, the confirmation
screen offers موعد متابعة at a relative offset measured from the
CREATED appointment's date (بعد أسبوع / بعد أسبوعين / بعد شهر /
اختيار تاريخ). The original slot's start time is re-verified against
the follow-up date through the SAME `getAvailabilityAction`; when it is
free the follow-up is created through the SAME `createAppointment`
action (one tap in the common case, chained follow-ups stay available,
and the result — including the status badge — comes only from the
server). When the time is NOT free, the follow-up is handed to the SAME
wizard (customer + service preserved, the resolved date applied, slot
cleared → slot step) so the user picks an available time instead of an
unavailable one ever being booked. A follow-up is an ORDINARY
appointment: no persisted linkage, no recurrence engine (explicitly out
of scope for B-07). «إنشاء موعد آخر» preserves the CUSTOMER (reopens on
the service step) rather than forcing re-selection.

**Rescheduling** already exists (the `rescheduleAppointment` action +
the detail-screen form — conflict-checked, tenant-scoped, status-guarded)
and is UNCHANGED by B-07. Availability-guided reschedule UX is deferred
to B-08: the appointment being rescheduled is itself a blocking row, so
its own current slot would render unavailable — guiding the user needs
an "exclude this appointment" parameter on the availability read, which
is a domain-layer change outside this slice.

**Verification** — `pnpm check:appointment-creation` (offline,
in-memory, no DB/network/LLM/secrets) exercises the whole B-07 layer
through the real services with fake repositories: the general creation
path, customer/service/conversation prefill (including cross-tenant
refusal), every relative date choice (with the end-of-week fallback and
custom-date passthrough), the earliest-slot path end-to-end, the
unavailable-slot rejection, the follow-up offsets (+1 week / +2 weeks /
+1 month with month-end clamping) and its conflict rejection, tenant
isolation, authorization rejection, structural no-DB-write assertions
over the new modules, and the intact booking invariants (server-derived
`endTime`, `confirmationMode`-derived status, active-service rule,
conflict check, honest success only).

## Availability semantics (PROMPT-10)

`getAvailability(deps, actor, input)` answers: "For this Business, on this
date, for this active Service, which start times are actually bookable?"

- **Business resolution**: the actor's own Business (ADMIN or STAFF); a
  client-provided `businessId` never overrides it.
- **Working hours**: the existing `Business.workingHours` JSON week (single
  open/close interval per weekday). Closed day (or missing/invalid entry) →
  zero slots with reason `BUSINESS_CLOSED`.
- **Service validation**: only active, non-deleted services of the actor's
  Business produce availability — inactive → `SERVICE_INACTIVE`,
  cross-Business/unknown/deleted → `SERVICE_NOT_FOUND`.
- **Slot generation**: candidates step from `open` by the Business's
  canonical `slotDurationMinutes` (onboarding step 3 setting — REUSED, no
  new setting). A candidate is valid only when the FULL
  `Service.durationMinutes` fits before `close` (17:30 for a 45-minute
  service in a 10:00–18:00 day is invalid — it ends 18:15).
- **Conflicts**: a slot must not overlap a blocking appointment — same
  business, same date, not soft-deleted, `PENDING`/`CONFIRMED` — the exact
  rule `AppointmentRepository.hasConflict` /
  `createWithConflictCheck` enforce for writes. Reads go through
  `AppointmentRepository.listBlockingForDate`; repositories remain the only
  Prisma consumers.
- **Timezone**: slots are business-local wall-clock "HH:mm" (the stored
  `@db.Time` semantics); the weekday is derived from the calendar date
  itself (timezone-independent). The Business's stored timezone travels in
  the result for display; the device timezone is never a source of truth.
- **Determinism**: no `Date.now()` in the calculation path — repeated calls
  with the same persisted state produce identical results.
- **Result contract**: `{success, data: {date, timezone, serviceId,
serviceDurationMinutes, slots}, reason}` — slots are `{startTime,
endTime}` "HH:mm" pairs; empty availability always carries an explicit
  reason (`BUSINESS_CLOSED` | `SERVICE_TOO_LONG` | `FULLY_BOOKED`); errors
  are typed codes with Arabic messages; no database internals leak into
  the shape.
- Repository collaborators are injectable (defaulting to the app
  singletons) so the workflow logic can be verified without a live
  database.
