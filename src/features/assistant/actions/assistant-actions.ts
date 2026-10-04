"use server";

import {
  defaultAssistantServiceDeps,
  getAssistantSettings,
  updateAssistantSettings,
  type AssistantActor,
} from "@/features/assistant/server/assistant-service";
import {
  defaultKnowledgeGapReviewDeps,
  listUnresolvedKnowledgeGaps,
  markKnowledgeGapReviewed,
} from "@/features/assistant/server/knowledge-gap-review";
import type {
  AssistantSettingsActionResult,
  KnowledgeGapReviewItem,
} from "@/features/assistant/types";
import { requireUser } from "@/server/auth/guards";
import { userRepository } from "@/server/repositories";

import { revalidatePath } from "next/cache";

/**
 * Builds the authorization context from the authenticated session + the
 * database-backed user record. The Business is ALWAYS derived server-side —
 * a client-provided businessId can never override it.
 */
async function currentActor(): Promise<AssistantActor> {
  const session = await requireUser();
  const user = await userRepository.findById(session.user.id);
  return {
    userId: session.user.id,
    // No user record (deleted mid-session) → least privilege: STAFF with no
    // Business can never touch assistant settings.
    role: user?.role ?? "STAFF",
    businessId: user?.businessId ?? null,
  };
}

function revalidateAssistant() {
  revalidatePath("/settings/assistant");
  // The assistant's voice affects live replies; the dashboard readiness card
  // links here, so keep both fresh after a save.
  revalidatePath("/");
}

export async function getAssistantSettingsAction(
  actorOverride?: AssistantActor,
): ReturnType<typeof getAssistantSettings> {
  return getAssistantSettings(
    defaultAssistantServiceDeps,
    actorOverride ?? (await currentActor()),
  );
}

export async function updateAssistantSettingsAction(
  input: unknown,
): Promise<AssistantSettingsActionResult> {
  const result = await updateAssistantSettings(
    defaultAssistantServiceDeps,
    await currentActor(),
    input,
  );
  if (result.success) revalidateAssistant();
  return result;
}

/**
 * List the business's UNRESOLVED knowledge gaps as review items (the
 * lightweight §13 loop). Tenant scope is the actor's own business — a client
 * can never request another business's gaps.
 */
export async function listUnresolvedKnowledgeGapsAction(
  actorOverride?: AssistantActor,
): Promise<KnowledgeGapReviewItem[] | { message: string }> {
  return listUnresolvedKnowledgeGaps(
    defaultKnowledgeGapReviewDeps,
    actorOverride ?? (await currentActor()),
  );
}

/**
 * Mark one knowledge gap reviewed (terminal — no promotion, no FAQ creation).
 * The row must belong to the actor's own business; the repository refuses a
 * row in another tenant or one already reviewed.
 */
export async function markKnowledgeGapReviewedAction(
  gapId: string,
): Promise<AssistantSettingsActionResult> {
  const result = await markKnowledgeGapReviewed(
    defaultKnowledgeGapReviewDeps,
    await currentActor(),
    gapId,
  );
  if (result.success) revalidatePath("/settings/assistant");
  return result;
}
