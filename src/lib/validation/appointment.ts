import { timeSchema, uuidSchema } from "./common";
import { z } from "zod";

export const appointmentStatusValues = [
  "PENDING",
  "CONFIRMED",
  "CANCELLED",
  "NO_SHOW",
  "COMPLETED",
] as const;

/** ISO date string (YYYY-MM-DD). */
export const appointmentDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "تنسيق التاريخ غير صالح")
  .refine(
    (value) => {
      const date = new Date(`${value}T00:00:00.000Z`);
      return (
        !Number.isNaN(date.getTime()) &&
        date.toISOString().slice(0, 10) === value
      );
    },
    { error: "التاريخ غير صالح" },
  );

const createAppointmentSchema = z
  .object({
    businessId: uuidSchema,
    customerId: uuidSchema,
    serviceId: uuidSchema,
    /**
     * Branch-aware (DECISIONS #30, PROMPT-ARCH-02): resolved SERVER-side
     * from the owning Business (its Default Branch today) — the field
     * exists on the repository DTO because the write is branch-scoped,
     * but no client form ever supplies it.
     */
    branchId: uuidSchema,
    assignedUserId: uuidSchema.nullish(),
    date: appointmentDateSchema,
    startTime: timeSchema,
    endTime: timeSchema,
    notes: z.string().trim().max(2000).optional(),
    /**
     * Initial status (PROMPT-09): derived server-side from the Business's
     * confirmation mode — PENDING (default/manual) or CONFIRMED
     * (automatic). Omitted by callers; the repository spreads it into the
     * create when present.
     */
    status: z.enum(appointmentStatusValues).optional(),
  })
  .refine((input) => input.endTime > input.startTime, {
    error: "وقت الانتهاء يجب أن يكون بعد وقت البداية",
    path: ["endTime"],
  });

const updateAppointmentSchema = z
  .object({
    assignedUserId: uuidSchema.nullish(),
    date: appointmentDateSchema,
    startTime: timeSchema,
    endTime: timeSchema,
    status: z.enum(appointmentStatusValues),
    notes: z.string().trim().max(2000).nullish(),
  })
  .partial()
  .refine(
    (input) =>
      !input.startTime || !input.endTime || input.endTime > input.startTime,
    { error: "وقت الانتهاء يجب أن يكون بعد وقت البداية", path: ["endTime"] },
  );

const listAppointmentsSchema = z.object({
  businessId: uuidSchema,
  /** Inclusive range as YYYY-MM-DD strings. */
  fromDate: appointmentDateSchema.optional(),
  toDate: appointmentDateSchema.optional(),
  status: z.enum(appointmentStatusValues).optional(),
  customerId: uuidSchema.optional(),
});

export type CreateAppointmentDto = z.infer<typeof createAppointmentSchema>;
export type UpdateAppointmentDto = z.infer<typeof updateAppointmentSchema>;
export type ListAppointmentsDto = z.infer<typeof listAppointmentsSchema>;

export const appointmentValidation = {
  create: createAppointmentSchema,
  update: updateAppointmentSchema,
  list: listAppointmentsSchema,
  findById: z.object({ id: uuidSchema }),
} as const;
