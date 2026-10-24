import {
  defaultCredentialsResolver,
  type CredentialsResolver,
} from "@/server/credentials/credentials-resolver";
import {
  TransportError,
  type WhatsAppTransportErrorCode,
} from "@/server/transport/whatsapp-transport";

/**
 * Telegram Bot API — the ONE HTTP boundary for the Telegram channel
 * (DECISIONS #63; mirrors the Meta client's boundary discipline).
 *
 * Boundary rules:
 * - Telegram concepts (api.telegram.org URL, the bot token in the path,
 *   `error_code`/`description` bodies, HTTP statuses) live ONLY here and
 *   in the sibling adapter modules — never in the Conversation Engine,
 *   never in a repository, never in the AI layer.
 * - The bot token is a server-side REFERENCE indirection: a connection's
 *   `credentialsRef` holds an opaque `fp:<id>` RUNTIME handle (DECISIONS
 *   #49) resolved through `CredentialsResolver` at call time. The token
 *   value NEVER leaves this module family, never reaches a log, a DB
 *   projection, an API response, or a domain payload.
 * - The MANAGER bot token (`TELEGRAM_MANAGER_BOT_TOKEN`) is an
 *   environment secret read ONLY inside the provisioning boundary for
 *   the `getManagedBotToken` / `replaceManagedBotToken` calls — never
 *   stored in the database, never returned to any caller.
 * - Vendor errors are mapped onto the provider-neutral transport taxonomy
 *   below; Core never assumes Telegram-specific statuses.
 */

export const TELEGRAM_API_HOST = "https://api.telegram.org";

export type TelegramApiDeps = {
  fetchImpl: typeof fetch;
  apiHost: string;
  /**
   * Resolves a connection's `credentialsRef` (`fp:<id>` RUNTIME handle)
   * to the managed bot token — the value stays in the adapter. */
  credentialsResolver: Pick<CredentialsResolver, "resolve">;
};

/** The part of a Telegram error body the boundary cares about. */
export type TelegramErrorBody = {
  ok?: false;
  error_code?: number;
  description?: string;
};

/**
 * Map a Telegram HTTP failure onto the provider-neutral taxonomy
 * (DECISIONS #63 (E)): 401/403 → the credential is unusable;
 * 429 and any 5xx → transient (Telegram-side, retryable by the adapter);
 * any other 4xx → permanent.
 */
export function mapTelegramError(
  status: number,
  _body: TelegramErrorBody | null,
): WhatsAppTransportErrorCode {
  if (status === 401 || status === 403)
    return "UNAUTHORIZED_CREDENTIALS" as const;
  if (status === 429) return "TRANSIENT_TRANSPORT_FAILURE" as const;
  if (status >= 500) return "TRANSIENT_TRANSPORT_FAILURE" as const;
  return "PERMANENT_TRANSPORT_FAILURE" as const;
}

export function buildTelegramApiUrl(
  host: string,
  token: string,
  method: string,
): string {
  return `${host}/bot${token}/${method}`;
}

export type TelegramApiResult<T> =
  { ok: true; result: T } | { ok: false; error: TransportError };

/**
 * The single Telegram HTTP call. The token is passed already resolved (a
 * caller resolves it from a `credentialsRef` or from the manager env
 * secret); it is used ONLY in the request URL and is never included in
 * the returned value, an error, or a log line.
 */
export async function callTelegramApi<T>(
  deps: TelegramApiDeps,
  params: {
    token: string;
    method: string;
    body?: Record<string, unknown>;
  },
): Promise<TelegramApiResult<T>> {
  const url = buildTelegramApiUrl(deps.apiHost, params.token, params.method);
  let response: Response;
  try {
    response = await deps.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      ...(params.body ? { body: JSON.stringify(params.body) } : {}),
    });
  } catch {
    return {
      ok: false,
      error: new TransportError(
        "TRANSIENT_TRANSPORT_FAILURE",
        "تعذر الاتصال بخدمة تيليجرام",
      ),
    };
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const errorBody =
      body && typeof body === "object" && "error_code" in body
        ? (body as TelegramErrorBody)
        : null;
    const code = mapTelegramError(response.status, errorBody);
    return {
      ok: false,
      error: new TransportError(code, telegramFailureMessage(code)),
    };
  }

  const payload = body as { ok?: boolean; result?: T } | null;
  if (!payload || payload.ok !== true || payload.result === undefined) {
    return {
      ok: false,
      error: new TransportError(
        "MALFORMED_PROVIDER_PAYLOAD",
        "استجابة تيليجرام غير صالحة",
      ),
    };
  }
  return { ok: true, result: payload.result };
}

function telegramFailureMessage(code: WhatsAppTransportErrorCode): string {
  switch (code) {
    case "UNAUTHORIZED_CREDENTIALS":
      return "بيانات اعتماد تيليجرام غير صالحة أو منتهية";
    case "TRANSIENT_TRANSPORT_FAILURE":
      return "خدمة تيليجرام غير متاحة حالياً";
    default:
      return "فشل دائم في طلب تيليجرام";
  }
}

/**
 * Resolve a connection's credential REFERENCE to the managed bot token.
 * The value is returned to the adapter caller ONLY — never persisted,
 * logged, or projected (DECISIONS #49).
 */
export async function resolveTelegramBotToken(
  deps: Pick<TelegramApiDeps, "credentialsResolver">,
  credentialsRef: string | null | undefined,
): Promise<{ ok: true; token: string } | { ok: false; error: TransportError }> {
  if (!credentialsRef) {
    return {
      ok: false,
      error: new TransportError(
        "UNAUTHORIZED_CREDENTIALS",
        "مرجع بيانات اعتماد تيليجرام مفقود",
      ),
    };
  }
  const resolved = await deps.credentialsResolver.resolve(
    credentialsRef.trim(),
  );
  if (!resolved.ok) {
    return {
      ok: false,
      error: new TransportError("UNAUTHORIZED_CREDENTIALS", resolved.message),
    };
  }
  return { ok: true, token: resolved.value };
}

/** The Manager Bot token — an env secret, read ONLY for provisioning. */
export function getManagerBotToken(
  getEnvVar: (name: string) => string | undefined,
): string | undefined {
  return getEnvVar("TELEGRAM_MANAGER_BOT_TOKEN");
}

// ─── Typed API method shapes (result subsets) ───────────────────────────────

export type TelegramBotUser = {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
  can_manage_bots?: boolean;
};

export type TelegramSendMessageResult = {
  message_id: number;
  date?: number;
  chat?: { id: number; type?: string };
};

export type TelegramSetWebhookResult = { ok?: true };

/**
 * `getMe` — the connection's own identity. Used by the verifier (a
 * READ-ONLY check that proves the stored `botExternalId` is real) and by
 * provisioning (the bot id Telegram reports must match the managed-bot
 * event's bot).
 */
export async function telegramGetMe(
  deps: TelegramApiDeps,
  token: string,
): Promise<TelegramApiResult<TelegramBotUser>> {
  return callTelegramApi<TelegramBotUser>(deps, { token, method: "getMe" });
}

/**
 * `sendMessage` — the ONLY customer-facing write the channel performs.
 * `chat_id` is the provider-neutral external handle the engine carried
 * inbound (a private-chat Telegram chat id; DECISIONS #64).
 *
 * `replyMarkup` is the ONE provisioning-only escape hatch: the Manager
 * Bot attaches the `KeyboardButtonRequestManagedBot` keyboard to its
 * provisioning reply so the Admin confirms creation inside Telegram's
 * own UI (DECISIONS #63 (B)). It is never used by the conversation
 * engine path (the transport's own `send` never passes it).
 */
export async function telegramSendMessage(
  deps: TelegramApiDeps,
  token: string,
  params: {
    chatId: string;
    text: string;
    replyMarkup?: Record<string, unknown>;
  },
): Promise<TelegramApiResult<TelegramSendMessageResult>> {
  return callTelegramApi<TelegramSendMessageResult>(deps, {
    token,
    method: "sendMessage",
    body: {
      chat_id: params.chatId,
      text: params.text,
      ...(params.replyMarkup ? { reply_markup: params.replyMarkup } : {}),
    },
  });
}

export const TELEGRAM_CUSTOMER_ALLOWED_UPDATES = [
  "message",
  "callback_query",
] as const;

export const TELEGRAM_MANAGER_ALLOWED_UPDATES = [
  "message",
  "managed_bot",
] as const;

export type TelegramWebhookInfo = {
  url: string;
  has_custom_certificate?: boolean;
  pending_update_count: number;
  ip_address?: string;
  last_error_date?: number;
  last_error_message?: string;
  last_synchronization_error_date?: number;
  max_connections?: number;
  allowed_updates?: string[];
};

/**
 * `getWebhookInfo` — returns current webhook status for the bot.
 * Read-only check for URL, allowed_updates, pending updates, and errors.
 */
export async function telegramGetWebhookInfo(
  deps: TelegramApiDeps,
  token: string,
): Promise<TelegramApiResult<TelegramWebhookInfo>> {
  return callTelegramApi<TelegramWebhookInfo>(deps, {
    token,
    method: "getWebhookInfo",
  });
}

/**
 * `setWebhook` — webhook (NOT `getUpdates` polling; polling is
 * incompatible with the Vercel-only infrastructure constraint,
 * DECISIONS #63 (E)). Defaults to `TELEGRAM_CUSTOMER_ALLOWED_UPDATES`
 * (["message", "callback_query"]) for customer conversation bots.
 */
export async function telegramSetWebhook(
  deps: TelegramApiDeps,
  token: string,
  params: {
    url: string;
    secretToken: string;
    allowedUpdates?: string[];
  },
): Promise<TelegramApiResult<TelegramSetWebhookResult>> {
  return callTelegramApi<TelegramSetWebhookResult>(deps, {
    token,
    method: "setWebhook",
    body: {
      url: params.url,
      secret_token: params.secretToken,
      allowed_updates: params.allowedUpdates ?? [
        ...TELEGRAM_CUSTOMER_ALLOWED_UPDATES,
      ],
    },
  });
}

/**
 * `deleteWebhook` — the disconnect primitive (DECISIONS #66). Removes the
 * webhook so Telegram stops delivering updates for this bot; called with
 * `drop_pending_updates` so a disconnected bot leaves no queued traffic
 * for a later reconnect to process as if it were live.
 */
export async function telegramDeleteWebhook(
  deps: TelegramApiDeps,
  token: string,
): Promise<TelegramApiResult<Record<string, never>>> {
  return callTelegramApi<Record<string, never>>(deps, {
    token,
    method: "deleteWebhook",
    body: { drop_pending_updates: true },
  });
}

/**
 * `getManagedBotToken` — the Managed Bot provisioning primitive. Only the
 * FlowPilot MANAGER Bot (Bot Management Mode enabled) may call it.
 *
 * WIRE SHAPE (authoritative Telegram Bot API):
 * - REQUEST: the method takes `user_id` — the managed bot's own Telegram
 *   User.id (the value carried on the `managed_bot` event's `bot.id`).
 *   It is NOT `managed_bot_id` (a field the API does not recognise).
 * - RESPONSE: the `result` is the token as a BARE STRING — NOT a
 *   `{ token: string }` object. It is validated here (a non-empty string)
 *   and any other shape fails safely as `MALFORMED_PROVIDER_PAYLOAD`.
 *
 * The returned token is stored ONLY as an `fp:<id>` RUNTIME reference and
 * never returned to any caller or UI, never logged, and never placed in an
 * error message.
 */
export async function telegramGetManagedBotToken(
  deps: TelegramApiDeps,
  params: { managerToken: string; userId: string },
): Promise<TelegramApiResult<string>> {
  const response = await callTelegramApi<unknown>(deps, {
    token: params.managerToken,
    method: "getManagedBotToken",
    body: { user_id: params.userId },
  });
  if (!response.ok) return response;
  // The Bot API returns the token as a bare string. Validate it BEFORE the
  // caller ever hands it to `setWebhook` (defence in depth: a malformed or
  // non-string `result` must not become an empty/invalid token). The token
  // value is never included in the error message.
  const token = response.result;
  if (typeof token !== "string" || token.trim().length === 0) {
    return {
      ok: false,
      error: new TransportError(
        "MALFORMED_PROVIDER_PAYLOAD",
        "استجابة رمز البوت المُدار غير صالحة",
      ),
    };
  }
  return { ok: true, result: token };
}

export type TelegramAnswerCallbackQueryResult = { ok?: boolean };

/**
 * `answerCallbackQuery` — acknowledges a Telegram callback query (DECISIONS #63 / UX001).
 * Tells Telegram client to dismiss the button loading spinner.
 */
export async function telegramAnswerCallbackQuery(
  deps: TelegramApiDeps,
  token: string,
  params: {
    callbackQueryId: string;
    text?: string;
    showAlert?: boolean;
  },
): Promise<TelegramApiResult<TelegramAnswerCallbackQueryResult>> {
  return callTelegramApi<TelegramAnswerCallbackQueryResult>(deps, {
    token,
    method: "answerCallbackQuery",
    body: {
      callback_query_id: params.callbackQueryId,
      ...(params.text ? { text: params.text } : {}),
      ...(params.showAlert ? { show_alert: params.showAlert } : {}),
    },
  });
}

/** The production adapter deps (app singletons; `fetch` = the runtime's). */
export const defaultTelegramApiDeps: TelegramApiDeps = {
  fetchImpl: globalThis.fetch,
  apiHost: TELEGRAM_API_HOST,
  credentialsResolver: defaultCredentialsResolver,
};
