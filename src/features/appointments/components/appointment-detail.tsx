"use client";

import { updateAppointmentStatus } from "@/features/appointments/actions/appointment-actions";
import { AppointmentStatusBadge } from "@/features/appointments/components/appointment-status";
import { FollowUpList } from "@/features/appointments/components/follow-up-list";
import { FollowUpModal } from "@/features/appointments/components/follow-up-modal";
import { ReschedulePanel } from "@/features/appointments/components/reschedule-panel";
import { formatArabicDate } from "@/features/appointments/components/smart-create/date-format";
import { formatSlotTime } from "@/features/appointments/components/smart-create/slot-helpers";
import type { AppointmentDetailData } from "@/features/appointments/types";
import { Button } from "@/components/ui/button";
import type { FollowUpRequestWithRelations } from "@/types/domain";

import {
  ArrowRightIcon,
  CalendarClockIcon,
  CalendarPlusIcon,
  CheckIcon,
  CircleXIcon,
  Clock3Icon,
  LoaderCircleIcon,
  MessageCircleIcon,
  RotateCwIcon,
  UserRoundIcon,
  UserXIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/** Stored epoch-anchored time → the ONE shared business-local formatter
 * (the value's "HH:mm" IS the business-local wall clock, so slicing and
 * reusing the slot helper keeps every appointment surface identical). */
function formatTime(time: string) {
  return formatSlotTime(time.slice(11, 16));
}

export function AppointmentDetail({
  initialData,
  today,
  timezone,
  workingHours,
  slotDurationMinutes,
  initialRescheduling,
  initialFollowUps = [],
  services = [],
  providers = [],
  initialFollowUpOpen = false,
}: {
  initialData: AppointmentDetailData;
  /** Business-local "YYYY-MM-DD" today (server-derived). */
  today: string;
  /** Business timezone (server-derived) — display only. */
  timezone: string;
  /** The candidate-grid inputs for the reschedule slot step (DECISIONS #56). */
  workingHours?: unknown;
  slotDurationMinutes?: number | null;
  initialRescheduling?: boolean;
  initialFollowUps?: FollowUpRequestWithRelations[];
  services?: Array<{ id: string; name: string; durationMinutes: number }>;
  providers?: Array<{ id: string; name: string; displayName?: string | null }>;
  initialFollowUpOpen?: boolean;
}) {
  const router = useRouter();
  const [data, setData] = useState(initialData);
  const [rescheduling, setRescheduling] = useState(
    initialRescheduling ?? false,
  );
  const [followUpOpen, setFollowUpOpen] = useState(initialFollowUpOpen);
  const [followUps] =
    useState<FollowUpRequestWithRelations[]>(initialFollowUps);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function changeStatus(
    status: "CONFIRMED" | "CANCELLED" | "COMPLETED" | "NO_SHOW",
  ) {
    const previousStatus = data.status;
    setError(null);
    // Optimistic transition — rolled back if the server rejects it.
    setData((current) => ({ ...current, status }));
    startTransition(async () => {
      const result = await updateAppointmentStatus({ id: data.id, status });
      if (!result.success) {
        setData((current) => ({ ...current, status: previousStatus }));
        setError(result.message);
      }
    });
  }

  /**
   * B-08 — a confirmed reschedule hands back the values the SERVER
   * persisted. They are applied verbatim; the client never recomputes
   * endTime or the date, and any optimistic drift is discarded in favor
   * of the authoritative row.
   */
  function handleRescheduleDone(updated: {
    date: string;
    startTime: string;
    endTime: string;
  }) {
    setData((current) => ({
      ...current,
      date: updated.date,
      startTime: `1970-01-01T${updated.startTime}:00.000Z`,
      endTime: `1970-01-01T${updated.endTime}:00.000Z`,
    }));
    setError(null);
    setRescheduling(false);
  }

  const active = data.status === "PENDING" || data.status === "CONFIRMED";

  return (
    <div className="animate-fade-in-up space-y-6">
      <div className="flex items-center gap-3">
        <Button asChild variant="ghost" size="icon-sm">
          <Link
            href={`/appointments?date=${data.date}`}
            aria-label="العودة إلى جدول المواعيد"
          >
            <ArrowRightIcon />
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-semibold sm:text-2xl">
            موعد {data.customer.name}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            تفاصيل الموعد والإجراءات المتاحة.
          </p>
        </div>
        <AppointmentStatusBadge status={data.status} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-6">
          <section className="rounded-xl border bg-card p-5 shadow-xs">
            <h2 className="mb-5 font-semibold">تفاصيل الموعد</h2>
            <dl className="grid gap-5 sm:grid-cols-2">
              <Detail
                icon={UserRoundIcon}
                label="العميل"
                value={data.customer.name}
                hint={data.customer.phone}
              />
              <Detail
                icon={CalendarClockIcon}
                label="الخدمة"
                value={data.service.name}
                hint={`${data.service.durationMinutes} دقيقة`}
              />
              <Detail
                icon={CalendarClockIcon}
                label="التاريخ"
                value={formatArabicDate(data.date)}
              />
              <Detail
                icon={Clock3Icon}
                label="الوقت"
                value={`${formatTime(data.startTime)} - ${formatTime(data.endTime)}`}
              />
            </dl>
            <div className="mt-6 border-t pt-5">
              <p className="text-xs text-muted-foreground">الملاحظات</p>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-7">
                {data.notes ?? "لا توجد ملاحظات لهذا الموعد."}
              </p>
            </div>
            <div className="mt-6 border-t pt-5">
              {data.conversationId ? (
                <Button asChild variant="outline">
                  <Link href={`/conversations/${data.conversationId}`}>
                    <MessageCircleIcon />
                    فتح محادثة العميل
                  </Link>
                </Button>
              ) : (
                <p className="text-sm text-muted-foreground">
                  لا توجد محادثة مرتبطة بهذا العميل.
                </p>
              )}
            </div>
          </section>

          <FollowUpList
            followUps={followUps}
            onRefresh={() => router.refresh()}
          />
        </div>

        <aside className="space-y-4">
          {!rescheduling ? (
            <section className="rounded-xl border bg-card p-4 shadow-xs">
              <h2 className="mb-3 font-semibold">إجراءات الموعد</h2>
              <div className="grid gap-2">
                {data.status === "PENDING" ? (
                  <Button
                    onClick={() => changeStatus("CONFIRMED")}
                    disabled={isPending}
                  >
                    <CheckIcon />
                    تأكيد الموعد
                  </Button>
                ) : null}
                {active ? (
                  <Button
                    variant="outline"
                    onClick={() => setRescheduling(true)}
                    disabled={isPending}
                  >
                    <RotateCwIcon />
                    إعادة الجدولة
                  </Button>
                ) : null}
                <Button
                  variant="outline"
                  onClick={() => setFollowUpOpen(true)}
                  disabled={isPending}
                >
                  <CalendarPlusIcon />
                  إضافة متابعة
                </Button>
                {data.status === "CONFIRMED" ? (
                  <>
                    <Button
                      variant="outline"
                      onClick={() => changeStatus("COMPLETED")}
                      disabled={isPending}
                    >
                      <CheckIcon />
                      تحديد كمكتمل
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => changeStatus("NO_SHOW")}
                      disabled={isPending}
                    >
                      <UserXIcon />
                      تحديد كلم يحضر
                    </Button>
                  </>
                ) : null}
                {active ? (
                  <Button
                    variant="destructive"
                    onClick={() => changeStatus("CANCELLED")}
                    disabled={isPending}
                  >
                    <CircleXIcon />
                    إلغاء الموعد
                  </Button>
                ) : null}
              </div>
              {isPending ? (
                <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                  <LoaderCircleIcon className="size-3.5 animate-spin" />
                  جارٍ الحفظ…
                </p>
              ) : null}
              {error ? (
                <p role="alert" className="mt-3 text-sm text-destructive">
                  {error}
                </p>
              ) : null}
            </section>
          ) : (
            <ReschedulePanel
              appointment={data}
              today={today}
              timezone={timezone}
              workingHours={workingHours}
              slotDurationMinutes={slotDurationMinutes}
              onDone={handleRescheduleDone}
              onCancel={() => {
                setError(null);
                setRescheduling(false);
              }}
            />
          )}
        </aside>
      </div>

      <FollowUpModal
        open={followUpOpen}
        onOpenChange={setFollowUpOpen}
        appointment={data}
        today={today}
        services={services}
        providers={providers}
        workingHours={workingHours}
        onSuccess={() => {
          router.refresh();
        }}
      />
    </div>
  );
}

function Detail({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof UserRoundIcon;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="flex gap-3">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
        <Icon className="size-4" aria-hidden />
      </div>
      <div className="min-w-0">
        <dt className="text-xs text-muted-foreground">{label}</dt>
        <dd className="mt-1 font-medium">{value}</dd>
        {hint ? (
          <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
        ) : null}
      </div>
    </div>
  );
}
