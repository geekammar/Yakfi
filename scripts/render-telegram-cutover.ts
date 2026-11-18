#!/usr/bin/env node
/**
 * Yakfi — Render-targeted Telegram cutover preflight and apply runner.
 *
 * Safety invariants:
 * - Preflight is read-only: no getUpdates, no setWebhook, no DB writes.
 * - Apply is a separate explicit operation and always performs a fresh
 *   read-only preflight immediately before mutation.
 * - Apply requires pending_update_count === 0; unknown/malformed/nonzero
 *   backlog blocks apply.
 * - drop_pending_updates is never enabled.
 * - The destination is pinned to the confirmed Render webhook URL.
 * - Only the confirmed Business/Connection/Bot and active selected DB are used.
 * - No secret values, tokens, raw headers, database URLs, or raw errors are
 *   printed; results are sanitized identifiers and bounded error text only.
 */
import { appendFileSync } from "node:fs";

import {
  defaultCredentialsResolver,
  type CredentialsResolver,
} from "@/server/credentials/credentials-resolver";
import { validateDatabaseUrl } from "@/server/credentials/test-bot-recovery";
import {
  TELEGRAM_CUSTOMER_ALLOWED_UPDATES,
  defaultTelegramApiDeps,
  resolveTelegramBotToken,
  telegramGetMe,
  telegramGetWebhookInfo,
  type TelegramApiDeps,
} from "@/server/integrations/telegram/telegram-client";
import {
  switchTelegramBotWebhookDefault,
  validateCustomerWebhookUrl,
  type SwitchTelegramWebhookOutcome,
  type SwitchTelegramWebhookParams,
} from "@/server/integrations/telegram/telegram-repair";
import {
  CUTOVER_READINESS_BOT_ID,
  CUTOVER_READINESS_BOT_USERNAME,
  CUTOVER_READINESS_BUSINESS_ID,
  CUTOVER_READINESS_CONNECTION_ID,
} from "@/server/operator/cutover-readiness";
import type { TelegramConnectionRepository } from "@/server/repositories";
import type { TelegramConnection } from "@/types/domain";

import {
  CONFIRMED_RENDER_ORIGIN,
  CONFIRMED_RENDER_REGION,
  CONFIRMED_RENDER_SERVICE_ID,
  CONFIRMED_RENDER_WEBHOOK_URL,
  CONFIRMED_RENDER_WORKSPACE_ID,
  verifyRenderRuntimeReadiness,
  verifyRenderServiceOwnership,
  type RenderRuntimeReadiness,
  type VerifiedRenderService,
} from "./render-vault-tool";

export const RENDER_TELEGRAM_CUTOVER_TARGET = {
  origin: CONFIRMED_RENDER_ORIGIN,
  webhookUrl: CONFIRMED_RENDER_WEBHOOK_URL,
  serviceId: CONFIRMED_RENDER_SERVICE_ID,
  workspaceId: CONFIRMED_RENDER_WORKSPACE_ID,
  region: CONFIRMED_RENDER_REGION,
  businessId: CUTOVER_READINESS_BUSINESS_ID,
  connectionId: CUTOVER_READINESS_CONNECTION_ID,
  botExternalId: CUTOVER_READINESS_BOT_ID,
  botUsername: CUTOVER_READINESS_BOT_USERNAME,
  allowedUpdates: [...TELEGRAM_CUSTOMER_ALLOWED_UPDATES],
} as const;

const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

export type RenderTelegramCutoverOperation = "preflight" | "apply";

export type RenderTelegramPreflightParams = {
  expectedCommitSha: string;
  actualCommitSha: string;
  expectedVersion: string;
  databaseUrl: string;
  renderApiKey: string;
};

export type RenderTelegramApplyParams = RenderTelegramPreflightParams & {
  expectedCurrentWebhookUrl: string;
};

export type RenderTelegramCutoverDeps = {
  connectionRepository: Pick<
    TelegramConnectionRepository,
    "findByIdWithinBusiness"
  >;
  credentialsResolver: Pick<CredentialsResolver, "resolve">;
  telegramApi: TelegramApiDeps;
  verifyRenderService: (
    params: {
      serviceId: string;
      renderApiKey: string;
      expectedWorkspaceId?: string;
      expectedRegion?: string;
    },
  ) => Promise<VerifiedRenderService>;
  verifyRenderReadiness: typeof verifyRenderRuntimeReadiness;
  switchWebhook: (
    params: SwitchTelegramWebhookParams,
  ) => Promise<SwitchTelegramWebhookOutcome>;
  renderFetchImpl?: typeof fetch;
  now?: () => number;
};

export type RenderTelegramPreflightResult = {
  ok: boolean;
  status: "READY" | "BLOCKED" | "FAILED" | "ALREADY_AT_DESTINATION";
  code: string;
  observedAt: string;
  expectedCommitSha: string;
  expectedVersion: string;
  destinationWebhookUrl: string;
  currentWebhookUrl: string | null;
  pendingUpdateCount: number | null;
  pendingUpdateCountValid: boolean;
  allowedUpdates: string[];
  lastErrorDate: number | null;
  lastErrorMessage: string | null;
  actionsCredentialResolved: boolean;
  botIdentityVerified: boolean;
  botExternalId: string | null;
  botUsername: string | null;
  renderService: {
    serviceId: string;
    workspaceId: string;
    region: string;
  } | null;
  renderReadiness: RenderRuntimeReadiness;
  readyForApply: boolean;
};

export type RenderTelegramApplyResult = {
  ok: boolean;
  status: "SWITCHED" | "ALREADY_AT_DESTINATION" | "BLOCKED" | "PARTIAL_FAILURE" | "FAILED";
  code: string;
  preflight: RenderTelegramPreflightResult;
  webhookUrl?: string;
  allowedUpdates?: string[];
  webhookSecretHashPersisted?: boolean;
  postApplyReadiness?: RenderRuntimeReadiness;
  remoteStateMayHaveChanged?: boolean;
  recoveryInstruction?: string;
};

function sanitizeTelegramErrorText(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<redacted>")
    .replace(/(postgres(?:ql)?:\/\/)[^\s]+/gi, "$1***")
    .replace(
      /(secret_token|x-telegram-bot-api-secret-token)[=:]\s*[^\s&]+/gi,
      "$1=***",
    )
    .slice(0, 300);
}

function basePreflightResult(
  params: RenderTelegramPreflightParams,
  observedAt: string,
): RenderTelegramPreflightResult {
  return {
    ok: false,
    status: "FAILED",
    code: "NOT_EVALUATED",
    observedAt,
    expectedCommitSha: params.expectedCommitSha.trim().toLowerCase(),
    expectedVersion: params.expectedVersion.trim(),
    destinationWebhookUrl: RENDER_TELEGRAM_CUTOVER_TARGET.webhookUrl,
    currentWebhookUrl: null,
    pendingUpdateCount: null,
    pendingUpdateCountValid: false,
    allowedUpdates: [],
    lastErrorDate: null,
    lastErrorMessage: null,
    actionsCredentialResolved: false,
    botIdentityVerified: false,
    botExternalId: null,
    botUsername: null,
    renderService: null,
    renderReadiness: { ok: false, code: "NOT_EVALUATED" },
    readyForApply: false,
  };
}

function validateExpectedCheckout(
  params: RenderTelegramPreflightParams,
): string | null {
  const expected = params.expectedCommitSha.trim().toLowerCase();
  const actual = params.actualCommitSha.trim().toLowerCase();
  if (!FULL_SHA_RE.test(expected)) {
    return "INVALID_EXPECTED_DEPLOYED_SHA";
  }
  if (!FULL_SHA_RE.test(actual)) {
    return "INVALID_CHECKOUT_SHA";
  }
  if (!VERSION_RE.test(params.expectedVersion.trim())) {
    return "INVALID_EXPECTED_VERSION";
  }
  return null;
}

async function resolveSelectedRuntimeCredential(
  deps: RenderTelegramCutoverDeps,
): Promise<
  | { ok: true; connection: TelegramConnection; token: string }
  | { ok: false; code: string }
> {
  const connection = await deps.connectionRepository.findByIdWithinBusiness(
    RENDER_TELEGRAM_CUTOVER_TARGET.connectionId,
    RENDER_TELEGRAM_CUTOVER_TARGET.businessId,
  );
  if (!connection) {
    return { ok: false, code: "CONNECTION_NOT_FOUND" };
  }
  if (
    connection.id !== RENDER_TELEGRAM_CUTOVER_TARGET.connectionId ||
    connection.businessId !== RENDER_TELEGRAM_CUTOVER_TARGET.businessId ||
    connection.botExternalId !==
      RENDER_TELEGRAM_CUTOVER_TARGET.botExternalId ||
    connection.botUsername?.toLowerCase() !==
      RENDER_TELEGRAM_CUTOVER_TARGET.botUsername.toLowerCase()
  ) {
    return { ok: false, code: "CONNECTION_IDENTITY_MISMATCH" };
  }
  if (!connection.isActive || connection.status !== "CONNECTED") {
    return { ok: false, code: "CONNECTION_NOT_ELIGIBLE" };
  }
  if (connection.provider !== "telegram_managed") {
    return { ok: false, code: "UNSUPPORTED_PROVIDER" };
  }
  if (
    connection.managerBotId &&
    connection.managerBotId === connection.botExternalId
  ) {
    return { ok: false, code: "MANAGER_BOT_TARGET_REJECTED" };
  }

  const tokenRes = await resolveTelegramBotToken(
    { credentialsResolver: deps.credentialsResolver },
    connection.credentialsRef,
  );
  if (!tokenRes.ok) {
    return { ok: false, code: "CREDENTIALS_UNAVAILABLE" };
  }
  return { ok: true, connection, token: tokenRes.token };
}

async function verifyTelegramIdentity(
  token: string,
  deps: RenderTelegramCutoverDeps,
): Promise<
  | { ok: true; botExternalId: string; botUsername: string | null }
  | { ok: false; code: string }
> {
  const me = await telegramGetMe(deps.telegramApi, token);
  if (!me.ok) {
    return { ok: false, code: "BOT_IDENTITY_VERIFICATION_FAILED" };
  }
  if (
    me.result.is_bot !== true ||
    String(me.result.id) !== RENDER_TELEGRAM_CUTOVER_TARGET.botExternalId ||
    me.result.username?.toLowerCase() !==
      RENDER_TELEGRAM_CUTOVER_TARGET.botUsername.toLowerCase() ||
    me.result.can_manage_bots === true
  ) {
    return { ok: false, code: "BOT_IDENTITY_MISMATCH" };
  }
  return {
    ok: true,
    botExternalId: String(me.result.id),
    botUsername: me.result.username ?? null,
  };
}

async function readTelegramWebhookInfo(
  token: string,
  deps: RenderTelegramCutoverDeps,
): Promise<
  | {
      ok: true;
      currentWebhookUrl: string;
      pendingUpdateCount: number | null;
      pendingUpdateCountValid: boolean;
      allowedUpdates: string[];
      lastErrorDate: number | null;
      lastErrorMessage: string | null;
    }
  | { ok: false; code: string }
> {
  const infoRes = await telegramGetWebhookInfo(deps.telegramApi, token);
  if (!infoRes.ok) {
    return { ok: false, code: "WEBHOOK_INFO_FAILED" };
  }
  const info = infoRes.result;
  const rawUrl = typeof info.url === "string" ? info.url.trim() : "";
  if (!rawUrl) {
    return { ok: false, code: "MISSING_WEBHOOK_URL" };
  }
  const currentValidation = validateCustomerWebhookUrl(
    rawUrl,
    "الرابط المسجل لدى تيليجرام",
  );
  if (!currentValidation.ok) {
    return { ok: false, code: currentValidation.code };
  }

  const pending = info.pending_update_count;
  const pendingValid =
    typeof pending === "number" && Number.isInteger(pending) && pending >= 0;
  const allowedUpdates = Array.isArray(info.allowed_updates)
    ? info.allowed_updates.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const lastErrorDate =
    typeof info.last_error_date === "number" &&
    Number.isFinite(info.last_error_date)
      ? info.last_error_date
      : null;

  return {
    ok: true,
    currentWebhookUrl: currentValidation.normalizedUrl,
    pendingUpdateCount: pendingValid ? pending : null,
    pendingUpdateCountValid: pendingValid,
    allowedUpdates,
    lastErrorDate,
    lastErrorMessage: sanitizeTelegramErrorText(info.last_error_message),
  };
}

function readinessDeps(deps: RenderTelegramCutoverDeps) {
  return {
    fetchImpl: deps.renderFetchImpl ?? globalThis.fetch,
    now: deps.now ?? (() => Date.now()),
  };
}

export async function preflightRenderTelegramCutover(
  params: RenderTelegramPreflightParams,
  deps: RenderTelegramCutoverDeps,
): Promise<RenderTelegramPreflightResult> {
  const observedAt = new Date((deps.now ?? Date.now)()).toISOString();
  const base = basePreflightResult(params, observedAt);

  const checkoutError = validateExpectedCheckout(params);
  if (checkoutError) {
    return { ...base, code: checkoutError };
  }

  try {
    validateDatabaseUrl(params.databaseUrl.trim());
  } catch {
    return { ...base, code: "UNAUTHORIZED_DATABASE_URL_TARGET" };
  }

  let verifiedService: VerifiedRenderService;
  try {
    verifiedService = await deps.verifyRenderService({
      serviceId: RENDER_TELEGRAM_CUTOVER_TARGET.serviceId,
      renderApiKey: params.renderApiKey,
      expectedWorkspaceId: RENDER_TELEGRAM_CUTOVER_TARGET.workspaceId,
      expectedRegion: RENDER_TELEGRAM_CUTOVER_TARGET.region,
    });
  } catch (err: unknown) {
    const detail =
      err instanceof Error && /^[A-Z0-9_]+$/.test(err.message)
        ? err.message
        : "VERIFICATION_FAILED";
    return { ...base, code: `RENDER_SERVICE_${detail}` };
  }
  const renderService = {
    serviceId: verifiedService.serviceId,
    workspaceId: verifiedService.workspaceId,
    region: verifiedService.region,
  };

  const credential = await resolveSelectedRuntimeCredential(deps);
  if (!credential.ok) {
    return { ...base, renderService, code: credential.code };
  }

  const identity = await verifyTelegramIdentity(credential.token, deps);
  if (!identity.ok) {
    return {
      ...base,
      renderService,
      actionsCredentialResolved: true,
      code: identity.code,
    };
  }

  const webhook = await readTelegramWebhookInfo(credential.token, deps);
  if (!webhook.ok) {
    return {
      ...base,
      renderService,
      actionsCredentialResolved: true,
      botIdentityVerified: true,
      botExternalId: identity.botExternalId,
      botUsername: identity.botUsername,
      code: webhook.code,
    };
  }

  const renderReadiness = await deps.verifyRenderReadiness(
    {
      renderOrigin: RENDER_TELEGRAM_CUTOVER_TARGET.origin,
      expectedCommitSha: params.expectedCommitSha.trim().toLowerCase(),
      expectedVersion: params.expectedVersion.trim(),
      databaseUrl: params.databaseUrl,
      cutoverSignerCred: credential.token,
    },
    readinessDeps(deps),
  );

  const telemetry = {
    ...base,
    ok: true,
    currentWebhookUrl: webhook.currentWebhookUrl,
    pendingUpdateCount: webhook.pendingUpdateCount,
    pendingUpdateCountValid: webhook.pendingUpdateCountValid,
    allowedUpdates: webhook.allowedUpdates,
    lastErrorDate: webhook.lastErrorDate,
    lastErrorMessage: webhook.lastErrorMessage,
    actionsCredentialResolved: true,
    botIdentityVerified: true,
    botExternalId: identity.botExternalId,
    botUsername: identity.botUsername,
    renderService,
    renderReadiness,
  };

  if (!webhook.pendingUpdateCountValid) {
    return {
      ...telemetry,
      status: "BLOCKED",
      code: "PENDING_UPDATE_COUNT_UNKNOWN",
      readyForApply: false,
    };
  }

  if ((webhook.pendingUpdateCount ?? 0) > 0) {
    return {
      ...telemetry,
      status: "BLOCKED",
      code: "PENDING_UPDATES_REQUIRE_DISPOSITION",
      readyForApply: false,
    };
  }

  if (webhook.currentWebhookUrl === RENDER_TELEGRAM_CUTOVER_TARGET.webhookUrl) {
    if (!renderReadiness.ok) {
      return {
        ...telemetry,
        status: "BLOCKED",
        code: "ALREADY_AT_DESTINATION_RUNTIME_NOT_READY",
        readyForApply: false,
      };
    }
    return {
      ...telemetry,
      status: "ALREADY_AT_DESTINATION",
      code: "ALREADY_AT_DESTINATION",
      readyForApply: false,
    };
  }

  if (!renderReadiness.ok) {
    return {
      ...telemetry,
      status: "BLOCKED",
      code: "RENDER_READINESS_NOT_VERIFIED",
      readyForApply: false,
    };
  }

  return {
    ...telemetry,
    status: "READY",
    code: "READY_FOR_APPLY",
    readyForApply: true,
  };
}

function applyResult(
  preflight: RenderTelegramPreflightResult,
  status: RenderTelegramApplyResult["status"],
  code: string,
  extra: Partial<RenderTelegramApplyResult> = {},
): RenderTelegramApplyResult {
  return {
    ok: status === "SWITCHED" || status === "ALREADY_AT_DESTINATION",
    status,
    code,
    preflight,
    recoveryInstruction:
      "Do not retry blindly. Inspect Telegram getWebhookInfo and the DB webhook_secret_hash, then use the reviewed reconciliation procedure.",
    ...extra,
  };
}

export async function applyRenderTelegramCutover(
  params: RenderTelegramApplyParams,
  deps: RenderTelegramCutoverDeps,
): Promise<RenderTelegramApplyResult> {
  const preflight = await preflightRenderTelegramCutover(params, deps);

  const expectedCurrentValidation = validateCustomerWebhookUrl(
    params.expectedCurrentWebhookUrl,
    "الرابط الحالي المتوقع",
  );
  if (!expectedCurrentValidation.ok) {
    return applyResult(preflight, "FAILED", "INVALID_EXPECTED_CURRENT_WEBHOOK_URL");
  }

  if (preflight.status === "FAILED") {
    return applyResult(preflight, "FAILED", preflight.code);
  }
  if (preflight.status === "ALREADY_AT_DESTINATION") {
    return applyResult(preflight, "ALREADY_AT_DESTINATION", preflight.code, {
      webhookUrl: RENDER_TELEGRAM_CUTOVER_TARGET.webhookUrl,
      allowedUpdates: [...RENDER_TELEGRAM_CUTOVER_TARGET.allowedUpdates],
      postApplyReadiness: preflight.renderReadiness,
    });
  }
  if (preflight.status === "BLOCKED") {
    return applyResult(preflight, "BLOCKED", preflight.code);
  }
  if (
    params.expectedCommitSha.trim().toLowerCase() !==
    params.actualCommitSha.trim().toLowerCase()
  ) {
    return applyResult(
      preflight,
      "BLOCKED",
      "APPLY_REQUIRES_CHECKOUT_EQUALS_DEPLOYED",
    );
  }
  if (
    preflight.currentWebhookUrl !== expectedCurrentValidation.normalizedUrl
  ) {
    return applyResult(preflight, "BLOCKED", "CURRENT_WEBHOOK_URL_MISMATCH");
  }
  if (!preflight.readyForApply) {
    return applyResult(preflight, "BLOCKED", "PREFLIGHT_NOT_READY");
  }

  let outcome: SwitchTelegramWebhookOutcome;
  try {
    outcome = await deps.switchWebhook({
      businessId: RENDER_TELEGRAM_CUTOVER_TARGET.businessId,
      connectionId: RENDER_TELEGRAM_CUTOVER_TARGET.connectionId,
      expectedCurrentUrl: expectedCurrentValidation.normalizedUrl,
      destinationUrl: RENDER_TELEGRAM_CUTOVER_TARGET.webhookUrl,
      expectedBotExternalId: RENDER_TELEGRAM_CUTOVER_TARGET.botExternalId,
      apply: true,
      allowAlreadyAtDestination: true,
      requireZeroPendingUpdates: true,
      allowedUpdates: [...RENDER_TELEGRAM_CUTOVER_TARGET.allowedUpdates],
    });
  } catch {
    return applyResult(preflight, "FAILED", "UNEXPECTED_SWITCH_ERROR", {
      remoteStateMayHaveChanged: true,
    });
  }

  if (outcome.ok && outcome.status === "SWITCHED") {
    const postCredential = await resolveSelectedRuntimeCredential(deps);
    if (!postCredential.ok) {
      return applyResult(
        preflight,
        "PARTIAL_FAILURE",
        "POST_APPLY_CREDENTIAL_RESOLUTION_FAILED",
        {
          webhookUrl: outcome.webhookUrl,
          allowedUpdates: outcome.allowedUpdates,
          webhookSecretHashPersisted: outcome.webhookSecretHashPersisted,
          remoteStateMayHaveChanged: true,
        },
      );
    }
    const postReadiness = await deps.verifyRenderReadiness(
      {
        renderOrigin: RENDER_TELEGRAM_CUTOVER_TARGET.origin,
        expectedCommitSha: params.expectedCommitSha.trim().toLowerCase(),
        expectedVersion: params.expectedVersion.trim(),
        databaseUrl: params.databaseUrl,
        cutoverSignerCred: postCredential.token,
      },
      readinessDeps(deps),
    );
    if (!postReadiness.ok) {
      return applyResult(
        preflight,
        "PARTIAL_FAILURE",
        "POST_APPLY_RUNTIME_READINESS_FAILED",
        {
          webhookUrl: outcome.webhookUrl,
          allowedUpdates: outcome.allowedUpdates,
          webhookSecretHashPersisted: outcome.webhookSecretHashPersisted,
          postApplyReadiness: postReadiness,
          remoteStateMayHaveChanged: true,
        },
      );
    }
    return applyResult(preflight, "SWITCHED", "SWITCHED", {
      webhookUrl: outcome.webhookUrl,
      allowedUpdates: outcome.allowedUpdates,
      webhookSecretHashPersisted: outcome.webhookSecretHashPersisted,
      postApplyReadiness: postReadiness,
    });
  }

  if (outcome.ok && outcome.status === "ALREADY_AT_DESTINATION") {
    return applyResult(
      preflight,
      "ALREADY_AT_DESTINATION",
      "ALREADY_AT_DESTINATION",
      {
        webhookUrl: RENDER_TELEGRAM_CUTOVER_TARGET.webhookUrl,
        allowedUpdates: outcome.allowedUpdates,
        postApplyReadiness: preflight.renderReadiness,
      },
    );
  }

  if (outcome.ok) {
    return applyResult(preflight, "FAILED", "UNEXPECTED_SWITCH_STATUS");
  }

  if (outcome.status === "PARTIAL_FAILURE") {
    return applyResult(preflight, "PARTIAL_FAILURE", outcome.code, {
      webhookUrl: outcome.webhookUrl,
      allowedUpdates: outcome.targetAllowedUpdates,
      remoteStateMayHaveChanged: outcome.remoteStateMayHaveChanged ?? true,
    });
  }

  const blockedCodes = new Set([
    "CURRENT_WEBHOOK_URL_MISMATCH",
    "PENDING_UPDATES_REQUIRE_DISPOSITION",
    "PENDING_UPDATE_COUNT_UNKNOWN",
  ]);
  return applyResult(
    preflight,
    blockedCodes.has(outcome.code) ? "BLOCKED" : "FAILED",
    outcome.code,
  );
}

export async function defaultRenderTelegramCutoverDeps(): Promise<RenderTelegramCutoverDeps> {
  const { telegramConnectionRepository } = await import("@/server/repositories");
  return {
    connectionRepository: telegramConnectionRepository,
    credentialsResolver: defaultCredentialsResolver,
    telegramApi: defaultTelegramApiDeps,
    verifyRenderService: (params) => verifyRenderServiceOwnership(params),
    verifyRenderReadiness: verifyRenderRuntimeReadiness,
    switchWebhook: (params) => switchTelegramBotWebhookDefault(params),
    renderFetchImpl: globalThis.fetch,
    now: () => Date.now(),
  };
}

function writeSummaryLine(line: string): void {
  console.log(line);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    appendFileSync(summaryPath, `${line}\n`);
  }
}

function printPreflight(result: RenderTelegramPreflightResult): void {
  writeSummaryLine("### Render Telegram Cutover Preflight (Read-Only)");
  writeSummaryLine(`- **Status**: \`${result.status}\``);
  writeSummaryLine(`- **Code**: \`${result.code}\``);
  writeSummaryLine(`- **Observed At**: \`${result.observedAt}\``);
  writeSummaryLine(`- **Expected SHA**: \`${result.expectedCommitSha}\``);
  writeSummaryLine(`- **Expected Version**: \`${result.expectedVersion}\``);
  writeSummaryLine(
    `- **Current Webhook URL**: \`${result.currentWebhookUrl ?? "unknown"}\``,
  );
  writeSummaryLine(
    `- **Destination Webhook URL**: \`${result.destinationWebhookUrl}\``,
  );
  writeSummaryLine(
    `- **Pending Updates**: \`${result.pendingUpdateCount ?? "UNKNOWN"}\``,
  );
  writeSummaryLine(
    `- **Pending Count Valid**: \`${String(result.pendingUpdateCountValid)}\``,
  );
  writeSummaryLine(
    `- **Allowed Updates**: \`${result.allowedUpdates.join(", ") || "none"}\``,
  );
  writeSummaryLine(
    `- **Last Error Date**: \`${result.lastErrorDate ?? "none"}\``,
  );
  writeSummaryLine(
    `- **Last Error Message**: \`${result.lastErrorMessage ?? "none"}\``,
  );
  writeSummaryLine(
    `- **Actions Credential Resolved**: \`${String(result.actionsCredentialResolved)}\``,
  );
  writeSummaryLine(
    `- **Bot Identity Verified**: \`${String(result.botIdentityVerified)}\``,
  );
  writeSummaryLine(
    `- **Bot Identity**: \`${result.botExternalId ?? "unknown"}\` / \`@${result.botUsername ?? "unknown"}\``,
  );
  if (result.renderService) {
    writeSummaryLine(
      `- **Render Service**: \`${result.renderService.serviceId}\` / workspace \`${result.renderService.workspaceId}\` / region \`${result.renderService.region}\``,
    );
  }
  if (result.renderReadiness.ok) {
    writeSummaryLine("- **Render Runtime Readiness**: `VERIFIED`");
    writeSummaryLine(
      `  - Commit/Version: \`${result.renderReadiness.commitSha}\` / \`${result.renderReadiness.version}\``,
    );
    writeSummaryLine(
      `  - Database: \`${result.renderReadiness.databaseHost}\` / \`${result.renderReadiness.databaseName}\``,
    );
    writeSummaryLine(
      `  - Identity: \`${result.renderReadiness.businessId}\` / \`${result.renderReadiness.connectionId}\` / \`${result.renderReadiness.botExternalId}\``,
    );
    writeSummaryLine(
      `  - Render Credential Resolved: \`${String(result.renderReadiness.credentialResolved)}\``,
    );
  } else {
    writeSummaryLine(
      `- **Render Runtime Readiness**: \`${result.renderReadiness.code}\``,
    );
  }
  writeSummaryLine(
    `- **Ready For Apply**: \`${String(result.readyForApply)}\``,
  );
}

function printApply(result: RenderTelegramApplyResult): void {
  writeSummaryLine("### Render Telegram Cutover Apply (Explicit)");
  writeSummaryLine(`- **Status**: \`${result.status}\``);
  writeSummaryLine(`- **Code**: \`${result.code}\``);
  writeSummaryLine(`- **Preflight Status**: \`${result.preflight.status}\``);
  writeSummaryLine(
    `- **Webhook URL**: \`${result.webhookUrl ?? "unchanged"}\``,
  );
  if (result.allowedUpdates) {
    writeSummaryLine(
      `- **Allowed Updates**: \`${result.allowedUpdates.join(", ")}\``,
    );
  }
  if (result.webhookSecretHashPersisted !== undefined) {
    writeSummaryLine(
      `- **Webhook Secret Hash Persisted**: \`${String(result.webhookSecretHashPersisted)}\``,
    );
  }
  writeSummaryLine(
    `- **Remote State May Have Changed**: \`${String(result.remoteStateMayHaveChanged ?? false)}\``,
  );
  if (result.postApplyReadiness) {
    writeSummaryLine(
      `- **Post-Apply Render Readiness**: \`${result.postApplyReadiness.ok ? "VERIFIED" : result.postApplyReadiness.code}\``,
    );
  }
  if (result.status === "PARTIAL_FAILURE" || result.status === "FAILED") {
    writeSummaryLine(`- **Recovery**: ${result.recoveryInstruction}`);
  }
}

async function main(): Promise<void> {
  const operation = (process.env.OPERATION ?? "preflight").trim();
  if (operation !== "preflight" && operation !== "apply") {
    throw new Error("INVALID_OPERATION");
  }

  const serviceId = (process.env.RENDER_SERVICE_ID ?? "").trim();
  const workspaceId = (process.env.RENDER_WORKSPACE_ID ?? "").trim();
  if (serviceId !== RENDER_TELEGRAM_CUTOVER_TARGET.serviceId) {
    throw new Error("FIXED_RENDER_SERVICE_MISMATCH");
  }
  if (workspaceId !== RENDER_TELEGRAM_CUTOVER_TARGET.workspaceId) {
    throw new Error("FIXED_RENDER_WORKSPACE_MISMATCH");
  }

  const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
  const masterKey = (process.env.CREDENTIAL_MASTER_KEY ?? "").trim();
  const renderApiKey = (process.env.RENDER_API_KEY_SOURCE ?? "").trim();
  const expectedCheckoutSha = (
    process.env.EXPECTED_CHECKOUT_SHA ?? ""
  ).trim();
  const expectedDeployedSha = (
    process.env.EXPECTED_DEPLOYED_SHA ?? ""
  ).trim();
  const actualCheckoutSha = (process.env.GITHUB_SHA ?? "").trim();
  if (!databaseUrl || !masterKey) {
    throw new Error("MISSING_RUNTIME_CREDENTIALS");
  }
  if (!renderApiKey) {
    throw new Error("MISSING_RENDER_API_KEY");
  }
  if (
    !FULL_SHA_RE.test(expectedCheckoutSha) ||
    expectedCheckoutSha !== actualCheckoutSha
  ) {
    throw new Error("COMMIT_SHA_MISMATCH");
  }
  if (!FULL_SHA_RE.test(expectedDeployedSha)) {
    throw new Error("INVALID_EXPECTED_DEPLOYED_SHA");
  }

  process.env.DATABASE_URL = databaseUrl;
  process.env.CREDENTIAL_MASTER_KEY = masterKey;

  const deps = await defaultRenderTelegramCutoverDeps();
  const baseParams: RenderTelegramPreflightParams = {
    expectedCommitSha: expectedDeployedSha,
    actualCommitSha: actualCheckoutSha,
    expectedVersion: process.env.EXPECTED_VERSION ?? "",
    databaseUrl,
    renderApiKey,
  };

  if (operation === "preflight") {
    const result = await preflightRenderTelegramCutover(baseParams, deps);
    printPreflight(result);
    if (result.status === "READY" || result.status === "ALREADY_AT_DESTINATION") {
      return;
    }
    process.exit(result.status === "BLOCKED" ? 2 : 1);
  }

  const result = await applyRenderTelegramCutover(
    {
      ...baseParams,
      expectedCurrentWebhookUrl:
        process.env.EXPECTED_CURRENT_WEBHOOK_URL ?? "",
    },
    deps,
  );
  printApply(result);
  if (result.status === "SWITCHED" || result.status === "ALREADY_AT_DESTINATION") {
    return;
  }
  process.exit(result.status === "BLOCKED" ? 2 : 1);
}

const isCliEntry =
  typeof process.argv[1] === "string" &&
  process.argv[1].endsWith("render-telegram-cutover.ts");

if (isCliEntry) {
  main().catch((err: unknown) => {
    const safeCode =
      err instanceof Error && /^[A-Z0-9_]+$/.test(err.message)
        ? err.message
        : "UNEXPECTED_RENDER_TELEGRAM_CUTOVER_ERROR";
    console.error(`::error::${safeCode}`);
    process.exit(1);
  });
}
