/**
 * Async knowledge-gap recorder (PROMPT-AI-ARCH-18 — Slice 9).
 *
 * The RECORD-ONLY, off-critical-path half of the target architecture's
 * "Async Knowledge-Gap / Self-Improvement" boundary
 * (`docs/ai/TARGET_ARCHITECTURE.md §3.16` / `§17 Slice 9`).
 *
 * WHAT THIS DOES — and does not do:
 *   1. It derives a bounded, deterministic observation ONLY when the finished
 *      turn's authoritative cause is `KNOWLEDGE_GAP_UNRESOLVED` ("the assistant
 *      could not answer because authoritative knowledge was unresolved").
 *   2. It classifies the missing knowledge into a small stable category by
 *      REUSING the EXISTING deterministic task-relevance seam
 *      (`deriveTaskRelevance`, the same function B-02 runs on this exact
 *      message) plus the turn's already-authoritative intent. It is NOT a new
 *      classifier, NOT a model call, NOT a second resolver, and it NEVER
 *      changes the turn.
 *   3. The engine calls this AFTER the customer reply was persisted + sent and
 *      records the result through the repository best-effort (exactly like
 *      usage telemetry and operator attention) — so a gap write can never
 *      block, retry, delay, or alter a turn.
 *
 * BINDING invariants:
 *   - It NEVER fabricates knowledge (no price, service, slot, or answer is
 *     invented) — a gap is evidence for review, never truth.
 *   - It is provider-neutral and tenant-scoped (the caller passes the
 *     server-derived businessId; no client businessId is ever trusted).
 *   - It is PURE and total: no I/O, no model, no environment access, nothing
 *     from the repository/DB layer.
 */

import type { TaskRelevance } from "@/features/conversations/server/ai-context-builder";
import { deriveTaskRelevance } from "@/features/conversations/server/ai-context-builder";
import type { AiResponse } from "@/features/conversations/server/ai-contract";
import type { HandoffCause } from "@/features/conversations/server/handoff-cause";
import type {
  KnowledgeGapCategory,
  RecordKnowledgeGapDto,
} from "@/lib/validation";

/**
 * The most of the customer's own question that is copied into a record. The
 * full message stays in the immutable `messages` row; this is only a bounded
 * human-readable subject so an operator does not have to join tables to see
 * what the gap was about. Never a model output, never chain-of-thought.
 */
export const KNOWLEDGE_GAP_SUBJECT_MAX_LENGTH = 200;

/** The minimal shape of a finished turn the recorder needs. */
export type KnowledgeGapTurn = {
  businessId: string;
  conversationId: string;
  customerMessageId: string;
  intent: AiResponse["intent"] | null;
  handoffCause: HandoffCause | null;
};

/**
 * Derive the stable knowledge family from signals the turn ALREADY computed.
 * The specific, task-gated families (price / business info / service info)
 * take precedence over the coarser intent fallback, because they tell the
 * reviewing human exactly what source was missing. There is NO model call and
 * NO new classifier: `relevance` is the same deterministic value B-02 derived.
 */
export function deriveKnowledgeGapCategory(
  intent: AiResponse["intent"] | null,
  relevance: TaskRelevance | null,
): KnowledgeGapCategory {
  if (relevance?.priceOrFee) return "SERVICE_PRICE";
  if (relevance?.businessInfo) return "BUSINESS_INFO";
  // An identity ask the assistant could not back is ALSO missing Business
  // record data: the canonical name lives in Business settings, so it routes
  // there — never to the FAQ editor, which would duplicate the name into the
  // knowledge store (PROMPT-AI-UX-02 single-source rule).
  if (relevance?.businessIdentity) return "BUSINESS_INFO";
  if (relevance?.serviceInfo) return "SERVICE_INFO";
  if (intent === "BOOKING" || intent === "AVAILABILITY") return "AVAILABILITY";
  if (intent === "FAQ") return "FAQ";
  return "GENERAL";
}

/**
 * Build the append DTO for a finished turn — or `null` when the turn is not a
 * genuine unresolved knowledge gap. This is the ONE gate that decides whether a
 * record exists, and it reads ONLY the engine's authoritative
 * `handoffCause`, so a provider failure, an AI failure, a safety handoff, a
 * human request, an ambiguity, a policy refusal, a domain block or a
 * configuration failure can NEVER create a false gap record.
 */
export function deriveKnowledgeGapObservation(input: {
  turn: KnowledgeGapTurn;
  messageText: string | null;
}): RecordKnowledgeGapDto | null {
  if (input.turn.handoffCause !== "KNOWLEDGE_GAP_UNRESOLVED") return null;

  const text = input.messageText?.trim() ?? "";
  const relevance = text ? deriveTaskRelevance(text) : null;
  const category = deriveKnowledgeGapCategory(input.turn.intent, relevance);
  const subjectText = text
    ? text.slice(0, KNOWLEDGE_GAP_SUBJECT_MAX_LENGTH)
    : null;

  return {
    businessId: input.turn.businessId,
    conversationId: input.turn.conversationId,
    customerMessageId: input.turn.customerMessageId,
    category,
    subjectText: subjectText && subjectText.length > 0 ? subjectText : null,
  };
}
