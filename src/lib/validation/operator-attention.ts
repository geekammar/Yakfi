import { uuidSchema } from "./common";
import { z } from "zod";

/**
 * Operator attention (PROMPT-B04) — the notification layer on top of the
 * EXISTING NEED_HUMAN / AI_HANDOFF path.
 *
 * This is NOT a second human-handoff concept: the handoff itself stays
 * `ConversationStatus.NEED_HUMAN` (the authoritative, unchanged lifecycle).
 * An attention row is the operator-facing "you have not looked at this yet"
 * marker for one unresolved handoff — the missing product layer that turns a
 * silent status flip into an informed, actionable alert.
 *
 * `reason` is a stable machine key (the pattern used everywhere else in this
 * codebase — no Prisma enum, extending the list needs no migration). It is a
 * COARSE operational category, never internal AI reasoning: no prompts, no
 * chain-of-thought, no provider payload, no disclosure-policy names, no
 * visibility classification. The operator sees the operational consequence
 * ("the assistant could not answer safely"), not why the model decided it.
 */
export const attentionReasonValues = [
  /** The assistant could not safely answer (AI failure, invalid output, or a refused reply). */
  "AI_HANDOFF",
  /** A booking intent could not be completed automatically (eligibility/options/availability). */
  "BOOKING_BLOCKED",
  /** A non-AI-eligible thread (staff-owned / handed back) routed to staff attention. */
  "DEFERRED_TO_STAFF",
] as const;

export type AttentionReason = (typeof attentionReasonValues)[number];

/**
 * Operator-facing Arabic labels — plain operational language. Deliberately
 * hides B-01/B-02/B-03 internals, provider identity, and AI internals; the
 * operator only ever sees what they need to act.
 */
export const ATTENTION_REASON_LABELS: Record<AttentionReason, string> = {
  AI_HANDOFF: "تعذّر على المساعد الرد بأمان",
  BOOKING_BLOCKED: "تعذّر إتمام الحجز تلقائياً",
  DEFERRED_TO_STAFF: "المحادثة تنتظر تدخلك",
};

const openAttentionSchema = z.object({
  businessId: uuidSchema,
  conversationId: uuidSchema,
  reason: z.enum(attentionReasonValues),
});

const resolveAttentionSchema = z.object({
  conversationId: uuidSchema,
  resolvedById: uuidSchema,
});

export type OpenAttentionDto = z.infer<typeof openAttentionSchema>;
export type ResolveAttentionDto = z.infer<typeof resolveAttentionSchema>;

export const operatorAttentionValidation = {
  open: openAttentionSchema,
  resolve: resolveAttentionSchema,
} as const;
