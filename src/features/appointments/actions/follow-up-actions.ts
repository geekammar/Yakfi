"use server";

import {
  cancelFollowUpRequestSchema,
  convertFollowUpToAppointmentSchema,
  createFollowUpRequestSchema,
} from "@/features/appointments/schemas/follow-up-schema";
import {
  createAppointmentRecord,
  defaultAppointmentCreateServiceDeps,
  type AppointmentCreateActor,
} from "@/features/appointments/server/appointment-create-service";
import type { CreateAppointmentActionResult } from "@/features/appointments/types";
import { requireUser } from "@/server/auth/guards";
import {
  customerRepository,
  followUpRequestRepository,
  providerRepository,
  serviceRepository,
  userRepository,
} from "@/server/repositories";
import type { FollowUpRequestWithRelations } from "@/types/domain";

import { revalidatePath } from "next/cache";

export type FollowUpActionResult =
  | { success: true; followUpRequestId: string; message: string }
  | { success: false; message: string };

export async function createFollowUpRequest(
  input: unknown,
): Promise<FollowUpActionResult> {
  const session = await requireUser();
  if (!session.user.businessId) {
    return { success: false, message: "أكمل إعداد المنشأة أولاً" };
  }

  const parsed = createFollowUpRequestSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      message:
        parsed.error.issues[0]?.message ?? "بيانات طلب المتابعة غير صالحة",
    };
  }

  const {
    customerId,
    sourceAppointmentId,
    serviceId,
    preferredProviderId,
    type,
    startDate,
    endDate,
    notes,
  } = parsed.data;

  // Validate customer belongs to authenticated tenant
  const customer = await customerRepository.findById(customerId);
  if (!customer || customer.businessId !== session.user.businessId) {
    return { success: false, message: "العميل غير موجود" };
  }

  // Validate service belongs to tenant if specified
  if (serviceId) {
    const service = await serviceRepository.findById(serviceId);
    if (!service || service.businessId !== session.user.businessId) {
      return { success: false, message: "الخدمة المحددة غير صالحة" };
    }
  }

  // Validate provider belongs to tenant if specified
  if (preferredProviderId) {
    const provider = await providerRepository.findProfileWithinBusiness(
      preferredProviderId,
      session.user.businessId,
    );
    if (!provider) {
      return { success: false, message: "مقدم الخدمة المحدد غير متاح" };
    }
  }

  const request = await followUpRequestRepository.create({
    businessId: session.user.businessId,
    customerId,
    sourceAppointmentId: sourceAppointmentId ?? null,
    serviceId: serviceId ?? null,
    preferredProviderId: preferredProviderId ?? null,
    createdById: session.user.id,
    startDate: type === "flexible" ? startDate : null,
    endDate: type === "flexible" ? endDate : null,
    notes: notes ?? null,
  });

  revalidatePath("/appointments");
  if (sourceAppointmentId) {
    revalidatePath(`/appointments/${sourceAppointmentId}`);
  }

  return {
    success: true,
    followUpRequestId: request.id,
    message: "تم حفظ طلب المتابعة. لم يتم حجز موعد بعد.",
  };
}

export async function cancelFollowUpRequest(
  input: unknown,
): Promise<{ success: boolean; message: string }> {
  const session = await requireUser();
  if (!session.user.businessId) {
    return { success: false, message: "غير مصرح" };
  }

  const parsed = cancelFollowUpRequestSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, message: "معرف طلب المتابعة غير صالح" };
  }

  const existing = await followUpRequestRepository.findById(
    parsed.data.id,
    session.user.businessId,
  );
  if (!existing) {
    return { success: false, message: "طلب المتابعة غير موجود" };
  }

  if (existing.status !== "PENDING") {
    return { success: false, message: "لا يمكن إلغاء هذا الطلب" };
  }

  await followUpRequestRepository.updateStatus(
    existing.id,
    session.user.businessId,
    "CANCELLED",
  );

  revalidatePath("/appointments");
  if (existing.sourceAppointmentId) {
    revalidatePath(`/appointments/${existing.sourceAppointmentId}`);
  }

  return { success: true, message: "تم إلغاء طلب المتابعة بنجاح" };
}

export async function convertFollowUpToAppointmentAction(
  input: unknown,
): Promise<CreateAppointmentActionResult> {
  const session = await requireUser();
  const user = await userRepository.findById(session.user.id);
  if (!user?.businessId) {
    return {
      success: false,
      code: "NO_BUSINESS",
      message: "أكمل إعداد المنشأة أولاً",
    };
  }

  const parsed = convertFollowUpToAppointmentSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      code: "VALIDATION",
      message: parsed.error.issues[0]?.message ?? "بيانات الحجز غير صالحة",
    };
  }

  const followUp = await followUpRequestRepository.findById(
    parsed.data.followUpId,
    user.businessId,
  );
  if (!followUp || followUp.status !== "PENDING") {
    return {
      success: false,
      code: "FOLLOW_UP_NOT_PENDING",
      message: "طلب المتابعة غير متاح أو تم حجزه مسبقاً",
    };
  }

  const serviceId = parsed.data.serviceId || followUp.serviceId;
  if (!serviceId) {
    return {
      success: false,
      code: "VALIDATION",
      message: "يجب اختيار خدمة لإتمام حجز المتابعة",
    };
  }

  const actor: AppointmentCreateActor = {
    userId: session.user.id,
    role: user.role ?? "STAFF",
    businessId: user.businessId,
  };

  const createInput = {
    customerId: followUp.customerId,
    serviceId,
    providerId:
      parsed.data.providerId || followUp.preferredProviderId || undefined,
    date: parsed.data.date,
    startTime: parsed.data.startTime,
    notes: parsed.data.notes || followUp.notes || "",
    followUpRequestId: followUp.id,
  };

  const result = await createAppointmentRecord(
    defaultAppointmentCreateServiceDeps,
    actor,
    createInput,
  );

  if (result.success) {
    revalidatePath("/appointments");
    revalidatePath(`/appointments/${result.appointmentId}`);
    if (followUp.sourceAppointmentId) {
      revalidatePath(`/appointments/${followUp.sourceAppointmentId}`);
    }
  }

  return result;
}

export async function getPendingFollowUpRequests(): Promise<
  FollowUpRequestWithRelations[]
> {
  const session = await requireUser();
  if (!session.user.businessId) return [];
  return followUpRequestRepository.listByBusiness(session.user.businessId, {
    status: "PENDING",
  });
}

export async function getFollowUpRequestsForAppointment(
  sourceAppointmentId: string,
): Promise<FollowUpRequestWithRelations[]> {
  const session = await requireUser();
  if (!session.user.businessId) return [];
  return followUpRequestRepository.listBySourceAppointment(
    session.user.businessId,
    sourceAppointmentId,
  );
}
