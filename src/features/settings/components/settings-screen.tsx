"use client";

import { updateBusinessSettingsAction } from "@/features/settings/actions/settings-actions";
import {
  REMINDER_LEAD_HOURS_OPTIONS,
  REMINDER_TEMPLATE_OPTIONS,
  businessSettingsSchema,
  type BusinessSettingsInput,
} from "@/features/settings/schemas/settings-schema";
import type { BusinessSettingsView } from "@/features/settings/types";
import { PageHeader } from "@/components/shared/page-header";
import { SectionHeader } from "@/components/shared/section-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { cn } from "@/lib/utils";
import {
  APPOINTMENT_TIME_DISPLAY_OPTIONS,
  BOOKING_INTERVAL_OPTIONS,
  CONFIRMATION_MODES,
  TIMEZONES,
  VERTICALS,
} from "@/lib/validation";

import { zodResolver } from "@hookform/resolvers/zod";
import {
  BellIcon,
  BookOpenIcon,
  CheckCircleIcon,
  ChevronLeftIcon,
  LoaderCircleIcon,
  MessageCircleIcon,
  SendIcon,
  SparklesIcon,
  UsersIcon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";

/**
 * Business Settings screen (operator PROMPT-09): how the business
 * operates. Three clearly separated sections — بيانات المنشأة,
 * معلومات المساعد, إعدادات الحجز, and التذكير بالمواعيد — with ONE primary
 * save action, inline Arabic validation, and visible save success/failure states.
 * The form never carries a businessId; the server derives the Business from
 * the authenticated actor.
 */
export function SettingsScreen({
  initialSettings,
  services = [],
}: {
  initialSettings: BusinessSettingsView;
  services?: Array<{ id: string; name: string; isActive?: boolean }>;
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
      appointmentTimeDisplay:
        (initialSettings.appointmentTimeDisplay as
          "START_ONLY" | "FULL_RANGE") ?? "START_ONLY",
      slotDurationMinutes:
        initialSettings.slotDurationMinutes as BusinessSettingsInput["slotDurationMinutes"],
      cancellationPolicy: initialSettings.cancellationPolicy,
      reminderEnabled: initialSettings.reminderEnabled ?? false,
      reminderLeadHours: (initialSettings.reminderLeadHours ??
        24) as BusinessSettingsInput["reminderLeadHours"],
      reminderTemplateId: (initialSettings.reminderTemplateId ??
        "standard") as BusinessSettingsInput["reminderTemplateId"],
      defaultServiceBookingEnabled:
        initialSettings.defaultServiceBookingEnabled ?? false,
      defaultBookingServiceId: initialSettings.defaultBookingServiceId ?? null,
    },
    mode: "onChange",
  });

  const defaultServiceBookingEnabled = form.watch(
    "defaultServiceBookingEnabled",
  );
  const selectedServiceId = form.watch("defaultBookingServiceId");
  const activeServices = services.filter((s) => s.isActive !== false);
  const selectedDefaultService = activeServices.find(
    (s) => s.id === selectedServiceId,
  );
  const matchedService = selectedServiceId
    ? services.find((s) => s.id === selectedServiceId)
    : null;

  // Explicitly distinguish states (ISS-007 / BK-41):
  // A. No default service configured
  // B. Valid active default service selected
  // C. Saved default service exists but is inactive
  // D. Saved ID cannot be resolved in tenant's available service data
  const defaultServiceState: "none" | "active" | "inactive" | "unavailable" =
    !selectedServiceId
      ? "none"
      : matchedService
        ? matchedService.isActive !== false
          ? "active"
          : "inactive"
        : "unavailable";

  const submit = form.handleSubmit(async (data) => {
    setError(null);
    setSaved(false);

    // Guard against saving an invalid or inactive service when default booking is enabled
    if (data.defaultServiceBookingEnabled && data.defaultBookingServiceId) {
      const srv = services.find((s) => s.id === data.defaultBookingServiceId);
      if (!srv || srv.isActive === false) {
        setError("الخدمة الافتراضية المحددة غير صالحة أو غير مفعّلة");
        return;
      }
    }

    setIsSubmitting(true);
    const result = await updateBusinessSettingsAction(data);
    setIsSubmitting(false);
    if (!result.success) {
      setError(result.message);
      return;
    }
    form.reset(data);
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
          href="/admin/team"
          className="group flex items-center gap-4 rounded-xl border bg-card p-4 shadow-xs transition-shadow hover:shadow-sm focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <div className="bg-primary/10 text-primary flex size-11 shrink-0 items-center justify-center rounded-full">
            <UsersIcon aria-hidden className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold">إدارة الفريق ومقدمي الخدمة</h2>
            <p className="text-muted-foreground mt-0.5 text-sm leading-6">
              أعضاء الفريق، مقدمو الخدمات، وتخصيص صلاحيات الخدمات لكل مقدم خدمة.
            </p>
          </div>
          <ChevronLeftIcon
            aria-hidden
            className="text-muted-foreground size-5 shrink-0 transition-transform group-hover:-translate-x-0.5"
          />
        </Link>
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

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">
                طريقة عرض وقت الموعد للعميل
              </legend>
              <Controller
                control={form.control}
                name="appointmentTimeDisplay"
                render={({ field }) => (
                  <RadioGroup
                    value={field.value}
                    onValueChange={field.onChange}
                    className="gap-3"
                  >
                    {APPOINTMENT_TIME_DISPLAY_OPTIONS.map((opt) => (
                      <Label
                        key={opt.value}
                        htmlFor={`time-display-${opt.value}`}
                        className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal transition-colors hover:bg-accent/60 has-data-checked:border-primary has-data-checked:bg-accent/60"
                      >
                        <RadioGroupItem
                          id={`time-display-${opt.value}`}
                          value={opt.value}
                          className="mt-0.5"
                        />
                        <span className="space-y-1">
                          <span className="block text-sm font-medium">
                            {opt.label}
                          </span>
                          <span className="block text-xs leading-5 text-muted-foreground">
                            {opt.hint}
                          </span>
                          <span className="block text-xs font-mono text-muted-foreground/80">
                            {opt.example}
                          </span>
                        </span>
                      </Label>
                    ))}
                  </RadioGroup>
                )}
              />
              {fieldError(
                form.formState.errors.appointmentTimeDisplay?.message,
              )}
            </fieldset>

            <div className="max-w-sm space-y-2">
              <Label htmlFor="settings-slot-duration">
                الفاصل الزمني بين بدايات المواعيد
              </Label>
              <Controller
                control={form.control}
                name="slotDurationMinutes"
                render={({ field }) => (
                  <Select
                    value={
                      field.value !== undefined ? String(field.value) : "30"
                    }
                    onValueChange={(val) => field.onChange(Number(val))}
                  >
                    <SelectTrigger
                      id="settings-slot-duration"
                      className="w-full"
                      aria-invalid={Boolean(
                        form.formState.errors.slotDurationMinutes,
                      )}
                    >
                      <SelectValue placeholder="اختر الفاصل الزمني" />
                    </SelectTrigger>
                    <SelectContent>
                      {BOOKING_INTERVAL_OPTIONS.map((minutes) => (
                        <SelectItem key={minutes} value={String(minutes)}>
                          {minutes} دقيقة
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              {fieldError(form.formState.errors.slotDurationMinutes?.message)}
              <p className="text-xs leading-5 text-muted-foreground">
                يحدد عدد الدقائق بين أوقات بدء الحجز المعروضة، ولا يغيّر مدة
                الخدمة أو المواعيد المحجوزة مسبقًا.
              </p>
            </div>

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

            {/* ─── الحجز السريع بالخدمة الافتراضية (CONV-PLAY-01) ─── */}
            <div className="border-t pt-5 space-y-4">
              <div>
                <h3 className="text-sm font-semibold">
                  الحجز السريع بالخدمة الافتراضية
                </h3>
                <p className="text-xs text-muted-foreground mt-0.5 leading-5">
                  إذا طلب العميل حجز موعد دون تحديد الخدمة، سيختار المساعد
                  الخدمة الافتراضية لتسريع الحجز. يمكنك تغييرها لاحقًا، ويمكن
                  للعميل اختيار خدمة أخرى في أي وقت.
                </p>
              </div>

              {/* Toggle */}
              <div className="flex items-start gap-3 rounded-lg border p-4 bg-muted/20">
                <Controller
                  control={form.control}
                  name="defaultServiceBookingEnabled"
                  render={({ field }) => (
                    <Checkbox
                      id="settings-default-service-enabled"
                      checked={field.value ?? false}
                      onCheckedChange={field.onChange}
                      aria-describedby="default-service-enabled-desc"
                    />
                  )}
                />
                <div className="space-y-1 leading-none">
                  <Label
                    htmlFor="settings-default-service-enabled"
                    className="text-sm font-semibold cursor-pointer"
                  >
                    استخدام الخدمة الافتراضية عند طلب حجز دون تحديد خدمة
                  </Label>
                  <p
                    id="default-service-enabled-desc"
                    className="text-xs text-muted-foreground leading-5"
                  >
                    تحديد خدمة أساسية للاقتراح الفوري عند عدم تحديد العميل لنوع
                    الخدمة.
                  </p>
                </div>
              </div>

              {/* Status indicator when disabled */}
              {!defaultServiceBookingEnabled ? (
                <div
                  role="status"
                  className="rounded-lg border border-border/60 bg-muted/40 p-3 text-xs leading-5 text-muted-foreground"
                >
                  <p>
                    <span className="font-semibold text-foreground">
                      الحالة الحالية:
                    </span>{" "}
                    الوضع معطّل — عند طلب حجز بدون تحديد خدمة، سيعرض المساعد
                    قائمة الخدمات المتاحة ليختار العميل منها.
                  </p>
                </div>
              ) : null}

              {/* Dropdown: الخدمة الافتراضية */}
              <div className="max-w-sm space-y-2">
                <Label htmlFor="settings-default-service">
                  الخدمة الافتراضية
                  {defaultServiceBookingEnabled ? (
                    <span className="text-destructive ms-1">*</span>
                  ) : (
                    <span className="font-normal text-muted-foreground ms-1">
                      (تجهيز مسبق)
                    </span>
                  )}
                </Label>
                <Controller
                  control={form.control}
                  name="defaultBookingServiceId"
                  render={({ field }) => (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 min-w-0">
                          <Select
                            value={field.value ?? ""}
                            onValueChange={(val) => {
                              field.onChange(val || null);
                              if (error) setError(null);
                            }}
                          >
                            <SelectTrigger
                              id="settings-default-service"
                              className="w-full"
                              aria-invalid={
                                Boolean(
                                  form.formState.errors.defaultBookingServiceId,
                                ) ||
                                (defaultServiceBookingEnabled &&
                                  (defaultServiceState === "inactive" ||
                                    defaultServiceState === "unavailable"))
                              }
                            >
                              <SelectValue placeholder="اختر الخدمة الافتراضية">
                                {selectedDefaultService
                                  ? selectedDefaultService.name
                                  : defaultServiceState === "inactive" &&
                                      matchedService
                                    ? `${matchedService.name} (غير مفعّلة)`
                                    : defaultServiceState === "unavailable"
                                      ? "خدمة غير متاحة"
                                      : undefined}
                              </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              {activeServices.length > 0 ? (
                                activeServices.map((service) => (
                                  <SelectItem
                                    key={service.id}
                                    value={service.id}
                                  >
                                    {service.name}
                                  </SelectItem>
                                ))
                              ) : (
                                <div className="p-2 text-xs text-muted-foreground text-center">
                                  لا توجد خدمات نشطة متاحة
                                </div>
                              )}
                            </SelectContent>
                          </Select>
                        </div>
                        {field.value ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              field.onChange(null);
                              if (error) setError(null);
                            }}
                            className="shrink-0 text-xs h-9 px-2.5"
                            aria-label="إلغاء اختيار الخدمة الافتراضية"
                          >
                            إلغاء التحديد
                          </Button>
                        ) : null}
                      </div>

                      {/* State C: Saved default service exists but is inactive */}
                      {defaultServiceState === "inactive" && matchedService ? (
                        <div
                          role="alert"
                          className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3.5 text-xs leading-5 text-amber-950 dark:text-amber-200 space-y-1"
                        >
                          <div className="flex items-center gap-2 font-semibold text-sm">
                            <span className="size-2 rounded-full bg-amber-500 shrink-0" />
                            <span>
                              الخدمة الافتراضية المحفوظة غير مفعّلة (
                              {matchedService.name})
                            </span>
                          </div>
                          <p className="text-muted-foreground dark:text-amber-200/90">
                            الخدمة المحفوظة كخدمة افتراضية (
                            {matchedService.name}) متوقفة حالياً ولا يمكن
                            استخدامها للحجز التلقائي. يرجى اختيار خدمة نشطة
                            بديلة، أو إلغاء تحديد الخدمة وتعطيل الحجز السريع.
                          </p>
                        </div>
                      ) : null}

                      {/* State D: Saved ID cannot be resolved in tenant's available services */}
                      {defaultServiceState === "unavailable" ? (
                        <div
                          role="alert"
                          className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3.5 text-xs leading-5 text-amber-950 dark:text-amber-200 space-y-1"
                        >
                          <div className="flex items-center gap-2 font-semibold text-sm">
                            <span className="size-2 rounded-full bg-amber-500 shrink-0" />
                            <span>الخدمة الافتراضية المحفوظة غير متاحة</span>
                          </div>
                          <p className="text-muted-foreground dark:text-amber-200/90">
                            الخدمة الافتراضية المحفوظة غير متاحة في قائمة خدمات
                            المنشأة الحالية. يرجى اختيار خدمة نشطة بديلة، أو
                            تعطيل الحجز بالخدمة الافتراضية واستخدام زر
                            &quot;إلغاء التحديد&quot;.
                          </p>
                        </div>
                      ) : null}
                    </div>
                  )}
                />
                {fieldError(
                  form.formState.errors.defaultBookingServiceId?.message,
                )}
                <p className="text-xs leading-5 text-muted-foreground">
                  تُعرض الخدمات النشطة والمتاحة للمنشأة فقط.
                </p>
              </div>

              {/* Booking Preview when enabled */}
              {defaultServiceBookingEnabled && selectedDefaultService ? (
                <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 text-xs leading-6 space-y-1.5">
                  <div className="font-semibold text-primary flex items-center gap-1.5">
                    <SparklesIcon className="size-3.5" />
                    <span>معاينة سلوك الحجز مع العميل:</span>
                  </div>
                  <p className="text-muted-foreground">
                    العميل:{" "}
                    <span className="font-medium text-foreground">
                      &quot;عايز أحجز بكرة&quot;
                    </span>
                  </p>
                  <p className="text-muted-foreground">
                    المساعد:{" "}
                    <span className="font-medium text-foreground">
                      &quot;تمام، هحجز لك على خدمة {selectedDefaultService.name}
                      . تقدر تغيّر الخدمة لو حابب. دي المواعيد المتاحة
                      بكرة...&quot;
                    </span>
                  </p>
                </div>
              ) : null}
            </div>
          </div>
        </section>

        {/* ─── Section 4: التذكير بالمواعيد (BOOK-REM-01) ─── */}
        <section
          aria-labelledby="settings-reminders-section"
          className="rounded-xl border bg-card p-5 shadow-xs sm:p-6"
        >
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <SectionHeader
              title="التذكير بالمواعيد"
              description="ذكّر عملاءك تلقائيًا قبل موعدهم."
            />
            {!initialSettings.remindersOperational ? (
              <Badge
                variant="outline"
                className="w-fit text-xs border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300"
              >
                مرحلة الإعداد (غير مفعّل)
              </Badge>
            ) : null}
          </div>
          <div className="space-y-6 pt-2">
            {/* Informative Status when feature is globally disabled */}
            {!initialSettings.remindersOperational ? (
              <div
                role="status"
                className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-xs leading-5 text-amber-950 dark:text-amber-200 space-y-1"
              >
                <div className="flex items-center gap-2 font-semibold text-sm">
                  <span className="size-2 rounded-full bg-amber-500" />
                  <span>التذكير التلقائي غير مفعّل حاليًا</span>
                </div>
                <p className="text-muted-foreground dark:text-amber-200/80">
                  يمكنك استعراض إعدادات التذكير وتجهيزها، لكن لن يتم إرسال رسائل
                  تلقائية خلال المرحلة الحالية.
                </p>
              </div>
            ) : null}

            {/* Setting A: Enable reminder */}
            <div className="flex items-start gap-3 rounded-lg border p-4 bg-muted/20">
              <Controller
                control={form.control}
                name="reminderEnabled"
                render={({ field }) => (
                  <Checkbox
                    id="settings-reminder-enabled"
                    checked={
                      initialSettings.remindersOperational ? field.value : false
                    }
                    onCheckedChange={
                      initialSettings.remindersOperational
                        ? field.onChange
                        : undefined
                    }
                    disabled={
                      !initialSettings.remindersOperational ||
                      !initialSettings.channelReadiness.hasActiveChannel
                    }
                    aria-describedby="reminder-enabled-desc"
                  />
                )}
              />
              <div className="space-y-1 leading-none">
                <Label
                  htmlFor="settings-reminder-enabled"
                  className={cn(
                    "text-base font-semibold",
                    initialSettings.remindersOperational
                      ? "cursor-pointer"
                      : "cursor-not-allowed opacity-75",
                  )}
                >
                  تفعيل التذكير التلقائي
                </Label>
                <p
                  id="reminder-enabled-desc"
                  className="text-xs text-muted-foreground leading-5"
                >
                  {initialSettings.remindersOperational
                    ? "إرسال رسالة تذكير تلقائية للعميل قبل موعده لتقليل نسبة عدم الحضور."
                    : "التذكير التلقائي معطل حالياً في هذه المرحلة التجريبية. يمكنك تجهيز خيارات التوقيت والنموذج بالأسفل وحفظها للمستقبل."}
                </p>
              </div>
            </div>

            {/* Setting C: Channel readiness */}
            <div className="space-y-2">
              <span className="text-sm font-medium">حالة قنوات المراسلة</span>
              {!initialSettings.channelReadiness.hasActiveChannel ? (
                <div
                  role="alert"
                  className="rounded-lg border border-destructive/30 bg-destructive/10 p-3.5 text-xs leading-5 text-destructive space-y-2"
                >
                  <p className="font-semibold">
                    لا توجد قناة مراسلة جاهزة حالياً لإرسال التذكيرات.
                  </p>
                  <p>
                    لتفعيل التذكير التلقائي، يجب أن يكون رقم واتساب أو بوت
                    تيليجرام متصلاً ومفعلاً.
                  </p>
                  <div className="flex flex-wrap items-center gap-3 pt-1">
                    <Link
                      href="/settings/whatsapp"
                      className="inline-flex items-center gap-1 font-medium underline hover:text-foreground"
                    >
                      <MessageCircleIcon className="size-3.5" />
                      إعداد واتساب
                    </Link>
                    <span>·</span>
                    <Link
                      href="/settings/telegram"
                      className="inline-flex items-center gap-1 font-medium underline hover:text-foreground"
                    >
                      <SendIcon className="size-3.5" />
                      إعداد تيليجرام
                    </Link>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  {initialSettings.channelReadiness.whatsapp ? (
                    <Badge
                      variant="outline"
                      className="border-success/30 bg-success/10 text-success gap-1.5 py-1 px-2.5"
                    >
                      <MessageCircleIcon className="size-3.5" />
                      واتساب متصل ومؤهل
                    </Badge>
                  ) : null}
                  {initialSettings.channelReadiness.telegram ? (
                    <Badge
                      variant="outline"
                      className="border-info/30 bg-info/10 text-info gap-1.5 py-1 px-2.5"
                    >
                      <SendIcon className="size-3.5" />
                      تيليجرام متصل ومؤهل
                    </Badge>
                  ) : null}
                </div>
              )}
            </div>

            {/* Setting B: Reminder lead time */}
            <div className="max-w-sm space-y-2">
              <Label htmlFor="settings-reminder-lead">
                إرسال التذكير قبل الموعد
              </Label>
              <Controller
                control={form.control}
                name="reminderLeadHours"
                render={({ field }) => (
                  <Select
                    value={String(field.value)}
                    onValueChange={(val) => field.onChange(Number(val))}
                  >
                    <SelectTrigger
                      id="settings-reminder-lead"
                      className="w-full"
                    >
                      <SelectValue placeholder="اختر وقت التذكير" />
                    </SelectTrigger>
                    <SelectContent>
                      {REMINDER_LEAD_HOURS_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={String(opt.value)}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              {fieldError(form.formState.errors.reminderLeadHours?.message)}
              <p className="text-xs leading-5 text-muted-foreground">
                يتم حساب وقت الإرسال بدقة بحسب المنطقة الزمنية المعتمدة للمنشأة.
              </p>
            </div>

            {/* Setting D: Message style and live preview */}
            <div className="max-w-sm space-y-2">
              <Label htmlFor="settings-reminder-template">
                نموذج رسالة التذكير
              </Label>
              <Controller
                control={form.control}
                name="reminderTemplateId"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger
                      id="settings-reminder-template"
                      className="w-full"
                    >
                      <SelectValue placeholder="اختر نموذج التذكير" />
                    </SelectTrigger>
                    <SelectContent>
                      {REMINDER_TEMPLATE_OPTIONS.map((tpl) => (
                        <SelectItem key={tpl.id} value={tpl.id}>
                          {tpl.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              {fieldError(form.formState.errors.reminderTemplateId?.message)}
            </div>

            {/* Live Message Preview */}
            <div className="space-y-2 rounded-xl border bg-muted/30 p-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
                  <BellIcon className="size-3.5" />
                  معاينة رسالة التذكير (مثال للعميل):
                </span>
                <Badge variant="secondary" className="text-[10px] font-normal">
                  معاينة فقط
                </Badge>
              </div>
              <div className="rounded-lg border bg-card p-3.5 text-sm leading-6 shadow-xs whitespace-pre-wrap">
                {form.watch("reminderTemplateId") === "compact"
                  ? `تذكير بموعدك: لدى ${form.watch("name") || "عيادة الأمل"} يوم الأحد (مثال) الساعة 10:00 ص لخدمة كشف واستشارة. نرجو الحضور قبل الموعد بـ 10 دقائق.`
                  : `مرحباً بك! نود تذكيرك بموعدك لدى ${form.watch("name") || "عيادة الأمل"} يوم الأحد (مثال) الساعة 10:00 ص (خدمة: كشف واستشارة). يسعدنا حضورك في الموعد المحدد.`}
              </div>
              <p className="text-[11px] leading-4 text-muted-foreground">
                * معاينة تجريبية لشكل النص فقط — لن يتم إرسال أي رسائل للعملاء
                خلال هذه المرحلة. في المستقبل، سيتم الإرسال عبر القالب المعتمد
                رسمياً دون أي بيانات خاصة.
              </p>
            </div>
          </div>
        </section>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {saved && !form.formState.isDirty ? (
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
            {initialSettings.remindersOperational
              ? "تعمل التعديلات على المواعيد الجديدة فوراً بعد الحفظ."
              : "تعمل التعديلات على المواعيد الجديدة فوراً بعد الحفظ (إعدادات التذكير تبقى مُجهّزة لحين تفعيل الخدمة مستقبلاً)."}
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
