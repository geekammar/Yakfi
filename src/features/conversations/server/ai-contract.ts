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
  /**
   * Service price — the provider-facing, MINIMAL, already-formatted display
   * string (PROMPT-AI-ARCH-13 — Slice 6). Present ONLY when the context
   * builder found the current turn price-relevant AND the service has an
   * authoritative stored price (task-gated CONDITIONAL exposure); absent
   * otherwise. The AI never sees the internal structured columns — it may
   * QUOTE this string but must NEVER invent a price when it is absent. The
   * deterministic server-side Domain stays authoritative for the real value.
   */
  price: z.string().trim().min(1).max(120).optional(),
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

// ─── Additive decision shape (PROMPT-AI-ARCH-02 — Slice 0) ────────────────────
//
// Target-architecture capacity ONLY. These fields are OPTIONAL: no current
// producer emits them and no current consumer is required to read them, so
// production behavior is unchanged. A decision that carries no `goals` is
// treated as exactly one goal synthesized from `intent` + `action`
// (`synthesizeDecisionGoals`) — the compatibility bridge the target defines
// (docs/ai/TARGET_ARCHITECTURE.md §5.2/§18).
//
// The final production enums for the future behaviours (decision classes,
// clarification types, handoff causes) land in later slices. To avoid copying
// the evaluation-only semantic vocabulary into production, every descriptive
// label here is a BOUNDED string; the ONE closed enum is the structural
// decision class (`AiGoalKind`) the synthesis bridge must emit.

/** The four target decision classes (TARGET_ARCHITECTURE §5.1). */
export const aiGoalKindValues = [
  "ANSWER",
  "CLARIFY",
  "DOMAIN_ACTION",
  "HANDOFF",
] as const;

export type AiGoalKind = (typeof aiGoalKindValues)[number];

export const aiGoalKindSchema = z.enum(aiGoalKindValues);

/**
 * One goal in a structured AI decision. `kind` is the target decision class;
 * the remaining labels are resolver-mapped (bounded labels, NOT a copy of the
 * evaluation-only vocabulary) and optional so a minimal goal stays valid.
 */
export const aiGoalSchema = z.object({
  kind: aiGoalKindSchema,
  /** Existing intent family, or a future resolver-mapped label. */
  intent: z.string().trim().min(1).max(64).optional(),
  /** Resolver-mapped knowledge requirement label (additive). */
  requiredKnowledge: z.string().trim().min(1).max(64).optional(),
  /** Resolver-mapped domain action label (additive). */
  domainAction: z.string().trim().min(1).max(64).optional(),
  /** Stable ordering — lower runs first. Optional for compatibility. */
  priority: z.number().int().min(0).max(100).optional(),
  /** Keep the task pending after this goal (answer-and-continue). */
  continueAfter: z.boolean().optional(),
});

export type AiGoal = z.infer<typeof aiGoalSchema>;

/** A clarification the model PROPOSES; the engine decides (later slice). */
export const aiClarificationSchema = z.object({
  /** Target clarification type; the final production enum lands later. */
  type: z.string().trim().min(1).max(64),
  /** Missing fact keys the clarification asks about (later slice). */
  missingFacts: z.array(z.string().trim().min(1).max(64)).max(8).optional(),
});

export type AiClarification = z.infer<typeof aiClarificationSchema>;

/**
 * An explicit handoff cause. A bounded label in this slice — the final
 * production cause enum lands with the handoff mapping (later slice). Target
 * values: CUSTOMER_REQUESTED_HUMAN · SENSITIVE_OR_RESTRICTED ·
 * DOMAIN_REQUIRES_HUMAN · KNOWLEDGE_GAP_UNRESOLVED · AMBIGUITY_UNRESOLVED ·
 * POLICY_REFUSED · PROVIDER_FAILURE · AI_FAILURE · TENANT_CONFIGURATION ·
 * RETRY_EXHAUSTED.
 */
export const aiHandoffCauseSchema = z.string().trim().min(1).max(64);

export type AiHandoffCause = z.infer<typeof aiHandoffCauseSchema>;

/** A conversation fact the model PROPOSES; the engine validates (later slice). */
export const aiFactUpdateSchema = z.object({
  /** Closed fact key in the target model (service | date | timePreference | …). */
  key: z.string().trim().min(1).max(64),
  /** Customer-stated value; the engine validates it against server ids. */
  value: z.string().trim().min(1).max(200),
  /** True when this supersedes a previously known value. */
  isRevision: z.boolean().optional(),
});

export type AiFactUpdate = z.infer<typeof aiFactUpdateSchema>;

/**
 * The ordered executable plan (TARGET_ARCHITECTURE §3.10). A plan is an
 * ordered list of goals — the SAME model, never a second one. Optional and
 * unused by today's producers; the Decision/Action Resolver owns it later.
 */
export const aiTurnPlanSchema = z.object({
  steps: z.array(aiGoalSchema).max(8),
});

export type AiTurnPlan = z.infer<typeof aiTurnPlanSchema>;

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
  // ── Additive target-architecture fields (OPTIONAL; unused by producers today)
  /** Structured goals when a producer can express more than one intent. */
  goals: z.array(aiGoalSchema).max(8).optional(),
  /** A proposed clarification (the engine decides; later slice). */
  clarification: aiClarificationSchema.optional(),
  /** An explicit typed handoff cause (the engine maps it; later slice). */
  handoffCause: aiHandoffCauseSchema.optional(),
  /** Proposed conversation-fact updates (engine-validated; later slice). */
  factUpdates: z.array(aiFactUpdateSchema).max(16).optional(),
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

// ─── Compatibility bridge (one canonical decision representation) ────────────

/** Intents the DOMAIN executes (CORE-01/CORE-02), not the assistant. */
const domainExecutedIntents: ReadonlySet<AiIntent> = new Set<AiIntent>([
  "BOOKING",
  "AVAILABILITY",
  "RESCHEDULE",
  "CANCELLATION",
]);

/** The target decision class an existing (intent, action) pair maps to. */
function goalKindForDecision(response: AiResponse): AiGoalKind {
  if (response.action === "handoff") return "HANDOFF";
  if (response.action === "booking_handoff") return "DOMAIN_ACTION";
  // action === "reply": booking-family intents resolve through the domain;
  // everything else is answered from knowledge/domain facts.
  return domainExecutedIntents.has(response.intent)
    ? "DOMAIN_ACTION"
    : "ANSWER";
}

/**
 * The single-goal synthesis bridge (TARGET_ARCHITECTURE §5.2/§18): a decision
 * that carries explicit `goals` keeps them; a decision with none is treated
 * as exactly one goal derived from the existing `intent` + `action`. Pure and
 * additive — current callers never need to call it, and it introduces no
 * second decision representation.
 */
export function synthesizeDecisionGoals(response: AiResponse): AiGoal[] {
  if (response.goals && response.goals.length > 0) return [...response.goals];
  return [{ kind: goalKindForDecision(response), intent: response.intent }];
}

/** The single-step TurnPlan a no-goals decision implies (Slice 0 observation). */
export function synthesizeTurnPlan(response: AiResponse): AiTurnPlan {
  return { steps: synthesizeDecisionGoals(response) };
}
