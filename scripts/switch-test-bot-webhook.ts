#!/usr/bin/env node
/**
 * FlowPilot — Guarded Customer Bot Webhook Switch & Restoration Runner.
 *
 * Implements strict target validation, fixed-target isolation, and safe output hygiene:
 * - Uses structured validateDatabaseUrl from test-bot-recovery.ts for test switches.
 * - Uses separate destination validation for production restorations.
 * - Fixed target constants: Business ID, Connection ID, Bot ID, Expected URLs.
 * - Emits strictly whitelisted metadata; never discloses secrets, raw errors, tokens, DB URLs, or bodies.
 */
import { fileURLToPath } from "node:url";

import { isRuntimeCredentialReference } from "../src/lib/validation";
import type { CredentialsResolver } from "../src/server/credentials/credentials-resolver";
import {
  RecoveryError,
  validateDatabaseUrl,
} from "../src/server/credentials/test-bot-recovery";
import type {
  SwitchTelegramWebhookOutcome,
  SwitchTelegramWebhookParams,
} from "../src/server/integrations/telegram/telegram-repair";

export const FIXED_TARGETS = {
  businessId: "f5314115-ae8c-46ea-9d7e-080ef5e7366d",
  connectionId: "1d2cdf87-2bee-4f26-aad5-5ab9efd1c716",
  botExternalId: "8926541123",
  botUsername: "Drafnanafnanbot",
  mainWebhookUrl: "https://flowpilot-prod.vercel.app/api/telegram/webhook",
  previewWebhookUrl:
    "https://flowpilot-prod-git-fix-safe-telegram-staff-reply-36d980-ammarj1.vercel.app/api/telegram/webhook",
} as const;

export const ALLOWED_OPERATIONS = [
  "switch-webhook-dry-run",
  "switch-webhook-apply",
  "restore-main-webhook-preflight",
  "restore-main-webhook-reconcile",
  "restore-main-webhook-dry-run",
  "restore-main-webhook-apply",
] as const;

export type SwitchOperation = (typeof ALLOWED_OPERATIONS)[number];

export function validateProductionDatabaseUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RecoveryError("INVALID_DATABASE_URL");
  }
  const productionHosts = [
    "ep-tiny-grass-a5e63jev.us-east-2.aws.neon.tech",
    "ep-tiny-grass-a5e63jev-pooler.us-east-2.aws.neon.tech",
  ];
  if (!productionHosts.includes(url.hostname) || url.pathname !== "/neondb") {
    throw new RecoveryError("PRODUCTION_DATABASE_TARGET_NOT_AUTHORIZED");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new RecoveryError("DATABASE_PROTOCOL_NOT_AUTHORIZED");
  }
  if (url.port && url.port !== "5432") {
    throw new RecoveryError("DATABASE_PORT_NOT_AUTHORIZED");
  }
  if (url.hash) {
    throw new RecoveryError("DATABASE_HASH_NOT_AUTHORIZED");
  }
  for (const [name, value] of url.searchParams) {
    if (!(
      (name === "sslmode" && ["require", "verify-full"].includes(value)) ||
      (name === "channel_binding" && value === "require")
    )) {
      throw new RecoveryError("DATABASE_OPTIONS_NOT_AUTHORIZED");
    }
  }
  if (!url.searchParams.has("sslmode")) {
    throw new RecoveryError("DATABASE_TLS_REQUIRED");
  }
}

export type SwitchRunnerDeps = {
  validateTestDbUrl?: (url: string) => void;
  validateProdDbUrl?: (url: string) => void;
  switchFn?: (
    params: SwitchTelegramWebhookParams,
    credentialsResolver?: Pick<CredentialsResolver, "resolve">,
  ) => Promise<SwitchTelegramWebhookOutcome>;
  out?: {
    log: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
};

/** Explicit operator credential for this fixed-bot maintenance job only.
 * This neither decrypts nor replaces the application's stored credentials.
 * Live getMe + the operator-pinned bot ID remain mandatory in the switch service.
 */
export function createOwnerRestoreResolver(
  token: string,
): Pick<CredentialsResolver, "resolve"> {
  return {
    async resolve(reference) {
      if (!isRuntimeCredentialReference(reference)) {
        return {
          ok: false,
          code: "UNRESOLVED_REFERENCE",
          message: "Runtime reference required",
        };
      }
      return { ok: true, kind: "RUNTIME", reference, value: token };
    },
  };
}

export async function executeGuardedSwitch(
  env: {
    DATABASE_URL?: string;
    CREDENTIAL_MASTER_KEY?: string;
    OPERATION?: string;
    [key: string]: string | undefined;
  },
  deps: SwitchRunnerDeps = {},
): Promise<{ ok: boolean; code?: string; status?: string }> {
  const out = deps.out ?? { log: console.log, error: console.error };
  const validateTestDb = deps.validateTestDbUrl ?? validateDatabaseUrl;
  const validateProdDb =
    deps.validateProdDbUrl ?? validateProductionDatabaseUrl;

  const operation = (env.OPERATION ?? "").trim();
  if (
    !ALLOWED_OPERATIONS.includes(
      operation as (typeof ALLOWED_OPERATIONS)[number],
    )
  ) {
    out.error(
      "❌ Preflight Refused: [UNKNOWN_OPERATION] Operation is not recognized.",
    );
    return { ok: false, code: "UNKNOWN_OPERATION" };
  }

  const databaseUrl = (env.DATABASE_URL ?? "").trim();
  if (!databaseUrl) {
    out.error(
      "❌ Preflight Refused: [MISSING_DATABASE_URL] Required database secret is unavailable.",
    );
    return { ok: false, code: "MISSING_DATABASE_URL" };
  }

  const isRestore = operation.startsWith("restore-main-webhook-");
  const isReconcile = operation === "restore-main-webhook-reconcile";
  const isApply = operation.endsWith("-apply") || isReconcile;
  const isRestorePreflight = operation === "restore-main-webhook-preflight";
  const masterKey = (env.CREDENTIAL_MASTER_KEY ?? "").trim();
  const restoreToken = (env.RESTORE_BOT_TOKEN ?? "").trim();
  if (isRestore ? !restoreToken : !masterKey) {
    const code = isRestore
      ? "MISSING_RESTORE_BOT_TOKEN"
      : "MISSING_CREDENTIAL_MASTER_KEY";
    out.error(
      `❌ Preflight Refused: [${code}] Required maintenance credential is unavailable.`,
    );
    return { ok: false, code };
  }

  try {
    if (isRestore) {
      validateProdDb(databaseUrl);
    } else {
      validateTestDb(databaseUrl);
    }
  } catch (err: unknown) {
    const code =
      err instanceof RecoveryError ? err.code : "DATABASE_VALIDATION_FAILED";
    out.error(
      `❌ Preflight Refused: [${code}] Database target validation failed.`,
    );
    return { ok: false, code };
  }

  process.env.DATABASE_URL = databaseUrl;
  if (!isRestore) process.env.CREDENTIAL_MASTER_KEY = masterKey;

  const expectedCurrentUrl =
    isRestore && !isRestorePreflight && !isReconcile
      ? FIXED_TARGETS.previewWebhookUrl
      : FIXED_TARGETS.mainWebhookUrl;

  const destinationUrl = isRestore
    ? FIXED_TARGETS.mainWebhookUrl
    : FIXED_TARGETS.previewWebhookUrl;

  const modeLabel = isApply ? "APPLY (explicit switch)" : "DRY RUN (read-only)";
  const actionLabel = isRestore
    ? "Production Restoration"
    : "Preview Webhook Switch";

  out.log(`[FlowPilot] Telegram ${actionLabel}: mode=${modeLabel}`);
  out.log(
    `Target: businessId=${FIXED_TARGETS.businessId}, connectionId=${FIXED_TARGETS.connectionId}`,
  );
  out.log(`Expected Current URL: ${expectedCurrentUrl}`);
  out.log(`Destination URL:      ${destinationUrl}`);
  out.log(
    `Credential source:    ${isRestore ? "owner-provided fixed-bot maintenance token; stored credential unchanged" : "application runtime credential"}`,
  );

  const restorationGuidance =
    "Reviewed workflow: restore-main-webhook-dry-run then restore-main-webhook-apply against Production when the current URL is Preview. Use the exact reviewed SHA.";
  const reconciliationGuidance =
    "If Telegram is already on main but its database hash is unconfirmed, use reviewed restore-main-webhook-reconcile against Production. Inspect partial failure first; never retry blindly.";

  try {
    let switchImpl = deps.switchFn;
    if (!switchImpl) {
      const { switchTelegramBotWebhookDefault } =
        await import("../src/server/integrations/telegram/telegram-repair");
      switchImpl = switchTelegramBotWebhookDefault;
    }

    const outcome = await switchImpl(
      {
        businessId: FIXED_TARGETS.businessId,
        connectionId: FIXED_TARGETS.connectionId,
        expectedBotExternalId: FIXED_TARGETS.botExternalId,
        expectedCurrentUrl,
        destinationUrl,
        apply: isApply,
      },
      isRestore ? createOwnerRestoreResolver(restoreToken) : undefined,
    );

    if (!outcome.ok) {
      if (outcome.status === "PARTIAL_FAILURE") {
        out.error("\n⚠️  PARTIAL FAILURE / RECOVERY REQUIRED");
        out.error(`[${outcome.code}] ${outcome.message}`);
        if (outcome.remoteStateMayHaveChanged) {
          out.error(
            "Note: Telegram remote state may have changed while local database confirmation was not obtained.",
          );
        }
        if (outcome.reconciliationCommand) {
          out.error("\nReconciliation Command:");
          out.error(`  ${reconciliationGuidance}`);
        }
        if (outcome.restorationProcedure) {
          out.error("\nRestoration Procedure (revert switch):");
          out.error(`  ${restorationGuidance}\n`);
        }
        return {
          ok: false,
          code: outcome.code,
          status: outcome.status,
        };
      }

      out.error(
        `\n❌ Switch Refused / Failed: [${outcome.code}] ${outcome.message}`,
      );
      if (outcome.restorationProcedure) {
        out.error("\nRestoration Procedure:");
        out.error(`  ${restorationGuidance}\n`);
      }
      return { ok: false, code: outcome.code };
    }

    // Whitelisted safe output projection
    out.log("\n================ Webhook Switch Result ================");
    const status = isRestorePreflight
      ? "RESTORE_PREFLIGHT_READY"
      : outcome.status;
    out.log(`Status:              ${status}`);
    out.log(
      `Mode:                ${outcome.dryRun ? "DRY RUN (no changes made)" : "APPLIED (switched)"}`,
    );
    out.log(`Bot External ID:     ${outcome.botExternalId}`);
    out.log(`Bot Username:        @${outcome.botUsername ?? "unknown"}`);

    if (outcome.status === "SWITCH_DRY_RUN") {
      out.log(`Current URL:         ${outcome.currentWebhookUrl}`);
      out.log(`Destination URL:     ${outcome.destinationWebhookUrl}`);
      out.log(`Target Updates:      ${JSON.stringify(outcome.allowedUpdates)}`);
      out.log(`Pending Updates:     ${outcome.pendingUpdateCount}`);
      out.log(
        `Message:             ${isRestorePreflight ? "Owner token and main registration verified; zero changes. Stored encryption key has not been recovered." : outcome.message}`,
      );
      if (!isRestorePreflight) {
        out.log("\nReviewed Restoration Procedure:");
        out.log(`  ${restorationGuidance}`);
        out.log(`  ${reconciliationGuidance}`);
      }
    } else if (outcome.status === "SWITCHED") {
      out.log(`Previous URL:        ${outcome.previousWebhookUrl}`);
      out.log(`New Webhook URL:     ${outcome.webhookUrl}`);
      out.log(`Allowed Updates:     ${JSON.stringify(outcome.allowedUpdates)}`);
      out.log(`Pending Updates:     ${outcome.pendingUpdateCount}`);
      out.log(
        "Webhook Secret Hash: Persisted & verified in destination database",
      );
      out.log(`Verified At:         ${outcome.verifiedAt}`);
      out.log("\nRestoration Procedure (revert switch):");
      out.log(`  ${restorationGuidance}\n  ${reconciliationGuidance}\n`);
    }
    out.log("=======================================================\n");

    return { ok: true, status };
  } catch {
    // Strict output boundary: NEVER print raw error message, stack trace, tokens, or URLs
    out.error(
      "\n❌ Switch Refused / Failed: [UNEXPECTED_SWITCH_FAILURE] Operation failed without disclosing raw error or secrets.",
    );
    return { ok: false, code: "UNEXPECTED_SWITCH_FAILURE" };
  }
}

async function main() {
  const result = await executeGuardedSwitch(process.env);
  if (!result.ok) {
    process.exit(1);
  }
}

const isDirectExecution =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectExecution) {
  void main();
}
