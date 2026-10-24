import type { AppointmentStatus } from "@/types/domain";

export type ServiceCorrectionHistoryEntry = {
  previousServiceId: string | null;
  previousServiceName?: string | null;
  newServiceId: string;
  newServiceName?: string | null;
  correctedAt: string;
  correctedById?: string | null;
  correctedByName?: string | null;
  notes?: string | null;
};

export type AppointmentAgendaItem = {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  status: AppointmentStatus;
  notes: string | null;
  customer: { id: string; name: string; phone: string };
  service: { id: string; name: string; durationMinutes: number };
  performedService?: {
    id: string;
    name: string;
    durationMinutes: number;
  } | null;
  serviceCorrectedAt?: string | null;
  serviceCorrectedBy?: { id: string; name: string } | null;
  serviceCorrectionHistory?: ServiceCorrectionHistoryEntry[] | null;
  provider?: { id: string; name: string; displayName?: string | null } | null;
  updatedAt?: string;
};

export type AppointmentDetailData = AppointmentAgendaItem & {
  conversationId: string | null;
};

export type AppointmentActionResult =
  | { success: true; appointmentId?: string }
  | { success: false; message: string };

export type CorrectPerformedServiceErrorCode =
  | "VALIDATION"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "NOT_COMPLETED"
  | "NOT_PASSED_YET"
  | "INVALID_SERVICE"
  | "CONCURRENCY_CONFLICT"
  | "UPDATE_FAILED";

export type CorrectPerformedServiceActionResult =
  | {
      success: true;
      appointmentId: string;
      performedServiceId: string;
      performedServiceName: string;
      serviceCorrectedAt: string;
      updatedAt: string;
    }
  | {
      success: false;
      code: CorrectPerformedServiceErrorCode;
      message: string;
    };

/**
 * `rescheduleAppointment` result contract (B-08): typed failure codes so
 * the UI can react to domain failures honestly (a `SLOT_CONFLICT` offers
 * "pick another time"; everything else is reported in place), and — on
 * success — the values the SERVER actually persisted. The client never
 * recomputes `endTime` or the date from its own inputs: the row is the
 * authority, exactly like the create path's server-derived status.
 */
export type RescheduleErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "APPOINTMENT_NOT_ACTIVE"
  | "END_OF_DAY"
  | "SLOT_CONFLICT"
  | "RESCHEDULE_FAILED";

export type RescheduleAppointmentActionResult =
  | {
      success: true;
      appointmentId: string;
      /** Business-local "YYYY-MM-DD" the server persisted. */
      date: string;
      /** Business-local "HH:mm" the server persisted. */
      startTime: string;
      /** Server-derived endTime (startTime + the service's duration). */
      endTime: string;
    }
  | { success: false; code: RescheduleErrorCode; message: string };

/**
 * Smart Create Appointment flow (PROMPT-11 Steps 1–3 + PROMPT-12 Step 4 +
 * PROMPT-13 Step 5 + PROMPT-14 Step 6).
 *
 * The flow is 6 steps — العميل → الخدمة → التاريخ → الوقت → المراجعة
 * → التأكيد — all active in this release: Step 6 confirms the reviewed
 * details and creates the appointment through the existing
 * `createAppointment` write path. `BOOKING_FLOW_ACTIVE_STEPS` marks
 * the boundary so the progress indicator (and tests) share one source
 * of truth.
 */
export const BOOKING_FLOW_STEPS = [
  { label: "العميل" },
  { label: "الخدمة" },
  { label: "التاريخ" },
  { label: "الوقت" },
  { label: "المراجعة" },
  { label: "التأكيد" },
] as const;

export const BOOKING_FLOW_ACTIVE_STEPS = 6 as const;

/** Wizard screen — one per flow step. */
export type BookingFlowScreen =
  "customer" | "service" | "date" | "slot" | "review" | "confirm";

/**
 * Step 5 (المراجعة) slot-revalidation state. The review's primary
 * action re-checks the selected slot through the EXISTING availability
 * layer before the flow may continue; "verified" is a HAND-OFF to the
 * confirmation step, never a reservation — the write path's
 * transactional conflict check remains the final guard.
 */
export type ReviewCheckState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "failed" }
  | { status: "stale"; message: string }
  | { status: "verified" };

/**
 * Typed failure codes for `createAppointment` (PROMPT-14 Step 6) so
 * the confirmation step can react to domain failures honestly instead
 * of guessing from message strings: `SLOT_CONFLICT` returns the user
 * to Step 4 to pick another time; every other failure is reported as
 * retryable without leaving the flow.
 */
export type CreateAppointmentErrorCode =
  | "VALIDATION"
  | "NO_BUSINESS"
  | "CUSTOMER_NOT_FOUND"
  | "SERVICE_UNAVAILABLE"
  | "END_OF_DAY"
  | "SLOT_CONFLICT"
  | "PROVIDER_NOT_ELIGIBLE"
  | "NO_ELIGIBLE_PROVIDERS"
  | "PAST_TIME"
  | "DATE_OUT_OF_RANGE"
  | "FOLLOW_UP_NOT_PENDING"
  | "BUSINESS_CLOSED"
  | "OUTSIDE_WORKING_HOURS"
  | "CREATE_FAILED";

/**
 * `createAppointment` result contract: success carries the created
 * appointment's id AND its actual server-derived status (the canonical
 * status system — never client input); failures carry a typed code
 * plus an Arabic message.
 */
export type CreateAppointmentActionResult =
  | { success: true; appointmentId: string; status: AppointmentStatus }
  | { success: false; code: CreateAppointmentErrorCode; message: string };

/**
 * Step 6 (التأكيد) submission lifecycle, owned by the wizard
 * container. "success" is ONLY ever recorded from the server's own
 * result — the UI never claims an appointment exists before the write
 * path confirms it, and the wizard state is only cleared after
 * success is known.
 */
export type ConfirmSubmitState =
  | { status: "idle" }
  | { status: "submitting" }
  | {
      status: "success";
      appointmentId: string;
      appointmentStatus: AppointmentStatus;
    }
  | { status: "error"; code: CreateAppointmentErrorCode; message: string };

/**
 * Follow-up scheduling lifecycle after a server-confirmed creation
 * (B-07 §6), owned by the wizard container. A follow-up is an ORDINARY
 * appointment created through the SAME `createAppointment` write path
 * — there is no separate scheduling subsystem and no persisted
 * linkage (no recurrence engine in B-07).
 *
 * - `scheduling` — the relative choice was tapped; the original slot
 *   is being re-checked against the follow-up date, then created.
 * - `scheduled` — the follow-up WAS created; the id/status come only
 *   from the server's own result (chained follow-ups stay possible).
 * - `unavailable` — the original time is not free on the follow-up
 *   date; the wizard switches to availability-first slot selection for
 *   that date instead of booking an unavailable time.
 * - `error` — a non-conflict create failure; retryable in place.
 */
export type FollowUpState =
  | { status: "idle" }
  | { status: "scheduling" }
  | {
      status: "scheduled";
      appointmentId: string;
      appointmentStatus: AppointmentStatus;
    }
  | { status: "unavailable"; message: string }
  | { status: "error"; message: string };

/**
 * Step 4 (الوقت) selection — the typed value handed to the review step
 * (PROMPT-13) and the confirmation step (PROMPT-14). It mirrors the
 * appointment domain's wall-clock conventions exactly: business-local
 * "HH:mm" start/end, start + `Service.durationMinutes`.
 */
export type SelectedSlot = AvailabilitySlot;

/** Customer option for the booking flow (searchable by name/phone). */
export type BookingCustomerOption = {
  id: string;
  name: string;
  phone: string;
};

/**
 * Smart Context prefill (B-07 §A) — entry-context selections already
 * resolved against the actor's OWN Business server-side. A `null`
 * field means "not prefilled" (no entry context, or the supplied id
 * was foreign/invalid/inactive — the wizard asks for it normally).
 * The wizard never trusts client ids; this is the only prefill path.
 */
export type BookingContextPrefill = {
  customer: BookingCustomerOption | null;
  serviceId: string | null;
  providerId?: string | null;
  followUpContext?: {
    id: string;
    startDate: string | null;
    endDate: string | null;
  } | null;
};

export type ServiceReadinessStatus = "READY_TO_BOOK" | "SETUP_REQUIRED";

/** Active service option for the booking flow. */
export type BookingServiceOption = {
  id: string;
  name: string;
  durationMinutes: number;
  readinessStatus?: ServiceReadinessStatus;
  eligibleProviderCount?: number;
};

export type BookingCustomerSearchResult =
  | { success: true; customers: BookingCustomerOption[] }
  | { success: false; message: string };

/**
 * Availability result contract (PROMPT-10).
 *
 * One small typed contract answering: "For this Business, on this date,
 * for this active Service, which start times are actually bookable?"
 *
 * - `slots` are business-local wall-clock "HH:mm" start times — the
 *   exact format appointments persist (`@db.Time`) and the existing
 *   Create Appointment form consumes. Times are interpreted in the
 *   Business's stored timezone; the device/browser timezone is never a
 *   source of truth.
 * - Empty availability is EXPLICIT (`reason: NO_SLOTS`), never an
 *   empty array without explanation.
 * - Errors are typed codes with Arabic messages — no internal
 *   database details leak into the shape.
 * - The calculation is deterministic: repeated calls with the same
 *   persisted state produce the same result (no `Date.now()` in the
 *   slot-calculation path).
 */

/** A single bookable start time (business-local "HH:mm"). */
export type AvailabilitySlot = {
  /** Slot start time — "HH:mm" 24h, business-local wall clock. */
  startTime: string;
  /** Slot end time — start + Service.durationMinutes, "HH:mm". */
  endTime: string;
  /** Available provider IDs for this slot (when provider-scoped). */
  availableProviderIds?: string[];
};

export type AvailabilityData = {
  /** Requested business date ("YYYY-MM-DD"), echoed back verbatim. */
  date: string;
  /** Business timezone the times are interpreted in. */
  timezone: string;
  /** The service whose duration produced the slots. */
  serviceId: string;
  serviceDurationMinutes: number;
  /** Bookable start times, ascending, chronologically ordered. */
  slots: AvailabilitySlot[];
  /** Intervals blocked by existing appointments on this date */
  blockedIntervals?: Array<{
    startTime: string;
    endTime: string;
    providerId?: string | null;
  }>;
};

/** Why zero slots exist — present ONLY when `slots` is empty. */
export type AvailabilityNoSlotsReason =
  | "BUSINESS_CLOSED"
  | "SERVICE_TOO_LONG"
  | "FULLY_BOOKED"
  | "NO_ELIGIBLE_PROVIDERS";

export type AvailabilityErrorCode =
  | "INVALID_INPUT"
  | "FORBIDDEN"
  | "NO_BUSINESS"
  | "SERVICE_NOT_FOUND"
  | "SERVICE_INACTIVE"
  | "APPOINTMENT_NOT_ACTIVE"
  | "PROVIDER_NOT_ELIGIBLE";

export type AvailabilityResult =
  | {
      success: true;
      data: AvailabilityData;
      reason: AvailabilityNoSlotsReason | null;
    }
  | {
      success: false;
      error: { code: AvailabilityErrorCode; message: string };
    };

/**
 * Provider / Service Eligibility result contract (PROMPT-CORE-01).
 *
 * One small deterministic contract answering: "Which Providers are
 * eligible for this requested Service within the current Business /
 * operational scope?" — the source of truth for Provider eligibility
 * (relation-driven: ProviderService + ProviderBranch, never names or
 * AI text), and the first step of the any-provider flow (DECISIONS
 * #32): eligible Providers → later availability lookup → options.
 *
 * - `providers` carry only what a downstream Conversation/AI layer
 *   needs to identify an eligible Provider — no credentials, no auth
 *   fields, no unrelated profile data.
 * - `branchId` echoes the applied operational scope (null when the
 *   request had no Branch scope).
 * - The resolution is deterministic: repeated calls with the same
 *   persisted state produce the same result, so deterministic turns
 *   can avoid AI calls entirely.
 */

/** One eligible Provider — compact identity for downstream AI use. */
export type EligibleProvider = {
  /** The ProviderProfile id (the booking seam, DECISIONS #32). */
  providerId: string;
  /** Profile display name, falling back to the member's name. */
  displayName: string;
};

export type ProviderEligibilityData = {
  /** The requested Service the eligibility was resolved against. */
  serviceId: string;
  /** The applied Branch scope — null when the request had none. */
  branchId: string | null;
  /** Eligible Providers, stable order (creation, then id). */
  providers: EligibleProvider[];
};

export type ProviderEligibilityErrorCode =
  | "INVALID_INPUT"
  | "NO_BUSINESS"
  | "SERVICE_NOT_FOUND"
  | "SERVICE_INACTIVE"
  | "BRANCH_NOT_FOUND";

export type ProviderEligibilityResult =
  | { success: true; data: ProviderEligibilityData }
  | {
      success: false;
      error: { code: ProviderEligibilityErrorCode; message: string };
    };

/**
 * Any-Provider Booking Options result contract (PROMPT-CORE-02).
 *
 * One small deterministic contract answering: "Among the eligible
 * Providers (CORE-01), what are the best useful appointment options
 * available to the customer?" — consumed by the future
 * Conversation/AI layer (and any deterministic response template).
 *
 * - `options` are the ranked useful options (normally 2–3,
 *   `MAX_BOOKING_OPTIONS`): each carries only the Provider identity +
 *   its slot — no credentials, no auth fields, no unrelated profile
 *   data, no full availability list.
 * - `startAt`/`endAt` are business-local "YYYY-MM-DDTHH:mm" instants —
 *   the existing wall-clock slot semantics (start + Service
 *   durationMinutes) combined with the echoed business date; the
 *   booking write splits them back into date + "HH:mm".
 * - `preference` echoes the applied provider preference (`ANY` when no
 *   specific Provider was requested, `PROVIDER` otherwise).
 * - Empty options are EXPLICIT (`reason`), never an unexplained
 *   empty array.
 * - The resolution is deterministic: repeated calls with the same
 *   persisted state produce the same result, so deterministic turns
 *   can avoid AI calls entirely.
 */

/** The applied provider preference, echoed back. */
export type BookingOptionsPreference = "ANY" | "PROVIDER";

/**
 * How many options one result carries (PROMPT-CORE-02): a SMALL set —
 * the customer-decision-efficiency target (2–3). Shared by the
 * resolver and its checks as one source of truth.
 */
export const MAX_BOOKING_OPTIONS = 3 as const;

/** Why zero options exist — present ONLY when `options` is empty. */
export type BookingOptionsNoOptionsReason =
  | "NO_ELIGIBLE_PROVIDERS"
  | "BUSINESS_CLOSED"
  | "SERVICE_TOO_LONG"
  | "FULLY_BOOKED"
  | "NO_PERIOD_SLOTS";

/** One useful customer-facing option — compact identity + slot. */
export type BookingOption = {
  /** The ProviderProfile id (the booking seam, DECISIONS #32). */
  providerId: string;
  /** Profile display name, falling back to the member's name. */
  displayName: string;
  /** Slot start — business-local "YYYY-MM-DDTHH:mm". */
  startAt: string;
  /** Slot end — start + Service.durationMinutes. */
  endAt: string;
};

export type BookingOptionsData = {
  /** The requested Service the options were resolved against. */
  serviceId: string;
  /** The applied Branch scope — null when the request had none. */
  branchId: string | null;
  /** The requested business date ("YYYY-MM-DD"), echoed back. */
  date: string;
  /** Business timezone the times are interpreted in. */
  timezone: string;
  /** The applied provider preference. */
  preference: BookingOptionsPreference;
  /** Ranked useful options, ascending by start time. */
  options: BookingOption[];
  /** Total count of eligible options prior to max/limit truncation. */
  totalEligibleCount?: number;
  /** Whether the returned options were capped by the requested limit. */
  isCapped?: boolean;
};

export type BookingOptionsErrorCode =
  | "INVALID_INPUT"
  | "NO_BUSINESS"
  | "SERVICE_NOT_FOUND"
  | "SERVICE_INACTIVE"
  | "BRANCH_NOT_FOUND"
  | "PROVIDER_NOT_ELIGIBLE";

export type BookingOptionsResult =
  | {
      success: true;
      data: BookingOptionsData;
      reason: BookingOptionsNoOptionsReason | null;
    }
  | {
      success: false;
      error: { code: BookingOptionsErrorCode; message: string };
    };
