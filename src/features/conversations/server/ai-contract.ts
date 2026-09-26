/**
 * Structured AI contract (DECISIONS #33, PROMPT-ARCH-02) — the compact
 * typed request/response boundary between the Conversation Engine and
 * any assistant implementation (today the deterministic classifier;
 * tomorrow a real LLM adapter — replaceable without touching the
 * engine or domain).
 *
 * Responsibility split enforced by this contract:
 * - The REQUEST is minimal by construction: the current customer
 *   message, compact conversation state, and only the task-relevant
 *   facts (services, knowledge, provider preference, availability
 *   results) — never the whole database or complete history.
 * - The RESPONSE is structured and bounded: an intent from the fixed
 *   family, a typed action, bounded customer-facing content, bounded
 *   extraction facts, and a handoff decision. Unknown keys (e.g. any
 *   provider "reasoning") are STRIPPED by Zod — chain-of-thought never
 *   crosses this boundary and is never persisted.
 * - The AI NEVER queries Prisma, never decides availability or
 *   eligibility truth, and never creates appointments — it interprets;
 *   the Domain decides and executes; the Engine orchestrates.
 */

import { z } from "zod";

// ─── Intent family (no invented intents) ─────────────────────────────────────

export const aiIntentValues = [
  "GREETING",
  "FAQ",
  "BOOKING",
  "AVAILABILITY",
  "RESCHEDULE",
  "CANCELLATION",
  "HUMAN_REQUEST",
  "AMBIGUOUS",
] as const;

export type AiIntent = (typeof aiIntentValues)[number];

export const aiIntentSchema = z.enum(aiIntentValues);

/** Why the assistant handed the thread to a human. */
export const handoffReasonValues = [
  "HUMAN_REQUEST",
  "SENSITIVE",
  "NO_KNOWLEDGE",
  "AMBIGUOUS",
] as const;

export type HandoffReason = (typeof handoffReasonValues)[number];

export const handoffReasonSchema = z.enum(handoffReasonValues);

/** Engine-level action the turn resolves to. */
export const aiActionValues = ["reply", "handoff", "booking_handoff"] as const;

export type AiAction = (typeof aiActionValues)[number];

// ─── Bounded extraction facts ────────────────────────────────────────────────

/** "YYYY-MM-DD" — the only date form that crosses the boundary. */
const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "التاريخ غير صالح")
  .refine(
    (value) =>
      !Number.isNaN(new Date(`${value}T00:00:00.000Z`).getTime()) &&
      new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value,
    { error: "التاريخ غير صالح" },
  );

/**
 * Bounded facts extracted from the customer message — FACTS ONLY, never
 * reasoning. `timePreference` is free-form but short (e.g. "10:30" or
 * "صباحاً"); the DOMAIN resolves actual slots deterministically.
 */
export const aiExtractionSchema = z.object({
  /** Matched service name, when the message names one. */
  service: z.string().trim().min(1).max(120).nullable().default(null),
  /** Customer's stated provider preference ("أي دكتور" resolves in the domain). */
  provider: z.string().trim().min(1).max(120).nullable().default(null),
  /** Requested date, ISO form, when stated. */
  date: isoDateSchema.nullable().default(null),
  /** Requested time-of-day preference, when stated. */
  timePreference: z.string().trim().min(1).max(32).nullable().default(null),
});

export type AiExtraction = z.infer<typeof aiExtractionSchema>;

export const emptyAiExtraction: AiExtraction = {
  service: null,
  provider: null,
  date: null,
  timePreference: null,
};

// ─── Request (minimal context) ───────────────────────────────────────────────

/** Hard bound on conversation history fed to any assistant. */
export const AI_RECENT_MESSAGE_LIMIT = 20;

/** Hard bound on knowledge entries per request. */
export const AI_KNOWLEDGE_ENTRY_LIMIT = 50;

const recentMessageSchema = z.object({
  senderType: z.enum(["CUSTOMER", "AI", "STAFF"]),
  content: z.string().max(4096),
});

const serviceFactSchema = z.object({
  name: z.string().trim().min(1).max(120),
  /**
   * Service duration is OPTIONAL since PROMPT-B02: the context builder
   * classifies it INTERNAL and omits it unless the current AI task
   * genuinely requires it (availability is domain-computed by CORE-02,
   * never LLM-reasoned from durations). Backwards compatible — producers
   * that still supply it validate unchanged, and consumers that read it
   * must tolerate its absence.
   */
  durationMinutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60)
    .optional(),
});

const knowledgeEntrySchema = z.object({
  question: z.string().max(500),
  answer: z.string().max(2000),
});

/** Availability RESULTS (domain-computed truth), never AI guesses. */
const availabilityResultSchema = z.object({
  date: isoDateSchema,
  slots: z
    .array(
      z
        .string()
        .trim()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    )
    .max(50),
});

/**
 * The AI request — everything the assistant may see for the CURRENT
 * turn. Optional blocks are present ONLY when relevant to the task;
 * the engine never sends the complete business context.
 */
export const aiRequestSchema = z.object({
  /** The customer message being answered. */
  message: z.string().trim().min(1).max(4096),
  /** Compact conversation state (facts, bounded history). */
  conversationStatus: z.enum([
    "AI_ACTIVE",
    "NEED_HUMAN",
    "BOOKED",
    "INCOMPLETE",
  ]),
  recentMessages: z.array(recentMessageSchema).max(AI_RECENT_MESSAGE_LIMIT),
  /** Business display name (for phrasing only). */
  businessName: z.string().trim().min(1).max(120),
  /** Service facts when the task may involve a service. */
  services: z.array(serviceFactSchema).max(100).default([]),
  /** Relevant knowledge entries when available. */
  faqs: z.array(knowledgeEntrySchema).max(AI_KNOWLEDGE_ENTRY_LIMIT).default([]),
  /** Previously captured provider preference, when one exists. */
  providerPreference: z.string().trim().min(1).max(120).nullish(),
  /**
   * The assistant's VOICE — a bounded Arabic phrasing directive rendered by
   * `renderAssistantStyleDirective` (DECISIONS #62). PHRASING ONLY, exactly
   * like `businessName`: it carries no knowledge, no slots, and no prices,
   * and it can never relax the disclosure gate (the gate never reads it).
   * Optional so a minimal request still validates; the context builder
   * always embeds the resident style.
   */
  assistantStyle: z.string().trim().min(1).max(400).optional(),
  /** Domain-computed availability results, when already resolved. */
  availability: z.array(availabilityResultSchema).max(14).nullish(),
});

export type AiRequest = z.infer<typeof aiRequestSchema>;

// ─── Response (structured, bounded) ──────────────────────────────────────────

const aiResponseBase = {
  intent: aiIntentSchema,
  action: z.enum(aiActionValues),
  /** Customer-facing reply (already phrased, bounded). */
  content: z.string().trim().min(1, "الرد فارغ").max(4096, "الرد طويل جداً"),
  /** Bounded extraction facts. */
  extraction: aiExtractionSchema,
  /** Why the thread goes to a human (required for handoff). */
  handoffReason: handoffReasonSchema.nullable().default(null),
  /** Short staff-facing summary (required for booking_handoff). */
  summary: z.string().trim().min(1).max(400).nullable().default(null),
};

/**
 * The AI response — structured output only. Unknown keys are STRIPPED
 * (Zod default): provider "reasoning"/chain-of-thought never crosses
 * the boundary and is never persisted anywhere downstream.
 */
export const aiResponseSchema = z
  .object(aiResponseBase)
  .refine(
    (response) =>
      response.action !== "handoff" || response.handoffReason !== null,
    {
      error: "سبب التحويل مطلوب",
      path: ["handoffReason"],
    },
  )
  .refine(
    (response) =>
      response.action !== "booking_handoff" || response.summary !== null,
    { error: "الملخص مطلوب", path: ["summary"] },
  );

export type AiResponse = z.infer<typeof aiResponseSchema>;

/** Parse + validate an assistant's raw output; null on any violation. */
export function parseAiResponse(raw: unknown): AiResponse | null {
  const parsed = aiResponseSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Parse + validate a minimal AI request; null on any violation. */
export function parseAiRequest(raw: unknown): AiRequest | null {
  const parsed = aiRequestSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
