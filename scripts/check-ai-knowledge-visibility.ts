/**
 * FlowPilot — AI KNOWLEDGE VISIBILITY POLICY check (PROMPT-B01).
 *
 * Offline, in-memory verification of the B-01 policy only (no DB, no
 * network, no LLM, no secrets):
 *   1. the four levels are exactly PUBLIC/CONDITIONAL/INTERNAL/FORBIDDEN;
 *   2. eligibility ("AI may know") vs disclosure ("AI may mention") are
 *      distinct — INTERNAL is eligible but never disclosable;
 *   3. CONDITIONAL facts are gated on task relevance (never speculative);
 *   4. enrollment refuses FORBIDDEN / unproven-tenant / unknown-provenance
 *      candidates by default (safe defaults are structural);
 *   5. cross-tenant facts are excluded, never AI-resolved;
 *   6. field classification covers Business / Service / conversation /
 *      FAQ-store with the required product rules (duration, working
 *      hours, confirmation mode = INTERNAL; cancellation policy =
 *      CONDITIONAL; FAQ store = PUBLIC);
 *   7. FORBIDDEN categories cover the required minimum list and map to
 *      the concrete FlowPilot secret/credential locations;
 *   8. the policy is structural (source/field/provenance), NOT a
 *      string-matching redactor or a word blacklist;
 *   9. the policy imports no env/DB/provider — it is pure application
 *      policy, so no `process.env` path was introduced into AI/domain
 *      logic (imported at the top, before ANY env is set, on purpose).
 *
 * Run: pnpm check:knowledge-visibility
 */

// Imported DELIBERATELY before any process.env assignment: the policy must
// load with zero environment or database dependencies.
import * as fs from "node:fs";
import * as path from "node:path";

import * as aiVisibilityModule from "../src/lib/ai-knowledge-visibility";
import {
  AI_MUST_NOT_RESOLVE_CONFLICTS,
  DEFAULT_VISIBILITY,
  FACT_EXCLUSION_REASONS,
  FORBIDDEN_CATEGORY_VALUES,
  FORBIDDEN_FIELDS,
  KNOWLEDGE_FACT_SOURCE_VALUES,
  VISIBILITY_LEVELS,
  classifyBusinessField,
  classifyConversationField,
  classifyFaqStore,
  classifyServiceField,
  decideFact,
  enrollFact,
  isDisclosable,
  isEligibleForAiContext,
  isForbidden,
  isForbiddenField,
  isWithinTenantScope,
  mostRestrictive,
} from "../src/lib/ai-knowledge-visibility";

export {};

type Check = { label: string; pass: boolean };

const checks: Check[] = [];
function check(label: string, pass: boolean): void {
  checks.push({ label, pass });
}
function eq<T>(actual: T, expected: T): boolean {
  return actual === expected;
}

async function main(): Promise<void> {
  // ── 0. The policy must have no env/DB/provider dependency ───────────────
  // Loaded above before ANY env var was set; now also prove statically that
  // the module sources introduce no process.env / Prisma / provider path.
  const policyDir = path.resolve(
    process.cwd(),
    "src/lib/ai-knowledge-visibility",
  );
  const policySources = fs
    .readdirSync(policyDir)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => fs.readFileSync(path.join(policyDir, file), "utf8"))
    .join("\n");
  check(
    "السياسة لا تصل process.env ولا قاعدة البيانات ولا المزود",
    !/process\.env\s*[.[\]]/.test(policySources) &&
      !/@\/server\/db|@\/generated\/prisma|prisma\/client/.test(
        policySources,
      ) &&
      !/@\/server\/integrations\//.test(policySources),
  );

  // ── 1. Four levels, exactly ──────────────────────────────────────────────
  check(
    "أربعة مستويات للظهور بالضبط: PUBLIC/CONDITIONAL/INTERNAL/FORBIDDEN",
    eq(
      [...VISIBILITY_LEVELS].join(","),
      "PUBLIC,CONDITIONAL,INTERNAL,FORBIDDEN",
    ),
  );
  check(
    "الافتراضي عند عدم المعرفة هو INTERNAL (لا يُفشى للعميل أبداً)",
    eq(DEFAULT_VISIBILITY, "INTERNAL"),
  );

  // ── 2. Eligibility vs disclosure are DISTINCT ────────────────────────────
  check(
    "PUBLIC: يعرف ويُذكر للعميل دائماً",
    isEligibleForAiContext("PUBLIC") === true &&
      isDisclosable("PUBLIC") === true,
  );
  check(
    "CONDITIONAL: غير مؤهل/غير ذكر بدون صلة المهمة",
    isEligibleForAiContext("CONDITIONAL") === false &&
      isDisclosable("CONDITIONAL") === false,
  );
  check(
    "CONDITIONAL: مؤهل وقابل للذكر فقط عندما تكون المهمة ذات صلة",
    isEligibleForAiContext("CONDITIONAL", { taskRelevant: true }) === true &&
      isDisclosable("CONDITIONAL", { taskRelevant: true }) === true,
  );
  check(
    "INTERNAL: مؤهل لسياق الذكاء (يعرفه) لكنه غير قابل للذكر أبداً",
    isEligibleForAiContext("INTERNAL") === true &&
      isDisclosable("INTERNAL") === false,
  );
  check(
    "FORBIDDEN: غير مؤهل وغير قابل للذكر (لا يدخل السياق)",
    isEligibleForAiContext("FORBIDDEN") === false &&
      isDisclosable("FORBIDDEN") === false &&
      isForbidden("FORBIDDEN") === true,
  );

  // ── 3. Field classification — Business record ────────────────────────────
  check(
    "حقول المنشأة العامة: name/about/faqs = PUBLIC",
    eq(classifyBusinessField("name"), "PUBLIC") &&
      eq(classifyBusinessField("about"), "PUBLIC") &&
      eq(classifyBusinessField("faqs"), "PUBLIC"),
  );
  check(
    "معلومات تشغيلية داخلية: workingHours/slotDurationMinutes/confirmationMode/vertical/city = INTERNAL",
    eq(classifyBusinessField("workingHours"), "INTERNAL") &&
      eq(classifyBusinessField("slotDurationMinutes"), "INTERNAL") &&
      eq(classifyBusinessField("confirmationMode"), "INTERNAL") &&
      eq(classifyBusinessField("vertical"), "INTERNAL") &&
      eq(classifyBusinessField("city"), "INTERNAL"),
  );
  check(
    "سياسة الإلغاء CONDITIONAL (فقط عند سؤال الإلغاء/الإعادة)",
    eq(classifyBusinessField("cancellationPolicy"), "CONDITIONAL"),
  );
  check(
    "المعرّفات الداخلية forbidden كحقائق: id/defaultBranchId",
    eq(classifyBusinessField("id"), "FORBIDDEN") &&
      eq(classifyBusinessField("defaultBranchId"), "FORBIDDEN"),
  );
  check(
    "حقل غير معروف يقع على INTERNAL (أبداً PUBLIC)",
    eq(classifyBusinessField("someNewFutureField"), "INTERNAL"),
  );

  // ── 4. Field classification — Service catalog + conversation ─────────────
  check(
    "الخدمات: name/description = PUBLIC، durationMinutes = INTERNAL",
    eq(classifyServiceField("name"), "PUBLIC") &&
      eq(classifyServiceField("description"), "PUBLIC") &&
      eq(classifyServiceField("durationMinutes"), "INTERNAL"),
  );
  check(
    "مفاتيح الخدمة الداخلية forbidden: id/businessId",
    eq(classifyServiceField("id"), "FORBIDDEN") &&
      eq(classifyServiceField("businessId"), "FORBIDDEN"),
  );
  check(
    "المحادثة: message = PUBLIC، availability = CONDITIONAL، conversationStatus = INTERNAL",
    eq(classifyConversationField("message"), "PUBLIC") &&
      eq(classifyConversationField("availability"), "CONDITIONAL") &&
      eq(classifyConversationField("conversationStatus"), "INTERNAL"),
  );
  check(
    "مخزن المعرفة (Business.faqs) PUBLIC ككل — بدون بيانات وصفية لكل مدخل",
    eq(classifyFaqStore(), "PUBLIC"),
  );
  check(
    "isForbiddenField يلتقط المعرّفات الداخلية عبر المصادر",
    isForbiddenField("id") === true &&
      isForbiddenField("defaultBranchId") === true &&
      isForbiddenField("businessId") === true &&
      isForbiddenField("name") === false,
  );

  // ── 5. Safe defaults are STRUCTURAL at enrollment ───────────────────────
  const ownScope = { businessId: "business-own" };
  const forbiddenEnroll = enrollFact({
    source: "BUSINESS_RECORD",
    businessId: ownScope.businessId,
    visibility: "FORBIDDEN",
    value: "whatever",
  });
  check(
    "الإدراج يرفض FORBIDDEN بشكل بنائي (FORBIDDEN_BY_POLICY)",
    forbiddenEnroll.enrolled === false &&
      "reason" in forbiddenEnroll &&
      eq(forbiddenEnroll.reason, "FORBIDDEN_BY_POLICY"),
  );
  const noTenant = enrollFact({
    source: "BUSINESS_RECORD",
    businessId: null,
    visibility: "PUBLIC",
    value: "x",
  });
  check(
    "بدل ملكية المستأجر غير مُثبت → مستبعد (UNPROVEN_TENANT)",
    noTenant.enrolled === false &&
      "reason" in noTenant &&
      eq(noTenant.reason, "UNPROVEN_TENANT"),
  );
  const noSource = enrollFact({
    source: undefined,
    businessId: ownScope.businessId,
    visibility: "PUBLIC",
    value: "x",
  });
  check(
    "المصدر غير معروف → مستبعد (UNKNOWN_SOURCE)",
    noSource.enrolled === false &&
      "reason" in noSource &&
      eq(noSource.reason, "UNKNOWN_SOURCE"),
  );
  const noVis = enrollFact({
    source: "BUSINESS_RECORD",
    businessId: ownScope.businessId,
    visibility: undefined,
    value: "x",
  });
  check(
    "الظهور غير المعروف → مستبعد (UNKNOWN_VISIBILITY)",
    noVis.enrolled === false &&
      "reason" in noVis &&
      eq(noVis.reason, "UNKNOWN_VISIBILITY"),
  );
  check(
    "أسباب الاستبعاد الأربعة معرّفة ومكتملة",
    eq(
      [...FACT_EXCLUSION_REASONS].join(","),
      "FORBIDDEN_BY_POLICY,UNPROVEN_TENANT,UNKNOWN_SOURCE,UNKNOWN_VISIBILITY",
    ),
  );

  // ── 6. decideFact — the end-to-end policy decision ───────────────────────
  const publicName = decideFact({
    source: "BUSINESS_RECORD",
    businessId: ownScope.businessId,
    visibility: classifyBusinessField("name"),
    value: "عيادة الابتسامة",
    scope: ownScope,
  });
  check(
    "اسم المنشأة في النطاق: مؤهل وقابل للذكر",
    publicName.enrolled === true &&
      "eligible" in publicName &&
      publicName.eligible === true &&
      publicName.disclosable === true,
  );
  const internalHours = decideFact({
    source: "BUSINESS_RECORD",
    businessId: ownScope.businessId,
    visibility: classifyBusinessField("workingHours"),
    value: { sun: { open: "09:00", close: "21:00" } },
    scope: ownScope,
  });
  check(
    "ساعات العمل: يعرفها الذكاء ولا يذكرها للعميل (الفصل الأساسي)",
    internalHours.enrolled === true &&
      "eligible" in internalHours &&
      internalHours.eligible === true &&
      internalHours.disclosable === false,
  );
  const condNoRelevance = decideFact({
    source: "BUSINESS_RECORD",
    businessId: ownScope.businessId,
    visibility: classifyBusinessField("cancellationPolicy"),
    value: "يُلغى قبل 24 ساعة",
    taskRelevant: false,
    scope: ownScope,
  });
  check(
    "سياسة الإلغاء بدون صلة: غير مؤهل وغير ذكر (لا تظهر استباقياً)",
    condNoRelevance.enrolled === true &&
      "eligible" in condNoRelevance &&
      condNoRelevance.eligible === false &&
      condNoRelevance.disclosable === false,
  );
  const condRelevance = decideFact({
    source: "BUSINESS_RECORD",
    businessId: ownScope.businessId,
    visibility: classifyBusinessField("cancellationPolicy"),
    value: "يُلغى قبل 24 ساعة",
    taskRelevant: true,
    scope: ownScope,
  });
  check(
    "سياسة الإلغاء عند صلة المهمة: مؤهلة وقابلة للذكر",
    condRelevance.enrolled === true &&
      "eligible" in condRelevance &&
      condRelevance.eligible === true &&
      condRelevance.disclosable === true,
  );

  // ── 7. Tenant safety ─────────────────────────────────────────────────────
  const foreign = decideFact({
    source: "BUSINESS_RECORD",
    businessId: "business-other",
    visibility: classifyBusinessField("name"),
    value: "منشأة أخرى",
    scope: ownScope,
  });
  check(
    "بيانات منشأة أخرى تُستبعد (لا تEntered سياق الذكاء أبداً)",
    foreign.enrolled === false &&
      "reason" in foreign &&
      eq(foreign.reason, "UNPROVEN_TENANT"),
  );
  const ownFact = enrollFact({
    source: "BUSINESS_FAQ_STORE",
    businessId: ownScope.businessId,
    visibility: "PUBLIC",
    value: { question: "q", answer: "a" },
  });
  check(
    "isWithinTenantScope: نطاق المنشأة مطابق فقط",
    ownFact.enrolled === true &&
      isWithinTenantScope(ownFact.fact, ownScope) === true,
  );
  check(
    "السياسة لا تحل تعارضات البيانات بنفسها (النطاق هو المرجع)",
    AI_MUST_NOT_RESOLVE_CONFLICTS === true,
  );

  // ── 8. FORBIDDEN categories — the required minimum set ──────────────────
  const required = [
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
  ];
  check(
    "فئات FORBIDDEN تغطي الحد الأدنى المطلوب (14)",
    required.every((cat) =>
      (FORBIDDEN_CATEGORY_VALUES as ReadonlyArray<string>).includes(cat),
    ),
  );
  const forbiddenLocations = FORBIDDEN_FIELDS.map((f) => f.location).join("|");
  check(
    "مواقع FORBIDDEN تغطي credentialsRef/secretRefs/tokenHash/env",
    forbiddenLocations.includes("WhatsAppConnection.credentialsRef") &&
      forbiddenLocations.includes("PlatformAiPolicy.primarySecretRef") &&
      forbiddenLocations.includes("PlatformAiPolicy.secondarySecretRef") &&
      forbiddenLocations.includes("Invitation.tokenHash") &&
      forbiddenLocations.includes("process.env secret values"),
  );

  // ── 9. Structural policy, NOT string redaction ──────────────────────────
  // A classification is decided by SOURCE+FIELD, never by scanning a value:
  // a value that looks like a key does not change a PUBLIC field's level,
  // and a benign value does not upgrade a FORBIDDEN field.
  check(
    "التصنيف يعتمد على المصدر/الحقل وليس على مسح قيمة النص",
    eq(classifyBusinessField("name"), "PUBLIC") &&
      eq(classifyBusinessField("id"), "FORBIDDEN"),
  );
  check(
    "السياسة لا تصدر قائمة كلمات حظر ولا تعتمد تطابق النصوص",
    !("redactText" in aiVisibilityModule) &&
      !("forbiddenWords" in aiVisibilityModule) &&
      !("blacklist" in aiVisibilityModule),
  );
  check(
    "مصادر الحقائق السبعة معرّفة (مصدر واحد لكل حقيقة)",
    eq(KNOWLEDGE_FACT_SOURCE_VALUES.length, 7),
  );

  // ── 10. Restrictiveness merge ────────────────────────────────────────────
  check(
    "mostRestrictive: الأكثر تقييداً يفوز، FORBIDDEN دائماً",
    eq(mostRestrictive(["PUBLIC", "INTERNAL"]), "INTERNAL") &&
      eq(mostRestrictive(["PUBLIC", "CONDITIONAL", "INTERNAL"]), "INTERNAL") &&
      eq(mostRestrictive(["PUBLIC", "FORBIDDEN"]), "FORBIDDEN") &&
      eq(mostRestrictive([]), "INTERNAL"),
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
    `\nسياسة ظهور معرفة الذكاء صحيحة: ${checks.length}/${checks.length} فحص ناجح.`,
  );
}

// Imported only for the structural "no redactor exists" assertion above.
main().catch((error: Error) => {
  console.error(`فشل غير متوقع: ${error.message}`);
  process.exit(1);
});
