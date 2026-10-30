import type {
  CustomerDetailData,
  CustomerHistoryAppointment,
  CustomerHistoryConversation,
} from "@/features/customers/types";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import {
  APPOINTMENT_NOUNS,
  CONVERSATION_NOUNS,
  arabicCount,
} from "@/lib/arabic";
import { resolveStatus } from "@/lib/status";

import {
  ArrowRightIcon,
  CalendarDaysIcon,
  MessageCircleIcon,
  PhoneIcon,
  PlusIcon,
  UserRoundIcon,
} from "lucide-react";
import Link from "next/link";

/** Appointment enum → canonical status-system value (shared badges). */
const APPOINTMENT_STATUS_VALUES = {
  PENDING: "pending",
  CONFIRMED: "confirmed",
  CANCELLED: "cancelled",
  NO_SHOW: "no-show",
  COMPLETED: "completed",
} as const;

/** Conversation enum → canonical status-system value (shared badges). */
const CONVERSATION_STATUS_VALUES = {
  AI_ACTIVE: "ai-active",
  NEED_HUMAN: "need-human",
  BOOKED: "booked",
  INCOMPLETE: "incomplete",
} as const;

function formatDate(date: string) {
  return new Intl.DateTimeFormat("ar-EG", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(`${date}T00:00:00.000Z`));
}

function formatTime(time: string) {
  return new Intl.DateTimeFormat("ar-EG", {
    timeZone: "UTC",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(time));
}

function formatActivity(date: string) {
  return new Intl.DateTimeFormat("ar-EG", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(date));
}

/**
 * Customer detail (PROMPT-15): what happened with this customer —
 * identity + contact + notes, the full appointment history, and the
 * conversation history, each row navigable. Deliberately NOT a CRM
 * profile: operational context only, rendered server-side (links
 * only — no client state needed).
 */
export function CustomerDetailScreen({
  customer,
}: {
  customer: CustomerDetailData;
}) {
  const latestConversationId = customer.conversations[0]?.id ?? null;

  return (
    <div className="animate-fade-in-up space-y-6">
      <div className="flex items-center gap-3">
        <Button asChild variant="ghost" size="icon-sm">
          <Link href="/customers" aria-label="العودة إلى دليل العملاء">
            <ArrowRightIcon />
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-semibold sm:text-2xl">
            {customer.name}
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground" dir="ltr">
            <span className="tabular-nums">{customer.phone}</span>
          </p>
        </div>
        <Button asChild>
          {/* B-07 §A — book FOR this customer: the context is already
           * known, so the flow opens past العميل instead of asking
           * the user to search for the customer again. */}
          <Link href={`/appointments/new?customerId=${customer.id}`}>
            <PlusIcon />
            حجز موعد
          </Link>
        </Button>
      </div>

      <section className="rounded-xl border bg-card p-5 shadow-xs">
        <h2 className="mb-5 font-semibold">بيانات العميل</h2>
        <dl className="grid gap-5 sm:grid-cols-2">
          <Detail icon={UserRoundIcon} label="الاسم" value={customer.name} />
          <Detail
            icon={PhoneIcon}
            label="رقم الهاتف"
            value={customer.phone}
            ltr
          />
          {customer.email ? (
            <Detail
              icon={PhoneIcon}
              label="البريد الإلكتروني"
              value={customer.email}
              ltr
            />
          ) : null}
          <Detail
            icon={CalendarDaysIcon}
            label="أُضيف في"
            value={formatActivity(customer.createdAt)}
          />
        </dl>
        <div className="mt-6 border-t pt-5">
          <p className="text-xs text-muted-foreground">الملاحظات</p>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-7">
            {customer.notes ?? "لا توجد ملاحظات مسجلة لهذا العميل."}
          </p>
        </div>
        {latestConversationId ? (
          <div className="mt-6 border-t pt-5">
            <Button asChild variant="outline">
              <Link href={`/conversations/${latestConversationId}`}>
                <MessageCircleIcon />
                فتح أحدث محادثة
              </Link>
            </Button>
          </div>
        ) : null}
      </section>

      <section className="rounded-xl border bg-card p-5 shadow-xs">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="font-semibold">سجل المواعيد</h2>
          <span className="text-xs text-muted-foreground">
            {arabicCount(customer.appointments.length, APPOINTMENT_NOUNS)}
          </span>
        </div>
        {customer.appointments.length === 0 ? (
          <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
            لا توجد مواعيد لهذا العميل بعد.
          </p>
        ) : (
          <ul className="divide-y overflow-hidden rounded-lg border">
            {customer.appointments.map((appointment) => (
              <li key={appointment.id}>
                <Link
                  href={`/appointments/${appointment.id}`}
                  className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-muted/60 focus-visible:bg-muted/60"
                >
                  <AppointmentRowContent appointment={appointment} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border bg-card p-5 shadow-xs">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="font-semibold">سجل المحادثات</h2>
          <span className="text-xs text-muted-foreground">
            {arabicCount(customer.conversations.length, CONVERSATION_NOUNS)}
          </span>
        </div>
        {customer.conversations.length === 0 ? (
          <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
            لا توجد محادثات مع هذا العميل — تبدأ المحادثات تلقائياً عند تواصل
            العميل.
          </p>
        ) : (
          <ul className="divide-y overflow-hidden rounded-lg border">
            {customer.conversations.map((conversation) => (
              <li key={conversation.id}>
                <Link
                  href={`/conversations/${conversation.id}`}
                  className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-muted/60 focus-visible:bg-muted/60"
                >
                  <ConversationRowContent conversation={conversation} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function AppointmentRowContent({
  appointment,
}: {
  appointment: CustomerHistoryAppointment;
}) {
  const statusKey = APPOINTMENT_STATUS_VALUES[appointment.status];
  const statusDef = resolveStatus(statusKey);

  return (
    <>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">
          {appointment.service.name}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {formatDate(appointment.date)} ·{" "}
          <span className="tabular-nums">
            {formatTime(appointment.startTime)} -{" "}
            {formatTime(appointment.endTime)}
          </span>
        </p>
      </div>
      <StatusBadge
        status={statusKey}
        aria-label={`حالة الموعد: ${statusDef.labelAr}`}
      />
    </>
  );
}

function ConversationRowContent({
  conversation,
}: {
  conversation: CustomerHistoryConversation;
}) {
  const statusKey = CONVERSATION_STATUS_VALUES[conversation.status];
  const statusDef = resolveStatus(statusKey);

  return (
    <>
      <div className="min-w-0">
        <p className="text-sm font-medium">محادثة</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          آخر نشاط{" "}
          <time dateTime={conversation.lastActivityAt} className="tabular-nums">
            {formatActivity(conversation.lastActivityAt)}
          </time>
        </p>
      </div>
      <StatusBadge
        status={statusKey}
        aria-label={`حالة المحادثة: ${statusDef.labelAr}`}
      />
    </>
  );
}

function Detail({
  icon: Icon,
  label,
  value,
  ltr,
}: {
  icon: typeof UserRoundIcon;
  label: string;
  value: string;
  ltr?: boolean;
}) {
  return (
    <div className="flex gap-3">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
        <Icon className="size-4" aria-hidden />
      </div>
      <div className="min-w-0">
        <dt className="text-xs text-muted-foreground">{label}</dt>
        <dd className="mt-1 font-medium" dir={ltr ? "ltr" : undefined}>
          {value}
        </dd>
      </div>
    </div>
  );
}
