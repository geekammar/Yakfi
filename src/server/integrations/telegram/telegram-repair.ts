import {
  defaultCredentialsResolver,
  type CredentialsResolver,
} from "@/server/credentials/credentials-resolver";
import {
  TELEGRAM_CUSTOMER_ALLOWED_UPDATES,
  defaultTelegramApiDeps,
  resolveTelegramBotToken,
  telegramGetMe,
  telegramGetWebhookInfo,
  telegramSetWebhook,
  type TelegramApiDeps,
} from "@/server/integrations/telegram/telegram-client";
import {
  buildCustomerWebhookUrl,
  generateWebhookSecret,
} from "@/server/integrations/telegram/telegram-provisioning";
import { hashTelegramWebhookSecret } from "@/server/integrations/telegram/telegram-webhook";
import type { TelegramConnectionRepository } from "@/server/repositories";
import type { TelegramConnection } from "@/types/domain";

export type RepairTelegramWebhookParams = {
  businessId: string;
  connectionId: string;
  apply?: boolean;
  reconcileSecret?: boolean;
  expectedWebhookUrl?: string;
};

export type RepairTelegramWebhookDeps = {
  api: TelegramApiDeps;
  connectionRepository: Pick<
    TelegramConnectionRepository,
    "findByIdWithinBusiness" | "update"
  > & {
    updateWebhookSecretHash?: (
      id: string,
      businessId: string,
      webhookSecretHash: string,
      options?: { expectedPreviousHash?: string | null },
    ) => Promise<TelegramConnection | null>;
  };
  credentialsResolver: Pick<CredentialsResolver, "resolve">;
  generateWebhookSecret?: () => string;
  hashWebhookSecret?: (secret: string) => string;
  expectedWebhookUrl?: string;
  getEnvVar?: (key: string) => string | undefined;
  sleepImpl?: (ms: number) => Promise<void>;
};

export type RepairTelegramWebhookOutcome =
  | {
      ok: true;
      status: "ALREADY_CORRECT";
      checkOnly: boolean;
      botExternalId: string;
      botUsername?: string | null;
      webhookUrl: string;
      allowedUpdates: string[];
      pendingUpdateCount: number;
      lastErrorMessage?: string;
      note?: string;
    }
  | {
      ok: true;
      status: "REPAIR_REQUIRED";
      checkOnly: true;
      botExternalId: string;
      botUsername?: string | null;
      webhookUrl: string;
      currentAllowedUpdates: string[];
      targetAllowedUpdates: string[];
      pendingUpdateCount: number;
      lastErrorMessage?: string;
      note?: string;
    }
  | {
      ok: true;
      status: "REPAIRED" | "SECRET_RECONCILED";
      checkOnly: false;
      botExternalId: string;
      botUsername?: string | null;
      webhookUrl: string;
      allowedUpdates: string[];
      previousAllowedUpdates: string[];
      pendingUpdateCount: number;
      secretReconciled: boolean;
      webhookSecretHashPersisted: boolean;
    }
  | {
      ok: false;
      code: "PARTIAL_APPLICATION_RECOVERY_REQUIRED";
      status: "PARTIAL_FAILURE";
      botExternalId: string;
      botUsername?: string | null;
      webhookUrl: string;
      targetAllowedUpdates: string[];
      pendingUpdateCount: number;
      reconciliationCommand: string;
      message: string;
    }
  | {
      ok: false;
      code:
        | "CONNECTION_NOT_FOUND"
        | "CONNECTION_INACTIVE"
        | "UNSUPPORTED_PROVIDER"
        | "MANAGER_BOT_TARGET_REJECTED"
        | "CREDENTIALS_UNAVAILABLE"
        | "BOT_IDENTITY_VERIFICATION_FAILED"
        | "BOT_IDENTITY_MISMATCH"
        | "WEBHOOK_INFO_FAILED"
        | "MISSING_WEBHOOK_URL"
        | "WEBHOOK_URL_MISMATCH"
        | "INVALID_CUSTOMER_WEBHOOK_PATH"
        | "MALFORMED_WEBHOOK_URL"
        | "SET_WEBHOOK_FAILED"
        | "DATABASE_UPDATE_FAILED"
        | "CONCURRENT_MODIFICATION_CONFLICT"
        | "INVALID_REPAIR_PARAMETERS";
      message: string;
    };

/** Normalize URL for exact string comparison (stripping trailing slashes). */
export function normalizeWebhookUrl(urlStr: string): string {
  try {
    const u = new URL(urlStr);
    const pathname = u.pathname.replace(/\/+$/, "");
    return `${u.protocol}//${u.host}${pathname}`;
  } catch {
    return urlStr.trim().replace(/\/+$/, "");
  }
}

/** Resolve the expected customer webhook URL from params, deps, or environment. */
export function resolveExpectedCustomerWebhookUrl(
  params: RepairTelegramWebhookParams,
  deps: RepairTelegramWebhookDeps,
): string | null {
  if (params.expectedWebhookUrl?.trim()) {
    return normalizeWebhookUrl(params.expectedWebhookUrl.trim());
  }
  if (deps.expectedWebhookUrl?.trim()) {
    return normalizeWebhookUrl(deps.expectedWebhookUrl.trim());
  }
  const envBase =
    deps.getEnvVar?.("NEXT_PUBLIC_APP_URL") ??
    deps.getEnvVar?.("APP_URL") ??
    (typeof process !== "undefined"
      ? process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL
      : undefined);
  if (envBase?.trim()) {
    return normalizeWebhookUrl(buildCustomerWebhookUrl(envBase.trim()));
  }
  return null;
}

/**
 * Targeted repair service for existing connected customer Telegram bots.
 * Default mode is read-only inspection (check mode).
 * Apply mode performs a controlled update:
 * 1. Resolves and validates connection within business.
 * 2. Confirms active CONNECTED status and customer provider.
 * 3. Rejects manager bot targets.
 * 4. Confirms bot identity via `getMe`.
 * 5. Reads registered webhook info via `getWebhookInfo`.
 * 6. Validates registered webhook URL against expected customer endpoint.
 * 7. If subscribing to message & callback_query and not reconciling:
 *    -> idempotent no-op reporting subscription correctness (does not claim auth proof).
 * 8. If callback_query missing (or if --reconcile-secret is requested):
 *    In check mode -> returns structured inspection showing needed repair.
 *    In apply mode -> executes controlled secret rotation with `setWebhook`,
 *    bounded DB persistence retries with tenant/concurrency guards, and
 *    explicit partial-failure recovery when DB write cannot be confirmed.
 */
export async function repairTelegramBotWebhook(
  deps: RepairTelegramWebhookDeps,
  params: RepairTelegramWebhookParams,
): Promise<RepairTelegramWebhookOutcome> {
  const isApply = Boolean(params.apply);

  if (params.reconcileSecret && !isApply) {
    return {
      ok: false,
      code: "INVALID_REPAIR_PARAMETERS",
      message: "المصالحة تتطلب تشغيل الأمر مع خيار التطبيق --apply",
    };
  }

  // 1. Resolve the connection within its business
  const connection = await deps.connectionRepository.findByIdWithinBusiness(
    params.connectionId,
    params.businessId,
  );
  if (!connection) {
    return {
      ok: false,
      code: "CONNECTION_NOT_FOUND",
      message: "اتصال تيليجرام غير موجود ضمن هذه المنشأة",
    };
  }

  // 2. Operational state & provider validation
  if (connection.status !== "CONNECTED" || !connection.isActive) {
    return {
      ok: false,
      code: "CONNECTION_INACTIVE",
      message: "اتصال تيليجرام غير نشط أو مفصول، لا يمكن تطبيق الإصلاح عليه",
    };
  }

  if (connection.provider !== "telegram_managed") {
    return {
      ok: false,
      code: "UNSUPPORTED_PROVIDER",
      message: "مزود الاتصال غير مدعوم للإصلاح التلقائي",
    };
  }

  // 3. Manager bot rejection: customer connection cannot be the manager bot
  if (
    connection.managerBotId &&
    connection.botExternalId === connection.managerBotId
  ) {
    return {
      ok: false,
      code: "MANAGER_BOT_TARGET_REJECTED",
      message: "لا يمكن تطبيق إصلاح بوت العملاء على بوت إدارة المنصة",
    };
  }

  // 4. Resolve credentials safely (token never leaves adapter)
  const tokenRes = await resolveTelegramBotToken(
    { credentialsResolver: deps.credentialsResolver },
    connection.credentialsRef,
  );
  if (!tokenRes.ok) {
    return {
      ok: false,
      code: "CREDENTIALS_UNAVAILABLE",
      message: tokenRes.error.message,
    };
  }
  const botToken = tokenRes.token;

  // 5. Verify bot identity before any modification
  const meRes = await telegramGetMe(deps.api, botToken);
  if (!meRes.ok) {
    return {
      ok: false,
      code: "BOT_IDENTITY_VERIFICATION_FAILED",
      message: meRes.error.message,
    };
  }
  if (String(meRes.result.id) !== connection.botExternalId) {
    return {
      ok: false,
      code: "BOT_IDENTITY_MISMATCH",
      message: "معرف البوت من تيليجرام لا يطابق معرف الاتصال المسجل",
    };
  }
  if (meRes.result.can_manage_bots === true) {
    return {
      ok: false,
      code: "MANAGER_BOT_TARGET_REJECTED",
      message: "لا يمكن تطبيق إصلاح بوت العملاء على بوت إدارة المنصة",
    };
  }

  // 6. Read getWebhookInfo
  const infoRes = await telegramGetWebhookInfo(deps.api, botToken);
  if (!infoRes.ok) {
    return {
      ok: false,
      code: "WEBHOOK_INFO_FAILED",
      message: infoRes.error.message,
    };
  }
  const info = infoRes.result;
  if (!info.url || info.url.trim().length === 0) {
    return {
      ok: false,
      code: "MISSING_WEBHOOK_URL",
      message: "لا يوجد رابط ويبهوك مسجل للبوت لدى تيليجرام",
    };
  }
  if (info.url.includes("/api/telegram/manager/webhook")) {
    return {
      ok: false,
      code: "MANAGER_BOT_TARGET_REJECTED",
      message: "رابط الويبهوك المسجل يشير إلى نقطة المدير وليس بوت العملاء",
    };
  }

  let parsedActualUrl: URL;
  try {
    parsedActualUrl = new URL(info.url);
  } catch {
    return {
      ok: false,
      code: "MALFORMED_WEBHOOK_URL",
      message: "رابط الويبهوك المسجل في تيليجرام غير صالح",
    };
  }

  if (
    parsedActualUrl.pathname.replace(/\/+$/, "") !== "/api/telegram/webhook"
  ) {
    return {
      ok: false,
      code: "INVALID_CUSTOMER_WEBHOOK_PATH",
      message:
        "مسار الويبهوك المسجل في تيليجرام لا ينتهي بـ /api/telegram/webhook",
    };
  }

  const expectedCustomerUrl = resolveExpectedCustomerWebhookUrl(params, deps);
  if (expectedCustomerUrl) {
    const actualNorm = normalizeWebhookUrl(info.url);
    if (actualNorm !== expectedCustomerUrl) {
      return {
        ok: false,
        code: "WEBHOOK_URL_MISMATCH",
        message: `رابط الويبهوك المسجل لدى تيليجرام (${info.url}) لا يطابق الرابط المتوقع لبوت العملاء (${expectedCustomerUrl}). لا يجوز تغيير الرابط بصمت أثناء إصلاح الاشتراكات.`,
      };
    }
  }

  const currentUpdates = info.allowed_updates ?? [];
  const hasMessage = currentUpdates.includes("message");
  const hasCallbackQuery = currentUpdates.includes("callback_query");
  const subscriptionOk = hasMessage && hasCallbackQuery;

  // 7. Check idempotency: already correct subscription is a no-op unless reconcileSecret is explicitly requested
  if (subscriptionOk && !params.reconcileSecret) {
    return {
      ok: true,
      status: "ALREADY_CORRECT",
      checkOnly: !isApply,
      botExternalId: connection.botExternalId,
      botUsername: connection.botUsername,
      webhookUrl: info.url,
      allowedUpdates: currentUpdates,
      pendingUpdateCount: info.pending_update_count,
      lastErrorMessage: info.last_error_message,
      note: "اشتراك تيليجرام يحوي message و callback_query. ملاحظة: getWebhookInfo لا يكشف سر الويبهوك النشط؛ للتحقق من المصادقة أو معالجة 401، استخدم --apply --reconcile-secret",
    };
  }

  // Build target allowed_updates without dropping existing types
  const targetUpdates = Array.from(
    new Set([...currentUpdates, ...TELEGRAM_CUSTOMER_ALLOWED_UPDATES]),
  );

  // 8. Check mode: report needed repair without mutating
  if (!isApply) {
    return {
      ok: true,
      status: "REPAIR_REQUIRED",
      checkOnly: true,
      botExternalId: connection.botExternalId,
      botUsername: connection.botUsername,
      webhookUrl: info.url,
      currentAllowedUpdates: currentUpdates,
      targetAllowedUpdates: targetUpdates,
      pendingUpdateCount: info.pending_update_count,
      lastErrorMessage: info.last_error_message,
      note: "ينقص اشتراك callback_query. أعد التشغيل مع --apply لتحديث التسجيل وتدوير السر بأمان.",
    };
  }

  // 9. Apply mode: controlled secret rotation path
  const secretGen = deps.generateWebhookSecret ?? generateWebhookSecret;
  const secretHasher = deps.hashWebhookSecret ?? hashTelegramWebhookSecret;
  const candidateSecret = secretGen();
  const candidateHash = secretHasher(candidateSecret);

  // 9A. Update Telegram webhook: preserve verified URL, set candidateSecret, add callback_query
  // drop_pending_updates is never enabled.
  const setRes = await telegramSetWebhook(deps.api, botToken, {
    url: info.url,
    secretToken: candidateSecret,
    allowedUpdates: targetUpdates,
  });

  if (!setRes.ok) {
    return {
      ok: false,
      code: "SET_WEBHOOK_FAILED",
      message: setRes.error.message,
    };
  }

  // 9B. Bounded database persistence retries with tenant & concurrency guards.
  // Note: Telegram HTTP and DB write are separate operations; cross-system atomicity does not exist.
  const MAX_DB_ATTEMPTS = 3;
  let persisted = false;

  for (let attempt = 1; attempt <= MAX_DB_ATTEMPTS; attempt++) {
    try {
      let updated: TelegramConnection | null = null;
      if (deps.connectionRepository.updateWebhookSecretHash) {
        updated = await deps.connectionRepository.updateWebhookSecretHash(
          connection.id,
          connection.businessId,
          candidateHash,
          { expectedPreviousHash: connection.webhookSecretHash },
        );
      } else {
        const currentCheck =
          await deps.connectionRepository.findByIdWithinBusiness(
            connection.id,
            connection.businessId,
          );
        if (
          !currentCheck ||
          currentCheck.status !== "CONNECTED" ||
          !currentCheck.isActive ||
          (currentCheck.webhookSecretHash !== connection.webhookSecretHash &&
            currentCheck.webhookSecretHash !== candidateHash)
        ) {
          // Row was disconnected or concurrently modified
          break;
        }
        updated = await deps.connectionRepository.update(
          connection.id,
          connection.businessId,
          { webhookSecretHash: candidateHash },
        );
      }

      if (updated && updated.webhookSecretHash === candidateHash) {
        persisted = true;
        break;
      }
    } catch {
      // transient database error; fall through to read-back verification
    }

    // Read back to verify whether the write actually committed despite an error/null response
    try {
      const readBack = await deps.connectionRepository.findByIdWithinBusiness(
        connection.id,
        connection.businessId,
      );
      if (readBack?.webhookSecretHash === candidateHash) {
        persisted = true;
        break;
      }
      if (readBack && (readBack.status !== "CONNECTED" || !readBack.isActive)) {
        // Concurrently disconnected
        break;
      }
    } catch {
      // ignore read-back error during retry
    }

    if (attempt < MAX_DB_ATTEMPTS && deps.sleepImpl) {
      await deps.sleepImpl(50 * attempt);
    }
  }

  const reconciliationCmd = `pnpm telegram:repair-webhook --business-id ${connection.businessId} --connection-id ${connection.id} --apply --reconcile-secret --expected-url ${info.url}`;

  if (!persisted) {
    return {
      ok: false,
      code: "PARTIAL_APPLICATION_RECOVERY_REQUIRED",
      status: "PARTIAL_FAILURE",
      botExternalId: connection.botExternalId,
      botUsername: connection.botUsername,
      webhookUrl: info.url,
      targetAllowedUpdates: targetUpdates,
      pendingUpdateCount: info.pending_update_count,
      reconciliationCommand: reconciliationCmd,
      message:
        "تم تحديث اشتراك تيليجرام بنجاح ولكن تعذر تأكيد حفظ ملخص سر الويبهوك في قاعدة البيانات. قد تُرفض طلبات الويبهوك برمز 401 حتى تتم المصالحة.",
    };
  }

  // 9C. Post-application verification: confirm intended digest is stored
  const finalRow = await deps.connectionRepository.findByIdWithinBusiness(
    connection.id,
    connection.businessId,
  );
  const hashPersisted = finalRow?.webhookSecretHash === candidateHash;

  return {
    ok: true,
    status:
      params.reconcileSecret && subscriptionOk
        ? "SECRET_RECONCILED"
        : "REPAIRED",
    checkOnly: false,
    botExternalId: connection.botExternalId,
    botUsername: connection.botUsername,
    webhookUrl: info.url,
    allowedUpdates: targetUpdates,
    previousAllowedUpdates: currentUpdates,
    pendingUpdateCount: info.pending_update_count,
    secretReconciled: Boolean(params.reconcileSecret),
    webhookSecretHashPersisted: hashPersisted,
  };
}

/** Default production boundary wiring */
export async function repairTelegramBotWebhookDefault(
  params: RepairTelegramWebhookParams,
): Promise<RepairTelegramWebhookOutcome> {
  const { telegramConnectionRepository } =
    await import("@/server/repositories");
  return repairTelegramBotWebhook(
    {
      api: defaultTelegramApiDeps,
      connectionRepository: telegramConnectionRepository,
      credentialsResolver: defaultCredentialsResolver,
      generateWebhookSecret,
      hashWebhookSecret: hashTelegramWebhookSecret,
    },
    params,
  );
}
