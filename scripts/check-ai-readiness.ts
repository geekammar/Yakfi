/**
 * FlowPilot — AI READINESS / LOW-FRICTION BUSINESS KNOWLEDGE check
 * (PROMPT-AI-OPS-21).
 *
 * Offline, in-memory verification of the behavior this slice INTRODUCED or
 * EXPOSED (no DB, no network, no LLM, no API tokens, no secrets). It runs
 * the REAL settings service, the REAL B-02 context builder, the REAL B-03
 * disclosure gate, the REAL readiness computation, and the REAL service
 * schemas; only the repository collaborator is an in-memory fake.
 *
 *   A. Business about authoring persistence (settings service)
 *   B. Location/address authoring persistence
 *   C. Partial-save behavior (both fields optional; clearing works)
 *   D. Authorization unchanged (ADMIN-only; own-Business-only write target)
 *   E. Readiness computation is deterministic and data-derived
 *   F. AI visibility of the newly authorable fields (about/address) through
 *      the EXISTING authorized context-builder channels
 *   G. Missing field ⇒ NO fabrication (disclosure gate refuses an unbacked
 *      location/business reply; the honest handoff semantics are intact)
 *   H. Tenant isolation unchanged (another Business's about/address never
 *      enters context)
 *   I. Service rules preserved (description optional, duration required,
 *      price optional, structured price formats)
 *
 * Run: pnpm check:ai-readiness
 */

import type { AiResponse } from "../src/features/conversations/server/ai-contract";
import type {
  SettingsActor,
  SettingsServiceDeps,
} from "../src/features/settings/server/settings-service";
import type { BusinessSettingsView } from "../src/features/settings/types";
import type { AiReadinessInput } from "../src/lib/ai-readiness";
import type { BusinessRepository } from "../src/server/repositories";
import type { Business, UserRole } from "../src/types/domain";

export {};

type Check = { label: string; pass: boolean };

const checks: Check[] = [];

function record(label: string, pass: boolean): void {
  checks.push({ label, pass });
}

// ─── In-memory business repository collaborator ──────────────────────────────

const NOW = new Date("2026-10-03T00:00:00.000Z");

function makeBusiness(overrides: Partial<Business> = {}): Business {
  return {
    id: "business-1",
    name: "مركز أفنان",
    vertical: "dental",
    city: "كفر الشيخ",
    whatsappNumber: "+201000000000",
    timezone: "Africa/Cairo",
    about: null,
    address: null,
    workingHours: null,
    slotDurationMinutes: 30,
    confirmationMode: "automatic",
    appointmentTimeDisplay: "START_ONLY",
    faqs: null,
    cancellationPolicy: null,
    onboardingCompletedAt: NOW,
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    assistantName: null,
    assistantStyle: null,
    defaultBranchId: "branch-1",
    reminderEnabled: false,
    reminderLeadHours: 24,
    reminderTemplateId: "standard",
    defaultServiceBookingEnabled: false,
    defaultBookingServiceId: null,
    ...overrides,
  };
}

function makeDeps(stored: Business): SettingsServiceDeps {
  const businesses = new Map<string, Business>([[stored.id, stored]]);
  const deps: SettingsServiceDeps = {
    businessRepository: {
      findById: async (id: string) => businesses.get(id) ?? null,
      update: async (
        id: string,
        data: Parameters<BusinessRepository["update"]>[1],
      ) => {
        const current = businesses.get(id);
        if (!current) throw new Error("not found");
        const next = { ...current, ...data, updatedAt: new Date() };
        businesses.set(id, next);
        return next;
      },
    } as Pick<BusinessRepository, "findById" | "update">,
  };
  return deps;
}

const ADMIN: SettingsActor = {
  userId: "user-1",
  role: "ADMIN" as UserRole,
  businessId: "business-1",
};

function asView(result: unknown): BusinessSettingsView | null {
  if (result && typeof result === "object" && "name" in result) {
    return result as BusinessSettingsView;
  }
  return null;
}

// ─── Context-builder source fixtures ─────────────────────────────────────────

function baseSources(overrides: {
  about?: string | null;
  address?: string | null;
}) {
  return {
    business: {
      businessId: "business-1",
      name: "مركز أفنان",
      about: overrides.about ?? null,
      address: overrides.address ?? null,
      faqs: [],
      whatsappNumber: "+201000000000",
      cancellationPolicy: null,
      workingHours: null,
      slotDurationMinutes: 30,
      confirmationMode: "automatic",
      timezone: "Africa/Cairo",
      vertical: "dental",
      city: "كفر الشيخ",
    },
    services: [],
    conversation: { status: "AI_ACTIVE" as const, recentMessages: [] },
    message: "أين موقعكم؟",
  };
}

// ─── Section A/B/C: settings authoring + partial save ────────────────────────

async function authoringSection(): Promise<void> {
  // Placeholder env before importing anything that transitively touches the
  // Prisma client (`@/server/repositories` → `db`). No connection is ever
  // opened: the repository is replaced by an in-memory fake, so the harness
  // stays offline (no DB, no network, no LLM, no secrets).
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
  const { getBusinessSettings, updateBusinessSettings } =
    await import("../src/features/settings/server/settings-service");

  // A. about persistence
  {
    const deps = makeDeps(makeBusiness());
    const update = await updateBusinessSettings(deps, ADMIN, {
      name: "مركز أفنان",
      vertical: "dental",
      city: "كفر الشيخ",
      whatsappNumber: "+201000000000",
      timezone: "Africa/Cairo",
      about: "عيادة أسنان متخصصة في تنظيف وحشو الأسنان.",
      address: "",
      confirmationMode: "automatic",
      cancellationPolicy: "يمكن الإلغاء قبل الموعد بـ ٢٤ ساعة.",
    });
    const view = asView(await getBusinessSettings(deps, ADMIN));
    record(
      "1. حفظ «نبذة عن المنشأة» يستمر ويُقرأ من سجل المنشأة",
      update.success &&
        view?.about === "عيادة أسنان متخصصة في تنظيف وحشو الأسنان.",
    );
  }

  // B. address persistence
  {
    const deps = makeDeps(makeBusiness());
    const update = await updateBusinessSettings(deps, ADMIN, {
      name: "مركز أفنان",
      vertical: "dental",
      city: "كفر الشيخ",
      whatsappNumber: "+201000000000",
      timezone: "Africa/Cairo",
      about: "",
      address: "كفر الشيخ — شارع الجمهورية، بجوار صيدلية النيل",
      confirmationMode: "automatic",
      cancellationPolicy: "يمكن الإلغاء قبل الموعد بـ ٢٤ ساعة.",
    });
    const view = asView(await getBusinessSettings(deps, ADMIN));
    record(
      "2. حفظ «موقع النشاط» يستمر ويُقرأ من سجل المنشأة",
      update.success &&
        view?.address === "كفر الشيخ — شارع الجمهورية، بجوار صيدلية النيل",
    );
  }

  // C. partial save: neither field → still succeeds, both read back empty
  {
    const deps = makeDeps(makeBusiness());
    const update = await updateBusinessSettings(deps, ADMIN, {
      name: "مركز أفنان",
      vertical: "dental",
      city: "كفر الشيخ",
      whatsappNumber: "+201000000000",
      timezone: "Africa/Cairo",
      about: "",
      address: "",
      confirmationMode: "automatic",
      cancellationPolicy: "يمكن الإلغاء قبل الموعد بـ ٢٤ ساعة.",
    });
    const view = asView(await getBusinessSettings(deps, ADMIN));
    record(
      "3. الحفظ الجزئي ناجح والمعلومات الاختيارية تبقى فارغة دون حظر",
      update.success && view?.about === "" && view?.address === "",
    );
  }

  // C-bis. partial save: about only
  {
    const deps = makeDeps(makeBusiness());
    await updateBusinessSettings(deps, ADMIN, {
      name: "مركز أفنان",
      vertical: "dental",
      city: "كفر الشيخ",
      whatsappNumber: "+201000000000",
      timezone: "Africa/Cairo",
      about: "نبذة قصيرة",
      address: "",
      confirmationMode: "automatic",
      cancellationPolicy: "يمكن الإلغاء قبل الموعد بـ ٢٤ ساعة.",
    });
    const view = asView(await getBusinessSettings(deps, ADMIN));
    record(
      "4. حفظ نبذة فقط يبقي الموقع ناقصًا (حفظ جزئي صادق)",
      view?.about === "نبذة قصيرة" && view?.address === "",
    );
  }

  // C-ter. clearing a previously-set field
  {
    const deps = makeDeps(
      makeBusiness({
        about: "نبذة قديمة",
        address: "عنوان قديم",
      }),
    );
    await updateBusinessSettings(deps, ADMIN, {
      name: "مركز أفنان",
      vertical: "dental",
      city: "كفر الشيخ",
      whatsappNumber: "+201000000000",
      timezone: "Africa/Cairo",
      about: "",
      address: "",
      confirmationMode: "automatic",
      cancellationPolicy: "يمكن الإلغاء قبل الموعد بـ ٢٤ ساعة.",
    });
    const view = asView(await getBusinessSettings(deps, ADMIN));
    record(
      "5. مسح الحقول الاختيارية يحفظها فارغة (لا تبيهات قديمة)",
      view?.about === "" && view?.address === "",
    );
  }

  // Bounding: overlong values are rejected
  {
    const deps = makeDeps(makeBusiness());
    const tooLong = await updateBusinessSettings(deps, ADMIN, {
      name: "مركز أفنان",
      vertical: "dental",
      city: "كفر الشيخ",
      whatsappNumber: "+201000000000",
      timezone: "Africa/Cairo",
      about: "x".repeat(2001),
      address: "y".repeat(501),
      confirmationMode: "automatic",
      cancellationPolicy: "يمكن الإلغاء قبل الموعد بـ ٢٤ ساعة.",
    });
    record(
      "6. النصوص الأطول من الحد المسموح تُرفض مع رسالة",
      tooLong.success === false,
    );
  }

  // D. authorization unchanged
  {
    const deps = makeDeps(makeBusiness());
    const staff = await updateBusinessSettings(
      deps,
      { ...ADMIN, role: "STAFF" as UserRole },
      { name: "محاولة تعديل" },
    );
    record("7. تعديل الإعدادات مخصص للمدير فقط", staff.success === false);
  }
  {
    const deps = makeDeps(makeBusiness());
    // A hostile client cannot redirect the write to another Business: the
    // schema strips unknown keys and the service always writes to the
    // actor's own businessId.
    await updateBusinessSettings(deps, ADMIN, {
      name: "مركز أفنان",
      vertical: "dental",
      city: "كفر الشيخ",
      whatsappNumber: "+201000000000",
      timezone: "Africa/Cairo",
      about: "نبذة",
      address: "عنوان",
      confirmationMode: "automatic",
      cancellationPolicy: "يمكن الإلغاء قبل الموعد بـ ٢٤ ساعة.",
      // A hostile client-supplied businessId: the Zod schema strips every
      // unknown key, and the service always writes to the actor's OWN
      // businessId — this payload must not redirect the write.
      businessId: "business-other",
    });
    const view = asView(await getBusinessSettings(deps, ADMIN));
    record(
      "8. معرّف المنشأة القادم من العميل لا يُعيد توجيه الكتابة",
      view?.about === "نبذة" && view?.address === "عنوان",
    );
  }
}

// ─── Section E: readiness computation ────────────────────────────────────────

async function readinessSection(): Promise<void> {
  const { aiReadinessCompleteCount, computeAiReadiness } =
    await import("../src/lib/ai-readiness");

  /**
   * Full-week hours record in the exact shape the onboarding wizard stores
   * (`workingHoursSchema` requires all seven day keys). Days not listed in
   * `open` are closed.
   */
  const DAYS = ["sat", "sun", "mon", "tue", "wed", "thu", "fri"] as const;
  function makeHours(
    open: Partial<Record<(typeof DAYS)[number], boolean>>,
  ): Record<string, { open: string; close: string; closed: boolean }> {
    return Object.fromEntries(
      DAYS.map((day) => [
        day,
        {
          open: "09:00",
          close: "17:00",
          closed: !open[day],
        },
      ]),
    );
  }

  const allMissing: AiReadinessInput = {
    about: null,
    address: null,
    workingHours: null,
    services: [],
    faqs: null,
  };
  const none = computeAiReadiness(allMissing);
  record(
    "9. نشاط بلا معلومات → كل العناصر ناقصة ولا شيء مكتمل",
    aiReadinessCompleteCount(none) === 0 &&
      none.every((item) => item.status === "missing"),
  );

  const full: AiReadinessInput = {
    about: "نبذة",
    address: "عنوان",
    workingHours: makeHours({ sat: true }),
    services: [
      {
        isActive: true,
        description: "وصف",
        priceType: "FIXED",
      },
    ],
    faqs: [{ question: "سؤال", answer: "إجابة" }],
  };
  const fullItems = computeAiReadiness(full);
  record(
    "10. نشاط مكتمل → كل العناصر مكتملة (٦/٦)",
    aiReadinessCompleteCount(fullItems) === 6 &&
      fullItems.every((item) => item.status === "complete"),
  );

  // hours
  const allClosed = computeAiReadiness({
    ...allMissing,
    workingHours: makeHours({}),
  });
  const hoursItem = allClosed.find((item) => item.key === "hours");
  record(
    "11. أوقات العمل: يوم مفتوح → مكتمل؛ كل الأيام مغلقة → ناقص",
    computeAiReadiness({
      ...allMissing,
      workingHours: makeHours({ sun: true }),
    }).find((item) => item.key === "hours")?.status === "complete" &&
      hoursItem?.status === "missing",
  );
  const brokenHours = computeAiReadiness({
    ...allMissing,
    workingHours: { notADay: { open: "x", close: "y", closed: false } },
  });
  record(
    "12. أوقات عمل تالفة → ناقص (فشل آمن دون استثناء)",
    brokenHours.find((item) => item.key === "hours")?.status === "missing",
  );

  // services complete on ≥1 ACTIVE service — the description is optional and
  // NON-GATING (PROMPT-AI-UX-01 §11): the assistant answers a catalog question
  // from the PUBLIC service names alone.
  const partial = computeAiReadiness({
    ...allMissing,
    services: [
      { isActive: true, description: "وصف", priceType: "FIXED" },
      { isActive: true, description: null, priceType: null },
    ],
  });
  record(
    "13. خدمة نشطة واحدة على الأقل → الخدمات مكتملة (الوصف اختياري وغير مُلزم)",
    partial.find((item) => item.key === "services")?.status === "complete" &&
      partial.find((item) => item.key === "services")?.count === 2,
  );

  // prices
  const priced = computeAiReadiness({
    ...allMissing,
    services: [{ isActive: true, description: null, priceType: "RANGE" }],
  });
  record(
    "14. سعر مخزَّن على الأقل لخدمة نشطة → الأسعار مكتملة",
    priced.find((item) => item.key === "prices")?.status === "complete" &&
      priced.find((item) => item.key === "prices")?.count === 1,
  );

  // faqs count
  const withFaqs = computeAiReadiness({
    ...allMissing,
    faqs: Array.from({ length: 12 }, () => ({ question: "س", answer: "ج" })),
  });
  record(
    "15. عدد الأسئلة الشائعة يظهر صادقًا (١٢)",
    withFaqs.find((item) => item.key === "faqs")?.count === 12 &&
      withFaqs.find((item) => item.key === "faqs")?.status === "complete",
  );

  // determinism
  const a = computeAiReadiness(full);
  const b = computeAiReadiness(full);
  record(
    "16. حساب الجاهزية حتمي: نفس المدخلات ⇒ نفس الناتج",
    JSON.stringify(a) === JSON.stringify(b),
  );

  // links point at the existing editors
  record(
    "17. كل عنصر يربط بمحرر موجود بالفعل",
    none.every(
      (item) => typeof item.href === "string" && item.href.startsWith("/"),
    ) &&
      fullItems.find((item) => item.key === "faqs")?.href ===
        "/settings/knowledge" &&
      fullItems.find((item) => item.key === "services")?.href === "/services" &&
      fullItems.find((item) => item.key === "hours")?.href ===
        "/onboarding/hours",
  );
}

// ─── Section F/G/H: AI visibility, no fabrication, tenant isolation ──────────

async function visibilitySection(): Promise<void> {
  const { buildAiContext } =
    await import("../src/features/conversations/server/ai-context-builder");
  const { enforceDisclosure } =
    await import("../src/features/conversations/server/ai-disclosure/disclosure-gate");
  const { emptyAiExtraction } =
    await import("../src/features/conversations/server/ai-contract");

  function locationReply(content: string): AiResponse {
    return {
      intent: "FAQ",
      action: "reply",
      content,
      extraction: emptyAiExtraction,
      handoffReason: null,
      summary: null,
    };
  }

  const scope = { businessId: "business-1" };

  // F. address carried on a location turn
  {
    const built = buildAiContext({
      scope,
      sources: baseSources({ address: "كفر الشيخ — شارع الجمهورية" }),
    });
    record(
      "18. سؤال الموقع يحمل العنوان المخزَّن عبر قناة businessAddress",
      built.request.businessAddress === "كفر الشيخ — شارع الجمهورية" &&
        built.facts.some(
          (fact) => fact.key === "business.address" && fact.included,
        ),
    );
  }

  // F-bis. address NOT carried on an unrelated (booking-only) turn
  {
    const built = buildAiContext({
      scope,
      sources: {
        ...baseSources({ address: "كفر الشيخ — شارع الجمهورية" }),
        message: "عايز أحجز بكرة",
      },
    });
    record(
      "19. دورة حجز لا تحمل العنوان (القناة مقيَّدة بالسؤال)",
      built.request.businessAddress === undefined &&
        built.facts.some(
          (fact) => fact.key === "business.address" && !fact.included,
        ),
    );
  }

  // F-ter. about carried on a business-info turn
  {
    const built = buildAiContext({
      scope,
      sources: {
        ...baseSources({ about: "عيادة أسنان متخصصة." }),
        message: "احكيلي عن العيادة",
      },
    });
    record(
      "20. سؤال عن النشاط يحمل النبذة عبر قناة businessAbout",
      built.request.businessAbout === "عيادة أسنان متخصصة.",
    );
  }

  // G. missing address ⇒ no fabrication (builder side)
  {
    const built = buildAiContext({
      scope,
      sources: baseSources({ address: null }),
    });
    record(
      "21. عنوان مفقود ⇒ لا توجد قناة عنوان في الطلب (لا اختراع)",
      built.request.businessAddress === undefined,
    );
  }

  // G-bis. missing address ⇒ disclosure gate refuses the location reply
  {
    const built = buildAiContext({
      scope,
      sources: baseSources({ address: null }),
    });
    const decision = enforceDisclosure({
      response: locationReply("نحن في كفر الشيخ بشارع الجمهورية."),
      context: { request: built.request, facts: built.facts },
    });
    record(
      "22. رد بموقع غير مدعوم → يحتاج تدخل بشري (UNAVAILABLE_IN_REQUEST)",
      decision.kind === "requires-human" &&
        decision.reason === "UNAVAILABLE_IN_REQUEST",
    );
  }

  // G-ter. present address ⇒ disclosure gate discloses the backed reply
  {
    const built = buildAiContext({
      scope,
      sources: { ...baseSources({ address: "كفر الشيخ — شارع الجمهورية" }) },
    });
    const decision = enforceDisclosure({
      response: locationReply("نحن في كفر الشيخ — شارع الجمهورية."),
      context: { request: built.request, facts: built.facts },
    });
    record(
      "23. رد بموقع مدعوم بعنوان مخزَّن → يُكشف وفق سياسة B-03",
      decision.kind === "disclosed" &&
        decision.support.includes("business.address"),
    );
  }

  // G-quater. an invented location reply on an UNARMED turn is still refused
  {
    const built = buildAiContext({
      scope,
      sources: {
        ...baseSources({ address: "كفر الشيخ — شارع الجمهورية" }),
        message: "عايز أحجز بكرة",
      },
    });
    const decision = enforceDisclosure({
      response: locationReply("نحن في كفر الشيخ — شارع الجمهورية."),
      context: { request: built.request, facts: built.facts },
    });
    record(
      "24. رد بموقع على دورة غير موقعية → مرفوض (العائلة غير مسلَّحة)",
      decision.kind === "requires-human",
    );
  }

  // H. tenant isolation: another Business's about/address never enter context
  {
    const built = buildAiContext({
      scope,
      sources: {
        ...baseSources({ about: "نبذة نشاط آخر", address: "عنوان نشاط آخر" }),
        business: {
          ...baseSources({ about: "نبذة نشاط آخر", address: "عنوان نشاط آخر" })
            .business,
          businessId: "business-other",
        },
      },
    });
    record(
      "25. بيانات منشأة أخرى لا تدور سياق المساعد (عزل المستأجر)",
      built.request.businessAbout === undefined &&
        built.request.businessAddress === undefined &&
        built.excluded.some((fact) => fact.key === "business.address") &&
        built.excluded.some((fact) => fact.key === "business.about"),
    );
  }
}

// ─── Section I: preserved service rules ──────────────────────────────────────

async function serviceRulesSection(): Promise<void> {
  const { serviceFormSchema } =
    await import("../src/features/services/schemas/service-schema");
  const { formatServicePrice } = await import("../src/lib/service-price");

  const validBase = {
    name: "تنظيف الأسنان",
    durationMinutes: 30,
  };

  // description optional
  const noDescription = serviceFormSchema.safeParse({
    ...validBase,
    description: "",
  });
  const omittedDescription = serviceFormSchema.safeParse(validBase);
  record(
    "26. وصف الخدمة اختياري (فارغ أو غير موجود)",
    noDescription.success === true && omittedDescription.success === true,
  );

  // duration required
  const noDuration = serviceFormSchema.safeParse({
    name: "تنظيف الأسنان",
    durationMinutes: undefined,
  });
  const tooShort = serviceFormSchema.safeParse({
    ...validBase,
    durationMinutes: 1,
  });
  record(
    "27. مدة الخدمة مطلوبة وضمن النطاق المسموح",
    noDuration.success === false && tooShort.success === false,
  );

  // price optional
  const noPrice = serviceFormSchema.safeParse({ ...validBase });
  record(
    "28. سعر الخدمة اختياري (الحجز يتحقق بالمدة فقط)",
    noPrice.success === true,
  );

  // structured price formats unchanged
  const fixed = formatServicePrice({
    priceType: "FIXED",
    priceAmount: 300,
    priceMaxAmount: null,
    priceCurrency: "EGP",
    priceNote: null,
  });
  const range = formatServicePrice({
    priceType: "RANGE",
    priceAmount: 300,
    priceMaxAmount: 500,
    priceCurrency: "EGP",
    priceNote: null,
  });
  const starting = formatServicePrice({
    priceType: "STARTING_FROM",
    priceAmount: 300,
    priceMaxAmount: null,
    priceCurrency: "EGP",
    priceNote: null,
  });
  const conditional = formatServicePrice({
    priceType: "CONDITIONAL",
    priceAmount: null,
    priceMaxAmount: null,
    priceCurrency: null,
    priceNote: "حسب الحالة",
  });
  const absent = formatServicePrice({
    priceType: null,
    priceAmount: null,
    priceMaxAmount: null,
    priceCurrency: null,
    priceNote: null,
  });
  record(
    "29. صيغ الأسعار المنظَّمة unchanged (ثابت/نطاق/يبدأ من/حسب الحالة/بدون)",
    typeof fixed === "string" &&
      fixed.includes("300") &&
      typeof range === "string" &&
      range.includes("500") &&
      typeof starting === "string" &&
      typeof conditional === "string" &&
      !/\d/.test(conditional) &&
      absent === null,
  );
}

// ─── Runner ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await authoringSection();
  await readinessSection();
  await visibilitySection();
  await serviceRulesSection();

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
    `\nجاهزية معلومات المساعد سليمة: ${checks.length}/${checks.length} فحص ناجح.`,
  );
}

main().catch((error: Error) => {
  console.error(`فشل غير متوقع: ${error.message}`);
  process.exit(1);
});
