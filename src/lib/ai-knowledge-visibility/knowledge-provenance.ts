/**
 * Knowledge provenance — the lightweight source/tenant record attached to
 * every knowledge fact (PROMPT-B01).
 *
 * A future Context Builder (B-02) needs to know, for each candidate fact:
 *   - where it came from (source),
 *   - which Business it belongs to (tenant), and
 *   - whether it is customer-safe (visibility, in `knowledge-visibility.ts`).
 *
 * Provenance is BUILDER-SIDE METADATA ONLY. It is never rendered into
 * prompt content and never disclosed to the customer: the Context Builder
 * reads `businessId` to prove tenant ownership, then drops provenance
 * before composing the `AiRequest`. A `businessId` therefore never
 * becomes AI-visible text even though it travels with the fact.
 *
 * Tenant safety (binding):
 * - The tenant is ALWAYS server-derived (the engine resolves the Business
 *   from the receiving WhatsApp number; the knowledge service derives it
 *   from the authenticated actor). Client-provided `businessId` is never
 *   trusted.
 * - There is exactly ONE tenant-resolution mechanism — the existing one.
 *   This policy adds no second resolution path; it only RECORDS the
 *   outcome so a fact can be proven in-scope before it is used.
 * - A fact whose tenant ownership cannot be proven is EXCLUDED (see
 *   `enrollFact` / EXCLUSION_UNPROVEN_TENANT).
 */

import type { VisibilityLevel } from "./visibility-level";

/**
 * Where a knowledge fact originates. Each source is classified once in
 * `knowledge-visibility.ts`; the Context Builder never has to guess.
 */
export const KNOWLEDGE_FACT_SOURCE_VALUES = [
  /** A field of the canonical `Business` record. */
  "BUSINESS_RECORD",
  /** The canonical `Business.faqs` knowledge store (DECISIONS #13). */
  "BUSINESS_FAQ_STORE",
  /** The `Service` catalog. */
  "SERVICE_CATALOG",
  /** Domain-computed availability results (CORE-02 truth, never AI guesses). */
  "DOMAIN_AVAILABILITY",
  /** Conversation state: status, bounded history, captured preferences. */
  "CONVERSATION_STATE",
  /** The customer's own message text for the current turn. */
  "CUSTOMER_MESSAGE",
  /** Platform-level configuration (e.g. the platform AI policy row). */
  "PLATFORM_CONFIG",
] as const;

export type KnowledgeFactSource = (typeof KNOWLEDGE_FACT_SOURCE_VALUES)[number];

/**
 * A knowledge fact candidate — a value plus the proof of where it came
 * from and which tenant owns it. FORBIDDEN facts are never representable
 * here: `enrollFact` refuses to build one, so anything that exists as a
 * `KnowledgeFact` is at worst INTERNAL (known to the AI, unspoken to the
 * customer).
 */
export type KnowledgeFact<TValue = unknown> = {
  readonly source: KnowledgeFactSource;
  /** Tenant provenance — the owning Business. Never prompt content. */
  readonly businessId: string;
  readonly visibility: VisibilityLevel;
  readonly value: TValue;
};

/**
 * Why a candidate was refused enrollment (diagnostics for the builder /
 * harness; never surfaced to the AI or the customer).
 */
export const FACT_EXCLUSION_REASONS = [
  /** The field is FORBIDDEN — it must never enter AI context. */
  "FORBIDDEN_BY_POLICY",
  /** Tenant ownership could not be proven server-side. */
  "UNPROVEN_TENANT",
  /** The source is unknown — no provenance ⇒ excluded by default. */
  "UNKNOWN_SOURCE",
  /** The visibility level could not be determined for this fact. */
  "UNKNOWN_VISIBILITY",
] as const;

export type FactExclusionReason = (typeof FACT_EXCLUSION_REASONS)[number];

export type FactEnrollmentResult<TValue> =
  | { readonly enrolled: true; readonly fact: KnowledgeFact<TValue> }
  | { readonly enrolled: false; readonly reason: FactExclusionReason };

/**
 * DEFAULT SAFETY (binding), enforced structurally:
 * - FORBIDDEN facts are refused outright (EXCLUSION_FORBIDDEN_BY_POLICY)
 *   — forbidden material is never even constructed as a candidate.
 * - Missing tenant proof ⇒ excluded (EXCLUSION_UNPROVEN_TENANT).
 * - Unknown source ⇒ excluded (EXCLUSION_UNKNOWN_SOURCE) — no provenance,
 *   no context.
 * - Unknown visibility ⇒ excluded (EXCLUSION_UNKNOWN_VISIBILITY) rather
 *   than guessed.
 *
 * The caller must supply `businessId` from the SERVER-DERIVED tenant
 * resolution; passing a client-supplied id is a caller bug and defeats
 * the tenant guarantee.
 */
export function enrollFact<TValue>(input: {
  source: KnowledgeFactSource | undefined;
  businessId: string | null | undefined;
  visibility: VisibilityLevel | undefined;
  value: TValue;
}): FactEnrollmentResult<TValue> {
  if (!input.source) return { enrolled: false, reason: "UNKNOWN_SOURCE" };
  if (input.businessId === null || input.businessId === undefined) {
    return { enrolled: false, reason: "UNPROVEN_TENANT" };
  }
  if (!input.visibility) {
    return { enrolled: false, reason: "UNKNOWN_VISIBILITY" };
  }
  if (input.visibility === "FORBIDDEN") {
    return { enrolled: false, reason: "FORBIDDEN_BY_POLICY" };
  }
  return {
    enrolled: true,
    fact: {
      source: input.source,
      businessId: input.businessId,
      visibility: input.visibility,
      value: input.value,
    },
  };
}

/**
 * Tenant guard — true only when the fact's recorded tenant matches the
 * server-derived scope of the current turn. Cross-tenant data must never
 * enter AI context; when information conflicts across tenants the AI
 * never resolves it (domain authority is preserved by exclusion).
 */
export function isWithinTenantScope<TValue>(
  fact: KnowledgeFact<TValue>,
  scope: { businessId: string },
): boolean {
  return fact.businessId === scope.businessId;
}
