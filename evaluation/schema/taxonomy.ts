/**
 * FlowPilot AI Evaluation — Taxonomy (PROMPT-AI-EVAL-DESIGN-01, extending
 * PROMPT-AI-EVAL-FOUNDATION-01).
 *
 * The stable vocabulary the Egyptian evaluation dataset is labelled with.
 * This file is DATASET LABELS ONLY — it deliberately imports the CURRENT
 * production intent/handoff enums from `ai-contract.ts` so a case can carry
 * a "baseline-compatible" expectation, and defines a separate FUTURE
 * taxonomy used to measure architecture gaps WITHOUT ever changing the
 * production `aiIntentValues` (see AGENT_RULES / the slice hard-stop).
 *
 * Nothing here is imported by production code. Evaluation depends on
 * production; production never depends on evaluation.
 *
 * EXTENSION RULE (binding): this vocabulary is ADDITIVE ONLY across dataset
 * versions. A label may be added or narrowed, never deleted or renamed — a
 * rename is a NEW label plus the old one kept (marked deprecated in the
 * design doc). That is what makes `egyptian-v2` forward-compatible with
 * `egyptian-v1` artifacts and vice versa (`evaluation/schema/versioning.ts`
 * enforces the rule structurally).
 */

import {
  aiActionValues,
  aiIntentValues,
  handoffReasonValues,
} from "@/features/conversations/server/ai-contract";

// ─── Current production taxonomy (re-exported, never redefined) ──────────────

/** The 8 production intents — the ONLY intents the current AI can emit. */
export const currentIntentValues = aiIntentValues;
export type CurrentIntent = (typeof currentIntentValues)[number];

/** The 3 production actions. */
export const currentActionValues = aiActionValues;
export type CurrentAction = (typeof currentActionValues)[number];

/** The 4 production handoff reasons. */
export const currentHandoffReasonValues = handoffReasonValues;
export type CurrentHandoffReason = (typeof currentHandoffReasonValues)[number];

// ─── Future evaluation taxonomy (DATASET LABELS ONLY) ────────────────────────

/**
 * Richer semantic categories used to describe what a customer ACTUALLY
 * wants, independent of what the current architecture can represent. These
 * are never added to production enums; they exist so the baseline can name
 * the gap between "what the customer meant" and "what the current AI did".
 */
export const semanticIntentValues = [
  // baseline-compatible (map 1:1 onto a current intent)
  "GREETING",
  "FAQ",
  "BOOKING",
  "AVAILABILITY",
  "RESCHEDULE",
  "CANCELLATION",
  "HUMAN_REQUEST",
  "AMBIGUOUS",
  // future evaluation categories (no production representation yet)
  "SERVICE_DISCOVERY",
  "SERVICE_INFO",
  "SERVICE_PRICE",
  "BUSINESS_INFO",
  "LOCATION",
  "HOURS",
  "CONFIRMATION",
  "FOLLOW_UP",
  "MULTI_INTENT",
  "TOPIC_SWITCH",
  "KNOWLEDGE_GAP",
  "CLARIFICATION_REQUIRED",
] as const;

export type SemanticIntent = (typeof semanticIntentValues)[number];

/** The subset of semantic intents that map 1:1 onto a production intent. */
export const baselineCompatibleSemanticIntents: ReadonlySet<SemanticIntent> =
  new Set<SemanticIntent>([
    "GREETING",
    "FAQ",
    "BOOKING",
    "AVAILABILITY",
    "RESCHEDULE",
    "CANCELLATION",
    "HUMAN_REQUEST",
    "AMBIGUOUS",
  ]);

// ─── Handoff appropriateness (the mandatory true-vs-unnecessary split) ───────

/**
 * Whether a genuine HUMAN is required for this turn, judged from the
 * scenario's semantic truth — NOT from what the current AI happens to do.
 * This is the ground truth behind handoff precision/recall.
 *
 * - REQUIRED: a human must be involved (explicit human request, sensitive/
 *   high-risk, or a genuinely unsupported request the AI can never satisfy).
 * - NOT_REQUIRED: a competent assistant could resolve this turn itself
 *   (answer, clarify, or drive the booking) — a handoff here is UNNECESSARY.
 * - ACCEPTABLE_EITHER: a routing handoff is a reasonable outcome but so is a
 *   self-serve answer (e.g. booking that current arch always routes to staff).
 */
export const handoffExpectationValues = [
  "REQUIRED",
  "NOT_REQUIRED",
  "ACCEPTABLE_EITHER",
] as const;

export type HandoffExpectation = (typeof handoffExpectationValues)[number];

/** The specific kind of TRUE handoff a case expects, when REQUIRED. */
export const handoffKindValues = [
  "HUMAN_REQUEST",
  "SENSITIVE",
  "UNSUPPORTED",
  "NONE",
] as const;

export type HandoffKind = (typeof handoffKindValues)[number];

/**
 * The observed CLASSIFICATION of a handoff an evaluated system actually
 * produced, separated by WHY the human got involved (the handoff model).
 * These are scored SEPARATELY in the evaluation result so a future system
 * is credited/blamed for the right reason:
 *
 * - TRUE_HUMAN_REQUIRED       — a human is genuinely required and one routed.
 * - UNNECESSARY_HUMAN_HANDOFF — the system could have resolved the turn but
 *   escalated anyway (the primary robustness metric).
 * - PROVIDER_FAILURE          — an upstream provider error forced escalation.
 * - AI_FAILURE                — the assistant produced an invalid/empty output.
 * - KNOWLEDGE_GAP             — no knowledge backed the answer (missing store).
 * - AMBIGUITY                 — the turn was genuinely ambiguous; clarifying or
 *   escalating was the honest move.
 * - NO_HANDOFF                — no handoff occurred.
 *
 * Only TRUE_HUMAN_REQUIRED / UNNECESSARY_HUMAN_HANDOFF feed handoff
 * precision/recall; the rest are reported as distinct failure channels.
 */
export const handoffOutcomeClassValues = [
  "TRUE_HUMAN_REQUIRED",
  "UNNECESSARY_HUMAN_HANDOFF",
  "PROVIDER_FAILURE",
  "AI_FAILURE",
  "KNOWLEDGE_GAP",
  "AMBIGUITY",
  "NO_HANDOFF",
] as const;

export type HandoffOutcomeClass = (typeof handoffOutcomeClassValues)[number];

// ─── Knowledge requirement ───────────────────────────────────────────────────

/**
 * What kind of knowledge the turn genuinely needs to be answered well.
 * Covers the full knowledge model: none → FAQ → catalog → details → price →
 * policy → business info → availability → multiple sources → gap.
 */
export const knowledgeRequirementValues = [
  "NONE",
  "EXACT_FAQ",
  "PARAPHRASED_FAQ",
  "WEAK_FAQ",
  "NO_FAQ",
  "SERVICE_CATALOG",
  "SERVICE_DETAILS",
  "SERVICE_INFO",
  "PRICE",
  "POLICY",
  "BUSINESS_INFO",
  "AVAILABILITY",
  "MULTIPLE_SOURCES",
  "KNOWLEDGE_GAP",
  "NOT_PRESENT",
  "NOT_EXPOSED",
  "MULTIPLE_PLAUSIBLE",
] as const;

export type KnowledgeRequirement = (typeof knowledgeRequirementValues)[number];

/**
 * The KNOWLEDGE SOURCE backing an ideal answer — the answer side of the
 * knowledge model. Distinct from `knowledgeRequirementValues` (what a turn
 * NEEDS): this names WHERE the needed knowledge comes from, which is what
 * lets a case assert a `KNOWLEDGE_GAP` (need present, source absent).
 */
export const knowledgeSourceValues = [
  "NONE",
  "FAQ_STORE",
  "SERVICE_CATALOG",
  "SERVICE_DETAILS",
  "PRICE_LIST",
  "BUSINESS_INFO",
  "AVAILABILITY_ENGINE",
  "CANCELLATION_POLICY",
  "MULTIPLE_SOURCES",
  "HUMAN_OPERATOR",
] as const;

export type KnowledgeSource = (typeof knowledgeSourceValues)[number];

// ─── Language behavior ───────────────────────────────────────────────────────

export const languageRegisterValues = [
  "EGYPTIAN_COLLOQUIAL",
  "EGYPTIAN_FORMALISH",
  "MSA",
  "MIXED_EGY_MSA",
  "ARABIZI",
  "ARABIC_ENGLISH",
  "ENGLISH",
] as const;

export type LanguageRegister = (typeof languageRegisterValues)[number];

/**
 * Orthographic / input-noise dimensions a variant may carry. `CLEAN` means
 * no deliberate noise. The remaining values are the Egyptian-Arabic
 * realization of the required language-profile axes: typo-heavy (`TYPOS`,
 * `KEYBOARD_MISTAKE`), speech-to-text style (`SPEECH_TO_TEXT`,
 * `FRAGMENTED`), punctuation noise (`MISSING_PUNCTUATION`,
 * `INFORMAL_PUNCTUATION`, `MISSING_HAMZA`), repeated characters
 * (`REPEATED_LETTERS`), and spelling variation (`SPELLING_VARIATION` — a
 * variant that realizes the SAME word with a different accepted spelling,
 * e.g. `تنظيف` / `تنضيف`, `موظف` / `موظف`).
 */
export const noiseCategoryValues = [
  "CLEAN",
  "MISSING_HAMZA",
  "MISSING_PUNCTUATION",
  "REPEATED_LETTERS",
  "TYPOS",
  "ABBREVIATIONS",
  "SPEECH_TO_TEXT",
  "INFORMAL_PUNCTUATION",
  "VERY_SHORT",
  "FRAGMENTED",
  "EMOJI",
  "KEYBOARD_MISTAKE",
  "ARABIZI",
  "MIXED_LANGUAGE",
  "SPELLING_VARIATION",
] as const;

export type NoiseCategory = (typeof noiseCategoryValues)[number];

// ─── Edge categories (why a case exists) ─────────────────────────────────────

/**
 * Edge categories — the taxonomy of WHY a case exists. Arranged as the
 * required PROMPT-AI-EVAL-DESIGN-01 edge taxonomy: a normal core, then
 * comprehension edges, then conversation-behavior edges, then knowledge
 * edges, then handoff edges, then safety edges, then domain-specific edges,
 * then robustness/rare edges.
 */
export const edgeCategoryValues = [
  // ── baseline core
  "NORMAL",
  // ── comprehension / ambiguity / multi-goal
  "MULTI_INTENT",
  "AMBIGUOUS",
  "AMBIGUOUS_CLARIFIABLE",
  "AMBIGUOUS_NEEDS_HUMAN",
  "AMBIGUOUS_STATE_RESOLVES",
  "CONTEXT_DEPENDENT",
  "MISSING_INFORMATION",
  "IMPLICIT_REFERENCE",
  "PARTIAL_INFORMATION",
  "MULTIPLE_ENTITIES",
  // ── comprehension (PROMPT-AI-EVAL-02 addition; additive-only)
  "VERY_SHORT_INPUT",
  // ── conversation behavior
  "TOPIC_SWITCH",
  "TOPIC_RETURN",
  "SELF_CORRECTION",
  "CONTRADICTION",
  "REPETITION",
  "REFUSAL",
  "FOLLOW_UP",
  "CONFIRMATION",
  "STATE_RECOVERY",
  "LONG_CONTEXT",
  // ── conversation behavior (PROMPT-AI-EVAL-02 additions; additive-only)
  "INTERRUPTION",
  "HESITATION",
  // ── knowledge
  "KNOWLEDGE_EXACT",
  "KNOWLEDGE_PARAPHRASE",
  "KNOWLEDGE_WEAK",
  "KNOWLEDGE_MISSING",
  "KNOWLEDGE_NOT_EXPOSED",
  "KNOWLEDGE_MULTIPLE",
  "KNOWLEDGE_GAP",
  // ── handoff
  "HANDOFF_EXPLICIT",
  "HANDOFF_SENSITIVE",
  "HANDOFF_UNSUPPORTED",
  "HANDOFF_UNNECESSARY_RISK",
  "UNNECESSARY_HANDOFF",
  "LEGITIMATE_HANDOFF",
  // ── safety / sensitive
  "SENSITIVE",
  "ADVERSARIAL",
  "SECURITY_INJECTION",
  "PROMPT_INJECTION",
  // ── language / orthography
  "LANGUAGE_VARIATION",
  "TYPO",
  "ARABIZI",
  "CODE_SWITCH",
  "SERVICE_NAME_ENGLISH",
  "SERVICE_NAME_ARABIZI",
  "KEYBOARD_MISTAKE",
  // ── domain-specific (booking domain)
  "BOOKING_JOURNEY",
  "BOOKING_FAILURE",
  "BOOKING_EDGE",
  "AVAILABILITY_EDGE",
  "RESCHEDULE_EDGE",
  "CANCELLATION_EDGE",
] as const;

export type EdgeCategory = (typeof edgeCategoryValues)[number];

// ─── Difficulty + rarity + orientation ───────────────────────────────────────

export const difficultyValues = ["EASY", "MEDIUM", "HARD", "EXTREME"] as const;
export type Difficulty = (typeof difficultyValues)[number];

export const rarityValues = [
  "COMMON",
  "UNCOMMON",
  "RARE",
  "EXTREMELY_RARE",
] as const;
export type Rarity = (typeof rarityValues)[number];

/** Whether the case measures current behavior or future-architecture gaps. */
export const orientationValues = [
  "BASELINE_COMPATIBLE",
  "FUTURE_ARCHITECTURE",
] as const;
export type Orientation = (typeof orientationValues)[number];

export const conversationTypeValues = [
  "SINGLE_TURN",
  "TWO_TURN",
  "SHORT_MULTI_TURN",
  "MEDIUM_MULTI_TURN",
  "LONG_MULTI_TURN",
] as const;
export type ConversationType = (typeof conversationTypeValues)[number];

// ─── Customer behavior profile (PROMPT-AI-EVAL-DESIGN-01) ────────────────────

/**
 * HOW the customer behaves in the turn — independent of WHAT they want
 * (the semantic intent) and of HOW they phrase it (the language profile).
 *
 * The two structural groups:
 * - disposition  — a stable conversational style (the customer is vague,
 *   hesitant, hurried, emotional, …). A case may carry several.
 * - change-of-state — the customer revises a fact already on the table.
 *   These are MUTATION-RELEVANT: a `corrective` / `changes_*` behaviour is
 *   the semantic counterpart of a SEMANTIC_CHANGING mutation, because the
 *   expected outcome must move with the revised fact.
 */
export const customerDispositionValues = [
  "CLEAR",
  "VAGUE",
  "HESITANT",
  "HURRIED",
  "REPETITIVE",
  "CORRECTIVE",
  "CONTRADICTORY",
  "EMOTIONAL",
  "POLITE",
  "CURIOUS",
] as const;

export type CustomerDisposition = (typeof customerDispositionValues)[number];

/**
 * A customer-revision axis. A turn carrying one of these SUPERSEDES a fact
 * the conversation had already established, so the ground truth's expected
 * entities / state transition must describe the REVISED fact, not the
 * original one.
 */
export const customerChangeOfStateValues = [
  "NONE",
  "CHANGES_MIND",
  "CHANGES_DATE",
  "CHANGES_SERVICE",
  "CHANGES_PROVIDER",
  "CHANGES_TIME",
  "ASKS_UNRELATED_QUESTION",
  "REQUESTS_HUMAN_EXPLICITLY",
] as const;

export type CustomerChangeOfState =
  (typeof customerChangeOfStateValues)[number];

/** The full customer-behavior profile attached to a scenario / case. */
export const customerBehaviorValues = [
  ...customerDispositionValues,
  ...customerChangeOfStateValues,
] as const;

export type CustomerBehavior = (typeof customerBehaviorValues)[number];

// ─── Ground-truth domains (evaluation-only; NOT production actions) ──────────

/**
 * The DOMAIN action the ideal assistant would drive — the ground-truth
 * counterpart of the production `AiAction`. These live ONLY in the dataset:
 * the production contract is unchanged (`reply` | `handoff` |
 * `booking_handoff`). They let a case state the intended domain move
 * (`PROPOSE_SLOTS`, `CONFIRM_BOOKING`, `REQUEST_CLARIFICATION`, …) so a
 * future architecture can be measured against the journey it should have
 * driven, not merely the intent it should have labelled.
 */
export const expectedDomainActionValues = [
  "NONE",
  "REPLY_FROM_KNOWLEDGE",
  "REQUEST_CLARIFICATION",
  "REQUEST_MISSING_SERVICE",
  "REQUEST_MISSING_DATE",
  "REQUEST_MISSING_TIME",
  "REQUEST_MISSING_PROVIDER",
  "RESOLVE_AVAILABILITY",
  "PROPOSE_SLOTS",
  "SELECT_SLOT",
  "CONFIRM_BOOKING",
  "CREATE_BOOKING",
  "RESCHEDULE_BOOKING",
  "CANCEL_BOOKING",
  "ESCALATE_TO_HUMAN",
] as const;

export type ExpectedDomainAction = (typeof expectedDomainActionValues)[number];

/**
 * The clarification the ideal assistant should ask for (or NONE). This is
 * the label future clarification behaviour will be measured against; the
 * current architecture has no clarification action, so any non-NONE value
 * records a `FUTURE_ARCHITECTURE` expectation.
 */
export const clarificationTypeValues = [
  "NONE",
  "CLARIFY_SERVICE",
  "CLARIFY_DATE",
  "CLARIFY_TIME",
  "CLARIFY_PROVIDER",
  "CLARIFY_INTENT",
  "CLARIFY_DISAMBIGUATE_MULTI_INTENT",
  "CONFIRM_UNDERSTOOD_REQUEST",
] as const;

export type ClarificationType = (typeof clarificationTypeValues)[number];

/**
 * The safety/sensitive expectation for a turn. `SAFE` is the default;
 * `SENSITIVE_MEDICAL`/`EMOTIONAL_DISTRESS` mark turns where the current
 * architecture must route to staff and a future one must never try to
 * diagnose or reassure; `SECURITY_ATTEMPT` marks adversarial turns where
 * the correct behavior is refusal + escalation and never instruction
 * following.
 */
export const safetyExpectationValues = [
  "SAFE",
  "SENSITIVE_MEDICAL",
  "EMOTIONAL_DISTRESS",
  "SECURITY_ATTEMPT",
] as const;

export type SafetyExpectation = (typeof safetyExpectationValues)[number];

/**
 * A booking-journey checkpoint. The dataset can represent the full journey
 * `goal → missing service → service supplied → missing date → date supplied
 * → missing time → preference supplied → availability → slot selection →
 * confirmation`, PLUS interruption/recovery (`INTERRUPTED`, `RECOVERING`,
 * `ABORTED`). `NOT_APPLICABLE` for non-booking turns.
 */
export const bookingJourneyStateValues = [
  "NOT_APPLICABLE",
  "GOAL_STATED",
  "MISSING_SERVICE",
  "SERVICE_SUPPLIED",
  "MISSING_DATE",
  "DATE_SUPPLIED",
  "MISSING_TIME",
  "TIME_SUPPLIED",
  "AVAILABILITY_RESOLVED",
  "SLOT_SELECTION",
  "CONFIRMATION",
  "COMPLETED",
  "INTERRUPTED",
  "RECOVERING",
  "ABORTED",
] as const;

export type BookingJourneyState = (typeof bookingJourneyStateValues)[number];

// ─── Mutation semantics (the semantic-preserving vs semantic-changing split) ──

/**
 * The semantic class of a mutation — the distinction the generation model
 * must keep explicit:
 *
 * - SURFACE_PRESERVING — the transform changes only the surface (register,
 *   orthography, punctuation, spelling). The gold label is UNCHANGED, so
 *   `goldPreserved` must stay `true` and the expected outcome is inherited
 *   unchanged from the scenario.
 * - SEMANTIC_CHANGING — the transform intentionally moves the
 *   conversation's semantic state (a contradiction, a change of date, a
 *   topic switch). The variant is emitted from a DIFFERENT scenario whose
 *   ground truth describes the NEW state; `goldPreserved: false` records
 *   that the label moved WITH the meaning, by construction.
 *
 * A generator MUST never relabel a SURFACE_PRESERVING mutation as
 * SEMANTIC_CHANGING to "fix" a mismatch — the fix is a new scenario.
 */
export const mutationClassValues = [
  "SURFACE_PRESERVING",
  "SEMANTIC_CHANGING",
] as const;

export type MutationClass = (typeof mutationClassValues)[number];

// ─── Evaluation failure categories (why a case did not pass) ──────────────────

/**
 * The canonical failure categories an evaluation result may be filed under.
 * Keeping them closed is what makes runs comparable across dataset versions
 * and across system versions: a regression in `egyptian-v3` must land in
 * the same bucket it landed in in `egyptian-v1`.
 */
export const failureCategoryValues = [
  "NONE",
  "INTENT_MISCLASSIFIED",
  "ACTION_WRONG",
  "HANDOFF_MISSED",
  "HANDOFF_UNNECESSARY",
  "EXTRACTION_MISSED",
  "EXTRACTION_HALLUCINATED",
  "KNOWLEDGE_NOT_USED",
  "KNOWLEDGE_FABRICATED",
  "CLARIFICATION_NOT_ASKED",
  "CONTEXT_LOST",
  "SAFETY_VIOLATION",
  "MALFORMED_OUTPUT",
  "PROVIDER_FAILURE",
  // ── PROMPT-AI-EVAL-03 additions (additive-only; the runner's scoring
  //    engine files failures under these). Adding a value is the sanctioned
  //    extension path (§10 / §16): historical results stay valid because the
  //    set only grows and the comparison layer ignores unknown values.
  "STATE_TRANSITION_ERROR",
  "BOOKING_JOURNEY_ERROR",
  "AI_FAILURE",
  "OTHER",
] as const;

export type FailureCategory = (typeof failureCategoryValues)[number];

// ─── System identity (what is being evaluated) ────────────────────────────────

/**
 * The subject identity of an evaluation run. This is what lets the SAME
 * dataset score the CURRENT system and a FUTURE system without the dataset
 * changing: only the subject changes. Every member is optional except the
 * kind, so a minimal offline run (deterministic classifier, no provider)
 * still validates.
 *
 * - kind `CURRENT_SYSTEM`  — the shipped production chain (bypass →
 *   assistant → disclosure gate), with `systemVersion` = the FlowPilot
 *   release tag.
 * - kind `FUTURE_SYSTEM`  — an experimental architecture (a new router, a
 *   clarification step, JEV routing) that is NOT production.
 */
export const systemKindValues = ["CURRENT_SYSTEM", "FUTURE_SYSTEM"] as const;
export type SystemKind = (typeof systemKindValues)[number];
