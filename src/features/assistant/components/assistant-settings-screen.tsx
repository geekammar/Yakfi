"use client";

import {
  markKnowledgeGapReviewedAction,
  updateAssistantSettingsAction,
} from "@/features/assistant/actions/assistant-actions";
import {
  assistantSettingsSchema,
  type AssistantSettingsInput,
} from "@/features/assistant/schemas/assistant-schema";
import type {
  AssistantSettingsView,
  KnowledgeGapReviewItem,
} from "@/features/assistant/types";
import {
  ASSISTANT_DETAIL_CHOICES,
  ASSISTANT_EMOJI_CHOICES,
  ASSISTANT_LANGUAGE_CHOICES,
  ASSISTANT_TONE_CHOICES,
} from "@/features/conversations/server/assistant-style";
import { PageHeader } from "@/components/shared/page-header";
import { SectionHeader } from "@/components/shared/section-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

import { zodResolver } from "@hookform/resolvers/zod";
import {
  CheckCircleIcon,
  CheckIcon,
  InfoIcon,
  LightbulbIcon,
  LoaderCircleIcon,
} from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";
import { Controller, useForm } from "react-hook-form";

/**
 * A single bounded-choice group (prompt §7: bounded choices only, large touch
 * targets, a label AND a hint so the choice is never color-only). Selected
 * choice is shown with a border + background, not just the radio control.
 */
function ChoiceGroup<
  Option extends { value: string; label: string; hint: string },
>({
  groupId,
  options,
  value,
  onChange,
}: {
  groupId: string;
  options: ReadonlyArray<Option>;
  value: string | null;
  onChange: (value: string) => void;
}) {
  return (
    <RadioGroup
      value={value ?? undefined}
      onValueChange={onChange}
      className="gap-2.5"
    >
      {options.map((option) => {
        const inputId = `${groupId}-${option.value}`;
        return (
          <Label
            key={option.value}
            htmlFor={inputId}
            className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3.5 font-normal transition-colors hover:bg-accent/60 has-data-checked:border-primary has-data-checked:bg-accent/60"
          >
            <RadioGroupItem
              id={inputId}
              value={option.value}
              className="mt-0.5"
            />
            <span className="space-y-1">
              <span className="block text-sm font-medium">{option.label}</span>
              <span className="block text-xs leading-5 text-muted-foreground">
                {option.hint}
              </span>
            </span>
          </Label>
        );
      })}
    </RadioGroup>
  );
}

/**
 * The "handled it" button for one knowledge-gap item. Marks the gap reviewed
 * (terminal — it does NOT create an FAQ and does NOT promote knowledge); the
 * optimistic removal keeps the list calm while the transition runs.
 */
function MarkReviewedButton({
  gapId,
  onDone,
}: {
  gapId: string;
  onDone: () => void;
}) {
  const [isPending, startTransition] = useTransition();
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={isPending}
      aria-label="تمت المراجعة"
      onClick={() => {
        startTransition(async () => {
          const result = await markKnowledgeGapReviewedAction(gapId);
          if (result.success) onDone();
        });
      }}
      className="text-muted-foreground hover:text-foreground"
    >
      {isPending ? (
        <LoaderCircleIcon aria-hidden className="animate-spin" />
      ) : (
        <CheckIcon aria-hidden className="size-4" />
      )}
      تمت المراجعة
    </Button>
  );
}

/**
 * The lightweight knowledge-gap review loop (§13). Each item states, in
 * business language, what the assistant was missing, and routes to the ONE
 * authoritative editor — never an automatic FAQ, and never a second source of
 * truth. Empty state explains simply that nothing needs the owner right now.
 */
function KnowledgeGapReviewSection({
  gaps,
  onReviewed,
}: {
  gaps: ReadonlyArray<KnowledgeGapReviewItem>;
  onReviewed: (gapId: string) => void;
}) {
  if (gaps.length === 0) {
    return (
      <section
        aria-labelledby="assistant-gaps-section"
        className="rounded-xl border bg-card p-5 shadow-xs sm:p-6"
      >
        <SectionHeader
          title="أسئلة لم يجد لها المساعد إجابة"
          description="تظهر هنا الأسئلة التي وصلت لمساعدك ولم تكن المعلومة موجودة بعد."
        />
        <div className="flex items-start gap-3 rounded-lg bg-muted/40 p-4">
          <LightbulbIcon
            aria-hidden
            className="mt-0.5 size-5 shrink-0 text-muted-foreground"
          />
          <p className="text-xs leading-5 text-muted-foreground">
            لا توجد أسئلة معلّقة الآن — كل سؤال وصل لمساعدك كان عنده الإجابة.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="assistant-gaps-section"
      className="rounded-xl border bg-card p-5 shadow-xs sm:p-6"
    >
      <SectionHeader
        title="أسئلة لم يجد لها المساعد إجابة"
        description="أضف المعلومة في مكانها الصحيح، والمساعد يستخدمها في الردود القادمة."
      />
      <ul className="space-y-3">
        {gaps.map((gap) => (
          <li
            key={gap.id}
            className="flex flex-col gap-2.5 rounded-lg border bg-background p-3.5"
          >
            <div className="flex items-center gap-2">
              <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-[11px] font-medium">
                {gap.categoryLabel}
              </span>
              <span className="text-muted-foreground text-[11px]">
                سؤال عميل
              </span>
            </div>
            <p className="text-sm leading-6">«{gap.subject}»</p>
            <p className="text-xs leading-5 text-muted-foreground">
              {gap.title}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button asChild size="sm">
                <Link href={gap.href}>{gap.action}</Link>
              </Button>
              <MarkReviewedButton
                gapId={gap.id}
                onDone={() => onReviewed(gap.id)}
              />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Assistant Settings screen (PROMPT-AI-UX-01): how the business's assistant
 * talks. Bounded choices only — no prompt editor, no provider/model fields,
 * no free-form system instructions (prompt §7 + §19). Handoff behaviors are
 * explained read-only (SECTION F): mandatory platform safety boundaries are
 * never switchable by a Business Admin.
 */
export function AssistantSettingsScreen({
  initialSettings,
  handoffBehaviors,
  initialGaps,
}: {
  initialSettings: AssistantSettingsView;
  handoffBehaviors: ReadonlyArray<{
    key: string;
    label: string;
    description: string;
  }>;
  initialGaps?: ReadonlyArray<KnowledgeGapReviewItem>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // Local gap state so a completed review removes its item immediately
  // (the server revalidates the page too — both stay in sync).
  const [gaps, setGaps] = useState<ReadonlyArray<KnowledgeGapReviewItem>>(
    initialGaps ?? [],
  );

  const form = useForm<AssistantSettingsInput>({
    resolver: zodResolver(assistantSettingsSchema),
    defaultValues: {
      name: initialSettings.name,
      language: (initialSettings.language ?? undefined) as
        AssistantSettingsInput["language"] | undefined,
      tone: (initialSettings.tone ?? undefined) as
        AssistantSettingsInput["tone"] | undefined,
      detail: (initialSettings.detail ?? undefined) as
        AssistantSettingsInput["detail"] | undefined,
      emoji: (initialSettings.emoji ?? undefined) as
        AssistantSettingsInput["emoji"] | undefined,
    },
    mode: "onChange",
  });

  const submit = form.handleSubmit(async (data) => {
    setError(null);
    setSaved(false);
    const result = await updateAssistantSettingsAction(data);
    if (!result.success) {
      setError(result.message);
      return;
    }
    setSaved(true);
  });

  const isDirty = form.formState.isDirty;
  const isSubmitting = form.formState.isSubmitting;

  return (
    <div className="animate-fade-in-up space-y-8">
      <PageHeader
        title="إعدادات المساعد"
        description="تحكّم في طريقة كلام مساعدك مع عملائك — بدون أي تعقيد."
      />

      <form onSubmit={submit} className="space-y-8" noValidate>
        {/* ─── SECTION A — IDENTITY ─── */}
        <section
          aria-labelledby="assistant-name-section"
          className="rounded-xl border bg-card p-5 shadow-xs sm:p-6"
        >
          <SectionHeader
            title="اسم المساعد"
            description="الاسم الذي يظهر لك في التطبيق. اختياري تمامًا."
          />
          <div className="space-y-2">
            <Label htmlFor="assistant-name">اسم المساعد</Label>
            <Input
              id="assistant-name"
              autoComplete="off"
              placeholder="مثال: مساعد عيادة أفنان"
              aria-invalid={Boolean(form.formState.errors.name)}
              {...form.register("name")}
            />
            {form.formState.errors.name?.message ? (
              <p className="text-xs text-destructive" role="alert">
                {form.formState.errors.name.message}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              إذا تركته فارغًا، يظهر «المساعد الذكي».
            </p>
          </div>
        </section>

        {/* ─── SECTION B — LANGUAGE ─── */}
        <section
          aria-labelledby="assistant-language-section"
          className="rounded-xl border bg-card p-5 shadow-xs sm:p-6"
        >
          <SectionHeader
            title="لغة الردود"
            description="بأي لغة يرد المساعد على عملائك."
          />
          <Controller
            control={form.control}
            name="language"
            render={({ field }) => (
              <ChoiceGroup
                groupId="assistant-language"
                options={ASSISTANT_LANGUAGE_CHOICES}
                value={field.value ?? null}
                onChange={field.onChange}
              />
            )}
          />
        </section>

        {/* ─── SECTION C — TONE ─── */}
        <section
          aria-labelledby="assistant-tone-section"
          className="rounded-xl border bg-card p-5 shadow-xs sm:p-6"
        >
          <SectionHeader
            title="أسلوب الحديث"
            description="نبرة المساعد في الردود."
          />
          <Controller
            control={form.control}
            name="tone"
            render={({ field }) => (
              <ChoiceGroup
                groupId="assistant-tone"
                options={ASSISTANT_TONE_CHOICES}
                value={field.value ?? null}
                onChange={field.onChange}
              />
            )}
          />
        </section>

        {/* ─── SECTION D — RESPONSE LENGTH ─── */}
        <section
          aria-labelledby="assistant-detail-section"
          className="rounded-xl border bg-card p-5 shadow-xs sm:p-6"
        >
          <SectionHeader
            title="طول الردود"
            description="ما مدى التفصيل في كل رد."
          />
          <Controller
            control={form.control}
            name="detail"
            render={({ field }) => (
              <ChoiceGroup
                groupId="assistant-detail"
                options={ASSISTANT_DETAIL_CHOICES}
                value={field.value ?? null}
                onChange={field.onChange}
              />
            )}
          />
        </section>

        {/* ─── SECTION E — EMOJI ─── */}
        <section
          aria-labelledby="assistant-emoji-section"
          className="rounded-xl border bg-card p-5 shadow-xs sm:p-6"
        >
          <SectionHeader
            title="الرموز التعبيرية"
            description="هل يستخدم المساعد الإيموجي في ردوده."
          />
          <Controller
            control={form.control}
            name="emoji"
            render={({ field }) => (
              <ChoiceGroup
                groupId="assistant-emoji"
                options={ASSISTANT_EMOJI_CHOICES}
                value={field.value ?? null}
                onChange={field.onChange}
              />
            )}
          />
        </section>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className="flex flex-col-reverse gap-2 border-t pt-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {isSubmitting
              ? "جارٍ الحفظ…"
              : saved
                ? "تم الحفظ"
                : isDirty
                  ? "لن يتم حفظ التعديلات إلا بعد الضغط على زر الحفظ."
                  : "لا توجد تعديلات غير محفوظة."}
          </p>
          <Button type="submit" size="lg" disabled={isSubmitting || !isDirty}>
            {isSubmitting ? (
              <LoaderCircleIcon aria-hidden className="animate-spin" />
            ) : saved ? (
              <CheckCircleIcon aria-hidden className="size-4" />
            ) : null}
            حفظ التغييرات
          </Button>
        </div>
      </form>

      {/* ─── SECTION F — HUMAN HANDOFF (read-only, platform-enforced) ─── */}
      <section
        aria-labelledby="assistant-handoff-section"
        className="rounded-xl border bg-card p-5 shadow-xs sm:p-6"
      >
        <SectionHeader
          title="متى يحوّل المساعد المحادثة لفريقك"
          description="قواعد ثابتة تحافظ على سلامة عملائك — لا يمكن إيقافها."
        />
        <ul className="space-y-3">
          {handoffBehaviors.map((behavior) => (
            <li
              key={behavior.key}
              className="flex items-start gap-3 rounded-lg bg-muted/40 p-3.5"
            >
              <InfoIcon
                aria-hidden
                className="mt-0.5 size-5 shrink-0 text-muted-foreground"
              />
              <div className="min-w-0 space-y-1">
                <h3 className="flex items-center gap-1.5 text-sm font-medium">
                  {behavior.label}
                </h3>
                <p className="text-xs leading-5 text-muted-foreground">
                  {behavior.description}
                </p>
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted-foreground">
          هذه القواعد ثابتة لحماية عملائك ومنشأتك، ولا يمكن تعطيلها من هنا.
        </p>
      </section>

      {/* ─── Knowledge-gap review loop (§13) ─── */}
      <KnowledgeGapReviewSection
        gaps={gaps}
        onReviewed={(gapId) =>
          setGaps((current) => current.filter((gap) => gap.id !== gapId))
        }
      />

      {/* Small legend of what each section icon means (non-color cue) */}
      <p className="sr-only">
        أقسام الإعدادات: الاسم، اللغة، الأسلوب، طول الردود، الرموز التعبيرية،
        وتحويل المحادثات. كل اختيار له اسم ووصف نصي.
      </p>
    </div>
  );
}
