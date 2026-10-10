import { MAX_COPY_LENGTH } from "@/features/conversation-copy/validation";

import { z } from "zod";

/**
 * Conversation-Copy Override persistence validation (UX-LAB-01C).
 *
 * These are the REPOSITORY DTOs for the platform-wide published copy
 * overrides. They validate only the *storage shape* (key form, text bounds,
 * action vocabulary, actor id) — the semantic copy contract (closed
 * placeholder vocabulary, per-key allowed placeholders, required
 * placeholders, protected markers, PROTECTED_COPY rejection) is owned
 * entirely by `validateCopyCandidate` from UX-LAB-01B and is enforced by
 * the override SERVICE before a write is ever handed to the repository.
 * The two layers never duplicate each other's rules.
 *
 * `action` is a plain string + Zod union, deliberately NOT a Prisma enum:
 * extending the action list later needs no data migration (the same
 * convention used by KnowledgeGap category/status and handoff cause).
 */

/**
 * The canonical copy-key form: a stable dotted `family.name`. Mirrors the
 * registry's own key shape so a malformed key is rejected at the boundary
 * (an unknown-but-well-formed key is still rejected by the service via
 * `validateCopyCandidate` — UNKNOWN_COPY_KEY).
 */
export const copyKeySchema = z
  .string()
  .trim()
  .min(1, "مفتاح النص مطلوب")
  .max(120, "مفتاح النص طويل جداً")
  .regex(
    /^[a-z][a-z0-9]*\.[a-z0-9_]+(\.[a-z0-9_]+)?$/,
    "صيغة مفتاح النص غير صالحة",
  );

/**
 * The stored override text bounds. The upper bound reuses the UX-LAB-01B
 * character contract (`MAX_COPY_LENGTH`) so persistence can never accept a
 * text the copy contract would reject; the semantic rules themselves live
 * in `validateCopyCandidate` and are never re-implemented here.
 */
export const copyOverrideTextSchema = z
  .string()
  .min(1, "نص التعديل مطلوب")
  .max(MAX_COPY_LENGTH, "نص التعديل طويل جداً");

/** The history action vocabulary (append-only audit rows). */
export const copyOverrideActionValues = [
  "PUBLISH",
  "RESET",
  "RESTORE",
] as const;

export type CopyOverrideAction = (typeof copyOverrideActionValues)[number];

export const copyOverrideActionSchema = z.enum(copyOverrideActionValues);

/** Upsert (publish/restore) repository input. */
export const saveCopyOverrideDtoSchema = z.object({
  copyKey: copyKeySchema,
  text: copyOverrideTextSchema,
  /** Audit actor when available. */
  actorId: z.string().nullable().optional(),
});

export type SaveCopyOverrideDto = z.infer<typeof saveCopyOverrideDtoSchema>;

/** Append a history row for a key transition. */
export const recordCopyOverrideHistoryDtoSchema = z.object({
  copyKey: copyKeySchema,
  action: copyOverrideActionSchema,
  /** Text effective BEFORE the change (null ⇒ code default was active). */
  previousText: z.string().nullable().optional(),
  /** Text effective AFTER the change (null ⇒ override removed). */
  resultText: z.string().nullable().optional(),
  /** Audit actor when available. */
  actorId: z.string().nullable().optional(),
});

export type RecordCopyOverrideHistoryDto = z.infer<
  typeof recordCopyOverrideHistoryDtoSchema
>;

/** Bounded history read for one key (newest first). */
export const listCopyOverrideHistoryDtoSchema = z.object({
  copyKey: copyKeySchema,
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type ListCopyOverrideHistoryDto = z.infer<
  typeof listCopyOverrideHistoryDtoSchema
>;
