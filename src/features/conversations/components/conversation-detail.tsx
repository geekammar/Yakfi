"use client";

import {
  assignConversation,
  sendStaffReply,
  transitionConversation,
  updateAiSummary,
} from "@/features/conversations/actions/conversation-actions";
import { ConversationActions } from "@/features/conversations/components/conversation-actions";
import { ConversationStatusBadge } from "@/features/conversations/components/conversation-status";
import {
  getStoredDraft,
  removeStoredDraft,
  setStoredDraft,
} from "@/features/conversations/lib/storage";
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
  LoaderCircleIcon,
  MessageCircleIcon,
  SendIcon,
  UserRoundIcon,
  UsersRoundIcon,
  XIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";

function formatMessageTime(date: string) {
  return new Intl.DateTimeFormat("ar-EG", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(date));
}

export function formatAppointmentDate(date: string) {
  const dateOnly = date.slice(0, 10);
  return new Intl.DateTimeFormat("ar-EG", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(`${dateOnly}T00:00:00.000Z`));
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
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[11px] leading-tight font-medium text-warning-foreground"
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
        className="inline-flex shrink-0 items-center gap-1 rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[11px] leading-tight font-medium text-primary"
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
        className="inline-flex shrink-0 items-center gap-1 rounded-full border border-info/30 bg-info/10 px-2 py-0.5 text-[11px] leading-tight font-medium text-info-foreground"
      >
        <UserRoundIcon aria-hidden className="size-3" />
        <span className="max-w-[70px] truncate sm:max-w-[120px]">{name}</span>
      </span>
    );
  }

  return (
    <span
      aria-label="المسؤول الحالي: غير معينة"
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[11px] leading-tight font-medium text-warning-foreground"
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
}: {
  data: ConversationDetailData;
  summary: string;
  setSummary: (value: string) => void;
  isPending: boolean;
  handleAssignment: (value: string) => void;
  handleSummarySave: () => void;
}) {
  return (
    <>
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

export type ConversationDetailProps = {
  data: ConversationDetailData;
  onTransition?: (payload: {
    id: string;
    transition: "TAKE_OVER" | "RETURN_TO_AI" | "MARK_BOOKED" | "HANDOFF";
  }) => Promise<{ success: boolean; message?: string }>;
  backHref?: string;
  businessId?: string;
};

export function ConversationDetail({
  data: initialData,
  onTransition,
  backHref,
  businessId: propBusinessId,
}: ConversationDetailProps) {
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

  const NEAR_BOTTOM_THRESHOLD_PX = 100;
  const initialScrolledRef = useRef(false);
  const ownSendPendingRef = useRef(false);
  const isNearBottomRef = useRef(true);
  const savedScrollTopRef = useRef<number>(0);

  const draftRevisionRef = useRef(0);
  const activeSubmissionRef = useRef<{
    rawDraft: string;
    revision: number;
  } | null>(null);
  const [failedSubmission, setFailedSubmission] = useState<string | null>(null);

  const effectiveBusinessId = propBusinessId ?? initialData.businessId;
  const effectiveUserId = initialData.currentUserId;

  // Track scroll position and proximity to bottom
  const handleLogScroll = () => {
    const el = messageLogRef.current;
    if (!el) return;
    savedScrollTopRef.current = el.scrollTop;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isNearBottomRef.current = distanceFromBottom <= NEAR_BOTTOM_THRESHOLD_PX;
  };

  // Ensure window scroll is at top so sticky header and persistent header are properly aligned
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, []);

  // Restore unsent draft across details toggle and Back navigation
  useEffect(() => {
    if (!effectiveBusinessId || !effectiveUserId) return;
    const savedDraft = getStoredDraft(
      effectiveBusinessId,
      effectiveUserId,
      data.id,
    );
    if (savedDraft) {
      queueMicrotask(() => {
        setReply(savedDraft);
      });
    }
  }, [effectiveBusinessId, effectiveUserId, data.id]);

  const handleReplyTextChange = (text: string) => {
    draftRevisionRef.current += 1;
    setReply(text);
    if (effectiveBusinessId && effectiveUserId) {
      setStoredDraft(effectiveBusinessId, effectiveUserId, data.id, text);
    }
  };
  // Initial scroll to bottom on mount
  useEffect(() => {
    const el = messageLogRef.current;
    if (!el || initialScrolledRef.current) return;
    el.scrollTop = el.scrollHeight;
    savedScrollTopRef.current = el.scrollTop;
    initialScrolledRef.current = true;
  }, []);

  // Follow messages when sending or near bottom; preserve reading position when reviewing older messages
  useEffect(() => {
    const el = messageLogRef.current;
    if (!el) return;

    if (!initialScrolledRef.current) {
      el.scrollTop = el.scrollHeight;
      savedScrollTopRef.current = el.scrollTop;
      initialScrolledRef.current = true;
      return;
    }

    if (ownSendPendingRef.current) {
      // Own-send: explicitly follow own message to bottom
      el.scrollTop = el.scrollHeight;
      savedScrollTopRef.current = el.scrollTop;
      isNearBottomRef.current = true;
      ownSendPendingRef.current = false;
      return;
    }

    if (isNearBottomRef.current) {
      // Already near bottom: follow incoming message
      el.scrollTop = el.scrollHeight;
      savedScrollTopRef.current = el.scrollTop;
    } else {
      // Reviewing older messages: preserve exact reading position
      el.scrollTop = savedScrollTopRef.current;
    }
  }, [data.messages.length]);

  // Explicit context-toggle behavior: restore reading position across mobile view switches
  useEffect(() => {
    if (mobileTab === "messages" && messageLogRef.current) {
      messageLogRef.current.scrollTop = savedScrollTopRef.current;
    }
  }, [mobileTab]);

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
        onTransition
          ? onTransition({ id: data.id, transition })
          : transitionConversation({ id: data.id, transition }),
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
    if (!content || isPending) return;

    ownSendPendingRef.current = true;

    // Optimistic append — rolled back if the server rejects the reply.
    const pendingId = crypto.randomUUID();
    setPendingMessageId(pendingId);

    // Keep recoverable raw draft snapshot and revision until confirmed success.
    const rawDraftSnapshot = reply;
    const submittedRevision = draftRevisionRef.current;
    activeSubmissionRef.current = {
      rawDraft: rawDraftSnapshot,
      revision: submittedRevision,
    };

    setReply("");
    setFailedSubmission(null);

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

      const submission = activeSubmissionRef.current;
      activeSubmissionRef.current = null;

      if (!success) {
        // Rollback optimistic message
        setData((current) => ({
          ...current,
          messages: current.messages.filter(
            (message) => message.id !== pendingId,
          ),
        }));

        // Failure handling:
        // Did operator type newer text while pending?
        const hasNewerText =
          draftRevisionRef.current > (submission?.revision ?? 0);

        if (!hasNewerText && submission?.rawDraft) {
          // If no newer text was typed, restore the failed submission directly
          setReply(submission.rawDraft);
          if (effectiveBusinessId && effectiveUserId) {
            setStoredDraft(
              effectiveBusinessId,
              effectiveUserId,
              data.id,
              submission.rawDraft,
            );
          }
        } else if (submission?.rawDraft) {
          // Newer text typed while pending:
          // Keep current newer draft UNCHANGED (no automatic concatenation!).
          // Preserve failed submission separately with explicit recovery affordance.
          setFailedSubmission(submission.rawDraft);
        }
        return;
      }

      // Success handling:
      // Remove only if not superseded by newer operator text
      const hasNewerText =
        draftRevisionRef.current > (submission?.revision ?? 0);

      if (!hasNewerText && effectiveBusinessId && effectiveUserId) {
        removeStoredDraft(effectiveBusinessId, effectiveUserId, data.id);
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

  return (
    <div className="flex min-h-[calc(100dvh-7.5rem)] flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_300px] lg:items-start">
      <section
        style={{
          height:
            "var(--conversation-height, calc(100dvh - 11rem - env(safe-area-inset-bottom, 0px)))",
          maxHeight:
            "var(--conversation-height, calc(100dvh - 11rem - env(safe-area-inset-bottom, 0px)))",
          minHeight: 0,
        }}
        className="flex h-[calc(100dvh-11rem)] min-h-[28rem] flex-1 flex-col overflow-hidden rounded-xl border bg-card shadow-xs lg:h-[calc(100dvh-8.5rem)]"
      >
        <header
          data-testid="conversation-persistent-header"
          className="sticky top-0 z-20 border-b bg-card/95 backdrop-blur-xs px-3 py-1 sm:px-4 sm:py-2.5 space-y-0.5 sm:space-y-2"
        >
          {/* Identity & Direct Actions Area */}
          <div className="flex flex-wrap lg:flex-nowrap items-center justify-between gap-1 sm:gap-2">
            {/* Customer Identity: independent layout area allowing up to 2 lines on narrow screens */}
            <div className="flex min-w-0 items-center gap-2 sm:gap-3 w-full lg:w-auto lg:flex-1">
              <Button
                asChild
                variant="ghost"
                size="icon-sm"
                className="min-h-11 min-w-11 md:min-h-8 md:min-w-8 shrink-0"
              >
                <Link
                  href={backHref ?? "/conversations"}
                  aria-label="العودة إلى المحادثات"
                >
                  <ArrowRightIcon />
                </Link>
              </Button>
              <div className="flex size-8 sm:size-9 shrink-0 items-center justify-center rounded-full bg-accent text-xs sm:text-sm font-semibold text-accent-foreground">
                {data.customer.name.slice(0, 2)}
              </div>
              <div className="min-w-0 flex-1">
                <h1 className="truncate line-clamp-2 whitespace-normal break-words font-semibold text-sm sm:text-base leading-tight sm:leading-snug">
                  {data.customer.name}
                </h1>
                <p className="truncate text-xs text-muted-foreground" dir="ltr">
                  {data.customer.phone}
                </p>
              </div>
            </div>

            {/* Direct Actions: wraps to its own row on mobile so customer name is never squeezed */}
            <div className="flex flex-wrap items-center gap-1 sm:gap-1.5">
              <ConversationActions
                data={data}
                isPending={isPending}
                handleTransition={handleTransition}
                mobileTab={mobileTab}
                setMobileTab={setMobileTab}
              />
            </div>
          </div>

          {/* Status, responder/assignee, and optional attention cause wrapping area */}
          <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 pt-0.5 border-t border-border/40 text-xs sm:gap-1.5 sm:pt-1.5">
            <ConversationStatusBadge status={data.status} compact />
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
        </header>

        {/* Mobile context view when details tab is active */}
        {mobileTab === "context" ? (
          <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4 lg:hidden">
            <ContextCards
              data={data}
              summary={summary}
              setSummary={setSummary}
              isPending={isPending}
              handleAssignment={handleAssignment}
              handleSummarySave={handleSummarySave}
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
            onScroll={handleLogScroll}
            className="flex-1 min-h-0 space-y-3 overflow-y-auto bg-muted/30 px-3 py-5 sm:px-5 [overflow-anchor:none]"
          >
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
            {failedSubmission ? (
              <div
                role="alert"
                aria-label="تنبيه تعذر إرسال الرد"
                className="mb-2.5 flex items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  <AlertCircleIcon className="size-4 shrink-0" />
                  <span className="truncate">
                    تعذر إرسال: &ldquo;{failedSubmission.trim()}&rdquo;
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => {
                      setReply(failedSubmission);
                      if (effectiveBusinessId && effectiveUserId) {
                        setStoredDraft(
                          effectiveBusinessId,
                          effectiveUserId,
                          data.id,
                          failedSubmission,
                        );
                      }
                      setFailedSubmission(null);
                    }}
                  >
                    استعادة الرد
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    aria-label="تجاهل الرد المتعثر"
                    onClick={() => setFailedSubmission(null)}
                  >
                    <XIcon className="size-3.5" />
                  </Button>
                </div>
              </div>
            ) : null}
            <div className="flex items-end gap-2">
              <Textarea
                value={reply}
                onChange={(event) => handleReplyTextChange(event.target.value)}
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

      <aside
        style={{
          maxHeight: "var(--conversation-height, calc(100dvh - 8.5rem))",
          minHeight: 0,
          overflowY: "auto",
        }}
        className="hidden lg:block space-y-4"
      >
        <ContextCards
          data={data}
          summary={summary}
          setSummary={setSummary}
          isPending={isPending}
          handleAssignment={handleAssignment}
          handleSummarySave={handleSummarySave}
        />
      </aside>
    </div>
  );
}
