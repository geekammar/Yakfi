import {
  ANSWER_FLOW_GAP_PARAM,
  ANSWER_FLOW_QUESTION_PARAM,
} from "@/features/assistant/server/gap-destinations";
import { KnowledgeScreen } from "@/features/knowledge/components/knowledge-screen";
import {
  defaultKnowledgeServiceDeps,
  listKnowledge,
  listKnowledgeSuggestions,
  type KnowledgeActor,
} from "@/features/knowledge/server/knowledge-service";
import type {
  KnowledgeEntryView,
  KnowledgeSuggestionView,
} from "@/features/knowledge/types";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { faqEntrySchema, uuidSchema } from "@/lib/validation";
import { requireRole } from "@/server/auth/guards";

import { CircleAlertIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "معلومات للمساعد",
};

/**
 * Business Knowledge (Spec A §6) — ADMIN-only (STAFF is redirected to
 * access-denied). Plain-text question/answer entries the future AI
 * assistant will use when replying to customers, stored in the
 * canonical `Business.faqs` JSON field. The Business is ALWAYS the
 * actor's own, derived from the authenticated session; the service
 * layer enforces the role + tenant scoping server-side on every read
 * and write. Starter suggestions are derived from the SAME business
 * record's vertical — never from client input.
 *
 * The ANSWER flow (PROMPT-AI-UX-02): a knowledge-gap review item may open
 * this editor with the discovered customer question prefilled (`?question=`)
 * and the unresolved gap to close on save (`?gap=`). Both params are
 * untrusted URL input — re-validated here against the SAME contracts the
 * write path uses, so a crafted link can only ever prefill an editable draft.
 * A question that fails the entry contract is dropped (the editor opens
 * blank); an invalid gap id is ignored (nothing closes on save).
 */
export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const session = await requireRole("ADMIN");
  if (!session.user.businessId) redirect("/onboarding");

  const actor: KnowledgeActor = {
    userId: session.user.id,
    role: "ADMIN", // asserted by the guard above
    businessId: session.user.businessId,
  };

  const params = await searchParams;
  const rawQuestion = params[ANSWER_FLOW_QUESTION_PARAM];
  const rawGap = params[ANSWER_FLOW_GAP_PARAM];
  const question = typeof rawQuestion === "string" ? rawQuestion : undefined;
  const gap = typeof rawGap === "string" ? rawGap : undefined;
  const questionParsed = faqEntrySchema.shape.question.safeParse(
    question ?? "",
  );
  const gapParsed = uuidSchema.safeParse(gap ?? "");

  const result = await listKnowledge(defaultKnowledgeServiceDeps, actor);
  if (!Array.isArray(result)) {
    // Honest failure state — never an empty list pretending success.
    return (
      <div className="animate-fade-in-up space-y-6">
        <PageHeader
          title="معلومات للمساعد"
          description="هذه المعلومات هي التي سيستخدمها المساعد الذكي للرد على العملاء."
        />
        <EmptyState
          className="bg-card min-h-72"
          icon={CircleAlertIcon}
          title="تعذر تحميل المعلومات"
          description="حدث خطأ أثناء تحميل معلومات المنشأة. حاول مرة أخرى."
          action={
            <Link
              href="/settings/knowledge"
              prefetch={false}
              className="text-primary text-sm underline-offset-4 hover:underline"
            >
              إعادة المحاولة
            </Link>
          }
        />
      </div>
    );
  }

  const entries: KnowledgeEntryView[] = result;

  // Suggestions are a non-critical affordance: a failure here must never
  // block the owner from managing existing knowledge, so the screen
  // degrades to "no suggestions" rather than failing the whole page.
  const suggestionsResult = await listKnowledgeSuggestions(
    defaultKnowledgeServiceDeps,
    actor,
  );
  const suggestions: KnowledgeSuggestionView =
    "suggestions" in suggestionsResult
      ? suggestionsResult
      : { verticalLabel: "", suggestions: [] };

  return (
    <KnowledgeScreen
      initialEntries={entries}
      initialSuggestions={suggestions}
      presetQuestion={questionParsed.success ? questionParsed.data : undefined}
      answerGapId={gapParsed.success ? gapParsed.data : undefined}
    />
  );
}
