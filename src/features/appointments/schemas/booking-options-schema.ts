import { appointmentDateSchema, uuidSchema } from "@/lib/validation";

import { z } from "zod";

/**
 * Booking Options request (PROMPT-CORE-02): the Business is NEVER part
 * of the client input — it is always the authenticated actor's own
 * Business, derived server-side (availability/eligibility pattern).
 * Zod strips every other key, so a hostile `businessId` / `role` /
 * `accountType` override never reaches the resolver. The date is the
 * already-normalized structured preference the current Availability
 * layer supports (no natural-language parsing here). An absent
 * `providerId` means the Any-Provider preference; a present one is a
 * Provider preference verified against CORE-01 eligibility.
 */
export const resolveBookingOptionsInputSchema = z.object({
  serviceId: uuidSchema,
  branchId: uuidSchema.optional(),
  providerId: uuidSchema.optional(),
  date: appointmentDateSchema,
});

export type ResolveBookingOptionsInput = z.infer<
  typeof resolveBookingOptionsInputSchema
>;
