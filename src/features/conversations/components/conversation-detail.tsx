"use client";

import {
  assignConversation,
  sendStaffReply,
  transitionConversation,
  updateAiSummary,
} from "@/features/conversations/actions/conversation-actions";
import { ConversationStatusBadge } from "@/features/conversations/components/conversation-status";
import { HANDOFF_CAUSE_PRESENTATIONS } from "@/features/conversations/server/handoff-cause";
import type { ConversationDetailData } from "@/features/conversations/types";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ATTENTION_REASON_LABELS } from "@/lib/validation/operator-attention";

import {
  AlertCircleIcon,
  ArrowRightIcon,
  BotIcon,
  CalendarDaysIcon,
  CheckIcon,
  LoaderCircleIcon,
  MessageCircleIcon,
  SendIcon,
  UserRoundIcon,
  UsersRoundIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";

function formatMessageTime(date: string) {
  return new Intl.DateTimeFormat("ar-EG", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(date));
}

function formatAppointmentDate(date: string) {
  return new Intl.DateTimeFormat("ar-EG", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(`${date}T00:00:00`));
}

function formatAppointmentTime(date: string) {
  return new Intl.DateTimeFormat("ar-EG", {
    timeZone: "UTC",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(date));
}

/**
 * WHY the thread reached the operator (DECISIONS #62). Shown only on the
 * first load of an unacknowledged handoff — opening the thread acknowledges
 * the alert, so a reload legitimately renders nothing. Paired with the
 * persistent NEED_HUMAN status badge: the badge says the thread is human-
 * owned, this says the operational cause. Icon + Arabic text + a full
 * accessible name — the state is never color-only (DESIGN_SYSTEM §11).
 *
 * PROMPT-AI-ARCH-16 (Slice 7) — when a TYPED cause was recorded it becomes
 * the primary explanation (label + bounded description, Arabic-first); the
 * coarse reason stays as the accessible fallback. A staff-routed thread or a
 * legacy row carries no cause and renders the coarse reason alone.
 */
function AttentionReasonChip({
  reason,
  cause,
}: {
  reason: NonNullable<ConversationDetailData["attentionReason"]>;
  cause: ConversationDetailData["attentionCause"];
}) {
  const presentation = cause ? HANDOFF_CAUSE_PRESENTATIONS[cause] : null;
  const label = presentation
    ? presentation.label
    : ATTENTION_REASON_LABELS[reason];
  return (
    <span
      aria-label={`سبب انتباه المشغل: ${label}`}
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning-foreground"
      {...(presentation ? { title: presentation.description } : {})}
    >
      <AlertCircleIcon aria-hidden className="size-3" />
      {label}
    </span>
  );
}

function senderLabel(senderType: "CUSTOMER" | "AI" | "STAFF") {
  return senderType === "CUSTOMER"
    ? "العميل"
    : senderType === "AI"
      ? "المساعد الذكي"
      : "الفريق";
}

function appointmentStatusLabel(
  status: ConversationDetailData["appointments"][number]["status"],
) {
  return {
    PENDING: "قيد الانتظار",
    CONFIRMED: "مؤكد",
    CANCELLED: "ملغي",
    NO_SHOW: "لم يحضر",
    COMPLETED: "مكتمل",
  }[status];
}

/**
 * Actual assignee / responder badge (CONV-UI-01).
 * Informs the operator immediately who owns or is actively handling the
 * thread without requiring navigation to the sidebar or footer.
 */
function AssigneeResponderBadge({
  status,
  assignedUser,
  currentUserId,
}: {
  status: ConversationDetailData["status"];
  assignedUser: ConversationDetailData["assignedUser"];
  currentUserId: string;
}) {
  if (status === "AI_ACTIVE") {
    return (
      <span
        aria-label="المسؤول الحالي: المساعد الذكي"
        className="inline-flex shrink-0 items-center gap-1 rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary"
      >
        <BotIcon aria-hidden className="size-3" />
        <span>المساعد الذكي</span>
      </span>
    );
  }

  if (assignedUser) {
    const isCurrentUser = assignedUser.id === currentUserId;
    const name = isCurrentUser ? "أنت" : assignedUser.name;
    return (
      <span
        aria-label={`المسؤول الحالي: ${name}`}
        className="inline-flex shrink-0 items-center gap-1 rounded-full border border-info/30 bg-info/10 px-2 py-0.5 text-[11px] font-medium text-info-foreground"
      >
        <UserRoundIcon aria-hidden className="size-3" />
        <span className="max-w-[70px] truncate sm:max-w-[120px]">{name}</span>
      </span>
    );
  }

  if (status === "BOOKED") {
    return (
      <span
        aria-label="المسؤول الحالي: مكتمل الحجز"
        className="inline-flex shrink-0 items-center gap-1 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success-foreground"
      >
        <CheckIcon aria-hidden className="size-3" />
        <span>محجوز</span>
      </span>
    );
  }

  return (
    <span
      aria-label="المسؤول الحالي: غير معينة"
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning-foreground"
    >
      <UsersRoundIcon aria-hidden className="size-3" />
      <span>غير معينة</span>
    </span>
  );
}

function ContextCards({
  data,
  summary,
  setSummary,
  isPending,
  handleAssignment,
  handleSummarySave,
  handleTransition,
  showActions = false,
}: {
  data: ConversationDetailData;
  summary: string;
  setSummary: (value: string) => void;
  isPending: boolean;
  handleAssignment: (value: string) => void;
  handleSummarySave: () => void;
  handleTransition: (
    transition: "TAKE_OVER" | "RETURN_TO_AI" | "MARK_BOOKED" | "HANDOFF",
  ) => void;
  showActions?: boolean;
}) {
  return (
    <>
      {showActions ? (
        <section className="rounded-xl border bg-card p-4 shadow-xs">
          <div className="mb-3 flex items-center gap-2">
            <BotIcon className="size-4 text-primary" />
            <h2 className="font-semibold">إجراءات المحادثة</h2>
          </div>
          <div className="flex flex-wrap gap-2">
            {data.status === "AI_ACTIVE" ||
            (data.status === "NEED_HUMAN" && !data.assignedUser) ? (
              <Button
                type="button"
                size="sm"
                className="min-h-11 md:min-h-8"
                onClick={() => handleTransition("TAKE_OVER")}
                disabled={isPending}
              >
                <UserRoundIcon />
                تولّي المحادثة
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="min-h-11 md:min-h-8"
                onClick={() => handleTransition("RETURN_TO_AI")}
                disabled={isPending}
              >
                <BotIcon />
                إعادة للمساعد
              </Button>
            )}
            {data.status !== "BOOKED" ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="min-h-11 md:min-h-8"
                onClick={() => handleTransition("MARK_BOOKED")}
                disabled={isPending}
              >
                <CheckIcon />
                تحديد كمحجوز
              </Button>
            ) : null}
            {data.status === "AI_ACTIVE" ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="min-h-11 md:min-h-8"
                onClick={() => handleTransition("HANDOFF")}
                disabled={isPending}
              >
                <UsersRoundIcon />
                تحويل للفريق
              </Button>
            ) : null}
          </div>
        </section>
      ) : null}

      <section className="rounded-xl border bg-card p-4 shadow-xs">
        <div className="mb-3 flex items-center gap-2">
          <UserRoundIcon className="size-4 text-primary" />
          <h2 className="font-semibold">سياق العميل</h2>
        </div>
        <dl className="space-y-3 text-sm">
          <div>
            <dt className="text-xs text-muted-foreground">الاسم</dt>
            <dd className="mt-0.5 font-medium">{data.customer.name}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">رقم الهاتف</dt>
            <dd className="mt-0.5 font-medium" dir="ltr">
              {data.customer.phone}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">ملاحظات</dt>
            <dd className="mt-0.5 leading-6">
              {data.customer.notes ?? "لا توجد ملاحظات مسجلة."}
            </dd>
          </div>
        </dl>
      </section>

      <section className="rounded-xl border bg-card p-4 shadow-xs">
        <div className="mb-3 flex items-center gap-2">
          <CalendarDaysIcon className="size-4 text-primary" />
          <h2 className="font-semibold">سياق الحجز</h2>
        </div>
        {data.appointments.length === 0 ? (
          <p className="text-sm leading-6 text-muted-foreground">
            لا توجد مواعيد مرتبطة بهذا العميل.
          </p>
        ) : (
          <div className="space-y-3">
            {data.appointments.map((appointment) => (
              <div
                key={appointment.id}
                className="rounded-lg border bg-muted/30 p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="font-medium">{appointment.service.name}</p>
                  <span className="text-xs text-muted-foreground">
                    {appointmentStatusLabel(appointment.status)}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {formatAppointmentDate(appointment.date)} ·{" "}
                  {formatAppointmentTime(appointment.startTime)}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-xl border bg-card p-4 shadow-xs">
        <div className="mb-3 flex items-center gap-2">
          <UsersRoundIcon className="size-4 text-primary" />
          <h2 className="font-semibold">التعيين</h2>
        </div>
        <Label htmlFor="conversation-assignee" className="sr-only">
          تعيين عضو الفريق
        </Label>
        <Select
          value={data.assignedUser?.id ?? "UNASSIGNED"}
          onValueChange={handleAssignment}
          disabled={isPending}
        >
          <SelectTrigger id="conversation-assignee" className="w-full">
            <SelectValue placeholder="غير معينة" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="UNASSIGNED">غير معينة</SelectItem>
            {data.team.map((user) => (
              <SelectItem key={user.id} value={user.id}>
                {user.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </section>

      <section className="rounded-xl border bg-card p-4 shadow-xs">
        <div className="mb-3 flex items-center gap-2">
          <MessageCircleIcon className="size-4 text-primary" />
          <h2 className="font-semibold">ملخص المساعد</h2>
        </div>
        <Textarea
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          placeholder="أضف ملخصاً يساعد الفريق على فهم المحادثة…"
          aria-label="ملخص المساعد"
          rows={4}
          maxLength={4000}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={handleSummarySave}
          disabled={isPending || summary === data.aiSummary}
        >
          {isPending ? <LoaderCircleIcon className="animate-spin" /> : null}
          حفظ الملخص
        </Button>
      </section>
    </>
  );
}

export function ConversationDetail({
  data: initialData,
}: {
  data: ConversationDetailData;
}) {
  const [data, setData] = useState(initialData);
  const [reply, setReply] = useState("");
  const [summary, setSummary] = useState(initialData.aiSummary);
  const [error, setError] = useState<string | null>(null);
  const [pendingMessageId, setPendingMessageId] = useState<string | null>(null);
  const [mobileTab, setMobileTab] = useState<"messages" | "context">(
    "messages",
  );
  const [isPending, startTransition] = useTransition();
  const messageEndRef = useRef<HTMLDivElement>(null);
  const messageLogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (messageLogRef.current) {
      messageLogRef.current.scrollTop = messageLogRef.current.scrollHeight;
    }
  }, [data.messages.length]);

  async function runAction(
    action: () => Promise<{ success: boolean; message?: string }>,
  ) {
    setError(null);
    const result = await action();
    if (!result.success) {
      setError(result.message ?? "تعذر تنفيذ الإجراء");
      return false;
    }
    return true;
  }

  function handleTransition(
    transition: "TAKE_OVER" | "RETURN_TO_AI" | "MARK_BOOKED" | "HANDOFF",
  ) {
    startTransition(async () => {
      const success = await runAction(() =>
        transitionConversation({ id: data.id, transition }),
      );
      if (!success) return;
      const nextStatus = {
        TAKE_OVER: "NEED_HUMAN",
        RETURN_TO_AI: "AI_ACTIVE",
        MARK_BOOKED: "BOOKED",
        HANDOFF: "NEED_HUMAN",
      }[transition] as ConversationDetailData["status"];
      setData((current) => ({
        ...current,
        status: nextStatus,
        assignedUser:
          transition === "TAKE_OVER"
            ? {
                id: current.currentUserId,
                name: "أنت",
                image: null,
              }
            : transition === "RETURN_TO_AI"
              ? null
              : current.assignedUser,
      }));
    });
  }

  function handleAssignment(value: string) {
    startTransition(async () => {
      const assignedUserId = value === "UNASSIGNED" ? null : value;
      const success = await runAction(() =>
        assignConversation({ id: data.id, assignedUserId }),
      );
      if (!success) return;
      const assignee =
        data.team.find((user) => user.id === assignedUserId) ?? null;
      setData((current) => ({
        ...current,
        assignedUser: assignee,
        status: assignedUserId ? "NEED_HUMAN" : current.status,
      }));
    });
  }

  function handleReply(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = reply.trim();
    if (!content) return;

    // Optimistic append — rolled back if the server rejects the reply.
    const pendingId = crypto.randomUUID();
    setPendingMessageId(pendingId);
    setReply("");
    setData((current) => ({
      ...current,
      messages: [
        ...current.messages,
        {
          id: pendingId,
          senderType: "STAFF",
          content,
          createdAt: new Date().toISOString(),
        },
      ],
    }));

    startTransition(async () => {
      const success = await runAction(() =>
        sendStaffReply({ id: data.id, content }),
      );
      setPendingMessageId(null);
      if (!success) {
        setData((current) => ({
          ...current,
          messages: current.messages.filter(
            (message) => message.id !== pendingId,
          ),
        }));
        setReply(content);
        return;
      }
      setData((current) => ({
        ...current,
        status: "NEED_HUMAN",
        assignedUser: current.assignedUser ?? {
          id: current.currentUserId,
          name: "أنت",
          image: null,
        },
      }));
    });
  }

  function handleSummarySave() {
    startTransition(async () => {
      const success = await runAction(() =>
        updateAiSummary({ id: data.id, aiSummary: summary }),
      );
      if (success) {
        setData((current) => ({ ...current, aiSummary: summary.trim() }));
      }
    });
  }

  const actionButtons = (
    <>
      {data.status === "AI_ACTIVE" ||
      (data.status === "NEED_HUMAN" && !data.assignedUser) ? (
        <Button
          type="button"
          size="sm"
          className="min-h-11 md:min-h-8"
          onClick={() => handleTransition("TAKE_OVER")}
          disabled={isPending}
        >
          <UserRoundIcon />
          تولّي المحادثة
        </Button>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="min-h-11 md:min-h-8"
          onClick={() => handleTransition("RETURN_TO_AI")}
          disabled={isPending}
        >
          <BotIcon />
          إعادة للمساعد
        </Button>
      )}
      {data.status !== "BOOKED" ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="min-h-11 md:min-h-8"
          onClick={() => handleTransition("MARK_BOOKED")}
          disabled={isPending}
        >
          <CheckIcon />
          تحديد كمحجوز
        </Button>
      ) : null}
      {data.status === "AI_ACTIVE" ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="min-h-11 md:min-h-8"
          onClick={() => handleTransition("HANDOFF")}
          disabled={isPending}
        >
          <UsersRoundIcon />
          تحويل للفريق
        </Button>
      ) : null}
    </>
  );

  return (
    <div className="flex min-h-[calc(100dvh-7.5rem)] flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_300px] lg:items-start">
      <section
        style={{
          height: "var(--conversation-height, calc(100dvh - 11rem))",
          maxHeight: "var(--conversation-height, calc(100dvh - 11rem))",
          minHeight: 0,
        }}
        className="flex h-[calc(100dvh-11rem)] min-h-[28rem] flex-1 flex-col overflow-hidden rounded-xl border bg-card shadow-xs lg:h-[calc(100dvh-8.5rem)]"
      >
        <header
          data-testid="conversation-persistent-header"
          className="sticky top-0 z-20 flex flex-wrap items-center gap-1.5 sm:gap-2 border-b bg-card/95 backdrop-blur-xs px-3 py-2 sm:px-4 sm:py-3"
        >
          <Button
            asChild
            variant="ghost"
            size="icon-sm"
            className="min-h-11 min-w-11 md:min-h-8 md:min-w-8 lg:hidden"
          >
            <Link href="/conversations" aria-label="العودة إلى المحادثات">
              <ArrowRightIcon />
            </Link>
          </Button>
          <div className="flex size-8 sm:size-9 shrink-0 items-center justify-center rounded-full bg-accent text-xs sm:text-sm font-semibold text-accent-foreground">
            {data.customer.name.slice(0, 2)}
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-semibold">{data.customer.name}</h1>
            <p className="truncate text-xs text-muted-foreground" dir="ltr">
              {data.customer.phone}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            <ConversationStatusBadge status={data.status} />
            {data.attentionReason ? (
              <AttentionReasonChip
                reason={data.attentionReason}
                cause={data.attentionCause}
              />
            ) : null}
            <AssigneeResponderBadge
              status={data.status}
              assignedUser={data.assignedUser}
              currentUserId={data.currentUserId}
            />
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {/* B-07 §A — booking shortcut */}
            <Button
              asChild
              variant="outline"
              size="sm"
              className="min-h-11 md:min-h-8"
            >
              <Link href={`/appointments/new?customerId=${data.customer.id}`}>
                <CalendarDaysIcon aria-hidden className="size-4" />
                <span className="hidden sm:inline">حجز موعد</span>
                <span className="sm:hidden">حجز</span>
              </Link>
            </Button>
            {/* Mobile view toggle: messages vs context */}
            <Button
              type="button"
              variant={mobileTab === "context" ? "secondary" : "ghost"}
              size="sm"
              className="min-h-11 md:min-h-8 lg:hidden"
              onClick={() =>
                setMobileTab((current) =>
                  current === "messages" ? "context" : "messages",
                )
              }
              aria-label={
                mobileTab === "context"
                  ? "العودة إلى المحادثة"
                  : "عرض سياق العميل والمواعيد"
              }
            >
              {mobileTab === "context" ? (
                <>
                  <MessageCircleIcon aria-hidden className="size-4" />
                  <span className="text-xs">المحادثة</span>
                </>
              ) : (
                <>
                  <UserRoundIcon aria-hidden className="size-4" />
                  <span className="text-xs">السياق</span>
                </>
              )}
            </Button>
          </div>
        </header>

        {/* Desktop action toolbar */}
        <div className="hidden md:flex flex-wrap gap-2 border-b px-4 py-2.5">
          {actionButtons}
        </div>

        {/* Mobile context view when context tab is active */}
        {mobileTab === "context" ? (
          <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4 lg:hidden">
            <ContextCards
              data={data}
              summary={summary}
              setSummary={setSummary}
              isPending={isPending}
              handleAssignment={handleAssignment}
              handleSummarySave={handleSummarySave}
              handleTransition={handleTransition}
              showActions={true}
            />
          </div>
        ) : null}

        {/* Messages & Composer */}
        <div
          className={`min-h-0 flex-1 flex-col ${
            mobileTab === "context" ? "hidden lg:flex" : "flex"
          }`}
        >
          <div
            ref={messageLogRef}
            role="log"
            aria-label="رسائل المحادثة"
            tabIndex={0}
            className="flex-1 min-h-0 space-y-3 overflow-y-auto bg-muted/30 px-3 py-5 sm:px-5"
          >
            {/* Mobile unpinned action buttons inside transcript */}
            <div className="md:hidden flex flex-wrap gap-2 pb-3 mb-2 border-b border-border/50">
              {actionButtons}
            </div>
            {data.messages.length === 0 ? (
              <div className="flex h-full min-h-48 items-center justify-center text-sm text-muted-foreground">
                لا توجد رسائل في هذه المحادثة.
              </div>
            ) : (
              data.messages.map((message) => {
                const customer = message.senderType === "CUSTOMER";
                const ai = message.senderType === "AI";
                const sending = message.id === pendingMessageId;
                return (
                  <div
                    key={message.id}
                    className={`flex ${customer ? "justify-start" : "justify-end"}`}
                  >
                    <div
                      className={`max-w-[88%] space-y-1 sm:max-w-[72%] ${
                        customer
                          ? "rounded-e-xl rounded-es-xl bg-card"
                          : ai
                            ? "rounded-s-xl rounded-ee-xl bg-accent"
                            : "rounded-s-xl rounded-ee-xl bg-primary text-primary-foreground"
                      } px-3.5 py-2.5 shadow-xs transition-opacity duration-[var(--duration-normal)] ${
                        sending ? "opacity-60" : "opacity-100"
                      }`}
                    >
                      <div className="flex items-center gap-2 text-[11px] opacity-70">
                        <span>{senderLabel(message.senderType)}</span>
                        {sending ? (
                          <span role="status" aria-label="جارٍ الإرسال">
                            جارٍ الإرسال…
                          </span>
                        ) : (
                          <time dateTime={message.createdAt}>
                            {formatMessageTime(message.createdAt)}
                          </time>
                        )}
                      </div>
                      <p className="whitespace-pre-wrap text-sm leading-7">
                        {message.content}
                      </p>
                    </div>
                  </div>
                );
              })
            )}
            <div ref={messageEndRef} aria-hidden />
          </div>

          <form onSubmit={handleReply} className="border-t bg-card p-3 sm:p-4">
            <div className="flex items-end gap-2">
              <Textarea
                value={reply}
                onChange={(event) => setReply(event.target.value)}
                placeholder="اكتب ردك للعميل…"
                aria-label="رد على العميل"
                rows={2}
                maxLength={4096}
                className="max-h-32 min-h-11 resize-none"
              />
              <Button
                type="submit"
                size="icon-lg"
                className="min-h-11 min-w-11 md:min-h-10 md:min-w-10"
                aria-label="إرسال الرد"
                disabled={isPending || !reply.trim()}
              >
                {isPending ? (
                  <LoaderCircleIcon className="animate-spin" />
                ) : (
                  <SendIcon />
                )}
              </Button>
            </div>
            {error ? (
              <p role="alert" className="mt-2 text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </form>
        </div>
      </section>

      <aside className="hidden lg:block space-y-4">
        <ContextCards
          data={data}
          summary={summary}
          setSummary={setSummary}
          isPending={isPending}
          handleAssignment={handleAssignment}
          handleSummarySave={handleSummarySave}
          handleTransition={handleTransition}
          showActions={false}
        />
      </aside>
    </div>
  );
}
