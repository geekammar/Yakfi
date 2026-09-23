/**
 * AI knowledge visibility policy — public surface (PROMPT-B01).
 *
 * The policy that decides what information is eligible to enter AI
 * context and, separately, what the assistant may mention to a customer.
 * Consumed by the future Context Builder (B-02); B-01 ships the policy
 * only — no context aggregation, no prompt assembly, no LLM calls.
 *
 * Canonical documentation: `docs/ai/ARCHITECTURE.md → Knowledge
 * visibility policy`. Decision record: DECISIONS #50.
 */

export {
  DEFAULT_VISIBILITY,
  VISIBILITY_LEVELS,
  VISIBILITY_RANK,
  type VisibilityLevel,
} from "./visibility-level";
export {
  isDisclosable,
  isEligibleForAiContext,
  isForbidden,
  mostRestrictive,
} from "./visibility-level";

export {
  FACT_EXCLUSION_REASONS,
  KNOWLEDGE_FACT_SOURCE_VALUES,
  type FactEnrollmentResult,
  type FactExclusionReason,
  type KnowledgeFact,
  type KnowledgeFactSource,
  enrollFact,
  isWithinTenantScope,
} from "./knowledge-provenance";

export {
  AI_MUST_NOT_RESOLVE_CONFLICTS,
  FAQ_STORE_VISIBILITY,
  FORBIDDEN_CATEGORY_VALUES,
  FORBIDDEN_FIELDS,
  type ForbiddenCategory,
  classifyBusinessField,
  classifyConversationField,
  classifyFaqStore,
  classifyServiceField,
  decideFact,
  isForbiddenField,
  mergeVisibility,
} from "./knowledge-visibility";
