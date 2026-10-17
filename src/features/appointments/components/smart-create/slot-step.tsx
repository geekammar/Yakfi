"use client";

import { getAvailabilityAction } from "@/features/appointments/actions/availability-actions";
import { formatArabicDate } from "@/features/appointments/components/smart-create/date-format";
import {
  derivePresentSlots,
  deriveSmartSuggestions,
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
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

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
  NO_ELIGIBLE_PROVIDERS: {
    icon: CalendarXIcon,
    title: "أضف مقدم خدمة لبدء الحجز",
    description:
      "تحتاج هذه الخدمة إلى مقدم خدمة واحد على الأقل قبل استقبال المواعيد.",
    showServiceAction: true,
  },
} as const;

/** The only label an unselectable candidate ever gets — never a reason. */
const UNAVAILABLE_LABEL = "غير متاح";

/**
 * Step 4 — الوقت (UX001-R1 Adaptive Quick Booking).
 *
 * Implements:
 * 1. Adaptive Provider Selection:
 *    - ZERO providers: neutral empty state, no misleading times, link back to service.
 *    - ONE provider: auto-selected, no selector UI, no 'Any', no switching.
 *    - TWO+ providers: 'Any available provider' + specific providers, same-time
 *      alternatives when occupied, no silent substitutions.
 * 2. Smart Time Suggestions:
 *    - Small group of 2–3 genuinely useful distinct suggestions.
 *    - Earliest suitable time, same time with another provider, nearby time.
 *    - 'View all times' progressive disclosure for full schedule.
 * 3. Mobile-First & Responsive:
 *    - Arabic RTL, large comfortable touch targets (h-11), no horizontal overflow at 320–390px.
 *    - Clear accessible states, color-independent availability labels.
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
  eligibleProviders = [],
  selectedProviderId = null,
  onSelectProvider,
  isEligibleProvidersLoading: _isEligibleProvidersLoading = false,
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
  excludeAppointmentId?: string;
  workingHours?: unknown;
  slotDurationMinutes?: number | null;
  eligibleProviders?: Array<{ providerId: string; displayName: string }>;
  selectedProviderId?: string | null;
  onSelectProvider?: (providerId: string | null) => void;
  isEligibleProvidersLoading?: boolean;
}) {
  void _isEligibleProvidersLoading;
  const [showAllTimes, setShowAllTimes] = useState(false);
  const [alternativePrompt, setAlternativePrompt] = useState<{
    startTime: string;
    altProviderId: string;
    altProviderName: string;
    nearbyTime?: string;
  } | null>(null);

  const isMultipleProviders = eligibleProviders.length >= 2;

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

  // Raw server slots containing all bookable slots across eligible providers
  const rawSlots =
    result && result.success && result.data.slots.length > 0
      ? result.data.slots
      : null;

  // Filter slots for the currently selected provider (if a specific provider is chosen)
  const slots = useMemo(() => {
    if (!rawSlots) return null;
    if (!selectedProviderId) return rawSlots;
    return rawSlots.filter((slot) =>
      slot.availableProviderIds
        ? slot.availableProviderIds.includes(selectedProviderId)
        : true,
    );
  }, [rawSlots, selectedProviderId]);

  // Current slot is valid only if it exists in the active filtered slots
  const currentSlot =
    slots && slotExistsIn(selectedSlot, slots) ? selectedSlot : null;

  // Provider display name
  const selectedProviderName = useMemo(() => {
    if (selectedProviderId) {
      return (
        eligibleProviders.find((p) => p.providerId === selectedProviderId)
          ?.displayName ?? null
      );
    }
    if (eligibleProviders.length === 1) {
      return eligibleProviders[0]?.displayName ?? null;
    }
    return null;
  }, [selectedProviderId, eligibleProviders]);

  // Smart suggestions derived from all available slots
  const smartSuggestions = useMemo(() => {
    if (!rawSlots || rawSlots.length === 0) return [];
    return deriveSmartSuggestions({
      slots: rawSlots,
      eligibleProviders,
      selectedProviderId,
      requestedTime: selectedSlot?.startTime,
      maxSuggestions: 3,
    });
  }, [
    rawSlots,
    eligibleProviders,
    selectedProviderId,
    selectedSlot?.startTime,
  ]);

  const emptyReason: AvailabilityNoSlotsReason | null =
    result && result.success && result.data.slots.length === 0
      ? (result.reason ?? "FULLY_BOOKED")
      : null;

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

  const presentSlots = useMemo(
    () =>
      derivePresentSlots({
        candidateGrid,
        availableSlots: slots,
        blockedIntervals: result?.success ? result.data.blockedIntervals : null,
        selectedProviderId,
      }),
    [candidateGrid, slots, result, selectedProviderId],
  );
  const availableCount = presentSlots
    ? presentSlots.filter((slot) => slot.available).length
    : 0;
  const unavailableCount = presentSlots
    ? presentSlots.length - availableCount
    : 0;
  const timezone = result?.success ? result.data.timezone : null;

  // Stale selection guard
  useEffect(() => {
    if (
      result?.success &&
      selectedSlot &&
      !slotExistsIn(selectedSlot, result.data.slots)
    ) {
      onSlotUnavailable();
    }
  }, [result, selectedSlot, onSlotUnavailable]);

  // When server determines no eligible providers exist for a provider-aware service:
  if (
    emptyReason === "NO_ELIGIBLE_PROVIDERS" ||
    eligibleProviders.length === 0
  ) {
    return (
      <EmptyState
        icon={CalendarXIcon}
        title="أضف مقدم خدمة لبدء الحجز"
        description="تحتاج هذه الخدمة إلى مقدم خدمة واحد على الأقل قبل استقبال المواعيد."
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button asChild size="sm">
              <Link href="/admin/team">إدارة الفريق ومقدمي الخدمة</Link>
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onGoToService}
            >
              اختيار خدمة أخرى
            </Button>
          </div>
        }
      />
    );
  }

  function handleCandidateClick(candidate: {
    startTime: string;
    endTime: string;
    available: boolean;
  }) {
    if (candidate.available) {
      const match = slots?.find((s) => s.startTime === candidate.startTime);
      if (match) onSelectSlot(match);
      setAlternativePrompt(null);
      return;
    }

    // Candidate is not available with current provider. Check if another provider is free at same time.
    if (selectedProviderId && rawSlots) {
      const altMatch = rawSlots.find(
        (s) => s.startTime === candidate.startTime,
      );
      const altId = altMatch?.availableProviderIds?.[0];
      if (altId) {
        const altProvider = eligibleProviders.find(
          (p) => p.providerId === altId,
        );
        const nearbySlot = slots?.find(
          (s) => s.startTime > candidate.startTime,
        );
        setAlternativePrompt({
          startTime: candidate.startTime,
          altProviderId: altId,
          altProviderName: altProvider?.displayName ?? "موظف آخر",
          nearbyTime: nearbySlot?.startTime,
        });
      }
    }
  }

  return (
    <div className="w-full max-w-full space-y-5 overflow-hidden">
      {/* Date header bar */}
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

      {/* Provider selection: shown ONLY when 2 or more eligible providers exist */}
      {isMultipleProviders ? (
        <div className="space-y-2">
          <label className="text-xs font-medium text-muted-foreground">
            اختيار الموظف
          </label>
          <div
            className="flex flex-wrap gap-2"
            role="radiogroup"
            aria-label="اختيار الموظف"
          >
            <button
              type="button"
              role="radio"
              aria-checked={selectedProviderId === null}
              onClick={() => {
                onSelectProvider?.(null);
                setAlternativePrompt(null);
              }}
              className={cn(
                "flex h-11 items-center justify-center rounded-xl border px-4 text-sm font-medium transition-colors",
                selectedProviderId === null
                  ? "border-primary bg-primary text-primary-foreground shadow-xs"
                  : "border-border bg-card text-foreground hover:bg-accent/60",
              )}
            >
              أي موظف متاح
            </button>
            {eligibleProviders.map((provider) => {
              const isSelected = selectedProviderId === provider.providerId;
              return (
                <button
                  key={provider.providerId}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  onClick={() => {
                    onSelectProvider?.(provider.providerId);
                    setAlternativePrompt(null);
                  }}
                  className={cn(
                    "flex h-11 items-center justify-center gap-1.5 rounded-xl border px-4 text-sm font-medium transition-colors",
                    isSelected
                      ? "border-primary bg-primary text-primary-foreground shadow-xs"
                      : "border-border bg-card text-foreground hover:bg-accent/60",
                  )}
                >
                  <span>{provider.displayName}</span>
                  {isSelected ? (
                    <CheckCircle2Icon aria-hidden className="size-4 shrink-0" />
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* Alternative suggestion banner when user inquires an occupied slot */}
      {alternativePrompt ? (
        <div
          role="alert"
          className="space-y-2.5 rounded-xl border border-primary/30 bg-primary/5 p-3.5 text-sm"
        >
          <p className="font-medium text-foreground">
            الوقت {formatSlotTime(alternativePrompt.startTime)} غير متاح مع{" "}
            {selectedProviderName}، لكنه متاح مع{" "}
            {alternativePrompt.altProviderName}.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => {
                const match = rawSlots?.find(
                  (s) => s.startTime === alternativePrompt.startTime,
                );
                if (match) {
                  onSelectProvider?.(alternativePrompt.altProviderId);
                  onSelectSlot(match);
                  setAlternativePrompt(null);
                }
              }}
            >
              الحجز مع {alternativePrompt.altProviderName} في{" "}
              {formatSlotTime(alternativePrompt.startTime)}
            </Button>
            {alternativePrompt.nearbyTime ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  const match = slots?.find(
                    (s) => s.startTime === alternativePrompt.nearbyTime,
                  );
                  if (match) {
                    onSelectSlot(match);
                    setAlternativePrompt(null);
                  }
                }}
              >
                أقرب وقت مع {selectedProviderName} (
                {formatSlotTime(alternativePrompt.nearbyTime)})
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setAlternativePrompt(null)}
            >
              إلغاء
            </Button>
          </div>
        </div>
      ) : null}

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
        <div className="space-y-5">
          {/* Smart suggestions section: up to 2–3 valid suggestions displayed first */}
          {smartSuggestions.length > 0 ? (
            <section aria-label="الأوقات المقترحة" className="space-y-2.5">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                <ZapIcon aria-hidden className="size-3.5 text-primary" />
                <span>أوقات مقترحة سريعة</span>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {smartSuggestions.map((suggestion) => {
                  const isSelected =
                    currentSlot?.startTime === suggestion.slot.startTime &&
                    (!selectedProviderId ||
                      selectedProviderId === suggestion.providerId ||
                      selectedProviderId === null);
                  return (
                    <button
                      key={`${suggestion.slot.startTime}-${suggestion.providerId ?? "any"}`}
                      type="button"
                      onClick={() => {
                        if (
                          suggestion.providerId &&
                          suggestion.providerId !== selectedProviderId &&
                          eligibleProviders.length > 1
                        ) {
                          onSelectProvider?.(suggestion.providerId);
                        }
                        onSelectSlot(suggestion.slot);
                        setAlternativePrompt(null);
                      }}
                      aria-pressed={isSelected}
                      aria-label={`${formatSlotTime(suggestion.slot.startTime)} — ${suggestion.badge}`}
                      className={cn(
                        "flex min-h-[44px] flex-col items-start justify-center gap-1 rounded-xl border p-3 text-start transition-colors",
                        isSelected
                          ? "border-primary bg-primary/10 text-foreground ring-1 ring-primary"
                          : "border-border bg-card hover:bg-accent/60",
                      )}
                    >
                      <div className="flex w-full items-center justify-between gap-2">
                        <span className="text-sm font-semibold tabular-nums">
                          {formatSlotTime(suggestion.slot.startTime)}
                        </span>
                        <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                          {suggestion.badge}
                        </span>
                      </div>
                      {suggestion.providerName ? (
                        <span className="text-xs text-muted-foreground">
                          مع {suggestion.providerName}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </section>
          ) : null}

          {/* Schedule status & 'View all times' progressive disclosure action */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
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
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowAllTimes((prev) => !prev)}
            >
              {showAllTimes ? "إخفاء جدول اليوم" : "عرض جميع الأوقات"}
            </Button>
          </div>

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

          {/* Full candidate time grid (shown when expanded or if no suggestions exist) */}
          {showAllTimes || smartSuggestions.length === 0 ? (
            <div className="space-y-4 pt-1">
              <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground pb-1">
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-emerald-500" />
                  متاح
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-primary" />
                  المحدد
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-amber-500" />
                  غير متاح (موعد قائم)
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-muted-foreground/40" />
                  غير متاح
                </span>
              </div>
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
                        slot.available &&
                        currentSlot?.startTime === slot.startTime;
                      return (
                        <li key={slot.startTime}>
                          {slot.available ? (
                            <button
                              type="button"
                              onClick={() =>
                                handleCandidateClick({
                                  startTime: slot.startTime,
                                  endTime: slot.endTime,
                                  available: true,
                                })
                              }
                              aria-pressed={isSelected}
                              aria-label={`حجز من ${formatSlotTime(slot.startTime)} إلى ${formatSlotTime(slot.endTime)}`}
                              className={cn(
                                "flex h-11 min-w-[5.25rem] items-center justify-center gap-1.5 rounded-xl border px-4 text-sm font-medium transition-colors",
                                isSelected
                                  ? "border-primary bg-primary text-primary-foreground ring-2 ring-primary ring-offset-2 ring-offset-background shadow-xs"
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
                            <button
                              type="button"
                              onClick={() =>
                                handleCandidateClick({
                                  startTime: slot.startTime,
                                  endTime: slot.endTime,
                                  available: false,
                                })
                              }
                              aria-disabled
                              aria-label={`${formatSlotTime(slot.startTime)} — ${UNAVAILABLE_LABEL}`}
                              className={cn(
                                "flex h-11 min-w-[5.25rem] flex-col items-center justify-center gap-0.5 rounded-xl border px-3 text-muted-foreground transition-colors",
                                slot.blockedByAppointment
                                  ? "border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-300 dark:border-amber-500/20"
                                  : "border-border/50 bg-muted/40",
                                selectedProviderId
                                  ? "cursor-pointer hover:border-border"
                                  : "cursor-not-allowed",
                              )}
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
            </div>
          ) : null}

          {/* Current selected slot confirmation banner */}
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
                {selectedProviderName ? (
                  <span className="text-muted-foreground">
                    {" "}
                    · مع {selectedProviderName}
                  </span>
                ) : null}
              </p>
              {/* Show which eligible providers are available for this selected time */}
              {eligibleProviders.length > 1 &&
              !selectedProviderId &&
              currentSlot.availableProviderIds &&
              currentSlot.availableProviderIds.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                  الموظفون المتاحون في هذا الوقت:{" "}
                  {currentSlot.availableProviderIds
                    .map(
                      (id) =>
                        eligibleProviders.find((p) => p.providerId === id)
                          ?.displayName,
                    )
                    .filter(Boolean)
                    .join("، ")}
                </p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                تابع إلى المراجعة للتأكد من تفاصيل الموعد قبل التأكيد.
              </p>
            </div>
          ) : null}
        </div>
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
