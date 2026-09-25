"use client";

/**
 * Availability-Guided Reschedule (B-08).
 *
 * The reschedule surface for an EXISTING appointment. Customer and
 * service are preserved (never asked again — the system already knows
 * them), and the operator is guided by REAL availability through the
 * SAME two B-07 steps the create wizard uses:
 *
 *   التاريخ → الوقت → التأكيد
 *
 * Rules (hard):
 * - The appointment being rescheduled is excluded from its OWN conflict
 *   set through `excludeAppointmentId` — the availability authority
 *   re-resolves it against the actor's own Business server-side, so
 *   its current slot is legitimately offered while every OTHER
 *   appointment still blocks. The write path
 *   (`rescheduleWithConflictCheck`) excludes itself independently, so
 *   read guidance and the write guard agree by construction.
 * - Nothing is invented on the client: every displayed slot comes from
 *   `getAvailabilityAction` (PROMPT-10, the one availability engine).
 * - Stale slots cannot survive: a fresh result that lost the preserved
 *   slot clears the selection; the final write's transactional conflict
 *   check remains the last guard.
 * - Double submission is blocked in-flight (ref + disabled button) and
 *   by the write path's own conflict check.
 * - On success the SERVER's persisted values are the only source of
 *   truth — the client never recomputes endTime or the date.
 */
import { rescheduleAppointment } from "@/features/appointments/actions/appointment-actions";
import { formatArabicDate } from "@/features/appointments/components/smart-create/date-format";
import { DateStep } from "@/features/appointments/components/smart-create/date-step";
import {
  formatSlotTime,
  timezoneLabel,
} from "@/features/appointments/components/smart-create/slot-helpers";
import { SlotStep } from "@/features/appointments/components/smart-create/slot-step";
import type {
  AppointmentDetailData,
  RescheduleAppointmentActionResult,
  SelectedSlot,
} from "@/features/appointments/types";
import { Button } from "@/components/ui/button";
import { appointmentDateSchema } from "@/lib/validation";

import {
  CalendarClockIcon,
  CheckCircle2Icon,
  LoaderCircleIcon,
  RotateCwIcon,
} from "lucide-react";
import { useRef, useState } from "react";

/** The two guided stages (context is already known — no customer/service steps). */
type RescheduleStage = "date" | "slot";

export function ReschedulePanel({
  appointment,
  today,
  timezone,
  onDone,
  onCancel,
}: {
  /** The appointment being rescheduled (server-resolved, tenant-scoped). */
  appointment: AppointmentDetailData;
  /** Business-local "YYYY-MM-DD" today (server-derived). */
  today: string;
  /** Business timezone (server-derived) — display only. */
  timezone: string;
  /** Called with the SERVER-persisted values after a confirmed success. */
  onDone: (updated: {
    date: string;
    startTime: string;
    endTime: string;
  }) => void;
  onCancel: () => void;
}) {
  const [stage, setStage] = useState<RescheduleStage>("date");
  const [date, setDate] = useState(appointment.date);
  const [selectedSlot, setSelectedSlot] = useState<SelectedSlot | null>(null);
  const [submitState, setSubmitState] = useState<
    | { status: "idle" }
    | { status: "submitting" }
    | { status: "error"; message: string; code?: string }
  >({ status: "idle" });
  /** Re-entrancy guard: a second tap during an in-flight reschedule must
   * never issue a second write. */
  const submitInFlight = useRef(false);

  const dateIsValid = appointmentDateSchema.safeParse(date).success;
  const resolvedSlot: SelectedSlot | null = selectedSlot;

  function handleSelectDate(nextDate: string) {
    if (nextDate !== date) setSelectedSlot(null);
    setDate(nextDate);
    setSubmitState({ status: "idle" });
  }

  function handleSelectSlot(slot: SelectedSlot) {
    setSelectedSlot(slot);
    setSubmitState({ status: "idle" });
  }

  function handleSlotUnavailable() {
    setSelectedSlot(null);
    setSubmitState({ status: "idle" });
  }

  /**
   * The final write. Only the appointment's id + the server-validated
   * date/startTime are submitted; endTime, tenant scope and the conflict
   * guard all live server-side. The action re-resolves the appointment
   * against the actor's own Business, so a stale or foreign id can never
   * move another tenant's row.
   */
  async function handleSubmit() {
    if (submitInFlight.current) return;
    if (!dateIsValid || !resolvedSlot) return;
    submitInFlight.current = true;
    setSubmitState({ status: "submitting" });
    let result: RescheduleAppointmentActionResult;
    try {
      result = await rescheduleAppointment({
        id: appointment.id,
        date,
        startTime: resolvedSlot.startTime,
      });
    } catch {
      submitInFlight.current = false;
      setSubmitState({
        status: "error",
        code: "RESCHEDULE_FAILED",
        message: "تعذر إعادة جدولة الموعد الآن. حاول مرة أخرى.",
      });
      return;
    }
    submitInFlight.current = false;
    if (result.success) {
      setSubmitState({ status: "idle" });
      onDone({
        date: result.date,
        startTime: result.startTime,
        endTime: result.endTime,
      });
    } else {
      // A SLOT_CONFLICT means the slot was taken between display and
      // confirmation — clear it so the operator picks a fresh one
      // (a stale slot can never be re-submitted).
      if (result.code === "SLOT_CONFLICT") setSelectedSlot(null);
      setSubmitState({
        status: "error",
        code: result.code,
        message: result.message,
      });
    }
  }

  const conflict =
    submitState.status === "error" && submitState.code === "SLOT_CONFLICT";

  return (
    <section
      aria-labelledby="reschedule-title"
      className="space-y-4 rounded-xl border bg-card p-4 shadow-xs sm:p-5"
    >
      <header className="space-y-1">
        <h2
          id="reschedule-title"
          className="flex items-center gap-2 font-semibold"
        >
          <RotateCwIcon aria-hidden className="size-4" />
          إعادة جدولة الموعد
        </h2>
        <p className="text-sm text-muted-foreground">
          العميل والخدمة محفوظان — اختر التاريخ ثم الوقت المتاح.
        </p>
      </header>

      {/* Preserved context — shown, never re-asked. */}
      <dl className="space-y-1.5 rounded-xl border bg-muted/40 px-4 py-3 text-sm">
        <div className="flex items-center justify-between gap-3">
          <dt className="shrink-0 text-muted-foreground">العميل</dt>
          <dd className="truncate font-medium">{appointment.customer.name}</dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="shrink-0 text-muted-foreground">الخدمة</dt>
          <dd className="truncate font-medium">
            {appointment.service.name} · {appointment.service.durationMinutes}{" "}
            دقيقة
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="shrink-0 text-muted-foreground">الموعد الحالي</dt>
          <dd className="truncate font-medium tabular-nums">
            {formatArabicDate(appointment.date)} ·{" "}
            {formatSlotTime(toWallClock(appointment.startTime))}
          </dd>
        </div>
      </dl>

      {stage === "date" ? (
        <>
          <div className="flex items-center justify-between gap-3 rounded-xl border bg-muted/40 px-4 py-3">
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">المرحلة</p>
              <p className="truncate text-sm font-medium">١ · التاريخ الجديد</p>
            </div>
          </div>
          <DateStep
            selectedDate={date}
            today={today}
            onSelect={handleSelectDate}
            serviceId={appointment.service.id}
            excludeAppointmentId={appointment.id}
          />
          <div className="flex gap-2 border-t pt-4">
            <Button type="button" variant="ghost" onClick={onCancel}>
              إلغاء
            </Button>
            <Button
              type="button"
              className="ms-auto"
              disabled={!dateIsValid}
              onClick={() => setStage("slot")}
            >
              الأوقات المتاحة
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3 rounded-xl border bg-muted/40 px-4 py-3">
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">المرحلة</p>
              <p className="truncate text-sm font-medium">
                ٢ · الوقت المتاح · بتوقيت {timezoneLabel(timezone)}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => setStage("date")}
            >
              تغيير التاريخ
            </Button>
          </div>
          <SlotStep
            serviceId={appointment.service.id}
            date={date}
            selectedSlot={resolvedSlot}
            onSelectSlot={handleSelectSlot}
            onSlotUnavailable={handleSlotUnavailable}
            onGoToDate={() => setStage("date")}
            onGoToService={() => setStage("date")}
            excludeAppointmentId={appointment.id}
          />
          {resolvedSlot ? (
            <div
              role="status"
              className="space-y-1.5 rounded-xl border border-primary/40 bg-primary/5 p-4"
            >
              <p className="flex items-center gap-2 text-sm font-semibold">
                <CheckCircle2Icon
                  aria-hidden
                  className="size-5 shrink-0 text-primary"
                />
                الوقت المختار
              </p>
              <p className="text-sm tabular-nums">
                {formatArabicDate(date)} ·{" "}
                <span className="font-medium">
                  {formatSlotTime(resolvedSlot.startTime)} –{" "}
                  {formatSlotTime(resolvedSlot.endTime)}
                </span>
              </p>
            </div>
          ) : null}
          {submitState.status === "error" ? (
            <p role="alert" className="text-sm text-destructive">
              {submitState.message}
            </p>
          ) : null}
          <div className="flex gap-2 border-t pt-4">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setStage("date")}
            >
              رجوع
            </Button>
            <Button
              type="button"
              className="ms-auto"
              disabled={
                !resolvedSlot || submitState.status === "submitting" || conflict
              }
              onClick={() => void handleSubmit()}
            >
              {submitState.status === "submitting" ? (
                <LoaderCircleIcon aria-hidden className="animate-spin" />
              ) : (
                <CalendarClockIcon aria-hidden />
              )}
              تأكيد الموعد الجديد
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

/** Stored epoch time → business-local "HH:mm" (the detail data's format). */
function toWallClock(time: string): string {
  return new Date(time).toISOString().slice(11, 16);
}
