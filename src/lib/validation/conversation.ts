import { uuidSchema } from "./common";
import { z } from "zod";

export const conversationStatusValues = [
  "AI_ACTIVE",
  "NEED_HUMAN",
  "BOOKED",
  "INCOMPLETE",
] as const;

export const messageSenderTypeValues = ["CUSTOMER", "AI", "STAFF"] as const;

const createConversationSchema = z.object({
  businessId: uuidSchema,
  customerId: uuidSchema,
  /**
   * Branch-aware (DECISIONS #30, PROMPT-ARCH-02): the operational unit
   * the thread runs in — always resolved SERVER-side (the Business's
   * Default Branch today); never accepted from client input.
   */
  branchId: uuidSchema,
  assignedUserId: uuidSchema.nullish(),
});

const updateConversationSchema = z.object({
  assignedUserId: uuidSchema.nullish(),
  aiSummary: z.string().trim().max(4000).nullish(),
});

const listConversationsSchema = z.object({
  businessId: uuidSchema,
  status: z.enum(conversationStatusValues).optional(),
  assignedUserId: uuidSchema.optional(),
});

const createMessageSchema = z.object({
  conversationId: uuidSchema,
  senderType: z.enum(messageSenderTypeValues),
  content: z.string().trim().min(1, "الرسالة فارغة").max(4096),
  /**
   * Transport-owned receive timestamp (PROMPT-19): an inbound message may
   * carry the time it actually arrived on WhatsApp so threads keep true
   * ordering across webhook retries. Omitted for UI/server-generated
   * writes, which fall back to the DB default (now).
   */
  createdAt: z.date().optional(),
});

export type CreateConversationDto = z.infer<typeof createConversationSchema>;
export type UpdateConversationDto = z.infer<typeof updateConversationSchema>;
export type ListConversationsDto = z.infer<typeof listConversationsSchema>;
export type CreateMessageDto = z.infer<typeof createMessageSchema>;

export const conversationValidation = {
  create: createConversationSchema,
  update: updateConversationSchema,
  list: listConversationsSchema,
  setStatus: z.object({
    id: uuidSchema,
    status: z.enum(conversationStatusValues),
  }),
} as const;

export const messageValidation = {
  create: createMessageSchema,
  listByConversation: z.object({ conversationId: uuidSchema }),
} as const;
