import { uuidSchema } from "@/lib/validation";

import { z } from "zod";

/**
 * Smart Create Appointment flow inputs (PROMPT-11 + PROMPT-12 +
 * B-07 smart context).
 *
 * The search input carries ONLY the free-text query — Zod strips every
 * other key, so a hostile `businessId`/`role`/identity override can
 * never reach the workflow (the Business is always the actor's own,
 * derived server-side). Step 4 (slot selection) consumes the existing
 * `getAvailabilityInputSchema` (`{date, serviceId}` only) — it has no
 * separate schema here.
 *
 * The context input (B-07 §A) carries ONLY optional entry ids: a
 * `customerId` (from a customer page or a conversation) and/or a
 * `serviceId` (from a service page). They are NEVER trusted —
 * `resolveBookingContext` re-checks each one against the actor's own
 * Business before anything is prefilled, and every other key
 * (`businessId`, `role`, `status`…) is stripped here.
 */
export const bookingCustomerSearchSchema = z.object({
  query: z.string().trim().max(100, "نص البحث طويل جداً"),
});

export const bookingContextSchema = z.object({
  customerId: uuidSchema.optional(),
  serviceId: uuidSchema.optional(),
  providerId: uuidSchema.optional(),
  followUpId: uuidSchema.optional(),
});

export type BookingCustomerSearchInput = z.infer<
  typeof bookingCustomerSearchSchema
>;
export type BookingContextInput = z.infer<typeof bookingContextSchema>;
