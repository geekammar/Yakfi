import { createHash, timingSafeEqual } from "node:crypto";

import {
  TransportError,
  normalizeInboundTransportMessage,
  type NormalizedInboundTransportMessage,
} from "@/server/transport/whatsapp-transport";

/**
 * Telegram webhook boundary (DECISIONS #63 (E)/#64).
 *
 * Two responsibilities, both Telegram-protocol-owned and nothing else:
 *
 * 1. SECRET VERIFICATION — the `X-Telegram-Bot-Api-Secret-Token` header
 *    is the proof a delivery really came from Telegram for THIS bot.
 *    There is no Meta-style GET handshake: the header IS the proof. The
 *    connection's stored value is a NON-SECRET SHA-256 digest of the
 *    secret (the plaintext is generated at provisioning, handed to
 *    Telegram once via `setWebhook`, and never persisted), so the digest
 *    of an incoming header identifies AND authenticates the connection,
 *    and the comparison is constant-time over fixed-length digests.
 *
 * 2. UPDATE PARSING — a Telegram `Update` → the provider-neutral
 *    `NormalizedInboundTransportMessage` the transport boundary already
 *    defines, so the webhook route hands the SAME envelope shape to the
 *    SAME engine as the WhatsApp path. `update_id` is the inbound
 *    external key (namespaced per bot — Telegram message ids are only
 *    unique per chat, but `update_id` is unique per bot; the namespace
 *    keeps the durable dedupe ledger exact even if a Business ever runs
 *    more than one bot), so the EXISTING dedupe ledger makes redeliveries
 *    idempotent with zero change.
 *
 * MVP scope (DECISIONS #63 (F), approved): private chats only, text only.
 * Non-private chats are routed away (ignored, 200 — no group support);
 * non-text messages hit the EXISTING approved contract (unsupported →
 * dropped, no invented behavior; the drop-vs-persist-and-defer decision
 * for stickers/voice stays an open, flagged decision, NOT guessed here).
 */

// ─── Secret verification ────────────────────────────────────────────────────

/** SHA-256 hex digest of a webhook secret — the NON-SECRET routing index. */
export function hashTelegramWebhookSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * Constant-time comparison of two hex digests (both fixed 64 chars).
 * Used after the digest lookup so the authentication decision itself is
 * timing-safe — the digest is non-reversible, so this never exposes the
 * plaintext secret.
 */
export function verifyTelegramWebhookSecretConstantTime(
  providedDigest: string,
  expectedDigest: string,
): boolean {
  if (providedDigest.length !== 64 || expectedDigest.length !== 64) {
    return false;
  }
  const provided = Buffer.from(providedDigest, "hex");
  const expected = Buffer.from(expectedDigest, "hex");
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

// ─── Update parsing ─────────────────────────────────────────────────────────

/** The parts of a Telegram `Update` this boundary consumes. */
type TelegramChat = {
  id?: number;
  type?: string;
  first_name?: string;
  username?: string;
};

type TelegramUser = {
  id?: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
};

type TelegramMessage = {
  message_id?: number;
  date?: number;
  chat?: TelegramChat;
  from?: TelegramUser;
  text?: string;
};

type TelegramManagedBot = {
  bot?: TelegramUser;
  user?: TelegramUser;
  added?: boolean;
};

type TelegramUpdate = {
  update_id?: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  managed_bot?: TelegramManagedBot;
  callback_query?: unknown;
};

/** A parsed `managed_bot` provisioning event (DECISIONS #63 (B)/(D)). */
export type ParsedManagedBotEvent = {
  /** The Telegram `user.id` that created the bot — must equal the ledger's
   *  bound creator, or the callback provisions nothing. */
  creatorTelegramUserId: string;
  /** The newly created managed bot's id. */
  botExternalId: string;
  /** The bot's @username, when Telegram reported it (non-secret label). */
  botUsername?: string;
};

/**
 * The classified result of one Telegram Update. Everything the webhook
 * route needs to decide; no Telegram object shapes leak past this module.
 */
export type ParsedTelegramUpdate =
  | {
      status: "message";
      updateId: string;
      /** The normalized envelope the engine consumes (private TEXT only). */
      message: NormalizedInboundTransportMessage;
    }
  | {
      status: "managed_bot";
      updateId: string;
      event: ParsedManagedBotEvent;
    }
  | {
      status: "ignored";
      updateId: string;
      reason:
        | "NON_PRIVATE_CHAT"
        | "UNSUPPORTED_MESSAGE_TYPE"
        | "UNSUPPORTED_UPDATE_TYPE";
    }
  | { status: "malformed"; error: TransportError };

function malformed(message: string): TransportError {
  return new TransportError("MALFORMED_PROVIDER_PAYLOAD", message);
}

function toIsoTimestamp(epochSeconds: number): string | null {
  const ms = epochSeconds * 1000;
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/**
 * Parse a raw Telegram webhook body.
 *
 * `botExternalId` is the connection's OWN stable Telegram identity,
 * resolved server-side BEFORE this call (from the webhook secret digest
 * → `TelegramConnection`); it becomes the normalized envelope's
 * recipient identity, exactly like the Meta `phone_number_id` path.
 */
export function parseTelegramUpdate(
  raw: unknown,
  options: { botExternalId: string },
): ParsedTelegramUpdate {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      status: "malformed",
      error: malformed("حمولة تيليجرام غير صالحة"),
    };
  }
  const update = raw as TelegramUpdate;
  if (
    typeof update.update_id !== "number" ||
    !Number.isFinite(update.update_id)
  ) {
    return {
      status: "malformed",
      error: malformed("معرّف التحديث مفقود في حمولة تيليجرام"),
    };
  }
  const updateId = String(update.update_id);

  // ── managed_bot provisioning event (handled by the provisioning
  // boundary; NOT a customer message). */
  if (update.managed_bot) {
    const event = parseManagedBotEvent(update.managed_bot);
    if (event instanceof TransportError) {
      return { status: "malformed", error: event };
    }
    return { status: "managed_bot", updateId, event };
  }

  // ── customer message (MVP: the `message` field, private chats only).
  //    Edited messages, channel posts, and callback queries are out of
  //    scope for the text-first MVP.
  const message = update.message;
  if (!message) {
    return {
      status: "ignored",
      updateId,
      reason: "UNSUPPORTED_UPDATE_TYPE",
    };
  }
  if (message.chat?.type && message.chat.type !== "private") {
    // Approved MVP scope: PRIVATE CHATS ONLY (DECISIONS #63 (F)(2)).
    return { status: "ignored", updateId, reason: "NON_PRIVATE_CHAT" };
  }
  if (
    typeof message.message_id !== "number" ||
    typeof message.date !== "number"
  ) {
    return {
      status: "malformed",
      error: malformed("حقول الرسالة الواردة ناقصة"),
    };
  }
  const text = typeof message.text === "string" ? message.text.trim() : "";
  if (!text) {
    // Non-text (sticker/voice/photo/…) or an empty body: the EXISTING
    // approved contract — unsupported, dropped (DECISIONS #63 (F)(1)
    // stays an open drop-vs-defer decision; no behavior is invented).
    return { status: "ignored", updateId, reason: "UNSUPPORTED_MESSAGE_TYPE" };
  }
  const timestamp = toIsoTimestamp(message.date);
  if (!timestamp) {
    return { status: "malformed", error: malformed("زمن الرسالة غير صالح") };
  }

  // The customer's provider-neutral external handle: the private-chat
  // chat id (which equals the user id) — the engine stores it on
  // `Customer.phone` exactly like a WhatsApp number (DECISIONS #64).
  const chatId = message.chat?.id ?? message.from?.id;
  if (typeof chatId !== "number" || !Number.isFinite(chatId)) {
    return {
      status: "malformed",
      error: malformed("هوية محادثة تيليجرام مفقودة"),
    };
  }

  const result = normalizeInboundTransportMessage({
    // Namespaced per bot so the durable dedupe ledger key is exact even
    // for multiple bots per Business (Telegram `update_id` is unique per
    // bot, not globally).
    externalMessageId: `tg:${options.botExternalId}:${updateId}`,
    senderExternalId: String(chatId),
    recipientExternalId: options.botExternalId,
    recipientProviderId: options.botExternalId,
    timestamp,
    kind: "TEXT",
    text,
  });
  if (!result.ok) {
    return { status: "malformed", error: result.error };
  }
  return { status: "message", updateId, message: result.message };
}

/** Parse a `managed_bot` provisioning event or return a typed failure. */
export function parseManagedBotEvent(
  raw: TelegramManagedBot,
): ParsedManagedBotEvent | TransportError {
  const botId = raw.bot?.id;
  const creatorId = raw.user?.id;
  if (typeof botId !== "number" || !Number.isFinite(botId)) {
    return malformed("هوية البوت المُدار مفقودة");
  }
  if (typeof creatorId !== "number" || !Number.isFinite(creatorId)) {
    return malformed("هوية منشئ البوت المُدار مفقودة");
  }
  const botUsername = raw.bot?.username?.trim();
  return {
    creatorTelegramUserId: String(creatorId),
    botExternalId: String(botId),
    ...(botUsername ? { botUsername } : {}),
  };
}
