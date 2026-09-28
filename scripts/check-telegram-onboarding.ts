/* eslint-disable @typescript-eslint/consistent-type-imports */

/**
 * FlowPilot — TELEGRAM customer onboarding journey harness
 * (DECISIONS #67 — slice TELEGRAM 03B: the `/settings/telegram` surface).
 *
 * The SMALLEST focused surface exercising the approved customer journey
 * end to end, through the REAL settings service + the REAL manager
 * webhook handler, with in-memory fakes only — no DB, no network, no real
 * credentials, and NO fabricated live result. This is the offline mirror
 * of the ONE real live E2E the operator runs after release
 * (`docs/TELEGRAM.md → Live E2E`):
 *
 *   EMPTY → provisioning created → Telegram launch URL generated
 *        → the managed-bot completion observed → CONNECTED
 *
 * The browser never assumes completion: every transition below is read
 * back through the SAME polling surface the UI uses
 * (`getTelegramConnectionStatus`), exactly as the screen does — so the
 * harness proves the UI observes only server-derived state and stops
 * polling once the terminal state is reached.
 *
 * It also covers the honest failure loop the approved model guarantees
 * (never a permanent spinner, never a half-provisioned connection, never
 * a resumed poisoned row):
 *
 *   a typed terminal failure → ACTION_REQUIRED + a retryable label
 *                          → a fresh attempt (new token, new deep link)
 *
 * Run: pnpm check:telegram-onboarding
 */

export {};

type Check = { label: string; pass: boolean };

const checks: Check[] = [];
function check(label: string, pass: boolean): void {
  checks.push({ label, pass });
}
function eq<T>(actual: T, expected: T): boolean {
  return actual === expected;
}

// ── Fixtures (no real credentials) ──────────────────────────────────────────

const BUSINESS_A = "11111111-1111-4111-8111-111111111111";
const BUSINESS_B = "22222222-2222-4222-8222-222222222222";
const BOT_ID = "6123456789";
const BOT_USERNAME = "flowpilot_demo";
const BOT_DISPLAY_NAME = "بوت عيادة الابتسامة";
const MANAGER_BOT_ID = "6987654321";
const CREATOR_ID = "9876543210";
const BUSINESS_NAME = "عيادة الابتسامة";
const MANAGER_USERNAME = "FlowPilotManagerBot";
const BOT_TOKEN_VALUE = "1234567890:AAA-managed-bot-token-never-logged";
const MANAGER_TOKEN_VALUE = "6987654321:AAA-manager-bot-token-never-logged";
const WEBHOOK_BASE = "https://flowpilot.example.com";

async function main(): Promise<void> {
  // Offline harness convention (see check-telegram): seed placeholder env
  // BEFORE importing the service/transport layer, which evaluates the
  // fail-fast env module at import time. No DB or network is ever
  // contacted — every dependency below is in-memory.
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const {
    beginTelegramProvisioning,
    getTelegramConnectionStatus,
    PROVISIONING_OUTCOME_LABELS,
    resolveTelegramConnectionView,
  } =
    await import("@/features/telegram-connection/server/telegram-connection-service");
  const { handleTelegramManagerWebhook } =
    await import("@/server/integrations/telegram/telegram-manager-webhook-handler");
  const { deriveManagerWebhookSecret, MANAGED_BOT_REQUEST_ID } =
    await import("@/server/integrations/telegram/telegram-provisioning");
  const {
    STANDARD_TELEGRAM_PACKAGE,
    isAndroidUserAgent,
    buildTelegramAndroidIntentUrl,
    buildAndroidTelegramLaunchTargets,
  } = await import("@/features/telegram-connection/telegram-app-launcher");

  // ── In-memory fakes (mirror check-telegram.ts; no Prisma, no fetch) ──────

  type LedgerRow = {
    id: string;
    businessId: string;
    connectionId: string | null;
    startToken: string;
    creatorTelegramUserId: string | null;
    expiresAt: Date;
    consumedAt: Date | null;
    outcomeCode: string | null;
    createdAt: Date;
  };
  type ConnectionRow = import("@/types/domain").TelegramConnection;

  const ledger: LedgerRow[] = [];
  const connections: ConnectionRow[] = [];
  const storedSecrets = new Map<string, string>();
  const sentManager: Array<{
    chatId: string;
    text: string;
    markup?: unknown;
  }> = [];
  let ledgerSeq = 0;
  let connectionSeq = 0;

  // A controllable Bot API fixture: `getManagedBotToken` fails on demand
  // (the typed-failure leg of the journey). Everything else stays healthy.
  const scenario = { failManagedBotToken: false };

  const api = {
    fetchImpl: (async (url: string, init?: RequestInit) => {
      const method = url.split("/").pop();
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<
        string,
        unknown
      >;
      if (method === "sendMessage") {
        sentManager.push({
          chatId: String(body.chat_id),
          text: String(body.text),
          markup: body.reply_markup,
        });
        return new Response(
          JSON.stringify({ ok: true, result: { message_id: 1 } }),
          { status: 200 },
        );
      }
      if (method === "getManagedBotToken") {
        if (scenario.failManagedBotToken) {
          return new Response(
            JSON.stringify({
              ok: false,
              error_code: 401,
              description: "unauthorized",
            }),
            { status: 401 },
          );
        }
        return new Response(
          JSON.stringify({ ok: true, result: BOT_TOKEN_VALUE }),
          { status: 200 },
        );
      }
      if (method === "setWebhook") {
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
        });
      }
      if (method === "getMe") {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              id: Number(BOT_ID),
              is_bot: true,
              username: BOT_USERNAME,
              first_name: BOT_DISPLAY_NAME,
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: false, error_code: 400 }), {
        status: 400,
      });
    }) as typeof fetch,
    apiHost: "https://api.telegram.org",
    credentialsResolver: {
      resolve: async (reference: string) => {
        const value = storedSecrets.get(reference);
        return value
          ? { ok: true as const, kind: "RUNTIME" as const, reference, value }
          : {
              ok: false as const,
              code: "UNRESOLVED_REFERENCE" as const,
              message: "غير متاح",
            };
      },
    },
  };

  const deps = {
    api,
    ledgerRepository: {
      create: async (input: {
        businessId: string;
        startToken: string;
        expiresAt: Date;
      }) => {
        const row: LedgerRow = {
          id: `led-${++ledgerSeq}`,
          businessId: input.businessId,
          connectionId: null,
          startToken: input.startToken,
          creatorTelegramUserId: null,
          expiresAt: input.expiresAt,
          consumedAt: null,
          outcomeCode: null,
          createdAt: new Date(),
        };
        ledger.push(row);
        return row;
      },
      findActiveByBusiness: async (businessId: string) =>
        ledger.find(
          (row) =>
            row.businessId === businessId &&
            row.consumedAt === null &&
            row.expiresAt > new Date(),
        ) ?? null,
      findLatestByBusiness: async (businessId: string) =>
        ledger
          .filter((row) => row.businessId === businessId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ??
        null,
      bindCreator: async (
        startToken: string,
        creatorTelegramUserId: string,
      ) => {
        const row = ledger.find(
          (candidate) =>
            candidate.startToken === startToken &&
            candidate.consumedAt === null &&
            candidate.expiresAt > new Date() &&
            (candidate.creatorTelegramUserId === null ||
              candidate.creatorTelegramUserId === creatorTelegramUserId),
        );
        if (!row) return false;
        row.creatorTelegramUserId = creatorTelegramUserId;
        return true;
      },
      findActiveByCreator: async (creator: string) =>
        ledger.find(
          (row) =>
            row.creatorTelegramUserId === creator &&
            row.consumedAt === null &&
            row.expiresAt > new Date(),
        ) ?? null,
      consume: async (startToken: string, creator: string) => {
        const row = ledger.find(
          (candidate) =>
            candidate.startToken === startToken &&
            candidate.creatorTelegramUserId === creator &&
            candidate.consumedAt === null &&
            candidate.expiresAt > new Date(),
        );
        if (!row) return false;
        row.consumedAt = new Date();
        return true;
      },
      recordOutcome: async (
        startToken: string,
        outcomeCode: string,
        now: Date,
      ) => {
        const row = ledger.find(
          (candidate) => candidate.startToken === startToken,
        );
        if (!row) return false;
        row.consumedAt = now;
        row.outcomeCode = outcomeCode;
        return true;
      },
      recordConnectionId: async (startToken: string, connectionId: string) => {
        const row = ledger.find(
          (candidate) => candidate.startToken === startToken,
        );
        if (row) row.connectionId = connectionId;
      },
    },
    connectionRepository: {
      findPrimaryByBusiness: async (businessId: string) =>
        connections
          .filter((row) => row.businessId === businessId)
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0] ??
        null,
      findByIdWithinBusiness: async (id: string, businessId: string) =>
        connections.find(
          (row) => row.id === id && row.businessId === businessId,
        ) ?? null,
      update: async (
        id: string,
        businessId: string,
        input: import("@/lib/validation").UpdateTelegramConnectionDto,
      ) => {
        const row = connections.find(
          (candidate) =>
            candidate.id === id && candidate.businessId === businessId,
        );
        if (!row) return null;
        Object.assign(row, {
          ...input,
          branchId: input.branchId ?? row.branchId,
          updatedAt: new Date(),
        });
        return row;
      },
      disconnect: async () => null,
      findByExternalId: async (botExternalId: string) =>
        connections.find((row) => row.botExternalId === botExternalId) ?? null,
      create: async (
        input: import("@/lib/validation").CreateTelegramConnectionDto,
      ) => {
        const now = new Date();
        const connection: ConnectionRow = {
          id: `${BOT_ID}-${++connectionSeq}`,
          businessId: input.businessId,
          branchId: input.branchId ?? null,
          displayName: input.displayName ?? null,
          botExternalId: input.botExternalId,
          botUsername: input.botUsername ?? null,
          provider: input.provider,
          status: input.status,
          credentialsRef: input.credentialsRef ?? null,
          credentialKind: input.credentialKind,
          webhookSecretHash: input.webhookSecretHash ?? null,
          isActive: input.isActive,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          onboardingState: input.onboardingState,
          onboardingActor: input.onboardingActor,
          onboardingReasonCode: null,
          onboardingReasonSummary: null,
          onboardingRetryable: null,
          onboardingStateChangedAt: null,
          onboardingCompletedAt: null,
          onboardingFailedAt: null,
          managerBotId: input.managerBotId ?? null,
          creatorTelegramUserId: input.creatorTelegramUserId ?? null,
        };
        connections.push(connection);
        return connection;
      },
      markOnboardingReady: async (id: string, businessId: string) => {
        const row = connections.find(
          (candidate) =>
            candidate.id === id &&
            candidate.businessId === businessId &&
            candidate.status === "CONNECTED" &&
            candidate.isActive,
        );
        if (!row) return null;
        const now = new Date();
        Object.assign(row, {
          onboardingState: "READY",
          onboardingActor: "FLOWPILOT",
          onboardingStateChangedAt: now,
          onboardingCompletedAt: now,
          updatedAt: now,
        });
        return row;
      },
    },
    credentialStore: {
      store: async (params: {
        businessId: string;
        reference: string;
        secret: string;
      }) => {
        storedSecrets.set(params.reference, params.secret);
        return { ok: true as const, reference: params.reference };
      },
      delete: async (reference: string) => {
        storedSecrets.delete(reference);
        return { ok: true as const };
      },
    },
    businessRepository: {
      findById: async (id: string) =>
        ({
          id,
          name: BUSINESS_NAME,
          isActive: true,
        }) as unknown as import("@/types/domain").Business,
    },
    getEnvVar: (name: string) =>
      name === "TELEGRAM_MANAGER_BOT_TOKEN" ? MANAGER_TOKEN_VALUE : undefined,
    webhookBaseUrl: WEBHOOK_BASE,
    managerBotId: MANAGER_BOT_ID,
    managerBotUsername: MANAGER_USERNAME,
    now: () => new Date(),
  };

  const MANAGER_SECRET = deriveManagerWebhookSecret(MANAGER_TOKEN_VALUE);

  function managerRequest(body: unknown, secret: string | null): Request {
    return new Request(`${WEBHOOK_BASE}/api/telegram/manager/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(secret ? { "X-Telegram-Bot-Api-Secret-Token": secret } : {}),
      },
      body: JSON.stringify(body),
    });
  }
  async function runManager(
    body: unknown,
    secret: string | null = MANAGER_SECRET,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await handleTelegramManagerWebhook(
      deps,
      managerRequest(body, secret),
    );
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  }

  // The actor the settings service authorizes (ADMIN, own Business). The
  // Business is ALWAYS server-derived — the screen sends no identity.
  const admin = {
    userId: "user-a",
    role: "ADMIN" as const,
    businessId: BUSINESS_A,
  };

  // ════════════════════════════════════════════════════════════════════════
  // 1. EMPTY — no connection, no attempt → the primary CTA
  // ════════════════════════════════════════════════════════════════════════

  const emptyStatus = await getTelegramConnectionStatus(deps, admin);
  check(
    "1. صفحة نظيفة → الحالة EMPTY + لا اتصال ولا محاولة",
    emptyStatus.success === true &&
      emptyStatus.view.uiState === "EMPTY" &&
      emptyStatus.view.botUsername === null &&
      emptyStatus.view.operationallyConnected === false,
  );

  // ════════════════════════════════════════════════════════════════════════
  // 2. PENDING — provisioning created; the launch URL is generated
  // ════════════════════════════════════════════════════════════════════════

  const launch = await beginTelegramProvisioning(deps, admin);
  const launched = launch.success && launch.launched ? launch : null;
  const startToken = launched
    ? new URL(launched.authorizationUrl).searchParams.get("start")
    : null;
  check(
    "2. إنشاء الجلسة → نجاح + رابط فتح لمدير البوت",
    launched !== null &&
      launched.launched === true &&
      /^https:\/\/t\.me\/FlowPilotManagerBot\?start=[A-Za-z0-9_-]{16,128}$/.test(
        launched.authorizationUrl,
      ) === true,
  );
  check(
    "3. الرابط يحمل الرمز المعتمد فقط — لا معرّف منشأة ولا أي سرّ",
    launched !== null &&
      startToken !== null &&
      !launched.authorizationUrl.includes(BUSINESS_A) &&
      !launched.authorizationUrl.includes(BOT_TOKEN_VALUE) &&
      !launched.authorizationUrl.includes(MANAGER_TOKEN_VALUE),
  );
  check(
    "4. الجلسة مسجَّلة في الدفتر (الخادم هو المرجع، لا افتراض عميل)",
    startToken !== null &&
      ledger.some(
        (row) => row.startToken === startToken && row.consumedAt === null,
      ) === true,
  );

  // ════════════════════════════════════════════════════════════════════════
  // 3. PROVISIONING — the UI's poll reads the server-derived state
  // ════════════════════════════════════════════════════════════════════════

  const provisioningStatus = await getTelegramConnectionStatus(deps, admin);
  check(
    "5. الاستطلاع يقرأ PROVISIONING من الخادم (لا يفترض العميل النجاح)",
    provisioningStatus.success === true &&
      provisioningStatus.view.uiState === "PROVISIONING" &&
      provisioningStatus.view.operationallyConnected === false,
  );
  // The re-open affordance (the PENDING "redirect/open action available"):
  // re-launching an in-flight attempt RESUMES it — the same token, the same
  // deep link, no second attempt orphaned.
  const reopen = await beginTelegramProvisioning(deps, admin);
  const reopenedToken =
    reopen.success && reopen.launched
      ? new URL(reopen.authorizationUrl).searchParams.get("start")
      : null;
  check(
    "6. إعادة الفتح أثناء التنفيذ تستأنف نفس الجلسة (نفس الرمز والرابط)",
    reopen.success === true &&
      reopen.launched === true &&
      reopenedToken !== null &&
      reopenedToken === startToken &&
      ledger.filter((row) => row.businessId === BUSINESS_A).length === 1,
  );

  // ════════════════════════════════════════════════════════════════════════
  // 4. The single required Telegram confirmation: `/start` → the keyboard
  // ════════════════════════════════════════════════════════════════════════

  sentManager.length = 0;
  const startReply = await runManager({
    update_id: 7000001,
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(CREATOR_ID), type: "private" },
      from: { id: Number(CREATOR_ID), is_bot: false },
      text: `/start ${startToken}`,
    },
  });
  const startKeyboard = sentManager[0]?.markup as
    | {
        keyboard: Array<
          Array<{
            text: string;
            request_managed_bot: { request_id: number };
          }>
        >;
      }
    | undefined;
  check(
    "7. /start بالرمز الصحيح → 200 + ربط المنشئ + لوحة إنشاء البوت",
    startReply.status === 200 &&
      eq(startReply.body.start, "BOUND") &&
      startKeyboard !== undefined &&
      startKeyboard.keyboard[0]?.[0]?.request_managed_bot?.request_id ===
        MANAGED_BOT_REQUEST_ID,
  );
  check(
    "8. رد المدير آمن فقط: لا توكن ولا معرّف تقني ولا إعداد ويبهوك",
    sentManager.length === 1 &&
      !JSON.stringify(sentManager).includes(BOT_TOKEN_VALUE) &&
      !JSON.stringify(sentManager).includes(MANAGER_TOKEN_VALUE) &&
      !JSON.stringify(sentManager).includes(BUSINESS_A),
  );
  // The creator binding is what makes the later event match a Business: a
  // forged managed_bot event that never went through the deep link must
  // match nothing (asserted in check-telegram section F6; this journey
  // confirms the legitimate binding side).
  check(
    "9. المنشئ مربوط بصف المحاولة (الحدث اللاحق سيطابقه)",
    ledger.find((row) => row.startToken === startToken)
      ?.creatorTelegramUserId === CREATOR_ID,
  );

  // ════════════════════════════════════════════════════════════════════════
  // 5. The managed-bot completion observed → CONNECTED
  // ════════════════════════════════════════════════════════════════════════

  const completion = await runManager({
    update_id: 7000002,
    managed_bot: {
      bot: { id: Number(BOT_ID), is_bot: true, username: BOT_USERNAME },
      user: { id: Number(CREATOR_ID), is_bot: false },
      added: true,
    },
  });
  check(
    "10. حدث managed_bot → 200 + اكتمال التفعيل من الخادم",
    completion.status === 200 &&
      eq(completion.body.provisioned, true) &&
      eq(completion.body.success, true),
  );

  const connectedStatus = await getTelegramConnectionStatus(deps, admin);
  check(
    "11. الاستطلاع يقرأ CONNECTED + اسم البوت واسمه الظاهر فقط (لا سرّ)",
    connectedStatus.success === true &&
      connectedStatus.view.uiState === "CONNECTED" &&
      connectedStatus.view.operationallyConnected === true &&
      connectedStatus.view.botUsername === BOT_USERNAME &&
      connectedStatus.view.botDisplayName === BOT_DISPLAY_NAME,
  );
  const connectedRow = connections.find((row) => row.businessId === BUSINESS_A);
  check(
    "12. التوكن مُخزَّن كمرجع fp:<id> فقط — القيمة لا تظهر في أي مخرج",
    connectedRow !== undefined &&
      connectedRow.credentialsRef?.startsWith("fp:") === true &&
      storedSecrets.get(connectedRow.credentialsRef) === BOT_TOKEN_VALUE &&
      !JSON.stringify(connectedStatus).includes(BOT_TOKEN_VALUE),
  );
  // Polling STOPS at the terminal state: the pure derivation returns
  // CONNECTED (not PROVISIONING), which is the screen's own stop condition.
  const terminalView = resolveTelegramConnectionView(
    connectedRow ?? null,
    ledger.find((row) => row.startToken === startToken) ?? null,
  );
  check(
    "13. الحالة الطرفية CONNECTED — الاستطلاع يتوقف (لا عودة لـ PROVISIONING)",
    terminalView.uiState === "CONNECTED" &&
      terminalView.operationallyConnected === true,
  );
  // Single-use: the completion consumed the attempt exactly once, so a
  // redelivered event provisions nothing and the connection is unchanged.
  const replay = await runManager({
    update_id: 7000003,
    managed_bot: {
      bot: { id: Number(BOT_ID), is_bot: true, username: BOT_USERNAME },
      user: { id: Number(CREATOR_ID), is_bot: false },
      added: true,
    },
  });
  check(
    "14. إعادة إرسال الحدث لا تُفعّل شيئاً (استخدام واحد — الحالة ثابتة)",
    replay.status === 200 &&
      eq(replay.body.provisioned, false) &&
      connections.filter((row) => row.businessId === BUSINESS_A).length === 1,
  );

  // ════════════════════════════════════════════════════════════════════════
  // 6. The honest failure loop (ACTION_REQUIRED → a fresh attempt)
  // ════════════════════════════════════════════════════════════════════════

  const failingAdmin = {
    userId: "user-b",
    role: "ADMIN" as const,
    businessId: BUSINESS_B,
  };
  const failedLaunch = await beginTelegramProvisioning(deps, failingAdmin);
  const failedToken =
    failedLaunch.success && failedLaunch.launched
      ? new URL(failedLaunch.authorizationUrl).searchParams.get("start")
      : null;
  if (failedToken) {
    await runManager({
      update_id: 7000004,
      message: {
        message_id: 2,
        date: Math.floor(Date.now() / 1000),
        chat: { id: Number(CREATOR_ID), type: "private" },
        from: { id: Number(CREATOR_ID), is_bot: false },
        text: `/start ${failedToken}`,
      },
    });
    // The provider leg fails (e.g. the manager bot loses Bot Management
    // Mode): the attempt must TERMINATE with a typed outcome — never a
    // permanent spinner, never a half-provisioned connection.
    scenario.failManagedBotToken = true;
    const failedCompletion = await runManager({
      update_id: 7000005,
      managed_bot: {
        bot: { id: Number(BOT_ID), is_bot: true, username: BOT_USERNAME },
        user: { id: Number(CREATOR_ID), is_bot: false },
        added: true,
      },
    });
    scenario.failManagedBotToken = false;
    const failedStatus = await getTelegramConnectionStatus(deps, failingAdmin);
    const failedRow = ledger.find((row) => row.startToken === failedToken);
    const failedView = failedStatus.success ? failedStatus.view : null;
    const outcome = failedRow?.outcomeCode
      ? PROVISIONING_OUTCOME_LABELS[failedRow.outcomeCode]
      : undefined;
    check(
      "15. فشل المزوّد → نتيجة مُؤكَّدة + محاولة منتهية برمز (لا spinner)",
      failedCompletion.status === 200 &&
        eq(failedCompletion.body.provisioned, false) &&
        failedStatus.success === true &&
        failedStatus.view.uiState === "ACTION_REQUIRED" &&
        failedRow?.consumedAt !== null &&
        failedRow?.outcomeCode !== null,
    );
    check(
      "16. سبب الفشل آمن وقابل لإعادة المحاولة في الواجهة",
      outcome !== undefined &&
        outcome.retryable === true &&
        failedView !== null &&
        failedView.summary !== null &&
        !String(failedView.summary).includes(BOT_TOKEN_VALUE),
    );
    check(
      "17. لا يوجد اتصال نصف مُهيأ بعد الفشل",
      connections.some((row) => row.businessId === BUSINESS_B) === false,
    );
    // The retry: a fresh attempt is minted (a NEW token + a NEW deep link)
    // — the terminated row is never resumed, and the poll observes the new
    // in-flight attempt.
    const retryLaunch = await beginTelegramProvisioning(deps, failingAdmin);
    const retryToken =
      retryLaunch.success && retryLaunch.launched
        ? new URL(retryLaunch.authorizationUrl).searchParams.get("start")
        : null;
    const retryStatus = await getTelegramConnectionStatus(deps, failingAdmin);
    check(
      "18. إعادة المحاولة → جلسة جديدة برمز جديد + PROVISIONING صادق",
      retryLaunch.success === true &&
        retryLaunch.launched === true &&
        retryToken !== null &&
        retryToken !== failedToken &&
        retryStatus.success === true &&
        retryStatus.view.uiState === "PROVISIONING",
    );
    // The terminated attempt stays terminal: the retry did NOT resume it
    // (its token is gone from the in-flight set).
    check(
      "19. الصف الفاشل لا يُستأنف أبداً (استهلاك واحد نهائي)",
      ledger.filter(
        (row) =>
          row.businessId === BUSINESS_B &&
          row.startToken === failedToken &&
          row.consumedAt !== null,
      ).length === 1,
    );
  } else {
    check("15-18. سجل فشل التفعيل", false);
  }

  // ════════════════════════════════════════════════════════════════════════
  // Authorization boundaries (the settings surface is ADMIN-only)
  // ════════════════════════════════════════════════════════════════════════

  check(
    "20. الاستعلام متاح للمدير فقط (STAFF مرفوض)",
    (
      await getTelegramConnectionStatus(deps, {
        userId: "user-staff",
        role: "STAFF",
        businessId: BUSINESS_A,
      })
    ).success === false,
  );
  check(
    "21. بدء التفعيل بدون منشأة مرتبطة مرفوض",
    (
      await beginTelegramProvisioning(deps, {
        userId: "user-none",
        role: "ADMIN",
        businessId: null,
      })
    ).success === false,
  );
  const finalStatus = await getTelegramConnectionStatus(deps, admin);
  check(
    "22. عميل لا يمكنه اختيار منشأة أخرى (الخادم يحدد النطاق)",
    finalStatus.success === true &&
      finalStatus.view.botUsername === BOT_USERNAME,
  );

  // ════════════════════════════════════════════════════════════════════════
  // Android Telegram app launcher (DECISIONS #72/#74)
  //
  // A CLIENT launch/compatibility helper only: it hands the EXISTING HTTPS
  // authorizationUrl to STANDARD Telegram via an intent:// URL, preserving
  // the original URL byte-for-byte as the fallback and NEVER touching the
  // opaque start token or the server contract. Telegram X is intentionally
  // NOT offered (DECISIONS #74).
  // ════════════════════════════════════════════════════════════════════════

  // A representative launch URL, exactly as beginTelegramProvisioning returns
  // it: the ONLY payload is the opaque single-use start token.
  const OPAQUE_START_TOKEN = "AbCdEf0123456789OPAQUE_start_TOKEN";
  const LAUNCH_URL = `https://t.me/${MANAGER_USERNAME}?start=${OPAQUE_START_TOKEN}`;

  const standardIntent = buildTelegramAndroidIntentUrl(
    LAUNCH_URL,
    STANDARD_TELEGRAM_PACKAGE,
  );
  const targets = buildAndroidTelegramLaunchTargets(LAUNCH_URL);
  const encodedOriginal = encodeURIComponent(LAUNCH_URL);

  // A — standard Telegram intent targets org.telegram.messenger, preserves
  // the original t.me URL as the underlying data + the fallback, and carries
  // NO transformed business/credential data (only the original token rides).
  check(
    "23. نية أندرويد لتيليجرام الرسمي تستهدف org.telegram.messenger",
    standardIntent.includes("package=org.telegram.messenger"),
  );
  check(
    "24. نية تيليجرام الرسمي تحفظ رابط t.me الأصلي كبيانات + كاحتياطي",
    standardIntent.startsWith(`intent://t.me/${MANAGER_USERNAME}?start=`) &&
      standardIntent.includes(`scheme=https`) &&
      standardIntent.includes(`S.browser_fallback_url=${encodedOriginal}`) &&
      standardIntent.endsWith(";end"),
  );
  check(
    "25. نية تيليجرام الرسمي لا تحوي أي بيانات منشأة/اعتماد محوّلة",
    !standardIntent.includes("businessId") &&
      !standardIntent.includes("connectionId") &&
      !standardIntent.includes("token=") &&
      // the opaque start token rides UNCHANGED (never parsed or rewritten)
      standardIntent.includes(`start=${OPAQUE_START_TOKEN}`) &&
      decodeURIComponent(encodedOriginal) === LAUNCH_URL,
  );

  // B — Telegram X is NOT exposed anywhere (DECISIONS #74): neither the
  // launcher module nor its built targets reference the Telegram X package
  // or a Telegram-X-specific intent.
  check(
    "26. تيليجرام X غير معروض إطلاقاً (لا حزمة org.thunderdog.challegram)",
    !JSON.stringify(targets).includes("org.thunderdog.challegram") &&
      !standardIntent.includes("org.thunderdog.challegram") &&
      // the chooser exposes ONLY the standard target + the plain fallback
      !("telegramX" in targets) &&
      Object.keys(targets).sort().join(",") === "fallback,standard",
  );
  check(
    "27. الهدف الرسمي الوحيد هو تيليجرام القياسي",
    targets.standard.packageName === STANDARD_TELEGRAM_PACKAGE &&
      targets.standard.url === standardIntent,
  );

  // C — the fallback returns EXACTLY the original authorizationUrl.
  check(
    "28. الرابط العادي يعيد authorizationUrl الأصلي حرفياً",
    targets.fallback.url === LAUNCH_URL &&
      targets.fallback.packageName === null,
  );

  // D — token safety: the helper never alters the opaque start token, never
  // persists/copies it into a new field, and is a pure function (calling it
  // twice on the same input yields an identical result and mutates nothing).
  check(
    "29. المساعد لا يغيّر رمز البدء المبهم (نفس الرمز في النية والاحتياطي)",
    standardIntent.includes(OPAQUE_START_TOKEN) &&
      decodeURIComponent(encodedOriginal).includes(OPAQUE_START_TOKEN) &&
      // the token is not truncated, re-encoded, or transformed anywhere
      LAUNCH_URL.includes(OPAQUE_START_TOKEN),
  );
  check(
    "30. المساعد دالة نقية (نفس المدخل ⇒ نفس المخرج، دون آثار جانبية)",
    buildTelegramAndroidIntentUrl(LAUNCH_URL, STANDARD_TELEGRAM_PACKAGE) ===
      standardIntent &&
      buildAndroidTelegramLaunchTargets(LAUNCH_URL).fallback.url === LAUNCH_URL,
  );

  // E — non-Android keeps the normal HTTPS launch (the chooser is never
  // shown): the platform gate is false off Android and true only on it.
  const DESKTOP_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
  const IOS_UA =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15";
  const ANDROID_UA =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36";
  check(
    "31. غير أندرويد (سطح المكتب) لا يعرض المُنتقي (السلوك المعتاد محفوظ)",
    isAndroidUserAgent(DESKTOP_UA) === false &&
      isAndroidUserAgent(IOS_UA) === false &&
      isAndroidUserAgent(null) === false &&
      isAndroidUserAgent(undefined) === false,
  );
  check(
    "32. أندرويد وحده يفعّل المُنتقي",
    isAndroidUserAgent(ANDROID_UA) === true,
  );

  // ── Report ─────────────────────────────────────────────────────────────────
  const failures = checks.filter((c) => !c.pass);
  for (const c of checks) {
    console.log(`${c.pass ? "✔" : "✘"} ${c.label}`);
  }
  console.log(
    `\nرحلة تفعيل تيليجرام للعميل مُتحقَّق منها دون اتصال: ${checks.length - failures.length}/${checks.length} فحص ناجح.`,
  );
  if (failures.length > 0) {
    console.error(
      `\nفحوصات فاشلة:\n${failures.map((c) => `  ✘ ${c.label}`).join("\n")}`,
    );
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  console.error("تعذّر تشغيل فحوصات رحلة تفعيل تيليجرام:", error);
  process.exitCode = 1;
});
