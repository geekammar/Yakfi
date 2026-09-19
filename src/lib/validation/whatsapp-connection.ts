import { phoneSchema, uuidSchema } from "./common";
import { z } from "zod";

/**
 * WhatsAppConnection validation (DECISIONS #31, PROMPT-ARCH-02).
 *
 * The Business owns its WhatsApp identity: `businessId` is required,
 * `branchId` is optional (a future Business-shared connection stays
 * possible). Everything here is provider-neutral — no vendor codes, no
 * raw credentials: `credentialsRef` is a REFERENCE to a secret (env
 * var name / secret-store pointer), never the secret itself.
 */

/** Stable machine keys — no Prisma enum, extending needs no migration. */
export const whatsappConnectionStatusValues = [
  "PENDING",
  "CONNECTED",
  "DISCONNECTED",
] as const;

export const whatsappConnectionStatusSchema = z.enum(
  whatsappConnectionStatusValues,
);

export const WHATSAPP_CONNECTION_STATUSES = {
  PENDING: "PENDING",
  CONNECTED: "CONNECTED",
  DISCONNECTED: "DISCONNECTED",
} as const;

const createWhatsAppConnectionSchema = z.object({
  businessId: uuidSchema,
  /** Optional Branch scope (null = Business-shared). */
  branchId: uuidSchema.nullish(),
  displayName: z.string().trim().min(1).max(120).optional(),
  phoneNumber: phoneSchema,
  /** Provider machine key — only when a provider decision exists. */
  provider: z.string().trim().min(1).max(64).optional(),
  /** Provider's own connection/WABA id — provider-neutral passthrough. */
  externalId: z.string().trim().min(1).max(256).optional(),
  status: whatsappConnectionStatusSchema.default("PENDING"),
  /** REFERENCE to stored credentials — never raw secrets. */
  credentialsRef: z.string().trim().min(1).max(512).optional(),
});

const updateWhatsAppConnectionSchema = z
  .object({
    branchId: uuidSchema.nullish(),
    displayName: z.string().trim().min(1).max(120).nullish(),
    // Non-nullable column: optional (skip) but never null.
    phoneNumber: phoneSchema.optional(),
    provider: z.string().trim().min(1).max(64).nullish(),
    externalId: z.string().trim().min(1).max(256).nullish(),
    status: whatsappConnectionStatusSchema,
    credentialsRef: z.string().trim().min(1).max(512).nullish(),
    isActive: z.boolean(),
  })
  .partial();

export type CreateWhatsAppConnectionDto = z.infer<
  typeof createWhatsAppConnectionSchema
>;
export type UpdateWhatsAppConnectionDto = z.infer<
  typeof updateWhatsAppConnectionSchema
>;

export const whatsappConnectionValidation = {
  create: createWhatsAppConnectionSchema,
  update: updateWhatsAppConnectionSchema,
} as const;
