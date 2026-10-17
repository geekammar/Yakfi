/**
 * FlowPilot — PROVIDER / SERVICE ELIGIBILITY check (PROMPT-CORE-01).
 *
 * Verifies the deterministic eligibility resolver with in-memory
 * repositories (no DB, no network):
 *   1. eligible Provider + eligible Service → returned (compact DTO);
 *   2. Provider without ProviderService → excluded (relation required);
 *   3. inactive Provider → excluded (isActive enforced);
 *   4. inactive Service → no eligibility (typed SERVICE_INACTIVE);
 *   5. Service from another Business → SERVICE_NOT_FOUND (no leak);
 *   6. Provider from another Business → excluded (tenant constraint);
 *   7. Branch from another Business → BRANCH_NOT_FOUND (no leak);
 *   8. valid same-Business Branch → included, scope echoed back;
 *   9. duplicate ProviderService relations cannot duplicate DTOs;
 *  10. hostile client identity/business keys are stripped by the input
 *      schema and never override the server tenant scope;
 *  11. the result is compact — no secrets/auth data;
 *  plus determinism: repeated calls with the same state are identical.
 *
 * The persisted-relation query constraints are verified through the
 * pure `eligibleProvidersWhere` builder (the repository query's only
 * consumer). Run: pnpm check:eligibility
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

  const { eligibleProvidersWhere } =
    await import("../src/server/repositories/provider.repository");
  const { resolveEligibleProviders } =
    await import("../src/features/appointments/server/provider-eligibility-service");
  const { resolveEligibleProvidersInputSchema } =
    await import("../src/features/appointments/schemas/provider-eligibility-schema");

  const checks: Check[] = [];
  function check(label: string, pass: boolean): void {
    checks.push({ label, pass });
  }

  // ── Deterministic fixtures (valid UUIDs) ─────────────────────────────────
  const BUSINESS_A = "11111111-1111-4111-8111-111111111111";
  const BUSINESS_B = "22222222-2222-4222-8222-222222222222";
  const SERVICE_A = "33333333-3333-4333-8333-333333333333";
  const SERVICE_B = "34444444-4444-4444-8444-444444444444";
  const BRANCH_A = "44444444-4444-4444-8444-444444444444";
  const BRANCH_B = "45555555-5555-4555-8555-555555555555";
  const PROVIDER_ACTIVE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";

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
    deletedAt: Date | null;
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
    deletedAt: Date | null;
  };
  type ProviderRow = {
    id: string;
    displayName: string | null;
    user: { name: string };
  };
  type ListCall = {
    businessId: string;
    serviceId: string;
    options?: { branchId?: string };
  };

  const now = new Date();
  const services = new Map<string, ServiceRow>();
  const branches = new Map<string, BranchRow>();
  const providerRows = new Map<string, ProviderRow[]>();
  const listCalls: ListCall[] = [];

  const deps = {
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
        listCalls.push({ businessId, serviceId, options });
        const key = `${businessId}:${serviceId}:${options?.branchId ?? "-"}`;
        return providerRows.get(key) ?? [];
      },
    },
  };

  function serviceRow(input: {
    id: string;
    businessId: string;
    isActive?: boolean;
  }): ServiceRow {
    return {
      id: input.id,
      businessId: input.businessId,
      name: "خدمة",
      description: null,
      durationMinutes: 30,
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

  const scopeKey = (businessId: string, branchId?: string): string =>
    `${businessId}:${SERVICE_A}:${branchId ?? "-"}`;

  // ── The persisted-relation query constraints (pure builder) ──────────────
  type LooseWhere = {
    businessId?: string;
    isActive?: boolean;
    OR?: Array<{
      servicePolicy?: string;
      exclusions?: { none?: { serviceId?: string } };
      services?: {
        some?: {
          serviceId?: string;
          service?: {
            businessId?: string;
            isActive?: boolean;
            deletedAt?: Date | null;
          };
        };
      };
    }>;
    branches?: {
      some?: {
        branchId?: string;
        branch?: { businessId?: string; deletedAt?: Date | null };
      };
    };
  };

  const whereNoBranch = eligibleProvidersWhere(
    BUSINESS_A,
    SERVICE_A,
  ) as unknown as LooseWhere;

  // Rule 1/6: the provider itself is Business-scoped.
  check(
    "الاستعلام يقيّد المزود بمنشأته (نطاق المستأجر)",
    whereNoBranch.businessId === BUSINESS_A,
  );
  // Rule 2: the provider must be active.
  check("الاستعلام يشترط مزوداً نشطاً", whereNoBranch.isActive === true);

  const allServicesBranch = whereNoBranch.OR?.find(
    (b) => b.servicePolicy === "ALL_SERVICES",
  );
  const specificServicesBranch = whereNoBranch.OR?.find(
    (b) => b.servicePolicy === "SPECIFIC_SERVICES",
  );

  // Rules 5/3/4: the ProviderService relation + the Service's own validity.
  check(
    "الاستعلام يشترط سياسة ALL_SERVICES واستبعاد الاستثناءات أو علاقة ProviderService",
    allServicesBranch?.exclusions?.none?.serviceId === SERVICE_A &&
      specificServicesBranch?.services?.some?.serviceId === SERVICE_A,
  );
  check(
    "علاقة الأهلية ترفض خدمة منشأة أخرى",
    specificServicesBranch?.services?.some?.service?.businessId === BUSINESS_A,
  );
  check(
    "علاقة الأهلية تشترط خدمة نشطة وغير محذوفة",
    specificServicesBranch?.services?.some?.service?.isActive === true &&
      specificServicesBranch?.services?.some?.service?.deletedAt === null,
  );
  // Rule 6 (no Branch scope): ProviderBranch must NOT be required.
  check(
    "بدون نطاق فرع لا يُشترط ProviderBranch",
    whereNoBranch.branches === undefined,
  );
  // Rule 9: the filter is an existence filter (some/none), never a join —
  // a repeated relation cannot multiply provider rows.
  check(
    "مرشح الأهلية وجودي (some) — صف فريد لكل مزود",
    specificServicesBranch?.services?.some !== undefined &&
      !Array.isArray(specificServicesBranch.services.some),
  );

  const whereBranch = eligibleProvidersWhere(BUSINESS_A, SERVICE_A, {
    branchId: BRANCH_A,
  }) as unknown as LooseWhere;

  // Rules 6/7 (Branch scope): the ProviderBranch relation + same Business.
  check(
    "مع نطاق فرع يُشترط ProviderBranch بالفرع المطلوب",
    whereBranch.branches?.some?.branchId === BRANCH_A,
  );
  check(
    "علاقة الفرع ترفض فرع منشأة أخرى",
    whereBranch.branches?.some?.branch?.businessId === BUSINESS_A,
  );

  // ── 1. Eligible Provider + eligible Service → returned ───────────────────
  services.set(
    SERVICE_A,
    serviceRow({ id: SERVICE_A, businessId: BUSINESS_A }),
  );
  seedProviders(scopeKey(BUSINESS_A), [
    { id: PROVIDER_ACTIVE, displayName: null, user: { name: "د. سارة" } },
  ]);
  const ok = await resolveEligibleProviders(
    deps,
    { businessId: BUSINESS_A },
    { serviceId: SERVICE_A },
  );
  check(
    "مزود مؤهل + خدمة مؤهلة → يُعاد المزود",
    ok.success === true &&
      ok.data.providers.length === 1 &&
      ok.data.providers[0]?.providerId === PROVIDER_ACTIVE,
  );
  check(
    "اسم العرض يحلّ من اسم العضو عند غياب displayName",
    ok.success === true && ok.data.providers[0]?.displayName === "د. سارة",
  );
  check(
    "كل مزود يُنتج DTO واحداً (providerId + displayName فقط)",
    ok.success === true &&
      (ok.data.providers[0] ?? {}).constructor === Object &&
      Object.keys(ok.data.providers[0] ?? {}).length === 2,
  );
  check(
    "لا businessId في النتيجة (النطاق ضمني)",
    ok.success === true && !("businessId" in ok.data),
  );

  // ── 11. Compact result — no secrets/auth data ────────────────────────────
  const okJson = ok.success ? JSON.stringify(ok) : "";
  check(
    "النتيجة مدمجة — لا أسرار ولا حقول توثيق/هوية",
    !/password|tokenhash|credential|secret|accounttype|session/i.test(okJson),
  );

  // Determinism: repeated calls with the same persisted state.
  const okAgain = await resolveEligibleProviders(
    deps,
    { businessId: BUSINESS_A },
    { serviceId: SERVICE_A },
  );
  check(
    "الحل حتمي — نتائج متطابقة لنفس الحالة",
    JSON.stringify(ok) === JSON.stringify(okAgain),
  );

  // ── 2. Provider without ProviderService → excluded ───────────────────────
  seedProviders(scopeKey(BUSINESS_A), []);
  const noLink = await resolveEligibleProviders(
    deps,
    { businessId: BUSINESS_A },
    { serviceId: SERVICE_A },
  );
  check(
    "مزود بدون علاقة ProviderService → مستبعد",
    noLink.success === true && noLink.data.providers.length === 0,
  );

  // ── 4. Service inactive → no eligibility ─────────────────────────────────
  const SERVICE_INACTIVE = "36666666-6666-4666-8666-666666666666";
  services.set(
    SERVICE_INACTIVE,
    serviceRow({
      id: SERVICE_INACTIVE,
      businessId: BUSINESS_A,
      isActive: false,
    }),
  );
  const beforeInactive = listCalls.length;
  const inactive = await resolveEligibleProviders(
    deps,
    { businessId: BUSINESS_A },
    { serviceId: SERVICE_INACTIVE },
  );
  check(
    "خدمة غير نشطة → SERVICE_INACTIVE (لا أهلية)",
    inactive.success === false && inactive.error.code === "SERVICE_INACTIVE",
  );
  check(
    "خدمة غير نشطة لا تصل لاستعلام المزودين",
    listCalls.length === beforeInactive,
  );

  // ── 5. Service from another Business → rejected safely ───────────────────
  services.set(
    SERVICE_B,
    serviceRow({ id: SERVICE_B, businessId: BUSINESS_B }),
  );
  const beforeForeignService = listCalls.length;
  const foreignService = await resolveEligibleProviders(
    deps,
    { businessId: BUSINESS_A },
    { serviceId: SERVICE_B },
  );
  check(
    "خدمة منشأة أخرى → SERVICE_NOT_FOUND (بلا تسريب)",
    foreignService.success === false &&
      foreignService.error.code === "SERVICE_NOT_FOUND",
  );
  check(
    "خدمة منشأة أخرى لا تصل لاستعلام المزودين",
    listCalls.length === beforeForeignService,
  );

  // ── 6. Provider from another Business → excluded ─────────────────────────
  seedProviders(`${BUSINESS_B}:${SERVICE_B}:-`, []);
  const asBusinessB = await resolveEligibleProviders(
    deps,
    { businessId: BUSINESS_B },
    { serviceId: SERVICE_B },
  );
  const lastCall = listCalls[listCalls.length - 1];
  check(
    "مزودو منشأة أخرى لا يظهرون في نطاق منشأة ثانية",
    asBusinessB.success === true && asBusinessB.data.providers.length === 0,
  );
  check(
    "استعلام المزودين يُقيَّد بمنشأة الفاعل (لا نطاق من العميل)",
    lastCall?.businessId === BUSINESS_B,
  );

  // ── 7. Branch from another Business → rejected safely ────────────────────
  const foreignBranch = await resolveEligibleProviders(
    deps,
    { businessId: BUSINESS_A },
    { serviceId: SERVICE_A, branchId: BRANCH_B },
  );
  check(
    "فرع منشأة أخرى → BRANCH_NOT_FOUND",
    foreignBranch.success === false &&
      foreignBranch.error.code === "BRANCH_NOT_FOUND",
  );

  // ── 8. Valid same-Business Branch → included ─────────────────────────────
  branches.set(BRANCH_A, {
    id: BRANCH_A,
    businessId: BUSINESS_A,
    name: "الفرع الرئيسي",
    isActive: true,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  });
  seedProviders(scopeKey(BUSINESS_A, BRANCH_A), [
    {
      id: PROVIDER_ACTIVE,
      displayName: "د. أحمد",
      user: { name: "أحمد" },
    },
  ]);
  const withBranch = await resolveEligibleProviders(
    deps,
    { businessId: BUSINESS_A },
    { serviceId: SERVICE_A, branchId: BRANCH_A },
  );
  check(
    "فرع صالح بنفس المنشأة → يُعاد المزود مع نطاق الفرع",
    withBranch.success === true &&
      withBranch.data.providers[0]?.providerId === PROVIDER_ACTIVE &&
      withBranch.data.branchId === BRANCH_A,
  );
  check(
    "displayName للمِلف يُفضّل على اسم العضو",
    withBranch.success === true &&
      withBranch.data.providers[0]?.displayName === "د. أحمد",
  );

  // ── 10. Client identity/business spoofing cannot escape tenancy ──────────
  const hostile = resolveEligibleProvidersInputSchema.safeParse({
    serviceId: SERVICE_A,
    branchId: BRANCH_A,
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
    "المدخل لا يحمل سوى الخدمة والفرع",
    hostile.success === true && Object.keys(hostileData).length === 2,
  );

  const noBusiness = await resolveEligibleProviders(
    deps,
    { businessId: null },
    { serviceId: SERVICE_A },
  );
  check(
    "فاعل بلا منشأة → NO_BUSINESS",
    noBusiness.success === false && noBusiness.error.code === "NO_BUSINESS",
  );

  const badInput = await resolveEligibleProviders(
    deps,
    { businessId: BUSINESS_A },
    { serviceId: "not-a-uuid" },
  );
  check(
    "معرّف خدمة غير صالح → INVALID_INPUT",
    badInput.success === false && badInput.error.code === "INVALID_INPUT",
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
    `\nثوابت أهلية المزودين صحيحة: ${checks.length}/${checks.length} فحص ناجح.`,
  );
}

main().catch((error: Error) => {
  console.error(`فشل غير متوقع: ${error.message}`);
  process.exit(1);
});
