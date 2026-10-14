/**
 * Turn observability seam (PROMPT-AI-ARCH-02 — Slice 0).
 *
 * Structured, additive observables for the target AI decision architecture,
 * projected from data the EXISTING execution path already has. This module
 * adds NO inference, NO provider awareness, NO domain authority, and NO
 * behavior: it is a pure, total projection of an already-finished turn.
 *
 * What it may carry (machine keys / closed classifications only):
 *   routingDecision · goals[] · turnPlan · clarification · handoffCause ·
 *   factUpdates · knowledgeSourceClass · provider · model · fallbackUsed ·
 *   retryCount · latencyMs · stateTransition
 *
 * What it must NEVER carry (binding):
 *   secrets · authorization headers · raw provider payloads · prompt bodies ·
 *   message content · chain-of-thought. The builder copies only the contract's
 *   bounded decision labels, closed machine keys, and already-sanitized
 *   telemetry counters; it never copies `content`, prompts, or raw provider
 *   bodies.
 *
 * The record is a plain value attached to the engine's existing success
 * result (`InboundSuccess.observability?`). It is NOT a new telemetry product:
 * no table, no queue, no external call, no persistence, no extra model call.
 *
 * Docs: `docs/ai/TARGET_ARCHITECTURE.md §14/§15`, `docs/ai/ARCHITECTURE.md`.
 */

import type {
  AiClarification,
  AiFactUpdate,
  AiGoal,
  AiHandoffCause,
  AiResponse,
  AiTurnPlan,
} from "@/features/conversations/server/ai-contract";
import {
  synthesizeDecisionGoals,
  synthesizeTurnPlan,
} from "@/features/conversations/server/ai-contract";
import type { JevSemanticEvidence } from "@/server/integrations/ai/jev-semantic-strategy";

/** Where the turn's decision came from (target §14 `routingDecision`). */
export const aiRoutingDecisionValues = [
  /** Answered with no model call (greeting / too-short bypass). */
  "DETERMINISTIC_BYPASS",
  /** The deterministic assistant answered with no provider call. */
  "DETERMINISTIC",
  /** A future JEV strategy produced the decision. */
  "JEV",
  /** A provider adapter produced the decision (the normal LLM turn). */
  "LLM",
  /** No decision ran (e.g. the thread was deferred to staff / duplicated). */
  "NONE",
] as const;

export type AiRoutingDecision = (typeof aiRoutingDecisionValues)[number];

/** A state transition already observable on the turn (later slices populate). */
export type TurnStateTransitionObservation = {
  readonly from?: string;
  readonly to?: string;
  readonly factKey?: string;
  readonly isRevision?: boolean;
};

/**
 * Which knowledge channels the assembled `AiRequest` actually carried this
 * turn (PROMPT-AI-OPS-22). A bounded, machine-safe projection of the B-02
 * context decision: counters and presence booleans ONLY — never a value,
 * never message content. This is what makes "was the expected context
 * available?" answerable from evidence instead of inference.
 */
export type TurnContextChannels = {
  readonly servicesCount: number;
  readonly addressPresent: boolean;
  readonly aboutPresent: boolean;
  readonly faqPresent: boolean;
  readonly pricePresent: boolean;
  readonly availabilityPresent: boolean;
};

/**
 * The B-03 disclosure gate's decision for this turn (PROMPT-AI-OPS-22), when
 * the gate was consulted. `channel` is the support family / request channel
 * key that backed (or failed to back) the reply; `allowed` is the gate's
 * verdict; `refusalReason` is present only on a refusal. Closed machine keys
 * only — never reply text, never policy internals surfaced to a customer.
 */
export type TurnDisclosureObservation = {
  readonly channel: string;
  readonly allowed: boolean;
  readonly refusalReason?: string;
};

/**
 * The NON-AUTHORITATIVE shadow JEV evidence projected from the
 * `AiTelemetry.shadow` slot (PROMPT-AI-JEV-03D — OPTION E). Pure projection:
 * it re-labels closed keys the shadow already produced and Derives the
 * DISJOINT `shadowModelCallCount` (0|1) from the shadow's own
 * `jevCallSpent`. It never influences any decision, and it is the projection
 * the turn-evidence record flattens into its bounded `shadow*` keys.
 *
 * Language / dialect precision (binding): `languageHint` is a Unicode
 * script-block key ∈ {ar, en, mixed}. It CANNOT distinguish Egyptian Arabic
 * from MSA and no dialect accuracy is claimed from it; the design measures
 * the CONSEQUENCE of language variation, not dialect identity.
 */
export type TurnShadowObservation = {
  /** The role discriminator; always "SHADOW" on this slot. */
  readonly evidenceRole: string;
  /** True iff the shadow eligibility gate selected the JEV route for the turn. */
  readonly selected: boolean;
  /** True iff the deterministic sampler admitted this turn. */
  readonly sampled: boolean;
  /** The shadow outcome class (audit only), or the ineligibility/not-sampled reason. */
  readonly resultClass: string;
  /** True iff a shadow network attempt was actually spent this turn. */
  readonly jevCallSpent: boolean;
  /**
   * The DISJOINT shadow model-call count (0|1). This NEVER contributes to the
   * authoritative `modelCallCount` — a shadowed generative turn reads
   * modelCallCount=1 (serving) and shadowModelCallCount=1 (evidence), so the
   * allowed experiment can never be confused with the forbidden JEV→LLM
   * serving chain.
   */
  readonly shadowModelCallCount: number;
  /** The closed provider failure code, when the shadow attempt failed. */
  readonly failureCode: string | null;
  /** The model id the shadow provider reported (machine key). */
  readonly servedModel: string | null;
  /** The script-block language hint ∈ {ar, en, mixed} — NOT a dialect classifier. */
  readonly languageHint: string | null;
  /** The confidence band of the decisive facts (P3; reporting only). */
  readonly confidence: string;
  /** The contact-vs-book boundary indicator. */
  readonly contactVsBook: boolean;
  /** True iff the shadow proposed the bounded contact-vs-book clarification. */
  readonly clarifyContactOrBookProposed: boolean;
  /**
   * The handoff agreement classification vs the deterministic lexical
   * baseline: SEMANTIC_ONLY_HANDOFF is the false-handoff proxy,
   * LEXICAL_ONLY_HANDOFF the missed-human proxy.
   */
  readonly handoffAgreement: string;
  /** The conversationGoal selection (non-authoritative evidence only). */
  readonly conversationGoal: string | null;
  /** The shadow evaluation's own reported latency (ms). */
  readonly latencyMs: number | null;
  /** The derived semantic facts as closed booleans. */
  readonly facts: Readonly<Record<string, boolean>>;
  /** The sanitized probabilities the model returned (evidence only). */
  readonly probabilities: Readonly<Record<string, number>>;
  /** The shared server precedence inputs + the derivation that fired. */
  readonly precedence: {
    readonly supportRequest: boolean;
    readonly providerRequest: boolean;
    readonly bookingTask: boolean;
    readonly explicitHuman: boolean;
    readonly derivation: string;
  };
  /** The evidence bucket (default OBSERVATION). */
  readonly bucket: string;
  /** The closed reason an eligible turn was NOT sampled, when applicable. */
  readonly notSampledReason: string | null;
};

/**
 * Project a SHADOW-marked evidence block into its observability record.
 * Pure and total; no I/O, no inference, no re-derivation of any business
 * formula. `shadowModelCallCount` is derived HERE so the authoritative
 * `modelCallCount` never needs to know the shadow slot exists.
 */
export function projectShadowEvidence(
  evidence: JevSemanticEvidence,
): TurnShadowObservation {
  return {
    evidenceRole: evidence.evidenceRole ?? "AUTHORITATIVE",
    selected: evidence.selected,
    sampled: evidence.sampled ?? true,
    resultClass: evidence.resultClass,
    jevCallSpent: evidence.jevCallSpent,
    shadowModelCallCount: evidence.jevCallSpent ? 1 : 0,
    failureCode: evidence.failureCode,
    servedModel: evidence.servedModel,
    languageHint: evidence.languageHint ?? null,
    confidence: evidence.confidence,
    contactVsBook: evidence.contactVsBook,
    clarifyContactOrBookProposed: evidence.clarifyContactOrBookProposed,
    handoffAgreement: evidence.handoffAgreement,
    conversationGoal: evidence.conversationGoal?.selection ?? null,
    latencyMs: evidence.latencyMs ?? null,
    facts: evidence.facts,
    probabilities: evidence.probabilities,
    precedence: { ...evidence.precedence },
    bucket: evidence.bucket ?? "OBSERVATION",
    notSampledReason: evidence.notSampledReason ?? null,
  };
}

/**
 * The additive, optional observable record for ONE turn. Every member is
 * optional: a producer that cannot observe a field simply omits it, so the
 * current system populates exactly what its existing seams expose and nothing
 * more.
 */
export type TurnObservability = {
  readonly routingDecision?: AiRoutingDecision;
  readonly goals?: readonly AiGoal[];
  readonly turnPlan?: AiTurnPlan;
  readonly clarification?: AiClarification;
  readonly handoffCause?: AiHandoffCause;
  readonly factUpdates?: readonly AiFactUpdate[];
  /**
   * The DOMAIN/booking goal(s) a turn PRESERVED for continuation
   * (PROMPT-AI-ARCH-09 — Slice 5). Populated only on an answer-and-continue
   * turn; absent otherwise. Machine labels only (the same bounded `AiGoal`),
   * never customer content.
   */
  readonly pendingGoals?: readonly AiGoal[];
  /** True on an answer-and-continue turn (knowledge answered, domain pending). */
  readonly answerAndContinue?: boolean;
  /**
   * The B-01/B-02 source classes of the facts that actually entered context
   * (closed `KnowledgeFactSource` machine keys — never content).
   */
  readonly knowledgeSourceClass?: readonly string[];
  /** Provider identity (machine key) when already known. */
  readonly provider?: string;
  /** Model identity (machine key) when already known. */
  readonly model?: string;
  readonly fallbackUsed?: boolean;
  readonly retryCount?: number;
  readonly latencyMs?: number;
  readonly stateTransition?: TurnStateTransitionObservation;
  /**
   * The JEV decision the gateway strategy made for this turn
   * (PROMPT-AI-ARCH-17 — Slice 8). Absent when no JEV strategy was configured.
   * Closed machine keys only (`mode` / `reason`) — never content, provider
   * identity, or chain-of-thought, and never customer-visible.
   */
  readonly jev?: {
    readonly mode: "DETERMINISTIC" | "GENERATIVE";
    readonly reason: string;
    /**
     * The semantic evidence block (PROMPT-AI-JEV-03B §12). Present only when a
     * semantic JEV strategy produced a reading for this turn. Closed machine
     * keys only — derived facts, sanitized probabilities, the shared precedence
     * derivation, the contact-vs-book boundary and the resolver signals. Never
     * content, provider raw output, secrets, or chain-of-thought.
     */
    readonly semantic?: unknown;
  } | null;
  /**
   * The NON-AUTHORITATIVE shadow JEV evaluation for this turn
   * (PROMPT-AI-JEV-03D — OPTION E). Present only when a shadow strategy was
   * installed. Closed machine keys only — never content, provider raw output,
   * secrets, or chain-of-thought — and read by NOTHING on any decision,
   * resolver, routing or transport path: pure comparison evidence for a future
   * promotion gate.
   */
  readonly shadow?: TurnShadowObservation | null;
  /**
   * ONE correlation id for the whole inbound turn (PROMPT-AI-OPS-22): born at
   * turn start, carried on every downstream observation of the same turn so a
   * single finished turn is traceable end-to-end. Opaque, random, and carries
   * no business or customer meaning.
   */
  readonly traceId?: string;
  /**
   * The B-02 task-relevance families that armed this turn
   * (PROMPT-AI-OPS-22) — the deterministic, text-derived family names only
   * (e.g. `serviceCatalog` / `contactOrIdentity`), never the message text.
   */
  readonly taskRelevance?: readonly string[];
  /** Which knowledge channels the request carried (PROMPT-AI-OPS-22). */
  readonly contextChannels?: TurnContextChannels;
  /** The B-03 gate's verdict, when the gate was consulted (PROMPT-AI-OPS-22). */
  readonly disclosure?: TurnDisclosureObservation;
  /** Number of physical provider attempts in this turn (0 = no call spent). */
  readonly providerAttempts?: number;
  /** Provider outcome for the turn; `NOT_CALLED` for a deterministic turn. */
  readonly providerStatus?: "SUCCESS" | "FAILURE" | "NOT_CALLED";
  /** Whether `parseAiResponse` accepted the provider output. */
  readonly parseSuccess?: boolean;
  /**
   * The TOTAL LOGICAL MODEL-CALL COUNT for the turn, JEV + generative
   * (PROMPT-AI-JEV-03B §12). 0 for a deterministic turn; 1 for an ordinary
   * generative turn; 1 for a semantic JEV turn that spent one JEV inference
   * (even though the generative provider's attempt trace is empty). This is the
   * counter that makes the 0/1 model-call invariant measurable end-to-end.
   */
  readonly modelCallCount?: number;
  /**
   * True when the ONE resolver PRESERVED a pending task by re-asking its
   * bounded clarification instead of escalating (precedence rule 6) — the
   * clarification anti-repeat / resume state (PROMPT-AI-JEV-03B §12).
   */
  readonly clarifyAntiRepeat?: boolean;
  /**
   * Input tokens the provider reported for this turn's successful (else last)
   * physical attempt (PROMPT-AI-PERF-02). Copied AS-IS from the existing
   * attempt-level adapter telemetry — never recomputed, never estimated. Absent
   * when the adapter exposes no token telemetry or no provider was consulted;
   * never a fabricated zero.
   */
  readonly inputTokens?: number;
  /** See {@link TurnObservability.inputTokens} — the output-token counterpart. */
  readonly outputTokens?: number;
};

export type BuildTurnObservabilityInput = {
  readonly routingDecision?: AiRoutingDecision;
  /** The validated decision (or a deterministic bypass response). */
  readonly response?: AiResponse | null;
  /**
   * The ordered `TurnPlan` the Decision/Action Resolver produced for this
   * turn (PROMPT-AI-ARCH-05 — Slice 3). When present it OVERRIDES the Slice-0
   * single-goal synthesis so the resolver is the ONE owner of the plan; when
   * absent, the plan falls back to the canonical synthesis bridge (unchanged
   * Slice-0 behavior). Still the SAME canonical `AiTurnPlan` — never a second
   * representation.
   */
  readonly turnPlan?: AiTurnPlan | null;
  /**
   * The clarification the Decision/Action Resolver produced for a first-class
   * CLARIFY turn (PROMPT-AI-ARCH-06 — Slice 4). When present it OVERRIDES the
   * decision's own proposed `clarification`, so the resolver stays the ONE
   * owner of the emitted clarification. Machine keys only (`type`,
   * `missingFacts`) — never the customer-facing question text.
   */
  readonly clarification?: AiClarification | null;
  readonly provider?: string | null;
  readonly model?: string | null;
  readonly fallbackUsed?: boolean;
  readonly retryCount?: number;
  readonly latencyMs?: number;
  readonly knowledgeSourceClass?: readonly string[] | null;
  readonly stateTransition?: TurnStateTransitionObservation | null;
  /**
   * The DOMAIN/booking goal(s) the resolver preserved for continuation on an
   * answer-and-continue turn (PROMPT-AI-ARCH-09 — Slice 5). Absent otherwise.
   */
  readonly pendingGoals?: readonly AiGoal[] | null;
  /** True on an answer-and-continue turn. */
  readonly answerAndContinue?: boolean;
  /** The JEV gateway decision (Slice 8) — closed machine keys, audit-only. */
  jev?: {
    readonly mode: "DETERMINISTIC" | "GENERATIVE";
    readonly reason: string;
    /** The semantic evidence block (PROMPT-AI-JEV-03B §12), when produced. */
    readonly semantic?: unknown;
  } | null;
  /**
   * The NON-AUTHORITATIVE shadow JEV evidence block (PROMPT-AI-JEV-03D —
   * OPTION E), when a shadow strategy was installed for this turn. Absent ⇒
   * no shadow ran; a SHADOW-marked block (including the pure zero-call
   * not-sampled marker) is projected into the disjoint `shadow` observation.
   */
  shadow?: JevSemanticEvidence | null;
  /** One correlation id for the turn (PROMPT-AI-OPS-22). */
  traceId?: string | null;
  /** Armed task-relevance family names (PROMPT-AI-OPS-22). */
  taskRelevance?: readonly string[] | null;
  /** Which knowledge channels the request carried (PROMPT-AI-OPS-22). */
  contextChannels?: TurnContextChannels | null;
  /** The B-03 gate verdict, when consulted (PROMPT-AI-OPS-22). */
  disclosure?: TurnDisclosureObservation | null;
  /** Physical provider attempts this turn (PROMPT-AI-OPS-22). */
  providerAttempts?: number | null;
  /** Provider outcome for the turn (PROMPT-AI-OPS-22). */
  providerStatus?: "SUCCESS" | "FAILURE" | "NOT_CALLED" | null;
  /** Whether `parseAiResponse` accepted the provider output. */
  parseSuccess?: boolean | null;
  /**
   * Input tokens from the turn's successful (else last) attempt's existing
   * adapter telemetry (PROMPT-AI-PERF-02). Null/absent ⇒ no token telemetry
   * was available; never fabricated.
   */
  inputTokens?: number | null;
  /** See {@link BuildTurnObservabilityInput.inputTokens} — output counterpart. */
  outputTokens?: number | null;
  /**
   * The total logical model-call count for the turn, JEV + generative
   * (PROMPT-AI-JEV-03B §12). Copied as-is; never recomputed.
   */
  modelCallCount?: number | null;
  /** Clarification anti-repeat / resume state (PROMPT-AI-JEV-03B §12). */
  clarifyAntiRepeat?: boolean | null;
};

/**
 * Project a finished turn into its observable record. Pure and total: no I/O,
 * no LLM, no env, no DB, no secret. Deterministic — the same input always
 * yields the same record. `goals` / `turnPlan` are derived through the ONE
 * canonical synthesis bridge, so a no-goals decision is observed as exactly
 * one synthesized goal without inventing a second decision model.
 */
export function buildTurnObservability(
  input: BuildTurnObservabilityInput,
): TurnObservability {
  const response = input.response ?? null;
  const goalObserved = response
    ? {
        goals: synthesizeDecisionGoals(response),
        turnPlan: input.turnPlan ?? synthesizeTurnPlan(response),
      }
    : input.turnPlan
      ? { turnPlan: input.turnPlan }
      : {};
  return {
    ...(input.routingDecision
      ? { routingDecision: input.routingDecision }
      : {}),
    ...goalObserved,
    ...(input.clarification
      ? { clarification: input.clarification }
      : response?.clarification
        ? { clarification: response.clarification }
        : {}),
    ...(response?.handoffCause ? { handoffCause: response.handoffCause } : {}),
    ...(response?.factUpdates && response.factUpdates.length > 0
      ? { factUpdates: [...response.factUpdates] }
      : {}),
    ...(input.knowledgeSourceClass && input.knowledgeSourceClass.length > 0
      ? { knowledgeSourceClass: [...new Set(input.knowledgeSourceClass)] }
      : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.fallbackUsed !== undefined
      ? { fallbackUsed: input.fallbackUsed }
      : {}),
    ...(input.retryCount !== undefined ? { retryCount: input.retryCount } : {}),
    ...(input.latencyMs !== undefined ? { latencyMs: input.latencyMs } : {}),
    ...(input.stateTransition
      ? { stateTransition: input.stateTransition }
      : {}),
    ...(input.pendingGoals && input.pendingGoals.length > 0
      ? { pendingGoals: [...input.pendingGoals] }
      : {}),
    ...(input.answerAndContinue !== undefined
      ? { answerAndContinue: input.answerAndContinue }
      : {}),
    ...(input.jev ? { jev: input.jev } : {}),
    // PROMPT-AI-JEV-03D — the NON-AUTHORITATIVE shadow slot. Pure projection
    // into the disjoint observation; nothing else in this builder (and nothing
    // anywhere on a decision path) reads the shadow evidence.
    ...(input.shadow ? { shadow: projectShadowEvidence(input.shadow) } : {}),
    ...(input.traceId ? { traceId: input.traceId } : {}),
    ...(input.taskRelevance && input.taskRelevance.length > 0
      ? { taskRelevance: [...input.taskRelevance] }
      : {}),
    ...(input.contextChannels
      ? { contextChannels: input.contextChannels }
      : {}),
    ...(input.disclosure ? { disclosure: input.disclosure } : {}),
    ...(input.providerAttempts !== undefined && input.providerAttempts !== null
      ? { providerAttempts: input.providerAttempts }
      : {}),
    ...(input.providerStatus ? { providerStatus: input.providerStatus } : {}),
    ...(input.parseSuccess !== undefined && input.parseSuccess !== null
      ? { parseSuccess: input.parseSuccess }
      : {}),
    // PROMPT-AI-PERF-02 — the ONE token projection. Copied AS-IS from the
    // attempt-level adapter telemetry the engine already selected (the same
    // success-then-last selection the AI_TURN usage record uses); never
    // recomputed from characters and never estimated. Null ⇒ omitted, so a
    // telemetry-less adapter or a no-call turn carries no fabricated zero.
    ...(input.inputTokens !== undefined && input.inputTokens !== null
      ? { inputTokens: input.inputTokens }
      : {}),
    ...(input.outputTokens !== undefined && input.outputTokens !== null
      ? { outputTokens: input.outputTokens }
      : {}),
    // PROMPT-AI-JEV-03B §12 — the ONE total model-call counter, copied as-is.
    // A semantic JEV turn reports 1 here while `providerAttempts` is 0.
    ...(input.modelCallCount !== undefined && input.modelCallCount !== null
      ? { modelCallCount: input.modelCallCount }
      : {}),
    ...(input.clarifyAntiRepeat ? { clarifyAntiRepeat: true } : {}),
  };
}
