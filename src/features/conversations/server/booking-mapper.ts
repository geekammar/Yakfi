/**
 * Conversation -> Booking mapper (PROMPT-AI-03A).
 *
 * Pure, provider-neutral mapping from the validated `AiResponse`
 * extraction facts to the deterministic CORE-01/CORE-02 domain input.
 *
 * Rules (hard):
 * - `businessId` / `branchId` are ALWAYS server-derived (caller passes
 *   them); any hostile `businessId`/`role`/`accountType`/tenant keys
 *   that might appear in raw AI output are stripped by `parseAiResponse`
 *   before this mapper ever sees the data — this mapper uses only the
 *   parsed `AiResponse.extraction` fields.
 * - `ANY_PROVIDER` is never a fabricated `providerId`: ANY phrases map
 *   to `providerId: undefined` (CORE-02 `preference: ANY`).
 * - Service matching is deterministic Arabic-normalized (via
 *   `normalizeArabicText`), no fuzzy/LLM, no external service.
 * - The mapper never touches Prisma, never creates appointments, never
 *   calls an LLM/WhatsApp boundary — it interprets; CORE-01/02 decide.
 */
import type { AiResponse } from "@/features/conversations/server/ai-contract";
import { normalizeArabicText } from "@/features/conversations/server/conversation-ai";

// ─── ANY_PROVIDER phrases (normalized forms) ────────────────────────────────
const ANY_PROVIDER_RAW = [
  "اي دكتور",
  "أي دكتور",
  "اي مزود",
  "أي مزود",
  "اي حد",
  "أي حد",
  "اي شخص",
  "أي شخص",
  "اي واحد",
  "أي واحد",
  "لا يهم",
  "اي طبيب",
  "أي طبيب",
  "any provider",
  "any doctor",
  "anyone",
];

const ANY_PROVIDER_NORMALIZED = new Set(
  ANY_PROVIDER_RAW.map((p) => normalizeArabicText(p)),
);

/**
 * Returns true when the provider text expresses "any provider".
 * Normalized exact match only — deterministic, no fuzzy.
 */
export function isAnyProviderPhrase(text: string | null): boolean {
  if (!text) return false;
  const n = normalizeArabicText(text);
  if (n.length === 0) return false;
  if (ANY_PROVIDER_NORMALIZED.has(n)) return true;
  // Allow the phrase to appear as a whole token inside a longer extraction
  // e.g. "أي دكتور متاح" -> still ANY
  for (const phrase of ANY_PROVIDER_NORMALIZED) {
    if (n === phrase || n.includes(phrase)) return true;
  }
  return false;
}

export type ServiceMatchResult =
  | { status: "ok"; serviceId: string; serviceName: string }
  | { status: "missing" }
  | { status: "ambiguous"; candidates: Array<{ id: string; name: string }> };

/**
 * Deterministic service matcher: free-form `extraction.service` text vs
 * the business's own services (`serviceRepository.listByBusiness`).
 *
 * - null/empty -> missing (needs clarification)
 * - normalized exact/substring match -> ok when exactly one candidate
 * - zero candidates -> missing
 * - >1 candidates -> ambiguous (needs clarification)
 */
export function matchServiceByName(
  serviceText: string | null,
  services: ReadonlyArray<{ id: string; name: string }>,
): ServiceMatchResult {
  if (!serviceText) return { status: "missing" };
  const needle = normalizeArabicText(serviceText);
  if (needle.length === 0) return { status: "missing" };
  const candidates = services.filter((service) => {
    const hay = normalizeArabicText(service.name);
    if (hay.length === 0) return false;
    // Bidirectional substring — handles "تنظيف" matching "تنظيف أسنان"
    // as well as exact verbatim matches.
    return hay.includes(needle) || needle.includes(hay);
  });
  if (candidates.length === 0) return { status: "missing" };
  if (candidates.length === 1) {
    const found = candidates[0]!;
    return { status: "ok", serviceId: found.id, serviceName: found.name };
  }
  // Multiple matches -> ambiguous unless one is exact equality
  const exact = candidates.filter(
    (service) => normalizeArabicText(service.name) === needle,
  );
  if (exact.length === 1) {
    const found = exact[0]!;
    return { status: "ok", serviceId: found.id, serviceName: found.name };
  }
  return { status: "ambiguous", candidates: candidates.slice(0, 5) };
}

export type ProviderMatchResult =
  | { status: "any" }
  | { status: "ok"; providerId: string; displayName: string }
  | { status: "missing"; reason: "not_found" | "ambiguous" };

/**
 * Deterministic provider matcher against the CORE-01 eligible set.
 * Caller must have already resolved eligibility for the service/branch.
 */
export function matchProviderByName(
  providerText: string | null,
  eligibleProviders: ReadonlyArray<{ providerId: string; displayName: string }>,
): ProviderMatchResult {
  if (!providerText) return { status: "any" };
  if (isAnyProviderPhrase(providerText)) return { status: "any" };
  const needle = normalizeArabicText(providerText);
  if (needle.length === 0) return { status: "any" };
  const candidates = eligibleProviders.filter((provider) => {
    const hay = normalizeArabicText(provider.displayName);
    if (hay.length === 0) return false;
    return hay.includes(needle) || needle.includes(hay);
  });
  if (candidates.length === 1) {
    const found = candidates[0]!;
    return {
      status: "ok",
      providerId: found.providerId,
      displayName: found.displayName,
    };
  }
  if (candidates.length === 0)
    return { status: "missing", reason: "not_found" };
  // Multiple candidates -> attempt exact equality disambiguation
  const exact = candidates.filter(
    (provider) => normalizeArabicText(provider.displayName) === needle,
  );
  if (exact.length === 1) {
    const found = exact[0]!;
    return {
      status: "ok",
      providerId: found.providerId,
      displayName: found.displayName,
    };
  }
  return { status: "missing", reason: "ambiguous" };
}

/**
 * Deterministic provider-NAME selection guard (PROMPT-AI-03B): true only
 * when every token of the customer text appears in ONE real provider
 * display name (normalized). This keeps ordinary short messages
 * ("تمام", "عندكم دكتور؟") from being hijacked as provider selections
 * while still accepting "سارة" for "د. سارة" and "د. أحمد علي".
 */
export function isProviderNameCandidate(
  providerText: string,
  providerDisplayNames: ReadonlyArray<string>,
): boolean {
  const tokens = normalizeArabicText(providerText).split(" ").filter(Boolean);
  if (tokens.length === 0) return false;
  return providerDisplayNames.some((displayName) => {
    const nameTokens = new Set(
      normalizeArabicText(displayName).split(" ").filter(Boolean),
    );
    return tokens.every((token) => nameTokens.has(token));
  });
}

export type BookingMapperInput = {
  businessId: string;
  branchId: string | null;
  services: ReadonlyArray<{ id: string; name: string }>;
  aiResponse: AiResponse;
};

export type BookingMapperOutput =
  | {
      kind: "needs_clarification";
      message: string;
      reason: "MISSING_SERVICE" | "AMBIGUOUS_SERVICE" | "MISSING_DATE";
    }
  | {
      kind: "ready";
      serviceId: string;
      serviceName: string;
      providerText: string | null;
      date: string | null;
      branchId: string | null;
    };

/**
 * First-stage mapping: AiResponse extraction -> domain identifiers.
 * Validates sufficiency without touching CORE-01/02. Tenant/hostile keys
 * are never read — `businessId`/`branchId` come from caller (server
 * derived). `date` is passed through when present (already bounded ISO
 * `YYYY-MM-DD` via `ai-contract.ts`); absent date is surfaced as
 * needs_clarification so the caller can ask the customer.
 */
export function mapAiResponseToBookingInput(
  input: BookingMapperInput,
): BookingMapperOutput {
  const { services, aiResponse, branchId } = input;
  const extraction = aiResponse.extraction;

  const serviceMatch = matchServiceByName(extraction.service, services);
  if (serviceMatch.status === "missing") {
    return {
      kind: "needs_clarification",
      message:
        "يرجى تحديد الخدمة المطلوبة — أخبرنا باسم الخدمة التي ترغب بحجزها.",
      reason: "MISSING_SERVICE",
    };
  }
  if (serviceMatch.status === "ambiguous") {
    const names = serviceMatch.candidates.map((c) => c.name).join("، ");
    return {
      kind: "needs_clarification",
      message: `هناك أكثر من خدمة تطابق طلبك (${names}) — يرجى تحديد الخدمة بدقة.`,
      reason: "AMBIGUOUS_SERVICE",
    };
  }

  // Date is optional at the mapper stage — the engine decides whether
  // to ask for clarification or apply a deterministic default. We surface
  // missing date as needs_clarification; AVAILABILITY callers may still
  // choose a fixed test date, but the mapper stays honest.
  const date = extraction.date;
  if (!date) {
    return {
      kind: "needs_clarification",
      message: "يرجى تحديد التاريخ المطلوب — مثال: 2026-09-14.",
      reason: "MISSING_DATE",
    };
  }

  return {
    kind: "ready",
    serviceId: serviceMatch.serviceId,
    serviceName: serviceMatch.serviceName,
    providerText: extraction.provider,
    date,
    branchId,
  };
}
