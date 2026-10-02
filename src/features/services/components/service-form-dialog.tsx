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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  SERVICE_PRICE_CURRENCY_VALUES,
  type ServicePriceCurrency,
  type ServicePriceType,
} from "@/lib/service-price";

import { zodResolver } from "@hookform/resolvers/zod";
import { LoaderCircleIcon } from "lucide-react";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";

/** Sentinel the "no price" Select option carries (maps to null on change). */
const NO_PRICE = "NONE";

const PRICE_TYPE_LABELS: Record<ServicePriceType, string> = {
  FIXED: "سعر ثابت",
  RANGE: "نطاق سعري",
  STARTING_FROM: "يبدأ من",
  CONDITIONAL: "حسب الحالة",
};

const CURRENCY_LABELS: Record<ServicePriceCurrency, string> = {
  EGP: "جنيه مصري",
  SAR: "ريال سعودي",
  AED: "درهم إماراتي",
  KWD: "دينار كويتي",
  QAR: "ريال قطري",
  USD: "دولار أمريكي",
};

/**
 * Small create/edit form: name, optional description, duration in minutes,
 * and an OPTIONAL structured price (PROMPT-AI-ARCH-13 — Slice 6). The same
 * form serves both modes — the parent remounts it (key change) on every open,
 * so edit values are prefilled through mount-time defaults. Name + duration
 * remain the only required fields (duration alone makes a service bookable);
 * price is clearly optional and never blocks saving.
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
      priceType: (service?.priceType as ServicePriceType | null) ?? null,
      priceAmount: service?.priceAmount ?? null,
      priceMaxAmount: service?.priceMaxAmount ?? null,
      priceCurrency:
        (service?.priceCurrency as ServicePriceCurrency | null) ?? null,
      priceNote: service?.priceNote ?? "",
    },
  });

  const priceType = form.watch("priceType");
  const showAmount =
    priceType === "FIXED" ||
    priceType === "RANGE" ||
    priceType === "STARTING_FROM";
  const showMax = priceType === "RANGE";
  const showNote = priceType === "CONDITIONAL";

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

  const numberSetValueAs = (value: unknown) =>
    value === "" || value === null || value === undefined
      ? null
      : Number(value);

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

          {/* OPTIONAL structured price (PROMPT-AI-ARCH-13 — Slice 6). */}
          <div className="space-y-2">
            <Label htmlFor="service-price-type">
              السعر <span className="text-muted-foreground">(اختياري)</span>
            </Label>
            <Controller
              control={form.control}
              name="priceType"
              render={({ field }) => (
                <Select
                  value={field.value ?? NO_PRICE}
                  onValueChange={(value) => {
                    field.onChange(value === NO_PRICE ? null : value);
                    // Clear dependent price fields when the shape changes so a
                    // stale amount never lingers (the server normalizes too).
                    form.setValue("priceAmount", null);
                    form.setValue("priceMaxAmount", null);
                    form.setValue("priceNote", "");
                    if (value === NO_PRICE || value === "CONDITIONAL") {
                      form.setValue("priceCurrency", null);
                    }
                  }}
                >
                  <SelectTrigger id="service-price-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_PRICE}>بدون سعر</SelectItem>
                    {(Object.keys(PRICE_TYPE_LABELS) as ServicePriceType[]).map(
                      (type) => (
                        <SelectItem key={type} value={type}>
                          {PRICE_TYPE_LABELS[type]}
                        </SelectItem>
                      ),
                    )}
                  </SelectContent>
                </Select>
              )}
            />
            <p className="text-xs text-muted-foreground">
              يُعرض للعميل فقط عندما يسأل عن السعر — غير مطلوب لتفعيل الحجز.
            </p>
          </div>

          {showAmount ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="service-price-amount">
                  {priceType === "RANGE" ? "من" : "المبلغ"}
                </Label>
                <Input
                  id="service-price-amount"
                  type="number"
                  dir="ltr"
                  inputMode="numeric"
                  min={1}
                  placeholder="300"
                  aria-invalid={Boolean(form.formState.errors.priceAmount)}
                  {...form.register("priceAmount", {
                    setValueAs: numberSetValueAs,
                  })}
                />
                {form.formState.errors.priceAmount ? (
                  <p className="text-xs text-destructive">
                    {form.formState.errors.priceAmount.message}
                  </p>
                ) : null}
              </div>
              {showMax ? (
                <div className="space-y-2">
                  <Label htmlFor="service-price-max">إلى</Label>
                  <Input
                    id="service-price-max"
                    type="number"
                    dir="ltr"
                    inputMode="numeric"
                    min={1}
                    placeholder="500"
                    aria-invalid={Boolean(form.formState.errors.priceMaxAmount)}
                    {...form.register("priceMaxAmount", {
                      setValueAs: numberSetValueAs,
                    })}
                  />
                  {form.formState.errors.priceMaxAmount ? (
                    <p className="text-xs text-destructive">
                      {form.formState.errors.priceMaxAmount.message}
                    </p>
                  ) : null}
                </div>
              ) : (
                <div className="space-y-2">
                  <Label htmlFor="service-price-currency">العملة</Label>
                  <Controller
                    control={form.control}
                    name="priceCurrency"
                    render={({ field }) => (
                      <Select
                        value={field.value ?? undefined}
                        onValueChange={field.onChange}
                      >
                        <SelectTrigger id="service-price-currency">
                          <SelectValue placeholder="اختر العملة" />
                        </SelectTrigger>
                        <SelectContent>
                          {SERVICE_PRICE_CURRENCY_VALUES.map((currency) => (
                            <SelectItem key={currency} value={currency}>
                              {CURRENCY_LABELS[currency]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                  {form.formState.errors.priceCurrency ? (
                    <p className="text-xs text-destructive">
                      {form.formState.errors.priceCurrency.message}
                    </p>
                  ) : null}
                </div>
              )}
            </div>
          ) : null}

          {showMax ? (
            <div className="space-y-2">
              <Label htmlFor="service-price-currency-range">العملة</Label>
              <Controller
                control={form.control}
                name="priceCurrency"
                render={({ field }) => (
                  <Select
                    value={field.value ?? undefined}
                    onValueChange={field.onChange}
                  >
                    <SelectTrigger id="service-price-currency-range">
                      <SelectValue placeholder="اختر العملة" />
                    </SelectTrigger>
                    <SelectContent>
                      {SERVICE_PRICE_CURRENCY_VALUES.map((currency) => (
                        <SelectItem key={currency} value={currency}>
                          {CURRENCY_LABELS[currency]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              {form.formState.errors.priceCurrency ? (
                <p className="text-xs text-destructive">
                  {form.formState.errors.priceCurrency.message}
                </p>
              ) : null}
            </div>
          ) : null}

          {showNote ? (
            <div className="space-y-2">
              <Label htmlFor="service-price-note">وصف السعر</Label>
              <Input
                id="service-price-note"
                placeholder="مثال: حسب الحالة"
                aria-invalid={Boolean(form.formState.errors.priceNote)}
                {...form.register("priceNote")}
              />
              {form.formState.errors.priceNote ? (
                <p className="text-xs text-destructive">
                  {form.formState.errors.priceNote.message}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  نص قصير يوضح أن السعر يُحدَّد حسب الحالة.
                </p>
              )}
            </div>
          ) : null}

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
