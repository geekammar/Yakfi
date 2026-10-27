/**
 * Deterministic Exact-Time Availability & Alternatives Resolver
 * (PROMPT-EXACT-TIME).
 *
 * Responsibilities:
 * - Checks ACTUAL domain availability for a customer-requested exact time,
 *   including times absent from the initial top-N displayed slots.
 * - Respects business timezone, working hours, service duration, breaks/slot grid,
 *   provider eligibility, branch, calendar conflicts, and past-time rules.
 * - When requested time is unavailable, answers directly and offers up to 3
 *   genuinely bookable nearby alternatives on the SAME day and with the SAME provider/service scope.
 * - Deterministic tie-breaking for alternatives: temporal distance (|t - t_req|),
 *   then earlier start time, then stable provider order.
 * - Read-only: creates ZERO appointments and NEVER silently books an alternative.
 */

import {
  filterConflictingSlots,
  generateCandidateSlots,
  resolveWorkingDay,
  weekdayOf,
} from "@/features/appointments/server/availability-service";
import type {
  BookingOptionsServiceDeps,
  RankedBookingPair,
} from "@/features/appointments/server/booking-options-service";
import { resolveEligibleProviders } from "@/features/appointments/server/provider-eligibility-service";
import { toMinutes } from "@/lib/scheduling/slot-grid";

export type ExactTimeUnavailabilityReason =
  | "PAST_TIME"
  | "BUSINESS_CLOSED"
  | "OUTSIDE_HOURS"
  | "SERVICE_TOO_LONG"
  | "SLOT_GRID_MISMATCH"
  | "CONFLICT"
  | "NO_ELIGIBLE_PROVIDERS"
  | "FULLY_BOOKED"
  | "TECHNICAL_FAILURE";

export type ExactTimeEvaluationResult = {
  readonly isAvailable: boolean;
  readonly unavailabilityReason?: ExactTimeUnavailabilityReason;
  readonly matchedSlot?: RankedBookingPair;
  readonly allAvailableSlots: readonly RankedBookingPair[];
  readonly alternatives: readonly RankedBookingPair[];
  readonly serviceName: string;
  readonly serviceDurationMinutes: number;
  readonly slotDurationMinutes?: number;
  readonly workingHours?: { readonly open: string; readonly close: string };
};

/**
 * Format a 24-hour "HH:mm" time string into human-friendly Egyptian Arabic.
 * e.g. "17:00" -> "5:00 مساءً", "13:00" -> "1:00 مساءً", "09:30" -> "9:30 صباحاً", "12:00" -> "12:00 ظهراً"
 */
export function formatTimeArabic(time: string): string {
  const [hStr, mStr] = time.split(":");
  const h = parseInt(hStr ?? "0", 10);
  const m = mStr ?? "00";
  const minutePart = m === "00" ? ":00" : `:${m}`;
  if (h === 0) return `12${minutePart} منتصف الليل`;
  if (h < 12) return `${h}${minutePart} صباحاً`;
  if (h === 12) return `12${minutePart} ظهراً`;
  return `${h - 12}${minutePart} مساءً`;
}

/**
 * Deterministic ranking of alternative slots by temporal distance to requested time.
 * Tie-breaking:
 * 1. |t - t_req| ascending
 * 2. startTime ascending (earlier slot wins tie)
 * 3. providerOrder ascending
 */
export function rankAlternativesByTemporalDistance(
  slots: readonly RankedBookingPair[],
  targetTime: string,
  max: number = 3,
): RankedBookingPair[] {
  const targetMin = toMinutes(targetTime);
  const sorted = [...slots].sort((a, b) => {
    const distA = Math.abs(toMinutes(a.startTime) - targetMin);
    const distB = Math.abs(toMinutes(b.startTime) - targetMin);
    if (distA !== distB) return distA - distB;
    if (a.startTime !== b.startTime) {
      return a.startTime < b.startTime ? -1 : 1;
    }
    return a.providerOrder - b.providerOrder;
  });

  // Unique by start time + provider to avoid duplicates
  const seen = new Set<string>();
  const picked: RankedBookingPair[] = [];
  for (const slot of sorted) {
    if (picked.length >= max) break;
    const key = `${slot.providerId}:${slot.startTime}`;
    if (!seen.has(key)) {
      seen.add(key);
      picked.push(slot);
    }
  }
  return picked;
}

/**
 * Check actual domain availability for a requested exact time and compute honest alternatives.
 */
export async function evaluateExactTimeAvailability(
  deps: BookingOptionsServiceDeps,
  actor: { businessId: string; userId: string },
  params: {
    serviceId: string;
    branchId?: string | null;
    providerId?: string | null;
    date: string;
    requestedTime: string; // HH:mm
    now: Date;
    businessTimezone: string;
  },
): Promise<ExactTimeEvaluationResult> {
  const {
    serviceId,
    branchId,
    providerId,
    date,
    requestedTime,
    now,
    businessTimezone,
  } = params;

  // 1. Eligibility
  const eligibility = await resolveEligibleProviders(
    deps.eligibility,
    { businessId: actor.businessId },
    { serviceId, ...(branchId ? { branchId } : {}) },
  );
  if (!eligibility.success || eligibility.data.providers.length === 0) {
    return {
      isAvailable: false,
      unavailabilityReason: "NO_ELIGIBLE_PROVIDERS",
      allAvailableSlots: [],
      alternatives: [],
      serviceName: "الخدمة المطلوبة",
      serviceDurationMinutes: 30,
    };
  }

  const [business, service] = await Promise.all([
    deps.businessRepository.findById(actor.businessId),
    deps.serviceRepository.findById(serviceId),
  ]);

  if (!business || !service || !service.isActive) {
    return {
      isAvailable: false,
      unavailabilityReason: "NO_ELIGIBLE_PROVIDERS",
      allAvailableSlots: [],
      alternatives: [],
      serviceName: service?.name ?? "الخدمة المطلوبة",
      serviceDurationMinutes: service?.durationMinutes ?? 30,
    };
  }

  const eligible = eligibility.data.providers;
  const scoped = providerId
    ? eligible.filter((p) => p.providerId === providerId)
    : eligible;

  if (providerId && scoped.length === 0) {
    return {
      isAvailable: false,
      unavailabilityReason: "NO_ELIGIBLE_PROVIDERS",
      allAvailableSlots: [],
      alternatives: [],
      serviceName: service.name,
      serviceDurationMinutes: service.durationMinutes,
    };
  }

  // 2. Working Day
  const workingDay = resolveWorkingDay(business, weekdayOf(date));
  if (!workingDay) {
    return {
      isAvailable: false,
      unavailabilityReason: "BUSINESS_CLOSED",
      allAvailableSlots: [],
      alternatives: [],
      serviceName: service.name,
      serviceDurationMinutes: service.durationMinutes,
    };
  }

  const openHoursStr = `${String(Math.floor(workingDay.openMinutes / 60)).padStart(2, "0")}:${String(workingDay.openMinutes % 60).padStart(2, "0")}`;
  const closeHoursStr = `${String(Math.floor(workingDay.closeMinutes / 60)).padStart(2, "0")}:${String(workingDay.closeMinutes % 60).padStart(2, "0")}`;
  const workingHours = { open: openHoursStr, close: closeHoursStr };

  const reqMin = toMinutes(requestedTime);
  let preAvailabilityReason: ExactTimeUnavailabilityReason | undefined;

  // Check hours boundary
  if (reqMin < workingDay.openMinutes || reqMin >= workingDay.closeMinutes) {
    preAvailabilityReason = "OUTSIDE_HOURS";
  } else if (reqMin + service.durationMinutes > workingDay.closeMinutes) {
    preAvailabilityReason = "SERVICE_TOO_LONG";
  }

  // Check past time relative to business timezone
  const todayFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: businessTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const todayIso = todayFormatter.format(now);
  if (date === todayIso) {
    const timeFormatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: businessTimezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const currentNowTime = timeFormatter.format(now);
    if (requestedTime <= currentNowTime) {
      preAvailabilityReason = "PAST_TIME";
    }
  }

  // 3. Generate candidate grid
  const candidates = generateCandidateSlots({
    openMinutes: workingDay.openMinutes,
    closeMinutes: workingDay.closeMinutes,
    durationMinutes: service.durationMinutes,
    slotDurationMinutes: business.slotDurationMinutes,
  });

  const slotGridMatch = candidates.some((c) => c.startTime === requestedTime);
  if (!preAvailabilityReason && !slotGridMatch) {
    preAvailabilityReason = "SLOT_GRID_MISMATCH";
  }

  // 4. Provider seams & conflicts
  const seams = await deps.providerRepository.listAssignmentSeams(
    actor.businessId,
    scoped.map((p) => p.providerId),
  );
  const seamByProvider = new Map(seams.map((s) => [s.providerId, s.userId]));

  const assigneeIds = [
    ...new Set(
      scoped.map((p) => seamByProvider.get(p.providerId) || p.providerId),
    ),
  ];
  const blockingRows = await deps.appointmentRepository.listBlockingByAssignees(
    actor.businessId,
    date,
    assigneeIds,
  );
  const blockingByAssignee = new Map<
    string,
    Array<{ startTime: string; endTime: string }>
  >();
  for (const row of blockingRows) {
    const blocks = blockingByAssignee.get(row.assignedUserId) ?? [];
    blocks.push({ startTime: row.startTime, endTime: row.endTime });
    blockingByAssignee.set(row.assignedUserId, blocks);
  }

  // Collect all available pairs
  const pairs: RankedBookingPair[] = [];
  scoped.forEach((provider, providerOrder) => {
    const assigneeId =
      seamByProvider.get(provider.providerId) || provider.providerId;
    if (!assigneeId) return;
    const available = filterConflictingSlots(
      candidates,
      blockingByAssignee.get(assigneeId) ?? [],
    );
    for (const slot of available) {
      pairs.push({
        providerOrder,
        providerId: provider.providerId,
        displayName: provider.displayName,
        startTime: slot.startTime,
        endTime: slot.endTime,
      });
    }
  });

  // Filter elapsed slots if date is today
  let bookablePairs = pairs;
  if (date === todayIso) {
    const timeFormatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: businessTimezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const currentNowTime = timeFormatter.format(now);
    bookablePairs = pairs.filter((p) => p.startTime > currentNowTime);
  }

  // Check if requested time is among bookable pairs
  const matched = preAvailabilityReason
    ? undefined
    : bookablePairs.find((p) => p.startTime === requestedTime);

  if (matched) {
    return {
      isAvailable: true,
      matchedSlot: matched,
      allAvailableSlots: bookablePairs,
      alternatives: [],
      serviceName: service.name,
      serviceDurationMinutes: service.durationMinutes,
      slotDurationMinutes: business.slotDurationMinutes,
      workingHours,
    };
  }

  // Unavailable: derive reason and alternatives truthfully
  let unavailabilityReason: ExactTimeUnavailabilityReason;
  if (preAvailabilityReason) {
    unavailabilityReason = preAvailabilityReason;
  } else if (bookablePairs.length === 0) {
    unavailabilityReason = "FULLY_BOOKED";
  } else {
    // Check if an actual booking conflict blocked this candidate time
    const hasActualConflict = blockingRows.some(
      (b) => b.startTime <= requestedTime && b.endTime > requestedTime,
    );
    unavailabilityReason = hasActualConflict ? "CONFLICT" : "FULLY_BOOKED";
  }

  const alternatives = rankAlternativesByTemporalDistance(
    bookablePairs,
    requestedTime,
    3,
  );

  return {
    isAvailable: false,
    unavailabilityReason,
    allAvailableSlots: bookablePairs,
    alternatives,
    serviceName: service.name,
    serviceDurationMinutes: service.durationMinutes,
    slotDurationMinutes: business.slotDurationMinutes,
    workingHours,
  };
}

/**
 * Compose an honest, direct Arabic answer explaining availability and presenting alternatives.
 */
export function composeExactTimeResponse(params: {
  evaluation: ExactTimeEvaluationResult;
  date: string;
  requestedTime: string;
  intent: "AVAILABILITY" | "BOOKING" | string;
}): { message: string; slotsToOffer: readonly RankedBookingPair[] } {
  const { evaluation, date, requestedTime, intent } = params;
  const timeArabic = formatTimeArabic(requestedTime);
  const serviceName = evaluation.serviceName;

  if (evaluation.isAvailable && evaluation.matchedSlot) {
    const slotsToOffer = [evaluation.matchedSlot];
    const prefix =
      intent === "AVAILABILITY"
        ? `نعم، موعد الساعة ${timeArabic} متاح يوم ${date} لخدمة "${serviceName}".`
        : `موعد الساعة ${timeArabic} متاح يوم ${date} لخدمة "${serviceName}".`;

    const message = [
      prefix,
      "إليك خيار الحجز:",
      `1️⃣ الساعة ${timeArabic}`,
      "(يمكنك الرد برقم 1 لتأكيد الحجز، أو كتابة أي وقت آخر)",
    ].join("\n");

    return { message, slotsToOffer };
  }

  // Unavailable path
  let explanation = `عذراً، موعد الساعة ${timeArabic} غير متاح يوم ${date}.`;
  switch (evaluation.unavailabilityReason) {
    case "PAST_TIME":
      explanation = `عذراً، موعد الساعة ${timeArabic} قد مضى اليوم (${date}) — يرجى اختيار وقت قادم.`;
      break;
    case "OUTSIDE_HOURS":
      if (evaluation.workingHours) {
        explanation = `عذراً، موعد الساعة ${timeArabic} خارج أوقات العمل الرسمية يوم ${date} (أوقات العمل من ${formatTimeArabic(evaluation.workingHours.open)} إلى ${formatTimeArabic(evaluation.workingHours.close)}).`;
      } else {
        explanation = `عذراً، موعد الساعة ${timeArabic} خارج أوقات العمل الرسمية يوم ${date}.`;
      }
      break;
    case "SERVICE_TOO_LONG":
      if (evaluation.workingHours) {
        explanation = `عذراً، موعد الساعة ${timeArabic} غير متاح لأن مدة الخدمة (${evaluation.serviceDurationMinutes} دقيقة) تتجاوز موعد إغلاق المنشأة الساعة ${formatTimeArabic(evaluation.workingHours.close)}.`;
      } else {
        explanation = `عذراً، موعد الساعة ${timeArabic} غير متاح لتجاوزه ساعات العمل.`;
      }
      break;
    case "BUSINESS_CLOSED":
      explanation = `المنشأة مغلقة يوم ${date} — يرجى اختيار تاريخ آخر.`;
      break;
    case "SLOT_GRID_MISMATCH":
      explanation = `عذراً، موعد الساعة ${timeArabic} غير متاح (لا يتوافق مع فترات جدول المواعيد المحددة (${evaluation.slotDurationMinutes ?? 30} دقيقة)) يوم ${date}.`;
      break;
    case "CONFLICT":
      explanation = `عذراً، موعد الساعة ${timeArabic} غير متاح يوم ${date} (محجوز مسبقاً).`;
      break;
    case "FULLY_BOOKED":
      explanation = `عذراً، موعد الساعة ${timeArabic} غير متاح وجميع المواعيد محجوزة بالكامل يوم ${date}.`;
      break;
    case "NO_ELIGIBLE_PROVIDERS":
      explanation = `لا يوجد مزود متاح لهذه الخدمة يوم ${date}.`;
      break;
    case "TECHNICAL_FAILURE":
      explanation = `تعذر التحقق من توفر موعد الساعة ${timeArabic} حالياً بسبب خلل فني مؤقت.`;
      break;
  }

  const alternatives = evaluation.alternatives;
  if (alternatives.length > 0) {
    const lines = [explanation, "إليك أقرب المواعيد المتاحة في نفس اليوم:"];
    for (let i = 0; i < alternatives.length; i++) {
      const alt = alternatives[i]!;
      lines.push(`${i + 1}️⃣ الساعة ${formatTimeArabic(alt.startTime)}`);
    }
    lines.push("(يمكنك اختيار موعد بالرقم أو كتابة موعد آخر يناسبك)");
    return {
      message: lines.join("\n"),
      slotsToOffer: alternatives,
    };
  }

  return {
    message: `${explanation}\nولا تتوفر مواعيد أخرى متاحة في هذا اليوم — يرجى اختيار يوم آخر.`,
    slotsToOffer: [],
  };
}
