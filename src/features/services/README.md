# Feature: services

Catalog of bookable service offerings (generic, no vertical-specific terminology).

## Isolation rules

- Everything feature-specific lives in this folder: components, hooks,
  schemas, server actions/queries, and API clients.
- This feature may import from `@/components/ui`, `@/lib/*`, `@/server/db`,
  `@/types`, and its own files — never from another feature folder.
- Cross-feature composition happens at the route layer (`src/app`), not here.
- No circular dependencies. If two features need shared logic, promote it to
  `@/lib` or `@/server` deliberately.
- Keep files small and single-purpose; no giant shared barrels.

## Structure

- `schemas/service-schema.ts` — form-level Zod input (name, optional
  description, duration minutes) derived from the shared
  `@/lib/validation` service contract; the client NEVER sends a
  `businessId`. Also `removeServiceSchema` (id-only) and
  `serviceIdentityKey` (trimmed name) for the duplicate guard.
- `server/service-service.ts` — management workflow (list / create /
  update / activate / deactivate / remove) with the authorization rules
  inside: ADMIN-only, tenant-scoped to the actor's Business,
  cross-Business service ids rejected as not-found, duplicate catalog
  names rejected, removal a soft delete. Repository collaborators are
  injectable so the logic is verifiable without a live database.
- `actions/service-actions.ts` — thin `"use server"` wrappers: build the
  actor from the authenticated session + DB user, run the service
  operation, revalidate `/services` and `/appointments/new`.
- `components/services-screen.tsx` — list screen (cards with name,
  description, duration, active badge), empty state, primary action
  (إضافة خدمة), optimistic activate/deactivate with rollback, confirmed
  removal.
- `components/service-form-dialog.tsx` — small create/edit dialog
  (same form, prefilled for edit).
- `components/service-remove-dialog.tsx` — destructive-action
  confirmation (the established knowledge-remove pattern) so a mis-tap
  on mobile never removes a service silently.

## Semantics

- Active/inactive is `Service.isActive`; inactive services are excluded
  from booking selection paths (the appointment form options list
  active services only, and `createAppointment` re-checks `isActive`).
- Removal is a SOFT DELETE (`deletedAt` + `isActive: false`), never a
  hard row delete: `Appointment.service` is `onDelete: Restrict`, so
  the row is the integrity anchor of past appointments (their service
  name/duration stay readable on history) while it stops being
  catalog/bookable. Removed names are free again for re-creation.
- Duplicate live names are rejected at the service layer
  (check-then-create): the deterministic booking matcher would
  otherwise see an ambiguous service, so this is a real conflict, not
  a storage constraint.
- The Service Catalog is canonical domain data, NOT a second Knowledge
  Base. `name`/`description` are customer-facing under the B-01 policy
  and reach the AI only through the B-02 context builder;
  `durationMinutes` is an INTERNAL operational scheduling fact the
  owner manages here but the assistant never repeats (B-03).
- No pricing, packages, staff assignment, or vertical metadata — Spec A
  scope.
