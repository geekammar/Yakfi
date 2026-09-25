"use client";

import { getAvailabilityAction } from "@/features/appointments/actions/availability-actions";
import { formatArabicDate } from "@/features/appointments/components/smart-create/date-format";
import {
  derivePresentSlots,
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
import { generateCandidateGrid } from "@/lib/scheduling/slot-grid";
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
import { useEffect, useMemo } from "react";

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
    description: "لا يمكن حجز أي وقت في هذا التاريخ حالياً. جرّب تاريخاً آخر.",
    showServiceAction: false,
  },
} as const;

/** The only label an unselectable candidate ever gets — never a reason. */
const UNAVAILABLE_LABEL = "غير متاح";

/**
 * Step 4 — الوقت. Real available-slot selection (DECISIONS #56):
 *
 * The step renders the KNOWN candidate time grid for the chosen day —
 * derived from the business's stored working-hours week + slot
 * granularity through the ONE grid rule (`@/lib/scheduling/slot-grid`,
 * the same one the availability authority uses) — and derives only a
 * PRESENTATIONAL state per candidate against the authority's single
 * result:
 *
 *   candidate exists in the available set  → AVAILABLE / selectable
 *   candidate is not returned              → UNAVAILABLE / disabled /
 *                                             muted / non-clickable,
 *                                             labelled «غير متاح»
 *
 * The authority itself still returns ONLY genuinely selectable slots
 * (the contract is unchanged); the frontend never infers WHY a
 * candidate is missing — it never labels one «مشغول» or assigns a
 * reason. One `getAvailabilityAction` request serves the whole step (no
 * per-candidate requests), and selecting still funnels through the
 * wizard into the canonical write path. When the grid inputs are absent
 * the step honestly falls back to showing the authority's selectable
 * slots only — nothing is invented.
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
  workingHours,
  slotDurationMinutes,
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
  /**
   * The candidate time grid (DECISIONS #56 — Spec A slot presentation):
   * the business's stored working-hours week + slot granularity, both
   * server-derived. When both are present, the step renders the KNOWN
   * candidate times for the chosen day and derives only a
   * PRESENTATIONAL state per candidate — present in the authority's
   * available set → selectable; absent → visibly muted, disabled and
   * labelled «غير متاح» (never a reason — the authority returns
   * selectable slots only and the frontend infers nothing from
   * absence). Absent inputs → the step falls back to showing the
   * authority's selectable slots only (nothing is invented).
   */
  workingHours?: unknown;
  slotDurationMinutes?: number | null;
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

  /**
   * The candidate time grid for the chosen day, derived from the SAME
   * rule the availability authority uses (`@/lib/scheduling/slot-grid`)
   * over the server-derived working-hours week + slot granularity and
   * the AUTHORITY's own `serviceDurationMinutes`. This is pure
   * presentation: a candidate is bookable ONLY when the authority's
   * result contains it (`available`), and every other candidate is
   * shown disabled — the frontend never decides WHY a candidate is
   * missing, and never invents candidates.
   */
  const serviceDurationMinutes = result?.success
    ? result.data.serviceDurationMinutes
    : null;
  const candidateGrid = useMemo(() => {
    if (!serviceDurationMinutes || !slotDurationMinutes) return null;
    return generateCandidateGrid({
      workingHours,
      date,
      durationMinutes: serviceDurationMinutes,
      slotDurationMinutes,
    });
  }, [workingHours, date, serviceDurationMinutes, slotDurationMinutes]);

  /**
   * What the step renders as chips (DECISIONS #56): the candidate grid
   * when it can be derived — each candidate flagged by its authority
   * membership — or the authority's selectable slots when the grid
   * cannot be derived (the honest fallback). null → no chips. Pure
   * derivation (`derivePresentSlots`), so the behavior is unit-verified.
   */
  const presentSlots = useMemo(
    () => derivePresentSlots({ candidateGrid, availableSlots: slots }),
    [candidateGrid, slots],
  );
  const availableCount = presentSlots
    ? presentSlots.filter((slot) => slot.available).length
    : 0;
  const unavailableCount = presentSlots
    ? presentSlots.length - availableCount
    : 0;
  const timezone = result?.success ? result.data.timezone : null;

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
      ) : presentSlots ? (
        <>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {arabicCount(availableCount, SLOT_NOUNS)}
            {unavailableCount > 0 ? (
              <span className="text-muted-foreground/80">
                {" · "}
                {unavailableCount} {UNAVAILABLE_LABEL}
              </span>
            ) : null}
            {timezone ? ` · بتوقيت ${timezoneLabel(timezone)}` : null}
          </p>
          {/* A day whose candidates are all unselectable: the grid is
           * still shown (everything disabled) so the user sees what the
           * day looks like, with one honest recovery action. The state
           * is never explained with a reason the backend did not give. */}
          {availableCount === 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-muted/40 px-4 py-3">
              <p className="text-sm">لا توجد أوقات متاحة في هذا اليوم.</p>
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
          ) : null}
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
          {groupSlotsByPeriod(presentSlots).map((group) => (
            <section
              key={group.period}
              aria-label={group.label}
              className="space-y-2"
            >
              <h3 className="text-sm font-medium">{group.label}</h3>
              <ul className="flex list-none flex-wrap gap-2">
                {group.slots.map((slot) => {
                  const isSelected =
                    slot.available && currentSlot?.startTime === slot.startTime;
                  return (
                    <li key={slot.startTime}>
                      {slot.available ? (
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
                      ) : (
                        /* A candidate the authority did NOT return. It
                         * stays visible and visibly NOT selectable —
                         * muted, inert and labelled «غير متاح» — but no
                         * reason is ever inferred (never «مشغول»), and
                         * `aria-disabled` keeps it announced rather than
                         * erased from the accessibility tree. */
                        <button
                          type="button"
                          aria-disabled
                          aria-label={`${formatSlotTime(slot.startTime)} — ${UNAVAILABLE_LABEL}`}
                          className="flex h-11 min-w-[5.25rem] cursor-not-allowed flex-col items-center justify-center gap-0.5 rounded-xl border border-border/50 bg-muted/40 px-3 text-muted-foreground"
                        >
                          <span className="text-sm tabular-nums line-through">
                            {formatSlotTime(slot.startTime)}
                          </span>
                          <span className="text-[10px] leading-none">
                            {UNAVAILABLE_LABEL}
                          </span>
                        </button>
                      )}
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
