# Feature: settings

Business Settings (operator PROMPT-09): how the business operates —
identity (بيانات المنشأة) and booking behavior (إعدادات الحجز). Generic and
vertical-agnostic; the vertical field is discovery metadata only.

## Isolation rules

- Everything feature-specific lives in this folder: components, schemas,
  server actions, and the workflow.
- This feature may import from `@/components/ui`, `@/components/shared`,
  `@/lib/*`, `@/server/repositories`, `@/types`, and its own files — never
  from another feature folder.
- Cross-feature composition happens at the route layer (`src/app`), not
  here.
- No circular dependencies. Shared logic is promoted to `@/lib` or
  `@/server` deliberately (e.g. `TIMEZONES` was promoted to
  `@/lib/validation` in PROMPT-09 because both onboarding and settings
  need the same list).

## Structure

- `schemas/settings-schema.ts` — form-level Zod input (name, vertical,
  city, WhatsApp number, timezone, confirmation mode, cancellation
  policy) with Arabic messages; the client NEVER sends a `businessId`,
  role, or account-state field — Zod strips every unknown key.
- `server/settings-service.ts` — read/update workflow with the
  authorization rules inside: ADMIN-only, the target Business is always
  the actor's own (derived from the trusted session → user record).
  Repository collaborators are injectable so the logic is verifiable
  without a live database.
- `actions/settings-actions.ts` — thin `"use server"` wrapper: builds the
  actor from the authenticated session + DB user, runs the update,
  revalidates `/settings`, `/` and `/appointments`.
- `components/settings-screen.tsx` — the settings screen: two sections
  (بيانات المنشأة / إعدادات الحجز) in ONE form with one primary save
  action, prefilled current values, inline Arabic validation, and visible
  save success/failure states.

## Consumed elsewhere

- `Business.confirmationMode` (schema, PROMPT-09) drives the initial
  status of newly created appointments in the appointments feature:
  `automatic` → `CONFIRMED`, `manual` (default) → `PENDING`. The status
  is derived server-side from the Business record, never client input.
- `Business.slotDurationMinutes` (UX001-R3) drives the candidate appointment
  start-time interval offered to customers and staff across booking surfaces
  (`generateCandidateSlots` / `generateCandidateGrid`). Allowed intervals:
  `[15, 20, 30, 45, 60, 90, 120]` minutes. This setting is strictly independent
  of service duration (`Service.durationMinutes`) and historical appointments.

## Out of scope (documented follow-ups)

- Working-hours editing (onboarding step 2 owns the wizard; a settings
  surface for hours is a follow-up slice).
- Business account activate/deactivate (Spec A §3 — deliberate separate
  action with its own guardrails).

## Related surfaces

- Business knowledge lives at `/settings/knowledge` as its own feature
  (`src/features/knowledge`, PROMPT-18) — this screen links to it (a
  URL link, not a feature import); it is not part of the settings form.
