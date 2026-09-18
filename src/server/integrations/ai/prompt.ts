/**
 * Prompt rendering for the AI provider adapter (PROMPT-AI-02).
 *
 * Provider-neutral instructions derived from `docs/ai/PROMPTS.md`
 * + the structured contract (`ai-contract.ts`). The adapter never
 * edits prompts — it renders `AiRequest` + these instructions into
 * the provider chat shape at call time, instructing JSON-only output
 * matching `aiResponseSchema`.
 */
import type { AiRequest } from "@/features/conversations/server/ai-contract";

export const AI_SYSTEM_INSTRUCTIONS = [
  "You are FlowPilot's Arabic booking assistant.",
  "Classify the CURRENT customer message and extract bounded facts.",
  "Emit JSON ONLY matching the AiResponse contract — never chain-of-thought, never reasoning, never markdown, never extra keys.",
  "Contract: { intent: enum[FAQ,BOOKING,AVAILABILITY,RESCHEDULE,CANCELLATION,HUMAN_REQUEST,AMBIGUOUS], action: enum[reply,handoff,booking_handoff], content: string(1..4096 Arabic already phrased), extraction: { service:string|null, provider:string|null, date:string(YYYY-MM-DD)|null, timePreference:string|null }, handoffReason: enum[HUMAN_REQUEST,SENSITIVE,NO_KNOWLEDGE,AMBIGUOUS]|null, summary: string|null }.",
  "Invariants: FAQ content is verbatim faqs[].answer when FAQ matches; booking/availability/reschedule/cancellation use booking_handoff; humanRequest/sensitive/unknown use handoff with reason; short/empty is AMBIGUOUS. Never invent slots, prices, or dates. Arabic content, English machine keys.",
  "Output MUST be valid JSON that satisfies aiResponseSchema; handoff ⇒ handoffReason required; booking_handoff ⇒ summary required.",
].join(" ");

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
