"use client";

import {
  formatArabicDate,
  formatArabicMonth,
  formatArabicWeekday,
  formatWeekRange,
  getWeekDays,
  moveDate,
  startOfBusinessWeek,
} from "@/features/appointments/components/smart-create/date-format";
import { Button } from "@/components/ui/button";
import { resolveWorkingHours } from "@/lib/scheduling/slot-grid";
import { cn } from "@/lib/utils";

import {
  CalendarDaysIcon,
  CalendarOffIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

export type DateRange = {
  startDate: string;
  endDate: string;
};

export function FollowUpRangeSelector({
  today,
  range,
  onRangeChange,
  workingHours,
}: {
  /** Business-local "YYYY-MM-DD" today */
  today: string;
  range: DateRange | null;
  onRangeChange: (range: DateRange) => void;
  workingHours?: unknown;
}) {
  const thisWeekSat = useMemo(() => startOfBusinessWeek(today), [today]);

  const [currentWeekStart, setCurrentWeekStart] = useState<string>(() =>
    startOfBusinessWeek(range?.startDate || today),
  );

  const [activePeriod, setActivePeriod] = useState<string | null>(() => {
    if (!range) return null;
    if (range.startDate === thisWeekSat) return "this-week";
    if (range.startDate === moveDate(thisWeekSat, 7)) return "next-week";
    if (range.startDate === moveDate(thisWeekSat, 14)) return "after-2-weeks";
    if (range.startDate === moveDate(thisWeekSat, 21)) return "after-3-weeks";
    return null;
  });

  const canShiftPrev = currentWeekStart <= thisWeekSat;
  const weekDays = useMemo(
    () => getWeekDays(currentWeekStart),
    [currentWeekStart],
  );

  function handleSelectPeriod(period: string) {
    setActivePeriod(period);
    switch (period) {
      case "this-week": {
        setCurrentWeekStart(thisWeekSat);
        const start = today >= thisWeekSat ? today : thisWeekSat;
        const end = moveDate(thisWeekSat, 6);
        onRangeChange({ startDate: start, endDate: end });
        break;
      }
      case "next-week": {
        const nextWeekStart = moveDate(thisWeekSat, 7);
        setCurrentWeekStart(nextWeekStart);
        onRangeChange({
          startDate: nextWeekStart,
          endDate: moveDate(nextWeekStart, 2), // Sat–Mon default example from prompt
        });
        break;
      }
      case "after-2-weeks": {
        const week2Start = moveDate(thisWeekSat, 14);
        setCurrentWeekStart(week2Start);
        onRangeChange({
          startDate: week2Start,
          endDate: moveDate(week2Start, 2),
        });
        break;
      }
      case "after-3-weeks": {
        const week3Start = moveDate(thisWeekSat, 21);
        setCurrentWeekStart(week3Start);
        onRangeChange({
          startDate: week3Start,
          endDate: moveDate(week3Start, 2),
        });
        break;
      }
      case "following-week": {
        const nextWeek = moveDate(currentWeekStart, 7);
        setCurrentWeekStart(nextWeek);
        onRangeChange({
          startDate: nextWeek,
          endDate: moveDate(nextWeek, 2),
        });
        break;
      }
    }
  }

  function handleDayClick(dateStr: string) {
    setActivePeriod(null);
    if (!range) {
      onRangeChange({ startDate: dateStr, endDate: dateStr });
      return;
    }

    // If both start and end are already selected and distinct, start fresh
    if (range.startDate !== range.endDate) {
      onRangeChange({ startDate: dateStr, endDate: dateStr });
      return;
    }

    // Exactly one day currently selected: extend to range
    if (dateStr < range.startDate) {
      onRangeChange({ startDate: dateStr, endDate: range.startDate });
    } else {
      onRangeChange({ startDate: range.startDate, endDate: dateStr });
    }
  }

  function handleShiftWeek(delta: 1 | -1) {
    const nextStart = moveDate(currentWeekStart, delta * 7);
    if (delta === -1 && nextStart < thisWeekSat) return;
    setCurrentWeekStart(nextStart);
    setActivePeriod(null);
  }

  const daysCount = useMemo(() => {
    if (!range) return 0;
    const start = new Date(`${range.startDate}T00:00:00.000Z`).getTime();
    const end = new Date(`${range.endDate}T00:00:00.000Z`).getTime();
    return Math.round((end - start) / 86_400_000) + 1;
  }, [range]);

  return (
    <div className="space-y-4">
      {/* ─── Range Summary Banner ─── */}
      <div className="rounded-xl border border-primary/20 bg-primary/5 p-3.5 sm:p-4 text-center">
        <div className="flex items-center justify-center gap-2 text-primary font-semibold text-sm">
          <CalendarDaysIcon className="size-4" />
          <span>فترة المتابعة المحددة</span>
        </div>
        {range ? (
          <div className="mt-1.5 space-y-1">
            <p className="text-base font-bold text-foreground">
              من {formatArabicDate(range.startDate)} إلى{" "}
              {formatArabicDate(range.endDate)}
            </p>
            <p className="text-xs text-muted-foreground">
              فترة تشمل {daysCount}{" "}
              {daysCount === 1 ? "يوم" : daysCount === 2 ? "يومين" : "أيام"}{" "}
              (المريض يختار موعده ضمنها)
            </p>
          </div>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">
            اضغط على يوم البداية ثم يوم النهاية لتحديد الفترة الشاملة للمتابعة.
          </p>
        )}
      </div>

      {/* ─── Quick Presets ─── */}
      <div>
        <p className="mb-2 text-xs font-medium text-muted-foreground">
          الفترات المقترحة
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {[
            { id: "this-week", label: "هذا الأسبوع" },
            { id: "next-week", label: "الأسبوع القادم" },
            { id: "after-2-weeks", label: "بعد أسبوعين" },
            { id: "after-3-weeks", label: "بعد 3 أسابيع" },
            { id: "following-week", label: "الأسبوع التالي" },
          ].map((item) => (
            <Button
              key={item.id}
              type="button"
              variant={activePeriod === item.id ? "default" : "outline"}
              size="sm"
              onClick={() => handleSelectPeriod(item.id)}
              className="h-10 text-xs font-medium"
            >
              {item.label}
            </Button>
          ))}
        </div>
      </div>

      {/* ─── Week Navigation Header ─── */}
      <div className="flex items-center justify-between rounded-xl border bg-muted/40 p-2 sm:p-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => handleShiftWeek(-1)}
          disabled={canShiftPrev}
          aria-label="الأسبوع السابق"
          className="h-9 px-3 gap-1"
        >
          <ChevronRightIcon className="size-4" />
          <span>الأسبوع السابق</span>
        </Button>

        <span className="text-xs sm:text-sm font-semibold tabular-nums text-foreground">
          {formatWeekRange(currentWeekStart)}
        </span>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => handleShiftWeek(1)}
          aria-label="الأسبوع التالي"
          className="h-9 px-3 gap-1"
        >
          <span>الأسبوع التالي</span>
          <ChevronLeftIcon className="size-4" />
        </Button>
      </div>

      {/* ─── 7 Day Cards Grid ─── */}
      <div
        className="grid grid-cols-2 gap-2 sm:grid-cols-7"
        role="group"
        aria-label="أيام الأسبوع لتحديد الفترة"
      >
        {weekDays.map((dateStr) => {
          const isPast = dateStr < today;
          const workingDay = resolveWorkingHours(workingHours, dateStr);
          const isClosed = workingHours ? !workingDay : false;

          const isStart = range?.startDate === dateStr;
          const isEnd = range?.endDate === dateStr;
          const isInRange =
            !!range && dateStr >= range.startDate && dateStr <= range.endDate;

          const weekdayName = formatArabicWeekday(dateStr);
          const dayNum = Number(dateStr.slice(8, 10));
          const monthName = formatArabicMonth(dateStr);

          return (
            <button
              key={dateStr}
              type="button"
              disabled={isPast}
              onClick={() => handleDayClick(dateStr)}
              className={cn(
                "flex min-h-[5.5rem] flex-col items-center justify-between rounded-xl border p-2.5 transition-all text-center",
                isPast
                  ? "cursor-not-allowed border-border/40 bg-muted/30 text-muted-foreground/50 opacity-50"
                  : isStart || isEnd
                    ? "border-primary bg-primary text-primary-foreground shadow-sm ring-2 ring-primary ring-offset-2 ring-offset-background font-bold"
                    : isInRange
                      ? "border-primary/40 bg-primary/15 text-primary font-semibold"
                      : "border-border bg-card text-foreground hover:bg-accent/60",
              )}
            >
              <div className="flex flex-col items-center">
                <span className="text-xs font-semibold">{weekdayName}</span>
                <span className="text-lg font-bold leading-tight tabular-nums">
                  {dayNum}
                </span>
                <span
                  className={cn(
                    "text-[10px] leading-tight",
                    isStart || isEnd
                      ? "text-primary-foreground/90"
                      : "text-muted-foreground",
                  )}
                >
                  {monthName}
                </span>
              </div>

              <div className="mt-1">
                {isStart && isEnd ? (
                  <span className="inline-flex rounded-full bg-primary-foreground/25 px-1.5 py-0.2 text-[10px] font-bold text-primary-foreground">
                    البداية والنهاية
                  </span>
                ) : isStart ? (
                  <span className="inline-flex rounded-full bg-primary-foreground/25 px-1.5 py-0.2 text-[10px] font-bold text-primary-foreground">
                    بداية الفترة
                  </span>
                ) : isEnd ? (
                  <span className="inline-flex rounded-full bg-primary-foreground/25 px-1.5 py-0.2 text-[10px] font-bold text-primary-foreground">
                    نهاية الفترة
                  </span>
                ) : isInRange ? (
                  <span className="text-[10px] text-primary font-medium">
                    ضمن الفترة
                  </span>
                ) : isClosed ? (
                  <span className="inline-flex items-center gap-0.5 rounded bg-muted px-1 py-0.5 text-[9px] text-muted-foreground">
                    <CalendarOffIcon className="size-2.5" />
                    مغلق
                  </span>
                ) : isPast ? (
                  <span className="text-[10px] text-muted-foreground/60">
                    سابق
                  </span>
                ) : (
                  <span className="text-[10px] text-muted-foreground font-normal">
                    متاح
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
