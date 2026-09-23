/**
 * AI context builder — public surface (PROMPT-B02).
 *
 * The explicit context boundary between conversation orchestration and the
 * `AiRequest` that reaches any assistant. Makes the B-01 knowledge
 * visibility policy operational: classifies every candidate fact, proves
 * tenant scope, drops provenance, and composes the minimal request.
 *
 * Canonical documentation: `docs/ai/ARCHITECTURE.md → AI context builder`.
 * Decision record: DECISIONS #51.
 */

export {
  CONTEXT_BUILDER_NEVER_HOLDS_SECRETS,
  CONTEXT_OMISSION_REASONS,
  buildAiContext,
  deriveTaskRelevance,
  type BuildAiContextInput,
  type BuiltAiContext,
  type ContextAvailabilityFact,
  type ContextBusinessSources,
  type ContextFactRecord,
  type ContextOmissionReason,
  type ContextServiceFact,
  type ContextSources,
  type TaskRelevance,
} from "./context-builder";
