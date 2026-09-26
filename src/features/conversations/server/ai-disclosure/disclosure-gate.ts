/**
 * Customer disclosure gate (PROMPT-B03) — the enforcement boundary between
 * an assistant result and a customer-visible reply.
 *
 *   AiResponse (validated)
 *        ↓
 *   DISCLOSURE GATE   ← this module
 *        ↓
 *   disclosed → the existing reply path (persist + WhatsApp send)
 *   requires-human → the existing NEED_HUMAN / AI_HANDOFF fallback
 *
 * B-01 states the policy ("AI may know this" ≠ "AI may mention this") and
 * B-02 records the verdicts (the disclosure ledger). This module makes that
 * boundary bite at the last moment before a reply becomes customer-visible.
 * It CONSUMES the ledger; it never re-classifies, never re-resolves tenant
 * scope, and never re-derives task relevance — there is exactly one policy
 * (B-01), one builder (B-02) and one tenant-resolution mechanism (the
 * engine's server-derived scope).
 *
 * The gate is structural, not textual (binding):
 * - It never inspects, scores, or rewrites the reply text. There is no word
 *   blacklist, no regex redaction, no "leak detector". The decision is made
 *   from the structured `AiResponse` (its `action` and `intent`) plus the
 *   ledger's typed per-fact verdicts.
 * - A reply the assistant AUTHORS itself (`action: "reply"`) is emitted only
 *   when the task it declares is backed by a fact the policy already marked
 *   `included` AND `disclosable` AND actually carried in the request. An
 *   INTERNAL fact is never disclosable (B-01), so it can never back a reply;
 *   a CONDITIONAL fact is disclosable only when B-02 found the task relevant;
 *   a FORBIDDEN fact is never even enrolled. A reply backed by nothing would
 *   have to be invented — it is routed to a human instead.
 * - A routing action (`handoff` / `booking_handoff`) IS the fallback channel.
 *   It discloses no knowledge, so the gate passes it through and the existing
 *   handoff semantics own the outcome — the AI-first default and the human
 *   fallback both stay exactly as they were.
 *
 * What this module is NOT (binding):
 * - NOT an LLM, NOT a judge, NOT a classifier — it cannot invent, infer, or
 *   rephrase anything. It can only refuse to emit and defer to a human.
 * - NOT a redactor — it never returns edited text; a refused reply is
 *   dropped wholesale (never persisted, never sent).
 * - NOT a policy source — the levels, the field classification, the
 *   provenance rules and the ledger all come from B-01/B-02.
 *
 * Fail-closed behavior (binding): a FORBIDDEN fact that somehow reached
 * context, a support family absent from the ledger, a family present but not
 * disclosable, or a family disclosable but carrying no data in the request —
 * every one of these yields `requires-human` with a typed reason. The gate
 * never guesses, never falls back to "probably fine", and never emits a
 * reply it cannot justify from the ledger.
 *
 * Server-side only: the refusal reasons are diagnostics for operators. They
 * never reach the customer — the customer sees the existing human-handoff
 * experience, and no policy name, provenance, or classification is ever
 * surfaced.
 */

import type { ContextFactRecord } from "@/features/conversations/server/ai-context-builder";
import type {
  AiIntent,
  AiRequest,
  AiResponse,
} from "@/features/conversations/server/ai-contract";

// ─── Decisions (typed, never free text) ─────────────────────────────────────

export const DISCLOSURE_DECISION_VALUES = [
  /** The reply may take the existing customer-visible path. */
  "disclosed",
  /** The reply is dropped; the existing human handoff owns the turn. */
  "requires-human",
] as const;

export type DisclosureDecision = (typeof DISCLOSURE_DECISION_VALUES)[number];

/**
 * Why a reply was refused. Diagnostics for operators/logs only — never
 * rendered into customer output.
 */
export const DISCLOSURE_REFUSAL_REASONS = [
  /**
   * A FORBIDDEN fact is marked included in the ledger. Impossible by
   * construction (B-01 refuses FORBIDDEN candidates at enrollment; B-02
   * records them as excluded). Observing it means a deeper invariant broke,
   * so the gate fails closed rather than emitting anything.
   */
  "FORBIDDEN_FACT_IN_CONTEXT",
  /**
   * The support family is included in the context but NOT disclosable — an
   * INTERNAL fact (known to the AI, unmentionable), or a CONDITIONAL fact
   * outside the task that makes it relevant.
   */
  "NOT_DISCLOSABLE",
  /**
   * The support family was excluded from the context — refused at enrollment
   * (FORBIDDEN / unproven tenant / unknown provenance) or omitted by the
   * builder. There is no knowledge behind the reply.
   */
  "EXCLUDED_FROM_CONTEXT",
  /**
   * The support family is included and disclosable, but the request carries
   * no data for it (an empty knowledge store, or a family with no request
   * channel today). The reply would have to be invented.
   */
  "UNAVAILABLE_IN_REQUEST",
] as const;

export type DisclosureRefusalReason =
  (typeof DISCLOSURE_REFUSAL_REASONS)[number];

// ─── Task → support family (reuses the B-02 ledger keys verbatim) ────────────

/**
 * The single request channel that may carry a support family, if one exists.
 * `null` marks families that are classified and ledgered by B-02 but carry no
 * `AiRequest` channel yet — a reply declaring that task can never be backed
 * today, so it routes to a human rather than being invented.
 */
export type SupportChannel = "faqs" | "availability" | null;

export type TaskSupportFamily = {
  /** The disclosure-ledger key this task draws its answer from. */
  readonly family: string | null;
  /** The `AiRequest` field that carries the family, if any. */
  readonly channel: SupportChannel;
};

/**
 * Which ledger family backs each declared intent. A reply is emitted only
 * when its declared task's family is `included` + `disclosable` + carried.
 * The keys are the exact strings B-02 records, so the gate reads the ledger
 * rather than re-deriving anything.
 *
 * - FAQ answers come from the canonical knowledge store (`business.faqs`,
 *   PUBLIC as a whole — DECISIONS #13).
 * - Booking/availability answers come from the domain-computed result
 *   (`domain.availability`, CONDITIONAL — booking/availability asks only).
 * - Cancellation/reschedule answers would come from `business.cancellationPolicy`
 *   (CONDITIONAL). It is classified and ledgered by B-02 but carries NO
 *   request channel yet — so the assistant cannot answer these tasks itself;
 *   the existing `booking_handoff` routes them to staff. Wiring the channel
 *   is a later product decision, not this slice.
 * - HUMAN_REQUEST / AMBIGUOUS disclose no knowledge: they are the routing
 *   intents. They reach the customer only as handoff actions (the fallback
 *   channel), never as self-authored replies.
 */
/**
 * Intents whose self-authored reply is a KNOWLEDGE-FREE social protocol —
 * a closed, exhaustive list. A reply declaring one of these needs no
 * backing fact because it can disclose nothing: the phrasing is a fixed
 * acknowledgment that never names a service, price, slot, policy, provider,
 * or business fact. The gate passes it by the DECLARED INTENT ONLY — it
 * still never inspects, scores, or rewrites the reply text.
 *
 * `GREETING` (DECISIONS #61) is the single member. The deterministic
 * classifier emits it only for a message that carries NO other intent
 * vocabulary (`isPureGreeting`), so a booking/FAQ/human-request turn can
 * never be answered by it. Extending this list is a disclosure-policy
 * decision, not an implementation detail.
 */
export const KNOWLEDGE_FREE_REPLY_INTENTS: ReadonlyArray<AiIntent> = [
  "GREETING",
];

function isKnowledgeFreeReply(response: AiResponse): boolean {
  return (
    response.action === "reply" &&
    KNOWLEDGE_FREE_REPLY_INTENTS.includes(response.intent)
  );
}

export const TASK_SUPPORT_FAMILIES: Readonly<
  Record<AiIntent, TaskSupportFamily>
> = {
  /**
   * A greeting discloses no knowledge by construction (a fixed social
   * acknowledgment), so it crosses the boundary on its declared intent —
   * never on a fact the assistant was given.
   */
  GREETING: { family: null, channel: null },
  FAQ: { family: "business.faqs", channel: "faqs" },
  BOOKING: { family: "domain.availability", channel: "availability" },
  AVAILABILITY: { family: "domain.availability", channel: "availability" },
  CANCELLATION: {
    family: "business.cancellationPolicy",
    channel: null,
  },
  RESCHEDULE: { family: "business.cancellationPolicy", channel: null },
  HUMAN_REQUEST: { family: null, channel: null },
  AMBIGUOUS: { family: null, channel: null },
};

// ─── Input / output ──────────────────────────────────────────────────────────

export type DisclosureInput = {
  /** The validated assistant result for this turn. */
  readonly response: AiResponse;
  /**
   * The turn's built context: the request the assistant saw (what it may
   * KNOW) and the disclosure ledger (what it may MENTION). Both are
   * builder-side artifacts; neither is customer-visible.
   */
  readonly context: {
    readonly request: AiRequest;
    readonly facts: ReadonlyArray<ContextFactRecord>;
  };
};

export type DisclosureResult =
  | {
      readonly kind: "disclosed";
      /** The reply, unchanged — the gate never edits text. */
      readonly response: AiResponse;
      /**
       * Ledger keys backing the reply (server-side diagnostics only; never
       * rendered into customer output).
       */
      readonly support: readonly string[];
    }
  | {
      readonly kind: "requires-human";
      readonly reason: DisclosureRefusalReason;
    };

// ─── Internal helpers ────────────────────────────────────────────────────────

/** Does the request actually carry data for this support channel? */
function channelCarried(request: AiRequest, channel: SupportChannel): boolean {
  switch (channel) {
    case "faqs":
      return request.faqs.length > 0;
    case "availability":
      return (request.availability?.length ?? 0) > 0;
    case null:
      // No request channel exists for this family today.
      return false;
  }
}

// ─── The gate ────────────────────────────────────────────────────────────────

/**
 * Enforce the customer disclosure boundary for one turn. Pure and total: no
 * I/O, no LLM, no env, no Prisma, no credential. Deterministic — the same
 * response + ledger always yield the same decision. Never throws: every
 * uncertain case resolves to `requires-human` (fail closed).
 */
export function enforceDisclosure(input: DisclosureInput): DisclosureResult {
  const { response, context } = input;
  const ledger = context.facts;

  // ── Invariant: FORBIDDEN material never backs a reply (defense in depth).
  // B-01 refuses such candidates at enrollment, so an included FORBIDDEN fact
  // is unreachable by construction; if it ever appears, nothing is emitted.
  if (ledger.some((fact) => fact.visibility === "FORBIDDEN" && fact.included)) {
    return { kind: "requires-human", reason: "FORBIDDEN_FACT_IN_CONTEXT" };
  }

  // ── Routing actions are the fallback channel: they disclose no knowledge,
  //    so they pass through and the existing handoff semantics own the turn.
  //    (The customer experience and the NEED_HUMAN/AI_HANDOFF contract stay
  //    exactly as designed.)
  if (response.action !== "reply") {
    return { kind: "disclosed", response, support: [] };
  }

  // ── A self-authored reply must be backed by disclosable knowledge.
  const support = TASK_SUPPORT_FAMILIES[response.intent];

  // The one knowledge-free social protocol (DECISIONS #61): a GREETING
  // reply is a fixed acknowledgment that can disclose nothing, so it
  // needs no backing fact. Everything else still requires a ledger fact
  // or it is routed to a human.
  if (isKnowledgeFreeReply(response)) {
    return { kind: "disclosed", response, support: [] };
  }

  // A routing intent declaring a `reply` discloses nothing it may stand
  // behind — there is no knowledge channel for it. Hand it to a human.
  if (!support.family) {
    return { kind: "requires-human", reason: "EXCLUDED_FROM_CONTEXT" };
  }

  const record = ledger.find((fact) => fact.key === support.family);
  if (!record || !record.included) {
    // Excluded at enrollment (FORBIDDEN / unproven tenant / unknown
    // provenance) or omitted by the builder — never reinterpreted as public.
    return { kind: "requires-human", reason: "EXCLUDED_FROM_CONTEXT" };
  }
  if (!record.disclosable) {
    // Known to the AI, unmentionable to the customer (INTERNAL, or a
    // CONDITIONAL fact outside its task). Never emitted merely because the
    // model happened to have it.
    return { kind: "requires-human", reason: "NOT_DISCLOSABLE" };
  }
  if (!channelCarried(context.request, support.channel)) {
    // Disclosable in principle but empty in practice — the reply would have
    // to be invented. Missing provenance lands here too (an unproven fact
    // never reaches the request).
    return { kind: "requires-human", reason: "UNAVAILABLE_IN_REQUEST" };
  }

  return {
    kind: "disclosed",
    response,
    support: [support.family],
  };
}

// ─── Static invariants (referenced by the harness; documented here) ──────────

/**
 * The gate holds no secrets by construction: it consumes only the validated
 * contract response and the builder's ledger, neither of which can carry a
 * credential reference or value (FORBIDDEN facts are refused upstream). It
 * never reads `process.env`, never touches Prisma, and never calls a
 * provider. It also never holds reply-borne text as policy input — the
 * decision is structural (action + intent + ledger verdicts), never textual.
 */
export const DISCLOSURE_GATE_NEVER_HOLDS_SECRETS = true as const;
