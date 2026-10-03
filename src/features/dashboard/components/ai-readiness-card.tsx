import { SectionHeader } from "@/components/shared/section-header";
import {
  aiReadinessCompleteCount,
  type AiReadinessItem,
} from "@/lib/ai-readiness";
import { cn } from "@/lib/utils";

import {
  CheckCircle2Icon,
  ChevronLeftIcon,
  CircleDashedIcon,
} from "lucide-react";
import Link from "next/link";

/**
 * AI Readiness card (PROMPT-AI-OPS-21) — a lightweight, NON-BLOCKING
 * authoring aid. It shows, from actual stored data only, whether the
 * Business has the information the assistant uses to answer common customer
 * questions, and each row jumps to the EXISTING editor for that field
 * (settings / services / knowledge / working hours). It is NOT a business
 * score and NOT an AI quality score; it never gates usage and it invents
 * nothing — a missing item is simply reported as «ناقص».
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
}: {
  items: ReadonlyArray<AiReadinessItem>;
}) {
  const complete = aiReadinessCompleteCount(items);

  return (
    <section
      aria-label="معلومات المساعد"
      className="rounded-xl border bg-card p-5 shadow-xs sm:p-6"
    >
      <SectionHeader
        title="معلومات المساعد"
        description="أدخل أهم المعلومات عن نشاطك مرة واحدة، والمساعد يستخدمها للإجابة على العملاء."
      />
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {complete} من {items.length} معلومات مكتملة — اختيارية ولا تمنع
        الاستخدام.
      </p>
      <ul className="mt-4 divide-y divide-border">
        {items.map((item) => {
          const Icon = STATUS_ICONS[item.status];
          const count =
            typeof item.count === "number" ? ` (${item.count})` : "";
          return (
            <li key={item.key}>
              <Link
                href={item.href}
                className="group flex items-center gap-3 py-3 transition-colors hover:bg-accent/40 focus-visible:ring-[3px] focus-visible:ring-ring/50"
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
