import {
  defaultConversationEngineDeps,
  receiveInboundMessage,
} from "@/features/conversations/server/conversation-engine";
import { defaultRuntimeCredentialStore } from "@/server/credentials/runtime-credential-store";
import {
  defaultTelegramApiDeps,
  resolveTelegramBotToken,
  telegramAnswerCallbackQuery,
  type TelegramApiDeps,
} from "@/server/integrations/telegram/telegram-client";
import {
  completeManagedBotProvisioning,
  type TelegramProvisioningDeps,
} from "@/server/integrations/telegram/telegram-provisioning";
import {
  createTelegramMessageTransport,
  resolveTelegramConnectionForSend,
} from "@/server/integrations/telegram/telegram-transport";
import {
  createSafeTelegramWebhookLogger,
  handleTelegramWebhook,
  mapEngineResultToTelegramOutcome,
  sanitizeErrorCode,
  type TelegramWebhookHandlerDeps,
  type TelegramWebhookLogger,
} from "@/server/integrations/telegram/telegram-webhook-handler";
import {
  telegramConnectionRepository,
  telegramProvisioningLedgerRepository,
  type TelegramConnectionRepository,
} from "@/server/repositories";

import { revalidatePath } from "next/cache";
import { after } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Telegram webhook (DECISIONS #63 (E)/#64 — slice TELEGRAM 02; the
 * `managed_bot` completion is wired by TELEGRAM 03, DECISIONS #66).
 *
 * The route is the thin composition point only: it wires the production
 * singletons (the connection repository, the Telegram-backed
 * `MessageTransport`, the provisioning boundary, Next 16 `after`) and
 * delegates the whole POST logic to `handleTelegramWebhook` in the
 * adapter — so the security path is assertable offline with injected
 * dependencies and no route logic is duplicated in tests.
 */
export const telegramTransport = createTelegramMessageTransport();

export const telegramEngineDeps = {
  ...defaultConversationEngineDeps,
  transport: telegramTransport,
};

export const defaultTelegramWebhookLogger = createSafeTelegramWebhookLogger();

export const defaultProvisioningDeps: TelegramProvisioningDeps = {
  api: defaultTelegramApiDeps,
  ledgerRepository: telegramProvisioningLedgerRepository,
  connectionRepository: telegramConnectionRepository,
  credentialStore: defaultRuntimeCredentialStore,
  getEnvVar: (name: string) => process.env[name],
  webhookBaseUrl: process.env.NEXT_PUBLIC_APP_URL ?? "",
  now: () => new Date(),
};

export type ProductionTelegramWebhookConfig = {
  engineDeps?: typeof telegramEngineDeps;
  connectionRepository?: Pick<
    TelegramConnectionRepository,
    "findByWebhookSecretHash" | "findByIdWithinBusiness"
  >;
  telegramApiDeps?: TelegramApiDeps;
  provisioningDeps?: TelegramProvisioningDeps;
  logger?: TelegramWebhookLogger;
  now?: () => Date;
  schedule?: (work: () => Promise<void> | void) => void;
  revalidatePaths?: boolean;
};

export function createProductionTelegramWebhookDeps(
  config?: ProductionTelegramWebhookConfig,
): TelegramWebhookHandlerDeps {
  const connectionRepo =
    config?.connectionRepository ?? telegramConnectionRepository;
  const engineDeps = config?.engineDeps ?? telegramEngineDeps;
  const apiDeps = config?.telegramApiDeps ?? defaultTelegramApiDeps;
  const provDeps = config?.provisioningDeps ?? defaultProvisioningDeps;
  const logger = config?.logger ?? defaultTelegramWebhookLogger;
  const shouldRevalidate = config?.revalidatePaths ?? true;

  return {
    connectionRepository: connectionRepo,
    logger,
    now: config?.now,
    async processInboundMessage({ engineInput, identity }) {
      const result = await receiveInboundMessage(
        engineDeps,
        engineInput,
        identity,
      );
      if (shouldRevalidate) {
        try {
          revalidatePath("/conversations");
          revalidatePath("/");
          revalidatePath("/staff");
        } catch {
          // Revalidation is best-effort in background worker/offline tests
        }
      }
      return mapEngineResultToTelegramOutcome(result);
    },
    async completeManagedBotProvisioning({ event }) {
      try {
        const result = await completeManagedBotProvisioning(provDeps, event);
        if (result.ok) {
          if (shouldRevalidate) {
            try {
              revalidatePath("/settings/telegram");
              revalidatePath("/settings");
            } catch {
              // Best-effort
            }
          }
          return { ok: true };
        }
        return { ok: false, code: result.code };
      } catch {
        return { ok: false, code: "PROVISIONING_FAILED" };
      }
    },
    async answerCallbackQuery({ callbackQueryId, connectionId, businessId }) {
      try {
        const resolution = await resolveTelegramConnectionForSend(
          { connectionRepository: connectionRepo },
          { connectionId, businessId },
        );
        if (!resolution.ok) {
          return { ok: false, error: "CONNECTION_RESOLUTION_FAILED" };
        }
        const tokenRes = await resolveTelegramBotToken(
          apiDeps,
          resolution.credentialsRef,
        );
        if (!tokenRes.ok) {
          return { ok: false, error: "BOT_TOKEN_RESOLUTION_FAILED" };
        }
        const ackRes = await telegramAnswerCallbackQuery(
          apiDeps,
          tokenRes.token,
          { callbackQueryId },
        );
        if (!ackRes.ok) {
          const code = ackRes.error.code;
          return {
            ok: false,
            error: sanitizeErrorCode(code) ?? "TELEGRAM_ACK_FAILED",
          };
        }
        if (
          (ackRes.result as unknown) === false ||
          (typeof ackRes.result === "object" &&
            ackRes.result !== null &&
            (ackRes.result as { ok?: boolean }).ok === false)
        ) {
          return { ok: false, error: "TELEGRAM_ACK_FAILED" };
        }
        return { ok: true };
      } catch {
        return { ok: false, error: "ANSWER_CALLBACK_FAILED" };
      }
    },
    async sendStartWelcome({ chatId, businessId, connectionId, text }) {
      await engineDeps.transport.send({
        to: chatId,
        businessId,
        businessName: "",
        conversationId: "",
        content: text,
        connectionId,
        kind: "TEXT",
      });
    },
    schedule:
      config?.schedule ??
      ((work) => {
        after(() => work());
      }),
  };
}

export async function POST(request: Request): Promise<Response> {
  const deps = createProductionTelegramWebhookDeps();
  return handleTelegramWebhook(deps, request);
}
