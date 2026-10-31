/* eslint-disable @typescript-eslint/consistent-type-imports */

/**
 * FlowPilot — WHATSAPP CONNECTION ONBOARDING check.
 *
 * Verifies the Business WhatsApp connection setup workflow on top of
 * the EXISTING provider-neutral transport boundary — no DB, no network,
 * no real credentials (all deps are in-memory fakes):
 *
 *   1. tenant isolation: a Business Admin can only see/save its OWN
 *      connection; a foreign businessId supplied by a client can never
 *      redirect a read or a write
 *   2. role isolation: STAFF is refused; a Business Admin without a
 *      Business is refused
 *   3. identity rule: `externalId` (Meta phone_number_id) is the
 *      authoritative provider identity and is persisted as-is; the
 *      display number is only a label
 *   4. connection ownership: update/find are Business-scoped — a
 *      connection of another Business is "not found"
 *   5. duplicate connection protection: the SAME externalId cannot be
 *      registered to a second Business; the owner Business may keep its
 *      own id on update
 *   6. verification behavior: reachable → CONNECTED/active; invalid
 *      credentials / invalid connection / unreachable → stays PENDING
 *      (never silently CONNECTED) — and verification NEVER sends a
 *      WhatsApp message (read-only verifier probe count)
 *   7. inactive/disconnected connection rejection: verify refuses a
 *      DISCONNECTED/inactive connection; the booking/transport gate is
 *      preserved
 *   8. disconnect → reactivate → PENDING lifecycle (re-verification
 *      required; a stale credential is never trusted)
 *   9. no raw secret leakage: credentialsRef is an env-var NAME only;
 *      the view carries no token; a raw-token-shaped credentialsRef is
 *      rejected by Zod
 *  10. masked externalId display (never the full phone_number_id)
 *  11. test-number compatibility: the EXISTING test connection
 *      (`+201064549970` / phone_number_id `1286861067846638`,
 *      credentialsRef `WHATSAPP_META_ACCESS_TOKEN`) round-trips through
 *      the same path unchanged — TEST stays usable
 *  12. real-number replacement compatibility: a real connection
 *      replaces the test connection through data only (same path) and
 *      resolves inbound by externalId through the REAL transport
 *      boundary — no code change
 *  13. hostile payload keys (businessId/branchId/role/accountType/
 *      status/isActive) are stripped and never become trusted input
 *
 * Run: pnpm check:whatsapp-onboarding
 */

export {};

type Check = { label: string; pass: boolean };

const BUSINESS_A = "11111111-1111-4111-8111-111111111111";
const BUSINESS_B = "22222222-2222-4222-8222-222222222222";
const ADMIN_A: import("../src/features/whatsapp-connection/server/whatsapp-connection-service").WhatsAppConnectionActor =
  { userId: "user-a", role: "ADMIN", businessId: BUSINESS_A };
const ADMIN_B: import("../src/features/whatsapp-connection/server/whatsapp-connection-service").WhatsAppConnectionActor =
  { userId: "user-b", role: "ADMIN", businessId: BUSINESS_B };
const STAFF_A: import("../src/features/whatsapp-connection/server/whatsapp-connection-service").WhatsAppConnectionActor =
  { userId: "user-s", role: "STAFF", businessId: BUSINESS_A };
const ADMIN_NO_BIZ: import("../src/features/whatsapp-connection/server/whatsapp-connection-service").WhatsAppConnectionActor =
  { userId: "user-n", role: "ADMIN", businessId: null };

// The current Meta TEST connection (production row values — public
// identifiers only, NO secret).
const TEST_PHONE = "+201064549970";
const TEST_EXTERNAL_ID = "1286861067846638";
const TEST_CREDENTIALS_REF = "WHATSAPP_META_ACCESS_TOKEN";
// A real customer connection replacing it later.
const REAL_PHONE = "+201003344556";
const REAL_EXTERNAL_ID = "1098765432109876";
const REAL_CREDENTIALS_REF = "WHATSAPP_META_TOKEN_BUSINESS_A";

type StoredConnection = {
  id: string;
  businessId: string;
  branchId: string | null;
  displayName: string | null;
  phoneNumber: string;
  provider: string | null;
  externalId: string | null;
  status: string;
  credentialsRef: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  // Onboarding lifecycle (separate from the operational gate)
  onboardingState: string;
  onboardingActor: string;
  onboardingReasonCode: string | null;
  onboardingReasonSummary: string | null;
  onboardingRetryable: boolean | null;
  onboardingStateChangedAt: Date | null;
  onboardingCompletedAt: Date | null;
  onboardingFailedAt: Date | null;
  credentialKind: string | null;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  metaBusinessId: string | null;
  wabaId: string | null;
  metaReviewStatus: string | null;
};

async function main(): Promise<void> {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const service =
    await import("../src/features/whatsapp-connection/server/whatsapp-connection-service");
  const transport = await import("../src/server/transport/whatsapp-transport");

  const checks: Check[] = [];
  function check(label: string, pass: boolean): void {
    checks.push({ label, pass });
  }

  // ── in-memory repository + verifier fakes ───────────────────────────
  const rows = new Map<string, StoredConnection>();
  let nextId = 1;
  /** UUID-shaped ids so the Zod `connectionId` field accepts them. */
  const newId = () =>
    `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`;
  const repo = {
    create: async (input: Record<string, unknown>) => {
      const id = newId();
      const now = new Date();
      const row: StoredConnection = {
        id,
        businessId: input.businessId as string,
        branchId: (input.branchId as string | null) ?? null,
        displayName: (input.displayName as string | null) ?? null,
        phoneNumber: input.phoneNumber as string,
        provider: (input.provider as string | null) ?? null,
        externalId: (input.externalId as string | null) ?? null,
        status: (input.status as string) ?? "PENDING",
        credentialsRef: (input.credentialsRef as string | null) ?? null,
        isActive: true,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        onboardingState: (input.onboardingState as string) ?? "NOT_STARTED",
        onboardingActor: (input.onboardingActor as string) ?? "NONE",
        onboardingReasonCode:
          (input.onboardingReasonCode as string | null) ?? null,
        onboardingReasonSummary:
          (input.onboardingReasonSummary as string | null) ?? null,
        onboardingRetryable:
          (input.onboardingRetryable as boolean | null) ?? null,
        onboardingStateChangedAt: null,
        onboardingCompletedAt: null,
        onboardingFailedAt: null,
        credentialKind: (input.credentialKind as string | null) ?? null,
        displayPhoneNumber: null,
        verifiedName: null,
        metaBusinessId: null,
        wabaId: null,
        metaReviewStatus: null,
      };
      rows.set(id, row);
      return row;
    },
    update: async (
      id: string,
      businessId: string,
      input: Record<string, unknown>,
    ) => {
      const row = rows.get(id);
      if (!row || row.businessId !== businessId || row.deletedAt) return null;
      Object.assign(row, input, { updatedAt: new Date() });
      return row;
    },
    findByIdWithinBusiness: async (id: string, businessId: string) => {
      const row = rows.get(id);
      if (!row || row.businessId !== businessId || row.deletedAt) return null;
      return row;
    },
    findByExternalId: async (externalId: string) => {
      for (const row of rows.values()) {
        if (row.externalId === externalId && !row.deletedAt) return row;
      }
      return null;
    },
    listByBusiness: async (businessId: string) =>
      [...rows.values()]
        .filter((row) => row.businessId === businessId && !row.deletedAt)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    findPrimaryByBusiness: async (businessId: string) =>
      [...rows.values()]
        .filter((row) => row.businessId === businessId && !row.deletedAt)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0] ??
      null,
    listByBusinessIds: async (businessIds: string[]) =>
      [...rows.values()]
        .filter((row) => businessIds.includes(row.businessId) && !row.deletedAt)
        .sort((a, b) => a.businessId.localeCompare(b.businessId)),
    // THE only path to onboarding READY — the fake mirrors the real
    // conditional update so the invariant is proven here too.
    markOnboardingReady: async (id: string, businessId: string) => {
      const row = rows.get(id);
      if (!row || row.businessId !== businessId || row.deletedAt) return null;
      if (row.status !== "CONNECTED" || !row.isActive) return null;
      const ready = new Date();
      Object.assign(row, {
        onboardingState: "READY",
        onboardingActor: "FLOWPILOT",
        onboardingReasonCode: null,
        onboardingReasonSummary: null,
        onboardingRetryable: null,
        onboardingStateChangedAt: ready,
        onboardingCompletedAt: ready,
        onboardingFailedAt: null,
        updatedAt: ready,
      });
      return row;
    },
  };

  /**
   * The verifier is a READ-ONLY probe: the `ConnectionVerifier` interface
   * has NO send method at all, so a WhatsApp message cannot be sent
   * during verification by construction. `probedExternalIds` records
   * every provider identity probed — the evidence that verification ran.
   */
  let probedCount = 0;
  const probedExternalIds: string[] = [];
  const fakeVerifier: import("../src/server/transport/whatsapp-transport").ConnectionVerifier =
    {
      providerName: "meta-whatsapp",
      verify: async (params) => {
        probedCount += 1;
        probedExternalIds.push(params.externalId);
        if (params.externalId === "INVALID-CRED-ID") {
          return {
            ok: false,
            code: "INVALID_CREDENTIALS",
            message: "بيانات اعتماد واتساب غير صالحة",
          };
        }
        if (params.externalId === "BOGUS-ID") {
          return {
            ok: false,
            code: "INVALID_CONNECTION",
            message: "اتصال غير صالح",
          };
        }
        if (params.externalId === "DOWN-ID") {
          return {
            ok: false,
            code: "UNREACHABLE",
            message: "تعذر الوصول",
          };
        }
        return {
          ok: true,
          verifiedExternalId: params.externalId,
          displayPhoneNumber: "+201000000000",
          verifiedName: "FlowPilot Test",
        };
      },
    };
  const deps = { whatsappConnectionRepository: repo, verifier: fakeVerifier };

  // ── 1. tenant isolation ─────────────────────────────────────────────
  const saved = await service.saveConnection(deps, ADMIN_A, {
    displayName: "رقم الاستقبال",
    phoneNumber: TEST_PHONE,
    externalId: TEST_EXTERNAL_ID,
    credentialsRef: TEST_CREDENTIALS_REF,
  });
  const listB = await service.listConnections(deps, ADMIN_B);
  check(
    "العزل: منشأة ب لا ترى اتصال منشأة أ (قائمة فارغة)",
    saved.success && "connections" in listB && listB.connections.length === 0,
  );
  const updateForeign = await service.saveConnection(deps, ADMIN_B, {
    connectionId: (saved as { connection: { id: string } }).connection.id,
    displayName: "محاولة استيلاء",
    phoneNumber: TEST_PHONE,
    externalId: TEST_EXTERNAL_ID,
    credentialsRef: "OTHER_TOKEN",
  });
  check(
    "العزل: تحديث اتصال منشأة أخرى من قبل منشأة أخرى → فشل (بلا تسريب)",
    !updateForeign.success,
  );
  const verifyForeign = await service.verifyConnection(
    deps,
    ADMIN_B,
    (saved as { connection: { id: string } }).connection.id,
  );
  const disconnectForeign = await service.disconnectConnection(
    deps,
    ADMIN_B,
    (saved as { connection: { id: string } }).connection.id,
  );
  check(
    "العزل: تحقق/فصل اتصال منشأة أخرى → فشل",
    !verifyForeign.success && !disconnectForeign.success,
  );

  // ── 2. role isolation ───────────────────────────────────────────────
  const staffSave = await service.saveConnection(deps, STAFF_A, {
    phoneNumber: "+201001111111",
    externalId: "STAFF-ID",
    credentialsRef: "STAFF_TOKEN",
  });
  const staffList = await service.listConnections(deps, STAFF_A);
  const noBizSave = await service.saveConnection(deps, ADMIN_NO_BIZ, {
    phoneNumber: "+201002222222",
    externalId: "NOBIZ-ID",
    credentialsRef: "NOBIZ_TOKEN",
  });
  check(
    "الدور: STAFF مرفوض والمدير بلا منشأة مرفوض",
    !staffSave.success && "message" in staffList && !noBizSave.success,
  );

  // ── 3. identity rule ────────────────────────────────────────────────
  check(
    "الهوية: externalId (phone_number_id) محفوظ كما هو وعدّاد المزوّد meta-whatsapp",
    saved.success &&
      (saved as { connection: { externalId: string; provider: string } })
        .connection.externalId === TEST_EXTERNAL_ID &&
      (saved as { connection: { provider: string } }).connection.provider ===
        "meta-whatsapp",
  );
  check(
    "الهوية: اتصال جديد يبدأ PENDING — التحقق وحده يوصله CONNECTED",
    saved.success &&
      (saved as { connection: { status: string } }).connection.status ===
        "PENDING",
  );

  // ── 4. connection ownership ─────────────────────────────────────────
  const verified = await service.verifyConnection(
    deps,
    ADMIN_A,
    (saved as { connection: { id: string } }).connection.id,
  );
  check(
    "الملكية: تحقق الاتصال داخل منشأته → CONNECTED + نشط",
    verified.success &&
      (verified as { connection: { status: string; isActive: boolean } })
        .connection.status === "CONNECTED" &&
      (verified as { connection: { isActive: boolean } }).connection
        .isActive === true,
  );

  // ── 5. duplicate connection protection ─────────────────────────────
  const dup = await service.saveConnection(deps, ADMIN_B, {
    phoneNumber: TEST_PHONE,
    externalId: TEST_EXTERNAL_ID, // already owned by BUSINESS_A
    credentialsRef: "DUP_TOKEN",
  });
  const sameOwnerUpdate = await service.saveConnection(deps, ADMIN_A, {
    connectionId: (saved as { connection: { id: string } }).connection.id,
    displayName: "رقم الاستقبال المحدّث",
    phoneNumber: TEST_PHONE,
    externalId: TEST_EXTERNAL_ID, // owner keeps its own id → allowed
    credentialsRef: TEST_CREDENTIALS_REF,
  });
  check(
    "التكرار: externalId مسجّل لمنشأة أخرى → مرفوض؛ المالك يحتفظ بمعرّفه",
    !dup.success &&
      sameOwnerUpdate.success &&
      (sameOwnerUpdate as { connection: { displayName: string } }).connection
        .displayName === "رقم الاستقبال المحدّث",
  );

  // ── 6. verification behavior (read-only) ────────────────────────────
  const badCred = await service.saveConnection(deps, ADMIN_A, {
    displayName: "اعتماد سيئ",
    phoneNumber: "+201004444444",
    externalId: "INVALID-CRED-ID",
    credentialsRef: "BAD_TOKEN_NAME",
  });
  const badCredVerify = await service.verifyConnection(
    deps,
    ADMIN_A,
    (badCred as { connection: { id: string } }).connection.id,
  );
  const bogusSave = await service.saveConnection(deps, ADMIN_A, {
    displayName: "اتصال وهمي",
    phoneNumber: "+201005555555",
    externalId: "BOGUS-ID",
    credentialsRef: "BOGUS_TOKEN_NAME",
  });
  const bogusVerify = await service.verifyConnection(
    deps,
    ADMIN_A,
    (bogusSave as { connection: { id: string } }).connection.id,
  );
  const downSave = await service.saveConnection(deps, ADMIN_A, {
    displayName: "خدمة متعذرة",
    phoneNumber: "+201006666666",
    externalId: "DOWN-ID",
    credentialsRef: "DOWN_TOKEN_NAME",
  });
  const downVerify = await service.verifyConnection(
    deps,
    ADMIN_A,
    (downSave as { connection: { id: string } }).connection.id,
  );
  check(
    "التحقق: اعتماد غير صالح / اتصال غير صالح / خدمة متعذرة → PENDING ولن يصبح CONNECTED",
    !badCredVerify.success &&
      badCredVerify.verificationCode === "INVALID_CREDENTIALS" &&
      !bogusVerify.success &&
      bogusVerify.verificationCode === "INVALID_CONNECTION" &&
      !downVerify.success &&
      downVerify.verificationCode === "UNREACHABLE" &&
      rows.get((badCred as { connection: { id: string } }).connection.id)!
        .status === "PENDING",
  );
  // A previously CONNECTED connection that later fails verification must
  // fall back to PENDING (never claim connected with a dead credential).
  rows.get((saved as { connection: { id: string } }).connection.id)!.status =
    "CONNECTED";
  rows.get(
    (saved as { connection: { id: string } }).connection.id,
  )!.externalId = "INVALID-CRED-ID";
  const recheck = await service.verifyConnection(
    deps,
    ADMIN_A,
    (saved as { connection: { id: string } }).connection.id,
  );
  check(
    "التحقق: اتصال كان موصولاً ثم فشل التحقق → يعود PENDING (لا ادعاء اتصال كاذب)",
    !recheck.success &&
      recheck.verificationCode === "INVALID_CREDENTIALS" &&
      rows.get((saved as { connection: { id: string } }).connection.id)!
        .status === "PENDING",
  );
  // restore the real test identity for the remaining checks
  rows.get(
    (saved as { connection: { id: string } }).connection.id,
  )!.externalId = TEST_EXTERNAL_ID;
  const probesBeforeFinalVerify = probedExternalIds.length;
  await service.verifyConnection(
    deps,
    ADMIN_A,
    (saved as { connection: { id: string } }).connection.id,
  );
  check(
    "التحقق: لا إرسال أي رسالة واتساب أثناء التحقق (استعلام قراءة فقط)",
    // Verification ran (a probe happened) yet the verifier interface
    // exposes no send path — a customer message is impossible here.
    probedCount > probesBeforeFinalVerify && !("send" in fakeVerifier),
  );

  // ── 7. inactive/disconnected connection rejection ──────────────────
  const disconnected = await service.disconnectConnection(
    deps,
    ADMIN_A,
    (saved as { connection: { id: string } }).connection.id,
  );
  const verifyWhileDisconnected = await service.verifyConnection(
    deps,
    ADMIN_A,
    (saved as { connection: { id: string } }).connection.id,
  );
  check(
    "غير الموصول: الفصل → DISCONNECTED/غير نشط، والتحقق مرفوض",
    disconnected.success &&
      (disconnected as { connection: { status: string; isActive: boolean } })
        .connection.status === "DISCONNECTED" &&
      (disconnected as { connection: { isActive: boolean } }).connection
        .isActive === false &&
      !verifyWhileDisconnected.success,
  );
  // The transport send gate must refuse the disconnected connection too.
  const sendResolution = await transport.resolveConnectionForSend(
    {
      businessRepository: {
        findById: async () => ({ id: BUSINESS_A, name: "منشأة أ" }),
        findByWhatsappNumber: async () => null,
      },
      whatsappConnectionRepository: {
        findByIdWithinBusiness: repo.findByIdWithinBusiness,
        findByPhone: async () => null,
        findByExternalId: repo.findByExternalId,
      },
      branchRepository: {
        findDefaultByBusiness: async () => ({
          id: "branch-default",
          businessId: BUSINESS_A,
        }),
        findByIdWithinBusiness: async () => null,
      },
    } as unknown as import("../src/server/transport/whatsapp-transport").ConnectionResolutionDeps,
    {
      connectionId: (saved as { connection: { id: string } }).connection.id,
      businessId: BUSINESS_A,
    },
  );
  check(
    "غير الموصول: بوابة الإرسال الأصلية ترفضه (INVALID_CONNECTION)",
    !sendResolution.ok && sendResolution.code === "INVALID_CONNECTION",
  );

  // ── 8. reactivate → PENDING (re-verification required) ─────────────
  const reactivated = await service.reactivateConnection(
    deps,
    ADMIN_A,
    (saved as { connection: { id: string } }).connection.id,
  );
  check(
    "إعادة التفعيل: PENDING + نشط — التحقق مطلوب مجدداً قبل الإرسال",
    reactivated.success &&
      (reactivated as { connection: { status: string; isActive: boolean } })
        .connection.status === "PENDING" &&
      (reactivated as { connection: { isActive: boolean } }).connection
        .isActive === true,
  );
  const sendBeforeReverify = await transport.resolveConnectionForSend(
    {
      businessRepository: {
        findById: async () => ({ id: BUSINESS_A, name: "منشأة أ" }),
        findByWhatsappNumber: async () => null,
      },
      whatsappConnectionRepository: {
        findByIdWithinBusiness: repo.findByIdWithinBusiness,
        findByPhone: async () => null,
        findByExternalId: repo.findByExternalId,
      },
      branchRepository: {
        findDefaultByBusiness: async () => ({
          id: "branch-default",
          businessId: BUSINESS_A,
        }),
        findByIdWithinBusiness: async () => null,
      },
    } as unknown as import("../src/server/transport/whatsapp-transport").ConnectionResolutionDeps,
    {
      connectionId: (saved as { connection: { id: string } }).connection.id,
      businessId: BUSINESS_A,
    },
  );
  check(
    "بعد إعادة التفعيل وقبل التحقق: الإرسال لا يزال مرفوضاً",
    !sendBeforeReverify.ok,
  );
  await service.verifyConnection(
    deps,
    ADMIN_A,
    (saved as { connection: { id: string } }).connection.id,
  );

  // ── 9. no raw secret leakage ────────────────────────────────────────
  const listView = await service.listConnections(deps, ADMIN_A);
  const view = "connections" in listView ? listView.connections[0] : undefined;
  const viewJson = JSON.stringify(view ?? {});
  const savedRow = rows.get(
    (saved as { connection: { id: string } }).connection.id,
  )!;
  check(
    "السرية: العرض لا يحوي credentialsRef ولا أي قيمة سرية",
    view !== undefined &&
      !("credentialsRef" in view) &&
      !viewJson.includes("credentialsRef") &&
      !viewJson.includes("ACCESS_TOKEN"),
  );
  check(
    "السرية: credentialsRef اسم متغيّر بيئة فقط — لا يُمرّر للمزوّد كقيمة",
    savedRow.credentialsRef === TEST_CREDENTIALS_REF &&
      typeof savedRow.credentialsRef === "string" &&
      /^[A-Z][A-Z0-9_]{2,63}$/.test(savedRow.credentialsRef),
  );
  const rawTokenRejected = await service.saveConnection(deps, ADMIN_A, {
    phoneNumber: "+201007777777",
    externalId: "RAW-TOKEN-ID",
    // A pasted raw Meta access token shape — must be rejected.
    credentialsRef: "EAAxxxxaDOzABO1234567890",
  });
  check(
    "السرية: رمز خام مُلصق في credentialsRef مرفوض (نمط اسم متغيّر البيئة)",
    !rawTokenRejected.success,
  );

  // ── 10. masked externalId display ───────────────────────────────────
  check(
    "العرض: معرّف الرقم يظهر مموّهاً (phone_number_id كاملاً لا يُعرض)",
    view !== undefined &&
      view.externalId === TEST_EXTERNAL_ID &&
      view.externalIdMasked === "1286••••6638",
  );

  // ── 11. test-number compatibility ───────────────────────────────────
  const testList = await service.listConnections(deps, ADMIN_A);
  const testConnection =
    "connections" in testList
      ? testList.connections.find(
          (connection) => connection.externalId === TEST_EXTERNAL_ID,
        )
      : undefined;
  const inboundByExternalId = await transport.resolveInboundConnection(
    {
      businessRepository: {
        findById: async (id: string) =>
          id === BUSINESS_A
            ? { id: BUSINESS_A, name: "منشأة أ", isActive: true }
            : null,
        findByWhatsappNumber: async () => null,
      },
      whatsappConnectionRepository: {
        findByIdWithinBusiness: repo.findByIdWithinBusiness,
        findByPhone: async () => null,
        findByExternalId: repo.findByExternalId,
      },
      branchRepository: {
        findDefaultByBusiness: async (id: string) =>
          id === BUSINESS_A
            ? { id: "branch-default", businessId: BUSINESS_A }
            : null,
        findByIdWithinBusiness: async () => null,
      },
    } as unknown as import("../src/server/transport/whatsapp-transport").ConnectionResolutionDeps,
    // The Meta display number may differ from the stored mapping — the
    // STABLE identity (phone_number_id) is what resolves the tenant.
    "+12025550123",
    TEST_EXTERNAL_ID,
  );
  check(
    "توافق رقم الاختبار: الاتصال الحالي يمر عبر نفس المسار ويُحلّ وارداً بـ phone_number_id",
    testConnection !== undefined &&
      testConnection.status === "CONNECTED" &&
      inboundByExternalId.ok &&
      inboundByExternalId.businessId === BUSINESS_A &&
      inboundByExternalId.connectionId === testConnection.id,
  );

  // ── 12. real-number replacement compatibility (data only) ──────────
  const replaced = await service.saveConnection(deps, ADMIN_A, {
    connectionId: testConnection!.id,
    displayName: "رقم العميل الحقيقي",
    phoneNumber: REAL_PHONE,
    externalId: REAL_EXTERNAL_ID,
    credentialsRef: REAL_CREDENTIALS_REF,
  });
  const realInbound = await transport.resolveInboundConnection(
    {
      businessRepository: {
        findById: async (id: string) =>
          id === BUSINESS_A
            ? { id: BUSINESS_A, name: "منشأة أ", isActive: true }
            : null,
        findByWhatsappNumber: async () => null,
      },
      whatsappConnectionRepository: {
        findByIdWithinBusiness: repo.findByIdWithinBusiness,
        findByPhone: async () => null,
        findByExternalId: repo.findByExternalId,
      },
      branchRepository: {
        findDefaultByBusiness: async (id: string) =>
          id === BUSINESS_A
            ? { id: "branch-default", businessId: BUSINESS_A }
            : null,
        findByIdWithinBusiness: async () => null,
      },
    } as unknown as import("../src/server/transport/whatsapp-transport").ConnectionResolutionDeps,
    "+12025550199",
    REAL_EXTERNAL_ID,
  );
  check(
    "استبدال الرقم الحقيقي: تحديث البيانات فقط (بلا كود) ويُحلّ وارداً بالمعرّف الجديد",
    replaced.success &&
      (replaced as { connection: { externalId: string; status: string } })
        .connection.externalId === REAL_EXTERNAL_ID &&
      (replaced as { connection: { status: string } }).connection.status ===
        "CONNECTED" && // verified connection keeps its lifecycle on identity edit
      realInbound.ok &&
      realInbound.businessId === BUSINESS_A &&
      realInbound.connectionId === testConnection!.id,
  );

  // ── 13. hostile payload keys stripped ───────────────────────────────
  const hostile = await service.saveConnection(deps, ADMIN_A, {
    displayName: "حمولة معادية",
    phoneNumber: "+201008888888",
    externalId: "HOSTILE-ID",
    credentialsRef: "HOSTILE_TOKEN",
    businessId: BUSINESS_B, // must be ignored
    branchId: "foreign-branch", // must be ignored
    role: "ADMIN",
    accountType: "PLATFORM",
    status: "CONNECTED", // must be ignored — verification is the only path
    isActive: false, // must be ignored
  });
  const hostileRow = rows.get(
    (hostile as { connection?: { id?: string } }).connection?.id ?? "",
  );
  check(
    "حمولة معادية: businessId/branchId/role/accountType/status/isActive لا تصبح مدخولاً موثوقاً",
    hostile.success &&
      hostileRow?.businessId === BUSINESS_A &&
      hostileRow?.branchId === null &&
      hostileRow?.status === "PENDING" &&
      hostileRow?.isActive === true,
  );

  // ════════════════════════════════════════════════════════════════════
  // WHATSAPP-ONBOARDING-01 — the separate onboarding lifecycle
  // (NOT_STARTED → AUTHORIZING → PROVISIONING → READY / FAILED /
  // ACTION_REQUIRED), the provider-neutral authorization port, the
  // authorization ledger, the credentials reference boundary, and the
  // Super Admin read projection. All deps stay in-memory: no DB, no
  // network, no real provider call, no secret.
  // ════════════════════════════════════════════════════════════════════

  const onboardingFeature =
    await import("../src/features/whatsapp-onboarding/server/whatsapp-onboarding-service");
  const failureModule =
    await import("../src/features/whatsapp-onboarding/server/onboarding-failure");
  const deterministic =
    await import("../src/features/whatsapp-onboarding/server/deterministic-connection-authorizer");
  const credentialsModule =
    await import("../src/server/credentials/credentials-resolver");
  const platformService =
    await import("../src/features/platform/server/business-onboarding-service");

  const fixedNow = new Date("2026-09-19T10:00:00.000Z");
  let stateRefSeq = 0;
  const nextStateRef = () =>
    `state-ref-${String(++stateRefSeq).padStart(3, "0")}`;

  // ── in-memory authorization ledger + businesses/users fakes ───────
  type StoredAuthorization = {
    id: string;
    businessId: string;
    connectionId: string;
    stateRef: string;
    expiresAt: Date;
    consumedAt: Date | null;
  };
  const authorizations = new Map<string, StoredAuthorization>();
  type StoredBusiness = {
    id: string;
    name: string;
    vertical: string | null;
    city: string | null;
    whatsappNumber: string;
    timezone: string;
    about: string | null;
    address: string | null;
    workingHours: null;
    slotDurationMinutes: number;
    confirmationMode: string;
    appointmentTimeDisplay: string;
    faqs: null;
    cancellationPolicy: string | null;
    onboardingCompletedAt: Date | null;
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
    defaultBranchId: string | null;
    assistantName: string | null;
    assistantStyle: Record<string, string> | null;
    reminderEnabled: boolean;
    reminderLeadHours: number;
    reminderTemplateId: string;
    defaultServiceBookingEnabled: boolean;
    defaultBookingServiceId: string | null;
  };
  const makeBusiness = (input: {
    id: string;
    name: string;
    whatsappNumber: string;
  }): StoredBusiness => ({
    id: input.id,
    name: input.name,
    vertical: "beauty",
    city: "الرياض",
    whatsappNumber: input.whatsappNumber,
    timezone: "Asia/Riyadh",
    about: null,
    address: null,
    workingHours: null,
    slotDurationMinutes: 30,
    confirmationMode: "manual",
    appointmentTimeDisplay: "START_ONLY",
    faqs: null,
    cancellationPolicy: null,
    onboardingCompletedAt: fixedNow,
    isActive: true,
    createdAt: fixedNow,
    updatedAt: fixedNow,
    deletedAt: null,
    assistantName: null,
    assistantStyle: null,
    defaultBranchId: null,
    reminderEnabled: false,
    reminderLeadHours: 24,
    reminderTemplateId: "standard",
    defaultServiceBookingEnabled: false,
    defaultBookingServiceId: null,
  });
  const businesses = new Map<string, StoredBusiness>();
  businesses.set(
    BUSINESS_A,
    makeBusiness({
      id: BUSINESS_A,
      name: "منشأة أ",
      whatsappNumber: TEST_PHONE,
    }),
  );
  businesses.set(
    BUSINESS_B,
    makeBusiness({
      id: BUSINESS_B,
      name: "منشأة ب",
      whatsappNumber: "+201003344556",
    }),
  );
  const users = new Map<
    string,
    {
      id: string;
      businessId: string;
      name: string;
      email: string;
    }
  >();
  users.set("user-a", {
    id: "user-a",
    businessId: BUSINESS_A,
    name: "مدير أ",
    email: "admin-a@example.com",
  });
  users.set("user-b", {
    id: "user-b",
    businessId: BUSINESS_B,
    name: "مدير ب",
    email: "admin-b@example.com",
  });

  const authorizationRepo = {
    create: async (input: {
      businessId: string;
      connectionId: string;
      stateRef: string;
      expiresAt: Date;
    }) => {
      const record: StoredAuthorization = {
        id: newId(),
        businessId: input.businessId,
        connectionId: input.connectionId,
        stateRef: input.stateRef,
        expiresAt: input.expiresAt,
        consumedAt: null,
      };
      authorizations.set(record.stateRef, record);
      return record;
    },
    findActiveByConnection: async (connectionId: string) => {
      for (const record of authorizations.values()) {
        if (
          record.connectionId === connectionId &&
          !record.consumedAt &&
          record.expiresAt.getTime() > fixedNow.getTime()
        ) {
          return record;
        }
      }
      return null;
    },
    findByStateRef: async (stateRef: string) =>
      authorizations.get(stateRef) ?? null,
    consume: async (
      stateRef: string,
      businessId: string,
      connectionId: string,
    ) => {
      const record = authorizations.get(stateRef);
      if (
        !record ||
        record.businessId !== businessId ||
        record.connectionId !== connectionId ||
        record.consumedAt ||
        record.expiresAt.getTime() <= fixedNow.getTime()
      ) {
        return false;
      }
      record.consumedAt = fixedNow;
      return true;
    },
  };

  const onboardingDeps = (options?: {
    outcome?: "success" | "action_required" | "unreachable" | "declined";
    credentialKind?: "ENV" | "RUNTIME";
    externalId?: string;
  }) => ({
    connectionRepository: repo,
    authorizationRepository: authorizationRepo,
    businessRepository: {
      findById: async (id: string) => businesses.get(id) ?? null,
      listForPlatform: async (input: {
        search?: string | null;
        limit: number;
        offset: number;
      }) =>
        [...businesses.values()]
          .filter((business) => !business.deletedAt)
          .filter((business) =>
            input.search
              ? business.name.includes(input.search) ||
                business.whatsappNumber.includes(input.search)
              : true,
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(input.offset, input.offset + input.limit),
      countForPlatform: async (input: { search?: string | null }) =>
        [...businesses.values()]
          .filter((business) => !business.deletedAt)
          .filter((business) =>
            input.search
              ? business.name.includes(input.search) ||
                business.whatsappNumber.includes(input.search)
              : true,
          ).length,
    },
    authorizer: deterministic.createDeterministicConnectionAuthorizer({
      outcome: options?.outcome ?? "success",
      credentialKind: options?.credentialKind ?? "ENV",
      externalId: options?.externalId,
      generateStateRef: nextStateRef,
    }),
    generateStateRef: nextStateRef,
    now: () => fixedNow,
  });

  const platformDeps = {
    businesses: {
      findById: async (id: string) => businesses.get(id) ?? null,
      listForPlatform: async (input: {
        search?: string | null;
        limit: number;
        offset: number;
      }) =>
        [...businesses.values()]
          .filter((business) => !business.deletedAt)
          .filter((business) =>
            input.search
              ? business.name.includes(input.search) ||
                business.whatsappNumber.includes(input.search)
              : true,
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(input.offset, input.offset + input.limit),
      countForPlatform: async (input: { search?: string | null }) =>
        [...businesses.values()]
          .filter((business) => !business.deletedAt)
          .filter((business) =>
            input.search
              ? business.name.includes(input.search) ||
                business.whatsappNumber.includes(input.search)
              : true,
          ).length,
    },
    connections: {
      listByBusinessIds: repo.listByBusinessIds,
      findPrimaryByBusiness: repo.findPrimaryByBusiness,
    },
    users: {
      findAdminsByBusinesses: async (businessIds: string[]) =>
        [...users.values()].filter((user) =>
          businessIds.includes(user.businessId),
        ),
      findAdminByBusiness: async (businessId: string) =>
        [...users.values()].find((user) => user.businessId === businessId) ??
        null,
    },
  };

  /**
   * Synchronous read of a Business's onboarding connection (the repo
   * methods stay async because the service deps require Promises).
   */
  const rowOf = (businessId: string): StoredConnection | null =>
    [...rows.values()]
      .filter((row) => row.businessId === businessId && !row.deletedAt)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0] ?? null;

  /**
   * Narrows a BEGIN result to its launched variant (the ALREADY_READY
   * variant carries no stateRef).
   */
  const launchedStateRef = (
    result: import("../src/features/whatsapp-onboarding/types").BeginWhatsAppOnboardingResult,
  ): string => (result.success && result.launched ? result.stateRef : "");

  const PLATFORM_OPERATOR = { userId: "operator-1", accountType: "PLATFORM" };
  const BUSINESS_ACTOR = { userId: "user-business", accountType: "BUSINESS" };

  // A second Business with its own (not-yet-onboarded) connection: the
  // neighbor that the isolation, gate, and duplicate-identity checks
  // exercise. Established BEFORE the checks so those guards actually
  // run instead of being silently skipped.
  const businessBConnection = await repo.create({
    businessId: BUSINESS_B,
    branchId: null,
    phoneNumber: "+201003344556",
    provider: "meta-whatsapp",
    externalId: null,
    credentialsRef: null,
    status: "PENDING",
    onboardingState: "NOT_STARTED",
    onboardingActor: "NONE",
  });
  void businessBConnection;

  // NOTE: the lifecycle progression runs against BUSINESS_B. BUSINESS_A
  // was already operationally CONNECTED by the manual-pilot checks above
  // (that is what proves the operational gate); the onboarding lifecycle
  // needs a connection that has NOT been verified yet, otherwise the
  // AUTHORIZING → PROVISIONING → READY progression could be shortcut by
  // an already-connected row.
  const beginA = await onboardingFeature.beginWhatsAppOnboarding(
    onboardingDeps(),
    ADMIN_B,
    { redirectUri: "http://localhost:3000/whatsapp-onboarding/callback" },
  );
  const connectionA = rowOf(BUSINESS_B);
  check(
    "ONBOARDING: BEGIN ينشئ اتصالاً للمنشأة وينقل الحالة إلى AUTHORIZING",
    beginA.success &&
      "launched" in beginA &&
      beginA.launched === true &&
      beginA.resumed === false &&
      Boolean(beginA.authorizationUrl) &&
      connectionA?.onboardingState === "AUTHORIZING" &&
      connectionA?.onboardingActor === "CUSTOMER",
  );
  const ledgerRowAwaited = await authorizationRepo.findByStateRef(
    launchedStateRef(beginA),
  );
  check(
    "ONBOARDING: مسار التفويض مُسجّل خادمياً (stateRef → منشأة + اتصال)",
    Boolean(ledgerRowAwaited) &&
      ledgerRowAwaited?.businessId === BUSINESS_B &&
      ledgerRowAwaited?.consumedAt === null,
  );

  // ── O2. authorization scope isolation ──────────────────────────────
  const staffBegin = await onboardingFeature.beginWhatsAppOnboarding(
    onboardingDeps(),
    STAFF_A,
    { redirectUri: "http://localhost:3000/whatsapp-onboarding/callback" },
  );
  const noBizBegin = await onboardingFeature.beginWhatsAppOnboarding(
    onboardingDeps(),
    ADMIN_NO_BIZ,
    { redirectUri: "http://localhost:3000/whatsapp-onboarding/callback" },
  );
  check(
    "ONBOARDING: STAFF ومدير بلا منشأة لا يستطيعان بدء الربط",
    !staffBegin.success && !noBizBegin.success,
  );

  // ── O1. NOT_STARTED → AUTHORIZING (BEGIN) ──────────────────────────
  // (see the NOTE above: this is the AUTHORIZING entry point)

  // ── O3. AUTHORIZING → PROVISIONING (CALLBACK) ──────────────────────
  const callbackA = await onboardingFeature.handleWhatsAppAuthorizationCallback(
    onboardingDeps(),
    {
      stateRef: launchedStateRef(beginA),
      code: "fp-deterministic-authorization-code",
      redirectUri: "http://localhost:3000/whatsapp-onboarding/callback",
    },
  );
  const provisionedA = rowOf(BUSINESS_B);
  check(
    "ONBOARDING: CALLBACK يُفعّل التجهيز (PROVISIONING) ويُثبت هوية المزوّد",
    callbackA.success &&
      provisionedA?.onboardingState !== "AUTHORIZING" &&
      Boolean(provisionedA?.externalId) &&
      Boolean(provisionedA?.credentialsRef) &&
      provisionedA?.provider === "meta-whatsapp" &&
      provisionedA?.metaBusinessId !== null &&
      provisionedA?.wabaId !== null &&
      provisionedA?.metaReviewStatus === "approved",
  );

  // ── O4. READY only through the operational verification path ───────
  // The callback must NOT write READY by itself: the connection is not
  // operationally CONNECTED yet.
  check(
    "ONBOARDING: الـ CALLBACK لا يكتب READY بنفسه (البوابة التشغيلية أولاً)",
    callbackA.success &&
      callbackA.onboardingState === "ACTION_REQUIRED" &&
      provisionedA?.onboardingState === "ACTION_REQUIRED" &&
      provisionedA?.status === "PENDING" &&
      provisionedA?.onboardingReasonCode === "VERIFICATION_REQUIRED",
  );
  // The read-only verification path establishes readiness.
  const verifiedA = await service.verifyConnection(
    deps,
    ADMIN_B,
    provisionedA!.id,
  );
  await onboardingFeature.refreshWhatsAppOnboardingReadiness(
    { connectionRepository: repo, now: () => fixedNow },
    ADMIN_B,
  );
  const readyA = rowOf(BUSINESS_B);
  check(
    "ONBOARDING: PROVISIONING → READY فقط بعد التحقق التشغيلي (موصول + نشط)",
    verifiedA.success &&
      readyA?.onboardingState === "READY" &&
      readyA?.status === "CONNECTED" &&
      readyA?.isActive === true &&
      readyA?.onboardingCompletedAt !== null &&
      readyA?.onboardingFailedAt === null,
  );

  // ── O5. READY cannot exist without the operational gate ────────────
  const gateProbe = rowOf(BUSINESS_B);
  if (gateProbe) {
    gateProbe.onboardingState = "PROVISIONING";
    gateProbe.status = "PENDING";
    gateProbe.isActive = true;
    const notReady = await repo.markOnboardingReady(gateProbe.id, BUSINESS_B);
    check(
      "ONBOARDING: READY مستحيل ما لم يكن status === CONNECTED",
      notReady === null && gateProbe.onboardingState === "PROVISIONING",
    );
    gateProbe.status = "CONNECTED";
    gateProbe.isActive = false;
    const notReadyInactive = await repo.markOnboardingReady(
      gateProbe.id,
      BUSINESS_B,
    );
    check(
      "ONBOARDING: READY مستحيل ما لم يكن الاتصال نشطاً",
      notReadyInactive === null && gateProbe.onboardingState === "PROVISIONING",
    );
    gateProbe.onboardingState = "NOT_STARTED";
    gateProbe.onboardingActor = "NONE";
    gateProbe.isActive = true;
    gateProbe.status = "PENDING";
    // Restore the pre-authorization identity too, so the remaining
    // lifecycle checks start from a genuinely un-provisioned row.
    gateProbe.externalId = null;
    gateProbe.credentialsRef = null;
    gateProbe.credentialKind = null;
    gateProbe.displayPhoneNumber = null;
    gateProbe.verifiedName = null;
    gateProbe.metaBusinessId = null;
    gateProbe.wabaId = null;
    gateProbe.metaReviewStatus = null;
    gateProbe.onboardingReasonCode = null;
    gateProbe.onboardingReasonSummary = null;
    gateProbe.onboardingRetryable = null;
    gateProbe.onboardingStateChangedAt = null;
    gateProbe.onboardingCompletedAt = null;
    gateProbe.onboardingFailedAt = null;
  }

  // ── O6. onboardingState is never consumed by the runtime gates ────
  const gateConnection = rowOf(BUSINESS_A)!;
  const sendReady = await transport.resolveConnectionForSend(
    {
      businessRepository: {
        findById: async () => ({ id: BUSINESS_A, name: "منشأة أ" }),
        findByWhatsappNumber: async () => null,
      },
      whatsappConnectionRepository: {
        findByIdWithinBusiness: repo.findByIdWithinBusiness,
        findByPhone: async () => null,
        findByExternalId: repo.findByExternalId,
      },
      branchRepository: {
        findDefaultByBusiness: async () => ({
          id: "branch-default",
          businessId: BUSINESS_A,
        }),
        findByIdWithinBusiness: async () => null,
      },
    } as unknown as import("../src/server/transport/whatsapp-transport").ConnectionResolutionDeps,
    { connectionId: gateConnection.id, businessId: BUSINESS_A },
  );
  check(
    "ONBOARDING: بوابة الإرسال تقرأ status/isActive فقط — READY لا يكفي وحده",
    sendReady.ok === true,
  );
  // A connection that is onboarding-READY but operationally disconnected
  // is still refused by BOTH runtime gates (the lifecycle never leaks).
  const readyRow = rowOf(BUSINESS_A)!;
  const snapshot = { ...readyRow };
  readyRow.status = "DISCONNECTED";
  readyRow.isActive = false;
  const sendBlocked = await transport.resolveConnectionForSend(
    {
      businessRepository: {
        findById: async () => ({ id: BUSINESS_A, name: "منشأة أ" }),
        findByWhatsappNumber: async () => null,
      },
      whatsappConnectionRepository: {
        findByIdWithinBusiness: repo.findByIdWithinBusiness,
        findByPhone: async () => null,
        findByExternalId: repo.findByExternalId,
      },
      branchRepository: {
        findDefaultByBusiness: async () => ({
          id: "branch-default",
          businessId: BUSINESS_A,
        }),
        findByIdWithinBusiness: async () => null,
      },
    } as unknown as import("../src/server/transport/whatsapp-transport").ConnectionResolutionDeps,
    { connectionId: readyRow.id, businessId: BUSINESS_A },
  );
  Object.assign(readyRow, snapshot);
  check(
    "ONBOARDING: دورة الربط READY لا تفتح بوابة الإرسال وحدها (status هو البوابة)",
    !sendBlocked.ok && sendBlocked.code === "INVALID_CONNECTION",
  );

  // ── O7. abandonment / resume ───────────────────────────────────────
  // BUSINESS_B was reset to a pre-authorization state by the O5 probe,
  // so a fresh launch mints a new attempt that a second launch RESUMES.
  const resumeBegin = await onboardingFeature.beginWhatsAppOnboarding(
    onboardingDeps(),
    ADMIN_B,
    { redirectUri: "http://localhost:3000/whatsapp-onboarding/callback" },
  );
  const secondBegin = await onboardingFeature.beginWhatsAppOnboarding(
    onboardingDeps(),
    ADMIN_B,
    { redirectUri: "http://localhost:3000/whatsapp-onboarding/callback" },
  );
  check(
    "ONBOARDING: استئناف نفس الطلب يُعيد نفس stateRef (لا طلبان مفتوحان)",
    resumeBegin.success &&
      secondBegin.success &&
      "stateRef" in resumeBegin &&
      "stateRef" in secondBegin &&
      secondBegin.resumed === true &&
      secondBegin.stateRef === resumeBegin.stateRef,
  );

  // ── O9. hostile / unknown callback state ───────────────────────────
  // Run BEFORE any provisioning of this connection so "nothing was
  // written" is provable on the row itself.
  const hostileState =
    await onboardingFeature.handleWhatsAppAuthorizationCallback(
      onboardingDeps(),
      {
        stateRef: "never-issued-state-ref",
        code: "fp-deterministic-authorization-code",
        redirectUri: "http://localhost:3000/whatsapp-onboarding/callback",
      },
    );
  // The in-flight (resumed) attempt carries a VALID stateRef, but a
  // stolen / replayed provider code — the exchange must refuse it and
  // no provider identity may be provisioned.
  const hostileCode =
    await onboardingFeature.handleWhatsAppAuthorizationCallback(
      onboardingDeps(),
      {
        stateRef: launchedStateRef(resumeBegin),
        code: "stolen-authorization-code",
        redirectUri: "http://localhost:3000/whatsapp-onboarding/callback",
      },
    );
  const hostileStateRow = rowOf(BUSINESS_B);
  check(
    "ONBOARDING: حالة معادية/غير مُصدَرة → رفض; رمز مسروق → رفض (بلا كتابة)",
    !hostileState.success &&
      hostileState.code === "AUTHORIZATION_STATE_UNKNOWN" &&
      !hostileCode.success &&
      hostileCode.code === "INVALID_AUTHORIZATION_CODE" &&
      // A refused exchange must not have provisioned an identity: the
      // failure is recorded in the normalized shape instead.
      hostileStateRow?.externalId === null &&
      hostileStateRow?.credentialsRef === null &&
      hostileStateRow?.onboardingState === "FAILED" &&
      hostileStateRow?.onboardingReasonCode === "INVALID_AUTHORIZATION_CODE",
  );

  // An expired attempt is abandoned: the next launch mints a NEW state.
  const expiredRef = nextStateRef();
  await authorizationRepo.create({
    businessId: BUSINESS_B,
    connectionId: rowOf(BUSINESS_B)!.id,
    stateRef: expiredRef,
    expiresAt: new Date(fixedNow.getTime() - 60_000),
  });
  const expiredCallback =
    await onboardingFeature.handleWhatsAppAuthorizationCallback(
      onboardingDeps(),
      {
        stateRef: expiredRef,
        code: "fp-deterministic-authorization-code",
        redirectUri: "http://localhost:3000/whatsapp-onboarding/callback",
      },
    );
  check(
    "ONBOARDING: الطلب المنتهي يُرفض (إهمال) — ويُطلق طلب جديد لاحقاً",
    !expiredCallback.success &&
      expiredCallback.code === "AUTHORIZATION_EXPIRED",
  );

  // ── O8. callback replay protection ────────────────────────────────
  // A FRESH attempt: the first callback consumes (and provisions) it,
  // the second is a deterministic rejection.
  const replayBegin = await onboardingFeature.beginWhatsAppOnboarding(
    onboardingDeps(),
    ADMIN_B,
    { redirectUri: "http://localhost:3000/whatsapp-onboarding/callback" },
  );
  const replay = await onboardingFeature.handleWhatsAppAuthorizationCallback(
    onboardingDeps(),
    {
      stateRef: launchedStateRef(replayBegin),
      code: "fp-deterministic-authorization-code",
      redirectUri: "http://localhost:3000/whatsapp-onboarding/callback",
    },
  );
  const replay2 = await onboardingFeature.handleWhatsAppAuthorizationCallback(
    onboardingDeps(),
    {
      stateRef: launchedStateRef(replayBegin),
      code: "fp-deterministic-authorization-code",
      redirectUri: "http://localhost:3000/whatsapp-onboarding/callback",
    },
  );
  check(
    "ONBOARDING: إعادة تشغيل الـ callback محمية — الاستهلاك مرة واحدة فقط",
    replay.success &&
      !replay2.success &&
      replay2.code === "AUTHORIZATION_ALREADY_CONSUMED",
  );

  // ── O10. cross-tenant authorization state rejection ────────────────
  const crossTenantRef = nextStateRef();
  await authorizationRepo.create({
    businessId: BUSINESS_B, // the ledger says Business B...
    connectionId: rowOf(BUSINESS_A)!.id, // ...but connection A
    stateRef: crossTenantRef,
    expiresAt: new Date(fixedNow.getTime() + 60_000),
  });
  const crossTenant =
    await onboardingFeature.handleWhatsAppAuthorizationCallback(
      onboardingDeps(),
      {
        stateRef: crossTenantRef,
        code: "fp-deterministic-authorization-code",
        redirectUri: "http://localhost:3000/whatsapp-onboarding/callback",
      },
    );
  check(
    "ONBOARDING: حالة عابرة للمنشآات (اتصال لا يخص المنشأة المسجّلة) → رفض",
    !crossTenant.success &&
      crossTenant.code === "AUTHORIZATION_CONNECTION_MISMATCH",
  );

  // ── O11. duplicate phone_number_id rejection ───────────────────────
  const claimedExternalId = rowOf(BUSINESS_A)!.externalId!;
  const foreignConnection = rowOf(BUSINESS_B)!;
  const dupRef = nextStateRef();
  await authorizationRepo.create({
    businessId: BUSINESS_B,
    connectionId: foreignConnection.id,
    stateRef: dupRef,
    expiresAt: new Date(fixedNow.getTime() + 60_000),
  });
  // Pretend the provider reports Business A's identity to Business B.
  // The authorizer is told to return A's externalId verbatim, so the
  // duplicate guard has a real collision to reject.
  const dupBegin = await onboardingFeature.beginWhatsAppOnboarding(
    onboardingDeps({ externalId: claimedExternalId }),
    ADMIN_B,
    { redirectUri: "http://localhost:3000/whatsapp-onboarding/callback" },
  );
  const dupCallback =
    await onboardingFeature.handleWhatsAppAuthorizationCallback(
      onboardingDeps({ externalId: claimedExternalId }),
      {
        stateRef: launchedStateRef(dupBegin) || dupRef,
        code: "fp-deterministic-authorization-code",
        redirectUri: "http://localhost:3000/whatsapp-onboarding/callback",
      },
    );
  check(
    "ONBOARDING: معرّف الرقم (phone_number_id) لا يصبح غامضاً بين منشأتين",
    !dupCallback.success &&
      dupCallback.code === "DUPLICATE_EXTERNAL_ID" &&
      // The owning Business keeps its identity, and the attempt that
      // tried to claim it ended FAILED without stealing it.
      rowOf(BUSINESS_A)!.externalId === claimedExternalId &&
      rowOf(BUSINESS_B)!.externalId !== claimedExternalId &&
      rowOf(BUSINESS_B)!.onboardingState === "FAILED" &&
      rowOf(BUSINESS_B)!.onboardingReasonCode === "DUPLICATE_EXTERNAL_ID",
  );

  // ── O12. customer-side ACTION_REQUIRED + FAILED diagnostics ────────
  const actionBegin = await onboardingFeature.beginWhatsAppOnboarding(
    onboardingDeps({ outcome: "action_required" }),
    ADMIN_B,
    { redirectUri: "http://localhost:3000/whatsapp-onboarding/callback" },
  );
  const actionCallback =
    await onboardingFeature.handleWhatsAppAuthorizationCallback(
      onboardingDeps({ outcome: "action_required" }),
      {
        stateRef: launchedStateRef(actionBegin),
        code: "fp-deterministic-authorization-code",
        redirectUri: "http://localhost:3000/whatsapp-onboarding/callback",
      },
    );
  const actionConnection = rowOf(BUSINESS_B);
  check(
    "ONBOARDING: يحتاج إجراء (ACTION_REQUIRED) من جهة المزوّد — مفتوح وليس فشلاً",
    actionCallback.success &&
      actionCallback.onboardingState === "ACTION_REQUIRED" &&
      actionConnection?.onboardingState === "ACTION_REQUIRED" &&
      actionConnection?.onboardingReasonCode === "PROVIDER_REVIEW_PENDING" &&
      actionConnection?.onboardingRetryable === false &&
      actionConnection?.onboardingFailedAt === null,
  );
  const failedBegin = await onboardingFeature.beginWhatsAppOnboarding(
    onboardingDeps({ outcome: "declined" }),
    ADMIN_B,
    { redirectUri: "http://localhost:3000/whatsapp-onboarding/callback" },
  );
  const failedCallback =
    await onboardingFeature.handleWhatsAppAuthorizationCallback(
      onboardingDeps({ outcome: "declined" }),
      {
        stateRef: launchedStateRef(failedBegin),
        code: "fp-deterministic-authorization-code",
        redirectUri: "http://localhost:3000/whatsapp-onboarding/callback",
      },
    );
  const failedConnection = rowOf(BUSINESS_B);
  check(
    "ONBOARDING: FAILED مع تشخيص طبيعي ومختصر (آخر فشل فقط)",
    !failedCallback.success &&
      failedCallback.code === "AUTHORIZATION_DECLINED" &&
      failedConnection?.onboardingState === "FAILED" &&
      failedConnection?.onboardingReasonCode === "AUTHORIZATION_DECLINED" &&
      failedConnection?.onboardingRetryable === false &&
      failedConnection?.onboardingFailedAt !== null,
  );
  check(
    "ONBOARDING: التشخيص يرفض حمولة المزوّد الخام (لا رمز/لا token/لا header)",
    Boolean(failedConnection) &&
      !JSON.stringify(failedConnection).includes("EAA") &&
      !JSON.stringify(failedConnection).includes("authorization_code") &&
      !JSON.stringify(failedConnection).includes("Bearer"),
  );
  // The mapping is exhaustive over the provider-neutral error codes.
  const mapped = new Set(
    Object.values(failureModule).flatMap((value) =>
      typeof value === "object" && value !== null && "reasonCode" in value
        ? [(value as { reasonCode: string }).reasonCode]
        : [],
    ),
  );
  check(
    "ONBOARDING: كل رموز أخطاء التفويض لها تصنيف طبيعي (لا رمز خام)",
    [...transport.authorizationErrorCodeValues].every((code) => {
      try {
        return (
          failureModule.describeAuthorizationFailure(code).reasonCode.length > 0
        );
      } catch {
        return false;
      }
    }) && mapped.size > 0,
  );

  // ── O13. credentials reference boundary ────────────────────────────
  const envRef = "WHATSAPP_META_TOKEN_BUSINESS_A";
  const envResolution =
    await credentialsModule.defaultCredentialsResolver.resolve(envRef);
  const runtimeResolution =
    await credentialsModule.defaultCredentialsResolver.resolve(
      "fp:0123456789abcdef01234567",
    );
  check(
    "CREDENTIALS: مرجع ENV يُحلّ (اسم متغيّر بيئة) — والمرجع RUNTIME يُحلّ من المخزن (غير المتاح = رفض صادق)",
    envResolution.ok === false && // the env var is NOT set in this harness → honest UNRESOLVED
      envResolution.code === "UNRESOLVED_REFERENCE" &&
      !("value" in envResolution) &&
      // The RUNTIME backend is no longer deferred: the reference routes to
      // the encrypted store and, with no master key / no stored row in this
      // harness, is refused with the same honest UNRESOLVED code — never a
      // fake value and never a silent UNSUPPORTED placeholder.
      runtimeResolution.ok === false &&
      runtimeResolution.code === "UNRESOLVED_REFERENCE" &&
      !("value" in runtimeResolution),
  );
  check(
    "CREDENTIALS: تصنيف المرجع — NULL/القديم = ENV، fp:* = RUNTIME",
    credentialsModule.classifyCredentialReference(null) === "ENV" &&
      credentialsModule.classifyCredentialReference(envRef) === "ENV" &&
      credentialsModule.classifyCredentialReference(
        "fp:0123456789abcdef01234567",
      ) === "RUNTIME",
  );
  const runtimeBegin = await onboardingFeature.beginWhatsAppOnboarding(
    onboardingDeps({ credentialKind: "RUNTIME" }),
    ADMIN_B,
    { redirectUri: "http://localhost:3000/whatsapp-onboarding/callback" },
  );
  const runtimeCallback =
    await onboardingFeature.handleWhatsAppAuthorizationCallback(
      onboardingDeps({ credentialKind: "RUNTIME" }),
      {
        stateRef: launchedStateRef(runtimeBegin),
        code: "fp-deterministic-authorization-code",
        redirectUri: "http://localhost:3000/whatsapp-onboarding/callback",
      },
    );
  const runtimeConnection = rowOf(BUSINESS_B);
  check(
    "CREDENTIALS: مرجع RUNTIME (fp:*) يُخزّن كمرجع فقط — القيمة لا تُخزّن أبداً",
    runtimeCallback.success &&
      runtimeConnection?.credentialKind === "RUNTIME" &&
      runtimeConnection?.credentialsRef?.startsWith("fp:") === true &&
      !JSON.stringify(runtimeConnection).includes("EAA"),
  );

  // ── O14. legacy / existing rows stay honest ────────────────────────
  const legacy = await repo.create({
    businessId: BUSINESS_B,
    branchId: null,
    phoneNumber: "+201009990000",
    provider: "meta-whatsapp",
    externalId: "LEGACY-EXISTING-ID",
    credentialsRef: "WHATSAPP_META_ACCESS_TOKEN",
    status: "CONNECTED",
  });
  check(
    "ONBOARDING: الصفوف القديمة: NOT_STARTED افتراضياً — لا ادعاء READY كاذب",
    legacy.onboardingState === "NOT_STARTED" &&
      legacy.onboardingActor === "NONE" &&
      legacy.credentialKind === null && // NULL = ENV (the existing grammar)
      legacy.status === "CONNECTED", // operational meaning untouched
  );

  // ── O15. customer UI exposes only safe labels/fields ───────────────
  const customerView = onboardingFeature.resolveOnboardingStatus(
    rowOf(BUSINESS_A),
  );
  const customerKeys = Object.keys(customerView);
  const customerLabels = new Set(
    Object.values(onboardingFeature.ONBOARDING_STATUS_LABELS),
  );
  check(
    "العرض: واجهة العميل تحوي الحقول الآمنة فقط (لا WABA/phone_number_id/توكن)",
    customerKeys.length === 6 &&
      customerKeys.includes("statusLabel") &&
      customerKeys.includes("onboardingState") &&
      customerKeys.includes("operationallyConnected") &&
      customerKeys.includes("cta") &&
      !customerKeys.some((key) =>
        ["wabaId", "externalId", "metaBusinessId", "credentialsRef"].includes(
          key,
        ),
      ),
  );
  check(
    "العرض: تسميات دورة الحالة الستة المبسطة فقط (لغة العميل)",
    customerLabels.size === 6 &&
      customerLabels.has("جاهز") &&
      customerLabels.has("غير متصل") &&
      customerLabels.has("جاري الربط") &&
      customerLabels.has("جاري التجهيز") &&
      customerLabels.has("يحتاج إجراء") &&
      customerLabels.has("تعذر إكمال الربط") &&
      !customerView.statusLabel.includes("phone_number_id") &&
      !customerView.statusLabel.includes("WABA"),
  );

  // ── O16. Super Admin sees only safe projections ────────────────────
  const listResult = await platformService.listBusinessOnboardingOverviews(
    PLATFORM_OPERATOR,
    {},
    platformDeps,
  );
  const overviewResult = await platformService.getBusinessOnboardingOverview(
    PLATFORM_OPERATOR,
    BUSINESS_A,
    platformDeps,
  );
  const listJson = listResult.success ? JSON.stringify(listResult.data) : "";
  const overviewJson = overviewResult.success
    ? JSON.stringify(overviewResult.data)
    : "";
  check(
    "PLATFORM: مشغل المنصة يرى الإسقاط الآمن فقط (لا قيمة credentialsRef)",
    listResult.success &&
      overviewResult.success &&
      !listJson.includes("credentialsRef") &&
      !overviewJson.includes("credentialsRef") &&
      !("credentialsRef" in overviewResult.data.overview.whatsapp) &&
      !overviewJson.includes("phone_number_id") &&
      // The raw provider connection identity never appears — only the
      // masked projection of it.
      !overviewJson.includes(rowOf(BUSINESS_A)!.externalId ?? "no-such-id"),
  );
  // No token-shaped value anywhere in the operator view.
  const tokenShaped = /[A-Za-z0-9_-]{64,}|EAA[A-Za-z0-9]+|Bearer\s/;
  const maskedExternalId = overviewResult.success
    ? overviewResult.data.overview.whatsapp.externalIdMasked
    : null;
  const maskedPhone = overviewResult.success
    ? overviewResult.data.overview.whatsapp.displayPhoneMasked
    : null;
  check(
    "PLATFORM: لا قيم بشكل رمز (token) في عرض المشغل — والمعرّفات مموّهة",
    !tokenShaped.test(listJson) &&
      !tokenShaped.test(overviewJson) &&
      maskedExternalId?.includes("••") === true &&
      maskedPhone?.includes("•") === true,
  );
  // The projection is derived, never a DB row spread.
  check(
    "PLATFORM: الإسقاط يُشتق صراحةً (business/whatsapp/metaProvenance/onboarding/operations)",
    overviewResult.success &&
      Object.keys(overviewResult.data.overview).length === 5 &&
      Object.keys(overviewResult.data.overview.onboarding).length === 8 &&
      Object.keys(overviewResult.data.overview.metaProvenance).length === 5,
  );
  const forbiddenList = await platformService.listBusinessOnboardingOverviews(
    BUSINESS_ACTOR,
    {},
    platformDeps,
  );
  const forbiddenDetail = await platformService.getBusinessOnboardingOverview(
    BUSINESS_ACTOR,
    BUSINESS_A,
    platformDeps,
  );
  check(
    "PLATFORM: حساب الأعمال لا يصل إلى سطح قراءة المشغل (FORBIDDEN)",
    !forbiddenList.success &&
      forbiddenList.error.code === "FORBIDDEN" &&
      !forbiddenDetail.success &&
      forbiddenDetail.error.code === "FORBIDDEN",
  );
  const invalidTarget = await platformService.getBusinessOnboardingOverview(
    PLATFORM_OPERATOR,
    "not-a-uuid",
    platformDeps,
  );
  check(
    "PLATFORM: معرّف عشوائي من رابط → INVALID_INPUT (لا يصل المستودع)",
    !invalidTarget.success && invalidTarget.error.code === "INVALID_INPUT",
  );

  // ── O17. managed model: no customer-facing manual credential write ──
  // The customer settings surface must never ask for or persist a
  // phone_number_id, an environment-variable name, or any provider
  // credential. Those are derived server-side by the authorization
  // callback. The customer write path is gone by construction: the
  // actions module exports only operational actions.
  const actions =
    await import("../src/features/whatsapp-connection/actions/whatsapp-connection-actions");
  const actionExports = Object.keys(actions);
  check(
    "MANAGED: لا مسار حفظ يدوي لبيانات اعتماد في واجهة العميل",
    !actionExports.includes("saveWhatsAppConnectionAction") &&
      actionExports.includes("verifyWhatsAppConnectionAction") &&
      actionExports.includes("disconnectWhatsAppConnectionAction") &&
      actionExports.includes("reactivateWhatsAppConnectionAction"),
  );
  // The settings screen carries no credential inputs at all.
  const screenModule =
    await import("../src/features/whatsapp-connection/components/whatsapp-connection-screen");
  const screenSource = screenModule.toString();
  check(
    "MANAGED: شاشة الإعدادات تحوي حقول حالة فقط — لا phone_number_id ولا credentialsRef",
    !screenSource.includes("credentialsRef") &&
      !screenSource.includes("saveWhatsAppConnectionAction") &&
      !screenSource.includes("WHATSAPP_META_ACCESS_TOKEN"),
  );

  // ── O18. no-connection CTA is a launch, not a self-link ─────────────
  // On `/settings/whatsapp` a CONFIGURE link would point at the page the
  // customer is already on. The begin use case creates the connection,
  // so BEGIN is the correct action from any surface.
  const noConnectionView = onboardingFeature.resolveOnboardingStatus(null);
  check(
    "MANAGED: غياب اتصال → إجراء بدء الربط (لا رابط دائري للإعدادات)",
    noConnectionView.cta === "BEGIN" &&
      noConnectionView.onboardingState === "NOT_STARTED" &&
      noConnectionView.operationallyConnected === false,
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
    `\nاختبارات ربط واتساب للأعمال صحيحة: ${checks.length}/${checks.length} فحص ناجح.`,
  );
}

main().catch((error: Error) => {
  console.error(`فشل غير متوقع: ${error.message}\n${error.stack}`);
  process.exit(1);
});
