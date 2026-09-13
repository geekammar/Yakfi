import { emailSchema, uuidSchema } from "./common";
import { z } from "zod";

export const userRoleValues = ["ADMIN", "STAFF"] as const;

/**
 * Account scope (DECISIONS #22, PROMPT-ARCH-02): the explicit
 * platform-level authorization marker. "BUSINESS" is the default (and
 * the only value any invitation/auth flow creates); "PLATFORM" marks a
 * Platform Operator — a platform-level identity that is NOT a Business
 * User and NOT a `UserRole`. Server-managed only (Better Auth
 * `input: false` + no client DTO carries it); platform access is never
 * inferred from `businessId = null`.
 */
export const accountTypeValues = ["PLATFORM", "BUSINESS"] as const;

export const accountTypeSchema = z.enum(accountTypeValues);

const createUserSchema = z.object({
  businessId: uuidSchema,
  name: z.string().trim().min(2, "الاسم قصير جداً").max(120),
  email: emailSchema,
  role: z.enum(userRoleValues).default("STAFF"),
});

const updateUserSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    role: z.enum(userRoleValues),
    isActive: z.boolean(),
  })
  .partial();

const listUsersSchema = z.object({
  businessId: uuidSchema,
  role: z.enum(userRoleValues).optional(),
});

export type CreateUserDto = z.infer<typeof createUserSchema>;
export type UpdateUserDto = z.infer<typeof updateUserSchema>;
export type ListUsersDto = z.infer<typeof listUsersSchema>;

/**
 * Note: user creation (credentials) is owned by Better Auth.
 * These schemas govern FlowPilot domain data on the shared `users` table.
 */
export const userValidation = {
  create: createUserSchema,
  update: updateUserSchema,
  listByBusiness: listUsersSchema,
} as const;
