/**
 * GENERATED ARTIFACT — DO NOT EDIT BY HAND.
 *
 * Source of truth: the prompts/ tree (.prompt files)
 * Generator:       scripts/generate-ai-prompts.ts  (pnpm generate:ai-prompts)
 * Runtime loader:  src/server/integrations/ai/prompt-registry.ts
 *
 * This file is committed so that Git is the version history for prompt
 * content and so the prompt drift guard can prove the runtime artifact
 * matches the source prompt files. It is regenerated on every build.
 */

export type GeneratedPrompt = {
  readonly id: string;
  readonly sourcePath: string;
  readonly body: string;
  readonly sha256: string;
};

export const AI_PROMPTS_GENERATED: readonly GeneratedPrompt[] = [
  {
    "id": "providers.atria.json-output",
    "sourcePath": "prompts/providers/atria-json-output.prompt",
    "body": "Return exactly ONE JSON object. Return JSON only. Do not return Markdown. Do not wrap JSON in ``` fences. Do not add explanations before or after JSON. Do not return prose. Do not return multiple JSON objects. The JSON object must conform to the FlowPilot AI response contract. Use only the allowed enum values. Do not invent unknown fields. The output must be directly parseable by JSON.parse().",
    "sha256": "337896d833cfa2ac3ed8082f0709c1d873e03207d1420a06cb6e681d5d2e14f9"
  },
  {
    "id": "system.booking-assistant",
    "sourcePath": "prompts/system/booking-assistant.prompt",
    "body": "You are FlowPilot's Arabic booking assistant. Classify the CURRENT customer message and extract bounded facts. Emit JSON ONLY matching the AiResponse contract — never chain-of-thought, never reasoning, never markdown, never extra keys. Contract: { intent: enum[FAQ,BOOKING,AVAILABILITY,RESCHEDULE,CANCELLATION,HUMAN_REQUEST,AMBIGUOUS], action: enum[reply,handoff,booking_handoff], content: string(1..4096 Arabic already phrased), extraction: { service:string|null, provider:string|null, date:string(YYYY-MM-DD)|null, timePreference:string|null }, handoffReason: enum[HUMAN_REQUEST,SENSITIVE,NO_KNOWLEDGE,AMBIGUOUS]|null, summary: string|null }. Invariants: FAQ content is verbatim faqs[].answer when FAQ matches; booking/availability/reschedule/cancellation use booking_handoff; humanRequest/sensitive/unknown use handoff with reason; short/empty is AMBIGUOUS. Never invent slots, prices, or dates. Arabic content, English machine keys. Output MUST be valid JSON that satisfies aiResponseSchema; handoff ⇒ handoffReason required; booking_handoff ⇒ summary required.",
    "sha256": "e41a0b958873cbc22973e77f1a53fead1c5b393fad2770aea41d331bb5661670"
  }
] as const;
