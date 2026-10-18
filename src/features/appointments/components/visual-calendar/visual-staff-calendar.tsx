"use client";

import { AppointmentStatusBadge } from "@/features/appointments/components/appointment-status";
import {
  formatArabicDate,
  moveDate,
} from "@/features/appointments/components/smart-create/date-format";
import { formatSlotTime } from "@/features/appointments/components/smart-create/slot-helpers";
import type { AppointmentAgendaItem } from "@/features/appointments/types";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { APPOINTMENT_NOUNS, arabicCount } from "@/lib/arabic";
import {
  resolveWorkingHours,
  toMinutes,
  toWallClock,
} from "@/lib/scheduling/slot-grid";
import { cn } from "@/lib/utils";

import {
  CalendarOffIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  Clock3Icon,
  PlusIcon,
  SparklesIcon,
  UserCheckIcon,
  UsersIcon,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

function formatTime(iso: string) {
  return formatSlotTime(iso.slice(11, 16));
}

function formatDurationMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} دقيقة`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  if (remaining === 0) {
    return hours === 1
      ? "ساعة واحدة"
      : hours === 2
        ? "ساعتان"
        : `${hours} ساعات`;
  }
  return `${hours} س و ${remaining} د`;
}

type VisualStaffCalendarProps = {
  items: AppointmentAgendaItem[];
  date: string;
  today: string;
  workingHours?: unknown;
  slotDurationMinutes?: number;
  providers?: Array<{
    id: string;
    name: string;
    displayName?: string | null;
  }>;
  onNavigateDate: (nextDate: string) => void;
  isPending?: boolean;
  onConfirmAppointment?: (id: string) => void;
};

type TimelineSegment =
  | {
      type: "appointment";
      appointment: AppointmentAgendaItem;
      startMinutes: number;
      endMinutes: number;
      durationMinutes: number;
    }
  | {
      type: "available";
      startMinutes: number;
      endMinutes: number;
      durationMinutes: number;
      startTime: string;
      endTime: string;
    };

export function VisualStaffCalendar({
  items,
  date,
  today,
  workingHours,
  slotDurationMinutes: _slotDurationMinutes = 30,
  providers = [],
  onNavigateDate,
  isPending = false,
  onConfirmAppointment,
}: VisualStaffCalendarProps) {
  void _slotDurationMinutes;
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(
    null,
  );

  const workingDay = useMemo(
    () => resolveWorkingHours(workingHours, date),
    [workingHours, date],
  );

  // Active appointments that occupy working time
  const activeOccupyingAppointments = useMemo(() => {
    return items.filter((item) => {
      if (selectedProviderId) {
        if (item.provider?.id !== selectedProviderId) return false;
      }
      return (
        item.status === "CONFIRMED" ||
        item.status === "PENDING" ||
        item.status === "COMPLETED"
      );
    });
  }, [items, selectedProviderId]);

  // Compute timeline segments (occupied appointments + available intervals)
  const { segments, totalBookedMinutes, totalAvailableMinutes } =
    useMemo(() => {
      if (!workingDay) {
        return {
          segments: [],
          totalBookedMinutes: 0,
          totalAvailableMinutes: 0,
        };
      }

      const open = workingDay.openMinutes;
      const close = workingDay.closeMinutes;
      const totalDayMinutes = Math.max(0, close - open);

      // Sort active appointments chronologically
      const sorted = [...activeOccupyingAppointments].sort((a, b) => {
        const aStart = toMinutes(a.startTime.slice(11, 16));
        const bStart = toMinutes(b.startTime.slice(11, 16));
        return aStart - bStart;
      });

      const list: TimelineSegment[] = [];
      let cursor = open;
      let bookedMinutes = 0;

      for (const app of sorted) {
        const appStart = toMinutes(app.startTime.slice(11, 16));
        const appEnd = toMinutes(app.endTime.slice(11, 16));
        const duration = Math.max(0, appEnd - appStart);

        // Clamped to working day
        const clampedStart = Math.max(open, Math.min(close, appStart));
        const clampedEnd = Math.max(open, Math.min(close, appEnd));

        // Free gap before this appointment
        if (clampedStart > cursor) {
          const gapDuration = clampedStart - cursor;
          list.push({
            type: "available",
            startMinutes: cursor,
            endMinutes: clampedStart,
            durationMinutes: gapDuration,
            startTime: toWallClock(cursor),
            endTime: toWallClock(clampedStart),
          });
        }

        // Add the appointment segment
        list.push({
          type: "appointment",
          appointment: app,
          startMinutes: clampedStart,
          endMinutes: clampedEnd,
          durationMinutes: duration,
        });

        bookedMinutes += duration;
        cursor = Math.max(cursor, clampedEnd);
      }

      // Trailing free gap after last appointment until close of day
      if (cursor < close) {
        const remainingGap = close - cursor;
        list.push({
          type: "available",
          startMinutes: cursor,
          endMinutes: close,
          durationMinutes: remainingGap,
          startTime: toWallClock(cursor),
          endTime: toWallClock(close),
        });
      }

      const availableMinutes = Math.max(0, totalDayMinutes - bookedMinutes);

      return {
        segments: list,
        totalBookedMinutes: bookedMinutes,
        totalAvailableMinutes: availableMinutes,
      };
    }, [workingDay, activeOccupyingAppointments]);

  // Appointment counts per provider
  const appointmentCountByProvider = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) {
      if (item.provider?.id) {
        counts.set(item.provider.id, (counts.get(item.provider.id) ?? 0) + 1);
      }
    }
    return counts;
  }, [items]);

  return (
    <div className="space-y-5">
      {/* ─── Day Navigation Header ─── */}
      <div className="rounded-xl border bg-card p-3.5 shadow-xs sm:p-4">
        <div className="flex items-center justify-between gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="اليوم السابق"
            onClick={() => onNavigateDate(moveDate(date, -1))}
            disabled={isPending}
          >
            <ChevronRightIcon className="size-5" />
          </Button>
          <div className="min-w-0 text-center">
            <h2 className="truncate font-semibold text-base sm:text-lg">
              {formatArabicDate(date)}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {date === today ? "اليوم · " : ""}
              {arabicCount(items.length, APPOINTMENT_NOUNS)}
              {workingDay ? (
                <span>
                  {" · "}
                  ساعات العمل:{" "}
                  {formatSlotTime(toWallClock(workingDay.openMinutes))} –{" "}
                  {formatSlotTime(toWallClock(workingDay.closeMinutes))}
                </span>
              ) : null}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="اليوم التالي"
            onClick={() => onNavigateDate(moveDate(date, 1))}
            disabled={isPending}
          >
            <ChevronLeftIcon className="size-5" />
          </Button>
        </div>
        {date !== today ? (
          <div className="mt-2 text-center">
            <Button
              type="button"
              variant="link"
              size="sm"
              onClick={() => onNavigateDate(today)}
            >
              العودة إلى اليوم
            </Button>
          </div>
        ) : null}
      </div>

      {/* ─── Provider Filter Chips (only when multiple providers exist) ─── */}
      {providers.length > 1 ? (
        <section aria-label="تصفية حسب مقدم الخدمة" className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              مقدمو الخدمة
            </span>
            {selectedProviderId ? (
              <button
                type="button"
                onClick={() => setSelectedProviderId(null)}
                className="text-xs text-primary underline-offset-4 hover:underline"
              >
                عرض كل الفريق
              </button>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setSelectedProviderId(null)}
              className={cn(
                "flex h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition-colors",
                selectedProviderId === null
                  ? "border-primary bg-primary text-primary-foreground shadow-xs"
                  : "border-border bg-card text-foreground hover:bg-accent/60",
              )}
            >
              <UsersIcon className="size-3.5" />
              <span>جميع مقدمي الخدمة</span>
              <span className="rounded-full bg-primary-foreground/20 px-1.5 py-0.2 text-[10px] tabular-nums">
                {items.length}
              </span>
            </button>
            {providers.map((p) => {
              const count = appointmentCountByProvider.get(p.id) ?? 0;
              const isSelected = selectedProviderId === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setSelectedProviderId(p.id)}
                  className={cn(
                    "flex h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition-colors",
                    isSelected
                      ? "border-primary bg-primary text-primary-foreground shadow-xs"
                      : "border-border bg-card text-foreground hover:bg-accent/60",
                  )}
                >
                  <UserCheckIcon className="size-3.5" />
                  <span>{p.displayName || p.name}</span>
                  <span
                    className={cn(
                      "rounded-full px-1.5 py-0.2 text-[10px] tabular-nums",
                      isSelected
                        ? "bg-primary-foreground/20 text-primary-foreground"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      {/* ─── Business Closed on this Day ─── */}
      {!workingDay ? (
        <EmptyState
          className="bg-card min-h-72"
          icon={CalendarOffIcon}
          title="المنشأة مغلقة في هذا اليوم"
          description="لا تعمل المنشأة في التاريخ المحدد. يمكنك الانتقال إلى يوم عمل آخر أو مراجعة ساعات العمل في الإعدادات."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onNavigateDate(moveDate(date, 1))}
              >
                اليوم التالي
              </Button>
              {date !== today ? (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => onNavigateDate(today)}
                >
                  العودة إلى اليوم
                </Button>
              ) : null}
            </div>
          }
        />
      ) : (
        <>
          {/* ─── Day Availability Metrics Bar ─── */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="rounded-xl border bg-card p-3 shadow-xs">
              <p className="text-xs text-muted-foreground">المواعيد المجدولة</p>
              <p className="mt-1 text-lg font-bold tabular-nums">
                {activeOccupyingAppointments.length}
                <span className="text-xs font-normal text-muted-foreground me-1">
                  {" "}
                  {arabicCount(
                    activeOccupyingAppointments.length,
                    APPOINTMENT_NOUNS,
                  )}
                </span>
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                إجمالي الوقت: {formatDurationMinutes(totalBookedMinutes)}
              </p>
            </div>

            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3 shadow-xs dark:bg-emerald-500/10">
              <p className="text-xs text-emerald-800 dark:text-emerald-300">
                الوقت المتاح للحجز
              </p>
              <p className="mt-1 text-lg font-bold text-emerald-900 tabular-nums dark:text-emerald-200">
                {formatDurationMinutes(totalAvailableMinutes)}
              </p>
              <p className="mt-0.5 text-[11px] text-emerald-700/80 dark:text-emerald-300/80">
                جاهز لاستقبال مواعيد جديدة
              </p>
            </div>

            <div className="col-span-2 rounded-xl border bg-card p-3 shadow-xs sm:col-span-1">
              <p className="text-xs text-muted-foreground">
                حالة استيعاب اليوم
              </p>
              {workingDay ? (
                <div className="mt-2 space-y-1.5">
                  <div className="flex items-center justify-between text-xs tabular-nums text-muted-foreground">
                    <span>
                      {Math.round(
                        (totalBookedMinutes /
                          Math.max(
                            1,
                            workingDay.closeMinutes - workingDay.openMinutes,
                          )) *
                          100,
                      )}
                      % مشغول
                    </span>
                    <span>
                      {Math.round(
                        (totalAvailableMinutes /
                          Math.max(
                            1,
                            workingDay.closeMinutes - workingDay.openMinutes,
                          )) *
                          100,
                      )}
                      % متاح
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full bg-primary transition-all duration-300"
                      style={{
                        width: `${Math.min(
                          100,
                          Math.round(
                            (totalBookedMinutes /
                              Math.max(
                                1,
                                workingDay.closeMinutes -
                                  workingDay.openMinutes,
                              )) *
                              100,
                          ),
                        )}%`,
                      }}
                    />
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          {/* ─── Visual Staff Schedule Timeline ─── */}
          <section aria-label="الجدول الزمني لليوم" className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold flex items-center gap-1.5">
                <Clock3Icon className="size-4 text-primary" />
                <span>الجدول الزمني والفترات المتاحة</span>
              </h3>
              <span className="text-xs text-muted-foreground">
                المواعيد تمثل مدتها الفعلية بدقة
              </span>
            </div>

            {/* Completely empty day */}
            {activeOccupyingAppointments.length === 0 ? (
              <div className="rounded-xl border border-dashed border-emerald-500/40 bg-emerald-500/5 p-6 text-center space-y-3">
                <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600">
                  <SparklesIcon className="size-6" />
                </div>
                <div>
                  <h4 className="font-semibold text-foreground">
                    اليوم متاح بالكامل لاستقبال الحجوزات
                  </h4>
                  <p className="mt-1 text-sm text-muted-foreground">
                    لا توجد مواعيد محجوزة حتى الآن من{" "}
                    {formatSlotTime(toWallClock(workingDay.openMinutes))} إلى{" "}
                    {formatSlotTime(toWallClock(workingDay.closeMinutes))} (
                    {formatDurationMinutes(totalAvailableMinutes)} متاحة
                    بالكامل).
                  </p>
                </div>
                <Button asChild size="sm">
                  <Link href={`/appointments/new?date=${date}`}>
                    <PlusIcon className="size-4" />
                    حجز موعد جديد
                  </Link>
                </Button>
              </div>
            ) : (
              <div className="relative space-y-3 before:absolute before:inset-y-3 before:start-[1.65rem] before:w-px before:bg-border sm:before:start-[4.25rem]">
                {segments.map((segment) => {
                  if (segment.type === "appointment") {
                    const app = segment.appointment;
                    const isPendingAppointment = app.status === "PENDING";
                    const isConfirmed = app.status === "CONFIRMED";
                    const isCompleted = app.status === "COMPLETED";

                    return (
                      <article
                        key={`app-${app.id}`}
                        className="relative grid grid-cols-[3.3rem_minmax(0,1fr)] gap-3 sm:grid-cols-[7.5rem_minmax(0,1fr)]"
                      >
                        {/* Time marker */}
                        <div className="relative z-10 flex items-start gap-1.5 bg-background pt-3 text-xs font-semibold tabular-nums sm:justify-end sm:pe-4">
                          <Clock3Icon className="mt-0.5 size-3.5 text-primary sm:hidden" />
                          <div className="flex flex-col text-start sm:text-end">
                            <time dateTime={app.startTime}>
                              {formatTime(app.startTime)}
                            </time>
                            <span className="text-[10px] font-normal text-muted-foreground">
                              {formatTime(app.endTime)}
                            </span>
                          </div>
                        </div>

                        {/* Occupied Appointment Card */}
                        <div
                          className={cn(
                            "rounded-xl border p-4 shadow-xs transition-shadow hover:shadow-sm",
                            isConfirmed &&
                              "border-emerald-500/30 bg-emerald-500/5 dark:bg-emerald-500/10",
                            isPendingAppointment &&
                              "border-amber-500/30 bg-amber-500/5 dark:bg-amber-500/10",
                            isCompleted &&
                              "border-sky-500/30 bg-sky-500/5 dark:bg-sky-500/10",
                            app.status === "CANCELLED" &&
                              "border-border/60 bg-muted/30 opacity-70",
                            app.status === "NO_SHOW" &&
                              "border-rose-500/30 bg-rose-500/5",
                          )}
                        >
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div className="min-w-0 space-y-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <h4 className="font-semibold text-foreground">
                                  {app.customer.name}
                                </h4>
                                <AppointmentStatusBadge status={app.status} />
                                <span className="rounded-md bg-background/80 px-2 py-0.5 text-xs font-medium text-foreground tabular-nums border">
                                  {segment.durationMinutes} دقيقة
                                </span>
                              </div>

                              <p className="text-sm text-muted-foreground">
                                {app.service.name}
                                {app.provider ? (
                                  <span className="text-foreground/90 font-medium me-1">
                                    {" "}
                                    · الموظف:{" "}
                                    {app.provider.displayName ||
                                      app.provider.name}
                                  </span>
                                ) : null}
                              </p>

                              {app.notes ? (
                                <p className="line-clamp-1 text-xs text-muted-foreground">
                                  {app.notes}
                                </p>
                              ) : null}
                            </div>

                            <div className="flex shrink-0 items-center gap-2">
                              {isPendingAppointment && onConfirmAppointment ? (
                                <Button
                                  type="button"
                                  size="sm"
                                  onClick={() => onConfirmAppointment(app.id)}
                                  disabled={isPending}
                                >
                                  <CheckIcon className="size-3.5" />
                                  تأكيد
                                </Button>
                              ) : null}
                              <Button asChild variant="outline" size="sm">
                                <Link href={`/appointments/${app.id}`}>
                                  التفاصيل
                                </Link>
                              </Button>
                            </div>
                          </div>
                        </div>
                      </article>
                    );
                  }

                  // Available period
                  return (
                    <div
                      key={`avail-${segment.startMinutes}-${segment.endMinutes}`}
                      className="relative grid grid-cols-[3.3rem_minmax(0,1fr)] gap-3 sm:grid-cols-[7.5rem_minmax(0,1fr)]"
                    >
                      {/* Time marker */}
                      <div className="relative z-10 flex items-start gap-1.5 bg-background pt-2.5 text-xs font-normal text-muted-foreground tabular-nums sm:justify-end sm:pe-4">
                        <div className="flex flex-col text-start sm:text-end">
                          <span>{formatSlotTime(segment.startTime)}</span>
                          <span className="text-[10px] text-muted-foreground/70">
                            {formatSlotTime(segment.endTime)}
                          </span>
                        </div>
                      </div>

                      {/* Available Slot Card */}
                      <div className="flex flex-wrap items-center justify-between gap-2.5 rounded-xl border border-dashed border-emerald-500/35 bg-emerald-500/5 px-4 py-3 text-xs transition-colors hover:bg-emerald-500/10 dark:bg-emerald-500/10">
                        <div className="flex items-center gap-2">
                          <span className="size-2 rounded-full bg-emerald-500" />
                          <span className="font-semibold text-emerald-950 dark:text-emerald-200">
                            فترة متاحة
                          </span>
                          <span className="text-muted-foreground">
                            ({formatDurationMinutes(segment.durationMinutes)}{" "}
                            متاحة)
                          </span>
                        </div>
                        <Button
                          asChild
                          size="sm"
                          variant="ghost"
                          className="h-8 gap-1 text-xs text-primary hover:text-primary"
                        >
                          <Link
                            href={`/appointments/new?date=${date}&time=${segment.startTime}`}
                          >
                            <PlusIcon className="size-3.5" />
                            حجز موعد في هذه الفترة
                          </Link>
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
