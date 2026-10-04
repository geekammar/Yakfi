import {
  assistantLanguageValues,
  detailValues,
  emojiValues,
  toneValues,
} from "@/features/conversations/server/assistant-style";

import { z } from "zod";

/**
 * Assistant Settings form input (PROMPT-AI-UX-01).
 *
 * BOUNDED CHOICES ONLY (prompt §7): every dimension is one of the closed
 * enums from the single assistant-style module — there is deliberately NO
 * free-form system instruction field anywhere. The client NEVER sends a
 * `businessId`, a provider, a model, a prompt, or a safety toggle; the
 * Business is always derived server-side from the authenticated actor and
 * Zod strips every unknown key.
 *
 * All dimensions are optional so a PARTIAL save is valid: the owner may set
 * the tone alone, and every untouched dimension keeps the resident default.
 * `name` is optional display copy (prompt §7 SECTION A: do not require it).
 */
export const assistantSettingsSchema = z.object({
  name: z
    .string()
    .trim()
    .max(60, "الاسم طويل جداً (٦٠ حرف كحد أقصى)")
    .optional(),
  language: z.enum(assistantLanguageValues).optional(),
  tone: z.enum(toneValues).optional(),
  detail: z.enum(detailValues).optional(),
  emoji: z.enum(emojiValues).optional(),
});

export type AssistantSettingsInput = z.infer<typeof assistantSettingsSchema>;
