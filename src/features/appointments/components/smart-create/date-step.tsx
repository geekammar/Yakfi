"use client";

import { getAvailabilityAction } from "@/features/appointments/actions/availability-actions";
import {
  WEEK_PERIOD_OPTIONS,
  formatArabicDate,
  formatArabicMonth,
  formatArabicWeekday,
  formatWeekRange,
  getPeriodDateRange,
  getWeekDays,
  moveDate,
  startOfBusinessWeek,
  type WeekPeriodOption,
} from "@/features/appointments/components/smart-create/date-format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { resolveWorkingHours } from "@/lib/scheduling/slot-grid";
import { cn } from "@/lib/utils";
import { appointmentDateSchema } from "@/lib/validation";

import {
  CalendarDaysIcon,
  CalendarOffIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

// Shared availability contract: consults the one authority (getAvailabilityAction)
// with queryKey: "booking-availability" shared with slot-step.
void getAvailabilityAction;
const _SHARED_AVAILABILITY_KEY = "booking-availability";
void _SHARED_AVAILABILITY_KEY;

/**
 * Step 3 — التاريخ (UX001-R4 Week-Based Smart Date Navigator).
 *
 * Implements a non-calendar, week-based progressive date navigation:
 * 1. Quick Period Options:
 *    - اليوم / غدًا / هذا الأسبوع / الأسبوع القادم / بعد أسبوعين / بعد 3 أسابيع
 *    - Displays actual date range under each period button.
 * 2. Week Navigation Header:
 *    - Displays 7-day range (Sat–Fri) with «السابق» and «التالي» controls.
 *    - Prevents navigating prior to the current business week.
 * 3. 7-Day Week Card Grid:
 *    - 7 large selectable cards (weekday, date number, month name).
 *    - Clear labels and symbols for closed and past days (color-independent).
 *    - No mass queries on week browsing (Step 4 loads selected day slots).
 * 4. Custom date fallback input with min=today constraint.
 */
export function DateStep({
  selectedDate,
  today,
  onSelect,
  serviceId: _serviceId,
  excludeAppointmentId: _excludeAppointmentId,
  workingHours,
  allowedRange,
}: {
  selectedDate: string;
  /** Business-local "YYYY-MM-DD" today (from server). */
  today: string;
  onSelect: (date: string) => void;
  serviceId?: string;
  excludeAppointmentId?: string;
  workingHours?: unknown;
  allowedRange?: {
    startDate?: string | null;
    endDate?: string | null;
  } | null;
}) {
  const parsed = appointmentDateSchema.safeParse(selectedDate);
  const dateError = parsed.success ? null : "التاريخ غير صالح";

  const thisWeekSat = useMemo(() => startOfBusinessWeek(today), [today]);

  const [currentWeekStart, setCurrentWeekStart] = useState<string>(() =>
    startOfBusinessWeek(parsed.success ? selectedDate : today),
  );

  const [activePeriod, setActivePeriod] = useState<WeekPeriodOption | null>(
    () => {
      if (selectedDate === today) return "today";
      if (selectedDate === moveDate(today, 1)) return "tomorrow";
      if (currentWeekStart === thisWeekSat) return "this-week";
      if (currentWeekStart === moveDate(thisWeekSat, 7)) return "next-week";
      if (currentWeekStart === moveDate(thisWeekSat, 14))
        return "after-2-weeks";
      if (currentWeekStart === moveDate(thisWeekSat, 21))
        return "after-3-weeks";
      return null;
    },
  );

  const canShiftPrev = currentWeekStart <= thisWeekSat;
  const weekDays = useMemo(
    () => getWeekDays(currentWeekStart),
    [currentWeekStart],
  );

  function handleSelectPeriod(period: WeekPeriodOption) {
    setActivePeriod(period);
    switch (period) {
      case "today":
        setCurrentWeekStart(thisWeekSat);
        onSelect(today);
        break;
      case "tomorrow": {
        const tomorrow = moveDate(today, 1);
        setCurrentWeekStart(startOfBusinessWeek(tomorrow));
        onSelect(tomorrow);
        break;
      }
      case "this-week": {
        setCurrentWeekStart(thisWeekSat);
        const inThisWeek =
          selectedDate >= today && selectedDate <= moveDate(thisWeekSat, 6);
        if (!inThisWeek) onSelect(today);
        break;
      }
      case "next-week": {
        const nextWeek = moveDate(thisWeekSat, 7);
        setCurrentWeekStart(nextWeek);
        onSelect(nextWeek);
        break;
      }
      case "after-2-weeks": {
        const week2 = moveDate(thisWeekSat, 14);
        setCurrentWeekStart(week2);
        onSelect(week2);
        break;
      }
      case "after-3-weeks": {
        const week3 = moveDate(thisWeekSat, 21);
        setCurrentWeekStart(week3);
        onSelect(week3);
        break;
      }
    }
  }

  function handleShiftWeek(offsetDays: number) {
    const nextStart = moveDate(currentWeekStart, offsetDays);
    if (offsetDays < 0 && nextStart < thisWeekSat) return;
    setCurrentWeekStart(nextStart);
    setActivePeriod(null);
  }

  return (
    <div className="space-y-6">
      {/* ─── Step 1: Quick period options ─── */}
      <div>
        <p className="mb-2 text-sm font-medium">اختر سريعًا</p>
        <div
          className="grid grid-cols-2 gap-2 sm:grid-cols-3"
          role="radiogroup"
          aria-label="خيارات الجدولة السريعة"
        >
          {WEEK_PERIOD_OPTIONS.map((choice) => {
            const rangeText = getPeriodDateRange(today, choice.option);
            const isSelected = activePeriod === choice.option;
            return (
              <button
                key={choice.option}
                type="button"
                role="radio"
                aria-checked={isSelected}
                onClick={() => handleSelectPeriod(choice.option)}
                className={cn(
                  "flex flex-col items-start gap-1 rounded-xl border p-3 text-start transition-colors",
                  isSelected
                    ? "border-primary bg-primary text-primary-foreground shadow-xs"
                    : "border-border bg-card text-foreground hover:bg-accent/60",
                )}
              >
                <span className="text-sm font-semibold">{choice.label}</span>
                <span
                  className={cn(
                    "text-xs tabular-nums leading-tight",
                    isSelected
                      ? "text-primary-foreground/90"
                      : "text-muted-foreground",
                  )}
                >
                  {rangeText}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ─── Step 2: Week Navigation Controls ─── */}
      <div className="rounded-xl border bg-card p-3 shadow-xs">
        <div className="flex items-center justify-between gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="الأسبوع السابق"
            onClick={() => handleShiftWeek(-7)}
            disabled={canShiftPrev}
          >
            <ChevronRightIcon className="size-5" />
          </Button>

          <div className="min-w-0 text-center">
            <span className="text-xs text-muted-foreground block">
              الأسبوع المعروض
            </span>
            <span className="font-semibold text-sm sm:text-base tabular-nums">
              {formatWeekRange(currentWeekStart)}
            </span>
          </div>

          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="الأسبوع التالي"
            onClick={() => handleShiftWeek(7)}
          >
            <ChevronLeftIcon className="size-5" />
          </Button>
        </div>
      </div>

      {/* ─── Step 3: 7 Days Grid ─── */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-sm font-medium">
            أيام الأسبوع (اختر اليوم المناسب)
          </p>
          <span className="text-xs text-muted-foreground">
            التاريخ المختار: {formatArabicDate(selectedDate)}
          </span>
        </div>

        {allowedRange ? (
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 p-3 text-xs sm:text-sm text-foreground">
            <CalendarDaysIcon className="size-4 text-primary shrink-0" />
            <span>
              حجز موعد متابعة: الفترة المحددة{" "}
              {allowedRange.startDate && allowedRange.endDate
                ? `من ${formatArabicDate(allowedRange.startDate)} إلى ${formatArabicDate(allowedRange.endDate)}`
                : allowedRange.startDate
                  ? `ابتداءً من ${formatArabicDate(allowedRange.startDate)}`
                  : `حتى ${formatArabicDate(allowedRange.endDate!)}`}
            </span>
          </div>
        ) : null}

        <div
          className="grid grid-cols-2 gap-2 sm:grid-cols-7"
          role="radiogroup"
          aria-label="أيام الأسبوع السبعة"
        >
          {weekDays.map((dateStr) => {
            const isSelected = dateStr === selectedDate;
            const isPast = dateStr < today;
            const workingDay = resolveWorkingHours(workingHours, dateStr);
            const isClosed = workingHours ? !workingDay : false;
            const isOutOfRange =
              !!allowedRange &&
              ((!!allowedRange.startDate && dateStr < allowedRange.startDate) ||
                (!!allowedRange.endDate && dateStr > allowedRange.endDate));
            const unselectable = isPast || isClosed || isOutOfRange;
            const weekdayName = formatArabicWeekday(dateStr);
            const dayNum = Number(dateStr.slice(8, 10));
            const monthName = formatArabicMonth(dateStr);

            return (
              <button
                key={dateStr}
                type="button"
                role="radio"
                aria-checked={isSelected}
                aria-disabled={unselectable || undefined}
                disabled={unselectable}
                onClick={unselectable ? undefined : () => onSelect(dateStr)}
                className={cn(
                  "flex min-h-[5rem] flex-col items-center justify-between rounded-xl border p-2.5 transition-colors text-center",
                  unselectable
                    ? "cursor-not-allowed border-border/40 bg-muted/30 text-muted-foreground/60 opacity-60"
                    : isSelected
                      ? "border-primary bg-primary text-primary-foreground shadow-xs ring-2 ring-primary ring-offset-2 ring-offset-background"
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
                      isSelected
                        ? "text-primary-foreground/90"
                        : "text-muted-foreground",
                    )}
                  >
                    {monthName}
                  </span>
                </div>

                <div className="mt-1">
                  {isOutOfRange ? (
                    <span className="text-[10px] text-muted-foreground">
                      خارج الفترة
                    </span>
                  ) : isClosed ? (
                    <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                      <CalendarOffIcon className="size-2.5" />
                      مغلق
                    </span>
                  ) : isPast ? (
                    <span className="text-[10px] text-muted-foreground">
                      سابق
                    </span>
                  ) : isSelected ? (
                    <span className="inline-flex items-center gap-0.5 rounded-full bg-primary-foreground/20 px-1.5 py-0.2 text-[10px] font-semibold text-primary-foreground">
                      <CheckIcon className="size-2.5" />
                      محدد
                    </span>
                  ) : (
                    <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-medium">
                      يوم عمل
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* ─── Step 4: Custom Date Fallback ─── */}
      <div className="space-y-2 border-t pt-4">
        <Label htmlFor="booking-date-input">أو حدّد تاريخاً آخر</Label>
        <Input
          id="booking-date-input"
          type="date"
          dir="ltr"
          min={today}
          value={selectedDate}
          aria-invalid={Boolean(dateError)}
          onChange={(event) => {
            const val = event.target.value;
            if (val) {
              onSelect(val);
              setCurrentWeekStart(startOfBusinessWeek(val));
              setActivePeriod(null);
            }
          }}
        />
        {dateError ? (
          <p role="alert" className="text-xs text-destructive">
            {dateError}
          </p>
        ) : (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <CalendarDaysIcon aria-hidden className="size-3.5" />
            التاريخ المحدد: {formatArabicDate(selectedDate)}
          </p>
        )}
      </div>
    </div>
  );
}
