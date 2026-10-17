"use client";

import { createAppointment } from "@/features/appointments/actions/appointment-actions";
import { getAvailabilityAction } from "@/features/appointments/actions/availability-actions";
import { resolveEligibleProvidersAction } from "@/features/appointments/actions/provider-eligibility-actions";
import { BookingFlowProgress } from "@/features/appointments/components/smart-create/booking-flow-progress";
import { ConfirmStep } from "@/features/appointments/components/smart-create/confirm-step";
import {
  CustomerStep,
  type CustomerCreateDialogComponent,
} from "@/features/appointments/components/smart-create/customer-step";
import {
  formatArabicDate,
  resolveRelativeDate,
  type RelativeDateOption,
} from "@/features/appointments/components/smart-create/date-format";
import { DateStep } from "@/features/appointments/components/smart-create/date-step";
import { ProviderSetupDialog } from "@/features/appointments/components/smart-create/provider-setup-dialog";
import {
  ReviewStep,
  getMissingReviewFields,
} from "@/features/appointments/components/smart-create/review-step";
import { ServiceStep } from "@/features/appointments/components/smart-create/service-step";
import { slotExistsIn } from "@/features/appointments/components/smart-create/slot-helpers";
import { SlotStep } from "@/features/appointments/components/smart-create/slot-step";
import type {
  BookingCustomerOption,
  BookingFlowScreen,
  BookingServiceOption,
  ConfirmSubmitState,
  CreateAppointmentActionResult,
  FollowUpState,
  ReviewCheckState,
  SelectedSlot,
} from "@/features/appointments/types";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { appointmentDateSchema } from "@/lib/validation";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CalendarXIcon,
  LoaderCircleIcon,
  UserPlusIcon,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";

const STEP_HEADINGS: Record<
  BookingFlowScreen,
  { title: string; description: string }
> = {
  customer: {
    title: "من هو العميل؟",
    description: "ابحث بالاسم أو رقم الهاتف واختر العميل.",
  },
  service: {
    title: "أي خدمة يحتاجها؟",
    description: "تظهر الخدمات النشطة فقط، وتُحسب مدة الموعد من الخدمة.",
  },
  date: {
    title: "متى الموعد؟",
    description: "اختر يوماً قريباً أو حدّد تاريخاً آخر.",
  },
  slot: {
    title: "أي وقت يناسب الموعد؟",
    description: "اختر وقتاً من الأوقات المتاحة فعلياً في اليوم المحدد.",
  },
  review: {
    title: "راجع تفاصيل الموعد",
    description: "تأكد من كل التفاصيل قبل خطوة التأكيد النهائي.",
  },
  confirm: {
    title: "تأكيد الحجز",
    description: "أكّد التفاصيل المعروضة ليُنشأ الموعد.",
  },
};

const STALE_SLOT_MESSAGE =
  "لم يعد الوقت الذي اخترته متاحاً — ربما حُجز في هذه الأثناء. اختر وقتاً آخر للموعد.";

/**
 * Smart Create Appointment flow (PROMPT-11 Steps 1–3 + PROMPT-12
 * Step 4 + PROMPT-13 Step 5 + PROMPT-14 Step 6 + B-07 smart context /
 * relative scheduling / availability-first / follow-up).
 *
 * العميل → الخدمة → التاريخ → الوقت → المراجعة → التأكيد, with all
 * six steps active. Selections live in this container only — moving
 * back and forth never resets them. Step 4 consumes the existing
 * availability layer through `getAvailabilityAction` and is SELECTION
 * ONLY. Step 5 reviews the preserved selections; its primary action
 * REVALIDATES the chosen slot through the SAME availability action
 * (no second engine, no reservation) — a verified review hands off to
 * Step 6. Step 6 (التأكيد) shows the final read-only summary and
 * creates the appointment through the EXISTING `createAppointment`
 * action (the canonical, conflict-checked write path); success is
 * recorded only from the server's own result, and the wizard is
 * cleared only after success is known. Changing the service or the
 * date clears the slot selection — a stale slot can never survive an
 * input change it was not computed for.
 *
 * B-07 additions (all reusing the existing domain authority — no new
 * write path, no second availability engine, no persisted linkage):
 * - Smart Context: a server-resolved customer/service prefill opens
 *   the flow past the already-known steps (§A).
 * - the date step offers relative choices whose dates this container
 *   derives from the server-derived business today (§B).
 * - after a confirmed creation, a follow-up is scheduled at a
 *   relative offset from the CREATED appointment's date — the original
 *   time is re-checked for availability first, and the SAME
 *   `createAppointment` path writes it; an unavailable time hands the
 *   follow-up back to slot selection instead of ever booking it (§6).
 * - "create another" preserves the customer (§5 STEP F).
 */
export function SmartCreateAppointment({
  initialCustomers,
  services,
  defaultDate,
  today,
  canManageServices,
  businessTimezone,
  confirmationMode,
  initialCustomer,
  initialServiceId,
  initialScreen,
  CustomerCreateDialog,
  workingHours,
  slotDurationMinutes,
}: {
  initialCustomers: BookingCustomerOption[];
  services: BookingServiceOption[];
  defaultDate: string;
  /** Business-local "YYYY-MM-DD" today (server-derived). */
  today: string;
  canManageServices: boolean;
  /** Business timezone (server-derived) — display only. */
  businessTimezone: string;
  /** Business booking setting (server-derived) — drives the
   * post-confirmation behavior copy. */
  confirmationMode: "automatic" | "manual";
  /**
   * Smart Context prefill (B-07 §A): a customer (from a customer page
   * or conversation) and/or a service (from a service page) ALREADY
   * resolved against the actor's own Business by the route — the
   * wizard never trusts a client id. Prefilled inputs are shown as
   * selected and never asked again.
   */
  initialCustomer?: BookingCustomerOption | null;
  initialServiceId?: string | null;
  /** Where the flow opens after prefill (derived by the route through
   * the booking-flow service). */
  initialScreen?: BookingFlowScreen;
  /**
   * Optional create-customer dialog (PROMPT-15): composed at the
   * route layer from the customers feature so Step 1 can create a
   * customer when no existing one is available. Absent → Step 1
   * behaves exactly as before.
   */
  CustomerCreateDialog?: CustomerCreateDialogComponent;
  /**
   * The candidate-grid inputs for Step 4 (DECISIONS #56): the business's
   * stored working-hours week + slot granularity, both server-derived.
   * Passed through untouched; the grid rule lives in the slot step.
   */
  workingHours?: unknown;
  slotDurationMinutes?: number | null;
}) {
  const [screen, setScreen] = useState<BookingFlowScreen>(
    initialScreen ?? "customer",
  );
  const [customer, setCustomer] = useState<BookingCustomerOption | null>(
    initialCustomer ?? null,
  );
  const [serviceId, setServiceId] = useState<string | null>(
    initialServiceId ?? null,
  );
  const [date, setDate] = useState(defaultDate);
  const [selectedSlot, setSelectedSlot] = useState<SelectedSlot | null>(null);
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(
    null,
  );
  const [reviewCheck, setReviewCheck] = useState<ReviewCheckState>({
    status: "idle",
  });
  const [submitState, setSubmitState] = useState<ConfirmSubmitState>({
    status: "idle",
  });
  const [followUp, setFollowUp] = useState<FollowUpState>({ status: "idle" });
  /** The date a relative follow-up choice resolved to (display only). */
  const [followUpDate, setFollowUpDate] = useState<string | null>(null);
  const queryClient = useQueryClient();
  /** Re-entrancy guard: a second click during an in-flight create
   * must never issue a second write. */
  const submitInFlight = useRef(false);
  /** Same guard for the follow-up create. */
  const followUpInFlight = useRef(false);

  const service = services.find((item) => item.id === serviceId) ?? null;
  const dateIsValid = appointmentDateSchema.safeParse(date).success;

  // Resolve eligible providers for the selected service (UX001-R1)
  const eligibleProvidersQuery = useQuery({
    queryKey: ["booking-eligible-providers", serviceId],
    queryFn: () => resolveEligibleProvidersAction({ serviceId: serviceId! }),
    enabled: Boolean(serviceId),
    staleTime: 60_000,
  });

  const eligibleProviders = useMemo(() => {
    if (eligibleProvidersQuery.data?.success) {
      return eligibleProvidersQuery.data.data.providers;
    }
    return [];
  }, [eligibleProvidersQuery.data]);

  const [providerSetupOpen, setProviderSetupOpen] = useState(false);

  const isZeroEligibleProviders =
    Boolean(serviceId) &&
    eligibleProvidersQuery.isSuccess &&
    eligibleProviders.length === 0;

  function handleProviderSetupSuccess(newProviderId: string) {
    if (serviceId) {
      void queryClient.invalidateQueries({
        queryKey: ["booking-eligible-providers", serviceId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["booking-availability", serviceId],
      });
    }
    setSelectedProviderId(newProviderId);
    setScreen("date");
  }

  // Derived active provider ID for the selector UI (resets safely if provider is no longer eligible)
  const activeSelectedProviderId = useMemo(() => {
    if (
      selectedProviderId &&
      eligibleProviders.some((p) => p.providerId === selectedProviderId)
    ) {
      return selectedProviderId;
    }
    return null;
  }, [selectedProviderId, eligibleProviders]);

  /** The provider ID to be persisted by the canonical booking engine. */
  const effectiveProviderId = useMemo(() => {
    if (activeSelectedProviderId) return activeSelectedProviderId;
    if (eligibleProviders.length === 1 && eligibleProviders[0]) {
      return eligibleProviders[0].providerId;
    }
    if (
      selectedSlot?.availableProviderIds &&
      selectedSlot.availableProviderIds.length > 0 &&
      selectedSlot.availableProviderIds[0]
    ) {
      return selectedSlot.availableProviderIds[0];
    }
    return undefined;
  }, [activeSelectedProviderId, eligibleProviders, selectedSlot]);

  /** Human-readable provider name for summaries and reviews. */
  const selectedProviderName = useMemo(() => {
    if (effectiveProviderId) {
      return (
        eligibleProviders.find((p) => p.providerId === effectiveProviderId)
          ?.displayName ?? null
      );
    }
    return null;
  }, [effectiveProviderId, eligibleProviders]);

  /** Any change to the revalidated inputs resets the review check. */
  function resetReviewCheck() {
    setReviewCheck({ status: "idle" });
  }

  /** Changing the service invalidates any slot and provider chosen for another one. */
  function handleSelectService(nextServiceId: string) {
    if (nextServiceId !== serviceId) {
      setSelectedSlot(null);
      setSelectedProviderId(null);
      resetReviewCheck();
    }
    setServiceId(nextServiceId);
  }

  /** Changing the date invalidates any slot chosen for another day. */
  function handleSelectDate(nextDate: string) {
    if (nextDate !== date) {
      setSelectedSlot(null);
      resetReviewCheck();
    }
    setDate(nextDate);
  }

  /** Selecting or switching a provider. Does NOT preserve invalid slots. */
  function handleSelectProvider(nextProviderId: string | null) {
    if (nextProviderId !== selectedProviderId) {
      if (
        selectedSlot &&
        nextProviderId &&
        selectedSlot.availableProviderIds &&
        !selectedSlot.availableProviderIds.includes(nextProviderId)
      ) {
        setSelectedSlot(null);
      }
      setSelectedProviderId(nextProviderId);
      resetReviewCheck();
    }
  }

  /** Selecting a fresh slot gives the review a new state to verify. */
  function handleSelectSlot(slot: SelectedSlot) {
    setSelectedSlot(slot);
    resetReviewCheck();
  }

  /**
   * Step 4's fresh availability result no longer contains the preserved
   * slot (booked by someone else meanwhile) — clear it through the
   * same wizard-state mechanism so no stale slot can reach the review.
   */
  function handleSlotUnavailable() {
    setSelectedSlot(null);
    resetReviewCheck();
  }

  const missingReviewFields = getMissingReviewFields({
    customer,
    service,
    date,
    selectedSlot,
  });
  const reviewIsValid = missingReviewFields.length === 0;

  const currentStep =
    screen === "customer"
      ? 1
      : screen === "service"
        ? 2
        : screen === "date"
          ? 3
          : screen === "slot"
            ? 4
            : screen === "review"
              ? 5
              : 6;

  const canContinue =
    screen === "customer"
      ? customer !== null
      : screen === "service"
        ? serviceId !== null
        : screen === "date"
          ? dateIsValid && !isZeroEligibleProviders
          : screen === "slot"
            ? selectedSlot !== null && !isZeroEligibleProviders
            : reviewIsValid;

  function goBack() {
    if (screen === "service") setScreen("customer");
    else if (screen === "date") setScreen("service");
    else if (screen === "slot") setScreen("date");
    else if (screen === "review") setScreen("slot");
    else if (screen === "confirm") setScreen("review");
  }

  function goNext() {
    if (screen === "customer") setScreen("service");
    else if (screen === "service") setScreen("date");
    else if (screen === "date") setScreen("slot");
    else if (screen === "slot") setScreen("review");
  }

  /**
   * Step 5's primary action: revalidate the selected slot against the
   * CURRENT availability through the existing `getAvailabilityAction`
   * (the same PROMPT-10 layer Step 4 uses — one engine, no duplicate
   * mount-time query; exactly one request per click). NEVER creates
   * an appointment. A stale slot clears through the wizard-state
   * mechanism and the user stays on the review with an obvious way
   * back to Step 4. A verified slot is a HAND-OFF (not a
   * reservation): the flow moves to Step 6, whose write still relies
   * on `createAppointment`'s transactional conflict check.
   */
  async function handleReviewContinue() {
    if (!reviewIsValid || !service || !selectedSlot) return;
    setReviewCheck({ status: "checking" });
    let result;
    try {
      result = await getAvailabilityAction({
        date,
        serviceId: service.id,
        providerId: effectiveProviderId,
      });
    } catch {
      setReviewCheck({ status: "failed" });
      return;
    }
    const stillBookable =
      result.success && slotExistsIn(selectedSlot, result.data.slots);
    if (!stillBookable) {
      setSelectedSlot(null);
      setReviewCheck({
        status: "stale",
        message: result.success ? STALE_SLOT_MESSAGE : result.error.message,
      });
      return;
    }
    setReviewCheck({ status: "verified" });
    setSubmitState({ status: "idle" });
    setScreen("confirm");
  }

  /**
   * Step 6's primary action: create the appointment through the
   * EXISTING `createAppointment` action — the wizard never builds an
   * appointment record itself. The submitted payload carries ONLY the
   * wizard's server-validated selections (the slot's server-computed
   * start time; the end time and every protection live server-side).
   * Duplicate submission is blocked in-flight (ref + disabled button)
   * and by the write path's own conflict check. Success is recorded
   * ONLY from the server's result — including the actual
   * server-derived appointment status.
   */
  async function handleConfirmSubmit() {
    if (submitInFlight.current || submitState.status === "success") return;
    if (!customer || !service || !selectedSlot || !dateIsValid) return;
    submitInFlight.current = true;
    setSubmitState({ status: "submitting" });
    let result: CreateAppointmentActionResult;
    try {
      result = await createAppointment({
        customerId: customer.id,
        serviceId: service.id,
        providerId: effectiveProviderId,
        date,
        startTime: selectedSlot.startTime,
        // The wizard collects no notes (PROMPT-14 scope decision) —
        // the schema requires the key, so an empty note is submitted.
        notes: "",
      });
    } catch {
      submitInFlight.current = false;
      setSubmitState({
        status: "error",
        code: "CREATE_FAILED",
        message: "تعذر إنشاء الموعد الآن. حاول مرة أخرى.",
      });
      return;
    }
    submitInFlight.current = false;
    if (result.success) {
      setSubmitState({
        status: "success",
        appointmentId: result.appointmentId,
        appointmentStatus: result.status,
      });
    } else {
      setSubmitState({
        status: "error",
        code: result.code,
        message: result.message,
      });
    }
  }

  /**
   * SLOT_CONFLICT recovery: the selected time was booked by someone
   * else between the review check and the write. Clear the stale slot
   * through the wizard's established mechanism, return to Step 4, and
   * drop the cached availability for these inputs so the slot step
   * refetches through the EXISTING `getAvailabilityAction` (the same
   * engine — no second availability implementation).
   */
  function handleChooseAnotherSlot() {
    setSelectedSlot(null);
    resetReviewCheck();
    setSubmitState({ status: "idle" });
    if (serviceId) {
      queryClient.removeQueries({
        queryKey: ["booking-availability", serviceId, date],
      });
    }
    setScreen("slot");
  }

  /**
   * Start a fresh booking after a server-confirmed success — the
   * wizard is cleared only now that success is known. Useful context
   * is preserved (B-07 §5 STEP F): the CUSTOMER stays selected (a
   * second appointment for the same person is the common case), so
   * the flow reopens on the service step; everything that a new
   * appointment would legitimately differ on is cleared.
   */
  function handleCreateAnother() {
    setServiceId(null);
    setSelectedProviderId(null);
    setDate(defaultDate);
    setSelectedSlot(null);
    resetReviewCheck();
    setSubmitState({ status: "idle" });
    setFollowUp({ status: "idle" });
    setFollowUpDate(null);
    setScreen(customer ? "service" : "customer");
  }

  /**
   * Schedule a follow-up after a server-confirmed creation (B-07 §6).
   * The relative offset is measured from the CREATED appointment's
   * date (a follow-up "after 1 week" means one week after that
   * appointment), the SAME customer + service are reused, and the
   * ORIGINAL time is re-checked for availability on the follow-up
   * date BEFORE any write — an unavailable time is never booked. When
   * the time is free, the follow-up is created through the EXACT SAME
   * `createAppointment` write path (there is no separate scheduling
   * subsystem); when it is not, the user switches to availability-first
   * slot selection on that date.
   */
  async function handleScheduleFollowUp(option: RelativeDateOption) {
    if (followUpInFlight.current) return;
    if (submitState.status !== "success" || !customer || !service) return;
    if (!selectedSlot) return;
    const resolved = resolveRelativeDate(date, option);
    followUpInFlight.current = true;
    setFollowUpDate(resolved);
    setFollowUp({ status: "scheduling" });

    let availability;
    try {
      availability = await getAvailabilityAction({
        date: resolved,
        serviceId: service.id,
        providerId: effectiveProviderId,
      });
    } catch {
      followUpInFlight.current = false;
      setFollowUp({
        status: "error",
        message: "تعذر التحقق من وقت المتابعة الآن. حاول مرة أخرى.",
      });
      return;
    }
    const stillFree =
      availability.success &&
      slotExistsIn(selectedSlot, availability.data.slots);
    if (!stillFree) {
      followUpInFlight.current = false;
      setFollowUp({
        status: "unavailable",
        message: `وقت الموعد الأصلي غير متاح في ${formatArabicDate(resolved)} — اختر وقتاً متاحاً للتابعة.`,
      });
      return;
    }

    let result: CreateAppointmentActionResult;
    try {
      result = await createAppointment({
        customerId: customer.id,
        serviceId: service.id,
        providerId: effectiveProviderId,
        date: resolved,
        startTime: selectedSlot.startTime,
        notes: "",
      });
    } catch {
      followUpInFlight.current = false;
      setFollowUp({
        status: "error",
        message: "تعذر إنشاء موعد المتابعة الآن. حاول مرة أخرى.",
      });
      return;
    }
    followUpInFlight.current = false;
    if (result.success) {
      setFollowUp({
        status: "scheduled",
        appointmentId: result.appointmentId,
        appointmentStatus: result.status,
      });
    } else if (result.code === "SLOT_CONFLICT") {
      setFollowUp({
        status: "unavailable",
        message: `وقت الموعد الأصلي غير متاح في ${formatArabicDate(resolved)} — اختر وقتاً متاحاً للتابعة.`,
      });
    } else {
      setFollowUp({ status: "error", message: result.message });
    }
  }

  /**
   * The follow-up's original time was unavailable (or the user wants a
   * different day): hand the follow-up to the SAME wizard — customer +
   * service preserved, the resolved date applied, slot cleared — and
   * let availability-first slot selection pick a valid time. No second
   * flow and no new write path; the existing review → confirm guards
   * re-apply verbatim.
   */
  function handFollowUpToWizard(target: "date" | "slot") {
    if (target === "slot" && followUpDate) setDate(followUpDate);
    setSelectedSlot(null);
    resetReviewCheck();
    setSubmitState({ status: "idle" });
    setFollowUp({ status: "idle" });
    setScreen(target);
  }

  const heading = STEP_HEADINGS[screen];
  const conflictError =
    submitState.status === "error" && submitState.code === "SLOT_CONFLICT";

  return (
    <div className="space-y-6">
      <BookingFlowProgress
        currentStep={currentStep}
        completedSteps={{
          customer: customer !== null,
          service: serviceId !== null,
          date: dateIsValid,
          slot: selectedSlot !== null,
        }}
        onSelectStep={(step) =>
          setScreen(
            step === 1
              ? "customer"
              : step === 2
                ? "service"
                : step === 3
                  ? "date"
                  : "slot",
          )
        }
      />

      <span role="status" aria-live="polite" className="sr-only">
        الخطوة الحالية: {heading.title}
      </span>

      {customer &&
      screen !== "customer" &&
      screen !== "review" &&
      screen !== "confirm" ? (
        <dl className="space-y-1.5 rounded-xl border bg-muted/40 px-4 py-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <dt className="shrink-0 text-muted-foreground">العميل</dt>
            <dd className="truncate font-medium">{customer.name}</dd>
          </div>
          {service && (screen === "date" || screen === "slot") ? (
            <div className="flex items-center justify-between gap-3">
              <dt className="shrink-0 text-muted-foreground">الخدمة</dt>
              <dd className="truncate font-medium">
                {service.name} · {service.durationMinutes} دقيقة
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      <section aria-labelledby="booking-step-title" className="space-y-4">
        <header className="space-y-1">
          <h2 id="booking-step-title" className="text-base font-semibold">
            {heading.title}
          </h2>
          <p className="text-sm text-muted-foreground">{heading.description}</p>
        </header>

        {screen === "customer" ? (
          <CustomerStep
            initialCustomers={initialCustomers}
            selected={customer}
            onSelect={setCustomer}
            CreateCustomerDialog={CustomerCreateDialog}
          />
        ) : screen === "service" ? (
          <ServiceStep
            services={services}
            selectedId={serviceId}
            onSelect={handleSelectService}
            canManageServices={canManageServices}
          />
        ) : (screen === "date" || screen === "slot") &&
          isZeroEligibleProviders ? (
          <EmptyState
            icon={CalendarXIcon}
            title="أضف مقدم خدمة لبدء الحجز"
            description="تحتاج هذه الخدمة إلى مقدم خدمة واحد على الأقل قبل استقبال المواعيد."
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                {canManageServices ? (
                  <Button
                    type="button"
                    onClick={() => setProviderSetupOpen(true)}
                  >
                    <UserPlusIcon aria-hidden className="size-4" />
                    إعداد مقدم خدمة
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    اطلب من مدير المنشأة إضافة مقدم خدمة لهذه الخدمة.
                  </span>
                )}
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setScreen("service")}
                >
                  اختيار خدمة أخرى
                </Button>
              </div>
            }
          />
        ) : screen === "date" ? (
          <DateStep
            selectedDate={date}
            today={today}
            onSelect={handleSelectDate}
            serviceId={serviceId ?? undefined}
          />
        ) : screen === "slot" && service ? (
          <SlotStep
            serviceId={service.id}
            date={date}
            selectedSlot={selectedSlot}
            onSelectSlot={handleSelectSlot}
            onSlotUnavailable={handleSlotUnavailable}
            onGoToDate={() => setScreen("date")}
            onGoToService={() => setScreen("service")}
            workingHours={workingHours}
            slotDurationMinutes={slotDurationMinutes}
            eligibleProviders={eligibleProviders}
            selectedProviderId={activeSelectedProviderId}
            onSelectProvider={handleSelectProvider}
            isEligibleProvidersLoading={eligibleProvidersQuery.isPending}
          />
        ) : screen === "review" ? (
          <ReviewStep
            customer={customer}
            service={service}
            date={date}
            selectedSlot={selectedSlot}
            checkState={reviewCheck}
            providerName={selectedProviderName}
            isSingleProvider={eligibleProviders.length === 1}
            onGoToCustomer={() => setScreen("customer")}
            onGoToService={() => setScreen("service")}
            onGoToDate={() => setScreen("date")}
            onGoToSlot={() => setScreen("slot")}
          />
        ) : screen === "confirm" ? (
          <ConfirmStep
            customer={customer}
            service={service}
            date={date}
            selectedSlot={selectedSlot}
            timezone={businessTimezone}
            confirmationMode={confirmationMode}
            providerName={selectedProviderName}
            submitState={submitState}
            followUpState={followUp}
            resolvedFollowUpDate={followUpDate}
            onChooseAnotherSlot={handleChooseAnotherSlot}
            onScheduleFollowUp={(option) => void handleScheduleFollowUp(option)}
            onFollowUpChooseDate={() => handFollowUpToWizard("date")}
            onFollowUpPickTime={() => handFollowUpToWizard("slot")}
          />
        ) : null}
      </section>

      <div className="flex flex-col-reverse gap-2 border-t pt-5 sm:flex-row sm:justify-end">
        {screen === "confirm" ? (
          submitState.status === "success" ? (
            /* Success is server-confirmed: the wizard finishes here.
             * One obvious primary action — open the created
             * appointment's existing detail page. */
            <>
              <Button
                type="button"
                variant="outline"
                onClick={handleCreateAnother}
              >
                إنشاء موعد آخر
              </Button>
              <Button asChild type="button">
                <Link href={`/appointments/${submitState.appointmentId}`}>
                  عرض الموعد
                  <ArrowLeftIcon aria-hidden />
                </Link>
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={goBack}
                disabled={submitState.status === "submitting"}
              >
                <ArrowRightIcon />
                رجوع
              </Button>
              {/* A conflicted slot must not be re-submitted — recovery
               * is اختيار وقت آخر inside the step's alert panel, so
               * the write button is hidden until the slot changes. */}
              {conflictError ? null : (
                <Button
                  type="button"
                  disabled={
                    submitState.status === "submitting" || !reviewIsValid
                  }
                  onClick={() => void handleConfirmSubmit()}
                >
                  {submitState.status === "submitting" ? (
                    <LoaderCircleIcon aria-hidden className="animate-spin" />
                  ) : null}
                  تأكيد الحجز
                </Button>
              )}
            </>
          )
        ) : (
          <>
            {screen === "customer" ? (
              <Button asChild type="button" variant="outline">
                <Link href={`/appointments?date=${date}`}>
                  <ArrowRightIcon />
                  إلغاء
                </Link>
              </Button>
            ) : (
              <Button type="button" variant="outline" onClick={goBack}>
                <ArrowRightIcon />
                رجوع
              </Button>
            )}
            {screen === "review" ? (
              /* Step 5's primary action: revalidate the slot and hand
               * off to Step 6 — it never creates an appointment
               * itself. */
              <Button
                type="button"
                disabled={!reviewIsValid || reviewCheck.status === "checking"}
                onClick={() => void handleReviewContinue()}
              >
                {reviewCheck.status === "checking" ? (
                  <LoaderCircleIcon aria-hidden className="animate-spin" />
                ) : null}
                متابعة إلى التأكيد
              </Button>
            ) : (
              <Button type="button" disabled={!canContinue} onClick={goNext}>
                التالي
              </Button>
            )}
          </>
        )}
      </div>

      {service && canManageServices ? (
        <ProviderSetupDialog
          open={providerSetupOpen}
          onOpenChange={setProviderSetupOpen}
          serviceId={service.id}
          serviceName={service.name}
          onSuccess={handleProviderSetupSuccess}
        />
      ) : null}
    </div>
  );
}
