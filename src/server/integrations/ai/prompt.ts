/**
 * Prompt rendering for the AI provider adapter (PROMPT-AI-02).
 *
 * The instruction BODY is not defined here — it lives in
 * `prompts/system/booking-assistant.prompt` and reaches the runtime through
 * the generated artifact (`src/generated/ai-prompts.generated.ts`) via
 * `getPromptBody`. This module is the BUILDER only: it renders `AiRequest`
 * + the compiled instructions into the provider chat shape and instructs
 * JSON-only output matching `aiResponseSchema`. Editing prompt text belongs
 * in the `.prompt` file, not here.
 */
import type { AiRequest } from "@/features/conversations/server/ai-contract";
import { ASSISTANT_STYLE_DIRECTIVE } from "@/features/conversations/server/assistant-style";

import { getPromptBody } from "./prompt-registry";

export const AI_SYSTEM_INSTRUCTIONS = getPromptBody("system.booking-assistant");

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export function buildPromptMessages(
  request: AiRequest,
  extraSystemInstructions?: string,
): ChatMessage[] {
  const recent =
    request.recentMessages
      .map((m) => `${m.senderType}: ${m.content}`)
      .join("\n") || "(no history)";
  const services = request.services.length
    ? request.services
        // Duration is INTERNAL (PROMPT-B02) and may be intentionally
        // absent; price is CONDITIONAL (PROMPT-AI-ARCH-13) and present only
        // when the context builder found the turn price-relevant AND an
        // authoritative price is stored; description is PUBLIC but carried
        // only on a service-info turn (PROMPT-AI-ARCH-15). Render each only
        // when provided.
        .map((s) => {
          const parts = [s.name];
          if (s.durationMinutes !== undefined)
            parts.push(`${s.durationMinutes}m`);
          if (s.price !== undefined) parts.push(`السعر: ${s.price}`);
          if (s.description !== undefined)
            parts.push(`الوصف: ${s.description}`);
          return parts.length > 1
            ? `${parts[0]} (${parts.slice(1).join(", ")})`
            : parts[0];
        })
        .join("; ")
    : "(none)";
  const faqs = request.faqs.length
    ? request.faqs
        .map((f) => `Q: ${f.question}\nA: ${f.answer}`)
        .join("\n---\n")
    : "(none)";
  const availability = request.availability?.length
    ? request.availability
        .map((a) => `${a.date}: ${a.slots.join(", ")}`)
        .join(" | ")
    : "(none / not resolved)";
  const providerPref = request.providerPreference ?? "(none)";

  const userContent = [
    `businessName: ${request.businessName}`,
    `conversationStatus: ${request.conversationStatus}`,
    // DECISIONS #62 — the assistant's voice rides with the request context
    // (phrasing only, like businessName), so every provider follows ONE
    // style and no provider-specific prompt copy exists.
    `assistantStyle: ${request.assistantStyle ?? ASSISTANT_STYLE_DIRECTIVE}`,
    `businessAbout: ${request.businessAbout ?? "(none)"}`,
    `recentMessages:\n${recent}`,
    `services: ${services}`,
    `faqs:\n${faqs}`,
    `providerPreference: ${providerPref}`,
    `availability: ${availability}`,
    `CURRENT message: ${request.message}`,
  ].join("\n\n");

  const systemContent = extraSystemInstructions
    ? `${AI_SYSTEM_INSTRUCTIONS} ${extraSystemInstructions}`
    : AI_SYSTEM_INSTRUCTIONS;

  return [
    { role: "system", content: systemContent },
    { role: "user", content: userContent },
  ];
}

export function buildRequestBody(
  model: string,
  messages: ChatMessage[],
): unknown {
  return {
    model,
    messages,
    temperature: 0.2,
    response_format: { type: "json_object" },
  };
}
