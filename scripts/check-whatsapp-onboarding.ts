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
  console.error(`فشل غير متوقع: ${error.message}`);
  process.exit(1);
});
