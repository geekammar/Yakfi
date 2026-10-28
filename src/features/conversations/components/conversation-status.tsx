import { StatusBadge } from "@/components/shared/status-badge";
import { cn } from "@/lib/utils";
import type { ConversationStatus } from "@/types/domain";

const STATUS_LABELS: Record<ConversationStatus, string> = {
  AI_ACTIVE: "المساعد الذكي نشط",
  NEED_HUMAN: "يحتاج تدخلاً بشرياً",
  BOOKED: "محجوز",
  INCOMPLETE: "غير مكتملة",
};

export function ConversationStatusBadge({
  status,
  compact = false,
  className,
}: {
  status: ConversationStatus;
  compact?: boolean;
  className?: string;
}) {
  const values = {
    AI_ACTIVE: "ai-active",
    NEED_HUMAN: "need-human",
    BOOKED: "booked",
    INCOMPLETE: "incomplete",
  } as const;

  const label =
    compact && status === "AI_ACTIVE" ? "نشط" : STATUS_LABELS[status];

  return (
    <StatusBadge
      status={values[status]}
      aria-label={`حالة المحادثة: ${STATUS_LABELS[status]}`}
      className={cn("leading-tight", className)}
    >
      {label}
    </StatusBadge>
  );
}
