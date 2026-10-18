import {
  appointmentDateSchema,
  appointmentStatusValues,
  timeSchema,
  uuidSchema,
} from "@/lib/validation";

import { z } from "zod";

export const agendaStatusSchema = z.enum(appointmentStatusValues);

export const createAppointmentFormSchema = z.object({
  customerId: uuidSchema,
  serviceId: uuidSchema,
  providerId: uuidSchema.optional(),
  date: appointmentDateSchema,
  startTime: timeSchema,
  notes: z.string().trim().max(2000, "الملاحظة طويلة جداً"),
  followUpRequestId: uuidSchema.optional(),
});

export const rescheduleAppointmentSchema = z.object({
  id: uuidSchema,
  date: appointmentDateSchema,
  startTime: timeSchema,
});

export const appointmentStatusActionSchema = z.object({
  id: uuidSchema,
  status: z.enum(["CONFIRMED", "CANCELLED", "COMPLETED", "NO_SHOW"]),
});

export type CreateAppointmentFormInput = z.infer<
  typeof createAppointmentFormSchema
>;
export type RescheduleAppointmentInput = z.infer<
  typeof rescheduleAppointmentSchema
>;
