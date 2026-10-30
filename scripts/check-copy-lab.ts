import type {
  CopyRegistryEntry,
  PlaceholderName,
} from "@/features/conversation-copy/types";

/**
 * FlowPilot — CONVERSATION COPY LAB registry check (UX-LAB-01A — Slice 1;
 * coverage extension UX-LAB-01A2; validation + render contracts UX-LAB-01B).
 *
 * Deterministic, OFFLINE verification of the canonical conversation-copy
 * registry (`src/features/conversation-copy/`). No DB, no network, no LLM, no
 * keys, no transport — the registry is passive code-only infrastructure and
 * this check proves it stays correct AND stays unwired.
 *
 *   A  UNIQUE KEYS            — no duplicate canonical keys; stable dotted form
 *   B  VALID CLASSIFICATIONS  — every classification/category is an approved value
 *   C  EDITABLE VS PROTECTED  — protected copy is never editable; static copy
 *                               declares no placeholders
 *   D  PLACEHOLDER METADATA   — templates interpolate ONLY approved placeholders
 *   E  REQUIRED PLACEHOLDERS  — requiredPlaceholders ⊆ placeholders
 *   F  MARKER METADATA        — the known marker-bearing entries retain the
 *                               parser/state substrings a rewording must keep
 *   G  DEFAULT COPY REGRESSION— registry defaults match CURRENT production:
 *                               exported constants exactly, the shared
 *                               classifier behaviorally, and every entry by
 *                               source scan (byte-for-byte, no refactor)
 *   H  NOT_COPY EXCLUSION     — parser/state markers (OFFER_HEADER, OFFER_LINE,
 *                               pending-clarification / continuation phrases)
 *                               are never editable registry keys; every
 *                               channel/transport string found in UX-LAB-01A2
 *                               is either a canonical key or a documented
 *                               exclusion; no duplicate semantic key was added
 *   I  NO RUNTIME WIRING      — zero production reply paths import the registry
 *   J  VALIDATION CONTRACT    — the pure validator accepts every editable
 *                               default, refuses protected/unknown/malformed
 *                               candidates, and protects markers + required
 *                               placeholders (never by throwing)
 *   K  RENDER CONTRACT        — the pure renderer substitutes every approved
 *                               placeholder deterministically, inherits the
 *                               OFFER_HEADER marker through {offer}, treats
 *                               values as text (no recursive injection), and
 *                               fails safely on unknown keys / missing values
 *   L  PURITY                 — the validation/render layer has no
 *                               DB/provider/network/env dependency and stays
 *                               unwired from every production reply path
 *   M  PLATFORM OVERRIDE      — the persistence layer's save/reset/history/
 *                               restore primitives, the CODE DEFAULT +
 *                               OPTIONAL OVERRIDE hierarchy, typed fallbacks,
 *                               and the strict runtime isolation of the
 *                               resolver from every production reply path
 *   N  FOUNDER LAB UI (01D-1) — the read-only Platform Lab surface over the
 *                               registry: the platform route + authorization,
 *                               derivation from COPY_REGISTRY (no duplicated
 *                               entry list), all 48 entries represented,
 *                               PROTECTED_COPY visibly read-only, search/
 *                               filter purity, preview through renderCopy,
 *                               template placeholders exercised, missing
 *                               required values failing safely, and no
 *                               provider/network/DB/customer-send path
 *   O  LAB MANAGEMENT (01D-2)  — the smallest useful management UI over the
 *                               01C persistence service, through ONE
 *                               platform-authorized server boundary: editable
 *                               load, protected read-only-ness, delegated
 *                               validation on publish (no duplicated rules),
 *                               effective-source flip to PLATFORM_OVERRIDE,
 *                               idempotent reset, newest-first bounded history,
 *                               valid restore / refused stale restore, a
 *                               non-PLATFORM actor unable to mutate, a
 *                               persistence outage surfaced (not crashing, not
 *                               corrupting the code default), the registry
 *                               left byte-for-byte unchanged, the production
 *                               reply paths still unwired, and the preview
 *                               still provider/network/send-free
 *   P  COMPONENT LIFECYCLE     — mounted React lifecycle test in jsdom against
 *                               mocked server boundary
 *   Q  RUNTIME COVERAGE        — explicit distinction between copy store resolution
 *                               and conversation engine consumption (welcome.intro
 *                               only; honest stored resolution wording)
 *
 * Run: pnpm check:copy-lab
 */
export {};

type Check = { label: string; pass: boolean };

const checks: Check[] = [];
function check(label: string, pass: boolean): void {
  checks.push({ label, pass });
}

const AI_FILE = "src/features/conversations/server/conversation-ai.ts";
const CLARIFY_FILE = "src/features/conversations/server/clarification.ts";
const SELECTION_FILE = "src/features/conversations/server/booking-selection.ts";
const TELEGRAM_WEBHOOK_FILE =
  "src/server/integrations/telegram/telegram-webhook-handler.ts";
const TELEGRAM_MANAGER_FILE =
  "src/server/integrations/telegram/telegram-manager-webhook-handler.ts";
const HANDOFF_POLICY_FILE =
  "src/server/integrations/ai/conversation-control/handoff-policy.ts";
const WHATSAPP_TRANSPORT_FILE = "src/server/transport/whatsapp-transport.ts";
const REGISTRY_DIR = "src/features/conversation-copy";

/**
 * Locations where the UX-LAB-01C persistence layer legitimately lives
 * OUTSIDE REGISTRY_DIR. The anti-wiring walks (I1 / L2 / M16) exempt these so
 * they keep guarding the REAL guarantee — that no production REPLY PATH ever
 * touches the override layer — instead of flagging the persistence layer's
 * own home: generated client code (never hand-written source), the
 * repository layer (the sanctioned Prisma-consumer boundary, where
 * copy-override.repository + its barrel export must live), and the
 * repository's DTO module (reuses the copy contract's MAX_COPY_LENGTH bound
 * by design so persistence can never accept a text the contract rejects).
 */
const PERSISTENCE_LAYER_PREFIXES = [
  "src/generated/",
  "src/server/repositories/",
];
const PERSISTENCE_LAYER_FILES = ["src/lib/validation/copy-override.ts"];

function isPersistenceLayer(rel: string): boolean {
  return (
    PERSISTENCE_LAYER_PREFIXES.some((prefix) => rel.startsWith(prefix)) ||
    PERSISTENCE_LAYER_FILES.includes(rel)
  );
}

/**
 * Locations where the FOUNDER CONVERSATION LAB UI (UX-LAB-01D-1) legitimately
 * consumes the registry + the pure render contract OUTSIDE REGISTRY_DIR. The
 * Lab is the registry's sanctioned NON-RUNTIME consumer — a read-only Platform
 * page (guarded by requirePlatformOperator), never a production reply path —
 * so importing COPY_REGISTRY / renderCopy there is exactly the intended use.
 *
 * The anti-wiring walks (I1 / L2) exempt these so they keep guarding the REAL
 * guarantee — that no production REPLY PATH ever touches the registry —
 * instead of flagging the Lab's own home. The list is exhaustive and
 * hand-audited: the page (imports COPY_REGISTRY), the pure UI-logic module
 * (labels + filter/group/demo projections), and the two client components
 * (browser + detail; the detail renders the preview through renderCopy).
 *
 * UX-LAB-01D-P1 (B2) adds the detail component's MOUNTED LIFECYCLE TEST: it
 * imports COPY_REGISTRY to pick real entries (never a duplicated entry list)
 * and is exercised in jsdom against a MOCKED server boundary, so it is a
 * Lab-owned, non-runtime consumer of exactly the same class.
 *
 * The OVERRIDE/persistence layer is deliberately NOT exempted here (M16 still
 * scans these files): this slice is read-only and DB-free, so the Lab must not
 * import it — section N asserts it does not.
 */
const LAB_UI_FILES = [
  "src/app/(platform)/platform/conversation-lab/page.tsx",
  "src/features/platform/components/copy-lab-logic.ts",
  "src/features/platform/components/copy-lab-browser.tsx",
  "src/features/platform/components/copy-lab-detail.tsx",
  "src/features/platform/components/copy-lab-detail.test.tsx",
];

function isLabUi(rel: string): boolean {
  return LAB_UI_FILES.includes(rel);
}

/**
 * The UX-LAB-01D-2 LAB SERVER BOUNDARY — the ONE platform-authorized seam the
 * Lab UI may call to reach the UX-LAB-01C override service (a "use server"
 * module that derives the actor from the persisted PLATFORM user and delegates
 * to the service; it imports no Prisma and duplicates no validation rule). It
 * is a sanctioned NON-RUNTIME consumer, never a production reply path.
 *
 * The anti-wiring walks (I1 / L2 / M16) exempt it so they keep guarding the
 * REAL guarantee — that no production REPLY PATH ever touches the override
 * layer — instead of flagging the sanctioned management boundary's own home.
 * The Lab UI components themselves are still NOT exempted from M16/N10: they
 * must reach the service only through this boundary (never directly).
 */
const LAB_SERVER_BOUNDARY_FILES = [
  "src/features/platform/actions/copy-lab-actions.ts",
];

function isLabServerBoundary(rel: string): boolean {
  return LAB_SERVER_BOUNDARY_FILES.includes(rel);
}

/**
 * The sanctioned runtime wiring for the first safe slice: the Conversation Engine
 * resolves `welcome.intro` via `resolveStoredCopy` and renders it via `renderCopyText`.
 */
const SANCTIONED_RUNTIME_FILES = [
  "src/features/conversations/server/conversation-engine.ts",
];

function isSanctionedRuntimeConsumer(rel: string): boolean {
  return SANCTIONED_RUNTIME_FILES.includes(rel);
}

/**
 * Files that may legitimately import the registry / render contract: the
 * persistence layer's own home, the Lab UI, the Lab's platform server
 * boundary, and the approved first runtime implementation slice.
 */
function isSanctionedRegistryConsumer(rel: string): boolean {
  return (
    isPersistenceLayer(rel) ||
    isLabUi(rel) ||
    isLabServerBoundary(rel) ||
    isSanctionedRuntimeConsumer(rel)
  );
}

async function main(): Promise<void> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const read = (rel: string) =>
    fs.readFileSync(path.join(process.cwd(), rel), "utf8");

  // Placeholder env so a pure-module import can never fail on config lookup.
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const registryModule =
    await import("../src/features/conversation-copy/index");
  // Widen the literal tuple to the general entry type so optional `markers`
  // and the placeholder unions are uniformly accessible below.
  const COPY_REGISTRY: readonly CopyRegistryEntry[] =
    registryModule.COPY_REGISTRY;
  const {
    COPY_REGISTRY_KEYS,
    NOT_COPY_EXCLUSIONS,
    PLACEHOLDER_SOURCE_KEY,
    getCopyEntry,
  } = registryModule;
  const {
    COPY_CATEGORY_VALUES,
    COPY_CLASSIFICATION_VALUES,
    PLACEHOLDER_VALUES,
  } = await import("../src/features/conversation-copy/types");
  // UX-LAB-01B — the pure validation + render contracts (section J/K). Both
  // are offline modules; importing them here has zero side effects on any
  // production reply path (section L proves it stays that way).
  const { MAX_COPY_LENGTH, renderCopy, validateCopyCandidate } = registryModule;
  const {
    CLARIFY_DATE_QUESTION,
    CLARIFY_INTENT_QUESTION,
    CONTINUE_DOMAIN_INVITE,
    INTERRUPTION_ACK_QUESTION,
  } = await import("../src/features/conversations/server/clarification");
  const { bypassDeterministicAi, classifyCustomerMessage } =
    await import("../src/features/conversations/server/conversation-ai");
  // UX-LAB-01A2 — the Conversation Control handoff seam. Pure module: its
  // imports are type-only, so importing it here has zero runtime side effects
  // (no repositories, no Prisma, no network).
  const { HANDOFF_MESSAGES } =
    await import("../src/server/integrations/ai/conversation-control/handoff-policy");

  const entry = (key: string) => getCopyEntry(key);
  const text = (key: string) => entry(key)?.defaultText ?? null;
  /** Strict boolean: the entry's default text contains the substring. */
  const textHas = (key: string, substring: string): boolean => {
    const found = entry(key);
    return found !== null && found.defaultText.includes(substring);
  };
  /** Strict boolean: the entry records the substring as protected marker metadata. */
  const hasMarker = (key: string, substring: string): boolean => {
    const found = entry(key);
    return (
      found !== null &&
      (found.markers ?? []).some((marker) => marker.substring === substring)
    );
  };

  // A source file matches a needle when the needle appears verbatim. Registry
  // defaultText holds REAL newlines; production source holds the `\n` escape,
  // so escape newlines before scanning (byte-for-byte without refactoring).
  const escapeForSourceScan = (value: string): string =>
    value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
  const PLACEHOLDER_TOKEN = /\{([a-zA-Z]+)\}/g;
  /** Static (non-placeholder) segments of a template, for source scanning. */
  const staticSegments = (value: string): string[] =>
    value
      .split(PLACEHOLDER_TOKEN)
      .filter((_, index) => index % 2 === 0)
      .filter((segment) => segment.length > 0);
  /**
   * Production sometimes COMPOSES a customer line from several constants
   * (e.g. `أيوه، ${businessName} معاك. ${IDENTITY_INVITE}`), so a whole static
   * segment can span a constant boundary. Verify the segment CONTIGUOUSLY
   * first (byte-for-byte, strongest); only then fall back to its CLAUSES
   * split on the separators production joins constants with, each of which
   * must still appear verbatim in the file.
   */
  const clauseSplit = (value: string): string[] =>
    value
      .split(/ — |\. |\\n|"/)
      .map((clause) => clause.trim())
      .filter((clause) => clause.length > 0);
  const needleFound = (source: string, needle: string): boolean =>
    source.includes(escapeForSourceScan(needle));
  const segmentFound = (source: string, segment: string): boolean => {
    if (needleFound(source, segment)) return true;
    return clauseSplit(segment).every((clause) => needleFound(source, clause));
  };

  // ── A. Unique, stable keys ─────────────────────────────────────────────
  const seen = new Set<string>();
  let duplicates = 0;
  for (const key of COPY_REGISTRY_KEYS) {
    if (seen.has(key)) duplicates += 1;
    seen.add(key);
  }
  check("A1. لا توجد مفاتيح канонical مكررة", duplicates === 0);
  check(
    "A2. كل مفاتيح السجل بصيغة نقطية مستقرة (family.name)",
    COPY_REGISTRY_KEYS.every((key) =>
      /^[a-z][a-z0-9]*\.[a-z0-9_]+(\.[a-z0-9_]+)?$/.test(key),
    ),
  );
  check(
    "A3. عدد المدخلات Canonical محدد وثابت (48)",
    COPY_REGISTRY.length === 48,
  );
  check(
    "A4. مفتاح قناة تيليجرام الجديد موجود مرة واحدة فقط (channel.telegram.start_welcome)",
    COPY_REGISTRY.filter((e) => e.key === "channel.telegram.start_welcome")
      .length === 1,
  );

  // ── B. Valid classifications + categories ──────────────────────────────
  const classificationSet = new Set<string>(COPY_CLASSIFICATION_VALUES);
  const categorySet = new Set<string>(COPY_CATEGORY_VALUES);
  check(
    "B1. كل تصنيف ضمن المجموعة المعتمدة (EDITABLE_COPY / EDITABLE_TEMPLATE / PROTECTED_COPY)",
    COPY_REGISTRY.every((e) => classificationSet.has(e.classification)),
  );
  check(
    "B2. كل فئة ضمن المجموعات العائلية المعتمدة",
    COPY_REGISTRY.every((e) => categorySet.has(e.category)),
  );
  check(
    "B3. حقول البيانات الوصفية الأساسية غير فارغة (key/label/default/source)",
    COPY_REGISTRY.every(
      (e) =>
        e.key.length > 0 &&
        e.humanLabel.length > 0 &&
        e.defaultText.length > 0 &&
        e.source.file.length > 0 &&
        e.source.symbol.length > 0,
    ),
  );
  // B4 (UX-LAB-01A2) — every mapped production path is a REAL file on disk,
  // so a stale/renamed source path is caught offline.
  const missingPaths = COPY_REGISTRY.filter(
    (e) => !fs.existsSync(path.join(process.cwd(), e.source.file)),
  );
  check(
    "B4. كل مسار مصدر مُعَين موجود فعلياً على القرص",
    missingPaths.length === 0,
  );
  if (missingPaths.length > 0) {
    for (const e of missingPaths) console.error(`   missing path: ${e.key}`);
  }

  // ── C. Editable vs protected ───────────────────────────────────────────
  const protected_ = COPY_REGISTRY.filter(
    (e) => e.classification === "PROTECTED_COPY",
  );
  const editableCopy = COPY_REGISTRY.filter(
    (e) => e.classification === "EDITABLE_COPY",
  );
  const templates = COPY_REGISTRY.filter(
    (e) => e.classification === "EDITABLE_TEMPLATE",
  );
  check(
    "C1. النسخ المحمية مصنّفة PROTECTED_COPY وليست قابلة للتعديل",
    protected_.length > 0 &&
      protected_.every((e) => e.classification === "PROTECTED_COPY"),
  );
  check(
    "C2. النسخ المحمية لا تحوي أي قوالب/عناصر نائبة (نص ثابت آمن)",
    protected_.every(
      (e) =>
        e.placeholders.length === 0 && !PLACEHOLDER_TOKEN.test(e.defaultText),
    ),
  );
  check(
    "C3. كل مفاتيح المحمية تنتمي لعائلة handoff (الممرات الآمنة)",
    protected_.every((e) => e.category === "handoff") &&
      protected_.length === 4,
  );
  // C6 (UX-LAB-01A2) — the four customer-facing safe-handoff keys stay
  // PROTECTED_COPY by name, so a future reclassification is caught offline.
  check(
    "C6. مفاتيح التحويل الآمن الأربعة لا تزال PROTECTED_COPY بالاسم",
    [
      "handoff.human_request",
      "handoff.sensitive",
      "handoff.no_knowledge",
      "handoff.ambiguous",
    ].every((key) => entry(key)?.classification === "PROTECTED_COPY"),
  );
  check(
    "C4. النسخ العادية القابلة للتعديل خالية من العناصر النائبة",
    editableCopy.every((e) => e.placeholders.length === 0),
  );
  check(
    "C5. كل قالب يحوي عنصراً نائباً واحداً على الأقل",
    templates.every((e) => e.placeholders.length > 0),
  );

  // ── D. Placeholder metadata (approved set only) ────────────────────────
  const placeholderSet = new Set<string>(PLACEHOLDER_VALUES);
  check(
    "D1. العناصر النائبة من المجموعة المعتمدة فقط",
    COPY_REGISTRY.every((e) =>
      [...e.placeholders, ...e.requiredPlaceholders].every((p) =>
        placeholderSet.has(p),
      ),
    ),
  );
  check(
    "D2. لا توجد عناصر نائبة مكررة في قالب واحد",
    COPY_REGISTRY.every(
      (e) => new Set(e.placeholders).size === e.placeholders.length,
    ),
  );
  check(
    "D3. القوالب تعلن العناصر النائبة في النص نفسه",
    templates.every((e) => {
      const inText = new Set(
        [...e.defaultText.matchAll(PLACEHOLDER_TOKEN)].map((m) => m[1]),
      );
      return (
        inText.size === e.placeholders.length &&
        e.placeholders.every((p) => inText.has(p))
      );
    }),
  );

  // ── E. requiredPlaceholders ⊆ placeholders ─────────────────────────────
  check(
    "E1. العناصر النائبة الإلزامية مجموعة جزئية من المعلنة",
    COPY_REGISTRY.every(
      (e) =>
        e.requiredPlaceholders.every((p) => e.placeholders.includes(p)) &&
        new Set(e.requiredPlaceholders).size === e.requiredPlaceholders.length,
    ),
  );

  // ── F. Marker metadata (parser/state substrings survive rewording) ─────
  //
  // The marker substrings are re-derived here from the PRODUCTION parser /
  // state-derivation sources, so the check is a real guard: the registry must
  // carry exactly the phrases the deterministic engine actually looks for.
  const clarifySource = read(CLARIFY_FILE);
  const selectionSource = read(SELECTION_FILE);
  const PENDING_SERVICE_PHRASE = "يرجى تحديد الخدمة المطلوبة";
  const PENDING_DATE_PHRASE = "يرجى تحديد التاريخ المطلوب";
  const AMBIGUOUS_SERVICE_PHRASE = "هناك أكثر من خدمة تطابق";
  const OFFER_HEADER_PHRASE = "تتوفر المواعيد التالية لخدمة";

  check(
    "F1. عبارات التحليل المعلنة لا تزال موجودة في مصدر الإنتاج",
    clarifySource.includes(PENDING_SERVICE_PHRASE) &&
      clarifySource.includes(PENDING_DATE_PHRASE) &&
      clarifySource.includes(AMBIGUOUS_SERVICE_PHRASE) &&
      selectionSource.includes(OFFER_HEADER_PHRASE),
  );
  check(
    "F2. clarify.service يحتفظ بعلامة «يرجى تحديد الخدمة المطلوبة»",
    textHas("clarify.service", PENDING_SERVICE_PHRASE) &&
      hasMarker("clarify.service", PENDING_SERVICE_PHRASE),
  );
  check(
    "F3. clarify.date يحتفظ بعلامة «يرجى تحديد التاريخ المطلوب»",
    textHas("clarify.date", PENDING_DATE_PHRASE) &&
      hasMarker("clarify.date", PENDING_DATE_PHRASE),
  );
  check(
    "F4. clarify.service_ambiguous و clarify.service_ambiguous_offer يحتفظان بعلامة «هناك أكثر من خدمة تطابق»",
    ["clarify.service_ambiguous", "clarify.service_ambiguous_offer"].every(
      (key) =>
        textHas(key, AMBIGUOUS_SERVICE_PHRASE) &&
        hasMarker(key, AMBIGUOUS_SERVICE_PHRASE),
    ),
  );
  check(
    "F5. continue.invite يحتفظ بخط علامة الاستئناف كاملاً",
    textHas("continue.invite", CONTINUE_DOMAIN_INVITE) &&
      hasMarker("continue.invite", CONTINUE_DOMAIN_INVITE),
  );
  check(
    "F6. booking.offer يحتفظ بعلامة OFFER_HEADER",
    textHas("booking.offer", OFFER_HEADER_PHRASE) &&
      hasMarker("booking.offer", OFFER_HEADER_PHRASE),
  );
  check(
    "F7. رسائل إعادة العرض تحتفظ بعلامة OFFER_HEADER عبر {offer}",
    [
      "booking.stale_options",
      "booking.stale_option",
      "booking.slot_taken",
    ].every((key) => {
      const e = entry(key);
      if (!e) return false;
      const marker = e.markers?.find((m) => m.carriedByPlaceholder === "offer");
      if (!marker) return false;
      const owner = marker.sourceKey ? getCopyEntry(marker.sourceKey) : null;
      return (
        e.placeholders.includes("offer") &&
        owner !== null &&
        owner.defaultText.includes(marker.substring)
      );
    }),
  );
  check(
    "F8. كل العلامات إما مباشرة في النص أو محمولة عبر عنصر نائب صالح",
    COPY_REGISTRY.every((e) =>
      (e.markers ?? []).every((m) => {
        if (m.carriedByPlaceholder) {
          const owner = m.sourceKey ? getCopyEntry(m.sourceKey) : null;
          return (
            e.placeholders.includes(m.carriedByPlaceholder) &&
            owner !== null &&
            owner.defaultText.includes(m.substring)
          );
        }
        return (
          e.defaultText.includes(m.substring) &&
          (m.sourceKey === undefined || m.sourceKey === e.key)
        );
      }),
    ),
  );
  check(
    "F9. PLACEHOLDER_SOURCE_KEY يربط {offer} بمالكه الـ canonical",
    PLACEHOLDER_SOURCE_KEY.offer === "booking.offer",
  );

  // ── G. Default copy regression against CURRENT production ──────────────
  //
  // G1: exported constants compared EXACTLY (strongest). G2: the shared
  // classifier + the deterministic bypass produce the registry wording
  // behaviorally (composed greeting / identity / the eight REPLIES). G3:
  // EVERY entry's default (plain copy verbatim; templates by their static
  // segments) still exists in its mapped production source — byte-for-byte
  // drift detection with zero runtime refactor.
  check(
    "G1. الثوابت المُصدَّرة تتطابق حرفاً بحرف (clarify.intent / clarify.date / interruption.ack / continue.invite)",
    text("clarify.intent") === CLARIFY_INTENT_QUESTION &&
      text("clarify.date") === CLARIFY_DATE_QUESTION &&
      text("interruption.ack") === INTERRUPTION_ACK_QUESTION &&
      text("continue.invite") === CONTINUE_DOMAIN_INVITE,
  );

  const INVITE = text("greeting.invite");
  const greetingCase = (msg: string, ackKey: string) => {
    const produced = classifyCustomerMessage(msg, []).content;
    const expected = `${text(ackKey)}! ${INVITE}`;
    return produced === expected;
  };
  check(
    "G2a. التحية المؤلفة من المصنّف تتطابق (السلام / الصباح / المساء / الافتراضي)",
    !!INVITE &&
      greetingCase("السلام عليكم", "greeting.ack.salam") &&
      greetingCase("صباح الخير", "greeting.ack.morning") &&
      greetingCase("مساء الخير", "greeting.ack.evening") &&
      greetingCase("اهلا", "greeting.ack.default"),
  );
  const identityReply = bypassDeterministicAi({
    message: "ما اسمكم؟",
    businessName: "عيادة النور",
    services: [],
    faqs: [],
  } as never);
  check(
    "G2b. رد الهوية يتطابق مع قالب identity.reply",
    !!identityReply &&
      identityReply.content ===
        text("identity.reply")?.replace("{businessName}", "عيادة النور"),
  );
  const replyCase = (msg: string, key: string) =>
    classifyCustomerMessage(msg, []).content === text(key);
  check(
    "G2c. مسارات التسليم الثمانية تُصدر النص الافتراضي (handoff.* + booking.*)",
    replyCase("عايز أتكلم مع موظف", "handoff.human_request") &&
      replyCase("عندي نزيف", "handoff.sensitive") &&
      replyCase("كم سعر التنظيف؟", "handoff.no_knowledge") &&
      replyCase("شكراً", "handoff.ambiguous") &&
      replyCase("عايز أحجز", "booking.request") &&
      replyCase("الأوقات المتاحة إمتى؟", "booking.availability") &&
      replyCase("أريد تعديل موعد", "booking.reschedule") &&
      replyCase("أريد إلغاء الموعد", "booking.cancellation"),
  );

  const missingInSource: string[] = [];
  for (const e of COPY_REGISTRY) {
    const source = read(e.source.file);
    if (e.classification === "EDITABLE_TEMPLATE") {
      for (const segment of staticSegments(e.defaultText)) {
        if (!segmentFound(source, segment)) {
          missingInSource.push(`${e.key} :: segment :: ${segment}`);
        }
      }
    } else {
      if (!needleFound(source, e.defaultText)) {
        missingInSource.push(`${e.key} :: full :: ${e.defaultText}`);
      }
    }
  }
  check(
    "G3. كل النصوص الافتراضية لا تزال موجودة حرفاً بحرف في مصدر الإنتاج",
    missingInSource.length === 0,
  );
  if (missingInSource.length > 0) {
    for (const miss of missingInSource) console.error(`   drift: ${miss}`);
  }

  // G4 (UX-LAB-01A2) — the newly added channel key maps a REAL, exported
  // production symbol whose initializer is the registry default
  // byte-for-byte. Verified by source scan (no module import → zero side
  // effects): the symbol declaration is present, exported, and its literal
  // carries the exact welcome text.
  const telegramSource = read(TELEGRAM_WEBHOOK_FILE);
  check(
    "G4. رمز CUSTOMER_START_WELCOME حقيقي ومُصدَّر ونصه يساوي الافتراضي حرفاً بحرف",
    telegramSource.includes("export const CUSTOMER_START_WELCOME") &&
      needleFound(telegramSource, text("channel.telegram.start_welcome") ?? ""),
  );

  // ── H. NOT_COPY exclusion (parser/state markers are never editable) ────
  const allKeys = new Set(COPY_REGISTRY_KEYS);
  check(
    "H1. قائمة الاستبعاد NOT_COPY غير فارغة وموثقة (5 علامات تحليل + 3 مناطق خارج المحرك)",
    NOT_COPY_EXCLUSIONS.length === 8 &&
      NOT_COPY_EXCLUSIONS.every((x) => x.id.length > 0 && x.note.length > 0),
  );
  check(
    "H2. لا يوجد مفتاح سجل يحمل اسم علامة تحليل/حالة (OFFER_HEADER / OFFER_LINE / …)",
    !COPY_REGISTRY_KEYS.some((key) =>
      NOT_COPY_EXCLUSIONS.some((x) => key.toUpperCase().includes(x.id)),
    ),
  );
  check(
    "H3. صيغة سطر الخيار (OFFER_LINE) ليست نصاً قابلاً للتعديل في السجل",
    !COPY_REGISTRY.some((e) =>
      /^\d+\.\s.*\s—\s\d{1,2}:\d{2}\sإلى\s\d{1,2}:\d{2}$/.test(e.defaultText),
    ),
  );
  check(
    "H4. عبارات التحليل تظهر فقط كبيانات وصفية للعلامات على المدخلات المتتبَّعة",
    (() => {
      const markerSubstrings = new Set(
        COPY_REGISTRY.flatMap((e) => (e.markers ?? []).map((m) => m.substring)),
      );
      return [
        PENDING_SERVICE_PHRASE,
        PENDING_DATE_PHRASE,
        AMBIGUOUS_SERVICE_PHRASE,
        OFFER_HEADER_PHRASE,
      ].every((phrase) => markerSubstrings.has(phrase));
    })(),
  );
  check(
    "H5. محللات التحديد لا تزال تعتمد على العلامات (OFFER_HEADER / OFFER_LINE في booking-selection)",
    selectionSource.includes("OFFER_HEADER") &&
      selectionSource.includes("OFFER_LINE"),
  );
  check(
    "H6. لا يوجد مفتاح يحمل اسم علامة حالة داخلية مطلقاً",
    !allKeys.has("OFFER_HEADER") &&
      !allKeys.has("OFFER_LINE") &&
      !allKeys.has("CLARIFY_SERVICE") &&
      !allKeys.has("BOOKING"),
  );

  // H7 (UX-LAB-01A2) — every deterministic CHANNEL/TRANSPORT string found by
  // the whole-codebase scan is either REPRESENTED by a canonical key or
  // EXPLICITLY documented as excluded. The Telegram customer /start welcome
  // is represented by `channel.telegram.start_welcome` (byte-for-byte); the
  // non-customer channel areas (manager bot, handoff seam, webhook/transport
  // API errors) are each covered by a NOT_COPY exclusion entry naming them.
  const exclusionLocations = NOT_COPY_EXCLUSIONS.map((x) => x.location);
  const exclusionIds = new Set(NOT_COPY_EXCLUSIONS.map((x) => x.id));
  // Areas whose deterministic copy reaches no customer and must therefore be
  // covered by a documented exclusion entry (matched by source path).
  const documentedAreas = [
    TELEGRAM_MANAGER_FILE,
    HANDOFF_POLICY_FILE,
    WHATSAPP_TRANSPORT_FILE,
    TELEGRAM_WEBHOOK_FILE,
  ];
  const undocumented = documentedAreas.filter(
    (file) => !exclusionLocations.some((location) => location.includes(file)),
  );
  check(
    "H7. كل نسخة قناة/نقل حتمية مُمَثَّلة بمفتاح canonical أو موثَّقة كمستبعدة",
    text("channel.telegram.start_welcome") !== null &&
      needleFound(
        read(TELEGRAM_WEBHOOK_FILE),
        text("channel.telegram.start_welcome") ?? "",
      ) &&
      undocumented.length === 0 &&
      (
        [
          "TELEGRAM_MANAGER_COPY",
          "HANDOFF_POLICY_MESSAGES",
          "CHANNEL_WEBHOOK_API_ERRORS",
        ] as const
      ).every((id) => exclusionIds.has(id)),
  );
  if (undocumented.length > 0) {
    for (const file of undocumented)
      console.error(`   undocumented area: ${file}`);
  }

  // H8 (UX-LAB-01A2) — no DUPLICATE semantic key was created: the three
  // Conversation Control handoff strings whose wording already exists as
  // canonical engine copy must EQUAL the existing defaults (proving they
  // MAP to `handoff.*` instead of adding parallel keys).
  check(
    "H8. رسائل سياسة التحويل المكرَّرة ترتبط بالمفاتيح الـ canonical الموجودة (لا توجد مفاتيح مكررة)",
    HANDOFF_MESSAGES.CUSTOMER_REQUESTED_HUMAN ===
      text("handoff.human_request") &&
      HANDOFF_MESSAGES.UNSUPPORTED_REQUEST === text("handoff.ambiguous") &&
      HANDOFF_MESSAGES.SENSITIVE_OR_RESTRICTED_REQUEST ===
        text("handoff.sensitive"),
  );

  // ── I. No runtime wiring (the registry stays passive in Slice 1) ───────
  const walkTs = (dir: string, out: string[] = []): string[] => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walkTs(full, out);
      else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
    }
    return out;
  };
  const importers: string[] = [];
  for (const file of walkTs(path.join(process.cwd(), "src"))) {
    const rel = path.relative(process.cwd(), file).split(path.sep).join("/");
    if (rel.startsWith(REGISTRY_DIR)) continue;
    if (isSanctionedRegistryConsumer(rel)) continue;
    const src = read(rel);
    if (/import\s[\s\S]*?conversation-copy/.test(src)) importers.push(rel);
  }
  check(
    "I1. لا يوجد مسار إنتاج يستورد السجل (السجل خامد، أو مستهلك مُعتمد فقط)",
    importers.length === 0,
  );
  if (importers.length > 0) {
    for (const rel of importers) console.error(`   wired: ${rel}`);
  }
  check(
    "I2. مسارات الرد الأساسية لا تشير إلى السجل (المحادثة + قناة تيليجرام + سياسة التحويل)",
    ![
      AI_FILE,
      CLARIFY_FILE,
      SELECTION_FILE,
      TELEGRAM_WEBHOOK_FILE,
      TELEGRAM_MANAGER_FILE,
      HANDOFF_POLICY_FILE,
      WHATSAPP_TRANSPORT_FILE,
    ].some((f) => read(f).includes("conversation-copy")),
  );

  // ── J. Validation contract (UX-LAB-01B) ────────────────────────────────
  //
  // The pure validator answers "may this text become the founder's override
  // for this key?" using ONLY registry metadata. Every registry default must
  // validate as a legal edit of itself (43 editable keys), every protected
  // key must be refused, and each documented failure class must be provably
  // rejected — deterministic, and never by throwing.
  check(
    "J0. كل النصوص الافتراضية الـ48 تُتحقق حسب تصنيفها (31 عادي + 13 قالب مقبول، 4 محمي مرفوع)",
    COPY_REGISTRY.length === 48 &&
      COPY_REGISTRY.every((e) => {
        const result = validateCopyCandidate(e.key, e.defaultText);
        return e.classification === "PROTECTED_COPY" ? !result.ok : result.ok;
      }),
  );
  const editableValidationFailures: string[] = [];
  for (const e of editableCopy) {
    const result = validateCopyCandidate(e.key, e.defaultText);
    if (!result.ok)
      editableValidationFailures.push(`${e.key} :: ${result.code}`);
  }
  check(
    "J1. كل نص EDITABLE_COPY افتراضي يُقبل كتعديل قانوني",
    editableCopy.length === 31 && editableValidationFailures.length === 0,
  );
  if (editableValidationFailures.length > 0) {
    for (const failure of editableValidationFailures)
      console.error(`   rejected default: ${failure}`);
  }
  const templateValidationFailures: string[] = [];
  for (const e of templates) {
    const result = validateCopyCandidate(e.key, e.defaultText);
    if (!result.ok)
      templateValidationFailures.push(`${e.key} :: ${result.code}`);
  }
  check(
    "J2. كل نص EDITABLE_TEMPLATE افتراضي يُقبل كتعديل قانوني",
    templates.length === 13 && templateValidationFailures.length === 0,
  );
  if (templateValidationFailures.length > 0) {
    for (const failure of templateValidationFailures)
      console.error(`   rejected template: ${failure}`);
  }
  check(
    "J3. مدخلات PROTECTED_COPY الأربع تُرفض للتعديل برمز ثابت (PROTECTED_COPY_NOT_EDITABLE)",
    protected_.length === 4 &&
      protected_.every((e) => {
        const result = validateCopyCandidate(e.key, e.defaultText);
        return !result.ok && result.code === "PROTECTED_COPY_NOT_EDITABLE";
      }),
  );
  const unknownKey = validateCopyCandidate(
    "handoff.does_not_exist",
    "نص تجريبي",
  );
  check(
    "J4. مفتاح غير معروف يفشل دائماً (UNKNOWN_COPY_KEY)",
    !unknownKey.ok && unknownKey.code === "UNKNOWN_COPY_KEY",
  );
  const unknownPlaceholder = validateCopyCandidate(
    "booking.business_closed",
    "المنشأة مغلقة يوم {date} — {randomThing}",
  );
  check(
    "J5. عنصر نائب خارج المجموعة المغلقة يفشل ({randomThing} → UNKNOWN_PLACEHOLDER)",
    !unknownPlaceholder.ok &&
      unknownPlaceholder.code === "UNKNOWN_PLACEHOLDER" &&
      unknownPlaceholder.message.includes("{randomThing}"),
  );
  const droppedRequired = validateCopyCandidate(
    "booking.confirmed",
    'تم تأكيد حجزك لخدمة "{serviceName}" يوم {date} من {startTime} إلى {endTime}.',
  );
  check(
    "J6. حذف عنصر نائب إلزامي يفشل ({providerName} → MISSING_REQUIRED_PLACEHOLDER)",
    !droppedRequired.ok &&
      droppedRequired.code === "MISSING_REQUIRED_PLACEHOLDER" &&
      droppedRequired.message.includes("{providerName}"),
  );
  // Each malformed candidate keeps {date} so the ONLY failure is the brace
  // syntax itself.
  const malformedCandidates = [
    "المنشأة مغلقة يوم {{date}} — يرجى اختيار تاريخ آخر.",
    "المنشأة مغلقة يوم { date } — يرجى اختيار تاريخ آخر.",
    "المنشأة مغلقة يوم {date",
    "المنشأة مغلقة يوم date}",
  ];
  check(
    "J7. الصيغة المعيوبة للأقواس تفشل دائماً ({{date}} / { date } / {date / date})",
    malformedCandidates.every((candidate) => {
      const result = validateCopyCandidate(
        "booking.business_closed",
        candidate,
      );
      return !result.ok && result.code === "MALFORMED_PLACEHOLDER";
    }),
  );
  // Every candidate keeps all its required placeholders, so the ONLY failure
  // is the removed parser/state marker.
  const markerRemovals: Array<[string, string]> = [
    ["clarify.service", "أي خدمة تريد حجزها؟ اكتب اسم الخدمة من فضلك."],
    ["clarify.date", "ما التاريخ الذي يناسبك لحجز الموعد؟"],
    [
      "clarify.service_ambiguous",
      "هناك خدمات متعددة مطابقة ({candidateNames}) — اختر واحدة بدقة.",
    ],
    [
      "clarify.service_ambiguous_offer",
      'خدمات متعددة تطابق "{serviceName}" — اختر واحدة بدقة.',
    ],
    ["continue.invite", "أنا جاهز لأكمل معك — تحب نحجز إمتى؟"],
    [
      "booking.offer",
      'مواعيد متاحة لخدمة "{serviceName}" يوم {date}:\n{offer}\nاختر ما يناسبك.',
    ],
  ];
  check(
    "J8. إزالة علامة التحليل/الحالة المطلوبة تفشل (MARKER_REMOVED)",
    markerRemovals.every(([key, candidate]) => {
      const result = validateCopyCandidate(key, candidate);
      return !result.ok && result.code === "MARKER_REMOVED";
    }),
  );
  const markerPreserving: Array<[string, string]> = [
    [
      "clarify.service",
      "يرجى تحديد الخدمة المطلوبة — اكتب اسم الخدمة التي ترغب بحجزها.",
    ],
    [
      "clarify.date",
      "يرجى تحديد التاريخ المطلوب (مثال: غداً، أو اذكر يوماً وتاريخاً محدداً).",
    ],
    [
      "clarify.service_ambiguous",
      "هناك أكثر من خدمة تطابق طلبك ({candidateNames}) — اختر بدقة من فضلك.",
    ],
    [
      "clarify.service_ambiguous_offer",
      'هناك أكثر من خدمة تطابق "{serviceName}" — اختر بدقة من فضلك.',
    ],
    ["continue.invite", "وبخصوص طلب الحجز، أنا جاهز أكمل معك — تحب نحجز إمتى؟"],
    [
      "booking.offer",
      'تتوفر المواعيد التالية لخدمة "{serviceName}" يوم {date}:\n{offer}\nاختر ما يناسبك وسيتواصل معك الفريق.',
    ],
    [
      "booking.stale_options",
      "لم يعد بإمكاني التأكد من الخيارات المعروضة — إليك المتاح الآن:\n{offer}",
    ],
  ];
  check(
    "J9. إعادة الصياغة مع الحفاظ على العلامات والعناصر النائبة تُقبل",
    markerPreserving.every(([key, candidate]) => {
      const result = validateCopyCandidate(key, candidate);
      if (result.ok) return true;
      console.error(`   rejected valid rewording: ${key} :: ${result.code}`);
      return false;
    }),
  );
  const longestDefault = Math.max(
    ...COPY_REGISTRY.map((e) => [...e.defaultText].length),
  );
  const tooLong = validateCopyCandidate("greeting.invite", "x".repeat(401));
  const emptyCandidate = validateCopyCandidate("greeting.invite", "   ");
  const notAString = validateCopyCandidate("greeting.invite", null);
  check(
    "J10. حدود النص: أطول افتراضي ضمن 400، والتجاوز/الفراغ/غير النص تُرفض",
    longestDefault > 0 &&
      longestDefault <= MAX_COPY_LENGTH &&
      !tooLong.ok &&
      tooLong.code === "TEXT_TOO_LONG" &&
      !emptyCandidate.ok &&
      emptyCandidate.code === "EMPTY_TEXT" &&
      !notAString.ok &&
      notAString.code === "INVALID_TEXT",
  );
  const notAllowed = validateCopyCandidate(
    "greeting.invite",
    "أهلاً بك في {businessName} — كيف يمكنني مساعدتك اليوم؟",
  );
  check(
    "J11. عنصر نائب صالح غير مُعلن للمفتاح يفشل ({businessName} في greeting.invite → PLACEHOLDER_NOT_ALLOWED)",
    !notAllowed.ok && notAllowed.code === "PLACEHOLDER_NOT_ALLOWED",
  );

  // ── K. Render contract (UX-LAB-01B) ────────────────────────────────────
  //
  // The pure renderer turns one key + values into the exact customer text,
  // from registry defaultText only. `{offer}` is special: its value is the
  // RENDERED `booking.offer` text, so the re-offer keys must inherit the
  // OFFER_HEADER marker through it.
  const SAMPLE_VALUE: Record<PlaceholderName, string> = {
    businessName: "عيادة النور",
    serviceName: "تنظيف الأسنان",
    date: "2026-09-14",
    startTime: "09:00",
    endTime: "10:00",
    providerName: "د. أحمد",
    candidateNames: "تنظيف الأسنان، تبييض الأسنان",
    maxIndex: "5",
    offer:
      "1. تنظيف الأسنان — 09:00 إلى 10:00\n2. تبييض الأسنان — 11:00 إلى 12:00",
  };
  const offerRender = renderCopy("booking.offer", SAMPLE_VALUE);
  check(
    "K0. عرض سعر الحجز يكتمل كاملاً (لا يبقى أي عنصر نائب)",
    offerRender.ok && !offerRender.text.includes("{"),
  );
  // `{offer}` carries the OFFER_HEADER marker into every re-offer message.
  const offerText = offerRender.ok ? offerRender.text : "";
  const valuesFor = (key: string): Record<PlaceholderName, string> => {
    const entry = getCopyEntry(key);
    const values = {} as Record<PlaceholderName, string>;
    for (const placeholder of entry?.placeholders ?? [])
      values[placeholder] =
        placeholder === "offer" ? offerText : SAMPLE_VALUE[placeholder];
    return values;
  };
  const renderFailures: string[] = [];
  for (const e of templates) {
    const result = renderCopy(e.key, valuesFor(e.key));
    if (!result.ok || result.text.includes("{"))
      renderFailures.push(
        `${e.key} :: ${result.ok ? "unresolved token" : result.code}`,
      );
  }
  check(
    "K1. كل قوالب EDITABLE_TEMPLATE الـ12 تُعرض كاملة بقيم عناصرها النائبة المُعلنة",
    renderFailures.length === 0,
  );
  if (renderFailures.length > 0) {
    for (const failure of renderFailures)
      console.error(`   render: ${failure}`);
  }
  // Every placeholder in the closed vocabulary is actually exercised by at
  // least one registry template and substitutes correctly.
  const templateByPlaceholder = new Map<string, string>();
  for (const e of templates)
    for (const placeholder of e.placeholders)
      templateByPlaceholder.set(placeholder, e.key);
  check(
    "K2. كل عنصر نائب معتمد يظهر في قالب واحد على الأقل ويُستبدل بقيمته بشكل صحيح",
    PLACEHOLDER_VALUES.every((placeholder) => {
      const key = templateByPlaceholder.get(placeholder);
      if (!key) return false;
      const values = valuesFor(key);
      const result = renderCopy(key, values);
      return (
        result.ok &&
        result.text.includes(values[placeholder]) &&
        !result.text.includes(`{${placeholder}}`)
      );
    }),
  );
  check(
    "K3. عرض {offer} ينقل علامة OFFER_HEADER إلى رسائل إعادة العرض الثلاث",
    [
      "booking.stale_options",
      "booking.stale_option",
      "booking.slot_taken",
    ].every((key) => {
      const result = renderCopy(key, valuesFor(key));
      return result.ok && result.text.includes(OFFER_HEADER_PHRASE);
    }),
  );
  const missingRender = renderCopy("booking.confirmed", {
    serviceName: "تنظيف الأسنان",
    date: "2026-09-14",
  });
  check(
    "K4. نقص قيمة عنصر نائب إلزامي يفشل بأمان (MISSING_PLACEHOLDER_VALUE بدلاً من اختراع قيمة)",
    !missingRender.ok &&
      missingRender.code === "MISSING_PLACEHOLDER_VALUE" &&
      (missingRender.placeholders ?? []).includes("providerName"),
  );
  // One-pass substitution: the {serviceName} VALUE is "{date}" and must stay
  // literal data, while the real {date} placeholder still resolves exactly
  // once (exactly one "{date}" occurrence in the output).
  const injected = renderCopy("booking.offer", {
    ...SAMPLE_VALUE,
    serviceName: "{date}",
  });
  const nestedValue = renderCopy("booking.offer", {
    ...SAMPLE_VALUE,
    serviceName: "{{date}}",
  });
  check(
    "K5. قيم العناصر النائبة تُعامل كنص ولن تُحلَّل مرة أخرى (لا حقن قالب)",
    injected.ok &&
      injected.text.includes('"{date}"') &&
      injected.text.includes("يوم 2026-09-14") &&
      injected.text.split("{date}").length === 2 &&
      !injected.text.includes("{serviceName}") &&
      nestedValue.ok &&
      nestedValue.text.includes("{{date}}") &&
      !nestedValue.text.includes("{serviceName}"),
  );
  const repeated = [0, 1, 2, 3, 4].map(() =>
    renderCopy("booking.pending", SAMPLE_VALUE),
  );
  const first = repeated[0];
  check(
    "K6. العرض حتمي: نفس المفتاح + نفس القيم = نفس النص دائماً",
    first !== undefined &&
      first.ok &&
      repeated.every((result) => result.ok && result.text === first.text),
  );
  check(
    "K7. عرض النسخ المحمية مسموح كاستعلام للقراءة فقط (النص الافتراضي كما هو)",
    protected_.every((e) => {
      const result = renderCopy(e.key, {});
      return result.ok && result.text === e.defaultText;
    }),
  );
  const unknownRender = renderCopy("handoff.does_not_exist", {});
  const emptyRender = renderCopy("", {});
  check(
    "K8. مفاتيح العرض غير المعروفة تفشل بشكل آمن (UNKNOWN_COPY_KEY)",
    !unknownRender.ok &&
      unknownRender.code === "UNKNOWN_COPY_KEY" &&
      !emptyRender.ok &&
      emptyRender.code === "UNKNOWN_COPY_KEY",
  );

  // ── L. Purity: the new contracts stay OFFLINE (UX-LAB-01B) ─────────────
  //
  // The validation/render layer must remain pure: no DB, no provider, no
  // network, no env, no throwing — and no production reply path may consume
  // it (extending the Slice-1/01A2 anti-wiring guard to the new symbols).
  const COPY_RUNTIME_FILES = [
    "src/features/conversation-copy/placeholders.ts",
    "src/features/conversation-copy/render.ts",
    "src/features/conversation-copy/validation.ts",
  ];
  const FORBIDDEN_TOKENS = [
    "@prisma",
    "prisma",
    "openrouter",
    "process.env",
    "fetch(",
    "require(",
  ];
  const tokenHits: string[] = [];
  for (const rel of COPY_RUNTIME_FILES) {
    const source = read(rel);
    for (const token of FORBIDDEN_TOKENS)
      if (source.includes(token)) tokenHits.push(`${rel} :: ${token}`);
  }
  // Every import in the runtime layer must resolve INSIDE the registry dir.
  const importSources: string[] = [];
  for (const rel of COPY_RUNTIME_FILES) {
    for (const line of read(rel).split("\n")) {
      const match = /^import\s[\s\S]*?from\s+"([^"]+)";$/.exec(line.trim());
      if (
        match &&
        match[1] &&
        !match[1].startsWith("@/features/conversation-copy")
      )
        importSources.push(`${rel} -> ${match[1]}`);
    }
  }
  const throwingFiles = COPY_RUNTIME_FILES.filter((rel) =>
    /\bthrow\b[\s\n]/.test(read(rel)),
  );
  check(
    "L1. عقد التحقق/العرض نقية: لا قاعدة بيانات/مزود/شبكة/env، واستيرادها من داخل السجل فقط",
    tokenHits.length === 0 &&
      importSources.length === 0 &&
      throwingFiles.length === 0,
  );
  if (tokenHits.length > 0 || importSources.length > 0) {
    for (const hit of [...tokenHits, ...importSources])
      console.error(`   impure: ${hit}`);
  }
  const runtimeWired: string[] = [];
  for (const file of walkTs(path.join(process.cwd(), "src"))) {
    const rel = path.relative(process.cwd(), file).split(path.sep).join("/");
    if (rel.startsWith(REGISTRY_DIR)) continue;
    if (isSanctionedRegistryConsumer(rel)) continue;
    const source = read(rel);
    if (
      /import\s[\s\S]*?conversation-copy/.test(source) ||
      /\b(?:renderCopy|validateCopyCandidate)\b/.test(source)
    )
      runtimeWired.push(rel);
  }
  check(
    "L2. لا يوجد مسار إنتاج يستورد عقد التحقق/العرض أو الرموز الجديدة (السجل يبقى خامداً)",
    runtimeWired.length === 0,
  );
  if (runtimeWired.length > 0) {
    for (const rel of runtimeWired) console.error(`   wired: ${rel}`);
  }

  // ── M. Platform override persistence contract (UX-LAB-01C) ─────────────
  //
  // The smallest safe PLATFORM-level persistence layer for published copy
  // overrides, exercised with an IN-MEMORY repository (no DB, no network,
  // no provider). Proves the CODE DEFAULT + OPTIONAL PLATFORM OVERRIDE
  // hierarchy, the delegated UX-LAB-01B validation, the safe fallbacks, the
  // audit/history primitive, and the strict runtime isolation of the new
  // resolver from every production reply path.
  const {
    codeDefaultFor,
    getPublishedOverride,
    listOverrideHistory,
    resetPublishedOverride,
    resolveStoredCopy,
    restoreOverride,
    savePublishedOverride,
  } = await import("../src/features/conversation-copy/override-service");

  // A deterministic in-memory repository implementing the service's injectable
  // deps. No Prisma, no DB — the service boundary is exercised through the
  // same narrow surface the real repository implements.
  type OverrideRow = {
    id: string;
    copyKey: string;
    text: string;
    actorId: string | null;
    createdAt: string;
    updatedAt: string;
  };
  type HistoryRow = {
    id: string;
    copyKey: string;
    action: "PUBLISH" | "RESET" | "RESTORE";
    previousText: string | null;
    resultText: string | null;
    actorId: string | null;
    createdAt: string;
  };
  const makeFakeDeps = (
    opts: {
      /** When set, `getPublished` throws to simulate a persistence outage. */
      readFails?: boolean;
      /** When set, `getPublished` returns this corrupted text for every key. */
      corruptedText?: string | null;
    } = {},
  ) => {
    const overrides = new Map<string, OverrideRow>();
    const history: HistoryRow[] = [];
    let seq = 0;
    const now = () => new Date(Date.now() + (seq += 1)).toISOString();
    return {
      overrides,
      history,
      getPublished: async (copyKey: string): Promise<OverrideRow | null> => {
        if (opts.readFails) {
          throw new Error("simulated persistence outage");
        }
        if (opts.corruptedText !== undefined && opts.corruptedText !== null) {
          return {
            id: `corrupt-${copyKey}`,
            copyKey,
            text: opts.corruptedText,
            actorId: null,
            createdAt: now(),
            updatedAt: now(),
          };
        }
        return overrides.get(copyKey) ?? null;
      },
      save: async (input: {
        copyKey: string;
        text: string;
        actorId?: string | null;
      }): Promise<OverrideRow> => {
        const existing = overrides.get(input.copyKey);
        const row: OverrideRow = {
          id: existing?.id ?? `ov-${(seq += 1)}`,
          copyKey: input.copyKey,
          text: input.text,
          actorId: input.actorId ?? null,
          createdAt: existing?.createdAt ?? now(),
          updatedAt: now(),
        };
        overrides.set(input.copyKey, row);
        return row;
      },
      remove: async (copyKey: string): Promise<OverrideRow | null> => {
        const existing = overrides.get(copyKey);
        if (!existing) return null;
        overrides.delete(copyKey);
        return existing;
      },
      recordHistory: async (input: {
        copyKey: string;
        action: "PUBLISH" | "RESET" | "RESTORE";
        previousText?: string | null;
        resultText?: string | null;
        actorId?: string | null;
      }): Promise<HistoryRow | null> => {
        const row: HistoryRow = {
          id: `hist-${(seq += 1)}`,
          copyKey: input.copyKey,
          action: input.action,
          previousText: input.previousText ?? null,
          resultText: input.resultText ?? null,
          actorId: input.actorId ?? null,
          createdAt: now(),
        };
        history.push(row);
        return row;
      },
      listHistory: async (input: {
        copyKey: string;
        limit?: number;
      }): Promise<HistoryRow[]> =>
        history
          .filter((row) => row.copyKey === input.copyKey)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, input.limit ?? 25),
      findHistoryById: async (id: string): Promise<HistoryRow | null> =>
        history.find((row) => row.id === id) ?? null,
    };
  };

  const PLATFORM_ACTOR = { userId: "operator-1", accountType: "PLATFORM" };

  // M1 (A) — no override ⇒ code default, byte-for-byte, for EVERY key.
  const emptyDeps = makeFakeDeps();
  const noOverrideFailures: string[] = [];
  for (const e of COPY_REGISTRY) {
    const resolved = await resolveStoredCopy(e.key, emptyDeps);
    if (
      !resolved.ok ||
      resolved.text !== e.defaultText ||
      resolved.source !== "CODE_DEFAULT"
    )
      noOverrideFailures.push(e.key);
  }
  check(
    "M1. غياب أي تجاوز يعيد النص الافتراضي للكود لكل مفاتيح السجل (CODE_DEFAULT)",
    noOverrideFailures.length === 0,
  );
  if (noOverrideFailures.length > 0) {
    for (const key of noOverrideFailures)
      console.error(`   no-override: ${key}`);
  }

  // M2 (B) — a valid EDITABLE_COPY override becomes the effective text.
  const editableDeps = makeFakeDeps();
  const savedEditable = await savePublishedOverride(
    PLATFORM_ACTOR,
    "greeting.invite",
    "أهلاً بك في عيادتنا — كيف أساعدك اليوم؟",
    editableDeps,
  );
  const resolvedEditable = await resolveStoredCopy(
    "greeting.invite",
    editableDeps,
  );
  check(
    "M2. نشر تجاوز EDITABLE_COPY صالح يجعله النص الفعلي (PLATFORM_OVERRIDE)",
    savedEditable.success &&
      savedEditable.data.override.text ===
        "أهلاً بك في عيادتنا — كيف أساعدك اليوم؟" &&
      resolvedEditable.ok &&
      resolvedEditable.source === "PLATFORM_OVERRIDE" &&
      resolvedEditable.text === "أهلاً بك في عيادتنا — كيف أساعدك اليوم؟",
  );

  // M3 (C) — a valid EDITABLE_TEMPLATE override (placeholders kept) becomes
  // the effective text, still carrying its unresolved tokens.
  const templateDeps = makeFakeDeps();
  const templateText =
    'تم تأكيد حجزك لخدمة "{serviceName}" يوم {date} من {startTime} إلى {endTime} مع {providerName}.';
  const savedTemplate = await savePublishedOverride(
    PLATFORM_ACTOR,
    "booking.confirmed",
    templateText,
    templateDeps,
  );
  const resolvedTemplate = await resolveStoredCopy(
    "booking.confirmed",
    templateDeps,
  );
  check(
    "M3. نشر تجاوز EDITABLE_TEMPLATE صالح (مع العناصر النائبة) يجعله القالب الفعلي",
    savedTemplate.success &&
      savedTemplate.data.override.text === templateText &&
      resolvedTemplate.ok &&
      resolvedTemplate.source === "PLATFORM_OVERRIDE" &&
      resolvedTemplate.text === templateText,
  );

  // M4 (D) — PROTECTED_COPY can never be saved (typed INVALID_COPY /
  // PROTECTED_COPY_NOT_EDITABLE, and nothing is stored).
  const protectedDeps = makeFakeDeps();
  const protectedSave = await savePublishedOverride(
    PLATFORM_ACTOR,
    "handoff.human_request",
    "تحت أمرك — جارٍ تحويلك الآن لأحد أعضاء الفريق الجدد.",
    protectedDeps,
  );
  const protectedRead = await getPublishedOverride(
    "handoff.human_request",
    protectedDeps,
  );
  check(
    "M4. لا يمكن حفظ تجاوز لـ PROTECTED_COPY (رفض مُنمَّق ولا يُخزَّن شيء)",
    !protectedSave.success &&
      protectedSave.error.code === "INVALID_COPY" &&
      protectedSave.error.validationFailure?.code ===
        "PROTECTED_COPY_NOT_EDITABLE" &&
      protectedRead.success &&
      protectedRead.data.override === null,
  );

  // M5 (E) — a malformed / unknown placeholder is rejected (nothing stored).
  const badPlaceholderDeps = makeFakeDeps();
  const badPlaceholder = await savePublishedOverride(
    PLATFORM_ACTOR,
    "booking.business_closed",
    "المنشأة مغلقة يوم {date} — {randomThing}",
    badPlaceholderDeps,
  );
  const badPlaceholderRead = await getPublishedOverride(
    "booking.business_closed",
    badPlaceholderDeps,
  );
  check(
    "M5. عنصر نائب غير معروف يُرفض ولا يُخزَّن (UNKNOWN_PLACEHOLDER)",
    !badPlaceholder.success &&
      badPlaceholder.error.code === "INVALID_COPY" &&
      badPlaceholder.error.validationFailure?.code === "UNKNOWN_PLACEHOLDER" &&
      badPlaceholderRead.success &&
      badPlaceholderRead.data.override === null,
  );

  // M6 (F) — removing a required placeholder is rejected.
  const droppedRequiredDeps = makeFakeDeps();
  const droppedRequiredSave = await savePublishedOverride(
    PLATFORM_ACTOR,
    "booking.confirmed",
    'تم تأكيد حجزك لخدمة "{serviceName}" يوم {date} من {startTime} إلى {endTime}.',
    droppedRequiredDeps,
  );
  check(
    "M6. حذف عنصر نائب إلزامي يُرفض (MISSING_REQUIRED_PLACEHOLDER)",
    !droppedRequiredSave.success &&
      droppedRequiredSave.error.code === "INVALID_COPY" &&
      droppedRequiredSave.error.validationFailure?.code ===
        "MISSING_REQUIRED_PLACEHOLDER" &&
      droppedRequiredSave.error.validationFailure?.message.includes(
        "{providerName}",
      ),
  );

  // M7 (G) — removing a protected parser/state marker is rejected.
  const markerRemovalDeps = makeFakeDeps();
  const markerRemoval = await savePublishedOverride(
    PLATFORM_ACTOR,
    "clarify.date",
    "ما التاريخ الذي يناسبك لحجز الموعد؟",
    markerRemovalDeps,
  );
  check(
    "M7. إزالة علامة التحليل/الحالة المطلوبة تُرفض (MARKER_REMOVED)",
    !markerRemoval.success &&
      markerRemoval.error.code === "INVALID_COPY" &&
      markerRemoval.error.validationFailure?.code === "MARKER_REMOVED",
  );

  // M7b — the SERVICE write path enforces the 400-char contract too (not just
  // the pure validator): a 401-codepoint candidate is refused with the typed
  // TEXT_TOO_LONG diagnostic and nothing reaches the store. Exactly 400 stays
  // legal, per the existing UX-LAB-01B bound.
  const tooLongDeps = makeFakeDeps();
  const atLimit = "أ".repeat(MAX_COPY_LENGTH);
  const overLimit = "أ".repeat(MAX_COPY_LENGTH + 1);
  const savedAtLimit = await savePublishedOverride(
    PLATFORM_ACTOR,
    "greeting.invite",
    atLimit,
    tooLongDeps,
  );
  const rejectedOverLimit = await savePublishedOverride(
    PLATFORM_ACTOR,
    "greeting.invite",
    overLimit,
    tooLongDeps,
  );
  const tooLongRead = await getPublishedOverride(
    "greeting.invite",
    tooLongDeps,
  );
  check(
    "M7b. مسار كتابة الخدمة يرفض تجاوز 400 حرف (TEXT_TOO_LONG) ويقبل حد 400 تماماً",
    savedAtLimit.success &&
      savedAtLimit.data.override.text === atLimit &&
      !rejectedOverLimit.success &&
      rejectedOverLimit.error.code === "INVALID_COPY" &&
      rejectedOverLimit.error.validationFailure?.code === "TEXT_TOO_LONG" &&
      tooLongRead.success &&
      // only the legal at-limit write landed
      tooLongRead.data.override?.text === atLimit,
  );

  // M8 (H) — reset removes the effective override and restores the code
  // default (and is idempotent for a key with no override).
  const resetDeps = makeFakeDeps();
  await savePublishedOverride(
    PLATFORM_ACTOR,
    "booking.no_options",
    "لا تتوفر مواعيد حالياً — يرجى المحاولة لاحقاً.",
    resetDeps,
  );
  const beforeReset = await resolveStoredCopy("booking.no_options", resetDeps);
  const resetResult = await resetPublishedOverride(
    PLATFORM_ACTOR,
    "booking.no_options",
    resetDeps,
  );
  const afterReset = await resolveStoredCopy("booking.no_options", resetDeps);
  const resetTwice = await resetPublishedOverride(
    PLATFORM_ACTOR,
    "booking.no_options",
    resetDeps,
  );
  check(
    "M8. إعادة التعيين تزيل التجاوز وتعيد النص الافتراضي للكود (ومُكرَّرة بأمان)",
    beforeReset.ok &&
      beforeReset.source === "PLATFORM_OVERRIDE" &&
      resetResult.success &&
      resetResult.data.removed !== null &&
      afterReset.ok &&
      afterReset.source === "CODE_DEFAULT" &&
      afterReset.text === text("booking.no_options") &&
      resetTwice.success &&
      resetTwice.data.removed === null,
  );

  // M9 (I) — a persistence READ failure falls back to the code default with
  // typed PERSISTENCE_UNAVAILABLE metadata (never an exception, never unsafe
  // text, and no customer-visible difference).
  const outageDeps = makeFakeDeps({ readFails: true });
  const outage = await resolveStoredCopy("greeting.invite", outageDeps);
  check(
    "M9. فشل قراءة الثبات يفشل بأمان إلى النص الافتراضي (PERSISTENCE_UNAVAILABLE)",
    outage.ok &&
      outage.source === "CODE_DEFAULT" &&
      outage.text === text("greeting.invite") &&
      outage.fallbackReason === "PERSISTENCE_UNAVAILABLE",
  );

  // M10 (J) — an invalid/corrupted STORED override (e.g. a value that was
  // valid when published but fails TODAY'S contract) is never propagated: the
  // code default wins, with the typed INVALID_STORED_OVERRIDE diagnostic.
  const corruptedDeps = makeFakeDeps({
    corruptedText: "المنشأة مغلقة يوم {date} — {unknownPlaceholder}",
  });
  const corrupted = await resolveStoredCopy(
    "booking.business_closed",
    corruptedDeps,
  );
  check(
    "M10. تجاوز مخزَّن تالف لا يُمرَّر للعميل أبداً (INVALID_STORED_OVERRIDE → النص الافتراضي)",
    corrupted.ok &&
      corrupted.source === "CODE_DEFAULT" &&
      corrupted.text === text("booking.business_closed") &&
      corrupted.fallbackReason === "INVALID_STORED_OVERRIDE" &&
      corrupted.validationFailure?.code === "UNKNOWN_PLACEHOLDER",
  );

  // M11 (K) — history/audit rows are recorded by the service for publish,
  // reset, and restore, carrying key / previous / resulting value / actor.
  const historyDeps = makeFakeDeps();
  await savePublishedOverride(
    PLATFORM_ACTOR,
    "booking.fully_booked",
    "جميع المواعيد محجوزة يوم {date} — يرجى اختيار يوم آخر.",
    historyDeps,
  );
  await savePublishedOverride(
    PLATFORM_ACTOR,
    "booking.fully_booked",
    "كل الحجوزات ممتلئة في {date} — اختر تاريخاً آخر من فضلك.",
    historyDeps,
  );
  await resetPublishedOverride(
    PLATFORM_ACTOR,
    "booking.fully_booked",
    historyDeps,
  );
  const historyRead = await listOverrideHistory(
    PLATFORM_ACTOR,
    "booking.fully_booked",
    25,
    historyDeps,
  );
  const histRows = historyRead.success ? historyRead.data.items : [];
  const publishRows = histRows.filter((row) => row.action === "PUBLISH");
  const resetRows = histRows.filter((row) => row.action === "RESET");
  check(
    "M11. الخدمة تسجّل سجل تدقيق صحيح لكل تغيير (PUBLISH/RESET مع القيمة السابقة والناتجة والممثل)",
    historyRead.success &&
      histRows.length === 3 &&
      publishRows.length === 2 &&
      resetRows.length === 1 &&
      // History is newest-first, so the republish is publishRows[0] (carrying
      // the first text as its previousText) and the FIRST publish — the one
      // with no predecessor — is publishRows[1].
      publishRows[0]?.previousText ===
        "جميع المواعيد محجوزة يوم {date} — يرجى اختيار يوم آخر." &&
      publishRows[0]?.resultText ===
        "كل الحجوزات ممتلئة في {date} — اختر تاريخاً آخر من فضلك." &&
      publishRows[0]?.actorId === "operator-1" &&
      publishRows[1]?.previousText === null &&
      publishRows[1]?.resultText ===
        "جميع المواعيد محجوزة يوم {date} — يرجى اختيار يوم آخر." &&
      publishRows[1]?.actorId === "operator-1" &&
      resetRows[0]?.previousText ===
        "كل الحجوزات ممتلئة في {date} — اختر تاريخاً آخر من فضلك." &&
      resetRows[0]?.resultText === null &&
      resetRows[0]?.actorId === "operator-1",
  );

  // M12 — restore re-publishes a historical value (after re-validation
  // against TODAY'S contract) and records its own RESTORE audit row.
  const restoreDeps = makeFakeDeps();
  await savePublishedOverride(
    PLATFORM_ACTOR,
    "booking.no_options",
    "لا تتوفر مواعيد حالياً — يرجى المحاولة لاحقاً.",
    restoreDeps,
  );
  const restoreHistory = await listOverrideHistory(
    PLATFORM_ACTOR,
    "booking.no_options",
    25,
    restoreDeps,
  );
  const firstPublishId = restoreHistory.success
    ? restoreHistory.data.items[0]?.id
    : null;
  const restored = await restoreOverride(
    PLATFORM_ACTOR,
    firstPublishId ?? "missing",
    restoreDeps,
  );
  const afterRestore = await resolveStoredCopy(
    "booking.no_options",
    restoreDeps,
  );
  const restoreHistoryAfter = await listOverrideHistory(
    PLATFORM_ACTOR,
    "booking.no_options",
    25,
    restoreDeps,
  );
  const restoreRows = restoreHistoryAfter.success
    ? restoreHistoryAfter.data.items.filter((row) => row.action === "RESTORE")
    : [];
  check(
    "M12. الاستعادة تعيد نشر قيمة تاريخية بعد إعادة تحققها بالعقد الحالي وتسجّل RESTORE",
    restored.success &&
      restored.data.override.text ===
        "لا تتوفر مواعيد حالياً — يرجى المحاولة لاحقاً." &&
      afterRestore.ok &&
      afterRestore.source === "PLATFORM_OVERRIDE" &&
      restoreRows.length === 1 &&
      restoreRows[0]?.resultText ===
        "لا تتوفر مواعيد حالياً — يرجى المحاولة لاحقاً.",
  );
  // A missing history row is a typed HISTORY_ENTRY_NOT_FOUND, never a crash.
  const restoreMissing = await restoreOverride(
    PLATFORM_ACTOR,
    "does-not-exist",
    restoreDeps,
  );
  check(
    "M12b. سجل استعادة غير موجود يُرجع رمز ثابت (HISTORY_ENTRY_NOT_FOUND)",
    !restoreMissing.success &&
      restoreMissing.error.code === "HISTORY_ENTRY_NOT_FOUND",
  );

  // M12c — restore goes THROUGH the UX-LAB-01B contract, exactly like a
  // publish: a historical value that no longer passes TODAY'S rules is
  // refused and NEVER becomes the current text. The fake deps let us seed a
  // row whose text was legal when published but is invalid now (a registry
  // evolution), which is precisely the case the re-validation exists for.
  const staleHistoryDeps = makeFakeDeps();
  const CURRENT_TEXT = text("booking.business_closed");
  await savePublishedOverride(
    PLATFORM_ACTOR,
    "booking.business_closed",
    CURRENT_TEXT,
    staleHistoryDeps,
  );
  // A row the service would never write today (unknown placeholder), seeded
  // straight into the store to model a value that predates a registry change.
  staleHistoryDeps.history.push({
    id: "hist-stale-placeholder",
    copyKey: "booking.business_closed",
    action: "PUBLISH",
    previousText: null,
    resultText: "المنشأة مغلقة يوم {date} — {closedReason}",
    actorId: "operator-legacy",
    createdAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
  });
  // A second stale row failing a DIFFERENT rule (marker removed) — distinct
  // failure codes flowing through proves it is the real validator deciding,
  // not a re-implemented copy of one rule inside the service.
  staleHistoryDeps.history.push({
    id: "hist-stale-marker",
    copyKey: "clarify.date",
    action: "PUBLISH",
    previousText: null,
    resultText: "ما التاريخ الذي يناسبك لحجز الموعد؟",
    actorId: "operator-legacy",
    createdAt: new Date("2026-01-02T00:00:00.000Z").toISOString(),
  });
  const restoreStalePlaceholder = await restoreOverride(
    PLATFORM_ACTOR,
    "hist-stale-placeholder",
    staleHistoryDeps,
  );
  const afterStaleRestore = await resolveStoredCopy(
    "booking.business_closed",
    staleHistoryDeps,
  );
  const restoreStaleMarker = await restoreOverride(
    PLATFORM_ACTOR,
    "hist-stale-marker",
    staleHistoryDeps,
  );
  const staleMarkerKey = await resolveStoredCopy(
    "clarify.date",
    staleHistoryDeps,
  );
  const staleHistoryAfter = await listOverrideHistory(
    PLATFORM_ACTOR,
    "booking.business_closed",
    25,
    staleHistoryDeps,
  );
  const staleRestoreRows = staleHistoryAfter.success
    ? staleHistoryAfter.data.items.filter((row) => row.action === "RESTORE")
    : [];
  check(
    "M12c. قيمة تاريخية تالفة/قديمة لا يمكن استعادتها (تُرفض بالعقد الحالي ولا تصبح النص الفعلي)",
    !restoreStalePlaceholder.success &&
      restoreStalePlaceholder.error.code === "INVALID_COPY" &&
      restoreStalePlaceholder.error.validationFailure?.code ===
        "UNKNOWN_PLACEHOLDER" &&
      // The valid published text is still the effective one — the invalid
      // historical value never reached the store.
      afterStaleRestore.ok &&
      afterStaleRestore.source === "PLATFORM_OVERRIDE" &&
      afterStaleRestore.text === CURRENT_TEXT &&
      // No RESTORE audit row is written for a refused restore (nothing
      // changed, so there is no transition to audit).
      staleRestoreRows.length === 0 &&
      !restoreStaleMarker.success &&
      restoreStaleMarker.error.code === "INVALID_COPY" &&
      restoreStaleMarker.error.validationFailure?.code === "MARKER_REMOVED" &&
      staleMarkerKey.ok &&
      staleMarkerKey.source === "CODE_DEFAULT",
  );

  // M12d — the restore path inherits the PROTECTED_COPY guard too: a history
  // row for a protected key can never be re-published through restore.
  const protectedHistoryDeps = makeFakeDeps();
  protectedHistoryDeps.history.push({
    id: "hist-protected",
    copyKey: "handoff.human_request",
    action: "PUBLISH",
    previousText: null,
    resultText: "تحت أمرك — جارٍ تحويلك الآن لأحد أعضاء الفريق.",
    actorId: "operator-legacy",
    createdAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
  });
  const restoreProtected = await restoreOverride(
    PLATFORM_ACTOR,
    "hist-protected",
    protectedHistoryDeps,
  );
  const protectedAfterRestore = await resolveStoredCopy(
    "handoff.human_request",
    protectedHistoryDeps,
  );
  check(
    "M12d. لا يمكن استعادة سجل لمفتاح PROTECTED_COPY (الاستعادة تخضع لحماية النصوص المحمية)",
    !restoreProtected.success &&
      restoreProtected.error.code === "INVALID_COPY" &&
      restoreProtected.error.validationFailure?.code ===
        "PROTECTED_COPY_NOT_EDITABLE" &&
      protectedAfterRestore.ok &&
      protectedAfterRestore.source === "CODE_DEFAULT" &&
      protectedAfterRestore.text === text("handoff.human_request"),
  );

  // M12e — every history row carries the spec's audit fields: the canonical
  // key, a closed-vocabulary action, the actor when available, and a real
  // timestamp. Exercised over the rich sequence built for M11 (two publishes
  // + a reset) so all three action types are covered.
  const historyDepsRows = historyRead.success ? historyRead.data.items : [];
  const validIso = (value: string): boolean =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value) &&
    !Number.isNaN(new Date(value).getTime());
  const shapeFailures: string[] = [];
  for (const row of historyDepsRows) {
    if (row.copyKey !== "booking.fully_booked")
      shapeFailures.push(`${row.id}:key`);
    if (!validIso(row.createdAt)) shapeFailures.push(`${row.id}:createdAt`);
    if (row.actorId !== "operator-1") shapeFailures.push(`${row.id}:actor`);
    if (!["PUBLISH", "RESET", "RESTORE"].includes(row.action))
      shapeFailures.push(`${row.id}:action`);
  }
  check(
    "M12e. كل سجل تدقيق يحوي المفتاح والإجراء والممثل وطابعاً زمنياً صالحاً",
    historyDepsRows.length === 3 &&
      shapeFailures.length === 0 &&
      // ISO-8601 UTC timestamps sort lexicographically the same way they
      // sort chronologically, which is what makes newest-first history a
      // stable, locale-independent read (newest first here).
      validIso(historyDepsRows[0]?.createdAt ?? "") &&
      validIso(historyDepsRows[1]?.createdAt ?? "") &&
      validIso(historyDepsRows[2]?.createdAt ?? "") &&
      new Date(historyDepsRows[0]?.createdAt ?? 0) >=
        new Date(historyDepsRows[1]?.createdAt ?? 0) &&
      new Date(historyDepsRows[1]?.createdAt ?? 0) >=
        new Date(historyDepsRows[2]?.createdAt ?? 0),
  );
  if (shapeFailures.length > 0) {
    for (const failure of shapeFailures)
      console.error(`   history-shape: ${failure}`);
  }

  // M13 (L) — different copy keys never overwrite each other.
  const isolationDeps = makeFakeDeps();
  await savePublishedOverride(
    PLATFORM_ACTOR,
    "booking.no_options",
    "لا تتوفر مواعيد حالياً — يرجى المحاولة لاحقاً.",
    isolationDeps,
  );
  await savePublishedOverride(
    PLATFORM_ACTOR,
    "booking.request",
    "يسعدنا خدمتك! سنتواصل معك قريباً لإتمام الحجز.",
    isolationDeps,
  );
  const noOptions = await resolveStoredCopy(
    "booking.no_options",
    isolationDeps,
  );
  const request = await resolveStoredCopy("booking.request", isolationDeps);
  const untouched = await resolveStoredCopy(
    "booking.cancellation",
    isolationDeps,
  );
  check(
    "M13. مفاتيح النسخ المختلفة لا تطمس بعضها البعض",
    noOptions.ok &&
      noOptions.source === "PLATFORM_OVERRIDE" &&
      noOptions.text === "لا تتوفر مواعيد حالياً — يرجى المحاولة لاحقاً." &&
      request.ok &&
      request.source === "PLATFORM_OVERRIDE" &&
      request.text === "يسعدنا خدمتك! سنتواصل معك قريباً لإتمام الحجز." &&
      untouched.ok &&
      untouched.source === "CODE_DEFAULT" &&
      untouched.text === text("booking.cancellation"),
  );

  // M13b — HISTORY is isolated per copy key, not just the overrides: a key's
  // audit log lists ONLY its own transitions, and restoring a row that
  // belongs to another key never touches this key's effective text or log.
  const historyIsoDeps = makeFakeDeps();
  const TEXT_A = "لا تتوفر مواعيد حالياً — يرجى المحاولة لاحقاً.";
  const TEXT_B1 = "يسعدنا خدمتك! سنتواصل معك قريباً لإتمام الحجز.";
  const TEXT_B2 = "يسعدنا خدمتك! سنتواصل معك خلال دقائق لإتمام الحجز.";
  await savePublishedOverride(
    PLATFORM_ACTOR,
    "booking.no_options",
    TEXT_A,
    historyIsoDeps,
  );
  await savePublishedOverride(
    PLATFORM_ACTOR,
    "booking.request",
    TEXT_B1,
    historyIsoDeps,
  );
  await savePublishedOverride(
    PLATFORM_ACTOR,
    "booking.request",
    TEXT_B2,
    historyIsoDeps,
  );
  const histA = await listOverrideHistory(
    PLATFORM_ACTOR,
    "booking.no_options",
    25,
    historyIsoDeps,
  );
  const histB = await listOverrideHistory(
    PLATFORM_ACTOR,
    "booking.request",
    25,
    historyIsoDeps,
  );
  const rowsA = histA.success ? histA.data.items : [];
  const rowsB = histB.success ? histB.data.items : [];
  // Restoring key B's FIRST publish (the older row, i.e. index 1 in a
  // newest-first list) must not disturb key A at all.
  const bFirstPublishId = rowsB[1]?.id;
  const restoredB = await restoreOverride(
    PLATFORM_ACTOR,
    bFirstPublishId ?? "missing",
    historyIsoDeps,
  );
  const aAfterRestore = await resolveStoredCopy(
    "booking.no_options",
    historyIsoDeps,
  );
  const bAfterRestore = await resolveStoredCopy(
    "booking.request",
    historyIsoDeps,
  );
  const histAAfter = await listOverrideHistory(
    PLATFORM_ACTOR,
    "booking.no_options",
    25,
    historyIsoDeps,
  );
  const histBAfter = await listOverrideHistory(
    PLATFORM_ACTOR,
    "booking.request",
    25,
    historyIsoDeps,
  );
  const rowsAAfter = histAAfter.success ? histAAfter.data.items : [];
  const bRestoreRows = histBAfter.success
    ? histBAfter.data.items.filter((row) => row.action === "RESTORE")
    : [];
  check(
    "M13b. سجلات التدقيق معزولة لكل مفتاح نسخ (استعادة سجل مفتاح لا تمس مفتاحاً آخر)",
    rowsA.length === 1 &&
      rowsA.every((row) => row.copyKey === "booking.no_options") &&
      rowsB.length === 2 &&
      rowsB.every((row) => row.copyKey === "booking.request") &&
      restoredB.success &&
      restoredB.data.override.text === TEXT_B1 &&
      bAfterRestore.ok &&
      bAfterRestore.source === "PLATFORM_OVERRIDE" &&
      bAfterRestore.text === TEXT_B1 &&
      // Key A is untouched: same effective override, same single audit row,
      // and no RESTORE row leaked into its log from key B's restore.
      aAfterRestore.ok &&
      aAfterRestore.source === "PLATFORM_OVERRIDE" &&
      aAfterRestore.text === TEXT_A &&
      rowsAAfter.length === 1 &&
      rowsAAfter[0]?.action === "PUBLISH" &&
      bRestoreRows.length === 1 &&
      bRestoreRows[0]?.copyKey === "booking.request",
  );

  // M14 (M) — there is NO tenant/business-scoped override behavior. The
  // persistence layer takes no businessId anywhere, the service signature
  // has no business parameter, and the schema models carry no business column.
  const persistenceFiles = [
    "src/features/conversation-copy/override-service.ts",
    "src/features/conversation-copy/override-types.ts",
    "src/server/repositories/copy-override.repository.ts",
    "src/lib/validation/copy-override.ts",
  ];
  const businessTokenHits: string[] = [];
  for (const rel of persistenceFiles) {
    const source = read(rel);
    if (/business(?:Id|_id)|tenantId|businessScope/i.test(source))
      businessTokenHits.push(rel);
  }
  const schemaSource = read("prisma/schema.prisma");
  const overrideModelBlock = /model\s+PlatformCopyOverride\s*\{[\s\S]*?\}/.exec(
    schemaSource,
  );
  const historyModelBlock =
    /model\s+PlatformCopyOverrideHistory\s*\{[\s\S]*?\}/.exec(schemaSource);
  check(
    "M14. لا يوجد أي سلوك تجاوز خاص بمشروع/مستأجر (لا معامل ولا عمود ولا نطاق)",
    businessTokenHits.length === 0 &&
      overrideModelBlock !== null &&
      !/business/i.test(overrideModelBlock[0]) &&
      historyModelBlock !== null &&
      !/business/i.test(historyModelBlock[0]),
  );
  if (businessTokenHits.length > 0) {
    for (const rel of businessTokenHits) console.error(`   scoped: ${rel}`);
  }
  // Every override read/write is platform-wide: the same published override
  // resolves identically regardless of any (absent) caller context.
  const platformWide = await resolveStoredCopy("greeting.invite", emptyDeps);
  check(
    "M14b. التجاوز المنشور هو نفسه لكل المتصلين (لا يوجد تقسيم حسب المستأجر)",
    platformWide.ok && platformWide.source === "CODE_DEFAULT",
  );

  // M15 (N) — the persistence layer never alters COPY_REGISTRY: defaults are
  // still the exact fallback target for all 48 keys, and the pure runtime
  // files are untouched by the persistence additions.
  const codeDefaultFailures: string[] = [];
  for (const e of COPY_REGISTRY) {
    if (codeDefaultFor(e.key) !== e.defaultText)
      codeDefaultFailures.push(e.key);
  }
  const unknownDefault = codeDefaultFor("handoff.does_not_exist");
  check(
    "M15. الطبقة الجديدة لا تغيّر COPY_REGISTRY: الافتراضي يبقى هدف التراجع لكل المفاتيح الـ48",
    codeDefaultFailures.length === 0 &&
      unknownDefault === null &&
      COPY_REGISTRY.length === 48,
  );
  if (codeDefaultFailures.length > 0) {
    for (const key of codeDefaultFailures) console.error(`   drift: ${key}`);
  }

  // M16 (O) — RUNTIME ISOLATION & APPROVED SLICE WIRING:
  // The persistence layer may be imported only by its own offline checks, the Lab UI,
  // the Lab management boundary, and the approved first runtime implementation slice
  // (conversation-engine.ts, which is restricted strictly to read-only resolution).
  const OVERRIDE_SYMBOLS =
    /\b(?:resolveStoredCopy|savePublishedOverride|resetPublishedOverride|restoreOverride|getPublishedOverride|listOverrideHistory|copyOverrideRepository|PlatformCopyOverride)\b/;
  const MUTATING_OVERRIDE_SYMBOLS =
    /\b(?:savePublishedOverride|resetPublishedOverride|restoreOverride|getPublishedOverride|listOverrideHistory|PlatformCopyOverride)\b/;

  // Structural validator for the conversation engine's approved runtime wiring:
  // Strictly enforces that ONLY literal "welcome.intro" may be resolved via resolveStoredCopy,
  // dynamic keys, unrelated keys, and extra wiring are rejected, and mutating symbols or Lab UI
  // imports remain strictly forbidden.
  function validateEngineCopyWiring(source: string): {
    valid: boolean;
    errors: string[];
    callCount: number;
    approvedCount: number;
  } {
    const errors: string[] = [];

    // 1. Management and mutating symbols are strictly forbidden
    const MUTATING_SYMBOLS = [
      "savePublishedOverride",
      "resetPublishedOverride",
      "restoreOverride",
      "getPublishedOverride",
      "listOverrideHistory",
      "PlatformCopyOverride",
    ];
    for (const sym of MUTATING_SYMBOLS) {
      if (new RegExp(`\\b${sym}\\b`).test(source)) {
        errors.push(
          `Mutating or management symbol forbidden in runtime engine: ${sym}`,
        );
      }
    }

    // 2. Lab UI imports and actions are strictly forbidden
    if (
      /copy-lab-actions|CopyLabBrowser|CopyLabDetail|conversation-lab|copy-lab-logic/.test(
        source,
      )
    ) {
      errors.push(
        "Conversation Lab UI modules and actions are forbidden in runtime engine",
      );
    }

    // 3. Find and inspect all resolveStoredCopy invocations
    const resolveRegex = /\bresolveStoredCopy\s*\(\s*([^,\)]+)/g;
    let match: RegExpExecArray | null;
    let callCount = 0;
    let approvedCount = 0;

    while ((match = resolveRegex.exec(source)) !== null) {
      callCount += 1;
      const rawArg = (match[1] ?? "").trim();
      const isApproved =
        rawArg === '"welcome.intro"' || rawArg === "'welcome.intro'";
      if (isApproved) {
        approvedCount += 1;
      } else {
        errors.push(
          `Disallowed resolver key at call site: ${rawArg} (only literal "welcome.intro" is approved)`,
        );
      }
    }

    if (callCount === 0) {
      errors.push(
        'Missing approved runtime resolver call site: resolveStoredCopy("welcome.intro", ...)',
      );
    } else if (callCount > 1) {
      errors.push(
        `Extra resolver wiring detected: expected exactly 1 call site for welcome.intro, found ${callCount}`,
      );
    }

    return {
      valid: errors.length === 0,
      errors,
      callCount,
      approvedCount,
    };
  }

  const overrideWired: string[] = [];
  for (const file of walkTs(path.join(process.cwd(), "src"))) {
    const rel = path.relative(process.cwd(), file).split(path.sep).join("/");
    if (rel.startsWith(REGISTRY_DIR)) continue;
    if (isPersistenceLayer(rel)) continue;
    // The sanctioned Lab management boundary (UX-LAB-01D-2): the one
    // platform-authorized "use server" seam the Lab uses to reach this
    // service. It is not a production reply path; the reply paths themselves
    // are still scanned unconditionally below (M16b).
    if (isLabServerBoundary(rel)) continue;
    if (rel === "src/features/conversations/server/conversation-engine.ts") {
      // In the approved runtime slice, the engine may ONLY call resolveStoredCopy
      // with literal "welcome.intro" (and inject copyOverrideRepository).
      // Mutating/management symbols, Lab UI modules, unrelated keys, and extra
      // wiring remain strictly forbidden.
      const engSrc = read(rel);
      const validation = validateEngineCopyWiring(engSrc);
      if (!validation.valid) {
        for (const err of validation.errors) {
          overrideWired.push(`${rel} (${err})`);
        }
      }
      continue;
    }
    const source = read(rel);
    if (
      /import\s[\s\S]*?conversation-copy\/(?:override|override-service|override-types)/.test(
        source,
      ) ||
      OVERRIDE_SYMBOLS.test(source)
    )
      overrideWired.push(rel);
  }
  check(
    "M16. مسار الرد الإنتاجي المعتمد (المحرك) محصور في قراءة welcome.intro فقط، وباقي المسارات خالية",
    overrideWired.length === 0,
  );
  if (overrideWired.length > 0) {
    for (const rel of overrideWired) console.error(`   override-wired: ${rel}`);
  }
  // The remaining reply paths themselves stay byte-for-byte free of the override layer.
  check(
    "M16b. مسارات الرد الأساسية غير المعتمدة خالية تماماً من طبقة التجاوز",
    ![
      AI_FILE,
      CLARIFY_FILE,
      SELECTION_FILE,
      TELEGRAM_WEBHOOK_FILE,
      TELEGRAM_MANAGER_FILE,
      HANDOFF_POLICY_FILE,
      WHATSAPP_TRANSPORT_FILE,
      "src/features/conversations/server/booking-mapper.ts",
    ].some((f) => OVERRIDE_SYMBOLS.test(read(f))),
  );
  // The persistence service is NOT part of the pure runtime surface the
  // L1 purity guard covers, and it stays inside the registry dir (the only
  // place the anti-wiring walk exempts). It must not leak the DB boundary
  // into the pure validation/render contracts.
  check(
    "M16c. طبقة الثبات لا تتسرب إلى عقد التحقق/العرض النقية (تبقى نقية)",
    !COPY_RUNTIME_FILES.some((rel) =>
      /@\/server\/(?:repositories|db)|@prisma|prisma/.test(read(rel)),
    ),
  );

  // M16d — STRUCTURAL RUNTIME GUARD & NEGATIVE FIXTURES:
  // Proves that validateEngineCopyWiring deterministically rejects:
  //  1. Unapproved static copy key (e.g. "greeting.invite")
  //  2. Dynamic key variable (e.g. dynamicKey)
  //  3. Template literal key (e.g. `welcome.${sub}`)
  //  4. Extra wiring (more than 1 resolveStoredCopy call site)
  //  5. Mutating override management symbols
  //  6. Lab UI module/action imports
  // And accepts ONLY the approved single welcome.intro call site.
  const fixtureDisallowedKey = validateEngineCopyWiring(
    'async function turn() { await resolveStoredCopy("greeting.invite", deps); }',
  );
  const fixtureDynamicKey = validateEngineCopyWiring(
    "async function turn() { await resolveStoredCopy(dynamicKey, deps); }",
  );
  const fixtureTemplateLiteralKey = validateEngineCopyWiring(
    "async function turn() { await resolveStoredCopy(`welcome.${sub}`, deps); }",
  );
  const fixtureExtraWiring = validateEngineCopyWiring(
    'async function turn() {\n  await resolveStoredCopy("welcome.intro", deps);\n  await resolveStoredCopy("welcome.intro", deps);\n}',
  );
  const fixtureMutatingSymbol = validateEngineCopyWiring(
    'async function turn() {\n  await resolveStoredCopy("welcome.intro", deps);\n  await savePublishedOverride(actor, "welcome.intro", text, deps);\n}',
  );
  const fixtureLabUiImport = validateEngineCopyWiring(
    'import { copyLabAction } from "@/features/platform/actions/copy-lab-actions";\nasync function turn() { await resolveStoredCopy("welcome.intro", deps); }',
  );
  const fixtureValid = validateEngineCopyWiring(
    'async function turn() { await resolveStoredCopy("welcome.intro", deps); }',
  );

  const fixturesPass =
    !fixtureDisallowedKey.valid &&
    fixtureDisallowedKey.errors.some((e) => e.includes("greeting.invite")) &&
    !fixtureDynamicKey.valid &&
    fixtureDynamicKey.errors.some((e) => e.includes("dynamicKey")) &&
    !fixtureTemplateLiteralKey.valid &&
    fixtureTemplateLiteralKey.errors.some((e) =>
      e.includes("welcome.${sub}"),
    ) &&
    !fixtureExtraWiring.valid &&
    fixtureExtraWiring.errors.some((e) =>
      e.includes("Extra resolver wiring"),
    ) &&
    !fixtureMutatingSymbol.valid &&
    fixtureMutatingSymbol.errors.some((e) =>
      e.includes("Mutating or management"),
    ) &&
    !fixtureLabUiImport.valid &&
    fixtureLabUiImport.errors.some((e) => e.includes("Lab UI modules")) &&
    fixtureValid.valid &&
    fixtureValid.approvedCount === 1;

  check(
    "M16d. الحارس البنيوي يرفض بدقة المفاتيح غير المعتمدة والديناميكية والربط الزائد ورموز الإدارة (Negative Fixtures)",
    fixturesPass,
  );

  // M17 — the fallback boundary stays explicit and TESTABLE: only the
  // persistence READ is guarded inside resolveStoredCopy. Verified
  // structurally over the service source — every validateCopyCandidate()
  // call site must sit OUTSIDE every try block, so a validator defect (or any
  // other programmer error) propagates instead of being converted into a
  // typed PERSISTENCE_FAILED/PERSISTENCE_UNAVAILABLE result; and the
  // persistence read in resolveStoredCopy must be guarded.
  const overrideServiceSource = read(
    "src/features/conversation-copy/override-service.ts",
  );
  // Track try-block nesting by line. Only a `try {` at a line's start opens a
  // scope and only a leading `} catch` closes it, so braces inside string
  // literals cannot confuse the walk; the file is formatted that way.
  const callSiteDepths: number[] = [];
  let tryDepth = 0;
  for (const line of overrideServiceSource.split("\n")) {
    const trimmed = line.trim();
    if (/^try\s*\{/.test(trimmed)) tryDepth += 1;
    const calls = trimmed.match(/validateCopyCandidate\(/g);
    for (let i = 0; i < (calls?.length ?? 0); i += 1) {
      callSiteDepths.push(tryDepth);
    }
    if (/^\}\s*catch/.test(trimmed)) tryDepth -= 1;
  }
  const unguardedValidationCalls = callSiteDepths.filter((d) => d !== 0);
  check(
    "M17. حدود التراجع صريحة: حراسة قراءة الثبات فقط داخل resolveStoredCopy (لا ابتلاع لأخطاء المبرمج)",
    callSiteDepths.length > 0 &&
      unguardedValidationCalls.length === 0 &&
      tryDepth === 0 &&
      /try\s*\{[\s\S]*?await\s+deps\.getPublished\(key\)[\s\S]*?\}\s*catch/.test(
        overrideServiceSource,
      ),
  );
  if (unguardedValidationCalls.length > 0) {
    console.error(
      `   swallowed-validation: ${unguardedValidationCalls.length} call site(s) inside a try block`,
    );
  }

  // M17b — the whole service surface is a typed boundary: it NEVER throws.
  // Every pathological input (unknown key, non-string/empty/over-long text, a
  // non-Platform actor, and a repository whose every method throws) yields a
  // typed result. A throw escaping any probe fails this check AND aborts the
  // script, so the contract is proved rather than assumed.
  const throwingDeps = {
    getPublished: async () => {
      throw new Error("simulated persistence outage");
    },
    save: async () => {
      throw new Error("simulated persistence outage");
    },
    remove: async () => {
      throw new Error("simulated persistence outage");
    },
    recordHistory: async () => {
      throw new Error("simulated persistence outage");
    },
    listHistory: async () => {
      throw new Error("simulated persistence outage");
    },
    findHistoryById: async () => {
      throw new Error("simulated persistence outage");
    },
  };
  const NON_PLATFORM_ACTOR = { userId: "staff-1", accountType: "BUSINESS" };
  type Probe = { name: string; result?: unknown; threw?: string };
  const probes: Probe[] = [];
  const probe = async (
    name: string,
    run: () => Promise<unknown>,
  ): Promise<void> => {
    try {
      probes.push({ name, result: await run() });
    } catch (error) {
      probes.push({ name, threw: (error as Error).message });
    }
  };
  await probe("resolve-outage", () =>
    resolveStoredCopy("greeting.invite", throwingDeps),
  );
  await probe("resolve-unknown-key", () =>
    resolveStoredCopy("handoff.does_not_exist", throwingDeps),
  );
  await probe("get-unknown-key", () =>
    getPublishedOverride("handoff.does_not_exist", throwingDeps),
  );
  await probe("get-outage", () =>
    getPublishedOverride("greeting.invite", throwingDeps),
  );
  await probe("save-non-string", () =>
    savePublishedOverride(
      PLATFORM_ACTOR,
      "greeting.invite",
      null,
      throwingDeps,
    ),
  );
  await probe("save-forbidden", () =>
    savePublishedOverride(NON_PLATFORM_ACTOR, "greeting.invite", "مرحباً", {
      ...throwingDeps,
      // The FORBIDDEN guard runs before any persistence call, so a working
      // read is what a real deployment would hit here.
      getPublished: async () => null,
    }),
  );
  await probe("reset-unknown-key", () =>
    resetPublishedOverride(
      PLATFORM_ACTOR,
      "handoff.does_not_exist",
      throwingDeps,
    ),
  );
  await probe("reset-forbidden", () =>
    resetPublishedOverride(NON_PLATFORM_ACTOR, "greeting.invite", throwingDeps),
  );
  await probe("list-outage", () =>
    listOverrideHistory(PLATFORM_ACTOR, "greeting.invite", 25, throwingDeps),
  );
  await probe("restore-outage", () =>
    restoreOverride(PLATFORM_ACTOR, "hist-nonexistent", throwingDeps),
  );
  const probeResult = (name: string): unknown =>
    probes.find((p) => p.name === name)?.result;
  // Accept both result shapes: resolveStoredCopy discriminates on `ok`, the
  // read/write/history functions on `success`.
  const isTypedFailure = (name: string, code: string): boolean => {
    const result = probeResult(name);
    if (result === undefined) return false;
    const failure = result as {
      ok?: boolean;
      success?: boolean;
      code?: string;
      error?: { code?: string };
    };
    return (
      (failure.ok === false || failure.success === false) &&
      (failure.code === code || failure.error?.code === code)
    );
  };
  const threw = probes.filter((p) => p.threw !== undefined);
  const resolvedOutage = probeResult("resolve-outage") as {
    ok?: boolean;
    source?: string;
    fallbackReason?: string;
  };
  check(
    "M17b. سطح الخدمة بالكامل حدٌّ مُنمَّق: لا يرمي استثناءً أبداً (كل دخول شاذ يعطي نتيجة مُنمَّقة)",
    threw.length === 0 &&
      // Validation runs BEFORE any persistence call, so a non-string candidate
      // is a typed INVALID_COPY even with a dead repository.
      isTypedFailure("save-non-string", "INVALID_COPY") &&
      // Authorization precedes both validation and persistence.
      isTypedFailure("save-forbidden", "FORBIDDEN") &&
      isTypedFailure("reset-forbidden", "FORBIDDEN") &&
      // An unknown key has no code default to fall to — a typed error, never
      // an empty string or an exception.
      isTypedFailure("resolve-unknown-key", "UNKNOWN_COPY_KEY") &&
      isTypedFailure("get-unknown-key", "UNKNOWN_COPY_KEY") &&
      isTypedFailure("reset-unknown-key", "UNKNOWN_COPY_KEY") &&
      // A dead repository degrades to a typed persistence failure, and for
      // resolution specifically to the safe code default.
      isTypedFailure("get-outage", "PERSISTENCE_FAILED") &&
      isTypedFailure("list-outage", "PERSISTENCE_FAILED") &&
      isTypedFailure("restore-outage", "PERSISTENCE_FAILED") &&
      resolvedOutage.ok === true &&
      resolvedOutage.source === "CODE_DEFAULT" &&
      resolvedOutage.fallbackReason === "PERSISTENCE_UNAVAILABLE",
  );
  for (const p of threw) console.error(`   threw: ${p.name} — ${p.threw}`);

  // ── N. Founder Conversation Lab UI (UX-LAB-01D-1) ───────────────────────
  //
  // The read-only Founder/superadmin Lab surface over COPY_REGISTRY + the pure
  // render contract. Proven OFFLINE: the platform route + authorization, the
  // browser deriving from the registry (never a duplicated entry list), all 48
  // entries represented, PROTECTED_COPY visibly read-only, search/filter
  // purity, the preview going through renderCopy, template placeholders
  // exercised, missing required values failing safely, and no provider /
  // network / DB / customer-send path anywhere near the Lab.
  const LAB_PAGE = "src/app/(platform)/platform/conversation-lab/page.tsx";
  const LAB_LOGIC = "src/features/platform/components/copy-lab-logic.ts";
  const LAB_BROWSER = "src/features/platform/components/copy-lab-browser.tsx";
  const LAB_DETAIL = "src/features/platform/components/copy-lab-detail.tsx";
  const PLATFORM_LAYOUT = "src/app/(platform)/layout.tsx";
  const labPageSource = read(LAB_PAGE);
  const labLogicSource = read(LAB_LOGIC);
  const labBrowserSource = read(LAB_BROWSER);
  const labDetailSource = read(LAB_DETAIL);
  const labUiSources = [
    labPageSource,
    labLogicSource,
    labBrowserSource,
    labDetailSource,
  ];

  const {
    buildClassificationChips,
    collectPreviewValues,
    demoPlaceholderValues,
    filterCopyEntries,
    groupCopyEntriesByCategory,
  } = await import("../src/features/platform/components/copy-lab-logic");

  // N1 — the platform route exists, renders the browser, and is guarded by the
  // PLATFORM operator authorization (layout + page, defense in depth).
  check(
    "N1. صفحة المختبر موجودة في مسار المنصة وتعرض المتصفح ومحمية بصلاحية مشغل المنصة",
    fs.existsSync(path.join(process.cwd(), LAB_PAGE)) &&
      labPageSource.includes("CopyLabBrowser") &&
      labPageSource.includes("requirePlatformOperator") &&
      read(PLATFORM_LAYOUT).includes("requirePlatformOperator"),
  );

  // N2 — the browser derives from COPY_REGISTRY directly: the page imports the
  // registry and forwards it, and no Lab UI file re-declares entry literals
  // (a `defaultText:` property ASSIGNMENT only exists in the registry; the UI
  // only ever READS entry.defaultText).
  check(
    "N2. واجهة المختبر مشتقة من COPY_REGISTRY مباشرةً (لا توجد قائمة مكررة): الصفحة تستورد السجل وتمرّره، ولا يوجد حرف افتراضي مكرر",
    labPageSource.includes("@/features/conversation-copy") &&
      labPageSource.includes("entries={COPY_REGISTRY}") &&
      labUiSources.every((src) => !/defaultText\s*:/.test(src)),
  );

  // N3 — the default view represents ALL 48 entries, in registry order, with
  // no key lost, added, or reordered by the projection.
  const labAll = filterCopyEntries(COPY_REGISTRY, {
    search: "",
    classification: "ALL",
  });
  check(
    "N3. العرض الافتراضي يمثّل كل المفاتيح الـ48 بنفس ترتيب السجل (بدون فقد أو إضافة)",
    labAll.length === COPY_REGISTRY.length &&
      COPY_REGISTRY.length === 48 &&
      labAll.every((entry, i) => entry.key === COPY_REGISTRY[i]!.key),
  );

  // N4 — classification counts are derived from the registry, never a
  // hand-maintained tally (ALL 48 / 31 editable / 13 template / 4 protected).
  const chips = buildClassificationChips(COPY_REGISTRY);
  const chipCount = (value: string): number | undefined =>
    chips.find((c) => c.value === value)?.count;
  check(
    "N4. عدّادات تصنيفات المختبر مشتقة من السجل: الكل 48، عادي 31، قالب 13، محمي 4",
    chips.length === 4 &&
      chipCount("ALL") === 48 &&
      chipCount("EDITABLE_COPY") === 31 &&
      chipCount("EDITABLE_TEMPLATE") === 13 &&
      chipCount("PROTECTED_COPY") === 4,
  );

  // N5 — search/filter is pure: it returns a NEW array, leaves the registry
  // untouched (length + identity + order), and yields a subset.
  const beforeFilter = COPY_REGISTRY;
  const labSearch = filterCopyEntries(COPY_REGISTRY, {
    search: "booking",
    classification: "ALL",
  });
  const labProtectedOnly = filterCopyEntries(COPY_REGISTRY, {
    search: "",
    classification: "PROTECTED_COPY",
  });
  check(
    "N5. البحث/التصفية نقي: مصفوفة جديدة ولا يغيّر السجل (الطول والترتيب والمرجع)، ونتيجته مجموعة جزئية",
    labAll !== beforeFilter &&
      beforeFilter.length === 48 &&
      labAll.every((entry, i) => entry === beforeFilter[i]) &&
      labSearch.length > 0 &&
      labSearch.length < 48 &&
      labSearch.every((e) => e.key.includes("booking")) &&
      labProtectedOnly.length === 4 &&
      labProtectedOnly.every((e) => e.classification === "PROTECTED_COPY"),
  );

  // N6 — grouping is pure + lossless: the registry interleaves its categories
  // (booking.* and error.* alternate), so grouping legitimately REORDERS by
  // category — the invariants are that no key is lost or duplicated, each
  // group preserves the input's RELATIVE order, and every category is real.
  const labGroups = groupCopyEntriesByCategory(labAll);
  const regrouped = labGroups.flatMap((g) => g.items);
  const groupIndexByKey = new Map(labAll.map((e, i) => [e.key, i]));
  const regroupedSet = new Set(regrouped.map((e) => e.key));
  const lossless =
    regrouped.length === 48 &&
    regroupedSet.size === 48 &&
    [...regroupedSet].every((key) => groupIndexByKey.has(key));
  const relativeOrderOk = labGroups.every((g) => {
    const indices = g.items.map((e) => groupIndexByKey.get(e.key)!);
    return indices.every((value, i) => i === 0 || indices[i - 1]! < value);
  });
  const groupCategories = new Set(labGroups.map((g) => g.category));
  check(
    "N6. التجميع حسب الفئة نقي وكامل: يحفظ كل المفاتيح وترتيبها النسبي داخل كل فئة، وكل فئة من السجل",
    labGroups.length === 9 &&
      groupCategories.size === 9 &&
      [...groupCategories].every((c) =>
        COPY_REGISTRY.some((e) => e.category === c),
      ) &&
      lossless &&
      relativeOrderOk &&
      regrouped !== labAll,
  );

  // N7 — the preview goes through the canonical render contract. The detail
  // component must import + CALL renderCopy / renderCopyText (the shared pure
  // substitution core; the 01D-2 candidate preview renders the DRAFT through
  // renderCopyText) and must NOT reimplement substitution itself (no direct
  // placeholder engine access).
  check(
    "N7. المعاينة تمر عبر عقد العرض الكنسي (renderCopy/renderCopyText): المكوّن يستورده ويستدعيه، ولا يعيد تنفيذ الاستبدال",
    labDetailSource.includes('from "@/features/conversation-copy"') &&
      /\brenderCopy(?:Text)?\s*\(/.test(labDetailSource) &&
      !/substitutePlaceholders|scanPlaceholderTokens/.test(labDetailSource),
  );

  // N8 — template preview exercises EXACTLY the declared placeholders: demo
  // values carry no invented placeholder, and every template renders fully
  // (ok + no leftover `{` token) through renderCopy.
  const templatesForLab = COPY_REGISTRY.filter(
    (e) => e.classification === "EDITABLE_TEMPLATE",
  );
  const templatePreviewFailures: string[] = [];
  for (const entry of templatesForLab) {
    const demo = demoPlaceholderValues(entry);
    const demoKeys = Object.keys(demo).sort();
    const declared = [...entry.placeholders].sort();
    if (demoKeys.join(",") !== declared.join(",")) {
      templatePreviewFailures.push(`${entry.key}: demo keys ≠ declared`);
      continue;
    }
    const rendered = renderCopy(entry.key, demo);
    if (!rendered.ok || rendered.text.includes("{")) {
      templatePreviewFailures.push(
        `${entry.key}: ${rendered.ok ? "leftover token" : rendered.code}`,
      );
    }
  }
  check(
    "N8. معاينة القوالب تشغّل الحقول المُصرَّح بها فقط (13 قالب): قيم العرض لا تخترع حقولاً، وكل قالب يُعرض كاملاً عبر renderCopy",
    templatesForLab.length === 13 && templatePreviewFailures.length === 0,
  );
  if (templatePreviewFailures.length > 0) {
    for (const failure of templatePreviewFailures)
      console.error(`   preview failure: ${failure}`);
  }

  // N9 — missing required placeholder values fail SAFELY: a cleared required
  // value is absent from the map, so renderCopy returns the typed
  // MISSING_PLACEHOLDER_VALUE instead of inventing or half-rendering.
  const businessClosed = COPY_REGISTRY.find(
    (e) => e.key === "booking.business_closed",
  )!;
  const missingDate = renderCopy(
    businessClosed.key,
    collectPreviewValues(businessClosed, { date: "   " }),
  );
  const plainPreview = renderCopy(
    COPY_REGISTRY.find((e) => e.key === "greeting.invite")!.key,
    {},
  );
  const protectedPreview = renderCopy(
    COPY_REGISTRY.find((e) => e.key === "handoff.human_request")!.key,
    {},
  );
  check(
    "N9. الحقل المطلوب الناقص يفشل بأمان (MISSING_PLACEHOLDER_VALUE)، والنصوص العادية والمحمية تُعرض بدون حقول",
    !missingDate.ok &&
      missingDate.code === "MISSING_PLACEHOLDER_VALUE" &&
      (missingDate.placeholders ?? []).includes("date") &&
      plainPreview.ok === true &&
      protectedPreview.ok === true,
  );

  // N10 — read-only slice: NO persistence/override layer is imported anywhere
  // in the Lab UI (M16 still scans these files), and no edit/publish/reset/
  // restore action is wired.
  check(
    "N10. شريحة للقراءة فقط: لا يستورد المختبر طبقة التجاوز/الثبات ولا يربط أي إجراء تعديل/نشر/إعادة تعيين/استرجاع",
    labUiSources.every(
      (src) =>
        !/conversation-copy\/(?:override|override-service|override-types)/.test(
          src,
        ) &&
        !/(?:resolveStoredCopy|savePublishedOverride|resetPublishedOverride|restoreOverride|getPublishedOverride|listOverrideHistory)/.test(
          src,
        ) &&
        !/@\/server\/(?:repositories|db)|@prisma|\bprisma\b/.test(src),
    ),
  );

  // N11 — the preview path stays away from every provider/network/customer-send
  // concern: no fetch, no LLM/openrouter/telegram/whatsapp transport, no
  // server integration in any Lab UI file.
  check(
    "N11. مسار المعاينة خالٍ من المزود/الشبكة/الإرسال: لا fetch ولا تكاملات خادم في ملفات المختبر",
    labUiSources.every(
      (src) =>
        !/\bfetch\s*\(/.test(src) &&
        !/openrouter|@\/server\/transport|@\/server\/integrations/.test(src),
    ),
  );

  // N12 — production customer reply paths stay unwired to the Lab AND to
  // override resolution (extends I2 / L2 / M16 to the new Lab surface).
  check(
    "N12. مسارات رد العميل تبقى غير موصولة بالمختبر أو بطبقة التجاوز",
    ![
      AI_FILE,
      CLARIFY_FILE,
      SELECTION_FILE,
      TELEGRAM_WEBHOOK_FILE,
      TELEGRAM_MANAGER_FILE,
      HANDOFF_POLICY_FILE,
      WHATSAPP_TRANSPORT_FILE,
      "src/features/conversations/server/conversation-engine.ts",
      "src/features/conversations/server/booking-mapper.ts",
    ].some(
      (f) =>
        read(f).includes("conversation-lab") ||
        read(f).includes("copy-lab") ||
        read(f).includes("CopyLab"),
    ),
  );

  // ── O. Founder Conversation Lab MANAGEMENT surface (UX-LAB-01D-2) ────────
  //
  // The smallest useful management UI over the 01C persistence service,
  // reachable ONLY through one platform-authorized server boundary. Proven
  // OFFLINE with the service's own injectable in-memory repository: the
  // boundary's delegation contract, the pure UI projections (effective state,
  // edit gating, history views, failure guidance), delegated validation on
  // publish, the effective-source flip, idempotent reset, newest-first
  // bounded history, valid restore / refused stale restore, a non-PLATFORM
  // actor unable to mutate, a persistence outage surfaced (not crashing, not
  // corrupting the code default), the registry left byte-for-byte unchanged,
  // the production reply paths still unwired, and the preview still
  // provider/network/send-free.
  const LAB_ACTIONS = "src/features/platform/actions/copy-lab-actions.ts";
  const labActionsSource = read(LAB_ACTIONS);
  const {
    canEditCopy,
    mapEffectiveCopyState,
    mapHistoryItems,
    overrideErrorGuidance,
    COPY_OVERRIDE_ACTION_LABELS,
    COPY_OVERRIDE_ERROR_GUIDANCE,
    COPY_VALIDATION_FAILURE_GUIDANCE,
  } = await import("../src/features/platform/components/copy-lab-logic");
  const { renderCopyText } = registryModule;

  // O1 (A) — EDITABLE_COPY loads for edit: the edit gate admits exactly the
  // 31 editable entries, and the effective-state projection (read through the
  // service's own typed results) seeds the editor from the code default.
  const oDeps = makeFakeDeps();
  const editableKeys = COPY_REGISTRY.filter(
    (e) => e.classification === "EDITABLE_COPY",
  );
  const editableLoadFailures: string[] = [];
  for (const e of editableKeys) {
    if (!canEditCopy(e)) editableLoadFailures.push(`${e.key}: gate refused`);
    const state = mapEffectiveCopyState(
      e,
      await resolveStoredCopy(e.key, oDeps),
      await getPublishedOverride(e.key, oDeps),
    );
    if (
      !state.editable ||
      state.source !== "CODE_DEFAULT" ||
      state.text !== e.defaultText ||
      state.editorSeed !== e.defaultText ||
      state.publishedText !== null
    )
      editableLoadFailures.push(`${e.key}: bad load state`);
  }
  check(
    "O1 (A). تحميل EDITABLE_COPY للتعديل: البوابة تقبل 31 نصاً والمحرر يبدأ من النص الافتراضي",
    editableKeys.length === 31 && editableLoadFailures.length === 0,
  );
  if (editableLoadFailures.length > 0)
    for (const f of editableLoadFailures) console.error(`   ${f}`);

  // O2 (B) — EDITABLE_TEMPLATE loads for edit, seeded from the PUBLISHED
  // override when one exists (the registry is never mutated — only local
  // draft state is seeded from what is stored).
  const TEMPLATE_KEY = "booking.business_closed";
  const templateEntry = getCopyEntry(TEMPLATE_KEY)!;
  const TEMPLATE_OVERRIDE = "المنشأة مغلقة يوم {date} — اختر موعداً آخر.";
  const tplDeps = makeFakeDeps();
  const tplPublish = await savePublishedOverride(
    PLATFORM_ACTOR,
    TEMPLATE_KEY,
    TEMPLATE_OVERRIDE,
    tplDeps,
  );
  const tplState = mapEffectiveCopyState(
    templateEntry,
    await resolveStoredCopy(TEMPLATE_KEY, tplDeps),
    await getPublishedOverride(TEMPLATE_KEY, tplDeps),
  );
  check(
    "O2 (B). تحميل EDITABLE_TEMPLATE للتعديل: المحرر يبدأ من التجاوز المنشور ولا يغيّر السجل",
    templateEntry.classification === "EDITABLE_TEMPLATE" &&
      tplPublish.success &&
      tplState.editable &&
      tplState.source === "PLATFORM_OVERRIDE" &&
      tplState.editorSeed === TEMPLATE_OVERRIDE &&
      tplState.publishedText === TEMPLATE_OVERRIDE &&
      templateEntry.defaultText !== TEMPLATE_OVERRIDE,
  );

  // O3 (C) — PROTECTED_COPY exposes no writable control: the gate refuses all
  // 4 protected entries, their mapped state is never editable, and the detail
  // view renders the whole mutation surface (editor / history / publish /
  // reset / restore) only inside the `canMutate` branch that requires it —
  // the protected branch renders none of it.
  const protectedKeys = COPY_REGISTRY.filter(
    (e) => e.classification === "PROTECTED_COPY",
  );
  const protectedFailures: string[] = [];
  for (const e of protectedKeys) {
    if (canEditCopy(e)) protectedFailures.push(`${e.key}: gate admitted`);
    const st = mapEffectiveCopyState(
      e,
      await resolveStoredCopy(e.key, oDeps),
      await getPublishedOverride(e.key, oDeps),
    );
    if (st.editable || st.editorSeed !== e.defaultText)
      protectedFailures.push(`${e.key}: bad protected state`);
  }
  // Structural: the mutation surface is one conditional branch off `editable`.
  // Every mutation surface (editor / history + restore / publish + reset)
  // first occurs AFTER a `canMutate` JSX guard, and the protected branch
  // renders none of it.
  const canMutateDerived =
    /const canMutate = editable && effective !== null && !persistenceDown;/.test(
      labDetailSource,
    );
  const firstGuard = labDetailSource.indexOf("{canMutate");
  const guardCount = (labDetailSource.match(/\{canMutate/g) ?? []).length;
  const mutationSurfaces = [
    "<CopyEditor",
    "<HistorySection",
    "publishCopyOverrideAction(",
    "resetCopyOverrideAction(",
    "restoreCopyOverrideAction(",
  ];
  const surfacesGuarded = mutationSurfaces.every(
    (surface) => labDetailSource.indexOf(surface) > firstGuard,
  );
  const protectedBranchStart = labDetailSource.indexOf("{isProtected ? (");
  const protectedBranchEnd = labDetailSource.indexOf(
    ") : (",
    protectedBranchStart,
  );
  const protectedBranch = labDetailSource.slice(
    protectedBranchStart,
    protectedBranchEnd,
  );
  const protectedBranchClean =
    protectedBranchStart !== -1 &&
    protectedBranchEnd > protectedBranchStart &&
    !/CopyEditor|HistorySection|publishCopyOverrideAction|resetCopyOverrideAction|restoreCopyOverrideAction/.test(
      protectedBranch,
    );
  check(
    "O3 (C). PROTECTED_COPY بلا أي تحكم قابل للكتابة: البوابة ترفض الـ4، وكل سطح التعديل خلف فرع canMutate، وفرع الحماية لا يعرض أي إجراء",
    protectedKeys.length === 4 &&
      protectedFailures.length === 0 &&
      canMutateDerived &&
      firstGuard !== -1 &&
      guardCount === 3 &&
      surfacesGuarded &&
      protectedBranchClean,
  );
  if (protectedFailures.length > 0)
    for (const f of protectedFailures) console.error(`   ${f}`);

  // O4 (D) — publish DELEGATES through the service: the boundary imports and
  // calls the service primitives, authorizes from the persisted PLATFORM
  // user, imports no Prisma/db/repository, and duplicates no validation rule
  // (it never calls validateCopyCandidate itself). And the delegated path
  // itself persists + audits through the injected repository.
  //
  // The no-duplication/no-Prisma assertions run against CODE only (comments
  // stripped): the boundary's own header documents the prohibition by name,
  // which must not count as a code reference.
  const stripComments = (source: string): string =>
    source.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const actionsCode = stripComments(labActionsSource);
  const delegationDeps = makeFakeDeps();
  const delegated = await savePublishedOverride(
    PLATFORM_ACTOR,
    "greeting.invite",
    "أهلاً بك في عيادتنا — كيف أساعدك اليوم؟",
    delegationDeps,
  );
  check(
    "O4 (D). النشر يمر عبر الخدمة: الحدّ يستدعي بدائياتها ويعتمد الصلاحية من مستخدم المنصة المخزّن، ولا يستورد Prisma/المستودع ولا يكرّر قواعد التحقق",
    delegated.success &&
      delegated.data.override.text ===
        "أهلاً بك في عيادتنا — كيف أساعدك اليوم؟" &&
      delegationDeps.history.some((h) => h.action === "PUBLISH") &&
      labActionsSource.includes('"use server";') &&
      labActionsSource.includes("requirePlatformOperator") &&
      labActionsSource.includes("userRepository.findById") &&
      /import\s[\s\S]*?savePublishedOverride/.test(actionsCode) &&
      /import\s[\s\S]*?resolveStoredCopy/.test(actionsCode) &&
      /import\s[\s\S]*?getPublishedOverride/.test(actionsCode) &&
      /import\s[\s\S]*?listOverrideHistory/.test(actionsCode) &&
      /import\s[\s\S]*?restoreOverride/.test(actionsCode) &&
      !/@prisma|@\/server\/db|\bcopyOverrideRepository\b|\bvalidateCopyCandidate\b/.test(
        actionsCode,
      ),
  );

  // O5 (E) — an invalid publish is rejected by the delegated contract, with
  // the stable technical failure code attached.
  const invalidPublish = await savePublishedOverride(
    PLATFORM_ACTOR,
    "greeting.invite",
    "   ",
    oDeps,
  );
  check(
    "O5 (E). النشر بنص غير صالح يُرفض بنتيجة مُنمَّقة (INVALID_COPY / EMPTY_TEXT)",
    !invalidPublish.success &&
      invalidPublish.error.code === "INVALID_COPY" &&
      invalidPublish.error.validationFailure?.code === "EMPTY_TEXT",
  );

  // O6 (F) — dropping a REQUIRED placeholder is rejected.
  const missingRequired = await savePublishedOverride(
    PLATFORM_ACTOR,
    TEMPLATE_KEY,
    "المنشأة مغلقة اليوم — عُد لاحقاً.",
    oDeps,
  );
  check(
    "O6 (F). حذف حقل مطلوب يُرفض (MISSING_REQUIRED_PLACEHOLDER)",
    !missingRequired.success &&
      missingRequired.error.code === "INVALID_COPY" &&
      missingRequired.error.validationFailure?.code ===
        "MISSING_REQUIRED_PLACEHOLDER",
  );

  // O7 (G) — removing a protected parser/state marker is rejected.
  const MARKER_KEY = "clarify.date";
  const markerEntry = getCopyEntry(MARKER_KEY)!;
  const markerPhrase = (markerEntry.markers ?? [])[0]?.substring ?? "";
  const markerRemoved = await savePublishedOverride(
    PLATFORM_ACTOR,
    MARKER_KEY,
    "ما الموعد المناسب لك؟",
    oDeps,
  );
  check(
    "O7 (G). حذف عبارة محمية يُرفض (MARKER_REMOVED)",
    markerPhrase.length > 0 &&
      !markerRemoved.success &&
      markerRemoved.error.code === "INVALID_COPY" &&
      markerRemoved.error.validationFailure?.code === "MARKER_REMOVED",
  );

  // O8 (H) — a successful publish flips the Lab effective source to
  // PLATFORM_OVERRIDE (read through the service + the UI projection).
  const flipDeps = makeFakeDeps();
  const beforeFlip = mapEffectiveCopyState(
    getCopyEntry("greeting.invite")!,
    await resolveStoredCopy("greeting.invite", flipDeps),
    await getPublishedOverride("greeting.invite", flipDeps),
  );
  await savePublishedOverride(
    PLATFORM_ACTOR,
    "greeting.invite",
    "أهلاً بك — كيف أساعدك؟",
    flipDeps,
  );
  const afterFlip = mapEffectiveCopyState(
    getCopyEntry("greeting.invite")!,
    await resolveStoredCopy("greeting.invite", flipDeps),
    await getPublishedOverride("greeting.invite", flipDeps),
  );
  check(
    "O8 (H). النشر الناجح يقلب المصدر الفعال في المختبر إلى PLATFORM_OVERRIDE",
    beforeFlip.source === "CODE_DEFAULT" &&
      beforeFlip.publishedText === null &&
      afterFlip.source === "PLATFORM_OVERRIDE" &&
      afterFlip.text === "أهلاً بك — كيف أساعدك؟",
  );

  // O9 (I) — RESET removes the override row so the code default is effective
  // again (a removal, never a copy of the default into the store).
  const resetResultO = await resetPublishedOverride(
    PLATFORM_ACTOR,
    "greeting.invite",
    flipDeps,
  );
  const resetState = mapEffectiveCopyState(
    getCopyEntry("greeting.invite")!,
    await resolveStoredCopy("greeting.invite", flipDeps),
    await getPublishedOverride("greeting.invite", flipDeps),
  );
  check(
    "O9 (I). إعادة التعيين تحذف صف التجاوز ويعود المصدر الفعال CODE_DEFAULT",
    resetResultO.success &&
      resetResultO.data.removed !== null &&
      resetState.source === "CODE_DEFAULT" &&
      resetState.text === getCopyEntry("greeting.invite")!.defaultText &&
      resetState.publishedText === null,
  );

  // O10 (J) — RESET is idempotent per the service contract: resetting again
  // (nothing stored) still succeeds with `removed: null`.
  const secondReset = await resetPublishedOverride(
    PLATFORM_ACTOR,
    "greeting.invite",
    flipDeps,
  );
  check(
    "O10 (J). إعادة التعيين متكررة الاستخدام: تكرارها على مفتاح بلا تجاوز ينجح بـ removed: null",
    secondReset.success && secondReset.data.removed === null,
  );

  // O11 (K) — history is shown NEWEST-FIRST: the service returns descending
  // rows and the UI projection preserves that order.
  const histDeps = makeFakeDeps();
  await savePublishedOverride(
    PLATFORM_ACTOR,
    "greeting.invite",
    "أهلاً ١",
    histDeps,
  );
  await savePublishedOverride(
    PLATFORM_ACTOR,
    "greeting.invite",
    "أهلاً ٢",
    histDeps,
  );
  await savePublishedOverride(
    PLATFORM_ACTOR,
    "greeting.invite",
    "أهلاً ٣",
    histDeps,
  );
  const hist = await listOverrideHistory(
    PLATFORM_ACTOR,
    "greeting.invite",
    25,
    histDeps,
  );
  const histItems = hist.success ? hist.data.items : [];
  const histView = mapHistoryItems(histItems);
  const newestFirst =
    hist.success &&
    histItems.length === 3 &&
    histItems.map((h) => h.resultText).join("|") ===
      "أهلاً ٣|أهلاً ٢|أهلاً ١" &&
    histView.length === 3 &&
    histView.every((v, i) => v.id === histItems[i]!.id) &&
    histView.map((v) => v.actionLabel).join("|") ===
      [
        COPY_OVERRIDE_ACTION_LABELS.PUBLISH,
        COPY_OVERRIDE_ACTION_LABELS.PUBLISH,
        COPY_OVERRIDE_ACTION_LABELS.PUBLISH,
      ].join("|");
  check(
    "O11 (K). السجل يُعرض من الأحدث إلى الأقدم، والإسقاط يحفظ الترتيب",
    newestFirst,
  );

  // O12 (L) — publish/reset actions produce history with the right transition
  // shape (previousText / resultText semantics).
  const auditDeps = makeFakeDeps();
  await savePublishedOverride(
    PLATFORM_ACTOR,
    "greeting.invite",
    "أهلاً ١",
    auditDeps,
  );
  await resetPublishedOverride(PLATFORM_ACTOR, "greeting.invite", auditDeps);
  const audit = await listOverrideHistory(
    PLATFORM_ACTOR,
    "greeting.invite",
    25,
    auditDeps,
  );
  const auditRows = audit.success ? audit.data.items : [];
  const publishRow = auditRows.find((h) => h.action === "PUBLISH");
  const resetRow = auditRows.find((h) => h.action === "RESET");
  check(
    "O12 (L). النشر وإعادة التعيين ينتجان سجلات بالشكل الصحيح (PUBLISH ثم RESET، resultText فارغ عند الحذف)",
    audit.success &&
      auditRows.length === 2 &&
      publishRow !== undefined &&
      publishRow.previousText === null &&
      publishRow.resultText === "أهلاً ١" &&
      publishRow.actorId === PLATFORM_ACTOR.userId &&
      resetRow !== undefined &&
      resetRow.previousText === "أهلاً ١" &&
      resetRow.resultText === null,
  );

  // O13 (M) — restoring a VALID historical value succeeds and becomes the
  // effective override, with a RESTORE audit row.
  const restoreDepsO = makeFakeDeps();
  await savePublishedOverride(
    PLATFORM_ACTOR,
    "greeting.invite",
    "أهلاً ١",
    restoreDepsO,
  );
  await savePublishedOverride(
    PLATFORM_ACTOR,
    "greeting.invite",
    "أهلاً ٢",
    restoreDepsO,
  );
  const restoreHist = await listOverrideHistory(
    PLATFORM_ACTOR,
    "greeting.invite",
    25,
    restoreDepsO,
  );
  const restoreRowsO = restoreHist.success ? restoreHist.data.items : [];
  const firstVersionId = restoreRowsO.find(
    (h) => h.resultText === "أهلاً ١",
  )!.id;
  const restoredO = await restoreOverride(
    PLATFORM_ACTOR,
    firstVersionId,
    restoreDepsO,
  );
  const restoredState = mapEffectiveCopyState(
    getCopyEntry("greeting.invite")!,
    await resolveStoredCopy("greeting.invite", restoreDepsO),
    await getPublishedOverride("greeting.invite", restoreDepsO),
  );
  check(
    "O13 (M). استرجاع قيمة تاريخية صالحة ينجح ويصبح التجاوز الفعال (مع سجل RESTORE)",
    restoredO.success &&
      restoredO.data.override.text === "أهلاً ١" &&
      restoredState.source === "PLATFORM_OVERRIDE" &&
      restoredState.text === "أهلاً ١" &&
      restoreDepsO.history.some((h) => h.action === "RESTORE"),
  );

  // O14 (N) — restoring a STALE/INVALID historical value is refused (the row
  // is re-validated against TODAY'S contract), and so is any historical value
  // for a PROTECTED key.
  const staleDeps = makeFakeDeps();
  staleDeps.history.push({
    id: "hist-stale",
    copyKey: TEMPLATE_KEY,
    action: "PUBLISH",
    // Valid when written, invalid today: the required {date} is gone.
    previousText: null,
    resultText: "المنشأة مغلقة — عُد لاحقاً.",
    actorId: PLATFORM_ACTOR.userId,
    createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
  });
  staleDeps.history.push({
    id: "hist-protected",
    copyKey: "handoff.human_request",
    action: "PUBLISH",
    previousText: null,
    resultText: getCopyEntry("handoff.human_request")!.defaultText,
    actorId: PLATFORM_ACTOR.userId,
    createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
  });
  const staleRestore = await restoreOverride(
    PLATFORM_ACTOR,
    "hist-stale",
    staleDeps,
  );
  const protectedRestore = await restoreOverride(
    PLATFORM_ACTOR,
    "hist-protected",
    staleDeps,
  );
  check(
    "O14 (N). استرجاع قيمة تاريخية باطلة/قديمة يُرفض (إعادة تحقق بعقد اليوم)، وكذلك استرجاع نص محمي",
    !staleRestore.success &&
      staleRestore.error.code === "INVALID_COPY" &&
      staleRestore.error.validationFailure?.code ===
        "MISSING_REQUIRED_PLACEHOLDER" &&
      !protectedRestore.success &&
      protectedRestore.error.code === "INVALID_COPY" &&
      protectedRestore.error.validationFailure?.code ===
        "PROTECTED_COPY_NOT_EDITABLE" &&
      !staleDeps.overrides.has(TEMPLATE_KEY) &&
      !staleDeps.overrides.has("handoff.human_request"),
  );

  // O15 (O) — a non-PLATFORM actor cannot mutate through the service: every
  // actor-gated primitive returns typed FORBIDDEN.
  const forbiddenDeps = makeFakeDeps();
  const forbiddenPublish = await savePublishedOverride(
    NON_PLATFORM_ACTOR,
    "greeting.invite",
    "مرحباً",
    forbiddenDeps,
  );
  const forbiddenReset = await resetPublishedOverride(
    NON_PLATFORM_ACTOR,
    "greeting.invite",
    forbiddenDeps,
  );
  const forbiddenList = await listOverrideHistory(
    NON_PLATFORM_ACTOR,
    "greeting.invite",
    25,
    forbiddenDeps,
  );
  const forbiddenRestore = await restoreOverride(
    NON_PLATFORM_ACTOR,
    "hist-none",
    forbiddenDeps,
  );
  check(
    "O15 (O). الجهة غير PLATFORM لا تستطيع أي عملية تعديل (FORBIDDEN لكل بدائية)",
    !forbiddenPublish.success &&
      forbiddenPublish.error.code === "FORBIDDEN" &&
      !forbiddenReset.success &&
      forbiddenReset.error.code === "FORBIDDEN" &&
      !forbiddenList.success &&
      forbiddenList.error.code === "FORBIDDEN" &&
      !forbiddenRestore.success &&
      forbiddenRestore.error.code === "FORBIDDEN" &&
      forbiddenDeps.history.length === 0 &&
      forbiddenDeps.overrides.size === 0,
  );

  // O16 (P) — a persistence failure is SURFACED (typed result, no throw) and
  // never corrupts the code default: the Lab degrades to the code default and
  // explains that persistence is unavailable.
  const outageResolution = await resolveStoredCopy(
    "greeting.invite",
    throwingDeps,
  );
  const outagePublished = await getPublishedOverride(
    "greeting.invite",
    throwingDeps,
  );
  const outageSave = await savePublishedOverride(
    PLATFORM_ACTOR,
    "greeting.invite",
    "أهلاً بك",
    throwingDeps,
  );
  const outageState = mapEffectiveCopyState(
    getCopyEntry("greeting.invite")!,
    outageResolution,
    outagePublished,
  );
  check(
    "O16 (P). فشل الثبات يظهر كنتيجة مُنمَّقة دون انهيار أو إفساد النص الافتراضي (الكود يبقى آمناً وقابلاً للاستخدام)",
    outageResolution.ok &&
      outageResolution.source === "CODE_DEFAULT" &&
      outageResolution.fallbackReason === "PERSISTENCE_UNAVAILABLE" &&
      !outagePublished.success &&
      outagePublished.error.code === "PERSISTENCE_FAILED" &&
      !outageSave.success &&
      outageSave.error.code === "PERSISTENCE_FAILED" &&
      outageState.text === getCopyEntry("greeting.invite")!.defaultText &&
      outageState.source === "CODE_DEFAULT" &&
      !outageState.persistenceAvailable &&
      outageState.publishedText === null &&
      outageState.editorSeed === getCopyEntry("greeting.invite")!.defaultText &&
      overrideErrorGuidance(outagePublished.error).length > 0,
  );

  // O17 (Q) — the registry stays byte-for-byte unchanged: the counts are
  // stable, the code default is still the fallback target, and the new
  // renderCopyText core renders the DEFAULT identically to renderCopy for
  // every key (the candidate-preview refactor changed no default render).
  const registryStable =
    COPY_REGISTRY.length === 48 &&
    count(COPY_REGISTRY, "EDITABLE_COPY") === 31 &&
    count(COPY_REGISTRY, "EDITABLE_TEMPLATE") === 13 &&
    count(COPY_REGISTRY, "PROTECTED_COPY") === 4;
  const renderEquivalenceFailures: string[] = [];
  for (const e of COPY_REGISTRY) {
    if (codeDefaultFor(e.key) !== e.defaultText)
      renderEquivalenceFailures.push(`${e.key}: default drift`);
    const demo = demoPlaceholderValues(e);
    const viaDefault = renderCopy(e.key, demo);
    const viaText = renderCopyText(e.key, e.defaultText, demo);
    if (
      viaDefault.ok !== viaText.ok ||
      (viaDefault.ok && viaText.ok && viaDefault.text !== viaText.text)
    )
      renderEquivalenceFailures.push(`${e.key}: render ≠ renderCopyText`);
  }
  check(
    "O17 (Q). السجل لم يتغير: 48 مفتاحاً (31/13/4)، الافتراضي هدف التراجع، وعرض الافتراضي عبر renderCopyText يطابق renderCopy حرفياً",
    registryStable && renderEquivalenceFailures.length === 0,
  );
  if (renderEquivalenceFailures.length > 0)
    for (const f of renderEquivalenceFailures) console.error(`   ${f}`);

  // O18 (R) — no unapproved reply path imports/invokes override resolution,
  // the engine is restricted strictly to read-only resolution, and no reply path
  // ever touches the Lab management boundary.
  const OTHER_REPLY_PATHS = [
    AI_FILE,
    CLARIFY_FILE,
    SELECTION_FILE,
    TELEGRAM_WEBHOOK_FILE,
    TELEGRAM_MANAGER_FILE,
    HANDOFF_POLICY_FILE,
    WHATSAPP_TRANSPORT_FILE,
    "src/features/conversations/server/booking-mapper.ts",
  ];
  const replyWired: string[] = [];
  for (const f of OTHER_REPLY_PATHS) {
    const src = read(f);
    if (
      OVERRIDE_SYMBOLS.test(src) ||
      /copy-lab-actions|CopyLabBrowser|CopyLabDetail|conversation-lab/.test(src)
    )
      replyWired.push(f);
  }
  const engineSource = read(
    "src/features/conversations/server/conversation-engine.ts",
  );
  if (
    MUTATING_OVERRIDE_SYMBOLS.test(engineSource) ||
    /copy-lab-actions|CopyLabBrowser|CopyLabDetail|conversation-lab/.test(
      engineSource,
    )
  ) {
    replyWired.push("src/features/conversations/server/conversation-engine.ts");
  }
  // Conversely the Lab boundary reaches ONLY the override service for data —
  // never a reply path, a transport, or a provider.
  const labTouchesReply =
    /@\/server\/transport|@\/server\/integrations\/(?!ai\/conversation-control)|conversation-ai|clarification|booking-selection/.test(
      labActionsSource,
    );
  check(
    "O18 (R). مسارات رد العميل محصورة: المحرك للقراءة فقط، البقية خالية تماماً، وحدّ المختبر لا يصل لأي مسار رد",
    replyWired.length === 0 && !labTouchesReply,
  );
  if (replyWired.length > 0)
    for (const f of replyWired) console.error(`   wired: ${f}`);

  // O19 (S) — the candidate preview stays provider/network/send-free: the
  // render core is pure (L1 already scans render.ts), it is deterministic on
  // a candidate, and the detail component previews the DRAFT through it (no
  // second substitution engine, no fetch/provider/transport in the Lab UI).
  // booking.business_closed declares exactly {date} (required): a candidate
  // carrying it renders fully, deterministically, with no leftover token.
  const candidate = "المنشأة مغلقة يوم {date} — اختر موعداً آخر.";
  const candidateValues = { date: "الخميس" };
  const repeatedCandidate = [0, 1, 2].map(() =>
    renderCopyText("booking.business_closed", candidate, candidateValues),
  );
  const firstCandidate = repeatedCandidate[0];
  const previewPure =
    firstCandidate !== undefined &&
    firstCandidate.ok &&
    firstCandidate.text === "المنشأة مغلقة يوم الخميس — اختر موعداً آخر." &&
    repeatedCandidate.every((r) => r.ok && r.text === firstCandidate.text) &&
    !firstCandidate.text.includes("{");
  // An unknown/undeclared token in a draft fails CLOSED with a typed
  // MALFORMED_PLACEHOLDER (the renderer never invents a value, never leaves a
  // live token through, and never throws); a brace-free candidate renders
  // verbatim. Both deterministic.
  const unknownToken = renderCopyText("greeting.invite", "hi {notAField}", {});
  const plainDraft = renderCopyText(
    "greeting.invite",
    "أهلاً بك، كيف أساعدك؟",
    {},
  );
  check(
    "O19 (S). معاينة المسودة خالية من المزود/الشبكة/الإرسال: حتمية عبر renderCopyText، والعنصر غير المعروف يفشل بأمان (MALFORMED_PLACEHOLDER)",
    previewPure &&
      !unknownToken.ok &&
      unknownToken.code === "MALFORMED_PLACEHOLDER" &&
      plainDraft.ok &&
      plainDraft.text === "أهلاً بك، كيف أساعدك؟" &&
      labUiSources.every(
        (src) =>
          !/\bfetch\s*\(/.test(src) &&
          !/openrouter|@\/server\/transport|@\/server\/integrations/.test(src),
      ),
  );

  // O20 — the UI guidance maps cover EVERY stable failure code of both
  // vocabularies (a drift guard: the maps only LABEL codes the contracts
  // already decide; they must never miss one).
  const VALIDATION_CODES: readonly string[] = [
    "UNKNOWN_COPY_KEY",
    "PROTECTED_COPY_NOT_EDITABLE",
    "INVALID_TEXT",
    "EMPTY_TEXT",
    "TEXT_TOO_LONG",
    "MALFORMED_PLACEHOLDER",
    "UNKNOWN_PLACEHOLDER",
    "PLACEHOLDER_NOT_ALLOWED",
    "MISSING_REQUIRED_PLACEHOLDER",
    "MARKER_REMOVED",
  ];
  const OVERRIDE_CODES: readonly string[] = [
    "FORBIDDEN",
    "UNKNOWN_COPY_KEY",
    "INVALID_COPY",
    "HISTORY_ENTRY_NOT_FOUND",
    "PERSISTENCE_FAILED",
  ];
  const missingValidation = VALIDATION_CODES.filter(
    (code) => !(code in COPY_VALIDATION_FAILURE_GUIDANCE),
  );
  const missingOverride = OVERRIDE_CODES.filter(
    (code) => !(code in COPY_OVERRIDE_ERROR_GUIDANCE),
  );
  check(
    "O20. خرائط الإرشاد تغطي كل رموز الفشل المستقرة للعقدين (لا تفوت رمزاً)",
    missingValidation.length === 0 && missingOverride.length === 0,
  );
  if (missingValidation.length > 0 || missingOverride.length > 0)
    console.error(
      `   missing guidance: ${[...missingValidation, ...missingOverride].join(", ")}`,
    );

  // ── P — UX-LAB-01D-P1: the REAL mounted component lifecycle (B2) ──────────
  //
  // Sections A–O are static / pure-function checks. They stayed green while
  // B1 was live (an editable entry stuck in first-open loading, with no
  // editor) because none of them mounts the React component. This check runs
  // the component-level regression — Vitest + jsdom mounting the real
  // `CopyLabDetail` against a mocked server boundary — which FAILS against the
  // pre-patch lifecycle. It needs no database, provider, or network: the
  // detail component's only seam is the Lab server boundary, which the test
  // mocks.
  const { spawnSync } = await import("node:child_process");
  const lifecycle = spawnSync(
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    ["test:copy-lab", "--no-color"],
    { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
  );
  check(
    "P1. دورة حياة فتح النص: التحميل يستقر، الحالة الفعالة والمحرر يظهران، والمحمي يبقى للقراءة فقط (اختبار مكوّن حقيقي)",
    lifecycle.status === 0,
  );
  if (lifecycle.status !== 0) {
    console.error(
      "   فشل اختبار دورة حياة المكوّن (mounted-component regression):",
    );
    console.error(
      (lifecycle.stdout ?? "").trim() || (lifecycle.stderr ?? "").trim(),
    );
  }

  // ── Q — Runtime coverage presentation & honest stored resolution ─────────
  const {
    getCopyRuntimeCoverage,
    isKeyConnectedToRuntime,
    getPublishFeedbackText,
    PLATFORM_OVERRIDE_SCOPE_NOTE: SCOPE_NOTE,
  } = await import("../src/features/platform/components/copy-lab-logic");

  // Q1: Exactly welcome.intro is connected; all other 47 keys are NOT connected
  const connectedKeys = COPY_REGISTRY.filter((e) =>
    isKeyConnectedToRuntime(e.key),
  ).map((e) => e.key);
  const coverageMap = new Map(
    COPY_REGISTRY.map((e) => [e.key, getCopyRuntimeCoverage(e.key)]),
  );
  check(
    "Q1. مفتاح welcome.intro فقط متصل بالمحادثة الحية وجميع المفاتيح الـ47 الأخرى غير متصلة",
    connectedKeys.length === 1 &&
      connectedKeys[0] === "welcome.intro" &&
      coverageMap.get("welcome.intro")?.isConnected === true &&
      coverageMap.get("welcome.intro")?.status === "CONNECTED" &&
      COPY_REGISTRY.every((e) =>
        e.key === "welcome.intro"
          ? coverageMap.get(e.key)?.isConnected === true
          : coverageMap.get(e.key)?.isConnected === false &&
            coverageMap.get(e.key)?.status === "NOT_CONNECTED",
      ),
  );

  // Q2: Arabic scope explanation for welcome.intro
  const welcomeCoverage = coverageMap.get("welcome.intro")!;
  const welcomeScopeOk =
    welcomeCoverage.scopeSummary.includes("/start") &&
    welcomeCoverage.scopeSummary.includes("مقدمة الترحيب") &&
    welcomeCoverage.scopeSummary.includes("لا يغيّر أزرار الخيارات") &&
    welcomeCoverage.scopeSummary.includes("استئناف الحجز النشط") &&
    welcomeCoverage.operationalNote.includes("الرجوع التلقائي للنص الافتراضي") &&
    welcomeCoverage.operationalNote.includes("لا يضمن ولا يثبت تسليم مزود الرسائل");
  check(
    "Q2. نطاق welcome.intro موضح بالعربية: مسار /start خامل/جديد فقط، لا يغير الأزرار ولا استئناف الحجز، وله بديل آمن دون ادعاء تسليم المزود",
    welcomeScopeOk,
  );

  // Q3: Arabic explanation for unwired keys
  const unwiredSample = coverageMap.get("greeting.invite")!;
  const unwiredScopeOk =
    unwiredSample.scopeSummary.includes("غير متصل بمحرك المحادثة الحية بعد") &&
    unwiredSample.scopeSummary.includes("لا يغيّر الردود الحية للعملاء") &&
    unwiredSample.operationalNote.includes("التعديل والمعاينة وسجل التعديلات والاسترجاع");
  check(
    "Q3. المفاتيح غير المربوطة توضح صراحة أن الحفظ/النشر لا يغير الردود الحية مع الحفاظ على التحرير والمعاينة والسجل",
    unwiredScopeOk,
  );

  // Q4: Protection classification remains independent of runtime coverage
  const protectedEntries = COPY_REGISTRY.filter(
    (e) => e.classification === "PROTECTED_COPY",
  );
  check(
    "Q4. التصنيف المحمي مستقل تماماً عن حالة التوصيل بالمحادثة (المحمي محمي بصرف النظر عن الربط)",
    protectedEntries.length === 4 &&
      protectedEntries.every(
        (e) =>
          canEditCopy(e) === false &&
          coverageMap.get(e.key)?.isConnected === false,
      ),
  );

  // Q5: Platform override scope explained as platform-wide
  check(
    "Q5. توضيح أن تجاوزات المنصة تسري على مستوى كافة المنشآت وليست مخصصة لمنشأة فردية",
    SCOPE_NOTE.includes("على مستوى كافة المنشآت في المنصة ككل") &&
      SCOPE_NOTE.includes("وليست مخصصة لمنشأة بعينها"),
  );

  // Q6: Honest publish feedback text
  const welcomePublishFeedback = getPublishFeedbackText(
    "welcome.intro",
    "PLATFORM_OVERRIDE",
  );
  const unwiredPublishFeedback = getPublishFeedbackText(
    "greeting.invite",
    "PLATFORM_OVERRIDE",
  );
  check(
    "Q6. رسائل تأكيد النشر صريحة: تفرق بين المفتاح المتصل وغير المتصل وتوضح دقة الحالة المخزنة",
    welcomePublishFeedback.includes("مسار /start") &&
      welcomePublishFeedback.includes("لا يعني ذلك التحقق من تسليم المزود") &&
      unwiredPublishFeedback.includes("غير متصل بالمحادثة الحية بعد") &&
      unwiredPublishFeedback.includes("لن تتغير ردود العملاء الحية حالياً"),
  );

  // ── Report ───────────────────────────────────────────────────────────────
  let failed = 0;
  for (const { label, pass } of checks) {
    if (pass) console.log(`✔ ${label}`);
    else {
      console.error(`✘ ${label}`);
      failed += 1;
    }
  }
  if (failed > 0) {
    console.error(`\nفشل ${failed} من ${checks.length} فحص.`);
    process.exit(1);
  }
  console.log(
    `\nسجل نسخ المحادثة سليم وخامل: ${checks.length}/${checks.length} فحص ناجح — ${COPY_REGISTRY.length} مفتاح canonical (${count(COPY_REGISTRY, "EDITABLE_COPY")} قابل للتعديل، ${count(COPY_REGISTRY, "EDITABLE_TEMPLATE")} قالب، ${count(COPY_REGISTRY, "PROTECTED_COPY")} محمي).`,
  );

  function count(
    registry: readonly { classification: string }[],
    classification: string,
  ): number {
    return registry.filter((e) => e.classification === classification).length;
  }
}

main().catch((error: Error) => {
  console.error(`فشل غير متوقع: ${error.message}`);
  if (error.stack) console.error(error.stack);
  process.exit(1);
});
