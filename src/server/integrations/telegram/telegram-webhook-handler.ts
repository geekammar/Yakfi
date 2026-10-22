import {
  hashTelegramWebhookSecret,
  parseTelegramUpdate,
  verifyTelegramWebhookSecretConstantTime,
  type ParsedManagedBotEvent,
} from "@/server/integrations/telegram/telegram-webhook";
import type { TelegramConnectionRepository } from "@/server/repositories";
import {
  toEngineInboundMessage,
  type EngineInboundMessage,
  type ResolvedInboundIdentity,
} from "@/server/transport/whatsapp-transport";

/**
 * Telegram webhook ORCHESTRATION (DECISIONS #63 (E)/#64 — slice TELEGRAM 02).
 *
 * The entire POST logic of `POST /api/telegram/webhook`, extracted into the
 * adapter so the security path is offline-testable with injected
 * dependencies (no DB, no network, no real credentials). The route file is
 * the thin composition point: it wires the production singletons (the
 * repository, the Telegram-backed `MessageTransport`, and Next 16 `after`)
 * and delegates here.
 *
 * Three Telegram-protocol-owned steps, nothing else:
 *
 * 1. AUTHENTICATE + RESOLVE — the `X-Telegram-Bot-Api-Secret-Token` header
 *    is the proof of authenticity (no Meta-style GET handshake). Its SHA-256
 *    digest resolves EXACTLY ONE Business-owned connection server-side, and
 *    the digest comparison is constant-time. An invalid, unknown, or missing
 *    secret gets 401 BEFORE any parsing or processing.
 * 2. PARSE + CLASSIFY — a Telegram `Update` is validated and routed by the
 *    approved MVP scope (private text only; non-private and non-text are
 *    acknowledged and not processed; `managed_bot` is deferred to the
 *    provisioning slice). A customer `/start` (with or without a payload)
 *    is classified as a DETERMINISTIC control command (DECISIONS #73), NOT
 *    a conversation turn: it is answered with a fixed welcome and NEVER
 *    reaches the engine, AI, disclosure, or human handoff. (The Manager
 *    Bot provisioning `/start <token>` is a wholly separate route/handler
 *    — `telegram-manager-webhook-handler.ts` — and is untouched.)
 * 3. DISPATCH — a supported private TEXT message is handed to the
 *    provider-neutral Conversation Engine through the SAME envelope the
 *    WhatsApp path uses, and the turn is SCHEDULED so the response returns
 *    200 promptly (Telegram retries on non-2xx then gives up; DECISIONS
 *    #63 (E)). `update_id` is the inbound external key, so the EXISTING
 *    durable dedupe ledger makes redeliveries idempotent with zero change.
 *
 * Boundary rules:
 * - The Business comes ONLY from the resolved connection row — never from
 *   the payload, a query parameter, or a client header. The classified
 *   update carries no identity keys at all (`strict()` envelope).
 * - This module never imports the Conversation Engine; the route supplies
 *   the turn processor, so the dependency direction (features → server)
 *   stays intact and the engine stays free of Telegram HTTP logic.
 */

/** The minimal view of the engine turn result this orchestrator needs. */
export type TelegramInboundTurnResult = {
  ok: boolean;
  duplicate?: boolean;
  code?: string;
};

/**
 * The webhook handler's injectable dependencies — every one of them is an
 * existing app boundary; none is a Telegram HTTP concern (the token never
 * crosses this module: the connection row carries only a `credentialsRef`).
 */
export type TelegramWebhookHandlerDeps = {
  connectionRepository: Pick<
    TelegramConnectionRepository,
    "findByWebhookSecretHash"
  >;
  /**
   * Process ONE supported private text message through the Conversation
   * Engine. Supplied by the route (the composition layer) — it closes over
   * the Telegram-backed `MessageTransport` and the engine, so this module
   * imports neither.
   */
  processInboundMessage: (params: {
    engineInput: EngineInboundMessage;
    identity: ResolvedInboundIdentity;
  }) => Promise<TelegramInboundTurnResult>;
  /**
   * Complete a `managed_bot` provisioning event server-side
   * (DECISIONS #66): the managed bot token is fetched via the MANAGER
   * bot, stored ONLY as an `fp:<id>` RUNTIME reference, the webhook is
   * set with a fresh per-connection secret, and the connection is
   * verified with `getMe`. Telegram delivers this event to the MANAGING
   * bot, so this hook is normally a no-op on the per-connection endpoint
   * — it exists so a delivery that ever arrives here is completed
   * instead of merely acknowledged. Optional: the manager webhook route
   * supplies the real boundary; an unbound route answers 200 honestly.
   */
  completeManagedBotProvisioning?: (params: {
    event: ParsedManagedBotEvent;
  }) => Promise<ManagedBotProvisioningOutcome>;
  /**
   * Acknowledge a customer inline keyboard callback query (UX001).
   * Tells Telegram client to dismiss the button loading spinner.
   */
  answerCallbackQuery?: (params: {
    callbackQueryId: string;
    businessId: string;
    connectionId: string;
  }) => Promise<void>;
  /**
   * Send the deterministic customer `/start` welcome through the EXISTING
   * Telegram `MessageTransport` (DECISIONS #73). Supplied by the route (the
   * composition layer) — it closes over the SAME Telegram-backed transport
   * the engine uses, so this module imports no transport and introduces NO
   * second messaging abstraction. The handler decides the fixed `text`; the
   * closure only delivers it. Optional: a route that does not wire it still
   * acknowledges `/start` (still no engine, still no handoff) — the welcome
   * is simply not sent.
   */
  sendStartWelcome?: (params: {
    chatId: string;
    businessId: string;
    connectionId: string;
    branchId: string | null;
    /** The deterministic welcome text the handler chose (never AI-authored). */
    text: string;
  }) => Promise<void>;
  /**
   * Defer the engine turn until AFTER the 200 is flushed (Next 16 `after`,
   * backed by `waitUntil` on Vercel). Telegram retries on non-2xx, so a slow
   * AI turn must never hold the response; the durable dedupe ledger keeps a
   * redelivery idempotent if the deferred work is lost. Overridable so the
   * offline harness can run the turn synchronously and observe its effects.
   */
  schedule: (work: () => Promise<void> | void) => void;
};

/** The outcome the handler needs from a managed-bot completion. */
export type ManagedBotProvisioningOutcome = {
  ok: boolean;
  /** The typed failure code when `ok` is false (safe to log + surface). */
  code?: string;
};

/** Namespaced external keys + the resolved identity, for the deferred turn. */
type DispatchParams = {
  engineInput: EngineInboundMessage;
  identity: ResolvedInboundIdentity;
};

function unauthorized(message: string): Response {
  return Response.json(
    { success: false, error: { code: "UNAUTHENTICATED", message } },
    { status: 401 },
  );
}

/**
 * The deterministic Arabic welcome a customer managed bot replies with when
 * a customer sends `/start` (DECISIONS #73). It is a FIXED string — never
 * AI-generated, never a handoff acknowledgment — appropriate for a business
 * customer bot. Exported so the composition layer and the offline harness
 * assert the exact copy.
 */
export const CUSTOMER_START_WELCOME =
  "أهلاً بك 👋\nمرحبًا بك! كيف يمكنني مساعدتك؟";

/**
 * The webhook POST. Pure orchestration over injected deps — the route's only
 * job is to supply them, so the whole security path is assertable offline.
 */
export async function handleTelegramWebhook(
  deps: TelegramWebhookHandlerDeps,
  request: Request,
): Promise<Response> {
  // 1. AUTHENTICATE + resolve the connection server-side. Only the
  //    NON-REVERSIBLE digest of the header is used; the plaintext secret is
  //    not stored anywhere, and the constant-time compare runs over two
  //    fixed-length digests.
  const secretHeader =
    request.headers.get("x-telegram-bot-api-secret-token") ??
    request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (!secretHeader) {
    return unauthorized("سر الويبهوك مفقود");
  }
  const digest = hashTelegramWebhookSecret(secretHeader);
  const connection =
    await deps.connectionRepository.findByWebhookSecretHash(digest);
  if (!connection || !connection.webhookSecretHash) {
    return unauthorized("سر الويبهوك غير صالح");
  }
  if (
    !verifyTelegramWebhookSecretConstantTime(
      digest,
      connection.webhookSecretHash,
    )
  ) {
    return unauthorized("سر الويبهوك غير صالح");
  }

  // 2. Parse + classify the raw body against the approved MVP scope. The
  //    connection's own bot identity (server-resolved) is the recipient.
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

  const parsed = parseTelegramUpdate(json, {
    botExternalId: connection.botExternalId,
  });

  if (parsed.status === "malformed") {
    return Response.json(
      {
        success: false,
        error: { code: parsed.error.code, message: parsed.error.message },
      },
      { status: 400 },
    );
  }

  // The `managed_bot` provisioning event is classified by the parser. On
  // THIS endpoint it is an unusual delivery (Telegram routes the event to
  // the MANAGING bot — `/api/telegram/manager/webhook`), but a bot whose
  // own secret is configured could deliver it here, so the completion is
  // run when the route supplies it and acknowledged either way: the event
  // is never silently mistaken for a customer message. A completion
  // failure stays a 200 with the typed outcome — Telegram would otherwise
  // retry forever, and the outcome is recorded on the ledger.
  if (parsed.status === "managed_bot") {
    const outcome = deps.completeManagedBotProvisioning
      ? await deps.completeManagedBotProvisioning({ event: parsed.event })
      : { ok: false, code: "MANAGED_BOT_PROVISIONING_UNBOUND" };
    return Response.json({
      success: true,
      accepted: outcome.ok,
      ...(outcome.ok
        ? { provisioned: true }
        : { deferred: "MANAGED_BOT_PROVISIONING", outcome: outcome.code }),
      updateId: parsed.updateId,
    });
  }

  if (parsed.status === "ignored") {
    // Approved MVP scope: private chats + text. Non-private chats and
    // non-text messages are acknowledged (200) and not processed — no
    // invented behavior, no side effects, no operator signal. Answering 200
    // also stops Telegram retrying something we will never handle.
    return Response.json({
      success: true,
      accepted: false,
      ignored: parsed.reason,
      updateId: parsed.updateId,
    });
  }

  // A customer `/start` (with or without a payload) is routed through the
  // existing application path (DECISIONS #63/#73 / UX001): business identity,
  // active-state handling, dedupe, and staff ownership are resolved server-side
  // with zero JEV and zero generative model calls. The start payload is
  // preserved as safe command metadata.
  if (parsed.status === "start_command") {
    const text = parsed.startPayload
      ? `/start ${parsed.startPayload}`
      : "/start";
    const dispatch: DispatchParams = {
      engineInput: {
        externalId: `tg:${connection.botExternalId}:${parsed.updateId}`,
        from: parsed.chatId,
        to: connection.botExternalId,
        receivedAt: new Date().toISOString(),
        text,
      },
      identity: {
        businessId: connection.businessId,
        branchId: connection.branchId,
        connectionId: connection.id,
      },
    };

    deps.schedule(async () => {
      try {
        await deps.processInboundMessage(dispatch);
      } catch {
        // A deferred turn must never crash the process after the 200.
      }
    });

    return Response.json({
      success: true,
      accepted: true,
      start: "WELCOME",
      updateId: parsed.updateId,
    });
  }

  // A customer interactive callback query (UX001): acknowledge promptly to
  // dismiss the Telegram button spinner, then dispatch the selection to the engine.
  if (parsed.status === "callback_query") {
    if (parsed.callbackQueryId && deps.answerCallbackQuery) {
      const cbId = parsed.callbackQueryId;
      deps.schedule(async () => {
        try {
          await deps.answerCallbackQuery!({
            callbackQueryId: cbId,
            businessId: connection.businessId,
            connectionId: connection.id,
          });
        } catch {
          // Acknowledgment failure must not crash the handler
        }
      });
    }
  }

  // 3. A supported private TEXT message: the SAME envelope → engine mapping
  //    as the WhatsApp path, then the SAME dedupe + engine. The engine sees
  //    no channel difference. The Business/branch/connection come from the
  //    server-resolved identity only — never from the parsed payload.
  const dispatch: DispatchParams = {
    engineInput: toEngineInboundMessage({
      ...parsed.message,
      businessId: connection.businessId,
      branchId: connection.branchId,
      connectionId: connection.id,
    }),
    identity: {
      businessId: connection.businessId,
      branchId: connection.branchId,
      connectionId: connection.id,
    },
  };

  // Return 200 PROMPTLY and run the turn afterwards (DECISIONS #63 (E)).
  // The durable dedupe ledger (keyed on the namespaced `update_id`) makes a
  // redelivery idempotent, so deferring is safe.
  deps.schedule(async () => {
    try {
      await deps.processInboundMessage(dispatch);
    } catch {
      // A deferred turn must never crash the process after we answered 200.
      // The redelivery path (idempotent) covers a lost attempt.
    }
  });

  return Response.json({
    success: true,
    received: 1,
    results: [{ externalId: parsed.message.externalMessageId, ok: true }],
  });
}
