/**
 * Knowledge-gap review loop (PROMPT-AI-UX-01 §13) — the LIGHTWEIGHT action
 * surface over the already-existing knowledge-gap evidence.
 *
 * The gaps are already recorded by the engine (PROMPT-AI-ARCH-18 — Slice 9,
 * record-only, off the customer critical path). This module is the smallest
 * UX half: it shows a business the questions its assistant could NOT answer,
 * and routes each one to the ONE correct AUTHORITATIVE editor — it NEVER
 * automatically creates an FAQ for a missing-data case, and NEVER promotes
 * knowledge (a gap stays evidence until a human types the fact into its
 * canonical source).
 *
 * Routing is deterministic and server-side: the category (already derived by
 * the recorder from the turn's authoritative intent + task relevance) maps to
 * exactly one destination:
 *   SERVICE_PRICE  → the Service editor (price is DOMAIN data, never an FAQ)
 *   BUSINESS_INFO  → Business settings (about/address)
 *   SERVICE_INFO   → the Service editor (description)
 *   AVAILABILITY   → the working-hours editor
 *   FAQ / GENERAL  → the Knowledge editor
 *
 * Tenant isolation: the businessId is ALWAYS the server-derived actor scope;
 * a client can never list or review another business's gaps.
 */

import type { AssistantActor } from "@/features/assistant/server/assistant-service";
import {
  KNOWLEDGE_GAP_CATEGORY_LABELS,
  KNOWLEDGE_GAP_DESTINATIONS,
} from "@/features/assistant/server/gap-destinations";
import type { KnowledgeGapCategory } from "@/lib/validation";
import type { KnowledgeGapRepository } from "@/server/repositories";
import { knowledgeGapRepository } from "@/server/repositories";

export type KnowledgeGapReviewDeps = {
  knowledgeGapRepository: Pick<KnowledgeGapRepository, "list" | "markReviewed">;
};

export const defaultKnowledgeGapReviewDeps: KnowledgeGapReviewDeps = {
  knowledgeGapRepository,
};

const FORBIDDEN_MESSAGE = "مراجعة الأسئلة متاحة للمدير فقط";
const NO_BUSINESS_MESSAGE = "أكمل إعداد المنشأة أولاً";

function resolveScope(
  actor: AssistantActor,
): { ok: true; businessId: string } | { ok: false; message: string } {
  if (actor.role !== "ADMIN") return { ok: false, message: FORBIDDEN_MESSAGE };
  if (!actor.businessId) return { ok: false, message: NO_BUSINESS_MESSAGE };
  return { ok: true, businessId: actor.businessId };
}

/**
 * The deterministic category → destination map lives in the pure module
 * `gap-destinations.ts` (re-exported here for the service's single import
 * surface): a price/hours gap NEVER routes to the FAQ editor — that would
 * duplicate Domain facts into the knowledge store.
 */
export { KNOWLEDGE_GAP_DESTINATIONS };

/** The serializable view the UI renders (no ids of other tenants). */
export type KnowledgeGapReviewItem = {
  id: string;
  /** The bounded slice of the customer's own question, when recorded. */
  subject: string;
  /** Arabic label for the missing knowledge family. */
  categoryLabel: string;
  /** The business-language explanation of what is missing. */
  title: string;
  /** The CTA label. */
  action: string;
  /** The EXISTING authoritative editor to jump to. */
  href: string;
};

const UNKNOWN_CATEGORY_FALLBACK = {
  category: "GENERAL" as KnowledgeGapCategory,
};

/**
 * List the business's UNRESOLVED gaps as review items. A gap whose stored
 * category is unknown/legacy falls back to the general FAQ destination
 * (never throws, never hides the gap).
 */
export async function listUnresolvedKnowledgeGaps(
  deps: KnowledgeGapReviewDeps,
  actor: AssistantActor,
  limit = 10,
): Promise<KnowledgeGapReviewItem[] | { message: string }> {
  const scope = resolveScope(actor);
  if (!scope.ok) return { message: scope.message };

  const rows = await deps.knowledgeGapRepository.list({
    businessId: scope.businessId,
    status: "UNRESOLVED",
    limit,
  });

  return rows.map((row) => {
    const category = row.category ?? UNKNOWN_CATEGORY_FALLBACK.category;
    const destination = KNOWLEDGE_GAP_DESTINATIONS[category];
    return {
      id: row.id,
      subject: row.subjectText?.trim() || "سؤال من عميل",
      categoryLabel: KNOWLEDGE_GAP_CATEGORY_LABELS[category],
      title: destination.title,
      action: destination.action,
      href: destination.href,
    };
  });
}

/**
 * Mark one gap reviewed (the owner handled it — terminal, no promotion).
 * Tenant-scoped: the row must belong to the actor's own business; the
 * repository additionally refuses an already-reviewed row.
 */
export async function markKnowledgeGapReviewed(
  deps: KnowledgeGapReviewDeps,
  actor: AssistantActor,
  gapId: string,
): Promise<{ success: true } | { success: false; message: string }> {
  const scope = resolveScope(actor);
  if (!scope.ok) return { success: false, message: scope.message };
  if (!scope.businessId)
    return { success: false, message: NO_BUSINESS_MESSAGE };

  try {
    await deps.knowledgeGapRepository.markReviewed({
      id: gapId,
      businessId: scope.businessId,
      reviewedById: actor.userId,
    });
    return { success: true };
  } catch {
    return { success: false, message: "تعذر تحديث هذه المراجعة الآن" };
  }
}
