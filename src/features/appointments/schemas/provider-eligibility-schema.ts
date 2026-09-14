import { uuidSchema } from "@/lib/validation";

import { z } from "zod";

/**
 * Provider / Service eligibility request (PROMPT-CORE-01): the Business
 * is NEVER part of the client input — it is always the authenticated
 * actor's own Business, derived server-side (availability pattern).
 * Zod strips every other key, so a hostile `businessId` / `role` /
 * `accountType` override never reaches the resolver.
 */
export const resolveEligibleProvidersInputSchema = z.object({
  serviceId: uuidSchema,
  branchId: uuidSchema.optional(),
});

export type ResolveEligibleProvidersInput = z.infer<
  typeof resolveEligibleProvidersInputSchema
>;
