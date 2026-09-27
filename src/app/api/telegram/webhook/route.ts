import {
  defaultConversationEngineDeps,
  receiveInboundMessage,
} from "@/features/conversations/server/conversation-engine";
import { env } from "@/lib/env";
import { defaultRuntimeCredentialStore } from "@/server/credentials/runtime-credential-store";
import { defaultTelegramApiDeps } from "@/server/integrations/telegram/telegram-client";
import {
  completeManagedBotProvisioning,
  type TelegramProvisioningDeps,
} from "@/server/integrations/telegram/telegram-provisioning";
import { createTelegramMessageTransport } from "@/server/integrations/telegram/telegram-transport";
import { handleTelegramWebhook } from "@/server/integrations/telegram/telegram-webhook-handler";
import {
  telegramConnectionRepository,
  telegramProvisioningLedgerRepository,
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
 *
 * Security + routing model (see `telegram-webhook-handler.ts`):
 * - The `X-Telegram-Bot-Api-Secret-Token` header IS the proof of
 *   authenticity (no Meta-style GET handshake). Its SHA-256 digest resolves
 *   EXACTLY ONE Business-owned connection server-side, and the digest
 *   comparison is constant-time. An invalid or unknown secret gets 401
 *   BEFORE any parsing or processing.
 * - Tenant selection NEVER comes from the payload: the Business is the
 *   resolved connection row's `businessId` (server-derived), and the
 *   classified update carries no identity keys at all (`strict()` envelope).
 * - `update_id` is the inbound external key, so the EXISTING durable dedupe
 *   ledger makes redeliveries idempotent with zero change.
 * - Webhook delivery, never polling (incompatible with the Vercel-only
 *   infrastructure constraint).
 *
 * MVP scope (approved): private chats, text only. Non-private chats are
 * routed away; non-text messages follow the EXISTING approved unsupported
 * contract (dropped). No behavior is invented for either — the
 * drop-vs-persist-and-defer decision for non-text stays an open, flagged
 * decision (DECISIONS #63 (F)).
 *
 * The provider adapter owns its outbound transport (exactly like the Meta
 * route): the Telegram route supplies the Telegram-backed `MessageTransport`
 * (live `sendMessage`) to the canonical engine. The engine's own default
 * stays offline, so no non-Telegram entry point gains a live Telegram
 * sender.
 */
const telegramEngineDeps = {
  ...defaultConversationEngineDeps,
  transport: createTelegramMessageTransport(),
};

/**
 * The provisioning boundary deps for this endpoint — every one of them an
 * app singleton; none is a Telegram HTTP concern.
 * `TELEGRAM_MANAGER_BOT_TOKEN` is an env secret read ONLY for the
 * manager-bot `getManagedBotToken` call.
 */
const provisioningDeps: TelegramProvisioningDeps = {
  api: defaultTelegramApiDeps,
  ledgerRepository: telegramProvisioningLedgerRepository,
  connectionRepository: telegramConnectionRepository,
  credentialStore: defaultRuntimeCredentialStore,
  getEnvVar: (name: string) => process.env[name],
  webhookBaseUrl: env.NEXT_PUBLIC_APP_URL,
  now: () => new Date(),
};

export async function POST(request: Request): Promise<Response> {
  return handleTelegramWebhook(
    {
      connectionRepository: telegramConnectionRepository,
      async processInboundMessage({ engineInput, identity }) {
        await receiveInboundMessage(telegramEngineDeps, engineInput, identity);
        // The operator surfaces (conversations inbox, dashboard, staff
        // workspace) refresh after the turn persists the inbound message.
        revalidatePath("/conversations");
        revalidatePath("/");
        revalidatePath("/staff");
        return { ok: true };
      },
      async completeManagedBotProvisioning({ event }) {
        try {
          const result = await completeManagedBotProvisioning(
            provisioningDeps,
            event,
          );
          if (result.ok) {
            revalidatePath("/settings/telegram");
            revalidatePath("/settings");
            return { ok: true };
          }
          return { ok: false, code: result.code };
        } catch {
          // A provisioning failure must never crash the webhook; the
          // event is acknowledged and the ledger carries the outcome.
          return { ok: false, code: "PROVISIONING_FAILED" };
        }
      },
      schedule: (work) => {
        // Next 16 `after` — the turn runs after the 200 is flushed, backed
        // by `waitUntil` on Vercel (Telegram retries on non-2xx then
        // gives up; the durable dedupe ledger keeps a redelivery
        // idempotent).
        after(() => work());
      },
    },
    request,
  );
}
