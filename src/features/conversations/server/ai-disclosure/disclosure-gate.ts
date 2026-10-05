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
export type SupportChannel =
  | "faqs"
  | "availability"
  | "services"
  | "businessAbout"
  | "businessAddress"
  | "businessName"
  | "serviceDescriptions"
  | "serviceNames"
  | null;

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
 *   PUBLIC as a whole — DECISIONS #13), or additively from a task-gated
 *   Slice-6 channel that is actually carried this turn (service price,
 *   business about, service description — see `candidateSupportFamilies`).
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
    case "services":
      // The service-catalog price channel (PROMPT-AI-ARCH-13 — Slice 6) is
      // carried only when at least one exposed service has a non-empty price
      // string (the context builder exposes it CONDITIONALLY, task-gated). An
      // empty price channel means the reply would invent a price → refused.
      return request.services.some(
        (service) =>
          typeof service.price === "string" && service.price.trim().length > 0,
      );
    case "businessAbout":
      // The PUBLIC business-about channel (PROMPT-AI-ARCH-15 — Slice 6) is
      // carried only when the turn was business-info relevant AND the
      // business carries authoritative about text. An empty channel means the
      // reply would invent a business fact → refused.
      return (
        typeof request.businessAbout === "string" &&
        request.businessAbout.trim().length > 0
      );
    case "businessAddress":
      // The CONDITIONAL business-location channel (PROMPT-AI-OPS-21) is
      // carried only when the turn was contact/identity/location relevant AND
      // the business stored an authoritative address. An empty channel means
      // the reply would invent a location → refused.
      return (
        typeof request.businessAddress === "string" &&
        request.businessAddress.trim().length > 0
      );
    case "businessName":
      // The PUBLIC business-identity channel (PROMPT-AI-UX-02) is carried
      // whenever the canonical Business record's name reached the request —
      // B-02 only forwards it when the record's tenant was PROVEN against the
      // turn's scope, so a foreign or unproven record yields an empty name and
      // this channel stays empty. An empty channel means the business has no
      // authoritative name stored → the reply would invent one → refused.
      return (
        typeof request.businessName === "string" &&
        request.businessName.trim().length > 0
      );
    case "serviceDescriptions":
      // The PUBLIC service-description channel (PROMPT-AI-ARCH-15 — Slice 6) is
      // carried only when the turn was service-info relevant AND at least one
      // exposed service carries an authoritative description. An empty channel
      // means the reply would invent a service detail → refused.
      return request.services.some(
        (service) =>
          typeof service.description === "string" &&
          service.description.trim().length > 0,
      );
    case "serviceNames":
      // The PUBLIC service-catalog NAME channel (PROMPT-AI-OPS-20) is carried
      // whenever at least one service NAME is exposed in the catalog. B-01
      // already declares a service name "AI may mention" and B-02 always
      // carries the names in request.services; this channel lets the gate back
      // a catalog-listing reply from those carried names instead of refusing
      // it. It licenses mentioning the CATALOG ONLY — never a price, location,
      // hour or detail, each of which still requires its own carried channel.
      return request.services.some(
        (service) =>
          typeof service.name === "string" && service.name.trim().length > 0,
      );
    case null:
      // No request channel exists for this family today.
      return false;
  }
}

/**
 * The ordered candidate support families a reply intent may draw its answer
 * from. Almost every intent has exactly ONE (its `TASK_SUPPORT_FAMILIES`
 * entry). FAQ is the exception (PROMPT-AI-ARCH-13/-15 — Slice 6,
 * PROMPT-AI-OPS-20): the fixed intent family has no separate
 * BUSINESS_INFO/SERVICE_INFO/SERVICE_CATALOG intents, so a business-profile,
 * service-detail, price, or services-list question is classified FAQ. A FAQ
 * reply may therefore be backed by the canonical FAQ store OR any of the
 * task-gated Slice-6 channels OR the carried service-catalog names OR the
 * canonical business NAME on an identity ask (PROMPT-AI-UX-02) — whichever is
 * included + disclosable + actually carried. This is purely ADDITIVE: a FAQ
 * reply the store already backs is unchanged, and each channel is carried ONLY
 * on its own relevance gate (`businessAbout` on business-info turns,
 * `serviceDescriptions` on service-info turns, `service.price` on price turns,
 * `business.identity` on identity turns) — so a booking or unrelated turn can
 * never carry them. The catalog-name channel is carried whenever the catalog
 * is exposed (B-01 marks names PUBLIC and B-02 always carries them), and it
 * backs ONLY the mention of those carried names.
 */
function candidateSupportFamilies(intent: AiIntent): TaskSupportFamily[] {
  const primary = TASK_SUPPORT_FAMILIES[intent];
  if (intent === "FAQ") {
    return [
      primary,
      { family: "service.price", channel: "services" },
      { family: "business.about", channel: "businessAbout" },
      { family: "business.address", channel: "businessAddress" },
      { family: "business.identity", channel: "businessName" },
      { family: "service.description", channel: "serviceDescriptions" },
      { family: "service.name", channel: "serviceNames" },
    ];
  }
  return [primary];
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

  // Try each candidate support family in order (FAQ may be backed by the FAQ
  // store OR the task-gated service-price channel — PROMPT-AI-ARCH-13). The
  // reply is disclosed as soon as ONE candidate is included + disclosable +
  // carried. If none qualifies, the PRIMARY family's refusal reason is
  // returned, preserving the existing single-family behavior for every intent
  // other than a price-backed FAQ.
  const candidates = candidateSupportFamilies(response.intent);
  let primaryRefusal: DisclosureRefusalReason | null = null;
  for (const candidate of candidates) {
    if (!candidate.family) continue;
    const record = ledger.find((fact) => fact.key === candidate.family);
    if (!record || !record.included) {
      if (primaryRefusal === null) primaryRefusal = "EXCLUDED_FROM_CONTEXT";
      continue;
    }
    if (!record.disclosable) {
      if (primaryRefusal === null) primaryRefusal = "NOT_DISCLOSABLE";
      continue;
    }
    if (!channelCarried(context.request, candidate.channel)) {
      if (primaryRefusal === null) primaryRefusal = "UNAVAILABLE_IN_REQUEST";
      continue;
    }
    return {
      kind: "disclosed",
      response,
      support: [candidate.family],
    };
  }

  return {
    kind: "requires-human",
    reason: primaryRefusal ?? "EXCLUDED_FROM_CONTEXT",
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
