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
  "أي مقدم خدمة متاح",
  "اي مقدم خدمة متاح",
  "أي مقدم خدمة",
  "اي مقدم خدمة",
  "أي دكتور متاح",
  "اي دكتور متاح",
  "أي طبيب متاح",
  "اي طبيب متاح",
  "المتاح",
  "اول متاح",
  "أول متاح",
  "مش فارق",
  "مش فارقة",
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
  | { status: "unknown"; raw: string }
  | { status: "ambiguous"; candidates: Array<{ id: string; name: string }> };

const SERVICE_ORDINALS: Record<string, number> = {
  "1": 1,
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
  "١": 1,
  "٢": 2,
  "٣": 3,
  "٤": 4,
  "٥": 5,
  "٦": 6,
  "٧": 7,
  "٨": 8,
  "٩": 9,
  الاول: 1,
  الاولاني: 1,
  التاني: 2,
  الثاني: 2,
  التالت: 3,
  الثالث: 3,
  الرابع: 4,
  الخامس: 5,
  السادس: 6,
};

/**
 * Deterministic service matcher: free-form `extraction.service` text vs
 * the business's own services (`serviceRepository.listByBusiness`).
 *
 * - null/empty -> missing (needs clarification)
 * - index/ordinal/button id -> matches corresponding service by 1-indexed order
 * - normalized exact/substring match -> ok when exactly one candidate
 * - zero candidates -> missing
 * - >1 candidates -> ambiguous (needs clarification)
 */
export function matchServiceByName(
  serviceText: string | null,
  services: ReadonlyArray<{ id: string; name: string }>,
): ServiceMatchResult {
  if (!serviceText) return { status: "missing" };
  const trimmed = serviceText.trim();
  if (trimmed.length === 0) return { status: "missing" };

  // Check structured button / callback or index pattern first
  const callbackMatch = trimmed.match(
    /^(?:service|serv|opt|choice)[_:]([1-9]\d*)$/i,
  );
  if (callbackMatch && callbackMatch[1]) {
    const idx = parseInt(callbackMatch[1], 10);
    if (idx >= 1 && idx <= services.length && services[idx - 1]) {
      const found = services[idx - 1]!;
      return { status: "ok", serviceId: found.id, serviceName: found.name };
    }
  }

  const needle = normalizeArabicText(serviceText);
  if (needle.length === 0) return { status: "missing" };

  const bareOrdinal = needle.startsWith("الخيار ")
    ? needle.replace("الخيار ", "").trim()
    : needle.startsWith("رقم ")
      ? needle.replace("رقم ", "").trim()
      : needle.startsWith("خدمة ")
        ? needle.replace("خدمة ", "").trim()
        : needle;

  if (SERVICE_ORDINALS[bareOrdinal] !== undefined) {
    const idx = SERVICE_ORDINALS[bareOrdinal]!;
    if (idx >= 1 && idx <= services.length && services[idx - 1]) {
      const found = services[idx - 1]!;
      return { status: "ok", serviceId: found.id, serviceName: found.name };
    }
  }

  const candidates = services.filter((service) => {
    const hay = normalizeArabicText(service.name);
    if (hay.length === 0) return false;
    // Bidirectional substring — handles "تنظيف" matching "تنظيف أسنان"
    // as well as exact verbatim matches.
    return hay.includes(needle) || needle.includes(hay);
  });
  if (candidates.length === 0) return { status: "unknown", raw: serviceText };
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
 *
 * @param options.mode - When "catalog_strict", nonempty provider text is strictly
 * matched against the eligible provider catalog without falling back to natural-language
 * "any provider" phrase dictionaries. When "legacy" (default), preserves legacy
 * phrase-based interpretation for existing unmanaged callers.
 */
export function matchProviderByName(
  providerText: string | null,
  eligibleProviders: ReadonlyArray<{ providerId: string; displayName: string }>,
  options?: { mode?: "legacy" | "catalog_strict" },
): ProviderMatchResult {
  const mode = options?.mode ?? "legacy";
  if (providerText === null) return { status: "any" };

  if (mode === "legacy") {
    if (!providerText) return { status: "any" };
    if (isAnyProviderPhrase(providerText)) return { status: "any" };
  } else {
    // catalog_strict: supplied empty or whitespace-only string must not become ANY_PROVIDER
    if (providerText.trim().length === 0) {
      return { status: "missing", reason: "not_found" };
    }
  }

  const byId = eligibleProviders.find((p) => p.providerId === providerText);
  if (byId) {
    return {
      status: "ok",
      providerId: byId.providerId,
      displayName: byId.displayName,
    };
  }

  const needle = normalizeArabicText(providerText);
  if (needle.length === 0) {
    // In catalog_strict mode, normalization-empty input (e.g. punctuation or diacritics only)
    // is an invalid candidate that must prompt clarification, not silently permit all providers.
    return mode === "catalog_strict"
      ? { status: "missing", reason: "not_found" }
      : { status: "any" };
  }
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
  defaultServiceId?: string | null;
};

export type BookingMapperOutput =
  | {
      kind: "needs_clarification";
      message: string;
      reason: "MISSING_SERVICE" | "AMBIGUOUS_SERVICE" | "MISSING_DATE";
      serviceId?: string;
      serviceName?: string;
      providerText?: string | null;
    }
  | {
      kind: "ready";
      serviceId: string;
      serviceName: string;
      /**
       * CONV-CORE-01 — CUSTOMER when the customer's own words resolved the
       * service; DEFAULT when the configured default / single-service rule
       * supplied it.
       */
      serviceSource: "CUSTOMER" | "DEFAULT";
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
  const { services, aiResponse, branchId, defaultServiceId } = input;
  const extraction = aiResponse.extraction;

  let serviceMatch = matchServiceByName(extraction.service, services);
  const serviceSource: "CUSTOMER" | "DEFAULT" =
    serviceMatch.status === "missing" ? "DEFAULT" : "CUSTOMER";
  if (serviceMatch.status === "missing") {
    // 1. Configured default booking service if valid and active (Rule A)
    const defaultService = defaultServiceId
      ? services.find((s) => s.id === defaultServiceId)
      : null;
    if (defaultService) {
      serviceMatch = {
        status: "ok",
        serviceId: defaultService.id,
        serviceName: defaultService.name,
      };
    } else if (services.length === 1 && services[0]) {
      // 2. Single active service auto-resolution (Rule A)
      serviceMatch = {
        status: "ok",
        serviceId: services[0].id,
        serviceName: services[0].name,
      };
    } else if (services.length > 1) {
      // 3. Multiple services without default: show concise real service catalog (Rule A, B)
      const list = services.map((s, idx) => `${idx + 1}. ${s.name}`).join("\n");
      return {
        kind: "needs_clarification",
        message: `يرجى تحديد الخدمة المطلوبة — الخدمات المتاحة لدينا:\n${list}\nأخبرنا باسم أو رقم الخدمة التي ترغب بحجزها.`,
        reason: "MISSING_SERVICE",
      };
    } else {
      return {
        kind: "needs_clarification",
        message:
          "يرجى تحديد الخدمة المطلوبة — أخبرنا باسم الخدمة التي ترغب بحجزها.",
        reason: "MISSING_SERVICE",
      };
    }
  }
  if (serviceMatch.status === "unknown") {
    const list = services.map((s, idx) => `${idx + 1}. ${s.name}`).join("\n");
    return {
      kind: "needs_clarification",
      message: `الخدمة المطلوبة غير متوفرة لدينا — الخدمات المتاحة لدينا:\n${list}\nأخبرنا باسم أو رقم الخدمة التي ترغب بحجزها.`,
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
      message:
        "يرجى تحديد التاريخ المطلوب (مثال: غداً، أو اذكر يوماً وتاريخاً محدداً).",
      reason: "MISSING_DATE",
      serviceId: serviceMatch.serviceId,
      serviceName: serviceMatch.serviceName,
      providerText: extraction.provider,
    };
  }

  return {
    kind: "ready",
    serviceId: serviceMatch.serviceId,
    serviceName: serviceMatch.serviceName,
    serviceSource,
    providerText: extraction.provider,
    date,
    branchId,
  };
}
