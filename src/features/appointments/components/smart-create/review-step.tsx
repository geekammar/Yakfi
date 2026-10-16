"use client";

import { formatArabicDate } from "@/features/appointments/components/smart-create/date-format";
import { formatSlotTime } from "@/features/appointments/components/smart-create/slot-helpers";
import type {
  BookingCustomerOption,
  BookingServiceOption,
  ReviewCheckState,
  SelectedSlot,
} from "@/features/appointments/types";
import { Button } from "@/components/ui/button";
import { appointmentDateSchema } from "@/lib/validation";

import { AlertCircleIcon, CheckCircle2Icon, Clock3Icon } from "lucide-react";

/** A missing required review input and the step that provides it. */
export type ReviewMissingField = {
  field: "customer" | "service" | "date" | "slot";
  /** Arabic, actionable explanation of what is missing. */
  message: string;
  /** The wizard screen that can provide the missing input. */
  target: "customer" | "service" | "date" | "slot";
  /** Arabic label for the "go fix it" action. */
  action: string;
};

/**
 * Pure derivation of the review step's missing required inputs
 * (PROMPT-13 §E). No fallback values are invented — an absent or
 * invalid input is reported as missing with the step that provides it.
 */
export function getMissingReviewFields(input: {
  customer: BookingCustomerOption | null;
  service: BookingServiceOption | null;
  date: string | null;
  selectedSlot: SelectedSlot | null;
}): ReviewMissingField[] {
  const missing: ReviewMissingField[] = [];
  if (!input.customer) {
    missing.push({
      field: "customer",
      message: "لم يتم اختيار العميل.",
      target: "customer",
      action: "اختيار العميل",
    });
  }
  if (!input.service) {
    missing.push({
      field: "service",
      message: "لم يتم اختيار الخدمة.",
      target: "service",
      action: "اختيار الخدمة",
    });
  }
  const dateIsValid =
    typeof input.date === "string" &&
    appointmentDateSchema.safeParse(input.date).success;
  if (!dateIsValid) {
    missing.push({
      field: "date",
      message: "لم يتم تحديد تاريخ صالح للموعد.",
      target: "date",
      action: "تحديد التاريخ",
    });
  }
  if (!input.selectedSlot) {
    missing.push({
      field: "slot",
      message: "لم يتم اختيار وقت للموعد.",
      target: "slot",
      action: "اختيار الوقت",
    });
  }
  return missing;
}

/**
 * Step 5 — المراجعة (PROMPT-13). One-glance booking summary of the
 * already-selected customer, service, date, and slot, each with an
 * obvious تعديل affordance back to its step. The primary action lives
 * in the wizard footer (the container owns the revalidation): it
 * never creates an appointment and only allows leaving the step after
 * the slot is revalidated against the CURRENT availability. A
 * verified review is a HAND-OFF to Step 6 (التأكيد), not a
 * reservation — the final write still relies on the conflict check
 * inside `createAppointment`.
 */
export function ReviewStep({
  customer,
  service,
  date,
  selectedSlot,
  checkState,
  providerName,
  isSingleProvider,
  onGoToCustomer,
  onGoToService,
  onGoToDate,
  onGoToSlot,
}: {
  customer: BookingCustomerOption | null;
  service: BookingServiceOption | null;
  /** Business-local "YYYY-MM-DD" chosen in Step 3. */
  date: string | null;
  selectedSlot: SelectedSlot | null;
  checkState: ReviewCheckState;
  providerName?: string | null;
  isSingleProvider?: boolean;
  onGoToCustomer: () => void;
  onGoToService: () => void;
  onGoToDate: () => void;
  onGoToSlot: () => void;
}) {
  const goToTarget = {
    customer: onGoToCustomer,
    service: onGoToService,
    date: onGoToDate,
    slot: onGoToSlot,
  } as const;

  const missing = getMissingReviewFields({
    customer,
    service,
    date,
    selectedSlot,
  });

  // A failed revalidation clears the stale slot first (the wizard's
  // existing mechanism), so this panel takes precedence over the
  // generic missing-slot notice — it explains WHY the slot vanished.
  if (checkState.status === "stale") {
    return (
      <div
        role="alert"
        className="space-y-3 rounded-xl border border-destructive/30 bg-destructive/10 p-4"
      >
        <p className="flex items-center gap-2 text-sm font-semibold">
          <AlertCircleIcon
            aria-hidden
            className="size-5 shrink-0 text-destructive"
          />
          لم يعد الوقت متاحاً
        </p>
        <p className="text-sm">{checkState.message}</p>
        <Button type="button" size="sm" onClick={onGoToSlot}>
          اختيار وقت آخر
        </Button>
      </div>
    );
  }

  if (missing.length > 0) {
    return (
      <div
        role="alert"
        className="space-y-3 rounded-xl border border-destructive/30 bg-destructive/10 p-4"
      >
        <p className="flex items-center gap-2 text-sm font-semibold">
          <AlertCircleIcon
            aria-hidden
            className="size-5 shrink-0 text-destructive"
          />
          لا يمكن إكمال المراجعة — تفاصيل ناقصة
        </p>
        <ul className="space-y-2">
          {missing.map((item) => (
            <li
              key={item.field}
              className="flex flex-wrap items-center justify-between gap-2"
            >
              <span className="min-w-0 flex-1 text-sm">{item.message}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={goToTarget[item.target]}
              >
                {item.action}
              </Button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  // The missing-fields derivation above is the single authority; this
  // guard only satisfies the type checker (unreachable when the list is
  // empty) and keeps the summary below free of fallback values.
  if (!customer || !service || !selectedSlot || !date) return null;

  return (
    <div className="space-y-3">
      {checkState.status === "checking" ? (
        <p role="status" aria-live="polite" className="sr-only">
          جارٍ التحقق من توفر الوقت المحدد…
        </p>
      ) : null}

      <section
        aria-label="تفاصيل العميل"
        className="rounded-xl border bg-card p-4"
      >
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold">العميل</h3>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={onGoToCustomer}
            aria-label="تعديل العميل"
          >
            تعديل
          </Button>
        </div>
        <p className="mt-2 truncate text-sm font-medium">{customer.name}</p>
        <p className="mt-0.5 text-sm text-muted-foreground" dir="ltr">
          <span className="tabular-nums">{customer.phone}</span>
        </p>
      </section>

      <section
        aria-label="تفاصيل الخدمة"
        className="rounded-xl border bg-card p-4"
      >
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold">الخدمة</h3>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={onGoToService}
            aria-label="تعديل الخدمة"
          >
            تعديل
          </Button>
        </div>
        <p className="mt-2 truncate text-sm font-medium">{service.name}</p>
        <p className="mt-0.5 flex items-center gap-1.5 text-sm text-muted-foreground">
          <Clock3Icon aria-hidden className="size-3.5" />
          <span className="tabular-nums">{service.durationMinutes}</span>
          دقيقة
        </p>
      </section>

      {providerName ? (
        <section
          aria-label="تفاصيل الموظف"
          className="rounded-xl border bg-card p-4"
        >
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">الموظف</h3>
            {!isSingleProvider ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={onGoToSlot}
                aria-label="تعديل الموظف"
              >
                تعديل
              </Button>
            ) : null}
          </div>
          <p className="mt-2 truncate text-sm font-medium">{providerName}</p>
        </section>
      ) : null}

      <section
        aria-label="تفاصيل التاريخ"
        className="rounded-xl border bg-card p-4"
      >
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold">التاريخ</h3>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={onGoToDate}
            aria-label="تعديل التاريخ"
          >
            تعديل
          </Button>
        </div>
        <p className="mt-2 text-sm font-medium">{formatArabicDate(date)}</p>
      </section>

      <section
        aria-label="تفاصيل الوقت"
        className="rounded-xl border bg-card p-4"
      >
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold">الوقت</h3>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={onGoToSlot}
            aria-label="تعديل الوقت"
          >
            تعديل
          </Button>
        </div>
        <p className="mt-2 text-sm font-medium">
          <span className="tabular-nums">
            من {formatSlotTime(selectedSlot.startTime)} إلى{" "}
            {formatSlotTime(selectedSlot.endTime)}
          </span>
        </p>
      </section>

      {checkState.status === "verified" ? (
        <div
          role="status"
          className="space-y-1.5 rounded-xl border border-primary/40 bg-primary/5 p-4"
        >
          <p className="flex items-center gap-2 text-sm font-semibold">
            <CheckCircle2Icon
              aria-hidden
              className="size-5 shrink-0 text-primary"
            />
            تم التحقق من التفاصيل
          </p>
          <p className="text-sm">
            الوقت المحدد ما زال متاحاً حتى الآن — يمكنك المتابعة إلى التأكيد
            النهائي.
          </p>
        </div>
      ) : null}

      {checkState.status === "failed" ? (
        <div
          role="alert"
          className="rounded-xl border border-destructive/30 bg-destructive/10 p-4"
        >
          <p className="text-sm">
            تعذر التحقق من توفر الوقت الآن. حاول المتابعة مرة أخرى.
          </p>
        </div>
      ) : null}
    </div>
  );
}
