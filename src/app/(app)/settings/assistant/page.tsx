import { AssistantSettingsScreen } from "@/features/assistant/components/assistant-settings-screen";
import {
  HANDOFF_BEHAVIORS,
  defaultAssistantServiceDeps,
  getAssistantSettings,
  type AssistantActor,
} from "@/features/assistant/server/assistant-service";
import {
  defaultKnowledgeGapReviewDeps,
  listUnresolvedKnowledgeGaps,
} from "@/features/assistant/server/knowledge-gap-review";
import type {
  AssistantSettingsView,
  KnowledgeGapReviewItem,
} from "@/features/assistant/types";
import { requireRole } from "@/server/auth/guards";

import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "إعدادات المساعد",
};

/**
 * Assistant Settings (PROMPT-AI-UX-01) — ADMIN-only (STAFF is redirected to
 * access-denied). The Business is derived from the authenticated session;
 * the service layer enforces the role + tenant scoping server-side on every
 * read and write. This surface owns ONLY bounded communication choices — no
 * provider, no model, no prompt, no safety toggle (prompt §19/§20).
 */
export default async function AssistantSettingsPage() {
  const session = await requireRole("ADMIN");
  if (!session.user.businessId) redirect("/onboarding");

  const actor: AssistantActor = {
    userId: session.user.id,
    role: "ADMIN", // asserted by the guard above
    businessId: session.user.businessId,
  };

  const result = await getAssistantSettings(defaultAssistantServiceDeps, actor);
  // The page guard + layout redirect make this unreachable in practice;
  // honest fallback instead of rendering an empty form.
  if (!("name" in result)) redirect("/onboarding");

  const settings: AssistantSettingsView = result;

  // The lightweight knowledge-gap review loop (§13) — a NON-CRITICAL
  // surface: a failure here must never block the owner from configuring the
  // assistant's voice, so it degrades to "nothing to review right now".
  const gapsResult = await listUnresolvedKnowledgeGaps(
    defaultKnowledgeGapReviewDeps,
    actor,
  );
  const gaps: KnowledgeGapReviewItem[] = Array.isArray(gapsResult)
    ? gapsResult
    : [];

  return (
    <AssistantSettingsScreen
      initialSettings={settings}
      handoffBehaviors={HANDOFF_BEHAVIORS}
      initialGaps={gaps}
    />
  );
}
