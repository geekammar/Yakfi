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
import { generateWebhookSecret } from "@/server/integrations/telegram/telegram-provisioning";
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
      webhookSecretHashPersisted: true;
      verifiedAt: string;
    }
  | {
      ok: false;
      code:
        | "PARTIAL_APPLICATION_RECOVERY_REQUIRED"
        | "SET_WEBHOOK_UNCERTAIN_RECOVERY_REQUIRED"
        | "POST_APPLY_VERIFICATION_FAILED"
        | "POST_APPLY_INSPECTION_FAILED"
        | "POST_APPLY_REGISTRATION_MISMATCH"
        | "CONCURRENT_MODIFICATION_CONFLICT"
        | "POST_APPLY_CONNECTION_NOT_FOUND"
        | "POST_APPLY_CONNECTION_INACTIVE";
      status: "PARTIAL_FAILURE";
      botExternalId: string;
      botUsername?: string | null;
      webhookUrl: string;
      targetAllowedUpdates: string[];
      pendingUpdateCount: number;
      reconciliationCommand: string;
      remoteStateMayHaveChanged?: boolean;
      message: string;
    }
  | {
      ok: false;
      status?: "REFUSED";
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
        | "EXPECTED_WEBHOOK_URL_REQUIRED"
        | "INVALID_EXPECTED_WEBHOOK_URL"
        | "WEBHOOK_URL_MISMATCH"
        | "INVALID_CUSTOMER_WEBHOOK_PATH"
        | "NON_HTTPS_WEBHOOK_URL"
        | "UNSUPPORTED_WEBHOOK_URL_COMPONENTS"
        | "MALFORMED_WEBHOOK_URL"
        | "SET_WEBHOOK_FAILED"
        | "DATABASE_UPDATE_FAILED"
        | "INVALID_REPAIR_PARAMETERS";
      message: string;
      reconciliationCommand?: string;
    };

/**
 * Validates and normalizes an HTTPS customer webhook URL.
 * Rejects unsupported components (query parameters, hash fragments, non-HTTPS protocols).
 */
export function validateCustomerWebhookUrl(
  rawUrl: string,
  label = "رابط الويبهوك",
):
  | { ok: true; normalizedUrl: string }
  | {
      ok: false;
      code:
        | "MALFORMED_WEBHOOK_URL"
        | "NON_HTTPS_WEBHOOK_URL"
        | "UNSUPPORTED_WEBHOOK_URL_COMPONENTS"
        | "INVALID_CUSTOMER_WEBHOOK_PATH";
      message: string;
    } {
  if (!rawUrl || rawUrl.trim().length === 0) {
    return {
      ok: false,
      code: "MALFORMED_WEBHOOK_URL",
      message: `${label} فارغ`,
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return {
      ok: false,
      code: "MALFORMED_WEBHOOK_URL",
      message: `${label} غير صالح من حيث البنية`,
    };
  }
  if (parsed.protocol !== "https:") {
    return {
      ok: false,
      code: "NON_HTTPS_WEBHOOK_URL",
      message: `${label} (${rawUrl}) يجب أن يبدأ بـ https://`,
    };
  }
  if (parsed.search || parsed.hash) {
    return {
      ok: false,
      code: "UNSUPPORTED_WEBHOOK_URL_COMPONENTS",
      message: `${label} (${rawUrl}) لا يجوز أن يحتوي على معلمات استعلام (query) أو أجزاء (fragment)`,
    };
  }
  const cleanPath = parsed.pathname.replace(/\/+$/, "");
  if (cleanPath !== "/api/telegram/webhook") {
    return {
      ok: false,
      code: "INVALID_CUSTOMER_WEBHOOK_PATH",
      message: `${label} (${rawUrl}) يجب أن ينتهي بالمسار /api/telegram/webhook`,
    };
  }
  return {
    ok: true,
    normalizedUrl: `https://${parsed.host}${cleanPath}`,
  };
}

/** Resolves raw expected customer webhook URL from params, deps, or environment. */
export function resolveExpectedCustomerWebhookUrl(
  params: RepairTelegramWebhookParams,
  deps: RepairTelegramWebhookDeps,
): string | null {
  const raw =
    params.expectedWebhookUrl?.trim() ||
    deps.expectedWebhookUrl?.trim() ||
    (deps.getEnvVar
      ? (deps.getEnvVar("NEXT_PUBLIC_APP_URL") ?? deps.getEnvVar("APP_URL"))
      : typeof process !== "undefined"
        ? process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL
        : undefined
    )?.trim();

  if (!raw) return null;

  const clean = raw.replace(/\/+$/, "");
  if (clean.endsWith("/api/telegram/webhook")) {
    return clean;
  }

  try {
    const u = new URL(clean);
    if (!u.pathname || u.pathname === "" || u.pathname === "/") {
      u.pathname = "/api/telegram/webhook";
      return u.toString().replace(/\/+$/, "");
    }
  } catch {
    // invalid URL format handled by validateCustomerWebhookUrl
  }

  return clean;
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
 * 6. Validates registered webhook URL against trusted expected HTTPS customer endpoint.
 * 7. If subscribing to message & callback_query and not reconciling:
 *    -> idempotent no-op reporting subscription correctness (does not claim auth proof).
 * 8. If callback_query missing (or if --reconcile-secret is requested):
 *    In check mode -> returns structured inspection showing needed repair.
 *    In apply mode -> executes controlled secret rotation with `setWebhook`,
 *    handles ambiguous transport outcomes with reconciliation guidance,
 *    executes bounded DB persistence retries with tenant/concurrency guards,
 *    and independently verifies both the database digest and live Telegram registration
 *    before returning success.
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

  // 7. Require trusted expected HTTPS customer webhook destination
  const rawExpectedUrl = resolveExpectedCustomerWebhookUrl(params, deps);
  if (!rawExpectedUrl) {
    return {
      ok: false,
      code: "EXPECTED_WEBHOOK_URL_REQUIRED",
      message:
        "لم يتم تحديد رابط الويبهوك المتوقع لبوت العملاء. يُرجى تمرير --expected-url أو ضبط متغير البيئة NEXT_PUBLIC_APP_URL/APP_URL.",
    };
  }
  const expectedCheck = validateCustomerWebhookUrl(
    rawExpectedUrl,
    "الرابط المتوقع لبوت العملاء",
  );
  if (!expectedCheck.ok) {
    return expectedCheck;
  }
  const expectedCustomerUrl = expectedCheck.normalizedUrl;

  const actualCheck = validateCustomerWebhookUrl(
    info.url,
    "رابط الويبهوك المسجل لدى تيليجرام",
  );
  if (!actualCheck.ok) {
    return actualCheck;
  }
  if (actualCheck.normalizedUrl !== expectedCustomerUrl) {
    return {
      ok: false,
      code: "WEBHOOK_URL_MISMATCH",
      message: `رابط الويبهوك المسجل لدى تيليجرام (${info.url}) لا يطابق الرابط المتوقع لبوت العملاء (${expectedCustomerUrl}). لا يجوز تغيير الرابط بصمت أثناء إصلاح الاشتراكات.`,
    };
  }

  const currentUpdates = info.allowed_updates ?? [];
  const hasMessage = currentUpdates.includes("message");
  const hasCallbackQuery = currentUpdates.includes("callback_query");
  const subscriptionOk = hasMessage && hasCallbackQuery;

  // 8. Check idempotency: already correct subscription is a no-op unless reconcileSecret is explicitly requested
  if (subscriptionOk && !params.reconcileSecret) {
    return {
      ok: true,
      status: "ALREADY_CORRECT",
      checkOnly: !isApply,
      botExternalId: connection.botExternalId,
      botUsername: connection.botUsername,
      webhookUrl: expectedCustomerUrl,
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

  // 9. Check mode: report needed repair without mutating
  if (!isApply) {
    return {
      ok: true,
      status: "REPAIR_REQUIRED",
      checkOnly: true,
      botExternalId: connection.botExternalId,
      botUsername: connection.botUsername,
      webhookUrl: expectedCustomerUrl,
      currentAllowedUpdates: currentUpdates,
      targetAllowedUpdates: targetUpdates,
      pendingUpdateCount: info.pending_update_count,
      lastErrorMessage: info.last_error_message,
      note: "ينقص اشتراك callback_query. أعد التشغيل مع --apply لتحديث التسجيل وتدوير السر بأمان.",
    };
  }

  // 10. Apply mode: controlled secret rotation path
  const secretGen = deps.generateWebhookSecret ?? generateWebhookSecret;
  const secretHasher = deps.hashWebhookSecret ?? hashTelegramWebhookSecret;
  const candidateSecret = secretGen();
  const candidateHash = secretHasher(candidateSecret);
  const targetAllowedUpdates = [...targetUpdates];
  const reconciliationCmd = `pnpm telegram:repair-webhook --business-id ${connection.businessId} --connection-id ${connection.id} --apply --reconcile-secret --expected-url ${expectedCustomerUrl}`;

  // 10A. Update Telegram webhook: preserve verified expected URL, set candidateSecret, add callback_query
  // drop_pending_updates is never enabled.
  const setRes = await telegramSetWebhook(deps.api, botToken, {
    url: expectedCustomerUrl,
    secretToken: candidateSecret,
    allowedUpdates: targetUpdates,
  });

  if (!setRes.ok) {
    const isTransportUncertainty =
      setRes.error.code === "TRANSIENT_TRANSPORT_FAILURE" ||
      setRes.error.code === "MALFORMED_PROVIDER_PAYLOAD";

    if (isTransportUncertainty) {
      return {
        ok: false,
        code: "SET_WEBHOOK_UNCERTAIN_RECOVERY_REQUIRED",
        status: "PARTIAL_FAILURE",
        botExternalId: connection.botExternalId,
        botUsername: connection.botUsername,
        webhookUrl: expectedCustomerUrl,
        targetAllowedUpdates,
        pendingUpdateCount: info.pending_update_count,
        reconciliationCommand: reconciliationCmd,
        remoteStateMayHaveChanged: true,
        message: `تعذر التأكد من استجابة تيليجرام عند تحديث الويبهوك (${setRes.error.message}). قد يكون تيليجرام طبق التغيير جزئياً دون تأكيد؛ يُرجى تشغيل أمر المصالحة.`,
      };
    }

    return {
      ok: false,
      code: "SET_WEBHOOK_FAILED",
      message: setRes.error.message,
      reconciliationCommand: reconciliationCmd,
    };
  }

  // 10B. Bounded database persistence retries with tenant & concurrency guards.
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

  if (!persisted) {
    return {
      ok: false,
      code: "PARTIAL_APPLICATION_RECOVERY_REQUIRED",
      status: "PARTIAL_FAILURE",
      botExternalId: connection.botExternalId,
      botUsername: connection.botUsername,
      webhookUrl: expectedCustomerUrl,
      targetAllowedUpdates,
      pendingUpdateCount: info.pending_update_count,
      reconciliationCommand: reconciliationCmd,
      message:
        "تم تحديث اشتراك تيليجرام بنجاح ولكن تعذر تأكيد حفظ ملخص سر الويبهوك في قاعدة البيانات. قد تُرفض طلبات الويبهوك برمز 401 حتى تتم المصالحة.",
    };
  }

  // 10C. Final database verification: must confirm candidate digest and active connection
  let finalRow: TelegramConnection | null = null;
  try {
    finalRow = await deps.connectionRepository.findByIdWithinBusiness(
      connection.id,
      connection.businessId,
    );
  } catch {
    return {
      ok: false,
      code: "POST_APPLY_VERIFICATION_FAILED",
      status: "PARTIAL_FAILURE",
      botExternalId: connection.botExternalId,
      botUsername: connection.botUsername,
      webhookUrl: expectedCustomerUrl,
      targetAllowedUpdates,
      pendingUpdateCount: info.pending_update_count,
      reconciliationCommand: reconciliationCmd,
      message:
        "حدث خطأ أثناء القراءة النهائية للتحقق من حفظ سر الويبهوك في قاعدة البيانات. يُرجى تشغيل أمر المصالحة.",
    };
  }

  if (!finalRow) {
    return {
      ok: false,
      code: "POST_APPLY_CONNECTION_NOT_FOUND",
      status: "PARTIAL_FAILURE",
      botExternalId: connection.botExternalId,
      botUsername: connection.botUsername,
      webhookUrl: expectedCustomerUrl,
      targetAllowedUpdates,
      pendingUpdateCount: info.pending_update_count,
      reconciliationCommand: reconciliationCmd,
      message:
        "لم يتم العثور على اتصال تيليجرام أثناء التحقق النهائي بعد تطبيق التحديث.",
    };
  }

  if (finalRow.status !== "CONNECTED" || !finalRow.isActive) {
    return {
      ok: false,
      code: "POST_APPLY_CONNECTION_INACTIVE",
      status: "PARTIAL_FAILURE",
      botExternalId: connection.botExternalId,
      botUsername: connection.botUsername,
      webhookUrl: expectedCustomerUrl,
      targetAllowedUpdates,
      pendingUpdateCount: info.pending_update_count,
      reconciliationCommand: reconciliationCmd,
      message: "تم فصل اتصال تيليجرام أثناء أو بعد تطبيق التحديث.",
    };
  }

  if (finalRow.webhookSecretHash !== candidateHash) {
    return {
      ok: false,
      code: "CONCURRENT_MODIFICATION_CONFLICT",
      status: "PARTIAL_FAILURE",
      botExternalId: connection.botExternalId,
      botUsername: connection.botUsername,
      webhookUrl: expectedCustomerUrl,
      targetAllowedUpdates,
      pendingUpdateCount: info.pending_update_count,
      reconciliationCommand: reconciliationCmd,
      message:
        "ملخص سر الويبهوك النهائي في قاعدة البيانات لا يطابق السر المطبق لدى تيليجرام (ربما حدث تعديل متزامن). يُرجى تشغيل أمر المصالحة.",
    };
  }

  // 10D. Post-application Telegram registration inspection
  const postInfoRes = await telegramGetWebhookInfo(deps.api, botToken);
  if (!postInfoRes.ok) {
    return {
      ok: false,
      code: "POST_APPLY_INSPECTION_FAILED",
      status: "PARTIAL_FAILURE",
      botExternalId: connection.botExternalId,
      botUsername: connection.botUsername,
      webhookUrl: expectedCustomerUrl,
      targetAllowedUpdates,
      pendingUpdateCount: info.pending_update_count,
      reconciliationCommand: reconciliationCmd,
      message: `تعذر قراءة تسجيل تيليجرام بعد التطبيق للتحقق من التحديث (${postInfoRes.error.message}).`,
    };
  }

  const postInfo = postInfoRes.result;
  const postActualValidation = validateCustomerWebhookUrl(
    postInfo.url,
    "رابط الويبهوك المسجل في تيليجرام بعد التطبيق",
  );
  if (
    !postActualValidation.ok ||
    postActualValidation.normalizedUrl !== expectedCustomerUrl
  ) {
    return {
      ok: false,
      code: "POST_APPLY_REGISTRATION_MISMATCH",
      status: "PARTIAL_FAILURE",
      botExternalId: connection.botExternalId,
      botUsername: connection.botUsername,
      webhookUrl: postInfo.url,
      targetAllowedUpdates,
      pendingUpdateCount: postInfo.pending_update_count,
      reconciliationCommand: reconciliationCmd,
      message: `رابط الويبهوك المسجل في تيليجرام بعد التطبيق (${postInfo.url}) لا يطابق الرابط المتوقع (${expectedCustomerUrl}).`,
    };
  }

  const postUpdates = postInfo.allowed_updates ?? [];
  const postHasMessage = postUpdates.includes("message");
  const postHasCallbackQuery = postUpdates.includes("callback_query");
  if (!postHasMessage || !postHasCallbackQuery) {
    return {
      ok: false,
      code: "POST_APPLY_REGISTRATION_MISMATCH",
      status: "PARTIAL_FAILURE",
      botExternalId: connection.botExternalId,
      botUsername: connection.botUsername,
      webhookUrl: postInfo.url,
      targetAllowedUpdates,
      pendingUpdateCount: postInfo.pending_update_count,
      reconciliationCommand: reconciliationCmd,
      message: `تسجيل تيليجرام بعد التطبيق لا يتضمن أنواع التحديثات المطلوبة (${JSON.stringify(postUpdates)}).`,
    };
  }

  return {
    ok: true,
    status:
      params.reconcileSecret && subscriptionOk
        ? "SECRET_RECONCILED"
        : "REPAIRED",
    checkOnly: false,
    botExternalId: connection.botExternalId,
    botUsername: connection.botUsername,
    webhookUrl: postInfo.url,
    allowedUpdates: postUpdates,
    previousAllowedUpdates: currentUpdates,
    pendingUpdateCount: postInfo.pending_update_count,
    secretReconciled: Boolean(params.reconcileSecret),
    webhookSecretHashPersisted: true,
    verifiedAt: new Date().toISOString(),
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
