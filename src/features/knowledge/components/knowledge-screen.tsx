"use client";

import { markKnowledgeGapReviewedAction } from "@/features/assistant/actions/assistant-actions";
import {
  createKnowledgeEntryAction,
  removeKnowledgeEntryAction,
  updateKnowledgeEntryAction,
} from "@/features/knowledge/actions/knowledge-actions";
import { KnowledgeFormDialog } from "@/features/knowledge/components/knowledge-form-dialog";
import { KnowledgeRemoveDialog } from "@/features/knowledge/components/knowledge-remove-dialog";
import type { KnowledgeFormInput } from "@/features/knowledge/schemas/knowledge-schema";
import type {
  KnowledgeActionResult,
  KnowledgeEntryView,
  KnowledgeSuggestionView,
} from "@/features/knowledge/types";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { SectionHeader } from "@/components/shared/section-header";
import { Button } from "@/components/ui/button";
import { KNOWLEDGE_NOUNS, arabicCount } from "@/lib/arabic";

import {
  BookOpenIcon,
  CheckCircleIcon,
  LightbulbIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

/**
 * Business Knowledge screen (PROMPT-18): what the future AI assistant
 * knows. The mental model is one line — هذه المعلومات هي التي
 * سيستخدمها المساعد الذكي للرد على العملاء — then a plain list of
 * question/answer entries with one primary action (إضافة معلومة), a
 * small edit dialog, and a confirmed remove. Mutation failures
 * surface inside their dialog (role="alert"); server-confirmed
 * results replace the whole list, so the screen never drifts from
 * the stored JSON entries.
 */
export function KnowledgeScreen({
  initialEntries,
  initialSuggestions,
  presetQuestion,
  answerGapId,
}: {
  initialEntries: KnowledgeEntryView[];
  initialSuggestions?: KnowledgeSuggestionView;
  /**
   * The discovered customer question carried in from a knowledge-gap review
   * (PROMPT-AI-UX-02). Present → the authoring form STARTS OPEN, prefilled
   * with the question as an EDITABLE draft and an empty answer: the owner only
   * supplies the answer.
   */
  presetQuestion?: string;
  /**
   * The unresolved knowledge-gap row the prefilled question belongs to. When
   * present, saving the answer ALSO closes the gap through its existing
   * lifecycle (REVIEWED — terminal). Server-side tenant-scoped; an invalid id
   * closes nothing.
   */
  answerGapId?: string;
}) {
  const [entries, setEntries] = useState(initialEntries);
  /**
   * The answer flow (PROMPT-AI-UX-02): a knowledge-gap review item opens this
   * editor with the discovered customer question. The prefilled draft is
   * derived from the page-load param as INITIAL STATE — identical on the server
   * and the client — so the form starts open and prefilled with no effect and
   * no cascading render. The question stays an EDITABLE DRAFT with an empty
   * answer: the system already knows what the customer asked, so the owner
   * only types the answer.
   */
  const presetFromQuestion = presetQuestion?.trim() || null;
  const [formOpen, setFormOpen] = useState(Boolean(presetFromQuestion));
  const [editing, setEditing] = useState<KnowledgeEntryView | null>(null);
  const [preset, setPreset] = useState<{
    question: string;
    answer: string;
  } | null>(
    presetFromQuestion ? { question: presetFromQuestion, answer: "" } : null,
  );
  /** The form is answering a discovered customer question (vs. a plain create). */
  const [customerQuestion, setCustomerQuestion] = useState(
    Boolean(presetFromQuestion),
  );
  const [formSession, setFormSession] = useState(0);
  const [removing, setRemoving] = useState<KnowledgeEntryView | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);

  function openCreate() {
    setEditing(null);
    setPreset(null);
    setCustomerQuestion(false);
    setFormSession((count) => count + 1);
    setFormOpen(true);
  }

  /**
   * B-05 — one tap on a suggested question opens the create form
   * PREFILLED with the starter pair as an editable draft. The pair is
   * NOT saved here: nothing reaches `Business.faqs` until the owner
   * submits the form (a suggestion never becomes a verified fact).
   */
  function openSuggestion(suggestion: { question: string; answer: string }) {
    setEditing(null);
    setPreset(suggestion);
    setCustomerQuestion(false);
    setFormSession((count) => count + 1);
    setFormOpen(true);
  }

  function openEdit(entry: KnowledgeEntryView) {
    setEditing(entry);
    setPreset(null);
    setCustomerQuestion(false);
    setFormSession((count) => count + 1);
    setFormOpen(true);
  }

  function openRemove(entry: KnowledgeEntryView) {
    setRemoving(entry);
    setRemoveOpen(true);
  }

  /** A server-confirmed save replaces the list and confirms calmly. */
  function handleSaved(list: KnowledgeEntryView[]) {
    setEntries(list);
    setSuccess(customerQuestion ? "تم حفظ الإجابة" : "تم حفظ المعلومة");
  }

  /** A server-confirmed remove replaces the list and confirms calmly. */
  function handleRemoved(list: KnowledgeEntryView[]) {
    setEntries(list);
    setRemoving(null);
    setSuccess("تم حذف المعلومة");
  }

  /**
   * The answer flow's save (PROMPT-AI-UX-02): persist through the EXISTING
   * canonical knowledge path FIRST, then — only after it succeeded — close the
   * unresolved gap through its existing REVIEWED lifecycle. Ordering matters:
   * a review failure can never lose the answer, and a refused/duplicate save
   * never closes the gap. No duplicate question can be created: the canonical
   * service rejects a question it already stores, and a reviewed gap is
   * terminal (it can never re-open to be answered twice).
   */
  async function submitAnswerFlow(
    input: KnowledgeFormInput,
  ): Promise<KnowledgeActionResult> {
    const result = await createKnowledgeEntryAction(input);
    if (!result.success) return result;
    if (answerGapId) {
      await markKnowledgeGapReviewedAction(answerGapId);
    }
    return result;
  }

  const submitForm = editing
    ? (input: KnowledgeFormInput) =>
        updateKnowledgeEntryAction({
          currentQuestion: editing.question,
          entry: input,
        })
    : answerGapId
      ? submitAnswerFlow
      : createKnowledgeEntryAction;

  const submitRemove = () =>
    removing
      ? removeKnowledgeEntryAction({ question: removing.question })
      : Promise.resolve({
          success: false,
          message: "لا توجد معلومة محددة للحذف",
        } as const);

  /**
   * A suggested question the business already answers verbatim adds
   * nothing — it is hidden instead of being offered twice. Matching is
   * on the trimmed question (the natural key of an entry), same rule
   * the service applies for duplicate rejection.
   */
  const existingQuestions = useMemo(
    () =>
      new Set(entries.map((entry) => entry.question.trim()).filter(Boolean)),
    [entries],
  );

  const suggestions =
    initialSuggestions?.suggestions.filter(
      (suggestion) => !existingQuestions.has(suggestion.question.trim()),
    ) ?? [];

  return (
    <div className="animate-fade-in-up space-y-6">
      <PageHeader
        title="معلومات للمساعد"
        description="هذه المعلومات هي التي سيستخدمها المساعد الذكي للرد على العملاء — خليها دقيقة ومحدّثة."
        actions={
          <Button onClick={openCreate}>
            <PlusIcon />
            إضافة معلومة
          </Button>
        }
      />

      {entries.length > 0 ? (
        <>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {arabicCount(entries.length, KNOWLEDGE_NOUNS)}
          </p>
          {success ? (
            <p
              role="status"
              className="flex items-center gap-1.5 text-sm text-success"
            >
              <CheckCircleIcon aria-hidden className="size-4" />
              {success}
            </p>
          ) : null}
          <ul className="space-y-3">
            {entries.map((entry) => (
              <li key={entry.question}>
                <article className="rounded-xl border bg-card p-4 shadow-xs transition-shadow hover:shadow-sm">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <h2 className="font-semibold">{entry.question}</h2>
                      <p className="mt-2 line-clamp-2 text-sm leading-6 text-muted-foreground">
                        {entry.answer}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => openEdit(entry)}
                      >
                        <PencilIcon />
                        تعديل
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => openRemove(entry)}
                      >
                        <TrashIcon />
                        حذف
                      </Button>
                    </div>
                  </div>
                </article>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <EmptyState
          className="bg-card min-h-72"
          icon={BookOpenIcon}
          title="لسه ما أضفتش معلومات للمساعد"
          description="أضف الأسعار أو السياسات أو الإجابات المتكررة عشان المساعد يقدر يرد بدقة."
          action={
            <Button size="sm" onClick={openCreate}>
              <PlusIcon aria-hidden className="size-4" />
              إضافة معلومة
            </Button>
          }
        />
      )}

      {/* key → the dialog remounts on every open, so create starts
          blank and edit prefills the selected entry. A suggestion
          presets create mode with an editable draft answer; a discovered
          customer question presets create mode with the question and an
          empty answer (the answer flow). */}
      <KnowledgeFormDialog
        key={formSession}
        open={formOpen}
        onOpenChange={setFormOpen}
        entry={editing ?? undefined}
        preset={preset ?? undefined}
        customerQuestion={customerQuestion}
        submit={submitForm}
        onSaved={handleSaved}
      />

      {suggestions.length > 0 ? (
        <section className="space-y-3">
          <SectionHeader
            title="أسئلة مقترحة"
            description={
              initialSuggestions?.verticalLabel
                ? `أسئلة شائعة مناسبة لنشاطك (${initialSuggestions.verticalLabel}) — أضفها بضغطة وعدّل الإجابة قبل الحفظ.`
                : "أسئلة شائعة مناسبة لنشاطك — أضفها بضغطة وعدّل الإجابة قبل الحفظ."
            }
          />
          <ul className="space-y-2.5">
            {suggestions.map((suggestion) => (
              <li key={suggestion.question}>
                <article className="flex flex-col gap-3 rounded-xl border border-dashed bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <h3 className="flex items-center gap-1.5 text-sm font-medium">
                      <LightbulbIcon
                        aria-hidden
                        className="text-primary size-4 shrink-0"
                      />
                      {suggestion.question}
                    </h3>
                    <p className="text-muted-foreground mt-1 line-clamp-2 text-xs leading-5">
                      مسودة: {suggestion.answer}
                    </p>
                  </div>
                  <div className="shrink-0">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => openSuggestion(suggestion)}
                    >
                      <PlusIcon aria-hidden className="size-4" />
                      إضافة
                    </Button>
                  </div>
                </article>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <KnowledgeRemoveDialog
        open={removeOpen}
        onOpenChange={(open) => {
          setRemoveOpen(open);
          if (!open) setRemoving(null);
        }}
        entry={removing}
        submit={submitRemove}
        onRemoved={handleRemoved}
      />
    </div>
  );
}
