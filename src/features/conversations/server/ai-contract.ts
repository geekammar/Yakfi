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

import {
  canonicalTimePreferenceSchema,
  canonicalTimePreferenceValues,
  conversationFactKeys,
  isCanonicalTimePreference,
  removableFactKeys,
  type CanonicalTimePreference,
  type ConversationFactKey,
  type RemovableFactKey,
} from "./conversation-facts";
import {
  aiTemporalContextSchema,
  type AiTemporalContext,
} from "./temporal-context";
import { z } from "zod";

export {
  canonicalTimePreferenceSchema,
  canonicalTimePreferenceValues,
  conversationFactKeys,
  isCanonicalTimePreference,
  removableFactKeys,
  type CanonicalTimePreference,
  type ConversationFactKey,
  type RemovableFactKey,
  aiTemporalContextSchema,
  type AiTemporalContext,
};

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

// ─── Semantic Safety Assessment (CORE-03D2) ──────────────────────────────────

/**
 * Canonical three-state safety assessment (CORE-03D2):
 * - safe: ordinary booking preferences, harmless polite phrasing, negation (e.g. "مش مشكلة"),
 *   or general queries that do not require sensitive escalation.
 * - sensitive: high-stakes customer situations (medical emergency, severe complaint, harm,
 *   legal dispute) requiring immediate human staff escalation.
 * - uncertain: ambiguous or unclassifiable high-stakes context that must not proceed to booking.
 */
export const aiSafetyAssessmentValues = [
  "safe",
  "sensitive",
  "uncertain",
] as const;

export type AiSafetyAssessment = (typeof aiSafetyAssessmentValues)[number];

export const aiSafetyAssessmentSchema = z.enum(aiSafetyAssessmentValues);

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
 * Structured temporal request schema for semantic date and range extraction.
 * Distinguishes an exact calendar date, a relative day offset, a calendar week range,
 * and an explicit bounded date range.
 */
export const aiTemporalRequestSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("exact_date"),
    date: isoDateSchema,
  }),
  z.object({
    type: z.literal("relative_day"),
    offsetDays: z.number().int().min(0).max(60),
  }),
  z.object({
    type: z.literal("calendar_week"),
    weekOffset: z.number().int().min(0).max(8),
  }),
  z.object({
    type: z.literal("date_range"),
    startDate: isoDateSchema,
    endDate: isoDateSchema,
  }),
]);

export type AiTemporalRequest = z.infer<typeof aiTemporalRequestSchema>;

/**
 * Structured exact-time request schema (PROMPT-EXACT-TIME).
 * Distinguishes a fully resolved 24-hour wall-clock time from a customer request
 * where the 12-hour hour was stated but AM/PM is genuinely unresolved (e.g. "الساعة 3").
 */
export const aiExactTimeRequestSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("specific"),
    /** "HH:mm" 24-hour wall-clock format (e.g. "17:00", "13:00", "09:30") */
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "تنسيق الوقت غير صالح"),
  }),
  z.object({
    type: z.literal("unresolved_period"),
    /** 12-hour format hour (1..12) where AM vs PM was not stated */
    hour: z.number().int().min(1).max(12),
    /** Optional minute (0..59), defaults to 0 */
    minute: z.number().int().min(0).max(59).default(0),
  }),
]);

export type AiExactTimeRequest = z.infer<typeof aiExactTimeRequestSchema>;

/**
 * Bounded facts extracted from the customer message — FACTS ONLY, never
 * reasoning. `timePreference` must strictly use canonical machine values
 * ("morning" | "afternoon" | "evening"). Stated exact times are carried
 * in structured `exactTime` without losing AM/PM uncertainty.
 * The DOMAIN resolves actual slots deterministically.
 */
export const aiExtractionSchema = z.object({
  /** Matched service name, when the message names one. */
  service: z.string().trim().min(1).max(120).nullable().default(null),
  /** Customer's stated provider preference ("أي دكتور" resolves in the domain). */
  provider: z.string().trim().min(1).max(120).nullable().default(null),
  /** Requested date, ISO form, when stated. */
  date: isoDateSchema.nullable().default(null),
  /** Requested time-of-day preference, when stated. Canonical values only. */
  timePreference: canonicalTimePreferenceSchema.nullable().default(null),
  /** Structured temporal request (exact, relative day, calendar week, or explicit range). */
  temporalRequest: aiTemporalRequestSchema.nullable().optional(),
  /** Structured exact-time request (specific HH:mm or unresolved period requiring clarification). */
  exactTime: z
    .preprocess((val) => {
      if (typeof val === "string") {
        const trimmed = val.trim();

        // 1. Explicit period indicators in string (AM/PM or Arabic period)
        const pmMatch =
          /^([01]?\d):([0-5]\d)(?:\s*(?:pm|p\.m\.|مساءً|مساء|عصراً|عصر|ظهراً|ظهر))$/i.exec(
            trimmed,
          );
        if (pmMatch && pmMatch[1] && pmMatch[2]) {
          const h = parseInt(pmMatch[1], 10);
          if (h >= 1 && h <= 12) {
            const resolvedH = h === 12 ? 12 : h + 12;
            return {
              type: "specific",
              time: `${String(resolvedH).padStart(2, "0")}:${pmMatch[2]}`,
            };
          }
        }
        const amMatch =
          /^([01]?\d):([0-5]\d)(?:\s*(?:am|a\.m\.|صباحاً|صباح|فجراً|فجر))$/i.exec(
            trimmed,
          );
        if (amMatch && amMatch[1] && amMatch[2]) {
          const h = parseInt(amMatch[1], 10);
          if (h >= 1 && h <= 12) {
            const resolvedH = h === 12 ? 0 : h;
            return {
              type: "specific",
              time: `${String(resolvedH).padStart(2, "0")}:${amMatch[2]}`,
            };
          }
        }

        // 2. Unambiguous 24-hour wall-clock times (hours 13..23 or hour 00/0)
        // Hour > 12 has unambiguous 24-hour PM provenance
        const m24 = /^(?:([1][3-9]|2[0-3])):([0-5]\d)(?::[0-5]\d)?$/.exec(
          trimmed,
        );
        if (m24 && m24[1] && m24[2]) {
          return { type: "specific", time: `${m24[1]}:${m24[2]}` };
        }
        // Hour 00/0 has unambiguous 24-hour midnight provenance
        const mMidnight = /^(?:0?0):([0-5]\d)(?::[0-5]\d)?$/.exec(trimmed);
        if (mMidnight && mMidnight[1]) {
          return { type: "specific", time: `00:${mMidnight[1]}` };
        }

        // 3. Bare 12-hour wall-clock time (hours 1..12, e.g. "4:15", "04:15", "3:30")
        // An untyped bare string in 1..12 without AM/PM has NO period provenance.
        // It must NOT silently manufacture AM certainty (e.g. "04:15").
        // Safe handling policy: treat as unresolved period requiring clarification.
        const mBare12 = /^([01]?\d):([0-5]\d)(?::[0-5]\d)?$/.exec(trimmed);
        if (mBare12 && mBare12[1] && mBare12[2]) {
          const h = parseInt(mBare12[1], 10);
          const m = parseInt(mBare12[2], 10);
          if (h >= 1 && h <= 12) {
            return { type: "unresolved_period", hour: h, minute: m };
          }
        }
      }

      if (val && typeof val === "object") {
        const obj = val as Record<string, unknown>;

        // Explicitly typed specific time (preserves legitimate explicit requests)
        if (
          (obj.type === "specific" || obj.type === "exact") &&
          typeof obj.time === "string"
        ) {
          const m = /^([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(
            obj.time.trim(),
          );
          if (m && m[1] && m[2]) {
            return {
              ...obj,
              type: "specific",
              time: `${m[1].padStart(2, "0")}:${m[2]}`,
            };
          }
        }

        // Explicitly typed unresolved period
        if (obj.type === "unresolved_period" || obj.type === "ambiguous") {
          return {
            type: "unresolved_period",
            hour: Number(obj.hour),
            minute: obj.minute !== undefined ? Number(obj.minute) : 0,
          };
        }

        // Untyped object with hour provided (e.g. { hour: 4, minute: 15 })
        if (obj.type === undefined && obj.hour !== undefined) {
          const h = Number(obj.hour);
          if (h >= 1 && h <= 12) {
            return {
              type: "unresolved_period",
              hour: h,
              minute: obj.minute !== undefined ? Number(obj.minute) : 0,
            };
          }
        }

        // Untyped object with time provided (e.g. { time: "4:15" })
        if (obj.type === undefined && typeof obj.time === "string") {
          const trimmed = obj.time.trim();
          const m24 = /^(?:([1][3-9]|2[0-3])):([0-5]\d)(?::[0-5]\d)?$/.exec(
            trimmed,
          );
          if (m24 && m24[1] && m24[2]) {
            return { type: "specific", time: `${m24[1]}:${m24[2]}` };
          }
          const mMidnight = /^(?:0?0):([0-5]\d)(?::[0-5]\d)?$/.exec(trimmed);
          if (mMidnight && mMidnight[1]) {
            return { type: "specific", time: `00:${mMidnight[1]}` };
          }
          const mBare12 = /^([01]?\d):([0-5]\d)(?::[0-5]\d)?$/.exec(trimmed);
          if (mBare12 && mBare12[1] && mBare12[2]) {
            const h = parseInt(mBare12[1], 10);
            const m = parseInt(mBare12[2], 10);
            if (h >= 1 && h <= 12) {
              return { type: "unresolved_period", hour: h, minute: m };
            }
          }
        }
      }
      return val;
    }, aiExactTimeRequestSchema.nullable().optional())
    .optional(),
});

export type AiExtraction = z.infer<typeof aiExtractionSchema>;

export const emptyAiExtraction: AiExtraction = {
  service: null,
  provider: null,
  date: null,
  timePreference: null,
  temporalRequest: null,
  exactTime: null,
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
  /**
   * Service description — the business's own customer-facing copy
   * (PROMPT-AI-ARCH-15 — Slice 6). Present ONLY when the context builder
   * found the current turn service-info relevant AND the service carries an
   * authoritative stored description (task-gated exposure); absent
   * otherwise. The AI may QUOTE it but must NEVER invent a service detail
   * when it is absent — missing description stays a knowledge gap.
   */
  description: z.string().trim().min(1).max(600).optional(),
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
 * CONV-CORE-02: Bounded context projection of durable conversation state.
 * Encapsulates the minimal, validated state slice required for contextual AI interpretation.
 */
export const conversationContextProjectionSchema = z.object({
  activeTask: z
    .object({
      kind: z.string().max(64),
      stage: z.string().max(64),
    })
    .nullable()
    .optional(),
  bookingStage: z.string().max(64).optional(),
  currentGoal: z.string().max(64).nullable().optional(),
  knownService: z.string().max(200).nullable().optional(),
  resolvedServiceId: z.string().max(200).nullable().optional(),
  knownDate: z.string().max(40).nullable().optional(),
  knownDateRange: z
    .object({
      startDate: z.string().max(40),
      endDate: z.string().max(40),
    })
    .nullable()
    .optional(),
  timePreference: z.string().max(80).nullable().optional(),
  knownExactTime: z.string().max(20).nullable().optional(),
  providerPreference: z.string().max(200).nullable().optional(),
  pendingClarification: z
    .object({
      type: z.string().max(64),
      missingFacts: z.array(z.string().max(64)).max(8).optional(),
      unresolvedTime: z
        .object({
          hour: z.number().int().min(1).max(12),
          minute: z.number().int().min(0).max(59),
        })
        .optional(),
    })
    .nullable()
    .optional(),
  pendingGoals: z
    .array(
      z.object({
        kind: z.string().max(64),
        intent: z.string().max(64).optional(),
      }),
    )
    .max(4)
    .optional(),
  activeOffer: z
    .object({
      type: z.enum(["SERVICE", "SLOT"]),
      itemCount: z.number().int().min(0).max(10),
      offeredDate: z.string().max(40).nullable().optional(),
      offeredServiceName: z.string().max(200).nullable().optional(),
    })
    .nullable()
    .optional(),
  lastCompletedTask: z
    .object({
      kind: z.literal("BOOKING"),
      serviceId: z.string().max(200),
      date: z.string().max(40),
      completedAt: z.string().max(64),
    })
    .nullable()
    .optional(),
});

export type ConversationContextProjection = z.infer<
  typeof conversationContextProjectionSchema
>;

export const requiredSemanticCapabilityValues = ["structured_turn"] as const;

export type RequiredSemanticCapability =
  (typeof requiredSemanticCapabilityValues)[number];

export const requiredSemanticCapabilitySchema = z.enum(
  requiredSemanticCapabilityValues,
);

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
  /**
   * The business's own "about" description (PROMPT-AI-ARCH-15 — Slice 6).
   * PUBLIC customer-facing copy, carried ONLY when the context builder found
   * the current turn business-info relevant (task-gated exposure — never on
   * unrelated turns). The AI may QUOTE it but must NEVER invent a business
   * fact when it is absent.
   */
  businessAbout: z.string().trim().min(1).max(2000).optional(),
  /**
   * The business's customer-facing location/address line
   * (PROMPT-AI-OPS-21). CONDITIONAL: carried ONLY when the context builder
   * found the current turn contact/identity/location-relevant (the same gate
   * `whatsappNumber` uses) AND the business stored an authoritative address.
   * The AI may QUOTE it but must NEVER invent a location when it is absent —
   * a missing address stays a knowledge gap (NO_KNOWLEDGE handoff).
   */
  businessAddress: z.string().trim().min(1).max(500).optional(),
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
  /**
   * ONE opaque correlation id for the turn (PROMPT-AI-JEV-03D — OPTION E).
   * Optional and additive: the engine stamps the turn's existing `traceId`
   * here so a NON-AUTHORITATIVE shadow JEV evaluation can admit and correlate
   * turns deterministically WITHOUT deriving anything from message content.
   * It is never customer-visible, never a routing input, and absent on every
   * pre-03D request (so all existing producers keep validating unchanged).
   */
  traceId: z
    .string()
    .trim()
    .max(64)
    .regex(/^[0-9a-f]+$/)
    .optional(),
  /**
   * CONV-CORE-02: Bounded context projection of durable conversation state.
   * Additive and optional; present when available and tenant-validated.
   */
  conversationContext: conversationContextProjectionSchema.optional(),
  /**
   * CORE-03B1: Server-derived provider-neutral temporal reference for relative date interpretation.
   * Additive and optional; present when canonical turn clock is available.
   */
  temporalContext: aiTemporalContextSchema.optional(),
  /**
   * CORE-03B2A: Server-derived provider-neutral semantic capability requirement.
   * Additive and optional; present when a free-form customer turn reaches
   * the semantic boundary after mechanical handling has yielded.
   */
  requiredSemanticCapability: requiredSemanticCapabilitySchema.optional(),
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
 * An OPTIONAL model-proposed handoff cause label. This field is a bounded
 * string (never a second authority): the canonical production taxonomy landed
 * in `handoff-cause.ts` (PROMPT-AI-ARCH-16 — Slice 7; DECISIONS #81), and the
 * engine DERIVES the authoritative `HandoffCause` deterministically AFTER the
 * resolver/safety decision — it never trusts this free-form model string.
 */
export const aiHandoffCauseSchema = z.string().trim().min(1).max(64);

export type AiHandoffCause = z.infer<typeof aiHandoffCauseSchema>;

/** Explicit or legacy SET operation (CORE-03A, CORE-03D1). */
export const aiSetFactUpdateSchema = z
  .object({
    /** Fact key in the target model. */
    key: z.string().trim().min(1).max(64),
    /** Explicit or default 'set' operation. */
    operation: z.literal("set").optional(),
    /** Customer-stated value; cannot be empty or sentinel 'null'. */
    value: z
      .string()
      .trim()
      .min(1, "قيمة الحقيقة مطلوبة")
      .max(200)
      .refine((v) => v.toLowerCase() !== "null", {
        message: "نص 'null' ليس قيمة صالحة",
      }),
    /** True when this supersedes a previously known value. */
    isRevision: z.boolean().optional(),
  })
  .refine(
    (update) => {
      if (update.key === "timePreference") {
        return (canonicalTimePreferenceValues as readonly string[]).includes(
          update.value,
        );
      }
      if (update.key === "exactTime") {
        return /^([01]\d|2[0-3]):[0-5]\d$/.test(update.value);
      }
      return true;
    },
    {
      message:
        "قيمة تفضيل الوقت غير صالحة — القيم المعتمدة هي morning أو afternoon أو evening، أو تنسيق وقت دقيق HH:mm",
      path: ["value"],
    },
  );

/** Explicit REMOVE operation (date, timePreference, provider only) (CORE-03A). */
export const aiRemoveFactUpdateSchema = z.object({
  /** Bounded subset of removable fact keys. */
  key: z.enum(removableFactKeys),
  /** Explicit 'remove' operation. */
  operation: z.literal("remove"),
  /** REMOVE carries no replacement value. */
  value: z.undefined().optional(),
  /** True when this supersedes a previously known value. */
  isRevision: z.boolean().optional(),
});

/**
 * A conversation fact the model PROPOSES; the engine validates.
 * Supports legacy SET { key, value }, explicit SET { key, operation: "set", value },
 * and explicit REMOVE { key, operation: "remove" }.
 */
export const aiFactUpdateSchema = z.union([
  aiSetFactUpdateSchema,
  aiRemoveFactUpdateSchema,
]);

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
  /**
   * Bounded semantic safety assessment for the customer utterance (CORE-03D2).
   * Distinguishes contextual meaning from isolated lexical triggers like "مشكلة".
   */
  safetyAssessment: aiSafetyAssessmentSchema.optional(),
  // ── Additive target-architecture fields (OPTIONAL; unused by producers today)
  /** Structured goals when a producer can express more than one intent. */
  goals: z.array(aiGoalSchema).max(8).optional(),
  /** Optional top-level requiredKnowledge label for single-intent responses. */
  requiredKnowledge: z.string().trim().min(1).max(64).optional(),
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
  return [
    {
      kind: goalKindForDecision(response),
      intent: response.intent,
      ...(response.requiredKnowledge
        ? { requiredKnowledge: response.requiredKnowledge }
        : {}),
    },
  ];
}

/** The single-step TurnPlan a no-goals decision implies (Slice 0 observation). */
export function synthesizeTurnPlan(response: AiResponse): AiTurnPlan {
  return { steps: synthesizeDecisionGoals(response) };
}
