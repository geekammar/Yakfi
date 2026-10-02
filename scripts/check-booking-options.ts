import type { Business } from "../src/types/domain";

/**
 * FlowPilot — ANY-PROVIDER BOOKING OPTIONS check (PROMPT-CORE-02).
 *
 * Verifies the deterministic booking options resolver with in-memory
 * repositories (no DB, no network):
 *   1. Any Provider → nearest useful options returned (2–3, ranked);
 *   2. ineligible Providers never appear (relations + tenant scope);
 *   3. a Provider with no availability is skipped;
 *   4. multiple eligible Providers are globally ranked by earliest;
 *   5. the result is capped at MAX_BOOKING_OPTIONS;
 *   6. ties break by the stable CORE-01 Provider order;
 *   7. a specific eligible Provider preference works;
 *   8. a Provider from another Business cannot leak (typed refusal);
 *   9. Branch scope is respected (eligibility + echo);
 *  10. no eligible Provider → explicit empty result;
 *  11. no availability → explicit empty result (closed/too long/full);
 *  12. service inactive/not found behave correctly (CORE-01 pass-through);
 *  13. no booking write occurs (only the availability read is touched);
 *  14. no LLM/WhatsApp/transport boundary is ever touched;
 *  15. no secret/auth fields in the result;
 *  16. input identity/business keys are stripped and never override
 *      the server tenant scope;
 *  plus determinism and the backfill policy (one Provider → its 2–3
 *  nearest slots).
 *
 * The availability primitives are the EXISTING availability layer's
 * (working hours, slot model, conflict rule) — this harness exercises
 * them through the resolver end-to-end. Run: pnpm check:booking-options
 *
 * Dummy env vars satisfy the fail-fast env validation of the imported
 * modules — no real connection is ever made (fake deps only).
 */

export {};

type Check = { label: string; pass: boolean };

async function main(): Promise<void> {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const { resolveBookingOptions, rankBookingOptions } =
    await import("../src/features/appointments/server/booking-options-service");
  const { resolveBookingOptionsInputSchema } =
    await import("../src/features/appointments/schemas/booking-options-schema");
  const { weekdayOf } =
    await import("../src/features/appointments/server/availability-service");
  const { MAX_BOOKING_OPTIONS } =
    await import("../src/features/appointments/types");

  const checks: Check[] = [];
  function check(label: string, pass: boolean): void {
    checks.push({ label, pass });
  }

  // ── Deterministic fixtures (valid UUIDs) ─────────────────────────────────
  const BUSINESS_A = "11111111-1111-4111-8111-111111111111";
  const BUSINESS_B = "22222222-2222-4222-8222-222222222222";
  const SERVICE_A = "33333333-3333-4333-8333-333333333333";
  const SERVICE_B = "34444444-4444-4444-8444-444444444444";
  const SERVICE_INACTIVE = "35555555-5555-4555-8555-555555555555";
  const BRANCH_A = "44444444-4444-4444-8444-444444444444";
  const BRANCH_B = "45555555-5555-4555-8555-555555555555";
  const P1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
  const P2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
  const P3 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
  const P4 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4";
  const P5 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5";
  const P6 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6";
  const U1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
  const U2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
  const U3 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3";
  const U4 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4";
  const U5 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5";
  const U6 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb6";
  // Fixed calendar date (never Date.now() — the resolver is
  // deterministic). 2026-09-14 is a Monday.
  const TEST_DATE = "2026-09-14";

  // ── In-memory repositories (fake deps only) ──────────────────────────────
  type ServiceRow = {
    id: string;
    businessId: string;
    name: string;
    description: null;
    durationMinutes: number;
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: null;
    priceType: string | null;
    priceAmount: number | null;
    priceMaxAmount: number | null;
    priceCurrency: string | null;
    priceNote: string | null;
  };
  type BranchRow = {
    id: string;
    businessId: string;
    name: string;
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: null;
  };
  type ProviderRow = {
    id: string;
    displayName: string | null;
    user: { name: string };
  };
  type BlockingRow = {
    assignedUserId: string;
    startTime: string;
    endTime: string;
  };

  const now = new Date();
  const services = new Map<string, ServiceRow>();
  const branches = new Map<string, BranchRow>();
  const businesses = new Map<string, Business>();
  const providerRows = new Map<string, ProviderRow[]>();
  const seams = new Map<string, { businessId: string; userId: string }>();
  const blocking = new Map<string, BlockingRow[]>();
  const listCalls: Array<{
    businessId: string;
    serviceId: string;
    branchId?: string;
  }> = [];
  const seamCalls: string[][] = [];
  const appointmentRepoAccesses: string[] = [];
  const providerRepoAccesses: string[] = [];

  function openWeek(testDay: string): Record<string, unknown> {
    const days = ["sat", "sun", "mon", "tue", "wed", "thu", "fri"];
    const hours: Record<string, unknown> = {};
    for (const day of days) {
      hours[day] =
        day === testDay
          ? { open: "10:00", close: "18:00", closed: false }
          : { open: "10:00", close: "18:00", closed: false };
    }
    return hours;
  }

  function businessRow(input: {
    id: string;
    durationMinutes?: number;
    closed?: boolean;
  }): Business {
    const testDay = weekdayOf(TEST_DATE);
    const hours = openWeek(testDay);
    if (input.closed) {
      hours[testDay] = { open: "10:00", close: "18:00", closed: true };
    }
    return {
      id: input.id,
      name: "منشأة",
      vertical: null,
      city: null,
      whatsappNumber: "+201000000000",
      timezone: "Africa/Cairo",
      about: null,
      workingHours: hours,
      slotDurationMinutes: 30,
      confirmationMode: "manual",
      faqs: [],
      cancellationPolicy: null,
      onboardingCompletedAt: now,
      isActive: true,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      defaultBranchId: null,
    } as unknown as Business;
  }

  function serviceRow(input: {
    id: string;
    businessId: string;
    durationMinutes?: number;
    isActive?: boolean;
  }): ServiceRow {
    return {
      id: input.id,
      businessId: input.businessId,
      name: "خدمة",
      description: null,
      durationMinutes: input.durationMinutes ?? 30,
      isActive: input.isActive ?? true,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      priceType: null,
      priceAmount: null,
      priceMaxAmount: null,
      priceCurrency: null,
      priceNote: null,
    };
  }

  function seedProviders(key: string, rows: ProviderRow[]): void {
    providerRows.set(key, rows);
  }

  function seedSeam(
    providerId: string,
    businessId: string,
    userId: string,
  ): void {
    seams.set(providerId, { businessId, userId });
  }

  function seedBlocking(userId: string, rows: BlockingRow[]): void {
    blocking.set(userId, rows);
  }

  function resetState(): void {
    providerRows.clear();
    blocking.clear();
  }

  const scopeKey = (businessId: string, branchId?: string): string =>
    `${businessId}:${SERVICE_A}:${branchId ?? "-"}`;

  const deps = {
    eligibility: {
      serviceRepository: {
        findById: async (id: string) => services.get(id) ?? null,
      },
      branchRepository: {
        findByIdWithinBusiness: async (id: string, businessId: string) => {
          const branch = branches.get(id);
          return branch && branch.businessId === businessId ? branch : null;
        },
      },
      providerRepository: {
        listEligibleForService: async (
          businessId: string,
          serviceId: string,
          options?: { branchId?: string },
        ) => {
          listCalls.push({
            businessId,
            serviceId,
            ...(options?.branchId ? { branchId: options.branchId } : {}),
          });
          const key = `${businessId}:${serviceId}:${options?.branchId ?? "-"}`;
          return providerRows.get(key) ?? [];
        },
      },
    },
    businessRepository: {
      findById: async (id: string) => businesses.get(id) ?? null,
    },
    serviceRepository: {
      findById: async (id: string) => services.get(id) ?? null,
    },
    providerRepository: new Proxy(
      {
        listAssignmentSeams: async (
          businessId: string,
          providerIds: string[],
        ) => {
          providerRepoAccesses.push("listAssignmentSeams");
          seamCalls.push([...providerIds]);
          return providerIds.flatMap((providerId) => {
            const seam = seams.get(providerId);
            return seam && seam.businessId === businessId
              ? [{ providerId, userId: seam.userId }]
              : [];
          });
        },
      },
      {
        get(target, prop) {
          providerRepoAccesses.push(String(prop));
          return (target as Record<string | symbol, unknown>)[prop];
        },
      },
    ),
    appointmentRepository: new Proxy(
      {
        listBlockingByAssignees: async (
          _businessId: string,
          _date: string,
          assignedUserIds: string[],
        ) => {
          appointmentRepoAccesses.push("listBlockingByAssignees");
          if (assignedUserIds.length === 0) return [];
          return assignedUserIds.flatMap(
            (userId) => blocking.get(userId) ?? [],
          );
        },
      },
      {
        get(target, prop) {
          appointmentRepoAccesses.push(String(prop));
          return (target as Record<string | symbol, unknown>)[prop];
        },
      },
    ),
  };

  // ── Shared fixture state ──────────────────────────────────────────────────
  businesses.set(BUSINESS_A, businessRow({ id: BUSINESS_A }));
  businesses.set(BUSINESS_B, businessRow({ id: BUSINESS_B }));
  services.set(
    SERVICE_A,
    serviceRow({ id: SERVICE_A, businessId: BUSINESS_A }),
  );
  services.set(
    SERVICE_INACTIVE,
    serviceRow({
      id: SERVICE_INACTIVE,
      businessId: BUSINESS_A,
      isActive: false,
    }),
  );
  services.set(
    SERVICE_B,
    serviceRow({ id: SERVICE_B, businessId: BUSINESS_B }),
  );
  branches.set(BRANCH_A, {
    id: BRANCH_A,
    businessId: BUSINESS_A,
    name: "الفرع الرئيسي",
    isActive: true,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  });
  branches.set(BRANCH_B, {
    id: BRANCH_B,
    businessId: BUSINESS_B,
    name: "فرع آخر",
    isActive: true,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  });
  seedSeam(P1, BUSINESS_A, U1);
  seedSeam(P2, BUSINESS_A, U2);
  seedSeam(P3, BUSINESS_A, U3);
  // P4 is eligible ONLY in BUSINESS_B (never in the A scope seed).
  seedSeam(P4, BUSINESS_B, U4);
  seedSeam(P5, BUSINESS_A, U5);
  seedSeam(P6, BUSINESS_A, U6);

  // ── 16. Input identity/business keys are stripped ────────────────────────
  const hostile = resolveBookingOptionsInputSchema.safeParse({
    serviceId: SERVICE_A,
    branchId: BRANCH_A,
    providerId: P2,
    date: TEST_DATE,
    businessId: BUSINESS_B,
    role: "ADMIN",
    accountType: "PLATFORM",
  });
  const hostileData = hostile.success
    ? (hostile.data as Record<string, unknown>)
    : {};
  check(
    "مفاتيح الهوية/المنشأة العدائية تُشطب من المدخل",
    hostile.success === true &&
      hostileData.businessId === undefined &&
      hostileData.role === undefined &&
      hostileData.accountType === undefined,
  );
  check(
    "المدخل لا يحمل سوى الخدمة والفرع والمزود والتاريخ",
    hostile.success === true && Object.keys(hostileData).length === 4,
  );

  // ── 2/14. Module surface — no AI/transport/WhatsApp boundary ─────────────
  const serviceModule =
    await import("../src/features/appointments/server/booking-options-service");
  const exportedNames = Object.keys(serviceModule);
  check(
    "الوحدة لا تصدّر أي حدود ذكاء/واتساب/نقل (منطق حتمي فقط)",
    exportedNames.every(
      (name) => !/ai|transport|whatsapp|llm|openrouter|agentrouter/i.test(name),
    ),
  );

  // ── 1/4/5. Any Provider → nearest useful options, globally ranked ────────
  resetState();
  seedProviders(scopeKey(BUSINESS_A), [
    { id: P1, displayName: "د. سارة", user: { name: "سارة" } },
    { id: P2, displayName: "د. أحمد", user: { name: "أحمد" } },
    { id: P3, displayName: "د. منى", user: { name: "منى" } },
    { id: P5, displayName: "د. هدى", user: { name: "هدى" } },
    { id: P6, displayName: "د. ليلى", user: { name: "ليلى" } },
  ]);
  seedBlocking(U1, [
    { assignedUserId: U1, startTime: "10:00", endTime: "11:00" },
  ]);
  seedBlocking(U3, [
    { assignedUserId: U3, startTime: "10:00", endTime: "14:00" },
  ]);
  seedBlocking(U5, [
    { assignedUserId: U5, startTime: "10:00", endTime: "15:00" },
  ]);
  seedBlocking(U6, [
    { assignedUserId: U6, startTime: "10:00", endTime: "16:00" },
  ]);
  const anyResult = await resolveBookingOptions(
    deps,
    { userId: "actor", businessId: BUSINESS_A },
    { serviceId: SERVICE_A, date: TEST_DATE },
  );
  check(
    "أي مزود → أقرب الخيارات المفيدة تُعاد",
    anyResult.success === true && anyResult.data.options.length === 3,
  );
  check(
    "الخيارات مرتّبة عالمياً بالأقدم (10:00 ثم 11:00 ثم 14:00)",
    anyResult.success === true &&
      anyResult.data.options.map((option) => option.providerId).join(",") ===
        [P2, P1, P3].join(",") &&
      anyResult.data.options[0]?.startAt === `${TEST_DATE}T10:00` &&
      anyResult.data.options[1]?.startAt === `${TEST_DATE}T11:00` &&
      anyResult.data.options[2]?.startAt === `${TEST_DATE}T14:00`,
  );
  check(
    "النتيجة محدودة بـ MAX_BOOKING_OPTIONS (5 مؤهلين → 3 خيارات)",
    anyResult.success === true &&
      anyResult.data.options.length === MAX_BOOKING_OPTIONS &&
      anyResult.reason === null,
  );
  check(
    "النطاق يُعاد (ANY، بلا فرع، التاريخ والمنطقة الزمنية)",
    anyResult.success === true &&
      anyResult.data.preference === "ANY" &&
      anyResult.data.branchId === null &&
      anyResult.data.date === TEST_DATE &&
      anyResult.data.timezone === "Africa/Cairo",
  );
  check(
    "endAt = startAt + مدة الخدمة (30 دقيقة)",
    anyResult.success === true &&
      anyResult.data.options.every((option) => {
        const start =
          Number(option.startAt.slice(11, 13)) * 60 +
          Number(option.startAt.slice(14, 16));
        const end =
          Number(option.endAt.slice(11, 13)) * 60 +
          Number(option.endAt.slice(14, 16));
        return end - start === 30 && option.startAt.slice(0, 10) === TEST_DATE;
      }),
  );

  // ── 2. Ineligible Provider never appears ─────────────────────────────────
  check(
    "مزود غير مؤهل لا يظهر أبداً (علاقات + نطاق المستأجر)",
    anyResult.success === true &&
      anyResult.data.options.every((option) => option.providerId !== P4),
  );

  // ── 15. No secret/auth fields in the result ──────────────────────────────
  const anyJson = anyResult.success ? JSON.stringify(anyResult) : "";
  check(
    "النتيجة مدمجة — لا أسرار ولا حقول توثيق/هوية",
    !/password|tokenhash|credential|secret|accounttype|session/i.test(anyJson),
  );

  // ── Determinism: repeated calls with the same state are identical ────────
  const anyAgain = await resolveBookingOptions(
    deps,
    { userId: "actor", businessId: BUSINESS_A },
    { serviceId: SERVICE_A, date: TEST_DATE },
  );
  check(
    "الحل حتمي — نتائج متطابقة لنفس الحالة",
    JSON.stringify(anyResult) === JSON.stringify(anyAgain),
  );

  // ── 3. Provider with no availability skipped ─────────────────────────────
  resetState();
  seedProviders(scopeKey(BUSINESS_A), [
    { id: P1, displayName: "د. سارة", user: { name: "سارة" } },
    { id: P2, displayName: "د. أحمد", user: { name: "أحمد" } },
    { id: P3, displayName: "د. منى", user: { name: "منى" } },
  ]);
  seedBlocking(U1, [
    { assignedUserId: U1, startTime: "10:00", endTime: "18:00" },
  ]);
  const skipResult = await resolveBookingOptions(
    deps,
    { userId: "actor", businessId: BUSINESS_A },
    { serviceId: SERVICE_A, date: TEST_DATE },
  );
  check(
    "مزود محجوز بالكامل يُستبعد — خيارات المؤهلين فقط ثم تعبئة",
    skipResult.success === true &&
      skipResult.data.options.length === MAX_BOOKING_OPTIONS &&
      skipResult.data.options.every((option) => option.providerId !== P1) &&
      skipResult.data.options[0]?.providerId === P2 &&
      skipResult.data.options[1]?.providerId === P3 &&
      skipResult.data.options[2]?.providerId === P2,
  );

  // ── 6. Stable deterministic tie-breaker (CORE-01 order) ──────────────────
  resetState();
  seedProviders(scopeKey(BUSINESS_A), [
    { id: P1, displayName: "د. سارة", user: { name: "سارة" } },
    { id: P2, displayName: "د. أحمد", user: { name: "أحمد" } },
    { id: P3, displayName: "د. منى", user: { name: "منى" } },
  ]);
  seedBlocking(U3, [
    { assignedUserId: U3, startTime: "10:00", endTime: "14:00" },
  ]);
  const tieResult = await resolveBookingOptions(
    deps,
    { userId: "actor", businessId: BUSINESS_A },
    { serviceId: SERVICE_A, date: TEST_DATE },
  );
  check(
    "تساوي الأوقات → الترتيب حتمي حسب ترتيب CORE-01 (P1 قبل P2)",
    tieResult.success === true &&
      tieResult.data.options.map((option) => option.providerId).join(",") ===
        [P1, P2, P3].join(","),
  );

  // ── rankBookingOptions: pure tie-break + backfill policy ─────────────────
  const tiePairs = [
    {
      providerOrder: 1,
      providerId: P2,
      displayName: "ب",
      startTime: "10:00",
      endTime: "10:30",
    },
    {
      providerOrder: 0,
      providerId: P1,
      displayName: "أ",
      startTime: "10:00",
      endTime: "10:30",
    },
  ];
  const tieRanked = rankBookingOptions(tiePairs, MAX_BOOKING_OPTIONS);
  check(
    "الترتيب الحتمي: تعادل الوقت → ترتيب الإنشاء (order 0 أولاً)",
    tieRanked[0]?.providerId === P1 && tieRanked.length === 2,
  );

  // ── Backfill: one Provider → its 2–3 nearest slots ───────────────────────
  resetState();
  seedProviders(scopeKey(BUSINESS_A), [
    { id: P1, displayName: "د. سارة", user: { name: "سارة" } },
  ]);
  seedBlocking(U1, [
    { assignedUserId: U1, startTime: "12:00", endTime: "18:00" },
  ]);
  const backfillResult = await resolveBookingOptions(
    deps,
    { userId: "actor", businessId: BUSINESS_A },
    { serviceId: SERVICE_A, date: TEST_DATE },
  );
  check(
    "مزود واحد → أقرب 3 مواعيد له (سياسة التعبئة)",
    backfillResult.success === true &&
      backfillResult.data.options.length === 3 &&
      backfillResult.data.options[0]?.startAt === `${TEST_DATE}T10:00` &&
      backfillResult.data.options[1]?.startAt === `${TEST_DATE}T10:30` &&
      backfillResult.data.options[2]?.startAt === `${TEST_DATE}T11:00`,
  );

  // ── 7. Specific eligible Provider preference works ───────────────────────
  resetState();
  seedProviders(scopeKey(BUSINESS_A), [
    { id: P1, displayName: "د. سارة", user: { name: "سارة" } },
    { id: P2, displayName: "د. أحمد", user: { name: "أحمد" } },
    { id: P3, displayName: "د. منى", user: { name: "منى" } },
  ]);
  seedBlocking(U2, [
    { assignedUserId: U2, startTime: "10:00", endTime: "10:30" },
  ]);
  const prefResult = await resolveBookingOptions(
    deps,
    { userId: "actor", businessId: BUSINESS_A },
    { serviceId: SERVICE_A, providerId: P2, date: TEST_DATE },
  );
  check(
    "تفضيل مزود مؤهل → خياراته فقط مع preference=PROVIDER",
    prefResult.success === true &&
      prefResult.data.preference === "PROVIDER" &&
      prefResult.data.options.length === 3 &&
      prefResult.data.options.every((option) => option.providerId === P2) &&
      prefResult.data.options[0]?.startAt === `${TEST_DATE}T10:30`,
  );

  // ── 8. Specific Provider from another Business cannot leak ───────────────
  const foreignProvider = await resolveBookingOptions(
    deps,
    { userId: "actor", businessId: BUSINESS_A },
    { serviceId: SERVICE_A, providerId: P4, date: TEST_DATE },
  );
  check(
    "مزود منشأة أخرى → PROVIDER_NOT_ELIGIBLE (بلا تسريب وجوده)",
    foreignProvider.success === false &&
      foreignProvider.error.code === "PROVIDER_NOT_ELIGIBLE",
  );

  // ── 9. Branch scope is respected ─────────────────────────────────────────
  resetState();
  seedProviders(scopeKey(BUSINESS_A), [
    { id: P1, displayName: "د. سارة", user: { name: "سارة" } },
    { id: P2, displayName: "د. أحمد", user: { name: "أحمد" } },
    { id: P3, displayName: "د. منى", user: { name: "منى" } },
  ]);
  seedProviders(scopeKey(BUSINESS_A, BRANCH_A), [
    { id: P1, displayName: "د. سارة", user: { name: "سارة" } },
    { id: P2, displayName: "د. أحمد", user: { name: "أحمد" } },
  ]);
  const branchResult = await resolveBookingOptions(
    deps,
    { userId: "actor", businessId: BUSINESS_A },
    { serviceId: SERVICE_A, branchId: BRANCH_A, date: TEST_DATE },
  );
  check(
    "نطاق الفرع → المؤهلون للفرع فقط + نطاق الفرع يُعاد",
    branchResult.success === true &&
      branchResult.data.branchId === BRANCH_A &&
      branchResult.data.options.length > 0 &&
      branchResult.data.options.every(
        (option) => option.providerId === P1 || option.providerId === P2,
      ),
  );
  const foreignBranch = await resolveBookingOptions(
    deps,
    { userId: "actor", businessId: BUSINESS_A },
    { serviceId: SERVICE_A, branchId: BRANCH_B, date: TEST_DATE },
  );
  check(
    "فرع منشأة أخرى → BRANCH_NOT_FOUND",
    foreignBranch.success === false &&
      foreignBranch.error.code === "BRANCH_NOT_FOUND",
  );

  // ── 10. No eligible Provider → explicit empty result ─────────────────────
  resetState();
  seedProviders(scopeKey(BUSINESS_A), []);
  const beforeSeamCalls = seamCalls.length;
  const noProviders = await resolveBookingOptions(
    deps,
    { userId: "actor", businessId: BUSINESS_A },
    { serviceId: SERVICE_A, date: TEST_DATE },
  );
  check(
    "لا مؤهلين → نتيجة فارغة صريحة (NO_ELIGIBLE_PROVIDERS)",
    noProviders.success === true &&
      noProviders.data.options.length === 0 &&
      noProviders.reason === "NO_ELIGIBLE_PROVIDERS",
  );
  check(
    "لا مؤهلين → لا استعلام توفر (توفر المزودين يسبقه)",
    seamCalls.length === beforeSeamCalls,
  );

  // ── 11. No availability → explicit empty results ─────────────────────────
  resetState();
  seedProviders(scopeKey(BUSINESS_A), [
    { id: P1, displayName: "د. سارة", user: { name: "سارة" } },
    { id: P2, displayName: "د. أحمد", user: { name: "أحمد" } },
  ]);
  businesses.set(BUSINESS_A, businessRow({ id: BUSINESS_A, closed: true }));
  const closed = await resolveBookingOptions(
    deps,
    { userId: "actor", businessId: BUSINESS_A },
    { serviceId: SERVICE_A, date: TEST_DATE },
  );
  check(
    "المنشأة مغلقة → BUSINESS_CLOSED (خيارات فارغة)",
    closed.success === true &&
      closed.data.options.length === 0 &&
      closed.reason === "BUSINESS_CLOSED",
  );

  services.set(
    SERVICE_A,
    serviceRow({ id: SERVICE_A, businessId: BUSINESS_A, durationMinutes: 600 }),
  );
  businesses.set(BUSINESS_A, businessRow({ id: BUSINESS_A }));
  const tooLong = await resolveBookingOptions(
    deps,
    { userId: "actor", businessId: BUSINESS_A },
    { serviceId: SERVICE_A, date: TEST_DATE },
  );
  check(
    "الخدمة أطول من يوم العمل → SERVICE_TOO_LONG",
    tooLong.success === true &&
      tooLong.data.options.length === 0 &&
      tooLong.reason === "SERVICE_TOO_LONG",
  );
  services.set(
    SERVICE_A,
    serviceRow({ id: SERVICE_A, businessId: BUSINESS_A }),
  );

  seedBlocking(U1, [
    { assignedUserId: U1, startTime: "10:00", endTime: "18:00" },
  ]);
  seedBlocking(U2, [
    { assignedUserId: U2, startTime: "10:00", endTime: "18:00" },
  ]);
  const fullyBooked = await resolveBookingOptions(
    deps,
    { userId: "actor", businessId: BUSINESS_A },
    { serviceId: SERVICE_A, date: TEST_DATE },
  );
  check(
    "كل المؤهلين محجوزون → FULLY_BOOKED (خيارات فارغة)",
    fullyBooked.success === true &&
      fullyBooked.data.options.length === 0 &&
      fullyBooked.reason === "FULLY_BOOKED",
  );

  // ── 12. Service inactive/not found behave correctly ──────────────────────
  const beforeInactiveSeams = seamCalls.length;
  const inactive = await resolveBookingOptions(
    deps,
    { userId: "actor", businessId: BUSINESS_A },
    { serviceId: SERVICE_INACTIVE, date: TEST_DATE },
  );
  check(
    "خدمة غير نشطة → SERVICE_INACTIVE (تمرير حتمي من CORE-01)",
    inactive.success === false && inactive.error.code === "SERVICE_INACTIVE",
  );
  check(
    "خدمة غير نشطة لا تصل لاستعلام التوفر",
    seamCalls.length === beforeInactiveSeams,
  );
  const unknownService = await resolveBookingOptions(
    deps,
    { userId: "actor", businessId: BUSINESS_A },
    { serviceId: "99999999-9999-4999-8999-999999999999", date: TEST_DATE },
  );
  check(
    "خدمة غير موجودة → SERVICE_NOT_FOUND",
    unknownService.success === false &&
      unknownService.error.code === "SERVICE_NOT_FOUND",
  );
  const badInput = await resolveBookingOptions(
    deps,
    { userId: "actor", businessId: BUSINESS_A },
    { serviceId: "not-a-uuid", date: TEST_DATE },
  );
  check(
    "معرّف خدمة غير صالح → INVALID_INPUT",
    badInput.success === false && badInput.error.code === "INVALID_INPUT",
  );

  // ── 16. Actor tenancy governs even with hostile input ────────────────────
  const lastCall = listCalls[listCalls.length - 1];
  check(
    "حل الأهلية يُقيَّد بمنشأة الفاعل دائماً (لا نطاق من العميل)",
    lastCall?.businessId === BUSINESS_A,
  );

  const noBusiness = await resolveBookingOptions(
    deps,
    { userId: "actor", businessId: null },
    { serviceId: SERVICE_A, date: TEST_DATE },
  );
  check(
    "فاعل بلا منشأة → NO_BUSINESS",
    noBusiness.success === false && noBusiness.error.code === "NO_BUSINESS",
  );

  // ── 13/14. Only availability reads were ever touched ─────────────────────
  check(
    "لا كتابة مواعيد — طبقة الحل قراءة فقط (لمس listBlockingByAssignees فقط)",
    appointmentRepoAccesses.length > 0 &&
      appointmentRepoAccesses.every(
        (access) => access === "listBlockingByAssignees",
      ),
  );
  check(
    "لا استدعاء ذكاء/نقل — لمس listAssignmentSeams فقط",
    providerRepoAccesses.length > 0 &&
      providerRepoAccesses.every((access) => access === "listAssignmentSeams"),
  );

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
    `\nثوابت خيارات الحجز صحيحة: ${checks.length}/${checks.length} فحص ناجح.`,
  );
}

main().catch((error: Error) => {
  console.error(`فشل غير متوقع: ${error.message}`);
  process.exit(1);
});
