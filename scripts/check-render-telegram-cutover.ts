#!/usr/bin/env node
/**
 * Focused checks for the Render-targeted Telegram cutover runner.
 * Uses synthetic credentials and controlled Telegram responses only.
 * Never performs a live Telegram write or a real database write.
 */
import type { TelegramApiDeps } from "@/server/integrations/telegram/telegram-client";
import {
  switchTelegramBotWebhook,
  type RepairTelegramWebhookDeps,
  type SwitchTelegramWebhookParams,
} from "@/server/integrations/telegram/telegram-repair";
import type { TelegramConnection } from "@/types/domain";

import {
  RENDER_TELEGRAM_CUTOVER_TARGET,
  applyRenderTelegramCutover,
  preflightRenderTelegramCutover,
  reconcileRenderTelegramCutover,
  type RenderTelegramCutoverDeps,
  type RenderTelegramPreflightParams,
} from "./render-telegram-cutover";
import { verifyRenderRuntimeReadiness } from "./render-vault-tool";

type CheckRecord = { label: string; pass: boolean };
const checks: CheckRecord[] = [];

function check(label: string, pass: boolean): void {
  checks.push({ label, pass: Boolean(pass) });
}

const SHA = "a".repeat(40);
const VERSION = "0.79.17";
const OTHER_SHA = "b".repeat(40);
const CURRENT_URL = "https://flowpilot-prod.vercel.app/api/telegram/webhook";
const DB_URL =
  "postgresql://user:pass@ep-little-mouse-a5nh644n-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require";
const FAKE_SIGNER_VALUE = "synthetic-cutover-value";
const FIXED_NOW = 1_700_000_000_000;

const readinessOk = {
  ok: true as const,
  origin: RENDER_TELEGRAM_CUTOVER_TARGET.origin,
  commitSha: SHA,
  version: VERSION,
  databaseHost: "ep-little-mouse-a5nh644n.us-east-2.aws.neon.tech",
  databaseName: "neondb",
  businessId: RENDER_TELEGRAM_CUTOVER_TARGET.businessId,
  connectionId: RENDER_TELEGRAM_CUTOVER_TARGET.connectionId,
  botExternalId: RENDER_TELEGRAM_CUTOVER_TARGET.botExternalId,
  botUsername: RENDER_TELEGRAM_CUTOVER_TARGET.botUsername,
  credentialResolved: true as const,
  checkedAt: "2026-11-18T22:00:00.000Z",
};

function baseConnection(): TelegramConnection {
  return {
    id: RENDER_TELEGRAM_CUTOVER_TARGET.connectionId,
    businessId: RENDER_TELEGRAM_CUTOVER_TARGET.businessId,
    botExternalId: RENDER_TELEGRAM_CUTOVER_TARGET.botExternalId,
    botUsername: RENDER_TELEGRAM_CUTOVER_TARGET.botUsername,
    status: "CONNECTED",
    isActive: true,
    provider: "telegram_managed",
    managerBotId: null,
    credentialsRef: "fp:render-cutover-test",
    webhookSecretHash: "previous-hash",
  } as unknown as TelegramConnection;
}

function createRepo(initial: TelegramConnection) {
  let current = { ...initial };
  let updateCount = 0;
  const repository = {
    findByIdWithinBusiness: async () => current,
    updateWebhookSecretHash: async (
      _id: string,
      _businessId: string,
      hash: string,
    ) => {
      updateCount += 1;
      current = { ...current, webhookSecretHash: hash };
      return current;
    },
    update: async (
      _id: string,
      _businessId: string,
      input: Partial<TelegramConnection>,
    ) => {
      updateCount += 1;
      current = { ...current, ...input };
      return current;
    },
  } as unknown as RepairTelegramWebhookDeps["connectionRepository"];
  return { repository, getUpdateCount: () => updateCount };
}

type TelegramFakeOptions = {
  currentUrl?: string;
  pendingUpdateCount?: unknown;
  allowedUpdates?: unknown;
  postAllowedUpdates?: unknown;
  lastErrorDate?: unknown;
  lastErrorMessage?: unknown;
  me?: Record<string, unknown>;
  setWebhookThrows?: boolean;
};

function createTelegramFake(options: TelegramFakeOptions = {}) {
  let currentUrl = options.currentUrl ?? CURRENT_URL;
  let postApply = false;
  let setWebhookCount = 0;
  let getWebhookInfoCount = 0;
  let setWebhookBody: Record<string, unknown> | null = null;

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/getMe")) {
      return new Response(
        JSON.stringify({
          ok: true,
          result: options.me ?? {
            id: Number(RENDER_TELEGRAM_CUTOVER_TARGET.botExternalId),
            is_bot: true,
            username: RENDER_TELEGRAM_CUTOVER_TARGET.botUsername,
          },
        }),
        { status: 200 },
      );
    }
    if (url.endsWith("/getWebhookInfo")) {
      getWebhookInfoCount += 1;
      const hasPostAllowedUpdates = Object.prototype.hasOwnProperty.call(
        options,
        "postAllowedUpdates",
      );
      const hasAllowedUpdates = Object.prototype.hasOwnProperty.call(
        options,
        "allowedUpdates",
      );
      const observedAllowedUpdates = postApply
        ? hasPostAllowedUpdates
          ? options.postAllowedUpdates
          : hasAllowedUpdates
            ? options.allowedUpdates
            : ["message", "callback_query"]
        : hasAllowedUpdates
          ? options.allowedUpdates
          : ["message", "callback_query"];
      const webhookInfo: Record<string, unknown> = {
        url: currentUrl,
        pending_update_count: Object.prototype.hasOwnProperty.call(
          options,
          "pendingUpdateCount",
        )
          ? options.pendingUpdateCount
          : 0,
        last_error_date: options.lastErrorDate,
        last_error_message: options.lastErrorMessage,
      };
      if (observedAllowedUpdates !== undefined) {
        webhookInfo.allowed_updates = observedAllowedUpdates;
      }
      return new Response(
        JSON.stringify({
          ok: true,
          result: webhookInfo,
        }),
        { status: 200 },
      );
    }
    if (url.endsWith("/setWebhook")) {
      setWebhookCount += 1;
      setWebhookBody = JSON.parse(String(init?.body ?? "{}")) as Record<
        string,
        unknown
      >;
      if (options.setWebhookThrows) {
        throw new Error("ECONNRESET");
      }
      if (typeof setWebhookBody.url === "string") {
        currentUrl = setWebhookBody.url;
        postApply = true;
      }
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
      });
    }
    throw new Error("UNEXPECTED_TELEGRAM_CALL");
  };

  const api = {
    fetchImpl,
    apiHost: "https://api.telegram.org",
    credentialsResolver: {
      resolve: async () => ({ ok: true, value: FAKE_SIGNER_VALUE }),
    },
  } as unknown as TelegramApiDeps;

  return {
    api,
    getSetWebhookCount: () => setWebhookCount,
    getGetWebhookInfoCount: () => getWebhookInfoCount,
    getSetWebhookBody: () => setWebhookBody,
  };
}

const fakeResolver = {
  resolve: async () => ({
    ok: true as const,
    kind: "RUNTIME" as const,
    reference: "fp:render-cutover-test",
    value: FAKE_SIGNER_VALUE,
  }),
};

function preflightParams(
  overrides: Partial<RenderTelegramPreflightParams> = {},
): RenderTelegramPreflightParams {
  return {
    expectedCommitSha: SHA,
    actualCommitSha: SHA,
    expectedVersion: VERSION,
    databaseUrl: DB_URL,
    renderApiKey: "rnd_render_test_key",
    ...overrides,
  };
}

function createDeps(
  options: {
    telegram?: TelegramFakeOptions;
    readiness?: typeof readinessOk | { ok: false; code: string };
    verifyRenderService?: RenderTelegramCutoverDeps["verifyRenderService"];
    switchResult?: Awaited<
      ReturnType<RenderTelegramCutoverDeps["switchWebhook"]>
    >;
    onSwitch?: (
      params: Parameters<RenderTelegramCutoverDeps["switchWebhook"]>[0],
    ) => void;
    onVerifyRenderService?: (
      params: Parameters<RenderTelegramCutoverDeps["verifyRenderService"]>[0],
    ) => void;
    onVerifyReadiness?: (
      params: Parameters<RenderTelegramCutoverDeps["verifyRenderReadiness"]>[0],
    ) => void;
  } = {},
) {
  const telegram = createTelegramFake(options.telegram);
  let switchCalls = 0;
  let readinessCalls = 0;
  let verifyServiceCalls = 0;
  const deps: RenderTelegramCutoverDeps = {
    connectionRepository: {
      findByIdWithinBusiness: async () => baseConnection(),
    },
    credentialsResolver: fakeResolver,
    telegramApi: telegram.api,
    verifyRenderService: async (params) => {
      verifyServiceCalls += 1;
      options.onVerifyRenderService?.(params);
      if (options.verifyRenderService) {
        return options.verifyRenderService(params);
      }
      return {
        ok: true as const,
        serviceId: RENDER_TELEGRAM_CUTOVER_TARGET.serviceId,
        serviceName: "Yakfi",
        workspaceId: RENDER_TELEGRAM_CUTOVER_TARGET.workspaceId,
        region: RENDER_TELEGRAM_CUTOVER_TARGET.region,
      };
    },
    verifyRenderReadiness: async (params) => {
      readinessCalls += 1;
      options.onVerifyReadiness?.(params);
      return options.readiness ?? readinessOk;
    },
    switchWebhook: async (params) => {
      switchCalls += 1;
      options.onSwitch?.(params);
      if (options.switchResult) {
        return options.switchResult;
      }
      throw new Error("SWITCH_NOT_EXPECTED");
    },
    renderFetchImpl: async () =>
      new Response(JSON.stringify(readinessOk), { status: 200 }),
    now: () => FIXED_NOW,
  };
  return {
    deps,
    telegram,
    getSwitchCalls: () => switchCalls,
    getReadinessCalls: () => readinessCalls,
    getVerifyServiceCalls: () => verifyServiceCalls,
  };
}

async function runRealSwitch(
  options: {
    currentUrl?: string;
    pendingUpdateCount?: unknown;
    currentAllowedUpdates?: unknown;
    postAllowedUpdates?: unknown;
    allowedUpdates?: string[];
    setWebhookThrows?: boolean;
    repository?: RepairTelegramWebhookDeps["connectionRepository"];
  } = {},
) {
  const hasOwn = (key: string): boolean =>
    Object.prototype.hasOwnProperty.call(options, key);
  const telegram = createTelegramFake({
    currentUrl: options.currentUrl ?? CURRENT_URL,
    ...(hasOwn("pendingUpdateCount")
      ? { pendingUpdateCount: options.pendingUpdateCount }
      : {}),
    ...(hasOwn("currentAllowedUpdates")
      ? { allowedUpdates: options.currentAllowedUpdates }
      : {}),
    ...(hasOwn("postAllowedUpdates")
      ? { postAllowedUpdates: options.postAllowedUpdates }
      : {}),
    setWebhookThrows: options.setWebhookThrows,
  });
  const repo = options.repository
    ? { repository: options.repository, getUpdateCount: () => 0 }
    : createRepo(baseConnection());
  const params: SwitchTelegramWebhookParams = {
    businessId: RENDER_TELEGRAM_CUTOVER_TARGET.businessId,
    connectionId: RENDER_TELEGRAM_CUTOVER_TARGET.connectionId,
    expectedCurrentUrl: options.currentUrl ?? CURRENT_URL,
    destinationUrl: RENDER_TELEGRAM_CUTOVER_TARGET.webhookUrl,
    expectedBotExternalId: RENDER_TELEGRAM_CUTOVER_TARGET.botExternalId,
    apply: true,
    allowAlreadyAtDestination: true,
    requireZeroPendingUpdates: true,
    ...(options.allowedUpdates !== undefined
      ? { allowedUpdates: options.allowedUpdates }
      : {}),
  };
  const result = await switchTelegramBotWebhook(
    {
      api: telegram.api,
      connectionRepository: repo.repository,
      credentialsResolver: fakeResolver,
      generateWebhookSecret: () => "candidate-secret",
      hashWebhookSecret: (secret) => `hash:${secret}`,
    },
    params,
  );
  return { result, telegram, repo };
}

const switchedOutcome = {
  ok: true as const,
  status: "SWITCHED" as const,
  dryRun: false as const,
  botExternalId: RENDER_TELEGRAM_CUTOVER_TARGET.botExternalId,
  botUsername: RENDER_TELEGRAM_CUTOVER_TARGET.botUsername,
  previousWebhookUrl: CURRENT_URL,
  webhookUrl: RENDER_TELEGRAM_CUTOVER_TARGET.webhookUrl,
  allowedUpdates: [...RENDER_TELEGRAM_CUTOVER_TARGET.allowedUpdates],
  previousAllowedUpdates: ["message"],
  pendingUpdateCount: 0,
  webhookSecretHashPersisted: true as const,
  restorationProcedure: "reviewed restoration",
  verifiedAt: "2026-11-18T22:00:01.000Z",
};

async function main(): Promise<void> {
  // ─── 1. Ready preflight, read-only ────────────────────────────────────────
  {
    const serviceCalls: Array<
      Parameters<RenderTelegramCutoverDeps["verifyRenderService"]>[0]
    > = [];
    const { deps, telegram, getSwitchCalls } = createDeps({
      telegram: {
        lastErrorDate: 1_700_000_000,
        lastErrorMessage:
          "Delivery failed at postgresql://user:pass@ep-little-mouse-a5nh644n.us-east-2.aws.neon.tech/neondb",
      },
      onVerifyRenderService: (params) => serviceCalls.push(params),
    });
    const result = await preflightRenderTelegramCutover(
      preflightParams(),
      deps,
    );
    check(
      "P1. Ready preflight reports the fixed Render target, identities, zero pending, and sanitized Telegram error",
      result.status === "READY" &&
        result.ok === true &&
        result.readyForApply === true &&
        result.destinationWebhookUrl ===
          RENDER_TELEGRAM_CUTOVER_TARGET.webhookUrl &&
        result.currentWebhookUrl === CURRENT_URL &&
        result.pendingUpdateCount === 0 &&
        result.pendingUpdateCountValid === true &&
        result.allowedUpdates.join(",") === "message,callback_query" &&
        result.lastErrorDate === 1_700_000_000 &&
        result.lastErrorMessage !== null &&
        !result.lastErrorMessage.includes("user:pass") &&
        result.lastErrorMessage.includes("postgresql://***") &&
        result.actionsCredentialResolved === true &&
        result.botIdentityVerified === true &&
        result.renderService?.serviceId ===
          RENDER_TELEGRAM_CUTOVER_TARGET.serviceId &&
        result.renderService?.workspaceId ===
          RENDER_TELEGRAM_CUTOVER_TARGET.workspaceId &&
        result.renderService?.region ===
          RENDER_TELEGRAM_CUTOVER_TARGET.region &&
        result.renderReadiness.ok === true &&
        result.observedAt === new Date(FIXED_NOW).toISOString() &&
        serviceCalls.length === 1 &&
        serviceCalls[0]?.serviceId ===
          RENDER_TELEGRAM_CUTOVER_TARGET.serviceId &&
        serviceCalls[0]?.expectedWorkspaceId ===
          RENDER_TELEGRAM_CUTOVER_TARGET.workspaceId &&
        serviceCalls[0]?.expectedRegion ===
          RENDER_TELEGRAM_CUTOVER_TARGET.region &&
        serviceCalls[0]?.renderApiKey === "rnd_render_test_key" &&
        telegram.getSetWebhookCount() === 0 &&
        getSwitchCalls() === 0,
    );
  }

  // ─── 1b. Wrong Render service/workspace/region blocks before Telegram ────
  {
    const { deps, telegram } = createDeps({
      verifyRenderService: async () => {
        throw new Error("RENDER_WORKSPACE_MISMATCH");
      },
    });
    const result = await preflightRenderTelegramCutover(
      preflightParams(),
      deps,
    );
    check(
      "P1b. Wrong Render service/workspace/region blocks before any Telegram call",
      result.status === "FAILED" &&
        result.code === "RENDER_SERVICE_RENDER_WORKSPACE_MISMATCH" &&
        result.renderService === null &&
        telegram.getGetWebhookInfoCount() === 0 &&
        telegram.getSetWebhookCount() === 0,
    );
  }

  // ─── 2. Invalid checkout/deployed SHA, version, DB blocks ─────────────────
  {
    const badCheckout = await preflightRenderTelegramCutover(
      preflightParams({ actualCommitSha: "not-a-sha" }),
      createDeps().deps,
    );
    const badDeployed = await preflightRenderTelegramCutover(
      preflightParams({ expectedCommitSha: "not-a-sha" }),
      createDeps().deps,
    );
    const wrongVersion = await preflightRenderTelegramCutover(
      preflightParams({ expectedVersion: "not-a-version" }),
      createDeps().deps,
    );
    const wrongDb = await preflightRenderTelegramCutover(
      preflightParams({
        databaseUrl:
          "postgresql://user:pass@example.com/neondb?sslmode=require",
      }),
      createDeps().deps,
    );
    check(
      "P2. Invalid checkout/deployed SHA, version, and database target are rejected before any Telegram mutation",
      badCheckout.code === "INVALID_CHECKOUT_SHA" &&
        badDeployed.code === "INVALID_EXPECTED_DEPLOYED_SHA" &&
        wrongVersion.code === "INVALID_EXPECTED_VERSION" &&
        wrongDb.code === "UNAUTHORIZED_DATABASE_URL_TARGET" &&
        badCheckout.pendingUpdateCount === null &&
        badDeployed.pendingUpdateCount === null &&
        wrongVersion.pendingUpdateCount === null &&
        wrongDb.pendingUpdateCount === null,
    );
  }

  // ─── 2b. Candidate checkout may preflight a different deployed SHA ───────
  {
    const readinessParams: Array<
      Parameters<RenderTelegramCutoverDeps["verifyRenderReadiness"]>[0]
    > = [];
    const { deps } = createDeps({
      onVerifyReadiness: (params) => readinessParams.push(params),
    });
    const result = await preflightRenderTelegramCutover(
      preflightParams({
        actualCommitSha: OTHER_SHA,
        expectedCommitSha: SHA,
      }),
      deps,
    );
    check(
      "P2b. Candidate checkout can preflight the currently deployed SHA and passes that deployed SHA to signed readiness",
      result.status === "READY" &&
        result.expectedCommitSha === SHA &&
        readinessParams.length === 1 &&
        readinessParams[0]?.expectedCommitSha === SHA &&
        readinessParams[0]?.cutoverSignerCred === FAKE_SIGNER_VALUE,
    );
  }

  // ─── 2c. Apply requires checkout SHA === deployed SHA ────────────────────
  {
    const { deps, getSwitchCalls } = createDeps();
    const result = await applyRenderTelegramCutover(
      {
        ...preflightParams({
          actualCommitSha: OTHER_SHA,
          expectedCommitSha: SHA,
        }),
        expectedCurrentWebhookUrl: CURRENT_URL,
      },
      deps,
    );
    check(
      "P2c. Apply is blocked when the checkout SHA differs from the deployed SHA",
      result.status === "BLOCKED" &&
        result.code === "APPLY_REQUIRES_CHECKOUT_EQUALS_DEPLOYED" &&
        getSwitchCalls() === 0,
    );
  }

  // ─── 3. Wrong bot identity blocks ─────────────────────────────────────────
  {
    const { deps } = createDeps({
      telegram: {
        me: {
          id: 9999999999,
          is_bot: true,
          username: "WrongBot",
        },
      },
    });
    const result = await preflightRenderTelegramCutover(
      preflightParams(),
      deps,
    );
    check(
      "P3. Wrong Telegram bot identity blocks the preflight",
      result.status === "FAILED" &&
        result.code === "BOT_IDENTITY_MISMATCH" &&
        result.actionsCredentialResolved === true &&
        result.botIdentityVerified === false,
    );
  }

  // ─── 4. Pending count validation and nonzero blocking ────────────────────
  {
    const unknownPending = await preflightRenderTelegramCutover(
      preflightParams(),
      createDeps({ telegram: { pendingUpdateCount: "0" } }).deps,
    );
    const negativePending = await preflightRenderTelegramCutover(
      preflightParams(),
      createDeps({ telegram: { pendingUpdateCount: -1 } }).deps,
    );
    const nonzeroPending = await preflightRenderTelegramCutover(
      preflightParams(),
      createDeps({ telegram: { pendingUpdateCount: 2 } }).deps,
    );
    const nonzeroApply = await applyRenderTelegramCutover(
      { ...preflightParams(), expectedCurrentWebhookUrl: CURRENT_URL },
      createDeps({
        telegram: { pendingUpdateCount: 2 },
        onSwitch: () => {
          throw new Error("SWITCH_MUST_NOT_BE_CALLED");
        },
      }).deps,
    );
    check(
      "P4. Unknown/malformed/nonzero pending counts are reported and block apply before mutation",
      unknownPending.status === "BLOCKED" &&
        unknownPending.code === "PENDING_UPDATE_COUNT_UNKNOWN" &&
        unknownPending.pendingUpdateCount === null &&
        unknownPending.pendingUpdateCountValid === false &&
        negativePending.status === "BLOCKED" &&
        negativePending.code === "PENDING_UPDATE_COUNT_UNKNOWN" &&
        nonzeroPending.status === "BLOCKED" &&
        nonzeroPending.code === "PENDING_UPDATES_REQUIRE_DISPOSITION" &&
        nonzeroPending.pendingUpdateCount === 2 &&
        nonzeroPending.readyForApply === false &&
        nonzeroApply.status === "BLOCKED" &&
        nonzeroApply.code === "PENDING_UPDATES_REQUIRE_DISPOSITION" &&
        nonzeroApply.ok === false,
    );
  }

  // ─── 5. Render-side readiness failure blocks apply ───────────────────────
  {
    const { deps, getSwitchCalls } = createDeps({
      readiness: {
        ok: false,
        code: "RENDER_CUTOVER_READINESS_UNAUTHORIZED",
      },
    });
    const preflight = await preflightRenderTelegramCutover(
      preflightParams(),
      deps,
    );
    const apply = await applyRenderTelegramCutover(
      { ...preflightParams(), expectedCurrentWebhookUrl: CURRENT_URL },
      deps,
    );
    check(
      "P5. Failed signed Render runtime readiness blocks apply without mutation",
      preflight.status === "BLOCKED" &&
        preflight.code === "RENDER_READINESS_NOT_VERIFIED" &&
        preflight.renderReadiness.ok === false &&
        apply.status === "BLOCKED" &&
        apply.code === "RENDER_READINESS_NOT_VERIFIED" &&
        getSwitchCalls() === 0,
    );
  }

  // ─── 6. Unresolved selected DB credential blocks apply ───────────────────
  {
    const { deps, getSwitchCalls } = createDeps();
    const unresolved = {
      ...deps,
      credentialsResolver: {
        resolve: async () => ({
          ok: false as const,
          code: "UNRESOLVED_REFERENCE" as const,
          message: "synthetic unresolved",
        }),
      },
    };
    const preflight = await preflightRenderTelegramCutover(
      preflightParams(),
      unresolved,
    );
    const apply = await applyRenderTelegramCutover(
      { ...preflightParams(), expectedCurrentWebhookUrl: CURRENT_URL },
      unresolved,
    );
    check(
      "P6. Unresolved selected runtime credential blocks apply without mutation",
      preflight.status === "FAILED" &&
        preflight.code === "CREDENTIALS_UNAVAILABLE" &&
        apply.status === "FAILED" &&
        apply.code === "CREDENTIALS_UNAVAILABLE" &&
        getSwitchCalls() === 0,
    );
  }

  // ─── 7. Wrong expected current URL blocks apply ──────────────────────────
  {
    const { deps, getSwitchCalls } = createDeps();
    const apply = await applyRenderTelegramCutover(
      {
        ...preflightParams(),
        expectedCurrentWebhookUrl: RENDER_TELEGRAM_CUTOVER_TARGET.webhookUrl,
      },
      deps,
    );
    check(
      "P7. Wrong expected current webhook URL blocks apply without mutation",
      apply.status === "BLOCKED" &&
        apply.code === "CURRENT_WEBHOOK_URL_MISMATCH" &&
        apply.ok === false &&
        getSwitchCalls() === 0,
    );
  }

  // ─── 8. Controlled successful apply ──────────────────────────────────────
  {
    const capturedParamsList: Array<
      Parameters<RenderTelegramCutoverDeps["switchWebhook"]>[0]
    > = [];
    const { deps, getSwitchCalls, getReadinessCalls } = createDeps({
      switchResult: switchedOutcome,
      onSwitch: (params) => {
        capturedParamsList.push(params);
      },
    });
    const apply = await applyRenderTelegramCutover(
      { ...preflightParams(), expectedCurrentWebhookUrl: CURRENT_URL },
      deps,
    );
    const capturedParams = capturedParamsList[0];
    check(
      "P8. Controlled apply performs exactly one switch with the fixed Render target, exact allowed updates, and fresh preflight",
      apply.status === "SWITCHED" &&
        apply.ok === true &&
        apply.code === "SWITCHED" &&
        apply.webhookSecretHashPersisted === true &&
        getSwitchCalls() === 1 &&
        getReadinessCalls() === 2 &&
        capturedParams !== undefined &&
        capturedParams.businessId ===
          RENDER_TELEGRAM_CUTOVER_TARGET.businessId &&
        capturedParams.connectionId ===
          RENDER_TELEGRAM_CUTOVER_TARGET.connectionId &&
        capturedParams.destinationUrl ===
          RENDER_TELEGRAM_CUTOVER_TARGET.webhookUrl &&
        capturedParams.expectedCurrentUrl === CURRENT_URL &&
        capturedParams.expectedBotExternalId ===
          RENDER_TELEGRAM_CUTOVER_TARGET.botExternalId &&
        capturedParams.apply === true &&
        capturedParams.allowAlreadyAtDestination === true &&
        capturedParams.requireZeroPendingUpdates === true &&
        capturedParams.allowedUpdates?.join(",") === "message,callback_query",
    );
  }

  // ─── 9. Already at destination is an idempotent no-op ────────────────────
  {
    const { deps, getSwitchCalls } = createDeps({
      telegram: { currentUrl: RENDER_TELEGRAM_CUTOVER_TARGET.webhookUrl },
    });
    const apply = await applyRenderTelegramCutover(
      {
        ...preflightParams(),
        expectedCurrentWebhookUrl: RENDER_TELEGRAM_CUTOVER_TARGET.webhookUrl,
      },
      deps,
    );
    check(
      "P9. Already-at-destination apply reports Telegram-observed settings and is a zero-write no-op",
      apply.status === "ALREADY_AT_DESTINATION" &&
        apply.ok === true &&
        apply.webhookUrl === RENDER_TELEGRAM_CUTOVER_TARGET.webhookUrl &&
        apply.allowedUpdates?.join(",") === "message,callback_query" &&
        apply.observedAllowedUpdates?.join(",") === "message,callback_query" &&
        apply.desiredAllowedUpdates?.join(",") === "message,callback_query" &&
        apply.exactSettingsMatch === true &&
        getSwitchCalls() === 0,
    );
  }

  // ─── 9b. Matching URL with wrong observed updates is not exact readiness ──
  {
    const { deps, getSwitchCalls } = createDeps({
      telegram: {
        currentUrl: RENDER_TELEGRAM_CUTOVER_TARGET.webhookUrl,
        allowedUpdates: ["message"],
      },
    });
    const preflight = await preflightRenderTelegramCutover(
      preflightParams(),
      deps,
    );
    const apply = await applyRenderTelegramCutover(
      {
        ...preflightParams(),
        expectedCurrentWebhookUrl: RENDER_TELEGRAM_CUTOVER_TARGET.webhookUrl,
      },
      deps,
    );
    check(
      "P9b. Matching Render URL with missing observed updates is reported as a mismatch and blocks apply",
      preflight.status === "BLOCKED" &&
        preflight.code === "ALREADY_AT_DESTINATION_SETTINGS_MISMATCH" &&
        preflight.exactSettingsMatch === false &&
        preflight.observedAllowedUpdates.join(",") === "message" &&
        preflight.desiredAllowedUpdates.join(",") ===
          "message,callback_query" &&
        apply.status === "BLOCKED" &&
        apply.code === "ALREADY_AT_DESTINATION_SETTINGS_MISMATCH" &&
        getSwitchCalls() === 0,
    );
  }

  // ─── 9c. Matching URL with extra observed updates is not exact readiness ──
  {
    const { deps, getSwitchCalls } = createDeps({
      telegram: {
        currentUrl: RENDER_TELEGRAM_CUTOVER_TARGET.webhookUrl,
        allowedUpdates: ["message", "callback_query", "inline_query"],
      },
    });
    const preflight = await preflightRenderTelegramCutover(
      preflightParams(),
      deps,
    );
    check(
      "P9c. Matching Render URL with additional observed updates is reported as a mismatch without mutation",
      preflight.status === "BLOCKED" &&
        preflight.code === "ALREADY_AT_DESTINATION_SETTINGS_MISMATCH" &&
        preflight.exactSettingsMatch === false &&
        preflight.observedAllowedUpdates.join(",") ===
          "message,callback_query,inline_query" &&
        getSwitchCalls() === 0,
    );
  }

  // ─── 10. Partial/ambiguous switch failure is not false success ───────────
  {
    const partialOutcome = {
      ok: false as const,
      status: "PARTIAL_FAILURE" as const,
      code: "SET_WEBHOOK_UNCERTAIN_RECOVERY_REQUIRED" as const,
      botExternalId: RENDER_TELEGRAM_CUTOVER_TARGET.botExternalId,
      botUsername: RENDER_TELEGRAM_CUTOVER_TARGET.botUsername,
      webhookUrl: RENDER_TELEGRAM_CUTOVER_TARGET.webhookUrl,
      targetAllowedUpdates: [...RENDER_TELEGRAM_CUTOVER_TARGET.allowedUpdates],
      pendingUpdateCount: 0,
      reconciliationCommand: "reviewed reconciliation",
      restorationProcedure: "reviewed restoration",
      remoteStateMayHaveChanged: true,
      message: "ambiguous",
    };
    const { deps, getSwitchCalls } = createDeps({
      switchResult: partialOutcome,
    });
    const apply = await applyRenderTelegramCutover(
      { ...preflightParams(), expectedCurrentWebhookUrl: CURRENT_URL },
      deps,
    );
    check(
      "P10. Partial/ambiguous Telegram failure returns no false success and performs no blind retry",
      apply.status === "PARTIAL_FAILURE" &&
        apply.ok === false &&
        apply.code === "SET_WEBHOOK_UNCERTAIN_RECOVERY_REQUIRED" &&
        apply.observedAllowedUpdates === undefined &&
        apply.observedAllowedUpdatesPhase === "UNKNOWN" &&
        apply.desiredAllowedUpdates?.join(",") === "message,callback_query" &&
        apply.exactSettingsMatch === false &&
        apply.remoteStateMayHaveChanged === true &&
        getSwitchCalls() === 1,
    );
  }

  // ─── 11. Real switch integration: pending gate and exact updates ─────────
  {
    const pendingOne = createRepo(baseConnection());
    const telegram = createTelegramFake({ pendingUpdateCount: 1 });
    const result = await switchTelegramBotWebhook(
      {
        api: telegram.api,
        connectionRepository: pendingOne.repository,
        credentialsResolver: fakeResolver,
        generateWebhookSecret: () => "candidate-secret",
        hashWebhookSecret: (secret) => `hash:${secret}`,
      },
      {
        businessId: RENDER_TELEGRAM_CUTOVER_TARGET.businessId,
        connectionId: RENDER_TELEGRAM_CUTOVER_TARGET.connectionId,
        expectedCurrentUrl: CURRENT_URL,
        destinationUrl: RENDER_TELEGRAM_CUTOVER_TARGET.webhookUrl,
        expectedBotExternalId: RENDER_TELEGRAM_CUTOVER_TARGET.botExternalId,
        apply: true,
        requireZeroPendingUpdates: true,
        allowedUpdates: ["message", "callback_query"],
      },
    );
    check(
      "P11. Real switch blocks nonzero pending updates before setWebhook or DB writes",
      result.ok === false &&
        result.code === "PENDING_UPDATES_REQUIRE_DISPOSITION" &&
        telegram.getSetWebhookCount() === 0 &&
        pendingOne.getUpdateCount() === 0,
    );
  }

  // ─── 12. Real switch integration: successful controlled apply ────────────
  {
    const repo = createRepo(baseConnection());
    const telegram = createTelegramFake({
      currentUrl: CURRENT_URL,
      pendingUpdateCount: 0,
    });
    const result = await switchTelegramBotWebhook(
      {
        api: telegram.api,
        connectionRepository: repo.repository,
        credentialsResolver: fakeResolver,
        generateWebhookSecret: () => "candidate-secret",
        hashWebhookSecret: (secret) => `hash:${secret}`,
      },
      {
        businessId: RENDER_TELEGRAM_CUTOVER_TARGET.businessId,
        connectionId: RENDER_TELEGRAM_CUTOVER_TARGET.connectionId,
        expectedCurrentUrl: CURRENT_URL,
        destinationUrl: RENDER_TELEGRAM_CUTOVER_TARGET.webhookUrl,
        expectedBotExternalId: RENDER_TELEGRAM_CUTOVER_TARGET.botExternalId,
        apply: true,
        allowAlreadyAtDestination: true,
        requireZeroPendingUpdates: true,
        allowedUpdates: ["message", "callback_query"],
      },
    );
    const body = telegram.getSetWebhookBody();
    check(
      "P12. Real switch applies the exact Render URL and allowed updates with one setWebhook and persisted hash",
      result.ok === true &&
        result.status === "SWITCHED" &&
        telegram.getSetWebhookCount() === 1 &&
        body !== null &&
        body.url === RENDER_TELEGRAM_CUTOVER_TARGET.webhookUrl &&
        Array.isArray(body.allowed_updates) &&
        body.allowed_updates.join(",") === "message,callback_query" &&
        body.secret_token === "candidate-secret" &&
        (!("drop_pending_updates" in body) ||
          body.drop_pending_updates === false) &&
        repo.getUpdateCount() === 1 &&
        result.webhookSecretHashPersisted === true &&
        result.observedAllowedUpdates?.join(",") === "message,callback_query" &&
        result.desiredAllowedUpdates?.join(",") === "message,callback_query" &&
        result.exactSettingsMatch === true,
    );
  }

  // ─── 13. Real switch integration: already at destination ─────────────────
  {
    const repo = createRepo(baseConnection());
    const telegram = createTelegramFake({
      currentUrl: RENDER_TELEGRAM_CUTOVER_TARGET.webhookUrl,
      pendingUpdateCount: 0,
    });
    const result = await switchTelegramBotWebhook(
      {
        api: telegram.api,
        connectionRepository: repo.repository,
        credentialsResolver: fakeResolver,
        generateWebhookSecret: () => "candidate-secret",
        hashWebhookSecret: (secret) => `hash:${secret}`,
      },
      {
        businessId: RENDER_TELEGRAM_CUTOVER_TARGET.businessId,
        connectionId: RENDER_TELEGRAM_CUTOVER_TARGET.connectionId,
        expectedCurrentUrl: CURRENT_URL,
        destinationUrl: RENDER_TELEGRAM_CUTOVER_TARGET.webhookUrl,
        expectedBotExternalId: RENDER_TELEGRAM_CUTOVER_TARGET.botExternalId,
        apply: true,
        allowAlreadyAtDestination: true,
        requireZeroPendingUpdates: true,
        allowedUpdates: ["message", "callback_query"],
      },
    );
    check(
      "P13. Real switch returns an idempotent no-op with observed settings when already at the Render destination",
      result.ok === true &&
        result.status === "ALREADY_AT_DESTINATION" &&
        result.allowedUpdates.join(",") === "message,callback_query" &&
        result.observedAllowedUpdates?.join(",") === "message,callback_query" &&
        result.desiredAllowedUpdates?.join(",") === "message,callback_query" &&
        result.exactSettingsMatch === true &&
        telegram.getSetWebhookCount() === 0 &&
        repo.getUpdateCount() === 0,
    );
  }

  // ─── 14. Real switch integration: ambiguous Telegram response ────────────
  {
    const repo = createRepo(baseConnection());
    const telegram = createTelegramFake({
      currentUrl: CURRENT_URL,
      pendingUpdateCount: 0,
      setWebhookThrows: true,
    });
    const result = await switchTelegramBotWebhook(
      {
        api: telegram.api,
        connectionRepository: repo.repository,
        credentialsResolver: fakeResolver,
        generateWebhookSecret: () => "candidate-secret",
        hashWebhookSecret: (secret) => `hash:${secret}`,
      },
      {
        businessId: RENDER_TELEGRAM_CUTOVER_TARGET.businessId,
        connectionId: RENDER_TELEGRAM_CUTOVER_TARGET.connectionId,
        expectedCurrentUrl: CURRENT_URL,
        destinationUrl: RENDER_TELEGRAM_CUTOVER_TARGET.webhookUrl,
        expectedBotExternalId: RENDER_TELEGRAM_CUTOVER_TARGET.botExternalId,
        apply: true,
        allowAlreadyAtDestination: true,
        requireZeroPendingUpdates: true,
        allowedUpdates: ["message", "callback_query"],
      },
    );
    check(
      "P14. Real switch reports ambiguous setWebhook as uncertain without DB writes or retry",
      result.ok === false &&
        result.status === "PARTIAL_FAILURE" &&
        result.code === "SET_WEBHOOK_UNCERTAIN_RECOVERY_REQUIRED" &&
        result.remoteStateMayHaveChanged === true &&
        telegram.getSetWebhookCount() === 1 &&
        repo.getUpdateCount() === 0,
    );
  }

  // ─── 15. Signed Render readiness verifier ────────────────────────────────
  {
    const observedHeadersList: Headers[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      observedHeadersList.push(new Headers(init?.headers));
      return new Response(
        JSON.stringify({
          ok: true,
          checkedAt: "2026-11-18T22:00:00.000Z",
          commitSha: SHA,
          version: VERSION,
          databaseHost: "ep-little-mouse-a5nh644n.us-east-2.aws.neon.tech",
          databaseName: "neondb",
          businessId: RENDER_TELEGRAM_CUTOVER_TARGET.businessId,
          connectionId: RENDER_TELEGRAM_CUTOVER_TARGET.connectionId,
          botExternalId: RENDER_TELEGRAM_CUTOVER_TARGET.botExternalId,
          botUsername: RENDER_TELEGRAM_CUTOVER_TARGET.botUsername,
          credentialResolved: true,
        }),
        { status: 200 },
      );
    };
    const ok = await verifyRenderRuntimeReadiness(
      {
        renderOrigin: RENDER_TELEGRAM_CUTOVER_TARGET.origin,
        expectedCommitSha: SHA,
        expectedVersion: VERSION,
        databaseUrl: DB_URL,
        cutoverSignerCred: FAKE_SIGNER_VALUE,
      },
      { fetchImpl, now: () => FIXED_NOW },
    );
    const unauthorized = await verifyRenderRuntimeReadiness(
      {
        renderOrigin: RENDER_TELEGRAM_CUTOVER_TARGET.origin,
        expectedCommitSha: SHA,
        expectedVersion: VERSION,
        databaseUrl: DB_URL,
        cutoverSignerCred: FAKE_SIGNER_VALUE,
      },
      {
        fetchImpl: async () => new Response("{}", { status: 401 }),
        now: () => FIXED_NOW,
      },
    );
    const wrongOrigin = await verifyRenderRuntimeReadiness(
      {
        renderOrigin: "https://flowpilot-prod.vercel.app",
        expectedCommitSha: SHA,
        expectedVersion: VERSION,
        databaseUrl: DB_URL,
        cutoverSignerCred: FAKE_SIGNER_VALUE,
      },
      { fetchImpl, now: () => FIXED_NOW },
    );
    const capturedHeaders = observedHeadersList[0];
    check(
      "P15. Signed Render readiness verifies identity, DB, SHA/version, and rejects unauthorized/legacy origins",
      ok.ok === true &&
        ok.credentialResolved === true &&
        ok.databaseHost ===
          "ep-little-mouse-a5nh644n.us-east-2.aws.neon.tech" &&
        capturedHeaders !== undefined &&
        capturedHeaders.get("x-flowpilot-cutover-bot-id") ===
          RENDER_TELEGRAM_CUTOVER_TARGET.botExternalId &&
        capturedHeaders.get("x-flowpilot-cutover-timestamp") ===
          String(FIXED_NOW) &&
        /^[0-9a-f]{64}$/.test(
          capturedHeaders.get("x-flowpilot-cutover-signature") ?? "",
        ) &&
        unauthorized.ok === false &&
        unauthorized.code === "RENDER_CUTOVER_READINESS_UNAUTHORIZED" &&
        wrongOrigin.ok === false &&
        wrongOrigin.code === "INVALID_RENDER_ORIGIN",
    );
  }

  // ─── 16. Exact post-apply set verification ───────────────────────────────
  {
    const exact = await runRealSwitch({
      allowedUpdates: ["message", "callback_query"],
      postAllowedUpdates: ["message", "callback_query"],
    });
    const extra = await runRealSwitch({
      allowedUpdates: ["message", "callback_query"],
      postAllowedUpdates: ["message", "callback_query", "inline_query"],
    });
    const missing = await runRealSwitch({
      allowedUpdates: ["message", "callback_query"],
      postAllowedUpdates: ["message"],
    });
    const malformed = await runRealSwitch({
      allowedUpdates: ["message", "callback_query"],
      postAllowedUpdates: "not-an-array",
    });
    const legacy = await runRealSwitch({
      postAllowedUpdates: ["message", "callback_query", "inline_query"],
    });
    check(
      "P16. Exact post-apply verification rejects extra/missing/malformed sets and preserves legacy merge behavior",
      exact.result.ok === true &&
        exact.result.status === "SWITCHED" &&
        exact.result.exactSettingsMatch === true &&
        extra.result.ok === false &&
        extra.result.code === "POST_APPLY_REGISTRATION_MISMATCH" &&
        extra.telegram.getSetWebhookCount() === 1 &&
        missing.result.ok === false &&
        missing.result.code === "POST_APPLY_REGISTRATION_MISMATCH" &&
        malformed.result.ok === false &&
        malformed.result.code === "POST_APPLY_REGISTRATION_MISMATCH" &&
        legacy.result.ok === true &&
        legacy.result.status === "SWITCHED" &&
        legacy.telegram.getSetWebhookCount() === 1,
    );
  }

  // ─── 17. Successful setWebhook + DB persistence failure is partial ───────
  {
    let dbUpdateAttempts = 0;
    const failingRepo = {
      findByIdWithinBusiness: async () => baseConnection(),
      updateWebhookSecretHash: async () => {
        dbUpdateAttempts += 1;
        throw new Error("DB_FAIL");
      },
      update: async () => {
        dbUpdateAttempts += 1;
        throw new Error("DB_FAIL");
      },
    } as unknown as RepairTelegramWebhookDeps["connectionRepository"];
    const { result, telegram } = await runRealSwitch({
      allowedUpdates: ["message", "callback_query"],
      repository: failingRepo,
    });
    check(
      "P17. Successful setWebhook followed by DB persistence failure is partial, never false success, and is not retried on Telegram",
      result.ok === false &&
        result.status === "PARTIAL_FAILURE" &&
        result.code === "PARTIAL_APPLICATION_RECOVERY_REQUIRED" &&
        telegram.getSetWebhookCount() === 1 &&
        dbUpdateAttempts > 0,
    );
  }

  // ─── 18. Explicit reconciliation rotates in place once ──────────────────
  {
    const capturedList: SwitchTelegramWebhookParams[] = [];
    const { deps, getSwitchCalls } = createDeps({
      telegram: { currentUrl: RENDER_TELEGRAM_CUTOVER_TARGET.webhookUrl },
      switchResult: switchedOutcome,
      onSwitch: (params) => capturedList.push(params),
    });
    const result = await reconcileRenderTelegramCutover(
      {
        ...preflightParams(),
        expectedCurrentWebhookUrl: RENDER_TELEGRAM_CUTOVER_TARGET.webhookUrl,
      },
      deps,
    );
    const captured = capturedList[0];
    check(
      "P18. Explicit reconciliation requires Render current URL/zero backlog and rotates in place exactly once",
      result.status === "RECONCILED" &&
        result.ok === true &&
        getSwitchCalls() === 1 &&
        captured !== undefined &&
        captured.expectedCurrentUrl ===
          RENDER_TELEGRAM_CUTOVER_TARGET.webhookUrl &&
        captured.destinationUrl === RENDER_TELEGRAM_CUTOVER_TARGET.webhookUrl &&
        captured.apply === true &&
        captured.allowAlreadyAtDestination === false &&
        captured.requireZeroPendingUpdates === true &&
        captured.allowedUpdates?.join(",") === "message,callback_query",
    );
  }

  // ─── 19. Reconciliation guards: current URL and zero backlog ────────────
  {
    const wrongUrlDeps = createDeps();
    const wrongUrl = await reconcileRenderTelegramCutover(
      {
        ...preflightParams(),
        expectedCurrentWebhookUrl: RENDER_TELEGRAM_CUTOVER_TARGET.webhookUrl,
      },
      wrongUrlDeps.deps,
    );
    const pendingDeps = createDeps({
      telegram: {
        currentUrl: RENDER_TELEGRAM_CUTOVER_TARGET.webhookUrl,
        pendingUpdateCount: 2,
      },
    });
    const pending = await reconcileRenderTelegramCutover(
      {
        ...preflightParams(),
        expectedCurrentWebhookUrl: RENDER_TELEGRAM_CUTOVER_TARGET.webhookUrl,
      },
      pendingDeps.deps,
    );
    check(
      "P19. Reconciliation blocks a non-Render current URL and any nonzero backlog without mutation",
      wrongUrl.status === "BLOCKED" &&
        wrongUrl.code === "RECONCILIATION_REQUIRES_RENDER_CURRENT_URL" &&
        wrongUrlDeps.getSwitchCalls() === 0 &&
        pending.status === "BLOCKED" &&
        pending.code === "PENDING_UPDATES_REQUIRE_DISPOSITION" &&
        pendingDeps.getSwitchCalls() === 0,
    );
  }

  // ─── 20. Reconciliation fixes a matching URL with wrong observed updates ─
  {
    const { deps, getSwitchCalls } = createDeps({
      telegram: {
        currentUrl: RENDER_TELEGRAM_CUTOVER_TARGET.webhookUrl,
        allowedUpdates: ["message"],
      },
      switchResult: switchedOutcome,
    });
    const result = await reconcileRenderTelegramCutover(
      {
        ...preflightParams(),
        expectedCurrentWebhookUrl: RENDER_TELEGRAM_CUTOVER_TARGET.webhookUrl,
      },
      deps,
    );
    check(
      "P20. Reconciliation is the explicit corrective operation for a matching URL with wrong observed updates",
      result.status === "RECONCILED" &&
        result.ok === true &&
        getSwitchCalls() === 1,
    );
  }

  // ─── 21. Reconciliation partial failure is never automatically retried ───
  {
    const partialOutcome = {
      ok: false as const,
      status: "PARTIAL_FAILURE" as const,
      code: "SET_WEBHOOK_UNCERTAIN_RECOVERY_REQUIRED" as const,
      botExternalId: RENDER_TELEGRAM_CUTOVER_TARGET.botExternalId,
      botUsername: RENDER_TELEGRAM_CUTOVER_TARGET.botUsername,
      webhookUrl: RENDER_TELEGRAM_CUTOVER_TARGET.webhookUrl,
      targetAllowedUpdates: [...RENDER_TELEGRAM_CUTOVER_TARGET.allowedUpdates],
      pendingUpdateCount: 0,
      reconciliationCommand: "reviewed reconciliation",
      restorationProcedure: "reviewed restoration",
      remoteStateMayHaveChanged: true,
      message: "ambiguous",
    };
    const { deps, getSwitchCalls } = createDeps({
      telegram: { currentUrl: RENDER_TELEGRAM_CUTOVER_TARGET.webhookUrl },
      switchResult: partialOutcome,
    });
    const result = await reconcileRenderTelegramCutover(
      {
        ...preflightParams(),
        expectedCurrentWebhookUrl: RENDER_TELEGRAM_CUTOVER_TARGET.webhookUrl,
      },
      deps,
    );
    check(
      "P21. Reconciliation partial failure returns no false success and performs no automatic retry",
      result.status === "PARTIAL_FAILURE" &&
        result.ok === false &&
        result.code === "SET_WEBHOOK_UNCERTAIN_RECOVERY_REQUIRED" &&
        result.observedAllowedUpdates === undefined &&
        result.observedAllowedUpdatesPhase === "UNKNOWN" &&
        result.desiredAllowedUpdates?.join(",") === "message,callback_query" &&
        result.exactSettingsMatch === false &&
        getSwitchCalls() === 1,
    );
  }

  // ─── 22. Malformed raw observations cannot become exact readiness ────────
  {
    const malformedCases: Array<{
      label: string;
      raw: unknown;
      observed: string;
    }> = [
      {
        label: "mixed valid/non-string array",
        raw: ["message", "callback_query", 42],
        observed: "message,callback_query",
      },
      {
        label: "non-array value",
        raw: "message,callback_query",
        observed: "",
      },
      {
        label: "missing value",
        raw: undefined,
        observed: "",
      },
      {
        label: "null value",
        raw: null,
        observed: "",
      },
    ];
    for (const item of malformedCases) {
      const { deps, getSwitchCalls } = createDeps({
        telegram: {
          currentUrl: RENDER_TELEGRAM_CUTOVER_TARGET.webhookUrl,
          allowedUpdates: item.raw,
        },
      });
      const preflight = await preflightRenderTelegramCutover(
        preflightParams(),
        deps,
      );
      const apply = await applyRenderTelegramCutover(
        {
          ...preflightParams(),
          expectedCurrentWebhookUrl: RENDER_TELEGRAM_CUTOVER_TARGET.webhookUrl,
        },
        deps,
      );
      check(
        `P22. Malformed raw allowed_updates (${item.label}) blocks exact readiness and apply`,
        preflight.status === "BLOCKED" &&
          preflight.code === "OBSERVED_ALLOWED_UPDATES_MALFORMED" &&
          preflight.allowedUpdatesValid === false &&
          preflight.exactSettingsMatch === false &&
          preflight.observedAllowedUpdates.join(",") === item.observed &&
          apply.status === "BLOCKED" &&
          apply.code === "OBSERVED_ALLOWED_UPDATES_MALFORMED" &&
          getSwitchCalls() === 0,
      );
    }

    const reversed = createDeps({
      telegram: {
        currentUrl: RENDER_TELEGRAM_CUTOVER_TARGET.webhookUrl,
        allowedUpdates: ["callback_query", "message"],
      },
    });
    const reversedPreflight = await preflightRenderTelegramCutover(
      preflightParams(),
      reversed.deps,
    );
    check(
      "P22b. Valid reversed-order observations remain an exact no-op",
      reversedPreflight.status === "ALREADY_AT_DESTINATION" &&
        reversedPreflight.allowedUpdatesValid === true &&
        reversedPreflight.exactSettingsMatch === true &&
        reversedPreflight.observedAllowedUpdates.join(",") ===
          "callback_query,message" &&
        reversed.getSwitchCalls() === 0,
    );
  }

  // ─── 23. Explicit switch rejects malformed current raw; legacy preserved ──
  {
    const explicitMalformed = await runRealSwitch({
      currentAllowedUpdates: ["message", "callback_query", 42],
      allowedUpdates: ["message", "callback_query"],
    });
    const explicitNonArray = await runRealSwitch({
      currentAllowedUpdates: "message",
      allowedUpdates: ["message", "callback_query"],
    });
    const explicitMissing = await runRealSwitch({
      currentAllowedUpdates: undefined,
      allowedUpdates: ["message", "callback_query"],
    });
    const explicitReversed = await runRealSwitch({
      currentAllowedUpdates: ["callback_query", "message"],
      allowedUpdates: ["message", "callback_query"],
    });
    const legacyMixed = await runRealSwitch({
      currentAllowedUpdates: ["message", "callback_query", 42],
    });
    check(
      "P23. Explicit allowedUpdates rejects mixed/non-array/missing raw current sets before setWebhook",
      explicitMalformed.result.ok === false &&
        explicitMalformed.result.code === "MALFORMED_ALLOWED_UPDATES" &&
        explicitMalformed.telegram.getSetWebhookCount() === 0 &&
        explicitMalformed.repo.getUpdateCount() === 0 &&
        explicitNonArray.result.ok === false &&
        explicitNonArray.result.code === "MALFORMED_ALLOWED_UPDATES" &&
        explicitNonArray.telegram.getSetWebhookCount() === 0 &&
        explicitMissing.result.ok === false &&
        explicitMissing.result.code === "MALFORMED_ALLOWED_UPDATES" &&
        explicitMissing.telegram.getSetWebhookCount() === 0,
    );
    check(
      "P23b. Valid reversed-order raw current set is exact; legacy callers keep their prior behavior",
      explicitReversed.result.ok === true &&
        explicitReversed.result.status === "SWITCHED" &&
        explicitReversed.result.exactSettingsMatch === true &&
        explicitReversed.telegram.getSetWebhookCount() === 1 &&
        legacyMixed.result.ok === true &&
        legacyMixed.result.status === "SWITCHED" &&
        legacyMixed.result.observedAllowedUpdatesValid === false &&
        legacyMixed.result.exactSettingsMatch === false &&
        legacyMixed.telegram.getSetWebhookCount() === 1,
    );
  }

  // ─── 24. Malformed post-apply observations are rejected, not normalized ─
  {
    const mixedPost = await runRealSwitch({
      allowedUpdates: ["message", "callback_query"],
      postAllowedUpdates: ["message", "callback_query", 42],
    });
    const nonArrayPost = await runRealSwitch({
      allowedUpdates: ["message", "callback_query"],
      postAllowedUpdates: "message",
    });
    const missingPost = await runRealSwitch({
      allowedUpdates: ["message", "callback_query"],
      postAllowedUpdates: undefined,
    });
    const reversedPost = await runRealSwitch({
      allowedUpdates: ["message", "callback_query"],
      postAllowedUpdates: ["callback_query", "message"],
    });
    check(
      "P24. Exact post-apply rejects mixed/non-array/missing raw observations and accepts reversed order",
      mixedPost.result.ok === false &&
        mixedPost.result.code === "POST_APPLY_REGISTRATION_MISMATCH" &&
        mixedPost.result.observedAllowedUpdatesValid === false &&
        mixedPost.telegram.getSetWebhookCount() === 1 &&
        nonArrayPost.result.ok === false &&
        nonArrayPost.result.code === "POST_APPLY_REGISTRATION_MISMATCH" &&
        nonArrayPost.result.observedAllowedUpdatesValid === false &&
        missingPost.result.ok === false &&
        missingPost.result.code === "POST_APPLY_REGISTRATION_MISMATCH" &&
        missingPost.result.observedAllowedUpdatesValid === false &&
        reversedPost.result.ok === true &&
        reversedPost.result.status === "SWITCHED" &&
        reversedPost.result.exactSettingsMatch === true,
    );
  }

  // ─── 25. Actual post-operation observations stay separate from desired ───
  {
    const partialWithObserved = {
      ok: false as const,
      status: "PARTIAL_FAILURE" as const,
      code: "POST_APPLY_REGISTRATION_MISMATCH" as const,
      botExternalId: RENDER_TELEGRAM_CUTOVER_TARGET.botExternalId,
      botUsername: RENDER_TELEGRAM_CUTOVER_TARGET.botUsername,
      webhookUrl: RENDER_TELEGRAM_CUTOVER_TARGET.webhookUrl,
      targetAllowedUpdates: [...RENDER_TELEGRAM_CUTOVER_TARGET.allowedUpdates],
      observedAllowedUpdates: ["message"],
      observedAllowedUpdatesValid: true,
      desiredAllowedUpdates: [...RENDER_TELEGRAM_CUTOVER_TARGET.allowedUpdates],
      exactSettingsMatch: false,
      pendingUpdateCount: 0,
      reconciliationCommand: "reviewed reconciliation",
      restorationProcedure: "reviewed restoration",
      remoteStateMayHaveChanged: true,
      message: "mismatch",
    };
    const { deps } = createDeps({ switchResult: partialWithObserved });
    const apply = await applyRenderTelegramCutover(
      { ...preflightParams(), expectedCurrentWebhookUrl: CURRENT_URL },
      deps,
    );
    check(
      "P25. Partial failure reports actual post-operation observation separately from desired settings",
      apply.status === "PARTIAL_FAILURE" &&
        apply.observedAllowedUpdates?.join(",") === "message" &&
        apply.observedAllowedUpdatesValid === true &&
        apply.observedAllowedUpdatesPhase === "POST_OPERATION" &&
        apply.desiredAllowedUpdates?.join(",") === "message,callback_query" &&
        apply.exactSettingsMatch === false,
    );
  }
}

main()
  .then(() => {
    let failed = 0;
    for (const item of checks) {
      if (item.pass) {
        console.log(`✔ ${item.label}`);
      } else {
        console.error(`✘ ${item.label}`);
        failed += 1;
      }
    }
    if (failed > 0) {
      console.error(
        `\nFailed ${failed} of ${checks.length} Render cutover checks.`,
      );
      process.exit(1);
    }
    console.log(
      `\nAll ${checks.length}/${checks.length} Render cutover checks PASSED.`,
    );
  })
  .catch((err: unknown) => {
    console.error(
      "Unexpected error in check-render-telegram-cutover:",
      err instanceof Error && /^[A-Z0-9_]+$/.test(err.message)
        ? err.message
        : "UNEXPECTED_ERROR",
    );
    process.exit(1);
  });
