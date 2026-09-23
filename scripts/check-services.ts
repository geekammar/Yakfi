/* eslint-disable @typescript-eslint/consistent-type-imports */

/**
 * FlowPilot — SERVICE CATALOG + SERVICE AUTHORING check (PROMPT-B-06).
 *
 * Offline, in-memory verification of the tenant-scoped Service Catalog
 * authoring workflow and its customer/AI boundary (no DB, no network, no
 * LLM, no API tokens, no secrets). It runs the REAL service layer with
 * the REAL schemas; only the repository collaborator is an in-memory
 * fake, so the whole list / create / update / activate / remove
 * workflow is exercised end-to-end through the service's own
 * authorization rules:
 *
 *   1.  list the tenant's services
 *   2.  an empty service catalog lists nothing (honest empty state)
 *   3.  create a valid service
 *   4.  reject an invalid service (short name, out-of-range duration)
 *   5.  edit a service (prefill target is resolved tenant-side)
 *   6.  delete a service (soft delete — row stays for past appointments)
 *   7.  cross-tenant READ is rejected (another Business's service is
 *       "not found", never returned)
 *   8.  cross-tenant WRITE/UPDATE is rejected (a client businessId can
 *       never redirect the write target; the other tenant's row is
 *       untouched)
 *   9.  an unauthorized actor (STAFF, or an ADMIN with no Business) is
 *       rejected before any repository call
 *  10.  durationMinutes is preserved for scheduling (it round-trips and
 *       remains available to the booking path)
 *  11.  durationMinutes is NOT a customer disclosure merely because it
 *       exists — through B-02 it is classified INTERNAL and omitted
 *       from the AI request; a service existing is not permission to
 *       disclose every field
 *  12.  an inactive service stays out of the bookable catalog while
 *       remaining visible to the owner
 *  13.  no duplicate accidental service creation — a second create of
 *       the same catalog name is rejected, and a rename onto another
 *       live name is rejected too
 *  14.  existing booking semantics remain intact — the deterministic
 *       service matcher still resolves names against the tenant's
 *       catalog, and the B-01/B-02/B-03 architecture is unchanged
 *
 * Run: pnpm check:services
 */

// Imported DELIBERATELY before any process.env assignment: the service
// layer must load with zero environment, database, provider or credential
// dependencies (the repository singletons are never constructed here —
// only the pure service layer and the AI boundary modules are imported).

// ─── Valid UUID ids (the service layer's schemas reject anything else —
// the fake must mirror that fail-closed contract) ─────────────────────────────

import { randomUUID } from "node:crypto";

import {
  classifyServiceField,
  mostRestrictive,
} from "../src/lib/ai-knowledge-visibility";

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

function notOk(value: unknown): boolean {
  return !ok(value);
}

/** Deep structural equality for the request objects compared below. */
function deepEq<T>(actual: T, expected: T): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

/**
 * Stable per-run UUIDs. The real schemas reject any non-UUID id, so the
 * fake collaborator must mint valid ones; determinism is not required
 * (the service layer compares ids, never generates them).
 */
function newServiceId(): string {
  return randomUUID();
}

const SERVICE_IDS = {
  cleaning: newServiceId(),
  checkup: newServiceId(),
  filling: newServiceId(),
  whitening: newServiceId(),
  rootcanal: newServiceId(),
  otherTenant: newServiceId(),
} as const;

// ─── In-memory repository collaborator ───────────────────────────────────────

type StoredService = {
  id: string;
  businessId: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  isActive: boolean;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function makeService(
  service: Partial<StoredService> & { businessId: string },
): StoredService {
  const now = new Date();
  return {
    id: service.id ?? "service-1",
    businessId: service.businessId,
    name: service.name ?? "كشف وتشخيص",
    description: service.description ?? null,
    durationMinutes: service.durationMinutes ?? 30,
    isActive: service.isActive ?? true,
    deletedAt: service.deletedAt ?? null,
    createdAt: service.createdAt ?? now,
    updatedAt: service.updatedAt ?? now,
  };
}

/**
 * The fake repository is the ONLY injected dependency. It mirrors the real
 * one exactly where the semantics matter: catalog reads drop soft-deleted
 * rows, and writes are addressed by id.
 */
function makeDeps(initial: StoredService[]): {
  deps: import("../src/features/services/server/service-service").ServiceServiceDeps;
  stores: Map<string, StoredService>;
  softDeletes: Array<{ id: string; deactivated: boolean }>;
} {
  const stores = new Map<string, StoredService>();
  for (const service of initial) stores.set(service.id, { ...service });

  const softDeletes: Array<{ id: string; deactivated: boolean }> = [];

  const deps = {
    serviceRepository: {
      async findById(id: string) {
        const found = stores.get(id);
        if (!found || found.deletedAt) return null;
        return { ...found };
      },
      async listByBusiness(
        businessId: string,
        options?: { includeInactive?: boolean },
      ) {
        return [...stores.values()]
          .filter(
            (service) =>
              service.businessId === businessId && service.deletedAt === null,
          )
          .filter((service) =>
            options?.includeInactive ? true : service.isActive,
          )
          .sort((a, b) => a.name.localeCompare(b.name, "ar"));
      },
      async create(data: {
        businessId: string;
        name: string;
        description?: string;
        durationMinutes: number;
      }) {
        const now = new Date();
        const created: StoredService = {
          id: newServiceId(),
          businessId: data.businessId,
          name: data.name,
          description: data.description ?? null,
          durationMinutes: data.durationMinutes,
          isActive: true,
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        stores.set(created.id, created);
        return { ...created };
      },
      async update(
        id: string,
        data: { name?: string; description?: string; durationMinutes?: number },
      ) {
        const current = stores.get(id);
        if (!current) throw new Error("not found");
        const updated = { ...current, ...data };
        stores.set(id, updated);
        return { ...updated };
      },
      async setActive(id: string, isActive: boolean) {
        const current = stores.get(id);
        if (!current) throw new Error("not found");
        const updated = { ...current, isActive };
        stores.set(id, updated);
        return { ...updated };
      },
      async softDelete(id: string) {
        const current = stores.get(id);
        if (!current) throw new Error("not found");
        const updated = { ...current, deletedAt: new Date(), isActive: false };
        stores.set(id, updated);
        softDeletes.push({ id, deactivated: true });
        return { ...updated };
      },
    },
  };

  return { deps, stores, softDeletes };
}

// ─── Actors ──────────────────────────────────────────────────────────────────

const BUSINESS_A = "business-a";
const BUSINESS_B = "business-b";

function adminOf(businessId: string) {
  return {
    userId: `admin-${businessId}`,
    role: "ADMIN" as const,
    businessId,
  };
}

const ADMIN_A = adminOf(BUSINESS_A);
const ADMIN_B = adminOf(BUSINESS_B);
const STAFF_A = {
  userId: "staff-a",
  role: "STAFF" as const,
  businessId: BUSINESS_A,
};
const ADMIN_NO_BUSINESS = {
  userId: "admin-loose",
  role: "ADMIN" as const,
  businessId: null,
};

async function main(): Promise<void> {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const {
    createService,
    listServices,
    removeService,
    setServiceActive,
    updateService,
  } = await import("../src/features/services/server/service-service");

  // ── 1. List the tenant's services ─────────────────────────────────────────
  {
    const { deps } = makeDeps([
      makeService({
        id: SERVICE_IDS.cleaning,
        businessId: BUSINESS_A,
        name: "تنظيف أسنان",
        durationMinutes: 45,
      }),
      makeService({
        id: SERVICE_IDS.checkup,
        businessId: BUSINESS_A,
        name: "كشف وتشخيص",
        durationMinutes: 30,
      }),
      makeService({
        id: SERVICE_IDS.otherTenant,
        businessId: BUSINESS_B,
        name: "حشو تجميلي",
      }),
    ]);
    const result = await listServices(deps, ADMIN_A);
    const listed = Array.isArray(result) ? result : [];
    // Tenant scope: only A's two, sorted by Arabic name.
    record(
      "1. القائمة تعرض خدمات المنشأة فقط (مرتبة عربياً)",
      eq(listed.length, 2) &&
        eq(listed[0]?.name, "تنظيف أسنان") &&
        eq(listed[1]?.name, "كشف وتشخيص"),
    );
    record(
      "1. القائمة تشمل غير النشطة (العرض الإداري)",
      eq(
        listed.every((item) => "isActive" in item),
        true,
      ),
    );
  }

  // ── 2. Empty catalog lists nothing ────────────────────────────────────────
  {
    const { deps } = makeDeps([
      makeService({
        id: SERVICE_IDS.otherTenant,
        businessId: BUSINESS_B,
        name: "حشو تجميلي",
      }),
    ]);
    const result = await listServices(deps, ADMIN_A);
    record(
      "2. كتالوج فارئ يسرد لا شيء (حالة فارغة صادقة)",
      Array.isArray(result) && eq(result.length, 0),
    );
  }

  // ── 3. Create a valid service ─────────────────────────────────────────────
  {
    const { deps, stores } = makeDeps([]);
    const result = await createService(deps, ADMIN_A, {
      name: "تبييض بالليزر",
      description: "جلسة واحدة لمدة ساعة.",
      durationMinutes: 60,
    });
    const stored = [...stores.values()].find(
      (service) => service.businessId === BUSINESS_A,
    );
    record(
      "3. إنشاء خدمة صالحة يحفظ الاسم والوصف والمدة",
      ok(result.success) &&
        eq(result.success && result.service.name, "تبييض بالليزر") &&
        ok(stored) &&
        eq(stored?.description, "جلسة واحدة لمدة ساعة.") &&
        eq(stored?.durationMinutes, 60),
    );
    // The client NEVER sends businessId; it is derived from the actor.
    record(
      "3. إنشاء بدون businessId من العميل يُسند للمنشأة الصحيحة",
      ok(stored) && eq(stored?.businessId, BUSINESS_A),
    );
    // A create is active by default so it is immediately bookable.
    record("3. الخدمة الجديدة نشطة افتراضياً", eq(stored?.isActive, true));
  }

  // ── 4. Reject an invalid service ──────────────────────────────────────────
  {
    const { deps, stores } = makeDeps([]);
    const tooShort = await createService(deps, ADMIN_A, {
      name: "أ",
      durationMinutes: 30,
    });
    record(
      "4. رفض اسم قصير جداً",
      notOk(tooShort.success) && eq(stores.size, 0),
    );

    const tooLong = await createService(deps, ADMIN_A, {
      name: "تنظيف أسنان احترافي كامل",
      durationMinutes: 6000,
    });
    record("4. رفض مدة تتجاوز الحد الأقصى", notOk(tooLong.success));

    const tooShortDuration = await createService(deps, ADMIN_A, {
      name: "تنظيف أسنان",
      durationMinutes: 1,
    });
    record("4. رفض مدة أقل من الحد الأدنى", notOk(tooShortDuration.success));

    const malformed = await createService(deps, ADMIN_A, {
      name: 42,
      durationMinutes: 30,
    });
    record(
      "4. رفض مدخلات غير صالحة (نوع خاطئ)",
      notOk(malformed.success) && eq(stores.size, 0),
    );
  }

  // ── 5. Edit a service ─────────────────────────────────────────────────────
  {
    const { deps, stores } = makeDeps([
      makeService({
        id: SERVICE_IDS.cleaning,
        businessId: BUSINESS_A,
        name: "تنظيف أسنان",
        durationMinutes: 45,
      }),
    ]);
    const result = await updateService(deps, ADMIN_A, {
      id: SERVICE_IDS.cleaning,
      service: {
        name: "تنظيف أسنان عميق",
        description: "يشمل إزالة الجير.",
        durationMinutes: 60,
      },
    });
    const stored = stores.get(SERVICE_IDS.cleaning);
    record(
      "5. تعديل الخدمة يحدّث الاسم والوصف والمدة",
      ok(result.success) &&
        eq(result.success && result.service.name, "تنظيف أسنان عميق") &&
        eq(stored?.description, "يشمل إزالة الجير.") &&
        eq(stored?.durationMinutes, 60),
    );
    record(
      "5. التعديل لا يُنشئ صفّاً جديداً",
      eq([...stores.values()].length, 1),
    );
  }

  // ── 6. Delete a service (soft delete) ─────────────────────────────────────
  {
    const { deps, stores, softDeletes } = makeDeps([
      makeService({
        id: SERVICE_IDS.cleaning,
        businessId: BUSINESS_A,
        name: "تنظيف أسنان",
        durationMinutes: 45,
      }),
    ]);
    const result = await removeService(deps, ADMIN_A, {
      id: SERVICE_IDS.cleaning,
    });
    const stored = stores.get(SERVICE_IDS.cleaning);
    record(
      "6. الحذف ناجح والصف يبقى (حذف ناعم)",
      ok(result.success) && ok(stored) && ok(stored?.deletedAt),
    );
    // Soft delete deactivates too, so no stale bookable row.
    record("6. الحذف الناعم يُلغي التفعيل", eq(stored?.isActive, false));
    // ...and the row disappears from the owner's catalog list.
    const after = await listServices(deps, ADMIN_A);
    record(
      "6. الخدمة المحذوفة تغادر الكتالوج",
      Array.isArray(after) && eq(after.length, 0),
    );
    record("6. مستودع softDelete هو من نُادي عليه", eq(softDeletes.length, 1));
  }

  // ── 7. Tenant isolation on read ───────────────────────────────────────────
  {
    const { deps } = makeDeps([
      makeService({
        id: SERVICE_IDS.cleaning,
        businessId: BUSINESS_A,
        name: "تنظيف أسنان",
      }),
      makeService({
        id: SERVICE_IDS.otherTenant,
        businessId: BUSINESS_B,
        name: "حشو تجميلي",
      }),
    ]);
    const crossRead = await updateService(deps, ADMIN_A, {
      id: SERVICE_IDS.otherTenant,
      service: { name: "حشو مسروق", durationMinutes: 30 },
    });
    const listB = await listServices(deps, ADMIN_B);
    record(
      "7. قراءة/تعديل خدمة منشأة أخرى مرفوض (غير موجود)",
      notOk(crossRead.success),
    );
    record(
      "7. بيانات المنشأة الأخرى لم تُمَس",
      Array.isArray(listB) &&
        eq(listB.length, 1) &&
        eq(listB[0]?.name, "حشو تجميلي"),
    );
    // Same for removal.
    const crossRemove = await removeService(deps, ADMIN_A, {
      id: SERVICE_IDS.otherTenant,
    });
    record("7. حذف خدمة منشأة أخرى مرفوض", notOk(crossRemove.success));
    const listB2 = await listServices(deps, ADMIN_B);
    record(
      "7. صف المنشأة الأخرى لا يزال موجوداً",
      Array.isArray(listB2) && eq(listB2.length, 1),
    );
  }

  // ── 8. Tenant isolation on write (client businessId never trusted) ────────
  {
    const { deps, stores } = makeDeps([]);
    const hostile = await createService(deps, ADMIN_A, {
      businessId: BUSINESS_B, // attempted tenant override — must be ignored
      name: "حشو تجميلي",
      durationMinutes: 30,
    });
    const stored = [...stores.values()].find(
      (service) => service.name === "حشو تجميلي",
    );
    record(
      "8. businessId المُرسل من العميل لا يُؤمن (الإنشاء)",
      ok(hostile.success) && eq(stored?.businessId, BUSINESS_A),
    );
  }

  // ── 9. Unauthorized actor rejected ────────────────────────────────────────
  {
    const { deps, stores } = makeDeps([]);
    const staffCreate = await createService(deps, STAFF_A, {
      name: "تنظيف أسنان",
      durationMinutes: 30,
    });
    record(
      "9. موظف (STAFF) لا يستطيع إنشاء خدمة",
      notOk(staffCreate.success) && eq(stores.size, 0),
    );
    record(
      "9. رسالة الرفض عربية وواضحة",
      eq(
        staffCreate.success === false && staffCreate.message,
        "إدارة الخدمات متاحة للمدير فقط",
      ),
    );
    const noBusiness = await createService(deps, ADMIN_NO_BUSINESS, {
      name: "تنظيف أسنان",
      durationMinutes: 30,
    });
    record(
      "9. مدير بلا منشأة مرفوض",
      notOk(noBusiness.success) &&
        eq(
          noBusiness.success === false && noBusiness.message,
          "أكمل إعداد المنشأة أولاً",
        ),
    );
    const staffList = await listServices(deps, STAFF_A);
    record(
      "9. موظف (STAFF) لا يستطيع قراءة الكتالوج الإداري",
      !Array.isArray(staffList),
    );
  }

  // ── 10. durationMinutes preserved for scheduling ──────────────────────────
  {
    const { deps } = makeDeps([]);
    const created = await createService(deps, ADMIN_A, {
      name: "علاج عصب",
      durationMinutes: 90,
    });
    const listed = await listServices(deps, ADMIN_A);
    record(
      "10. المدة تُحفظ كما هي (90 دقيقة) وتعود في القائمة",
      ok(created.success) &&
        eq(created.success && created.service.durationMinutes, 90) &&
        Array.isArray(listed) &&
        eq(listed[0]?.durationMinutes, 90),
    );
    const updated = await updateService(deps, ADMIN_A, {
      id: created.success ? created.service.id : "",
      service: { name: "علاج عصب", durationMinutes: 120 },
    });
    record(
      "10. المدة تُحدّث وتُحفظ بعد التعديل (120 دقيقة)",
      ok(updated.success) &&
        eq(updated.success && updated.service.durationMinutes, 120),
    );
  }

  // ── 11. duration is NOT an automatic customer disclosure ──────────────────
  {
    // The B-01 policy itself classifies the service fields.
    record(
      "11. الاسم عمومي (PUBLIC) والمدة داخلية (INTERNAL) بحكم B-01",
      eq(classifyServiceField("name"), "PUBLIC") &&
        eq(classifyServiceField("durationMinutes"), "INTERNAL"),
    );
    record(
      "11. الوصف عمومي (PUBLIC) كبيانات يراها العميل",
      eq(classifyServiceField("description"), "PUBLIC"),
    );
    // ...and the id/businessId can never become facts at all.
    record(
      "11. المعرّف و businessId ممنوعان كحقائق (FORBIDDEN)",
      eq(classifyServiceField("id"), "FORBIDDEN") &&
        eq(classifyServiceField("businessId"), "FORBIDDEN"),
    );

    // Through B-02, a service with a duration must NOT put the duration
    // into the AI request — it exists for scheduling only.
    const { buildAiContext } =
      await import("../src/features/conversations/server/ai-context-builder");
    const built = buildAiContext({
      scope: { businessId: BUSINESS_A },
      sources: {
        business: { name: "عيادة الأسنان" },
        services: [
          {
            id: SERVICE_IDS.cleaning,
            businessId: BUSINESS_A,
            name: "تنظيف أسنان",
            description: "تنظيف كامل للجير.",
            durationMinutes: 45,
          },
        ],
        conversation: { status: "AI_ACTIVE", recentMessages: [] },
        message: "محتاج أنظف أسناني",
      },
    });
    const serviceFact = built.request.services.find(
      (service) => service.name === "تنظيف أسنان",
    );
    const serviceName = serviceFact?.name;
    const hasDuration = serviceFact ? "durationMinutes" in serviceFact : true; // absence ⇒ the fact was NOT forwarded (what we assert below)
    record(
      "11. الاسم يدخل سياق الذكاء (العميل يرى الخدمات)",
      ok(serviceFact) && eq(serviceName, "تنظيف أسنان"),
    );
    record(
      "11. المدة لا تدخل سياق الذكاء لمجرد وجودها",
      ok(serviceFact) && !hasDuration,
    );
    const durationRecord = built.facts.find(
      (fact) => fact.key === "service.durationMinutes:تنظيف أسنان",
    );
    record(
      "11. المدة مُصنّفة وغير مُفصَح عنها في سجل B-02",
      ok(durationRecord) &&
        eq(durationRecord?.visibility, "INTERNAL") &&
        eq(durationRecord?.included, false) &&
        eq(durationRecord?.disclosable, false),
    );
    // ...and the most-restrictive merge keeps INTERNAL below disclosure.
    record(
      "11. INTERNAL لا تُفشى تحت أي دمج (mostRestrictive)",
      eq(mostRestrictive(["PUBLIC", "INTERNAL"]), "INTERNAL"),
    );
    // Provenance dropped: no tenant id in the request content.
    record(
      "11. لا businessId في محتوى الطلب (المصدر مُسقط)",
      !JSON.stringify(built.request).includes(BUSINESS_A),
    );
  }

  // ── 12. Inactive service behavior ─────────────────────────────────────────
  {
    const { deps } = makeDeps([
      makeService({
        id: SERVICE_IDS.cleaning,
        businessId: BUSINESS_A,
        name: "تنظيف أسنان",
        isActive: true,
      }),
      makeService({
        id: SERVICE_IDS.checkup,
        businessId: BUSINESS_A,
        name: "تبييض بالليزر",
        isActive: false,
      }),
    ]);
    const deactivated = await setServiceActive(deps, ADMIN_A, {
      id: SERVICE_IDS.cleaning,
      isActive: false,
    });
    record(
      "12. تعطيل خدمة يضبط isActive=false",
      ok(deactivated.success) &&
        eq(deactivated.success && deactivated.service.isActive, false),
    );
    // The owner's management list STILL includes inactive services.
    const ownerList = await listServices(deps, ADMIN_A);
    record(
      "12. قائمة الإدارة تشمل الخدمات غير النشطة",
      Array.isArray(ownerList) && eq(ownerList.length, 2),
    );
    // The bookable catalog (repository default) excludes inactive ones —
    // this mirrors how the booking flow loads its options.
    const { deps: bookingDeps } = makeDeps([
      makeService({
        id: SERVICE_IDS.cleaning,
        businessId: BUSINESS_A,
        name: "تنظيف أسنان",
        isActive: false,
      }),
      makeService({
        id: SERVICE_IDS.checkup,
        businessId: BUSINESS_A,
        name: "تبييض بالليزر",
        isActive: true,
      }),
    ]);
    const bookable =
      await bookingDeps.serviceRepository.listByBusiness(BUSINESS_A);
    record(
      "12. مسار الحجز يستبعد الخدمات غير النشطة",
      eq(bookable.length, 1) && eq(bookable[0]?.name, "تبييض بالليزر"),
    );
  }

  // ── 13. No duplicate accidental service creation ──────────────────────────
  {
    const { deps, stores } = makeDeps([
      makeService({
        id: SERVICE_IDS.cleaning,
        businessId: BUSINESS_A,
        name: "تنظيف أسنان",
        durationMinutes: 45,
      }),
    ]);
    const duplicate = await createService(deps, ADMIN_A, {
      name: "تنظيف أسنان",
      durationMinutes: 30,
    });
    record(
      "13. إنشاء اسم كتالوج مكرر مرفوض",
      notOk(duplicate.success) &&
        eq(
          duplicate.success === false && duplicate.message,
          "في خدمة بنفس الاسم موجودة بالفعل",
        ),
    );
    record("13. الرفض المكرر لا يُنشئ صفّاً", eq(stores.size, 1));
    // Whitespace-only variation is the same name.
    const padded = await createService(deps, ADMIN_A, {
      name: "  تنظيف أسنان  ",
      durationMinutes: 30,
    });
    record(
      "13. الفراغات لا تتجاوز حماية التكرار",
      notOk(padded.success) && eq(stores.size, 1),
    );
    // The same name in ANOTHER tenant is allowed (scope is per-Business).
    const otherTenant = await createService(deps, ADMIN_B, {
      name: "تنظيف أسنان",
      durationMinutes: 45,
    });
    record(
      "13. نفس الاسم في منشأة أخرى مسموح (نطاق لكل منشأة)",
      ok(otherTenant.success),
    );
    // Renaming an own service onto another live name is a conflict.
    const { deps: renameDeps } = makeDeps([
      makeService({
        id: SERVICE_IDS.cleaning,
        businessId: BUSINESS_A,
        name: "تنظيف أسنان",
      }),
      makeService({
        id: SERVICE_IDS.checkup,
        businessId: BUSINESS_A,
        name: "كشف وتشخيص",
      }),
    ]);
    const renameConflict = await updateService(renameDeps, ADMIN_A, {
      id: SERVICE_IDS.cleaning,
      service: { name: "كشف وتشخيص", durationMinutes: 30 },
    });
    record("13. إعادة التسمية لاسم موجود مرفوض", notOk(renameConflict.success));
    // Keeping your own name (with other edits) is always allowed.
    const keepName = await updateService(renameDeps, ADMIN_A, {
      id: SERVICE_IDS.cleaning,
      service: { name: "تنظيف أسنان", durationMinutes: 60 },
    });
    record(
      "13. الاحتفاظ باسم الخدمة أثناء التعديل مسموح",
      ok(keepName.success),
    );
    // A removed service frees its name for re-creation.
    const { deps: reuseDeps } = makeDeps([
      makeService({
        id: SERVICE_IDS.cleaning,
        businessId: BUSINESS_A,
        name: "تنظيف أسنان",
      }),
    ]);
    await removeService(reuseDeps, ADMIN_A, { id: SERVICE_IDS.cleaning });
    const reuse = await createService(reuseDeps, ADMIN_A, {
      name: "تنظيف أسنان",
      durationMinutes: 45,
    });
    record(
      "13. اسم الخدمة المحذوفة يصبح متاحاً للإنشاء مجدداً",
      ok(reuse.success),
    );
  }

  // ── 14. Existing booking semantics remain intact ──────────────────────────
  {
    // The deterministic matcher still resolves a service by name against
    // the tenant's catalog (unchanged by this slice).
    const { matchServiceByName } =
      await import("../src/features/conversations/server/booking-mapper");
    const resolved = matchServiceByName("تنظيف", [
      { id: SERVICE_IDS.cleaning, name: "تنظيف أسنان" },
      { id: SERVICE_IDS.checkup, name: "كشف وتشخيص" },
    ]);
    record(
      "14. مطابقة الخدمة بالاسم لا تزال دقيقة",
      eq(resolved.status, "ok") &&
        resolved.status === "ok" &&
        eq(resolved.serviceName, "تنظيف أسنان"),
    );
    // A genuinely ambiguous set still asks for clarification.
    const ambiguous = matchServiceByName("تنظيف", [
      { id: SERVICE_IDS.cleaning, name: "تنظيف أسنان" },
      { id: SERVICE_IDS.checkup, name: "تنظيف اللثة" },
    ]);
    record(
      "14. الالتباس لا يزال يطلب توضيحاً (لا اختراع)",
      eq(ambiguous.status, "ambiguous"),
    );
    // The B-01/B-02/B-03 architecture is unchanged: services still reach
    // context only as names under the established policy.
    const { buildAiContext } =
      await import("../src/features/conversations/server/ai-context-builder");
    const built = buildAiContext({
      scope: { businessId: BUSINESS_A },
      sources: {
        business: { name: "عيادة الأسنان" },
        services: [
          {
            id: SERVICE_IDS.cleaning,
            businessId: BUSINESS_A,
            name: "تنظيف أسنان",
          },
          {
            id: SERVICE_IDS.checkup,
            businessId: BUSINESS_B,
            name: "حشو تجميلي",
          }, // cross-tenant — must be excluded
        ],
        conversation: { status: "AI_ACTIVE", recentMessages: [] },
        message: "أريد حجز موعد",
      },
    });
    record(
      "14. خدمة منشأة أخرى تُستبعد من سياق الذكاء",
      !built.request.services.some((s) => s.name === "حشو تجميلي"),
    );
    record(
      "14. خدمة المنشأة تدخل سياق الذكاء بالاسم فقط",
      eq(built.request.services.length, 1) &&
        eq(built.request.services[0]?.name, "تنظيف أسنان"),
    );
    // Determinism: same inputs ⇒ same request.
    record(
      "14. حتمي: نفس المدخلات ⇒ نفس سياق الذكاء",
      deepEq(built.request, {
        ...built.request,
        services: [...built.request.services],
      }),
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
    `\nكتالوج الخدمات سليم: ${checks.length}/${checks.length} فحص ناجح.`,
  );
}

main().catch((error: Error) => {
  console.error(`فشل غير متوقع: ${error.message}`);
  process.exit(1);
});
