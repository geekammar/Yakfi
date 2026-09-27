import { z } from "zod";

export const uuidSchema = z.uuid("معرّف غير صالح");

/** International phone number, digits/spaces/dashes, 8–20 chars. */
export const phoneSchema = z
  .string()
  .regex(/^\+?[0-9][0-9\s-]{7,19}$/, "رقم هاتف غير صالح");

/**
 * Provider-neutral EXTERNAL identity handle — the customer-facing seam
 * for ANY messaging channel (DECISIONS #63: Telegram second channel).
 *
 * An E.164 phone number is a STRICT SUBSET (optional leading `+`, digits,
 * optional space/dash separators), so every existing WhatsApp payload is
 * unchanged; a channel-native identifier — e.g. a Telegram chat/user id,
 * which is an integer, not a phone number — is a plain digit string.
 *
 * This is a LOOKUP KEY ONLY, never tenant identity: the Business is always
 * resolved SERVER-side from persisted state (never from a provider
 * payload), and the handle never carries authority of any kind. Channel
 * identity logic lives in the adapters; the Conversation Engine and the
 * transport boundary never branch on a channel.
 */
export const externalHandleSchema = z
  .string()
  .regex(/^\+?[0-9][0-9\s-]{5,63}$/, "معرّف خارجي غير صالح");

export const emailSchema = z.email("بريد إلكتروني غير صالح").max(255);

/** "HH:mm" or "HH:mm:ss", 24-hour. */
export const timeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, "تنسيق الوقت غير صالح");

/** Working-hours entry for a single day. */
export const workingHoursEntrySchema = z.object({
  open: timeSchema,
  close: timeSchema,
  closed: z.boolean(),
});

/** Full-week working hours keyed by English day names. */
export const workingHoursSchema = z.record(
  z.enum(["sat", "sun", "mon", "tue", "wed", "thu", "fri"]),
  workingHoursEntrySchema,
);

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type PaginationInput = z.infer<typeof paginationSchema>;

export function paginationToSkipTake(input: PaginationInput) {
  return { skip: (input.page - 1) * input.pageSize, take: input.pageSize };
}
