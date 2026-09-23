"use client";

import {
  createServiceAction,
  updateServiceAction,
} from "@/features/services/actions/service-actions";
import {
  serviceFormSchema,
  type ServiceFormInput,
} from "@/features/services/schemas/service-schema";
import type { ServiceListItem } from "@/features/services/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import { zodResolver } from "@hookform/resolvers/zod";
import { LoaderCircleIcon } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";

/**
 * Small create/edit form: name, optional description, duration in
 * minutes. The same form serves both modes — the parent remounts it
 * (key change) on every open, so edit values are prefilled through
 * mount-time defaults. No wizard, no extra fields.
 */
export function ServiceFormDialog({
  open,
  onOpenChange,
  service,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present → edit mode; absent → create mode. */
  service?: ServiceListItem;
  onSaved: (service: ServiceListItem) => void;
}) {
  const isEdit = Boolean(service);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const form = useForm<ServiceFormInput>({
    resolver: zodResolver(serviceFormSchema),
    defaultValues: {
      name: service?.name ?? "",
      description: service?.description ?? "",
      durationMinutes: service?.durationMinutes ?? 30,
    },
  });

  const submit = form.handleSubmit(async (data) => {
    setError(null);
    setSubmitting(true);
    const result =
      isEdit && service
        ? await updateServiceAction({ id: service.id, service: data })
        : await createServiceAction(data);
    setSubmitting(false);
    if (!result.success) {
      setError(result.message);
      return;
    }
    onOpenChange(false);
    onSaved(result.service);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? "تعديل الخدمة" : "إضافة خدمة"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "عدّل بيانات الخدمة ثم احفظ التغييرات."
              : "أضف خدمة جديدة ليتمكن العملاء من حجزها."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-5" noValidate>
          <div className="space-y-2">
            <Label htmlFor="service-name">اسم الخدمة</Label>
            <Input
              id="service-name"
              placeholder="مثال: جلسة تنظيف"
              autoComplete="off"
              aria-invalid={Boolean(form.formState.errors.name)}
              {...form.register("name")}
            />
            {form.formState.errors.name ? (
              <p className="text-xs text-destructive">
                {form.formState.errors.name.message}
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="service-description">
              وصف الخدمة{" "}
              <span className="text-muted-foreground">(اختياري)</span>
            </Label>
            <Textarea
              id="service-description"
              rows={3}
              placeholder="تفاصيل تساعد العميل على فهم الخدمة عند الحجز…"
              aria-invalid={Boolean(form.formState.errors.description)}
              {...form.register("description")}
            />
            {form.formState.errors.description ? (
              <p className="text-xs text-destructive">
                {form.formState.errors.description.message}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                يظهر للعملاء كجزء من بيانات الخدمة.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="service-duration">مدة الخدمة (بالدقائق)</Label>
            <Input
              id="service-duration"
              type="number"
              dir="ltr"
              inputMode="numeric"
              min={5}
              max={480}
              step={5}
              placeholder="30"
              aria-invalid={Boolean(form.formState.errors.durationMinutes)}
              {...form.register("durationMinutes", { valueAsNumber: true })}
            />
            {form.formState.errors.durationMinutes ? (
              <p className="text-xs text-destructive">
                {form.formState.errors.durationMinutes.message}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                من 5 دقائق حتى 8 ساعات — تُستخدم لحساب أوقات الحجز فقط، ولا
                تُعرض للعملاء تلقائياً.
              </p>
            )}
          </div>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              إلغاء
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? (
                <LoaderCircleIcon className="animate-spin" />
              ) : null}
              حفظ الخدمة
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
