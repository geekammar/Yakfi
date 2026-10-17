import { uuidSchema } from "@/lib/validation";

import { z } from "zod";

/**
 * Team management input schemas (PROMPT-16). The client may supply
 * ONLY the target member id and the desired active state — the
 * Business comes from the authenticated actor (server-side), never
 * from client input.
 */

export const setTeamMemberActiveSchema = z.object({
  memberId: uuidSchema,
  isActive: z.boolean(),
});

export type SetTeamMemberActiveInput = z.infer<
  typeof setTeamMemberActiveSchema
>;

export const createProviderSchema = z.object({
  name: z.string().trim().min(1, "اسم مقدم الخدمة مطلوب").max(100),
  displayName: z.string().trim().max(100).optional().nullable(),
  isActive: z.boolean().default(true),
  servicePolicy: z
    .enum(["ALL_SERVICES", "SPECIFIC_SERVICES"])
    .default("ALL_SERVICES"),
  excludedServiceIds: z.array(uuidSchema).optional(),
  branchId: uuidSchema.optional().nullable(),
  userId: uuidSchema.optional().nullable(),
});

export type CreateProviderInput = z.infer<typeof createProviderSchema>;

export const updateProviderSchema = z.object({
  providerId: uuidSchema,
  name: z.string().trim().min(1, "اسم مقدم الخدمة مطلوب").max(100).optional(),
  displayName: z.string().trim().max(100).optional().nullable(),
  isActive: z.boolean().optional(),
  servicePolicy: z.enum(["ALL_SERVICES", "SPECIFIC_SERVICES"]).optional(),
  excludedServiceIds: z.array(uuidSchema).optional(),
  branchId: uuidSchema.optional().nullable(),
  userId: uuidSchema.optional().nullable(),
});

export type UpdateProviderInput = z.infer<typeof updateProviderSchema>;

export const toggleProviderActiveSchema = z.object({
  providerId: uuidSchema,
  isActive: z.boolean(),
});

export type ToggleProviderActiveInput = z.infer<
  typeof toggleProviderActiveSchema
>;
