"use client";

import { updateAppointmentStatus } from "@/features/appointments/actions/appointment-actions";
import {
  APPOINTMENT_STATUS_LABELS,
  AppointmentStatusBadge,
} from "@/features/appointments/components/appointment-status";
import {
  formatArabicDate,
  moveDate,
} from "@/features/appointments/components/smart-create/date-format";
import { formatSlotTime } from "@/features/appointments/components/smart-create/slot-helpers";
import { VisualStaffCalendar } from "@/features/appointments/components/visual-calendar/visual-staff-calendar";
import type { AppointmentAgendaItem } from "@/features/appointments/types";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { APPOINTMENT_NOUNS, arabicCount } from "@/lib/arabic";
import { cn } from "@/lib/utils";
import type { AppointmentStatus } from "@/types/domain";

import {
  CalendarDaysIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  Clock3Icon,
  PlusIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

const FILTERS: Array<{ value: "ALL" | AppointmentStatus; label: string }> = [
  { value: "ALL", label: "كل الحالات" },
  { value: "PENDING", label: "قيد الانتظار" },
  { value: "CONFIRMED", label: "مؤكد" },
  { value: "CANCELLED", label: "ملغي" },
  { value: "NO_SHOW", label: "لم يحضر" },
  { value: "COMPLETED", label: "مكتمل" },
];

function formatTime(time: string) {
  // Stored `@db.Time` values are epoch-anchored
  // ("1970-01-01THH:mm:00.000Z"); the wall-clock "HH:mm" is the shared
  // slot helper's input format, so one formatter serves every surface.
  return formatSlotTime(time.slice(11, 16));
}

export function AppointmentAgenda({
  initialItems,
  date,
  today,
  workingHours,
  slotDurationMinutes,
  providers,
}: {
  initialItems: AppointmentAgendaItem[];
  date: string;
  today: string;
  workingHours?: unknown;
  slotDurationMinutes?: number;
  providers?: Array<{
    id: string;
    name: string;
    displayName?: string | null;
  }>;
}) {
  const router = useRouter();
  const [items, setItems] = useState(initialItems);
  const [viewMode, setViewMode] = useState<"calendar" | "list">("calendar");
  const [filter, setFilter] = useState<"ALL" | AppointmentStatus>("ALL");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const visible = useMemo(
    () => items.filter((item) => filter === "ALL" || item.status === filter),
    [filter, items],
  );

  function navigate(nextDate: string) {
    startTransition(() => router.push(`/appointments?date=${nextDate}`));
  }

  function confirmAppointment(id: string) {
    setError(null);
    setItems((current) =>
      current.map((item) =>
        item.id === id ? { ...item, status: "CONFIRMED" } : item,
      ),
    );
    startTransition(async () => {
      const result = await updateAppointmentStatus({ id, status: "CONFIRMED" });
      if (!result.success) {
        setItems((current) =>
          current.map((item) =>
            item.id === id ? { ...item, status: "PENDING" } : item,
          ),
        );
        setError(result.message);
      }
    });
  }

  return (
    <div className="space-y-5">
      {/* ─── View Switcher: Visual Staff Calendar vs Agenda List ─── */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1 rounded-xl border bg-muted/40 p-1">
          <button
            type="button"
            onClick={() => setViewMode("calendar")}
            className={cn(
              "flex h-9 items-center gap-1.5 rounded-lg px-3.5 text-xs font-medium transition-colors",
              viewMode === "calendar"
                ? "bg-background text-foreground shadow-xs font-semibold"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Clock3Icon className="size-3.5" />
            <span>الجدول المرئي</span>
          </button>
          <button
            type="button"
            onClick={() => setViewMode("list")}
            className={cn(
              "flex h-9 items-center gap-1.5 rounded-lg px-3.5 text-xs font-medium transition-colors",
              viewMode === "list"
                ? "bg-background text-foreground shadow-xs font-semibold"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <CalendarDaysIcon className="size-3.5" />
            <span>قائمة المواعيد</span>
          </button>
        </div>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {viewMode === "calendar" ? (
        <VisualStaffCalendar
          items={items}
          date={date}
          today={today}
          workingHours={workingHours}
          slotDurationMinutes={slotDurationMinutes}
          providers={providers}
          onNavigateDate={navigate}
          isPending={isPending}
          onConfirmAppointment={confirmAppointment}
        />
      ) : (
        <div className="space-y-5">
          <div className="rounded-xl border bg-card p-3 shadow-xs sm:p-4">
            <div className="flex items-center justify-between gap-2">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="اليوم السابق"
                onClick={() => navigate(moveDate(date, -1))}
                disabled={isPending}
              >
                <ChevronRightIcon />
              </Button>
              <div className="min-w-0 text-center">
                <h2 className="truncate font-semibold">
                  {formatArabicDate(date)}
                </h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {/* The count answers "how many appointments?" for EVERY day
                   * — including today, which additionally carries the
                   * «اليوم» marker so the viewed day is always obvious. */}
                  {date === today ? "اليوم · " : ""}
                  {arabicCount(items.length, APPOINTMENT_NOUNS)}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="اليوم التالي"
                onClick={() => navigate(moveDate(date, 1))}
                disabled={isPending}
              >
                <ChevronLeftIcon />
              </Button>
            </div>
            {date !== today ? (
              <div className="mt-2 text-center">
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  onClick={() => navigate(today)}
                >
                  العودة إلى اليوم
                </Button>
              </div>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <Select
              value={filter}
              onValueChange={(value) => setFilter(value as typeof filter)}
            >
              <SelectTrigger className="w-44" aria-label="تصفية حسب الحالة">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FILTERS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-xs text-muted-foreground" aria-live="polite">
              {arabicCount(visible.length, APPOINTMENT_NOUNS)}
            </span>
          </div>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          {visible.length === 0 ? (
            <EmptyState
              className="bg-card min-h-72"
              icon={CalendarDaysIcon}
              title={
                items.length === 0
                  ? "لا توجد مواعيد في هذا اليوم"
                  : "لا توجد مواعيد بهذه الحالة"
              }
              description={
                items.length === 0
                  ? "يمكنك إضافة موعد جديد وسيظهر هنا مرتباً حسب الوقت."
                  : "غيّر فلتر الحالة لعرض بقية مواعيد اليوم."
              }
              action={
                items.length === 0 ? (
                  <Button asChild size="sm">
                    <Link href={`/appointments/new?date=${date}`}>
                      <PlusIcon aria-hidden className="size-4" />
                      إنشاء موعد
                    </Link>
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setFilter("ALL")}
                  >
                    عرض كل الحالات
                  </Button>
                )
              }
            />
          ) : (
            <ol className="relative space-y-3 before:absolute before:inset-y-4 before:start-[1.7rem] before:w-px before:bg-border sm:before:start-[4.25rem]">
              {visible.map((appointment) => (
                <li
                  key={appointment.id}
                  className="relative grid grid-cols-[3.4rem_minmax(0,1fr)] gap-3 sm:grid-cols-[7.5rem_minmax(0,1fr)]"
                >
                  <div className="relative z-10 flex items-start gap-2 bg-background pt-4 text-sm font-semibold tabular-nums sm:justify-end sm:pe-4">
                    <Clock3Icon className="mt-0.5 size-3.5 text-muted-foreground sm:hidden" />
                    <time dateTime={appointment.startTime}>
                      {formatTime(appointment.startTime)}
                    </time>
                  </div>
                  <article className="rounded-xl border bg-card p-4 shadow-xs transition-shadow hover:shadow-sm">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="truncate font-semibold">
                            {appointment.customer.name}
                          </h3>
                          <AppointmentStatusBadge status={appointment.status} />
                        </div>
                        <p className="mt-1 truncate text-sm text-muted-foreground">
                          {appointment.service.name} ·{" "}
                          {appointment.service.durationMinutes} دقيقة
                          {appointment.provider ? (
                            <span>
                              {" "}
                              · الموظف:{" "}
                              {appointment.provider.displayName ||
                                appointment.provider.name}
                            </span>
                          ) : null}
                        </p>
                        {appointment.notes ? (
                          <p className="mt-2 line-clamp-1 text-xs text-muted-foreground">
                            {appointment.notes}
                          </p>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {appointment.status === "PENDING" ? (
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => confirmAppointment(appointment.id)}
                            disabled={isPending}
                          >
                            <CheckIcon />
                            تأكيد
                          </Button>
                        ) : null}
                        <Button asChild variant="outline" size="sm">
                          <Link href={`/appointments/${appointment.id}`}>
                            التفاصيل
                          </Link>
                        </Button>
                      </div>
                    </div>
                  </article>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

export { APPOINTMENT_STATUS_LABELS };
