"use client";

import {
  knowledgeFormSchema,
  type KnowledgeFormInput,
} from "@/features/knowledge/schemas/knowledge-schema";
import type {
  KnowledgeActionResult,
  KnowledgeEntryView,
} from "@/features/knowledge/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import { zodResolver } from "@hookform/resolvers/zod";
import { LoaderCircleIcon } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";

/**
 * Small create/edit form: the question and its answer. The same form
 * serves both modes — the parent remounts it (key change) on every
 * open, so edit values are prefilled through mount-time defaults. The
 * submit operation (create or update) is bound by the parent screen.
 *
 * A suggested question (B-05) uses `preset`: create mode with the
 * starter pair prefilled as an EDITABLE DRAFT — the owner must still
 * hit save, so a suggestion never silently becomes a stored fact.
 *
 * The answer flow (PROMPT-AI-UX-02) uses `preset` + `customerQuestion`:
 * the discovered customer question is prefilled as an editable draft with
 * an EMPTY answer — the system already knows what the customer asked, so
 * the owner only supplies the answer.
 */
export function KnowledgeFormDialog({
  open,
  onOpenChange,
  entry,
  preset,
  customerQuestion,
  submit,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present → edit mode; absent → create mode. */
  entry?: KnowledgeEntryView;
  /** Present → create mode prefilled with a suggested starter pair. */
  preset?: { question: string; answer: string };
  /** Present → create mode answers a discovered customer question. */
  customerQuestion?: boolean;
  /** Runs the actual server action (create, or update by current question). */
  submit: (input: KnowledgeFormInput) => Promise<KnowledgeActionResult>;
  onSaved: (entries: KnowledgeEntryView[]) => void;
}) {
  const isEdit = Boolean(entry);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const form = useForm<KnowledgeFormInput>({
    resolver: zodResolver(knowledgeFormSchema),
    defaultValues: {
      question: entry?.question ?? preset?.question ?? "",
      answer: entry?.answer ?? preset?.answer ?? "",
    },
  });

  const onSubmit = form.handleSubmit(async (data) => {
    setError(null);
    setSubmitting(true);
    const result = await submit(data);
    setSubmitting(false);
    if (!result.success) {
      setError(result.message);
      return;
    }
    onOpenChange(false);
    onSaved(result.entries);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? "تعديل المعلومة"
              : customerQuestion
                ? "إضافة الإجابة"
                : "إضافة معلومة"}
          </DialogTitle>
          <DialogDescription>
            {isEdit
              ? "عدّل السؤال أو الإجابة ثم احفظ التغييرات."
              : customerQuestion
                ? "ده السؤال اللي سأله العميل — عدّله لو محتاج، واكتب الإجابة فقط."
                : "اكتب سؤالاً وإجابةً واضحة — زي الأسعار، السياسات، أو تعليمات ما قبل الحجز."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-5" noValidate>
          <div className="space-y-2">
            <Label htmlFor="knowledge-question">السؤال</Label>
            <Input
              id="knowledge-question"
              placeholder="مثال: إيه الأسعار عندكم؟"
              autoComplete="off"
              aria-invalid={Boolean(form.formState.errors.question)}
              {...form.register("question")}
            />
            {form.formState.errors.question ? (
              <p className="text-xs text-destructive">
                {form.formState.errors.question.message}
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="knowledge-answer">الإجابة</Label>
            <Textarea
              id="knowledge-answer"
              rows={4}
              placeholder="اكتب الإجابة ببساطة زي ما هتقوله للعميل في الواتساب…"
              aria-invalid={Boolean(form.formState.errors.answer)}
              {...form.register("answer")}
            />
            {form.formState.errors.answer ? (
              <p className="text-xs text-destructive">
                {form.formState.errors.answer.message}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                خلي الإجابة كاملة وواضحة — المساعد هيردها كما هي تقريباً.
              </p>
            )}
          </div>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              إلغاء
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? (
                <LoaderCircleIcon className="animate-spin" />
              ) : null}
              {customerQuestion && !isEdit ? "حفظ الإجابة" : "حفظ المعلومة"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
