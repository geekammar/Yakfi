"use client";

import { updateAppointmentStatus } from "@/features/appointments/actions/appointment-actions";
import { AppointmentStatusBadge } from "@/features/appointments/components/appointment-status";
import { FollowUpList } from "@/features/appointments/components/follow-up-list";
import { FollowUpModal } from "@/features/appointments/components/follow-up-modal";
import { ReschedulePanel } from "@/features/appointments/components/reschedule-panel";
import { ServiceCorrectionModal } from "@/features/appointments/components/service-correction-modal";
import { formatArabicDate } from "@/features/appointments/components/smart-create/date-format";
import { formatSlotTime } from "@/features/appointments/components/smart-create/slot-helpers";
import type { AppointmentDetailData } from "@/features/appointments/types";
import { Button } from "@/components/ui/button";
import { parseAppointmentEndUtc } from "@/lib/scheduling/reminder-time";
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
  SparklesIcon,
  UserRoundIcon,
  UserXIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore, useTransition } from "react";

/** Stored epoch-anchored time → the ONE shared business-local formatter
 * (the value's "HH:mm" IS the business-local wall clock, so slicing and
 * reusing the slot helper keeps every appointment surface identical). */
function formatTime(time: string) {
  return formatSlotTime(time.slice(11, 16));
}

const emptySubscribe = () => () => {};

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
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [followUps] =
    useState<FollowUpRequestWithRelations[]>(initialFollowUps);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const dateIso = data.date.slice(0, 10);
  const endTimeStr = data.endTime.includes("T")
    ? data.endTime.slice(11, 16)
    : data.endTime.slice(0, 5);
  const endUtc = parseAppointmentEndUtc({
    date: dateIso,
    endTime: endTimeStr,
    timezone,
  });
  const endUtcMs = endUtc.getTime();
  const hasEnded = useSyncExternalStore(
    emptySubscribe,
    () => Date.now() >= endUtcMs,
    () => false,
  );
  const isCompleted = data.status === "COMPLETED";
  const canCorrectService = isCompleted && hasEnded;

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
                label="الخدمة المحجوزة"
                value={data.service.name}
                hint={`${data.service.durationMinutes} دقيقة (الأصلية)`}
              />
              <Detail
                icon={SparklesIcon}
                label="الخدمة المنفذة"
                value={
                  data.performedService
                    ? data.performedService.name
                    : data.status === "COMPLETED"
                      ? `${data.service.name} (مطابقة للمحجوزة)`
                      : "لم تُسجل بعد"
                }
                hint={
                  data.serviceCorrectedAt
                    ? `تم التوثيق: ${new Date(data.serviceCorrectedAt).toLocaleDateString("ar-EG")}`
                    : undefined
                }
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
            {data.serviceCorrectionHistory &&
            data.serviceCorrectionHistory.length > 0 ? (
              <div className="mt-6 border-t pt-5 space-y-2">
                <p className="text-xs font-semibold text-muted-foreground">
                  سجل تصحيح الخدمة المنفذة
                </p>
                <div className="space-y-2">
                  {data.serviceCorrectionHistory.map((entry, idx) => (
                    <div
                      key={idx}
                      className="rounded-lg border bg-muted/20 p-2.5 text-xs space-y-1"
                    >
                      <div className="flex justify-between items-center text-muted-foreground">
                        <span>
                          بواسطة: {entry.correctedByName || "عضو الفريق"}
                        </span>
                        <span>
                          {new Date(entry.correctedAt).toLocaleDateString(
                            "ar-EG",
                          )}
                        </span>
                      </div>
                      <p className="font-medium text-foreground">
                        تعديل من &quot;
                        {entry.previousServiceName || entry.previousServiceId}
                        &quot; إلى &quot;
                        {entry.newServiceName || entry.newServiceId}&quot;
                      </p>
                      {entry.notes ? (
                        <p className="text-muted-foreground italic">
                          ملاحظة: {entry.notes}
                        </p>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
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
                {canCorrectService ? (
                  <Button
                    variant="outline"
                    onClick={() => setCorrectionOpen(true)}
                    disabled={isPending}
                  >
                    <SparklesIcon />
                    تسجيل / تصحيح الخدمة المنفذة
                  </Button>
                ) : isCompleted && !hasEnded ? (
                  <p className="text-xs text-muted-foreground p-2 rounded-lg bg-muted/40 text-center">
                    يصبح تسجيل الخدمة المنفذة متاحاً بعد انتهاء وقت الموعد
                    المحدد.
                  </p>
                ) : null}
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

      <ServiceCorrectionModal
        open={correctionOpen}
        onOpenChange={setCorrectionOpen}
        appointment={data}
        services={services}
        onSuccess={(updated) => {
          setData((current) => ({
            ...current,
            performedService: {
              id: updated.performedServiceId,
              name: updated.performedServiceName,
              durationMinutes:
                services.find((s) => s.id === updated.performedServiceId)
                  ?.durationMinutes ?? current.service.durationMinutes,
            },
            serviceCorrectedAt: updated.serviceCorrectedAt,
            updatedAt: updated.updatedAt,
          }));
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
