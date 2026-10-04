import { resolveAssistantName } from "@/features/conversations/server/assistant-style";
import { SectionHeader } from "@/components/shared/section-header";
import { Button } from "@/components/ui/button";
import {
  aiReadinessCompleteCount,
  isAssistantReady,
  nextReadinessAction,
  type AiReadinessItem,
} from "@/lib/ai-readiness";
import { cn } from "@/lib/utils";

import {
  CheckCircle2Icon,
  ChevronLeftIcon,
  CircleDashedIcon,
  SparklesIcon,
} from "lucide-react";
import Link from "next/link";

/**
 * AI Readiness card (PROMPT-AI-OPS-21 / PROMPT-AI-UX-01) — the
 * "اجعل مساعدك جاهزًا" entry point. A lightweight, NON-BLOCKING authoring
 * aid: it shows, from actual stored data only, whether the Business has the
 * information the assistant uses to answer common customer questions, and
 * each row jumps to the EXISTING editor for that field (settings / services /
 * knowledge / working hours). It is NOT a business score and NOT an AI
 * quality score; it never gates usage and invents nothing.
 *
 * Two deterministic states (no fabricated percentage):
 *  - READY: every CORE item is complete → the positive «مساعدك جاهز» state
 *    with the assistant's configured name, a secondary edit action, and a
 *    pointer to the optional enrichment items that remain.
 *  - NOT READY: exactly ONE primary action — the highest-value missing core
 *    item — plus the full per-item list. The owner is never shown 15 empty
 *    fields (prompt §17).
 */
const STATUS_STYLES = {
  complete: "text-success",
  partial: "text-warning",
  missing: "text-muted-foreground",
} as const;

const STATUS_ICONS = {
  complete: CheckCircle2Icon,
  partial: CircleDashedIcon,
  missing: CircleDashedIcon,
} as const;

export function AiReadinessCard({
  items,
  assistantName,
}: {
  items: ReadonlyArray<AiReadinessItem>;
  /** Raw stored `Business.assistantName` — resolved to the fallback here. */
  assistantName?: string | null;
}) {
  const ready = isAssistantReady(items);
  const next = nextReadinessAction(items);
  const complete = aiReadinessCompleteCount(items);
  const displayName = resolveAssistantName(assistantName);

  return (
    <section
      aria-label="المساعد الذكي"
      className="rounded-xl border bg-card p-5 shadow-xs sm:p-6"
    >
      <SectionHeader
        title="المساعد الذكي"
        description="اجعل مساعدك جاهزًا لاستقبال العملاء."
      />

      {ready ? (
        // ─── The positive READY state (prompt §16) ───────────────────────
        // States only that the minimum information is present — never that
        // the assistant is 100% accurate or answers every question.
        <div className="mt-4 space-y-4">
          <div className="flex items-start gap-3 rounded-lg border border-success/30 bg-success/5 p-4">
            <SparklesIcon
              aria-hidden
              className="mt-0.5 size-5 shrink-0 text-success"
            />
            <div className="min-w-0 space-y-1">
              <h3 className="text-sm font-semibold text-success">
                مساعدك جاهز
              </h3>
              <p className="text-xs leading-5 text-muted-foreground">
                تم إعداد المعلومات الأساسية ويمكن لـ{displayName} استقبال
                العملاء.
              </p>
            </div>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button asChild size="lg" className="sm:px-6">
              <Link href="/settings/assistant">إعدادات المساعد</Link>
            </Button>
            <Button asChild variant="outline" size="lg">
              <Link href={next?.href ?? "/settings"}>تعديل المعلومات</Link>
            </Button>
          </div>
        </div>
      ) : (
        // ─── The not-ready state: ONE primary action + the item list ──────
        <div className="mt-4 space-y-4">
          <p className="text-sm font-medium">مساعدك جاهز تقريبًا</p>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {complete} من {items.length} معلومات مكتملة — أساسيات فقط هي ما
            تحتاجه للبدء، والباقي اختياري.
          </p>
          {next ? (
            <Button asChild size="lg" className="sm:px-6">
              <Link href={next.href}>
                {next.key === "hours"
                  ? "إضافة أوقات العمل"
                  : next.key === "services"
                    ? "مراجعة الخدمات"
                    : next.key === "address"
                      ? "إضافة العنوان"
                      : "إكمال المعلومات"}
              </Link>
            </Button>
          ) : null}
        </div>
      )}

      <ul className="mt-5 divide-y divide-border">
        {items.map((item) => {
          const Icon = STATUS_ICONS[item.status];
          const count =
            typeof item.count === "number" ? ` (${item.count})` : "";
          return (
            <li key={item.key}>
              <Link
                href={item.href}
                className="group flex min-h-11 items-center gap-3 py-3 transition-colors hover:bg-accent/40 focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <Icon
                  aria-hidden
                  className={cn("size-5 shrink-0", STATUS_STYLES[item.status])}
                />
                <span className="min-w-0 flex-1 text-sm font-medium">
                  {item.label}
                  {count}
                </span>
                <span
                  className={cn(
                    "shrink-0 text-xs font-medium",
                    STATUS_STYLES[item.status],
                  )}
                >
                  {item.statusLabel}
                </span>
                <ChevronLeftIcon
                  aria-hidden
                  className="text-muted-foreground size-4 shrink-0 transition-transform group-hover:-translate-x-0.5"
                />
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
