"use client";

import { updateAppointmentStatus } from "@/features/appointments/actions/appointment-actions";
import { formatArabicDate } from "@/features/appointments/components/smart-create/date-format";
import { formatSlotTime } from "@/features/appointments/components/smart-create/slot-helpers";
import type { AppointmentActionResult } from "@/features/appointments/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import {
  CalendarIcon,
  ClockIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
  UserIcon,
} from "lucide-react";
import React, { useEffect, useRef, useState } from "react";

function formatTime(time: string) {
  const timeSlice = time.includes("T") ? time.slice(11, 16) : time.slice(0, 5);
  return formatSlotTime(timeSlice);
}

export type AppointmentCancelTarget = {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  customer: {
    name: string;
    phone?: string | null;
  };
  service: {
    name: string;
    durationMinutes?: number;
  };
};

export type AppointmentCancelDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appointment: AppointmentCancelTarget | null;
  /** Explicit control to restore focus to on dialog closure (when opener survives). */
  returnFocusRef?: React.RefObject<HTMLElement | null>;
  /** Fallback focus target if the opener control has unmounted (e.g. after cancellation). */
  fallbackFocusRef?: React.RefObject<HTMLElement | null>;
  /** Optional custom action runner, defaulting to updateAppointmentStatus. */
  cancelAction?: (input: {
    id: string;
    status: "CANCELLED";
  }) => Promise<AppointmentActionResult>;
  /** Called after server confirmation has succeeded. */
  onCancelled: () => void;
};

/**
 * Accessible confirmation dialog for appointment cancellation.
 * Ensures zero mutations on dismiss/escape/cancel, displays customer,
 * service, and date/time, prevents duplicate submissions while pending,
 * and restores focus to an appropriate surviving control upon closure.
 */
export function AppointmentCancelDialog({
  open,
  onOpenChange,
  appointment,
  returnFocusRef,
  fallbackFocusRef,
  cancelAction = updateAppointmentStatus,
  onCancelled,
}: AppointmentCancelDialogProps) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const capturedOpenerRef = useRef<HTMLElement | null>(null);

  // Capture active element when dialog opens as opener fallback
  useEffect(() => {
    if (open) {
      if (capturedOpenerRef.current == null) {
        const active = document.activeElement;
        if (active instanceof HTMLElement && active !== document.body) {
          capturedOpenerRef.current = active;
        }
      }
    } else {
      capturedOpenerRef.current = null;
    }
  }, [open]);

  function handleOpenChange(val: boolean) {
    if (submitting) return;
    if (val) {
      setError(null);
    }
    onOpenChange(val);
  }

  function handleCloseAutoFocus(event: Event) {
    event.preventDefault();
    const opener = returnFocusRef?.current ?? capturedOpenerRef.current;
    if (opener && opener.isConnected && typeof opener.focus === "function") {
      opener.focus();
      return;
    }
    if (
      fallbackFocusRef?.current &&
      fallbackFocusRef.current.isConnected &&
      typeof fallbackFocusRef.current.focus === "function"
    ) {
      fallbackFocusRef.current.focus();
      return;
    }
    if (typeof document !== "undefined") {
      const fallback = document.querySelector<HTMLElement>(
        '[data-testid="appointment-back-btn"], [data-testid="appointment-follow-up-btn"], main button:not([disabled]), main a[href], [tabindex="0"]',
      );
      fallback?.focus();
    }
  }

  async function handleConfirm() {
    if (!appointment || submitting) return;
    setError(null);
    setSubmitting(true);

    try {
      const result = await cancelAction({
        id: appointment.id,
        status: "CANCELLED",
      });

      if (!result.success) {
        setError(result.message || "تعذر إلغاء الموعد");
        setSubmitting(false);
        return;
      }

      setSubmitting(false);
      onOpenChange(false);
      onCancelled();
    } catch {
      setError("حدث خطأ غير متوقع أثناء إلغاء الموعد");
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        onCloseAutoFocus={handleCloseAutoFocus}
        onEscapeKeyDown={(e) => {
          if (submitting) e.preventDefault();
        }}
        onPointerDownOutside={(e) => {
          if (submitting) e.preventDefault();
        }}
        className="max-w-md"
      >
        <DialogHeader>
          <div className="flex items-center gap-2 text-destructive">
            <TriangleAlertIcon className="size-5 shrink-0" aria-hidden="true" />
            <DialogTitle>تأكيد إلغاء الموعد</DialogTitle>
          </div>
          <DialogDescription>
            هل أنت متأكد من رغبتك في إلغاء هذا الموعد؟ لا يمكن التراجع عن هذا
            الإجراء تلقائياً.
          </DialogDescription>
        </DialogHeader>

        {appointment ? (
          <div
            className="rounded-lg border bg-muted/40 p-3.5 text-sm space-y-2.5"
            data-testid="cancel-appointment-summary"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium">
                <UserIcon className="size-3.5" aria-hidden="true" />
                العميل:
              </span>
              <span
                className="font-semibold text-foreground truncate"
                data-testid="cancel-customer-name"
              >
                {appointment.customer.name}
              </span>
            </div>

            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium">
                <CalendarIcon className="size-3.5" aria-hidden="true" />
                الخدمة:
              </span>
              <span
                className="font-semibold text-foreground truncate"
                data-testid="cancel-service-name"
              >
                {appointment.service.name}
              </span>
            </div>

            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium">
                <ClockIcon className="size-3.5" aria-hidden="true" />
                الموعد:
              </span>
              <span
                className="font-semibold text-foreground tabular-nums text-xs sm:text-sm"
                data-testid="cancel-datetime"
              >
                {formatArabicDate(appointment.date)} ·{" "}
                {formatTime(appointment.startTime)} -{" "}
                {formatTime(appointment.endTime)}
              </span>
            </div>
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="text-sm font-medium text-destructive">
            {error}
          </p>
        ) : null}

        <DialogFooter className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-2">
          <Button
            type="button"
            variant="outline"
            className="min-h-[44px] min-w-[44px] w-full sm:w-auto"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            data-testid="cancel-dialog-decline-btn"
          >
            تراجع
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="min-h-[44px] min-w-[44px] w-full sm:w-auto"
            onClick={() => void handleConfirm()}
            disabled={submitting}
            data-testid="cancel-dialog-confirm-btn"
          >
            {submitting ? (
              <LoaderCircleIcon className="size-4 animate-spin me-2" />
            ) : null}
            تأكيد الإلغاء
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
