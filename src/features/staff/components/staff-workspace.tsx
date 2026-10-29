"use client";

import {
  HANDOFF_CAUSE_PRESENTATIONS,
  type HandoffCause,
} from "@/features/conversations/server/handoff-cause";
import { formatArabicDayMonth } from "@/features/appointments/components/smart-create/date-format";
import type {
  StaffAssignedItem,
  StaffQueueItem,
  TakeOverConversationAction,
} from "@/features/staff/types";
import { EmptyState } from "@/components/shared/empty-state";
import { SectionHeader } from "@/components/shared/section-header";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { CONVERSATION_NOUNS, arabicCount } from "@/lib/arabic";
import { ATTENTION_REASON_LABELS } from "@/lib/validation/operator-attention";
import type { AppointmentStatus, ConversationStatus } from "@/types/domain";

import {
  AlertCircleIcon,
  CalendarDaysIcon,
  CheckCircle2Icon,
  LoaderCircleIcon,
  UserRoundIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

const TAKEOVER_FAILED_MESSAGE = "تعذر تولي المحادثة الآن";

function conversationStatus(status: ConversationStatus) {
  const values = {
    AI_ACTIVE: "ai-active",
    NEED_HUMAN: "need-human",
    BOOKED: "booked",
    INCOMPLETE: "incomplete",
  } as const;
  return values[status];
}

function appointmentStatusLabel(status: AppointmentStatus) {
  return {
    PENDING: "قيد الانتظار",
    CONFIRMED: "مؤكد",
    CANCELLED: "ملغي",
    NO_SHOW: "لم يحضر",
    COMPLETED: "مكتمل",
  }[status];
}

function formatActivity(date: string) {
  const today = new Intl.DateTimeFormat("en-CA").format(new Date());
  const activityDay = new Intl.DateTimeFormat("en-CA").format(new Date(date));
  if (today === activityDay) {
    return new Intl.DateTimeFormat("ar-EG", {
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(date));
  }
  return new Intl.DateTimeFormat("ar-EG", {
    day: "numeric",
    month: "short",
  }).format(new Date(date));
}

export function formatAppointmentDate(date: string) {
  const dateOnly = date.slice(0, 10);
  return formatArabicDayMonth(dateOnly);
}

function formatAppointmentTime(time: string) {
  return new Intl.DateTimeFormat("ar-EG", {
    timeZone: "UTC",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(time));
}

function initials(name: string) {
  return name.trim().slice(0, 2);
}

function previewPrefix(senderType: "CUSTOMER" | "AI" | "STAFF") {
  return senderType === "STAFF"
    ? "الفريق: "
    : senderType === "AI"
      ? "المساعد: "
      : "";
}

/**
 * The unacknowledged-attention marker (PROMPT-B04) — the operational
 * "this one is still waiting for you" chip: why the assistant did not
 * answer, in plain operator language. Carries no AI internals (no prompts,
 * no chain-of-thought, no provider details). Shown to the operator only.
 *
 * PROMPT-AI-ARCH-16 (Slice 7) — when a TYPED cause was recorded it becomes
 * the primary explanation (the plain "why does this need me?" label + a
 * bounded description on hover/title); the coarse reason stays as the
 * operational category underneath. A staff-routed thread or a legacy row
 * carries no cause and falls back to the coarse reason alone.
 */
function AttentionMarker({ item }: { item: StaffQueueItem }) {
  if (!item.hasAttention || !item.attentionReason) return null;
  const cause = item.attentionCause;
  const presentation = cause
    ? HANDOFF_CAUSE_PRESENTATIONS[cause as HandoffCause]
    : null;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning-foreground"
      {...(presentation ? { title: presentation.description } : {})}
    >
      <AlertCircleIcon aria-hidden className="size-3" />
      {presentation
        ? presentation.label
        : ATTENTION_REASON_LABELS[item.attentionReason]}
    </span>
  );
}

/** Assignment state indicator — server-derived, never client input. */
function AssignmentIndicator({ item }: { item: StaffQueueItem }) {
  if (item.assignment === "mine") {
    return (
      <span className="text-primary inline-flex shrink-0 items-center gap-1 text-[11px] font-medium">
        <UserRoundIcon aria-hidden className="size-3" />
        معينة إليك
      </span>
    );
  }
  return (
    <span className="text-muted-foreground inline-flex shrink-0 items-center gap-1 text-[11px]">
      <UserRoundIcon aria-hidden className="size-3" />
      {item.assignment === "other" && item.assignedUserName
        ? `معينة إلى ${item.assignedUserName}`
        : "غير معينة"}
    </span>
  );
}

function AppointmentContext({
  appointment,
}: {
  appointment: StaffQueueItem["latestAppointment"];
}) {
  if (!appointment) return null;
  return (
    <p className="text-muted-foreground flex items-center gap-1 truncate text-xs">
      <CalendarDaysIcon aria-hidden className="size-3 shrink-0" />
      <span className="truncate">
        {appointment.serviceName} · {formatAppointmentDate(appointment.date)} ·{" "}
        {formatAppointmentTime(appointment.startTime)} ·{" "}
        {appointmentStatusLabel(appointment.status)}
      </span>
    </p>
  );
}

function MessagePreview({
  lastMessage,
}: {
  lastMessage: StaffQueueItem["lastMessage"];
}) {
  const content = lastMessage
    ? `${previewPrefix(lastMessage.senderType)}${lastMessage.content}`
    : "لا توجد رسائل";
  return <p className="text-muted-foreground truncate text-xs">{content}</p>;
}

/**
 * The staff workspace (PROMPT-17): a calm human-handoff queue —
 * ATTENTION (unassigned NEED_HUMAN first), then the actor's own
 * conversations. Takeover reuses the conversations feature's existing
 * action (route-injected — no second assignment system); replying and
 * full customer/appointment context live in the existing conversation
 * detail screen.
 */
export function StaffWorkspace({
  queue,
  assigned,
  takeOver,
}: {
  queue: StaffQueueItem[];
  assigned: StaffAssignedItem[];
  /**
   * The conversations feature's takeover action, composed at the route
   * layer (feature isolation preserved — same pattern as the team
   * directory's invite dialog).
   */
  takeOver: TakeOverConversationAction;
}) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleTakeOver(id: string) {
    setError(null);
    setPendingId(id);
    try {
      const result = await takeOver({ id, transition: "TAKE_OVER" });
      if (!result.success) {
        setError(result.message ?? TAKEOVER_FAILED_MESSAGE);
        setPendingId(null);
        return;
      }
      // Ownership confirmed server-side — open the existing thread.
      router.push(`/conversations/${id}`);
    } catch {
      setError(TAKEOVER_FAILED_MESSAGE);
      setPendingId(null);
    }
  }

  return (
    <div className="space-y-8">
      <section>
        <SectionHeader
          title="تحتاج تدخلاً بشرياً"
          description="محادثات تنتظر رداً من الفريق — ابدأ بغير المعينة."
        />
        <p aria-live="polite" className="text-muted-foreground sr-only text-xs">
          {arabicCount(queue.length, CONVERSATION_NOUNS)}
        </p>
        {queue.length === 0 ? (
          <EmptyState
            className="bg-card min-h-56"
            icon={CheckCircle2Icon}
            title="لا توجد محادثات تحتاج تدخلاً"
            description="كل شيء هادئ الآن. ستظهر هنا أي محادثة فور تحويلها إلى الفريق."
            action={
              <Button asChild variant="outline" size="sm">
                <Link href="/conversations">فتح المحادثات</Link>
              </Button>
            }
          />
        ) : (
          <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs">
            {queue.map((item) => (
              <li key={item.id} className="px-4 py-3.5">
                <div className="flex items-start gap-3">
                  <div className="bg-accent text-accent-foreground flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold">
                    {initials(item.customer.name)}
                  </div>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <p className="truncate font-medium">
                        {item.customer.name}
                      </p>
                      <AssignmentIndicator item={item} />
                      <AttentionMarker item={item} />
                    </div>
                    <MessagePreview lastMessage={item.lastMessage} />
                    <AppointmentContext appointment={item.latestAppointment} />
                    <div className="flex flex-wrap items-center gap-2 pt-0.5">
                      <StatusBadge status={conversationStatus("NEED_HUMAN")} />
                      <time
                        dateTime={item.lastActivityAt}
                        className="text-muted-foreground text-[11px] tabular-nums"
                      >
                        {formatActivity(item.lastActivityAt)}
                      </time>
                    </div>
                  </div>
                </div>
                <div className="mt-2.5">
                  {item.assignment === "unassigned" ? (
                    <Button
                      type="button"
                      size="sm"
                      className="w-full sm:w-auto"
                      onClick={() => handleTakeOver(item.id)}
                      disabled={pendingId !== null}
                    >
                      {pendingId === item.id ? (
                        <LoaderCircleIcon className="animate-spin" />
                      ) : (
                        <UserRoundIcon />
                      )}
                      تولّي المحادثة
                    </Button>
                  ) : item.assignment === "mine" ? (
                    <Button
                      asChild
                      variant="outline"
                      size="sm"
                      className="w-full sm:w-auto"
                    >
                      <Link href={`/conversations/${item.id}`}>
                        متابعة المحادثة
                      </Link>
                    </Button>
                  ) : (
                    <Button
                      asChild
                      variant="ghost"
                      size="sm"
                      className="w-full sm:w-auto"
                    >
                      <Link href={`/conversations/${item.id}`}>
                        عرض المحادثة
                      </Link>
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <SectionHeader
          title="معينة إليك"
          description="محادثات تتولى التعامل معها."
        />
        {assigned.length === 0 ? (
          <p className="text-muted-foreground rounded-xl border border-dashed px-4 py-6 text-center text-sm">
            {queue.length === 0
              ? "لا توجد محادثات معينة إليك حالياً."
              : "عند تولّيك محادثة ستظهر هنا لمتابعتها."}
          </p>
        ) : (
          <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs">
            {assigned.map((item) => (
              <li key={item.id} className="px-4 py-3.5">
                <div className="flex items-start gap-3">
                  <div className="bg-accent text-accent-foreground flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold">
                    {initials(item.customer.name)}
                  </div>
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="truncate font-medium">{item.customer.name}</p>
                    <MessagePreview lastMessage={item.lastMessage} />
                    <AppointmentContext appointment={item.latestAppointment} />
                    <div className="flex flex-wrap items-center gap-2 pt-0.5">
                      <StatusBadge status={conversationStatus(item.status)} />
                      <time
                        dateTime={item.lastActivityAt}
                        className="text-muted-foreground text-[11px] tabular-nums"
                      >
                        {formatActivity(item.lastActivityAt)}
                      </time>
                    </div>
                  </div>
                  <Button
                    asChild
                    variant="outline"
                    size="sm"
                    className="hidden shrink-0 sm:inline-flex"
                  >
                    <Link href={`/conversations/${item.id}`}>
                      متابعة المحادثة
                    </Link>
                  </Button>
                </div>
                <div className="mt-2.5 sm:hidden">
                  <Button
                    asChild
                    variant="outline"
                    size="sm"
                    className="w-full"
                  >
                    <Link href={`/conversations/${item.id}`}>
                      متابعة المحادثة
                    </Link>
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {error ? (
        <div
          role="alert"
          className="text-destructive rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm"
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}
