import { externalHandleSchema, uuidSchema } from "./common";
import {
  credentialKindSchema,
  credentialRuntimeReferenceSchema,
} from "./whatsapp-connection";
import { z } from "zod";

/**
 * TelegramConnection validation (DECISIONS #63/#64 — the second channel).
 *
 * Telegram is a transport SIBLING of WhatsApp, not a second product: the
 * Business owns its Telegram identity (`businessId` required, `branchId`
 * optional — a Business-shared connection stays possible), everything
 * here is provider-neutral, and `credentialsRef` is a REFERENCE to the
 * managed bot's token (an opaque `fp:<id>` RUNTIME handle) — NEVER the
 * raw token. The customer never pastes a token and never visits
 * BotFather; provisioning is via Telegram Managed Bots.
 */

/** The single approved Telegram provisioning model (machine key). */
export const TELEGRAM_PROVIDER = "telegram_managed" as const;

/** Stable machine keys — no Prisma enum, extending needs no migration. */
export const telegramConnectionStatusValues = [
  "PENDING",
  "CONNECTED",
  "DISCONNECTED",
] as const;

export const telegramConnectionStatusSchema = z.enum(
  telegramConnectionStatusValues,
);

export const TELEGRAM_CONNECTION_STATUSES = {
  PENDING: "PENDING",
  CONNECTED: "CONNECTED",
  DISCONNECTED: "DISCONNECTED",
} as const;

/**
 * The SEPARATE onboarding lifecycle — exactly like the WhatsApp
 * connection's. Never consumed by the operational runtime gate
 * (`status`/`isActive`); it tracks the managed-bot provisioning flow
 * only: not started → waiting on the Admin's Telegram-side confirmation
 * → ready / needs action / failed.
 */
export const telegramOnboardingStateValues = [
  "NOT_STARTED",
  "PROVISIONING",
  "ACTION_REQUIRED",
  "READY",
  "FAILED",
] as const;

export const telegramOnboardingStateSchema = z.enum(
  telegramOnboardingStateValues,
);

export type TelegramOnboardingState =
  (typeof telegramOnboardingStateValues)[number];

export const TELEGRAM_ONBOARDING_STATES = {
  NOT_STARTED: "NOT_STARTED",
  PROVISIONING: "PROVISIONING",
  ACTION_REQUIRED: "ACTION_REQUIRED",
  READY: "READY",
  FAILED: "FAILED",
} as const;

/** Who moved the onboarding lifecycle last (audit actor, never authority). */
export const telegramOnboardingActorValues = [
  "CUSTOMER",
  "TELEGRAM",
  "FLOWPILOT",
  "NONE",
] as const;

export const telegramOnboardingActorSchema = z.enum(
  telegramOnboardingActorValues,
);

export type TelegramOnboardingActor =
  (typeof telegramOnboardingActorValues)[number];

/**
 * The opaque single-use provisioning start token — the ONLY thing the
 * customer-facing deep link (`https://t.me/<manager>?start=<token>`)
 * carries. Unguessable; the raw value is persisted exactly once as the
 * unique lookup key on the provisioning ledger and is consumed exactly
 * once. url-safe, no meaningful length cost.
 */
export const telegramStartTokenSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{16,128}$/, "رمز بدء ترقية غير صالح");

/**
 * A Telegram bot/chat external identity: a numeric id in string form (a
 * chat id is an Integer, never a phone number). The transport envelope's
 * `externalHandleSchema` accepts it as the provider-neutral customer
 * handle; this schema is the adapter-side validation of the bot id that
 * a `getMe` / `managed_bot` event reported.
 */
export const telegramBotIdSchema = z
  .string()
  .trim()
  .regex(/^[0-9]{1,20}$/, "معرّف بوت غير صالح");

/** A Telegram @username (non-secret label), with or without the @. */
export const telegramUsernameSchema = z
  .string()
  .trim()
  .regex(/^@?[A-Za-z0-9_]{4,32}$/, "اسم مستخدم غير صالح");

const createTelegramConnectionSchema = z.object({
  businessId: uuidSchema,
  /** Optional Branch scope (null = Business-shared). */
  branchId: uuidSchema.nullish(),
  displayName: z.string().trim().min(1).max(120).optional(),
  /** The managed bot's stable Telegram identity — authoritative. */
  botExternalId: telegramBotIdSchema,
  botUsername: telegramUsernameSchema.optional(),
  /** Provider machine key — only "telegram_managed" is supported. */
  provider: z.literal(TELEGRAM_PROVIDER).default(TELEGRAM_PROVIDER),
  status: telegramConnectionStatusSchema.default("PENDING"),
  /** REFERENCE to the managed bot token (`fp:<id>` RUNTIME handle) — never the raw token. */
  credentialsRef: credentialRuntimeReferenceSchema.optional(),
  credentialKind: credentialKindSchema.default("RUNTIME"),
  /**
   * NON-SECRET SHA-256 hex digest of the webhook `secret_token` — the
   * inbound routing index. Written only at provisioning completion; the
   * plaintext is handed to Telegram once via `setWebhook` and never
   * persisted.
   */
  webhookSecretHash: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{64}$/, "ملخّص سر الويبهوك غير صالح")
    .optional(),
  isActive: z.boolean().default(true),
  onboardingState: telegramOnboardingStateSchema.default("NOT_STARTED"),
  onboardingActor: telegramOnboardingActorSchema.default("NONE"),
  managerBotId: telegramBotIdSchema.optional(),
  creatorTelegramUserId: telegramBotIdSchema.optional(),
});

const updateTelegramConnectionSchema = z
  .object({
    branchId: uuidSchema.nullish(),
    displayName: z.string().trim().min(1).max(120).nullish(),
    botUsername: telegramUsernameSchema.nullish(),
    status: telegramConnectionStatusSchema,
    credentialsRef: credentialRuntimeReferenceSchema.nullish(),
    credentialKind: credentialKindSchema,
    webhookSecretHash: z
      .string()
      .trim()
      .regex(/^[0-9a-f]{64}$/, "ملخّص سر الويبهوك غير صالح")
      .nullish(),
    isActive: z.boolean(),
    onboardingState: telegramOnboardingStateSchema,
    onboardingActor: telegramOnboardingActorSchema,
    onboardingReasonCode: z.string().trim().min(1).max(128).nullish(),
    onboardingReasonSummary: z.string().trim().min(1).max(512).nullish(),
    onboardingRetryable: z.boolean().nullish(),
    onboardingStateChangedAt: z.date().nullish(),
    onboardingCompletedAt: z.date().nullish(),
    onboardingFailedAt: z.date().nullish(),
    managerBotId: telegramBotIdSchema.nullish(),
    creatorTelegramUserId: telegramBotIdSchema.nullish(),
  })
  .partial();

export type CreateTelegramConnectionDto = z.infer<
  typeof createTelegramConnectionSchema
>;
export type UpdateTelegramConnectionDto = z.infer<
  typeof updateTelegramConnectionSchema
>;

export const telegramConnectionValidation = {
  create: createTelegramConnectionSchema,
  update: updateTelegramConnectionSchema,
} as const;

/**
 * The provider-neutral inbound customer handle for the Telegram path: a
 * private-chat Telegram chat id (which equals the user id) as a string.
 * The Conversation Engine consumes this through `externalHandleSchema`
 * and stores it on `Customer.phone` as the raw handle digits — exactly
 * the WhatsApp path's contract, with no channel logic in the engine
 * (DECISIONS #64).
 */
export function telegramChatIdToExternalHandle(
  chatId: string | number,
): string {
  return String(chatId);
}

export { externalHandleSchema };
