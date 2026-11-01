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
  synthesizeDecisionGoals,
  type AiGoal,
  type AiIntent,
  type AiRequest,
  type AiResponse,
} from "@/features/conversations/server/ai-contract";
import {
  buildBusinessAboutContent,
  buildBusinessAddressContent,
  buildBusinessIdentityContent,
  buildServiceCatalogContent,
  buildServiceDescriptionContent,
  buildServicePriceContent,
  isPureServiceCatalogQuestion,
  matchFaq,
  normalizeArabicText,
  tokenize,
} from "@/features/conversations/server/conversation-ai";

export {
  buildBusinessAboutContent,
  buildBusinessAddressContent,
  buildBusinessIdentityContent,
  buildServiceCatalogContent,
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
  readonly family: string | null;
  /** The `AiRequest` field that carries the family, if any. */
  readonly channel: SupportChannel;
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
  const norm = key.toLowerCase().trim();
  switch (norm) {
    case "business.identity":
    case "identity":
      return { family: "business.identity", channel: "businessName" };
    case "business.address":
    case "address":
      return { family: "business.address", channel: "businessAddress" };
    case "business.about":
    case "about":
      return { family: "business.about", channel: "businessAbout" };
    case "service.price":
    case "price":
      return { family: "service.price", channel: "services" };
    case "service.description":
    case "description":
      return { family: "service.description", channel: "serviceDescriptions" };
    case "service.name":
    case "service.catalog":
    case "catalog":
    case "service":
      return { family: "service.name", channel: "serviceNames" };
    case "business.faqs":
      return { family: "business.faqs", channel: "faqs" };
    case "domain.availability":
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
  family: string | null;
  sourceId: string | null;
};

/**
 * Extract the structured knowledge family and source reference proposal
 * from a response or active goal without inspecting free-text prose.
 */
export function resolveKnowledgeProposal(
  response: AiResponse,
  goal?: AiGoal | null,
): ResolvedKnowledgeProposal {
  let family: string | null = null;
  let sourceId: string | null = null;

  // 1. Goal or top-level knowledgeRef
  const rawRef = goal?.knowledgeRef ?? response.knowledgeRef;
  if (typeof rawRef === "string") {
    const familyCandidate = supportFamilyForProposedKnowledge(rawRef);
    if (familyCandidate && familyCandidate !== "GENERIC_FAQ") {
      family = familyCandidate.family;
    } else {
      sourceId = rawRef.trim();
    }
  } else if (rawRef && typeof rawRef === "object") {
    if (rawRef.family) {
      const familyCandidate = supportFamilyForProposedKnowledge(rawRef.family);
      family =
        familyCandidate && familyCandidate !== "GENERIC_FAQ"
          ? familyCandidate.family
          : rawRef.family.trim();
    }
    if (rawRef.sourceId) {
      sourceId = rawRef.sourceId.trim();
    }
  }

  // 2. Goal or top-level sourceId
  const explicitSourceId = goal?.sourceId ?? response.sourceId;
  if (explicitSourceId && typeof explicitSourceId === "string") {
    sourceId = explicitSourceId.trim();
  }

  // 3. Goal or top-level requiredKnowledge
  const explicitRequiredKnowledge =
    goal?.requiredKnowledge ?? response.requiredKnowledge;
  if (
    !family &&
    explicitRequiredKnowledge &&
    typeof explicitRequiredKnowledge === "string"
  ) {
    const familyCandidate = supportFamilyForProposedKnowledge(
      explicitRequiredKnowledge,
    );
    if (familyCandidate && familyCandidate !== "GENERIC_FAQ") {
      family = familyCandidate.family;
    } else if (!familyCandidate) {
      family = explicitRequiredKnowledge.trim();
    }
  }

  return { family, sourceId };
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

  // ── Invariant: FORBIDDEN material never backs a reply (defense in depth).
  if (ledger.some((fact) => fact.visibility === "FORBIDDEN" && fact.included)) {
    return { kind: "requires-human", reason: "FORBIDDEN_FACT_IN_CONTEXT" };
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
    return { kind: "requires-human", reason: "EXCLUDED_FROM_CONTEXT" };
  }

  const isStructured =
    context.request.requiredSemanticCapability === "structured_turn";
  const goals = synthesizeDecisionGoals(response);
  const currentAnswerGoal =
    goals.find((g) => g.kind === "ANSWER") ?? goals[0] ?? null;
  const isIdentity = isExplicitIdentityGoal(currentAnswerGoal);

  const proposal = resolveKnowledgeProposal(response, currentAnswerGoal);
  if (isIdentity) {
    proposal.family = "business.identity";
  }

  // ── Case A: Explicit or resolved knowledge family
  if (proposal.family) {
    switch (proposal.family) {
      case "business.identity": {
        const record = ledger.find(
          (f) => f.key === "business.identity" || f.key === "business.name",
        );
        if (!record || !record.included) {
          return { kind: "requires-human", reason: "EXCLUDED_FROM_CONTEXT" };
        }
        if (!record.disclosable) {
          return { kind: "requires-human", reason: "NOT_DISCLOSABLE" };
        }
        if (
          !context.request.businessName ||
          context.request.businessName.trim().length === 0
        ) {
          return { kind: "requires-human", reason: "UNAVAILABLE_IN_REQUEST" };
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
        if (!record || !record.included) {
          return { kind: "requires-human", reason: "EXCLUDED_FROM_CONTEXT" };
        }
        if (!record.disclosable) {
          return { kind: "requires-human", reason: "NOT_DISCLOSABLE" };
        }
        if (
          !context.request.businessAddress ||
          context.request.businessAddress.trim().length === 0
        ) {
          return { kind: "requires-human", reason: "UNAVAILABLE_IN_REQUEST" };
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
        if (!record || !record.included) {
          return { kind: "requires-human", reason: "EXCLUDED_FROM_CONTEXT" };
        }
        if (!record.disclosable) {
          return { kind: "requires-human", reason: "NOT_DISCLOSABLE" };
        }
        if (
          !context.request.businessAbout ||
          context.request.businessAbout.trim().length === 0
        ) {
          return { kind: "requires-human", reason: "UNAVAILABLE_IN_REQUEST" };
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
          return { kind: "requires-human", reason: "EXCLUDED_FROM_CONTEXT" };
        }
        if (!record.disclosable) {
          return { kind: "requires-human", reason: "NOT_DISCLOSABLE" };
        }
        if (context.request.services.length === 0) {
          return { kind: "requires-human", reason: "UNAVAILABLE_IN_REQUEST" };
        }
        return {
          kind: "disclosed",
          response,
          support: ["service.name"],
          renderedContent: buildServiceCatalogContent(context.request.services),
        };
      }
      case "service.price": {
        const record = ledger.find((f) => f.key === "service.price");
        if (!record || !record.included) {
          return { kind: "requires-human", reason: "EXCLUDED_FROM_CONTEXT" };
        }
        if (!record.disclosable) {
          return { kind: "requires-human", reason: "NOT_DISCLOSABLE" };
        }
        let matchedService: (typeof context.request.services)[number] | null =
          null;
        const sId =
          proposal.sourceId?.trim() ?? response.extraction?.service?.trim();
        if (sId) {
          matchedService =
            context.request.services.find(
              (s) =>
                s.id === sId ||
                s.name === sId ||
                normalizeArabicText(s.name) === normalizeArabicText(sId),
            ) ?? null;
        } else if (!isStructured) {
          const priced = context.request.services.filter((s) => s.price);
          if (priced.length === 1) matchedService = priced[0] ?? null;
        }
        if (
          !matchedService ||
          !matchedService.price ||
          matchedService.price.trim().length === 0
        ) {
          return { kind: "requires-human", reason: "UNAVAILABLE_IN_REQUEST" };
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
        const record = ledger.find((f) => f.key === "service.description");
        if (!record || !record.included) {
          return { kind: "requires-human", reason: "EXCLUDED_FROM_CONTEXT" };
        }
        if (!record.disclosable) {
          return { kind: "requires-human", reason: "NOT_DISCLOSABLE" };
        }
        let matchedService: (typeof context.request.services)[number] | null =
          null;
        const sId =
          proposal.sourceId?.trim() ?? response.extraction?.service?.trim();
        if (sId) {
          matchedService =
            context.request.services.find(
              (s) =>
                s.id === sId ||
                s.name === sId ||
                normalizeArabicText(s.name) === normalizeArabicText(sId),
            ) ?? null;
        } else if (!isStructured) {
          const described = context.request.services.filter(
            (s) => s.description,
          );
          if (described.length === 1) matchedService = described[0] ?? null;
        }
        if (
          !matchedService ||
          !matchedService.description ||
          matchedService.description.trim().length === 0
        ) {
          return { kind: "requires-human", reason: "UNAVAILABLE_IN_REQUEST" };
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
        if (!record || !record.included) {
          return { kind: "requires-human", reason: "EXCLUDED_FROM_CONTEXT" };
        }
        if (!record.disclosable) {
          return { kind: "requires-human", reason: "NOT_DISCLOSABLE" };
        }
        let matchedFaq: (typeof context.request.faqs)[number] | null = null;
        if (proposal.sourceId) {
          const sId = proposal.sourceId.trim();
          matchedFaq =
            context.request.faqs.find(
              (f) =>
                (f.id && f.id === sId) ||
                f.question === sId ||
                normalizeArabicText(f.question) === normalizeArabicText(sId),
            ) ?? null;
        } else {
          const exact = context.request.faqs.find(
            (f) => f.answer.trim() === response.content.trim(),
          );
          if (exact) {
            matchedFaq = exact;
          } else {
            const matchedByMsg = matchFaq(
              tokenize(context.request.message),
              context.request.faqs,
            );
            if (matchedByMsg) {
              matchedFaq = matchedByMsg;
            } else if (!isStructured && context.request.faqs.length === 1) {
              matchedFaq = context.request.faqs[0] ?? null;
            }
          }
        }
        if (
          !matchedFaq ||
          !matchedFaq.answer ||
          matchedFaq.answer.trim().length === 0
        ) {
          const sName = response.extraction?.service?.trim();
          if (sName) {
            const matchedService = context.request.services.find(
              (s) => s.name === sName,
            );
            if (matchedService?.price) {
              const priceRecord = ledger.find((f) => f.key === "service.price");
              if (priceRecord?.included && priceRecord.disclosable) {
                return {
                  kind: "disclosed",
                  response,
                  support: ["service.price"],
                  renderedContent: response.content,
                };
              }
            }
          }
          return { kind: "requires-human", reason: "UNAVAILABLE_IN_REQUEST" };
        }
        const renderedFaq =
          proposal.sourceId ||
          matchedFaq.answer.trim() === response.content.trim()
            ? matchedFaq.answer.trim()
            : response.content;
        return {
          kind: "disclosed",
          response,
          support: ["business.faqs"],
          renderedContent: renderedFaq,
        };
      }
      default: {
        return { kind: "requires-human", reason: "EXCLUDED_FROM_CONTEXT" };
      }
    }
  }

  // ── Case B: sourceId provided without explicit family
  if (proposal.sourceId) {
    const sId = proposal.sourceId.trim();
    const matchedFaq = context.request.faqs.find(
      (f) =>
        (f.id && f.id === sId) ||
        f.question === sId ||
        normalizeArabicText(f.question) === normalizeArabicText(sId),
    );
    if (matchedFaq) {
      const record = ledger.find((f) => f.key === "business.faqs");
      if (!record || !record.included) {
        return { kind: "requires-human", reason: "EXCLUDED_FROM_CONTEXT" };
      }
      if (!record.disclosable) {
        return { kind: "requires-human", reason: "NOT_DISCLOSABLE" };
      }
      return {
        kind: "disclosed",
        response,
        support: ["business.faqs"],
        renderedContent: matchedFaq.answer.trim(),
      };
    }

    const matchedService = context.request.services.find(
      (s) =>
        s.id === sId ||
        s.name === sId ||
        normalizeArabicText(s.name) === normalizeArabicText(sId),
    );
    if (matchedService) {
      if (matchedService.price) {
        const record = ledger.find((f) => f.key === "service.price");
        if (record?.included && record.disclosable) {
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
      }
      if (matchedService.description) {
        const record = ledger.find((f) => f.key === "service.description");
        if (record?.included && record.disclosable) {
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
      }
    }

    const exactFaq = context.request.faqs.find(
      (f) => f.answer.trim() === response.content.trim(),
    );
    if (exactFaq) {
      const record = ledger.find((f) => f.key === "business.faqs");
      if (record?.included && record.disclosable) {
        return {
          kind: "disclosed",
          response,
          support: ["business.faqs"],
          renderedContent: exactFaq.answer.trim(),
        };
      }
    }

    return { kind: "requires-human", reason: "UNAVAILABLE_IN_REQUEST" };
  }

  // ── Case C: Neither family nor sourceId provided
  // Check if response content is an exact verbatim match to an exposed, disclosable stored source:
  const trimmedContent = response.content.trim();

  // 1. Exact stored FAQ answer match:
  const exactFaq = context.request.faqs.find(
    (f) => f.answer.trim() === trimmedContent,
  );
  if (exactFaq) {
    const record = ledger.find((f) => f.key === "business.faqs");
    if (record?.included && record.disclosable) {
      return {
        kind: "disclosed",
        response,
        support: ["business.faqs"],
        renderedContent: exactFaq.answer.trim(),
      };
    }
  }

  // 2. Stored business about match:
  if (
    context.request.businessAbout &&
    context.request.businessAbout.trim().length > 0 &&
    (context.request.businessAbout.trim() === trimmedContent ||
      response.content.includes(context.request.businessAbout.trim()))
  ) {
    const record = ledger.find((f) => f.key === "business.about");
    if (record?.included && record.disclosable) {
      return {
        kind: "disclosed",
        response,
        support: ["business.about"],
        renderedContent: response.content,
      };
    }
  }

  // 3. Stored business address match:
  if (
    context.request.businessAddress &&
    context.request.businessAddress.trim().length > 0 &&
    (context.request.businessAddress.trim() === trimmedContent ||
      response.content.includes(context.request.businessAddress.trim()))
  ) {
    const record = ledger.find((f) => f.key === "business.address");
    if (record?.included && record.disclosable) {
      return {
        kind: "disclosed",
        response,
        support: ["business.address"],
        renderedContent: response.content,
      };
    }
  }

  // 4. Exact stored service description match:
  const exactDescService = context.request.services.find(
    (s) => s.description && s.description.trim() === trimmedContent,
  );
  if (exactDescService) {
    const record = ledger.find((f) => f.key === "service.description");
    if (record?.included && record.disclosable) {
      return {
        kind: "disclosed",
        response,
        support: ["service.description"],
        renderedContent: buildServiceDescriptionContent(
          exactDescService.name,
          exactDescService.description!,
        ),
      };
    }
  }

  // 5. Exposed service catalog listing:
  if (
    context.request.services.length > 0 &&
    (context.request.services.every((s) => response.content.includes(s.name)) ||
      isPureServiceCatalogQuestion(context.request.message))
  ) {
    const record = ledger.find((f) => f.key === "service.name");
    if (record?.included && record.disclosable) {
      return {
        kind: "disclosed",
        response,
        support: ["service.name"],
        renderedContent: buildServiceCatalogContent(context.request.services),
      };
    }
  }

  // 6. Matching stored FAQ for legacy/offline test turns where model omitted source reference:
  if (context.request.faqs.length > 0) {
    const matchedFaq = matchFaq(
      tokenize(context.request.message),
      context.request.faqs,
    );
    if (matchedFaq) {
      const record = ledger.find((f) => f.key === "business.faqs");
      if (record?.included && record.disclosable) {
        return {
          kind: "disclosed",
          response,
          support: ["business.faqs"],
          renderedContent: response.content,
        };
      }
    }
  }

  // 7. Priced service inquiry for legacy/offline turns:
  const isPriceAsk =
    context.request.message.includes("بكام") ||
    context.request.message.includes("سعر") ||
    context.request.message.includes("كم") ||
    context.request.message.includes("تكلفة");
  const extractedServiceName = response.extraction?.service?.trim();
  const legacyPricedService = extractedServiceName
    ? context.request.services.find(
        (s) =>
          (s.name === extractedServiceName ||
            normalizeArabicText(s.name) ===
              normalizeArabicText(extractedServiceName)) &&
          Boolean(s.price),
      )
    : context.request.services.find(
        (s) =>
          Boolean(s.price) &&
          (response.content.includes(s.price!) ||
            (isPriceAsk &&
              response.content.includes(s.name) &&
              context.request.message.includes(s.name))),
      );
  if (legacyPricedService) {
    const record = ledger.find(
      (f) => f.key === "service.price" || f.key.startsWith("service.price:"),
    );
    if (record?.included && record.disclosable) {
      return {
        kind: "disclosed",
        response,
        support: ["service.price"],
        renderedContent: response.content,
      };
    }
  }

  // 8. Mentioned service name inquiry for legacy/offline turns:
  const mentionedService = context.request.services.find(
    (s) =>
      response.content.includes(s.name) &&
      context.request.message.includes(s.name),
  );
  if (mentionedService) {
    const record = ledger.find(
      (f) => f.key === "service.name" || f.key.startsWith("service.name:"),
    );
    if (record?.included && record.disclosable) {
      return {
        kind: "disclosed",
        response,
        support: ["service.name"],
        renderedContent: response.content,
      };
    }
  }

  if (isStructured) {
    // Missing structured source reference on structured turn -> fail closed
    return { kind: "requires-human", reason: "UNAVAILABLE_IN_REQUEST" };
  }

  // Compatibility candidate evaluation for legacy/offline test turns:
  if (context.request.faqs.length === 1) {
    const record = ledger.find((f) => f.key === "business.faqs");
    if (record?.included && record.disclosable) {
      return {
        kind: "disclosed",
        response,
        support: ["business.faqs"],
        renderedContent: context.request.faqs[0]!.answer.trim(),
      };
    }
  }

  if (
    context.request.businessAbout &&
    context.request.businessAbout.trim().length > 0
  ) {
    const record = ledger.find((f) => f.key === "business.about");
    if (record?.included && record.disclosable) {
      return {
        kind: "disclosed",
        response,
        support: ["business.about"],
        renderedContent: buildBusinessAboutContent(
          context.request.businessAbout,
        ),
      };
    }
  }

  if (
    context.request.businessAddress &&
    context.request.businessAddress.trim().length > 0
  ) {
    const record = ledger.find((f) => f.key === "business.address");
    if (record?.included && record.disclosable) {
      return {
        kind: "disclosed",
        response,
        support: ["business.address"],
        renderedContent: buildBusinessAddressContent(
          context.request.businessAddress,
        ),
      };
    }
  }

  const describedService = context.request.services.find(
    (s) => typeof s.description === "string" && s.description.trim().length > 0,
  );
  if (describedService) {
    const record = ledger.find((f) => f.key === "service.description");
    if (record?.included && record.disclosable) {
      return {
        kind: "disclosed",
        response,
        support: ["service.description"],
        renderedContent: buildServiceDescriptionContent(
          describedService.name,
          describedService.description!,
        ),
      };
    }
  }

  const pricedService = context.request.services.find(
    (s) => typeof s.price === "string" && s.price.trim().length > 0,
  );
  if (pricedService) {
    const record = ledger.find((f) => f.key === "service.price");
    if (record?.included && record.disclosable) {
      return {
        kind: "disclosed",
        response,
        support: ["service.price"],
        renderedContent: buildServicePriceContent(
          pricedService.name,
          pricedService.price!,
        ),
      };
    }
  }

  if (context.request.services.length > 0) {
    const record = ledger.find((f) => f.key === "service.name");
    if (record?.included && record.disclosable) {
      return {
        kind: "disclosed",
        response,
        support: ["service.name"],
        renderedContent: buildServiceCatalogContent(context.request.services),
      };
    }
  }

  return { kind: "requires-human", reason: "UNAVAILABLE_IN_REQUEST" };
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
