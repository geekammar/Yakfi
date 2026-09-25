"use client";

import { getAvailabilityAction } from "@/features/appointments/actions/availability-actions";
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
import {
  DAY_CAPACITY_LABELS,
  dayCapacityState,
  isDayUnselectable,
  type DayCapacityState,
} from "@/features/appointments/components/smart-create/day-capacity";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { appointmentDateSchema } from "@/lib/validation";

import { useQueries } from "@tanstack/react-query";
import { CalendarDaysIcon } from "lucide-react";
import { useMemo, useState } from "react";

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
 * timezone is never a source of truth. The DATE MATH stays pure: every
 * candidate is a calendar day from deterministic arithmetic, and when a
 * service is known each rendered day is additionally decorated with its
 * real capacity from the EXISTING PROMPT-10 availability layer (the one
 * engine) — a day with no selectable capacity is visibly muted and
 * non-actionable instead of wasting a tap. Availability is never
 * computed, generated, or fabricated client-side.
 */
export function DateStep({
  selectedDate,
  today,
  onSelect,
  serviceId,
  excludeAppointmentId,
}: {
  selectedDate: string;
  /** Business-local "YYYY-MM-DD" today (from the server). */
  today: string;
  onSelect: (date: string) => void;
  /**
   * The service chosen in Step 2 (B-09): when known, each offered day is
   * decorated with its real capacity through the EXISTING availability
   * authority — the same one Step 4 uses — so a day with no selectable
   * capacity is visibly muted and non-actionable before a tap is spent
   * on it. Absent → days render undecorated (nothing is invented).
   */
  serviceId?: string;
  /**
   * B-08 — the appointment being rescheduled, so its own slot does not
   * count against its day's capacity (the authority re-resolves the id
   * against the actor's own Business). Shares the slot step's exact
   * query key so both surfaces read ONE cached result per day.
   */
  excludeAppointmentId?: string;
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

  // B-09 — the capacity of every day currently offered as a chip. The
  // query key is EXACTLY the slot step's, so the two surfaces share one
  // cached result per day (the slot step refetches on mount anyway — a
  // chip hint can never go stale enough to matter, and the write path's
  // conflict check is still the final guard). No availability is ever
  // computed client-side: the authority answers, this layer only paints.
  const capacityDates = useMemo(() => {
    const set = new Set(days.map((day) => day.date));
    for (const date of windowDays ?? []) set.add(date);
    return Array.from(set);
  }, [days, windowDays]);
  const excludeRef = excludeAppointmentId ?? null;
  const capacities = useQueries({
    queries: capacityDates.map((date) => ({
      queryKey: ["booking-availability", serviceId, date, excludeRef],
      queryFn: () =>
        getAvailabilityAction({
          date,
          serviceId: serviceId as string,
          ...(excludeAppointmentId ? { excludeAppointmentId } : {}),
        }),
      enabled: Boolean(serviceId),
      retry: 1,
    })),
  });
  const capacityByDate = useMemo(() => {
    const map = new Map<string, DayCapacityState>();
    capacities.forEach((query, index) => {
      const date = capacityDates[index];
      if (date) map.set(date, dayCapacityState(query.data));
    });
    return map;
  }, [capacities, capacityDates]);

  function capacityOf(date: string): DayCapacityState {
    return capacityByDate.get(date) ?? "unknown";
  }

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
                  capacity={capacityOf(date)}
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
                  capacity={capacityOf(day.date)}
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
 * quick-pick strip (selected state obvious, month shown when it changes,
 * generous tap target). A day the authority reported as having no
 * selectable capacity is muted, labelled («مغلق»/«ممتلئ»/«غير متاح»),
 * and inert — the state is never conveyed by color alone, and the user
 * cannot spend a tap discovering it. */
function DayChip({
  date,
  label,
  showMonth,
  isSelected,
  capacity,
  onSelect,
}: {
  date: string;
  label: string;
  showMonth: boolean;
  isSelected: boolean;
  capacity: DayCapacityState;
  onSelect: (date: string) => void;
}) {
  const unselectable = isDayUnselectable(capacity);
  const capacityLabel = unselectable
    ? DAY_CAPACITY_LABELS[capacity]
    : showMonth
      ? formatArabicMonth(date)
      : "\u00A0";
  return (
    <button
      type="button"
      // `aria-disabled` (not the native `disabled`) keeps the day in the
      // accessibility tree so its state is announced; with no handler it
      // is inert (never actionable), matching "make impossible actions
      // visibly unavailable".
      aria-disabled={unselectable || undefined}
      aria-pressed={unselectable ? false : isSelected}
      aria-label={
        unselectable
          ? `${label}، ${formatArabicDate(date)}، ${DAY_CAPACITY_LABELS[capacity]}`
          : `${label}، ${formatArabicDate(date)}`
      }
      onClick={unselectable ? undefined : () => onSelect(date)}
      className={cn(
        "flex w-16 flex-col items-center gap-0.5 rounded-xl border px-2 py-2.5 transition-colors",
        unselectable
          ? "cursor-not-allowed border-border/50 bg-muted/50 text-muted-foreground"
          : isSelected
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border bg-card text-foreground hover:bg-accent/60",
      )}
    >
      <span
        className={cn(
          "text-xs font-medium",
          isSelected && !unselectable
            ? "text-primary-foreground"
            : "text-foreground",
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
          unselectable
            ? "font-medium"
            : isSelected
              ? "text-primary-foreground/90"
              : "text-muted-foreground",
        )}
      >
        {capacityLabel}
      </span>
    </button>
  );
}
