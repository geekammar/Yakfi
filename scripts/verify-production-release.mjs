#!/usr/bin/env node
// FlowPilot verify-production-release.mjs
// Explicit target-aware post-deploy readiness & exact-SHA verifier.
// Never defaults silently to disabled Vercel; never permits missing or prefix
// commitSha; never authorizes tags/releases for an unverified candidate.
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const ALLOWED_DEPLOYMENT_TARGETS = Object.freeze(["render", "vercel"]);
const TARGET_SET = new Set(ALLOWED_DEPLOYMENT_TARGETS);
const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

export function validateReleaseTargetInputs(input) {
  const target = (input.deploymentTarget ?? "").trim().toLowerCase();
  if (!TARGET_SET.has(target)) {
    return { ok: false, code: "INVALID_DEPLOYMENT_TARGET" };
  }

  const rawUrl = (input.productionBaseUrl ?? "").trim();
  if (!rawUrl) {
    return { ok: false, code: "MISSING_PRODUCTION_BASE_URL" };
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return { ok: false, code: "INVALID_PRODUCTION_BASE_URL" };
  }

  if (
    parsedUrl.protocol !== "https:" ||
    !parsedUrl.hostname ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.search ||
    parsedUrl.hash ||
    (parsedUrl.pathname !== "/" && parsedUrl.pathname !== "")
  ) {
    return { ok: false, code: "INVALID_PRODUCTION_BASE_URL" };
  }

  if (
    target === "render" &&
    parsedUrl.hostname.toLowerCase().endsWith(".vercel.app")
  ) {
    return { ok: false, code: "TARGET_URL_PLATFORM_MISMATCH" };
  }
  if (
    target === "vercel" &&
    parsedUrl.hostname.toLowerCase().endsWith(".onrender.com")
  ) {
    return { ok: false, code: "TARGET_URL_PLATFORM_MISMATCH" };
  }

  const expectedSha = (input.expectedCommitSha ?? "").trim().toLowerCase();
  if (!FULL_SHA_RE.test(expectedSha)) {
    return { ok: false, code: "INVALID_EXPECTED_COMMIT_SHA" };
  }

  const checkedOutSha = (input.checkedOutCommitSha ?? "").trim().toLowerCase();
  if (!FULL_SHA_RE.test(checkedOutSha)) {
    return { ok: false, code: "INVALID_CHECKED_OUT_COMMIT_SHA" };
  }
  if (expectedSha !== checkedOutSha) {
    return { ok: false, code: "CHECKED_OUT_SHA_MISMATCH" };
  }

  const expectedVersion = (input.expectedVersion ?? "").trim();
  if (!SEMVER_RE.test(expectedVersion)) {
    return { ok: false, code: "INVALID_EXPECTED_VERSION" };
  }

  const origin = parsedUrl.origin;
  return {
    ok: true,
    deploymentTarget: target,
    origin,
    healthUrl: `${origin}/api/health`,
    expectedCommitSha: expectedSha,
    expectedVersion,
  };
}

export function evaluateLiveHealthResponse(params) {
  if (params.httpStatus !== 200) {
    return { ok: false, code: "NON_200_HEALTH_STATUS" };
  }

  const body = params.body;
  if (!body || typeof body !== "object") {
    return { ok: false, code: "MALFORMED_HEALTH_BODY" };
  }

  if (
    body.status !== "ok" ||
    body.deploymentReady !== true ||
    body.database !== "connected"
  ) {
    return { ok: false, code: "DEPLOYMENT_NOT_READY" };
  }

  const missingVars = body.missingEnvVars;
  if (!Array.isArray(missingVars) || missingVars.length !== 0) {
    return { ok: false, code: "MISSING_REQUIRED_ENV_VARS" };
  }

  if (body.version !== params.expectedVersion) {
    return { ok: false, code: "LIVE_VERSION_MISMATCH" };
  }

  const liveSha =
    typeof body.commitSha === "string"
      ? body.commitSha.trim().toLowerCase()
      : "";
  if (!liveSha) {
    return { ok: false, code: "MISSING_LIVE_COMMIT_SHA" };
  }
  if (!FULL_SHA_RE.test(liveSha)) {
    return { ok: false, code: "LIVE_COMMIT_SHA_NOT_EXACT" };
  }
  if (liveSha !== params.expectedCommitSha) {
    return { ok: false, code: "LIVE_COMMIT_SHA_MISMATCH" };
  }

  return {
    ok: true,
    version: body.version,
    commitSha: liveSha,
    database: body.database,
  };
}

export async function pollProductionReleaseReadiness(input, deps = {}) {
  const validated = validateReleaseTargetInputs(input);
  if (!validated.ok) {
    return validated;
  }

  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const sleepImpl =
    deps.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = deps.log ?? console.log;
  const maxAttempts = deps.maxAttempts ?? 24;
  const pollIntervalMs = deps.pollIntervalMs ?? 10_000;
  const timeoutMs = deps.timeoutMs ?? 10_000;

  let lastFailureCode = "HEALTH_UNREACHABLE";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(
      `Attempt ${attempt}/${maxAttempts}: probing ${validated.healthUrl} (${validated.deploymentTarget})...`,
    );
    try {
      const response = await fetchImpl(validated.healthUrl, {
        method: "GET",
        redirect: "error",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });

      let parsedBody = null;
      try {
        parsedBody = await response.json();
      } catch {
        lastFailureCode = "MALFORMED_HEALTH_BODY";
      }

      if (parsedBody !== null) {
        const verdict = evaluateLiveHealthResponse({
          httpStatus: response.status,
          body: parsedBody,
          expectedVersion: validated.expectedVersion,
          expectedCommitSha: validated.expectedCommitSha,
        });
        if (verdict.ok) {
          return {
            ok: true,
            deploymentTarget: validated.deploymentTarget,
            origin: validated.origin,
            healthUrl: validated.healthUrl,
            version: verdict.version,
            commitSha: verdict.commitSha,
          };
        }
        lastFailureCode = verdict.code;
        log(`   -> not ready yet: ${verdict.code} (HTTP ${response.status})`);
      } else {
        log(`   -> non-JSON response (HTTP ${response.status})`);
      }
    } catch {
      lastFailureCode = "HEALTH_UNREACHABLE";
      log("   -> health endpoint unreachable or timed out");
    }

    if (attempt < maxAttempts) {
      await sleepImpl(pollIntervalMs);
    }
  }

  return { ok: false, code: lastFailureCode };
}

async function main() {
  const pkgPath = resolve(process.cwd(), "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

  const outcome = await pollProductionReleaseReadiness({
    deploymentTarget: process.env.DEPLOYMENT_TARGET,
    productionBaseUrl: process.env.PRODUCTION_BASE_URL,
    expectedCommitSha: process.env.EXPECTED_COMMIT_SHA,
    checkedOutCommitSha: process.env.CHECKED_OUT_COMMIT_SHA,
    expectedVersion: process.env.EXPECTED_VERSION || pkg.version,
  });

  if (!outcome.ok) {
    console.error(`::error::Release verification failed: ${outcome.code}`);
    process.exit(1);
  }

  console.log(
    `✅ Verified ${outcome.deploymentTarget} deployment at ${outcome.healthUrl}`,
  );
  console.log(`   - Version: ${outcome.version}`);
  console.log(`   - Exact Commit SHA: ${outcome.commitSha}`);

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `prod_verified=true\nverified_health_url=${outcome.healthUrl}\nverified_target=${outcome.deploymentTarget}\n`,
    );
  }
}

const argvEntry = process.argv[1];
const cliEntryHref = argvEntry ? pathToFileURL(argvEntry).href : "";
if (cliEntryHref && import.meta.url === cliEntryHref) {
  main().catch(() => {
    console.error("::error::UNEXPECTED_RELEASE_VERIFICATION_ERROR");
    process.exit(1);
  });
}
