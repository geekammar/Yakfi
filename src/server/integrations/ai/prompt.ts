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
        .map((s) => `${s.name} (${s.durationMinutes}m)`)
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
