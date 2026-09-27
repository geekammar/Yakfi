import { env } from "@/lib/env";
import { defaultRuntimeCredentialStore } from "@/server/credentials/runtime-credential-store";
import {
  defaultTelegramApiDeps,
  getManagerBotToken,
  telegramGetMe,
} from "@/server/integrations/telegram/telegram-client";
import { handleTelegramManagerWebhook } from "@/server/integrations/telegram/telegram-manager-webhook-handler";
import {
  businessRepository,
  telegramConnectionRepository,
  telegramProvisioningLedgerRepository,
} from "@/server/repositories";

export const dynamic = "force-dynamic";

/**
 * The MANAGER BOT webhook (DECISIONS #63 (B)/(D), #66 — slice TELEGRAM 03).
 *
 * Telegram delivers the managed-bot provisioning updates HERE — to the
 * MANAGING bot (Bot Management Mode), never to the managed business bot:
 *
 *   - the Admin's `/start <opaque-single-use-token>` message → the creator
 *     is bound to the in-flight provisioning ledger + the
 *     `request_managed_bot` keyboard is handed back;
 *   - the `managed_bot` event → provisioning completes server-side (token
 *     via the manager bot → `fp:<id>` RUNTIME reference → `setWebhook` with
 *     a fresh per-connection secret → `getMe` → CONNECTED).
 *
 * The route is the thin composition point ONLY: it wires the production
 * singletons and delegates the whole POST logic to the deps-injected
 * handler, so the security path (constant-time secret verification before
 * any parsing, Business resolved only from the single-use ledger) is
 * assertable offline with no DB, no network, and no real credentials.
 *
 * The webhook itself is configured by `ensureManagerWebhook` at
 * provisioning launch — the operator never configures a webhook manually
 * (the ONE-TIME setup is: create the Manager Bot via @BotFather, enable
 * Bot Management Mode, set `TELEGRAM_MANAGER_BOT_TOKEN`).
 */

/**
 * The manager bot's own Telegram id — OPTIONAL provenance recorded on each
 * provisioned connection (so a future `ManagedBotUpdated` owner event can
 * be correlated to its provisioning bot). Resolved once per process via
 * `getMe` and memoized (the value is constant for the configured manager
 * bot); a failure resolves `undefined` and NEVER blocks provisioning —
 * provenance is not correctness.
 */
let managerBotIdMemo: string | null | undefined = undefined;
async function resolveManagerBotId(): Promise<string | undefined> {
  if (managerBotIdMemo !== undefined) return managerBotIdMemo ?? undefined;
  const managerToken = getManagerBotToken((name) => process.env[name]);
  if (!managerToken) {
    managerBotIdMemo = null;
    return undefined;
  }
  const me = await telegramGetMe(defaultTelegramApiDeps, managerToken);
  managerBotIdMemo = me.ok ? String(me.result.id) : null;
  return managerBotIdMemo ?? undefined;
}

const handlerDeps = {
  api: defaultTelegramApiDeps,
  ledgerRepository: telegramProvisioningLedgerRepository,
  connectionRepository: telegramConnectionRepository,
  credentialStore: defaultRuntimeCredentialStore,
  businessRepository,
  getEnvVar: (name: string) => process.env[name],
  webhookBaseUrl: env.NEXT_PUBLIC_APP_URL,
  now: () => new Date(),
};

export async function POST(request: Request): Promise<Response> {
  return handleTelegramManagerWebhook(
    { ...handlerDeps, managerBotId: await resolveManagerBotId() },
    request,
  );
}
