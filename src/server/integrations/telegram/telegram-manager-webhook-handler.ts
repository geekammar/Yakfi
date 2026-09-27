import {
  getManagerBotToken,
  telegramSendMessage,
} from "@/server/integrations/telegram/telegram-client";
import {
  MANAGED_BOT_KEYBOARD_TITLE,
  buildManagedBotCreationLink,
  buildManagedBotKeyboard,
  completeManagedBotProvisioning,
  deriveManagerWebhookSecret,
  suggestBotUsername,
  type TelegramProvisioningDeps,
} from "@/server/integrations/telegram/telegram-provisioning";
import {
  hashTelegramWebhookSecret,
  parseManagedBotEvent,
  verifyTelegramWebhookSecretConstantTime,
  type ParsedManagedBotEvent,
} from "@/server/integrations/telegram/telegram-webhook";
import type { BusinessRepository } from "@/server/repositories";
import { TransportError } from "@/server/transport/whatsapp-transport";

/**
 * Telegram MANAGER BOT webhook (DECISIONS #66 — slice TELEGRAM 03).
 *
 * The Manager Bot (Bot Management Mode; `TELEGRAM_MANAGER_BOT_TOKEN` in
 * env) is the ONLY bot that receives the two provisioning updates:
 *
 *   1. the Admin's `message` carrying the deep-link payload
 *      `/start <opaque-single-use-token>` → FlowPilot BINDS the Telegram
 *      `user.id` to the in-flight ledger row (the Business comes ONLY
 *      from that row) and replies with the `request_managed_bot`
 *      keyboard — the ONE customer action the approved model requires;
 *   2. the `managed_bot` event (Telegram delivers it to the MANAGING
 *      bot, never to the managed one) → FlowPilot completes provisioning
 *      server-side: the token is fetched via the manager bot, stored ONLY
 *      as an `fp:<id>` RUNTIME reference, the webhook is set with a fresh
 *      per-connection secret, and the connection is verified with
 *      `getMe` → CONNECTED.
 *
 * Security model (parallel to the per-connection webhook, with the env
 * secret as the trust root instead of a connection row):
 * - the `X-Telegram-Bot-Api-Secret-Token` header is the proof of
 *   authenticity. The expected value is DERIVED from the manager token
 *   with a fixed-label HMAC (no extra operator config, no persisted
 *   secret): it is unknowable without the manager token, so only
 *   FlowPilot could have set this webhook. A constant-time compare over
 *   the two fixed-length digests; 401 BEFORE any parsing when the header
 *   is missing, unknown, or when the manager bot is not configured (a
 *   delivery here is then impossible to authenticate).
 * - the Business comes ONLY from the single-use ledger row — never from
 *   the payload, the deep link, or the message text. The deep link's ONLY
 *   payload is the opaque `startToken`.
 * - nothing but safe Arabic copy + the keyboard is sent to the Admin; no
 *   token, no technical identifier, no webhook setting is ever shown.
 *
 * Responsiveness: the provider chain here (token fetch + `setWebhook` +
 * `getMe`) runs INLINE and answers 200 on completion. Telegram allows a
 * generous window before retrying, and the single-use ledger makes a
 * redelivery a no-op (it matches no in-flight attempt), so no deferral is
 * needed on this low-volume provisioning endpoint (unlike the
 * customer-message webhook, where a slow AI turn must never hold the
 * response — DECISIONS #63 (E)).
 */

/** The minimal view of the business the reply copy needs. */
type BusinessNameSource = Pick<BusinessRepository, "findById">;

export type TelegramManagerWebhookHandlerDeps = TelegramProvisioningDeps & {
  businessRepository: BusinessNameSource;
};

/** The parts of a Telegram `Update` this endpoint consumes. */
type TelegramManagerUpdate = {
  update_id?: number;
  message?: {
    message_id?: number;
    date?: number;
    chat?: { id?: number; type?: string };
    from?: { id?: number; is_bot?: boolean };
    text?: string;
  };
  managed_bot?: unknown;
};

/** One classified manager update. */
type ParsedManagerUpdate =
  | {
      status: "start";
      updateId: string;
      /** The Admin's private chat (the reply destination). */
      chatId: string;
      /** The opaque single-use token from the deep link. */
      startToken: string;
    }
  | {
      status: "managed_bot";
      updateId: string;
      event: ParsedManagedBotEvent;
    }
  | {
      status: "other_message";
      updateId: string;
      chatId: string;
    }
  | {
      status: "ignored";
      updateId: string;
      reason: "NON_PRIVATE_CHAT" | "UNSUPPORTED_MESSAGE_TYPE" | "EMPTY_UPDATE";
    }
  | { status: "malformed"; error: TransportError };

function malformed(message: string): TransportError {
  return new TransportError("MALFORMED_PROVIDER_PAYLOAD", message);
}

/**
 * Classify a manager-bot update. Deliberately NOT the per-connection
 * parser (that one is tuned for the customer-message path and needs the
 * connection's own bot id as the envelope recipient, which the manager
 * endpoint has no row for): the manager path cares about exactly two
 * shapes — the `/start <token>` deep-link payload, and the
 * `managed_bot` event. Everything else is acknowledged and ignored per
 * the approved MVP scope (private chats, text only).
 */
export function parseTelegramManagerUpdate(raw: unknown): ParsedManagerUpdate {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      status: "malformed",
      error: malformed("حمولة تيليجرام غير صالحة"),
    };
  }
  const update = raw as TelegramManagerUpdate;
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

  // ── the `managed_bot` provisioning event.
  if (update.managed_bot) {
    const event = parseManagedBotEvent(
      update.managed_bot as Parameters<typeof parseManagedBotEvent>[0],
    );
    if (event instanceof TransportError) {
      return { status: "malformed", error: event };
    }
    return { status: "managed_bot", updateId, event };
  }

  // ── a message (MVP: the `/start <token>` deep-link payload).
  const message = update.message;
  if (!message) {
    return { status: "ignored", updateId, reason: "EMPTY_UPDATE" };
  }
  if (message.chat?.type && message.chat.type !== "private") {
    return { status: "ignored", updateId, reason: "NON_PRIVATE_CHAT" };
  }
  const chatId = message.chat?.id ?? message.from?.id;
  if (typeof chatId !== "number" || !Number.isFinite(chatId)) {
    return {
      status: "malformed",
      error: malformed("هوية محادثة تيليجرام مفقودة"),
    };
  }
  const text = typeof message.text === "string" ? message.text.trim() : "";
  if (!text) {
    return { status: "ignored", updateId, reason: "UNSUPPORTED_MESSAGE_TYPE" };
  }

  // The deep-link payload: `https://t.me/<manager>?start=<token>` arrives
  // as the message text "/start <token>". The token is the ONLY thing the
  // link carries — the Business is resolved from the ledger row it opens.
  const startMatch = /^\/start\s+([A-Za-z0-9_-]+)$/.exec(text);
  if (startMatch) {
    return {
      status: "start",
      updateId,
      chatId: String(chatId),
      startToken: startMatch[1]!,
    };
  }
  return { status: "other_message", updateId, chatId: String(chatId) };
}

// ─── Safe Arabic copy (the ONLY thing the manager bot ever says) ────────────

const START_WELCOME = (businessName: string, usernameHint: string) =>
  `أهلاً بك. ستفعّل الآن بوت تيليجرام الخاص بـ «${businessName}».\nاضغط الزر بالأسفل لإنشاء البوت داخل تيليجرام — لن يُطلب منك أي رمز أو إعداد يدوي، وكل الخطوات تتم بشكل آمن.\n(اقتراح لاسم المستخدم: ${usernameHint})`;

/**
 * The same welcome, but leading with the OFFICIAL managed-bot creation
 * deep link (the reliable primary path). The `request_managed_bot`
 * reply keyboard is STILL attached for clients that launch the native
 * creation UI from it; the link is a tappable fallback that works on any
 * client whose deep-link handler resolves `t.me/newbot/...` (which the
 * live Android report proved the reply-keyboard button alone does not do
 * — tapping it opened nothing). Both routes end in the SAME `managed_bot`
 * event, so there is no second provisioning lifecycle.
 */
const START_WELCOME_WITH_LINK = (
  businessName: string,
  usernameHint: string,
  creationLink: string,
) =>
  `أهلاً بك. ستفعّل الآن بوت تيليجرام الخاص بـ «${businessName}».\nاضغط الرابط التالي لإنشاء البوت داخل تيليجرام — ستفتح نافذة تيليجرام لإنشاء البوت باسم مقترح يمكنك تعديله، دون أي رمز أو إعداد يدوي:\n${creationLink}\n\nأو استخدم زر «${MANAGED_BOT_KEYBOARD_TITLE}» بالأسفل إن ظهر لديك.\n(اقتراح لاسم المستخدم: ${usernameHint})`;

const START_INVALID =
  "انتهت صلاحية هذا الرابط أو أنه غير صالح. ابدأ تفعيل تيليجرام من جديد داخل FlowPilot للحصول على رابط جديد.";

const OTHER_MESSAGE_GUIDE =
  "هذا البوت مخصّص لتفعيل تيليجرام لمنشأتك فقط. افتح شاشة «تيليجرام» في إعدادات FlowPilot وابدأ التفعيل من هناك.";

const PROVISIONED_NOTICE = (businessName: string) =>
  `تم! بوت «${businessName}» جاهز الآن لاستقبال رسائل عملائك على تيليجرام.`;

const PROVISION_FAILED_NOTICE = (reason: string) =>
  `تعذّر إكمال تفعيل البوت: ${reason}. ابدأ محاولة جديدة من شاشة «تيليجرام» في إعدادات FlowPilot.`;

function unauthorized(message: string): Response {
  return Response.json(
    { success: false, error: { code: "UNAUTHENTICATED", message } },
    { status: 401 },
  );
}

/**
 * Send the manager bot's reply. Best-effort by design: a send failure
 * never changes the provisioning outcome (the ledger is the authority,
 * not the message), and the endpoint still answers 200 so Telegram does
 * not retry a reply that may already have been delivered.
 */
async function reply(
  deps: Pick<TelegramManagerWebhookHandlerDeps, "api" | "getEnvVar">,
  chatId: string,
  text: string,
  replyMarkup?: Record<string, unknown>,
): Promise<boolean> {
  const managerToken = getManagerBotToken(deps.getEnvVar);
  if (!managerToken) return false;
  const result = await telegramSendMessage(deps.api, managerToken, {
    chatId,
    text,
    ...(replyMarkup ? { replyMarkup } : {}),
  });
  return result.ok;
}

/**
 * The manager webhook POST. Pure orchestration over injected deps — the
 * route's only job is to supply them, so the whole provisioning path is
 * assertable offline with no DB, no network, and no real credentials.
 */
export async function handleTelegramManagerWebhook(
  deps: TelegramManagerWebhookHandlerDeps,
  request: Request,
): Promise<Response> {
  // 1. AUTHENTICATE. The expected secret is derived from the manager
  //    token; the comparison is constant-time over fixed-length digests,
  //    and 401 is returned BEFORE any parsing (DECISIONS #63 (E) model).
  const managerToken = getManagerBotToken(deps.getEnvVar);
  if (!managerToken) {
    return unauthorized("بوت الإدارة غير مُهيأ");
  }
  const secretHeader =
    request.headers.get("x-telegram-bot-api-secret-token") ??
    request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (!secretHeader) {
    return unauthorized("سر الويبهوك مفقود");
  }
  if (
    !verifyTelegramWebhookSecretConstantTime(
      hashTelegramWebhookSecret(secretHeader),
      hashTelegramWebhookSecret(deriveManagerWebhookSecret(managerToken)),
    )
  ) {
    return unauthorized("سر الويبهوك غير صالح");
  }

  // 2. PARSE + classify.
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return Response.json(
      {
        success: false,
        error: { code: "VALIDATION", message: "حمولة تيليجرام غير صالحة" },
      },
      { status: 400 },
    );
  }
  const parsed = parseTelegramManagerUpdate(json);

  if (parsed.status === "malformed") {
    return Response.json(
      {
        success: false,
        error: { code: parsed.error.code, message: parsed.error.message },
      },
      { status: 400 },
    );
  }

  if (parsed.status === "ignored") {
    // Approved MVP scope (private chats, text). Non-private chats and
    // non-text payloads are acknowledged and ignored — no invented
    // behavior, no side effects.
    return Response.json({
      success: true,
      accepted: false,
      ignored: parsed.reason,
      updateId: parsed.updateId,
    });
  }

  // 3a. The deep-link START: bind the creator, then hand the Admin the
  //     managed-bot keyboard. The Business comes ONLY from the ledger
  //     row this token opens — never from the payload.
  if (parsed.status === "start") {
    const bound = await deps.ledgerRepository.bindCreator(
      parsed.startToken,
      parsed.chatId,
      deps.now(),
    );
    if (!bound) {
      await reply(deps, parsed.chatId, START_INVALID);
      return Response.json({
        success: true,
        accepted: true,
        start: "REJECTED",
        updateId: parsed.updateId,
      });
    }
    // The row this token just bound IS the authority for the Business.
    const ledger = await deps.ledgerRepository.findActiveByCreator(
      parsed.chatId,
      deps.now(),
    );
    const business = ledger
      ? await deps.businessRepository.findById(ledger.businessId)
      : null;
    const businessName = business?.name ?? "منشأتي";
    const usernameHint = suggestBotUsername(businessName);
    // The OFFICIAL managed-bot creation deep link (the reliable primary
    // path — see buildManagedBotCreationLink). Built only when the public
    // manager @username is configured; otherwise we fall back to the
    // reply-keyboard-only welcome (the native-button path). The link needs
    // NO FlowPilot state parameter: creator identity was already bound by
    // this very /start, so the resulting `managed_bot` event still resolves
    // the Business ONLY from the ledger row.
    const managerUsername = deps.getEnvVar("TELEGRAM_MANAGER_BOT_USERNAME");
    const welcomeText = managerUsername
      ? START_WELCOME_WITH_LINK(
          businessName,
          usernameHint,
          buildManagedBotCreationLink(
            managerUsername,
            usernameHint,
            businessName,
          ),
        )
      : START_WELCOME(businessName, usernameHint);
    await reply(deps, parsed.chatId, welcomeText, buildManagedBotKeyboard());
    return Response.json({
      success: true,
      accepted: true,
      start: "BOUND",
      updateId: parsed.updateId,
    });
  }

  // 3b. Any other private message: guide the Admin back to the settings
  //     surface (never silence — the Admin is staring at the bot).
  if (parsed.status === "other_message") {
    await reply(deps, parsed.chatId, OTHER_MESSAGE_GUIDE);
    return Response.json({
      success: true,
      accepted: true,
      start: "GUIDE",
      updateId: parsed.updateId,
    });
  }

  // 3c. The `managed_bot` event: complete provisioning server-side. The
  //     token is fetched via the manager bot and stored ONLY as an
  //     `fp:<id>` RUNTIME reference; the webhook + getMe verification
  //     happen inside the boundary. A failure records its typed outcome
  //     on the ledger so the UI never sits on a permanent spinner.
  const result = await completeManagedBotProvisioning(deps, parsed.event);
  if (result.ok) {
    const business = await deps.businessRepository.findById(result.businessId);
    await reply(
      deps,
      parsed.event.creatorTelegramUserId,
      PROVISIONED_NOTICE(business?.name ?? "منشأتي"),
    );
    return Response.json({
      success: true,
      accepted: true,
      provisioned: true,
      updateId: parsed.updateId,
    });
  }

  await reply(
    deps,
    parsed.event.creatorTelegramUserId,
    PROVISION_FAILED_NOTICE(result.message),
  );
  return Response.json({
    success: true,
    accepted: true,
    provisioned: false,
    outcome: result.code,
    updateId: parsed.updateId,
  });
}
