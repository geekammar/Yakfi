import {
  appointmentDateSchema,
  timeSchema,
  uuidSchema,
} from "@/lib/validation";

import { z } from "zod";

export const followUpStatusValues = [
  "PENDING",
  "SCHEDULED",
  "CANCELLED",
] as const;

export const followUpStatusSchema = z.enum(followUpStatusValues);

export const createFollowUpRequestSchema = z
  .object({
    customerId: uuidSchema,
    sourceAppointmentId: uuidSchema.nullish(),
    serviceId: uuidSchema.nullish(),
    preferredProviderId: uuidSchema.nullish(),
    type: z.enum(["flexible", "undated"]),
    startDate: appointmentDateSchema.nullish(),
    endDate: appointmentDateSchema.nullish(),
    notes: z.string().trim().max(2000, "الملاحظة طويلة جداً").nullish(),
  })
  .refine(
    (data) => {
      if (data.type === "flexible") {
        return (
          !!data.startDate && !!data.endDate && data.startDate <= data.endDate
        );
      }
      return true;
    },
    {
      message: "يجب تحديد تاريخ بداية ونهاية صحيحين للفترة المحددة",
      path: ["startDate"],
    },
  );

export const cancelFollowUpRequestSchema = z.object({
  id: uuidSchema,
});

export const convertFollowUpToAppointmentSchema = z.object({
  followUpId: uuidSchema,
  date: appointmentDateSchema,
  startTime: timeSchema,
  serviceId: uuidSchema.optional(),
  providerId: uuidSchema.optional(),
  notes: z.string().trim().max(2000, "الملاحظة طويلة جداً").optional(),
});

export type CreateFollowUpRequestInput = z.infer<
  typeof createFollowUpRequestSchema
>;
export type CancelFollowUpRequestInput = z.infer<
  typeof cancelFollowUpRequestSchema
>;
export type ConvertFollowUpToAppointmentInput = z.infer<
  typeof convertFollowUpToAppointmentSchema
>;
