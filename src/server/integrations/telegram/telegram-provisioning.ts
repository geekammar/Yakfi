import { createHmac } from "node:crypto";

import { TELEGRAM_PROVIDER, telegramStartTokenSchema } from "@/lib/validation";
import { mintRuntimeCredentialReference } from "@/server/credentials/credentials-resolver";
import type { RuntimeCredentialStore } from "@/server/credentials/runtime-credential-store";
import {
  TELEGRAM_CUSTOMER_ALLOWED_UPDATES,
  TELEGRAM_MANAGER_ALLOWED_UPDATES,
  getManagerBotToken,
  resolveTelegramBotToken,
  telegramDeleteWebhook,
  telegramGetManagedBotToken,
  telegramGetMe,
  telegramSetWebhook,
  type TelegramApiDeps,
} from "@/server/integrations/telegram/telegram-client";
import {
  hashTelegramWebhookSecret,
  type ParsedManagedBotEvent,
} from "@/server/integrations/telegram/telegram-webhook";
import type {
  TelegramConnectionRepository,
  TelegramProvisioningLedgerRepository,
} from "@/server/repositories";

/**
 * Telegram Managed Bot provisioning boundary (DECISIONS #63 (B)/(D)).
 *
 * The approved provisioning model — the customer NEVER pastes a bot token
 * and NEVER visits BotFather:
 *
 *   FlowPilot mints a single-use `startToken` + server-persisted ledger
 *   row (businessId = the ONLY authority) → the Admin opens
 *   `https://t.me/<manager>?start=<token>` → STARTs the Manager Bot →
 *   FlowPilot binds the Telegram `user.id` to the ledger row → sends the
 *   `KeyboardButtonRequestManagedBot` keyboard (the UI slice) → the Admin
 *   taps + confirms in Telegram's native creation UI (the ONE unavoidable
 *   customer action — Telegram requires the bot's owner to approve) →
 *   Telegram delivers the `managed_bot` event → THIS boundary completes
 *   provisioning.
 *
 * This module owns the `managed_bot` EVENT boundary only: it consumes the
 * ledger, fetches the managed bot token via the MANAGER bot, sets the
 * webhook, verifies with `getMe`, and persists the connection — with the
 * token stored ONLY as an opaque `fp:<id>` RUNTIME reference. Every
 * failure TERMINATES the attempt with a typed outcome recorded on the
 * ledger, so the polling surface never sits on a permanent spinner. The
 * customer-facing UI (deep-link generation, the keyboard, the settings
 * surface) and the manager-bot `/start` binding wiring are the NEXT slice.
 */

/** Lifetime of a provisioning attempt (a human confirmation in Telegram). */
export const PROVISIONING_RESULT_CODES = [
  "PROVISIONED",
  "BOT_ATTACHED_TO_ANOTHER_BUSINESS",
  "BOT_ALREADY_PROVISIONED",
  "NO_IN_FLIGHT_ATTEMPT",
  "ATTEMPT_EXPIRED",
  "CREATOR_MISMATCH",
  "MANAGER_BOT_NOT_CONFIGURED",
  "PROVIDER_UNREACHABLE",
  "CREDENTIAL_STORE_UNAVAILABLE",
  "PROVISIONING_FAILED",
] as const;

export type ProvisioningResultCode = (typeof PROVISIONING_RESULT_CODES)[number];

export type ManagedBotProvisioningResult =
  | {
      ok: true;
      connectionId: string;
      businessId: string;
      botExternalId: string;
    }
  | { ok: false; code: ProvisioningResultCode; message: string };

export type TelegramProvisioningDeps = {
  api: TelegramApiDeps;
  ledgerRepository: Pick<
    TelegramProvisioningLedgerRepository,
    | "findActiveByCreator"
    | "findActiveByBusiness"
    | "bindCreator"
    | "consume"
    | "recordConnectionId"
    | "recordOutcome"
  >;
  connectionRepository: Pick<
    TelegramConnectionRepository,
    | "findByExternalId"
    | "findByIdWithinBusiness"
    | "create"
    | "update"
    | "disconnect"
    | "markOnboardingReady"
  >;
  credentialStore: Pick<RuntimeCredentialStore, "store" | "delete">;
  getEnvVar: (name: string) => string | undefined;
  /** The base URL the webhook lives under (e.g. the deployment origin). */
  webhookBaseUrl: string;
  /** The Manager Bot's Telegram id (provenance on each connection). */
  managerBotId?: string;
  now(): Date;
};

/** Mint an opaque single-use start token for a provisioning deep link. */
export function mintTelegramStartToken(): string {
  // 24 random bytes → 32 url-safe base64 chars; unguessable, single-use.
  const token =
    crypto.randomUUID().replace(/-/g, "") +
    crypto.randomUUID().replace(/-/g, "");
  return telegramStartTokenSchema.parse(token.slice(0, 32));
}

/**
 * The customer-facing deep link. The ONLY thing it carries is the opaque
 * single-use token — no business id, no connection id, no tenant hint —
 * so the server-persisted ledger row is the sole authority for which
 * Business a provisioning attempt belongs to.
 */
export function buildManagedBotDeepLink(
  managerBotUsername: string,
  startToken: string,
): string {
  const username = managerBotUsername.replace(/^@/, "");
  return `https://t.me/${username}?start=${startToken}`;
}

/**
 * The OFFICIAL Telegram managed-bot creation deep link (Telegram Bot
 * Features → Managed Bots → "Sharing Your Management Bot"):
 *
 *   https://t.me/newbot/{manager_bot_username}/{new_username}?name={new_name}
 *
 * Opening it shows Telegram's NATIVE bot-creation window with the
 * @username + display name PRE-FILLED (editable). On confirmation the
 * MANAGER bot receives the SAME `managed_bot` update the reply-keyboard
 * `request_managed_bot` button produces — so this reuses the existing
 * provisioning ledger, creator binding, and `completeManagedBotProvisioning`
 * completion path with NO second lifecycle.
 *
 * Why it is a SAFE fallback (no weakened tenant isolation, no new binding
 * rule): the link is only ever shown as the Manager Bot's reply to a valid
 * `/start <token>`, which already bound the Admin's Telegram `user.id` to
 * the single-use ledger row. The link therefore needs NO FlowPilot state
 * parameter — the `managed_bot` event's creator `user.id` matches the
 * already-bound ledger row exactly as it does for the keyboard path, and
 * the Business still comes ONLY from that row. It is the smallest reliable
 * alternative to the `request_managed_bot` reply-keyboard button, whose
 * native-creation-UI launch is a Telegram CLIENT capability (older clients
 * render the button but do not open the creation window — a server-side
 * FlowPilot change cannot fix that; a plain t.me deep link is resolved by
 * the client's universally-supported deep-link handler instead).
 *
 * Escaping: the manager + new-bot usernames are Telegram usernames
 * (`[A-Za-z0-9_]`, `@` stripped), and the display name is percent-encoded
 * so an Arabic business name or a name with spaces is a valid query value.
 */
export function buildManagedBotCreationLink(
  managerBotUsername: string,
  suggestedUsername: string,
  suggestedName: string,
): string {
  const manager = managerBotUsername.replace(/^@/, "");
  const username = suggestedUsername.replace(/^@/, "");
  const name = encodeURIComponent(suggestedName);
  return `https://t.me/newbot/${manager}/${username}?name=${name}`;
}

/**
 * The Manager Bot's OWN webhook secret (DECISIONS #66). Telegram's
 * `X-Telegram-Bot-Api-Secret-Token` is the proof a delivery really came
 * from Telegram, and the Manager Bot has NO connection row to carry a
 * generated secret (it is FlowPilot-owned, token in env). So the secret
 * is DERIVED from the manager token with a fixed-label HMAC-SHA256
 * (hex — only [0-9a-f], always inside Telegram's 1–256 char limit):
 *
 *   - no new operator configuration and no persisted secret;
 *   - it is UNKNOWABLE without the manager token, so only FlowPilot (which
 *     holds the token) could have set the webhook — the same trust model
 *     as the per-connection secret, with env as the secret's home;
 *   - it rotates WITH the manager token (the one operator action that
 *     changes the manager bot), and `ensureManagerWebhook` re-applies it
 *     on the next provisioning launch.
 */
export const MANAGER_WEBHOOK_SECRET_LABEL =
  "flowpilot:telegram:manager-webhook";

export function deriveManagerWebhookSecret(managerToken: string): string {
  return createHmac("sha256", managerToken)
    .update(MANAGER_WEBHOOK_SECRET_LABEL, "utf8")
    .digest("hex");
}

/**
 * The Manager Bot's webhook URL — its OWN endpoint, separate from the
 * per-connection `/api/telegram/webhook` (which is routed by the
 * per-connection secret to a Business-owned connection). The Manager Bot
 * receives the `/start` deep-link payload AND the `managed_bot` event.
 */
export function buildManagerWebhookUrl(webhookBaseUrl: string): string {
  return `${webhookBaseUrl.replace(/\/$/, "")}/api/telegram/manager/webhook`;
}

/**
 * Ensure the Manager Bot's webhook points here with the derived secret
 * (idempotent — `setWebhook` is a configuration SET, so re-applying the
 * same value is a no-op at Telegram). Called at provisioning LAUNCH, so
 * the ONE-TIME operator setup needs no manual webhook configuration at
 * all: set `TELEGRAM_MANAGER_BOT_TOKEN`, and the first «اربط تيليجرام»
 * wires the manager webhook itself.
 *
 * `allowed_updates` is the approved MVP scope: the `message` updates that
 * carry `/start <token>` and the `managed_bot` provisioning event —
 * nothing else enters the manager endpoint.
 */
export async function ensureManagerWebhook(
  deps: Pick<TelegramProvisioningDeps, "api" | "getEnvVar" | "webhookBaseUrl">,
): Promise<{ ok: true } | { ok: false; code: ProvisioningResultCode }> {
  const managerToken = getManagerBotToken(deps.getEnvVar);
  if (!managerToken) return { ok: false, code: "MANAGER_BOT_NOT_CONFIGURED" };
  const result = await telegramSetWebhook(deps.api, managerToken, {
    url: buildManagerWebhookUrl(deps.webhookBaseUrl),
    secretToken: deriveManagerWebhookSecret(managerToken),
    allowedUpdates: [...TELEGRAM_MANAGER_ALLOWED_UPDATES],
  });
  if (!result.ok) {
    return {
      ok: false,
      code:
        result.error.code === "UNAUTHORIZED_CREDENTIALS"
          ? "MANAGER_BOT_NOT_CONFIGURED"
          : result.error.code === "TRANSIENT_TRANSPORT_FAILURE"
            ? "PROVIDER_UNREACHABLE"
            : "PROVISIONING_FAILED",
    };
  }
  return { ok: true };
}

/**
 * Suggest a bot @username for Telegram's native creation UI (a
 * non-binding hint the Admin can edit; the final username is Telegram's).
 * Telegram requires [A-Za-z0-9_], 4–32 chars, and it must be unique — so
 * a deterministic ASCII slug of the Business name is extended with a
 * short random tail whenever the name yields no usable prefix. Arabic
 * business names (the norm here) fall back to the `fp_` prefix.
 */
export function suggestBotUsername(
  businessName: string,
  randomSuffix: () => string = () =>
    crypto.randomUUID().replace(/-/g, "").slice(0, 6),
): string {
  const slug = businessName
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const base = slug.length >= 3 ? slug.slice(0, 24) : "fp";
  const candidate = `${base}_${randomSuffix()}`;
  return candidate.replace(/_{2,}/g, "_").slice(0, 32);
}

/**
 * Generate a fresh per-connection webhook secret. The PLAINTEXT is handed
 * to Telegram exactly once via `setWebhook`; only its non-reversible
 * SHA-256 digest is persisted (as the connection's routing index).
 */
export function generateWebhookSecret(): string {
  return (
    crypto.randomUUID().replace(/-/g, "") +
    crypto.randomUUID().replace(/-/g, "")
  );
}

/**
 * The Manager Bot's reply to `/start <token>`: the managed-bot keyboard
 * (DECISIONS #63 (B)) — the ONE customer action the model requires (the
 * bot's owner must approve creation in Telegram's own UI). The button's
 * `request_managed_bot` object carries ONLY the REQUIRED `request_id`
 * (a stable, per-attempt signed 32-bit identifier Telegram needs to
 * correlate the resulting `managed_bot` event back to this button tap);
 * FlowPilot does NOT prefill the bot's name/username into a Telegram API
 * field it cannot verify — the suggestion is carried in the reply TEXT
 * (the safe place for Arabic copy), and the Admin edits the final values
 * in Telegram. The id is derived from the ledger row so a replayed
 * attempt re-opens the same request, while a fresh attempt gets a fresh
 * id (Telegram requires uniqueness within the message only, but a stable
 * per-attempt value keeps redeliveries coherent).
 */
/**
 * The `request_id` Telegram requires on the `request_managed_bot` button
 * (Bot API: a signed 32-bit identifier, unique within the message). A
 * FIXED value is correct and safest here: the keyboard is the only
 * button in the only message this endpoint ever sends per attempt, so
 * uniqueness-within-the-message is trivially satisfied, and a constant
 * (rather than a random per-send value) keeps a legitimate replay of the
 * SAME attempt coherent — the keyboard the Admin re-opens after an
 * app restart or a redeploy carries the same request id as the one
 * their button tap already produced. It carries no security meaning: it
 * is a provider correlation key, not a FlowPilot secret (the auth is the
 * ledger's single-use `startToken` + creator binding).
 */
export const MANAGED_BOT_REQUEST_ID = 1;

export const MANAGED_BOT_KEYBOARD_TITLE = "إنشاء بوت المنشأة على تيليجرام";

export function buildManagedBotKeyboard(): {
  keyboard: Array<
    Array<{
      text: string;
      request_managed_bot: { request_id: number };
    }>
  >;
  resize_keyboard?: boolean;
  one_time_keyboard?: boolean;
} {
  return {
    keyboard: [
      [
        {
          text: MANAGED_BOT_KEYBOARD_TITLE,
          request_managed_bot: { request_id: MANAGED_BOT_REQUEST_ID },
        },
      ],
    ],
    resize_keyboard: true,
    one_time_keyboard: true,
  };
}

function fail<Code extends string>(
  code: Code,
  message: string,
): { ok: false; code: Code; message: string } {
  return { ok: false, code, message };
}

/**
 * Complete managed-bot provisioning from a `managed_bot` event — the
 * event boundary. Every failure is a typed, honest result; nothing is
 * invented and no half-provisioned connection is left behind on failure.
 *
 * Invariants (DECISIONS #63 (D)):
 * - CREATOR BINDING: the event's creator `user.id` must match an
 *   in-flight, unexpired ledger row's BOUND creator — a forged callback
 *   that never went through the deep link matches nothing and provisions
 *   nothing (cross-tenant forgery protection).
 * - SINGLE-USE: the ledger row is consumed exactly once (conditional
 *   update); a replay provisions nothing.
 * - TENANT ISOLATION: the Business comes ONLY from the ledger row, never
 *   from the event or any client input.
 * - ONE BOT / ONE BUSINESS: a managed bot already CONNECTED to ANOTHER
 *   Business is refused (the duplicate-attach guard); `@@unique` on
 *   (businessId, botExternalId) plus this check-then-create mirror the
 *   WhatsApp connection's duplicate protection. A DISCONNECTED row of
 *   the SAME Business is the RECONNECT path (DECISIONS #66): the Admin
 *   re-launched provisioning and picked the same bot again, so it is
 *   re-provisioned in place with a FRESH webhook secret and a NEW
 *   `fp:<id>` reference (the old reference's secret was deleted at
 *   disconnect — a stale credential is never resurrected).
 * - NO SECRET LEAKAGE: the bot token is stored ONLY as an `fp:<id>`
 *   RUNTIME reference; the plaintext crosses no boundary, no log, and no
 *   result.
 */
export async function completeManagedBotProvisioning(
  deps: TelegramProvisioningDeps,
  event: ParsedManagedBotEvent,
): Promise<ManagedBotProvisioningResult> {
  // 1. Resolve the in-flight attempt by its BOUND creator (the event
  //    carries no business and no token — the ledger is the authority).
  const ledger = await deps.ledgerRepository.findActiveByCreator(
    event.creatorTelegramUserId,
    deps.now(),
  );
  if (!ledger) {
    return fail(
      "NO_IN_FLIGHT_ATTEMPT",
      "لا توجد محاولة تفعيل نشطة مرتبطة بهذا المستخدم",
    );
  }

  /**
   * Terminate THIS attempt with a typed outcome and return the failure.
   * The ledger row is the UI's ONE state signal: without this write a
   * failed attempt stays IN FLIGHT forever (a permanent spinner), because
   * the polling surface derives its state from the row. Recording the
   * outcome makes the attempt terminal exactly once — `recordOutcome` is a
   * conditional write on the unique `startToken`, so a racing completion
   * cannot clobber another attempt, and a redelivered event then matches
   * no in-flight row (idempotent: it reports NO_IN_FLIGHT_ATTEMPT and
   * provisions nothing again). Best-effort by design: the write's own
   * failure never changes the provisioning result.
   */
  const terminate = async (
    code: ProvisioningResultCode,
    message: string,
  ): Promise<ManagedBotProvisioningResult> => {
    await deps.ledgerRepository.recordOutcome(
      ledger.startToken,
      code,
      deps.now(),
    );
    return fail(code, message);
  };

  // 2. Duplicate-attach guard: a managed bot cannot silently attach to
  //    another Business. A same-Business DISCONNECTED row is the
  //    reconnect-of-the-same-bot path (re-provisioned below); a
  //    same-Business CONNECTED row is already done.
  const existing = await deps.connectionRepository.findByExternalId(
    event.botExternalId,
  );
  if (existing && existing.businessId !== ledger.businessId) {
    return await terminate(
      "BOT_ATTACHED_TO_ANOTHER_BUSINESS",
      "هذا البوت مُفعّل بالفعل لمنشأة أخرى",
    );
  }
  const reconnect = Boolean(existing && !existing.isActive);
  if (existing && existing.businessId === ledger.businessId && !reconnect) {
    // Already CONNECTED: a re-delivered event, or a rotation of a live
    // bot. The unprompted owner-change security event is a later slice —
    // this boundary reports the honest state instead of re-provisioning.
    return await terminate(
      "BOT_ALREADY_PROVISIONED",
      "هذا البوت مُفعّل بالفعل لهذه المنشأة",
    );
  }

  // 3. Fetch the managed bot token via the MANAGER bot (the customer never
  //    sees it). Only a Manager Bot with Bot Management Mode can call it.
  const managerToken = getManagerBotToken(deps.getEnvVar);
  if (!managerToken) {
    return await terminate(
      "MANAGER_BOT_NOT_CONFIGURED",
      "لم يتم تكوين بوت الإدارة المركزي",
    );
  }
  const tokenResult = await telegramGetManagedBotToken(deps.api, {
    managerToken,
    // The `getManagedBotToken` request field is `user_id` — the managed
    // bot's own Telegram User.id, which the `managed_bot` event carries as
    // `bot.id` (parsed into `botExternalId`). NOT `managed_bot_id`.
    userId: event.botExternalId,
  });
  if (!tokenResult.ok) {
    return await terminate(
      tokenResult.error.code === "UNAUTHORIZED_CREDENTIALS"
        ? "MANAGER_BOT_NOT_CONFIGURED"
        : tokenResult.error.code === "TRANSIENT_TRANSPORT_FAILURE"
          ? "PROVIDER_UNREACHABLE"
          : "PROVISIONING_FAILED",
      tokenResult.error.message,
    );
  }
  // The Bot API returns the token as a BARE STRING (validated in the
  // client). It stays in the adapter — encrypted into an `fp:<id>`
  // reference below and never logged or returned.
  const botToken = tokenResult.result;

  // 4. Set the webhook with a FRESH per-connection secret (webhook, never
  //    polling — DECISIONS #63 (E)); private-chats text and inline button callback scope.
  const webhookSecret = generateWebhookSecret();
  const webhookUrl = `${deps.webhookBaseUrl.replace(/\/$/, "")}/api/telegram/webhook`;
  const webhookResult = await telegramSetWebhook(deps.api, botToken, {
    url: webhookUrl,
    secretToken: webhookSecret,
    allowedUpdates: [...TELEGRAM_CUSTOMER_ALLOWED_UPDATES],
  });
  if (!webhookResult.ok) {
    return await terminate(
      webhookResult.error.code === "TRANSIENT_TRANSPORT_FAILURE"
        ? "PROVIDER_UNREACHABLE"
        : "PROVISIONING_FAILED",
      webhookResult.error.message,
    );
  }

  // 5. Verify with `getMe`: the bot Telegram reports must be the bot the
  //    event named (defense in depth against a swapped id).
  const meResult = await telegramGetMe(deps.api, botToken);
  if (!meResult.ok) {
    return await terminate(
      meResult.error.code === "TRANSIENT_TRANSPORT_FAILURE"
        ? "PROVIDER_UNREACHABLE"
        : "PROVISIONING_FAILED",
      meResult.error.message,
    );
  }
  if (String(meResult.result.id) !== event.botExternalId) {
    return await terminate(
      "PROVISIONING_FAILED",
      "هوية البوت المُتحقَّق منها لا تطابق الحدث",
    );
  }
  // The bot's display name (`first_name`) — provider-reported, NON-SECRET,
  // and already fetched by the identity check above (no extra API call). It
  // is what the CONNECTED settings surface shows next to the @username, so
  // the Admin sees a human label for the live bot.
  const botDisplayName =
    typeof meResult.result.first_name === "string" &&
    meResult.result.first_name.trim().length > 0
      ? meResult.result.first_name.trim()
      : null;

  // 6. Store the bot token ONLY as an opaque `fp:<id>` RUNTIME reference
  //    (DECISIONS #49). The plaintext is encrypted application-side and
  //    never read back outside the adapter.
  const credentialsRef = mintRuntimeCredentialReference();
  const stored = await deps.credentialStore.store({
    businessId: ledger.businessId,
    reference: credentialsRef,
    secret: botToken,
  });
  if (!stored.ok) {
    return await terminate(
      stored.code === "REFERENCE_COLLISION"
        ? "PROVISIONING_FAILED"
        : "CREDENTIAL_STORE_UNAVAILABLE",
      stored.message,
    );
  }

  // 7. Consume the ledger attempt EXACTLY ONCE (single-use; the creator
  //    binding is re-checked inside the conditional update). Consuming
  //    AFTER the provider calls means a provider failure leaves an
  //    unconsumed, retryable attempt and NO connection row — nothing
  //    half-provisioned.
  const consumed = await deps.ledgerRepository.consume(
    ledger.startToken,
    event.creatorTelegramUserId,
    deps.now(),
  );
  if (!consumed) {
    // A concurrent completion already consumed it (or it expired in the
    // window). Nothing to provision here — the other attempt owns it.
    return await terminate(
      "ATTEMPT_EXPIRED",
      "انتهت صلاحية محاولة التفعيل أو استُهلكت بالفعل",
    );
  }

  // 8. Persist the connection — CONNECTED, provenance recorded. The
  //    onboarding lifecycle is flipped to READY through the ONLY guarded
  //    write path (`markOnboardingReady`), exactly like the WhatsApp
  //    connection's two-surface model. A reconnect rewrites the SAME
  //    Business's DISCONNECTED row in place (the `@@unique` key is
  //    unchanged); a first-time provisioning creates it.
  let connection;
  try {
    connection = reconnect
      ? await deps.connectionRepository.update(
          existing!.id,
          ledger.businessId,
          {
            ...(event.botUsername ? { botUsername: event.botUsername } : {}),
            ...(botDisplayName ? { displayName: botDisplayName } : {}),
            status: "CONNECTED",
            credentialsRef,
            credentialKind: "RUNTIME",
            webhookSecretHash: hashTelegramWebhookSecret(webhookSecret),
            isActive: true,
            onboardingState: "PROVISIONING",
            onboardingActor: "TELEGRAM",
            onboardingReasonCode: null,
            onboardingReasonSummary: null,
            onboardingRetryable: null,
            ...(deps.managerBotId ? { managerBotId: deps.managerBotId } : {}),
            creatorTelegramUserId: event.creatorTelegramUserId,
          },
        )
      : await deps.connectionRepository.create({
          businessId: ledger.businessId,
          botExternalId: event.botExternalId,
          ...(event.botUsername ? { botUsername: event.botUsername } : {}),
          ...(botDisplayName ? { displayName: botDisplayName } : {}),
          provider: TELEGRAM_PROVIDER,
          status: "CONNECTED",
          credentialsRef,
          credentialKind: "RUNTIME",
          webhookSecretHash: hashTelegramWebhookSecret(webhookSecret),
          isActive: true,
          onboardingState: "PROVISIONING",
          onboardingActor: "TELEGRAM",
          ...(deps.managerBotId ? { managerBotId: deps.managerBotId } : {}),
          creatorTelegramUserId: event.creatorTelegramUserId,
        });
  } catch (error) {
    // The token is already stored under `credentialsRef`; the next
    // attempt re-provisions (the reference is the indirection). Surface
    // the typed failure honestly.
    return await terminate(
      "PROVISIONING_FAILED",
      error instanceof Error ? error.message : "فشل حفظ اتصال تيليجرام",
    );
  }
  if (!connection) {
    // The conditional update matched no row (a concurrent disconnect won
    // the race). Nothing half-provisioned; the attempt is already
    // consumed, so the Admin re-launches from the settings surface.
    return await terminate(
      "PROVISIONING_FAILED",
      "تعذر حفظ اتصال تيليجرام — ابدأ المحاولة من جديد",
    );
  }

  await deps.ledgerRepository.recordOutcome(
    ledger.startToken,
    "PROVISIONED",
    deps.now(),
  );
  await deps.ledgerRepository.recordConnectionId(
    ledger.startToken,
    connection.id,
  );

  // The onboarding lifecycle flips to READY through the ONLY guarded
  // write path (`markOnboardingReady`), exactly like the WhatsApp
  // connection's two-surface model. A failure here cannot un-provision
  // the bot (it is already CONNECTED and operational), so it is not
  // reported as a provisioning failure.
  await deps.connectionRepository.markOnboardingReady(
    connection.id,
    ledger.businessId,
  );

  return {
    ok: true,
    connectionId: connection.id,
    businessId: ledger.businessId,
    botExternalId: event.botExternalId,
  };
}

// ─── DISCONNECT (DECISIONS #66 — the supported lifecycle) ───────────────────

export type TelegramDisconnectionResult =
  | {
      ok: true;
      connectionId: string;
      businessId: string;
      botExternalId: string;
      /** A cleanup step at Telegram or the credential store did not
       *  confirm; the connection is STILL disconnected locally. */
      cleanupWarning: string | null;
    }
  | {
      ok: false;
      code: "NOT_FOUND" | "NOT_CONNECTED" | "DISCONNECT_FAILED";
      message: string;
    };
export type DisconnectionResultCode = TelegramDisconnectionResult extends {
  ok: false;
  code: infer Code;
}
  ? Code
  : never;

/**
 * Disconnect a Business's connected managed bot (DECISIONS #66):
 *
 *   `deleteWebhook` (stop Telegram deliveries) → disconnect the
 *   connection (DISCONNECTED + inactive, retained for provenance) →
 *   DELETE the runtime credential reference (a stale secret is never
 *   left behind, and reconnect mints a FRESH `fp:<id>`).
 *
 * Tenancy: the connection is resolved WITHIN the caller's Business, so a
 * foreign connection is "not found" — no cross-tenant existence leak
 * (the same rule as the outbound transport). Only an operationally
 * CONNECTED + active connection can be disconnected.
 *
 * Failure model (honest, and never leaves the bot half-disconnected):
 * the LOCAL disconnect is authoritative — a Telegram-side `deleteWebhook`
 * failure is reported as a non-fatal `cleanupWarning`, because an
 * inbound delivery to a disconnected connection is already refused by
 * the routing layer (`isActive`). The credential deletion is likewise
 * best-effort: a leftover encrypted row is unreferenced by any active
 * connection, and the warning tells the operator to re-run the
 * disconnect.
 */
export async function disconnectManagedBotConnection(
  deps: Pick<
    TelegramProvisioningDeps,
    "api" | "connectionRepository" | "credentialStore" | "now"
  >,
  params: { connectionId: string; businessId: string },
): Promise<TelegramDisconnectionResult> {
  const connection = await deps.connectionRepository.findByIdWithinBusiness(
    params.connectionId,
    params.businessId,
  );
  if (!connection) {
    return fail("NOT_FOUND", "تعذر العثور على اتصال تيليجرام لهذه المنشأة");
  }
  if (!connection.isActive || connection.status !== "CONNECTED") {
    return fail(
      "NOT_CONNECTED",
      "الاتصال غير موصول حالياً — ابدأ تفعيلاً جديداً",
    );
  }

  let cleanupWarning: string | null = null;

  // 1. Stop Telegram deliveries. The token is resolved from the
  //    connection's `fp:<id>` reference and stays in the adapter.
  if (connection.credentialsRef) {
    const tokenResolution = await resolveTelegramBotToken(
      deps.api,
      connection.credentialsRef,
    );
    if (tokenResolution.ok) {
      const removed = await telegramDeleteWebhook(
        deps.api,
        tokenResolution.token,
      );
      if (!removed.ok) {
        cleanupWarning = "تعذر إزالة الويبهوك من جانب تيليجرام";
      }
    } else {
      cleanupWarning = "تعذر الوصول إلى بيانات اعتماد البوت لإزالة الويبهوك";
    }
  }

  // 2. The LOCAL disconnect (the authoritative step): DISCONNECTED +
  //    inactive, retained for provenance + the UI's honest state.
  const disconnected = await deps.connectionRepository.disconnect(
    params.connectionId,
    params.businessId,
  );
  if (!disconnected) {
    return fail(
      "DISCONNECT_FAILED",
      "تعذر فصل اتصال تيليجرام الآن — حاول مرة أخرى",
    );
  }

  // 3. Remove the runtime credential (the reference dies with it; a
  //    reconnect mints a fresh one under a new `fp:<id>`).
  if (connection.credentialsRef) {
    const deleted = await deps.credentialStore.delete(
      connection.credentialsRef,
    );
    if (!deleted.ok && cleanupWarning === null) {
      cleanupWarning = "تعذر إزالة مرجع بيانات الاعتماد";
    }
  }

  return {
    ok: true,
    connectionId: disconnected.id,
    businessId: params.businessId,
    botExternalId: disconnected.botExternalId,
    cleanupWarning,
  };
}
