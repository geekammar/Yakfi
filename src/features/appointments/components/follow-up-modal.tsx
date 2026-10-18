"use client";

import { createFollowUpRequest } from "@/features/appointments/actions/follow-up-actions";
import {
  FollowUpRangeSelector,
  type DateRange,
} from "@/features/appointments/components/follow-up-range-selector";
import { formatArabicDate } from "@/features/appointments/components/smart-create/date-format";
import type { AppointmentDetailData } from "@/features/appointments/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import {
  CalendarClockIcon,
  CalendarDaysIcon,
  CalendarPlusIcon,
  CheckCircle2Icon,
  CheckIcon,
  ChevronLeftIcon,
  LoaderCircleIcon,
} from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";

type FollowUpMode = "choice" | "flexible" | "undated";

export function FollowUpModal({
  open,
  onOpenChange,
  appointment,
  today,
  services,
  providers,
  workingHours,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appointment: AppointmentDetailData;
  today: string;
  services?: Array<{ id: string; name: string; durationMinutes: number }>;
  providers?: Array<{ id: string; name: string; displayName?: string | null }>;
  workingHours?: unknown;
  onSuccess?: () => void;
}) {
  const [mode, setMode] = useState<FollowUpMode>("choice");
  const [selectedServiceId, setSelectedServiceId] = useState<string>(
    appointment.service.id,
  );
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(
    appointment.provider?.id ?? null,
  );
  const [range, setRange] = useState<DateRange | null>(null);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const activeServices =
    services && services.length > 0
      ? services
      : [
          {
            id: appointment.service.id,
            name: appointment.service.name,
            durationMinutes: appointment.service.durationMinutes,
          },
        ];

  const currentService =
    activeServices.find((s) => s.id === selectedServiceId) ||
    activeServices[0] ||
    appointment.service;

  const activeProviders = providers || [];
  const currentProvider = activeProviders.find(
    (p) => p.id === selectedProviderId,
  );

  function reset() {
    setMode("choice");
    setSelectedServiceId(appointment.service.id);
    setSelectedProviderId(appointment.provider?.id ?? null);
    setRange(null);
    setNotes("");
    setError(null);
    setSuccessMessage(null);
  }

  function handleClose() {
    reset();
    onOpenChange(false);
  }

  function handleSave() {
    setError(null);
    if (mode === "flexible" && (!range || !range.startDate || !range.endDate)) {
      setError("يرجى تحديد فترة المتابعة المطلوبة");
      return;
    }

    startTransition(async () => {
      const result = await createFollowUpRequest({
        customerId: appointment.customer.id,
        sourceAppointmentId: appointment.id,
        serviceId: selectedServiceId,
        preferredProviderId: selectedProviderId ?? undefined,
        type: mode === "flexible" ? "flexible" : "undated",
        startDate: mode === "flexible" && range ? range.startDate : undefined,
        endDate: mode === "flexible" && range ? range.endDate : undefined,
        notes: notes.trim() || undefined,
      });

      if (result.success) {
        setSuccessMessage(result.message);
        onSuccess?.();
      } else {
        setError(result.message);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        className="max-w-xl max-h-[90vh] overflow-y-auto p-4 sm:p-6 text-right"
        dir="rtl"
      >
        <DialogHeader className="text-right">
          <div className="flex items-center justify-between">
            <DialogTitle className="text-lg sm:text-xl font-bold">
              إضافة متابعة — {appointment.customer.name}
            </DialogTitle>
            {mode !== "choice" && !successMessage ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setError(null);
                  setMode("choice");
                }}
                className="gap-1 text-xs"
              >
                <span>الخيارات</span>
                <ChevronLeftIcon className="size-3.5" />
              </Button>
            ) : null}
          </div>
          <DialogDescription className="text-xs sm:text-sm text-muted-foreground mt-1">
            تسجيل متابعة للمريض استناداً إلى توصية الطبيب دون إعادة إدخال
            بياناته.
          </DialogDescription>
        </DialogHeader>

        {successMessage ? (
          <div className="animate-fade-in-up my-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-5 text-center space-y-3">
            <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-emerald-500 text-white">
              <CheckCircle2Icon className="size-6" />
            </div>
            <h3 className="text-base font-bold text-emerald-800 dark:text-emerald-300">
              {successMessage}
            </h3>
            <p className="text-xs text-muted-foreground leading-relaxed">
              تم حفظ طلب المتابعة. لم يتم حجز موعد بعد. يمكنك اختيار موعد محدد
              له لاحقاً عند رغبة المريض.
            </p>
            <div className="pt-2">
              <Button onClick={handleClose} className="w-full sm:w-auto">
                تم
              </Button>
            </div>
          </div>
        ) : mode === "choice" ? (
          /* ─── 3 Clear Arabic Choices ─── */
          <div className="space-y-3 py-3">
            <p className="text-xs font-semibold text-muted-foreground">
              اختر نوع المتابعة المناسب:
            </p>

            {/* Option 1: Book Follow-up Now */}
            <Button
              asChild
              variant="outline"
              className="h-auto w-full justify-start p-4 text-right rounded-xl border-border hover:border-primary hover:bg-accent/50 group"
            >
              <Link
                href={`/appointments/new?customerId=${appointment.customer.id}&serviceId=${appointment.service.id}${appointment.provider?.id ? `&providerId=${appointment.provider.id}` : ""}&sourceAppointmentId=${appointment.id}`}
                onClick={handleClose}
              >
                <div className="flex w-full items-start gap-3.5">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary group-hover:bg-primary group-hover:text-primary-foreground transition-colors">
                    <CalendarPlusIcon className="size-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-foreground">
                      ١. حجز موعد متابعة الآن
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground leading-normal">
                      تحديد التاريخ والوقت المتاح فوراً وتأكيد الموعد عبر مسار
                      الحجز السريع المعتمد.
                    </p>
                  </div>
                  <ChevronLeftIcon className="size-4 text-muted-foreground self-center shrink-0" />
                </div>
              </Link>
            </Button>

            {/* Option 2: Patient Chooses Within Range */}
            <button
              type="button"
              onClick={() => {
                setError(null);
                setMode("flexible");
              }}
              className="flex w-full items-start gap-3.5 rounded-xl border border-border p-4 text-right transition-colors hover:border-primary hover:bg-accent/50 group"
            >
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-sky-500/10 text-sky-600 dark:text-sky-400 group-hover:bg-sky-500 group-hover:text-white transition-colors">
                <CalendarDaysIcon className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-foreground">
                  ٢. المريض يختار خلال فترة محددة
                </p>
                <p className="mt-1 text-xs text-muted-foreground leading-normal">
                  توصية الطبيب بمتابعة خلال فترة زمنية (مثل: الأسبوع القادم من
                  السبت إلى الإثنين) دون حجز وقت نهائي الآن.
                </p>
              </div>
              <ChevronLeftIcon className="size-4 text-muted-foreground self-center shrink-0" />
            </button>

            {/* Option 3: Undated Follow-up */}
            <button
              type="button"
              onClick={() => {
                setError(null);
                setMode("undated");
              }}
              className="flex w-full items-start gap-3.5 rounded-xl border border-border p-4 text-right transition-colors hover:border-primary hover:bg-accent/50 group"
            >
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400 group-hover:bg-amber-500 group-hover:text-white transition-colors">
                <CalendarClockIcon className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-foreground">
                  ٣. متابعة مطلوبة دون تاريخ محدد
                </p>
                <p className="mt-1 text-xs text-muted-foreground leading-normal">
                  تسجيل حاجة المريض للمتابعة وفق تقدير الطبيب دون تحديد موعد
                  مسبق، لجدولتها لاحقاً.
                </p>
              </div>
              <ChevronLeftIcon className="size-4 text-muted-foreground self-center shrink-0" />
            </button>
          </div>
        ) : (
          /* ─── Flexible / Undated Flow ─── */
          <div className="space-y-5 py-2">
            {/* Service & Provider Configuration */}
            <div className="grid gap-3.5 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label
                  htmlFor="follow-up-service"
                  className="text-xs font-semibold"
                >
                  الخدمة المطلوبة
                </Label>
                <select
                  id="follow-up-service"
                  value={selectedServiceId}
                  onChange={(e) => setSelectedServiceId(e.target.value)}
                  className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-xs focus:ring-2 focus:ring-primary focus:outline-hidden"
                >
                  {activeServices.map((service) => (
                    <option key={service.id} value={service.id}>
                      {service.name} ({service.durationMinutes} دقيقة)
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <Label
                  htmlFor="follow-up-provider"
                  className="text-xs font-semibold"
                >
                  مقدم الخدمة المفضل
                </Label>
                <select
                  id="follow-up-provider"
                  value={selectedProviderId ?? ""}
                  onChange={(e) =>
                    setSelectedProviderId(
                      e.target.value ? e.target.value : null,
                    )
                  }
                  className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-xs focus:ring-2 focus:ring-primary focus:outline-hidden"
                >
                  <option value="">أي موظف متاح</option>
                  {activeProviders.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.displayName || provider.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Date Range Selector if Flexible */}
            {mode === "flexible" ? (
              <div className="space-y-2 border-t pt-4">
                <Label className="text-xs font-semibold">
                  فترة المتابعة الموصى بها (متصلة وشاملة)
                </Label>
                <FollowUpRangeSelector
                  today={today}
                  range={range}
                  onRangeChange={setRange}
                  workingHours={workingHours}
                />
              </div>
            ) : null}

            {/* Notes Input */}
            <div className="space-y-1.5 border-t pt-4">
              <Label
                htmlFor="follow-up-notes"
                className="text-xs font-semibold"
              >
                ملاحظات المتابعة (اختياري)
              </Label>
              <Textarea
                id="follow-up-notes"
                placeholder="توصيات الطبيب، الفحوصات المطلوبة، أو سبب المتابعة..."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                className="resize-none text-sm"
              />
            </div>

            {/* Review Step Card */}
            <div className="rounded-xl border bg-muted/30 p-3.5 space-y-2 text-xs">
              <p className="font-semibold text-foreground text-xs border-b pb-1.5">
                مراجعة طلب المتابعة قبل الحفظ
              </p>
              <div className="grid grid-cols-2 gap-2 text-muted-foreground">
                <div>
                  <span className="font-medium text-foreground">العميل:</span>{" "}
                  {appointment.customer.name}
                </div>
                <div>
                  <span className="font-medium text-foreground">الخدمة:</span>{" "}
                  {currentService.name}
                </div>
                <div>
                  <span className="font-medium text-foreground">
                    مقدم الخدمة:
                  </span>{" "}
                  {currentProvider
                    ? currentProvider.displayName || currentProvider.name
                    : "أي موظف متاح"}
                </div>
                <div>
                  <span className="font-medium text-foreground">
                    حالة الطلب:
                  </span>{" "}
                  <span className="font-bold text-amber-600 dark:text-amber-400">
                    بانتظار تحديد موعد
                  </span>
                </div>
              </div>
              <div className="pt-1 text-foreground">
                <span className="font-medium">الفترة:</span>{" "}
                {mode === "flexible" && range
                  ? `من ${formatArabicDate(range.startDate)} إلى ${formatArabicDate(range.endDate)}`
                  : "دون تاريخ محدد"}
              </div>
            </div>

            {error ? (
              <p role="alert" className="text-xs font-medium text-destructive">
                {error}
              </p>
            ) : null}

            {/* Actions */}
            <div className="flex items-center justify-end gap-2 pt-2 border-t">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setMode("choice")}
                disabled={isPending}
              >
                رجوع
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={handleSave}
                disabled={isPending || (mode === "flexible" && !range)}
                className="gap-1.5"
              >
                {isPending ? (
                  <LoaderCircleIcon className="size-3.5 animate-spin" />
                ) : (
                  <CheckIcon className="size-3.5" />
                )}
                حفظ طلب المتابعة
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
