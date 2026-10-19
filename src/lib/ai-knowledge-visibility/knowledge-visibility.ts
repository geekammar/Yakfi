/**
 * The classification policy (PROMPT-B01) — the single place that states
 * which FlowPilot information carries which visibility level.
 *
 * This is a structured, type-driven policy over SOURCE + FIELD, not a
 * string-matching redaction and not an ad-hoc word blacklist. It is
 * consumed by the future Context Builder (B-02), which asks:
 *
 *   1. `classify*(source, field)`  → the level (is this even a candidate?)
 *   2. `enrollFact(...)`           → build the provenance-bound candidate
 *                                    (FORBIDDEN / unproven ⇒ refused)
 *   3. `isEligibleForAiContext`    → may the AI know it this turn?
 *   4. `isDisclosable`             → may the AI mention it to the customer?
 *
 * Product rules encoded here:
 * - The AI is the default responder when sufficient SAFE information
 *   exists; it does NOT guess missing business facts (a missing fact is
 *   handed to a human, never invented).
 * - Internal operational information is not exposed to customers merely
 *   because it exists on the Business record.
 * - Service duration stays operational: the AI may know it (it is already
 *   in `AiRequest.services`), but its CUSTOMER-FACING behavior is decided
 *   by the later B-03 policy — so it is INTERNAL here, not PUBLIC.
 * - Service duration's customer-facing behavior, working hours, and slot
 *   duration are never disclosed; the customer sees domain-computed
 *   OUTCOME facts (available slots), not operational metadata.
 */

import type {
  FactEnrollmentResult,
  KnowledgeFact,
  KnowledgeFactSource,
} from "./knowledge-provenance";
import { enrollFact, isWithinTenantScope } from "./knowledge-provenance";
import type { VisibilityLevel } from "./visibility-level";
import {
  isDisclosable,
  isEligibleForAiContext,
  mostRestrictive,
} from "./visibility-level";

// ─── FORBIDDEN categories (binding; the minimum set) ────────────────────────

/**
 * Why information is FORBIDDEN. This is the explicit, enumerated policy —
 * not a keyword scan. Anything in these categories must never enter AI
 * context as a knowledge fact.
 */
export const FORBIDDEN_CATEGORY_VALUES = [
  "ACCESS_TOKEN",
  "APP_SECRET",
  "CREDENTIAL",
  "ENCRYPTION_KEY",
  "RAW_CREDENTIAL_MATERIAL",
  "AUTHENTICATION_SECRET",
  "SESSION_SECRET",
  "INTERNAL_SECURITY_MATERIAL",
  "PRIVATE_INFRASTRUCTURE_DATA",
  "RAW_DATABASE_RECORD",
  "HIDDEN_SYSTEM_PROMPT",
  "INTERNAL_IMPLEMENTATION_INSTRUCTION",
  "CROSS_TENANT_DATA",
  "OUT_OF_SCOPE_PRIVATE_DATA",
] as const;

export type ForbiddenCategory = (typeof FORBIDDEN_CATEGORY_VALUES)[number];

/**
 * Concrete FlowPilot locations that are FORBIDDEN as knowledge facts,
 * mapped to their category. Proven these never reach `AiRequest` today
 * (the credential boundary stores REFERENCES only — DECISIONS #31/#47;
 * repositories are the only Prisma consumers — DECISIONS #12).
 */
export const FORBIDDEN_FIELDS: ReadonlyArray<{
  readonly location: string;
  readonly category: ForbiddenCategory;
}> = [
  // Secret material — references and values alike never become facts.
  { location: "WhatsAppConnection.credentialsRef", category: "CREDENTIAL" },
  {
    location: "RuntimeCredential.encryptedValue",
    category: "RAW_CREDENTIAL_MATERIAL",
  },
  { location: "PlatformAiPolicy.primarySecretRef", category: "CREDENTIAL" },
  { location: "PlatformAiPolicy.secondarySecretRef", category: "CREDENTIAL" },
  { location: "credential-crypto key material", category: "ENCRYPTION_KEY" },
  { location: "process.env secret values", category: "ACCESS_TOKEN" },
  // Authentication / security material.
  { location: "account password hash", category: "AUTHENTICATION_SECRET" },
  { location: "Invitation.tokenHash", category: "AUTHENTICATION_SECRET" },
  { location: "session/token material", category: "SESSION_SECRET" },
  { location: "webhook verify token", category: "INTERNAL_SECURITY_MATERIAL" },
  // Raw, out-of-task data.
  {
    location: "raw Prisma rows (non-task tables)",
    category: "RAW_DATABASE_RECORD",
  },
  { location: "another Business's data", category: "CROSS_TENANT_DATA" },
  {
    location: "private data outside tenant/customer scope",
    category: "OUT_OF_SCOPE_PRIVATE_DATA",
  },
  // Instruction-channel integrity: no second, hidden prompt may be
  // injected as knowledge. The ONE engine-wired system instruction is
  // governed by the Prompt Workspace rules, not by this policy.
  {
    location: "injected hidden system prompt",
    category: "HIDDEN_SYSTEM_PROMPT",
  },
  {
    location: "internal implementation instruction as a fact",
    category: "INTERNAL_IMPLEMENTATION_INSTRUCTION",
  },
];

/**
 * The public, customer-authored knowledge store (DECISIONS #13). Entries
 * are written by the business FOR customers (prices, policies,
 * preparation instructions), so the STORE is PUBLIC — the whole store,
 * not per-entry metadata: the entry shape is question/answer only, and
 * adding per-entry visibility would contradict DECISIONS #13.
 *
 * The store stays the single canonical knowledge source — this policy
 * classifies it, it does not duplicate it.
 */
export const FAQ_STORE_VISIBILITY: VisibilityLevel = "PUBLIC";

// ─── Field classification ───────────────────────────────────────────────────

/** `Business` record fields → visibility level. */
const BUSINESS_FIELD_VISIBILITY: Record<string, VisibilityLevel> = {
  name: "PUBLIC", // the business name — phrasing only, already in AiRequest
  about: "PUBLIC", // the business's own customer-facing description
  // Customer-facing location line (PROMPT-AI-OPS-21). CONDITIONAL like
  // `whatsappNumber`: it reaches the assistant ONLY on a
  // contact/identity/location turn, so an unrelated turn never carries it
  // and a missing address is never invented.
  address: "CONDITIONAL",
  faqs: FAQ_STORE_VISIBILITY, // the canonical knowledge store
  vertical: "INTERNAL", // discovery metadata — operator use only
  city: "INTERNAL", // discovery metadata — operator use only
  whatsappNumber: "CONDITIONAL", // known to the customer already; only on contact/identity asks
  timezone: "INTERNAL", // operational; customers see computed slots, never the tz
  workingHours: "INTERNAL", // operational; availability is domain-computed (CORE-02)
  slotDurationMinutes: "INTERNAL", // operational (product rule: duration behavior is B-03)
  confirmationMode: "INTERNAL", // operational; customer-facing behavior is B-03
  cancellationPolicy: "CONDITIONAL", // relevant only on cancellation/reschedule asks
  isActive: "INTERNAL", // operational state
  onboardingCompletedAt: "INTERNAL", // operational state
  createdAt: "INTERNAL", // operational metadata
  updatedAt: "INTERNAL", // operational metadata
  deletedAt: "INTERNAL", // operational metadata
  // ids are FORBIDDEN as facts: they are internal identifiers. Tenant
  // identity travels as provenance on the envelope, never as content.
  id: "FORBIDDEN",
  defaultBranchId: "FORBIDDEN",
};

/** `Service` catalog fields → visibility level. */
const SERVICE_FIELD_VISIBILITY: Record<string, VisibilityLevel> = {
  name: "PUBLIC", // bookable service names — the customer picks from them
  description: "PUBLIC", // the business's own customer-facing copy
  durationMinutes: "INTERNAL", // operational (product rule: duration behavior is B-03)
  // Price is authoritative, customer-facing DOMAIN data (PROMPT-AI-ARCH-13 —
  // Slice 6) but CONDITIONAL: it is exposed to AI context + disclosable ONLY
  // when the current customer turn is price-relevant (the context builder's
  // task gate), never on every turn. A missing price stays NO_KNOWLEDGE — the
  // AI must never invent one.
  price: "CONDITIONAL",
  isActive: "INTERNAL", // operational state; inactive services are hidden upstream
  id: "FORBIDDEN", // internal identifier — never a fact
  businessId: "FORBIDDEN", // tenant identifier — provenance only, never content
};

/** Conversation-state fields as they appear in `AiRequest` → level. */
const CONVERSATION_FIELD_VISIBILITY: Record<string, VisibilityLevel> = {
  message: "PUBLIC", // the customer's own current message
  businessName: "PUBLIC", // phrasing only
  recentMessages: "PUBLIC", // this thread's own bounded history (≤20)
  conversationStatus: "INTERNAL", // engine state — phrasing, never customer-visible
  providerPreference: "CONDITIONAL", // relevant only on provider-choice asks
  availability: "CONDITIONAL", // domain-computed (CORE-02); booking/availability asks only
  services: "PUBLIC", // the service-name facts the customer chooses from
  faqs: FAQ_STORE_VISIBILITY, // the canonical knowledge store
  conversationContext: "INTERNAL", // bounded projection of durable state for AI interpretation
};

/**
 * Classify a `Business` record field. Unknown fields resolve to the safe
 * default (INTERNAL — never customer-visible), never to PUBLIC.
 */
export function classifyBusinessField(field: string): VisibilityLevel {
  return BUSINESS_FIELD_VISIBILITY[field] ?? "INTERNAL";
}

/** Classify a `Service` catalog field. Unknown ⇒ safe default. */
export function classifyServiceField(field: string): VisibilityLevel {
  return SERVICE_FIELD_VISIBILITY[field] ?? "INTERNAL";
}

/** Classify a conversation-state field of `AiRequest`. Unknown ⇒ safe default. */
export function classifyConversationField(field: string): VisibilityLevel {
  return CONVERSATION_FIELD_VISIBILITY[field] ?? "INTERNAL";
}

/**
 * Classify the FAQ store itself (by source). It is PUBLIC by construction.
 * Kept explicit so the Context Builder never has to hard-code the level.
 */
export function classifyFaqStore(): VisibilityLevel {
  return FAQ_STORE_VISIBILITY;
}

/** Is this field name FORBIDDEN from ever becoming a knowledge fact? */
export function isForbiddenField(field: string): boolean {
  return (
    classifyBusinessField(field) === "FORBIDDEN" ||
    classifyServiceField(field) === "FORBIDDEN" ||
    classifyConversationField(field) === "FORBIDDEN"
  );
}

/**
 * Conflicts are NOT resolved by the AI. When two facts disagree (two
 * sources state different values for the same business-authoritative
 * fact), the assistant must not pick one: the domain stays authoritative.
 * The conversation engine's existing NEED_HUMAN / handoff path is the
 * resolution route; this policy only forbids AI self-resolution.
 */
export const AI_MUST_NOT_RESOLVE_CONFLICTS = true as const;

// ─── Policy decisions over enrolled facts ───────────────────────────────────

/**
 * Full policy decision for one candidate fact in a turn. `taskRelevant`
 * is supplied by the Context Builder from the turn's intent (never by
 * the AI), and gates both CONDITIONAL eligibility and CONDITIONAL
 * disclosure. An unenrollable candidate (FORBIDDEN / unproven tenant /
 * unknown provenance) yields `eligible: false` with the typed reason.
 */
export function decideFact<TValue>(input: {
  source: KnowledgeFactSource | undefined;
  businessId: string | null | undefined;
  visibility: VisibilityLevel | undefined;
  value: TValue;
  taskRelevant?: boolean;
  scope: { businessId: string };
}):
  | {
      readonly enrolled: true;
      readonly fact: KnowledgeFact<TValue>;
      readonly eligible: boolean;
      readonly disclosable: boolean;
    }
  | (FactEnrollmentResult<TValue> & { readonly enrolled: false }) {
  const enrollment = enrollFact({
    source: input.source,
    businessId: input.businessId,
    visibility: input.visibility,
    value: input.value,
  });
  if (!enrollment.enrolled) {
    return { ...enrollment, enrolled: false };
  }
  const fact = enrollment.fact;
  if (!isWithinTenantScope(fact, input.scope)) {
    // Cross-tenant data: excluded, never resolved by the AI.
    return {
      enrolled: false,
      reason: "UNPROVEN_TENANT",
    };
  }
  return {
    enrolled: true,
    fact,
    eligible: isEligibleForAiContext(fact.visibility, {
      taskRelevant: input.taskRelevant,
    }),
    disclosable: isDisclosable(fact.visibility, {
      taskRelevant: input.taskRelevant,
    }),
  };
}

/**
 * Merge classifications when a fact is reachable by several paths — the
 * most restrictive level wins, so a fact is never more permissive than
 * its least permissive attribution.
 */
export function mergeVisibility(
  levels: ReadonlyArray<VisibilityLevel>,
): VisibilityLevel {
  return mostRestrictive(levels);
}
