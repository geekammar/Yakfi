/**
 * Founder Conversation Lab — pure UI logic (UX-LAB-01D-1).
 *
 * The deterministic, side-effect-free helpers behind the read-only Copy Lab
 * browser: display labels for the registry's own enum vocabularies, plus the
 * search/filter/group projections and the safe demonstration placeholder
 * values. Every function here is pure — it reads registry entries and returns
 * NEW structures; it never mutates the registry, never renders, and never
 * touches a database, provider, network, or the customer reply path.
 *
 * The Lab's PREVIEW deliberately lives in the component layer and goes through
 * the canonical `renderCopy()` contract; this module only prepares the VALUES
 * (and drops empty ones so a cleared required placeholder surfaces the
 * renderer's typed MISSING_PLACEHOLDER_VALUE failure instead of a silent
 * empty substitution).
 *
 * UX-LAB-01D-2 compatibility: `filterCopyEntries` / `groupCopyEntriesByCategory`
 * operate on `CopyRegistryEntry` and are agnostic to any future override state
 * the detail view may attach, so the persistence slice can extend the browser
 * without rewriting these projections.
 */
import type { CanonicalCopyKey } from "@/features/conversation-copy/registry";
import type {
  CopyCategory,
  CopyClassification,
  CopyRegistryEntry,
} from "@/features/conversation-copy/types";
import type { CopyValidationFailureCode } from "@/features/conversation-copy/validation";

/** Arabic display labels for the registry's three classifications. */
export const COPY_CLASSIFICATION_LABELS: Readonly<
  Record<CopyClassification, string>
> = {
  EDITABLE_COPY: "نص قابل للتعديل",
  EDITABLE_TEMPLATE: "قالب قابل للتعديل",
  PROTECTED_COPY: "نص محمي",
};

/** Arabic display labels for the registry's nine categories. */
export const COPY_CATEGORY_LABELS: Readonly<Record<CopyCategory, string>> = {
  greeting: "التحية",
  identity: "هوية المنشأة",
  clarification: "التوضيح",
  interruption: "المقاطعة",
  continuation: "الاستئناف",
  booking: "الحجز",
  handoff: "التحويل للإنسان",
  error: "الأخطاء",
  channel: "القنوات",
};

/**
 * Short Arabic guidance for each classification, shown in the entry detail so
 * a founder understands what is editable before any edit surface exists.
 */
export const COPY_CLASSIFICATION_HINTS: Readonly<
  Record<CopyClassification, string>
> = {
  EDITABLE_COPY: "نص حر بدون حقول ديناميكية — يمكن تعديل صياغته لاحقاً.",
  EDITABLE_TEMPLATE:
    "قالب يحتوي على حقول ديناميكية بين أقواس — يلزم الحفاظ عليها عند التعديل.",
  PROTECTED_COPY: "نص محمي للسلامة — للقراءة فقط ولا يمكن تعديله أو نشره.",
};

/**
 * The classification filter chips, "الكل" first. `ALL` is a UI-only sentinel
 * on top of the registry's own classification vocabulary — no synthetic
 * classification is ever added to the registry.
 */
export type CopyClassificationFilter = "ALL" | CopyClassification;

export const COPY_CLASSIFICATION_FILTER_VALUES: readonly CopyClassificationFilter[] =
  ["ALL", "EDITABLE_COPY", "EDITABLE_TEMPLATE", "PROTECTED_COPY"];

export const COPY_CLASSIFICATION_FILTER_LABELS: Readonly<
  Record<CopyClassificationFilter, string>
> = {
  ALL: "الكل",
  ...COPY_CLASSIFICATION_LABELS,
};

/**
 * Runtime relevance answers ONE question: is this wording still produced by
 * the current default path? It is deliberately separate from whether the Lab
 * override store is consumed at runtime (`getCopyRuntimeCoverage` below).
 *
 * - CURRENT_OPERATIONAL_TEMPLATE — deterministic engine/domain wording that
 *   the current operational path can emit.
 * - AUTHORITATIVE_DATA_PRESENTATION — server-rendered business data, not a
 *   response template and not model-authored prose.
 * - LEGACY_ONLY_PATH — wording reachable only through a legacy/fallback
 *   assistant (including the policy-read failure path), not the default
 *   structured path.
 * - UNUSED_CODE — the symbol exists but no caller emits it.
 * - UNRESOLVED — evidence is insufficient to classify safely.
 */
export type CopyRuntimeRelevance =
  | "CURRENT_OPERATIONAL_TEMPLATE"
  | "AUTHORITATIVE_DATA_PRESENTATION"
  | "LEGACY_ONLY_PATH"
  | "UNUSED_CODE"
  | "UNRESOLVED";

export const COPY_RUNTIME_RELEVANCE_LABELS: Readonly<
  Record<CopyRuntimeRelevance, string>
> = {
  CURRENT_OPERATIONAL_TEMPLATE: "نص تشغيلي حالي",
  AUTHORITATIVE_DATA_PRESENTATION: "عرض بيانات مرجعية",
  LEGACY_ONLY_PATH: "مسار قديم/احتياطي",
  UNUSED_CODE: "نص غير مستخدم",
  UNRESOLVED: "يحتاج تحقيقاً",
};

export const COPY_RUNTIME_RELEVANCE_HINTS: Readonly<
  Record<CopyRuntimeRelevance, string>
> = {
  CURRENT_OPERATIONAL_TEMPLATE:
    "النص يُنتج فعلياً من الكود في المسار التشغيلي الحالي، سواء كرد مباشر أو كقالب قرار. هذا لا يعني أن تجاوز المختبر يُقرأ وقت التشغيل.",
  AUTHORITATIVE_DATA_PRESENTATION:
    "صياغة عرض لبيانات المنشأة المرجعية يملكها الخادم؛ ليست تفسيراً لنية العميل ولا استنتاجاً من كلماته.",
  LEGACY_ONLY_PATH:
    "النص موجود في مسار احتياطي/قديم فقط (مثل المساعد الحتمي عند تعذر قراءة سياسة المنصة)، وليس في المسار الافتراضي المهيكل.",
  UNUSED_CODE:
    "الرمز ما زال معرّفاً في الكود لكن لا يوجد مستدعٍ يرسل هذا النص للعميل حالياً.",
  UNRESOLVED:
    "الأدلة الحالية غير كافية لتصنيف هذا المفتاح؛ يلزم تحقيق إضافي قبل أي قرار.",
};

/**
 * Verified relevance per canonical key. Exhaustive by construction: adding a
 * registry key without classifying it is a TypeScript error, and the offline
 * check independently verifies the count. This is presentation metadata only;
 * it never changes registry defaults, storage, or the runtime reply path.
 */
export const COPY_RUNTIME_RELEVANCE_BY_KEY: Readonly<
  Record<CanonicalCopyKey, CopyRuntimeRelevance>
> = {
  "greeting.ack.salam": "LEGACY_ONLY_PATH",
  "greeting.ack.morning": "LEGACY_ONLY_PATH",
  "greeting.ack.evening": "LEGACY_ONLY_PATH",
  "greeting.ack.default": "LEGACY_ONLY_PATH",
  "greeting.invite": "LEGACY_ONLY_PATH",
  "welcome.intro": "CURRENT_OPERATIONAL_TEMPLATE",
  "identity.reply": "AUTHORITATIVE_DATA_PRESENTATION",
  "clarify.intent": "CURRENT_OPERATIONAL_TEMPLATE",
  "clarify.service": "CURRENT_OPERATIONAL_TEMPLATE",
  "clarify.date": "CURRENT_OPERATIONAL_TEMPLATE",
  "clarify.service_ambiguous": "CURRENT_OPERATIONAL_TEMPLATE",
  "clarify.service_ambiguous_offer": "CURRENT_OPERATIONAL_TEMPLATE",
  "interruption.ack": "CURRENT_OPERATIONAL_TEMPLATE",
  "continue.invite": "CURRENT_OPERATIONAL_TEMPLATE",
  "booking.offer": "CURRENT_OPERATIONAL_TEMPLATE",
  "booking.invalid_index": "CURRENT_OPERATIONAL_TEMPLATE",
  "booking.unknown_time": "CURRENT_OPERATIONAL_TEMPLATE",
  "booking.ambiguous_time": "CURRENT_OPERATIONAL_TEMPLATE",
  "booking.conflict": "CURRENT_OPERATIONAL_TEMPLATE",
  "booking.retry": "CURRENT_OPERATIONAL_TEMPLATE",
  "booking.confirmed": "CURRENT_OPERATIONAL_TEMPLATE",
  "booking.pending": "CURRENT_OPERATIONAL_TEMPLATE",
  "booking.stale_options": "CURRENT_OPERATIONAL_TEMPLATE",
  "booking.stale_option": "CURRENT_OPERATIONAL_TEMPLATE",
  "booking.slot_taken": "CURRENT_OPERATIONAL_TEMPLATE",
  "booking.service_unavailable": "CURRENT_OPERATIONAL_TEMPLATE",
  "booking.service_not_found": "CURRENT_OPERATIONAL_TEMPLATE",
  "booking.service_inactive": "CURRENT_OPERATIONAL_TEMPLATE",
  "booking.branch_not_found": "CURRENT_OPERATIONAL_TEMPLATE",
  "booking.no_business": "CURRENT_OPERATIONAL_TEMPLATE",
  "booking.invalid_input": "CURRENT_OPERATIONAL_TEMPLATE",
  "booking.booking_failed": "CURRENT_OPERATIONAL_TEMPLATE",
  "booking.provider_not_eligible": "CURRENT_OPERATIONAL_TEMPLATE",
  "booking.provider_ambiguous": "CURRENT_OPERATIONAL_TEMPLATE",
  "booking.no_eligible_providers": "CURRENT_OPERATIONAL_TEMPLATE",
  "booking.business_closed": "CURRENT_OPERATIONAL_TEMPLATE",
  "booking.service_too_long": "CURRENT_OPERATIONAL_TEMPLATE",
  "booking.fully_booked": "CURRENT_OPERATIONAL_TEMPLATE",
  "booking.no_options": "CURRENT_OPERATIONAL_TEMPLATE",
  "booking.request": "LEGACY_ONLY_PATH",
  "booking.availability": "LEGACY_ONLY_PATH",
  "booking.reschedule": "LEGACY_ONLY_PATH",
  "booking.cancellation": "LEGACY_ONLY_PATH",
  "handoff.human_request": "CURRENT_OPERATIONAL_TEMPLATE",
  "handoff.sensitive": "CURRENT_OPERATIONAL_TEMPLATE",
  "handoff.no_knowledge": "CURRENT_OPERATIONAL_TEMPLATE",
  "handoff.ambiguous": "CURRENT_OPERATIONAL_TEMPLATE",
  "channel.telegram.start_welcome": "UNUSED_CODE",
};

/**
 * Verified per-key notes that must not be flattened into a generic label.
 * These are evidence-backed discrepancies, not future-wiring promises.
 */
export const COPY_RUNTIME_KEY_NOTES: Readonly<
  Partial<Record<CanonicalCopyKey, string>>
> = {
  "booking.confirmed":
    "تحقق: الصياغة الحالية في المحرك تضيف «لدى {businessName}» وتستخدم تعبيراً زمنياً مرناً؛ النص الافتراضي في السجل يحتاج تحديثاً منفصلاً ولا يطابق الإخراج الحالي حرفاً بحرف.",
  "booking.pending":
    "تحقق: الصياغة الحالية في المحرك تضيف «لدى {businessName}» وتستخدم تعبيراً زمنياً مرناً؛ النص الافتراضي في السجل يحتاج تحديثاً منفصلاً ولا يطابق الإخراج الحالي حرفاً بحرف.",
  "channel.telegram.start_welcome":
    "الرمز مُعرَّف ومُصدَّر، لكن لا يوجد مستدعٍ له؛ مسار /start الفعلي يمر عبر المحرك ويستخدم welcome.intro.",
};

export function getCopyRuntimeRelevance(key: string): CopyRuntimeRelevance {
  return COPY_RUNTIME_RELEVANCE_BY_KEY[key as CanonicalCopyKey] ?? "UNRESOLVED";
}

export function isOperationalRuntimeRelevance(
  relevance: CopyRuntimeRelevance,
): boolean {
  return (
    relevance === "CURRENT_OPERATIONAL_TEMPLATE" ||
    relevance === "AUTHORITATIVE_DATA_PRESENTATION"
  );
}

/** A registry-derived classification chip with its live count. */
export type CopyClassificationChip = {
  value: CopyClassificationFilter;
  label: string;
  count: number;
};

/**
 * Build the classification chips from the entries actually in view, so the
 * counts stay derived from the registry (never a hand-maintained tally).
 */
export function buildClassificationChips(
  entries: readonly CopyRegistryEntry[],
): CopyClassificationChip[] {
  return COPY_CLASSIFICATION_FILTER_VALUES.map((value) => ({
    value,
    label: COPY_CLASSIFICATION_FILTER_LABELS[value],
    count:
      value === "ALL"
        ? entries.length
        : entries.filter((entry) => entry.classification === value).length,
  }));
}

/**
 * The default operational view shows only keys whose wording is actually
 * produced by the current runtime path (operational templates and
 * server-rendered authoritative-data presentation). Legacy/fallback wording,
 * unused constants, and unresolved entries stay inspectable behind the
 * explicit "all entries" scope — never implied to be part of today's runtime
 * or a promised future wiring.
 */
export type CopyRuntimeScopeFilter = "OPERATIONAL" | "ALL";

/** Search + classification + runtime-scope filter. Returns a NEW array. */
export function filterCopyEntries(
  entries: readonly CopyRegistryEntry[],
  options: {
    search: string;
    classification: CopyClassificationFilter;
    scope?: CopyRuntimeScopeFilter;
  },
): CopyRegistryEntry[] {
  const needle = options.search.trim().toLowerCase();
  const classification = options.classification;
  const scope = options.scope ?? "ALL";
  return entries.filter((entry) => {
    if (
      scope === "OPERATIONAL" &&
      !isOperationalRuntimeRelevance(getCopyRuntimeRelevance(entry.key))
    ) {
      return false;
    }
    if (classification !== "ALL" && entry.classification !== classification) {
      return false;
    }
    if (needle.length === 0) return true;
    return (
      entry.key.toLowerCase().includes(needle) ||
      entry.humanLabel.toLowerCase().includes(needle) ||
      entry.defaultText.toLowerCase().includes(needle)
    );
  });
}

/** One category group in the browser list. */
export type CopyEntryGroup = {
  category: CopyCategory;
  label: string;
  items: CopyRegistryEntry[];
};

/**
 * Group entries by category in FIRST-APPEARANCE order (the registry's own
 * order), so the grouping stays derived from the registry rather than an
 * imposed external ordering. Returns new arrays; the input is not mutated.
 */
export function groupCopyEntriesByCategory(
  entries: readonly CopyRegistryEntry[],
): CopyEntryGroup[] {
  const groups: CopyEntryGroup[] = [];
  const byCategory = new Map<CopyCategory, CopyEntryGroup>();
  for (const entry of entries) {
    let group = byCategory.get(entry.category);
    if (group === undefined) {
      group = {
        category: entry.category,
        label: COPY_CATEGORY_LABELS[entry.category] ?? entry.category,
        items: [],
      };
      byCategory.set(entry.category, group);
      groups.push(group);
    }
    group.items.push(entry);
  }
  return groups;
}

/**
 * Obvious, safe DEMONSTRATION values for the placeholders a template may
 * interpolate. These exist only so the founder sees a realistic rendered
 * preview on first open — they are never stored, never sent, and never used
 * outside the local preview.
 *
 * Values are provided ONLY for placeholders a key actually declares: the map
 * is keyed by the closed placeholder vocabulary, and `demoPlaceholderValues`
 * below projects it onto one entry's declared placeholders, so no placeholder
 * is ever invented for a key that does not declare it.
 */
const DEMO_OFFER_LINES = [
  "1. استشارة — 5:00 م إلى 6:00 م",
  "2. استشارة متابعة — 6:00 م إلى 7:00 م",
].join("\n");

const DEMO_PLACEHOLDER_VALUES: Readonly<Record<string, string>> = {
  businessName: "عيادة المثال",
  serviceName: "الخدمة",
  date: "الخميس",
  startTime: "5:00 م",
  endTime: "6:00 م",
  providerName: "د. أحمد",
  candidateNames: "استشارة، استشارة متابعة",
  maxIndex: "3",
  offer: DEMO_OFFER_LINES,
};

/**
 * The demonstration values for exactly the placeholders `entry` declares
 * (empty for placeholder-free EDITABLE_COPY / PROTECTED_COPY). Never invents
 * a placeholder: the result's keys are exactly `entry.placeholders`.
 */
export function demoPlaceholderValues(
  entry: CopyRegistryEntry,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const name of entry.placeholders) {
    const demo = DEMO_PLACEHOLDER_VALUES[name];
    if (demo !== undefined) values[name] = demo;
  }
  return values;
}

/**
 * Collect the preview values for one entry from raw input state: each declared
 * placeholder contributes its TRIMMED value ONLY when non-empty. A cleared
 * required placeholder is therefore ABSENT from the map, which is what makes
 * the canonical `renderCopy()` surface its typed
 * MISSING_PLACEHOLDER_VALUE failure instead of silently substituting "".
 *
 * Placeholders the entry does not declare are dropped, matching the renderer's
 * own "only declared placeholders are substituted" rule.
 */
export function collectPreviewValues(
  entry: CopyRegistryEntry,
  raw: Readonly<Record<string, string>>,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const name of entry.placeholders) {
    const value = raw[name];
    if (typeof value === "string" && value.trim().length > 0) {
      values[name] = value.trim();
    }
  }
  return values;
}

/** The Arabic label for a classification, falling back to the raw value. */
export function classificationLabel(
  classification: CopyClassification,
): string {
  return COPY_CLASSIFICATION_LABELS[classification] ?? classification;
}

/** The Arabic label for a category, falling back to the raw value. */
export function categoryLabel(category: CopyCategory): string {
  return COPY_CATEGORY_LABELS[category] ?? category;
}

// ── UX-LAB-01D-2 — effective state, edit gating, history, guidance ──────────
//
// Everything below stays PURE: these are display projections over the
// override service's TYPED results. They never touch a database, never call
// the service, and never import the persistence layer — the inputs are
// structural mirrors of the service's own result shapes (the server boundary
// passes the real typed results in, so `tsc` keeps them in sync), and the
// outputs are Lab-owned view types. The validation RULES themselves are never
// reproduced here: only Arabic product-facing GUIDANCE for the stable
// machine codes the service already decided.

/**
 * The only classifications the Founder Lab may open an editor for.
 * PROTECTED_COPY is visible + previewable but never writable — the lab's
 * safety guarantee (UX-LAB-01B).
 */
export function canEditCopy(entry: CopyRegistryEntry): boolean {
  return entry.classification !== "PROTECTED_COPY";
}

/** Where the effective copy text for one key currently comes from. */
export type EffectiveCopySource = "CODE_DEFAULT" | "PLATFORM_OVERRIDE";

export const EFFECTIVE_SOURCE_LABELS: Readonly<
  Record<EffectiveCopySource, string>
> = {
  CODE_DEFAULT: "الكود (الافتراضي)",
  PLATFORM_OVERRIDE: "تجاوز المنصة",
};

// ── Runtime alignment: relevance vs. override connection (separate) ──────
//
// TWO INDEPENDENT FACTS:
//  1. relevance — is the wording produced by the current default path?
//  2. override connection — does the runtime READ the Lab override for it?
//
// They must never collapse into one badge. Almost every current operational
// key is NOT override-connected; publishing a Lab override for it changes the
// store only. Only `welcome.intro` is both operational and override-connected.

export type CopyOverrideConnection =
  "CONNECTED" | "NOT_CONNECTED" | "NOT_APPLICABLE";

export type CopyRuntimeCoverage = {
  /** Whether the current default path emits this wording at all. */
  readonly relevance: CopyRuntimeRelevance;
  readonly relevanceLabel: string;
  readonly relevanceSummary: string;
  /** Whether the runtime consumes a stored Lab override for this key. */
  readonly overrideConnection: CopyOverrideConnection;
  readonly overrideConnectionLabel: string;
  readonly overrideConnectionSummary: string;
  /** Verified per-key discrepancy/note, when one exists. */
  readonly runtimeNote: string | null;

  // Backwards-compatible projections (still clearly override-scoped).
  /** @deprecated Use `overrideConnection`. Kept for existing consumers. */
  readonly status: "CONNECTED" | "NOT_CONNECTED";
  readonly isConnected: boolean;
  readonly badgeLabel: string;
  readonly statusLabel: string;
  readonly scopeSummary: string;
  readonly operationalNote: string;
};

export const RUNTIME_CONNECTED_KEYS = ["welcome.intro"] as const;

export function isKeyConnectedToRuntime(key: string): boolean {
  return (RUNTIME_CONNECTED_KEYS as readonly string[]).includes(key);
}

function relevanceSummaryFor(relevance: CopyRuntimeRelevance): string {
  switch (relevance) {
    case "CURRENT_OPERATIONAL_TEMPLATE":
      return "النص يُنتج فعلياً من الكود في المسار التشغيلي الحالي. هذا لا يعني أن تجاوز المختبر يُقرأ وقت التشغيل.";
    case "AUTHORITATIVE_DATA_PRESENTATION":
      return "النص عرض مرجعي لبيانات المنشأة يُصيغه الخادم (مثل اسم المنشأة)؛ ليس تفسيراً لنية العميل ولا استنتاجاً من كلماته.";
    case "LEGACY_ONLY_PATH":
      return "النص موجود في مسار احتياطي/قديم فقط (مثل المساعد الحتمي عند تعذر قراءة سياسة المنصة أو المستدعين القدامى)، وليس في المسار الافتراضي المهيكل.";
    case "UNUSED_CODE":
      return "الرمز ما زال معرّفاً في الكود لكن لا يوجد مستدعٍ يرسل هذا النص للعميل حالياً.";
    case "UNRESOLVED":
      return "الأدلة الحالية غير كافية لتصنيف هذا المفتاح؛ يلزم تحقيق إضافي.";
  }
}

export function getCopyRuntimeCoverage(
  key: string,
  classification?: CopyClassification,
): CopyRuntimeCoverage {
  const relevance = getCopyRuntimeRelevance(key);
  const runtimeNote = COPY_RUNTIME_KEY_NOTES[key as CanonicalCopyKey] ?? null;
  const overrideConnected = isKeyConnectedToRuntime(key);

  if (overrideConnected) {
    return {
      relevance,
      relevanceLabel: COPY_RUNTIME_RELEVANCE_LABELS[relevance],
      relevanceSummary: relevanceSummaryFor(relevance),
      overrideConnection: "CONNECTED",
      overrideConnectionLabel: "تجاوز المختبر موصول",
      overrideConnectionSummary:
        "يقرأ المحرك تجاوز welcome.intro من مخزن المنصة في مسار /start فقط (محادثة جديدة أو خاملة بلا عرض نشط/مهمة حجز قائمة)، مع الرجوع للنص الافتراضي عند التعذر. لا يغيّر أزرار الخيارات ولا استئناف حجز نشط، ولا يثبت تسليم مزود الرسائل.",
      runtimeNote,
      status: "CONNECTED",
      isConnected: true,
      badgeLabel: "تجاوز المختبر موصول",
      statusLabel: "تجاوز المختبر موصول بمسار /start",
      scopeSummary: relevanceSummaryFor(relevance),
      operationalNote:
        "التجاوز المنشور والصالح يُقرأ فعلياً في هذا المسار. هذا لا يضمن ولا يثبت تسليم مزود الرسائل الخارجي.",
    };
  }

  if (classification === "PROTECTED_COPY") {
    return {
      relevance,
      relevanceLabel: COPY_RUNTIME_RELEVANCE_LABELS[relevance],
      relevanceSummary: relevanceSummaryFor(relevance),
      overrideConnection: "NOT_APPLICABLE",
      overrideConnectionLabel: "تجاوز المختبر غير متاح (محمي)",
      overrideConnectionSummary:
        "هذا النص محمي لحماية مسارات التحويل الآمن؛ ولا تتوفر له عمليات التعديل أو النشر أو إعادة التعيين أو الاسترجاع في مخزن المنصة.",
      runtimeNote,
      status: "NOT_CONNECTED",
      isConnected: false,
      badgeLabel: "تجاوز غير متاح",
      statusLabel: "تجاوز المختبر غير متاح للنص المحمي",
      scopeSummary: relevanceSummaryFor(relevance),
      operationalNote:
        "للقراءة والمعاينة فقط؛ لا يمكن نشره أو تغييره من المختبر.",
    };
  }

  return {
    relevance,
    relevanceLabel: COPY_RUNTIME_RELEVANCE_LABELS[relevance],
    relevanceSummary: relevanceSummaryFor(relevance),
    overrideConnection: "NOT_CONNECTED",
    overrideConnectionLabel: "تجاوز المختبر غير موصول",
    overrideConnectionSummary:
      "لا يقرأ المحرك تجاوزات المختبر لهذا المفتاح وقت التشغيل: الحفظ أو النشر يغيّر المخزن فقط، وقد يظل النص التشغيلي الحالي يُنتج من الكود. إظهار المفتاح أو وجود نص تشغيلي لا يعني وجود خطة لربط تجاوزه لاحقاً.",
    runtimeNote,
    status: "NOT_CONNECTED",
    isConnected: false,
    badgeLabel: "تجاوز غير موصول",
    statusLabel: "تجاوز المختبر غير موصول بالمحرك",
    scopeSummary: relevanceSummaryFor(relevance),
    operationalNote:
      "تظل إمكانية التعديل والمعاينة وسجل التعديلات والاسترجاع متاحة في المخزن، دون التأثير على أي رد حي ما دام التجاوز غير موصول.",
  };
}

export const PLATFORM_OVERRIDE_SCOPE_NOTE =
  "تنبيه: التجاوزات المنشورة تسري على مستوى كافة المنشآت في المنصة ككل وليست مخصصة لمنشأة بعينها.";

export type MutationKind = "publish" | "reset" | "restore";

export function getMutationFeedbackText(options: {
  kind: MutationKind;
  key: string;
  readbackSuccess: boolean;
  source?: EffectiveCopySource;
}): string {
  const { kind, key, readbackSuccess, source } = options;
  const isConnected = isKeyConnectedToRuntime(key);

  if (!readbackSuccess) {
    if (kind === "publish") {
      return "تم حفظ التعديل بنجاح في مخزن المنصة، لكن تعذر تحديث عرض الحالة الحالية فوراً (دون إثبات قراءة راجعة). يُرجى إغلاق النافذة وإعادة فتحها للتحقق.";
    }
    if (kind === "reset") {
      return "تمت إعادة التعيين وحذف التجاوز بنجاح في مخزن المنصة، لكن تعذر تحديث عرض الحالة الحالية فوراً (دون إثبات قراءة راجعة). يُرجى إغلاق النافذة وإعادة فتحها للتحقق.";
    }
    return "تم استرجاع النسخة المحددة بنجاح في مخزن المنصة، لكن تعذر تحديث عرض الحالة الحالية فوراً (دون إثبات قراءة راجعة). يُرجى إغلاق النافذة وإعادة فتحها للتحقق.";
  }

  const sourceName = source ? (EFFECTIVE_SOURCE_LABELS[source] ?? source) : "";

  if (kind === "publish") {
    if (isConnected) {
      return `تم نشر التجاوز في مخزن المنصة — يُعتمد القالب الآن من ${sourceName} في مسار /start لمحادثة جديدة أو خاملة فقط، مع توفر البديل الافتراضي عند التعذر (لا يعني ذلك التحقق من تسليم المزود).`;
    }
    return `تم حفظ التجاوز في مخزن المنصة — النص المعتمد في المخزن الآن من ${sourceName}. (تنبيه: تجاوز المختبر غير موصول بهذا المفتاح وقت التشغيل، لذلك لن تتغير الردود الحية جرّاء هذا النشر).`;
  }

  if (kind === "reset") {
    if (isConnected) {
      return "تمت إعادة التعيين في مخزن المنصة وحذف التجاوز — يعود المحرك الآن إلى النص الافتراضي في الكود لمسار /start مع استمرار عمل البديل الآمن (لا يعني ذلك التحقق من تسليم المزود).";
    }
    return "تمت إعادة التعيين في مخزن المنصة وحذف التجاوز — يعود النص المعتمد في المخزن إلى الافتراضي في الكود. (تجاوز المختبر غير موصول بهذا المفتاح وقت التشغيل؛ الردود الحية لا تتغير جرّاء إعادة التعيين).";
  }

  // kind === "restore"
  if (isConnected) {
    return `تم استرجاع النسخة المحددة في مخزن المنصة — يُعتمد القالب المسترجع الآن من ${sourceName} في مسار /start لمحادثة جديدة أو خاملة فقط، مع توفر البديل الافتراضي عند التعذر (لا يعني ذلك التحقق من تسليم المزود).`;
  }
  return `تم استرجاع النسخة المحددة في مخزن المنصة — أصبح النص المسترجع هو المعتمد في المخزن من ${sourceName}. (تنبيه: تجاوز المختبر غير موصول بهذا المفتاح وقت التشغيل، لذلك لن تتغير الردود الحية جرّاء الاسترجاع).`;
}

export function getPublishFeedbackText(
  key: string,
  source: EffectiveCopySource,
): string {
  return getMutationFeedbackText({
    kind: "publish",
    key,
    readbackSuccess: true,
    source,
  });
}

/**
 * The resolution result the override service returns, mirrored STRUCTURALLY
 * so this UI-logic module stays free of any persistence-layer import. The
 * server boundary hands the real typed result in, which keeps the shapes in
 * sync at compile time.
 */
export type EffectiveResolutionInput =
  | {
      ok: true;
      readonly text: string;
      readonly source: EffectiveCopySource;
      readonly fallbackReason?:
        "NO_OVERRIDE" | "INVALID_STORED_OVERRIDE" | "PERSISTENCE_UNAVAILABLE";
      readonly validationFailure?: {
        readonly code: string;
        readonly message: string;
      };
    }
  | { ok: false; readonly code: "UNKNOWN_COPY_KEY"; readonly message: string };

/** The published-override read the override service returns (structural mirror). */
export type PublishedOverrideInput =
  | {
      success: true;
      readonly data: {
        readonly override: {
          readonly text: string;
          readonly actorId: string | null;
          readonly updatedAt: string;
        } | null;
      };
    }
  | {
      success: false;
      readonly error: { readonly code: string; readonly message: string };
    };

/**
 * The product-first effective state ONE detail view renders: the effective
 * text and its source first, then the code default and the published
 * override, then the fallback diagnostics the typed contract reports.
 *
 * Never throws and never mutates the registry entry: a resolution failure
 * (an unknown key cannot happen for a registry entry, but the contract is
 * typed) degrades to the entry's own code default with `available: false`.
 */
export type EffectiveCopyState = {
  /** The currently effective, safely renderable text. */
  readonly text: string;
  readonly source: EffectiveCopySource;
  readonly sourceLabel: string;
  /** The registry code default — the canonical fallback, unchanged by any override. */
  readonly codeDefault: string;
  /** The published override text when a row exists, else null (absence = code default). */
  readonly publishedText: string | null;
  /** The Platform Operator who last published, when the row records one. */
  readonly publishedActorId: string | null;
  /** False only when the persistence read failed and the code default is standing in. */
  readonly persistenceAvailable: boolean;
  /** True when a stored override exists but fails TODAY'S contract (it is ignored). */
  readonly storedOverrideInvalid: boolean;
  /** Stable UX-LAB-01B failure code for an ignored stored override, for diagnosis. */
  readonly storedOverrideFailureCode: string | null;
  /** Whether this key exposes an edit control at all (PROTECTED_COPY never does). */
  readonly editable: boolean;
  /** What the editor starts from: the published text when present, else the effective text. */
  readonly editorSeed: string;
};

export function mapEffectiveCopyState(
  entry: CopyRegistryEntry,
  resolution: EffectiveResolutionInput,
  published: PublishedOverrideInput,
): EffectiveCopyState {
  const codeDefault = entry.defaultText;
  const editable = canEditCopy(entry);

  // A resolution failure has no code default of its own, so the entry's own
  // default is the safe text and the state is marked unavailable.
  if (!resolution.ok) {
    return {
      text: codeDefault,
      source: "CODE_DEFAULT",
      sourceLabel: EFFECTIVE_SOURCE_LABELS.CODE_DEFAULT,
      codeDefault,
      publishedText: null,
      publishedActorId: null,
      persistenceAvailable: false,
      storedOverrideInvalid: false,
      storedOverrideFailureCode: null,
      editable,
      editorSeed: codeDefault,
    };
  }

  // The published row is what the store actually holds; a failed read is the
  // "persistence unavailable" state (the code default stays safely usable).
  const publishedText = published.success
    ? (published.data.override?.text ?? null)
    : null;
  const publishedActorId = published.success
    ? (published.data.override?.actorId ?? null)
    : null;
  const persistenceAvailable = published.success;

  // A stored override that fails TODAY'S contract is reported by the service
  // as a CODE_DEFAULT resolution with INVALID_STORED_OVERRIDE + the typed
  // UX-LAB-01B failure — the Lab shows it is being ignored, never the unsafe
  // text, and seeds the editor from what is actually stored so the founder
  // can repair and republish it.
  const storedOverrideInvalid =
    resolution.source === "CODE_DEFAULT" &&
    resolution.fallbackReason === "INVALID_STORED_OVERRIDE";

  return {
    text: resolution.text,
    source: resolution.source,
    sourceLabel: EFFECTIVE_SOURCE_LABELS[resolution.source],
    codeDefault,
    publishedText,
    publishedActorId,
    persistenceAvailable,
    storedOverrideInvalid,
    storedOverrideFailureCode: resolution.validationFailure?.code ?? null,
    editable,
    editorSeed: publishedText ?? resolution.text,
  };
}

// ── History (bounded, newest-first; the service owns ordering + retention) ───

/** The action vocabulary the audit rows record, with Arabic product labels. */
export const COPY_OVERRIDE_ACTION_LABELS: Readonly<
  Record<"PUBLISH" | "RESET" | "RESTORE", string>
> = {
  PUBLISH: "نشر",
  RESET: "إعادة تعيين",
  RESTORE: "استرجاع",
};

/** One history row projected for display (structural mirror of the service item). */
export type HistoryItemInput = {
  readonly id: string;
  readonly action: "PUBLISH" | "RESET" | "RESTORE";
  readonly previousText: string | null;
  readonly resultText: string | null;
  readonly actorId: string | null;
  readonly createdAt: string;
};

export type HistoryItemView = {
  readonly id: string;
  readonly action: HistoryItemInput["action"];
  readonly actionLabel: string;
  readonly createdAt: string;
  readonly createdAtLabel: string;
  readonly actorId: string | null;
  readonly previousText: string | null;
  readonly resultText: string | null;
  /** A RESTORE target exists: a resultText, or a RESET's previousText to un-remove. */
  readonly restorable: boolean;
};

const historyFormatter = new Intl.DateTimeFormat("ar", {
  dateStyle: "medium",
  timeStyle: "short",
});

/** Project the service's newest-first history rows into display rows (order preserved). */
export function mapHistoryItems(
  items: readonly HistoryItemInput[],
): HistoryItemView[] {
  return items.map((item) => ({
    id: item.id,
    action: item.action,
    actionLabel: COPY_OVERRIDE_ACTION_LABELS[item.action],
    createdAt: item.createdAt,
    createdAtLabel: historyFormatter.format(new Date(item.createdAt)),
    actorId: item.actorId,
    previousText: item.previousText,
    resultText: item.resultText,
    restorable: (item.resultText ?? item.previousText) !== null,
  }));
}

// ── Typed failure guidance (labels for stable codes — the rules stay in the
// validator; nothing here decides what is valid) ─────────────────────────────

/**
 * Arabic product-facing guidance for each stable UX-LAB-01B validation
 * failure code. The validator still OWNS every rule; this only explains a
 * rejection the service already made, in wording a founder can act on.
 */
export const COPY_VALIDATION_FAILURE_GUIDANCE: Readonly<
  Record<CopyValidationFailureCode, string>
> = {
  UNKNOWN_COPY_KEY: "هذا المفتاح غير موجود في سجل النصوص.",
  PROTECTED_COPY_NOT_EDITABLE: "هذا النص محمي للسلامة ولا يمكن تعديله أو نشره.",
  INVALID_TEXT: "النص غير صالح — يجب أن يكون نصاً.",
  EMPTY_TEXT: "لا يمكن أن يكون النص فارغاً.",
  TEXT_TOO_LONG: "النص أطول من الحد المسموح (400 حرف).",
  MALFORMED_PLACEHOLDER:
    "توجد عبارة بين أقواس غير سليمة — استخدم الصيغة {name}.",
  UNKNOWN_PLACEHOLDER:
    "توجد عبارة بين أقواس غير معتمدة — احذفها أو استبدلها بحقل معتمد.",
  PLACEHOLDER_NOT_ALLOWED: "هذا الحقل غير مسموح لهذا النص — احذفه.",
  MISSING_REQUIRED_PLACEHOLDER:
    "حقل مطلوب ناقص — أعد إضافة الحقل المطلوب إلى النص.",
  MARKER_REMOVED:
    "عبارة محمية لازمة للنظام حُذفت — يجب أن تبقى في النص كما هي.",
};

/**
 * Arabic product-facing guidance for the override service's own typed
 * failure codes. Keyed by the stable code (a technical debugging hint is
 * shown alongside it, never instead of it).
 */
export const COPY_OVERRIDE_ERROR_GUIDANCE: Readonly<Record<string, string>> = {
  FORBIDDEN: "هذه الصلاحية متاحة لمشغل المنصة فقط.",
  UNKNOWN_COPY_KEY: "هذا المفتاح غير موجود في سجل النصوص.",
  INVALID_COPY: "النص لا يستوفي شروط النشر — راجع الملاحظات أدناه.",
  HISTORY_ENTRY_NOT_FOUND: "السجل المحدد غير موجود أو لم يعد متاحاً.",
  PERSISTENCE_FAILED: "تعذر الاتصال بمخزن النصوص الآن — حاول مرة أخرى لاحقاً.",
};

/** Product guidance for one service error, always with a defined fallback. */
export function overrideErrorGuidance(error: {
  code: string;
  message: string;
}): string {
  return COPY_OVERRIDE_ERROR_GUIDANCE[error.code] ?? error.message;
}
