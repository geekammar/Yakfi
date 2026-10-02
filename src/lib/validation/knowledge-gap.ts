import { uuidSchema } from "./common";
import { z } from "zod";

/**
 * Knowledge-gap records (PROMPT-AI-ARCH-18 — Slice 9).
 *
 * A knowledge gap is the RECORD-ONLY evidence that the assistant reached an
 * authoritative `KNOWLEDGE_GAP_UNRESOLVED` handoff — "the turn could not be
 * answered because authoritative knowledge was unresolved". It is NOT a
 * second knowledge store, NOT RAG, NOT an automatic learning artifact and NOT
 * an operator queue: it is a bounded, tenant-scoped, append-oriented row that
 * a human can later review.
 *
 * This module owns ONLY the DTOs/value sets. The lifecycle authority is the
 * repository (`src/server/repositories/knowledge-gap.repository.ts`) and the
 * derivation is the pure recorder
 * (`src/features/conversations/server/knowledge-gap.ts`). Nothing here runs on
 * the customer critical path.
 *
 * BINDING: a record NEVER promotes knowledge. There is no `promote` DTO and no
 * FAQ/business write here — promotion is a future, explicitly human-approved
 * workflow (see `docs/ai/TARGET_ARCHITECTURE.md §3.16`).
 */

/**
 * The bounded family of the missing knowledge, derived DETERMINISTICALLY from
 * the turn's already-computed signals (the authoritative intent + the B-02
 * task relevance) — never from a model output and never by a new classifier.
 * A stable machine key (the codebase convention — no Prisma enum), so
 * extending the list needs no data migration.
 */
export const knowledgeGapCategoryValues = [
  /** A price / fee ask the service catalog could not back. */
  "SERVICE_PRICE",
  /** A business-profile / "about" ask. */
  "BUSINESS_INFO",
  /** A service-detail / description ask. */
  "SERVICE_INFO",
  /** An availability / booking-window ask. */
  "AVAILABILITY",
  /** A general knowledge question with no backing store entry. */
  "FAQ",
  /** Any other unresolved knowledge the assistant could not ground. */
  "GENERAL",
] as const;

export type KnowledgeGapCategory = (typeof knowledgeGapCategoryValues)[number];

/**
 * The review lifecycle. `UNRESOLVED` is the ONLY value the recorder ever
 * writes; `REVIEWED` / `REJECTED` are set by an explicit human transition
 * through the repository. Promotion (turning a reviewed gap into business
 * knowledge) is deliberately absent — it is a future human-approved workflow.
 */
export const knowledgeGapStatusValues = [
  "UNRESOLVED",
  "REVIEWED",
  "REJECTED",
] as const;

export type KnowledgeGapStatus = (typeof knowledgeGapStatusValues)[number];

const categorySchema = z.enum(knowledgeGapCategoryValues);
const statusSchema = z.enum(knowledgeGapStatusValues);

/**
 * Fail-safe parse of a STORED category/status. An unknown / legacy value
 * yields `null` (never a misleading category) — the same convention as
 * `parseHandoffCause`.
 */
export function parseKnowledgeGapCategory(
  value: unknown,
): KnowledgeGapCategory | null {
  return categorySchema.safeParse(value).success
    ? (value as KnowledgeGapCategory)
    : null;
}

export function parseKnowledgeGapStatus(
  value: unknown,
): KnowledgeGapStatus | null {
  return statusSchema.safeParse(value).success
    ? (value as KnowledgeGapStatus)
    : null;
}

/**
 * The append DTO. `businessId` is ALWAYS the server-derived tenant scope
 * (never client input); `conversationId` / `customerMessageId` reference the
 * source turn; `subjectText` is an OPTIONAL bounded slice of the customer's
 * own question (never a model output, never chain-of-thought).
 */
const recordKnowledgeGapSchema = z.object({
  businessId: uuidSchema,
  conversationId: uuidSchema,
  customerMessageId: uuidSchema,
  category: categorySchema,
  subjectText: z.string().trim().min(1).max(200).nullish(),
});

/**
 * Deterministic, tenant-scoped retrieval. `status` defaults to UNRESOLVED
 * (the review queue); `limit` is bounded so a caller can never ask for the
 * whole table.
 */
const listKnowledgeGapsSchema = z.object({
  businessId: uuidSchema,
  status: statusSchema.optional(),
  category: categorySchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * An explicit human review transition. The actor is server-authorized; the
 * repository only ever updates a row that is BOTH in the caller's tenant and
 * still `UNRESOLVED` (a reviewed gap is terminal — never re-opened by a
 * replay).
 */
const reviewKnowledgeGapSchema = z.object({
  id: uuidSchema,
  businessId: uuidSchema,
  reviewedById: uuidSchema,
});

export type RecordKnowledgeGapDto = z.infer<typeof recordKnowledgeGapSchema>;
export type ListKnowledgeGapsDto = z.infer<typeof listKnowledgeGapsSchema>;
export type ReviewKnowledgeGapDto = z.infer<typeof reviewKnowledgeGapSchema>;

export const knowledgeGapValidation = {
  record: recordKnowledgeGapSchema,
  list: listKnowledgeGapsSchema,
  review: reviewKnowledgeGapSchema,
} as const;
