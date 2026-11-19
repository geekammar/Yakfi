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
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
import { encryptCredential } from "@/server/credentials/credential-crypto";
import {
  TARGET,
  type Connection,
  type Credential,
} from "@/server/credentials/test-bot-recovery";
import { isTypeSafeJevPreferred } from "@/server/integrations/ai/factory";
import { signCutoverReadiness } from "@/server/operator/cutover-readiness";

import nextConfig, { PLATFORM_NEUTRAL_PWA_HEADERS } from "../next.config";
import {
  CONFIRMED_RENDER_REGION,
  CONFIRMED_RENDER_WORKSPACE_ID,
  PRE_SERVICE_EXPORT_SENTINEL,
  directTransferAllowlistedSecretsToRender,
  encryptAllowlistedSecretsForOwner,
  evaluateMigrationStatusPreflight,
  generateOwnerRecoveryKeypair,
  inspectRecoverySources,
  parseAllowlist,
  transferAllowlistedSecretsToRender,
  verifyOwnerEncryptedBundle,
  verifyRenderCutoverReadinessAndBacklog,
  verifyRenderServiceOwnership,
  verifySelectedRuntimePreflight,
  writeOwnerRecoveryKeypairExclusive,
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
    "R1.3 render.yaml configures the existing Yakfi service as a single starter Node web service in ohio on 0.0.0.0:$PORT with auto-deploy on commit",
    renderYaml.includes("name: Yakfi") &&
      renderYaml.includes("type: web") &&
      renderYaml.includes("runtime: node") &&
      renderYaml.includes("plan: starter") &&
      renderYaml.includes("region: ohio") &&
      renderYaml.includes("autoDeployTrigger: commit") &&
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
    "R7.1 render-migration-ops.yml enforces SHA + private-key ban, verify-selected-runtime, truthful migration-status exit, and always() backup-before-transfer",
    recoveryWorkflowYaml.includes("workflow_dispatch:") &&
      !recoveryWorkflowYaml.includes("pull_request:") &&
      !recoveryWorkflowYaml.includes("\n  push:") &&
      recoveryWorkflowYaml.includes("expected_commit_sha") &&
      recoveryWorkflowYaml.includes("owner_restoration_proof") &&
      recoveryWorkflowYaml.includes("verify-selected-runtime") &&
      recoveryWorkflowYaml.includes("MIGRATE_EXIT_CODE=$?") &&
      recoveryWorkflowYaml.includes("evaluate-migration-status") &&
      recoveryWorkflowYaml.includes(
        "trap 'rm -f status-selected.raw.txt status-selected.txt' EXIT",
      ) &&
      !recoveryWorkflowYaml.includes("exit 0") &&
      !recoveryWorkflowYaml.includes("migrate deploy") &&
      !recoveryWorkflowYaml.includes("db:deploy") &&
      !recoveryWorkflowYaml.includes("migrate dev") &&
      !recoveryWorkflowYaml.includes("db push") &&
      recoveryWorkflowYaml.includes("PRIVATE_KEY_INPUT_FORBIDDEN") &&
      recoveryWorkflowYaml.includes("prepare-and-deliver-backup:") &&
      recoveryWorkflowYaml.includes("apply-render-transfer:") &&
      recoveryWorkflowYaml.includes("- prepare-and-deliver-backup") &&
      !recoveryWorkflowYaml.includes("success() &&") &&
      recoveryWorkflowYaml.includes("yakfi-owner-encrypted-bundle") &&
      recoveryWorkflowYaml.includes("rm -rf /tmp/yakfi-encrypted-out"),
  );

  const directDryRunBlock = recoveryWorkflowYaml.slice(
    recoveryWorkflowYaml.indexOf(
      "Direct-transfer dry-run (read-only, zero writes)",
    ),
    recoveryWorkflowYaml.indexOf(
      "Verify selected runtime DB decryption pairing",
    ),
  );
  const directApplyBlock = recoveryWorkflowYaml.slice(
    recoveryWorkflowYaml.indexOf("apply-direct-transfer:"),
  );
  check(
    "R7.1b render-migration-ops.yml exposes manual-only direct-transfer with forced dry-run before apply, no owner recovery dependency, and two-key allowlist",
    recoveryWorkflowYaml.includes('"direct-transfer"') &&
      directDryRunBlock.includes('DRY_RUN: "true"') &&
      !directDryRunBlock.includes("OWNER_RESTORATION_PROOF") &&
      !directDryRunBlock.includes("owner_restoration_proof") &&
      directApplyBlock.includes("inputs.dry_run == false") &&
      directApplyBlock.includes("prepare-and-deliver-backup") &&
      directApplyBlock.includes('DRY_RUN: "false"') &&
      !directApplyBlock.includes("OWNER_RESTORATION_PROOF") &&
      !directApplyBlock.includes("owner_restoration_proof"),
  );

  const ownerPair = generateOwnerRecoveryKeypair();
  const wrongOwnerPair = generateOwnerRecoveryKeypair();
  const syntheticDbConn =
    "postgresql://user:pass@ep-little-mouse-a5nh644n-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require";
  const syntheticKeyHex = "a1b2c3d4".repeat(8);
  const testServiceId = "srv-cdefghijklmnopqrstuv";

  // Pre-service export (before Render service exists)
  const preServiceBundle = encryptAllowlistedSecretsForOwner({
    recipient: ownerPair.recipient,
    allowlist: parseAllowlist("DATABASE_URL,CREDENTIAL_MASTER_KEY"),
    sourceValues: {
      DATABASE_URL: syntheticDbConn,
      CREDENTIAL_MASTER_KEY: syntheticKeyHex,
    },
    commitSha: exactSha,
    serviceId: "",
  });
  const preServiceRestore = verifyOwnerEncryptedBundle({
    bundle: preServiceBundle,
    privateKey: ownerPair.privateKey,
  });

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

  let preServiceTransferRejected = false;
  try {
    await transferAllowlistedSecretsToRender({
      expectedCommitSha: exactSha,
      actualCommitSha: exactSha,
      serviceId: "",
      renderApiKey: "rnd_placeholder_example_key",
      ownerRecipient: ownerPair.recipient,
      allowlist: ["DATABASE_URL"],
      sourceValues: { DATABASE_URL: syntheticDbConn },
      dryRun: true,
    });
  } catch (err: unknown) {
    preServiceTransferRejected =
      err instanceof Error && err.message === "INVALID_RENDER_SERVICE_ID";
  }

  const verifiedJoined = validRestore.ok
    ? validRestore.verifiedKeys.join(",")
    : "";
  const validProof = validRestore.ok ? validRestore.restorationProof : "";
  const preServiceProof = preServiceRestore.ok
    ? preServiceRestore.restorationProof
    : "";
  check(
    "R7.2 Pre-service & service-bound encrypted bundles omit plaintext, pass restoration check, and reject service-less transfer",
    !serializedBundle.includes("ep-little-mouse-a5nh644n") &&
      !serializedBundle.includes(syntheticKeyHex) &&
      preServiceBundle.metadata.serviceId === PRE_SERVICE_EXPORT_SENTINEL &&
      preServiceRestore.ok === true &&
      preServiceRestore.serviceId === PRE_SERVICE_EXPORT_SENTINEL &&
      preServiceProof.startsWith("yakfi-verified-v1:") &&
      validRestore.ok === true &&
      validProof === preServiceProof &&
      verifiedJoined === "CREDENTIAL_MASTER_KEY,DATABASE_URL" &&
      wrongKeyRestore.ok === false &&
      wrongKeyRestore.code === "RECIPIENT_KEY_MISMATCH" &&
      tamperedMetadataRestore.ok === false &&
      tamperedMetadataRestore.code === "BUNDLE_DECRYPTION_OR_AUTH_FAILED" &&
      disallowedKeyRejected &&
      preServiceTransferRejected,
  );

  // Exclusive keygen & backup-before-transfer filesystem checks
  const tempVaultDir = mkdtempSync(resolve(tmpdir(), "yakfi-vault-check-"));
  let keygenExclusiveOk = false;
  let existingFileProtected = false;
  let liveSymlinkRefused = false;
  let danglingSymlinkRefused = false;
  let backupPersistedBeforePut = false;
  let partialFailurePreservedBundle = false;
  let networkExceptionPreservedBundle = false;

  try {
    const freshKeyPath = resolve(tempVaultDir, "owner-key.json");
    const writtenPair = writeOwnerRecoveryKeypairExclusive(freshKeyPath);
    const keyMode = statSync(freshKeyPath).mode & 0o777;
    const originalKeyBytes = readFileSync(freshKeyPath, "utf8");
    keygenExclusiveOk =
      keyMode === 0o600 && originalKeyBytes.includes(writtenPair.recipient);

    try {
      writeOwnerRecoveryKeypairExclusive(freshKeyPath);
    } catch (err: unknown) {
      existingFileProtected =
        err instanceof Error &&
        err.message === "REFUSING_TO_OVERWRITE_EXISTING_KEYFILE" &&
        readFileSync(freshKeyPath, "utf8") === originalKeyBytes;
    }

    const liveLinkPath = resolve(tempVaultDir, "symlink-to-existing.json");
    symlinkSync(freshKeyPath, liveLinkPath);
    try {
      writeOwnerRecoveryKeypairExclusive(liveLinkPath);
    } catch (err: unknown) {
      liveSymlinkRefused =
        err instanceof Error &&
        err.message === "REFUSING_SYMLINK_KEYFILE" &&
        readFileSync(freshKeyPath, "utf8") === originalKeyBytes;
    }

    const missingTarget = resolve(tempVaultDir, "nonexistent-target.json");
    const danglingLinkPath = resolve(tempVaultDir, "dangling-symlink.json");
    symlinkSync(missingTarget, danglingLinkPath);
    try {
      writeOwnerRecoveryKeypairExclusive(danglingLinkPath);
    } catch (err: unknown) {
      danglingSymlinkRefused =
        err instanceof Error &&
        err.message === "REFUSING_SYMLINK_KEYFILE" &&
        !existsSync(missingTarget);
    }

    const partialBundlePath = resolve(tempVaultDir, "partial-bundle.enc.json");
    let putCountPartial = 0;
    let fileExistedBeforeFirstPut = false;
    const partialRes = await transferAllowlistedSecretsToRender(
      {
        expectedCommitSha: exactSha,
        actualCommitSha: exactSha,
        serviceId: testServiceId,
        renderApiKey: "rnd_placeholder_example_key",
        ownerRecipient: ownerPair.recipient,
        ownerRestorationProof: validProof,
        bundleOutPath: partialBundlePath,
        allowlist: ["DATABASE_URL", "CREDENTIAL_MASTER_KEY"],
        sourceValues: {
          DATABASE_URL: syntheticDbConn,
          CREDENTIAL_MASTER_KEY: syntheticKeyHex,
        },
        dryRun: false,
      },
      {
        fetchImpl: async (_input, init) => {
          if (init?.method === "PUT") {
            if (putCountPartial === 0) {
              fileExistedBeforeFirstPut = existsSync(partialBundlePath);
            }
            putCountPartial += 1;
            if (putCountPartial === 2) {
              return new Response("upstream error", { status: 502 });
            }
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
    const partialSaved = JSON.parse(
      readFileSync(partialBundlePath, "utf8"),
    ) as typeof encryptedBundle;
    const partialVerified = verifyOwnerEncryptedBundle({
      bundle: partialSaved,
      privateKey: ownerPair.privateKey,
    });
    backupPersistedBeforePut = fileExistedBeforeFirstPut;
    partialFailurePreservedBundle =
      partialRes.summary.ok === false &&
      partialRes.summary.code === "PARTIAL_TRANSFER_FAILURE_DATABASE_URL" &&
      partialRes.summary.encryptedBundleWritten === true &&
      partialRes.summary.failedKey === "DATABASE_URL" &&
      partialVerified.ok === true;

    const netErrBundlePath = resolve(tempVaultDir, "neterr-bundle.enc.json");
    let putCountNet = 0;
    const netErrRes = await transferAllowlistedSecretsToRender(
      {
        expectedCommitSha: exactSha,
        actualCommitSha: exactSha,
        serviceId: testServiceId,
        renderApiKey: "rnd_placeholder_example_key",
        ownerRecipient: ownerPair.recipient,
        ownerRestorationProof: validProof,
        bundleOutPath: netErrBundlePath,
        allowlist: ["DATABASE_URL", "CREDENTIAL_MASTER_KEY"],
        sourceValues: {
          DATABASE_URL: syntheticDbConn,
          CREDENTIAL_MASTER_KEY: syntheticKeyHex,
        },
        dryRun: false,
      },
      {
        fetchImpl: async (_input, init) => {
          if (init?.method === "PUT") {
            putCountNet += 1;
            if (putCountNet === 2) {
              throw new Error("ECONNRESET");
            }
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
    const netSaved = JSON.parse(
      readFileSync(netErrBundlePath, "utf8"),
    ) as typeof encryptedBundle;
    const netVerified = verifyOwnerEncryptedBundle({
      bundle: netSaved,
      privateKey: ownerPair.privateKey,
    });
    networkExceptionPreservedBundle =
      netErrRes.summary.ok === false &&
      netErrRes.summary.code === "NETWORK_TRANSFER_FAILURE_DATABASE_URL" &&
      netErrRes.summary.encryptedBundleWritten === true &&
      netVerified.ok === true;
  } finally {
    rmSync(tempVaultDir, { recursive: true, force: true });
  }

  check(
    "R7.3 Exclusive keygen sets 0600 mode and refuses existing files, live symlinks, and dangling symlinks",
    keygenExclusiveOk &&
      existingFileProtected &&
      liveSymlinkRefused &&
      danglingSymlinkRefused,
  );

  let missingProofBlocked = false;
  let privateKeyInputBlocked = false;
  const blockedPutUrls: string[] = [];
  try {
    await transferAllowlistedSecretsToRender(
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
          if (init?.method === "PUT") blockedPutUrls.push(String(input));
          return new Response("{}", { status: 200 });
        },
      },
    );
  } catch (err: unknown) {
    missingProofBlocked =
      err instanceof Error &&
      err.message === "OWNER_RESTORATION_VERIFICATION_REQUIRED";
  }

  try {
    await transferAllowlistedSecretsToRender({
      expectedCommitSha: exactSha,
      actualCommitSha: exactSha,
      serviceId: testServiceId,
      renderApiKey: "rnd_placeholder_example_key",
      ownerRecipient: ownerPair.recipient,
      ownerRestorationProof: ownerPair.privateKey,
      allowlist: ["DATABASE_URL", "CREDENTIAL_MASTER_KEY"],
      sourceValues: {
        DATABASE_URL: syntheticDbConn,
        CREDENTIAL_MASTER_KEY: syntheticKeyHex,
      },
      dryRun: false,
    });
  } catch (err: unknown) {
    privateKeyInputBlocked =
      err instanceof Error && err.message === "PRIVATE_KEY_INPUT_FORBIDDEN";
  }

  check(
    "R7.4 Real backup-before-transfer requires owner restoration proof, rejects private keys, writes bundle before PUT, and preserves ciphertext on partial/network failure",
    missingProofBlocked &&
      privateKeyInputBlocked &&
      blockedPutUrls.length === 0 &&
      backupPersistedBeforePut &&
      partialFailurePreservedBundle &&
      networkExceptionPreservedBundle,
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
      ownerRestorationProof: validProof,
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
  const singleKeyBundle = encryptAllowlistedSecretsForOwner({
    recipient: ownerPair.recipient,
    allowlist: ["DATABASE_URL"],
    sourceValues: { DATABASE_URL: syntheticDbConn },
    commitSha: exactSha,
    serviceId: "",
  });
  const singleKeyRestore = verifyOwnerEncryptedBundle({
    bundle: singleKeyBundle,
    privateKey: ownerPair.privateKey,
  });
  const singleKeyProof = singleKeyRestore.ok
    ? singleKeyRestore.restorationProof
    : "";
  try {
    await transferAllowlistedSecretsToRender(
      {
        expectedCommitSha: exactSha,
        actualCommitSha: exactSha,
        serviceId: testServiceId,
        renderApiKey: "rnd_placeholder_example_key",
        ownerRecipient: ownerPair.recipient,
        ownerRestorationProof: singleKeyProof,
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

  let missingRegionRejected = false;
  let emptyDetailsRegionRejected = false;
  let malformedRegionRejected = false;
  let nonStringRegionRejected = false;
  let wrongRegionRejected = false;
  const rejectedRegionPutUrls: string[] = [];

  try {
    await transferAllowlistedSecretsToRender(
      {
        expectedCommitSha: exactSha,
        actualCommitSha: exactSha,
        serviceId: testServiceId,
        renderApiKey: "rnd_placeholder_example_key",
        ownerRecipient: ownerPair.recipient,
        ownerRestorationProof: singleKeyProof,
        allowlist: ["DATABASE_URL"],
        sourceValues: { DATABASE_URL: syntheticDbConn },
        dryRun: false,
      },
      {
        fetchImpl: async (input, init) => {
          if (init?.method === "PUT") rejectedRegionPutUrls.push(String(input));
          return new Response(
            JSON.stringify({
              service: {
                id: testServiceId,
                name: "yakfi-web",
                ownerId: CONFIRMED_RENDER_WORKSPACE_ID,
                type: "web_service",
              },
            }),
            { status: 200 },
          );
        },
      },
    );
  } catch (err: unknown) {
    missingRegionRejected =
      err instanceof Error && err.message === "RENDER_REGION_MISSING";
  }

  try {
    await verifyRenderServiceOwnership(
      {
        serviceId: testServiceId,
        renderApiKey: "rnd_placeholder_example_key",
      },
      {
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              service: {
                id: testServiceId,
                name: "yakfi-web",
                ownerId: CONFIRMED_RENDER_WORKSPACE_ID,
                type: "web_service",
                serviceDetails: { region: "   " },
              },
            }),
            { status: 200 },
          ),
      },
    );
  } catch (err: unknown) {
    emptyDetailsRegionRejected =
      err instanceof Error && err.message === "RENDER_REGION_MISSING";
  }

  try {
    await transferAllowlistedSecretsToRender(
      {
        expectedCommitSha: exactSha,
        actualCommitSha: exactSha,
        serviceId: testServiceId,
        renderApiKey: "rnd_placeholder_example_key",
        ownerRecipient: ownerPair.recipient,
        ownerRestorationProof: singleKeyProof,
        allowlist: ["DATABASE_URL"],
        sourceValues: { DATABASE_URL: syntheticDbConn },
        dryRun: false,
      },
      {
        fetchImpl: async (input, init) => {
          if (init?.method === "PUT") rejectedRegionPutUrls.push(String(input));
          return new Response(
            JSON.stringify({
              service: {
                id: testServiceId,
                name: "yakfi-web",
                ownerId: CONFIRMED_RENDER_WORKSPACE_ID,
                type: "web_service",
                serviceDetails: { region: "ohio/invalid!" },
              },
            }),
            { status: 200 },
          );
        },
      },
    );
  } catch (err: unknown) {
    malformedRegionRejected =
      err instanceof Error && err.message === "RENDER_REGION_MALFORMED";
  }

  try {
    await verifyRenderServiceOwnership(
      {
        serviceId: testServiceId,
        renderApiKey: "rnd_placeholder_example_key",
      },
      {
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              service: {
                id: testServiceId,
                name: "yakfi-web",
                ownerId: CONFIRMED_RENDER_WORKSPACE_ID,
                type: "web_service",
                serviceDetails: { region: 42 },
              },
            }),
            { status: 200 },
          ),
      },
    );
  } catch (err: unknown) {
    nonStringRegionRejected =
      err instanceof Error && err.message === "RENDER_REGION_MALFORMED";
  }

  try {
    await transferAllowlistedSecretsToRender(
      {
        expectedCommitSha: exactSha,
        actualCommitSha: exactSha,
        serviceId: testServiceId,
        renderApiKey: "rnd_placeholder_example_key",
        ownerRecipient: ownerPair.recipient,
        ownerRestorationProof: singleKeyProof,
        allowlist: ["DATABASE_URL"],
        sourceValues: { DATABASE_URL: syntheticDbConn },
        dryRun: false,
      },
      {
        fetchImpl: async (input, init) => {
          if (init?.method === "PUT") rejectedRegionPutUrls.push(String(input));
          return new Response(
            JSON.stringify({
              service: {
                id: testServiceId,
                name: "yakfi-web",
                ownerId: CONFIRMED_RENDER_WORKSPACE_ID,
                type: "web_service",
                serviceDetails: { region: "oregon" },
              },
            }),
            { status: 200 },
          );
        },
      },
    );
  } catch (err: unknown) {
    wrongRegionRejected =
      err instanceof Error && err.message === "RENDER_REGION_MISMATCH";
  }

  const expectedEnvPath = `/services/${testServiceId}/env-vars/`;
  check(
    "R7.5 Render transfer pins workspace tea-db9st3gm7kps73ek9op0 + ohio, rejects missing/malformed/wrong region before any PUT, performs zero PUTs in dryRun, and uses per-key PUTs only",
    dryRunTransfer.summary.ok &&
      dryRunTransfer.summary.code === "DRY_RUN_READY" &&
      applyTransfer.summary.ok &&
      applyTransfer.summary.code === "TRANSFER_APPLIED" &&
      putUrls.length === 2 &&
      putUrls.every((u) => u.includes(expectedEnvPath)) &&
      wrongWorkspaceRejected &&
      missingRegionRejected &&
      emptyDetailsRegionRejected &&
      malformedRegionRejected &&
      nonStringRegionRejected &&
      wrongRegionRejected &&
      rejectedRegionPutUrls.length === 0,
  );

  const directServiceResponse = () =>
    new Response(
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

  const captureDirectOwnershipError = async (service: {
    id: string;
    name: string;
    ownerId: string;
    type: string;
    serviceDetails: { region: string };
  }): Promise<{ code: string | null; puts: string[] }> => {
    const puts: string[] = [];
    try {
      await directTransferAllowlistedSecretsToRender(
        {
          expectedCommitSha: exactSha,
          actualCommitSha: exactSha,
          serviceId: testServiceId,
          renderApiKey: "rnd_placeholder_example_key",
          allowlist: ["DATABASE_URL", "CREDENTIAL_MASTER_KEY"],
          sourceValues: {
            DATABASE_URL: syntheticDbConn,
            CREDENTIAL_MASTER_KEY: syntheticKeyHex,
          },
          dryRun: false,
        },
        {
          fetchImpl: async (input, init) => {
            if (init?.method === "PUT") {
              puts.push(String(input));
              return new Response("{}", { status: 200 });
            }
            return new Response(JSON.stringify({ service }), { status: 200 });
          },
        },
      );
      return { code: null, puts };
    } catch (err: unknown) {
      return {
        code: err instanceof Error ? err.message : "UNKNOWN",
        puts,
      };
    }
  };

  let directWrongShaRejected = false;
  let directWrongShaFetchCount = 0;
  try {
    await directTransferAllowlistedSecretsToRender(
      {
        expectedCommitSha: exactSha,
        actualCommitSha: otherSha,
        serviceId: testServiceId,
        renderApiKey: "rnd_placeholder_example_key",
        allowlist: ["DATABASE_URL", "CREDENTIAL_MASTER_KEY"],
        sourceValues: {
          DATABASE_URL: syntheticDbConn,
          CREDENTIAL_MASTER_KEY: syntheticKeyHex,
        },
        dryRun: false,
      },
      {
        fetchImpl: async () => {
          directWrongShaFetchCount += 1;
          return directServiceResponse();
        },
      },
    );
  } catch (err: unknown) {
    directWrongShaRejected =
      err instanceof Error && err.message === "COMMIT_SHA_MISMATCH";
  }

  let directWrongAllowlistRejected = false;
  let directWrongAllowlistFetchCount = 0;
  try {
    await directTransferAllowlistedSecretsToRender(
      {
        expectedCommitSha: exactSha,
        actualCommitSha: exactSha,
        serviceId: testServiceId,
        renderApiKey: "rnd_placeholder_example_key",
        allowlist: ["DATABASE_URL"],
        sourceValues: {
          DATABASE_URL: syntheticDbConn,
          CREDENTIAL_MASTER_KEY: syntheticKeyHex,
        },
        dryRun: false,
      },
      {
        fetchImpl: async () => {
          directWrongAllowlistFetchCount += 1;
          return directServiceResponse();
        },
      },
    );
  } catch (err: unknown) {
    directWrongAllowlistRejected =
      err instanceof Error &&
      err.message === "DIRECT_TRANSFER_ALLOWLIST_MISMATCH";
  }

  const wrongWorkspaceDirect = await captureDirectOwnershipError({
    id: testServiceId,
    name: "yakfi-web",
    ownerId: "tea-wrongworkspace000000",
    type: "web_service",
    serviceDetails: { region: CONFIRMED_RENDER_REGION },
  });
  const wrongServiceDirect = await captureDirectOwnershipError({
    id: "srv-aaaaaaaaaaaaaaaaaaaaaaaa",
    name: "yakfi-web",
    ownerId: CONFIRMED_RENDER_WORKSPACE_ID,
    type: "web_service",
    serviceDetails: { region: CONFIRMED_RENDER_REGION },
  });
  const wrongRegionDirect = await captureDirectOwnershipError({
    id: testServiceId,
    name: "yakfi-web",
    ownerId: CONFIRMED_RENDER_WORKSPACE_ID,
    type: "web_service",
    serviceDetails: { region: "oregon" },
  });

  let directInvalidValueRejected = false;
  let directInvalidValuePutCount = 0;
  try {
    await directTransferAllowlistedSecretsToRender(
      {
        expectedCommitSha: exactSha,
        actualCommitSha: exactSha,
        serviceId: testServiceId,
        renderApiKey: "rnd_placeholder_example_key",
        allowlist: ["DATABASE_URL", "CREDENTIAL_MASTER_KEY"],
        sourceValues: {
          DATABASE_URL: "not-a-database-url",
          CREDENTIAL_MASTER_KEY: syntheticKeyHex,
        },
        dryRun: false,
      },
      {
        fetchImpl: async (_input, init) => {
          if (init?.method === "PUT") directInvalidValuePutCount += 1;
          return directServiceResponse();
        },
      },
    );
  } catch (err: unknown) {
    directInvalidValueRejected =
      err instanceof Error &&
      err.message === "UNAUTHORIZED_DATABASE_URL_TARGET";
  }

  const directDryRunPutUrls: string[] = [];
  const directDryRun = await directTransferAllowlistedSecretsToRender(
    {
      expectedCommitSha: exactSha,
      actualCommitSha: exactSha,
      serviceId: testServiceId,
      renderApiKey: "rnd_placeholder_example_key",
      allowlist: ["DATABASE_URL", "CREDENTIAL_MASTER_KEY"],
      sourceValues: {
        DATABASE_URL: syntheticDbConn,
        CREDENTIAL_MASTER_KEY: syntheticKeyHex,
      },
      dryRun: true,
    },
    {
      fetchImpl: async (input, init) => {
        if (init?.method === "PUT") directDryRunPutUrls.push(String(input));
        return directServiceResponse();
      },
    },
  );

  const renderEnv = new Map<string, string>([["UNRELATED_KEY", "keep-me"]]);
  const directApplyPutUrls: string[] = [];
  const directApply = await directTransferAllowlistedSecretsToRender(
    {
      expectedCommitSha: exactSha,
      actualCommitSha: exactSha,
      serviceId: testServiceId,
      renderApiKey: "rnd_placeholder_example_key",
      allowlist: ["DATABASE_URL", "CREDENTIAL_MASTER_KEY"],
      sourceValues: {
        DATABASE_URL: syntheticDbConn,
        CREDENTIAL_MASTER_KEY: syntheticKeyHex,
      },
      dryRun: false,
    },
    {
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (init?.method === "PUT") {
          directApplyPutUrls.push(url);
          const key = decodeURIComponent(url.split("/env-vars/")[1] ?? "");
          const body = JSON.parse(String(init.body ?? "{}")) as {
            value?: string;
          };
          if (key && typeof body.value === "string") {
            renderEnv.set(key, body.value);
          }
          return new Response("{}", { status: 200 });
        }
        return directServiceResponse();
      },
    },
  );

  let directPartialPutCount = 0;
  const directPartial = await directTransferAllowlistedSecretsToRender(
    {
      expectedCommitSha: exactSha,
      actualCommitSha: exactSha,
      serviceId: testServiceId,
      renderApiKey: "rnd_placeholder_example_key",
      allowlist: ["DATABASE_URL", "CREDENTIAL_MASTER_KEY"],
      sourceValues: {
        DATABASE_URL: syntheticDbConn,
        CREDENTIAL_MASTER_KEY: syntheticKeyHex,
      },
      dryRun: false,
    },
    {
      fetchImpl: async (_input, init) => {
        if (init?.method === "PUT") {
          directPartialPutCount += 1;
          if (directPartialPutCount === 2) {
            return new Response("{}", { status: 500 });
          }
          return new Response("{}", { status: 200 });
        }
        return directServiceResponse();
      },
    },
  );

  let directNetworkPutCount = 0;
  const directNetwork = await directTransferAllowlistedSecretsToRender(
    {
      expectedCommitSha: exactSha,
      actualCommitSha: exactSha,
      serviceId: testServiceId,
      renderApiKey: "rnd_placeholder_example_key",
      allowlist: ["DATABASE_URL", "CREDENTIAL_MASTER_KEY"],
      sourceValues: {
        DATABASE_URL: syntheticDbConn,
        CREDENTIAL_MASTER_KEY: syntheticKeyHex,
      },
      dryRun: false,
    },
    {
      fetchImpl: async (_input, init) => {
        if (init?.method === "PUT") {
          directNetworkPutCount += 1;
          if (directNetworkPutCount === 2) {
            throw new Error("ECONNRESET");
          }
          return new Response("{}", { status: 200 });
        }
        return directServiceResponse();
      },
    },
  );

  check(
    "R7.10 Direct transfer rejects wrong SHA, allowlist, workspace, service, and region before mutation; dry-run performs zero writes",
    directWrongShaRejected &&
      directWrongShaFetchCount === 0 &&
      directWrongAllowlistRejected &&
      directWrongAllowlistFetchCount === 0 &&
      wrongWorkspaceDirect.code === "RENDER_WORKSPACE_MISMATCH" &&
      wrongWorkspaceDirect.puts.length === 0 &&
      wrongServiceDirect.code === "RENDER_SERVICE_ID_MISMATCH" &&
      wrongServiceDirect.puts.length === 0 &&
      wrongRegionDirect.code === "RENDER_REGION_MISMATCH" &&
      wrongRegionDirect.puts.length === 0 &&
      directInvalidValueRejected &&
      directInvalidValuePutCount === 0 &&
      directDryRun.summary.ok === true &&
      directDryRun.summary.code === "DRY_RUN_READY" &&
      directDryRunPutUrls.length === 0 &&
      (directDryRun.summary.transferredKeys ?? []).join(",") ===
        "CREDENTIAL_MASTER_KEY,DATABASE_URL",
  );

  check(
    "R7.11 Direct transfer updates only the two allowlisted keys, preserves unrelated env vars, and reports partial/network failures without secret values",
    directApply.summary.ok === true &&
      directApply.summary.code === "TRANSFER_APPLIED" &&
      directApplyPutUrls.length === 2 &&
      directApplyPutUrls.some((url) =>
        url.endsWith("/env-vars/DATABASE_URL"),
      ) &&
      directApplyPutUrls.some((url) =>
        url.endsWith("/env-vars/CREDENTIAL_MASTER_KEY"),
      ) &&
      renderEnv.get("UNRELATED_KEY") === "keep-me" &&
      renderEnv.get("DATABASE_URL") === syntheticDbConn &&
      renderEnv.get("CREDENTIAL_MASTER_KEY") === syntheticKeyHex &&
      directPartial.summary.ok === false &&
      directPartial.summary.code.startsWith("PARTIAL_TRANSFER_FAILURE_") &&
      (directPartial.summary.transferredKeys ?? []).length === 1 &&
      Boolean(directPartial.summary.failedKey) &&
      directNetwork.summary.ok === false &&
      directNetwork.summary.code.startsWith("NETWORK_TRANSFER_FAILURE_") &&
      (directNetwork.summary.transferredKeys ?? []).length === 1 &&
      Boolean(directNetwork.summary.failedKey) &&
      !JSON.stringify(directApply.summary).includes(syntheticDbConn) &&
      !JSON.stringify(directApply.summary).includes(syntheticKeyHex) &&
      !JSON.stringify(directPartial.summary).includes(syntheticDbConn) &&
      !JSON.stringify(directPartial.summary).includes(syntheticKeyHex) &&
      !JSON.stringify(directNetwork.summary).includes(syntheticDbConn) &&
      !JSON.stringify(directNetwork.summary).includes(syntheticKeyHex),
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
    "R7.6 Source inspection classifies Neon hosts accurately and strips all Vercel value fields",
    inspection.testDbClassification === "ACTIVE_NEON_TEST_DB" &&
      inspection.prodDbClassification === "LEGACY_INACTIVE_PROD_DB" &&
      inspection.masterKeyFormatValid === true &&
      inspection.vercelProductionMetadata?.totalProductionCount === 2 &&
      inspection.vercelProductionMetadata?.sensitiveCount === 1 &&
      !serializedInspection.includes("SHOULD_NEVER_BE_RETAINED") &&
      !serializedInspection.includes("flowpilot-prod.vercel.app"),
  );

  // Selected-runtime read-only decryption preflight (offline disposable fixtures)
  const preflightKeyA = randomBytes(32);
  const preflightKeyB = randomBytes(32);
  const syntheticBotSecret = `${TARGET.botId}:placeholder_${"x".repeat(24)}`;
  const wrongBotSecret = `111222333:placeholder_${"y".repeat(24)}`;
  const fixtureConn: Connection = {
    id: TARGET.connectionId,
    businessId: TARGET.businessId,
    botExternalId: TARGET.botId,
    botUsername: TARGET.username,
    status: "CONNECTED",
    isActive: true,
    deletedAt: null,
    credentialsRef: "fp:selected-preflight-fixture",
    credentialKind: "RUNTIME",
    updatedAt: new Date(),
  };
  const fixtureCred: Credential = {
    credentialsRef: "fp:selected-preflight-fixture",
    businessId: TARGET.businessId,
    algorithm: "AES-256-GCM",
    keyVersion: 1,
    cipherBlob: encryptCredential(preflightKeyA, syntheticBotSecret),
  };

  const healthyPreflight = await verifySelectedRuntimePreflight(
    {
      databaseUrl: syntheticDbConn,
      masterKey: preflightKeyA.toString("hex"),
    },
    {
      repo: {
        readConnection: async () => fixtureConn,
        readCredential: async () => fixtureCred,
      },
    },
  );
  const mismatchedKeyPreflight = await verifySelectedRuntimePreflight(
    {
      databaseUrl: syntheticDbConn,
      masterKey: preflightKeyB.toString("hex"),
    },
    {
      repo: {
        readConnection: async () => fixtureConn,
        readCredential: async () => fixtureCred,
      },
    },
  );
  const wrongHostPreflight = await verifySelectedRuntimePreflight(
    {
      databaseUrl:
        "postgresql://user:pass@ep-tiny-grass-a5e63jev.us-east-2.aws.neon.tech/neondb?sslmode=require",
      masterKey: preflightKeyA.toString("hex"),
    },
    {
      repo: {
        readConnection: async () => fixtureConn,
        readCredential: async () => fixtureCred,
      },
    },
  );
  const wrongBotCredPreflight = await verifySelectedRuntimePreflight(
    {
      databaseUrl: syntheticDbConn,
      masterKey: preflightKeyA.toString("hex"),
    },
    {
      repo: {
        readConnection: async () => fixtureConn,
        readCredential: async () => ({
          ...fixtureCred,
          cipherBlob: encryptCredential(preflightKeyA, wrongBotSecret),
        }),
      },
    },
  );
  const preflightOut = JSON.stringify({
    healthyPreflight,
    mismatchedKeyPreflight,
    wrongHostPreflight,
    wrongBotCredPreflight,
  });
  check(
    "R7.7 verifySelectedRuntimePreflight proves real decryption, rejects mismatched key & wrong targets, and emits status only",
    healthyPreflight.ok === true &&
      healthyPreflight.status === "HEALTHY_LOCAL_KEY" &&
      mismatchedKeyPreflight.ok === false &&
      mismatchedKeyPreflight.status === "REPAIR_NEEDED" &&
      mismatchedKeyPreflight.code === "AUTHENTICATION_FAILED_KEY_OR_DATA" &&
      wrongHostPreflight.ok === false &&
      wrongHostPreflight.status === "BLOCKED" &&
      wrongHostPreflight.code === "DATABASE_TARGET_NOT_AUTHORIZED" &&
      wrongBotCredPreflight.ok === false &&
      wrongBotCredPreflight.status === "BLOCKED" &&
      wrongBotCredPreflight.code === "DECRYPTED_BOT_IDENTITY_MISMATCH" &&
      !preflightOut.includes("placeholder_") &&
      !preflightOut.includes(preflightKeyA.toString("hex")),
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
    "R7.8 Cutover gate blocks non-zero pending_update_count by default, never drops updates, and verifies HMAC signed Render readiness",
    blockedBacklog.ok === false &&
      blockedBacklog.code === "PENDING_UPDATES_REQUIRE_DISPOSITION" &&
      blockedBacklog.pendingUpdateCount === 4 &&
      cleanCutover.ok === true &&
      cleanCutover.dropPendingUpdates === false &&
      cleanCutover.commitSha === exactSha,
  );

  const upToDateEval = evaluateMigrationStatusPreflight({
    exitCode: 0,
    rawOutput:
      "19 migrations found in prisma/migrations\nDatabase schema is up to date!",
    credentialDecryptionStatus: "HEALTHY_LOCAL_KEY",
  });
  const pendingExitOneEval = evaluateMigrationStatusPreflight({
    exitCode: 1,
    rawOutput:
      "Following migration(s) have not yet been applied:\n20261118_example",
    credentialDecryptionStatus: "HEALTHY_LOCAL_KEY",
  });
  const pendingExitZeroEval = evaluateMigrationStatusPreflight({
    exitCode: 0,
    rawOutput:
      "Following migration(s) have not yet been applied:\n20261118_example",
    credentialDecryptionStatus: "HEALTHY_LOCAL_KEY",
  });
  const failedMigrationEval = evaluateMigrationStatusPreflight({
    exitCode: 1,
    rawOutput: "Following migration(s) have failed:\n20261110_broken_step",
    credentialDecryptionStatus: "HEALTHY_LOCAL_KEY",
  });
  const divergentMigrationEval = evaluateMigrationStatusPreflight({
    exitCode: 1,
    rawOutput:
      "Your local migration history and the migrations table from your database are different.",
    credentialDecryptionStatus: "HEALTHY_LOCAL_KEY",
  });
  const connErrEval = evaluateMigrationStatusPreflight({
    exitCode: 2,
    rawOutput:
      "Error: P1001 at postgresql://neondb_owner:replace-with-db-pass@ep-little-mouse-a5nh644n.us-east-2.aws.neon.tech/neondb?sslmode=require&password=replace-with-query-pass",
    credentialDecryptionStatus: "HEALTHY_LOCAL_KEY",
  });
  const repairNeededButSchemaOkEval = evaluateMigrationStatusPreflight({
    exitCode: 0,
    rawOutput: "Database schema is up to date!",
    credentialDecryptionStatus: "REPAIR_NEEDED",
  });
  const repairCredLabel =
    repairNeededButSchemaOkEval.credentialDecryptionStatus;

  check(
    "R7.9 Migration-status evaluator preserves real exit codes, redacts credentials, distinguishes decryption from schema status, and blocks pending/failed/divergent states",
    upToDateEval.ok === true &&
      upToDateEval.migrationStatus === "UP_TO_DATE" &&
      upToDateEval.overallReadiness === "READY" &&
      upToDateEval.propagatedExitCode === 0 &&
      pendingExitOneEval.ok === false &&
      pendingExitOneEval.credentialDecryptionStatus === "HEALTHY_LOCAL_KEY" &&
      pendingExitOneEval.migrationStatus === "PENDING_MIGRATIONS" &&
      pendingExitOneEval.overallReadiness === "NOT_READY" &&
      pendingExitOneEval.propagatedExitCode === 1 &&
      pendingExitZeroEval.ok === false &&
      pendingExitZeroEval.migrationStatus === "PENDING_MIGRATIONS" &&
      pendingExitZeroEval.overallReadiness === "NOT_READY" &&
      pendingExitZeroEval.propagatedExitCode === 1 &&
      failedMigrationEval.ok === false &&
      failedMigrationEval.migrationStatus === "FAILED_MIGRATIONS" &&
      failedMigrationEval.overallReadiness === "NOT_READY" &&
      failedMigrationEval.propagatedExitCode === 1 &&
      divergentMigrationEval.ok === false &&
      divergentMigrationEval.migrationStatus === "DIVERGENT_HISTORY" &&
      divergentMigrationEval.overallReadiness === "NOT_READY" &&
      divergentMigrationEval.propagatedExitCode === 1 &&
      connErrEval.ok === false &&
      connErrEval.migrationStatus === "COMMAND_FAILED" &&
      connErrEval.overallReadiness === "NOT_READY" &&
      connErrEval.propagatedExitCode === 2 &&
      !connErrEval.redactedOutput.includes("replace-with-db-pass") &&
      !connErrEval.redactedOutput.includes("replace-with-query-pass") &&
      connErrEval.redactedOutput.includes("postgresql://***:***@") &&
      repairNeededButSchemaOkEval.ok === false &&
      repairCredLabel === "REPAIR_NEEDED" &&
      repairNeededButSchemaOkEval.migrationStatus === "UP_TO_DATE" &&
      repairNeededButSchemaOkEval.overallReadiness === "NOT_READY",
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
