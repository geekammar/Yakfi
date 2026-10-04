"use client";

import { updateBusinessSettingsAction } from "@/features/settings/actions/settings-actions";
import {
  businessSettingsSchema,
  type BusinessSettingsInput,
} from "@/features/settings/schemas/settings-schema";
import type { BusinessSettingsView } from "@/features/settings/types";
import { PageHeader } from "@/components/shared/page-header";
import { SectionHeader } from "@/components/shared/section-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { CONFIRMATION_MODES, TIMEZONES, VERTICALS } from "@/lib/validation";

import { zodResolver } from "@hookform/resolvers/zod";
import {
  BookOpenIcon,
  CheckCircleIcon,
  ChevronLeftIcon,
  LoaderCircleIcon,
  MessageCircleIcon,
  SendIcon,
  SparklesIcon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";

/**
 * Business Settings screen (operator PROMPT-09): how the business
 * operates. Two clearly separated sections — بيانات المنشأة and
 * إعدادات الحجز — with ONE primary save action, inline Arabic
 * validation, and visible save success/failure states. The form never
 * carries a businessId; the server derives the Business from the
 * authenticated actor.
 */
export function SettingsScreen({
  initialSettings,
}: {
  initialSettings: BusinessSettingsView;
}) {
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const form = useForm<BusinessSettingsInput>({
    resolver: zodResolver(businessSettingsSchema),
    defaultValues: {
      name: initialSettings.name,
      vertical: initialSettings.vertical as BusinessSettingsInput["vertical"],
      city: initialSettings.city,
      whatsappNumber: initialSettings.whatsappNumber,
      timezone: initialSettings.timezone as BusinessSettingsInput["timezone"],
      about: initialSettings.about,
      address: initialSettings.address,
      confirmationMode:
        initialSettings.confirmationMode as BusinessSettingsInput["confirmationMode"],
      cancellationPolicy: initialSettings.cancellationPolicy,
    },
    mode: "onChange",
  });

  const submit = form.handleSubmit(async (data) => {
    setError(null);
    setSaved(false);
    setIsSubmitting(true);
    const result = await updateBusinessSettingsAction(data);
    setIsSubmitting(false);
    if (!result.success) {
      setError(result.message);
      return;
    }
    setSaved(true);
  });

  const fieldError = (message?: string) =>
    message ? (
      <p className="text-xs text-destructive" role="alert">
        {message}
      </p>
    ) : null;

  return (
    <div className="animate-fade-in-up space-y-8">
      <PageHeader
        title="الإعدادات"
        description="كيف تعمل منشأتك — بياناتها الأساسية وسلوك الحجز فيها."
      />

      {/* Knowledge lives at its own route (PROMPT-18): a link, not a
          second form inside this feature. */}
      <div className="space-y-3">
        <Link
          href="/settings/assistant"
          className="group flex items-center gap-4 rounded-xl border bg-card p-4 shadow-xs transition-shadow hover:shadow-sm focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <div className="bg-primary/10 text-primary flex size-11 shrink-0 items-center justify-center rounded-full">
            <SparklesIcon aria-hidden className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold">إعدادات المساعد</h2>
            <p className="text-muted-foreground mt-0.5 text-sm leading-6">
              طريقة كلام مساعدك مع العملاء — اسمه، لغته، أسلوبه، وطول ردوده.
            </p>
          </div>
          <ChevronLeftIcon
            aria-hidden
            className="text-muted-foreground size-5 shrink-0 transition-transform group-hover:-translate-x-0.5"
          />
        </Link>
        <Link
          href="/settings/whatsapp"
          className="group flex items-center gap-4 rounded-xl border bg-card p-4 shadow-xs transition-shadow hover:shadow-sm focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <div className="bg-muted text-muted-foreground flex size-11 shrink-0 items-center justify-center rounded-full">
            <MessageCircleIcon aria-hidden className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold">واتساب</h2>
            <p className="text-muted-foreground mt-0.5 text-sm leading-6">
              ربط رقم واتساب الخاص بمنشأتك والتحقق من الاتصال.
            </p>
          </div>
          <ChevronLeftIcon
            aria-hidden
            className="text-muted-foreground size-5 shrink-0 transition-transform group-hover:-translate-x-0.5"
          />
        </Link>
        <Link
          href="/settings/telegram"
          className="group flex items-center gap-4 rounded-xl border bg-card p-4 shadow-xs transition-shadow hover:shadow-sm focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <div className="bg-muted text-muted-foreground flex size-11 shrink-0 items-center justify-center rounded-full">
            <SendIcon aria-hidden className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold">تيليجرام</h2>
            <p className="text-muted-foreground mt-0.5 text-sm leading-6">
              ربط بوت تيليجرام الخاص بمنشأتك — بدون نسخ أي رمز أو إعداد يدوي.
            </p>
          </div>
          <ChevronLeftIcon
            aria-hidden
            className="text-muted-foreground size-5 shrink-0 transition-transform group-hover:-translate-x-0.5"
          />
        </Link>
        <Link
          href="/settings/knowledge"
          className="group flex items-center gap-4 rounded-xl border bg-card p-4 shadow-xs transition-shadow hover:shadow-sm focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <div className="bg-muted text-muted-foreground flex size-11 shrink-0 items-center justify-center rounded-full">
            <BookOpenIcon aria-hidden className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold">معلومات للمساعد</h2>
            <p className="text-muted-foreground mt-0.5 text-sm leading-6">
              الأسعار والسياسات والإجابات المتكررة التي سيستخدمها المساعد الذكي
              في الردود.
            </p>
          </div>
          <ChevronLeftIcon
            aria-hidden
            className="text-muted-foreground size-5 shrink-0 transition-transform group-hover:-translate-x-0.5"
          />
        </Link>
      </div>

      <form onSubmit={submit} className="space-y-8" noValidate>
        {/* ─── Section 1: بيانات المنشأة ─── */}
        <section
          aria-labelledby="settings-business-section"
          className="rounded-xl border bg-card p-5 shadow-xs sm:p-6"
        >
          <SectionHeader
            title="بيانات المنشأة"
            description="تظهر للعملاء عند التواصل والحجز."
          />
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="settings-name">اسم المنشأة</Label>
              <Input
                id="settings-name"
                autoComplete="organization"
                aria-invalid={Boolean(form.formState.errors.name)}
                {...form.register("name")}
              />
              {fieldError(form.formState.errors.name?.message)}
            </div>

            <div className="space-y-2">
              <Label htmlFor="settings-vertical">نوع المنشأة</Label>
              <Controller
                control={form.control}
                name="vertical"
                render={({ field }) => (
                  <Select
                    value={field.value || undefined}
                    onValueChange={field.onChange}
                  >
                    <SelectTrigger id="settings-vertical" className="w-full">
                      <SelectValue placeholder="اختر نوع المنشأة" />
                    </SelectTrigger>
                    <SelectContent>
                      {VERTICALS.map((vertical) => (
                        <SelectItem key={vertical.value} value={vertical.value}>
                          {vertical.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              {fieldError(form.formState.errors.vertical?.message)}
            </div>

            <div className="space-y-2">
              <Label htmlFor="settings-city">المدينة</Label>
              <Input
                id="settings-city"
                autoComplete="address-level2"
                aria-invalid={Boolean(form.formState.errors.city)}
                {...form.register("city")}
              />
              {fieldError(form.formState.errors.city?.message)}
            </div>

            <div className="space-y-2">
              <Label htmlFor="settings-whatsapp">رقم واتساب</Label>
              <Input
                id="settings-whatsapp"
                type="tel"
                dir="ltr"
                autoComplete="tel"
                className="text-start"
                aria-invalid={Boolean(form.formState.errors.whatsappNumber)}
                {...form.register("whatsappNumber")}
              />
              {fieldError(form.formState.errors.whatsappNumber?.message)}
            </div>

            <div className="space-y-2">
              <Label htmlFor="settings-timezone">المنطقة الزمنية</Label>
              <Controller
                control={form.control}
                name="timezone"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="settings-timezone" className="w-full">
                      <SelectValue placeholder="اختر المنطقة الزمنية" />
                    </SelectTrigger>
                    <SelectContent>
                      {TIMEZONES.map((timezone) => (
                        <SelectItem key={timezone.value} value={timezone.value}>
                          {timezone.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              {fieldError(form.formState.errors.timezone?.message)}
            </div>
          </div>
        </section>

        {/* ─── Section 2: معلومات المساعد (AI information — optional) ─── */}
        <section
          aria-labelledby="settings-ai-section"
          className="rounded-xl border bg-card p-5 shadow-xs sm:p-6"
        >
          <SectionHeader
            title="معلومات المساعد"
            description="أدخل أهم المعلومات عن نشاطك مرة واحدة، والمساعد يستخدمها للإجابة على العملاء — اختيارية بالكامل."
          />
          <div className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="settings-about">
                نبذة عن المنشأة{" "}
                <span className="font-normal text-muted-foreground">
                  (اختياري)
                </span>
              </Label>
              <Textarea
                id="settings-about"
                rows={3}
                placeholder="مثال: عيادة أسنان متخصصة في تنظيف وحشو الأسنان، فريق محترف وأحدث الأجهزة."
                aria-invalid={Boolean(form.formState.errors.about)}
                {...form.register("about")}
              />
              {fieldError(form.formState.errors.about?.message)}
              <p className="text-xs text-muted-foreground">
                يُستخدمها المساعد عندما يسأل العميل عن نشاطك.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="settings-address">
                موقع النشاط{" "}
                <span className="font-normal text-muted-foreground">
                  (اختياري)
                </span>
              </Label>
              <Input
                id="settings-address"
                autoComplete="street-address"
                placeholder="مثال: كفر الشيخ — شارع الجمهورية، بجوار صيدلية النيل"
                aria-invalid={Boolean(form.formState.errors.address)}
                {...form.register("address")}
              />
              {fieldError(form.formState.errors.address?.message)}
              <p className="text-xs text-muted-foreground">
                يُستخدمها المساعد عندما يسأل العميل عن مكانك.
              </p>
            </div>
          </div>
        </section>

        {/* ─── Section 3: إعدادات الحجز ─── */}
        <section
          aria-labelledby="settings-booking-section"
          className="rounded-xl border bg-card p-5 shadow-xs sm:p-6"
        >
          <SectionHeader
            title="إعدادات الحجز"
            description="كيف تُضاف المواعيد الجديدة إلى جدولك."
          />
          <div className="space-y-5">
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">طريقة تأكيد الحجز</legend>
              <Controller
                control={form.control}
                name="confirmationMode"
                render={({ field }) => (
                  <RadioGroup
                    value={field.value}
                    onValueChange={field.onChange}
                    className="gap-3"
                  >
                    {CONFIRMATION_MODES.map((mode) => (
                      <Label
                        key={mode.value}
                        htmlFor={`confirmation-${mode.value}`}
                        className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal transition-colors hover:bg-accent/60 has-data-checked:border-primary has-data-checked:bg-accent/60"
                      >
                        <RadioGroupItem
                          id={`confirmation-${mode.value}`}
                          value={mode.value}
                          className="mt-0.5"
                        />
                        <span className="space-y-1">
                          <span className="block text-sm font-medium">
                            {mode.label}
                          </span>
                          <span className="block text-xs leading-5 text-muted-foreground">
                            {mode.hint}
                          </span>
                        </span>
                      </Label>
                    ))}
                  </RadioGroup>
                )}
              />
              {fieldError(form.formState.errors.confirmationMode?.message)}
            </fieldset>

            <div className="space-y-2">
              <Label htmlFor="settings-cancellation">سياسة الإلغاء</Label>
              <Textarea
                id="settings-cancellation"
                rows={3}
                placeholder="مثال: يمكن الإلغاء أو التعديل قبل الموعد بـ 24 ساعة."
                aria-invalid={Boolean(form.formState.errors.cancellationPolicy)}
                {...form.register("cancellationPolicy")}
              />
              {fieldError(form.formState.errors.cancellationPolicy?.message)}
            </div>
          </div>
        </section>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {saved ? (
          <p
            role="status"
            className="flex items-center gap-1.5 text-sm text-success"
          >
            <CheckCircleIcon aria-hidden className="size-4" />
            تم حفظ الإعدادات
          </p>
        ) : null}

        <div className="flex flex-col-reverse gap-2 border-t pt-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            تعمل التعديلات على المواعيد الجديدة فوراً بعد الحفظ.
          </p>
          <Button type="submit" size="lg" disabled={isSubmitting}>
            {isSubmitting ? (
              <LoaderCircleIcon className="animate-spin" />
            ) : null}
            حفظ الإعدادات
          </Button>
        </div>
      </form>
    </div>
  );
}
