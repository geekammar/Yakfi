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
  oldPreviewOrigin:
    "https://flowpilot-prod-git-fix-safe-telegram-staff-reply-36d980-ammarj1.vercel.app",
  oldPreviewCommitSha: "1a11f35bf53b11f1ebb5da364b4205524353cf1c",
  oldPreviewVersion: "0.79.8",
  integratedPreviewOrigin:
    "https://flowpilot-prod-git-integration-staff-delivery-kn-d54181-ammarj1.vercel.app",
  integratedPreviewWebhookUrl:
    "https://flowpilot-prod-git-integration-staff-delivery-kn-d54181-ammarj1.vercel.app/api/telegram/webhook",
  integratedPreviewVersion: "0.79.10",
} as const;

export const ALLOWED_OPERATIONS = [
  "switch-webhook-dry-run",
  "switch-webhook-apply",
  "restore-main-webhook-preflight",
  "restore-main-webhook-reconcile",
  "restore-main-webhook-dry-run",
  "restore-main-webhook-apply",
  "transfer-integration-preview-dry-run",
  "transfer-integration-preview-apply",
  "return-old-preview-dry-run",
  "return-old-preview-apply",
  "cutover-main-runtime-dry-run",
  "cutover-main-runtime-apply",
] as const;

export const CUTOVER_CURRENT_KINDS = [
  "integrated-preview",
  "old-preview",
  "main",
] as const;

export type CutoverCurrentKind = (typeof CUTOVER_CURRENT_KINDS)[number];

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

export type PreviewDestinationKind = "old-preview" | "integrated-preview";

export type PreviewDestinationReadiness =
  | {
      ok: true;
      kind: PreviewDestinationKind;
      origin: string;
      version: string;
      commitSha: string;
      dbHost: string;
    }
  | {
      ok: false;
      code:
        | "MISSING_EXPECTED_COMMIT_SHA"
        | "DESTINATION_HEALTH_UNAVAILABLE"
        | "DESTINATION_NOT_READY"
        | "DESTINATION_IDENTITY_MISMATCH"
        | "DESTINATION_DATABASE_MISMATCH"
        | "DESTINATION_MIGRATION_NOT_APPLIED";
    };

const AUTHORIZED_TEST_DB_HOSTS = [
  "ep-little-mouse-a5nh644n.us-east-2.aws.neon.tech",
  "ep-little-mouse-a5nh644n-pooler.us-east-2.aws.neon.tech",
] as const;

function canonicalDbHost(hostname: string): string {
  return hostname.replace(/-pooler\./, ".");
}

function parseDbHost(databaseUrl: string): string | null {
  try {
    return new URL(databaseUrl).hostname;
  } catch {
    return null;
  }
}

function isAuthorizedTestDbHost(hostname: string): boolean {
  const canonical = canonicalDbHost(hostname);
  return AUTHORIZED_TEST_DB_HOSTS.some(
    (host) => canonicalDbHost(host) === canonical,
  );
}

/**
 * Bounded read-only readiness check for the fixed Preview destinations.
 * It verifies the deployed candidate identity, preview database safety and the
 * canonical test DB binding needed for webhook-secret verification. It never
 * reads or returns secrets, raw bodies or provider tokens.
 */
export async function verifyPreviewDestinationReadiness(
  params: {
    kind: PreviewDestinationKind;
    expectedCommitSha: string;
    databaseUrl: string;
  },
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<PreviewDestinationReadiness> {
  const expected = params.expectedCommitSha.trim();
  if (!/^[0-9a-f]{40}$/.test(expected)) {
    return { ok: false, code: "MISSING_EXPECTED_COMMIT_SHA" };
  }

  const isIntegrated = params.kind === "integrated-preview";
  const origin = isIntegrated
    ? FIXED_TARGETS.integratedPreviewOrigin
    : FIXED_TARGETS.oldPreviewOrigin;
  const expectedCommitSha = isIntegrated
    ? expected
    : FIXED_TARGETS.oldPreviewCommitSha;
  const expectedVersion = isIntegrated
    ? FIXED_TARGETS.integratedPreviewVersion
    : FIXED_TARGETS.oldPreviewVersion;

  let response: Response;
  try {
    response = await (deps.fetchImpl ?? globalThis.fetch)(
      `${origin}/api/health`,
      {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(deps.timeoutMs ?? 5000),
      },
    );
  } catch {
    return { ok: false, code: "DESTINATION_HEALTH_UNAVAILABLE" };
  }
  if (!response.ok) {
    return { ok: false, code: "DESTINATION_HEALTH_UNAVAILABLE" };
  }

  let body: {
    status?: unknown;
    version?: unknown;
    commitSha?: unknown;
    deploymentReady?: unknown;
    database?: unknown;
    previewDiagnostics?: {
      dbHost?: unknown;
      isProductionDb?: unknown;
      migrationApplied?: unknown;
    };
  };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    return { ok: false, code: "DESTINATION_HEALTH_UNAVAILABLE" };
  }

  if (
    body.status !== "ok" ||
    body.deploymentReady !== true ||
    body.database !== "connected"
  ) {
    return { ok: false, code: "DESTINATION_NOT_READY" };
  }
  if (
    body.version !== expectedVersion ||
    body.commitSha !== expectedCommitSha
  ) {
    return { ok: false, code: "DESTINATION_IDENTITY_MISMATCH" };
  }

  const diagnostics = body.previewDiagnostics;
  if (
    !diagnostics ||
    diagnostics.isProductionDb !== false ||
    typeof diagnostics.dbHost !== "string" ||
    !isAuthorizedTestDbHost(diagnostics.dbHost)
  ) {
    return { ok: false, code: "DESTINATION_DATABASE_MISMATCH" };
  }
  if (diagnostics.migrationApplied !== true) {
    return { ok: false, code: "DESTINATION_MIGRATION_NOT_APPLIED" };
  }

  const sourceHost = parseDbHost(params.databaseUrl);
  if (
    !sourceHost ||
    !isAuthorizedTestDbHost(sourceHost) ||
    canonicalDbHost(sourceHost) !== canonicalDbHost(diagnostics.dbHost)
  ) {
    return { ok: false, code: "DESTINATION_DATABASE_MISMATCH" };
  }

  return {
    ok: true,
    kind: params.kind,
    origin,
    version: expectedVersion,
    commitSha: expectedCommitSha,
    dbHost: diagnostics.dbHost,
  };
}

export type ProductionDestinationReadiness =
  | {
      ok: true;
      origin: string;
      version: string | null;
      commitSha: string;
    }
  | {
      ok: false;
      code:
        | "MISSING_EXPECTED_COMMIT_SHA"
        | "DESTINATION_HEALTH_UNAVAILABLE"
        | "DESTINATION_NOT_READY"
        | "DESTINATION_IDENTITY_MISMATCH";
    };

/**
 * Bounded read-only readiness check for the canonical Production runtime.
 * It verifies the deployed commit SHA and ready/connected health before any
 * cutover mutation. It never reads or returns secrets, raw bodies or tokens.
 */
export async function verifyProductionDestinationReadiness(
  params: {
    expectedCommitSha: string;
    expectedVersion?: string;
  },
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ProductionDestinationReadiness> {
  const expected = params.expectedCommitSha.trim();
  if (!/^[0-9a-f]{40}$/.test(expected)) {
    return { ok: false, code: "MISSING_EXPECTED_COMMIT_SHA" };
  }

  const origin = new URL(FIXED_TARGETS.mainWebhookUrl).origin;
  let response: Response;
  try {
    response = await (deps.fetchImpl ?? globalThis.fetch)(
      `${origin}/api/health`,
      {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(deps.timeoutMs ?? 5000),
      },
    );
  } catch {
    return { ok: false, code: "DESTINATION_HEALTH_UNAVAILABLE" };
  }
  if (!response.ok) {
    return { ok: false, code: "DESTINATION_HEALTH_UNAVAILABLE" };
  }

  let body: {
    status?: unknown;
    version?: unknown;
    commitSha?: unknown;
    deploymentReady?: unknown;
    database?: unknown;
  };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    return { ok: false, code: "DESTINATION_HEALTH_UNAVAILABLE" };
  }

  if (
    body.status !== "ok" ||
    body.deploymentReady !== true ||
    body.database !== "connected"
  ) {
    return { ok: false, code: "DESTINATION_NOT_READY" };
  }
  if (body.commitSha !== expected) {
    return { ok: false, code: "DESTINATION_IDENTITY_MISMATCH" };
  }
  const expectedVersion = params.expectedVersion?.trim();
  if (
    expectedVersion &&
    body.version !== expectedVersion
  ) {
    return { ok: false, code: "DESTINATION_IDENTITY_MISMATCH" };
  }

  return {
    ok: true,
    origin,
    version: typeof body.version === "string" ? body.version : null,
    commitSha: expected,
  };
}

export type SwitchRunnerDeps = {
  validateTestDbUrl?: (url: string) => void;
  validateProdDbUrl?: (url: string) => void;
  verifyDestination?: (params: {
    kind: PreviewDestinationKind;
    expectedCommitSha: string;
    databaseUrl: string;
  }) => Promise<PreviewDestinationReadiness>;
  verifyProductionDestination?: (params: {
    expectedCommitSha: string;
    expectedVersion?: string;
  }) => Promise<ProductionDestinationReadiness>;
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

  const isIntegratedPreviewTransfer =
    operation === "transfer-integration-preview-dry-run" ||
    operation === "transfer-integration-preview-apply";
  const isOldPreviewReturn =
    operation === "return-old-preview-dry-run" ||
    operation === "return-old-preview-apply";
  const isPreviewToPreview = isIntegratedPreviewTransfer || isOldPreviewReturn;
  const isCutover =
    operation === "cutover-main-runtime-dry-run" ||
    operation === "cutover-main-runtime-apply";

  let expectedCurrentUrl: string = FIXED_TARGETS.mainWebhookUrl;
  let destinationUrl: string = isRestore
    ? FIXED_TARGETS.mainWebhookUrl
    : FIXED_TARGETS.previewWebhookUrl;

  if (isRestore && !isRestorePreflight && !isReconcile) {
    expectedCurrentUrl = FIXED_TARGETS.previewWebhookUrl;
  }
  if (isIntegratedPreviewTransfer) {
    expectedCurrentUrl = FIXED_TARGETS.previewWebhookUrl;
    destinationUrl = FIXED_TARGETS.integratedPreviewWebhookUrl;
  } else if (isOldPreviewReturn) {
    expectedCurrentUrl = FIXED_TARGETS.integratedPreviewWebhookUrl;
    destinationUrl = FIXED_TARGETS.previewWebhookUrl;
  }
  if (isCutover) {
    const kind = (env.EXPECTED_CURRENT_KIND ?? "").trim();
    if (
      !CUTOVER_CURRENT_KINDS.includes(kind as CutoverCurrentKind)
    ) {
      out.error(
        "❌ Preflight Refused: [INVALID_EXPECTED_CURRENT_KIND] Expected current webhook kind is missing or not authorized.",
      );
      return { ok: false, code: "INVALID_EXPECTED_CURRENT_KIND" };
    }
    expectedCurrentUrl =
      kind === "integrated-preview"
        ? FIXED_TARGETS.integratedPreviewWebhookUrl
        : kind === "old-preview"
          ? FIXED_TARGETS.previewWebhookUrl
          : FIXED_TARGETS.mainWebhookUrl;
    destinationUrl = FIXED_TARGETS.mainWebhookUrl;
  }

  const expectedCommitSha = (env.EXPECTED_COMMIT_SHA ?? "").trim();
  if (isPreviewToPreview || isCutover) {
    if (!/^[0-9a-f]{40}$/.test(expectedCommitSha)) {
      out.error(
        "❌ Preflight Refused: [MISSING_EXPECTED_COMMIT_SHA] Full reviewed commit SHA is required.",
      );
      return { ok: false, code: "MISSING_EXPECTED_COMMIT_SHA" };
    }
    const actualCheckedOutSha = (env.GITHUB_SHA ?? "").trim();
    if (actualCheckedOutSha && actualCheckedOutSha !== expectedCommitSha) {
      out.error(
        "❌ Preflight Refused: [COMMIT_SHA_MISMATCH] Expected commit SHA does not match the checked-out SHA.",
      );
      return { ok: false, code: "COMMIT_SHA_MISMATCH" };
    }
  }

  const expectedVersion = (env.EXPECTED_VERSION ?? "").trim();
  const previewReadiness = isPreviewToPreview
    ? await (deps.verifyDestination ?? verifyPreviewDestinationReadiness)({
        kind: isIntegratedPreviewTransfer
          ? "integrated-preview"
          : "old-preview",
        expectedCommitSha,
        databaseUrl,
      })
    : null;
  const productionReadiness = isCutover
    ? await (deps.verifyProductionDestination ??
        verifyProductionDestinationReadiness)({
        expectedCommitSha,
        ...(expectedVersion ? { expectedVersion } : {}),
      })
    : null;
  const destinationReadiness = previewReadiness ?? productionReadiness;
  if (destinationReadiness && !destinationReadiness.ok) {
    out.error(
      `❌ Preflight Refused: [${destinationReadiness.code}] Destination readiness failed.`,
    );
    return { ok: false, code: destinationReadiness.code };
  }

  const modeLabel = isApply ? "APPLY (explicit switch)" : "DRY RUN (read-only)";
  const actionLabel = isRestore
    ? "Production Restoration"
    : isPreviewToPreview
      ? "Preview-to-Preview Transfer"
      : isCutover
        ? "Production Runtime Cutover"
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
  if (previewReadiness?.ok) {
    out.log(
      `Destination check:    version=${previewReadiness.version}, commitSha=${previewReadiness.commitSha}, dbHost=${previewReadiness.dbHost}, migrationApplied=true, isProductionDb=false`,
    );
  }
  if (productionReadiness?.ok) {
    out.log(
      `Destination check:    origin=${productionReadiness.origin}, version=${productionReadiness.version ?? "unknown"}, commitSha=${productionReadiness.commitSha}, database=connected`,
    );
  }

  const restorationGuidance =
    "Reviewed workflow: restore-main-webhook-dry-run then restore-main-webhook-apply against Production when the current URL is Preview. Use the exact reviewed SHA.";
  const reconciliationGuidance =
    "If Telegram is already on main but its database hash is unconfirmed, use reviewed restore-main-webhook-reconcile against Production. Inspect partial failure first; never retry blindly.";
  const previewReturnGuidance =
    "Return path: reviewed workflow return-old-preview-dry-run then return-old-preview-apply on the exact integration SHA. It uses the SAME test database and does not touch Production.";
  const previewForwardGuidance =
    "Forward path: reviewed workflow transfer-integration-preview-dry-run then transfer-integration-preview-apply on the exact integration SHA. It uses the SAME test database and does not touch Production.";
  const cutoverGuidance =
    "Cutover path: test-db-migrate.yml cutover-main-runtime-dry-run then cutover-main-runtime-apply on main with the exact merged SHA. Do not use restore-main-webhook-* against the selected test database.";

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
        allowAlreadyAtDestination: isPreviewToPreview || isCutover,
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
          out.error(`  ${isCutover ? cutoverGuidance : reconciliationGuidance}`);
        }
        if (outcome.restorationProcedure) {
          out.error("\nRestoration Procedure (revert switch):");
          out.error(`  ${isCutover ? cutoverGuidance : restorationGuidance}\n`);
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
        out.error(`  ${isCutover ? cutoverGuidance : restorationGuidance}\n`);
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
      `Mode:                ${
        outcome.status === "ALREADY_AT_DESTINATION"
          ? "READ-ONLY NO-OP (already at destination)"
          : outcome.dryRun
            ? "DRY RUN (no changes made)"
            : "APPLIED (switched)"
      }`,
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
      if (isPreviewToPreview) {
        out.log("\nReviewed Transfer Procedure:");
        out.log(
          `  ${isIntegratedPreviewTransfer ? previewReturnGuidance : previewForwardGuidance}`,
        );
      } else if (!isRestorePreflight) {
        out.log("\nReviewed Restoration Procedure:");
        out.log(`  ${restorationGuidance}`);
        out.log(`  ${reconciliationGuidance}`);
      }
    } else if (outcome.status === "ALREADY_AT_DESTINATION") {
      out.log(`Current URL:         ${outcome.currentWebhookUrl}`);
      out.log(`Destination URL:     ${outcome.destinationWebhookUrl}`);
      out.log(`Pending Updates:     ${outcome.pendingUpdateCount}`);
      out.log(
        "Message:             Fixed destination is already active; zero provider and database writes were performed.",
      );
    } else if (outcome.status === "SWITCHED") {
      out.log(`Previous URL:        ${outcome.previousWebhookUrl}`);
      out.log(`New Webhook URL:     ${outcome.webhookUrl}`);
      out.log(`Allowed Updates:     ${JSON.stringify(outcome.allowedUpdates)}`);
      out.log(`Pending Updates:     ${outcome.pendingUpdateCount}`);
      out.log(
        "Webhook Secret Hash: Persisted & verified in destination database",
      );
      out.log(`Verified At:         ${outcome.verifiedAt}`);
      if (isPreviewToPreview) {
        out.log("\nReviewed Return Procedure:");
        out.log(
          `  ${isIntegratedPreviewTransfer ? previewReturnGuidance : previewForwardGuidance}\n`,
        );
      } else {
        out.log("\nRestoration Procedure (revert switch):");
        out.log(`  ${restorationGuidance}\n  ${reconciliationGuidance}\n`);
      }
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
