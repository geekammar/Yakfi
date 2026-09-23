/**
 * AI knowledge visibility — the four-level policy (PROMPT-B01).
 *
 * The policy controls what information is ELIGIBLE to enter AI context
 * (what the assistant may know) and, separately, what it may MENTION to
 * a customer. The two are NOT the same thing:
 *
 *   "AI may know this"    — eligibility to enter the `AiRequest` context
 *                           the Conversation Engine builds.
 *   "AI may mention this" — permission for the assistant to put it in a
 *                           customer-facing reply.
 *
 * Levels (binding):
 *
 * - PUBLIC      — safe for the AI to know AND communicate to customers
 *                 normally (e.g. the business name, the FAQ store, the
 *                 service catalog names).
 * - CONDITIONAL — safe for the AI to know and mention ONLY when the
 *                 conversational request or task makes the fact relevant
 *                 (e.g. the cancellation policy on a cancellation ask;
 *                 domain-computed availability on a booking ask). It must
 *                 not automatically appear in normal responses.
 * - INTERNAL    — may inform FlowPilot's internal reasoning or future
 *                 staff/operator tooling, but must NOT be disclosed to
 *                 customers by the AI (e.g. working hours, slot duration,
 *                 confirmation mode, discovery metadata). The AI may know
 *                 it exists; it may not repeat it.
 * - FORBIDDEN   — must never enter AI context (see FORBIDDEN_CATEGORY).
 *
 * Scope (what this policy governs): KNOWLEDGE FACTS — the pieces of
 * information a future Context Builder (B-02) considers putting into
 * `AiRequest`. It does NOT govern the engine-wired system-instruction
 * channel (`prompts/system/booking-assistant.prompt`), which is the
 * instruction layer governed by the Prompt Workspace rules
 * (`docs/ai/ARCHITECTURE.md`) and is never a knowledge fact.
 *
 * This module defines the levels and their algebra only. WHICH field has
 * which level lives in `knowledge-visibility.ts`.
 */

/**
 * The four visibility levels. The order below is the restrictiveness
 * order used by `mostRestrictive` — it is NOT alphabetical.
 */
export const VISIBILITY_LEVELS = [
  "PUBLIC",
  "CONDITIONAL",
  "INTERNAL",
  "FORBIDDEN",
] as const;

export type VisibilityLevel = (typeof VISIBILITY_LEVELS)[number];

/** Restrictiveness rank: higher = fewer permissions. */
export const VISIBILITY_RANK: Record<VisibilityLevel, number> = {
  PUBLIC: 0,
  CONDITIONAL: 1,
  INTERNAL: 2,
  FORBIDDEN: 3,
};

/**
 * When several sources classify the same fact, the MOST restrictive
 * classification wins — a fact is only as disclosable as its least
 * permissive attribution. An empty list means unclassified, which
 * resolves to INTERNAL (see DEFAULT_VISIBILITY): never customer-visible.
 */
export function mostRestrictive(
  levels: ReadonlyArray<VisibilityLevel>,
): VisibilityLevel {
  if (levels.length === 0) return DEFAULT_VISIBILITY;
  return levels.reduce((strictest, level) =>
    VISIBILITY_RANK[level] > VISIBILITY_RANK[strictest] ? level : strictest,
  );
}

/**
 * DEFAULT SAFETY (binding): when visibility is unknown the fact is NOT
 * exposed to the customer. Unknown resolves to INTERNAL — the AI may
 * still reason about it when the Context Builder explicitly enrolls it
 * with a known source, but it is never customer-disclosable.
 */
export const DEFAULT_VISIBILITY: VisibilityLevel = "INTERNAL";

/**
 * The disclosure gate — "AI may mention this to the customer?".
 *
 * - PUBLIC      → yes, always.
 * - CONDITIONAL → only when the current task makes it relevant. The
 *                 relevance flag is supplied by the Context Builder
 *                 (B-02) from the turn's intent, never by the AI.
 * - INTERNAL    → never (the AI may know it, not repeat it).
 * - FORBIDDEN   → never, and it never reaches context in the first place.
 */
export function isDisclosable(
  level: VisibilityLevel,
  options?: { taskRelevant?: boolean },
): boolean {
  switch (level) {
    case "PUBLIC":
      return true;
    case "CONDITIONAL":
      return options?.taskRelevant === true;
    case "INTERNAL":
    case "FORBIDDEN":
      return false;
  }
}

/**
 * AI-context eligibility — "AI may know this?".
 *
 * PUBLIC and CONDITIONAL facts are eligible (CONDITIONAL ones only when
 * task-relevant — they must not be loaded speculatively). INTERNAL facts
 * are eligible to inform reasoning, but `isDisclosable` stays false, so
 * including them obliges the prompt to keep them unspoken (B-03 decides
 * the customer-facing behavior). FORBIDDEN facts are never eligible and
 * are never constructed as candidates (see `enrollFact`).
 */
export function isEligibleForAiContext(
  level: VisibilityLevel,
  options?: { taskRelevant?: boolean },
): boolean {
  switch (level) {
    case "PUBLIC":
      return true;
    case "CONDITIONAL":
      return options?.taskRelevant === true;
    case "INTERNAL":
      return true;
    case "FORBIDDEN":
      return false;
  }
}

/** Convenience: a level is FORBIDDEN (never enters AI context). */
export function isForbidden(level: VisibilityLevel): boolean {
  return level === "FORBIDDEN";
}
