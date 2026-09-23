/**
 * Business Knowledge workflow (PROMPT-18, Spec A §6).
 *
 * Plain-text FAQ/knowledge entries the future AI assistant will use
 * when replying to customers. The storage is the canonical
 * `Business.faqs` JSON field (DECISIONS #13 — no second knowledge
 * system, no vector DB, no RAG). The service layer enforces the
 * authorization rules the route layer relies on: only Business ADMIN
 * users manage knowledge, and the target Business is ALWAYS the
 * actor's own (derived from the trusted session → user record, never
 * from client input). Repository collaborators are injectable so the
 * workflow logic can be verified without a live database
 * (services/settings-feature pattern).
 */

import {
  knowledgeFormSchema,
  removeKnowledgeSchema,
  updateKnowledgeSchema,
} from "@/features/knowledge/schemas/knowledge-schema";
import {
  listFaqSuggestions,
  suggestionGroupLabel,
  type FaqSuggestionGroup,
} from "@/features/knowledge/suggestions/faq-suggestions";
import type {
  KnowledgeActionResult,
  KnowledgeEntryView,
} from "@/features/knowledge/types";
import type { BusinessRepository } from "@/server/repositories";
import { businessRepository } from "@/server/repositories";
import type { UserRole } from "@/types/domain";

import { z } from "zod";

/** Authorization context derived from the authenticated session. */
export type KnowledgeActor = {
  userId: string;
  role: UserRole;
  businessId: string | null;
};

export type KnowledgeServiceDeps = {
  businessRepository: Pick<BusinessRepository, "findById" | "update">;
};

/** Production dependencies (app singletons). */
export const defaultKnowledgeServiceDeps: KnowledgeServiceDeps = {
  businessRepository,
};

/** Stored-shape contract: the JSON entries must conform to be manageable. */
const storedFaqsSchema = z.array(knowledgeFormSchema);

const MAX_ENTRIES = 50;

const FORBIDDEN_MESSAGE = "إدارة معلومات المساعد متاحة للمدير فقط";
const NO_BUSINESS_MESSAGE = "أكمل إعداد المنشأة أولاً";
const BUSINESS_NOT_FOUND_MESSAGE = "تعذر العثور على المنشأة";
const ENTRY_NOT_FOUND_MESSAGE =
  "المعلومة دي مش موجودة — حدّث الصفحة وحاول تاني";
const DUPLICATE_MESSAGE = "في معلومة بنفس السؤال موجودة بالفعل";
const LIMIT_MESSAGE = "وصلت للحد الأقصى للمعلومات (٥٠)";
const INVALID_INPUT_MESSAGE = "بيانات المعلومة غير صالحة";
const SAVE_FAILED_MESSAGE = "تعذر حفظ المعلومة الآن";
const REMOVE_FAILED_MESSAGE = "تعذر حذف المعلومة الآن";
const READ_FAILED_MESSAGE = "تعذر قراءة معلومات المنشأة — راجع البيانات";

function resolveScope(
  actor: KnowledgeActor,
): { ok: true; businessId: string } | { ok: false; message: string } {
  if (actor.role !== "ADMIN") return { ok: false, message: FORBIDDEN_MESSAGE };
  if (!actor.businessId) return { ok: false, message: NO_BUSINESS_MESSAGE };
  return { ok: true, businessId: actor.businessId };
}

/**
 * Reads and validates the stored JSON entries. Malformed stored data
 * fails honestly instead of being silently dropped or rewritten.
 */
async function loadEntries(
  deps: KnowledgeServiceDeps,
  businessId: string,
): Promise<KnowledgeEntryView[] | { message: string }> {
  const business = await deps.businessRepository.findById(businessId);
  if (!business) return { message: BUSINESS_NOT_FOUND_MESSAGE };

  const parsed = storedFaqsSchema.safeParse(business.faqs ?? []);
  if (!parsed.success) return { message: READ_FAILED_MESSAGE };
  return parsed.data;
}

/** The trimmed question is the natural key of an entry. */
function findIndexByQuestion(
  entries: KnowledgeEntryView[],
  question: string,
): number {
  return entries.findIndex((entry) => entry.question === question);
}

/** List the actor's Business knowledge entries (ADMIN only). */
export async function listKnowledge(
  deps: KnowledgeServiceDeps,
  actor: KnowledgeActor,
): Promise<KnowledgeEntryView[] | { message: string }> {
  const scope = resolveScope(actor);
  if (!scope.ok) return { message: scope.message };
  return loadEntries(deps, scope.businessId);
}

/**
 * Starter FAQ suggestions for the actor's Business (ADMIN only, own
 * Business only) — B-05. The vertical is derived from the actor's OWN
 * business record (never client input), and the pairs are static drafts
 * the owner must explicitly review and save. A suggestion never becomes
 * a stored fact without an explicit create. (No DB write, no AI call.)
 */
export async function listKnowledgeSuggestions(
  deps: KnowledgeServiceDeps,
  actor: KnowledgeActor,
): Promise<FaqSuggestionGroup | { message: string }> {
  const scope = resolveScope(actor);
  if (!scope.ok) return { message: scope.message };

  const business = await deps.businessRepository.findById(scope.businessId);
  if (!business) return { message: BUSINESS_NOT_FOUND_MESSAGE };

  return {
    verticalLabel: suggestionGroupLabel(business.vertical),
    suggestions: listFaqSuggestions(business.vertical),
  };
}

export async function createKnowledgeEntry(
  deps: KnowledgeServiceDeps,
  actor: KnowledgeActor,
  input: unknown,
): Promise<KnowledgeActionResult> {
  const scope = resolveScope(actor);
  if (!scope.ok) return { success: false, message: scope.message };

  const parsed = knowledgeFormSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      message: parsed.error.issues[0]?.message ?? INVALID_INPUT_MESSAGE,
    };
  }

  const loaded = await loadEntries(deps, scope.businessId);
  if (!Array.isArray(loaded))
    return { success: false, message: loaded.message };

  if (findIndexByQuestion(loaded, parsed.data.question) !== -1) {
    return { success: false, message: DUPLICATE_MESSAGE };
  }
  if (loaded.length >= MAX_ENTRIES) {
    return { success: false, message: LIMIT_MESSAGE };
  }

  try {
    // The write targets ONLY the actor's own businessId — a client-
    // supplied businessId cannot redirect it.
    const entries = [...loaded, parsed.data];
    await deps.businessRepository.update(scope.businessId, { faqs: entries });
    return { success: true, entries };
  } catch {
    return { success: false, message: SAVE_FAILED_MESSAGE };
  }
}

export async function updateKnowledgeEntry(
  deps: KnowledgeServiceDeps,
  actor: KnowledgeActor,
  input: unknown,
): Promise<KnowledgeActionResult> {
  const scope = resolveScope(actor);
  if (!scope.ok) return { success: false, message: scope.message };

  const parsed = updateKnowledgeSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      message: parsed.error.issues[0]?.message ?? INVALID_INPUT_MESSAGE,
    };
  }

  const loaded = await loadEntries(deps, scope.businessId);
  if (!Array.isArray(loaded))
    return { success: false, message: loaded.message };

  const index = findIndexByQuestion(loaded, parsed.data.currentQuestion);
  if (index === -1) {
    return { success: false, message: ENTRY_NOT_FOUND_MESSAGE };
  }
  // Same-question duplicate against any OTHER entry is a conflict.
  const duplicateIndex = findIndexByQuestion(
    loaded,
    parsed.data.entry.question,
  );
  if (duplicateIndex !== -1 && duplicateIndex !== index) {
    return { success: false, message: DUPLICATE_MESSAGE };
  }

  try {
    const entries = loaded.map((entry, i) =>
      i === index ? parsed.data.entry : entry,
    );
    await deps.businessRepository.update(scope.businessId, { faqs: entries });
    return { success: true, entries };
  } catch {
    return { success: false, message: SAVE_FAILED_MESSAGE };
  }
}

export async function removeKnowledgeEntry(
  deps: KnowledgeServiceDeps,
  actor: KnowledgeActor,
  input: unknown,
): Promise<KnowledgeActionResult> {
  const scope = resolveScope(actor);
  if (!scope.ok) return { success: false, message: scope.message };

  const parsed = removeKnowledgeSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      message: parsed.error.issues[0]?.message ?? INVALID_INPUT_MESSAGE,
    };
  }

  const loaded = await loadEntries(deps, scope.businessId);
  if (!Array.isArray(loaded))
    return { success: false, message: loaded.message };

  const index = findIndexByQuestion(loaded, parsed.data.question);
  if (index === -1) {
    return { success: false, message: ENTRY_NOT_FOUND_MESSAGE };
  }

  try {
    const entries = loaded.filter((_, i) => i !== index);
    await deps.businessRepository.update(scope.businessId, { faqs: entries });
    return { success: true, entries };
  } catch {
    return { success: false, message: REMOVE_FAILED_MESSAGE };
  }
}
