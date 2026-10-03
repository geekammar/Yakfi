/**
 * AI readiness (PROMPT-AI-OPS-21) — a deterministic authoring/readiness aid.
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
  /** Arabic status label the owner sees. */
  readonly statusLabel: string;
  /**
   * Optional count carried alongside the status (the FAQ item shows how many
   * answers exist). Omitted when the item has no meaningful count.
   */
  readonly count?: number;
  /** The existing editor the admin jumps to. */
  readonly href: string;
};

export type AiReadinessServiceFact = {
  readonly isActive: boolean;
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
  partial: "مكتمل جزئيًا",
  missing: "ناقص",
};

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
  const described = activeServices.filter((service) =>
    hasText(service.description),
  );
  const priced = activeServices.filter((service) => hasText(service.priceType));

  const servicesStatus: AiReadinessStatus =
    activeServices.length === 0
      ? "missing"
      : described.length === activeServices.length
        ? "complete"
        : "partial";

  const faqs = faqCount(input.faqs);

  return [
    {
      key: "about",
      label: "نبذة عن النشاط",
      status: hasText(input.about) ? "complete" : "missing",
      statusLabel: STATUS_LABELS[hasText(input.about) ? "complete" : "missing"],
      href: "/settings",
    },
    {
      key: "address",
      label: "موقع النشاط",
      status: hasText(input.address) ? "complete" : "missing",
      statusLabel:
        STATUS_LABELS[hasText(input.address) ? "complete" : "missing"],
      href: "/settings",
    },
    {
      key: "hours",
      label: "أوقات العمل",
      status: openDayCount(input.workingHours) > 0 ? "complete" : "missing",
      statusLabel:
        STATUS_LABELS[
          openDayCount(input.workingHours) > 0 ? "complete" : "missing"
        ],
      href: "/onboarding/hours",
    },
    {
      key: "services",
      label: "الخدمات",
      status: servicesStatus,
      statusLabel: STATUS_LABELS[servicesStatus],
      count: activeServices.length,
      href: "/services",
    },
    {
      key: "prices",
      label: "الأسعار",
      status: priced.length > 0 ? "complete" : "missing",
      statusLabel: STATUS_LABELS[priced.length > 0 ? "complete" : "missing"],
      count: priced.length,
      href: "/services",
    },
    {
      key: "faqs",
      label: "الأسئلة الشائعة",
      status: faqs > 0 ? "complete" : "missing",
      statusLabel: STATUS_LABELS[faqs > 0 ? "complete" : "missing"],
      count: faqs,
      href: "/settings/knowledge",
    },
  ];
}

/** How many of the readiness items are complete (0..total). Deterministic. */
export function aiReadinessCompleteCount(
  items: ReadonlyArray<AiReadinessItem>,
): number {
  return items.filter((item) => item.status === "complete").length;
}
