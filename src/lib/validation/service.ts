import { refineServicePrice, servicePriceShape } from "@/lib/service-price";

import { uuidSchema } from "./common";
import { z } from "zod";

/**
 * The plain Service field object (NO refinement) so feature-level schemas can
 * `.omit`/`.extend`/`.partial` it (ZodEffects cannot be reshaped). The
 * structural price invariants are applied via `refineServicePrice` on each
 * concrete schema below (and on the form schema).
 */
export const serviceCreateObject = z.object({
  businessId: uuidSchema,
  name: z.string().trim().min(2, "الاسم قصير جداً").max(120),
  description: z.string().trim().max(2000).optional(),
  durationMinutes: z
    .number()
    .int()
    .min(5, "أقل مدة هي 5 دقائق")
    .max(480, "أقصى مدة هي 8 ساعات"),
  // Price is OPTIONAL authoritative DOMAIN data (PROMPT-AI-ARCH-13 — Slice 6).
  // Duration (above) alone makes a service bookable; price never does.
  ...servicePriceShape,
});

const createServiceSchema = serviceCreateObject.superRefine((value, ctx) =>
  refineServicePrice(value, ctx),
);

const updateServiceSchema = serviceCreateObject
  .omit({ businessId: true })
  .partial()
  .superRefine((value, ctx) => refineServicePrice(value, ctx));

export type CreateServiceDto = z.infer<typeof createServiceSchema>;
export type UpdateServiceDto = z.infer<typeof updateServiceSchema>;

export const serviceValidation = {
  create: createServiceSchema,
  createObject: serviceCreateObject,
  update: updateServiceSchema,
  listByBusiness: z.object({ businessId: uuidSchema }),
  setActive: z.object({ id: uuidSchema, isActive: z.boolean() }),
} as const;
