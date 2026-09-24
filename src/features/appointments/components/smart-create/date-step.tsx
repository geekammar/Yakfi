"use client";

import {
  RELATIVE_DATE_OPTIONS,
  formatArabicDate,
  formatArabicMonth,
  formatArabicWeekday,
  moveDate,
  resolveRelativeDate,
} from "@/features/appointments/components/smart-create/date-format";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { appointmentDateSchema } from "@/lib/validation";

import { CalendarDaysIcon } from "lucide-react";

/** How many upcoming days the quick-pick strip offers. */
const QUICK_DAYS = 14;

/**
 * Step 3 — التاريخ. Mobile-friendly date selection (B-07 §B):
 * - relative choices (اليوم / غداً / هذا الأسبوع / الأسبوع القادم /
 *   بعد أسبوع / بعد أسبوعين / بعد شهر) that each compute the actual
 *   date from the server-derived business today — the user never
 *   counts days;
 * - a quick-pick strip of the next two weeks for any other near day;
 * - a native date input for any other date.
 *
 * `today` is business-timezone today (server-derived) — the device
 * timezone is never a source of truth. No availability calculation
 * happens here; the next step consumes the PROMPT-10 availability
 * layer.
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

  return (
    <div className="space-y-5">
      <div>
        <p className="mb-2 text-sm font-medium">اختر سرعاً</p>
        <ul
          className="flex list-none flex-wrap gap-2"
          aria-label="خيارات الجدولة السريعة"
        >
          {RELATIVE_DATE_OPTIONS.map((choice) => {
            // A relative choice is "active" when it resolves to the
            // currently selected date — honest feedback, never a guess.
            const resolved = resolveRelativeDate(today, choice.option);
            const isSelected = resolved === selectedDate;
            return (
              <li key={choice.option}>
                <button
                  type="button"
                  onClick={() => onSelect(resolved)}
                  aria-pressed={isSelected}
                  aria-label={`${choice.label}، ${formatArabicDate(resolved)}`}
                  className={cn(
                    "rounded-full border px-4 py-2 text-sm font-medium transition-colors",
                    isSelected
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-card text-foreground hover:bg-accent/60",
                  )}
                >
                  {choice.label}
                </button>
              </li>
            );
          })}
        </ul>
      </div>

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
                <button
                  type="button"
                  onClick={() => onSelect(day.date)}
                  aria-pressed={isSelected}
                  aria-label={`${day.label}، ${formatArabicDate(day.date)}`}
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
                      isSelected
                        ? "text-primary-foreground"
                        : "text-foreground",
                    )}
                  >
                    {day.label}
                  </span>
                  <span className="text-lg font-semibold leading-none tabular-nums">
                    {Number(day.date.slice(8, 10))}
                  </span>
                  <span
                    className={cn(
                      "text-[10px] leading-tight",
                      isSelected
                        ? "text-primary-foreground/90"
                        : "text-muted-foreground",
                    )}
                  >
                    {showMonth ? formatArabicMonth(day.date) : "\u00A0"}
                  </span>
                </button>
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
          onChange={(event) => onSelect(event.target.value)}
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
