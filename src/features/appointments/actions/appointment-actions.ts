"use server";

import {
  appointmentStatusActionSchema,
  correctPerformedServiceSchema,
  rescheduleAppointmentSchema,
} from "@/features/appointments/schemas/appointment-schema";
import {
  addMinutes,
  createAppointmentRecord,
  defaultAppointmentCreateServiceDeps,
  type AppointmentCreateActor,
} from "@/features/appointments/server/appointment-create-service";
import type {
  AppointmentActionResult,
  AppointmentAgendaItem,
  CorrectPerformedServiceActionResult,
  CreateAppointmentActionResult,
  RescheduleAppointmentActionResult,
} from "@/features/appointments/types";
import { parseAppointmentEndUtc } from "@/lib/scheduling/reminder-time";
import { requireUser } from "@/server/auth/guards";
import {
  appointmentRepository,
  businessRepository,
  serviceRepository,
  userRepository,
} from "@/server/repositories";

import { revalidatePath } from "next/cache";

function storedDuration(startTime: Date, endTime: Date) {
  return Math.round((endTime.getTime() - startTime.getTime()) / 60_000);
}

async function currentUser() {
  const session = await requireUser();
  return userRepository.findById(session.user.id);
}

function failure(message: string): AppointmentActionResult {
  return { success: false, message };
}

function refreshAppointments(id?: string) {
  revalidatePath("/appointments");
  if (id) revalidatePath(`/appointments/${id}`);
  revalidatePath("/");
}

/**
 * THE canonical appointment-creation write path (Smart Create Step 6,
 * PROMPT-14, is its first UI consumer). Thin session wrapper only:
 * the actor is derived from the authenticated session + DB user (the
 * Business is ALWAYS the actor's own — a client-provided businessId
 * or role can never override it), and every rule (Zod boundary
 * validation, tenant isolation, active-service check, server-derived
 * initial status, transactional conflict check) lives in
 * `createAppointmentRecord`. Failures are typed codes with Arabic
 * messages; success carries the created appointment's id and its
 * ACTUAL server-derived status.
 */
export async function createAppointment(
  input: unknown,
): Promise<CreateAppointmentActionResult> {
  const session = await requireUser();
  const user = await userRepository.findById(session.user.id);
  const actor: AppointmentCreateActor = {
    userId: session.user.id,
    // No user record (deleted mid-session) → least privilege: no
    // business, so no appointment can ever be created.
    role: user?.role ?? "STAFF",
    businessId: user?.businessId ?? null,
  };
  const result = await createAppointmentRecord(
    defaultAppointmentCreateServiceDeps,
    actor,
    input,
  );
  if (result.success) refreshAppointments(result.appointmentId);
  return result;
}

export async function updateAppointmentStatus(
  input: unknown,
): Promise<AppointmentActionResult> {
  const parsed = appointmentStatusActionSchema.safeParse(input);
  if (!parsed.success) return failure("الإجراء غير صالح");
  const user = await currentUser();
  if (!user?.businessId) return failure("لا يمكن الوصول إلى الموعد");
  const appointment = await appointmentRepository.findById(parsed.data.id);
  if (!appointment || appointment.businessId !== user.businessId) {
    return failure("الموعد غير موجود");
  }

  const allowedTransitions = {
    PENDING: ["CONFIRMED", "CANCELLED"],
    CONFIRMED: ["CANCELLED", "COMPLETED", "NO_SHOW"],
    CANCELLED: [],
    COMPLETED: [],
    NO_SHOW: [],
  } as const;
  if (
    !(allowedTransitions[appointment.status] as readonly string[]).includes(
      parsed.data.status,
    )
  ) {
    return failure("لا يمكن تطبيق هذا الإجراء على حالة الموعد الحالية");
  }

  try {
    await appointmentRepository.setStatus(appointment.id, parsed.data.status);
    refreshAppointments(appointment.id);
    return { success: true };
  } catch {
    return failure("تعذر تحديث حالة الموعد");
  }
}

export async function rescheduleAppointment(
  input: unknown,
): Promise<RescheduleAppointmentActionResult> {
  const parsed = rescheduleAppointmentSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      code: "VALIDATION",
      message: parsed.error.issues[0]?.message ?? "بيانات الموعد غير صالحة",
    };
  }
  const user = await currentUser();
  if (!user?.businessId) {
    return {
      success: false,
      code: "NOT_FOUND",
      message: "لا يمكن الوصول إلى الموعد",
    };
  }
  const appointment = await appointmentRepository.findById(parsed.data.id);
  if (!appointment || appointment.businessId !== user.businessId) {
    return { success: false, code: "NOT_FOUND", message: "الموعد غير موجود" };
  }
  if (appointment.status !== "PENDING" && appointment.status !== "CONFIRMED") {
    return {
      success: false,
      code: "APPOINTMENT_NOT_ACTIVE",
      message: "لا يمكن إعادة جدولة موعد منتهٍ",
    };
  }

  const duration = storedDuration(appointment.startTime, appointment.endTime);
  const endTime = addMinutes(parsed.data.startTime, duration);
  if (!endTime) {
    return {
      success: false,
      code: "END_OF_DAY",
      message: "الموعد يتجاوز نهاية اليوم",
    };
  }
  try {
    const updated = await appointmentRepository.rescheduleWithConflictCheck(
      appointment.id,
      {
        date: parsed.data.date,
        startTime: parsed.data.startTime,
        endTime,
      },
    );
    if (!updated) {
      return {
        success: false,
        code: "SLOT_CONFLICT",
        message: "يوجد موعد آخر متداخل في هذا الوقت",
      };
    }
    refreshAppointments(appointment.id);
    // The SERVER's own row is the only source of truth for what was
    // persisted — the client never recomputes endTime or a date from
    // its own inputs (no duplicated domain math on the write result).
    return {
      success: true,
      appointmentId: updated.id,
      date: parsed.data.date,
      startTime: parsed.data.startTime,
      endTime,
    };
  } catch {
    return {
      success: false,
      code: "RESCHEDULE_FAILED",
      message: "تعذر إعادة جدولة الموعد",
    };
  }
}

export async function searchAppointmentsAction(query: string): Promise<{
  success: boolean;
  appointments: AppointmentAgendaItem[];
  message?: string;
}> {
  try {
    const user = await currentUser();
    if (!user?.businessId) {
      return {
        success: false,
        appointments: [],
        message: "لا يمكن الوصول للمواعيد",
      };
    }
    const { searchBusinessAppointments } =
      await import("@/features/appointments/server/appointment-queries");
    const appointments = await searchBusinessAppointments(
      user.businessId,
      query,
    );
    return { success: true, appointments };
  } catch {
    return {
      success: false,
      appointments: [],
      message: "تعذر البحث عن المواعيد",
    };
  }
}

/**
 * Retrospective post-visit performed service correction (CONV-PLAY-01).
 *
 * Rules:
 * 1. Admin/Staff authorized within tenant boundary.
 * 2. Original scheduled end time must have passed (`now >= endTime`).
 * 3. Appointment status must be COMPLETED.
 * 4. Original booked service (`serviceId`), date, startTime, endTime, and status are preserved.
 * 5. No availability search, no conflict calculation, no slot alterations.
 * 6. Audit history recorded on the appointment.
 * 7. Optimistic concurrency check protects against concurrent overwrites.
 */
export async function correctPerformedServiceAction(
  input: unknown,
): Promise<CorrectPerformedServiceActionResult> {
  const parsed = correctPerformedServiceSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      code: "VALIDATION",
      message:
        parsed.error.issues[0]?.message ?? "بيانات تصحيح الخدمة غير صالحة",
    };
  }

  const user = await currentUser();
  if (!user?.businessId) {
    return {
      success: false,
      code: "UNAUTHORIZED",
      message: "غير مصرح لك بإجراء هذا التعديل",
    };
  }

  const [appointment, business] = await Promise.all([
    appointmentRepository.findWithRelationsByBusiness(
      parsed.data.appointmentId,
      user.businessId,
    ),
    businessRepository.findById(user.businessId),
  ]);

  if (!appointment) {
    return {
      success: false,
      code: "NOT_FOUND",
      message: "الموعد غير موجود",
    };
  }

  // 1. Validate visit completion
  if (appointment.status !== "COMPLETED") {
    return {
      success: false,
      code: "NOT_COMPLETED",
      message: "تصحيح الخدمة المنفذة متاح فقط للمواعيد المكتملة",
    };
  }

  // 2. Validate scheduled end time is in the past
  const dateIso =
    appointment.date instanceof Date
      ? appointment.date.toISOString().slice(0, 10)
      : String(appointment.date).slice(0, 10);
  const endTimeStr =
    appointment.endTime instanceof Date
      ? appointment.endTime.toISOString().slice(11, 16)
      : String(appointment.endTime).includes("T")
        ? String(appointment.endTime).slice(11, 16)
        : String(appointment.endTime).slice(0, 5);

  const endUtc = parseAppointmentEndUtc({
    date: dateIso,
    endTime: endTimeStr,
    timezone: business?.timezone ?? "Asia/Riyadh",
  });

  if (Date.now() < endUtc.getTime()) {
    return {
      success: false,
      code: "NOT_PASSED_YET",
      message:
        "لا يمكن تسجيل أو تصحيح الخدمة المنفذة إلا بعد انتهاء وقت الموعد المجدول",
    };
  }

  // 3. Concurrency check
  if (
    parsed.data.expectedVersion &&
    appointment.updatedAt &&
    appointment.updatedAt.toISOString() !== parsed.data.expectedVersion
  ) {
    return {
      success: false,
      code: "CONCURRENCY_CONFLICT",
      message:
        "تم تعديل الموعد بواسطة مستخدم آخر. يرجى تحديث الصفحة والمحاولة مجدداً.",
    };
  }

  // 4. Validate performed service
  const targetService = await serviceRepository.findByIdWithinBusiness(
    parsed.data.performedServiceId,
    user.businessId,
  );
  if (!targetService || !targetService.isActive || targetService.deletedAt) {
    return {
      success: false,
      code: "INVALID_SERVICE",
      message: "الخدمة المحددة غير صالحة أو غير مفعّلة في المنشأة",
    };
  }

  // 5. Build audit entry
  const previousServiceId =
    appointment.performedServiceId ?? appointment.serviceId;
  const previousServiceName =
    appointment.performedService?.name ?? appointment.service?.name ?? null;

  const historyEntry = {
    previousServiceId,
    previousServiceName,
    newServiceId: targetService.id,
    newServiceName: targetService.name,
    correctedAt: new Date().toISOString(),
    correctedById: user.id,
    correctedByName: user.name || "عضو الفريق",
    notes: parsed.data.notes || null,
  };

  try {
    const updated = await appointmentRepository.correctPerformedService(
      appointment.id,
      user.businessId,
      {
        performedServiceId: targetService.id,
        correctedById: user.id,
        historyEntry,
      },
    );

    if (!updated) {
      return {
        success: false,
        code: "UPDATE_FAILED",
        message: "تعذر تحديث الخدمة المنفذة",
      };
    }

    refreshAppointments(appointment.id);

    return {
      success: true,
      appointmentId: updated.id,
      performedServiceId: targetService.id,
      performedServiceName: targetService.name,
      serviceCorrectedAt:
        updated.serviceCorrectedAt?.toISOString() ?? new Date().toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    };
  } catch {
    return {
      success: false,
      code: "UPDATE_FAILED",
      message: "تعذر تحديث الخدمة المنفذة",
    };
  }
}
