"use client";

import { correctPerformedServiceAction } from "@/features/appointments/actions/appointment-actions";
import type { AppointmentDetailData } from "@/features/appointments/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

import {
  CheckIcon,
  InfoIcon,
  LoaderCircleIcon,
  SparklesIcon,
} from "lucide-react";
import { useState, useTransition } from "react";

export function ServiceCorrectionModal({
  open,
  onOpenChange,
  appointment,
  services,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appointment: AppointmentDetailData;
  services: Array<{ id: string; name: string; durationMinutes?: number }>;
  onSuccess: (updated: {
    performedServiceId: string;
    performedServiceName: string;
    serviceCorrectedAt: string;
    updatedAt: string;
  }) => void;
}) {
  const currentPerformedId =
    appointment.performedService?.id ?? appointment.service.id;
  const [selectedServiceId, setSelectedServiceId] =
    useState<string>(currentPerformedId);
  const [notes, setNotes] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSave() {
    if (!selectedServiceId) {
      setError("يرجى اختيار الخدمة المنفذة");
      return;
    }
    setError(null);
    setSuccessMessage(null);

    startTransition(async () => {
      const result = await correctPerformedServiceAction({
        appointmentId: appointment.id,
        performedServiceId: selectedServiceId,
        notes: notes.trim() || undefined,
        expectedVersion: appointment.updatedAt,
      });

      if (!result.success) {
        setError(result.message);
        return;
      }

      setSuccessMessage("تم تحديث الخدمة المنفذة دون تغيير موعد الحجز.");
      onSuccess(result);
      setTimeout(() => {
        onOpenChange(false);
        setSuccessMessage(null);
      }, 1200);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-5" dir="rtl">
        <DialogHeader className="text-start">
          <DialogTitle className="flex items-center gap-2">
            <SparklesIcon className="size-5 text-primary" />
            <span>تسجيل / تصحيح الخدمة المنفذة</span>
          </DialogTitle>
          <DialogDescription className="text-xs leading-5 text-muted-foreground mt-1">
            توثيق الخدمة التي قُدمت بالفعل للعميل في الزيارة المكتملة دون تغيير
            تاريخ أو وقت الموعد التاريخي.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          {/* Readonly Booked Service */}
          <div className="rounded-lg border bg-muted/40 p-3 space-y-1">
            <span className="text-xs text-muted-foreground">
              الخدمة المحجوزة (الأصلية):
            </span>
            <p className="font-semibold text-foreground">
              {appointment.service.name}
            </p>
          </div>

          {/* Current Performed Service Indicator */}
          {appointment.performedService &&
          appointment.performedService.id !== appointment.service.id ? (
            <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 space-y-1">
              <span className="text-xs text-primary font-medium">
                الخدمة المنفذة الحالية:
              </span>
              <p className="font-semibold text-foreground">
                {appointment.performedService.name}
              </p>
            </div>
          ) : null}

          {/* Selection of New Performed Service */}
          <div className="space-y-2">
            <Label htmlFor="correction-service">الخدمة المنفذة الفعلية</Label>
            <Select
              value={selectedServiceId}
              onValueChange={(val) => {
                setSelectedServiceId(val);
                setError(null);
              }}
            >
              <SelectTrigger id="correction-service" className="w-full">
                <SelectValue placeholder="اختر الخدمة المنفذة" />
              </SelectTrigger>
              <SelectContent>
                {services.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground leading-5">
              هذا التعديل يوثق الخدمة التي قُدمت بالفعل، ولا يغير وقت الحجز.
            </p>
          </div>

          {/* Optional Notes */}
          <div className="space-y-2">
            <Label htmlFor="correction-notes">
              سبب التعديل أو ملاحظات الزيارة{" "}
              <span className="font-normal text-muted-foreground">
                (اختياري)
              </span>
            </Label>
            <Textarea
              id="correction-notes"
              rows={2}
              placeholder="مثال: تم تحويل الكشف إلى تنظيف أسنان بناءً على رغبة العميل."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="resize-none"
            />
          </div>

          {/* Educational notice */}
          <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/30 p-3 text-xs leading-5 text-muted-foreground">
            <InfoIcon className="size-4 shrink-0 text-muted-foreground mt-0.5" />
            <span>
              لن يتم تشغيل فحص تعارض المواعيد أو إرسال رسائل آلية للعميل عند حفظ
              هذا التعديل.
            </span>
          </div>

          {error ? (
            <p role="alert" className="text-sm font-medium text-destructive">
              {error}
            </p>
          ) : null}

          {successMessage ? (
            <div
              role="status"
              className="flex items-center gap-2 text-sm font-medium text-emerald-600 dark:text-emerald-400"
            >
              <CheckIcon className="size-4" />
              <span>{successMessage}</span>
            </div>
          ) : null}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            إلغاء
          </Button>
          <Button
            onClick={handleSave}
            disabled={isPending || !selectedServiceId}
          >
            {isPending ? (
              <>
                <LoaderCircleIcon className="size-4 animate-spin" />
                جارٍ الحفظ…
              </>
            ) : (
              "حفظ الخدمة المنفذة"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
