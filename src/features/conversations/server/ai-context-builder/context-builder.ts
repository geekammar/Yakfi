/**
 * AI context builder (PROMPT-B02) — the explicit context boundary between
 * conversation orchestration and the `AiRequest` that reaches any assistant.
 *
 *   conversation orchestration
 *        ↓  (server-derived tenant scope + structured source facts)
 *   CONTEXT BUILDER  ← this module
 *        ↓  (policy-filtered, provenance-dropped)
 *   AiRequest
 *        ↓
 *   AI Provider
 *
 * It makes the B-01 knowledge-visibility policy operational at the actual
 * AI boundary. For every candidate fact it runs the B-01 pipeline —
 *
 *   classify*(source, field)   → level (unknown ⇒ INTERNAL, never PUBLIC)
 *   enrollFact(...)            → provenance-bound candidate
 *                                (FORBIDDEN / unproven / unknown ⇒ refused)
 *   isWithinTenantScope(...)   → cross-tenant ⇒ excluded, never AI-resolved
 *   budget + task gate         → CONDITIONAL only when task-relevant;
 *                                INTERNAL operational facts only when the
 *                                task genuinely requires them
 *   isEligibleForAiContext     → "AI may know this?"  (entered the request)
 *   isDisclosable              → "AI may mention this?" (recorded in the
 *                                disclosure ledger — B-03 consumes it)
 *
 * — then composes the minimal `AiRequest` and DROPS provenance: `businessId`
 * is builder-side metadata and never becomes prompt content.
 *
 * The two-question boundary is load-bearing:
 *
 *   "AI may know this"  ≠  "AI may mention this"
 *
 * An `INTERNAL` fact may enter context to inform reasoning yet must never be
 * put in a customer reply; a `CONDITIONAL` fact is only eligible/mentionable
 * when the current task makes it relevant. This is how internal and
 * conditional information exists without automatically becoming
 * customer-visible.
 *
 * What this module is NOT (binding):
 * - NOT a knowledge system, NOT RAG, NOT a vector DB, NOT a search — it
 *   assembles facts from sources the orchestration layer already loaded
 *   through the existing repositories (one DB path, no second resolution).
 * - NOT a redactor — safety is STRUCTURAL (source + field + provenance +
 *   visibility), never string matching, never a word blacklist.
 * - NOT a Domain authority and NOT a booking engine: it never decides
 *   availability (that is CORE-02), never mutates appointments, and never
 *   resolves tenant scope (that stays the engine's server-derived
 *   `BusinessRepository` resolution). A customer message can never
 *   influence the tenant scope: it is DATA, never authority.
 * - It never calls an LLM, never touches `process.env`, never reads
 *   Prisma, and never holds a credential reference or value.
 *
 * Fail-closed behavior (binding): a fact with missing provenance, an
 * unproven tenant, unknown visibility, or a FORBIDDEN classification is
 * excluded with a typed reason — never guessed, never silently reinterpreted
 * as public, and never replaced by raw source content.
 */
import type {
  AiRequest,
  ConversationContextProjection,
} from "@/features/conversations/server/ai-contract";
import {
  AI_KNOWLEDGE_ENTRY_LIMIT,
  AI_RECENT_MESSAGE_LIMIT,
} from "@/features/conversations/server/ai-contract";
import {
  ASSISTANT_STYLE_DIRECTIVE,
  businessAssistantStyleDirective,
} from "@/features/conversations/server/assistant-style";
import {
  deriveTaskRelevance,
  normalizeArabicText,
  type TaskRelevance,
} from "@/features/conversations/server/conversation-ai";
import {
  projectConversationState,
  type ConversationState,
} from "@/features/conversations/server/conversation-state";
import {
  FACT_EXCLUSION_REASONS,
  classifyBusinessField,
  classifyConversationField,
  classifyFaqStore,
  classifyServiceField,
  decideFact,
  type FactExclusionReason,
  type KnowledgeFactSource,
  type VisibilityLevel,
} from "@/lib/ai-knowledge-visibility";
import { formatServicePrice } from "@/lib/service-price";
import { faqEntrySchema } from "@/lib/validation";
import type { ConversationStatus } from "@/types/domain";

import { z } from "zod";

/**
 * Re-exported so the builder's public surface stays stable: the relevance
 * derivation is consumed by the builder (task-gated fact exposure), the
 * knowledge-gap recorder, the conversation engine and the deterministic
 * identity decision set — all through this ONE canonical export. The
 * derivation itself is defined in `conversation-ai.ts`, next to the other
 * Arabic text-classification primitives, so the relevance vocabulary has
 * exactly ONE definition site (no second classifier, no duplicated tables).
 */
export { deriveTaskRelevance, type TaskRelevance };

// ─── Sources (existing sources only — nothing new is invented) ──────────────

/**
 * The Business-record facts the builder accounts for. Only the fields
 * enumerated here are candidates; anything else on the record is not a
 * context candidate at all. Deliberately a structural subset — the builder
 * never receives (and never asks for) credential references, ids-as-content,
 * or lifecycle rows.
 */
export type ContextBusinessSources = {
  /**
   * The Business record's own tenant id — provenance only, never prompt
   * content. When present it is proven against the scope (defense in
   * depth); when absent the builder falls back to the server-derived
   * scope, which the engine guarantees for its tenant-scoped lookup.
   */
  readonly businessId?: string | null;
  readonly name: string;
  readonly about?: string | null;
  /**
   * Customer-facing location line (PROMPT-AI-OPS-21). Exposed ONLY on a
   * contact/identity/location turn; absent otherwise, and never invented.
   */
  readonly address?: string | null;
  readonly whatsappNumber?: string | null;
  /** Raw `Business.faqs` JSON — validated here, same as the engine did. */
  readonly faqs?: unknown;
  readonly cancellationPolicy?: string | null;
  readonly workingHours?: unknown;
  readonly slotDurationMinutes?: number | null;
  readonly confirmationMode?: string | null;
  readonly timezone?: string | null;
  /** Discovery metadata — operational only (never customer-visible). */
  readonly vertical?: string | null;
  readonly city?: string | null;
  /**
   * Persisted, business-owned assistant style (PROMPT-AI-UX-01) — the raw
   * `Business.assistantStyle` JSON. UNTRUSTED by construction: the builder
   * resolves it over the resident default via `businessAssistantStyleDirective`
   * (fail-safe for absent/partial/legacy/malformed values), so it can only
   * ever yield a directive composed from the CLOSED enum fragments. It is a
   * phrasing directive from no source, carries no business facts, and the
   * budget ledger has nothing to classify for it (same as the resident
   * voice).
   */
  readonly assistantStyle?: unknown;
  /**
   * The business's optional display name for its assistant (PROMPT-AI-UX-01).
   * DISPLAY COPY ONLY — it is NEVER copied into the request (see the name's
   * free-text rationale in `assistant-style.ts`). Carried on the source type
   * solely so callers may pass the Business record unchanged; the builder
   * ignores it.
   */
  readonly assistantName?: string | null;
};

export type ContextServiceFact = {
  readonly id: string;
  /** Tenant provenance of the service row — never prompt content. */
  readonly businessId: string;
  readonly name: string;
  readonly description?: string | null;
  readonly durationMinutes?: number | null;
  /**
   * Structured, authoritative price columns (PROMPT-AI-ARCH-13 — Slice 6).
   * The builder formats them into the MINIMAL display string via
   * `formatServicePrice` and exposes it ONLY when the turn is price-relevant
   * (CONDITIONAL). A null `priceType` means NO price — never invented.
   */
  readonly priceType?: string | null;
  readonly priceAmount?: number | null;
  readonly priceMaxAmount?: number | null;
  readonly priceCurrency?: string | null;
  readonly priceNote?: string | null;
};

export type ContextAvailabilityFact = {
  readonly date: string;
  readonly slots: ReadonlyArray<string>;
};

export type ContextSources = {
  readonly business: ContextBusinessSources;
  readonly services: ReadonlyArray<ContextServiceFact>;
  readonly conversation: {
    readonly status: ConversationStatus;
    readonly recentMessages: ReadonlyArray<{
      readonly senderType: string;
      readonly content: string;
    }>;
  };
  /** The customer's own message for the current turn. */
  readonly message: string;
  /** Domain-computed availability results, when already resolved (CORE-02). */
  readonly availability?: ReadonlyArray<ContextAvailabilityFact> | null;
  /** Previously captured provider preference, when one exists. */
  readonly providerPreference?: string | null;
  /** CONV-CORE-02: Durable conversation state for minimal bounded AI projection. */
  readonly conversationState?: ConversationState | null;
  /** Current turn time for freshness and expiration evaluation. */
  readonly now?: Date;
};

/**
 * Upper bound on how many service descriptions a single turn may carry. The
 * catalog names are already bounded by the contract; descriptions are more
 * verbose, so a generic service-info turn carries at most this many — a
 * BOUNDED catalog summary, never an unbounded dump.
 */
export const AI_SERVICE_DESCRIPTION_LIMIT = 5;

// ─── Output contract ─────────────────────────────────────────────────────────

/**
 * Why an enrolled, in-scope fact still did not enter the request. These are
 * BUILDER-level inclusion decisions — distinct from B-01's typed
 * `FactExclusionReason` (refusal at enrollment).
 */
export const CONTEXT_OMISSION_REASONS = [
  /** CONDITIONAL fact, but the current task is not relevant to it. */
  "NOT_TASK_RELEVANT",
  /** INTERNAL operational fact the current AI task does not require. */
  "OPERATIONAL_NOT_REQUIRED",
  /**
   * Eligible per policy but not part of the `AiRequest` context budget
   * (DECISIONS #33) — the builder filters, it never expands the budget.
   */
  "OUTSIDE_CONTEXT_BUDGET",
] as const;

export type ContextOmissionReason = (typeof CONTEXT_OMISSION_REASONS)[number];

/**
 * One candidate's full record in the disclosure ledger. The ledger is
 * BUILDER-SIDE metadata: it travels with the built context so a later
 * slice (B-03) can enforce "AI may mention this". It is never rendered
 * into prompt content and never sent to a provider.
 */
export type ContextFactRecord = {
  /** Stable fact key (e.g. "business.name", "service.name:تنظيف أسنان"). */
  readonly key: string;
  readonly source: KnowledgeFactSource;
  readonly visibility: VisibilityLevel;
  /** Entered the `AiRequest` context — "AI may know this". */
  readonly included: boolean;
  /** May be mentioned to the customer — "AI may mention this". */
  readonly disclosable: boolean;
  /** Refused at enrollment (B-01 typed reason), when applicable. */
  readonly exclusionReason?: FactExclusionReason;
  /** Omitted by the builder despite being enrolled, when applicable. */
  readonly omissionReason?: ContextOmissionReason;
};

export type BuildAiContextInput = {
  /**
   * The server-derived tenant scope for this turn. The engine resolves the
   * Business from the receiving WhatsApp number (or the provider adapter's
   * authoritative identity) — a client/customer-supplied value can never
   * reach here. Every candidate fact is proven against it.
   */
  readonly scope: { readonly businessId: string };
  readonly sources: ContextSources;
  /**
   * Override the derived relevance (observability/testing only). When
   * omitted, relevance is derived deterministically from the message.
   */
  readonly taskRelevance?: TaskRelevance;
};

export type BuiltAiContext = {
  /** The policy-filtered, provider-neutral request — provenance dropped. */
  readonly request: AiRequest;
  /**
   * The disclosure ledger — every considered candidate with its
   * included / disclosable verdicts. Deterministic order, unique keys.
   */
  readonly facts: ReadonlyArray<ContextFactRecord>;
  /** Candidates that did not enter the request (refused or omitted). */
  readonly excluded: ReadonlyArray<ContextFactRecord>;
};

// ─── Internal helpers ────────────────────────────────────────────────────────

/** Stored knowledge contract reuse (the ONE canonical store's entry shape). */
const storedFaqsSchema = z.array(faqEntrySchema);

/** Malformed stored FAQ JSON degrades to "no knowledge" — never crashes. */
function safeFaqs(raw: unknown): Array<{ question: string; answer: string }> {
  const parsed = storedFaqsSchema.safeParse(raw ?? []);
  return parsed.success ? parsed.data.slice(0, AI_KNOWLEDGE_ENTRY_LIMIT) : [];
}

/**
 * Deterministic "does the current turn reference this service?" signal
 * (PROMPT-AI-ARCH-15 — Slice 6). It reuses the existing Arabic normalizer and
 * is deliberately bounded: an exact phrase containment check, otherwise the
 * service's FIRST significant token (≥3 chars — the discriminating word in
 * this domain, e.g. «تنظيف» in «تنظيف الأسنان»). It is NOT a search index, NOT
 * fuzzy, NOT ranked — it only decides whether a service's PUBLIC description
 * is task-relevant this turn (the common word «الأسنان» alone never selects a
 * sibling service).
 */
function serviceReferenced(serviceName: string, message: string): boolean {
  const hay = normalizeArabicText(serviceName);
  if (hay.length === 0) return false;
  const needle = normalizeArabicText(message);
  if (needle.length === 0) return false;
  if (needle.includes(hay)) return true;
  const firstToken = hay.split(" ").find((token) => token.length >= 3);
  if (!firstToken) return false;
  return new Set(needle.split(" ").filter(Boolean)).has(firstToken);
}

type Ledger = {
  records: ContextFactRecord[];
  keys: Set<string>;
};

function recordFact(
  ledger: Ledger,
  entry: Omit<ContextFactRecord, "included" | "disclosable">,
  verdicts: { included: boolean; disclosable: boolean },
): void {
  // Deterministic dedupe: the first occurrence of a key wins; a later
  // duplicate is dropped (never emitted twice).
  if (ledger.keys.has(entry.key)) return;
  ledger.keys.add(entry.key);
  ledger.records.push({ ...entry, ...verdicts });
}

/**
 * One candidate through the full B-02 pipeline. Returns the disclosure
 * verdicts; the caller decides what physically enters the request.
 */
function evaluateCandidate(input: {
  ledger: Ledger;
  scope: { businessId: string };
  source: KnowledgeFactSource;
  /** Server-derived tenant owner of THIS fact (never customer input). */
  businessId: string | null | undefined;
  visibility: VisibilityLevel | undefined;
  key: string;
  /** Whether the context budget carries this fact at all. */
  inBudget: boolean;
  /** Whether the current task requires/relevates this fact. */
  taskRequired: boolean;
}): { included: boolean; disclosable: boolean } {
  const decision = decideFact({
    source: input.source,
    businessId: input.businessId,
    visibility: input.visibility,
    value: null, // the value never reaches the policy layer (structural)
    taskRelevant: input.taskRequired,
    scope: input.scope,
  });
  if (!decision.enrolled) {
    // Fail closed: FORBIDDEN / unproven tenant / unknown provenance /
    // unknown visibility — typed reason, never a guess.
    recordFact(
      input.ledger,
      {
        key: input.key,
        source: input.source,
        visibility: input.visibility ?? "INTERNAL",
        exclusionReason: decision.reason,
      },
      { included: false, disclosable: false },
    );
    return { included: false, disclosable: false };
  }
  const { fact, eligible, disclosable } = decision;
  if (!eligible) {
    recordFact(
      input.ledger,
      {
        key: input.key,
        source: fact.source,
        visibility: fact.visibility,
        omissionReason: "NOT_TASK_RELEVANT",
      },
      { included: false, disclosable },
    );
    return { included: false, disclosable };
  }
  // An eligible INTERNAL operational fact is omitted unless the current
  // task genuinely requires it (documented dependency — it stays
  // non-disclosable either way; only the minimum representation passes).
  // Checked before budget membership: the reason an operational fact is
  // absent is its operational, task-irrelevant nature — never the budget.
  if (fact.visibility === "INTERNAL" && !input.taskRequired) {
    recordFact(
      input.ledger,
      {
        key: input.key,
        source: fact.source,
        visibility: fact.visibility,
        omissionReason: "OPERATIONAL_NOT_REQUIRED",
      },
      { included: false, disclosable },
    );
    return { included: false, disclosable };
  }
  if (!input.inBudget) {
    recordFact(
      input.ledger,
      {
        key: input.key,
        source: fact.source,
        visibility: fact.visibility,
        omissionReason: "OUTSIDE_CONTEXT_BUDGET",
      },
      { included: false, disclosable },
    );
    return { included: false, disclosable };
  }
  recordFact(
    input.ledger,
    {
      key: input.key,
      source: fact.source,
      visibility: fact.visibility,
    },
    { included: true, disclosable },
  );
  return { included: true, disclosable };
}

// ─── The builder ─────────────────────────────────────────────────────────────

/**
 * Build the AI-safe context for one turn. Pure and total: no I/O, no LLM,
 * no env, no Prisma, no credential. Always returns a structured result —
 * per-fact exclusion is the fail-closed mechanism, so the function never
 * throws and never falls back to raw source content.
 */
export function buildAiContext(input: BuildAiContextInput): BuiltAiContext {
  const scope = input.scope;
  const sources = input.sources;
  const relevance = input.taskRelevance ?? deriveTaskRelevance(sources.message);
  const ledger: Ledger = { records: [], keys: new Set() };

  // The server-derived tenant scope. An empty/blank scope is UNPROVEN —
  // every fact is refused rather than matched against an empty tenant.
  const scopeId =
    typeof scope.businessId === "string" && scope.businessId.trim()
      ? scope.businessId
      : null;

  // The Business record's own tenant, proven against the scope. A record
  // from another Business is rejected wholesale (fail closed: no business
  // fact enters context), never resolved by the AI.
  const businessTenantId = sources.business.businessId ?? scopeId;
  const businessProvenance =
    scopeId && businessTenantId === scopeId ? scopeId : null;

  // ── 1. The customer's own message (PUBLIC, always in budget) ─────────────
  const messageVerdict = evaluateCandidate({
    ledger,
    scope,
    source: "CUSTOMER_MESSAGE",
    businessId: scopeId,
    visibility: classifyConversationField("message"),
    key: "customer.message",
    inBudget: true,
    taskRequired: true,
  });

  // ── 2. Conversation state ────────────────────────────────────────────────
  // conversationStatus is INTERNAL but the assistant's phrasing task
  // genuinely depends on it (the prompt contract uses it for register); it
  // stays non-disclosable. This is the one documented INTERNAL dependency.
  const statusVerdict = evaluateCandidate({
    ledger,
    scope,
    source: "CONVERSATION_STATE",
    businessId: scopeId,
    visibility: classifyConversationField("conversationStatus"),
    key: "conversation.status",
    inBudget: true,
    taskRequired: true,
  });
  const historyVerdict = evaluateCandidate({
    ledger,
    scope,
    source: "CONVERSATION_STATE",
    businessId: scopeId,
    visibility: classifyConversationField("recentMessages"),
    key: "conversation.recentMessages",
    inBudget: true,
    taskRequired: true,
  });

  // ── 3. Business identity / public business information ───────────────────
  const nameVerdict = evaluateCandidate({
    ledger,
    scope,
    source: "BUSINESS_RECORD",
    businessId: businessProvenance,
    visibility: classifyBusinessField("name"),
    key: "business.name",
    inBudget: true,
    taskRequired: true,
  });
  // Aggregate business-IDENTITY disclosure family (PROMPT-AI-UX-02): the ONE
  // ledger key the disclosure gate consults to back an identity reply
  // («ما اسمكم؟» / «انتو مين؟»). The business `name` is PUBLIC and ALWAYS
  // carried in `request.businessName` (the model needs it for phrasing — the
  // per-fact `business.name` above), but this AGGREGATE family is armed ONLY
  // on an identity ask — exactly the budget gate `service.name` uses with
  // `serviceCatalog`. That is what keeps the disclosure backstop intact for
  // NON-identity questions: on a price, hours, or location turn the name stays
  // in the request (still usable for phrasing) but cannot back a self-authored
  // reply, so an unbacked answer is still refused. The name itself is still
  // sourced from the canonical Business record — nothing is duplicated into
  // the FAQ store, and no identity-specific storage exists.
  evaluateCandidate({
    ledger,
    scope,
    source: "BUSINESS_RECORD",
    businessId: businessProvenance,
    visibility: classifyBusinessField("name"),
    key: "business.identity",
    inBudget: relevance.businessIdentity,
    taskRequired: true,
  });
  // about is PUBLIC; PROMPT-AI-ARCH-15 (Slice 6) carries it ONLY when the
  // current turn is business-profile relevant. Unrelated turns keep the
  // previous behavior (recorded, not forwarded). The fact stays PUBLIC and
  // disclosable — the gate only needs the ledger verdict.
  const aboutVerdict = evaluateCandidate({
    ledger,
    scope,
    source: "BUSINESS_RECORD",
    businessId: businessProvenance,
    visibility: classifyBusinessField("about"),
    key: "business.about",
    inBudget: relevance.businessInfo,
    taskRequired: true,
  });
  // CONDITIONAL contact fact — only on contact/identity asks. Recorded in
  // the ledger; not part of today's context budget (never forwarded).
  evaluateCandidate({
    ledger,
    scope,
    source: "BUSINESS_RECORD",
    businessId: businessProvenance,
    visibility: classifyBusinessField("whatsappNumber"),
    key: "business.whatsappNumber",
    inBudget: false,
    taskRequired: relevance.contactOrIdentity,
  });
  // CONDITIONAL location fact (PROMPT-AI-OPS-21): the customer-facing
  // address line, carried ONLY on a contact/identity/location turn — the
  // same gate `whatsappNumber` uses. `contactOrIdentity` already covers the
  // Egyptian location vocabulary («العنوان»/«عنوان»/«مكان»/«أين»/«وين»), so
  // no new relevance family is needed. The fact is PUBLIC in level but
  // task-gated, exactly like `about` on a business-info turn: an unrelated
  // turn never carries the address, and a missing address contributes
  // nothing (never invented).
  const addressVerdict = evaluateCandidate({
    ledger,
    scope,
    source: "BUSINESS_RECORD",
    businessId: businessProvenance,
    visibility: classifyBusinessField("address"),
    key: "business.address",
    inBudget: relevance.contactOrIdentity,
    taskRequired: true,
  });
  // CONDITIONAL policy fact — only on cancellation/reschedule asks.
  // Recorded in the ledger; not part of today's context budget.
  evaluateCandidate({
    ledger,
    scope,
    source: "BUSINESS_RECORD",
    businessId: businessProvenance,
    visibility: classifyBusinessField("cancellationPolicy"),
    key: "business.cancellationPolicy",
    inBudget: false,
    taskRequired: relevance.cancellationOrReschedule,
  });

  // ── 4. INTERNAL operational facts (Phase 3 — classified, then omitted) ───
  // These exist on the Business record; they are NOT forwarded merely
  // because they exist. Availability is domain-computed (CORE-02), never
  // LLM-reasoned from raw schedules, so the raw operational dataset stays
  // out of context and only the derived domain result may enter (§5).
  for (const field of [
    "workingHours",
    "slotDurationMinutes",
    "confirmationMode",
    "timezone",
    "vertical",
    "city",
  ] as const) {
    evaluateCandidate({
      ledger,
      scope,
      source: "BUSINESS_RECORD",
      businessId: businessProvenance,
      visibility: classifyBusinessField(field),
      key: `business.${field}`,
      inBudget: false,
      taskRequired: false,
    });
  }

  // Internal identifiers are FORBIDDEN as facts: tenant identity travels as
  // provenance on the envelope, never as content. Refused at enrollment —
  // a candidate that can never be constructed.
  for (const field of ["id", "defaultBranchId"] as const) {
    evaluateCandidate({
      ledger,
      scope,
      source: "BUSINESS_RECORD",
      businessId: businessProvenance,
      visibility: classifyBusinessField(field),
      key: `business.${field}`,
      inBudget: false,
      taskRequired: false,
    });
  }

  // ── 5. The canonical FAQ store (PUBLIC as a whole — DECISIONS #13) ───────
  const faqs = safeFaqs(sources.business.faqs);
  const faqVerdict = evaluateCandidate({
    ledger,
    scope,
    source: "BUSINESS_FAQ_STORE",
    businessId: businessProvenance,
    visibility: classifyFaqStore(),
    key: "business.faqs",
    inBudget: true,
    taskRequired: true,
  });

  // ── 6. Service catalog (names PUBLIC; duration INTERNAL — B-03 decides) ──
  // Service descriptions are PUBLIC but PROMPT-AI-ARCH-15 (Slice 6) carries
  // them ONLY on a service-info turn, and only for a BOUNDED set: services the
  // turn actually references, otherwise at most AI_SERVICE_DESCRIPTION_LIMIT
  // descriptive entries (a bounded catalog summary — never a full dump).
  const descriptionServiceIds = new Set<string>();
  if (relevance.serviceInfo) {
    for (const service of sources.services) {
      if (descriptionServiceIds.size >= AI_SERVICE_DESCRIPTION_LIMIT) break;
      if (!service.description || !service.description.trim()) continue;
      if (serviceReferenced(service.name, sources.message)) {
        descriptionServiceIds.add(service.id);
      }
    }
    if (descriptionServiceIds.size === 0) {
      for (const service of sources.services) {
        if (descriptionServiceIds.size >= AI_SERVICE_DESCRIPTION_LIMIT) break;
        if (!service.description || !service.description.trim()) continue;
        descriptionServiceIds.add(service.id);
      }
    }
  }

  const seenServiceNames = new Set<string>();
  const includedServices: Array<{
    name: string;
    price?: string;
    description?: string;
  }> = [];
  for (const service of sources.services) {
    // Per-row tenant proof: a service from another Business is excluded,
    // never resolved by the AI.
    const nameVerdict = evaluateCandidate({
      ledger,
      scope,
      source: "SERVICE_CATALOG",
      businessId: service.businessId,
      visibility: classifyServiceField("name"),
      key: `service.name:${service.name}`,
      inBudget: true,
      taskRequired: true,
    });
    if (!nameVerdict.included) continue;
    if (seenServiceNames.has(service.name)) continue; // dedupe by name
    seenServiceNames.add(service.name);
    const included: {
      name: string;
      price?: string;
      description?: string;
    } = { name: service.name };

    // durationMinutes is INTERNAL and no current AI task requires it:
    // availability comes from CORE-02, not from LLM schedule reasoning.
    // Classified and omitted — never forwarded merely because it exists.
    evaluateCandidate({
      ledger,
      scope,
      source: "SERVICE_CATALOG",
      businessId: service.businessId,
      visibility: classifyServiceField("durationMinutes"),
      key: `service.durationMinutes:${service.name}`,
      inBudget: true,
      taskRequired: false,
    });
    // Service price (PROMPT-AI-ARCH-13 — Slice 6): CONDITIONAL, exposed ONLY
    // when the turn is price-relevant AND an authoritative price is stored.
    // The deterministic formatter turns the structured columns into the
    // MINIMAL display string; a service with no stored price contributes
    // nothing (never a fabricated amount — missing price stays NO_KNOWLEDGE).
    const formattedPrice = formatServicePrice({
      priceType: service.priceType ?? null,
      priceAmount: service.priceAmount ?? null,
      priceMaxAmount: service.priceMaxAmount ?? null,
      priceCurrency: service.priceCurrency ?? null,
      priceNote: service.priceNote ?? null,
    });
    const priceVerdict = evaluateCandidate({
      ledger,
      scope,
      source: "SERVICE_CATALOG",
      businessId: service.businessId,
      visibility: classifyServiceField("price"),
      key: `service.price:${service.name}`,
      inBudget: true,
      taskRequired: relevance.priceOrFee,
    });
    if (priceVerdict.included && formattedPrice) {
      included.price = formattedPrice;
    }
    // Service description (PROMPT-AI-ARCH-15 — Slice 6): PUBLIC, exposed ONLY
    // on a service-info turn AND only for the bounded relevant set. A service
    // with no stored description contributes nothing — never invented.
    const descriptionWanted = descriptionServiceIds.has(service.id);
    const descriptionVerdict = evaluateCandidate({
      ledger,
      scope,
      source: "SERVICE_CATALOG",
      businessId: service.businessId,
      visibility: classifyServiceField("description"),
      key: `service.description:${service.name}`,
      inBudget: descriptionWanted,
      taskRequired: true,
    });
    if (
      descriptionVerdict.included &&
      service.description &&
      service.description.trim()
    ) {
      included.description = service.description.trim();
    }
    includedServices.push(included);
    // Internal identifiers are FORBIDDEN as facts — provenance only.
    evaluateCandidate({
      ledger,
      scope,
      source: "SERVICE_CATALOG",
      businessId: service.businessId,
      visibility: classifyServiceField("id"),
      key: `service.id:${service.id}`,
      inBudget: false,
      taskRequired: false,
    });
  }

  // Aggregate service-catalog NAME disclosure family (PROMPT-AI-OPS-20):
  // the ONE ledger key the disclosure gate consults to back a catalog-listing
  // reply ("ايه الخدمات اللي عندكم؟"). Service `name` is PUBLIC and the
  // per-service names are ALWAYS carried in `request.services` (the model
  // needs the catalog for booking/discovery), but this AGGREGATE disclosure
  // family is armed ONLY on a catalog-listing turn (`serviceCatalog`) — the
  // same budget-gate pattern `service.description` uses with `serviceInfo`.
  // That is what keeps the disclosure backstop intact for NON-catalog
  // questions: on a location/hours/about turn the names stay in the base
  // catalog (still usable for booking) but cannot back a self-authored reply,
  // so an unbacked answer is still refused. It is the missing sibling of the
  // existing `service.price` / `service.description` aggregates: B-01 declares
  // a service name "AI may mention", B-02 carries it, and before this the
  // gate had NO channel that recognized a carried catalog — so an answerable
  // services-list reply was refused even though its backing facts were
  // legitimately exposed. `channelCarried("serviceNames")` separately proves a
  // name is actually carried, so this family can never emit an invented
  // service.
  evaluateCandidate({
    ledger,
    scope,
    source: "SERVICE_CATALOG",
    businessId: scopeId,
    visibility: classifyServiceField("name"),
    key: "service.name",
    inBudget: relevance.serviceCatalog,
    taskRequired: true,
  });

  // Aggregate service-price disclosure family (PROMPT-AI-ARCH-13 — Slice 6):
  // the ONE ledger key the disclosure gate consults to back a price answer
  // (a per-service key cannot be matched by the gate's single-family lookup).
  // CONDITIONAL + task-gated on price relevance; `channelCarried("services")`
  // in the gate separately proves a price is actually carried, so this family
  // being disclosable never emits an invented price.
  evaluateCandidate({
    ledger,
    scope,
    source: "SERVICE_CATALOG",
    businessId: scopeId,
    visibility: classifyServiceField("price"),
    key: "service.price",
    inBudget: true,
    taskRequired: relevance.priceOrFee,
  });

  // Aggregate service-description disclosure family (PROMPT-AI-ARCH-15 —
  // Slice 6): the ONE ledger key the disclosure gate consults to back a
  // service-detail answer (per-service keys cannot be matched by the gate's
  // single-family lookup). PUBLIC, but IN BUDGET ONLY on a service-info turn;
  // `channelCarried("serviceDescriptions")` separately proves a description is
  // actually carried, so this family being disclosable never emits an invented
  // service detail.
  evaluateCandidate({
    ledger,
    scope,
    source: "SERVICE_CATALOG",
    businessId: scopeId,
    visibility: classifyServiceField("description"),
    key: "service.description",
    inBudget: relevance.serviceInfo,
    taskRequired: true,
  });

  // ── 7. Domain-computed availability (CORE-02 truth — CONDITIONAL) ────────
  let availabilityIncluded = false;
  if (sources.availability) {
    const availabilityVerdict = evaluateCandidate({
      ledger,
      scope,
      source: "DOMAIN_AVAILABILITY",
      businessId: scopeId,
      visibility: classifyConversationField("availability"),
      key: "domain.availability",
      inBudget: true,
      taskRequired: relevance.bookingOrAvailability,
    });
    availabilityIncluded = availabilityVerdict.included;
  }

  // ── 8. Provider preference (CONDITIONAL — provider-choice asks) ──────────
  let providerPreferenceIncluded = false;
  if (sources.providerPreference) {
    const preferenceVerdict = evaluateCandidate({
      ledger,
      scope,
      source: "CONVERSATION_STATE",
      businessId: scopeId,
      visibility: classifyConversationField("providerPreference"),
      key: "conversation.providerPreference",
      inBudget: true,
      taskRequired: relevance.providerChoice,
    });
    providerPreferenceIncluded = preferenceVerdict.included;
  }

  // ── 9. Conversation context projection (CONV-CORE-02) ───────────────────
  let conversationContextIncluded = false;
  let projectedContext: ConversationContextProjection | null = null;
  if (sources.conversationState) {
    const stateBusinessId =
      (sources.conversationState as { businessId?: string }).businessId ??
      sources.conversationState.offer?.businessId ??
      scopeId;
    const contextVerdict = evaluateCandidate({
      ledger,
      scope,
      source: "CONVERSATION_STATE",
      businessId: stateBusinessId,
      visibility: classifyConversationField("conversationContext"),
      key: "conversation.context",
      inBudget: true,
      taskRequired: true,
    });
    conversationContextIncluded = contextVerdict.included;
    if (conversationContextIncluded) {
      projectedContext = projectConversationState(sources.conversationState, {
        now: sources.now,
      });
    }
  }

  // ── Compose the request (provenance dropped, only eligible facts) ────────
  const request: AiRequest = {
    message: messageVerdict.included ? sources.message : "",
    conversationStatus: statusVerdict.included
      ? sources.conversation.status
      : "AI_ACTIVE",
    recentMessages: historyVerdict.included
      ? sources.conversation.recentMessages
          .slice(-AI_RECENT_MESSAGE_LIMIT)
          .map((message) => ({
            senderType: message.senderType as "CUSTOMER" | "AI" | "STAFF",
            content: message.content,
          }))
      : [],
    businessName: nameVerdict.included ? sources.business.name : "",
    services: includedServices,
    faqs: faqVerdict.included ? faqs : [],
    // The assistant's VOICE (DECISIONS #62) — a phrasing directive, not
    // knowledge: it comes from no source, carries no business facts, and
    // the budget ledger has nothing to classify for it. PROMPT-AI-UX-01:
    // when the business persisted a style it is resolved over the resident
    // default (fail-safe); otherwise the resident directive is used.
    assistantStyle: sources.business.assistantStyle
      ? businessAssistantStyleDirective(sources.business.assistantStyle)
      : ASSISTANT_STYLE_DIRECTIVE,
    ...(aboutVerdict.included &&
    sources.business.about &&
    sources.business.about.trim()
      ? { businessAbout: sources.business.about.trim() }
      : {}),
    ...(addressVerdict.included &&
    sources.business.address &&
    sources.business.address.trim()
      ? { businessAddress: sources.business.address.trim() }
      : {}),
    ...(providerPreferenceIncluded
      ? { providerPreference: sources.providerPreference ?? undefined }
      : {}),
    ...(availabilityIncluded
      ? {
          availability: (sources.availability ?? []).map((result) => ({
            date: result.date,
            slots: [...result.slots],
          })),
        }
      : {}),
    ...(conversationContextIncluded && projectedContext
      ? { conversationContext: projectedContext }
      : {}),
  };

  const excluded = ledger.records.filter((record) => !record.included);
  return { request, facts: ledger.records, excluded };
}

// ─── Static invariants (referenced by the harness; documented here) ─────────

/**
 * The builder holds no secrets by construction: it never imports a
 * credential resolver, never reads `process.env`, and its input type has no
 * field for a credential reference or value. FORBIDDEN categories are
 * refused at enrollment and can never become candidates.
 */
export const CONTEXT_BUILDER_NEVER_HOLDS_SECRETS = true as const;

/** Re-exported so consumers stay in step with B-01's typed reasons. */
export { FACT_EXCLUSION_REASONS };
