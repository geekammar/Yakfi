#!/usr/bin/env node
/**
 * Yakfi — Render Migration Preparation Offline Verification Suite.
 *
 * Verifies:
 * 1. Reproducible Render Blueprint (`render.yaml`) & Node/pnpm pinning
 * 2. Platform-neutral `/sw.js` & `/offline.html` headers in `next.config.ts`
 * 3. `RENDER_GIT_COMMIT` identity, QA harness block & JEV budget guard
 * 4. Better Auth `trustedOrigins` & URL resolution without fake `VERCEL_ENV`
 * 5. Explicit release target & exact 40-char SHA gate
 * 6. Values-free environment inventory completeness & zero-secret hygiene
 * 7. Owner-encrypted secret bundle, restoration check, workspace pinning
 *    (`tea-db9st3gm7kps73ek9op0`), allowlist & webhook backlog policy
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { isPublicPath } from "@/lib/public-paths";
import { isQaHarnessAllowed } from "@/lib/qa-harness";
import {
  isRenderProductionRuntime,
  resolveRuntimeCommitSha,
  resolveRuntimeEnvironmentLabel,
} from "@/lib/runtime-identity";
import {
  getTrustedOrigins,
  isVercelPreview,
  resolveAppUrl,
} from "@/lib/url-resolver";
import { isTypeSafeJevPreferred } from "@/server/integrations/ai/factory";
import { signCutoverReadiness } from "@/server/operator/cutover-readiness";

import nextConfig, { PLATFORM_NEUTRAL_PWA_HEADERS } from "../next.config";
import {
  CONFIRMED_RENDER_REGION,
  CONFIRMED_RENDER_WORKSPACE_ID,
  encryptAllowlistedSecretsForOwner,
  generateOwnerRecoveryKeypair,
  inspectRecoverySources,
  parseAllowlist,
  transferAllowlistedSecretsToRender,
  verifyOwnerEncryptedBundle,
  verifyRenderCutoverReadinessAndBacklog,
} from "./render-vault-tool";
import {
  evaluateLiveHealthResponse,
  pollProductionReleaseReadiness,
  validateReleaseTargetInputs,
} from "./verify-production-release.mjs";

type CheckRecord = { label: string; pass: boolean };
const checks: CheckRecord[] = [];

function check(label: string, condition: boolean): void {
  checks.push({ label, pass: Boolean(condition) });
}

const REQUIRED_INVENTORY_FIELDS = [
  "name",
  "purpose",
  "environment",
  "requiredStatus",
  "recoverySource",
  "recoveryState",
  "replacementImpact",
  "owner",
  "vaultItemRef",
  "verificationDate",
  "nextAction",
] as const;

const REQUIRED_INVENTORY_VAR_NAMES = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "NEXT_PUBLIC_APP_URL",
  "CREDENTIAL_MASTER_KEY",
  "OPENROUTER_API_KEY",
  "TELEGRAM_MANAGER_BOT_TOKEN",
  "TELEGRAM_MANAGER_BOT_USERNAME",
  "AGENTROUTER_API_KEY",
  "ATRIA_API_KEY",
  "CODECRAFT_API_KEY",
  "INBOUND_WEBHOOK_TOKEN",
  "FLOWPILOT_TEST_INGRESS_TOKEN",
  "WHATSAPP_META_VERIFY_TOKEN",
  "WHATSAPP_META_APP_SECRET",
  "WHATSAPP_META_ACCESS_TOKEN",
  "WHATSAPP_META_PHONE_NUMBER_ID",
  "WHATSAPP_META_APP_ID",
  "WHATSAPP_META_EMBEDDED_SIGNUP_CONFIG_ID",
  "WHATSAPP_META_API_VERSION",
  "APPOINTMENT_REMINDERS_ENABLED",
  "CRON_SECRET",
  "FLOWPILOT_JEV_SEMANTIC_ENABLED",
  "FLOWPILOT_JEV_APPROVED_MONTHLY_BUDGET",
  "FLOWPILOT_JEV_SHADOW_ENABLED",
  "SHADOW_SALT",
  "SHADOW_SAMPLE_RATE",
  "SHADOW_MAX_CALLS_PER_DAY",
  "JEV_SHADOW_TIMEOUT_MS",
  "FLOWPILOT_AI_GLOBAL_STOP",
  "FLOWPILOT_AI_MAX_SERVING_ATTEMPTS",
  "TURN_EVIDENCE_DISABLED",
  "OTEL_TURN_EVIDENCE_ENABLED",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "RENDER_GIT_COMMIT",
  "PORT",
] as const;

async function main(): Promise<void> {
  const root = process.cwd();

  // ─── 1. Render Blueprint & Version Pinning ────────────────────────────────
  const nodeVerPath = resolve(root, ".node-version");
  const nodeVersion = readFileSync(nodeVerPath, "utf8").trim();
  const pkgRaw = readFileSync(resolve(root, "package.json"), "utf8");
  const pkg = JSON.parse(pkgRaw) as {
    engines?: { node?: string };
    packageManager?: string;
    scripts?: Record<string, string>;
  };
  const renderYaml = readFileSync(resolve(root, "render.yaml"), "utf8");
  const renderStartScript = pkg.scripts?.["start:render"] ?? "";

  check(
    "R1.1 .node-version pins Node 22 matching package.json engines.node (22.x)",
    nodeVersion === "22" && pkg.engines?.node === "22.x",
  );
  check(
    "R1.2 render.yaml pins pnpm@11.24.0 frozen-lockfile + prisma generate + AI prompts/Next build",
    pkg.packageManager === "pnpm@11.24.0" &&
      renderYaml.includes("corepack prepare pnpm@11.24.0 --activate") &&
      renderYaml.includes("pnpm install --frozen-lockfile --prod=false") &&
      renderYaml.includes("pnpm db:generate && pnpm build"),
  );
  check(
    "R1.3 render.yaml configures single starter Node web service in ohio on 0.0.0.0:$PORT",
    renderYaml.includes("type: web") &&
      renderYaml.includes("runtime: node") &&
      renderYaml.includes("plan: starter") &&
      renderYaml.includes("region: ohio") &&
      renderYaml.includes("autoDeployTrigger: off") &&
      renderYaml.includes("healthCheckPath: /api/health/live") &&
      renderYaml.includes("startCommand: pnpm run start:render") &&
      renderStartScript.includes("--hostname 0.0.0.0") &&
      renderStartScript.includes("PORT"),
  );
  check(
    "R1.4 render.yaml excludes DB migrations, seed, cron, worker, redis, and disk",
    !renderYaml.includes("db:deploy") &&
      !renderYaml.includes("prisma migrate") &&
      !renderYaml.includes("db:push") &&
      !renderYaml.includes("db:seed") &&
      !renderYaml.includes("type: cron") &&
      !renderYaml.includes("type: worker") &&
      !renderYaml.includes("type: keyvalue") &&
      !renderYaml.includes("type: redis") &&
      !renderYaml.includes("disks:") &&
      !renderYaml.includes("VERCEL_ENV"),
  );

  // ─── 2. Platform-Neutral PWA Cache-Control Headers ────────────────────────
  const vercelRaw = readFileSync(resolve(root, "vercel.json"), "utf8");
  const vercelJson = JSON.parse(vercelRaw) as Record<string, unknown>;
  const resolvedHeaders = nextConfig.headers ? await nextConfig.headers() : [];
  const swHeader = resolvedHeaders.find((h) => h.source === "/sw.js");
  const offlineHeader = resolvedHeaders.find(
    (h) => h.source === "/offline.html",
  );
  const expectedCache = "public, max-age=0, must-revalidate";

  check(
    "R2.1 next.config.ts defines Cache-Control: public, max-age=0, must-revalidate for /sw.js and /offline.html",
    PLATFORM_NEUTRAL_PWA_HEADERS.length === 2 &&
      swHeader?.headers[0]?.key === "Cache-Control" &&
      swHeader?.headers[0]?.value === expectedCache &&
      offlineHeader?.headers[0]?.key === "Cache-Control" &&
      offlineHeader?.headers[0]?.value === expectedCache,
  );
  check(
    "R2.2 vercel.json retains buildCommand & ignoreCommand without platform-only headers or crons",
    vercelJson.buildCommand === "pnpm db:generate && pnpm build" &&
      !Object.prototype.hasOwnProperty.call(vercelJson, "headers") &&
      !Object.prototype.hasOwnProperty.call(vercelJson, "crons"),
  );

  // ─── 3. Runtime Identity, Public Probe Paths, QA Guard & JEV Budget ───────
  const renderSha = "1".repeat(40);
  const vercelSha = "2".repeat(40);
  const fromRender = resolveRuntimeCommitSha({ RENDER_GIT_COMMIT: renderSha });
  const fromVercel = resolveRuntimeCommitSha({
    VERCEL_GIT_COMMIT_SHA: vercelSha,
  });
  const fromBoth = resolveRuntimeCommitSha({
    RENDER_GIT_COMMIT: renderSha,
    VERCEL_GIT_COMMIT_SHA: vercelSha,
  });

  check(
    "R3.1 resolveRuntimeCommitSha supports RENDER_GIT_COMMIT and VERCEL_GIT_COMMIT_SHA",
    fromRender === renderSha &&
      fromVercel === vercelSha &&
      fromBoth === renderSha &&
      resolveRuntimeCommitSha({}) === null,
  );

  const renderPrEnv = { RENDER: "true", RENDER_IS_PULL_REQUEST: "true" };
  const renderHarnessEnv = {
    RENDER: "true",
    FLOWPILOT_ENABLE_QA_HARNESS: "true",
  };
  check(
    "R3.2 Render production runtime blocks QA fixture routes even if FLOWPILOT_ENABLE_QA_HARNESS=true",
    isRenderProductionRuntime({ RENDER: "true" }) === true &&
      isRenderProductionRuntime(renderPrEnv) === false &&
      resolveRuntimeEnvironmentLabel({ RENDER: "true" }) === "production" &&
      isQaHarnessAllowed(renderHarnessEnv) === false &&
      isPublicPath("/qa/conversation-header", renderHarnessEnv) === false,
  );
  check(
    "R3.3 Both /api/health and /api/health/live are public probe paths",
    isPublicPath("/api/health", { RENDER: "true" }) === true &&
      isPublicPath("/api/health/live", { RENDER: "true" }) === true,
  );

  const renderOnlyEnv = (k: string) => (k === "RENDER" ? "true" : undefined);
  const renderBudgetedEnv = (k: string) => {
    if (k === "RENDER") return "true";
    if (k === "FLOWPILOT_JEV_APPROVED_MONTHLY_BUDGET") return "25";
    return undefined;
  };
  check(
    "R3.4 Production JEV budget safety blocks unbudgeted JEV on Render production",
    isTypeSafeJevPreferred(renderOnlyEnv) === false &&
      isTypeSafeJevPreferred(renderBudgetedEnv) === true,
  );

  // ─── 4. Better Auth Trusted Origins Without Fake VERCEL_ENV ───────────────
  const savedEnv = {
    VERCEL_ENV: process.env.VERCEL_ENV,
    VERCEL_URL: process.env.VERCEL_URL,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
  };
  try {
    delete process.env.VERCEL_ENV;
    delete process.env.VERCEL_URL;
    process.env.NEXT_PUBLIC_APP_URL = "https://yakfi-web.onrender.com";
    process.env.BETTER_AUTH_URL = "https://yakfi-web.onrender.com";

    const trusted = getTrustedOrigins();
    check(
      "R4.1 Render runtime without VERCEL_ENV enforces exact single trustedOrigin",
      isVercelPreview() === false &&
        resolveAppUrl() === "https://yakfi-web.onrender.com" &&
        trusted.length === 1 &&
        trusted[0] === "https://yakfi-web.onrender.com",
    );
  } finally {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  // ─── 5. Explicit Release Target & Exact-SHA Verification ──────────────────
  const prodReleasePath = resolve(
    root,
    ".github/workflows/production-release.yml",
  );
  const prodReleaseYaml = readFileSync(prodReleasePath, "utf8");
  check(
    "R5.1 production-release.yml has no automatic push tagging and no hardcoded Vercel URL",
    !prodReleaseYaml.includes("flowpilot-prod.vercel.app") &&
      !prodReleaseYaml.includes("\n  push:") &&
      prodReleaseYaml.includes("deployment_target:") &&
      prodReleaseYaml.includes("production_base_url:") &&
      prodReleaseYaml.includes("expected_commit_sha:") &&
      prodReleaseYaml.includes("publish_release:"),
  );

  const exactSha = "a".repeat(40);
  const otherSha = "b".repeat(40);
  const validTarget = validateReleaseTargetInputs({
    deploymentTarget: "render",
    productionBaseUrl: "https://yakfi-web.onrender.com",
    expectedCommitSha: exactSha,
    checkedOutCommitSha: exactSha,
    expectedVersion: "0.79.15",
  });
  const mismatchedPlatform = validateReleaseTargetInputs({
    deploymentTarget: "render",
    productionBaseUrl: "https://flowpilot-prod.vercel.app",
    expectedCommitSha: exactSha,
    checkedOutCommitSha: exactSha,
    expectedVersion: "0.79.15",
  });
  const missingUrl = validateReleaseTargetInputs({
    deploymentTarget: "render",
    productionBaseUrl: "",
    expectedCommitSha: exactSha,
    checkedOutCommitSha: exactSha,
    expectedVersion: "0.79.15",
  });
  const mismatchedCheckedOut = validateReleaseTargetInputs({
    deploymentTarget: "render",
    productionBaseUrl: "https://yakfi-web.onrender.com",
    expectedCommitSha: exactSha,
    checkedOutCommitSha: otherSha,
    expectedVersion: "0.79.15",
  });

  check(
    "R5.2 Release target validator enforces explicit HTTPS URL, platform match, and checked-out SHA match",
    validTarget.ok === true &&
      validTarget.healthUrl === "https://yakfi-web.onrender.com/api/health" &&
      mismatchedPlatform.ok === false &&
      mismatchedPlatform.code === "TARGET_URL_PLATFORM_MISMATCH" &&
      missingUrl.ok === false &&
      missingUrl.code === "MISSING_PRODUCTION_BASE_URL" &&
      mismatchedCheckedOut.ok === false &&
      mismatchedCheckedOut.code === "CHECKED_OUT_SHA_MISMATCH",
  );

  const missingLiveSha = evaluateLiveHealthResponse({
    httpStatus: 200,
    body: {
      status: "ok",
      version: "0.79.15",
      commitSha: null,
      deploymentReady: true,
      database: "connected",
      missingEnvVars: [],
    },
    expectedVersion: "0.79.15",
    expectedCommitSha: exactSha,
  });
  const shortLiveSha = evaluateLiveHealthResponse({
    httpStatus: 200,
    body: {
      status: "ok",
      version: "0.79.15",
      commitSha: exactSha.slice(0, 7),
      deploymentReady: true,
      database: "connected",
      missingEnvVars: [],
    },
    expectedVersion: "0.79.15",
    expectedCommitSha: exactSha,
  });
  const unready503 = evaluateLiveHealthResponse({
    httpStatus: 503,
    body: {
      status: "degraded",
      version: "0.79.15",
      commitSha: exactSha,
      deploymentReady: false,
      database: "unreachable",
      missingEnvVars: [],
    },
    expectedVersion: "0.79.15",
    expectedCommitSha: exactSha,
  });
  const exactReady = evaluateLiveHealthResponse({
    httpStatus: 200,
    body: {
      status: "ok",
      version: "0.79.15",
      commitSha: exactSha,
      deploymentReady: true,
      database: "connected",
      missingEnvVars: [],
    },
    expectedVersion: "0.79.15",
    expectedCommitSha: exactSha,
  });

  const polledReady = await pollProductionReleaseReadiness(
    {
      deploymentTarget: "render",
      productionBaseUrl: "https://yakfi-web.onrender.com",
      expectedCommitSha: exactSha,
      checkedOutCommitSha: exactSha,
      expectedVersion: "0.79.15",
    },
    {
      maxAttempts: 2,
      pollIntervalMs: 1,
      log: () => {},
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            status: "ok",
            version: "0.79.15",
            commitSha: exactSha,
            deploymentReady: true,
            database: "connected",
            missingEnvVars: [],
          }),
          { status: 200 },
        ),
    },
  );

  check(
    "R5.3 Release health evaluator rejects missing SHA, prefix SHA, and HTTP 503; accepts exact 40-char SHA only",
    missingLiveSha.ok === false &&
      missingLiveSha.code === "MISSING_LIVE_COMMIT_SHA" &&
      shortLiveSha.ok === false &&
      shortLiveSha.code === "LIVE_COMMIT_SHA_NOT_EXACT" &&
      unready503.ok === false &&
      unready503.code === "NON_200_HEALTH_STATUS" &&
      exactReady.ok === true &&
      polledReady.ok === true,
  );

  // ─── 6. Values-Free Inventory Completeness & Hygiene ──────────────────────
  const invPath = resolve(root, "config/render-env-inventory.json");
  const inventoryRaw = readFileSync(invPath, "utf8");
  const inventory = JSON.parse(inventoryRaw) as {
    schema?: string;
    targetPlatform?: { workspaceId?: string };
    vercelObservationSummary?: {
      observedProductionVarCount?: number;
      observedSensitiveOrSecretCount?: number;
      observedConfigPlainOrEncryptedCount?: number;
      sensitiveReadbackSupported?: boolean;
    };
    variables?: Array<Record<string, unknown>>;
  };
  const varList = inventory.variables ?? [];
  const varByName = new Map(varList.map((v) => [String(v.name ?? ""), v]));

  const allRequiredNamesPresent = REQUIRED_INVENTORY_VAR_NAMES.every((n) =>
    varByName.has(n),
  );
  const allFieldsNonEmpty = varList.every((entry) =>
    REQUIRED_INVENTORY_FIELDS.every((field) => {
      const val = entry[field];
      return typeof val === "string" && val.trim().length > 0;
    }),
  );
  const semState = varByName.get(
    "FLOWPILOT_JEV_SEMANTIC_ENABLED",
  )?.recoveryState;
  const shadowState = varByName.get(
    "FLOWPILOT_JEV_SHADOW_ENABLED",
  )?.recoveryState;
  const jevRecordedUnknown =
    semState === "UNKNOWN_UNVERIFIED" && shadowState === "UNKNOWN_UNVERIFIED";
  const remState = varByName.get(
    "APPOINTMENT_REMINDERS_ENABLED",
  )?.recoveryState;
  const remindersDisabled = remState === "CONFIRMED_DISABLED";

  const vercelObs = inventory.vercelObservationSummary;
  check(
    "R6.1 Values-free inventory covers all required/optional vars, 11 metadata fields, 25 Vercel Prod count, disabled reminders & unknown JEV/SHADOW",
    inventory.schema === "yakfi.env-inventory@v1" &&
      inventory.targetPlatform?.workspaceId === CONFIRMED_RENDER_WORKSPACE_ID &&
      vercelObs?.observedProductionVarCount === 25 &&
      vercelObs?.observedSensitiveOrSecretCount === 24 &&
      vercelObs?.observedConfigPlainOrEncryptedCount === 1 &&
      vercelObs?.sensitiveReadbackSupported === false &&
      allRequiredNamesPresent &&
      allFieldsNonEmpty &&
      jevRecordedUnknown &&
      remindersDisabled,
  );

  // ─── 7. Owner-Encrypted Recovery Bundle, Restoration Check & Guards ───────
  const opsWorkflowPath = resolve(
    root,
    ".github/workflows/render-migration-ops.yml",
  );
  const recoveryWorkflowYaml = readFileSync(opsWorkflowPath, "utf8");
  check(
    "R7.1 render-migration-ops.yml is manual workflow_dispatch only (never runs in PR CI) and enforces exact 40-char SHA",
    recoveryWorkflowYaml.includes("workflow_dispatch:") &&
      !recoveryWorkflowYaml.includes("pull_request:") &&
      !recoveryWorkflowYaml.includes("\n  push:") &&
      recoveryWorkflowYaml.includes("expected_commit_sha") &&
      recoveryWorkflowYaml.includes("yakfi-owner-encrypted-bundle") &&
      recoveryWorkflowYaml.includes("rm -rf /tmp/yakfi-encrypted-out"),
  );

  const ownerPair = generateOwnerRecoveryKeypair();
  const wrongOwnerPair = generateOwnerRecoveryKeypair();
  const syntheticDbConn =
    "postgresql://user:pass@ep-little-mouse-a5nh644n-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require";
  const syntheticKeyHex = "a1b2c3d4".repeat(8);
  const testServiceId = "srv-cdefghijklmnopqrstuv";

  const encryptedBundle = encryptAllowlistedSecretsForOwner({
    recipient: ownerPair.recipient,
    allowlist: parseAllowlist("DATABASE_URL,CREDENTIAL_MASTER_KEY"),
    sourceValues: {
      DATABASE_URL: syntheticDbConn,
      CREDENTIAL_MASTER_KEY: syntheticKeyHex,
    },
    commitSha: exactSha,
    serviceId: testServiceId,
  });

  const serializedBundle = JSON.stringify(encryptedBundle);
  const validRestore = verifyOwnerEncryptedBundle({
    bundle: encryptedBundle,
    privateKey: ownerPair.privateKey,
  });
  const wrongKeyRestore = verifyOwnerEncryptedBundle({
    bundle: encryptedBundle,
    privateKey: wrongOwnerPair.privateKey,
  });
  const tamperedMetadataRestore = verifyOwnerEncryptedBundle({
    bundle: {
      ...encryptedBundle,
      metadata: { ...encryptedBundle.metadata, commitSha: otherSha },
    },
    privateKey: ownerPair.privateKey,
  });

  let disallowedKeyRejected = false;
  try {
    parseAllowlist("DATABASE_URL,OPENROUTER_API_KEY");
  } catch (err: unknown) {
    disallowedKeyRejected =
      err instanceof Error && err.message === "DISALLOWED_SECRET_KEY";
  }

  const verifiedJoined = validRestore.ok
    ? validRestore.verifiedKeys.join(",")
    : "";
  check(
    "R7.2 Encrypted owner bundle omits plaintext, passes owner restoration check, and fails closed on wrong key, AAD tamper, or disallowed key",
    !serializedBundle.includes("ep-little-mouse-a5nh644n") &&
      !serializedBundle.includes(syntheticKeyHex) &&
      validRestore.ok === true &&
      verifiedJoined === "CREDENTIAL_MASTER_KEY,DATABASE_URL" &&
      wrongKeyRestore.ok === false &&
      wrongKeyRestore.code === "RECIPIENT_KEY_MISMATCH" &&
      tamperedMetadataRestore.ok === false &&
      tamperedMetadataRestore.code === "BUNDLE_DECRYPTION_OR_AUTH_FAILED" &&
      disallowedKeyRejected,
  );

  const putUrls: string[] = [];
  const dryRunTransfer = await transferAllowlistedSecretsToRender(
    {
      expectedCommitSha: exactSha,
      actualCommitSha: exactSha,
      serviceId: testServiceId,
      renderApiKey: "rnd_placeholder_example_key",
      ownerRecipient: ownerPair.recipient,
      allowlist: ["DATABASE_URL", "CREDENTIAL_MASTER_KEY"],
      sourceValues: {
        DATABASE_URL: syntheticDbConn,
        CREDENTIAL_MASTER_KEY: syntheticKeyHex,
      },
      dryRun: true,
    },
    {
      fetchImpl: async (input, init) => {
        const u = String(input);
        if (init?.method === "PUT") putUrls.push(u);
        return new Response(
          JSON.stringify({
            service: {
              id: testServiceId,
              name: "yakfi-web",
              ownerId: CONFIRMED_RENDER_WORKSPACE_ID,
              type: "web_service",
              serviceDetails: { region: CONFIRMED_RENDER_REGION },
            },
          }),
          { status: 200 },
        );
      },
    },
  );

  const applyTransfer = await transferAllowlistedSecretsToRender(
    {
      expectedCommitSha: exactSha,
      actualCommitSha: exactSha,
      serviceId: testServiceId,
      renderApiKey: "rnd_placeholder_example_key",
      ownerRecipient: ownerPair.recipient,
      allowlist: ["DATABASE_URL", "CREDENTIAL_MASTER_KEY"],
      sourceValues: {
        DATABASE_URL: syntheticDbConn,
        CREDENTIAL_MASTER_KEY: syntheticKeyHex,
      },
      dryRun: false,
    },
    {
      fetchImpl: async (input, init) => {
        const u = String(input);
        if (init?.method === "PUT") {
          putUrls.push(u);
          return new Response(JSON.stringify({ key: "ok" }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            service: {
              id: testServiceId,
              name: "yakfi-web",
              ownerId: CONFIRMED_RENDER_WORKSPACE_ID,
              type: "web_service",
              serviceDetails: { region: CONFIRMED_RENDER_REGION },
            },
          }),
          { status: 200 },
        );
      },
    },
  );

  let wrongWorkspaceRejected = false;
  try {
    await transferAllowlistedSecretsToRender(
      {
        expectedCommitSha: exactSha,
        actualCommitSha: exactSha,
        serviceId: testServiceId,
        renderApiKey: "rnd_placeholder_example_key",
        ownerRecipient: ownerPair.recipient,
        allowlist: ["DATABASE_URL"],
        sourceValues: { DATABASE_URL: syntheticDbConn },
        dryRun: false,
      },
      {
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              service: {
                id: testServiceId,
                name: "other-svc",
                ownerId: "tea-wrongworkspace000000",
                type: "web_service",
                serviceDetails: { region: "ohio" },
              },
            }),
            { status: 200 },
          ),
      },
    );
  } catch (err: unknown) {
    wrongWorkspaceRejected =
      err instanceof Error && err.message === "RENDER_WORKSPACE_MISMATCH";
  }

  const expectedEnvPath = `/services/${testServiceId}/env-vars/`;
  check(
    "R7.3 Render transfer pins workspace tea-db9st3gm7kps73ek9op0 + ohio, performs zero PUTs in dryRun, and uses per-key PUTs only",
    dryRunTransfer.summary.ok &&
      dryRunTransfer.summary.code === "DRY_RUN_READY" &&
      applyTransfer.summary.ok &&
      applyTransfer.summary.code === "TRANSFER_APPLIED" &&
      putUrls.length === 2 &&
      putUrls.every((u) => u.includes(expectedEnvPath)) &&
      wrongWorkspaceRejected,
  );

  const inspection = await inspectRecoverySources(
    {
      testDatabaseUrl: syntheticDbConn,
      prodDatabaseUrl:
        "postgresql://user:pass@ep-tiny-grass-a5e63jev.us-east-2.aws.neon.tech/neondb?sslmode=require",
      credentialMasterKey: syntheticKeyHex,
      vercelAccessCred: "vercel_placeholder_example_cred",
    },
    {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            envs: [
              {
                key: "DATABASE_URL",
                type: "sensitive",
                target: ["production"],
                value: "SHOULD_NEVER_BE_RETAINED",
              },
              {
                key: "NEXT_PUBLIC_APP_URL",
                type: "encrypted",
                target: ["production"],
                value: "https://flowpilot-prod.vercel.app",
              },
            ],
          }),
          { status: 200 },
        ),
    },
  );
  const serializedInspection = JSON.stringify(inspection);
  check(
    "R7.4 Source inspection classifies Neon hosts accurately and strips all Vercel value fields",
    inspection.testDbClassification === "ACTIVE_NEON_TEST_DB" &&
      inspection.prodDbClassification === "LEGACY_INACTIVE_PROD_DB" &&
      inspection.masterKeyFormatValid === true &&
      inspection.vercelProductionMetadata?.totalProductionCount === 2 &&
      inspection.vercelProductionMetadata?.sensitiveCount === 1 &&
      !serializedInspection.includes("SHOULD_NEVER_BE_RETAINED") &&
      !serializedInspection.includes("flowpilot-prod.vercel.app"),
  );

  const fixedNow = 1_763_400_000_000;
  const signer = "123456:placeholder_example_bot_signer";
  const blockedBacklog = await verifyRenderCutoverReadinessAndBacklog({
    renderOrigin: "https://yakfi-web.onrender.com",
    expectedCommitSha: exactSha,
    expectedVersion: "0.79.15",
    databaseUrl: syntheticDbConn,
    cutoverSignerCred: signer,
    pendingUpdateCount: 4,
  });

  const activePoolerHost =
    "ep-little-mouse-a5nh644n-pooler.us-east-2.aws.neon.tech";
  const cleanCutover = await verifyRenderCutoverReadinessAndBacklog(
    {
      renderOrigin: "https://yakfi-web.onrender.com",
      expectedCommitSha: exactSha,
      expectedVersion: "0.79.15",
      databaseUrl: syntheticDbConn,
      cutoverSignerCred: signer,
      pendingUpdateCount: 0,
    },
    {
      now: () => fixedNow,
      fetchImpl: async (_input, init) => {
        const headers = new Headers(init?.headers);
        const expectedSig = signCutoverReadiness(
          signer,
          String(fixedNow),
          "8926541123",
        );
        if (headers.get("x-flowpilot-cutover-signature") !== expectedSig) {
          return new Response("unauthorized", { status: 401 });
        }
        return new Response(
          JSON.stringify({
            ok: true,
            commitSha: exactSha,
            version: "0.79.15",
            databaseHost: activePoolerHost,
            databaseName: "neondb",
            businessId: "f5314115-ae8c-46ea-9d7e-080ef5e7366d",
            connectionId: "1d2cdf87-2bee-4f26-aad5-5ab9efd1c716",
            botExternalId: "8926541123",
            botUsername: "Drafnanafnanbot",
            credentialResolved: true,
          }),
          { status: 200 },
        );
      },
    },
  );

  check(
    "R7.5 Cutover gate blocks non-zero pending_update_count by default, never drops updates, and verifies HMAC signed Render readiness",
    blockedBacklog.ok === false &&
      blockedBacklog.code === "PENDING_UPDATES_REQUIRE_DISPOSITION" &&
      blockedBacklog.pendingUpdateCount === 4 &&
      cleanCutover.ok === true &&
      cleanCutover.dropPendingUpdates === false &&
      cleanCutover.commitSha === exactSha,
  );

  // ─── Summary ──────────────────────────────────────────────────────────────
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
    console.error(`\nFailed ${failed} of ${checks.length} Render prep checks.`);
    process.exit(1);
  }
  console.log(
    `\nAll ${checks.length}/${checks.length} Render migration preparation checks PASSED.`,
  );
}

main().catch((err: unknown) => {
  console.error("Unexpected error in check-render-migration:", err);
  process.exit(1);
});
