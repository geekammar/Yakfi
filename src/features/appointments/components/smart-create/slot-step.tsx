"use client";

import { getAvailabilityAction } from "@/features/appointments/actions/availability-actions";
import { formatArabicDate } from "@/features/appointments/components/smart-create/date-format";
import {
  earliestSlot,
  formatSlotTime,
  groupSlotsByPeriod,
  slotExistsIn,
  timezoneLabel,
} from "@/features/appointments/components/smart-create/slot-helpers";
import type {
  AvailabilityNoSlotsReason,
  SelectedSlot,
} from "@/features/appointments/types";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SLOT_NOUNS, arabicCount } from "@/lib/arabic";
import { cn } from "@/lib/utils";
import { appointmentDateSchema } from "@/lib/validation";

import { useQuery } from "@tanstack/react-query";
import {
  CalendarOffIcon,
  CalendarXIcon,
  CheckCircle2Icon,
  HourglassIcon,
  ZapIcon,
} from "lucide-react";
import { useEffect } from "react";

/** Copy for the explicit no-slots reasons from the availability layer. */
const NO_SLOTS_CONTENT = {
  BUSINESS_CLOSED: {
    icon: CalendarOffIcon,
    title: "المنشأة مغلقة في هذا اليوم",
    description: "لا تعمل المنشأة في التاريخ المحدد. اختر تاريخاً آخر.",
    showServiceAction: false,
  },
  SERVICE_TOO_LONG: {
    icon: HourglassIcon,
    title: "مدة الخدمة لا تناسب هذا اليوم",
    description:
      "مدة الخدمة أطول من ساعات العمل في هذا اليوم. اختر يوماً بساعات أطول أو خدمة أقصر.",
    showServiceAction: true,
  },
  FULLY_BOOKED: {
    icon: CalendarXIcon,
    title: "لا توجد أوقات متاحة",
    description: "اليوم محجوز بالكامل في هذا التاريخ. جرّب تاريخاً آخر.",
    showServiceAction: false,
  },
} as const;

/**
 * Step 4 — الوقت. Real available-slot selection: every displayed time
 * comes from the EXISTING availability layer (`getAvailabilityAction`
 * → `getAvailability`, PROMPT-10) — nothing is invented on the client.
 * The request runs only while the step is mounted with a valid date +
 * the service chosen in Step 2, and the query key carries both inputs
 * so a change to either refetches instead of showing stale times.
 */
export function SlotStep({
  serviceId,
  date,
  selectedSlot,
  onSelectSlot,
  onSlotUnavailable,
  onGoToDate,
  onGoToService,
  excludeAppointmentId,
}: {
  serviceId: string;
  /** Business-local "YYYY-MM-DD" chosen in Step 3. */
  date: string;
  selectedSlot: SelectedSlot | null;
  onSelectSlot: (slot: SelectedSlot) => void;
  /** Called when the fresh server result no longer contains the
   * preserved slot — the wizard clears it through its own mechanism so
   * no stale slot can reach the review step. */
  onSlotUnavailable: () => void;
  onGoToDate: () => void;
  onGoToService: () => void;
  /**
   * B-08 — the id of the appointment being rescheduled, so it is
   * excluded from its OWN conflict set (the availability layer
   * re-resolves it against the actor's Business). Absent for the
   * create flow (unchanged behavior).
   */
  excludeAppointmentId?: string;
}) {
  const dateIsValid = appointmentDateSchema.safeParse(date).success;
  const availability = useQuery({
    queryKey: [
      "booking-availability",
      serviceId,
      date,
      excludeAppointmentId ?? null,
    ],
    queryFn: () =>
      getAvailabilityAction({
        date,
        serviceId,
        ...(excludeAppointmentId ? { excludeAppointmentId } : {}),
      }),
    enabled: dateIsValid,
    retry: 1,
  });

  const result = availability.data;
  const resultError =
    result && !result.success
      ? { code: result.error.code, message: result.error.message }
      : null;
  const requestError = availability.error ? "تعذر تحميل الأوقات الآن" : null;
  const error = resultError
    ? { ...resultError, serviceRelated: isServiceError(resultError.code) }
    : requestError
      ? {
          code: null,
          message: requestError,
          serviceRelated: false,
        }
      : null;

  // A success result with at least one bookable slot.
  const slotsResult =
    result && result.success && result.data.slots.length > 0 ? result : null;
  const slots = slotsResult ? slotsResult.data.slots : null;
  // B-07 §C — the earliest server-provided slot (null when none).
  const earliest = slots ? earliestSlot(slots) : null;
  // Zero-slot success always carries an explicit reason by contract;
  // FULLY_BOOKED is the defensive fallback for a reasonless empty list.
  const emptyReason: AvailabilityNoSlotsReason | null =
    result && result.success && result.data.slots.length === 0
      ? (result.reason ?? "FULLY_BOOKED")
      : null;
  // Stale-selection guard: the wizard clears the selection when service
  // or date changes; membership in the CURRENT result is the backstop.
  const currentSlot =
    slots && slotExistsIn(selectedSlot, slots) ? selectedSlot : null;

  // A fresh successful result that lost the preserved slot (booked by
  // someone else meanwhile) clears it in the wizard's own state too —
  // otherwise a stale slot could survive into the review summary.
  useEffect(() => {
    if (
      result?.success &&
      selectedSlot &&
      !slotExistsIn(selectedSlot, result.data.slots)
    ) {
      onSlotUnavailable();
    }
  }, [result, selectedSlot, onSlotUnavailable]);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 rounded-xl border bg-muted/40 px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">التاريخ المحدد</p>
          <p className="truncate text-sm font-medium">
            {formatArabicDate(date)}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={onGoToDate}
        >
          تغيير التاريخ
        </Button>
      </div>

      {availability.isPending ? (
        <div className="space-y-5" aria-busy="true">
          <p role="status" className="sr-only">
            جارٍ تحميل الأوقات المتاحة…
          </p>
          {Array.from({ length: 2 }, (_, group) => (
            <div key={group} className="space-y-2">
              <Skeleton className="h-4 w-16" />
              <div className="flex flex-wrap gap-2">
                {Array.from({ length: 5 }, (_, index) => (
                  <Skeleton
                    key={index}
                    className="h-11 w-[5.25rem] rounded-xl"
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="space-y-3 rounded-xl border border-destructive/30 bg-destructive/10 p-4">
          <p role="alert" className="text-sm">
            {error.message}
          </p>
          <div className="flex flex-wrap gap-2">
            {error.serviceRelated ? (
              <Button type="button" size="sm" onClick={onGoToService}>
                العودة إلى الخدمات
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void availability.refetch()}
              disabled={availability.isFetching}
            >
              إعادة المحاولة
            </Button>
          </div>
        </div>
      ) : slotsResult ? (
        <>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {arabicCount(slotsResult.data.slots.length, SLOT_NOUNS)} · بتوقيت{" "}
            {timezoneLabel(slotsResult.data.timezone)}
          </p>
          {/* B-07 §C — the availability-first fast path: one tap books
           * the earliest valid time. The availability contract returns
           * slots ascending, so this is always the FIRST server-provided
           * slot — nothing invented on the client. */}
          {earliest ? (
            <Button
              type="button"
              className="w-full sm:w-auto"
              onClick={() => onSelectSlot(earliest)}
            >
              <ZapIcon aria-hidden />
              أقرب وقت متاح · {formatSlotTime(earliest.startTime)}
            </Button>
          ) : null}
          {groupSlotsByPeriod(slotsResult.data.slots).map((group) => (
            <section
              key={group.period}
              aria-label={group.label}
              className="space-y-2"
            >
              <h3 className="text-sm font-medium">{group.label}</h3>
              <ul className="flex list-none flex-wrap gap-2">
                {group.slots.map((slot) => {
                  const isSelected = currentSlot?.startTime === slot.startTime;
                  return (
                    <li key={slot.startTime}>
                      <button
                        type="button"
                        onClick={() => onSelectSlot(slot)}
                        aria-pressed={isSelected}
                        aria-label={`حجز من ${formatSlotTime(slot.startTime)} إلى ${formatSlotTime(slot.endTime)}`}
                        className={cn(
                          "flex h-11 min-w-[5.25rem] items-center justify-center gap-1.5 rounded-xl border px-4 text-sm font-medium transition-colors",
                          isSelected
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border bg-card text-foreground hover:bg-accent/60",
                        )}
                      >
                        <span className="tabular-nums">
                          {formatSlotTime(slot.startTime)}
                        </span>
                        {isSelected ? (
                          <CheckCircle2Icon
                            aria-hidden
                            className="size-4 shrink-0"
                          />
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
          {currentSlot ? (
            <div
              role="status"
              className="space-y-1.5 rounded-xl border border-primary/40 bg-primary/5 p-4"
            >
              <p className="flex items-center gap-2 text-sm font-semibold">
                <CheckCircle2Icon
                  aria-hidden
                  className="size-5 shrink-0 text-primary"
                />
                تم اختيار الوقت
              </p>
              <p className="text-sm">
                <span className="font-medium tabular-nums">
                  {formatSlotTime(currentSlot.startTime)} –{" "}
                  {formatSlotTime(currentSlot.endTime)}
                </span>
              </p>
              <p className="text-xs text-muted-foreground">
                تابع إلى المراجعة للتأكد من تفاصيل الموعد قبل التأكيد.
              </p>
            </div>
          ) : null}
        </>
      ) : emptyReason ? (
        <EmptyState
          icon={NO_SLOTS_CONTENT[emptyReason].icon}
          title={NO_SLOTS_CONTENT[emptyReason].title}
          description={NO_SLOTS_CONTENT[emptyReason].description}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button type="button" size="sm" onClick={onGoToDate}>
                تغيير التاريخ
              </Button>
              {NO_SLOTS_CONTENT[emptyReason].showServiceAction ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={onGoToService}
                >
                  تغيير الخدمة
                </Button>
              ) : null}
            </div>
          }
        />
      ) : null}
    </div>
  );
}

/** Typed errors that mean the Step 2 service can no longer be booked. */
function isServiceError(code: string | null): boolean {
  return code === "SERVICE_NOT_FOUND" || code === "SERVICE_INACTIVE";
}
