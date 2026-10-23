/**
 * Durable booking offers (CONV-CORE-01).
 *
 * An OFFER is the exact, numbered list of choices the engine showed the
 * customer (a service list or a slot list). Before this slice the only record
 * of an offer was its rendered Arabic copy, which `booking-selection.ts`
 * regex-parsed back on the next turn — so a copy edit, a Copy-Lab override, or
 * a re-rendered list could silently change what "1" meant.
 *
 * Now every NEW offer is a typed, Zod-validated snapshot that is:
 * - scoped by business + conversation (validated on every load),
 * - bound to an opaque `token` that Telegram callbacks carry,
 * - stored with the real ids (serviceId / providerId / startAt / endAt),
 * - expired explicitly (CONSUMED / REPLACED / INVALIDATED) or by TTL.
 *
 * The snapshot is a cached PRESENTATION, never booking truth: the engine still
 * re-runs CORE-01 + CORE-02 and `createWithConflictCheck` before any write.
 *
 * Pure module: no I/O, no clock reads except through explicit `now` params.
 */
import {
  canonicalTimePreferenceSchema,
  type CanonicalTimePreference,
} from "@/lib/validation";

import { z } from "zod";

/** Offers older than this are expired even if never consumed. */
export const BOOKING_OFFER_TTL_MS = 12 * 60 * 60 * 1000;
/** Upper bound on stored options (keeps the snapshot small). */
export const MAX_OFFER_OPTIONS = 99;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
const shortText = z.string().trim().min(1).max(200);

export const offerStatusValues = [
  "ACTIVE",
  /** Atomically claimed by a booking attempt in flight. */
  "CLAIMED",
  /** A booking was written from it. */
  "CONSUMED",
  /** A newer offer superseded it. */
  "REPLACED",
  /** A dependency (service/date/provider) changed, or staff took over. */
  "INVALIDATED",
] as const;
export type OfferStatus = (typeof offerStatusValues)[number];

export const welcomeOfferOptionSchema = z.object({
  index: z.number().int().min(1).max(MAX_OFFER_OPTIONS),
  action: z.enum(["book", "inquire"]),
  label: shortText,
});

export const serviceOfferOptionSchema = z.object({
  index: z.number().int().min(1).max(MAX_OFFER_OPTIONS),
  serviceId: shortText,
  name: shortText,
});

export const serviceDetailOptionSchema = z.object({
  index: z.number().int().min(1).max(MAX_OFFER_OPTIONS),
  action: z.enum(["book_service", "other_services", "menu"]),
  label: shortText,
});

export const dateOfferOptionSchema = z.object({
  index: z.number().int().min(1).max(MAX_OFFER_OPTIONS),
  date: isoDate,
  label: shortText,
});

export const providerOfferOptionSchema = z.object({
  index: z.number().int().min(1).max(MAX_OFFER_OPTIONS),
  providerId: shortText.nullable(),
  name: shortText,
});

export const slotOfferOptionSchema = z.object({
  index: z.number().int().min(1).max(MAX_OFFER_OPTIONS),
  providerId: shortText,
  displayName: shortText,
  startAt: localDateTime,
  endAt: localDateTime,
});

const offerBase = {
  id: shortText,
  /** Short opaque token carried by Telegram callback data. */
  token: z.string().regex(/^[a-z0-9]{6,12}$/),
  businessId: shortText,
  conversationId: shortText,
  status: z.enum(offerStatusValues),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
};

export const welcomeOfferSchema = z.object({
  ...offerBase,
  kind: z.literal("WELCOME"),
  options: z.array(welcomeOfferOptionSchema).min(1).max(MAX_OFFER_OPTIONS),
});

export const serviceOfferSchema = z.object({
  ...offerBase,
  kind: z.literal("SERVICE"),
  purpose: z.enum(["BOOKING", "INQUIRY"]).default("BOOKING"),
  options: z.array(serviceOfferOptionSchema).min(1).max(MAX_OFFER_OPTIONS),
});

export const serviceDetailOfferSchema = z.object({
  ...offerBase,
  kind: z.literal("SERVICE_DETAIL"),
  serviceId: shortText,
  serviceName: shortText,
  options: z.array(serviceDetailOptionSchema).min(1).max(MAX_OFFER_OPTIONS),
});

export const dateOfferSchema = z.object({
  ...offerBase,
  kind: z.literal("DATE"),
  serviceId: shortText,
  serviceName: shortText,
  providerId: shortText.nullable(),
  options: z.array(dateOfferOptionSchema).min(1).max(MAX_OFFER_OPTIONS),
});

export const providerOfferSchema = z.object({
  ...offerBase,
  kind: z.literal("PROVIDER"),
  serviceId: shortText,
  serviceName: shortText,
  date: isoDate.nullable(),
  options: z.array(providerOfferOptionSchema).min(1).max(MAX_OFFER_OPTIONS),
});

export const slotOfferSchema = z.object({
  ...offerBase,
  kind: z.literal("SLOT"),
  serviceId: shortText,
  serviceName: shortText,
  serviceSource: z.enum(["CUSTOMER", "DEFAULT"]),
  providerId: shortText.nullable(),
  timePreference: canonicalTimePreferenceSchema.nullable().optional(),
  date: isoDate,
  followUpRequestId: shortText.nullable(),
  /** How many fresh options were presented across "more times" batches. */
  shownCount: z.number().int().min(0).max(500),
  options: z.array(slotOfferOptionSchema).min(1).max(MAX_OFFER_OPTIONS),
});

export const bookingOfferSchema = z.discriminatedUnion("kind", [
  welcomeOfferSchema,
  serviceOfferSchema,
  serviceDetailOfferSchema,
  dateOfferSchema,
  providerOfferSchema,
  slotOfferSchema,
]);

export type WelcomeOffer = z.infer<typeof welcomeOfferSchema>;
export type ServiceOffer = z.infer<typeof serviceOfferSchema>;
export type ServiceDetailOffer = z.infer<typeof serviceDetailOfferSchema>;
export type DateOffer = z.infer<typeof dateOfferSchema>;
export type ProviderOffer = z.infer<typeof providerOfferSchema>;
export type SlotOffer = z.infer<typeof slotOfferSchema>;
export type BookingOffer = z.infer<typeof bookingOfferSchema>;

/** Is the offer still selectable right now? */
export function isOfferLive(offer: BookingOffer | null, now: Date): boolean {
  if (!offer) return false;
  if (offer.status !== "ACTIVE") return false;
  return Date.parse(offer.expiresAt) > now.getTime();
}

/** Opaque short token from a random id (lowercase alnum, 8 chars). */
export function offerTokenFromId(id: string): string {
  const alnum = id.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (alnum.slice(0, 8) || "offer000").padEnd(8, "0");
}

type OfferScope = {
  readonly businessId: string;
  readonly conversationId: string;
};

function offerEnvelope(scope: OfferScope, id: string, now: Date) {
  return {
    id,
    token: offerTokenFromId(id),
    businessId: scope.businessId,
    conversationId: scope.conversationId,
    status: "ACTIVE" as const,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + BOOKING_OFFER_TTL_MS).toISOString(),
  };
}

/** Build a validated welcome offer for initial customer choices. */
export function buildWelcomeOffer(
  scope: OfferScope,
  id: string,
  now: Date,
): WelcomeOffer | null {
  const candidate = {
    ...offerEnvelope(scope, id, now),
    kind: "WELCOME" as const,
    options: [
      { index: 1, action: "book" as const, label: "حجز موعد" },
      { index: 2, action: "inquire" as const, label: "استفسار عن خدمة" },
    ],
  };
  const parsed = welcomeOfferSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** Build a validated service-list offer (indices 1..n, in shown order). */
export function buildServiceOffer(
  scope: OfferScope,
  id: string,
  services: ReadonlyArray<{ id: string; name: string }>,
  now: Date,
  purpose: "BOOKING" | "INQUIRY" = "BOOKING",
): ServiceOffer | null {
  const candidate = {
    ...offerEnvelope(scope, id, now),
    kind: "SERVICE" as const,
    purpose,
    options: services.slice(0, MAX_OFFER_OPTIONS).map((service, i) => ({
      index: i + 1,
      serviceId: service.id,
      name: service.name,
    })),
  };
  const parsed = serviceOfferSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** Build a validated service-detail action offer (explicit book / continue inquiry). */
export function buildServiceDetailOffer(
  scope: OfferScope,
  id: string,
  serviceId: string,
  serviceName: string,
  now: Date,
): ServiceDetailOffer | null {
  const candidate = {
    ...offerEnvelope(scope, id, now),
    kind: "SERVICE_DETAIL" as const,
    serviceId,
    serviceName,
    options: [
      { index: 1, action: "book_service" as const, label: "حجز هذه الخدمة" },
      { index: 2, action: "other_services" as const, label: "خدمة أخرى" },
      { index: 3, action: "menu" as const, label: "القائمة الرئيسية" },
    ],
  };
  const parsed = serviceDetailOfferSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** Build a validated date selection offer from sensible upcoming dates. */
export function buildDateOffer(
  scope: OfferScope,
  id: string,
  input: {
    serviceId: string;
    serviceName: string;
    providerId: string | null;
    dates: ReadonlyArray<{ date: string; label: string }>;
  },
  now: Date,
): DateOffer | null {
  const candidate = {
    ...offerEnvelope(scope, id, now),
    kind: "DATE" as const,
    serviceId: input.serviceId,
    serviceName: input.serviceName,
    providerId: input.providerId,
    options: input.dates.slice(0, MAX_OFFER_OPTIONS).map((d, i) => ({
      index: i + 1,
      date: d.date,
      label: d.label,
    })),
  };
  const parsed = dateOfferSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** Build a validated provider selection offer. */
export function buildProviderOffer(
  scope: OfferScope,
  id: string,
  input: {
    serviceId: string;
    serviceName: string;
    date: string | null;
    providers: ReadonlyArray<{ providerId: string | null; name: string }>;
  },
  now: Date,
): ProviderOffer | null {
  const candidate = {
    ...offerEnvelope(scope, id, now),
    kind: "PROVIDER" as const,
    serviceId: input.serviceId,
    serviceName: input.serviceName,
    date: input.date,
    options: input.providers.slice(0, MAX_OFFER_OPTIONS).map((p, i) => ({
      index: i + 1,
      providerId: p.providerId,
      name: p.name,
    })),
  };
  const parsed = providerOfferSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** Build a validated slot offer from fresh CORE-02 options (shown order). */
export function buildSlotOffer(
  scope: OfferScope,
  id: string,
  input: {
    serviceId: string;
    serviceName: string;
    serviceSource: "CUSTOMER" | "DEFAULT";
    providerId: string | null;
    timePreference?: CanonicalTimePreference | null;
    date: string;
    followUpRequestId: string | null;
    shownCount: number;
    options: ReadonlyArray<{
      providerId: string;
      displayName: string;
      startAt: string;
      endAt: string;
    }>;
  },
  now: Date,
): SlotOffer | null {
  const candidate = {
    ...offerEnvelope(scope, id, now),
    kind: "SLOT" as const,
    serviceId: input.serviceId,
    serviceName: input.serviceName,
    serviceSource: input.serviceSource,
    providerId: input.providerId,
    timePreference: input.timePreference ?? null,
    date: input.date,
    followUpRequestId: input.followUpRequestId,
    shownCount: input.shownCount,
    options: input.options.slice(0, MAX_OFFER_OPTIONS).map((option, i) => ({
      index: i + 1,
      providerId: option.providerId,
      displayName: option.displayName,
      startAt: option.startAt,
      endAt: option.endAt,
    })),
  };
  const parsed = slotOfferSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

// ─── Offer-bound Telegram callbacks & presentation re-exports ───────────────
// Telegram presentation boundary owns callback formatting and inline keyboards.
// Re-exported here for compatibility with existing tests.

export {
  offerCallbackData,
  parseOfferCallback,
  welcomeOfferKeyboard,
  serviceOfferKeyboard,
  serviceDetailKeyboard,
  dateOfferKeyboard,
  providerOfferKeyboard,
  slotOfferKeyboard,
  type OfferCallback,
  type TelegramInlineKeyboardButton,
  type TelegramInlineKeyboardMarkup,
} from "@/server/integrations/telegram/telegram-presentation";
