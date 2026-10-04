/**
 * AI readiness (PROMPT-AI-OPS-21 / PROMPT-AI-UX-01) — a deterministic
 * authoring/readiness aid.
 *
 * It answers ONE question, from actual stored data only: "does the Business
 * have the information the assistant uses to answer common customer
 * questions?" It is NOT a business score, NOT an AI quality score, NOT
 * analytics: no event telemetry, no aggregation, no history — a pure
 * function over the Business record + the service catalog the caller already
 * loaded. Missing information is reported as missing, never as a guess, and
 * it NEVER blocks usage (the owner may use FlowPilot with any subset filled).
 *
 * The fields tracked are exactly the ones the EXISTING assistant can already
 * reach through the B-01/B-02/B-03 seams:
 *   - about      → the `businessAbout` channel (business-profile asks)
 *   - address    → the `businessAddress` channel (location asks)
 *   - hours      → the authoritative working-hours mechanism (availability is
 *                  domain-computed by CORE-02 from these hours)
 *   - services   → the PUBLIC service catalog (names always; the optional
 *                  description is what makes a service "fully" described)
 *   - prices     → the optional structured service price (authoritative DOMAIN
 *                  data — price is never duplicated into the FAQ store)
 *   - faqs       → the canonical `Business.faqs` store
 *
 * Deterministic + pure: same input ⇒ same output, no I/O, no LLM, no env, no
 * Prisma, no clock. Safe to render server-side and to unit-test directly.
 */

import { workingHoursSchema } from "@/lib/validation";

export type AiReadinessStatus = "complete" | "partial" | "missing";

export type AiReadinessItem = {
  /** Stable machine key (for test assertions, never customer-visible). */
  readonly key: string;
  /** Arabic label the owner sees. */
  readonly label: string;
  readonly status: AiReadinessStatus;
  /**
   * Arabic status label the owner sees. Derived (see `statusLabelFor`): a
   * MISSING OPTIONAL item reads «اختياري» — never a guilt-inducing
   * «ناقص» — because the business may legitimately never fill it.
   */
  readonly statusLabel: string;
  /**
   * Optional count carried alongside the status (the FAQ item shows how many
   * answers exist). Omitted when the item has no meaningful count.
   */
  readonly count?: number;
  /**
   * (PROMPT-AI-UX-01) Whether this item is part of the MINIMUM the assistant
   * needs to answer the most common customer questions without a human
   * (core), or ENRICHMENT the business may skip (optional). Only core items
   * gate the «مساعدك جاهز» state; an optional item never blocks readiness
   * and never reads as missing.
   */
  readonly optional: boolean;
  /** The existing editor the admin jumps to. */
  readonly href: string;
};

export type AiReadinessServiceFact = {
  readonly isActive: boolean;
  /**
   * Kept for information only. A service DESCRIPTION is OPTIONAL (prompt §11)
   * and is deliberately NON-GATING: the assistant answers "what services do
   * you have?" from the PUBLIC names alone, so a missing description is
   * enrichment, not missing information. Do not reintroduce description-
   * driven readiness gating.
   */
  readonly description: string | null;
  readonly priceType: string | null;
};

export type AiReadinessInput = {
  readonly about: string | null;
  readonly address: string | null;
  /** Raw `Business.workingHours` JSON. */
  readonly workingHours: unknown;
  readonly services: ReadonlyArray<AiReadinessServiceFact>;
  /** Raw `Business.faqs` JSON. */
  readonly faqs: unknown;
};

const STATUS_LABELS: Record<AiReadinessStatus, string> = {
  complete: "مكتمل",
  partial: "يحتاج مراجعة",
  missing: "غير مكتمل",
};

/**
 * (PROMPT-AI-UX-01) The four approved, deterministic, non-numeric readiness
 * states. A core item that is absent reads «غير مكتمل»; an OPTIONAL item
 * that is absent reads «اختياري» — color is never the only cue, so an
 * optional gap is never presented as a failure.
 */
export function statusLabelFor(
  status: AiReadinessStatus,
  optional: boolean,
): string {
  if (status === "complete") return STATUS_LABELS.complete;
  if (status === "partial") return STATUS_LABELS.partial;
  return optional ? "اختياري" : STATUS_LABELS.missing;
}

function hasText(value: string | null): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Malformed stored hours degrade to "no hours" — never crash, never guess.
 * A day counts as open when the stored entry is valid and not closed.
 */
function openDayCount(raw: unknown): number {
  const parsed = workingHoursSchema.safeParse(raw);
  if (!parsed.success) return 0;
  return Object.values(parsed.data).filter((entry) => !entry.closed).length;
}

/** Malformed stored FAQs degrade to zero — never crash. */
function faqCount(raw: unknown): number {
  return Array.isArray(raw) ? raw.length : 0;
}

/**
 * Compute the readiness items in a fixed, deterministic order. Every item
 * derives ONLY from the passed data; nothing is inferred or defaulted.
 */
export function computeAiReadiness(input: AiReadinessInput): AiReadinessItem[] {
  const activeServices = input.services.filter((service) => service.isActive);
  const priced = activeServices.filter((service) => hasText(service.priceType));

  const servicesStatus: AiReadinessStatus =
    activeServices.length === 0 ? "missing" : "complete";

  const faqs = faqCount(input.faqs);

  return [
    {
      key: "about",
      label: "نبذة عن النشاط",
      status: hasText(input.about) ? "complete" : "missing",
      statusLabel: statusLabelFor(
        hasText(input.about) ? "complete" : "missing",
        false,
      ),
      optional: false,
      href: "/settings",
    },
    {
      key: "address",
      label: "موقع النشاط",
      status: hasText(input.address) ? "complete" : "missing",
      statusLabel: statusLabelFor(
        hasText(input.address) ? "complete" : "missing",
        false,
      ),
      optional: false,
      href: "/settings",
    },
    {
      key: "hours",
      label: "أوقات العمل",
      status: openDayCount(input.workingHours) > 0 ? "complete" : "missing",
      statusLabel: statusLabelFor(
        openDayCount(input.workingHours) > 0 ? "complete" : "missing",
        false,
      ),
      optional: false,
      href: "/onboarding/hours",
    },
    {
      key: "services",
      label: "الخدمات",
      status: servicesStatus,
      statusLabel: statusLabelFor(servicesStatus, false),
      count: activeServices.length,
      optional: false,
      href: "/services",
    },
    {
      key: "prices",
      label: "الأسعار",
      status: priced.length > 0 ? "complete" : "missing",
      statusLabel: statusLabelFor(
        priced.length > 0 ? "complete" : "missing",
        true,
      ),
      count: priced.length,
      optional: true,
      href: "/services",
    },
    {
      key: "faqs",
      label: "الأسئلة الشائعة",
      status: faqs > 0 ? "complete" : "missing",
      statusLabel: statusLabelFor(faqs > 0 ? "complete" : "missing", true),
      count: faqs,
      optional: true,
      href: "/settings/knowledge",
    },
  ];
}

/**
 * (PROMPT-AI-UX-01) The deterministic READY rule — the smallest honest
 * definition of "the assistant has what it needs for the common customer
 * questions". A business is ready when every CORE (non-optional) item is
 * COMPLETE. Enrichment items (prices, FAQs) never gate readiness: the
 * assistant answers price/FAQ questions by handing off honestly rather than
 * fabricating, so their absence degrades quality without breaking the loop.
 *
 * This is an authoring aid, NOT a model-performance metric: it asserts only
 * that the minimum information is present, never that replies are accurate.
 */
export function isAssistantReady(
  items: ReadonlyArray<AiReadinessItem>,
): boolean {
  return items
    .filter((item) => !item.optional)
    .every((item) => item.status === "complete");
}

/**
 * (PROMPT-AI-UX-01) The single highest-value next action: the first CORE
 * item that is not complete (missing first, then partial). Returns `null`
 * when the assistant is ready, so the dashboard can show the positive state
 * and route to enrichment instead.
 */
export function nextReadinessAction(
  items: ReadonlyArray<AiReadinessItem>,
): AiReadinessItem | null {
  const core = items.filter((item) => !item.optional);
  return (
    core.find((item) => item.status === "missing") ??
    core.find((item) => item.status === "partial") ??
    null
  );
}

/** How many of the readiness items are complete (0..total). Deterministic. */
export function aiReadinessCompleteCount(
  items: ReadonlyArray<AiReadinessItem>,
): number {
  return items.filter((item) => item.status === "complete").length;
}
