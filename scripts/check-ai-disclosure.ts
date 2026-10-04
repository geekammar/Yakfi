/**
 * FlowPilot — CUSTOMER DISCLOSURE BOUNDARY check (PROMPT-B03).
 *
 * Offline, in-memory verification of the B-03 enforcement boundary (no DB, no
 * network, no LLM, no API tokens, no secrets):
 *
 *   1.  a PUBLIC fact can be disclosed (a FAQ reply backed by the PUBLIC
 *       knowledge store is emitted);
 *   2.  a PUBLIC fact stays tenant-scoped — another Business's PUBLIC fact
 *       can never back a reply;
 *   3.  a CONDITIONAL fact is disclosed only when its task allows it
 *       (domain availability in on a booking ask, refused off-task);
 *   4.  an INTERNAL fact never becomes customer-visible (a reply backed by an
 *       included-but-INTERNAL fact is refused);
 *   5.  a FORBIDDEN fact never becomes customer-visible (refused even in a
 *       synthetic "leaked into context" ledger);
 *   6.  credentialsRef never becomes customer-visible;
 *   7.  credentialsRef stays a REFERENCE, never a credential value;
 *   8.  provenance metadata never becomes customer-visible;
 *   9.  policy names / classification never become customer-visible;
 *  10.  cross-tenant facts cannot leak into a reply;
 *  11.  missing provenance fails closed (no support ⇒ human handoff);
 *  12.  conflicting classification is never resolved by guessing;
 *  13.  an AI failure and a refused reply both fall back to the EXISTING
 *       human handoff (NEED_HUMAN / AI_HANDOFF), and the refused content is
 *       never persisted nor sent;
 *  14.  a safe AI answer is emitted byte-for-byte unchanged;
 *  15.  no customer-visible Meta/provider jargon is introduced;
 *  16.  the boundary is deterministic (same input ⇒ same output);
 *  17.  no raw token/secret can appear in the emitted response;
 *  18.  no INTERNAL operational metadata reaches the customer output;
 *  19.  durationMinutes is not disclosed merely because it exists internally;
 *  20.  the customer's own message content is preserved where appropriate.
 *
 * Run: pnpm check:ai-disclosure
 */

// Imported DELIBERATELY before any process.env assignment: the boundary must
// load with zero environment, database, provider or credential dependencies.
// (The conversation engine is imported lazily inside main(), after the pure
// boundary checks have already run with no env at all.)
import * as fs from "node:fs";
import * as path from "node:path";

import { buildAiContext } from "../src/features/conversations/server/ai-context-builder";
import type { ContextFactRecord } from "../src/features/conversations/server/ai-context-builder";
import type {
  AiRequest,
  AiResponse,
} from "../src/features/conversations/server/ai-contract";
import * as disclosureModule from "../src/features/conversations/server/ai-disclosure";
import {
  DISCLOSURE_REFUSAL_REASONS,
  KNOWLEDGE_FREE_REPLY_INTENTS,
  TASK_SUPPORT_FAMILIES,
  enforceDisclosure,
} from "../src/features/conversations/server/ai-disclosure";
import {
  AI_MUST_NOT_RESOLVE_CONFLICTS,
  mostRestrictive,
} from "../src/lib/ai-knowledge-visibility";
import type { Business, ConversationStatus } from "../src/types/domain";

export {};

type Check = { label: string; pass: boolean };

const checks: Check[] = [];
function check(label: string, pass: boolean): void {
  checks.push({ label, pass });
}
function eq<T>(actual: T, expected: T): boolean {
  return actual === expected;
}
function deepEq<T>(actual: T, expected: T): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

const TENANT_A = "biz-aaaaaaaaaaaaaaaaaaaa";
const TENANT_B = "biz-bbbbbbbbbbbbbbbbbbbb";
const WHATSAPP_NUMBER = "+201000000000";
const RAW_TOKEN = "sk-live-FAKESECRETAAAAAAAAAAAAAAAA"; // test fixture, never real
const REFERENCE = "fp:deadbeef-0000-4000-8000-000000000000";
const SAFE_ANSWER = "سعر التنظيف ٣٠٠ جنيه.";
const LEAKY_REPLY = "جلسة التنظيف مدتها 30 دقيقة والسعر 500 جنيه.";

// ─── Fixture builders ────────────────────────────────────────────────────────

type BuiltContext = ReturnType<typeof buildAiContext>;
type ContextSources = Parameters<typeof buildAiContext>[0]["sources"];
type BusinessSources = ContextSources["business"];
type ServiceFact = ContextSources["services"][number];

function businessSources(
  overrides: Partial<BusinessSources> = {},
): BusinessSources {
  return {
    businessId: TENANT_A,
    name: "عيادة النور لطب الأسنان",
    about: "عيادة متخصصة في طب وتجميل الأسنان",
    whatsappNumber: "+201000000000",
    faqs: [{ question: "كم سعر تنظيف الأسنان؟", answer: SAFE_ANSWER }],
    cancellationPolicy: "الإلغاء قبل ٢٤ ساعة.",
    workingHours: { sat: { open: "10:00", close: "18:00", closed: false } },
    slotDurationMinutes: 30,
    confirmationMode: "manual",
    timezone: "Africa/Cairo",
    vertical: "dental",
    city: "القاهرة",
    ...overrides,
  };
}

function serviceFact(
  name: string,
  extra: Partial<ServiceFact> = {},
): ServiceFact {
  return {
    id: `svc-${name}`,
    businessId: TENANT_A,
    name,
    description: null,
    durationMinutes: 30,
    ...extra,
  };
}

function makeSources(
  message: string,
  overrides: Partial<ContextSources> = {},
): ContextSources {
  return {
    business: businessSources(),
    services: [serviceFact("تنظيف الأسنان")],
    conversation: {
      status: "AI_ACTIVE" as ConversationStatus,
      recentMessages: [
        { senderType: "CUSTOMER", content: "السلام عليكم" },
        { senderType: "AI", content: "أهلاً بك!" },
      ],
    },
    message,
    ...overrides,
  };
}

function emptyExtraction() {
  return { service: null, provider: null, date: null, timePreference: null };
}

/** A self-authored reply (the only reply shape the assistant emits today). */
function replyOf(intent: AiResponse["intent"], content: string): AiResponse {
  return {
    intent,
    action: "reply",
    content,
    extraction: emptyExtraction(),
    handoffReason: null,
    summary: null,
  };
}

function record(
  built: BuiltContext,
  key: string,
): ContextFactRecord | undefined {
  return built.facts.find((fact) => fact.key === key);
}

/** Build a context + gate a reply through the boundary, in one step. */
function gateReply(input: {
  message: string;
  sources?: Partial<ContextSources>;
  reply: AiResponse;
  scope?: { businessId: string };
}): BuiltContext & { decision: ReturnType<typeof enforceDisclosure> } {
  const built = buildAiContext({
    scope: input.scope ?? { businessId: TENANT_A },
    sources: makeSources(input.message, input.sources ?? {}),
  });
  const decision = enforceDisclosure({
    response: input.reply,
    context: { request: built.request, facts: built.facts },
  });
  return { ...built, decision };
}

async function main(): Promise<void> {
  // ── 0. The boundary is pure, structural, and holds no secrets ────────────
  const gateDir = path.resolve(
    process.cwd(),
    "src/features/conversations/server/ai-disclosure",
  );
  const gateSources = fs
    .readdirSync(gateDir)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => fs.readFileSync(path.join(gateDir, file), "utf8"))
    .join("\n");
  check(
    "الحدّ لا يصل process.env ولا قاعدة البيانات ولا بيانات الاعتماد",
    !/process\.env\s*[.[\]]/.test(gateSources) &&
      !/@\/server\/db|@\/generated\/prisma|prisma\/client/.test(gateSources) &&
      !/credentialsRef|encryptedValue|secretRef|CREDENTIAL_MASTER_KEY/.test(
        gateSources,
      ),
  );
  check(
    "الحدّ ليس مصحّح نصوص: لا قائمة كلمات ممنوعة ولا مسح قيم",
    !("redactText" in disclosureModule) &&
      !("forbiddenWords" in disclosureModule) &&
      !("blacklist" in disclosureModule) &&
      !("sanitize" in disclosureModule) &&
      typeof disclosureModule.enforceDisclosure === "function",
  );
  check(
    "الحدّ لا يحمل قناة مزود ولا Meta (لا أسماء مزودين في النص)",
    !/graph\.facebook\.com|WhatsApp Cloud|whatsapp-business|Atria|OpenRouter|AgentRouter/i.test(
      gateSources,
    ),
  );
  check(
    "أسباب الرفض مُعرَّفة كنوع محدد (وليست نصاً حراً)",
    deepEq(
      [...DISCLOSURE_REFUSAL_REASONS].sort(),
      [
        "EXCLUDED_FROM_CONTEXT",
        "FORBIDDEN_FACT_IN_CONTEXT",
        "NOT_DISCLOSABLE",
        "UNAVAILABLE_IN_REQUEST",
      ].sort(),
    ),
  );
  check(
    "لكل نيّة عائلة دعم واحدة مُسجَّلة (لا اشتقاق داخل الحدّ)",
    deepEq(
      Object.keys(TASK_SUPPORT_FAMILIES).sort(),
      [
        "AMBIGUOUS",
        "AVAILABILITY",
        "BOOKING",
        "CANCELLATION",
        "FAQ",
        "GREETING",
        "HUMAN_REQUEST",
        "RESCHEDULE",
      ].sort(),
    ),
  );
  check(
    "GREETING نيّة حرة من المعرفة: تُفصح عنها بلا عائلة دعم (لا حقيقة تسندها)",
    deepEq(TASK_SUPPORT_FAMILIES["GREETING"], {
      family: null,
      channel: null,
    }) &&
      KNOWLEDGE_FREE_REPLY_INTENTS.length === 1 &&
      KNOWLEDGE_FREE_REPLY_INTENTS[0] === "GREETING",
  );

  // ── 1 / 14 / 20. PUBLIC disclosure, unchanged answer, message preserved ───
  const faqTurn = gateReply({
    message: "كم سعر تنظيف الأسنان؟",
    reply: replyOf("FAQ", SAFE_ANSWER),
  });
  check(
    "1. حقيقة عامة (مخزن الأسئلة) تُفصح عنها — الرد مُصرَّح",
    eq(faqTurn.decision.kind, "disclosed") &&
      deepEq(
        faqTurn.decision.kind === "disclosed" ? faqTurn.decision.support : [],
        ["business.faqs"],
      ),
  );
  check(
    "14. رد آمن يُمرَّر كما هو تماماً (الحدّ لا يحرّف النص)",
    faqTurn.decision.kind === "disclosed" &&
      eq(faqTurn.decision.response.content, SAFE_ANSWER) &&
      deepEq(faqTurn.decision.response, replyOf("FAQ", SAFE_ANSWER)),
  );
  check(
    "20. رسالة العميل تُحفظ كما هي في الطلب (حقيقة عامة)",
    eq(faqTurn.request.message, "كم سعر تنظيف الأسنان؟") &&
      eq(record(faqTurn, "customer.message")?.visibility, "PUBLIC") &&
      eq(record(faqTurn, "customer.message")?.included, true),
  );

  // ── 1b/1c. PROMPT-AI-ARCH-15: about + service-description channels ────────
  // A business-profile FAQ reply is newly backable by the task-gated PUBLIC
  // business-about channel — here with an EMPTY FAQ store, so the store cannot
  // be the support. It stays refused when the turn is not business-info.
  const aboutTurn = gateReply({
    message: "احكيلي عن العيادة",
    sources: { business: businessSources({ faqs: [] }) },
    reply: replyOf("FAQ", "عيادة متخصصة في طب وتجميل الأسنان"),
  });
  check(
    "1b. رد FAQ مدعوم بقناة «عن المنشأة» (مخزن فارغ) — يُفصح",
    eq(aboutTurn.decision.kind, "disclosed") &&
      deepEq(
        aboutTurn.decision.kind === "disclosed"
          ? aboutTurn.decision.support
          : [],
        ["business.about"],
      ) &&
      eq(aboutTurn.request.businessAbout, "عيادة متخصصة في طب وتجميل الأسنان"),
  );
  const aboutOffTaskTurn = gateReply({
    message: "عايز أحجز موعد",
    sources: { business: businessSources({ faqs: [] }) },
    reply: replyOf("FAQ", "عيادة متخصصة في طب وتجميل الأسنان"),
  });
  check(
    "1c. قناة «عن المنشأة» غير محمولة في دور غير ذي صلة — رفض (لا اختراع)",
    eq(aboutOffTaskTurn.decision.kind, "requires-human") &&
      eq(aboutOffTaskTurn.request.businessAbout, undefined),
  );

  // A service-detail FAQ reply is backable by the task-gated PUBLIC service
  // description channel; absent descriptions/channels still refuse.
  const descriptionTurn = gateReply({
    message: "تنظيف الأسنان بيعملوا فيه إيه؟",
    sources: {
      business: businessSources({ faqs: [] }),
      services: [
        serviceFact("تنظيف الأسنان", { description: "تنظيف وتلميع الأسنان" }),
      ],
    },
    reply: replyOf("FAQ", "تنظيف وتلميع الأسنان"),
  });
  check(
    "1d. رد FAQ مدعوم بقناة «وصف الخدمة» (مخزن فارغ) — يُفصح",
    eq(descriptionTurn.decision.kind, "disclosed") &&
      deepEq(
        descriptionTurn.decision.kind === "disclosed"
          ? descriptionTurn.decision.support
          : [],
        ["service.description"],
      ) &&
      eq(
        descriptionTurn.request.services[0]?.description,
        "تنظيف وتلميع الأسنان",
      ),
  );
  const descriptionOffTaskTurn = gateReply({
    message: "عايز أحجز موعد",
    sources: {
      business: businessSources({ faqs: [] }),
      services: [
        serviceFact("تنظيف الأسنان", { description: "تنظيف وتلميع الأسنان" }),
      ],
    },
    reply: replyOf("FAQ", "تنظيف وتلميع الأسنان"),
  });
  check(
    "1e. قناة «وصف الخدمة» غير محمولة في دور غير ذي صلة — رفض",
    eq(descriptionOffTaskTurn.decision.kind, "requires-human") &&
      descriptionOffTaskTurn.request.services.every(
        (service) => service.description === undefined,
      ),
  );
  const missingDescriptionTurn = gateReply({
    message: "حشو الأسنان بيعملوا فيه إيه؟",
    sources: {
      business: businessSources({ faqs: [] }),
      services: [serviceFact("حشو الأسنان")], // description null
    },
    reply: replyOf("FAQ", "حشو تجميلي"),
  });
  check(
    "1f. وصف مفقود على دور تفاصيل = تحويل لبشري (لا اختراع وصف)",
    eq(missingDescriptionTurn.decision.kind, "requires-human") &&
      missingDescriptionTurn.request.services.every(
        (service) => service.description === undefined,
      ),
  );

  // ── 1g/1h/1i/1j. PROMPT-AI-OPS-20: service-catalog NAME channel ────────────
  // A services-list FAQ reply is backable by the carried PUBLIC catalog NAMES
  // — with an EMPTY FAQ store and NO descriptions/prices, so no other channel
  // can be the support. Before this channel existed, an answerable
  // services-list reply was refused (UNAVAILABLE_IN_REQUEST) even though B-01
  // marks a service name "AI may mention" and B-02 carries it: the gate had
  // no channel that recognized a carried catalog. This is the pilot defect
  // ("ايه الخدمات اللي عندكم؟" → NEED_HUMAN despite a real, exposed catalog).
  const catalogTurn = gateReply({
    message: "ايه الخدمات اللي عندكم؟",
    sources: {
      business: businessSources({ faqs: [], about: "" }),
      services: [serviceFact("تنظيف الأسنان"), serviceFact("حشو الأسنان")],
    },
    reply: replyOf("FAQ", "نقدم تنظيف الأسنان وحشو الأسنان."),
  });
  check(
    "1g. رد «قائمة الخدمات» مدعوم بأسماء الكتالوج المحمّلة (مخزن فارغ) — يُفصح ويبقى AI_ACTIVE",
    eq(catalogTurn.decision.kind, "disclosed") &&
      deepEq(
        catalogTurn.decision.kind === "disclosed"
          ? catalogTurn.decision.support
          : [],
        ["service.name"],
      ) &&
      eq(record(catalogTurn, "service.name")?.visibility, "PUBLIC") &&
      eq(record(catalogTurn, "service.name")?.included, true) &&
      eq(record(catalogTurn, "service.name")?.disclosable, true) &&
      eq(catalogTurn.request.services.length, 2),
  );
  // Arabic morphology: the definite-article form «الخدمات» and the bare plural
  // both arm the family (relevance matches on non-affix-stripped tokens, so both
  // surface forms must be recognized).
  const definiteCatalogTurn = gateReply({
    message: "ما هي الخدمات المتاحة لديكم؟",
    sources: {
      business: businessSources({ faqs: [], about: "" }),
      services: [serviceFact("تنظيف الأسنان")],
    },
    reply: replyOf("FAQ", "نقدم تنظيف الأسنان."),
  });
  check(
    "1g-bis. صيغة «الخدمات» بالتعريف تُفعّل عائلة أسماء الكتالوج أيضاً",
    eq(definiteCatalogTurn.decision.kind, "disclosed") &&
      eq(
        definiteCatalogTurn.decision.kind === "disclosed"
          ? definiteCatalogTurn.decision.support[0]
          : undefined,
        "service.name",
      ),
  );
  // The name channel is armed ONLY on a catalog-listing turn. On an unrelated
  // turn the names stay in the base catalog (the model may still use them for
  // booking) but cannot back a self-authored reply — the disclosure backstop
  // stays intact for non-catalog questions.
  const catalogOffTaskTurn = gateReply({
    message: "عايز أحجز موعد",
    sources: {
      business: businessSources({ faqs: [], about: "" }),
      services: [serviceFact("تنظيف الأسنان")],
    },
    reply: replyOf("FAQ", "نقدم تنظيف الأسنان."),
  });
  check(
    "1h. عائلة أسماء الكتالوج غير مسلّحة في دور غير الكتالوج — رفض (تبقى الأسماء في الكتالوج)",
    eq(catalogOffTaskTurn.decision.kind, "requires-human") &&
      eq(record(catalogOffTaskTurn, "service.name")?.included, false) &&
      eq(catalogOffTaskTurn.request.services.length, 1),
  );
  // The backstop that the fix had to preserve: on a NON-catalog turn (a
  // location/hours-style ask) a self-authored reply is still refused even
  // though the catalog names are carried — so an invented location or hours
  // answer can never leak through the catalog channel.
  const nonCatalogLeakTurn = gateReply({
    message: "المركز فين؟ ومواعيد العمل ايه؟",
    sources: {
      business: businessSources({ faqs: [], about: "" }),
      services: [serviceFact("تنظيف الأسنان")],
    },
    reply: replyOf("FAQ", "المركز في القاهرة ونعمل من 10 لـ 6."),
  });
  check(
    "1i. رد موقع/مواعيد على دور غير الكتالوج يُرفض رغم حمل الأسماء (لا تسرّب معلومات مخترعة)",
    eq(nonCatalogLeakTurn.decision.kind, "requires-human") &&
      eq(record(nonCatalogLeakTurn, "service.name")?.included, false),
  );
  // An EMPTY catalog on a catalog-listing turn still refuses — the channel
  // proves a name is actually carried, so a service can never be invented.
  const emptyCatalogTurn = gateReply({
    message: "ايه الخدمات اللي عندكم؟",
    sources: {
      business: businessSources({ faqs: [], about: "" }),
      services: [],
    },
    reply: replyOf("FAQ", "نقدم تنظيف الأسنان."),
  });
  check(
    "1j. كتالوج فارغ على دور قائمة خدمات = تحويل لبشري (لا اختراع خدمة)",
    eq(emptyCatalogTurn.decision.kind, "requires-human") &&
      eq(emptyCatalogTurn.request.services.length, 0),
  );

  // ── 3. CONDITIONAL: disclosed only when its task allows it ───────────────
  const bookingTurn = gateReply({
    message: "عايز أحجز موعد",
    sources: {
      availability: [{ date: "2026-09-28", slots: ["10:00", "11:00"] }],
    },
    reply: replyOf("AVAILABILITY", "المواعيد المتاحة: 10:00 أو 11:00."),
  });
  check(
    "3a. حقيقة شرطية (التوفر) تُفصح عند صلة المهمة بها",
    eq(bookingTurn.decision.kind, "disclosed") &&
      eq(record(bookingTurn, "domain.availability")?.included, true) &&
      eq(record(bookingTurn, "domain.availability")?.disclosable, true) &&
      eq(bookingTurn.request.availability?.[0]?.date, "2026-09-28"),
  );
  // Same availability supplied, but the turn is NOT a booking ask and the
  // knowledge store carries nothing → the fact is excluded, so a reply
  // declaring it cannot be emitted.
  const offTaskTurn = gateReply({
    message: "بماذا تفعلون؟",
    sources: {
      business: businessSources({ faqs: [] }),
      availability: [{ date: "2026-09-28", slots: ["10:00"] }],
    },
    reply: replyOf("AVAILABILITY", "المواعيد المتاحة: 10:00."),
  });
  check(
    "3b. حقيقة شرطية بلا صلة بالمهمة لا تُفصح (استبعاد، لا تحميل استباقي)",
    eq(offTaskTurn.decision.kind, "requires-human") &&
      eq(record(offTaskTurn, "domain.availability")?.included, false) &&
      eq(
        record(offTaskTurn, "domain.availability")?.omissionReason,
        "NOT_TASK_RELEVANT",
      ),
  );

  // ── 4. INTERNAL never becomes customer-visible ───────────────────────────
  const internalLedger: ContextFactRecord[] = [
    {
      key: "business.faqs",
      source: "BUSINESS_FAQ_STORE",
      visibility: "INTERNAL",
      included: true,
      disclosable: false,
    },
  ];
  const requestWithStore: AiRequest = {
    ...faqTurn.request,
    faqs: [{ question: "سؤال", answer: "جواب" }],
  };
  const internalDecision = enforceDisclosure({
    response: replyOf("FAQ", "نعمل من 10 إلى 6."),
    context: { request: requestWithStore, facts: internalLedger },
  });
  check(
    "4a. حقيقة داخلية (مضمَّنة في السياق) لا تصل العميل — رفض",
    eq(internalDecision.kind, "requires-human") &&
      eq(
        internalDecision.kind === "requires-human"
          ? internalDecision.reason
          : null,
        "NOT_DISCLOSABLE",
      ),
  );
  check(
    "4b. حالة المحادثة داخلية: تصل السياق لكنها غير قابلة للذكر",
    eq(record(faqTurn, "conversation.status")?.visibility, "INTERNAL") &&
      eq(record(faqTurn, "conversation.status")?.included, true) &&
      eq(record(faqTurn, "conversation.status")?.disclosable, false),
  );

  // ── 5. FORBIDDEN never becomes customer-visible ──────────────────────────
  const forbiddenLedger: ContextFactRecord[] = [
    {
      key: "whatsapp.credentialsRef",
      source: "PLATFORM_CONFIG",
      visibility: "FORBIDDEN",
      included: true, // impossible by construction — defense in depth
      disclosable: false,
    },
  ];
  const forbiddenDecision = enforceDisclosure({
    response: replyOf("FAQ", REFERENCE),
    context: { request: requestWithStore, facts: forbiddenLedger },
  });
  check(
    "5a. حقيقة ممنوعة (حتى لو تسربت للسياق) لا تصل العميل — إغلاق باب",
    eq(forbiddenDecision.kind, "requires-human") &&
      eq(
        forbiddenDecision.kind === "requires-human"
          ? forbiddenDecision.reason
          : null,
        "FORBIDDEN_FACT_IN_CONTEXT",
      ),
  );
  check(
    "5b. المرشح الممنوع يُرفض عند التسجيل أصلاً (B-01/B-02)",
    eq(
      record(faqTurn, "business.id")?.exclusionReason,
      "FORBIDDEN_BY_POLICY",
    ) && eq(record(faqTurn, "business.id")?.included, false),
  );

  // ── 6 / 7 / 17. credentialsRef + raw secrets never customer-visible ──────
  const poisonedBusiness = businessSources({
    faqs: [{ question: "كم السعر؟", answer: SAFE_ANSWER }],
  });
  const poisonedRecord = poisonedBusiness as Record<string, unknown>;
  poisonedRecord.credentialsRef = REFERENCE;
  poisonedRecord.encryptedValue = "v1:AAABBBCCC==";
  poisonedRecord.rawToken = RAW_TOKEN;
  const poisonedTurn = gateReply({
    message: "كم السعر؟",
    sources: { business: poisonedBusiness },
    reply: replyOf("FAQ", SAFE_ANSWER),
  });
  const poisonedRequestJson = JSON.stringify(poisonedTurn.request);
  const poisonedResponseJson = JSON.stringify(
    poisonedTurn.decision.kind === "disclosed"
      ? poisonedTurn.decision.response
      : null,
  );
  check(
    "6. credentialsRef لا يصل مخرجات العميل أبداً",
    eq(poisonedTurn.decision.kind, "disclosed") &&
      !poisonedRequestJson.includes("credentialsRef") &&
      !poisonedRequestJson.includes(REFERENCE) &&
      !poisonedResponseJson.includes(REFERENCE),
  );
  check(
    "7. المرجع يبقى مرجعاً (لا قيمة سرية في الطلب أو الرد أو الدفتر)",
    !poisonedRequestJson.includes("AAABBBCCC") &&
      !poisonedRequestJson.includes(RAW_TOKEN) &&
      !poisonedResponseJson.includes(RAW_TOKEN) &&
      !JSON.stringify(poisonedTurn.facts).includes(RAW_TOKEN),
  );

  // ── 8 / 9. provenance + policy names never customer-visible ──────────────
  check(
    "8. الرد المُفصح عنه لا يحمل مصدر/رؤية/مستأجر (المصدر سقط في B-02)",
    poisonedTurn.decision.kind === "disclosed" &&
      deepEq(
        Object.keys(poisonedTurn.decision.response).sort(),
        [
          "action",
          "content",
          "extraction",
          "handoffReason",
          "intent",
          "summary",
        ].sort(),
      ) &&
      !poisonedRequestJson.includes("visibility") &&
      !poisonedRequestJson.includes("provenance") &&
      !poisonedRequestJson.includes(TENANT_A),
  );
  check(
    "9. أسباب الرفض وأسماء السياسة لا تظهر في رد العميل",
    DISCLOSURE_REFUSAL_REASONS.every(
      (reason) => !SAFE_ANSWER.includes(reason),
    ) &&
      !/FORBIDDEN|INTERNAL|CONDITIONAL|PUBLIC|DISCLOSABLE|EXCLUDED/.test(
        SAFE_ANSWER,
      ) &&
      (forbiddenDecision.kind === "requires-human"
        ? !("content" in forbiddenDecision)
        : false),
  );

  // ── 2 / 10. tenant scoping + cross-tenant leak prevention ────────────────
  const crossTurn = gateReply({
    message: "ما هي خدماتكم؟",
    scope: { businessId: TENANT_A },
    sources: {
      business: businessSources({ faqs: [] }),
      services: [
        serviceFact("خدمة المنشأة الأخرى", {
          id: "svc-b1",
          businessId: TENANT_B,
        }),
      ],
      conversation: { status: "AI_ACTIVE", recentMessages: [] },
    },
    reply: replyOf("FAQ", "نقدم خدمة المنشأة الأخرى."),
  });
  check(
    "2/10. حقائق المنشأة الأخرى العامة لا تسند رداً (استبعاد، لا تسريب)",
    eq(crossTurn.decision.kind, "requires-human") &&
      eq(
        record(crossTurn, "service.name:خدمة المنشأة الأخرى")?.exclusionReason,
        "UNPROVEN_TENANT",
      ) &&
      !crossTurn.request.services.some(
        (service) => service.name === "خدمة المنشأة الأخرى",
      ),
  );

  // ── 11. missing provenance fails closed ──────────────────────────────────
  const unprovenTurn = gateReply({
    message: "كم السعر؟",
    sources: {
      business: businessSources({ faqs: [] }),
      services: [serviceFact("خدمة بلا مصدر", { id: "svc-x", businessId: "" })],
    },
    reply: replyOf("FAQ", "سعر الخدمة 100 جنيه."),
  });
  check(
    "11a. غياب إثبات المستأجر يُغلق الباب (لا دعم ⇒ تحويل بشري)",
    eq(unprovenTurn.decision.kind, "requires-human") &&
      eq(
        record(unprovenTurn, "service.name:خدمة بلا مصدر")?.exclusionReason,
        "UNPROVEN_TENANT",
      ),
  );
  const emptyScopeTurn = gateReply({
    message: "كم السعر؟",
    scope: { businessId: "" },
    reply: replyOf("FAQ", SAFE_ANSWER),
  });
  check(
    "11b. نطاق فارغ ⇒ لا حقيقة مضمَّنة ⇒ أي رد يُرفض",
    emptyScopeTurn.facts.every((fact) => fact.included === false) &&
      eq(emptyScopeTurn.decision.kind, "requires-human"),
  );
  const emptyLedgerDecision = enforceDisclosure({
    response: replyOf("FAQ", SAFE_ANSWER),
    context: { request: requestWithStore, facts: [] },
  });
  check(
    "11c. دفتر غائب ⇒ رفض (لا تخمين)",
    eq(emptyLedgerDecision.kind, "requires-human") &&
      eq(
        emptyLedgerDecision.kind === "requires-human"
          ? emptyLedgerDecision.reason
          : null,
        "EXCLUDED_FROM_CONTEXT",
      ),
  );

  // ── 12. conflicts are never resolved by guessing ────────────────────────
  check(
    "12a. التصنيف المتضارب يحل للأكثر تقييداً (B-01) — والحدّ يلتزمه",
    eq(AI_MUST_NOT_RESOLVE_CONFLICTS, true) &&
      eq(mostRestrictive(["PUBLIC", "INTERNAL"]), "INTERNAL") &&
      eq(mostRestrictive(["PUBLIC", "CONDITIONAL", "FORBIDDEN"]), "FORBIDDEN"),
  );
  const conflictDecision = enforceDisclosure({
    response: replyOf("FAQ", "الجواب حسب المصدر الأكثر تقييداً."),
    // The merged outcome of a conflict is the MOST restrictive level (B-01),
    // which is never disclosable — the gate obeys the recorded verdict.
    context: {
      request: requestWithStore,
      facts: [
        {
          key: "business.faqs",
          source: "BUSINESS_FAQ_STORE",
          visibility: "INTERNAL",
          included: true,
          disclosable: false,
        },
      ],
    },
  });
  check(
    "12b. الحدّ لا يخفّف تصنيفاً متضارباً (يقرر الحكم المسجَّل فقط)",
    eq(conflictDecision.kind, "requires-human") &&
      !("resolveConflict" in disclosureModule) &&
      !("mergeVisibility" in disclosureModule),
  );

  // ── 18 / 19. INTERNAL operational metadata + durationMinutes ─────────────
  const operationalKeys = [
    "business.workingHours",
    "business.slotDurationMinutes",
    "business.confirmationMode",
    "business.timezone",
    "business.vertical",
    "business.city",
  ];
  check(
    "18a. الحقائق التشغيلية الداخلية لا تصل الطلب ولا تسند رداً",
    operationalKeys.every(
      (key) =>
        record(faqTurn, key)?.included === false &&
        record(faqTurn, key)?.disclosable === false,
    ) &&
      faqTurn.facts
        .filter((fact) => fact.included && !fact.disclosable)
        .every((fact) => fact.key === "conversation.status") &&
      !JSON.stringify(faqTurn.request).includes("workingHours") &&
      !JSON.stringify(faqTurn.request).includes("slotDurationMinutes"),
  );
  check(
    "19. durationMinutes لا يُفصح لمجرد وجوده داخلياً (ليس عائلة دعم أبداً)",
    eq(
      record(faqTurn, "service.durationMinutes:تنظيف الأسنان")?.included,
      false,
    ) &&
      eq(
        record(faqTurn, "service.durationMinutes:تنظيف الأسنان")
          ?.omissionReason,
        "OPERATIONAL_NOT_REQUIRED",
      ) &&
      !JSON.stringify(faqTurn.request).includes("durationMinutes") &&
      !Object.values(TASK_SUPPORT_FAMILIES).some(
        (family) =>
          family.family?.startsWith("service.durationMinutes") === true,
      ) &&
      (faqTurn.decision.kind === "disclosed"
        ? !faqTurn.decision.support.includes(
            "service.durationMinutes:تنظيف الأسنان",
          )
        : false),
  );

  // ── 13. AI failure + refused reply → the EXISTING human handoff ─────────
  // A compact in-memory engine run: an AI failure and a boundary refusal
  // must take the SAME NEED_HUMAN / AI_HANDOFF path, and a refused reply
  // must be neither persisted nor sent. In BOTH cases the customer is NOT
  // left in silence: exactly one deterministic safe handoff acknowledgment
  // is persisted and delivered (the #58 invariant, extended to the
  // AI-failure path by DECISIONS #60).
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
  const engine =
    await import("../src/features/conversations/server/conversation-engine");
  const now = new Date();
  const ENGINE_BUSINESS = "biz-engine-a";
  const openWeek = (): Record<string, unknown> => {
    const hours: Record<string, unknown> = {};
    for (const day of ["sat", "sun", "mon", "tue", "wed", "thu", "fri"]) {
      hours[day] = { open: "10:00", close: "18:00", closed: false };
    }
    return hours;
  };
  function makeBusiness(
    faqs: Array<{ question: string; answer: string }>,
  ): Business {
    return {
      id: ENGINE_BUSINESS,
      name: "عيادة النور",
      vertical: null,
      city: null,
      whatsappNumber: WHATSAPP_NUMBER,
      timezone: "Africa/Cairo",
      about: null,
      workingHours: openWeek(),
      slotDurationMinutes: 30,
      confirmationMode: "manual",
      faqs,
      cancellationPolicy: null,
      onboardingCompletedAt: now,
      isActive: true,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      assistantName: null,
      assistantStyle: null,
      defaultBranchId: "branch-a",
    } as unknown as Business;
  }

  interface RunResult {
    assistantAction: string | undefined;
    conversationStatus: string | undefined;
    aiMessages: string[];
    sent: string[];
    aiCalls: number;
  }

  async function runTurn(opts: {
    text: string;
    faqs: Array<{ question: string; answer: string }>;
    ai:
      | { kind: "throw" }
      | { kind: "reply"; content: string; intent: AiResponse["intent"] };
  }): Promise<RunResult> {
    const messages: Array<{
      senderType: string;
      content: string;
      id: string;
    }> = [];
    const sent: string[] = [];
    let aiCalls = 0;
    let conversation: {
      id: string;
      businessId: string;
      status: ConversationStatus;
      assignedUserId: string | null;
    } | null = null;
    let convSeq = 0;
    const business = makeBusiness(opts.faqs);

    const deps = {
      businessRepository: {
        findByWhatsappNumber: async () => business,
        findById: async () => business,
      },
      branchRepository: {
        findDefaultByBusiness: async () => ({
          id: "branch-a",
          businessId: ENGINE_BUSINESS,
          name: "الفرع الرئيسي",
          isActive: true,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        }),
        findByIdWithinBusiness: async () => null,
      },
      customerRepository: {
        upsertByPhone: async () => ({
          id: "cust-1",
          businessId: ENGINE_BUSINESS,
          name: "عميل",
          phone: "+201234567890",
          notes: null,
          lastConversationAt: null,
          lastAppointmentAt: null,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        }),
        touchConversation: async () => undefined,
      },
      conversationRepository: {
        findLatestByCustomer: async () => null,
        findById: async () => conversation,
        create: async (input: { businessId: string; customerId: string }) => {
          convSeq += 1;
          conversation = {
            id: `conv-${convSeq}`,
            businessId: input.businessId,
            status: "AI_ACTIVE",
            assignedUserId: null,
          };
          return conversation;
        },
        addMessage: async (input: { senderType: string; content: string }) => {
          const msg = {
            id: `msg-${messages.length + 1}`,
            senderType: input.senderType,
            content: input.content,
          };
          messages.push(msg);
          return msg;
        },
        getMessages: async () => [...messages].reverse(),
        update: async () => conversation,
        updateWorkflow: async (
          id: string,
          patch: { status: ConversationStatus },
        ) => {
          if (conversation && conversation.id === id) {
            conversation = { ...conversation, status: patch.status };
          }
          return conversation;
        },
      },
      serviceRepository: {
        listByBusiness: async () => [],
        findById: async () => null,
      },
      inboundDedupeRepository: {
        claim: async () => ({ status: "claimed" as const, claimId: "c1" }),
      },
      usageRepository: { record: async () => undefined },
      ai: {
        providerName: "fake-ai",
        respond: async () => {
          aiCalls += 1;
          if (opts.ai.kind === "throw") {
            throw new Error("provider down");
          }
          return replyOf(opts.ai.intent, opts.ai.content);
        },
      },
      transport: {
        providerName: "fake-transport",
        send: async (input: { content: string }) => {
          sent.push(input.content);
          return { provider: "fake-transport", delivered: true };
        },
      },
    } as unknown as Parameters<typeof engine.receiveInboundMessage>[0];

    const result = await engine.receiveInboundMessage(deps, {
      to: WHATSAPP_NUMBER,
      from: "+201234567890",
      text: opts.text,
      receivedAt: new Date().toISOString(),
      externalId: `ext-${Math.random().toString(36).slice(2)}`,
    });

    return {
      assistantAction:
        result.ok && !result.duplicate ? result.assistantAction : undefined,
      conversationStatus:
        result.ok && !result.duplicate ? result.conversationStatus : undefined,
      aiMessages: messages
        .filter((message) => message.senderType === "AI")
        .map((message) => message.content),
      sent,
      aiCalls,
    };
  }

  // (a) AI failure → the existing human handoff.
  const failed = await runTurn({
    text: "كم سعر تنظيف الأسنان؟",
    faqs: [{ question: "كم سعر تنظيف الأسنان؟", answer: SAFE_ANSWER }],
    ai: { kind: "throw" },
  });
  check(
    "13a. فشل الذكاء يتحول إلى التحويل البشري الموجود (AI_HANDOFF + NEED_HUMAN) مع إقرار آمن للعميل",
    eq(failed.assistantAction, "AI_HANDOFF") &&
      eq(failed.conversationStatus, "NEED_HUMAN") &&
      // No AI-authored content is trusted/persisted/sent on failure…
      !failed.sent.includes("fake") &&
      // …but exactly ONE deterministic safe acknowledgment IS persisted…
      eq(failed.aiMessages.length, 1) &&
      // …and delivered (never silence — DECISIONS #60). The
      // acknowledgment is the deterministic classifier's output for this
      // message, never the failed AI's content.
      eq(failed.sent.length, 1) &&
      failed.sent[0] === failed.aiMessages[0],
  );

  // (b) A fabricated reply on a store that carries no knowledge → refused by
  //     the boundary: the invented content is neither persisted nor sent.
  //     The customer is not left in silence — the turn delivers the SAME
  //     safe, deterministic handoff acknowledgment the deterministic
  //     assistant produces for this message, then keeps the existing
  //     NEED_HUMAN handoff semantics.
  const refused = await runTurn({
    text: "كم سعر تنظيف الأسنان؟",
    faqs: [],
    ai: { kind: "reply", content: LEAKY_REPLY, intent: "FAQ" },
  });
  check(
    "13b. رد مُخترَع بدون دعم قابل للإفصاح يُرفض (نفس مسار التحويل، لا تسريب)",
    eq(refused.assistantAction, "AI_HANDOFF") &&
      eq(refused.conversationStatus, "NEED_HUMAN") &&
      // The fabricated reply never reaches the customer…
      !refused.sent.includes(LEAKY_REPLY) &&
      !refused.aiMessages.includes(LEAKY_REPLY) &&
      // …but exactly one safe deterministic acknowledgment is persisted…
      eq(refused.aiMessages.length, 1) &&
      refused.aiMessages[0]!.includes("سيرد عليك أحد أعضاء الفريق") &&
      // …and delivered (never silence).
      eq(refused.sent.length, 1) &&
      refused.sent[0] === refused.aiMessages[0],
  );

  // (c) A safe, backed AI answer is emitted unchanged and delivered.
  const safe = await runTurn({
    text: "كم سعر تنظيف الأسنان؟",
    faqs: [{ question: "كم سعر تنظيف الأسنان؟", answer: SAFE_ANSWER }],
    ai: { kind: "reply", content: SAFE_ANSWER, intent: "FAQ" },
  });
  check(
    "13c/14. الرد الآمن المُسنَد يُرسل كما هو (AI_REPLY + AI_ACTIVE)",
    eq(safe.assistantAction, "AI_REPLY") &&
      eq(safe.conversationStatus, "AI_ACTIVE") &&
      deepEq(safe.aiMessages, [SAFE_ANSWER]) &&
      deepEq(safe.sent, [SAFE_ANSWER]) &&
      eq(safe.aiCalls, 1),
  );

  // (d) A booking/availability intent takes the DOMAIN path (domain-authored
  //     content), never the assistant's own text — the boundary does not
  //     touch that seam.
  const bookingHandoff = await runTurn({
    text: "عايز أحجز موعد",
    faqs: [],
    ai: { kind: "reply", content: "سأحجز لك.", intent: "AVAILABILITY" },
  });
  check(
    "13d. نيّة الحجز تذهب للمسار النطاقي (نص المزود لا يُرسل — الباقي كما هو)",
    bookingHandoff.assistantAction !== undefined &&
      !bookingHandoff.sent.includes("سأحجز لك."),
  );

  // (e) GREETING (DECISIONS #61) — a knowledge-free social protocol. The
  //     gate passes it by DECLARED INTENT, never by inspecting text: even
  //     on an EMPTY knowledge store the turn stays AI_ACTIVE and answers
  //     with the fixed acknowledgment (no invention, no handoff). The
  //     engine's deterministic bypass produced it, so ZERO LLM calls were
  //     spent and no AI_TURN usage fact exists.
  const greeting = await runTurn({
    text: "السلام عليكم",
    faqs: [], // no knowledge store at all — still safe to greet
    ai: { kind: "reply", content: "رد ترحيبي", intent: "GREETING" },
  });
  check(
    "13e. GREETING تُفصح بلا معرفة مساندة — AI_REPLY + AI_ACTIVE ولا تحويل",
    eq(greeting.assistantAction, "AI_REPLY") &&
      eq(greeting.conversationStatus, "AI_ACTIVE") &&
      greeting.aiMessages.length === 1 &&
      greeting.aiCalls === 0, // deterministic bypass: no provider call
  );
  check(
    "13f. ترحيب GREETING لا يدّعي البشرية ولا يخترع معلومات",
    greeting.aiMessages.length === 1 &&
      !/بشري|إنسان|موظف|سعر|موعد متاح|السعر/.test(greeting.aiMessages[0]!) &&
      greeting.aiMessages[0]!.includes("أهلاً") &&
      greeting.sent[0] === greeting.aiMessages[0],
  );
  // The gate made its decision from the intent alone — an UNKNOWN intent
  // declaring a reply on the same empty store is still refused (the closed
  // list cannot be widened by a provider).
  const unknownIntent = enforceDisclosure({
    response: { ...replyOf("GREETING", "رد"), intent: "FAQ" },
    context: {
      request: { ...faqTurn.request, faqs: [] },
      facts: buildAiContext({
        scope: { businessId: TENANT_A },
        sources: makeSources("اهلا", {
          business: businessSources({ faqs: [] }),
        }),
      }).facts,
    },
  });
  check(
    "13g. نيّة غير ترحيبية على مخزن فارغ تُرفض (القائمة المغلقة لا تتوسع)",
    eq(unknownIntent.kind, "requires-human"),
  );

  // ── 15 / 16. jargon-free customer output + determinism ──────────────────
  check(
    "15. لا مصطلحات Meta/المزود في ردود العميل (التجربة طبيعية)",
    !/graph\.facebook\.com|WhatsApp Cloud|Atria|OpenRouter|AgentRouter|API/i.test(
      [...safe.sent, ...safe.aiMessages, ...failed.sent, ...refused.sent].join(
        "\n",
      ),
    ),
  );
  const again = enforceDisclosure({
    response: replyOf("FAQ", SAFE_ANSWER),
    context: { request: faqTurn.request, facts: faqTurn.facts },
  });
  check(
    "16. حتمي: نفس المدخلات ⇒ نفس الإخراج",
    deepEq(faqTurn.decision, again),
  );

  // ── Report ───────────────────────────────────────────────────────────────
  let failedCount = 0;
  for (const { label, pass } of checks) {
    if (pass) console.log(`✔ ${label}`);
    else {
      console.error(`✘ ${label}`);
      failedCount += 1;
    }
  }
  if (failedCount > 0) {
    console.error(`\nفشل ${failedCount} من ${checks.length} فحص.`);
    process.exit(1);
  }
  console.log(
    `\nحدّ إفصاح العميل صحيح: ${checks.length}/${checks.length} فحص ناجح.`,
  );
}

main().catch((error: Error) => {
  console.error(`فشل غير متوقع: ${error.message}`);
  process.exit(1);
});
