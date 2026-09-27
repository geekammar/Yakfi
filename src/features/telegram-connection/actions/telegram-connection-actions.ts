"use server";

import {
  beginTelegramProvisioning,
  disconnectTelegramConnection,
  getTelegramConnectionStatus,
  resolveManagerBotUsername,
  type TelegramConnectionActor,
  type TelegramConnectionServiceDeps,
} from "@/features/telegram-connection/server/telegram-connection-service";
import type {
  BeginTelegramProvisioningResult,
  TelegramConnectionReadResult,
  TelegramDisconnectionResult,
} from "@/features/telegram-connection/types";
import { env } from "@/lib/env";
import { requireUser } from "@/server/auth/guards";
import { defaultRuntimeCredentialStore } from "@/server/credentials/runtime-credential-store";
import { defaultTelegramApiDeps } from "@/server/integrations/telegram/telegram-client";
import {
  businessRepository,
  telegramConnectionRepository,
  telegramProvisioningLedgerRepository,
  userRepository,
} from "@/server/repositories";

import { revalidatePath } from "next/cache";

/**
 * Server-side authorization context derived from the authenticated
 * session + the database-backed user record. The Business is ALWAYS
 * derived server-side — a client-provided businessId can never override
 * it (the service layer re-checks role + scope on every operation).
 */
async function currentActor(): Promise<TelegramConnectionActor> {
  const session = await requireUser();
  const user = await userRepository.findById(session.user.id);
  return {
    userId: session.user.id,
    // No user record (deleted mid-session) → least privilege: STAFF with
    // no Business can never start a Telegram provisioning.
    role: user?.role ?? "STAFF",
    businessId: user?.businessId ?? null,
  };
}

/**
 * Production dependencies — every one an app singleton; the Telegram HTTP
 * boundary stays in the adapter family. `managerBotUsername` is the
 * manager bot's PUBLIC @username (non-secret); the token is an env secret
 * read only inside the adapter.
 */
function deps(): TelegramConnectionServiceDeps {
  return {
    api: defaultTelegramApiDeps,
    ledgerRepository: telegramProvisioningLedgerRepository,
    connectionRepository: telegramConnectionRepository,
    credentialStore: defaultRuntimeCredentialStore,
    businessRepository,
    getEnvVar: (name: string) => process.env[name],
    webhookBaseUrl: env.NEXT_PUBLIC_APP_URL,
    managerBotUsername: resolveManagerBotUsername((name) => process.env[name]),
    now: () => new Date(),
  };
}

function revalidateTelegramSurfaces() {
  revalidatePath("/settings/telegram");
  revalidatePath("/settings");
}

/** The ONE UI state machine — the honest polling surface (ADMIN only). */
export async function getTelegramConnectionStatusAction(): Promise<TelegramConnectionReadResult> {
  return getTelegramConnectionStatus(deps(), await currentActor());
}

/**
 * Launch a single-use managed-bot provisioning attempt for the actor's own
 * Business (ADMIN only). Only safe, non-secret information crosses to the
 * browser: the deep link (whose ONLY payload is the opaque token) + the
 * attempt's expiry. Never a bot token, never a technical identifier.
 */
export async function beginTelegramProvisioningAction(): Promise<BeginTelegramProvisioningResult> {
  const result = await beginTelegramProvisioning(deps(), await currentActor());
  revalidateTelegramSurfaces();
  return result;
}

/**
 * Disconnect the actor's connected managed bot (ADMIN only): the webhook
 * is removed at Telegram, the connection is DISCONNECTED + inactive, and
 * the runtime credential reference is deleted. Never accepts a connection
 * id from the client.
 */
export async function disconnectTelegramConnectionAction(): Promise<TelegramDisconnectionResult> {
  const result = await disconnectTelegramConnection(
    deps(),
    await currentActor(),
  );
  revalidateTelegramSurfaces();
  return result;
}
