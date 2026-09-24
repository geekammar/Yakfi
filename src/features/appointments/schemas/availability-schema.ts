import { appointmentDateSchema, uuidSchema } from "@/lib/validation";

import { z } from "zod";

/**
 * Availability request (PROMPT-10): the Business is NEVER part of the
 * client input — it is always the authenticated actor's own Business,
 * derived server-side (services/settings pattern). Zod strips every
 * other key, so a hostile `businessId` override never reaches the
 * workflow.
 *
 * `excludeAppointmentId` (B-08 — availability-guided reschedule): the
 * optional id of the appointment currently being rescheduled, so it
 * does not block its OWN slot in the offered availability. It is
 * re-resolved against the actor's OWN Business inside the availability
 * service before it has any effect (a foreign / missing / inactive id
 * is "unauthorized" and widens nothing) — a client id is never trusted
 * as authorization, exactly like `serviceId`.
 */
export const getAvailabilityInputSchema = z.object({
  date: appointmentDateSchema,
  serviceId: uuidSchema,
  excludeAppointmentId: uuidSchema.optional(),
});

export type GetAvailabilityInput = z.infer<typeof getAvailabilityInputSchema>;

/** "HH:mm" — shared wall-clock time format (kept for local typing). */
export type WallClock = string;
