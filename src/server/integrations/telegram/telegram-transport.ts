import {
  defaultCredentialsResolver,
  type CredentialsResolver,
} from "@/server/credentials/credentials-resolver";
import {
  resolveTelegramBotToken,
  telegramSendMessage,
  type TelegramApiDeps,
} from "@/server/integrations/telegram/telegram-client";
import { renderTelegramInlineKeyboard } from "@/server/integrations/telegram/telegram-presentation";
import type { TelegramConnectionRepository } from "@/server/repositories";
import { telegramConnectionRepository } from "@/server/repositories";
import type {
  MessageTransport,
  OutboundMessage,
  TransportError,
  TransportSendResult,
} from "@/server/transport/whatsapp-transport";

/**
 * Telegram outbound transport — the channel's `MessageTransport`
 * implementation (DECISIONS #63 (A): Telegram is a transport sibling).
 *
 * Boundary rules (mirror the Meta client's discipline):
 * - The engine hands a provider-neutral `OutboundMessage`; `to` is the
 *   customer's external handle (a private-chat Telegram chat id,
 *   DECISIONS #64) — it becomes the `sendMessage` `chat_id` here and only
 *   here. The engine never knows it is talking to Telegram.
 * - Tenancy is enforced BEFORE any credential read: the connection is
 *   resolved WITHIN the `OutboundMessage.businessId` (a connection of
 *   ANOTHER Business is "not found" — no cross-tenant existence leak),
 *   and only an active CONNECTED connection may send.
 * - The bot token is resolved from the connection's `credentialsRef`
 *   (`fp:<id>` RUNTIME handle) AFTER tenancy; the value never crosses a
 *   log, a result, or a domain payload.
 * - Telegram HTTP semantics (URL, error codes) stay in the client module.
 */

export type TelegramTransportDeps = {
  api: TelegramApiDeps;
  connectionRepository: Pick<
    TelegramConnectionRepository,
    "findByIdWithinBusiness"
  >;
  credentialsResolver: CredentialsResolver;
};

export type SendResolution =
  | {
      ok: true;
      connectionId: string;
      branchId: string | null;
      credentialsRef: string;
    }
  | { ok: false; code: TransportError["code"]; message: string };

/**
 * OUTBOUND tenancy: which Telegram connection may send for a Business.
 * Exactly parallel to the WhatsApp `resolveConnectionForSend` — the
 * connection id is resolved WITHIN the Business, so a foreign or unknown
 * connection is simply unusable, and only an active CONNECTED connection
 * sends. The credential REFERENCE is the only thing returned (never the
 * token).
 */
export async function resolveTelegramConnectionForSend(
  deps: Pick<TelegramTransportDeps, "connectionRepository">,
  params: { connectionId: string; businessId: string },
): Promise<SendResolution> {
  const connection = await deps.connectionRepository.findByIdWithinBusiness(
    params.connectionId,
    params.businessId,
  );
  if (!connection) {
    return {
      ok: false,
      code: "INVALID_CONNECTION",
      message: "الاتصال غير متاح لهذه المنشأة",
    };
  }
  if (!connection.isActive) {
    return {
      ok: false,
      code: "INVALID_CONNECTION",
      message: "الاتصال غير مفعّل حالياً",
    };
  }
  if (connection.status !== "CONNECTED") {
    return {
      ok: false,
      code: "INVALID_CONNECTION",
      message: "الاتصال غير موصول حالياً",
    };
  }
  if (!connection.credentialsRef) {
    return {
      ok: false,
      code: "UNAUTHORIZED_CREDENTIALS",
      message: "مرجع بيانات اعتماد تيليجرام غير مُهيأ",
    };
  }
  return {
    ok: true,
    connectionId: connection.id,
    branchId: connection.branchId ?? null,
    credentialsRef: connection.credentialsRef,
  };
}

export function createTelegramMessageTransport(
  deps: TelegramTransportDeps = defaultTelegramTransportDeps,
): MessageTransport {
  return {
    providerName: "telegram",
    async send(message: OutboundMessage): Promise<TransportSendResult> {
      // No connection id → no tenant-scoped send (the engine always
      // carries the resolved connection for a connected channel).
      if (!message.connectionId) {
        return {
          provider: "telegram",
          delivered: false,
          error: "لا يوجد اتصال مُحدَّد للإرسال",
          errorCode: "INVALID_CONNECTION",
        };
      }
      const resolution = await resolveTelegramConnectionForSend(deps, {
        connectionId: message.connectionId,
        businessId: message.businessId,
      });
      if (!resolution.ok) {
        return {
          provider: "telegram",
          delivered: false,
          error: resolution.message,
          errorCode: resolution.code,
        };
      }

      const tokenResolution = await resolveTelegramBotToken(
        deps,
        resolution.credentialsRef,
      );
      if (!tokenResolution.ok) {
        return {
          provider: "telegram",
          delivered: false,
          error: tokenResolution.error.message,
          errorCode: tokenResolution.error.code,
        };
      }

      const replyMarkup =
        message.replyMarkup ??
        (message.choices
          ? renderTelegramInlineKeyboard(message.choices)
          : undefined);

      const result = await telegramSendMessage(
        deps.api,
        tokenResolution.token,
        {
          chatId: message.to,
          text: message.content,
          ...(replyMarkup ? { replyMarkup } : {}),
        },
      );
      if (!result.ok) {
        return {
          provider: "telegram",
          delivered: false,
          error: result.error.message,
          errorCode: result.error.code,
        };
      }
      return {
        provider: "telegram",
        delivered: true,
        providerMessageId: String(result.result.message_id),
      };
    },
  };
}

export const defaultTelegramTransportDeps: TelegramTransportDeps = {
  api: {
    fetchImpl: globalThis.fetch,
    apiHost: "https://api.telegram.org",
    credentialsResolver: defaultCredentialsResolver,
  },
  connectionRepository: telegramConnectionRepository,
  credentialsResolver: defaultCredentialsResolver,
};

export { type TelegramApiDeps };
