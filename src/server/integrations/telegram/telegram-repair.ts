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
import {
  telegramConnectionRepository,
  type TelegramConnectionRepository,
} from "@/server/repositories";

export type RepairTelegramWebhookParams = {
  businessId: string;
  connectionId: string;
  apply?: boolean;
};

export type RepairTelegramWebhookDeps = {
  api: TelegramApiDeps;
  connectionRepository: Pick<
    TelegramConnectionRepository,
    "findByIdWithinBusiness" | "update"
  >;
  credentialsResolver: Pick<CredentialsResolver, "resolve">;
  generateWebhookSecret?: () => string;
  hashWebhookSecret?: (secret: string) => string;
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
    }
  | {
      ok: true;
      status: "REPAIRED";
      checkOnly: false;
      botExternalId: string;
      botUsername?: string | null;
      webhookUrl: string;
      allowedUpdates: string[];
      previousAllowedUpdates: string[];
      pendingUpdateCount: number;
    }
  | {
      ok: false;
      code:
        | "CONNECTION_NOT_FOUND"
        | "UNSUPPORTED_PROVIDER"
        | "MANAGER_BOT_TARGET_REJECTED"
        | "CREDENTIALS_UNAVAILABLE"
        | "BOT_IDENTITY_VERIFICATION_FAILED"
        | "BOT_IDENTITY_MISMATCH"
        | "WEBHOOK_INFO_FAILED"
        | "MISSING_WEBHOOK_URL"
        | "SET_WEBHOOK_FAILED"
        | "DATABASE_UPDATE_FAILED";
      message: string;
    };

/**
 * Targeted repair service for existing connected customer Telegram bots.
 * Default mode is read-only inspection (check mode).
 * Apply mode performs a controlled update:
 * 1. Resolves and validates connection within business.
 * 2. Confirms bot identity via `getMe`.
 * 3. Rejects manager bot targets.
 * 4. Reads registered webhook info via `getWebhookInfo`.
 * 5. If already subscribing to message & callback_query -> idempotent no-op.
 * 6. If callback_query missing:
 *    In check mode -> returns structured inspection showing needed repair.
 *    In apply mode -> executes controlled secret rotation with `setWebhook`
 *    and atomic database digest update, preserving webhook URL and avoiding
 *    drop_pending_updates.
 */
export async function repairTelegramBotWebhook(
  deps: RepairTelegramWebhookDeps,
  params: RepairTelegramWebhookParams,
): Promise<RepairTelegramWebhookOutcome> {
  const isApply = Boolean(params.apply);

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

  // 2. Provider validation
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

  const currentUpdates = info.allowed_updates ?? [];
  const hasMessage = currentUpdates.includes("message");
  const hasCallbackQuery = currentUpdates.includes("callback_query");

  // 7. Check idempotency: already correct registration is a no-op
  if (hasMessage && hasCallbackQuery) {
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
    };
  }

  // 9. Apply mode: controlled secret rotation path
  const secretGen = deps.generateWebhookSecret ?? generateWebhookSecret;
  const secretHasher = deps.hashWebhookSecret ?? hashTelegramWebhookSecret;
  const newSecret = secretGen();
  const newSecretHash = secretHasher(newSecret);

  // Update Telegram webhook: preserve existing URL, use fresh secret, add callback_query
  // drop_pending_updates is NOT set (remains false)
  const setRes = await telegramSetWebhook(deps.api, botToken, {
    url: info.url,
    secretToken: newSecret,
    allowedUpdates: targetUpdates,
  });

  if (!setRes.ok) {
    return {
      ok: false,
      code: "SET_WEBHOOK_FAILED",
      message: setRes.error.message,
    };
  }

  // Atomically update database digest
  const updateRes = await deps.connectionRepository.update(
    connection.id,
    connection.businessId,
    { webhookSecretHash: newSecretHash },
  );

  if (!updateRes) {
    return {
      ok: false,
      code: "DATABASE_UPDATE_FAILED",
      message:
        "تم تحديث تسجيل تيليجرام ولكن تعذر تحديث ملخص سر الويبهوك في قاعدة البيانات",
    };
  }

  return {
    ok: true,
    status: "REPAIRED",
    checkOnly: false,
    botExternalId: connection.botExternalId,
    botUsername: connection.botUsername,
    webhookUrl: info.url,
    allowedUpdates: targetUpdates,
    previousAllowedUpdates: currentUpdates,
    pendingUpdateCount: info.pending_update_count,
  };
}

/** Default production boundary wiring */
export async function repairTelegramBotWebhookDefault(
  params: RepairTelegramWebhookParams,
): Promise<RepairTelegramWebhookOutcome> {
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
