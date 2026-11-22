/**
 * Customer disclosure gate (PROMPT-B03 / ISS-012) — the enforcement boundary between
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
 *   blacklist, no regex redaction, no "leak detector", and no lexical overlap score.
 *   The decision is made from the structured `AiResponse` (its `action`, `intent`,
 *   and structured source reference `knowledgeRef`/`sourceId`) plus the
 *   ledger's typed per-fact verdicts.
 * - Server-Authoritative Rendering (ISS-012): For accepted knowledge answers,
 *   the customer-visible content is rendered authoritatively from the validated
 *   source (FAQ answer, formatted service price, stored about/address, catalog list).
 *   Arbitrary model prose is never emitted merely because some source exists.
 * - Fail-closed behavior (binding): an unknown reference, unpriced service,
 *   missing knowledge, forbidden fact, or excluded family yields `requires-human`
 *   with a typed reason and transitions safely to canonical human handoff.
 */

import type { ContextFactRecord } from "@/features/conversations/server/ai-context-builder";
import {
  knowledgeFamilyValues,
  synthesizeDecisionGoals,
  type AiGoal,
  type AiIntent,
  type AiRequest,
  type AiResponse,
  type DisclosureProposalStatus,
  type KnowledgeFamily,
  type KnowledgeScope,
  type ProposedKnowledgeFamilyObservation,
} from "@/features/conversations/server/ai-contract";
import {
  buildBusinessAboutContent,
  buildBusinessAddressContent,
  buildBusinessIdentityContent,
  buildServiceCatalogContent,
  buildServiceCatalogPriceContent,
  buildServiceDescriptionContent,
  buildServicePriceContent,
} from "@/features/conversations/server/conversation-ai";

export {
  buildBusinessAboutContent,
  buildBusinessAddressContent,
  buildBusinessIdentityContent,
  buildServiceCatalogContent,
  buildServiceCatalogPriceContent,
  buildServiceDescriptionContent,
  buildServicePriceContent,
};

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
  /**
   * The proposal supplied a structured family label outside the canonical
   * machine vocabulary. Fails closed with a distinct diagnostic instead of
   * being conflated with an excluded ledger family.
   */
  "UNKNOWN_KNOWLEDGE_FAMILY",
  /**
   * The proposal matched multiple distinct records or supplied conflicting
   * references (ISS-012). Fails closed rather than arbitrarily guessing.
   */
  "AMBIGUOUS_MATCH",
] as const;

export type DisclosureRefusalReason =
  (typeof DISCLOSURE_REFUSAL_REASONS)[number];

// ─── Task → support family (reuses the B-02 ledger keys verbatim) ────────────

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
  readonly family: KnowledgeFamily | null;
  /** The `AiRequest` field that carries the family, if any. */
  readonly channel: SupportChannel;
};

/** The canonical family → request-channel map (single source for resolution). */
const CANONICAL_KNOWLEDGE_FAMILY_CHANNELS: Readonly<
  Record<KnowledgeFamily, SupportChannel>
> = {
  "business.identity": "businessName",
  "business.address": "businessAddress",
  "business.about": "businessAbout",
  "business.faqs": "faqs",
  "service.name": "serviceNames",
  "service.price": "services",
  "service.description": "serviceDescriptions",
  "domain.availability": "availability",
  "business.cancellationPolicy": null,
};

/**
 * Bounded source-reference outcome for one refusal. It never carries the raw
 * source id: the operator only learns whether a reference was required and
 * missing, matched a carried source, or could not be resolved unambiguously.
 */
export const DISCLOSURE_SOURCE_REFERENCE_VALUES = [
  /** The family requires a source reference, but none was supplied. */
  "NONE",
  /** The supplied reference matched exactly one carried source. */
  "MATCHED",
  /** A reference was supplied but matched no carried source. */
  "UNKNOWN",
  /** A reference matched multiple carried sources. */
  "AMBIGUOUS",
  /** The family/scope is aggregate or does not require a source reference. */
  "NOT_APPLICABLE",
] as const;

export type DisclosureSourceReference =
  (typeof DISCLOSURE_SOURCE_REFERENCE_VALUES)[number];

/**
 * Bounded operator evidence for ONE disclosure refusal. It never carries the
 * raw model label, reply text, source id, source content, customer text or a
 * secret: `unknownFamily`/`conflict`/`missing` are collapsed into the closed
 * `proposalStatus`, only a canonical family (or the closed `UNKNOWN` sentinel)
 * is exposed, and `sourceReference` reports only the reference OUTCOME.
 */
export type DisclosureRefusalDiagnostics = {
  /** The validated declared intent that proposed the reply. */
  readonly declaredIntent: AiIntent;
  /** How the structured family proposal resolved. */
  readonly proposalStatus: DisclosureProposalStatus;
  /** Canonical resolved family, the closed UNKNOWN sentinel, or null. */
  readonly proposedFamily: ProposedKnowledgeFamilyObservation;
  /** Typed scope of the resolved proposal (single/catalog), when declared. */
  readonly proposedScope: KnowledgeScope | null;
  /** Bounded source-reference outcome. */
  readonly sourceReference: DisclosureSourceReference;
  /** The relevant ledger record's included verdict, when applicable. */
  readonly ledgerIncluded: boolean | null;
  /** The relevant ledger record's disclosable verdict, when applicable. */
  readonly ledgerDisclosable: boolean | null;
};

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
   * KNOW) and the disclosure ledger (what it may MENTION).
   */
  readonly context: {
    readonly request: AiRequest;
    readonly facts: ReadonlyArray<ContextFactRecord>;
    /**
     * Server-derived tenant scope (trusted, from engine or context builder).
     * Used for validating singleton references against authoritative scope.
     */
    readonly scope?: { readonly businessId: string };
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
      /**
       * Server-authoritative rendered knowledge content (ISS-012).
       * Present for accepted knowledge replies to guarantee unbacked model prose
       * is never emitted to customers.
       */
      readonly renderedContent?: string;
    }
  | {
      readonly kind: "requires-human";
      readonly reason: DisclosureRefusalReason;
      /** Bounded, content-free refinement of the refusal (see above). */
      readonly diagnostics: DisclosureRefusalDiagnostics;
    };

// ─── Internal helpers ────────────────────────────────────────────────────────

/** Does the request actually carry data for this support channel? */
export function channelCarried(
  request: AiRequest,
  channel: SupportChannel,
): boolean {
  switch (channel) {
    case "faqs":
      return request.faqs.length > 0;
    case "availability":
      return (request.availability?.length ?? 0) > 0;
    case "services":
      return request.services.some(
        (service) =>
          typeof service.price === "string" && service.price.trim().length > 0,
      );
    case "businessAbout":
      return (
        typeof request.businessAbout === "string" &&
        request.businessAbout.trim().length > 0
      );
    case "businessAddress":
      return (
        typeof request.businessAddress === "string" &&
        request.businessAddress.trim().length > 0
      );
    case "businessName":
      return (
        typeof request.businessName === "string" &&
        request.businessName.trim().length > 0
      );
    case "serviceDescriptions":
      return request.services.some(
        (service) =>
          typeof service.description === "string" &&
          service.description.trim().length > 0,
      );
    case "serviceNames":
      return request.services.some(
        (service) =>
          typeof service.name === "string" && service.name.trim().length > 0,
      );
    case null:
      return false;
  }
}

/**
 * Pure mapping from a model-proposed requiredKnowledge string onto its canonical support family and channel.
 */
export function supportFamilyForProposedKnowledge(
  key: string,
): TaskSupportFamily | "GENERIC_FAQ" | null {
  const raw = key.trim();
  // Every canonical value resolves to itself, including camelCase keys that a
  // case-insensitive alias check would otherwise miss (cancellationPolicy).
  const canonical = knowledgeFamilyValues.find(
    (family) => family.toLowerCase() === raw.toLowerCase(),
  );
  if (canonical) {
    return {
      family: canonical,
      channel: CANONICAL_KNOWLEDGE_FAMILY_CHANNELS[canonical],
    };
  }
  const norm = raw.toLowerCase();
  switch (norm) {
    case "identity":
      return { family: "business.identity", channel: "businessName" };
    case "address":
      return { family: "business.address", channel: "businessAddress" };
    case "about":
      return { family: "business.about", channel: "businessAbout" };
    case "price":
      return { family: "service.price", channel: "services" };
    case "description":
      return { family: "service.description", channel: "serviceDescriptions" };
    case "service.catalog":
    case "catalog":
      return { family: "service.name", channel: "serviceNames" };
    case "availability":
      return { family: "domain.availability", channel: "availability" };
    case "faq":
    case "none":
      return "GENERIC_FAQ";
    default:
      return null;
  }
}

export type ResolvedKnowledgeProposal = {
  family: KnowledgeFamily | null;
  sourceId: string | null;
  scope: KnowledgeScope | null;
  conflict: boolean;
  invalidFamily: boolean;
  status: DisclosureProposalStatus;
};

function extractEntityProposal(
  entity:
    | {
        knowledgeRef?:
          | string
          | {
              family?: string;
              sourceId?: string | null;
              scope?: KnowledgeScope | null;
            }
          | null;
        sourceId?: string | null;
        requiredKnowledge?: string | null;
      }
    | null
    | undefined,
): {
  family: KnowledgeFamily | null;
  sourceId: string | null;
  scope: KnowledgeScope | null;
  conflict: boolean;
  invalidFamily: boolean;
} {
  let family: KnowledgeFamily | null = null;
  let sourceId: string | null = null;
  let scope: KnowledgeScope | null = null;
  let conflict = false;
  let invalidFamily = false;

  if (!entity) {
    return { family, sourceId, scope, conflict, invalidFamily };
  }

  // 1. knowledgeRef
  if (typeof entity.knowledgeRef === "string") {
    const raw = entity.knowledgeRef.trim();
    const familyCandidate = supportFamilyForProposedKnowledge(raw);
    if (familyCandidate && familyCandidate !== "GENERIC_FAQ") {
      family = familyCandidate.family;
    } else if (familyCandidate === "GENERIC_FAQ") {
      family = "business.faqs";
    } else {
      // A legacy string knowledgeRef is a SOURCE REFERENCE unless it exactly
      // matches one of the established family aliases above. Dots are valid
      // inside source ids ("svc.1"), so they cannot be used to guess that an
      // unknown string is a family label.
      sourceId = raw;
    }
  } else if (entity.knowledgeRef && typeof entity.knowledgeRef === "object") {
    if (entity.knowledgeRef.family) {
      const rawFamily = entity.knowledgeRef.family.trim();
      const familyCandidate = supportFamilyForProposedKnowledge(rawFamily);
      if (familyCandidate && familyCandidate !== "GENERIC_FAQ") {
        family = familyCandidate.family;
      } else if (familyCandidate === "GENERIC_FAQ") {
        family = "business.faqs";
      } else {
        invalidFamily = true;
      }
    }
    if (entity.knowledgeRef.sourceId) {
      sourceId = entity.knowledgeRef.sourceId.trim();
    }
    if (entity.knowledgeRef.scope) {
      scope = entity.knowledgeRef.scope;
    }
  }

  // 2. sourceId
  if (entity.sourceId && typeof entity.sourceId === "string") {
    const rawSourceId = entity.sourceId.trim();
    if (sourceId && sourceId !== rawSourceId) {
      conflict = true;
    } else {
      sourceId = rawSourceId;
    }
  }

  // 3. requiredKnowledge
  if (
    entity.requiredKnowledge &&
    typeof entity.requiredKnowledge === "string"
  ) {
    const rawReq = entity.requiredKnowledge.trim();
    const familyCandidate = supportFamilyForProposedKnowledge(rawReq);
    let reqFamily: KnowledgeFamily | null = null;
    if (familyCandidate && familyCandidate !== "GENERIC_FAQ") {
      reqFamily = familyCandidate.family;
    } else if (familyCandidate === "GENERIC_FAQ") {
      reqFamily = "business.faqs";
    } else {
      invalidFamily = true;
    }
    if (reqFamily) {
      if (family && family !== reqFamily) {
        conflict = true;
      } else {
        family = reqFamily;
      }
    }
  }

  return { family, sourceId, scope, conflict, invalidFamily };
}

/**
 * Extract the structured knowledge family, source reference and typed scope
 * proposal from a response or active goal without inspecting free-text prose.
 */
export function resolveKnowledgeProposal(
  response: AiResponse,
  goal?: AiGoal | null,
): ResolvedKnowledgeProposal {
  const goalProp = extractEntityProposal(goal);
  const respProp = extractEntityProposal(response);

  let conflict = goalProp.conflict || respProp.conflict;
  const invalidFamily = goalProp.invalidFamily || respProp.invalidFamily;

  if (
    goalProp.family &&
    respProp.family &&
    goalProp.family !== respProp.family
  ) {
    conflict = true;
  }
  if (
    goalProp.sourceId &&
    respProp.sourceId &&
    goalProp.sourceId !== respProp.sourceId
  ) {
    conflict = true;
  }
  if (goalProp.scope && respProp.scope && goalProp.scope !== respProp.scope) {
    conflict = true;
  }

  const family = goalProp.family ?? respProp.family ?? null;
  const sourceId = goalProp.sourceId ?? respProp.sourceId ?? null;
  const scope = goalProp.scope ?? respProp.scope ?? null;

  // Scope is only meaningful for the service-price family. `catalog` is an
  // aggregate scope and therefore cannot also carry a single source id;
  // either contradiction fails closed rather than guessing intent.
  if (scope && family) {
    if (family !== "service.price") conflict = true;
    else if (scope === "catalog" && sourceId) conflict = true;
  }

  const status: DisclosureProposalStatus = conflict
    ? "CONFLICT"
    : invalidFamily
      ? "UNKNOWN_FAMILY"
      : family
        ? "RESOLVED"
        : "MISSING";

  return { family, sourceId, scope, conflict, invalidFamily, status };
}

/**
 * Determine whether a goal explicitly targets business identity via the canonical machine signal.
 */
export function isExplicitIdentityGoal(
  goal: AiGoal | null | undefined,
): boolean {
  return (
    goal?.kind === "ANSWER" && goal.requiredKnowledge === "business.identity"
  );
}

/**
 * Determine whether a response explicitly declares an identity answer.
 */
export function isExplicitIdentityResponse(response: AiResponse): boolean {
  const goals = synthesizeDecisionGoals(response);
  const primaryAnswerGoal =
    goals.find((g) => g.kind === "ANSWER") ?? goals[0] ?? null;
  return isExplicitIdentityGoal(primaryAnswerGoal);
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

  // Diagnostics accumulate as the structural proposal is resolved. They are
  // closed machine values only: no raw model label, reply text or source id.
  let proposalStatus: DisclosureProposalStatus = "MISSING";
  let proposedFamily: ProposedKnowledgeFamilyObservation = null;
  let proposedScope: KnowledgeScope | null = null;

  const refuse = (
    reason: DisclosureRefusalReason,
    record?: ContextFactRecord | null,
    sourceReference: DisclosureSourceReference = "NOT_APPLICABLE",
  ): DisclosureResult => ({
    kind: "requires-human",
    reason,
    diagnostics: {
      declaredIntent: response.intent,
      proposalStatus,
      proposedFamily,
      proposedScope,
      sourceReference,
      ledgerIncluded: record ? record.included : null,
      ledgerDisclosable: record ? record.disclosable : null,
    },
  });

  // ── Invariant: FORBIDDEN material never backs a reply (defense in depth).
  if (ledger.some((fact) => fact.visibility === "FORBIDDEN" && fact.included)) {
    return refuse("FORBIDDEN_FACT_IN_CONTEXT");
  }

  // ── Routing actions are the fallback channel: they disclose no knowledge.
  if (response.action !== "reply") {
    return { kind: "disclosed", response, support: [] };
  }

  // ── A knowledge-free social protocol (GREETING) discloses no knowledge.
  if (isKnowledgeFreeReply(response)) {
    return { kind: "disclosed", response, support: [] };
  }

  // ── A routing intent declaring a `reply` discloses nothing it may stand behind.
  const primarySupport = TASK_SUPPORT_FAMILIES[response.intent];
  if (!primarySupport.family) {
    return refuse("EXCLUDED_FROM_CONTEXT");
  }

  const goals = synthesizeDecisionGoals(response);
  const currentAnswerGoal =
    goals.find((g) => g.kind === "ANSWER") ?? goals[0] ?? null;

  // An explicit identity goal is already represented by the structured
  // proposal resolver. Do NOT overwrite its conflict/unknown verdicts here:
  // contradictory or unrecognized top-level declarations must still fail
  // closed instead of being erased by the identity label.
  const proposal = resolveKnowledgeProposal(response, currentAnswerGoal);
  proposalStatus = proposal.status;
  proposedScope = proposal.scope;
  proposedFamily =
    proposal.status === "RESOLVED"
      ? proposal.family
      : proposal.status === "UNKNOWN_FAMILY"
        ? "UNKNOWN"
        : null;

  if (proposal.conflict) {
    return refuse("AMBIGUOUS_MATCH");
  }
  if (proposal.invalidFamily) {
    return refuse("UNKNOWN_KNOWLEDGE_FAMILY");
  }
  if (!proposal.family) {
    return refuse("UNAVAILABLE_IN_REQUEST");
  }

  // ── Unambiguous structured knowledge-family/operation selection
  switch (proposal.family) {
    case "business.identity": {
      const record = ledger.find(
        (f) => f.key === "business.identity" || f.key === "business.name",
      );
      if (proposal.sourceId) {
        const sId = proposal.sourceId.trim();
        const validRefs = [
          context.request.businessName?.trim(),
          context.scope?.businessId?.trim(),
          "business.identity",
          "business.name",
          "identity",
        ].filter(Boolean);
        if (!validRefs.includes(sId)) {
          return refuse("UNAVAILABLE_IN_REQUEST", record ?? null);
        }
      }
      if (!record || !record.included) {
        return refuse("EXCLUDED_FROM_CONTEXT", record ?? null);
      }
      if (!record.disclosable) {
        return refuse("NOT_DISCLOSABLE", record);
      }
      if (
        !context.request.businessName ||
        context.request.businessName.trim().length === 0
      ) {
        return refuse("UNAVAILABLE_IN_REQUEST", record);
      }
      return {
        kind: "disclosed",
        response,
        support: ["business.identity"],
        renderedContent: buildBusinessIdentityContent(
          context.request.businessName,
        ),
      };
    }
    case "business.address": {
      const record = ledger.find((f) => f.key === "business.address");
      if (proposal.sourceId) {
        const sId = proposal.sourceId.trim();
        const validRefs = [
          context.request.businessAddress?.trim(),
          context.scope?.businessId?.trim(),
          "business.address",
          "address",
        ].filter(Boolean);
        if (!validRefs.includes(sId)) {
          return refuse("UNAVAILABLE_IN_REQUEST", record ?? null);
        }
      }
      if (!record || !record.included) {
        return refuse("EXCLUDED_FROM_CONTEXT", record ?? null);
      }
      if (!record.disclosable) {
        return refuse("NOT_DISCLOSABLE", record);
      }
      if (
        !context.request.businessAddress ||
        context.request.businessAddress.trim().length === 0
      ) {
        return refuse("UNAVAILABLE_IN_REQUEST", record);
      }
      return {
        kind: "disclosed",
        response,
        support: ["business.address"],
        renderedContent: buildBusinessAddressContent(
          context.request.businessAddress,
        ),
      };
    }
    case "business.about": {
      const record = ledger.find((f) => f.key === "business.about");
      if (proposal.sourceId) {
        const sId = proposal.sourceId.trim();
        const validRefs = [
          context.request.businessAbout?.trim(),
          context.scope?.businessId?.trim(),
          "business.about",
          "about",
        ].filter(Boolean);
        if (!validRefs.includes(sId)) {
          return refuse("UNAVAILABLE_IN_REQUEST", record ?? null);
        }
      }
      if (!record || !record.included) {
        return refuse("EXCLUDED_FROM_CONTEXT", record ?? null);
      }
      if (!record.disclosable) {
        return refuse("NOT_DISCLOSABLE", record);
      }
      if (
        !context.request.businessAbout ||
        context.request.businessAbout.trim().length === 0
      ) {
        return refuse("UNAVAILABLE_IN_REQUEST", record);
      }
      return {
        kind: "disclosed",
        response,
        support: ["business.about"],
        renderedContent: buildBusinessAboutContent(
          context.request.businessAbout,
        ),
      };
    }
    case "service.name": {
      const record = ledger.find((f) => f.key === "service.name");
      if (!record || !record.included) {
        return refuse("EXCLUDED_FROM_CONTEXT", record ?? null);
      }
      if (!record.disclosable) {
        return refuse("NOT_DISCLOSABLE", record);
      }
      if (context.request.services.length === 0) {
        return refuse("UNAVAILABLE_IN_REQUEST", record);
      }
      if (proposal.sourceId) {
        const sId = proposal.sourceId.trim();
        const catalogRefs = [
          "service.catalog",
          "service.name",
          "catalog",
          "services",
          context.scope?.businessId?.trim(),
        ].filter(Boolean);
        if (!catalogRefs.includes(sId)) {
          const matches = context.request.services.filter(
            (s) => s.id === sId || s.name.trim() === sId,
          );
          if (matches.length === 0) {
            return refuse("UNAVAILABLE_IN_REQUEST", record, "UNKNOWN");
          }
          if (matches.length > 1) {
            return refuse("AMBIGUOUS_MATCH", record, "AMBIGUOUS");
          }
          return {
            kind: "disclosed",
            response,
            support: ["service.name"],
            renderedContent: buildServiceCatalogContent([matches[0]!]),
          };
        }
      }
      return {
        kind: "disclosed",
        response,
        support: ["service.name"],
        renderedContent: buildServiceCatalogContent(context.request.services),
      };
    }
    case "service.price": {
      const aggregateRecord = ledger.find((f) => f.key === "service.price");

      // Catalog scope is an explicit, typed aggregate request: the model
      // declared that the customer asked for the whole service catalog with
      // prices. The gate renders ONLY the carried, tenant-proven, active
      // services (the builder already excluded foreign/inactive rows) and
      // states a missing stored price truthfully. A single source id is
      // never accepted for this aggregate scope.
      if (proposal.scope === "catalog") {
        if (proposal.sourceId) {
          return refuse("AMBIGUOUS_MATCH", aggregateRecord ?? null);
        }
        if (context.request.services.length === 0) {
          return refuse(
            "UNAVAILABLE_IN_REQUEST",
            aggregateRecord ?? null,
            "NOT_APPLICABLE",
          );
        }
        if (!aggregateRecord || !aggregateRecord.included) {
          return refuse(
            "EXCLUDED_FROM_CONTEXT",
            aggregateRecord ?? null,
            "NOT_APPLICABLE",
          );
        }
        if (!aggregateRecord.disclosable) {
          return refuse("NOT_DISCLOSABLE", aggregateRecord, "NOT_APPLICABLE");
        }
        return {
          kind: "disclosed",
          response,
          support: ["service.price"],
          renderedContent: buildServiceCatalogPriceContent(
            context.request.services,
          ),
        };
      }

      // Single-service scope (the established contract): one EXACT opaque
      // service id must match one carried service.
      if (!proposal.sourceId) {
        return refuse(
          "UNAVAILABLE_IN_REQUEST",
          aggregateRecord ?? null,
          "NONE",
        );
      }
      const sId = proposal.sourceId.trim();
      // The model must reference the EXACT opaque service id exposed in the
      // request. A service name is never accepted as an id fallback.
      const matches = context.request.services.filter((s) => s.id === sId);
      if (matches.length === 0) {
        return refuse(
          "UNAVAILABLE_IN_REQUEST",
          aggregateRecord ?? null,
          "UNKNOWN",
        );
      }
      if (matches.length > 1) {
        return refuse("AMBIGUOUS_MATCH", aggregateRecord ?? null, "AMBIGUOUS");
      }
      const matchedService = matches[0]!;
      const record = ledger.find(
        (f) =>
          f.key === "service.price" ||
          f.key === `service.price:${matchedService.id}`,
      );
      if (
        typeof matchedService.price !== "string" ||
        matchedService.price.trim().length === 0
      ) {
        return refuse("UNAVAILABLE_IN_REQUEST", record ?? null, "MATCHED");
      }
      if (!record || !record.included) {
        return refuse("EXCLUDED_FROM_CONTEXT", record ?? null, "MATCHED");
      }
      if (!record.disclosable) {
        return refuse("NOT_DISCLOSABLE", record, "MATCHED");
      }
      return {
        kind: "disclosed",
        response,
        support: ["service.price"],
        renderedContent: buildServicePriceContent(
          matchedService.name,
          matchedService.price,
        ),
      };
    }
    case "service.description": {
      const aggregateRecord = ledger.find(
        (f) => f.key === "service.description",
      );
      if (!proposal.sourceId) {
        return refuse(
          "UNAVAILABLE_IN_REQUEST",
          aggregateRecord ?? null,
          "NONE",
        );
      }
      const sId = proposal.sourceId.trim();
      const matches = context.request.services.filter(
        (s) => s.id === sId || s.name.trim() === sId,
      );
      if (matches.length === 0) {
        return refuse(
          "UNAVAILABLE_IN_REQUEST",
          aggregateRecord ?? null,
          "UNKNOWN",
        );
      }
      if (matches.length > 1) {
        return refuse("AMBIGUOUS_MATCH", aggregateRecord ?? null, "AMBIGUOUS");
      }
      const matchedService = matches[0]!;
      const record = ledger.find(
        (f) =>
          f.key === "service.description" ||
          f.key === `service.description:${matchedService.id}`,
      );
      if (
        typeof matchedService.description !== "string" ||
        matchedService.description.trim().length === 0
      ) {
        return refuse("UNAVAILABLE_IN_REQUEST", record ?? null, "MATCHED");
      }
      if (!record || !record.included) {
        return refuse("EXCLUDED_FROM_CONTEXT", record ?? null, "MATCHED");
      }
      if (!record.disclosable) {
        return refuse("NOT_DISCLOSABLE", record, "MATCHED");
      }
      return {
        kind: "disclosed",
        response,
        support: ["service.description"],
        renderedContent: buildServiceDescriptionContent(
          matchedService.name,
          matchedService.description,
        ),
      };
    }
    case "business.faqs": {
      const record = ledger.find((f) => f.key === "business.faqs");
      if (!proposal.sourceId) {
        return refuse("UNAVAILABLE_IN_REQUEST", record ?? null, "NONE");
      }
      if (!record || !record.included) {
        return refuse("EXCLUDED_FROM_CONTEXT", record ?? null);
      }
      if (!record.disclosable) {
        return refuse("NOT_DISCLOSABLE", record);
      }
      const sId = proposal.sourceId.trim();
      const matches = context.request.faqs.filter(
        (f) => (f.id && f.id === sId) || f.question.trim() === sId,
      );
      if (matches.length === 0) {
        return refuse("UNAVAILABLE_IN_REQUEST", record, "UNKNOWN");
      }
      if (matches.length > 1) {
        return refuse("AMBIGUOUS_MATCH", record, "AMBIGUOUS");
      }
      const matchedFaq = matches[0]!;
      if (!matchedFaq.answer || matchedFaq.answer.trim().length === 0) {
        return refuse("UNAVAILABLE_IN_REQUEST", record, "MATCHED");
      }
      return {
        kind: "disclosed",
        response,
        support: ["business.faqs"],
        renderedContent: matchedFaq.answer.trim(),
      };
    }
    case "domain.availability": {
      const record = ledger.find((f) => f.key === "domain.availability");
      if (!record || !record.included) {
        // No domain-computed availability was carried for this turn.
        return refuse("UNAVAILABLE_IN_REQUEST", record ?? null);
      }
      // Availability is DOMAIN-owned. Even when it was carried, a
      // model-authored reply must never re-author or invent slots; the
      // existing domain booking/availability path owns that response.
      return refuse("NOT_DISCLOSABLE", record);
    }
    case "business.cancellationPolicy": {
      // No AiRequest channel exists for this CONDITIONAL family today; the
      // existing cancellation/reschedule handoff path remains authoritative.
      const record = ledger.find(
        (f) => f.key === "business.cancellationPolicy",
      );
      return refuse("UNAVAILABLE_IN_REQUEST", record ?? null);
    }
    default: {
      // Defense in depth: a canonical family that this switch does not know
      // is still classified as an unknown family, never as a ledger exclusion.
      proposalStatus = "UNKNOWN_FAMILY";
      proposedFamily = "UNKNOWN";
      return refuse("UNKNOWN_KNOWLEDGE_FAMILY");
    }
  }
}

// ─── Static invariants ───────────────────────────────────────────────────────

/**
 * The gate holds no secrets by construction: it consumes only the validated
 * contract response and the builder's ledger, neither of which can carry a
 * credential reference or value (FORBIDDEN facts are refused upstream). It
 * never reads `process.env`, never touches Prisma, and never calls a
 * provider. It also never holds reply-borne text as policy input — the
 * decision is structural (action + intent + ledger verdicts + source references),
 * never free-text regex or token overlap.
 */
export const DISCLOSURE_GATE_NEVER_HOLDS_SECRETS = true as const;
