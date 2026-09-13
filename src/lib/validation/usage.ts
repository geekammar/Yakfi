import { uuidSchema } from "./common";
import { z } from "zod";

/**
 * Usage telemetry validation (DECISIONS #36, PROMPT-ARCH-02).
 *
 * RAW USAGE FACTS ONLY — Usage ≠ Cost ≠ Price ≠ Entitlement ≠ Billing
 * (ECONOMICS.md). Records carry ids, counters, provider/model machine
 * keys, and status — never message content, secrets, or
 * chain-of-thought. Cost is stored only as an optional point-in-time
 * snapshot (`estimatedCostMicros`); pricing logic is computed later,
 * never in schemas.
 */

/** What was measured — stable machine keys. */
export const usageKindValues = [
  "INBOUND_MESSAGE",
  "OUTBOUND_MESSAGE",
  "AI_TURN",
] as const;

export const usageStatusValues = ["SUCCESS", "FAILURE"] as const;

const recordUsageSchema = z.object({
  businessId: uuidSchema,
  kind: z.enum(usageKindValues),
  conversationId: uuidSchema.nullish(),
  messageId: uuidSchema.nullish(),
  whatsappConnectionId: uuidSchema.nullish(),
  /** Provider machine key (transport/assistant implementation name). */
  provider: z.string().trim().min(1).max(64).nullish(),
  /** Model identifier when the provider reports one. */
  model: z.string().trim().min(1).max(128).nullish(),
  inputTokens: z.number().int().min(0).nullish(),
  outputTokens: z.number().int().min(0).nullish(),
  estimatedCostMicros: z.number().int().min(0).nullish(),
  status: z.enum(usageStatusValues),
  occurredAt: z.date(),
});

export type RecordUsageDto = z.infer<typeof recordUsageSchema>;

export const usageValidation = {
  record: recordUsageSchema,
} as const;
