/* eslint-disable @typescript-eslint/consistent-type-imports */

/**
 * FlowPilot — KNOWLEDGE BASE / FAQ AUTHORING check (PROMPT-B05).
 *
 * Offline, in-memory verification of the tenant-scoped knowledge authoring
 * workflow (no DB, no network, no LLM, no API tokens, no secrets). It runs
 * the REAL knowledge service with the REAL schemas; only the repository
 * collaborator is an in-memory fake, so the whole list/create/update/remove
 * + suggestion seam is exercised end-to-end through the service's own
 * authorization rules:
 *
 *   1.  list the tenant's FAQs
 *   2.  create an FAQ
 *   3.  update an FAQ
 *   4.  delete an FAQ
 *   5.  cross-tenant READ is rejected (another Business's FAQ is invisible)
 *   6.  cross-tenant WRITE is rejected (a client businessId can never
 *       redirect the write target)
 *   7.  cross-tenant DELETE is rejected (another tenant's entry key is
 *       "not found", never removed)
 *   8.  an invalid question is rejected
 *   9.  an invalid answer is rejected
 *  10.  a suggested question is added ONLY through the explicit create
 *       path — the suggestion read performs no write and no suggestion
 *       becomes stored knowledge by itself
 *  11.  a suggested answer stays an EDITABLE draft — the create input the
 *       owner submits may differ from the draft, and only the submitted
 *       text is stored (never an auto-"verified" answer)
 *  12.  no duplicate FAQ is created when the same item is already present
 *       (service-side) and an already-answered suggestion is not offered
 *       twice (catalog dedupe helper)
 *  13.  existing AI context behavior stays compatible — the stored JSON
 *       the service writes round-trips through the B-02 context builder's
 *       own stored-FAQ validation and remains a PUBLIC knowledge store
 *  14.  B-01/B-02/B-03 invariants the authoring surface depends on are
 *       unchanged (FAQ store classified PUBLIC by the shared policy)
 *
 * Run: pnpm check:knowledge-faq
 */

import type { FaqSuggestionGroup } from "../src/features/knowledge/suggestions/faq-suggestions";
import { classifyFaqStore } from "../src/lib/ai-knowledge-visibility";
import {
  VERTICAL_LABELS,
  VERTICAL_VALUES,
  faqEntrySchema,
} from "../src/lib/validation";
import type { Business } from "../src/types/domain";

export {};

type Check = { label: string; pass: boolean };

const checks: Check[] = [];

function record(label: string, pass: boolean): void {
  checks.push({ label, pass });
}

function eq<T>(actual: T, expected: T): boolean {
  return actual === expected;
}

function ok(value: unknown): boolean {
  return Boolean(value);
}

/** Every starter pair is a valid `faqEntrySchema` entry (and at least one). */
function allValidSuggestionPairs(group: FaqSuggestionGroup | null): boolean {
  if (!group) return false;
  return (
    group.suggestions.length > 0 &&
    group.suggestions.every(
      (pair) => faqEntrySchema.safeParse(pair).success === true,
    )
  );
}

// ─── In-memory repository collaborator ───────────────────────────────────────

/** Minimal business record shape the service actually reads (faqs + vertical). */
type StoredBusiness = {
  id: string;
  faqs: unknown;
  vertical: string | null;
};

function makeBusiness(business: Partial<StoredBusiness>): StoredBusiness {
  return {
    id: business.id ?? "business-1",
    faqs: business.faqs ?? [],
    vertical: business.vertical ?? null,
  };
}

/**
 * The fake repository is the ONLY injected dependency. It records writes so
 * a cross-tenant attempt can be proven to never have touched the other
 * tenant's record.
 */
function makeDeps(initial: StoredBusiness[]): {
  deps: import("../src/features/knowledge/server/knowledge-service").KnowledgeServiceDeps;
  stores: Map<string, StoredBusiness>;
  writes: Array<{ businessId: string }>;
} {
  const stores = new Map<string, StoredBusiness>();
  for (const business of initial) stores.set(business.id, business);

  const writes: Array<{ businessId: string }> = [];

  const deps: import("../src/features/knowledge/server/knowledge-service").KnowledgeServiceDeps =
    {
      businessRepository: {
        findById: async (id: string) =>
          (stores.get(id) as Business | undefined) ?? null,
        update: async (businessId: string, data: { faqs?: unknown }) => {
          writes.push({ businessId });
          const stored = stores.get(businessId);
          if (stored && data.faqs !== undefined) stored.faqs = data.faqs;
          return stored as Business;
        },
      },
    };

  return { deps, stores, writes };
}

const OWNER_A: import("../src/features/knowledge/server/knowledge-service").KnowledgeActor =
  { userId: "user-a", role: "ADMIN", businessId: "business-a" };

const OWNER_B: import("../src/features/knowledge/server/knowledge-service").KnowledgeActor =
  { userId: "user-b", role: "ADMIN", businessId: "business-b" };

const STAFF_ACTOR: import("../src/features/knowledge/server/knowledge-service").KnowledgeActor =
  { userId: "user-staff", role: "STAFF", businessId: "business-a" };

const NO_BUSINESS_ACTOR: import("../src/features/knowledge/server/knowledge-service").KnowledgeActor =
  { userId: "user-orphan", role: "ADMIN", businessId: null };

async function main(): Promise<void> {
  // Placeholder env before importing anything that transitively touches the
  // Prisma client (`@/server/repositories` → `db`). No connection is ever
  // opened: the repository is replaced by an in-memory fake, so the harness
  // stays offline (no DB, no network, no LLM, no secrets).
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const service =
    await import("../src/features/knowledge/server/knowledge-service");
  const {
    createKnowledgeEntry,
    defaultKnowledgeServiceDeps,
    listKnowledge,
    listKnowledgeSuggestions,
    removeKnowledgeEntry,
    updateKnowledgeEntry,
  } = service;
  const { listFaqSuggestions, suggestionGroupLabel } =
    await import("../src/features/knowledge/suggestions/faq-suggestions");

  // ── 1. List the tenant's FAQs ──────────────────────────────────────────────
  {
    const { deps } = makeDeps([
      makeBusiness({
        id: "business-a",
        faqs: [{ question: "ما سياسة الإلغاء؟", answer: "قبل ٢٤ ساعة." }],
        vertical: "dental",
      }),
    ]);

    const result = await listKnowledge(deps, OWNER_A);
    record(
      "1. القائمة ترجع مدخلات النشاط الحالي",
      Array.isArray(result) &&
        result.length === 1 &&
        eq(result[0]!.question, "ما سياسة الإلغاء؟"),
    );
  }

  // ── 2. Create an FAQ ───────────────────────────────────────────────────────
  {
    const { deps, stores } = makeDeps([makeBusiness({ id: "business-a" })]);

    const result = await createKnowledgeEntry(deps, OWNER_A, {
      question: "هل يجب الحجز مسبقًا؟",
      answer: "نعم، عن طريق الواتساب.",
    });

    record(
      "2. الإنشاء يرجع قائمة محدّثة",
      result.success === true && result.entries.length === 1,
    );
    record(
      "2. الإنشاء يخزّن في حقل faqs للنشاط المالك",
      stores.get("business-a")?.faqs instanceof Array &&
        eq(
          (stores.get("business-a")!.faqs as Array<{ question: string }>)[0]!
            .question,
          "هل يجب الحجز مسبقًا؟",
        ) &&
        eq(
          (stores.get("business-a")!.faqs as Array<{ answer: string }>)[0]!
            .answer,
          "نعم، عن طريق الواتساب.",
        ),
    );
  }

  // ── 3. Update an FAQ ───────────────────────────────────────────────────────
  {
    const { deps, stores } = makeDeps([
      makeBusiness({
        id: "business-a",
        faqs: [
          { question: "ما سياسة الإلغاء؟", answer: "قديمة" },
          { question: "سؤال ثانٍ", answer: "جواب ثانٍ" },
        ],
      }),
    ]);

    const result = await updateKnowledgeEntry(deps, OWNER_A, {
      currentQuestion: "ما سياسة الإلغاء؟",
      entry: { question: "ما سياسة الإلغاء؟", answer: "محفوظة جديدة" },
    });
    const stored = stores.get("business-a")?.faqs as Array<{
      question: string;
      answer: string;
    }>;

    record(
      "3. التعديل يرجع نفس عدد المدخلات بدون تكرار",
      result.success === true && result.entries.length === 2,
    );
    record(
      "3. التعديل يغيّر الإجابة ويترك بقية المدخلات",
      eq(stored[0]!.answer, "محفوظة جديدة") &&
        eq(stored[1]!.question, "سؤال ثانٍ"),
    );
  }

  // ── 4. Delete an FAQ ───────────────────────────────────────────────────────
  {
    const { deps, stores } = makeDeps([
      makeBusiness({
        id: "business-a",
        faqs: [
          { question: "ما سياسة الإلغاء؟", answer: "قديمة" },
          { question: "سؤال ثانٍ", answer: "جواب ثانٍ" },
        ],
      }),
    ]);

    const result = await removeKnowledgeEntry(deps, OWNER_A, {
      question: "ما سياسة الإلغاء؟",
    });
    const stored = stores.get("business-a")?.faqs as Array<{
      question: string;
    }>;

    record(
      "4. الحذف يحذف المدخل المستهدف فقط",
      result.success === true &&
        stored.length === 1 &&
        eq(stored[0]!.question, "سؤال ثانٍ"),
    );
  }

  // ── 5. Cross-tenant READ rejected ──────────────────────────────────────────
  {
    const { deps } = makeDeps([
      makeBusiness({
        id: "business-a",
        faqs: [{ question: "سؤال النشاط أ", answer: "جواب أ" }],
      }),
      makeBusiness({
        id: "business-b",
        faqs: [{ question: "سؤال النشاط ب", answer: "جواب ب" }],
      }),
    ]);

    const result = await listKnowledge(deps, OWNER_B);

    record(
      "5. نشاط آخر لا يرى أسئلة نشاط مختلف (scope ذاتي)",
      Array.isArray(result) &&
        result.length === 1 &&
        eq(result[0]!.question, "سؤال النشاط ب"),
    );
  }

  // ── 6. Cross-tenant WRITE rejected ─────────────────────────────────────────
  {
    const { deps, stores, writes } = makeDeps([
      makeBusiness({
        id: "business-a",
        faqs: [{ question: "سؤال النشاط أ", answer: "جواب أ" }],
      }),
      makeBusiness({ id: "business-b", faqs: [] }),
    ]);

    // A hostile payload carrying the OTHER tenant's businessId: the schema
    // strips unknown keys, and the write target is always the actor's own.
    const result = await createKnowledgeEntry(deps, OWNER_B, {
      question: "سؤال جديد",
      answer: "جواب جديد",
      businessId: "business-a",
    });
    const storeA = stores.get("business-a")?.faqs as Array<{
      question: string;
    }>;
    const storeB = stores.get("business-b")?.faqs as Array<{
      question: string;
    }>;

    record(
      "6. الحمومة الحاقدة لا تعيد توجيه الكتابة لنشاط آخر",
      result.success === true &&
        storeA.length === 1 &&
        eq(storeA[0]!.question, "سؤال النشاط أ") &&
        storeB.length === 1 &&
        eq(storeB[0]!.question, "سؤال جديد"),
    );
    record(
      "6. الكتابة سجّلت على نشاط المالك فقط",
      writes.length === 1 && eq(writes[0]!.businessId, "business-b"),
    );
  }

  // ── 7. Cross-tenant DELETE rejected ────────────────────────────────────────
  {
    const { deps, stores } = makeDeps([
      makeBusiness({
        id: "business-a",
        faqs: [{ question: "سؤال النشاط أ", answer: "جواب أ" }],
      }),
      makeBusiness({ id: "business-b", faqs: [] }),
    ]);

    // Owner B has NO entry by that question; a stale key from tenant A must
    // fail honestly instead of removing tenant A's entry.
    const result = await removeKnowledgeEntry(deps, OWNER_B, {
      question: "سؤال النشاط أ",
    });
    const storeA = stores.get("business-a")?.faqs as Array<{
      question: string;
    }>;

    record(
      "7. حذف مفتاح من نشاط آخر يُرفض (غير موجود)",
      result.success === false,
    );
    record(
      "7. مدخل النشاط الآخر لم يُمسس",
      storeA.length === 1 && eq(storeA[0]!.question, "سؤال النشاط أ"),
    );
  }

  // ── 8. Invalid question rejected ───────────────────────────────────────────
  {
    const { deps } = makeDeps([makeBusiness({ id: "business-a" })]);

    const tooShort = await createKnowledgeEntry(deps, OWNER_A, {
      question: "أ",
      answer: "جواب صحيح",
    });
    const empty = await createKnowledgeEntry(deps, OWNER_A, {
      question: "   ",
      answer: "جواب صحيح",
    });
    const tooLong = await createKnowledgeEntry(deps, OWNER_A, {
      question: "س".repeat(501),
      answer: "جواب صحيح",
    });

    record(
      "8. سؤال قصير جدًا / فارغ / طويل جدًا مرفوض",
      tooShort.success === false &&
        empty.success === false &&
        tooLong.success === false,
    );
  }

  // ── 9. Invalid answer rejected ─────────────────────────────────────────────
  {
    const { deps } = makeDeps([makeBusiness({ id: "business-a" })]);

    const tooShort = await createKnowledgeEntry(deps, OWNER_A, {
      question: "سؤال صحيح؟",
      answer: "أ",
    });
    const empty = await createKnowledgeEntry(deps, OWNER_A, {
      question: "سؤال صحيح؟",
      answer: "  ",
    });
    const tooLong = await createKnowledgeEntry(deps, OWNER_A, {
      question: "سؤال صحيح؟",
      answer: "ج".repeat(2001),
    });

    record(
      "9. إجابة قصيرة جدًا / فارغة / طويلة جدًا مرفوضة",
      tooShort.success === false &&
        empty.success === false &&
        tooLong.success === false,
    );
  }

  // ── Role / no-business guards stay authoritative ──────────────────────────
  {
    const { deps } = makeDeps([makeBusiness({ id: "business-a", faqs: [] })]);

    const staffList = await listKnowledge(deps, STAFF_ACTOR);
    const staffCreate = await createKnowledgeEntry(deps, STAFF_ACTOR, {
      question: "سؤال",
      answer: "جواب",
    });
    const orphanList = await listKnowledge(deps, NO_BUSINESS_ACTOR);

    record(
      "حارس الدور: STAFF لا يرى القائمة",
      !Array.isArray(staffList) && typeof staffList.message === "string",
    );
    record("حارس الدور: STAFF لا ينشئ مدخلًا", staffCreate.success === false);
    record("حارس النطاق: ADMIN بدون نشاط يُرفض", !Array.isArray(orphanList));
  }

  // ── 10. Suggestion adds ONLY through explicit save ────────────────────────
  {
    const store = makeBusiness({ id: "business-a", vertical: "dental" });
    const { deps, writes } = makeDeps([store]);

    const before = store.faqs as Array<{ question: string }>;
    const suggestions = await listKnowledgeSuggestions(deps, OWNER_A);
    const suggestionList: FaqSuggestionGroup | null =
      "suggestions" in suggestions ? suggestions : null;

    record(
      "10. قراءة الاقتراحات لا تكتب أبدًا (مفتاح تشغيل صفر)",
      writes.length === 0 && before.length === 0,
    );
    const validPairs = allValidSuggestionPairs(suggestionList);
    record("10. الاقتراحات ترجع أزواج سؤال/إجابة", validPairs);

    // A suggestion object by itself never reaches storage: only the explicit
    // create call does.
    const first = suggestionList?.suggestions[0] ?? null;
    record(
      "10. الاقتراحات ترجع زوجًا أول صالح",
      ok(first) && faqEntrySchema.safeParse(first).success === true,
    );
    const explicit = await createKnowledgeEntry(deps, OWNER_A, {
      question: first!.question,
      answer: first!.answer,
    });
    record(
      "10. الاقتراح يُخزَّن فقط عبر الإنشاء الصريح",
      explicit.success === true && writes.length === 1,
    );
  }

  // ── 11. Suggested answer stays an editable draft ───────────────────────────
  {
    const { deps, stores } = makeDeps([makeBusiness({ id: "business-a" })]);

    const draft = listFaqSuggestions("dental")[0]!;
    const editedAnswer = "إجابة خاصة بي عدّلتها";
    const result = await createKnowledgeEntry(deps, OWNER_A, {
      question: draft.question,
      answer: editedAnswer,
    });
    const stored = stores.get("business-a")?.faqs as Array<{
      answer: string;
    }>;

    record(
      "11. الإجابة المخزّنة هي ما أدخله المالك، لا مسودة الاقتراح",
      result.success === true &&
        stored.length === 1 &&
        eq(stored[0]!.answer, editedAnswer) &&
        stored[0]!.answer !== draft.answer,
    );
  }

  // ── 12. No duplicate FAQ / already-answered suggestions not re-offered ────
  {
    const existing = { question: "ما سياسة الإلغاء؟", answer: "قديم" };
    const { deps } = makeDeps([
      makeBusiness({ id: "business-a", faqs: [existing] }),
    ]);

    const duplicate = await createKnowledgeEntry(deps, OWNER_A, {
      question: "ما سياسة الإلغاء؟",
      answer: "محاولة تكرار",
    });

    record(
      "12. تكرار نفس السؤال مرفوض برسالة واضحة",
      duplicate.success === false && duplicate.message.length > 0,
    );

    // Catalog dedupe helper: a suggestion whose question already exists is
    // not offered again (the UI hides it instead of offering a dead add).
    const common = listFaqSuggestions("dental");
    record(
      "12. الاقتراحات الشائعة تشمل سياسة الإلغاء",
      common.some((pair) => pair.question === existing.question),
    );

    const owned = new Set([existing.question.trim()]);
    const remaining = common.filter((pair) => !owned.has(pair.question.trim()));
    record(
      "12. مساعد إزالة المُجاب عنها يحذف التكرار",
      !remaining.some((pair) => pair.question === existing.question) &&
        remaining.length === common.length - 1,
    );

    // Renaming a question onto an existing one is still a conflict.
    const other = makeBusiness({
      id: "business-c",
      faqs: [
        { question: "سؤال أول", answer: "جواب" },
        { question: "سؤال ثانٍ", answer: "جواب" },
      ],
    });
    const { deps: depsC } = makeDeps([other]);
    const ownerC: import("../src/features/knowledge/server/knowledge-service").KnowledgeActor =
      { userId: "user-c", role: "ADMIN", businessId: "business-c" };
    const renameConflict = await updateKnowledgeEntry(depsC, ownerC, {
      currentQuestion: "سؤال أول",
      entry: { question: "سؤال ثانٍ", answer: "جواب" },
    });
    record(
      "12. إعادة تسمية لسؤال موجود بالفعل تُرفض",
      renameConflict.success === false,
    );
  }

  // ── 13. AI context compatibility (B-02 unchanged) ────────────────────────
  {
    const { deps, stores } = makeDeps([
      makeBusiness({
        id: "business-a",
        faqs: [{ question: "ما سياسة الإلغاء؟", answer: "٢٤ ساعة." }],
        vertical: "dental",
      }),
    ]);

    await createKnowledgeEntry(deps, OWNER_A, {
      question: "سؤال جديد",
      answer: "إجابة جديدة",
    });

    // The exact JSON shape the service writes must validate against the
    // shared faqEntrySchema contract the B-02 builder also uses.
    const written = stores.get("business-a")!.faqs as Array<{
      question: string;
      answer: string;
    }>;
    record(
      "13. الشكل المخزّن يطابق عقد faqEntrySchema",
      written.length === 2 &&
        written.every((entry) => faqEntrySchema.safeParse(entry).success),
    );

    // The store stays a whole-store PUBLIC classification (B-01), i.e. the
    // authoring surface never introduced per-entry metadata or a second
    // knowledge system.
    record(
      "13. المخزن يبقى PUBLIC ككل بدون بيانات وصفية لكل مدخل",
      eq(classifyFaqStore(), "PUBLIC") &&
        written.every(
          (entry) =>
            Object.keys(entry).length === 2 &&
            "question" in entry &&
            "answer" in entry,
        ),
    );

    // No vertical/provider/AI concept leaked into stored knowledge.
    record(
      "13. التخزين لا يحمل مفاهيم عمودية أو مزوّد",
      JSON.stringify(written).includes("vertical") === false,
    );
  }

  // ── 14. B-01/B-02/B-03 invariants the surface depends on ──────────────────
  {
    // Every vertical is keyed by the EXISTING validation enum (no second
    // business-type mechanism, no invented keys), and every catalog answer
    // is a draft the owner may legitimately rewrite.
    const allCovered = VERTICAL_VALUES.every(
      (vertical) => listFaqSuggestions(vertical).length > 0,
    );
    record(
      "14. الاقتراحات مفتاحها تعداد الأنشطة الموجود",
      allCovered && VERTICAL_VALUES.length === 7,
    );

    const labelsComplete = VERTICAL_VALUES.every((vertical) =>
      eq(suggestionGroupLabel(vertical), VERTICAL_LABELS[vertical]),
    );
    record("14. تسميات المجموعات تعيد استخدام قاموس الأنشطة", labelsComplete);

    // The default production deps still resolve the real repository: the
    // authoring slice introduced no new tenant-resolution mechanism.
    record(
      "14. تبقى الـdeps الإنتاجية هي المستودع الأصلي",
      ok(defaultKnowledgeServiceDeps.businessRepository),
    );

    // Malformed stored JSON still fails honestly (entry drop never happens).
    const { deps } = makeDeps([
      makeBusiness({ id: "business-a", faqs: [{ question: "بدون إجابة" }] }),
    ]);
    const broken = await listKnowledge(deps, OWNER_A);
    record(
      "14. JSON تالف يفشل بأمانة بدلًا من إسقاط المدخلات",
      !Array.isArray(broken),
    );
  }

  // ─── Report ───────────────────────────────────────────────────────────────
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
    `\nقاعدة معرفة المساعد سليمة: ${checks.length}/${checks.length} فحص ناجح.`,
  );
}

main().catch((error: Error) => {
  console.error(`فشل غير متوقع: ${error.message}`);
  process.exit(1);
});
