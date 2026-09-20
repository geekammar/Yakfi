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

/**
 * The SEPARATE onboarding lifecycle (WHATSAPP-ONBOARDING-01). Never
 * consumed by the operational runtime gate (`status`/`isActive`) — it
 * tracks the Business Admin's provider authorization → provisioning →
 * readiness flow only.
 */
export const whatsappOnboardingStateValues = [
  "NOT_STARTED",
  "AUTHORIZING",
  "PROVISIONING",
  "ACTION_REQUIRED",
  "READY",
  "FAILED",
] as const;

export const whatsappOnboardingStateSchema = z.enum(
  whatsappOnboardingStateValues,
);

export type WhatsAppOnboardingState =
  (typeof whatsappOnboardingStateValues)[number];

export const WHATSAPP_ONBOARDING_STATES = {
  NOT_STARTED: "NOT_STARTED",
  AUTHORIZING: "AUTHORIZING",
  PROVISIONING: "PROVISIONING",
  ACTION_REQUIRED: "ACTION_REQUIRED",
  READY: "READY",
  FAILED: "FAILED",
} as const;

/** Who moved the onboarding lifecycle last (audit actor, never authority). */
export const whatsappOnboardingActorValues = [
  "CUSTOMER",
  "META",
  "FLOWPILOT",
  "NONE",
] as const;

export const whatsappOnboardingActorSchema = z.enum(
  whatsappOnboardingActorValues,
);

export type WhatsAppOnboardingActor =
  (typeof whatsappOnboardingActorValues)[number];

/**
 * The grammar of a `credentialsRef` VALUE. `credentialsRef` itself stays
 * a REFERENCE — this records which reference kind it is. Legacy rows
 * (and any ENV-shaped reference) are ENV; an opaque `fp:<id>` handle is
 * RUNTIME (the runtime secret backend is deferred).
 */
export const credentialKindValues = ["ENV", "RUNTIME"] as const;

export const credentialKindSchema = z.enum(credentialKindValues);

export type CredentialKind = (typeof credentialKindValues)[number];

/**
 * An ENV-var NAME — the existing production reference grammar. A raw
 * token shape (mixed case / long blob) is rejected here so a pasted
 * access token can never reach the column.
 */
export const credentialEnvVarNameSchema = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9_]{2,63}$/, "اسم متغيّر البيئة غير صالح");

/** The opaque RUNTIME reference handle shape (`fp:<random-id>`). */
export const CREDENTIAL_RUNTIME_REFERENCE_PREFIX = "fp:";

export const credentialRuntimeReferenceSchema = z
  .string()
  .trim()
  .regex(/^fp:[A-Za-z0-9_-]{8,128}$/, "مرجع بيانات اعتماد غير صالح");

/** Is this reference an opaque RUNTIME handle (`fp:<random-id>`)? */
export function isRuntimeCredentialReference(reference: string): boolean {
  return credentialRuntimeReferenceSchema.safeParse(reference).success;
}

/** Is this reference an ENV-var NAME (the existing grammar)? */
export function isEnvCredentialReference(reference: string): boolean {
  return credentialEnvVarNameSchema.safeParse(reference).success;
}

/** Normalized onboarding failure categories (provider-neutral). */
export const whatsappOnboardingFailureCategoryValues = [
  "AUTHORIZATION",
  "PROVISIONING",
  "VERIFICATION",
  "PROVIDER_REVIEW",
  "CONFIGURATION",
] as const;

export const whatsappOnboardingFailureCategorySchema = z.enum(
  whatsappOnboardingFailureCategoryValues,
);

export type WhatsAppOnboardingFailureCategory =
  (typeof whatsappOnboardingFailureCategoryValues)[number];

/** Meta provenance keys the onboarding flow is allowed to persist. */
export const META_PROVENANCE_KEYS = [
  "meta_business_id",
  "waba_id",
  "meta_review_status",
] as const;

export type MetaProvenanceKey = (typeof META_PROVENANCE_KEYS)[number];

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
  // Onboarding lifecycle defaults: a freshly created connection has not
  // started the provider authorization flow (existing callers are
  // unchanged — NOT_STARTED / NONE is the honest initial state).
  onboardingState: whatsappOnboardingStateSchema.default("NOT_STARTED"),
  onboardingActor: whatsappOnboardingActorSchema.default("NONE"),
  credentialKind: credentialKindSchema.optional(),
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
    // Onboarding lifecycle (all optional — the onboarding service owns
    // these writes; the generic update path never sets them).
    onboardingState: whatsappOnboardingStateSchema,
    onboardingActor: whatsappOnboardingActorSchema,
    onboardingReasonCode: z.string().trim().min(1).max(128).nullish(),
    onboardingReasonSummary: z.string().trim().min(1).max(512).nullish(),
    onboardingRetryable: z.boolean().nullish(),
    onboardingStateChangedAt: z.date().nullish(),
    onboardingCompletedAt: z.date().nullish(),
    onboardingFailedAt: z.date().nullish(),
    credentialKind: credentialKindSchema,
    metaBusinessId: z.string().trim().min(1).max(256).nullish(),
    wabaId: z.string().trim().min(1).max(256).nullish(),
    displayPhoneNumber: z.string().trim().min(1).max(64).nullish(),
    verifiedName: z.string().trim().min(1).max(256).nullish(),
    metaReviewStatus: z.string().trim().min(1).max(128).nullish(),
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
