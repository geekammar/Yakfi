"use client";

import {
  RELATIVE_DATE_OPTIONS,
  RELATIVE_WINDOW_OPTIONS,
  formatArabicDate,
  formatArabicDayMonth,
  formatArabicMonth,
  formatArabicWeekday,
  moveDate,
  relativeDateWindow,
  resolveRelativeDate,
  type RelativeDateOption,
} from "@/features/appointments/components/smart-create/date-format";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { appointmentDateSchema } from "@/lib/validation";

import { CalendarDaysIcon } from "lucide-react";
import { useState } from "react";

/** How many upcoming days the quick-pick strip offers. */
const QUICK_DAYS = 14;

/**
 * Step 3 — التاريخ. Mobile-friendly date selection (B-07 §B):
 * - relative choices (اليوم / غداً / هذا الأسبوع / الأسبوع القادم /
 *   بعد أسبوع / بعد أسبوعين / بعد شهر) that each compute the actual
 *   date from the server-derived business today — the user never
 *   counts days — and each shows the date it resolves to so the
 *   resulting date is ALWAYS explicit;
 * - a period choice (this/next week, بعد أسبوع/أسبوعين/شهر) additionally
 *   offers the days of that period, with the deterministic resolved date
 *   selected by default and freely changeable (B-07 polish);
 * - a quick-pick strip of the next two weeks for any other near day;
 * - a native date input for any other date.
 *
 * `today` is business-timezone today (server-derived) — the device
 * timezone is never a source of truth. No availability calculation
 * happens here; the next step consumes the PROMPT-10 availability
 * layer (the period candidates are calendar days only — availability is
 * never fabricated client-side).
 */
export function DateStep({
  selectedDate,
  today,
  onSelect,
}: {
  selectedDate: string;
  /** Business-local "YYYY-MM-DD" today (from the server). */
  today: string;
  onSelect: (date: string) => void;
}) {
  const parsed = appointmentDateSchema.safeParse(selectedDate);
  const dateError = parsed.success ? null : "التاريخ غير صالح";

  // The period whose candidate days are currently offered (B-07 polish).
  // Restored on mount when the preserved selection is exactly a period's
  // resolved date, so returning to this step never loses the context.
  const [activeWindow, setActiveWindow] = useState<RelativeDateOption | null>(
    () => {
      const options = RELATIVE_WINDOW_OPTIONS;
      return (
        options.find(
          (option) => resolveRelativeDate(today, option) === selectedDate,
        ) ?? null
      );
    },
  );
  const windowDays = activeWindow
    ? relativeDateWindow(today, activeWindow)
    : null;

  const days = Array.from({ length: QUICK_DAYS }, (_, index) => {
    const date = moveDate(today, index);
    return {
      date,
      index,
      label:
        index === 0
          ? "اليوم"
          : index === 1
            ? "غداً"
            : formatArabicWeekday(date),
    };
  });

  function handleSelectRelative(option: RelativeDateOption, resolved: string) {
    setActiveWindow(option);
    onSelect(resolved);
  }

  function handleSelectPlainDate(date: string) {
    setActiveWindow(null);
    onSelect(date);
  }

  return (
    <div className="space-y-5">
      <div>
        <p className="mb-2 text-sm font-medium">اختر سريعًا</p>
        <ul
          className="flex list-none flex-wrap gap-2"
          aria-label="خيارات الجدولة السريعة"
        >
          {RELATIVE_DATE_OPTIONS.map((choice) => {
            // A relative choice is "active" when its period is open OR its
            // resolved date is the current selection — honest feedback
            // (the date each label means is shown under it either way).
            const resolved = resolveRelativeDate(today, choice.option);
            const isSelected =
              activeWindow === choice.option || resolved === selectedDate;
            return (
              <li key={choice.option}>
                <button
                  type="button"
                  onClick={() => handleSelectRelative(choice.option, resolved)}
                  aria-pressed={isSelected}
                  aria-label={`${choice.label}، ${formatArabicDate(resolved)}`}
                  className={cn(
                    "flex flex-col items-center gap-0.5 rounded-xl border px-4 py-2 text-sm font-medium transition-colors",
                    isSelected
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-card text-foreground hover:bg-accent/60",
                  )}
                >
                  <span>{choice.label}</span>
                  <span
                    className={cn(
                      "text-[11px] leading-tight tabular-nums",
                      isSelected
                        ? "text-primary-foreground/90"
                        : "text-muted-foreground",
                    )}
                  >
                    {formatArabicDayMonth(resolved)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {windowDays ? (
        <div>
          <p className="mb-2 flex flex-wrap items-baseline gap-x-2 text-sm font-medium">
            <span>أيام هذه الفترة</span>
            <span className="text-xs font-normal text-muted-foreground">
              التاريخ المحدد: {formatArabicDate(selectedDate)}
            </span>
          </p>
          <ul
            className="flex list-none gap-2 overflow-x-auto pb-2"
            aria-label="اختر يوماً ضمن هذه الفترة"
          >
            {windowDays.map((date, index) => (
              <li key={date} className="shrink-0">
                <DayChip
                  date={date}
                  label={formatArabicWeekday(date)}
                  showMonth={
                    index === 0 ||
                    formatArabicMonth(date) !==
                      formatArabicMonth(windowDays[index - 1] ?? date)
                  }
                  isSelected={date === selectedDate}
                  onSelect={() => onSelect(date)}
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div>
        <p className="mb-2 text-sm font-medium">الأيام القريبة</p>
        <ul
          className="flex list-none gap-2 overflow-x-auto pb-2"
          aria-label="اختر تاريخاً من الأيام القريبة"
        >
          {days.map((day, index) => {
            const isSelected = day.date === selectedDate;
            const showMonth =
              index === 0 ||
              formatArabicMonth(day.date) !==
                formatArabicMonth(days[index - 1]?.date ?? day.date);
            return (
              <li key={day.date} className="shrink-0">
                <DayChip
                  date={day.date}
                  label={day.label}
                  showMonth={showMonth}
                  isSelected={isSelected}
                  onSelect={() => handleSelectPlainDate(day.date)}
                />
              </li>
            );
          })}
        </ul>
      </div>

      <div className="space-y-2">
        <Label htmlFor="booking-date-input">تاريخ آخر</Label>
        <Input
          id="booking-date-input"
          type="date"
          dir="ltr"
          min={today}
          value={selectedDate}
          aria-invalid={Boolean(dateError)}
          onChange={(event) => handleSelectPlainDate(event.target.value)}
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

/** One day tile — the shared shape of the period candidates and the
 * quick-pick strip (selected state obvious, month shown when it
 * changes, generous tap target). */
function DayChip({
  date,
  label,
  showMonth,
  isSelected,
  onSelect,
}: {
  date: string;
  label: string;
  showMonth: boolean;
  isSelected: boolean;
  onSelect: (date: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(date)}
      aria-pressed={isSelected}
      aria-label={`${label}، ${formatArabicDate(date)}`}
      className={cn(
        "flex w-16 flex-col items-center gap-0.5 rounded-xl border px-2 py-2.5 transition-colors",
        isSelected
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-card text-foreground hover:bg-accent/60",
      )}
    >
      <span
        className={cn(
          "text-xs font-medium",
          isSelected ? "text-primary-foreground" : "text-foreground",
        )}
      >
        {label}
      </span>
      <span className="text-lg font-semibold leading-none tabular-nums">
        {Number(date.slice(8, 10))}
      </span>
      <span
        className={cn(
          "text-[10px] leading-tight",
          isSelected ? "text-primary-foreground/90" : "text-muted-foreground",
        )}
      >
        {showMonth ? formatArabicMonth(date) : "\u00A0"}
      </span>
    </button>
  );
}
